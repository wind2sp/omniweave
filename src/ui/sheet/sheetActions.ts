// Sheet editing (표 계산 편집): what the grid, the formula bar and the sheet ribbon do to a sheet page — typing into
// cells (Excel's input rules: numbers, percentages, dates, times, currency, TRUE/FALSE, 'text, =formulas), recalculating
// only what depends on the change, cell formats, merges, column widths, frozen panes, sheet tabs, clipboard and sending a
// range to a document page. Every change is one undo step (core/store commit).

import { create } from "zustand";
import { draftPage, findPage, useStore } from "../../core/store";
import type { SheetCell, SheetData, SheetStyle } from "../../core/sheetTypes";
import type { OmwDocument, Page } from "../../core/types";
import { t, useLang } from "../../i18n";
import { applyChange, Book, numText, textNumber } from "../../io/sheet/calc";
import { shownFormula } from "../../io/sheet/book";
import { addr, colLetters, MAX_COL, MAX_ROW, parseAddr, parseFormula, parseRange, rangeText, sheetRef, shiftFormula, tokenize, type Rect } from "../../io/sheet/formula";
import { isDateCode, type SheetLang } from "../../io/sheet/numfmt";
import { sheetCells, usedRange } from "../../io/sheet/pages";
import { tablePages } from "../../io/formats/csv";
import { sheetPages } from "../../io/sheet/book";

const S = () => useStore.getState();
export const lang = (): SheetLang => useLang.getState().lang as SheetLang;

// ───── grid UI state shared by the view, ribbon and status ─────

export interface Sel {
  /** active cell */
  ar: number;
  ac: number;
  /** anchor of the range (shift-extend keeps it) */
  r0: number;
  c0: number;
  /** other corner */
  r1: number;
  c1: number;
}
export const norm = (s: Sel): Rect => ({ r0: Math.min(s.r0, s.r1), c0: Math.min(s.c0, s.c1), r1: Math.max(s.r0, s.r1), c1: Math.max(s.c0, s.c1) });
export const one = (r: number, c: number): Sel => ({ ar: r, ac: c, r0: r, c0: c, r1: r, c1: c });

export const useSheetUI = create<{ sel: Record<string, Sel>; tick: number }>(() => ({ sel: {}, tick: 0 }));
export const selOf = (pageId: string): Sel => useSheetUI.getState().sel[pageId] ?? one(0, 0);
export const setSel = (pageId: string, s: Sel) => useSheetUI.setState((st) => ({ sel: { ...st.sel, [pageId]: s } }));

// ───── book ─────

/** The sheet pages of a page's workbook, in tab order. */
export function bookPages(doc: OmwDocument, page: Page): Page[] {
  const b = page.sheet?.book;
  return b ? doc.pages.filter((p) => p.sheet?.book === b) : [page];
}

/** Recalculate what depends on the changed cells; values to write back (not applied). */
function recalc(doc: OmwDocument, page: Page, sheetAfter: SheetData, changed: string[], all = false) {
  const pages = bookPages(doc, page);
  const sheets = pages.map((p) => (p.id === page.id ? sheetAfter : p.sheet!));
  const si = pages.findIndex((p) => p.id === page.id);
  const book = new Book(sheets);
  book.lang = lang();
  const keys = all ? undefined : book.dependents(changed.map((a) => ({ sheet: si, addr: a })));
  const out = book.recalc(keys);
  if (book.circular) S().notify(t("sheet.circular"));
  return out.map((ch) => ({ ...ch, pageId: pages[ch.sheet].id }));
}

/** Commit cell edits on one page with the recalculation they cause (one undo step). */
export function setCells(pageId: string, edits: { a: string; cell: SheetCell | undefined }[], label = t("sheet.h.edit"), extra?: (sh: SheetData) => void) {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet || !edits.length) return;
  const cells = { ...page.sheet.cells };
  for (const e of edits) {
    if (e.cell && (e.cell.v !== undefined || e.cell.f || e.cell.s)) cells[e.a] = e.cell;
    else delete cells[e.a];
  }
  let after: SheetData = { ...page.sheet, cells };
  if (extra) {
    after = JSON.parse(JSON.stringify(after));
    extra(after);
  }
  const changes = recalc(st.doc, page, after, edits.map((e) => e.a));
  st.commit(label, (d) => {
    const pg = draftPage(d, pageId);
    if (!pg?.sheet) return;
    if (extra) pg.sheet = after as typeof pg.sheet;
    else
      for (const e of edits) {
        if (cells[e.a]) pg.sheet.cells[e.a] = cells[e.a];
        else delete pg.sheet.cells[e.a];
      }
    for (const ch of changes) {
      const sh2 = draftPage(d, ch.pageId)?.sheet;
      if (sh2) applyChange(sh2 as SheetData, ch); // values, and the cells dynamic arrays spill into
    }
  });
}

