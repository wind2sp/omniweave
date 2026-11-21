// Footnotes and endnotes (각주·미주; docs/design/FIDELITY_DOCX.md, DOC_FLOW.md).
//
// A note lives in its reference run (TextRun.note): the run shows the note's mark, the note's paragraphs travel with
// the run through every edit, cut and join of the body flow, and the Office Surgeon finds the note in the file by its
// `src`. The body flow (core/flow.ts) numbers the notes in document order and lays them out: footnotes at the foot of
// the page their reference lands on (the body gets that much less room; a note too long for the page goes on at the
// foot of the next), endnotes after the end of the document. What it lays out are ordinary nodes marked `notes`
// (a text frame and its separator line), so every renderer, printer and picture export draws them as they are.

import { attr, child } from "../io/xml";
import { formatNumber } from "./lists";
import { uid } from "./types";
import type { NoteKindPr, NoteNumFormat, NotePr, NoteRef, Page, SceneNode, TextParagraph, TextRun, VectorNode } from "./types";

export type NoteKind = NoteRef["kind"];

/** Word's symbol marks: * † ‡ §, then doubled (** †† …). */
const SYMBOLS = ["*", "†", "‡", "§"];

/** The mark of note number `n` (1-based as counted from the start) in the kind's format. */
export function noteMarkText(n: number, kind: NoteKind, pr?: NoteKindPr): string {
  const fmt = pr?.fmt ?? (kind === "end" ? "lowerRoman" : "decimal");
  const k = Math.max(1, Math.round(n));
  const s = fmt === "symbol" ? SYMBOLS[(k - 1) % 4].repeat(Math.floor((k - 1) / 4) + 1) : fmt === "decimal" || fmt === "dash" ? String(k) : formatNumber(k, fmt);
  return (pr?.prefix ?? "") + s + (pr?.suffix ?? "");
}

/** Note settings of a document's pages (the first page's). */
export const notePrOf = (pages: readonly Pick<Page, "notePr">[]): NotePr | undefined => pages[0]?.notePr;

/** Note references of a paragraph with their character offsets. */
export function notesOf(p: TextParagraph): { o: number; note: NoteRef; run: TextRun }[] {
  const out: { o: number; note: NoteRef; run: TextRun }[] = [];
  let o = 0;
  for (const r of p.runs) {
    if (r.note) out.push({ o, note: r.note, run: r });
    o += r.text.length;
  }
  return out;
}

export const hasNotes = (p: TextParagraph) => p.runs.some((r) => r.note);

/** Counters of the notes numbered so far (custom marks are not counted, as in Word and 한글). */
export interface NoteCount {
  foot: number;
  end: number;
}

/** Notes of paragraphs counted (non-custom) by kind. */
export function countNotes(paras: readonly TextParagraph[], into: NoteCount = { foot: 0, end: 0 }): NoteCount {
  for (const p of paras) for (const r of p.runs) if (r.note && !r.note.custom) into[r.note.kind]++;
  return into;
}

/**
 * Paragraphs with every note reference showing its number (continuing `count`, which is advanced): the same array
 * — and the same paragraph objects — where nothing changes.
 */
export function numberNotes(paras: readonly TextParagraph[], count: NoteCount, pr?: NotePr, fixed?: Map<NoteRef, number>): TextParagraph[] {
  let out: TextParagraph[] | null = null;
  paras.forEach((p, i) => {
    if (!hasNotes(p)) return;
    let runs: TextRun[] | null = null;
    p.runs.forEach((r, k) => {
      if (!r.note || r.note.custom) return;
      const kind = r.note.kind;
      // (a number the page decides: Word's numbering restarted on each page — core/flow.ts)
      const mark = noteMarkText(fixed?.get(r.note) ?? (pr?.[kind]?.start != null ? pr[kind]!.start! + count[kind] : count[kind] + 1), kind, pr?.[kind]);
      count[kind]++;
      if (r.text === mark) return;
      runs ??= [...p.runs];
      runs[k] = { ...r, text: mark };
    });
    if (runs) {
      out ??= [...paras];
      out[i] = { ...p, runs };
    }
  });
  return out ?? (paras as TextParagraph[]);
}

const bodyMemo = new WeakMap<NoteRef, Map<string, TextParagraph[]>>();
/** A note's paragraphs as shown in its note area: its mark run showing `mark` (the reference's text). */
export function noteBody(note: NoteRef, mark: string): TextParagraph[] {
  let m = bodyMemo.get(note);
  const hit = m?.get(mark);
  if (hit) return hit;
  const paras = note.paras.map((p) => (p.runs.some((r) => r.noteMark && r.text !== mark) ? { ...p, runs: p.runs.map((r) => (r.noteMark && r.text !== mark ? { ...r, text: mark } : r)) } : p));
  if (!m) bodyMemo.set(note, (m = new Map()));
  m.set(mark, paras);
  return paras;
}

/** Word's footnote separator: a line 2 inches long (144 pt); the continuation separator runs across the column. */
export const WORD_SEP_LEN = 192;

