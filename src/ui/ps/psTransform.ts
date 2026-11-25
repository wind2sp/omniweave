// Free transform (Ctrl+T) beyond size and turn, as in Photoshop:
//   Ctrl+drag a corner                왜곡 (distort): that corner goes anywhere
//   Ctrl+Alt+Shift+drag a corner      원근 (perspective): the corner and its neighbour on that edge move apart / together
//   Ctrl+drag a side handle           기울이기 (skew): the side slides along itself
//   right-click while transforming    회전 180° / 90° · 가로 / 세로로 뒤집기 · 왜곡 / 원근 / 기울이기 (then a plain drag does it)
// A pixel layer is warped through the projective map of its painted box onto the new corners (bilinear); a picture,
// shape or text layer is made pixels first. Each drag is one undo step; Enter keeps, Esc undoes the session (xform.ts).

import { applyTransform } from "../../core/geom";
import { rasterContentBounds } from "../../core/loom";
import { imgToTiles, tilesToImg, tileBounds, type Img } from "../../core/image/pixels";
import { currentPage, draftPage, useStore } from "../../core/store";
import type { Page, RasterNode, Vec2 } from "../../core/types";
import { t } from "../../i18n";
import { currentEditMode } from "../editModes";
import { rasterizeLayer } from "../pixelSelect";
import { flipSelected, startTransformSession, useXform } from "../xform";
import { rotateSelected90 } from "../menuActions";
import type { MenuItem } from "../shell/controls";
import type { ExtDrag } from "./canvasExt";
import { create } from "zustand";
import { ctx2d, makeCanvas } from "../../render/draw";

const S = () => useStore.getState();

export type XMode = "free" | "distort" | "perspective" | "skew" | "warp";
export const useXMode = create<{ mode: XMode; set: (m: XMode) => void }>((set) => ({ mode: "free", set: (mode) => set({ mode }) }));
useXform.subscribe((s, p) => {
  if (s.session == null && p.session != null) {
    useXMode.getState().set("free");
    warp = null;
  }
});

/** 3 × 3 projective map of the unit square onto quad q (corners tl, tr, br, bl). */
export function squareToQuad(q: Vec2[]): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** `src` (its box `r` in its own pixels) warped onto page quad `q`: the image over the quad's bounding box. */
export function warpImage(src: Img, r: { x: number; y: number; w: number; h: number }, ox: number, oy: number, q: Vec2[]): { img: Img; x: number; y: number } {
  const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
  const X0 = Math.floor(Math.min(...xs)), Y0 = Math.floor(Math.min(...ys));
  const W = Math.max(1, Math.ceil(Math.max(...xs)) - X0), H = Math.max(1, Math.ceil(Math.max(...ys)) - Y0);
  const inv = invert3(squareToQuad(q));
  const out: Img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const sw = src.width, sh = src.height, s = src.data;
  const at = (x: number, y: number, c: number) => (x < 0 || y < 0 || x >= sw || y >= sh ? 0 : s[(y * sw + x) * 4 + c]);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const px = X0 + x + 0.5, py = Y0 + y + 0.5;
      const w = inv[6] * px + inv[7] * py + inv[8];
      const u = (inv[0] * px + inv[1] * py + inv[2]) / w, v = (inv[3] * px + inv[4] * py + inv[5]) / w;
      if (u < -0.001 || v < -0.001 || u > 1.001 || v > 1.001) continue;
      // source pixel position (its own pixels, relative to the image `src` that starts at ox, oy)
      const sx = r.x + u * r.w - ox - 0.5, sy = r.y + v * r.h - oy - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy), ax = sx - x0, ay = sy - y0;
      let R = 0, G = 0, B = 0, A = 0;
      for (const [dx, dy, wt] of [[0, 0, (1 - ax) * (1 - ay)], [1, 0, ax * (1 - ay)], [0, 1, (1 - ax) * ay], [1, 1, ax * ay]] as const) {
        const a = at(x0 + dx, y0 + dy, 3) * wt;
        if (!a) continue;
        R += at(x0 + dx, y0 + dy, 0) * a;
        G += at(x0 + dx, y0 + dy, 1) * a;
        B += at(x0 + dx, y0 + dy, 2) * a;
        A += a;
      }
      if (A <= 0) continue;
      const o = (y * W + x) * 4;
      out.data[o] = R / A;
      out.data[o + 1] = G / A;
      out.data[o + 2] = B / A;
      out.data[o + 3] = A;
    }
  return { img: out, x: X0, y: Y0 };
}

