// Character- and paragraph-level formatting on the TextParagraph/TextRun model.
// Pure functions only: every operation takes paragraphs and returns new paragraphs (inputs are
// never mutated), so the rich text editor can hand the result straight to store.commit.
//
// Positions are { p: paragraph index, o: UTF-16 offset inside the paragraph's text }. Offsets
// coming from the DOM always sit on grapheme boundaries; offsets computed here are snapped to
// grapheme clusters (Intl.Segmenter) so Hangul syllables, decomposed jamo and emoji never split.

import { graphemes } from "./text";
import { isOwnInsertion, isOwnRevision, isRemoved, newRevision, sameMarks, skipHidden, trackingOn } from "./review";
import { paraLineRatio, withWordMultiple, wordMultipleOf } from "./lineSpacing";
import { DEFAULT_RUN, uid, type Align, type Ruby, type Page, type ParaLineHeight, type ParaList, type ParaRole, type Revision, type TextNode, type TextParagraph, type TextRun } from "./types";
import { LIST_PRESETS, MARKER_SEP, MAX_LEVELS, isBulletLevel, levelIndent, levelOf, listNumbers, markerText, newListId, resolveDef, type ListCtx, type ListSeed } from "./lists";

export type RunFormat = Omit<TextRun, "text">;
export type RunPatch = { [K in keyof RunFormat]?: RunFormat[K] | null };
export type ParaPatch = Partial<Pick<TextParagraph, "align" | "lineSpacing" | "indent" | "spaceAfter" | "indentLeft" | "spaceBefore" | "indentRight" | "keepNext" | "keepLines" | "pageBreakBefore">> & {
  /** null clears an exact / at-least line height (back to lineSpacing) */
  lineHeight?: ParaLineHeight | null;
  /**
   * Word multiple (core/lineSpacing.ts): each paragraph gets it with the lineSpacing of the same height and no exact
   * height; null = a percent-of-size paragraph. A patch with lineSpacing or lineHeight but no lineMultiple also ends
   * the Word multiple.
   */
  lineMultiple?: number | null;
};

export interface Pos {
  p: number;
  o: number;
}
export interface Range {
  start: Pos;
  end: Pos;
}

export const RUN_KEYS: (keyof RunFormat)[] = ["fontFamily", "latinFont", "fontSize", "bold", "italic", "underline", "color", "strike", "script", "highlight", "letterSpacing", "hscale", "spacingPct", "field", "fieldCode", "link"];
/** optional fields: removed from the run when they hold their default, so old files and hashes stay unchanged */
const OPTIONAL_DEFAULT: Partial<Record<keyof RunFormat, unknown>> = { latinFont: undefined, strike: false, script: undefined, highlight: undefined, letterSpacing: 0, hscale: 100, spacingPct: 0, field: undefined, fieldCode: undefined, link: undefined };

/** A format without its field (text typed next to a page number is ordinary text, core/headerFooter.ts). */
export function plainFormat<T extends Partial<TextRun>>(f: T): T {
  // (new text is not part of the file's tracked changes or comment ranges either: core/review.ts)
  // (nor an inline picture's: letters typed right after a picture are letters, not more copies of it — QA 11-24 basic-ux)
  // (nor a 덧말's: text typed after it is plain text; nor a bookmark's range: core/docRefs.ts)
  if (!("field" in f) && !("fieldCode" in f) && !("rev" in f) && !("fmtRev" in f) && !("comments" in f) && !("obj" in f) && !("ruby" in f) && !("bookmarks" in f)) return f;
  const { field: _f, fieldCode: _c, rev: _r, fmtRev: _m, comments: _k, obj: _o, ruby: _y, bookmarks: _b, ...rest } = f as T & { obj?: unknown };
  return rest as T;
}

// ───────── positions ─────────

export const paraText = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
export const cmpPos = (a: Pos, b: Pos) => a.p - b.p || a.o - b.o;
export const range = (a: Pos, b: Pos): Range => (cmpPos(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a });
export const collapsed = (r: Range) => cmpPos(r.start, r.end) === 0;
/** Whether a right-click at `pos` keeps the selection `r` (Word: a press inside the selected text; else the caret moves there). */
export const keepsSelection = (r: Range, pos: Pos) => !collapsed(r) && cmpPos(pos, r.start) >= 0 && cmpPos(pos, r.end) <= 0;
export const docStart = (): Pos => ({ p: 0, o: 0 });
export const docEnd = (paras: TextParagraph[]): Pos => ({ p: Math.max(0, paras.length - 1), o: paras.length ? paraText(paras[paras.length - 1]).length : 0 });
export const fullRange = (paras: TextParagraph[]): Range => ({ start: docStart(), end: docEnd(paras) });

/** Grapheme boundaries (UTF-16 offsets, including 0 and length). */
export function boundaries(text: string): number[] {
  const out = [0];
  let acc = 0;
  for (const g of graphemes(text)) out.push((acc += g.length));
  return out;
}

/** Snap an offset to a grapheme boundary: dir -1 = previous boundary, +1 = next. */
export function snapOffset(text: string, o: number, dir: -1 | 1 = -1): number {
  o = Math.max(0, Math.min(text.length, o));
  const b = boundaries(text);
  if (b.includes(o)) return o;
  if (dir < 0) return [...b].reverse().find((x) => x < o) ?? 0;
  return b.find((x) => x > o) ?? text.length;
}

export function clampPos(paras: TextParagraph[], pos: Pos, dir: -1 | 1 = -1): Pos {
  if (!paras.length) return { p: 0, o: 0 };
  const p = Math.max(0, Math.min(paras.length - 1, pos.p));
  return { p, o: snapOffset(paraText(paras[p]), pos.o, dir) };
}

/** Normalise a range against the paragraphs: clamped and grapheme-snapped outward. */
export function clampRange(paras: TextParagraph[], r: Range): Range {
  const x = range(r.start, r.end);
  return { start: clampPos(paras, x.start, -1), end: clampPos(paras, x.end, collapsed(x) ? -1 : 1) };
}

// ───────── runs ─────────

export function runFormat(r: TextRun): RunFormat {
  const { text: _t, ...f } = r;
  return f;
}

/** Drop optional fields that hold their default value. */
export function normRun<T extends Partial<TextRun>>(r: T): T {
  let out: T | null = null;
  for (const k of Object.keys(OPTIONAL_DEFAULT) as (keyof RunFormat)[]) {
    if (!(k in r)) continue;
    const v = (r as any)[k];
    if (v === undefined || v === null || v === OPTIONAL_DEFAULT[k] || v === "" || (k === "highlight" && v === "none")) {
      out ??= { ...r };
      delete (out as any)[k];
    }
  }
  return out ?? r;
}

const val = (r: Partial<TextRun>, k: keyof RunFormat) => {
  const v = (r as any)[k];
  return v === undefined || v === null || v === "" ? OPTIONAL_DEFAULT[k] : v;
};

export function sameFormat(a: Partial<TextRun>, b: Partial<TextRun>): boolean {
  // an inline object (core/flow.ts) is a run of its own
  if (a.obj || b.obj) return false;
  // (as is a 덧말: its text is one unit under it)
  if (JSON.stringify(a.ruby ?? null) !== JSON.stringify(b.ruby ?? null)) return false;
  // (a tracked change or a comment range is never merged into text without it: core/review.ts)
  // (nor a bookmark's text into text outside it: core/docRefs.ts)
  return RUN_KEYS.every((k) => val(a, k) === val(b, k)) && sameMarks(a, b) && (a.bookmarks ?? []).join("\u0001") === (b.bookmarks ?? []).join("\u0001");
}

export function applyPatch(r: TextRun, patch: RunPatch): TextRun {
  const out: any = { ...r };
  // a new font is the font of all the run's text (a Word Latin font beside it goes)
  if (patch.fontFamily != null && !("latinFont" in patch)) delete out.latinFont;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) delete out[k];
    else out[k] = v;
  }
  return normRun(out as TextRun);
}

