// XLS (Excel 97-2003, BIFF8) same-format save, stage 2: a workbook opened from an .xls whose cell values alone were
// edited (legacyWrite.ts xlsValuesOnly — the fingerprint without the values is the one taken at open). The values are
// written into the BIFF records of the original Workbook stream; every other stream of the compound file, and every
// record but the ones below, stays byte for byte. Loaded only when such a workbook is saved as XLS (not at start-up).
//
//   values     the cells whose value differs from the file read again as it was opened (xlsPages with the same
//              workbook ids, checked against the fingerprint of the open — another reader version is refused)
//   cells      the old record of the cell is replaced: a number → RK (when it fits) or NUMBER, a text → LABELSST, a
//              logical value → BOOLERR, cleared → BLANK (only when the cell has its own format, else nothing). MULRK /
//              MULBLANK are cut around the cell. The cell keeps the XF (format) of its old record; a new cell takes the
//              row's XF (ROW fGhostDirty), else the column's (COLINFO), else the default cell XF 15
//   formulas   a formula cell given a value: its FORMULA record (with STRING) becomes the value record. Refused (save as
//              XLSX): the first cell of a shared formula (SHRFMLA follows it), array formulas and data tables (a part
//              of an array cannot be changed in Excel either). A formula typed in is not a value edit (xlsShape).
//              Since the open reads the formulas (io/sheet/readXls.ts, 2026-11-21), a formula typed in or changed is
//              refused; a formula replaced by a value is written, even by its own result; an error value is written as
//              one (BOOLERR)
//   recalc     a formula still in its cell (and a cell an array formula fills) whose result the engine calculated anew
//              after the edits gets that result as its cached value (FORMULA FormulaValue, STRING — QA 2026-11-21: a
//              reader that does not calculate, Omniweave's own included, would show the old result otherwise); one the
//              engine could not calculate keeps the file's (without the engine: all stay as they were); RECALCID is removed, so Excel
//              recalculates every formula when it loads the file ([MS-XLS] RecalcId: a calculation engine older than
//              Excel's own — none at all — means a full recalculation after load; checked in Excel, xls_check.ps1).
//              CALCMODE / CALCCOUNT are left alone: they are the calculation mode and the iteration count, not a "recalculate on open" switch.
//              In manual calculation (CALCMODE 0) Excel does not recalculate on load at all, so an edit is refused while
//              any formula is left in the workbook (QA 2026-11-17: B1 =A1*2 still showed the old result in Excel)
//   SST        texts not in the table yet are appended (a full record continues in a CONTINUE record, characters cut
//              with a fresh option byte), cstTotal / cstUnique follow, and EXTSST is computed again rather than dropped
//              (dsst kept; [MS-XLS] 2.4.107 ExtSST: ceil(cstUnique / dsst) buckets, each a string's stream position and
//              its offset in its record) — Excel itself always writes it after SST
//   rows       ROW records of edited rows get their first / last column again; a row with a new cell and no ROW record
//              gets one (default height); DIMENSIONS and INDEX rows / columns grow to the new cells
//   positions  BOUNDSHEET lbPlyPos (each sheet's BOF), INDEX (DBCELL positions, ibXF) and the DBCELL offsets of the
//              edited sheet's row blocks are computed again for the new stream
//
// Source: [MS-XLS] Excel Binary File Format — Microsoft open specification.

import type { Page } from "../../core/types";
import { t } from "../../i18n";
import { parseAddr } from "../sheet/formula";
import { readCfbTree, writeCfb } from "./cfb";
import { legacyFingerprint, xlsPages } from "./legacyWrite";

type Val = number | string | boolean | undefined;
/** one cell's new value (undefined: cleared), 0-based row / column */
export interface XlsCellEdit {
  r: number;
  c: number;
  v: Val;
  /** the value is an error (#N/A …): written as one (BOOLERR fError), not as a text */
  err?: boolean;
  /** a formula kept in its cell: `v` is its new result, written as the formula's cached value (formulaResult) */
  cached?: boolean;
}
/** BOOLERR error codes ([MS-XLS] 2.5.10 Bes) */
const ERR_CODE: Record<string, number> = { "#NULL!": 0x00, "#DIV/0!": 0x07, "#VALUE!": 0x0f, "#REF!": 0x17, "#NAME?": 0x1d, "#NUM!": 0x24, "#N/A": 0x2a };

