// XLS (Excel 97-2003, BIFF8) written anew from the sheet models — for an .xls whose edits the record patcher
// (xlsWrite.ts: cell values into the original file) cannot carry: formulas typed in, formats, rows / columns inserted or
// deleted, sheets added … Excel keeps an .xls an .xls on 저장 (with its compatibility check); so does Omniweave.
//
// What is written: every sheet's cells (numbers, texts in the shared string table, logical / error values, formulas
// with their cached results), cell formats (fonts, number formats, fills, borders, alignment, wrap, indent, rotation,
// protection), column widths and row heights, hidden / outline rows and columns, merged cells, frozen panes, gridlines /
// headings, hidden sheets and the 1904 date system. What BIFF8 cannot hold here is listed for the person before the
// save (charts and pictures, conditional formats, data validation, notes, hyperlinks, AutoFilter, tables, sparklines,
// pivot tables, protection, page setup, defined names, cells past IV65536, functions newer than Excel 2003).
//
// Formulas are compiled from the expression tree (io/sheet/formula.ts) to BIFF8 parsed tokens: constants, cell / area
// references (3-D through EXTERNSHEET for other sheets), operators and the built-in functions of the Ftab table.
// Excel recalculates on load (no RECALCID → [MS-XLS] full recalculation).
//
// Source: [MS-XLS] Excel Binary File Format — Microsoft open specification. Omniweave's own implementation.

import type { SheetCell, SheetData, SheetStyle } from "../../core/sheetTypes";
import { t } from "../../i18n";
import { writeCfb } from "../crypto/cfbWrite";
import { readCfb } from "./cfb";
import { parseAddr, parseFormula, parseRange, type Ast } from "../sheet/formula";
import { ftabOf } from "../sheet/readXls";
import { widthChars } from "../sheet/read";

const MAX_ROWS = 65536, MAX_COLS = 256;

// ───── bytes ─────

class Buf {
  parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
  }
  u16(v: number) {
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16((v >>> 16) & 0xffff);
  }
  f64(v: number) {
    const b = new Uint8Array(new Float64Array([v]).buffer);
    for (const x of b) this.parts.push(x);
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.parts.push(b[i]);
  }
  /** XLUnicodeString (16-bit count) as UTF-16 */
  str16(s: string) {
    this.u16(s.length);
    this.u8(1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
  }
  /** ShortXLUnicodeString (8-bit count) as UTF-16 */
  str8(s: string) {
    this.u8(s.length);
    this.u8(1);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
  }
  get length() {
    return this.parts.length;
  }
}

/** One record (type, its data); data longer than 8224 bytes goes on in CONTINUE records. */
function rec(out: Buf, type: number, data: Buf | number[]) {
  const d = data instanceof Buf ? data.parts : data;
  let first = true;
  for (let i = 0; i < d.length || first; i += 8224) {
    const chunk = d.slice(i, i + 8224);
    out.u16(first ? type : 0x003c);
    out.u16(chunk.length);
    out.bytes(chunk);
    first = false;
  }
}

// ───── colours: the BIFF8 palette (56 entries from index 8), the colours of the workbook put in where needed ─────

const DEFAULT_PALETTE = "000000 FFFFFF FF0000 00FF00 0000FF FFFF00 FF00FF 00FFFF 800000 008000 000080 808000 800080 008080 C0C0C0 808080 9999FF 993366 FFFFCC CCFFFF 660066 FF8080 0066CC CCCCFF 000080 FF00FF FFFF00 00FFFF 800080 800000 008080 0000FF 00CCFF CCFFFF CCFFCC FFFF99 99CCFF FF99CC CC99FF FFCC99 3366FF 33CCCC 99CC00 FFCC00 FF9900 FF6600 666699 969696 003366 339966 003300 333300 993300 993366 333399 333333".split(" ");

