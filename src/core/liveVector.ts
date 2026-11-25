// Live appearance of a path (Illustrator's Appearance panel): what a vector draws when it has live corners, a stroke
// aligned inside / outside, a width profile or live effects (Effect › Stylize › Round Corners, Distort & Transform ›
// Transform, Path › Offset Path). The node keeps its own path; `liveParts` gives the plain paths that are drawn (canvas,
// SVG, PDF and .ai saves alike) and `expandLive` (Object › Expand Appearance) makes them the document's paths.
//
// Everything stays in the node's own coordinates, so the parts share its transform. Nodes without any of these
// properties return null and are drawn as before (hashes and older files are unchanged).

import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import { rectFromPoints, type Rect } from "./geom";
import type { Contour, Vec2, VectorAnchor, VectorNode } from "./types";
import { flatten } from "./vector";

/** Illustrator's width profiles (Stroke panel › Profile), the ones its users reach for. */
export type WidthProfile = "lens" | "taperEnd" | "taperStart" | "bulgeEnds";
export const WIDTH_PROFILES: readonly WidthProfile[] = ["lens", "taperEnd", "taperStart", "bulgeEnds"];

export type VectorFx =
  /** Effect › Stylize › Round Corners: radius px */
  | { kind: "roundCorners"; on: boolean; r: number }
  /** Effect › Path › Offset Path: distance px (negative shrinks), joins */
  | { kind: "offset"; on: boolean; d: number; join?: "miter" | "round" | "bevel" }
  /** Effect › Distort & Transform › Transform: scale %, move px, rotate ° (counter-clockwise), copies, about the centre */
  | { kind: "transform"; on: boolean; sx: number; sy: number; dx: number; dy: number; angle: number; copies: number };
export type VectorFxKind = VectorFx["kind"];

/** A pattern swatch: its tile's paths (tile coordinates, 0..w × 0..h), repeated over the fill. */
export interface PatternFill {
  id: string;
  name: string;
  w: number;
  h: number;
  tile: VectorNode[];
  /** Pattern Options › Overlap: which neighbour is in front where the art reaches past the tile (default left, top) */
  overlapH?: "left" | "right";
  overlapV?: "top" | "bottom";
}

export function newVectorFx(kind: VectorFxKind): VectorFx {
  switch (kind) {
    case "roundCorners":
      return { kind, on: true, r: 10 };
    case "offset":
      return { kind, on: true, d: 10, join: "miter" };
    case "transform":
      return { kind, on: true, sx: 100, sy: 100, dx: 20, dy: 20, angle: 0, copies: 1 };
  }
}

/** Does the node draw differently from its own path (anything liveParts would change)? */
export function isLive(n: VectorNode): boolean {
  return !!(hasCorners(n) || (n.patternFill && n.patternFill.tile.length) || (n.stroke && n.strokeWidth > 0 && ((n.strokeAlign && n.contours.some((c) => c.closed)) || n.widthProfile)) || n.vfx?.some((f) => f.on));
}

/** Live corners set: one radius for all, or some per-corner radius above 0. */
const hasCorners = (n: VectorNode) => (n.cornerRadius ?? 0) > 0 || !!n.cornerRadii?.some((r) => r?.some((x) => (x ?? 0) > 0));

const cache = new WeakMap<VectorNode, VectorNode[]>();

/** The plain paths a live node draws, bottom to top (null when the node draws its own path). */
export function liveParts(n: VectorNode): VectorNode[] | null {
  if (!isLive(n)) return null;
  let p = cache.get(n);
  if (!p) {
    // the polygon engine can fail on near-degenerate outlines: then the path draws as it is rather than not at all
    try {
      p = computeParts(n);
    } catch {
      p = [plainCopy(n)];
    }
    cache.set(n, p);
  }
  return p;
}