const BOF = 0x0809, EOF = 0x000a, BOUNDSHEET = 0x0085, SST = 0x00fc, EXTSST = 0x00ff, CONTINUE = 0x003c, RECALCID = 0x01c1;
const CALCMODE = 0x000d, INDEX = 0x020b, DIMENSIONS = 0x0200, ROW = 0x0208, DBCELL = 0x00d7, COLINFO = 0x007d, DEFAULTROWHEIGHT = 0x0225;
const FORMULA = 0x0006, BLANK = 0x0201, MULBLANK = 0x00be, RK = 0x027e, MULRK = 0x00bd, BOOLERR = 0x0205, NUMBER = 0x0203;
const LABELSST = 0x00fd, LABEL = 0x0204, RSTRING = 0x00d6;
const STRING = 0x0207, SHRFMLA = 0x04bc, ARRAY = 0x0221, TABLE = 0x0236;
/** cell records ([MS-XLS] CELL) */
const CELLS = new Set([FORMULA, BLANK, MULBLANK, RK, MULRK, BOOLERR, NUMBER, LABELSST, LABEL, RSTRING]);
/** records that belong to the FORMULA before them */
const ATTACHED = new Set([STRING, SHRFMLA, ARRAY, TABLE, CONTINUE]);
/** every record of the cell table ([MS-XLS] CELLTABLE) */
const CELL_TABLE = new Set([...CELLS, ...ATTACHED, ROW, DBCELL]);
/** the most data one record holds */
const MAX_DATA = 8224;
/** the default cell XF of a BIFF8 workbook (the first 15 are style XFs) */
const DEFAULT_XF = 15;

/** A cell edit this stage does not write: the advice is to save as XLSX (the message says why). */
export class XlsRefused extends Error {}
const refuse = (why: "formula" | "formulaEdit" | "layout" | "reader" | "calc") => new XlsRefused(t("legacysave.err.xlsCells", { why: t(`legacysave.xlsWhy.${why}`) }));

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
const put16 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 0xff;
  b[o + 1] = (v >>> 8) & 0xff;
};
const put32 = (b: Uint8Array, o: number, v: number) => {
  put16(b, o, v & 0xffff);
  put16(b, o + 2, Math.floor(v / 0x10000) & 0xffff);
};

/** One BIFF record: its type and data; `at` = its offset in the original stream (−1 for a record made here). */
interface Rec {
  type: number;
  data: Uint8Array;
  at: number;
}
const made = (type: number, data: Uint8Array): Rec => ({ type, data, at: -1 });
/** a copy of a record to change (it keeps its original offset: pointers to it are moved with it) */
const copy = (r: Rec): Rec => ({ type: r.type, data: r.data.slice(), at: r.at });

/** The records of a Workbook stream: whole substreams (BOF … EOF), and whatever follows the last one. */
function readRecords(wb: Uint8Array): { recs: Rec[]; tail: Uint8Array } {
  const recs: Rec[] = [];
  let o = 0, depth = 0;
  while (o + 4 <= wb.length) {
    const type = u16(wb, o), len = u16(wb, o + 2);
    if (depth === 0 && type !== BOF) break;
    if (o + 4 + len > wb.length) throw refuse("layout");
    recs.push({ type, data: wb.subarray(o + 4, o + 4 + len), at: o });
    if (type === BOF) depth++;
    else if (type === EOF) depth--;
    o += 4 + len;
  }
  if (depth !== 0 || !recs.length || u16(recs[0].data, 0) !== 0x0600) throw refuse("layout"); // BIFF8 only
  return { recs, tail: wb.subarray(o) };
}

