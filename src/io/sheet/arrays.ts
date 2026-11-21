// Dynamic-array functions of the Omniweave formula engine (calc.ts): FILTER, SORT, SORTBY, UNIQUE, SEQUENCE,
// RANDARRAY, TRANSPOSE, CHOOSECOLS / CHOOSEROWS, TAKE / DROP, VSTACK / HSTACK, TOCOL / TOROW, WRAPROWS / WRAPCOLS,
// EXPAND, TEXTSPLIT, MMULT, LET (names scoped to the call), ANCHORARRAY (A1#), SINGLE (@). They return arrays that
// spill from the formula's cell. Behaviour follows Excel's documented semantics; Omniweave's own implementation.

import type { Ast } from "./formula";
import { type Book, compare, E, Err, fix15, isArr, isRange, toBool, toNum, toText, type Scalar, type V } from "./calc";
import type { Fn } from "./functions";

type Grid = Scalar[][];

const ev = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): V => (a && a.k !== "miss" ? b.eval(a, si, r, c, d) : null);
const given = (a: Ast | undefined) => !!a && a.k !== "miss";
/** An argument as rows of values (one value = 1 × 1); an error value stays an error. */
function grid(b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): Grid | Err {
  const v = ev(b, a, si, r, c, d);
  if (v instanceof Err) return v;
  if (isRange(v) || isArr(v)) return b.grid(v);
  return [[v]];
}
/** A number argument (its default when left out). */
function num(b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number, def: number): number | Err {
  if (!given(a)) return def;
  return toNum(b.scalar(ev(b, a, si, r, c, d), r, c));
}
function bool(b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): boolean | Err {
  if (!given(a)) return false;
  return toBool(b.scalar(ev(b, a, si, r, c, d), r, c));
}
/** Every value of an argument (row by row). */
function flatArg(b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): Scalar[] | Err {
  const g = grid(b, a, si, r, c, d);
  return g instanceof Err ? g : g.flat();
}
const arr = (rows: Grid): V => ({ kind: "arr", rows });
const transpose = (g: Grid): Grid => (g[0] ?? []).map((_, j) => g.map((row) => row[j] ?? null));
const width = (g: Grid) => g[0]?.length ?? 0;

/** Sort order of two values: numbers, text (case-insensitive), logicals, errors; blanks always last. */
function sortCmp(x: Scalar, y: Scalar, dir: number): number {
  const rank = (v: Scalar) => (v === null ? 4 : typeof v === "number" ? 0 : typeof v === "string" ? 1 : typeof v === "boolean" ? 2 : 3);
  const rx = rank(x), ry = rank(y);
  if (rx === 4 || ry === 4) return rx - ry;
  if (rx !== ry) return (rx - ry) * dir;
  if (rx === 3) return 0;
  return compare(x, y) * dir;
}

/** Key of a row of values for UNIQUE (text compared without case, like Excel). */
const rowKey = (row: Scalar[]) =>
  JSON.stringify(row.map((v) => (v === null ? ["b"] : v instanceof Err ? ["e", v.code] : typeof v === "string" ? ["s", v.toLowerCase()] : [typeof v, v])));

/** Positions (1-based, negative from the end) into 0-based indexes; null when one is out of range. */
function picks(ns: Scalar[], n: number): number[] | Err | null {
  const out: number[] = [];
  for (const x of ns) {
    const k = toNum(x);
    if (k instanceof Err) return k;
    const t = Math.trunc(k);
    if (t === 0 || Math.abs(t) > n) return null;
    out.push(t > 0 ? t - 1 : n + t);
  }
  return out;
}

function stack(b: Book, args: Ast[], si: number, r: number, c: number, d: number, vertical: boolean): V {
  const parts: Grid[] = [];
  for (const a of args) {
    if (!given(a)) continue;
    const g = grid(b, a, si, r, c, d);
    parts.push(g instanceof Err ? [[g]] : vertical ? g : transpose(g));
  }
  const w = Math.max(0, ...parts.map(width));
  const rows = parts.flatMap((g) => g.map((row) => [...row, ...Array<Scalar>(w - row.length).fill(E.na)]));
  return arr(vertical ? rows : transpose(rows));
}

function takeDrop(take: boolean): Fn {
  return (b, args, si, r, c, d) => {
    let g = grid(b, args[0], si, r, c, d);
    if (g instanceof Err) return g;
    const cut = (rows: Grid, n: number): Grid => {
      const k = Math.min(Math.abs(Math.trunc(n)), rows.length);
      if (take) return n >= 0 ? rows.slice(0, k) : rows.slice(rows.length - k);
      return n >= 0 ? rows.slice(k) : rows.slice(0, rows.length - k);
    };
    if (given(args[1])) {
      const n = num(b, args[1], si, r, c, d, 0);
      if (n instanceof Err) return n;
      g = cut(g, n);
    }
    if (given(args[2])) {
      const n = num(b, args[2], si, r, c, d, 0);
      if (n instanceof Err) return n;
      g = transpose(cut(transpose(g), n));
    }
    return g.length && width(g) ? arr(g) : E.calc;
  };
}

