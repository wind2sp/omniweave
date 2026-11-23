// In-place rich text editor for TEXT nodes (Word / 한글 style character and paragraph formatting).
//
// The model (TextParagraph[] / TextRun[]) is the source of truth. The contenteditable DOM is
// rendered from the model; ordinary edits arrive as `beforeinput` events, are applied to the
// model with the pure functions in core/richtext.ts and the DOM is re-rendered. Hangul (IME)
// composition is the one exception: the browser edits the DOM while composing, and only after
// `compositionend` is the DOM read back into the model — nothing is normalised, re-rendered or
// committed while a syllable is being composed.
//
// Every change reaches the document through store.commit (typing is grouped into one step per
// pause) or a store gesture (colour drags / number scrubs), so undo and the history timeline
// see the editor like any other command.

import { isAppChord } from "./appKeys";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Draft } from "immer";
import { create } from "zustand";
import * as RT from "../core/richtext";
import { useStore } from "../core/store";
import { SCRIPT_SCALE, cssFamily, lineHeightOf, plainText } from "../core/text";
import { paraLineRatio, wordMultipleOf } from "../core/lineSpacing";
import { uid, type OmwDocument, type Page, type TextNode, type TextParagraph, type TextRun } from "../core/types";
import type { ListDef } from "../core/style/types";
import type { ListCtx } from "../core/lists";
import type { Live } from "./shell/ops";
import { insertBreak } from "./pageSetupActions";
import { fieldNow, hfEditNode, parseHfId, setHfParas } from "../core/headerFooter";
import type { FieldKind } from "../core/types";
import { t as tx, useT } from "../i18n";
import { spellAvailable, useSpell } from "./spell";

const S = () => useStore.getState();
const ZW = "​";
const clean = (s: string) => s.replace(/​/g, "");
/**
 * Text of a DOM text node read back into a run (after IME composition): placeholders removed, no-break
 * spaces as spaces. "\n" is kept: the editor is white-space: pre-wrap, so a line break inside a paragraph
 * (Word w:br, HWPX hp:lineBreak) is rendered as "\n" and must not be deleted by typing elsewhere.
 */
export const domRunText = (s: string) => clean(s).replace(/\u00a0/g, " ").replace(/\r\n?/g, "\n");

// ───────── status + command API shared with the ribbon ─────────

export interface RichStatus {
  active: boolean;
  nodeId: string | null;
  /** format at the caret / common format of the selection (mixed keys are absent) */
  fmt: Partial<RT.RunFormat>;
  /** paragraph properties common to the paragraphs the selection touches */
  para: ReturnType<typeof RT.paraFormat>;
  collapsed: boolean;
}

const IDLE: RichStatus = { active: false, nodeId: null, fmt: {}, para: {}, collapsed: true };
export const useRichStatus = create<RichStatus>(() => IDLE);

export interface RichApi {
  toggle: (key: RT.ToggleKey) => void;
  script: (s: "super" | "sub") => void;
  /** set (or with null, clear) one character format on the selection / next input */
  setRun: <K extends keyof RT.RunFormat>(key: K, value: RT.RunFormat[K] | null, label: string) => void;
  runLive: <K extends keyof RT.RunFormat>(key: K, label: string) => Live<RT.RunFormat[K]>;
  setPara: (patch: RT.ParaPatch, label: string) => void;
  paraLive: <K extends keyof RT.ParaPatch>(key: K, label: string) => Live<NonNullable<RT.ParaPatch[K]>>;
  list: (kind: "li" | "oli") => void;
  /** multi-level list of a definition (preset name or node list id) on the paragraphs; again: off */
  listApply: (def: string, lists?: ListDef[]) => void;
  /** list level one deeper (+1) / shallower (-1) */
  listLevel: (by: 1 | -1) => void;
  /** heading outline numbering with a definition (again: off) */
  outline: (def: string, lists?: ListDef[]) => void;
  /** restart the numbers at the first selected item (null: continue) */
  listStart: (start: number | null) => void;
  /** list definitions of the text being edited */
  listDefs: () => ListDef[];
  /** give list instance `listId` the definition `def` (stored in `lists`) */
  listRedefine: (listId: string, def: string, lists: ListDef[], start?: number | null) => void;
  /** move the first selected paragraph and what follows to a new page (문단 앞에서 쪽 나누기); false when it cannot */
  breakBefore?: (patch?: RT.ParaPatch) => boolean;
  heading: (level: 0 | 1 | 2 | 3) => void;
  /** type `text` at the caret (replacing the selection), as if typed */
  insertText: (text: string) => void;
  /** insert a field (쪽 번호, 전체 쪽 수, 날짜 …) at the caret: one undo step */
  insertField: (kind: FieldKind) => void;
  focus: () => void;
}

let activeApi: RichApi | null = null;
/** The editor currently open on the canvas (null when no text is being edited). */
export const richApi = () => activeApi;
/** Another editor (the document body flow, ui/docFlow.ts) takes the ribbon's commands; null when it closes. */
export function setRichApi(api: RichApi | null, owner?: RichApi | null) {
  if (api || owner === undefined || activeApi === owner) activeApi = api;
}

// last pointer press, used to put the caret where the user double-clicked
let lastDown = { x: 0, y: 0, t: 0 };
if (typeof window !== "undefined")
  window.addEventListener("pointerdown", (e) => (lastDown = { x: e.clientX, y: e.clientY, t: Date.now() }), true);

// ───────── document helpers ─────────

function findNode(doc: OmwDocument, id: string): TextNode | undefined {
  // a page's header / footer (core/headerFooter.ts): a text node made for the editor, the same object per document state
  if (parseHfId(id)) return hfEditNode(doc, id);
  for (const p of doc.pages) for (const n of p.nodes) if (n.id === id && n.type === "TEXT") return n;
  for (const p of doc.masters) for (const n of p.nodes) if (n.id === id && n.type === "TEXT") return n;
  return undefined;
}

