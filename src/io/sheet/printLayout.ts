// Excel print layout (표 계산 인쇄 쪽 나눔): which rows and columns go on which printed page, the way Excel paginates —
// print area (or the used range from A1, cells with only a fill / border count, as in Excel), whole rows and columns
// fitted in the printable area at the print scale, manual breaks, fit to N pages (the largest whole percent ≤ 100 that
// fits, at least 10), down-then-over or over-then-down order, hidden rows / columns left out, print titles repeated on
// every page (and taking their space), printed headings.
//
// Units: printer dots at 600 dpi, as Excel lays a print out (1 px at 96 dpi = 6.25 dots). Excel measures a printed
// column in digits of the printer font (wider or narrower than on screen: 맑은 고딕 11 = 51 dots, Calibri 11 = 47) and a
// printed row in the printer font's line height; both follow from the font's metrics (io/sheet/printFont.ts, checked
// with Excel 16: qa/interop/scripts/xlsx_print_make.ps1 and xlsx_print_fonts_make.ps1, docs/design/FIDELITY_XLSX.md
// §4). Scaled lines are rounded to whole dots, like Excel's.

import type { SheetData } from "../../core/sheetTypes";
import { printDigitDots, printRowOf, screenRowPx } from "./printFont";
import { parseAddr, parseRange, MAX_COL, MAX_ROW, type Rect } from "./formula";

export const DOTS_PER_PX = 6.25;

/** Paper sizes (ST_PaperSize) in mm or inches: [width, height, unit]. */
const PAPER: Record<number, [number, number, "mm" | "in"]> = {
  1: [8.5, 11, "in"], 2: [8.5, 11, "in"], 3: [11, 17, "in"], 4: [17, 11, "in"], 5: [8.5, 14, "in"], 6: [5.5, 8.5, "in"], 7: [7.25, 10.5, "in"],
  8: [297, 420, "mm"], 9: [210, 297, "mm"], 10: [210, 297, "mm"], 11: [148, 210, "mm"], 12: [257, 364, "mm"], 13: [182, 257, "mm"],
  14: [8.5, 13, "in"], 15: [215, 275, "mm"], 16: [10, 14, "in"], 17: [11, 17, "in"], 18: [8.5, 11, "in"], 19: [3.875, 8.875, "in"],
  20: [4.125, 9.5, "in"], 27: [110, 220, "mm"], 28: [162, 229, "mm"], 29: [324, 458, "mm"], 30: [229, 324, "mm"], 31: [114, 162, "mm"],
  33: [250, 353, "mm"], 34: [176, 250, "mm"], 35: [176, 125, "mm"], 37: [3.875, 7.5, "in"], 38: [3.625, 6.5, "in"], 39: [14.875, 11, "in"],
  40: [8.5, 12, "in"], 41: [8.5, 13, "in"], 66: [420, 594, "mm"], 70: [105, 148, "mm"],
};

/** Paper size in dots (portrait); unknown codes and no page setup → A4. */
export function paperDots(code?: number): [number, number] {
  const p = PAPER[code ?? 9] ?? PAPER[9];
  const k = p[2] === "mm" ? 600 / 25.4 : 600;
  return [Math.round(p[0] * k), Math.round(p[1] * k)];
}

/**
 * Printed size of a column / row against the screen (px), from the Normal style's font (io/sheet/printFont.ts):
 * kx = printer digit width ÷ screen digit width (a column of w characters prints w × the printer digit: Calibri 11 = 47
 * dots, 맑은 고딕 11 = 51), ky = the printer font's row ÷ the screen's default row; `defPx` is the default row's
 * screen height that prints × ky (the stored one, or the font's row when Excel ignores the stored one).
 */
