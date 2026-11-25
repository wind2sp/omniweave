// Gradient mesh (Illustrator's Mesh tool U, design 2 2026-11-25): a grid of points over a path's fill, each point
// with a colour and up to four curve handles (toward its left, right, upper and lower neighbours). The mesh lines
// are cubic curves through the points; each patch between four points is the Coons surface of its four curved
// sides, and the colour blends across it from its corners (eased, so there are no creases at the mesh lines). The
// mesh lives in the path's own coordinates; the path's outline cuts it (render/draw.ts, io/export.ts and
// io/pdfVector.ts draw it as a picture clipped to the path: SVG and PDF have no mesh of this kind to write).

import type { Vec2 } from "./types";
import { parseColor, rgbHex } from "./style/color";

/** Handle directions: toward the left, right, upper, lower neighbour. */
export const H_LEFT = 0, H_RIGHT = 1, H_UP = 2, H_DOWN = 3;

export interface MeshPoint {
  /** position, in the path's own coordinates */
  p: Vec2;
  /** colour (#rrggbb) */
  c: string;
  /**
   * curve handles as offsets from `p` (left, right, up, down); null or missing = a third of the way to that neighbour
   * (a straight mesh line)
   */
  h?: (Vec2 | null)[];
}

/** `rows` × `cols` patches: (rows + 1) × (cols + 1) points, row by row. */
export interface MeshFill {
  rows: number;
  cols: number;
  pts: MeshPoint[];
}

export const meshIndex = (m: MeshFill, r: number, c: number) => r * (m.cols + 1) + c;
const pt = (m: MeshFill, r: number, c: number) => m.pts[meshIndex(m, r, c)];

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const add = (a: Vec2, b: Vec2): Vec2 => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
function rgb(c: string): [number, number, number] {
  const x = parseColor(c);
  return x ? [x.r, x.g, x.b] : [0, 0, 0];
}
export function mixColor(a: string, b: string, t: number): string {
  const p = rgb(a), q = rgb(b);
  return rgbHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
}

