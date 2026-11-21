// Table layout shared by the renderer, hit testing, bounds and exporters.
// Rows grow to fit wrapped cell text; layout is memoized by node identity (nodes are immutable).
//
// Merged cells (TableCell.colSpan / rowSpan, from DOCX gridSpan·vMerge and HWPX cellSpan or the 셀 합치기 command):
// the top-left cell of a range draws over the whole range; the cells it covers stay in the grid (empty) but are not
// drawn, hit or edited. coverMap / spanOf / tableCells are the one place that resolves spans — the canvas, PDF and
// Office writers all use them.

import { cssFont, graphemes, layoutText, measure, textMetricsEpoch, tokenize } from "./text";
import { newText, type TableCell, type TableNode, type TextNode, type TextParagraph, type WordCells } from "./types";

export const CELL_PAD_X = 6;
export const CELL_PAD_Y = 4;
export const TABLE_LINE = 1.35;

export interface CellLine {
  text: string;
  width: number;
}

export interface TableLayout {
  colX: number[]; // left edge of each column, plus total width at the end
  rowY: number[]; // top edge of each row, plus total height at the end
  lines: CellLine[][][]; // [row][col] wrapped lines (a merged cell's lines are at its top-left cell, wrapped to its full width)
  width: number;
  height: number;
  /** [row][col] a `cellBox` table's cells as text laid out from their own paragraphs (null: drawn from `lines`) */
  rich?: (TextNode | null)[][];
}

/** A cell's own paragraphs while its text is still theirs (an edited cell is drawn from its text). */
export function richOf(cell: TableCell): TextParagraph[] | null {
  const ps = cell.richText;
  return ps?.length && ps.map((p) => p.runs.map((r) => r.text).join("")).join("\n") === cell.text ? ps : null;
}

/**
 * The glyph box of a rich cell's text: from the top of the first line's glyphs to the bottom of the last line's
 * (한글 sizes a cell to its text: the gap a line spacing adds below the last line, and the space after the last
 * paragraph, are not part of it). `top` is where that box starts in the laid-out node.
 */
export function richBox(t: TextNode): { top: number; h: number } {
  const lines = layoutText(t).lines;
  if (!lines.length) return { top: 0, h: 0 };
  // (an empty line: the size of its paragraph's first run)
  const size = (l: (typeof lines)[number]) => (l.pieces.length ? Math.max(...l.pieces.map((p) => p.run.fontSize)) : t.paragraphs[l.paragraph]?.runs[0]?.fontSize ?? 1);
  const a = lines[0], b = lines[lines.length - 1];
  const top = a.y + a.baseline - size(a) * 0.8;
  return { top, h: b.y + b.baseline + size(b) * 0.2 - top };
}

/** Template of the text node a rich cell is laid out in. */
let cellTextBase: TextNode | null = null;
const cellText = () => (cellTextBase ??= { ...newText("", 10), id: "cell", name: "cell", paragraphs: [], wordBreak: "keep-all" });

/** The text frame settings of a Word table's cells (TableNode.cellBox.word). */
function wordOpts(w: WordCells | undefined): Partial<TextNode> {
  if (!w) return {};
  const o: Partial<TextNode> = {};
  if (w.wordBreak) o.wordBreak = w.wordBreak;
  if (w.cjkSpace) o.cjkSpace = w.cjkSpace;
  if (w.hangPunct) o.hangPunct = true;
  if (w.justifyShrink) o.justifyShrink = true;
  if (w.autoSpace) o.autoSpace = w.autoSpace;
  if (w.wordSpacing) o.wordSpacing = w.wordSpacing;
  return o;
}

export function cellFont(n: TableNode, cell: TableCell, row: number): string {
  return cssFont({ fontFamily: n.fontFamily, fontSize: n.fontSize, bold: !!cell.bold || (n.headerRow && row === 0), italic: !!cell.italic });
}

