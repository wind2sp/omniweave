// Drawing geometry for the drawing screen (docs/design/CAD_SCREEN.md): drawing coordinates (WCS, y up, drawing units),
// segments of VECTOR nodes (lines and cubic Béziers), object-snap points, intersections, splitting for TRIM, arcs as
// Béziers, and the AutoCAD coordinate entry the command line takes (x,y · @dx,dy · @d<a · d<a · direct distance).
// Pure: no store, no DOM — tests/cad/cadScreen.test.ts.

import type { CadSourceMeta, Contour, SceneNode, VectorAnchor, VectorNode } from "../../core/types";
import { applyTransform } from "../../core/geom";

export type W = [number, number];
/** Affine map [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (canvas order). */
export type Mat = [number, number, number, number, number, number];

export const I: Mat = [1, 0, 0, 1, 0, 0];
export const mul = (m: Mat, n: Mat): Mat => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
export const ap = (m: Mat, p: readonly number[]): W => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
export const translate = (dx: number, dy: number): Mat => [1, 0, 0, 1, dx, dy];
export function rotateAbout(c: W, rad: number): Mat {
  const co = Math.cos(rad), si = Math.sin(rad);
  return [co, si, -si, co, c[0] - co * c[0] + si * c[1], c[1] - si * c[0] - co * c[1]];
}
export const scaleAbout = (c: W, s: number): Mat => [s, 0, 0, s, c[0] * (1 - s), c[1] * (1 - s)];
/** Reflection in the line through a and b. */
export function mirrorLine(a: W, b: W): Mat {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l = dx * dx + dy * dy || 1;
  const c = (dx * dx - dy * dy) / l, s = (2 * dx * dy) / l;
  return mul(translate(a[0], a[1]), mul([c, s, s, -c, 0, 0], translate(-a[0], -a[1])));
}

/** Page px ↔ drawing coordinates as matrices. */
export const pageToW = (cad: Pick<CadSourceMeta, "k" | "ox" | "oy">): Mat => [1 / cad.k, 0, 0, -1 / cad.k, cad.ox, cad.oy];
export const wToPage = (cad: Pick<CadSourceMeta, "k" | "ox" | "oy">): Mat => [cad.k, 0, 0, -cad.k, -cad.ox * cad.k, cad.oy * cad.k];

export const sub = (a: W, b: W): W => [a[0] - b[0], a[1] - b[1]];
export const add = (a: W, b: W): W => [a[0] + b[0], a[1] + b[1]];
export const dist = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const lerp = (a: W, b: W, t: number): W => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
export const angleOf = (a: W, b: W) => Math.atan2(b[1] - a[1], b[0] - a[0]);
export const polar = (a: W, d: number, rad: number): W => [a[0] + d * Math.cos(rad), a[1] + d * Math.sin(rad)];
export const deg = (rad: number) => ((((rad * 180) / Math.PI) % 360) + 360) % 360;

// ───────── segments ─────────

/** One piece of a contour in drawing coordinates: a line (no c1 / c2) or a cubic Bézier. */
export interface Seg {
  a: W;
  b: W;
  c1?: W;
  c2?: W;
  /** node, contour index, segment index (segment i runs from anchor i to anchor i+1) */
  id: string;
  ci: number;
  si: number;
}

const same = (p: readonly number[], q: readonly number[]) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;

/** Segments of a contour mapped by m (node-local → drawing). */
export function contourSegs(c: Contour, m: Mat, id = "", ci = 0): Seg[] {
  const out: Seg[] = [];
  const n = c.nodes.length;
  const last = c.closed ? n : n - 1;
  for (let i = 0; i < last; i++) {
    const p = c.nodes[i], q = c.nodes[(i + 1) % n];
    const straight = same(p.handleOut, p.anchor) && same(q.handleIn, q.anchor);
    const s: Seg = { a: ap(m, p.anchor), b: ap(m, q.anchor), id, ci, si: i };
    if (!straight) {
      s.c1 = ap(m, p.handleOut);
      s.c2 = ap(m, q.handleIn);
    }
    if (!straight || dist(s.a, s.b) > 1e-12) out.push(s);
  }
  return out;
}

