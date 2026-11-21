// OCR — classical (non-AI) page preprocessing: grey levels, Sauvola binarisation, skew estimate from projection
// profiles, rotation. All our own code; used before detection (deskew) and by the layout pass (ruling lines,
// check boxes, stroke width).

import type { Img } from "../pixels";

/** Luma 0..255 per pixel (transparent → white). */
export function grey(img: Img): Uint8Array {
  const n = img.width * img.height, g = new Uint8Array(n), d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    g[i] = Math.round((d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) * a + 255 * (1 - a));
  }
  return g;
}

/**
 * Sauvola binarisation (Sauvola & Pietikäinen 2000): threshold T = m·(1 + k·(s/R − 1)) over a w×w window, with
 * integral images of the sum and the squared sum (O(1) per pixel). Returns 1 = ink.
 */
export function sauvola(g: Uint8Array, W: number, H: number, win = 31, k = 0.2, R = 128): Uint8Array {
  const S = new Float64Array((W + 1) * (H + 1)), Q = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let rs = 0, rq = 0;
    for (let x = 0; x < W; x++) {
      const v = g[y * W + x];
      rs += v;
      rq += v * v;
      S[(y + 1) * (W + 1) + x + 1] = S[y * (W + 1) + x + 1] + rs;
      Q[(y + 1) * (W + 1) + x + 1] = Q[y * (W + 1) + x + 1] + rq;
    }
  }
  const out = new Uint8Array(W * H), r = win >> 1;
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(W, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const a = (y1 * (W + 1) + x1), b = (y0 * (W + 1) + x1), c = (y1 * (W + 1) + x0), d = (y0 * (W + 1) + x0);
      const m = (S[a] - S[b] - S[c] + S[d]) / n;
      const v = Math.max(0, (Q[a] - Q[b] - Q[c] + Q[d]) / n - m * m);
      const t = m * (1 + k * (Math.sqrt(v) / R - 1));
      // flat light areas (noise on paper) stay paper
      out[y * W + x] = g[y * W + x] < t && g[y * W + x] < 200 ? 1 : 0;
    }
  }
  return out;
}

/**
 * Skew angle (degrees; text lines run along y = x·tan(angle) in y-down image space, so positive = falling to the right) from
 * the projection profile: text lines give the sharpest row histogram when they are horizontal. Coarse 0.5° scan,
 * then 0.05° refinement. Works on a ≤ 900 px copy of the ink map.
 */
export function estimateSkew(ink: Uint8Array, W: number, H: number, maxDeg = 8): number {
  const sc = Math.min(1, 900 / Math.max(W, H));
  const w = Math.max(1, Math.round(W * sc)), h = Math.max(1, Math.round(H * sc));
  const pts: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.min(W - 1, Math.floor(x / sc)), sy = Math.min(H - 1, Math.floor(y / sc));
      if (ink[sy * W + sx]) pts.push(x - w / 2, y - h / 2);
    }
  if (pts.length < 50) return 0;
  const diag = Math.ceil(Math.hypot(w, h));
  const bins = new Float64Array(diag * 2 + 2);
  const score = (deg: number) => {
    const t = (deg * Math.PI) / 180, s = Math.sin(t), c = Math.cos(t);
    bins.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      // y' of the point in a frame rotated by −deg
      const yy = Math.round(-pts[i] * s + pts[i + 1] * c) + diag;
      bins[yy]++;
    }
    let e = 0;
    for (let i = 1; i < bins.length; i++) e += (bins[i] - bins[i - 1]) ** 2;
    return e;
  };
  let best = 0, bs = -1;
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += 0.5) {
    const s = score(a);
    if (s > bs) [bs, best] = [s, a];
  }
  const c0 = best;
  for (let a = c0 - 0.5; a <= c0 + 0.5 + 1e-9; a += 0.05) {
    const s = score(a);
    if (s > bs) [bs, best] = [s, a];
  }
  return Math.round(best * 100) / 100;
}

/** Rotate about the centre so that lines running at `deg` (y-down, estimateSkew's angle) become horizontal. Same size, white fill. */
export function rotateImg(img: Img, deg: number): Img {
  if (Math.abs(deg) < 0.01) return img;
  const { width: W, height: H, data: s } = img;
  const out = new Uint8ClampedArray(W * H * 4).fill(255);
  const t = (deg * Math.PI) / 180, c = Math.cos(t), sn = Math.sin(t);
  const cx = W / 2, cy = H / 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // inverse map: source = R(deg)·(dest − centre) + centre — a source line at `deg` lands horizontal
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const sx = c * dx - sn * dy + cx - 0.5, sy = sn * dx + c * dy + cy - 0.5;
      const x0 = Math.floor(sx), y0 = Math.floor(sy);
      if (x0 < -1 || y0 < -1 || x0 >= W || y0 >= H) continue;
      const fx = sx - x0, fy = sy - y0;
      const o = (y * W + x) * 4;
      if (x0 >= 0 && y0 >= 0 && x0 + 1 < W && y0 + 1 < H) {
        // inside: the four neighbours without bounds checks (same arithmetic as the edge case below)
        const i00 = (y0 * W + x0) * 4, i01 = i00 + W * 4;
        for (let ch = 0; ch < 4; ch++)
          out[o + ch] = (s[i00 + ch] * (1 - fx) + s[i00 + 4 + ch] * fx) * (1 - fy) + (s[i01 + ch] * (1 - fx) + s[i01 + 4 + ch] * fx) * fy;
        continue;
      }
      for (let ch = 0; ch < 4; ch++) {
        const p = (xx: number, yy: number) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 255 : s[(yy * W + xx) * 4 + ch]);
        const v = (p(x0, y0) * (1 - fx) + p(x0 + 1, y0) * fx) * (1 - fy) + (p(x0, y0 + 1) * (1 - fx) + p(x0 + 1, y0 + 1) * fx) * fy;
        out[o + ch] = v;
      }
    }
  return { width: W, height: H, data: out };
}

/** Deskew: estimate on the Sauvola ink map and rotate the page straight. */
export function deskew(img: Img, maxDeg = 8): { img: Img; angle: number } {
  const g = grey(img);
  const ink = sauvola(g, img.width, img.height);
  const angle = estimateSkew(ink, img.width, img.height, maxDeg);
  // `angle` is the rotation actually applied (callers map positions back through it): 0 below the threshold
  const rotated = Math.abs(angle) >= 0.1;
  return { img: rotated ? rotateImg(img, angle) : img, angle: rotated ? angle : 0 };
}
