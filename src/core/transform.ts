// Free transform (pure): the selection box with 8 handles, the rotate zone outside its corners,
// resize / rotate / flip maths, and the pointer-target priority that keeps "click a pixel →
// that layer is selected and moves" first. No DOM, no store — the canvas calls these.
//
// Rules (documented in docs/LOOM.md "자유 변형"):
//  • corners resize both directions, edge handles one direction; Alt = from the centre.
//  • Images, raster layers (PSD) and PDF pages keep their proportions on corners by default and
//    Shift frees them (Photoshop 2026); other objects are free and Shift keeps proportions.
//  • Text boxes: every handle changes the box width (text re-flows, height follows the text);
//    Ctrl + corner scales the whole text (glyphs included) proportionally.
//  • Dragging outside a corner rotates (Shift = 15° steps); inside the box moves.

import { applyTransform, invertTransform, scaleYOf, type Rect } from "./geom";
import type { SceneNode, Transform, Vec2 } from "./types";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const CORNERS: Handle[] = ["nw", "ne", "se", "sw"];
export const EDGES: Handle[] = ["n", "e", "s", "w"];
/** handle position as a fraction of the local box */
export const HANDLE_POS: Record<Handle, Vec2> = { nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5] };

/** A box in some local space (`lb`) placed on the page by `t`. */
export interface Box {
  t: Transform;
  lb: Rect;
}

export function handlePoint(box: Box, h: Handle): Vec2 {
  const [fx, fy] = HANDLE_POS[h];
  return applyTransform(box.t, [box.lb.x + fx * box.lb.w, box.lb.y + fy * box.lb.h]);
}

export function boxCorners(box: Box): Vec2[] {
  return CORNERS.map((h) => handlePoint(box, h));
}

export function boxCenter(box: Box): Vec2 {
  return applyTransform(box.t, [box.lb.x + box.lb.w / 2, box.lb.y + box.lb.h / 2]);
}

export function insideBox(box: Box, p: Vec2): boolean {
  const q = invertTransform(box.t, p);
  return q[0] >= box.lb.x && q[0] <= box.lb.x + box.lb.w && q[1] >= box.lb.y && q[1] <= box.lb.y + box.lb.h;
}

/** On-page size of the box (local size × |scale|). */
export function boxSize(box: Box): { w: number; h: number } {
  return { w: Math.abs(box.lb.w * box.t.scale), h: Math.abs(box.lb.h * scaleYOf(box.t)) };
}

export type HandlePick = { kind: "handle"; handle: Handle } | { kind: "rotate"; corner: Handle } | null;

/**
 * What the pointer is over: a handle (within `tol` page px), the rotate zone (outside the box,
 * within `rotateReach` of a corner) or nothing. Edge handles are skipped when `edges` is false or
 * the box is too small on screen to tell them apart from the corners.
 */
export function pickHandle(box: Box, p: Vec2, tol: number, opts: { edges?: boolean; rotate?: boolean; rotateReach?: number } = {}): HandlePick {
  const size = boxSize(box);
  const order: Handle[] = opts.edges !== false && Math.min(size.w, size.h) > tol * 4 ? [...CORNERS, ...EDGES] : CORNERS;
  let best: Handle | null = null;
  let bd = tol;
  for (const h of order) {
    const q = handlePoint(box, h);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d <= bd) (bd = d), (best = h);
  }
  if (best) return { kind: "handle", handle: best };
  if (opts.rotate !== false && !insideBox(box, p)) {
    const reach = opts.rotateReach ?? tol * 4;
    for (const h of CORNERS) {
      const q = handlePoint(box, h);
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= reach) return { kind: "rotate", corner: h };
    }
  }
  return null;
}

export type PointerTarget = "handle" | "rotate" | "object" | "move-selection" | "marquee";

/**
 * Priority of a press with the select tool. Handles win only on the handle itself; the rotate zone
 * only when no other object's pixel is under the pointer; otherwise the existing pixel hit test
 * decides (click a layer's pixel → it is selected and moves). A press on an empty spot inside the
 * selection box moves the selection; anywhere else starts a marquee.
 */