/** Node-local → page px of a node's transform as a matrix. */
export function nodeMat(n: SceneNode): Mat {
  const o = applyTransform(n.transform, [0, 0]), x = applyTransform(n.transform, [1, 0]), y = applyTransform(n.transform, [0, 1]);
  return [x[0] - o[0], x[1] - o[1], y[0] - o[0], y[1] - o[1], o[0], o[1]];
}

const segMemo = new WeakMap<object, { k: number; segs: Seg[] }>();
/** All segments of a VECTOR node in drawing coordinates (memoized per node object). */
export function nodeSegs(n: VectorNode, cad: Pick<CadSourceMeta, "k" | "ox" | "oy">): Seg[] {
  const hit = segMemo.get(n);
  if (hit && hit.k === cad.k + cad.ox * 1e-3 + cad.oy * 1e-6) return hit.segs;
  const m = mul(pageToW(cad), nodeMat(n));
  const segs = n.contours.flatMap((c, ci) => contourSegs(c, m, n.id, ci));
  segMemo.set(n, { k: cad.k + cad.ox * 1e-3 + cad.oy * 1e-6, segs });
  return segs;
}

export function bez(s: Seg, t: number): W {
  if (!s.c1 || !s.c2) return lerp(s.a, s.b, t);
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [k0 * s.a[0] + k1 * s.c1[0] + k2 * s.c2[0] + k3 * s.b[0], k0 * s.a[1] + k1 * s.c1[1] + k2 * s.c2[1] + k3 * s.b[1]];
}

/** Tangent direction at t. */
export function tangent(s: Seg, t: number): W {
  if (!s.c1 || !s.c2) return sub(s.b, s.a);
  const u = 1 - t;
  const d: W = [
    3 * u * u * (s.c1[0] - s.a[0]) + 6 * u * t * (s.c2[0] - s.c1[0]) + 3 * t * t * (s.b[0] - s.c2[0]),
    3 * u * u * (s.c1[1] - s.a[1]) + 6 * u * t * (s.c2[1] - s.c1[1]) + 3 * t * t * (s.b[1] - s.c2[1]),
  ];
  return Math.hypot(d[0], d[1]) < 1e-12 ? sub(s.b, s.a) : d;
}

/** Points along a segment (t, point), finer for curves. */
export function flat(s: Seg, n = 16): { t: number; p: W }[] {
  if (!s.c1) return [
    { t: 0, p: s.a },
    { t: 1, p: s.b },
  ];
  const out = [];
  for (let i = 0; i <= n; i++) out.push({ t: i / n, p: bez(s, i / n) });
  return out;
}

export function segLength(s: Seg): number {
  if (!s.c1) return dist(s.a, s.b);
  const f = flat(s, 32);
  let l = 0;
  for (let i = 1; i < f.length; i++) l += dist(f[i - 1].p, f[i].p);
  return l;
}

/** The circle a cubic segment draws, when it is a circular arc (imported circles, arcs and bulges). */
export function arcOf(s: Seg): { c: W; r: number } | null {
  if (!s.c1) return null;
  const p0 = s.a, p1 = bez(s, 0.5), p2 = s.b;
  const c = circumcenter(p0, p1, p2);
  if (!c) return null;
  const r = dist(c, p0);
  if (!(r > 0) || !isFinite(r)) return null;
  for (const t of [0.25, 0.75]) if (Math.abs(dist(c, bez(s, t)) - r) > r * 2e-3) return null;
  return { c, r };
}

export function circumcenter(a: W, b: W, c: W): W | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] * a[0] + a[1] * a[1], b2 = b[0] * b[0] + b[1] * b[1], c2 = c[0] * c[0] + c[1] * c[1];
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

