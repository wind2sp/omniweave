// Illustrator's Object › Path and Object menus on the design mode's selection (2026-11-24, the owner's check):
// Outline Stroke, Offset Path, Simplify, Average, Pathfinder Divide, Compound Path make / release (Ctrl+8 /
// Alt+Shift+Ctrl+8), Expand, and the Move / Rotate / Reflect / Scale dialogs' work. Geometry in page space; results
// replace or join the selection as one undo step each.

import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import { mapMesh, type MeshFill } from "../core/mesh";
import { applyTransform } from "../core/geom";
import { currentPage, draftPage, useStore } from "../core/store";
import { IDENTITY, newVector, type Contour, type SceneNode, type Vec2, type VectorAnchor, type VectorNode } from "../core/types";
import { flatten } from "../core/vector";
import type { Paint } from "../core/style/types";
import { t } from "../i18n";

const S = () => useStore.getState();

const corner = (x: number, y: number): VectorAnchor => ({ anchor: [x, y], handleIn: [x, y], handleOut: [x, y], isCorner: true });

/** The selected, unlocked vectors of the current page, in stacking order. */
export function selectedVectors(): VectorNode[] {
  const page = currentPage();
  const sel = new Set(S().selection);
  return (page?.nodes ?? []).filter((n): n is VectorNode => n.type === "VECTOR" && sel.has(n.id) && !n.locked);
}

/** A node's contours flattened into page space (closed rings close themselves; open ones stay polylines). */
function pagePolylines(n: VectorNode, tol = 0.35): { pts: Vec2[]; closed: boolean }[] {
  return n.contours.filter((c) => c.nodes.length > 1).map((c) => ({ pts: flatten(c, tol).map((p) => applyTransform(n.transform, p) as Vec2), closed: c.closed }));
}

const ringOf = (pts: Vec2[]): Ring => {
  const r = pts.map(([x, y]) => [x, y] as [number, number]);
  if (r.length && (r[0][0] !== r[r.length - 1][0] || r[0][1] !== r[r.length - 1][1])) r.push([r[0][0], r[0][1]]);
  return r;
};

/** The fill of a vector as a multipolygon (page space): even-odd over its closed (or implicitly closed) rings. */
export function fillArea(n: VectorNode): MultiPolygon {
  const rings = pagePolylines(n).filter((r) => r.pts.length > 2).map((r) => [ringOf(r.pts)] as Polygon);
  if (!rings.length) return [];
  return rings.length === 1 ? [rings[0]] : polygonClipping.xor(rings[0], ...rings.slice(1));
}

/** A disc as a polygon (round caps and joins of a stroke outline). */
function disc([cx, cy]: Vec2, r: number): Polygon {
  const n = Math.max(12, Math.min(64, Math.ceil(r * 1.5)));
  const ring: [number, number][] = [];
  for (let i = 0; i < n; i++) ring.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  ring.push(ring[0]);
  return [ring];
}

/** The area a stroke of width `w` covers along polylines (round joins and caps, as the canvas draws them here). */
export function strokeArea(lines: { pts: Vec2[]; closed: boolean }[], w: number): MultiPolygon {
  const h = w / 2;
  const parts: Polygon[] = [];
  for (const { pts, closed } of lines) {
    const p = closed && pts.length > 2 ? [...pts, pts[0]] : pts;
    for (let i = 0; i + 1 < p.length; i++) {
      const [ax, ay] = p[i], [bx, by] = p[i + 1];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-9) continue;
      const nx = (-(by - ay) / len) * h, ny = ((bx - ax) / len) * h;
      parts.push([[[ax + nx, ay + ny], [bx + nx, by + ny], [bx - nx, by - ny], [ax - nx, ay - ny], [ax + nx, ay + ny]]]);
    }
    for (const q of p) parts.push(disc(q, h));
  }
  if (!parts.length) return [];
  // in chunks: one union of thousands of small polygons is slow
  let acc: MultiPolygon = [];
  for (let i = 0; i < parts.length; i += 200) acc = polygonClipping.union(acc, ...parts.slice(i, i + 200));
  return acc;
}

/** A multipolygon as straight-edged contours (page space). */
function contoursOf(mp: MultiPolygon): Contour[] {
  const out: Contour[] = [];
  for (const poly of mp)
    for (const ring of poly) {
      const pts = ring.slice(0, -1);
      if (pts.length > 2) out.push({ closed: true, nodes: pts.map(([x, y]) => corner(x, y)) });
    }
  return out;
}