/** Corners (tl, tr, br, bl) of a raster's painted box on the page. */
function cornersOf(n: RasterNode): Vec2[] {
  const b = rasterContentBounds(n);
  return ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as Vec2[]).map((p) => applyTransform(n.transform, p));
}

/** The one layer the session transforms, made pixels when needed. */
function sessionRaster(page: Page): RasterNode | null {
  const sel = S().selection;
  if (sel.length !== 1) return null;
  const n = page.nodes.find((x) => x.id === sel[0]);
  if (!n || n.locked) return null;
  if (n.type === "RASTER") return n.adjust ? null : n;
  if (n.type === "IMAGE" || n.type === "VECTOR" || n.type === "TEXT") return rasterizeLayer(page, n);
  return null;
}

/**
 * A press on a handle while transforming: Ctrl (distort / skew), Ctrl+Alt+Shift (perspective), or any press when a
 * mode was picked from the right-click menu. Null: CanvasView's own transform handles it.
 */
export function transformDown(p: Vec2, e: PointerEvent, page: Page): ExtDrag | null {
  if (useXform.getState().session == null || currentEditMode() !== "IMAGE" || S().tool !== "select") return null;
  const mod = e.ctrlKey || e.metaKey;
  const pick = useXMode.getState().mode;
  if (pick === "warp") return warpDown(p, page);
  if (!mod && pick === "free") return null;
  const sel = S().selection;
  const n0 = page.nodes.find((x) => x.id === sel[0]);
  if (sel.length !== 1 || !n0 || n0.type !== "RASTER" || n0.adjust) {
    if (!n0 || sel.length !== 1) return null;
  }
  const zoom = S().view.zoom;
  const tol = 9 / zoom;
  // the handle under the press: a corner (0..3) or a side (4..7: top, right, bottom, left)
  const probe = n0 && n0.type === "RASTER" ? cornersOf(n0) : null;
  if (!probe) {
    // a picture / shape / text: made pixels on the first warp press
    const r = sessionRaster(page);
    if (!r) return null;
    return transformDown(p, e, currentPage()!);
  }
  const mids = probe.map((c, i) => [(c[0] + probe[(i + 1) % 4][0]) / 2, (c[1] + probe[(i + 1) % 4][1]) / 2] as Vec2);
  const near = (q: Vec2) => Math.hypot(q[0] - p[0], q[1] - p[1]) <= tol;
  let corner = probe.findIndex(near);
  const side = corner < 0 ? mids.findIndex(near) : -1;
  if (corner < 0 && side < 0) return null;
  const mode: XMode = mod ? (e.altKey && e.shiftKey ? "perspective" : side >= 0 ? "skew" : "distort") : pick === "skew" && corner >= 0 ? "distort" : pick === "perspective" && side >= 0 ? "skew" : pick;
  if (mode === "skew" && side < 0) corner = -1;
  const n = n0 as RasterNode;
  const b = tileBounds(n.tiles);
  if (!b) return null;
  const src = tilesToImg(n.tiles, b);
  const r = rasterContentBounds(n);
  const start = probe.map((c) => [c[0], c[1]] as Vec2);
  const s = S();
  s.beginGesture();
  let raf = 0, cur = p;
  const quadNow = (): Vec2[] => {
    const q = start.map((c) => [c[0], c[1]] as Vec2);
    const dx = cur[0] - p[0], dy = cur[1] - p[1];
    if (mode === "distort" && corner >= 0) q[corner] = [start[corner][0] + dx, start[corner][1] + dy];
    else if (mode === "perspective" && corner >= 0) {
      // the corner and its neighbour on the edge the drag runs along move mirror-wise (Photoshop's perspective)
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const pair = horiz ? [0, 1, 3, 2][corner] : [3, 2, 1, 0][corner];
      q[corner] = horiz ? [start[corner][0] + dx, start[corner][1]] : [start[corner][0], start[corner][1] + dy];
      q[pair] = horiz ? [start[pair][0] - dx, start[pair][1]] : [start[pair][0], start[pair][1] - dy];
    } else if (side >= 0) {
      // skew: both ends of the side slide along it
      const a = side, c = (side + 1) % 4;
      const ex = start[c][0] - start[a][0], ey = start[c][1] - start[a][1], len = Math.hypot(ex, ey) || 1;
      const along = (dx * ex + dy * ey) / len;
      const mx = (ex / len) * along, my = (ey / len) * along;
      q[a] = [start[a][0] + mx, start[a][1] + my];
      q[c] = [start[c][0] + mx, start[c][1] + my];
    }
    return q;
  };
  const flush = () => {
    raf = 0;
    const q = quadNow();
    const w = warpImage(src, r, b.ox, b.oy, q);
    const tiles = imgToTiles(w.img, 0, 0, {}).tiles;
    S().updateGesture((d) => {
      const x = draftPage(d, page.id)?.nodes.find((k) => k.id === n.id) as RasterNode | undefined;
      if (!x) return;
      x.tiles = tiles as any;
      x.transform = { x: w.x, y: w.y, rotation: 0, scale: 1 };
      delete x.mask;
      delete x.crop;
    });
    useXform.getState().set({ readout: t(`psfeat.xform.${mode}`) });
  };
  return {
    move(q) {
      cur = q;
      raf ||= requestAnimationFrame(flush);
    },
    up() {
      if (raf) cancelAnimationFrame(raf);
      if (cur[0] !== p[0] || cur[1] !== p[1]) flush();
      S().endGesture(t(`psfeat.xform.${mode}`));
      useXform.getState().set({ readout: null });
    },
    draw(o, toScreen) {
      const q = quadNow().map(toScreen);
      o.save();
      o.strokeStyle = "#4f7cff";
      o.lineWidth = 1;
      o.beginPath();
      q.forEach((c, i) => (i ? o.lineTo(c[0], c[1]) : o.moveTo(c[0], c[1])));
      o.closePath();
      o.stroke();
      o.restore();
    },
  };
}

