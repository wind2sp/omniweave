// Non-AI selections for background removal. Pure, runs in the image worker. Each returns a full-resolution alpha
// (0..255) and, where the method knows the exact background, the un-mixed foreground colours for edge pixels.
//
//  - flatBackground:  graphics / logos — background colour(s) connected to the border removed exactly, anti-aliased
//                     edge pixels un-mixed against the background colour (no blur, no AI).
//  - paperRemoval:    scans / signatures / stamps — local paper colour estimated (ink removed by a max filter), ink
//                     opacity = how much darker than the paper each channel is; ink colour un-mixed from the paper.
//  - chromaKey:       green / blue screen with spill suppression.
//  - studioKey:       product shots — smooth background model fitted to the border (studio sweep gradients), soft key,
//                     optional shadow kept as a separate dark, translucent layer.

import type { Img } from "../pixels";
import { boxMean, clamp01 } from "./refine";

export interface SelectResult {
  alpha: Uint8ClampedArray;
  /** replacement colours (RGB, full res) for pixels whose colour was un-mixed; null = keep the original colours */
  rgb: Uint8ClampedArray | null;
}

type RGB = [number, number, number];

/** Pixels on the outer ring (width ≈ 1% of the short side, at least 1 px). */
export function borderPixels(img: Img): number[] {
  const { width: W, height: H } = img;
  const t = Math.max(1, Math.round(Math.min(W, H) * 0.01));
  const out: number[] = [];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) if (x < t || y < t || x >= W - t || y >= H - t) out.push(y * W + x);
  return out;
}

