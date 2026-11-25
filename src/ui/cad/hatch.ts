// Hatches on the drawing screen (AutoCAD HATCH / GRADIENT / HATCHEDIT): the boundary around a picked internal point
// (the smallest face the drawing's lines, arcs and polylines close around it, with the closed objects inside it as
// islands), AutoCAD's common patterns (ANSI31 …, defined as in acad.pat), solid fills and two-colour gradients. A hatch
// is a VECTOR node (gradient: one per colour band, kept together) carrying its definition (VectorNode.cadHatch), so
// HATCHEDIT draws it again and the DXF export writes a HATCH.

import { produce } from "immer";
import { currentPage, draftPage, useStore } from "../../core/store";
import { pickableOn } from "../../core/layerTree";
import { newVector, uid, type CadHatch, type CadSourceMeta, type Contour, type Page, type VectorNode } from "../../core/types";
import { gradientBands, patternSegments } from "../../io/formats/cad/build";
import { HATCH_NAMES, PATTERNS, isGradient, patternLines } from "../../io/formats/cad/hatchPatterns";
export { HATCH_NAMES, PATTERNS, isGradient, patternLines };
import { t } from "../../i18n";
import { bez, mapAnchors, nodeSegs, polyArea, polyContour, wToPage, type W } from "./geom";

const S = () => useStore.getState();

/** What a hatch draws: its nodes in page px (several for a gradient), coloured `color` (and the gradient's second). */
export function hatchNodes(h: CadHatch, color: string, cad: Pick<CadSourceMeta, "k" | "ox" | "oy">, strokeWidth: number): VectorNode[] {
  const m = wToPage(cad);
  const name = `${t("cadfeat.ent.hatch")} ${h.pattern}`;
  const mk = (contours: Contour[], fill: string | null, stroke: string | null): VectorNode => {
    const n = newVector(contours, name);
    n.fill = fill;
    n.stroke = stroke;
    n.strokeWidth = stroke ? strokeWidth : 0;
    n.fillRule = "evenodd";
    n.cadHatch = JSON.parse(JSON.stringify(h));
    return n;
  };
  const loops = h.loops.filter((l) => l.length >= 3);
  if (!loops.length) return [];
  if (h.pattern === "SOLID") return [mk(loops.map((l) => polyContour(l, true, m)), color, null)];
  if (isGradient(h.pattern)) {
    const c2 = h.color2 ?? "#ffffff";
    const bands = gradientBands(loops, { name: "LINEAR", angle: (h.angle * Math.PI) / 180, shift: 0, single: false, tint: 1, colors: [{ aci: 1 }, { aci: 2 }] as any }, (c: any) => (c.aci === 1 ? color : c2));
    return bands.map((b) => mk(b.contours.map((c) => ({ closed: true, nodes: mapAnchors(c.nodes, m) })), b.color, null));
  }
  const segs = patternSegments(loops, patternLines(h.pattern, h.scale, h.angle));
  // too fine for the area (more than 20 000 lines): drawn solid, as AutoCAD warns and refuses
  if (!segs) return [mk(loops.map((l) => polyContour(l, true, m)), color, null)];
  return [mk(segs.map(([p, q]) => polyContour([p as W, q as W], false, m)), null, color)];
}

// ───────── boundary detection ─────────

const flatSeg = (s: { a: W; b: W; c1?: W; c2?: W }, n = 16): W[] => {
  if (!s.c1) return [s.a, s.b];
  const out: W[] = [];
  for (let i = 0; i <= n; i++) out.push(bez(s as any, i / n));
  return out;
};