function setNodeParas(d: Draft<OmwDocument>, id: string, paras: TextParagraph[]) {
  const hf = parseHfId(id);
  if (hf) return setHfParas(d.pages as Page[], hf.pageId, hf.area, paras);
  for (const p of [...d.pages, ...d.masters])
    for (const n of p.nodes)
      if (n.id === id && n.type === "TEXT") {
        // list numbers count on into the text boxes after this one (an imported list across pages) — also when this
        // text has just lost its last list item, so the boxes after it count from where the list now is
        const hadList = n.paragraphs.some((q) => q.list);
        n.paragraphs = paras as Draft<TextParagraph>[];
        if (hadList || paras.some((q) => q.list)) RT.renumberAfter(d.pages as Page[], id);
        return;
      }
}

function setNodeLists(d: Draft<OmwDocument>, id: string, lists: ListDef[]) {
  for (const p of [...d.pages, ...d.masters])
    for (const n of p.nodes)
      if (n.id === id && n.type === "TEXT") {
        if (lists.length) n.lists = lists as Draft<ListDef>[];
        else delete n.lists;
      }
}

/** A selection moved by per-paragraph text length changes at offset 0 (list markers written or removed). */
function shiftSel(sel: RT.Range, delta: number[]): RT.Range {
  const mv = (p: RT.Pos) => ({ p: p.p, o: Math.max(0, p.o + (delta[p.p] ?? 0)) });
  return { start: mv(sel.start), end: mv(sel.end) };
}

/** the run's font family list, as the canvas draws it (core/text.ts cssFamily) */
const fontFamilyCss = (r: Pick<RT.RunFormat, "fontFamily" | "latinFont">) => cssFamily(r);

function styleRun(span: HTMLElement, r: RT.RunFormat) {
  const st = span.style;
  // individual properties: the `font` shorthand would reset line-height
  st.fontFamily = fontFamilyCss(r);
  st.fontSize = `${r.script ? r.fontSize * SCRIPT_SCALE : r.fontSize}px`;
  st.fontWeight = r.bold ? "700" : "400";
  st.fontStyle = r.italic ? "italic" : "normal";
  st.color = r.color;
  if (r.script) st.verticalAlign = r.script === "super" ? "super" : "sub";
  if (r.highlight) st.backgroundColor = r.highlight;
  const deco = [r.underline && "underline", r.strike && "line-through"].filter(Boolean).join(" ");
  if (deco) st.textDecoration = deco;
  // 장평 / 한글 자간 (core/text.ts runScale): flowing DOM text cannot narrow its glyphs, so the extra advance goes into
  // letter-spacing (an average share of the size) and the edited text wraps about where the page does
  const k = ((r.hscale ?? 100) / 100) * (1 + (r.spacingPct ?? 0) / 100);
  const ls = (r.letterSpacing ?? 0) + (k !== 1 ? (k - 1) * r.fontSize * 0.75 : 0);
  if (ls) st.letterSpacing = `${ls}px`;
}

/**
 * A paragraph's inline style. Space before / after: CSS margins of block siblings collapse to the larger one, which is
 * Word's spacing (TextNode.wordSpacing "max"); text whose spacings add up (한글, our own, Word with
 * w:doNotUseHTMLParagraphAutoSpacing) takes them as padding, which does not collapse — the box being typed in is then
 * as tall as the frame on the canvas and the caret stays on its lines.
 */
export function styleParagraph(div: HTMLElement, p: TextParagraph, ws?: TextNode["wordSpacing"]) {
  const st = div.style;
  const [top, bottom] = ws === "max" ? (["marginTop", "marginBottom"] as const) : (["paddingTop", "paddingBottom"] as const);
  st.textAlign = p.align === "JUSTIFY" ? "justify" : p.align.toLowerCase();
  st.fontSize = `${p.runs[0]?.fontSize ?? 16}px`;
  // a Word multiple: the font's single line × v, as a multiple of the size (core/lineSpacing.ts)
  const wm = wordMultipleOf(p);
  st.lineHeight = p.lineHeight ? `${lineHeightOf(p, p.runs[0]?.fontSize ?? 16)}px` : String(wm !== undefined ? wm * paraLineRatio(p) : p.lineSpacing);
  st.paddingLeft = `${p.indentLeft ?? 0}px`;
  if (p.indentRight) st.paddingRight = `${p.indentRight}px`;
  if (p.spaceBefore) st[top] = `${p.spaceBefore}px`;
  st.textIndent = `${p.indent}px`;
  st[bottom] = `${p.spaceAfter}px`;
}

/** offset in a text node's raw data for a clean (zero-width-free) offset k */
function rawOffset(s: string, k: number): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (n === k && s[i] !== ZW) return i;
    if (s[i] !== ZW) n++;
  }
  return s.length;
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = w.nextNode(); t; t = w.nextNode()) out.push(t as Text);
  return out;
}

// ───────── the engine (imperative; React only positions the box) ─────────

class Engine {
  paras: TextParagraph[] = [];
  /** paragraphs and format table the current DOM was rendered from */
  renderedParas: TextParagraph[] = [];
  fmts: RT.RunFormat[] = [];
  sel: RT.Range = { start: { p: 0, o: 0 }, end: { p: 0, o: 0 } };
  backward = false;
  /** "next input" format at a collapsed caret (toggled with nothing selected) */
  pending: { fmt: RT.RunFormat; pos: RT.Pos } | null = null;
  composing = false;
  needSync = false;
  dirty = false;
  timer: ReturnType<typeof setTimeout> | undefined;
  self = false;
  known: TextNode | undefined;
  done = false;
  gestureBase: TextParagraph[] | null = null;
  private off: (() => void)[] = [];

