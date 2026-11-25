// Omniweave formula engine (표 계산 수식): evaluates the formulas of a workbook's sheets (core/sheetTypes.ts) the way
// Excel does — references across sheets, defined names, operators with Excel's coercions, the everyday functions —
// and recalculates only what depends on a changed cell (dependency graph), detecting circular references.
// A formula with a function the engine does not know keeps the value stored in the file (marked stale).
// Dynamic arrays (Excel 365): a formula whose result is an array fills ("spills" into) the cells right of and below
// it — #SPILL! when one of them is not empty; the filled cells carry `sp` (their anchor) and no formula of their own.
// Inside array formulas operators and scalar functions work element by element; LET names are scoped to their call.
// Omniweave's own implementation (no third-party formula code).

import type { SheetCell, SheetData, SheetTable } from "../../core/sheetTypes";
import { addr, formulaRefs, MAX_COL, MAX_ROW, parseAddr, parseFormula, parseRange, rangeText, type Ast, type Rect } from "./formula";
import { FUNCTIONS, MAX_TEXT, Unknown, type Fn } from "./functions";

export class Err {
  constructor(public readonly code: string) {}
}
export type Scalar = number | string | boolean | Err | null;
export interface RangeV {
  kind: "range";
  sheet: SheetData;
  g: Rect;
}
export interface ArrV {
  kind: "arr";
  rows: Scalar[][];
}
export type V = Scalar | RangeV | ArrV;

export const isRange = (v: V): v is RangeV => !!v && typeof v === "object" && (v as RangeV).kind === "range";
export const isArr = (v: V): v is ArrV => !!v && typeof v === "object" && (v as ArrV).kind === "arr";
export const E = {
  div0: new Err("#DIV/0!"),
  na: new Err("#N/A"),
  name: new Err("#NAME?"),
  num: new Err("#NUM!"),
  ref: new Err("#REF!"),
  value: new Err("#VALUE!"),
  nul: new Err("#NULL!"),
  spill: new Err("#SPILL!"),
  calc: new Err("#CALC!"),
};

/** One cell's new value from a recalculation (apply with `applyChange`). */
export interface CellChange {
  sheet: number;
  addr: string;
  v: number | string | boolean | undefined;
  t?: "e";
  stale?: boolean;
  /** array formula anchor: its (wanted) spill range */
  spill?: string;
  /** a value spilled by the anchor at this address */
  sp?: string;
  /** a spilled value that is no longer there (the cell empties) */
  gone?: boolean;
}

type Key = string; // `${sheetIndex}!${A1}`

interface Compiled {
  ast: Ast | null; // null = unreadable formula (value kept)
  refs: { sheet: number; g: Rect }[];
  volatile: boolean;
  /** uses a dynamic-array function: evaluated as an array formula (spills) */
  dyn: boolean;
}

/** One array formula's result in a recalculation: the range it fills and its values. */
interface SpillResult {
  g: Rect;
  rows: Scalar[][];
  blocked: boolean;
  /** the result is more than one value */
  multi: boolean;
}

const VOLATILE = new Set(["NOW", "TODAY", "RAND", "RANDBETWEEN", "OFFSET", "INDIRECT", "INFO", "CELL", "RANDARRAY"]);
/** Functions that exist only with dynamic arrays: a formula using one is an array formula (Excel stores it as one). */
const DYNAMIC = new Set(["FILTER", "SORT", "SORTBY", "UNIQUE", "SEQUENCE", "RANDARRAY", "LET", "TRANSPOSE", "ANCHORARRAY", "XLOOKUP", "CHOOSECOLS", "CHOOSEROWS", "TAKE", "DROP", "VSTACK", "HSTACK", "TOCOL", "TOROW", "TEXTSPLIT", "WRAPROWS", "WRAPCOLS", "EXPAND"]);
/** Functions whose arguments are arrays: evaluated element by element even inside a legacy formula. */
const ARRAY_ARGS = new Set(["SUMPRODUCT", "MMULT", "TRANSPOSE", ...DYNAMIC]);
/** Scalar functions called once per element when given an array inside an array formula ("all" or the argument indexes). */
const LIFT: Record<string, "all" | number[]> = {};
for (const n of "ABS INT SQRT EXP LN LOG10 SIGN EVEN ODD ROUND ROUNDUP ROUNDDOWN TRUNC MOD POWER LOG CEILING FLOOR LEFT RIGHT MID LEN TRIM UPPER LOWER PROPER CLEAN TEXT FIXED SUBSTITUTE REPLACE FIND SEARCH REPT EXACT VALUE CHAR UNICHAR CODE UNICODE T N DATE TIME DATEVALUE TIMEVALUE YEAR MONTH DAY WEEKDAY HOUR MINUTE SECOND EDATE EOMONTH DAYS DATEDIF ISNUMBER ISTEXT ISNONTEXT ISLOGICAL ISBLANK ISERROR ISERR ISNA ISEVEN ISODD NOT CONCATENATE".split(" "))
  LIFT[n] = "all";
for (const n of "IF IFERROR IFNA VLOOKUP HLOOKUP MATCH XLOOKUP CHOOSE SWITCH".split(" ")) LIFT[n] = [0];
LIFT.COUNTIF = LIFT.SUMIF = LIFT.AVERAGEIF = [1];

/** More than one value (a range or array that is not a single cell). */
export const isMulti = (v: V): v is RangeV | ArrV =>
  isRange(v) ? v.g.r0 !== v.g.r1 || v.g.c0 !== v.g.c1 : isArr(v) ? v.rows.length > 1 || (v.rows[0]?.length ?? 0) > 1 : false;
