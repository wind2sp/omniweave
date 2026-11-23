// Image edit mode (Photoshop feel): the pixel selection and the edits that honour it.
//
//   선택 윤곽 M (사각형 / 원형, Shift+M) · 올가미 L · 마술봉 W — Shift 추가, Alt 빼기, Shift+Alt 교차
//   Ctrl+D 선택 해제 · Ctrl+Shift+D 다시 선택 · Ctrl+Shift+I 반전 · Ctrl+A 모두 선택 (이미지 모드)
//   Delete 선택 영역 지우기 · Alt+Backspace 전경색 칠 · Ctrl+Backspace 배경색 칠
//   Ctrl+J 선택 영역을 새 레이어로 복사 (선택이 없으면 레이어 복제) · Ctrl+Shift+J 잘라 새 레이어로
//   브러시·지우개·그라디언트는 선택 영역 안에만 칠한다.
//
// The selection itself (core/image/pixelSelection.ts) is view state: not saved, not in the history — as in Photoshop,
// where it is not part of the layer either. Pixel edits go through render/brush.ts Stroke (the same tile commit as a
// brush stroke), so every edit is one undo step and untouched tiles keep their identity.

import { create } from "zustand";
import { applyTransform, invertTransform } from "../core/geom";
import { localBounds } from "../core/loom";
import { borderMask, colorRangeMask, contractMask, expandMask, featherMask, combine, ellipseMask, invertMask, maskBounds, maskOutline, polygonMask, rectMask, wandMask, type SelMask, type SelOp } from "../core/image/pixelSelection";
import { renderMasterOf } from "../core/headerFooter";
import { currentPage, draftPage, useStore } from "../core/store";
import { IDENTITY, newRaster, type Page, type RasterNode, type SceneNode, type Transform } from "../core/types";
import { groupIndex, lockedInTree, pickableOn, shownInTree } from "../core/layerTree";
import { Stroke, canvasToTiles } from "../render/brush";
import { ctx2d, drawNode, makeCanvas, pictureSize, type Ctx, type DrawEnv } from "../render/draw";
import { renderPageCanvas } from "../render/weave";
import { cmykSampled, cmykSampleTile } from "../render/cmykView";
import { pristinePsdView } from "../core/fidelity/overlay";
import { TILE } from "../core/tile";
import { t } from "../i18n";
import { revealTransparencyInPlace } from "./transparency";

const S = () => useStore.getState();

export type MarqueeShape = "rect" | "ellipse";
export type GradientKind = "linear" | "radial";

interface PixelSelState {
  mask: SelMask | null;
  /** page the mask belongs to */
  pageId: string | null;
  /** marching-ants segments [x0,y0,x1,y1,…] (page px), null = too many (draw the bounds) */
  outline: number[] | null;
  bounds: { x: number; y: number; w: number; h: number } | null;
  /** last selection, for Ctrl+Shift+D */
  last: { mask: SelMask; pageId: string } | null;
  marquee: MarqueeShape;
  wandTolerance: number;
  wandContiguous: boolean;
  /** sample every visible layer (on) or only the active layer (off) — the wand and the eyedropper */
  sampleAll: boolean;
  gradient: GradientKind;
  /** background colour (the foreground colour is the brush colour) */
  bg: string;
  set: (p: Partial<PixelSelState>) => void;
}

export const usePixelSel = create<PixelSelState>((set) => ({
  mask: null,
  pageId: null,
  outline: null,
  bounds: null,
  last: null,
  marquee: "rect",
  wandTolerance: 32,
  wandContiguous: true,
  sampleAll: false,
  gradient: "linear",
  bg: "#ffffff",
  set,
}));

/** The selection of the current page (null when none, or when it belongs to another page). */
export function activeMask(): SelMask | null {
  const st = usePixelSel.getState();
  return st.mask && st.pageId === S().pageId ? st.mask : null;
}
export const hasPixelSelection = () => !!activeMask();