export function printFactors(sh: Pick<SheetData, "baseFont" | "baseSize" | "mdw" | "defRowH" | "defRowCustom">): { kx: number; ky: number; defPx: number } {
  const digit = printDigitDots(sh.baseFont, sh.baseSize);
  const font = printRowOf(sh.baseFont, sh.baseSize);
  const screen = screenRowPx(sh.baseFont, sh.baseSize);
  // (a font not in the table: as 맑은 고딕's ratios, the reader's default)
  if (digit == null || !font || screen == null) return { kx: 1.02, ky: 1, defPx: sh.defRowH };
  // rows: every row prints × ky, cut to whole dots — a set height (60 pt: 500 → 505 dots, omni-xlsx-print.7.pdf; a set
  // 30 pt row 252.7 → 252), a row Excel fitted to its text (20.25 pt: 168.75 → 170, omni-xlsx-print.4.pdf; Calibri 11's
  // fitted 28.8 pt row prints 242 at 121 ÷ 120) and the default row, which so prints at the printer font's row
  // whatever the screen row (맑은 고딕 11: 139 dots from a 16.5 pt row and from Excel 2021's 17.4 pt one,
  // qa/interop/adobe-made/excel_book.xlsx.ref.pdf) — Excel scales the screen's rows by the printer font's row over the
  // screen font's, and the sheet's stored default row is the screen font's row of the Excel that wrote it (16.5 pt at
  // 96 dpi, 17.4 pt at 120 for 맑은 고딕 11). A stored default row that is not an Excel screen row of the font — set
  // (customHeight, which Excel keeps: a set 18 pt default prints 151 dots in Calibri 11 and set rows stay 252) or far
  // from the font's row (which Excel ignores: a stored 18 pt Calibri 11 default without customHeight prints 121) —
  // says nothing of the screen, so the ratio is to the font's 96-dpi row; Excel's default rows are then the stored
  // height (set) or the font's row (ignored).
  const def = sh.defRowH * DOTS_PER_PX, own = screen * DOTS_PER_PX;
  // (near: an Excel at 120 dpi writes 0.82–1.13 × the 96-dpi row: 맑은 고딕 8 10.5 pt against 12.75, 맑은 고딕 12 19.2
  // against 17.25 — qa/interop/excel-made/omni-xlsx-print-fonts.truth.json)
  const near = !sh.defRowCustom && def >= own * 0.8 && def <= own * 1.15;
  const ky = font.row / (near ? def : own);
  return { kx: digit / (sh.mdw * DOTS_PER_PX), ky, defPx: near || sh.defRowCustom ? sh.defRowH : screen };
}

/** Printed row height in px at 100 % for a page's scale: × ky, whole dots at the scale (cut, not rounded). */
export function printRowPx(px: number, ky: number, s: number): number {
  return printRowDots(px * DOTS_PER_PX * ky, s) / DOTS_PER_PX / s;
}
const printRowDots = (dots: number, s: number) => Math.floor(dots * s + 1e-6);

/**
 * Excel leaves a few dots unused at the far edge of the printable area: a column or row that would end within them goes
 * to the next page (measured: rows and columns both break 3–14 dots before the margin).
 */
const EDGE = 9;

export interface PrintMargins {
  l: number;
  r: number;
  t: number;
  b: number;
  header: number;
  footer: number;
}

export interface PrintPage {
  /** 0-based index among the sheet's printed pages, the printed page number (&P), and the count (&N) */
  index: number;
  number: number;
  total: number;
  /** paper in px (96 dpi), orientation applied */
  width: number;
  height: number;
  landscape: boolean;
  /** rows / columns of this page, inclusive (hidden ones inside are skipped when printing) */
  rows: [number, number];
  cols: [number, number];
  /** print titles repeated at the top / left of this page */
  titleRows?: [number, number];
  titleCols?: [number, number];
  /** print scale (1 = 100 %) and the printed size of columns / rows against the screen */
  scale: number;
  kx: number;
  ky: number;
  /** the default row's screen height (px) that prints × ky (printFactors) */
  defPx: number;
  /** margins, px */
  margins: PrintMargins;
  /** printed block (headings + titles + cells) on the page, px: top-left after centering, and size */
  x: number;
  y: number;
  w: number;
  h: number;
  /** printed headings (row numbers / column letters): their width / height, px (0 = not printed) */
  headW: number;
  headH: number;
  grid: boolean;
}

const DEF_MARGINS: PrintMargins = { l: 0.7, r: 0.7, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 };

/** Hooks that extend the printed range past the cells (pictures, charts…): the last row / column they cover. */
export const printExtentHooks: ((sh: SheetData) => { r1: number; c1: number } | null)[] = [];

/** Last row / column Excel prints when there is no print area: values, formulas, and cells with a fill or border. */
export function printExtent(sh: SheetData): { r1: number; c1: number } {
  let r1 = -1, c1 = -1;
  const visible = (s?: number) => {
    const st = s ? sh.styles[s] : undefined;
    return !!st && !!(st.fill || st.bl || st.br || st.bt || st.bb);
  };
  for (const [a, c] of Object.entries(sh.cells)) {
    if ((c.v === undefined || c.v === "") && !c.f && !visible(c.s)) continue;
    const p = parseAddr(a);
    if (!p) continue;
    if (p.r > r1) r1 = p.r;
    if (p.c > c1) c1 = p.c;
  }
  for (const m of sh.merges) {
    const g = parseRange(m);
    if (g && g.r0 <= r1 && g.c0 <= c1) {
      r1 = Math.max(r1, g.r1);
      c1 = Math.max(c1, g.c1);
    }
  }
  for (const h of printExtentHooks) {
    const e = h(sh);
    if (e) {
      r1 = Math.max(r1, e.r1);
      c1 = Math.max(c1, e.c1);
    }
  }
  return { r1, c1 };
}

