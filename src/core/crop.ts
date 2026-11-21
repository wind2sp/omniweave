// Non-destructive crop (pure). Images, raster layers (PSD) and PDF pages keep every original
// pixel / operator; `node.crop` (node-local rectangle) only limits what is shown, exported and hit.
// Removing the crop brings the whole original back. The canvas edits the rectangle with the same
// handles as free transform (core/transform.ts).

import type { Rect } from "./geom";
import { TILE, type CropRect, type SceneNode, type Vec2 } from "./types";
import { HANDLE_POS, type Handle } from "./transform";

export type Croppable = Extract<SceneNode, { type: "IMAGE" | "RASTER" | "PDF" }>;

export function canCrop(n: SceneNode | undefined | null): n is Croppable {
  return !!n && (n.type === "IMAGE" || n.type === "RASTER" || n.type === "PDF");
}

/** The whole content of a node, ignoring any crop (node-local). */
export function fullBounds(n: Croppable): Rect {
  if (n.type !== "RASTER") return { x: 0, y: 0, w: n.width, h: n.height };
  const keys = Object.keys(n.tiles);
  if (!keys.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of keys) {
    const i = k.indexOf("_");
    const tx = +k.slice(0, i), ty = +k.slice(i + 1);
    x0 = Math.min(x0, tx);
    y0 = Math.min(y0, ty);
    x1 = Math.max(x1, tx);
    y1 = Math.max(y1, ty);
  }
  return { x: x0 * TILE, y: y0 * TILE, w: (x1 - x0 + 1) * TILE, h: (y1 - y0 + 1) * TILE };
}

/** Visible part: the crop clipped to the content (or the content when not cropped). */
export function visibleBounds(n: Croppable): Rect {
  const f = fullBounds(n);
  return n.crop ? intersect(n.crop, f) : f;
}

export function intersect(a: Rect, b: Rect): Rect {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

const MIN = 1;

/** Keep a rectangle inside `full` (moving it first, shrinking only when it is larger). */
export function clampInto(r: Rect, full: Rect): Rect {
  const w = Math.min(Math.max(MIN, r.w), full.w), h = Math.min(Math.max(MIN, r.h), full.h);
  const x = Math.min(Math.max(r.x, full.x), full.x + full.w - w);
  const y = Math.min(Math.max(r.y, full.y), full.y + full.h - h);
  return { x, y, w, h };
}

/** Move the crop rectangle by a local delta, staying inside the content. */
export function moveCrop(r: Rect, dx: number, dy: number, full: Rect): Rect {
  return clampInto({ ...r, x: r.x + dx, y: r.y + dy }, full);
}

export interface CropDragOpts {
  /** on-page aspect ratio (w / h) to keep, or null for free */
  ratio?: number | null;
  /** node scale (local → page) per axis, so the ratio is the one seen on the page */
  sx?: number;
  sy?: number;
  fromCenter?: boolean;
}

/**
 * Drag a crop handle to local point `q`. Edges move one side, corners two; Alt = symmetric about
 * the centre. With a ratio the other side follows. The result stays inside `full`.
 */
export function resizeCrop(r: Rect, handle: Handle, q: Vec2, full: Rect, o: CropDragOpts = {}): Rect {
  const [fx, fy] = HANDLE_POS[handle];
  let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const qx = Math.min(Math.max(q[0], full.x), full.x + full.w), qy = Math.min(Math.max(q[1], full.y), full.y + full.h);
  if (fx === 0) x0 = Math.min(qx, x1 - MIN);
  if (fx === 1) x1 = Math.max(qx, x0 + MIN);
  if (fy === 0) y0 = Math.min(qy, y1 - MIN);
  if (fy === 1) y1 = Math.max(qy, y0 + MIN);
  if (o.fromCenter) {
    if (fx === 0) x1 = 2 * cx - x0;
    if (fx === 1) x0 = 2 * cx - x1;
    if (fy === 0) y1 = 2 * cy - y0;
    if (fy === 1) y0 = 2 * cy - y1;
  }
  let out: Rect = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  if (o.ratio) {
    const sx = Math.abs(o.sx ?? 1) || 1, sy = Math.abs(o.sy ?? 1) || 1;
    // local ratio that looks like `ratio` on the page
    const lr = (o.ratio * sy) / sx;
    const movesX = fx !== 0.5, movesY = fy !== 0.5;
    let w = out.w, h = out.h;
    if (movesX && !movesY) h = w / lr;
    else if (movesY && !movesX) w = h * lr;
    else if (w / h > lr) h = w / lr;
    else w = h * lr;
    // keep the side opposite the handle fixed (or the centre)
    const ax = o.fromCenter || !movesX ? out.x + out.w / 2 : fx === 0 ? out.x + out.w : out.x;
    const ay = o.fromCenter || !movesY ? out.y + out.h / 2 : fy === 0 ? out.y + out.h : out.y;
    const nx = o.fromCenter || !movesX ? ax - w / 2 : fx === 0 ? ax - w : ax;
    const ny = o.fromCenter || !movesY ? ay - h / 2 : fy === 0 ? ay - h : ay;
    out = fitRatio({ x: nx, y: ny, w, h }, full, lr);
  }
  return clampInto(out, full);
}

/** Shrink a rectangle about its centre until it fits `full`, keeping the local ratio `lr`. */
function fitRatio(r: Rect, full: Rect, lr: number): Rect {
  let { w, h } = r;
  if (w > full.w) (w = full.w), (h = w / lr);
  if (h > full.h) (h = full.h), (w = h * lr);
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  return clampInto({ x: cx - w / 2, y: cy - h / 2, w, h }, full);
}

/** The largest rectangle of on-page ratio `ratio` centred in `r` (when picking a preset). */
export function applyRatio(r: Rect, full: Rect, ratio: number, sx = 1, sy = 1): Rect {
  const lr = (ratio * Math.abs(sy || 1)) / Math.abs(sx || 1);
  let w = r.w, h = r.h;
  if (w / h > lr) w = h * lr;
  else h = w / lr;
  return fitRatio({ x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }, full, lr);
}

/** Stored form: undefined when the crop shows everything (so the file stays as if never cropped). */
export function normalizeCrop(r: Rect | null | undefined, full: Rect): CropRect | undefined {
  if (!r) return undefined;
  const c = intersect(r, full);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  if (Math.abs(c.x - full.x) < 1e-6 && Math.abs(c.y - full.y) < 1e-6 && Math.abs(c.w - full.w) < 1e-6 && Math.abs(c.h - full.h) < 1e-6) return undefined;
  return { x: round(c.x), y: round(c.y), w: round(c.w), h: round(c.h) };
}

export const CROP_RATIOS: { id: string; label: string; ratio: number | null }[] = [
  { id: "free", label: "자유", ratio: null }, // i18n: ui
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];
