// Modify and inquiry commands of the drawing screen beyond engine.ts (AutoCAD's Modify / Layers / Utilities panels):
// STRETCH (S, crossing window), PEDIT (PE), CHAMFER (CHA), BREAK (BR), LENGTHEN (LEN), ALIGN (AL), ARRAY (AR: type
// rectangular / path / polar), ARRAYPOLAR, ARRAYPATH, MATCHPROP (MA), LIST (LI), QSELECT (QSE) / FILTER (FI),
// LAYISO / LAYUNISO / LAYOFF / LAYON / LAYFRZ / LAYTHW / LAYLCK / LAYULK / LAYMCUR, PROPERTIES (PR), PAN (P),
// REGEN (RE), UNITS (UN) and PURGE (PU).

import { create } from "zustand";
import type { Draft } from "immer";
import { currentPage, draftPage, useStore } from "../../core/store";
import { uid, type Contour, type Page, type SceneNode, type VectorNode } from "../../core/types";
import { t } from "../../i18n";
import { useUI } from "../shell/uiStore";
import { COMMANDS, hooksCad, bridge, joinNodes, saveLayerState, restoreLayerState, layerGroupOf, lwPx, mapNode, parts, say, setCurrentLayer, textParts, transformNodes, currentLayer, type Cmd } from "./engine";
import {
  angleOf, ap, arcOf, deg, dist, fmt, mul, nearest, nodeMat, nodeSegs, pageToW, polyArea, rotateAbout, scaleAbout, segPart, segsToContour, sub, translate, trimContour, wToPage,
  type Mat, type Seg, type W,
} from "./geom";
import { nodeColor, nodeLayer, moveToLayer } from "./layers";
import { hatchArea, placeHatch } from "./hatch";
import { regenViewports } from "./layout";
import { hatchOf, lengthOf, pointsAlong, splineAnchors } from "./moreDraw";

const S = () => useStore.getState();
const P = parts;
const cadNow = () => currentPage()?.source?.cad;
const unit = (v: W): W => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

// ───────── STRETCH ─────────

/**
 * Stretch: the vertices inside the crossing window move by d; objects wholly inside (or picked without a window) move
 * whole; texts move when their insertion point is inside. One undo step.
 */
export function stretchNodes(ids: string[], win: { a: W; b: W } | null, d: W): number {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad || !ids.length) return 0;
  ids = textParts(page, ids);
  const x0 = win ? Math.min(win.a[0], win.b[0]) : -Infinity, x1 = win ? Math.max(win.a[0], win.b[0]) : Infinity;
  const y0 = win ? Math.min(win.a[1], win.b[1]) : -Infinity, y1 = win ? Math.max(win.a[1], win.b[1]) : Infinity;
  const inside = (p: W) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const whole = mul(wToPage(cad), mul(translate(d[0], d[1]), pageToW(cad)));
  let n = 0;
  S().commit(t("cadui.cmd.STRETCH"), (dr) => {
    const pg = draftPage(dr, page.id);
    if (!pg) return;
    const set = new Set(ids);
    for (const x of pg.nodes) {
      if (!set.has(x.id) || x.locked) continue;
      if (x.type === "VECTOR" && x.cadHatch) continue;
      if (x.type !== "VECTOR") {
        const o = ap(pageToW(cad), [x.transform.x, x.transform.y]);
        if (inside(o)) mapNode(x as SceneNode, whole), n++;
        continue;
      }
      const M = mul(pageToW(cad), nodeMat(x as unknown as SceneNode));
      const hits: [number, number][] = [];
      let all = 0;
      x.contours.forEach((c, ci) => c.nodes.forEach((q, i) => (all++, inside(ap(M, q.anchor)) && hits.push([ci, i]))));
      if (!hits.length) continue;
      n++;
      if (hits.length === all) {
        mapNode(x as SceneNode, whole);
        continue;
      }
      const L = P.invert(M);
      const o = ap(L, [0, 0]), q = ap(L, d);
      const dl: W = [q[0] - o[0], q[1] - o[1]];
      for (const [ci, i] of hits) P.shift(x.contours[ci].nodes[i], dl);
    }
  });
  // a hatch follows its boundary: the loop corners inside the window move and the hatch is drawn again
  const done = new Set<string>();
  for (const id of ids) {
    const h = hatchOf(currentPage()!, id);
    // (an associative hatch has followed its boundary already)
    if (!h || done.has(h.ids[0]) || h.h.src?.length) continue;
    h.ids.forEach((x) => done.add(x));
    let moved = false;
    const loops = h.h.loops.map((l) => l.map((q) => (inside(q as W) ? ((moved = true), [q[0] + d[0], q[1] + d[1]] as [number, number]) : q)));
    if (!moved) continue;
    const n0 = currentPage()!.nodes.find((q) => q.id === h.ids[0]) as VectorNode;
    placeHatch(t("cadui.cmd.STRETCH"), { ...h.h, loops }, h.color, n0.strokeWidth || lwPx(0.13), n0.groupId, h.ids);
    n++;
  }
  return n;
}

function* STRETCH(): Cmd {
  say(t("cadfeat.msg.stretchHow"));
  // the crossing window decides which vertices move: a selection made before does not count
  S().set({ selection: [] });
  bridge.lastWin = null;
  const ids = yield* P.selectObjects();
  const win = bridge.lastWin;
  if (!ids.length) return;
  S().set({ selection: ids });
  const a = yield* P.point({ prompt: "basePoint", opts: ["displacement"] });
  let d: W | null = null;
  if (a.k === "opt" && a.key === "displacement") {
    const q = yield* P.point({ prompt: "displacement", def: "0,0" });
    if (q.k === "point") d = q.p;
  } else if (a.k === "point") {
    const base = a.p;
    const b = yield* P.point({ prompt: "secondPoint", base, preview: (q) => [{ k: "line", a: base, b: q, dash: true }] });
    if (b.k === "point") d = sub(b.p, base);
  }
  P.finishSel();
  if (d) say(t("cadfeat.msg.stretched", { n: stretchNodes(ids, win, d) }));
}

// ───────── PEDIT ─────────

