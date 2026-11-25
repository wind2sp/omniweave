// Drawing commands of the drawing screen beyond engine.ts (AutoCAD's Draw panel): ELLIPSE (EL), POLYGON (POL),
// SPLINE (SPL), XLINE (XL), RAY, POINT (PO), DIVIDE (DIV), MEASURE (ME), DONUT (DO), HATCH (H) / GRADIENT (GD) /
// HATCHEDIT (HE), MTEXT (MT, T), TEXTEDIT (ED) and STYLE (ST). Each asks the command line the way AutoCAD does.

import { currentPage, draftPage, useStore } from "../../core/store";
import { DEFAULT_RUN, newText, newVector, type CadHatch, type Contour, type Page, type SceneNode, type TextNode, type VectorAnchor, type VectorNode } from "../../core/types";
import { t } from "../../i18n";
import { bridge, currentLayer, insertNodes, layerGroupOf, lwPx, parts, say, textStyle, type Ans, type Cmd, type Req } from "./engine";
import { add, angleOf, arcAnchors, bez, circleContour, dist, fmt, mapAnchors, nodeSegs, polar, polyContour, sub, wToPage, type Seg, type W } from "./geom";
import { HATCH_NAMES, boundaryAt, boundarySources, interiorPoint, isGradient, loopsOf, placeHatch } from "./hatch";

const S = () => useStore.getState();
const P = parts;
const cadNow = () => currentPage()?.source?.cad;

/** The current layer's colour and lineweight (px). */
export function layerLook(page: Page = currentPage()!) {
  const g = layerGroupOf(page, currentLayer(page));
  return { color: g?.cad?.color ?? "#000000", lw: lwPx(g?.cad?.lw ?? 0.25), gid: g?.id };
}

/** A new vector on the current layer from contours in drawing coordinates (anchors). */
export function addShape(label: string, contours: { closed: boolean; nodes: VectorAnchor[] }[], name: string, o: { fill?: boolean; evenodd?: boolean; donut?: boolean } = {}): string | null {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return null;
  const m = wToPage(cad);
  const look = layerLook(page);
  const n = newVector(contours.map((c) => ({ closed: c.closed, nodes: mapAnchors(c.nodes, m) })), name);
  n.stroke = look.color;
  n.fill = o.fill ? look.color : null;
  n.fillRule = o.evenodd ? "evenodd" : "nonzero";
  n.strokeWidth = look.lw;
  if (o.donut) n.cadDonut = true;
  insertNodes(label, page.id, currentLayer(page), [n]);
  say(t("cadui.msg.made", { what: label }));
  return n.id;
}
const corner = (p: W): VectorAnchor => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true });

// ───────── ELLIPSE ─────────

/** An ellipse (centre, half axes u and v) as four Bézier quarters. */
export function ellipseAnchors(c: W, u: W, v: W): VectorAnchor[] {
  const k = 0.5522847498;
  const out: VectorAnchor[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const p: W = [c[0] + u[0] * Math.cos(a) + v[0] * Math.sin(a), c[1] + u[1] * Math.cos(a) + v[1] * Math.sin(a)];
    const d: W = [-u[0] * Math.sin(a) + v[0] * Math.cos(a), -u[1] * Math.sin(a) + v[1] * Math.cos(a)];
    out.push({ anchor: p, handleOut: [p[0] + d[0] * k, p[1] + d[1] * k], handleIn: [p[0] - d[0] * k, p[1] - d[1] * k], isCorner: false });
  }
  return out;
}