/** Element (i, j) of a grid, a one-row / one-column grid repeated (Excel's array broadcasting); #N/A outside. */
export const pick = (g: Scalar[][], i: number, j: number): Scalar => {
  const row = g.length === 1 ? g[0] : g[i];
  if (!row) return E.na;
  const x = row.length === 1 ? row[0] : row[j];
  return x === undefined ? E.na : x;
};

/** A workbook being calculated: its sheets (tabs of one book, in order) and the parsed formulas. */
export class Book {
  readonly byName = new Map<string, number>();
  private compiled = new Map<Key, Compiled>();
  /** sheet → sorted cell coordinates (for ranges over sparse cells) */
  private coords = new Map<number, { r: number; c: number; a: string }[]>();
  // per recalculation
  private results = new Map<Key, Scalar>();
  private pending = new Set<Key>();
  private stack = new Set<Key>();
  /** array formulas evaluated in this recalculation */
  private spills = new Map<Key, SpillResult>();
  /** sheet → array formula anchors being recalculated and not evaluated yet */
  private todo = new Map<number, { a: string; r: number; c: number; key: Key }[]>();
  /** sheet → array formulas evaluated in this recalculation that fill more than their own cell */
  private live = new Map<number, (SpillResult & { a: string })[]>();
  /** anchor → the cells it filled before this recalculation */
  private spilled = new Map<Key, string[]>();
  /** anchors that are no longer array formulas (their spilled cells empty) */
  private orphans = new Set<Key>();
  /** evaluating an array formula: operators and scalar functions work element by element */
  am = false;
  /** LET names in scope (innermost last) */
  scopes: Map<string, V>[] = [];
  circular = false;
  stale: Key[] = [];
  lang: "ko" | "en" | "ja" | "zh" = "en";
  now = () => Date.now();
  /**
   * performance.now() after which formulas not evaluated yet keep their stored value (as with an unknown function):
   * a time budget for calculating a received file only to show it (io/formats/csv.ts excelShown).
   */
  deadline = Infinity;

  constructor(public sheets: SheetData[]) {
    sheets.forEach((s, i) => this.byName.set(s.name.toLowerCase(), i));
    this.lang = sheets[0]?.lang ?? "en";
  }

  sheetIndex(name: string | undefined, self: number): number {
    if (name == null) return self;
    return this.byName.get(name.toLowerCase()) ?? -1;
  }

  private compile(si: number, a: string, f: string): Compiled {
    const key = `${si}!${a}`;
    let c = this.compiled.get(key);
    if (c) return c;
    let ast: Ast | null = null;
    try {
      ast = parseFormula(f);
    } catch {
      ast = null;
    }
    const refs: { sheet: number; g: Rect }[] = [];
    let volatile = false;
    let dyn = false;
    if (ast) {
      for (const r of formulaRefs(ast)) refs.push({ sheet: this.sheetIndex(r.sheet, si), g: r.g });
      const visit = (n: Ast) => {
        if (n.k === "fn") {
          if (VOLATILE.has(n.name)) volatile = true;
          // XLOOKUP spills only a whole row / column: when its return range is wider and taller than one cell
          const ret = n.args[2];
          if (DYNAMIC.has(n.name) && !(n.name === "XLOOKUP" && ret?.k === "ref" && (ret.r0 === ret.r1 || ret.c0 === ret.c1))) dyn = true;
          n.args.forEach(visit);
        } else if (n.k === "name" || n.k === "sref") {
          volatile = true; // names, tables: resolved at evaluation (kept simple: always recalculated)
        } else if (n.k === "bin") {
          visit(n.a);
          visit(n.b);
        } else if (n.k === "un" || n.k === "pct") visit(n.a);
      };
      visit(ast);
    }
    c = { ast, refs, volatile, dyn };
    this.compiled.set(key, c);
    return c;
  }

  /** Forget a cell's parsed formula (its formula text changed). */
  forget(si: number, a: string) {
    this.compiled.delete(`${si}!${a}`);
    this.coords.delete(si);
  }

  cellsOf(si: number) {
    let list = this.coords.get(si);
    if (!list) {
      list = Object.keys(this.sheets[si].cells)
        .map((a) => ({ a, ...parseAddr(a)! }))
        .filter((x) => x.r != null)
        .sort((p, q) => p.r - q.r || p.c - q.c);
      this.coords.set(si, list);
    }
    return list;
  }

  /** Formula cells whose value depends (directly or not) on the given cells, plus volatile ones. */
  dependents(changed: { sheet: number; addr: string }[]): Key[] {
    const formulas: { key: Key; si: number; a: string; c: Compiled; spill: Rect | null }[] = [];
    this.sheets.forEach((s, si) => {
      for (const [a, cell] of Object.entries(s.cells))
        if (cell.f) formulas.push({ key: `${si}!${a}`, si, a, c: this.compile(si, a, cell.f), spill: cell.spill ? parseRange(cell.spill) : null });
    });
    const out = new Set<Key>();
    const queue = changed.map((x) => ({ si: x.sheet, ...parseAddr(x.addr)! }));
    for (const f of formulas) if (f.c.volatile) out.add(f.key);
    const inside = (g: Rect, p: { r: number; c: number }) => p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1;
    while (queue.length) {
      const p = queue.pop()!;
      for (const f of formulas) {
        if (out.has(f.key)) continue;
        // an array formula also depends on the cells it spills into (typing there blocks it, clearing them unblocks it)
        if (f.c.refs.some((r) => r.sheet === p.si && inside(r.g, p)) || (f.spill && f.si === p.si && inside(f.spill, p))) {
          out.add(f.key);
          const q = parseAddr(f.a)!;
          queue.push({ si: f.si, ...q });
        }
      }
    }
    for (const x of changed) if (this.sheets[x.sheet]?.cells[x.addr]?.f) out.add(`${x.sheet}!${x.addr}`);
    return [...out];
  }

