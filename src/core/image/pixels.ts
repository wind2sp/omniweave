// Pixel buffers for the image engine (filters, adjustments, trace).
// RGBA, 8 bits per channel, straight (non-premultiplied) alpha — the same layout as ImageData and Loom tiles.
// Everything here is pure (no DOM), so it runs in tests, in the main thread and in the image worker.

import { isBlank, makeTile } from "../tile";
import { TILE } from "../tile";
import type { PixelTile } from "../types";

export interface Img {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function newImg(width: number, height: number): Img {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function cloneImg(img: Img): Img {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

/** Solid colour image (tests and previews). */
export function solidImg(width: number, height: number, r: number, g: number, b: number, a = 255): Img {
  const img = newImg(width, height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
    d[i + 3] = a;
  }
  return img;
}

/** Rec. 601 luma (0..255) — used by threshold, emboss, edge detection and trace. */
export function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Copy a rectangle out of an image (clipped to the image). */
export function cropImg(img: Img, x: number, y: number, w: number, h: number): Img {
  x = Math.max(0, Math.min(img.width, Math.floor(x)));
  y = Math.max(0, Math.min(img.height, Math.floor(y)));
  w = Math.max(1, Math.min(img.width - x, Math.floor(w)));
  h = Math.max(1, Math.min(img.height - y, Math.floor(h)));
  const out = newImg(w, h);
  for (let r = 0; r < h; r++) out.data.set(img.data.subarray(((y + r) * img.width + x) * 4, ((y + r) * img.width + x + w) * 4), r * w * 4);
  return out;
}

/**
 * Area-average downscale so the longer side is at most `maxSide` (preview thumbnails).
 * Averages premultiplied colour so transparent pixels do not darken edges. Returns the input when already small.
 */
export function downscale(img: Img, maxSide: number): { img: Img; scale: number } {
  const k = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (k >= 1) return { img, scale: 1 };
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const out = newImg(w, h);
  const sx = img.width / w, sy = img.height / h;
  const s = img.data, d = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++)
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * img.width + xx) * 4;
          const al = s[i + 3];
          r += s[i] * al;
          g += s[i + 1] * al;
          b += s[i + 2] * al;
          a += al;
          n++;
        }
      const o = (y * w + x) * 4;
      if (a > 0) {
        d[o] = r / a;
        d[o + 1] = g / a;
        d[o + 2] = b / a;
      }
      d[o + 3] = a / n;
    }
  }
  return { img: out, scale: w / img.width };
}

// ───────── Loom tiles ↔ image ─────────

export interface TileBounds {
  /** node-local pixel origin of the image (always a multiple of TILE) */
  ox: number;
  oy: number;
  width: number;
  height: number;
}

/** Tile-aligned bounds of a sparse tile map, optionally grown by `margin` pixels (rounded out to whole tiles). */
export function tileBounds(tiles: Record<string, PixelTile>, margin = 0): TileBounds | null {
  const keys = Object.keys(tiles);
  if (!keys.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of keys) {
    const i = k.indexOf("_");
    const tx = +k.slice(0, i), ty = +k.slice(i + 1);
    if (tx < x0) x0 = tx;
    if (ty < y0) y0 = ty;
    if (tx > x1) x1 = tx;
    if (ty > y1) y1 = ty;
  }
  const grow = margin > 0 ? Math.ceil(margin / TILE) : 0;
  x0 -= grow; y0 -= grow; x1 += grow; y1 += grow;
  return { ox: x0 * TILE, oy: y0 * TILE, width: (x1 - x0 + 1) * TILE, height: (y1 - y0 + 1) * TILE };
}

/** Composite a raster node's tiles into one image covering `b` (missing tiles are transparent). */
export function tilesToImg(tiles: Record<string, PixelTile>, b: TileBounds): Img {
  const img = newImg(b.width, b.height);
  for (const [k, t] of Object.entries(tiles)) {
    const i = k.indexOf("_");
    const px = +k.slice(0, i) * TILE - b.ox, py = +k.slice(i + 1) * TILE - b.oy;
    if (px < 0 || py < 0 || px + TILE > b.width || py + TILE > b.height) continue;
    for (let r = 0; r < TILE; r++) img.data.set(t.data.subarray(r * TILE * 4, (r + 1) * TILE * 4), ((py + r) * b.width + px) * 4);
  }
  return img;
}

/**
 * Split an image back into Loom tiles and merge them over `old`.
 * Loom rule: a tile whose bytes did not change keeps its old object (and hash); only changed tiles become new
 * threads, blank tiles are dropped. Tiles of `old` outside the image are kept untouched.
 * Returns the next tile map and the number of tiles that changed (0 → nothing to commit).
 */
export function imgToTiles(img: Img, ox: number, oy: number, old: Record<string, PixelTile>): { tiles: Record<string, PixelTile>; changed: number } {
  const tiles: Record<string, PixelTile> = { ...old };
  let changed = 0;
  const tx0 = Math.floor(ox / TILE), ty0 = Math.floor(oy / TILE);
  const ntx = Math.ceil(img.width / TILE), nty = Math.ceil(img.height / TILE);
  for (let ty = 0; ty < nty; ty++)
    for (let tx = 0; tx < ntx; tx++) {
      const key = `${tx0 + tx}_${ty0 + ty}`;
      const data = new Uint8ClampedArray(TILE * TILE * 4);
      const w = Math.min(TILE, img.width - tx * TILE), h = Math.min(TILE, img.height - ty * TILE);
      for (let r = 0; r < h; r++) {
        const src = ((ty * TILE + r) * img.width + tx * TILE) * 4;
        data.set(img.data.subarray(src, src + w * 4), r * TILE * 4);
      }
      const prev = old[key];
      if (isBlank(data)) {
        if (prev) {
          delete tiles[key];
          changed++;
        }
        continue;
      }
      if (prev && sameBytes(prev.data, data)) continue;
      tiles[key] = makeTile(data);
      changed++;
    }
  return { tiles, changed };
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false;
  const ua = new Uint32Array(a.buffer, a.byteOffset, a.byteLength >>> 2);
  const ub = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >>> 2);
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
  return true;
}

// ───────── histogram ─────────

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  /** pixels counted (alpha > 0) */
  count: number;
}

/** 256-bin histograms of R, G, B and luma, counting only pixels with alpha > 0. */
export function histogram(img: Img): Histogram {
  const r = new Uint32Array(256), g = new Uint32Array(256), b = new Uint32Array(256), l = new Uint32Array(256);
  const d = img.data;
  let count = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    r[d[i]]++;
    g[d[i + 1]]++;
    b[d[i + 2]]++;
    l[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
    count++;
  }
  return { r, g, b, l, count };
}

/** Lowest / highest bins after clipping `clip` (0..0.5 fraction) of the counted pixels at each end. */
export function histRange(h: Uint32Array, count: number, clip: number): [number, number] {
  const cut = Math.floor(count * Math.max(0, Math.min(0.49, clip)));
  let lo = 0, hi = 255, acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += h[i];
    if (acc > cut) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += h[i];
    if (acc > cut) {
      hi = i;
      break;
    }
  }
  return [lo, hi];
}
