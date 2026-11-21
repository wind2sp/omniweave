// Image Trace — bitmap → editable vector paths (Illustrator "Image Trace" class), Omniweave's own engine.
//
// Pipeline (every stage is a published, textbook algorithm; no code from potrace (GPL) or any other tracer):
//  1. Quantise   — black & white: luma threshold. Colour: median cut (P. Heckbert, "Color Image Quantization for
//                  Frame Buffer Display", SIGGRAPH 1982) seeds k-means (Lloyd 1957/1982) on a pixel sample.
//  2. Despeckle  — 4-connected components smaller than "noise" px are merged into their dominant neighbour.
//  3. Layers     — "stack": colours ordered by area, each layer's mask = itself + everything above it, so shapes
//                  overlap and no hairline seams appear between colours. "abut": each colour traced on its own.
//  4. Contours   — marching squares (Lorensen & Cline 1987, 2-D case) on pixel centres; saddles resolved as
//                  connected foreground (8-connectivity). Contours run along pixel edges with ½-px chamfered corners,
//                  outer boundaries and holes come out with opposite orientation.
//  5. Corners    — Ramer–Douglas–Peucker (Ramer 1972; Douglas & Peucker 1973) on each closed loop; an RDP vertex
//                  whose turning angle exceeds "corner angle" becomes a sharp anchor.
//  6. Curves     — between corners, least-squares cubic Bézier fitting with Newton–Raphson reparameterisation and
//                  recursive splitting (P. J. Schneider, "An Algorithm for Automatically Fitting Digitized Curves",
//                  Graphics Gems, 1990). Runs that stay within tolerance of their chord become straight lines.
// The result is plain VectorNode contours (absolute handles), so it is editable with the pen / direct-select tools.

import type { Contour, Vec2, VectorAnchor } from "../types";
import { gaussianBlur } from "./filters";
import { luma, type Img } from "./pixels";

export interface TraceOptions {
  mode: "bw" | "color";
  /** bw: pixels with luma below this are ink (0..255) */
  threshold: number;
  /** colour: number of colours (2..64) */
  colors: number;
  /** regions smaller than this many pixels are ignored (merged into neighbours) */
  minArea: number;
  /** turning angle (degrees) above which an anchor is a sharp corner */
  cornerAngle: number;
  /** curve-fit tolerance in px — smaller follows the bitmap more closely (more anchors) */
  precision: number;
  /** fit Bézier curves (false → straight-line polygons) */
  curves: boolean;
  /** colour: drop near-white regions (they become holes) */
  ignoreWhite: boolean;
  method: "stack" | "abut";
  /** pixels with alpha below this are background */
  alphaCutoff: number;
  /** paint as filled shapes (true) or outlines only (false) */
  fill: boolean;
  /** Gaussian pre-smoothing (σ px) before quantising — calms photo noise so regions stay large; 0 = off */
  smooth: number;
}

export const DEFAULT_TRACE: TraceOptions = {
  mode: "bw",
  threshold: 128,
  colors: 6,
  minArea: 8,
  cornerAngle: 60,
  precision: 1,
  curves: true,
  ignoreWhite: false,
  method: "stack",
  alphaCutoff: 128,
  fill: true,
  smooth: 0,
};

export interface TracePreset {
  id: string;
  label: string;
  hint: string;
  options: Partial<TraceOptions>;
}