/** Set (or with `op`, combine into) the selection of the current page. */
export function setSelection(next: SelMask | null, op: SelOp = "replace") {
  const page = currentPage();
  const st = usePixelSel.getState();
  if (!page || !next) return deselect();
  const merged = combine(activeMask(), next, op);
  const bounds = maskBounds(merged);
  if (!bounds) return deselect();
  usePixelSel.setState({ mask: merged, pageId: page.id, bounds, outline: maskOutline(merged), last: st.last });
}

export function deselect() {
  const st = usePixelSel.getState();
  if (!st.mask) return;
  usePixelSel.setState({ mask: null, outline: null, bounds: null, last: st.pageId ? { mask: st.mask, pageId: st.pageId } : st.last });
}

/** Ctrl+Shift+D */
export function reselect() {
  const l = usePixelSel.getState().last;
  if (l && l.pageId === S().pageId) setSelection(l.mask);
}

export function selectAllPixels() {
  const page = currentPage();
  if (page) setSelection(rectMask(page.width, page.height, 0, 0, page.width, page.height));
}

export function invertSelection() {
  const page = currentPage();
  if (!page) return;
  const m = activeMask();
  setSelection(m ? invertMask(m) : rectMask(page.width, page.height, 0, 0, page.width, page.height));
}

/** 선택 › 수정 (확대 · 축소 · 페더 · 테두리) of the current selection by `r` px; false when there is none. */
export function modifySelection(kind: "expand" | "contract" | "feather" | "border", r: number): boolean {
  const m = activeMask();
  if (!m || !(r > 0)) return false;
  const f = kind === "expand" ? expandMask : kind === "contract" ? contractMask : kind === "feather" ? featherMask : borderMask;
  setSelection(f(m, Math.min(500, r)));
  return true;
}

/** 선택 › 색상 범위: pixels of the visible picture near `rgb` (Photoshop's fuzziness 0…200), combined by `op`. */
export function selectColorRange(rgb: [number, number, number], fuzziness: number, op: SelOp = "replace"): boolean {
  const page = currentPage();
  const s = page && samplePixels(page, true);
  if (!page || !s) return false;
  setSelection(colorRangeMask(s.data, s.w, s.h, rgb, fuzziness), op);
  return !!activeMask();
}

/** Shift = add, Alt = subtract, Shift+Alt = intersect (Photoshop). */
export const opFromMods = (e: { shiftKey: boolean; altKey: boolean }): SelOp => (e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : "replace");

export function marqueeSelect(a: [number, number], b: [number, number], op: SelOp) {
  const page = currentPage();
  if (!page) return;
  const shape = usePixelSel.getState().marquee;
  setSelection((shape === "ellipse" ? ellipseMask : rectMask)(page.width, page.height, a[0], a[1], b[0], b[1]), op);
}

export function lassoSelect(pts: [number, number][], op: SelOp) {
  const page = currentPage();
  if (page && pts.length > 2) setSelection(polygonMask(page.width, page.height, pts), op);
}

// ───────── sampling (wand, eyedropper) ─────────

/** Page-sized RGBA for the wand and the eyedropper. */
export interface Sample {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  /**
   * A CMYK page that blends, sampled with every layer: `data` holds the layers as drawn without the CMYK composite,
   * and the composite only in the 256 px tiles marked `ready` (row-major, `cols` a row) — filled in on demand
   * (`fillCmykTiles`), never the whole page at once on this thread (a large file would stop the app for seconds).
   */
  cmyk?: { page: Page; ready: Uint8Array; cols: number };
}

let sampleMemo: { key: unknown; node: unknown; s: Sample } | null = null;