/** Merge neighbouring runs with identical formatting; drop empty runs (one empty run is kept for an empty paragraph). */
export function mergeRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = [];
  for (const r0 of runs) {
    const r = normRun(r0);
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && sameFormat(last, r)) out[out.length - 1] = { ...last, text: last.text + r.text };
    else out.push(r);
  }
  if (!out.length) out.push({ ...normRun(runs[0] ?? DEFAULT_RUN), text: "" });
  return out;
}

/** Split runs so that a run boundary falls exactly at offset o. Returns the new runs and the index of the first run at/after o. */
export function splitRunsAt(runs: TextRun[], o: number): [TextRun[], number] {
  const out: TextRun[] = [];
  let acc = 0;
  let idx = -1;
  for (const r of runs) {
    const end = acc + r.text.length;
    if (idx < 0 && o === acc) idx = out.length;
    if (idx < 0 && o > acc && o < end) {
      out.push({ ...r, text: r.text.slice(0, o - acc) });
      idx = out.length;
      out.push({ ...r, text: r.text.slice(o - acc) });
    } else out.push(r);
    acc = end;
  }
  if (idx < 0) idx = out.length;
  return [out, idx];
}

/** Runs covering [a, b) of one paragraph (empty runs excluded). */
export function sliceRuns(runs: TextRun[], a: number, b: number): TextRun[] {
  const out: TextRun[] = [];
  let acc = 0;
  for (const r of runs) {
    const s = Math.max(a, acc), e = Math.min(b, acc + r.text.length);
    if (e > s) out.push({ ...r, text: r.text.slice(s - acc, e - acc) });
    acc += r.text.length;
  }
  return out;
}

function mapParas(paras: TextParagraph[], from: number, to: number, fn: (p: TextParagraph, i: number) => TextParagraph): TextParagraph[] {
  return paras.map((p, i) => (i >= from && i <= to ? fn(p, i) : p));
}

/** Per-paragraph [a, b) offsets a range covers. */
function spans(paras: TextParagraph[], r: Range): { i: number; a: number; b: number; len: number }[] {
  const out = [];
  for (let i = r.start.p; i <= r.end.p && i < paras.length; i++) {
    const len = paraText(paras[i]).length;
    out.push({ i, a: i === r.start.p ? r.start.o : 0, b: i === r.end.p ? r.end.o : len, len });
  }
  return out;
}

// ───────── character formatting ─────────

/** Apply a format patch to the characters inside the range. A collapsed range changes nothing. */
/** The look of a run (its character format: what a format change records as the format before it). */
export function runLook(r: Partial<TextRun>): NonNullable<Revision["was"]> {
  const out: Record<string, unknown> = {};
  for (const k of RUN_KEYS) if (k !== "field" && k !== "fieldCode" && (r as any)[k] !== undefined) out[k] = (r as any)[k];
  return out as NonNullable<Revision["was"]>;
}

/** The run in the format before its format change made here (Revision.was); null without one. */
export function formerRun<T extends TextRun>(r: T): T | null {
  const was = r.fmtRev?.was;
  if (!was) return null;
  const out: any = { ...r };
  for (const k of RUN_KEYS) if (k !== "field" && k !== "fieldCode") delete out[k];
  return normRun({ ...out, ...was }) as T;
}

/**
 * A run format patch as one edit: while changes are recorded (core/review.ts) every run whose format it changes gets the
 * reviewer's format change with the format before it (Word w:rPrChange) — one change for the whole edit; a run that has
 * a format change already keeps it (its format before the first change), and the reviewer's own new text and deleted
 * text get none (Word records neither).
 */
function patcher(patch: RunPatch): (x: TextRun) => TextRun {
  let rev: Revision | undefined;
  return (x) => {
    // deleted text keeps its format while changes are recorded: no change of its own is recorded for it, so a format
    // put on it would come back with the text when the deletion is rejected (QA doc-review3)
    if (trackingOn() && isRemoved(x)) return x;
    const y = applyPatch(x, patch);
    if (!trackingOn() || !x.text || x.fmtRev || x.obj || x.note || isOwnInsertion(x.rev)) return y;
    const was = runLook(x);
    if (JSON.stringify(runLook(y)) === JSON.stringify(was)) return y;
    rev ??= newRevision("fmt");
    return { ...y, fmtRev: { ...rev, was } };
  };
}

export function applyRunFormat(paras: TextParagraph[], r0: Range, patch: RunPatch): TextParagraph[] {
  const r = clampRange(paras, r0);
  if (collapsed(r)) return paras;
  const multi = r.start.p !== r.end.p;
  const patchRun = patcher(patch);
  let out = paras;
  for (const { i, a, b, len } of spans(paras, r)) {
    const p = out[i];
    if (len === 0) {
      // an empty paragraph inside a multi-paragraph selection takes the format for future typing
      if (multi) out = mapParas(out, i, i, () => ({ ...p, runs: [applyPatch(p.runs[0] ?? { ...DEFAULT_RUN }, patch)] }));
      continue;
    }
    if (b <= a) continue;
    let [runs, ia] = splitRunsAt(p.runs, a);
    let ib: number;
    [runs, ib] = splitRunsAt(runs, b);
    runs = runs.map((x, k) => (k >= ia && k < ib ? patchRun(x) : x));
    out = mapParas(out, i, i, () => ({ ...p, runs: mergeRuns(runs) }));
  }
  return out;
}

/** Format of the character before pos (or the first character of the paragraph at its start). */
export function formatAt(paras: TextParagraph[], pos: Pos): RunFormat {
  const p = paras[Math.max(0, Math.min(paras.length - 1, pos.p))];
  if (!p || !p.runs.length) return runFormat(DEFAULT_RUN);
  let acc = 0;
  // (the caret right after a list marker: the format of the item's text, not the marker's own — a bullet in its own
  // font (Arial, Symbol) made the letters typed at the start of an item take that font and join the marker run; a PPT
  // save then refused it as a format change. QA 2026-11-21)
  const m = p.list ? markerLength(p) : 0;
  if (m && pos.o === m)
    for (const r of p.runs) {
      if (acc >= m && r.text) return plainFormat(runFormat(r));
      acc += r.text.length;
    }
  acc = 0;
  for (const r of p.runs) {
    const end = acc + r.text.length;
    if (r.text && pos.o > acc && pos.o <= end) return plainFormat(runFormat(r));
    acc = end;
  }
  return plainFormat(runFormat(p.runs.find((r) => r.text) ?? p.runs[0]));
}

/** Runs (formatted slices) a range covers; for a collapsed range, the format at the caret. */
export function rangeRuns(paras: TextParagraph[], r0: Range): TextRun[] {
  const r = clampRange(paras, r0);
  if (collapsed(r)) return [{ ...formatAt(paras, r.start), text: "" } as TextRun];
  const out: TextRun[] = [];
  for (const { i, a, b, len } of spans(paras, r)) {
    if (len === 0) continue;
    out.push(...sliceRuns(paras[i].runs, a, b));
  }
  return out.length ? out : [{ ...formatAt(paras, r.start), text: "" } as TextRun];
}

// ───────── 덧말 / 윗주 (TextRun.ruby) ─────────

/**
 * The text a 덧말 command acts on: the selection within one paragraph, else (at a caret) the 덧말 run the caret is in or
 * right after; null when there is none.
 */
export function rubyRange(paras: TextParagraph[], r0: Range): Range | null {
  const r = clampRange(paras, r0);
  if (r.start.p !== r.end.p) return null;
  if (!collapsed(r)) return r;
  const p = paras[r.start.p];
  let acc = 0;
  for (const run of p?.runs ?? []) {
    const end = acc + run.text.length;
    if (run.ruby && r.start.o > acc && r.start.o <= end) return { start: { p: r.start.p, o: acc }, end: { p: r.start.p, o: end } };
    acc = end;
  }
  return null;
}

