// CSV / TSV (RFC 4180): quoted fields, embedded quotes/newlines, delimiter detection.
// Tables are split across pages with the header repeated; saving joins them back.

import { t as tr } from "../../i18n";
import type { Page, TableCell, TableNode } from "../../core/types";
import { A4_MARGIN } from "../office";
import { flowBlocks, pagesFor, readingOrder, sourceOf } from "./flow";
import { baseName } from "./text";
import { decodeText, encodeText } from "./textcodec";
import type { CsvSourceMeta } from "../../core/types";
import type { SheetCell, SheetData } from "../../core/sheetTypes";
import { applyChange, Book, textNumber } from "../sheet/calc";
import { dateTextFormat, parseDateText } from "../sheet/dateText";
import { addr, formulaRefs, parseFormula, type Rect } from "../sheet/formula";
import { formatValue } from "../sheet/numfmt";

export function detectDelimiter(text: string): string {
  const sample = text.split("\n").slice(0, 20).join("\n");
  let best = ",", bestScore = -1;
  for (const d of [",", "\t", ";", "|"]) {
    const counts = sample.split("\n").filter((l) => l.trim()).map((l) => splitCount(l, d));
    if (!counts.length) continue;
    const first = counts[0];
    const consistent = counts.filter((c) => c === first).length;
    const score = first > 0 ? consistent * 10 + first : 0;
    if (score > bestScore) (best = d), (bestScore = score);
  }
  return best;
}

function splitCount(line: string, d: string): number {
  let n = 0, q = false;
  for (const c of line) {
    if (c === '"') q = !q;
    else if (c === d && !q) n++;
  }
  return n;
}

/** One field of a record as the file wrote it: its value, its exact text (quotes included), whether it was quoted. */
export interface CsvField {
  value: string;
  raw: string;
  quoted: boolean;
}
/** One record (row) as the file wrote it: its fields, its exact text without the line end, and its line end ("" at the end of a file without one). */
export interface CsvRecord {
  fields: CsvField[];
  raw: string;
  term: string;
}

/**
 * Records of a CSV text with line ends as in the file (CR LF, LF or CR; a line break inside a quoted field stays in its
 * value). RFC 4180 plus what Excel accepts: a quote opens a quoted field only at its start; text after the closing
 * quote belongs to the field; an unclosed quote runs to the end.
 */
export function scanCsv(text: string, d: string): CsvRecord[] {
  const s = text.replace(/^﻿/, "");
  const n = s.length;
  const recs: CsvRecord[] = [];
  let i = 0;
  while (i < n) {
    const start = i;
    const fields: CsvField[] = [];
    for (;;) {
      const fs = i;
      let value = "";
      let quoted = false;
      if (s[i] === '"') {
        quoted = true;
        i++;
        while (i < n) {
          const c = s[i];
          if (c === '"') {
            if (s[i + 1] === '"') {
              value += '"';
              i += 2;
              continue;
            }
            i++;
            break;
          }
          value += c;
          i++;
        }
      }
      let j = i;
      while (j < n && s[j] !== d && s[j] !== "\n" && s[j] !== "\r") j++;
      value += s.slice(i, j);
      i = j;
      fields.push({ value, raw: s.slice(fs, i), quoted });
      if (i < n && s[i] === d) {
        i++;
        continue;
      }
      break;
    }
    const end = i;
    let term = "";
    if (s[i] === "\r" && s[i + 1] === "\n") term = "\r\n";
    else if (s[i] === "\r" || s[i] === "\n") term = s[i];
    i += term.length;
    recs.push({ fields, raw: s.slice(start, end), term });
  }
  return recs;
}

export function parseCsv(text: string, delimiter?: string, quotedOut?: boolean[][]): string[][] {
  const recs = scanCsv(text, delimiter ?? detectDelimiter(text));
  if (quotedOut) for (const r of recs) quotedOut.push(r.fields.map((f) => f.quoted));
  return recs.map((r) => r.fields.map((f) => f.value));
}

const NUMERIC = /^-?[\d,]*\.?\d+([eE][-+]?\d+)?%?$/;

