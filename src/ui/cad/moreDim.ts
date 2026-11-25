// Dimensions and leaders of the drawing screen (AutoCAD's Annotate panel): DIMLINEAR (DLI) / DIMALIGNED (DAL) made
// as one object each (an anonymous block *D, picked whole like AutoCAD's dimension), DIMCONTINUE (DCO), DIMBASELINE
// (DBA), DIMANGULAR (DAN), DIMRADIUS (DRA), DIMDIAMETER (DDI), MLEADER (MLD) / QLEADER (LE) and DIMSTYLE (D): text
// height, arrow size, precision and overall scale (DIMTXT, DIMASZ, DIMDEC, DIMSCALE).

import { produce } from "immer";
import { currentPage, draftPage, useStore } from "../../core/store";
import { groupDescendants } from "../../core/layerTree";
import { DEFAULT_RUN, newText, newVector, uid, type SceneNode } from "../../core/types";
import { t } from "../../i18n";
import { currentLayer, insertNodes, layerGroupOf, lwPx, parts, say, textStyle, type Cmd } from "./engine";
import { angleOf, ap, arcAnchors, arcOf, dist, fmt, mapAnchors, mul, nearest, nodeMat, pageToW, polar, polyContour, sub, wToPage, type W } from "./geom";

const S = () => useStore.getState();
const P = parts;
const cadNow = () => currentPage()?.source?.cad;

/** The dimension style (AutoCAD DIMSTYLE ISO-25): sizes in paper mm, times DIMSCALE (0 = the drawing's plot scale). */
export const dimStyle = { txt: 2.5, asz: 2.5, exo: 0.625, exe: 1.25, dec: 2, dli: 3.75, scale: 0 };
/** A paper size in drawing units. */
function size(mm: number): number {
  const cad = cadNow();
  const sc = dimStyle.scale || cad?.scale || 1;
  return mm * sc * (cad?.mmPerUnit ? 1 / cad.mmPerUnit : 1);
}
const unit = (v: W): W => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};
const add2 = (p: W, v: W, k: number): W => [p[0] + v[0] * k, p[1] + v[1] * k];
const dot = (a: W, b: W) => a[0] * b[0] + a[1] * b[1];

interface DimParts {
  lines: W[][];
  /** arc pieces: centre, radius, from, to (radians, counterclockwise) */
  arcs?: { c: W; r: number; a0: number; a1: number }[];
  heads: W[][];
  text: { s: string; at: W; ang: number };
}

/** Arrowhead with its tip at `tip`, pointing along unit `dir`. */
const head = (tip: W, dir: W): W[] => {
  const ar = size(dimStyle.asz);
  const back = add2(tip, dir, -ar);
  const nrm: W = [-dir[1], dir[0]];
  return [tip, add2(back, nrm, ar / 6), add2(back, nrm, -ar / 6)];
};

/** A dimension's nodes (lines, filled arrowheads, measurement) grouped as one object on the current layer. */
type DimMeta = NonNullable<NonNullable<import("../../core/types").LayerGroup["cad"]>["dim"]>;
/** A dimension's three nodes (lines and arcs, filled arrowheads, measurement) in page px. */
function dimNodes(d: DimParts, color: string, cad: NonNullable<ReturnType<typeof cadNow>>): SceneNode[] {
  const m = wToPage(cad);
  const lines = newVector([...d.lines.map((l) => polyContour(l, false, m)), ...(d.arcs ?? []).map((a) => ({ closed: false, nodes: mapAnchors(arcAnchors(a.c, a.r, a.a0, a.a1), m) }))], t("cadui.ent.dim"));
  lines.stroke = color;
  lines.fill = null;
  lines.strokeWidth = lwPx(0.18);
  const heads = newVector(d.heads.map((h) => polyContour(h, true, m)), t("cadui.ent.dim"));
  heads.fill = color;
  heads.stroke = null;
  heads.strokeWidth = 0;
  return [lines, heads, dimText(d.text.s, d.text.at, d.text.ang, color)];
}