/** The 덧말 of the text a 덧말 command acts on (rubyRange), when all of it has the same one. */
export function rubyAt(paras: TextParagraph[], r0: Range): Ruby | undefined {
  const r = rubyRange(paras, r0);
  if (!r) return undefined;
  const runs = sliceRuns(paras[r.start.p].runs, r.start.o, r.end.o).filter((x) => x.text);
  const k = JSON.stringify(runs[0]?.ruby ?? null);
  return runs.length && runs[0].ruby && runs.every((x) => JSON.stringify(x.ruby ?? null) === k) ? runs[0].ruby : undefined;
}

/**
 * Put a 덧말 on the text a 덧말 command acts on (rubyRange) — it becomes one run in the format of its first character —
 * or (null) take it off.
 */
export function setRuby(paras: TextParagraph[], r0: Range, ruby: Ruby | null): TextParagraph[] {
  const r = rubyRange(paras, r0);
  if (!r || collapsed(r)) return paras;
  const p = paras[r.start.p];
  const len = paraText(p).length;
  const mid = sliceRuns(p.runs, r.start.o, r.end.o).filter((x) => x.text);
  if (!mid.length) return paras;
  const { ruby: _old, ...first } = mid[0];
  const put: TextRun[] = ruby ? [{ ...first, text: mid.map((x) => x.text).join(""), ruby }] : mid.map(({ ruby: _r, ...x }) => x as TextRun);
  const runs = mergeRuns([...sliceRuns(p.runs, 0, r.start.o), ...put, ...sliceRuns(p.runs, r.end.o, len)]);
  return paras.map((q, i) => (i === r.start.p ? { ...q, runs } : q));
}

/** Common format over a range: a key is present only when every character agrees. */
export function rangeFormat(paras: TextParagraph[], r: Range): Partial<RunFormat> {
  const runs = rangeRuns(paras, r);
  const out: any = {};
  for (const k of RUN_KEYS) {
    const v = val(runs[0], k);
    if (runs.every((x) => val(x, k) === v)) out[k] = v;
  }
  return out;
}

/** Apply a patch to every run of every paragraph (whole text box, also empty ones). */
export function formatAll(paras: TextParagraph[], patch: RunPatch): TextParagraph[] {
  const patchRun = patcher(patch);
  return paras.map((p) => ({ ...p, runs: mergeRuns(p.runs.map(patchRun)) }));
}

/** Whole-box toggle: on unless every character (or every run of an empty box) already has it. */
export function toggleAll(paras: TextParagraph[], key: ToggleKey): TextParagraph[] {
  const runs = paras.flatMap((p) => p.runs);
  const withText = runs.filter((r) => r.text);
  const all = (withText.length ? withText : runs).every((r) => !!r[key]);
  return formatAll(paras, { [key]: !all });
}

export function scriptAll(paras: TextParagraph[], script: "super" | "sub"): TextParagraph[] {
  const runs = paras.flatMap((p) => p.runs).filter((r) => r.text);
  const all = runs.length > 0 && runs.every((r) => r.script === script);
  return formatAll(paras, { script: all ? null : script });
}

export type ToggleKey = "bold" | "italic" | "underline" | "strike";

/** Word-style toggle: on unless every character in the range already has it. */
export function toggleRunFormat(paras: TextParagraph[], r: Range, key: ToggleKey): TextParagraph[] {
  const all = rangeRuns(paras, r).every((x) => !!x[key]);
  return applyRunFormat(paras, r, { [key]: !all });
}

export function toggleScript(paras: TextParagraph[], r: Range, script: "super" | "sub"): TextParagraph[] {
  const all = rangeRuns(paras, r).every((x) => x.script === script);
  return applyRunFormat(paras, r, { script: all ? null : script });
}

// ───────── text editing ─────────

/**
 * The text an IME composition put in at `at`, read from the editor's text after it (`after`: the paragraphs as the DOM
 * shows them): the same paragraphs as `base` with only that text added there. Null when the text changed otherwise (the
 * IME also replaced text before the caret, a paragraph was added): the caller then keeps what the DOM shows.
 */
export function composedText(base: readonly TextParagraph[], at: Pos, after: readonly TextParagraph[]): string | null {
  if (after.length !== base.length || !base[at.p]) return null;
  for (let i = 0; i < base.length; i++) if (i !== at.p && paraText(after[i]) !== paraText(base[i])) return null;
  const was = paraText(base[at.p]), now = paraText(after[at.p]);
  const head = was.slice(0, at.o), tail = was.slice(at.o);
  if (now.length < was.length || !now.startsWith(head) || !now.endsWith(tail)) return null;
  return now.slice(head.length, now.length - tail.length);
}

/**
 * The editor's paragraphs after an IME composition at `at` of `base`: the composed text inserted as typing is (in the
 * caret format `fmt`; a tracked insertion while changes are recorded — never taking on the change or comment marks of the
 * run the browser composed it into, such as deleted text next to the caret). Null when the composition cannot be read as
 * text added at `at` (composedText).
 */
export function insertComposed(base: TextParagraph[], at: Pos, after: readonly TextParagraph[], fmt?: RunFormat): { paras: TextParagraph[]; pos: Pos } | null {
  const text = composedText(base, at, after);
  if (text === null) return null;
  return text ? insertText(base, at, text, fmt) : { paras: base, pos: at };
}

/** Insert text (\n starts a new paragraph). Returns the new paragraphs and the caret after the insert. */
export function insertText(paras: TextParagraph[], pos0: Pos, text: string, fmt?: RunFormat): { paras: TextParagraph[]; pos: Pos } {
  if (!paras.length) paras = [{ id: uid("p"), runs: [{ ...DEFAULT_RUN }], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 6 }];
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let pos = clampPos(paras, pos0);
  const f0 = plainFormat(fmt ?? formatAt(paras, pos));
  // recording changes: the text is an insertion of the reviewer (joining their insertion right there)
  let rev: Revision | undefined;
  lines.forEach((line, li) => {
    if (li > 0) ({ paras, pos } = splitParagraph(paras, pos, { keepMarker: true }));
    if (!line) return;
    const p = paras[pos.p];
    if (trackingOn()) rev ??= ownRevNear(p, pos.o, "ins") ?? newRevision("ins");
    const f = rev ? { ...f0, rev } : f0;
    const [runs, idx] = splitRunsAt(p.runs, pos.o);
    runs.splice(idx, 0, normRun({ ...f, text: line }));
    paras = mapParas(paras, pos.p, pos.p, () => ({ ...p, runs: mergeRuns(runs) }));
    pos = { p: pos.p, o: pos.o + line.length };
  });
  return { paras, pos };
}

/** Insert one run as it is (a field: 쪽 번호, 전체 쪽 수 …) at the caret. Returns the paragraphs and the caret after it. */
export function insertRun(paras: TextParagraph[], pos0: Pos, run: TextRun): { paras: TextParagraph[]; pos: Pos } {
  if (!run.text) return { paras, pos: pos0 };
  const pos = clampPos(paras, pos0);
  const p = paras[pos.p];
  if (!p) return { paras, pos };
  const [runs, idx] = splitRunsAt(p.runs, pos.o);
  if (trackingOn() && !run.rev) run = { ...run, rev: ownRevNear(p, pos.o, "ins") ?? newRevision("ins") };
  runs.splice(idx, 0, normRun({ ...run }));
  return { paras: mapParas(paras, pos.p, pos.p, () => ({ ...p, runs: mergeRuns(runs) })), pos: { p: pos.p, o: pos.o + run.text.length } };
}

