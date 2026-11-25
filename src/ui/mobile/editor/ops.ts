// Phone editor commands (docs/MOBILE_PLAN.md §3.8): every edit is an undoable step on the desktop engine's own document
// store (core/store.ts commit / replaceDoc / gestures), so the phone and the desktop write the same files from the same
// model. Format-specific edits reuse the desktop's own code: PSD text layers (ui/psdText/psdTextRender applyPsdText),
// sheet cells (ui/sheet/sheetActions enterText), drawing layers (ui/cad/layers), PDF text promotion (io/pdf
// elevatePdfText). Nothing here draws: the screen is MobileEditor.tsx.

import { produce } from "immer";
import { applyTransform, invertTransform } from "../../../core/geom";
import { nodeBounds } from "../../../core/loom";
import { groupIndex, lockedInTree, pickableOn, reorderInGroups } from "../../../core/layerTree";
import { currentPage, draftPage, findPage, useStore } from "../../../core/store";
import { layoutText } from "../../../core/text";
import { copyNode, newText, newVector, uid, type OmwDocument, type Page, type SceneNode, type TextNode, type TextRun, type Vec2, type VectorAnchor, type VectorNode } from "../../../core/types";
import { distanceToContour, ellipseContour, pointInContours, rectContour } from "../../../core/vector";
import { isFlowSegment, reflowSegment, segmentAt } from "../../../core/flow";
import { t } from "../../../i18n";

const S = () => useStore.getState();

/** What kind of editing a page gets on the phone. */
export type EditKind = "doc" | "slide" | "sheet" | "psd" | "vector" | "cad" | "pdf" | "design";

export function editKindOf(page: Page | undefined): EditKind {
  if (!page) return "design";
  const f = page.source?.format;
  if (page.sheet) return "sheet";
  if (page.source?.cad || f === "dxf" || f === "dwg") return "cad";
  if (f === "psd") return "psd";
  // a PDF page — an .ai saved PDF compatible too: its text is edited after the desktop's text promotion
  if (page.nodes.some((n) => n.type === "PDF")) return "pdf";
  if (f === "ai" || f === "svg") return "vector";
  if (page.kind === "SLIDE") return "slide";
  if (page.kind === "DOCUMENT") return "doc";
  return "design";
}

// ───────── picking ─────────

/** Objects under a page point, top first: shown, in shown and unlocked groups. */
export function nodesAt(page: Page, p: Vec2, slop = 0): SceneNode[] {
  const pick = pickableOn(page);
  return [...page.nodes].reverse().filter((n) => {
    if (!n.visible || !pick(n) || n.notes) return false;
    const b = nodeBounds(n);
    return p[0] >= b.x - slop && p[0] <= b.x + b.w + slop && p[1] >= b.y - slop && p[1] <= b.y + b.h + slop;
  });
}

/** The object a tap picks: the top one, skipping a full-page PDF background or locked layers unless nothing else is there. */
export function pickAt(page: Page, p: Vec2, slop = 0): SceneNode | null {
  const idx = groupIndex(page.groups);
  // a drawn shape counts where its lines are (or inside, when filled), not anywhere in its box: on a drawing a line
  // under the finger is picked, not the outline round the whole plan whose box covers everything (phone check
  // 2026-11-24: on a DXF the whole drawing moved instead of one line)
  const all = nodesAt(page, p, slop).filter((n) => !n.locked && !lockedInTree(n, idx) && (n.type !== "VECTOR" || onShape(n as VectorNode, p, slop)));
  // a table under the finger wins over the body text whose box it sits in (a Word page: the table is laid out inside
  // the flow's frame, and a tap on a cell used to open the paragraph after the table)
  const table = all.find((n) => n.type === "TABLE");
  if (table) return table;
  // of several text boxes there, the one with a line of text under the finger (frames overlap on a page)
  const onLine = all.find((n) => n.type === "TEXT" && lineAt(n as TextNode, p) >= 0);
  if (onLine) return onLine;
  return all.find((n) => n.type !== "PDF") ?? null;
}

/** a point on (within `slop` of) a shape's lines, or inside it where it is filled */
function onShape(n: VectorNode, p: Vec2, slop: number): boolean {
  const lp = invertTransform(n.transform, p);
  const k = Math.abs(n.transform.scale) || 1;
  if (n.fill && pointInContours(n, lp)) return true;
  const tol = slop / k + (n.strokeWidth ?? 1) / 2;
  return n.contours.some((c) => distanceToContour(c, lp) <= tol);
}