  /** Recalculate the given formula cells (all formulas when omitted) and return the values that changed. */
  recalc(keys?: Key[]): CellChange[] {
    this.results.clear();
    this.stack.clear();
    this.spills.clear();
    this.circular = false;
    this.stale = [];
    if (!keys) {
      keys = [];
      this.sheets.forEach((s, si) => {
        for (const [a, c] of Object.entries(s.cells)) if (c.f) keys!.push(`${si}!${a}`);
      });
    }
    this.pending = new Set(keys);
    // array formula anchors and the cells they filled
    this.todo.clear();
    this.live.clear();
    this.spilled.clear();
    this.orphans.clear();
    this.sheets.forEach((s, si) => {
      for (const [a, c] of Object.entries(s.cells))
        if (c.sp) {
          const k = `${si}!${c.sp}`;
          const list = this.spilled.get(k) ?? [];
          list.push(a);
          this.spilled.set(k, list);
        }
    });
    for (const k of this.spilled.keys()) {
      const [si, a] = splitKey(k);
      const anchor = this.sheets[si]?.cells[a];
      if (!anchor?.f || !this.isArrayFormula(si, a, anchor)) this.orphans.add(k);
    }
    const out: CellChange[] = [];
    let moved = this.run(this.arraysFirst(keys), out);
    for (const k of this.orphans) {
      const [si] = splitKey(k);
      for (const b of this.spilled.get(k) ?? []) {
        out.push({ sheet: si, addr: b, v: undefined, gone: true });
        moved.push({ sheet: si, addr: b });
      }
    }
    // formulas that read spilled cells which changed (and were not recalculated yet)
    for (let pass = 0; moved.length && pass < 16; pass++) {
      const more = this.dependents(moved).filter((k) => !this.results.has(k) && !this.pending.has(k));
      if (!more.length) break;
      for (const k of more) this.pending.add(k);
      moved = this.run(this.arraysFirst(more), out);
    }
    return out;
  }

  /** The keys with the array formulas among them first (noted as not evaluated yet: cells they may spill into wait for them). */
  private arraysFirst(keys: Key[]): Key[] {
    const arrays: Key[] = [], rest: Key[] = [];
    for (const k of keys) {
      const [si, a] = splitKey(k);
      const cell = this.sheets[si]?.cells[a];
      const p = parseAddr(a);
      if (cell?.f && p && this.isArrayFormula(si, a, cell)) {
        arrays.push(k);
        const list = this.todo.get(si) ?? [];
        list.push({ a, ...p, key: k });
        this.todo.set(si, list);
      } else rest.push(k);
    }
    return [...arrays, ...rest];
  }

  /** Calculate the given formula cells, adding what changed to `out`; returns the spilled cells that changed. */
  private run(keys: Key[], out: CellChange[]): { sheet: number; addr: string }[] {
    const moved: { sheet: number; addr: string }[] = [];
    for (const k of keys) {
      const [si, a] = splitKey(k);
      const cell = this.sheets[si]?.cells[a];
      if (!cell?.f) continue;
      const v = this.valueOf(si, a);
      const staleNow = this.stale.includes(k);
      const nv = toStored(v);
      if (staleNow) {
        if (!cell.stale) out.push({ sheet: si, addr: a, v: cell.v, t: cell.t, stale: true });
        continue;
      }
      const res = this.spills.get(k);
      const spill = res && (res.multi || cell.spill) ? (cell.cse ? cell.spill : rangeText(res.g)) : undefined;
      if (nv.v !== cell.v || nv.t !== cell.t || cell.stale || spill !== cell.spill) out.push({ sheet: si, addr: a, ...nv, ...(spill !== undefined ? { spill } : {}) });
      if (!res) continue;
      // the cells it fills now, and those it no longer fills
      const sh = this.sheets[si];
      const now = new Set<string>();
      if (!res.blocked && res.multi)
        for (let r = res.g.r0; r <= res.g.r1; r++)
          for (let c = res.g.c0; c <= res.g.c1; c++) {
            const b = addr(r, c);
            if (b === a) continue;
            const x = sh.cells[b];
            // a legacy array's fixed range is not resized around a value typed into it: that value stays
            if (cell.cse && x && x.sp !== a && (x.v !== undefined || x.f)) continue;
            now.add(b);
            const sv = toStored(res.rows[r - res.g.r0]?.[c - res.g.c0] ?? null);
            if (!x || x.sp !== a || x.v !== sv.v || x.t !== sv.t) {
              out.push({ sheet: si, addr: b, ...sv, sp: a });
              moved.push({ sheet: si, addr: b });
            }
          }
      for (const b of this.spilled.get(k) ?? [])
        if (!now.has(b)) {
          out.push({ sheet: si, addr: b, v: undefined, gone: true });
          moved.push({ sheet: si, addr: b });
        }
    }
    return moved;
  }

  /** A formula evaluated as an array formula: read as one, or using a dynamic-array function. */
  private isArrayFormula(si: number, a: string, cell: SheetCell): boolean {
    return !!cell.f && (cell.spill != null || this.compile(si, a, cell.f).dyn);
  }