export function placeDim(label: string, d: DimParts, name: string, dim?: DimMeta): string | null {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return null;
  const L = layerGroupOf(page, currentLayer(page));
  const color = L?.cad?.color ?? "#000000";
  const nodes = dimNodes(d, color, cad);
  if (!L) {
    insertNodes(label, page.id, currentLayer(page), nodes);
    return null;
  }
  const gid = uid("g");
  S().commit(label, (dr) => {
    const pg = draftPage(dr, page.id);
    if (!pg) return;
    pg.groups ??= [];
    pg.groups.push({ id: gid, name, parentId: L.id, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { block: "*D", ...(dim ? { dim } : {}) } } as any);
    for (const n of nodes) n.groupId = gid;
    const lay = groupDescendants(pg.groups as any, L.id);
    let at = -1;
    pg.nodes.forEach((x, i) => {
      if (x.groupId && lay.has(x.groupId)) at = i;
    });
    pg.nodes.splice(at < 0 ? pg.nodes.length : at + 1, 0, ...(nodes as any));
  });
  say(t("cadui.msg.made", { what: label }));
  return gid;
}

/** The measurement text centred at `at` (drawing), reading along `ang` (turned to read left to right). */
function dimText(s: string, at: W, ang: number, color: string) {
  const cad = cadNow()!;
  const hpx = size(dimStyle.txt) * cad.k;
  const tx = newText(s);
  Object.assign(tx.paragraphs[0].runs[0], { ...DEFAULT_RUN, text: s, fontSize: hpx / 0.72, color, ...(textStyle.font ? { fontFamily: textStyle.font } : {}) });
  tx.paragraphs[0].align = "CENTER";
  const read = Math.cos(ang) < -1e-9 ? ang + Math.PI : ang;
  // wide enough that a measurement never wraps (the box is centred, so extra room costs nothing)
  const w = (s.length + 2) * hpx * 1.1;
  tx.width = w;
  const mp = ap(wToPage(cad), at);
  const rad = -read;
  // the box's centre at the point (the text box is one line of 1.6 × the font size)
  const bh = (hpx / 0.72) * 1.6;
  tx.transform = { x: mp[0] - Math.cos(rad) * w / 2 + Math.sin(rad) * bh / 2, y: mp[1] - Math.sin(rad) * w / 2 - Math.cos(rad) * bh / 2, rotation: (rad * 180) / Math.PI, scale: 1 };
  tx.name = s;
  return tx;
}
const num = (v: number) => fmt(v, dimStyle.dec);

// ───────── linear ─────────

interface Lin {
  a: W;
  b: W;
  u: W;
  nrm: W;
  /** dimension line distance from a along nrm */
  off: number;
}
let lastDim: Lin | null = null;

/** The parts of a linear dimension between extension origins a and b, measured along u, its line `off` from a. */
function linear(l: Lin): DimParts & { pa: W; pb: W; len: number } {
  const { a, b, u, nrm, off } = l;
  const pa = add2(a, nrm, off);
  const pb = add2(b, nrm, off - dot(sub(b, a), nrm));
  const len = Math.abs(dot(sub(pb, pa), u));
  const dirAB = Math.sign(dot(sub(pb, pa), u)) || 1;
  const ext = (o: W, p: W): W[] => {
    const s = Math.sign(dot(sub(p, o), nrm)) || 1;
    return [add2(o, nrm, s * size(dimStyle.exo)), add2(p, nrm, s * size(dimStyle.exe))];
  };
  const ud: W = [u[0] * dirAB, u[1] * dirAB];
  const mid: W = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
  const side = Math.sign(off) || 1;
  return {
    lines: [ext(a, pa), ext(b, pb), [pa, pb]],
    heads: [head(pa, [-ud[0], -ud[1]]), head(pb, ud)],
    text: { s: num(len), at: add2(mid, nrm, side * size(dimStyle.txt) * 0.9), ang: Math.atan2(u[1], u[0]) },
    pa,
    pb,
    len,
  };
}
/** Horizontal or vertical (by where the line is dragged), or aligned with a → b. */
function linDir(a: W, b: W, q: W, aligned: boolean): Lin {
  let u: W;
  if (aligned) u = unit(sub(b, a));
  else {
    const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    const vert = Math.abs(q[0] - mx) > Math.abs(q[1] - my) && dy > 0 ? true : dx === 0;
    u = vert ? [0, 1] : [1, 0];
  }
  const nrm: W = [-u[1], u[0]];
  return { a, b, u, nrm, off: dot(sub(q, a), nrm) };
}
/** A linear dimension's DXF definition: ext origins 13 / 14, dimension line point 10 (by the second), text 11 — and, associative, the object points its origins sit on. */
const linMeta = (l: Lin, d: ReturnType<typeof linear>, type: number): DimMeta => {
  const assoc: NonNullable<DimMeta["assoc"]> = {};
  for (const [k, p] of [["13", l.a], ["14", l.b]] as const) {
    const at = anchorAt(p);
    if (at) assoc[k] = at;
  }
  return { type, p: { "10": d.pb, "11": d.text.at, "13": l.a, "14": l.b }, measure: d.len, angle: (Math.atan2(l.u[1], l.u[0]) * 180) / Math.PI, u: l.u, off: l.off, ...(Object.keys(assoc).length ? { assoc } : {}) };
};
/** The object anchor (end or vertex of a line / polyline) at drawing point p, if one is there. */
function anchorAt(p: W): { id: string; ci: number; i: number } | null {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return null;
  const tol = 1e-6 * Math.max(1, Math.hypot(p[0], p[1]));
  for (const n of page.nodes) {
    if (n.type !== "VECTOR" || n.cadHatch || !n.visible) continue;
    const M = mul(pageToW(cad), nodeMat(n));
    for (let ci = 0; ci < n.contours.length; ci++)
      for (let i = 0; i < n.contours[ci].nodes.length; i++) if (dist(ap(M, n.contours[ci].nodes[i].anchor), p) < tol) return { id: n.id, ci, i };
  }
  return null;
}

