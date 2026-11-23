// Office Surgeon — content fingerprints shared by the DOCX / HWPX / XLSX surgeons.
//
// A fingerprint covers what the importer reads and the exporter writes: run text and character format,
// paragraph format and role, table cells. Page placement (transform, page breaks) is not part of it, so a
// paragraph that only moved to another page is not "changed". List marker text ("• ", "3. ") is left out
// too: renumbering after deleting an item above is not an edit of the later items.

import { hashString } from "../../core/hash";
import { DEFAULT_RUN, type NoteRef, type TableCell, type TableNode, type TextParagraph, type TextRun } from "../../core/types";
import { docxBodyRuns } from "../office";
import { wordMultipleOf } from "../../core/lineSpacing";
import { markerLength } from "../../core/richtext";
import type { ListDef } from "../../core/style/types";
import type { FlowItem, OfficeItem } from "../office";
import { MAX_LEVELS, levelOf, resolveDef } from "../../core/lists";

/** Version of the block-map rules; a map made under other rules is not used (the file is written anew). */
export const ENGINE_VERSION = 1;
/**
 * Rules version of the word-processor maps (DOCX / HWPX). 2: page breaks are page boundaries, not text (a paragraph
 * holding only a page break is no item); sections and hard breaks are compared with the pages (layout.ts).
 */
export const WORD_ENGINE_VERSION = 2;

export const isListRole = (p: TextParagraph) => p.role === "li" || p.role === "oli";

/**
 * Runs as the surgeon writes them: without the number the paragraph shows as text (markerLength > 0) - a list item's,
 * and a heading's or body paragraph's outline / paragraph numbering alike: the file draws it from its numbering. (By
 * role alone, an edited '1. 개요' was written with '1. ' as text and read again as '1. 1. 개요', QA 2026-11-16.)
 * The fingerprints (normalRuns) keep their role rule: block maps already saved hold them.
 */
export const markedBodyRuns = (p: TextParagraph) => docxBodyRuns(p, markerLength(p) > 0);

/**
 * Model version of the block maps: 2 = made by the importer that reads paragraph spacing before / right indent /
 * exact line heights / keep flags, multi-level lists and 장평·한글 자간 (TextParagraph / TextRun optional fields).
 * A map without it (older .omw) was made from paragraphs without those fields: the original read again is compared
 * in that older shape (legacyParaView), so an untouched paragraph still counts as untouched.
 * 3 = DOCX line spacing read as a Word multiple (lineMultiple, Word's measured single lines): a map before it is compared
 * with the original in its older shape too (preWordMultipleView), read with that importer's run defaults (11 pt without
 * w:sz, theme fonts ignored, sizes to 0.1 px: office.ts docxContext legacy).
 */
export const MODEL_VERSION = 9;
/**
 * Model 9: comments and tracked changes are read (core/review.ts): deleted and moved-away text are runs (TextRun.rev),
 * DOCX moves no longer read twice, 한글 memo text is a comment, not body paragraphs. A map before it reads the original
 * as the importer before did (OfficeImportReport.noReview).
 */
export const MODEL_REVIEW = 9;
/** Model 8: DOCX — an empty paragraph after a table is an item unless it ends the body (OfficeImportReport.afterTableParas). */
export const MODEL_AFTER_TABLE = 8;
/**
 * Model 6: DOCX read through Word's style hierarchy (office.ts DocxStyles): paragraph and run properties from the
 * paragraph style chain, character styles and document defaults; a run's Latin font beside its East Asian one
 * (TextRun.latinFont). A map before it reads the original as the importer before did.
 */
export const MODEL_WORD_STYLES = 6;
/** Model 4: DOCX heading runs read with the heading style's size / bold (below); a map before it reads the original with the guess. */
export const MODEL_HEADING_STYLES = 4;
/**
 * (Model 5 = pictures: body pictures are IMAGE nodes and a paragraph of inline pictures only is no item — officesurgeon/
 * pics.ts MODEL_PICTURES; a map before it reads the original without pictures, as that importer did.)
 * Model 3: DOCX line spacing as a Word multiple (above). 4 = DOCX heading runs without their own w:sz / w:b take the
 * heading style's (styles.xml through basedOn) instead of the guessed 26 − 3 × level pt bold: a map before it reads the
 * original with the guess (office.ts docxContext oldHeadings), so an untouched heading still counts as untouched.
 */