function* PEDIT(): Cmd {
  const pre = S().selection.length === 1 ? S().selection[0] : null;
  let id: string | null = pre;
  if (!id) {
    const o = yield { k: "pick", prompt: "pePick" };
    if (o.k !== "pick") return;
    id = o.id;
  }
  const n0 = P.nodeOf(id);
  if (n0?.type !== "VECTOR") return say(t("cadfeat.msg.notPoly"));
  if (n0.contours.length === 1 && n0.contours[0].nodes.length <= 2 || n0.name === t("cadui.ent.line") || n0.name === t("cadui.ent.arc")) {
    const y = yield { k: "key", prompt: "peConvert", opts: ["yes", "no"], def: t("cadui.o.yes") };
    if (y.k === "opt" && y.key === "no") return;
    rename(id, t("cadui.ent.pline"));
  }
  const page = currentPage()!;
  S().set({ selection: [id] });
  for (;;) {
    const n = P.nodeOf(id) as VectorNode | undefined;
    if (!n) break;
    const closed = n.contours.every((c) => c.closed);
    const r = yield { k: "key", prompt: "peWhat", opts: [closed ? "open" : "close", "join", "width", "fit", "spline", "decurve", "undo"] };
    if (r.k !== "opt") break;
    if (r.key === "close" || r.key === "open") editNode(page, id, t("cadui.cmd.PEDIT"), (x) => {
      for (const c of x.contours) {
        c.closed = r.key === "close";
        const f = c.nodes[0], l = c.nodes[c.nodes.length - 1];
        if (c.closed && c.nodes.length > 2 && dist(f.anchor, l.anchor) < 1e-9) c.nodes.pop();
      }
    });
    else if (r.key === "join") {
      S().set({ selection: [] });
      const more = yield* P.selectObjects();
      const k = joinNodes([id, ...more.filter((x) => x !== id)]);
      say(k ? t("cadfeat.msg.peJoined", { n: k }) : t("cadui.msg.cannotJoin"));
      S().set({ selection: [id] });
    } else if (r.key === "width") {
      const w = yield* P.point({ prompt: "peWidth", number: true, def: "0" });
      if (w.k !== "number" || w.v < 0) continue;
      const cad = cadNow()!;
      editNode(page, id, t("cadui.cmd.PEDIT"), (x) => {
        if (w.v > 0) {
          x.strokeWidth = w.v * cad.k;
          x.strokeCap = "butt";
          x.strokeJoin = "miter";
        } else {
          const g = layerGroupOf(currentPage()!, nodeLayer(currentPage()!, x as unknown as SceneNode));
          x.strokeWidth = lwPx(g?.cad?.lw ?? 0.25);
          delete x.strokeCap;
          delete x.strokeJoin;
        }
      });
    } else if (r.key === "fit" || r.key === "spline")
      editNode(page, id, t("cadui.cmd.PEDIT"), (x) => {
        for (const c of x.contours) c.nodes = splineAnchors(c.nodes.map((q) => q.anchor as W), c.closed) as any;
      });
    else if (r.key === "decurve")
      editNode(page, id, t("cadui.cmd.PEDIT"), (x) => {
        for (const c of x.contours) for (const q of c.nodes) (q.handleIn = [...q.anchor] as any), (q.handleOut = [...q.anchor] as any), (q.isCorner = true);
      });
    else if (r.key === "undo") S().undo();
  }
  P.finishSel();
}
function rename(id: string, name: string) {
  const page = currentPage();
  if (page) editNode(page, id, t("cadui.cmd.PEDIT"), (x) => void (x.name = name));
}
function editNode(page: Page, id: string, label: string, f: (x: Draft<VectorNode>) => void) {
  S().commit(label, (d) => {
    const x = draftPage(d, page.id)?.nodes.find((q) => q.id === id);
    if (x?.type === "VECTOR") f(x as Draft<VectorNode>);
  });
}

// ───────── CHAMFER ─────────

let cham = { d1: 0, d2: 0 };
/** The end of a picked line (or open polyline end segment) toward the corner X: which anchor moves, and where to. */
function cornerEnd(id: string, p: W, X: W) {
  const n = P.nodeOf(id), cad = cadNow();
  if (n?.type !== "VECTOR" || n.locked || !cad) return null;
  const segs = nodeSegs(n, cad);
  if (!segs.length) return null;
  const s = segs.reduce((b, x) => (nearest(x, p).d < nearest(b, p).d ? x : b), segs[0]);
  if (s.c1 || n.contours[s.ci].closed) return null;
  const q = nearest(s, p).p;
  let u = sub(q, X);
  if (Math.hypot(u[0], u[1]) < 1e-9) u = dist(s.a, X) > dist(s.b, X) ? sub(s.a, X) : sub(s.b, X);
  u = unit(u);
  const moveA = (s.a[0] - X[0]) * u[0] + (s.a[1] - X[1]) * u[1] < (s.b[0] - X[0]) * u[0] + (s.b[1] - X[1]) * u[1];
  const i = moveA ? s.si : s.si + 1;
  const len = n.contours[s.ci].nodes.length;
  if (i !== 0 && i !== len - 1) return null;
  return { id, ci: s.ci, i, far: moveA ? s.b : s.a, u, s };
}
/** CHAMFER two lines: both trimmed or extended to the corner, then cut back d1 / d2 along them and joined by a line. */
export function chamferAt(idA: string, pA: W, idB: string, pB: W, d1: number, d2: number): boolean {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad || idA === idB) return false;
  const sa = P.segsOf(idA).reduce<Seg | null>((b, x) => (!b || nearest(x, pA).d < nearest(b, pA).d ? x : b), null);
  const sb = P.segsOf(idB).reduce<Seg | null>((b, x) => (!b || nearest(x, pB).d < nearest(b, pB).d ? x : b), null);
  if (!sa || !sb || sa.c1 || sb.c1) return false;
  const da = sub(sa.b, sa.a), db = sub(sb.b, sb.a);
  const den = da[0] * db[1] - da[1] * db[0];
  if (Math.abs(den) < 1e-12 * Math.hypot(...da) * Math.hypot(...db)) return false;
  const tt = ((sb.a[0] - sa.a[0]) * db[1] - (sb.a[1] - sa.a[1]) * db[0]) / den;
  const X: W = [sa.a[0] + da[0] * tt, sa.a[1] + da[1] * tt];
  const ea = cornerEnd(idA, pA, X), eb = cornerEnd(idB, pB, X);
  if (!ea || !eb) return false;
  if (d1 > dist(X, ea.far) + 1e-9 || d2 > dist(X, eb.far) + 1e-9) return false;
  const ta: W = [X[0] + ea.u[0] * d1, X[1] + ea.u[1] * d1], tb: W = [X[0] + eb.u[0] * d2, X[1] + eb.u[1] * d2];
  const m = wToPage(cad);
  S().commit(t("cadui.cmd.CHAMFER"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const [e, p] of [[ea, ta], [eb, tb]] as const) {
      const x = pg.nodes.find((q) => q.id === e.id) as Draft<VectorNode> | undefined;
      const q = x?.contours[e.ci]?.nodes[e.i];
      if (!x || !q) continue;
      const to = ap(mul(P.invert(nodeMat(x as unknown as SceneNode)), m), p);
      P.shift(q, [to[0] - q.anchor[0], to[1] - q.anchor[1]]);
    }
    if (d1 > 0 || d2 > 0) {
      const i = pg.nodes.findIndex((q) => q.id === ea.id);
      const src = pg.nodes[i] as Draft<VectorNode>;
      const n = JSON.parse(JSON.stringify(src)) as VectorNode;
      n.id = uid();
      n.name = t("cadui.ent.line");
      n.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
      const a = ap(m, ta), b = ap(m, tb);
      n.contours = [{ closed: false, nodes: [a, b].map((p) => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true })) }];
      pg.nodes.splice(i + 1, 0, n as any);
    }
  });
  return true;
}