/** Insert lines of formatted segments (paste); each segment patches the caret format. */
export function insertSegments(paras: TextParagraph[], pos0: Pos, lines: Segment[][], base?: RunFormat): { paras: TextParagraph[]; pos: Pos } {
  let pos = clampPos(paras, pos0);
  const f = base ?? formatAt(paras, pos);
  lines.forEach((segs, li) => {
    if (li > 0) ({ paras, pos } = splitParagraph(paras, pos, { keepMarker: true }));
    for (const s of segs) {
      if (!s.text) continue;
      ({ paras, pos } = insertText(paras, pos, s.text.replace(/\n/g, " "), { ...f, bold: f.bold || !!s.bold, italic: f.italic || !!s.italic, underline: f.underline || !!s.underline }));
    }
  });
  return { paras, pos };
}

/**
 * Paste clipboard data over the selection (the text box editor and the document body editor): HTML as formatted
 * segments (Word / web pages), else plain text, in the caret format `base`. null when there is nothing to paste.
 */
export function pasteData(paras: TextParagraph[], sel: Range, base: RunFormat, html: string, text: string): { paras: TextParagraph[]; pos: Pos } | null {
  if (!html && !text) return null;
  let at = sel.start;
  if (!collapsed(sel)) ({ paras, pos: at } = deleteRange(paras, sel));
  if (!html) return insertText(paras, at, text, base);
  const d = new DOMParser().parseFromString(html, "text/html");
  return insertSegments(paras, at, htmlToSegments(d.body ?? d.documentElement), base);
}

/** Delete the characters in the range, joining paragraphs. The first paragraph keeps its properties. */
export function deleteRange(paras: TextParagraph[], r0: Range): { paras: TextParagraph[]; pos: Pos } {
  const out = deleteRangeOnly(paras, r0);
  // an 이어서 구역 whose first paragraph was joined into the one before: it begins at the paragraph after the join (the
  // section break stays where the file has it — QA docx-flow, the mark paragraph joined with the next)
  const r = clampRange(paras, r0);
  if (r.end.p > r.start.p && out.paras.length < paras.length) {
    const gone = paras.slice(r.start.p + 1, r.end.p + 1).find((q) => q.contSect)?.contSect;
    const next = out.paras[r.start.p + 1];
    if (gone && !out.paras[r.start.p].contSect && next && !next.contSect) out.paras[r.start.p + 1] = { ...next, contSect: gone };
  }
  return out;
}

function deleteRangeOnly(paras: TextParagraph[], r0: Range): { paras: TextParagraph[]; pos: Pos } {
  const r = clampRange(paras, r0);
  if (collapsed(r)) return { paras, pos: r.start };
  // recording changes: the text stays, struck through (the caret after it, where typing replaces it — Word)
  if (trackingOn()) {
    const t = trackedDelete(paras, r);
    return { paras: t.paras, pos: t.end };
  }
  const first = paras[r.start.p], last = paras[r.end.p];
  const keepFmt = formatAt(paras, { p: r.start.p, o: r.start.o + 1 > paraText(first).length ? r.start.o : r.start.o + 1 });
  const lenLast = paraText(last).length;
  const runs = [...sliceRuns(first.runs, 0, r.start.o), ...sliceRuns(last.runs, r.end.o, lenLast)];
  const merged = mergeRuns(runs.length ? runs : [{ ...keepFmt, text: "" } as TextRun]);
  // (the joined paragraph ends in the last one's mark: its tracked mark change goes with it)
  const joined: TextParagraph = { ...first, runs: merged };
  if (r.end.p !== r.start.p) {
    if (last.markRev) joined.markRev = last.markRev;
    else delete joined.markRev;
    if (last.markFmtRev) joined.markFmtRev = last.markFmtRev;
    else delete joined.markFmtRev;
  }
  const out = [...paras.slice(0, r.start.p), joined, ...paras.slice(r.end.p + 1)];
  if (r.start.p === r.end.p || !paras.slice(r.start.p, r.end.p + 2).some((p) => p.role === "oli")) return { paras: out, pos: r.start };
  // whole list items were removed: renumber the items after the join (the joined paragraph itself
  // is left as typed, so deleting its own marker text is not undone)
  const rn = renumber(out).paras;
  return { paras: rn.map((p, i) => (i === r.start.p ? out[i] : p)), pos: r.start };
}

/** Backspace (dir -1) or Delete (dir +1) of one grapheme at a collapsed caret; joins paragraphs at the edges. */
export function deleteChar(paras: TextParagraph[], pos0: Pos, dir: -1 | 1): { paras: TextParagraph[]; pos: Pos } {
  let pos = clampPos(paras, pos0);
  // the final view's hidden (deleted) text next to the caret is stepped over: the key acts on the visible character
  if (paras[pos.p]) pos = { p: pos.p, o: skipHidden(paras[pos.p], pos.o, dir) };
  const text = paraText(paras[pos.p]);
  if (trackingOn()) {
    // recording changes: the character is struck through and the caret steps over it (Backspace: before it, Delete:
    // after it); the reviewer's own new text goes for good
    let r: Range | null = null;
    if (dir < 0) r = pos.o > 0 ? { start: { p: pos.p, o: snapOffset(text, pos.o - 1, -1) }, end: pos } : pos.p > 0 ? { start: { p: pos.p - 1, o: paraText(paras[pos.p - 1]).length }, end: pos } : null;
    else r = pos.o < text.length ? { start: pos, end: { p: pos.p, o: snapOffset(text, pos.o + 1, 1) } } : pos.p < paras.length - 1 ? { start: pos, end: { p: pos.p + 1, o: 0 } } : null;
    if (!r) return { paras, pos };
    const t = trackedDelete(paras, r);
    return { paras: t.paras, pos: dir < 0 ? t.start : t.end };
  }
  if (dir < 0) {
    if (pos.o > 0) return deleteRange(paras, { start: { p: pos.p, o: snapOffset(text, pos.o - 1, -1) }, end: pos });
    if (pos.p === 0) return { paras, pos };
    const prev = { p: pos.p - 1, o: paraText(paras[pos.p - 1]).length };
    return deleteRange(paras, { start: prev, end: pos });
  }
  if (pos.o < text.length) return deleteRange(paras, { start: pos, end: { p: pos.p, o: snapOffset(text, pos.o + 1, 1) } });
  if (pos.p >= paras.length - 1) return { paras, pos };
  return deleteRange(paras, { start: pos, end: { p: pos.p + 1, o: 0 } });
}

/** The reviewer's own change of `kind` at offset `o` of the paragraph (in the run holding, ending or starting there). */
function ownRevNear(p: TextParagraph | undefined, o: number, kind: "ins" | "del"): Revision | undefined {
  if (!p) return undefined;
  let acc = 0;
  for (const r of p.runs) {
    const end = acc + r.text.length;
    // (only a change made in this session: a file's change of the same author name is someone else's — QA doc-review2)
    if (r.text && o >= acc && o <= end && isOwnRevision(r.rev, kind)) return r.rev;
    acc = end;
  }
  return undefined;
}

/**
 * Delete a range while changes are recorded (core/review.ts): its text is marked deleted (struck through, still there)
 * and so are the paragraph marks inside it — the reviewer's own insertions go for good (their text, their paragraph
 * marks: those paragraphs join). Text already deleted stays as it was. Returns the paragraphs and where the range's
 * start and end are now (Backspace leaves the caret at the start, Delete and typing over a selection at the end).
 */
