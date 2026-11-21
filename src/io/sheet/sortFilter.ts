// Sort, AutoFilter and Find / Replace on a sheet (표 계산 정렬·필터·찾기) — the parts that do not need the screen:
// the current region (Ctrl+*), Excel's sort order (numbers < text < FALSE < TRUE < errors, blanks always last,
// text without case), header-row guessing, the values of a filter column and which rows a filter hides, and
// Excel's find rules (* ? ~ wildcards, match case, match entire cell, look in formulas / values).

import type { SheetCell, SheetData, SheetFilter } from "../../core/sheetTypes";
import { addr, MAX_COL, MAX_ROW, parseAddr, parseRange, shiftFormula, type Rect } from "./formula";
import { formatValue, type SheetLang } from "./numfmt";

const filled = (c: SheetCell | undefined) => !!c && ((c.v !== undefined && c.v !== "") || !!c.f);

/** The block of data around a cell bounded by empty rows and columns (Excel's current region, Ctrl+*). */
export function currentRegion(sh: SheetData, r: number, c: number): Rect {
  const g: Rect = { r0: r, c0: c, r1: r, c1: c };
  const has = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr <= MAX_ROW && cc <= MAX_COL && filled(sh.cells[addr(rr, cc)]);
  for (let grew = true; grew; ) {
    grew = false;
    const rowHas = (rr: number) => {
      for (let cc = Math.max(0, g.c0 - 1); cc <= g.c1 + 1; cc++) if (has(rr, cc)) return true;
      return false;
    };
    const colHas = (cc: number) => {
      for (let rr = Math.max(0, g.r0 - 1); rr <= g.r1 + 1; rr++) if (has(rr, cc)) return true;
      return false;
    };
    if (g.r0 > 0 && rowHas(g.r0 - 1)) (g.r0--, (grew = true));
    if (g.r1 < MAX_ROW && rowHas(g.r1 + 1)) (g.r1++, (grew = true));
    if (g.c0 > 0 && colHas(g.c0 - 1)) (g.c0--, (grew = true));
    if (g.c1 < MAX_COL && colHas(g.c1 + 1)) (g.c1++, (grew = true));
  }
  return g;
}

/** The text a cell shows (number format applied). */
export function shownText(sh: SheetData, cell: SheetCell | undefined, lang: SheetLang): string {
  if (!cell || cell.v === undefined || cell.v === null) return "";
  if (cell.t === "e") return String(cell.v);
  return formatValue(cell.v, sh.styles[cell.s ?? 0]?.fmt, { date1904: sh.date1904, lang }).text;
}

// ───── sort ─────

export interface SortKey {
  /** sheet column */
  col: number;
  desc?: boolean;
}

const rank = (c: SheetCell | undefined) => {
  if (!c || c.v === undefined || c.v === "") return 5;
  if (c.t === "e") return 4;
  if (typeof c.v === "number") return 0;
  if (typeof c.v === "string") return 1;
  return c.v ? 3 : 2;
};
// root order (Excel: Latin before Hangul / kana / Han), case-insensitive
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: false });

/** Excel's order of two cells (blanks are handled by the caller: always last). */
export function compareCells(a: SheetCell | undefined, b: SheetCell | undefined): number {
  const ra = rank(a), rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return (a!.v as number) - (b!.v as number);
  if (ra === 1) return collator.compare(a!.v as string, b!.v as string);
  return 0;
}

/** Whether the first row of a range looks like headings (text over a column that also holds other values, or bold). */
export function guessHeader(sh: SheetData, g: Rect): boolean {
  if (g.r1 <= g.r0) return false;
  let text = 0, other = 0;
  for (let c = g.c0; c <= g.c1; c++) {
    const h = sh.cells[addr(g.r0, c)];
    const below = sh.cells[addr(g.r0 + 1, c)];
    if (!filled(h)) continue;
    if (typeof h!.v === "string" && !h!.f) {
      text++;
      if (below && typeof below.v !== "string") other++;
      if (sh.styles[h!.s ?? 0]?.bold && !sh.styles[below?.s ?? 0]?.bold) other++;
    } else return false;
  }
  return text > 0 && other > 0;
}

