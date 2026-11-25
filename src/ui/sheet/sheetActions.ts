// Sheet editing (표 계산 편집): what the grid, the formula bar and the sheet ribbon do to a sheet page — typing into
// cells (Excel's input rules: numbers, percentages, dates, times, currency, TRUE/FALSE, 'text, =formulas), recalculating
// only what depends on the change, cell formats, merges, column widths, frozen panes, sheet tabs, clipboard and sending a
// range to a document page. Every change is one undo step (core/store commit).

import { create } from "zustand";
import { draftPage, findPage, useStore } from "../../core/store";
import type { SheetCell, SheetData, SheetStyle } from "../../core/sheetTypes";
import type { OmwDocument, Page } from "../../core/types";
import { t, useLang } from "../../i18n";
import { dataTableValues } from "../../io/sheet/dataTables";
import { produce, type Draft } from "immer";
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
  /** the other ranges of a multi-area selection (Ctrl+click / Ctrl+drag, 이동 옵션 results), before this one */
  more?: Rect[];
}
export const norm = (s: Sel): Rect => ({ r0: Math.min(s.r0, s.r1), c0: Math.min(s.c0, s.c1), r1: Math.max(s.r0, s.r1), c1: Math.max(s.c0, s.c1) });
export const one = (r: number, c: number): Sel => ({ ar: r, ac: c, r0: r, c0: c, r1: r, c1: c });

export const useSheetUI = create<{ sel: Record<string, Sel>; tick: number }>(() => ({ sel: {}, tick: 0 }));
export const selOf = (pageId: string): Sel => useSheetUI.getState().sel[pageId] ?? one(0, 0);
export const setSel = (pageId: string, s: Sel) => useSheetUI.setState((st) => ({ sel: { ...st.sel, [pageId]: s } }));
/** `g` and, when it is the page's selection, the selection's other areas (a multi-area selection acts on all of them) */
export function areasWith(pageId: string, g: Rect): Rect[] {
  const s = selOf(pageId);
  const m = norm(s);
  return s.more?.length && m.r0 === g.r0 && m.c0 === g.c0 && m.r1 === g.r1 && m.c1 === g.c1 ? [...s.more, g] : [g];
}
/** F4 (not typing): the last action again on the selection (Excel's 반복 — formats, inserted / deleted lines …) */
let lastAction: ((pageId: string) => void) | null = null;
export const setRepeat = (f: (pageId: string) => void) => void (lastAction = f);
export function repeatLast(pageId: string): boolean {
  if (!lastAction) return false;
  lastAction(pageId);
  return true;
}

/** 계산 옵션 ▸ 수동: the books whose formulas wait for F9 (지금 계산) since the last edit — the status bar says 계산 */
export const useCalcPending = create<{ books: Record<string, boolean> }>(() => ({ books: {} }));

/** F9 / 지금 계산: every formula of the page's book recalculated (in manual calculation too) */
export function calcNow(pageId: string) {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return;
  const pages = bookPages(st.doc, page);
  const sheets = pages.map((p) => JSON.parse(JSON.stringify(p.sheet)) as SheetData);
  const book = new Book(sheets);
  book.lang = lang();
  for (const ch of book.recalc()) applyChange(sheets[ch.sheet], ch);
  st.commit(t("sheetx.calc.h"), (d) => {
    pages.forEach((p, i) => {
      const dp = draftPage(d, p.id);
      if (dp) dp.sheet = sheets[i] as typeof dp.sheet;
    });
    refreshDataTables(d, page);
  });
  useCalcPending.setState((s) => ({ books: { ...s.books, [page.sheet!.book ?? page.id]: false } }));
}

/** 계산 옵션: 자동 (formulas follow every edit, recalculated now) or 수동 (they wait for F9) — the whole book */
export function setCalcManual(pageId: string, manual: boolean) {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return;
  const pages = bookPages(st.doc, page);
  st.commit(t("sheetx.calc.opts"), (d) => {
    for (const p of pages) {
      const dp = draftPage(d, p.id);
      if (!dp?.sheet) continue;
      if (manual) dp.sheet.calcManual = true;
      else delete dp.sheet.calcManual;
    }
  });
  if (!manual) calcNow(pageId);
}

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
  // 계산 옵션 ▸ 수동: only a formula just entered is worked out; what depends on the edit waits for F9 (Excel)
  const manual = !all && !!sheetAfter.calcManual;
  if (manual) useCalcPending.setState((s) => ({ books: { ...s.books, [sheetAfter.book ?? page.id]: true } }));
  const keys = all ? undefined : manual ? changed.filter((a) => sheetAfter.cells[a]?.f).map((a) => `${si}!${a}` as const) : book.dependents(changed.map((a) => ({ sheet: si, addr: a })));
  const out = book.recalc(keys);
  if (book.circular) S().notify(t("sheet.circular"));
  return out.map((ch) => ({ ...ch, pageId: pages[ch.sheet].id }));
}