function* ELLIPSE(): Cmd {
  const a = yield* P.point({ prompt: "ellAxis", opts: ["center"] });
  let c: W, u: W;
  if (a.k === "opt" && a.key === "center") {
    const q = yield* P.point({ prompt: "ellCenter" });
    if (q.k !== "point") return;
    c = q.p;
    const e = yield* P.point({ prompt: "ellAxisEnd", base: c, preview: (x) => [{ k: "line", a: c, b: x }] });
    if (e.k !== "point") return;
    u = sub(e.p, c);
  } else {
    if (a.k !== "point") return;
    const p1 = a.p;
    const e = yield* P.point({ prompt: "ellAxisEnd2", base: p1, preview: (x) => [{ k: "line", a: p1, b: x }] });
    if (e.k !== "point") return;
    c = [(p1[0] + e.p[0]) / 2, (p1[1] + e.p[1]) / 2];
    u = sub(e.p, c);
  }
  const L = Math.hypot(u[0], u[1]);
  if (!(L > 0)) return;
  const nrm: W = [-u[1] / L, u[0] / L];
  const at = (x: W) => Math.abs((x[0] - c[0]) * nrm[0] + (x[1] - c[1]) * nrm[1]);
  const r = yield* P.point({ prompt: "ellOther", base: c, number: true, preview: (x) => [{ k: "poly", pts: sample(ellipseAnchors(c, u, [nrm[0] * at(x), nrm[1] * at(x)])), closed: true }] });
  const b = r.k === "number" ? r.v : r.k === "point" ? at(r.p) : 0;
  if (!(b > 0)) return;
  addShape(t("cadui.cmd.ELLIPSE"), [{ closed: true, nodes: ellipseAnchors(c, u, [nrm[0] * b, nrm[1] * b]) }], t("cadfeat.ent.ellipse"));
}
/** Points along closed anchors (previews). */
function sample(an: VectorAnchor[], closed = true): W[] {
  const out: W[] = [];
  const n = an.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const p = an[i], q = an[(i + 1) % n];
    const s: Seg = { a: p.anchor as W, b: q.anchor as W, c1: p.handleOut as W, c2: q.handleIn as W, id: "", ci: 0, si: 0 };
    for (let k = 0; k < 12; k++) out.push(bez(s, k / 12));
  }
  if (!closed && n) out.push(an[n - 1].anchor as W);
  return out;
}

// ───────── POLYGON ─────────

let polySides = 4;
let polyMode: "inscribed" | "circumscribed" = "inscribed";
function* POLYGON(): Cmd {
  for (;;) {
    const n = yield* P.point({ prompt: "polSides", number: true, def: String(polySides) });
    if (n.k === "number") {
      if (n.v >= 3 && n.v <= 1024 && Number.isInteger(n.v)) polySides = n.v;
      else {
        say(t("cadfeat.msg.sides"));
        continue;
      }
    } else if (n.k !== "enter") return;
    break;
  }
  const N = polySides;
  const a = yield* P.point({ prompt: "polCenter", opts: ["edge"] });
  const ring = (c: W, r: number, a0: number): W[] => Array.from({ length: N }, (_, i) => polar(c, r, a0 + (i * 2 * Math.PI) / N));
  if (a.k === "opt" && a.key === "edge") {
    const e1 = yield* P.point({ prompt: "polEdge1" });
    if (e1.k !== "point") return;
    const edge = (q: W): W[] => {
      // the polygon to the left of the edge e1 → q
      const L = dist(e1.p, q), r = L / (2 * Math.sin(Math.PI / N));
      const mid: W = [(e1.p[0] + q[0]) / 2, (e1.p[1] + q[1]) / 2];
      const ang = angleOf(e1.p, q);
      const c = polar(mid, r * Math.cos(Math.PI / N), ang + Math.PI / 2);
      return ring(c, r, angleOf(c, e1.p));
    };
    const e2 = yield* P.point({ prompt: "polEdge2", base: e1.p, preview: (q) => [{ k: "poly", pts: edge(q), closed: true }] });
    if (e2.k !== "point") return;
    addShape(t("cadui.cmd.POLYGON"), [{ closed: true, nodes: edge(e2.p).map(corner) }], t("cadfeat.ent.polygon"));
    return;
  }
  if (a.k !== "point") return;
  const c = a.p;
  const m = yield { k: "key", prompt: "polMode", opts: ["inscribed", "circumscribed"], def: t(`cadui.o.${polyMode}`) };
  if (m.k === "opt") polyMode = m.key as typeof polyMode;
  else if (m.k !== "enter") return;
  const make = (q: W | null, rv?: number): W[] => {
    const r0 = rv ?? dist(c, q!);
    const r = polyMode === "inscribed" ? r0 : r0 / Math.cos(Math.PI / N);
    // a typed radius: the bottom edge level (AutoCAD); a picked point: a corner (inscribed) or an edge middle there
    const a0 = q ? angleOf(c, q) + (polyMode === "inscribed" ? 0 : Math.PI / N) : -Math.PI / 2 + Math.PI / N;
    return ring(c, r, a0);
  };
  const r = yield* P.point({ prompt: "polRadius", base: c, number: true, preview: (q) => [{ k: "poly", pts: make(q), closed: true }] });
  const pts = r.k === "point" ? make(r.p) : r.k === "number" && r.v > 0 ? make(null, r.v) : null;
  if (pts) addShape(t("cadui.cmd.POLYGON"), [{ closed: true, nodes: pts.map(corner) }], t("cadfeat.ent.polygon"));
}

