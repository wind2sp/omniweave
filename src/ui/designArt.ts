// Live art of the design mode (Illustrator, design 2, 2026-11-24): Object › Blend (Ctrl+Alt+B), Object › Repeat (Radial
// · Grid · Mirror), symbols (Symbols panel: new, place, edit, break link) and pattern swatches (Object › Pattern › Make).
//
// A blend, a repeat and a symbol instance are layer groups with `art` (core/types.ts ArtGroupMeta): the members marked
// `artGen` are generated — blend steps, repeat copies, the symbol's art — and made again from the sources (or the
// symbol) in the same undo step whenever those change (storeHooks.settle, so a drag of a blend's end shape moves its
// steps on release). Releasing drops the generated members; expanding keeps them as ordinary objects.

import { produce, type Draft } from "immer";
import { mapMesh, type MeshFill } from "../core/mesh";
import { create } from "zustand";
import { applyTransform } from "../core/geom";
import { currentPage, draftPage, storeHooks, useStore } from "../core/store";
import { IDENTITY, newGroup, uid, type ArtGroupMeta, type Contour, type LayerGroup, type OmwDocument, type Page, type SceneNode, type SymbolDef, type Vec2, type VectorNode } from "../core/types";
import { flatten } from "../core/vector";
import type { PatternFill } from "../core/liveVector";
import { nodeBounds } from "../core/loom";
import { t } from "../i18n";
import { enterIsolation, exitIsolation, useDesign } from "./designTools";

const S = () => useStore.getState();

// ───────── geometry helpers ─────────

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A copy of `n` with a new id whose page-space points are mapped by `f` (a vector's path is baked; others move). */
export function mapNode(n: SceneNode, f: (p: Vec2) => Vec2, turn = 0, flip = false): SceneNode {
  const c = clone(n);
  c.id = uid("n");
  if (c.type === "VECTOR") {
    const tr = n.transform;
    for (const ct of c.contours)
      for (const a of ct.nodes) {
        a.anchor = f(applyTransform(tr, a.anchor));
        a.handleIn = f(applyTransform(tr, a.handleIn));
        a.handleOut = f(applyTransform(tr, a.handleOut));
      }
    if (c.meshFill) c.meshFill = mapMesh(c.meshFill as MeshFill, (q) => f(applyTransform(tr, q))) as never;
    const k = Math.abs(tr.scale) || 1;
    if (k !== 1) c.strokeWidth *= k;
    c.transform = { ...IDENTITY };
  } else {
    const [x, y] = f([n.transform.x, n.transform.y]);
    c.transform = { ...c.transform, x, y, rotation: c.transform.rotation + turn };
    if (flip) c.transform.scale = -c.transform.scale;
  }
  return c;
}

function boundsOf(nodes: readonly SceneNode[]): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    // a path by its own geometry (Illustrator's bounds: the stroke not counted), others by their box
    const b = n.type === "VECTOR" && n.contours.some((c) => c.nodes.length) ? geomBounds(n) : nodeBounds(n);
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 0, h: 0 };
}
function geomBounds(n: VectorNode): { x: number; y: number; w: number; h: number } {
  const pts = n.contours.flatMap((c) => flatten(c, 1)).map((p) => applyTransform(n.transform, p));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
// ───────── affine matrices (symbol instances) ─────────

type M6 = [number, number, number, number, number, number];
const symMatrix = (a: Extract<ArtGroupMeta, { kind: "symbol" }>): M6 => a.m ?? [1, 0, 0, 1, a.dx, a.dy];
const applyM = (m: M6, [x, y]: Vec2): Vec2 => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** a after b (b applied first) */
const mulM = (a: M6, b: M6): M6 => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
function invM(m: M6): M6 | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det, b = -m[1] / det, c = -m[2] / det, d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
/** The page points that pin a set of objects down (a path's anchors and handles; another object's position). */
function pointsOf(nodes: readonly SceneNode[]): Vec2[] {
  return nodes.flatMap((n) => (n.type === "VECTOR" ? n.contours.flatMap((c) => c.nodes.flatMap((a) => [a.anchor, a.handleIn, a.handleOut].map((p) => applyTransform(n.transform, p)))) : [[n.transform.x, n.transform.y] as Vec2]));
}
/**
 * The affine map taking points `a` to points `b` (least squares), or null when the points do not pin one down or the
 * art changed shape (an edit, not a transform): the instance then only follows the move of its centre.
 */
export function fitAffine(a: Vec2[], b: Vec2[]): M6 | null {
  if (a.length !== b.length || a.length < 3) return null;
  // normal equations for [x y 1]·[a c e]ᵀ = x' and · [b d f]ᵀ = y'
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  const n = a.length;
  const r = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const [x, y] = a[i], [u, v] = b[i];
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y;
    r[0] += x * u; r[1] += y * u; r[2] += u; r[3] += x * v; r[4] += y * v; r[5] += v;
  }
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const solve = (rhs: number[]): number[] | null => {
    const M = A.map((row, i) => [...row, rhs[i]]);
    for (let c = 0; c < 3; c++) {
      let p = c;
      for (let k = c + 1; k < 3; k++) if (Math.abs(M[k][c]) > Math.abs(M[p][c])) p = k;
      if (Math.abs(M[p][c]) < 1e-9) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let k = 0; k < 3; k++) if (k !== c) {
        const f = M[k][c] / M[c][c];
        for (let j = c; j < 4; j++) M[k][j] -= f * M[c][j];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  };
  const X = solve(r.slice(0, 3)), Y = solve(r.slice(3));
  if (!X || !Y) return null;
  const m: M6 = [X[0], Y[0], X[1], Y[1], X[2], Y[2]];
  // a real transform maps every point (within a hundredth of a pixel or so)
  for (let i = 0; i < n; i++) {
    const q = applyM(m, a[i]);
    if (Math.hypot(q[0] - b[i][0], q[1] - b[i][1]) > 0.05) return null;
  }
  return m;
}

const sub = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]];
const centre = (nodes: readonly SceneNode[]): Vec2 => {
  const b = boundsOf(nodes);
  return [b.x + b.w / 2, b.y + b.h / 2];
};

