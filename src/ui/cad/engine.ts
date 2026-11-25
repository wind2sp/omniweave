// Command line of the drawing screen (docs/design/CAD_SCREEN.md): AutoCAD's command names and aliases (L, C, A, PL,
// REC, M, CO, RO, SC, MI, O, TR, EX, E, X, J, F, AR, Z, LA, DI, AA, DT, DLI, U…, and grip stretch) run as small coroutines that ask for points,
// objects, numbers or options; the canvas (ui/cad/view.ts), the command line box and the ribbon feed them answers.
// Everything they draw or change is an ordinary VECTOR / TEXT node on the drawing page, in the layer group of the
// current layer — so Omniweave's pen, anchor editing, undo history and export keep working on it.

import { create } from "zustand";
import { currentPage, draftPage, findPage, useStore } from "../../core/store";
import { groupDescendants } from "../../core/layerTree";
import { applyTransform } from "../../core/geom";
import { localBounds } from "../../core/loom";
import { DEFAULT_RUN, newPage, newText, newVector, uid, type CadSourceMeta, type Contour, type LayerGroup, type Page, type SceneNode, type VectorNode } from "../../core/types";
import type { Draft } from "immer";
import { t } from "../../i18n";
import {
  ap, arc3, arcAnchors, circleContour, constrain, dist, fmt, deg, angleOf, intersect, mapAnchors, mirrorLine, mul, nearest, nodeMat, nodeSegs,
  offsetPoly, pageToW, parseEntry, polar, polyArea, polyContour, rotateAbout, scaleAbout, segsToContour, sub, translate, trimContour, wToPage,
  arcOf, type Mat, type Seg, type W,
} from "./geom";

const S = () => useStore.getState();
const PX_MM = 96 / 25.4;

// ───────── requests and answers ─────────

export type Shape =
  | { k: "line"; a: W; b: W; dash?: boolean }
  | { k: "poly"; pts: W[]; closed?: boolean }
  | { k: "circle"; c: W; r: number }
  | { k: "arc"; c: W; r: number; a0: number; a1: number }
  | { k: "ghost"; ids: string[]; m: Mat };

export type Ans = { k: "point"; p: W } | { k: "number"; v: number } | { k: "opt"; key: string } | { k: "enter" } | { k: "text"; s: string } | { k: "sel"; ids: string[] } | { k: "pick"; id: string; p: W };

export interface Req {
  k: "point" | "select" | "pick" | "text" | "key";
  /** cadui.p.* prompt id */
  prompt: string;
  vars?: Record<string, string | number>;
  /** options in [ ] — ids of cadui.o.* (their letter is OPT_KEY) */
  opts?: string[];
  /** default shown in < > (Enter takes it) */
  def?: string;
  /** rubber band / ortho / direct distance base */
  base?: W;
  /** a number is a valid answer (radius, angle, distance, scale) */
  number?: boolean;
  preview?: (cursor: W) => Shape[];
}
export type Cmd = Generator<Req, void, Ans>;

/** Option letters as AutoCAD shows them: 닫기(C), 명령 취소(U)… */
export const OPT_KEY: Record<string, string> = {
  close: "C", undo: "U", arc: "A", line: "L", diameter: "D", p2: "2P", p3: "3P", center: "C", copy: "C", reference: "R", extents: "E",
  window: "W", all: "A", previous: "P", yes: "Y", no: "N", through: "T", displacement: "D", object: "O", erase: "E", angle: "A", end: "E", radius: "R",
};

// ───────── state ─────────

export interface CmdState {
  /** running command (canonical name) or null */
  name: string | null;
  req: Req | null;
  /** command line history (last lines first-in) */
  hist: string[];
  /** last command, for Enter / Space repeat */
  last: string | null;
  /** last point picked (the @ of relative entry) */
  lastPt: W | null;
  /** recent commands (right-click / list) */
  recent: string[];
  /** a line the canvas shows next to the cursor (dynamic input) */
  tick: number;
}
export const useCmd = create<CmdState>(() => ({ name: null, req: null, hist: [], last: null, lastPt: null, recent: [], tick: 0 }));

/** What the canvas lends the commands: the cursor, zooming and the current page's drawing meta. */
export const bridge: {
  cursor: () => W | null;
  zoomExtents: () => void;
  zoomWindow: (a: W, b: W) => void;
  zoomBy: (f: number) => void;
  zoomPrevious: () => void;
  zoomAll: () => void;
  ortho: () => boolean;
  polar: () => number | null;
  openLayers: () => void;
  /** move the view by a drawing displacement (PAN) */
  panBy: (d: W) => void;
  /** edit a text in place (MTEXT, TEXTEDIT, double click); false when there is no canvas editor */
  editText: (id: string) => boolean;
  /** the last window / crossing the canvas drew at "객체 선택" (STRETCH takes its corners) */
  lastWin: { a: W; b: W; crossing: boolean } | null;
  /** repaint (REGEN) */
  redraw: () => void;
} = { cursor: () => null, zoomExtents() {}, zoomWindow() {}, zoomBy() {}, zoomPrevious() {}, zoomAll() {}, ortho: () => false, polar: () => null, openLayers() {}, panBy() {}, editText: () => false, lastWin: null, redraw() {} };

/** The current text style (AutoCAD STYLE): font (empty = the default), fixed height (0 = asked), width factor. */
export const textStyle = { font: "", height: 0, wf: 1 };

export function say(line: string) {
  useCmd.setState((s) => ({ hist: [...s.hist.slice(-199), line] }));
}

// ───────── current layer ─────────

const clayers = new Map<string, string>();
/** the current layer's group: a rename (and its undo) keeps the same layer current */
const clayerGroups = new Map<string, string>();
/** The current layer of a drawing page (AutoCAD CLAYER): the one set, else "0", else the first layer. */
export function currentLayer(page: Page | undefined = currentPage()): string {
  if (!page) return "0";
  const set = clayers.get(page.id);
  const layers = (page.groups ?? []).filter((g) => g.cad?.layer && !g.parentId);
  if (set && layers.some((g) => g.cad!.layer === set)) return set;
  const byId = layers.find((g) => g.id === clayerGroups.get(page.id));
  if (set && byId) return byId.cad!.layer!;
  return layers.find((g) => g.cad!.layer === "0")?.cad?.layer ?? layers[0]?.cad?.layer ?? "0";
}
export const useClayer = create<{ v: number }>(() => ({ v: 0 }));
export function setCurrentLayer(name: string, page: Page | undefined = currentPage()) {
  if (!page) return;
  clayers.set(page.id, name);
  const g = layerGroupOf(page, name);
  if (g) clayerGroups.set(page.id, g.id);
  useClayer.setState((s) => ({ v: s.v + 1 }));
}
export const layerGroupOf = (page: Page, name: string): LayerGroup | undefined => page.groups?.find((g) => !g.parentId && g.cad?.layer?.toUpperCase() === name.toUpperCase());

// ───────── document edits ─────────

const cadOfPage = (p: Page | undefined): CadSourceMeta | undefined => p?.source?.cad;

/** Lineweight (mm) → stroke width in page px, as the importer does (cad/build.ts). */
export const lwPx = (mm: number) => Math.max(0.25, mm * PX_MM);

/** A new entity on the current layer: contours in drawing coordinates. */
export function addEntity(label: string, make: (m: Mat) => Contour[], opts: { name?: string; fill?: boolean } = {}): string | null {
  const page = currentPage();
  const cad = cadOfPage(page);
  if (!page || !cad) return null;
  const m = wToPage(cad);
  const layer = currentLayer(page);
  const n = newVector(make(m), opts.name ?? t("cadui.ent.line"));
  const g = layerGroupOf(page, layer);
  n.stroke = g?.cad?.color ?? "#000000";
  n.fill = opts.fill ? n.stroke : null;
  n.strokeWidth = lwPx(g?.cad?.lw ?? 0.25);
  insertNodes(label, page.id, layer, [n]);
  return n.id;
}

/** Put nodes into a layer's group (made when missing), right after its last member (members stay together). */
export function insertNodes(label: string, pageId: string, layer: string, nodes: SceneNode[]) {
  S().commit(label, (d) => {
    const pg = draftPage(d, pageId);
    if (!pg) return;
    pg.groups ??= [];
    // the block editor (BEDIT) is open: what is drawn goes into the block (its layer kept on the node), so BCLOSE
    // gives it to every insert and the DXF block definition has it (it went to the layer, outside the block)
    const be = blockEdit.gid ? pg.groups.find((x) => x.id === blockEdit.gid) : undefined;
    if (be) {
      const under = groupDescendants(pg.groups, be.id);
      let last = -1;
      pg.nodes.forEach((x, i) => {
        if (x.groupId && under.has(x.groupId)) last = i;
      });
      for (const n of nodes) {
        n.groupId = be.id;
        n.cadLayer = layer;
      }
      lastMade = nodes.map((n) => n.id);
      if (last < 0) pg.nodes.push(...(nodes as any));
      else pg.nodes.splice(last + 1, 0, ...(nodes as any));
      return;
    }
    let g = pg.groups.find((x) => !x.parentId && x.cad?.layer?.toUpperCase() === layer.toUpperCase());
    if (!g) {
      g = { id: uid("g"), name: layer, parentId: null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { layer, color: "#000000" } };
      pg.groups.push(g);
    }
    const ids = groupDescendants(pg.groups, g.id);
    let at = -1;
    pg.nodes.forEach((x, i) => {
      if (x.groupId && ids.has(x.groupId)) at = i;
    });
    for (const n of nodes) n.groupId = g.id;
    lastMade = nodes.map((n) => n.id);
    if (at < 0) pg.nodes.push(...(nodes as any));
    else pg.nodes.splice(at + 1, 0, ...(nodes as any));
  });
}

/**
 * The ids with the other parts of every text among them that is drawn as several nodes (a `cad.text` group: the
 * upper parts of MTEXT stacks), so a text is picked, moved, copied, erased and re-layered as one object.
 */
export function textParts(page: Page, ids: string[]): string[] {
  const groups = page.groups ?? [];
  if (!groups.length || !ids.length) return ids;
  const byId = new Map(groups.map((g) => [g.id, g]));
  const set = new Set(ids);
  // a block insert or a dimension is one object too (AutoCAD picks the INSERT, not its lines): everything under its
  // outermost block group below the layer — except the block open in the block editor (BEDIT), whose parts are picked
  const hit = new Set<string>();
  for (const n of page.nodes) {
    if (!set.has(n.id) || !n.groupId) continue;
    let g = byId.get(n.groupId);
    let top: LayerGroup | undefined = g?.cad?.text ? g : undefined;
    for (let i = 0; g && i < 64; i++) {
      if (g.cad?.layer && !g.parentId) break;
      if (g.id === blockEdit.gid) break;
      if (g.cad?.block && !g.cad.block.startsWith("*VIEWPORT")) top = g;
      g = g.parentId ? byId.get(g.parentId) : undefined;
    }
    if (top) hit.add(top.id);
  }
  if (!hit.size) return ids;
  const under = new Set<string>();
  for (const id of hit) for (const x of groupDescendants(groups, id)) under.add(x);
  for (const n of page.nodes) if (n.groupId && under.has(n.groupId)) set.add(n.id);
  return [...set];
}
/** Hooks the other command files lend the engine (an array made associative after ARRAYRECT). */
export const hooksCad: { onArray: ((src: string[], made: string[], arr: Record<string, unknown>) => void) | null } = { onArray: null };
/** The block open in the block editor (BEDIT): its group, so its parts are picked one by one. */
export const blockEdit: { gid: string | null; name: string | null } = { gid: null, name: null };

