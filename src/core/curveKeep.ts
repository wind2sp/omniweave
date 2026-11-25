// Béziers kept through polygon booleans (Illustrator's Pathfinder, Shape Builder, Divide keep the curves): the source
// paths are sampled with every sample point tagged by the segment and t it came from; after the polygon operation the
// result's vertices are looked up again, and each run of vertices along one source curve becomes that curve's own
// piece (de Casteljau) instead of short straight lines. Vertices made by the operation (crossings) are put on the
// nearest segment of their neighbours. All in page space.

import type { MultiPolygon, Polygon, Ring } from "polygon-clipping";
import { applyTransform } from "./geom";
import type { Contour, Vec2, VectorAnchor, VectorNode } from "./types";

type Cubic = [Vec2, Vec2, Vec2, Vec2];
interface Seg {
  c: Cubic;
  line: boolean;
}
interface Tag {
  s: number;
  t: number;
}

const eq = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const at = (c: Cubic, t: number): Vec2 => {
  const u = 1 - t;
  return [u * u * u * c[0][0] + 3 * u * u * t * c[1][0] + 3 * u * t * t * c[2][0] + t * t * t * c[3][0], u * u * u * c[0][1] + 3 * u * u * t * c[1][1] + 3 * u * t * t * c[2][1] + t * t * t * c[3][1]];
};
const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function sub(c: Cubic, t0: number, t1: number): Cubic {
  const rev = t1 < t0;
  const [a, b] = rev ? [t1, t0] : [t0, t1];
  const split = (q: Cubic, t: number): [Cubic, Cubic] => {
    const p01 = lerp(q[0], q[1], t), p12 = lerp(q[1], q[2], t), p23 = lerp(q[2], q[3], t);
    const p012 = lerp(p01, p12, t), p123 = lerp(p12, p23, t), m = lerp(p012, p123, t);
    return [[q[0], p01, p012, m], [m, p123, p23, q[3]]];
  };
  let r = c;
  if (b < 1) r = split(r, b)[0];
  if (a > 0) r = split(r, b > 0 ? a / b : 0)[1];
  return rev ? [r[3], r[2], r[1], r[0]] : r;
}
const key = (x: number, y: number) => `${Math.round(x * 1e5)},${Math.round(y * 1e5)}`;

/** The sampled sources: one polygon set per shape (for the boolean), and the tags of every sample point. */
export interface Sampled {
  segs: Seg[];
  tags: Map<string, Tag[]>;
  /** per shape: its closed contours as polygons (even-odd between them is the caller's) */
  rings: Ring[][];
}

/** Sample shapes (each a list of page-space contours) for a boolean whose result keeps their curves. */
export function sampleShapes(shapes: Contour[][]): Sampled {
  const segs: Seg[] = [];
  const tags = new Map<string, Tag[]>();
  const tag = (p: Vec2, t: Tag) => {
    const k = key(p[0], p[1]);
    const l = tags.get(k);
    if (l) l.push(t);
    else tags.set(k, [t]);
  };
  const rings: Ring[][] = shapes.map((cs) =>
    cs
      .filter((c) => c.closed && c.nodes.length > 2)
      .map((c) => {
        const m = c.nodes.length;
        const first = segs.length;
        const ring: [number, number][] = [];
        for (let i = 0; i < m; i++) {
          const a = c.nodes[i], b = c.nodes[(i + 1) % m];
          const cu: Cubic = [a.anchor, a.handleOut, b.handleIn, b.anchor];
          const line = eq(a.handleOut, a.anchor) && eq(b.handleIn, b.anchor);
          const s = segs.length;
          segs.push({ c: cu, line });
          // a curve: evenly in t, finer for longer ones; a line: its ends
          const len = Math.hypot(b.anchor[0] - a.anchor[0], b.anchor[1] - a.anchor[1]) + Math.hypot(a.handleOut[0] - a.anchor[0], a.handleOut[1] - a.anchor[1]) + Math.hypot(b.handleIn[0] - b.anchor[0], b.handleIn[1] - b.anchor[1]);
          const n = line ? 1 : Math.max(8, Math.min(96, Math.ceil(len / 3)));
          for (let k = 0; k < n; k++) {
            const t = k / n;
            const p = at(cu, t);
            ring.push([p[0], p[1]]);
            tag(p, { s, t });
            // the segment's start is also the previous segment's end
            if (k === 0) tag(p, { s: i === 0 ? first + m - 1 : s - 1, t: 1 });
          }
        }
        ring.push([ring[0][0], ring[0][1]]);
        return ring;
      }),
  );
  return { segs, tags, rings };
}

/** A node's contours in page space. */
export function pageContours(n: VectorNode): Contour[] {
  const f = (p: Vec2) => applyTransform(n.transform, p);
  return n.contours.map((c) => ({ closed: c.closed, nodes: c.nodes.map((a) => ({ ...a, anchor: f(a.anchor), handleIn: f(a.handleIn), handleOut: f(a.handleOut) })) }));
}