/** RGBA of the page (every visible layer) or of the active layer alone, page-sized; memoized per document state. */
export function samplePixels(page: Page, all: boolean): Sample | null {
  const doc = S().doc;
  const layer = all ? null : activeLayer(page);
  const key = page;
  if (sampleMemo && sampleMemo.key === key && sampleMemo.node === (layer ?? doc)) return sampleMemo.s;
  const w = Math.max(1, Math.round(page.width)), h = Math.max(1, Math.round(page.height));
  let cv: OffscreenCanvas | HTMLCanvasElement;
  let cmyk = false;
  if (layer) {
    cv = makeCanvas(w, h);
    const env: DrawEnv = { doc, clip: { x: 0, y: 0, w, h }, scale: 1, incomplete: false, onResourceReady: () => {} };
    drawNode(ctx2d(cv), layer, env, undefined, { bare: true });
  } else {
    const master = renderMasterOf(doc, page);
    // as paintPage: an unedited PSD page draws Photoshop's merged image, a master page the layers
    cmyk = !master && !pristinePsdView(page) && cmykSampled(doc, page);
    cv = renderPageCanvas(doc, page, master, 1, cmyk ? "rgb" : false);
  }
  const g = ctx2d(cv) as Ctx & { getImageData: CanvasRenderingContext2D["getImageData"] };
  const data = g.getImageData(0, 0, w, h).data;
  const cols = Math.ceil(w / TILE);
  const s: Sample = { data, w, h, ...(cmyk ? { cmyk: { page, ready: new Uint8Array(cols * Math.ceil(h / TILE)), cols } } : {}) };
  sampleMemo = { key, node: layer ?? doc, s };
  return s;
}

/** ms of CMYK tiles one task may composite for sampling (the first tile of a task always goes) */
const SAMPLE_BUDGET_MS = 40;

