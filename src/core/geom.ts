import type { Transform, Vec2 } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const emptyRect = (): Rect => ({ x: Infinity, y: Infinity, w: -Infinity, h: -Infinity });

export function rectFromPoints(pts: Vec2[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function inflate(r: Rect, d: number): Rect {
  return { x: r.x - d, y: r.y - d, w: r.w + 2 * d, h: r.h + 2 * d };
}

export function containsPoint(r: Rect, x: number, y: number): boolean {
  return x >= r.x && y >= r.y && x <= r.x + r.w && y <= r.y + r.h;
}

/** Local -> page coordinates. Rotation and scale are about the local origin. */
/** Vertical scale of a transform (`scaleY` when set, else the uniform `scale`). */
export const scaleYOf = (t: Transform) => t.scaleY ?? t.scale;

/** True when the transform is a pure translation. */
export const isTranslation = (t: Transform) => t.rotation === 0 && t.scale === 1 && scaleYOf(t) === 1;

/** Local -> page: scale (x by `scale`, y by `scaleY`), rotate, translate. */
export function applyTransform(t: Transform, p: Vec2): Vec2 {
  const a = (t.rotation * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const x = p[0] * t.scale, y = p[1] * scaleYOf(t);
  return [x * cos - y * sin + t.x, x * sin + y * cos + t.y];
}

/** Page -> local coordinates. */
export function invertTransform(t: Transform, p: Vec2): Vec2 {
  const a = (-t.rotation * Math.PI) / 180;
  const dx = p[0] - t.x, dy = p[1] - t.y;
  const cos = Math.cos(a), sin = Math.sin(a);
  return [(dx * cos - dy * sin) / (t.scale || 1), (dx * sin + dy * cos) / (scaleYOf(t) || 1)];
}

export function transformRect(t: Transform, r: Rect): Rect {
  if (isTranslation(t)) return { x: r.x + t.x, y: r.y + t.y, w: r.w, h: r.h };
  return rectFromPoints([
    applyTransform(t, [r.x, r.y]),
    applyTransform(t, [r.x + r.w, r.y]),
    applyTransform(t, [r.x, r.y + r.h]),
    applyTransform(t, [r.x + r.w, r.y + r.h]),
  ]);
}

export function inverseTransformRect(t: Transform, r: Rect): Rect {
  return rectFromPoints([
    invertTransform(t, [r.x, r.y]),
    invertTransform(t, [r.x + r.w, r.y]),
    invertTransform(t, [r.x, r.y + r.h]),
    invertTransform(t, [r.x + r.w, r.y + r.h]),
  ]);
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