/** A block placement moved by drawing matrix m (insertion point, rotation, scales). */
export function mapIns(ins: NonNullable<NonNullable<LayerGroup["cad"]>["ins"]>, m: Mat): typeof ins {
  const c = Math.cos(ins.rot), s = Math.sin(ins.rot);
  const X: W = [(m[0] * c + m[2] * s) * ins.sx, (m[1] * c + m[3] * s) * ins.sx];
  const Y: W = [(-m[0] * s + m[2] * c) * ins.sy, (-m[1] * s + m[3] * c) * ins.sy];
  const sx = Math.hypot(X[0], X[1]), det = X[0] * Y[1] - X[1] * Y[0];
  const p = ap(m, ins.p);
  return { p: [p[0], p[1]], rot: Math.atan2(X[1], X[0]), sx, sy: Math.hypot(Y[0], Y[1]) * (det < 0 ? -1 : 1) * (ins.sx < 0 ? -1 : 1) };
}
/** A dimension's definition points moved by drawing matrix m (its angle turns with it; the measure scales). */
export function mapDim(d: NonNullable<NonNullable<LayerGroup["cad"]>["dim"]>, m: Mat): typeof d {
  const p: Record<string, [number, number]> = {};
  for (const [k, v] of Object.entries(d.p)) {
    const q = ap(m, v);
    p[k] = [q[0], q[1]];
  }
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
  const turn = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const u = d.u ? ((v: W) => ((l) => [v[0] / l, v[1] / l] as [number, number])(Math.hypot(v[0], v[1]) || 1))([m[0] * d.u[0] + m[2] * d.u[1], m[1] * d.u[0] + m[3] * d.u[1]]) : undefined;
  return { ...d, p, measure: d.type === 5 ? d.measure : d.measure * s, ...(d.angle !== undefined ? { angle: d.angle + turn } : {}), ...(u ? { u } : {}), ...(d.off !== undefined ? { off: d.off * s } : {}) };
}
const isBlockGroup = (g: LayerGroup | undefined) => !!g && (!!g.cad?.text || (!!g.cad?.block && !g.cad.block.startsWith("*VIEWPORT")));
/**
 * A copy of a member of a text drawn in parts or of a block insert goes into groups of its own (one per source group
 * and `key`, the whole chain up to the layer), not the original's; a block's placement goes along by `mw`.
 */
function regroupCopy(pg: Draft<Page>, n: Draft<SceneNode>, key: string, fresh: Map<string, string>, mw?: Mat) {
  const chain: LayerGroup[] = [];
  let g = n.groupId ? (pg.groups?.find((x) => x.id === n.groupId) as LayerGroup | undefined) : undefined;
  for (let i = 0; isBlockGroup(g) && i < 64; i++) {
    chain.push(g!);
    g = pg.groups?.find((x) => x.id === g!.parentId) as LayerGroup | undefined;
  }
  if (!chain.length) return;
  for (let i = chain.length - 1; i >= 0; i--) {
    const src = chain[i];
    const k = `${src.id}|${key}`;
    if (fresh.has(k)) continue;
    const id = uid("g");
    fresh.set(k, id);
    const c = JSON.parse(JSON.stringify(src)) as LayerGroup;
    c.id = id;
    if (i < chain.length - 1) c.parentId = fresh.get(`${chain[i + 1].id}|${key}`) ?? c.parentId;
    if (c.cad?.ins && mw) c.cad.ins = mapIns(c.cad.ins, mw);
    if (c.cad?.dim && mw) c.cad.dim = mapDim(c.cad.dim, mw);
    pg.groups!.push(c as any);
  }
  n.groupId = fresh.get(`${chain[0].id}|${key}`)!;
}
/** Moved block inserts keep their placement (the groups above the moved nodes). */
function moveIns(pg: Draft<Page>, ids: Set<string>, mw: Mat) {
  const done = new Set<string>();
  for (const n of pg.nodes) {
    if (!ids.has(n.id)) continue;
    let g = pg.groups?.find((x) => x.id === n.groupId);
    for (let i = 0; g && !(g.cad?.layer && !g.parentId) && i < 64; i++) {
      if ((g.cad?.ins || g.cad?.dim || g.cad?.arr) && !done.has(g.id)) {
        done.add(g.id);
        if (g.cad.ins) g.cad.ins = mapIns(g.cad.ins, mw) as any;
        if (g.cad.dim) g.cad.dim = mapDim(g.cad.dim as any, mw) as any;
        if (g.cad.arr?.c) g.cad.arr.c = ap(mw, g.cad.arr.c) as any;
      }
      g = pg.groups?.find((x) => x.id === g!.parentId);
    }
  }
}

/** Apply a drawing-space matrix to nodes (move, rotate, scale, mirror); copy = leave the originals. */
export function transformNodes(label: string, ids: string[], mw: Mat, copy = false): string[] {
  const page = currentPage();
  const cad = cadOfPage(page);
  if (!page || !cad || !ids.length) return [];
  ids = textParts(page, ids);
  const fresh = new Map<string, string>();
  const P = mul(wToPage(cad), mul(mw, pageToW(cad)));
  const made: string[] = [];
  S().commit(label, (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const set = new Set(ids);
    for (let i = pg.nodes.length - 1; i >= 0; i--) {
      const src = pg.nodes[i];
      if (!set.has(src.id) || src.locked) continue;
      const n = copy ? (JSON.parse(JSON.stringify(src)) as Draft<SceneNode>) : src;
      if (copy) {
        n.id = uid();
        made.push(n.id);
        regroupCopy(pg as Draft<Page>, n, "", fresh, mw);
        pg.nodes.splice(i + 1, 0, n as any);
      }
      mapNode(n as SceneNode, P);
    }
    if (!copy) moveIns(pg as Draft<Page>, set, mw);
  });
  return made;
}

/** Bake page matrix P into a node: VECTOR anchors directly; other nodes by their centre, angle and size. */
export function mapNode(n: SceneNode, P: Mat) {
  const tr = n.transform;
  const det = P[0] * P[3] - P[1] * P[2];
  const s = Math.sqrt(Math.abs(det));
  if (n.type === "VECTOR") {
    const M = mul(P, nodeMat(n));
    n.contours = n.contours.map((c) => ({ closed: c.closed, nodes: mapAnchors(c.nodes, M) }));
    n.strokeWidth *= Math.abs(tr.scale) || 1;
    n.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
    return;
  }
  const b = localBounds(n);
  const lc: W = [b.x + b.w / 2, b.y + b.h / 2];
  const c = ap(P, applyTransform(tr, lc));
  // text keeps reading left to right when mirrored (AutoCAD MIRRTEXT 0)
  const rot = det < 0 ? tr.rotation : tr.rotation + (Math.atan2(P[1], P[0]) * 180) / Math.PI;
  tr.rotation = Math.abs(rot) < 1e-9 ? 0 : rot;
  tr.scale *= s;
  if (tr.scaleY !== undefined) tr.scaleY *= s;
  const q = applyTransform({ ...tr, x: 0, y: 0 }, lc);
  tr.x = c[0] - q[0];
  tr.y = c[1] - q[1];
}

export function eraseNodes(ids: string[]) {
  const page = currentPage();
  if (!page || !ids.length) return;
  const set = new Set(textParts(page, ids));
  S().commit(t("cadui.cmd.ERASE"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.nodes = pg.nodes.filter((n) => !set.has(n.id) || n.locked) as any;
    // a text group whose parts are all gone goes too
    if (pg.groups?.some((g) => g.cad?.text)) pg.groups = pg.groups.filter((g) => !g.cad?.text || pg.nodes.some((n) => n.groupId === g.id));
  });
  S().set({ selection: S().selection.filter((i) => !set.has(i)) });
}

/**
 * Omniweave: the selected objects (or everything shown) as vectors on a new document or slide page after this one —
 * a drawing detail in a report or a deck, still editable there.
 */
export function sendToPage(kind: "DOCUMENT" | "SLIDE") {
  const page = currentPage();
  if (!page) return;
  const sel = new Set(textParts(page, S().selection));
  const src = page.nodes.filter((n) => n.visible && (sel.size ? sel.has(n.id) : true));
  if (!src.length) return;
  const b = src.reduce<[number, number, number, number]>((a, n) => {
    const r = nodeBoundsOf(n);
    return [Math.min(a[0], r.x), Math.min(a[1], r.y), Math.max(a[2], r.x + r.w), Math.max(a[3], r.y + r.h)];
  }, [Infinity, Infinity, -Infinity, -Infinity]);
  const pg = kind === "DOCUMENT" ? newPage("DOCUMENT", 794, 1123, t("cadui.toDoc.name", { name: page.name })) : newPage("SLIDE", 1920, 1080, t("cadui.toDoc.name", { name: page.name }));
  const margin = kind === "DOCUMENT" ? 76 : 80;
  const k = Math.min((pg.width - 2 * margin) / Math.max(1e-6, b[2] - b[0]), (pg.height - 2 * margin) / Math.max(1e-6, b[3] - b[1]));
  const P: Mat = [k, 0, 0, k, margin - b[0] * k + ((pg.width - 2 * margin) - (b[2] - b[0]) * k) / 2, margin - b[1] * k];
  pg.nodes = src.map((n) => {
    const c = JSON.parse(JSON.stringify(n)) as SceneNode;
    c.id = uid();
    delete c.groupId;
    delete c.cadLayer;
    mapNode(c, P);
    if (c.type === "VECTOR") c.strokeWidth = Math.max(0.5, c.strokeWidth);
    return c;
  });
  S().commit(t("cadui.toDoc.hist"), (d) => {
    const i = d.pages.findIndex((p) => p.id === page.id);
    d.pages.splice(i + 1, 0, pg as any);
  });
  S().set({ pageId: pg.id, selection: [] });
  S().notify(t(kind === "DOCUMENT" ? "cadui.toDoc.done" : "cadui.toSlide.done"));
}
const nodeBoundsOf = (n: SceneNode) => {
  const b = localBounds(n);
  const pts = [applyTransform(n.transform, [b.x, b.y]), applyTransform(n.transform, [b.x + b.w, b.y]), applyTransform(n.transform, [b.x, b.y + b.h]), applyTransform(n.transform, [b.x + b.w, b.y + b.h])];
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
};

// ───────── layer states (AutoCAD LAYERSTATE): named on / frozen / locked sets kept with the drawing ─────────

