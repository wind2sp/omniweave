// Drawing geometry → Bézier contours: 2D affine matrices (OCS, block inserts, page mapping), arcs, bulges, ellipses,
// B-splines (exact Bézier pieces by knot insertion up to cubic, Hermite pieces otherwise). Pure math, no DOM.

import type { Contour, VectorAnchor, Vec2 } from "../../../core/types";
import type { P2, P3, PolyVertex } from "./model";

/** Affine map (x, y) → (a x + c y + e, b x + d y + f). */
export type Mat = [number, number, number, number, number, number];

export const IDENT: Mat = [1, 0, 0, 1, 0, 0];

/** m ∘ n: n first, then m. */
export function mul(m: Mat, n: Mat): Mat {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

export const translate = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];
export const scaleM = (sx: number, sy: number): Mat => [sx, 0, 0, sy, 0, 0];
export function rotateM(deg: number): Mat {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return [c, s, -s, c, 0, 0];
}

export const ap = (m: Mat, x: number, y: number): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** direction (no translation) */
export const av = (m: Mat, x: number, y: number): Vec2 => [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
export const det = (m: Mat) => m[0] * m[3] - m[1] * m[2];
/** mean length scale of the linear part */
export const scaleOf = (m: Mat) => Math.sqrt(Math.abs(det(m))) || 1;

/**
 * OCS → WCS (x, y) for an extrusion normal (AutoCAD's arbitrary axis algorithm); `elev` is the OCS z of the shape.
 * Identity for the +Z normal.
 */
export function ocs(n: P3 | undefined, elev = 0): Mat {
  if (!n) return IDENT;
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const N: P3 = [n[0] / len, n[1] / len, n[2] / len];
  const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: P3): P3 => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const Ax = norm(Math.abs(N[0]) < 1 / 64 && Math.abs(N[1]) < 1 / 64 ? cross([0, 1, 0], N) : cross([0, 0, 1], N));
  const Ay = norm(cross(N, Ax));
  return [Ax[0], Ax[1], Ay[0], Ay[1], N[0] * elev, N[1] * elev];
}

// ───────── path builder ─────────

/** Builds contours through a matrix (affine maps keep Bézier curves exact). */
export class PathBuilder {
  contours: Contour[] = [];
  private cur: VectorAnchor[] | null = null;
  constructor(public m: Mat = IDENT) {}
  private pt(x: number, y: number): Vec2 {
    return ap(this.m, x, y);
  }
  move(x: number, y: number) {
    this.end();
    const p = this.pt(x, y);
    this.cur = [{ anchor: p, handleIn: p, handleOut: p, isCorner: true }];
  }
  line(x: number, y: number) {
    if (!this.cur) return this.move(x, y);
    const p = this.pt(x, y);
    this.cur.push({ anchor: p, handleIn: p, handleOut: p, isCorner: true });
  }
  /** cubic to (x, y); `smoothStart` marks the joint at the current point as tangent-continuous */
  cubic(x1: number, y1: number, x2: number, y2: number, x: number, y: number, smoothStart = false) {
    if (!this.cur) this.move(x1, y1);
    const last = this.cur![this.cur!.length - 1];
    last.handleOut = this.pt(x1, y1);
    if (smoothStart) last.isCorner = false;
    const p = this.pt(x, y);
    this.cur!.push({ anchor: p, handleIn: this.pt(x2, y2), handleOut: p, isCorner: true });
  }
  close() {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    if (c.length > 1) {
      const a = c[0], z = c[c.length - 1];
      if (Math.abs(a.anchor[0] - z.anchor[0]) < 1e-9 && Math.abs(a.anchor[1] - z.anchor[1]) < 1e-9) {
        a.handleIn = z.handleIn;
        c.pop();
      }
    }
    this.contours.push({ nodes: c, closed: true });
  }
  end() {
    if (this.cur && this.cur.length) this.contours.push({ nodes: this.cur, closed: false });
    this.cur = null;
  }
  get pen(): Vec2 | null {
    const c = this.cur;
    return c ? c[c.length - 1].anchor : null;
  }
  done(): Contour[] {
    this.end();
    return this.contours;
  }
}

/**
 * Elliptic arc c + u cos t + v sin t for t from t0 to t1 (any sign of sweep), as cubic pieces of at most 90°.
 * Starts with a move unless `join` (the pen is already at the start point).
 */
/**
 * The end angle (radians) of an arc from a0 to a1 going counter-clockwise (or clockwise): a0 plus a sweep in (0, 2π]
 * (clockwise [-2π, 0)). Found by remainder, not by adding 2π in a loop — a damaged angle such as 1e308° made that loop
 * endless, and −2147483648° made a sweep of millions of turns (QA cad-verify fuzz, omni-cad-20).
 */
