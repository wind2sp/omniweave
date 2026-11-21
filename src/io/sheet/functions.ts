// Worksheet functions of the Omniweave formula engine (calc.ts). Behaviour follows Excel's documented semantics
// (argument coercion, blanks, errors, criteria with wildcards); names are Excel's English names.

import type { Ast } from "./formula";
import { ARRAY_FUNCTIONS } from "./arrays";
import { formatValue } from "./numfmt";
import { parseDateText } from "./dateText";
import { type Book, compare, E, Err, fix15, isArr, isRange, numText, serialOf, textNumber, toBool, toNum, toText, ymdOf, type RangeV, type Scalar, type V } from "./calc";

/** Longest text a cell holds (Excel: 32,767 characters). REPT, CONCAT, TEXTJOIN, SUBSTITUTE, REPLACE past it are
 * #VALUE!; & and CONCATENATE cut it there (checked with Excel 365, 2026-11-16). It also keeps a received file's
 * formula from building a text too long to show (QA 2026-11-16: =REPT("x",100000000) in a CSV froze its opening). */
export const MAX_TEXT = 32767;

/** A function the engine does not have: the formula keeps its stored value. */
export class Unknown extends Error {}

export type Fn = (b: Book, args: Ast[], si: number, r: number, c: number, depth: number) => V;

// ───── argument helpers ─────

const ev = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): V => (a ? b.eval(a, si, r, c, d) : null);
const sc = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): Scalar => b.scalar(ev(b, a, si, r, c, d), r, c);

/** Values of all arguments, ranges and arrays flattened. `refsOnly`: text / booleans inside ranges are skipped by the caller. */
function flat(b: Book, args: Ast[], si: number, r: number, c: number, d: number, fn: (v: Scalar, fromRef: boolean) => void) {
  for (const a of args) {
    if (a.k === "miss") continue;
    const v = ev(b, a, si, r, c, d);
    if (isRange(v)) b.each(b.trim(v), (x) => fn(x, true));
    else if (isArr(v)) v.rows.forEach((row) => row.forEach((x) => fn(x, true)));
    else fn(v, false);
  }
}

/** Numbers of the arguments as SUM / AVERAGE / MIN / MAX see them; the first error wins. */
function nums(b: Book, args: Ast[], si: number, r: number, c: number, d: number): number[] | Err {
  const out: number[] = [];
  let err: Err | null = null;
  flat(b, args, si, r, c, d, (v, ref) => {
    if (err) return;
    if (v instanceof Err) err = v;
    else if (typeof v === "number") out.push(v);
    else if (!ref && v !== null) {
      const n = toNum(v);
      if (n instanceof Err) err = n;
      else out.push(n);
    }
  });
  return err ?? out;
}

const num = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number, def?: number): number | Err => {
  if (!a || a.k === "miss") return def ?? 0;
  return toNum(sc(b, a, si, r, c, d));
};
const txt = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): string | Err => {
  const v = sc(b, a, si, r, c, d);
  return v instanceof Err ? v : toText(v);
};
const range = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): RangeV | Err | Scalar[][] => {
  const v = ev(b, a, si, r, c, d);
  if (isRange(v)) return v;
  if (isArr(v)) return v.rows;
  if (v instanceof Err) return v;
  return [[v as Scalar]];
};
/** Rows × columns of a range / array argument. */
function grid(b: Book, v: RangeV | Scalar[][]): { rows: number; cols: number; at: (i: number, j: number) => Scalar } {
  if (Array.isArray(v)) return { rows: v.length, cols: v[0]?.length ?? 0, at: (i, j) => v[i]?.[j] ?? null };
  const t = b.trim(v);
  return { rows: Math.min(v.g.r1, Math.max(t.g.r1, v.g.r0)) - v.g.r0 + 1, cols: v.g.c1 - v.g.c0 + 1, at: (i, j) => b.at(v, i, j) };
}

const roundTo = (x: number, n: number, mode: "half" | "up" | "down") => {
  const f = 10 ** n;
  const y = Number((Math.abs(x) * f).toPrecision(15));
  const k = mode === "half" ? Math.floor(y + 0.5) : mode === "up" ? Math.ceil(y) : Math.floor(y);
  const v = (Math.sign(x) * k) / f;
  return Number(v.toPrecision(15));
};

// ───── criteria (COUNTIF, SUMIF …) ─────

function criterion(crit: Scalar): (v: Scalar) => boolean {
  if (typeof crit === "number" || typeof crit === "boolean") return (v) => v !== null && compare(v, crit) === 0 && typeof v === typeof crit;
  if (crit instanceof Err) return (v) => v instanceof Err && v.code === crit.code;
  const s = crit ?? "";
  const m = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(s)!;
  const op = m[1] ?? "=";
  const rhs = m[2];
  const n = textNumber(rhs);
  const up = rhs.toUpperCase();
  if (n != null) {
    return (v) => {
      const x = typeof v === "number" ? v : typeof v === "string" && op === "=" ? textNumber(v) : null;
      if (x == null) return op === "<>";
      switch (op) {
        case "=": return x === n;
        case "<>": return x !== n;
        case "<": return x < n;
        case ">": return x > n;
        case "<=": return x <= n;
        default: return x >= n;
      }
    };
  }
  if (up === "TRUE" || up === "FALSE") {
    const bv = up === "TRUE";
    return (v) => (op === "<>" ? v !== bv : op === "=" ? v === bv : false);
  }
  if (rhs === "") {
    if (op === "=") return (v) => v === null || v === "";
    if (op === "<>") return (v) => !(v === null || v === "");
  }
  if (op === "=" || op === "<>") {
    const re = new RegExp("^" + rhs.replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (_m, lit, wild, sp) => (lit ? "\\" + lit : wild ? (wild === "*" ? "[\\s\\S]*" : "[\\s\\S]") : "\\" + sp)) + "$", "i");
    return op === "=" ? (v) => typeof v === "string" && re.test(v) : (v) => !(typeof v === "string" && re.test(v));
  }
  return (v) => {
    if (typeof v !== "string") return false;
    const k = compare(v, rhs);
    return op === "<" ? k < 0 : op === ">" ? k > 0 : op === "<=" ? k <= 0 : k >= 0;
  };
}