/** The top substreams: index of the BOF and of its EOF in `recs` (substreams inside them, e.g. charts, included). */
function substreams(recs: readonly Rec[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let depth = 0, start = 0;
  recs.forEach((r, i) => {
    if (r.type === BOF) {
      if (depth === 0) start = i;
      depth++;
    } else if (r.type === EOF && --depth === 0) out.push({ start, end: i });
  });
  return out;
}

/** The records of a substream at its own level (not those of substreams inside it), by index in `recs`. */
function topLevel(recs: readonly Rec[], s: { start: number; end: number }): number[] {
  const out: number[] = [];
  let depth = 0;
  for (let i = s.start + 1; i < s.end; i++) {
    if (depth === 0) out.push(i);
    if (recs[i].type === BOF) depth++;
    else if (recs[i].type === EOF) depth--;
  }
  return out;
}

// ───────────────────────── shared strings ─────────────────────────

/**
 * The strings of an SST record and its CONTINUE records (`parts`: their data), with where each one starts. A string
 * cut between records continues with a fresh option byte (its characters may change between 8 and 16 bits there).
 */
function walkSst(parts: readonly Uint8Array[]) {
  const strings: string[] = [];
  const plain: boolean[] = [];
  const pos: { part: number; off: number }[] = [];
  let p = 0, o = 8;
  const next = () => {
    if (++p >= parts.length) throw refuse("layout");
    o = 0;
  };
  const need = (n: number) => {
    if (o + n > parts[p].length) next();
  };
  const unique = parts[0].length >= 8 ? u32(parts[0], 4) : 0;
  for (let k = 0; k < unique; k++) {
    need(3);
    pos.push({ part: p, off: o });
    const cch = u16(parts[p], o);
    const head = parts[p][o + 2];
    let wide = head & 1;
    o += 3;
    let runs = 0, ext = 0;
    if (head & 0x08) {
      need(2);
      runs = u16(parts[p], o);
      o += 2;
    }
    if (head & 0x04) {
      need(4);
      ext = u32(parts[p], o);
      o += 4;
    }
    let s = "";
    for (let left = cch; left > 0; ) {
      if (parts[p].length - o < (wide ? 2 : 1)) {
        next();
        wide = parts[p][o++] & 1;
      }
      const take = Math.min(left, Math.floor((parts[p].length - o) / (wide ? 2 : 1)));
      for (let i = 0; i < take; i++) s += String.fromCharCode(wide ? u16(parts[p], o + i * 2) : parts[p][o + i]);
      o += take * (wide ? 2 : 1);
      left -= take;
    }
    for (let skip = runs * 4 + ext; skip > 0; ) {
      if (o >= parts[p].length) next();
      const n = Math.min(skip, parts[p].length - o);
      o += n;
      skip -= n;
    }
    strings.push(s);
    plain.push(!(head & 0x0c)); // no formatting runs, no phonetic data
  }
  return { strings, plain, pos, end: { part: p, off: o } };
}

/** The strings appended to `parts` (the last one filled, then new CONTINUE records), with cstTotal / cstUnique. */
function appendSst(parts: readonly Uint8Array[], add: readonly string[], total: number, unique: number): Uint8Array[] {
  const done = parts.slice(0, -1).map((d) => d.slice());
  let cur = Array.from(parts[parts.length - 1]);
  const room = () => MAX_DATA - cur.length;
  const newPart = () => {
    done.push(Uint8Array.from(cur));
    cur = [];
  };
  for (const s of add) {
    let wide = false;
    for (let i = 0; i < s.length && !wide; i++) {
      const c = s.charCodeAt(i);
      wide = c > 0xff || (c >= 0x80 && c < 0xa0); // 8-bit only for ASCII and Latin-1 letters
    }
    const size = wide ? 2 : 1;
    if (room() < 3 + size) newPart(); // a string's header (cch, options) is never cut
    cur.push(s.length & 0xff, s.length >> 8, wide ? 1 : 0);
    for (let i = 0; i < s.length; ) {
      if (room() < size) {
        newPart();
        cur.push(wide ? 1 : 0); // the characters go on in the next record, after a fresh option byte
      }
      const take = Math.min(s.length - i, Math.floor(room() / size));
      for (let k = 0; k < take; k++) {
        const c = s.charCodeAt(i + k);
        if (wide) cur.push(c & 0xff, c >> 8);
        else cur.push(c);
      }
      i += take;
    }
  }
  done.push(Uint8Array.from(cur));
  put32(done[0], 0, total);
  put32(done[0], 4, unique);
  return done;
}

/** The shared string table as the edits use it: an index for each text (an existing plain one, else a new one). */
class Strings {
  readonly strings: string[];
  readonly added: string[] = [];
  /** change of cstTotal: LABELSST cells added − removed */
  delta = 0;
  private readonly index = new Map<string, number>();
  constructor(readonly parts: Uint8Array[] | null) {
    const w = parts ? walkSst(parts) : null;
    this.strings = w?.strings ?? [];
    w?.strings.forEach((s, i) => {
      if (w.plain[i] && !this.index.has(s)) this.index.set(s, i);
    });
  }
  of(s: string): number {
    if (!this.parts) throw refuse("layout"); // no SST to add to
    if (s.length > 32767) throw refuse("layout"); // longer than a cell holds
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.strings.length + this.added.length;
      this.added.push(s);
      this.index.set(s, i);
    }
    this.delta++;
    return i;
  }
}

// ───────────────────────── cell table ─────────────────────────

/** A cell record (with the records that belong to it) covering columns c0 … c1 of row r. */
interface Unit {
  r: number;
  c0: number;
  c1: number;
  recs: Rec[];
}

function rkOf(v: number): number | null {
  if (Number.isInteger(v) && v >= -0x20000000 && v <= 0x1fffffff) return ((v * 4) | 2) >>> 0;
  const x = v * 100;
  if (Number.isInteger(x) && x >= -0x20000000 && x <= 0x1fffffff && x / 100 === v) return ((x * 4) | 3) >>> 0;
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, true);
  const hi = dv.getUint32(4, true);
  return dv.getUint32(0, true) === 0 && (hi & 3) === 0 ? hi : null;
}

function cellRec(r: number, c: number, xf: number, extra: number): Uint8Array {
  const d = new Uint8Array(6 + extra);
  put16(d, 0, r);
  put16(d, 2, c);
  put16(d, 4, xf);
  return d;
}

/** The records of one value (none for a cleared cell without a format of its own). */
function valueUnit(r: number, c: number, xf: number, v: Val, plainXf: number, sst: Strings, err = false): Unit | null {
  let rec: Rec;
  if (err && typeof v === "string") {
    const code = ERR_CODE[v.toUpperCase()];
    if (code === undefined) throw refuse("layout");
    const d = cellRec(r, c, xf, 2);
    d[6] = code;
    d[7] = 1;
    rec = made(BOOLERR, d);
  } else if (v === undefined || v === null) {
    if (xf === plainXf) return null;
    rec = made(BLANK, cellRec(r, c, xf, 0));
  } else if (typeof v === "boolean") {
    const d = cellRec(r, c, xf, 2);
    d[6] = v ? 1 : 0;
    rec = made(BOOLERR, d);
  } else if (typeof v === "number") {
    if (!Number.isFinite(v)) throw refuse("layout");
    const rk = rkOf(v);
    if (rk !== null) {
      const d = cellRec(r, c, xf, 4);
      put32(d, 6, rk);
      rec = made(RK, d);
    } else {
      const d = cellRec(r, c, xf, 8);
      new DataView(d.buffer).setFloat64(6, v, true);
      rec = made(NUMBER, d);
    }
  } else {
    const d = cellRec(r, c, xf, 4);
    put32(d, 6, sst.of(String(v)));
    rec = made(LABELSST, d);
  }
  return { r, c0: c, c1: c, recs: [rec] };
}