/** Greedy word wrap (keep-all, grapheme fallback for long tokens). Explicit "\n" always breaks. */
export function wrapText(text: string, font: string, maxW: number): CellLine[] {
  const out: CellLine[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    const push = () => {
      const t = line.replace(/\s+$/, "");
      out.push({ text: t, width: measure(t, font) });
      line = "";
    };
    for (const tok of tokenize(para, "keep-all")) {
      if (measure((line + tok).replace(/\s+$/, ""), font) <= maxW || !line) {
        if (!line && measure(tok.replace(/\s+$/, ""), font) > maxW) {
          for (const g of graphemes(tok)) {
            if (line && measure(line + g, font) > maxW) push();
            line += g;
          }
        } else line += tok;
      } else {
        push();
        if (measure(tok.replace(/\s+$/, ""), font) > maxW) {
          for (const g of graphemes(tok)) {
            if (line && measure(line + g, font) > maxW) push();
            line += g;
          }
        } else line = tok;
      }
    }
    push();
  }
  return out;
}

// ───────── merged cells ─────────

/** For every grid position: the top-left cell of the merged range covering it (null = not covered, i.e. drawn itself). */
export function coverMap(rows: TableCell[][]): ({ r: number; c: number } | null)[][] {
  const cols = Math.max(0, ...rows.map((r) => r.length));
  const map = rows.map(() => Array.from({ length: cols }, () => null as { r: number; c: number } | null));
  rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (map[r][c]) return;
      const rs = Math.min(cell.rowSpan ?? 1, rows.length - r), cs = Math.min(cell.colSpan ?? 1, cols - c);
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) if (i || j) map[r + i][c + j] = { r, c };
    }),
  );
  return map;
}

/** Span of the cell at (r, c), clipped to the grid. */
export const spanOf = (rows: TableCell[][], r: number, c: number) => {
  const cell = rows[r][c];
  const cols = rows[r].length;
  return { cs: Math.max(1, Math.min(cell.colSpan ?? 1, cols - c)), rs: Math.max(1, Math.min(cell.rowSpan ?? 1, rows.length - r)) };
};

export const hasMerges = (rows: TableCell[][]) => rows.some((r) => r.some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1));

/** The top-left cell of the range drawn at (r, c) — (r, c) itself unless it is covered. */
export function anchorOf(n: Pick<TableNode, "rows">, r: number, c: number): { row: number; col: number } {
  const cv = coverMap(n.rows)[r]?.[c];
  return cv ? { row: cv.r, col: cv.c } : { row: r, col: c };
}

/** Visible cells (top-left cells of their ranges) with their spans, in reading order. */
export function visibleCells(n: Pick<TableNode, "rows">): { r: number; c: number; rs: number; cs: number; cell: TableCell }[] {
  const cover = coverMap(n.rows);
  const out: { r: number; c: number; rs: number; cs: number; cell: TableCell }[] = [];
  n.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cover[r][c]) return;
      const { rs, cs } = spanOf(n.rows, r, c);
      out.push({ r, c, rs, cs, cell });
    }),
  );
  return out;
}

const cache = new WeakMap<TableNode, TableLayout>();
/** a rich cell's text node and height, per cell object (layoutTable) */
const richCellMemo = new WeakMap<TableCell, { box: NonNullable<TableNode["cellBox"]>; w: number; rs: number; epoch: number; t: TextNode; h: number }>();