function* CHAMFER(): Cmd {
  for (;;) {
    say(t("cadfeat.msg.chamNow", { a: fmt(cham.d1), b: fmt(cham.d2) }));
    const a = yield { k: "pick", prompt: "chamFirst", opts: ["distance"] };
    if (a.k === "opt" && a.key === "distance") {
      const r1 = yield* P.point({ prompt: "chamD1", number: true, def: fmt(cham.d1) });
      if (r1.k === "number" && r1.v >= 0) cham = { d1: r1.v, d2: r1.v };
      const r2 = yield* P.point({ prompt: "chamD2", number: true, def: fmt(cham.d1) });
      if (r2.k === "number" && r2.v >= 0) cham.d2 = r2.v;
      continue;
    }
    if (a.k !== "pick") return;
    const b = yield { k: "pick", prompt: "chamSecond" };
    if (b.k !== "pick") return;
    if (!chamferAt(a.id, a.p, b.id, b.p, cham.d1, cham.d2)) say(t("cadfeat.msg.cannotChamfer"));
    return;
  }
}

// ───────── BREAK ─────────

/** Contour parameter (segment index + t) of the point of contour ci nearest p. */
function paramOn(segs: Seg[], p: W): number {
  let best = segs[0], bd = Infinity, bt = 0;
  for (const s of segs) {
    const q = nearest(s, p);
    if (q.d < bd) (bd = q.d), (best = s), (bt = q.t);
  }
  return best.si + bt;
}
/** Open pieces split at parameter t (BREAKATPOINT). */
function splitAt(segs: Seg[], tp: number): Seg[][] {
  const k = Math.min(segs.length - 1, Math.floor(tp)), f = tp - k;
  const a = segs.filter((s) => s.si < k), b = segs.filter((s) => s.si > k);
  const s = segs.find((x) => x.si === k)!;
  if (f > 1e-9) a.push(segPart(s, 0, f));
  if (f < 1 - 1e-9) b.unshift(segPart(s, f, 1));
  return [a, b].filter((x) => x.length);
}

