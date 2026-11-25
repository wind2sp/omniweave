// Layouts and viewports on the drawing screen (AutoCAD LAYOUT / MVIEW): a layout is a paper page of the same drawing
// (a tab beside 모형) measured in paper millimetres; a viewport shows the model on it at 1:N, clipped to its frame.
// The view is drawn from the model when it is made and again on REGEN (it is a picture of the model, kept with the
// layout so the layout plots at 1:1 with PLOT).

import { produce } from "immer";
import { currentPage, draftPage, useStore } from "../../core/store";
import { newPage, newVector, uid, type CadSourceMeta, type Contour, type LayerGroup, type Page, type SceneNode, type VectorNode } from "../../core/types";
import { t } from "../../i18n";
import { currentLayer, layerGroupOf, lwPx, mapNode, parts, say, type Cmd } from "./engine";
import { ap, bez, fmt, mul, nodeSegs, pageToW, polyContour, wToPage, type Mat, type W } from "./geom";
import { PAPERS } from "./plot";

const S = () => useStore.getState();
const PX_MM = 96 / 25.4;
type Vp = NonNullable<NonNullable<LayerGroup["cad"]>["vp"]>;

/** The model page of a drawing (the page of the same file without a layout name). */
export function modelOf(page: Page): Page | undefined {
  const a = page.source?.cad?.assetId;
  return S().doc.pages.find((p) => p.source?.cad?.assetId === a && !p.source?.cad?.layout);
}

/** LAYOUT New: a paper page (landscape `paper`) after the drawing's pages, with the drawing's layers. */
export function newLayout(name: string, paper = "A3"): Page | null {
  const page = currentPage();
  const model = page && modelOf(page);
  if (!model?.source?.cad) return null;
  const [a, b] = PAPERS[paper] ?? PAPERS.A3;
  const pw = Math.max(a, b), ph = Math.min(a, b);
  const pg = newPage("DESIGN", pw * PX_MM, ph * PX_MM, name);
  const cad: CadSourceMeta = { ...model.source.cad, layout: name, k: PX_MM, ox: 0, oy: ph, scale: 1, mmPerUnit: 1, insunits: 4, unit: "mm", blocks: {}, layerStates: undefined, groups: undefined };
  pg.source = { ...model.source, cad };
  pg.background = "#ffffff";
  pg.groups = (model.groups ?? []).filter((g) => !g.parentId && g.cad?.layer).map((g) => ({ ...JSON.parse(JSON.stringify(g)), id: uid("g") }));
  S().commit(t("cadui.cmd.LAYOUT"), (d) => {
    const at = d.pages.reduce((k, p, i) => (p.source?.cad?.assetId === cad.assetId ? i : k), d.pages.length - 1);
    d.pages.splice(at + 1, 0, pg as any);
  });
  S().set({ pageId: pg.id, selection: [] });
  return pg;
}

// ───────── clipping ─────────