class Palette {
  colors = [...DEFAULT_PALETTE];
  private free = 55;
  private taken = new Set<number>();
  index(hex: string | undefined): number | null {
    if (!hex) return null;
    const h = hex.replace("#", "").toUpperCase().slice(-6);
    let i = this.colors.indexOf(h);
    if (i >= 0) {
      this.taken.add(i);
      return i + 8;
    }
    // a slot of its own (from the end of the palette), else the nearest colour
    while (this.free >= 8 && this.taken.has(this.free)) this.free--;
    if (this.free >= 8) {
      i = this.free--;
      this.colors[i] = h;
      this.taken.add(i);
      return i + 8;
    }
    const rgb = (x: string) => [0, 2, 4].map((k) => parseInt(x.slice(k, k + 2), 16));
    const [r, g, b] = rgb(h);
    let best = 0, bd = Infinity;
    this.colors.forEach((c, k) => {
      const [r2, g2, b2] = rgb(c);
      const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
      if (d < bd) (bd = d), (best = k);
    });
    return best + 8;
  }
}

// ───── number formats ─────

const BUILTIN_FMT: Record<string, number> = { General: 0, "0": 1, "0.00": 2, "#,##0": 3, "#,##0.00": 4, "0%": 9, "0.00%": 10, "0.00E+00": 11, "# ?/?": 12, "# ??/??": 13, "h:mm AM/PM": 18, "h:mm:ss AM/PM": 19, "h:mm": 20, "h:mm:ss": 21, "mm:ss": 45, "[h]:mm:ss": 46, "@": 49 };

// ───── formulas → parsed tokens ─────

class Refuse extends Error {}

interface FCtx {
  own: string;
  sheetIndex: (name: string) => number | null;
  xti: (sheet: number) => number;
}

const OPS: Record<string, number> = { "+": 0x03, "-": 0x04, "*": 0x05, "/": 0x06, "^": 0x07, "&": 0x08, "<": 0x09, "<=": 0x0a, "=": 0x0b, ">=": 0x0c, ">": 0x0d, "<>": 0x0e, ":": 0x11 };
const ERRS: Record<string, number> = { "#NULL!": 0x00, "#DIV/0!": 0x07, "#VALUE!": 0x0f, "#REF!": 0x17, "#NAME?": 0x1d, "#NUM!": 0x24, "#N/A": 0x2a };

/** The parts of a reference body ($A$1:B2): absolute marks per corner. */
function absOf(body: string | undefined): [boolean, boolean, boolean, boolean] {
  const parts = (body ?? "").replace(/^.*!/, "").split(":");
  const one = (s: string): [boolean, boolean] => {
    const m = /^(\$?)[A-Za-z]{0,3}(\$?)\d*$/.exec(s);
    return m ? [m[1] === "$", m[2] === "$"] : [false, false];
  };
  const a = one(parts[0] ?? ""), b = one(parts[1] ?? parts[0] ?? "");
  return [a[0], a[1], b[0], b[1]]; // colAbs, rowAbs of each corner
}