export const TRACE_PRESETS: TracePreset[] = [
  { id: "logo", label: "흑백 로고", hint: "선명한 흑백 도형 — 어두운 부분만 검정 패스로", options: { mode: "bw", threshold: 128, minArea: 8, precision: 1, cornerAngle: 60, curves: true, fill: true } }, // i18n: ui
  { id: "outline", label: "윤곽선", hint: "채우기 없이 경계만 선으로", options: { mode: "bw", threshold: 128, minArea: 8, precision: 1, cornerAngle: 60, curves: true, fill: false } }, // i18n: ui
  { id: "color3", label: "색상 3", hint: "단순한 3색 그림", options: { mode: "color", colors: 3, minArea: 12, precision: 1.2, cornerAngle: 60, method: "stack" } }, // i18n: ui
  { id: "color6", label: "색상 6", hint: "일러스트·아이콘", options: { mode: "color", colors: 6, minArea: 10, precision: 1, cornerAngle: 60, method: "stack" } }, // i18n: ui
  { id: "color16", label: "색상 16", hint: "색이 많은 그림", options: { mode: "color", colors: 16, minArea: 8, precision: 1, cornerAngle: 60, method: "stack" } }, // i18n: ui
  { id: "photo", label: "사진(고충실)", hint: "사진을 32색 패스로 — 패스가 많아 무거움", options: { mode: "color", colors: 32, minArea: 24, precision: 1, cornerAngle: 75, method: "stack", smooth: 1.5 } }, // i18n: ui
];

export function presetOptions(id: string): TraceOptions {
  const p = TRACE_PRESETS.find((x) => x.id === id);
  return { ...DEFAULT_TRACE, ...(p?.options ?? {}) };
}

export interface TraceLayer {
  /** "#rrggbb" */
  color: string;
  contours: Contour[];
  /** pixels in this colour region (before stacking) */
  area: number;
}

export interface TraceResult {
  width: number;
  height: number;
  /** bottom → top */
  layers: TraceLayer[];
  paths: number;
  anchors: number;
}

// ───────── 1. quantisation ─────────

const BG = 255;

interface Quant {
  labels: Uint8Array;
  palette: [number, number, number][];
}

function quantizeBW(img: Img, o: TraceOptions): Quant {
  const { data: d } = img;
  const labels = new Uint8Array(img.width * img.height);
  for (let i = 0, j = 0; j < labels.length; i += 4, j++) labels[j] = d[i + 3] >= o.alphaCutoff && luma(d[i], d[i + 1], d[i + 2]) < o.threshold ? 0 : BG;
  return { labels, palette: [[0, 0, 0]] };
}

type Box = { pts: number[]; };

/** Median cut on a list of packed RGB samples → up to k centroids. */
function medianCut(samples: Int32Array, k: number): [number, number, number][] {
  let boxes: Box[] = [{ pts: Array.from(samples) }];
  const range = (b: Box) => {
    let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0;
    for (const p of b.pts) {
      const r = p >> 16, g = (p >> 8) & 255, bl = p & 255;
      if (r < r0) r0 = r; if (r > r1) r1 = r;
      if (g < g0) g0 = g; if (g > g1) g1 = g;
      if (bl < b0) b0 = bl; if (bl > b1) b1 = bl;
    }
    const rr = r1 - r0, gr = g1 - g0, br = b1 - b0;
    return rr >= gr && rr >= br ? { ch: 16, span: rr } : gr >= br ? { ch: 8, span: gr } : { ch: 0, span: br };
  };
  while (boxes.length < k) {
    let best = -1, bestScore = 0, bestCh = 0;
    boxes.forEach((b, i) => {
      const { ch, span } = range(b);
      const score = span * Math.sqrt(b.pts.length);
      if (span > 0 && b.pts.length > 1 && score > bestScore) {
        bestScore = score;
        best = i;
        bestCh = ch;
      }
    });
    if (best < 0) break;
    const b = boxes[best];
    b.pts.sort((x, y) => ((x >> bestCh) & 255) - ((y >> bestCh) & 255));
    const mid = b.pts.length >> 1;
    boxes = [...boxes.slice(0, best), { pts: b.pts.slice(0, mid) }, { pts: b.pts.slice(mid) }, ...boxes.slice(best + 1)];
  }
  return boxes.map((b) => {
    let r = 0, g = 0, bl = 0;
    for (const p of b.pts) {
      r += p >> 16;
      g += (p >> 8) & 255;
      bl += p & 255;
    }
    const n = Math.max(1, b.pts.length);
    return [r / n, g / n, bl / n];
  });
}