// ───────── associative dimensions: they follow the object points they measure ─────────

let following = false;
useStore.subscribe((s, prev) => {
  if (following || s.doc === prev.doc) return;
  const page = s.doc.pages.find((p) => p.id === s.pageId), old = prev.doc.pages.find((p) => p.id === s.pageId);
  const cad = page?.source?.cad;
  if (!page || !old || !cad || page.nodes === old.nodes) return;
  const before = new Map(old.nodes.map((n) => [n.id, n]));
  const now = new Map(page.nodes.map((n) => [n.id, n]));
  const jobs: { gid: string; dim: DimMeta; nodes: SceneNode[] }[] = [];
  for (const g of page.groups ?? []) {
    const dm = g.cad?.dim;
    if (!dm?.assoc || !dm.u || dm.off === undefined || (dm.type !== 0 && dm.type !== 1)) continue;
    const ids = Object.values(dm.assoc).map((x) => x.id);
    if (!ids.some((id) => before.get(id) !== now.get(id))) continue;
    const pt = (k: "13" | "14"): W => {
      const a = dm.assoc![k];
      const n = a && now.get(a.id);
      const q = n?.type === "VECTOR" ? n.contours[a!.ci]?.nodes[a!.i]?.anchor : undefined;
      return q && n ? ap(mul(pageToW(cad), nodeMat(n)), q) : (dm.p[k] as W);
    };
    const a = pt("13"), b = pt("14");
    const u: W = dm.type === 1 ? unit(sub(b, a)) : (dm.u as W);
    const nrm: W = [-u[1], u[0]];
    // the dimension line stays where it was, measured from the first origin as before
    const line0 = add2(dm.p["13"] as W, [-(dm.u as W)[1], (dm.u as W)[0]], dm.off);
    const l: Lin = { a, b, u, nrm, off: dot(sub(line0, a), nrm) };
    const d = linear(l);
    const color = (page.nodes.find((n) => n.groupId === g.id && n.type === "VECTOR") as any)?.stroke ?? "#000000";
    const fresh = (() => {
      const keep = currentPage;
      void keep;
      return dimNodes(d, color, cad);
    })();
    jobs.push({ gid: g.id, dim: { ...dm, p: { "10": d.pb, "11": d.text.at, "13": a, "14": b }, measure: d.len, u, off: l.off }, nodes: fresh });
  }
  if (!jobs.length) return;
  following = true;
  try {
    S().set({
      doc: produce(S().doc, (dr) => {
        const pg = dr.pages.find((p) => p.id === page.id);
        if (!pg) return;
        for (const j of jobs) {
          const g = pg.groups?.find((x) => x.id === j.gid);
          if (!g?.cad) continue;
          g.cad.dim = j.dim as any;
          const at = pg.nodes.findIndex((n) => n.groupId === j.gid);
          pg.nodes = pg.nodes.filter((n) => n.groupId !== j.gid) as any;
          for (const n of j.nodes) n.groupId = j.gid;
          pg.nodes.splice(at < 0 ? pg.nodes.length : at, 0, ...(j.nodes as any));
        }
      }),
    });
  } finally {
    following = false;
  }
});
const previewOf = (d: DimParts) => d.lines.map((l) => ({ k: "line" as const, a: l[0], b: l[1] }));

