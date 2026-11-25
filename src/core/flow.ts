// Body flow of document pages (docs/design/DOC_FLOW.md).
//
// The story of a page run is not stored on its own: the pages keep the laid-out result as ordinary nodes (one text
// frame per page holding the paragraphs that fall there, tables and pictures where they land), so every renderer and
// writer keeps working on page.nodes. This module gathers those frames back into one story, lays the story out from
// page to page (Word's rules: keep with next, keep lines together, page break before, widow / orphan control, tables
// split between rows with the header row repeated) and writes the result back onto the pages.
//
// Paragraph layouts are cached per paragraph object (immer keeps untouched paragraphs identical), and frames, pieces
// and pages whose content did not change are reused as the same objects, so one keystroke in a long document lays out
// one paragraph and rebuilds only the pages whose frames moved.

import { t } from "../i18n";
import { advance, graphemes, hwpLinesSig, layoutText, runScale, spacingOverlap, textMetricsEpoch, type LaidLine, type TextLayout } from "./text";
import { coverMap, layoutTable, richBox, richOf } from "./table";
import { bodyBox, columnBoxes, flowHeight } from "./pageSetup";
import { hfPush } from "./headerFooter";
import { pageBorderNodes } from "./pageBorder";
import { wordMultipleOf } from "./lineSpacing";
import { countNotes, hasNotes, noteBody, notePrOf, notesOf, numberNotes, sepGeom, sepNode, type SepGeom } from "./notes";
import { markerLength } from "./richtext";
import { uid, type HwpLines, type NotePr, type NoteRef, type Page, type PageColumns, type SceneNode, type TableCell, type TableNode, type TextNode, type TextParagraph, type TextRun } from "./types";
import type { ListDef } from "./style/types";

// ───────── segments ─────────

/** Pages [start, end) that one story flows through: a page that begins with a page or section break and the pages that continue it. */
export interface Segment {
  start: number;
  end: number;
}

export const isFlowNode = (n: SceneNode) => n.flow === true;

/** The run of pages holding page `i`. */
export function segmentAt(pages: readonly Pick<Page, "breakBefore">[], i: number): Segment {
  let start = Math.max(0, Math.min(i, pages.length - 1));
  while (start > 0 && pages[start].breakBefore === "flow") start--;
  let end = start + 1;
  while (end < pages.length && pages[end].breakBefore === "flow") end++;
  return { start, end };
}

/** Every page run in order. */
export function segments(pages: readonly Pick<Page, "breakBefore">[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < pages.length; ) {
    const s = segmentAt(pages, i);
    out.push(s);
    i = s.end;
  }
  return out;
}

/** The run of pages holding page `i` flows (a document page run with at least one flow frame). */
export function isFlowSegment(pages: readonly Page[], seg: Segment): boolean {
  for (let i = seg.start; i < seg.end; i++) if (pages[i].kind === "DOCUMENT" && pages[i].nodes.some(isFlowNode)) return true;
  return false;
}

export const isFlowPageAt = (pages: readonly Page[], i: number) => i >= 0 && i < pages.length && pages[i].kind === "DOCUMENT" && isFlowSegment(pages, segmentAt(pages, i));

// ───────── split paragraphs ─────────

const textOf = (p: TextParagraph) => {
  let s = "";
  for (const r of p.runs) s += r.text;
  return s;
};

const joinMemo = new WeakMap<TextParagraph, WeakMap<TextParagraph, TextParagraph>>();

/**
 * The pieces a joined paragraph / table was made of, with their character / row ranges. Cutting it again at the same
 * places gives those very objects back (pieceOf / tablePiece), so flowing a story whose layout did not change returns
 * the same frames and pages — without this every paragraph or table cut at a page end came out as new objects on every
 * keystroke (new frames, laid out again, page caches dropped).
 */
type Origin<T> = { a: number; b: number; piece: T }[];
const origins = new WeakMap<object, Origin<unknown>>();
const lenOf = (p: TextParagraph) => {
  let n = 0;
  for (const r of p.runs) n += r.text.length;
  return n;
};
function originOf<T>(whole: T, a: number, b: number): T | undefined {
  const o = origins.get(whole as object) as Origin<T> | undefined;
  return o?.find((x) => x.a === a && x.b === b)?.piece;
}
/** same fields (`skip` aside) by identity */
function sameFields(x: object, y: object, skip: readonly string[]): boolean {
  const kx = Object.keys(x).filter((k) => !skip.includes(k)), ky = Object.keys(y).filter((k) => !skip.includes(k));
  return kx.length === ky.length && kx.every((k) => (x as Record<string, unknown>)[k] === (y as Record<string, unknown>)[k]);
}
const samePiece = (x: TextParagraph, y: TextParagraph) =>
  sameFields(x, y, ["runs"]) && x.runs.length === y.runs.length && x.runs.every((r, i) => sameFields(r, y.runs[i], []));

/** A paragraph cut at a page end, joined again (head + its continuation); the head's own fields and id. */
export function joinSplit(head: TextParagraph, cont: TextParagraph): TextParagraph {
  let m = joinMemo.get(head);
  const hit = m?.get(cont);
  if (hit) return hit;
  const runs = [...head.runs];
  const rest = cont.runs.filter((r) => r.text);
  if (head.flowSplit === 2 && runs.length && rest.length) {
    const last = runs[runs.length - 1];
    runs[runs.length - 1] = { ...last, text: last.text + rest[0].text };
    runs.push(...rest.slice(1));
  } else runs.push(...rest);
  const out: TextParagraph = { ...head, runs: runs.filter((r, i) => r.text || runs.length === 1 || i === 0) };
  if (cont.flowSplit) out.flowSplit = cont.flowSplit;
  else delete out.flowSplit;
  // 한글's saved lines of both pieces (each still as laid out) make the whole paragraph's again
  const hh = head.hwpLines, ch = cont.hwpLines;
  if (hh || ch) {
    if (hh && ch && hh.sig === hwpLinesSig(head) && ch.sig === hwpLinesSig(cont)) {
      const hl = lenOf(head), n = hh.at.length + 1;
      const v: HwpLines = { at: [...hh.at, hl, ...ch.at.map((x) => x + hl)], right: hh.right, sig: "" };
      if (hh.page || ch.page) v.page = [...(hh.page ?? []), ...(ch.page ?? []).map((i) => i + n)];
      out.hwpLines = v;
      v.sig = hwpLinesSig(out);
    } else delete out.hwpLines;
  }
  const hl = lenOf(head);
  origins.set(out, [...((origins.get(head) as Origin<TextParagraph>) ?? [{ a: 0, b: hl, piece: head }]), { a: hl, b: hl + lenOf(cont), piece: cont }]);
  if (!m) joinMemo.set(head, (m = new WeakMap()));
  m.set(cont, out);
  return out;
}

const plainMemo = new WeakMap<TextParagraph, TextParagraph>();
/**
 * A flow piece standing on its own (stories here, the DOCX / HWPX writers in io/office.ts): a continuation whose head
 * is gone becomes the head — the paragraph's id, still joined by its own continuation when it is cut again — and a
 * head whose continuation is gone loses its cut mark.
 */
export function unpiece(p: TextParagraph): TextParagraph {
  if (!p.flowSplit && !p.flowCont) return p;
  let v = plainMemo.get(p);
  if (!v) {
    v = { ...p };
    if (v.flowCont) v.id = v.flowCont;
    else delete v.flowSplit;
    delete v.flowCont;
    plainMemo.set(p, v);
  }
  return v;
}

/** Paragraphs of text frames in order with the pieces of paragraphs cut at page ends joined again (exports, search). */
export function joinPieces(paras: readonly TextParagraph[]): TextParagraph[] {
  const out: TextParagraph[] = [];
  for (const p of paras) {
    const prev = out[out.length - 1];
    if (p.flowCont && prev && prev.id === p.flowCont && prev.flowSplit) out[out.length - 1] = joinSplit(prev, p);
    else out.push(p.flowCont ? unpiece(p) : p);
  }
  // a cut whose continuation never came (after joining, none can follow): the paragraph ends there
  for (let i = 0; i < out.length; i++) if (out[i].flowSplit) out[i] = unpiece(out[i]);
  return out;
}

const pieceMemo = new WeakMap<TextParagraph, Map<string, TextParagraph>>();

/** Characters [a, b) of a story paragraph as a flow piece (a = 0: the head, keeps the id; b = length: the last piece). */
export function pieceOf(p: TextParagraph, a: number, b: number, len: number): TextParagraph {
  if (a === 0 && b >= len) return p;
  const key = `${a}:${b}`;
  let m = pieceMemo.get(p);
  const hit = m?.get(key);
  if (hit) return hit;
  const runs: TextRun[] = [];
  let acc = 0;
  let inside = false; // the cut at b falls inside a run
  for (const r of p.runs) {
    const s = Math.max(a, acc), e = Math.min(b, acc + r.text.length);
    if (e > s) runs.push({ ...r, text: r.text.slice(s - acc, e - acc) });
    if (b > acc && b < acc + r.text.length) inside = true;
    acc += r.text.length;
  }
  if (!runs.length) runs.push({ ...(p.runs[0] ?? ({} as TextRun)), text: "" });
  let out: TextParagraph = { ...p, runs };
  if (b < len) out.flowSplit = inside ? 2 : 1;
  else delete out.flowSplit;
  if (a > 0) {
    out.id = `${p.id}~${a}`;
    out.flowCont = p.id;
    out.indent = 0;
    delete out.spaceBefore;
    delete out.list;
    delete out.pageBreakBefore;
  }
  // 한글's saved lines of the paragraph go with each piece (its own breaks, signed for the piece's text)
  const h = p.hwpLines;
  if (h) {
    if (h.sig === hwpLinesSig(p)) {
      const hl: HwpLines = { at: h.at.filter((x) => x > a && x < b).map((x) => x - a), right: h.right, sig: "" };
      // 한글's page starts within the piece (line numbers from the piece's first line)
      const la = a === 0 ? 0 : h.at.indexOf(a) + 1;
      if (h.page && (a === 0 || la > 0)) hl.page = h.page.filter((i) => (i === 0 ? 0 : h.at[i - 1]) >= a && (i === 0 ? 0 : h.at[i - 1]) < b).map((i) => i - la);
      out.hwpLines = hl;
      hl.sig = hwpLinesSig(out);
    } else delete out.hwpLines;
  }
  // cut where it was cut before: the piece already on the page
  const was = originOf<TextParagraph>(p, a, b);
  if (was && samePiece(was, out)) out = was;
  if (!m) pieceMemo.set(p, (m = new Map()));
  m.set(key, out);
  return out;
}

// ───────── split tables ─────────

/** A cell part of a row cut at a page end that holds nothing (TableNode.cutRow): no text, no paragraphs. */
const isEmptyPart = (c: TableCell) => !c.text && !!c.richText && c.richText.length === 0;

const cellTextOf = (ps: readonly TextParagraph[]) => ps.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
/** a cell whose text is not its paragraphs' (edited, or no paragraphs): the cell is its text then, as an edited cell is */
const editedPart = (c: TableCell) => !isEmptyPart(c) && (c.richText ? c.text !== cellTextOf(c.richText) : !!c.text);

/** The cell without its cut marks (TableCell.cutA / cutB); `keep`: still the first part of the next cut (cutA). */
function unmarked(c: TableCell, keep?: number): TableCell {
  const { cutA: _a, cutB: _b, ...rest } = c;
  return keep !== undefined ? { ...rest, cutA: keep } : rest;
}

/** A cell's paragraph pieces made whole again (a cell part whose other part is gone, or the row's last part). */
function wholeCell(c: TableCell): TableCell {
  const ps = c.richText;
  if (!ps?.some((p) => p.flowSplit || p.flowCont)) return c;
  const was = editedPart(c);
  const q = ps.map((p) => (p.flowSplit || p.flowCont ? unpiece(p) : p));
  return was ? { ...c, richText: q } : { ...c, text: cellTextOf(q), richText: q };
}

/** A row of a joined table that is no part of a cut row any more: no marks, its paragraphs whole. */
function plainRow(row: TableCell[]): TableCell[] {
  if (!row.some((c) => c.cutA !== undefined || c.cutB !== undefined)) return row;
  return row.map((c) => (c.cutA !== undefined || c.cutB !== undefined ? wholeCell(unmarked(c)) : c));
}

/** The one cut mark (cutA / cutB) every marked cell of a row has (unmarked cells: merged away or new), else undefined. */
function rowMark(row: readonly TableCell[], k: "cutA" | "cutB"): number | undefined {
  let v: number | undefined;
  for (const c of row) {
    const x = c[k];
    if (x === undefined) continue;
    if (v !== undefined && v !== x) return undefined;
    v = x;
  }
  return v;
}

/**
 * The two parts of a row cut at a page end joined into the row again, cell by cell (their paragraph pieces joined).
 * `keep`: the joined row is cut again at the next page end (its continuation's cutA) — its last pieces stay open.
 */