/** Commit cell edits on one page with the recalculation they cause (one undo step). */
export function setCells(pageId: string, edits: { a: string; cell: SheetCell | undefined }[], label = t("sheet.h.edit"), extra?: (sh: SheetData) => void) {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet || !edits.length) return;
  // a protected sheet keeps its locked cells (검토 ▸ 시트 보호): Excel's message, nothing changed
  if (page.sheet.protect && edits.some((e) => isLocked(page.sheet!, e.a))) return void st.notify(t("sheetx.protect.locked"));
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
  const renames = tableRenames(after, edits.map((e) => e.a));
  st.commit(label, (d) => {
    const pg = draftPage(d, pageId);
    if (!pg?.sheet) return;
    if (extra) pg.sheet = after as typeof pg.sheet;
    else
      for (const e of edits) {
        if (cells[e.a]) pg.sheet.cells[e.a] = cells[e.a];
        else delete pg.sheet.cells[e.a];
      }
    // a table's header cell typed over: the column takes that name, and the formulas that used the old one follow
    for (const rn of renames) {
      const tb = pg.sheet.tables?.find((x) => x.name === rn.table);
      if (!tb) continue;
      tb.cols[rn.i] = rn.to;
      for (const p of bookPages(d as OmwDocument, pg as Page)) {
        const sh2 = draftPage(d, p.id)?.sheet;
        if (!sh2) continue;
        for (const c of Object.values(sh2.cells)) if (c.f && c.f.includes("[")) c.f = renameColumnRef(c.f, rn.table, rn.from, rn.to, p.id === pageId);
      }
    }
    for (const ch of changes) {
      const sh2 = draftPage(d, ch.pageId)?.sheet;
      if (sh2) applyChange(sh2 as SheetData, ch); // values, and the cells dynamic arrays spill into
    }
    // 데이터 표: worked out again from their inputs (not while calculation is manual)
    if (!after.calcManual) refreshDataTables(d, pg as Page);
  });
}

/** The book's data tables recalculated in the draft (their result cells take the values TABLE() gives now). */
function refreshDataTables(d: Draft<OmwDocument>, pg: Page) {
  const sheets = bookPages(d as OmwDocument, pg).map((p) => draftPage(d, p.id)?.sheet as SheetData | undefined);
  if (!sheets.some((s) => s && Object.values(s.cells).some((c) => c.dt))) return;
  const plain = sheets.map((s) => JSON.parse(JSON.stringify(s ?? null)) as SheetData);
  for (const u of dataTableValues(plain, lang())) {
    const sh = sheets[u.si];
    const c = sh?.cells[u.a];
    if (!sh) continue;
    if (c) {
      if (u.v === undefined) delete c.v;
      else c.v = u.v;
    } else if (u.v !== undefined) sh.cells[u.a] = { v: u.v };
  }
}

/** Header cells of Excel tables among the edited ones: the column names they give (unique in the table, 열N when empty). */
function tableRenames(sh: SheetData, edited: string[]): { table: string; i: number; from: string; to: string }[] {
  const out: { table: string; i: number; from: string; to: string }[] = [];
  for (const tb of sh.tables ?? []) {
    if (tb.noHeader) continue;
    const g = parseRange(tb.ref);
    if (!g) continue;
    const cols = [...tb.cols];
    for (const a of edited) {
      const p = parseAddr(a);
      if (!p || p.r !== g.r0 || p.c < g.c0 || p.c > g.c1) continue;
      const i = p.c - g.c0;
      const v = sh.cells[a]?.v;
      let name = v === undefined || v === null || v === "" ? t("sheetx.table.col", { n: i + 1 }) : String(v);
      const base = name;
      for (let k = 2; cols.some((c, j) => j !== i && c.toLowerCase() === name.toLowerCase()); k++) name = `${base}${k}`;
      if (name !== cols[i]) {
        out.push({ table: tb.name, i, from: cols[i], to: name });
        cols[i] = name;
      }
    }
  }
  return out;
}