/** BREAK an object between two points (the same point: split it there). Circles lose the part counterclockwise from 1 to 2. */
export function breakAt(id: string, p1: W, p2: W): boolean {
  const page = currentPage(), cad = cadNow(), n = P.nodeOf(id);
  if (!page || !cad || n?.type !== "VECTOR" || n.locked) return false;
  const all = nodeSegs(n, cad);
  if (!all.length) return false;
  const ci = all.reduce((b, s) => (nearest(s, p1).d < nearest(b, p1).d ? s : b), all[0]).ci;
  const segs = all.filter((s) => s.ci === ci);
  const closed = n.contours[ci].closed;
  const t1 = paramOn(segs, p1), t2 = paramOn(segs, p2);
  let pieces: Seg[][] | null;
  if (Math.abs(t1 - t2) < 1e-9) {
    if (closed) return false;
    pieces = splitAt(segs, t1);
  } else if (closed) {
    const N = segs.length;
    const pts = segs.map((s) => s.a);
    let sa = 0;
    for (let i = 0; i < pts.length; i++) sa += pts[i][0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * pts[i][1];
    // contour parameters running counterclockwise in the drawing: the part from 1 to 2 goes; else the other way round
    const [from, to] = sa > 0 ? [t1, t2] : [t2, t1];
    const mid = (from < to ? (from + to) / 2 : ((from + to + N) / 2) % N);
    pieces = trimContour(segs, true, [t1, t2], mid);
  } else pieces = trimContour(segs, false, [t1, t2], (t1 + t2) / 2);
  if (!pieces?.length) return false;
  const m = wToPage(cad);
  S().commit(t("cadui.cmd.BREAK"), (d) => {
    const pg = draftPage(d, page.id);
    const i = pg?.nodes.findIndex((q) => q.id === id) ?? -1;
    if (!pg || i < 0) return;
    const x = pg.nodes[i] as Draft<VectorNode>;
    const L = P.invert(nodeMat(x as unknown as SceneNode));
    const local = (pc: Seg[]): Contour => {
      const c = segsToContour(pc, false, m);
      return { closed: false, nodes: c.nodes.map((q) => ({ ...q, anchor: ap(L, q.anchor), handleIn: ap(L, q.handleIn), handleOut: ap(L, q.handleOut) })) };
    };
    const keep = x.contours.filter((_, k) => k !== ci) as Contour[];
    const [first, ...rest] = pieces!;
    const extra = rest.map((pc) => {
      const c = JSON.parse(JSON.stringify(x)) as VectorNode;
      c.id = uid();
      c.contours = [local(pc)];
      return c;
    });
    x.contours = [...keep, local(first)] as any;
    pg.nodes.splice(i + 1, 0, ...(extra as any));
  });
  return true;
}

function* BREAK(): Cmd {
  const o = yield { k: "pick", prompt: "brPick" };
  if (o.k !== "pick") return;
  let p1 = o.p;
  let r = yield* P.point({ prompt: "brSecond", opts: ["first"], base: p1 });
  if (r.k === "opt" && r.key === "first") {
    const f = yield* P.point({ prompt: "brFirst" });
    if (f.k !== "point") return;
    p1 = f.p;
    r = yield* P.point({ prompt: "brSecond2", base: p1 });
  }
  if (r.k !== "point") return;
  if (!breakAt(o.id, p1, r.p)) say(t("cadfeat.msg.cannotBreak"));
}

// ───────── LENGTHEN ─────────

let lenMode: { k: "delta" | "percent" | "total"; v: number } = { k: "delta", v: 0 };
/** Change the length of a line / open polyline at the end nearest p (straight end segment). */
export function lengthenAt(id: string, p: W, mode = lenMode): boolean {
  const page = currentPage(), cad = cadNow(), n = P.nodeOf(id);
  if (!page || !cad || n?.type !== "VECTOR" || n.locked) return false;
  const ci = n.contours.findIndex((c) => !c.closed);
  if (ci < 0) return false;
  const segs = nodeSegs(n, cad).filter((s) => s.ci === ci);
  if (!segs.length) return false;
  const L = lengthOf(segs);
  const want = mode.k === "delta" ? L + mode.v : mode.k === "percent" ? (L * mode.v) / 100 : mode.v;
  const ch = want - L;
  const atStart = dist(p, segs[0].a) < dist(p, segs[segs.length - 1].b);
  const s = atStart ? segs[0] : segs[segs.length - 1];
  if (s.c1 || !(want > 0) || -ch >= dist(s.a, s.b)) return false;
  const dir = unit(atStart ? sub(s.a, s.b) : sub(s.b, s.a));
  const end = atStart ? s.a : s.b;
  const to: W = [end[0] + dir[0] * ch, end[1] + dir[1] * ch];
  S().commit(t("cadui.cmd.LENGTHEN"), (d) => {
    const x = draftPage(d, page.id)?.nodes.find((q) => q.id === id) as Draft<VectorNode> | undefined;
    const c = x?.contours[ci];
    if (!x || !c) return;
    const q = atStart ? c.nodes[0] : c.nodes[c.nodes.length - 1];
    const lp = ap(mul(P.invert(nodeMat(x as unknown as SceneNode)), wToPage(cad)), to);
    P.shift(q, [lp[0] - q.anchor[0], lp[1] - q.anchor[1]]);
  });
  return true;
}

function* LENGTHEN(): Cmd {
  for (;;) {
    const r = yield { k: "pick", prompt: "lenPick", opts: ["delta", "percent", "total"] };
    if (r.k === "pick") {
      const segs = P.segsOf(r.id);
      if (segs.length) say(t("cadfeat.msg.lenNow", { l: fmt(lengthOf(segs)) }));
      continue;
    }
    if (r.k !== "opt") return;
    const prompt = r.key === "delta" ? "lenDelta" : r.key === "percent" ? "lenPercent" : "lenTotal";
    const v = yield* P.point({ prompt, number: true, def: fmt(lenMode.k === r.key ? lenMode.v : r.key === "percent" ? 100 : 0) });
    if (v.k === "number") lenMode = { k: r.key as typeof lenMode.k, v: v.v };
    else if (v.k !== "enter") return;
    break;
  }
  for (;;) {
    const o = yield { k: "pick", prompt: "lenChange", opts: ["undo"] };
    if (o.k === "opt" && o.key === "undo") S().undo();
    else if (o.k === "pick") {
      if (!lengthenAt(o.id, o.p)) say(t("cadfeat.msg.cannotLengthen"));
    } else return;
  }
}

// ───────── ALIGN ─────────

export function alignMat(s1: W, d1: W, s2: W | null, d2: W | null, scale: boolean): Mat {
  let M = translate(d1[0] - s1[0], d1[1] - s1[1]);
  if (s2 && d2) {
    M = mul(rotateAbout(d1, angleOf(d1, d2) - angleOf(s1, s2)), M);
    if (scale && dist(s1, s2) > 0) M = mul(scaleAbout(d1, dist(d1, d2) / dist(s1, s2)), M);
  }
  return M;
}
function* ALIGN(): Cmd {
  const ids = yield* P.selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const s1 = yield* P.point({ prompt: "alSrc1" });
  if (s1.k !== "point") return P.finishSel();
  const d1 = yield* P.point({ prompt: "alDst1", base: s1.p, preview: (q) => [{ k: "line", a: s1.p, b: q }] });
  if (d1.k !== "point") return P.finishSel();
  const s2 = yield* P.point({ prompt: "alSrc2" });
  if (s2.k !== "point") {
    transformNodes(t("cadui.cmd.ALIGN"), ids, alignMat(s1.p, d1.p, null, null, false));
    return P.finishSel();
  }
  const d2 = yield* P.point({ prompt: "alDst2", base: s2.p, preview: (q) => [{ k: "line", a: s2.p, b: q }, { k: "ghost", ids, m: alignMat(s1.p, d1.p, s2.p, q, false) }] });
  if (d2.k !== "point") return P.finishSel();
  const y = yield { k: "key", prompt: "alScale", opts: ["yes", "no"], def: t("cadui.o.no") };
  transformNodes(t("cadui.cmd.ALIGN"), ids, alignMat(s1.p, d1.p, s2.p, d2.p, y.k === "opt" && y.key === "yes"));
  P.finishSel();
}

// ───────── ARRAY (type), ARRAYPOLAR, ARRAYPATH ─────────

/** Copies of the objects, one per matrix (drawing space), in one undo step. */
export function copyWith(label: string, ids: string[], mats: Mat[]): string[] {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad || !ids.length || !mats.length || mats.length > 10000) return [];
  const made: string[] = [];
  const fresh = new Map<string, string>();
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const set = new Set(textParts(page, ids));
    for (let i = pg.nodes.length - 1; i >= 0; i--) {
      const src = pg.nodes[i];
      if (!set.has(src.id)) continue;
      const copies = mats.map((mw, k) => {
        const n = JSON.parse(JSON.stringify(src)) as SceneNode;
        n.id = uid();
        P.regroupCopy(pg as Draft<Page>, n as Draft<SceneNode>, `a${k}`, fresh, mw);
        mapNode(n, mul(wToPage(cad), mul(mw, pageToW(cad))));
        made.push(n.id);
        return n;
      });
      pg.nodes.splice(i + 1, 0, ...(copies as any));
    }
  });
  return made;
}