function joinRow(a: TableCell[], b: TableCell[], keep: number | undefined): TableCell[] {
  return a.map((ca0, i) => {
    const ca = unmarked(ca0), cb = unmarked(b[i]);
    const done = (c: TableCell) => (keep !== undefined ? unmarked(c, keep) : wholeCell(c));
    if (isEmptyPart(cb)) return done(ca);
    if (isEmptyPart(ca)) return done({ ...cb, ...(ca.minHeight !== undefined ? { minHeight: ca.minHeight } : {}) });
    if (editedPart(ca) || editedPart(cb)) {
      // the cut fell inside a paragraph (the first part's last piece goes on): no line break between the parts
      const inPara = !!ca.richText?.[ca.richText.length - 1]?.flowSplit;
      const { richText: _r, ...rest } = ca;
      return done({ ...rest, text: ca.text && cb.text ? ca.text + (inPara ? "" : "\n") + cb.text : ca.text || cb.text });
    }
    const pa = ca.richText ?? [], pb = cb.richText ?? [];
    const last = pa[pa.length - 1];
    // (the rest of a piece cut again on a later page continues the joined paragraph, whatever piece id it was given)
    const ps = last?.flowSplit && pb[0]?.flowCont ? [...pa.slice(0, -1), joinSplit(last, pb[0]), ...pb.slice(1)] : [...pa, ...pb];
    return done({ ...ca, text: cellTextOf(ps), richText: ps });
  });
}

/**
 * Where the first part of a cut row (cutA) at the end of `head` and its rest (the same cutB) in `more` are, when they
 * can still be joined: both there, as many cells, none merged or covered (rows the parts were cut from never are).
 * Rows inserted or deleted next to a part, cells merged across one: no pair — the parts stay rows of their own.
 */
function cutPair(head: TableNode, more: readonly TableCell[][]): { ia: number; ib: number } | null {
  let ia = head.rows.length - 1;
  while (ia >= 0 && rowMark(head.rows[ia], "cutA") === undefined) ia--;
  if (ia < 0) return null;
  const key = rowMark(head.rows[ia], "cutA");
  const ib = more.findIndex((r) => rowMark(r, "cutB") === key);
  if (ib < 0) return null;
  const a = head.rows[ia], b = more[ib], cols = head.colWidths.length;
  if (a.length !== cols || b.length !== cols) return null;
  const spans = (r: readonly TableCell[]) => r.some((c) => (c.rowSpan ?? 1) > 1 || (c.colSpan ?? 1) > 1);
  if (spans(a) || spans(b)) return null;
  const ca = coverMap(head.rows)[ia], cb = coverMap(more as TableCell[][])[ib];
  if (ca.some((v) => v && v.r !== ia) || cb.some((v) => v && v.r !== ib)) return null;
  return { ia, ib };
}

/** A joined table that no further piece continues: rows still marked as cut parts made plain (TableNode.cutRow). */
export function endCut(t: TableNode): TableNode {
  if (!t.cutRow && !t.rows.some((r) => r.some((c) => c.cutA !== undefined || c.cutB !== undefined))) return t;
  let v = endMemo.get(t);
  if (!v) {
    v = { ...t, rows: t.rows.map(plainRow) };
    delete v.cutRow;
    endMemo.set(t, v);
  }
  return v;
}
const endMemo = new WeakMap<TableNode, TableNode>();

const tableJoinMemo = new WeakMap<TableNode, WeakMap<TableNode, TableNode>>();
/**
 * A table piece and the piece continuing it as one table (the continuation's repeated header row left out, a row cut
 * between them joined again). The writers (io/office.ts collectFlow) join pieces with it too.
 */
export function joinTable(head: TableNode, cont: TableNode): TableNode {
  let m = tableJoinMemo.get(head);
  const hit = m?.get(cont);
  if (hit) return hit;
  const more = cont.headerRow && cont.rows.length > 1 ? cont.rows.slice(1) : cont.rows;
  const pair = head.cutRow && more.length > 0 ? cutPair(head, more) : null;
  // the continuation's rows: a rest (cutB) is joined or plain now; a first part (cutA) stays while a piece follows
  const contRow = (r: TableCell[]) => {
    const stale = (c: TableCell) => c.cutB !== undefined || (!cont.cutRow && c.cutA !== undefined);
    return r.some(stale) ? r.map((c) => (stale(c) ? (c.cutA !== undefined && cont.cutRow ? unmarked(c, c.cutA) : wholeCell(unmarked(c))) : c)) : r;
  };
  let rows: TableCell[][];
  if (pair) {
    // (rows added after the first part or before the rest — a new row, Tab in the last cell — around the joined row:
    // those before the rest before it, those after the first part after it)
    const { ia, ib } = pair;
    const joined = joinRow(head.rows[ia], more[ib], cont.cutRow ? rowMark(more[ib], "cutA") : undefined);
    rows = [...head.rows.slice(0, ia).map(plainRow), ...more.slice(0, ib).map(contRow), joined, ...head.rows.slice(ia + 1).map(plainRow), ...more.slice(ib + 1).map(contRow)];
  } else rows = [...head.rows.map(plainRow), ...more.map(contRow)];
  const out: TableNode = { ...head, rows };
  if (cont.cutRow) out.cutRow = true;
  else delete out.cutRow;
  const hr = head.rows.length;
  // (rows are the pieces' own when nothing was joined or made plain)
  const cut = !!pair || rows.some((r, i) => r !== (i < hr ? head.rows[i] : more[i - hr]));
  // (the pieces of a table with a cut row are not row ranges of it: they are cut again from the whole table)
  if (!cut) origins.set(out, [...((origins.get(head) as Origin<TableNode>) ?? [{ a: 0, b: hr, piece: head }]), { a: hr, b: hr + more.length, piece: cont }]);
  if (!m) tableJoinMemo.set(head, (m = new WeakMap()));
  m.set(cont, out);
  return out;
}

/** Tables split across pages (flowCont) joined again; other items as they are. */
export function joinTables<T extends SceneNode>(nodes: readonly T[]): T[] {
  const out: T[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (n.type === "TABLE" && n.flowCont && prev?.type === "TABLE" && prev.id === n.flowCont) out[out.length - 1] = joinTable(prev, n) as T;
    else out.push(n);
  }
  // (a cut row whose continuation is gone — its piece deleted: the first part is the row)
  return out.map((n) => (n.type === "TABLE" ? (endCut(n) as T) : n));
}

/**
 * Where the cell edge of a table starts in a text column `w` wide (TableNode.wordAlign), as Word 2021 PDFs show it:
 * centred, the table is the columns plus the outer half of its left border (cell edge = (w − columns) / 2 + left / 4 —
 * 4.5 pt border: 1.13 pt right of the plain centre); set right, the cell edge is half that border left of
 * w − columns (the right border not counted: 3 pt border, 0.05 pt off).
 */
export function tableShift(n: TableNode, w: number): number {
  const a = n.wordAlign;
  // (set left: w:tblInd, TableNode.wordInd — a negative indent puts the table into the left margin)
  const cols = n.colWidths.reduce((s, c) => s + c, 0);
  // (QA docx-flow: however far the indent, a little of the table stays over the text column, where it can be reached)
  if (!a) return n.wordInd ? Math.max(Math.min(0, 16 - cols), Math.min(Math.max(0, w - 16), n.wordInd)) : 0;
  const x = a.jc === "center" ? (w - cols) / 2 + a.left / 4 : w - cols - a.left / 2;
  // (a table wider than the column: Word centres it across both margins, or sets it into the left one — Word PDF:
  // a 600 pt table in a 523 pt column starts 38 pt left of the column centred, 77 pt set right)
  return Math.round(x * 100) / 100;
}

const tablePieceMemo = new WeakMap<TableNode, Map<string, TableNode>>();
function tablePiece(full: TableNode, r0: number, r1: number, header: number): TableNode {
  if (r0 <= header && r1 >= full.rows.length) return full;
  const key = `${r0}:${r1}`;
  let m = tablePieceMemo.get(full);
  const hit = m?.get(key);
  if (hit) return hit;
  const rows = r0 <= header ? full.rows.slice(0, r1) : header ? [full.rows[0], ...full.rows.slice(r0, r1)] : full.rows.slice(r0, r1);
  let out: TableNode = r0 <= header ? { ...full, rows } : { ...full, id: `${full.id}~${r0}`, rows, flowCont: full.id };
  // cut where it was cut before: the piece already on the page (its place is set when it is placed)
  const was = originOf<TableNode>(full, r0 <= header ? 0 : r0, r1);
  if (was && sameFields(was, out, ["rows", "transform"]) && was.rows.length === rows.length && was.rows.every((r, i) => r === rows[i])) out = was;
  if (!m) tablePieceMemo.set(full, (m = new Map()));
  m.set(key, out);
  return out;
}

const cutPieceMemo = new WeakMap<TableNode, TableNode>();
/** A piece whose last row goes on in the next piece (TableNode.cutRow). */
function cutPiece(p: TableNode): TableNode {
  let v = cutPieceMemo.get(p);
  if (!v) cutPieceMemo.set(p, (v = { ...p, cutRow: true }));
  return v;
}

const cutMemo = new WeakMap<TableNode, Map<string, TableNode>>();
/**
 * 한글's '쪽 경계에서 나눔' (TableNode.cellBox.cut): row `r` of `t` cut between lines so that its first part is at most
 * `room` high — a table with the row replaced by its two parts (the first keeps the cells' own heights, the second
 * none; a cell whose lines all fit has an empty second part). Null when the row cannot be cut there: no line of any
 * cell fits, every line does, a cell spans rows or is drawn from its text (edited), or Word's cell model.
 * (omni-hwp-tables PDF: 한글 ends page 2 with the first two lines of row 11, the cells set in the middle with them.)
 */
function cutRowAt(t: TableNode, r: number, room: number): TableNode | null {
  const box = t.cellBox;
  if (!box?.cut || box.word || r < 0 || r >= t.rows.length) return null;
  const cover = coverMap(t.rows);
  const row = t.rows[r];
  // (a cell over rows, or one this row is covered by from above: rows move whole)
  for (let c = 0; c < row.length; c++) {
    const cv = cover[r][c];
    if ((cv && cv.r !== r) || (row[c].rowSpan ?? 1) > 1 || cover[r + 1]?.[c]?.r === r) return null;
  }
  const lay = layoutTable(t);
  // lines of each drawn cell that fit (its glyph box from the top, with the cell's margins above and below)
  const ks: number[] = [];
  const cells: { c: number; node: TextNode | null; n: number }[] = [];
  for (let c = 0; c < row.length; c++) {
    if (cover[r][c]) continue;
    const node = lay.rich?.[r]?.[c] ?? null;
    if (!node) {
      if (row[c].text) return null;
      cells.push({ c, node, n: 0 });
      ks.push(0);
      continue;
    }
    const lines = layoutText(node).lines;
    const top = richBox(node).top;
    let k = lines.length;
    while (k > 0) {
      const l = lines[k - 1];
      const size = l.pieces.length ? Math.max(...l.pieces.map((p) => p.run.fontSize)) : node.paragraphs[l.paragraph]?.runs[0]?.fontSize ?? 1;
      if (l.y + l.baseline + size * 0.2 - top + box.padY * 2 <= room + 0.01) break;
      k--;
    }
    cells.push({ c, node, n: lines.length });
    ks.push(k);
  }
  if (ks.every((k) => k === 0) || cells.every((x, i) => ks[i] >= x.n)) return null;
  const key = `${r}:${ks.join(",")}`;
  let m = cutMemo.get(t);
  const hit = m?.get(key);
  if (hit !== undefined) return hit;
  const a: TableCell[] = row.map((x) => x);
  const b: TableCell[] = row.map((x) => {
    const { minHeight: _m, ...rest } = x;
    return { ...rest, text: "", richText: [] };
  });
  cells.forEach(({ c, node, n }, i) => {
    const k = ks[i];
    const cell = row[c];
    const { minHeight: _m, ...rest } = cell;
    if (!node || k >= n) return; // all of it in the first part
    if (k === 0) {
      a[c] = { ...cell, text: "", richText: [] };
      b[c] = rest;
      return;
    }
    // the paragraph and character the first line left over starts at
    const lines = layoutText(node).lines;
    const qi = lines[k].paragraph;
    const ps = node.paragraphs;
    const p = ps[qi];
    const nth = lines.slice(0, k).filter((l) => l.paragraph === qi).length;
    const off = nth ? lineStarts(p, lines, qi)[nth] : 0;
    const len = p.runs.reduce((s, x) => s + x.text.length, 0);
    const pa = [...ps.slice(0, qi), ...(off > 0 ? [pieceOf(p, 0, off, len)] : [])];
    const pb = [...(off > 0 ? [pieceOf(p, off, len, len)] : [p]), ...ps.slice(qi + 1)];
    const text = (q: TextParagraph[]) => q.map((x) => x.runs.map((y) => y.text).join("")).join("\n");
    a[c] = { ...cell, text: text(pa), richText: pa };
    b[c] = { ...rest, text: text(pb), richText: pb };
  });
  // the parts marked as this cut's (TableCell.cutA / cutB: joinTable joins these two only; a rest cut again is the
  // first part of the next cut as well)
  const ma = a.map((x) => ({ ...x, cutA: r }));
  const mb = b.map((x) => {
    const { cutA: _a, ...y } = x;
    return { ...y, cutB: r };
  });
  let out: TableNode | null = { ...t, rows: [...t.rows.slice(0, r), ma, mb, ...t.rows.slice(r + 1)] };
  // (the first part with the cells' own heights from the file must still fit)
  const l2 = layoutTable(out);
  if (l2.rowY[r + 1] - l2.rowY[r] > room + 0.01) out = null;
  if (!m) cutMemo.set(t, (m = new Map()));
  m.set(key, out as TableNode);
  return out;
}

