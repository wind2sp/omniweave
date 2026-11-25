// Excel 97-2003 workbook (.xls, BIFF8 — [MS-XLS]) → the same sheet models the .xlsx reader makes (core/sheetTypes.ts,
// read.ts): every worksheet with its cell values, formulas (decoded from their parsed tokens, the stored results kept),
// cell formats (XF: font, number format, fill, borders, alignment, wrap, rotation, indent — the colours of Excel 2007's
// XFEXT and the workbook's theme when it has them, else the PALETTE), column widths and row heights, hidden rows /
// columns / sheets, merged cells, frozen panes, view settings, defined names, page setup (margins, orientation, scale,
// fit to pages, breaks, header / footer, print area and titles) and notes. What it does not draw is listed as notices
// (pictures, charts, conditional formats …) — each one only when the file has it. Omniweave's own reader, written from
// the public specification.
//
// Source: [MS-XLS] Excel Binary File Format — Microsoft open specification.

import { strFromU8, unzipSync } from "fflate";
import type { SheetBorder, SheetCell, SheetData, SheetNote, SheetPrint, SheetStyle } from "../../core/sheetTypes";
import { uid } from "../../core/types";
import { readCfb } from "../formats/cfb";
import { FUTURE } from "./book";
import { addr, colLetters, sheetRef } from "./formula";
import { builtinFormat, type SheetLang } from "./numfmt";
import { digitWidth, INDEXED, MAX_CELLS, themeColors, tinted, widthPx } from "./read";
import { markSpills } from "./tables";

/** What the reader could not show as Excel does, by kind (only those the file has), with how many. */
export type XlsNoticeKind =
  | "formulaValues" // formulas whose text could not be decoded (or external references): shown as their stored result
  | "pictures"
  | "charts"
  | "shapes"
  | "chartSheets" // chart sheets and macro / module sheets: not opened
  | "hyperlinks" // the text shows, the link is not kept as a link
  | "cond" // conditional formats
  | "valid" // data validation
  | "filter" // AutoFilter
  | "pattern" // pattern / gradient fills drawn as one colour
  | "richText" // formatting runs inside a cell's text
  | "superSub" // superscript / subscript drawn at normal size
  | "oddEven" // different odd / even page headers: the odd ones are used
  | "truncated";
export interface XlsNotice {
  kind: XlsNoticeKind;
  n: number;
}

export interface XlsReadResult {
  sheets: SheetData[];
  notices: XlsNotice[];
  truncated: boolean;
}

/** A file this reader refuses on purpose (encrypted, BIFF5): the caller shows the message and does not fall back. */
export class XlsUnreadable extends Error {}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const s16 = (b: Uint8Array, o: number) => (u16(b, o) << 16) >> 16;
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
/** (0 past the end of `b`: a record cut short reads as zeros, as the other readers here do, instead of throwing) */
const f64 = (b: Uint8Array, o: number) => (o >= 0 && o + 8 <= b.length ? new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true) : 0);
function chars(b: Uint8Array, o: number, n: number, wide: boolean): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(wide ? u16(b, o + i * 2) : b[o + i]);
  return s;
}
/** XLUnicodeString (cch 2 bytes, option byte, characters) or ShortXLUnicodeString (cch 1 byte) at `o`. */
function xlStr(b: Uint8Array, o: number, short = false): { s: string; end: number } {
  const cch = short ? b[o] : u16(b, o);
  const at = o + (short ? 1 : 2);
  const wide = (b[at] & 1) === 1;
  return { s: chars(b, at + 1, cch, wide), end: at + 1 + cch * (wide ? 2 : 1) };
}

// record types
const BOF = 0x0809, EOF = 0x000a, CONTINUE = 0x003c;
const ERR: Record<number, string> = { 0x00: "#NULL!", 0x07: "#DIV/0!", 0x0f: "#VALUE!", 0x17: "#REF!", 0x1d: "#NAME?", 0x24: "#NUM!", 0x2a: "#N/A", 0x2b: "#N/A" };
const BORDER = ["", "thin", "medium", "dashed", "dotted", "thick", "double", "hair", "mediumDashed", "dashDot", "mediumDashDot", "dashDotDot", "mediumDashDotDot", "slantDashDot"];
const H_ALIGN: (SheetStyle["h"] | undefined)[] = [undefined, "left", "center", "right", "fill", "justify", "centerContinuous", "distributed"];
const V_ALIGN: (SheetStyle["v"] | undefined)[] = ["top", "center", undefined, "justify", "distributed"];
const BUILTIN_NAMES = ["Consolidate_Area", "Auto_Open", "Auto_Close", "Extract", "Database", "Criteria", "Print_Area", "Print_Titles", "Recorder", "Data_Form", "Auto_Activate", "Auto_Deactivate", "Sheet_Title", "_FilterDatabase"];

// ───────────────────────── functions of the formula tokens ([MS-XLS] 2.5.198.17 Ftab) ─────────────────────────

