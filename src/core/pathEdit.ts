// Path editing engine — anchor points and direction handles of vector contours (Illustrator / Photoshop pen family,
// PowerPoint 점 편집). Pure geometry on node-local contours; the functions that change a contour change it in place,
// so they work the same on plain objects and on immer drafts (ui/pathTools.ts commits them).
//
//   insertAnchorAt   — split a segment at a parameter (de Casteljau): the curve keeps its exact shape
//   removeAnchor     — delete one point; the two segments around it are refitted into one (least squares, the
//                      neighbours' handle directions kept) so the shape stays as close as it can
//   dragHandle       — smooth point: the opposite handle turns with it, its length kept; `split` (Alt) = corner
//   pullHandles      — Alt+drag out of a point: new symmetric handles (convert anchor point)
//   toggleSmooth     — corner ↔ smooth (auto handles along the neighbours' chord)
//   bendSegment      — drag a segment itself: the handles move so the curve goes through the pointer
//   deleteAnchors    — Delete with points selected: the points and their segments go, the path breaks there
//   joinEnds         — Ctrl+J: close an open contour or connect two end points (merging contours)
//   autoSmooth       — curvature tool: handles so the curve runs smoothly through the points

import type { Contour, Vec2, VectorAnchor } from "./types";
import { cubicAt } from "./vector";

const lerp = (a: Vec2, b: Vec2, u: number): Vec2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Vec2) => Math.hypot(v[0], v[1]);
const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const copy = (a: VectorAnchor): VectorAnchor => ({ anchor: [...a.anchor], handleIn: [...a.handleIn], handleOut: [...a.handleOut], isCorner: a.isCorner });

/** A straight segment: neither end has a handle along it. */
export const isStraight = (a: VectorAnchor, b: VectorAnchor) => same(a.handleOut, a.anchor) && same(b.handleIn, b.anchor);

/** Number of segments of a contour. */
export const segCount = (c: Contour) => (c.closed ? c.nodes.length : Math.max(0, c.nodes.length - 1));

/** Split segment (a → b) at u (de Casteljau): the new anchor and the updated handles of a and b. */
export function splitSegment(a: VectorAnchor, b: VectorAnchor, u: number): { a: VectorAnchor; mid: VectorAnchor; b: VectorAnchor } {
  const p0 = a.anchor, p1 = a.handleOut, p2 = b.handleIn, p3 = b.anchor;
  if (isStraight(a, b)) {
    // the curve parameter, not the length fraction: the point lands where nearestOnContour found it
    const s = cubicAt(p0, p1, p2, p3, u);
    return { a, mid: { anchor: s, handleIn: [...s], handleOut: [...s], isCorner: true }, b };
  }
  const q0 = lerp(p0, p1, u), q1 = lerp(p1, p2, u), q2 = lerp(p2, p3, u);
  const r0 = lerp(q0, q1, u), r1 = lerp(q1, q2, u);
  const s = lerp(r0, r1, u);
  return { a: { ...a, handleOut: q0 }, mid: { anchor: s, handleIn: r0, handleOut: r1, isCorner: false }, b: { ...b, handleIn: q2 } };
}

/** The nearest point on a contour to p (node-local): segment index and parameter, with the distance. */
export function nearestOnContour(c: Contour, p: Vec2): { seg: number; u: number; d: number } | null {
  let best: { seg: number; u: number; d: number } | null = null;
  const n = c.nodes.length;
  for (let i = 0; i < segCount(c); i++) {
    const a = c.nodes[i], b = c.nodes[(i + 1) % n];
    const at = (u: number) => {
      const q = cubicAt(a.anchor, a.handleOut, b.handleIn, b.anchor, u);
      return Math.hypot(q[0] - p[0], q[1] - p[1]);
    };
    let bu = 0, bd = Infinity;
    for (let k = 0; k <= 64; k++) {
      const d = at(k / 64);
      if (d < bd) (bd = d), (bu = k / 64);
    }
    for (let step = 1 / 128; step > 1e-5; step /= 2)
      for (const u of [bu - step, bu + step]) {
        if (u < 0 || u > 1) continue;
        const d = at(u);
        if (d < bd) (bd = d), (bu = u);
      }
    if (!best || bd < best.d) best = { seg: i, u: bu, d: bd };
  }
  return best;
}