// ───────── story ─────────

export interface StoryObj {
  node: SceneNode;
  /** id of the paragraph the object stands before; STORY_END = after the last paragraph */
  before: string;
}

/**
 * Anchor of objects after the story's last paragraph (a document ending in a picture, a table or a picture-only
 * paragraph that the import made the picture itself): no empty paragraph is made up for them, so flowing an unedited
 * Word / 한글 file adds nothing to it and the Office Surgeon saves the original bytes.
 */
export const STORY_END = "";

export interface Story {
  paras: TextParagraph[];
  objs: StoryObj[];
  /** the text frame the paragraphs take their frame settings from (word break, list definitions) */
  proto: TextNode | null;
  lists: ListDef[] | undefined;
  /** objects in the text like characters (runs with `obj`): the nodes, by id */
  inline?: Map<string, SceneNode>;
}

/** Ids of the inline objects (그림 글자처럼) the paragraphs hold. */
function inlineIds(paras: readonly TextParagraph[]): Set<string> {
  const out = new Set<string>();
  for (const p of paras) for (const r of p.runs) if (r.obj) out.add(r.obj.id);
  return out;
}

/** Drawn size of an object node (its box × its scale). */
export function objSize(n: SceneNode): { w: number; h: number } {
  const k = Math.abs(n.transform.scale), ky = Math.abs(n.transform.scaleY ?? n.transform.scale);
  const b = n as { width?: number; height?: number };
  return { w: (b.width ?? 0) * k, h: (b.height ?? 0) * ky };
}

/** Reading order of a page's body nodes: column by column (Page.columns), top to bottom, left to right. */
export const nodeOrder = (a: SceneNode, b: SceneNode) => (a.flowCol ?? 0) - (b.flowCol ?? 0) || a.transform.y - b.transform.y || a.transform.x - b.transform.x;
const flowSort = nodeOrder;

const storyMemo = new WeakMap<readonly Page[], Map<number, Story>>();