/** The right-click menu while transforming (Photoshop's free transform menu); null when no session. */
export function transformMenu(): MenuItem[] | null {
  if (useXform.getState().session == null || currentEditMode() !== "IMAGE") return null;
  const m = useXMode.getState();
  const it = (k: XMode): MenuItem => ({ label: t(`psfeat.xform.${k}`), checked: m.mode === k, onSelect: () => m.set(k) });
  return [
    it("free"),
    it("skew"),
    it("distort"),
    it("perspective"),
    it("warp"),
    { sep: true },
    { label: t("psfeat.xform.rot180"), onSelect: () => (rotateSelected90(1), rotateSelected90(1)) },
    { label: t("psfeat.xform.rotCW"), onSelect: () => rotateSelected90(1) },
    { label: t("psfeat.xform.rotCCW"), onSelect: () => rotateSelected90(-1) },
    { sep: true },
    { label: t("psfeat.xform.flipH"), onSelect: () => flipSelected("h") },
    { label: t("psfeat.xform.flipV"), onSelect: () => flipSelected("v") },
  ];
}

// ───────── warp (뒤틀기): a 4 × 4 Bézier patch over the layer's painted box ─────────

interface WarpState {
  id: string;
  /** control points, row-major (v then u), page px */
  c: Vec2[];
  /** the layer as it was when the warp began (source of every frame) */
  src: HTMLCanvasElement | OffscreenCanvas;
  r: { x: number; y: number; w: number; h: number };
  ox: number;
  oy: number;
  tr: RasterNode["transform"];
}
let warp: WarpState | null = null;