/** Dominant colours of the border: up to `max` cluster means each covering ≥ minShare of the border. */
export function borderColors(img: Img, max = 3, minShare = 0.08): { color: RGB; share: number }[] {
  const d = img.data;
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>();
  const px = borderPixels(img);
  for (const p of px) {
    const i = p * 4;
    if (d[i + 3] < 128) continue;
    const key = ((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4);
    const e = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    e.n++;
    e.r += d[i];
    e.g += d[i + 1];
    e.b += d[i + 2];
    bins.set(key, e);
  }
  const total = px.length || 1;
  // merge neighbouring bins into the strongest ones
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  const out: { color: RGB; share: number; n: number; s: [number, number, number] }[] = [];
  for (const e of sorted) {
    const c: RGB = [e.r / e.n, e.g / e.n, e.b / e.n];
    const hit = out.find((o) => dist(o.color, c) < 28);
    if (hit) {
      hit.n += e.n;
      hit.s[0] += e.r;
      hit.s[1] += e.g;
      hit.s[2] += e.b;
      hit.color = [hit.s[0] / hit.n, hit.s[1] / hit.n, hit.s[2] / hit.n];
    } else out.push({ color: c, share: 0, n: e.n, s: [e.r, e.g, e.b] });
  }
  return out
    .map((o) => ({ color: o.color, share: o.n / total }))
    .filter((o) => o.share >= minShare)
    .sort((a, b) => b.share - a.share)
    .slice(0, max);
}

export function dist(a: RGB, b: RGB): number {
  // weighted RGB ("redmean") distance — cheap and close enough to ΔE for keying
  const rm = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

export interface InnerRegion {
  /** distinct solid colours around it (rays 1–4 px outward, clustered) */
  colors: number;
  /** inscribed diameter / short side of the bounding box: ≈1 for a round or square counter, small for strokes */
  fat: number;
  /** inscribed diameter in px */
  width: number;
  /** median width (px, ≤ 64) of the surrounding colour, measured straight outward */
  line: number;
}

/** Shape features of an enclosed background-coloured region `px` (see `isCounter`); B = the background colour. */
export function innerRegion(img: Img, px: number[], isBg: Uint8Array, B: RGB): InnerRegion {
  const { width: W, height: H, data: d } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (const p of px) {
    const x = p % W, y = (p - x) / W;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  // local frame with a 1 px margin
  const bw = x1 - x0 + 3, bh = y1 - y0 + 3;
  const inR = new Uint8Array(bw * bh);
  for (const p of px) {
    const x = p % W, y = (p - x) / W;
    inR[(y - y0 + 1) * bw + (x - x0 + 1)] = 1;
  }
  // chamfer distance to the region's outside → inscribed radius
  const D = new Float32Array(bw * bh);
  for (let i = 0; i < D.length; i++) D[i] = inR[i] ? 1e9 : 0;
  const S2 = Math.SQRT2;
  for (let y = 1; y < bh - 1; y++)
    for (let x = 1; x < bw - 1; x++) {
      const i = y * bw + x;
      if (!inR[i]) continue;
      D[i] = Math.min(D[i], D[i - 1] + 1, D[i - bw] + 1, D[i - bw - 1] + S2, D[i - bw + 1] + S2);
    }
  let maxD = 0;
  for (let y = bh - 2; y >= 1; y--)
    for (let x = bw - 2; x >= 1; x--) {
      const i = y * bw + x;
      if (!inR[i]) continue;
      D[i] = Math.min(D[i], D[i + 1] + 1, D[i + bw] + 1, D[i + bw + 1] + S2, D[i + bw - 1] + S2);
      if (D[i] > maxD) maxD = D[i];
    }
  const fat = (2 * maxD) / Math.max(1, Math.min(x1 - x0 + 1, y1 - y0 + 1));
  // colours around: walk outward from each boundary pixel, keep the pixel farthest from the background within 4 px
  const samples: RGB[] = [];
  const runs: number[] = [];
  const own = (x: number, y: number) => x >= x0 - 1 && y >= y0 - 1 && x <= x1 + 1 && y <= y1 + 1 && inR[(y - y0 + 1) * bw + (x - x0 + 1)] === 1;
  for (const p of px) {
    const x = p % W, y = (p - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (own(x + dx, y + dy)) continue;
      let best: RGB | null = null, bd = 0, bk = 0;
      for (let k = 1; k <= 4; k++) {
        const xx = x + dx * k, yy = y + dy * k;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) break;
        const q = yy * W + xx;
        if (isBg[q] || own(xx, yy)) break;
        const c: RGB = [d[q * 4], d[q * 4 + 1], d[q * 4 + 2]];
        const e = dist(c, B);
        if (e > bd) (bd = e), (best = c), (bk = k);
      }
      if (!best || bd <= 30) continue;
      samples.push(best);
      // how far the surrounding colour runs on (a drawn line is thin, a filled area is wide)
      let k = bk;
      while (k < 64) {
        const xx = x + dx * (k + 1), yy = y + dy * (k + 1);
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) break;
        const q = yy * W + xx;
        if (dist([d[q * 4], d[q * 4 + 1], d[q * 4 + 2]], best) > 36) break;
        k++;
      }
      runs.push(k);
    }
  }
  const clusters: { c: RGB; n: number }[] = [];
  for (const c of samples) {
    const hit = clusters.find((k) => dist(k.c, c) < 36);
    if (hit) hit.n++;
    else clusters.push({ c, n: 1 });
  }
  const colors = clusters.filter((k) => k.n >= Math.max(3, samples.length * 0.1)).length;
  runs.sort((a, b) => a - b);
  const line = runs.length ? runs[Math.floor(runs.length / 2)] : 0;
  return { colors, fat, width: 2 * maxD, line };
}

/**
 * Is an enclosed background-coloured region a counter (the hole of an "O", "A", a ring, the gaps of line art —
 * remove it) rather than a filled surface (a document icon's white page, white letters on a badge — keep it)?
 * A surface is at least 12 px wide and either touches two or more solid colours (the page meets the frame and the
 * label band) or sits in a filled area at least as wide as itself while being a stroke (white letters) or much
 * narrower than that area. Counters and the gaps of line art are bounded by one colour drawn as a line or a stroke.
 */
export function isCounter(r: InnerRegion): boolean {
  if (r.width < INNER.minWidth) return true; // slivers between drawn lines
  if (r.colors >= 2) return false;
  if (r.line >= r.width && (r.fat < INNER.fat || r.line >= 2 * r.width)) return false;
  return true;
}
/** Thresholds of `isCounter` (measured on the real-image graphic items and the synthetic bench, MATTE_EVAL.md §7). */
export const INNER = { fat: 0.45, minWidth: 12 };

/** Enclosed background-coloured regions: "auto" = remove counters only (`isCounter`), true = remove all, false = keep all. */
export type InnerHoles = boolean | "auto";

/**
 * Remove flat background colour(s) connected to the border, and enclosed regions of exactly that colour per `holes`
 * (default: all). `keep` / `drop` are pixel indices of user hints: an enclosed region holding one is kept / removed.
 * `tol` is the colour distance treated as background; edge pixels just outside it get a fractional alpha by un-mixing
 * against the background colour and the nearest solid interior colour.
 */
export function flatBackground(img: Img, opts: { tol?: number; holes?: InnerHoles; colors?: RGB[]; keep?: number[]; drop?: number[] } = {}): SelectResult {
  const { width: W, height: H, data: d } = img;
  const N = W * H;
  const tol = opts.tol ?? 10;
  const bgs = opts.colors ?? borderColors(img).map((c) => c.color);
  const alpha = new Uint8ClampedArray(N).fill(255);
  const rgb = new Uint8ClampedArray(N * 3);
  for (let p = 0; p < N; p++) {
    rgb[p * 3] = d[p * 4];
    rgb[p * 3 + 1] = d[p * 4 + 1];
    rgb[p * 3 + 2] = d[p * 4 + 2];
  }
  if (!bgs.length) return { alpha, rgb: null };
  const col = (p: number): RGB => [d[p * 4], d[p * 4 + 1], d[p * 4 + 2]];
  const nearBg = (p: number) => {
    if (d[p * 4 + 3] < 8) return 0; // already transparent counts as background
    const c = col(p);
    let best = Infinity;
    for (const b of bgs) best = Math.min(best, dist(c, b));
    return best;
  };
  const nearestBg = (c: RGB) => bgs.reduce((a, b) => (dist(c, b) < dist(c, a) ? b : a));
  const isBg = new Uint8Array(N);
  const stack: number[] = [];
  const seed = (p: number) => {
    if (!isBg[p] && nearBg(p) <= tol) {
      isBg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) seed(x), seed((H - 1) * W + x);
  for (let y = 0; y < H; y++) seed(y * W), seed(y * W + W - 1);
  while (stack.length) {
    const p = stack.pop()!;
    const x = p % W, y = (p - x) / W;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (y > 0) seed(p - W);
    if (y < H - 1) seed(p + W);
  }
  const holes = opts.holes ?? true;
  if (holes !== false || opts.drop?.length || opts.keep?.length) {
    // enclosed regions of (nearly exactly) the background colour, e.g. the inside of an "O" — or a white page
    const seen = new Uint8Array(N);
    const tight = Math.min(tol, 6);
    const keep = new Set(opts.keep ?? []), drop = new Set(opts.drop ?? []);
    const comps: number[][] = [];
    for (let s = 0; s < N; s++) {
      if (isBg[s] || seen[s] || nearBg(s) > tight) continue;
      const comp: number[] = [s];
      seen[s] = 1;
      for (let k = 0; k < comp.length; k++) {
        const p = comp[k], x = p % W, y = (p - x) / W;
        for (const q of [x > 0 ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y > 0 ? p - W : -1, y < H - 1 ? p + W : -1])
          if (q >= 0 && !seen[q] && !isBg[q] && nearBg(q) <= tight) {
            seen[q] = 1;
            comp.push(q);
          }
      }
      if (comp.length >= 12) comps.push(comp);
    }
    for (const comp of comps) {
      // user hints win; then the option
      let remove: boolean;
      if (comp.some((p) => drop.has(p))) remove = true;
      else if (comp.some((p) => keep.has(p))) remove = false;
      else if (holes === "auto") remove = isCounter(innerRegion(img, comp, isBg, nearestBg(col(comp[0]))));
      else remove = holes;
      if (remove) for (const p of comp) isBg[p] = 1;
    }
  }
  for (let p = 0; p < N; p++) if (isBg[p]) alpha[p] = 0;
  // anti-aliased rim: pixels next to background get alpha by un-mixing P = a·F + (1−a)·B
  for (let p = 0; p < N; p++) {
    if (isBg[p]) continue;
    const x = p % W, y = (p - x) / W;
    let touches = false;
    for (let dy = -1; dy <= 1 && !touches; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && isBg[yy * W + xx]) {
          touches = true;
          break;
        }
      }
    if (!touches) continue;
    const P = col(p);
    let B = bgs[0], bd = Infinity;
    for (const b of bgs) {
      const dd = dist(P, b);
      if (dd < bd) (bd = dd), (B = b);
    }
    // nearest solid foreground colour within 3 px: the pixel farthest from the background
    let F: RGB = P, fd = dist(P, B);
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const q = yy * W + xx;
        if (isBg[q]) continue;
        const c = col(q), dd = dist(c, B);
        if (dd > fd) (fd = dd), (F = c);
      }
    const fr = F[0] - B[0], fg = F[1] - B[1], fb = F[2] - B[2];
    const l2 = fr * fr + fg * fg + fb * fb;
    if (l2 < 1) continue;
    const a = clamp01(((P[0] - B[0]) * fr + (P[1] - B[1]) * fg + (P[2] - B[2]) * fb) / l2);
    alpha[p] = Math.round(a * d[p * 4 + 3]);
    rgb[p * 3] = F[0];
    rgb[p * 3 + 1] = F[1];
    rgb[p * 3 + 2] = F[2];
  }
  return { alpha, rgb };
}

