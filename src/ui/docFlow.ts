// Typing straight into a document page's body (docs/design/DOC_FLOW.md 4).
//
// The body of a flowing page run (core/flow.ts) is edited as one story: a hidden textarea takes keys, IME composition
// and the clipboard, the caret and selection are drawn over the canvas (ui/FlowEditor.tsx), and the text itself is
// drawn by the canvas from the real layout. Every edit runs the pure functions of core/richtext.ts on the story's
// paragraphs, flows the story again and commits the pages — typing is grouped into one undo step per pause.
//
// Public API for the canvas and the shell (the mode switch calls these): isFlowPage, hitCaret, beginTyping,
// endTyping, flowActive, flowPointerDown / Move / Up, convertToFlow, reflowDocument, flowBreak.

import { create } from "zustand";
import * as RT from "../core/richtext";
import { useStore } from "../core/store";
import {
  caretBox,
  flowLines,
  gatherStory,
  isFlowPageAt,
  isFlowSegment,
  lineIndexOf,
  markFlowInPlace,
  offsetOnLine,
  posAt,
  reanchor,
  reflowPages,
  reflowSegment,
  segmentAt,
  STORY_END,
  flowPageLike,
  type FlowLine,
  type Story,
} from "../core/flow";
import { DEFAULT_MARGINS, normalizeLegacyBreaks } from "../core/pageSetup";
import { withWordDefaults } from "../core/lineSpacing";
import { hfAreaAt } from "../core/headerFooter";
import { fieldNow } from "../core/headerFooter";
import type { OmwDocument, Page, TextParagraph, TextRun } from "../core/types";
import type { ListDef } from "../core/style/types";
import type { ListCtx } from "../core/lists";
import { setRichApi, useRichStatus, type RichApi } from "./RichTextEditor";
import type { Live } from "./shell/ops";
import { t as tx } from "../i18n";
import { docHooks } from "./editModes";
import { PAGE_GAP, docModeNow } from "./docView";
import { bodyBox } from "../core/pageSetup";
import { OBJ_CHAR, newParagraph as makeParagraph, newText, uid, type AssetRef, type SceneNode } from "../core/types";
import { nodeBounds } from "../core/loom";
import { objSize } from "../core/flow";
import { applyNoteAreaEdits, newNoteRun, type NoteKind } from "../core/notes";
import { skipHidden } from "../core/review";

const S = () => useStore.getState();
type Pos = RT.Pos;

export const FLOW_ID_PREFIX = "flow:";

/** View options of the document mode: 텍스트 경계 (the body box drawn as a dotted frame), off by default as in Word. */
export const useDocView = create<{ textBounds: boolean }>(() => ({ textBounds: false }));
export function toggleTextBounds() {
  useDocView.setState({ textBounds: !useDocView.getState().textBounds });
  // repaint the canvas (it redraws on any store change)
  S().set({ view: { ...S().view } });
}
export const flowEditId = (segPageId: string) => FLOW_ID_PREFIX + segPageId;

export interface FlowState {
  active: boolean;
  /** id of the first page of the page run being edited */
  segId: string | null;
  anchor: Pos;
  focus: Pos;
  /** IME text being composed: its story range */
  comp: { p: number; a: number; b: number } | null;
  /** bumped on every caret move (restarts the blink) */
  tick: number;
  /**
   * The caret waits after the picture / table that ends the body (Word: a click below it). No paragraph is there
   * yet — the original file stays as it was — until something is typed (materializeTail).
   */
  tail?: boolean;
}

const ZERO: Pos = { p: 0, o: 0 };
export const useFlow = create<FlowState>(() => ({ active: false, segId: null, anchor: ZERO, focus: ZERO, comp: null, tick: 0 }));
const F = () => useFlow.getState();

// ───────── context ─────────

interface Ctx {
  doc: OmwDocument;
  pages: Page[];
  start: number;
  story: Story;
  lines: FlowLine[];
}

function ctx(): Ctx | null {
  const f = F();
  if (!f.active || !f.segId) return null;
  const doc = S().doc;
  const i = doc.pages.findIndex((p) => p.id === f.segId);
  if (i < 0) return null;
  const seg = segmentAt(doc.pages, i);
  return { doc, pages: doc.pages, start: seg.start, story: gatherStory(doc.pages, seg), lines: flowLines(doc.pages, seg) };
}

const selRange = (): RT.Range => RT.range(F().anchor, F().focus);

function setSel(anchor: Pos, focus: Pos = anchor, keepGoal = false) {
  if (!keepGoal) goalX = null;
  if (pending && !(RT.cmpPos(anchor, focus) === 0 && RT.cmpPos(focus, pending.pos) === 0)) pending = null;
  useFlow.setState({ anchor, focus, tick: F().tick + 1, tail: false });
  pushStatus();
  ensureVisible();
}

// ───────── public: pages ─────────

/** The page has a flowing body (a document page of a run with flow frames). */
export function isFlowPage(page: Page | undefined | null): boolean {
  if (!page) return false;
  const pages = S().doc.pages;
  return isFlowPageAt(pages, pages.findIndex((p) => p.id === page.id));
}

/** Story position under a point of `page` (page coordinates), null when the page does not flow. */
export function hitCaret(page: Page, x: number, y: number): { segId: string; pos: Pos } | null {
  const pages = S().doc.pages;
  const i = pages.findIndex((p) => p.id === page.id);
  if (!isFlowPageAt(pages, i)) return null;
  const seg = segmentAt(pages, i);
  const pos = posAt(flowLines(pages, seg), i, x, y);
  return pos ? { segId: pages[seg.start].id, pos } : null;
}

export const flowActive = () => F().active;

// ───────── typing groups ─────────

let typingOpen = false;
let typingTimer: ReturnType<typeof setTimeout> | undefined;
let goalX: number | null = null;
let pending: { fmt: RT.RunFormat; pos: Pos } | null = null;
let selfWrite = false;

function closeTyping() {
  clearTimeout(typingTimer);
  typingOpen = false;
}

function writePages(pages: Page[], label: string | null) {
  const s = S();
  if (pages === s.doc.pages && label === null) return;
  selfWrite = true;
  try {
    if (label === null && typingOpen) {
      // the same undo step as the typing before it: the step's "before" stays the document before the first key
      useStore.setState({ doc: { ...s.doc, pages, modified: new Date().toISOString() }, dirty: true });
    } else {
      if (label !== null) closeTyping();
      S().commit(label ?? tx("shell.hist.typing"), (d) => {
        d.pages = pages as typeof d.pages;
      });
      absorbProvisional();
      if (label === null) typingOpen = true;
    }
  } finally {
    selfWrite = false;
  }
  if (label === null) {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(closeTyping, 800);
  }
}

/** Put edited story paragraphs back: flow them through the run and commit (label null = typing, grouped). */
function applyParas(paras: TextParagraph[], anchor: Pos, focus: Pos = anchor, label: string | null = null, lists?: ListDef[]) {
  const c = ctx();
  if (!c) return;
  const story: Story = { ...c.story, paras, objs: reanchor(c.story.objs, c.story.paras, paras), lists: lists ?? c.story.lists };
  let pages = reflowSegment(c.pages, c.start, story);
  // list numbers count on into the page runs after this one
  if (paras.some((p) => p.list) || c.story.paras.some((p) => p.list)) pages = renumberLater(pages, c.start);
  writePages(pages, label);
  setSel(RT.clampPos(paras, anchor), RT.clampPos(paras, focus));
}

function renumberLater(pages: Page[], start: number): Page[] {
  const seg = segmentAt(pages, start);
  const frames = pages.slice(seg.start, seg.end).flatMap((p) => p.nodes.filter((n) => n.type === "TEXT" && n.flow));
  const last = frames[frames.length - 1];
  if (!last || seg.end >= pages.length) return pages;
  const copy = pages.map((p) => ({ ...p, nodes: [...p.nodes] }));
  RT.renumberAfter(copy, last.id);
  // keep untouched pages as they were
  return copy.map((p, i) => (p.nodes.every((n, k) => n === pages[i].nodes[k]) ? pages[i] : p));
}

// ───────── status for the ribbon ─────────

function pushStatus() {
  const c = ctx();
  if (!c) return;
  const r = RT.clampRange(c.story.paras, selRange());
  const col = RT.collapsed(r);
  const fmt = col && pending ? pending.fmt : RT.rangeFormat(c.story.paras, r);
  useRichStatus.setState({ active: true, nodeId: flowEditId(F().segId!), fmt, para: RT.paraFormat(c.story.paras, r.start.p, r.end.p), collapsed: col });
  // the frame under the caret is "selected", so the ribbon shows the text tools
  const cb = caretBox(c.lines, F().focus.p, F().focus.o);
  if (cb) {
    const fl = c.lines[lineIndexOf(c.lines, F().focus.p, F().focus.o)];
    if (fl && (S().selection.length !== 1 || S().selection[0] !== fl.node.id)) S().set({ selection: [fl.node.id] });
  }
}

// ───────── keeping the caret in view ─────────