/** Ftab index → name and its fixed argument count (-1: variable, PtgFuncVar gives it). */
const FTAB: Record<number, [string, number]> = {};
(
  "0 COUNT -1|1 IF -1|2 ISNA 1|3 ISERROR 1|4 SUM -1|5 AVERAGE -1|6 MIN -1|7 MAX -1|8 ROW -1|9 COLUMN -1|10 NA 0|11 NPV -1|12 STDEV -1|13 DOLLAR -1|14 FIXED -1|15 SIN 1|16 COS 1|17 TAN 1|18 ATAN 1|19 PI 0|20 SQRT 1|21 EXP 1|22 LN 1|23 LOG10 1|24 ABS 1|25 INT 1|26 SIGN 1|27 ROUND 2|28 LOOKUP -1|29 INDEX -1|30 REPT 2|31 MID 3|32 LEN 1|33 VALUE 1|34 TRUE 0|35 FALSE 0|36 AND -1|37 OR -1|38 NOT 1|39 MOD 2|40 DCOUNT 3|41 DSUM 3|42 DAVERAGE 3|43 DMIN 3|44 DMAX 3|45 DSTDEV 3|46 VAR -1|47 DVAR 3|48 TEXT 2|49 LINEST -1|50 TREND -1|51 LOGEST -1|52 GROWTH -1|56 PV -1|57 FV -1|58 NPER -1|59 PMT -1|60 RATE -1|61 MIRR 3|62 IRR -1|63 RAND 0|64 MATCH -1|65 DATE 3|66 TIME 3|67 DAY 1|68 MONTH 1|69 YEAR 1|70 WEEKDAY -1|71 HOUR 1|72 MINUTE 1|73 SECOND 1|74 NOW 0|75 AREAS 1|76 ROWS 1|77 COLUMNS 1|78 OFFSET -1|82 SEARCH -1|83 TRANSPOSE 1|86 TYPE 1|97 ATAN2 2|98 ASIN 1|99 ACOS 1|100 CHOOSE -1|101 HLOOKUP -1|102 VLOOKUP -1|105 ISREF 1|109 LOG -1|111 CHAR 1|112 LOWER 1|113 UPPER 1|114 PROPER 1|115 LEFT -1|116 RIGHT -1|117 EXACT 2|118 TRIM 1|119 REPLACE 4|120 SUBSTITUTE -1|121 CODE 1|124 FIND -1|125 CELL -1|126 ISERR 1|127 ISTEXT 1|128 ISNUMBER 1|129 ISBLANK 1|130 T 1|131 N 1|140 DATEVALUE 1|141 TIMEVALUE 1|142 SLN 3|143 SYD 4|144 DDB -1|148 INDIRECT -1|162 CLEAN 1|163 MDETERM 1|164 MINVERSE 1|165 MMULT 2|167 IPMT -1|168 PPMT -1|169 COUNTA -1|183 PRODUCT -1|184 FACT 1|189 DPRODUCT 3|190 ISNONTEXT 1|193 STDEVP -1|194 VARP -1|195 DSTDEVP 3|196 DVARP 3|197 TRUNC -1|198 ISLOGICAL 1|199 DCOUNTA 3|204 USDOLLAR -1|205 FINDB -1|206 SEARCHB -1|207 REPLACEB 4|208 LEFTB -1|209 RIGHTB -1|210 MIDB 3|211 LENB 1|212 ROUNDUP 2|213 ROUNDDOWN 2|214 ASC 1|215 DBCS 1|216 RANK -1|219 ADDRESS -1|220 DAYS360 -1|221 TODAY 0|222 VDB -1|227 MEDIAN -1|228 SUMPRODUCT -1|229 SINH 1|230 COSH 1|231 TANH 1|232 ASINH 1|233 ACOSH 1|234 ATANH 1|235 DGET 3|244 INFO 1|247 DB -1|252 FREQUENCY 2|261 ERROR.TYPE 1|269 AVEDEV -1|270 BETADIST -1|271 GAMMALN 1|272 BETAINV -1|273 BINOMDIST 4|274 CHIDIST 2|275 CHIINV 2|276 COMBIN 2|277 CONFIDENCE 3|278 CRITBINOM 3|279 EVEN 1|280 EXPONDIST 3|281 FDIST 3|282 FINV 3|283 FISHER 1|284 FISHERINV 1|285 FLOOR 2|286 GAMMADIST 4|287 GAMMAINV 3|288 CEILING 2|289 HYPGEOMDIST 4|290 LOGNORMDIST 3|291 LOGINV 3|292 NEGBINOMDIST 3|293 NORMDIST 4|294 NORMSDIST 1|295 NORMINV 3|296 NORMSINV 1|297 STANDARDIZE 3|298 ODD 1|299 PERMUT 2|300 POISSON 3|301 TDIST 3|302 WEIBULL 4|303 SUMXMY2 2|304 SUMX2MY2 2|305 SUMX2PY2 2|306 CHITEST 2|307 CORREL 2|308 COVAR 2|309 FORECAST 3|310 FTEST 2|311 INTERCEPT 2|312 PEARSON 2|313 RSQ 2|314 STEYX 2|315 SLOPE 2|316 TTEST 4|317 PROB -1|318 DEVSQ -1|319 GEOMEAN -1|320 HARMEAN -1|321 SUMSQ -1|322 KURT -1|323 SKEW -1|324 ZTEST -1|325 LARGE 2|326 SMALL 2|327 QUARTILE 2|328 PERCENTILE 2|329 PERCENTRANK -1|330 MODE -1|331 TRIMMEAN 2|332 TINV 2|336 CONCATENATE -1|337 POWER 2|342 RADIANS 1|343 DEGREES 1|344 SUBTOTAL -1|345 SUMIF -1|346 COUNTIF 2|347 COUNTBLANK 1|350 ISPMT 4|351 DATEDIF 3|352 DATESTRING 1|353 NUMBERSTRING 2|354 ROMAN -1|358 GETPIVOTDATA -1|359 HYPERLINK -1|360 PHONETIC 1|361 AVERAGEA -1|362 MAXA -1|363 MINA -1|364 STDEVPA -1|365 VARPA -1|366 STDEVA -1|367 VARA -1"
)
  .split("|")
  .forEach((e) => {
    const [i, n, a] = e.split(" ");
    FTAB[Number(i)] = [n, Number(a)];
  });

/** A function's Ftab index and fixed argument count (-1: variable), for the XLS writer (io/formats/xlsFresh.ts). */
export function ftabOf(name: string): [number, number] | undefined {
  const up = name.toUpperCase();
  for (const [i, [n, a]] of Object.entries(FTAB)) if (n === up) return [Number(i), a];
  return undefined;
}

// ───────────────────────── records ─────────────────────────

interface Rec {
  type: number;
  off: number;
  len: number;
}

/** The data of record `i` with the CONTINUE records after it joined (a long NAME / TXO formula, a long note). */
function joined(wb: Uint8Array, recs: readonly Rec[], i: number): Uint8Array {
  let n = recs[i].len;
  for (let j = i + 1; j < recs.length && recs[j].type === CONTINUE; j++) n += recs[j].len;
  if (n === recs[i].len) return wb.subarray(recs[i].off, recs[i].off + n);
  const out = new Uint8Array(n);
  let p = 0;
  for (let j = i; j === i || (j < recs.length && recs[j].type === CONTINUE); j++) {
    out.set(wb.subarray(recs[j].off, recs[j].off + recs[j].len), p);
    p += recs[j].len;
  }
  return out;
}

/** The shared strings (SST with its CONTINUE records: a string cut between records goes on after a fresh option byte). */
function readSst(wb: Uint8Array, recs: readonly Rec[], i: number): { strings: string[]; rich: (number[] | null)[] } {
  const parts = [recs[i]];
  for (let j = i + 1; j < recs.length && recs[j].type === CONTINUE; j++) parts.push(recs[j]);
  let p = 0, o = parts[0].off, end = parts[0].off + parts[0].len;
  const next = () => {
    if (++p >= parts.length) return false;
    o = parts[p].off;
    end = o + parts[p].len;
    return true;
  };
  const need = (n: number) => {
    if (o + n > end) next();
  };
  const strings: string[] = [];
  const rich: (number[] | null)[] = [];
  o += 4;
  const unique = u32(wb, o);
  o += 4;
  for (let k = 0; k < unique && p < parts.length; k++) { work++;
    need(3);
    const cch = u16(wb, o);
    let flags = wb[o + 2];
    o += 3;
    let runs = 0, ext = 0;
    if (flags & 0x08) {
      need(2);
      runs = u16(wb, o);
      o += 2;
    }
    if (flags & 0x04) {
      need(4);
      ext = u32(wb, o);
      o += 4;
    }
    let s = "";
    for (let left = cch; left > 0; ) { work++;
      if (o >= end) {
        if (!next()) break;
        flags = wb[o++];
      }
      const wide = (flags & 1) === 1;
      const take = Math.min(left, Math.floor((end - o) / (wide ? 2 : 1)));
      s += chars(wb, o, take, wide);
      o += take * (wide ? 2 : 1);
      left -= take;
      if (take === 0 && !next()) break;
    }
    // formatting runs (ich, ifnt): the fonts they use
    const fontsUsed: number[] = [];
    for (let q = 0; q < runs; q++) {
      if (o + 4 > end && !next()) break;
      fontsUsed.push(u16(wb, o + 2));
      o += 4;
    }
    for (let skip = ext; skip > 0; ) {
      if (o >= end && !next()) break;
      const n = Math.min(skip, end - o);
      o += n;
      skip -= n;
    }
    strings.push(s);
    rich.push(fontsUsed.length ? fontsUsed : null);
  }
  return { strings, rich };
}

interface Font {
  name: string;
  size: number;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline?: "single" | "double";
  icv: number;
  sss: number;
}
interface Xf {
  ifnt: number;
  ifmt: number;
  data: Uint8Array;
}
/** a colour of Excel 2007's extensions (FullColorExt): resolved to RGB, or undefined (automatic) */
type ExtColor = string | undefined | null; // null: not given

interface Supbook {
  self: boolean;
  addin: boolean;
  names: string[];
}
interface DefName {
  name: string;
  /** 0 = the workbook, else the 1-based sheet (BOUNDSHEET order) it is local to */
  itab: number;
  func: boolean;
  builtin: boolean;
  hidden: boolean;
  rgce: Uint8Array;
  cce: number;
}

// ───────────────────────── formula tokens ([MS-XLS] 2.5.198 Ptg) ─────────────────────────

