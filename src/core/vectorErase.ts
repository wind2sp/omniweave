// The design mode's eraser on vector paths (Illustrator's Eraser): where the eraser passes, a stroked path is cut —
// the parts left keep their exact curves (the Bézier segments are split, not flattened) — and a filled shape loses
// the area the eraser covered. Pure: a path in, the path that remains out.

import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { applyTransform, invertTransform } from "./geom";
import { cubicAt, flatten, segments } from "./vector";
import { IDENTITY, type Contour, type VectorAnchor, type VectorNode, type Vec2 } from "./types";

type Cubic = [Vec2, Vec2, Vec2, Vec2];

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** The part of a cubic between t0 and t1 (de Casteljau), exact. */
export function subCubic(c: Cubic, t0: number, t1: number): Cubic {
  const split = (q: Cubic, t: number): [Cubic, Cubic] => {
    const [p0, p1, p2, p3] = q;
    const a = lerp(p0, p1, t), b = lerp(p1, p2, t), cc = lerp(p2, p3, t);
    const d = lerp(a, b, t), e = lerp(b, cc, t), f = lerp(d, e, t);
    return [[p0, a, d, f], [f, e, cc, p3]];
  };
  const left = t1 >= 1 ? c : split(c, t1)[0];
  if (t0 <= 0) return left;
  return split(left, t0 / t1)[1];
}

function distToTrack(p: Vec2, track: Vec2[]): number {
  if (track.length === 1) return Math.hypot(p[0] - track[0][0], p[1] - track[0][1]);
  let best = Infinity;
  for (let i = 0; i + 1 < track.length; i++) {
    const [ax, ay] = track[i], [bx, by] = track[i + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

/** Cut the stroked contours where the (node-local) track passes within `reach`; null = nothing left, undefined = untouched. */
export function cutContours(contours: Contour[], track: Vec2[], reach: number): Contour[] | null | undefined {
  const STEPS = 48;
  let touched = false;
  const out: Contour[] = [];
  for (const c of contours) {
    const segs = segments(c).map(([a, b]) => [a.anchor, a.handleOut, b.handleIn, b.anchor] as Cubic);
    if (!segs.length) {
      out.push(c);
      continue;
    }
    const inside = (s: Cubic, t: number) => distToTrack(cubicAt(s[0], s[1], s[2], s[3], t), track) < reach;
    // kept pieces in order: [segment index, t0, t1]
    const pieces: [number, number, number][] = [];
    let any = false;
    segs.forEach((s, si) => {
      let start: number | null = inside(s, 0) ? null : 0;
      let prev = 0, prevIn = start === null;
      if (prevIn) any = true;
      for (let k = 1; k <= STEPS; k++) {
        const t = k / STEPS, inn = inside(s, t);
        if (inn !== prevIn) {
          // refine the boundary between prev and t
          let lo = prev, hi = t;
          for (let i = 0; i < 12; i++) {
            const m = (lo + hi) / 2;
            if (inside(s, m) === prevIn) lo = m;
            else hi = m;
          }
          const b = (lo + hi) / 2;
          if (inn) {
            if (start !== null && b - start > 1e-6) pieces.push([si, start, b]);
            start = null;
            any = true;
          } else start = b;
        }
        if (inn) any = true;
        prev = t;
        prevIn = inn;
      }
      if (start !== null && 1 - start > 1e-6) pieces.push([si, start, 1]);
    });
    if (!any) {
      out.push(c);
      continue;
    }
    touched = true;
    // chain pieces that meet (end of one segment = start of the next)
    const runs: [number, number, number][][] = [];
    for (const p of pieces) {
      const last = runs[runs.length - 1]?.at(-1);
      if (last && last[2] === 1 && p[1] === 0 && p[0] === last[0] + 1) runs[runs.length - 1].push(p);
      else runs.push([p]);
    }
    // a closed contour: the run through the start point continues the last run
    if (c.closed && runs.length > 1) {
      const first = runs[0], last = runs[runs.length - 1];
      if (first[0][0] === 0 && first[0][1] === 0 && last.at(-1)![0] === segs.length - 1 && last.at(-1)![2] === 1) {
        runs[runs.length - 1] = [...last, ...first];
        runs.shift();
      }
    }
    for (const run of runs) {
      const cubics = run.map(([si, t0, t1]) => subCubic(segs[si], t0, t1));
      const nodes: VectorAnchor[] = [];
      cubics.forEach((q, i) => {
        if (i === 0) nodes.push({ anchor: q[0], handleIn: q[0], handleOut: q[1], isCorner: true });
        else nodes[nodes.length - 1].handleOut = q[1];
        const joint = run[i + 1] && run[i][2] === 1 ? c.nodes[(run[i][0] + 1) % c.nodes.length] : null;
        nodes.push({ anchor: q[3], handleIn: q[2], handleOut: q[3], isCorner: joint ? joint.isCorner : true });
      });
      if (nodes.length >= 2) out.push({ closed: false, nodes });
    }
  }
  if (!touched) return undefined;
  return out.length ? out : null;
}

/** The eraser track (page px) as an area: a disc at every point and a band along every step. */
export function eraserArea(track: Vec2[], radius: number): MultiPolygon {
  const polys: Polygon[] = [];
  const disc = (c: Vec2): Polygon => [Array.from({ length: 17 }, (_, i) => {
    const a = ((i % 16) / 16) * Math.PI * 2;
    return [c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)] as [number, number];
  })];
  for (const p of track) polys.push(disc(p));
  for (let i = 0; i + 1 < track.length; i++) {
    const [ax, ay] = track[i], [bx, by] = track[i + 1];
    const l = Math.hypot(bx - ax, by - ay);
    if (l < 1e-9) continue;
    const nx = (-(by - ay) / l) * radius, ny = ((bx - ax) / l) * radius;
    polys.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny]]]);
  }
  return polys.length ? polygonClipping.union(polys[0], ...polys.slice(1)) : [];
}