function* DIMLIN(aligned: boolean): Cmd {
  const a = yield* P.point({ prompt: "dimFirst" });
  if (a.k !== "point") return;
  const b = yield* P.point({ prompt: "dimSecond", base: a.p, preview: (q) => [{ k: "line", a: a.p, b: q, dash: true }] });
  if (b.k !== "point") return;
  const c = yield* P.point({ prompt: "dimLine", preview: (q) => previewOf(linear(linDir(a.p, b.p, q, aligned))) });
  if (c.k !== "point") return;
  const l = linDir(a.p, b.p, c.p, aligned);
  const d = linear(l);
  if (placeDim(t(aligned ? "cadui.cmd.DIMALIGNED" : "cadui.cmd.DIMLINEAR"), d, `${t("cadui.ent.dim")} ${d.text.s}`, linMeta(l, d, aligned ? 1 : 0))) lastDim = l;
}

function* DIMCHAIN(baseline: boolean): Cmd {
  if (!lastDim) return say(t("cadfeat.msg.noDim"));
  for (;;) {
    const L = lastDim!;
    const make = (q: W): Lin => {
      const a = baseline ? L.a : L.b;
      const line = add2(L.a, L.nrm, L.off);
      const side = Math.sign(L.off) || 1;
      const off = dot(sub(line, a), L.nrm) + (baseline ? side * size(dimStyle.dli) : 0);
      return { a, b: q, u: L.u, nrm: L.nrm, off };
    };
    const r = yield* P.point({ prompt: baseline ? "dbaNext" : "dcoNext", opts: ["undo"], preview: (q) => previewOf(linear(make(q))) });
    if (r.k === "opt" && r.key === "undo") {
      S().undo();
      continue;
    }
    if (r.k !== "point") return;
    const l = make(r.p);
    const d = linear(l);
    if (placeDim(t(baseline ? "cadui.cmd.DIMBASELINE" : "cadui.cmd.DIMCONTINUE"), d, `${t("cadui.ent.dim")} ${d.text.s}`, linMeta(l, d, 0))) lastDim = l;
  }
}

// ───────── radius, diameter ─────────

function* DIMRAD(diameter: boolean): Cmd {
  const o = yield { k: "pick", prompt: diameter ? "ddiPick" : "draPick" };
  if (o.k !== "pick") return;
  const segs = P.segsOf(o.id);
  const s = segs.length ? segs.reduce((b, x) => (nearest(x, o.p).d < nearest(b, o.p).d ? x : b), segs[0]) : null;
  const arc = s ? arcOf(s) : null;
  if (!arc) return say(t("cadfeat.msg.notArc"));
  const { c, r } = arc;
  const parts = (q: W): DimParts => {
    const u = unit(sub(q, c));
    const p1 = add2(c, u, r);
    const outside = dist(q, c) > r;
    const ang = Math.atan2(u[1], u[0]);
    const s = diameter ? `Ø${num(2 * r)}` : `R${num(r)}`;
    const tw = s.length * size(dimStyle.txt) * 0.75;
    if (diameter) {
      const p0 = add2(c, u, -r);
      const end = outside ? add2(q, u, tw) : p1;
      return { lines: [[p0, end]], heads: [head(p0, [-u[0], -u[1]]), head(p1, u)], text: { s, at: add2(outside ? add2(q, u, tw / 2) : c, [-u[1], u[0]], size(dimStyle.txt) * 0.9), ang } };
    }
    const from = outside ? p1 : c;
    const end = outside ? add2(q, u, tw) : p1;
    return { lines: [[from, end]], heads: [head(p1, outside ? [-u[0], -u[1]] : u)], text: { s, at: add2(outside ? add2(q, u, tw / 2) : add2(c, u, r / 2), [-u[1], u[0]], size(dimStyle.txt) * 0.9), ang } };
  };
  const q = yield* P.point({ prompt: "dimLine", base: c, preview: (x) => previewOf(parts(x)) });
  if (q.k !== "point") return;
  const d = parts(q.p);
  const u = unit(sub(q.p, c));
  const on = add2(c, u, r), opp = add2(c, u, -r);
  placeDim(t(diameter ? "cadui.cmd.DIMDIAMETER" : "cadui.cmd.DIMRADIUS"), d, `${t("cadui.ent.dim")} ${d.text.s}`, diameter ? { type: 3, p: { "10": opp, "15": on, "11": d.text.at }, measure: 2 * r } : { type: 4, p: { "10": c, "15": on, "11": d.text.at }, measure: r });
}

