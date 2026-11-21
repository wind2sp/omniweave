// Image upscale ("이미지 크기 키우기") — classical, pure TypeScript, runs in the image worker.
//
// Methods:
//  - "hq" (고품질, default): Lanczos-3 resampling, an edge-directed pass that smooths along strong edges only (the
//    staircase of diagonal edges goes, sharpness across the edge stays), then iterative back-projection: the result
//    is pushed until its own area-average equals the source pixels (each source pixel IS the average of the area it
//    covers), and an anti-ringing clamp to the 2×2 source neighbourhood so no halo is added. Optional mild
//    noise reduction (on the source, before enlarging) and unsharp mask (after).
//  - "smooth" (부드럽게): bicubic (Catmull-Rom).
//  - "pixel" (픽셀 그대로): nearest neighbour, for pixel art.
//
// All filtering is on premultiplied alpha, so transparent edges get no dark (or coloured) fringe. 8-bit and 16-bit
// RGBA in, the same depth out. Work is done in output tiles (TILE px) with a source margin, so the memory beyond the
// result is a few MB whatever the size; `onProgress` is called per tile. Colour mode decisions (CMYK, 32-bit) belong to
// the caller (ui/upscaleActions.ts, docs/design/IMAGE_UPSCALE.md).

import { gaussPremul } from "./filters";
import { ImageOpError } from "./ops";

export type UpscaleMethod = "hq" | "smooth" | "pixel";

export interface UpscaleOptions {
  method: UpscaleMethod;
  /** target size in pixels (each side ≥ the source, ≤ UPSCALE_MAX_FACTOR × the source) */
  width: number;
  height: number;
  /** unsharp mask after enlarging, 0..100 (default 0) */
  sharpen?: number;
  /** mild edge-preserving noise reduction on the source before enlarging */
  denoise?: boolean;
  /** false: the result is flattened onto white and opaque (default true: transparency kept) */
  keepAlpha?: boolean;
}

/** 8-bit (Uint8ClampedArray, 0..255) or 16-bit (Uint16Array, 0..65535) straight-alpha RGBA. */
export interface UpImg<D extends Uint8ClampedArray | Uint16Array = Uint8ClampedArray | Uint16Array> {
  width: number;
  height: number;
  data: D;
}

/** Largest result: 100 MP (400 MB at 8 bits — the result plus the copy sent back already need about twice that). */
export const UPSCALE_MAX_PIXELS = 100_000_000;
/** Photoshop's own limit for a PSD side. */
export const UPSCALE_MAX_SIDE = 30_000;
export const UPSCALE_MAX_FACTOR = 8;