let polarLast = { n: 6, fill: 360, rot: true };
function* ARRAYPOLAR(): Cmd {
  const ids = yield* P.selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const c = yield* P.point({ prompt: "apCenter" });
  if (c.k !== "point") return P.finishSel();
  const n = yield* P.point({ prompt: "apCount", number: true, def: String(polarLast.n) });
  if (n.k === "number" && n.v >= 2 && Number.isInteger(n.v)) polarLast.n = n.v;
  else if (n.k !== "enter") return P.finishSel();
  const f = yield* P.point({ prompt: "apFill", number: true, def: fmt(polarLast.fill) });
  if (f.k === "number" && f.v !== 0 && Math.abs(f.v) <= 360) polarLast.fill = f.v;
  else if (f.k !== "enter") return P.finishSel();
  const r = yield { k: "key", prompt: "apRotate", opts: ["yes", "no"], def: t(polarLast.rot ? "cadui.o.yes" : "cadui.o.no") };
  if (r.k === "opt") polarLast.rot = r.key === "yes";
  const N = polarLast.n, fill = (polarLast.fill * Math.PI) / 180;
  const step = Math.abs(polarLast.fill) >= 360 ? fill / N : fill / (N - 1);
  // items not rotated keep their direction: the selection's centre goes round
  const segs = ids.flatMap(P.segsOf);
  const b = segs.length ? P.bbox(segs) : [c.p[0], c.p[1], c.p[0], c.p[1]];
  const mid: W = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const mats: Mat[] = [];
  for (let i = 1; i < N; i++) {
    const R = rotateAbout(c.p, step * i);
    if (polarLast.rot) mats.push(R);
    else {
      const q = ap(R, mid);
      mats.push(translate(q[0] - mid[0], q[1] - mid[1]));
    }
  }
  const made = copyWith(t("cadui.cmd.ARRAYPOLAR"), ids, mats);
  hooksCad.onArray?.(ids, made, { kind: "polar", n: N, fill: polarLast.fill, c: [c.p[0], c.p[1]], rot: polarLast.rot });
  P.finishSel();
  say(t("cadui.msg.arrayed", { n: made.length }));
}

let pathLast = { n: 5, align: true };
function* ARRAYPATH(): Cmd {
  const ids = yield* P.selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const o = yield { k: "pick", prompt: "pathCurve" };
  if (o.k !== "pick") return P.finishSel();
  const segs = P.segsOf(o.id);
  if (!segs.length) return P.finishSel(), say(t("cadfeat.msg.notCurve"));
  const n = yield* P.point({ prompt: "pathCount", number: true, def: String(pathLast.n) });
  if (n.k === "number" && n.v >= 2 && Number.isInteger(n.v)) pathLast.n = n.v;
  else if (n.k !== "enter") return P.finishSel();
  const r = yield { k: "key", prompt: "pathAlign", opts: ["yes", "no"], def: t(pathLast.align ? "cadui.o.yes" : "cadui.o.no") };
  if (r.k === "opt") pathLast.align = r.key === "yes";
  const total = lengthOf(segs);
  const closed = (P.nodeOf(o.id) as VectorNode).contours.every((c) => c.closed);
  const N = pathLast.n;
  const at = Array.from({ length: N }, (_, i) => (total * i) / (closed ? N : N - 1));
  const pts = pointsAlong(segs, at);
  const p0 = pts[0];
  const mats = pts.slice(1).map((q) => {
    const M = translate(q.p[0] - p0.p[0], q.p[1] - p0.p[1]);
    return pathLast.align ? mul(rotateAbout(q.p, q.ang - p0.ang), M) : M;
  });
  const made = copyWith(t("cadui.cmd.ARRAYPATH"), ids, mats);
  hooksCad.onArray?.(ids, made, { kind: "path", path: o.id, n: N, rot: pathLast.align });
  P.finishSel();
  say(t("cadui.msg.arrayed", { n: made.length }));
}

function* ARRAY(): Cmd {
  const ids = yield* P.selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const r = yield { k: "key", prompt: "arType", opts: ["rect", "path", "polar"], def: t("cadui.o.rect") };
  const k = r.k === "opt" ? r.key : r.k === "enter" ? "rect" : null;
  if (!k) return P.finishSel();
  yield* COMMANDS[k === "rect" ? "ARRAYRECT" : k === "path" ? "ARRAYPATH" : "ARRAYPOLAR"]();
}

// ───────── MATCHPROP ─────────

export function matchProps(srcId: string, ids: string[]): number {
  const page = currentPage();
  const src = page?.nodes.find((n) => n.id === srcId);
  if (!page || !src) return 0;
  ids = textParts(page, ids).filter((i) => i !== srcId);
  if (!ids.length) return 0;
  moveToLayer(page, ids, nodeLayer(page, src));
  const col = nodeColor(src);
  const sv = src.type === "VECTOR" ? src : null;
  const run = src.type === "TEXT" ? src.paragraphs[0]?.runs[0] : null;
  S().commit(t("cadui.cmd.MATCHPROP"), (d) => {
    const pg = draftPage(d, page.id);
    const set = new Set(ids);
    for (const n of pg?.nodes ?? []) {
      if (!set.has(n.id) || n.locked) continue;
      if (n.type === "VECTOR") {
        if (col) {
          if (n.stroke) n.stroke = col;
          if (n.fill) n.fill = col;
        }
        if (sv && n.stroke) {
          n.strokeWidth = sv.stroke ? sv.strokeWidth : n.strokeWidth;
          if (sv.strokeDash?.length) n.strokeDash = [...sv.strokeDash];
          else delete n.strokeDash;
          if (sv.cadLt) n.cadLt = JSON.parse(JSON.stringify(sv.cadLt));
          else delete n.cadLt;
        }
      } else if (n.type === "TEXT") {
        for (const p of n.paragraphs)
          for (const r of p.runs) {
            if (col) r.color = col;
            if (run) (r.fontFamily = run.fontFamily), (r.fontSize = run.fontSize);
          }
      }
    }
  });
  return ids.length;
}