/** Add an anchor on segment `seg` at parameter u; returns the new point's index. The curve keeps its shape. */
export function insertAnchorAt(c: Contour, seg: number, u: number): number {
  const n = c.nodes.length;
  const ai = seg, bi = (seg + 1) % n;
  const r = splitSegment(c.nodes[ai], c.nodes[bi], u);
  c.nodes[ai] = r.a;
  c.nodes[bi] = r.b;
  c.nodes.splice(ai + 1, 0, r.mid);
  return ai + 1;
}

/**
 * One cubic from p0 to p3 leaving along t1 and arriving along t2 (unit vectors, t2 pointing back from p3) that best
 * fits the sample points (least squares on the two handle lengths, chord-length parameters refined by Newton steps).
 */
function fitCubic(pts: Vec2[], t1: Vec2, t2: Vec2): [Vec2, Vec2] {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  const chord = len(sub(p3, p0));
  let us: number[] = [0];
  for (let i = 1; i < pts.length; i++) us.push(us[i - 1] + len(sub(pts[i], pts[i - 1])));
  const total = us[us.length - 1] || 1;
  us = us.map((u) => u / total);
  let h: [Vec2, Vec2] = [[p0[0] + t1[0] * chord / 3, p0[1] + t1[1] * chord / 3], [p3[0] + t2[0] * chord / 3, p3[1] + t2[1] * chord / 3]];
  for (let iter = 0; iter < 8; iter++) {
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < pts.length; i++) {
      const u = us[i], m = 1 - u;
      const b0 = m * m * m, b1 = 3 * m * m * u, b2 = 3 * m * u * u, b3 = u * u * u;
      const A1: Vec2 = [t1[0] * b1, t1[1] * b1], A2: Vec2 = [t2[0] * b2, t2[1] * b2];
      c00 += A1[0] * A1[0] + A1[1] * A1[1];
      c01 += A1[0] * A2[0] + A1[1] * A2[1];
      c11 += A2[0] * A2[0] + A2[1] * A2[1];
      const tmp: Vec2 = [pts[i][0] - (p0[0] * (b0 + b1) + p3[0] * (b2 + b3)), pts[i][1] - (p0[1] * (b0 + b1) + p3[1] * (b2 + b3))];
      x0 += A1[0] * tmp[0] + A1[1] * tmp[1];
      x1 += A2[0] * tmp[0] + A2[1] * tmp[1];
    }
    const det = c00 * c11 - c01 * c01;
    let a1 = Math.abs(det) > 1e-12 ? (x0 * c11 - x1 * c01) / det : chord / 3;
    let a2 = Math.abs(det) > 1e-12 ? (c00 * x1 - c01 * x0) / det : chord / 3;
    const eps = chord * 1e-4;
    if (!(a1 > eps) || !(a2 > eps)) a1 = a2 = chord / 3;
    h = [[p0[0] + t1[0] * a1, p0[1] + t1[1] * a1], [p3[0] + t2[0] * a2, p3[1] + t2[1] * a2]];
    // Newton reparameterisation: move each u to the nearest point of the current curve
    us = us.map((u, i) => {
      if (i === 0 || i === us.length - 1) return u;
      const m = 1 - u;
      const q = cubicAt(p0, h[0], h[1], p3, u);
      const d1: Vec2 = [3 * (m * m * (h[0][0] - p0[0]) + 2 * m * u * (h[1][0] - h[0][0]) + u * u * (p3[0] - h[1][0])), 3 * (m * m * (h[0][1] - p0[1]) + 2 * m * u * (h[1][1] - h[0][1]) + u * u * (p3[1] - h[1][1]))];
      const d2: Vec2 = [6 * (m * (h[1][0] - 2 * h[0][0] + p0[0]) + u * (p3[0] - 2 * h[1][0] + h[0][0])), 6 * (m * (h[1][1] - 2 * h[0][1] + p0[1]) + u * (p3[1] - 2 * h[1][1] + h[0][1]))];
      const diff = sub(q, pts[i]);
      const num = diff[0] * d1[0] + diff[1] * d1[1];
      const den = d1[0] * d1[0] + d1[1] * d1[1] + diff[0] * d2[0] + diff[1] * d2[1];
      const nu = Math.abs(den) > 1e-12 ? u - num / den : u;
      return Math.min(1, Math.max(0, nu));
    });
  }
  return h;
}