/** the laid-out line of a text object at a page point, or -1 */
function lineAt(n: TextNode, p: Vec2): number {
  const [, ly] = invertTransform(n.transform, p);
  const lines = layoutText(n).lines;
  return lines.findIndex((l) => ly >= l.y && ly < l.y + l.height);
}

/** The paragraph of a text object at a page point (its laid-out line), and the character offset nearest to it. */
export function paragraphAt(n: TextNode, p: Vec2): number {
  const [, ly] = invertTransform(n.transform, p);
  const lines = layoutText(n).lines;
  for (const l of lines) if (ly >= l.y && ly < l.y + l.height) return l.paragraph;
  if (!lines.length) return 0;
  return ly < lines[0].y ? lines[0].paragraph : lines[lines.length - 1].paragraph;
}

/** Objects that belong to the body flow of a document (a Word / 한글 page): edited as text, never moved. */
export const isFlowNode = (n: SceneNode) => !!n.flow || !!n.notes;

// ───────── generic object edits ─────────

export function select(ids: string[]) {
  S().set({ selection: ids });
}

export function updateNodes(ids: string[], label: string, fn: (n: any) => void) {
  const s = S();
  s.commit(label, (d) => {
    const pg = draftPage(d, s.pageId);
    pg?.nodes.forEach((n) => ids.includes(n.id) && fn(n));
  });
}

export function deleteNodes(ids: string[]) {
  const s = S();
  const set = new Set(ids);
  s.commit(t("doc.history.delete"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    pg.nodes = pg.nodes.filter((n) => !set.has(n.id) || n.locked);
    pg.animations = pg.animations.filter((a) => !set.has(a.targetNodeId));
  });
  S().set({ selection: [] });
}

export function duplicateNodes(ids: string[]): string[] {
  const s = S();
  const page = currentPage();
  if (!page) return [];
  const nodes = page.nodes.filter((n) => ids.includes(n.id) && !isFlowNode(n));
  if (!nodes.length) return [];
  const copies = nodes.map((n) => ({ ...copyNode(n, uid()), name: t("doc.copyName", { name: n.name }), transform: { ...n.transform, x: n.transform.x + 20, y: n.transform.y + 20 } }));
  s.commit(t("doc.history.duplicate"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    // right above each original (in its layer group)
    for (const c of copies as SceneNode[]) {
      const src = nodes[copies.indexOf(c as any)];
      const at = pg.nodes.findIndex((n) => n.id === src.id);
      pg.nodes.splice(at + 1, 0, c as any);
    }
  });
  S().set({ selection: copies.map((c) => c.id) });
  return copies.map((c) => c.id);
}