/** The story of a page run: its flow frames' paragraphs (pieces joined) and flow objects anchored before a paragraph. */
export function gatherStory(pages: readonly Page[], seg: Segment): Story {
  let m = storyMemo.get(pages);
  const hit = m?.get(seg.start);
  if (hit) return hit;
  const raw: TextParagraph[] = [];
  const objs: StoryObj[] = [];
  let pending: SceneNode[] = [];
  let proto: TextNode | null = null;
  const lists = new Map<string, ListDef>();
  const all: SceneNode[] = [];
  for (let i = seg.start; i < seg.end; i++) all.push(...pages[i].nodes.filter(isFlowNode).sort(flowSort));
  // objects in the text like characters travel with their runs, not as blocks
  const ids = inlineIds(all.flatMap((n) => (n.type === "TEXT" ? n.paragraphs : [])));
  const inline = new Map<string, SceneNode>();
  const items: SceneNode[] = [];
  for (const n of all) {
    if (ids.has(n.id)) inline.set(n.id, n);
    else items.push(n);
  }
  for (const n of joinTables(items)) {
    if (n.type === "TEXT") {
      if (!proto) proto = n;
      for (const d of n.lists ?? []) if (!lists.has(d.id)) lists.set(d.id, d);
      for (const p of n.paragraphs) {
        raw.push(p);
        if (pending.length && !p.flowCont) {
          for (const o of pending) objs.push({ node: o, before: p.id });
          pending = [];
        }
      }
    } else pending.push(n);
  }
  const paras = joinPieces(raw);
  if (paras.length) for (const o of pending) objs.push({ node: o, before: STORY_END });
  else {
    // a run with no text at all: one empty paragraph to type into
    const empty: TextParagraph = { id: uid("p"), runs: [{ text: "", fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#1d1f24" }], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 6 };
    paras.push(empty);
    for (const o of pending) objs.push({ node: o, before: empty.id });
  }
  // a resized inline object: its run takes the new size (the line makes room for it)
  if (inline.size)
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      if (!p.runs.some((r) => r.obj && inline.has(r.obj.id))) continue;
      let changed = false;
      const runs = p.runs.map((r) => {
        const n = r.obj && inline.get(r.obj.id);
        if (!n || !r.obj) return r;
        const s = objSize(n);
        if (Math.abs(s.w - r.obj.w) < 0.01 && Math.abs(s.h - r.obj.h) < 0.01) return r;
        changed = true;
        return { ...r, obj: { ...r.obj, w: s.w, h: s.h } };
      });
      if (changed) paras[i] = { ...p, runs };
    }
  const story: Story = { paras, objs, proto, lists: lists.size ? [...lists.values()] : undefined, inline };
  if (!m) storyMemo.set(pages, (m = new Map()));
  m.set(seg.start, story);
  return story;
}

/** Objects anchored again after an edit that may have removed their paragraph: before the paragraph now at its place. */
export function reanchor(objs: readonly StoryObj[], oldParas: readonly TextParagraph[], paras: readonly TextParagraph[]): StoryObj[] {
  if (!objs.length) return [];
  const ids = new Set(paras.map((p) => p.id));
  return objs.map((o) => {
    if (o.before === STORY_END || ids.has(o.before)) return o;
    const at = oldParas.findIndex((p) => p.id === o.before);
    const p = paras[Math.max(0, Math.min(paras.length - 1, at < 0 ? paras.length - 1 : at))];
    return { node: o.node, before: p.id };
  });
}

/**
 * Where the text of `oldParas` went in `paras` (an edit of the story: letters typed or deleted, paragraphs split or
 * joined): a picture's place in its paragraph (ImageNode.place: the paragraph's id and the letters before it — a list's
 * number, note marks and objects in the line not counted) after the edit. The paragraphs left as they were (same id,
 * same text) hold their pictures; between them, the text then and now (each paragraph opened by a mark of its id) is
 * compared from both ends, and a place in the text that changed goes to its start — a place where text was only added
 * goes with the text after it, as in Word, where the picture is a character: Enter or letters typed right before it put
 * it after them (a split paragraph's second part; Enter at a paragraph's start: the paragraph with its letters). Enter
 * at a paragraph's end leaves it in that paragraph (the new one is added after the paragraph, unchanged). Paragraphs
 * joined: their pictures go into the joined one, after the letters before them. null: nothing to follow.
 */
export function followParas(oldParas: readonly TextParagraph[], paras: readonly TextParagraph[]): ((para: string, offset: number) => { para: string; offset: number } | null) | null {
  if (oldParas === paras || !paras.length) return null;
  const newAt = new Map<string, number>();
  paras.forEach((p, j) => newAt.set(p.id, j));
  // the paragraphs left as they were, in order (ids are unique: a paragraph kept has its id, a new one a new id)
  const anchorOld: number[] = [], anchorNew: number[] = [];
  let lastJ = -1;
  oldParas.forEach((p, i) => {
    const j = newAt.get(p.id);
    if (j === undefined || j <= lastJ || (paras[j] !== p && textOf(paras[j]) !== textOf(p))) return;
    anchorOld.push(i), anchorNew.push(j), (lastJ = j);
  });
  if (anchorOld.length === oldParas.length && oldParas.length === paras.length) return null;
  /** for each paragraph of a list, its stretch: the anchors before and after it (indexes into anchorOld / anchorNew) */
  const oldAnchor = new Map<number, number>();
  anchorOld.forEach((i, k) => oldAnchor.set(i, k));
  const cache = new Map<number, { map: (r: number, i: number) => { p: number; o: number } }>();
  const stretch = (k: number) => {
    // old paragraphs (anchorOld[k − 1], anchorOld[k]) against new (anchorNew[k − 1], anchorNew[k])
    let hit = cache.get(k);
    if (hit) return hit;
    const o0 = k > 0 ? anchorOld[k - 1] + 1 : 0, o1 = k < anchorOld.length ? anchorOld[k] : oldParas.length;
    const n0 = k > 0 ? anchorNew[k - 1] + 1 : 0, n1 = k < anchorNew.length ? anchorNew[k] : paras.length;
    const ids = new Map<string, number>();
    const tok = (id: string) => {
      let v = ids.get(id);
      if (v === undefined) ids.set(id, (v = -1 - ids.size));
      return v;
    };
    const seq = (ps: readonly TextParagraph[], a: number, b: number) => {
      const s: number[] = [], start: number[] = [];
      for (let i = a; i < b; i++) {
        s.push(tok(ps[i].id));
        start.push(s.length);
        const tx = textOf(ps[i]);
        for (let c = 0; c < tx.length; c++) s.push(tx.charCodeAt(c));
      }
      return { s, start };
    };
    const A = seq(oldParas, o0, o1), B = seq(paras, n0, n1);
    let pre = 0;
    while (pre < A.s.length && pre < B.s.length && A.s[pre] === B.s[pre]) pre++;
    let suf = 0;
    while (suf < A.s.length - pre && suf < B.s.length - pre && A.s[A.s.length - 1 - suf] === B.s[B.s.length - 1 - suf]) suf++;
    const delta = B.s.length - A.s.length;
    // between the ends that are alike (more than one change: Replace all, two paragraphs edited at once): the text kept
    // matched as a longest common subsequence, when small enough (else all of it the one change)
    const n = A.s.length - suf - pre, m = B.s.length - suf - pre;
    let kept: Int32Array | null = null;
    if (n > 0 && m > 0 && (n + 1) * (m + 1) <= 4_000_000) {
      const L = new Int32Array((n + 1) * (m + 1));
      for (let x = n - 1; x >= 0; x--)
        for (let y = m - 1; y >= 0; y--)
          L[x * (m + 1) + y] = A.s[pre + x] === B.s[pre + y] ? L[(x + 1) * (m + 1) + y + 1] + 1 : Math.max(L[(x + 1) * (m + 1) + y], L[x * (m + 1) + y + 1]);
      kept = new Int32Array(n).fill(-1);
      for (let x = 0, y = 0; x < n && y < m; ) {
        if (A.s[pre + x] === B.s[pre + y] && L[x * (m + 1) + y] === L[(x + 1) * (m + 1) + y + 1] + 1) (kept[x] = y), x++, y++;
        else if (L[(x + 1) * (m + 1) + y] >= L[x * (m + 1) + y + 1]) x++;
        else y++;
      }
    }
    hit = {
      map: (r: number, i: number) => {
        // the place in the old text, then in the new: unchanged before the change, moved with the text after it (a
        // place where text was added: after it), else the change's start (after the text kept before it)
        const g = A.start[r - o0] + i;
        let h: number;
        if (g < pre) h = g;
        else if (g >= A.s.length - suf) h = g + delta;
        else if (!kept) h = pre;
        else {
          const x = g - pre;
          let back = x - 1;
          while (back >= 0 && kept[back] < 0) back--;
          h = kept[x] >= 0 ? pre + kept[x] : pre + (back >= 0 ? kept[back] + 1 : 0);
        }
        // the paragraph it is in now: the last one opened at or before it (before the first: the end of the one before)
        let q = -1;
        for (let t = 0; t < B.start.length && B.start[t] <= h; t++) q = t;
        if (q < 0) {
          if (n0 > 0) return { p: n0 - 1, o: textOf(paras[n0 - 1]).length };
          return { p: 0, o: 0 };
        }
        return { p: n0 + q, o: h - B.start[q] };
      },
    };
    cache.set(k, hit);
    return hit;
  };
  const oldAt = new Map<string, number>();
  oldParas.forEach((p, i) => oldAt.set(p.id, i));
  return (para, offset) => {
    const r = oldAt.get(para);
    if (r === undefined) return null;
    if (oldAnchor.has(r)) return null;
    // (the stretch the paragraph is in: the anchors around it)
    let k = 0;
    while (k < anchorOld.length && anchorOld[k] < r) k++;
    const at = stretch(k).map(r, letterPlace(oldParas[r], offset));
    const p = paras[at.p];
    return { para: p.id, offset: letterCount(p, at.o) };
  };
}

/** whether a run's text is letters a picture's place counts (ImageNode.place.offset): not a note's mark, nor an object */
const isLetterRun = (r: TextRun) => !r.note && !r.obj;

/** The place in a paragraph's text of the place after `k` of its letters (after its list number). */
function letterPlace(p: TextParagraph, k: number): number {
  let skip = markerLength(p);
  let o = 0, n = 0;
  if (k <= 0) return skip;
  for (const r of p.runs) {
    for (let c = 0; c < r.text.length; c++) {
      o++;
      if (skip > 0) {
        skip--;
        continue;
      }
      if (isLetterRun(r) && ++n === k) return o;
    }
  }
  return o;
}

/** The letters (as ImageNode.place counts them) before place `i` of a paragraph's text. */
function letterCount(p: TextParagraph, i: number): number {
  let skip = markerLength(p);
  let o = 0, n = 0;
  for (const r of p.runs) {
    for (let c = 0; c < r.text.length && o < i; c++) {
      o++;
      if (skip > 0) {
        skip--;
        continue;
      }
      if (isLetterRun(r)) n++;
    }
  }
  return n;
}

/**
 * The pictures of a story edited (`old` → `story`) placed again in the text (followParas): the paragraph and letters
 * ImageNode.place says they are in — the objects of the story (and the block's anchor: one right after its paragraph
 * stays right after it) and the free pictures anchored in its paragraphs (`free`, a floating one: its anchor follows its
 * paragraph as in Word; it stays where it is drawn). Objects in the line (runs with `obj`) follow their runs already.
 */
function followPictures(old: Story, story: Story, free: readonly SceneNode[]): { story: Story; free: Map<SceneNode, SceneNode> } {
  const out = new Map<SceneNode, SceneNode>();
  const placed = (n: SceneNode) => (n.type === "IMAGE" && n.place?.para && !story.inline?.has(n.id) ? n.place : undefined);
  if (!story.objs.some((o) => placed(o.node)) && !free.some(placed)) return { story, free: out };
  const f = followParas(old.paras, story.paras);
  if (!f) return { story, free: out };
  const moved = (n: SceneNode): SceneNode => {
    const pl = placed(n);
    if (!pl || n.type !== "IMAGE") return n;
    // (a picture in a paragraph of its own after `para`: where that paragraph's end went)
    const at = f(pl.para!, pl.own ? Number.MAX_SAFE_INTEGER : pl.offset ?? 0);
    if (!at) return n;
    const offset = pl.own ? pl.offset ?? 0 : at.offset;
    if (at.para === pl.para && offset === pl.offset) return n;
    return { ...n, place: { ...pl, para: at.para, ...(pl.offset !== undefined || offset ? { offset } : {}) } };
  };
  const oldNext = new Map<string, string>();
  old.paras.forEach((p, i) => oldNext.set(p.id, old.paras[i + 1]?.id ?? STORY_END));
  const newNext = new Map<string, string>();
  story.paras.forEach((p, i) => newNext.set(p.id, story.paras[i + 1]?.id ?? STORY_END));
  let changed = false;
  const objs = story.objs.map((o) => {
    const n = moved(o.node);
    const pl = placed(o.node);
    if (!pl) return o;
    const was = pl.para!, now = (n as { place?: { para?: string } }).place?.para ?? was;
    // (a block right after its paragraph as opened: right after the paragraph it is in now — one in a paragraph of its
    // own after `para` only when that paragraph went elsewhere: a paragraph added after `para` comes before it, as in Word)
    const after = oldNext.has(was) && o.before === oldNext.get(was) && (!pl.own || now !== was);
    const before = after ? newNext.get(now) ?? o.before : o.before;
    if (n === o.node && before === o.before) return o;
    changed = true;
    return { node: n, before };
  });
  for (const n of free) {
    const m = moved(n);
    if (m !== n) out.set(n, m);
  }
  return { story: changed ? { ...story, objs } : story, free: out };
}

// ───────── paragraph layout (cached per paragraph object) ─────────

export interface ParaLay {
  lay: TextLayout;
  /** character offset where each line starts, and the paragraph's length at the end */
  starts: number[];
  len: number;
}

const paraMemo = new WeakMap<TextParagraph, { w: number; wb: string; epoch: number; v: ParaLay }>();

/** The text frame settings a paragraph is laid out with (as the frame it lands in lays it out). */
export type FrameOpts = Pick<TextNode, "wordBreak" | "cjkSpace" | "hangPunct" | "justifyShrink" | "autoSpace">;
const optsKey = (o: FrameOpts) => `${o.wordBreak}|${o.cjkSpace ?? ""}|${o.hangPunct ? 1 : 0}|${o.justifyShrink ? 1 : 0}|${o.autoSpace ? `${o.autoSpace.alpha ? 1 : 0}${o.autoSpace.digit ? 1 : 0}` : ""}`;
/** The frame settings of a story's frames (the first frame's). */
export function frameOpts(proto: TextNode | null): FrameOpts {
  const o: FrameOpts = { wordBreak: proto?.wordBreak ?? "keep-all" };
  if (proto?.cjkSpace) o.cjkSpace = proto.cjkSpace;
  if (proto?.hangPunct) o.hangPunct = true;
  if (proto?.justifyShrink) o.justifyShrink = true;
  if (proto?.autoSpace) o.autoSpace = proto.autoSpace;
  return o;
}

/** Character offset of every line start of paragraph `qi` laid out in `lines` (all lines of a frame). */
export function lineStarts(p: TextParagraph, lines: readonly LaidLine[], qi: number): number[] {
  const text = textOf(p);
  const out: number[] = [];
  let o = 0;
  for (const ln of lines) {
    if (ln.paragraph !== qi) continue;
    out.push(o);
    for (const pc of ln.pieces) o += pc.text.length;
    if (text[o] === "\n") o++;
  }
  return out;
}

export function layPara(p: TextParagraph, width: number, frame: FrameOpts | TextNode["wordBreak"]): ParaLay {
  const opts: FrameOpts = typeof frame === "string" ? { wordBreak: frame } : frame;
  const key = optsKey(opts);
  const epoch = textMetricsEpoch();
  const hit = paraMemo.get(p);
  if (hit && hit.w === width && hit.wb === key && hit.epoch === epoch) return hit.v;
  const node = { type: "TEXT", width, paragraphs: [p], ...opts } as TextNode;
  const lay = layoutText(node);
  const v: ParaLay = { lay, starts: lineStarts(p, lay.lines, 0), len: textOf(p).length };
  paraMemo.set(p, { w: width, wb: key, epoch, v });
  return v;
}

// ───────── pagination ─────────

/**
 * The part of an object the flow stacks: a cropped picture shows only its crop, which starts `dy` below the node's
 * own top (transform.y) and is `h` high.
 */
function visBox(n: SceneNode): { dy: number; h: number } {
  if (n.type === "IMAGE" && n.crop && !n.transform.rotation) {
    const ky = Math.abs(n.transform.scaleY ?? n.transform.scale);
    return { dy: n.crop.y * ky, h: n.crop.h * ky };
  }
  return { dy: 0, h: flowHeight(n) };
}

/** Gap below a table and below a picture in the body flow (as the importers place them). */
export const TABLE_GAP = 10;
export const OBJECT_GAP = 8;
/** Gap below a table: none in Word (the next paragraph starts under the bottom border line), TABLE_GAP otherwise. */
export const tableGap = (n: Pick<TableNode, "cellBox">) => (n.cellBox?.word ? n.cellBox.word.border / 2 : TABLE_GAP);

/**
 * The lines at which 한글 began a page in a paragraph whose saved lines are the ones laid out (TextParagraph.hwpLines
 * with `page`), else null (the flow decides).
 */
function hwpPages(p: TextParagraph, pl: ParaLay): number[] | null {
  const h = p.hwpLines;
  if (!h?.page || h.sig !== hwpLinesSig(p)) return null;
  // the laid-out lines are 한글's (its breaks applied: the box is as wide as its lines)
  if (pl.starts.length !== h.at.length + 1 || h.at.some((x, i) => pl.starts[i + 1] !== x)) return null;
  return h.page;
}

/** A note as laid out: the note and the mark its reference shows. */
export interface NoteItem {
  note: NoteRef;
  mark: string;
}

type Placed =
  | { kind: "para"; p: TextParagraph; y: number; h: number }
  | { kind: "obj"; node: SceneNode; y: number; h: number }
  /** the footnotes at the foot of the page: their paragraphs (pieces of a note cut at the page end too), height with the separator */
  | { kind: "foot"; paras: TextParagraph[]; h: number; sep: SepGeom }
  /** endnote paragraphs after the story's end (the first with the separator above it) */
  | { kind: "end"; p: TextParagraph; y: number; h: number; sep?: SepGeom };

interface PageGeom {
  box: { x: number; y: number; w: number; h: number };
  /** the column of the page this box is (0 = the first; a section of several columns lays out column by column) */
  col?: number;
}

export interface NoteOpts {
  pr?: NotePr;
  /** endnotes to set after the story's last block (the document's last page run) */
  end?: NoteItem[];
  /**
   * the run's first page follows a hard page break (not the document's start or a new section): with Word's spacing
   * (TextNode.wordSpacing) a paragraph at its top loses its space before, as on every page after the first
   */
  afterBreak?: boolean;
  /**
   * the run's first page begins a new section: the last body paragraph of the section before (TextNode.wordSpacing
   * "max": the space before at the top of the new section loses what this one's space after already gives — Word 2021
   * PDF omni-fid-spacing-sect: after 4 / 30 / 10 pt, before 20 pt → 16 / 0 / 10 pt)
   */
  sectionAfter?: TextParagraph;
}

const lineNotesMemo = new WeakMap<TextParagraph, { starts: number[]; v: NoteItem[][] }>();
/** The footnotes whose references are on each line of a laid-out paragraph. */
function lineNotes(p: TextParagraph, starts: number[]): NoteItem[][] {
  const hit = lineNotesMemo.get(p);
  if (hit && hit.starts === starts) return hit.v;
  const v: NoteItem[][] = starts.map(() => []);
  for (const { o, note, run } of notesOf(p)) {
    if (note.kind !== "foot") continue;
    let li = 0;
    while (li + 1 < starts.length && starts[li + 1] <= o) li++;
    v[li].push({ note, mark: run.text });
  }
  lineNotesMemo.set(p, { starts, v });
  return v;
}

/**
 * Lay a story out onto pages: returns, per page, the paragraph pieces and objects with their y inside the body box,
 * and the page's footnotes. `geom(k)` gives page k's body box (pages past the existing ones repeat the last).
 */
export function paginateStory(story: Story, geom: (k: number) => PageGeom, notes: NoteOpts = {}): Placed[][] {
  const wb = frameOpts(story.proto);
  const ws = story.proto?.wordSpacing;
  const out: Placed[][] = [[]];
  let k = 0;
  let y = 0;
  /**
   * Where the head of paragraph `p` goes (Word's spacing, TextNode.wordSpacing): at the top of a page after a page break
   * its space before is left above the body (Word drops it), below a paragraph of the same frame it overlaps that one's
   * space after ("max").
   */
  const headY = (p: TextParagraph): number => {
    if (!ws) return y;
    if (y === 0 && !out[k].some((it) => it.kind !== "foot")) {
      if (k > 0 || notes.afterBreak) return -(p.spaceBefore ?? 0);
      return notes.sectionAfter ? -spacingOverlap(story.proto!, notes.sectionAfter, p) : 0;
    }
    const prev = out[k][out[k].length - 1];
    return prev?.kind === "para" ? y - spacingOverlap(story.proto!, prev.p, p) : y;
  };
  let box = geom(0).box;
  // footnotes of the page being filled: their paragraphs and height; `cont` = going on from the page before
  const footPr = notes.pr?.foot;
  let fParas: TextParagraph[] = [];
  let fH = 0;
  let fCont = false;
  const parasH = (ps: readonly TextParagraph[]) => ps.reduce((s, q) => s + layPara(q, box.w, wb).lay.height, 0);
  const sepOf = (cont: boolean, pr = footPr) => sepGeom(pr, box.w, cont, pr?.para ? layPara(pr.para, box.w, wb).lay.height : undefined);
  /** room the footnotes take with `extra` more of them (their separator included) */
  const area = (extra: number) => (fH + extra > 0 ? fH + extra + sepOf(fCont).h : 0);
  const itemsH = (its: readonly NoteItem[]) => its.reduce((s, it) => s + parasH(noteBody(it.note, it.mark)), 0);
  /** the footnotes go to the foot of the page; what does not fit below the body goes on at the foot of the next */
  const closeFoot = () => {
    if (!fParas.length) return;
    const sep = sepOf(fCont);
    const room = box.h - y - sep.h;
    let carry: TextParagraph[] = [];
    let keep = fParas;
    if (fH > room + 0.01) {
      keep = [];
      let used = 0;
      for (let i = 0; i < fParas.length; i++) {
        const q = fParas[i];
        const pl = layPara(q, box.w, wb);
        if (used + pl.lay.height <= room + 0.01) {
          keep.push(q);
          used += pl.lay.height;
          continue;
        }
        // cut the note paragraph between lines (at least one line stays when nothing else is here)
        const ls = pl.lay.lines;
        let fit = 0;
        while (fit < ls.length && used + ls[fit].y + ls[fit].height <= room + 0.01) fit++;
        if (!fit && !keep.length) fit = 1;
        if (fit > 0 && fit < ls.length) {
          keep.push(pieceOf(q, 0, pl.starts[fit], pl.len));
          carry = [pieceOf(q, pl.starts[fit], pl.len, pl.len), ...fParas.slice(i + 1)];
        } else if (fit >= ls.length) {
          keep.push(q);
          carry = fParas.slice(i + 1);
        } else carry = fParas.slice(i);
        break;
      }
    }
    out[k].push({ kind: "foot", paras: keep, h: parasH(keep) + sep.h, sep });
    fParas = carry;
    fH = parasH(carry);
    fCont = carry.length > 0;
  };
  const newPage = () => {
    closeFoot();
    out.push([]);
    k++;
    y = 0;
    box = geom(k).box;
    if (fParas.length) fH = parasH(fParas);
  };
  const addFoot = (its: readonly NoteItem[]) => {
    for (const it of its) {
      const ps = noteBody(it.note, it.mark);
      fParas.push(...ps);
      fH += parasH(ps);
    }
  };
  // the block sequence: objects before their paragraph
  type Block = { kind: "para"; p: TextParagraph } | { kind: "obj"; node: SceneNode };
  const blocks: Block[] = [];
  const before = new Map<string, SceneNode[]>();
  for (const o of story.objs) {
    const l = before.get(o.before);
    if (l) l.push(o.node);
    else before.set(o.before, [o.node]);
  }
  for (const p of story.paras) {
    for (const n of before.get(p.id) ?? []) blocks.push({ kind: "obj", node: n });
    blocks.push({ kind: "para", p });
  }
  for (const n of before.get(STORY_END) ?? []) blocks.push({ kind: "obj", node: n });

  // Word's keep with next in a table (Word's rules only, TextNode.wordSpacing): a row whose cells' paragraphs are all kept
  // with the next stays with the row after it, and a table whose rows all are, with what follows the table (Word PDF:
  // a heading, a table of such rows and the heading and picture after it go to the next page together)
  const keptRows = new Map<TableNode, number>();
  const keepRows = (t: TableNode): number => {
    let k = keptRows.get(t);
    if (k === undefined) {
      k = 0;
      if (ws)
        while (k < t.rows.length) {
          const ps = t.rows[k].flatMap((c) => richOf(c) ?? []);
          if (!ps.length || !ps.every((q) => q.keepNext)) break;
          k++;
        }
      keptRows.set(t, k);
    }
    return k;
  };
  const keepsOn = (b: Block): boolean => (b.kind === "para" ? !!b.p.keepNext : b.node.type === "TABLE" && b.node.rows.length > 0 && keepRows(b.node) === b.node.rows.length);
  // height a block needs at least at the bottom of a page (the first lines a paragraph may leave there)
  const firstNeed = (b: Block | undefined): number => {
    if (!b) return 0;
    if (b.kind === "obj") {
      if (b.node.type === "TABLE") {
        const l = layoutTable(b.node);
        const rows = Math.max(b.node.headerRow && b.node.rows.length > 1 ? 2 : 1, keepRows(b.node) + 1);
        return l.rowY[Math.min(b.node.rows.length, rows)];
      }
      return visBox(b.node).h;
    }
    const pl = layPara(b.p, box.w, wb);
    const lines = pl.lay.lines;
    const n = b.p.keepLines ? lines.length : b.p.widowControl === false ? 1 : Math.min(lines.length, 2);
    const last = lines[Math.max(0, n - 1)];
    return last ? last.y + last.height : pl.lay.height;
  };
  /**
   * Height the chain of blocks kept with the next from block `from` needs on one page (`need` so far): those blocks whole
   * and the first lines of the block after them. (Word's spacing: each paragraph's space before overlapping the one
   * before it, as the flow will place them.)
   */
  const chainNeed = (from: number, need: number): number => {
    let j = from;
    let up: TextParagraph | undefined;
    while (j < blocks.length && keepsOn(blocks[j])) {
      const bj = blocks[j];
      if (bj.kind === "para") {
        if (ws && up) need -= spacingOverlap(story.proto!, up, bj.p);
        need += layPara(bj.p, box.w, wb).lay.height;
        up = bj.p;
      } else {
        const tn = bj.node as TableNode;
        need += layoutTable(tn).rowY[tn.rows.length] + tableGap(tn);
        up = undefined;
      }
      j++;
    }
    const nb = blocks[j];
    if (ws && up && nb?.kind === "para") need -= spacingOverlap(story.proto!, up, nb.p);
    return need + firstNeed(nb);
  };

  let colAfter = false; // the paragraph before ends with a column break
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi];
    if (b.kind === "obj" && colAfter) {
      if (y > 0 || out[k].some((it) => it.kind !== "foot")) newPage();
      colAfter = false;
    }
    if (b.kind === "obj") {
      const n = b.node;
      if (n.type === "TABLE") {
        // (`tbl`: the table with the rows cut at page ends so far — 한글 '쪽 경계에서 나눔', cutRowAt)
        let tbl = n;
        let lay = layoutTable(tbl);
        const header = n.headerRow && n.rows.length > 1 ? 1 : 0;
        const headH = header ? lay.rowY[1] : 0;
        // footnotes referenced in a row's cells (Word): the page keeps room for them like for a line's
        const notesOfRows = (t: TableNode) => t.rows.map((row) => row.flatMap((c) => (richOf(c) ?? []).flatMap((q) => notesOf(q).filter((x) => x.note.kind === "foot").map((x) => ({ note: x.note, mark: x.run.text })))));
        let rowNotes = notesOfRows(tbl);
        const useCut = (t: TableNode) => {
          tbl = t;
          lay = layoutTable(t);
          rowNotes = notesOfRows(t);
        };
        const rowsNotesH = (a: number, b: number) => {
          let s = 0;
          for (let i = a; i < b; i++) if (rowNotes[i].length) s += itemsH(rowNotes[i]);
          return s;
        };
        // a table kept with the next as a whole begins a chain (Word): it moves on with what it is kept with
        if (y > 0 && keepsOn(b) && !(bi > 0 && keepsOn(blocks[bi - 1]))) {
          const need = chainNeed(bi, 0);
          if (need <= box.h && y + need > box.h - area(0)) newPage();
        }
        let r = 0;
        while (r < tbl.rows.length) {
          const rowStart = r === 0 ? 0 : r;
          const head = rowStart === 0 ? 0 : headH;
          const room = box.h - y - head - area(0);
          const roomFor = (b: number) => box.h - y - head - area(rowsNotesH(rowStart, b));
          // first row (with the header) must fit, unless the page is empty
          const firstEnd = rowStart === 0 ? Math.min(tbl.rows.length, header + 1) : rowStart + 1;
          const firstH = lay.rowY[firstEnd] - lay.rowY[rowStart];
          let end = firstEnd;
          // a row cut at the page end: the piece ends with its first part, the next begins with the rest
          let cut = false;
          if (firstH > room) {
            const at = firstEnd - 1;
            const c = cutRowAt(tbl, at, roomFor(at + 1) - (lay.rowY[at] - lay.rowY[rowStart]));
            if (c) {
              useCut(c);
              cut = true;
            } else if (n.cellBox?.cut && rowStart === 0 && header && at === header && y > 0 && lay.rowY[1] <= room) {
              // (한글: the header row stays at the page end when no line of the first row fits under it — omni-hwp-tables PDF)
              end = header;
            } else if (y > 0) {
              newPage();
              continue;
            }
          } else {
            while (end < tbl.rows.length && lay.rowY[end + 1] - lay.rowY[rowStart] <= roomFor(end + 1)) end++;
            if (end < tbl.rows.length) {
              const c = cutRowAt(tbl, end, roomFor(end + 1) - (lay.rowY[end] - lay.rowY[rowStart]));
              if (c) {
                useCut(c);
                end++;
                cut = true;
              }
            }
          }
          const p0 = tablePiece(tbl, rowStart, end, header);
          const piece = cut ? cutPiece(p0) : p0;
          for (let i = rowStart; i < end; i++) if (rowNotes[i].length) addFoot(rowNotes[i]);
          const h = head + lay.rowY[end] - lay.rowY[rowStart];
          out[k].push({ kind: "obj", node: piece, y, h });
          y += h + tableGap(n);
          r = end;
          if (r < tbl.rows.length) newPage();
        }
        continue;
      }
      const h = visBox(n).h;
      // a picture in a paragraph of its own (Word / 한글 import): that paragraph's spacing around it; one that does not
      // fit goes to the next page without the room above it
      const sp = n.type === "IMAGE" ? n.place?.space : undefined;
      let pre = sp ? sp.before : 0;
      if (y + pre + h > box.h - area(0) && y > 0) {
        newPage();
        pre = 0;
      }
      out[k].push({ kind: "obj", node: n, y: y + pre, h });
      y += pre + h + (sp ? sp.after : OBJECT_GAP);
      continue;
    }

    const p = b.p;
    if (p.pageBreakBefore && (y > 0 || out[k].length) && !(k === 0 && out[0].length === 0)) {
      newPage();
      while (geom(k).col) newPage();
    }
    // 단 나누기 (Word / 한글): the next column (the next page on a page of one column)
    if ((p.colBreak === "before" || colAfter) && (y > 0 || out[k].some((it) => it.kind !== "foot"))) newPage();
    colAfter = p.colBreak === "after";
    // keep with next: the chain of paragraphs kept with the next and the first lines after them go on one page
    const prevKeeps = bi > 0 && keepsOn(blocks[bi - 1]);
    if (p.keepNext && !prevKeeps && y > 0) {
      // (Word's spacing: measured from where the chain's head goes — its space before overlapping the space after above)
      const need = chainNeed(bi, ws ? headY(p) - y : 0);
      // a chain longer than a page is not kept together (Word)
      if (need <= box.h && y + need > box.h - area(0)) newPage();
    }
    const pl = layPara(p, box.w, wb);
    const lines = pl.lay.lines;
    const n = lines.length;
    const after = p.spaceAfter;
    // 한글's pages known for this paragraph (its saved lines apply): a page begins at those lines and nowhere else
    const hp = hwpPages(p, pl);
    // footnotes referenced on each line: the page keeps room for them below the body
    const ln = hasNotes(p) ? lineNotes(p, pl.starts) : null;
    const notesH = (from: number, to: number) => {
      if (!ln) return 0;
      let h = 0;
      for (let i = from; i < to; i++) if (ln[i].length) h += itemsH(ln[i]);
      return h;
    };
    const take_ = (from: number, to: number) => {
      if (ln) for (let i = from; i < to; i++) addFoot(ln[i]);
    };
    let a = 0; // first line still to place
    // Word's multiple line spacing puts the room it adds below the text, and a page's last line may run that room past
    // the body's end (Word 2021 PDF: a 1.35 line of 10.5 pt 맑은 고딕 whose text ends 3.4 pt above the bottom margin
    // stays, though its line ends 3 pt below it): the line fits when its single line does
    const wm = ws ? wordMultipleOf(p) : undefined;
    const below = (i: number) => (wm && wm > 1 && i >= 0 && i < n ? lines[i].height * (1 - 1 / wm) : 0);
    if (hp) {
      if (hp.includes(0) && (y > 0 || out[k].some((it) => it.kind !== "foot"))) newPage();
      for (;;) {
        const top = a === 0 ? 0 : lines[a].y;
        const b2 = hp.find((x) => x > a) ?? n;
        const h = (b2 > 0 && n ? lines[b2 - 1].y + lines[b2 - 1].height : pl.lay.height - after) - top + (b2 >= n ? after : 0);
        out[k].push({ kind: "para", p: pieceOf(p, a ? pl.starts[a] : 0, b2 >= n ? pl.len : pl.starts[b2], pl.len), y, h });
        take_(a, b2);
        y += h;
        if (b2 >= n) break;
        a = b2;
        newPage();
      }
      continue;
    }
    for (;;) {
      if (a === 0) y = headY(p);
      const top = a === 0 ? 0 : lines[a].y; // the piece starts at its first line (space before only on the head)
      const restH = (n ? lines[n - 1].y + lines[n - 1].height : pl.lay.height - after) - top;
      const room = box.h - y;
      if (restH - below(n - 1) + area(notesH(a, n)) <= room + 0.01) {
        const h = restH + after;
        out[k].push({ kind: "para", p: pieceOf(p, a ? pl.starts[a] : 0, pl.len, pl.len), y, h });
        take_(a, n);
        y += h;
        break;
      }
      // lines that fit
      let fit = a;
      while (fit < n && lines[fit].y + lines[fit].height - below(fit) - top + area(notesH(a, fit + 1)) <= room + 0.01) fit++;
      let take = fit - a;
      const left = n - a;
      if (p.keepLines && y > 0) take = 0;
      else if (p.widowControl !== false) {
        if (n - fit < 2 && take > 0) take = Math.max(0, n - 2 - a); // leave two lines for the next page
        if (take < 2 && left > 1) take = 0; // never one line alone at the bottom
      }
      if (take <= 0) {
        if (y > 0 || out[k].length) {
          newPage();
          continue;
        }
        // an empty page that cannot hold it: place what fits (at least one line)
        take = Math.max(1, fit - a);
        if (a + take >= n) {
          out[k].push({ kind: "para", p: pieceOf(p, a ? pl.starts[a] : 0, pl.len, pl.len), y, h: restH + after });
          take_(a, n);
          y += restH + after;
          break;
        }
      }
      const b2 = a + take;
      const h = lines[b2 - 1].y + lines[b2 - 1].height - top;
      out[k].push({ kind: "para", p: pieceOf(p, a ? pl.starts[a] : 0, pl.starts[b2], pl.len), y, h });
      take_(a, b2);
      y += h;
      a = b2;
      newPage();
    }
  }
  // endnotes after the end of the document: the separator, then the notes (cut between lines at page ends)
  const ends = notes.end ?? [];
  if (ends.length) {
    const endPr = notes.pr?.end;
    let sep: SepGeom | undefined = sepOf(false, endPr);
    if ((y > 0 || out[k].some((it) => it.kind !== "foot")) && (endPr?.newPage || y + sep.h > box.h - area(0))) newPage();
    for (const it of ends)
      for (const q of noteBody(it.note, it.mark)) {
        const pl = layPara(q, box.w, wb);
        const ls = pl.lay.lines;
        let a = 0;
        for (;;) {
          const pre = sep ? sep.h : 0;
          const top = a === 0 ? 0 : ls[a].y;
          const restH = (ls.length ? ls[ls.length - 1].y + ls[ls.length - 1].height : pl.lay.height - q.spaceAfter) - top;
          const room = box.h - area(0) - y - pre;
          if (restH <= room + 0.01) {
            out[k].push({ kind: "end", p: pieceOf(q, a ? pl.starts[a] : 0, pl.len, pl.len), y: y + pre, h: restH + q.spaceAfter, ...(sep ? { sep } : {}) });
            y += pre + restH + q.spaceAfter;
            sep = undefined;
            break;
          }
          let fit = a;
          while (fit < ls.length && ls[fit].y + ls[fit].height - top <= room + 0.01) fit++;
          if (fit === a) {
            if (y > 0 || out[k].length) {
              newPage();
              continue;
            }
            fit = a + 1;
          }
          if (fit >= ls.length) {
            out[k].push({ kind: "end", p: pieceOf(q, a ? pl.starts[a] : 0, pl.len, pl.len), y: y + pre, h: restH + q.spaceAfter, ...(sep ? { sep } : {}) });
            y += pre + restH + q.spaceAfter;
            sep = undefined;
            break;
          }
          const h = ls[fit - 1].y + ls[fit - 1].height - top;
          out[k].push({ kind: "end", p: pieceOf(q, a ? pl.starts[a] : 0, pl.starts[fit], pl.len), y: y + pre, h, ...(sep ? { sep } : {}) });
          sep = undefined;
          a = fit;
          newPage();
        }
      }
  }
  // footnotes of the last page (and of the pages they go on to)
  closeFoot();
  while (fParas.length) {
    out.push([]);
    k++;
    y = 0;
    box = geom(k).box;
    fH = parasH(fParas);
    closeFoot();
  }
  return out;
}
// ───────── writing the layout onto pages ─────────