  constructor(
    public el: HTMLDivElement,
    public id: string,
    public onDone: () => void,
  ) {}

  // ── lifecycle ──

  mount() {
    this.known = findNode(S().doc, this.id);
    if (!this.known) return this.onDone();
    this.paras = this.known.paragraphs;
    this.render();
    const end = RT.docEnd(this.paras);
    this.sel = { start: end, end };
    this.el.focus({ preventScroll: true });
    // caret where the user double-clicked, when that point is inside the text
    if (Date.now() - lastDown.t < 1500) {
      const cr = (document as any).caretRangeFromPoint?.(lastDown.x, lastDown.y) as Range | null;
      if (cr && this.el.contains(cr.startContainer)) {
        const p = this.domToPos(cr.startContainer, cr.startOffset);
        if (p) this.sel = { start: p, end: p };
      }
    }
    this.restoreSel();
    this.pushStatus();
    // the editor usually opens inside a pointerdown; the following mousedown would move the focus
    // to the page body, so take it back once that event is over
    const refocus = setTimeout(() => {
      if (this.done || document.activeElement === this.el) return;
      this.el.focus({ preventScroll: true });
      this.restoreSel();
    }, 0);
    this.off.push(() => clearTimeout(refocus));

    const on =<K extends keyof HTMLElementEventMap>(t: EventTarget, type: K | string, fn: (e: any) => void, opts?: AddEventListenerOptions | boolean) => {
      t.addEventListener(type, fn, opts);
      this.off.push(() => t.removeEventListener(type, fn, opts));
    };
    on(this.el, "beforeinput", (e: InputEvent) => this.onBeforeInput(e));
    on(this.el, "keydown", (e: KeyboardEvent) => this.onKeyDown(e));
    on(this.el, "compositionstart", () => {
      this.beginComposition();
      this.composing = true;
    });
    on(this.el, "compositionend", () => this.onCompositionEnd());
    on(this.el, "input", () => {
      if (this.needSync && !this.composing) {
        this.needSync = false;
        this.syncFromDom();
        this.pushStatus();
      }
    });
    on(this.el, "copy", (e: ClipboardEvent) => this.onCopy(e, false));
    on(this.el, "cut", (e: ClipboardEvent) => this.onCopy(e, true));
    on(this.el, "paste", (e: ClipboardEvent) => this.onPaste(e));
    on(this.el, "drop", (e: DragEvent) => e.preventDefault());
    on(document, "selectionchange", () => this.onSelectionChange());
    on(window, "pointerdown", (e: PointerEvent) => this.onOutsideDown(e), true);
    this.off.push(useStore.subscribe(() => this.onStore()));
    activeApi = this.api();
  }

  dispose() {
    for (const f of this.off) f();
    this.off = [];
    clearTimeout(this.timer);
    if (activeApi && this.done) activeApi = null;
    useRichStatus.setState(IDLE);
  }

  /** Commit pending typing, drop the node when it was left empty, close the editor. */
  finish() {
    if (this.done) return;
    if (this.composing) {
      this.composing = false;
      this.syncFromDom();
    }
    this.flush();
    this.done = true;
    activeApi = null;
    const n = findNode(S().doc, this.id);
    // (an emptied header / footer stays: it is blank, not a text box to remove; so does a slide placeholder, which then
    // shows its prompt again — core/slides.ts)
    if (n && !parseHfId(this.id) && !plainText(n).trim() && !(n.type === "TEXT" && n.ph)) {
      S().commit(tx("shell.hist.removeEmptyText"), (d) => {
        for (const pg of [...d.pages, ...d.masters]) pg.nodes = pg.nodes.filter((x) => x.id !== this.id);
      });
      S().set({ selection: [] });
    }
    this.dispose();
    this.onDone();
  }

  // ── model ⇄ DOM ──

  render() {
    const el = this.el;
    const fmts: RT.RunFormat[] = [];
    const fmtIndex = (f: RT.RunFormat) => fmts.push(f) - 1;
    const frag = document.createDocumentFragment();
    this.paras.forEach((p, i) => {
      const div = document.createElement("div");
      div.className = "rt-p";
      div.dataset.pi = String(i);
      styleParagraph(div, p, this.known?.wordSpacing);
      const segs: { fmt: RT.RunFormat; text: string | null; pending?: boolean }[] = [];
      const pend = this.pending && this.pending.pos.p === i ? this.pending : null;
      let placed = false;
      let acc = 0;
      for (const r of p.runs) {
        if (!r.text) continue;
        const end = acc + r.text.length;
        if (pend && !placed && pend.pos.o >= acc && pend.pos.o <= end) {
          if (pend.pos.o > acc) segs.push({ fmt: RT.runFormat(r), text: r.text.slice(0, pend.pos.o - acc) });
          segs.push({ fmt: pend.fmt, text: ZW, pending: true });
          placed = true;
          if (pend.pos.o < end) segs.push({ fmt: RT.runFormat(r), text: r.text.slice(pend.pos.o - acc) });
        } else segs.push({ fmt: RT.runFormat(r), text: r.text });
        acc = end;
      }
      if (pend && !placed) segs.push({ fmt: pend.fmt, text: ZW, pending: true });
      if (!segs.length) segs.push({ fmt: RT.runFormat(p.runs[0] ?? ({} as TextRun)), text: null });
      for (const s of segs) {
        const span = document.createElement("span");
        span.dataset.fi = String(fmtIndex(s.fmt));
        if (s.pending) span.dataset.pending = "1";
        styleRun(span, s.fmt);
        if (s.text === null) span.appendChild(document.createElement("br"));
        else span.textContent = s.text;
        div.appendChild(span);
      }
      frag.appendChild(div);
    });
    el.replaceChildren(frag);
    this.fmts = fmts;
    this.renderedParas = this.paras;
  }