/** Largest distance from the samples to a cubic (dense polyline). */
function fitError(pts: Vec2[], h: [Vec2, Vec2], p0: Vec2, p3: Vec2): number {
  const poly: Vec2[] = [];
  for (let k = 0; k <= 128; k++) poly.push(cubicAt(p0, h[0], h[1], p3, k / 128));
  let worst = 0;
  for (const s of pts) {
    let d = Infinity;
    for (let i = 0; i + 1 < poly.length; i++) d = Math.min(d, segDist(s, poly[i], poly[i + 1]));
    worst = Math.max(worst, d);
  }
  return worst;
}

function segDist(s: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((s[0] - a[0]) * dx + (s[1] - a[1]) * dy) / l2));
  return Math.hypot(s[0] - (a[0] + t * dx), s[1] - (a[1] + t * dy));
}

const unit = (v: Vec2): Vec2 | null => {
  const l = len(v);
  return l > 1e-9 ? [v[0] / l, v[1] / l] : null;
};

/**
 * Delete anchor `ni`. A point between two others is replaced by one refitted segment (neighbours keep their handle
 * directions, so smooth neighbours stay smooth); an end point of an open contour just goes with its segment.
 * Returns false when the contour is left with fewer than two points (the caller removes it).
 */
export function removeAnchor(c: Contour, ni: number): boolean {
  const n = c.nodes.length;
  const end = !c.closed && (ni === 0 || ni === n - 1);
  if (n <= 2 || end) {
    c.nodes.splice(ni, 1);
    if (c.nodes.length < 3 && c.closed) c.closed = c.nodes.length >= 3;
    return c.nodes.length >= 2;
  }
  const pi = (ni - 1 + n) % n, qi = (ni + 1) % n;
  const p = c.nodes[pi], m = c.nodes[ni], q = c.nodes[qi];
  if (isStraight(p, m) && isStraight(m, q)) {
    c.nodes.splice(ni, 1);
    return true;
  }
  const pts: Vec2[] = [];
  const N = 24;
  for (let k = 0; k <= N; k++) pts.push(cubicAt(p.anchor, p.handleOut, m.handleIn, m.anchor, k / N));
  for (let k = 1; k <= N; k++) pts.push(cubicAt(m.anchor, m.handleOut, q.handleIn, q.anchor, k / N));
  const t1 = unit(sub(p.handleOut, p.anchor)) ?? unit(sub(m.handleIn, p.anchor)) ?? unit(sub(m.anchor, p.anchor)) ?? [1, 0];
  const t2 = unit(sub(q.handleIn, q.anchor)) ?? unit(sub(m.handleOut, q.anchor)) ?? unit(sub(m.anchor, q.anchor)) ?? [-1, 0];
  let best = fitCubic(pts, t1, t2);
  // a point that came from splitting one curve (its handles in line, lengths in ratio u : 1 − u): undo the split
  // exactly — de Casteljau backwards — when that fits the samples better than the least-squares curve
  const li = len(sub(m.handleIn, m.anchor)), lo = len(sub(m.handleOut, m.anchor));
  if (li > 1e-9 && lo > 1e-9) {
    const u0 = li / (li + lo);
    const back: [Vec2, Vec2] = [lerp(p.anchor, p.handleOut, 1 / u0), lerp(q.anchor, q.handleIn, 1 / (1 - u0))];
    if (fitError(pts, back, p.anchor, q.anchor) < fitError(pts, best, p.anchor, q.anchor)) best = back;
  }
  p.handleOut = best[0];
  q.handleIn = best[1];
  c.nodes.splice(ni, 1);
  return true;
}

/** 45° steps of v around `origin` (Shift). */
export function snap45(origin: Vec2, v: Vec2): Vec2 {
  const d = sub(v, origin);
  const l = len(d);
  const a = Math.round(Math.atan2(d[1], d[0]) / (Math.PI / 4)) * (Math.PI / 4);
  return [origin[0] + Math.cos(a) * l, origin[1] + Math.sin(a) * l];
}

/** The opposite handle of a smooth point turned to stay in line with `mine`, keeping its own length. */
function turnOpposite(a: VectorAnchor, mine: "handleIn" | "handleOut") {
  const other = mine === "handleIn" ? "handleOut" : "handleIn";
  const ol = len(sub(a[other], a.anchor));
  const dir = unit(sub(a.anchor, a[mine]));
  if (!dir || ol < 1e-9) return;
  a[other] = [a.anchor[0] + dir[0] * ol, a.anchor[1] + dir[1] * ol];
}