/** Result size for a factor (rounded, at least 1). */
export function scaledSize(w: number, h: number, k: number): { width: number; height: number } {
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/** Throws a coded error (i18n key) when the target is not a valid enlargement of a w × h picture. */
export function checkUpscale(w: number, h: number, W: number, H: number) {
  if (!(w >= 1 && h >= 1) || !Number.isInteger(W) || !Number.isInteger(H)) throw new ImageOpError("image.upscale.err.size");
  if (W < w || H < h || (W === w && H === h)) throw new ImageOpError("image.upscale.err.notLarger", { w, h });
  if (W > w * UPSCALE_MAX_FACTOR || H > h * UPSCALE_MAX_FACTOR) throw new ImageOpError("image.upscale.err.factor", { max: UPSCALE_MAX_FACTOR });
  if (W > UPSCALE_MAX_SIDE || H > UPSCALE_MAX_SIDE || W * H > UPSCALE_MAX_PIXELS) throw new ImageOpError("image.upscale.err.tooLarge", { w: W, h: H, mp: Math.round(UPSCALE_MAX_PIXELS / 1e6) });
}

// ───────── separable resampling with precomputed tap tables ─────────

interface Axis {
  /** output samples */
  n: number;
  taps: number;
  idx: Int32Array;
  w: Float32Array;
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos3 = (x: number) => (Math.abs(x) < 3 ? sinc(x) * sinc(x / 3) : 0);
function catmullRom(x: number) {
  x = Math.abs(x);
  if (x < 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
  if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
  return 0;
}

/**
 * Interpolation taps for `n` outputs starting at global output index `d0`: output X samples the source at
 * u = (X + 0.5) / s − 0.5 (pixel centres), minus `off` (the local source window start); edges are clamped.
 */
function interpAxis(n: number, d0: number, s: number, off: number, len: number, radius: number, kern: (x: number) => number): Axis {
  const taps = 2 * radius, idx = new Int32Array(n * taps), w = new Float32Array(n * taps);
  for (let i = 0; i < n; i++) {
    const u = (d0 + i + 0.5) / s - 0.5 - off, f = Math.floor(u);
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const j = f - radius + 1 + t, k = kern(u - j);
      idx[i * taps + t] = j < 0 ? 0 : j >= len ? len - 1 : j;
      w[i * taps + t] = k;
      sum += k;
    }
    for (let t = 0; t < taps; t++) w[i * taps + t] /= sum;
  }
  return { n, taps, idx, w };
}

/**
 * Area average back to the source grid: source pixel i (global gi = off + i) is the mean of the output area
 * [gi·s, (gi+1)·s), output samples counted from global `d0`, `len` of them (partial coverage at the window edges is
 * renormalised).
 */
function boxAxis(n: number, off: number, s: number, d0: number, len: number): Axis {
  const taps = Math.ceil(s) + 1, idx = new Int32Array(n * taps), w = new Float32Array(n * taps);
  for (let i = 0; i < n; i++) {
    const a = (off + i) * s - d0, b = a + s, j0 = Math.floor(a);
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const j = j0 + t, cover = Math.max(0, Math.min(b, j + 1) - Math.max(a, j));
      const ok = j >= 0 && j < len;
      idx[i * taps + t] = ok ? j : 0;
      w[i * taps + t] = ok ? cover : 0;
      sum += ok ? cover : 0;
    }
    if (sum > 0) for (let t = 0; t < taps; t++) w[i * taps + t] /= sum;
  }
  return { n, taps, idx, w };
}

/** Separable filter of interleaved RGBA floats: sw × sh → ax.n × ay.n. */
function separable(src: Float32Array, sw: number, sh: number, ax: Axis, ay: Axis): Float32Array {
  const dw = ax.n, dh = ay.n;
  const tmp = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let t = 0, k = x * ax.taps; t < ax.taps; t++, k++) {
        const wt = ax.w[k];
        if (wt === 0) continue;
        const p = (row + ax.idx[k]) * 4;
        r += wt * src[p]; g += wt * src[p + 1]; b += wt * src[p + 2]; a += wt * src[p + 3];
      }
      const o = (y * dw + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = new Float32Array(dw * dh * 4), stride = dw * 4;
  for (let y = 0; y < dh; y++) {
    const o = y * stride;
    for (let t = 0, k = y * ay.taps; t < ay.taps; t++, k++) {
      const wt = ay.w[k];
      if (wt === 0) continue;
      const s = ay.idx[k] * stride;
      for (let c = 0; c < stride; c++) out[o + c] += wt * tmp[s + c];
    }
  }
  return out;
}

// ───────── passes ─────────

/** 3 × 3 bilateral filter on premultiplied floats (range σ ≈ 6 % of full scale): grain goes, edges stay. */
function denoise(f: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(f.length), inv = 1 / (2 * 0.06 * 0.06);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      let r = 0, g = 0, b = 0, a = 0, sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const p = (yy * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
          const d0 = f[p] - f[o], d1 = f[p + 1] - f[o + 1], d2 = f[p + 2] - f[o + 2], d3 = f[p + 3] - f[o + 3];
          const k = Math.exp(-(d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3) * inv - (dx * dx + dy * dy) * 0.5);
          r += k * f[p]; g += k * f[p + 1]; b += k * f[p + 2]; a += k * f[p + 3];
          sum += k;
        }
      }
      out[o] = r / sum; out[o + 1] = g / sum; out[o + 2] = b / sum; out[o + 3] = a / sum;
    }
  return out;
}