export function pointInPoly(p: W, poly: W[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** The objects that can bound a hatch: visible vectors on the page, not hatches themselves. */
function boundaryNodes(page: Page): VectorNode[] {
  const pick = pickableOn(page);
  return page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && n.visible && !n.cadHatch && (pick(n) || !!n.groupId));
}

/** Closed contours of the nodes as polygons (drawing coordinates). */
function closedPolys(nodes: VectorNode[], cad: CadSourceMeta): W[][] {
  const out: W[][] = [];
  for (const n of nodes)
    n.contours.forEach((c, ci) => {
      if (!c.closed) return;
      const pts: W[] = [];
      for (const s of nodeSegs(n, cad)) if (s.ci === ci) for (const q of flatSeg(s).slice(pts.length ? 1 : 0)) pts.push(q);
      if (pts.length >= 3) out.push(pts);
    });
  return out;
}

/**
 * The boundary around an internal point (AutoCAD's "내부 점 선택"): the smallest face that the lines, arcs and
 * polylines close around p — they may cross or just meet — and the closed objects inside it as islands. Null when p
 * is outside every closed area.
 */
export function boundaryAt(p: W, page: Page | undefined = currentPage()): W[][] | null {
  const cad = page?.source?.cad;
  if (!page || !cad) return null;
  const nodes = boundaryNodes(page);
  // pieces: straight pieces of every segment (curves flattened)
  const pcs: [W, W][] = [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes)
    for (const s of nodeSegs(n, cad)) {
      const f = flatSeg(s);
      for (let i = 1; i < f.length; i++) {
        pcs.push([f[i - 1], f[i]]);
        for (const q of [f[i - 1], f[i]]) (x0 = Math.min(x0, q[0])), (y0 = Math.min(y0, q[1])), (x1 = Math.max(x1, q[0])), (y1 = Math.max(y1, q[1]));
      }
      if (pcs.length > 40000) break;
    }
  if (!pcs.length) return null;
  const ext = Math.max(x1 - x0, y1 - y0, 1e-9);
  const tol = ext * 1e-7;
  // crossings: pieces bucketed on a grid, each pair in a shared cell tested once
  const cells = Math.max(1, Math.min(256, Math.round(Math.sqrt(pcs.length))));
  const cw = ext / cells || 1;
  const grid = new Map<number, number[]>();
  const cutAt: number[][] = pcs.map(() => []);
  pcs.forEach(([a, b], i) => {
    const i0 = Math.floor((Math.min(a[0], b[0]) - x0) / cw), i1 = Math.floor((Math.max(a[0], b[0]) - x0) / cw);
    const j0 = Math.floor((Math.min(a[1], b[1]) - y0) / cw), j1 = Math.floor((Math.max(a[1], b[1]) - y0) / cw);
    for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) (grid.get(x * 4096 + y) ?? grid.set(x * 4096 + y, []).get(x * 4096 + y)!).push(i);
  });
  const tested = new Set<number>();
  for (const list of grid.values())
    for (let u = 0; u < list.length; u++)
      for (let v = u + 1; v < list.length; v++) {
        const i = list[u], j = list[v];
        const key = i * 50000 + j;
        if (tested.has(key)) continue;
        tested.add(key);
        const [a, b] = pcs[i], [c, d] = pcs[j];
        const r: W = [b[0] - a[0], b[1] - a[1]], s: W = [d[0] - c[0], d[1] - c[1]];
        const den = r[0] * s[1] - r[1] * s[0];
        if (Math.abs(den) < 1e-18) continue;
        const q: W = [c[0] - a[0], c[1] - a[1]];
        const tt = (q[0] * s[1] - q[1] * s[0]) / den, uu = (q[0] * r[1] - q[1] * r[0]) / den;
        const e = 1e-9;
        if (tt < -e || tt > 1 + e || uu < -e || uu > 1 + e) continue;
        if (tt > e && tt < 1 - e) cutAt[i].push(tt);
        if (uu > e && uu < 1 - e) cutAt[j].push(uu);
      }
  // planar graph: vertices merged within tol
  const vid = new Map<string, number>();
  const vp: W[] = [];
  const vertex = (p: W) => {
    const k = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
    let id = vid.get(k);
    if (id === undefined) {
      id = vp.length;
      vp.push(p);
      vid.set(k, id);
    }
    return id;
  };
  const adj = new Map<number, Set<number>>();
  const link = (u: number, v: number) => {
    if (u === v) return;
    (adj.get(u) ?? adj.set(u, new Set()).get(u)!).add(v);
    (adj.get(v) ?? adj.set(v, new Set()).get(v)!).add(u);
  };
  pcs.forEach(([a, b], i) => {
    const ts = [0, ...cutAt[i].sort((x, y) => x - y), 1];
    let prev = vertex(a);
    for (let k = 1; k < ts.length; k++) {
      const q: W = k === ts.length - 1 ? b : [a[0] + (b[0] - a[0]) * ts[k], a[1] + (b[1] - a[1]) * ts[k]];
      const v = vertex(q);
      link(prev, v);
      prev = v;
    }
  });
  // dangling ends go (they bound nothing)
  for (let again = true; again; ) {
    again = false;
    for (const [v, s] of adj)
      if (s.size < 2) {
        for (const w of s) adj.get(w)?.delete(v);
        adj.delete(v);
        again = true;
      }
  }
  // the nearest edge the ray from p to +x crosses, taken upward (p on its left)
  let best = Infinity, start: [number, number] | null = null;
  for (const [u, s] of adj)
    for (const v of s) {
      if (u > v) continue;
      const a = vp[u], b = vp[v];
      if (a[1] > p[1] === b[1] > p[1]) continue;
      const x = a[0] + ((p[1] - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      if (x > p[0] && x < best) (best = x), (start = a[1] < b[1] ? [u, v] : [v, u]);
    }
  let outer: W[] | null = null;
  if (start) {
    const sorted = new Map<number, number[]>();
    const around = (v: number) => {
      let l = sorted.get(v);
      if (!l) {
        const c = vp[v];
        l = [...(adj.get(v) ?? [])].sort((x, y) => Math.atan2(vp[x][1] - c[1], vp[x][0] - c[0]) - Math.atan2(vp[y][1] - c[1], vp[y][0] - c[0]));
        sorted.set(v, l);
      }
      return l;
    };
    const ring: W[] = [];
    let [u, v] = start;
    for (let k = 0; k < 200000; k++) {
      ring.push(vp[u]);
      const l = around(v);
      const i = l.indexOf(u);
      const w = l[(i - 1 + l.length) % l.length];
      [u, v] = [v, w];
      if (u === start[0] && v === start[1]) break;
    }
    const a = polyArea(ring).area;
    let signed = 0;
    for (let i = 0; i < ring.length; i++) {
      const p0 = ring[i], p1 = ring[(i + 1) % ring.length];
      signed += p0[0] * p1[1] - p1[0] * p0[1];
    }
    if (signed > 0 && a > 0 && pointInPoly(p, ring)) outer = ring;
  }
  // no face around p from the graph: the smallest closed object around it
  const polys = closedPolys(nodes, cad);
  if (!outer) {
    let area = Infinity;
    for (const q of polys)
      if (pointInPoly(p, q)) {
        const a = polyArea(q).area;
        if (a < area) (area = a), (outer = q);
      }
  }
  if (!outer) return null;
  const o = outer;
  const holes = polys.filter((q) => q !== o && !pointInPoly(p, q) && q.every((x) => pointInPoly(x, o)));
  return [o, ...holes];
}

/** The objects a boundary runs along (an associative hatch follows them): those with a point on one of its loops. */
export function boundarySources(loops: W[][], page: Page | undefined = currentPage()): string[] {
  const cad = page?.source?.cad;
  if (!page || !cad || !loops.length) return [];
  const pts = loops.flat();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const tol = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1e-9) * 1e-6;
  const onLoop = (q: W) =>
    loops.some((l) => l.some((a, i) => {
      const b = l[(i + 1) % l.length];
      const vx = b[0] - a[0], vy = b[1] - a[1], L = vx * vx + vy * vy;
      const tt = L ? Math.max(0, Math.min(1, ((q[0] - a[0]) * vx + (q[1] - a[1]) * vy) / L)) : 0;
      return Math.hypot(q[0] - a[0] - vx * tt, q[1] - a[1] - vy * tt) < tol;
    }));
  return boundaryNodes(page).filter((n) => nodeSegs(n, cad).some((s) => onLoop(s.a) || onLoop(s.b))).map((n) => n.id);
}

// ───────── associativity: a hatch follows its boundary objects ─────────

let following = false;
/** Draw again the hatches whose boundary objects this change moved or reshaped (not an undo step of its own). */
function follow(page: Page, old: Page) {
  const cad = page.source?.cad;
  if (!cad) return;
  const before = new Map(old.nodes.map((n) => [n.id, n]));
  const now = new Map(page.nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const jobs: { ids: string[]; h: CadHatch; seed: [number, number]; color: string; sw: number }[] = [];
  // what this change touched (not hatches): a hatch without known boundary objects (imported) looks for them there
  const changed = old.nodes.filter((x) => x.type === "VECTOR" && !x.cadHatch && before.get(x.id) !== now.get(x.id)) as VectorNode[];
  const boxOf = (pts: W[]) => [Math.min(...pts.map((q) => q[0])), Math.min(...pts.map((q) => q[1])), Math.max(...pts.map((q) => q[0])), Math.max(...pts.map((q) => q[1]))];
  const foundSrc = new Map<string, string[]>();
  const changedBoxes = changed.map((x) => boxOf(nodeSegs(x, cad).flatMap((s) => [s.a, s.b])));
  for (const n of page.nodes) {
    if (n.type !== "VECTOR" || !n.cadHatch || done.has(n.id) || !n.cadHatch.loops.length) continue;
    if (!n.cadHatch.src?.length && changed.length) {
      // imported, or made by object selection: its boundary objects are those its loops run along (in the old drawing)
      const hb = boxOf(n.cadHatch.loops.flat() as W[]);
      if (!changedBoxes.some((c) => c[0] <= hb[2] && hb[0] <= c[2] && c[1] <= hb[3] && hb[1] <= c[3])) continue;
      const found = boundarySources(n.cadHatch.loops as W[][], old);
      if (!found.length) continue;
      foundSrc.set(n.id, found);
    }
    const src: string[] = n.cadHatch.src?.length ? n.cadHatch.src : foundSrc.get(n.id) ?? [];
    if (!src.length) continue;
    const g = page.groups?.find((x) => x.id === n.groupId);
    const ids = g?.cad?.text ? page.nodes.filter((x) => x.groupId === g.id).map((x) => x.id) : [n.id];
    ids.forEach((x) => done.add(x));
    if (before.get(n.id) !== n) continue; // the hatch itself was edited by this change
    const moved = src.filter((id) => before.get(id) !== now.get(id));
    if (!moved.length) continue;
    // the seed goes along when a boundary object moved as a whole (MOVE, ROTATE …): its first point's displacement
    let seed = n.cadHatch.seed ?? interiorPoint(n.cadHatch.loops[0] as W[], old);
    if (!seed) continue;
    const a = before.get(moved[0]), b = now.get(moved[0]);
    // (the boundary found there must still run along this hatch's objects; else the seed went with them)
    const at = boundaryAt(seed, page);
    const ok = !!at && ((s) => moved.every((id) => s.includes(id)))(boundarySources(at, page));
    // a boundary object moved whole (every point by the same vector, MOVE): the seed goes with it
    const sa = a?.type === "VECTOR" ? nodeSegs(a, cad) : [], sb = b?.type === "VECTOR" ? nodeSegs(b, cad) : [];
    const dv: W | null = sa.length && sa.length === sb.length ? [sb[0].a[0] - sa[0].a[0], sb[0].a[1] - sa[0].a[1]] : null;
    const rigid = !!dv && Math.hypot(dv[0], dv[1]) > 0 && sa.every((s, i) => Math.abs(sb[i].a[0] - s.a[0] - dv[0]) < 1e-9 && Math.abs(sb[i].a[1] - s.a[1] - dv[1]) < 1e-9 && Math.abs(sb[i].b[0] - s.b[0] - dv[0]) < 1e-9 && Math.abs(sb[i].b[1] - s.b[1] - dv[1]) < 1e-9);
    if (rigid) seed = [seed[0] + dv![0], seed[1] + dv![1]];
    else if (!ok && dv) seed = [seed[0] + dv[0], seed[1] + dv[1]];
    const first = page.nodes.find((x) => x.id === ids[0]) as VectorNode;
    // boundary objects that are closed by themselves (polylines, circles — as AutoCAD's associativity keeps them):
    // the loops are those objects, not a face searched around the point
    const closedSrc = src.every((id) => {
      const x = now.get(id);
      return x?.type === "VECTOR" && x.contours.length > 0 && x.contours.every((c) => c.closed);
    });
    jobs.push({ ids, h: { ...n.cadHatch, src, ...(closedSrc ? { sel: true as const } : {}) }, seed: seed as [number, number], color: isGradient(n.cadHatch.pattern) ? first.fill ?? "#000000" : n.fill ?? n.stroke ?? "#000000", sw: first.strokeWidth });
  }
  if (!jobs.length) return;
  let doc = S().doc;
  for (const j of jobs) {
    const loops = j.h.sel ? loopsOf(j.h.src ?? [], page) : boundaryAt(j.seed, page);
    if (!loops?.length) continue;
    const h: CadHatch = { ...j.h, seed: j.seed, loops: loops.map((l) => l.map((q) => [q[0], q[1]] as [number, number])), src: j.h.sel ? j.h.src : boundarySources(loops, page) };
    const fresh = hatchNodes(h, j.color, cad, j.sw || 0.5);
    if (!fresh.length) continue;
    doc = produce(doc, (d) => {
      const pg = d.pages.find((x) => x.id === page.id);
      if (!pg) return;
      const at = pg.nodes.findIndex((x) => x.id === j.ids[0]);
      if (at < 0) return;
      const gid = pg.nodes[at].groupId;
      fresh.forEach((x, i) => {
        x.groupId = gid;
        if (j.ids[i]) x.id = j.ids[i];
      });
      // a gradient keeps as many bands as it had (its group stays); a plain hatch is one node
      const set = new Set(j.ids);
      pg.nodes = pg.nodes.filter((x) => !set.has(x.id)) as any;
      pg.nodes.splice(at, 0, ...(fresh.slice(0, Math.max(1, j.ids.length)) as any));
    });
  }
  if (doc !== S().doc) S().set({ doc });
}
useStore.subscribe((s, prev) => {
  if (following || s.doc === prev.doc) return;
  const page = s.doc.pages.find((p) => p.id === s.pageId), old = prev.doc.pages.find((p) => p.id === s.pageId);
  if (!page?.source?.cad || !old || page.nodes === old.nodes) return;
  following = true;
  try {
    follow(page, old);
  } finally {
    following = false;
  }
});

/** A point inside a loop, clear of its edges (the internal point of a hatch made without one). */
export function interiorPoint(loop: W[], page?: Page): [number, number] | null {
  if (loop.length < 3) return null;
  const tries: W[] = [];
  const c: W = [loop.reduce((s, q) => s + q[0], 0) / loop.length, loop.reduce((s, q) => s + q[1], 0) / loop.length];
  tries.push(c);
  for (let i = 1; i + 1 < loop.length; i++) tries.push([(loop[0][0] + loop[i][0] + loop[i + 1][0]) / 3, (loop[0][1] + loop[i][1] + loop[i + 1][1]) / 3]);
  const p = tries.find((q) => pointInPoly(q, loop) && (!page || boundaryAt(q, page)));
  return p ? [p[0], p[1]] : null;
}

/** Loops of selected closed objects (AutoCAD's "객체 선택" boundary). */
export function loopsOf(ids: string[], page: Page | undefined = currentPage()): W[][] {
  const cad = page?.source?.cad;
  if (!page || !cad) return [];
  const set = new Set(ids);
  return closedPolys(page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && set.has(n.id) && !n.cadHatch), cad);
}

/** The area a hatch covers (outer loops minus islands, even-odd). */
export function hatchArea(h: CadHatch): number {
  let a = 0;
  h.loops.forEach((l) => {
    const depth = h.loops.filter((o) => o !== l && pointInPoly(l[0], o)).length;
    a += (depth % 2 ? -1 : 1) * polyArea(l).area;
  });
  return Math.abs(a);
}

/** Put a hatch on the page: behind the drawing (AutoCAD HPDRAWORDER "behind boundary"), in layer `layerGroupId`. */
export function placeHatch(label: string, h: CadHatch, color: string, strokeWidth: number, layerGroupId: string | undefined, replace?: string[]): string[] {
  const page = currentPage(), cad = page?.source?.cad;
  if (!page || !cad) return [];
  const nodes = hatchNodes(h, color, cad, strokeWidth);
  if (!nodes.length) return [];
  let gid = layerGroupId;
  const made = nodes.map((n) => n.id);
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    let at = 0;
    if (replace?.length) {
      const set = new Set(replace);
      const first = pg.nodes.findIndex((x) => set.has(x.id));
      const old = pg.nodes[first];
      const og = pg.groups?.find((g) => g.id === old?.groupId);
      gid = og?.cad?.text ? og.parentId ?? gid : old?.groupId ?? gid;
      at = Math.max(0, first);
      pg.nodes = pg.nodes.filter((x) => !set.has(x.id)) as any;
      if (og?.cad?.text) pg.groups = pg.groups!.filter((g) => g.id !== og.id || pg.nodes.some((x) => x.groupId === g.id));
    } else {
      const ids = new Set((pg.groups ?? []).filter((g) => g.id === gid || g.parentId === gid).map((g) => g.id));
      const i = pg.nodes.findIndex((x) => x.groupId && ids.has(x.groupId));
      at = i < 0 ? 0 : i;
    }
    // a gradient's bands are one object (kept together like a text drawn in parts)
    if (nodes.length > 1) {
      const g = { id: uid("g"), name: `${t("cadfeat.ent.hatch")} ${h.pattern}`, parentId: gid ?? null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { text: true } };
      pg.groups ??= [];
      pg.groups.push(g as any);
      for (const n of nodes) n.groupId = g.id;
    } else for (const n of nodes) n.groupId = gid;
    pg.nodes.splice(at, 0, ...(nodes as any));
  });
  return made;
}