function ensureVisible() {
  const c = ctx();
  if (!c) return;
  const cb = caretBox(c.lines, F().focus.p, F().focus.o);
  if (!cb) return;
  const s = S();
  const page = c.pages[cb.page];
  if (page && page.id !== s.pageId) {
    // the document view shows the pages one under another (ui/docView.ts): shift the view by the pages between, so
    // the text does not jump when the caret moves onto the next page
    const from = c.pages.findIndex((p) => p.id === s.pageId);
    let { panX, panY } = s.view;
    const z = s.view.zoom;
    if (from >= 0 && docModeNow()) {
      const dir = cb.page > from ? 1 : -1;
      for (let j = from; j !== cb.page; j += dir) {
        const a = c.pages[j], b = c.pages[j + dir];
        panY += dir * ((dir > 0 ? a.height : b.height) * z + PAGE_GAP);
        panX += ((a.width - b.width) / 2) * z;
      }
    }
    s.set({ pageId: page.id, view: { zoom: z, panX, panY } });
  }
  const wrap = typeof document !== "undefined" ? (document.querySelector(".canvas-wrap") as HTMLElement | null) : null;
  if (!wrap) return;
  const { zoom, panX, panY } = S().view;
  const H = wrap.clientHeight, W = wrap.clientWidth;
  const sy = cb.y * zoom + panY, sh = cb.h * zoom, sx = cb.x * zoom + panX;
  let ny = panY, nx = panX;
  const pad = 48;
  if (sy < pad) ny += pad - sy;
  else if (sy + sh > H - pad) ny -= sy + sh - (H - pad);
  if (sx < pad) nx += pad - sx;
  else if (sx > W - pad) nx -= sx - (W - pad);
  if (nx !== panX || ny !== panY) S().set({ view: { zoom, panX: nx, panY: ny } });
}

// ───────── begin / end ─────────

let unsub: (() => void) | null = null;

/** Start typing in the body of the page run holding `pageId` (default: the current page) at `pos` (default: its start). */
export function beginTyping(pageId?: string, pos?: Pos): boolean {
  const s = S();
  const pages = s.doc.pages;
  const i = pages.findIndex((p) => p.id === (pageId ?? s.pageId));
  if (!isFlowPageAt(pages, i)) return false;
  const seg = segmentAt(pages, i);
  const segId = pages[seg.start].id;
  const was = F();
  if (was.active && was.segId !== segId) closeTyping();
  const story = gatherStory(pages, seg);
  const at = RT.clampPos(story.paras, pos ?? (i === seg.start ? ZERO : (posAt(flowLines(pages, seg), i, 0, 0) ?? ZERO)));
  pending = null;
  useFlow.setState({ active: true, segId, anchor: at, focus: at, comp: null, tick: was.tick + 1 });
  if (s.editingTextId !== flowEditId(segId)) S().set({ editingTextId: flowEditId(segId) });
  setRichApi(api);
  if (!unsub) unsub = useStore.subscribe(onStore);
  pushStatus();
  ensureVisible();
  focusInput();
  return true;
}

/** Stop typing in the body (the caret goes away; what was typed is already in the document). */
/**
 * Close the body's typing group (a syllable being composed kept first) before another part of the app writes the
 * document — the review pane's 모두 수락 / 거부, recording on / off: that step is its own undo step and the typing after it
 * starts a new one (QA doc-review2).
 */
export function sealTyping() {
  if (compBase) commitComposition();
  closeTyping();
}

export function endTyping() {
  if (!F().active) return;
  closeTyping();
  pending = null;
  useFlow.setState({ active: false, segId: null, comp: null });
  setRichApi(null, api);
  useRichStatus.setState({ active: false, nodeId: null, fmt: {}, para: {}, collapsed: true });
  if (S().editingTextId?.startsWith(FLOW_ID_PREFIX)) S().set({ editingTextId: null, selection: [] });
  unsub?.();
  unsub = null;
  input?.blur();
}

function onStore(s: ReturnType<typeof S>, prev: ReturnType<typeof S>) {
  if (!F().active) return;
  // another editor opened, the page panel switched pages, a document was loaded
  if (s.editingTextId !== flowEditId(F().segId!)) return endTyping();
  if (s.doc === prev.doc || selfWrite) return;
  closeTyping();
  // undo / redo / a command changed the document: keep the caret inside what is there now
  const pages = s.doc.pages;
  const i = pages.findIndex((p) => p.id === F().segId);
  if (i < 0 || !isFlowSegment(pages, segmentAt(pages, i))) return endTyping();
  const story = gatherStory(pages, segmentAt(pages, i));
  const a = RT.clampPos(story.paras, F().anchor), f = RT.clampPos(story.paras, F().focus);
  if (RT.cmpPos(a, F().anchor) || RT.cmpPos(f, F().focus)) useFlow.setState({ anchor: a, focus: f });
  pushStatus();
}

// ───────── the hidden input ─────────

let input: HTMLTextAreaElement | null = null;

/** The editor's textarea (ui/FlowEditor.tsx mounts it). */
export function attachInput(el: HTMLTextAreaElement | null) {
  input = el;
  if (el && F().active) focusInput();
}

export function focusInput() {
  // a dialog (the start screen, a menu dialog) keeps the keyboard
  if (!input || typeof document === "undefined" || document.querySelector('[aria-modal="true"]')) return;
  if (document.activeElement !== input) input.focus({ preventScroll: true });
}

// ───────── editing ─────────

function story(): Story | null {
  return ctx()?.story ?? null;
}

/** The objects (pictures, tables) that end the story — after its last paragraph. */
function tailObjs(st: Story) {
  return st.objs.filter((o) => o.before === STORY_END);
}

/**
 * Is the press at (x, y) of page index `i` below the object that ends the story (where Word puts a caret after a
 * closing picture)?
 */
function belowTail(c: Ctx, i: number, y: number): boolean {
  const ids = new Set(tailObjs(c.story).map((o) => o.node.id));
  if (!ids.size) return false;
  let last: { page: number; bottom: number } | null = null;
  for (let k = c.start; k < c.pages.length; k++)
    for (const n of c.pages[k].nodes) if (ids.has(n.id)) {
      const b = nodeBounds(n);
      if (!last || k > last.page || (k === last.page && b.y + b.h > last.bottom)) last = { page: k, bottom: b.y + b.h };
    }
  return !!last && i === last.page && y > last.bottom;
}

/** Where the caret after the closing object is drawn: page index and page box (FlowEditor). */
export function tailCaret(): { page: number; x: number; y: number; h: number } | null {
  const c = ctx();
  if (!c || !F().tail) return null;
  const ids = new Set(tailObjs(c.story).map((o) => o.node.id));
  let out: { page: number; x: number; y: number; h: number } | null = null;
  for (let k = c.start; k < c.pages.length; k++)
    for (const n of c.pages[k].nodes) if (ids.has(n.id)) {
      const b = nodeBounds(n);
      if (!out || k > out.page || (k === out.page && b.y + b.h + 2 > out.y)) {
        const fmt = RT.formatAt(c.story.paras, RT.docEnd(c.story.paras));
        out = { page: k, x: bodyBox(c.pages[k]).x, y: b.y + b.h + 2, h: fmt.fontSize * 1.25 };
      }
    }
  return out;
}

/**
 * Typing at the caret after the closing object: the paragraph it needs is made now (in the same typing step as
 * what follows), the closing objects stand before it, the caret at its start.
 */
function materializeTail() {
  if (!F().tail) return;
  const c = ctx();
  if (!c) return;
  const paras = c.story.paras;
  const last = paras[paras.length - 1];
  const fmt = RT.formatAt(paras, RT.docEnd(paras));
  const { role: _r, list: _l, flowSplit: _s, flowCont: _c, sectMark: _m, ...base } = last;
  const np: TextParagraph = { ...base, id: uid("p"), runs: [{ ...RT.plainFormat(fmt), text: "" } as TextRun] };
  const next = [...paras, np];
  const objs = c.story.objs.map((o) => (o.before === STORY_END ? { ...o, before: np.id } : o));
  writePages(reflowSegment(c.pages, c.start, { ...c.story, paras: next, objs }), null);
  setSel({ p: next.length - 1, o: 0 });
}

function insert(text: string, label: string | null = null, lineBreak = false) {
  materializeTail();
  const st = story();
  if (!st || !text) return;
  let paras = st.paras;
  let r = RT.clampRange(paras, selRange());
  const fmt = pending && RT.collapsed(r) ? pending.fmt : RT.formatAt(paras, RT.collapsed(r) ? r.start : { ...r.start, o: r.start.o + 1 });
  if (!RT.collapsed(r)) ({ paras, pos: r.start } = RT.deleteRange(paras, r));
  // Shift+Enter: a line break inside the paragraph ("\n" in the run, Word w:br / 한글 hp:lineBreak), not a new paragraph
  const res = lineBreak ? RT.insertRun(paras, r.start, { ...RT.plainFormat(fmt), text: "\n" } as TextRun) : RT.insertText(paras, r.start, text, fmt);
  pending = null;
  applyParas(res.paras, res.pos, res.pos, label);
}

