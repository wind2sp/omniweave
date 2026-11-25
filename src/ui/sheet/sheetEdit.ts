// Sheet editing, stage 2 (표 계산 편집 2단계): inserting / deleting rows and columns, fill (handle, Ctrl+D / Ctrl+R),
// sort, AutoFilter, find & replace, notes and data validation — as commands on a sheet page, each one undo step.
// The rules themselves live in io/sheet (structure.ts, fill.ts, sortFilter.ts); this file applies them to the
// document and keeps the dialogs' state (ui/sheet/SheetDialogs.tsx draws them).

import { create } from "zustand";
import { draftPage, findPage, useStore } from "../../core/store";
import type { SheetCell, SheetCustomFilter, SheetData, SheetFilter, SheetValidation } from "../../core/sheetTypes";
import type { Page } from "../../core/types";
import { t } from "../../i18n";
import { applyChange, Book } from "../../io/sheet/calc";
import { fillEdits, type FillMode } from "../../io/sheet/fill";
import { addr, MAX_COL, MAX_ROW, parseAddr, parseRange, tokenize, type Rect } from "../../io/sheet/formula";
import { currentRegion, filterHiddenRows, filterRangeAt, findAll, findNext, guessHeader, replaceText, searchText, shownText, sortEdits, type FindOpts, type SortKey } from "../../io/sheet/sortFilter";
import { usedRange } from "../../io/sheet/pages";
import { sheetFilters } from "../../io/sheet/filters";
import { applyStructToBook, insertWouldLoseData, type StructOp } from "../../io/sheet/structure";
import { bookPages, lang, norm, parseInput, selOf, setCells, setRepeat, setSel, type Sel } from "./sheetActions";

const S = () => useStore.getState();

// ───── dialogs and popups of the grid ─────

export type SheetDlg =
  | { kind: "find"; replace: boolean }
  | { kind: "sort" }
  | { kind: "insert" | "delete" }
  | { kind: "note"; a: string }
  | { kind: "filter"; col: number; table?: string; x: number; y: number }
  | { kind: "customFilter"; col: number; table?: string; op: string; text: boolean }
  | { kind: "list"; r: number; c: number; x: number; y: number }
  | { kind: "invalid"; v: SheetValidation; retry: () => void; accept: () => void; cancel: () => void }
  | { kind: "menu"; x: number; y: number; head: "col" | "row" | null }
  // Excel's dialogs of the ribbon tabs (ui/sheet/SheetFeatureDialogs.tsx)
  | { kind: "fmt"; tab?: "number" | "align" | "font" | "border" | "fill" | "protect" }
  | { kind: "cond"; type: string; edit?: { b: number; r: number } }
  | { kind: "condMgr" }
  | { kind: "valid" }
  | { kind: "dedupe" }
  | { kind: "split" }
  | { kind: "link" }
  | { kind: "protect" }
  | { kind: "unprotect" }
  | { kind: "book" }
  | { kind: "page"; tab?: "page" | "margins" | "hf" | "sheet" }
  | { kind: "name"; edit?: string; from?: "names" }
  | { kind: "names" }
  | { kind: "chart"; i: number }
  | { kind: "pivot" }
  | { kind: "fn" }
  | { kind: "pasteSpecial" }
  | { kind: "table"; style?: string }
  | { kind: "group"; ungroup?: boolean }
  | { kind: "subtotal" }
  | { kind: "goalSeek" }
  | { kind: "goTo" }
  | { kind: "goSpecial" }
  | { kind: "moveCopy"; pageId: string }
  | { kind: "series" }
  | { kind: "evalFormula" }
  | { kind: "consol" }
  | { kind: "scenarios" }
  | { kind: "scenarioEdit"; i?: number }
  | { kind: "dataTable" }
  | { kind: "customLists" }
  | { kind: "thread"; a: string }
  | { kind: "errCheck" }
  | { kind: "slicer" }
  | { kind: "spark"; type: "line" | "column" | "stacked" }
  | { kind: "chartMenu"; i: number; x: number; y: number };

export const useSheetDlg = create<{ dlg: SheetDlg | null }>(() => ({ dlg: null }));
export const openDlg = (dlg: SheetDlg | null) => useSheetDlg.setState({ dlg });

const curPage = (): Page | undefined => {
  const st = S();
  return st.doc.pages.find((p) => p.id === st.pageId && p.sheet);
};

// ───── rows / columns ─────

