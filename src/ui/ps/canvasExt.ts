// The image mode's extra canvas tools (Photoshop), hooked into CanvasView by three calls (extDown / extOverlay /
// extCursor) so the big view file only routes to them:
//   브러시·지우개 on a layer mask (the mask thumbnail is the target, or an adjustment layer): grey into the mask
//   스팟 복구 브러시 J   paint over a spot; on release it is filled from its surroundings (content-aware)
//   복구 브러시          Alt+click a source, paint: the source's texture in the destination's colour and light
//   패치 도구            draw round an area (or use the selection), drag it onto a clean area: healed from there
//   복제 도장 S          Alt+click a source, paint a copy of it (aligned: the offset stays between strokes)
//   빠른 선택 W          paint over an area: the selection grows to similar colours nearby (Alt: takes away)
//   개체 선택            drag a box round an object: the object inside is selected
// Every edit is one undo step (a gesture); the layer's untouched tiles keep their identity.

import type { Vec2 } from "../../core/types";
import { applyTransform, invertTransform } from "../../core/geom";
import { healBlend, inpaint, maskBox } from "../../core/image/inpaint";
import { maskPlane, maskFromPlane } from "../../core/image/layerMask";
import { tilesToImg, type Img } from "../../core/image/pixels";
import { draftPage, useStore } from "../../core/store";
import { TILE, makeTile, isBlank } from "../../core/tile";
import type { Page, PixelTile, RasterNode, SceneNode } from "../../core/types";
import { t } from "../../i18n";
import { activeMask, lassoSelect, rasterizeLayer, samplePixels, setSelection, usePixelSel } from "../pixelSelect";
import { currentEditMode } from "../editModes";
import { DabStroke, tileAligned, type Box } from "./dabs";
import { drawWarp, transformDown } from "./psTransform";
import { drawActivePath } from "./PathsPanel";
import { localPageBox, maskOf, paintsMask, soleSelected, useMaskUI } from "./maskActions";
import { objectSelectMask, quickSelectMask } from "../../core/image/smartSelect";
import { makeCanvas, ctx2d } from "../../render/draw";
import { TONE_TOOLS, tonePaint } from "./toning";

const S = () => useStore.getState();

export interface ExtDrag {
  move(p: Vec2, e: PointerEvent): void;
  up(p: Vec2, e: PointerEvent): void;
  draw?(o: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2, zoom: number): void;
}

/** Tools this module draws with (they take the press before CanvasView's own switch). */
export const EXT_TOOLS = new Set(["spotHeal", "heal", "patch", "clone", "quickSelect", "objectSelect", "dodge", "burn", "sponge"]);
const BRUSHLIKE = new Set(["spotHeal", "heal", "clone", "quickSelect", "dodge", "burn", "sponge"]);

// ───────── shared ─────────

const lum = (hex: string) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const v = parseInt(m[1], 16);
  return Math.round(0.299 * ((v >> 16) & 255) + 0.587 * ((v >> 8) & 255) + 0.114 * (v & 255));
};

/** The pixel layer a retouching tool works on: the selected one, else the top visible one with pixels (pictures are made pixels). */
function retouchTarget(page: Page): RasterNode | null {
  const s = S();
  const sel = page.nodes.filter((n) => s.selection.includes(n.id));
  let n: SceneNode | undefined = sel.length === 1 ? sel[0] : undefined;
  if (!n) n = [...page.nodes].reverse().find((x) => x.visible && !x.locked && ((x.type === "RASTER" && !x.adjust && Object.keys(x.tiles).length > 0) || x.type === "IMAGE"));
  if (!n) return void s.notify(t("psfeat.retouch.noLayer")), null;
  if (n.locked) return void s.notify(t("imgmode.msg.layerLocked")), null;
  if (n.lockPixels) return void s.notify(t("psfeat.lock.pixels")), null;
  if (n.type === "RASTER" && n.adjust) return void s.notify(t("psfeat.retouch.adjustLayer")), null;
  if (n.type === "IMAGE") {
    const r = rasterizeLayer(page, n);
    if (r) s.set({ selection: [r.id] });
    return r;
  }
  if (n.type !== "RASTER") return void s.notify(t("psfeat.retouch.notPixels")), null;
  if (!s.selection.includes(n.id)) s.set({ selection: [n.id] });
  return n;
}

