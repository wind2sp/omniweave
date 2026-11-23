// Raster brush engine.
// While drawing, dabs accumulate into a stroke mask (so overlapping dabs inside one stroke
// do not build up opacity). On release the mask is composited into only the touched
// 256px tiles, creating new tile threads; untouched tiles keep their identity.

import { invertTransform, type Rect } from "../core/geom";
import type { Transform } from "../core/types";
import { isBlank, makeTile } from "../core/loom";
import type { BrushSettings } from "../core/store";
import { TILE, type PixelTile, type RasterNode } from "../core/types";
import { ctx2d, makeCanvas, tileCanvas, type Ctx } from "./draw";

export interface StrokePoint {
  x: number; // page coords
  y: number;
  p: number; // pressure 0..1
}

const dabCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
function dab(radius: number, hardness: number, color: string): OffscreenCanvas | HTMLCanvasElement {
  const r = Math.max(0.5, Math.round(radius * 2) / 2);
  const key = `${r}:${hardness.toFixed(2)}:${color}`;
  let c = dabCache.get(key);
  if (!c) {
    const size = Math.ceil(r * 2) + 2;
    c = makeCanvas(size, size);
    const g = ctx2d(c);
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, r);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(Math.min(0.999, Math.max(0, hardness)), "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    g.globalCompositeOperation = "source-in";
    g.fillStyle = color;
    g.fillRect(0, 0, size, size);
    if (dabCache.size > 200) dabCache.clear();
    dabCache.set(key, c);
  }
  return c;
}

/** Node-local size the stroke mask needs to cover the page (0, 0, pageW, pageH): at least the page size. */
export function maskSize(tr: Transform, pageW: number, pageH: number): { w: number; h: number } {
  let mx = pageW, my = pageH;
  for (const p of [[0, 0], [pageW, 0], [0, pageH], [pageW, pageH]] as [number, number][]) {
    const [x, y] = invertTransform(tr, p);
    if (Number.isFinite(x)) mx = Math.max(mx, x);
    if (Number.isFinite(y)) my = Math.max(my, y);
  }
  return { w: Math.min(16384, Math.ceil(mx)), h: Math.min(16384, Math.ceil(my)) };
}

/**
 * How far (node-local px, whole tiles) the page reaches left of / above the layer's own origin: a PSD layer starts at
 * its content's corner, so painting left of or above that corner lands at negative local coordinates — it was cut
 * off and the stroke changed nothing (a stroke across a page whose top layer is a small shape).
 */
export function maskOrigin(tr: Transform, pageW: number, pageH: number): { ox: number; oy: number } {
  let nx = 0, ny = 0;
  for (const p of [[0, 0], [pageW, 0], [0, pageH], [pageW, pageH]] as [number, number][]) {
    const [x, y] = invertTransform(tr, p);
    if (Number.isFinite(x)) nx = Math.min(nx, x);
    if (Number.isFinite(y)) ny = Math.min(ny, y);
  }
  return { ox: Math.ceil(-nx / TILE) * TILE, oy: Math.ceil(-ny / TILE) * TILE };
}

export class Stroke {
  /** the stroke's dabs in node-local space from (0, 0) (what a live preview drawn at the layer's origin shows) */
  readonly mask: OffscreenCanvas | HTMLCanvasElement;
  /**
   * The whole stroke, also left of / above the layer's origin: its (0, 0) is node-local (-ox, -oy). The same canvas
   * as `mask` when the page does not reach there.
   */
  readonly full: OffscreenCanvas | HTMLCanvasElement;
  readonly ox: number;
  readonly oy: number;
  private mctx: Ctx;
  private fctx: Ctx;
  bounds: Rect | null = null;
  private last: StrokePoint | null = null;
  private residual = 0;

  constructor(
    readonly node: RasterNode,
    readonly pageW: number,
    readonly pageH: number,
    readonly brush: BrushSettings,
    readonly erase: boolean,
  ) {
    // the mask (coloured dabs, max alpha 1) lives in node-local space covering the page area: a layer with more pixels
    // than its place on the page (a rasterized photo scaled down) needs a larger mask, or strokes on its right / lower
    // part were cut off; at most 16384 px a side
    const s = maskSize(node.transform, pageW, pageH);
    this.mask = makeCanvas(s.w, s.h);
    this.mctx = ctx2d(this.mask);
    const o = maskOrigin(node.transform, pageW, pageH);
    // at most 16384 px a side in all: the part right of / below the origin comes first
    this.ox = Math.max(0, Math.min(o.ox, Math.floor((16384 - s.w) / TILE) * TILE));
    this.oy = Math.max(0, Math.min(o.oy, Math.floor((16384 - s.h) / TILE) * TILE));
    this.full = this.ox || this.oy ? makeCanvas(s.w + this.ox, s.h + this.oy) : this.mask;
    this.fctx = this.full === this.mask ? this.mctx : ctx2d(this.full);
  }

