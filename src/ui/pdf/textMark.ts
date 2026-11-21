// Marking text on a PDF page by dragging (highlight / underline / strike-out): the text runs of the page in reading
// order, and the stretch of text from the drag's start to its end as one quad per line (PDF user space,
// Acrobat's QuadPoints order UL UR LL LR). Pure: tests/pdfsurgeon/textMark.test.ts, annotRotateColumns.test.ts.
//
// Reading order follows the page's layout, not just its rows: the runs are cut recursively at the widest empty
// vertical band (a column gutter, left part first) or, where there is none, at the widest empty horizontal band
// (top part first) — an X-Y cut. A vertical band cuts only between real text columns (columns(): several rows of
// running text on each side), so a one-column page — lists, tab stops, tables, spreadsheet cells — reads row by row
// exactly as before. A "line" is a row inside one such block, so on a two-column page a row is two
// lines, its quads never cover the gutter, and a drag from one column into the next marks the rest of the first
// column and then the start of the next, the way the page reads.
import type { PdfTextItem } from "../../io/pdf";

export interface Line {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  /** the column the line belongs to (textLines; the gutters' middles, unbounded without columns) */
  cx0?: number;
  cx1?: number;
  items: PdfTextItem[];
}

/** Runs of one block grouped into rows (top to bottom), each row left to right. */
function rows(items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  for (const it of [...items].sort((a, b) => b.y1 + b.y0 - (a.y1 + a.y0))) {
    const mid = (it.y0 + it.y1) / 2;
    const line = lines.find((l) => mid >= l.y0 && mid <= l.y1);
    if (line) {
      line.items.push(it);
      line.y0 = Math.min(line.y0, it.y0);
      line.y1 = Math.max(line.y1, it.y1);
      line.x0 = Math.min(line.x0, it.x0);
      line.x1 = Math.max(line.x1, it.x1);
    } else lines.push({ y0: it.y0, y1: it.y1, x0: it.x0, x1: it.x1, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x0 - b.x0);
  return lines.sort((a, b) => b.y1 - a.y1);
}

/** the widest empty band along one axis: [width, middle] (width 0 when the runs cover it all) */
function widestGap(items: PdfTextItem[], lo: (i: PdfTextItem) => number, hi: (i: PdfTextItem) => number): [number, number] {
  const s = [...items].sort((a, b) => lo(a) - lo(b));
  let reach = hi(s[0]), best: [number, number] = [0, 0];
  for (let i = 1; i < s.length; i++) {
    const g = lo(s[i]) - reach;
    if (g > best[0]) best = [g, reach + g / 2];
    reach = Math.max(reach, hi(s[i]));
  }
  return best;
}

/**
 * Whether the two sides of an empty vertical band are text columns: each holds several rows of running text — the
 * median row at least COL_EM ems wide and mostly ink, not cells apart. A list's numbers, a tab-aligned label, a
 * table's or a spreadsheet's cells are not: those pages keep reading row by row across the band, as before.
 */
const COL_ROWS = 3;
const COL_EM = 12;
const COL_INK = 0.75;
function columns(sides: PdfTextItem[][], em: number): boolean {
  const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
  return sides.every((side) => {
    const rs = rows(side);
    if (rs.length < COL_ROWS) return false;
    if (median(rs.map((r) => r.x1 - r.x0)) < COL_EM * em) return false;
    // the part of the row covered by its runs (runs left to right; overlaps counted once)
    const ink = (r: Line) => {
      let reach = -Infinity, sum = 0;
      for (const it of r.items) {
        sum += Math.max(0, it.x1 - Math.max(it.x0, reach));
        reach = Math.max(reach, it.x1);
      }
      return sum / Math.max(1e-6, r.x1 - r.x0);
    };
    return median(rs.map(ink)) >= COL_INK;
  });
}

interface Block {
  items: PdfTextItem[];
  /** the column the block sits in: between the gutters around it (unbounded on a one-column page) */
  cx0: number;
  cx1: number;
}

/** X-Y cut: the runs as blocks in reading order (see the header) */
function cut(items: PdfTextItem[], em: number, out: Block[], cx0 = -Infinity, cx1 = Infinity, depth = 0): void {
  if (items.length < 2 || depth > 200) {
    if (items.length) out.push({ items, cx0, cx1 });
    return;
  }
  const [hg, hy] = widestGap(items, (i) => i.y0, (i) => i.y1);
  if (hg <= 0) return void out.push({ items, cx0, cx1 }); // a single row is never cut in columns
  const [vg, vx] = widestGap(items, (i) => i.x0, (i) => i.x1);
  // a gutter is wider than most of a character: LaTeX's two columns are 10 pt apart at 10 pt text
  if (vg >= Math.max(4, 0.7 * em)) {
    const mid = (i: PdfTextItem) => (i.x0 + i.x1) / 2;
    const sides = [items.filter((i) => mid(i) < vx), items.filter((i) => mid(i) >= vx)];
    if (columns(sides, em)) {
      cut(sides[0], em, out, cx0, vx, depth + 1);
      cut(sides[1], em, out, vx, cx1, depth + 1);
      return;
    }
  }
  const mid = (i: PdfTextItem) => (i.y0 + i.y1) / 2;
  cut(items.filter((i) => mid(i) > hy), em, out, cx0, cx1, depth + 1);
  cut(items.filter((i) => mid(i) <= hy), em, out, cx0, cx1, depth + 1);
}

const known = new WeakMap<PdfTextItem[], Line[]>();
/** The page's text lines in reading order (a column after another), each line left to right. */
export function textLines(items: PdfTextItem[]): Line[] {
  let lines = known.get(items);
  if (lines) return lines;
  const hs = items.map((i) => i.y1 - i.y0).sort((a, b) => a - b);
  const blocks: Block[] = [];
  cut(items, hs[hs.length >> 1] ?? 10, blocks);
  lines = blocks.flatMap((b) => rows(b.items).map((l) => ({ ...l, cx0: b.cx0, cx1: b.cx1 })));
  known.set(items, lines);
  return lines;
}

/**
 * where a point falls in the text: the nearest line, a step up or down counting double; across, only the distance
 * to the line's column counts — on a one-column page none, so a drag past the end of a short line still ends on it
 */
function locate(lines: Line[], p: [number, number]): { line: number; x: number } {
  let best = 0, dist = Infinity;
  lines.forEach((l, i) => {
    const dy = p[1] < l.y0 ? l.y0 - p[1] : p[1] > l.y1 ? p[1] - l.y1 : 0;
    const cx0 = l.cx0 ?? -Infinity, cx1 = l.cx1 ?? Infinity;
    const dx = p[0] < cx0 ? cx0 - p[0] : p[0] > cx1 ? p[0] - cx1 : 0;
    const d = Math.hypot(dx, 2 * dy); // rows sit close together: a step up or down counts more than one along
    if (d < dist) (dist = d), (best = i);
  });
  return { line: best, x: p[0] };
}

/** x snapped to the character boundary of a run (characters assumed even width — close enough for marking) */
function snap(it: PdfTextItem, x: number, up: boolean): number {
  const n = Math.max(1, [...it.str].length);
  const w = (it.x1 - it.x0) / n;
  // the start takes the whole character it falls in, the end too
  const k = Math.min(n, Math.max(0, (up ? Math.ceil : Math.floor)((x - it.x0) / w)));
  return it.x0 + k * w;
}

/** The text between two points (drag start and end, any order) as one quad per line. */
export function quadsBetween(items: PdfTextItem[], a: [number, number], b: [number, number]): number[][] {
  const lines = textLines(items);
  if (!lines.length) return [];
  let s = locate(lines, a), e = locate(lines, b);
  if (s.line > e.line || (s.line === e.line && s.x > e.x)) [s, e] = [e, s];
  const quads: number[][] = [];
  for (let li = s.line; li <= e.line; li++) {
    const l = lines[li];
    const xs = li === s.line ? s.x : -Infinity, xe = li === e.line ? e.x : Infinity;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const it of l.items) {
      if (it.x1 <= xs || it.x0 >= xe) continue;
      const a0 = xs > it.x0 ? snap(it, xs, false) : it.x0;
      const a1 = xe < it.x1 ? snap(it, xe, true) : it.x1;
      if (a1 - a0 < 0.5) continue;
      x0 = Math.min(x0, a0);
      x1 = Math.max(x1, a1);
      y0 = Math.min(y0, it.y0);
      y1 = Math.max(y1, it.y1);
    }
    if (x1 - x0 >= 0.5) quads.push([x0, y1, x1, y1, x0, y0, x1, y0]);
  }
  return quads;
}