const tb = (b: Box) => ({ ox: b.x, oy: b.y, width: b.w, height: b.h });

/** Replace tiles `keys` of `tiles` from an image over `box` (blank ones dropped). */
function tilesFrom(img: Img, box: Box, keys: Iterable<string>, base: Record<string, PixelTile>, into: Record<string, PixelTile>) {
  for (const k of keys) {
    const u = k.indexOf("_");
    const tx = +k.slice(0, u), ty = +k.slice(u + 1);
    const ox = tx * TILE - box.x, oy = ty * TILE - box.y;
    if (ox < 0 || oy < 0 || ox + TILE > box.w || oy + TILE > box.h) continue;
    const d = new Uint8ClampedArray(TILE * TILE * 4);
    for (let r = 0; r < TILE; r++) d.set(img.data.subarray(((oy + r) * box.w + ox) * 4, ((oy + r) * box.w + ox + TILE) * 4), r * TILE * 4);
    const old = base[k];
    if (isBlank(d)) delete into[k];
    else into[k] = old && sameData(old.data, d) ? old : makeTile(d);
  }
}
function sameData(a: Uint8ClampedArray, b: Uint8ClampedArray) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function setTiles(pageId: string, id: string, tiles: Record<string, PixelTile>) {
  S().updateGesture((d) => {
    const n = draftPage(d, pageId)?.nodes.find((x) => x.id === id) as RasterNode | undefined;
    if (n) n.tiles = tiles as any;
  });
}

/** The pixel selection as layer-local coverage over `box` (1 everywhere when there is none). */
function selectionCoverage(n: RasterNode, box: Box): Float32Array | null {
  const sel = activeMask();
  if (!sel) return null;
  const out = new Float32Array(box.w * box.h);
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const [px, py] = applyTransform(n.transform, [box.x + x + 0.5, box.y + y + 0.5]);
      const ix = Math.floor(px), iy = Math.floor(py);
      out[y * box.w + x] = ix >= 0 && iy >= 0 && ix < sel.w && iy < sel.h ? sel.data[iy * sel.w + ix] / 255 : 0;
    }
  return out;
}

const brushSize = (n: RasterNode) => S().brush.size / (Math.abs(n.transform.scale) || 1);

// ───────── layer-mask painting ─────────