/** The page's background colour as RGBA (what the composite is drawn over). */
function backgroundRgba(page: Page): [number, number, number, number] {
  const cv = makeCanvas(1, 1);
  const g = ctx2d(cv) as Ctx & { getImageData: CanvasRenderingContext2D["getImageData"] };
  g.fillStyle = page.background;
  g.fillRect(0, 0, 1, 1);
  const d = g.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

/**
 * Put the CMYK composite of tiles `want` (indices as in `Sample.cmyk`) into a sample, over the page background as
 * the screen draws it — a few tiles a task, between them the app goes on. False when the composite is not to be had
 * (the channels could not be read): the sample keeps the drawn layers there.
 */
export async function fillCmykTiles(s: Sample, want: Iterable<number>): Promise<boolean> {
  const c = s.cmyk;
  if (!c) return true;
  const doc = S().doc;
  const bg = backgroundRgba(c.page);
  const queue = [...want].filter((i) => !c.ready[i]);
  while (queue.length) {
    const t0 = performance.now();
    while (queue.length && performance.now() - t0 < SAMPLE_BUDGET_MS) {
      const i = queue[0];
      const tx = i % c.cols, ty = (i / c.cols) | 0;
      let wake: () => void = () => {};
      const waiting = new Promise<void>((r) => (wake = r));
      const px = cmykSampleTile(doc, c.page, tx, ty, () => wake());
      if (px === null) return false;
      if (px === undefined) {
        await waiting; // the channels are being read (a worker)
        break;
      }
      queue.shift();
      blendTile(s, px, tx, ty, bg);
      c.ready[i] = 1;
    }
    if (queue.length) await new Promise((r) => setTimeout(r, 0));
  }
  return true;
}

/** Tile pixels (straight RGBA, 256 × 256) over the background into the sample (source-over, as the canvas does). */
function blendTile(s: Sample, px: Uint8ClampedArray, tx: number, ty: number, bg: [number, number, number, number]) {
  const x0 = tx * TILE, y0 = ty * TILE;
  const xn = Math.min(TILE, s.w - x0), yn = Math.min(TILE, s.h - y0);
  const ba = bg[3] / 255;
  for (let y = 0; y < yn; y++)
    for (let x = 0; x < xn; x++) {
      const i = (y * TILE + x) * 4, o = ((y0 + y) * s.w + x0 + x) * 4;
      const a = px[i + 3] / 255, out = a + ba * (1 - a);
      for (let k = 0; k < 3; k++) s.data[o + k] = out ? Math.round((px[i + k] * a + bg[k] * ba * (1 - a)) / out) : 0;
      s.data[o + 3] = Math.round(out * 255);
    }
}

/** Is the sampled state still the current one (the user may have edited or switched page while tiles came in)? */
const sameState = (page: Page) => currentPage() === page;

export function wandSelect(p: [number, number], op: SelOp) {
  const page = currentPage();
  if (!page) return;
  const st = usePixelSel.getState();
  const px = samplePixels(page, st.sampleAll || !activeLayer(page));
  if (!px) return;
  const click = ++wandClicks;
  if (!px.cmyk) return setSelection(wandMask(px.data, px.w, px.h, p[0], p[1], st.wandTolerance, st.wandContiguous), op);
  void wandCmyk(page, px, p, op, st.wandTolerance, st.wandContiguous, click, st.mask);
}

/** Wand clicks so far: a CMYK wand still waiting for tiles gives way to a later click. */
let wandClicks = 0;
/** Eyedropper clicks so far (likewise). */
let pickClicks = 0;

/**
 * The wand on a CMYK composite: run it on the tiles there are, composite the tiles it reached past them, again —
 * until it reaches no tile it lacks. Only the area the selection grows into is composited (all of it for a
 * non-contiguous wand, a tile budget a task). Dropped when the user selected something else (or clicked the wand
 * again) meanwhile: what they did last stays (`sel`: the selection when the wand was clicked).
 */
async function wandCmyk(page: Page, px: Sample, p: [number, number], op: SelOp, tol: number, contiguous: boolean, click: number, sel: SelMask | null) {
  const c = px.cmyk!;
  const current = () => sameState(page) && click === wandClicks && usePixelSel.getState().mask === sel;
  for (;;) {
    const missing = new Set<number>();
    const m = wandMask(px.data, px.w, px.h, p[0], p[1], tol, contiguous, { ready: c.ready, cols: c.cols, missing });
    if (!missing.size) return void (current() && setSelection(m, op));
    const ok = await fillCmykTiles(px, missing);
    if (!current()) return;
    if (!ok) {
      // no composite to be had: the layers as drawn
      c.ready.fill(1);
    }
  }
}

/** Eyedropper (I, or Alt+click with the brush): the colour under the pointer becomes the foreground colour. */
export function pickColorAt(p: [number, number], toBackground = false) {
  const page = currentPage();
  if (!page) return;
  const px = samplePixels(page, true);
  if (!px) return;
  const x = Math.floor(p[0]), y = Math.floor(p[1]);
  if (x < 0 || y < 0 || x >= px.w || y >= px.h) return;
  const pick = () => {
    const o = (y * px.w + x) * 4;
    const hex = "#" + [px.data[o], px.data[o + 1], px.data[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
    if (toBackground) usePixelSel.setState({ bg: hex });
    else S().set({ brush: { ...S().brush, color: hex } });
  };
  const click = ++pickClicks;
  if (!px.cmyk) return pick();
  // a CMYK composite: only the tile under the pointer — unless the user clicked again or chose a colour meanwhile
  const before = toBackground ? usePixelSel.getState().bg : S().brush.color;
  const unchanged = () => click === pickClicks && (toBackground ? usePixelSel.getState().bg : S().brush.color) === before;
  void fillCmykTiles(px, [((y / TILE) | 0) * px.cmyk.cols + ((x / TILE) | 0)]).then(() => sameState(page) && unchanged() && pick());
}

// ───────── colours (D · X) ─────────

/** D: black foreground, white background. */
export function defaultColors() {
  S().set({ brush: { ...S().brush, color: "#000000" } });
  usePixelSel.setState({ bg: "#ffffff" });
}
/** X: swap foreground and background. */
export function swapColors() {
  const fg = S().brush.color, bg = usePixelSel.getState().bg;
  S().set({ brush: { ...S().brush, color: bg } });
  usePixelSel.setState({ bg: fg });
}

// ───────── layers ─────────

/** The layer pixel edits act on: the selected (topmost) unlocked layer, else the top visible raster. */
export function activeLayer(page: Page): SceneNode | null {
  const sel = S().selection;
  const idx = groupIndex(page.groups);
  for (let i = page.nodes.length - 1; i >= 0; i--) {
    const n = page.nodes[i];
    if (sel.includes(n.id) && !lockedInTree(n, idx)) return n;
  }
  const pick = pickableOn(page);
  return [...page.nodes].reverse().find((n) => n.type === "RASTER" && pick(n)) ?? null;
}

const PIXEL_TYPES = new Set<SceneNode["type"]>(["RASTER", "IMAGE", "PDF", "VECTOR", "TEXT"]);

/** Largest side of a rasterized layer (px): a canvas past this cannot be made in every browser. */
const RASTER_MAX = 16384;

/**
 * Pixels per local unit when a layer becomes pixels: a picture keeps its own pixels (its image width over its width on
 * the layer), anything else 1. Never more than RASTER_MAX on a side.
 */
export function rasterResolution(lb: { w: number; h: number }, nodeW: number, imageW: number): number {
  let k = nodeW > 0 && imageW > 0 ? imageW / nodeW : 1;
  if (!(k > 0) || !Number.isFinite(k)) k = 1;
  const side = Math.max(lb.w, lb.h) * k;
  return side > RASTER_MAX ? k * (RASTER_MAX / side) : k;
}

/** The raster's transform: its pixel (0, 0) at the layer's local (lb.x, lb.y), k pixels per local unit, same turn / flip. */
export function rasterPlacement(tr: Transform, lb: { x: number; y: number }, k: number): Transform {
  const [x, y] = applyTransform(tr, [lb.x, lb.y]);
  const out: Transform = { ...tr, x, y, scale: tr.scale / k };
  if (tr.scaleY !== undefined) out.scaleY = tr.scaleY / k;
  return out;
}

/**
 * Turn a placed picture / shape / text layer into a pixel layer (Photoshop "Rasterize Layer") so pixel edits can
 * apply to it. One undo step; the picture's original stays in the document's assets (undo brings the layer back).
 * Returns the raster, or null when the layer's picture is not decoded yet.
 */
export function rasterizeLayer(page: Page, n: SceneNode): RasterNode | null {
  if (n.type === "RASTER") return n;
  if (!PIXEL_TYPES.has(n.type)) return null;
  // the layer's own frame and resolution (2026-11-23): before, it was drawn at the canvas size and 100 %, so a picture
  // larger than its place (a photo scaled down) lost resolution and the parts outside the canvas were cut off
  const env: DrawEnv = { doc: S().doc, clip: { x: 0, y: 0, w: 1, h: 1 }, scale: 1, incomplete: false, onResourceReady: () => {} };
  const lb = localBounds(n);
  const px = n.type === "IMAGE" ? pictureSize(n, env) : null;
  const k = rasterResolution(lb, n.type === "IMAGE" ? n.width : 0, px?.w ?? 0);
  const w = Math.max(1, Math.ceil(lb.w * k)), h = Math.max(1, Math.ceil(lb.h * k));
  env.clip = { ...lb };
  env.scale = k;
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv);
  g.scale(k, k);
  g.translate(-lb.x, -lb.y);
  drawNode(g, { ...n, visible: true, transform: { ...IDENTITY } } as SceneNode, env, undefined, { bare: true });
  if (env.incomplete) {
    S().notify(t("imgmode.msg.notReady"));
    return null;
  }
  const r: RasterNode = { ...newRaster(n.name), id: n.id, visible: n.visible, locked: n.locked, opacity: n.opacity, blendMode: n.blendMode, groupId: n.groupId, clip: n.clip, effects: n.effects, tiles: canvasToTiles(cv), transform: rasterPlacement(n.transform, lb, k) };
  if (!r.groupId) delete r.groupId;
  if (!r.clip) delete r.clip;
  if (!r.effects) delete r.effects;
  S().commit(t("imgmode.hist.rasterize"), (d) => {
    const pg = draftPage(d, page.id);
    const i = pg?.nodes.findIndex((x) => x.id === n.id) ?? -1;
    if (pg && i >= 0) pg.nodes[i] = r as any;
  });
  S().notify(t("imgmode.msg.rasterized", { name: n.name }));
  return r;
}

/** The raster to paint on for a pixel edit (rasterizing a picture layer first); null when there is none. */
function editRaster(page: Page, create: boolean): RasterNode | null {
  const n = activeLayer(page);
  if (n) return n.type === "RASTER" ? n : rasterizeLayer(currentPage()!, n);
  if (!create) return null;
  const r = newRaster(t("ribbon.layer.name", { n: page.nodes.filter((x) => x.type === "RASTER").length + 1 }));
  S().commit(t("shell.hist.addRasterLayer"), (d) => void draftPage(d, page.id)?.nodes.push(r as any));
  S().set({ selection: [r.id] });
  return r;
}

/**
 * The layer the brush / eraser paints on (Photoshop: the active layer).
 *  - the selected unlocked pixel layer; a selected picture (an opened PNG / JPG is one) is rasterized first — before
 *    2026-11-23 a picture was passed over, the eraser made an empty raster layer above it and erased nothing there;
 *  - nothing selected: the brush uses the top raster layer, the eraser the top layer with pixels (raster or picture);
 *  - the brush makes a new raster layer when there is none; the eraser never does (there is nothing to erase on it):
 *    null, with a notice saying why.
 * `imageMode` — the image edit mode, where the brush paints on a selected picture as well (other modes: the eraser only).
 */
export function paintTarget(page: Page, erase: boolean, imageMode: boolean, rasterize: (page: Page, n: SceneNode) => RasterNode | null = rasterizeLayer): RasterNode | null {
  const s = S();
  const idx = groupIndex(page.groups);
  const pick = pickableOn(page);
  const pixels = (n: SceneNode) => n.type === "RASTER" || n.type === "IMAGE";
  const selected = page.nodes.filter((n) => s.selection.includes(n.id) && pixels(n));
  const open = selected.find((n) => !lockedInTree(n, idx) && shownInTree(n, idx));
  if (open) {
    if (open.type === "RASTER") return open;
    if (erase || imageMode) return rasterize(page, open);
  } else if (selected.length) {
    // the chosen layer is locked or hidden: nothing is painted (Photoshop), and not some other layer instead
    const locked = selected.some((n) => lockedInTree(n, idx));
    s.notify(t(locked ? (erase ? "imgmode.msg.layerLocked" : "imgmode.msg.layerLockedPaint") : "imgmode.msg.layerHidden"));
    return null;
  }
  const top = [...page.nodes].reverse().find((n) => pick(n) && (erase ? (n.type === "RASTER" && Object.keys(n.tiles).length > 0) || (imageMode && n.type === "IMAGE") : n.type === "RASTER"));
  if (top) {
    if (top.type === "RASTER") return top;
    const r = rasterize(page, top);
    if (r) s.set({ selection: [r.id] });
    return r;
  }
  if (erase) {
    s.notify(t("imgmode.msg.nothingToErase"));
    return null;
  }
  const r = newRaster();
  s.commit(t("shell.hist.addRasterLayer"), (d) => void draftPage(d, page.id)?.nodes.push(r as any));
  s.set({ selection: [r.id] });
  return r;
}

const matrixOf = (tr: Transform) => new DOMMatrix().translateSelf(tr.x, tr.y).rotateSelf(tr.rotation).scaleSelf(tr.scale, tr.scaleY ?? tr.scale);

const maskCanvases = new WeakMap<SelMask, OffscreenCanvas | HTMLCanvasElement>();
/** The selection as an alpha canvas (page px). */
export function maskCanvas(m: SelMask) {
  let c = maskCanvases.get(m);
  if (!c) {
    c = makeCanvas(m.w, m.h);
    const img = new ImageData(m.w, m.h);
    for (let i = 0; i < m.data.length; i++) img.data[i * 4 + 3] = m.data[i];
    ctx2d(c).putImageData(img, 0, 0);
    maskCanvases.set(m, c);
  }
  return c;
}

/** Keep only the part of a stroke mask (node-local canvas) inside the selection. */
export function clipToSelection(target: OffscreenCanvas | HTMLCanvasElement, tr: Transform, ox = 0, oy = 0) {
  const m = activeMask();
  if (!m) return;
  const g = ctx2d(target);
  g.save();
  // the target's (0, 0) is node-local (-ox, -oy) (a brush stroke reaching left of / above the layer's origin)
  g.setTransform(new DOMMatrix().translateSelf(ox, oy).multiplySelf(matrixOf(tr).invertSelf()));
  g.globalCompositeOperation = "destination-in";
  g.drawImage(maskCanvas(m), 0, 0);
  g.restore();
}

/** Node-local bounds of a page rectangle. */
function localRect(tr: Transform, r: { x: number; y: number; w: number; h: number }) {
  const pts = [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map((p) => invertTransform(tr, p as [number, number]));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.floor(Math.min(...xs)) - 1, y = Math.floor(Math.min(...ys)) - 1;
  return { x, y, w: Math.ceil(Math.max(...xs)) + 1 - x, h: Math.ceil(Math.max(...ys)) + 1 - y };
}

/**
 * Paint page-space content into the active raster through the selection: `draw` paints in page coordinates on a
 * canvas mapped to the layer; erase = clear what it paints. One undo step labelled `label`.
 */
function paintThroughSelection(label: string, draw: (g: Ctx, page: Page) => void, opts: { erase?: boolean; opacity?: number; create?: boolean } = {}): boolean {
  const page = currentPage();
  if (!page) return false;
  const raster = editRaster(page, opts.create ?? true);
  if (!raster) return false;
  const pg = currentPage()!;
  const stroke = new Stroke(raster, pg.width, pg.height, { ...S().brush, opacity: opts.opacity ?? 1 }, !!opts.erase);
  // the whole page, also left of / above the layer's origin (Stroke.full: its (0, 0) is node-local (-ox, -oy))
  const g = ctx2d(stroke.full);
  g.save();
  g.setTransform(new DOMMatrix().translateSelf(stroke.ox, stroke.oy).multiplySelf(matrixOf(raster.transform).invertSelf()));
  draw(g, pg);
  g.restore();
  clipToSelection(stroke.full, raster.transform, stroke.ox, stroke.oy);
  const area = usePixelSel.getState().bounds && activeMask() ? usePixelSel.getState().bounds! : { x: 0, y: 0, w: pg.width, h: pg.height };
  stroke.bounds = localRect(raster.transform, area);
  const tiles = stroke.commit();
  if (!tiles) return false;
  S().commit(label, (d) => {
    const dp = draftPage(d, pg.id);
    const n = dp?.nodes.find((x) => x.id === raster.id) as any;
    if (n) n.tiles = tiles;
    if (dp && opts.erase) revealTransparencyInPlace(dp);
  });
  return true;
}

const fillAll = (color: string) => (g: Ctx, page: Page) => {
  g.fillStyle = color;
  g.fillRect(-page.width, -page.height, page.width * 3, page.height * 3);
};

/** Delete / Backspace with a selection: clear its pixels on the active layer. */
export function clearSelectionPixels(): boolean {
  if (!activeMask()) return false;
  paintThroughSelection(t("imgmode.hist.clear"), fillAll("#000000"), { erase: true, create: false });
  return true;
}

/** Alt+Backspace (foreground) / Ctrl+Backspace (background): fill the selection, or the whole layer. */
export function fillSelection(which: "fg" | "bg") {
  const color = which === "fg" ? S().brush.color : usePixelSel.getState().bg;
  paintThroughSelection(which === "fg" ? t("imgmode.hist.fillFg") : t("imgmode.hist.fillBg"), fillAll(color));
}

/** Gradient tool: foreground → background along a → b, inside the selection (or the whole layer). */
export function applyGradient(a: [number, number], b: [number, number]) {
  const fg = S().brush.color, bg = usePixelSel.getState().bg;
  const kind = usePixelSel.getState().gradient;
  paintThroughSelection(t("imgmode.hist.gradient"), (g, page) => {
    const gr = kind === "radial" ? g.createRadialGradient(a[0], a[1], 0, a[0], a[1], Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]))) : g.createLinearGradient(a[0], a[1], b[0], b[1]);
    gr.addColorStop(0, fg);
    gr.addColorStop(1, bg);
    g.fillStyle = gr;
    g.fillRect(-page.width, -page.height, page.width * 3, page.height * 3);
  }, { opacity: S().brush.opacity });
}