interface FormulaCtx {
  sheets: string[];
  xti: { sup: number; first: number; last: number }[];
  supbooks: Supbook[];
  names: DefName[];
}

/**
 * A number in a formula as Excel shows it (checked in Excel 16, QA 2026-11-21): its shortest digits cut (not rounded)
 * to 15 significant ones, written out in full when that is at most 21 characters (0.0000000000000000001, 1E+20 as
 * 100000000000000000000), else as 1E-20 / 1.23456789012345E-12 / 1E+21.
 */
function numText(v: number): string {
  if (!Number.isFinite(v) || v === 0) return v === 0 ? "0" : String(v);
  const m = /^(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(Math.abs(v).toExponential());
  if (!m) return String(v);
  const d = (m[1] + (m[2] ?? "")).slice(0, 15).replace(/0+$/, "") || "0";
  const e = Number(m[3]);
  const sign = v < 0 ? "-" : "";
  const full = e >= 0 ? (d.length <= e + 1 ? d + "0".repeat(e + 1 - d.length) : `${d.slice(0, e + 1)}.${d.slice(e + 1)}`) : `0.${"0".repeat(-e - 1)}${d}`;
  if (full.length <= 21) return sign + full;
  return `${sign}${d[0]}${d.length > 1 ? "." + d.slice(1) : ""}E${e < 0 ? "-" : "+"}${Math.abs(e)}`;
}
const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * The formula of parsed tokens `rgce` (cce bytes at `o`, the extra data rgcb after them up to `end`) as text without
 * "=", for the cell (r, c) — `rel`: a shared formula's tokens, whose relative references are offsets from that cell.
 * Null when a token is not one this decoder knows (or refers to another workbook): the stored result is shown then.
 */
export function decodeFormula(b: Uint8Array, o: number, cce: number, end: number, r: number, c: number, ctx: FormulaCtx, rel = false): string | null {
  // (QA 2026-11-21: the tokens of a damaged file never throw out of the open — the stored result is shown instead)
  try {
    return decodeTokens(b, o, cce, Math.min(end, b.length), r, c, ctx, rel);
  } catch {
    return null;
  }
}

function decodeTokens(b: Uint8Array, o: number, cce: number, end: number, r: number, c: number, ctx: FormulaCtx, rel: boolean): string | null {
  const st: string[] = [];
  const stop = o + cce;
  let p = o, cb = stop;
  const pop = () => st.pop() ?? "";
  const popN = (n: number) => st.splice(Math.max(0, st.length - n), n);
  const cellRef = (rw: number, colw: number, relN: boolean) => {
    const rRel = (colw & 0x8000) !== 0, cRel = (colw & 0x4000) !== 0;
    let row = rw, col = colw & 0x3fff;
    if (relN && rRel) row = (r + ((rw << 16) >> 16)) & 0xffff;
    if (relN && cRel) col = (c + (((col & 0xff) << 24) >> 24)) & 0xff;
    return { row, col, rRel, cRel };
  };
  const ref1 = (x: { row: number; col: number; rRel: boolean; cRel: boolean }) => `${x.cRel ? "" : "$"}${colLetters(x.col)}${x.rRel ? "" : "$"}${x.row + 1}`;
  const area = (rw0: number, rw1: number, cw0: number, cw1: number, relN: boolean) => {
    const a = cellRef(rw0, cw0, relN), z = cellRef(rw1, cw1, relN);
    // (whole columns / rows: also in a shared formula — its rows (columns) come out absolute 0 … 65535 there too)
    if (a.row === 0 && z.row === 0xffff) return `${a.cRel ? "" : "$"}${colLetters(a.col)}:${z.cRel ? "" : "$"}${colLetters(z.col)}`;
    if (a.col === 0 && z.col === 0xff) return `${a.rRel ? "" : "$"}${a.row + 1}:${z.rRel ? "" : "$"}${z.row + 1}`;
    return `${ref1(a)}:${ref1(z)}`;
  };
  const sheetOf = (ixti: number): string | null => {
    const x = ctx.xti[ixti];
    const sup = x && ctx.supbooks[x.sup];
    if (!x || !sup?.self) return null; // another workbook (or an add-in): not followed
    if (x.first >= 0xfffe || x.last >= 0xfffe) return null;
    const a = ctx.sheets[x.first], z = ctx.sheets[x.last];
    if (a === undefined || z === undefined) return null;
    return (x.first === x.last ? sheetRef(a) : sheetRef(`${a}:${z}`)) + "!";
  };
  const nameAt = (i: number) => {
    const n = ctx.names[i - 1];
    return n ? (n.builtin ? "_xlnm." + n.name : n.name) : null;
  };
  while (p < stop) { work++;
    const ptg = b[p++];
    const base = ptg >= 0x20 ? 0x20 | (ptg & 0x1f) : ptg;
    switch (base) {
      case 0x03: case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c: case 0x0d: case 0x0e: case 0x0f: case 0x10: case 0x11: {
        const y = pop(), x = pop();
        st.push(x + ["+", "-", "*", "/", "^", "&", "<", "<=", "=", ">=", ">", "<>", " ", ",", ":"][base - 3] + y);
        break;
      }
      case 0x12:
        st.push("+" + pop());
        break;
      case 0x13:
        st.push("-" + pop());
        break;
      case 0x14:
        st.push(pop() + "%");
        break;
      case 0x15:
        st.push("(" + pop() + ")");
        break;
      case 0x16:
        st.push("");
        break;
      case 0x17: {
        const s = xlStr(b, p, true);
        st.push(quote(s.s));
        p = s.end;
        break;
      }
      case 0x19: {
        const g = b[p];
        if (g & 0x04) p += 3 + (u16(b, p + 1) + 1) * 2; // choose: its jump table
        else {
          if (g & 0x10) st.push(`SUM(${pop()})`);
          p += 3;
        }
        break;
      }
      case 0x1c:
        st.push(ERR[b[p++]] ?? "#N/A");
        break;
      case 0x1d:
        st.push(b[p++] ? "TRUE" : "FALSE");
        break;
      case 0x1e:
        st.push(String(u16(b, p)));
        p += 2;
        break;
      case 0x1f:
        st.push(numText(f64(b, p)));
        p += 8;
        break;
      case 0x20: {
        // array constant: its values in rgcb
        p += 7;
        const cols = b[cb] + 1, rows = u16(b, cb + 1) + 1;
        cb += 3;
        // (each value takes 9 bytes or more: a count the data cannot hold is a damaged formula, not 16 M empty values)
        if (cb + rows * cols * 2 > end) return null;
        const rowsOut: string[] = [];
        for (let i = 0; i < rows; i++) {
          const vals: string[] = [];
          for (let j = 0; j < cols; j++) {
            if (cb >= end) return null;
            const t = b[cb++];
            if (t === 0x01) vals.push(numText(f64(b, cb)));
            else if (t === 0x02) {
              const s = xlStr(b, cb);
              vals.push(quote(s.s));
              cb = s.end;
              continue;
            } else if (t === 0x04) vals.push(b[cb] ? "TRUE" : "FALSE");
            else if (t === 0x10) vals.push(ERR[b[cb]] ?? "#N/A");
            else vals.push("");
            cb += 8;
          }
          rowsOut.push(vals.join(","));
        }
        st.push(`{${rowsOut.join(";")}}`);
        break;
      }
      case 0x21: {
        const fn = FTAB[u16(b, p)];
        p += 2;
        if (!fn || fn[1] < 0) return null;
        st.push(`${fn[0]}(${popN(fn[1]).join(",")})`);
        break;
      }
      case 0x22: {
        const argc = b[p] & 0x7f, tab = u16(b, p + 1) & 0x7fff;
        p += 3;
        const args = popN(argc);
        if (tab === 255) {
          // a function by name: an add-in's, or one newer than Excel 2003 (_xlfn.IFERROR …) — the name is the first argument
          let name = args.shift();
          if (!name) return null;
          // Excel 2007's own functions (IFERROR, SUMIFS …) are _xlfn. names in an .xls only: as an .xlsx stores them
          if (/^_xlfn\./i.test(name) && !FUTURE.has(name.slice(6).toUpperCase())) name = name.slice(6);
          st.push(`${name}(${args.join(",")})`);
        } else {
          const fn = FTAB[tab];
          if (!fn) return null;
          st.push(`${fn[0]}(${args.join(",")})`);
        }
        break;
      }
      case 0x23: {
        const n = nameAt(u32(b, p));
        p += 4;
        if (!n) return null;
        st.push(n);
        break;
      }
      case 0x24:
      case 0x2c: {
        st.push(ref1(cellRef(u16(b, p), u16(b, p + 2), base === 0x2c)));
        p += 4;
        break;
      }
      case 0x25:
      case 0x2d: {
        st.push(area(u16(b, p), u16(b, p + 2), u16(b, p + 4), u16(b, p + 6), base === 0x2d));
        p += 8;
        break;
      }
      case 0x26: // PtgMemArea: its subexpression follows; the areas it caches are in rgcb
        p += 6;
        cb += 2 + u16(b, cb) * 8;
        break;
      case 0x27:
      case 0x28:
        p += 6;
        break;
      case 0x29:
        p += 2;
        break;
      case 0x2a:
        st.push("#REF!");
        p += 4;
        break;
      case 0x2b:
        st.push("#REF!");
        p += 8;
        break;
      case 0x39: {
        const x = ctx.xti[u16(b, p)];
        const idx = u16(b, p + 2);
        p += 6;
        const sup = x && ctx.supbooks[x.sup];
        const n = sup ? (sup.self ? nameAt(idx) : sup.addin ? sup.names[idx - 1] : null) : null;
        if (!n) return null;
        st.push(n);
        break;
      }
      case 0x3a: {
        const sh = sheetOf(u16(b, p));
        if (sh === null) return null;
        st.push(sh + ref1(cellRef(u16(b, p + 2), u16(b, p + 4), rel)));
        p += 6;
        break;
      }
      case 0x3b: {
        const sh = sheetOf(u16(b, p));
        if (sh === null) return null;
        st.push(sh + area(u16(b, p + 2), u16(b, p + 4), u16(b, p + 6), u16(b, p + 8), rel));
        p += 10;
        break;
      }
      case 0x3c: {
        const sh = sheetOf(u16(b, p));
        st.push((sh ?? "") + "#REF!");
        p += 6;
        break;
      }
      case 0x3d: {
        const sh = sheetOf(u16(b, p));
        st.push((sh ?? "") + "#REF!");
        p += 10;
        break;
      }
      default:
        return null; // PtgExp / PtgTbl (handled by the caller), PtgExtended … not decoded
    }
    if (p > stop || cb > end) return null;
  }
  return st.length === 1 ? st[0] : null;
}

// ───────────────────────── the workbook ─────────────────────────

/** Read every worksheet of an .xls. `books`: each sheet's workbook id (the same ids give the same models again). */
/**
 * Loop steps the last readXls took (records, shared strings and their pieces, formula tokens): what the damaged-file
 * tests bound — each step reads at least one byte of the file, so a reader that stays linear takes fewer steps than
 * the file has bytes, however busy the machine is (wall-clock limits failed under a loaded test run).
 */
let work = 0;
export const lastXlsWork = () => work;

export function readXls(bytes: Uint8Array, lang: SheetLang = "en", books?: readonly (string | undefined)[], messages?: { encrypted: string; biff5: string; noWorkbook: string }): XlsReadResult {
  work = 0;
  const cfb = readCfb(bytes);
  const wb = cfb.get("Workbook");
  if (!wb) throw new XlsUnreadable(cfb.get("Book") ? messages?.biff5 ?? "BIFF5" : messages?.noWorkbook ?? "no Workbook stream");
  const recs: Rec[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = u16(wb, o), len = u16(wb, o + 2);
    if (o + 4 + len > wb.length) break;
    recs.push({ type, off: o + 4, len });
    o += 4 + len;
  }
  if (recs.some((r) => r.type === 0x002f)) throw new XlsUnreadable(messages?.encrypted ?? "encrypted");
  if (!recs.length || recs[0].type !== BOF || u16(wb, recs[0].off) !== 0x0600) throw new Error("not BIFF8");
  const notices = new Map<XlsNoticeKind, number>();
  const note = (k: XlsNoticeKind, n = 1) => notices.set(k, (notices.get(k) ?? 0) + n);

  // ── globals ──
  const fonts: Font[] = [];
  const formats = new Map<number, string>();
  const xfs: Xf[] = [];
  const xfExt = new Map<number, { fg?: ExtColor; bg?: ExtColor; text?: ExtColor; bt?: ExtColor; bb?: ExtColor; bl?: ExtColor; br?: ExtColor; gradient?: boolean; indent?: number }>();
  const palette = INDEXED.slice();
  let theme: string[] = themeColors(undefined);
  let date1904 = false;
  let sst: ReturnType<typeof readSst> = { strings: [], rich: [] };
  const bound: { name: string; pos: number; state: number; dt: number }[] = [];
  const supbooks: Supbook[] = [];
  const xti: FormulaCtx["xti"] = [];
  const defNames: DefName[] = [];
  let i = 1;
  for (; i < recs.length && recs[i].type !== EOF; i++) { work++;
    const r = recs[i], o = r.off, d = wb.subarray(o, o + r.len);
    switch (r.type) {
      case 0x0031: {
        const grbit = u16(d, 2), uls = d[10];
        fonts.push({
          size: u16(d, 0) / 20,
          italic: (grbit & 0x02) !== 0,
          strike: (grbit & 0x08) !== 0,
          icv: u16(d, 4),
          bold: u16(d, 6) >= 700,
          sss: u16(d, 8),
          underline: uls === 1 || uls === 0x21 ? "single" : uls === 2 || uls === 0x22 ? "double" : undefined,
          name: xlStr(d, 14, true).s,
        });
        break;
      }
      case 0x041e:
        formats.set(u16(d, 0), xlStr(d, 2).s);
        break;
      case 0x00e0:
        if (r.len >= 20) xfs.push({ ifnt: u16(d, 0), ifmt: u16(d, 2), data: d });
        break;
      case 0x087d: {
        // XFEXT: the colours Excel 2007+ gave the XF (theme colours with tints, RGB) — the XF holds the nearest palette ones
        const ixfe = u16(d, 14), n = u16(d, 18);
        const e: NonNullable<ReturnType<typeof xfExt.get>> = {};
        let p = 20;
        for (let k = 0; k < n && p + 4 <= d.length; k++) {
          const type = u16(d, p), cb = u16(d, p + 2);
          if (cb < 4) break;
          const x = p + 4;
          const col = (): ExtColor => {
            const kind = u16(d, x), tint = s16(d, x + 2) / 32767, v = u32(d, x + 4);
            let rgb: string | undefined;
            if (kind === 1) rgb = v < 64 ? palette[v] : undefined;
            else if (kind === 2) rgb = [d[x + 4], d[x + 5], d[x + 6]].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
            else if (kind === 3) rgb = theme[v];
            else if (kind === 0) return undefined;
            else return null;
            return rgb ? "#" + tinted(rgb.toUpperCase(), tint) : null;
          };
          if (type === 4) e.fg = col();
          else if (type === 5) e.bg = col();
          else if (type === 6) e.gradient = true;
          else if (type === 7) e.bt = col();
          else if (type === 8) e.bb = col();
          else if (type === 9) e.bl = col();
          else if (type === 10) e.br = col();
          else if (type === 13) e.text = col();
          else if (type === 15 && cb >= 6) e.indent = u16(d, x);
          p += cb;
        }
        xfExt.set(ixfe, e);
        break;
      }
      case 0x0092: {
        const n = u16(d, 0);
        for (let k = 0; k < n && 8 + k < 64; k++) palette[8 + k] = [d[2 + k * 4], d[3 + k * 4], d[4 + k * 4]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
        break;
      }
      case 0x0896: {
        // THEME: a theme package (zip) unless it is the default theme (dwThemeVersion 124226)
        try {
          const data = joinedFrt(wb, recs, i);
          if (u32(data, 12) === 0) {
            const files = unzipSync(data.subarray(16), { filter: (f) => /theme\d*\.xml$/i.test(f.name) });
            const xml = Object.entries(files).find(([k]) => /theme\/theme\/theme\d*\.xml$/i.test(k))?.[1];
            if (xml) theme = themeColors(strFromU8(xml));
          }
        } catch {
          // (an unreadable theme: the default one)
        }
        break;
      }
      case 0x0022:
        date1904 = u16(d, 0) === 1;
        break;
      case 0x00fc:
        sst = readSst(wb, recs, i);
        break;
      case 0x0085:
        bound.push({ pos: u32(d, 0), state: d[4] & 0x03, dt: d[5], name: xlStr(d, 6, true).s });
        break;
      case 0x01ae: {
        const cch = u16(d, 2);
        supbooks.push({ self: cch === 0x0401, addin: cch === 0x3a01, names: [] });
        break;
      }
      case 0x0023: {
        const sup = supbooks[supbooks.length - 1];
        if (sup && d.length > 7) sup.names.push(xlStr(d, 6, true).s);
        break;
      }
      case 0x0017: {
        const n = u16(d, 0);
        for (let k = 0; k < n && 2 + k * 6 + 6 <= d.length; k++) xti.push({ sup: u16(d, 2 + k * 6), first: u16(d, 4 + k * 6), last: u16(d, 6 + k * 6) });
        break;
      }
      case 0x0018: {
        const all = joined(wb, recs, i);
        const grbit = u16(all, 0), cch = all[3], cce = u16(all, 4), itab = u16(all, 8);
        const wide = (all[14] & 1) === 1;
        const builtin = (grbit & 0x20) !== 0;
        const nameEnd = 15 + cch * (wide ? 2 : 1);
        const raw = chars(all, 15, cch, wide);
        defNames.push({
          name: builtin && cch === 1 ? BUILTIN_NAMES[raw.charCodeAt(0)] ?? raw : raw,
          itab,
          func: (grbit & 0x02) !== 0,
          builtin,
          hidden: (grbit & 0x01) !== 0,
          rgce: all.subarray(nameEnd),
          cce,
        });
        break;
      }
    }
  }
  const fontAt = (ifnt: number): Font | undefined => fonts[ifnt >= 4 ? ifnt - 1 : ifnt];
  const color = (icv: number): string | undefined => (icv < 64 && palette[icv] ? "#" + palette[icv] : undefined);
  /** whether a text's formatting runs look different from the cell's font (runs that change only the font name are
   * Excel's own fallback for letters the font lacks — Hangul in Arial — and look as the cell does) */
  const runsShow = (runs: number[] | null | undefined, ixfe: number) => {
    if (!runs) return false;
    const a = fontAt(xfs[ixfe]?.ifnt ?? 0);
    return runs.some((k) => {
      const b = fontAt(k);
      return !a || !b || a.size !== b.size || a.bold !== b.bold || a.italic !== b.italic || a.strike !== b.strike || a.underline !== b.underline || a.icv !== b.icv || a.sss !== b.sss;
    });
  };
  const f0 = fontAt(xfs[0]?.ifnt ?? 0) ?? fonts[0];
  const baseFont = f0?.name || "Arial";
  const baseSize = f0?.size || 10;
  const mdw = digitWidth(baseFont, baseSize);
  const sheetNames = bound.map((b) => b.name);
  const ctx: FormulaCtx = { sheets: sheetNames, xti, supbooks, names: defNames };

  // cell formats → sheet styles (as read.ts: font and size only where they differ from the Normal style's)
  const patterned = new Set<number>(), superSub = new Set<number>();
  const styleCache = new Map<number, SheetStyle>();
  const styleOfXf = (ix: number): SheetStyle => {
    const hit = styleCache.get(ix);
    if (hit) return hit;
    const xf = xfs[ix];
    const st: SheetStyle = {};
    if (xf) {
      const d = xf.data, e = xfExt.get(ix);
      const font = fontAt(xf.ifnt);
      if (xf.ifmt) {
        const code = formats.get(xf.ifmt) ?? builtinFormat(xf.ifmt, lang);
        if (code !== "General") st.fmt = code;
      }
      if (font) {
        if (font.name && font.name !== baseFont) st.font = font.name;
        if (font.size && font.size !== baseSize) st.size = font.size;
        if (font.bold) st.bold = true;
        if (font.italic) st.italic = true;
        if (font.underline) st.underline = font.underline;
        if (font.strike) st.strike = true;
        // XFEXT text colour: a colour, automatic (undefined) or not given (null → the font's palette colour)
        const ext = e && "text" in e ? e.text : null;
        const c = ext === null ? color(font.icv) : ext;
        if (c && c !== "#000000") st.color = c;
        if (font.sss) superSub.add(ix);
      }
      // alignment
      const al = d[6];
      const h = H_ALIGN[al & 0x07];
      if (h) st.h = h;
      if (al & 0x08) st.wrap = true;
      const v = V_ALIGN[(al >> 4) & 0x07];
      if (v) st.v = v;
      if (d[7]) st.rot = d[7];
      const ind = e?.indent ?? d[8] & 0x0f;
      if (ind) st.indent = ind;
      if (d[8] & 0x10) st.shrink = true;
      // borders
      const b1 = u32(d, 10), b2 = u32(d, 14), fill = u16(d, 18);
      const side = (dg: number, icv: number, ext: ExtColor): SheetBorder | undefined => {
        if (!dg || !BORDER[dg]) return undefined;
        return { style: BORDER[dg], color: (ext !== undefined && ext !== null ? ext : undefined) ?? color(icv) ?? "#000000" };
      };
      const bl = side(b1 & 0x0f, (b1 >>> 16) & 0x7f, e?.bl ?? null);
      const br = side((b1 >>> 4) & 0x0f, (b1 >>> 23) & 0x7f, e?.br ?? null);
      const bt = side((b1 >>> 8) & 0x0f, b2 & 0x7f, e?.bt ?? null);
      const bb = side((b1 >>> 12) & 0x0f, (b2 >>> 7) & 0x7f, e?.bb ?? null);
      if (bl) st.bl = bl;
      if (br) st.br = br;
      if (bt) st.bt = bt;
      if (bb) st.bb = bb;
      // fill: solid = its foreground colour; another pattern = its foreground and background colours mixed by how much
      // of the cell the pattern covers (one colour for the hatch — named in a notice); a gradient = its pattern colour
      const fls = (b2 >>> 26) & 0x3f;
      if (fls) {
        const fg = (e?.fg !== undefined && e.fg !== null ? e.fg : color(fill & 0x7f)) ?? "#000000";
        const bg = (e?.bg !== undefined && e.bg !== null ? e.bg : color((fill >> 7) & 0x7f)) ?? "#FFFFFF";
        st.fill = fls === 1 ? fg : mix(fg, bg, PATTERN_COVER[fls] ?? 0.5);
        if (fls !== 1) patterned.add(ix);
      }
      if (e?.gradient) patterned.add(ix);
    }
    styleCache.set(ix, st);
    return st;
  };
  const DEFAULT_XF = xfs.length > 15 ? 15 : 0;

  // defined names: the workbook's and each sheet's own (formulas decoded; built-in names go to the page setup)
  const wbNames: Record<string, string> = {};
  const localNames = new Map<number, Record<string, string>>();
  for (const n of defNames) {
    if (n.builtin || n.func || !n.name || n.hidden) continue;
    const f = decodeFormula(n.rgce, 0, n.cce, n.rgce.length, 0, 0, ctx);
    if (f === null) continue;
    if (n.itab) {
      const m = localNames.get(n.itab - 1) ?? {};
      m[n.name] = f;
      localNames.set(n.itab - 1, m);
    } else wbNames[n.name] = f;
  }

  // ── sheets ──
  const out: SheetData[] = [];
  let truncated = false, total = 0;
  const fallbackBook = uid("bk");
  // (QA 2026-11-21: each substream read once — a damaged file's BOUNDSHEETs that all point at one sheet are not that
  // sheet thousands of times; positions looked up, not searched for each sheet)
  const recAt = new Map<number, number>();
  recs.forEach((r, k) => {
    if (r.type === BOF) recAt.set(r.off - 4, k);
  });
  const readAt = new Set<number>();
  bound.forEach((bs, si) => {
    const start = recAt.get(bs.pos) ?? -1;
    if (start < 0 || readAt.has(start)) return;
    readAt.add(start);
    const dt = u16(wb, recs[start].off + 2);
    if (bs.dt !== 0 || dt !== 0x0010) {
      // (a VBA module sheet, dt 6: Excel shows no sheet for it either — code, not content; QA 2026-11-21)
      if (bs.dt !== 6 && dt !== 0x0006) note("chartSheets");
      return;
    }
    const used = new Map<number, number>([[DEFAULT_XF, 0]]);
    const styles: SheetStyle[] = [styleOfXf(DEFAULT_XF)];
    const styleOf = (ix: number) => {
      if (ix === DEFAULT_XF || !xfs[ix]) return 0;
      let k = used.get(ix);
      if (k === undefined) {
        k = styles.push(styleOfXf(ix)) - 1;
        used.set(ix, k);
      }
      return k;
    };
    const sh: SheetData = { book: books?.[out.length] ?? books?.[0] ?? fallbackBook, name: bs.name, cells: {}, styles, colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont, baseSize, mdw, lang };
    if (bs.state) sh.hidden = true;
    if (date1904) sh.date1904 = true;
    const nm = { ...wbNames, ...(localNames.get(si) ?? {}) };
    if (Object.keys(nm).length) sh.names = nm;
    const cells = sh.cells;
    const put = (r: number, c: number, cell: SheetCell) => {
      if (++total > MAX_CELLS) {
        truncated = true;
        return;
      }
      if (cell.v === undefined && !cell.f && !cell.s) return;
      cells[addr(r, c)] = cell;
    };
    const withXf = (ix: number): SheetCell => {
      const s = styleOf(ix);
      return s ? { s } : {};
    };
    const print: SheetPrint = {};
    const margins = { l: 0.75, r: 0.75, t: 1, b: 1, header: 0.5, footer: 0.5 };
    let fitToPage = false, setup: Uint8Array | null = null, frozen = false, pane: Uint8Array | null = null;
    let defCols = 8, stdWidth = -1;
    const hiddenRows: number[] = [], hiddenCols: number[] = [];
    const rowS: Record<number, number> = {}, colS: Record<number, number> = {};
    const formulas: { r: number; c: number; d: Uint8Array }[] = [];
    const shared = new Map<string, Uint8Array>(), arrays = new Map<string, { ref: string; d: Uint8Array }>(), tables = new Set<string>();
    let lastFormula: { r: number; c: number } | null = null;
    let pendingString: string | null = null;
    const notes: Record<string, SheetNote> = {};
    const objText = new Map<number, string>();
    const noteRecs: { r: number; c: number; id: number; author: string }[] = [];
    let lastObj = -1;
    let depth = 0;
    for (let k = start + 1; k < recs.length; k++) { work++;
      const r = recs[k];
      if (r.type === BOF) {
        depth++;
        continue;
      }
      if (r.type === EOF) {
        if (depth-- === 0) break;
        continue;
      }
      if (depth > 0) continue; // a chart inside the sheet (counted by its OBJ)
      const d = wb.subarray(r.off, r.off + r.len);
      switch (r.type) {
        // cells
        case 0x00fd: {
          const ix = u32(d, 6);
          put(u16(d, 0), u16(d, 2), { ...withXf(u16(d, 4)), v: sst.strings[ix] ?? "" });
          if (runsShow(sst.rich[ix], u16(d, 4))) note("richText");
          break;
        }
        case 0x0204:
          put(u16(d, 0), u16(d, 2), { ...withXf(u16(d, 4)), v: xlStr(d, 6).s });
          break;
        case 0x00d6:
          put(u16(d, 0), u16(d, 2), { ...withXf(u16(d, 4)), v: xlStr(d, 6).s });
          note("richText");
          break;
        case 0x0203:
          put(u16(d, 0), u16(d, 2), { ...withXf(u16(d, 4)), v: f64(d, 6) });
          break;
        case 0x027e:
          put(u16(d, 0), u16(d, 2), { ...withXf(u16(d, 4)), v: rk(u32(d, 6)) });
          break;
        case 0x00bd: {
          const row = u16(d, 0), first = u16(d, 2), n = (r.len - 6) / 6;
          for (let q = 0; q < n; q++) put(row, first + q, { ...withXf(u16(d, 4 + q * 6)), v: rk(u32(d, 6 + q * 6)) });
          break;
        }
        case 0x0201:
          put(u16(d, 0), u16(d, 2), withXf(u16(d, 4)));
          break;
        case 0x00be: {
          const row = u16(d, 0), first = u16(d, 2), n = (r.len - 6) / 2;
          for (let q = 0; q < n; q++) put(row, first + q, withXf(u16(d, 4 + q * 2)));
          break;
        }
        case 0x0205: {
          const cell = withXf(u16(d, 4));
          if (d[7]) {
            cell.v = ERR[d[6]] ?? "#N/A";
            cell.t = "e";
          } else cell.v = d[6] !== 0;
          put(u16(d, 0), u16(d, 2), cell);
          break;
        }
        case 0x0006: {
          const row = u16(d, 0), col = u16(d, 2);
          const cell = withXf(u16(d, 4));
          pendingString = null;
          if (u16(d, 12) === 0xffff) {
            const kind = d[6];
            if (kind === 0) {
              pendingString = addr(row, col);
              cell.v = ""; // the STRING record after it holds the text
            }
            else if (kind === 1) cell.v = d[8] !== 0;
            else if (kind === 2) {
              cell.v = ERR[d[8]] ?? "#N/A";
              cell.t = "e";
            } else if (kind === 3) cell.v = "";
          } else cell.v = f64(d, 6);
          put(row, col, cell);
          formulas.push({ r: row, c: col, d });
          lastFormula = { r: row, c: col };
          break;
        }
        case 0x0207:
          if (pendingString) {
            const c = cells[pendingString];
            if (c) c.v = xlStr(d, 0).s;
          }
          pendingString = null;
          break;
        case 0x04bc: {
          // shared formula: after the FORMULA of the cell the members' PtgExp point at (also keyed by its range's corner)
          shared.set(`${u16(d, 0)},${d[4]}`, d);
          if (lastFormula) shared.set(`${lastFormula.r},${lastFormula.c}`, d);
          break;
        }
        case 0x0221: {
          const a = { ref: `${addr(u16(d, 0), d[4])}:${addr(u16(d, 2), d[5])}`, d };
          arrays.set(`${u16(d, 0)},${d[4]}`, a);
          if (lastFormula) arrays.set(`${lastFormula.r},${lastFormula.c}`, a);
          break;
        }
        case 0x0236:
          if (lastFormula) tables.add(`${lastFormula.r},${lastFormula.c}`);
          break;
        // rows and columns
        case 0x0208: {
          const rn = u16(d, 0), miy = u16(d, 6) & 0x7fff, g = d[12];
          const px = Math.round((miy / 20) * (96 / 72));
          if (g & 0x20) hiddenRows.push(rn);
          if (g & 0x40 || px !== sh.defRowH) {
            sh.rowH[rn] = px;
            if (!(g & 0x40)) (sh.rowAuto ??= {})[rn] = true;
          }
          if (g & 0x80) {
            const s = styleOf(u16(d, 14) & 0x0fff);
            if (s) rowS[rn] = s;
          }
          break;
        }
        case 0x0225: {
          const g = u16(d, 0);
          if (!(g & 0x02)) sh.defRowH = Math.round((u16(d, 2) / 20) * (96 / 72));
          if (g & 0x01) sh.defRowCustom = true;
          break;
        }
        case 0x0055:
          defCols = u16(d, 0);
          break;
        case 0x0099:
          stdWidth = u16(d, 0);
          break;
        case 0x007d: {
          const c0 = u16(d, 0), c1 = Math.min(u16(d, 2), 255), w = u16(d, 4), ix = u16(d, 6), g = u16(d, 8);
          for (let c = c0; c <= c1; c++) {
            sh.colW[c] = widthPx(w / 256, mdw);
            if (g & 0x01) hiddenCols.push(c);
            const s = ix !== DEFAULT_XF ? styleOf(ix) : 0;
            if (s) colS[c] = s;
          }
          break;
        }
        case 0x00e5: {
          const n = u16(d, 0);
          for (let q = 0; q < n && 2 + q * 8 + 8 <= d.length; q++) {
            const o = 2 + q * 8;
            sh.merges.push(`${addr(u16(d, o), u16(d, o + 4))}:${addr(u16(d, o + 2), u16(d, o + 6))}`);
          }
          break;
        }
        // view
        case 0x023e: {
          const g = u16(d, 0);
          if (!(g & 0x02)) sh.grid = false;
          if (!(g & 0x04)) sh.headings = false;
          if (g & 0x08) frozen = true;
          if (g & 0x40) sh.rtl = true;
          const top = u16(d, 2), left = u16(d, 4);
          if (top || left) sh.topLeft = addr(top, left);
          break;
        }
        case 0x0041:
          pane = d;
          break;
        case 0x00a0: {
          const z = u16(d, 0) / (u16(d, 2) || 1);
          if (z && Math.abs(z - 1) > 1e-9) sh.zoom = z;
          break;
        }
        case 0x001d:
          if (d.length >= 5) sh.active = addr(u16(d, 1), u16(d, 3));
          break;
        case 0x0862: {
          // SHEETEXT: the tab's palette colour, and (cb > 20) its full colour (FullColorExt at 24) Excel 2007+ uses
          const icv = u32(d, 16) & 0x7f;
          let c = icv !== 0x7f ? color(icv) : undefined;
          if (u32(d, 12) > 20 && d.length >= 32) {
            const kind = u16(d, 24), tint = s16(d, 26) / 32767, v = u32(d, 28);
            const rgb = kind === 2 ? [d[28], d[29], d[30]].map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase() : kind === 3 ? theme[v] : kind === 1 && v < 64 ? palette[v] : undefined;
            if (rgb) c = "#" + tinted(rgb, tint);
          }
          if (c) sh.tabColor = c;
          break;
        }
        // page setup
        case 0x00a1:
          setup = d;
          break;
        case 0x0081:
          if (u16(d, 0) & 0x0100) fitToPage = true;
          break;
        case 0x0026:
          margins.l = f64(d, 0);
          break;
        case 0x0027:
          margins.r = f64(d, 0);
          break;
        case 0x0028:
          margins.t = f64(d, 0);
          break;
        case 0x0029:
          margins.b = f64(d, 0);
          break;
        case 0x0083:
          if (u16(d, 0)) print.hCenter = true;
          break;
        case 0x0084:
          if (u16(d, 0)) print.vCenter = true;
          break;
        case 0x002b:
          if (u16(d, 0)) print.grid = true;
          break;
        case 0x002a:
          if (u16(d, 0)) print.headings = true;
          break;
        case 0x0014:
          if (r.len >= 3) {
            const s = xlStr(d, 0).s;
            if (s) print.header = s;
          }
          break;
        case 0x0015:
          if (r.len >= 3) {
            const s = xlStr(d, 0).s;
            if (s) print.footer = s;
          }
          break;
        case 0x089c: {
          if (d.length < 38) break;
          // (guidSView not zero: the headers of a custom view, not of the sheet)
          if (d.subarray(12, 28).some((x) => x !== 0)) break;
          const g = u16(d, 28);
          if (g & 0x01) note("oddEven");
          if (g & 0x02) {
            // the strings: even header, even footer, first header, first footer (each only when its count is not 0)
            let p = 38;
            const strs: string[] = [];
            for (let q = 0; q < 4; q++) {
              const n = u16(d, 30 + q * 2);
              if (!n) {
                strs.push("");
                continue;
              }
              const s = u16(d, p) === n && p + 3 <= d.length ? xlStr(d, p) : { s: chars(d, p + 1, n, (d[p] & 1) === 1), end: p + 1 + n * ((d[p] & 1) === 1 ? 2 : 1) };
              strs.push(s.s);
              p = s.end;
            }
            print.firstHeader = strs[2];
            print.firstFooter = strs[3];
          }
          break;
        }
        case 0x001b:
        case 0x001a: {
          const n = u16(d, 0), list: number[] = [];
          for (let q = 0; q < n && 2 + q * 6 + 2 <= d.length; q++) list.push(u16(d, 2 + q * 6));
          const brk = [...new Set(list.filter((x) => x > 0))].sort((a, b) => a - b);
          if (brk.length) print[r.type === 0x001b ? "rowBreaks" : "colBreaks"] = brk;
          break;
        }
        // notes, objects, links, rules
        case 0x005d: {
          // OBJ: its first sub-record is FtCmo (ot, id)
          if (u16(d, 0) !== 0x15) break;
          const ot = u16(d, 4);
          lastObj = u16(d, 6);
          if (ot === 0x05) note("charts");
          else if (ot === 0x08) note("pictures");
          else if (ot !== 0x19 && ot !== 0x14 && ot !== 0x00) note("shapes");
          break;
        }
        case 0x01b6: {
          // TXO: its text is in the CONTINUE records after it (each piece starts with an option byte)
          const cch = u16(d, 10);
          let s = "";
          for (let q = k + 1; q < recs.length && recs[q].type === CONTINUE && s.length < cch; q++) {
            const c = recs[q];
            const wide = (wb[c.off] & 1) === 1;
            const n = Math.min(cch - s.length, Math.floor((c.len - 1) / (wide ? 2 : 1)));
            s += chars(wb, c.off + 1, n, wide);
          }
          if (lastObj >= 0) objText.set(lastObj, s);
          break;
        }
        case 0x001c:
          if (d.length >= 8) noteRecs.push({ r: u16(d, 0), c: u16(d, 2), id: u16(d, 6), author: d.length > 10 ? xlStr(d, 8).s : "" });
          break;
        case 0x01b8:
          note("hyperlinks");
          break;
        case 0x01b0:
        case 0x0879:
          note("cond");
          break;
        case 0x01b2:
          // DVAL: how many DV records follow (idvMac) — a DVAL left with none is no data validation
          if (d.length < 18 || u32(d, 14) > 0) note("valid");
          break;
        case 0x009d:
          note("filter");
          break;
      }
    }
    // formulas: decoded now that the shared / array formulas after their first cells are known
    let undecoded = 0;
    for (const fm of formulas) {
      const d = fm.d, cce = u16(d, 20);
      const cell = cells[addr(fm.r, fm.c)];
      if (!cell) continue;
      let f: string | null = null;
      if (cce === 5 && d[22] === 0x01) {
        const key = `${u16(d, 23)},${u16(d, 25)}`;
        const shr = shared.get(key), arr = arrays.get(key);
        if (arr) {
          // an array formula: its text on its first cell, the others are filled by it
          if (fm.r === u16(d, 23) && fm.c === u16(d, 25)) {
            const a = arr.d;
            f = decodeFormula(a, 14, u16(a, 12), a.length, fm.r, fm.c, ctx);
            if (f !== null) {
              cell.spill = arr.ref;
              cell.cse = true;
            }
          } else continue;
        } else if (shr) f = decodeFormula(shr, 10, u16(shr, 8), shr.length, fm.r, fm.c, ctx, true);
      } else if (cce && d[22] !== 0x02 && !tables.has(`${fm.r},${fm.c}`)) f = decodeFormula(d, 22, cce, d.length, fm.r, fm.c, ctx);
      if (f === null) undecoded++;
      else cell.f = f;
    }
    if (undecoded) note("formulaValues", undecoded);
    markSpills(sh);
    // sizes
    sh.defColW = stdWidth >= 0 ? widthPx(stdWidth / 256, mdw) : Math.ceil((defCols * mdw + 5) / 8) * 8;
    if (hiddenRows.length) sh.hiddenRows = hiddenRows;
    if (hiddenCols.length) sh.hiddenCols = hiddenCols;
    if (Object.keys(rowS).length) sh.rowS = rowS;
    if (Object.keys(colS).length) sh.colS = colS;
    // (DEFAULTROWHEIGHT comes before the ROW records in a sheet substream: the comparison above used the sheet's default)
    if (frozen && pane && pane.length >= 4) {
      const cols = u16(pane, 0), rows = u16(pane, 2);
      if (rows || cols) sh.freeze = { rows, cols };
    }
    // notes: the text of the object each NOTE points at
    for (const n of noteRecs) {
      const text = objText.get(n.id);
      if (text === undefined) continue;
      notes[addr(n.r, n.c)] = { text, ...(n.author ? { author: n.author } : {}) };
    }
    if (Object.keys(notes).length) sh.notes = notes;
    // page setup ([MS-XLS] SETUP: the paper, scale and orientation are not valid when fNoPls is set)
    if (setup && setup.length >= 34) {
      const g = u16(setup, 10);
      if (!(g & 0x04)) {
        const paper = u16(setup, 0);
        if (paper) print.paper = paper;
        if (!(g & 0x02) && !(g & 0x40)) print.landscape = true;
        const sc = u16(setup, 2);
        if (sc && sc !== 100) print.scale = Math.min(400, Math.max(10, sc));
      }
      if (g & 0x80) print.firstPage = s16(setup, 4);
      if (g & 0x01) print.overThenDown = true;
      if (fitToPage) print.fit = { w: u16(setup, 6), h: u16(setup, 8) };
      margins.header = f64(setup, 16);
      margins.footer = f64(setup, 24);
    } else if (fitToPage) print.fit = { w: 1, h: 1 };
    print.margins = margins;
    printNames(defNames, si, ctx, print);
    sh.print = print;
    out.push(sh);
  });
  if (patterned.size || superSub.size) {
    const used = usedStyles(out);
    for (const ix of patterned) if (used.has(styleCache.get(ix)!)) note("pattern");
    for (const ix of superSub) if (used.has(styleCache.get(ix)!)) note("superSub");
  }
  if (truncated) note("truncated");
  return { sheets: out, notices: [...notices].map(([kind, n]) => ({ kind, n })), truncated };
}

/** the style objects a cell, row or column of the sheets uses (a pattern in an XF nothing uses is no notice) — once for
 * all the XFs (QA 2026-11-21: not every cell again for each patterned XF) */
function usedStyles(sheets: readonly SheetData[]): Set<SheetStyle> {
  const out = new Set<SheetStyle>();
  for (const sh of sheets) {
    const add = (k: number | undefined) => {
      if (k) out.add(sh.styles[k]);
    };
    for (const c of Object.values(sh.cells)) add(c.s);
    for (const k of Object.values(sh.rowS ?? {})) add(k);
    for (const k of Object.values(sh.colS ?? {})) add(k);
  }
  return out;
}

/** Print area / titles of sheet `si` from its built-in names (formulas like Sheet1!$A$1:$D$20,Sheet1!$1:$2). */
function printNames(names: readonly DefName[], si: number, ctx: FormulaCtx, p: SheetPrint) {
  for (const n of names) {
    if (!n.builtin || n.itab !== si + 1 || (n.name !== "Print_Area" && n.name !== "Print_Titles")) continue;
    const f = decodeFormula(n.rgce, 0, n.cce, n.rgce.length, 0, 0, ctx);
    if (!f) continue;
    const parts: string[] = [];
    let cur = "", q = false;
    for (const ch of f) {
      if (ch === "'") q = !q;
      if (ch === "," && !q) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) parts.push(cur);
    const refs = parts.map((r) => r.trim().replace(/^.*!/, "").replace(/\$/g, "")).filter(Boolean);
    if (n.name === "Print_Area") {
      const area = refs.filter((r) => /^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(r));
      if (area.length) p.area = area;
    } else
      for (const r of refs) {
        const rows = /^(\d+):(\d+)$/.exec(r);
        const cols = /^([A-Z]{1,3}):([A-Z]{1,3})$/i.exec(r);
        if (rows) p.titleRows = [Number(rows[1]) - 1, Number(rows[2]) - 1];
        else if (cols) p.titleCols = [colNum(cols[1]), colNum(cols[2])];
      }
  }
}
const colNum = (s: string) => [...s.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** How much of a cell each fill pattern ([MS-XLS] 2.5.152 FillPattern, 2–18) paints in its foreground colour. */
const PATTERN_COVER: Record<number, number> = { 2: 0.5, 3: 0.75, 4: 0.25, 5: 0.5, 6: 0.5, 7: 0.5, 8: 0.5, 9: 0.75, 10: 0.75, 11: 0.25, 12: 0.25, 13: 0.25, 14: 0.25, 15: 0.4375, 16: 0.375, 17: 0.125, 18: 0.0625 };
/** `a` over `b` at coverage k (#RRGGBB). */
function mix(a: string, b: string, k: number): string {
  const ch = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(ch(a, i) * k + ch(b, i) * (1 - k)).toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** RK number ([MS-XLS] 2.5.218 RkNumber): a 30-bit integer or the high bits of a double, maybe divided by 100. */
function rk(v: number): number {
  let n: number;
  if (v & 2) n = (v | 0) >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    n = buf.getFloat64(0, true);
  }
  return v & 1 ? n / 100 : n;
}

/** A future record (THEME …) with its CONTINUEFRT12 records joined — each continuation without its 12-byte header. */
function joinedFrt(wb: Uint8Array, recs: readonly Rec[], i: number): Uint8Array {
  const parts = [wb.subarray(recs[i].off, recs[i].off + recs[i].len)];
  for (let j = i + 1; j < recs.length && recs[j].type === 0x0875; j++) parts.push(wb.subarray(recs[j].off + 12, recs[j].off + recs[j].len));
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const x of parts) {
    out.set(x, p);
    p += x.length;
  }
  return out;
}