export const MODEL_WORD_MULTIPLE = 3;
/** maps below this model version compare in the shape before optional paragraph fields (legacyParaView) */
export const MODEL_OPTIONAL_FIELDS = 2;

/**
 * Character format of a run (everything but its text). Fields added later are appended only when set, so the key of a
 * run without them — and every fingerprint stored in an older map — stays the same.
 */
export const runKey = (r: TextRun) => {
  const base = lookBase(r);
  // a tracked insertion / deletion / move (model 9): inserted and deleted text are not the same content
  if (r.rev) base.push({ rev: r.rev.kind });
  // a format change's mark and the comments on the text (stage 2: accepting a format change, adding a comment are edits)
  if (r.fmtRev) base.push({ fmt: 1 });
  if (r.comments?.length) base.push({ c: [...r.comments].sort() });
  return JSON.stringify(base);
};

const lookBase = (r: TextRun): unknown[] => {
  const base: unknown[] = [r.fontFamily, r.fontSize, !!r.bold, !!r.italic, !!r.underline, !!r.strike, r.color, r.highlight ?? null, r.script ?? null, r.letterSpacing ?? 0];
  if ((r.hscale ?? 100) !== 100 || r.spacingPct) base.push(r.hscale ?? 100, r.spacingPct ?? 0);
  return base;
};

/** The character format alone (which original w:rPr / hh:charPr a run can take). */
export const lookKey = (r: TextRun) => JSON.stringify(lookBase(r));

/** The character format and the tracked insertion / deletion (text written back as an original element keeps both). */
export const revLookKey = (r: TextRun) => {
  const base = lookBase(r);
  if (r.rev) base.push({ rev: r.rev.kind });
  return JSON.stringify(base);
};

/** A paragraph's own tracked changes (its mark inserted / deleted, its format change); "" without (older hashes stay). */
export const paraReviewKey = (p: TextParagraph) => (p.markRev || p.fmtRev || p.markFmtRev ? JSON.stringify([p.markRev?.kind ?? null, !!p.fmtRev, ...(p.markFmtRev ? [true] : [])]) : "");

/** Paragraph format and role (everything but its runs); later fields appended only when set (see runKey). */
export const paraPropsKey = (p: TextParagraph) => {
  const base: unknown[] = [p.align, p.lineSpacing, p.indent, p.indentLeft ?? 0, p.spaceAfter, p.role ?? ""];
  // (the at-least basis is how the line is drawn, not what the file says: left out)
  const lh = p.lineHeight ? { mode: p.lineHeight.mode, v: p.lineHeight.v } : null;
  const extra = [p.spaceBefore ?? 0, p.indentRight ?? 0, lh, !!p.keepNext, !!p.keepLines, !!p.pageBreakBefore, p.list ? [p.list.def, p.list.level, p.list.start ?? null] : null];
  if (extra.some((v, i) => v !== [0, 0, null, false, false, false, null][i])) base.push(extra);
  // a Word multiple (DOCX import; core/lineSpacing.ts): appended only when the paragraph is drawn with one
  const wm = wordMultipleOf(p);
  if (wm !== undefined) base.push({ wm });
  // 단 나누기: appended only when the paragraph has one (older hashes stay)
  if (p.colBreak) base.push({ cb: p.colBreak });
  // 이어서 구역 that begins here (its columns; the Office Surgeon writes them into the section's own w:sectPr)
  if (p.contSect) base.push({ cs: p.contSect.columns ? [p.contSect.columns.n, Math.round(p.contSect.columns.gap), p.contSect.columns.widths?.map(Math.round) ?? null, !!p.contSect.columns.line] : 1 });
  return JSON.stringify(base);
};