function newParagraph() {
  materializeTail();
  const st = story();
  if (!st) return;
  let paras = st.paras;
  const r = RT.clampRange(paras, selRange());
  let at = r.start;
  if (!RT.collapsed(r)) ({ paras, pos: at } = RT.deleteRange(paras, r));
  const res = RT.splitParagraph(paras, at, { body: RT.bodyFormat(paras), lc: lc() });
  pending = null;
  applyParas(res.paras, res.pos);
}

function del(dir: -1 | 1, word: boolean) {
  const c = ctx();
  if (!c) return;
  const paras = c.story.paras;
  const r = RT.clampRange(paras, selRange());
  pending = null;
  if (!RT.collapsed(r)) {
    const res = RT.deleteRange(paras, r);
    return applyParas(res.paras, res.pos);
  }
  const at = r.start;
  // at the start of the run: Backspace removes the page break before it (Word); at its end Delete the one after
  if (dir < 0 && at.p === 0 && at.o === 0) return joinRuns(c.start, "before");
  if (dir > 0 && at.p === paras.length - 1 && at.o === RT.paraText(paras[at.p]).length) return joinRuns(c.start, "after");
  // a table or picture right before / after the paragraph: the text does not merge across it
  if (dir < 0 && at.o === 0 && c.story.objs.some((o) => o.before === paras[at.p].id)) {
    if (RT.paraText(paras[at.p]) || at.p === 0) return;
  }
  if (dir > 0 && at.p + 1 < paras.length && at.o === RT.paraText(paras[at.p]).length && c.story.objs.some((o) => o.before === paras[at.p + 1].id)) return;
  if (word) {
    const to = dir < 0 ? wordLeft(paras, at) : wordRight(paras, at);
    const res = RT.deleteRange(paras, RT.range(at, to));
    return applyParas(res.paras, res.pos);
  }
  const res = RT.deleteChar(paras, at, dir);
  applyParas(res.paras, res.pos);
}

/** Remove the page break between this run and the one before / after it (both flow): one run again. */
function joinRuns(start: number, side: "before" | "after") {
  const pages = S().doc.pages;
  const seg = segmentAt(pages, start);
  const j = side === "before" ? seg.start : seg.end;
  if (j <= 0 || j >= pages.length || pages[j].breakBefore === "section") return;
  const prevSeg = segmentAt(pages, j - 1);
  if (!isFlowSegment(pages, prevSeg) || !isFlowSegment(pages, segmentAt(pages, j))) return;
  const before = gatherStory(pages, prevSeg);
  const joined = pages.map((p, i) => (i === j ? { ...p, breakBefore: "flow" as const } : p));
  const out = reflowSegment(joined, prevSeg.start);
  const caret = side === "before" ? { p: before.paras.length, o: 0 } : F().focus;
  const segId = out[prevSeg.start].id;
  closeTyping();
  writePages(out, tx("docflow.hist.joinPages"));
  useFlow.setState({ segId });
  S().set({ editingTextId: flowEditId(segId) });
  setSel(caret);
}

/** Ctrl+Enter / Alt+Shift+Enter in the body: a page (or section) break at the caret — what follows starts a new page run. */
export function flowBreak(kind: "page" | "section"): boolean {
  const c = ctx();
  if (!c) return false;
  let paras = c.story.paras;
  const r = RT.clampRange(paras, selRange());
  let at = r.start;
  if (!RT.collapsed(r)) ({ paras, pos: at } = RT.deleteRange(paras, r));
  const res = RT.splitParagraph(paras, at, { body: RT.bodyFormat(paras), lc: lc() });
  const keep = res.paras.slice(0, res.pos.p), moved = res.paras.slice(res.pos.p);
  const objs = reanchor(c.story.objs, c.story.paras, res.paras);
  const movedIds = new Set(moved.map((p) => p.id));
  const seg = segmentAt(c.pages, c.start);
  // the new run's first page: like the run's last page, after a hard break (or a section break)
  const first = flowPageLike(c.pages[seg.end - 1], seg.end + 1);
  if (kind === "section") first.breakBefore = "section";
  else delete first.breakBefore;
  // a frame so the new page is a flow page; reflow fills it
  const frame = c.story.proto ? { ...c.story.proto, id: `${c.story.proto.id}~b${Date.now().toString(36)}`, paragraphs: moved, flow: true as const } : null;
  if (frame) first.nodes.push(frame);
  let pages = [...c.pages.slice(0, seg.end), first, ...c.pages.slice(seg.end)];
  pages = reflowSegment(pages, seg.start, { ...c.story, paras: keep, objs: objs.filter((o) => !movedIds.has(o.before)) });
  const at2 = pages.findIndex((p) => p.id === first.id);
  pages = reflowSegment(pages, at2, { ...c.story, paras: moved, objs: objs.filter((o) => movedIds.has(o.before)) });
  closeTyping();
  writePages(pages, tx(kind === "page" ? "pagesetup.hist.pageBreak" : "pagesetup.hist.sectionBreak"));
  useFlow.setState({ segId: first.id });
  S().set({ editingTextId: flowEditId(first.id) });
  setSel(ZERO);
  return true;
}

// ───────── moving ─────────

function wordRight(paras: TextParagraph[], at: Pos): Pos {
  const text = RT.paraText(paras[at.p]);
  if (at.o >= text.length) return at.p + 1 < paras.length ? { p: at.p + 1, o: 0 } : at;
  let o = at.o;
  while (o < text.length && /\s/.test(text[o])) o++;
  while (o < text.length && !/\s/.test(text[o])) o++;
  while (o < text.length && /\s/.test(text[o])) o++;
  return { p: at.p, o };
}

function wordLeft(paras: TextParagraph[], at: Pos): Pos {
  if (at.o <= 0) return at.p > 0 ? { p: at.p - 1, o: RT.paraText(paras[at.p - 1]).length } : at;
  const text = RT.paraText(paras[at.p]);
  let o = at.o;
  while (o > 0 && /\s/.test(text[o - 1])) o--;
  while (o > 0 && !/\s/.test(text[o - 1])) o--;
  return { p: at.p, o };
}

function charStep(paras: TextParagraph[], at0: Pos, dir: -1 | 1): Pos {
  // the final view's hidden (deleted) text is stepped over as if it were not there (core/review.ts)
  const at = paras[at0.p] ? { p: at0.p, o: skipHidden(paras[at0.p], at0.o, dir) } : at0;
  const text = RT.paraText(paras[at.p]);
  if (dir > 0) {
    if (at.o >= text.length) return at.p + 1 < paras.length ? { p: at.p + 1, o: 0 } : at;
    const b = RT.boundaries(text).find((x) => x > at.o);
    return { p: at.p, o: b ?? text.length };
  }
  if (at.o <= 0) return at.p > 0 ? { p: at.p - 1, o: RT.paraText(paras[at.p - 1]).length } : at;
  const bs = RT.boundaries(text).filter((x) => x < at.o);
  return { p: at.p, o: bs.length ? bs[bs.length - 1] : 0 };
}