  private stamp(x: number, y: number, p: number) {
    const r = Math.max(0.5, (this.brush.size / 2) * (0.25 + 0.75 * p));
    const d = dab(r, this.brush.hardness, this.erase ? "#000000" : this.brush.color);
    const s = d.width;
    this.mctx.drawImage(d, x - s / 2, y - s / 2);
    if (this.full !== this.mask) this.fctx.drawImage(d, x - s / 2 + this.ox, y - s / 2 + this.oy);
    const b = { x: x - s / 2, y: y - s / 2, w: s, h: s };
    if (!this.bounds) this.bounds = b;
    else {
      const x0 = Math.min(this.bounds.x, b.x), y0 = Math.min(this.bounds.y, b.y);
      const x1 = Math.max(this.bounds.x + this.bounds.w, b.x + b.w), y1 = Math.max(this.bounds.y + this.bounds.h, b.y + b.h);
      this.bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
  }

  /** Add a pointer sample (page coordinates). Interpolates dabs at 15% of the brush size. */
  add(pt: StrokePoint) {
    const [lx, ly] = invertTransform(this.node.transform, [pt.x, pt.y]);
    const cur = { x: lx, y: ly, p: pt.p };
    if (!this.last) {
      this.stamp(cur.x, cur.y, cur.p);
      this.last = cur;
      return;
    }
    const spacing = Math.max(0.75, this.brush.size * 0.12);
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

  /** Composite the stroke into new tiles. Returns the next tile map, or null if nothing changed. */
  commit(): Record<string, PixelTile> | null {
    if (!this.bounds) return null;
    const b = this.bounds;
    const colored = this.full; // dabs are already in brush colour

    const tiles = { ...this.node.tiles };
    const tx0 = Math.floor(b.x / TILE), ty0 = Math.floor(b.y / TILE);
    const tx1 = Math.floor((b.x + b.w) / TILE), ty1 = Math.floor((b.y + b.h) / TILE);
    const work = makeCanvas(TILE, TILE);
    const wc = ctx2d(work) as Ctx & { getImageData: CanvasRenderingContext2D["getImageData"] };
    let changed = false;
    for (let ty = ty0; ty <= ty1; ty++)
      for (let tx = tx0; tx <= tx1; tx++) {
        const key = `${tx}_${ty}`;
        const old = tiles[key];
        if (!old && this.erase) continue;
        wc.globalCompositeOperation = "copy";
        wc.globalAlpha = 1;
        if (old) wc.drawImage(tileCanvas(old), 0, 0);
        else wc.clearRect(0, 0, TILE, TILE);
        wc.globalCompositeOperation = this.erase ? "destination-out" : "source-over";
        wc.globalAlpha = this.brush.opacity;
        wc.drawImage(colored, tx * TILE + this.ox, ty * TILE + this.oy, TILE, TILE, 0, 0, TILE, TILE);
        const data = wc.getImageData(0, 0, TILE, TILE).data;
        if (isBlank(data)) {
          if (old) {
            delete tiles[key];
            changed = true;
          }
          continue;
        }
        const t = makeTile(data);
        if (!old || old.hash !== t.hash) {
          tiles[key] = t;
          changed = true;
        }
      }
    return changed ? tiles : null;
  }
}

/** Rasterize an arbitrary canvas region into a tile map (used to merge/flatten layers). */
export function canvasToTiles(src: OffscreenCanvas | HTMLCanvasElement): Record<string, PixelTile> {
  const tiles: Record<string, PixelTile> = {};
  const work = makeCanvas(TILE, TILE);
  const wc = ctx2d(work);
  for (let ty = 0; ty * TILE < src.height; ty++)
    for (let tx = 0; tx * TILE < src.width; tx++) {
      wc.clearRect(0, 0, TILE, TILE);
      wc.drawImage(src, tx * TILE, ty * TILE, TILE, TILE, 0, 0, TILE, TILE);
      const data = (wc as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE).data;
      if (!isBlank(data)) tiles[`${tx}_${ty}`] = makeTile(data);
    }
  return tiles;
}