/** Closest point of a segment to p. */
export function nearest(s: Seg, p: W): { p: W; t: number; d: number } {
  if (!s.c1) {
    const v = sub(s.b, s.a);
    const l = v[0] * v[0] + v[1] * v[1];
    const t = l ? Math.max(0, Math.min(1, ((p[0] - s.a[0]) * v[0] + (p[1] - s.a[1]) * v[1]) / l)) : 0;
    const q = lerp(s.a, s.b, t);
    return { p: q, t, d: dist(p, q) };
  }
  let best = { p: s.a, t: 0, d: Infinity };
  for (let i = 0; i <= 24; i++) {
    const q = bez(s, i / 24), d = dist(p, q);
    if (d < best.d) best = { p: q, t: i / 24, d };
  }
  // refine
  let step = 1 / 48;
  for (let k = 0; k < 12; k++) {
    for (const t of [best.t - step, best.t + step]) {
      if (t < 0 || t > 1) continue;
      const q = bez(s, t), d = dist(p, q);
      if (d < best.d) best = { p: q, t, d };
    }
    step /= 2;
  }
  return best;
}

function lineX(a: W, b: W, c: W, d: W): { t: number; u: number } | null {
  const r = sub(b, a), s = sub(d, c);
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-14) return null;
  const q = sub(c, a);
  return { t: (q[0] * s[1] - q[1] * s[0]) / den, u: (q[0] * r[1] - q[1] * r[0]) / den };
}

/** Intersections of two segments: points with the parameter on each. `extendA` treats a line `s` as unbounded. */
export function intersect(s: Seg, o: Seg, extendA = false): { p: W; t: number; u: number }[] {
  const out: { p: W; t: number; u: number }[] = [];
  const fs = flat(s, 24), fo = flat(o, 24);
  for (let i = 1; i < fs.length; i++)
    for (let j = 1; j < fo.length; j++) {
      const x = lineX(fs[i - 1].p, fs[i].p, fo[j - 1].p, fo[j].p);
      if (!x) continue;
      const okA = extendA && !s.c1 ? true : x.t >= -1e-9 && x.t <= 1 + 1e-9;
      if (!okA || x.u < -1e-9 || x.u > 1 + 1e-9) continue;
      const t = fs[i - 1].t + (fs[i].t - fs[i - 1].t) * x.t;
      const u = fo[j - 1].t + (fo[j].t - fo[j - 1].t) * x.u;
      const p = lerp(fs[i - 1].p, fs[i].p, x.t);
      if (!out.some((q) => dist(q.p, p) < 1e-9)) out.push({ p, t, u });
    }
  return out;
}

// ───────── object snap ─────────

export type SnapKind = "end" | "mid" | "cen" | "int" | "per" | "tan" | "nea";
export const SNAP_KINDS: SnapKind[] = ["end", "mid", "cen", "int", "per", "tan", "nea"];
export interface SnapHit {
  kind: SnapKind;
  p: W;
}

/**
 * The object snap for cursor `p` among `segs` (already the ones near the cursor), within `ap` drawing units.
 * `from` is the last point picked (perpendicular and tangent need it). Priority: the closest candidate, kinds in
 * AutoCAD's order break ties.
 */
