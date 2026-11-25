// The design mode's pencil (N), scissors (C) and knife (Illustrator, design 2, 2026-11-25):
//  - pencil: a hand-drawn track becomes a smooth open path in the stroke colour (closed when it ends at its start);
//  - scissors: a click on a path cuts it there — a closed path opens at that point, an open one becomes two paths;
//  - knife: a freehand cut through closed shapes divides each into pieces (their curves kept, core/curveKeep.ts).

import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { mapMesh } from "../core/mesh";
import { applyTransform, invertTransform } from "../core/geom";
import { currentPage, draftPage, useStore } from "../core/store";
import { IDENTITY, newVector, uid, type Contour, type Vec2, type VectorAnchor, type VectorNode } from "../core/types";
import { autoSmooth, nearestOnContour } from "../core/pathEdit";
import { curvedContours, pageContours, sampleShapes } from "../core/curveKeep";
import { pickableOn } from "../core/layerTree";
import { simplifyTrack } from "./designPaint";
import { strokeArea } from "./designPathOps";
import { useShapeStroke } from "./drawDefaults";
import { t } from "../i18n";

const S = () => useStore.getState();

// ───────── pencil ─────────

/** The pencil's track as a smooth path (page coordinates), or null for a click. */
export function pencilPath(track: Vec2[], zoom: number): VectorNode | null {
  if (track.length < 2) return null;
  // Illustrator's default fidelity: corners kept within a few screen px, the rest smoothed
  let pts = simplifyTrack(track, Math.max(0.75, 2.5 / Math.max(zoom, 1e-3)));
  const first = pts[0], last = pts[pts.length - 1];
  const closed = pts.length > 3 && Math.hypot(last[0] - first[0], last[1] - first[1]) * zoom < 10;
  if (closed) pts = pts.slice(0, -1);
  if (pts.length < 2 || (!closed && Math.hypot(last[0] - first[0], last[1] - first[1]) * zoom < 2 && pts.length < 3)) return null;
  const nodes: VectorAnchor[] = pts.map((p) => ({ anchor: [p[0], p[1]], handleIn: [p[0], p[1]], handleOut: [p[0], p[1]], isCorner: false }));
  autoSmooth(nodes, closed);
  const v = newVector([{ closed, nodes }], t("design.name.pencil"));
  const s = S();
  v.fill = null;
  v.stroke = s.stroke;
  v.strokeWidth = useShapeStroke.getState().width;
  return v;
}

export function drawPencil(track: Vec2[], zoom: number): boolean {
  const v = pencilPath(track, zoom);
  if (!v) return false;
  const s = S();
  s.commit(t("design.hist.pencil"), (d) => void draftPage(d, s.pageId)?.nodes.push(v as never));
  s.set({ selection: [v.id] });
  return true;
}

// ───────── scissors ─────────

const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
/** Split the segment a→b of a contour at u: the new anchor, and a's new handleOut / b's new handleIn. */
function splitSeg(a: VectorAnchor, b: VectorAnchor, u: number): { mid: VectorAnchor; aOut: Vec2; bIn: Vec2 } {
  const p01 = lerp(a.anchor, a.handleOut, u), p12 = lerp(a.handleOut, b.handleIn, u), p23 = lerp(b.handleIn, b.anchor, u);
  const p012 = lerp(p01, p12, u), p123 = lerp(p12, p23, u), m = lerp(p012, p123, u);
  return { mid: { anchor: m, handleIn: p012, handleOut: p123, isCorner: true }, aOut: p01, bIn: p23 };
}

/** Cut contour `c` at segment `seg`, parameter u: the open contours it becomes (one for a closed contour, two for an open one). */
export function cutContour(c: Contour, seg: number, u: number): Contour[] {
  const n = c.nodes.length;
  const nodes = c.nodes.map((a) => ({ ...a, anchor: [...a.anchor] as Vec2, handleIn: [...a.handleIn] as Vec2, handleOut: [...a.handleOut] as Vec2 }));
  const a = nodes[seg], b = nodes[(seg + 1) % n];
  const { mid, aOut, bIn } = splitSeg(a, b, Math.min(1 - 1e-6, Math.max(1e-6, u)));
  a.handleOut = aOut;
  b.handleIn = bIn;
  const start: VectorAnchor = { ...mid, handleIn: mid.anchor }, end: VectorAnchor = { ...mid, handleOut: mid.anchor, anchor: [...mid.anchor] as Vec2 };
  if (c.closed) {
    // the path opens at the cut: it runs from the cut point round to the same point
    const ring = [...nodes.slice(seg + 1), ...nodes.slice(0, seg + 1)];
    return [{ closed: false, nodes: [start, ...ring, end] }];
  }
  return [
    { closed: false, nodes: [...nodes.slice(0, seg + 1), end] },
    { closed: false, nodes: [start, ...nodes.slice(seg + 1)] },
  ];
}