export function saveLayerState(name: string) {
  const page = currentPage();
  if (!page?.source?.cad) return;
  const snap: Record<string, [boolean, boolean, boolean]> = {};
  for (const g of page.groups ?? []) if (!g.parentId && g.cad?.layer) snap[g.cad.layer] = [g.visible, !!g.cad.frozen, g.locked];
  S().commit(t("cadui.ls.saveHist"), (d) => {
    const c = draftPage(d, page.id)?.source?.cad;
    if (c) c.layerStates = { ...(c.layerStates ?? {}), [name]: snap };
  });
}
export function restoreLayerState(name: string) {
  const page = currentPage();
  const st = page?.source?.cad?.layerStates?.[name];
  if (!page || !st) return;
  S().commit(t("cadui.ls.restoreHist", { name }), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const on = new Map<string, boolean>();
    for (const g of pg.groups ?? []) {
      const v = g.cad?.layer ? st[g.cad.layer] : undefined;
      if (!v || g.parentId) continue;
      g.visible = v[0] && !v[1];
      if (v[1]) g.cad!.frozen = true;
      else delete g.cad!.frozen;
      // the saved state decides on / off; a remembered "off while frozen" from before does not survive it
      delete g.cad!.offWhileFrozen;
      g.locked = v[2];
      on.set(g.cad!.layer!, g.visible);
    }
    for (const n of pg.nodes) if (n.cadLayer && on.has(n.cadLayer)) n.visible = on.get(n.cadLayer)!;
  });
}

// ───────── commands ─────────

const nodeOf = (id: string) => currentPage()?.nodes.find((n) => n.id === id);
const segsOf = (id: string): Seg[] => {
  const n = nodeOf(id), cad = cadOfPage(currentPage());
  return n?.type === "VECTOR" && cad ? nodeSegs(n, cad) : [];
};

function* selectObjects(): Generator<Req, string[], Ans> {
  const pre = S().selection;
  if (pre.length) return [...pre];
  for (;;) {
    const a = yield { k: "select", prompt: "select" };
    if (a.k === "sel") return a.ids;
    if (a.k === "enter") return [...S().selection];
    if (a.k === "opt" && a.key === "fence") {
      // Fence (F): a line of points; what it crosses is selected
      const pts: W[] = [];
      for (;;) {
        const last = pts[pts.length - 1];
        const r = yield* point({ prompt: pts.length ? "fenceNext" : "fenceFirst", base: last, preview: (q) => (pts.length ? [{ k: "poly", pts: [...pts, q] }] : []) });
        if (r.k !== "point") break;
        pts.push(r.p);
      }
      const page = currentPage(), cad = cadOfPage(page);
      if (page && cad && pts.length > 1) {
        const fence: Seg[] = pts.slice(1).map((b, i) => ({ a: pts[i], b, id: "", ci: 0, si: 0 }));
        const hit = page.nodes.filter((n) => n.type === "VECTOR" && n.visible && !n.locked && nodeSegs(n, cad).some((s) => fence.some((f) => intersect(s, f).length))).map((n) => n.id);
        S().set({ selection: [...new Set([...S().selection, ...textParts(page, hit)])] });
        say(t("cadfeat.msg.found", { n: hit.length }));
      }
    }
  }
}

/** Ask for a point; numbers become direct distance from `base` along the cursor (or the answer when number=true). */
function* point(req: Omit<Req, "k">): Generator<Req, Ans, Ans> {
  for (;;) {
    const a = yield { k: "point", ...req };
    if (a.k === "number" && !req.number) {
      const base = req.base, c = bridge.cursor();
      if (!base || !c) continue;
      const dir = constrain(base, c, bridge.ortho(), bridge.polar());
      const ang = angleOf(base, dir);
      return { k: "point", p: polar(base, a.v, ang) };
    }
    return a;
  }
}

const done = (n: string, x: string | null) => (x ? say(t("cadui.msg.made", { what: t(`cadui.cmd.${n}`) })) : undefined);

function* LINE(): Cmd {
  const a = yield* point({ prompt: "firstPoint" });
  if (a.k !== "point") return;
  const pts: W[] = [a.p];
  const made: string[] = [];
  for (;;) {
    const from = pts[pts.length - 1];
    const opts = pts.length >= 3 ? ["close", "undo"] : ["undo"];
    const r = yield* point({ prompt: "nextPoint", opts, base: from, preview: (c) => [{ k: "line", a: from, b: c }] });
    if (r.k === "point") {
      const id = addEntity(t("cadui.cmd.LINE"), (m) => [polyContour([from, r.p], false, m)], { name: t("cadui.ent.line") });
      if (id) made.push(id);
      pts.push(r.p);
    } else if (r.k === "opt" && r.key === "close") {
      addEntity(t("cadui.cmd.LINE"), (m) => [polyContour([from, pts[0]], false, m)], { name: t("cadui.ent.line") });
      return;
    } else if (r.k === "opt" && r.key === "undo") {
      const id = made.pop();
      if (id) eraseNodes([id]);
      if (pts.length > 1) pts.pop();
    } else return;
  }
}

function* PLINE(): Cmd {
  const a = yield* point({ prompt: "startPoint" });
  if (a.k !== "point") return;
  // vertices with the arc between the previous and this one (tangent arcs, AutoCAD's PLINE Arc mode)
  const v: { p: W; arc?: { c: W; r: number; a0: number; a1: number } }[] = [{ p: a.p }];
  let arcMode = false;
  const tangentAt = (): W | null => {
    if (v.length < 2) return null;
    const q = v[v.length - 1];
    if (q.arc) {
      const ang = q.arc.a1 + (q.arc.a1 > q.arc.a0 ? Math.PI / 2 : -Math.PI / 2);
      return [Math.cos(ang), Math.sin(ang)];
    }
    return sub(q.p, v[v.length - 2].p);
  };
  const tanArc = (from: W, to: W): { c: W; r: number; a0: number; a1: number } | null => {
    const tg = tangentAt() ?? [1, 0];
    const nrm: W = [-tg[1], tg[0]];
    const ch = sub(to, from);
    const den = 2 * (nrm[0] * ch[0] + nrm[1] * ch[1]);
    if (Math.abs(den) < 1e-12) return null;
    const k = (ch[0] * ch[0] + ch[1] * ch[1]) / den;
    const c: W = [from[0] + nrm[0] * k, from[1] + nrm[1] * k];
    const r = Math.abs(k);
    const a0 = angleOf(c, from);
    let sweep = angleOf(c, to) - a0;
    const ccw = k > 0;
    if (ccw && sweep < 0) sweep += 2 * Math.PI;
    if (!ccw && sweep > 0) sweep -= 2 * Math.PI;
    return { c, r, a0, a1: a0 + sweep };
  };
  const shapes = (extra?: { p: W; arc?: { c: W; r: number; a0: number; a1: number } }): Shape[] => {
    const all = extra ? [...v, extra] : v;
    const out: Shape[] = [];
    for (let i = 1; i < all.length; i++) {
      const q = all[i];
      out.push(q.arc ? { k: "arc", ...q.arc } : { k: "line", a: all[i - 1].p, b: q.p });
    }
    return out;
  };
  const finish = (closed: boolean) => {
    if (v.length < 2) return;
    addEntity(t("cadui.cmd.PLINE"), (m) => {
      const nodes = [{ anchor: v[0].p, handleIn: v[0].p, handleOut: v[0].p, isCorner: true }];
      for (let i = 1; i < v.length; i++) {
        const q = v[i];
        if (q.arc) {
          const an = arcAnchors(q.arc.c, q.arc.r, q.arc.a0, q.arc.a1);
          nodes[nodes.length - 1].handleOut = an[0].handleOut;
          nodes.push(...an.slice(1));
        } else nodes.push({ anchor: q.p, handleIn: q.p, handleOut: q.p, isCorner: true });
      }
      if (closed) nodes.push({ anchor: v[0].p, handleIn: v[0].p, handleOut: v[0].p, isCorner: true });
      for (const q of nodes) q.isCorner = true;
      const c: Contour = { closed, nodes: mapAnchors(nodes as any, m) };
      if (closed) c.nodes.pop();
      return [c];
    }, { name: t("cadui.ent.pline") });
  };
  for (;;) {
    const from = v[v.length - 1].p;
    const opts = arcMode ? ["line", "close", "undo"] : ["arc", "close", "undo"];
    const r = yield* point({ prompt: arcMode ? "arcEnd" : "nextPoint", opts, base: from, preview: (c) => shapes(arcMode ? { p: c, arc: tanArc(from, c) ?? undefined } : { p: c }) });
    if (r.k === "point") v.push(arcMode ? { p: r.p, arc: tanArc(from, r.p) ?? undefined } : { p: r.p });
    else if (r.k === "opt" && r.key === "arc") arcMode = true;
    else if (r.k === "opt" && r.key === "line") arcMode = false;
    else if (r.k === "opt" && r.key === "undo") {
      if (v.length > 1) v.pop();
    } else if (r.k === "opt" && r.key === "close") return finish(true);
    else return finish(false);
  }
}

function* CIRCLE(): Cmd {
  const a = yield* point({ prompt: "circleCenter", opts: ["p3", "p2"] });
  const make = (c: W, r: number) => {
    if (r > 0) done("CIRCLE", addEntity(t("cadui.cmd.CIRCLE"), (m) => [circleContour(c, r, m)], { name: t("cadui.ent.circle") }));
  };
  if (a.k === "opt" && (a.key === "p2" || a.key === "p3")) {
    const p1 = yield* point({ prompt: "circleP1" });
    if (p1.k !== "point") return;
    const p2 = yield* point({ prompt: "circleP2", base: p1.p, preview: (c) => (a.key === "p2" ? [{ k: "circle", c: [(p1.p[0] + c[0]) / 2, (p1.p[1] + c[1]) / 2], r: dist(p1.p, c) / 2 }] : [{ k: "line", a: p1.p, b: c }]) });
    if (p2.k !== "point") return;
    if (a.key === "p2") return make([(p1.p[0] + p2.p[0]) / 2, (p1.p[1] + p2.p[1]) / 2], dist(p1.p, p2.p) / 2);
    const p3 = yield* point({ prompt: "circleP3", preview: (c) => {
      const x = arc3(p1.p, p2.p, c);
      return x ? [{ k: "circle", c: x.c, r: x.r }] : [];
    } });
    if (p3.k !== "point") return;
    const x = arc3(p1.p, p2.p, p3.p);
    if (x) make(x.c, x.r);
    return;
  }
  if (a.k !== "point") return;
  const c = a.p;
  let diameter = false;
  for (;;) {
    const r = yield* point({ prompt: diameter ? "circleDiameter" : "circleRadius", opts: diameter ? [] : ["diameter"], base: c, number: true, preview: (q) => [{ k: "circle", c, r: dist(c, q) / (diameter ? 2 : 1) }, { k: "line", a: c, b: q }] });
    if (r.k === "opt" && r.key === "diameter") {
      diameter = true;
      continue;
    }
    if (r.k === "number") return make(c, diameter ? r.v / 2 : r.v);
    if (r.k === "point") return make(c, dist(c, r.p) / (diameter ? 2 : 1));
    return;
  }
}