/** Offsets (i, j) of the cells of `rng` meeting every (range, criterion) pair. */
function matches(b: Book, pairs: { rng: RangeV | Scalar[][]; test: (v: Scalar) => boolean }[]): [number, number][] | Err {
  const g0 = grid(b, pairs[0].rng);
  const grids = pairs.map((p) => grid(b, p.rng));
  if (grids.some((g) => g.cols !== g0.cols)) return E.value;
  const rows = Math.max(...grids.map((g) => g.rows));
  const out: [number, number][] = [];
  for (let i = 0; i < rows; i++) for (let j = 0; j < g0.cols; j++) if (pairs.every((p, k) => p.test(grids[k].at(i, j)))) out.push([i, j]);
  return out;
}

function ifsFn(kind: "sum" | "count" | "avg" | "max" | "min", single: boolean): Fn {
  return (b, args, si, r, c, d) => {
    const pairs: { rng: RangeV | Scalar[][]; test: (v: Scalar) => boolean }[] = [];
    let target: RangeV | Scalar[][] | null = null;
    if (single) {
      const rng = range(b, args[0], si, r, c, d);
      if (rng instanceof Err) return rng;
      pairs.push({ rng, test: criterion(sc(b, args[1], si, r, c, d)) });
      if (kind !== "count") {
        const t = args[2] ? range(b, args[2], si, r, c, d) : rng;
        if (t instanceof Err) return t;
        target = t;
      }
    } else {
      let k = 0;
      if (kind !== "count") {
        const t = range(b, args[0], si, r, c, d);
        if (t instanceof Err) return t;
        target = t;
        k = 1;
      }
      for (; k + 1 < args.length; k += 2) {
        const rng = range(b, args[k], si, r, c, d);
        if (rng instanceof Err) return rng;
        pairs.push({ rng, test: criterion(sc(b, args[k + 1], si, r, c, d)) });
      }
    }
    const hits = matches(b, pairs);
    if (hits instanceof Err) return hits;
    if (kind === "count") return hits.length;
    const tg = grid(b, target!);
    const vals = hits.map(([i, j]) => tg.at(i, j)).filter((v): v is number => typeof v === "number");
    if (kind === "sum") return fix15(vals.reduce((a, x) => a + x, 0));
    if (kind === "avg") return vals.length ? fix15(vals.reduce((a, x) => a + x, 0) / vals.length) : E.div0;
    if (!vals.length) return 0;
    return kind === "max" ? Math.max(...vals) : Math.min(...vals);
  };
}

// ───── lookups ─────