export function trackedDelete(paras: TextParagraph[], r0: Range): { paras: TextParagraph[]; start: Pos; end: Pos } {
  const r = clampRange(paras, r0);
  if (collapsed(r)) return { paras, start: r.start, end: r.start };
  // next to the reviewer's own deletion (Backspace after Backspace): one deletion
  const del = ownRevNear(paras[r.end.p], r.end.o, "del") ?? ownRevNear(paras[r.start.p], r.start.o, "del") ?? newRevision("del");
  const work: { p: TextParagraph; join: boolean; endAt?: number }[] = [];
  for (let i = r.start.p; i <= r.end.p; i++) {
    const p = paras[i];
    const a = i === r.start.p ? r.start.o : 0;
    const b = i === r.end.p ? r.end.o : paraText(p).length;
    let [runs, ia] = splitRunsAt(p.runs, a);
    let ib: number;
    [runs, ib] = splitRunsAt(runs, b);
    const next: TextRun[] = [];
    let kept = 0; // characters left before b
    runs.forEach((x, k) => {
      let y: TextRun | null = x;
      if (k >= ia && k < ib && x.text && !isRemoved(x)) y = isOwnInsertion(x.rev) ? null : { ...x, rev: del };
      if (!y) return;
      next.push(y);
      if (k < ib) kept += y.text.length;
    });
    if (!next.length) next.push({ ...plainFormat(runFormat(p.runs[0] ?? DEFAULT_RUN)), text: "" } as TextRun);
    let q: TextParagraph = { ...p, runs: next };
    let join = false;
    if (i < r.end.p) {
      if (isOwnInsertion(p.markRev)) join = true;
      else if (!p.markRev || !isRemoved({ rev: p.markRev })) q = { ...q, markRev: del };
    }
    work.push({ p: q, join, endAt: i === r.end.p ? kept : undefined });
  }
  const out: TextParagraph[] = [];
  let end: Pos = r.start;
  let joining = false;
  for (const w of work) {
    let base = 0;
    if (joining) {
      const prev = out[out.length - 1];
      base = paraText(prev).length;
      const merged: TextParagraph = { ...prev, runs: [...prev.runs.filter((x) => x.text), ...w.p.runs] };
      if (w.p.markRev) merged.markRev = w.p.markRev;
      else delete merged.markRev;
      if (w.p.markFmtRev) merged.markFmtRev = w.p.markFmtRev;
      else delete merged.markFmtRev;
      out[out.length - 1] = merged;
    } else out.push(w.p);
    if (w.endAt !== undefined) end = { p: r.start.p + out.length - 1, o: base + w.endAt };
    joining = w.join;
  }
  const fixed = out.map((q) => ({ ...q, runs: mergeRuns(q.runs) }));
  return { paras: [...paras.slice(0, r.start.p), ...fixed, ...paras.slice(r.end.p + 1)], start: r.start, end };
}

// ───────── lists & headings ─────────

const MARKER: Record<"li" | "oli", RegExp> = { li: /^•\s?/, oli: /^\d+[.)]\s?/ };
export const isList = (role?: ParaRole): role is "li" | "oli" => role === "li" || role === "oli";
export const isHeading = (role?: ParaRole) => !!role && /^h[1-6]$/.test(role);
const headingLevel = (role?: ParaRole) => (role && /^h([1-6])$/.exec(role) ? Number(role[1]) : 0);

/**
 * Length of the list marker ("• ", "3. ", "1.1. ", "가. ") at the start of a list paragraph, 0 otherwise. A
 * multi-level list paragraph knows its marker (list.mk); an older one-level list item is recognised by its role.
 */
export function markerLength(p: TextParagraph): number {
  if (p.list) return p.list.mk && paraText(p).startsWith(p.list.mk) ? p.list.mk.length : 0;
  if (!isList(p.role)) return 0;
  return MARKER[p.role].exec(paraText(p))?.[0].length ?? 0;
}

function replacePrefix(p: TextParagraph, cut: number, insert: string): TextParagraph {
  const len = paraText(p).length;
  // (the number is not part of the first word's tracked insertion or memo: a file reopened with an insertion at a
  // numbered heading's start showed the number as inserted text — QA hwpx-numbering 2026-11-16)
  const fmt = plainFormat(runFormat(p.runs.find((r) => r.text) ?? p.runs[0] ?? DEFAULT_RUN));
  const rest = sliceRuns(p.runs, cut, len);
  return { ...p, runs: mergeRuns([...(insert ? [{ ...fmt, text: insert } as TextRun] : []), ...rest, ...(rest.length || insert ? [] : [{ ...fmt, text: "" } as TextRun])]) };
}

/** A paragraph without list membership and marker. */
function dropList(p: TextParagraph): TextParagraph {
  const { role: _r, list: _l, ...rest } = replacePrefix(p, markerLength(p), "");
  const keep = p.role && !isList(p.role) ? { role: p.role } : {};
  return { ...rest, ...keep } as TextParagraph;
}

/** Split the paragraph at pos. The new paragraph keeps the paragraph properties; list items continue the list. */
export function splitParagraph(paras: TextParagraph[], pos0: Pos, opts: { body?: RunFormat; keepMarker?: boolean; lc?: ListCtx } = {}): { paras: TextParagraph[]; pos: Pos } {
  const pos = clampPos(paras, pos0);
  const p = paras[pos.p];
  const len = paraText(p).length;
  const mlen = markerLength(p);
  const inList = isList(p.role) || !!p.list;
  // Enter on an empty list item ends the list (Word / 한글 behaviour); an outline heading is not an item to end
  if (inList && !isHeading(p.role) && !opts.keepMarker && mlen > 0 && len === mlen && pos.o === len) {
    const out = mapParas(paras, pos.p, pos.p, (q) => dropList(q));
    return { paras: renumber(out, opts.lc).paras, pos: { p: pos.p, o: 0 } };
  }
  const fmt = formatAt(paras, pos);
  const left = sliceRuns(p.runs, 0, pos.o);
  const right = sliceRuns(p.runs, pos.o, len);
  let nextP: TextParagraph = { ...p, id: uid("p"), runs: mergeRuns(right.length ? right : [{ ...fmt, text: "" } as TextRun]) };
  let caret = 0;
  const styled = !!p.styleNext && pos.o === len && (!inList || isHeading(p.role));
  if (styled) {
    // (DOC, doc-para-write) the style the paragraph's style names for the one after it (Word: a heading → Normal): its
    // format and letters, nothing of this paragraph's own
    const tpl = JSON.parse(JSON.stringify(p.styleNext)) as Omit<TextParagraph, "id">;
    nextP = { ...tpl, id: uid("p"), runs: [{ ...(tpl.runs[0] ?? opts.body ?? runFormat(DEFAULT_RUN)), text: "" } as TextRun] };
    // (QA doc-para-write: the paragraph's own mark and its tracked change go with the new paragraph, as below — the
    // template has none; a heading whose mark was a tracked insertion lost it on Enter at its end)
    delete nextP.markRev;
    delete nextP.markFmtRev;
    if (p.markRev) nextP.markRev = p.markRev;
    if (p.markFmtRev) nextP.markFmtRev = p.markFmtRev;
  } else if (isHeading(p.role) && pos.o === len) {
    // a new paragraph after a heading is body text (and leaves the outline numbering)
    // (and its heading style: the default one, core/docStyles.ts)
    const { role: _r, list: _l, style: _s, ...rest } = nextP;
    nextP = { ...rest, runs: [{ ...(opts.body ?? runFormat(DEFAULT_RUN)), text: "" } as TextRun] } as TextParagraph;
    if (p.list) {
      delete nextP.pageBreakBefore;
      nextP.indent = 0;
      delete nextP.indentLeft;
    }
  } else if (p.list) {
    // the new item continues the list at the same level; renumbering writes its marker
    const { start: _s, mk: _m, ...l } = p.list;
    nextP = { ...nextP, list: l };
    delete nextP.pageBreakBefore;
  } else if (isList(p.role)) {
    const marker = p.role === "li" ? "• " : "1. ";
    nextP = replacePrefix(nextP, 0, marker);
    caret = marker.length;
  }
  if (nextP.pageBreakBefore && !styled) delete nextP.pageBreakBefore;
  const leftP: TextParagraph = { ...p, runs: mergeRuns(left.length ? left : [{ ...fmt, text: "" } as TextRun]) };
  // the paragraph's own mark (and its tracked change) goes with the text after the caret; the first part ends in a
  // new mark — an insertion while changes are recorded (core/review.ts)
  delete leftP.markRev;
  delete leftP.markFmtRev;
  // (QA docx-flow: Word's continuous section break mark, TextParagraph.sectMark, stays with the first part — the one
  // keeping the paragraph's id, whose w:sectPr the in-place DOCX save keeps; the new paragraph is an ordinary line.
  // Enter in the empty mark paragraph made two empty marks of no line: nothing showed, the caret vanished)
  delete nextP.sectMark;
  // 단 나누기: one before the paragraph stays with its first part, one after it goes with the end
  delete nextP.colBreak;
  // (an 이어서 구역 begins with the first part)
  delete nextP.contSect;
  if (p.colBreak === "after") {
    nextP.colBreak = "after";
    delete leftP.colBreak;
  }
  if (trackingOn()) leftP.markRev = ownRevNear(p, pos.o, "ins") ?? newRevision("ins");
  let out = [...paras.slice(0, pos.p), leftP, nextP, ...paras.slice(pos.p + 1)];
  if (inList || nextP.list) {
    const rn = renumber(out, opts.lc);
    out = rn.paras;
    caret += rn.delta[pos.p + 1];
  }
  return { paras: out, pos: { p: pos.p + 1, o: caret } };
}