export function pointerTarget(pick: HandlePick, pixelHit: string | null, selection: string[], insideSelection: boolean): PointerTarget {
  if (pick?.kind === "handle") return "handle";
  if (pick?.kind === "rotate" && (!pixelHit || selection.includes(pixelHit))) return "rotate";
  if (pixelHit) return "object";
  if (insideSelection) return "move-selection";
  return "marquee";
}

export interface ResizeOpts {
  keepRatio?: boolean;
  fromCenter?: boolean;
}

export interface ResizeFactors {
  kx: number;
  ky: number;
  /** fixed point, in the box's local space */
  anchor: Vec2;
}

const MIN_K = 1e-3;
const nz = (k: number) => (Math.abs(k) < MIN_K ? (k < 0 ? -MIN_K : MIN_K) : k);

/** Scale factors (negative = flipped through the anchor) for dragging `handle` to page point `p`. */
export function resizeFactors(box: Box, handle: Handle, p: Vec2, opts: ResizeOpts = {}): ResizeFactors {
  const { lb } = box;
  const q = invertTransform(box.t, p);
  const [fx, fy] = HANDLE_POS[handle];
  const cx = lb.x + lb.w / 2, cy = lb.y + lb.h / 2;
  const movesX = fx !== 0.5, movesY = fy !== 0.5;
  const ax = !movesX || opts.fromCenter ? cx : fx === 0 ? lb.x + lb.w : lb.x;
  const ay = !movesY || opts.fromCenter ? cy : fy === 0 ? lb.y + lb.h : lb.y;
  const hx = lb.x + fx * lb.w, hy = lb.y + fy * lb.h;
  let kx = movesX && Math.abs(hx - ax) > 1e-9 ? (q[0] - ax) / (hx - ax) : 1;
  let ky = movesY && Math.abs(hy - ay) > 1e-9 ? (q[1] - ay) / (hy - ay) : 1;
  if (opts.keepRatio && movesX && movesY) {
    const k = Math.max(Math.abs(kx), Math.abs(ky));
    kx = Math.sign(kx || 1) * k;
    ky = Math.sign(ky || 1) * k;
  }
  return { kx: nz(kx), ky: nz(ky), anchor: [ax, ay] };
}

/** Transform scaled by (kx, ky) in its own axes about a local anchor (the anchor stays put on the page). */
export function scaledTransform(t: Transform, kx: number, ky: number, anchor: Vec2): Transform {
  const sx = t.scale * kx, sy = scaleYOf(t) * ky;
  const out: Transform = { x: 0, y: 0, rotation: t.rotation, scale: sx };
  if (Math.abs(sy - sx) > 1e-12) out.scaleY = sy;
  const fixed = applyTransform(t, anchor);
  const now = applyTransform(out, anchor);
  out.x = fixed[0] - now[0];
  out.y = fixed[1] - now[1];
  return out;
}

/**
 * For objects whose size lives in their own fields (image width / height, text width): the local
 * content is stretched by (kx, ky) and the transform moved so the anchor stays put.
 */
export function sizedTransform(t: Transform, kx: number, ky: number, anchor: Vec2): Transform {
  const fixed = applyTransform(t, anchor);
  const moved = applyTransform(t, [anchor[0] * kx, anchor[1] * ky]);
  return { ...t, x: t.x + fixed[0] - moved[0], y: t.y + fixed[1] - moved[1] };
}

