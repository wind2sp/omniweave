// Scan picture work for the phone app (docs/MOBILE_PLAN.md §1.2 "스캔"), plain TypeScript on pixel arrays — no
// library, no model: finding the paper's corners, straightening it (perspective), colour / grey / black-and-white.

export type Pt = { x: number; y: number };
/** corners in picture pixels: top-left, top-right, bottom-right, bottom-left */
export type Quad = [Pt, Pt, Pt, Pt];

export function defaultQuad(w: number, h: number, inset = 0.06): Quad {
  const dx = w * inset, dy = h * inset;
  return [
    { x: dx, y: dy },
    { x: w - dx, y: dy },
    { x: w - dx, y: h - dy },
    { x: dx, y: h - dy },
  ];
}

/** luminance 0–255 of RGBA pixels */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Uint8Array {
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return g;
}

/** Otsu's threshold of a grey picture */
export function otsu(g: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, at = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = g.length - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) (best = v), (at = t);
  }
  return at;
}

/**
 * The paper's corners in a small grey picture (≈ 300–500 px): the largest bright region (Otsu) that does not fill the
 * whole frame, its extreme points along the diagonals. Null when no clear sheet stands out (the caller then offers
 * the default frame to adjust by hand).
 */
export function detectQuad(g: Uint8Array, w: number, h: number): Quad | null {
  // light blur (3×3 box) so paper texture and text do not break the region
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++)
        for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) (s += g[yy * w + xx]), n++;
      b[y * w + x] = s / n;
    }
  const t = otsu(b);
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < b.length; i++) bright[i] = b[i] > t ? 1 : 0;
  // largest 4-connected bright region
  const label = new Int32Array(w * h);
  let bestId = 0, bestSize = 0, id = 0;
  const stack: number[] = [];
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || label[i]) continue;
    id++;
    let size = 0;
    stack.push(i);
    label[i] = id;
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p / w) | 0;
      if (x > 0 && bright[p - 1] && !label[p - 1]) (label[p - 1] = id), stack.push(p - 1);
      if (x < w - 1 && bright[p + 1] && !label[p + 1]) (label[p + 1] = id), stack.push(p + 1);
      if (y > 0 && bright[p - w] && !label[p - w]) (label[p - w] = id), stack.push(p - w);
      if (y < h - 1 && bright[p + w] && !label[p + w]) (label[p + w] = id), stack.push(p + w);
    }
    if (size > bestSize) (bestSize = size), (bestId = id);
  }
  if (!bestId || bestSize < w * h * 0.12 || bestSize > w * h * 0.97) return null;
  let tl = { s: Infinity, p: { x: 0, y: 0 } }, br = { s: -Infinity, p: { x: 0, y: 0 } };
  let tr = { s: -Infinity, p: { x: 0, y: 0 } }, bl = { s: Infinity, p: { x: 0, y: 0 } };
  let touches = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== bestId) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
      const s = x + y, d = x - y;
      if (s < tl.s) tl = { s, p: { x, y } };
      if (s > br.s) br = { s, p: { x, y } };
      if (d > tr.s) tr = { s: d, p: { x, y } };
      if (d < bl.s) bl = { s: d, p: { x, y } };
    }
  // a region running along most of the frame's edge is the background, not a sheet on it
  if (touches > (w + h) * 0.9) return null;
  const q: Quad = [tl.p, tr.p, br.p, bl.p];
  return quadArea(q) > w * h * 0.1 ? q : null;
}

export function quadArea(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const p = q[i], n = q[(i + 1) % 4];
    a += p.x * n.y - n.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Homography that maps the unit square's corners (0,0) (1,0) (1,1) (0,1) to `q` (3×3, row-major, h33 = 1). */
export function squareToQuad(q: Quad): number[] {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (dx3 !== 0 || dy3 !== 0) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1];
}

/** Output size for a quad: the longer of each pair of opposite edges, capped at `maxSide` on the long side. */
export function quadSize(q: Quad, maxSide: number): { w: number; h: number } {
  const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  let w = Math.max(d(q[0], q[1]), d(q[3], q[2]));
  let h = Math.max(d(q[0], q[3]), d(q[1], q[2]));
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** The quad's contents straightened into a w × h RGBA picture (bilinear sampling). */
export function warp(src: Uint8ClampedArray, sw: number, sh: number, q: Quad, w: number, h: number): Uint8ClampedArray {
  const m = squareToQuad(q);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const z = m[6] * u + m[7] * v + 1;
      let sx = (m[0] * u + m[1] * v + m[2]) / z - 0.5;
      let sy = (m[3] * u + m[4] * v + m[5]) / z - 0.5;
      sx = Math.min(sw - 1.001, Math.max(0, sx));
      sy = Math.min(sh - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, fx = sx - x0, fy = sy - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
        const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
        out[o + c] = top + (bot - top) * fy;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}

export type ScanMode = "color" | "gray" | "bw";

/**
 * Clean up a straightened page in place: "color" stretches each channel's 1–99 % range (paper whiter, ink darker),
 * "gray" the same on luminance, "bw" thresholds against the local mean (shadows and uneven light do not blacken
 * whole areas — the way scanner apps make black-and-white pages).
 */
export function enhance(px: Uint8ClampedArray, w: number, h: number, mode: ScanMode): void {
  const n = w * h;
  if (mode === "color") {
    for (let c = 0; c < 3; c++) {
      const hist = new Uint32Array(256);
      for (let i = c; i < px.length; i += 4) hist[px[i]]++;
      const [lo, hi] = range(hist, n);
      const k = 255 / Math.max(1, hi - lo);
      for (let i = c; i < px.length; i += 4) px[i] = (px[i] - lo) * k;
    }
    return;
  }
  const g = toGray(px, w, h);
  if (mode === "gray") {
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) hist[g[i]]++;
    const [lo, hi] = range(hist, n);
    const k = 255 / Math.max(1, hi - lo);
    for (let i = 0, j = 0; i < n; i++, j += 4) px[j] = px[j + 1] = px[j + 2] = (g[i] - lo) * k;
    return;
  }
  // integral image → mean over a window of about 1/16 of the page width
  const W = w + 1;
  const sum = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += g[y * w + x];
      sum[(y + 1) * W + x + 1] = sum[y * W + x + 1] + row;
    }
  }
  const r = Math.max(6, Math.round(Math.max(w, h) / 32));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const area = (y1 - y0) * (x1 - x0);
      const mean = (sum[y1 * W + x1] - sum[y0 * W + x1] - sum[y1 * W + x0] + sum[y0 * W + x0]) / area;
      const v = g[y * w + x] < mean * 0.86 && g[y * w + x] < 225 ? 0 : 255;
      const j = (y * w + x) * 4;
      px[j] = px[j + 1] = px[j + 2] = v;
    }
  }
}

function range(hist: Uint32Array, n: number): [number, number] {
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) if ((acc += hist[i]) > n * 0.01) {
    lo = i;
    break;
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) if ((acc += hist[i]) > n * 0.01) {
    hi = i;
    break;
  }
  return hi - lo < 40 ? [0, 255] : [lo, hi];
}

/** Quarter turns clockwise of an RGBA picture. */
export function rotate90(px: Uint8ClampedArray, w: number, h: number): { px: Uint8ClampedArray; w: number; h: number } {
  const out = new Uint8ClampedArray(px.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, d = (x * h + (h - 1 - y)) * 4;
      out[d] = px[s];
      out[d + 1] = px[s + 1];
      out[d + 2] = px[s + 2];
      out[d + 3] = px[s + 3];
    }
  return { px: out, w: h, h: w };
}
