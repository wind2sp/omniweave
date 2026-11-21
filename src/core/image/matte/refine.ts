// Edge refinement for background removal ("가장자리 다듬기", Photoshop Select and Mask). Pure, runs in the image worker.
//
//   coarse alpha (e.g. 320² saliency) ──► colour-guided filter at working resolution (snaps the matte to image edges)
//     ──► tail clip (hardenAlpha: the map's blur ramps are not coverage)
//     ──► local foreground / background colour estimates in the uncertain band (matteBand; used for decontamination —
//         its colour-line alpha re-estimate made real photos worse, so it is not applied to the matte by default)
//     ──► smooth / feather / contrast / shift edge (user sliders)
//     ──► fast guided upsampling to full resolution (detail comes from the full-res image as guide)
//     ──► colour decontamination (removes background spill from edge pixels; only the cut-out copy changes)
//
// Working resolution is capped (WORK_SIDE) so a 12 MP photo costs about as much as a 1 MP one, except the final
// per-pixel pass. References: He, Sun, Tang "Guided Image Filtering" (2010/2013), He & Sun "Fast Guided Filter" (2015).

import type { Img } from "../pixels";

/** long side of the working resolution */
export const WORK_SIDE = 1024;

export interface Plane {
  w: number;
  h: number;
  d: Float32Array;
}

export interface EdgeOptions {
  /** uncertain band half-width in working-res px (hair/fur want more) */
  radius: number;
  /** 0..100: removes jaggies */
  smooth: number;
  /** feather in full-res px */
  feather: number;
  /** 0..100: hardens the edge */
  contrast: number;
  /** −100..100: moves the edge out (+) or in (−) */
  shift: number;
  /** 0..100: background colour spill removal at edges */
  decontaminate: number;
}

export const DEFAULT_EDGE: EdgeOptions = { radius: 6, smooth: 0, feather: 0, contrast: 0, shift: 0, decontaminate: 60 };

// ---------- primitives ----------

/** Mean over a (2r+1)² window, clamped at the borders (window shrinks; divides by the real count). O(N). */
export function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  if (r <= 0) return Float32Array.from(src);
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = 0; x < Math.min(w, r + 1); x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      const lo = x - r, hi = x + r;
      tmp[o + x] = s / (Math.min(w - 1, hi) - Math.max(0, lo) + 1);
      if (hi + 1 < w) s += src[o + hi + 1];
      if (lo >= 0) s -= src[o + lo];
    }
  }
  const col = new Float64Array(w);
  for (let y = 0; y < Math.min(h, r + 1); y++) for (let x = 0; x < w; x++) col[x] += tmp[y * w + x];
  for (let y = 0; y < h; y++) {
    const lo = y - r, hi = y + r;
    const n = Math.min(h - 1, hi) - Math.max(0, lo) + 1;
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = col[x] / n;
    if (hi + 1 < h) for (let x = 0, p = (hi + 1) * w; x < w; x++) col[x] += tmp[p + x];
    if (lo >= 0) for (let x = 0, p = lo * w; x < w; x++) col[x] -= tmp[p + x];
  }
  return out;
}

/** Bilinear resample of a plane (pixel-centre aligned). */
export function resizePlane(p: Plane, w: number, h: number): Plane {
  const out = new Float32Array(w * h);
  const sx = p.w / w, sy = p.h / h;
  for (let y = 0; y < h; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(p.h - 1, Math.floor(fy)), y1 = Math.min(p.h - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      let fx = (x + 0.5) * sx - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(p.w - 1, Math.floor(fx)), x1 = Math.min(p.w - 1, x0 + 1), tx = fx - x0;
      const a = p.d[y0 * p.w + x0] + (p.d[y0 * p.w + x1] - p.d[y0 * p.w + x0]) * tx;
      const b = p.d[y1 * p.w + x0] + (p.d[y1 * p.w + x1] - p.d[y1 * p.w + x0]) * tx;
      out[y * w + x] = a + (b - a) * ty;
    }
  }
  return { w, h, d: out };
}