/** Bounds of what a live node draws (its own coordinates, strokes included). */
export function liveBounds(n: VectorNode): Rect | null {
  const parts = liveParts(n);
  if (!parts) return null;
  const pts: Vec2[] = [];
  let pad = 1;
  for (const q of parts) {
    for (const c of q.contours) pts.push(...flatten(c, 2));
    if (q.stroke) pad = Math.max(pad, q.strokeWidth / 2 + 1);
  }
  if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
  const r = rectFromPoints(pts);
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

/** The node's live properties dropped (what the parts are drawn as). */
export function plainCopy(n: VectorNode, patch: Partial<VectorNode> = {}): VectorNode {
  const q: VectorNode = { ...n, ...patch };
  delete q.cornerRadius;
  delete q.cornerRadii;
  delete q.strokeAlign;
  delete q.widthProfile;
  delete q.vfx;
  delete q.patternFill;
  return q;
}

function computeParts(n: VectorNode): VectorNode[] {
  // the geometry: live corners, then the effects in their order (Appearance panel, top = last applied)
  const radius = (ci: number) => (i: number) => n.cornerRadii?.[ci]?.[i] ?? n.cornerRadius ?? 0;
  let sets: Contour[][] = [hasCorners(n) ? n.contours.map((c, ci) => roundCorners(c, radius(ci))) : n.contours];
  for (const f of n.vfx ?? []) {
    if (!f.on) continue;
    if (f.kind === "roundCorners") sets = sets.map((cs) => cs.map((c) => roundCorners(c, f.r)));
    else if (f.kind === "offset") sets = sets.map((cs) => offsetContours(cs, f.d, f.join ?? "miter", n.fillRule));
    else if (f.kind === "transform") {
      const out: Contour[][] = [];
      for (const cs of sets) {
        out.push(cs);
        let cur = cs;
        const ctr = centreOf(cs);
        for (let i = 0; i < Math.max(0, Math.min(500, Math.round(f.copies))); i++) {
          cur = cur.map((c) => mapContour(c, xformMap(f, ctr)));
          out.push(cur);
        }
      }
      sets = out;
    }
  }
  const parts: VectorNode[] = [];
  const stroked = !!n.stroke && n.strokeWidth > 0;
  const special = stroked && (!!n.widthProfile || (!!n.strokeAlign && n.contours.some((c) => c.closed)));
  const pattern = n.patternFill?.tile.length ? n.patternFill : null;
  for (const cs of sets) {
    // a pattern fill: the tile's paths repeated over the shape, cut to it, under the stroke
    if (pattern) parts.push(...patternParts(n, cs, pattern));
    if (!special) {
      parts.push(plainCopy(n, pattern ? { contours: cs, fill: null } : { contours: cs }));
      continue;
    }
    // the fill as a part of its own, the stroke as a filled outline above it
    if (n.fill && !pattern) parts.push(plainCopy(n, { contours: cs, stroke: null, strokeWidth: 0, strokeArrows: undefined }));
    const outline = n.widthProfile ? profileOutline(cs, n.strokeWidth, n.widthProfile, n.strokeCap ?? "round") : alignedOutline(cs, n.strokeWidth, n.strokeAlign!, n.strokeJoin ?? "round", n.fillRule);
    const contours = contoursOf(outline);
    if (contours.length) {
      const sp = (n as VectorNode & { strokes?: { paint: unknown }[] }).strokes?.[0]?.paint;
      const q = plainCopy(n, { contours, fill: n.stroke, stroke: null, strokeWidth: 0, fillRule: "nonzero", strokeDash: undefined, strokeArrows: undefined });
      const anyQ = q as VectorNode & { fills?: unknown[]; strokes?: unknown[] };
      delete anyQ.strokes;
      if (sp) anyQ.fills = [sp];
      else delete anyQ.fills;
      parts.push(q);
    }
  }
  for (const q of parts) {
    if (q.strokeArrows === undefined) delete q.strokeArrows;
    if (q.strokeDash === undefined) delete q.strokeDash;
  }
  return parts;
}

/** The pattern's tile paths repeated over the area of `cs` and cut to it: one part per tile path. */
function patternParts(n: VectorNode, cs: Contour[], pf: PatternFill): VectorNode[] {
  const area = areaOf(cs, n.fillRule);
  if (!area.length || pf.w < 0.5 || pf.h < 0.5) return [];
  const pts = area.flatMap((poly) => poly[0]);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.floor(Math.min(...xs) / pf.w), x1 = Math.ceil(Math.max(...xs) / pf.w), y0 = Math.floor(Math.min(...ys) / pf.h), y1 = Math.ceil(Math.max(...ys) / pf.h);
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) return [];
  const out: VectorNode[] = [];
  // art reaching past the tile: copy by copy, in the overlap order (the copies in front last)
  const reach = pf.tile.some((tq) => {
    if (tq.type !== "VECTOR") return false;
    const pts = tq.contours.flatMap((c) => c.nodes.map((a) => tileAt(tq.transform, a.anchor)));
    const pad = tq.stroke ? tq.strokeWidth / 2 : 0;
    return pts.some(([x, y]) => x - pad < -0.01 || y - pad < -0.01 || x + pad > pf.w + 0.01 || y + pad > pf.h + 0.01);
  });
  if (reach && (x1 - x0 + 3) * (y1 - y0 + 3) * pf.tile.length <= 1500) return patternCopies(n, area, pf, x0, x1, y0, y1);
  // one tile area repeated over the shape's box and cut to the shape
  const tiled = (base: MultiPolygon): Contour[] => {
    const copies: Polygon[] = [];
    for (let i = x0 - 1; i <= x1; i++)
      for (let j = y0 - 1; j <= y1; j++) for (const poly of base) copies.push(poly.map((r) => r.map(([x, y]) => [q(x + i * pf.w), q(y + j * pf.h)] as [number, number])));
    return contoursOf(polygonClipping.intersection(unionAll(copies), area));
  };
  const part = (id: string, contours: Contour[], fill: string) => plainCopy(n, { id, contours, fill, stroke: null, strokeWidth: 0, fillRule: "nonzero", strokeArrows: undefined, strokeDash: undefined });
  for (const tq of pf.tile) {
    if (tq.type !== "VECTOR") continue;
    const t = tq.transform;
    const local = tq.contours.map((c) => mapContour(c, (p) => tileAt(t, p)));
    // the tile path's fill, then its stroke (as an outline) above it
    if (tq.fill) {
      const base = areaOf(local, tq.fillRule);
      const contours = base.length ? tiled(base) : [];
      if (contours.length) out.push(part(`${n.id}~${tq.id}`, contours, tq.fill));
    }
    if (tq.stroke && tq.strokeWidth > 0) {
      const w = tq.strokeWidth * (Math.abs(t.scale) || 1);
      const base = band(local.filter((c) => c.nodes.length > 1).map((c) => ({ pts: flatten(c, 0.2), closed: c.closed })), () => w, (tq.strokeCap ?? "round") !== "butt");
      const contours = base.length ? tiled(base) : [];
      if (contours.length) out.push(part(`${n.id}~${tq.id}~s`, contours, tq.stroke));
    }
  }
  return out;
}