const placedMemo = new WeakMap<SceneNode, Map<string, SceneNode>>();
function placed<T extends SceneNode>(n: T, x: number, y: number): T {
  if (n.transform.x === x && n.transform.y === y && n.flow) return n;
  const key = `${x},${y}`;
  let m = placedMemo.get(n);
  const hit = m?.get(key);
  if (hit) return hit as T;
  const out = { ...n, flow: true, transform: { ...n.transform, x, y } } as T;
  if (!m) placedMemo.set(n, (m = new Map()));
  m.set(key, out);
  return out;
}

function frameFor(old: TextNode | undefined, proto: TextNode | null, lists: ListDef[] | undefined, paras: TextParagraph[], x: number, y: number, w: number): TextNode {
  if (
    old &&
    old.flow &&
    old.width === w &&
    old.transform.x === x &&
    old.transform.y === y &&
    old.lists === lists &&
    old.paragraphs.length === paras.length &&
    old.paragraphs.every((p, i) => p === paras[i])
  )
    return old;
  const base: TextNode = old ?? proto ?? ({ type: "TEXT", name: t("engine.default.body"), visible: true, locked: false, opacity: 1, blendMode: "NORMAL", wordBreak: "keep-all", background: null } as TextNode);
  const out: TextNode = { ...base, id: old?.id ?? uid(), flow: true, width: w, paragraphs: paras, transform: { x, y, rotation: 0, scale: 1 } };
  if (lists) out.lists = lists;
  else delete out.lists;
  if (!old) {
    out.name = t("engine.default.body");
    delete out.effects;
    delete out.groupId;
    out.opacity = 1;
    out.visible = true;
  }
  return out;
}