// ───────── colours ─────────

function rgba(c: string | null): [number, number, number, number] | null {
  if (!c) return null;
  const s = c.trim().toLowerCase();
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join("");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const v = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    return [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 1];
  }
  return null;
}
const hex2 = (v: number) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0");
function mixColor(a: string | null, b: string | null, u: number): string | null {
  const A = rgba(a), B = rgba(b);
  if (!A && !B) return null;
  if (!A) return b;
  if (!B) return a;
  const al = A[3] + (B[3] - A[3]) * u;
  return "#" + hex2(A[0] + (B[0] - A[0]) * u) + hex2(A[1] + (B[1] - A[1]) * u) + hex2(A[2] + (B[2] - A[2]) * u) + (al < 0.999 ? hex2(al * 255) : "");
}

/** Illustrator's Smooth Color: enough steps that neighbouring colours differ by about one level (at most 256). */
export function smoothSteps(a: VectorNode, b: VectorNode): number {
  const d = (x: string | null, y: string | null) => {
    const A = rgba(x), B = rgba(y);
    return A && B ? Math.max(Math.abs(A[0] - B[0]), Math.abs(A[1] - B[1]), Math.abs(A[2] - B[2])) : 0;
  };
  const k = Math.max(d(a.fill, b.fill), d(a.stroke, b.stroke));
  // the same colours: Illustrator then spaces the steps by size; a handful reads as the blend
  return k < 1 ? 5 : Math.min(256, Math.max(1, Math.round(k / 2)));
}

// ───────── blend shapes ─────────

/** A vector's contours in page space. */
function pageContours(n: VectorNode): Contour[] {
  return n.contours.map((c) => ({ closed: c.closed, nodes: c.nodes.map((a) => ({ ...a, anchor: applyTransform(n.transform, a.anchor), handleIn: applyTransform(n.transform, a.handleIn), handleOut: applyTransform(n.transform, a.handleOut) })) }));
}

const lerp = (a: Vec2, b: Vec2, u: number): Vec2 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];