function wordAt(paras: TextParagraph[], at: Pos): RT.Range {
  const text = RT.paraText(paras[at.p]);
  const isW = (ch: string) => !/\s/.test(ch) && !/[.,;:!?()[\]{}"'“”‘’·…—–-]/.test(ch);
  let a = at.o, b = at.o;
  if (a < text.length && isW(text[a])) {
    while (a > 0 && isW(text[a - 1])) a--;
    while (b < text.length && isW(text[b])) b++;
  } else if (a > 0 && isW(text[a - 1])) {
    while (a > 0 && isW(text[a - 1])) a--;
  } else if (b < text.length) b++;
  // Word selects the space after a word too
  while (b < text.length && text[b] === " ") b++;
  return { start: { p: at.p, o: a }, end: { p: at.p, o: b } };
}

type Move = "left" | "right" | "up" | "down" | "home" | "end" | "docStart" | "docEnd" | "pageUp" | "pageDown" | "wordLeft" | "wordRight";

function move(how: Move, extend: boolean) {
  const c = ctx();
  if (!c) return;
  const paras = c.story.paras;
  const r = RT.clampRange(paras, selRange());
  const f = RT.clampPos(paras, F().focus);
  let to: Pos = f;
  let keepGoal = false;
  const lines = c.lines;
  const li = lineIndexOf(lines, f.p, f.o);
  const cb = caretBox(lines, f.p, f.o);
  switch (how) {
    case "left":
      to = !extend && !RT.collapsed(r) ? r.start : charStep(paras, f, -1);
      break;
    case "right":
      to = !extend && !RT.collapsed(r) ? r.end : charStep(paras, f, 1);
      break;
    case "wordLeft":
      to = wordLeft(paras, f);
      break;
    case "wordRight":
      to = wordRight(paras, f);
      break;
    case "home":
      to = { p: f.p, o: lines[li]?.start ?? 0 };
      break;
    case "end": {
      const fl = lines[li];
      to = fl ? { p: f.p, o: fl.last ? fl.end : offsetOnLine(fl, 1e9) } : f;
      break;
    }
    case "docStart":
      to = ZERO;
      break;
    case "docEnd":
      to = RT.docEnd(paras);
      break;
    case "up":
    case "down": {
      if (!cb) break;
      if (goalX === null) goalX = cb.x;
      keepGoal = true;
      const tl = lines[li + (how === "up" ? -1 : 1)];
      if (!tl) to = how === "up" ? ZERO : RT.docEnd(paras);
      else to = { p: tl.sp, o: offsetOnLine(tl, goalX - tl.node.transform.x) };
      break;
    }
    case "pageUp":
    case "pageDown": {
      if (!cb) break;
      if (goalX === null) goalX = cb.x;
      keepGoal = true;
      const wrap = document.querySelector(".canvas-wrap") as HTMLElement | null;
      const step = ((wrap?.clientHeight ?? 800) * 0.9) / S().view.zoom;
      // the line about one screen above / below (continuing onto the next page)
      let y = cb.y + (how === "pageUp" ? -step : step);
      let page = cb.page;
      const pg = c.pages[page];
      while (y < 0 && page > c.start) y += c.pages[--page].height;
      while (y > pg.height && lines.some((l) => l.page === page + 1)) y -= c.pages[page++].height;
      const p = posAt(lines, page, goalX, y);
      to = p ?? (how === "pageUp" ? ZERO : RT.docEnd(paras));
      break;
    }
  }
  if (extend) setSel(F().anchor, to, keepGoal);
  else setSel(to, to, keepGoal);
}

// ───────── keys ─────────

export function onKeyDown(e: KeyboardEvent) {
  if (!F().active) return;
  if (e.isComposing || e.keyCode === 229 || F().comp) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = /^[a-z]$/i.test(e.key) || !/^Key[A-Z]$/.test(e.code) ? e.key.toLowerCase() : e.code.slice(3).toLowerCase();
  const done = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  const sh = e.shiftKey;
  // Word: Alt+Ctrl+F footnote, Alt+Ctrl+D endnote at the caret
  if (mod && e.altKey && !sh && (k === "f" || k === "d")) return done(), void insertNote(k === "f" ? "foot" : "end");
  switch (e.key) {
    case "ArrowLeft":
      return done(), move(mod ? "wordLeft" : "left", sh);
    case "ArrowRight":
      return done(), move(mod ? "wordRight" : "right", sh);
    case "ArrowUp":
      return done(), move("up", sh);
    case "ArrowDown":
      return done(), move("down", sh);
    case "Home":
      return done(), move(mod ? "docStart" : "home", sh);
    case "End":
      return done(), move(mod ? "docEnd" : "end", sh);
    case "PageUp":
      return done(), move("pageUp", sh);
    case "PageDown":
      return done(), move("pageDown", sh);
    case "Backspace":
      return done(), del(-1, mod);
    case "Delete":
      return done(), del(1, mod);
    case "Escape":
      return done(), endTyping();
    case "Enter":
      done();
      if (mod && !sh && !e.altKey) return void flowBreak("page");
      if (!mod && e.altKey && sh) return void flowBreak("section");
      if (sh) return insert("\n", null, true);
      return newParagraph();
    case "Tab": {
      // Ctrl+Tab / Ctrl+Shift+Tab switch document tabs (shell/shortcuts.ts): let it through
      if (mod) return;
      done();
      const r = RT.clampRange(story()!.paras, selRange());
      const res = RT.changeListLevel(story()!.paras, r.start.p, r.end.p, sh ? -1 : 1, lc());
      if (res) return applyParas(res.paras, shiftPos(F().anchor, res.delta), shiftPos(F().focus, res.delta), tx("paragraph.hist.listLevel"));
      if (!sh) insert("\t");
      return;
    }
  }
  if (!mod || e.altKey) {
    if (mod && e.altKey && /^[0-3]$/.test(k)) return done(), api.heading(Number(k) as 0 | 1 | 2 | 3);
    return;
  }
  if (k === "a") return done(), setSel(ZERO, RT.docEnd(story()!.paras));
  if (k === "b") return done(), api.toggle("bold");
  if (k === "i") return done(), api.toggle("italic");
  if (k === "u") return done(), api.toggle("underline");
  if (k === "z" && !sh) return done(), undo(false);
  if (k === "y" || (k === "z" && sh)) return done(), undo(true);
  if (e.code === "Equal") return done(), api.script(sh ? "super" : "sub");
  if (sh && k === "x") return done(), api.toggle("strike");
  if (k === "l" && !sh) return done(), api.setPara({ align: "LEFT" }, tx("shell.hist.alignLeft"));
  if (k === "e" && !sh) return done(), api.setPara({ align: "CENTER" }, tx("shell.hist.alignCenter"));
  if (k === "r" && !sh) return done(), api.setPara({ align: "RIGHT" }, tx("shell.hist.alignRight"));
  if (k === "j" && !sh) return done(), api.setPara({ align: "JUSTIFY" }, tx("shell.hist.justify"));
  if (k === "s") closeTyping();
}

function shiftPos(p: Pos, delta: number[]): Pos {
  return { p: p.p, o: Math.max(0, p.o + (delta[p.p] ?? 0)) };
}

/**
 * Where two versions of a story differ, as a caret in the new one: the end of what changed (after re-inserted text,
 * where removed text was) — Word puts the caret there after undo / redo. Null when the text is the same.
 */
export function changedAt(before: readonly TextParagraph[], after: readonly TextParagraph[]): Pos | null {
  const a = before.map(RT.paraText), b = after.map(RT.paraText);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  if (s === a.length && s === b.length) return null;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const p = Math.min(b.length - 1, Math.max(s, b.length - 1 - e));
  const x = a[Math.min(a.length - 1, Math.max(s, a.length - 1 - e))] ?? "", y = b[p];
  let k = 0;
  while (k < x.length && k < y.length && x[x.length - 1 - k] === y[y.length - 1 - k]) k++;
  let o = y.length - k;
  if (p === s) {
    let pre = 0;
    const xs = a[s] ?? "";
    while (pre < xs.length && pre < y.length && xs[pre] === y[pre]) pre++;
    o = Math.max(o, Math.min(pre, y.length));
  }
  return { p, o };
}

function undo(redo: boolean) {
  closeTyping();
  const before = story()?.paras;
  if (redo) S().redo();
  else S().undo();
  // the run may have gone (an undone page break): stay where the page is
  const pages = S().doc.pages;
  if (!pages.some((p) => p.id === F().segId)) {
    const i = Math.max(0, pages.findIndex((p) => p.id === S().pageId));
    if (!beginTyping(pages[i]?.id, F().focus)) endTyping();
    return;
  }
  // the caret goes to what the undo / redo changed (Word), not where it was before
  const after = story()?.paras;
  const at = before && after ? changedAt(before, after) : null;
  if (at) setSel(RT.clampPos(after!, at));
  pushStatus();
}

/** Text typed into the textarea (not composed): insert it. */
export function onInput(e: InputEvent | Event) {
  if (!input) return;
  if ((e as InputEvent).isComposing || F().comp) return;
  const v = input.value;
  input.value = "";
  if (v) insert(v.replace(/\r\n?/g, "\n"));
}

// ───────── IME composition ─────────

let compBase: { doc: OmwDocument; paras: TextParagraph[]; at: Pos; fmt: RT.RunFormat; data?: string } | null = null;

/** End the composition now with what it shows (the browser's own compositionend then finds nothing to do). */
function commitComposition() {
  const data = compBase?.data ?? "";
  onCompositionEnd(data);
  // the IME lets go of the syllable it held
  input?.blur();
}

export function onCompositionStart() {
  materializeTail();
  const c = ctx();
  if (!c) return;
  // composing over a selection: the selection goes first (as typing)
  let r = RT.clampRange(c.story.paras, selRange());
  if (!RT.collapsed(r)) {
    const res = RT.deleteRange(c.story.paras, r);
    applyParas(res.paras, res.pos);
    r = { start: res.pos, end: res.pos };
  }
  const paras = story()!.paras;
  const fmt = pending && RT.collapsed(r) ? pending.fmt : RT.formatAt(paras, r.start);
  compBase = { doc: S().doc, paras, at: r.start, fmt };
  useFlow.setState({ comp: { p: r.start.p, a: r.start.o, b: r.start.o } });
}

/** The syllable being composed is shown in place (laid out with the text, not yet an undo step). */
export function onCompositionUpdate(data: string) {
  const b = compBase;
  if (!b) return;
  const c = ctx();
  if (!c) return;
  b.data = data;
  const res = RT.insertText(b.paras, b.at, data, b.fmt);
  const st: Story = { ...gatherStory(b.doc.pages, segmentAt(b.doc.pages, c.start)), paras: res.paras };
  st.objs = reanchor(st.objs, b.paras, res.paras);
  const pages = reflowSegment(b.doc.pages, c.start, st);
  selfWrite = true;
  try {
    useStore.setState({ doc: { ...b.doc, pages } });
  } finally {
    selfWrite = false;
  }
  useFlow.setState({ comp: { p: b.at.p, a: b.at.o, b: b.at.o + data.length }, anchor: res.pos, focus: res.pos, tick: F().tick + 1 });
  ensureVisible();
}

export function onCompositionEnd(data: string) {
  const b = compBase;
  compBase = null;
  useFlow.setState({ comp: null });
  if (input) input.value = "";
  if (!b) return;
  // back to the document before the preview, then the syllable as typing
  selfWrite = true;
  try {
    useStore.setState({ doc: b.doc });
  } finally {
    selfWrite = false;
  }
  if (!data) return setSel(b.at);
  const res = RT.insertText(b.paras, b.at, data, b.fmt);
  pending = null;
  applyParas(res.paras, res.pos);
}

// ───────── clipboard ─────────

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function rangeHtml(paras: TextParagraph[], r: RT.Range): string {
  const out: string[] = [];
  for (let i = r.start.p; i <= r.end.p; i++) {
    const p = paras[i];
    const len = RT.paraText(p).length;
    const runs = RT.sliceRuns(p.runs, i === r.start.p ? r.start.o : 0, i === r.end.p ? r.end.o : len);
    const inner = runs
      .map((x: TextRun) => {
        const st = [`font-size:${(x.fontSize * 0.75).toFixed(1)}pt`, `color:${x.color}`, x.fontFamily !== "Pretendard" ? `font-family:'${escHtml(x.fontFamily)}'` : ""].filter(Boolean).join(";");
        let h = `<span style="${st}">${escHtml(x.text).replace(/\n/g, "<br>")}</span>`;
        if (x.bold) h = `<b>${h}</b>`;
        if (x.italic) h = `<i>${h}</i>`;
        if (x.underline) h = `<u>${h}</u>`;
        if (x.strike) h = `<s>${h}</s>`;
        return h;
      })
      .join("");
    const tag = p.role && /^h[1-6]$/.test(p.role) ? p.role : "p";
    out.push(`<${tag} style="text-align:${p.align === "JUSTIFY" ? "justify" : p.align.toLowerCase()}">${inner || "<br>"}</${tag}>`);
  }
  return out.join("");
}

export function onCopy(e: ClipboardEvent, cut: boolean) {
  const st = story();
  if (!st) return;
  e.preventDefault();
  e.stopPropagation();
  const r = RT.clampRange(st.paras, selRange());
  if (RT.collapsed(r)) return;
  e.clipboardData?.setData("text/plain", RT.rangeText(st.paras, r));
  e.clipboardData?.setData("text/html", rangeHtml(st.paras, r));
  if (cut) {
    const res = RT.deleteRange(st.paras, r);
    applyParas(res.paras, res.pos, res.pos, tx("shell.hist.cut"));
  }
}

export function onPaste(e: ClipboardEvent) {
  const st = story();
  if (!st) return;
  e.preventDefault();
  e.stopPropagation();
  const dt = e.clipboardData;
  if (!dt) return;
  const r = RT.clampRange(st.paras, selRange());
  const base = pending && RT.collapsed(r) ? pending.fmt : RT.formatAt(st.paras, r.start);
  const res = RT.pasteData(st.paras, r, base, dt.getData("text/html"), dt.getData("text/plain"));
  if (!res) return;
  pending = null;
  applyParas(res.paras, res.pos, res.pos, tx("shell.hist.paste"));
}

// ───────── pointer ─────────

let drag: { mode: "char" | "word" | "para"; origin: RT.Range } | null = null;

/**
 * A press on a document page: put the caret there (true), or leave it to the canvas (false: not a flowing page, a
 * free object or a table was hit, or a double click in the header / footer margin).
 */
let lastPress = { t: 0, x: 0, y: 0, n: 0, page: "" };

export function flowPointerDown(page: Page, x: number, y: number, opts: { detail: number; shift: boolean }): boolean {
  // click count: some engines give pointerdown no detail, so count presses close in time and place too
  const now = Date.now();
  const near = now - lastPress.t < 500 && page.id === lastPress.page && Math.hypot(x - lastPress.x, y - lastPress.y) < 6 / Math.max(0.05, S().view.zoom);
  lastPress = { t: now, x, y, n: near ? lastPress.n + 1 : 1, page: page.id };
  opts = { ...opts, detail: Math.max(opts.detail, lastPress.n) };
  if (opts.detail >= 2 && hfAreaAt(page, y)) {
    endTyping();
    return false;
  }
  // composing a syllable (한글 IME) and pressing elsewhere: the syllable is kept where it was being typed, then the
  // caret goes where the press was (Word) — not after the syllable when the browser ends the composition later
  if (compBase) commitComposition();
  const hit = hitCaret(page, x, y);
  if (!hit) {
    endTyping();
    return false;
  }
  const f = F();
  if (!f.active || f.segId !== hit.segId) beginTyping(page.id, hit.pos);
  const paras = story()!.paras;
  const pos = RT.clampPos(paras, hit.pos);
  if (opts.detail >= 3) {
    const r = { start: { p: pos.p, o: 0 }, end: { p: pos.p, o: RT.paraText(paras[pos.p]).length } };
    drag = { mode: "para", origin: r };
    setSel(r.start, r.end);
  } else if (opts.detail === 2) {
    const r = wordAt(paras, pos);
    drag = { mode: "word", origin: r };
    setSel(r.start, r.end);
  } else {
    drag = { mode: "char", origin: { start: pos, end: pos } };
    if (opts.shift) setSel(F().anchor, pos);
    else setSel(pos);
    // below the picture / table that ends the body: the caret waits after it (Word)
    const c = !opts.shift ? ctx() : null;
    if (c && RT.cmpPos(pos, RT.docEnd(paras)) === 0 && belowTail(c, c.pages.findIndex((p) => p.id === page.id), y)) useFlow.setState({ tail: true });
  }
  focusInput();
  // the press goes on to a mousedown that takes the focus to the page: take it back after it
  setTimeout(focusInput, 0);
  return true;
}

/**
 * A right-click on the body (before its context menu opens): the caret goes where it was pressed, as in Word — unless the
 * press is inside the selection, which then stays (the menu acts on it). A syllable being composed is kept first. False
 * when the press is not on the body text.
 */
export function flowContextPress(page: Page, x: number, y: number): boolean {
  if (compBase) commitComposition();
  const hit = hitCaret(page, x, y);
  if (!hit) return false;
  const f = F();
  const same = f.active && f.segId === hit.segId;
  if (!same && !beginTyping(page.id, hit.pos)) return false;
  const paras = story()?.paras;
  if (!paras) return false;
  const pos = RT.clampPos(paras, hit.pos);
  if (!(same && RT.keepsSelection(selRange(), pos))) {
    closeTyping();
    setSel(pos);
  }
  drag = null;
  focusInput();
  return true;
}

export function flowPointerMove(page: Page, x: number, y: number) {
  if (!drag || !F().active) return;
  const c = ctx();
  if (!c) return;
  let i = c.pages.findIndex((p) => p.id === page.id);
  // dragged past the page's end onto the page shown below (or above) it in the document mode (docView.ts): the
  // selection goes on there — page coordinates of that page, the gap between pages counted in screen px
  if (docModeNow()) {
    const gap = PAGE_GAP / Math.max(0.05, S().view.zoom);
    const seg = segmentAt(c.pages, c.start);
    while (i + 1 < seg.end && y > c.pages[i].height + gap) y -= c.pages[i++].height + gap;
    while (i - 1 >= seg.start && y < -gap) y += c.pages[--i].height + gap;
  }
  const pos = posAt(c.lines, i, x, y);
  if (!pos) return;
  const o = drag.origin;
  if (drag.mode === "char") return setSel(F().anchor, pos);
  const unit = drag.mode === "word" ? wordAt(c.story.paras, pos) : { start: { p: pos.p, o: 0 }, end: { p: pos.p, o: RT.paraText(c.story.paras[pos.p]).length } };
  if (RT.cmpPos(unit.start, o.start) < 0) setSel(o.end, unit.start);
  else setSel(o.start, RT.cmpPos(unit.end, o.end) > 0 ? unit.end : o.end);
}

export function flowPointerUp() {
  drag = null;
  focusInput();
}

// ───────── list context ─────────

function lc(): ListCtx {
  const c = ctx();
  if (!c) return {};
  const first = c.pages[c.start].nodes.find((n) => n.type === "TEXT" && n.flow);
  return { defs: c.story.lists, seed: first ? RT.listSeedBefore(c.pages, first.id) : undefined };
}

// ───────── ribbon commands (RichApi) ─────────

function runCmd(label: string, op: (paras: TextParagraph[], r: RT.Range) => TextParagraph[], patchFor: (cur: RT.RunFormat) => RT.RunPatch) {
  const st = story();
  if (!st) return;
  const r = RT.clampRange(st.paras, selRange());
  if (RT.collapsed(r)) {
    const cur = pending?.fmt ?? RT.formatAt(st.paras, r.start);
    pending = { fmt: RT.runFormat(RT.applyPatch({ ...cur, text: "" } as TextRun, patchFor(cur))), pos: r.start };
    closeTyping();
    pushStatus();
    focusInput();
    return;
  }
  applyParas(op(st.paras, r), F().anchor, F().focus, label);
  focusInput();
}

const paraSpan = (): [number, number] => {
  const r = RT.clampRange(story()?.paras ?? [], selRange());
  return [r.start.p, r.end.p];
};

let gesture: { paras: TextParagraph[]; pages: Page[] } | null = null;

function liveFor(make: (base: TextParagraph[], v: unknown) => TextParagraph[], label: string, set: (v: unknown) => void): Live<any> {
  return {
    set,
    begin: () => {
      const c = ctx();
      if (!c) return;
      closeTyping();
      gesture = { paras: c.story.paras, pages: c.pages };
      S().beginGesture();
    },
    live: (v) => {
      const c = ctx();
      if (!gesture || !c) return set(v);
      const paras = make(gesture.paras, v);
      const st = gatherStory(gesture.pages, segmentAt(gesture.pages, c.start));
      const pages = reflowSegment(gesture.pages, c.start, { ...st, paras, objs: reanchor(st.objs, st.paras, paras) });
      selfWrite = true;
      try {
        S().updateGesture((d) => {
          d.pages = pages as typeof d.pages;
        });
      } finally {
        selfWrite = false;
      }
      pushStatus();
    },
    end: () => {
      if (!gesture) return;
      gesture = null;
      selfWrite = true;
      try {
        S().endGesture(label);
      } finally {
        selfWrite = false;
      }
      pushStatus();
      focusInput();
    },
  };
}

function withLists(lists: ListDef[] | undefined, fn: (c: ListCtx) => { paras: TextParagraph[]; delta: number[] }, label: string) {
  const l = lc();
  const res = fn(lists ? { ...l, defs: lists } : l);
  applyParas(res.paras, shiftPos(F().anchor, res.delta), shiftPos(F().focus, res.delta), label, lists);
}

const toggleLabel = (key: RT.ToggleKey) => (key === "strike" ? tx("shell.hist.strike") : tx(`cmd.text.${key}`));

const api: RichApi = {
  toggle: (key) => runCmd(toggleLabel(key), (ps, r) => RT.toggleRunFormat(ps, r, key), (cur) => ({ [key]: !cur[key] })),
  script: (s) => runCmd(s === "super" ? tx("shell.hist.superscript") : tx("shell.hist.subscript"), (ps, r) => RT.toggleScript(ps, r, s), (cur) => ({ script: cur.script === s ? null : s })),
  setRun: (key, value, label) => runCmd(label, (ps, r) => RT.applyRunFormat(ps, r, { [key]: value } as RT.RunPatch), () => ({ [key]: value }) as RT.RunPatch),
  runLive: (key, label) => {
    const set = (v: unknown) => api.setRun(key, v as never, label);
    const lv = liveFor((base, v) => RT.applyRunFormat(base, selRange(), { [key]: v } as RT.RunPatch), label, set);
    const begin = lv.begin;
    lv.begin = () => {
      if (!RT.collapsed(selRange())) begin?.();
    };
    return lv;
  },
  setPara: (patch, label) => {
    const [a, b] = paraSpan();
    const st = story();
    if (st) applyParas(RT.applyParaFormat(st.paras, a, b, patch), F().anchor, F().focus, label);
  },
  paraLive: (key, label) => {
    const set = (v: unknown) => api.setPara({ [key]: v } as RT.ParaPatch, label);
    return liveFor(
      (base, v) => {
        const [a, b] = paraSpan();
        return RT.applyParaFormat(base, a, b, { [key]: v } as RT.ParaPatch);
      },
      label,
      set,
    );
  },
  list: (kind) => {
    const [a, b] = paraSpan();
    const st = story();
    if (!st) return;
    const res = RT.toggleList(st.paras, a, b, kind);
    applyParas(res.paras, shiftPos(F().anchor, res.delta), shiftPos(F().focus, res.delta), kind === "li" ? tx("shell.hist.bullets") : tx("shell.hist.numbering"));
  },
  listApply: (def, lists) => {
    const [a, b] = paraSpan();
    withLists(lists, (l) => RT.applyList(story()!.paras, a, b, def, l), tx("paragraph.hist.list"));
  },
  listLevel: (by) => {
    const [a, b] = paraSpan();
    const res = RT.changeListLevel(story()!.paras, a, b, by, lc());
    if (res) applyParas(res.paras, shiftPos(F().anchor, res.delta), shiftPos(F().focus, res.delta), tx("paragraph.hist.listLevel"));
  },
  outline: (def, lists) => withLists(lists, (l) => RT.applyOutline(story()!.paras, def, l), tx("paragraph.hist.outline")),
  listStart: (start) => {
    const [a] = paraSpan();
    const res = RT.setListStart(story()!.paras, a, start, lc());
    applyParas(res.paras, shiftPos(F().anchor, res.delta), shiftPos(F().focus, res.delta), tx("paragraph.hist.listStart"));
  },
  listDefs: () => story()?.lists ?? [],
  listRedefine: (listId, def, lists, start) => {
    const [a] = paraSpan();
    withLists(
      lists,
      (l) => {
        const r = RT.redefineList(story()!.paras, listId, def, l);
        if (start === undefined) return r;
        const s = RT.setListStart(r.paras, a, start, l);
        return { paras: s.paras, delta: r.delta.map((d, i) => d + s.delta[i]) };
      },
      tx("paragraph.hist.listFormat"),
    );
  },
  // 문단 앞에서 쪽 나눔 in the body flow is a paragraph format: the flow starts that paragraph on a new page
  breakBefore: (patch) => {
    const [a, b] = paraSpan();
    const st = story();
    if (!st) return false;
    applyParas(RT.applyParaFormat(st.paras, a, b, { ...(patch ?? {}), pageBreakBefore: true }), F().anchor, F().focus, tx("pagesetup.hist.pageBreak"));
    return true;
  },
  heading: (level) => {
    const [a, b] = paraSpan();
    const st = story();
    if (!st) return;
    applyParas(RT.setHeading(st.paras, a, b, level, RT.bodyFormat(st.paras), lc()), F().anchor, F().focus, level ? tx("shell.hist.heading", { level }) : tx("shell.hist.body"));
  },
  insertText: (text) => insert(text),
  insertField: (kind) => {
    const c = ctx();
    if (!c) return;
    let paras = c.story.paras;
    const r = RT.clampRange(paras, selRange());
    let at = r.start;
    if (!RT.collapsed(r)) ({ paras, pos: at } = RT.deleteRange(paras, r));
    const cb = caretBox(c.lines, at.p, at.o);
    const run = fieldNow(c.doc, cb?.page ?? c.start, kind, RT.formatAt(paras, at));
    const res = RT.insertRun(paras, at, run);
    pending = null;
    applyParas(res.paras, res.pos, res.pos, tx("headerfooter.hist.field"));
  },
  focus: () => focusInput(),
};

// ───────── review edits (comments, accepting changes: ui/reviewActions.ts) ─────────

/** The story being typed in and its selection (null when the caret is not in a document body). */
export function flowSelection(): { segId: string; paras: TextParagraph[]; sel: RT.Range; word: RT.Range } | null {
  const c = ctx();
  if (!c) return null;
  const sel = RT.clampRange(c.story.paras, selRange());
  return { segId: F().segId!, paras: c.story.paras, sel, word: wordAt(c.story.paras, sel.start) };
}

/**
 * Edit the story being typed in as one undo step `label`: `fn` gets its paragraphs and selection and returns the new
 * paragraphs (null: nothing to do); `after` may change the pages written (the document's comment list). The caret
 * stays where it was (clamped), or goes where `fn` says.
 */
export function storyEdit(label: string, fn: (paras: TextParagraph[], sel: RT.Range) => { paras: TextParagraph[]; anchor?: Pos; focus?: Pos } | null, after?: (pages: Page[]) => Page[], segId?: string): boolean {
  const c = ctx();
  if (!c || (segId && segId !== F().segId)) return false;
  const res = fn(c.story.paras, RT.clampRange(c.story.paras, selRange()));
  if (!res) return false;
  closeTyping();
  let pages = reflowSegment(c.pages, c.start, { ...c.story, paras: res.paras, objs: reanchor(c.story.objs, c.story.paras, res.paras) });
  if (after) pages = after(pages);
  writePages(pages, label);
  setSel(RT.clampPos(res.paras, res.anchor ?? F().anchor), RT.clampPos(res.paras, res.focus ?? F().focus));
  return true;
}

// ───────── documents ─────────

/** Re-flow every flowing page run of a document (the same document when nothing changed). */
export function reflowDocument(doc: OmwDocument): OmwDocument {
  const pages = reflowPages(doc.pages);
  return pages === doc.pages ? doc : { ...doc, pages };
}

/**
 * 본문 흐름으로 바꾸기: the body text boxes and tables of the document pages (those starting at the left margin) become
 * the body flow, and the text flows from page to page. One undo step; false when there was nothing to turn.
 */
export function convertToFlow(): boolean {
  const s = S();
  const docPages = s.doc.pages.filter((p) => p.kind === "DOCUMENT");
  if (!docPages.length) {
    s.notify(tx("docflow.toast.noDocPages"));
    return false;
  }
  let n = 0;
  s.commit(tx("docflow.hist.convert"), (d) => {
    normalizeLegacyBreaks(d.pages as Page[]);
    n = markFlowInPlace(d.pages as Page[]);
    if (n) d.pages = reflowPages(d.pages as Page[]) as typeof d.pages;
  });
  s.notify(n ? tx("docflow.toast.converted", { n }) : tx("docflow.toast.already"));
  if (n) beginTyping();
  return n > 0;
}

// a document opened or made: the caret waits at the start of the body (Word)
if (typeof window !== "undefined") {
  let lastDocId = S().doc.id;
  useStore.subscribe((s) => {
    if (s.doc.id === lastDocId) return;
    lastDocId = s.doc.id;
    if (F().active) endTyping();
    const first = s.doc.pages.findIndex((p) => p.id === s.pageId);
    if (isFlowPageAt(s.doc.pages, first)) setTimeout(() => beginTyping(s.pageId, ZERO), 0);
  });
}

// ───────── objects in the text ─────────

/**
 * Put a table or picture into the body at the caret (Word's inline insert): the paragraph is split at the caret and
 * the object stands between the two halves, flowing with the text. False when no body is being typed in.
 */
/** Window event asking the canvas to edit a note area text frame (detail: { id } of the TEXT node). */
export const NOTE_EDIT_EVENT = "omw:edit-note";

/**
 * 각주 / 미주 넣기 (Word Alt+Ctrl+F / Alt+Ctrl+D): a numbered reference after the selection, its note in the look of
 * the document's notes; the flow numbers it and lays the note out, and the note's text is edited at its place (the
 * canvas opens the note area's text). One undo step.
 */
export function insertNote(kind: NoteKind): boolean {
  const c = ctx();
  if (!c) return false;
  closeTyping();
  materializeTail();
  const c2 = ctx();
  if (!c2) return false;
  const paras = c2.story.paras;
  const at = RT.clampRange(paras, selRange()).end;
  // the look of the document's notes of this kind (any page run), else Word's
  let model: import("../core/types").NoteRef | undefined;
  for (const pg of c2.pages) for (const n of pg.nodes) if (!model && n.type === "TEXT" && n.flow) for (const p of n.paragraphs) for (const r of p.runs) if (!model && r.note?.kind === kind) model = r.note;
  const run = newNoteRun(kind, RT.formatAt(paras, at) as TextRun, model);
  const res = RT.insertRun(paras, at, run);
  const pages = reflowSegment(c2.pages, c2.start, { ...c2.story, paras: res.paras, objs: reanchor(c2.story.objs, c2.story.paras, res.paras) });
  writePages(pages, tx(kind === "foot" ? "docflow.hist.insertFootnote" : "docflow.hist.insertEndnote"));
  setSel(res.pos);
  // the note's text is typed in its area (the frame holding its paragraph)
  const pid = run.note!.paras[0].id;
  const area = S().doc.pages.flatMap((pg) => pg.nodes).find((n) => n.type === "TEXT" && n.notes && n.paragraphs.some((q) => q.id === pid));
  if (area && typeof window !== "undefined") {
    endTyping();
    window.dispatchEvent(new CustomEvent(NOTE_EDIT_EVENT, { detail: { id: area.id, para: pid } }));
  }
  return true;
}

/** 각주 / 미주 넣기 from a command or key outside the body editor: at the caret the body had last (its start). */
export function startNote(kind: NoteKind): boolean {
  if (!F().active && !beginTyping(S().pageId, F().focus)) return false;
  return insertNote(kind);
}

export function insertObject(node: SceneNode, assets?: Record<string, AssetRef>): boolean {
  const c = ctx();
  if (!c) return false;
  closeTyping();
  let paras = c.story.paras;
  const r = RT.clampRange(paras, selRange());
  let at = r.start;
  if (!RT.collapsed(r)) ({ paras, pos: at } = RT.deleteRange(paras, r));
  // a picture (or other drawn object) goes into the line like a character (Word's default "In Line with Text")
  if (node.type !== "TABLE") {
    const box0 = bodyBox(c.pages[c.start]);
    const s0 = objSize(node);
    const k0 = Math.min(1, box0.w / Math.max(1, s0.w), (box0.h * 0.8) / Math.max(1, s0.h));
    const obj = { ...node, flow: true, transform: { ...node.transform, scale: node.transform.scale * k0, ...(node.transform.scaleY !== undefined ? { scaleY: node.transform.scaleY * k0 } : {}) } } as SceneNode;
    if (obj.type === "IMAGE") obj.place = { mode: "inline" };
    const sz = objSize(obj);
    const run = { ...RT.formatAt(paras, at), text: OBJ_CHAR, obj: { id: obj.id, w: sz.w, h: sz.h }, underline: false } as TextRun;
    const res = RT.insertRun(paras, at, run);
    const inline = new Map(c.story.inline ?? []);
    inline.set(obj.id, obj);
    const pages0 = reflowSegment(c.pages, c.start, { ...c.story, paras: res.paras, objs: reanchor(c.story.objs, c.story.paras, res.paras), inline });
    selfWrite = true;
    try {
      S().commit(tx("docflow.hist.insertObject"), (d) => {
        d.pages = pages0 as typeof d.pages;
        if (assets) for (const [k, v] of Object.entries(assets)) d.assets[k] = v;
      });
      absorbProvisional();
    } finally {
      selfWrite = false;
    }
    setSel(res.pos);
    focusInput();
    return true;
  }
  let before: string;
  if (at.o === 0) before = paras[at.p].id;
  else {
    const res = RT.splitParagraph(paras, at, { body: RT.bodyFormat(paras), lc: lc() });
    paras = res.paras;
    at = res.pos;
    before = paras[at.p].id;
  }
  // as wide as the body at most
  const box = bodyBox(c.pages[c.start]);
  let obj: SceneNode = { ...node, flow: true } as SceneNode;
  if (obj.type === "TABLE") {
    const total = obj.colWidths.reduce((a, b) => a + b, 0);
    const k = box.w / Math.max(1, total);
    obj = { ...obj, colWidths: obj.colWidths.map((w) => Math.round(w * k * 100) / 100) };
  } else if ("width" in obj && "height" in obj) {
    const k = Math.min(1, box.w / Math.max(1, obj.width), (box.h * 0.9) / Math.max(1, obj.height));
    obj = { ...obj, width: obj.width * k, height: obj.height * k } as SceneNode;
  }
  obj.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
  const objs = [...reanchor(c.story.objs, c.story.paras, paras), { node: obj, before }];
  const pages = reflowSegment(c.pages, c.start, { ...c.story, paras, objs });
  selfWrite = true;
  try {
    S().commit(tx("docflow.hist.insertObject"), (d) => {
      d.pages = pages as typeof d.pages;
      if (assets) for (const [k, v] of Object.entries(assets)) d.assets[k] = v;
    });
  } finally {
    selfWrite = false;
  }
  setSel(at);
  focusInput();
  return true;
}

// ───────── a body for a page that has none (the 문서 mode chosen on a picture / design / slide page) ─────────
//
// docs/design/EDIT_MODES.md 6: choosing 문서 on a page without a body flow gives it one — the page becomes a document
// page with an empty body (margins: the page's own, Word-like 20 mm on paper-sized pages, scaled with the page on
// much smaller / larger ones; the page size never changes) and the caret waits on its first line. One text box that
// already sits exactly where the body goes (left margin, top margin, body width) becomes the body itself; anything
// else stays a free object on the page (pictures behind the text). The step is provisional: leaving the page or
// the mode before anything was typed takes it back without a trace (no undo step, the document as it was), and
// the first edit absorbs it, so one undo returns the page as it was before 문서 was chosen.

let provisional: { doc: OmwDocument; base: OmwDocument; pageId: string; dirty: boolean; past: number } | null = null;

/** Margins for a page given a body: its own, or the default scaled to the page (paper-sized pages: the default). */
function bodyMargins(p: Page): Page["margins"] {
  if (p.margins) return p.margins;
  const k = Math.min(p.width, p.height) / 794; // A4's short side
  if (k > 0.6 && k < 1.6) return undefined;
  const m = DEFAULT_MARGINS;
  const r = (v: number) => Math.max(4, Math.round(v * k * 10) / 10);
  return { top: r(m.top), right: r(m.right), bottom: r(m.bottom), left: r(m.left), header: r(m.header), footer: r(m.footer) };
}

/** Give the page `pageId` a body flow when it has none (see above); true when one was made. */
export function ensureDocBody(pageId = S().pageId): boolean {
  const s = S();
  const pages = s.doc.pages;
  const i = pages.findIndex((p) => p.id === pageId);
  const page = pages[i];
  if (!page || isFlowPageAt(pages, i) || !(page.kind === "DESIGN" || page.kind === "SLIDE" || page.kind === "DOCUMENT")) return false;
  const base = s.doc, dirty = s.dirty, past = s.past.length;
  s.commit(tx("docflow.hist.makeBody"), (d) => {
    const p = d.pages[i] as Page;
    p.kind = "DOCUMENT";
    const m = bodyMargins(p);
    if (m) p.margins = m;
    const box = bodyBox(p);
    const k = Math.max(1, Math.min(p.width, p.height) / 794);
    // the one text box already where the body goes: it is the body (nothing moves)
    const fit = p.nodes.filter((n) => n.type === "TEXT" && !n.locked && n.visible && !n.transform.rotation && n.transform.scale === 1 && Math.abs(n.transform.x - box.x) <= 1.5 && Math.abs(n.transform.y - box.y) <= 1.5 && Math.abs((n as { width: number }).width - box.w) <= 2);
    if (fit.length === 1 && p.nodes.filter((n) => n.type === "TEXT").length === 1) fit[0].flow = true;
    else {
      const n = newText("", box.w);
      n.paragraphs = [withWordDefaults(makeParagraph("", { fontSize: Math.round(16 * k), color: "#1d1f24" }))];
      n.name = tx("engine.default.body");
      n.flow = true;
      n.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
      // pictures already on the page stay where they are, behind the text (Word's 텍스트 뒤)
      for (const o of p.nodes) if (o.type === "IMAGE" && !o.place) o.place = { mode: "float", wrap: "behind" };
      p.nodes.push(n);
    }
    d.pages = reflowPages(d.pages as Page[]) as typeof d.pages;
  });
  if (S().doc === base) return false;
  // nothing typed yet: no "not saved" mark, no recovery copy, no "save changes?" on close — the first edit marks it
  if (!dirty) useStore.setState({ dirty: false });
  provisional = { doc: S().doc, base, pageId, dirty, past };
  beginTyping(pageId, ZERO);
  return true;
}

/** Leaving the page / the 문서 mode: a body made by ensureDocBody that nothing was typed into goes away. */
export function dropUnusedDocBody(): boolean {
  const p = provisional;
  provisional = null;
  // the body is not typed in outside the 문서 edit mode (there it is one text box)
  if (F().active && !docModeNow()) endTyping();
  const s = S();
  if (!p || s.doc !== p.doc || s.past.length !== p.past + 1) return false;
  endTyping();
  useStore.setState({ doc: p.base, past: s.past.slice(0, p.past), dirty: p.dirty });
  return true;
}

/** The first edit after ensureDocBody: the body's making and the edit become one undo step. */
function absorbProvisional() {
  const p = provisional;
  if (!p) return;
  const s = S();
  if (s.doc === p.doc) return;
  provisional = null;
  const last = s.past[s.past.length - 1];
  if (s.past.length === p.past + 2 && s.past[p.past].doc === p.base && last.doc === p.doc) useStore.setState({ past: [...s.past.slice(0, p.past), { doc: p.base, label: last.label }] });
}

/** Is page point (x, y) on a line of the page's body text (a picture behind the text does not take that click)? */
function onBodyLine(page: Page, x: number, y: number): boolean {
  const pages = S().doc.pages;
  const i = pages.findIndex((q) => q.id === page.id);
  if (!isFlowPageAt(pages, i)) return false;
  return flowLines(pages, segmentAt(pages, i)).some((l) => {
    if (l.page !== i) return false;
    const t = l.node.transform;
    const top = t.y + l.line.y;
    return y >= top && y <= top + l.line.height && x >= t.x - 4 && x <= t.x + l.node.width + 4;
  });
}

// the edit modes' document hooks (ui/editModes.ts): clicks, typing on no text and inline inserts come here
docHooks.click = (page, p, hit, e) => {
  // a note area: its text is edited like a text box (the edit goes back into the notes)
  if (hit?.type === "TEXT" && hit.notes) return false;
  const behind = hit?.type === "IMAGE" && hit.place?.mode === "float" && hit.place.wrap === "behind" && onBodyLine(page, p[0], p[1]);
  if (hit && !(hit.type === "TEXT" && hit.flow) && !behind) return false;
  return flowPointerDown(page, p[0], p[1], { detail: 1, shift: e.shiftKey });
};
docHooks.enter = (pageId) => void ensureDocBody(pageId);
docHooks.leave = () => void dropUnusedDocBody();
docHooks.key = (e) => {
  if (F().active || e.ctrlKey || e.metaKey || e.altKey) return false;
  const s = S();
  if (!beginTyping(s.pageId, F().focus)) return false;
  insert(e.key);
  return true;
};
docHooks.insertInline = (node, assets) => insertObject(node, assets);

// ───────── other edits of a flowing body settle the flow ─────────

/**
 * A command that changed a flowing page without the body editor (a table cell, a deleted or resized picture, the
 * paragraph dialog on the selected frame…): the run flows again, folded into that same undo step (the history keeps
 * the state before the command).
 */
if (typeof window !== "undefined")
  useStore.subscribe((s, prev) => {
    if (selfWrite || s.doc === prev.doc || s.past.length <= prev.past.length || s.doc.id !== prev.doc.id || s.gestureBase) return;
    // note text edited in a note area goes back into its notes first (the flow lays the areas out from them)
    let pages = applyNoteAreaEdits(s.doc.pages, prev.doc.pages);
    const done = new Set<number>();
    for (let i = 0; i < pages.length; i++) {
      if (prev.doc.pages.includes(pages[i])) continue;
      if (!isFlowPageAt(pages, i)) continue;
      const seg = segmentAt(pages, i);
      if (done.has(seg.start)) continue;
      done.add(seg.start);
      pages = reflowSegment(pages, seg.start);
      i = segmentAt(pages, seg.start).end - 1;
    }
    if (pages === s.doc.pages) return;
    selfWrite = true;
    try {
      useStore.setState({ doc: { ...s.doc, pages } });
    } finally {
      selfWrite = false;
    }
  });

// ───────── picture layout options (Word's 레이아웃 옵션 button) ─────────

export type PicLayout = "inline" | "square" | "topBottom" | "behind" | "front";

/** How a picture of a document page sits now. */
export function picLayoutOf(n: SceneNode | undefined): PicLayout | null {
  if (!n || (n.type !== "IMAGE" && n.type !== "VECTOR")) return null;
  const place = n.type === "IMAGE" ? n.place : undefined;
  if (place?.mode === "inline") return "inline";
  if (place?.wrap) return place.wrap;
  return n.flow ? "topBottom" : "front";
}

/**
 * Change how a picture sits (one undo step): 글자처럼 = in the line at the nearest text position; 정사각형 / 위아래 = a
 * block of the body flow before the paragraph it is next to (text goes above and below it); 글 뒤 / 글 앞 = free on the
 * page where it is now (behind: under the text).
 */
export function setPicLayout(nodeId: string, layout: PicLayout): boolean {
  const s = S();
  const pages = s.doc.pages;
  const pi = pages.findIndex((p) => p.nodes.some((n) => n.id === nodeId));
  if (pi < 0 || !isFlowPageAt(pages, pi)) return false;
  const seg = segmentAt(pages, pi);
  const st = gatherStory(pages, seg);
  let node = pages[pi].nodes.find((n) => n.id === nodeId)!;
  // out of the text first (its run, or its block)
  let paras = st.paras;
  let at: Pos | null = null;
  paras = paras.map((p, i) => {
    const k = p.runs.findIndex((r) => r.obj?.id === nodeId);
    if (k < 0) return p;
    let o = 0;
    for (let j = 0; j < k; j++) o += p.runs[j].text.length;
    at = { p: i, o };
    const runs = p.runs.filter((_, j) => j !== k);
    return { ...p, runs: runs.length ? runs : [{ ...p.runs[k], text: "", obj: undefined }] };
  });
  let objs = st.objs.filter((o) => o.node.id !== nodeId);
  const inline = new Map(st.inline ?? []);
  inline.delete(nodeId);
  // the text position next to the picture (by its place on the page)
  if (!at) {
    const b = objSize(node);
    at = posAt(flowLines(pages, seg), pi, node.transform.x, node.transform.y + b.h / 2) ?? { p: 0, o: 0 };
  }
  const pos: Pos = at;
  let free: SceneNode | null = null;
  if (layout === "inline") {
    node = { ...node, flow: true, ...(node.type === "IMAGE" ? { place: { mode: "inline" } } : {}) } as SceneNode;
    const sz = objSize(node);
    const res = RT.insertRun(paras, pos, { ...RT.formatAt(paras, pos), text: OBJ_CHAR, obj: { id: node.id, w: sz.w, h: sz.h }, underline: false } as TextRun);
    paras = res.paras;
    inline.set(node.id, node);
  } else if (layout === "square" || layout === "topBottom") {
    node = { ...node, flow: true, ...(node.type === "IMAGE" ? { place: { mode: "float", wrap: layout, para: paras[pos.p]?.id } } : {}) } as SceneNode;
    objs = [...objs, { node, before: paras[Math.min(paras.length - 1, pos.p)].id }];
  } else {
    const { flow: _f, ...rest } = node as SceneNode & { flow?: true };
    free = { ...rest, ...(node.type === "IMAGE" ? { place: { mode: "float", wrap: layout, para: paras[pos.p]?.id } } : {}) } as SceneNode;
  }
  let out = pages.map((p, i) => (i === pi ? { ...p, nodes: p.nodes.filter((n) => n.id !== nodeId) } : p));
  out = reflowSegment(out, seg.start, { ...st, paras, objs: reanchor(objs, st.paras, paras), inline });
  if (free) {
    const f = free;
    out = out.map((p, i) => (i === pi ? { ...p, nodes: layout === "behind" ? [f, ...p.nodes] : [...p.nodes, f] } : p));
  }
  selfWrite = true;
  try {
    s.commit(tx("docflow.hist.picLayout"), (d) => {
      d.pages = out as typeof d.pages;
    });
  } finally {
    selfWrite = false;
  }
  S().set({ selection: [nodeId] });
  return true;
}