function bilinear(f: Float32Array, w: number, h: number, x: number, y: number, out: Float32Array, o: number, k: number) {
  x = x < 0 ? 0 : x > w - 1 ? w - 1 : x;
  y = y < 0 ? 0 : y > h - 1 ? h - 1 : y;
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1);
  const fx = x - x0, fy = y - y0;
  const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4;
  const a = (1 - fx) * (1 - fy), b = fx * (1 - fy), c = (1 - fx) * fy, d = fx * fy;
  for (let ch = 0; ch < 4; ch++) out[o + ch] += k * (a * f[p00 + ch] + b * f[p10 + ch] + c * f[p01 + ch] + d * f[p11 + ch]);
}

/**
 * Edge-directed refinement: the structure tensor of the enlarged picture gives each pixel its edge direction and
 * how coherent it is; where an edge is strong and straight the pixel is averaged with samples along the edge (never
 * across it). Flat areas and textures (low coherence) are left as they are.
 */
function edgeRefine(f: Float32Array, w: number, h: number, s: number): Float32Array {
  const n = w * h, lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * f[i * 4] + 0.587 * f[i * 4 + 1] + 0.114 * f[i * 4 + 2] + 0.5 * f[i * 4 + 3];
  const J = new Float32Array(n * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = (lum[y * w + Math.min(w - 1, x + 1)] - lum[y * w + Math.max(0, x - 1)]) * 0.5;
      const gy = (lum[Math.min(h - 1, y + 1) * w + x] - lum[Math.max(0, y - 1) * w + x]) * 0.5;
      const o = (y * w + x) * 4;
      J[o] = gx * gx; J[o + 1] = gx * gy; J[o + 2] = gy * gy;
    }
  gaussPremul(J, w, h, Math.max(1, s * 0.6));
  const out = new Float32Array(f);
  const d1 = s * 0.5, d2 = s, eps = 1e-4;
  const acc = new Float32Array(4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const jxx = J[o], jxy = J[o + 1], jyy = J[o + 2], tr = jxx + jyy;
      if (tr < eps) continue;
      const disc = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
      const coh = (disc / tr) * (disc / tr);
      const k = 0.85 * coh * (tr / (tr + 4 * eps));
      if (k < 0.02) continue;
      // tangent = eigenvector of the smaller eigenvalue
      const l2 = (tr - disc) / 2;
      let tx = jxy, ty = l2 - jxx;
      if (Math.abs(tx) + Math.abs(ty) < 1e-12) (tx = jyy - l2), (ty = jxy);
      // (jxx ≥ jyy and jxy = 0: the gradient is along x, the edge along y)
      if (Math.abs(tx) + Math.abs(ty) < 1e-12) (tx = jxx >= jyy ? 0 : 1), (ty = jxx >= jyy ? 1 : 0);
      const len = Math.hypot(tx, ty);
      tx /= len;
      ty /= len;
      acc.fill(0);
      bilinear(f, w, h, x + tx * d1, y + ty * d1, acc, 0, 0.3);
      bilinear(f, w, h, x - tx * d1, y - ty * d1, acc, 0, 0.3);
      bilinear(f, w, h, x + tx * d2, y + ty * d2, acc, 0, 0.2);
      bilinear(f, w, h, x - tx * d2, y - ty * d2, acc, 0, 0.2);
      for (let c = 0; c < 4; c++) out[o + c] = f[o + c] + k * (acc[c] - f[o + c]);
    }
  return out;
}