/**
 * Ctrl+J with a selection: the selected pixels of the active layer on a new layer right above it (Photoshop "Layer
 * via Copy"); `cut` also clears them from the source (Ctrl+Shift+J). False when there is no selection.
 */
export function layerViaCopy(cut = false): boolean {
  const m = activeMask();
  const page = currentPage();
  if (!m || !page) return false;
  const src = activeLayer(page);
  if (!src) return false;
  const w = m.w, h = m.h;
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv);
  const env: DrawEnv = { doc: S().doc, clip: { x: 0, y: 0, w, h }, scale: 1, incomplete: false, onResourceReady: () => {} };
  drawNode(g, src, env, undefined, { bare: true });
  if (env.incomplete) {
    S().notify(t("imgmode.msg.notReady"));
    return true;
  }
  g.globalCompositeOperation = "destination-in";
  g.drawImage(maskCanvas(m), 0, 0);
  const r: RasterNode = { ...newRaster(cut ? t("imgmode.layer.cutName", { name: src.name }) : t("imgmode.layer.copyName", { name: src.name })), transform: { ...IDENTITY }, tiles: canvasToTiles(cv), opacity: src.opacity, blendMode: src.blendMode };
  if (src.groupId) r.groupId = src.groupId;
  if (cut) {
    if (!clearSelectionPixels()) return true;
  }
  const at = currentPage()!.nodes.findIndex((n) => n.id === src.id) + 1;
  S().commit(cut ? t("imgmode.hist.layerViaCut") : t("imgmode.hist.layerViaCopy"), (d) => void draftPage(d, page.id)?.nodes.splice(at, 0, r as any));
  S().set({ selection: [r.id] });
  return true;
}

/** Crop the canvas to the selection (Image ▸ Crop): the page shrinks to the selection bounds, layers move. */
export function cropToSelection(): boolean {
  const b = usePixelSel.getState().bounds;
  const page = currentPage();
  if (!b || !page || !activeMask()) return false;
  S().commit(t("imgmode.hist.cropToSel"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.width = b.w;
    pg.height = b.h;
    for (const n of pg.nodes) {
      n.transform.x -= b.x;
      n.transform.y -= b.y;
    }
  });
  deselect();
  return true;
}

// keep the selection with its page: a page whose size changes drops it (its mask no longer fits)
useStore.subscribe((s, p) => {
  if (s.doc === p.doc) return;
  const st = usePixelSel.getState();
  if (!st.mask) return;
  const pg = s.doc.pages.find((x) => x.id === st.pageId) ?? s.doc.masters.find((x) => x.id === st.pageId);
  if (!pg || Math.round(pg.width) !== st.mask.w || Math.round(pg.height) !== st.mask.h) deselect();
});