/**
 * Move one direction handle to `to`. On a smooth point the opposite handle turns with it (its length kept, as in
 * Illustrator); `split` (Alt) moves this one alone and the point becomes a corner. A corner point's handles always
 * move alone.
 */
export function dragHandle(a: VectorAnchor, part: "in" | "out", to: Vec2, split = false) {
  const mine = part === "in" ? "handleIn" : "handleOut";
  a[mine] = [to[0], to[1]];
  if (split) a.isCorner = true;
  else if (!a.isCorner) turnOpposite(a, mine);
}

/** Alt+drag out of a point (convert anchor point / pen): new symmetric handles, the out handle at `to`. */
export function pullHandles(a: VectorAnchor, to: Vec2) {
  a.handleOut = [to[0], to[1]];
  a.handleIn = [2 * a.anchor[0] - to[0], 2 * a.anchor[1] - to[1]];
  a.isCorner = same(to, a.anchor);
}

/** Move an anchor with its handles. */
export function moveAnchor(a: VectorAnchor, dx: number, dy: number) {
  a.anchor = [a.anchor[0] + dx, a.anchor[1] + dy];
  a.handleIn = [a.handleIn[0] + dx, a.handleIn[1] + dy];
  a.handleOut = [a.handleOut[0] + dx, a.handleOut[1] + dy];
}

/** Retract both handles: a sharp corner. */
export function makeCorner(a: VectorAnchor) {
  a.handleIn = [...a.anchor];
  a.handleOut = [...a.anchor];
  a.isCorner = true;
}

/** Smooth point with handles along the chord of its neighbours (a third of the distance to each). */
export function makeSmooth(c: Contour, ni: number) {
  const n = c.nodes.length;
  const a = c.nodes[ni];
  const prev = ni > 0 || c.closed ? c.nodes[(ni - 1 + n) % n] : null;
  const next = ni < n - 1 || c.closed ? c.nodes[(ni + 1) % n] : null;
  // a smooth point that already has a handle: line the other one up with it
  const hasIn = !same(a.handleIn, a.anchor), hasOut = !same(a.handleOut, a.anchor);
  if (hasIn !== hasOut) {
    a.isCorner = false;
    const mine = hasIn ? "handleIn" : "handleOut";
    const other = hasIn ? "handleOut" : "handleIn";
    const nb = hasIn ? next : prev;
    const l = nb ? len(sub(nb.anchor, a.anchor)) / 3 : len(sub(a[mine], a.anchor));
    const d = unit(sub(a.anchor, a[mine]))!;
    a[other] = [a.anchor[0] + d[0] * l, a.anchor[1] + d[1] * l];
    return;
  }
  if (hasIn && hasOut) {
    a.isCorner = false;
    const d = unit(sub(a.handleOut, a.handleIn));
    if (!d) return;
    const li = len(sub(a.handleIn, a.anchor)), lo = len(sub(a.handleOut, a.anchor));
    a.handleIn = [a.anchor[0] - d[0] * li, a.anchor[1] - d[1] * li];
    a.handleOut = [a.anchor[0] + d[0] * lo, a.anchor[1] + d[1] * lo];
    return;
  }
  const from = prev?.anchor ?? a.anchor, to = next?.anchor ?? a.anchor;
  const d = unit(sub(to, from)) ?? [1, 0];
  const li = prev ? len(sub(prev.anchor, a.anchor)) / 3 : 0, lo = next ? len(sub(next.anchor, a.anchor)) / 3 : 0;
  a.handleIn = [a.anchor[0] - d[0] * li, a.anchor[1] - d[1] * li];
  a.handleOut = [a.anchor[0] + d[0] * lo, a.anchor[1] + d[1] * lo];
  a.isCorner = false;
}

/** Click with the convert anchor point tool: a smooth point (or one with handles) becomes a corner, a bare corner smooth. */
export function toggleSmooth(c: Contour, ni: number) {
  const a = c.nodes[ni];
  if (!a.isCorner || !same(a.handleIn, a.anchor) || !same(a.handleOut, a.anchor)) makeCorner(a);
  else makeSmooth(c, ni);
}

/**
 * Drag the segment from node `ai` to the next one so that its point at parameter u goes to `to` (both from the
 * segment as it was when the drag started, `base`). The two inner handles take the least movement that does it;
 * smooth end points turn their other handle to stay smooth.
 */