/** Clamp every output sample to the range of the 2 × 2 source pixels around it (no overshoot, no halo). */
function antiRing(hr: Float32Array, lr: Float32Array, lw: number, ax: Axis, ay: Axis) {
  const W = ax.n, H = ay.n;
  const fx0 = new Int32Array(W), fx1 = new Int32Array(W), fy0 = new Int32Array(H), fy1 = new Int32Array(H);
  // the two middle taps of a 6-tap (Lanczos-3) table are the source pixels left / right of the sample
  for (let i = 0; i < W; i++) (fx0[i] = ax.idx[i * ax.taps + ax.taps / 2 - 1]), (fx1[i] = ax.idx[i * ax.taps + ax.taps / 2]);
  for (let i = 0; i < H; i++) (fy0[i] = ay.idx[i * ay.taps + ay.taps / 2 - 1]), (fy1[i] = ay.idx[i * ay.taps + ay.taps / 2]);
  for (let y = 0; y < H; y++) {
    const r0 = fy0[y] * lw, r1 = fy1[y] * lw;
    for (let x = 0; x < W; x++) {
      const a = (r0 + fx0[x]) * 4, b = (r0 + fx1[x]) * 4, c = (r1 + fx0[x]) * 4, d = (r1 + fx1[x]) * 4, o = (y * W + x) * 4;
      for (let ch = 0; ch < 4; ch++) {
        const va = lr[a + ch], vb = lr[b + ch], vc = lr[c + ch], vd = lr[d + ch];
        const lo = Math.min(va, vb, vc, vd), hi = Math.max(va, vb, vc, vd), v = hr[o + ch];
        hr[o + ch] = v < lo ? lo : v > hi ? hi : v;
      }
    }
  }
}

function unsharp(f: Float32Array, w: number, h: number, amount: number, sigma: number) {
  const blur = gaussPremul(new Float32Array(f), w, h, sigma);
  for (let i = 0; i < f.length; i++) f[i] += amount * (f[i] - blur[i]);
}

/** Premultiplied 0..1 floats of a source window (flattened on white when transparency is not kept). */
function windowPremul(img: UpImg, x0: number, y0: number, w: number, h: number, max: number, keepAlpha: boolean): Float32Array {
  const f = new Float32Array(w * h * 4), d = img.data, inv = 1 / max;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.width + x0 + x) * 4, o = (y * w + x) * 4;
      const a = d[s + 3] * inv;
      if (keepAlpha) {
        f[o] = d[s] * inv * a; f[o + 1] = d[s + 1] * inv * a; f[o + 2] = d[s + 2] * inv * a; f[o + 3] = a;
      } else {
        f[o] = d[s] * inv * a + 1 - a; f[o + 1] = d[s + 1] * inv * a + 1 - a; f[o + 2] = d[s + 2] * inv * a + 1 - a; f[o + 3] = 1;
      }
    }
  return f;
}

/**
 * Enlarge a picture. Throws ImageOpError for an invalid target (checkUpscale). `onProgress(done, total)` after every
 * output tile.
 */