  /** Current value of a cell during a recalculation. */
  valueOf(si: number, a: string): Scalar {
    const key = `${si}!${a}`;
    const cell = this.sheets[si]?.cells[a];
    if (!cell?.f) {
      const sv = this.spilledValue(si, a, cell);
      if (sv !== undefined) return sv;
    }
    if (!cell) return null;
    if (!cell.f || !this.pending.has(key)) return stored(cell);
    const done = this.results.get(key);
    if (done !== undefined) return done;
    if (this.stack.has(key)) {
      this.circular = true;
      return 0;
    }
    this.stack.add(key);
    const comp = this.compile(si, a, cell.f);
    let v: Scalar;
    const am = this.am, scopes = this.scopes;
    this.am = false;
    this.scopes = [];
    if (!comp.ast) {
      v = stored(cell);
      this.stale.push(key);
    } else {
      const at = parseAddr(a)!;
      try {
        if (cell.spill != null || comp.dyn) {
          this.am = true;
          v = this.spill(key, cell, this.eval(comp.ast, si, at.r, at.c), si, at.r, at.c);
        } else v = this.scalar(this.eval(comp.ast, si, at.r, at.c), at.r, at.c);
      } catch (e) {
        if (!(e instanceof Unknown)) throw e;
        v = stored(cell);
        this.stale.push(key);
      }
    }
    this.am = am;
    this.scopes = scopes;
    this.stack.delete(key);
    this.results.set(key, v);
    return v;
  }

  /** An array formula's result laid out from its anchor: the anchor's own value (#SPILL! when blocked). */
  private spill(key: Key, cell: SheetCell, raw: V, si: number, r: number, c: number): Scalar {
    const one = { r0: r, c0: c, r1: r, c1: c };
    const a = addr(r, c);
    const done = (res: SpillResult, v: Scalar): Scalar => {
      this.spills.set(key, res);
      if (res.multi && !res.blocked) {
        const list = this.live.get(si) ?? [];
        list.push({ ...res, a });
        this.live.set(si, list);
      }
      return v;
    };
    if (cell.cse) {
      // legacy array formula: its range is fixed, the result is fitted into it (#N/A where it has no value)
      const g = parseRange(cell.spill ?? "") ?? one;
      const src = isMulti(raw) ? this.grid(raw) : [[this.scalar(raw, r, c)]];
      const rows = Array.from({ length: g.r1 - g.r0 + 1 }, (_, i) => Array.from({ length: g.c1 - g.c0 + 1 }, (_, j) => pick(src, i, j)));
      return done({ g, rows, blocked: false, multi: true }, rows[0][0]);
    }
    if (!isMulti(raw)) {
      const v = this.scalar(raw, r, c);
      return done({ g: one, rows: [[v]], blocked: false, multi: false }, v);
    }
    const rows = this.grid(raw);
    const h = rows.length, w = rows[0]?.length ?? 0;
    if (!h || !w) return done({ g: one, rows: [[E.calc]], blocked: false, multi: false }, E.calc);
    const g = { r0: r, c0: c, r1: r + h - 1, c1: c + w - 1 };
    if (g.r1 > MAX_ROW || g.c1 > MAX_COL || h * w > 1_000_000) return done({ g: one, rows, blocked: true, multi: true }, E.spill);
    const blocked = this.blocked(si, a, g);
    return done({ g, rows, blocked, multi: true }, blocked ? E.spill : rows[0][0] ?? null);
  }