/** Lines (rows or columns) of a range with their printed size in dots at a scale; hidden lines left out. */
function lines(n0: number, n1: number, size: (i: number) => number, hidden: Set<number>, k: number, s: number, row = false) {
  const out: { i: number; d: number }[] = [];
  for (let i = n0; i <= n1; i++) {
    if (hidden.has(i)) continue;
    const px = size(i);
    if (px <= 0) continue;
    out.push({ i, d: row ? printRowDots(px * DOTS_PER_PX * k, s) : Math.round(px * DOTS_PER_PX * k * s) });
  }
  return out;
}

/** Split lines into pages: whole lines in `avail` dots, titles taking their space on pages past them, manual breaks. */
function split(ls: { i: number; d: number }[], avail: number, title: { end: number; d: number } | null, breaks: Set<number>): [number, number][] {
  const out: [number, number][] = [];
  let k = 0;
  while (k < ls.length) {
    const start = k;
    let used = (title && ls[k].i > title.end ? title.d : 0) + ls[k].d;
    k++;
    while (k < ls.length && !breaks.has(ls[k].i) && used + ls[k].d <= avail - EDGE) used += ls[k++].d;
    out.push([ls[start].i, ls[k - 1].i]);
  }
  return out;
}

const sum = (ls: { d: number }[]) => ls.reduce((a, l) => a + l.d, 0);

/** Cache by sheet object, checked against what pagination reads (the grid view changes sizes in place). */
const pageCache = new WeakMap<SheetData, { sig: string; pages: PrintPage[] }>();
const signature = (sh: SheetData) => {
  let cw = 0, rh = 0;
  for (const k in sh.colW) cw += sh.colW[k] * (Number(k) + 1);
  for (const k in sh.rowH) rh += sh.rowH[k] * (Number(k) + 1);
  return [Object.keys(sh.cells).length, sh.styles.length, sh.merges.length, cw, rh, sh.defColW, sh.defRowH, sh.defRowCustom, sh.hiddenRows?.length, sh.hiddenCols?.length, sh.baseFont, sh.baseSize, JSON.stringify(sh.print ?? null)].join("|");
};

/** The printed pages of a sheet, in print order (Excel's pagination). An empty sheet prints one empty page. */
export function sheetPrintPages(sh: SheetData): PrintPage[] {
  const sig = signature(sh);
  const hit = pageCache.get(sh);
  if (hit && hit.sig === sig) return hit.pages;
  const pages = paginate(sh);
  pageCache.set(sh, { sig, pages });
  return pages;
}