/** A 1 × 1 mesh over a box, every corner in `color`. */
export function newMesh(box: { x: number; y: number; w: number; h: number }, color: string): MeshFill {
  const { x, y, w, h } = box;
  return { rows: 1, cols: 1, pts: [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map((p) => ({ p: p as Vec2, c: color })) };
}

/** The neighbour of point (r, c) in direction `dir`, or null at the edge. */
function neighbour(m: MeshFill, r: number, c: number, dir: number): [number, number] | null {
  const [rr, cc] = dir === H_LEFT ? [r, c - 1] : dir === H_RIGHT ? [r, c + 1] : dir === H_UP ? [r - 1, c] : [r + 1, c];
  return rr < 0 || cc < 0 || rr > m.rows || cc > m.cols ? null : [rr, cc];
}

/** The handle of point (r, c) toward `dir` as an offset (its default: a third of the way to the neighbour). */
export function meshHandle(m: MeshFill, r: number, c: number, dir: number): Vec2 | null {
  const nb = neighbour(m, r, c, dir);
  if (!nb) return null;
  const x = pt(m, r, c);
  const own = x.h?.[dir];
  if (own) return own;
  const q = pt(m, nb[0], nb[1]).p;
  return [(q[0] - x.p[0]) / 3, (q[1] - x.p[1]) / 3];
}

/** The cubic of the mesh line from (r, c) toward `dir` (RIGHT or DOWN). */
function edge(m: MeshFill, r: number, c: number, dir: number): [Vec2, Vec2, Vec2, Vec2] {
  const [r2, c2] = dir === H_RIGHT ? [r, c + 1] : [r + 1, c];
  const a = pt(m, r, c).p, b = pt(m, r2, c2).p;
  return [a, add(a, meshHandle(m, r, c, dir)!), add(b, meshHandle(m, r2, c2, dir === H_RIGHT ? H_LEFT : H_UP)!), b];
}

function bez([p0, p1, p2, p3]: [Vec2, Vec2, Vec2, Vec2], t: number): Vec2 {
  const s = 1 - t, a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

/** de Casteljau: the cubic split at t (left part, right part). */
function split([p0, p1, p2, p3]: [Vec2, Vec2, Vec2, Vec2], t: number) {
  const p01 = lerp(p0, p1, t), p12 = lerp(p1, p2, t), p23 = lerp(p2, p3, t), p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), mid = lerp(p012, p123, t);
  return { a1: p01, m0: p012, mid, m1: p123, b2: p23 };
}

/** The point at (u, v) of patch (r, c): the Coons surface of its four curved sides. */
export function patchPoint(m: MeshFill, r: number, c: number, u: number, v: number): Vec2 {
  const top = edge(m, r, c, H_RIGHT), bottom = edge(m, r + 1, c, H_RIGHT), left = edge(m, r, c, H_DOWN), right = edge(m, r, c + 1, H_DOWN);
  const c0 = bez(top, u), c1 = bez(bottom, u), d0 = bez(left, v), d1 = bez(right, v);
  const p00 = top[0], p10 = top[3], p01 = bottom[0], p11 = bottom[3];
  const f = (k: 0 | 1) =>
    (1 - v) * c0[k] + v * c1[k] + (1 - u) * d0[k] + u * d1[k] - ((1 - u) * (1 - v) * p00[k] + u * (1 - v) * p10[k] + (1 - u) * v * p01[k] + u * v * p11[k]);
  return [f(0), f(1)];
}

const cross = (a: Vec2, b: Vec2) => a[0] * b[1] - a[1] * b[0];

/** u, v of `q` in the bilinear patch a (0,0) b (1,0) c (1,1) d (0,1); null when it has none. */
export function inverseBilinear(q: Vec2, a: Vec2, b: Vec2, c: Vec2, d: Vec2): [number, number] | null {
  const e: Vec2 = [b[0] - a[0], b[1] - a[1]], f: Vec2 = [d[0] - a[0], d[1] - a[1]];
  const g: Vec2 = [a[0] - b[0] + c[0] - d[0], a[1] - b[1] + c[1] - d[1]], h: Vec2 = [q[0] - a[0], q[1] - a[1]];
  const k2 = cross(g, f), k1 = cross(e, f) + cross(h, g), k0 = cross(h, e);
  const uOf = (v: number) => {
    const dx = e[0] + g[0] * v, dy = e[1] + g[1] * v;
    return Math.abs(dx) > Math.abs(dy) ? (h[0] - f[0] * v) / dx : (h[1] - f[1] * v) / dy;
  };
  if (Math.abs(k2) < 1e-9 * Math.max(1, Math.abs(k1))) {
    if (Math.abs(k1) < 1e-12) return null;
    const v = -k0 / k1;
    return [uOf(v), v];
  }
  const w = k1 * k1 - 4 * k0 * k2;
  if (w < 0) return null;
  const s = Math.sqrt(w);
  const cands = [(-k1 - s) / (2 * k2), (-k1 + s) / (2 * k2)].map((v) => [uOf(v), v] as [number, number]);
  const inside = (x: [number, number]) => x[0] >= -1e-6 && x[0] <= 1 + 1e-6 && x[1] >= -1e-6 && x[1] <= 1 + 1e-6;
  return cands.find(inside) ?? cands.sort((p, q) => dist01(p) - dist01(q))[0];
}
const dist01 = ([u, v]: [number, number]) => Math.max(0, -u, u - 1) + Math.max(0, -v, v - 1);

/** The patch sampled on an n × n grid: (n + 1)² points, row by row (v), u along each row. */
function patchGrid(m: MeshFill, r: number, c: number, n: number): Vec2[] {
  const out: Vec2[] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) out.push(patchPoint(m, r, c, i / n, j / n));
  return out;
}

/** The patch under `q` and its u, v there; null outside the mesh. */
export function meshLocate(m: MeshFill, q: Vec2): { r: number; c: number; u: number; v: number } | null {
  const n = 12;
  for (let r = 0; r < m.rows; r++)
    for (let c = 0; c < m.cols; c++) {
      const g = patchGrid(m, r, c, n);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const k = j * (n + 1) + i;
          const uv = inverseBilinear(q, g[k], g[k + 1], g[k + n + 2], g[k + n + 1]);
          if (uv && uv[0] >= -1e-6 && uv[0] <= 1 + 1e-6 && uv[1] >= -1e-6 && uv[1] <= 1 + 1e-6) return { r, c, u: (i + uv[0]) / n, v: (j + uv[1]) / n };
        }
    }
  return null;
}

/** The mesh point within `tol` of `q` (the nearest), or −1. */
export function meshPointAt(m: MeshFill, q: Vec2, tol: number): number {
  let best = -1, bd = tol;
  m.pts.forEach((x, i) => {
    const d = Math.hypot(x.p[0] - q[0], x.p[1] - q[1]);
    if (d <= bd) (bd = d), (best = i);
  });
  return best;
}