  /** Something in the way of a spill: a value or formula (not spilled by this anchor) or a merged cell. */
  private blocked(si: number, a: string, g: Rect): boolean {
    const sh = this.sheets[si];
    for (const m of sh.merges) {
      const q = parseRange(m);
      if (q && q.r0 <= g.r1 && q.r1 >= g.r0 && q.c0 <= g.c1 && q.c1 >= g.c0) return true;
    }
    const busy = (b: string) => {
      const x = sh.cells[b];
      if (!x || b === a || x.sp === a) return false;
      if (x.sp && !x.f && this.pending.has(`${si}!${x.sp}`)) return false; // another array formula's old spill, being recalculated
      return x.v !== undefined || !!x.f;
    };
    if ((g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) <= 4096) {
      for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) if (busy(addr(r, c))) return true;
      return false;
    }
    return this.cellsOf(si).some((p) => p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1 && busy(p.a));
  }

  /** The value an array formula being recalculated spills into a cell; undefined when none does. */
  private spilledValue(si: number, a: string, cell: SheetCell | undefined): Scalar | undefined {
    const todo = this.todo.get(si);
    const live = this.live.get(si);
    if (!todo?.length && !live?.length && !cell?.sp) return undefined;
    const p = parseAddr(a);
    if (!p) return undefined;
    if (todo?.length) {
      // array formulas above and left of the cell that are not evaluated yet may spill into it
      for (const an of [...todo]) if (an.r <= p.r && an.c <= p.c && an.a !== a && !this.stack.has(an.key)) this.valueOf(si, an.a);
      this.todo.set(si, todo.filter((an) => !this.results.has(an.key)));
    }
    for (const res of this.live.get(si) ?? [])
      if (res.a !== a && p.r >= res.g.r0 && p.r <= res.g.r1 && p.c >= res.g.c0 && p.c <= res.g.c1) return res.rows[p.r - res.g.r0]?.[p.c - res.g.c0] ?? null;
    if (cell?.sp) {
      const k = `${si}!${cell.sp}`;
      if (this.spills.has(k) || this.orphans.has(k)) return null;
    }
    return undefined;
  }

  /** A1#: the range the array formula in a cell spills into. */
  spillRange(si: number, r: number, c: number): RangeV | Err {
    const a = addr(r, c);
    const sh = this.sheets[si];
    const cell = sh?.cells[a];
    if (!cell?.f) return E.ref;
    const key = `${si}!${a}`;
    let g: Rect | null;
    if (this.pending.has(key)) {
      this.valueOf(si, a);
      const res = this.spills.get(key);
      if (!res || res.blocked) return E.ref;
      g = res.g;
    } else {
      if (!cell.spill || (cell.t === "e" && cell.v === "#SPILL!")) return E.ref;
      g = parseRange(cell.spill);
    }
    return g ? { kind: "range", sheet: sh, g } : E.ref;
  }

  /** Values of a range / array, row by row (whole columns / rows cut to the cells in use). */
  grid(v: RangeV | ArrV): Scalar[][] {
    if (isArr(v)) return v.rows;
    const t = this.trim(v);
    const si = this.sheets.indexOf(v.sheet);
    const out: Scalar[][] = [];
    for (let r = t.g.r0; r <= t.g.r1; r++) {
      const row: Scalar[] = [];
      for (let c = t.g.c0; c <= t.g.c1; c++) row.push(this.valueOf(si, addr(r, c)));
      out.push(row);
    }
    return out;
  }

  /** A range / array reduced to one value the way a single cell formula sees it (implicit intersection). */
  scalar(v: V, r: number, c: number): Scalar {
    if (isRange(v)) {
      const g = v.g;
      if (g.r0 === g.r1 && g.c0 === g.c1) return this.at(v, 0, 0);
      if (g.c0 === g.c1 && r >= g.r0 && r <= g.r1) return this.at(v, r - g.r0, 0);
      if (g.r0 === g.r1 && c >= g.c0 && c <= g.c1) return this.at(v, 0, c - g.c0);
      return this.at(v, 0, 0); // dynamic-array Excel shows the first value of the spill
    }
    if (isArr(v)) return v.rows[0]?.[0] ?? null;
    return v;
  }

  /** Value in a range at row i, column j (0-based within the range). */
  at(v: RangeV, i: number, j: number): Scalar {
    const si = this.sheets.indexOf(v.sheet);
    return this.valueOf(si, addr(v.g.r0 + i, v.g.c0 + j));
  }

  /** Every non-empty cell of a range (row by row), with its offset. */
  each(v: RangeV, fn: (x: Scalar, i: number, j: number) => void) {
    const si = this.sheets.indexOf(v.sheet);
    const g = v.g;
    const area = (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1);
    const live = this.settle(si, g);
    const spilledAt = (r: number, c: number) => live.some((s) => r >= s.g.r0 && r <= s.g.r1 && c >= s.g.c0 && c <= s.g.c1);
    if (area <= 4096) {
      for (let r = g.r0; r <= g.r1; r++)
        for (let c = g.c0; c <= g.c1; c++) {
          const a = addr(r, c);
          if (v.sheet.cells[a] || (live.length && spilledAt(r, c))) fn(this.valueOf(si, a), r - g.r0, c - g.c0);
        }
      return;
    }
    for (const p of this.cellsOf(si)) if (p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1) fn(this.valueOf(si, p.a), p.r - g.r0, p.c - g.c0);
    // values spilled into cells that do not exist yet
    for (const s of live)
      for (let r = Math.max(g.r0, s.g.r0); r <= Math.min(g.r1, s.g.r1); r++)
        for (let c = Math.max(g.c0, s.g.c0); c <= Math.min(g.c1, s.g.c1); c++) {
          const a = addr(r, c);
          if (!v.sheet.cells[a]) fn(this.valueOf(si, a), r - g.r0, c - g.c0);
        }
  }

  /** Evaluate the array formulas of a sheet still waiting in this recalculation; the spills they fill. */
  private settle(si: number, g: Rect): (SpillResult & { a: string })[] {
    const todo = this.todo.get(si);
    if (todo?.length) {
      for (const an of [...todo]) if (an.r <= g.r1 && an.c <= g.c1 && !this.stack.has(an.key)) this.valueOf(si, an.a);
      this.todo.set(si, todo.filter((an) => !this.results.has(an.key)));
    }
    return this.live.get(si) ?? [];
  }

  /** The used part of a range (whole columns / rows cut to the cells that exist). */
  trim(v: RangeV): RangeV {
    const g = v.g;
    if (g.r1 - g.r0 < 100000 && g.c1 - g.c0 < 1000) return v;
    let r1 = g.r0, c1 = g.c0;
    const si = this.sheets.indexOf(v.sheet);
    const pts: { r: number; c: number }[] = [...this.cellsOf(si), ...this.settle(si, g).map((s) => ({ r: s.g.r1, c: s.g.c1 }))];
    for (const p of pts) {
      if (p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1) {
        r1 = Math.max(r1, p.r);
        c1 = Math.max(c1, p.c);
      }
    }
    return { kind: "range", sheet: v.sheet, g: { r0: g.r0, c0: g.c0, r1, c1 } };
  }

  resolveName(name: string, si: number, depth = 0): V {
    const sh = this.sheets[si];
    const key = Object.keys(sh.names ?? {}).find((n) => n.toLowerCase() === name.toLowerCase());
    if (!key || depth > 8) return E.name;
    const def = sh.names![key];
    const scopes = this.scopes;
    this.scopes = []; // a defined name does not see the LET names of the formula using it
    try {
      return this.eval(parseFormula(def), si, 0, 0, depth + 1);
    } catch (e) {
      if (e instanceof Unknown) throw e;
      return E.ref;
    } finally {
      this.scopes = scopes;
    }
  }

  /** Structured reference: the part of an Excel table it names (Table1[Col], [#Headers], [@Col], [[A]:[B]] …). */
  structured(n: { table?: string; spec: string }, si: number, r: number, c: number): V {
    let t: SheetTable | undefined;
    let tsi = si;
    if (n.table) {
      const want = n.table.toLowerCase();
      for (let i = 0; i < this.sheets.length && !t; i++) {
        t = this.sheets[i].tables?.find((x) => x.name.toLowerCase() === want);
        if (t) tsi = i;
      }
    } else
      t = this.sheets[si].tables?.find((x) => {
        const g = parseRange(x.ref);
        return !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
      });
    const g = t && parseRange(t.ref);
    if (!t || !g) return E.ref;
    // the spec: "@" (this row), [#Specials] and [Columns] separated by "," or ":" (' escapes the next character)
    const unesc = (s: string) => s.replace(/'(.)/g, "$1");
    let s = n.spec.trim();
    let thisRow = false;
    if (s.startsWith("@")) {
      thisRow = true;
      s = s.slice(1).trim();
    }
    const groups: string[] = [];
    if (s && !s.startsWith("[")) groups.push(unesc(s));
    else
      for (let k = 0; k < s.length; k++) {
        if (s[k] !== "[") continue;
        let j = k + 1;
        for (let depth = 1; j < s.length; j++) {
          if (s[j] === "'") j++;
          else if (s[j] === "[") depth++;
          else if (s[j] === "]" && --depth === 0) break;
        }
        groups.push(unesc(s.slice(k + 1, j)));
        k = j;
      }
    const specials = new Set(groups.filter((x) => x.startsWith("#")).map((x) => x.toLowerCase().replace(/\s+/g, " ")));
    const cols = groups.filter((x) => !x.startsWith("#"));
    if (specials.has("#this row")) thisRow = true;
    let c0 = g.c0, c1 = g.c1;
    if (cols.length) {
      const idx = cols.map((x) => t!.cols.findIndex((y) => y.toLowerCase() === x.trim().toLowerCase()));
      if (idx.some((i) => i < 0)) return E.ref;
      c0 = g.c0 + Math.min(...idx);
      c1 = g.c0 + Math.max(...idx);
    }
    const hr = t.noHeader ? -1 : g.r0;
    const d0 = g.r0 + (t.noHeader ? 0 : 1), d1 = g.r1 - (t.totals ? 1 : 0);
    const tr = t.totals ? g.r1 : -1;
    let r0: number, r1: number;
    if (thisRow) {
      if (tsi !== si || r < d0 || r > d1) return E.value;
      r0 = r1 = r;
    } else {
      const all = specials.has("#all");
      const want = all ? ["#headers", "#data", "#totals"] : [...specials];
      if (!want.length) want.push("#data");
      const segs: [number, number][] = [];
      for (const w of want) {
        if (w === "#headers") {
          if (hr >= 0) segs.push([hr, hr]);
          else if (!all) return E.ref;
        } else if (w === "#data") {
          if (d1 >= d0) segs.push([d0, d1]);
        } else if (w === "#totals") {
          if (tr >= 0) segs.push([tr, tr]);
          else if (!all) return E.ref;
        } else return E.ref;
      }
      if (!segs.length) return E.ref;
      r0 = Math.min(...segs.map((x) => x[0]));
      r1 = Math.max(...segs.map((x) => x[1]));
    }
    return { kind: "range", sheet: this.sheets[tsi], g: { r0, c0, r1, c1 } };
  }

  eval(n: Ast, si: number, r: number, c: number, depth = 0): V {
    switch (n.k) {
      case "num":
        return n.v;
      case "str":
        return n.v;
      case "bool":
        return n.v;
      case "err":
        return new Err(n.v);
      case "miss":
        return null;
      case "val":
        return n.v as V;
      case "ref": {
        const s = this.sheetIndex(n.sheet, si);
        if (s < 0) return E.ref;
        return { kind: "range", sheet: this.sheets[s], g: { r0: n.r0, c0: n.c0, r1: n.r1, c1: n.c1 } };
      }
      case "sref":
        return this.structured(n, si, r, c);
      case "name": {
        if (!n.sheet)
          for (let k = this.scopes.length - 1; k >= 0; k--) {
            const v = this.scopes[k].get(n.name.toLowerCase());
            if (v !== undefined) return v;
          }
        const v = this.resolveName(n.name, n.sheet ? this.sheetIndex(n.sheet, si) : si, depth);
        // a table's name alone is its data rows
        if (v === E.name && !n.sheet && this.sheets.some((s) => s.tables?.some((t) => t.name.toLowerCase() === n.name.toLowerCase()))) return this.structured({ table: n.name, spec: "" }, si, r, c);
        return v;
      }
      case "arr":
        return { kind: "arr", rows: n.rows.map((row) => row.map((x) => this.scalar(this.eval(x, si, r, c, depth), r, c))) };
      case "un":
      case "pct": {
        const f = (v: Scalar): Scalar => {
          if (n.k === "un" && n.op === "+") return v;
          const x = toNum(v);
          return x instanceof Err ? x : n.k === "pct" ? x / 100 : -x;
        };
        const a = this.eval(n.a, si, r, c, depth);
        if (this.am && isMulti(a)) return this.zip([a], (xs) => f(xs[0]));
        return f(this.scalar(a, r, c));
      }
      case "bin":
        return this.binary(n.op, n.a, n.b, si, r, c, depth);
      case "fn": {
        const fn = FUNCTIONS[n.name];
        if (!fn) throw new Unknown(n.name);
        if (this.deadline !== Infinity && performance.now() > this.deadline) throw new Unknown(n.name);
        if (this.am && LIFT[n.name]) return this.lift(n.name, fn, n.args, si, r, c, depth);
        if (!this.am && ARRAY_ARGS.has(n.name)) {
          this.am = true;
          try {
            return fn(this, n.args, si, r, c, depth);
          } finally {
            this.am = false;
          }
        }
        return fn(this, n.args, si, r, c, depth);
      }
    }
  }

  /** Element by element over arrays of any shapes (one row / one column repeated, #N/A past a smaller one). */
  zip(vals: V[], f: (xs: Scalar[]) => Scalar): ArrV {
    const grids = vals.map((v) => (isMulti(v) ? this.grid(v) : null));
    const h = Math.max(1, ...grids.map((g) => g?.length ?? 1));
    const w = Math.max(1, ...grids.map((g) => g?.[0]?.length ?? 1));
    const rows: Scalar[][] = [];
    for (let i = 0; i < h; i++) {
      const row: Scalar[] = [];
      for (let j = 0; j < w; j++) row.push(f(vals.map((v, k) => (grids[k] ? pick(grids[k]!, i, j) : (v as Scalar)))));
      rows.push(row);
    }
    return { kind: "arr", rows };
  }

  /** A scalar function inside an array formula: called once per element of the arrays given where it wants one value. */
  private lift(name: string, fn: Fn, args: Ast[], si: number, r: number, c: number, depth: number): V {
    const spec = LIFT[name];
    const vals = args.map((a, i) => (a.k !== "miss" && (spec === "all" || spec.includes(i)) ? this.eval(a, si, r, c, depth) : undefined));
    const call = (val: (i: number) => V | undefined) =>
      fn(
        this,
        args.map((a, i) => {
          const v = val(i);
          return v === undefined ? a : ({ k: "val", v } as Ast);
        }),
        si,
        r,
        c,
        depth,
      );
    const grids = vals.map((v) => (v !== undefined && isMulti(v) ? this.grid(v) : null));
    if (!grids.some(Boolean)) return call((i) => vals[i]);
    const h = Math.max(...grids.map((g) => g?.length ?? 1));
    const w = Math.max(...grids.map((g) => g?.[0]?.length ?? 1));
    const rows: Scalar[][] = [];
    for (let i = 0; i < h; i++) {
      const row: Scalar[] = [];
      for (let j = 0; j < w; j++) {
        const res = call((k) => (grids[k] ? pick(grids[k]!, i, j) : vals[k]));
        // a result that is itself an array (IF's branches) gives its own element
        row.push(isMulti(res) ? pick(this.grid(res), i, j) : this.scalar(res, r, c));
      }
      rows.push(row);
    }
    return { kind: "arr", rows };
  }

  private binary(op: string, a: Ast, b: Ast, si: number, r: number, c: number, depth: number): V {
    if (op === ":") {
      const x = this.eval(a, si, r, c, depth), y = this.eval(b, si, r, c, depth);
      if (!isRange(x) || !isRange(y) || x.sheet !== y.sheet) return E.ref;
      return { kind: "range", sheet: x.sheet, g: { r0: Math.min(x.g.r0, y.g.r0), c0: Math.min(x.g.c0, y.g.c0), r1: Math.max(x.g.r1, y.g.r1), c1: Math.max(x.g.c1, y.g.c1) } };
    }
    const x = this.eval(a, si, r, c, depth);
    const y = this.eval(b, si, r, c, depth);
    if (this.am && (isMulti(x) || isMulti(y))) return this.zip([x, y], (xs) => binop(op, xs[0], xs[1]));
    return binop(op, this.scalar(x, r, c), this.scalar(y, r, c));
  }
}