export function osnap(segs: Seg[], p: W, apR: number, on: Partial<Record<SnapKind, boolean>>, from?: W | null): SnapHit | null {
  const cand: SnapHit[] = [];
  for (const s of segs) {
    if (on.end) cand.push({ kind: "end", p: s.a }, { kind: "end", p: s.b });
    const arc = arcOf(s);
    if (on.mid) cand.push({ kind: "mid", p: bez(s, 0.5) });
    if (on.cen && arc) cand.push({ kind: "cen", p: arc.c });
    if (on.per && from) {
      if (!s.c1) {
        const v = sub(s.b, s.a), l = v[0] * v[0] + v[1] * v[1];
        if (l) {
          const t = ((from[0] - s.a[0]) * v[0] + (from[1] - s.a[1]) * v[1]) / l;
          if (t >= 0 && t <= 1) cand.push({ kind: "per", p: lerp(s.a, s.b, t) });
        }
      } else if (arc) {
        const d = dist(from, arc.c);
        if (d > 1e-12) for (const sg of [1, -1]) {
          const q = polar(arc.c, arc.r, angleOf(arc.c, from) + (sg < 0 ? Math.PI : 0));
          if (nearest(s, q).d < arc.r * 1e-3) cand.push({ kind: "per", p: q });
        }
      }
    }
    if (on.tan && from && arc) {
      const d = dist(from, arc.c);
      if (d > arc.r) {
        const base = angleOf(arc.c, from), off = Math.acos(arc.r / d);
        for (const a of [base + off, base - off]) {
          const q = polar(arc.c, arc.r, a);
          if (nearest(s, q).d < arc.r * 1e-3) cand.push({ kind: "tan", p: q });
        }
      }
    }
  }
  if (on.int)
    for (let i = 0; i < segs.length; i++)
      for (let j = i + 1; j < segs.length; j++) {
        if (segs[i].id === segs[j].id && segs[i].ci === segs[j].ci && Math.abs(segs[i].si - segs[j].si) <= 1) continue;
        for (const x of intersect(segs[i], segs[j])) cand.push({ kind: "int", p: x.p });
      }
  const order: SnapKind[] = ["end", "int", "cen", "mid", "per", "tan", "nea"];
  let best: SnapHit | null = null, bd = Infinity;
  for (const c of cand) {
    const d = dist(c.p, p);
    if (d > apR) continue;
    if (d < bd - apR * 0.05 || (Math.abs(d - bd) <= apR * 0.05 && best && order.indexOf(c.kind) < order.indexOf(best.kind))) {
      best = c;
      bd = d;
    }
  }
  if (!best && on.nea) {
    for (const s of segs) {
      const q = nearest(s, p);
      if (q.d <= apR && q.d < bd) {
        best = { kind: "nea", p: q.p };
        bd = q.d;
      }
    }
  }
  return best;
}

/** Ortho (F8) / polar tracking (F10): the cursor pulled onto 90° or the polar increment from `base`. */
export function constrain(base: W, p: W, ortho: boolean, polarDeg: number | null, polarTol = 5): W {
  const d = dist(base, p);
  if (d < 1e-12) return p;
  const a = deg(angleOf(base, p));
  if (ortho) {
    const s = Math.round(a / 90) * 90;
    return polar(base, d, (s * Math.PI) / 180);
  }
  if (polarDeg) {
    const s = Math.round(a / polarDeg) * polarDeg;
    if (Math.abs(a - s) <= polarTol) {
      // keep the distance along the tracking ray (projection)
      const rad = (s * Math.PI) / 180;
      const l = (p[0] - base[0]) * Math.cos(rad) + (p[1] - base[1]) * Math.sin(rad);
      return polar(base, l, rad);
    }
  }
  return p;
}

// ───────── coordinate entry ─────────

export type Entry = { k: "point"; p: W } | { k: "number"; v: number } | null;

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const RE_XY = new RegExp(`^(@|#)?\\s*(${NUM})\\s*,\\s*(${NUM})(?:\\s*,\\s*${NUM})?$`);
const RE_POLAR = new RegExp(`^(@|#)?\\s*(${NUM})\\s*<\\s*(${NUM})$`);
const RE_NUM = new RegExp(`^(${NUM})$`);

/**
 * AutoCAD point entry: "x,y" absolute, "@dx,dy" relative to the last point, "d<a" polar from the origin,
 * "@d<a" polar from the last point (degrees, counter-clockwise from +X), "@" the last point itself, "#x,y" absolute.
 * A bare number is a distance (direct distance entry along the cursor, or a value the prompt asks for).
 */
export function parseEntry(text: string, last: W | null): Entry {
  const s = text.trim();
  if (s === "@") return last ? { k: "point", p: [...last] as W } : null;
  let m = RE_XY.exec(s);
  if (m) {
    const x = Number(m[2]), y = Number(m[3]);
    if (m[1] === "@") return last ? { k: "point", p: [last[0] + x, last[1] + y] } : { k: "point", p: [x, y] };
    return { k: "point", p: [x, y] };
  }
  m = RE_POLAR.exec(s);
  if (m) {
    const d = Number(m[2]), a = (Number(m[3]) * Math.PI) / 180;
    const o: W = m[1] === "@" && last ? last : [0, 0];
    return { k: "point", p: polar(o, d, a) };
  }
  m = RE_NUM.exec(s);
  if (m) return { k: "number", v: Number(m[1]) };
  return null;
}