/** Recalculate every formula of a book (after cells moved) and write the values into the sheets (mutates). */
function recalcAll(sheets: SheetData[]) {
  const book = new Book(sheets);
  book.lang = lang();
  for (const ch of book.recalc()) applyChange(sheets[ch.sheet], ch); // values, and the cells dynamic arrays spill into
  if (book.circular) S().notify(t("sheet.circular"));
}

/** Insert (n > 0) or delete (n < 0) whole rows / columns of a sheet page, with every reference in the book moved. */
export function changeLines(pageId: string, op: StructOp, label = op.n > 0 ? t("sheet.h.insert") : t("sheet.h.delete")): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  const pages = bookPages(st.doc, page);
  const ti = pages.findIndex((p) => p.id === pageId);
  if (insertWouldLoseData(page.sheet, op)) {
    st.notify(t("sheet.insertLoses"));
    return false;
  }
  const sheets = pages.map((p) => JSON.parse(JSON.stringify(p.sheet)) as SheetData);
  applyStructToBook(sheets, ti, op);
  sheets[ti].struct = [...(sheets[ti].struct ?? []), op];
  recalcAll(sheets);
  st.commit(label, (d) => {
    pages.forEach((p, i) => {
      const dp = draftPage(d, p.id);
      if (dp) dp.sheet = sheets[i] as typeof dp.sheet;
    });
  });
  return true;
}

/**
 * Several changes to a book in one undo step: `f` gets copies of the book's sheets (and the page's index among them),
 * inserts / deletes lines with `lines` (every reference moved) and edits cells; formulas are recalculated after it.
 * `f` returning false drops the change.
 */
export function bookEdit(pageId: string, label: string, f: (sheets: SheetData[], ti: number, lines: (op: StructOp) => void) => boolean | void): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  const pages = bookPages(st.doc, page);
  const ti = pages.findIndex((p) => p.id === pageId);
  const sheets = pages.map((p) => JSON.parse(JSON.stringify(p.sheet)) as SheetData);
  const lines = (op: StructOp) => {
    applyStructToBook(sheets, ti, op);
    sheets[ti].struct = [...(sheets[ti].struct ?? []), op];
  };
  if (f(sheets, ti, lines) === false) return false;
  recalcAll(sheets);
  st.commit(label, (d) => {
    pages.forEach((p, i) => {
      const dp = draftPage(d, p.id);
      if (dp) dp.sheet = sheets[i] as typeof dp.sheet;
    });
  });
  return true;
}

/**
 * 셀 삽입 / 셀 삭제 that shifts cells: down / right (insert) or up / left (delete) — only the cells in the selection's
 * columns (rows) move, with the references into them; the rows and columns themselves stay (Excel). Refused, as in
 * Excel, when it would cut a merged cell or a table in two, or push data off the sheet.
 */
export function shiftCells(pageId: string, g: Rect, dir: "down" | "right" | "up" | "left"): boolean {
  const st = S();
  const sh = findPage(st.doc, pageId)?.sheet;
  if (!sh) return false;
  const rows = g.r1 - g.r0 + 1, cols = g.c1 - g.c0 + 1;
  const op: StructOp =
    dir === "down" ? { axis: "row", at: g.r0, n: rows, band: [g.c0, g.c1] } :
    dir === "up" ? { axis: "row", at: g.r0, n: -rows, band: [g.c0, g.c1] } :
    dir === "right" ? { axis: "col", at: g.c0, n: cols, band: [g.r0, g.r1] } :
    { axis: "col", at: g.c0, n: -cols, band: [g.r0, g.r1] };
  // the block that moves: from the selection to the sheet's end, in the band
  const moving: Rect = op.axis === "row" ? { r0: g.r0, r1: MAX_ROW, c0: g.c0, c1: g.c1 } : { r0: g.r0, r1: g.r1, c0: g.c0, c1: MAX_COL };
  const cuts = (x: Rect) => !(x.r1 < moving.r0 || x.r0 > moving.r1 || x.c1 < moving.c0 || x.c0 > moving.c1) && !(op.axis === "row" ? x.c0 >= g.c0 && x.c1 <= g.c1 : x.r0 >= g.r0 && x.r1 <= g.r1);
  if (sh.merges.some((m) => { const x = parseRange(m); return !!x && cuts(x); })) return void st.notify(t("sheetx.cells.merged")), false;
  if ((sh.tables ?? []).some((tb) => { const x = parseRange(tb.ref); return !!x && cuts(x); })) return void st.notify(t("sheetx.cells.table")), false;
  if (insertWouldLoseData(sh, op)) return void st.notify(t("sheet.insertLoses")), false;
  // (not recorded in `struct`: the save writes the moved cells as cell changes)
  return bookEdit(pageId, op.n > 0 ? t("sheet.h.insert") : t("sheet.h.delete"), (sheets, ti) => {
    applyStructToBook(sheets, ti, op);
  });
}