export function binop(op: string, x: Scalar, y: Scalar): Scalar {
  if (x instanceof Err) return x;
  if (y instanceof Err) return y;
  if (op === "&") return (toText(x) + toText(y)).slice(0, MAX_TEXT); // Excel cuts & at 32,767 characters
  if (op === "=" || op === "<>" || op === "<" || op === ">" || op === "<=" || op === ">=") {
    const k = compare(x, y);
    switch (op) {
      case "=": return k === 0;
      case "<>": return k !== 0;
      case "<": return k < 0;
      case ">": return k > 0;
      case "<=": return k <= 0;
      default: return k >= 0;
    }
  }
  const p = toNum(x), q = toNum(y);
  if (p instanceof Err) return p;
  if (q instanceof Err) return q;
  let v: number;
  switch (op) {
    case "+": v = p + q; break;
    case "-": v = p - q; break;
    case "*": v = p * q; break;
    case "/":
      if (q === 0) return E.div0;
      v = p / q;
      break;
    case "^":
      if (p === 0 && q === 0) return E.num;
      v = Math.pow(p, q);
      break;
    default:
      return E.value;
  }
  return Number.isFinite(v) ? fix15(v) : E.num;
}

/** Excel keeps 15 significant digits in additions that cancel (0.1+0.2−0.3 = 0). */
export function fix15(v: number): number {
  if (v === 0 || !Number.isFinite(v)) return v;
  const r = Number(v.toPrecision(15));
  return Math.abs(r - v) <= Math.abs(v) * 1e-15 ? r : v;
}