/**
 * A formula kept in its cell given the result the engine calculated for it after the edits (QA 2026-11-21): its FORMULA
 * record's cached value ([MS-XLS] FormulaValue) and the STRING record after it, the tokens and everything else as they
 * were — so a reader that does not calculate (Omniweave itself, viewers) shows what the app showed; Excel recalculates.
 */
function formulaResult(u: Unit, v: Val, err = false) {
  const f = copy(u.recs[0]);
  const d = f.data;
  if (d.length < 20) throw refuse("layout");
  let text: string | null = null;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw refuse("layout");
    new DataView(d.buffer, d.byteOffset).setFloat64(6, v, true);
  } else {
    d.fill(0, 6, 12);
    put16(d, 12, 0xffff);
    if (typeof v === "boolean") {
      d[6] = 1;
      d[8] = v ? 1 : 0;
    } else if (err && typeof v === "string") {
      const code = ERR_CODE[v.toUpperCase()];
      if (code === undefined) throw refuse("layout");
      d[6] = 2;
      d[8] = code;
    } else if (typeof v === "string") {
      d[6] = v === "" ? 3 : 0;
      if (v !== "") text = v;
    } else throw refuse("layout");
  }
  // the old STRING (and its CONTINUE records) goes; a text result gets a new one after SHRFMLA / ARRAY / TABLE
  const kept: Rec[] = [];
  let inString = false;
  for (const x of u.recs.slice(1)) {
    if (x.type === STRING) inString = true;
    else if (x.type !== CONTINUE) inString = false;
    if (!inString) kept.push(x);
  }
  if (text !== null) {
    const wide = [...text].some((ch) => ch.charCodeAt(0) > 0xff);
    const s = new Uint8Array(3 + text.length * (wide ? 2 : 1));
    if (s.length > MAX_DATA) throw refuse("layout");
    put16(s, 0, text.length);
    s[2] = wide ? 1 : 0;
    for (let i = 0; i < text.length; i++) {
      if (wide) put16(s, 3 + i * 2, text.charCodeAt(i));
      else s[3 + i] = text.charCodeAt(i);
    }
    kept.push(made(STRING, s));
  }
  u.recs = [f, ...kept];
}

/** MULRK / MULBLANK cells c0 … c1 of `u` (`size` bytes each) as a record of their own, or one RK / BLANK. */
function mulPart(u: Unit, c0: number, c1: number): Unit[] {
  if (c1 < c0) return [];
  const d = u.recs[0].data;
  const mulrk = u.recs[0].type === MULRK;
  const size = mulrk ? 6 : 2;
  const from = 4 + (c0 - u.c0) * size;
  const items = d.subarray(from, from + (c1 - c0 + 1) * size);
  if (c0 === c1) {
    const one = new Uint8Array(4 + size);
    put16(one, 0, u.r);
    put16(one, 2, c0);
    one.set(items, 4);
    return [{ r: u.r, c0, c1, recs: [made(mulrk ? RK : BLANK, one)] }];
  }
  const out = new Uint8Array(4 + items.length + 2);
  put16(out, 0, u.r);
  put16(out, 2, c0);
  out.set(items, 4);
  put16(out, 4 + items.length, c1);
  return [{ r: u.r, c0, c1, recs: [made(u.recs[0].type, out)] }];
}

/** The XF of column c in `u`. */
function xfIn(u: Unit, c: number): number {
  const d = u.recs[0].data;
  if (u.recs[0].type === MULRK) return u16(d, 4 + (c - u.c0) * 6);
  if (u.recs[0].type === MULBLANK) return u16(d, 4 + (c - u.c0) * 2);
  return u16(d, 4);
}

/**
 * The records of one sheet substream with `edits` written into its cell table (an empty list rebuilds the table as it
 * is — the row blocks and DBCELL offsets come out the same, which the tests check).
 */