export function arcEnd(a0: number, a1: number, ccw = true): number {
  if (!Number.isFinite(a0) || !Number.isFinite(a1)) return a0;
  const T = Math.PI * 2;
  let d = (a1 - a0) % T;
  if (ccw && d <= 0) d += T;
  else if (!ccw && d >= 0) d -= T;
  return a0 + d;
}

export function arcTo(b: PathBuilder, c: P2, u: P2, v: P2, t0: number, t1: number, join = false) {
  const P = (t: number): P2 => [c[0] + u[0] * Math.cos(t) + v[0] * Math.sin(t), c[1] + u[1] * Math.cos(t) + v[1] * Math.sin(t)];
  const D = (t: number): P2 => [-u[0] * Math.sin(t) + v[0] * Math.cos(t), -u[1] * Math.sin(t) + v[1] * Math.cos(t)];
  // an angle that is not a number (damaged): nothing to draw
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return;
  // a full turn at most (more draws nothing new; a damaged angle must not make millions of pieces)
  const sweep = Number.isFinite(t1 - t0) ? Math.max(-Math.PI * 2, Math.min(Math.PI * 2, t1 - t0)) : 0;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const h = sweep / n;
  const k = (4 / 3) * Math.tan(h / 4);
  const s = P(t0);
  if (!join) b.move(s[0], s[1]);
  else {
    // continue from the pen; a line only when it is not already at the start
    const pen = b.pen, q = ap(b.m, s[0], s[1]);
    if (!pen || Math.hypot(pen[0] - q[0], pen[1] - q[1]) > 1e-9 * (1 + Math.abs(q[0]) + Math.abs(q[1]))) b.line(s[0], s[1]);
  }
  for (let i = 0; i < n; i++) {
    const a = t0 + i * h, e = a + h;
    const pa = P(a), pe = P(e), da = D(a), de = D(e);
    b.cubic(pa[0] + k * da[0], pa[1] + k * da[1], pe[0] - k * de[0], pe[1] - k * de[1], pe[0], pe[1], i > 0);
  }
}

/** Arc of a polyline segment with bulge (tan of a quarter of the included angle, + = counter-clockwise). */
export function bulgeTo(b: PathBuilder, p0: P2, p1: P2, bulge: number) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  const d = Math.hypot(dx, dy);
  if (!bulge || d < 1e-12) return b.line(p1[0], p1[1]);
  const off = (d * (1 - bulge * bulge)) / (4 * bulge);
  const c: P2 = [(p0[0] + p1[0]) / 2 - (dy / d) * off, (p0[1] + p1[1]) / 2 + (dx / d) * off];
  const r = Math.hypot(p0[0] - c[0], p0[1] - c[1]);
  const a0 = Math.atan2(p0[1] - c[1], p0[0] - c[0]);
  arcTo(b, c, [r, 0], [0, r], a0, a0 + 4 * Math.atan(bulge), true);
}

/** Polyline with bulges; `closed` adds the closing segment (with the last vertex's bulge). */
export function polyPath(b: PathBuilder, pts: PolyVertex[], closed: boolean) {
  if (!pts.length) return;
  b.move(pts[0].x, pts[0].y);
  const n = pts.length;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) {
    const a = pts[i - 1], z = pts[i % n];
    bulgeTo(b, [a.x, a.y], [z.x, z.y], a.bulge ?? 0);
  }
  if (closed) b.close();
  else b.end();
}

// ───────── splines ─────────

type H = number[]; // homogeneous point [x w, y w, w]

/** Insert knot u once into a B-spline of degree p (Boehm). */
function insertKnot(p: number, U: number[], P: H[], u: number): { U: number[]; P: H[] } {
  let k = p;
  while (k < U.length - p - 2 && U[k + 1] <= u) k++;
  const Q: H[] = [];
  for (let i = 0; i <= k - p; i++) Q.push(P[i]);
  for (let i = k - p + 1; i <= k; i++) {
    const den = U[i + p] - U[i];
    const a = den > 0 ? (u - U[i]) / den : 0;
    Q.push(P[i - 1].map((v, j) => (1 - a) * v + a * P[i][j]));
  }
  for (let i = k; i < P.length; i++) Q.push(P[i]);
  return { U: [...U.slice(0, k + 1), u, ...U.slice(k + 1)], P: Q };
}