/** Style index for a style (an existing equal one, else appended — existing styles are never changed). */
export function styleIndex(sh: SheetData, st: SheetStyle): number {
  const clean = JSON.parse(JSON.stringify(st)) as SheetStyle;
  for (const k of Object.keys(clean) as (keyof SheetStyle)[]) if (clean[k] === undefined || clean[k] === false) delete clean[k];
  const key = JSON.stringify(clean);
  const i = sh.styles.findIndex((s) => JSON.stringify(s) === key);
  if (i >= 0) return i;
  sh.styles.push(clean);
  return sh.styles.length - 1;
}

/** Apply a style change to every cell of a range (empty cells get a styled empty cell). */
export function formatRange(pageId: string, g: Rect, patch: (st: SheetStyle) => SheetStyle, label = t("sheet.h.format")) {
  const page = findPage(S().doc, pageId);
  if (!page?.sheet) return;
  const u = usedRange(page.sheet);
  const area = { r0: g.r0, c0: g.c0, r1: Math.min(g.r1, Math.max(g.r0, u.r1 + 50)), c1: Math.min(g.c1, Math.max(g.c0, u.c1 + 20)) };
  if ((area.r1 - area.r0 + 1) * (area.c1 - area.c0 + 1) > 200000) return;
  S().commit(label, (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    const memo = new Map<number, number>();
    for (let r = area.r0; r <= area.r1; r++)
      for (let c = area.c0; c <= area.c1; c++) {
        const a = addr(r, c);
        const cell = sh.cells[a];
        const s0 = cell?.s ?? 0;
        let s1 = memo.get(s0);
        if (s1 === undefined) {
          s1 = styleIndex(sh as SheetData, patch({ ...(sh.styles[s0] ?? {}) }));
          memo.set(s0, s1);
        }
        if (cell) {
          if (s1) cell.s = s1;
          else delete cell.s;
        } else if (s1) sh.cells[a] = { s: s1 };
      }
  });
}

/** Style of the active cell. */
export const styleAt = (sh: SheetData, r: number, c: number): SheetStyle => sh.styles[sh.cells[addr(r, c)]?.s ?? 0] ?? {};

// ───── input ─────

const DATE_FMT: Record<SheetLang, string> = { ko: "yyyy-mm-dd", en: "m/d/yyyy", ja: "yyyy/m/d", zh: "yyyy/m/d" };
const CURRENCY: Record<string, string> = { "₩": '"₩"#,##0', $: '"$"#,##0.00', "¥": '"¥"#,##0', "€": '"€"#,##0.00', "￦": '"₩"#,##0' };