/** A run as the importer before model version 2 read it: no 장평, 한글 자간 as px of the size. */
export function legacyRunView(r: TextRun): TextRun {
  if ((r.hscale ?? 100) === 100 && !r.spacingPct) return r;
  const { hscale: _h, spacingPct, ...rest } = r;
  const out: TextRun = { ...rest };
  if (spacingPct) out.letterSpacing = Math.round((spacingPct / 100) * r.fontSize * 100) / 100;
  return out;
}

/**
 * The original DOCX paragraph read now, in the shape a map before model 3 has: no Word multiple, and the current
 * paragraph's lineSpacing while its wordLine still is the original's w:line (that importer converted Word's multiple
 * with other single-line ratios, so its lineSpacing is not the one read now).
 */
export function preWordMultipleView(orig: TextParagraph, cur: TextParagraph | undefined): TextParagraph {
  if (!orig.lineMultiple) return orig;
  const { lineMultiple, ...rest } = orig;
  const wl = cur?.wordLine;
  const same = !!cur && !!wl && wl.lineSpacing === cur.lineSpacing && Math.round(wl.line) === Math.round(lineMultiple.v * 240);
  return same ? { ...rest, lineSpacing: cur.lineSpacing } : rest;
}

/** A paragraph as the importer before model version 2 read it (see MODEL_VERSION). */
export function legacyParaView(p: TextParagraph): TextParagraph {
  const { spaceBefore: _a, indentRight: _b, lineHeight: _c, keepNext: _d, keepLines: _e, pageBreakBefore: _f, list: _g, lineMultiple: _h, wordLine: _i, ...rest } = p;
  // a numbered heading (outline numbering) had no marker text then
  const runs = p.list && !isListRole(p) ? docxBodyRuns(p, true) : p.runs;
  return { ...rest, runs: runs.map(legacyRunView) };
}

/**
 * Runs without the list marker, empty runs dropped and neighbours with the same format joined. A note reference counts
 * as the note being there (not its number: numbering again after a note is added above is no edit of this paragraph,
 * and the note's own text is compared on its own, noteFp); a note's own mark likewise.
 */
export function normalRuns(p: TextParagraph): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const r of docxBodyRuns(p, isListRole(p))) {
    if (r.note || r.noteMark) {
      out.push({ key: r.note ? `note:${r.note.kind}${r.note.custom ? ":" + r.text : ""}` : "mark", text: "\u0001" });
      continue;
    }
    if (!r.text) continue;
    const key = runKey(r);
    const last = out[out.length - 1];
    if (last && last.key === key) last.text += r.text;
    else out.push({ key, text: r.text });
  }
  return out;
}

export const paraFp = (p: TextParagraph) => hashString(paraPropsKey(p) + paraReviewKey(p) + "\u0000" + JSON.stringify(normalRuns(p)));

/** Fingerprint of a footnote / endnote's own text (its paragraphs). */
export const noteFp = (n: NoteRef) => hashString(n.kind + "\u0000" + n.paras.map(paraFp).join("\u0000"));

/** Model 7: notes are read (TextRun.note) and the map keeps each note's fingerprint (OfficeSourceMeta.notes). */
export const MODEL_NOTES = 7;

/** A cell's paragraphs as the exporters use them: the rich paragraphs while they still match the cell text. */
export const cellParas = (c: TableCell): TextParagraph[] | null =>
  c.richText?.length && c.richText.map((p) => p.runs.map((r) => r.text).join("")).join("\n") === c.text ? c.richText : null;

export function cellFp(c: TableCell): string {
  const rich = cellParas(c)?.map(paraFp) ?? null;
  return hashString(JSON.stringify([rich ? null : c.text, !!c.bold, !!c.italic, c.align ?? null, c.color ?? null, c.fill ?? null, c.colSpan ?? 1, c.rowSpan ?? 1, c.formula ?? null, c.numFmt ?? null, rich]));
}

/** Table-level format (everything but the cells). */
export const tablePropsKey = (t: TableNode) =>
  JSON.stringify([t.colWidths.map((w) => Math.round(w * 10) / 10), t.headerRow, t.fontFamily, t.fontSize, t.color, t.borderColor, t.headerFill]);