function* ARC(): Cmd {
  const a = yield* point({ prompt: "arcStart", opts: ["center"] });
  const make = (x: { c: W; r: number; a0: number; a1: number } | null) => {
    if (x && x.r > 0) done("ARC", addEntity(t("cadui.cmd.ARC"), (m) => [{ closed: false, nodes: mapAnchors(arcAnchors(x.c, x.r, x.a0, x.a1), m) }], { name: t("cadui.ent.arc") }));
  };
  if (a.k === "opt" && a.key === "center") {
    const c = yield* point({ prompt: "arcCenter" });
    if (c.k !== "point") return;
    const s = yield* point({ prompt: "arcStart", base: c.p, preview: (q) => [{ k: "line", a: c.p, b: q }] });
    if (s.k !== "point") return;
    const r = dist(c.p, s.p), a0 = angleOf(c.p, s.p);
    const sweepTo = (q: W) => {
      let a1 = angleOf(c.p, q);
      while (a1 <= a0) a1 += 2 * Math.PI;
      return { c: c.p, r, a0, a1 };
    };
    const e = yield* point({ prompt: "arcEndPt", opts: ["angle"], base: c.p, preview: (q) => [{ k: "arc", ...sweepTo(q) }, { k: "line", a: c.p, b: q, dash: true }] });
    if (e.k === "point") return make(sweepTo(e.p));
    if (e.k === "opt" && e.key === "angle") {
      const g = yield* point({ prompt: "arcAngle", number: true, base: c.p });
      if (g.k === "number") return make({ c: c.p, r, a0, a1: a0 + (g.v * Math.PI) / 180 });
      if (g.k === "point") return make(sweepTo(g.p));
    }
    return;
  }
  if (a.k !== "point") return;
  const p1 = a.p;
  const b = yield* point({ prompt: "arcSecond", base: p1, preview: (q) => [{ k: "line", a: p1, b: q }] });
  if (b.k !== "point") return;
  const e = yield* point({ prompt: "arcEndPt", preview: (q) => {
    const x = arc3(p1, b.p, q);
    return x ? [{ k: "arc", ...x }] : [];
  } });
  if (e.k === "point") make(arc3(p1, b.p, e.p));
}

function* RECTANG(): Cmd {
  const a = yield* point({ prompt: "firstCorner" });
  if (a.k !== "point") return;
  const p = a.p;
  const corners = (q: W): W[] => [p, [q[0], p[1]], q, [p[0], q[1]]];
  const b = yield* point({ prompt: "otherCorner", base: p, preview: (q) => [{ k: "poly", pts: corners(q), closed: true }] });
  if (b.k === "point" && b.p[0] !== p[0] && b.p[1] !== p[1]) done("RECTANG", addEntity(t("cadui.cmd.RECTANG"), (m) => [polyContour(corners(b.p), true, m)], { name: t("cadui.ent.pline") }));
}

/** MOVE / COPY: base point (or Displacement) then the second point. */
function* moveCopy(copy: boolean): Cmd {
  const ids = yield* selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const a = yield* point({ prompt: "basePoint", opts: ["displacement"], def: copy ? undefined : undefined });
  let base: W;
  if (a.k === "opt" && a.key === "displacement") {
    const d = yield* point({ prompt: "displacement", def: "0,0" });
    if (d.k !== "point") return;
    transformNodes(t(copy ? "cadui.cmd.COPY" : "cadui.cmd.MOVE"), ids, translate(d.p[0], d.p[1]), copy);
    return finishSel();
  }
  if (a.k !== "point") return finishSel();
  base = a.p;
  for (;;) {
    const b = yield* point({ prompt: copy ? "secondPointCopy" : "secondPoint", base, preview: (q) => [{ k: "line", a: base, b: q, dash: true }, { k: "ghost", ids, m: translate(q[0] - base[0], q[1] - base[1]) }] });
    if (b.k === "point") transformNodes(t(copy ? "cadui.cmd.COPY" : "cadui.cmd.MOVE"), ids, translate(b.p[0] - base[0], b.p[1] - base[1]), copy);
    else if (b.k === "enter" && !copy) transformNodes(t("cadui.cmd.MOVE"), ids, translate(base[0], base[1]));
    if (!copy || b.k !== "point") break;
  }
  finishSel();
}
const finishSel = () => {
  if (S().selection.length) prevSel = [...S().selection];
  S().set({ selection: [] });
};
/** AutoCAD's Previous (P) and Last (L) at "객체 선택": the last command's selection, the newest object drawn. */
let prevSel: string[] = [];
let lastMade: string[] = [];

function* ROTATE(): Cmd {
  const ids = yield* selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const a = yield* point({ prompt: "basePoint" });
  if (a.k !== "point") return finishSel();
  const c = a.p;
  let copy = false, ref = 0;
  for (;;) {
    const r = yield* point({ prompt: "rotAngle", opts: ["copy", "reference"], def: "0", base: c, number: true, preview: (q) => [{ k: "line", a: c, b: q, dash: true }, { k: "ghost", ids, m: rotateAbout(c, angleOf(c, q) - ref) }] });
    if (r.k === "opt" && r.key === "copy") {
      copy = true;
      say(t("cadui.msg.copyOn"));
      continue;
    }
    if (r.k === "opt" && r.key === "reference") {
      const g = yield* point({ prompt: "refAngle", number: true, def: "0" });
      if (g.k === "number") ref = (g.v * Math.PI) / 180;
      else if (g.k === "point") {
        const h = yield* point({ prompt: "secondPoint", base: g.p });
        if (h.k === "point") ref = angleOf(g.p, h.p);
      }
      continue;
    }
    const ang = r.k === "number" ? (r.v * Math.PI) / 180 - ref : r.k === "point" ? angleOf(c, r.p) - ref : null;
    if (ang !== null) transformNodes(t("cadui.cmd.ROTATE"), ids, rotateAbout(c, ang), copy);
    return finishSel();
  }
}

function* SCALE(): Cmd {
  const ids = yield* selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const a = yield* point({ prompt: "basePoint" });
  if (a.k !== "point") return finishSel();
  const c = a.p;
  let copy = false, refLen = 1;
  for (;;) {
    const r = yield* point({ prompt: "scaleFactor", opts: ["copy", "reference"], def: "1", base: c, number: true, preview: (q) => [{ k: "line", a: c, b: q, dash: true }, { k: "ghost", ids, m: scaleAbout(c, dist(c, q) / refLen || 1) }] });
    if (r.k === "opt" && r.key === "copy") {
      copy = true;
      continue;
    }
    if (r.k === "opt" && r.key === "reference") {
      const g = yield* point({ prompt: "refLength", number: true, def: "1" });
      if (g.k === "number" && g.v > 0) refLen = g.v;
      else if (g.k === "point") {
        const h = yield* point({ prompt: "secondPoint", base: g.p });
        if (h.k === "point") refLen = dist(g.p, h.p) || 1;
      }
      continue;
    }
    const f = r.k === "number" ? r.v / refLen : r.k === "point" ? dist(c, r.p) / refLen : null;
    if (f && f > 0) transformNodes(t("cadui.cmd.SCALE"), ids, scaleAbout(c, f), copy);
    return finishSel();
  }
}

function* MIRROR(): Cmd {
  const ids = yield* selectObjects();
  if (!ids.length) return;
  S().set({ selection: ids });
  const a = yield* point({ prompt: "mirror1" });
  if (a.k !== "point") return finishSel();
  const b = yield* point({ prompt: "mirror2", base: a.p, preview: (q) => [{ k: "line", a: a.p, b: q }, { k: "ghost", ids, m: mirrorLine(a.p, q) }] });
  if (b.k !== "point") return finishSel();
  const e = yield { k: "key", prompt: "mirrorErase", opts: ["yes", "no"], def: "no" };
  const erase = e.k === "opt" && e.key === "yes";
  transformNodes(t("cadui.cmd.MIRROR"), ids, mirrorLine(a.p, b.p), !erase);
  finishSel();
}

/** Points of a contour when all its segments are straight (a line or polyline), else null. */
const straightPts = (segs: Seg[]): W[] | null => (segs.every((s) => !s.c1) && segs.length ? [segs[0].a, ...segs.map((s) => s.b)] : null);

function* OFFSET(): Cmd {
  let d: number | null = null;
  for (;;) {
    const r = yield* point({ prompt: "offsetDist", opts: ["through"], def: offsetLast ? fmt(offsetLast) : t("cadui.o.through"), number: true });
    if (r.k === "number" && r.v > 0) d = r.v;
    else if (r.k === "point") {
      const q = yield* point({ prompt: "secondPoint", base: r.p });
      if (q.k === "point") d = dist(r.p, q.p);
    } else if (r.k === "enter" && offsetLast) d = offsetLast;
    else if (r.k === "opt" && r.key === "through") d = null;
    else if (r.k !== "enter") return;
    break;
  }
  if (d) offsetLast = d;
  for (;;) {
    const o = yield { k: "pick", prompt: "offsetPick" };
    if (o.k !== "pick") return;
    const segs = segsOf(o.id);
    if (!segs.length) continue;
    const side = yield* point({ prompt: d ? "offsetSide" : "throughPoint" });
    if (side.k !== "point") return;
    const s = side.p;
    const n = nodeOf(o.id) as VectorNode;
    const contours: Contour[] = [];
    // per contour: circle / arc pieces → concentric, straight → mitred offset, other curves → offset control points
    const byC = new Map<number, Seg[]>();
    for (const x of segs) (byC.get(x.ci) ?? byC.set(x.ci, []).get(x.ci)!).push(x);
    const near = segs.reduce((b, x) => (nearest(x, s).d < nearest(b, s).d ? x : b), segs[0]);
    const nq = nearest(near, s);
    const tg = sub(near.b, near.a);
    const arc = arcOf(near);
    let sign = 1;
    if (arc) sign = dist(arc.c, s) > arc.r ? 1 : -1;
    else sign = tg[0] * (s[1] - nq.p[1]) - tg[1] * (s[0] - nq.p[0]) > 0 ? 1 : -1;
    const dd = d ?? nq.d;
    for (const [ci, list] of byC) {
      const closed = n.contours[ci].closed;
      const pts = straightPts(list);
      const arcs = list.map(arcOf);
      if (pts) {
        const base = closed && dist(pts[0], pts[pts.length - 1]) < 1e-9 ? pts.slice(0, -1) : closed ? pts : pts;
        contours.push(polyContour(offsetPoly(closed ? base.slice(0, closed ? base.length : undefined) : base, closed, sign * dd), closed, wToPage(cadOfPage(currentPage())!)));
      } else if (arcs.every((x) => x)) {
        const c = arcs[0]!.c;
        const out = list.map((x) => {
          const a2 = arcOf(x)!;
          const k = (a2.r + (arc ? sign : 1) * dd) / a2.r;
          const m = scaleAbout(a2.c, k);
          return { ...x, a: ap(m, x.a), b: ap(m, x.b), c1: ap(m, x.c1!), c2: ap(m, x.c2!) };
        });
        void c;
        contours.push(segsToContour(out, closed, wToPage(cadOfPage(currentPage())!)));
      }
    }
    if (contours.length) {
      const layerG = currentPage()?.groups?.find((g) => g.id === n.groupId);
      const id = uid();
      const copy: VectorNode = { ...JSON.parse(JSON.stringify(n)), id, contours, transform: { x: 0, y: 0, rotation: 0, scale: 1 } };
      void layerG;
      const page = currentPage()!;
      S().commit(t("cadui.cmd.OFFSET"), (dr) => {
        const pg = draftPage(dr, page.id);
        const i = pg?.nodes.findIndex((x) => x.id === n.id) ?? -1;
        if (pg && i >= 0) pg.nodes.splice(i + 1, 0, copy as any);
      });
    } else say(t("cadui.msg.cannotOffset"));
  }
}
let offsetLast = 0;