/**
 * Renumber list paragraphs. Multi-level lists (paragraph `list`): counters per list instance and level, a level
 * resets the deeper ones, `list.start` restarts; numbers count on across other paragraphs (Word / 한글) and, with
 * `lc.seed`, from the text nodes before. Older one-level numbered items (role "oli" without `list`) are numbered
 * 1., 2., 3. … per run of consecutive items as before. Returns the change of text length at offset 0 per paragraph
 * and the counters reached (the seed of the next node).
 */
export function renumber(paras: TextParagraph[], lc: ListCtx = {}): { paras: TextParagraph[]; delta: number[]; seed: ListSeed } {
  const delta = paras.map(() => 0);
  const seed: ListSeed = new Map([...(lc.seed ?? new Map())].map(([k, v]) => [k, [...v]]));
  let n = 0;
  const out = paras.map((p, i) => {
    if (p.list) {
      n = 0;
      const def = resolveDef(p.list.def, lc.defs);
      const level = Math.max(0, Math.min(MAX_LEVELS - 1, p.list.level | 0));
      const lv = levelOf(def, level);
      const cs = seed.get(p.list.id) ?? [];
      cs[level] = p.list.start != null ? p.list.start : cs[level] == null ? lv.start ?? 1 : cs[level]! + 1;
      for (let k = level + 1; k < MAX_LEVELS; k++) cs[k] = undefined;
      seed.set(p.list.id, cs);
      const want = markerText(def, level, cs) + MARKER_SEP;
      const role: ParaRole | undefined = isHeading(p.role) ? p.role : isBulletLevel(lv) ? "li" : "oli";
      const have = markerLength(p);
      if (have === want.length && paraText(p).startsWith(want) && p.list.mk === want && p.role === role && p.list.level === level) return p;
      delta[i] = want.length - have;
      const q = replacePrefix(p, have, want);
      return { ...q, role, list: { ...p.list, level, mk: want } } as TextParagraph;
    }
    if (p.role !== "oli") {
      n = 0;
      return p;
    }
    n++;
    const want = `${n}. `;
    const m = MARKER.oli.exec(paraText(p));
    const have = m?.[0] ?? "";
    if (have === want) return p;
    delta[i] = want.length - have.length;
    return replacePrefix(p, have.length, want);
  });
  return { paras: out, delta, seed };
}

/**
 * Toggle a bulleted ("li") or numbered ("oli") list on paragraphs from..to.
 * Markers are real text ("• ", "1. ") so DOCX/HWPX/Markdown keep them; delta[i] is the
 * change of text length at offset 0 of paragraph i (for moving the caret).
 */
export function toggleList(paras: TextParagraph[], from: number, to: number, kind: "li" | "oli"): { paras: TextParagraph[]; delta: number[] } {
  const all = paras.slice(from, to + 1).every((p) => p.role === kind && !p.list);
  const delta = paras.map(() => 0);
  let out = mapParas(paras, from, to, (p, i) => {
    const m = markerLength(p);
    if (all) {
      const { role: _r, ...rest } = replacePrefix(p, m, "");
      delta[i] = -m;
      return rest as TextParagraph;
    }
    const marker = kind === "li" ? "• " : "1. ";
    delta[i] = marker.length - m;
    const { role: _r, list: _l, ...rest } = p;
    return { ...replacePrefix(rest as TextParagraph, m, marker), role: kind };
  });
  const rn = renumber(out);
  out = rn.paras;
  return { paras: out, delta: delta.map((d, i) => d + rn.delta[i]) };
}

/** Paragraph indents of a list level (the level's left indent and hanging marker room). */
function withLevelIndent(p: TextParagraph, defId: string, level: number, lc: ListCtx): TextParagraph {
  const def = resolveDef(defId, lc.defs);
  if (def.outline) return p; // heading numbering keeps the heading's own indents
  const { left, first } = levelIndent(levelOf(def, level));
  const out: TextParagraph = { ...p, indent: first };
  if (left) out.indentLeft = left;
  else delete out.indentLeft;
  return out;
}

/**
 * Put paragraphs from..to into a list of definition `def` (a preset name or a node list id). Items keep their level
 * (a heading's level in an outline list); they join the list of the paragraph before them when it has the same
 * definition, else a new list starts. When every paragraph already uses `def`, the list is removed instead.
 */
export function applyList(paras: TextParagraph[], from: number, to: number, def: string, lc: ListCtx = {}): { paras: TextParagraph[]; delta: number[] } {
  const delta = paras.map(() => 0);
  const outline = !!resolveDef(def, lc.defs).outline;
  const targets = paras.slice(from, to + 1);
  const all = targets.every((p) => p.list?.def === def);
  let out: TextParagraph[];
  if (all) {
    out = mapParas(paras, from, to, (p, i) => {
      delta[i] = -markerLength(p);
      const q = dropList(p);
      if (outline) return q;
      const { indentLeft: _il, ...r } = q;
      return { ...r, indent: 0 } as TextParagraph;
    });
  } else {
    // continue the list just before (same definition), else a new instance; an outline list is one per text
    const before = [...paras.slice(0, from)].reverse().find((p) => p.list);
    const existing = outline ? paras.find((p) => p.list?.def === def)?.list?.id : undefined;
    const id = existing ?? (before?.list?.def === def ? before.list.id : newListId());
    out = mapParas(paras, from, to, (p, i) => {
      if (outline && !isHeading(p.role)) return p; // outline numbering numbers headings only
      const m = markerLength(p);
      delta[i] = -m;
      const level = outline ? headingLevel(p.role) - 1 : p.list ? p.list.level : 0;
      const base = replacePrefix(p, m, "");
      const q: TextParagraph = { ...base, list: { id, def, level } };
      if (!isHeading(p.role)) q.role = isBulletLevel(levelOf(resolveDef(def, lc.defs), level)) ? "li" : "oli";
      return withLevelIndent(q, def, level, lc);
    });
  }
  const rn = renumber(out, lc);
  return { paras: rn.paras, delta: delta.map((d, i) => d + rn.delta[i]) };
}

/** Number every heading of the text with an outline definition (개요 번호), or remove it when already numbered so. */
export function applyOutline(paras: TextParagraph[], def: string, lc: ListCtx = {}): { paras: TextParagraph[]; delta: number[] } {
  const hs = paras.map((p, i) => (isHeading(p.role) ? i : -1)).filter((i) => i >= 0);
  if (!hs.length) return { paras, delta: paras.map(() => 0) };
  const all = hs.every((i) => paras[i].list?.def === def);
  if (all) return applyList(paras, 0, paras.length - 1, def, lc);
  // headings of another list leave it first
  const cleared = paras.map((p) => (isHeading(p.role) && p.list && p.list.def !== def ? dropList(p) : p));
  const pre = paras.map((p, i) => markerLength(p) - markerLength(cleared[i]));
  const r = applyList(cleared, 0, cleared.length - 1, def, lc);
  return { paras: r.paras, delta: r.delta.map((d, i) => d - pre[i]) };
}