/** The pattern drawn copy by copy (so the neighbour in front covers the other where the art overlaps). */
function patternCopies(n: VectorNode, area: MultiPolygon, pf: PatternFill, x0: number, x1: number, y0: number, y1: number): VectorNode[] {
  const shapes = pf.tile
    .filter((tq) => tq.type === "VECTOR")
    .map((tq) => {
      const local = tq.contours.map((c) => mapContour(c, (p) => tileAt(tq.transform, p)));
      const w = tq.strokeWidth * (Math.abs(tq.transform.scale) || 1);
      return {
        id: tq.id,
        fill: tq.fill ? areaOf(local, tq.fillRule) : [],
        fillColour: tq.fill,
        stroke: tq.stroke && w > 0 ? band(local.filter((c) => c.nodes.length > 1).map((c) => ({ pts: flatten(c, 0.2), closed: c.closed })), () => w, (tq.strokeCap ?? "round") !== "butt") : [],
        strokeColour: tq.stroke,
      };
    });
  const is = Array.from({ length: x1 - x0 + 2 }, (_, k) => x0 - 1 + k), js = Array.from({ length: y1 - y0 + 2 }, (_, k) => y0 - 1 + k);
  // drawn first = behind: left in front → right to left; top in front → bottom to top
  if ((pf.overlapH ?? "left") === "left") is.reverse();
  if ((pf.overlapV ?? "top") === "top") js.reverse();
  const out: VectorNode[] = [];
  const put = (mp: MultiPolygon, dx: number, dy: number, colour: string, id: string) => {
    if (!mp.length) return;
    const moved: MultiPolygon = mp.map((poly) => poly.map((r) => r.map(([x, y]) => [q(x + dx), q(y + dy)] as [number, number])));
    const contours = contoursOf(polygonClipping.intersection(moved, area));
    if (contours.length) out.push(plainCopy(n, { id, contours, fill: colour, stroke: null, strokeWidth: 0, fillRule: "nonzero", strokeArrows: undefined, strokeDash: undefined }));
  };
  for (const j of js)
    for (const i of is)
      for (const sh of shapes) {
        if (sh.fillColour) put(sh.fill, i * pf.w, j * pf.h, sh.fillColour, `${n.id}~${sh.id}~${i}_${j}`);
        if (sh.strokeColour) put(sh.stroke, i * pf.w, j * pf.h, sh.strokeColour, `${n.id}~${sh.id}~s${i}_${j}`);
      }
  return out;
}