/** How the original file quoted its fields (undefined = only where needed, RFC 4180 minimal). */
export function quoteStyle(rows: string[][], quoted: boolean[][]): "all" | "nonnumeric" | undefined {
  const cells = rows.flatMap((r, i) => r.map((v, j) => ({ v, q: !!quoted[i]?.[j] })));
  if (!cells.length || !cells.some((c) => c.q)) return undefined;
  if (cells.every((c) => c.q)) return "all";
  if (cells.every((c) => (c.v === "" ? true : c.q === !NUMERIC.test(c.v))) && cells.some((c) => c.v !== "" && !c.q)) return "nonnumeric";
  return undefined;
}

export function toCsv(rows: string[][], delimiter = ",", style?: "all" | "nonnumeric"): string {
  const quote = (v: string) =>
    v.includes(delimiter) || /["\r\n]/.test(v) || /^\s|\s$/.test(v) || style === "all" || (style === "nonnumeric" && v !== "" && !NUMERIC.test(v)) ? `"${v.replace(/"/g, '""')}"` : v;
  return rows.map((r) => r.map(quote).join(delimiter)).join("\r\n") + "\r\n";
}

/** Column widths (px) from content length. */
export function autoWidths(rows: string[][], min = 56, max = 320): number[] {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const w = new Array(cols).fill(min);
  for (const r of rows.slice(0, 500))
    r.forEach((v, c) => {
      let len = 0;
      for (const ch of v.split("\n")[0] ?? "") len += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch) ? 2 : 1; // i18n: keep — wide-character range, not text
      w[c] = Math.min(max, Math.max(w[c], len * 7 + 16));
    });
  return w;
}

/** Table rows → document pages wide enough for the columns (landscape-like when needed). */
export function tablePages(rows: TableCell[][], title: string, source: Page["source"], sheetName = tr("engine.default.table"), widths?: number[]): Page[] {
  const w = widths ?? autoWidths(rows.map((r) => r.map((c) => c.text)));
  const total = w.reduce((a, c) => a + c, 0);
  const width = Math.min(4000, Math.max(794, Math.ceil(total + A4_MARGIN * 2)));
  const height = width > 794 ? Math.max(794, Math.round(width * 0.7071)) : 1123;
  return flowBlocks([{ kind: "table", rows, colWidths: w, headerRow: true, name: sheetName }], title, {}, { source, width, height });
}

export const MAX_ROWS = 20000;

export function importCsv(bytes: Uint8Array, name: string, opts: { year?: number } = {}): { pages: Page[]; rows: number; cols: number; truncated: boolean } {
  const d = decodeText(bytes);
  const delim = /\.tsv$/i.test(name) ? "\t" : detectDelimiter(d.text);
  // the file's own text (line ends as written): records keep their exact text, so saving writes back what was read
  const raw = d.raw ?? d.text;
  const recs = scanCsv(raw, delim);
  let grid = recs.map((r) => r.fields.map((f) => f.value.replace(/\r\n?/g, "\n")));
  const quote = quoteStyle(grid, recs.map((r) => r.fields.map((f) => f.quoted)));
  while (grid.length && grid[grid.length - 1].every((c) => c === "")) grid.pop();
  const truncated = grid.length > MAX_ROWS;
  if (truncated) grid = grid.slice(0, MAX_ROWS);
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const shown = excelShown(grid, opts.year ?? new Date().getFullYear());
  const rows: TableCell[][] = grid.map((r, i) =>
    Array.from({ length: cols }, (_, c) => {
      const x = shown.get(`${i},${c}`);
      if (x) return { text: x.text, ...(x.formula ? { formula: x.formula } : {}), ...(x.right ? { align: "RIGHT" as const } : {}) };
      return { text: r[c] ?? "", ...(/^-?[\d,]+(\.\d+)?%?$/.test(r[c] ?? "") ? { align: "RIGHT" as const } : {}) };
    }),
  );
  const eol = fileEol(recs);
  const csv: CsvSourceMeta = { text: raw, rows: grid.length, eol, ...(shown.size ? { shown: Object.fromEntries([...shown].map(([k, v]) => [k, v.text])) } : {}) };
  const source = { format: "csv", name, encoding: d.encoding, eol: eol === "\n" ? ("\n" as const) : ("\r\n" as const), bom: d.bom, ...(delim !== "," ? { delimiter: delim } : {}), ...(quote ? { quote } : {}) };
  const pages = tablePages(rows, baseName(name), source, baseName(name));
  // the file's text is kept once, on the first page (the other pages carry the rest of the source)
  if (pages[0]?.source) pages[0].source = { ...pages[0].source, csv };
  return { pages, rows: grid.length, cols, truncated };
}

/** The line end most records use ("\r\n" when the file has none). */
function fileEol(recs: CsvRecord[]): "\r\n" | "\n" | "\r" {
  const n: Record<string, number> = { "\r\n": 0, "\n": 0, "\r": 0 };
  for (const r of recs) if (r.term) n[r.term]++;
  const best = (["\r\n", "\n", "\r"] as const).reduce((a, b) => (n[b] > n[a] ? b : a));
  return n[best] ? best : "\r\n";
}

/**
 * Cells Excel shows differently from the file's text when it opens the CSV (Korean locale, checked with Excel 365 on
 * 2026-11-16): dates typed as text ("2026/1/2" → 2026-01-02, "11/16" → 11월 16일) and formulas ("=1+2" → 3).
 * Omniweave shows them the same way; the file's text is what is saved (keptCsv compares with these).
 * Formulas use Omniweave's engine over the grid as Excel reads it; one it cannot read or calculate (unknown
 * function) stays as the file's text.
 */
/** Time the formulas of a CSV may take to be shown when it opens. */
const SHOW_BUDGET_MS = 1500;

export function excelShown(grid: string[][], year: number): Map<string, { text: string; formula?: string; right?: boolean }> {
  const out = new Map<string, { text: string; formula?: string; right?: boolean }>();
  // array generators (a spill, not shown anyway, or a huge array inside an aggregate) are not calculated: the file's text
  const isFormula = (v: string) => /^=./.test(v) && !/\b(SEQUENCE|RANDARRAY|MMULT|MUNIT|MAKEARRAY)\s*\(/i.test(v);
  let formulas = false;
  grid.forEach((r, i) =>
    r.forEach((v, j) => {
      if (isFormula(v)) {
        formulas = true;
        return;
      }
      const dt = parseDateText(v, year);
      const code = dt && dateTextFormat(dt);
      if (dt && code) {
        const text = formatValue(dt.date + dt.time, code).text;
        if (text !== v) out.set(`${i},${j}`, { text, right: true });
      }
    }),
  );
  if (!formulas) return out;
  // the grid as Excel reads it (numbers, dates, TRUE/FALSE), then the formulas
  const cells: Record<string, SheetCell> = {};
  grid.forEach((r, i) =>
    r.forEach((v, j) => {
      if (v === "") return;
      const a = addr(i, j);
      if (isFormula(v)) cells[a] = { f: v.slice(1) };
      else {
        const dt = parseDateText(v, year);
        const u = v.trim().toUpperCase();
        cells[a] = { v: dt && dateTextFormat(dt) ? dt.date + dt.time : u === "TRUE" ? true : u === "FALSE" ? false : (textNumber(v) ?? v) };
      }
    }),
  );
  const sh: SheetData = { book: "csv", name: "csv", cells, styles: [{}], colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "", baseSize: 11, mdw: 7 };
  // a received file must not hold Omniweave up: formulas not reached within the budget stay the file's text
  // (QA 2026-11-16: 20,000 rows of =SUM(C:C) took minutes); text functions stop at Excel's 32,767 characters
  const book = new Book([sh]);
  book.deadline = performance.now() + SHOW_BUDGET_MS;
  try {
    for (const ch of book.recalc()) applyChange(sh, ch);
  } catch {
    return out;
  }
  // unreadable, unknown function, past the budget or an array: the file's text — and so is a formula using one of those
  // (its value here would be calculated from an empty cell: "=foo(1)" then "=A2+1" is #NAME? in Excel, not 1)
  const live: { i: number; j: number; refs: Rect[] }[] = [];
  const bad: { r: number; c: number }[] = [];
  grid.forEach((r, i) =>
    r.forEach((v, j) => {
      if (!isFormula(v)) return;
      const c = cells[addr(i, j)];
      if (!c || c.stale || c.v === undefined || c.sp || c.spill) bad.push({ r: i, c: j });
      else {
        let refs: Rect[] = [];
        try {
          refs = formulaRefs(parseFormula(v.slice(1))).filter((x) => !x.sheet).map((x) => x.g);
        } catch {
          bad.push({ r: i, c: j });
          return;
        }
        live.push({ i, j, refs });
      }
    }),
  );
  const isBad = new Set(bad.map((b) => `${b.r},${b.c}`));
  const stop = performance.now() + SHOW_BUDGET_MS;
  for (let grew = bad.length > 0; grew; ) {
    grew = false;
    if (performance.now() > stop) return out;
    for (const f of live)
      if (!isBad.has(`${f.i},${f.j}`) && f.refs.some((g) => bad.some((b) => b.r >= g.r0 && b.r <= g.r1 && b.c >= g.c0 && b.c <= g.c1))) {
        isBad.add(`${f.i},${f.j}`);
        bad.push({ r: f.i, c: f.j });
        grew = true;
      }
  }
  grid.forEach((r, i) =>
    r.forEach((v, j) => {
      if (!isFormula(v) || isBad.has(`${i},${j}`)) return;
      const c = cells[addr(i, j)];
      const text = c.t === "e" ? String(c.v) : formatValue(c.v ?? null, "General").text;
      out.set(`${i},${j}`, { text, formula: v.slice(1), right: typeof c.v === "number" });
    }),
  );
  return out;
}

/**
 * Tables grouped by name in reading order. Consecutive chunks of one sheet (split across pages)
 * are joined, dropping the repeated header row.
 */
export function collectTables(pages: Page[]): { name: string; rows: TableCell[][]; colWidths: number[]; headerRow: boolean }[] {
  const out: { name: string; rows: TableCell[][]; colWidths: number[]; headerRow: boolean; last: TableNode }[] = [];
  for (const n of readingOrder(pages)) {
    if (n.type !== "TABLE") continue;
    const prev = out[out.length - 1];
    const sameHeader = prev && n.headerRow && prev.headerRow && JSON.stringify(n.rows[0]?.map((c) => c.text)) === JSON.stringify(prev.rows[0]?.map((c) => c.text));
    if (prev && prev.name === n.name && sameHeader) {
      prev.rows.push(...n.rows.slice(1));
      prev.last = n;
    } else out.push({ name: n.name, rows: [...n.rows], colWidths: [...n.colWidths], headerRow: n.headerRow, last: n });
  }
  return out.map(({ last: _l, ...t }) => t);
}

export function exportCsv(allPages: Page[]): Uint8Array {
  const pages = pagesFor(allPages, ["csv", "xlsx", "xls"]);
  const t = collectTables(pages)[0];
  if (!t) throw new Error(tr("engine.csv.noTable"));
  const src = sourceOf(allPages, ["csv"]);
  const rows = t.rows.map((r) => r.map((c) => c.text));
  const meta = allPages.find((p) => p.source?.format === "csv" && p.source.csv)?.source?.csv;
  const csv = meta ? keptCsv(rows, meta, src?.delimiter ?? ",", src?.quote) : toCsv(rows, src?.delimiter ?? ",", src?.quote);
  // Excel opens UTF-8 CSV correctly only with a BOM; keep the original encoding when there is one
  return encodeText(csv, { encoding: src?.encoding ?? "utf-8", bom: src ? src.bom : true });
}

/**
 * The table written back over the file it came from: a row whose cells all read as when the file was opened is its
 * record's exact text and line end; in an edited row the unedited fields keep their exact text (quotes included) and an
 * edited field keeps its quotes; new rows and fields follow the file (line end, quoting of the column, line breaks
 * inside cells). Records after the table (blank lines at the end, rows past MAX_ROWS) are written as they were, and a
 * file without a final line end gets none.
 */
export function keptCsv(rows: string[][], meta: CsvSourceMeta, d: string, style?: "all" | "nonnumeric"): string {
  const recs = scanCsv(meta.text, d);
  const n0 = Math.min(meta.rows, recs.length);
  const eol = meta.eol;
  const orig = (k: number) => recs[k].fields.map((f, j) => meta.shown?.[`${k},${j}`] ?? f.value.replace(/\r\n?/g, "\n"));
  const same = (row: string[], k: number) => {
    const o = orig(k);
    if (row.length < o.length) return false; // a column was deleted (its empty field must go too)
    for (let j = 0; j < Math.max(row.length, o.length); j++) if ((row[j] ?? "") !== (o[j] ?? "")) return false;
    return true;
  };
  // the file's habits: the line break inside a quoted cell, columns whose every field is quoted
  const breaks = recs.flatMap((r) => r.fields.filter((f) => f.quoted).flatMap((f) => f.raw.match(/\r\n|\r|\n/g) ?? []));
  const inner = breaks.includes("\r\n") ? "\r\n" : breaks.length && breaks.every((x) => x === "\r") ? "\r" : "\n";
  const colQuoted: boolean[] = [];
  for (let j = 0; j < Math.max(0, ...rows.map((r) => r.length)); j++) {
    const fs = recs.slice(n0 > 1 ? 1 : 0, n0).map((r) => r.fields[j]).filter((f): f is CsvField => !!f && f.value !== "");
    colQuoted[j] = fs.length > 0 && fs.every((f) => f.quoted);
  }
  const needs = (v: string) => v.includes(d) || /["\r\n]/.test(v) || /^\s|\s$/.test(v);
  const write = (v: string, q: boolean) => (q || needs(v) ? `"${v.replace(/"/g, '""').replace(/\r\n?|\n/g, inner)}"` : v);
  const fresh = (v: string, j: number) => write(v, v !== "" && (style === "all" || (style === "nonnumeric" && !NUMERIC.test(v)) || !!colQuoted[j]));
  // which record each row is: unedited ("same"), edited, or new
  const plan: { kind: "same" | "edit" | "new"; k: number; row: string[] }[] = [];
  let k = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (k < n0 && same(row, k)) {
      plan.push({ kind: "same", k: k++, row });
      continue;
    }
    // rows deleted before this one
    let m = -1;
    for (let x = k + 1; x < Math.min(n0, k + 64); x++)
      if (same(row, x)) {
        m = x;
        break;
      }
    if (m >= 0) {
      plan.push({ kind: "same", k: m, row });
      k = m + 1;
      continue;
    }
    // a new row (the next one is the file's next record, or the file's rows are used up)
    if (k >= n0 || (i + 1 < rows.length && same(rows[i + 1], k))) {
      plan.push({ kind: "new", k: -1, row });
      continue;
    }
    plan.push({ kind: "edit", k: k++, row });
  }
  // rows or columns inserted, deleted or moved: a formula's relative references would point elsewhere, so a formula the
  // file wrote is saved as the value shown (what Excel writes to a CSV); with every row and column in place, as written
  const cols0 = Math.max(0, ...recs.slice(0, n0).map((r) => r.fields.length));
  const shifted = plan.length !== n0 || plan.some((p, i) => p.k !== i) || rows.some((r) => r.length !== cols0);
  const formulaAt = (k: number, j: number) => shifted && meta.shown?.[`${k},${j}`] !== undefined && recs[k].fields[j].value.startsWith("=");
  const rawOf = (k: number, j: number) => (formulaAt(k, j) ? write(meta.shown![`${k},${j}`], recs[k].fields[j].quoted) : recs[k].fields[j].raw);
  const lines: { text: string; term: string }[] = plan.map(({ kind, k, row }) => {
    if (kind === "new") return { text: row.map(fresh).join(d), term: eol };
    const rec = recs[k];
    if (kind === "same") return { text: rec.fields.some((_, j) => formulaAt(k, j)) ? rec.fields.map((_, j) => rawOf(k, j)).join(d) : rec.raw, term: rec.term };
    // an edited row: unedited fields as written, an edited one keeps its quotes; as many fields as the record (fewer
    // when columns were deleted, more for cells written past its end)
    const o = orig(k);
    let last = row.length;
    while (last > rec.fields.length && (row[last - 1] ?? "") === "") last--;
    const out: string[] = [];
    for (let j = 0; j < Math.max(last, Math.min(rec.fields.length, row.length)); j++) {
      const v = row[j] ?? "", f = rec.fields[j];
      out.push(f && v === o[j] ? rawOf(k, j) : f ? write(v, f.quoted) : fresh(v, j));
    }
    return { text: out.join(d), term: rec.term };
  });
  const rest = recs.slice(n0).map((r) => r.raw + r.term).join("");
  const endsOpen = recs.length > 0 && recs[recs.length - 1].term === "";
  let s = "";
  lines.forEach((l, i) => {
    const term = i < lines.length - 1 || rest || !endsOpen ? l.term || eol : "";
    s += l.text + term;
  });
  return s + rest;
}