  /** Read the DOM back into paragraphs (after IME composition). Formats come from each span's data-fi. */
  parseDom(): TextParagraph[] {
    const out: TextParagraph[] = [];
    const used = new Set<string>();
    for (const div of Array.from(this.el.children) as HTMLElement[]) {
      const base = this.renderedParas[Number(div.dataset.pi)] ?? out[out.length - 1] ?? this.renderedParas[0];
      if (!base) continue;
      let id = base.id;
      if (used.has(id)) id = uid("p");
      used.add(id);
      const runs: TextRun[] = [];
      let last: RT.RunFormat = RT.runFormat(base.runs[0] ?? ({} as TextRun));
      for (const t of textNodes(div)) {
        const holder = (t.parentElement?.closest("[data-fi]") as HTMLElement | null) ?? null;
        const f = holder && div.contains(holder) ? this.fmts[Number(holder.dataset.fi)] ?? last : last;
        const text = domRunText(t.data);
        last = f;
        if (text) runs.push({ ...f, text } as TextRun);
      }
      out.push({ ...base, id, runs: RT.mergeRuns(runs.length ? runs : [{ ...RT.runFormat(base.runs[0] ?? ({} as TextRun)), text: "" } as TextRun]) });
    }
    return out.length ? out : this.paras;
  }

  /**
   * The model before an IME composition and its caret (with the caret format): what the composed text is inserted into
   * when it is read back, as the body editor does (docFlow.ts onCompositionEnd) — so it is a tracked insertion while
   * changes are recorded and never takes on the marks of the run the browser composed it into (QA doc-review2).
   */
  compBase: { paras: TextParagraph[]; at: RT.Pos; fmt: RT.RunFormat } | null = null;

  beginComposition() {
    if (this.compBase) return;
    // (a selection is deleted through the model on the keydown before: onKeyDown)
    const sel = this.currentSel();
    if (!RT.collapsed(sel)) return;
    const fmt = this.pending && RT.cmpPos(this.pending.pos, sel.start) === 0 ? this.pending.fmt : RT.formatAt(this.paras, sel.start);
    this.compBase = { paras: this.paras, at: sel.start, fmt };
  }

  syncFromDom() {
    const parsed = this.parseDom();
    const b = this.compBase;
    this.compBase = null;
    const res = b ? RT.insertComposed(b.paras, b.at, parsed, b.fmt) : null;
    if (res) {
      this.paras = res.paras;
      this.sel = { start: res.pos, end: res.pos };
      this.backward = false;
    } else {
      this.paras = parsed;
      const s = this.readDomSel();
      if (s) this.sel = s;
    }
    this.markDirty();
  }

  domToPos(node: Node, offset: number): RT.Pos | null {
    const el = this.el;
    if (node === el) return offset >= el.children.length ? RT.docEnd(this.paras) : { p: offset, o: 0 };
    if (!el.contains(node)) return null;
    let div: Node | null = node;
    while (div && div.parentNode !== el) div = div.parentNode;
    if (!div || div.nodeType !== 1) return RT.docEnd(this.paras);
    const p = Array.prototype.indexOf.call(el.children, div);
    const r = document.createRange();
    r.setStart(div, 0);
    try {
      r.setEnd(node, offset);
    } catch {
      return { p, o: 0 };
    }
    return { p, o: clean(r.toString()).length };
  }

  posToDom(pos: RT.Pos): [Node, number] {
    const div = this.el.children[pos.p];
    if (!div) return [this.el, this.el.childNodes.length];
    if (this.pending && RT.cmpPos(this.pending.pos, pos) === 0) {
      const ph = div.querySelector("[data-pending]")?.firstChild;
      if (ph && ph.nodeType === 3) return [ph, (ph as Text).data.length];
    }
    let acc = 0;
    const texts = textNodes(div);
    for (const t of texts) {
      const len = clean(t.data).length;
      if (pos.o <= acc + len) return [t, rawOffset(t.data, pos.o - acc)];
      acc += len;
    }
    const last = texts[texts.length - 1];
    if (last) return [last, last.data.length];
    return [div.firstChild ?? div, 0];
  }

  readDomSel(): RT.Range | null {
    const s = document.getSelection();
    if (!s || !s.rangeCount || !s.anchorNode || !s.focusNode) return null;
    if (!this.el.contains(s.anchorNode) || !this.el.contains(s.focusNode)) return null;
    const a = this.domToPos(s.anchorNode, s.anchorOffset), f = this.domToPos(s.focusNode, s.focusOffset);
    if (!a || !f) return null;
    this.backward = RT.cmpPos(f, a) < 0;
    return RT.range(a, f);
  }

  restoreSel() {
    if (document.activeElement !== this.el) return;
    const s = document.getSelection();
    if (!s) return;
    this.sel = RT.clampRange(this.paras, this.sel);
    const [an, ao] = this.posToDom(this.backward ? this.sel.end : this.sel.start);
    const [fn, fo] = this.posToDom(this.backward ? this.sel.start : this.sel.end);
    try {
      s.setBaseAndExtent(an, ao, fn, fo);
    } catch {
      /* node detached */
    }
  }

  pushStatus() {
    const c = RT.collapsed(this.sel);
    const fmt = c && this.pending ? this.pending.fmt : RT.rangeFormat(this.paras, this.sel);
    useRichStatus.setState({ active: true, nodeId: this.id, fmt, para: RT.paraFormat(this.paras, this.sel.start.p, this.sel.end.p), collapsed: c });
  }

  // ── commits ──