/** Bézier pieces (p + 1 homogeneous points each) of a B-spline over its domain [U[p], U[n]]. */
export function bezierPieces(p: number, knots: number[], ctrl: H[]): H[][] {
  let U = knots.slice();
  let P = ctrl.slice();
  const n = P.length;
  if (U.length !== n + p + 1) {
    // missing or inconsistent knots: clamped uniform
    U = [];
    for (let i = 0; i <= n + p; i++) U.push(i <= p ? 0 : i >= n ? n - p : i - p);
  }
  const lo = U[p], hi = U[U.length - p - 1];
  const values = [...new Set(U.filter((u) => u >= lo && u <= hi))];
  for (const u of values) {
    const mult = U.filter((x) => x === u).length;
    for (let m = mult; m < p; m++) ({ U, P } = insertKnot(p, U, P, u));
  }
  const pieces: H[][] = [];
  for (let k = p; k < U.length - p - 1; k++) if (U[k] < U[k + 1] && k - p >= 0 && k < P.length) pieces.push(P.slice(k - p, k + 1));
  return pieces;
}

function deCasteljau(pts: H[], t: number): H {
  const q = pts.map((x) => x.slice());
  for (let r = 1; r < q.length; r++) for (let i = 0; i < q.length - r; i++) q[i] = q[i].map((v, j) => (1 - t) * v + t * q[i + 1][j]);
  return q[0];
}

const proj = (h: H): P2 => [h[0] / (h[2] || 1), h[1] / (h[2] || 1)];

/** Append one Bézier piece of any degree (rational or not) to the builder (pen at its start). */
function pieceTo(b: PathBuilder, q: H[], first: boolean) {
  const rational = q.some((h) => Math.abs(h[2] - q[0][2]) > 1e-12);
  const pts = q.map(proj);
  if (first) b.move(pts[0][0], pts[0][1]);
  if (!rational && q.length === 2) return b.line(pts[1][0], pts[1][1]);
  if (!rational && q.length === 3) {
    const [p0, p1, p2] = pts;
    return b.cubic(p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1]), p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1]), p2[0], p2[1], !first);
  }
  if (!rational && q.length === 4) return b.cubic(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1], !first);
  // rational or higher degree: Hermite cubics through 4 sub-pieces
  const N = 4;
  const at = (t: number) => proj(deCasteljau(q, t));
  const der = (t: number): P2 => {
    const e = 1e-4;
    const a = at(Math.max(0, t - e)), z = at(Math.min(1, t + e));
    const dt = Math.min(1, t + e) - Math.max(0, t - e);
    return [(z[0] - a[0]) / dt, (z[1] - a[1]) / dt];
  };
  for (let i = 0; i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N, h = t1 - t0;
    const p0 = at(t0), p1 = at(t1), d0 = der(t0), d1 = der(t1);
    b.cubic(p0[0] + (d0[0] * h) / 3, p0[1] + (d0[1] * h) / 3, p1[0] - (d1[0] * h) / 3, p1[1] - (d1[1] * h) / 3, p1[0], p1[1], !first || i > 0);
  }
}

/** A B-spline (control points, optional weights) as Bézier contour pieces. */
export function splinePath(b: PathBuilder, degree: number, knots: number[], ctrl: P2[], weights?: number[]) {
  if (ctrl.length < 2) return;
  const p = Math.max(1, Math.min(degree, ctrl.length - 1));
  const H = ctrl.map((c, i) => {
    const w = weights?.[i] ?? 1;
    return [c[0] * w, c[1] * w, w];
  });
  const pieces = bezierPieces(p, knots, H);
  pieces.forEach((q, i) => pieceTo(b, q, i === 0));
}

/** B-spline basis functions of degree p at u (knot span found by search), Cox–de Boor. */
function basisAt(U: number[], p: number, n: number, u: number, deriv: number): number[] {
  const out = new Array(n).fill(0);
  const N = (i: number, q: number, d: number): number => {
    if (d > 0) {
      const a = U[i + q] - U[i], b = U[i + q + 1] - U[i + 1];
      return (a ? (q / a) * N(i, q - 1, d - 1) : 0) - (b ? (q / b) * N(i + 1, q - 1, d - 1) : 0);
    }
    if (q === 0) {
      const last = u >= U[U.length - 1];
      return (U[i] <= u && u < U[i + 1]) || (last && U[i] < u && u <= U[i + 1]) ? 1 : 0;
    }
    const a = U[i + q] - U[i], b = U[i + q + 1] - U[i + 1];
    return (a ? ((u - U[i]) / a) * N(i, q - 1, 0) : 0) + (b ? ((U[i + q + 1] - u) / b) * N(i + 1, q - 1, 0) : 0);
  };
  for (let i = 0; i < n; i++) out[i] = N(i, p, deriv);
  return out;
}