/** A polyline resampled to m points evenly along its length. */
function resample(pts: Vec2[], m: number, closed: boolean): Vec2[] {
  const p = closed ? [...pts, pts[0]] : pts;
  const acc = [0];
  for (let i = 1; i < p.length; i++) acc.push(acc[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
  const total = acc[acc.length - 1] || 1;
  const out: Vec2[] = [];
  const n = closed ? m : m - 1;
  for (let k = 0, j = 0; k < m; k++) {
    const s = (k / n) * total;
    while (j < acc.length - 2 && acc[j + 1] < s) j++;
    const seg = acc[j + 1] - acc[j] || 1;
    out.push(lerp(p[j], p[Math.min(j + 1, p.length - 1)], (s - acc[j]) / seg));
  }
  return out;
}

const signedArea = (p: Vec2[]) => p.reduce((s, a, i) => s + a[0] * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * a[1], 0);

/** Contours of the step at u between two shapes: anchor by anchor when they match, else resampled outlines. */
function blendContours(a: Contour[], b: Contour[], u: number): Contour[] {
  const same = a.length === b.length && a.every((c, i) => c.nodes.length === b[i].nodes.length && c.closed === b[i].closed);
  if (same)
    return a.map((c, i) => ({
      closed: c.closed,
      nodes: c.nodes.map((x, j) => {
        const y = b[i].nodes[j];
        return { anchor: lerp(x.anchor, y.anchor, u), handleIn: lerp(x.handleIn, y.handleIn, u), handleOut: lerp(x.handleOut, y.handleOut, u), isCorner: x.isCorner && y.isCorner };
      }),
    }));
  const k = Math.min(a.length, b.length);
  const out: Contour[] = [];
  for (let i = 0; i < k; i++) {
    const closed = a[i].closed && b[i].closed;
    const pa = flatten(a[i], 0.3), pb0 = flatten(b[i], 0.3);
    const m = Math.min(400, Math.max(48, pa.length, pb0.length));
    const ra = resample(pa, m, closed);
    let rb = resample(pb0, m, closed);
    if (closed) {
      // the same winding, and B's start turned to the point nearest A's start
      if (Math.sign(signedArea(ra)) !== Math.sign(signedArea(rb))) rb = rb.reverse();
      let best = 0, bd = Infinity;
      for (let j = 0; j < m; j++) {
        let d = 0;
        for (let q = 0; q < m; q += Math.max(1, (m / 16) | 0)) d += Math.hypot(ra[q][0] - rb[(q + j) % m][0], ra[q][1] - rb[(q + j) % m][1]);
        if (d < bd) [bd, best] = [d, j];
      }
      rb = rb.map((_, q) => rb[(q + best) % m]);
    }
    out.push({ closed, nodes: ra.map((p, q) => {
      const v = lerp(p, rb[q], u);
      return { anchor: v, handleIn: v, handleOut: v, isCorner: true };
    }) });
  }
  return out;
}

/** The `steps` shapes between vectors a and b (page space), bottom → top. */
export function blendSteps(a: VectorNode, b: VectorNode, steps: number): VectorNode[] {
  const ca = pageContours(a), cb = pageContours(b);
  const ka = Math.abs(a.transform.scale) || 1, kb = Math.abs(b.transform.scale) || 1;
  const out: VectorNode[] = [];
  for (let k = 1; k <= steps; k++) {
    const u = k / (steps + 1);
    const v: VectorNode = {
      ...clone(a),
      id: uid("n"),
      name: t("design.art.blendStep", { n: k }),
      contours: blendContours(ca, cb, u),
      transform: { ...IDENTITY },
      fill: mixColor(a.fill, b.fill, u),
      stroke: mixColor(a.stroke, b.stroke, u),
      strokeWidth: a.strokeWidth * ka + (b.strokeWidth * kb - a.strokeWidth * ka) * u,
      opacity: a.opacity + (b.opacity - a.opacity) * u,
      artGen: true,
    };
    delete (v as Partial<VectorNode>).strokeArrows;
    out.push(v);
  }
  return out;
}

// ───────── generating the members of a live-art group ─────────

/** What a live-art group generates from its sources (page space). */
function generate(art: ArtGroupMeta, sources: SceneNode[], doc: OmwDocument): SceneNode[][] {
  switch (art.kind) {
    case "blend": {
      const vs = sources.filter((n): n is VectorNode => n.type === "VECTOR");
      const out: SceneNode[][] = [];
      for (let i = 0; i + 1 < vs.length; i++) {
        const n = Math.max(1, Math.min(1000, art.steps ?? smoothSteps(vs[i], vs[i + 1])));
        let steps = blendSteps(vs[i], vs[i + 1], n);
        // along a replaced spine: each step's centre on the spine at its share, turned with it when aligned to the path
        if (art.spine && art.spine.nodes.length > 1) {
          const sp = spineOf(art.spine);
          const c0 = centre([vs[i]]), c1 = centre([vs[i + 1]]);
          const base = Math.atan2(c1[1] - c0[1], c1[0] - c0[0]);
          steps = steps.map((st, k) => {
            const f = (i + (k + 1) / (n + 1)) / (vs.length - 1);
            const at = sp.at(f), c = centre([st]);
            const a = art.orient === "path" ? sp.angle(f) - base : 0, co = Math.cos(a), si = Math.sin(a);
            const moved = mapNode(st, ([x, y]) => {
              const dx = x - c[0], dy = y - c[1];
              return [at[0] + dx * co - dy * si, at[1] + dx * si + dy * co];
            }) as VectorNode;
            return { ...moved, id: st.id, name: st.name, artGen: true as const };
          });
        }
        out.push(steps);
      }
      return out;
    }
    case "repeat": {
      if (!sources.length) return [];
      const b = boundsOf(sources);
      const c: Vec2 = [b.x + b.w / 2, b.y + b.h / 2];
      const copies: SceneNode[] = [];
      if (art.mode === "radial") {
        const n = Math.max(2, Math.min(200, Math.round(art.count ?? 8)));
        const r = art.radius ?? Math.max(b.w, b.h);
        const o: Vec2 = [c[0], c[1] + r];
        for (let k = 1; k < n; k++) {
          const a = (2 * Math.PI * k) / n, co = Math.cos(a), si = Math.sin(a);
          const f = (p: Vec2): Vec2 => [o[0] + (p[0] - o[0]) * co - (p[1] - o[1]) * si, o[1] + (p[0] - o[0]) * si + (p[1] - o[1]) * co];
          for (const s of sources) copies.push(mapNode(s, f, (a * 180) / Math.PI));
        }
      } else if (art.mode === "grid") {
        const rows = Math.max(1, Math.min(100, Math.round(art.rows ?? 3))), cols = Math.max(1, Math.min(100, Math.round(art.cols ?? 3)));
        const gx = art.gapX ?? 10, gy = art.gapY ?? 10;
        for (let i = 0; i < rows; i++)
          for (let j = 0; j < cols; j++) {
            if (!i && !j) continue;
            const dx = j * (b.w + gx), dy = i * (b.h + gy);
            for (const s of sources) copies.push(mapNode(s, (p) => [p[0] + dx, p[1] + dy]));
          }
      } else {
        // mirror: a reflected copy across an axis through the point beside the art (Illustrator's mirror repeat)
        const ax = (((art.axis ?? 90) * Math.PI) / 180) * -1;
        const o: Vec2 = [b.x + b.w + (art.gapX ?? 10) / 2, c[1]];
        const co = Math.cos(2 * ax), si = Math.sin(2 * ax);
        const f = (p: Vec2): Vec2 => {
          const x = p[0] - o[0], y = p[1] - o[1];
          return [o[0] + x * co + y * si, o[1] + x * si - y * co];
        };
        for (const s of sources) copies.push(mapNode(s, f, 0, true));
      }
      for (const n of copies) n.artGen = true;
      return [copies];
    }
    case "symbol": {
      const def = doc.symbols?.find((x) => x.id === art.symbolId);
      if (!def) return [];
      const m = symMatrix(art);
      const turn = (Math.atan2(m[1], m[0]) * 180) / Math.PI, flip = m[0] * m[3] - m[1] * m[2] < 0;
      return [def.nodes.map((n) => ({ ...mapNode(n, (p) => applyM(m, p), turn, flip), artGen: true as const }))];
    }
  }
}

/** Rebuild the generated members of group `g` on page `pg` (a draft): old ones out, new ones in their places. */
function rebuild(d: Draft<OmwDocument>, pg: Draft<Page>, g: LayerGroup) {
  const art = g.art!;
  const members = pg.nodes.filter((n) => n.groupId === g.id);
  const sources = members.filter((n) => !n.artGen) as SceneNode[];
  const made = generate(art, clone(sources), d as OmwDocument);
  // where they go: blend steps between their two sources, repeat copies above the art, symbol art where the old was
  const firstIdx = pg.nodes.findIndex((n) => n.groupId === g.id);
  pg.nodes = pg.nodes.filter((n) => !(n.groupId === g.id && n.artGen)) as any;
  for (const set of made) for (const n of set) n.groupId = g.id;
  if (art.kind === "blend") {
    const vs = pg.nodes.filter((n) => n.groupId === g.id && n.type === "VECTOR");
    for (let i = made.length - 1; i >= 0; i--) {
      const at = pg.nodes.findIndex((n) => n.id === vs[i + 1]?.id);
      if (at >= 0) pg.nodes.splice(at, 0, ...(made[i] as any));
    }
  } else if (art.kind === "repeat") {
    const last = pg.nodes.reduce((k, n, i) => (n.groupId === g.id ? i : k), -1);
    pg.nodes.splice(last + 1, 0, ...(made.flat() as any));
  } else pg.nodes.splice(Math.max(0, Math.min(firstIdx, pg.nodes.length)), 0, ...(made.flat() as any));
}

/** storeHooks.settle: bring live art up to date after a change (sources edited, options changed, symbol redefined). */
export function settleArt(next: OmwDocument, prev: OmwDocument): OmwDocument {
  const symChanged = next.symbols !== prev.symbols;
  const todo: [string, string][] = [];
  const moves: [string, string, Vec2 | M6][] = [];
  for (const pg of [...next.pages, ...next.masters]) {
    if (!pg.groups?.some((g) => g.art)) continue;
    const old = prev.pages.find((p) => p.id === pg.id) ?? prev.masters.find((p) => p.id === pg.id);
    if (old === pg && !symChanged) continue;
    for (const g of pg.groups) {
      if (!g.art) continue;
      const og = old?.groups?.find((x) => x.id === g.id);
      const src = (p: Page | undefined) => (p?.nodes ?? []).filter((n) => n.groupId === g.id && !n.artGen);
      const now = src(pg), was = src(old);
      if (g.art.kind === "symbol") {
        const sd = next.symbols?.find((x) => x.id === (g.art as { symbolId: string }).symbolId);
        const od = prev.symbols?.find((x) => x.id === (g.art as { symbolId: string }).symbolId);
        if (!og || og.art !== g.art || sd !== od) todo.push([pg.id, g.id]);
        else if (editing?.groupId !== g.id) {
          // the instance itself moved: its offset follows (no rebuild)
          const m = (p: Page | undefined) => (p?.nodes ?? []).filter((n) => n.groupId === g.id);
          const a = m(pg), b = m(old);
          if (a.length && b.length && (a.length !== b.length || a.some((n, i) => n !== b[i]))) {
            // turned / scaled / sheared by the transform tools (their path baked): the whole change as a matrix
            const fit = a.length === b.length ? fitAffine(pointsOf(b), pointsOf(a)) : null;
            moves.push([pg.id, g.id, fit ?? sub(centre(a), centre(b))]);
          }
        }
        continue;
      }
      if (!og || og.art !== g.art || now.length !== was.length || now.some((n, i) => n !== was[i])) todo.push([pg.id, g.id]);
    }
  }
  if (!todo.length && !moves.length) return next;
  const pageOf = (d: Draft<OmwDocument>, pid: string) => (d.pages.find((p) => p.id === pid) ?? d.masters.find((p) => p.id === pid)) as Draft<Page> | undefined;
  return produce(next, (d) => {
    for (const [pid, gid, mv] of moves) {
      const g = pageOf(d, pid)?.groups?.find((x) => x.id === gid);
      if (g?.art?.kind !== "symbol") continue;
      if (mv.length === 2) {
        const m = g.art.m;
        g.art = m ? { ...g.art, m: [m[0], m[1], m[2], m[3], m[4] + mv[0], m[5] + mv[1]] } : { ...g.art, dx: g.art.dx + mv[0], dy: g.art.dy + mv[1] };
      } else {
        const m = mulM(mv, symMatrix(g.art));
        g.art = { ...g.art, dx: m[4], dy: m[5], m };
      }
    }
    for (const [pid, gid] of todo) {
      const pg = pageOf(d, pid);
      const g = pg?.groups?.find((x) => x.id === gid);
      if (pg && g?.art) rebuild(d, pg, g as LayerGroup);
    }
  });
}
storeHooks.settle = settleArt;

// ───────── commands ─────────

const vectorsSel = (page: Page) => page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && S().selection.includes(n.id) && !n.locked);
/** The live-art group the selection is in (one of `kind`, or any). */
export function selectedArt(kind?: ArtGroupMeta["kind"]): LayerGroup | null {
  const page = currentPage();
  if (!page?.groups) return null;
  const sel = page.nodes.filter((n) => S().selection.includes(n.id));
  for (const n of sel) {
    const g = page.groups.find((x) => x.id === n.groupId);
    if (g?.art && (!kind || g.art.kind === kind)) return g;
  }
  return null;
}

/** A spine as a polyline with its length: the point and the direction at a share f (0..1) of the way along. */
function spineOf(c: Contour): { at: (f: number) => Vec2; angle: (f: number) => number } {
  const pts = flatten(c, 0.3);
  if (c.closed) pts.push(pts[0]);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[acc.length - 1] || 1;
  const seg = (f: number) => {
    const s = Math.max(0, Math.min(1, f)) * total;
    let i = 1;
    while (i < acc.length - 1 && acc[i] < s) i++;
    return { i, u: (s - acc[i - 1]) / (acc[i] - acc[i - 1] || 1) };
  };
  return {
    at: (f) => {
      const { i, u } = seg(f);
      return lerp(pts[i - 1], pts[i], u);
    },
    angle: (f) => {
      const { i } = seg(f);
      return Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]);
    },
  };
}