/** Turn a transform by `deg` about a page point. */
export function rotatedAbout(t: Transform, center: Vec2, deg: number): Transform {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const dx = t.x - center[0], dy = t.y - center[1];
  let r = (((t.rotation + deg) % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return { ...t, x: center[0] + dx * c - dy * s, y: center[1] + dx * s + dy * c, rotation: Math.abs(r) < 1e-9 ? 0 : r };
}

/** Kinds that keep proportions on corner handles unless Shift is held. */
export function ratioByDefault(n: Pick<SceneNode, "type">): boolean {
  return n.type === "IMAGE" || n.type === "RASTER" || n.type === "PDF" || n.type === "MEDIA";
}

/** Does this press keep proportions? (`shift` toggles the kind's default) */
export function keepRatio(nodes: Pick<SceneNode, "type">[], shift: boolean): boolean {
  const byDefault = nodes.length > 1 || nodes.every(ratioByDefault);
  return byDefault !== shift;
}

/**
 * Apply a resize to one node (mutates; works on immer drafts).
 * Images and media change width / height; text changes its width (or, with `textScale`, scales
 * uniformly); everything else changes transform.scale / scaleY (raster layers resample on PSD save).
 */
export function resizeNode(n: SceneNode, f: ResizeFactors, opts: { textScale?: boolean } = {}) {
  const { kx, ky, anchor } = f;
  if (n.type === "TEXT") {
    if (opts.textScale) {
      const k = Math.max(Math.abs(kx), Math.abs(ky));
      n.transform = scaledTransform(n.transform, k, k, anchor);
      return;
    }
    const k = Math.max(20 / Math.max(1, n.width), Math.abs(kx));
    n.transform = sizedTransform(n.transform, k, 1, anchor);
    n.width = n.width * k;
    return;
  }
  if ((n.type === "IMAGE" || n.type === "MEDIA") && kx > 0 && ky > 0) {
    n.transform = sizedTransform(n.transform, kx, ky, anchor);
    n.width *= kx;
    n.height *= ky;
    // a crop lives in the image's own coordinates: it stretches with it
    if (n.type === "IMAGE" && n.crop) n.crop = { x: n.crop.x * kx, y: n.crop.y * ky, w: n.crop.w * kx, h: n.crop.h * ky };
    return;
  }
  n.transform = scaledTransform(n.transform, kx, ky, anchor);
}

/** Several objects: uniform scale `k` about a page point (positions and sizes). */
export function scaleNodeAbout(n: SceneNode, k: number, anchor: Vec2) {
  const t = n.transform;
  t.x = anchor[0] + (t.x - anchor[0]) * k;
  t.y = anchor[1] + (t.y - anchor[1]) * k;
  t.scale *= k;
  if (t.scaleY !== undefined) t.scaleY *= k;
}

/** Mirror a node about its own centre along its OWN axes (kept for an "object axis" flip option). */
export function flipNode(n: SceneNode, lb: Rect, axis: "h" | "v") {
  const c: Vec2 = [lb.x + lb.w / 2, lb.y + lb.h / 2];
  n.transform = scaledTransform(n.transform, axis === "h" ? -1 : 1, axis === "v" ? -1 : 1, c);
}

/**
 * Mirror a node like a real mirror on the screen (Photoshop behaviour, the default — decided
 * 2026-11-11): horizontal = across the vertical screen line through the object's centre.
 * Mirroring a rotation R(θ) gives R(−θ)·mirror, so the angle changes sign and one local scale
 * axis is negated; the object's centre on the page stays where it was.
 */
export function flipNodeScreen(n: SceneNode, lb: Rect, axis: "h" | "v"): Transform {
  const t = n.transform;
  const lc: Vec2 = [lb.x + lb.w / 2, lb.y + lb.h / 2];
  const centre = applyTransform(t, lc);
  const sy = scaleYOf(t);
  const next: Transform = { ...t, rotation: t.rotation === 0 ? 0 : -t.rotation };
  if (axis === "h") {
    next.scale = -t.scale;
    next.scaleY = sy;
  } else {
    next.scale = t.scale;
    next.scaleY = -sy;
  }
  if (next.scaleY === next.scale) delete next.scaleY;
  const moved = applyTransform({ ...next, x: 0, y: 0 }, lc);
  next.x = centre[0] - moved[0];
  next.y = centre[1] - moved[1];
  return next;
}

/** Cursor for a handle on a box turned by `rotation` degrees (and maybe mirrored). */
export function handleCursor(h: Handle, rotation: number): string {
  const base: Record<Handle, number> = { e: 0, se: 45, s: 90, sw: 135, w: 180, nw: 225, n: 270, ne: 315 };
  const a = (((base[h] + rotation) % 180) + 180) % 180;
  const i = Math.round(a / 45) % 4;
  return ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"][i];
}
