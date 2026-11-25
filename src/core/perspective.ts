// Perspective grid (Illustrator's Perspective Grid tool Shift+P, design 2 2026-11-25): one- and two-point grids
// whose planes — left wall, right wall, floor — are each a projective map from a unit square onto the page. What
// is drawn on a plane is drawn in the plane's own square and mapped through it (ui/designPersp.ts).

import type { Contour, Vec2, VectorAnchor } from "./types";

export type PerspPlane = "left" | "right" | "floor";

export interface PerspGrid {
  /** one-point (one vanishing point, walls left and right of it) or two-point (a corner seen from the front) */
  kind: 1 | 2;
  /** y of the horizon line (page px) */
  horizon: number;
  /** y of the ground line (page px) */
  ground: number;
  /** x of the vanishing point (one-point) or the left one (two-point), on the horizon */
  vp1: number;
  /** x of the right vanishing point (two-point) */
  vp2: number;
  /** two-point: x of the corner where the walls meet; one-point: x of the left wall's front edge */
  ox: number;
  /** one-point: x of the right wall's front edge */
  ox2: number;
  /** height of the walls' front edges (px) */
  height: number;
  /** how far the planes reach toward their vanishing point (0..1) */
  depth: number;
  /** grid lines per side */
  cells: number;
}

/** A grid over a w × h page (Illustrator's default: the horizon a little under half way). */
export function defaultGrid(w: number, h: number, kind: 1 | 2 = 2): PerspGrid {
  return {
    kind,
    horizon: Math.round(h * 0.42),
    ground: Math.round(h * 0.86),
    vp1: Math.round(kind === 1 ? w / 2 : w * 0.04),
    vp2: Math.round(w * 0.96),
    ox: Math.round(kind === 1 ? w * 0.18 : w / 2),
    ox2: Math.round(w * 0.82),
    height: Math.round(h * 0.62),
    depth: kind === 1 ? 0.62 : 0.72,
    cells: 8,
  };
}

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Where lines a→b and c→d meet (their extensions); the midpoint of b and d when they are parallel. */
function meet(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 {
  const r: Vec2 = [b[0] - a[0], b[1] - a[1]], s: Vec2 = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-9) return lerp(b, d, 0.5);
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return [a[0] + r[0] * t, a[1] + r[1] * t];
}

/** The plane's corners on the page for its square's (0,0) (1,0) (1,1) (0,1). */
export function planeQuad(g: PerspGrid, plane: PerspPlane): [Vec2, Vec2, Vec2, Vec2] {
  if (g.kind === 2) {
    const ob: Vec2 = [g.ox, g.ground], ot: Vec2 = [g.ox, g.ground - g.height];
    const L: Vec2 = [g.vp1, g.horizon], R: Vec2 = [g.vp2, g.horizon];
    if (plane === "left") return [ob, lerp(ob, L, g.depth), lerp(ot, L, g.depth), ot];
    if (plane === "right") return [ob, lerp(ob, R, g.depth), lerp(ot, R, g.depth), ot];
    const a = lerp(ob, L, g.depth), b = lerp(ob, R, g.depth);
    return [ob, a, meet(a, R, b, L), b];
  }
  const V: Vec2 = [g.vp1, g.horizon];
  const lb: Vec2 = [g.ox, g.ground], lt: Vec2 = [g.ox, g.ground - g.height], rb: Vec2 = [g.ox2, g.ground], rt: Vec2 = [g.ox2, g.ground - g.height];
  if (plane === "left") return [lb, lerp(lb, V, g.depth), lerp(lt, V, g.depth), lt];
  if (plane === "right") return [rb, lerp(rb, V, g.depth), lerp(rt, V, g.depth), rt];
  return [lb, rb, lerp(rb, V, g.depth), lerp(lb, V, g.depth)];
}

/** 3 × 3 projective matrix, row by row (the last entry 1). */
export type Homography = [number, number, number, number, number, number, number, number, number];

/** The projective map of the unit square onto quad q (Heckbert's square-to-quad). */
export function squareToQuad(q: [Vec2, Vec2, Vec2, Vec2]): Homography {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  if (Math.abs(dx3) < 1e-9 && Math.abs(dy3) < 1e-9) return [x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1];
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (dx3 * dy2 - dx2 * dy3) / den, h = (dx1 * dy3 - dx3 * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

export function applyH(m: Homography, [u, v]: Vec2): Vec2 {
  const w = m[6] * u + m[7] * v + m[8] || 1e-9;
  return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w];
}

export function invertH(m: Homography): Homography {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1e-12;
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
}

/** The plane's map both ways: square → page and page → square. */
export function planeMap(g: PerspGrid, plane: PerspPlane): { to: (uv: Vec2) => Vec2; from: (p: Vec2) => Vec2 } {
  const H = squareToQuad(planeQuad(g, plane));
  const I = invertH(H);
  return { to: (uv) => applyH(H, uv), from: (p) => applyH(I, p) };
}

/** The grid lines of a plane on the page (each a pair of points). */
export function planeLines(g: PerspGrid, plane: PerspPlane): [Vec2, Vec2][] {
  const m = planeMap(g, plane);
  const out: [Vec2, Vec2][] = [];
  for (let k = 0; k <= g.cells; k++) {
    const s = k / g.cells;
    out.push([m.to([s, 0]), m.to([s, 1])], [m.to([0, s]), m.to([1, s])]);
  }
  return out;
}

/** Which plane holds page point p (inside its quad), left before right before floor; null for none. */
export function planeAt(g: PerspGrid, p: Vec2): PerspPlane | null {
  for (const pl of ["left", "right", "floor"] as PerspPlane[]) {
    const [u, v] = planeMap(g, pl).from(p);
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) return pl;
  }
  return null;
}