/**
 * Object › Blend › Replace Spine: the selected blend follows the selected path (which is used up, as in Illustrator);
 * its source shapes move to the spine's ends (and evenly along it when there are more than two).
 */
export function replaceSpine(): boolean {
  const page = currentPage();
  const g = selectedArt("blend");
  if (!page || !g || g.art?.kind !== "blend") return false;
  const path = page.nodes.find((n): n is VectorNode => n.type === "VECTOR" && S().selection.includes(n.id) && n.groupId !== g.id && !n.artGen && n.contours[0]?.nodes.length > 1);
  if (!path) {
    S().notify(t("design.art.needSpine"));
    return false;
  }
  const spine: Contour = { closed: path.contours[0].closed, nodes: path.contours[0].nodes.map((a) => ({ ...a, anchor: applyTransform(path.transform, a.anchor), handleIn: applyTransform(path.transform, a.handleIn), handleOut: applyTransform(path.transform, a.handleOut) })) };
  const sp = spineOf(spine);
  const srcs = page.nodes.filter((n) => n.groupId === g.id && !n.artGen && n.type === "VECTOR");
  const moves = new Map(srcs.map((n, k) => {
    const c = centre([n]), at = sp.at(srcs.length > 1 ? k / (srcs.length - 1) : 0);
    return [n.id, [at[0] - c[0], at[1] - c[1]] as Vec2];
  }));
  S().commit(t("design.art.hist.spine"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.nodes = pg.nodes.filter((n) => n.id !== path.id) as any;
    for (const n of pg.nodes) {
      const mv = moves.get(n.id);
      if (mv) {
        n.transform.x += mv[0];
        n.transform.y += mv[1];
      }
    }
    const gr = pg.groups?.find((x) => x.id === g.id);
    if (gr?.art?.kind === "blend") gr.art = { ...gr.art, spine: spine as any };
  });
  S().set({ selection: currentPage()?.nodes.filter((n) => n.groupId === g.id).map((n) => n.id) ?? [] });
  return true;
}