export function reorder(ids: string[], where: "up" | "down" | "top" | "bottom") {
  const s = S();
  const set = new Set(ids);
  s.commit(t("doc.history.reorder"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const arr = pg.nodes as SceneNode[];
    if (pg.groups?.length) return void (pg.nodes = reorderInGroups(arr, pg.groups, set, where) as any);
    if (where === "top") pg.nodes = [...arr.filter((n) => !set.has(n.id)), ...arr.filter((n) => set.has(n.id))] as any;
    else if (where === "bottom") pg.nodes = [...arr.filter((n) => set.has(n.id)), ...arr.filter((n) => !set.has(n.id))] as any;
    else if (where === "up") {
      for (let i = arr.length - 2; i >= 0; i--) if (set.has(arr[i].id) && !set.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    } else for (let i = 1; i < arr.length; i++) if (set.has(arr[i].id) && !set.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
  });
}

/** Group (folder) visibility / lock — PSD groups, drawing layers alike. */
export function updateGroup(groupId: string, label: string, fn: (g: any) => void) {
  const s = S();
  s.commit(label, (d) => {
    const g = draftPage(d, s.pageId)?.groups?.find((x) => x.id === groupId);
    if (g) fn(g);
  });
}

// ───────── move / scale / rotate (one gesture = one undo step) ─────────

export interface XformStart {
  ids: string[];
  /** transforms when the gesture began */
  start: Map<string, SceneNode["transform"]>;
  /** pivot (page px): the selection's centre */
  pivot: Vec2;
}

export function beginXform(ids: string[]): XformStart | null {
  const page = currentPage();
  if (!page) return null;
  const nodes = page.nodes.filter((n) => ids.includes(n.id) && !n.locked && !isFlowNode(n));
  if (!nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) {
    const b = nodeBounds(n);
    x0 = Math.min(x0, b.x), y0 = Math.min(y0, b.y), x1 = Math.max(x1, b.x + b.w), y1 = Math.max(y1, b.y + b.h);
  }
  S().beginGesture();
  return { ids: nodes.map((n) => n.id), start: new Map(nodes.map((n) => [n.id, { ...n.transform }])), pivot: [(x0 + x1) / 2, (y0 + y1) / 2] };
}

/** Move by (dx, dy), then scale by k and rotate by deg about the pivot (page px). */
export function updateXform(x: XformStart, dx: number, dy: number, k = 1, deg = 0) {
  const s = S();
  const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
  const [px, py] = x.pivot;
  s.updateGesture((d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    for (const n of pg.nodes) {
      const t0 = x.start.get(n.id);
      if (!t0) continue;
      // the node origin relative to the pivot, scaled and turned, then moved
      const ox = (t0.x - px) * k, oy = (t0.y - py) * k;
      n.transform.x = px + ox * c - oy * sn + dx;
      n.transform.y = py + ox * sn + oy * c + dy;
      n.transform.rotation = t0.rotation + deg;
      n.transform.scale = t0.scale * k;
      if (t0.scaleY !== undefined) n.transform.scaleY = t0.scaleY * k;
    }
  });
}

export function endXform(label = t("mobile.ed.h.transform")) {
  S().endGesture(label);
}

// ───────── text ─────────

const runsText = (runs: readonly TextRun[]) => runs.map((r) => r.text).join("");

/**
 * The runs of a paragraph with its text replaced by `next`: the unchanged start and end keep their runs (and formats);
 * what was typed in between takes the format of the run it was typed into.
 */
export function retypeRuns(runs: readonly TextRun[], next: string): TextRun[] {
  const old = runsText(runs);
  if (old === next) return runs as TextRun[];
  if (!runs.length) return [{ ...newText("").paragraphs[0].runs[0], text: next }];
  let p = 0;
  while (p < old.length && p < next.length && old[p] === next[p]) p++;
  let s = 0;
  while (s < old.length - p && s < next.length - p && old[old.length - 1 - s] === next[next.length - 1 - s]) s++;
  const ins = next.slice(p, next.length - s);
  const delEnd = old.length - s;
  // the run the typed text joins: the one holding the character before it (typing on at a word's end keeps its
  // format), else the first
  let host = 0;
  {
    let at = 0;
    for (let i = 0; i < runs.length; i++) {
      const b = at + runs[i].text.length;
      if (p > 0 && p - 1 >= at && p - 1 < b) {
        host = i;
        break;
      }
      at = b;
    }
  }
  const out: TextRun[] = [];
  let at = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    const a = at, b = at + r.text.length;
    at = b;
    // keep [a, p) and [delEnd, b) of this run
    let text = "";
    if (a < p) text += r.text.slice(0, Math.min(r.text.length, p - a));
    if (i === host) text += ins;
    if (b > delEnd) text += r.text.slice(Math.max(0, delEnd - a));
    if (text || i === host) out.push({ ...r, text });
  }
  // an object run whose U+FFFC was deleted goes with it
  const clean = out.filter((r) => !r.obj || r.text === "￼");
  return clean.length ? clean : [{ ...runs[0], text: "", obj: undefined, note: undefined }];
}

/** Split runs at character offsets so [a, b) is made of whole runs; returns the runs and the index range. */
function splitAt(runs: readonly TextRun[], a: number, b: number): { runs: TextRun[]; i0: number; i1: number } {
  const out: TextRun[] = [];
  let at = 0, i0 = -1, i1 = -1;
  for (const r of runs) {
    const s = at, e = at + r.text.length;
    at = e;
    if (s === e) {
      // an empty run (an empty paragraph): it is the range when the range is empty there
      if (a <= s && s <= b) {
        if (i0 < 0) i0 = out.length;
        i1 = out.length + 1;
      }
      out.push({ ...r });
      continue;
    }
    const m0 = Math.min(e, Math.max(s, a)), m1 = Math.min(e, Math.max(s, b));
    if (m0 > s) out.push({ ...r, text: r.text.slice(0, m0 - s) });
    if (m1 > m0) {
      if (i0 < 0) i0 = out.length;
      out.push({ ...r, text: r.text.slice(m0 - s, m1 - s) });
      i1 = out.length;
    }
    if (e > m1) out.push({ ...r, text: r.text.slice(m1 - s) });
  }
  return { runs: out, i0: i0 < 0 ? 0 : i0, i1: i1 < 0 ? 0 : i1 };
}

export type RunPatch = Partial<Pick<TextRun, "bold" | "italic" | "underline" | "fontSize" | "color">>;

/** Apply a character format to [a, b) of a paragraph's runs (a = b: the whole paragraph); neighbours that match join. */
export function formatRuns(runs: readonly TextRun[], a: number, b: number, patch: RunPatch): TextRun[] {
  const len = runsText(runs).length;
  if (a >= b) (a = 0), (b = len);
  const sp = splitAt(runs, a, b);
  const out = sp.runs.map((r, i) => (i >= sp.i0 && i < sp.i1 ? { ...r, ...patch } : r));
  // join neighbours with the same format
  const joined: TextRun[] = [];
  for (const r of out) {
    const last = joined[joined.length - 1];
    const { text: _a, ...fa } = last ?? ({} as TextRun);
    const { text: _b, ...fb } = r;
    if (last && !r.obj && !last.obj && !r.note && !last.note && JSON.stringify(fa) === JSON.stringify(fb)) last.text += r.text;
    else joined.push({ ...r });
  }
  return joined.filter((r, i) => r.text || i === 0 || r.obj);
}

/** A document page's body flow laid out again after one of its texts changed (Word / 한글 pages). */
function reflowAround(doc: OmwDocument, pageId: string): OmwDocument {
  const i = doc.pages.findIndex((p) => p.id === pageId);
  if (i < 0) return doc;
  const seg = segmentAt(doc.pages, i);
  if (!isFlowSegment(doc.pages, seg)) return doc;
  try {
    const pages = reflowSegment(doc.pages, seg.start);
    return { ...doc, pages };
  } catch (e) {
    console.warn("reflow after a phone edit failed", e);
    return doc;
  }
}

/** Change one paragraph of a text object: its text (formats kept where the text is unchanged) and/or a format range. */
export function editParagraph(nodeId: string, para: number, change: { text?: string; format?: { a: number; b: number; patch: RunPatch } }, label = t("mobile.ed.h.text")): boolean {
  const s = S();
  const pageId = s.pageId;
  const page = findPage(s.doc, pageId);
  const n0 = page?.nodes.find((n) => n.id === nodeId);
  if (!page || !n0 || n0.type !== "TEXT" || !n0.paragraphs[para]) return false;
  let flowed = false;
  const next = produce(s.doc, (d) => {
    const n = draftPage(d, pageId)?.nodes.find((x) => x.id === nodeId) as TextNode | undefined;
    if (!n) return;
    const p = n.paragraphs[para];
    let runs = p.runs as TextRun[];
    if (change.text !== undefined) runs = retypeRuns(runs, change.text);
    if (change.format) runs = formatRuns(runs, change.format.a, change.format.b, change.format.patch);
    p.runs = runs as any;
    // 한글's saved line breaks hold only while the paragraph is as imported
    if (change.text !== undefined) delete (p as any).hwpLines;
    flowed = !!n.flow;
    d.modified = new Date().toISOString();
  });
  if (next === s.doc) return false;
  s.replaceDoc(label, flowed ? reflowAround(next, pageId) : next);
  return true;
}

/** Text of a paragraph (for the editing sheet). */
export const paragraphText = (n: TextNode, para: number) => runsText(n.paragraphs[para]?.runs ?? []);

// ───────── drawing ─────────

export interface ShapeStyle {
  fill: string | null;
  stroke: string | null;
  width: number;
}

export function addShape(kind: "rect" | "ellipse" | "line", a: Vec2, b: Vec2, st: ShapeStyle): string {
  const x = Math.min(a[0], b[0]), y = Math.min(a[1], b[1]);
  let w = Math.abs(b[0] - a[0]), h = Math.abs(b[1] - a[1]);
  if (kind !== "line" && w < 4 && h < 4) w = h = 120;
  let v: VectorNode;
  if (kind === "line") {
    v = newVector([{ nodes: [corner([a[0], a[1]]), corner([b[0], b[1]])], closed: false }], t("mobile.ed.shape.line"));
    v.fill = null;
    v.stroke = st.stroke ?? "#1d1f24";
    v.strokeWidth = st.width;
  } else {
    v = newVector([kind === "rect" ? rectContour(0, 0, w, h) : ellipseContour(w / 2, h / 2, w / 2, h / 2)], t(kind === "rect" ? "cmd.insert.rect" : "cmd.insert.ellipse"));
    v.fill = st.fill;
    v.stroke = st.stroke;
    v.strokeWidth = st.width;
    v.transform = { x, y, rotation: 0, scale: 1 };
  }
  return addNode(v, t(kind === "line" ? "mobile.ed.h.line" : kind === "rect" ? "shell.hist.drawRect" : "shell.hist.drawEllipse"));
}

const corner = (p: Vec2): VectorAnchor => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true });

