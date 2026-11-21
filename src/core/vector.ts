import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { applyTransform, rectFromPoints, type Rect } from "./geom";
import { IDENTITY, newVector, type Contour, type VectorAnchor, type VectorNode, type Vec2 } from "./types";

export function corner(x: number, y: number): VectorAnchor {
  return { anchor: [x, y], handleIn: [x, y], handleOut: [x, y], isCorner: true };
}

export function smooth(x: number, y: number, hix: number, hiy: number, hox: number, hoy: number): VectorAnchor {
  return { anchor: [x, y], handleIn: [hix, hiy], handleOut: [hox, hoy], isCorner: false };
}

export function rectContour(x: number, y: number, w: number, h: number): Contour {
  return { closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] };
}

const K = 0.5522847498;
export function ellipseContour(cx: number, cy: number, rx: number, ry: number): Contour {
  const kx = rx * K, ky = ry * K;
  return {
    closed: true,
    nodes: [
      smooth(cx, cy - ry, cx - kx, cy - ry, cx + kx, cy - ry),
      smooth(cx + rx, cy, cx + rx, cy - ky, cx + rx, cy + ky),
      smooth(cx, cy + ry, cx + kx, cy + ry, cx - kx, cy + ry),
      smooth(cx - rx, cy, cx - rx, cy + ky, cx - rx, cy - ky),
    ],
  };
}

export function cubicAt(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, t: number): Vec2 {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]];
}

function isLine(a: VectorAnchor, b: VectorAnchor): boolean {
  return (
    a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] &&
    b.handleIn[0] === b.anchor[0] && b.handleIn[1] === b.anchor[1]
  );
}

/** Segments of a contour as (from, to) anchor pairs. */
export function segments(c: Contour): [VectorAnchor, VectorAnchor][] {
  const out: [VectorAnchor, VectorAnchor][] = [];
  for (let i = 0; i + 1 < c.nodes.length; i++) out.push([c.nodes[i], c.nodes[i + 1]]);
  if (c.closed && c.nodes.length > 1) out.push([c.nodes[c.nodes.length - 1], c.nodes[0]]);
  return out;
}

/** Adaptive flattening: segment subdivisions chosen from control-polygon length. */
export function flatten(c: Contour, tolerance = 0.5): Vec2[] {
  if (c.nodes.length === 0) return [];
  const pts: Vec2[] = [c.nodes[0].anchor];
  for (const [a, b] of segments(c)) {
    if (isLine(a, b)) {
      pts.push(b.anchor);
      continue;
    }
    const len =
      Math.hypot(a.handleOut[0] - a.anchor[0], a.handleOut[1] - a.anchor[1]) +
      Math.hypot(b.handleIn[0] - a.handleOut[0], b.handleIn[1] - a.handleOut[1]) +
      Math.hypot(b.anchor[0] - b.handleIn[0], b.anchor[1] - b.handleIn[1]);
    const n = Math.max(4, Math.min(256, Math.ceil(Math.sqrt(len / tolerance) * 1.5)));
    for (let i = 1; i <= n; i++) pts.push(cubicAt(a.anchor, a.handleOut, b.handleIn, b.anchor, i / n));
  }
  if (c.closed && pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (f[0] === l[0] && f[1] === l[1]) pts.pop();
  }
  return pts;
}

export function vectorLocalBounds(n: VectorNode): Rect {
  const pts: Vec2[] = [];
  for (const c of n.contours) pts.push(...flatten(c, 2));
  const r = rectFromPoints(pts);
  const pad = n.stroke ? n.strokeWidth / 2 + 1 : 1;
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function contourToSvgD(c: Contour): string {
  if (!c.nodes.length) return "";
  const f = (v: number) => +v.toFixed(3);
  let d = `M${f(c.nodes[0].anchor[0])} ${f(c.nodes[0].anchor[1])}`;
  for (const [a, b] of segments(c)) {
    if (isLine(a, b)) d += `L${f(b.anchor[0])} ${f(b.anchor[1])}`;
    else
      d += `C${f(a.handleOut[0])} ${f(a.handleOut[1])} ${f(b.handleIn[0])} ${f(b.handleIn[1])} ${f(b.anchor[0])} ${f(b.anchor[1])}`;
  }
  if (c.closed) d += "Z";
  return d;
}

export function vectorToSvgD(n: VectorNode): string {
  return n.contours.map(contourToSvgD).join(" ");
}

// ---------- Pathfinder (boolean ops) ----------
// Paths are flattened in page space and combined with a robust sweep-line clipper.

export type BoolOp = "union" | "subtract" | "intersect" | "exclude";

function toMultiPolygon(n: VectorNode): MultiPolygon {
  const rings = n.contours
    .filter((c) => c.closed && c.nodes.length > 2)
    .map((c) => {
      const ring = flatten(c, 0.35).map((p) => applyTransform(n.transform, p)) as [number, number][];
      ring.push(ring[0]);
      return ring;
    });
  // treat every ring as its own polygon and union them (handles holes from evenodd poorly, but stays robust)
  if (!rings.length) return [];
  const polys: Polygon[] = rings.map((r) => [r]);
  return polys.length === 1 ? [polys[0]] : polygonClipping.xor(polys[0], ...polys.slice(1));
}

export function pathfinder(op: BoolOp, nodes: VectorNode[]): VectorNode | null {
  if (nodes.length < 2) return null;
  const geoms = nodes.map(toMultiPolygon);
  let result: MultiPolygon;
  switch (op) {
    case "union":
      result = polygonClipping.union(geoms[0], ...geoms.slice(1));
      break;
    case "subtract":
      result = polygonClipping.difference(geoms[0], ...geoms.slice(1));
      break;
    case "intersect":
      result = polygonClipping.intersection(geoms[0], ...geoms.slice(1));
      break;
    case "exclude":
      result = polygonClipping.xor(geoms[0], ...geoms.slice(1));
      break;
  }
  const contours: Contour[] = [];
  for (const poly of result)
    for (const ring of poly) {
      const pts = ring.slice(0, -1);
      if (pts.length > 2) contours.push({ closed: true, nodes: pts.map(([x, y]) => corner(x, y)) });
    }
  if (!contours.length) return null;
  const base = nodes[0];
  const out = newVector(contours, `${base.name} (${op})`);
  return { ...out, fill: base.fill, stroke: base.stroke, strokeWidth: base.strokeWidth, fillRule: "evenodd", transform: { ...IDENTITY } };
}

/** Distance from a point to a contour polyline (for hit testing strokes and anchors). */
export function distanceToContour(c: Contour, p: Vec2): number {
  const pts = flatten(c, 1);
  if (c.closed && pts.length) pts.push(pts[0]);
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

export function pointInContours(n: VectorNode, p: Vec2): boolean {
  let inside = false;
  let winding = 0;
  for (const c of n.contours) {
    if (!c.closed) continue;
    const pts = flatten(c, 1);
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > p[1] !== yj > p[1]) {
        const x = ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi;
        if (p[0] < x) {
          inside = !inside;
          winding += yj > yi ? 1 : -1;
        }
      }
    }
  }
  return n.fillRule === "evenodd" ? inside : winding !== 0;
}