function maskPaint(page: Page, n: RasterNode, erase: boolean): ExtDrag | null {
  const m = maskOf(n);
  if (!m) return null;
  const box = tileAligned(localPageBox(n.transform, page, { ...n.tiles, ...m.tiles }));
  const base = maskPlane(m, box.x, box.y, box.w, box.h);
  const s = S();
  // the eraser paints the background colour into a mask (Photoshop)
  const v = lum(erase ? usePixelSel.getState().bg : s.brush.color);
  const op = s.brush.opacity;
  const stroke = new DabStroke(box, n.transform, brushSize(n), s.brush.hardness, s.brush.flow ?? 1);
  const sel = selectionCoverage(n, box);
  const tiles: Record<string, PixelTile> = { ...m.tiles };
  const plane = base.slice();
  s.beginGesture();
  let raf = 0;
  const flush = () => {
    raf = 0;
    const keys = stroke.takeDirty();
    if (!keys.length) return;
    for (const k of keys) {
      const u = k.indexOf("_");
      const ox = +k.slice(0, u) * TILE - box.x, oy = +k.slice(u + 1) * TILE - box.y;
      for (let r = 0; r < TILE; r++)
        for (let c = 0; c < TILE; c++) {
          const i = (oy + r) * box.w + ox + c;
          const a = stroke.cov[i] * op * (sel ? sel[i] : 1);
          plane[i] = Math.round(base[i] + (v - base[i]) * a);
        }
    }
    const part = maskFromPlane(plane, box.x, box.y, box.w, box.h, m.hide);
    for (const k of keys) {
      if (part[k]) tiles[k] = part[k];
      else delete tiles[k];
    }
    S().updateGesture((d) => {
      const x = draftPage(d, page.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
      if (!x) return;
      if (x.adjust) x.tiles = { ...tiles } as any;
      else if (x.mask) x.mask.tiles = { ...tiles } as any;
    });
  };
  const queue = () => void (raf ||= requestAnimationFrame(flush));
  return {
    move(p, e) {
      stroke.add(p[0], p[1], e.pointerType === "pen" ? e.pressure || 0.5 : 1);
      queue();
    },
    up() {
      if (raf) cancelAnimationFrame(raf);
      flush();
      S().endGesture(t("psfeat.mask.hist.paint"));
    },
  };
}

// ───────── clone stamp / healing brush ─────────

/** Alt+click source of the clone stamp and the healing brush (page px), and the aligned offset once a stroke used it. */
let source: { pageId: string; p: Vec2 } | null = null;
let aligned: { pageId: string; d: Vec2 } | null = null;
export const cloneSource = () => source;

function clonePaint(page: Page, n: RasterNode, start: Vec2, heal: boolean): ExtDrag | null {
  if (!source || source.pageId !== page.id) return void S().notify(t("psfeat.clone.needSource")), null;
  // offset (page px) from the destination to the source: kept between strokes (Photoshop's 정렬 on) until a new Alt+click
  const d: Vec2 = aligned && aligned.pageId === page.id ? aligned.d : [source.p[0] - start[0], source.p[1] - start[1]];
  aligned = { pageId: page.id, d };
  const k = Math.abs(n.transform.scale) || 1;
  const ldx = Math.round(d[0] / k), ldy = Math.round(d[1] / k);
  const box = tileAligned(localPageBox(n.transform, page, n.tiles));
  const img0 = tilesToImg(n.tiles, tb(box));
  const s = S();
  const op = s.brush.opacity;
  const stroke = new DabStroke(box, n.transform, brushSize(n), s.brush.hardness, s.brush.flow ?? 1);
  const sel = selectionCoverage(n, box);
  const cur = tilesToImg(n.tiles, tb(box));
  const tiles: Record<string, PixelTile> = { ...n.tiles };
  const W = box.w, H = box.h;
  s.beginGesture();
  let raf = 0;
  const flush = () => {
    raf = 0;
    const keys = stroke.takeDirty();
    if (!keys.length) return;
    for (const key of keys) {
      const u = key.indexOf("_");
      const ox = +key.slice(0, u) * TILE - box.x, oy = +key.slice(u + 1) * TILE - box.y;
      for (let r = 0; r < TILE; r++)
        for (let c = 0; c < TILE; c++) {
          const x = ox + c, y = oy + r, i = y * W + x;
          const a = stroke.cov[i] * op * (sel ? sel[i] : 1);
          if (a <= 0) continue;
          const sx = x + ldx, sy = y + ldy;
          if (sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
          const j = (sy * W + sx) * 4, o = i * 4;
          // straight-alpha "over" of the source pixel at coverage a
          const sa = (img0.data[j + 3] / 255) * a, da = img0.data[o + 3] / 255;
          const ao = sa + da * (1 - sa);
          for (let ch = 0; ch < 3; ch++) cur.data[o + ch] = ao > 0 ? Math.round((img0.data[j + ch] * sa + img0.data[o + ch] * da * (1 - sa)) / ao) : 0;
          cur.data[o + 3] = Math.round(ao * 255);
        }
    }
    tilesFrom(cur, box, keys, n.tiles, tiles);
    setTiles(page.id, n.id, { ...tiles });
  };
  const queue = () => void (raf ||= requestAnimationFrame(flush));
  let last: Vec2 = start;
  return {
    move(p, e) {
      last = p;
      stroke.add(p[0], p[1], e.pointerType === "pen" ? e.pressure || 0.5 : 1);
      queue();
    },
    up() {
      if (raf) cancelAnimationFrame(raf);
      flush();
      if (heal && stroke.bounds) {
        // the healing: source texture, destination colour and light (core/image/inpaint.ts healBlend)
        const mask = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) mask[i] = Math.round(Math.min(1, stroke.cov[i] * (sel ? sel[i] : 1)) * 255 * op);
        const src: Img = { width: W, height: H, data: new Uint8ClampedArray(img0.data) };
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const sx = Math.min(W - 1, Math.max(0, x + ldx)), sy = Math.min(H - 1, Math.max(0, y + ldy));
            src.data.set(img0.data.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), (y * W + x) * 4);
          }
        const out = healBlend(img0, src, mask);
        tilesFrom(out, box, stroke.touched, n.tiles, tiles);
        setTiles(page.id, n.id, { ...tiles });
      }
      S().endGesture(t(heal ? "psfeat.hist.heal" : "psfeat.hist.clone"));
    },
    draw(o, toScreen) {
      // the source crosshair follows the brush (Photoshop)
      const q = toScreen([last[0] + d[0], last[1] + d[1]]);
      crosshair(o, q);
    },
  };
}