/** A freehand pen line (page points) as a smooth path: points thinned, then joined with Catmull-Rom curves. */
export function addPenPath(pts: Vec2[], st: ShapeStyle): string | null {
  const thin: Vec2[] = [];
  for (const p of pts) {
    const l = thin[thin.length - 1];
    if (!l || Math.hypot(p[0] - l[0], p[1] - l[1]) >= Math.max(2, st.width * 0.6)) thin.push(p);
  }
  if (pts.length && thin[thin.length - 1] !== pts[pts.length - 1]) thin.push(pts[pts.length - 1]);
  if (thin.length < 2) return null;
  const nodes: VectorAnchor[] = thin.map((p, i) => {
    const a = thin[Math.max(0, i - 1)], b = thin[Math.min(thin.length - 1, i + 1)];
    const tx = (b[0] - a[0]) / 6, ty = (b[1] - a[1]) / 6;
    return { anchor: p, handleIn: [p[0] - tx, p[1] - ty], handleOut: [p[0] + tx, p[1] + ty], isCorner: false };
  });
  const v = newVector([{ nodes, closed: false }], t("shell.name.line", undefined, "Line"));
  v.fill = null;
  v.stroke = st.stroke ?? "#1d1f24";
  v.strokeWidth = st.width;
  v.strokeCap = "round";
  v.strokeJoin = "round";
  return addNode(v, t("mobile.ed.h.pen"));
}