export function layoutTable(n: TableNode): TableLayout {
  const hit = cache.get(n);
  if (hit) return hit;
  const colX = [0];
  for (const w of n.colWidths) colX.push(colX[colX.length - 1] + w);
  const lines: CellLine[][][] = n.rows.map(() => n.colWidths.map(() => [] as CellLine[]));
  const lh = n.fontSize * TABLE_LINE;
  const need = (count: number) => Math.max(n.rowHeight, count * lh + CELL_PAD_Y * 2);
  // (a cellBox table's rows are as tall as their cells need: 한글 sizes rows to their content and cell heights)
  const heights = n.rows.map(() => (n.cellBox ? 0 : n.rowHeight));
  const tall: { r: number; rs: number; h: number }[] = [];
  const rich: (TextNode | null)[][] = n.rows.map(() => n.colWidths.map(() => null));
  for (const v of visibleCells(n)) {
    if (v.c >= n.colWidths.length) continue;
    const cs = Math.min(v.cs, n.colWidths.length - v.c);
    const w = colX[v.c + cs] - colX[v.c];
    const box = n.cellBox;
    // (a cell laid out before in a table of the same cell settings and column: its text node and height again — a
    // table the body flow cuts a row of at each page end, core/flow.ts cutRowAt, is the same cells but two)
    const epoch = textMetricsEpoch();
    const was = box ? richCellMemo.get(v.cell) : undefined;
    const same = !!was && was.box === box && was.w === w && was.rs === v.rs && was.epoch === epoch;
    const paras = box && !same ? richOf(v.cell) : null;
    let h: number;
    if (was && same) {
      rich[v.r][v.c] = was.t;
      h = was.h;
    } else if (box && paras) {
      // the cell's own paragraphs, laid out like body text in the cell less its margins
      const t: TextNode = { ...cellText(), ...wordOpts(box.word), width: Math.max(4, w - box.padX * 2), paragraphs: paras };
      rich[v.r][v.c] = t;
      // (at least the cell's own height from the file)
      const min = v.rs === 1 ? v.cell.minHeight ?? 0 : 0;
      // Word: the paragraphs' whole height (their space before / after too) and a border line; 한글: the glyph box
      // (Word: w:trHeight bounds the content; the cell margins and the border line come on top — measured, omni-fid-cells)
      h = box.word ? Math.max(min, layoutText(t).height) + box.word.border + box.padY * 2 : Math.max(min, richBox(t).h + box.padY * 2);
      richCellMemo.set(v.cell, { box, w, rs: v.rs, epoch, t, h });
    } else if (box && !v.cell.text && v.cell.richText?.length === 0) {
      // the empty part of a row cut at a page end (core/flow.ts cutRowAt): nothing in it, the other cells decide
      h = 0;
    } else {
      const l = v.cell.text ? wrapText(v.cell.text, cellFont(n, v.cell, v.r), Math.max(4, w - CELL_PAD_X * 2)) : [];
      lines[v.r][v.c] = l;
      h = need(Math.max(1, l.length));
    }
    if (v.rs === 1) heights[v.r] = Math.max(heights[v.r], h);
    else tall.push({ r: v.r, rs: v.rs, h });
  }
  // a cell spanning several rows that needs more room than those rows give grows its last row
  for (const t of tall) {
    const have = heights.slice(t.r, t.r + t.rs).reduce((a, b) => a + b, 0);
    if (have < t.h) heights[t.r + t.rs - 1] += t.h - have;
  }
  const rowY = [0];
  for (const h of heights) rowY.push(rowY[rowY.length - 1] + h);
  const layout: TableLayout = { colX, rowY, lines, width: colX[colX.length - 1], height: rowY[rowY.length - 1] };
  if (n.cellBox) layout.rich = rich;
  cache.set(n, layout);
  return layout;
}

/** The node-local rectangle a cell draws in: its whole merged range for a top-left cell. */
export function cellRect(l: TableLayout, r: number, c: number, rs = 1, cs = 1): { x: number; y: number; w: number; h: number } {
  const c1 = Math.min(c + cs, l.colX.length - 1), r1 = Math.min(r + rs, l.rowY.length - 1);
  return { x: l.colX[c], y: l.rowY[r], w: l.colX[c1] - l.colX[c], h: l.rowY[r1] - l.rowY[r] };
}