function crosshair(o: CanvasRenderingContext2D, q: Vec2) {
  o.save();
  for (const [col, w] of [["rgba(0,0,0,.7)", 3], ["#fff", 1]] as const) {
    o.strokeStyle = col;
    o.lineWidth = w;
    o.beginPath();
    o.moveTo(q[0] - 8, q[1]);
    o.lineTo(q[0] + 8, q[1]);
    o.moveTo(q[0], q[1] - 8);
    o.lineTo(q[0], q[1] + 8);
    o.stroke();
  }
  o.restore();
}

// ───────── spot healing brush ─────────

function spotHeal(page: Page, n: RasterNode): ExtDrag | null {
  const box = tileAligned(localPageBox(n.transform, page, n.tiles));
  const s = S();
  const stroke = new DabStroke(box, n.transform, brushSize(n), Math.max(0.5, s.brush.hardness), 1);
  const pts: Vec2[] = [];
  const r = s.brush.size / 2;
  return {
    move(p) {
      pts.push(p);
      stroke.add(p[0], p[1]);
    },
    up() {
      if (!stroke.bounds) return;
      const img = tilesToImg(n.tiles, tb(box));
      const hole = new Uint8Array(box.w * box.h);
      const sel = selectionCoverage(n, box);
      for (let i = 0; i < hole.length; i++) hole[i] = stroke.cov[i] > 0.04 && (!sel || sel[i] > 0.5) ? 1 : 0;
      const out = fillHole(img, hole, box.w, box.h);
      if (!out) return;
      const tiles = { ...n.tiles };
      tilesFrom(out, box, stroke.touched, n.tiles, tiles);
      S().commit(t("psfeat.hist.spotHeal"), (d) => {
        const x = draftPage(d, page.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
        if (x) x.tiles = tiles as any;
      });
    },
    draw(o, toScreen, zoom) {
      // the painted spot shows dark until it is filled (Photoshop)
      if (!pts.length) return;
      o.save();
      o.strokeStyle = "rgba(20,20,20,.55)";
      o.lineCap = o.lineJoin = "round";
      o.lineWidth = Math.max(1, 2 * r * zoom);
      o.beginPath();
      pts.forEach((q, i) => {
        const a = toScreen(q);
        if (i) o.lineTo(a[0], a[1]);
        else o.moveTo(a[0], a[1]);
      });
      if (pts.length === 1) {
        const a = toScreen(pts[0]);
        o.lineTo(a[0] + 0.01, a[1]);
      }
      o.stroke();
      o.restore();
    },
  };
}

/** Content-aware fill of `hole` within a crop round it (the kernel works on the crop, then it is put back). */
export function fillHole(img: Img, hole: Uint8Array, W: number, H: number, seed = 7): Img | null {
  const hb = maskBox(hole, W, H);
  if (!hb) return null;
  const m = Math.max(48, Math.ceil(Math.max(hb.w, hb.h) * 1.2));
  const x0 = Math.max(0, hb.x - m), y0 = Math.max(0, hb.y - m), x1 = Math.min(W, hb.x + hb.w + m), y1 = Math.min(H, hb.y + hb.h + m);
  const cw = x1 - x0, ch = y1 - y0;
  const crop: Img = { width: cw, height: ch, data: new Uint8ClampedArray(cw * ch * 4) };
  const ch2 = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) {
    crop.data.set(img.data.subarray(((y + y0) * W + x0) * 4, ((y + y0) * W + x1) * 4), y * cw * 4);
    ch2.set(hole.subarray((y + y0) * W + x0, (y + y0) * W + x1), y * cw);
  }
  const filled = inpaint(crop, ch2, seed);
  const out: Img = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < ch; y++) out.data.set(filled.data.subarray(y * cw * 4, (y + 1) * cw * 4), ((y + y0) * W + x0) * 4);
  return out;
}