/** Separable max filter over (2r+1)² (paper estimation: removes thin dark ink). */
function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = -Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      out[y * w + x] = m;
    }
  return out;
}

/**
 * Paper removal for scans, signatures and stamps. The paper colour is estimated per channel on a coarse grid (max
 * filter removes the ink, a blur removes the paper texture), so uneven lighting and yellowed paper are handled.
 * Ink alpha = strongest relative darkening over the channels (red stamps and blue pens stay opaque), soft between
 * `lo` and `hi`. Ink colour is un-mixed from the paper colour.
 */
export function paperRemoval(img: Img, opts: { lo?: number; hi?: number } = {}): SelectResult {
  const { width: W, height: H, data: d } = img;
  const lo = opts.lo ?? 0.1, hi = opts.hi ?? 0.42;
  const cell = Math.max(2, Math.round(Math.max(W, H) / 256));
  const gw = Math.ceil(W / cell), gh = Math.ceil(H / cell);
  const paper = [0, 1, 2].map((c) => {
    const g = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        let m = 0;
        for (let y = gy * cell; y < Math.min(H, gy * cell + cell); y++)
          for (let x = gx * cell; x < Math.min(W, gx * cell + cell); x++) m = Math.max(m, d[(y * W + x) * 4 + c]);
        g[gy * gw + gx] = m;
      }
    const r = Math.max(2, Math.round(Math.max(gw, gh) / 40));
    return boxMean(maxFilter(g, gw, gh, r), gw, gh, r);
  });
  const N = W * H;
  const alpha = new Uint8ClampedArray(N);
  const rgb = new Uint8ClampedArray(N * 3);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(gh - 1, Math.floor(y / cell));
    for (let x = 0; x < W; x++) {
      const gx = Math.min(gw - 1, Math.floor(x / cell));
      const p = y * W + x, i = p * 4;
      let dark = 0;
      const P: number[] = [];
      const Pp: number[] = [];
      for (let c = 0; c < 3; c++) {
        const pc = Math.max(1, paper[c][gy * gw + gx]);
        P.push(d[i + c]);
        Pp.push(pc);
        dark = Math.max(dark, 1 - d[i + c] / pc);
      }
      const a = clamp01((dark - lo) / (hi - lo));
      alpha[p] = Math.round(a * d[i + 3]);
      for (let c = 0; c < 3; c++) {
        // un-mix: P = a·F + (1−a)·paper → F; weak ink keeps its hue but not the paper tint
        const f = a > 0.02 ? (P[c] - (1 - a) * Pp[c]) / a : P[c];
        rgb[p * 3 + c] = Math.max(0, Math.min(255, f));
      }
    }
  }
  return { alpha, rgb };
}