function nearest(pal: [number, number, number][], r: number, g: number, b: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < pal.length; i++) {
    const dr = pal[i][0] - r, dg = pal[i][1] - g, db = pal[i][2] - b;
    const dd = dr * dr + dg * dg + db * db;
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  return best;
}

function quantizeColor(img: Img, o: TraceOptions): Quant {
  const { data: d } = img;
  const npx = img.width * img.height;
  const k = Math.max(2, Math.min(64, Math.round(o.colors)));
  // sample up to 60k opaque pixels on a regular stride
  let opaque = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] >= o.alphaCutoff) opaque++;
  const labels = new Uint8Array(npx).fill(BG);
  if (!opaque) return { labels, palette: [] };
  const stride = Math.max(1, Math.floor(opaque / 60000));
  const samp: number[] = [];
  for (let i = 0, c = 0; i < d.length; i += 4) {
    if (d[i + 3] < o.alphaCutoff) continue;
    if (c++ % stride === 0) samp.push((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  const samples = Int32Array.from(samp);
  let pal = medianCut(samples, k);
  // k-means refinement (Lloyd) on the sample
  for (let it = 0; it < 8; it++) {
    const acc = pal.map(() => [0, 0, 0, 0]);
    for (const p of samples) {
      const r = p >> 16, g = (p >> 8) & 255, b = p & 255;
      const a = acc[nearest(pal, r, g, b)];
      a[0] += r; a[1] += g; a[2] += b; a[3]++;
    }
    let moved = 0;
    pal = pal.map((c, i) => {
      const a = acc[i];
      if (!a[3]) return c;
      const nc: [number, number, number] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
      moved = Math.max(moved, Math.abs(nc[0] - c[0]) + Math.abs(nc[1] - c[1]) + Math.abs(nc[2] - c[2]));
      return nc;
    });
    if (moved < 0.5) break;
  }
  // assign every pixel (memoised on the exact colour; logos have few distinct colours)
  const memo = new Map<number, number>();
  for (let i = 0, j = 0; j < npx; i += 4, j++) {
    if (d[i + 3] < o.alphaCutoff) continue;
    const key = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    let l = memo.get(key);
    if (l === undefined) {
      l = nearest(pal, d[i], d[i + 1], d[i + 2]);
      if (memo.size < 200000) memo.set(key, l);
    }
    labels[j] = l;
  }
  if (o.ignoreWhite) {
    const white = pal.map(([r, g, b]) => luma(r, g, b) > 240 && Math.max(r, g, b) - Math.min(r, g, b) < 24);
    for (let j = 0; j < npx; j++) if (labels[j] !== BG && white[labels[j]]) labels[j] = BG;
  }
  return { labels, palette: pal };
}

// ───────── 2. despeckle ─────────

/** Merge 4-connected regions smaller than minArea into their most common neighbouring label. Background touching the border is kept. */
export function despeckle(labels: Uint8Array, w: number, h: number, minArea: number) {
  if (minArea <= 1) return;
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const region = new Int32Array(w * h);
  const nb = new Uint32Array(256);
  for (let s = 0; s < labels.length; s++) {
    if (seen[s]) continue;
    const lab = labels[s];
    let sp = 0, rn = 0, border = false;
    stack[sp++] = s;
    seen[s] = 1;
    while (sp) {
      const p = stack[--sp];
      region[rn++] = p;
      const x = p % w, y = (p - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      if (x > 0 && !seen[p - 1] && labels[p - 1] === lab) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && !seen[p + 1] && labels[p + 1] === lab) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (y > 0 && !seen[p - w] && labels[p - w] === lab) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (y < h - 1 && !seen[p + w] && labels[p + w] === lab) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    if (rn >= minArea || (lab === BG && border)) continue;
    nb.fill(0);
    for (let i = 0; i < rn; i++) {
      const p = region[i], x = p % w;
      if (x > 0 && labels[p - 1] !== lab) nb[labels[p - 1]]++;
      if (x < w - 1 && labels[p + 1] !== lab) nb[labels[p + 1]]++;
      if (p >= w && labels[p - w] !== lab) nb[labels[p - w]]++;
      if (p + w < labels.length && labels[p + w] !== lab) nb[labels[p + w]]++;
    }
    let best = -1, bc = 0;
    for (let i = 0; i < 256; i++) if (nb[i] > bc) { bc = nb[i]; best = i; }
    if (best < 0) continue;
    for (let i = 0; i < rn; i++) labels[region[i]] = best;
  }
}

// ───────── 4. marching squares ─────────

type Pair = [number, number, number]; // edge a, edge b, inside reference corner
// edges: 0 = T, 1 = R, 2 = B, 3 = L ; corners: 0 = tl, 1 = tr, 2 = br, 3 = bl
const EDGE_PT: Vec2[] = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
const CORNER_PT: Vec2[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
const CASES: Pair[][] = [
  [], [[3, 2, 3]], [[2, 1, 2]], [[3, 1, 3]], [[0, 1, 1]], [[0, 3, 1], [2, 1, 3]], [[0, 2, 1]], [[0, 3, 2]],
  [[0, 3, 0]], [[0, 2, 0]], [[0, 1, 0], [3, 2, 2]], [[0, 1, 0]], [[3, 1, 0]], [[2, 1, 0]], [[3, 2, 0]], [],
];
/** oriented segments per case: [from edge, to edge] so that the inside is always on the same side */
const ORIENTED: [number, number][][] = CASES.map((segs) =>
  segs.map(([a, b, c]) => {
    const P = EDGE_PT[a], Q = EDGE_PT[b], C = CORNER_PT[c];
    const cross = (Q[0] - P[0]) * (C[1] - P[1]) - (Q[1] - P[1]) * (C[0] - P[0]);
    return cross > 0 ? [a, b] : [b, a];
  }),
);
// doubled-coordinate offsets of the edge points inside cell (cx, cy), relative to (2cx, 2cy)
const EDGE_D2: Vec2[] = [[2, 1], [3, 2], [2, 3], [1, 2]];

/**
 * Closed contours of a binary mask (1 = inside) as polylines in pixel coordinates (pixel (x, y) covers [x, x+1]).
 * Outer boundaries and holes have opposite orientation.
 */
export function marchingSquares(mask: Uint8Array, w: number, h: number, work?: Int32Array): Vec2[][] {
  const KW = 2 * w + 4, KH = 2 * h + 4;
  // `work` (reused between layers) must be all −1; every entry set here is reset to −1 while walking the loops
  const next = work && work.length >= KW * KH ? work : new Int32Array(KW * KH).fill(-1);
  const starts: number[] = [];
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? mask[y * w + x] : 0);
  for (let cy = -1; cy < h; cy++) {
    for (let cx = -1; cx < w; cx++) {
      const c = (at(cx, cy) << 3) | (at(cx + 1, cy) << 2) | (at(cx + 1, cy + 1) << 1) | at(cx, cy + 1);
      if (c === 0 || c === 15) continue;
      for (const [a, b] of ORIENTED[c]) {
        const ka = (2 * cy + EDGE_D2[a][1] + 2) * KW + (2 * cx + EDGE_D2[a][0] + 2);
        const kb = (2 * cy + EDGE_D2[b][1] + 2) * KW + (2 * cx + EDGE_D2[b][0] + 2);
        next[ka] = kb;
        starts.push(ka);
      }
    }
  }
  const loops: Vec2[][] = [];
  for (const s of starts) {
    if (next[s] < 0) continue;
    const pts: Vec2[] = [];
    let k = s;
    while (k >= 0 && next[k] >= 0) {
      const x2 = k % KW, y2 = (k - x2) / KW;
      pts.push([(x2 - 2) / 2, (y2 - 2) / 2]);
      const nk = next[k];
      next[k] = -1;
      k = nk;
    }
    if (pts.length >= 3) loops.push(pts);
  }
  return loops;
}

export function polygonArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}

// ───────── 5. Ramer–Douglas–Peucker ─────────

function segDist2(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
  return ex * ex + ey * ey;
}

/** RDP on pts[i0..i1] (inclusive); pushes kept interior indices into `out` in order. */
function rdp(pts: Vec2[], i0: number, i1: number, tol2: number, out: number[]) {
  // iterative to avoid deep recursion on long contours
  const st: [number, number][] = [[i0, i1]];
  const keep: number[] = [];
  while (st.length) {
    const [a, b] = st.pop()!;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist2(pts[i], pts[a], pts[b]);
      if (d > md) {
        md = d;
        mi = i;
      }
    }
    if (md > tol2) {
      keep.push(mi);
      st.push([a, mi], [mi, b]);
    }
  }
  keep.sort((x, y) => x - y);
  for (const k of keep) out.push(k);
}

/** RDP of a closed loop → indices of kept vertices (sorted). Exported for tests. */
export function rdpClosed(pts: Vec2[], tol: number): number[] {
  const n = pts.length;
  if (n < 4) return pts.map((_, i) => i);
  // anchor at the point farthest from pts[0]
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const ring = [...pts, pts[0]];
  const out: number[] = [0];
  rdp(ring, 0, far, tol * tol, out);
  out.push(far);
  rdp(ring, far, n, tol * tol, out);
  return out;
}

// ───────── 6. Schneider cubic fitting ─────────

type Cubic = [Vec2, Vec2, Vec2, Vec2];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const mul = (a: Vec2, k: number): Vec2 => [a[0] * k, a[1] * k];
const dot = (a: Vec2, b: Vec2) => a[0] * b[0] + a[1] * b[1];
const len = (a: Vec2) => Math.hypot(a[0], a[1]);
const unit = (a: Vec2): Vec2 => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l] : [0, 0];
};