// ───────── SPLINE ─────────

/** A smooth curve through the points (Catmull-Rom as Bézier handles). */
export function splineAnchors(pts: W[], closed: boolean): VectorAnchor[] {
  const n = pts.length;
  return pts.map((p, i) => {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const next = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const d: W = [(next[0] - prev[0]) / 6, (next[1] - prev[1]) / 6];
    const end = !closed && (i === 0 || i === n - 1);
    const k = end ? 2 : 1;
    return { anchor: p, handleOut: [p[0] + d[0] * k, p[1] + d[1] * k], handleIn: [p[0] - d[0] * k, p[1] - d[1] * k], isCorner: false };
  });
}

function* SPLINE(): Cmd {
  const a = yield* P.point({ prompt: "splFirst" });
  if (a.k !== "point") return;
  const pts: W[] = [a.p];
  for (;;) {
    const from = pts[pts.length - 1];
    const r = yield* P.point({ prompt: "splNext", opts: pts.length >= 2 ? ["close", "undo"] : ["undo"], base: from, preview: (q) => [{ k: "poly", pts: sample(splineAnchors([...pts, q], false), false) }] });
    if (r.k === "point") pts.push(r.p);
    else if (r.k === "opt" && r.key === "undo") {
      if (pts.length > 1) pts.pop();
    } else {
      const closed = r.k === "opt" && r.key === "close";
      if (pts.length >= 2) addShape(t("cadui.cmd.SPLINE"), [{ closed, nodes: splineAnchors(pts, closed) }], t("cadfeat.ent.spline"));
      return;
    }
  }
}

// ───────── XLINE, RAY ─────────

/** "Infinite" length: far past the drawing (AutoCAD draws construction lines without end). */
function farLen(): number {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return 1e6;
  return Math.max(page.width, page.height) / cad.k * 50;
}
function* XLINE(ray = false): Cmd {
  const a = yield* P.point({ prompt: ray ? "rayStart" : "xlFirst", opts: ray ? [] : ["hor", "ver"] });
  let base: W | null = null;
  let fixed: number | null = null;
  if (a.k === "opt" && (a.key === "hor" || a.key === "ver")) fixed = a.key === "hor" ? 0 : Math.PI / 2;
  else if (a.k === "point") base = a.p;
  else return;
  const L = farLen();
  const shape = (p: W, ang: number) => (ray ? [p, polar(p, L, ang)] : [polar(p, -L, ang), polar(p, L, ang)]) as [W, W];
  for (;;) {
    const r = yield* P.point({ prompt: "xlThrough", base: base ?? undefined, preview: (q) => {
      const s = fixed !== null ? shape(q, fixed) : base && dist(base, q) > 0 ? shape(base, angleOf(base, q)) : null;
      return s ? [{ k: "line", a: s[0], b: s[1] }] : [];
    } });
    if (r.k !== "point") return;
    const s = fixed !== null ? shape(r.p, fixed) : base && dist(base, r.p) > 0 ? shape(base, angleOf(base, r.p)) : null;
    if (s) addShape(t(ray ? "cadui.cmd.RAY" : "cadui.cmd.XLINE"), [{ closed: false, nodes: s.map(corner) }], t(ray ? "cadfeat.ent.ray" : "cadfeat.ent.xline"));
  }
}