/** Intersections of node `id`'s contour `ci` with everything else near it: parameters (segment index + t). */
function cutsOn(id: string, ci: number): number[] {
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad) return [];
  const mine = segsOf(id).filter((s) => s.ci === ci);
  const box = bbox(mine);
  const out: number[] = [];
  for (const n of page.nodes) {
    if (n.type !== "VECTOR" || !n.visible) continue;
    for (const o of nodeSegs(n, cad)) {
      if (o.id === id && o.ci === ci) continue;
      if (!overlap(box, bbox([o]))) continue;
      for (const s of mine) for (const x of intersect(s, o)) out.push(s.si + x.t);
    }
  }
  return out;
}
function bbox(segs: Seg[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of segs) for (const p of [s.a, s.b, s.c1, s.c2]) if (p) (x0 = Math.min(x0, p[0])), (y0 = Math.min(y0, p[1])), (x1 = Math.max(x1, p[0])), (y1 = Math.max(y1, p[1]));
  return [x0, y0, x1, y1];
}
const overlap = (a: number[], b: number[]) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

/** TRIM (Quick mode): every object is a cutting edge; the picked piece between the nearest crossings goes. */
export function trimAt(id: string, p: W): boolean {
  const n = nodeOf(id), cad = cadOfPage(currentPage());
  if (n?.type !== "VECTOR" || !cad) return false;
  const all = nodeSegs(n, cad);
  if (!all.length) return false;
  const hit = all.reduce((b, s) => (nearest(s, p).d < nearest(b, p).d ? s : b), all[0]);
  const ci = hit.ci;
  const segs = all.filter((s) => s.ci === ci);
  const pick = hit.si + nearest(hit, p).t;
  const pieces = trimContour(segs, n.contours[ci].closed, cutsOn(id, ci), pick);
  const page = currentPage()!;
  const m = wToPage(cad);
  S().commit(t("cadui.cmd.TRIM"), (d) => {
    const pg = draftPage(d, page.id);
    const x = pg?.nodes.find((q) => q.id === id) as Draft<VectorNode> | undefined;
    if (!pg || !x) return;
    const keep = x.contours.filter((_, i) => i !== ci) as Contour[];
    const fresh = (pieces ?? []).map((pc) => segsToContour(pc, false, m));
    const local = fresh.map((c) => ({ closed: false, nodes: mapAnchors(c.nodes, invert(nodeMat(x as any))) }));
    x.contours = [...keep, ...local] as any;
    if (!x.contours.length) pg.nodes = pg.nodes.filter((q) => q.id !== id) as any;
  });
  return true;
}
function invert(m: Mat): Mat {
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** EXTEND (Quick mode): the end of a line / open polyline nearest the pick runs on to the next object it meets. */
export function extendAt(id: string, p: W): boolean {
  const n = nodeOf(id), page = currentPage(), cad = cadOfPage(page);
  if (n?.type !== "VECTOR" || !cad || !page) return false;
  const segs = nodeSegs(n, cad);
  const c = n.contours.findIndex((x) => !x.closed);
  const mine = segs.filter((s) => s.ci === c);
  if (c < 0 || !mine.length) return false;
  const first = mine[0], last = mine[mine.length - 1];
  const atStart = dist(p, first.a) < dist(p, last.b);
  const s = atStart ? first : last;
  if (s.c1) return false;
  const from = atStart ? s.b : s.a, end = atStart ? s.a : s.b;
  const ray: Seg = { a: from, b: end, id: "", ci: 0, si: 0 };
  let best: W | null = null, bt = Infinity;
  for (const o of page.nodes) {
    if (o.type !== "VECTOR" || !o.visible) continue;
    for (const q of nodeSegs(o, cad)) {
      if (q.id === id && q.ci === c) continue;
      for (const x of intersect(ray, q, true)) if (x.t > 1 + 1e-9 && x.t < bt) (bt = x.t), (best = x.p);
    }
  }
  if (!best) return false;
  const P = invert(nodeMat(n));
  const tp = ap(P, ap(wToPage(cad), best));
  S().commit(t("cadui.cmd.EXTEND"), (d) => {
    const x = draftPage(d, page.id)?.nodes.find((q) => q.id === id) as Draft<VectorNode> | undefined;
    const cn = x?.contours[c];
    if (!cn) return;
    const a = atStart ? cn.nodes[0] : cn.nodes[cn.nodes.length - 1];
    a.anchor = [...tp];
    a.handleIn = [...tp];
    a.handleOut = [...tp];
  });
  return true;
}

function* TRIM(): Cmd {
  say(t("cadui.msg.trimQuick"));
  for (;;) {
    const o = yield { k: "pick", prompt: "trimPick", opts: ["undo"] };
    if (o.k === "pick") {
      if (!trimAt(o.id, o.p)) say(t("cadui.msg.noEdge"));
    } else if (o.k === "opt" && o.key === "undo") S().undo();
    else return;
  }
}
function* EXTEND(): Cmd {
  for (;;) {
    const o = yield { k: "pick", prompt: "extendPick", opts: ["undo"] };
    if (o.k === "pick") {
      if (!extendAt(o.id, o.p)) say(t("cadui.msg.noBoundary"));
    } else if (o.k === "opt" && o.key === "undo") S().undo();
    else return;
  }
}

function* ERASE(): Cmd {
  const ids = yield* selectObjects();
  eraseNodes(ids);
  if (ids.length) say(t("cadui.msg.erased", { n: ids.length }));
}

function* ZOOM(): Cmd {
  const r = yield* point({ prompt: "zoom", opts: ["all", "extents", "previous", "window"], number: true });
  if (r.k === "opt" && r.key === "extents") return bridge.zoomExtents();
  if (r.k === "opt" && r.key === "all") return bridge.zoomAll();
  if (r.k === "opt" && r.key === "previous") return bridge.zoomPrevious();
  if (r.k === "number" && r.v > 0) return bridge.zoomBy(r.v);
  if (r.k === "text") {
    const m = /^([\d.]+)\s*x?$/i.exec(r.s);
    if (m) return bridge.zoomBy(Number(m[1]));
  }
  let a: W | null = r.k === "point" ? r.p : null;
  if (!a) {
    const q = yield* point({ prompt: "firstCorner" });
    if (q.k !== "point") return;
    a = q.p;
  }
  const corner = a;
  const b = yield* point({ prompt: "otherCorner", preview: (q) => [{ k: "poly", pts: [corner, [q[0], corner[1]], q, [corner[0], q[1]]], closed: true }] });
  if (b.k === "point") bridge.zoomWindow(corner, b.p);
}

function* DIST(): Cmd {
  const a = yield* point({ prompt: "firstPoint" });
  if (a.k !== "point") return;
  const b = yield* point({ prompt: "secondPoint", base: a.p, preview: (q) => [{ k: "line", a: a.p, b: q, dash: true }] });
  if (b.k !== "point") return;
  const d = dist(a.p, b.p);
  say(t("cadui.msg.dist", { d: fmt(d), a: fmt(deg(angleOf(a.p, b.p)), 2), dx: fmt(b.p[0] - a.p[0]), dy: fmt(b.p[1] - a.p[1]) }));
}

function* AREA(): Cmd {
  const pts: W[] = [];
  for (;;) {
    const r = yield* point({ prompt: pts.length ? "nextPoint" : "areaFirst", opts: pts.length ? ["undo"] : ["object"], base: pts[pts.length - 1], preview: (q) => (pts.length ? [{ k: "poly", pts: [...pts, q], closed: true }] : []) });
    if (r.k === "point") pts.push(r.p);
    else if (r.k === "opt" && r.key === "undo") pts.pop();
    else if (r.k === "opt" && r.key === "object") {
      const o = yield { k: "pick", prompt: "offsetPick" };
      if (o.k !== "pick") return;
      const segs = segsOf(o.id);
      const flatPts: W[] = [];
      for (const s of segs) for (let i = 0; i <= (s.c1 ? 16 : 1); i++) if (i || !flatPts.length) flatPts.push(s.c1 ? (bzAt(s, i / 16)) : i ? s.b : s.a);
      const x = polyArea(flatPts);
      return say(t("cadui.msg.area", { a: fmt(x.area), p: fmt(x.perimeter) }));
    } else break;
  }
  if (pts.length >= 3) {
    const x = polyArea(pts);
    say(t("cadui.msg.area", { a: fmt(x.area), p: fmt(x.perimeter) }));
  }
}
const bzAt = (s: Seg, tt: number): W => {
  const u = 1 - tt;
  return [u * u * u * s.a[0] + 3 * u * u * tt * s.c1![0] + 3 * u * tt * tt * s.c2![0] + tt * tt * tt * s.b[0], u * u * u * s.a[1] + 3 * u * u * tt * s.c1![1] + 3 * u * tt * tt * s.c2![1] + tt * tt * tt * s.b[1]];
};

function* ID(): Cmd {
  const a = yield* point({ prompt: "idPoint" });
  if (a.k === "point") say(`X = ${fmt(a.p[0])}   Y = ${fmt(a.p[1])}   Z = 0`);
}

let textHeight = 2.5;
function* TEXT(): Cmd {
  const a = yield* point({ prompt: "textStart" });
  if (a.k !== "point") return;
  // a style with a fixed height does not ask it (AutoCAD STYLE)
  const h: Ans = textStyle.height > 0 ? { k: "number", v: textStyle.height } : yield* point({ prompt: "textHeight", def: fmt(textHeight), number: true, base: a.p });
  if (h.k === "number" && h.v > 0) textHeight = h.v;
  else if (h.k === "point") textHeight = dist(a.p, h.p) || textHeight;
  const r = yield* point({ prompt: "textRot", def: "0", number: true, base: a.p });
  const rot = r.k === "number" ? r.v : r.k === "point" ? deg(angleOf(a.p, r.p)) : 0;
  const s = yield { k: "text", prompt: "textString" };
  if (s.k !== "text" || !s.s) return;
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad) return;
  const g = layerGroupOf(page, currentLayer(page));
  const hpx = textHeight * cad.k;
  const n = newText(s.s);
  const run = n.paragraphs[0].runs[0];
  Object.assign(run, { ...DEFAULT_RUN, text: s.s, fontSize: hpx / 0.72, color: g?.cad?.color ?? "#000000", ...(textStyle.font ? { fontFamily: textStyle.font } : {}), ...(textStyle.wf !== 1 ? { hscale: textStyle.wf * 100 } : {}) });
  const at = ap(wToPage(cad), a.p);
  // baseline-left at the insertion point: the box top sits one line above it
  n.transform = { x: at[0], y: at[1] - hpx / 0.72, rotation: -rot, scale: 1 };
  n.name = s.s.slice(0, 40);
  insertNodes(t("cadui.cmd.TEXT"), page.id, currentLayer(page), [n]);
}

