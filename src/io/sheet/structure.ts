// Inserting and deleting rows / columns (표 계산 행·열 삽입·삭제) — Excel's rules for what moves with them:
// cells, row heights / column widths, hidden lines, merges, conditional formats, data validation, notes, the
// AutoFilter range, frozen panes, defined names and every formula reference in the book that points at the sheet
// (absolute ones too; a reference into deleted lines becomes #REF!, a range around the change grows / shrinks,
// whole-column refs move with column changes only). The same functions move references inside the saved XML
// (io/sheet/bookExtra.ts). Omniweave's own implementation.

import type { SheetCell, SheetData } from "../../core/sheetTypes";
import { addr, colIndex, colLetters, MAX_COL, MAX_ROW, parseAddr, tokenize } from "./formula";

/** One structural change: `n` > 0 inserts n lines before line `at`; `n` < 0 deletes −n lines starting at `at`. */
export interface StructOp {
  axis: "row" | "col";
  at: number;
  n: number;
}

const maxOf = (op: StructOp) => (op.axis === "row" ? MAX_ROW : MAX_COL);

/** Where line i goes; null = deleted. */
export function shiftIndex(i: number, op: StructOp): number | null {
  if (op.n > 0) {
    if (i < op.at) return i;
    const j = i + op.n;
    return j > maxOf(op) ? null : j;
  }
  const k = -op.n, end = op.at + k - 1;
  if (i < op.at) return i;
  if (i > end) return i - k;
  return null;
}

/** Where the span a..b goes (grows when lines are inserted inside it, shrinks when some of it is deleted); null = all deleted. */
export function shiftSpan(a: number, b: number, op: StructOp): [number, number] | null {
  const max = maxOf(op);
  if (op.n > 0) {
    if (a >= op.at) return a + op.n > max ? null : [a + op.n, Math.min(max, b + op.n)];
    if (b >= op.at) return [a, Math.min(max, b + op.n)];
    return [a, b];
  }
  const k = -op.n, end = op.at + k - 1;
  if (b < op.at) return [a, b];
  if (a > end) return [a - k, b - k];
  if (a >= op.at && b <= end) return null;
  return [a < op.at ? a : op.at, b > end ? b - k : op.at - 1];
}

/** A reference body (A1, $A$1:B$2, A:C, 3:5) after the change; null = #REF!. */
export function adjustRefBody(body: string, op: StructOp): string | null {
  const parts = body.split(":");
  type P = { cd: string; c: number | null; rd: string; r: number | null };
  const parse = (s: string): P | null => {
    let m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(s);
    if (m) return { cd: m[1], c: colIndex(m[2]), rd: m[3], r: Number(m[4]) - 1 };
    m = /^(\$?)([A-Za-z]{1,3})$/.exec(s);
    if (m) return { cd: m[1], c: colIndex(m[2]), rd: "", r: null };
    m = /^(\$?)(\d+)$/.exec(s);
    if (m) return { cd: "", c: null, rd: m[1], r: Number(m[2]) - 1 };
    return null;
  };
  const ps = parts.map(parse);
  if (ps.some((p) => !p) || ps.length > 2) return body;
  const a = ps[0]!, b = (ps[1] ?? ps[0])!;
  const key = op.axis === "row" ? "r" : "c";
  if (a[key] == null || b[key] == null) return body; // whole columns under a row change (or whole rows under a column change)
  const lo = Math.min(a[key]!, b[key]!), hi = Math.max(a[key]!, b[key]!);
  const sp = ps.length === 1 ? (() => {
    const i = shiftIndex(lo, op);
    return i == null ? null : ([i, i] as [number, number]);
  })() : shiftSpan(lo, hi, op);
  if (!sp) return null;
  const write = (p: P, v: number) => {
    const q = { ...p, [key]: v };
    return `${q.c != null ? q.cd + colLetters(q.c) : ""}${q.r != null ? q.rd + (q.r + 1) : ""}`;
  };
  if (ps.length === 1) return write(a, sp[0]);
  // keep the order the formula wrote (B2:A1 stays reversed)
  const aLow = a[key]! <= b[key]!;
  return `${write(a, aLow ? sp[0] : sp[1])}:${write(b, aLow ? sp[1] : sp[0])}`;
}

/**
 * A formula (without "=") after a change on sheet `target`; `own` = the sheet the formula lives on (unqualified
 * references are on it; undefined = none, as in defined names and chart series).
 */