// ───────── saved grid, objects on a plane ─────────

/** A page's grid as saved: its settings and whether it shows. */
export type SavedPerspGrid = PerspGrid & { shown: boolean };

/** An object on a plane: its outline as it lies flat on the plane (plane px, x right, y down as read on the plane). */
export interface PerspAttach {
  plane: PerspPlane;
  flat: Contour[];
  /**
   * Text on a plane (its outlines drawn in perspective, the text kept to edit — Illustrator's perspective text): the
   * text as it was, flat on the page; `key` ties the outline paths of one text together; `d` = plane px − page px.
   */
  text?: import("./types").TextNode;
  key?: string;
  d?: Vec2;
}

/** The plane's px size: its square's u side and v side on the page at the front. */
function frame(g: PerspGrid, plane: PerspPlane): { su: number; sv: number } {
  const [a, b, , d] = planeQuad(g, plane);
  return { su: Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1])), sv: Math.max(1, Math.hypot(d[0] - a[0], d[1] - a[1])) };
}

/**
 * Plane px → the plane's square (u, v): oriented so things read left to right and upright on each plane, as they do
 * in Illustrator (two-point: the left wall runs toward the corner, the floor away from the viewer).
 */
export function flatToUv(g: PerspGrid, plane: PerspPlane, [x, y]: Vec2): Vec2 {
  const { su, sv } = frame(g, plane);
  if (plane === "floor") return g.kind === 2 ? [1 - y / su, x / sv] : [x / su, 1 - y / sv];
  const leftward = g.kind === 2 ? plane === "left" : plane === "right";
  return [leftward ? 1 - x / su : x / su, 1 - y / sv];
}

export function uvToFlat(g: PerspGrid, plane: PerspPlane, [u, v]: Vec2): Vec2 {
  const { su, sv } = frame(g, plane);
  if (plane === "floor") return g.kind === 2 ? [v * sv, (1 - u) * su] : [u * su, (1 - v) * sv];
  const leftward = g.kind === 2 ? plane === "left" : plane === "right";
  return [(leftward ? 1 - u : u) * su, (1 - v) * sv];
}

/** Page point ↔ plane px. */
export function flatToPage(g: PerspGrid, plane: PerspPlane, p: Vec2): Vec2 {
  return planeMap(g, plane).to(flatToUv(g, plane, p));
}
export function pageToFlat(g: PerspGrid, plane: PerspPlane, p: Vec2): Vec2 {
  return uvToFlat(g, plane, planeMap(g, plane).from(p));
}

/**
 * A flat outline projected onto the plane: anchors exactly; each curve split in two first so its handles (mapped as
 * points) follow the perspective closely.
 */
export function projectContours(g: PerspGrid, plane: PerspPlane, flat: Contour[]): Contour[] {
  const m = planeMap(g, plane);
  const P = (p: Vec2) => m.to(flatToUv(g, plane, p));
  return flat.map((c) => {
    const nodes: VectorAnchor[] = [];
    const n = c.nodes.length;
    const segs = c.closed ? n : n - 1;
    const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const straight = (a: VectorAnchor, b: VectorAnchor) => a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] && b.handleIn[0] === b.anchor[0] && b.handleIn[1] === b.anchor[1];
    const out: VectorAnchor[] = c.nodes.map((a) => ({ anchor: a.anchor, handleIn: a.handleIn, handleOut: a.handleOut, isCorner: a.isCorner }));
    // split every curved segment at its middle (de Casteljau) in flat space
    const split: VectorAnchor[] = [];
    for (let i = 0; i < n; i++) {
      const a = out[i];
      split.push(a);
      if (i >= segs) continue;
      const b = out[(i + 1) % n];
      if (straight(a, b)) continue;
      const p01 = lerp2(a.anchor, a.handleOut, 0.5), p12 = lerp2(a.handleOut, b.handleIn, 0.5), p23 = lerp2(b.handleIn, b.anchor, 0.5);
      const p012 = lerp2(p01, p12, 0.5), p123 = lerp2(p12, p23, 0.5), mid = lerp2(p012, p123, 0.5);
      a.handleOut = p01;
      out[(i + 1) % n] = { ...b, handleIn: p23 };
      if ((i + 1) % n === 0) split[0] = out[0];
      split.push({ anchor: mid, handleIn: p012, handleOut: p123, isCorner: false });
    }
    for (const a of split) nodes.push({ anchor: P(a.anchor), handleIn: P(a.handleIn), handleOut: P(a.handleOut), isCorner: a.isCorner });
    return { closed: c.closed, nodes };
  });
}