function lookupIndex(key: Scalar, g: { rows: number; cols: number; at: (i: number, j: number) => Scalar }, byRow: boolean, exact: boolean, n: number): number {
  const at = (k: number) => (byRow ? g.at(0, k) : g.at(k, 0));
  if (exact) {
    const test = typeof key === "string" && /[*?~]/.test(key) ? criterion(key) : (v: Scalar) => v !== null && compare(v, key) === 0 && typeof v === typeof key;
    for (let k = 0; k < n; k++) if (test(at(k))) return k;
    return -1;
  }
  // approximate: binary search for the largest value ≤ key (same type)
  let lo = 0, hi = n - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = at(mid);
    if (v === null || compare(v, key) <= 0) {
      if (v !== null && typeof v === typeof key) best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

const vhlookup = (byRow: boolean): Fn => (b, args, si, r, c, d) => {
  const key = sc(b, args[0], si, r, c, d);
  if (key instanceof Err) return key;
  const tbl = range(b, args[1], si, r, c, d);
  if (tbl instanceof Err) return tbl;
  const idx = num(b, args[2], si, r, c, d);
  if (idx instanceof Err) return idx;
  const approx = args[3] && args[3].k !== "miss" ? toBool(sc(b, args[3], si, r, c, d)) : true;
  if (approx instanceof Err) return approx;
  const g = grid(b, tbl);
  const k = Math.trunc(idx);
  if (k < 1) return E.value;
  if (k > (byRow ? g.rows : g.cols)) return E.ref;
  const at = lookupIndex(key, g, byRow, !approx, byRow ? g.cols : g.rows);
  if (at < 0) return E.na;
  return byRow ? g.at(k - 1, at) : g.at(at, k - 1);
};

// ───── dates ─────

const dateArg = (b: Book, a: Ast | undefined, si: number, r: number, c: number, d: number): number | Err => {
  const v = num(b, a, si, r, c, d);
  if (v instanceof Err) return v;
  return v < 0 ? E.num : v;
};
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
function edate(s: number, months: number, end: boolean): number {
  const [y, m, d] = ymdOf(s);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const ny = t.getUTCFullYear(), nm = t.getUTCMonth() + 1;
  const dim = daysInMonth(ny, nm);
  return serialOf(ny, nm, end ? dim : Math.min(d, dim));
}

// ───── statistics ─────

const sum = (xs: number[]) => fix15(xs.reduce((a, x) => a + x, 0));
const variance = (xs: number[], sample: boolean) => {
  const m = xs.reduce((a, x) => a + x, 0) / xs.length;
  return xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - (sample ? 1 : 0));
};

const numsFn = (f: (xs: number[], b: Book, args: Ast[], si: number, r: number, c: number, d: number) => V): Fn => (b, args, si, r, c, d) => {
  const xs = nums(b, args, si, r, c, d);
  return xs instanceof Err ? xs : f(xs, b, args, si, r, c, d);
};
const math1 = (f: (x: number) => number | Err): Fn => (b, args, si, r, c, d) => {
  const x = num(b, args[0], si, r, c, d);
  if (x instanceof Err) return x;
  const v = f(x);
  return v instanceof Err ? v : Number.isFinite(v) ? v : E.num;
};
const text1 = (f: (s: string) => V): Fn => (b, args, si, r, c, d) => {
  const s = txt(b, args[0], si, r, c, d);
  return s instanceof Err ? s : f(s);
};
const is = (f: (v: Scalar) => boolean): Fn => (b, args, si, r, c, d) => f(sc(b, args[0], si, r, c, d));

function rankOf(xs: number[], x: number, asc: boolean): number | Err {
  if (!xs.includes(x)) return E.na;
  return xs.filter((y) => (asc ? y < x : y > x)).length + 1;
}

function textOfNumber(b: Book, x: number, code: string) {
  return formatValue(x, code, { lang: b.lang }).text;
}

const CURRENCY: Record<string, string> = { ko: "₩", ja: "¥", zh: "¥", en: "$" };

export const FUNCTIONS: Record<string, Fn> = {
  // math
  SUM: numsFn((xs) => sum(xs)),
  PRODUCT: numsFn((xs) => (xs.length ? xs.reduce((a, x) => a * x, 1) : 0)),
  AVERAGE: numsFn((xs) => (xs.length ? fix15(sum(xs) / xs.length) : E.div0)),
  MIN: numsFn((xs) => (xs.length ? Math.min(...xs) : 0)),
  MAX: numsFn((xs) => (xs.length ? Math.max(...xs) : 0)),
  MEDIAN: numsFn((xs) => {
    if (!xs.length) return E.num;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }),
  STDEV: numsFn((xs) => (xs.length < 2 ? E.div0 : Math.sqrt(variance(xs, true)))),
  "STDEV.S": numsFn((xs) => (xs.length < 2 ? E.div0 : Math.sqrt(variance(xs, true)))),
  STDEVP: numsFn((xs) => (xs.length < 1 ? E.div0 : Math.sqrt(variance(xs, false)))),
  "STDEV.P": numsFn((xs) => (xs.length < 1 ? E.div0 : Math.sqrt(variance(xs, false)))),
  VAR: numsFn((xs) => (xs.length < 2 ? E.div0 : variance(xs, true))),
  "VAR.S": numsFn((xs) => (xs.length < 2 ? E.div0 : variance(xs, true))),
  VARP: numsFn((xs) => (xs.length < 1 ? E.div0 : variance(xs, false))),
  "VAR.P": numsFn((xs) => (xs.length < 1 ? E.div0 : variance(xs, false))),
  COUNT: (b, args, si, r, c, d) => {
    let n = 0;
    flat(b, args, si, r, c, d, (v, ref) => {
      if (typeof v === "number" || (!ref && (typeof v === "boolean" || (typeof v === "string" && textNumber(v) != null)))) n++;
    });
    return n;
  },
  COUNTA: (b, args, si, r, c, d) => {
    let n = 0;
    for (const a of args) {
      if (a.k === "miss") {
        n++;
        continue;
      }
      const v = ev(b, a, si, r, c, d);
      if (isRange(v)) b.each(b.trim(v), (x) => void (x !== null && n++));
      else if (isArr(v)) v.rows.forEach((row) => row.forEach((x) => void (x !== null && n++)));
      else n++;
    }
    return n;
  },
  COUNTBLANK: (b, args, si, r, c, d) => {
    const v = ev(b, args[0], si, r, c, d);
    if (!isRange(v)) return E.value;
    let filled = 0;
    b.each(v, (x) => void (x !== null && x !== "" && filled++));
    return (v.g.r1 - v.g.r0 + 1) * (v.g.c1 - v.g.c0 + 1) - filled;
  },
  ABS: math1(Math.abs),
  INT: math1(Math.floor),
  TRUNC: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d, 0);
    if (x instanceof Err) return x;
    if (n instanceof Err) return n;
    return roundTo(x, Math.trunc(n), "down");
  },
  ROUND: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (n instanceof Err) return n;
    return roundTo(x, Math.trunc(n), "half");
  },
  ROUNDUP: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (n instanceof Err) return n;
    return roundTo(x, Math.trunc(n), "up");
  },
  ROUNDDOWN: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (n instanceof Err) return n;
    return roundTo(x, Math.trunc(n), "down");
  },
  MOD: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), y = num(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (y instanceof Err) return y;
    if (y === 0) return E.div0;
    return fix15(x - y * Math.floor(x / y));
  },
  SQRT: math1((x) => (x < 0 ? E.num : Math.sqrt(x))),
  POWER: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), y = num(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (y instanceof Err) return y;
    const v = Math.pow(x, y);
    return Number.isFinite(v) ? v : E.num;
  },
  CEILING: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), s = num(b, args[1], si, r, c, d, 1);
    if (x instanceof Err) return x;
    if (s instanceof Err) return s;
    if (s === 0) return 0;
    if (x > 0 && s < 0) return E.num;
    return fix15(Math.ceil(Number((x / s).toPrecision(15))) * s);
  },
  FLOOR: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), s = num(b, args[1], si, r, c, d, 1);
    if (x instanceof Err) return x;
    if (s instanceof Err) return s;
    if (s === 0) return E.div0;
    if (x > 0 && s < 0) return E.num;
    return fix15(Math.floor(Number((x / s).toPrecision(15))) * s);
  },
  "CEILING.MATH": (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), s = num(b, args[1], si, r, c, d, 1);
    if (x instanceof Err) return x;
    if (s instanceof Err) return s;
    return s === 0 ? 0 : fix15(Math.ceil(x / Math.abs(s)) * Math.abs(s));
  },
  "FLOOR.MATH": (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), s = num(b, args[1], si, r, c, d, 1);
    if (x instanceof Err) return x;
    if (s instanceof Err) return s;
    return s === 0 ? 0 : fix15(Math.floor(x / Math.abs(s)) * Math.abs(s));
  },
  PI: () => Math.PI,
  EXP: math1(Math.exp),
  LN: math1((x) => (x <= 0 ? E.num : Math.log(x))),
  LOG10: math1((x) => (x <= 0 ? E.num : Math.log10(x))),
  LOG: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), base = num(b, args[1], si, r, c, d, 10);
    if (x instanceof Err) return x;
    if (base instanceof Err) return base;
    if (x <= 0 || base <= 0 || base === 1) return E.num;
    return fix15(Math.log(x) / Math.log(base));
  },
  SIGN: math1(Math.sign),
  EVEN: math1((x) => Math.sign(x) * Math.ceil(Math.abs(x) / 2) * 2),
  ODD: math1((x) => {
    const a = Math.ceil(Math.abs(x));
    return Math.sign(x || 1) * (a % 2 ? a : a + 1);
  }),
  RAND: () => Math.random(),
  RANDBETWEEN: (b, args, si, r, c, d) => {
    const lo = num(b, args[0], si, r, c, d), hi = num(b, args[1], si, r, c, d);
    if (lo instanceof Err) return lo;
    if (hi instanceof Err) return hi;
    return Math.floor(Math.ceil(lo) + Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1));
  },
  SUMPRODUCT: (b, args, si, r, c, d) => {
    const gs = args.map((a) => range(b, a, si, r, c, d));
    for (const g of gs) if (g instanceof Err) return g;
    const grids = (gs as (RangeV | Scalar[][])[]).map((g) => (Array.isArray(g) ? grid(b, g) : { rows: g.g.r1 - g.g.r0 + 1, cols: g.g.c1 - g.g.c0 + 1, at: (i: number, j: number) => b.at(g, i, j) }));
    const g0 = grids[0];
    if (grids.some((g) => g.rows !== g0.rows || g.cols !== g0.cols)) return E.value;
    let total = 0;
    for (let i = 0; i < g0.rows; i++)
      for (let j = 0; j < g0.cols; j++) {
        let p = 1;
        for (const g of grids) {
          const v = g.at(i, j);
          if (v instanceof Err) return v;
          p *= typeof v === "number" ? v : 0;
        }
        total += p;
      }
    return fix15(total);
  },
  SUMSQ: numsFn((xs) => xs.reduce((a, x) => a + x * x, 0)),
  LARGE: (b, args, si, r, c, d) => {
    const xs = nums(b, [args[0]], si, r, c, d);
    const k = num(b, args[1], si, r, c, d);
    if (xs instanceof Err) return xs;
    if (k instanceof Err) return k;
    const s = [...xs].sort((p, q) => q - p);
    return k < 1 || k > s.length ? E.num : s[Math.ceil(k) - 1];
  },
  SMALL: (b, args, si, r, c, d) => {
    const xs = nums(b, [args[0]], si, r, c, d);
    const k = num(b, args[1], si, r, c, d);
    if (xs instanceof Err) return xs;
    if (k instanceof Err) return k;
    const s = [...xs].sort((p, q) => p - q);
    return k < 1 || k > s.length ? E.num : s[Math.ceil(k) - 1];
  },
  RANK: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d);
    const xs = nums(b, [args[1]], si, r, c, d);
    const o = num(b, args[2], si, r, c, d, 0);
    if (x instanceof Err) return x;
    if (xs instanceof Err) return xs;
    if (o instanceof Err) return o;
    return rankOf(xs, x, o !== 0);
  },
  // logic
  IF: (b, args, si, r, c, d) => {
    const t = toBool(sc(b, args[0], si, r, c, d));
    if (t instanceof Err) return t;
    if (t) return args.length > 1 ? (args[1].k === "miss" ? 0 : ev(b, args[1], si, r, c, d)) : true;
    return args.length > 2 ? (args[2].k === "miss" ? 0 : ev(b, args[2], si, r, c, d)) : false;
  },
  IFS: (b, args, si, r, c, d) => {
    for (let k = 0; k + 1 < args.length; k += 2) {
      const t = toBool(sc(b, args[k], si, r, c, d));
      if (t instanceof Err) return t;
      if (t) return ev(b, args[k + 1], si, r, c, d);
    }
    return E.na;
  },
  IFERROR: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    return v instanceof Err ? ev(b, args[1], si, r, c, d) : v;
  },
  IFNA: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    return v instanceof Err && v.code === "#N/A" ? ev(b, args[1], si, r, c, d) : v;
  },
  AND: (b, args, si, r, c, d) => {
    let res = true, any = false, err: Err | null = null;
    flat(b, args, si, r, c, d, (v, ref) => {
      if (err || (ref && (v === null || typeof v === "string"))) return;
      const t = toBool(v);
      if (t instanceof Err) err = t;
      else {
        any = true;
        res &&= t;
      }
    });
    return err ?? (any ? res : E.value);
  },
  OR: (b, args, si, r, c, d) => {
    let res = false, any = false, err: Err | null = null;
    flat(b, args, si, r, c, d, (v, ref) => {
      if (err || (ref && (v === null || typeof v === "string"))) return;
      const t = toBool(v);
      if (t instanceof Err) err = t;
      else {
        any = true;
        res ||= t;
      }
    });
    return err ?? (any ? res : E.value);
  },
  XOR: (b, args, si, r, c, d) => {
    let n = 0, err: Err | null = null;
    flat(b, args, si, r, c, d, (v, ref) => {
      if (err || (ref && (v === null || typeof v === "string"))) return;
      const t = toBool(v);
      if (t instanceof Err) err = t;
      else if (t) n++;
    });
    return err ?? n % 2 === 1;
  },
  NOT: (b, args, si, r, c, d) => {
    const t = toBool(sc(b, args[0], si, r, c, d));
    return t instanceof Err ? t : !t;
  },
  TRUE: () => true,
  FALSE: () => false,
  CHOOSE: (b, args, si, r, c, d) => {
    const k = num(b, args[0], si, r, c, d);
    if (k instanceof Err) return k;
    const i = Math.trunc(k);
    if (i < 1 || i >= args.length) return E.value;
    return ev(b, args[i], si, r, c, d);
  },
  SWITCH: (b, args, si, r, c, d) => {
    const x = sc(b, args[0], si, r, c, d);
    if (x instanceof Err) return x;
    let k = 1;
    for (; k + 1 < args.length; k += 2) {
      const v = sc(b, args[k], si, r, c, d);
      if (!(v instanceof Err) && compare(x, v) === 0) return ev(b, args[k + 1], si, r, c, d);
    }
    return k < args.length ? ev(b, args[k], si, r, c, d) : E.na;
  },
  // conditional aggregates
  SUMIF: ifsFn("sum", true),
  COUNTIF: ifsFn("count", true),
  AVERAGEIF: ifsFn("avg", true),
  SUMIFS: ifsFn("sum", false),
  COUNTIFS: ifsFn("count", false),
  AVERAGEIFS: ifsFn("avg", false),
  MAXIFS: ifsFn("max", false),
  MINIFS: ifsFn("min", false),
  // lookup
  VLOOKUP: vhlookup(false),
  HLOOKUP: vhlookup(true),
  INDEX: (b, args, si, r, c, d) => {
    const v = ev(b, args[0], si, r, c, d);
    const rr = num(b, args[1], si, r, c, d, 0), cc = num(b, args[2], si, r, c, d, 0);
    if (rr instanceof Err) return rr;
    if (cc instanceof Err) return cc;
    if (isRange(v)) {
      const g = v.g;
      const nr = g.r1 - g.r0 + 1, nc = g.c1 - g.c0 + 1;
      let i = Math.trunc(rr), j = Math.trunc(cc);
      if (nr === 1 && args.length === 2) [i, j] = [1, i];
      if (i < 0 || j < 0 || i > nr || j > nc) return E.ref;
      if (i === 0 && j === 0) return v;
      if (i === 0) return { kind: "range", sheet: v.sheet, g: { r0: g.r0, r1: g.r1, c0: g.c0 + j - 1, c1: g.c0 + j - 1 } };
      if (j === 0) return nc === 1 ? b.at(v, i - 1, 0) : { kind: "range", sheet: v.sheet, g: { r0: g.r0 + i - 1, r1: g.r0 + i - 1, c0: g.c0, c1: g.c1 } };
      return { kind: "range", sheet: v.sheet, g: { r0: g.r0 + i - 1, r1: g.r0 + i - 1, c0: g.c0 + j - 1, c1: g.c0 + j - 1 } };
    }
    if (isArr(v)) {
      const i = Math.max(1, Math.trunc(rr)), j = Math.max(1, Math.trunc(cc));
      return v.rows[i - 1]?.[j - 1] ?? E.ref;
    }
    return v instanceof Err ? v : E.value;
  },
  MATCH: (b, args, si, r, c, d) => {
    const key = sc(b, args[0], si, r, c, d);
    if (key instanceof Err) return key;
    const rng = range(b, args[1], si, r, c, d);
    if (rng instanceof Err) return rng;
    const t = num(b, args[2], si, r, c, d, 1);
    if (t instanceof Err) return t;
    const g = grid(b, rng);
    const byRow = g.rows === 1 && g.cols > 1;
    const n = byRow ? g.cols : g.rows;
    if (t === 0) {
      const k = lookupIndex(key, g, byRow, true, n);
      return k < 0 ? E.na : k + 1;
    }
    if (t > 0) {
      const k = lookupIndex(key, g, byRow, false, n);
      return k < 0 ? E.na : k + 1;
    }
    // descending: the smallest value ≥ key
    let best = -1;
    for (let k = 0; k < n; k++) {
      const v = byRow ? g.at(0, k) : g.at(k, 0);
      if (v !== null && compare(v, key) >= 0) best = k;
      else break;
    }
    return best < 0 ? E.na : best + 1;
  },
  XLOOKUP: (b, args, si, r, c, d) => {
    const key = sc(b, args[0], si, r, c, d);
    if (key instanceof Err) return key;
    const look = range(b, args[1], si, r, c, d), ret = range(b, args[2], si, r, c, d);
    if (look instanceof Err) return look;
    if (ret instanceof Err) return ret;
    const mode = num(b, args[4], si, r, c, d, 0);
    if (mode instanceof Err) return mode;
    const g = grid(b, look), rg = grid(b, ret);
    const byRow = g.rows === 1 && g.cols > 1;
    const n = byRow ? g.cols : g.rows;
    const search = num(b, args[5], si, r, c, d, 1);
    if (search instanceof Err) return search;
    let k = -1;
    if ((mode === 0 || mode === 2) && search === -1) {
      // last to first
      const test = typeof key === "string" && mode === 2 && /[*?~]/.test(key) ? criterion(key) : (v: Scalar) => v !== null && compare(v, key) === 0 && typeof v === typeof key;
      for (let i = n - 1; i >= 0 && k < 0; i--) if (test(byRow ? g.at(0, i) : g.at(i, 0))) k = i;
    } else if (mode === 0 || mode === 2) k = lookupIndex(key, g, byRow, true, n);
    else {
      let bestV: Scalar = null;
      for (let i = 0; i < n; i++) {
        const v = byRow ? g.at(0, i) : g.at(i, 0);
        if (v === null) continue;
        const cmp = compare(v, key);
        if (cmp === 0) {
          k = i;
          break;
        }
        if ((mode < 0 && cmp < 0 && (bestV === null || compare(v, bestV) > 0)) || (mode > 0 && cmp > 0 && (bestV === null || compare(v, bestV) < 0))) {
          bestV = v;
          k = i;
        }
      }
    }
    if (k < 0) return args[3] && args[3].k !== "miss" ? ev(b, args[3], si, r, c, d) : E.na;
    // a return range wider (taller) than one column (row): the whole row (column) it finds — an array that spills
    if (!byRow && rg.cols > 1) return Array.isArray(ret) ? { kind: "arr", rows: [ret[k] ?? []] } : { kind: "range", sheet: ret.sheet, g: { r0: ret.g.r0 + k, r1: ret.g.r0 + k, c0: ret.g.c0, c1: ret.g.c1 } };
    if (byRow && rg.rows > 1) return Array.isArray(ret) ? { kind: "arr", rows: ret.map((row) => [row[k] ?? null]) } : { kind: "range", sheet: ret.sheet, g: { r0: ret.g.r0, r1: ret.g.r1, c0: ret.g.c0 + k, c1: ret.g.c0 + k } };
    return byRow ? rg.at(0, k) : rg.at(k, 0);
  },
  LOOKUP: (b, args, si, r, c, d) => {
    const key = sc(b, args[0], si, r, c, d);
    const look = range(b, args[1], si, r, c, d);
    if (key instanceof Err) return key;
    if (look instanceof Err) return look;
    const g = grid(b, look);
    const byRow = g.cols > g.rows;
    const k = lookupIndex(key, g, byRow, false, byRow ? g.cols : g.rows);
    if (k < 0) return E.na;
    if (args[2]) {
      const ret = range(b, args[2], si, r, c, d);
      if (ret instanceof Err) return ret;
      const rg = grid(b, ret);
      return rg.rows === 1 ? rg.at(0, k) : rg.at(k, 0);
    }
    return byRow ? g.at(g.rows - 1, k) : g.at(k, g.cols - 1);
  },
  ROW: (b, args, si, r) => {
    if (!args.length) return r + 1;
    const v = ev(b, args[0], si, r, 0, 0);
    return isRange(v) ? v.g.r0 + 1 : E.value;
  },
  COLUMN: (b, args, si, r, c) => {
    if (!args.length) return c + 1;
    const v = ev(b, args[0], si, r, c, 0);
    return isRange(v) ? v.g.c0 + 1 : E.value;
  },
  ROWS: (b, args, si, r, c, d) => {
    const v = range(b, args[0], si, r, c, d);
    return v instanceof Err ? v : Array.isArray(v) ? v.length : v.g.r1 - v.g.r0 + 1;
  },
  COLUMNS: (b, args, si, r, c, d) => {
    const v = range(b, args[0], si, r, c, d);
    return v instanceof Err ? v : Array.isArray(v) ? v[0]?.length ?? 0 : v.g.c1 - v.g.c0 + 1;
  },
  OFFSET: (b, args, si, r, c, d) => {
    const v = ev(b, args[0], si, r, c, d);
    if (!isRange(v)) return E.value;
    const dr = num(b, args[1], si, r, c, d), dc = num(b, args[2], si, r, c, d);
    const h = num(b, args[3], si, r, c, d, v.g.r1 - v.g.r0 + 1), w = num(b, args[4], si, r, c, d, v.g.c1 - v.g.c0 + 1);
    for (const x of [dr, dc, h, w]) if (x instanceof Err) return x;
    const r0 = v.g.r0 + (dr as number), c0 = v.g.c0 + (dc as number);
    if (r0 < 0 || c0 < 0 || (h as number) < 1 || (w as number) < 1) return E.ref;
    return { kind: "range", sheet: v.sheet, g: { r0, c0, r1: r0 + (h as number) - 1, c1: c0 + (w as number) - 1 } };
  },
  INDIRECT: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d);
    if (s instanceof Err) return s;
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(s);
    const sheet = m ? (m[1] ?? m[2]).replace(/''/g, "'") : undefined;
    const g = parseRangeLoose(m ? m[3] : s);
    const k = b.sheetIndex(sheet, si);
    if (!g || k < 0) return E.ref;
    return { kind: "range", sheet: b.sheets[k], g };
  },
  // text
  LEFT: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d, 1);
    if (s instanceof Err) return s;
    if (n instanceof Err) return n;
    return n < 0 ? E.value : [...s].slice(0, Math.trunc(n)).join("");
  },
  RIGHT: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d, 1);
    if (s instanceof Err) return s;
    if (n instanceof Err) return n;
    if (n < 0) return E.value;
    const ch = [...s];
    return Math.trunc(n) === 0 ? "" : ch.slice(Math.max(0, ch.length - Math.trunc(n))).join("");
  },
  MID: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d), st = num(b, args[1], si, r, c, d), n = num(b, args[2], si, r, c, d);
    if (s instanceof Err) return s;
    if (st instanceof Err) return st;
    if (n instanceof Err) return n;
    if (st < 1 || n < 0) return E.value;
    return [...s].slice(Math.trunc(st) - 1, Math.trunc(st) - 1 + Math.trunc(n)).join("");
  },
  LEN: text1((s) => [...s].length),
  TRIM: text1((s) => s.replace(/ +/g, " ").trim()),
  UPPER: text1((s) => s.toUpperCase()),
  LOWER: text1((s) => s.toLowerCase()),
  PROPER: text1((s) => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_m, p, ch) => p + ch.toUpperCase())),
  CLEAN: text1((s) => s.replace(/[\x00-\x1f]/g, "")),
  CONCAT: (b, args, si, r, c, d) => {
    let s = "";
    let err: Err | null = null;
    flat(b, args, si, r, c, d, (v) => {
      if (v instanceof Err) err ??= v;
      else if (s.length <= MAX_TEXT) s += toText(v);
    });
    return err ?? (s.length > MAX_TEXT ? E.value : s);
  },
  CONCATENATE: (b, args, si, r, c, d) => {
    let s = "";
    for (const a of args) {
      const v = sc(b, a, si, r, c, d);
      if (v instanceof Err) return v;
      s += toText(v);
      if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT);
    }
    return s;
  },
  TEXTJOIN: (b, args, si, r, c, d) => {
    const sep = txt(b, args[0], si, r, c, d);
    const skip = toBool(sc(b, args[1], si, r, c, d));
    if (sep instanceof Err) return sep;
    if (skip instanceof Err) return skip;
    const parts: string[] = [];
    let err: Err | null = null;
    let len = 0;
    flat(b, args.slice(2), si, r, c, d, (v) => {
      if (v instanceof Err) err ??= v;
      else if (!(skip && (v === null || v === "")) && len <= MAX_TEXT) {
        parts.push(toText(v));
        len += parts[parts.length - 1].length + (parts.length > 1 ? sep.length : 0);
      }
    });
    return err ?? (len > MAX_TEXT ? E.value : parts.join(sep));
  },
  TEXT: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    const f = txt(b, args[1], si, r, c, d);
    if (v instanceof Err) return v;
    if (f instanceof Err) return f;
    const n = typeof v === "string" ? textNumber(v) ?? v : v;
    return formatValue(typeof n === "boolean" ? toText(n) : n, f, { lang: b.lang }).text;
  },
  FIXED: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d, 2);
    const noComma = args[2] ? toBool(sc(b, args[2], si, r, c, d)) : false;
    if (x instanceof Err) return x;
    if (n instanceof Err) return n;
    if (noComma instanceof Err) return noComma;
    const dec = Math.max(0, Math.trunc(n));
    const v = roundTo(x, Math.trunc(n), "half");
    return textOfNumber(b, v, (noComma ? "0" : "#,##0") + (dec ? "." + "0".repeat(dec) : ""));
  },
  DOLLAR: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d, b.lang === "en" ? 2 : 0);
    if (x instanceof Err) return x;
    if (n instanceof Err) return n;
    const dec = Math.max(0, Math.trunc(n));
    const cur = `"${CURRENCY[b.lang] ?? "$"}"`;
    const body = "#,##0" + (dec ? "." + "0".repeat(dec) : "");
    return textOfNumber(b, roundTo(x, Math.trunc(n), "half"), b.lang === "en" ? `${cur}${body}_);(${cur}${body})` : `${cur}${body};-${cur}${body}`);
  },
  SUBSTITUTE: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d), from = txt(b, args[1], si, r, c, d), to = txt(b, args[2], si, r, c, d);
    if (s instanceof Err) return s;
    if (from instanceof Err) return from;
    if (to instanceof Err) return to;
    if (!from) return s;
    if (args[3]) {
      const k = num(b, args[3], si, r, c, d);
      if (k instanceof Err) return k;
      let at = -1;
      for (let i = 0; i < k; i++) {
        at = s.indexOf(from, at + 1);
        if (at < 0) return s;
      }
      return s.length - from.length + to.length > MAX_TEXT ? E.value : s.slice(0, at) + to + s.slice(at + from.length);
    }
    const parts = s.split(from);
    return s.length + (parts.length - 1) * (to.length - from.length) > MAX_TEXT ? E.value : parts.join(to);
  },
  REPLACE: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d), st = num(b, args[1], si, r, c, d), n = num(b, args[2], si, r, c, d), to = txt(b, args[3], si, r, c, d);
    if (s instanceof Err) return s;
    if (st instanceof Err) return st;
    if (n instanceof Err) return n;
    if (to instanceof Err) return to;
    const ch = [...s];
    const out = ch.slice(0, st - 1).join("") + to + ch.slice(st - 1 + n).join("");
    return out.length > MAX_TEXT ? E.value : out;
  },
  FIND: (b, args, si, r, c, d) => {
    const f = txt(b, args[0], si, r, c, d), s = txt(b, args[1], si, r, c, d), st = num(b, args[2], si, r, c, d, 1);
    if (f instanceof Err) return f;
    if (s instanceof Err) return s;
    if (st instanceof Err) return st;
    const k = s.indexOf(f, st - 1);
    return k < 0 ? E.value : k + 1;
  },
  SEARCH: (b, args, si, r, c, d) => {
    const f = txt(b, args[0], si, r, c, d), s = txt(b, args[1], si, r, c, d), st = num(b, args[2], si, r, c, d, 1);
    if (f instanceof Err) return f;
    if (s instanceof Err) return s;
    if (st instanceof Err) return st;
    const re = new RegExp(f.replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (_m, lit, wild, sp) => (lit ? "\\" + lit : wild ? (wild === "*" ? "[\\s\\S]*" : "[\\s\\S]") : "\\" + sp)), "i");
    const m = re.exec(s.slice(st - 1));
    return m ? m.index + st : E.value;
  },
  REPT: (b, args, si, r, c, d) => {
    const s = txt(b, args[0], si, r, c, d), n = num(b, args[1], si, r, c, d);
    if (s instanceof Err) return s;
    if (n instanceof Err) return n;
    return n < 0 || s.length * Math.trunc(n) > MAX_TEXT ? E.value : s.repeat(Math.trunc(n));
  },
  EXACT: (b, args, si, r, c, d) => {
    const x = txt(b, args[0], si, r, c, d), y = txt(b, args[1], si, r, c, d);
    if (x instanceof Err) return x;
    if (y instanceof Err) return y;
    return x === y;
  },
  VALUE: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    if (v instanceof Err || typeof v === "number") return v;
    const n = textNumber(toText(v));
    return n == null ? E.value : n;
  },
  CHAR: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d);
    if (x instanceof Err) return x;
    return x < 1 || x > 255 ? E.value : String.fromCharCode(Math.trunc(x));
  },
  UNICHAR: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d);
    if (x instanceof Err) return x;
    return x < 1 ? E.value : String.fromCodePoint(Math.trunc(x));
  },
  CODE: text1((s) => (s ? s.charCodeAt(0) : E.value)),
  UNICODE: text1((s) => (s ? s.codePointAt(0)! : E.value)),
  T: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    return typeof v === "string" ? v : v instanceof Err ? v : "";
  },
  N: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    return typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : v instanceof Err ? v : 0;
  },
  // dates
  DATE: (b, args, si, r, c, d) => {
    const y = num(b, args[0], si, r, c, d), m = num(b, args[1], si, r, c, d), dd = num(b, args[2], si, r, c, d);
    if (y instanceof Err) return y;
    if (m instanceof Err) return m;
    if (dd instanceof Err) return dd;
    const s = serialOf(Math.trunc(y), Math.trunc(m), Math.trunc(dd));
    return s < 0 ? E.num : s;
  },
  TIME: (b, args, si, r, c, d) => {
    const h = num(b, args[0], si, r, c, d), m = num(b, args[1], si, r, c, d), s = num(b, args[2], si, r, c, d);
    if (h instanceof Err) return h;
    if (m instanceof Err) return m;
    if (s instanceof Err) return s;
    const t = (Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s)) / 86400;
    return t < 0 ? E.num : t - Math.floor(t);
  },
  // text → date / time (Excel: the argument must be text; a number or an unreadable text is #VALUE!)
  DATEVALUE: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    if (v instanceof Err) return v;
    if (typeof v !== "string") return E.value;
    const x = parseDateText(v, new Date(b.now()).getFullYear());
    return x ? x.date : E.value;
  },
  TIMEVALUE: (b, args, si, r, c, d) => {
    const v = sc(b, args[0], si, r, c, d);
    if (v instanceof Err) return v;
    if (typeof v !== "string") return E.value;
    const x = parseDateText(v, new Date(b.now()).getFullYear());
    return x ? x.time : E.value;
  },
  YEAR: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d);
    return s instanceof Err ? s : ymdOf(s)[0];
  },
  MONTH: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d);
    return s instanceof Err ? s : ymdOf(s)[1];
  },
  DAY: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d);
    return s instanceof Err ? s : ymdOf(s)[2];
  },
  WEEKDAY: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d), t = num(b, args[1], si, r, c, d, 1);
    if (s instanceof Err) return s;
    if (t instanceof Err) return t;
    const w = ((Math.floor(s) + 6) % 7) + 1; // 1 = Sunday
    if (t === 2) return ((w + 5) % 7) + 1;
    if (t === 3) return (w + 5) % 7;
    return w;
  },
  HOUR: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d);
    return s instanceof Err ? s : Math.floor(Math.round((s - Math.floor(s)) * 86400) / 3600) % 24;
  },
  MINUTE: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d);
    return s instanceof Err ? s : Math.floor((Math.round((s - Math.floor(s)) * 86400) % 3600) / 60);
  },
  SECOND: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d);
    return s instanceof Err ? s : Math.round((s - Math.floor(s)) * 86400) % 60;
  },
  TODAY: (b) => {
    const now = new Date(b.now());
    return serialOf(now.getFullYear(), now.getMonth() + 1, now.getDate());
  },
  NOW: (b) => {
    const now = new Date(b.now());
    return serialOf(now.getFullYear(), now.getMonth() + 1, now.getDate()) + (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds()) / 86400;
  },
  EDATE: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d), m = num(b, args[1], si, r, c, d);
    if (s instanceof Err) return s;
    if (m instanceof Err) return m;
    return edate(s, Math.trunc(m), false);
  },
  EOMONTH: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d), m = num(b, args[1], si, r, c, d);
    if (s instanceof Err) return s;
    if (m instanceof Err) return m;
    return edate(s, Math.trunc(m), true);
  },
  DAYS: (b, args, si, r, c, d) => {
    const e = dateArg(b, args[0], si, r, c, d), s = dateArg(b, args[1], si, r, c, d);
    if (e instanceof Err) return e;
    if (s instanceof Err) return s;
    return Math.floor(e) - Math.floor(s);
  },
  DATEDIF: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d), e = dateArg(b, args[1], si, r, c, d), u = txt(b, args[2], si, r, c, d);
    if (s instanceof Err) return s;
    if (e instanceof Err) return e;
    if (u instanceof Err) return u;
    if (s > e) return E.num;
    const [y1, m1, d1] = ymdOf(s), [y2, m2, d2] = ymdOf(e);
    const months = (y2 - y1) * 12 + (m2 - m1) - (d2 < d1 ? 1 : 0);
    switch (u.toUpperCase()) {
      case "D": return Math.floor(e) - Math.floor(s);
      case "M": return months;
      case "Y": return Math.floor(months / 12);
      case "YM": return months % 12;
      case "MD": return d2 >= d1 ? d2 - d1 : Math.floor(e) - serialOf(y2, m2 - 1, d1);
      case "YD": {
        let t = serialOf(y2, m1, d1);
        if (t > Math.floor(e)) t = serialOf(y2 - 1, m1, d1);
        return Math.floor(e) - t;
      }
      default: return E.num;
    }
  },
  NETWORKDAYS: (b, args, si, r, c, d) => {
    const s = dateArg(b, args[0], si, r, c, d), e = dateArg(b, args[1], si, r, c, d);
    if (s instanceof Err) return s;
    if (e instanceof Err) return e;
    const hol = new Set<number>();
    if (args[2]) {
      const h = nums(b, [args[2]], si, r, c, d);
      if (h instanceof Err) return h;
      h.forEach((x) => hol.add(Math.floor(x)));
    }
    const [a, z] = s <= e ? [Math.floor(s), Math.floor(e)] : [Math.floor(e), Math.floor(s)];
    let n = 0;
    for (let x = a; x <= z; x++) {
      const w = (x + 6) % 7; // 0 Sunday
      if (w !== 0 && w !== 6 && !hol.has(x)) n++;
    }
    return s <= e ? n : -n;
  },
  // information
  ISNUMBER: is((v) => typeof v === "number"),
  ISTEXT: is((v) => typeof v === "string"),
  ISNONTEXT: is((v) => typeof v !== "string"),
  ISLOGICAL: is((v) => typeof v === "boolean"),
  ISBLANK: is((v) => v === null),
  ISERROR: is((v) => v instanceof Err),
  ISERR: is((v) => v instanceof Err && v.code !== "#N/A"),
  ISNA: is((v) => v instanceof Err && v.code === "#N/A"),
  ISEVEN: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d);
    return x instanceof Err ? x : Math.trunc(x) % 2 === 0;
  },
  ISODD: (b, args, si, r, c, d) => {
    const x = num(b, args[0], si, r, c, d);
    return x instanceof Err ? x : Math.abs(Math.trunc(x)) % 2 === 1;
  },
  NA: () => E.na,
};
FUNCTIONS["RANK.EQ"] = FUNCTIONS.RANK;
FUNCTIONS.AVERAGEA = FUNCTIONS.AVERAGE;
Object.assign(FUNCTIONS, ARRAY_FUNCTIONS);

function parseRangeLoose(s: string) {
  const g = s.replace(/\$/g, "");
  const m = /^([A-Za-z]{1,3}\d+)(?::([A-Za-z]{1,3}\d+))?$/.exec(g);
  if (!m) return null;
  const a = m[1], b2 = m[2] ?? m[1];
  const col = (x: string) => {
    let n = 0;
    for (const ch of x.replace(/\d+/, "").toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
    return n - 1;
  };
  const row = (x: string) => Number(x.replace(/\D+/, "")) - 1;
  return { r0: Math.min(row(a), row(b2)), c0: Math.min(col(a), col(b2)), r1: Math.max(row(a), row(b2)), c1: Math.max(col(a), col(b2)) };
}

export { numText };