function tileAt(t: VectorNode["transform"], p: Vec2): Vec2 {
  const a = (t.rotation * Math.PI) / 180, sx = t.scale, sy = t.scaleY ?? t.scale;
  return [t.x + Math.cos(a) * p[0] * sx - Math.sin(a) * p[1] * sy, t.y + Math.sin(a) * p[0] * sx + Math.cos(a) * p[1] * sy];
}

// ───────── geometry ─────────

const pt = (x: number, y: number): VectorAnchor => ({ anchor: [x, y], handleIn: [x, y], handleOut: [x, y], isCorner: true });
const eq = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const len = (v: Vec2) => Math.hypot(v[0], v[1]);

/** A cubic segment's four points. */
type Cubic = [Vec2, Vec2, Vec2, Vec2];
const cubicPt = (b: Cubic, t: number): Vec2 => {
  const u = 1 - t;
  return [u * u * u * b[0][0] + 3 * u * u * t * b[1][0] + 3 * u * t * t * b[2][0] + t * t * t * b[3][0], u * u * u * b[0][1] + 3 * u * u * t * b[1][1] + 3 * u * t * t * b[2][1] + t * t * t * b[3][1]];
};
const lerp2 = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** The part of a cubic between t0 and t1 (de Casteljau). */
function subCubic(b: Cubic, t0: number, t1: number): Cubic {
  const split = (c: Cubic, t: number): [Cubic, Cubic] => {
    const p01 = lerp2(c[0], c[1], t), p12 = lerp2(c[1], c[2], t), p23 = lerp2(c[2], c[3], t);
    const p012 = lerp2(p01, p12, t), p123 = lerp2(p12, p23, t), m = lerp2(p012, p123, t);
    return [[c[0], p01, p012, m], [m, p123, p23, c[3]]];
  };
  if (t1 < 1) b = split(b, t1)[0];
  if (t0 > 0) b = split(b, t1 > 0 ? t0 / t1 : 0)[1];
  return b;
}
/** The arc-length table of a cubic (t at 64 even steps). */
function arcTable(b: Cubic): number[] {
  const acc = [0];
  let prev = b[0];
  for (let i = 1; i <= 64; i++) {
    const p = cubicPt(b, i / 64);
    acc.push(acc[i - 1] + len(sub(p, prev)));
    prev = p;
  }
  return acc;
}
/** The t at arc length s from the start. */
function tAt(acc: number[], s: number): number {
  if (s <= 0) return 0;
  const L = acc[acc.length - 1];
  if (s >= L) return 1;
  let i = 1;
  while (acc[i] < s) i++;
  return (i - 1 + (s - acc[i - 1]) / (acc[i] - acc[i - 1] || 1)) / 64;
}
const unit = (v: Vec2): Vec2 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l];
};

interface CornerGeo {
  i: number;
  /** the directions from the corner along the incoming (back) and outgoing sides */
  u: Vec2;
  v: Vec2;
  /** the corner's own angle */
  phi: number;
}