export function adjustFormula(f: string, op: StructOp, own: string | undefined, target: string): string {
  if (!f) return f;
  const tl = target.toLowerCase();
  const toks = tokenize(f);
  let changed = false;
  const out = toks.map((t) => {
    if (t.t !== "ref") return t.s;
    const sheet = t.sheet ?? own;
    if (sheet == null || sheet.toLowerCase() !== tl) return t.s;
    const moved = adjustRefBody(t.body, op);
    const prefix = t.s.slice(0, t.s.length - t.body.length);
    const s = prefix + (moved ?? "#REF!");
    if (s !== t.s) changed = true;
    return s;
  });
  return changed ? out.join("") : f;
}

/** A range ("A1:B3" or "A1") of the changed sheet after the change; null = deleted. */
export function adjustRange(s: string, op: StructOp): string | null {
  const r = adjustRefBody(s.replace(/\$/g, ""), op);
  if (r == null) return null;
  return r;
}

/** A space-separated list of ranges (sqref) after the change; "" when every range is gone. */
export function adjustSqref(sqref: string, op: StructOp): string {
  return sqref
    .split(/\s+/)
    .filter(Boolean)
    .map((x) => adjustRange(x, op))
    .filter((x): x is string => !!x)
    .join(" ");
}

/** An address after the change; a deleted cell goes to the first line after the deleted ones (`clamp`) or null. */
export function adjustAddr(a: string, op: StructOp, clamp = false): string | null {
  const p = parseAddr(a);
  if (!p) return a;
  const i = shiftIndex(op.axis === "row" ? p.r : p.c, op);
  const j = i ?? (clamp ? Math.min(op.at, maxOf(op)) : null);
  if (j == null) return null;
  return op.axis === "row" ? addr(j, p.c) : addr(p.r, j);
}

function shiftKeys<T>(rec: Record<number, T> | undefined, op: StructOp): Record<number, T> | undefined {
  if (!rec) return rec;
  const out: Record<number, T> = {};
  for (const [k, v] of Object.entries(rec)) {
    const i = shiftIndex(Number(k), op);
    if (i != null) out[i] = v;
  }
  return out;
}
const shiftList = (list: number[] | undefined, op: StructOp) => (list ? list.map((x) => shiftIndex(x, op)).filter((x): x is number => x != null) : list);

/** Frozen line count after the change (lines inserted / deleted inside the frozen part change it). */
export function frozenAfter(n: number, op: StructOp): number {
  if (!n || op.at >= n) return n;
  if (op.n > 0) return n + op.n;
  const k = -op.n;
  return Math.max(0, n - Math.min(k, n - op.at));
}