function editSheet(recs: readonly Rec[], s: { start: number; end: number }, edits: readonly XlsCellEdit[], sst: Strings): Rec[] {
  const top = topLevel(recs, s);
  const topSet = new Set(top);
  const inTable = top.filter((i) => recs[i].type === ROW || recs[i].type === DBCELL || CELLS.has(recs[i].type));
  let a: number, b: number; // the cell table: recs[a] … recs[b] (b < a: none, inserted at a)
  if (inTable.length) {
    a = inTable[0];
    b = inTable[inTable.length - 1];
    for (let k = top.indexOf(b) + 1; k < top.length && ATTACHED.has(recs[top[k]].type); k++) b = top[k];
    // one run of cell table records, nothing else in it (no substream either)
    for (let i = a; i <= b; i++) if (!CELL_TABLE.has(recs[i].type)) throw refuse("layout");
  } else {
    const dim = top.find((i) => recs[i].type === DIMENSIONS);
    if (dim === undefined) throw refuse("layout");
    a = dim + 1;
    b = dim;
  }
  // rows, cells
  const rows = new Map<number, Rec>();
  const units = new Map<number, Unit[]>();
  let hadDb = false;
  let last: Unit | null = null;
  for (let i = a; i <= b; i++) {
    const r = recs[i];
    if (r.type === ROW) {
      if (r.data.length < 16 || rows.has(u16(r.data, 0))) throw refuse("layout");
      rows.set(u16(r.data, 0), r);
      last = null;
    } else if (r.type === DBCELL) {
      hadDb = true;
      last = null;
    } else if (ATTACHED.has(r.type)) {
      if (!last || last.recs[0].type !== FORMULA || (r.type === CONTINUE && last.recs.length < 2)) throw refuse("layout");
      last.recs.push(r);
    } else {
      const d = r.data;
      if (d.length < 6) throw refuse("layout");
      const row = u16(d, 0), c0 = u16(d, 2);
      const c1 = r.type === MULRK || r.type === MULBLANK ? u16(d, d.length - 2) : c0;
      const size = r.type === MULRK ? 6 : 2;
      if (c1 < c0 || ((r.type === MULRK || r.type === MULBLANK) && d.length !== 6 + (c1 - c0 + 1) * size)) throw refuse("layout");
      last = { r: row, c0, c1, recs: [r] };
      const list = units.get(row) ?? [];
      if (!units.has(row)) units.set(row, list);
      list.push(last);
    }
  }
  const unitAt = (r: number, c: number) => units.get(r)?.find((u) => u.c0 <= c && c <= u.c1);
  // the format a new cell takes: its row's, else its column's, else the default
  const colInfo = top.filter((i) => recs[i].type === COLINFO).map((i) => recs[i].data);
  const plainXf = (r: number, c: number) => {
    const row = rows.get(r)?.data;
    if (row && row[12] & 0x80) return u16(row, 14) & 0x0fff; // fGhostDirty: the row has a format
    const col = colInfo.find((d) => d.length >= 8 && u16(d, 0) <= c && c <= u16(d, 2));
    return col ? u16(col, 6) : DEFAULT_XF;
  };
  // a formula cell given a value: not the first cell of a shared formula, not part of an array or a data table
  const checkFormula = (u: Unit) => {
    if (u.recs[0].type !== FORMULA) return;
    if (u.recs.some((x) => x.type === SHRFMLA || x.type === ARRAY || x.type === TABLE)) throw refuse("formula");
    const d = u.recs[0].data;
    if (d.length < 23 || u16(d, 20) === 0) return;
    if (d[22] === 0x02) throw refuse("formula"); // PtgTbl: a cell of a data table
    if (d[22] === 0x01 && d.length >= 27) {
      // PtgExp: a cell of a shared formula (fine) or of an array formula (not)
      const anchor = unitAt(u16(d, 23), u16(d, 25));
      if (anchor?.recs.some((x) => x.type === ARRAY || x.type === TABLE)) throw refuse("formula");
    }
  };
  const touched = new Set<number>();
  const seen = new Set<string>();
  for (const e of edits) {
    if (seen.has(`${e.r},${e.c}`)) continue;
    seen.add(`${e.r},${e.c}`);
    if (e.r > 0xffff || e.c > 0xff) throw refuse("layout"); // beyond a BIFF8 sheet
    if (e.cached) {
      // a formula still there: only its stored result (the row's cells and extent stay as they are)
      const u = unitAt(e.r, e.c);
      if (!u || u.recs[0].type !== FORMULA || u.c0 !== u.c1) throw refuse("layout");
      formulaResult(u, e.v, e.err);
      continue;
    }
    const list = units.get(e.r) ?? [];
    if (!units.has(e.r)) units.set(e.r, list);
    const k = list.findIndex((u) => u.c0 <= e.c && e.c <= u.c1);
    let xf = plainXf(e.r, e.c);
    if (k >= 0) {
      const u = list[k];
      checkFormula(u);
      xf = xfIn(u, e.c);
      if (u.recs[0].type === LABELSST) sst.delta--;
      const rest = u.c0 === u.c1 ? [] : [...mulPart(u, u.c0, e.c - 1), ...mulPart(u, e.c + 1, u.c1)];
      list.splice(k, 1, ...rest);
    }
    const unit = valueUnit(e.r, e.c, xf, e.v, plainXf(e.r, e.c), sst, e.err);
    if (unit) list.push(unit);
    list.sort((x, y) => x.c0 - y.c0);
    touched.add(e.r);
  }
  // rows: first / last column again, a ROW record for a row that gets cells and had none
  const dflt = top.map((i) => recs[i]).find((r) => r.type === DEFAULTROWHEIGHT)?.data;
  for (const r of touched) {
    const list = units.get(r) ?? [];
    const old = rows.get(r);
    if (!old && !list.length) continue;
    const row = old ? copy(old) : made(ROW, new Uint8Array(16));
    const d = row.data;
    if (!old) {
      put16(d, 0, r);
      const hidden = dflt && dflt.length >= 4 && u16(dflt, 0) & 0x02;
      put16(d, 6, dflt && dflt.length >= 4 && !hidden ? u16(dflt, 2) : 0xff);
      d[12] = dflt && dflt.length >= 4 && u16(dflt, 0) & 0x01 ? 0x40 : 0; // fUnsynced as the default height says
      d[13] = 0x01; // reserved, 1
      put16(d, 14, DEFAULT_XF);
    }
    put16(d, 2, list.length ? list[0].c0 : 0);
    put16(d, 4, list.length ? list[list.length - 1].c1 + 1 : 0);
    rows.set(r, row);
  }
  // the cell table again: blocks of 32 rows, each its ROW records, its cells and a DBCELL
  const allRows = [...new Set([...rows.keys(), ...[...units].filter(([, l]) => l.length).map(([r]) => r)])].sort((x, y) => x - y);
  const table: Rec[] = [];
  const blocks = new Map<number, number[]>();
  // (a block is the 32 rows from its first row on, as Excel writes them — not rows 32k … 32k+31: a sheet whose first
  // row is 2 has blocks 2–33, 34–65 … — omni-xls-print.xls, 2026-11-21)
  let blockStart = -Infinity;
  for (const r of allRows) {
    if (r >= blockStart + 32) blockStart = r;
    const k = blockStart;
    const list = blocks.get(k) ?? [];
    if (!blocks.has(k)) blocks.set(k, list);
    list.push(r);
  }
  const size = (r: Rec) => 4 + r.data.length;
  for (const block of blocks.values()) {
    const rowRecs = block.filter((r) => rows.has(r)).map((r) => rows.get(r)!);
    table.push(...rowRecs);
    let pos = rowRecs.reduce((n, r) => n + size(r), 0);
    const firstCell: number[] = [];
    for (const r of block) {
      if (rows.has(r)) firstCell.push(pos);
      for (const u of units.get(r) ?? [])
        for (const x of u.recs) {
          table.push(x);
          pos += size(x);
        }
    }
    if (!hadDb) continue;
    const d = new Uint8Array(4 + 2 * rowRecs.length);
    put32(d, 0, pos); // from this DBCELL back to the block's first ROW
    let ref = rowRecs.length ? size(rowRecs[0]) : 0; // the first: from the second ROW (the end of the first) …
    firstCell.forEach((p, i) => {
      put16(d, 4 + i * 2, p - ref); // … the next ones: from the first cell of the row before
      ref = p;
    });
    // (a block without ROW records — cells only — still gets its DBCELL)
    table.push(made(DBCELL, d));
  }
  // DIMENSIONS and INDEX grow to the edited cells
  let rMin = Infinity, rMax = -1, cMin = Infinity, cMax = -1;
  for (const r of touched)
    for (const u of units.get(r) ?? []) {
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
      cMin = Math.min(cMin, u.c0);
      cMax = Math.max(cMax, u.c1);
    }
  const before: Rec[] = [];
  for (let i = s.start; i < a; i++) {
    const r = recs[i];
    if (rMax >= 0 && r.type === DIMENSIONS && r.data.length >= 12 && topSet.has(i)) {
      const n = copy(r);
      const empty = u32(n.data, 4) === 0 && u16(n.data, 10) === 0;
      put32(n.data, 0, empty ? rMin : Math.min(u32(n.data, 0), rMin));
      put32(n.data, 4, empty ? rMax + 1 : Math.max(u32(n.data, 4), rMax + 1));
      put16(n.data, 8, empty ? cMin : Math.min(u16(n.data, 8), cMin));
      put16(n.data, 10, empty ? cMax + 1 : Math.max(u16(n.data, 10), cMax + 1));
      before.push(n);
    } else if (rMax >= 0 && r.type === INDEX && r.data.length >= 16 && topSet.has(i)) {
      const n = copy(r);
      const empty = u32(n.data, 8) === 0;
      put32(n.data, 4, empty ? rMin : Math.min(u32(n.data, 4), rMin));
      put32(n.data, 8, empty ? rMax + 1 : Math.max(u32(n.data, 8), rMax + 1));
      before.push(n);
    } else before.push(r);
  }
  return [...before, ...table, ...recs.slice(b + 1, s.end + 1)];
}