/** What typing `text` into a cell makes (Excel's entry rules); `fmt` = a number format the entry brings (when the cell has none). */
export function parseInput(text: string, st: SheetStyle, lng: SheetLang = lang()): { v?: number | string | boolean; f?: string; fmt?: string; error?: boolean } {
  if (text === "") return {};
  if (text.startsWith("=") && text.length > 1) {
    const f = text.slice(1);
    try {
      parseFormula(f);
    } catch {
      return { error: true };
    }
    return { f };
  }
  if (text.startsWith("'")) return { v: text.slice(1) };
  if (st.fmt === "@") return { v: text };
  const tr = text.trim();
  const up = tr.toUpperCase();
  if (up === "TRUE" || up === "FALSE") return { v: up === "TRUE" };
  const general = !st.fmt || st.fmt === "General";
  // currency
  const cur = /^(-?)([₩$¥€￦])\s?([\d,]+(\.\d+)?)$/.exec(tr);
  if (cur) {
    const n = Number(cur[3].replace(/,/g, "")) * (cur[1] ? -1 : 1);
    return { v: n, fmt: general ? CURRENCY[cur[2]] : undefined };
  }
  // numbers (with thousands separators), percentages
  if (/^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/.test(tr) && /\d/.test(tr)) {
    const pct = tr.endsWith("%");
    const n = Number(tr.replace(/,/g, "").replace(/%$/, ""));
    if (Number.isFinite(n)) {
      if (pct) return { v: n / 100, fmt: general ? (/\.\d/.test(tr) ? "0." + "0".repeat((/\.(\d+)/.exec(tr)?.[1].length ?? 1)) + "%" : "0%") : undefined };
      // a number typed into a percent cell is a percentage (Excel's automatic percent entry)
      if (st.fmt && /%/.test(st.fmt.replace(/"[^"]*"/g, ""))) return { v: n / 100 };
      return { v: n, fmt: general && tr.includes(",") ? (tr.includes(".") ? "#,##0.00" : "#,##0") : undefined };
    }
  }
  // dates and times
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(tr);
  if (!m && lng === "en") {
    const e = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(tr);
    if (e) m = [e[0], e[3], e[1], e[2]] as unknown as RegExpExecArray;
  }
  if (m) {
    const v = textNumber(`${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5]}${m[6] ? ":" + m[6] : ""}` : ""}`);
    if (v != null && Number(m[2]) <= 12 && Number(m[3]) <= 31) return { v, fmt: general || !isDateCode(st.fmt!) ? (m[4] ? DATE_FMT[lng] + " h:mm" : DATE_FMT[lng]) : undefined };
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(tr);
  if (m && Number(m[1]) < 24 && Number(m[2]) < 60) {
    const v = textNumber(tr)!;
    return { v, fmt: general ? (m[3] ? "h:mm:ss" : "h:mm") : undefined };
  }
  return { v: text };
}

/** The text a cell is edited as (formula bar): formulas with "=", dates as dates, percentages with %. */
export function editText(sh: SheetData, cell: SheetCell | undefined, lng: SheetLang = lang()): string {
  if (!cell) return "";
  if (cell.f) return "=" + shownFormula(cell.f);
  const v = cell.v;
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "string") return cell.t !== "e" && /^(=|'|TRUE$|FALSE$)/i.test(v) ? "'" + v : v;
  const fmt = sh.styles[cell.s ?? 0]?.fmt;
  if (fmt && isDateCode(fmt)) {
    const days = Math.floor(v);
    const secs = Math.round((v - days) * 86400);
    const time = secs ? ` ${Math.floor(secs / 3600)}:${String(Math.floor((secs % 3600) / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}` : "";
    if (days === 0 && secs) return time.trim();
    const dt = new Date(Date.UTC(1899, 11, days < 61 ? 31 : 30) + days * 86400000);
    const [y, mo, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
    return (lng === "en" ? `${mo}/${d}/${y}` : lng === "ko" ? `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}` : `${y}/${mo}/${d}`) + time;
  }
  if (fmt && /%/.test(fmt.replace(/"[^"]*"/g, ""))) return numText(v * 100) + "%";
  return numText(v);
}

/** Type `text` into a cell (Enter / Tab in the grid, the formula bar). */
export function enterText(pageId: string, r: number, c: number, text: string): boolean {
  const page = findPage(S().doc, pageId);
  const sh = page?.sheet;
  if (!sh) return false;
  const a = addr(r, c);
  const old = sh.cells[a];
  const st = sh.styles[old?.s ?? 0] ?? {};
  const p = parseInput(text, st);
  if (p.error) {
    S().notify(t("sheet.badFormula"));
    return false;
  }
  const cell: SheetCell = {};
  if (old?.s) cell.s = old.s;
  if (p.f !== undefined) cell.f = p.f;
  else if (p.v !== undefined) cell.v = p.v;
  const fmt = p.fmt;
  setCells(pageId, [{ a, cell }], t("sheet.h.edit"), fmt ? (after) => {
    const c2 = after.cells[a] ?? (after.cells[a] = {});
    const s = styleIndex(after, { ...(after.styles[c2.s ?? 0] ?? {}), fmt });
    if (s) c2.s = s;
  } : undefined);
  return true;
}

export function clearRange(pageId: string, g: Rect) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  for (const [a, cell] of Object.entries(sh.cells)) {
    const p = parseAddr(a)!;
    if (p.r < g.r0 || p.r > g.r1 || p.c < g.c0 || p.c > g.c1) continue;
    if (cell.v === undefined && !cell.f) continue;
    edits.push({ a, cell: cell.s ? { s: cell.s } : undefined });
  }
  setCells(pageId, edits, t("sheet.h.clear"));
}

// ───── layout ─────

export function setColWidth(pageId: string, cols: number[], px: number, label = t("sheet.h.colWidth")) {
  S().commit(label, (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    for (const c of cols) {
      if (px <= 0) {
        sh.hiddenCols = [...new Set([...(sh.hiddenCols ?? []), c])];
        continue;
      }
      sh.colW[c] = Math.round(px);
      if (sh.hiddenCols?.includes(c)) sh.hiddenCols = sh.hiddenCols.filter((x) => x !== c);
    }
  });
}

export function setRowHeight(pageId: string, rows: number[], px: number) {
  S().commit(t("sheet.h.rowHeight"), (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    for (const r of rows) {
      sh.rowH[r] = Math.max(0, Math.round(px));
      // a height set here is the user's own (customHeight), no longer Excel's fit to the text
      if (sh.rowAuto) delete sh.rowAuto[r];
    }
    if (sh.rowAuto && !Object.keys(sh.rowAuto).length) delete sh.rowAuto;
  });
}

export function toggleFreeze(pageId: string, r: number, c: number) {
  S().commit(t("sheet.h.freeze"), (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    if (sh.freeze || (!r && !c)) delete sh.freeze;
    else sh.freeze = { rows: r, cols: c };
  });
}

export function toggleGrid(pageId: string) {
  S().commit(t("sheet.h.grid"), (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (sh) sh.grid = !sh.grid;
  });
}

/** Merge & Center (or unmerge when the range is one merge already / overlaps merges). */
export function toggleMerge(pageId: string, g: Rect) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const overlaps = sh.merges.filter((m) => {
    const q = parseRange(m)!;
    return !(q.r1 < g.r0 || q.r0 > g.r1 || q.c1 < g.c0 || q.c0 > g.c1);
  });
  if (overlaps.length) {
    S().commit(t("sheet.h.unmerge"), (d) => {
      const s2 = draftPage(d, pageId)?.sheet;
      if (s2) s2.merges = s2.merges.filter((m) => !overlaps.includes(m));
    });
    return;
  }
  if (g.r0 === g.r1 && g.c0 === g.c1) return;
  // Excel keeps the upper-left value only
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  for (let r = g.r0; r <= g.r1; r++)
    for (let c = g.c0; c <= g.c1; c++) {
      if (r === g.r0 && c === g.c0) continue;
      const a = addr(r, c);
      const cell = sh.cells[a];
      if (cell && (cell.v !== undefined || cell.f)) edits.push({ a, cell: cell.s ? { s: cell.s } : undefined });
    }
  const top = addr(g.r0, g.c0);
  setCells(pageId, edits.length ? edits : [{ a: top, cell: sh.cells[top] }], t("sheet.h.merge"), (after) => {
    after.merges.push(rangeText(g));
    const c0 = after.cells[top] ?? (after.cells[top] = {});
    const s = styleIndex(after, { ...(after.styles[c0.s ?? 0] ?? {}), h: "center" });
    if (s) c0.s = s;
  });
}

// ───── sheets ─────

const BAD_NAME = /[[\]:*?/\\]/;

export function addSheet(afterPageId: string): string | null {
  const st = S();
  const page = findPage(st.doc, afterPageId);
  const sh = page?.sheet;
  if (!sh) return null;
  const pages = bookPages(st.doc, page!);
  const names = new Set(pages.map((p) => p.sheet!.name.toLowerCase()));
  let n = pages.length + 1;
  while (names.has(`sheet${n}`)) n++;
  const fresh: SheetData = {
    book: sh.book,
    name: `Sheet${n}`,
    cells: {},
    styles: [sh.styles[0] ?? {}],
    colW: {},
    rowH: {},
    defColW: sh.defColW,
    defRowH: sh.defRowH,
    merges: [],
    grid: true,
    headings: true,
    baseFont: sh.baseFont,
    baseSize: sh.baseSize,
    mdw: sh.mdw,
    lang: sh.lang,
    ...(sh.date1904 ? { date1904: true } : {}),
    ...(sh.names ? { names: { ...sh.names } } : {}),
  };
  const [np] = sheetPages([fresh], page!.source?.name ?? "", page!.source?.format ?? "xlsx");
  if (page!.source) np.source = { format: page!.source.format, name: page!.source.name };
  const last = pages[pages.length - 1];
  st.commit(t("sheet.h.addSheet"), (d) => {
    const i = d.pages.findIndex((p) => p.id === last.id);
    d.pages.splice(i + 1, 0, np as (typeof d.pages)[number]);
  });
  S().set({ pageId: np.id });
  return np.id;
}

/** Formula text with references to sheet `from` renamed to `to`. */
export function renameInFormula(f: string, from: string, to: string): string {
  return tokenize(f)
    .map((tk) => (tk.t === "ref" || tk.t === "id") && tk.sheet != null && tk.sheet.toLowerCase() === from.toLowerCase() ? sheetRef(to) + "!" + tk.s.slice(tk.s.lastIndexOf("!") + 1) : tk.s)
    .join("");
}

export function renameSheet(pageId: string, name: string): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  name = name.trim();
  if (!sh || !name || name === sh.name) return !!sh;
  if (name.length > 31 || BAD_NAME.test(name) || name.startsWith("'")) return void st.notify(t("sheet.badName")), false;
  const pages = bookPages(st.doc, page!);
  if (pages.some((p) => p.id !== pageId && p.sheet!.name.toLowerCase() === name.toLowerCase())) return void st.notify(t("sheet.dupName")), false;
  const from = sh.name;
  st.commit(t("sheet.h.rename"), (d) => {
    for (const p of pages) {
      const dp = draftPage(d, p.id);
      if (!dp?.sheet) continue;
      for (const c of Object.values(dp.sheet.cells)) if (c.f && c.f.includes("!")) c.f = renameInFormula(c.f, from, name);
      if (dp.sheet.names) for (const k of Object.keys(dp.sheet.names)) dp.sheet.names[k] = renameInFormula(dp.sheet.names[k], from, name);
      if (p.id === pageId) {
        dp.sheet.name = name;
        dp.name = name;
      }
    }
  });
  return true;
}

// ───── clipboard ─────

let lastCopy: { pageId: string; g: Rect; text: string } | null = null;

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** TSV and HTML of a range (shown texts, as Excel copies them). */
export function copyRange(pageId: string, g: Rect): { text: string; html: string } {
  const sh = findPage(S().doc, pageId)!.sheet!;
  const { rows } = sheetCells(sh, g);
  const text = rows.map((r) => r.map((c) => (/[\t\n"]/.test(c.text) ? `"${c.text.replace(/"/g, '""')}"` : c.text)).join("\t")).join("\r\n") + "\r\n";
  const html =
    "<table>" +
    rows
      .map(
        (r) =>
          "<tr>" +
          r
            .map((c) => {
              const style = [c.bold ? "font-weight:bold" : "", c.italic ? "font-style:italic" : "", c.color ? `color:${c.color}` : "", c.fill ? `background:${c.fill}` : "", c.align ? `text-align:${c.align.toLowerCase()}` : ""].filter(Boolean).join(";");
              return `<td${style ? ` style="${style}"` : ""}${c.colSpan ? ` colspan="${c.colSpan}"` : ""}${c.rowSpan ? ` rowspan="${c.rowSpan}"` : ""}>${escHtml(c.text)}</td>`;
            })
            .join("") +
          "</tr>",
      )
      .join("") +
    "</table>";
  lastCopy = { pageId, g, text };
  return { text, html };
}

function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"' && cur === "") q = true;
    else if (ch === "\t") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur);
    rows.push(row);
  }
  return rows;
}