/** Insert / delete for the selection: whole rows or columns when they are selected, else `axis` (the dialog's choice). */
export function insertOrDelete(pageId: string, del: boolean, axis?: "row" | "col"): boolean {
  const s = selOf(pageId);
  const g = norm(s);
  const rows = g.c0 === 0 && g.c1 === MAX_COL, cols = g.r0 === 0 && g.r1 === MAX_ROW;
  const ax = axis ?? (rows && !cols ? "row" : cols && !rows ? "col" : null);
  if (!ax) {
    openDlg({ kind: del ? "delete" : "insert" });
    return false;
  }
  const at = ax === "row" ? g.r0 : g.c0;
  const n = ax === "row" ? g.r1 - g.r0 + 1 : g.c1 - g.c0 + 1;
  if (n > (ax === "row" ? MAX_ROW : MAX_COL)) return false;
  const ok = changeLines(pageId, { axis: ax, at, n: del ? -n : n });
  // F4: the same insertion / deletion at the selection then (as many lines as it spans)
  if (ok)
    setRepeat((p) => {
      const q = norm(selOf(p));
      const k = ax === "row" ? q.r1 - q.r0 + 1 : q.c1 - q.c0 + 1;
      changeLines(p, { axis: ax, at: ax === "row" ? q.r0 : q.c0, n: del ? -k : k });
    });
  if (ok && del) {
    // the selection stays where it was (the lines after it moved up)
    setSel(pageId, s);
  }
  return ok;
}

// ───── fill ─────

export function fill(pageId: string, src: Rect, dest: Rect, mode: FillMode = "auto", ctrl = false) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const edits = fillEdits(sh, src, dest, mode, ctrl);
  if (edits.length) setCells(pageId, edits, t("sheet.h.fill"));
}

/** Ctrl+D / Ctrl+R (and Fill › Down / Right / Up / Left): the first row (column) of the selection copied over the rest; a single row takes the one above. */
export function fillDir(pageId: string, dir: "down" | "right" | "up" | "left") {
  const g = norm(selOf(pageId));
  if (dir === "down" || dir === "up") {
    if (g.r0 === g.r1) {
      if (dir === "down" && g.r0 > 0) fill(pageId, { ...g, r0: g.r0 - 1, r1: g.r0 - 1 }, { ...g, r0: g.r0 - 1 }, "copy");
      if (dir === "up" && g.r1 < MAX_ROW) fill(pageId, { ...g, r0: g.r1 + 1, r1: g.r1 + 1 }, { ...g, r1: g.r1 + 1 }, "copy");
      return;
    }
    const srcRow = dir === "down" ? g.r0 : g.r1;
    return fill(pageId, { ...g, r0: srcRow, r1: srcRow }, g, "copy");
  }
  if (g.c0 === g.c1) {
    if (dir === "right" && g.c0 > 0) fill(pageId, { ...g, c0: g.c0 - 1, c1: g.c0 - 1 }, { ...g, c0: g.c0 - 1 }, "copy");
    if (dir === "left" && g.c1 < MAX_COL) fill(pageId, { ...g, c0: g.c1 + 1, c1: g.c1 + 1 }, { ...g, c1: g.c1 + 1 }, "copy");
    return;
  }
  const srcCol = dir === "right" ? g.c0 : g.c1;
  fill(pageId, { ...g, c0: srcCol, c1: srcCol }, g, "copy");
}

// ───── sort / filter ─────

/** The range a sort works on: the selection when it is a range, else the current region (the AutoFilter range inside one). */
export function sortArea(sh: SheetData, sel: Sel): Rect {
  const g = norm(sel);
  if (sh.filter) {
    const f = parseRange(sh.filter.ref)!;
    if (sel.ar >= f.r0 && sel.ar <= f.r1 && sel.ac >= f.c0 && sel.ac <= f.c1) return f;
  }
  if (g.r0 !== g.r1 || g.c0 !== g.c1) {
    const u = usedRange(sh);
    return { ...g, r1: Math.max(g.r0, Math.min(g.r1, u.r1)), c1: Math.max(g.c0, Math.min(g.c1, u.c1)) };
  }
  return currentRegion(sh, sel.ar, sel.ac);
}