/** The separator above a note area: its height, where its line is drawn in it and how long. */
export interface SepGeom {
  h: number;
  lineY: number;
  len: number;
  width: number;
  color: string;
}

/**
 * The separator of a note area of `kind`: Word's separator paragraph (`paraH` = its laid-out height, line across its
 * middle), 한글's line with room above and below, or — a document with no setting — a Word-like one 12 px high.
 * `cont`: a footnote going on from the page before (Word's continuation separator: as wide as the column).
 */
export function sepGeom(pr: NoteKindPr | undefined, width: number, cont: boolean, paraH?: number): SepGeom {
  const l = pr?.line;
  if (l === null) return { h: 0, lineY: 0, len: 0, width: 0, color: "#000000" };
  if (l) return { h: l.above + l.below, lineY: l.above, len: cont ? width : Math.min(width, l.len), width: l.width, color: l.color };
  const h = paraH ?? 12;
  return { h, lineY: h / 2, len: cont ? width : Math.min(width, WORD_SEP_LEN), width: 0.67, color: "#000000" };
}

/** The separator line of a note area at (x, y) in page px (a VECTOR node; `id` keeps it the same object between flows). */
export function sepNode(id: string, kind: NoteKind, x: number, y: number, g: SepGeom, old?: SceneNode): VectorNode {
  const yy = Math.round(y * 100) / 100;
  if (old && old.type === "VECTOR" && old.notes === kind && old.transform.x === x && old.transform.y === yy && old.contours[0]?.nodes[1]?.anchor[0] === g.len && old.strokeWidth === g.width && old.stroke === g.color) return old;
  const pt = (px: number): [number, number] => [px, 0];
  return {
    id,
    name: kind === "foot" ? "footnote separator" : "endnote separator",
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: "NORMAL",
    transform: { x, y: yy, rotation: 0, scale: 1 },
    type: "VECTOR",
    contours: [{ closed: false, nodes: [0, g.len].map((v) => ({ anchor: pt(v), handleIn: pt(v), handleOut: pt(v), isCorner: true })) }],
    fill: null,
    stroke: g.color,
    strokeWidth: g.width,
    fillRule: "nonzero",
    strokeCap: "butt",
    notes: kind,
  };
}

/** Every note of the document's body text in order (frames' paragraphs; pieces of a cut paragraph hold their own refs). */
export function documentNotes(pages: readonly Page[], kind?: NoteKind): NoteRef[] {
  const out: NoteRef[] = [];
  for (const pg of pages)
    for (const n of pg.nodes)
      if (n.type === "TEXT" && !n.notes) for (const p of n.paragraphs) for (const r of p.runs) if (r.note && (!kind || r.note.kind === kind)) out.push(r.note);
  return out;
}

/** 한글 자동 번호 모양 → note mark formats (others: 1 2 3) */
const HWPX_NOTEFMT: Record<string, NoteNumFormat> = { DIGIT: "decimal", ROMAN_SMALL: "lowerRoman", ROMAN_CAPITAL: "upperRoman", LATIN_SMALL: "lowerLetter", LATIN_CAPITAL: "upperLetter", HANGUL_SYLLABLE: "ganada" };