// ───────── POINT, DIVIDE, MEASURE ─────────

/** A point object: a small dot (AutoCAD PDMODE 0), a few screen pixels at the zoom it is made. */
function pointShape(p: W) {
  const cad = cadNow()!;
  const r = 1.5 / (S().view.zoom * cad.k);
  return { closed: true, nodes: arcAnchors(p, r, 0, Math.PI * 2).slice(0, -1) };
}
export function addPoints(pts: W[], label: string): string[] {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad || !pts.length) return [];
  const m = wToPage(cad);
  const look = layerLook(page);
  const nodes = pts.map((p) => {
    const n = newVector([((c) => ({ closed: true, nodes: mapAnchors(c.nodes, m) }))(pointShape(p))], t("cadfeat.ent.point"));
    n.fill = look.color;
    n.stroke = null;
    n.strokeWidth = 0;
    n.cadPoint = true;
    return n;
  });
  insertNodes(label, page.id, currentLayer(page), nodes);
  return nodes.map((n) => n.id);
}
function* POINT(): Cmd {
  for (;;) {
    const a = yield* P.point({ prompt: "poPoint" });
    if (a.k !== "point") return;
    addPoints([a.p], t("cadui.cmd.POINT"));
  }
}

/** Points along a node's segments at the given distances from its start. */
export function pointsAlong(segs: Seg[], at: number[]): { p: W; ang: number }[] {
  const pieces: { a: W; b: W; l0: number; l: number }[] = [];
  let tot = 0;
  for (const s of segs) {
    const n = s.c1 ? 32 : 1;
    let prev = s.a;
    for (let i = 1; i <= n; i++) {
      const q = s.c1 ? bez(s, i / n) : s.b;
      const l = dist(prev, q);
      if (l > 0) pieces.push({ a: prev, b: q, l0: tot, l });
      tot += l;
      prev = q;
    }
  }
  return at.map((d) => {
    const pc = pieces.find((x) => d <= x.l0 + x.l + 1e-9) ?? pieces[pieces.length - 1];
    const f = pc.l ? Math.max(0, Math.min(1, (d - pc.l0) / pc.l)) : 0;
    return { p: [pc.a[0] + (pc.b[0] - pc.a[0]) * f, pc.a[1] + (pc.b[1] - pc.a[1]) * f] as W, ang: angleOf(pc.a, pc.b) };
  });
}
export const lengthOf = (segs: Seg[]) => segs.reduce((s, x) => s + (x.c1 ? flatLen(x) : dist(x.a, x.b)), 0);
const flatLen = (s: Seg) => {
  let l = 0, prev = s.a;
  for (let i = 1; i <= 32; i++) {
    const q = bez(s, i / 32);
    l += dist(prev, q);
    prev = q;
  }
  return l;
};

