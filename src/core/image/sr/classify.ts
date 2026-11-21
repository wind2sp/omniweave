// What kind of picture is this, and how damaged? — chooses the super-resolution model and its denoise strength
// ("자동"). Pure statistics, no network: a few ms on a 256 px copy plus a 256 px native-resolution crop.
//
//  content: "photo" or "art" (illustration, animation, line art, logos, screenshots and text) from
//   - palette concentration (share of the 16 most common 5-bit colours) and distinct colour count,
//   - flat-area share (gradient < 2) and the share of middle gradients (3..20, the soft shading of photos),
//   - edge bimodality: strong edges between flat sides (vector art and text) vs soft ones.
//  damage:
//   - noise σ (Immerkær 1996: the 3 × 3 Laplacian-difference mask, on non-edge pixels only),
//   - JPEG blockiness: mean step across the 8 × 8 grid lines over the mean step elsewhere (1 = none).
//  → denoise 0..1 (the general / wdn blend) and whether to deblock first.

import type { Img } from "../pixels";

export type SrContent = "photo" | "art";

export interface SrFeatures {
  /** share of pixels in the 16 most common colours (5 bits a channel) */
  top16: number;
  /** distinct colours per 1000 pixels */
  colours: number;
  flat: number;
  mid: number;
  /** strong edges with a flat pixel on both sides, per strong edge */
  crisp: number;
  /** noise σ away from strong edges */
  noise: number;
  /** the same measure within 3 px of strong edges (ringing) */
  ring: number;
  blockiness: number;
  /** estimated JPEG quality (100 = none) */
  jpeg: number;
}

export interface SrDecision {
  content: SrContent;
  /** 0..1 */
  denoise: number;
  deblock: boolean;
  /** "low" | "mid" | "high" damage, for the dialog */
  damage: "low" | "mid" | "high";
  /** looks like pixel art (few exact colours, hard un-blended steps): the dialog suggests "픽셀 그대로" */
  pixelArt: boolean;
  features: SrFeatures;
  ms: number;
}

const lumaOf = (d: ArrayLike<number>, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Nearest-neighbour copy with the longer side ≤ max (keeps hard edges for the content statistics). */
function sample(img: Img, max: number): Img {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  if (k >= 1) return img;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y + 0.5) / k));
    for (let x = 0; x < w; x++) {
      const s = (sy * img.width + Math.min(img.width - 1, Math.floor((x + 0.5) / k))) * 4;
      out.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}