/** Wrap the selection into a new live-art group (one undo step); the group's members become the selection. */
function makeArt(label: string, art: ArtGroupMeta, ids: string[], name: string): string | null {
  const page = currentPage();
  if (!page || !ids.length) return null;
  const g = { ...newGroup(name), art };
  // inside the selection's own group, if they share one
  const parents = new Set(page.nodes.filter((n) => ids.includes(n.id)).map((n) => n.groupId ?? null));
  if (parents.size === 1) g.parentId = [...parents][0];
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups = [...(pg.groups ?? []), g] as any;
    for (const n of pg.nodes) if (ids.includes(n.id)) n.groupId = g.id;
  });
  const pg = currentPage();
  S().set({ selection: pg?.nodes.filter((n) => n.groupId === g.id).map((n) => n.id) ?? [] });
  return g.id;
}

/** Object › Blend › Make (Ctrl+Alt+B): two or more paths, `steps` between each pair (null = smooth colour). */
export function makeBlend(steps: number | null = useArtOptions.blendSteps): boolean {
  const page = currentPage();
  if (!page) return false;
  const vs = vectorsSel(page);
  if (vs.length < 2) {
    S().notify(t("design.art.needTwo"));
    return false;
  }
  return !!makeArt(t("design.art.hist.blend"), { kind: "blend", steps }, vs.map((v) => v.id), t("design.art.blend"));
}

