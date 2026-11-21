// Align and distribute (pure). Works on page-space bounding boxes and returns the move for each
// box, so callers apply it to whatever they hold (node transforms, in one store.commit).

import type { Rect } from "./geom";
import type { Vec2 } from "./types";

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeAxis = "x" | "y";
/** what the boxes are aligned to: the selection's bounds, the page, or one key object */
export type AlignRef = "selection" | "page" | "key";

export const ALIGN_MODES: AlignMode[] = ["left", "hcenter", "right", "top", "vcenter", "bottom"];

export function boundsOf(rects: Rect[]): Rect {
  if (!rects.length) return { x: 0, y: 0, w: 0, h: 0 };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The rectangle to align to. "selection" with a single box falls back to the page (aligning one
 * object to itself would do nothing); "key" without a valid key index falls back to the selection.
 */
export function referenceRect(ref: AlignRef, rects: Rect[], page: { width: number; height: number }, keyIndex = -1): Rect {
  if (ref === "page" || (ref === "selection" && rects.length < 2)) return { x: 0, y: 0, w: page.width, h: page.height };
  if (ref === "key" && keyIndex >= 0 && keyIndex < rects.length) return rects[keyIndex];
  if (ref === "key" && rects.length < 2) return { x: 0, y: 0, w: page.width, h: page.height };
  return boundsOf(rects);
}

/** Move of each box so its edge / centre lines up with the reference. */
export function alignDeltas(rects: Rect[], mode: AlignMode, ref: Rect): Vec2[] {
  return rects.map((r) => {
    switch (mode) {
      case "left":
        return [ref.x - r.x, 0];
      case "hcenter":
        return [ref.x + ref.w / 2 - (r.x + r.w / 2), 0];
      case "right":
        return [ref.x + ref.w - (r.x + r.w), 0];
      case "top":
        return [0, ref.y - r.y];
      case "vcenter":
        return [0, ref.y + ref.h / 2 - (r.y + r.h / 2)];
      case "bottom":
        return [0, ref.y + ref.h - (r.y + r.h)];
    }
  });
}

/**
 * Equal gaps between boxes along an axis. The outermost boxes stay put (or, with `within`, are
 * moved to its edges — "distribute across the page"); the rest are spaced so every gap is equal,
 * keeping their order by position. Fewer than 3 boxes (2 with `within`) do not move.
 * Overlapping boxes get a negative gap — still equal.
 */
export function distributeDeltas(rects: Rect[], axis: DistributeAxis, within?: Rect | null): Vec2[] {
  const out: Vec2[] = rects.map(() => [0, 0]);
  const min = within ? 2 : 3;
  if (rects.length < min) return out;
  const X = axis === "x";
  const pos = (r: Rect) => (X ? r.x : r.y);
  const len = (r: Rect) => (X ? r.w : r.h);
  const order = rects.map((_, i) => i).sort((a, b) => pos(rects[a]) - pos(rects[b]) || pos(rects[a]) + len(rects[a]) - (pos(rects[b]) + len(rects[b])) || a - b);
  const total = order.reduce((a, i) => a + len(rects[i]), 0);
  const first = rects[order[0]], last = rects[order[order.length - 1]];
  const start = within ? (X ? within.x : within.y) : pos(first);
  const end = within ? (X ? within.x + within.w : within.y + within.h) : pos(last) + len(last);
  const gap = (end - start - total) / (order.length - 1);
  let cur = start;
  for (const i of order) {
    const d = cur - pos(rects[i]);
    out[i] = X ? [d, 0] : [0, d];
    cur += len(rects[i]) + gap;
  }
  return out;
}

/** Gap that distribute would produce (for display), or null when it would not run. */
export function distributeGap(rects: Rect[], axis: DistributeAxis, within?: Rect | null): number | null {
  if (rects.length < (within ? 2 : 3)) return null;
  const X = axis === "x";
  const total = rects.reduce((a, r) => a + (X ? r.w : r.h), 0);
  const b = within ?? boundsOf(rects);
  return ((X ? b.w : b.h) - total) / (rects.length - 1);
}