/** A polyline clipped to a box: the pieces inside (Liang–Barsky per segment, pieces joined). */
function clipLine(pts: W[], box: [number, number, number, number]): W[][] {
  const out: W[][] = [];
  let cur: W[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [p, q] = [pts[i - 1], pts[i]];
    let t0 = 0, t1 = 1;
    const d: W = [q[0] - p[0], q[1] - p[1]];
    let ok = true;
    for (const [pp, qq] of [[-d[0], p[0] - box[0]], [d[0], box[2] - p[0]], [-d[1], p[1] - box[1]], [d[1], box[3] - p[1]]]) {
      if (pp === 0) {
        if (qq < 0) ok = false;
        continue;
      }
      const r = qq / pp;
      if (pp < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
    }
    if (!ok || t0 > t1) {
      if (cur.length > 1) out.push(cur);
      cur = [];
      continue;
    }
    const a: W = [p[0] + d[0] * t0, p[1] + d[1] * t0], b: W = [p[0] + d[0] * t1, p[1] + d[1] * t1];
    if (!cur.length || t0 > 0) {
      if (cur.length > 1) out.push(cur);
      cur = [a];
    }
    cur.push(b);
    if (t1 < 1) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}
/** A closed polygon clipped to a box (Sutherland–Hodgman). */
function clipPoly(pts: W[], box: [number, number, number, number]): W[] {
  let poly = pts;
  const edges: [(p: W) => boolean, (p: W, q: W) => W][] = [
    [(p) => p[0] >= box[0], (p, q) => [box[0], p[1] + ((q[1] - p[1]) * (box[0] - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= box[2], (p, q) => [box[2], p[1] + ((q[1] - p[1]) * (box[2] - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= box[1], (p, q) => [p[0] + ((q[0] - p[0]) * (box[1] - p[1])) / (q[1] - p[1]), box[1]]],
    [(p) => p[1] <= box[3], (p, q) => [p[0] + ((q[0] - p[0]) * (box[3] - p[1])) / (q[1] - p[1]), box[3]]],
  ];
  for (const [inside, cut] of edges) {
    const next: W[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      if (inside(q)) {
        if (!inside(p)) next.push(cut(p, q));
        next.push(q);
      } else if (inside(p)) next.push(cut(p, q));
    }
    poly = next;
    if (!poly.length) break;
  }
  return poly;
}

/** The viewport's picture of the model: its nodes mapped to the paper at 1:scale and clipped to the frame. */
export function viewportNodes(vp: Vp, model: Page, layout: Page): SceneNode[] {
  const mc = model.source!.cad!, lc = layout.source!.cad!;
  const k = 1 / vp.scale;
  const toPaper = (p: W): W => [vp.c[0] + (p[0] - vp.mc[0]) * k, vp.c[1] + (p[1] - vp.mc[1]) * k];
  const box: [number, number, number, number] = [vp.c[0] - vp.w / 2, vp.c[1] - vp.h / 2, vp.c[0] + vp.w / 2, vp.c[1] + vp.h / 2];
  const m = wToPage(lc);
  const out: SceneNode[] = [];
  const groupLayer = new Map((model.groups ?? []).map((g) => [g.id, g]));
  const layerName = (n: SceneNode) => {
    let g = groupLayer.get(n.groupId ?? "");
    for (let i = 0; g?.parentId && i < 64; i++) g = groupLayer.get(g.parentId);
    return n.cadLayer ?? g?.cad?.layer ?? "0";
  };
  for (const n of model.nodes) {
    if (!n.visible) continue;
    if (n.type === "VECTOR") {
      const contours: Contour[] = [];
      n.contours.forEach((c, ci) => {
        const pts: W[] = [];
        for (const s of nodeSegs(n, mc)) {
          if (s.ci !== ci) continue;
          const steps = s.c1 ? 12 : 1;
          for (let i = pts.length ? 1 : 0; i <= steps; i++) pts.push(toPaper(s.c1 ? bez(s, i / steps) : i ? s.b : s.a));
        }
        if (pts.length < 2) return;
        if (c.closed && n.fill) {
          const poly = clipPoly(pts, box);
          if (poly.length >= 3) contours.push(polyContour(poly, true, m));
        } else for (const piece of clipLine(c.closed ? [...pts, pts[0]] : pts, box)) contours.push(polyContour(piece, false, m));
      });
      if (!contours.length) continue;
      const v = JSON.parse(JSON.stringify(n)) as VectorNode;
      v.id = uid();
      v.contours = contours;
      v.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
      delete v.cadHatch;
      delete v.cadLt;
      v.cadLayer = layerName(n);
      out.push(v);
    } else if (n.type === "TEXT") {
      const o = ap(pageToW(mc), [n.transform.x, n.transform.y]);
      const q = toPaper(o);
      if (q[0] < box[0] || q[0] > box[2] || q[1] < box[1] || q[1] > box[3]) continue;
      const x = JSON.parse(JSON.stringify(n)) as SceneNode;
      x.id = uid();
      x.cadLayer = layerName(n);
      // model page px → drawing → paper → layout page px
      const P: Mat = mul(m, mul([k, 0, 0, k, vp.c[0] - vp.mc[0] * k, vp.c[1] - vp.mc[1] * k], pageToW(mc)));
      mapNode(x, P);
      out.push(x);
    }
  }
  // the frame (AutoCAD draws the viewport's edge on its layer)
  const f = newVector([polyContour([[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], true, m)], t("cadui.cmd.MVIEW"));
  f.fill = null;
  f.stroke = "#000000";
  f.strokeWidth = lwPx(0.25);
  out.push(f);
  return out;
}

/** MVIEW: a viewport on the current layout between two paper points, showing the model at 1:scale (0 = fit). */
export function makeViewport(a: W, b: W, scale = 0, mc?: W): string | null {
  const page = currentPage();
  const model = page && modelOf(page);
  if (!page?.source?.cad?.layout || !model?.source?.cad) return null;
  const w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (!(w > 0 && h > 0)) return null;
  const c: W = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // the model's extents (drawing units → mm on paper)
  const cad = model.source.cad;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of model.nodes) {
    if (!n.visible || n.type !== "VECTOR") continue;
    for (const s of nodeSegs(n, cad)) for (const p of [s.a, s.b]) (x0 = Math.min(x0, p[0])), (y0 = Math.min(y0, p[1])), (x1 = Math.max(x1, p[0])), (y1 = Math.max(y1, p[1]));
  }
  if (!(x1 > x0)) (x0 = 0), (y0 = 0), (x1 = 1), (y1 = 1);
  const mm = cad.mmPerUnit || 1;
  // drawing units per paper mm: 1:N means N drawing mm per paper mm
  const units = scale > 0 ? scale / mm : Math.max((x1 - x0) / (w * 0.95), (y1 - y0) / (h * 0.95));
  const vp: Vp = { model: model.id, c, w, h, mc: mc ?? [(x0 + x1) / 2, (y0 + y1) / 2], scale: units };
  const L = layerGroupOf(page, currentLayer(page));
  const gid = uid("g");
  const nodes = viewportNodes(vp, model, page);
  S().commit(t("cadui.cmd.MVIEW"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups ??= [];
    pg.groups.push({ id: gid, name: t("cadfeat.vp.name", { scale: fmt(units * mm, 2) }), parentId: L?.id ?? null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { block: `*VIEWPORT ${gid}`, vp } } as any);
    for (const n of nodes) n.groupId = gid;
    pg.nodes.push(...(nodes as any));
  });
  return gid;
}

/** REGEN on a layout: every viewport drawn again from the model as it is now. */
export function regenViewports(page: Page | undefined = currentPage()): number {
  if (!page?.source?.cad?.layout) return 0;
  const vps = (page.groups ?? []).filter((g) => g.cad?.vp);
  if (!vps.length) return 0;
  S().commit(t("cadui.cmd.REGEN"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const g of vps) {
      const model = S().doc.pages.find((p) => p.id === g.cad!.vp!.model);
      if (!model) continue;
      const at = pg.nodes.findIndex((n) => n.groupId === g.id);
      pg.nodes = pg.nodes.filter((n) => n.groupId !== g.id) as any;
      const fresh = viewportNodes(g.cad!.vp!, model, page);
      for (const n of fresh) n.groupId = g.id;
      pg.nodes.splice(at < 0 ? pg.nodes.length : at, 0, ...(fresh as any));
    }
  });
  return vps.length;
}

// ───────── viewports follow the model (no REGEN needed) ─────────

let pending = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Draw again, now, the viewports of every layout whose model changed (outside the undo history: undo of the model change brings them back the same way). */
export function flushViewports() {
  if (timer) clearTimeout(timer);
  timer = null;
  const models = pending;
  pending = new Set();
  if (!models.size) return;
  const doc0 = S().doc;
  const doc = produce(doc0, (d) => {
    for (const pg of d.pages) {
      if (!pg.source?.cad?.layout) continue;
      for (const g of pg.groups ?? []) {
        const vp = g.cad?.vp;
        if (!vp || !models.has(vp.model)) continue;
        const model = doc0.pages.find((p) => p.id === vp.model);
        const layout = doc0.pages.find((p) => p.id === pg.id);
        if (!model || !layout) continue;
        const at = pg.nodes.findIndex((n) => n.groupId === g.id);
        pg.nodes = pg.nodes.filter((n) => n.groupId !== g.id) as any;
        const fresh = viewportNodes(vp as Vp, model, layout);
        for (const n of fresh) n.groupId = g.id;
        pg.nodes.splice(at < 0 ? pg.nodes.length : at, 0, ...(fresh as any));
      }
    }
  });
  if (doc !== doc0) S().set({ doc });
}
useStore.subscribe((s, prev) => {
  if (s.doc === prev.doc) return;
  const before = new Map(prev.doc.pages.map((p) => [p.id, p]));
  const watched = new Set<string>();
  for (const p of s.doc.pages) for (const g of p.groups ?? []) if (g.cad?.vp) watched.add(g.cad.vp.model);
  if (!watched.size) return;
  for (const id of watched) {
    const now = s.doc.pages.find((p) => p.id === id);
    if (now && before.get(id) && before.get(id)!.nodes !== now.nodes) pending.add(id);
  }
  if (pending.size && !timer) timer = setTimeout(flushViewports, 250);
});

let layoutN = 1;
function* LAYOUT(): Cmd {
  const r = yield { k: "key", prompt: "loWhat", opts: ["loNew", "loList"], def: t("cadui.o.loNew") };
  if (r.k === "opt" && r.key === "loList") {
    const page = currentPage();
    const a = page?.source?.cad?.assetId;
    return say(S().doc.pages.filter((p) => p.source?.cad?.assetId === a).map((p) => p.source!.cad!.layout ?? t("cadui.model")).join(", "));
  }
  if (r.k !== "opt" && r.k !== "enter") return;
  const n = yield { k: "text", prompt: "loName", def: t("cadfeat.lo.default", { n: layoutN }) };
  const name = n.k === "text" && n.s.trim() ? n.s.trim() : t("cadfeat.lo.default", { n: layoutN });
  const p = yield { k: "text", prompt: "plPaper", vars: { list: Object.keys(PAPERS).join("/") }, def: "A3" };
  const paper = p.k === "text" && PAPERS[p.s.trim().toUpperCase()] ? p.s.trim().toUpperCase() : "A3";
  layoutN++;
  if (newLayout(name, paper)) say(t("cadfeat.msg.layoutMade", { name, paper }));
}

function* MVIEW(): Cmd {
  const page = currentPage();
  if (!page?.source?.cad?.layout) return say(t("cadfeat.msg.mviewModel"));
  const a = yield* parts.point({ prompt: "firstCorner" });
  if (a.k !== "point") return;
  const b = yield* parts.point({ prompt: "otherCorner", base: a.p, preview: (q) => [{ k: "poly", pts: [a.p, [q[0], a.p[1]], q, [a.p[0], q[1]]], closed: true }] });
  if (b.k !== "point") return;
  const s = yield* parts.point({ prompt: "plScale", opts: ["fitPaper"], number: true, def: t("cadui.o.fitPaper") });
  let scale = 0;
  if (s.k === "number" && s.v > 0) scale = s.v;
  else if (s.k === "text") {
    const m = /^\s*1\s*[:=]\s*([\d.]+)\s*$/.exec(s.s);
    if (m) scale = Number(m[1]);
  } else if (s.k !== "opt" && s.k !== "enter") return;
  if (makeViewport(a.p, b.p, scale)) say(t("cadfeat.msg.mviewMade"));
}

export const LAYOUTS = { LAYOUT, MVIEW };