/** The sharp corners of a contour (a turn of more than about 1 degree; open ends excluded), with their sides' directions. */
function cornerGeo(c: Contour): CornerGeo[] {
  const ns = c.nodes, m = ns.length, out: CornerGeo[] = [];
  if (m < (c.closed ? 2 : 3)) return out;
  for (let i = 0; i < m; i++) {
    if (!c.closed && (i === 0 || i === m - 1)) continue;
    const a = ns[i], prev = ns[(i - 1 + m) % m], next = ns[(i + 1) % m];
    const back = !eq(a.handleIn, a.anchor) ? a.handleIn : !eq(prev.handleOut, a.anchor) ? prev.handleOut : prev.anchor;
    const fwd = !eq(a.handleOut, a.anchor) ? a.handleOut : !eq(next.handleIn, a.anchor) ? next.handleIn : next.anchor;
    const u = sub(back, a.anchor), v = sub(fwd, a.anchor);
    if (len(u) < 1e-9 || len(v) < 1e-9) continue;
    const uu = unit(u), vv = unit(v);
    const phi = Math.acos(Math.max(-1, Math.min(1, uu[0] * vv[0] + uu[1] * vv[1])));
    if (phi > Math.PI - 0.02 || phi < 1e-3) continue;
    out.push({ i, u: uu, v: vv, phi });
  }
  return out;
}

/**
 * Round the sharp corners of a contour with fillets (Illustrator's live corners and Round Corners effect): `r` is one
 * radius for every corner or a radius per anchor index. Straight and curved sides alike: a curved side is cut where
 * the fillet meets it. A fillet is kept to half of each side, so neighbouring corners never cross.
 */
export function roundCorners(c: Contour, r: number | ((i: number) => number)): Contour {
  const ns = c.nodes, m = ns.length;
  const rOf = typeof r === "number" ? () => r : r;
  const corners = cornerGeo(c).filter((g) => rOf(g.i) > 0);
  if (!corners.length) return c;
  const segCount = c.closed ? m : m - 1;
  // a straight side as a cubic with evenly spaced handles (an even speed, so lengths map to t exactly)
  const straight = (j: number) => eq(ns[j].handleOut, ns[j].anchor) && eq(ns[(j + 1) % m].handleIn, ns[(j + 1) % m].anchor);
  const seg = (j: number): Cubic => {
    const a = ns[j].anchor, b = ns[(j + 1) % m].anchor;
    return straight(j) ? [a, lerp2(a, b, 1 / 3), lerp2(a, b, 2 / 3), b] : [a, ns[j].handleOut, ns[(j + 1) % m].handleIn, b];
  };
  const tables = Array.from({ length: segCount }, (_, j) => arcTable(seg(j)));
  // per segment: where it starts and ends after trimming (t)
  const t0: number[] = new Array(segCount).fill(0), t1: number[] = new Array(segCount).fill(1);
  const fillet = new Map<number, { p1: Vec2; p2: Vec2; h1: Vec2; h2: Vec2 }>();
  for (const g of corners) {
    const jin = (g.i - 1 + m) % m, jout = g.i;
    if (jin >= segCount || jout >= segCount) continue;
    const Lin = tables[jin][64], Lout = tables[jout][64];
    let T = rOf(g.i) / Math.tan(g.phi / 2);
    T = Math.min(T, Lin / 2, Lout / 2);
    if (T < 1e-6) continue;
    const rr = T * Math.tan(g.phi / 2);
    const k = (4 / 3) * Math.tan((Math.PI - g.phi) / 4) * rr;
    t1[jin] = tAt(tables[jin], Lin - T);
    t0[jout] = tAt(tables[jout], T);
    const p1 = cubicPt(seg(jin), t1[jin]), p2 = cubicPt(seg(jout), t0[jout]);
    // the fillet leaves p1 along the incoming side's direction there and arrives at p2 along the outgoing one
    const e = 1e-3;
    const d1 = unit(sub(cubicPt(seg(jin), Math.min(1, t1[jin] + e)), cubicPt(seg(jin), Math.max(0, t1[jin] - e))));
    const d2 = unit(sub(cubicPt(seg(jout), Math.min(1, t0[jout] + e)), cubicPt(seg(jout), Math.max(0, t0[jout] - e))));
    fillet.set(g.i, { p1, p2, h1: [p1[0] + d1[0] * k, p1[1] + d1[1] * k], h2: [p2[0] - d2[0] * k, p2[1] - d2[1] * k] });
  }
  // (a straight side stays straight: its handles on its ends)
  const parts = Array.from({ length: segCount }, (_, j) => {
    const b = subCubic(seg(j), t0[j], t1[j]);
    return straight(j) ? ([b[0], b[0], b[3], b[3]] as Cubic) : b;
  });
  const out: VectorAnchor[] = [];
  for (let i = 0; i < m; i++) {
    const inSeg = c.closed || i > 0 ? parts[(i - 1 + m) % m] : null;
    const outSeg = i < segCount ? parts[i] : null;
    const f = fillet.get(i);
    if (f) {
      out.push({ anchor: f.p1, handleIn: inSeg ? inSeg[2] : f.p1, handleOut: f.h1, isCorner: false });
      out.push({ anchor: f.p2, handleIn: f.h2, handleOut: outSeg ? outSeg[1] : f.p2, isCorner: false });
    } else {
      const a = ns[i];
      out.push({ ...a, handleIn: inSeg ? inSeg[2] : a.handleIn, handleOut: outSeg ? outSeg[1] : a.handleOut });
    }
  }
  return { ...c, nodes: out };
}