/**
 * The cubic B-spline AutoCAD makes through fit points (SPLINE saved with fit data only, as DWG keeps it): knots by
 * chord length, clamped ends; end conditions: the given start / end tangents as first derivatives, natural
 * (zero second derivative) where none is given. Checked against the control points AutoCAD writes to DXF.
 */
export function fitSplineCtrl(fit: P2[], tan0?: P2, tan1?: P2): { knots: number[]; ctrl: P2[] } | null {
  const n = fit.length - 1;
  if (n < 1) return null;
  const d = [0];
  for (let i = 1; i <= n; i++) d.push(d[i - 1] + Math.hypot(fit[i][0] - fit[i - 1][0], fit[i][1] - fit[i - 1][1]));
  if (!(d[n] > 0)) return null;
  const U = [0, 0, 0, 0, ...d.slice(1, n), d[n], d[n], d[n], d[n]];
  const m = n + 3;
  const A: number[][] = [], B: P2[] = [];
  for (let k = 0; k <= n; k++) {
    A.push(basisAt(U, 3, m, d[k], 0));
    B.push([fit[k][0], fit[k][1]]);
  }
  const eps = d[n] * 1e-12;
  const has = (t?: P2) => !!t && Math.hypot(t[0], t[1]) > 1e-12;
  A.push(basisAt(U, 3, m, d[0] + eps, has(tan0) ? 1 : 2));
  B.push(has(tan0) ? [tan0![0], tan0![1]] : [0, 0]);
  A.push(basisAt(U, 3, m, d[n] - eps, has(tan1) ? 1 : 2));
  B.push(has(tan1) ? [tan1![0], tan1![1]] : [0, 0]);
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < m; c++) {
    let piv = c;
    for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-14) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    [B[c], B[piv]] = [B[piv], B[c]];
    for (let r = 0; r < m; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < m; k++) A[r][k] -= f * A[c][k];
      B[r] = [B[r][0] - f * B[c][0], B[r][1] - f * B[c][1]];
    }
  }
  const ctrl = B.map((b, i) => [b[0] / A[i][i], b[1] / A[i][i]] as P2);
  ctrl[0] = [fit[0][0], fit[0][1]];
  ctrl[m - 1] = [fit[n][0], fit[n][1]];
  return { knots: U, ctrl };
}

/** A curve through fit points (Catmull-Rom tangents), for splines saved with fit points only. */
export function fitPath(b: PathBuilder, pts: P2[], closed: boolean) {
  const n = pts.length;
  if (n < 2) return;
  const at = (i: number) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  b.move(pts[0][0], pts[0][1]);
  const last = closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    b.cubic(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1], i > 0);
  }
  if (closed) b.close();
  else b.end();
}

// ───────── flattening (hatch patterns) ─────────

/** Polygon rings of contours (curves subdivided). */
export function rings(contours: Contour[], segs = 8): P2[][] {
  return contours.map((c) => {
    const out: P2[] = [];
    const N = c.nodes.length;
    const count = c.closed ? N : N - 1;
    if (N) out.push([c.nodes[0].anchor[0], c.nodes[0].anchor[1]]);
    for (let i = 0; i < count; i++) {
      const a = c.nodes[i], z = c.nodes[(i + 1) % N];
      const straight = a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] && z.handleIn[0] === z.anchor[0] && z.handleIn[1] === z.anchor[1];
      if (straight) out.push([z.anchor[0], z.anchor[1]]);
      else
        for (let s = 1; s <= segs; s++) {
          const t = s / segs, u = 1 - t;
          const A = u * u * u, B = 3 * u * u * t, C = 3 * u * t * t, D = t * t * t;
          out.push([A * a.anchor[0] + B * a.handleOut[0] + C * z.handleIn[0] + D * z.anchor[0], A * a.anchor[1] + B * a.handleOut[1] + C * z.handleIn[1] + D * z.anchor[1]]);
        }
    }
    return out;
  });
}

/**
 * Visible edges of a polyface mesh: vertices, and faces of up to four 1-based corner indices where a negative index
 * hides the edge that starts at that corner (DXF 71–74, DWG VERTEX_PFACE_FACE). Shared edges are kept once.
 */
export function polyfaceEdges(pts: P3[], faces: number[][]): [P3, P3][] {
  const out: [P3, P3][] = [];
  const seen = new Set<string>();
  for (const f of faces) {
    const idx = f.filter((x) => x !== 0);
    for (let i = 0; i < idx.length; i++) {
      if (idx[i] < 0) continue;
      const a = Math.abs(idx[i]) - 1, b = Math.abs(idx[(i + 1) % idx.length]) - 1;
      if (!pts[a] || !pts[b] || a === b) continue;
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([pts[a], pts[b]]);
    }
  }
  return out;
}