/** Object › Repeat › Radial / Grid / Mirror on the selection. */
export function makeRepeat(mode: "radial" | "grid" | "mirror"): boolean {
  const page = currentPage();
  if (!page) return false;
  const ids = page.nodes.filter((n) => S().selection.includes(n.id) && !n.locked && !n.artGen).map((n) => n.id);
  if (!ids.length) {
    S().notify(t("cmd.why.pickLayer"));
    return false;
  }
  const art: ArtGroupMeta = mode === "radial" ? { kind: "repeat", mode, count: 8 } : mode === "grid" ? { kind: "repeat", mode, rows: 3, cols: 3, gapX: 10, gapY: 10 } : { kind: "repeat", mode, axis: 90, gapX: 10 };
  return !!makeArt(t(`design.art.hist.repeat.${mode}`), art, ids, t(`design.art.repeat.${mode}`));
}

/** Change the options of the selected blend / repeat (the dialogs): its generated members follow. */
export function setArtOptions(patch: Partial<Record<string, number | string | null>>): void {
  const page = currentPage();
  const g = selectedArt();
  if (!page || !g?.art || g.art.kind === "symbol") return;
  S().commit(t("design.art.hist.options"), (d) => {
    const gr = draftPage(d, page.id)?.groups?.find((x) => x.id === g.id);
    if (gr?.art) {
      const a = { ...gr.art, ...patch } as Record<string, unknown>;
      // (an option set to null that means "the default" is left out, e.g. orientation back to the page)
      for (const k of Object.keys(patch)) if (patch[k] === null && k !== "steps") delete a[k];
      gr.art = a as ArtGroupMeta;
    }
  });
}

/** Object › Blend / Repeat › Release: the generated members go, the sources stay (ungrouped). */
export function releaseArt(): boolean {
  const page = currentPage();
  const g = selectedArt();
  if (!page || !g) return false;
  const keep = page.nodes.filter((n) => n.groupId === g.id && !n.artGen).map((n) => n.id);
  S().commit(t("design.art.hist.release"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.nodes = pg.nodes.filter((n) => !(n.groupId === g.id && n.artGen)) as any;
    for (const n of pg.nodes) if (n.groupId === g.id) n.groupId = g.parentId ?? undefined;
    pg.groups = pg.groups?.filter((x) => x.id !== g.id) as any;
  });
  S().set({ selection: keep });
  return true;
}

/** Object › Blend / Repeat › Expand (and a symbol's Break Link): the group stays, every member an ordinary object. */
export function expandArt(): boolean {
  const page = currentPage();
  const g = selectedArt();
  if (!page || !g) return false;
  S().commit(t(g.art?.kind === "symbol" ? "design.sym.hist.break" : "design.art.hist.expand"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const n of pg.nodes) if (n.groupId === g.id) delete n.artGen;
    const gr = pg.groups?.find((x) => x.id === g.id);
    if (gr) delete gr.art;
  });
  return true;
}

/** Options remembered for the next blend (Blend Options dialog). */
export const useArtOptions = { blendSteps: null as number | null };

// ───────── symbols ─────────

/** Symbols panel › New Symbol: the selection becomes a symbol and, in its place, its first instance. */
export function newSymbol(name?: string): string | null {
  const page = currentPage();
  if (!page) return null;
  const sel = page.nodes.filter((n) => S().selection.includes(n.id) && !n.locked);
  if (!sel.length) {
    S().notify(t("cmd.why.pickLayer"));
    return null;
  }
  const doc = S().doc;
  const def: SymbolDef = { id: uid("sym"), name: name ?? t("design.sym.defaultName", { n: (doc.symbols?.length ?? 0) + 1 }), nodes: sel.map((n) => ({ ...clone(n), groupId: undefined, artGen: undefined })) };
  for (const n of def.nodes) {
    delete n.groupId;
    delete n.artGen;
  }
  const g = { ...newGroup(def.name), art: { kind: "symbol", symbolId: def.id, dx: 0, dy: 0 } as ArtGroupMeta };
  const ids = sel.map((n) => n.id);
  const parents = new Set(sel.map((n) => n.groupId ?? null));
  if (parents.size === 1) g.parentId = [...parents][0];
  S().commit(t("design.sym.hist.new"), (d) => {
    d.symbols = [...(d.symbols ?? []), def] as any;
    const pg = draftPage(d, page.id);
    if (!pg) return;
    // the originals become the instance's art (the same objects, now generated from the symbol)
    for (const n of pg.nodes)
      if (ids.includes(n.id)) {
        n.groupId = g.id;
        n.artGen = true;
      }
    pg.groups = [...(pg.groups ?? []), g] as any;
  });
  S().set({ selection: currentPage()?.nodes.filter((n) => n.groupId === g.id).map((n) => n.id) ?? [] });
  return def.id;
}