/** Apply a change to the sheet it happens on (mutates): cells move, references to this sheet in its own formulas adjust. */
export function applyStructToSheet(sh: SheetData, op: StructOp): void {
  const own = sh.name;
  const fx = (f: string) => adjustFormula(f, op, own, own);
  const cells: Record<string, SheetCell> = {};
  for (const [a, cell] of Object.entries(sh.cells)) {
    const na = adjustAddr(a, op);
    if (!na) continue;
    let out = cell;
    if (cell.f) {
      const f = fx(cell.f);
      if (f !== cell.f) out = { ...out, f };
    }
    // dynamic arrays: the anchor's spill range and a spilled cell's anchor move with the sheet
    if (cell.spill) {
      const sp = adjustRange(cell.spill, op);
      out = sp ? { ...out, spill: sp } : { ...out, spill: undefined };
    }
    if (cell.sp) {
      const sp = adjustAddr(cell.sp, op);
      if (!sp) continue;
      out = { ...out, sp };
    }
    cells[na] = out;
  }
  if (sh.tables) sh.tables = sh.tables.flatMap((t) => {
    const ref = adjustRange(t.ref, op);
    return ref ? [{ ...t, ref }] : [];
  });
  sh.cells = cells;
  if (op.axis === "row") {
    sh.rowH = shiftKeys(sh.rowH, op)!;
    sh.rowS = shiftKeys(sh.rowS, op);
    if (sh.rowAuto) sh.rowAuto = shiftKeys(sh.rowAuto, op); // (rows Excel fitted to their text move with their heights)
    sh.hiddenRows = shiftList(sh.hiddenRows, op);
    if (sh.rowS && !Object.keys(sh.rowS).length) delete sh.rowS;
    if (sh.rowAuto && !Object.keys(sh.rowAuto).length) delete sh.rowAuto;
    if (sh.hiddenRows && !sh.hiddenRows.length) delete sh.hiddenRows;
  } else {
    sh.colW = shiftKeys(sh.colW, op)!;
    sh.colS = shiftKeys(sh.colS, op);
    sh.hiddenCols = shiftList(sh.hiddenCols, op);
    if (sh.colS && !Object.keys(sh.colS).length) delete sh.colS;
    if (sh.hiddenCols && !sh.hiddenCols.length) delete sh.hiddenCols;
  }
  // a merge shrunk to one cell is no merge any more (Excel drops it)
  sh.merges = sh.merges.map((m) => adjustRange(m, op)).filter((m): m is string => !!m && m.includes(":") && m.split(":")[0] !== m.split(":")[1]);
  if (sh.cond) {
    sh.cond = sh.cond
      .map((c) => ({ ...c, ranges: c.ranges.map((r) => adjustRange(r, op)).filter((r): r is string => !!r), rules: c.rules.map((r) => (r.formulas ? { ...r, formulas: r.formulas.map(fx) } : r)) }))
      .filter((c) => c.ranges.length);
    if (!sh.cond.length) delete sh.cond;
  }
  if (sh.freeze) {
    const fr = { rows: op.axis === "row" ? frozenAfter(sh.freeze.rows, op) : sh.freeze.rows, cols: op.axis === "col" ? frozenAfter(sh.freeze.cols, op) : sh.freeze.cols };
    if (fr.rows || fr.cols) sh.freeze = fr;
    else delete sh.freeze;
  }
  if (sh.topLeft) sh.topLeft = adjustAddr(sh.topLeft, op, true) ?? sh.topLeft;
  if (sh.active) {
    const a = /^[A-Z]+\d+/.exec(sh.active)?.[0];
    if (a) sh.active = adjustAddr(a, op, true) ?? a;
  }
  if (sh.notes) {
    const notes: NonNullable<SheetData["notes"]> = {};
    for (const [a, n] of Object.entries(sh.notes)) {
      const na = adjustAddr(a, op);
      if (na) notes[na] = n;
    }
    sh.notes = notes;
  }
  if (sh.valid) {
    sh.valid = sh.valid
      .map((v) => ({ ...v, ranges: v.ranges.map((r) => adjustRange(r, op)).filter((r): r is string => !!r), ...(v.f1 != null ? { f1: fx(v.f1) } : {}), ...(v.f2 != null ? { f2: fx(v.f2) } : {}) }))
      .filter((v) => v.ranges.length);
    if (!sh.valid.length) delete sh.valid;
  }
  if (sh.filter) {
    const ref = adjustRange(sh.filter.ref, op);
    if (!ref) delete sh.filter;
    else {
      const c0 = parseAddr(sh.filter.ref.split(":")[0])!.c;
      const cols: NonNullable<SheetData["filter"]>["cols"] = {};
      for (const [k, v] of Object.entries(sh.filter.cols ?? {})) {
        if (op.axis === "row") cols[Number(k)] = v;
        else {
          const nc = shiftIndex(c0 + Number(k), op);
          const nc0 = parseAddr(ref.split(":")[0])!.c;
          if (nc != null) cols[nc - nc0] = v;
        }
      }
      sh.filter = { ...sh.filter, ref, cols };
    }
  }
  if (sh.names) sh.names = adjustNames(sh.names, op, undefined, own);
}

function adjustNames(names: Record<string, string>, op: StructOp, own: string | undefined, target: string) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(names)) out[k] = adjustFormula(v, op, own, target);
  return out;
}

/** Apply a change on sheet `ti` of a book (mutates every sheet): the sheet itself, and references to it everywhere else. */
export function applyStructToBook(sheets: SheetData[], ti: number, op: StructOp): void {
  const target = sheets[ti].name;
  sheets.forEach((sh, i) => {
    if (i === ti) return applyStructToSheet(sh, op);
    const fx = (f: string) => adjustFormula(f, op, sh.name, target);
    for (const [a, c] of Object.entries(sh.cells))
      if (c.f && c.f.includes("!")) {
        const f = fx(c.f);
        if (f !== c.f) sh.cells[a] = { ...c, f };
      }
    if (sh.names) sh.names = adjustNames(sh.names, op, undefined, target);
    if (sh.cond) sh.cond = sh.cond.map((c) => ({ ...c, rules: c.rules.map((r) => (r.formulas ? { ...r, formulas: r.formulas.map(fx) } : r)) }));
    if (sh.valid) sh.valid = sh.valid.map((v) => ({ ...v, ...(v.f1 != null ? { f1: fx(v.f1) } : {}), ...(v.f2 != null ? { f2: fx(v.f2) } : {}) }));
  });
}

/** Whether a change would push data off the sheet (Excel refuses the insert then). */
export function insertWouldLoseData(sh: SheetData, op: StructOp): boolean {
  if (op.n <= 0) return false;
  const max = maxOf(op);
  for (const a of Object.keys(sh.cells)) {
    const p = parseAddr(a);
    if (!p) continue;
    const i = op.axis === "row" ? p.r : p.c;
    if (i >= op.at && i + op.n > max && (sh.cells[a].v !== undefined || sh.cells[a].f)) return true;
  }
  return false;
}

export { colLetters };