/** Linear (horizontal / vertical) or aligned dimension: extension lines, dimension line, arrowheads, measurement. */
function* DIM(aligned: boolean): Cmd {
  const a = yield* point({ prompt: "dimFirst" });
  if (a.k !== "point") return;
  const b = yield* point({ prompt: "dimSecond", base: a.p, preview: (q) => [{ k: "line", a: a.p, b: q, dash: true }] });
  if (b.k !== "point") return;
  const geo = (q: W) => {
    let dir: W;
    if (aligned) dir = sub(b.p, a.p);
    else {
      const dx = Math.abs(b.p[0] - a.p[0]), dy = Math.abs(b.p[1] - a.p[1]);
      const mx = (a.p[0] + b.p[0]) / 2, my = (a.p[1] + b.p[1]) / 2;
      // AutoCAD picks horizontal or vertical by where the dimension line is dragged
      const vert = Math.abs(q[0] - mx) > Math.abs(q[1] - my) && dy > 0 ? true : dx === 0;
      dir = vert ? [0, 1] : [1, 0];
    }
    const l = Math.hypot(dir[0], dir[1]) || 1;
    const u: W = [dir[0] / l, dir[1] / l], nrm: W = [-u[1], u[0]];
    const off = (q[0] - a.p[0]) * nrm[0] + (q[1] - a.p[1]) * nrm[1];
    const pa: W = [a.p[0] + nrm[0] * (off - ((a.p[0] - a.p[0]) * nrm[0])), a.p[1] + nrm[1] * off];
    const offB = off - ((b.p[0] - a.p[0]) * nrm[0] + (b.p[1] - a.p[1]) * nrm[1]);
    const pb: W = [b.p[0] + nrm[0] * offB, b.p[1] + nrm[1] * offB];
    return { pa, pb, u, nrm, len: Math.abs((pb[0] - pa[0]) * u[0] + (pb[1] - pa[1]) * u[1]) };
  };
  const c = yield* point({ prompt: "dimLine", preview: (q) => {
    const g = geo(q);
    return [{ k: "line", a: a.p, b: g.pa }, { k: "line", a: b.p, b: g.pb }, { k: "line", a: g.pa, b: g.pb }];
  } });
  if (c.k !== "point") return;
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad) return;
  const g = geo(c.p);
  const scale = cad.scale || 1;
  const ar = 2.5 * scale * (cad.mmPerUnit ? 1 / cad.mmPerUnit : 1); // 2.5 mm on paper
  const m = wToPage(cad);
  const layerG = layerGroupOf(page, currentLayer(page));
  const color = layerG?.cad?.color ?? "#000000";
  const dirAB = Math.sign((g.pb[0] - g.pa[0]) * g.u[0] + (g.pb[1] - g.pa[1]) * g.u[1]) || 1;
  const head = (tip: W, s: number): W[] => {
    const back = polar(tip, ar, Math.atan2(g.u[1] * s, g.u[0] * s));
    return [tip, add2(back, g.nrm, ar / 6), add2(back, g.nrm, -ar / 6)];
  };
  const lines = newVector([polyContour([a.p, add2(g.pa, g.nrm, Math.sign(dot(sub(g.pa, a.p), g.nrm)) * ar * 0.5)], false, m), polyContour([b.p, add2(g.pb, g.nrm, Math.sign(dot(sub(g.pb, b.p), g.nrm)) * ar * 0.5)], false, m), polyContour([g.pa, g.pb], false, m)], t("cadui.ent.dim"));
  lines.stroke = color;
  lines.fill = null;
  lines.strokeWidth = lwPx(0.18);
  const heads = newVector([polyContour(head(g.pa, dirAB), true, m), polyContour(head(g.pb, -dirAB), true, m)], t("cadui.ent.dim"));
  heads.fill = color;
  heads.stroke = null;
  heads.strokeWidth = 0;
  const label = fmt(g.len, 2);
  const tx = newText(label);
  const hpx = ar * cad.k;
  Object.assign(tx.paragraphs[0].runs[0], { ...DEFAULT_RUN, text: label, fontSize: hpx / 0.72, color });
  const mid: W = [(g.pa[0] + g.pb[0]) / 2 + g.nrm[0] * ar * 0.4, (g.pa[1] + g.pb[1]) / 2 + g.nrm[1] * ar * 0.4];
  const ang = Math.atan2(g.u[1], g.u[0]);
  const read = Math.cos(ang) < -1e-9 ? ang + Math.PI : ang;
  const mp = ap(m, mid);
  const w = label.length * hpx * 0.75;
  const rad = -read;
  tx.transform = { x: mp[0] - Math.cos(rad) * w / 2 + Math.sin(rad) * hpx * 1.3, y: mp[1] - Math.sin(rad) * w / 2 - Math.cos(rad) * hpx * 1.3, rotation: (rad * 180) / Math.PI, scale: 1 };
  tx.name = label;
  insertNodes(t("cadui.cmd.DIMLINEAR"), page.id, currentLayer(page), [lines, heads, tx]);
}
const dot = (a: W, b: W) => a[0] * b[0] + a[1] * b[1];
const add2 = (p: W, v: W, k: number): W => [p[0] + v[0] * k, p[1] + v[1] * k];

function* LAYER(): Cmd {
  bridge.openLayers();
}
function* U(): Cmd {
  S().undo();
  say(t("cadui.msg.undone"));
}
function* REDO(): Cmd {
  S().redo?.();
}

// ───────── grips, EXPLODE, JOIN, FILLET, ARRAY ─────────

/** Node-local ↔ drawing matrices of a node. */
const toWorld = (n: SceneNode, cad: CadSourceMeta): Mat => mul(pageToW(cad), nodeMat(n));
const toLocal = (n: SceneNode, cad: CadSourceMeta): Mat => mul(invert(nodeMat(n)), wToPage(cad));
const shift = (q: Draft<VectorNode>["contours"][number]["nodes"][number], d: W) => {
  q.anchor = [q.anchor[0] + d[0], q.anchor[1] + d[1]];
  q.handleIn = [q.handleIn[0] + d[0], q.handleIn[1] + d[1]];
  q.handleOut = [q.handleOut[0] + d[0], q.handleOut[1] + d[1]];
};

/** Grips of a VECTOR node as the canvas shows them: ends of every segment, arc centres, a single line's midpoint. */
export function gripsOf(n: VectorNode, cad: CadSourceMeta): W[] {
  const segs = nodeSegs(n, cad);
  const out: W[] = [];
  if (segs.length > 400) return out;
  const once = (p: W) => {
    if (!out.some((s) => dist(s, p) < 1e-9)) out.push(p);
  };
  for (const s of segs) {
    const arc = arcOf(s);
    if (arc) once(arc.c);
    once(s.a);
    once(s.b);
    if (!s.c1 && segs.length === 1) once([(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2]);
  }
  return out;
}

/**
 * Grip stretch: the anchors at grip `g` move to `to` (their handles with them); an arc centre or a line's midpoint
 * moves the whole object, as AutoCAD's grips do.
 */
export function stretchGrip(id: string, g: W, to: W): boolean {
  const page = currentPage(), cad = cadOfPage(page), n = nodeOf(id);
  if (!page || !cad || n?.type !== "VECTOR" || n.locked) return false;
  const M = toWorld(n, cad), L = toLocal(n, cad);
  const a = ap(L, g), b = ap(L, to);
  const d: W = [b[0] - a[0], b[1] - a[1]];
  const hits: [number, number][] = [];
  n.contours.forEach((c, ci) => c.nodes.forEach((q, i) => dist(ap(M, q.anchor), g) < 1e-6 && hits.push([ci, i])));
  if (!hits.length) return transformNodes(t("cadui.cmd.STRETCH"), [id], translate(to[0] - g[0], to[1] - g[1])), true;
  S().commit(t("cadui.cmd.STRETCH"), (dr) => {
    const x = draftPage(dr, page.id)?.nodes.find((q) => q.id === id) as Draft<VectorNode> | undefined;
    if (x) for (const [ci, i] of hits) shift(x.contours[ci].nodes[i], d);
  });
  return true;
}

function* GRIP(id: string, g: W): Cmd {
  const r = yield* point({ prompt: "stretchTo", base: g, preview: (c) => [{ k: "line", a: g, b: c, dash: true }] });
  if (r.k === "point") stretchGrip(id, g, r.p);
}

/** Start a grip stretch (a click on a selected object's grip with no command running). */
export function startGrip(id: string, g: W) {
  if (gen) cancel(true);
  say(`** ${t("cadui.cmd.STRETCH")} **`);
  useCmd.setState({ name: "GRIP", lastPt: g });
  gen = GRIP(id, g);
  step(undefined);
}

/**
 * EXPLODE: an inserted block (its group) gives up its members to the group around it; a polyline becomes its lines
 * and arcs (one object each; the Bézier pieces of one arc stay together; a whole circle stays a circle).
 */
export function explodeNodes(ids: string[]): number {
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad || !ids.length) return 0;
  const groups = page.groups ?? [];
  const blockGroups = new Set<string>();
  const vectors: string[] = [];
  for (const id of ids) {
    const n = nodeOf(id);
    if (!n || n.locked) continue;
    let g = groups.find((x) => x.id === n.groupId);
    // a text drawn as several nodes stays whole: the block around it is what explodes
    if (g?.cad?.text) g = groups.find((x) => x.id === g!.parentId);
    // one level: the outermost block below the layer (AutoCAD explodes the insert, not the blocks nested in it)
    for (let i = 0; g?.parentId && !g.cad?.layer && i < 64; i++) {
      const up = groups.find((x) => x.id === g!.parentId);
      if (!up || (up.cad?.layer && !up.parentId) || !up.cad?.block) break;
      g = up;
    }
    if (g && g.parentId && !g.cad?.layer) blockGroups.add(g.id);
    else if (n.type === "VECTOR") vectors.push(id);
  }
  // pieces of each polyline: [contour, first segment, last segment]
  const pieces = new Map<string, [number, number, number][]>();
  for (const id of vectors) {
    const n = nodeOf(id) as VectorNode;
    const out: [number, number, number][] = [];
    n.contours.forEach((c, ci) => {
      const segs = nodeSegs(n, cad).filter((s) => s.ci === ci);
      if (!segs.length) return;
      const arcs = segs.map(arcOf);
      const sameArc = (i: number, j: number) => !!arcs[i] && !!arcs[j] && dist(arcs[i]!.c, arcs[j]!.c) < 1e-6 && Math.abs(arcs[i]!.r - arcs[j]!.r) < 1e-6;
      if (c.closed && segs.every((_, i) => sameArc(0, i))) return void out.push([ci, -1, -1]);
      let from = 0;
      for (let i = 1; i <= segs.length; i++)
        if (i === segs.length || !sameArc(i - 1, i) || segs[i].si !== segs[i - 1].si + 1) {
          out.push([ci, segs[from].si, segs[i - 1].si]);
          from = i;
        }
    });
    if (out.length > 1) pieces.set(id, out);
  }
  if (!blockGroups.size && !pieces.size) return 0;
  let made = 0;
  S().commit(t("cadui.cmd.EXPLODE"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const gid of blockGroups) {
      const g = pg.groups?.find((x) => x.id === gid);
      if (!g) continue;
      for (const n of pg.nodes) if (n.groupId === gid) n.groupId = g.parentId ?? undefined;
      for (const x of pg.groups ?? []) if (x.parentId === gid) x.parentId = g.parentId;
      pg.groups = pg.groups!.filter((x) => x.id !== gid);
      made++;
    }
    for (const [id, list] of pieces) {
      const i = pg.nodes.findIndex((x) => x.id === id);
      if (i < 0) continue;
      const src = JSON.parse(JSON.stringify(pg.nodes[i])) as VectorNode;
      const fresh = list.map(([ci, a, b]): VectorNode => {
        const c = src.contours[ci];
        let contour: Contour;
        if (a < 0) contour = c;
        else {
          const N = c.nodes.length;
          const nodes = [];
          for (let k = a; k <= b + 1; k++) nodes.push({ ...c.nodes[k % N] });
          nodes[0] = { ...nodes[0], handleIn: nodes[0].anchor, isCorner: true };
          const z = nodes.length - 1;
          nodes[z] = { ...nodes[z], handleOut: nodes[z].anchor, isCorner: true };
          contour = { closed: false, nodes };
        }
        const straight = contour.nodes.length === 2 && contour.nodes.every((q) => q.handleIn[0] === q.anchor[0] && q.handleIn[1] === q.anchor[1] && q.handleOut[0] === q.anchor[0] && q.handleOut[1] === q.anchor[1]);
        return { ...JSON.parse(JSON.stringify(src)), id: uid(), name: straight ? t("cadui.ent.line") : a < 0 ? src.name : t("cadui.ent.arc"), contours: [contour] };
      });
      pg.nodes.splice(i, 1, ...(fresh as any));
      made++;
    }
  });
  S().set({ selection: [] });
  return made;
}