function* DIVIDE(measure: boolean): Cmd {
  const o = yield { k: "pick", prompt: measure ? "meObject" : "divObject" };
  if (o.k !== "pick") return;
  const segs = P.segsOf(o.id);
  if (!segs.length) return say(t("cadfeat.msg.notCurve"));
  const total = lengthOf(segs);
  const closed = (P.nodeOf(o.id) as VectorNode).contours.every((c) => c.closed);
  for (;;) {
    const r = yield* P.point({ prompt: measure ? "meLength" : "divCount", number: true });
    if (r.k !== "number") return;
    const at: number[] = [];
    if (measure) {
      if (!(r.v > 0)) continue;
      // from the end nearest the pick, as AutoCAD measures
      const start = dist(segs[0].a, o.p) <= dist(segs[segs.length - 1].b, o.p);
      for (let d = r.v; d < total - 1e-9; d += r.v) at.push(start ? d : total - d);
    } else {
      if (!(r.v >= 2 && r.v <= 32767 && Number.isInteger(r.v))) {
        say(t("cadfeat.msg.divRange"));
        continue;
      }
      for (let i = 1; i < r.v; i++) at.push((total * i) / r.v);
      if (closed) at.push(0);
    }
    const ids = addPoints(pointsAlong(segs, at).map((x) => x.p), t(measure ? "cadui.cmd.MEASURE" : "cadui.cmd.DIVIDE"));
    say(t("cadfeat.msg.pointsMade", { n: ids.length }));
    return;
  }
}

// ───────── DONUT ─────────

let donut = { inner: 0.5, outer: 1 };
function* DONUT(): Cmd {
  const a = yield* P.point({ prompt: "doInner", number: true, def: fmt(donut.inner) });
  if (a.k === "number" && a.v >= 0) donut.inner = a.v;
  else if (a.k !== "enter") return;
  const b = yield* P.point({ prompt: "doOuter", number: true, def: fmt(donut.outer) });
  if (b.k === "number" && b.v > 0) donut.outer = b.v;
  else if (b.k !== "enter") return;
  for (;;) {
    const c = yield* P.point({ prompt: "doCenter", preview: (q) => [{ k: "circle", c: q, r: donut.outer / 2 }, ...(donut.inner > 0 ? [{ k: "circle" as const, c: q, r: donut.inner / 2 }] : [])] });
    if (c.k !== "point") return;
    const rings = [{ closed: true, nodes: arcAnchors(c.p, donut.outer / 2, 0, Math.PI * 2).slice(0, -1) }];
    if (donut.inner > 0) rings.push({ closed: true, nodes: arcAnchors(c.p, donut.inner / 2, 0, Math.PI * 2).slice(0, -1) });
    addShape(t("cadui.cmd.DONUT"), rings, t("cadfeat.ent.donut"), { fill: true, evenodd: true, donut: true });
  }
}

// ───────── HATCH, GRADIENT, HATCHEDIT ─────────

export const hatchSet = { pattern: "ANSI31", scale: 1, angle: 0, color2: "#ffffff" };

function* askPattern(): Generator<Req, boolean, Ans> {
  say(`${t("cadfeat.msg.patterns")}: ${HATCH_NAMES.join(", ")}`);
  const p = yield { k: "text", prompt: "hPattern", def: hatchSet.pattern };
  if (p.k === "enter") return true;
  if (p.k !== "text") return false;
  const name = p.s.trim().toUpperCase();
  const hit = HATCH_NAMES.find((x) => x === name) ?? (name === "S" ? "SOLID" : name === "G" ? "GRADIENT" : undefined);
  if (!hit) {
    say(t("cadfeat.msg.noPattern", { name }));
    return true;
  }
  hatchSet.pattern = hit;
  return true;
}
function* askNum(prompt: string, key: "scale" | "angle"): Generator<Req, boolean, Ans> {
  const r = yield* P.point({ prompt, number: true, def: fmt(hatchSet[key]) });
  if (r.k === "number" && (key === "angle" || r.v > 0)) hatchSet[key] = r.v;
  return r.k === "number" || r.k === "enter";
}