/** The corners of a contour that live corners round (sharp ones, straight or curved sides), as indices. */
export function roundableCorners(c: Contour): number[] {
  return cornerGeo(c).map((g) => g.i);
}

/** A corner's own angle and side directions (for the canvas widget), or null for a smooth point. */
export function cornerAt(c: Contour, i: number): { u: Vec2; v: Vec2; phi: number } | null {
  return cornerGeo(c).find((g) => g.i === i) ?? null;
}

/** The largest radius live corners can take on these contours (half the shorter side at the tightest corner). */
export function maxCornerRadius(cs: Contour[]): number {
  let best = Infinity;
  for (const c of cs) {
    const m = c.nodes.length;
    for (const g of cornerGeo(c)) {
      const a = c.nodes[g.i].anchor, p = c.nodes[(g.i - 1 + m) % m].anchor, q = c.nodes[(g.i + 1) % m].anchor;
      best = Math.min(best, (Math.min(len(sub(p, a)), len(sub(q, a))) / 2) * Math.tan(g.phi / 2));
    }
  }
  return Number.isFinite(best) ? best : 0;
}

function centreOf(cs: Contour[]): Vec2 {
  const pts = cs.flatMap((c) => c.nodes.map((a) => a.anchor));
  if (!pts.length) return [0, 0];
  const r = rectFromPoints(pts);
  return [r.x + r.w / 2, r.y + r.h / 2];
}

function xformMap(f: Extract<VectorFx, { kind: "transform" }>, [cx, cy]: Vec2): (p: Vec2) => Vec2 {
  const a = (-f.angle * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
  return ([x, y]) => {
    const X = ((x - cx) * f.sx) / 100, Y = ((y - cy) * f.sy) / 100;
    return [cx + X * co - Y * si + f.dx, cy + X * si + Y * co + f.dy];
  };
}

export function mapContour(c: Contour, f: (p: Vec2) => Vec2): Contour {
  return { ...c, nodes: c.nodes.map((a) => ({ ...a, anchor: f(a.anchor), handleIn: f(a.handleIn), handleOut: f(a.handleOut) })) };
}

// coordinates on a 1/1024 px grid: the sweep-line engine (polygon-clipping) stays robust on nearly touching edges
const q = (v: number) => Math.round(v * 1024) / 1024;
const ring = (pts: Vec2[]): Ring => {
  const r: [number, number][] = [];
  for (const [x, y] of pts) {
    const a: [number, number] = [q(x), q(y)];
    const l = r[r.length - 1];
    if (!l || l[0] !== a[0] || l[1] !== a[1]) r.push(a);
  }
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]]);
  return r;
};

/** The filled area of contours (open ones close themselves, as the fill does). */
export function areaOf(cs: Contour[], rule: "nonzero" | "evenodd" = "nonzero", tol = 0.2): MultiPolygon {
  const polys = cs.filter((c) => c.nodes.length > 2).map((c) => [ring(flatten(c, tol))] as Polygon);
  if (!polys.length) return [];
  if (polys.length === 1) return polygonClipping.union(polys[0]);
  return rule === "evenodd" ? polygonClipping.xor(polys[0], ...polys.slice(1)) : polygonClipping.union(polys[0], ...polys.slice(1));
}