export const tableFp = (t: TableNode) => hashString(tablePropsKey(t) + "\u0000" + t.rows.map((r) => r.map(cellFp).join(",")).join(";"));

export const itemId = (it: { kind: "p"; p: TextParagraph } | { kind: "table"; t: TableNode }) => (it.kind === "p" ? it.p.id : it.t.id);
export const itemFp = (it: { kind: "p"; p: TextParagraph } | { kind: "table"; t: TableNode }) => (it.kind === "p" ? paraFp(it.p) : tableFp(it.t));

/**
 * The paragraphs of an edited cell: its rich paragraphs while they match its text, else its text lines in the
 * look of the cell's original paragraphs (an edit of the plain cell text keeps the original format); null when
 * the original cell has no paragraphs to take the look from.
 */
export function cellParagraphs(cell: TableCell, orig: TextParagraph[]): TextParagraph[] | null {
  const rich = cellParas(cell);
  if (rich) return rich;
  if (!orig.length) return null;
  return cell.text.split("\n").map((line, k) => {
    const tpl = orig[Math.min(k, orig.length - 1)];
    return { ...tpl, runs: [{ ...(tpl.runs[0] ?? DEFAULT_RUN), text: line }] };
  });
}

// ── list numbering the file cannot keep (QA hwpx-numbering ①, 2026-11-17) ──
//
// A paragraph's fingerprint names its list definition by id only, and the list dialog changes a definition read from
// the file in place (same id): a changed number format (가. → 1)), bullet shape or start number was not seen, or the
// paragraph was written with its original w:numPr / hh:heading, and the file opened again in the old format. The
// surgeons now compare the definitions themselves and give the lists whose numbering changed numbering of their own
// (the file's definitions stay as they are: other paragraphs may use them).

/** A list definition as a file holds it (formats, texts, starts, indents, marker look), for comparing. */
export const listDefKey = (d: ListDef) => JSON.stringify([!!d.outline, d.levels.map((l) => [l.format, l.text, l.start ?? 1, l.indent ?? null, l.char ?? null])]);

/** Ids of the file's list definitions (`orig`, read again) that the pages hold otherwise now. */
export function changedListDefs(cur: readonly ListDef[], orig: readonly ListDef[] | undefined): Set<string> {
  const was = new Map((orig ?? []).map((d) => [d.id, listDefKey(d)]));
  return new Set(cur.filter((d) => was.has(d.id) && was.get(d.id) !== listDefKey(d)).map((d) => d.id));
}

/** One run of a list written with numbering of its own: the restart numbers of its levels (first item of each). */
export interface ListSegment {
  /** list instance the segment belongs to */
  list: string;
  /** level → number its first item there starts at (an override: DOCX w:lvlOverride, HWPX paraHead start) */
  starts: Map<number, number>;
  /** levels that have had an item in the segment */
  seen: Set<number>;
}

export interface RelistPlan {
  /** paragraphs whose numbering is written anew, with their segment */
  at: Map<TextParagraph, ListSegment>;
  /** why the numbering cannot be written in place (the file is written anew), null when it can */
  unsafe: string | null;
}

/** Body paragraphs in document order, cell paragraphs of tables included (the ones the surgeons write). */
export function flowParas(flow: readonly FlowItem[]): TextParagraph[] {
  const out: TextParagraph[] = [];
  for (const it of flow) {
    if (it.kind === "p") out.push(it.p);
    else for (const row of it.t.rows) for (const c of row) out.push(...(cellParas(c) ?? []));
  }
  return out;
}

/** The paragraphs of the file as read again for the ones of the pages (same item id; cells by place). */
export function origParas(flow: readonly FlowItem[], origOf: (id: string) => OfficeItem | undefined): Map<TextParagraph, TextParagraph> {
  const out = new Map<TextParagraph, TextParagraph>();
  const seen = new Set<string>();
  for (const it of flow) {
    const id = itemId(it);
    if (seen.has(id)) continue; // a copy of an item is new content
    seen.add(id);
    const o = origOf(id);
    if (!o) continue;
    if (it.kind === "p" && o.kind === "p") out.set(it.p, o.p);
    else if (it.kind === "table" && o.kind === "table")
      it.t.rows.forEach((row, ri) =>
        row.forEach((c, ci) => {
          const was = o.table.rows[ri]?.[ci];
          const a = cellParas(c), b = was ? cellParas(was) : null;
          a?.forEach((p, k) => b?.[k] && out.set(p, b[k]));
        }),
      );
  }
  return out;
}