/** The cell edits that sort the rows of `g` by `keys` (the header row stays); null when merged cells are in the way. */
export function sortEdits(sh: SheetData, g: Rect, keys: SortKey[], header: boolean): { a: string; cell: SheetCell | undefined }[] | null {
  for (const m of sh.merges) {
    const q = parseRange(m);
    if (q && !(q.r1 < g.r0 || q.r0 > g.r1 || q.c1 < g.c0 || q.c0 > g.c1)) return null;
  }
  const r0 = g.r0 + (header ? 1 : 0);
  if (r0 >= g.r1) return [];
  const rows: number[] = [];
  for (let r = r0; r <= g.r1; r++) rows.push(r);
  const order = [...rows].sort((x, y) => {
    for (const k of keys) {
      const a = sh.cells[addr(x, k.col)], b = sh.cells[addr(y, k.col)];
      const ba = rank(a) === 5, bb = rank(b) === 5;
      if (ba || bb) {
        if (ba !== bb) return ba ? 1 : -1;
        continue;
      }
      const d = compareCells(a, b);
      if (d) return k.desc ? -d : d;
    }
    return x - y;
  });
  const out: { a: string; cell: SheetCell | undefined }[] = [];
  order.forEach((from, i) => {
    const to = rows[i];
    if (from === to) return;
    for (let c = g.c0; c <= g.c1; c++) {
      const src = sh.cells[addr(from, c)];
      out.push({ a: addr(to, c), cell: src ? (src.f ? { ...src, f: shiftFormula(src.f, to - from, 0) } : { ...src }) : undefined });
    }
  });
  return out;
}

// ───── AutoFilter ─────

/** The distinct shown values of a filter column (sorted as Excel lists them) and whether it has empty cells. */
export function filterValues(sh: SheetData, f: SheetFilter, col: number, lang: SheetLang): { values: string[]; blank: boolean } {
  const g = parseRange(f.ref)!;
  const seen = new Map<string, SheetCell>();
  let blank = false;
  for (let r = g.r0 + 1; r <= g.r1; r++) {
    const c = sh.cells[addr(r, g.c0 + col)];
    const t = shownText(sh, c, lang);
    if (!t) blank = true;
    else if (!seen.has(t)) seen.set(t, c!);
  }
  const values = [...seen.entries()].sort((a, b) => compareCells(a[1], b[1]) || collator.compare(a[0], b[0])).map((x) => x[0]);
  return { values, blank };
}

/** Rows of the filter range a filter hides (the header row never). */
export function filterHiddenRows(sh: SheetData, f: SheetFilter, lang: SheetLang): number[] {
  const g = parseRange(f.ref);
  if (!g) return [];
  const out: number[] = [];
  const cols = Object.entries(f.cols ?? {}).filter(([, v]) => !v.other && v.vals);
  if (!cols.length) return out;
  const sets = cols.map(([k, v]) => ({ c: g.c0 + Number(k), vals: new Set(v.vals!.map((x) => x.toLowerCase())), blank: !!v.blank }));
  for (let r = g.r0 + 1; r <= g.r1; r++) {
    for (const s of sets) {
      const t = shownText(sh, sh.cells[addr(r, s.c)], lang);
      if (t ? !s.vals.has(t.toLowerCase()) : !s.blank) {
        out.push(r);
        break;
      }
    }
  }
  return out;
}

/** The filter range for a cell: its current region (grown down to the last filled row). */
export function filterRangeAt(sh: SheetData, r: number, c: number, sel?: Rect): Rect {
  if (sel && (sel.r0 !== sel.r1 || sel.c0 !== sel.c1)) return { ...sel, r1: Math.min(sel.r1, Math.max(sel.r0 + 1, lastRow(sh, sel))) };
  return currentRegion(sh, r, c);
}
function lastRow(sh: SheetData, g: Rect): number {
  let r1 = g.r0;
  for (const a of Object.keys(sh.cells)) {
    const p = parseAddr(a);
    if (p && p.c >= g.c0 && p.c <= g.c1 && p.r > r1 && filled(sh.cells[a])) r1 = p.r;
  }
  return r1;
}