function disc([cx, cy]: Vec2, r: number): Polygon {
  const n = Math.max(12, Math.min(64, Math.ceil(r * 1.5)));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) out.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return [ring(out)];
}

function unionAll(parts: Polygon[]): MultiPolygon {
  let acc: MultiPolygon = [];
  for (let i = 0; i < parts.length; i += 200) acc = polygonClipping.union(acc, ...parts.slice(i, i + 200));
  return acc;
}

/** A band of width w along polylines with round joins (and round ends when `ends`). */
function band(lines: { pts: Vec2[]; closed: boolean }[], w: (i: number, line: number) => number, ends = true): MultiPolygon {
  const parts: Polygon[] = [];
  lines.forEach(({ pts, closed }, li) => {
    const p = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1];
      const l = Math.hypot(bx - ax, by - ay);
      if (l < 1e-9) continue;
      const ha = w(i, li) / 2, hb = w(closed && i + 1 === p.length - 1 ? 0 : i + 1, li) / 2;
      if (ha < 1e-4 && hb < 1e-4) continue;
      const nx = -(by - ay) / l, ny = (bx - ax) / l;
      parts.push([ring([[ax + nx * ha, ay + ny * ha], [bx + nx * hb, by + ny * hb], [bx - nx * hb, by - ny * hb], [ax - nx * ha, ay - ny * ha]])]);
    }
    for (let i = 0; i < pts.length; i++) {
      if (!ends && !closed && (i === 0 || i === pts.length - 1)) continue;
      const h = w(i, li) / 2;
      if (h > 0.05) parts.push(disc(pts[i], h));
    }
  });
  return parts.length ? unionAll(parts) : [];
}

/** A closed polyline grown by d with mitred corners (Illustrator's default join); may self-overlap, which the union mends. */
function miterRing(pts: Vec2[], d: number, limit = 4): Vec2[] {
  const m = pts.length;
  // the ring's orientation: grow outwards whichever way it turns
  let area = 0;
  for (let i = 0; i < m; i++) area += pts[i][0] * pts[(i + 1) % m][1] - pts[(i + 1) % m][0] * pts[i][1];
  const s = area > 0 ? 1 : -1; // y down: a positive shoelace sum is clockwise on screen
  const out: Vec2[] = [];
  for (let i = 0; i < m; i++) {
    const p0 = pts[(i - 1 + m) % m], p1 = pts[i], p2 = pts[(i + 1) % m];
    const e1 = sub(p1, p0), e2 = sub(p2, p1);
    const l1 = len(e1) || 1, l2 = len(e2) || 1;
    const n1: Vec2 = [(s * e1[1]) / l1, (-s * e1[0]) / l1], n2: Vec2 = [(s * e2[1]) / l2, (-s * e2[0]) / l2];
    const bis: Vec2 = [n1[0] + n2[0], n1[1] + n2[1]];
    const bl = len(bis);
    const cosHalf = bl / 2;
    if (bl < 1e-9 || 1 / cosHalf > limit) {
      // too sharp for a mitre: bevel
      out.push([p1[0] + n1[0] * d, p1[1] + n1[1] * d], [p1[0] + n2[0] * d, p1[1] + n2[1] * d]);
      continue;
    }
    const k = d / (cosHalf * cosHalf) / 2;
    out.push([p1[0] + bis[0] * k, p1[1] + bis[1] * k]);
  }
  return out;
}