function paginate(sh: SheetData): PrintPage[] {
  const pr = sh.print ?? {};
  const [pw, ph] = paperDots(pr.paper);
  const landscape = !!pr.landscape;
  const W = landscape ? ph : pw, H = landscape ? pw : ph;
  const mi = pr.margins ?? DEF_MARGINS;
  const m = { l: mi.l * 600, r: mi.r * 600, t: mi.t * 600, b: mi.b * 600 };
  const { kx, ky, defPx } = printFactors(sh);
  const hr = new Set(sh.hiddenRows ?? []), hc = new Set(sh.hiddenCols ?? []);
  const colPx = (c: number) => sh.colW[c] ?? sh.defColW;
  const rowPx = (r: number) => sh.rowH[r] ?? defPx;
  // areas: the print area's ranges, or A1 to the last printed cell
  let areas: Rect[] = (pr.area ?? []).map((a) => parseRange(a)).filter((g): g is Rect => !!g);
  if (!areas.length) {
    const e = printExtent(sh);
    areas = [{ r0: 0, c0: 0, r1: Math.max(0, e.r1), c1: Math.max(0, e.c1) }];
  }
  // (a guard: at most 200 000 rows / 4 000 columns of one area)
  areas = areas.map((g) => ({ r0: Math.max(0, g.r0), c0: Math.max(0, g.c0), r1: Math.min(MAX_ROW, g.r1, g.r0 + 200_000), c1: Math.min(MAX_COL, g.c1, g.c0 + 4_000) }));
  const tr = pr.titleRows, tc = pr.titleCols;
  const rowBreaks = new Set(pr.rowBreaks ?? []), colBreaks = new Set(pr.colBreaks ?? []);
  const none = new Set<number>();
  // printed headings: a column as wide as the row numbers, a row as tall as a default row
  const headings = !!pr.headings;
  const lastRow = Math.max(...areas.map((a) => a.r1)) + 1;
  const digit = (kx * sh.mdw * DOTS_PER_PX); // printer digit, dots at 100 %
  const headWBase = headings ? String(lastRow).length * digit + 93 : 0;
  const headHBase = headings ? defPx * DOTS_PER_PX * ky : 0; // a printed default row

  // layout of one area at a scale: row bands × column bands
  const layout = (g: Rect, s: number, manual: boolean) => {
    const rl = lines(g.r0, g.r1, rowPx, hr, ky, s, true), cl = lines(g.c0, g.c1, colPx, hc, kx, s);
    const hw = Math.round(headWBase * s), hh = Math.round(headHBase * s);
    const trl = tr ? lines(tr[0], tr[1], rowPx, hr, ky, s, true) : [], tcl = tc ? lines(tc[0], tc[1], colPx, hc, kx, s) : [];
    const availW = W - m.l - m.r - hw, availH = H - m.t - m.b - hh;
    const rows = rl.length ? split(rl, availH, tr ? { end: tr[1], d: sum(trl) } : null, manual ? rowBreaks : none) : [[g.r0, g.r0] as [number, number]];
    const cols = cl.length ? split(cl, availW, tc ? { end: tc[1], d: sum(tcl) } : null, manual ? colBreaks : none) : [[g.c0, g.c0] as [number, number]];
    return { rows, cols, rl, cl, trl, tcl, hw, hh };
  };
  // scale: fit to pages = the largest whole percent (10–100) whose layout fits; manual breaks do not apply then
  const fit = pr.fit;
  const scaleOf = (g: Rect) => {
    if (!fit || (!fit.w && !fit.h)) return (pr.scale ?? 100) / 100;
    // start near the scale the total size allows (a page holds less than its share: whole lines only)
    const L1 = layout(g, 1, false);
    const est = Math.min(
      fit.w ? (fit.w * (W - m.l - m.r - L1.hw)) / Math.max(1, sum(L1.cl) + (tc ? sum(L1.tcl) * (fit.w - 1) : 0)) : 1,
      fit.h ? (fit.h * (H - m.t - m.b - L1.hh)) / Math.max(1, sum(L1.rl) + (tr ? sum(L1.trl) * (fit.h - 1) : 0)) : 1,
    );
    for (let p = Math.min(100, Math.ceil(est * 100) + 1); p > 10; p--) {
      const L = p === 100 ? L1 : layout(g, p / 100, false);
      if ((!fit.w || L.cols.length <= fit.w) && (!fit.h || L.rows.length <= fit.h)) return p / 100;
    }
    return 0.1;
  };

  const out: PrintPage[] = [];
  for (const g of areas) {
    const s = scaleOf(g);
    const L = layout(g, s, !fit || (!fit.w && !fit.h));
    const lineSum = (ls: { i: number; d: number }[], a: number, b: number) => ls.reduce((t, l) => t + (l.i >= a && l.i <= b ? l.d : 0), 0);
    const order: [number, number][][] = [];
    if (pr.overThenDown) for (const r of L.rows) for (const c of L.cols) order.push([r, c]);
    else for (const c of L.cols) for (const r of L.rows) order.push([r, c]);
    for (const [r, c] of order) {
      const titleRows = tr && r[0] > tr[1] ? tr : undefined;
      const titleCols = tc && c[0] > tc[1] ? tc : undefined;
      const w = L.hw + (titleCols ? sum(L.tcl) : 0) + lineSum(L.cl, c[0], c[1]);
      const h = L.hh + (titleRows ? sum(L.trl) : 0) + lineSum(L.rl, r[0], r[1]);
      // centring: Excel centres the block with two line slots (8 dots each) added to it (omni-xlsx-print.9.pdf)
      const x = m.l + (pr.hCenter ? Math.max(0, (W - m.l - m.r - w - 16) / 2) : 0);
      const y = m.t + (pr.vCenter ? Math.max(0, (H - m.t - m.b - h - 16) / 2) : 0);
      const px = (d: number) => d / DOTS_PER_PX;
      out.push({
        index: out.length,
        number: 0,
        total: 0,
        width: px(W),
        height: px(H),
        landscape,
        rows: r,
        cols: c,
        ...(titleRows ? { titleRows } : {}),
        ...(titleCols ? { titleCols } : {}),
        scale: s,
        kx,
        ky,
        defPx,
        margins: { l: px(m.l), r: px(m.r), t: px(m.t), b: px(m.b), header: mi.header * 96, footer: mi.footer * 96 },
        x: px(x),
        y: px(y),
        w: px(w),
        h: px(h),
        headW: px(L.hw),
        headH: px(L.hh),
        grid: !!pr.grid,
      });
    }
  }
  const first = pr.firstPage ?? 1;
  for (const p of out) {
    p.number = first + p.index;
    p.total = out.length;
  }
  return out;
}

/** Printed size of a line in px at 100 % for a page's scale: whole dots at the scale, as Excel prints it. */
export function printLinePx(px: number, k: number, s: number): number {
  return Math.round(px * DOTS_PER_PX * k * s) / DOTS_PER_PX / s;
}