/**
 * Move list items from..to one level deeper (+1, Tab) or shallower (-1, Shift+Tab). An older one-level item becomes
 * a multi-level one first. Returns null when nothing is a list item (Tab then types a tab).
 */
export function changeListLevel(paras: TextParagraph[], from: number, to: number, by: 1 | -1, lc: ListCtx = {}): { paras: TextParagraph[]; delta: number[] } | null {
  if (!paras.slice(from, to + 1).some((p) => (p.list && !LIST_PRESETS[p.list.def]?.outline && !resolveDef(p.list.def, lc.defs).outline) || isList(p.role))) return null;
  const delta = paras.map(() => 0);
  const legacyId = { li: newListId(), oli: newListId() };
  // an older one-level item joins a multi-level list together with the items next to it (its consecutive run), so
  // the numbers after the indented item count on (1. / a. / 2.) instead of starting again
  let lo = from, hi = to;
  const legacy = (q?: TextParagraph) => !!q && !q.list && isList(q.role);
  if (legacy(paras[from])) while (lo > 0 && legacy(paras[lo - 1]) && paras[lo - 1].role === paras[from].role) lo--;
  if (legacy(paras[to])) while (hi < paras.length - 1 && legacy(paras[hi + 1]) && paras[hi + 1].role === paras[to].role) hi++;
  const joined = mapParas(paras, lo, hi, (p, i) => {
    if (i >= from && i <= to) return p;
    if (!legacy(p)) return p;
    const role = p.role as "li" | "oli";
    const m = markerLength(p);
    delta[i] = -m;
    return { ...replacePrefix(p, m, ""), list: { id: legacyId[role], def: role === "li" ? "bullet" : "decimal", level: 0 } };
  });
  const out = mapParas(joined, from, to, (p, i) => {
    let list: ParaList | undefined = p.list;
    if (!list && isList(p.role)) list = { id: legacyId[p.role], def: p.role === "li" ? "bullet" : "decimal", level: 0 };
    if (!list || resolveDef(list.def, lc.defs).outline) return p;
    const level = Math.max(0, Math.min(MAX_LEVELS - 1, list.level + by));
    const m = markerLength(p);
    delta[i] = -m;
    const { start: _s, mk: _m, ...l } = list;
    const q: TextParagraph = { ...replacePrefix(p, m, ""), list: { ...l, level } };
    return withLevelIndent(q, list.def, level, lc);
  });
  const rn = renumber(out, lc);
  return { paras: rn.paras, delta: delta.map((d, i) => d + rn.delta[i]) };
}

/** Give list instance `listId` the definition `def` (levels edited in the list dialog) and renumber. */
export function redefineList(paras: TextParagraph[], listId: string, def: string, lc: ListCtx = {}): { paras: TextParagraph[]; delta: number[] } {
  const out = paras.map((p) => (p.list?.id === listId && p.list.def !== def ? { ...p, list: { ...p.list, def } } : p));
  return renumber(out, lc);
}

/** Restart numbering at `start` on paragraph i (null: continue the list). */
export function setListStart(paras: TextParagraph[], i: number, start: number | null, lc: ListCtx = {}): { paras: TextParagraph[]; delta: number[] } {
  const p = paras[i];
  if (!p?.list) return { paras, delta: paras.map(() => 0) };
  const { start: _s, ...l } = p.list;
  const out = mapParas(paras, i, i, (q) => ({ ...q, list: start != null && start >= 0 ? { ...l, start } : l }));
  return renumber(out, lc);
}

export const HEADING_SCALE: Record<1 | 2 | 3, number> = { 1: 1.75, 2: 1.4, 3: 1.2 };

/** The most common character format among non-heading paragraphs (by character count). */
export function bodyFormat(paras: TextParagraph[]): RunFormat {
  const count = new Map<string, { f: RunFormat; n: number }>();
  for (const p of paras) {
    if (isHeading(p.role)) continue;
    for (const r of p.runs) {
      const f = runFormat(normRun(r));
      const k = JSON.stringify(RUN_KEYS.map((x) => val(f, x)));
      const e = count.get(k) ?? { f, n: 0 };
      e.n += r.text.length || 0.5;
      count.set(k, e);
    }
  }
  let best: { f: RunFormat; n: number } | null = null;
  for (const e of count.values()) if (!best || e.n > best.n) best = e;
  return best?.f ?? runFormat(DEFAULT_RUN);
}

/**
 * Heading 1–3 or body text (0) for paragraphs from..to: sets the role and the run size/weight. When the text has
 * heading outline numbering (an outline list), new headings join it at their level and body text leaves it.
 */
export function setHeading(paras: TextParagraph[], from: number, to: number, level: 0 | 1 | 2 | 3, body: RunFormat = bodyFormat(paras), lc: ListCtx = {}): TextParagraph[] {
  const outline = paras.find((p) => p.list && isHeading(p.role) && resolveDef(p.list.def, lc.defs).outline)?.list;
  let touched = false;
  const out = mapParas(paras, from, to, (p0) => {
    let p = p0;
    if (p.list && resolveDef(p.list.def, lc.defs).outline) {
      p = dropList(p);
      touched = true;
    }
    const { role: _r, ...rest } = p;
    const keepRole = !isHeading(p0.role) && p.role ? { role: p.role } : {};
    if (level === 0) {
      return { ...rest, ...keepRole, runs: mergeRuns(p.runs.map((r) => ({ ...r, fontSize: body.fontSize, bold: body.bold }))) } as TextParagraph;
    }
    const size = Math.round(body.fontSize * HEADING_SCALE[level] * 10) / 10;
    const h = { ...rest, role: `h${level}` as ParaRole, runs: mergeRuns(p.runs.map((r) => ({ ...r, fontSize: size, bold: true }))) } as TextParagraph;
    if (outline && !(isList(p0.role) || (p0.list && !resolveDef(p0.list.def, lc.defs).outline))) {
      touched = true;
      return { ...h, list: { id: outline.id, def: outline.def, level: level - 1 } };
    }
    return h;
  });
  return touched ? renumber(out, lc).paras : out;
}

export function applyParaFormat(paras: TextParagraph[], from: number, to: number, patch: ParaPatch): TextParagraph[] {
  const { lineMultiple: wm, ...rest } = patch;
  return mapParas(paras, from, to, (p) => {
    let out: any = { ...p, ...rest };
    if (typeof wm === "number") out = withWordMultiple(out, wm);
    else if (wm === null || rest.lineSpacing !== undefined || rest.lineHeight) delete out.lineMultiple;
    // 최소 in a Word-basis paragraph (a Word multiple, or already at least the font's line): Word's natural line
    if (rest.lineHeight?.mode === "atLeast" && !rest.lineHeight.basis && (p.lineMultiple || (p.lineHeight?.mode === "atLeast" && p.lineHeight.basis === "font")))
      out.lineHeight = { ...rest.lineHeight, basis: "font" };
    if (out.indentLeft === 0 || out.indentLeft == null) delete out.indentLeft;
    // optional formats are omitted at their default (older files and hashes stay the same)
    for (const k of ["spaceBefore", "indentRight"] as const) if (!out[k]) delete out[k];
    for (const k of ["keepNext", "keepLines", "pageBreakBefore"] as const) if (!out[k]) delete out[k];
    if (out.lineHeight == null) delete out.lineHeight;
    return out;
  });
}