export function sortRange(pageId: string, g: Rect, keys: SortKey[], header: boolean) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const edits = sortEdits(sh, g, keys, header);
  if (!edits) return S().notify(t("sheet.sortMerged"));
  if (!edits.length) return;
  setCells(pageId, edits, t("sheet.h.sort"), sh.filter ? (after) => applyFilterRows(after) : undefined);
}

/** Sort A→Z / Z→A by the active column (the Data / Home buttons). */
export function quickSort(pageId: string, desc: boolean) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const sel = selOf(pageId);
  const g = sortArea(sh, sel);
  const header = sh.filter && parseRange(sh.filter.ref)!.r0 === g.r0 ? true : guessHeader(sh, g);
  sortRange(pageId, g, [{ col: sel.ac, desc }], header);
}

/** Rows the filters hide (the sheet's and the tables'), written into hiddenRows (rows of their ranges shown again first). */
function applyFilterRows(sh: SheetData) {
  const fs = sheetFilters(sh);
  if (!fs.length) return;
  const areas = fs.map((x) => parseRange(x.f.ref)!).filter(Boolean);
  const keep = (sh.hiddenRows ?? []).filter((r) => !areas.some((g) => r > g.r0 && r <= g.r1));
  const hide = fs.flatMap((x) => filterHiddenRows(sh, x.f, lang()));
  const all = [...new Set([...keep, ...hide])].sort((a, b) => a - b);
  if (all.length) sh.hiddenRows = all;
  else delete sh.hiddenRows;
}

/** Ctrl+Shift+L: AutoFilter on (for the current region) or off (every row shown). */
export function toggleFilter(pageId: string) {
  const st = S();
  const sh = findPage(st.doc, pageId)?.sheet;
  if (!sh) return;
  const sel = selOf(pageId);
  st.commit(t("sheet.h.filter"), (d) => {
    const s2 = draftPage(d, pageId)?.sheet as SheetData | undefined;
    if (!s2) return;
    if (s2.filter) {
      const g = parseRange(s2.filter.ref)!;
      if (s2.filter.cols && Object.keys(s2.filter.cols).length) {
        s2.hiddenRows = (s2.hiddenRows ?? []).filter((r) => r <= g.r0 || r > g.r1);
        if (!s2.hiddenRows.length) delete s2.hiddenRows;
      }
      delete s2.filter;
      return;
    }
    const g = filterRangeAt(s2, sel.ar, sel.ac, norm(sel));
    s2.filter = { ref: g.r0 === g.r1 && g.c0 === g.c1 ? addr(g.r0, g.c0) + ":" + addr(g.r0 + 1, g.c0) : `${addr(g.r0, g.c0)}:${addr(g.r1, g.c1)}` };
  });
}

/** Set (vals) or clear (null) the value filter of one filter column. */
export function setFilterColumn(pageId: string, col: number, vals: string[] | null, blank = false, table?: string) {
  S().commit(t("sheet.h.filter"), (d) => {
    const sh = draftPage(d, pageId)?.sheet as SheetData | undefined;
    const tb = table ? sh?.tables?.find((x) => x.name === table) : undefined;
    const cur = table ? tb?.filter : sh?.filter;
    if (!sh || !cur) return;
    const cols = { ...(cur.cols ?? {}) };
    if (vals) cols[col] = { vals, ...(blank ? { blank: true } : {}) };
    else delete cols[col];
    const next = { ...cur, cols };
    if (!Object.keys(cols).length) delete (next as { cols?: unknown }).cols;
    if (tb) tb.filter = next;
    else sh.filter = next;
    applyFilterRows(sh);
  });
}

/** 숫자 필터 · 텍스트 필터: a column's conditions (null = none), the sheet's AutoFilter or a table's. */
export function setFilterCustom(pageId: string, col: number, custom: SheetCustomFilter | null, table?: string) {
  S().commit(t("sheet.h.filter"), (d) => {
    const sh = draftPage(d, pageId)?.sheet as SheetData | undefined;
    const tb = table ? sh?.tables?.find((x) => x.name === table) : undefined;
    const cur = table ? tb?.filter : sh?.filter;
    if (!sh || !cur) return;
    const cols = { ...(cur.cols ?? {}) };
    if (custom) cols[col] = { custom };
    else delete cols[col];
    const next: SheetFilter = { ...cur, cols };
    if (!Object.keys(cols).length) delete next.cols;
    if (tb) tb.filter = next;
    else sh.filter = next;
    applyFilterRows(sh);
  });
}