const bern = (t: number) => [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
function patchAt(c: Vec2[], u: number, v: number): Vec2 {
  const bu = bern(u), bv = bern(v);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const w = bu[i] * bv[j];
    x += c[j * 4 + i][0] * w;
    y += c[j * 4 + i][1] * w;
  }
  return [x, y];
}

/** Start warping the selected layer (the right-click menu's 뒤틀기, or 편집 › 변형 › 뒤틀기). */
function startWarp(page: Page): WarpState | null {
  const n = sessionRaster(page);
  if (!n) return null;
  const pg = currentPage()!;
  const cur = pg.nodes.find((x) => x.id === n.id) as RasterNode;
  const b = tileBounds(cur.tiles);
  if (!b) return null;
  const img = tilesToImg(cur.tiles, b);
  const cv = makeCanvas(b.width, b.height);
  (ctx2d(cv) as CanvasRenderingContext2D).putImageData(new ImageData(img.data, b.width, b.height), 0, 0);
  const r = rasterContentBounds(cur);
  const c: Vec2[] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) c.push(applyTransform(cur.transform, [r.x + (r.w * i) / 3, r.y + (r.h * j) / 3]));
  warp = { id: cur.id, c, src: cv, r, ox: b.ox, oy: b.oy, tr: cur.transform };
  return warp;
}

/** The warped layer drawn through a mesh of small affine triangles. */
function renderWarp(w: WarpState): { img: Img; x: number; y: number } {
  const N = 24;
  const pts: Vec2[][] = [];
  for (let j = 0; j <= N; j++) {
    const row: Vec2[] = [];
    for (let i = 0; i <= N; i++) row.push(patchAt(w.c, i / N, j / N));
    pts.push(row);
  }
  const all = pts.flat();
  const X0 = Math.floor(Math.min(...all.map((p) => p[0]))) - 1, Y0 = Math.floor(Math.min(...all.map((p) => p[1]))) - 1;
  const W = Math.max(1, Math.ceil(Math.max(...all.map((p) => p[0]))) + 1 - X0), H = Math.max(1, Math.ceil(Math.max(...all.map((p) => p[1]))) + 1 - Y0);
  const cv = makeCanvas(Math.min(W, 16384), Math.min(H, 16384));
  const g = ctx2d(cv) as CanvasRenderingContext2D;
  // source position (the layer's own pixels relative to its image) of mesh vertex (i, j); a turned / scaled layer is
  // warped from its own pixels, so its transform only placed the mesh
  const sp = (i: number, j: number): Vec2 => [w.r.x + (w.r.w * i) / N - w.ox, w.r.y + (w.r.h * j) / N - w.oy];
  const tri = (a: [number, number], b: [number, number], c: [number, number]) => {
    const [s0, s1, s2] = [sp(...a), sp(...b), sp(...c)];
    const [d0, d1, d2] = [pts[a[1]][a[0]], pts[b[1]][b[0]], pts[c[1]][c[0]]].map((p) => [p[0] - X0, p[1] - Y0] as Vec2);
    // affine map source triangle → destination triangle
    const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (!den) return;
    const m11 = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
    const m12 = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
    const m21 = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
    const m22 = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
    const dx = d0[0] - m11 * s0[0] - m12 * s0[1], dy = d0[1] - m21 * s0[0] - m22 * s0[1];
    // the triangle grown by half a pixel from its centre (no hairline seams between neighbours)
    const cx = (d0[0] + d1[0] + d2[0]) / 3, cy = (d0[1] + d1[1] + d2[1]) / 3;
    const grow = (p: Vec2): Vec2 => {
      const l = Math.hypot(p[0] - cx, p[1] - cy) || 1;
      return [p[0] + ((p[0] - cx) / l) * 0.6, p[1] + ((p[1] - cy) / l) * 0.6];
    };
    const [e0, e1, e2] = [grow(d0), grow(d1), grow(d2)];
    g.save();
    g.beginPath();
    g.moveTo(e0[0], e0[1]);
    g.lineTo(e1[0], e1[1]);
    g.lineTo(e2[0], e2[1]);
    g.closePath();
    g.clip();
    g.setTransform(m11, m21, m12, m22, dx, dy);
    g.drawImage(w.src as CanvasImageSource, 0, 0);
    g.restore();
  };
  for (let j = 0; j < N; j++)
    for (let i = 0; i < N; i++) {
      tri([i, j], [i + 1, j], [i, j + 1]);
      tri([i + 1, j], [i + 1, j + 1], [i, j + 1]);
    }
  const d = g.getImageData(0, 0, cv.width, cv.height);
  return { img: { width: cv.width, height: cv.height, data: d.data }, x: X0, y: Y0 };
}