/** A number shown in the drawing's units (up to 4 decimals, AutoCAD LUPREC 4). */
export function fmt(v: number, digits = 4): string {
  const s = (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

// ───────── building contours ─────────

const A = (p: W): VectorAnchor => ({ anchor: [...p] as W, handleIn: [...p] as W, handleOut: [...p] as W, isCorner: true });

/** A polyline contour through drawing points, mapped to page px by m. */
export function polyContour(pts: W[], closed: boolean, m: Mat): Contour {
  return { closed, nodes: pts.map((p) => A(ap(m, p))) };
}

/**
 * A circular arc from angle a0 to a1 (radians, counter-clockwise when a1 > a0) as Bézier anchors in drawing
 * coordinates, pieces of at most 90°. full = a whole circle (closed contour).
 */
export function arcAnchors(c: W, r: number, a0: number, a1: number): VectorAnchor[] {
  const sweep = a1 - a0;
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const d = sweep / n;
  const k = (4 / 3) * Math.tan(d / 4) * r;
  const out: VectorAnchor[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + d * i;
    const p = polar(c, r, a);
    const t: W = [-Math.sin(a) * k, Math.cos(a) * k];
    out.push({ anchor: p, handleIn: i ? sub(p, t) : p, handleOut: i < n ? add(p, t) : p, isCorner: false });
  }
  out[0].isCorner = out[n].isCorner = true;
  return out;
}

export function mapAnchors(nodes: VectorAnchor[], m: Mat): VectorAnchor[] {
  return nodes.map((q) => ({ anchor: ap(m, q.anchor), handleIn: ap(m, q.handleIn), handleOut: ap(m, q.handleOut), isCorner: q.isCorner }));
}

export function circleContour(c: W, r: number, m: Mat): Contour {
  const nodes = arcAnchors(c, r, 0, 2 * Math.PI);
  nodes.pop();
  const a = nodes[0];
  a.handleIn = sub(a.anchor, [0, (4 / 3) * Math.tan(Math.PI / 8) * r]);
  for (const q of nodes) q.isCorner = false;
  return { closed: true, nodes: mapAnchors(nodes, m) };
}

/** Arc through three points (start, any point on it, end): centre, radius and angles (a1 follows the sweep). */
export function arc3(p0: W, p1: W, p2: W): { c: W; r: number; a0: number; a1: number } | null {
  const c = circumcenter(p0, p1, p2);
  if (!c) return null;
  const r = dist(c, p0);
  const a0 = angleOf(c, p0);
  let am = angleOf(c, p1), a2 = angleOf(c, p2);
  const norm = (x: number) => ((x - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(am) < norm(a2);
  let a1 = a0 + norm(a2);
  if (!ccw) a1 = a1 - 2 * Math.PI;
  void am;
  return { c, r, a0, a1 };
}

// ───────── splitting (TRIM) ─────────

function splitBez(s: Seg, t: number): [Seg, Seg] {
  if (!s.c1 || !s.c2) {
    const m = lerp(s.a, s.b, t);
    return [{ ...s, b: m }, { ...s, a: m }];
  }
  const p01 = lerp(s.a, s.c1, t), p12 = lerp(s.c1, s.c2, t), p23 = lerp(s.c2, s.b, t);
  const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), m = lerp(p012, p123, t);
  return [
    { ...s, b: m, c1: p01, c2: p012 },
    { ...s, a: m, c1: p123, c2: p23 },
  ];
}

/** The part of segment s between t0 and t1. */
export function segPart(s: Seg, t0: number, t1: number): Seg {
  let x = s;
  if (t1 < 1) x = splitBez(x, t1)[0];
  if (t0 > 0) x = splitBez(x, t0 / (t1 || 1))[1];
  return x;
}

/** Segments → contour (drawing coordinates, mapped by m). Consecutive segments share their joints. */
export function segsToContour(segs: Seg[], closed: boolean, m: Mat): Contour {
  const nodes: VectorAnchor[] = [];
  segs.forEach((s, i) => {
    if (i === 0) nodes.push({ anchor: s.a, handleIn: s.a, handleOut: s.c1 ?? s.a, isCorner: true });
    else nodes[nodes.length - 1].handleOut = s.c1 ?? s.a;
    nodes.push({ anchor: s.b, handleIn: s.c2 ?? s.b, handleOut: s.b, isCorner: true });
  });
  if (closed && nodes.length > 1 && dist(nodes[0].anchor, nodes[nodes.length - 1].anchor) < 1e-9) {
    const l = nodes.pop()!;
    nodes[0].handleIn = l.handleIn;
  }
  return { closed, nodes: mapAnchors(nodes, m) };
}

/**
 * TRIM one contour (its segments `segs`, in order) at the cut parameters `cuts` (segment index + t), removing the
 * piece that holds `pick` (same form). Returns the remaining pieces as lists of segments; null when nothing bounds the
 * picked piece (AutoCAD then deletes the object in Quick mode).
 */
export function trimContour(segs: Seg[], closed: boolean, cuts: number[], pick: number): Seg[][] | null {
  const n = segs.length;
  const cs = [...new Set(cuts.filter((u) => u > 1e-7 && u < n - 1e-7 || (closed && u >= 0 && u < n)).map((u) => Math.round(u * 1e9) / 1e9))].sort((a, b) => a - b);
  const part = (u0: number, u1: number): Seg[] => {
    const out: Seg[] = [];
    for (let i = Math.floor(u0); i < Math.ceil(u1) && i < n; i++) {
      const t0 = Math.max(0, u0 - i), t1 = Math.min(1, u1 - i);
      if (t1 - t0 > 1e-9) out.push(segPart(segs[i], t0, t1));
    }
    return out;
  };
  if (!closed) {
    const lo = [...cs].reverse().find((u) => u < pick) ?? null;
    const hi = cs.find((u) => u > pick) ?? null;
    if (lo === null && hi === null) return null;
    const pieces: Seg[][] = [];
    if (lo !== null) pieces.push(part(0, lo));
    if (hi !== null) pieces.push(part(hi, n));
    return pieces.filter((p) => p.length);
  }
  if (cs.length < 2) return null;
  const lo = [...cs].reverse().find((u) => u < pick) ?? cs[cs.length - 1];
  const hi = cs.find((u) => u > pick) ?? cs[0];
  // keep hi → (around) → lo
  const keep = hi <= lo ? part(hi, lo) : [...part(hi, n), ...part(0, lo)];
  return keep.length ? [keep] : null;
}

/** Offset of a polyline (straight segments) by d to the left (d > 0) — mitred corners. */
export function offsetPoly(pts: W[], closed: boolean, d: number): W[] {
  const n = pts.length;
  const lines: [W, W][] = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const l = dist(a, b) || 1;
    const nx = (-(b[1] - a[1]) / l) * d, ny = ((b[0] - a[0]) / l) * d;
    lines.push([
      [a[0] + nx, a[1] + ny],
      [b[0] + nx, b[1] + ny],
    ]);
  }
  const out: W[] = [];
  const meet = (p: [W, W], q: [W, W]): W => {
    const x = lineX(p[0], p[1], q[0], q[1]);
    return x ? lerp(p[0], p[1], x.t) : p[1];
  };
  if (!closed) {
    out.push(lines[0][0]);
    for (let i = 1; i < lines.length; i++) out.push(meet(lines[i - 1], lines[i]));
    out.push(lines[lines.length - 1][1]);
  } else for (let i = 0; i < lines.length; i++) out.push(meet(lines[(i - 1 + lines.length) % lines.length], lines[i]));
  return out;
}

/** Area (shoelace) and perimeter of a polygon. */
export function polyArea(pts: W[], closed = true): { area: number; perimeter: number } {
  let a = 0, p = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[i], r = pts[(i + 1) % pts.length];
    if (i < pts.length - 1 || closed) {
      a += q[0] * r[1] - r[0] * q[1];
      p += dist(q, r);
    }
  }
  return { area: Math.abs(a) / 2, perimeter: p };
}