function vectorFrom(mp: MultiPolygon, like: VectorNode, name: string, fill: string | null): VectorNode | null {
  const contours = contoursOf(mp);
  if (!contours.length) return null;
  const v = newVector(contours, name);
  return { ...v, fill, stroke: null, strokeWidth: 0, fillRule: "evenodd", opacity: like.opacity, blendMode: like.blendMode, groupId: like.groupId, transform: { ...IDENTITY } };
}

/** Replace each selected vector by what `make` gives (in its place in the stack); the results become the selection. */
function replaceEach(label: string, make: (n: VectorNode) => VectorNode[]): number {
  const s = S();
  const page = currentPage();
  const sel = selectedVectors();
  if (!page || !sel.length) return 0;
  const made = new Map<string, VectorNode[]>();
  for (const n of sel) {
    const r = make(n);
    if (r.length) made.set(n.id, r);
  }
  if (!made.size) return 0;
  s.commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const [id, vs] of made) {
      const i = pg.nodes.findIndex((x) => x.id === id);
      if (i >= 0) pg.nodes.splice(i, 1, ...(vs as any));
    }
  });
  S().set({ selection: [...made.values()].flat().map((v) => v.id) });
  return made.size;
}

/** Object › Path › Outline Stroke: the stroke becomes a filled shape (the fill, if any, stays a shape of its own below). */
export function outlineStroke(): number {
  return replaceEach(t("design.path.hist.outlineStroke"), (n) => {
    if (!n.stroke || n.strokeWidth <= 0) return [];
    const scale = Math.abs(n.transform.scale) || 1;
    const area = strokeArea(pagePolylines(n), n.strokeWidth * scale);
    const stroke = vectorFrom(area, n, n.name, n.stroke);
    if (!stroke) return [];
    // a gradient stroke: the outline is filled with it (over the outline's own box, as Illustrator expands it)
    const sp = (n as VectorNode & { strokes?: { paint: Paint }[] }).strokes?.[0]?.paint;
    if (sp?.type === "gradient") (stroke as VectorNode & { fills?: Paint[] }).fills = [sp];
    const fill = n.fill ? { ...n, id: newVector([], "").id, stroke: null, strokeWidth: 0 } : null;
    return fill ? [fill as VectorNode, stroke] : [stroke];
  });
}

/** Object › Path › Offset Path: a copy grown (or shrunk) by `d` px, above the original (Illustrator keeps both). */
export function offsetPath(d: number): number {
  const s = S();
  const page = currentPage();
  const sel = selectedVectors();
  if (!page || !sel.length || !d) return 0;
  const made: [string, VectorNode][] = [];
  for (const n of sel) {
    const fill = fillArea(n);
    if (!fill.length) continue;
    const band = strokeArea(pagePolylines(n).map((r) => ({ ...r, closed: true })), Math.abs(d) * 2);
    const area = d > 0 ? polygonClipping.union(fill, band) : polygonClipping.difference(fill, band);
    const v = vectorFrom(area, n, n.name, n.fill ?? n.stroke);
    if (v) {
      v.stroke = n.stroke;
      v.strokeWidth = n.strokeWidth;
      made.push([n.id, v]);
    }
  }
  if (!made.length) return 0;
  s.commit(t("design.path.hist.offset"), (doc) => {
    const pg = draftPage(doc, page.id);
    if (!pg) return;
    for (const [id, v] of made) {
      const i = pg.nodes.findIndex((x) => x.id === id);
      pg.nodes.splice(i + 1, 0, v as any);
    }
  });
  S().set({ selection: made.map(([, v]) => v.id) });
  return made.length;
}

/** Douglas–Peucker over a polyline. */
function rdp(pts: Vec2[], eps: number): Vec2[] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let best = -1, at = 0;
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pts.length - 1; i++) {
    // a closed ring (start = end): the distance from that point
    const d = Math.hypot(dx, dy) < 1e-9 ? Math.hypot(pts[i][0] - a[0], pts[i][1] - a[1]) : Math.abs(dy * pts[i][0] - dx * pts[i][1] + b[0] * a[1] - b[1] * a[0]) / L;
    if (d > best) (best = d), (at = i);
  }
  if (best <= eps) return [a, b];
  return [...rdp(pts.slice(0, at + 1), eps).slice(0, -1), ...rdp(pts.slice(at), eps)];
}