/** The handle of point `idx` within `tol` of `q`: its direction, or −1. */
export function meshHandleAt(m: MeshFill, idx: number, q: Vec2, tol: number): number {
  const r = Math.floor(idx / (m.cols + 1)), c = idx % (m.cols + 1);
  let best = -1, bd = tol;
  for (let dir = 0; dir < 4; dir++) {
    const h = meshHandle(m, r, c, dir);
    if (!h) continue;
    const p = add(m.pts[idx].p, h);
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d <= bd) (bd = d), (best = dir);
  }
  return best;
}

const copyPoint = (x: MeshPoint): MeshPoint => ({ p: [x.p[0], x.p[1]], c: x.c, ...(x.h ? { h: x.h.map((v) => (v ? ([v[0], v[1]] as Vec2) : null)) } : {}) });
function setH(x: MeshPoint, dir: number, v: Vec2 | null) {
  const h = x.h ? [...x.h] : [null, null, null, null];
  while (h.length < 4) h.push(null);
  h[dir] = v;
  if (h.every((y) => !y)) delete x.h;
  else x.h = h;
}

/**
 * A click with the Mesh tool inside the mesh: a new mesh line across through `q` each way (only one when `q` is on a
 * line already). The lines it crosses are split where it crosses them (their curves kept), the new lines' colours
 * blended from their neighbours. The point at `q` gets `color` when given. Null outside the mesh.
 */
export function meshAddAt(m: MeshFill, q: Vec2, color?: string): { mesh: MeshFill; index: number } | null {
  const at = meshLocate(m, q);
  if (!at) return null;
  const E = 0.02;
  let mesh: MeshFill = { rows: m.rows, cols: m.cols, pts: m.pts.map(copyPoint) };
  let col: number, row: number;
  if (at.u > E && at.u < 1 - E) {
    mesh = insertColumn(mesh, at.c, at.u);
    col = at.c + 1;
  } else col = at.u >= 1 - E ? at.c + 1 : at.c;
  if (at.v > E && at.v < 1 - E) {
    mesh = insertRow(mesh, at.r, at.v);
    row = at.r + 1;
  } else row = at.v >= 1 - E ? at.r + 1 : at.r;
  const index = meshIndex(mesh, row, col);
  if (color) mesh.pts[index].c = color;
  return { mesh, index };
}

/** A new column of points at `u` of every patch of column `c` (each row's curve split there). */
function insertColumn(m: MeshFill, c: number, u: number): MeshFill {
  const cols = m.cols + 1;
  const out: MeshPoint[] = [];
  for (let r = 0; r <= m.rows; r++) {
    const a = copyPoint(pt(m, r, c)), b = copyPoint(pt(m, r, c + 1));
    const s = split(edge(m, r, c, H_RIGHT), u);
    setH(a, H_RIGHT, sub(s.a1, a.p));
    setH(b, H_LEFT, sub(s.b2, b.p));
    const x: MeshPoint = { p: s.mid, c: mixColor(a.c, b.c, u) };
    setH(x, H_LEFT, sub(s.m0, s.mid));
    setH(x, H_RIGHT, sub(s.m1, s.mid));
    // its up / down handles between its neighbours' (the column line follows the curves around it)
    const hu = [meshHandle(m, r, c, H_UP), meshHandle(m, r, c + 1, H_UP)], hd = [meshHandle(m, r, c, H_DOWN), meshHandle(m, r, c + 1, H_DOWN)];
    if (hu[0] && hu[1] && (pt(m, r, c).h?.[H_UP] || pt(m, r, c + 1).h?.[H_UP])) setH(x, H_UP, lerp(hu[0], hu[1], u));
    if (hd[0] && hd[1] && (pt(m, r, c).h?.[H_DOWN] || pt(m, r, c + 1).h?.[H_DOWN])) setH(x, H_DOWN, lerp(hd[0], hd[1], u));
    for (let k = 0; k <= m.cols; k++) {
      out.push(k === c ? a : k === c + 1 ? b : copyPoint(pt(m, r, k)));
      if (k === c) out.push(x);
    }
  }
  return { rows: m.rows, cols, pts: out };
}