function* EXPLODE(): Cmd {
  const ids = yield* selectObjects();
  const n = explodeNodes(ids);
  say(n ? t("cadui.msg.exploded", { n }) : t("cadui.msg.cannotExplode"));
}

const reverseAnchors = (nodes: Contour["nodes"]): Contour["nodes"] => nodes.map((q) => ({ ...q, handleIn: q.handleOut, handleOut: q.handleIn })).reverse();

/**
 * JOIN: open lines, arcs and polylines whose ends meet (within 1e-6 drawing units … 0.01 % of the size) become one
 * polyline in the first object; it closes when its ends meet. Others stay as they were.
 */
export function joinNodes(ids: string[]): number {
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad) return 0;
  const vs = ids.map(nodeOf).filter((n): n is VectorNode => n?.type === "VECTOR" && !n.locked);
  type Part = { id: string; nodes: Contour["nodes"] };
  const parts: Part[] = [];
  for (const n of vs) for (const c of n.contours) if (!c.closed && c.nodes.length >= 2) parts.push({ id: n.id, nodes: mapAnchors(c.nodes, nodeMat(n)) });
  if (parts.length < 2) return 0;
  const tol = 1e-6 * cad.k;
  const chain = parts.shift()!;
  let nodes = chain.nodes;
  const used = new Set<string>([chain.id]);
  let joined = 0;
  for (let grew = true; grew; ) {
    grew = false;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const s = nodes[0].anchor, e = nodes[nodes.length - 1].anchor;
      const ps = p.nodes[0].anchor, pe = p.nodes[p.nodes.length - 1].anchor;
      let add: Contour["nodes"] | null = null, atEnd = true;
      if (dist(e, ps) < tol) add = p.nodes;
      else if (dist(e, pe) < tol) add = reverseAnchors(p.nodes);
      else if (dist(s, pe) < tol) (add = p.nodes), (atEnd = false);
      else if (dist(s, ps) < tol) (add = reverseAnchors(p.nodes)), (atEnd = false);
      if (!add) continue;
      if (atEnd) {
        const last = { ...nodes[nodes.length - 1], handleOut: add[0].handleOut, isCorner: true };
        nodes = [...nodes.slice(0, -1), last, ...add.slice(1)];
      } else {
        const first = { ...nodes[0], handleIn: add[add.length - 1].handleIn, isCorner: true };
        nodes = [...add.slice(0, -1), first, ...nodes.slice(1)];
      }
      used.add(p.id);
      parts.splice(i--, 1);
      joined++;
      grew = true;
    }
  }
  if (!joined) return 0;
  let closed = false;
  if (nodes.length > 2 && dist(nodes[0].anchor, nodes[nodes.length - 1].anchor) < tol) {
    const z = nodes.pop()!;
    nodes[0] = { ...nodes[0], handleIn: z.handleIn, isCorner: true };
    closed = true;
  }
  // objects whose every open contour went into the chain go; the first keeps the chain and its closed contours
  const first = vs.find((n) => n.id === chain.id)!;
  const gone = new Set([...used].filter((id) => id !== first.id && !parts.some((p) => p.id === id)));
  S().commit(t("cadui.cmd.JOIN"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const x = pg.nodes.find((q) => q.id === first.id) as Draft<VectorNode> | undefined;
    if (!x) return;
    const M = nodeMat(x as unknown as SceneNode);
    const keep = x.contours.filter((c) => c.closed).map((c) => ({ closed: true, nodes: mapAnchors(c.nodes as Contour["nodes"], M) }));
    const rest = parts.filter((p) => p.id === first.id).map((p) => ({ closed: false, nodes: p.nodes }));
    x.contours = [...keep, { closed, nodes }, ...rest] as any;
    x.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
    x.name = t("cadui.ent.pline");
    pg.nodes = pg.nodes.filter((q) => !gone.has(q.id)) as any;
  });
  S().set({ selection: [first.id] });
  return joined;
}

function* JOIN(): Cmd {
  const ids = yield* selectObjects();
  const n = joinNodes(ids);
  say(n ? t("cadui.msg.joined", { n: n + 1 }) : t("cadui.msg.cannotJoin"));
}

let filletR = 0;

/**
 * FILLET of two lines (or the end segments of open polylines): both are trimmed or extended to the arc of radius r
 * tangent to them (r = 0: to their corner), keeping the picked sides; the arc is added after the first object.
 */
export function filletAt(idA: string, pA: W, idB: string, pB: W, r: number): boolean {
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad || idA === idB) return false;
  type End = { id: string; ci: number; i: number; far: W; u: W };
  const X0 = (() => {
    const pick = (id: string, p: W) => {
      const n = nodeOf(id);
      if (n?.type !== "VECTOR" || n.locked) return null;
      const segs = nodeSegs(n, cad);
      if (!segs.length) return null;
      const s = segs.reduce((b, x) => (nearest(x, p).d < nearest(b, p).d ? x : b), segs[0]);
      if (s.c1 || n.contours[s.ci].closed) return null;
      return { n, s, q: nearest(s, p).p };
    };
    const a = pick(idA, pA), b = pick(idB, pB);
    if (!a || !b) return null;
    const da = sub(a.s.b, a.s.a), db = sub(b.s.b, b.s.a);
    const den = da[0] * db[1] - da[1] * db[0];
    if (Math.abs(den) < 1e-12 * Math.hypot(...da) * Math.hypot(...db)) return null;
    const tt = ((b.s.a[0] - a.s.a[0]) * db[1] - (b.s.a[1] - a.s.a[1]) * db[0]) / den;
    const X: W = [a.s.a[0] + da[0] * tt, a.s.a[1] + da[1] * tt];
    const end = (x: typeof a): End | null => {
      // the end of the picked segment on the corner's side moves; it must be an end of its contour
      let u = sub(x.q, X);
      const ul = Math.hypot(...u);
      if (ul < 1e-9) u = dist(x.s.a, X) > dist(x.s.b, X) ? sub(x.s.a, X) : sub(x.s.b, X);
      const L = Math.hypot(...u) || 1;
      u = [u[0] / L, u[1] / L];
      const moveA = (x.s.a[0] - X[0]) * u[0] + (x.s.a[1] - X[1]) * u[1] < (x.s.b[0] - X[0]) * u[0] + (x.s.b[1] - X[1]) * u[1];
      const nodes = x.n.contours[x.s.ci].nodes;
      const i = moveA ? x.s.si : x.s.si + 1;
      if (i !== 0 && i !== nodes.length - 1) return null;
      return { id: x.n.id, ci: x.s.ci, i, far: moveA ? x.s.b : x.s.a, u };
    };
    const ea = end(a), eb = end(b);
    return ea && eb ? { X, ea, eb } : null;
  })();
  if (!X0) return false;
  const { X, ea, eb } = X0;
  let ta = X, tb = X;
  let arc: { c: W; a0: number; a1: number } | null = null;
  if (r > 0) {
    const cos = ea.u[0] * eb.u[0] + ea.u[1] * eb.u[1];
    const half = Math.acos(Math.max(-1, Math.min(1, cos))) / 2;
    if (half < 1e-6 || half > Math.PI / 2 - 1e-6) return false;
    const dd = r / Math.tan(half);
    // the arc must fit on both lines
    if (dd > dist(X, ea.far) + 1e-9 || dd > dist(X, eb.far) + 1e-9) return false;
    ta = [X[0] + ea.u[0] * dd, X[1] + ea.u[1] * dd];
    tb = [X[0] + eb.u[0] * dd, X[1] + eb.u[1] * dd];
    const bis: W = [ea.u[0] + eb.u[0], ea.u[1] + eb.u[1]];
    const bl = Math.hypot(...bis);
    const c: W = [X[0] + (bis[0] / bl) * (r / Math.sin(half)), X[1] + (bis[1] / bl) * (r / Math.sin(half))];
    let a0 = angleOf(c, ta), a1 = angleOf(c, tb);
    while (a1 <= a0) a1 += 2 * Math.PI;
    if (a1 - a0 > Math.PI) [a0, a1] = [angleOf(c, tb), angleOf(c, ta) + (angleOf(c, ta) <= angleOf(c, tb) ? 2 * Math.PI : 0)];
    arc = { c, a0, a1 };
  }
  const m = wToPage(cad);
  S().commit(t("cadui.cmd.FILLET"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const [e, p] of [[ea, ta], [eb, tb]] as const) {
      const x = pg.nodes.find((q) => q.id === e.id) as Draft<VectorNode> | undefined;
      const q = x?.contours[e.ci]?.nodes[e.i];
      if (!x || !q) continue;
      const L = mul(invert(nodeMat(x as unknown as SceneNode)), m);
      const to = ap(L, p);
      shift(q, [to[0] - q.anchor[0], to[1] - q.anchor[1]]);
    }
    if (arc) {
      const i = pg.nodes.findIndex((q) => q.id === ea.id);
      const src = pg.nodes[i] as Draft<VectorNode>;
      const n = newVector([{ closed: false, nodes: mapAnchors(arcAnchors(arc.c, r, arc.a0, arc.a1), m) }], t("cadui.ent.arc"));
      // (an arc is a curve: newVector's default fill would draw it, and export it, as a filled region)
      n.fill = null;
      n.stroke = src.stroke;
      n.strokeWidth = src.strokeWidth;
      n.groupId = src.groupId;
      if (src.cadLayer) n.cadLayer = src.cadLayer;
      pg.nodes.splice(i + 1, 0, n as any);
    }
  });
  return true;
}

function* FILLET(): Cmd {
  for (;;) {
    const a = yield { k: "pick", prompt: "filletFirst", opts: ["radius"], vars: { r: fmt(filletR) } };
    if (a.k === "opt" && a.key === "radius") {
      const r = yield* point({ prompt: "filletRadius", number: true, def: fmt(filletR) });
      if (r.k === "number" && r.v >= 0) filletR = r.v;
      continue;
    }
    if (a.k !== "pick") return;
    const b = yield { k: "pick", prompt: "filletSecond" };
    if (b.k !== "pick") return;
    if (!filletAt(a.id, a.p, b.id, b.p, filletR)) say(t("cadui.msg.cannotFillet"));
    return;
  }
}