// ───────────────────────── the Workbook stream ─────────────────────────

/**
 * The Workbook stream with `edits` (by sheet name) written into it. A sheet given an empty list has its cell table
 * rebuilt as it is; RECALCID goes only when some value changes (`keepRecalcId`: kept anyway — the check that Excel
 * really recalculates because it is gone, qa/interop/scripts/xls_check.ps1).
 */
export function editWorkbook(wb: Uint8Array, edits: ReadonlyMap<string, readonly XlsCellEdit[]>, keepRecalcId = false): Uint8Array {
  const { recs, tail } = readRecords(wb);
  const subs = substreams(recs);
  const globals = subs[0];
  const gTop = topLevel(recs, globals);
  const gSet = new Set(gTop);
  // sheets: name → the substream its BOUNDSHEET points to
  const byPos = new Map(subs.map((s) => [recs[s.start].at, s]));
  const sheetSub = new Map<string, { start: number; end: number }>();
  for (const i of gTop) {
    const d = recs[i].data;
    if (recs[i].type !== BOUNDSHEET || d.length < 8) continue;
    const cch = d[6], wide = d[7] & 1;
    let name = "";
    for (let k = 0; k < cch; k++) name += String.fromCharCode(wide ? u16(d, 8 + k * 2) : d[8 + k]);
    const s = byPos.get(u32(d, 0));
    if (s) sheetSub.set(name, s);
  }
  // the shared strings
  const sstAt = gTop.find((i) => recs[i].type === SST);
  const sstEnd = sstAt === undefined ? -1 : (() => {
    let j = sstAt;
    while (recs[j + 1]?.type === CONTINUE) j++;
    return j;
  })();
  const sst = new Strings(sstAt === undefined ? null : recs.slice(sstAt, sstEnd + 1).map((r) => r.data));
  const changed = !keepRecalcId && [...edits.values()].some((l) => l.length);
  // each edited sheet's records again
  const newSheet = new Map<number, Rec[]>();
  for (const [name, list] of edits) {
    const s = sheetSub.get(name);
    if (!s) throw refuse("reader");
    newSheet.set(s.start, editSheet(recs, s, list, sst));
  }
  // the globals: SST with the new strings, EXTSST sized for them, RECALCID gone (Excel recalculates on load)
  const out: Rec[] = [];
  let sstParts: Rec[] = [];
  let extsst: Rec | null = null;
  for (let i = globals.start; i <= globals.end; i++) {
    const r = recs[i];
    if (i === sstAt) {
      if (sst.added.length || sst.delta) {
        const total = Math.max(0, u32(r.data, 0) + sst.delta);
        const parts = appendSst(recs.slice(sstAt, sstEnd + 1).map((x) => x.data), sst.added, total, sst.strings.length + sst.added.length);
        sstParts = parts.map((d, k) => (k === 0 ? { type: SST, data: d, at: r.at } : k <= sstEnd - sstAt ? { type: CONTINUE, data: d, at: recs[sstAt + k].at } : made(CONTINUE, d)));
      } else sstParts = recs.slice(sstAt, sstEnd + 1);
      out.push(...sstParts);
      i = sstEnd;
    } else if (r.type === EXTSST && gSet.has(i) && sstParts.length) {
      const dsst = Math.max(8, r.data.length >= 2 ? u16(r.data, 0) : 8, Math.ceil((sst.strings.length + sst.added.length) / 128));
      const buckets = Math.ceil((sst.strings.length + sst.added.length) / dsst);
      const d = new Uint8Array(2 + buckets * 8);
      put16(d, 0, dsst);
      extsst = { type: EXTSST, data: d, at: r.at };
      out.push(extsst);
    } else if (r.type === RECALCID && changed && gSet.has(i)) continue;
    else if (r.type === BOUNDSHEET && gSet.has(i)) out.push(copy(r));
    else out.push(r);
  }
  // the sheets (and any other substream), in stream order
  const sheetRecs: Rec[][] = [];
  for (const s of subs.slice(1)) {
    const list = newSheet.get(s.start) ?? recs.slice(s.start, s.end + 1);
    // INDEX: its DBCELL pointers are set below, one per row block
    const top = topLevel(list as Rec[], { start: 0, end: list.length - 1 });
    const idx = top.find((i) => list[i].type === INDEX);
    if (idx !== undefined && list[idx].data.length >= 16) {
      const dbs = top.filter((i) => list[i].type === DBCELL).length;
      const n: Rec = { type: INDEX, data: new Uint8Array(16 + 4 * dbs), at: list[idx].at };
      n.data.set(list[idx].data.subarray(0, 16));
      list[idx] = n;
    }
    sheetRecs.push(list as Rec[]);
  }
  const all = [...out, ...sheetRecs.flat()];
  // manual calculation (CALCMODE 0): Excel does not recalculate on load then, RECALCID or not (checked in Excel), and
  // Excel itself recalculates before it saves — formulas left in the workbook would show results of the old values
  const manual = all.some((r) => r.type === CALCMODE && r.data.length >= 2 && u16(r.data, 0) === 0);
  if (manual && [...edits.values()].some((l) => l.length) && all.some((r) => r.type === FORMULA)) throw refuse("calc");
  // where everything is now
  const at = new Map<Rec, number>();
  const moved = new Map<number, number>();
  let pos = 0;
  for (const r of all) {
    at.set(r, pos);
    if (r.at >= 0 && !moved.has(r.at)) moved.set(r.at, pos);
    pos += 4 + r.data.length;
  }
  for (const r of out)
    if (r.type === BOUNDSHEET && r.data.length >= 4) {
      const p = moved.get(u32(r.data, 0));
      if (p === undefined) throw refuse("layout");
      put32(r.data, 0, p);
    }
  for (const list of sheetRecs) {
    const top = topLevel(list, { start: 0, end: list.length - 1 });
    const idx = top.find((i) => list[i].type === INDEX);
    if (idx === undefined || list[idx].data.length < 16) continue;
    const d = list[idx].data;
    const xf = u32(d, 12);
    if (xf) put32(d, 12, moved.get(xf) ?? xf);
    top.filter((i) => list[i].type === DBCELL).forEach((i, k) => put32(d, 16 + k * 4, at.get(list[i])!));
  }
  if (extsst) {
    const w = walkSst(sstParts.map((r) => r.data));
    const d = extsst.data;
    const dsst = u16(d, 0);
    for (let k = 0; k * dsst < w.pos.length; k++) {
      const { part, off } = w.pos[k * dsst];
      put32(d, 2 + k * 8, at.get(sstParts[part])! + 4 + off); // the string's stream position
      put16(d, 2 + k * 8 + 4, 4 + off); // … and its offset in its record, the record header counted
    }
  }
  const bytes = new Uint8Array(pos + tail.length);
  for (const r of all) {
    const p = at.get(r)!;
    if (r.data.length > MAX_DATA) throw refuse("layout");
    put16(bytes, p, r.type);
    put16(bytes, p + 2, r.data.length);
    bytes.set(r.data, p + 4);
  }
  bytes.set(tail, pos);
  return bytes;
}