/** Smooth anchors through `pts` (Catmull–Rom handles): the simplified path keeps its curves. */
function smoothContour(pts: Vec2[], closed: boolean): Contour {
  const n = pts.length;
  const at = (i: number) => pts[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
  return {
    closed,
    nodes: pts.map((p, i) => {
      const a = at(i - 1), b = at(i + 1);
      const tx = (b[0] - a[0]) / 6, ty = (b[1] - a[1]) / 6;
      // a sharp turn (over 40°) stays a corner: a rectangle stays a rectangle
      const u = [p[0] - a[0], p[1] - a[1]], w = [b[0] - p[0], b[1] - p[1]];
      const cos = (u[0] * w[0] + u[1] * w[1]) / (Math.hypot(u[0], u[1]) * Math.hypot(w[0], w[1]) || 1);
      const end = (!closed && (i === 0 || i === n - 1)) || cos < Math.cos((40 * Math.PI) / 180);
      return { anchor: [p[0], p[1]], handleIn: end ? [p[0], p[1]] : [p[0] - tx, p[1] - ty], handleOut: end ? [p[0], p[1]] : [p[0] + tx, p[1] + ty], isCorner: end };
    }),
  };
}

/** Object › Path › Simplify: fewer anchors within `tolerance` px of the path, its curves kept smooth. */
export function simplifyPaths(tolerance = 1.5): number {
  return replaceEach(t("design.path.hist.simplify"), (n) => {
    const before = n.contours.reduce((a, c) => a + c.nodes.length, 0);
    const contours = pagePolylines(n, 0.25).map((r) => {
      // a closed ring is simplified all the way round (its start repeated at the end, then dropped)
      const ring = r.closed && r.pts.length > 2 && Math.hypot(r.pts[0][0] - r.pts[r.pts.length - 1][0], r.pts[0][1] - r.pts[r.pts.length - 1][1]) > 1e-6 ? [...r.pts, r.pts[0]] : r.pts;
      let pts = rdp(ring, tolerance);
      if (r.closed && pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6) pts = pts.slice(0, -1);
      return smoothContour(pts, r.closed);
    });
    const after = contours.reduce((a, c) => a + c.nodes.length, 0);
    if (after >= before) return [];
    return [{ ...n, contours, ...(n.meshFill ? { meshFill: mapMesh(n.meshFill, (q) => applyTransform(n.transform, q) as Vec2) } : {}), transform: { ...IDENTITY } }];
  });
}

/** Pathfinder › Divide: every region where the selected shapes overlap or not becomes a shape of its own. */
export function dividePaths(): number {
  const s = S();
  const page = currentPage();
  const sel = selectedVectors().filter((n) => fillArea(n).length);
  if (!page || sel.length < 2) return 0;
  const areas = sel.map(fillArea);
  const pieces: { area: MultiPolygon; top: VectorNode }[] = [];
  // each shape's part not under the ones above it, then its overlaps with the ones above (they take the top's colour)
  for (let i = 0; i < sel.length; i++) {
    const above = areas.slice(i + 1);
    const own = above.length ? polygonClipping.difference(areas[i], ...above) : areas[i];
    if (own.length) pieces.push({ area: own, top: sel[i] });
    for (let j = i + 1; j < sel.length; j++) {
      let both = polygonClipping.intersection(areas[i], areas[j]);
      const higher = areas.slice(j + 1);
      if (both.length && higher.length) both = polygonClipping.difference(both, ...higher);
      if (both.length) pieces.push({ area: both, top: sel[j] });
    }
  }
  const out: VectorNode[] = [];
  for (const p of pieces)
    for (const poly of p.area) {
      const v = vectorFrom([poly], p.top, p.top.name, p.top.fill);
      if (v) out.push({ ...v, stroke: p.top.stroke, strokeWidth: p.top.strokeWidth });
    }
  if (!out.length) return 0;
  const ids = new Set(sel.map((n) => n.id));
  s.commit(t("design.path.hist.divide"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const at = pg.nodes.findIndex((x) => ids.has(x.id));
    pg.nodes = pg.nodes.filter((x) => !ids.has(x.id));
    pg.nodes.splice(Math.max(0, at), 0, ...(out as any));
  });
  S().set({ selection: out.map((v) => v.id) });
  return out.length;
}

/** Object › Compound Path › Make (Ctrl+8): one path of all the selected paths' contours, even-odd (holes). */
export function makeCompound(): number {
  const s = S();
  const page = currentPage();
  const sel = selectedVectors();
  if (!page || sel.length < 2) return 0;
  const contours: Contour[] = sel.flatMap((n) => n.contours.map((c) => ({ closed: c.closed, nodes: c.nodes.map((a) => ({ ...a, anchor: applyTransform(n.transform, a.anchor) as Vec2, handleIn: applyTransform(n.transform, a.handleIn) as Vec2, handleOut: applyTransform(n.transform, a.handleOut) as Vec2 })) })));
  const top = sel[sel.length - 1];
  const v: VectorNode = { ...newVector(contours, top.name), fill: top.fill, stroke: top.stroke, strokeWidth: top.strokeWidth, fillRule: "evenodd", groupId: top.groupId, opacity: top.opacity, transform: { ...IDENTITY } };
  const ids = new Set(sel.map((n) => n.id));
  s.commit(t("design.path.hist.compound"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const at = pg.nodes.findIndex((x) => x.id === top.id);
    pg.nodes.splice(at, 1, v as any);
    pg.nodes = pg.nodes.filter((x) => x.id === v.id || !ids.has(x.id));
  });
  S().set({ selection: [v.id] });
  return 1;
}

/** Object › Compound Path › Release (Alt+Shift+Ctrl+8): each contour a path of its own. */
export function releaseCompound(): number {
  return replaceEach(t("design.path.hist.release"), (n) => {
    if (n.contours.length < 2) return [];
    return n.contours.map((c) => ({ ...n, id: newVector([], "").id, contours: [c], fillRule: "nonzero" as const, transform: { ...n.transform } }));
  });
}

/** Object › Path › Average: the selected paths' anchors (or the selected anchors, ui/pathTools) moved to their centre. */
export function averageAnchors(axis: "both" | "x" | "y" = "both"): number {
  const sel = selectedVectors();
  const pts = sel.flatMap((n) => n.contours.flatMap((c) => c.nodes.map((a) => applyTransform(n.transform, a.anchor))));
  if (pts.length < 2) return 0;
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length, cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  return replaceEach(t("design.path.hist.average"), (n) => [
    {
      ...n,
      transform: { ...IDENTITY },
      contours: n.contours.map((c) => ({
        ...c,
        nodes: c.nodes.map((a) => {
          const p = applyTransform(n.transform, a.anchor);
          const q: Vec2 = [axis === "y" ? p[0] : cx, axis === "x" ? p[1] : cy];
          return corner(q[0], q[1]);
        }),
      })),
    },
  ]);
}

/** Object › Expand: strokes become shapes (Outline Stroke), the fill stays a shape of its own. */
export const expandAppearance = outlineStroke;

// ───────── Object › Transform dialogs (Move · Rotate · Reflect · Scale) ─────────

export type TransformKind = "move" | "rotate" | "reflect" | "scale" | "shear";

/** The selection's centre (page space) — the reference point of Rotate / Reflect / Scale. */
function centreOf(nodes: SceneNode[]): Vec2 {
  const pts = nodes.flatMap((n) => (n.type === "VECTOR" ? n.contours.flatMap((c) => c.nodes.map((a) => applyTransform(n.transform, a.anchor))) : [[n.transform.x, n.transform.y] as Vec2]));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
}

export type XformValues = { dx?: number; dy?: number; angle?: number; sx?: number; sy?: number; origin?: Vec2; /** shear: the axis angle in degrees (0 = horizontal) */ axis?: number };

/** The centre of the selection's unlocked objects (the R / O / S tools' first reference point). */
export function selectionCentre(): Vec2 | null {
  const s = S();
  const page = currentPage();
  const sel = page?.nodes.filter((n) => s.selection.includes(n.id) && !n.locked) ?? [];
  return sel.length ? centreOf(sel) : null;
}

/**
 * Apply a Transform dialog to the selection (copy = the dialog's Copy button: the result is a copy above). move: dx, dy
 * px · rotate: degrees (counter-clockwise, as Illustrator) · reflect: axis angle in degrees (0 = horizontal axis) ·
 * scale: percent (uniform) or sx / sy percent; about `origin` (the R / O / S tools' reference point) or the centre.
 */
export function transformSelection(kind: TransformKind, v: XformValues, copy = false): number {
  const s = S();
  const page = currentPage();
  if (!page || !s.selection.length) return 0;
  const sel = page.nodes.filter((n) => s.selection.includes(n.id) && !n.locked);
  if (!sel.length) return 0;
  const o = v.origin ?? centreOf(sel);
  let ids: string[] = [];
  s.commit(t(`design.xf.hist.${kind}`), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) ids = xformInDraft(pg, sel.map((n) => n.id), kind, v, o, copy);
  });
  S().set({ selection: ids });
  return ids.length;
}