// ───── find / replace ─────

export interface FindOpts {
  matchCase?: boolean;
  /** match entire cell contents */
  whole?: boolean;
  /** look in: formulas (what the cell holds — formulas with "=") or values (what it shows) */
  lookIn?: "formulas" | "values";
  /** search by columns instead of rows */
  byCols?: boolean;
}

/** Excel's find pattern (* any text, ? one character, ~ escapes) as a regular expression. */
export function findPattern(q: string, o: FindOpts, global = false): RegExp {
  let src = "";
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === "~" && i + 1 < q.length && /[*?~]/.test(q[i + 1])) src += "\\" + q[++i];
    else if (ch === "*") src += "[\\s\\S]*";
    else if (ch === "?") src += "[\\s\\S]";
    else src += ch.replace(/[.+^${}()|[\]\\/-]/g, "\\$&");
  }
  if (o.whole) src = `^(?:${src})$`;
  return new RegExp(src, (o.matchCase ? "" : "i") + (global ? "g" : ""));
}

/** The text a cell is searched in. */
export function searchText(sh: SheetData, cell: SheetCell, o: FindOpts, lang: SheetLang): string {
  if (o.lookIn !== "values" && cell.f) return "=" + cell.f.replace(/_xlfn\.|_xlws\./gi, "");
  if (o.lookIn === "values") return shownText(sh, cell, lang);
  if (cell.v === undefined) return "";
  return typeof cell.v === "boolean" ? (cell.v ? "TRUE" : "FALSE") : cell.t === "e" ? String(cell.v) : typeof cell.v === "number" ? String(cell.v) : cell.v;
}

/** Every matching cell of a range (the whole sheet when omitted), in Excel's order (by rows, or by columns). */
export function findAll(sh: SheetData, q: string, o: FindOpts, lang: SheetLang, within?: Rect): string[] {
  if (!q) return [];
  const re = findPattern(q, o);
  const hits: { a: string; r: number; c: number }[] = [];
  for (const [a, cell] of Object.entries(sh.cells)) {
    const p = parseAddr(a);
    if (!p) continue;
    if (within && (p.r < within.r0 || p.r > within.r1 || p.c < within.c0 || p.c > within.c1)) continue;
    const text = searchText(sh, cell, o, lang);
    if (text && re.test(text)) hits.push({ a, ...p });
  }
  hits.sort((x, y) => (o.byCols ? x.c - y.c || x.r - y.r : x.r - y.r || x.c - y.c));
  return hits.map((h) => h.a);
}

/** The next match after the active cell (wrapping around), or null. */
export function findNext(sh: SheetData, q: string, o: FindOpts, lang: SheetLang, from: { r: number; c: number }, back = false, within?: Rect): string | null {
  const all = findAll(sh, q, o, lang, within);
  if (!all.length) return null;
  const key = (a: string) => {
    const p = parseAddr(a)!;
    return o.byCols ? p.c * (MAX_ROW + 1) + p.r : p.r * (MAX_COL + 1) + p.c;
  };
  const k0 = o.byCols ? from.c * (MAX_ROW + 1) + from.r : from.r * (MAX_COL + 1) + from.c;
  if (back) return [...all].reverse().find((a) => key(a) < k0) ?? all[all.length - 1];
  return all.find((a) => key(a) > k0) ?? all[0];
}

/** What a replace writes into a cell's text (every match replaced; the whole text when matching entire cells). */
export function replaceText(text: string, q: string, by: string, o: FindOpts): string {
  if (o.whole) return findPattern(q, o).test(text) ? by : text;
  return text.replace(findPattern(q, o, true), () => by);
}