/** Which screen colour dominates the border, if any. */
export function chromaScreen(img: Img): "green" | "blue" | null {
  const d = img.data;
  let g = 0, b = 0, n = 0;
  for (const p of borderPixels(img)) {
    const i = p * 4, R = d[i], G = d[i + 1], B = d[i + 2];
    n++;
    if (G > 60 && G - Math.max(R, B) > 0.25 * G) g++;
    else if (B > 60 && B - Math.max(R, G) > 0.25 * B) b++;
  }
  if (!n) return null;
  if (g / n > 0.6) return "green";
  if (b / n > 0.6) return "blue";
  return null;
}

/**
 * Chroma key: alpha from the screen-colour excess (G − max(R, B) for green), normalised by the key's own excess;
 * spill suppression clamps the screen channel to the other two on kept pixels.
 */
export function chromaKey(img: Img, screen: "green" | "blue", opts: { spill?: number } = {}): SelectResult {
  const { width: W, height: H, data: d } = img;
  const N = W * H;
  const k = screen === "green" ? 1 : 2;
  const o1 = screen === "green" ? 0 : 0, o2 = screen === "green" ? 2 : 1;
  // key strength from the border
  const ex: number[] = [];
  for (const p of borderPixels(img)) {
    const i = p * 4;
    ex.push(d[i + k] - Math.max(d[i + o1], d[i + o2]));
  }
  ex.sort((a, b) => a - b);
  const keyEx = Math.max(30, ex[Math.floor(ex.length * 0.5)] ?? 100);
  const t0 = keyEx * 0.25, t1 = keyEx * 0.75;
  const spill = (opts.spill ?? 100) / 100;
  const alpha = new Uint8ClampedArray(N);
  const rgb = new Uint8ClampedArray(N * 3);
  for (let p = 0; p < N; p++) {
    const i = p * 4;
    const e = d[i + k] - Math.max(d[i + o1], d[i + o2]);
    const a = 1 - clamp01((e - t0) / (t1 - t0));
    alpha[p] = Math.round(a * d[i + 3]);
    const r = [d[i], d[i + 1], d[i + 2]];
    const lim = screen === "green" ? (r[0] + r[2]) / 2 : (r[0] + r[1]) / 2;
    if (r[k] > lim) r[k] = r[k] - (r[k] - lim) * spill;
    rgb[p * 3] = r[0];
    rgb[p * 3 + 1] = r[1];
    rgb[p * 3 + 2] = r[2];
  }
  return { alpha, rgb };
}