  markDirty() {
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 800);
  }

  flush() {
    clearTimeout(this.timer);
    if (!this.dirty) return;
    if (this.composing) {
      this.timer = setTimeout(() => this.flush(), 400);
      return;
    }
    this.dirty = false;
    this.commitParas(tx("shell.hist.typing"));
  }

  commitParas(label: string) {
    const paras = this.paras;
    this.self = true;
    try {
      S().commit(label, (d) => setNodeParas(d, this.id, paras));
    } finally {
      this.self = false;
    }
    this.known = findNode(S().doc, this.id);
  }

  /** Replace the model with an edit result: re-render, move the caret, then commit or keep typing grouped. */
  apply(paras: TextParagraph[], sel: RT.Range | null, label: string | null) {
    if (label) this.flush();
    this.paras = paras;
    if (sel) {
      this.sel = sel;
      this.backward = false;
    }
    this.render();
    if (document.activeElement !== this.el) this.el.focus({ preventScroll: true });
    this.restoreSel();
    if (label) this.commitParas(label);
    else this.markDirty();
    this.pushStatus();
  }

  reload() {
    const n = findNode(S().doc, this.id);
    if (!n) return this.finish();
    this.known = n;
    this.paras = n.paragraphs;
    this.pending = null;
    this.compBase = null;
    this.dirty = false;
    clearTimeout(this.timer);
    this.render();
    this.restoreSel();
    this.pushStatus();
  }

  onStore() {
    if (this.done) return;
    const s = S();
    if (s.editingTextId !== this.id) return this.finish();
    if (this.self) return;
    const n = findNode(s.doc, this.id);
    if (n === this.known) return;
    if (!n) {
      this.dirty = false;
      return this.finish();
    }
    if (this.composing || this.dirty) {
      // our typing wins; it is committed on the next flush
      this.known = n;
      return;
    }
    this.reload();
  }

  undo(redo: boolean) {
    this.flush();
    if (redo) S().redo();
    else S().undo();
    if (!this.done) this.reload();
  }

  // ── events ──

  onSelectionChange() {
    if (this.composing || this.done) return;
    const r = this.readDomSel();
    if (!r) return;
    this.sel = r;
    if (this.pending && !(RT.collapsed(r) && RT.cmpPos(r.start, this.pending.pos) === 0)) this.pending = null;
    this.pushStatus();
  }

  onOutsideDown(e: PointerEvent) {
    const t = e.target as HTMLElement | null;
    if (!t || this.el.contains(t)) return;
    // ribbon, its tab row and menus, tooltips, and dialogs that act on the caret (Insert symbol, backdrop included)
    if (t.closest?.(".ribbon, .tabrow, .menu-pop, .tooltip, [data-rt-keep], .modal-backdrop:has([data-rt-keep])")) return;
    this.finish();
  }

  onCompositionEnd() {
    this.composing = false;
    // the browser has finished the syllable: read it into the model (no re-render here)
    this.syncFromDom();
    this.pending = null;
    this.pushStatus();
  }

  currentSel(): RT.Range {
    const r = this.readDomSel();
    if (r) this.sel = r;
    return RT.clampRange(this.paras, this.sel);
  }

  insert(text: string) {
    let sel = this.currentSel();
    let paras = this.paras;
    const fmt = this.pending && RT.collapsed(sel) ? this.pending.fmt : undefined;
    if (!RT.collapsed(sel)) ({ paras, pos: sel.start } = RT.deleteRange(paras, sel));
    const res = RT.insertText(paras, sel.start, text, fmt ?? RT.formatAt(this.paras, RT.collapsed(sel) ? sel.start : { ...sel.start, o: sel.start.o + 1 }));
    this.pending = null;
    this.apply(res.paras, { start: res.pos, end: res.pos }, null);
  }

  onBeforeInput(e: InputEvent) {
    const t = e.inputType;
    if (e.isComposing || this.composing || t === "insertCompositionText" || t === "insertFromComposition" || t === "deleteCompositionText") {
      // IME text (WebKit reports the committed syllable as insertFromComposition): the browser edits, we read it back
      if (!this.composing) {
        this.beginComposition();
        this.needSync = true;
      }
      return;
    }
    e.preventDefault();
    switch (t) {
      case "insertText":
      case "insertReplacementText": {
        const text = e.data ?? e.dataTransfer?.getData("text/plain") ?? "";
        if (text) this.insert(text);
        return;
      }
      case "insertParagraph":
      case "insertLineBreak": {
        let sel = this.currentSel();
        let paras = this.paras;
        if (!RT.collapsed(sel)) ({ paras, pos: sel.start } = RT.deleteRange(paras, sel));
        const res = RT.splitParagraph(paras, sel.start, { body: RT.bodyFormat(paras), lc: this.lc() });
        this.pending = null;
        this.apply(res.paras, { start: res.pos, end: res.pos }, null);
        return;
      }
      case "historyUndo":
        return this.undo(false);
      case "historyRedo":
        return this.undo(true);
      case "formatBold":
        return this.api().toggle("bold");
      case "formatItalic":
        return this.api().toggle("italic");
      case "formatUnderline":
        return this.api().toggle("underline");
      case "formatStrikeThrough":
        return this.api().toggle("strike");
      case "formatSuperscript":
        return this.api().script("super");
      case "formatSubscript":
        return this.api().script("sub");
    }
    if (t.startsWith("delete")) {
      const sel = this.currentSel();
      let res: { paras: TextParagraph[]; pos: RT.Pos };
      if (!RT.collapsed(sel)) res = RT.deleteRange(this.paras, sel);
      else {
        const tr = e.getTargetRanges?.()[0];
        const a = tr && this.domToPos(tr.startContainer, tr.startOffset);
        const b = tr && this.domToPos(tr.endContainer, tr.endOffset);
        if (a && b && RT.cmpPos(a, b) !== 0) res = RT.deleteRange(this.paras, RT.range(a, b));
        else res = RT.deleteChar(this.paras, sel.start, /Backward/.test(t) ? -1 : 1);
      }
      this.pending = null;
      this.apply(res.paras, { start: res.pos, end: res.pos }, null);
    }
    // anything else (insertOrderedList, insertFromDrop, …) is blocked so the DOM never drifts from the model
  }

  onKeyDown(e: KeyboardEvent) {
    // 열기 / 저장 / 새로 / 닫기 / 찾기 / 인쇄 / tab keys: on to the app (what was typed is put into the document first)
    if (isAppChord(e)) {
      this.flush();
      return;
    }
    e.stopPropagation();
    if (e.isComposing || e.keyCode === 229) {
      // an IME is about to compose over a selection: delete it through the model first,
      // so the browser never merges paragraph elements on its own
      if (!this.composing) {
        const sel = this.currentSel();
        if (!RT.collapsed(sel)) {
          const res = RT.deleteRange(this.paras, sel);
          this.apply(res.paras, { start: res.pos, end: res.pos }, null);
        }
      }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const api = this.api();
    // on a document page Ctrl+Enter is 쪽 나누기 and Alt+Shift+Enter 구역 나누기 at the caret (Word, 한글); elsewhere
    // Ctrl+Enter ends editing
    if (e.key === "Enter" && ((mod && !e.shiftKey && !e.altKey) || (!mod && e.altKey && e.shiftKey)) && this.onDocumentPage()) {
      e.preventDefault();
      return this.breakAtCaret(mod ? "page" : "section");
    }
    if (e.key === "Escape" || (e.key === "Enter" && mod)) {
      e.preventDefault();
      return this.finish();
    }
    if (e.key === "Tab" && !mod) {
      e.preventDefault();
      // in a list: one level deeper / shallower (Word, 한글); elsewhere a tab character
      const [a, b] = this.paraRange();
      const res = RT.changeListLevel(this.paras, a, b, e.shiftKey ? -1 : 1, this.lc());
      if (res) return this.apply(res.paras, shiftSel(RT.clampRange(this.paras, this.currentSel()), res.delta), tx("paragraph.hist.listLevel"));
      if (e.shiftKey) return;
      return this.insert("\t");
    }
    if (!mod || e.altKey) return;
    const handled = () => e.preventDefault();
    if (k === "b") return handled(), api.toggle("bold");
    if (k === "i") return handled(), api.toggle("italic");
    if (k === "u") return handled(), api.toggle("underline");
    if (k === "z" && !e.shiftKey) return handled(), this.undo(false);
    if (k === "y" || (k === "z" && e.shiftKey)) return handled(), this.undo(true);
    if (e.code === "Equal") return handled(), api.script(e.shiftKey ? "super" : "sub");
    if (e.shiftKey && k === "x") return handled(), api.toggle("strike");
    if (k === "l" && !e.shiftKey) return handled(), api.setPara({ align: "LEFT" }, tx("shell.hist.alignLeft"));
    if (k === "e" && !e.shiftKey) return handled(), api.setPara({ align: "CENTER" }, tx("shell.hist.alignCenter"));
    if (k === "r" && !e.shiftKey) return handled(), api.setPara({ align: "RIGHT" }, tx("shell.hist.alignRight"));
    if (k === "j" && !e.shiftKey) return handled(), api.setPara({ align: "JUSTIFY" }, tx("shell.hist.justify"));
    if (e.altKey && /^[0-3]$/.test(k)) return handled(), api.heading(Number(k) as 0 | 1 | 2 | 3);
    if (k === "s") return handled(), this.flush(); // keep typing in the document before a save shortcut
  }

  /** The text box is on a document page (not a slide, design or master page). */
  onDocumentPage(): boolean {
    return !!S().doc.pages.find((p) => p.kind === "DOCUMENT" && p.nodes.some((n) => n.id === this.id));
  }

  /** Split the text at the caret and move what follows (and the objects below) to a new page: one undo step. */
  breakAtCaret(kind: "page" | "section") {
    if (this.composing) return;
    this.flush();
    const sel = this.currentSel();
    let paras = this.paras;
    let pos = sel.start;
    if (!RT.collapsed(sel)) ({ paras, pos } = RT.deleteRange(paras, sel));
    const res = RT.splitParagraph(paras, pos, { body: RT.bodyFormat(paras), lc: this.lc() });
    const keep = res.paras.slice(0, res.pos.p), moved = res.paras.slice(res.pos.p);
    this.dirty = false;
    clearTimeout(this.timer);
    this.done = true;
    activeApi = null;
    this.dispose();
    insertBreak(kind, { nodeId: this.id, keep, moved });
    this.onDone();
  }

  onCopy(e: ClipboardEvent, cut: boolean) {
    e.preventDefault();
    e.stopPropagation();
    const sel = this.currentSel();
    if (RT.collapsed(sel)) return;
    e.clipboardData?.setData("text/plain", RT.rangeText(this.paras, sel));
    if (cut) {
      const res = RT.deleteRange(this.paras, sel);
      this.apply(res.paras, { start: res.pos, end: res.pos }, tx("shell.hist.cut"));
    }
  }

  onPaste(e: ClipboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const dt = e.clipboardData;
    if (!dt) return;
    const sel = this.currentSel();
    const base = this.pending && RT.collapsed(sel) ? this.pending.fmt : RT.formatAt(this.paras, sel.start);
    const res = RT.pasteData(this.paras, sel, base, dt.getData("text/html"), dt.getData("text/plain"));
    if (!res) return;
    this.pending = null;
    this.apply(res.paras, { start: res.pos, end: res.pos }, tx("shell.hist.paste"));
  }

  // ── commands ──

  private runCmd(label: string, op: (paras: TextParagraph[], sel: RT.Range) => TextParagraph[], patchFor: (cur: RT.RunFormat) => RT.RunPatch) {
    const sel = document.activeElement === this.el ? this.currentSel() : RT.clampRange(this.paras, this.sel);
    if (RT.collapsed(sel)) {
      // nothing selected: the format applies to what is typed next at the caret
      const cur = this.pending?.fmt ?? RT.formatAt(this.paras, sel.start);
      const fmt = RT.runFormat(RT.applyPatch({ ...cur, text: "" } as TextRun, patchFor(cur)));
      this.pending = { fmt, pos: sel.start };
      this.flush();
      this.render();
      this.el.focus({ preventScroll: true });
      this.restoreSel();
      this.pushStatus();
      return;
    }
    this.apply(op(this.paras, sel), sel, label);
  }

  /** List context of this text: its own definitions and the numbers reached in the text boxes before it. */
  lc(): ListCtx {
    const n = findNode(S().doc, this.id);
    return { defs: n?.lists, seed: RT.listSeedBefore(S().doc.pages, this.id) };
  }

  /** Apply a list edit; new list definitions are stored on the node in the same undo step. */
  withLists(lists: ListDef[] | undefined, fn: (lc: ListCtx) => { paras: TextParagraph[]; delta: number[] }, label: string) {
    const lc = this.lc();
    const res = fn(lists ? { ...lc, defs: lists } : lc);
    if (!lists) return this.apply(res.paras, shiftSel(RT.clampRange(this.paras, this.sel), res.delta), label);
    this.flush();
    this.self = true;
    try {
      S().commit(label, (d) => {
        setNodeLists(d, this.id, lists);
        setNodeParas(d, this.id, res.paras);
      });
    } finally {
      this.self = false;
    }
    this.known = findNode(S().doc, this.id);
    this.paras = res.paras;
    this.render();
    this.restoreSel();
    this.pushStatus();
  }

  private paraRange(): [number, number] {
    const sel = document.activeElement === this.el ? this.currentSel() : RT.clampRange(this.paras, this.sel);
    return [sel.start.p, sel.end.p];
  }

  api(): RichApi {
    const label = (key: RT.ToggleKey) => (key === "strike" ? tx("shell.hist.strike") : tx(`cmd.text.${key}`));
    const shift = (sel: RT.Range, delta: number[]): RT.Range => {
      const mv = (p: RT.Pos) => ({ p: p.p, o: Math.max(0, p.o + (delta[p.p] ?? 0)) });
      return { start: mv(sel.start), end: mv(sel.end) };
    };
    return {
      toggle: (key) =>
        this.runCmd(label(key), (ps, sel) => RT.toggleRunFormat(ps, sel, key), (cur) => ({ [key]: !cur[key] })),
      script: (s) =>
        this.runCmd(s === "super" ? tx("shell.hist.superscript") : tx("shell.hist.subscript"), (ps, sel) => RT.toggleScript(ps, sel, s), (cur) => ({ script: cur.script === s ? null : s })),
      setRun: (key, value, label) =>
        this.runCmd(label, (ps, sel) => RT.applyRunFormat(ps, sel, { [key]: value } as RT.RunPatch), () => ({ [key]: value }) as RT.RunPatch),
      runLive: <K extends keyof RT.RunFormat>(key: K, label: string): Live<RT.RunFormat[K]> => ({
        set: (v) => this.api().setRun(key, v, label),
        begin: () => {
          if (RT.collapsed(this.sel)) return;
          this.flush();
          this.gestureBase = this.paras;
          S().beginGesture();
        },
        live: (v) => {
          if (!this.gestureBase) return this.api().setRun(key, v, label);
          const next = RT.applyRunFormat(this.gestureBase, this.sel, { [key]: v } as RT.RunPatch);
          this.self = true;
          try {
            S().updateGesture((d) => setNodeParas(d, this.id, next));
          } finally {
            this.self = false;
          }
          this.paras = next;
          this.render();
          this.restoreSel();
        },
        end: () => this.endGesture(label),
      }),
      setPara: (patch, label) => {
        const [a, b] = this.paraRange();
        this.apply(RT.applyParaFormat(this.paras, a, b, patch), null, label);
      },
      paraLive: (key, label) => ({
        set: (v) => this.api().setPara({ [key]: v } as RT.ParaPatch, label),
        begin: () => {
          this.flush();
          this.gestureBase = this.paras;
          S().beginGesture();
        },
        live: (v) => {
          const [a, b] = this.paraRange();
          const next = RT.applyParaFormat(this.gestureBase ?? this.paras, a, b, { [key]: v } as RT.ParaPatch);
          this.self = true;
          try {
            S().updateGesture((d) => setNodeParas(d, this.id, next));
          } finally {
            this.self = false;
          }
          this.paras = next;
          this.render();
          this.restoreSel();
        },
        end: () => this.endGesture(label),
      }),
      list: (kind) => {
        const [a, b] = this.paraRange();
        const res = RT.toggleList(this.paras, a, b, kind);
        this.apply(res.paras, shift(RT.clampRange(this.paras, this.sel), res.delta), kind === "li" ? tx("shell.hist.bullets") : tx("shell.hist.numbering"));
      },
      heading: (level) => {
        const [a, b] = this.paraRange();
        this.apply(RT.setHeading(this.paras, a, b, level, RT.bodyFormat(this.paras), this.lc()), null, level ? tx("shell.hist.heading", { level }) : tx("shell.hist.body"));
      },
      listApply: (def, lists) => {
        const [a, b] = this.paraRange();
        this.withLists(lists, (lc) => RT.applyList(this.paras, a, b, def, lc), tx("paragraph.hist.list"));
      },
      listLevel: (by) => {
        const [a, b] = this.paraRange();
        const res = RT.changeListLevel(this.paras, a, b, by, this.lc());
        if (res) this.apply(res.paras, shiftSel(RT.clampRange(this.paras, this.sel), res.delta), tx("paragraph.hist.listLevel"));
      },
      outline: (def, lists) => this.withLists(lists, (lc) => RT.applyOutline(this.paras, def, lc), tx("paragraph.hist.outline")),
      listStart: (start) => {
        const [a] = this.paraRange();
        const res = RT.setListStart(this.paras, a, start, this.lc());
        this.apply(res.paras, shiftSel(RT.clampRange(this.paras, this.sel), res.delta), tx("paragraph.hist.listStart"));
      },
      listDefs: () => findNode(S().doc, this.id)?.lists ?? [],
      listRedefine: (listId, def, lists, start) => {
        const [a] = this.paraRange();
        // the level format and a restart change are one undo step
        this.withLists(
          lists,
          (lc) => {
            const r = RT.redefineList(this.paras, listId, def, lc);
            if (start === undefined) return r;
            const s = RT.setListStart(r.paras, a, start, lc);
            return { paras: s.paras, delta: r.delta.map((d, i) => d + s.delta[i]) };
          },
          tx("paragraph.hist.listFormat"),
        );
      },
      breakBefore: (patch) => {
        const [a, b] = this.paraRange();
        if (a === 0 || this.composing || !this.onDocumentPage()) return false;
        this.flush();
        // the dialog's other paragraph changes go into the same undo step as the page break
        const paras = patch ? RT.applyParaFormat(this.paras, a, b, patch) : this.paras;
        const keep = paras.slice(0, a), moved = paras.slice(a);
        this.dirty = false;
        clearTimeout(this.timer);
        this.done = true;
        activeApi = null;
        this.dispose();
        insertBreak("page", { nodeId: this.id, keep, moved });
        this.onDone();
        return true;
      },
      insertField: (kind) => {
        if (this.done || this.composing) return;
        this.flush();
        let sel = this.currentSel();
        let paras = this.paras;
        if (!RT.collapsed(sel)) ({ paras, pos: sel.start } = RT.deleteRange(paras, sel));
        // the field shows this page's value now; every page draws its own (core/headerFooter.ts)
        const doc = S().doc;
        const hf = parseHfId(this.id);
        const i = hf ? doc.pages.findIndex((p) => p.id === hf.pageId) : doc.pages.findIndex((p) => p.nodes.some((n) => n.id === this.id));
        const run = fieldNow(doc, Math.max(0, i), kind, RT.formatAt(paras, sel.start));
        const res = RT.insertRun(paras, sel.start, run);
        this.pending = null;
        this.apply(res.paras, { start: res.pos, end: res.pos }, tx("headerfooter.hist.field"));
      },
      insertText: (text) => {
        if (this.done || !text) return;
        this.insert(text);
        this.pushStatus();
      },
      focus: () => {
        this.el.focus({ preventScroll: true });
        this.restoreSel();
      },
    };
  }

  endGesture(label: string) {
    if (!this.gestureBase) return;
    this.gestureBase = null;
    this.self = true;
    try {
      S().endGesture(label);
    } finally {
      this.self = false;
    }
    this.known = findNode(S().doc, this.id);
    this.el.focus({ preventScroll: true });
    this.restoreSel();
    this.pushStatus();
  }
}