/** Note numbering and separator of a section (hp:footNotePr / hp:endNotePr; 한글's defaults where absent). */
export function hwpxNotePr(secPr: Element | undefined): NotePr {
  const out: NotePr = {};
  for (const kind of ["foot", "end"] as const) {
    const el = secPr && child(secPr, kind === "foot" ? "footNotePr" : "endNotePr");
    const f = el && child(el, "autoNumFormat");
    const pr: NoteKindPr = { fmt: HWPX_NOTEFMT[(f && attr(f, "type")) ?? "DIGIT"] ?? "decimal", suffix: f ? attr(f, "suffixChar") ?? "" : ")" };
    const pre = f && attr(f, "prefixChar");
    if (pre) pr.prefix = pre;
    if (!pr.suffix) delete pr.suffix;
    const nb = el && child(el, "numbering");
    const start = nb ? Number(attr(nb, "newNum")) : NaN;
    if (Number.isFinite(start) && start > 1) pr.start = start;
    // the line: -1 = 한글's 5 cm (its PDFs), a length longer than any page = across the column; spacing in HWPUNIT
    const nl = el && child(el, "noteLine");
    const sp = el && child(el, "noteSpacing");
    const num = (e: Element | undefined | null, a: string, d: number) => {
      const v = e ? Number(attr(e, a)) : NaN;
      return Number.isFinite(v) ? v : d;
    };
    const len = num(nl, "length", -1);
    const mm = /^([\d.]+)\s*mm$/.exec((nl && attr(nl, "width")) ?? "");
    const color = (nl && attr(nl, "color")) ?? "#000000";
    // (한글 draws no line for the endnotes' 14692344-unit default: a length past any page is taken as none)
    pr.line =
      (nl && attr(nl, "type") === "NONE") || len > 100000
        ? null
        : { len: len < 0 ? Math.round((50 / 25.4) * 96 * 100) / 100 : Math.min(len / 75, 4000), above: num(sp, "aboveLine", 850) / 75, below: num(sp, "belowLine", 567) / 75, width: mm ? Math.max(0.5, (Number(mm[1]) / 25.4) * 96) : 0.5, color: /^#[0-9a-f]{6}$/i.test(color) ? color : "#000000" };
    // 한글 sets the endnotes at the document's end on a page of their own (its PDFs)
    if (kind === "end") pr.newPage = true;
    out[kind] = pr;
  }
  return out;
}

/**
 * Note text edited in a note area (the text frame the flow laid out, edited like any text box): the edited paragraphs go
 * back into the notes they show, in the reference runs of the body frames (a paragraph made by Enter belongs to the
 * note before it). Areas holding a note cut at a page end are left alone. Returns `pages` itself when nothing changed.
 */
export function applyNoteAreaEdits(pages: Page[], prev: readonly Page[]): Page[] {
  const before = new Map<string, SceneNode>();
  for (const pg of prev) for (const n of pg.nodes) if (n.notes && n.type === "TEXT") before.set(n.id, n);
  const edited: TextParagraph[][] = [];
  for (const pg of pages)
    for (const n of pg.nodes) {
      const o = n.notes && n.type === "TEXT" ? before.get(n.id) : undefined;
      if (o && o !== n && o.type === "TEXT" && n.type === "TEXT" && o.paragraphs !== n.paragraphs && !n.paragraphs.some((q) => q.flowCont || q.flowSplit)) edited.push(n.paragraphs);
    }
  if (!edited.length) return pages;
  const byPara = new Map<string, NoteRef>();
  for (const pg of pages) for (const n of pg.nodes) if (n.type === "TEXT" && n.flow) for (const p of n.paragraphs) for (const r of p.runs) if (r.note) for (const q of r.note.paras) byPara.set(q.id, r.note);
  const repl = new Map<NoteRef, TextParagraph[]>();
  for (const ps of edited) {
    let cur: NoteRef | null = null;
    for (const q of ps) {
      const n = byPara.get(q.id);
      if (n && n !== cur) {
        cur = n;
        if (!repl.has(n)) repl.set(n, []);
      }
      if (cur) repl.get(cur)!.push(q);
    }
  }
  for (const [n, ps] of [...repl]) if (ps.length === n.paras.length && ps.every((q, i) => q === n.paras[i] || sameText(q, n.paras[i]))) repl.delete(n);
  if (!repl.size) return pages;
  const made = new Map<NoteRef, NoteRef>();
  const noteOf = (n: NoteRef) => {
    let v = made.get(n);
    if (!v) made.set(n, (v = { ...n, paras: repl.get(n)! }));
    return v;
  };
  return pages.map((pg) => {
    if (!pg.nodes.some((n) => n.type === "TEXT" && n.flow && n.paragraphs.some((p) => p.runs.some((r) => r.note && repl.has(r.note))))) return pg;
    return {
      ...pg,
      nodes: pg.nodes.map((n) =>
        n.type === "TEXT" && n.flow && n.paragraphs.some((p) => p.runs.some((r) => r.note && repl.has(r.note)))
          ? { ...n, paragraphs: n.paragraphs.map((p) => (p.runs.some((r) => r.note && repl.has(r.note)) ? { ...p, runs: p.runs.map((r) => (r.note && repl.has(r.note) ? { ...r, note: noteOf(r.note) } : r)) } : p)) }
          : n,
      ),
    };
  });
}

/** Same paragraph as shown (the mark run's text aside: it shows the reference's mark). */
function sameText(a: TextParagraph, b: TextParagraph): boolean {
  if (a.runs.length !== b.runs.length) return false;
  return a.runs.every((r, i) => {
    const s = b.runs[i];
    const { text: t1, ...x } = r, { text: t2, ...y } = s;
    return (r.noteMark || t1 === t2) && JSON.stringify(x) === JSON.stringify(y);
  }) && JSON.stringify({ ...a, runs: 0 }) === JSON.stringify({ ...b, runs: 0 });
}

/** A new footnote / endnote run at the reference place, in the look of the document's notes (or Word's: 10 pt, single). */
export function newNoteRun(kind: NoteKind, like: TextRun, model?: NoteRef): TextRun {
  const mp = model?.paras[0];
  const markRun = mp?.runs.find((r) => r.noteMark);
  const textRun = mp?.runs.find((r) => !r.noteMark && !r.note);
  const base: TextRun = { ...like, text: "", underline: false };
  delete base.highlight;
  delete base.obj;
  delete base.field;
  delete base.fieldCode;
  const size = Math.round(10 * (96 / 72) * 100) / 100;
  const para: TextParagraph = mp
    ? { ...mp, id: uid("p"), runs: [{ ...(markRun ?? { ...base, script: "super" as const }), text: "1", noteMark: true }, { ...(textRun ?? base), text: " " }] }
    : { id: uid("p"), align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 0, runs: [{ ...base, fontSize: size, script: "super", text: "1", noteMark: true }, { ...base, fontSize: size, text: " " }] };
  delete para.flowCont;
  delete para.flowSplit;
  delete para.hwpLines;
  delete para.list;
  return { ...base, text: "1", script: "super", note: { kind, paras: [para] } };
}