/** The compound file with its Workbook stream replaced; every other stream and entry as it was. */
export function withWorkbook(orig: Uint8Array, wb: Uint8Array): Uint8Array {
  const tree = readCfbTree(orig);
  const node = tree.root.kids?.find((k) => k.kind === "stream" && k.name === "Workbook");
  if (!node) throw refuse("layout");
  node.data = wb;
  return writeCfb(tree);
}

/** The Workbook stream of a compound file. */
export function workbookOf(file: Uint8Array): Uint8Array {
  const node = readCfbTree(file).root.kids?.find((k) => k.kind === "stream" && k.name === "Workbook");
  if (!node?.data) throw refuse("layout");
  return node.data;
}

/**
 * The cell values that differ between `pages` and the file read again as opened (by sheet name). Throws when the
 * file reads differently now (another reader version: its values are not the ones the edits were made against).
 */
export function xlsCellEdits(pages: readonly Page[], orig: Uint8Array, legacy: { name: string; fp: string }): Map<string, XlsCellEdit[]> {
  const was = xlsPages(orig, legacy.name, pages.map((p) => p.sheet?.book), pages.find((p) => p.sheet)?.sheet?.lang).pages;
  if (was.length !== pages.length || legacyFingerprint("xls", was) !== legacy.fp) throw refuse("reader");
  const edits = new Map<string, XlsCellEdit[]>();
  pages.forEach((p, i) => {
    const a = was[i].sheet, b = p.sheet;
    if (!a || !b || a.name !== b.name) throw refuse("reader");
    const list: XlsCellEdit[] = [];
    for (const k of new Set([...Object.keys(a.cells), ...Object.keys(b.cells)])) {
      const ca = a.cells[k], cb = b.cells[k];
      const sameValue = ca?.v === cb?.v && (ca?.t === "e") === (cb?.t === "e");
      // (2026-11-21: the open reads the formulas) a formula still there, and a cell an array formula fills: the result the
      // engine calculated after the edits becomes its cached value (QA 2026-11-21: not the old one — a reader that does
      // not calculate would show the result of the old values); one the engine could not calculate keeps the file's
      // (Excel recalculates every formula on load either way: RECALCID goes)
      const kept = ca?.f !== undefined && cb?.f !== undefined;
      if (kept && ca.f !== cb.f) throw refuse("formulaEdit");
      if (!kept && cb?.f !== undefined) throw refuse("formulaEdit");
      if (kept || (ca?.sp && cb?.sp === ca.sp)) {
        if (sameValue || cb!.stale || cb!.v === undefined || cb!.v === null) continue;
        const at = parseAddr(k);
        if (!at) throw refuse("layout");
        list.push({ r: at.r, c: at.c, v: cb!.v, cached: true, ...(cb!.t === "e" ? { err: true } : {}) });
        continue;
      }
      const vb = cb?.v;
      // a formula replaced by a value is an edit even when the value is the cached result
      if (sameValue && ca?.f === undefined) continue;
      const at = parseAddr(k);
      if (!at) throw refuse("layout");
      list.push({ r: at.r, c: at.c, v: vb, ...(cb?.t === "e" && typeof vb === "string" ? { err: true } : {}) });
    }
    if (list.length) edits.set(b.name, list);
  });
  return edits;
}

/** The .xls with the cell values edited in `pages` written into it (the original when no value differs). */
export function saveXlsCells(pages: readonly Page[], orig: Uint8Array, legacy: { name: string; fp: string }): Uint8Array {
  const edits = xlsCellEdits(pages, orig, legacy);
  if (!edits.size) return orig;
  return withWorkbook(orig, editWorkbook(workbookOf(orig), edits));
}