/** Fit c(x, y) = k0 + k1·x + k2·y + k3·x² + k4·y² + k5·xy to samples (least squares, normal equations). */
function fitQuadric(xs: number[], ys: number[], vs: number[], ws?: number[]): number[] {
  const M = Array.from({ length: 6 }, () => new Array(7).fill(0));
  for (let s = 0; s < xs.length; s++) {
    const x = xs[s], y = ys[s], w = ws ? ws[s] : 1;
    const f = [1, x, y, x * x, y * y, x * y];
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 6; j++) M[i][j] += w * f[i] * f[j];
      M[i][6] += w * f[i] * vs[s];
    }
  }
  for (let i = 0; i < 6; i++) M[i][i] += 1e-6;
  for (let c = 0; c < 6; c++) {
    let piv = c;
    for (let r = c + 1; r < 6; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const div = M[c][c] || 1e-9;
    for (let j = c; j < 7; j++) M[c][j] /= div;
    for (let r = 0; r < 6; r++) {
      if (r === c) continue;
      const f = M[r][c];
      for (let j = c; j < 7; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r) => r[6]);
}

/** Smooth background model fitted to the border ring (robust: two passes, outliers down-weighted). */
export function borderModel(img: Img): (x: number, y: number) => RGB {
  const { width: W, height: H, data: d } = img;
  const px = borderPixels(img);
  const step = Math.max(1, Math.floor(px.length / 4000));
  const xs: number[] = [], ys: number[] = [], cs: number[][] = [[], [], []];
  for (let k = 0; k < px.length; k += step) {
    const p = px[k], x = p % W, y = (p - x) / W;
    xs.push(x / W - 0.5);
    ys.push(y / H - 0.5);
    for (let c = 0; c < 3; c++) cs[c].push(d[p * 4 + c]);
  }
  let coef = cs.map((v) => fitQuadric(xs, ys, v));
  const ev = (k: number[], x: number, y: number) => k[0] + k[1] * x + k[2] * y + k[3] * x * x + k[4] * y * y + k[5] * x * y;
  const ws = xs.map((x, s) => {
    const e = Math.hypot(...[0, 1, 2].map((c) => cs[c][s] - ev(coef[c], x, ys[s])));
    return 1 / (1 + (e / 12) ** 2);
  });
  coef = cs.map((v) => fitQuadric(xs, ys, v, ws));
  return (x, y) => {
    const u = x / W - 0.5, v = y / H - 0.5;
    return [ev(coef[0], u, v), ev(coef[1], u, v), ev(coef[2], u, v)];
  };
}

/**
 * Studio / plain background key. Distance to the fitted background → soft alpha, kept only where connected to the
 * border through background-ish pixels (so foreground parts coloured like the background stay). Shadows (the same
 * chroma, only darker) count as background, or become a translucent black layer with `keepShadow`.
 */
export function studioKey(img: Img, opts: { t0?: number; t1?: number; keepShadow?: boolean } = {}): SelectResult & { key: Float32Array } {
  const { width: W, height: H, data: d } = img;
  const N = W * H;
  const model = borderModel(img);
  const t0 = opts.t0 ?? 10, t1 = opts.t1 ?? 34;
  const key = new Float32Array(N); // 0 = background, 1 = foreground (by colour only)
  const shadow = new Float32Array(N);
  // the model is smooth: evaluate it on a coarse grid and interpolate (12 MP stays cheap)
  const GW = Math.min(W, 96), GH = Math.min(H, 96);
  const grid = new Float32Array(GW * GH * 3);
  for (let gy = 0; gy < GH; gy++)
    for (let gx = 0; gx < GW; gx++) {
      const c = model(((gx + 0.5) * W) / GW, ((gy + 0.5) * H) / GH);
      grid.set(c, (gy * GW + gx) * 3);
    }
  const dd = (r: number, g: number, b: number, R: number, G: number, B: number) => {
    const rm = (r + R) / 2, dr = r - R, dg = g - G, db = b - B;
    return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
  };
  for (let y = 0; y < H; y++) {
    let fy = ((y + 0.5) * GH) / H - 0.5;
    if (fy < 0) fy = 0;
    const y0 = Math.min(GH - 1, Math.floor(fy)), y1 = Math.min(GH - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      let fx = ((x + 0.5) * GW) / W - 0.5;
      if (fx < 0) fx = 0;
      const x0 = Math.min(GW - 1, Math.floor(fx)), x1 = Math.min(GW - 1, x0 + 1), tx = fx - x0;
      const a = (y0 * GW + x0) * 3, b = (y0 * GW + x1) * 3, c = (y1 * GW + x0) * 3, e = (y1 * GW + x1) * 3;
      const w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      const BR = grid[a] * w00 + grid[b] * w01 + grid[c] * w10 + grid[e] * w11;
      const BG = grid[a + 1] * w00 + grid[b + 1] * w01 + grid[c + 1] * w10 + grid[e + 1] * w11;
      const BB = grid[a + 2] * w00 + grid[b + 2] * w01 + grid[c + 2] * w10 + grid[e + 2] * w11;
      const p = y * W + x, i = p * 4;
      const Pr = d[i], Pg = d[i + 1], Pb = d[i + 2];
      let D = dd(Pr, Pg, Pb, BR, BG, BB);
      // shadow test: uniformly darker with the same chroma
      const lb = BR + BG + BB, lp = Pr + Pg + Pb;
      if (lp < lb && lb > 30) {
        const s = lp / lb;
        const chromaD = s > 0 ? dd(Pr / s, Pg / s, Pb / s, BR, BG, BB) : Infinity;
        if (chromaD < t0 * 1.5 && s > 0.25) {
          shadow[p] = 1 - s;
          D = chromaD;
        }
      }
      key[p] = clamp01((D - t0) / (t1 - t0));
    }
  }
  // background = key < 0.5 connected to the border
  const isBg = new Uint8Array(N);
  const st: number[] = [];
  const seed = (p: number) => {
    if (!isBg[p] && key[p] < 0.5) {
      isBg[p] = 1;
      st.push(p);
    }
  };
  for (let x = 0; x < W; x++) seed(x), seed((H - 1) * W + x);
  for (let y = 0; y < H; y++) seed(y * W), seed(y * W + W - 1);
  while (st.length) {
    const p = st.pop()!;
    const x = p % W, y = (p - x) / W;
    if (x > 0) seed(p - 1);
    if (x < W - 1) seed(p + 1);
    if (y > 0) seed(p - W);
    if (y < H - 1) seed(p + W);
  }
  const alpha = new Uint8ClampedArray(N);
  let rgb: Uint8ClampedArray | null = null;
  if (opts.keepShadow) rgb = new Uint8ClampedArray(N * 3);
  for (let p = 0; p < N; p++) {
    // inside the subject (not reachable from the border) stays opaque even when coloured like the background;
    // its rim (next to background) keeps the soft key value for anti-aliasing
    let a = 1;
    if (isBg[p]) a = key[p];
    else {
      const x = p % W;
      if ((x > 0 && isBg[p - 1]) || (x < W - 1 && isBg[p + 1]) || (p >= W && isBg[p - W]) || (p + W < N && isBg[p + W])) a = key[p];
    }
    if (opts.keepShadow && isBg[p] && shadow[p] > 0.04 && a < 0.5) {
      a = Math.max(a, shadow[p]);
      rgb![p * 3] = rgb![p * 3 + 1] = rgb![p * 3 + 2] = 0;
    } else if (rgb) {
      rgb[p * 3] = d[p * 4];
      rgb[p * 3 + 1] = d[p * 4 + 1];
      rgb[p * 3 + 2] = d[p * 4 + 2];
    }
    alpha[p] = Math.round(a * d[p * 4 + 3]);
  }
  return { alpha, rgb, key };
}