function compile(ast: Ast, c: FCtx, out: Buf, cls: "ref" | "val") {
  switch (ast.k) {
    case "num":
      if (Number.isInteger(ast.v) && ast.v >= 0 && ast.v <= 65535) {
        out.u8(0x1e);
        out.u16(ast.v);
      } else {
        out.u8(0x1f);
        out.f64(ast.v);
      }
      return;
    case "str":
      if (ast.v.length > 255) throw new Refuse("string");
      out.u8(0x17);
      out.str8(ast.v);
      return;
    case "bool":
      out.u8(0x1d);
      out.u8(ast.v ? 1 : 0);
      return;
    case "err":
      out.u8(0x1c);
      out.u8(ERRS[ast.v] ?? 0x2a);
      return;
    case "miss":
      out.u8(0x16);
      return;
    case "ref": {
      const sheet = ast.sheet == null || ast.sheet.toLowerCase() === c.own.toLowerCase() ? null : c.sheetIndex(ast.sheet);
      if (ast.sheet != null && ast.sheet.toLowerCase() !== c.own.toLowerCase() && sheet == null) throw new Refuse("sheet");
      const whole = ast.r1 >= MAX_ROWS || ast.c1 >= MAX_COLS;
      const r1 = Math.min(ast.r1, MAX_ROWS - 1), c1 = Math.min(ast.c1, MAX_COLS - 1);
      if (ast.r0 >= MAX_ROWS || ast.c0 >= MAX_COLS || (whole && !(ast.r0 === 0 || ast.c0 === 0))) throw new Refuse("range");
      const [ca0, ra0, ca1, ra1] = absOf(ast.body);
      const col = (cc: number, cAbs: boolean, rAbs: boolean) => cc | (cAbs ? 0 : 0x4000) | (rAbs ? 0 : 0x8000);
      const kind = cls === "ref" || ast.area ? 0x20 : 0x40;
      if (!ast.area) {
        out.u8((sheet == null ? 0x04 : 0x1a) | kind);
        if (sheet != null) out.u16(c.xti(sheet));
        out.u16(ast.r0);
        out.u16(col(ast.c0, ca0, ra0));
      } else {
        out.u8((sheet == null ? 0x05 : 0x1b) | kind);
        if (sheet != null) out.u16(c.xti(sheet));
        out.u16(ast.r0);
        out.u16(r1);
        out.u16(col(ast.c0, ca0, ra0));
        out.u16(col(c1, ca1, ra1));
      }
      return;
    }
    case "un":
      compile(ast.a, c, out, "val");
      out.u8(ast.op === "-" ? 0x13 : 0x12);
      return;
    case "pct":
      compile(ast.a, c, out, "val");
      out.u8(0x14);
      return;
    case "bin": {
      const op = OPS[ast.op];
      if (op == null) throw new Refuse("operator");
      compile(ast.a, c, out, ast.op === ":" ? "ref" : "val");
      compile(ast.b, c, out, ast.op === ":" ? "ref" : "val");
      out.u8(op);
      return;
    }
    case "fn": {
      const f = ftabOf(ast.name);
      if (!f) throw new Refuse(`function ${ast.name}`);
      for (const a of ast.args) compile(a, c, out, "ref");
      if (f[1] >= 0 && f[1] === ast.args.length) {
        out.u8(0x41);
        out.u16(f[0]);
      } else {
        out.u8(0x42);
        out.u8(ast.args.length);
        out.u16(f[0]);
      }
      return;
    }
    default:
      // names, structured references, arrays: not written here
      throw new Refuse(ast.k);
  }
}

// ───── the workbook ─────

/** Whether an .xls is in manual calculation (a CALCMODE record of 0 in its Workbook stream). */
export function xlsManualCalc(file: Uint8Array): boolean {
  try {
    const tree = readCfb(file);
    const wb = tree.get("Workbook");
    if (!wb) return false;
    for (let p = 0; p + 4 <= wb.length; ) {
      const type = wb[p] | (wb[p + 1] << 8), len = wb[p + 2] | (wb[p + 3] << 8);
      if (type === 0x000d && len >= 2) return (wb[p + 4] | (wb[p + 5] << 8)) === 0;
      p += 4 + len;
    }
  } catch {
    /* not a compound file */
  }
  return false;
}

/** What of these sheets an .xls written anew cannot hold (for the question before the save). */
export function xlsFreshLosses(sheets: readonly SheetData[]): string[] {
  const out = new Set<string>();
  const has = (k: string) => out.add(t(`legacysave.fresh.lose.${k}`));
  for (const sh of sheets) {
    if (sh.drawings?.length) has("drawings");
    if (sh.cond?.length) has("cond");
    if (sh.valid?.length) has("valid");
    if (sh.notes && Object.keys(sh.notes).length) has("notes");
    if (sh.links && Object.keys(sh.links).length) has("links");
    if (sh.filter || sh.tables?.length) has("tables");
    if (sh.sparks?.length || sh.pivots?.length) has("sparks");
    if (sh.protect || sh.bookProtect) has("protect");
    if (sh.print) has("print");
    if (sh.names && Object.keys(sh.names).length) has("names");
    for (const a of Object.keys(sh.cells)) {
      const p = parseAddr(a);
      if (p && (p.r >= MAX_ROWS || p.c >= MAX_COLS)) has("size");
    }
  }
  return [...out];
}

/**
 * A BIFF8 .xls of the sheets (one compound file with its Workbook stream). `formulaLost` receives the cells whose
 * formula BIFF8 / this writer cannot express (their value is written instead).
 */