/**
 * Erase along `track` (page px, eraser radius `radius`) on a vector path. Returns the path that remains (same id and
 * look), null when nothing is left, undefined when the eraser did not touch it.
 * - a filled closed shape loses the covered area (its outline is then flattened to straight pieces — as Pathfinder);
 * - anything else (lines, open paths, stroke-only shapes) is cut where the eraser passes, its curves kept exactly.
 */
export function eraseVector(v: VectorNode, track: Vec2[], radius: number): VectorNode | null | undefined {
  if (!track.length) return undefined;
  const filled = !!v.fill && v.contours.some((c) => c.closed && c.nodes.length > 2);
  if (filled) {
    const rings = v.contours
      .filter((c) => c.closed && c.nodes.length > 2)
      .map((c) => {
        const ring = flatten(c, 0.35).map((p) => applyTransform(v.transform, p)) as [number, number][];
        ring.push(ring[0]);
        return [ring] as Polygon;
      });
    const shape = rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
    const cut = eraserArea(track, radius);
    if (!polygonClipping.intersection(shape, cut).length) return undefined;
    const left = polygonClipping.difference(shape, cut);
    const contours: Contour[] = [];
    for (const poly of left)
      for (const ring of poly) {
        const pts = ring.slice(0, -1);
        if (pts.length > 2) contours.push({ closed: true, nodes: pts.map(([x, y]) => ({ anchor: [x, y], handleIn: [x, y], handleOut: [x, y], isCorner: true })) });
      }
    if (!contours.length) return null;
    return { ...v, contours, fillRule: "evenodd", transform: { ...IDENTITY } };
  }
  const local = track.map((p) => invertTransform(v.transform, p));
  const k = (Math.abs(v.transform.scale) + Math.abs(v.transform.scaleY ?? v.transform.scale)) / 2 || 1;
  const reach = radius / k + (v.stroke ? v.strokeWidth / 2 : 0);
  const cut = cutContours(v.contours, local, reach);
  if (cut === undefined) return undefined;
  if (cut === null) return null;
  return { ...v, contours: cut };
}