// ───────── angular ─────────

function* DIMANGULAR(): Cmd {
  const a = yield { k: "pick", prompt: "danFirst" };
  let X: W, d1: W, d2: W;
  if (a.k === "enter") {
    const v = yield* P.point({ prompt: "danVertex" });
    if (v.k !== "point") return;
    const p1 = yield* P.point({ prompt: "danP1", base: v.p });
    if (p1.k !== "point") return;
    const p2 = yield* P.point({ prompt: "danP2", base: v.p });
    if (p2.k !== "point") return;
    X = v.p;
    d1 = unit(sub(p1.p, X));
    d2 = unit(sub(p2.p, X));
  } else {
    if (a.k !== "pick") return;
    const b = yield { k: "pick", prompt: "danSecond" };
    if (b.k !== "pick") return;
    const sa = P.segsOf(a.id).reduce((x, y) => (nearest(y, a.p).d < nearest(x, a.p).d ? y : x));
    const sb = P.segsOf(b.id).reduce((x, y) => (nearest(y, b.p).d < nearest(x, b.p).d ? y : x));
    if (!sa || !sb || sa.c1 || sb.c1) return say(t("cadfeat.msg.notLines"));
    const da = sub(sa.b, sa.a), db = sub(sb.b, sb.a);
    const den = da[0] * db[1] - da[1] * db[0];
    if (Math.abs(den) < 1e-12) return say(t("cadfeat.msg.parallel"));
    const tt = ((sb.a[0] - sa.a[0]) * db[1] - (sb.a[1] - sa.a[1]) * db[0]) / den;
    X = [sa.a[0] + da[0] * tt, sa.a[1] + da[1] * tt];
    d1 = unit(sub(nearest(sa, a.p).p, X));
    d2 = unit(sub(nearest(sb, b.p).p, X));
    if (Math.hypot(...sub(nearest(sa, a.p).p, X)) < 1e-9) d1 = unit(da);
    if (Math.hypot(...sub(nearest(sb, b.p).p, X)) < 1e-9) d2 = unit(db);
  }
  const parts = (q: W): DimParts => {
    const R = Math.max(dist(q, X), 1e-9);
    const aq = angleOf(X, q);
    // the sector (of the four the two lines make) that holds the arc location
    const cands: [W, W][] = [[d1, d2], [[-d1[0], -d1[1]], d2], [d1, [-d2[0], -d2[1]]], [[-d1[0], -d1[1]], [-d2[0], -d2[1]]]];
    let a0 = 0, a1 = 0;
    for (const [u, v] of cands) {
      let s = Math.atan2(u[1], u[0]), e = Math.atan2(v[1], v[0]);
      if (e < s) e += 2 * Math.PI;
      if (e - s > Math.PI) [s, e] = [e, s + 2 * Math.PI];
      let x = aq;
      while (x < s) x += 2 * Math.PI;
      while (x > s + 2 * Math.PI) x -= 2 * Math.PI;
      if (x <= e) {
        a0 = s;
        a1 = e;
        break;
      }
    }
    const p0 = polar(X, R, a0), p1 = polar(X, R, a1);
    const tg0: W = [-Math.sin(a0), Math.cos(a0)], tg1: W = [-Math.sin(a1), Math.cos(a1)];
    const am = (a0 + a1) / 2;
    const deg = ((a1 - a0) * 180) / Math.PI;
    return {
      lines: [],
      arcs: [{ c: X, r: R, a0, a1 }],
      heads: [head(p0, [-tg0[0], -tg0[1]]), head(p1, tg1)],
      text: { s: `${fmt(deg, Math.max(0, dimStyle.dec - 2))}°`, at: polar(X, R + size(dimStyle.txt) * 0.9, am), ang: am - Math.PI / 2 },
    };
  };
  const q = yield* P.point({ prompt: "danArc", base: X, preview: (x) => {
    const d = parts(x);
    return [...previewOf(d), ...(d.arcs ?? []).map((a) => ({ k: "arc" as const, ...a }))];
  } });
  if (q.k !== "point") return;
  const d = parts(q.p);
  const arc0 = d.arcs![0];
  placeDim(t("cadui.cmd.DIMANGULAR"), d, `${t("cadui.ent.dim")} ${d.text.s}`, { type: 5, p: { "13": polar(X, arc0.r, arc0.a0), "14": polar(X, arc0.r, arc0.a1), "15": X, "10": q.p, "11": d.text.at }, measure: arc0.a1 - arc0.a0 });
}