function* MATCHPROP(): Cmd {
  const s = yield { k: "pick", prompt: "maSource" };
  if (s.k !== "pick") return;
  say(t("cadfeat.msg.maProps"));
  S().set({ selection: [] });
  for (;;) {
    const o = yield { k: "pick", prompt: "maTarget", opts: ["undo"] };
    if (o.k === "opt" && o.key === "undo") S().undo();
    else if (o.k === "pick") matchProps(s.id, [o.id]);
    else return;
  }
}

// ───────── LIST ─────────

export function listLines(ids: string[]): string[] {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return [];
  const out: string[] = [];
  for (const n of page.nodes.filter((x) => ids.includes(x.id))) {
    const head = `${n.type === "TEXT" ? t("cadui.ent.text") : n.name}  ${t("cadfeat.list.layer")}: "${nodeLayer(page, n) || "0"}"  ${t("cadfeat.list.color")}: ${nodeColor(n) ?? "BYLAYER"}`;
    out.push(head);
    if (n.type === "TEXT") {
      const o = ap(pageToW(cad), [n.transform.x, n.transform.y]);
      out.push(`  ${t("cadfeat.list.text")}: ${n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join(" / ").slice(0, 120)}`);
      out.push(`  ${t("cadfeat.list.at")}: X=${fmt(o[0])} Y=${fmt(o[1])}  ${t("cadfeat.list.height")}: ${fmt(((n.paragraphs[0]?.runs[0]?.fontSize ?? 0) * 0.72) / cad.k)}`);
      continue;
    }
    if (n.type !== "VECTOR") continue;
    if (n.cadHatch) {
      out.push(`  ${t("cadfeat.list.pattern")}: ${n.cadHatch.pattern}  ${t("cadfeat.list.scale")}: ${fmt(n.cadHatch.scale)}  ${t("cadfeat.list.angle")}: ${fmt(n.cadHatch.angle)}  ${t("cadui.props.area")}: ${fmt(hatchArea(n.cadHatch))}`);
      continue;
    }
    const segs = nodeSegs(n, cad);
    const arcs = segs.map(arcOf);
    if (segs.length === 1 && !segs[0].c1) {
      const s = segs[0];
      out.push(`  ${t("cadfeat.list.from")}: X=${fmt(s.a[0])} Y=${fmt(s.a[1])}   ${t("cadfeat.list.to")}: X=${fmt(s.b[0])} Y=${fmt(s.b[1])}`);
      out.push(`  ${t("cadui.props.length")} = ${fmt(dist(s.a, s.b))}, ${t("cadui.props.angle")} = ${fmt(deg(angleOf(s.a, s.b)), 2)}°, ΔX = ${fmt(s.b[0] - s.a[0])}, ΔY = ${fmt(s.b[1] - s.a[1])}`);
    } else if (segs.length && arcs.every((a) => a && dist(a.c, arcs[0]!.c) < a.r * 1e-3)) {
      const a = arcs[0]!;
      out.push(`  ${t("cadui.props.centerX")}: ${fmt(a.c[0])}  ${t("cadui.props.centerY")}: ${fmt(a.c[1])}  ${t("cadui.props.radius")}: ${fmt(a.r)}`);
      if (n.contours.every((c) => c.closed)) out.push(`  ${t("cadui.props.circumference")}: ${fmt(2 * Math.PI * a.r)}  ${t("cadui.props.area")}: ${fmt(Math.PI * a.r * a.r)}`);
      else out.push(`  ${t("cadui.props.length")}: ${fmt(lengthOf(segs))}`);
    } else {
      const closed = n.contours.every((c) => c.closed);
      const pts = segs.length ? [segs[0].a, ...segs.map((s) => s.b)] : [];
      out.push(`  ${t("cadfeat.list.vertices")}: ${pts.length - (closed ? 1 : 0)}  ${t("cadui.props.length")}: ${fmt(lengthOf(segs))}${closed ? `  ${t("cadui.props.area")}: ${fmt(polyArea(pts).area)}` : ""}`);
      for (const q of pts.slice(0, closed ? -1 : undefined).slice(0, 12)) out.push(`    X=${fmt(q[0])}  Y=${fmt(q[1])}`);
    }
  }
  return out;
}
function* LIST(): Cmd {
  const ids = yield* P.selectObjects();
  for (const l of listLines(ids)) say(l);
  useUiHist();
  P.finishSel();
}
const useUiHist = () => import("./state").then((m) => m.useCadUI.getState().set({ histOpen: true }));

// ───────── QSELECT, PROPERTIES ─────────

/** QSELECT / FILTER open the Quick Select box of the layer panel. */
export const useQs = create<{ open: boolean }>(() => ({ open: false }));
function* QSELECT(): Cmd {
  bridge.openLayers();
  useQs.setState({ open: true });
}
function* PROPERTIES(): Cmd {
  useUI.getState().set({ rightOpen: true, rightTab: "props" });
}

// ───────── layer tools ─────────

const topLayer = (page: Page, name: string) => layerGroupOf(page, name);
/** Set layers on / off, frozen, locked in one undo step (AutoCAD's layer tools). */
function layerEdit(label: string, f: (g: Draft<Page>["groups"] extends (infer G)[] | undefined ? G : never, pg: Draft<Page>) => void, which: (name: string) => boolean) {
  const page = currentPage();
  if (!page) return;
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const g of pg.groups ?? []) if (!g.parentId && g.cad?.layer && which(g.cad.layer)) f(g, pg);
  });
}
const setOn = (g: any, pg: Draft<Page>, on: boolean) => {
  if (g.cad.frozen) return;
  g.visible = on;
  for (const n of pg.nodes) if (n.cadLayer === g.cad.layer) n.visible = on;
};
const isoSaved = new Map<string, Record<string, boolean>>();