/** Everything a renderer needs per visible cell: rectangle, lines, font, colours (canvas, PDF and print draw from this). */
export function tableCells(n: TableNode) {
  const l = layoutTable(n);
  return visibleCells(n)
    .filter((v) => v.c < n.colWidths.length)
    .map((v) => {
      const rect = cellRect(l, v.r, v.c, v.rs, v.cs);
      return { ...v, rect, lines: l.lines[v.r][v.c] ?? [], rich: richAt(n, l, v.r, v.c, v.cell, rect) };
    });
}

/** A rich cell's text node and where it is drawn (node-local, after the cell's margins and vertical alignment). */
function richAt(n: TableNode, l: TableLayout, r: number, c: number, cell: TableCell, rect: { x: number; y: number; w: number; h: number }) {
  const t = l.rich?.[r]?.[c];
  if (!t || !n.cellBox) return null;
  const { padX, padY, word } = n.cellBox;
  // (Word: the text starts below the row's top border line, whose middle is the row's edge)
  const box = word ? { top: -word.border / 2, h: layoutText(t).height + word.border } : richBox(t);
  const room = rect.h - padY * 2 - box.h;
  const dy = room > 0 && cell.vAlign ? (cell.vAlign === "middle" ? room / 2 : room) : 0;
  return { node: t, x: rect.x + padX, y: rect.y + padY + dy - box.top };
}

/** x of a cell line for the cell's alignment */
export function lineX(align: TableCell["align"], x0: number, w: number, lineW: number) {
  const a = align ?? "LEFT";
  return a === "CENTER" ? x0 + (w - lineW) / 2 : a === "RIGHT" ? x0 + w - CELL_PAD_X - lineW : x0 + CELL_PAD_X;
}

/** Cell under a node-local point (the top-left cell of a merged range), or null. */
export function cellAt(n: TableNode, x: number, y: number): { row: number; col: number } | null {
  const l = layoutTable(n);
  if (x < 0 || y < 0 || x > l.width || y > l.height) return null;
  let col = l.colX.findIndex((v, i) => i > 0 && x <= v) - 1;
  let row = l.rowY.findIndex((v, i) => i > 0 && y <= v) - 1;
  if (col < 0) col = n.colWidths.length - 1;
  if (row < 0) row = n.rows.length - 1;
  return anchorOf(n, row, col);
}

/** Plain grid of strings (for CSV/SRT/exports). */
export function tableGrid(n: TableNode): string[][] {
  return n.rows.map((r) => r.map((c) => c.text));
}

// ───────── merge / split (셀 합치기 / 셀 나누기) ─────────

export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

/** A range grown until no merged cell sticks out of it (merging must swallow whole merged cells). */
export function expandRange(rows: TableCell[][], g: CellRange): CellRange {
  let { r0, c0, r1, c1 } = { r0: Math.min(g.r0, g.r1), c0: Math.min(g.c0, g.c1), r1: Math.max(g.r0, g.r1), c1: Math.max(g.c0, g.c1) };
  const cover = coverMap(rows);
  for (let changed = true; changed; ) {
    changed = false;
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) {
        const a = cover[r]?.[c] ?? { r, c };
        if (!rows[a.r]?.[a.c]) continue;
        const { rs, cs } = spanOf(rows, a.r, a.c);
        const nr0 = Math.min(r0, a.r), nc0 = Math.min(c0, a.c), nr1 = Math.max(r1, a.r + rs - 1), nc1 = Math.max(c1, a.c + cs - 1);
        if (nr0 !== r0 || nc0 !== c0 || nr1 !== r1 || nc1 !== c1) {
          ({ r0, c0, r1, c1 } = { r0: nr0, c0: nc0, r1: nr1, c1: nc1 });
          changed = true;
        }
      }
  }
  return { r0, c0, r1, c1 };
}

/**
 * Merge a range into its top-left cell (in place). The texts of the merged cells are joined line by line in
 * reading order (like Word and 한글, nothing is thrown away); covered cells become empty. Returns false when the
 * range is a single cell.
 */
