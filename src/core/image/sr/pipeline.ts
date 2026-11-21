// AI super-resolution of a picture: the network enlarges 4× tile by tile, then the result is brought to the asked
// size (2×, 3×, custom: area-average down from 4×; above 4×: the classical upscale for the rest).
//
//  - tiles overlap by OVERLAP source px; each new tile is laid over the ones before it with a linear ramp across the
//    overlap (left and top bands), so there is no seam and no buffer beyond the result;
//  - transparency: the network sees straight colour with the colour of fully transparent pixels filled in from their
//    neighbours (no black fringe to learn from); the alpha is enlarged separately with the classical high-quality
//    method (premultiplied, upscale.ts) and put back — no halo either way;
//  - JPEG damage: an optional deblocking pass on the source first (smooths small steps across the 8 × 8 grid only).

import type { Tensor } from "../infer/graph";
import { gaussPremul } from "../filters";
import type { Img } from "../pixels";
import { upscale } from "../upscale";

export type NetRun = (x: Tensor) => Promise<Tensor>;

export interface SrOptions {
  width: number;
  height: number;
  /** deblock the source first (heavy JPEG artefacts) */
  deblock?: boolean;
  /** false: flatten onto white (default true) */
  keepAlpha?: boolean;
  /** source tile size (px; 4× that is the output tile) */
  tile?: number;
}

/** The 4× intermediate may hold at most this many pixels (RGBA, 8 bits: 480 MB). */
export const SR_MAX_4X_PIXELS = 120_000_000;
const OVERLAP = 12;
const SCALE = 4;

/** Colour of fully transparent pixels filled in from the nearest visible ones (blurred premultiplied / alpha). */
function bleed(img: Img): Uint8ClampedArray {
  const { width: w, height: h, data: d } = img;
  const out = new Uint8ClampedArray(d);
  let holes = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] === 0) holes++;
  if (!holes) return out;
  if (holes === w * h) return out.fill(0);
  const f = new Float32Array(d.length);
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255;
    f[i] = d[i] * a; f[i + 1] = d[i + 1] * a; f[i + 2] = d[i + 2] * a; f[i + 3] = a;
  }
  let left = holes;
  for (const sigma of [2, 6, 18, 54, 162]) {
    if (!left) break;
    const g = gaussPremul(new Float32Array(f), w, h, sigma);
    left = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] !== 0 || out[i + 3] === 1) continue;
      const a = g[i + 3];
      if (a > 1e-4) {
        out[i] = g[i] / a; out[i + 1] = g[i + 1] / a; out[i + 2] = g[i + 2] / a;
        out[i + 3] = 1; // marks "filled" (alpha comes from the classical pass)
      } else left++;
    }
  }
  return out;
}

/**
 * Light deblocking: across every 8 × 8 grid line, a step smaller than `t` (a JPEG block edge, not a real edge) is
 * spread over the four pixels around it.
 */
export function deblock(img: Img, t = 14): Img {
  const { width: w, height: h } = img;
  const d = new Uint8ClampedArray(img.data);
  const fix = (p0: number, p1: number, p2: number, p3: number) => {
    for (let c = 0; c < 3; c++) {
      const a = d[p0 + c], b = d[p1 + c], e = d[p2 + c], f = d[p3 + c];
      const step = e - b;
      if (Math.abs(step) >= t || Math.abs(b - a) > t / 2 || Math.abs(f - e) > t / 2) continue;
      d[p0 + c] = a + step / 8; d[p1 + c] = b + (3 * step) / 8;
      d[p2 + c] = e - (3 * step) / 8; d[p3 + c] = f - step / 8;
    }
  };
  for (let y = 0; y < h; y++) for (let x = 8; x + 1 < w; x += 8) fix((y * w + x - 2) * 4, (y * w + x - 1) * 4, (y * w + x) * 4, (y * w + x + 1) * 4);
  for (let y = 8; y + 1 < h; y += 8) for (let x = 0; x < w; x++) fix(((y - 2) * w + x) * 4, ((y - 1) * w + x) * 4, (y * w + x) * 4, ((y + 1) * w + x) * 4);
  return { width: w, height: h, data: d };
}

/**
 * Area-average resize (each output pixel = the mean of the source area it covers), any ratio ≤ 1 per axis. Each
 * source row is shrunk across when first needed and kept while the next output row may still use it, so the memory
 * beyond the result is one row — the source here can be the 120 MP 4× intermediate (a full-height float buffer of
 * the half-done result would be up to ~1 GB).
 */