function* LAYISO(): Cmd {
  const ids = yield* P.selectObjects();
  const page = currentPage();
  if (!ids.length || !page) return;
  const keep = new Set(page.nodes.filter((n) => ids.includes(n.id)).map((n) => (nodeLayer(page, n) || "0").toUpperCase()));
  const before: Record<string, boolean> = {};
  for (const g of page.groups ?? []) if (!g.parentId && g.cad?.layer) before[g.cad.layer] = g.visible;
  isoSaved.set(page.id, before);
  layerEdit(t("cadui.cmd.LAYISO"), (g, pg) => setOn(g, pg, keep.has(g.cad!.layer!.toUpperCase())), () => true);
  const first = [...keep][0];
  const cur = page.groups?.find((g) => !g.parentId && g.cad?.layer?.toUpperCase() === first);
  if (cur?.cad?.layer) setCurrentLayer(cur.cad.layer, page);
  P.finishSel();
  say(t("cadfeat.msg.isolated", { n: keep.size }));
}
function* LAYUNISO(): Cmd {
  const page = currentPage();
  const saved = page && isoSaved.get(page.id);
  if (!page || !saved) return say(t("cadfeat.msg.noIso"));
  layerEdit(t("cadui.cmd.LAYUNISO"), (g, pg) => setOn(g, pg, saved[g.cad!.layer!]), (n) => n in saved);
  isoSaved.delete(page.id);
}
function* layerPick(cmd: string, f: (name: string) => void): Cmd {
  for (;;) {
    const o = yield { k: "pick", prompt: "layPick", vars: { cmd: t(`cadui.cmd.${cmd}`) }, opts: ["undo"] };
    if (o.k === "opt" && o.key === "undo") S().undo();
    else if (o.k === "pick") {
      const page = currentPage()!;
      const n = page.nodes.find((x) => x.id === o.id);
      const name = n ? nodeLayer(page, n) || "0" : "0";
      f(name);
      say(t("cadfeat.msg.layDone", { layer: name, what: t(`cadui.cmd.${cmd}`) }));
      if (cmd === "LAYMCUR") return;
    } else return;
  }
}
const one = (name: string) => (n: string) => n.toUpperCase() === name.toUpperCase();
const LAYOFF = () => layerPick("LAYOFF", (name) => {
  if (name.toUpperCase() === currentLayer().toUpperCase()) say(t("cadfeat.msg.offCurrent"));
  layerEdit(t("cadui.cmd.LAYOFF"), (g, pg) => setOn(g, pg, false), one(name));
});
const LAYFRZ = () => layerPick("LAYFRZ", (name) => {
  if (name.toUpperCase() === currentLayer().toUpperCase()) return say(t("cadlm.err.freezeCurrent"));
  layerEdit(t("cadui.cmd.LAYFRZ"), (g, pg) => {
    if (!g.visible) g.cad!.offWhileFrozen = true;
    g.cad!.frozen = true;
    g.visible = false;
    for (const n of pg.nodes) if (n.cadLayer === g.cad!.layer) n.visible = false;
  }, one(name));
});
const LAYLCK = () => layerPick("LAYLCK", (name) => layerEdit(t("cadui.cmd.LAYLCK"), (g, pg) => {
  g.locked = true;
  for (const n of pg.nodes) if (n.cadLayer === g.cad!.layer) n.locked = true;
}, one(name)));
const LAYULK = () => layerPick("LAYULK", (name) => layerEdit(t("cadui.cmd.LAYULK"), (g, pg) => {
  g.locked = false;
  for (const n of pg.nodes) if (n.cadLayer === g.cad!.layer) n.locked = false;
}, one(name)));
const LAYMCUR = () => layerPick("LAYMCUR", (name) => setCurrentLayer(name));
/** LAYERSTATE (LAS) on the command line: save, restore or list the named layer states the ribbon keeps. */
function* LAYERSTATE(): Cmd {
  const r = yield { k: "key", prompt: "lsWhat", opts: ["lsSave", "lsRestore", "lsList"] };
  if (r.k !== "opt") return;
  const names = Object.keys(currentPage()?.source?.cad?.layerStates ?? {});
  if (r.key === "lsList") return say(names.length ? names.join(", ") : t("cadfeat.msg.lsNone"));
  if (r.key === "lsRestore" && !names.length) return say(t("cadfeat.msg.lsNone"));
  const n = yield { k: "text", prompt: "lsName", def: r.key === "lsSave" ? t("cadui.ls.defaultName", { n: names.length + 1 }) : names[names.length - 1] };
  const name = n.k === "text" && n.s.trim() ? n.s.trim() : n.k === "enter" ? (r.key === "lsSave" ? t("cadui.ls.defaultName", { n: names.length + 1 }) : names[names.length - 1]) : "";
  if (!name) return;
  if (r.key === "lsSave") saveLayerState(name), say(t("cadfeat.msg.lsSaved", { name }));
  else if (names.includes(name)) restoreLayerState(name), say(t("cadfeat.msg.lsRestored", { name }));
  else say(t("cadfeat.msg.lsNone"));
}
function* LAYON(): Cmd {
  layerEdit(t("cadui.cmd.LAYON"), (g, pg) => setOn(g, pg, true), () => true);
  say(t("cadfeat.msg.allOn"));
}
function* LAYTHW(): Cmd {
  layerEdit(t("cadui.cmd.LAYTHW"), (g, pg) => {
    if (!g.cad!.frozen) return;
    delete g.cad!.frozen;
    g.visible = !g.cad!.offWhileFrozen;
    delete g.cad!.offWhileFrozen;
    for (const n of pg.nodes) if (n.cadLayer === g.cad!.layer) n.visible = g.visible;
  }, () => true);
  say(t("cadfeat.msg.allThawed"));
}

// ───────── PAN, REGEN, UNITS, PURGE ─────────