export type ParaFormat = {
  align?: Align;
  lineSpacing?: number;
  indent?: number;
  indentLeft?: number;
  spaceAfter?: number;
  spaceBefore?: number;
  indentRight?: number;
  /** the exact / at-least line height, null when the paragraphs use a multiple */
  lineHeight?: ParaLineHeight | null;
  /** the Word multiple (core/lineSpacing.ts), null when the paragraphs use a percent of the size */
  lineMultiple?: number | null;
  /** Word single line ÷ size of the first paragraph (converts between the two kinds of multiple) */
  lineRatio?: number;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  role?: ParaRole | "";
  /** list definition and level ("" = no list) */
  listDef?: string;
  listLevel?: number;
  /** list instance of the first paragraph, and its restart number */
  listId?: string;
  listStart?: number;
};

/** Paragraph properties common to paragraphs from..to (a key is present only when all agree). */
export function paraFormat(paras: TextParagraph[], from: number, to: number): ParaFormat {
  const ps = paras.slice(from, to + 1);
  if (!ps.length) return {};
  const out: any = {};
  const keys = ["align", "lineSpacing", "indent", "spaceAfter"] as const;
  for (const k of keys) if (ps.every((p) => p[k] === ps[0][k])) out[k] = ps[0][k];
  const num = (k: "indentLeft" | "spaceBefore" | "indentRight") => (p: TextParagraph) => p[k] ?? 0;
  for (const k of ["indentLeft", "spaceBefore", "indentRight"] as const) if (ps.every((p) => num(k)(p) === num(k)(ps[0]))) out[k] = num(k)(ps[0]);
  for (const k of ["keepNext", "keepLines", "pageBreakBefore"] as const) if (ps.every((p) => !!p[k] === !!ps[0][k])) out[k] = !!ps[0][k];
  const lh = (p: TextParagraph) => JSON.stringify(p.lineHeight ?? null);
  if (ps.every((p) => lh(p) === lh(ps[0]))) out.lineHeight = ps[0].lineHeight ?? null;
  const wm = (p: TextParagraph) => wordMultipleOf(p) ?? null;
  if (ps.every((p) => wm(p) === wm(ps[0]))) out.lineMultiple = wm(ps[0]);
  out.lineRatio = paraLineRatio(ps[0]);
  const role = (p: TextParagraph) => p.role ?? "";
  if (ps.every((p) => role(p) === role(ps[0]))) out.role = role(ps[0]);
  const def = (p: TextParagraph) => p.list?.def ?? (p.role === "li" ? "bullet" : p.role === "oli" ? "decimal" : "");
  if (ps.every((p) => def(p) === def(ps[0]))) out.listDef = def(ps[0]);
  const lvl = (p: TextParagraph) => p.list?.level ?? 0;
  if (ps.every((p) => lvl(p) === lvl(ps[0]))) out.listLevel = lvl(ps[0]);
  if (ps[0].list) out.listId = ps[0].list.id;
  if (ps[0].list?.start != null) out.listStart = ps[0].list.start;
  return out;
}

// ───────── paste ─────────

export interface Segment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}

const BLOCK = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "blockquote", "pre", "section", "article", "header", "footer", "ul", "ol", "table"]);
const SKIP_TAGS = new Set(["script", "style", "head", "title", "meta", "link", "noscript", "template"]);

/**
 * Pasted HTML → lines of segments. Only bold, italic and underline are taken over
 * (tags b/strong/i/em/u and inline font-weight / font-style / text-decoration); everything
 * else follows the caret format. Works on any DOM-like tree (browser DOMParser or xmldom).
 */
export function htmlToSegments(root: Node): Segment[][] {
  const lines: Segment[][] = [[]];
  const newLine = () => {
    if (lines[lines.length - 1].length) lines.push([]);
  };
  const walk = (n: Node, f: { bold: boolean; italic: boolean; underline: boolean }) => {
    if (n.nodeType === 3) {
      const t = (n.nodeValue ?? "").replace(/[\r\n\t ]+/g, " ");
      if (t) lines[lines.length - 1].push({ text: t, ...f });
      return;
    }
    if (n.nodeType !== 1 && n.nodeType !== 9 && n.nodeType !== 11) return;
    const tag = (n.nodeType === 1 ? ((n as Element).localName ?? n.nodeName) : "").toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    if (tag === "br") return void lines.push([]);
    const style = n.nodeType === 1 ? ((n as Element).getAttribute?.("style") ?? "").toLowerCase() : "";
    const g = { ...f };
    if (tag === "b" || tag === "strong" || /^h[1-6]$/.test(tag) || /font-weight\s*:\s*(bold|[6-9]00)/.test(style)) g.bold = true;
    if (/font-weight\s*:\s*(normal|[1-4]00)/.test(style)) g.bold = false;
    if (tag === "i" || tag === "em" || /font-style\s*:\s*italic/.test(style)) g.italic = true;
    if (tag === "u" || tag === "ins" || /text-decoration[^;]*underline/.test(style)) g.underline = true;
    const block = BLOCK.has(tag);
    if (block) newLine();
    for (let c = n.firstChild; c; c = c.nextSibling) walk(c, g);
    if (block) newLine();
  };
  walk(root, { bold: false, italic: false, underline: false });
  while (lines.length > 1 && !lines[lines.length - 1].length) lines.pop();
  // trim edge spaces that come from HTML formatting whitespace
  for (const l of lines) {
    if (l.length) l[0] = { ...l[0], text: l[0].text.replace(/^ +/, "") };
    if (l.length) l[l.length - 1] = { ...l[l.length - 1], text: l[l.length - 1].text.replace(/ +$/, "") };
  }
  return lines.map((l) => l.filter((s) => s.text));
}

/** Plain text of a range (copy). Paragraphs are joined with \n. */
export function rangeText(paras: TextParagraph[], r0: Range): string {
  const r = clampRange(paras, r0);
  return spans(paras, r)
    .map(({ i, a, b }) => paraText(paras[i]).slice(a, b))
    .join("\n");
}

// ───────── list numbers across text nodes ─────────

/** Text nodes whose list numbers count on together: document pages in order, each top→bottom, left→right. */
function flowTextNodes(pages: readonly Page[]): TextNode[] {
  const out: TextNode[] = [];
  for (const pg of pages)
    if (pg.kind === "DOCUMENT")
      for (const n of [...pg.nodes].sort((a, b) => (a.flowCol ?? 0) - (b.flowCol ?? 0) || a.transform.y - b.transform.y || a.transform.x - b.transform.x)) if (n.type === "TEXT") out.push(n);
  return out;
}

/** Counters reached before text node `nodeId` (a list that began on an earlier page counts on). */
export function listSeedBefore(pages: readonly Page[], nodeId: string): ListSeed {
  let seed: ListSeed = new Map();
  for (const n of flowTextNodes(pages)) {
    if (n.id === nodeId) break;
    if (n.paragraphs.some((p) => p.list)) seed = listNumbers(n.paragraphs, { defs: n.lists, seed }).seed;
  }
  return seed;
}

/**
 * Renumber the text nodes after `nodeId` (whose numbers may have changed): a node's paragraphs are replaced only
 * when a marker changes. `pages` may be an immer draft.
 */
export function renumberAfter(pages: Page[], nodeId: string): void {
  const nodes = flowTextNodes(pages);
  const at = nodes.findIndex((n) => n.id === nodeId);
  if (at < 0) return;
  let seed = listSeedBefore(pages, nodeId);
  seed = listNumbers(nodes[at].paragraphs, { defs: nodes[at].lists, seed }).seed;
  for (const n of nodes.slice(at + 1)) {
    if (!n.paragraphs.some((p) => p.list)) continue;
    const r = renumber(n.paragraphs, { defs: n.lists, seed });
    if (r.paras.some((p, i) => p !== n.paragraphs[i])) n.paragraphs = r.paras;
    seed = r.seed;
  }
}