function* HATCH(gradient = false): Cmd {
  if (gradient && !/GRAD/.test(hatchSet.pattern)) hatchSet.pattern = "GRADIENT";
  if (!gradient && isGradient(hatchSet.pattern)) hatchSet.pattern = "ANSI31";
  const page = currentPage();
  if (!page) return;
  for (;;) {
    say(t("cadfeat.msg.hatchNow", { p: hatchSet.pattern, s: fmt(hatchSet.scale), a: fmt(hatchSet.angle) }));
    const r = yield* P.point({ prompt: "hPick", opts: ["selObjects", "hpattern", "hscale", "hangle"] });
    let loops: W[][] | null = null;
    if (r.k === "point") {
      loops = boundaryAt(r.p);
      if (!loops) {
        say(t("cadfeat.msg.noClosed"));
        continue;
      }
    } else if (r.k === "opt" && r.key === "selObjects") {
      const ids = yield* P.selectObjects();
      P.finishSel();
      loops = loopsOf(ids);
      if (!loops.length) {
        say(t("cadfeat.msg.noClosed"));
        continue;
      }
    } else if (r.k === "opt" && r.key === "hpattern") {
      if (!(yield* askPattern())) return;
      continue;
    } else if (r.k === "opt" && r.key === "hscale") {
      if (!(yield* askNum("hScale", "scale"))) return;
      continue;
    } else if (r.k === "opt" && r.key === "hangle") {
      if (!(yield* askNum("hAngle", "angle"))) return;
      continue;
    } else return;
    const look = layerLook(currentPage()!);
    const h: CadHatch = { pattern: hatchSet.pattern, scale: hatchSet.scale, angle: hatchSet.angle, loops: loops.map((l) => l.map((q) => [q[0], q[1]] as [number, number])) };
    // associative (AutoCAD HPASSOC): the hatch keeps its internal point and boundary objects and follows them
    if (r.k === "point") (h.seed = [r.p[0], r.p[1]]), (h.src = boundarySources(loops));
    // by object selection: the objects themselves, and a point inside the outer loop
    else {
      h.src = boundarySources(loops);
      h.sel = true;
      const s = interiorPoint(loops[0]);
      if (s) h.seed = s;
    }
    if (isGradient(h.pattern)) (h.color1 = look.color), (h.color2 = hatchSet.color2);
    const ids = placeHatch(t(gradient ? "cadui.cmd.GRADIENT" : "cadui.cmd.HATCH"), h, look.color, lwPx(0.13), look.gid);
    if (ids.length) say(t("cadui.msg.made", { what: t("cadfeat.ent.hatch") }));
  }
}

/** The hatch a node belongs to: its own definition, or the bands of a gradient. */
export function hatchOf(page: Page, id: string): { h: CadHatch; ids: string[]; color: string } | null {
  const n = page.nodes.find((x) => x.id === id);
  if (n?.type !== "VECTOR" || !n.cadHatch) return null;
  const g = page.groups?.find((x) => x.id === n.groupId);
  const ids = g?.cad?.text ? page.nodes.filter((x) => x.groupId === g.id).map((x) => x.id) : [n.id];
  const first = page.nodes.find((x) => x.id === ids[0]) as VectorNode;
  const color = isGradient(n.cadHatch.pattern) ? first.fill ?? "#000000" : n.fill ?? n.stroke ?? "#000000";
  return { h: n.cadHatch, ids, color };
}

/** Change a hatch's pattern / scale / angle (HATCHEDIT, the properties palette). */
export function editHatch(id: string, change: Partial<Pick<CadHatch, "pattern" | "scale" | "angle" | "color2">>): string[] {
  const page = currentPage();
  const x = page && hatchOf(page, id);
  if (!page || !x) return [];
  const h = { ...x.h, ...change };
  if (isGradient(h.pattern) && !h.color2) h.color2 = "#ffffff";
  const n = page.nodes.find((q) => q.id === x.ids[0]) as VectorNode;
  return placeHatch(t("cadui.cmd.HATCHEDIT"), h, x.color, n.strokeWidth || lwPx(0.13), n.groupId, x.ids);
}