// ───── find / replace ─────

export const useFind = create<{ q: string; by: string; opts: FindOpts; found: string[] | null }>(() => ({ q: "", by: "", opts: { lookIn: "formulas" }, found: null }));

/** Within the selection when it is a range, else the whole sheet. */
const findScope = (sel: Sel): Rect | undefined => {
  const g = norm(sel);
  return g.r0 !== g.r1 || g.c0 !== g.c1 ? g : undefined;
};

export function doFindNext(pageId: string, back = false): boolean {
  const sh = findPage(S().doc, pageId)?.sheet;
  const { q, opts } = useFind.getState();
  if (!sh || (!q && !opts.format)) return false;
  const sel = selOf(pageId);
  const scope = findScope(sel);
  const a = findNext(sh, q, opts, lang(), { r: sel.ar, c: sel.ac }, back, scope);
  if (!a) {
    S().notify(t("sheet.find.none"));
    return false;
  }
  const p = parseAddr(a)!;
  setSel(pageId, scope ? { ...sel, ar: p.r, ac: p.c } : { ar: p.r, ac: p.c, r0: p.r, c0: p.c, r1: p.r, c1: p.c });
  return true;
}

export function doFindAll(pageId: string) {
  const sh = findPage(S().doc, pageId)?.sheet;
  const { q, opts } = useFind.getState();
  if (!sh || (!q && !opts.format)) return;
  const found = findAll(sh, q, opts, lang(), findScope(selOf(pageId)));
  useFind.setState({ found });
  if (!found.length) S().notify(t("sheet.find.none"));
}

/** The edit that replaces the matches in one cell (null when nothing matches). */
function replaceCell(sh: SheetData, a: string, q: string, by: string, opts: FindOpts): { a: string; cell: SheetCell | undefined } | null {
  const cell = sh.cells[a];
  if (!cell) return null;
  const o = { ...opts, lookIn: "formulas" as const };
  const text = searchText(sh, cell, o, lang());
  const next = replaceText(text, q, by, o);
  if (next === text) return null;
  const p = parseInput(next, sh.styles[cell.s ?? 0] ?? {});
  const out: SheetCell = cell.s ? { s: cell.s } : {};
  if (p.f && !p.error) out.f = p.f;
  else if (p.v !== undefined) out.v = p.v;
  return { a, cell: out };
}

/** Replace in the active cell when it matches, then go to the next match (Excel's Replace button). */
export function doReplace(pageId: string) {
  const sh = findPage(S().doc, pageId)?.sheet;
  const { q, by, opts } = useFind.getState();
  if (!sh || !q) return;
  const sel = selOf(pageId);
  const a = addr(sel.ar, sel.ac);
  const hit = findAll(sh, q, { ...opts, lookIn: "formulas" }, lang(), { r0: sel.ar, c0: sel.ac, r1: sel.ar, c1: sel.ac }).length > 0;
  const e = hit ? replaceCell(sh, a, q, by, opts) : null;
  if (e) setCells(pageId, [e], t("sheet.h.replace"));
  doFindNext(pageId);
}

export function doReplaceAll(pageId: string): number {
  const sh = findPage(S().doc, pageId)?.sheet;
  const { q, by, opts } = useFind.getState();
  if (!sh || !q) return 0;
  const edits = findAll(sh, q, { ...opts, lookIn: "formulas" }, lang(), findScope(selOf(pageId)))
    .map((a) => replaceCell(sh, a, q, by, opts))
    .filter((e): e is NonNullable<typeof e> => !!e);
  if (!edits.length) {
    S().notify(t("sheet.find.none"));
    return 0;
  }
  setCells(pageId, edits, t("sheet.h.replace"));
  S().notify(t("sheet.find.replaced", { n: edits.length }));
  return edits.length;
}

// ───── notes ─────

export function setNote(pageId: string, a: string, text: string | null) {
  const sh = findPage(S().doc, pageId)?.sheet;
  if (!sh) return;
  const old = sh.notes?.[a];
  if (old?.threaded) return void openDlg({ kind: "thread", a }); // a thread: its own dialog (답글 · 해결)
  if ((old?.text ?? null) === text) return;
  S().commit(t("sheet.h.note"), (d) => {
    const s2 = draftPage(d, pageId)?.sheet;
    if (!s2) return;
    const notes = { ...(s2.notes ?? {}) };
    if (text == null) delete notes[a];
    else notes[a] = { ...(old ?? {}), text };
    s2.notes = notes;
  });
}