/** Order of two values: numbers < text < booleans; text ignores case; blank = 0 / "" / FALSE. */
export function compare(x: Scalar, y: Scalar): number {
  const kind = (v: Scalar) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : -1);
  if (x === null) x = typeof y === "string" ? "" : typeof y === "boolean" ? false : 0;
  if (y === null) y = typeof x === "string" ? "" : typeof x === "boolean" ? false : 0;
  const kx = kind(x), ky = kind(y);
  if (kx !== ky) return kx - ky;
  if (typeof x === "string") {
    const a = x.toLowerCase(), b = (y as string).toLowerCase();
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = Number(x), b = Number(y);
  return a < b ? -1 : a > b ? 1 : 0;
}

const NUMERIC = /^[-+]?(\d+(,\d{3})*(\.\d*)?|\.\d+)([eE][-+]?\d+)?%?$/;

/** A text that reads as a number (Excel's value coercion): "1,234.5", "12%", "2026-01-05", "13:30". */
export function textNumber(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (NUMERIC.test(t)) {
    const pct = t.endsWith("%");
    const n = Number(t.replace(/,/g, "").replace(/%$/, ""));
    return Number.isFinite(n) ? (pct ? n / 100 : n) : null;
  }
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) {
    const d = serialOf(Number(m[1]), Number(m[2]), Number(m[3]));
    return d + (Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) / 86400;
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(t);
  if (m) return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0)) / 86400;
  return null;
}