/** A new page continuing the flow of `like` (same kind, paper, margins, background and master). */
export function flowPageLike(like: Page, n: number): Page {
  const p: Page = {
    id: uid("pg"),
    name: t("doc.pageName.DOCUMENT", { n }),
    kind: like.kind,
    width: like.width,
    height: like.height,
    background: like.background,
    nodes: [],
    masterId: like.masterId,
    transition: { ...like.transition },
    animations: [],
    breakBefore: "flow",
  };
  if (like.margins) p.margins = { ...like.margins };
  if (like.columns) p.columns = { ...like.columns };
  if (like.border) p.border = { ...like.border };
  if (like.source) {
    const { office: _o, fragments: _f, ...src } = like.source;
    p.source = src;
  }
  return p;
}

/**
 * Flow `story` (default: the run's own) through the run of pages starting at page `start`: returns the new page list
 * (the same array when nothing changed). Pages are added after the run when the story needs more, and pages the
 * story no longer reaches are removed (kept, without body, when they hold free objects).
 */
export function reflowSegment(pages: readonly Page[], start: number, story?: Story): Page[] {
  const seg = segmentAt(pages, start);
  let st = story ?? gatherStory(pages, seg);
  const segPages = pages.slice(seg.start, seg.end);
  // (doc-pic-para) an edited story: its pictures where their text went — the paragraph and letters before them
  let freeMoved: Map<SceneNode, SceneNode> | null = null;
  if (story) {
    const old = gatherStory(pages, seg);
    if (old.paras !== story.paras) {
      const r = followPictures(old, st, segPages.flatMap((p) => p.nodes.filter((n) => isFree(n) && n.type === "IMAGE")));
      st = r.story;
      if (r.free.size) freeMoved = r.free;
    }
  }
  // notes: numbered in document order (continuing from the runs before), endnotes set after the document's last run
  const pr = notePrOf(pages);
  const before = countNotes(storyParasOf(pages, 0, seg.start));
  // (footnote numbers restarted in each section: a run of flowing pages is a section's body)
  if (pr?.foot?.restart === "section") before.foot = 0;
  const had = countNotes(storyParasOf(pages, seg.start, seg.end));
  const numbered = numberNotes(st.paras, { ...before }, pr);
  if (numbered !== st.paras) st = { ...st, paras: numbered };
  const mine = countNotes(numbered);
  const lastSeg = lastSeg2(pages, seg);
  const endItems: NoteItem[] = [];
  if (lastSeg) {
    for (const q of storyParasOf(pages, 0, seg.start)) for (const x of notesOf(q)) if (x.note.kind === "end") endItems.push({ note: x.note, mark: x.run.text });
    for (const q of numbered) for (const x of notesOf(q)) if (x.note.kind === "end") endItems.push({ note: x.note, mark: x.run.text });
  }
  const last = segPages[segPages.length - 1];
  // the body box of each page: inside the margins, below a header (above a footer) that runs past them (Word)
  const boxes = segPages.map((p, k) => {
    const b = bodyBox(p);
    const push = hfPush(pages, seg.start + k);
    return push.top || push.bottom ? { x: b.x, y: b.y + push.top, w: b.w, h: Math.max(16, b.h - push.top - push.bottom) } : b;
  });
  const boxAt = (k: number) => boxes[Math.min(k, boxes.length - 1)];
  // 단 (Page.columns, the run's first page = its section's) and 이어서 구역 (TextParagraph.contSect): the story is laid
  // out region by region, each column by column; a region followed by another on the same page has its columns
  // balanced there (Word), and the next one begins below it
  const colDef = segPages[0]?.columns && segPages[0].columns.n > 1 ? segPages[0].columns : undefined;
  // (a run that begins after a hard page break: Word drops the space before at its top too)
  const afterBreak = seg.start > 0 && !pages[seg.start].breakBefore;
  // (a run that begins a new section: its top overlaps the space after of the section before's last paragraph)
  const sectionAfter = seg.start > 0 && pages[seg.start].breakBefore === "section" ? lastBodyPara(pages[seg.start - 1]) : undefined;
  // an empty paragraph that ends a part before an 이어서 구역 holds its section break: no line, as Word lays it out (and as
  // the file written from it reads again — TextParagraph.sectMark)
  // (not right after a table: Word gives that paragraph its line — Word 2021, omni-fid-table-ind with a break after its table)
  const afterTable = (q: TextParagraph) => st.objs.some((o) => o.before === q.id && o.node.type === "TABLE");
  if (st.paras.some((q, i) => i > 0 && q.contSect && !st.paras[i - 1].sectMark && st.paras[i - 1].runs.every((r) => !r.text) && !afterTable(st.paras[i - 1])))
    st = { ...st, paras: st.paras.map((q, i) => (st.paras[i + 1]?.contSect && !q.sectMark && q.runs.every((r) => !r.text) && !afterTable(q) ? { ...q, sectMark: true as const } : q)) };
  const layAll = (story: Story) => layRegions(story, colDef, boxAt, { pr, end: endItems, afterBreak, sectionAfter });
  let slots = layAll(st);
  // Word's footnote numbers restarted on each page (w:numRestart eachPage): the page a reference lands on decides its
  // number; laid out once more with those numbers when one changed
  if (pr?.foot?.restart === "page") {
    const fixed = new Map<NoteRef, number>();
    let n = pr.foot.start ?? 1;
    let pg = -1;
    for (const sl of slots) {
      if (sl.page !== pg) (pg = sl.page), (n = pr.foot.start ?? 1);
      for (const it of sl.items) if (it.kind === "para") for (const r of it.p.runs) if (r.note?.kind === "foot" && !r.note.custom && !fixed.has(r.note)) fixed.set(r.note, n++);
    }
    const again = numberNotes(st.paras, { ...before }, pr, fixed);
    if (again !== st.paras) {
      st = { ...st, paras: again };
      slots = layAll(st);
    }
  }
  const lists = sameLists(segPages, st.lists);
  const outPages: Page[] = [];
  const count = Math.max(1, ...slots.map((x) => x.page + 1));
  const objOffsets = st.inline?.size ? inlineOffsets(st.paras) : new Map<string, { para: string; offset: number }>();
  for (let k = 0; k < Math.max(count, segPages.length); k++) {
    const old = segPages[k];
    if (k >= count) {
      // past the story's end: keep a page only for its free objects
      if (old && old.nodes.some(isFree)) {
        const kept = freeMoved && old.nodes.some((n) => freeMoved!.has(n)) ? { ...old, nodes: old.nodes.map((n) => freeMoved!.get(n) ?? n) } : old;
        outPages.push(kept.nodes.some((n) => !isFree(n)) ? { ...kept, nodes: kept.nodes.filter(isFree) } : kept);
      }
      continue;
    }
    let page = old ?? flowPageLike(last, seg.start + k + 1);
    if (freeMoved && page.nodes.some((n) => freeMoved!.has(n))) page = { ...page, nodes: page.nodes.map((n) => freeMoved!.get(n) ?? n) };
    const oldFrames = page.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(flowSort);
    const flowNodes: SceneNode[] = [];
    let fi = 0;
    // note areas: the page's footnotes at the foot of the body (of each column), endnotes where they fall
    const oldNotes = new Map(page.nodes.filter((n) => n.notes).map((n) => [n.id, n]));
    const noteNodes: SceneNode[] = [];
    const bodyBottom = boxAt(k).y + boxAt(k).h;
    // the page's columns in reading order (region by region): column c of the page is TextNode.flowCol c
    const mine = slots.filter((x) => x.page === k);
    mine.forEach((sl, c) => {
      const box = sl.box;
      const sfx = c ? String(c) : "";
      const inCol = <T extends SceneNode>(n: T): T => inColumn(n, c);
      let run: TextParagraph[] = [];
      let runY = 0;
      const closeRun = () => {
        if (!run.length) return;
        flowNodes.push(inCol(frameFor(oldFrames[fi++], st.proto, lists, run, box.x, box.y + runY, box.w)));
        run = [];
      };
      let ends: TextParagraph[] = [];
      let endY = 0;
      const closeEnds = () => {
        if (!ends.length) return;
        noteNodes.push(noteFrame(`${page.id}:en${sfx}`, "end", oldNotes, st.proto, ends, box.x, box.y + endY, box.w));
        ends = [];
      };
      for (const it of sl.items) {
        if (it.kind === "para") {
          if (!run.length) runY = it.y;
          run.push(it.p);
        } else if (it.kind === "obj") {
          closeRun();
          const x = it.node.type === "TABLE" ? box.x + tableShift(it.node, box.w) : Math.max(box.x, Math.min(it.node.transform.x, box.x + box.w - 1));
          flowNodes.push(inCol(placed(it.node, x, box.y + it.y - visBox(it.node).dy)));
        } else if (it.kind === "foot") {
          // (at the foot of the page's body, also below a region whose columns were balanced higher up)
          const top = (sl.last ? bodyBottom : box.y + box.h) - it.h;
          if (it.sep.len > 0) noteNodes.push(sepNode(`${page.id}:fnsep${sfx}`, "foot", box.x, top + it.sep.lineY, it.sep, oldNotes.get(`${page.id}:fnsep${sfx}`)));
          if (it.paras.length) noteNodes.push(noteFrame(`${page.id}:fn${sfx}`, "foot", oldNotes, st.proto, it.paras, box.x, top + it.sep.h, box.w));
        } else {
          if (it.sep) {
            closeEnds();
            if (it.sep.len > 0) noteNodes.push(sepNode(`${page.id}:ensep${sfx}`, "end", box.x, box.y + it.y - it.sep.h + it.sep.lineY, it.sep, oldNotes.get(`${page.id}:ensep${sfx}`)));
          }
          if (!ends.length) endY = it.y;
          ends.push(it.p);
        }
      }
      closeRun();
      closeEnds();
    });
    // the rule between columns (Word w:sep, 한글 colLine): from the region's top on the page as far down as its columns go
    let rule = 0;
    for (const sl of mine) {
      if (!sl.rule) continue;
      noteNodes.push(colRuleNode(`${page.id}:colsep${++rule === 1 ? "1" : rule}`, sl.rule.x, sl.rule.top, sl.rule.len, oldNotes.get(`${page.id}:colsep${rule === 1 ? "1" : rule}`)));
    }
    // 쪽 테두리 (Page.border, core/pageBorder.ts): its lines, the same objects while unchanged
    for (const n of pageBorderNodes(page)) {
      const o = oldNotes.get(n.id);
      noteNodes.push(o && JSON.stringify(o) === JSON.stringify(n) ? o : n);
    }
    if (st.inline?.size) for (const fr of flowNodes.filter((n): n is TextNode => n.type === "TEXT")) placeInline(fr, st, flowNodes, objOffsets);
    // free objects keep their place in the stacking order: those below the first flow node stay below
    const firstFlow = page.nodes.findIndex(isFlowNode);
    const below = firstFlow < 0 ? [] : page.nodes.slice(0, firstFlow).filter(isFree);
    const above = page.nodes.filter((n, i) => isFree(n) && (firstFlow < 0 || i > firstFlow));
    const nodes = [...below, ...flowNodes, ...noteNodes, ...above];
    const same = old && old.nodes.length === nodes.length && old.nodes.every((n, i) => n === nodes[i]);
    outPages.push(same ? old : { ...page, nodes });
  }
  const unchanged = outPages.length === segPages.length && outPages.every((p, i) => p === segPages[i]);
  let res = unchanged ? (pages as Page[]) : [...pages.slice(0, seg.start), ...outPages, ...pages.slice(seg.end)];
  // the notes after this run count on from it: when its count changed they are numbered again, and the endnotes at
  // the document's end follow an endnote edited here
  const end = seg.start + outPages.length;
  if (end < res.length && (mine.foot !== had.foot || mine.end !== had.end || (!lastSeg && (mine.end || had.end)))) {
    for (let i = end; i < res.length; ) {
      const s2 = segmentAt(res, i);
      if (isFlowSegment(res, s2) && (lastSeg2(res, s2) || storyParasOf(res, s2.start, s2.end).some(hasNotes))) res = reflowSegment(res, s2.start);
      i = segmentAt(res, s2.start).end;
    }
  }
  // the next run begins a new section whose top overlaps this run's last space after (Word's spacing): it follows a
  // change of that space after (or of the paragraph that ends this run)
  if (end < res.length && res[end].breakBefore === "section" && st.proto?.wordSpacing === "max") {
    const was = lastBodyPara(pages[seg.end - 1]);
    const now = lastBodyPara(res[end - 1]);
    if ((was?.spaceAfter ?? -1) !== (now?.spaceAfter ?? -1) && isFlowSegment(res, segmentAt(res, end))) res = reflowSegment(res, end);
  }
  return res;
}