/** RGB planes (0..1) of an image, area-averaged down to w×h; transparent pixels are composited on white. */
export function rgbPlanes(img: Img, w: number, h: number): [Float32Array, Float32Array, Float32Array] {
  const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h);
  const { width: W, height: H, data: d } = img;
  const sx = W / w, sy = H / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < Math.min(H, y1); yy++)
        for (let xx = x0; xx < Math.min(W, x1); xx++) {
          const i = (yy * W + xx) * 4, a = d[i + 3] / 255;
          r += d[i] * a + 255 * (1 - a);
          g += d[i + 1] * a + 255 * (1 - a);
          b += d[i + 2] * a + 255 * (1 - a);
          n++;
        }
      const k = 1 / (255 * (n || 1));
      R[y * w + x] = r * k;
      G[y * w + x] = g * k;
      B[y * w + x] = b * k;
    }
  }
  return [R, G, B];
}

export function workSize(W: number, H: number, side = WORK_SIDE): { w: number; h: number } {
  const k = Math.min(1, side / Math.max(W, H));
  return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) };
}

/**
 * Colour-guided filter coefficients: q = aR·R + aG·G + aB·B + b, smoothed (mean of a, b). Edge-preserving; `eps`
 * trades smoothing against following the guide.
 */
export function guidedCoeffs(I: [Float32Array, Float32Array, Float32Array], p: Float32Array, w: number, h: number, r: number, eps: number) {
  const N = w * h;
  const [R, G, B] = I;
  const m = (x: Float32Array) => boxMean(x, w, h, r);
  const prod = (a: Float32Array, b: Float32Array) => {
    const o = new Float32Array(N);
    for (let i = 0; i < N; i++) o[i] = a[i] * b[i];
    return o;
  };
  const mR = m(R), mG = m(G), mB = m(B), mp = m(p);
  const cRp = m(prod(R, p)), cGp = m(prod(G, p)), cBp = m(prod(B, p));
  const vRR = m(prod(R, R)), vRG = m(prod(R, G)), vRB = m(prod(R, B)), vGG = m(prod(G, G)), vGB = m(prod(G, B)), vBB = m(prod(B, B));
  const aR = new Float32Array(N), aG = new Float32Array(N), aB = new Float32Array(N), b = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const rr = vRR[i] - mR[i] * mR[i] + eps, rg = vRG[i] - mR[i] * mG[i], rb = vRB[i] - mR[i] * mB[i];
    const gg = vGG[i] - mG[i] * mG[i] + eps, gb = vGB[i] - mG[i] * mB[i], bb = vBB[i] - mB[i] * mB[i] + eps;
    const pr = cRp[i] - mR[i] * mp[i], pg = cGp[i] - mG[i] * mp[i], pb = cBp[i] - mB[i] * mp[i];
    // inverse of the symmetric 3×3 covariance
    const i00 = gg * bb - gb * gb, i01 = rb * gb - rg * bb, i02 = rg * gb - rb * gg;
    const i11 = rr * bb - rb * rb, i12 = rb * rg - rr * gb, i22 = rr * gg - rg * rg;
    const det = rr * i00 + rg * i01 + rb * i02;
    const k = det !== 0 ? 1 / det : 0;
    aR[i] = (pr * i00 + pg * i01 + pb * i02) * k;
    aG[i] = (pr * i01 + pg * i11 + pb * i12) * k;
    aB[i] = (pr * i02 + pg * i12 + pb * i22) * k;
    b[i] = mp[i] - aR[i] * mR[i] - aG[i] * mG[i] - aB[i] * mB[i];
  }
  return { aR: m(aR), aG: m(aG), aB: m(aB), b: m(b) };
}

export function guidedFilter(I: [Float32Array, Float32Array, Float32Array], p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const c = guidedCoeffs(I, p, w, h, r, eps);
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(c.aR[i] * I[0][i] + c.aG[i] * I[1][i] + c.aB[i] * I[2][i] + c.b[i]);
  return out;
}

export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------- matting-lite ----------

export interface BandResult {
  alpha: Float32Array;
  /** local foreground / background colour estimates (for decontamination), 3 planes each */
  fg: [Float32Array, Float32Array, Float32Array];
  bg: [Float32Array, Float32Array, Float32Array];
}

/**
 * Re-estimate alpha in the uncertain band around the 0.5 contour from local foreground / background colour means
 * (alpha = projection of the pixel colour on the line between them, Bayesian / shared-sampling style but O(N) with
 * box filters). Where the two colours are too close to tell apart, the guided alpha is kept.
 */