export function mergeCellsInPlace(t: Pick<TableNode, "rows">, range: CellRange): boolean {
  const g = expandRange(t.rows, range);
  if (g.r0 === g.r1 && g.c0 === g.c1) return false;
  const texts: string[] = [];
  for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) if (t.rows[r][c].text.trim()) texts.push(t.rows[r][c].text);
  const top = t.rows[g.r0][g.c0];
  const merged: TableCell = { ...top, text: texts.join("\n") };
  delete merged.formula;
  if (merged.text !== top.text) delete merged.richText;
  const rs = g.r1 - g.r0 + 1, cs = g.c1 - g.c0 + 1;
  if (rs > 1) merged.rowSpan = rs;
  else delete merged.rowSpan;
  if (cs > 1) merged.colSpan = cs;
  else delete merged.colSpan;
  for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) if (r !== g.r0 || c !== g.c0) t.rows[r][c] = { text: "" };
  t.rows[g.r0][g.c0] = merged;
  return true;
}

/**
 * Split the cell at (r, c) (in place): a merged cell goes back to its grid cells (its text stays in the top-left one);
 * a single cell is split into two columns — a new grid column is inserted after it and the cells above and below grow
 * across both, so only this cell is divided. Returns what happened.
 */
export function splitCellInPlace(t: Pick<TableNode, "rows" | "colWidths">, r: number, c: number): "unmerged" | "split" | null {
  const a = anchorOf(t, r, c);
  const cell = t.rows[a.row]?.[a.col];
  if (!cell) return null;
  if ((cell.colSpan ?? 1) > 1 || (cell.rowSpan ?? 1) > 1) {
    const next = { ...cell };
    delete next.colSpan;
    delete next.rowSpan;
    t.rows[a.row][a.col] = next;
    return "unmerged";
  }
  const cover = coverMap(t.rows);
  const half = (t.colWidths[a.col] ?? 100) / 2;
  t.colWidths.splice(a.col, 1, half, half);
  t.rows.forEach((row, ri) => {
    if (ri === a.row) {
      row.splice(a.col + 1, 0, { text: "" });
      return;
    }
    // the cell (or merged range) over this column in another row now spans the new column too; a range that starts
    // in an earlier row is widened once, at its own row, and the rows it covers only get the new (covered) slot
    const cv = cover[ri][a.col] ?? { r: ri, c: a.col };
    if (cv.r === ri) row[cv.c] = { ...row[cv.c], colSpan: (row[cv.c].colSpan ?? 1) + 1 };
    row.splice(a.col + 1, 0, { text: "" });
  });
  return "split";
}

// ───────── rows / columns (행·열 삽입 / 삭제 — the table context menu and the properties panel) ─────────

/** The other corner of a cell range dragged from `anchor` to `cur` (null = still the one cell). */
export const dragEnd = (anchor: { row: number; col: number }, cur: { row: number; col: number }) => (anchor.row === cur.row && anchor.col === cur.col ? null : { row: cur.row, col: cur.col });

const setSpan = (cell: TableCell, key: "rowSpan" | "colSpan", n: number): TableCell => {
  const next = { ...cell };
  if (n > 1) next[key] = n;
  else delete next[key];
  return next;
};

/**
 * Insert `n` empty rows before row `at` (in place). A merged cell the new rows cut through grows over them (Word):
 * the new slots under it are covered (empty) cells.
 */
export function insertRowsInPlace(t: Pick<TableNode, "rows" | "colWidths">, at: number, n = 1) {
  const cols = t.colWidths.length;
  at = Math.max(0, Math.min(at, t.rows.length));
  const cover = coverMap(t.rows);
  const grown = new Set<string>();
  for (let c = 0; c < cols && at < t.rows.length; c++) {
    const cv = cover[at]?.[c];
    if (!cv || cv.r >= at || grown.has(`${cv.r}:${cv.c}`)) continue;
    grown.add(`${cv.r}:${cv.c}`);
    t.rows[cv.r][cv.c] = setSpan(t.rows[cv.r][cv.c], "rowSpan", (t.rows[cv.r][cv.c].rowSpan ?? 1) + n);
  }
  t.rows.splice(at, 0, ...Array.from({ length: n }, () => Array.from({ length: cols }, () => ({ text: "" }) as TableCell)));
}