/** A new row of points at `v` of every patch of row `r` (each column's curve split there). */
function insertRow(m: MeshFill, r: number, v: number): MeshFill {
  const rows: MeshPoint[][] = [];
  for (let k = 0; k <= m.rows; k++) rows.push(m.pts.slice(k * (m.cols + 1), (k + 1) * (m.cols + 1)).map(copyPoint));
  const added: MeshPoint[] = [];
  for (let c = 0; c <= m.cols; c++) {
    const a = rows[r][c], b = rows[r + 1][c];
    const s = split(edge(m, r, c, H_DOWN), v);
    setH(a, H_DOWN, sub(s.a1, a.p));
    setH(b, H_UP, sub(s.b2, b.p));
    const x: MeshPoint = { p: s.mid, c: mixColor(a.c, b.c, v) };
    setH(x, H_UP, sub(s.m0, s.mid));
    setH(x, H_DOWN, sub(s.m1, s.mid));
    const hl = [meshHandle(m, r, c, H_LEFT), meshHandle(m, r + 1, c, H_LEFT)], hr = [meshHandle(m, r, c, H_RIGHT), meshHandle(m, r + 1, c, H_RIGHT)];
    if (hl[0] && hl[1] && (pt(m, r, c).h?.[H_LEFT] || pt(m, r + 1, c).h?.[H_LEFT])) setH(x, H_LEFT, lerp(hl[0], hl[1], v));
    if (hr[0] && hr[1] && (pt(m, r, c).h?.[H_RIGHT] || pt(m, r + 1, c).h?.[H_RIGHT])) setH(x, H_RIGHT, lerp(hr[0], hr[1], v));
    added.push(x);
  }
  rows.splice(r + 1, 0, added);
  return { rows: m.rows + 1, cols: m.cols, pts: rows.flat() };
}

/** The mesh without the row and / or column lines through point `idx` (the outer edge stays); null when none can go. */
export function meshRemoveAt(m: MeshFill, idx: number): MeshFill | null {
  const r = Math.floor(idx / (m.cols + 1)), c = idx % (m.cols + 1);
  const dropRow = r > 0 && r < m.rows, dropCol = c > 0 && c < m.cols;
  if (!dropRow && !dropCol) return null;
  const keep: MeshPoint[] = [];
  m.pts.forEach((x, i) => {
    const rr = Math.floor(i / (m.cols + 1)), cc = i % (m.cols + 1);
    if ((dropRow && rr === r) || (dropCol && cc === c)) return;
    const y = copyPoint(x);
    // the handles that reached the removed line go back to straight
    if (dropCol && cc === c - 1) setH(y, H_RIGHT, null);
    if (dropCol && cc === c + 1) setH(y, H_LEFT, null);
    if (dropRow && rr === r - 1) setH(y, H_DOWN, null);
    if (dropRow && rr === r + 1) setH(y, H_UP, null);
    keep.push(y);
  });
  return { rows: m.rows - (dropRow ? 1 : 0), cols: m.cols - (dropCol ? 1 : 0), pts: keep };
}

/** Point `idx`'s handle toward `dir` set to an offset (null = straight again). */
export function meshSetHandle(m: MeshFill, idx: number, dir: number, v: Vec2 | null): MeshFill {
  const pts = m.pts.map((x, i) => (i === idx ? copyPoint(x) : x));
  setH(pts[idx], dir, v);
  return { ...m, pts };
}

