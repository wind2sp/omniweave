// SSIM (structural similarity, Wang et al. 2004) and a difference heat map — no dependencies,
// shared by the Node tests and the browser screen harness (tests/fidelity/screen.ts).
//
// Both images are compared on luma (Rec. 601) in 8×8 windows with a stride of 4, the usual
// "fast SSIM" layout. Constants follow the paper: K1 = 0.01, K2 = 0.03, L = 255.

export interface Gray {
  w: number;
  h: number;
  /** luma 0..255, row-major */
  y: Float32Array;
}

export interface SsimResult {
  /** mean SSIM over all windows, 1 = identical */
  ssim: number;
  /** windows with SSIM < 0.9 (share 0..1) — "visibly different" area */
  badShare: number;
  /** per-window SSIM, gw × gh */
  map: Float32Array;
  gw: number;
  gh: number;
  win: number;
  stride: number;
}

/** RGBA (straight alpha) → luma, composited over white so transparent areas compare as paper. */
export function toGray(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Gray {
  const y = new Float32Array(w * h);
  for (let i = 0, p = 0; p < y.length; i += 4, p++) {
    const a = rgba[i + 3] / 255;
    const r = rgba[i] * a + 255 * (1 - a), g = rgba[i + 1] * a + 255 * (1 - a), b = rgba[i + 2] * a + 255 * (1 - a);
    y[p] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { w, h, y };
}

/** Box-filter resample (area average when shrinking, nearest when growing) to an exact size. */
export function resizeGray(src: Gray, w: number, h: number): Gray {
  if (src.w === w && src.h === h) return src;
  const out = new Float32Array(w * h);
  const sx = src.w / w, sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = Math.max(y0 + 1e-6, (y + 1) * sy);
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = Math.max(x0 + 1e-6, (x + 1) * sx);
      let sum = 0, area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1) && yy < src.h; yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1) && xx < src.w; xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          sum += src.y[yy * src.w + xx] * wx * wy;
          area += wx * wy;
        }
      }
      out[y * w + x] = area ? sum / area : 255;
    }
  }
  return { w, h, y: out };
}

/** SSIM of two equally sized gray images. */
export function ssim(a: Gray, b: Gray, win = 8, stride = 4): SsimResult {
  if (a.w !== b.w || a.h !== b.h) throw new Error(`SSIM: 크기가 다릅니다 ${a.w}×${a.h} / ${b.w}×${b.h}`);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const w = a.w, h = a.h;
  const ww = Math.min(win, w), wh = Math.min(win, h);
  const gw = Math.max(1, Math.floor((w - ww) / stride) + 1), gh = Math.max(1, Math.floor((h - wh) / stride) + 1);
  const map = new Float32Array(gw * gh);
  const n = ww * wh;
  let total = 0, bad = 0;
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gx * stride, y0 = gy * stride;
      let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
      for (let y = y0; y < y0 + wh; y++) {
        let i = y * w + x0;
        for (let x = 0; x < ww; x++, i++) {
          const va = a.y[i], vb = b.y[i];
          sa += va;
          sb += vb;
          saa += va * va;
          sbb += vb * vb;
          sab += va * vb;
        }
      }
      const ma = sa / n, mb = sb / n;
      const va = Math.max(0, saa / n - ma * ma), vb = Math.max(0, sbb / n - mb * mb), cov = sab / n - ma * mb;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      map[gy * gw + gx] = s;
      total += s;
      if (s < 0.9) bad++;
    }
  return { ssim: total / map.length, badShare: bad / map.length, map, gw, gh, win: ww, stride };
}

/** Fit (w, h) inside a box of `max` pixels on the longer side (never enlarges). */
export function fitSize(w: number, h: number, max: number): { w: number; h: number } {
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Heat map RGBA: the reference in faded gray, windows tinted from yellow (SSIM 0.9) to red
 * (SSIM ≤ 0.5). Areas that match are left untinted, so the picture shows *where* it differs.
 */
export function heatmap(ref: Gray, r: SsimResult): Uint8ClampedArray {
  const { w, h } = ref;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const g = 160 + ref.y[i] * 0.37;
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = g;
    out[i * 4 + 3] = 255;
  }
  // worst window covering each pixel
  const worst = new Float32Array(w * h).fill(1);
  for (let gy = 0; gy < r.gh; gy++)
    for (let gx = 0; gx < r.gw; gx++) {
      const s = r.map[gy * r.gw + gx];
      if (s >= 0.9) continue;
      for (let y = gy * r.stride; y < Math.min(h, gy * r.stride + r.win); y++)
        for (let x = gx * r.stride; x < Math.min(w, gx * r.stride + r.win); x++) if (s < worst[y * w + x]) worst[y * w + x] = s;
    }
  for (let i = 0; i < w * h; i++) {
    const s = worst[i];
    if (s >= 0.9) continue;
    const t = Math.min(1, (0.9 - s) / 0.4); // 0 = yellow, 1 = red
    const a = 0.55 + 0.4 * t;
    const g0 = out[i * 4];
    out[i * 4] = g0 * (1 - a) + 255 * a;
    out[i * 4 + 1] = g0 * (1 - a) + 220 * (1 - t) * a;
    out[i * 4 + 2] = g0 * (1 - a);
  }
  return out;
}