/** Structured references to a renamed table column: 표1[이름] / [@이름] (on the table's own sheet) → the new name. */
function renameColumnRef(f: string, table: string, from: string, to: string, own: boolean): string {
  const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const q = esc(from);
  // 표1[이름], 표1[[#Headers],[이름]], 표1[@이름]
  let out = f.replace(new RegExp(`(${esc(table)}\\[(?:\\[[^\\]]*\\],\\s*)?\\[?@?)${q}(\\]?\\])`, "gi"), (_m, a: string, b: string) => `${a}${to}${b}`);
  // [@이름] inside the table (no table name)
  if (own) out = out.replace(new RegExp(`(^|[^\\w\\]])\\[@${q}\\]`, "gi"), (_m, a: string) => `${a}[@${to}]`);
  return out;
}

/** A cell of a protected sheet that may not change (locked, Excel's default). */
const isLocked = (sh: SheetData, a: string) => !sh.styles[sh.cells[a]?.s ?? 0]?.unlocked;

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
  if (page.sheet.protect && !page.sheet.protect.allow.includes("formatCells")) return void S().notify(t("sheetx.protect.locked"));
  const u = usedRange(page.sheet);
  const areas = areasWith(pageId, g).map((g) => ({ r0: g.r0, c0: g.c0, r1: Math.min(g.r1, Math.max(g.r0, u.r1 + 50)), c1: Math.min(g.c1, Math.max(g.c0, u.c1 + 20)) }));
  if (areas.reduce((n, area) => n + (area.r1 - area.r0 + 1) * (area.c1 - area.c0 + 1), 0) > 200000) return;
  setRepeat((p) => formatRange(p, norm(selOf(p)), patch, label));
  S().commit(label, (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    const memo = new Map<number, number>();
    for (const area of areas)
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
  // a line break typed (Alt+Enter) turns 텍스트 줄 바꿈 on, as Excel does
  const wrap = typeof p.v === "string" && p.v.includes("\n") && !st.wrap;
  setCells(pageId, [{ a, cell }], t("sheet.h.edit"), fmt || wrap ? (after) => {
    const c2 = after.cells[a] ?? (after.cells[a] = {});
    const s = styleIndex(after, { ...(after.styles[c2.s ?? 0] ?? {}), ...(fmt ? { fmt } : {}), ...(wrap ? { wrap: true } : {}) });
    if (s) c2.s = s;
  } : undefined);
  return true;
}

/** Ctrl+Enter: the entry typed goes into every cell of the selection (a formula's references moved for each, Excel). */
export function enterTextAll(pageId: string, g0: Rect, at: { r: number; c: number }, text: string): boolean {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return false;
  const p = parseInput(text, sh.styles[sh.cells[addr(at.r, at.c)]?.s ?? 0] ?? {});
  if (p.error) return void S().notify(t("sheet.badFormula")), false;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  for (const g of areasWith(pageId, g0))
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++)
    for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 500); c++) {
      const a = addr(r, c);
      const old = sh.cells[a];
      const cell: SheetCell = old?.s ? { s: old.s } : {};
      if (p.f !== undefined) cell.f = shiftFormula(p.f, r - at.r, c - at.c);
      else if (p.v !== undefined) cell.v = p.v;
      edits.push({ a, cell });
    }
  setCells(pageId, edits, t("sheet.h.edit"));
  return true;
}