/** One laid-out column of a page run: the page (in the run), its box, what goes in it. */
interface Slot {
  page: number;
  box: { x: number; y: number; w: number; h: number };
  items: Placed[];
  /** the region's last page column: its footnotes go to the page's foot */
  last: boolean;
  /** the rule before this column (Word w:sep): x, top and length (page coordinates) */
  rule?: { x: number; top: number; len: number };
}

/**
 * The regions of a story: from its start, and from each paragraph with `contSect` (이어서 구역), with their columns;
 * objects go with the paragraph they stand before (those after the story's end with the last region).
 */
function storyRegions(st: Story, first: PageColumns | undefined): { story: Story; cols: PageColumns | undefined }[] {
  const cuts = st.paras.map((p, i) => (i > 0 && p.contSect ? i : -1)).filter((i) => i > 0);
  const firstCols = st.paras[0]?.contSect ? st.paras[0].contSect.columns : first;
  if (!cuts.length) return [{ story: st, cols: firstCols }];
  const bounds = [0, ...cuts, st.paras.length];
  return bounds.slice(0, -1).map((a, r) => {
    const paras = st.paras.slice(a, bounds[r + 1]);
    const ids = new Set(paras.map((q) => q.id));
    const lastR = r === bounds.length - 2;
    const objs = st.objs.filter((o) => ids.has(o.before) || (lastR && o.before === STORY_END));
    return { story: { ...st, paras, objs }, cols: r === 0 ? firstCols : paras[0].contSect!.columns };
  });
}

/** The columns of a page run, region by region (see reflowSegment): balanced where another region follows on the page. */
function layRegions(st: Story, first: PageColumns | undefined, boxAt: (k: number) => { x: number; y: number; w: number; h: number }, opts: NoteOpts): Slot[] {
  const regions = storyRegions(st, first);
  const out: Slot[] = [];
  let P0 = 0, T0 = 0;
  regions.forEach((rg, r) => {
    const cols = rg.cols && rg.cols.n > 1 ? rg.cols : undefined;
    const n = columnBoxes({ x: 0, w: 1000 }, cols).length;
    const lastR = r === regions.length - 1;
    // (a region on the page after another: its top overlaps the space after of the part before's last paragraph — Word's
    // spacing, as at a section's top; the section break mark itself takes no room)
    // (the section break mark included: its space after is what overlaps — Word 2021, omni-fid-spacing-sect / -top)
    const prevLast = r > 0 ? regions[r - 1].story.paras[regions[r - 1].story.paras.length - 1] : undefined;
    // an empty mark paragraph (no line, its space after not counted in `used`): the space before of the next
    // part's first paragraph loses as much as the mark's space after (Word: after 10, mark 4, before 20 → 26 pt; mark 10 → 20 pt)
    const markEnd = !!prevLast?.sectMark && prevLast.runs.every((x) => !x.text);
    // (Word's "max" spacing only: with doNotUseHTMLParagraphAutoSpacing the spaces add up — omni-fid-spacing-sect-sum)
    if (r > 0 && T0 > 0 && markEnd && st.proto?.wordSpacing === "max") T0 = Math.max(0, T0 - Math.min(prevLast!.spaceAfter, rg.story.paras[0]?.spaceBefore ?? 0));
    const nopts: NoteOpts = r === 0 ? { ...opts, ...(lastR ? {} : { end: [] }) } : { pr: opts.pr, ...(lastR ? { end: opts.end } : {}), ...(T0 > 0 && prevLast && !markEnd ? { sectionAfter: prevLast } : {}) };
    const geomOf = (lastP: number, H?: number) => (k: number) => {
      const pg = P0 + Math.floor(k / n), c = k % n;
      const b = boxAt(pg);
      const top = pg === P0 ? T0 : 0;
      const cb = columnBoxes(b, cols)[c];
      const h = H !== undefined && pg === lastP ? H : b.h - top;
      return { box: { x: cb.x, y: b.y + top, w: cb.w, h: Math.max(1, h) }, ...(n > 1 ? { col: c } : {}) };
    };
    let lay = paginateStory(rg.story, geomOf(-1), nopts);
    const lastP = P0 + Math.floor((Math.max(1, lay.length) - 1) / n);
    // balanced columns before the next region (Word's continuous section break): the lowest height of the last page's
    // columns that still holds what goes there
    if (!lastR && n > 1) {
      const full = boxAt(lastP).h - (lastP === P0 ? T0 : 0);
      const fits = (H: number) => {
        const l = paginateStory(rg.story, geomOf(lastP, H), nopts);
        return P0 + Math.floor((Math.max(1, l.length) - 1) / n) === lastP ? l : null;
      };
      let lo = 0, hi = full, best = lay;
      for (let i = 0; i < 16 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2;
        const l = fits(mid);
        if (l) (hi = mid), (best = l);
        else lo = mid;
      }
      lay = best;
    }
    const geom = geomOf(-1);
    let used = 0;
    const regionSlots: Slot[] = [];
    lay.forEach((items, k) => {
      const g = geom(k);
      const pg = P0 + Math.floor(k / n);
      const sl: Slot = { page: pg, box: g.box, items, last: lastR || pg !== lastP };
      regionSlots.push(sl);
      // (Word's section break mark before the next region — TextParagraph.sectMark — takes no room: not its space after)
      if (pg === lastP) for (const it of items) if (it.kind !== "foot") used = Math.max(used, (it as { y: number; h: number }).y + (it as { y: number; h: number }).h - (it.kind === "para" && it.p.sectMark && it.p.runs.every((x) => !x.text) ? it.p.spaceAfter : 0));
    });
    // the rule between columns: per page of the region, as tall as its columns go there
    if (cols?.line && n > 1) {
      const byPage = new Map<number, Slot[]>();
      for (const sl of regionSlots) byPage.set(sl.page, [...(byPage.get(sl.page) ?? []), sl]);
      for (const [pg, sls] of byPage) {
        const len = Math.max(0, ...sls.map((x) => Math.max(0, ...x.items.filter((it) => it.kind !== "foot").map((it) => (it as { y: number; h: number }).y + (it as { y: number; h: number }).h))));
        if (len <= 0) continue;
        const cbs = columnBoxes(boxAt(pg), cols);
        sls.forEach((sl, i) => {
          const c = i % n;
          if (c > 0 && cbs[c]) sl.rule = { x: Math.round(((cbs[c - 1].x + cbs[c - 1].w + cbs[c].x) / 2) * 100) / 100, top: sl.box.y, len: Math.round(len * 100) / 100 };
        });
      }
    }
    out.push(...regionSlots);
    // the next region: below this one on its last page
    T0 = (lastP === P0 ? T0 : 0) + used;
    P0 = lastP;
  });
  return out;
}

const colMemo = new WeakMap<SceneNode, Map<number, SceneNode>>();
/** `n` laid out in column `c` (the same object each time, so an unchanged page stays the same) */
function inColumn<T extends SceneNode>(n: T, c: number): T {
  if ((n.flowCol ?? 0) === c) return n;
  let m = colMemo.get(n);
  const hit = m?.get(c);
  if (hit) return hit as T;
  const out = { ...n } as T;
  if (c) out.flowCol = c;
  else delete out.flowCol;
  if (!m) colMemo.set(n, (m = new Map()));
  m.set(c, out);
  return out;
}

/** The vertical rule between two columns (screen, print and every export draw it like any line; never body content). */
function colRuleNode(id: string, x: number, y: number, len: number, old?: SceneNode): SceneNode {
  if (old && old.type === "VECTOR" && old.transform.x === x && old.transform.y === y && old.contours[0]?.nodes[1]?.anchor[1] === len) return old;
  const pt = (v: number): [number, number] => [0, v];
  return {
    id,
    name: "column rule",
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: "NORMAL",
    transform: { x, y, rotation: 0, scale: 1 },
    type: "VECTOR",
    contours: [{ closed: false, nodes: [0, len].map((v) => ({ anchor: pt(v), handleIn: pt(v), handleOut: pt(v), isCorner: true })) }],
    fill: null,
    stroke: "#000000",
    strokeWidth: 0.75,
    fillRule: "nonzero",
    strokeCap: "butt",
    notes: "foot",
  } as SceneNode;
}

/** The last paragraph of a page's body when the body ends with text there (not a table or picture), else none. */
function lastBodyPara(page: Page | undefined): TextParagraph | undefined {
  const flow = page?.nodes.filter(isFlowNode).sort(flowSort) ?? [];
  const n = flow[flow.length - 1];
  return n?.type === "TEXT" ? n.paragraphs[n.paragraphs.length - 1] : undefined;
}

/** The run is the document's last flowing run (endnotes go after its story). */
const lastSeg2 = (pages: readonly Page[], seg: Segment) => !pages.slice(seg.end).some((p) => p.kind === "DOCUMENT" && p.nodes.some(isFlowNode));

/** Body paragraphs of pages [a, b) in order (flow frames, pieces as they are: notes are counted by their references). */
function storyParasOf(pages: readonly Page[], a: number, b: number): TextParagraph[] {
  const out: TextParagraph[] = [];
  for (let i = a; i < b; i++) for (const n of pages[i].nodes) if (n.type === "TEXT" && n.flow) out.push(...n.paragraphs);
  return out;
}

/** Free objects of a page: neither body flow nor the note areas the flow lays out. */
const isFree = (n: SceneNode) => !n.flow && !n.notes;

/** A note area's text frame (the same object while its paragraphs and place are unchanged). */
function noteFrame(id: string, kind: "foot" | "end", old: Map<string, SceneNode>, proto: TextNode | null, paras: TextParagraph[], x: number, y: number, w: number): TextNode {
  const o = old.get(id);
  const yy = Math.round(y * 100) / 100;
  if (o && o.type === "TEXT" && o.transform.x === x && o.transform.y === yy && o.width === w && o.paragraphs.length === paras.length && o.paragraphs.every((p, i) => p === paras[i])) return o;
  const n: TextNode = {
    id,
    name: t(kind === "foot" ? "docmode.footnote" : "docmode.endnote"),
    visible: true,
    // (clicked like a text box: its text is edited in place and goes back into the notes, ui/docFlow.ts)
    locked: false,
    opacity: 1,
    blendMode: "NORMAL",
    transform: { x, y: yy, rotation: 0, scale: 1 },
    type: "TEXT",
    width: w,
    paragraphs: paras,
    wordBreak: proto?.wordBreak ?? "keep-all",
    background: null,
    notes: kind,
  };
  if (proto?.cjkSpace) n.cjkSpace = proto.cjkSpace;
  if (proto?.hangPunct) n.hangPunct = true;
  if (proto?.justifyShrink) n.justifyShrink = true;
  if (proto?.autoSpace) n.autoSpace = proto.autoSpace;
  return n;
}