function choose(rows: boolean): Fn {
  return (b, args, si, r, c, d) => {
    const g0 = grid(b, args[0], si, r, c, d);
    if (g0 instanceof Err) return g0;
    const g = rows ? g0 : transpose(g0);
    const ns: Scalar[] = [];
    for (const a of args.slice(1)) {
      const xs = flatArg(b, a, si, r, c, d);
      if (xs instanceof Err) return xs;
      ns.push(...xs);
    }
    if (!ns.length) return E.value;
    const idx = picks(ns, g.length);
    if (idx instanceof Err) return idx;
    if (!idx) return E.value;
    const out = idx.map((i) => g[i]);
    return arr(rows ? out : transpose(out));
  };
}

function toLine(column: boolean): Fn {
  return (b, args, si, r, c, d) => {
    const g = grid(b, args[0], si, r, c, d);
    if (g instanceof Err) return g;
    const ignore = num(b, args[1], si, r, c, d, 0);
    const byCol = bool(b, args[2], si, r, c, d);
    if (ignore instanceof Err) return ignore;
    if (byCol instanceof Err) return byCol;
    const vals = (byCol ? transpose(g) : g).flat().filter((v) => !((ignore === 1 || ignore === 3) && v === null) && !((ignore === 2 || ignore === 3) && v instanceof Err));
    if (!vals.length) return E.calc;
    return arr(column ? vals.map((v) => [v]) : [vals]);
  };
}

function wrap(byRows: boolean): Fn {
  return (b, args, si, r, c, d) => {
    const g = grid(b, args[0], si, r, c, d);
    if (g instanceof Err) return g;
    if (g.length > 1 && width(g) > 1) return E.value;
    const n = num(b, args[1], si, r, c, d, 0);
    if (n instanceof Err) return n;
    const k = Math.trunc(n);
    if (k < 1) return E.num;
    const pad = given(args[2]) ? b.scalar(ev(b, args[2], si, r, c, d), r, c) : E.na;
    const vals = g.flat();
    const out: Grid = [];
    for (let i = 0; i < vals.length; i += k) {
      const row = vals.slice(i, i + k);
      while (row.length < k) row.push(pad);
      out.push(row);
    }
    return arr(byRows ? out : transpose(out));
  };
}