// ───────── leader ─────────

let leaderText = "";
function* MLEADER(): Cmd {
  const a = yield* P.point({ prompt: "mldArrow" });
  if (a.k !== "point") return;
  const b = yield* P.point({ prompt: "mldLanding", base: a.p, preview: (q) => [{ k: "line", a: a.p, b: q }] });
  if (b.k !== "point") return;
  const s = yield { k: "text", prompt: "textString", def: leaderText || undefined };
  const text = s.k === "text" && s.s ? s.s : s.k === "enter" ? leaderText : "";
  if (!text) return;
  leaderText = text;
  const right = b.p[0] >= a.p[0];
  const land = size(dimStyle.asz) * 2;
  const e: W = [b.p[0] + (right ? land : -land), b.p[1]];
  const u = unit(sub(a.p, b.p));
  const tw = text.length * size(dimStyle.txt) * 0.75;
  const gap = size(dimStyle.txt) * 0.4;
  const at: W = [e[0] + (right ? 1 : -1) * (gap + tw / 2), e[1]];
  placeDim(t("cadui.cmd.MLEADER"), { lines: [[a.p, b.p, e]], heads: [head(a.p, u)], text: { s: text, at, ang: 0 } }, `${t("cadfeat.ent.leader")} ${text.slice(0, 30)}`);
}

// ───────── DIMSTYLE ─────────

function* DIMSTYLE(): Cmd {
  for (;;) {
    const cad = cadNow();
    say(t("cadfeat.msg.dimNow", { t: fmt(dimStyle.txt), a: fmt(dimStyle.asz), d: dimStyle.dec, s: dimStyle.scale ? fmt(dimStyle.scale) : `${t("cadfeat.msg.plotScale")} ${fmt(cad?.scale ?? 1)}` }));
    const r = yield { k: "key", prompt: "dsWhat", opts: ["dtxt", "dasz", "ddec", "dscale"] };
    if (r.k !== "opt") return;
    const key = r.key === "dtxt" ? "txt" : r.key === "dasz" ? "asz" : r.key === "ddec" ? "dec" : "scale";
    const v = yield* P.point({ prompt: `ds_${key}`, number: true, def: fmt(dimStyle[key]) });
    if (v.k !== "number" || v.v < 0 || (key === "dec" && (!Number.isInteger(v.v) || v.v > 8)) || ((key === "txt" || key === "asz") && v.v <= 0)) continue;
    dimStyle[key] = v.v;
  }
}

export const DIMS = {
  DIMLINEAR: () => DIMLIN(false), DIMALIGNED: () => DIMLIN(true), DIMCONTINUE: () => DIMCHAIN(false), DIMBASELINE: () => DIMCHAIN(true),
  DIMRADIUS: () => DIMRAD(false), DIMDIAMETER: () => DIMRAD(true), DIMANGULAR, MLEADER, QLEADER: MLEADER, DIMSTYLE,
};