// ───────── component ─────────

export function RichTextEditor({ nodeId, onDone }: { nodeId: string; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const view = useStore((s) => s.view);
  const node = useStore((s) => findNode(s.doc, nodeId));
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  useT();

  useLayoutEffect(() => {
    const eng = new Engine(ref.current!, nodeId, () => doneRef.current());
    eng.mount();
    return () => {
      // unmounted without finishing (page switch, document load): keep what was typed
      if (!eng.done) {
        eng.flush();
        eng.done = true;
        activeApi = null;
      }
      eng.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId]);

  useEffect(() => () => useRichStatus.setState(IDLE), []);

  const t = node?.transform ?? { x: 0, y: 0, rotation: 0, scale: 1 };
  const scale = Math.max(0.01, view.zoom * t.scale);
  // spelling while typing in place: the web view checks with the same Windows dictionaries (ui/spell.ts draws the rest)
  const spell = useSpell((s) => s.on) && spellAvailable();
  const pageBg = useStore((s) => {
    const bg = (s.doc.pages.find((p) => p.id === s.pageId) ?? s.doc.masters.find((p) => p.id === s.pageId))?.background;
    return bg && /^#[0-9a-f]{6}$/i.test(bg) ? bg : "#ffffff";
  });
  return (
    <div
      ref={ref}
      className="rich-editor"
      contentEditable
      suppressContentEditableWarning
      spellCheck={spell}
      lang={spell ? node?.lang ?? undefined : undefined}
      role="textbox"
      aria-multiline="true"
      aria-label={tx("shell.textEdit")}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      style={{
        // CSS zoom (not a scale transform) and an opaque background: Chromium then draws the text being typed at its
        // real pixel size with subpixel (LCD) antialiasing, as crisp as the canvas around it. zoom scales left / top too.
        zoom: scale,
        left: (t.x * view.zoom + view.panX) / scale,
        top: (t.y * view.zoom + view.panY) / scale,
        width: node?.width ?? 100,
        transform: t.rotation ? `rotate(${t.rotation}deg)` : undefined,
        wordBreak: node?.wordBreak === "normal" ? "normal" : "keep-all",
        background: node?.background ?? pageBg,
      }}
    />
  );
}