export function meshBounds(m: MeshFill): { x: number; y: number; w: number; h: number } {
  const xs: number[] = [], ys: number[] = [];
  m.pts.forEach((x, i) => {
    xs.push(x.p[0]);
    ys.push(x.p[1]);
    const r = Math.floor(i / (m.cols + 1)), c = i % (m.cols + 1);
    // the curves stay inside their control points' hull
    for (let dir = 0; dir < 4; dir++)
      if (x.h?.[dir]) {
        const h = meshHandle(m, r, c, dir);
        if (h) xs.push(x.p[0] + h[0]), ys.push(x.p[1] + h[1]);
      }
  });
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

export interface MeshRaster {
  /** the box it covers, in the path's coordinates */
  x: number;
  y: number;
  w: number;
  h: number;
  /** pixels (RGBA, straight alpha): transparent outside the mesh */
  pw: number;
  ph: number;
  data: Uint8ClampedArray;
}

const rasterCache = new WeakMap<MeshFill, Map<number, MeshRaster>>();
const ease = (t: number) => t * t * (3 - 2 * t);

/** The mesh as pixels at `scale` px per unit (its longer side at most `maxPx`). */
export function meshRaster(m: MeshFill, scale: number, maxPx = 1600): MeshRaster {
  const b = meshBounds(m);
  const k = Math.max(0.01, Math.min(scale, maxPx / Math.max(1, b.w), maxPx / Math.max(1, b.h)));
  const key = Math.round(k * 64) / 64;
  let per = rasterCache.get(m);
  const hit = per?.get(key);
  if (hit) return hit;
  const pw = Math.max(1, Math.ceil(b.w * key)), ph = Math.max(1, Math.ceil(b.h * key));
  const data = new Uint8ClampedArray(pw * ph * 4);
  const cols = m.pts.map((x) => rgb(x.c));
  const tol = 0.02;
  for (let r = 0; r < m.rows; r++)
    for (let c = 0; c < m.cols; c++) {
      const C = [cols[meshIndex(m, r, c)], cols[meshIndex(m, r, c + 1)], cols[meshIndex(m, r + 1, c + 1)], cols[meshIndex(m, r + 1, c)]];
      const colorAt = (u: number, v: number, o: number) => {
        const uu = ease(Math.max(0, Math.min(1, u))), vv = ease(Math.max(0, Math.min(1, v)));
        const w00 = (1 - uu) * (1 - vv), w10 = uu * (1 - vv), w11 = uu * vv, w01 = (1 - uu) * vv;
        for (let ch = 0; ch < 3; ch++) data[o + ch] = C[0][ch] * w00 + C[1][ch] * w10 + C[2][ch] * w11 + C[3][ch] * w01;
        data[o + 3] = 255;
      };
      // the curved patch as an n × n grid of small quads, each filled by its own inverse bilinear map
      const corners = [pt(m, r, c).p, pt(m, r, c + 1).p, pt(m, r + 1, c + 1).p, pt(m, r + 1, c).p];
      let span = 0;
      for (let i = 0; i < 4; i++) span = Math.max(span, Math.hypot(corners[i][0] - corners[(i + 1) % 4][0], corners[i][1] - corners[(i + 1) % 4][1]));
      const n = Math.max(4, Math.min(48, Math.ceil((span * key) / 6)));
      const g = patchGrid(m, r, c, n).map((p) => [(p[0] - b.x) * key, (p[1] - b.y) * key] as Vec2);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          const q0 = j * (n + 1) + i;
          const Q = [g[q0], g[q0 + 1], g[q0 + n + 2], g[q0 + n + 1]];
          const x0 = Math.max(0, Math.floor(Math.min(Q[0][0], Q[1][0], Q[2][0], Q[3][0]))), x1 = Math.min(pw - 1, Math.ceil(Math.max(Q[0][0], Q[1][0], Q[2][0], Q[3][0])));
          const y0 = Math.max(0, Math.floor(Math.min(Q[0][1], Q[1][1], Q[2][1], Q[3][1]))), y1 = Math.min(ph - 1, Math.ceil(Math.max(Q[0][1], Q[1][1], Q[2][1], Q[3][1])));
          for (let y = y0; y <= y1; y++)
            for (let x = x0; x <= x1; x++) {
              const uv = inverseBilinear([x + 0.5, y + 0.5], Q[0], Q[1], Q[2], Q[3]);
              if (!uv) continue;
              const [su, sv] = uv;
              if (su < -tol || su > 1 + tol || sv < -tol || sv > 1 + tol) continue;
              const o = (y * pw + x) * 4;
              // (a pixel properly inside another small quad keeps that one's colour; edge pixels fill seams)
              if (data[o + 3] && !(su >= 0 && su <= 1 && sv >= 0 && sv <= 1)) continue;
              colorAt((i + su) / n, (j + sv) / n, o);
            }
        }
    }
  const out: MeshRaster = { ...b, pw, ph, data };
  if (!per) rasterCache.set(m, (per = new Map()));
  per.set(key, out);
  return out;
}

/** The mesh carried through a map of its coordinates (its path transformed): points and their handles. */
export function mapMesh(m: MeshFill, f: (p: Vec2) => Vec2): MeshFill {
  return {
    ...m,
    pts: m.pts.map((x) => {
      const p = f(x.p);
      return { p, c: x.c, ...(x.h ? { h: x.h.map((h) => (h ? sub(f(add(x.p, h)), p) : null)) } : {}) };
    }),
  };
}