/** For every inline object: its paragraph's id and the characters (objects not counted) before it — ImageNode.place. */
function inlineOffsets(paras: readonly TextParagraph[]): Map<string, { para: string; offset: number }> {
  const out = new Map<string, { para: string; offset: number }>();
  for (const p of paras) {
    let o = 0;
    for (const r of p.runs) {
      if (r.obj) out.set(r.obj.id, { para: p.id, offset: o });
      else o += r.text.length;
    }
  }
  return out;
}

const inlineMemo = new WeakMap<SceneNode, Map<string, SceneNode>>();
/** The nodes of the inline objects a frame's lines hold, at their place in the line (bottom on the baseline). */
function placeInline(fr: TextNode, st: Story, out: SceneNode[], offs: Map<string, { para: string; offset: number }>) {
  if (!fr.paragraphs.some((q) => q.runs.some((r) => r.obj))) return;
  const lay = layoutText(fr);
  for (const ln of lay.lines)
    for (const pc of ln.pieces) {
      const o = pc.run.obj;
      const n = o && st.inline?.get(o.id);
      if (!o || !n) continue;
      const x = fr.transform.x + pc.x, y = fr.transform.y + ln.y + ln.baseline - o.h;
      const at = offs.get(o.id);
      const key = `${x},${y},${at?.para},${at?.offset}`;
      let m = inlineMemo.get(n);
      let v = m?.get(key);
      if (!v) {
        const cur = (n as { place?: Record<string, unknown> }).place;
        const same = n.transform.x === x && n.transform.y === y && n.flow && cur?.mode === "inline" && cur.para === at?.para && cur.offset === at?.offset;
        v = same ? n : ({ ...n, flow: true, transform: { ...n.transform, x, y }, ...(n.type === "IMAGE" ? { place: { mode: "inline", para: at?.para, offset: at?.offset } } : {}) } as SceneNode);
        if (!m) inlineMemo.set(n, (m = new Map()));
        m.set(key, v);
      }
      out.push(v);
    }
}

/** The list definitions object already on the run's frames when it equals `lists` (keeps frames unchanged). */
function sameLists(pages: readonly Page[], lists: ListDef[] | undefined): ListDef[] | undefined {
  if (!lists) return undefined;
  const key = JSON.stringify(lists);
  for (const p of pages) for (const n of p.nodes) if (n.type === "TEXT" && n.flow && n.lists && JSON.stringify(n.lists) === key) return n.lists;
  return lists;
}

/**
 * Re-flow every flowing page run of a document's pages (the same array when nothing changed). `asRead`: only runs that
 * hold text frames (a run of tables or pictures only gets no empty paragraph to type into: an imported file stays as
 * it is).
 */
export function reflowPages(pages: readonly Page[], asRead = false): Page[] {
  let out = pages as Page[];
  for (let i = 0; i < out.length; ) {
    const seg = segmentAt(out, i);
    const text = () => out.slice(seg.start, seg.end).some((p) => p.nodes.some((n) => n.type === "TEXT" && n.flow));
    if (isFlowSegment(out, seg) && (!asRead || text())) out = reflowSegment(out, seg.start);
    i = segmentAt(out, seg.start).end;
  }
  return out;
}

// ───────── turning page body boxes into flow ─────────

const near = (a: number, b: number, tol = 1.5) => Math.abs(a - b) <= tol;

/** Body objects of a document page: unrotated text boxes and tables starting at the left margin (as paginate / flowBlocks place them). */
export function bodyNodes(page: Page): SceneNode[] {
  if (page.kind !== "DOCUMENT") return [];
  const box = bodyBox(page);
  return page.nodes.filter((n) => (n.type === "TEXT" || n.type === "TABLE") && !n.notes && !n.transform.rotation && n.transform.scale === 1 && near(n.transform.x, box.x) && n.transform.y >= box.y - 1.5 && !n.locked);
}

/** Mark the body objects of pages as flow (in place, plain pages or a draft). Returns how many were marked. */
export function markFlowInPlace(pages: Page[]): number {
  let c = 0;
  for (const p of pages) {
    const nodes = bodyNodes(p);
    // pictures the file holds in the text (DOCX wp:inline, HWPX treatAsChar; io/officeDrawing.ts) flow as blocks with it
    if (p.kind === "DOCUMENT") for (const n of p.nodes) if (n.type === "IMAGE" && n.place?.mode === "inline") nodes.push(n);
    for (const n of nodes)
      if (!n.flow) {
        n.flow = true;
        c++;
      }
  }
  return c;
}

// ───────── geometry: story positions ⇄ page points ─────────

/** One laid-out line of the story: where it is drawn and which story characters [start, end] it shows. */
export interface FlowLine {
  /** page index in the document */
  page: number;
  node: TextNode;
  line: LaidLine;
  /** story paragraph index, and the line's character range in it (end excludes a "\n" break) */
  sp: number;
  start: number;
  end: number;
  /** the line is its paragraph's first / last */
  first: boolean;
  last: boolean;
}

const linesMemo = new WeakMap<readonly Page[], Map<number, FlowLine[]>>();

/** One frame's lines with paragraph-local offsets (cached per frame object: unchanged frames cost nothing). */
interface FrameLines {
  lines: { qi: number; line: LaidLine; s: number; e: number; first: boolean; last: boolean }[];
  lens: number[];
}
const frameMemo = new WeakMap<TextNode, { epoch: number; v: FrameLines }>();
function frameLines(fr: TextNode): FrameLines {
  const epoch = textMetricsEpoch();
  const hit = frameMemo.get(fr);
  if (hit && hit.epoch === epoch) return hit.v;
  const lay = layoutText(fr);
  const texts = fr.paragraphs.map(textOf);
  const v: FrameLines = { lines: [], lens: texts.map((x) => x.length) };
  let qi = -1;
  let o = 0;
  lay.lines.forEach((ln, k) => {
    if (ln.paragraph !== qi) {
      qi = ln.paragraph;
      o = 0;
    }
    const s0 = o;
    for (const pc of ln.pieces) o += pc.text.length;
    const e = Math.min(o, v.lens[qi]);
    if (texts[qi][o] === "\n") o++;
    const next = lay.lines[k + 1];
    v.lines.push({ qi, line: ln, s: s0, e, first: s0 === 0, last: !next || next.paragraph !== qi });
  });
  frameMemo.set(fr, { epoch, v });
  return v;
}

/** Every line of the run's story in reading order (frames' own layouts, the ones drawn). */
export function flowLines(pages: readonly Page[], seg: Segment): FlowLine[] {
  let m = linesMemo.get(pages);
  const hit = m?.get(seg.start);
  if (hit) return hit;
  const out: FlowLine[] = [];
  let sp = -1;
  let base = 0; // offset of the current piece in its story paragraph
  let prev: TextParagraph | null = null;
  let prevLen = 0;
  for (let i = seg.start; i < seg.end; i++) {
    const frames = pages[i].nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(flowSort);
    for (const fr of frames) {
      const fl = frameLines(fr);
      const spOf: number[] = [];
      const baseOf: number[] = [];
      fr.paragraphs.forEach((q, qi) => {
        const p0 = prev as TextParagraph | null;
        if (q.flowCont && p0 && p0.flowSplit && (p0.id === q.flowCont || p0.flowCont === q.flowCont)) base += prevLen;
        else {
          sp++;
          base = 0;
        }
        prev = q;
        prevLen = fl.lens[qi];
        spOf.push(sp);
        baseOf.push(base);
      });
      for (const l of fl.lines) {
        const q = fr.paragraphs[l.qi];
        out.push({ page: i, node: fr, line: l.line, sp: spOf[l.qi], start: baseOf[l.qi] + l.s, end: baseOf[l.qi] + l.e, first: l.first && !q.flowCont, last: l.last && !q.flowSplit });
      }
    }
  }
  if (!m) linesMemo.set(pages, (m = new Map()));
  m.set(seg.start, out);
  return out;
}

/** x (frame-local) of story offset `o` on line `fl`. */
export function xOnLine(fl: FlowLine, o: number): number {
  const { line, node } = fl;
  const para = node.paragraphs[line.paragraph];
  if (!line.pieces.length) {
    const left = (para.indentLeft ?? 0) + (fl.first ? para.indent : 0);
    const right = node.width - (para.indentRight ?? 0);
    return para.align === "CENTER" ? (left + right) / 2 : para.align === "RIGHT" ? right : Math.max(0, left);
  }
  let acc = fl.start;
  for (const pc of line.pieces) {
    const len = pc.text.length;
    if (o <= acc + len) {
      const k = o - acc;
      if (k <= 0 || pc.hidden) return pc.x;
      if (k >= len) return pc.x + pc.width;
      return pc.x + advance(pc.text.slice(0, k), pc.font, pc.letterSpacing ?? 0, runScale(pc.run));
    }
    acc += len;
  }
  const lp = line.pieces[line.pieces.length - 1];
  return lp.x + lp.width;
}

/** Story offset on line `fl` nearest to frame-local x (between grapheme clusters). */
export function offsetOnLine(fl: FlowLine, x: number): number {
  const { line } = fl;
  if (!line.pieces.length) return fl.start;
  let best = fl.start;
  let bd = Infinity;
  let acc = fl.start;
  for (const pc of line.pieces) {
    let k = 0;
    const check = (o: number, px: number) => {
      const d = Math.abs(px - x);
      if (d < bd) (bd = d), (best = o);
    };
    check(acc, pc.x);
    // (text the view hides: the caret goes before it)
    if (pc.hidden) {
      acc += pc.text.length;
      continue;
    }
    for (const g of graphemes(pc.text)) {
      k += g.length;
      check(acc + k, pc.x + (k >= pc.text.length ? pc.width : advance(pc.text.slice(0, k), pc.font, pc.letterSpacing ?? 0, runScale(pc.run))));
    }
    acc += pc.text.length;
  }
  // a line ending in a space that wrapped: the caret stays before the break
  if (best > fl.end) best = fl.end;
  if (!fl.last && best === fl.end && fl.end > fl.start) {
    const lp = line.pieces[line.pieces.length - 1];
    if (/\s$/.test(lp.text)) best = fl.end - 1;
  }
  return best;
}

/** Index of the line showing story position (p, o); at a wrap the caret goes to the next line's start. */
export function lineIndexOf(lines: readonly FlowLine[], p: number, o: number): number {
  let found = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.sp < p) continue;
    if (l.sp > p) break;
    if (o >= l.start && o <= l.end) {
      found = i;
      if (o < l.end || l.last) return i;
    }
    if (o < l.start) break;
  }
  if (found >= 0) return found;
  // past the paragraph's last line (shouldn't happen): its last line
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].sp <= p) return i;
  return 0;
}

export interface CaretBox {
  page: number;
  x: number;
  y: number;
  h: number;
}

/** Caret rectangle (page coordinates) of a story position. */
export function caretBox(lines: readonly FlowLine[], p: number, o: number): CaretBox | null {
  if (!lines.length) return null;
  const fl = lines[lineIndexOf(lines, p, o)];
  const t = fl.node.transform;
  // (QA docx-flow: Word's continuous section break mark lays out a line of no height — TextParagraph.sectMark — the
  // caret there is its font's height, else it vanished on the arrow keys)
  const h = fl.line.height || (fl.node.paragraphs[fl.line.paragraph]?.runs[0]?.fontSize ?? 16) * 1.2;
  return { page: fl.page, x: t.x + xOnLine(fl, o), y: t.y + fl.line.y - (fl.line.height ? 0 : h / 2), h };
}

/** Story position nearest to a point on page `page` (page coordinates); null when the run has no line there. */
export function posAt(lines: readonly FlowLine[], page: number, x: number, y: number): { p: number; o: number } | null {
  let best: FlowLine | null = null;
  let bd = Infinity;
  for (const fl of lines) {
    if (fl.page !== page) continue;
    const top = fl.node.transform.y + fl.line.y;
    const left = fl.node.transform.x, right = left + fl.node.width;
    // (several columns: the line of the column under the point — beside it counts more than above or below)
    const dx = x < left - 4 ? left - x : x > right + 4 ? x - right : 0;
    const d = (y < top ? top - y : y > top + fl.line.height ? y - top - fl.line.height : 0) + dx * 4;
    if (d < bd) (bd = d), (best = fl);
    if (d === 0) break;
  }
  if (!best) return null;
  return { p: best.sp, o: offsetOnLine(best, x - best.node.transform.x) };
}

/** Selection rectangles (page coordinates) of story range [a, b) on page `page`. */
export function rangeRects(lines: readonly FlowLine[], page: number, a: { p: number; o: number }, b: { p: number; o: number }): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (const fl of lines) {
    if (fl.page !== page || fl.sp < a.p || fl.sp > b.p) continue;
    const s = fl.sp === a.p ? Math.max(a.o, fl.start) : fl.start;
    const e = fl.sp === b.p ? Math.min(b.o, fl.end) : fl.end;
    if (s > e) continue;
    // the paragraph mark is selected too: a little room past the end
    const mark = fl.last && fl.sp < b.p;
    if (s === e && !mark) continue;
    const x0 = xOnLine(fl, s);
    const x1 = xOnLine(fl, e) + (mark ? 6 : 0);
    const t = fl.node.transform;
    out.push({ x: t.x + x0, y: t.y + fl.line.y, w: Math.max(1, x1 - x0), h: fl.line.height });
  }
  return out;
}