/** The scissors: cut the topmost path under page point p (within tol px); true when a path was cut. */
export function scissorsAt(p: Vec2, tol: number): boolean {
  const page = currentPage();
  if (!page) return false;
  const pick = pickableOn(page);
  const vs = [...page.nodes].reverse().filter((n): n is VectorNode => n.type === "VECTOR" && n.visible && !n.locked && pick(n));
  for (const n of vs) {
    const lp = invertTransform(n.transform, p);
    const k = Math.abs(n.transform.scale) || 1;
    for (let ci = 0; ci < n.contours.length; ci++) {
      const hit = nearestOnContour(n.contours[ci], lp);
      if (!hit || hit.d * k > tol) continue;
      const parts = cutContour(n.contours[ci], hit.seg, hit.u);
      const others = n.contours.filter((_, i) => i !== ci);
      // an open path cut in two: two paths (Illustrator); the other contours of a compound stay with the first
      const made: VectorNode[] = parts.map((c, i) => ({ ...n, id: i ? uid("n") : n.id, contours: i ? [c] : [c, ...others], fill: n.fill }));
      S().commit(t("design.hist.scissors"), (d) => {
        const pg = draftPage(d, page.id);
        if (!pg) return;
        const at = pg.nodes.findIndex((x) => x.id === n.id);
        pg.nodes.splice(at, 1, ...(made as never[]));
      });
      S().set({ selection: made.map((m) => m.id) });
      return true;
    }
  }
  return false;
}

// ───────── knife ─────────

/** The knife: cut every closed, unlocked shape the freehand track crosses into pieces; the number of shapes cut. */
export function knifeCut(track: Vec2[]): number {
  const page = currentPage();
  if (!page || track.length < 2) return 0;
  const pick = pickableOn(page);
  const sel = new Set(S().selection);
  const all = page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && n.visible && !n.locked && pick(n) && n.contours.some((c) => c.closed && c.nodes.length > 2));
  // the selected shapes when some are selected (Illustrator cuts the selection, else everything under the knife)
  const targets = all.some((n) => sel.has(n.id)) ? all.filter((n) => sel.has(n.id)) : all;
  const cut: MultiPolygon = strokeArea([{ pts: track, closed: false }], 0.5);
  const made = new Map<string, VectorNode[]>();
  for (const n of targets) {
    const sm = sampleShapes([pageContours(n)]);
    const rs = sm.rings[0];
    if (!rs.length) continue;
    const area: MultiPolygon = rs.length === 1 ? [[rs[0]]] : polygonClipping.xor([rs[0]], ...rs.slice(1).map((r) => [r] as Polygon));
    const pieces = polygonClipping.difference(area, cut);
    if (pieces.length < 2) continue;
    const k = Math.abs(n.transform.scale) || 1;
    made.set(
      n.id,
      pieces.map((poly, i) => ({ ...n, id: i ? uid("n") : n.id, contours: curvedContours([poly], sm), ...(n.meshFill ? { meshFill: mapMesh(n.meshFill, (q) => applyTransform(n.transform, q) as Vec2) } : {}), transform: { ...IDENTITY }, strokeWidth: n.strokeWidth * k, fillRule: "nonzero" as const })),
    );
  }
  if (!made.size) return 0;
  S().commit(t("design.hist.knife"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const [id, vs] of made) {
      const at = pg.nodes.findIndex((x) => x.id === id);
      if (at >= 0) pg.nodes.splice(at, 1, ...(vs as never[]));
    }
  });
  S().set({ selection: [...made.values()].flat().map((v) => v.id) });
  return made.size;
}