export function toNum(v: Scalar): number | Err {
  if (v instanceof Err) return v;
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = textNumber(v);
  return n == null ? E.value : n;
}

/** Number as text in a formula (=1/3&"" → "0.333333333333333"): 15 significant digits. */
export function numText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = String(Number(n.toPrecision(15)));
  return s.replace(/e\+?(-?)(\d+)$/, (_m, sg, d) => `E${sg || "+"}${d.padStart(2, "0")}`);
}

export function toText(v: Scalar): string {
  if (v === null) return "";
  if (typeof v === "number") return numText(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Err) return v.code;
  return v;
}

export function toBool(v: Scalar): boolean | Err {
  if (v instanceof Err) return v;
  if (v === null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const u = v.toUpperCase();
  if (u === "TRUE") return true;
  if (u === "FALSE") return false;
  return E.value;
}

/** Serial number of a date (1900 system, months / days may overflow like Excel's DATE). */
export function serialOf(y: number, m: number, d: number): number {
  if (y < 1900) y += 1900;
  // Excel's 1900 has a 29 February (serial 60): days count on from the 1st of the month in that calendar, so
  // DATE(1900,2,29) = DATE(1900,3,0) = 60 and DATEVALUE("1900-02-29") = 60 (QA 2026-11-16, Excel 365)
  const y2 = y + Math.floor((m - 1) / 12), m2 = ((((m - 1) % 12) + 12) % 12) + 1;
  if (y2 === 1900 && m2 <= 2) return (m2 === 1 ? 1 : 32) + d - 1;
  const first = Date.UTC(y2, m2 - 1, 1) / 86400000 + 25569;
  if (first >= 61) return first + d - 1;
  const s = first + d - 1;
  return s < 61 ? s - 1 : s;
}
/** y, m, d of a serial number (1900 system with its 1900-02-29). */
export function ymdOf(serial: number): [number, number, number] {
  const n = Math.floor(serial);
  if (n === 60) return [1900, 2, 29];
  if (n === 0) return [1900, 1, 0];
  const dt = new Date((n < 60 ? n + 1 : n) * 86400000 - 25569 * 86400000);
  return [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
}

function stored(cell: SheetCell): Scalar {
  if (cell.t === "e") return new Err(String(cell.v));
  return cell.v ?? null;
}
function toStored(v: Scalar): { v: number | string | boolean | undefined; t?: "e" } {
  if (v instanceof Err) return { v: v.code, t: "e" };
  if (v === null) return { v: 0 };
  return { v };
}
const splitKey = (k: Key): [number, string] => {
  const i = k.indexOf("!");
  return [Number(k.slice(0, i)), k.slice(i + 1)];
};

/** Recalculate every formula of the sheets in place (opening a file whose values are missing, measuring). */
export function recalcAll(sheets: SheetData[]): Book {
  const b = new Book(sheets);
  for (const ch of b.recalc()) applyChange(sheets[ch.sheet], ch);
  return b;
}

/** Write one recalculation result into its sheet: a formula's value, a spilled value (the cell is made), a spill gone. */
export function applyChange(sh: SheetData, ch: CellChange) {
  let cell = sh.cells[ch.addr];
  if (ch.gone) {
    if (!cell?.sp || cell.f) return;
    if (cell.s) sh.cells[ch.addr] = { s: cell.s };
    else delete sh.cells[ch.addr];
    return;
  }
  if (!cell) {
    if (!ch.sp) return;
    cell = sh.cells[ch.addr] = {};
  }
  if (ch.stale) {
    cell.stale = true;
    return;
  }
  cell.v = ch.v;
  if (ch.t) cell.t = ch.t;
  else delete cell.t;
  delete cell.stale;
  if (ch.sp) cell.sp = ch.sp;
  if (ch.spill !== undefined) cell.spill = ch.spill;
}

export { parseRange };
