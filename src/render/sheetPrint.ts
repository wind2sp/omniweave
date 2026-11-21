// A printed page of a sheet (표 계산 인쇄 쪽), as Excel prints it: the page's rows and columns (io/sheet/printLayout.ts)
// at the print scale inside the margins, centred when the page setup says so, print titles repeated above / left,
// printed gridlines and headings, and the header / footer text (&P &N &D &T &A &F codes, &L &C &R sections).
// The cells are painted by the sheet painter (render/sheet.ts paintSheet), so cell formats, conditional formats and
// the sheet's drawings appear as on screen; title blocks leave the drawings out (Excel does not repeat them).

import type { SheetData } from "../core/sheetTypes";
import { colLetters } from "../io/sheet/formula";
import type { SheetLang } from "../io/sheet/numfmt";
import { printLinePx, printRowPx, sheetPrintPages, type PrintPage } from "../io/sheet/printLayout";
import { geomOf, paintSheet, printFontPx, printGridline, PRINT_DOT } from "./sheet";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** The sheet as it prints at a scale: columns / rows in printed px (whole dots at the scale), no frozen panes. */
const printCache = new WeakMap<SheetData, Map<string, SheetData>>();
function printSheet(sh: SheetData, pg: PrintPage): SheetData {
  const key = `${pg.scale}|${pg.kx}|${pg.ky}|${pg.defPx}|${pg.grid}`;
  let m = printCache.get(sh);
  if (!m) printCache.set(sh, (m = new Map()));
  let ps = m.get(key);
  if (!ps) {
    const scaled = (o: Record<number, number>, f: (v: number) => number) => {
      const out: Record<number, number> = {};
      for (const [i, v] of Object.entries(o)) out[Number(i)] = f(v);
      return out;
    };
    const col = (v: number) => printLinePx(v, pg.kx, pg.scale);
    const rowH: Record<number, number> = {};
    for (const [i, v] of Object.entries(sh.rowH)) rowH[Number(i)] = v > 0 ? printRowPx(v, pg.ky, pg.scale) : v;
    ps = { ...sh, colW: scaled(sh.colW, col), rowH, defColW: col(sh.defColW), defRowH: printRowPx(pg.defPx, pg.ky, pg.scale), freeze: undefined, topLeft: undefined, grid: pg.grid };
    m.set(key, ps);
  }
  return ps;
}

/** Header / footer sections with the codes filled in (Excel &-codes; formatting codes are left out). */
export function headerFooterText(src: string, page: Pick<PrintPage, "number" | "total">, sheetName: string, fileName = "", now = new Date()): { L: string; C: string; R: string; size?: number } {
  const out = { L: "", C: "", R: "" } as { L: string; C: string; R: string; size?: number };
  let sec: "L" | "C" | "R" = "C";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== "&") {
      out[sec] += ch;
      continue;
    }
    const n = src[++i] ?? "";
    if (n === "&") out[sec] += "&";
    else if (n === "L" || n === "C" || n === "R") sec = n;
    else if (n === "P" || n === "N") {
      let v = n === "P" ? page.number : page.total;
      const m = /^([+-])(\d+)/.exec(src.slice(i + 1));
      if (m) {
        v += (m[1] === "+" ? 1 : -1) * Number(m[2]);
        i += m[0].length;
      }
      out[sec] += String(v);
    } else if (n === "D") out[sec] += now.toLocaleDateString();
    else if (n === "T") out[sec] += now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    else if (n === "A") out[sec] += sheetName;
    else if (n === "F") out[sec] += fileName;
    else if (n === "Z") out[sec] += "";
    else if (n === '"') {
      const e = src.indexOf('"', i + 1);
      i = e < 0 ? src.length : e; // &"font,style"
    } else if (n === "K") i += /^[0-9A-Fa-f]{6}/.test(src.slice(i + 1)) ? 6 : /^\d\d[+-]\d{3}/.test(src.slice(i + 1)) ? 6 : 0;
    else if (/\d/.test(n)) {
      const m = /^\d+/.exec(src.slice(i))!;
      out.size = Number(m[0]);
      i += m[0].length - 1;
    }
    // &B &I &U &E &S &X &Y &G and anything unknown: no text
  }
  return out;
}

export interface PrintPaintOptions {
  /** file name for &F */
  fileName?: string;
  /** the other sheets of the book (conditional formats that refer to them) */
  sheets?: SheetData[];
}