function bez(c: Cubic, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, cc = 3 * u * t * t, d = t * t * t;
  return [a * c[0][0] + b * c[1][0] + cc * c[2][0] + d * c[3][0], a * c[0][1] + b * c[1][1] + cc * c[2][1] + d * c[3][1]];
}
function bezD1(c: Cubic, t: number): Vec2 {
  const u = 1 - t;
  return [
    3 * u * u * (c[1][0] - c[0][0]) + 6 * u * t * (c[2][0] - c[1][0]) + 3 * t * t * (c[3][0] - c[2][0]),
    3 * u * u * (c[1][1] - c[0][1]) + 6 * u * t * (c[2][1] - c[1][1]) + 3 * t * t * (c[3][1] - c[2][1]),
  ];
}
function bezD2(c: Cubic, t: number): Vec2 {
  const u = 1 - t;
  return [6 * u * (c[2][0] - 2 * c[1][0] + c[0][0]) + 6 * t * (c[3][0] - 2 * c[2][0] + c[1][0]), 6 * u * (c[2][1] - 2 * c[1][1] + c[0][1]) + 6 * t * (c[3][1] - 2 * c[2][1] + c[1][1])];
}

function chordParams(p: Vec2[], a: number, b: number): number[] {
  const u = [0];
  for (let i = a + 1; i <= b; i++) u.push(u[u.length - 1] + len(sub(p[i], p[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((x) => x / total);
}

function generateBezier(p: Vec2[], a: number, b: number, u: number[], t1: Vec2, t2: Vec2): Cubic {
  const p0 = p[a], p3 = p[b];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], s = 1 - t;
    const b0 = s * s * s, b1 = 3 * s * s * t, b2 = 3 * s * t * t, b3 = t * t * t;
    const A1 = mul(t1, b1), A2 = mul(t2, b2);
    c00 += dot(A1, A1);
    c01 += dot(A1, A2);
    c11 += dot(A2, A2);
    const tmp = sub(p[a + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(A1, tmp);
    x1 += dot(A2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  const segLen = len(sub(p3, p0));
  let al = 0, ar = 0;
  if (Math.abs(det) > 1e-12) {
    al = (x0 * c11 - x1 * c01) / det;
    ar = (c00 * x1 - c01 * x0) / det;
  }
  const eps = 1e-6 * segLen;
  if (al < eps || ar < eps) al = ar = segLen / 3; // Wu/Barsky heuristic fallback
  return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
}

function reparam(c: Cubic, p: Vec2[], a: number, u: number[]): number[] {
  return u.map((t, i) => {
    const q = bez(c, t), d1 = bezD1(c, t), d2 = bezD2(c, t);
    const diff = sub(q, p[a + i]);
    const num = dot(diff, d1), den = dot(d1, d1) + dot(diff, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.max(0, Math.min(1, t - num / den));
  });
}

function maxError(c: Cubic, p: Vec2[], a: number, b: number, u: number[]): { err: number; at: number } {
  let err = 0, at = Math.floor((a + b) / 2);
  for (let i = a + 1; i < b; i++) {
    const q = bez(c, u[i - a]);
    const d = (q[0] - p[i][0]) ** 2 + (q[1] - p[i][1]) ** 2;
    if (d >= err) {
      err = d;
      at = i;
    }
  }
  return { err, at };
}

function fitCubic(p: Vec2[], a: number, b: number, t1: Vec2, t2: Vec2, err2: number, out: Cubic[], depth = 0) {
  if (b - a === 1) {
    const d = len(sub(p[b], p[a])) / 3;
    out.push([p[a], add(p[a], mul(t1, d)), add(p[b], mul(t2, d)), p[b]]);
    return;
  }
  let u = chordParams(p, a, b);
  let c = generateBezier(p, a, b, u, t1, t2);
  let { err, at } = maxError(c, p, a, b, u);
  if (err < err2) {
    out.push(c);
    return;
  }
  if (err < err2 * 16) {
    for (let i = 0; i < 6; i++) {
      u = reparam(c, p, a, u);
      c = generateBezier(p, a, b, u, t1, t2);
      ({ err, at } = maxError(c, p, a, b, u));
      if (err < err2) {
        out.push(c);
        return;
      }
    }
  }
  if (depth > 40 || at <= a || at >= b) {
    out.push(c);
    return;
  }
  const tc = unit(sub(p[Math.max(a, at - 1)], p[Math.min(b, at + 1)]));
  fitCubic(p, a, at, t1, tc, err2, out, depth + 1);
  fitCubic(p, at, b, mul(tc, -1), t2, err2, out, depth + 1);
}

/** True when every point between a and b lies within tol of the chord. */
function isStraight(p: Vec2[], a: number, b: number, tol2: number): boolean {
  for (let i = a + 1; i < b; i++) if (segDist2(p[i], p[a], p[b]) > tol2) return false;
  return true;
}

interface LoopFit {
  /** segments in order; each starts where the previous ended */
  segs: Cubic[];
  /** anchor index → sharp corner */
  corner: boolean[];
}

/** Least-squares line through loop points strictly between vertex indices a → b (cyclic), trimmed 1 px at both ends. */
function runLine(loop: Vec2[], a: number, b: number): { p: Vec2; d: Vec2 } | null {
  const n = loop.length;
  const A = loop[a], B = loop[b];
  const pts: Vec2[] = [];
  for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) {
    const q = loop[i];
    if (Math.hypot(q[0] - A[0], q[1] - A[1]) > 1 && Math.hypot(q[0] - B[0], q[1] - B[1]) > 1) pts.push(q);
  }
  if (pts.length < 3) return null;
  let mx = 0, my = 0;
  for (const q of pts) {
    mx += q[0];
    my += q[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const q of pts) {
    const dx = q[0] - mx, dy = q[1] - my;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const d: Vec2 = [Math.cos(th), Math.sin(th)];
  for (const q of pts) if (Math.abs((q[0] - mx) * d[1] - (q[1] - my) * d[0]) > 0.6) return null; // not straight
  return { p: [mx, my], d };
}

/**
 * Corner refinement: marching squares cuts pixel corners by ½ px and RDP keeps one of the cut points. Where both runs
 * next to a corner are straight, move the corner to the intersection of the two fitted lines (if within 1.5 px).
 */
function refineCorners(loop: Vec2[], vidx: number[], isCorner: boolean[]): Vec2[] {
  const out = loop.slice();
  const m = vidx.length;
  for (let i = 0; i < m; i++) {
    if (!isCorner[i]) continue;
    const L1 = runLine(loop, vidx[(i - 1 + m) % m], vidx[i]), L2 = runLine(loop, vidx[i], vidx[(i + 1) % m]);
    if (!L1 || !L2) continue;
    const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
    if (Math.abs(den) < 0.2) continue;
    const t = ((L2.p[0] - L1.p[0]) * L2.d[1] - (L2.p[1] - L1.p[1]) * L2.d[0]) / den;
    const X: Vec2 = [L1.p[0] + L1.d[0] * t, L1.p[1] + L1.d[1] * t];
    const v = loop[vidx[i]];
    if (Math.hypot(X[0] - v[0], X[1] - v[1]) <= 1.5) out[vidx[i]] = X;
  }
  return out;
}

/** Fit one closed loop with corners from RDP and Schneider cubics in between. */
export function fitLoop(loop: Vec2[], o: Pick<TraceOptions, "cornerAngle" | "precision" | "curves">): LoopFit {
  const n = loop.length;
  const tol = Math.max(0.3, o.precision);
  const vidx = rdpClosed(loop, Math.max(0.6, Math.min(tol, 2)));
  const cosLim = Math.cos((Math.max(0, Math.min(179, o.cornerAngle)) * Math.PI) / 180);
  const cornersOf = (ids: number[]) =>
    ids.map((id, i) => {
      const k = ids.length, v = loop[id];
      const d0 = unit(sub(v, loop[ids[(i - 1 + k) % k]])), d1 = unit(sub(loop[ids[(i + 1) % k]], v));
      return dot(d0, d1) < cosLim; // turning angle larger than the limit
    });
  if (!o.curves || vidx.length < 3) {
    const ids = !o.curves ? rdpClosed(loop, tol) : vidx;
    const ref = ids.length >= 3 ? refineCorners(loop, ids, cornersOf(ids)) : loop;
    const segs: Cubic[] = ids.map((id, i) => {
      const a = ref[id], b = ref[ids[(i + 1) % ids.length]];
      return [a, a, b, b];
    });
    return { segs, corner: ids.map(() => true) };
  }
  const m = vidx.length;
  const isCorner = cornersOf(vidx);
  loop = refineCorners(loop, vidx, isCorner);
  const V = vidx.map((i) => loop[i]);
  // split points: corners; a loop without corners is split at two opposite RDP vertices with smooth tangents
  let splits = vidx.filter((_, i) => isCorner[i]);
  const smoothSplit = splits.length === 0;
  if (smoothSplit) splits = [vidx[0], vidx[Math.floor(m / 2)]];
  if (splits.length === 1) splits.push(vidx[(vidx.indexOf(splits[0]) + Math.floor(m / 2)) % m]);
  const tangentAt = (idx: number): Vec2 => {
    const vi = vidx.indexOf(idx);
    return unit(sub(V[(vi + 1) % m], V[(vi - 1 + m) % m]));
  };
  const cornerSet = new Set(vidx.filter((_, i) => isCorner[i]));
  const segs: Cubic[] = [];
  const corner: boolean[] = [];
  const err2 = tol * tol;
  for (let s = 0; s < splits.length; s++) {
    const i0 = splits[s], i1raw = splits[(s + 1) % splits.length];
    const i1 = i1raw > i0 ? i1raw : i1raw + n;
    const pts: Vec2[] = [];
    for (let i = i0; i <= i1; i++) pts.push(loop[i % n]);
    const last = pts.length - 1;
    let t1: Vec2, t2: Vec2;
    // start tangent: smooth split → loop tangent; corner → towards the next RDP vertex inside the run
    if (cornerSet.has(i0)) {
      const vi = vidx.indexOf(i0);
      t1 = unit(sub(V[(vi + 1) % m], V[vi]));
    } else t1 = tangentAt(i0);
    if (cornerSet.has(i1raw)) {
      const vi = vidx.indexOf(i1raw);
      t2 = unit(sub(V[(vi - 1 + m) % m], V[vi]));
    } else t2 = mul(tangentAt(i1raw), -1);
    const before = segs.length;
    if (isStraight(pts, 0, last, err2)) segs.push([pts[0], pts[0], pts[last], pts[last]]);
    else fitCubic(pts, 0, last, t1, t2, err2, segs);
    corner.push(cornerSet.has(i0));
    for (let k = before + 1; k < segs.length; k++) corner.push(false);
  }
  return { segs, corner };
}

/** Convert fitted segments into a closed contour with absolute handles, mapped by (scale, offset). */
function toContour(f: LoopFit, sx: number, sy: number, ox: number, oy: number): Contour {
  const T = (p: Vec2): Vec2 => [+(p[0] * sx + ox).toFixed(3), +(p[1] * sy + oy).toFixed(3)];
  const nodes: VectorAnchor[] = f.segs.map((s, i) => {
    const prev = f.segs[(i - 1 + f.segs.length) % f.segs.length];
    return { anchor: T(s[0]), handleIn: T(prev[2]), handleOut: T(s[1]), isCorner: f.corner[i] ?? false };
  });
  return { nodes, closed: true };
}

// ───────── driver ─────────

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");

/**
 * Trace an image. Coordinates are returned in the image's pixel space × (sx, sy) + (ox, oy), i.e. the caller passes the
 * mapping into the target node's local space.
 */
export interface TraceMap {
  sx?: number;
  sy?: number;
  ox?: number;
  oy?: number;
}

export function traceImage(img: Img, opts: Partial<TraceOptions> = {}, map: TraceMap = {}): TraceResult {
  const o: TraceOptions = { ...DEFAULT_TRACE, ...opts };
  const { width: w, height: h } = img;
  const sx = map.sx ?? 1, sy = map.sy ?? sx, ox = map.ox ?? 0, oy = map.oy ?? 0;
  const src = o.smooth > 0.2 ? gaussianBlur(img, { radius: o.smooth }) : img;
  const q = o.mode === "bw" ? quantizeBW(src, o) : quantizeColor(src, o);
  despeckle(q.labels, w, h, Math.max(1, Math.round(o.minArea)));
  const areas = new Array(q.palette.length).fill(0);
  for (let j = 0; j < q.labels.length; j++) if (q.labels[j] !== BG) areas[q.labels[j]]++;
  const order = q.palette.map((_, i) => i).filter((i) => areas[i] > 0).sort((a, b) => areas[b] - areas[a]);
  const rank = new Int16Array(256).fill(-1);
  order.forEach((l, r) => (rank[l] = r));
  const mask = new Uint8Array(w * h);
  const work = new Int32Array((2 * w + 4) * (2 * h + 4)).fill(-1);
  const layers: TraceLayer[] = [];
  let paths = 0, anchors = 0;
  for (let r = 0; r < order.length; r++) {
    const lab = order[r];
    for (let j = 0; j < mask.length; j++) {
      const L = q.labels[j];
      mask[j] = L === BG ? 0 : o.method === "stack" ? (rank[L] >= r ? 1 : 0) : L === lab ? 1 : 0;
    }
    const loops = marchingSquares(mask, w, h, work).filter((l) => Math.abs(polygonArea(l)) >= Math.max(1, o.minArea * 0.5));
    const contours = loops.map((l) => toContour(fitLoop(l, o), sx, sy, ox, oy));
    if (!contours.length) continue;
    paths += contours.length;
    for (const c of contours) anchors += c.nodes.length;
    const [cr, cg, cb] = q.palette[lab];
    layers.push({ color: `#${hex2(cr)}${hex2(cg)}${hex2(cb)}`, contours, area: areas[lab] });
  }
  return { width: w, height: h, layers, paths, anchors };
}