export function srFeatures(img: Img): SrFeatures {
  // ── content, on a ≤ 256 px copy ──
  const s = sample(img, 256), W = s.width, H = s.height, d = s.data, n = W * H;
  const hist = new Map<number, number>();
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const key = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
    hist.set(key, (hist.get(key) ?? 0) + 1);
    L[i] = lumaOf(d, p);
  }
  const counts = [...hist.values()].sort((a, b) => b - a);
  let top = 0;
  for (let i = 0; i < Math.min(16, counts.length); i++) top += counts[i];
  let flat = 0, mid = 0, strong = 0, crisp = 0, cnt = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = L[i + 1] - L[i - 1], gy = L[i + W] - L[i - W], g = Math.hypot(gx, gy) / 2;
      cnt++;
      if (g < 2) flat++;
      else if (g >= 3 && g < 20) mid++;
      else if (g >= 30) {
        strong++;
        // the pixels two steps away across the edge are flat on both sides: a drawn edge, not a soft one
        const ax = Math.abs(gx) >= Math.abs(gy);
        const a = ax ? Math.max(1, x - 2) + y * W : Math.max(1, y - 2) * W + x, b = ax ? Math.min(W - 2, x + 2) + y * W : Math.min(H - 2, y + 2) * W + x;
        const fl = (j: number) => Math.abs(L[j + 1] - L[j - 1]) + Math.abs(L[j + W] - L[j - W]) < 8;
        if (fl(a) && fl(b)) crisp++;
      }
    }
  // ── damage, on a native-resolution crop (JPEG blocks sit on the file's own 8 × 8 grid) ──
  const cw = Math.min(img.width, 256), ch = Math.min(img.height, 256);
  const cx = Math.floor((img.width - cw) / 16) * 8, cy = Math.floor((img.height - ch) / 16) * 8;
  const C = new Float32Array(cw * ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) C[y * cw + x] = lumaOf(img.data, ((cy + y) * img.width + cx + x) * 4);
  // strong edges, and a band of 3 px around them: ringing (JPEG "mosquito noise") lives in the band, sensor noise
  // is measured away from it
  const G = new Float32Array(cw * ch), near = new Uint8Array(cw * ch);
  for (let y = 1; y < ch - 1; y++)
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      G[i] = Math.abs(C[i + 1] - C[i - 1]) + Math.abs(C[i + cw] - C[i - cw]);
    }
  for (let y = 0; y < ch; y++)
    for (let x = 0; x < cw; x++)
      if (G[y * cw + x] >= 80)
        for (let dy = -3; dy <= 3; dy++)
          for (let dx = -3; dx <= 3; dx++) {
            const yy = y + dy, xx = x + dx;
            if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) near[yy * cw + xx] = 1;
          }
  let sum = 0, used = 0, ringSum = 0, ringN = 0, onGrid = 0, nOn = 0, offGrid = 0, nOff = 0;
  for (let y = 1; y < ch - 1; y++)
    for (let x = 1; x < cw - 1; x++) {
      const i = y * cw + x;
      const gx = Math.abs(C[i + 1] - C[i - 1]), gy = Math.abs(C[i + cw] - C[i - cw]);
      if (gx + gy < 24) {
        const lap = C[i - cw - 1] - 2 * C[i - cw] + C[i - cw + 1] - 2 * C[i - 1] + 4 * C[i] - 2 * C[i + 1] + C[i + cw - 1] - 2 * C[i + cw] + C[i + cw + 1];
        if (near[i]) (ringSum += Math.abs(lap)), ringN++;
        else (sum += Math.abs(lap)), used++;
      }
      // horizontal steps between columns x and x + 1, in smooth surroundings only (texture says nothing about blocks)
      if (gx + gy < 40) {
        const step = Math.abs(C[i + 1] - C[i]);
        if ((cx + x) % 8 === 7) (onGrid += step), nOn++;
        else (offGrid += step), nOff++;
      }
    }
  const jpeg = jpegQuality(C, cw, ch);
  const k = Math.sqrt(Math.PI / 2) / 6;
  const noise = used > 50 ? k * (sum / used) : 0;
  const ring = ringN > 50 ? k * (ringSum / ringN) : 0;
  const blockiness = nOn > 20 && nOff > 20 ? (onGrid / nOn + 0.3) / (offGrid / nOff + 0.3) : 1;
  return { top16: top / n, colours: (hist.size / n) * 1000, flat: flat / cnt, mid: mid / cnt, crisp: strong ? crisp / strong : 0, noise, ring, blockiness, jpeg };
}

const DCT8 = Array.from({ length: 64 }, (_, k) => (Math.floor(k / 8) === 0 ? Math.SQRT1_2 : 1) * 0.5 * Math.cos(((2 * (k % 8) + 1) * Math.floor(k / 8) * Math.PI) / 16)); // [u·8 + x]

/**
 * The JPEG quality the picture was last saved at, read from its own pixels: a decoded JPEG's 8 × 8 DCT coefficients
 * sit on multiples of the quantisation step. The step of the four lowest AC coefficients (luma) is found as the
 * largest q whose multiples the coefficients cluster on, and turned back into the IJG quality scale (standard
 * table). 100 = no quantisation found (never a JPEG, or resized since). `C`: luma of a crop starting on the grid.
 */
