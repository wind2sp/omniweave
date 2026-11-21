// Sheets ↔ tables: a sheet laid out as table pages (printing, PDF / DOCX / slide exports, sending a range to a
// document — Omniweave's one-canvas strength), and a table turned into a sheet (saving document tables as a workbook).

import type { SheetCell, SheetData, SheetStyle } from "../../core/sheetTypes";
import type { Align, OmwDocument, Page, TableCell } from "../../core/types";
import { newImage, uid } from "../../core/types";
import { makeAsset } from "../../core/assets";
import { encodePng } from "../formats/png";
import { tablePages } from "../formats/csv";
import { addr, parseAddr, parseRange, type Rect } from "./formula";
import { formatValue, type SheetLang } from "./numfmt";
import { sheetPrintPages } from "./printLayout";

/** Text a cell shows (number format applied; no column-width effects). */
export function cellText(sh: SheetData, cell: SheetCell | undefined, lang?: SheetLang): string {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  return formatValue(cell.v, sh.styles[cell.s ?? 0]?.fmt, { date1904: sh.date1904, lang: lang ?? sh.lang ?? "en" }).text;
}

/** Last used row / column (0-based; −1 when the sheet is empty). */
export function usedRange(sh: SheetData): { r1: number; c1: number } {
  let r1 = -1, c1 = -1;
  for (const [a, c] of Object.entries(sh.cells)) {
    if (c.v === undefined && !c.f) continue;
    const p = parseAddr(a);
    if (!p) continue;
    if (p.r > r1) r1 = p.r;
    if (p.c > c1) c1 = p.c;
  }
  for (const m of sh.merges) {
    const g = parseRange(m);
    if (g && sh.cells[addr(g.r0, g.c0)]?.v !== undefined) {
      r1 = Math.max(r1, g.r1);
      c1 = Math.max(c1, g.c1);
    }
  }
  return { r1, c1 };
}

const ALIGN: Record<string, Align> = { center: "CENTER", centerContinuous: "CENTER", right: "RIGHT", left: "LEFT", justify: "JUSTIFY" as Align };

/** Table cells of a sheet area (hidden rows / columns left out, merges as spans). */
export function sheetCells(sh: SheetData, g?: Rect): { rows: TableCell[][]; widths: number[] } {
  const u = usedRange(sh);
  const area = g ?? { r0: 0, c0: 0, r1: u.r1, c1: u.c1 };
  const hr = new Set(sh.hiddenRows ?? []), hc = new Set(sh.hiddenCols ?? []);
  const cols: number[] = [];
  for (let c = area.c0; c <= area.c1; c++) if (!hc.has(c)) cols.push(c);
  const rowsIdx: number[] = [];
  for (let r = area.r0; r <= area.r1; r++) if (!hr.has(r)) rowsIdx.push(r);
  const merges = sh.merges.map(parseRange).filter((m): m is Rect => !!m);
  const rows = rowsIdx.map((r) =>
    cols.map((c) => {
      const cell = sh.cells[addr(r, c)];
      const st: SheetStyle = sh.styles[cell?.s ?? 0] ?? {};
      const out: TableCell = { text: cellText(sh, cell) };
      if (st.bold) out.bold = true;
      if (st.italic) out.italic = true;
      if (st.color) out.color = st.color;
      if (st.fill) out.fill = st.fill;
      const h = st.h ? ALIGN[st.h] : typeof cell?.v === "number" ? "RIGHT" : typeof cell?.v === "boolean" ? "CENTER" : undefined;
      if (h) out.align = h;
      if (st.v === "center") out.vAlign = "middle";
      else if (!st.v || st.v === "bottom") out.vAlign = "bottom";
      if (cell?.f) out.formula = cell.f;
      if (st.fmt && typeof cell?.v === "number") out.numFmt = st.fmt;
      const m = merges.find((x) => x.r0 === r && x.c0 === c);
      if (m) {
        const cs = cols.filter((x) => x >= m.c0 && x <= m.c1).length, rs = rowsIdx.filter((x) => x >= m.r0 && x <= m.r1).length;
        if (cs > 1) out.colSpan = cs;
        if (rs > 1) out.rowSpan = rs;
      }
      return out;
    }),
  );
  return { rows, widths: cols.map((c) => sh.colW[c] ?? sh.defColW) };
}

/** A sheet laid out as table pages (A4, split across pages like a print). */
export function sheetTablePages(page: Page): Page[] {
  const sh = page.sheet!;
  const { rows, widths } = sheetCells(sh);
  if (!rows.length) return [{ ...page, sheet: undefined, nodes: [] }];
  const pages = tablePages(rows, page.name, page.source ? { format: page.source.format, name: page.source.name } : undefined, sh.name, widths);
  for (const p of pages)
    for (const n of p.nodes)
      if (n.type === "TABLE") {
        n.headerRow = false;
        n.headerFill = n.background ?? "#ffffff";
        n.fontFamily = sh.baseFont;
        n.fontSize = Math.round((sh.baseSize * 96) / 72);
      }
  return pages;
}

/** The document with sheet pages laid out as table pages (exports that write pages, not workbooks). */
export function expandSheetPages(doc: OmwDocument, page?: Page): { doc: OmwDocument; page?: Page } {
  if (!doc.pages.some((p) => p.sheet)) return { doc, page };
  let cur = page;
  const pages = doc.pages.flatMap((p) => {
    if (!p.sheet) return [p];
    const out = sheetTablePages(p);
    if (page && p.id === page.id) cur = out[0];
    return out;
  });
  return { doc: { ...doc, pages }, page: cur };
}