// ───────── patch tool ─────────

function patchTool(page: Page, n: RasterNode, start: Vec2): ExtDrag {
  const sel = activeMask();
  const inside = !!sel && start[0] >= 0 && start[1] >= 0 && start[0] < sel.w && start[1] < sel.h && sel.data[Math.floor(start[1]) * sel.w + Math.floor(start[0])] > 127;
  if (!inside) {
    // draw the patch's outline (as the lasso)
    const pts: Vec2[] = [start];
    return {
      move(p) {
        pts.push(p);
      },
      up() {
        if (pts.length > 2) lassoSelect(pts, "replace");
      },
      draw(o, toScreen) {
        o.save();
        o.strokeStyle = "#fff";
        o.lineWidth = 1;
        o.beginPath();
        pts.forEach((q, i) => {
          const a = toScreen(q);
          if (i) o.lineTo(a[0], a[1]);
          else o.moveTo(a[0], a[1]);
        });
        o.stroke();
        o.setLineDash([4, 4]);
        o.strokeStyle = "#000";
        o.stroke();
        o.restore();
      },
    };
  }
  let cur: Vec2 = start;
  const outline = usePixelSel.getState().outline;
  return {
    move(p) {
      cur = p;
    },
    up() {
      const dx = cur[0] - start[0], dy = cur[1] - start[1];
      if (Math.hypot(dx, dy) < 1) return;
      const box = tileAligned(localPageBox(n.transform, page, n.tiles));
      const img = tilesToImg(n.tiles, tb(box));
      const cov = selectionCoverage(n, box)!;
      const k = Math.abs(n.transform.scale) || 1;
      const ldx = Math.round(dx / k), ldy = Math.round(dy / k);
      const W = box.w, H = box.h;
      const src: Img = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
      const mask = new Uint8Array(W * H);
      const keys = new Set<string>();
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          mask[i] = Math.round(cov[i] * 255);
          if (mask[i]) keys.add(`${Math.floor((x + box.x) / TILE)}_${Math.floor((y + box.y) / TILE)}`);
          const sx = Math.min(W - 1, Math.max(0, x + ldx)), sy = Math.min(H - 1, Math.max(0, y + ldy));
          src.data.set(img.data.subarray((sy * W + sx) * 4, (sy * W + sx) * 4 + 4), i * 4);
        }
      const out = healBlend(img, src, mask);
      const tiles = { ...n.tiles };
      tilesFrom(out, box, keys, n.tiles, tiles);
      S().commit(t("psfeat.hist.patch"), (d) => {
        const x = draftPage(d, page.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
        if (x) x.tiles = tiles as any;
      });
    },
    draw(o, toScreen) {
      // the selection's outline moved to where it takes its pixels from
      if (!outline) return;
      const dx = cur[0] - start[0], dy = cur[1] - start[1];
      o.save();
      o.strokeStyle = "#fff";
      o.lineWidth = 1;
      o.beginPath();
      for (let i = 0; i < outline.length; i += 4) {
        const a = toScreen([outline[i] + dx, outline[i + 1] + dy]), b = toScreen([outline[i + 2] + dx, outline[i + 3] + dy]);
        o.moveTo(a[0], a[1]);
        o.lineTo(b[0], b[1]);
      }
      o.stroke();
      o.setLineDash([3, 3]);
      o.strokeStyle = "#000";
      o.stroke();
      o.restore();
    },
  };
}

// ───────── quick selection / object selection ─────────

function quickSelect(page: Page, start: Vec2, e: PointerEvent): ExtDrag | null {
  const px = samplePixels(page, true);
  if (!px) return null;
  const sub = e.altKey;
  const before = activeMask();
  // Shift adds, Alt takes away; a first stroke without a selection makes one (Photoshop's quick selection adds by default)
  const base = e.shiftKey || !!before ? before : null;
  const pts: Vec2[] = [start];
  const r = Math.max(2, S().brush.size / 2);
  let raf = 0;
  const run = () => {
    raf = 0;
    const m = quickSelectMask(px.data, px.w, px.h, pts, r);
    setSelection(base ? combineQuick(base, m, sub) : m, "replace");
  };
  run();
  return {
    move(p) {
      const l = pts[pts.length - 1];
      if (Math.hypot(p[0] - l[0], p[1] - l[1]) < r * 0.4) return;
      pts.push(p);
      raf ||= requestAnimationFrame(run);
    },
    up() {
      if (raf) cancelAnimationFrame(raf);
      run();
    },
  };
}