/** Paint one printed page into a page of `width` × `height` px (the paper is fitted in, keeping its proportions). */
export function paintPrintPage(ctx: Ctx, sh: SheetData, pg: PrintPage, width: number, height: number, lang: SheetLang = sh.lang ?? "en", opt: PrintPaintOptions = {}) {
  const k = Math.min(width / pg.width, height / pg.height);
  const ps = printSheet(sh, pg);
  const g = geomOf(ps);
  const s = pg.scale;
  const span = (axis: typeof g.cols, a: number, b: number) => (axis.pos(b + 1) - axis.pos(a)) * s;
  ctx.save();
  ctx.scale(k, k);
  const x0 = pg.x + pg.headW, y0 = pg.y + pg.headH;
  const tw = pg.titleCols ? span(g.cols, pg.titleCols[0], pg.titleCols[1]) : 0;
  const th = pg.titleRows ? span(g.rows, pg.titleRows[0], pg.titleRows[1]) : 0;
  const bw = span(g.cols, pg.cols[0], pg.cols[1]), bh = span(g.rows, pg.rows[0], pg.rows[1]);
  const block = (rows: [number, number], cols: [number, number], x: number, y: number, drawings: boolean) => {
    const w = span(g.cols, cols[0], cols[1]), h = span(g.rows, rows[0], rows[1]);
    if (w <= 0 || h <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    // the block's last line slots (and medium borders on its first lines) reach past it
    ctx.rect(-8 * PRINT_DOT, -8 * PRINT_DOT, w + 24 * PRINT_DOT, h + 24 * PRINT_DOT);
    ctx.clip();
    paintSheet(ctx, ps, { width: w, height: h, zoom: s, scrollX: g.cols.pos(cols[0]), scrollY: g.rows.pos(rows[0]), headings: false, lang, sheets: opt.sheets, gridColor: GRID, ...(drawings ? {} : { drawings: false }) });
    ctx.restore();
  };
  if (pg.titleRows && pg.titleCols) block(pg.titleRows, pg.titleCols, x0, y0, false);
  if (pg.titleRows) block(pg.titleRows, pg.cols, x0 + tw, y0, false);
  if (pg.titleCols) block(pg.rows, pg.titleCols, x0, y0 + th, false);
  block(pg.rows, pg.cols, x0 + tw, y0 + th, true);
  // printed gridlines: the block's first (left / top) lines — the painter draws each cell's right / bottom one
  const W = tw + bw, H = th + bh;
  if (pg.grid) {
    ctx.fillStyle = GRID;
    ctx.strokeStyle = GRID;
    printGridline(ctx, true, x0, y0 + 4 * PRINT_DOT, y0 + H + 16 * PRINT_DOT);
    printGridline(ctx, false, y0, x0 + 4 * PRINT_DOT, x0 + W + 16 * PRINT_DOT);
  }
  if (pg.headW || pg.headH) paintPrintHeadings(ctx, ps, pg, x0, y0);
  else if (pg.grid) printFrame(ctx, x0, y0, x0 + W, y0 + H);
  // header / footer
  const pr = sh.print;
  const first = pg.index === 0 && pr?.firstHeader !== undefined;
  const hd = first ? pr?.firstHeader : pr?.header, ft = first ? pr?.firstFooter : pr?.footer;
  if (hd) paintHeaderFooter(ctx, sh, pg, hd, true, opt.fileName);
  if (ft) paintHeaderFooter(ctx, sh, pg, ft, false, opt.fileName);
  ctx.restore();
}

const GRID = "#000000";

/** An 8-dot printed line (thin border, heading line, frame) in the slot after `at`, from `from` to `to`. */
function slotLine(ctx: Ctx, vertical: boolean, at: number, from: number, to: number) {
  const hair = 1 / Math.max(1e-6, Math.hypot(ctx.getTransform().a, ctx.getTransform().b));
  const D = PRINT_DOT;
  ctx.beginPath();
  if (vertical) {
    ctx.moveTo(at + D / 2, from + D / 2);
    ctx.lineTo(at + D / 2, to - D / 2);
  } else {
    ctx.moveTo(from + D / 2, at + D / 2);
    ctx.lineTo(to - D / 2, at + D / 2);
  }
  ctx.lineWidth = hair;
  ctx.lineCap = "square";
  ctx.lineJoin = "round";
  ctx.stroke();
  if (vertical) ctx.fillRect(at, from, 8 * D, to - from);
  else ctx.fillRect(from, at, to - from, 8 * D);
}

/** The frame Excel prints around gridlines / headings: 8-dot lines in the first and the last line slots. */
function printFrame(ctx: Ctx, x: number, y: number, x1: number, y1: number) {
  ctx.save();
  ctx.fillStyle = GRID;
  ctx.strokeStyle = GRID;
  const e = 8 * PRINT_DOT;
  slotLine(ctx, false, y, x, x1 + e);
  slotLine(ctx, true, x, y, y1 + e);
  slotLine(ctx, true, x1, y, y1 + e);
  slotLine(ctx, false, y1, x, x1 + e);
  ctx.restore();
}

/**
 * Printed headings as Excel's PDF has them (omni-xlsx-print.10.pdf): the heading column / row inside the frame, a line
 * slot after each column / row, letters centred over the column's text area and row numbers in the heading column,
 * in the Normal font at 10 / 11 of its size (whole dots).
 */
function paintPrintHeadings(ctx: Ctx, ps: SheetData, pg: PrintPage, x0: number, y0: number) {
  const g = geomOf(ps);
  const s = pg.scale;
  const D = PRINT_DOT;
  ctx.save();
  ctx.fillStyle = GRID;
  ctx.strokeStyle = GRID;
  ctx.font = `${printFontPx((ps.baseSize * 10) / 11, s)}px "${ps.baseFont}", "맑은 고딕", "Malgun Gothic", sans-serif`; // i18n: keep — font names
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const hx = x0 - pg.headW, hy = y0 - pg.headH;
  const runs = (title: [number, number] | undefined, body: [number, number]) => [...(title ? [title] : []), body];
  const colEnds: number[] = [], rowEnds: number[] = [];
  // column letters: centred over the text area, 42 dots × scale above the heading row's bottom line
  let x = x0;
  for (const [a, b] of runs(pg.titleCols, pg.cols))
    for (let c = a; c <= b; c++) {
      const w = g.cols.size(c) * s;
      if (w <= 0) continue;
      ctx.fillText(colLetters(c), x + (8 * D + w) / 2, y0 - 42 * s * D);
      x += w;
      colEnds.push(x);
    }
  // row numbers: 33 dots × scale above the row's bottom line
  let y = y0;
  for (const [a, b] of runs(pg.titleRows, pg.rows))
    for (let r = a; r <= b; r++) {
      const h = g.rows.size(r) * s;
      if (h <= 0) continue;
      y += h;
      ctx.fillText(String(r + 1), (hx + 8 * D + x0 + 7 * D) / 2, y - 33 * s * D);
      rowEnds.push(y);
    }
  // lines: after each column in the heading row, after each row in the heading column, the two heading edges, the frame
  for (const cx of colEnds.slice(0, -1)) slotLine(ctx, true, cx, hy + 7 * D, y0 + 7 * D);
  for (const ry of rowEnds.slice(0, -1)) slotLine(ctx, false, ry, hx + 8 * D, x0 + 7 * D);
  slotLine(ctx, true, x0, hy + 7 * D, y + 8 * D);
  slotLine(ctx, false, y0, hx + 8 * D, x + 8 * D);
  printFrame(ctx, hx, hy, x, y);
  ctx.restore();
}

function paintHeaderFooter(ctx: Ctx, sh: SheetData, pg: PrintPage, src: string, top: boolean, fileName?: string) {
  const t = headerFooterText(src, pg, sh.name, fileName);
  const size = printFontPx(t.size ?? sh.baseSize, pg.scale); // whole printer dots, as Excel prints it
  ctx.save();
  ctx.fillStyle = "#000000";
  ctx.font = `${size}px "${sh.baseFont}", "맑은 고딕", "Malgun Gothic", sans-serif`; // i18n: keep — font names
  ctx.textBaseline = "alphabetic";
  const lh = size * 1.25;
  for (const [sec, align, x] of [["L", "left", pg.margins.l + 8 * PRINT_DOT], ["C", "center", pg.width / 2], ["R", "right", pg.width - pg.margins.r - 8 * PRINT_DOT]] as const) {
    const lines = t[sec].split(/\r?\n/);
    if (!t[sec]) continue;
    ctx.textAlign = align;
    lines.forEach((ln, i) => {
      const y = top ? pg.margins.header + size * 1.178 + i * lh : pg.height - pg.margins.footer - size * 0.502 - (lines.length - 1 - i) * lh;
      ctx.fillText(ln, x, y);
    });
  }
  ctx.restore();
}

/** Paint print page `index` of a sheet (pages laid out by io/sheet/printLayout.ts). */
export function paintSheetPrintPage(ctx: Ctx, sh: SheetData, width: number, height: number, lang: SheetLang, index: number, opt?: PrintPaintOptions) {
  const pages = sheetPrintPages(sh);
  paintPrintPage(ctx, sh, pages[Math.max(0, Math.min(pages.length - 1, index))], width, height, lang, opt);
}