export function writeFreshXls(sheets: readonly SheetData[], formulaLost?: (sheet: string, a: string) => void, opts: { manual?: boolean } = {}): Uint8Array {
  const palette = new Palette();
  const base = sheets[0];
  // fonts: 0–3 the workbook's default (index 4 does not exist in BIFF), then one per distinct look
  const fonts: string[] = [];
  const fontKey = (st: SheetStyle, sh: SheetData) => JSON.stringify([st.font ?? sh.baseFont, st.size ?? sh.baseSize, !!st.bold, !!st.italic, st.underline ?? "", !!st.strike, st.color ?? ""]);
  const fontIndex = (st: SheetStyle, sh: SheetData) => {
    const k = fontKey(st, sh);
    let i = fonts.indexOf(k);
    if (i < 0) i = fonts.push(k) - 1;
    return i < 4 ? i : i + 1;
  };
  const defFont = fontKey({}, base);
  fonts.push(defFont, defFont, defFont, defFont);
  // number formats
  const fmts = new Map<string, number>();
  const fmtIndex = (code: string | undefined) => {
    if (!code || code === "General") return 0;
    if (code in BUILTIN_FMT) return BUILTIN_FMT[code];
    let i = fmts.get(code);
    if (i == null) fmts.set(code, (i = 164 + fmts.size));
    return i;
  };
  // cell formats: 16 built-in (15 style XFs, the default cell XF 15), then one per distinct look
  const xfs: { font: number; fmt: number; st: SheetStyle }[] = [];
  const xfKeys = new Map<string, number>();
  const xfOf = (sh: SheetData, s: number | undefined): number => {
    const st = sh.styles[s ?? 0] ?? {};
    if (!s && !Object.keys(st).length) return 15;
    const font = fontIndex(st, sh), fmt = fmtIndex(st.fmt);
    const k = JSON.stringify([font, fmt, st.fill, st.bl, st.br, st.bt, st.bb, st.h, st.v, st.wrap, st.shrink, st.indent, st.rot, st.unlocked, st.hideFormula]);
    let i = xfKeys.get(k);
    if (i == null) {
      i = 16 + xfs.length;
      xfs.push({ font, fmt, st });
      xfKeys.set(k, i);
    }
    return i;
  };

  // sheets first (their XFs, fonts, formats and strings), globals after — then the positions
  const sst: string[] = [];
  const sstIdx = new Map<string, number>();
  let sstTotal = 0;
  const strIndex = (s: string) => {
    sstTotal++;
    let i = sstIdx.get(s);
    if (i == null) {
      i = sst.push(s) - 1;
      sstIdx.set(s, i);
    }
    return i;
  };
  // 3-D references: one XTI per sheet referred to
  const xtis: number[] = [];
  const names = sheets.map((s) => s.name.toLowerCase());
  const ctxOf = (sh: SheetData): FCtx => ({
    own: sh.name,
    sheetIndex: (n) => {
      const i = names.indexOf(n.toLowerCase());
      return i < 0 ? null : i;
    },
    xti: (si) => {
      let i = xtis.indexOf(si);
      if (i < 0) i = xtis.push(si) - 1;
      return i;
    },
  });

  const sheetStreams = sheets.map((sh, si) => {
    const b = new Buf();
    const bof = (dt: number) => {
      const d = new Buf();
      d.u16(0x0600);
      d.u16(dt);
      d.u16(0x0dbb);
      d.u16(0x07cc);
      d.u32(0x00000000);
      d.u32(0x00000006);
      rec(b, 0x0809, d);
    };
    bof(0x0010);
    // the used range
    let r0 = MAX_ROWS, r1 = -1, c0 = MAX_COLS, c1 = -1;
    const cells: { r: number; c: number; cell: SheetCell }[] = [];
    for (const [a, cell] of Object.entries(sh.cells)) {
      const p = parseAddr(a);
      if (!p || p.r >= MAX_ROWS || p.c >= MAX_COLS) continue;
      if (cell.v === undefined && !cell.f && !cell.s) continue;
      cells.push({ r: p.r, c: p.c, cell });
      r0 = Math.min(r0, p.r);
      r1 = Math.max(r1, p.r);
      c0 = Math.min(c0, p.c);
      c1 = Math.max(c1, p.c);
    }
    cells.sort((x, y) => x.r - y.r || x.c - y.c);
    // calculation settings, default sizes
    rec(b, 0x000d, [opts.manual ? 0 : 1, 0]); // CALCMODE automatic (manual kept)
    rec(b, 0x000c, [100, 0]); // CALCCOUNT
    rec(b, 0x0225, (() => { const d = new Buf(); d.u16(sh.defRowCustom ? 0x0001 : 0); d.u16(Math.round((sh.defRowH * 72 * 20) / 96)); return d; })());
    const olRows = Math.max(0, ...Object.values(sh.rowLevel ?? {})), olCols = Math.max(0, ...Object.values(sh.colLevel ?? {}));
    if (olRows || olCols) rec(b, 0x0080, (() => { const d = new Buf(); d.u16(olRows ? (olRows + 1) * 12 + 5 : 0); d.u16(olCols ? (olCols + 1) * 12 + 5 : 0); d.u16(olRows ? olRows + 1 : 0); d.u16(olCols ? olCols + 1 : 0); return d; })()); // GUTS
    rec(b, 0x0081, [0xc1, 0x04]); // WSBOOL (summary rows below, outline symbols shown)
    rec(b, 0x0055, (() => { const d = new Buf(); d.u16(Math.max(1, Math.round((sh.defColW - 5) / sh.mdw))); return d; })());
    // column widths, hidden / outline columns, column formats
    const colSet = new Set<number>([...Object.keys(sh.colW).map(Number), ...(sh.hiddenCols ?? []), ...Object.keys(sh.colLevel ?? {}).map(Number), ...Object.keys(sh.colS ?? {}).map(Number)].filter((c) => c < MAX_COLS));
    for (const c of [...colSet].sort((x, y) => x - y)) {
      const d = new Buf();
      const px = sh.colW[c] ?? sh.defColW;
      d.u16(c);
      d.u16(c);
      d.u16(Math.max(0, Math.min(65535, Math.round(widthChars(px, sh.mdw) * 256))));
      d.u16(sh.colS?.[c] != null ? xfOf(sh, sh.colS[c]) : 15);
      d.u16(((sh.hiddenCols ?? []).includes(c) ? 1 : 0) | ((sh.colLevel?.[c] ?? 0) << 8));
      d.u16(0);
      rec(b, 0x007d, d);
    }
    rec(b, 0x0200, (() => { const d = new Buf(); d.u32(r1 < 0 ? 0 : r0); d.u32(r1 < 0 ? 0 : r1 + 1); d.u16(c1 < 0 ? 0 : c0); d.u16(c1 < 0 ? 0 : c1 + 1); d.u16(0); return d; })());
    // rows with a height, hidden, outline level or format
    const rowSet = new Set<number>([...cells.map((x) => x.r), ...Object.keys(sh.rowH).map(Number), ...(sh.hiddenRows ?? []), ...Object.keys(sh.rowLevel ?? {}).map(Number), ...Object.keys(sh.rowS ?? {}).map(Number)].filter((r) => r < MAX_ROWS));
    const hiddenRows = new Set(sh.hiddenRows ?? []);
    for (const r of [...rowSet].sort((x, y) => x - y)) {
      const inRow = cells.filter((x) => x.r === r);
      const d = new Buf();
      d.u16(r);
      d.u16(inRow.length ? inRow[0].c : 0);
      d.u16(inRow.length ? inRow[inRow.length - 1].c + 1 : 0);
      const h = sh.rowH[r];
      d.u16(Math.round((((h ?? sh.defRowH) * 72) / 96) * 20) & 0x7fff);
      d.u16(0);
      d.u16(0);
      const st = sh.rowS?.[r];
      d.u16((sh.rowLevel?.[r] ?? 0) | (hiddenRows.has(r) ? 0x20 : 0) | (h != null && !sh.rowAuto?.[r] ? 0x40 : 0) | (st != null ? 0x80 : 0) | 0x100);
      d.u16(st != null ? xfOf(sh, st) : 15);
      rec(b, 0x0208, d);
    }
    // cells
    const ctx = ctxOf(sh);
    for (const { r, c, cell } of cells) {
      const xf = xfOf(sh, cell.s);
      const head = (d: Buf) => {
        d.u16(r);
        d.u16(c);
        d.u16(xf);
      };
      const v = cell.v;
      if (cell.f) {
        const tok = new Buf();
        let ok = true;
        try {
          compile(parseFormula(cell.f), ctx, tok, "val");
        } catch {
          ok = false;
          formulaLost?.(sh.name, `${r},${c}`);
        }
        if (ok && tok.length <= 1800) {
          const d = new Buf();
          head(d);
          let text: string | null = null;
          if (typeof v === "number") d.f64(v);
          else if (typeof v === "boolean") d.bytes([1, 0, v ? 1 : 0, 0, 0, 0, 0xff, 0xff]);
          else if (cell.t === "e") d.bytes([2, 0, ERRS[String(v)] ?? 0x2a, 0, 0, 0, 0xff, 0xff]);
          else if (v === undefined || v === null || v === "") d.bytes([3, 0, 0, 0, 0, 0, 0xff, 0xff]);
          else {
            d.bytes([0, 0, 0, 0, 0, 0, 0xff, 0xff]);
            text = String(v);
          }
          d.u16(0x0002); // fCalcOnLoad
          d.u32(0);
          d.u16(tok.length);
          d.bytes(tok.parts);
          rec(b, 0x0006, d);
          if (text != null) rec(b, 0x0207, (() => { const s = new Buf(); s.str16(text.slice(0, 32767)); return s; })());
          continue;
        }
      }
      const d = new Buf();
      head(d);
      if (typeof v === "number") {
        d.f64(v);
        rec(b, 0x0203, d);
      } else if (typeof v === "boolean" || cell.t === "e") {
        d.u8(typeof v === "boolean" ? (v ? 1 : 0) : ERRS[String(v)] ?? 0x2a);
        d.u8(typeof v === "boolean" ? 0 : 1);
        rec(b, 0x0205, d);
      } else if (v !== undefined && v !== null && v !== "") {
        d.u32(strIndex(String(v).slice(0, 32767)));
        rec(b, 0x00fd, d);
      } else rec(b, 0x0201, d);
    }
    // window: gridlines, headings, frozen panes
    const fr = sh.freeze;
    const frozen = !!(fr && (fr.rows || fr.cols));
    const w2 = new Buf();
    w2.u16(0x0004 * (sh.headings !== false ? 1 : 0) | (sh.grid ? 0x0002 : 0) | 0x0010 | 0x0020 | 0x0080 | (frozen ? 0x0108 : 0) | (si === 0 ? 0x0600 : 0) | (sh.rtl ? 0x0040 : 0));
    w2.u16(0);
    w2.u16(0);
    w2.u16(0x40);
    w2.u16(0);
    w2.u16(0);
    w2.u16(sh.zoom ? Math.round(sh.zoom * 100) : 0);
    w2.u32(0);
    rec(b, 0x023e, w2);
    if (frozen) {
      const p = new Buf();
      p.u16(fr!.cols);
      p.u16(fr!.rows);
      p.u16(fr!.rows);
      p.u16(fr!.cols);
      p.u16(fr!.rows && fr!.cols ? 0 : fr!.rows ? 2 : 1);
      rec(b, 0x0041, p);
    }
    // merged cells (up to 1026 a record)
    const merges = sh.merges.map((m) => parseRange(m)).filter((g): g is NonNullable<typeof g> => !!g && g.r1 < MAX_ROWS && g.c1 < MAX_COLS);
    for (let i = 0; i < merges.length; i += 1026) {
      const d = new Buf();
      const part = merges.slice(i, i + 1026);
      d.u16(part.length);
      for (const g of part) {
        d.u16(g.r0);
        d.u16(g.r1);
        d.u16(g.c0);
        d.u16(g.c1);
      }
      rec(b, 0x00e5, d);
    }
    rec(b, 0x000a, []);
    return b;
  });

  // ───── globals ─────
  const g = new Buf();
  const bof = new Buf();
  bof.u16(0x0600);
  bof.u16(0x0005);
  bof.u16(0x0dbb);
  bof.u16(0x07cc);
  bof.u32(0);
  bof.u32(6);
  rec(g, 0x0809, bof);
  rec(g, 0x0042, [0xb0, 0x04]); // CODEPAGE 1200
  rec(g, 0x003d, (() => { const d = new Buf(); d.u16(0); d.u16(0); d.u16(0x4000); d.u16(0x2000); d.u16(0x0038); d.u16(0); d.u16(0); d.u16(1); d.u16(600); return d; })()); // WINDOW1
  rec(g, 0x0022, [base.date1904 ? 1 : 0, 0]); // DATE1904
  rec(g, 0x0040, [0, 0]); // BACKUP
  rec(g, 0x008d, [0, 0]); // HIDEOBJ
  rec(g, 0x000e, [0, 0]); // PRECISION (full)
  rec(g, 0x00da, [0, 0]); // BOOKBOOL
  // fonts
  fonts.forEach((k) => {
    const [name, size, bold, italic, underline, strike, color] = JSON.parse(k) as [string, number, boolean, boolean, string, boolean, string];
    const d = new Buf();
    d.u16(Math.round(size * 20));
    d.u16((italic ? 0x02 : 0) | (strike ? 0x08 : 0));
    d.u16(palette.index(color || undefined) ?? 0x7fff);
    d.u16(bold ? 700 : 400);
    d.u16(0);
    d.u8(underline === "double" ? 2 : underline ? 1 : 0);
    d.u8(0);
    d.u8(/[가-힣]/.test(name) || /gulim|dotum|batang|malgun/i.test(name) ? 129 : 1);
    d.u8(0);
    d.str8(name.slice(0, 31));
    rec(g, 0x0031, d);
  });
  // number formats
  for (const [code, i] of fmts) {
    const d = new Buf();
    d.u16(i);
    d.str16(code);
    rec(g, 0x041e, d);
  }
  // cell formats: 15 style XFs, the default cell XF, ours
  const xfRec = (font: number, fmt: number, style: boolean, st: SheetStyle) => {
    const d = new Buf();
    d.u16(font);
    d.u16(fmt);
    d.u16(style ? 0xfff5 : (st.unlocked ? 0 : 0x0001) | (st.hideFormula ? 0x0002 : 0));
    const H: Record<string, number> = { left: 1, center: 2, right: 3, fill: 4, justify: 5, centerContinuous: 6, distributed: 7 };
    const V: Record<string, number> = { top: 0, center: 1, bottom: 2, justify: 3, distributed: 4 };
    d.u8((H[st.h ?? ""] ?? 0) | (st.wrap ? 0x08 : 0) | ((V[st.v ?? "bottom"] ?? 2) << 4));
    d.u8(st.rot == null ? 0 : st.rot === 255 ? 255 : st.rot < 0 ? 90 - st.rot : st.rot);
    d.u8(Math.min(15, st.indent ?? 0) | (st.shrink ? 0x10 : 0));
    d.u8(style ? 0 : 0xfc);
    const B = ["", "thin", "medium", "dashed", "dotted", "thick", "double", "hair", "mediumDashed", "dashDot", "mediumDashDot", "dashDotDot", "mediumDashDotDot", "slantDashDot"];
    const bs = (x?: { style: string }) => (x ? Math.max(0, B.indexOf(x.style)) : 0);
    const bc = (x?: { color: string }) => (x ? palette.index(x.color) ?? 8 : 0);
    d.u16(bs(st.bl) | (bs(st.br) << 4) | (bs(st.bt) << 8) | (bs(st.bb) << 12));
    d.u16(bc(st.bl) | (bc(st.br) << 7));
    d.u32(bc(st.bt) | (bc(st.bb) << 7) | (st.fill ? 1 << 26 : 0));
    const fill = st.fill ? palette.index(st.fill) ?? 64 : 64;
    d.u16(fill | (65 << 7));
    return d;
  };
  for (let i = 0; i < 15; i++) rec(g, 0x00e0, xfRec(0, 0, true, {}));
  rec(g, 0x00e0, xfRec(0, 0, false, {}));
  for (const x of xfs) rec(g, 0x00e0, xfRec(x.font, x.fmt, false, x.st));
  rec(g, 0x0293, [0x00, 0x80, 0x00, 0xff]); // STYLE: Normal (built-in 0) on XF 0
  // the palette with the workbook's colours
  rec(g, 0x0092, (() => { const d = new Buf(); d.u16(56); for (const c of palette.colors) d.bytes([parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), 0]); return d; })());
  // sheets: their BOF positions are patched in after the globals are laid out
  const boundAt: number[] = [];
  sheets.forEach((sh) => {
    const d = new Buf();
    boundAt.push(g.length + 4);
    d.u32(0);
    d.u8(sh.hidden ? 1 : 0);
    d.u8(0);
    d.str8(sh.name.slice(0, 31));
    rec(g, 0x0085, d);
  });
  rec(g, 0x008c, [1, 0, 82, 0]); // COUNTRY
  if (xtis.length) {
    rec(g, 0x01ae, (() => { const d = new Buf(); d.u16(sheets.length); d.u16(0x0401); return d; })()); // SUPBOOK (this workbook)
    rec(g, 0x0017, (() => { const d = new Buf(); d.u16(xtis.length); for (const si of xtis) { d.u16(0); d.u16(si); d.u16(si); } return d; })()); // EXTERNSHEET
  }
  // shared strings (records split at 8224 bytes, a string's characters continued with a fresh option byte) + EXTSST
  const sstStart = g.length;
  const ext: { pos: number; off: number }[] = [];
  {
    const recs: number[][] = [];
    let cur: number[] = [];
    const head = new Buf();
    head.u32(sstTotal);
    head.u32(sst.length);
    cur.push(...head.parts);
    const room = () => 8224 - cur.length;
    const recStart = () => sstStart + recs.reduce((n, r) => n + r.length + 4, 0);
    sst.forEach((s, i) => {
      if (room() < 3 + 2) {
        recs.push(cur);
        cur = [];
      }
      if (i % 8 === 0) ext.push({ pos: recStart() + 4 + cur.length, off: 4 + cur.length });
      cur.push(s.length & 0xff, (s.length >> 8) & 0xff, 1);
      let k = 0;
      while (k < s.length) {
        if (room() < 2) {
          recs.push(cur);
          cur = [1];
        }
        const n = Math.min(s.length - k, Math.floor(room() / 2));
        for (let j = 0; j < n; j++) {
          const ch = s.charCodeAt(k + j);
          cur.push(ch & 0xff, ch >> 8);
        }
        k += n;
      }
    });
    recs.push(cur);
    recs.forEach((r, i) => {
      g.u16(i ? 0x003c : 0x00fc);
      g.u16(r.length);
      g.bytes(r);
    });
    const d = new Buf();
    d.u16(8);
    for (const e of ext) {
      d.u32(e.pos);
      d.u16(e.off);
      d.u16(0);
    }
    rec(g, 0x00ff, d);
  }
  rec(g, 0x000a, []);
  // positions of the sheets
  let at = g.length;
  const bytes = new Uint8Array(g.length + sheetStreams.reduce((n, s) => n + s.length, 0));
  bytes.set(g.parts);
  sheetStreams.forEach((s, i) => {
    const p = boundAt[i];
    bytes[p] = at & 0xff;
    bytes[p + 1] = (at >> 8) & 0xff;
    bytes[p + 2] = (at >> 16) & 0xff;
    bytes[p + 3] = (at >>> 24) & 0xff;
    bytes.set(s.parts, at);
    at += s.length;
  });
  // (a Workbook stream under 4096 bytes would go to the mini stream: padded past it, as Excel's own files are)
  const wb = bytes.length >= 4096 ? bytes : (() => { const x = new Uint8Array(4096); x.set(bytes); return x; })();
  return writeCfb({ Workbook: wb });
}

export { Refuse as XlsFreshRefused };