/**
 * Which list paragraphs get numbering of their own. A list of the file (`fileDef`: instance id → the definition the
 * file gives it) keeps its numbering while its definition is unchanged and each item's start number is the file's;
 * from the first item where that no longer holds, the rest of the list is written in segments of its own (Word / 한글
 * move the following items to the new numbering too). Lists made in Omniweave are segments from their first item.
 *
 * Each segment starts at its first item with the numbers the editor shows there (`starts`: levels 0 … the item's
 * level, the levels above it as the numbers of the items it is under). Word (hidden new Word, QA list-format
 * 2026-11-17) reads a w:num's w:startOverride only when it has one for level 0, uses it again each time that level
 * restarts, and counts the w:num instances of one w:abstractNum on from each other when they have none: so a segment
 * always has its numbers from level 0, and a new one starts at each restart (an item with a start number) and at an
 * item shallower than the segment's first one (where its deeper override would be used again).
 */
export function relistPlan(order: readonly TextParagraph[], origOf: ReadonlyMap<TextParagraph, TextParagraph>, fileDef: ReadonlyMap<string, string>, changed: ReadonlySet<string>, defs: readonly ListDef[] = []): RelistPlan {
  const at = new Map<TextParagraph, ListSegment>();
  const segOf = new Map<string, ListSegment>();
  // the editor's counters of each list (core/lists.ts listNumbers)
  const counters = new Map<string, (number | undefined)[]>();
  const segment = (list: string, cs: readonly (number | undefined)[], level: number, def: string): ListSegment => {
    const d = resolveDef(def, defs);
    // a level above the item with no number yet: one before its start (Word counts the item as under that number)
    const starts = new Map(Array.from({ length: level + 1 }, (_, k): [number, number] => [k, cs[k] ?? (levelOf(d, k).start ?? 1) - (k < level ? 1 : 0)]));
    const s: ListSegment = { list, starts, seen: new Set() };
    segOf.set(list, s);
    return s;
  };
  for (const p of order) {
    const l = p.list;
    if (!l) continue;
    const level = Math.max(0, Math.min(MAX_LEVELS - 1, l.level | 0));
    const cs = counters.get(l.id) ?? [];
    cs[level] = l.start != null ? l.start : cs[level] == null ? (levelOf(resolveDef(l.def, defs), level).start ?? 1) : cs[level]! + 1;
    for (let k = level + 1; k < MAX_LEVELS; k++) cs[k] = undefined;
    counters.set(l.id, cs);
    let seg = segOf.get(l.id);
    if (!seg) {
      const o = origOf.get(p)?.list;
      const def = fileDef.get(l.id);
      const startSame = o && o.id === l.id ? (o.start ?? null) === (l.start ?? null) : l.start == null;
      if (def !== undefined && def === l.def && !changed.has(l.def) && startSame) continue;
      seg = segment(l.id, cs, level, l.def);
    } else if (l.start != null || level < Math.max(...seg.starts.keys())) seg = segment(l.id, cs, level, l.def);
    seg.seen.add(level);
    at.set(p, seg);
  }
  return { at, unsafe: null };
}

/** Instance id → definition id of the file's lists (from its paragraphs as read again). */
export function fileListDefs(paras: Iterable<TextParagraph>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of paras) if (p.list && !out.has(p.list.id)) out.set(p.list.id, p.list.def);
  return out;
}

/** Whether an item holds a paragraph whose numbering is written anew (so it is not intact). */
export const itemRelisted = (it: FlowItem, plan: RelistPlan) =>
  plan.at.size > 0 && (it.kind === "p" ? plan.at.has(it.p) : it.t.rows.some((row) => row.some((c) => (cellParas(c) ?? []).some((p) => plan.at.has(p)))));