// ───── data validation ─────

const inRanges = (ranges: string[], r: number, c: number) =>
  ranges.some((x) => {
    const g = parseRange(x);
    return !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  });

/** The validation rule of a cell (the last one that covers it, as Excel applies it). */
export function validationAt(sh: SheetData, r: number, c: number): SheetValidation | undefined {
  const list = sh.valid ?? [];
  for (let i = list.length - 1; i >= 0; i--) if (inRanges(list[i].ranges, r, c)) return list[i];
  return undefined;
}

/** The choices of a list validation: an explicit list ("a,b,c") or the shown values of a range (or a name for one). */
export function listItems(pages: Page[], sh: SheetData, v: SheetValidation): string[] {
  let f = (v.f1 ?? "").trim().replace(/^=/, "");
  if (f.startsWith('"')) return f.slice(1, f.endsWith('"') ? -1 : undefined).replace(/""/g, '"').split(",").map((x) => x.trim());
  for (let depth = 0; depth < 3 && sh.names?.[f]; depth++) f = sh.names[f].replace(/^=/, "");
  const tk = tokenize(f).filter((x) => x.t !== "ws");
  const ref = tk[0];
  if (tk.length !== 1 || ref.t !== "ref") return [];
  const g = parseRange(ref.body);
  const src = ref.sheet ? pages.find((p) => p.sheet?.book === sh.book && p.sheet.name.toLowerCase() === ref.sheet!.toLowerCase())?.sheet : sh;
  if (!g || !src) return [];
  const out: string[] = [];
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 2000); r++)
    for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 50); c++) {
      const s = shownText(src, src.cells[addr(r, c)], lang());
      if (s) out.push(s);
    }
  return out;
}

const num = (sh: SheetData, f: string | undefined): number | null => {
  if (f == null) return null;
  const n = Number(f);
  if (Number.isFinite(n)) return n;
  const p = parseAddr(f.replace(/\$/g, ""));
  const v = p ? sh.cells[addr(p.r, p.c)]?.v : undefined;
  return typeof v === "number" ? v : null;
};

/** Whether typed input passes a cell's validation (lists, whole numbers, decimals, text length; other kinds pass). */
export function passesValidation(pages: Page[], sh: SheetData, v: SheetValidation, text: string): boolean {
  if (text === "") return true;
  if (text.startsWith("=")) return true;
  const p = parseInput(text, {});
  if (v.type === "list") {
    const items = listItems(pages, sh, v).map((x) => x.toLowerCase());
    return !items.length || items.includes(text.trim().toLowerCase());
  }
  const cmp = (x: number) => {
    const a = num(sh, v.f1), b = num(sh, v.f2);
    if (a == null) return true;
    switch (v.op ?? "between") {
      case "between":
        return b == null || (x >= a && x <= b);
      case "notBetween":
        return b == null || x < a || x > b;
      case "equal":
        return x === a;
      case "notEqual":
        return x !== a;
      case "greaterThan":
        return x > a;
      case "lessThan":
        return x < a;
      case "greaterThanOrEqual":
        return x >= a;
      case "lessThanOrEqual":
        return x <= a;
    }
    return true;
  };
  if (v.type === "whole" || v.type === "decimal" || v.type === "date" || v.type === "time") {
    if (typeof p.v !== "number") return false;
    if (v.type === "whole" && !Number.isInteger(p.v)) return false;
    return cmp(p.v);
  }
  if (v.type === "textLength") return cmp(text.length);
  return true;
}

/** Keys of Excel's Data / Home commands for the command search and shortcuts. */
export function sheetCommand(kind: "find" | "replace" | "filter" | "sort" | "insert" | "delete" | "fillDown" | "fillRight") {
  const p = curPage();
  if (!p) return;
  if (kind === "find" || kind === "replace") return openDlg({ kind: "find", replace: kind === "replace" });
  if (kind === "filter") return toggleFilter(p.id);
  if (kind === "sort") return openDlg({ kind: "sort" });
  if (kind === "insert" || kind === "delete") return void insertOrDelete(p.id, kind === "delete");
  return fillDir(p.id, kind === "fillDown" ? "down" : "right");
}