/** Symbols panel › Place Symbol Instance: a new instance in the middle of the view's page. */
export function placeSymbol(id: string): boolean {
  const page = currentPage();
  const def = S().doc.symbols?.find((x) => x.id === id);
  if (!page || !def) return false;
  const c = centre(def.nodes);
  const art: ArtGroupMeta = { kind: "symbol", symbolId: id, dx: page.width / 2 - c[0], dy: page.height / 2 - c[1] };
  const g = { ...newGroup(def.name), art };
  const made = generate(art, [], S().doc)[0] ?? [];
  for (const n of made) n.groupId = g.id;
  S().commit(t("design.sym.hist.place"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups = [...(pg.groups ?? []), g] as any;
    pg.nodes.push(...(made as any));
  });
  S().set({ selection: currentPage()?.nodes.filter((n) => n.groupId === g.id).map((n) => n.id) ?? [] });
  return true;
}

/** The instances of a symbol on every page. */
export function symbolUses(id: string): number {
  let k = 0;
  for (const p of [...S().doc.pages, ...S().doc.masters]) for (const g of p.groups ?? []) if (g.art?.kind === "symbol" && g.art.symbolId === id) k++;
  return k;
}

let editing: { groupId: string; symbolId: string; pageId: string } | null = null;
/** Is a symbol being edited (its instance isolated)? */
export const symbolEditing = () => editing;

/** Symbols panel › Edit Symbol (or a double-click on an instance): the instance isolated, its art editable. */
export function editSymbol(): boolean {
  const g = selectedArt("symbol");
  const page = currentPage();
  if (!g || !page || g.art?.kind !== "symbol") return false;
  editing = { groupId: g.id, symbolId: g.art.symbolId, pageId: page.id };
  enterIsolation(g.id);
  S().notify(t("design.sym.msg.editing"));
  return true;
}

/** Leave symbol editing: the instance's art as it is now becomes the symbol (every instance follows). */
export function finishSymbolEdit(): boolean {
  const e = editing;
  editing = null;
  if (!e) return false;
  const doc = S().doc;
  const page = [...doc.pages, ...doc.masters].find((p) => p.id === e.pageId);
  const g = page?.groups?.find((x) => x.id === e.groupId);
  const def = doc.symbols?.find((x) => x.id === e.symbolId);
  if (useDesign.getState().isolated === e.groupId) exitIsolation();
  if (!page || !g || g.art?.kind !== "symbol" || !def) return false;
  const mem = page.nodes.filter((n) => n.groupId === g.id);
  if (!mem.length) return false;
  const inv = invM(symMatrix(g.art));
  if (!inv) return false;
  const turn = (Math.atan2(inv[1], inv[0]) * 180) / Math.PI, flip = inv[0] * inv[3] - inv[1] * inv[2] < 0;
  const nodes = mem.map((n) => {
    const c = mapNode(n, (p) => applyM(inv, p), turn, flip);
    c.id = n.id;
    delete c.groupId;
    delete c.artGen;
    return c;
  });
  S().commit(t("design.sym.hist.edit"), (d) => {
    const sd = d.symbols?.find((x) => x.id === def.id);
    if (sd) sd.nodes = nodes as any;
    // this instance keeps its offset (settleArt reads it from where its art is now)
  });
  return true;
}

// leaving the isolation (Esc, a double-click outside) ends a symbol edit
useDesign.subscribe((s, p) => {
  if (editing && p.isolated === editing.groupId && s.isolated !== editing.groupId) finishSymbolEdit();
});

/** Symbols panel › Delete Symbol: its instances become ordinary groups first (Illustrator asks; here they stay). */
export function deleteSymbol(id: string): void {
  S().commit(t("design.sym.hist.delete"), (d) => {
    for (const p of [...d.pages, ...d.masters])
      for (const g of p.groups ?? [])
        if (g.art?.kind === "symbol" && g.art.symbolId === id) {
          delete g.art;
          for (const n of p.nodes) if (n.groupId === g.id) delete n.artGen;
        }
    d.symbols = d.symbols?.filter((x) => x.id !== id) as any;
    if (!d.symbols?.length) delete d.symbols;
  });
}

// ───────── pattern swatches ─────────

export interface PatternDoc {
  patterns?: PatternFill[];
}
const patternsOf = (d: OmwDocument) => (d as OmwDocument & PatternDoc).patterns ?? [];
export const docPatterns = () => patternsOf(S().doc);

/** Object › Pattern › Make: the selected paths become a pattern swatch (their box is the tile). */
export function makePattern(): string | null {
  const page = currentPage();
  if (!page) return null;
  const vs = vectorsSel(page).filter((v) => v.fill);
  if (!vs.length) {
    S().notify(t("design.pat.needFill"));
    return null;
  }
  const b = boundsOf(vs);
  // the tile is the art's own box (Illustrator's default pattern tile: no gap)
  const tile = vs.map((v) => mapNode(v, (p) => [p[0] - b.x, p[1] - b.y]) as VectorNode);
  const pf: PatternFill = { id: uid("pat"), name: t("design.pat.defaultName", { n: patternsOf(S().doc).length + 1 }), w: Math.max(1, b.w), h: Math.max(1, b.h), tile };
  S().commit(t("design.pat.hist.make"), (d) => {
    const dd = d as Draft<OmwDocument & PatternDoc>;
    dd.patterns = [...(dd.patterns ?? []), pf] as any;
  });
  S().notify(t("design.pat.msg.made", { name: pf.name }));
  return pf.id;
}