export function jpegQuality(C: Float32Array, w: number, h: number): number {
  // (u, v) and the standard luma table's step there (row-major [v·8 + u])
  const pos = [[1, 0], [0, 1], [1, 1], [2, 0]] as const, base = [11, 12, 12, 10];
  const coef: number[][] = pos.map(() => []);
  for (let by = 0; by + 8 <= h; by += 8)
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      // a block with clipped pixels (ringing past black / white) no longer holds the quantised values
      let clipped = false;
      for (let y = 0; y < 8 && !clipped; y++) for (let x = 0; x < 8; x++) if (C[(by + y) * w + bx + x] <= 1 || C[(by + y) * w + bx + x] >= 254) (clipped = true), (x = 8);
      if (clipped) continue;
      pos.forEach(([u, v], j) => {
        let s = 0;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += C[(by + y) * w + bx + x] * DCT8[u * 8 + x] * DCT8[v * 8 + y];
        if (Math.abs(s) >= 1.5) coef[j].push(s);
      });
    }
  const scales: number[] = [];
  coef.forEach((cs, j) => {
    if (cs.length < 30) return;
    // the step whose multiples the coefficients cluster on best (its divisors cluster too, a little less)
    let step = 1, best = 0.75;
    for (let q = 2; q <= 60; q++) {
      // only coefficients at least half a step from 0: small ones sit near a multiple of any large q
      let re = 0, im = 0, n = 0;
      for (const c of cs)
        if (Math.abs(c) >= q / 2) (re += Math.cos((2 * Math.PI * c) / q)), (im += Math.sin((2 * Math.PI * c) / q)), n++;
      const S = n >= 30 ? Math.hypot(re, im) / n : 0;
      if (S > best) (best = S), (step = q);
    }
    scales.push((step / base[j]) * 100);
  });
  if (!scales.length) return 100;
  scales.sort((a, b) => a - b);
  const s = scales[Math.floor(scales.length / 2)];
  if (s < 12) return 100;
  return Math.round(s <= 100 ? (200 - s) / 2 : 5000 / s);
}

/** Photo vs art and the damage, from the features. Thresholds fitted on the labelled set of tests/image/srClassify.test.ts. */
export function decideSr(f: SrFeatures): Omit<SrDecision, "features" | "ms" | "pixelArt"> {
  // art: few colours carry most of the picture, lots of flat area, crisp edges, little soft shading
  const content: SrContent = f.top16 > 0.5 || (f.top16 > 0.4 && f.flat > 0.6) ? "art" : "photo";
  // JPEG: q 90 → 0, q 30 → 1; noise σ 1.5 → 0, σ 6.5 → 1
  const jpeg = Math.max(0, Math.min(1, (90 - f.jpeg) / 60));
  const noisy = Math.max(0, Math.min(1, (f.noise - 1.5) / 5));
  const score = Math.max(jpeg, noisy);
  const denoise = Math.round(Math.max(0.2, score) * 10) / 10;
  const damage = score > 0.75 ? "high" : score > 0.3 ? "mid" : "low";
  return { content, denoise, deblock: jpeg > 0.6, damage };
}

/**
 * Pixel art: at most 48 exact colours, at most 1024 px a side, and where three neighbours in a row all differ the
 * middle one is seldom between the other two (anti-aliased line art, text and downscaled drawings blend there: 0.5–0.95
 * on the test pictures, pixel art ≤ 0.37). Real-ESRGAN smooths pixel art into paint (4×: 16 dB against the
 * nearest-neighbour blocks, the classical method 20 dB), so the dialog suggests the nearest method for it.
 */
export function looksPixelArt(img: Img): boolean {
  const { width: w, height: h, data: d } = img;
  if (Math.max(w, h) > 1024 || w * h < 16) return false;
  const u = d.byteOffset % 4 ? new Uint32Array(d.slice(0, w * h * 4).buffer) : new Uint32Array(d.buffer, d.byteOffset, w * h);
  const cols = new Set<number>();
  for (let i = 0; i < u.length; i++) {
    cols.add(u[i]);
    if (cols.size > 48) return false;
  }
  const L = (i: number) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let tri = 0, between = 0;
  for (let y = 0; y < h; y++)
    for (let x = 1; x + 1 < w; x++) {
      const i = y * w + x;
      if (u[i - 1] === u[i + 1] || u[i] === u[i - 1] || u[i] === u[i + 1]) continue;
      tri++;
      const a = L(i - 1), b = L(i), c = L(i + 1);
      if (b > Math.min(a, c) && b < Math.max(a, c)) between++;
    }
  return between < 0.45 * tri || tri === 0;
}

export function classifySr(img: Img): SrDecision {
  const t0 = performance.now();
  const features = srFeatures(img);
  return { ...decideSr(features), pixelArt: looksPixelArt(img), features, ms: performance.now() - t0 };
}