export function addTextAt(p: Vec2, text: string, size: number, color: string): string {
  const page = currentPage();
  const w = Math.max(80, Math.min(480, (page?.width ?? 600) - p[0]));
  const n = newText(text, w, { fontSize: size, color });
  n.transform = { x: p[0], y: p[1], rotation: 0, scale: 1 };
  return addNode(n, t("mobile.ed.h.addText"));
}

/** Add an object on the current page — inside the layer group of the selected object (a drawing's current layer). */
export function addNode(n: SceneNode, label: string): string {
  const s = S();
  const page = currentPage();
  const sel = page?.nodes.find((x) => s.selection.includes(x.id));
  if (sel?.groupId) n.groupId = sel.groupId;
  if (sel?.cadLayer) n.cadLayer = sel.cadLayer;
  s.commit(label, (d) => void draftPage(d, s.pageId)?.nodes.push(n as any));
  S().set({ selection: [n.id] });
  return n.id;
}

// ───────── measuring (drawings) ─────────

/** Distance between two page points in drawing units, with the unit's symbol. */
export function measure(page: Page, a: Vec2, b: Vec2): { value: number; unit: string; text: string } {
  const cad = page.source?.cad;
  const px = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const k = cad?.k ?? 96 / 25.4;
  const unit = cad ? cad.unit : "mm";
  const value = px / k;
  const text = `${value >= 100 ? value.toFixed(1) : value.toFixed(value >= 10 ? 2 : 3)}${unit ? " " + unit : ""}`;
  return { value, unit, text };
}

/** A page point → drawing coordinates (shown beside a measurement). */
export function drawingPoint(page: Page, p: Vec2): Vec2 {
  const cad = page.source?.cad;
  if (!cad) return p;
  return [cad.ox + p[0] / cad.k, cad.oy - p[1] / cad.k];
}

export { applyTransform };