export function matteBand(I: [Float32Array, Float32Array, Float32Array], alpha: Float32Array, w: number, h: number, radius: number): BandResult {
  const N = w * h;
  const bin = new Float32Array(N);
  for (let i = 0; i < N; i++) bin[i] = alpha[i] >= 0.5 ? 1 : 0;
  const near = boxMean(bin, w, h, Math.max(1, radius));
  const F = new Float32Array(N), Bk = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const band = near[i] > 0.001 && near[i] < 0.999;
    if (!band) {
      if (bin[i]) F[i] = 1;
      else Bk[i] = 1;
    } else if (alpha[i] > 0.985) F[i] = 1;
    else if (alpha[i] < 0.015) Bk[i] = 1;
  }
  const est = (mask: Float32Array) => {
    const r1 = Math.max(2, Math.round(radius * 1.5)), r2 = r1 * 4;
    const cnt1 = boxMean(mask, w, h, r1), cnt2 = boxMean(mask, w, h, r2);
    return I.map((ch) => {
      const prod = new Float32Array(N);
      for (let i = 0; i < N; i++) prod[i] = ch[i] * mask[i];
      const s1 = boxMean(prod, w, h, r1), s2 = boxMean(prod, w, h, r2);
      const o = new Float32Array(N);
      let glob = 0, gn = 0;
      for (let i = 0; i < N; i++) if (mask[i]) (glob += ch[i]), gn++;
      glob = gn ? glob / gn : 0.5;
      for (let i = 0; i < N; i++) o[i] = cnt1[i] > 0.02 ? s1[i] / cnt1[i] : cnt2[i] > 0.002 ? s2[i] / cnt2[i] : glob;
      return o;
    }) as [Float32Array, Float32Array, Float32Array];
  };
  const fg = est(F), bg = est(Bk);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const band = near[i] > 0.001 && near[i] < 0.999;
    if (!band) {
      out[i] = alpha[i] > 0.9 ? 1 : alpha[i] < 0.1 ? 0 : alpha[i];
      continue;
    }
    const dr = fg[0][i] - bg[0][i], dg = fg[1][i] - bg[1][i], db = fg[2][i] - bg[2][i];
    const len2 = dr * dr + dg * dg + db * db;
    const ac = clamp01(((I[0][i] - bg[0][i]) * dr + (I[1][i] - bg[1][i]) * dg + (I[2][i] - bg[2][i]) * db) / (len2 + 1e-6));
    // trust the colour estimate only where fg and bg differ clearly
    const conf = clamp01((Math.sqrt(len2) - 0.06) / 0.2);
    out[i] = conf * ac + (1 - conf) * alpha[i];
  }
  return { alpha: out, fg, bg };
}

/**
 * Clip the low / high tails of a guided saliency matte: U²-Netp's soft ramps are mostly blur from the 320² map, not
 * partial coverage, so values within `t` of 0 or 1 snap there and the rest is stretched (fine partial alpha — hair —
 * comes from the colour-guided filter and survives). Real-image eval: SAD −40 %, edge gradient error −50 % vs. the
 * colour-line band re-estimate (docs/design/MATTE_EVAL.md).
 */
export function hardenAlpha(a: Float32Array, t: number): Float32Array {
  if (t <= 0) return a;
  const k = 1 / (1 - 2 * t);
  return a.map((x) => (x >= 1 - t ? 1 : x <= t ? 0 : (x - t) * k));
}

/** Guided-filter defaults for the saliency map (radius in px at 1024 working side, eps) and the tail clip. */
export const GUIDE = { radius: 8, eps: 3e-4, harden: 0.12 };

// ---------- user controls ----------

/** Smooth, feather (working-res px), contrast and shift edge, in that order. */
export function shapeAlpha(a: Float32Array, w: number, h: number, o: Pick<EdgeOptions, "smooth" | "contrast" | "shift">, featherPx: number): Float32Array {
  let x = a;
  if (o.smooth > 0) {
    const r = Math.max(1, Math.round(o.smooth / 25));
    x = boxMean(x, w, h, r);
    // keep the edge as hard as it was: smoothing changes the outline, not the softness
    const k = 1 + o.smooth / 50;
    x = x.map((v) => clamp01((v - 0.5) * k + 0.5));
  }
  if (featherPx > 0.3) {
    const r = Math.max(1, Math.round(featherPx / 1.7));
    for (let i = 0; i < 3; i++) x = boxMean(x, w, h, r); // ≈ gaussian
  }
  if (o.contrast > 0) {
    const k = 1 + o.contrast / 12;
    x = x.map((v) => clamp01((v - 0.5) * k + 0.5));
  }
  if (o.shift !== 0) {
    const g = Math.pow(2, -o.shift / 40);
    x = x.map((v) => Math.pow(v, g));
  }
  return x;
}