/** Insert `n` empty columns before column `at` (in place), each as wide as its neighbour; merged cells cut through grow. */
export function insertColsInPlace(t: Pick<TableNode, "rows" | "colWidths">, at: number, n = 1) {
  const cols = t.colWidths.length;
  at = Math.max(0, Math.min(at, cols));
  const cover = coverMap(t.rows);
  const grown = new Set<string>();
  t.rows.forEach((_, r) => {
    const cv = at < cols ? cover[r]?.[at] : null;
    if (!cv || cv.c >= at || grown.has(`${cv.r}:${cv.c}`)) return;
    grown.add(`${cv.r}:${cv.c}`);
    t.rows[cv.r][cv.c] = setSpan(t.rows[cv.r][cv.c], "colSpan", (t.rows[cv.r][cv.c].colSpan ?? 1) + n);
  });
  const w = t.colWidths[at] ?? t.colWidths[at - 1] ?? 100;
  t.colWidths.splice(at, 0, ...Array.from({ length: n }, () => w));
  for (const row of t.rows) row.splice(at, 0, ...Array.from({ length: n }, () => ({ text: "" }) as TableCell));
}

/**
 * Delete rows r0…r1 (in place). A merged cell that reaches into them shrinks; one that starts in them and goes on
 * below moves down to the first row kept (its text with it). Returns false (nothing done) when every row would go —
 * that is deleting the table.
 */
export function deleteRowsInPlace(t: Pick<TableNode, "rows" | "colWidths">, r0: number, r1: number): boolean {
  [r0, r1] = [Math.max(0, Math.min(r0, r1)), Math.min(t.rows.length - 1, Math.max(r0, r1))];
  if (r0 > r1 || r1 - r0 + 1 >= t.rows.length) return false;
  for (const v of visibleCells(t)) {
    const end = v.r + v.rs - 1;
    if (v.rs < 2 || end < r0 || v.r > r1) continue;
    const gone = Math.min(end, r1) - Math.max(v.r, r0) + 1;
    if (v.r < r0) t.rows[v.r][v.c] = setSpan(v.cell, "rowSpan", v.rs - gone);
    else if (end > r1) t.rows[r1 + 1][v.c] = setSpan(v.cell, "rowSpan", v.rs - gone);
  }
  t.rows.splice(r0, r1 - r0 + 1);
  return true;
}

/** Delete columns c0…c1 (in place), as deleteRowsInPlace does rows; false when every column would go. */
export function deleteColsInPlace(t: Pick<TableNode, "rows" | "colWidths">, c0: number, c1: number): boolean {
  [c0, c1] = [Math.max(0, Math.min(c0, c1)), Math.min(t.colWidths.length - 1, Math.max(c0, c1))];
  if (c0 > c1 || c1 - c0 + 1 >= t.colWidths.length) return false;
  for (const v of visibleCells(t)) {
    const end = v.c + v.cs - 1;
    if (v.cs < 2 || end < c0 || v.c > c1) continue;
    const gone = Math.min(end, c1) - Math.max(v.c, c0) + 1;
    if (v.c < c0) t.rows[v.r][v.c] = setSpan(v.cell, "colSpan", v.cs - gone);
    else if (end > c1) t.rows[v.r][c1 + 1] = setSpan(v.cell, "colSpan", v.cs - gone);
  }
  t.colWidths.splice(c0, c1 - c0 + 1);
  for (const row of t.rows) row.splice(c0, c1 - c0 + 1);
  return true;
}
