// A brush stroke as coverage (0..1 per layer pixel) for the tools that do not lay down colour: layer-mask painting,
// clone stamp, healing brushes. Dabs are round with the brush's hardness; within one stroke they do not build up past
// the flow (Photoshop: opacity caps the stroke, flow is what each dab adds). Coordinates are the layer's own pixels
// over `box` (tile-aligned, so the touched tiles can be rebuilt one by one).

import { invertTransform } from "../../core/geom";
import { TILE } from "../../core/tile";
import type { Transform } from "../../core/types";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** `b` grown out to whole tiles. */
export function tileAligned(b: Box): Box {
  const x0 = Math.floor(b.x / TILE) * TILE, y0 = Math.floor(b.y / TILE) * TILE;
  const x1 = Math.ceil((b.x + b.w) / TILE) * TILE, y1 = Math.ceil((b.y + b.h) / TILE) * TILE;
  return { x: x0, y: y0, w: Math.max(TILE, x1 - x0), h: Math.max(TILE, y1 - y0) };
}

export class DabStroke {
  readonly cov: Float32Array;
  /** tiles ("tx_ty", layer-local) the stroke touched since the last `takeDirty` */
  private dirty = new Set<string>();
  /** every tile the stroke touched */
  readonly touched = new Set<string>();
  private last: { x: number; y: number; p: number } | null = null;
  private residual = 0;
  bounds: Box | null = null;

  constructor(
    readonly box: Box,
    readonly tr: Transform,
    /** diameter in layer pixels */
    readonly size: number,
    readonly hardness: number,
    readonly flow = 1,
  ) {
    this.cov = new Float32Array(box.w * box.h);
  }

  private stamp(x: number, y: number, p: number) {
    const r = Math.max(0.5, (this.size / 2) * (0.25 + 0.75 * p));
    const hr = r * Math.min(0.99, Math.max(0, this.hardness));
    const bx = this.box.x, by = this.box.y, w = this.box.w, h = this.box.h;
    const x0 = Math.max(0, Math.floor(x - r - bx)), x1 = Math.min(w - 1, Math.ceil(x + r - bx));
    const y0 = Math.max(0, Math.floor(y - r - by)), y1 = Math.min(h - 1, Math.ceil(y + r - by));
    if (x1 < x0 || y1 < y0) return;
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx + bx + 0.5 - x, yy + by + 0.5 - y);
        if (d >= r) continue;
        const v = (d <= hr ? 1 : 1 - (d - hr) / (r - hr)) * this.flow;
        const i = yy * w + xx;
        const c = this.cov[i];
        this.cov[i] = c + (1 - c) * v;
      }
    for (let ty = Math.floor((y0 + by) / TILE); ty <= Math.floor((y1 + by) / TILE); ty++)
      for (let tx = Math.floor((x0 + bx) / TILE); tx <= Math.floor((x1 + bx) / TILE); tx++) {
        this.dirty.add(`${tx}_${ty}`);
        this.touched.add(`${tx}_${ty}`);
      }
    const b = { x: x0 + bx, y: y0 + by, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (!this.bounds) this.bounds = b;
    else {
      const X0 = Math.min(this.bounds.x, b.x), Y0 = Math.min(this.bounds.y, b.y);
      this.bounds = { x: X0, y: Y0, w: Math.max(this.bounds.x + this.bounds.w, b.x + b.w) - X0, h: Math.max(this.bounds.y + this.bounds.h, b.y + b.h) - Y0 };
    }
  }

  /** A pointer sample in page coordinates; dabs every 10 % of the size in between. */
  add(px: number, py: number, pressure = 1) {
    const [x, y] = invertTransform(this.tr, [px, py]);
    const cur = { x, y, p: pressure };
    if (!this.last) {
      this.stamp(x, y, pressure);
      this.last = cur;
      return;
    }
    const spacing = Math.max(0.75, this.size * 0.1);
    const dx = cur.x - this.last.x, dy = cur.y - this.last.y;
    const dist = Math.hypot(dx, dy);
    let t = spacing - this.residual;
    while (t <= dist) {
      const u = t / dist;
      this.stamp(this.last.x + dx * u, this.last.y + dy * u, this.last.p + (cur.p - this.last.p) * u);
      t += spacing;
    }
    this.residual = dist - (t - spacing);
    this.last = cur;
  }

  takeDirty(): string[] {
    const d = [...this.dirty];
    this.dirty.clear();
    return d;
  }
}