/** The nearest t of a point on a segment (and its distance). */
function project(seg: Seg, p: Vec2): { t: number; d: number } {
  let best = { t: 0, d: Infinity };
  const steps = seg.line ? 1 : 96;
  if (seg.line) {
    const [a, , , b] = seg.c;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
    const q = lerp(a, b, t);
    return { t, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
  }
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, q = at(seg.c, t), d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.d) best = { t, d };
  }
  // refine around the best sample
  let lo = Math.max(0, best.t - 1 / steps), hi = Math.min(1, best.t + 1 / steps);
  for (let k = 0; k < 24; k++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const d1 = Math.hypot(at(seg.c, m1)[0] - p[0], at(seg.c, m1)[1] - p[1]), d2 = Math.hypot(at(seg.c, m2)[0] - p[0], at(seg.c, m2)[1] - p[1]);
    if (d1 < d2) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2, q = at(seg.c, t);
  return { t, d: Math.hypot(q[0] - p[0], q[1] - p[1]) };
}

const corner = (p: Vec2): VectorAnchor => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true });

/** One ring of a boolean's result as a contour with the sources' curves where it runs along them. */
function rebuildRing(ring: Ring, sm: Sampled): Contour | null {
  const pts: Vec2[] = ring.slice(0, -1).map(([x, y]) => [x, y]);
  const n = pts.length;
  if (n < 3) return null;
  const tg: Tag[][] = pts.map((p) => sm.tags.get(key(p[0], p[1])) ?? []);
  // vertices the operation made (crossings): on the nearest segment their neighbours run along
  for (let i = 0; i < n; i++) {
    if (tg[i].length) continue;
    const cand = new Set<number>([...tg[(i - 1 + n) % n], ...tg[(i + 1) % n]].map((x) => x.s));
    for (const s of cand) {
      const r = project(sm.segs[s], pts[i]);
      if (r.d < 0.05) tg[i].push({ s, t: r.t });
    }
  }
  // each edge: the curve segment it lies along (both ends tagged on it), with the ends' t, or a plain line
  const edge: ({ s: number; t0: number; t1: number } | null)[] = [];
  for (let i = 0; i < n; i++) {
    const a = tg[i], b = tg[(i + 1) % n];
    let e: { s: number; t0: number; t1: number } | null = null;
    for (const x of a) {
      if (sm.segs[x.s].line) continue;
      const y = b.find((z) => z.s === x.s);
      if (y && Math.abs(y.t - x.t) < 0.5) {
        e = { s: x.s, t0: x.t, t1: y.t };
        break;
      }
    }
    edge.push(e);
  }
  // runs: consecutive edges along the same segment, t moving one way
  const same = (p: (typeof edge)[number], q: (typeof edge)[number]) => !!p && !!q && p.s === q.s && Math.sign(p.t1 - p.t0) === Math.sign(q.t1 - q.t0) && Math.abs(p.t1 - q.t0) < 1e-9;
  let start = 0;
  while (start < n && same(edge[(start - 1 + n) % n], edge[start])) start++;
  if (start === n) start = 0;
  const nodes: VectorAnchor[] = [];
  let i = start;
  let count = 0;
  while (count < n) {
    const e = edge[i];
    let j = i, t1 = e?.t1 ?? 0;
    let k = 1;
    while (e && k < n && same(edge[(j) % n], edge[(j + 1) % n])) {
      j = (j + 1) % n;
      t1 = edge[j]!.t1;
      k++;
    }
    const from = pts[i];
    if (!nodes.length) nodes.push(corner(from));
    const last = nodes[nodes.length - 1];
    const to = pts[(j + 1) % n];
    if (e) {
      const c = sub(sm.segs[e.s].c, e.t0, t1);
      last.handleOut = c[1];
      nodes.push({ anchor: to, handleIn: c[2], handleOut: to, isCorner: true });
    } else nodes.push(corner(to));
    count += k;
    i = (j + 1) % n;
  }
  // the ring closes on its first anchor: the last pushed one is the first point again
  const end = nodes.pop()!;
  nodes[0].handleIn = end.handleIn;
  // smooth where a curve goes on into the next piece of the same curve (no visible corner)
  for (const a of nodes) {
    const u: Vec2 = [a.anchor[0] - a.handleIn[0], a.anchor[1] - a.handleIn[1]], v: Vec2 = [a.handleOut[0] - a.anchor[0], a.handleOut[1] - a.anchor[1]];
    const lu = Math.hypot(...u), lv = Math.hypot(...v);
    a.isCorner = !(lu > 1e-9 && lv > 1e-9 && (u[0] * v[0] + u[1] * v[1]) / (lu * lv) > 0.999);
  }
  return nodes.length > 1 ? { closed: true, nodes } : null;
}

/** A boolean's result as contours that keep the sources' curves. */
export function curvedContours(mp: MultiPolygon, sm: Sampled): Contour[] {
  const out: Contour[] = [];
  for (const poly of mp as Polygon[]) for (const r of poly) {
    const c = rebuildRing(r, sm);
    if (c) out.push(c);
  }
  return out;
}
