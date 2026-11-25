// The Shape Builder tool (Shift+M; Illustrator, design 2): over two or more selected paths, the regions their overlaps
// cut the area into light up under the pointer; a drag across regions merges them into one shape, Alt+drag (or click)
// deletes them. The other regions become shapes of their own (the selection divided), each painted like the topmost
// path over it.

import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { currentPage, draftPage, useStore } from "../core/store";
import { IDENTITY, newVector, type Contour, type Vec2, type VectorNode } from "../core/types";
import { curvedContours, pageContours, sampleShapes, type Sampled } from "../core/curveKeep";
import { t } from "../i18n";

const S = () => useStore.getState();

export interface Region {
  poly: Polygon;
  /** the path whose paint the region takes (topmost over it) */
  top: VectorNode;
}

let cache: { key: string; regions: Region[] } | null = null;
/** the sources sampled for the last regions (their curves come back in the shapes made) */
let sampled: Sampled | null = null;

/** The selected closed paths (stacking order) the tool works on. */
function sources(): VectorNode[] {
  const page = currentPage();
  const sel = new Set(S().selection);
  return (page?.nodes ?? []).filter((n): n is VectorNode => n.type === "VECTOR" && sel.has(n.id) && !n.locked && n.contours.some((c) => c.nodes.length > 2));
}

/** The regions of the selection (cached until the selection or the paths change). */
export function regions(): Region[] {
  const src = sources();
  if (src.length < 1) return [];
  const key = src.map((n) => n.id + ":" + JSON.stringify(n.contours).length + ":" + n.transform.x + "," + n.transform.y + "," + n.transform.rotation + "," + n.transform.scale).join("|");
  if (cache?.key === key) return cache.regions;
  try {
    cache = { key, regions: computeRegions(src) };
  } catch {
    // the polygon engine failed on these paths: no regions (the tool says to pick overlapping paths)
    cache = { key, regions: [] };
  }
  return cache.regions;
}

function computeRegions(src: VectorNode[]): Region[] {
  const sm = (sampled = sampleShapes(src.map(pageContours)));
  let atoms: { mp: MultiPolygon; top: VectorNode }[] = [];
  let seen: MultiPolygon = [];
  for (const n of src) {
    const rs = sm.rings[src.indexOf(n)];
    const a: MultiPolygon = !rs.length ? [] : rs.length === 1 ? [[rs[0]]] : polygonClipping.xor([rs[0]], ...rs.slice(1).map((r) => [r] as Polygon));
    if (!a.length) continue;
    const next: typeof atoms = [];
    for (const x of atoms) {
      const inter = polygonClipping.intersection(x.mp, a);
      const diff = polygonClipping.difference(x.mp, a);
      if (inter.length) next.push({ mp: inter, top: n });
      if (diff.length) next.push({ mp: diff, top: x.top });
    }
    const rest = seen.length ? polygonClipping.difference(a, seen) : a;
    if (rest.length) next.push({ mp: rest, top: n });
    seen = seen.length ? polygonClipping.union(seen, a) : a;
    atoms = next;
  }
  const out: Region[] = [];
  for (const x of atoms) for (const poly of x.mp) if (Math.abs(ringArea(poly[0])) > 0.5) out.push({ poly, top: x.top });
  return out;
}

function ringArea(r: [number, number][]): number {
  let s = 0;
  for (let i = 0; i + 1 < r.length; i++) s += r[i][0] * r[i + 1][1] - r[i + 1][0] * r[i][1];
  return s / 2;
}

function inRing(r: [number, number][], [x, y]: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The region under page point p (index), or -1. */
export function regionAt(p: Vec2): number {
  const rs = regions();
  for (let i = rs.length - 1; i >= 0; i--) {
    const poly = rs[i].poly;
    if (inRing(poly[0], p) && !poly.slice(1).some((h) => inRing(h, p))) return i;
  }
  return -1;
}

const contoursOf = (mp: MultiPolygon): Contour[] =>
  mp.flatMap((poly) => poly.map((r) => ({ closed: true, nodes: r.slice(0, -1).map(([x, y]) => ({ anchor: [x, y] as Vec2, handleIn: [x, y] as Vec2, handleOut: [x, y] as Vec2, isCorner: true })) })));

function shape(mp: MultiPolygon, like: VectorNode, name: string): VectorNode {
  // the sources' curves kept where the shape runs along them (Illustrator)
  const v = newVector(sampled ? curvedContours(mp, sampled) : contoursOf(mp), name);
  return { ...v, fill: like.fill, stroke: like.stroke, strokeWidth: like.strokeWidth * (Math.abs(like.transform.scale) || 1), strokeJoin: like.strokeJoin, strokeCap: like.strokeCap, fillRule: "nonzero", opacity: like.opacity, blendMode: like.blendMode, groupId: like.groupId, transform: { ...IDENTITY } };
}

/**
 * Apply a shape-builder gesture: the regions `picked` are merged into one shape (erase: removed); the selection's paths
 * are replaced by the resulting shapes. Returns the number of regions used.
 */
export function buildShapes(picked: number[], erase: boolean): number {
  const page = currentPage();
  const src = sources();
  const rs = regions();
  const set = new Set(picked.filter((i) => i >= 0 && i < rs.length));
  if (!page || !src.length || !set.size) return 0;
  const out: VectorNode[] = [];
  const chosen = [...set].map((i) => rs[i]);
  if (!erase) {
    const merged = polygonClipping.union([chosen[0].poly], ...chosen.slice(1).map((r) => [r.poly] as MultiPolygon));
    // the merged shape takes the paint of the region the drag started on (Illustrator)
    out.push(shape(merged, chosen[0].top, chosen[0].top.name));
  }
  rs.forEach((r, i) => {
    if (!set.has(i)) out.push(shape([r.poly], r.top, r.top.name));
  });
  const ids = new Set(src.map((n) => n.id));
  S().commit(t(erase ? "design.sb.hist.erase" : "design.sb.hist.merge"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const at = pg.nodes.findIndex((n) => ids.has(n.id));
    pg.nodes = pg.nodes.filter((n) => !ids.has(n.id)) as any;
    // regions below the merged one keep the stack order of the paths they came from
    pg.nodes.splice(Math.max(0, at), 0, ...(out.reverse() as any));
  });
  cache = null;
  S().set({ selection: out.map((v) => v.id) });
  return set.size;
}