function warpDown(p: Vec2, page: Page): ExtDrag | null {
  const w = warp ?? startWarp(page);
  if (!w) return null;
  const tol = 10 / S().view.zoom;
  let k = -1, best = tol;
  w.c.forEach((q, i) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= best) ((best = d), (k = i));
  });
  // a press inside the patch away from the points: the nearest inner point pulls along (Photoshop moves the mesh)
  if (k < 0) {
    const inner = [5, 6, 9, 10];
    k = inner.reduce((a, i) => (Math.hypot(w.c[i][0] - p[0], w.c[i][1] - p[1]) < Math.hypot(w.c[a][0] - p[0], w.c[a][1] - p[1]) ? i : a), inner[0]);
  }
  const start = w.c.map((q) => [q[0], q[1]] as Vec2);
  S().beginGesture();
  let raf = 0, cur = p;
  const flush = () => {
    raf = 0;
    const dx = cur[0] - p[0], dy = cur[1] - p[1];
    w.c[k] = [start[k][0] + dx, start[k][1] + dy];
    // a corner drags its two handles along (Photoshop)
    const nb: Record<number, number[]> = { 0: [1, 4], 3: [2, 7], 12: [8, 13], 15: [11, 14] };
    for (const h of nb[k] ?? []) w.c[h] = [start[h][0] + dx, start[h][1] + dy];
    const r = renderWarp(w);
    const tiles = imgToTiles(r.img, 0, 0, {}).tiles;
    S().updateGesture((d) => {
      const x = draftPage(d, page.id)?.nodes.find((q) => q.id === w.id) as RasterNode | undefined;
      if (!x) return;
      x.tiles = tiles as any;
      x.transform = { x: r.x, y: r.y, rotation: 0, scale: 1 };
      delete x.mask;
      delete x.crop;
    });
  };
  return {
    move(q) {
      cur = q;
      raf ||= requestAnimationFrame(flush);
    },
    up() {
      if (raf) cancelAnimationFrame(raf);
      if (cur[0] !== p[0] || cur[1] !== p[1]) flush();
      S().endGesture(t("psfeat.xform.warp"));
    },
  };
}

/** The warp mesh on the canvas while warping: the patch's grid lines and its 16 points. */
export function drawWarp(o: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2) {
  if (!warp || useXMode.getState().mode !== "warp") return;
  const w = warp;
  o.save();
  o.strokeStyle = "rgba(79,124,255,.9)";
  o.lineWidth = 1;
  for (let a = 0; a <= 3; a++)
    for (const along of [0, 1]) {
      o.beginPath();
      for (let s = 0; s <= 30; s++) {
        const q = toScreen(along ? patchAt(w.c, a / 3, s / 30) : patchAt(w.c, s / 30, a / 3));
        if (s) o.lineTo(q[0], q[1]);
        else o.moveTo(q[0], q[1]);
      }
      o.stroke();
    }
  o.fillStyle = "#fff";
  for (const c of w.c) {
    const q = toScreen(c);
    o.fillRect(q[0] - 3, q[1] - 3, 6, 6);
    o.strokeRect(q[0] - 3, q[1] - 3, 6, 6);
  }
  o.restore();
}

/** 편집 › 변형 › 뒤틀기: a transform session on the selected layer, in warp mode. */
export function startWarpCommand() {
  if (useXform.getState().session == null) startTransformSession();
  if (useXform.getState().session == null) return;
  useXMode.getState().set("warp");
  S().notify(t("psfeat.xform.warpHint"));
}