/** PNG of a canvas (native encoder; the JS one when the canvas has none). */
async function canvasPng(c: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  if ("convertToBlob" in c) return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
  if (blob) return new Uint8Array(await blob.arrayBuffer());
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  return encodePng(d.data, c.width, c.height, 6);
}

/** Resolution of a printed page picture against 96 dpi (2 = 192 dpi). */
const PRINT_PICTURE_SCALE = 2;

/**
 * The document with sheet pages as Excel prints them, for outputs with fixed pages (PDF, pictures, printing): one page
 * per printed page (io/sheet/printLayout.ts — Excel's page count, paper and orientation), holding that page painted
 * as a picture by the sheet painter (render/sheetPrint.ts) at 192 dpi. A picture is what matches Excel's PDF: the
 * sheet painter draws cells, number formats, conditional formats, borders and drawings as Excel does, which the
 * page writers' table node cannot (fonts, overflowing text, merged areas, data bars). Without a canvas (Node) the
 * sheet is laid out as table pages instead (expandSheetPages).
 */
export async function expandSheetPrintPages(doc: OmwDocument, page?: Page): Promise<{ doc: OmwDocument; page?: Page }> {
  if (!doc.pages.some((p) => p.sheet)) return { doc, page };
  const canvas = typeof OffscreenCanvas !== "undefined" || typeof document !== "undefined";
  if (!canvas) return expandSheetPages(doc, page);
  const { paintPrintPage } = await import("../../render/sheetPrint");
  // charts and pictures painted synchronously below: their painter / decoded images first
  await (await import("../../render/sheetDrawings")).preloadDrawings(doc.pages.flatMap((p) => (p.sheet ? [p.sheet] : [])));
  const assets = { ...doc.assets };
  const pages: Page[] = [];
  let cur = page;
  for (const p of doc.pages) {
    const sh = p.sheet;
    if (!sh) {
      pages.push(p);
      continue;
    }
    const prints = sheetPrintPages(sh);
    const book = doc.pages.filter((q) => q.sheet?.book === sh.book).map((q) => q.sheet!);
    for (const pg of prints) {
      const w = Math.round(pg.width), h = Math.round(pg.height);
      const cw = Math.round(w * PRINT_PICTURE_SCALE), ch = Math.round(h * PRINT_PICTURE_SCALE);
      const cv: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(cw, ch) : Object.assign(document.createElement("canvas"), { width: cw, height: ch });
      const cx = cv.getContext("2d") as CanvasRenderingContext2D;
      cx.fillStyle = "#ffffff";
      cx.fillRect(0, 0, cw, ch);
      paintPrintPage(cx, sh, pg, cw, ch, sh.lang ?? "en", { sheets: book, fileName: p.source?.name });
      const name = prints.length > 1 ? `${p.name} (${pg.index + 1}/${prints.length})` : p.name;
      const asset = makeAsset(await canvasPng(cv), "image/png", `${name}.png`);
      assets[asset.id] = asset;
      const img = newImage(asset.id, w, h, name);
      img.locked = true;
      const out: Page = { ...p, id: pg.index ? uid("pg") : p.id, name, sheet: undefined, width: w, height: h, nodes: [img], groups: undefined };
      pages.push(out);
      if (page && p.id === page.id && pg.index === 0) cur = out;
    }
  }
  return { doc: { ...doc, pages, assets }, page: cur };
}

/** A table (document, CSV) as a sheet: texts that read as numbers become numbers, formulas are kept. */
export function tableToSheet(name: string, rows: TableCell[][], widths: number[], book = uid("bk")): SheetData {
  const sh: SheetData = { book, name, cells: {}, styles: [{}], colW: {}, rowH: {}, defColW: 72, defRowH: 22, merges: [], grid: true, headings: true, baseFont: "맑은 고딕", baseSize: 11, mdw: 8 }; // i18n: keep — font name written to the file
  const styleIdx = new Map<string, number>([["{}", 0]]);
  widths.forEach((w, c) => (sh.colW[c] = Math.round(w)));
  rows.forEach((row, r) =>
    row.forEach((tc, c) => {
      const st: SheetStyle = {};
      if (tc.bold) st.bold = true;
      if (tc.italic) st.italic = true;
      if (tc.color && tc.color.toLowerCase() !== "#000000") st.color = tc.color;
      if (tc.fill) st.fill = tc.fill;
      if (tc.align === "CENTER") st.h = "center";
      else if (tc.align === "RIGHT") st.h = "right";
      if (tc.numFmt) st.fmt = tc.numFmt;
      const k = JSON.stringify(st);
      let s = styleIdx.get(k);
      if (s === undefined) {
        s = sh.styles.push(st) - 1;
        styleIdx.set(k, s);
      }
      const cell: SheetCell = {};
      const text = tc.text;
      const num = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text.trim()) && !/^-?0\d/.test(text.trim()) ? Number(text) : null;
      if (tc.formula) cell.f = tc.formula;
      if (num != null) cell.v = num;
      else if (text) cell.v = text;
      if (s) cell.s = s;
      if (cell.v === undefined && !cell.f && !cell.s) return;
      sh.cells[addr(r, c)] = cell;
      if ((tc.colSpan ?? 1) > 1 || (tc.rowSpan ?? 1) > 1) sh.merges.push(`${addr(r, c)}:${addr(r + (tc.rowSpan ?? 1) - 1, c + (tc.colSpan ?? 1) - 1)}`);
    }),
  );
  return sh;
}