function* HATCHEDIT(): Cmd {
  const pre = S().selection;
  let id = pre.find((i) => currentPage()?.nodes.some((n) => n.id === i && n.type === "VECTOR" && n.cadHatch));
  if (!id) {
    const o = yield { k: "pick", prompt: "heObject" };
    if (o.k !== "pick") return;
    id = o.id;
  }
  const page = currentPage()!;
  if (!hatchOf(page, id)) return say(t("cadfeat.msg.notHatch"));
  for (;;) {
    const x = hatchOf(currentPage()!, id);
    if (!x) return;
    say(t("cadfeat.msg.hatchNow", { p: x.h.pattern, s: fmt(x.h.scale), a: fmt(x.h.angle) }));
    const r = yield { k: "key", prompt: "heWhat", opts: ["hpattern", "hscale", "hangle"] };
    const keep = { ...hatchSet };
    Object.assign(hatchSet, { pattern: x.h.pattern, scale: x.h.scale, angle: x.h.angle });
    let ok = true;
    if (r.k === "opt" && r.key === "hpattern") ok = yield* askPattern();
    else if (r.k === "opt" && r.key === "hscale") ok = yield* askNum("hScale", "scale");
    else if (r.k === "opt" && r.key === "hangle") ok = yield* askNum("hAngle", "angle");
    else {
      Object.assign(hatchSet, keep);
      return;
    }
    const made = editHatch(id, { pattern: hatchSet.pattern, scale: hatchSet.scale, angle: hatchSet.angle });
    Object.assign(hatchSet, keep);
    if (made.length) id = made[0];
    if (!ok) return;
  }
}

// ───────── MTEXT, TEXTEDIT, STYLE ─────────

/** Make a text on the current layer at drawing point `at` (top-left), `width` drawing units wide (0 = one line). */
export function makeText(label: string, s: string, at: W, height: number, width: number, rot = 0): string | null {
  const page = currentPage(), cad = cadNow();
  if (!page || !cad) return null;
  const look = layerLook(page);
  const hpx = height * cad.k;
  const n = newText(s, width > 0 ? width * cad.k : Math.max(hpx * 2, s.length * hpx * 0.9), { ...DEFAULT_RUN, fontFamily: textStyle.font || DEFAULT_RUN.fontFamily, fontSize: hpx / 0.72, color: look.color, ...(textStyle.wf !== 1 ? { hscale: textStyle.wf * 100 } : {}) });
  for (const p of n.paragraphs) (p.lineSpacing = 1.4), (p.spaceAfter = 0);
  const q = wToPage(cad);
  const pp: W = [q[0] * at[0] + q[2] * at[1] + q[4], q[1] * at[0] + q[3] * at[1] + q[5]];
  n.transform = { x: pp[0], y: pp[1], rotation: -rot, scale: 1 };
  n.name = (s || t("cadfeat.ent.mtext")).slice(0, 40);
  insertNodes(label, page.id, currentLayer(page), [n]);
  return n.id;
}

function* MTEXT(): Cmd {
  const a = yield* P.point({ prompt: "mtFirst", vars: { h: fmt(textStyle.height || 2.5) } });
  if (a.k !== "point") return;
  const p = a.p;
  const b = yield* P.point({ prompt: "mtOpposite", base: p, opts: ["height"], preview: (q) => [{ k: "poly", pts: [p, [q[0], p[1]], q, [p[0], q[1]]], closed: true }] });
  let other: W | null = b.k === "point" ? b.p : null;
  if (b.k === "opt" && b.key === "height") {
    const h = yield* P.point({ prompt: "textHeight", number: true, def: fmt(textStyle.height || 2.5), base: p });
    if (h.k === "number" && h.v > 0) textStyle.height = h.v;
    const c = yield* P.point({ prompt: "mtOpposite", base: p, preview: (q) => [{ k: "poly", pts: [p, [q[0], p[1]], q, [p[0], q[1]]], closed: true }] });
    other = c.k === "point" ? c.p : null;
  }
  if (!other) return;
  const top: W = [Math.min(p[0], other[0]), Math.max(p[1], other[1])];
  const width = Math.abs(other[0] - p[0]);
  // the text is typed in place (AutoCAD's in-place text editor); the command line takes it where there is no canvas
  const id = makeText(t("cadui.cmd.MTEXT"), "", top, textStyle.height || 2.5, width);
  if (!id) return;
  if (bridge.editText(id)) return;
  const s = yield { k: "text", prompt: "textString" };
  const page = currentPage()!;
  if (s.k !== "text" || !s.s) return void S().commit(t("cadui.cmd.MTEXT"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) pg.nodes = pg.nodes.filter((x) => x.id !== id) as any;
  });
  setTextString(id, s.s.replace(/\\P/g, "\n"));
}