/** Fill the selected paths with a pattern swatch (null: back to their plain fill). */
export function applyPattern(id: string | null): number {
  const page = currentPage();
  if (!page) return 0;
  const vs = vectorsSel(page);
  const pf = id ? patternsOf(S().doc).find((x) => x.id === id) : null;
  if (!vs.length || (id && !pf)) return 0;
  const ids = vs.map((v) => v.id);
  S().commit(t("design.pat.hist.apply"), (d) => {
    for (const n of draftPage(d, page.id)?.nodes ?? [])
      if (ids.includes(n.id) && n.type === "VECTOR") {
        if (pf) {
          n.patternFill = clone(pf) as any;
          if (!n.fill) n.fill = "#ffffff";
        } else delete n.patternFill;
      }
  });
  return vs.length;
}

// ───────── pattern editing (Illustrator's Pattern Editing Mode) ─────────

export interface PatternEdit {
  groupId: string;
  patternId: string;
  pageId: string;
  /** where the tile's top left sits on the page while editing */
  ox: number;
  oy: number;
  /** the tile box (Pattern Options width / height, or its box dragged on the canvas) and the overlap */
  w: number;
  h: number;
  overlapH: "left" | "right";
  overlapV: "top" | "bottom";
}
/** The pattern being edited (its tile art isolated on the page), with its tile box; null when none. */
export const usePatternEdit = create<{ edit: PatternEdit | null }>(() => ({ edit: null }));
const getPE = () => usePatternEdit.getState().edit;
const setPE = (edit: PatternEdit | null) => usePatternEdit.setState({ edit });
export const patternEditing = getPE;
/** Pattern Options while editing: the tile's width / height and overlap. */
export function setPatternTile(p: Partial<Pick<PatternEdit, "w" | "h" | "overlapH" | "overlapV">>): void {
  const e = getPE();
  if (!e) return;
  setPE({ ...e, ...p, w: Math.max(1, p.w ?? e.w), h: Math.max(1, p.h ?? e.h) });
}

/** Edit a pattern swatch: its tile art is put on the page (isolated); leaving the isolation saves it into the swatch. */
export function editPattern(id: string): boolean {
  const page = currentPage();
  const pf = patternsOf(S().doc).find((x) => x.id === id);
  if (!page || !pf) return false;
  if (getPE()) finishPatternEdit();
  const ox = Math.round(page.width / 2 - pf.w / 2), oy = Math.round(page.height / 2 - pf.h / 2);
  const g = newGroup(t("design.pat.editGroup", { name: pf.name }));
  const made = pf.tile.map((n) => ({ ...mapNode(n, (p) => [p[0] + ox, p[1] + oy]), groupId: g.id }));
  S().commit(t("design.pat.hist.edit"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups = [...(pg.groups ?? []), g] as any;
    pg.nodes.push(...(made as any));
  });
  setPE({ groupId: g.id, patternId: id, pageId: page.id, ox, oy, w: pf.w, h: pf.h, overlapH: pf.overlapH ?? "left", overlapV: pf.overlapV ?? "top" });
  enterIsolation(g.id);
  S().notify(t("design.pat.msg.editing", { w: Math.round(pf.w), h: Math.round(pf.h) }));
  return true;
}

/** Leave pattern editing: the tile art as it is now becomes the swatch, and every path filled with it follows. */
export function finishPatternEdit(): boolean {
  const e = getPE();
  setPE(null);
  if (!e) return false;
  if (useDesign.getState().isolated === e.groupId) exitIsolation();
  const doc = S().doc;
  const page = [...doc.pages, ...doc.masters].find((p) => p.id === e.pageId);
  const pf = patternsOf(doc).find((x) => x.id === e.patternId);
  if (!page || !pf) return false;
  const mem = page.nodes.filter((n): n is VectorNode => n.groupId === e.groupId && n.type === "VECTOR");
  const tile = mem.map((n) => {
    const c = mapNode(n, (p) => [p[0] - e.ox, p[1] - e.oy]) as VectorNode;
    delete c.groupId;
    return c;
  });
  const next: PatternFill = { ...pf, tile, w: e.w, h: e.h };
  if (e.overlapH === "right") next.overlapH = "right";
  else delete next.overlapH;
  if (e.overlapV === "bottom") next.overlapV = "bottom";
  else delete next.overlapV;
  S().commit(t("design.pat.hist.edit"), (d) => {
    const dd = d as Draft<OmwDocument & PatternDoc>;
    dd.patterns = dd.patterns?.map((x) => (x.id === pf.id ? next : x)) as any;
    for (const p of [...d.pages, ...d.masters]) {
      if (p.id === e.pageId) {
        p.nodes = p.nodes.filter((n) => n.groupId !== e.groupId) as any;
        p.groups = p.groups?.filter((g) => g.id !== e.groupId) as any;
      }
      for (const n of p.nodes) if (n.type === "VECTOR" && n.patternFill?.id === pf.id) n.patternFill = clone(next) as any;
    }
  });
  return true;
}

useDesign.subscribe((s, p) => {
  const e = getPE();
  if (e && p.isolated === e.groupId && s.isolated !== e.groupId) finishPatternEdit();
});