export function bendSegment(c: Contour, ai: number, base: [VectorAnchor, VectorAnchor], u: number, to: Vec2) {
  const n = c.nodes.length;
  const bi = (ai + 1) % n;
  const [a0, b0] = base;
  const uu = Math.min(0.95, Math.max(0.05, u));
  // a straight segment starts from handles at a third of the way, so it bends as a curve would
  const straight = isStraight(a0, b0);
  const p1 = straight ? lerp(a0.anchor, b0.anchor, 1 / 3) : a0.handleOut;
  const p2 = straight ? lerp(a0.anchor, b0.anchor, 2 / 3) : b0.handleIn;
  const cur = cubicAt(a0.anchor, p1, p2, b0.anchor, uu);
  const d = sub(to, cur);
  const m = 1 - uu;
  const w1 = 3 * m * m * uu, w2 = 3 * m * uu * uu;
  const k = 1 / (w1 * w1 + w2 * w2);
  const a = c.nodes[ai], b = c.nodes[bi];
  a.handleOut = [p1[0] + d[0] * w1 * k, p1[1] + d[1] * w1 * k];
  b.handleIn = [p2[0] + d[0] * w2 * k, p2[1] + d[1] * w2 * k];
  // keep the far handles as they were, then line them up on smooth points
  a.handleIn = [...a0.handleIn];
  b.handleOut = [...b0.handleOut];
  if (!a.isCorner) turnOpposite(a, "handleOut");
  if (!b.isCorner) turnOpposite(b, "handleIn");
}

/** Reverse a contour's direction (handles swap sides). */
export function reverseContour(c: Contour) {
  c.nodes.reverse();
  for (const a of c.nodes) [a.handleIn, a.handleOut] = [a.handleOut, a.handleIn];
}

/**
 * Delete the selected points of one node's contours and the segments touching them; contours break where points
 * went (a closed one opens). Returns the new contour list (pieces with fewer than two points are dropped).
 */
export function deleteAnchors(contours: Contour[], picked: (ci: number, ni: number) => boolean): Contour[] {
  const out: Contour[] = [];
  contours.forEach((c, ci) => {
    const n = c.nodes.length;
    const del = c.nodes.map((_, ni) => picked(ci, ni));
    if (!del.some(Boolean)) return void out.push(c);
    if (del.every(Boolean)) return;
    // walk from the point after a deleted one so a closed contour's runs do not wrap
    let start = 0;
    if (c.closed) start = (del.indexOf(true) + 1) % n;
    let run: VectorAnchor[] = [];
    const flush = () => {
      if (run.length >= 2) out.push({ closed: false, nodes: run });
      run = [];
    };
    for (let k = 0; k < n; k++) {
      const i = c.closed ? (start + k) % n : k;
      if (del[i]) flush();
      else run.push(copy(c.nodes[i]));
    }
    flush();
  });
  return out;
}

/**
 * Cut the path at the selected points (Illustrator's "cut path at selected anchor points", PowerPoint 경로 열기): each
 * picked point becomes two end points, so a closed contour opens there and an open one splits in two.
 */
export function cutAt(contours: Contour[], picked: (ci: number, ni: number) => boolean): Contour[] {
  const out: Contour[] = [];
  contours.forEach((c, ci) => {
    const n = c.nodes.length;
    const cuts = c.nodes.map((_, ni) => picked(ci, ni) && (c.closed || (ni > 0 && ni < n - 1)));
    if (!cuts.some(Boolean)) return void out.push(c);
    const start = c.closed ? cuts.indexOf(true) : 0;
    let run: VectorAnchor[] = [];
    for (let k = 0; k < (c.closed ? n + 1 : n); k++) {
      const i = (start + k) % n;
      run.push(copy(c.nodes[i]));
      if (cuts[i] && run.length >= 2) {
        out.push({ closed: false, nodes: run });
        run = [copy(c.nodes[i])];
      }
    }
    if (run.length >= 2) out.push({ closed: false, nodes: run });
  });
  return out;
}

/** An end point of an open contour: "start" (first) / "end" (last), or null. */
export function endOf(c: Contour, ni: number): "start" | "end" | null {
  if (c.closed || c.nodes.length < 2) return null;
  if (ni === 0) return "start";
  if (ni === c.nodes.length - 1) return "end";
  return null;
}

/**
 * Ctrl+J on two end points (ci/ni pairs) of one node's open contours: the same contour closes; two contours become
 * one, joined by a straight segment (or merged into one point when the ends lie on each other). Returns the contour
 * list, or null when the two points are not joinable ends.
 */