/** Replace a text's contents (keeping its first run's look). */
export function setTextString(id: string, s: string) {
  const page = currentPage();
  if (!page) return;
  S().commit(t("cadui.cmd.TEXTEDIT"), (d) => {
    const n = draftPage(d, page.id)?.nodes.find((x) => x.id === id) as TextNode | undefined;
    if (n?.type !== "TEXT") return;
    const p0 = n.paragraphs[0];
    const run = { ...(p0?.runs[0] ?? DEFAULT_RUN) };
    n.paragraphs = s.split("\n").map((line, i) => ({ ...JSON.parse(JSON.stringify(p0)), id: i ? `${p0.id}-${i}` : p0.id, runs: [{ ...run, text: line }] }));
    n.name = s.slice(0, 40);
  });
}

function* TEXTEDIT(): Cmd {
  for (;;) {
    const o = yield { k: "pick", prompt: "edPick", opts: ["undo"] };
    if (o.k === "opt" && o.key === "undo") {
      S().undo();
      continue;
    }
    if (o.k !== "pick") return;
    const n = P.nodeOf(o.id);
    if (n?.type !== "TEXT") {
      say(t("cadfeat.msg.notText"));
      continue;
    }
    if (bridge.editText(n.id)) return;
    const cur = n.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\\P");
    const s = yield { k: "text", prompt: "edNew", def: cur };
    if (s.k === "text" && s.s) setTextString(n.id, s.s.replace(/\\P/g, "\n"));
  }
}

function* STYLE(): Cmd {
  for (;;) {
    say(t("cadfeat.msg.styleNow", { f: textStyle.font || DEFAULT_RUN.fontFamily, h: fmt(textStyle.height), w: fmt(textStyle.wf) }));
    const r = yield { k: "key", prompt: "stWhat", opts: ["font", "height", "wfactor"] };
    if (r.k !== "opt") return;
    if (r.key === "font") {
      const f = yield { k: "text", prompt: "stFont", def: textStyle.font || DEFAULT_RUN.fontFamily };
      if (f.k === "text" && f.s.trim()) textStyle.font = f.s.trim();
    } else if (r.key === "height") {
      const h = yield* P.point({ prompt: "stHeight", number: true, def: fmt(textStyle.height) });
      if (h.k === "number" && h.v >= 0) textStyle.height = h.v;
    } else {
      const w = yield* P.point({ prompt: "stWidth", number: true, def: fmt(textStyle.wf) });
      if (w.k === "number" && w.v > 0) textStyle.wf = w.v;
    }
  }
}

export const DRAW = {
  ELLIPSE, POLYGON, SPLINE, XLINE: () => XLINE(false), RAY: () => XLINE(true), POINT, DIVIDE: () => DIVIDE(false), MEASURE: () => DIVIDE(true), DONUT,
  HATCH: () => HATCH(false), GRADIENT: () => HATCH(true), HATCHEDIT, MTEXT, TEXTEDIT, STYLE,
};
void circleContour;
void polyContour;
void add;
void nodeSegs;
export type { Contour, SceneNode };