export function clearRange(pageId: string, g: Rect) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const areas = areasWith(pageId, g);
  for (const [a, cell] of Object.entries(sh.cells)) {
    const p = parseAddr(a)!;
    if (!areas.some((g) => p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1)) continue;
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

/** 행 높이 자동 맞춤 (a row border double-clicked): each row fits its largest font and its lines again (Excel's AutoFit). */
export function fitRowHeights(pageId: string, rows: number[]) {
  S().commit(t("sheet.h.rowHeight"), (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    for (const r of rows) {
      let lines = 1, size = sh.baseSize;
      for (const [a, c] of Object.entries(sh.cells)) {
        if (parseAddr(a)?.r !== r) continue;
        lines = Math.max(lines, String(c.v ?? "").split("\n").length);
        size = Math.max(size, sh.styles[c.s ?? 0]?.size ?? sh.baseSize);
      }
      sh.rowH[r] = Math.max(sh.defRowH, Math.ceil(((size * 96) / 72) * 1.35 * lines + 2));
      (sh.rowAuto ??= {})[r] = true;
    }
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

/** 보기 ▸ 나누기: split the window at the active cell (the rows / columns shown above / left of it), or remove the split. */
export function toggleSplit(pageId: string, r: number, c: number, top: number, left: number) {
  S().commit(t("sheetx.split.h"), (d) => {
    const sh = draftPage(d, pageId)?.sheet;
    if (!sh) return;
    if (sh.split) return void delete sh.split;
    delete sh.freeze;
    let rows = Math.max(0, r - top), cols = Math.max(0, c - left);
    // at the top-left cell Excel splits the window in the middle
    if (!rows && !cols) (rows = 10), (cols = 4);
    sh.split = { rows, cols, top, left, row: top + rows, col: left + cols };
  });
}

/** The top / left pane of a split scrolled (view state: not an undo step). */
export function scrollSplit(pageId: string, dRows: number, dCols: number) {
  const st = S();
  st.set({
    doc: produce(st.doc, (d) => {
      const sp = draftPage(d, pageId)?.sheet?.split;
      if (!sp) return;
      sp.top = Math.max(0, sp.top + dRows);
      sp.left = Math.max(0, sp.left + dCols);
    }),
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
  if (sh.bookProtect) return void st.notify(t("sheetx.protect.bookLocked")), null;
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
  // a new workbook (no file behind it) stays without one: a source of no name made 내보내기 ▸ XLSX ask about the
  // original file it does not have (real-use sx-sheets)
  else delete np.source;
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
  if (sh.bookProtect) return void st.notify(t("sheetx.protect.bookLocked")), false;
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

/** `parts`: a multi-area copy — each source area and where it lands in the pasted block */
let lastCopy: { pageId: string; g: Rect; text: string; parts?: { g: Rect; br: number; bc: number }[] } | null = null;

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** TSV and HTML of a range (shown texts, as Excel copies them). */
/**
 * Ctrl+C of the selection: a multi-area selection is copied only when its areas share their rows or their columns
 * (Excel: they are put side by side / one under another); otherwise Excel's message and null.
 */
export function copySelection(pageId: string): { text: string; html: string; g: Rect; multi: boolean } | null {
  const g = norm(selOf(pageId));
  const areas = areasWith(pageId, g);
  if (areas.length === 1) return { ...copyRange(pageId, g), g, multi: false };
  const sameRows = areas.every((a) => a.r0 === areas[0].r0 && a.r1 === areas[0].r1);
  const sameCols = areas.every((a) => a.c0 === areas[0].c0 && a.c1 === areas[0].c1);
  if (!sameRows && !sameCols) return void S().notify(t("sheetx.multi.copyBad")), null;
  const sh = findPage(S().doc, pageId)!.sheet!;
  const blocks = [...areas].sort((a, b) => (sameRows ? a.c0 - b.c0 : a.r0 - b.r0)).map((a) => sheetCells(sh, a).rows);
  const rows = sameRows ? blocks[0].map((_, i) => blocks.flatMap((p) => p[i])) : blocks.flat();
  const text = rows.map((r) => r.map((c) => (/[\t\n"]/.test(c.text) ? `"${c.text.replace(/"/g, '""')}"` : c.text)).join("\t")).join("\r\n") + "\r\n";
  const html = "<table>" + rows.map((r) => "<tr>" + r.map((c) => `<td>${escHtml(c.text)}</td>`).join("") + "</tr>").join("") + "</table>";
  // the areas side by side / one under another: a paste moves each one's formulas and formats there (Excel)
  const sorted = [...areas].sort((a, b) => (sameRows ? a.c0 - b.c0 : a.r0 - b.r0));
  let off = 0;
  const parts = sorted.map((a) => {
    const p = { g: a, br: sameRows ? 0 : off, bc: sameRows ? off : 0 };
    off += sameRows ? a.c1 - a.c0 + 1 : a.r1 - a.r0 + 1;
    return p;
  });
  lastCopy = { pageId, g: sorted[0], text, parts };
  return { text, html, g, multi: true };
}

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
// ───── the copied range (Excel's marching ants) and 값만 붙여넣기 ─────

/** The range last copied / cut on a sheet: drawn with a moving dashed border until Esc or typing (Excel). */
export const useSheetClip = create<{ clip: { pageId: string; g: Rect; cut: boolean; text?: string; html?: string } | null }>(() => ({ clip: null }));
export const rememberCopy = (pageId: string, g: Rect, cut = false, text?: string, html?: string) => useSheetClip.setState({ clip: { pageId, g, cut, text, html } });
export const forgetCopy = () => useSheetClip.getState().clip && useSheetClip.setState({ clip: null });

/**
 * 값만 붙여넣기 (Excel Paste Special ▸ Values, Ctrl+Alt+V): the copied range's values — the results of its formulas,
 * no formulas, no formats — at `at`. Returns the area written, or null when nothing was copied on a sheet.
 */
export function pasteValues(pageId: string, at: { r: number; c: number }): Rect | null {
  const clip = useSheetClip.getState().clip;
  const src = clip && findPage(S().doc, clip.pageId)?.sheet;
  if (!clip || !src) return null;
  const rows: string[] = [];
  for (let r = clip.g.r0; r <= clip.g.r1; r++) {
    const line: string[] = [];
    for (let c = clip.g.c0; c <= clip.g.c1; c++) {
      const v = src.cells[addr(r, c)]?.v;
      const s = v === undefined || v === null ? "" : typeof v === "number" ? String(v) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v);
      // a text that would read as a formula stays text
      line.push(/^[=+@-]/.test(s) && typeof v !== "number" ? `'${s}` : /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    }
    rows.push(line.join("\t"));
  }
  return paste(pageId, at, rows.join("\r\n") + "\r\n", undefined, true);
}

/** 선택하여 붙여넣기 (Excel's Paste Special, Ctrl+Alt+V): what goes in, the operation, and the two check boxes. */
export type PasteWhat = "all" | "formulas" | "values" | "formats" | "comments" | "allExceptBorders" | "colWidths" | "formulasNumFmt" | "valuesNumFmt";
export type PasteOp = "none" | "add" | "sub" | "mul" | "div";
export interface PasteSpecialOpts {
  what: PasteWhat;
  op: PasteOp;
  skipBlanks: boolean;
  transpose: boolean;
}
const OP_CH: Record<Exclude<PasteOp, "none">, string> = { add: "+", sub: "-", mul: "*", div: "/" };
const applyOp = (op: Exclude<PasteOp, "none">, a: number, b: number) => (op === "add" ? a + b : op === "sub" ? a - b : op === "mul" ? a * b : a / b);

/**
 * 선택하여 붙여넣기: the copied range (on a sheet here) pasted at `at` as Excel's Paste Special does it — all, formulas,
 * values (formula results), formats, notes, all but borders, column widths, formulas / values with number formats;
 * an operation with the cells pasted on (add, subtract, multiply, divide), blanks skipped, rows and columns swapped.
 * Returns the area written, or null when nothing was copied on a sheet.
 */
export function pasteSpecial(pageId: string, at: { r: number; c: number }, o: PasteSpecialOpts): Rect | null {
  const clip = useSheetClip.getState().clip;
  const st = S();
  const src = clip && findPage(st.doc, clip.pageId)?.sheet;
  const sh = findPage(st.doc, pageId)?.sheet;
  if (!clip || !src || !sh) return null;
  const g = clip.g;
  const rows = g.r1 - g.r0 + 1, cols = g.c1 - g.c0 + 1;
  const area: Rect = { r0: at.r, c0: at.c, r1: Math.min(MAX_ROW, at.r + (o.transpose ? cols : rows) - 1), c1: Math.min(MAX_COL, at.c + (o.transpose ? rows : cols) - 1) };
  const content = ["all", "formulas", "values", "allExceptBorders", "formulasNumFmt", "valuesNumFmt"].includes(o.what);
  const keepFormula = o.what !== "values" && o.what !== "valuesNumFmt";
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const styles: { a: string; style: SheetStyle }[] = [];
  const notes: { a: string; from: string }[] = [];
  for (let r = g.r0; r <= g.r1; r++)
    for (let c = g.c0; c <= g.c1; c++) {
      const dr = o.transpose ? at.r + (c - g.c0) : at.r + (r - g.r0);
      const dc = o.transpose ? at.c + (r - g.r0) : at.c + (c - g.c0);
      if (dr > MAX_ROW || dc > MAX_COL) continue;
      const fa = addr(r, c), a = addr(dr, dc);
      const from = src.cells[fa];
      const blank = !from || (!from.f && (from.v === undefined || from.v === ""));
      // 내용 있는 셀만 붙여넣기; with an operation a blank counts as 0 and changes nothing
      if (blank && (o.skipBlanks || (content && o.op !== "none"))) continue;
      const old = sh.cells[a];
      const sStyle = src.styles[from?.s ?? 0] ?? {};
      const dStyle = sh.styles[old?.s ?? 0] ?? {};
      if (o.what === "comments") {
        if (src.notes?.[fa]) notes.push({ a, from: fa });
        continue;
      }
      if (o.what === "colWidths") continue;
      if (content) {
        const cell: SheetCell = old?.s ? { s: old.s } : {};
        if (from?.f && keepFormula) cell.f = shiftFormula(from.f, dr - r, dc - c);
        else if (from?.v !== undefined) {
          cell.v = from.v;
          if (from.t) cell.t = from.t;
        }
        // 연산: the number pasted with the one already there; a formula on either side gives a formula
        if (o.op !== "none") {
          const ch = OP_CH[o.op];
          const oldNum = typeof old?.v === "number" ? old.v : old?.v === undefined || old?.v === "" ? 0 : null;
          if (cell.f) cell.f = `${old?.f ? `(${old.f})` : String(oldNum ?? 0)}${ch}(${cell.f})`;
          else if (typeof cell.v === "number") {
            if (old?.f) {
              cell.f = `(${old.f})${ch}${cell.v}`;
              delete cell.v;
            } else if (oldNum != null) {
              if (o.op === "div" && cell.v === 0) {
                cell.f = `${oldNum}/0`;
                delete cell.v;
              } else cell.v = applyOp(o.op, oldNum, cell.v);
            }
          }
        }
        edits.push({ a, cell });
      } else if (o.what === "formats") edits.push({ a, cell: old ? { ...old } : {} });
      if (o.what === "all" || o.what === "formats") styles.push({ a, style: sStyle });
      else if (o.what === "allExceptBorders") styles.push({ a, style: { ...sStyle, bl: dStyle.bl, br: dStyle.br, bt: dStyle.bt, bb: dStyle.bb } });
      else if (o.what === "formulasNumFmt" || o.what === "valuesNumFmt") styles.push({ a, style: { ...dStyle, fmt: sStyle.fmt } });
    }
  const label = t("sheet.h.paste");
  if (o.what === "comments" || o.what === "colWidths") {
    if (o.what === "comments" && !notes.length) return null;
    st.commit(label, (d) => {
      const pg = draftPage(d, pageId);
      if (!pg?.sheet) return;
      for (const n of notes) (pg.sheet.notes ??= {})[n.a] = { ...src.notes![n.from] };
      if (o.what === "colWidths")
        for (let c = g.c0; c <= g.c1; c++) {
          const dc = at.c + (c - g.c0);
          if (dc > MAX_COL) continue;
          if (src.colW[c] != null) pg.sheet.colW[dc] = src.colW[c];
          else delete pg.sheet.colW[dc];
        }
    });
    return area;
  }
  if (!edits.length) return null;
  setCells(pageId, edits, label, (after) => {
    for (const { a, style } of styles) {
      const c = after.cells[a] ?? (after.cells[a] = {});
      const s = styleIndex(after, style);
      if (s) c.s = s;
      else delete c.s;
    }
  });
  return area;
}

/** The clipboard written with both the text and the sheet's HTML (formulas and formats for a paste here). */
export function writeSheetClipboard(text: string, html: string) {
  try {
    const C = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (C && navigator.clipboard?.write) {
      void navigator.clipboard.write([new C({ "text/plain": new Blob([text], { type: "text/plain" }), "text/html": new Blob([html], { type: "text/html" }) })]).catch(() => navigator.clipboard?.writeText(text));
      return;
    }
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard not available */
  }
}

/** 잘라내기 / 복사 from the cell menu (as Ctrl+X / Ctrl+C on the grid). */
export function copyFromMenu(pageId: string, g: Rect, cut: boolean) {
  const s = selOf(pageId);
  if (s.more?.length && cut) return void S().notify(t("sheetx.multi.copyBad"));
  const cp = s.more?.length ? copySelection(pageId) : { ...copyRange(pageId, g) };
  if (!cp) return;
  const { text, html } = cp;
  writeSheetClipboard(text, html);
  // a cut range stays where it is until it is pasted (Excel: the moving border, then the move)
  rememberCopy(pageId, g, cut, text, html);
}

/** 붙여넣기 from the cell menu: what was copied on a sheet here, else the system clipboard's text. */
export async function pasteFromMenu(pageId: string, at: { r: number; c: number }): Promise<Rect | null> {
  const c = useSheetClip.getState().clip;
  if (c?.text !== undefined) {
    return paste(pageId, at, c.text, c.html);
  }
  try {
    const text = await navigator.clipboard.readText();
    return text ? paste(pageId, at, text) : null;
  } catch {
    return null;
  }
}
/** `plain`: the text is typed in as values even when it is what was last copied here (값만 붙여넣기). */
export function paste(pageId: string, at: { r: number; c: number }, text: string, html?: string, plain = false): Rect | null {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return null;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const styleCopies: { a: string; style: SheetStyle }[] = [];
  let area: Rect;
  const clip = useSheetClip.getState().clip;
  // the paste of a cut (Ctrl+X): the cells move — formulas keep their references, the cut cells are emptied
  const cut = !plain && !!lastCopy && text === lastCopy.text && !!clip?.cut && clip.pageId === lastCopy.pageId;
  let cutFrom: { pageId: string; g: Rect } | null = null;
  if (!plain && lastCopy && text === lastCopy.text) {
    const src = findPage(st.doc, lastCopy.pageId)?.sheet;
    const g = lastCopy.g;
    if (!src) return null;
    if (cut) cutFrom = { pageId: lastCopy.pageId, g };
    const parts = lastCopy.parts ?? [{ g, br: 0, bc: 0 }];
    let bh = 0, bw = 0;
    for (const part of parts) {
    const pg0 = part.g;
    const dr = at.r + part.br - pg0.r0, dc = at.c + part.bc - pg0.c0;
    bh = Math.max(bh, part.br + pg0.r1 - pg0.r0 + 1);
    bw = Math.max(bw, part.bc + pg0.c1 - pg0.c0 + 1);
    for (let r = pg0.r0; r <= pg0.r1; r++)
      for (let c = pg0.c0; c <= pg0.c1; c++) {
        const from = src.cells[addr(r, c)];
        const a = addr(r + dr, c + dc);
        if (r + dr > MAX_ROW || c + dc > MAX_COL) continue;
        const cell: SheetCell = {};
        if (from?.f) cell.f = cut ? from.f : shiftFormula(from.f, dr, dc);
        else if (from?.v !== undefined) {
          cell.v = from.v;
          if (from.t) cell.t = from.t;
        }
        edits.push({ a, cell });
        styleCopies.push({ a, style: src.styles[from?.s ?? 0] ?? {} });
      }
    }
    area = { r0: at.r, c0: at.c, r1: at.r + bh - 1, c1: at.c + bw - 1 };
    // the cut cells outside where they land are emptied in the same step (same sheet: one undo)
    if (cut && lastCopy.pageId === pageId)
      for (let r = g.r0; r <= g.r1; r++)
        for (let c = g.c0; c <= g.c1; c++) if (!(r >= area.r0 && r <= area.r1 && c >= area.c0 && c <= area.c1)) edits.push({ a: addr(r, c), cell: undefined });
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
  if (cutFrom) {
    forgetCopy();
    lastCopy = null;
    // cut on another sheet: emptied there after the paste
    if (cutFrom.pageId !== pageId) clearRange(cutFrom.pageId, cutFrom.g);
  }
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
  // a number, a formula (its result may not be worked out yet) or numeric text counts, as Excel's AutoSum reads it;
  // only numbers typed as values counted before, so the range stopped at the first formula (=SUM(C5:C5), QA 2026-11-24)
  const num = (rr: number, cc: number) => {
    const x = sh.cells[addr(rr, cc)];
    return !!x && (typeof x.v === "number" || !!x.f || (typeof x.v === "string" && x.v.trim() !== "" && !isNaN(Number(x.v))));
  };
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

// ───── 서식 복사 (Format Painter) · 셀 스타일 ─────

/** 서식 복사: the formats of the range picked (its pattern tiles the target); `keep` = double-clicked, stays on. */
export const useFormatPainter = create<{ src: { pageId: string; g: Rect } | null; keep: boolean }>(() => ({ src: null, keep: false }));

/** The painter's formats onto `to` (the source range's styles repeated over it), one undo step. */
export function paintFormats(pageId: string, to: Rect): boolean {
  const { src, keep } = useFormatPainter.getState();
  if (!src) return false;
  const st = S();
  const from = findPage(st.doc, src.pageId)?.sheet;
  const sh = findPage(st.doc, pageId)?.sheet;
  if (!from || !sh) return false;
  const h = src.g.r1 - src.g.r0 + 1, w = src.g.c1 - src.g.c0 + 1;
  // a single cell picked as the target takes the whole pattern (Excel)
  const g = to.r0 === to.r1 && to.c0 === to.c1 ? { ...to, r1: to.r0 + h - 1, c1: to.c0 + w - 1 } : to;
  const looks: { a: string; style: SheetStyle }[] = [];
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++)
    for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 500); c++) {
      const sa = addr(src.g.r0 + ((r - g.r0) % h), src.g.c0 + ((c - g.c0) % w));
      looks.push({ a: addr(r, c), style: from.styles[from.cells[sa]?.s ?? 0] ?? {} });
    }
  st.commit(t("sheetx.painter.h"), (d) => {
    const s2 = draftPage(d, pageId)?.sheet;
    if (!s2) return;
    for (const { a, style } of looks) {
      const s = styleIndex(s2 as SheetData, style);
      const cell = s2.cells[a];
      if (cell) {
        if (s) cell.s = s;
        else delete cell.s;
        if (!cell.s && cell.v === undefined && !cell.f) delete s2.cells[a];
      } else if (s) s2.cells[a] = { s };
    }
  });
  if (!keep) useFormatPainter.setState({ src: null });
  return true;
}

/** 셀 스타일: Excel's built-in cell styles as formats (좋음 · 나쁨 · 보통, 제목, 합계, 강조색 …). */
export const CELL_STYLES: { id: string; style: SheetStyle }[] = [
  { id: "normal", style: {} },
  { id: "good", style: { fill: "#C6EFCE", color: "#006100" } },
  { id: "bad", style: { fill: "#FFC7CE", color: "#9C0006" } },
  { id: "neutral", style: { fill: "#FFEB9C", color: "#9C5700" } },
  { id: "title", style: { size: 18, color: "#44546A" } },
  { id: "h1", style: { size: 15, bold: true, color: "#44546A", bb: { style: "thick", color: "#4472C4" } } },
  { id: "h2", style: { size: 13, bold: true, color: "#44546A", bb: { style: "thick", color: "#A9C4EB" } } },
  { id: "total", style: { bold: true, bt: { style: "thin", color: "#4472C4" }, bb: { style: "double", color: "#4472C4" } } },
  { id: "note", style: { fill: "#FFFFCC", bl: { style: "thin", color: "#B2B2B2" }, br: { style: "thin", color: "#B2B2B2" }, bt: { style: "thin", color: "#B2B2B2" }, bb: { style: "thin", color: "#B2B2B2" } } },
  { id: "warning", style: { color: "#FF0000" } },
  { id: "calc", style: { fill: "#F2F2F2", color: "#FA7D00", bold: true, bl: { style: "thin", color: "#7F7F7F" }, br: { style: "thin", color: "#7F7F7F" }, bt: { style: "thin", color: "#7F7F7F" }, bb: { style: "thin", color: "#7F7F7F" } } },
  { id: "accent1", style: { fill: "#4472C4", color: "#FFFFFF" } },
  { id: "accent2", style: { fill: "#ED7D31", color: "#FFFFFF" } },
  { id: "accent6", style: { fill: "#70AD47", color: "#FFFFFF" } },
];

/** A cell style applied to the range (표준 takes every format off, keeping the number format). */
export function applyCellStyle(pageId: string, g: Rect, id: string) {
  const cs = CELL_STYLES.find((x) => x.id === id);
  if (!cs) return;
  formatRange(pageId, g, (s) => (id === "normal" ? { ...(s.fmt ? { fmt: s.fmt } : {}) } : { ...s, ...cs.style }));
}