/** The R / O / S tools' live drag: the selection follows inside the current gesture (from its base each step). */
export function xformGesture(ids: string[], kind: TransformKind, v: XformValues, origin: Vec2): void {
  const s = S();
  const page = currentPage();
  if (!page) return;
  s.updateGesture((d) => {
    const pg = draftPage(d, page.id);
    if (pg) xformInDraft(pg, ids, kind, v, origin, false);
  });
}

function xformInDraft(pg: { nodes: SceneNode[] }, selIds: string[], kind: TransformKind, v: XformValues, origin: Vec2, copy: boolean): string[] {
  const sel = pg.nodes.filter((n) => selIds.includes(n.id) && !n.locked).map((n) => JSON.parse(JSON.stringify(n)) as SceneNode);
  const [cx, cy] = origin;
  const a = (((kind === "rotate" ? -(v.angle ?? 0) : 2 * (v.angle ?? 0)) * Math.PI) / 180);
  const map = (p: Vec2): Vec2 => {
    const x = p[0] - cx, y = p[1] - cy;
    switch (kind) {
      case "move":
        return [p[0] + (v.dx ?? 0), p[1] + (v.dy ?? 0)];
      case "rotate":
        return [cx + x * Math.cos(a) - y * Math.sin(a), cy + x * Math.sin(a) + y * Math.cos(a)];
      case "reflect":
        // mirror about an axis through the centre at angle θ: reflect(θ) = rotate(2θ) ∘ flip-y (screen y down: -θ)
        return [cx + x * Math.cos(-a) + y * Math.sin(-a), cy + x * Math.sin(-a) - y * Math.cos(-a)];
      case "scale":
        return [cx + (x * (v.sx ?? 100)) / 100, cy + (y * (v.sy ?? v.sx ?? 100)) / 100];
      case "shear": {
        // Illustrator's Shear: along an axis at `axis`° (counter-clockwise), the far side leaning by `angle`° (design 2)
        const b = (-(v.axis ?? 0) * Math.PI) / 180, k = Math.tan(((v.angle ?? 0) * Math.PI) / 180);
        const u = x * Math.cos(b) + y * Math.sin(b), w = -x * Math.sin(b) + y * Math.cos(b);
        const u2 = u - w * k;
        return [cx + u2 * Math.cos(b) - w * Math.sin(b), cy + u2 * Math.sin(b) + w * Math.cos(b)];
      }
    }
  };
  const ids: string[] = [];
  {
    for (const n0 of sel) {
      const i = pg.nodes.findIndex((x) => x.id === n0.id);
      let n = pg.nodes[i] as SceneNode;
      if (copy) {
        const c = JSON.parse(JSON.stringify(n0)) as SceneNode;
        c.id = newVector([], "").id;
        pg.nodes.splice(i + 1, 0, c as any);
        n = pg.nodes[i + 1] as SceneNode;
      }
      ids.push(n.id);
      if (n.type === "VECTOR") {
        const tr = n.transform;
        for (const c of n.contours)
          for (const an of c.nodes) {
            an.anchor = map(applyTransform(tr, an.anchor) as Vec2);
            an.handleIn = map(applyTransform(tr, an.handleIn) as Vec2);
            an.handleOut = map(applyTransform(tr, an.handleOut) as Vec2);
          }
        // a gradient mesh goes the same way (its points and curve handles)
        if (n.meshFill) n.meshFill = mapMesh(n.meshFill as MeshFill, (q) => map(applyTransform(tr, q) as Vec2)) as never;
        n.transform = { ...IDENTITY };
        if (kind === "scale") n.strokeWidth *= Math.sqrt(Math.abs(((v.sx ?? 100) * (v.sy ?? v.sx ?? 100)) / 10000));
      } else {
        // other objects: their position (and a rotation / scale of their own transform)
        const [x, y] = map([n.transform.x, n.transform.y]);
        n.transform.x = x;
        n.transform.y = y;
        if (kind === "rotate") n.transform.rotation -= v.angle ?? 0;
        if (kind === "scale") n.transform.scale *= (v.sx ?? 100) / 100;
      }
    }
  }
  return ids;
}