export function joinEnds(contours: Contour[], p: { ci: number; ni: number }, q: { ci: number; ni: number }): Contour[] | null {
  const cp = contours[p.ci], cq = contours[q.ci];
  const ep = cp && endOf(cp, p.ni), eq = cq && endOf(cq, q.ni);
  if (!ep || !eq) return null;
  if (p.ci === q.ci) {
    if (ep === eq) return null;
    const c = contours[p.ci];
    mergeCoincident(c.nodes, c.nodes.length - 1, 0, true);
    c.closed = true;
    return contours;
  }
  const a: Contour = { closed: false, nodes: cp.nodes.map(copy) };
  const b: Contour = { closed: false, nodes: cq.nodes.map(copy) };
  if (ep === "start") reverseContour(a);
  if (eq === "end") reverseContour(b);
  const nodes = [...a.nodes, ...b.nodes];
  mergeCoincident(nodes, a.nodes.length - 1, a.nodes.length, false);
  const out = contours.filter((_, i) => i !== p.ci && i !== q.ci);
  out.splice(Math.min(p.ci, q.ci), 0, { closed: false, nodes });
  return out;
}

/** Two joined ends lying on each other become one point (the first keeps its in handle, takes the other's out). */
function mergeCoincident(nodes: VectorAnchor[], i: number, j: number, closing: boolean) {
  const a = nodes[i], b = nodes[j];
  if (len(sub(a.anchor, b.anchor)) > 1e-6) return;
  if (closing) {
    b.handleIn = a.handleIn;
    b.isCorner = true;
    nodes.splice(i, 1);
  } else {
    a.handleOut = b.handleOut;
    a.isCorner = true;
    nodes.splice(j, 1);
  }
}

/**
 * Curvature tool: handles that make the curve run smoothly through the points (Catmull-Rom tangents, a third of the
 * neighbour distance); corner points keep no handles.
 */
export function autoSmooth(nodes: VectorAnchor[], closed: boolean) {
  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const a = nodes[i];
    if (a.isCorner) {
      makeCorner(a);
      continue;
    }
    const prev = i > 0 || closed ? nodes[(i - 1 + n) % n] : null;
    const next = i < n - 1 || closed ? nodes[(i + 1) % n] : null;
    if (!prev || !next || n < 3) {
      // open ends get their handle below, once the inner points have theirs
      a.handleIn = [...a.anchor];
      a.handleOut = [...a.anchor];
      continue;
    }
    const d = unit(sub(next.anchor, prev.anchor)) ?? [1, 0];
    const li = len(sub(prev.anchor, a.anchor)) / 3, lo = len(sub(next.anchor, a.anchor)) / 3;
    a.handleIn = [a.anchor[0] - d[0] * li, a.anchor[1] - d[1] * li];
    a.handleOut = [a.anchor[0] + d[0] * lo, a.anchor[1] + d[1] * lo];
  }
  // open ends: a handle toward the neighbour's in handle so the first / last segment curves into the next one
  if (!closed && n >= 3) {
    const f = nodes[0], s = nodes[1];
    if (!f.isCorner) f.handleOut = lerp(f.anchor, s.handleIn, 0.5);
    const l = nodes[n - 1], k = nodes[n - 2];
    if (!l.isCorner) l.handleIn = lerp(l.anchor, k.handleOut, 0.5);
  }
}

/** Largest distance from samples of `b` to the polyline of `a` (shape comparison in tests and checks). */
export function shapeDistance(a: Contour, b: Contour, samples = 32): number {
  const poly: Vec2[] = [];
  const segs = (c: Contour) => Array.from({ length: segCount(c) }, (_, i) => [c.nodes[i], c.nodes[(i + 1) % c.nodes.length]] as const);
  for (const [p, q] of segs(a)) for (let k = 0; k <= 256; k++) poly.push(cubicAt(p.anchor, p.handleOut, q.handleIn, q.anchor, k / 256));
  let worst = 0;
  for (const [p, q] of segs(b))
    for (let k = 0; k <= samples; k++) {
      const s = cubicAt(p.anchor, p.handleOut, q.handleIn, q.anchor, k / samples);
      let best = Infinity;
      for (let i = 0; i + 1 < poly.length; i++) best = Math.min(best, segDist(s, poly[i], poly[i + 1]));
      worst = Math.max(worst, best);
    }
  return worst;
}