export function resizeArea(img: Img, W: number, H: number): Img {
  const { width: w, height: h, data: s } = img;
  const sx = w / W, sy = h / H, rowLen = W * 4;
  const x0s = new Int32Array(W), x1s = new Int32Array(W), ks: Float32Array[] = [];
  for (let X = 0; X < W; X++) {
    const a = X * sx, b = a + sx;
    x0s[X] = Math.floor(a);
    x1s[X] = Math.min(w, Math.ceil(b));
    const k = new Float32Array(Math.max(0, x1s[X] - x0s[X]));
    for (let x = x0s[X]; x < x1s[X]; x++) k[x - x0s[X]] = (Math.min(b, x + 1) - Math.max(a, x)) / sx;
    ks.push(k);
  }
  const row = new Float32Array(rowLen);
  let rowY = -1;
  const across = (y: number): Float32Array => {
    if (y === rowY) return row;
    for (let X = 0; X < W; X++) {
      let r = 0, g = 0, bl = 0, al = 0;
      const k = ks[X];
      for (let x = x0s[X], i = 0; x < x1s[X]; x++, i++) {
        const p = (y * w + x) * 4, kk = k[i];
        r += kk * s[p]; g += kk * s[p + 1]; bl += kk * s[p + 2]; al += kk * s[p + 3];
      }
      const o = X * 4;
      row[o] = r; row[o + 1] = g; row[o + 2] = bl; row[o + 3] = al;
    }
    rowY = y;
    return row;
  };
  const out = new Uint8ClampedArray(W * H * 4), acc = new Float32Array(rowLen);
  for (let Y = 0; Y < H; Y++) {
    const a = Y * sy, b = a + sy;
    acc.fill(0);
    for (let y = Math.floor(a); y < Math.min(h, Math.ceil(b)); y++) {
      const k = (Math.min(b, y + 1) - Math.max(a, y)) / sy, r = across(y);
      for (let i = 0; i < rowLen; i++) acc[i] += k * r[i];
    }
    out.set(acc, Y * rowLen);
  }
  return { width: W, height: H, data: out };
}

/**
 * Enlarge `img` with the network `run` (4× per pass). `onProgress(done, total)` per tile. The network gets NCHW RGB
 * in 0..1 and returns 4× that.
 */
export async function superResolve(img: Img, o: SrOptions, run: NetRun, onProgress?: (done: number, total: number) => void): Promise<Img> {
  const w = img.width, h = img.height, W = o.width, H = o.height;
  const keepAlpha = o.keepAlpha !== false;
  let hasAlpha = false;
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) (hasAlpha = true), (i = img.data.length);
  let src: Img = img;
  if (hasAlpha && !keepAlpha) {
    const d = new Uint8ClampedArray(img.data);
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      for (let c = 0; c < 3; c++) d[i + c] = d[i + c] * a + 255 * (1 - a);
      d[i + 3] = 255;
    }
    src = { width: w, height: h, data: d };
    hasAlpha = false;
  }
  const colour: Img = { width: w, height: h, data: hasAlpha ? bleed(src) : src.data };
  const base = o.deblock ? deblock(colour) : colour;
  const W4 = w * SCALE, H4 = h * SCALE;
  const big = new Uint8ClampedArray(W4 * H4 * 4);
  const T = Math.max(16, o.tile ?? 96);
  const tilesX = Math.ceil(w / T), tilesY = Math.ceil(h / T), total = tilesX * tilesY + 1;
  let done = 0;
  for (let ty = 0; ty < tilesY; ty++)
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = tx * T, y0 = ty * T, x1 = Math.min(w, x0 + T), y1 = Math.min(h, y0 + T);
      const ix0 = Math.max(0, x0 - OVERLAP), iy0 = Math.max(0, y0 - OVERLAP), ix1 = Math.min(w, x1 + OVERLAP), iy1 = Math.min(h, y1 + OVERLAP);
      const iw = ix1 - ix0, ih = iy1 - iy0, plane = iw * ih;
      const x = new Float32Array(3 * plane);
      for (let y = 0; y < ih; y++)
        for (let xx = 0; xx < iw; xx++) {
          const p = ((iy0 + y) * w + ix0 + xx) * 4, q = y * iw + xx;
          x[q] = base.data[p] / 255; x[plane + q] = base.data[p + 1] / 255; x[2 * plane + q] = base.data[p + 2] / 255;
        }
      const r = await run({ s: [1, 3, ih, iw], d: x });
      const OW = iw * SCALE, OH = ih * SCALE, op = OW * OH;
      if (r.s[2] !== OH || r.s[3] !== OW) throw new Error("super-resolution: unexpected output size");
      // write the tile's area plus its right / bottom overlap; ramp in over the left / top overlap the earlier tiles wrote
      const ox0 = ix0 * SCALE, oy0 = iy0 * SCALE;
      const bandL = tx > 0 ? (x0 - ix0) * SCALE : 0, bandT = ty > 0 ? (y0 - iy0) * SCALE : 0;
      for (let y = 0; y < OH; y++) {
        const wy = bandT ? Math.min(1, (y + 0.5) / bandT) : 1;
        for (let xx = 0; xx < OW; xx++) {
          const wx = bandL ? Math.min(1, (xx + 0.5) / bandL) : 1, k = wx * wy, q = y * OW + xx;
          const t = ((oy0 + y) * W4 + ox0 + xx) * 4;
          for (let c = 0; c < 3; c++) {
            const v = r.d[c * op + q] * 255;
            big[t + c] = k >= 1 ? v : big[t + c] + k * (v - big[t + c]);
          }
          big[t + 3] = 255;
        }
      }
      onProgress?.(++done, total);
    }
  let out: Img = { width: W4, height: H4, data: big };
  if (W !== W4 || H !== H4) {
    if (W <= W4 && H <= H4) out = resizeArea(out, W, H);
    else out = upscale(out.width <= W && out.height <= H ? out : resizeArea(out, Math.min(W, W4), Math.min(H, H4)), { method: "hq", width: W, height: H }) as Img;
  }
  if (hasAlpha) {
    const a = upscale(src, { method: "hq", width: W, height: H }) as Img;
    for (let i = 3; i < out.data.length; i += 4) out.data[i] = a.data[i];
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] === 0) out.data[i] = out.data[i + 1] = out.data[i + 2] = 0;
  }
  onProgress?.(total, total);
  return out;
}