function combineQuick(base: { w: number; h: number; data: Uint8Array }, m: { w: number; h: number; data: Uint8Array }, sub: boolean) {
  const out = { w: base.w, h: base.h, data: new Uint8Array(base.data) };
  for (let i = 0; i < out.data.length; i++) out.data[i] = sub ? Math.min(out.data[i], 255 - m.data[i]) : Math.max(out.data[i], m.data[i]);
  return out;
}

function objectSelect(page: Page, start: Vec2, e: PointerEvent): ExtDrag | null {
  let cur: Vec2 = start;
  const op = e.altKey ? "subtract" : e.shiftKey ? "add" : "replace";
  return {
    move(p) {
      cur = p;
    },
    up() {
      const x0 = Math.max(0, Math.floor(Math.min(start[0], cur[0]))), y0 = Math.max(0, Math.floor(Math.min(start[1], cur[1])));
      const x1 = Math.min(page.width, Math.ceil(Math.max(start[0], cur[0]))), y1 = Math.min(page.height, Math.ceil(Math.max(start[1], cur[1])));
      if (x1 - x0 < 4 || y1 - y0 < 4) return void S().notify(t("psfeat.objsel.drag"));
      const px = samplePixels(page, true);
      if (!px) return;
      const m = objectSelectMask(px.data, px.w, px.h, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      if (!m) return void S().notify(t("psfeat.objsel.none"));
      setSelection(m, op);
    },
    draw(o, toScreen) {
      const a = toScreen(start), b = toScreen(cur);
      o.save();
      o.strokeStyle = "#fff";
      o.lineWidth = 1;
      o.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      o.setLineDash([4, 4]);
      o.strokeStyle = "#000";
      o.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      o.restore();
    },
  };
}

// ───────── entry points for CanvasView ─────────

/** A press the extra tools take (null: CanvasView handles it). Image mode only. */
export function extDown(p: Vec2, e: PointerEvent, page: Page): ExtDrag | null {
  if (currentEditMode() !== "IMAGE" || e.button !== 0) return null;
  // free transform: distort / perspective / skew (ui/ps/psTransform.ts)
  const xd = transformDown(p, e, page);
  if (xd) return xd;
  const tool = S().tool as string;
  // the brush / eraser on a layer mask (the mask is the target) or on an adjustment layer (its mask)
  if (tool === "brush" || tool === "eraser") {
    if (e.altKey && tool === "brush") return null;
    const n = soleSelected(page);
    if (n && n.type === "RASTER" && paintsMask(n) && !n.locked) {
      const d = maskPaint(page, n, tool === "eraser");
      d?.move(p, e);
      return d;
    }
    return null;
  }
  if (!EXT_TOOLS.has(tool)) return null;
  if (tool === "quickSelect") return quickSelect(page, p, e);
  if (tool === "objectSelect") return objectSelect(page, p, e);
  if ((tool === "clone" || tool === "heal") && e.altKey) {
    source = { pageId: page.id, p };
    aligned = null;
    S().notify(t("psfeat.clone.sourceSet"));
    return { move() {}, up() {} };
  }
  const n = retouchTarget(page);
  if (!n) return null;
  let d: ExtDrag | null = null;
  if (tool === "clone" || tool === "heal") d = clonePaint(page, n, p, tool === "heal");
  else if (tool === "spotHeal") d = spotHeal(page, n);
  else if (tool === "patch") d = patchTool(page, n, p);
  else if (TONE_TOOLS.has(tool)) {
    // 닷지 · 번 · 스펀지 (ui/ps/toning.tsx)
    const box = tileAligned(localPageBox(n.transform, page, n.tiles));
    d = tonePaint(n, tool as "dodge" | "burn" | "sponge", {
      box,
      size: brushSize(n),
      sel: selectionCoverage(n, box),
      tb,
      commit: (cur, keys, tiles) => {
        tilesFrom(cur, box, keys, n.tiles, tiles);
        setTiles(page.id, n.id, { ...tiles });
      },
      begin: () => S().beginGesture(),
      end: (label) => S().endGesture(label),
    });
  }
  d?.move(p, e);
  return d;
}

const viewCache = new WeakMap<object, { key: string; cv: OffscreenCanvas | HTMLCanvasElement; box: Box }>();

/** The mask shown alone (Alt+click): grey over the layer's area, white = shows. */
function drawMaskView(o: CanvasRenderingContext2D, page: Page, view: { zoom: number; panX: number; panY: number }) {
  const id = useMaskUI.getState().view;
  const n = id ? page.nodes.find((x) => x.id === id) : null;
  const m = maskOf(n);
  if (!n || !m || n.type !== "RASTER") return;
  const box = localPageBox(n.transform, page);
  const key = `${box.x},${box.y},${box.w},${box.h},${m.hide}`;
  let c = viewCache.get(m.tiles);
  if (!c || c.key !== key) {
    const plane = maskPlane(m, box.x, box.y, box.w, box.h);
    const cv = makeCanvas(box.w, box.h);
    const img = new ImageData(box.w, box.h);
    for (let i = 0; i < plane.length; i++) {
      img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = plane[i];
      img.data[i * 4 + 3] = 255;
    }
    (ctx2d(cv) as CanvasRenderingContext2D).putImageData(img, 0, 0);
    c = { key, cv, box };
    viewCache.set(m.tiles, c);
  }
  o.save();
  o.translate(view.panX, view.panY);
  o.scale(view.zoom, view.zoom);
  o.beginPath();
  o.rect(0, 0, page.width, page.height);
  o.clip();
  const tr = n.transform;
  o.translate(tr.x, tr.y);
  o.rotate((tr.rotation * Math.PI) / 180);
  o.scale(tr.scale, tr.scaleY ?? tr.scale);
  o.imageSmoothingEnabled = false;
  o.drawImage(c.cv as CanvasImageSource, c.box.x, c.box.y);
  o.restore();
}

/** Overlay of the extra tools: the mask view, the drag in progress, the brush circle and the clone source. */
export function extOverlay(o: CanvasRenderingContext2D, page: Page, cursor: Vec2, drag: ExtDrag | null, hideCursor: boolean) {
  const s = S();
  const v = s.view;
  const toScreen = (p: Vec2): Vec2 => [p[0] * v.zoom + v.panX, p[1] * v.zoom + v.panY];
  drawMaskView(o, page, v);
  drawWarp(o, toScreen);
  drawActivePath(o, page, toScreen);
  drag?.draw?.(o, toScreen, v.zoom);
  const tool = s.tool as string;
  if (hideCursor || !BRUSHLIKE.has(tool) || currentEditMode() !== "IMAGE") return;
  const c = toScreen(cursor);
  const r = Math.max(1, (s.brush.size / 2) * v.zoom);
  o.save();
  o.strokeStyle = "rgba(255,255,255,.9)";
  o.beginPath();
  o.arc(c[0], c[1], r, 0, Math.PI * 2);
  o.stroke();
  o.strokeStyle = "rgba(0,0,0,.6)";
  o.beginPath();
  o.arc(c[0], c[1], r + 1, 0, Math.PI * 2);
  o.stroke();
  if (tool === "quickSelect") {
    o.beginPath();
    o.moveTo(c[0] - 3, c[1]);
    o.lineTo(c[0] + 3, c[1]);
    o.moveTo(c[0], c[1] - 3);
    o.lineTo(c[0], c[1] + 3);
    o.stroke();
  }
  o.restore();
  if (!drag && (tool === "clone" || tool === "heal") && source && source.pageId === page.id) {
    const q = aligned ? toScreen([cursor[0] + aligned.d[0], cursor[1] + aligned.d[1]]) : toScreen(source.p);
    crosshair(o, q);
  }
}

/** CSS cursor of the extra tools (null: CanvasView's own). */
export function extCursor(tool: string): string | null {
  if (BRUSHLIKE.has(tool)) return "none";
  if (tool === "patch" || tool === "objectSelect") return "crosshair";
  return null;
}

void invertTransform;