function htmlTable(html: string): string[][] | null {
  if (!/<table/i.test(html) || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tb = doc.querySelector("table");
  if (!tb) return null;
  return Array.from(tb.querySelectorAll("tr")).map((tr) => Array.from(tr.querySelectorAll("td,th")).map((td) => (td.textContent ?? "").replace(/ /g, " ").trim()));
}

/** Paste at the active cell: a range copied here keeps formulas (moved) and formats; other text is typed in. */
export function paste(pageId: string, at: { r: number; c: number }, text: string, html?: string): Rect | null {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return null;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const styleCopies: { a: string; style: SheetStyle }[] = [];
  let area: Rect;
  if (lastCopy && text === lastCopy.text) {
    const src = findPage(st.doc, lastCopy.pageId)?.sheet;
    const g = lastCopy.g;
    if (!src) return null;
    const dr = at.r - g.r0, dc = at.c - g.c0;
    for (let r = g.r0; r <= g.r1; r++)
      for (let c = g.c0; c <= g.c1; c++) {
        const from = src.cells[addr(r, c)];
        const a = addr(r + dr, c + dc);
        if (r + dr > MAX_ROW || c + dc > MAX_COL) continue;
        const cell: SheetCell = {};
        if (from?.f) cell.f = shiftFormula(from.f, dr, dc);
        else if (from?.v !== undefined) {
          cell.v = from.v;
          if (from.t) cell.t = from.t;
        }
        edits.push({ a, cell });
        styleCopies.push({ a, style: src.styles[from?.s ?? 0] ?? {} });
      }
    area = { r0: at.r, c0: at.c, r1: at.r + g.r1 - g.r0, c1: at.c + g.c1 - g.c0 };
  } else {
    const grid = (html && htmlTable(html)) || parseTsv(text.replace(/\r?\n$/, ""));
    if (!grid.length) return null;
    for (let i = 0; i < grid.length; i++)
      for (let j = 0; j < grid[i].length; j++) {
        const a = addr(at.r + i, at.c + j);
        const old = sh.cells[a];
        const p = parseInput(grid[i][j], sh.styles[old?.s ?? 0] ?? {});
        const cell: SheetCell = old?.s ? { s: old.s } : {};
        if (p.f && !p.error) cell.f = p.f;
        else if (p.v !== undefined) cell.v = p.v;
        edits.push({ a, cell });
        if (p.fmt) styleCopies.push({ a, style: { ...(sh.styles[old?.s ?? 0] ?? {}), fmt: p.fmt } });
      }
    area = { r0: at.r, c0: at.c, r1: at.r + grid.length - 1, c1: at.c + Math.max(...grid.map((r) => r.length)) - 1 };
  }
  setCells(pageId, edits, t("sheet.h.paste"), (after) => {
    for (const { a, style } of styleCopies) {
      const c = after.cells[a] ?? (after.cells[a] = {});
      const s = styleIndex(after, style);
      if (s) c.s = s;
      else delete c.s;
    }
  });
  return area;
}

// ───── Omniweave: a range as a table on a document page ─────

export function sendToDocument(pageId: string, g: Rect) {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return;
  const u = usedRange(sh);
  const area = { r0: g.r0, c0: g.c0, r1: Math.min(g.r1, u.r1), c1: Math.min(g.c1, u.c1) };
  if (area.r1 < area.r0 || area.c1 < area.c0) return;
  const { rows, widths } = sheetCells(sh, area);
  const pages = tablePages(rows, `${sh.name} ${rangeText(area)}`, undefined, sh.name, widths);
  st.commit(t("sheet.h.toDoc"), (d) => {
    const i = d.pages.findIndex((p) => p.id === pageId);
    d.pages.splice(i + 1, 0, ...(pages as typeof d.pages));
  });
  S().set({ pageId: pages[0].id });
  S().notify(t("sheet.sentToDoc"));
}

// ───── keyboard helpers ─────

/** The data edge Ctrl+arrow goes to (Excel's End mode). */
export function dataEdge(sh: SheetData, r: number, c: number, dr: number, dc: number): { r: number; c: number } {
  const filled = (rr: number, cc: number) => {
    const x = sh.cells[addr(rr, cc)];
    return !!x && x.v !== undefined && x.v !== "";
  };
  const inside = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr <= MAX_ROW && cc <= MAX_COL;
  const u = usedRange(sh);
  const limitR = dr > 0 ? Math.max(u.r1, r) : 0, limitC = dc > 0 ? Math.max(u.c1, c) : 0;
  let rr = r + dr, cc = c + dc;
  if (!inside(rr, cc)) return { r, c };
  if (filled(r, c) && filled(rr, cc)) {
    while (inside(rr + dr, cc + dc) && filled(rr + dr, cc + dc)) {
      rr += dr;
      cc += dc;
    }
    return { r: rr, c: cc };
  }
  while (inside(rr, cc) && !filled(rr, cc)) {
    if ((dr > 0 && rr >= limitR) || (dc > 0 && cc >= limitC)) return dr > 0 ? { r: MAX_ROW, c } : dc > 0 ? { r, c: MAX_COL } : { r: rr, c: cc };
    if ((dr < 0 && rr === 0) || (dc < 0 && cc === 0)) return { r: rr, c: cc };
    rr += dr;
    cc += dc;
  }
  return inside(rr, cc) ? { r: rr, c: cc } : { r, c };
}

/** =SUM( … ) of the numbers above (or left of) a cell — AutoSum. */
export function autoSumFormula(sh: SheetData, r: number, c: number): string {
  const num = (rr: number, cc: number) => typeof sh.cells[addr(rr, cc)]?.v === "number";
  let r0 = r - 1;
  while (r0 >= 0 && num(r0, c)) r0--;
  if (r0 < r - 1) return `=SUM(${addr(r0 + 1, c)}:${addr(r - 1, c)})`;
  let c0 = c - 1;
  while (c0 >= 0 && num(r, c0)) c0--;
  if (c0 < c - 1) return `=SUM(${addr(r, c0 + 1)}:${addr(r, c - 1)})`;
  return "=SUM()";
}

/** Number formats of the Number group and Ctrl+Shift+1…6 (in the reader's locale). */
export function numberFormats(lng: SheetLang = lang()) {
  const cur = lng === "ko" ? '"₩"#,##0' : lng === "en" ? '"$"#,##0.00' : '"¥"#,##0';
  const acc = lng === "ko" ? '_-"₩"* #,##0_-;-"₩"* #,##0_-;_-"₩"* "-"_-;_-@_-' : lng === "en" ? '_("$"* #,##0.00_);_("$"* (#,##0.00);_("$"* "-"??_);_(@_)' : '_-"¥"* #,##0_-;-"¥"* #,##0_-;_-"¥"* "-"_-;_-@_-';
  return {
    general: "General",
    number: "#,##0.00",
    currency: cur,
    accounting: acc,
    shortDate: DATE_FMT[lng],
    longDate: lng === "ko" ? 'yyyy"년" m"월" d"일" dddd' : lng === "en" ? "dddd, mmmm d, yyyy" : 'yyyy"年"m"月"d"日"', // i18n: keep — format codes / character ranges
    time: lng === "en" ? "h:mm:ss AM/PM" : "h:mm:ss",
    percent: "0%",
    fraction: "# ?/?",
    scientific: "0.00E+00",
    text: "@",
  };
}

export { colLetters, rangeText };

// ───── keys shared with the global shortcuts (shell/shortcuts.ts) and the command search ─────

/** The current page is shown as a sheet grid (a sheet page in the document edit mode): Excel's keys win there. */
export function inSheetGrid(): boolean {
  const st = S();
  const p = st.doc.pages.find((x) => x.id === st.pageId);
  if (!p?.sheet) return false;
  return st.mode === "AUTO" || st.mode === "DOCUMENT";
}

/** Ctrl+PgUp / Ctrl+PgDn: the previous / next sheet of the workbook. */
export function switchSheet(dir: number) {
  const st = S();
  const p = st.doc.pages.find((x) => x.id === st.pageId);
  if (!p?.sheet) return;
  const tabs = bookPages(st.doc, p).filter((x) => !x.sheet!.hidden);
  const next = tabs[tabs.findIndex((x) => x.id === p.id) + dir];
  if (next) st.set({ pageId: next.id });
}

/** Ctrl+Shift+1…6 and Ctrl+Shift+` : Excel's number formats on the selection. */
export const NUMBER_KEYS: Record<string, keyof ReturnType<typeof numberFormats>> = { Digit1: "number", Digit2: "time", Digit3: "shortDate", Digit4: "currency", Digit5: "percent", Digit6: "scientific", Backquote: "general" };
export function applyNumberFormat(kind: keyof ReturnType<typeof numberFormats>) {
  const pageId = S().pageId;
  const f = numberFormats()[kind];
  formatRange(pageId, norm(selOf(pageId)), (st) => ({ ...st, fmt: f === "General" ? undefined : f }));
}