/** ARRAY (rectangular): copies of the objects in rows and columns, one undo step. */
export function arrayRect(ids: string[], cols: number, rows: number, dx: number, dy: number): string[] {
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad || !ids.length || cols < 1 || rows < 1 || cols * rows > 10000) return [];
  const made: string[] = [];
  const fresh = new Map<string, string>();
  S().commit(t("cadui.cmd.ARRAY"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const set = new Set(textParts(page, ids));
    for (let i = pg.nodes.length - 1; i >= 0; i--) {
      const src = pg.nodes[i];
      if (!set.has(src.id)) continue;
      const copies: SceneNode[] = [];
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          if (!r && !c) continue;
          const n = JSON.parse(JSON.stringify(src)) as SceneNode;
          n.id = uid();
          regroupCopy(pg as Draft<Page>, n as Draft<SceneNode>, `${r},${c}`, fresh, translate(c * dx, r * dy));
          mapNode(n, mul(wToPage(cad), mul(translate(c * dx, r * dy), pageToW(cad))));
          copies.push(n);
          made.push(n.id);
        }
      pg.nodes.splice(i + 1, 0, ...(copies as any));
    }
  });
  return made;
}

let arrayLast = { cols: 4, rows: 3, dx: 0, dy: 0 };

function* ARRAY(): Cmd {
  const ids = yield* selectObjects();
  if (!ids.length) return;
  const page = currentPage(), cad = cadOfPage(page);
  if (!page || !cad) return;
  // default spacing: the selection's size and a half
  const segs = ids.flatMap(segsOf);
  const b = segs.length ? bbox(segs) : [0, 0, 1, 1];
  const L = arrayLast;
  // (a selection with no width or height — a vertical or horizontal line — uses its other side: a spacing of 0 would
  // stack every copy on the original; 2026-11-23 a vertical line offered 0)
  const bw = b[2] - b[0], bh = b[3] - b[1], side = Math.max(bw, bh, 1);
  const dx0 = L.dx || (bw > 1e-6 ? bw : side) * 1.5, dy0 = L.dy || (bh > 1e-6 ? bh : side) * 1.5;
  const ask = function* (prompt: string, def: number, whole: boolean): Generator<Req, number | null, Ans> {
    for (;;) {
      const r = yield* point({ prompt, number: true, def: fmt(def) });
      if (r.k === "enter") return def;
      if (r.k === "number" && (!whole || (r.v >= 1 && Number.isInteger(r.v)))) return r.v;
      if (r.k !== "number") return null;
    }
  };
  const cols = yield* ask("arrayCols", L.cols, true);
  if (cols === null) return;
  const rows = yield* ask("arrayRows", L.rows, true);
  if (rows === null) return;
  const dx = cols > 1 ? yield* ask("arrayColSpacing", dx0, false) : dx0;
  if (dx === null) return;
  const dy = rows > 1 ? yield* ask("arrayRowSpacing", dy0, false) : dy0;
  if (dy === null) return;
  arrayLast = { cols, rows, dx, dy };
  const made = arrayRect(ids, cols, rows, dx, dy);
  hooksCad.onArray?.(ids, made, { kind: "rect", cols, rows, dx, dy });
  finishSel();
  say(t("cadui.msg.arrayed", { n: made.length }));
}

/** Commands by canonical name; aliases as AutoCAD's acad.pgp. */
export const COMMANDS: Record<string, () => Cmd> = {
  LINE, PLINE, CIRCLE, ARC, RECTANG, MOVE: () => moveCopy(false), COPY: () => moveCopy(true), ROTATE, SCALE, MIRROR, OFFSET, TRIM, EXTEND, ERASE, ZOOM,
  DIST, AREA, ID, TEXT, DIMLINEAR: () => DIM(false), DIMALIGNED: () => DIM(true), LAYER, U, REDO, EXPLODE, JOIN, FILLET, ARRAYRECT: ARRAY,
};
export const ALIASES: Record<string, string> = {
  L: "LINE", PL: "PLINE", C: "CIRCLE", A: "ARC", REC: "RECTANG", RECTANGLE: "RECTANG", M: "MOVE", CO: "COPY", CP: "COPY", RO: "ROTATE", SC: "SCALE", MI: "MIRROR",
  O: "OFFSET", TR: "TRIM", EX: "EXTEND", E: "ERASE", DEL: "ERASE", Z: "ZOOM", DI: "DIST", AA: "AREA", DT: "TEXT", DTEXT: "TEXT", DLI: "DIMLINEAR", DAL: "DIMALIGNED",
  LA: "LAYER", UNDO: "U", MEASUREGEOM: "DIST", MEA: "DIST", X: "EXPLODE", J: "JOIN", F: "FILLET", AR: "ARRAYRECT", ARRAY: "ARRAYRECT",
};
/** AutoCAD commands (and acad.pgp aliases of them) the drawing screen does not have: named as such, never run as another. */
export const NOT_HERE: Record<string, string> = {};
/** More commands and aliases (ui/cad/more.ts registers the rest of the drawing screen's commands). */
export function registerCommands(cmds: Record<string, () => Cmd>, aliases: Record<string, string>, missing: Record<string, string> = {}) {
  Object.assign(COMMANDS, cmds);
  Object.assign(ALIASES, aliases);
  Object.assign(NOT_HERE, missing);
}
export const resolve = (s: string): string | null => {
  // an alias written with its dash (-CH = CHANGE, not CH) is its own; else the _ . - prefixes go, as in AutoCAD
  const raw = s.trim().toUpperCase().replace(/^[_.]+/, "");
  if (ALIASES[raw]) return ALIASES[raw];
  if (NOT_HERE[raw]) return null;
  const u = raw.replace(/^-+/, "");
  if (COMMANDS[u]) return u;
  return ALIASES[u] ?? null;
};
/**
 * Command names and aliases starting with `prefix` (AutoComplete list): the command the text names exactly (a name
 * or an acad.pgp alias) first, then the others — so E + Enter is ERASE, not EXTEND (QA bux2 2026-11-24).
 */
export function complete(prefix: string): string[] {
  const p = prefix.trim().toUpperCase().replace(/^[_.-]+/, "");
  if (!p) return [];
  const out = new Set<string>();
  const exact = resolve(p);
  if (exact) out.add(exact);
  for (const [k, v] of Object.entries(ALIASES)) if (k.startsWith(p)) out.add(v);
  for (const k of Object.keys(COMMANDS)) if (k.startsWith(p)) out.add(k);
  return [...out].slice(0, 8);
}

// ───────── runner ─────────

let gen: Cmd | null = null;

export const promptText = (r: Req | null): string => {
  if (!r) return t("cadui.p.command");
  let s = t(`cadui.p.${r.prompt}`, r.vars);
  if (r.opts?.length) s += ` [${r.opts.map((o) => `${t(`cadui.o.${o}`)}(${OPT_KEY[o] ?? o[0].toUpperCase()})`).join("/")}]`;
  if (r.def) s += ` <${r.def}>`;
  return s + ":";
};

function step(a: Ans | undefined) {
  if (!gen) return;
  let r: IteratorResult<Req, void>;
  try {
    r = gen.next(a as Ans);
  } catch (e) {
    console.error(e);
    r = { done: true, value: undefined };
  }
  if (r.done) {
    gen = null;
    useCmd.setState((s) => ({ name: null, req: null, tick: s.tick + 1 }));
    return;
  }
  useCmd.setState((s) => ({ req: r.value as Req, tick: s.tick + 1 }));
}

/** Start a command by name or alias; false when there is none. */
export function run(input: string): boolean {
  const name = resolve(input);
  if (!name) {
    const raw = input.trim().toUpperCase().replace(/^[_.]+/, "");
    const u = NOT_HERE[raw] ? raw : raw.replace(/^-+/, "");
    if (NOT_HERE[u]) say(t("cadfeat.msg.notHere", { cmd: u, name: NOT_HERE[u] }));
    else say(t("cadui.msg.unknown", { cmd: input.trim().toUpperCase() }));
    return false;
  }
  if (gen) cancel(true);
  say(`${t("cadui.p.command")}: ${input.trim().toUpperCase()}`);
  useCmd.setState((s) => ({ name, last: name === "U" ? s.last : name, recent: [name, ...s.recent.filter((x) => x !== name)].slice(0, 8) }));
  gen = COMMANDS[name]();
  step(undefined);
  return true;
}

export function cancel(quiet = false) {
  if (!gen) return;
  try {
    gen.return();
  } catch {}
  gen = null;
  useCmd.setState((s) => ({ name: null, req: null, tick: s.tick + 1 }));
  if (!quiet) say(t("cadui.msg.cancel"));
}

export const active = () => !!gen;

/** Answer the current request. */
export function answer(a: Ans) {
  const r = useCmd.getState().req;
  if (!gen || !r) return;
  if (a.k === "point") useCmd.setState({ lastPt: a.p });
  step(a);
}

/**
 * What the command line sends: an option letter / name, a coordinate or number, free text (TEXT), a command name
 * when nothing runs, or "" (Enter / Space: the default, finish, or repeat the last command).
 */
export function submit(text: string) {
  const s = text.trim();
  const st = useCmd.getState();
  if (!gen) {
    if (!s) {
      if (st.last) run(st.last);
      return;
    }
    run(s);
    return;
  }
  const r = st.req!;
  if (s) say(`${promptText(r)} ${s}`);
  if (r.k === "text") return answer(s ? { k: "text", s } : { k: "enter" });
  if (!s) {
    if (r.def !== undefined && r.k !== "select") {
      const e = parseEntry(r.def, st.lastPt);
      if (e) return answer(e.k === "point" ? { k: "point", p: e.p } : { k: "number", v: e.v });
      const o = r.opts?.find((x) => t(`cadui.o.${x}`) === r.def || x === r.def);
      if (o) return answer({ k: "opt", key: o });
    }
    return answer({ k: "enter" });
  }
  const up = s.toUpperCase();
  const opt = r.opts?.find((o) => (OPT_KEY[o] ?? "") === up || o.toUpperCase() === up || t(`cadui.o.${o}`).toUpperCase() === up);
  if (opt) return answer({ k: "opt", key: opt });
  if (r.k === "select" && (up === "ALL" || up === "A")) return void (bridge as any).selectAll?.(true);
  if (r.k === "select" && (up === "F" || up === "FENCE")) return answer({ k: "opt", key: "fence" });
  if (r.k === "select" && (up === "L" || up === "LAST" || up === "P" || up === "PREVIOUS")) {
    const page = currentPage();
    const ids = (up[0] === "L" ? lastMade : prevSel).filter((id) => page?.nodes.some((n) => n.id === id));
    if (ids.length) S().set({ selection: [...new Set([...S().selection, ...ids])] });
    return say(t("cadfeat.msg.found", { n: ids.length }));
  }
  const e = parseEntry(s, st.lastPt);
  if (e && (r.k === "point" || r.k === "key")) return answer(e.k === "point" ? { k: "point", p: e.p } : { k: "number", v: e.v });
  if (r.k === "point" && (r.prompt === "zoom" || r.prompt === "plScale")) return answer({ k: "text", s });
  say(t("cadui.msg.invalid"));
}

/** Command line helpers used by tests and the ribbon. */
export const lastPoint = () => useCmd.getState().lastPt;
export const pageCad = () => cadOfPage(currentPage());
export const _test = { findPage };
/** The pieces more.ts builds its commands from. */
export const parts = { point, selectObjects, finishSel: () => finishSel(), segsOf, nodeOf, invert, bbox, cutsOn, done, toWorld, toLocal, regroupCopy, shift };
void constrain;