export const ARRAY_FUNCTIONS: Record<string, Fn> = {
  FILTER: (b, args, si, r, c, d) => {
    const g = grid(b, args[0], si, r, c, d);
    if (g instanceof Err) return g;
    const inc = grid(b, args[1], si, r, c, d);
    if (inc instanceof Err) return inc;
    const h = g.length, w = width(g);
    let byRow: boolean;
    if (inc.length === h && width(inc) === 1) byRow = true;
    else if (inc.length === 1 && width(inc) === w) byRow = false;
    else return E.value;
    const keep: boolean[] = [];
    for (const v of byRow ? inc.map((row) => row[0]) : inc[0]) {
      if (v instanceof Err) return v;
      if (typeof v === "string") return E.value;
      keep.push(v === null ? false : (toBool(v) as boolean));
    }
    const rows = byRow ? g.filter((_, i) => keep[i]) : g.map((row) => row.filter((_, j) => keep[j]));
    if (!rows.length || !width(rows)) return given(args[2]) ? ev(b, args[2], si, r, c, d) : E.calc;
    return arr(rows);
  },
  SORT: (b, args, si, r, c, d) => {
    const g0 = grid(b, args[0], si, r, c, d);
    if (g0 instanceof Err) return g0;
    const byCol = bool(b, args[3], si, r, c, d);
    if (byCol instanceof Err) return byCol;
    const g = byCol ? transpose(g0) : g0;
    const idx = given(args[1]) ? flatArg(b, args[1], si, r, c, d) : [1];
    const ord = given(args[2]) ? flatArg(b, args[2], si, r, c, d) : [1];
    if (idx instanceof Err) return idx;
    if (ord instanceof Err) return ord;
    const keys: { col: number; dir: number }[] = [];
    for (let k = 0; k < idx.length; k++) {
      const i = toNum(idx[k]), o = toNum(ord[Math.min(k, ord.length - 1)] ?? 1);
      if (i instanceof Err) return i;
      if (o instanceof Err) return o;
      if (Math.trunc(i) < 1 || Math.trunc(i) > width(g) || (o !== 1 && o !== -1)) return E.value;
      keys.push({ col: Math.trunc(i) - 1, dir: o });
    }
    const order = g.map((_, i) => i);
    order.sort((p, q) => {
      for (const k of keys) {
        const v = sortCmp(g[p][k.col], g[q][k.col], k.dir);
        if (v) return v;
      }
      return p - q;
    });
    const out = order.map((i) => g[i]);
    return arr(byCol ? transpose(out) : out);
  },
  SORTBY: (b, args, si, r, c, d) => {
    const g = grid(b, args[0], si, r, c, d);
    if (g instanceof Err) return g;
    const h = g.length, w = width(g);
    const keys: { vals: Scalar[]; dir: number }[] = [];
    let byCol: boolean | null = null;
    for (let k = 1; k < args.length; k += 2) {
      const by = grid(b, args[k], si, r, c, d);
      if (by instanceof Err) return by;
      const dir = num(b, args[k + 1], si, r, c, d, 1);
      if (dir instanceof Err) return dir;
      if (dir !== 1 && dir !== -1) return E.value;
      const col = width(by) === 1 && by.length === h;
      const row = by.length === 1 && width(by) === w;
      if (!col && !row) return E.value;
      const cols = row && !(col && h > 1);
      if (byCol !== null && byCol !== cols) return E.value;
      byCol = cols;
      keys.push({ vals: cols ? by[0] : by.map((x) => x[0]), dir });
    }
    if (!keys.length) return E.value;
    const n = byCol ? w : h;
    const order = Array.from({ length: n }, (_, i) => i);
    order.sort((p, q) => {
      for (const k of keys) {
        const v = sortCmp(k.vals[p], k.vals[q], k.dir);
        if (v) return v;
      }
      return p - q;
    });
    return arr(byCol ? g.map((row) => order.map((j) => row[j])) : order.map((i) => g[i]));
  },
  UNIQUE: (b, args, si, r, c, d) => {
    const g0 = grid(b, args[0], si, r, c, d);
    if (g0 instanceof Err) return g0;
    const byCol = bool(b, args[1], si, r, c, d), once = bool(b, args[2], si, r, c, d);
    if (byCol instanceof Err) return byCol;
    if (once instanceof Err) return once;
    const g = byCol ? transpose(g0) : g0;
    const count = new Map<string, number>();
    for (const row of g) count.set(rowKey(row), (count.get(rowKey(row)) ?? 0) + 1);
    const seen = new Set<string>();
    const out: Grid = [];
    for (const row of g) {
      const k = rowKey(row);
      if (seen.has(k) || (once && count.get(k)! > 1)) continue;
      seen.add(k);
      out.push(row);
    }
    if (!out.length) return E.calc;
    return arr(byCol ? transpose(out) : out);
  },
  SEQUENCE: (b, args, si, r, c, d) => {
    const h = num(b, args[0], si, r, c, d, 1), w = num(b, args[1], si, r, c, d, 1);
    const start = num(b, args[2], si, r, c, d, 1), step = num(b, args[3], si, r, c, d, 1);
    for (const x of [h, w, start, step]) if (x instanceof Err) return x;
    const rows = Math.trunc(h as number), cols = Math.trunc(w as number);
    if (rows < 1 || cols < 1) return E.calc;
    if (rows * cols > 1_048_576 * 16) return E.num;
    return arr(Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => fix15((start as number) + (i * cols + j) * (step as number)))));
  },
  RANDARRAY: (b, args, si, r, c, d) => {
    const h = num(b, args[0], si, r, c, d, 1), w = num(b, args[1], si, r, c, d, 1);
    const lo = num(b, args[2], si, r, c, d, 0), hi = num(b, args[3], si, r, c, d, 1);
    const whole = bool(b, args[4], si, r, c, d);
    for (const x of [h, w, lo, hi, whole]) if (x instanceof Err) return x;
    const rows = Math.trunc(h as number), cols = Math.trunc(w as number);
    if (rows < 1 || cols < 1) return E.calc;
    if ((lo as number) > (hi as number)) return E.value;
    const one = () => (whole ? Math.ceil(lo as number) + Math.floor(Math.random() * (Math.floor(hi as number) - Math.ceil(lo as number) + 1)) : (lo as number) + Math.random() * ((hi as number) - (lo as number)));
    return arr(Array.from({ length: rows }, () => Array.from({ length: cols }, one)));
  },
  TRANSPOSE: (b, args, si, r, c, d) => {
    const g = grid(b, args[0], si, r, c, d);
    return g instanceof Err ? g : arr(transpose(g));
  },
  CHOOSECOLS: choose(false),
  CHOOSEROWS: choose(true),
  TAKE: takeDrop(true),
  DROP: takeDrop(false),
  VSTACK: (b, args, si, r, c, d) => stack(b, args, si, r, c, d, true),
  HSTACK: (b, args, si, r, c, d) => stack(b, args, si, r, c, d, false),
  TOCOL: toLine(true),
  TOROW: toLine(false),
  WRAPROWS: wrap(true),
  WRAPCOLS: wrap(false),
  EXPAND: (b, args, si, r, c, d) => {
    const g = grid(b, args[0], si, r, c, d);
    if (g instanceof Err) return g;
    const h = num(b, args[1], si, r, c, d, g.length), w = num(b, args[2], si, r, c, d, width(g));
    if (h instanceof Err) return h;
    if (w instanceof Err) return w;
    if (h < g.length || w < width(g)) return E.value;
    const pad = given(args[3]) ? b.scalar(ev(b, args[3], si, r, c, d), r, c) : E.na;
    return arr(Array.from({ length: Math.trunc(h) }, (_, i) => Array.from({ length: Math.trunc(w) }, (_, j) => (g[i] && j < g[i].length ? g[i][j] : pad))));
  },
  TEXTSPLIT: (b, args, si, r, c, d) => {
    const tv = b.scalar(ev(b, args[0], si, r, c, d), r, c);
    if (tv instanceof Err) return tv;
    const text = toText(tv);
    const delims = (a: Ast | undefined): string[] | Err => {
      if (!given(a)) return [];
      const xs = flatArg(b, a, si, r, c, d);
      if (xs instanceof Err) return xs;
      const out: string[] = [];
      for (const x of xs) {
        if (x instanceof Err) return x;
        out.push(toText(x));
      }
      return out.some((s) => s === "") ? E.value : out;
    };
    const cd = delims(args[1]), rd = delims(args[2]);
    if (cd instanceof Err) return cd;
    if (rd instanceof Err) return rd;
    if (!cd.length && !rd.length) return E.value;
    const ignore = bool(b, args[3], si, r, c, d);
    const mode = num(b, args[4], si, r, c, d, 0);
    if (ignore instanceof Err) return ignore;
    if (mode instanceof Err) return mode;
    const pad = given(args[5]) ? b.scalar(ev(b, args[5], si, r, c, d), r, c) : E.na;
    const splitter = (ds: string[]) => {
      if (!ds.length) return (s: string) => [s];
      const re = new RegExp([...ds].sort((x, y) => y.length - x.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), mode === 1 ? "gi" : "g");
      return (s: string) => s.split(re);
    };
    let lines = splitter(rd)(text);
    if (ignore) lines = lines.filter((s) => s !== "");
    const rows: Grid = lines.map((line) => {
      let parts = splitter(cd)(line);
      if (ignore) parts = parts.filter((s) => s !== "");
      return parts;
    });
    const w = Math.max(1, ...rows.map((row) => row.length));
    return arr(rows.length ? rows.map((row) => [...row, ...Array<Scalar>(w - row.length).fill(pad)]) : [[pad]]);
  },
  MMULT: (b, args, si, r, c, d) => {
    const x = grid(b, args[0], si, r, c, d), y = grid(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (y instanceof Err) return y;
    if (width(x) !== y.length) return E.value;
    const out: Grid = [];
    for (const row of x) {
      const o: Scalar[] = [];
      for (let j = 0; j < width(y); j++) {
        let s = 0;
        for (let k = 0; k < row.length; k++) {
          const p = row[k], q = y[k][j];
          if (typeof p !== "number" || typeof q !== "number") return E.value;
          s += p * q;
        }
        o.push(fix15(s));
      }
      out.push(o);
    }
    return arr(out);
  },
  LET: (b, args, si, r, c, d) => {
    if (args.length < 3 || args.length % 2 === 0) return E.value;
    const scope = new Map<string, V>();
    b.scopes.push(scope);
    try {
      for (let k = 0; k + 1 < args.length; k += 2) {
        const n = args[k];
        if (n.k !== "name" || n.sheet) return E.value;
        scope.set(n.name.toLowerCase(), ev(b, args[k + 1], si, r, c, d));
      }
      return ev(b, args[args.length - 1], si, r, c, d);
    } finally {
      b.scopes.pop();
    }
  },
  ANCHORARRAY: (b, args, si) => {
    const a = args[0];
    if (a?.k !== "ref") return E.ref;
    const s = b.sheetIndex(a.sheet, si);
    return s < 0 ? E.ref : b.spillRange(s, a.r0, a.c0);
  },
  SINGLE: (b, args, si, r, c, d) => b.scalar(ev(b, args[0], si, r, c, d), r, c),
};