export function upscale<D extends Uint8ClampedArray | Uint16Array>(img: UpImg<D>, o: UpscaleOptions, onProgress?: (done: number, total: number) => void): UpImg<D> {
  const w = img.width, h = img.height, W = o.width, H = o.height;
  checkUpscale(w, h, W, H);
  const deep = img.data instanceof Uint16Array, max = deep ? 65535 : 255;
  const out = (deep ? new Uint16Array(W * H * 4) : new Uint8ClampedArray(W * H * 4)) as D;
  const keepAlpha = o.keepAlpha !== false;
  const sx = W / w, sy = H / h;
  if (o.method === "pixel") {
    const xs = new Int32Array(W);
    for (let X = 0; X < W; X++) xs[X] = Math.min(w - 1, Math.floor((X + 0.5) / sx));
    const d = img.data;
    for (let Y = 0; Y < H; Y++) {
      const row = Math.min(h - 1, Math.floor((Y + 0.5) / sy)) * w;
      for (let X = 0; X < W; X++) {
        const s = (row + xs[X]) * 4, t = (Y * W + X) * 4;
        if (keepAlpha) (out[t] = d[s]), (out[t + 1] = d[s + 1]), (out[t + 2] = d[s + 2]), (out[t + 3] = d[s + 3]);
        else {
          const a = d[s + 3] / max;
          for (let c = 0; c < 3; c++) out[t + c] = Math.round(d[s + c] * a + max * (1 - a));
          out[t + 3] = max;
        }
      }
      if (onProgress && (Y % 256 === 255 || Y === H - 1)) onProgress(Y + 1, H);
    }
    return { width: W, height: H, data: out };
  }
  const hq = o.method === "hq";
  const TILE = 512;
  // source margin around a tile: Lanczos (3) + the edge pass and back-projection (2 rounds × 4) + the sharpen blur
  const M = hq ? 12 : 3;
  const sharpen = Math.max(0, Math.min(100, o.sharpen ?? 0)) / 100;
  const tilesX = Math.ceil(W / TILE), tilesY = Math.ceil(H / TILE), total = tilesX * tilesY;
  let done = 0;
  for (let Y0 = 0; Y0 < H; Y0 += TILE)
    for (let X0 = 0; X0 < W; X0 += TILE) {
      const X1 = Math.min(W, X0 + TILE), Y1 = Math.min(H, Y0 + TILE);
      const lx0 = Math.max(0, Math.floor(X0 / sx) - M), lx1 = Math.min(w, Math.ceil(X1 / sx) + M);
      const ly0 = Math.max(0, Math.floor(Y0 / sy) - M), ly1 = Math.min(h, Math.ceil(Y1 / sy) + M);
      const lw = lx1 - lx0, lh = ly1 - ly0;
      let lr = windowPremul(img, lx0, ly0, lw, lh, max, keepAlpha);
      if (o.denoise) lr = denoise(lr, lw, lh);
      // the output area of this source window
      const hx0 = Math.round(lx0 * sx), hx1 = Math.round(lx1 * sx), hy0 = Math.round(ly0 * sy), hy1 = Math.round(ly1 * sy);
      const hw = hx1 - hx0, hh = hy1 - hy0;
      const ax = hq ? interpAxis(hw, hx0, sx, lx0, lw, 3, lanczos3) : interpAxis(hw, hx0, sx, lx0, lw, 2, catmullRom);
      const ay = hq ? interpAxis(hh, hy0, sy, ly0, lh, 3, lanczos3) : interpAxis(hh, hy0, sy, ly0, lh, 2, catmullRom);
      let hr = separable(lr, lw, lh, ax, ay);
      if (hq) {
        hr = edgeRefine(hr, hw, hh, (sx + sy) / 2);
        const bx = boxAxis(lw, lx0, sx, hx0, hw), by = boxAxis(lh, ly0, sy, hy0, hh);
        for (let it = 0; it < 2; it++) {
          const down = separable(hr, hw, hh, bx, by);
          for (let i = 0; i < down.length; i++) down[i] = lr[i] - down[i];
          const up = separable(down, lw, lh, ax, ay);
          for (let i = 0; i < hr.length; i++) hr[i] += up[i];
        }
        antiRing(hr, lr, lw, ax, ay);
      }
      if (sharpen > 0) unsharp(hr, hw, hh, sharpen * 1.2, Math.max(0.6, ((sx + sy) / 2) * 0.5));
      // back to straight alpha in the result; premultiplied colour is kept within [0, alpha]
      for (let Y = Y0; Y < Y1; Y++)
        for (let X = X0; X < X1; X++) {
          const s = ((Y - hy0) * hw + (X - hx0)) * 4, t = (Y * W + X) * 4;
          let a = hr[s + 3];
          a = a < 0 ? 0 : a > 1 ? 1 : a;
          if (a * max < 0.5) {
            out[t] = out[t + 1] = out[t + 2] = out[t + 3] = 0;
            continue;
          }
          for (let c = 0; c < 3; c++) {
            const v = hr[s + c];
            out[t + c] = Math.round(((v < 0 ? 0 : v > a ? a : v) / a) * max);
          }
          out[t + 3] = Math.round(a * max);
        }
      onProgress?.(++done, total);
    }
  return { width: W, height: H, data: out };
}