/** The area grown (d > 0) or shrunk (d < 0) by |d|. */
export function offsetArea(cs: Contour[], d: number, join: "miter" | "round" | "bevel", rule: "nonzero" | "evenodd"): MultiPolygon {
  const area = areaOf(cs, rule);
  if (!area.length || !d) return area;
  if (join === "miter") {
    // each ring of the area mitred outwards (holes inwards): grown = union of the mitred outer rings minus mitred holes
    const res: Polygon[] = [];
    for (const poly of area) {
      const outer = miterRing(poly[0].slice(0, -1) as Vec2[], d);
      const holes = poly.slice(1).map((h) => miterRing(h.slice(0, -1) as Vec2[], -d));
      let p: MultiPolygon = polygonClipping.union([ring(outer)]);
      if (d < 0) p = polygonClipping.intersection(p, [poly[0]]);
      for (const h of holes) p = polygonClipping.difference(p, [ring(h)]);
      res.push(...p);
    }
    return res.length ? polygonClipping.union(res[0], ...res.slice(1)) : [];
  }
  const lines = area.flatMap((poly) => poly.map((r) => ({ pts: r.slice(0, -1) as Vec2[], closed: true })));
  const b = band(lines, () => Math.abs(d) * 2);
  return d > 0 ? polygonClipping.union(area, b) : polygonClipping.difference(area, b);
}

function offsetContours(cs: Contour[], d: number, join: "miter" | "round" | "bevel", rule: "nonzero" | "evenodd"): Contour[] {
  return contoursOf(offsetArea(cs, d, join, rule));
}

/** A stroke of width w drawn inside or outside the closed contours (open ones keep a centred stroke). */
function alignedOutline(cs: Contour[], w: number, align: "inside" | "outside", join: "miter" | "round" | "bevel", rule: "nonzero" | "evenodd"): MultiPolygon {
  const closed = cs.filter((c) => c.closed);
  const open = cs.filter((c) => !c.closed && c.nodes.length > 1);
  const area = areaOf(closed, rule);
  const grown = (j: typeof join) => (align === "outside" ? polygonClipping.difference(offsetArea(closed, w, j, rule), area) : polygonClipping.difference(area, offsetArea(closed, -w, j, rule)));
  let out: MultiPolygon;
  try {
    out = grown(join);
  } catch {
    // (a round join's many small discs can trip the sweep line: mitred corners then)
    out = grown("miter");
  }
  if (open.length) out = polygonClipping.union(out, band(open.map((c) => ({ pts: flatten(c, 0.2), closed: false })), () => w));
  return out;
}

/** The width factor (0..1) of a profile at u along the path (0 = start, 1 = end). */
export function profileAt(p: WidthProfile, u: number): number {
  switch (p) {
    case "lens":
      return Math.sin(Math.PI * Math.min(1, Math.max(0, u)));
    case "taperEnd":
      return 1 - u;
    case "taperStart":
      return u;
    case "bulgeEnds":
      return 0.35 + 0.65 * Math.abs(2 * u - 1);
  }
}

/** A stroke of width w × profile along each contour, as an area. */
function profileOutline(cs: Contour[], w: number, p: WidthProfile, cap: "butt" | "round" | "square"): MultiPolygon {
  const lines = cs.filter((c) => c.nodes.length > 1).map((c) => {
    // dense enough for a smooth width change
    let pts = flatten(c, 0.15);
    pts = densify(c.closed ? [...pts, pts[0]] : pts, Math.max(1, w / 4));
    if (c.closed) pts.pop();
    return { pts, closed: c.closed };
  });
  const widths = lines.map(({ pts, closed }) => {
    const acc = [0];
    for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + len(sub(pts[i], pts[i - 1])));
    const total = (closed ? acc[acc.length - 1] + len(sub(pts[0], pts[pts.length - 1])) : acc[acc.length - 1]) || 1;
    return acc.map((s) => w * profileAt(p, s / total));
  });
  return band(lines, (i, li) => widths[li][Math.min(i, widths[li].length - 1)], cap !== "butt");
}

function densify(pts: Vec2[], step: number): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i) {
      const a = pts[i - 1], b = pts[i];
      const l = len(sub(b, a));
      const k = Math.floor(l / step);
      for (let j = 1; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
    }
    out.push(pts[i]);
  }
  return out;
}

/** A multipolygon as straight-edged closed contours. */
export function contoursOf(mp: MultiPolygon): Contour[] {
  const out: Contour[] = [];
  for (const poly of mp)
    for (const r of poly) {
      const pts = r.slice(0, -1);
      if (pts.length > 2) out.push({ closed: true, nodes: pts.map(([x, y]) => pt(x, y)) });
    }
  return out;
}