function* PAN(): Cmd {
  const a = yield* P.point({ prompt: "panBase" });
  if (a.k !== "point") return;
  const b = yield* P.point({ prompt: "panTo", base: a.p, preview: (q) => [{ k: "line", a: a.p, b: q, dash: true }] });
  if (b.k === "point") bridge.panBy(sub(b.p, a.p));
}
function* REGEN(): Cmd {
  // a layout's viewports are drawn again from the model
  regenViewports();
  bridge.redraw();
  say(t("cadfeat.msg.regen"));
}
const UNIT_LIST: { key: string; ins: number; sym: string; mm: number }[] = [
  { key: "uMm", ins: 4, sym: "mm", mm: 1 },
  { key: "uCm", ins: 5, sym: "cm", mm: 10 },
  { key: "uM", ins: 6, sym: "m", mm: 1000 },
  { key: "uIn", ins: 1, sym: "in", mm: 25.4 },
  { key: "uFt", ins: 2, sym: "ft", mm: 304.8 },
  { key: "uNone", ins: 0, sym: "", mm: 1 },
];
function* UNITS(): Cmd {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return;
  say(t("cadfeat.msg.units", { u: cad.unit || t("cadui.props.unitless"), ins: cad.insunits }));
  const r = yield { k: "key", prompt: "unWhat", opts: UNIT_LIST.map((u) => u.key) };
  if (r.k !== "opt") return;
  const u = UNIT_LIST.find((x) => x.key === r.key)!;
  // the drawing's numbers stay; what one unit means changes (AutoCAD UNITS insertion scale)
  S().commit(t("cadui.cmd.UNITS"), (d) => {
    const c = draftPage(d, page.id)?.source?.cad;
    if (c) Object.assign(c, { insunits: u.ins, unit: u.sym, mmPerUnit: u.mm });
  });
  say(t("cadfeat.msg.unitsSet", { u: u.sym || t("cadui.props.unitless") }));
}
function* PURGE(): Cmd {
  const page = currentPage();
  if (!page) return;
  const cur = currentLayer(page).toUpperCase();
  const used = new Set<string>();
  for (const n of page.nodes) {
    if (n.cadLayer) used.add(n.cadLayer.toUpperCase());
    let g = page.groups?.find((x) => x.id === n.groupId);
    for (let i = 0; g?.parentId && i < 64; i++) g = page.groups?.find((x) => x.id === g!.parentId);
    if (g?.cad?.layer) used.add(g.cad.layer.toUpperCase());
  }
  const gone = (page.groups ?? []).filter((g) => !g.parentId && g.cad?.layer && g.cad.layer !== "0" && g.cad.layer.toUpperCase() !== cur && !used.has(g.cad.layer.toUpperCase()));
  if (!gone.length) return say(t("cadfeat.msg.purgeNone"));
  const ids = new Set(gone.map((g) => g.id));
  S().commit(t("cadui.cmd.PURGE"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) pg.groups = pg.groups!.filter((g) => !ids.has(g.id) && !ids.has(g.parentId ?? "")) as any;
  });
  say(t("cadfeat.msg.purged", { n: gone.length, names: gone.map((g) => g.cad!.layer).join(", ").slice(0, 200) }));
}


// ───────── the drawing's clipboard (Ctrl+C / Ctrl+X / Ctrl+V; the OS clipboard is not touched) ─────────

let clip: { ids: string[]; nodes: SceneNode[]; groups: any[]; base: W; pageId: string } | null = null;
/** COPYCLIP / CUTCLIP: the objects kept with their lower-left corner as base point (AutoCAD). */
export function clipCopy(ids: string[], cut = false) {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad || !ids.length) return;
  ids = textParts(page, ids);
  const set = new Set(ids);
  const nodes = page.nodes.filter((n) => set.has(n.id));
  const segs = nodes.flatMap((n) => (n.type === "VECTOR" ? nodeSegs(n, cad) : []));
  const b = segs.length ? P.bbox(segs) : [0, 0, 0, 0];
  clip = { ids, nodes: JSON.parse(JSON.stringify(nodes)), groups: JSON.parse(JSON.stringify(page.groups ?? [])), base: [b[0], b[1]], pageId: page.id };
  if (cut) P.finishSel(), import("./engine").then((m) => m.eraseNodes(ids));
  say(t("cadfeat.msg.copied", { n: nodes.length }));
}
/** PASTECLIP: asks the insertion point (the copy follows the cursor). */
export function clipPaste() {
  if (!clip) return say(t("cadfeat.msg.clipEmpty"));
  void import("./engine").then((m) => m.run("PASTECLIP"));
}
function* PASTECLIP(): Cmd {
  const c = clip;
  const page = currentPage();
  if (!c || !page) return say(t("cadfeat.msg.clipEmpty"));
  // cut objects come back first (ids and groups as they were), then the paste copies them
  const live = c.ids.filter((id) => page.nodes.some((n) => n.id === id));
  const ghost = live.length ? live : [];
  const a = yield* P.point({ prompt: "insPoint", preview: (q) => (ghost.length ? [{ k: "ghost", ids: ghost, m: translate(q[0] - c.base[0], q[1] - c.base[1]) }] : []) });
  if (a.k !== "point") return;
  const d = translate(a.p[0] - c.base[0], a.p[1] - c.base[1]);
  if (live.length === c.ids.length) {
    const made = transformNodes(t("cadfeat.menu.paste"), c.ids, d, true);
    return say(t("cadfeat.msg.pasted", { n: made.length }));
  }
  const cad = cadNow()!;
  const Pm = mul(wToPage(cad), mul(d, pageToW(cad)));
  S().commit(t("cadfeat.menu.paste"), (dr) => {
    const pg = draftPage(dr, page.id);
    if (!pg) return;
    pg.groups ??= [];
    const have = new Set(pg.groups.map((g) => g.id));
    const need = new Set<string>();
    for (const n of c.nodes) for (let g = c.groups.find((x) => x.id === n.groupId); g && !need.has(g.id); g = c.groups.find((x) => x.id === g.parentId)) need.add(g.id);
    for (const g of c.groups) if (need.has(g.id) && !have.has(g.id)) pg.groups.push(JSON.parse(JSON.stringify(g)));
    for (const n of c.nodes) {
      const x = JSON.parse(JSON.stringify(n)) as SceneNode;
      mapNode(x, Pm);
      pg.nodes.push(x as any);
    }
  });
  say(t("cadfeat.msg.pasted", { n: c.nodes.length }));
}
export const EDIT = {
  PASTECLIP,
  STRETCH, PEDIT, CHAMFER, BREAK, LENGTHEN, ALIGN, ARRAY, ARRAYPOLAR, ARRAYPATH, MATCHPROP, LIST, QSELECT, FILTER: QSELECT, PROPERTIES,
  LAYERSTATE, LAYISO, LAYUNISO, LAYOFF, LAYON, LAYFRZ, LAYTHW, LAYLCK, LAYULK, LAYMCUR, PAN, REGEN, REDRAW: REGEN, UNITS, PURGE,
};
void topLayer;