// ---------- full resolution ----------

/**
 * Final alpha at full resolution: guided-filter coefficients of the working-res matte (small radius, small eps) are
 * bilinearly upsampled and applied to the full-res pixels (fast guided upsampling). Returns 0..255 alpha.
 */
export function upsampleAlpha(img: Img, I: [Float32Array, Float32Array, Float32Array], a: Float32Array, w: number, h: number): Uint8ClampedArray {
  const W = img.width, H = img.height;
  const out = new Uint8ClampedArray(W * H);
  if (W === w && H === h) {
    for (let i = 0; i < out.length; i++) out[i] = Math.round(a[i] * 255);
    return out;
  }
  const c = guidedCoeffs(I, a, w, h, 1, 1e-4);
  const d = img.data;
  const sx = w / W, sy = h / H;
  const x0s = new Int32Array(W), x1s = new Int32Array(W), txs = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    let fx = (x + 0.5) * sx - 0.5;
    if (fx < 0) fx = 0;
    x0s[x] = Math.min(w - 1, Math.floor(fx));
    x1s[x] = Math.min(w - 1, x0s[x] + 1);
    txs[x] = fx - x0s[x];
  }
  const lerp2 = (p: Float32Array, r0: number, r1: number, x: number, ty: number) => {
    const a0 = p[r0 + x0s[x]] + (p[r0 + x1s[x]] - p[r0 + x0s[x]]) * txs[x];
    const a1 = p[r1 + x0s[x]] + (p[r1 + x1s[x]] - p[r1 + x0s[x]]) * txs[x];
    return a0 + (a1 - a0) * ty;
  };
  for (let y = 0; y < H; y++) {
    let fy = (y + 0.5) * sy - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(h - 1, Math.floor(fy)), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
    const r0 = y0 * w, r1 = y1 * w;
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const al = d[i + 3] / 255;
      const R = (d[i] * al + 255 * (1 - al)) / 255, G = (d[i + 1] * al + 255 * (1 - al)) / 255, B = (d[i + 2] * al + 255 * (1 - al)) / 255;
      const v = lerp2(c.aR, r0, r1, x, ty) * R + lerp2(c.aG, r0, r1, x, ty) * G + lerp2(c.aB, r0, r1, x, ty) * B + lerp2(c.b, r0, r1, x, ty);
      out[y * W + x] = Math.round(clamp01(v) * 255 * al);
    }
  }
  return out;
}

/**
 * Cut-out pixels: the original colour with the matte as alpha; edge pixels get their background spill removed
 * (F = (I − (1−α)·B) / α, B = local background estimate) blended in by `amount` (0..100).
 */
export function composeCutout(img: Img, alpha: Uint8ClampedArray, bg: [Float32Array, Float32Array, Float32Array] | null, fg: [Float32Array, Float32Array, Float32Array] | null, w: number, h: number, amount: number): Img {
  const W = img.width, H = img.height, d = img.data;
  const out = new Uint8ClampedArray(d.length);
  const k = Math.max(0, Math.min(1, amount / 100));
  const sx = w / W, sy = h / H;
  for (let y = 0; y < H; y++) {
    const wy = Math.min(h - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 4;
      const a = alpha[p];
      out[i + 3] = a;
      if (a === 0) continue;
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (k > 0 && bg && a < 250) {
        const wp = wy * w + Math.min(w - 1, Math.floor((x + 0.5) * sx));
        const af = a / 255;
        const br = bg[0][wp] * 255, bgc = bg[1][wp] * 255, bb = bg[2][wp] * 255;
        let fr = (r - (1 - af) * br) / af, fgc = (g - (1 - af) * bgc) / af, fb = (b - (1 - af) * bb) / af;
        if (fg && af < 0.35) {
          // tiny alpha: the unmixing is unstable, lean on the local foreground colour
          const t = af / 0.35;
          fr = fr * t + fg[0][wp] * 255 * (1 - t);
          fgc = fgc * t + fg[1][wp] * 255 * (1 - t);
          fb = fb * t + fg[2][wp] * 255 * (1 - t);
        }
        r = r + (Math.max(0, Math.min(255, fr)) - r) * k;
        g = g + (Math.max(0, Math.min(255, fgc)) - g) * k;
        b = b + (Math.max(0, Math.min(255, fb)) - b) * k;
      }
      out[i] = r;
      out[i + 1] = g;
      out[i + 2] = b;
    }
  }
  return { width: W, height: H, data: out };
}
