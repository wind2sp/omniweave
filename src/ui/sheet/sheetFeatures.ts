// Excel commands of the sheet ribbon's tabs (표 계산 Excel 기능): conditional formatting, data validation, remove
// duplicates, text to columns, flash fill (Ctrl+E), hyperlinks (Ctrl+K), sheet / workbook protection, page setup with
// print area and titles, defined names, charts (insert, edit, move, delete) and pivot tables (create, refresh). Each
// command is one undo step on the sheet page; the file side is io/sheet/writeParts.ts and writeDrawings.ts.

import { create } from "zustand";
import { draftPage, findPage, useStore } from "../../core/store";
import type { Page } from "../../core/types";
import type { PivotFn, SheetCell, SheetChartSpec, SheetCondRule, SheetData, SheetDrawing, SheetLink, SheetPivot, SheetPrint, SheetSlicer, SheetTable, SheetValidation } from "../../core/sheetTypes";
import { t } from "../../i18n";
import { addr, colLetters, MAX_COL, MAX_ROW, parseAddr, parseFormula, parseRange, rangeText, type Ast, type Rect } from "../../io/sheet/formula";
import { applyChange, Book } from "../../io/sheet/calc";
import { currentRegion, guessHeader, shownText } from "../../io/sheet/sortFilter";
import { usedRange } from "../../io/sheet/pages";
import { setUserLists, USER_LISTS } from "../../io/sheet/fill";
import { guidOf, legacyText } from "../../io/sheet/threads";
import { reviewAuthor } from "../../core/review";
import { tokenize } from "../../io/sheet/formula";
import { sheetPages } from "../../io/sheet/book";
import { chartXml } from "../../io/sheet/writeDrawings";
import { excelPasswordHash } from "../../io/sheet/writeParts";
import { addSheet, bookPages, lang, norm, one, parseInput, selOf, setCells, setSel, styleIndex } from "./sheetActions";
import { bookEdit, setFilterColumn } from "./sheetEdit";
import { applyStructToBook, insertWouldLoseData, type StructOp } from "../../io/sheet/structure";

const S = () => useStore.getState();
const sheetOf = (pageId: string) => findPage(S().doc, pageId)?.sheet;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Change a sheet page's model in one undo step. */
function edit(pageId: string, label: string, f: (sh: SheetData) => void) {
  S().commit(label, (d) => {
    const sh = draftPage(d, pageId)?.sheet as SheetData | undefined;
    if (sh) f(sh);
  });
}

/** Ranges as text without the sheet part ("B2:D9"). */
const rangesOf = (g: Rect) => [g.r0 === g.r1 && g.c0 === g.c1 ? addr(g.r0, g.c0) : rangeText(g)];

/** The selection, cut down to the used range when whole rows / columns are picked. */
export function selArea(sh: SheetData, pageId: string): Rect {
  const g = norm(selOf(pageId));
  const u = usedRange(sh);
  return { r0: g.r0, c0: g.c0, r1: g.r1 === MAX_ROW ? Math.max(g.r0, u.r1) : g.r1, c1: g.c1 === MAX_COL ? Math.max(g.c0, u.c1) : g.c1 };
}

/** The data a command works on: the selection when it is a range, else the current region around the active cell. */
export function dataArea(sh: SheetData, pageId: string): Rect {
  const s = selOf(pageId);
  const g = norm(s);
  if (g.r0 !== g.r1 || g.c0 !== g.c1) return selArea(sh, pageId);
  return currentRegion(sh, s.ar, s.ac);
}

const overlaps = (a: Rect, b: Rect) => !(a.r1 < b.r0 || a.r0 > b.r1 || a.c1 < b.c0 || a.c0 > b.c1);

/** `a` minus `b`: up to four rectangles. */
function subtract(a: Rect, b: Rect): Rect[] {
  if (!overlaps(a, b)) return [a];
  const out: Rect[] = [];
  if (a.r0 < b.r0) out.push({ ...a, r1: b.r0 - 1 });
  if (a.r1 > b.r1) out.push({ ...a, r0: b.r1 + 1 });
  const r0 = Math.max(a.r0, b.r0), r1 = Math.min(a.r1, b.r1);
  if (a.c0 < b.c0) out.push({ r0, r1, c0: a.c0, c1: b.c0 - 1 });
  if (a.c1 > b.c1) out.push({ r0, r1, c0: b.c1 + 1, c1: a.c1 });
  return out;
}
const textOf = (g: Rect) => (g.r0 === g.r1 && g.c0 === g.c1 ? addr(g.r0, g.c0) : rangeText(g));

// ───── protection ─────

/** Is a cell locked against edits now (the sheet protected and the cell not unlocked in 셀 서식 ▸ 보호)? */
export function lockedAt(sh: SheetData, r: number, c: number): boolean {
  if (!sh.protect) return false;
  return !sh.styles[sh.cells[addr(r, c)]?.s ?? 0]?.unlocked;
}

/** Excel's message when an edit touches locked cells of a protected sheet; true = the edit may go on. */
export function mayEdit(sh: SheetData, g: Rect): boolean {
  if (!sh.protect) return true;
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 2000); r++) for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 200); c++) if (lockedAt(sh, r, c)) return void S().notify(t("sheetx.protect.locked")), false;
  return true;
}

/** May the protected sheet do `what` (formatCells, insertRows, sort …)? Tells why not. */
export function mayDo(sh: SheetData, what: string): boolean {
  if (!sh.protect || sh.protect.allow.includes(what)) return true;
  S().notify(t("sheetx.protect.locked"));
  return false;
}

export function protectSheet(pageId: string, allow: string[], password: string) {
  edit(pageId, t("sheetx.h.protect"), (sh) => {
    sh.protect = { allow, ...(password ? { hash: excelPasswordHash(password) } : {}) };
  });
}

/** Unprotect; false when the password is wrong. */
export function unprotectSheet(pageId: string, password: string): boolean {
  const sh = sheetOf(pageId);
  if (!sh?.protect) return true;
  if (sh.protect.hash && excelPasswordHash(password) !== sh.protect.hash) return false;
  edit(pageId, t("sheetx.h.unprotect"), (s) => void delete s.protect);
  return true;
}

/** Workbook structure protection on / off (every sheet of the book carries it). */
export function protectBook(pageId: string, on: boolean, password: string): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  const cur = page.sheet.bookProtect;
  if (!on && cur?.hash && excelPasswordHash(password) !== cur.hash) return false;
  const pages = bookPages(st.doc, page);
  st.commit(t(on ? "sheetx.h.protectBook" : "sheetx.h.unprotectBook"), (d) => {
    for (const p of pages) {
      const sh = draftPage(d, p.id)?.sheet as SheetData | undefined;
      if (!sh) continue;
      if (on) sh.bookProtect = password ? { hash: excelPasswordHash(password) } : {};
      else delete sh.bookProtect;
    }
  });
  return true;
}

// ───── conditional formatting ─────

/** Add a rule on the selection (it goes on top, as Excel's new rules do). */
export function addCondRule(pageId: string, g: Rect, rule: Omit<SheetCondRule, "priority">) {
  edit(pageId, t("sheetx.h.cond"), (sh) => {
    const cond = sh.cond ?? [];
    for (const cf of cond) for (const r of cf.rules) r.priority += 1;
    cond.push({ ranges: rangesOf(g), rules: [{ ...clone(rule), priority: 1 }] });
    sh.cond = cond;
  });
}

/** 규칙 지우기: from the selected cells, or from the whole sheet. */
export function clearCond(pageId: string, g: Rect | null) {
  edit(pageId, t("sheetx.h.condClear"), (sh) => {
    if (!sh.cond) return;
    if (!g) return void delete sh.cond;
    sh.cond = sh.cond
      .map((cf) => ({ ...cf, ranges: cf.ranges.flatMap((x) => (parseRange(x) ? subtract(parseRange(x)!, g).map(textOf) : [x])) }))
      .filter((cf) => cf.ranges.length);
    if (!sh.cond.length) delete sh.cond;
  });
}

/** 규칙 관리 ▸ 편집: one rule replaced (its place in the order kept). */
export function replaceCondRule(pageId: string, block: number, rule: number, next: Omit<SheetCondRule, "priority">) {
  edit(pageId, t("sheetx.h.cond"), (sh) => {
    const cf = sh.cond?.[block];
    const r = cf?.rules[rule];
    if (!cf || !r) return;
    cf.rules[rule] = { ...clone(next), priority: r.priority, ...(r.stop ? { stop: true } : {}) };
  });
}

export function deleteCondRule(pageId: string, block: number, rule: number) {
  edit(pageId, t("sheetx.h.condClear"), (sh) => {
    const cf = sh.cond?.[block];
    if (!cf) return;
    cf.rules.splice(rule, 1);
    if (!cf.rules.length) sh.cond!.splice(block, 1);
    if (!sh.cond!.length) delete sh.cond;
  });
}

// ───── data validation ─────

/** Set (or with null clear) the validation of the selected cells; other rules lose those cells. */
export function setValidation(pageId: string, g: Rect, v: Omit<SheetValidation, "ranges"> | null) {
  edit(pageId, t("sheetx.h.valid"), (sh) => {
    const list = (sh.valid ?? [])
      .map((x) => ({ ...x, ranges: x.ranges.flatMap((rg) => (parseRange(rg) ? subtract(parseRange(rg)!, g).map(textOf) : [rg])) }))
      .filter((x) => x.ranges.length);
    if (v) list.push({ ...clone(v), ranges: rangesOf(g) });
    if (list.length) sh.valid = list;
    else delete sh.valid;
  });
}

// ───── remove duplicates / text to columns / flash fill ─────

const keyOf = (sh: SheetData, r: number, c: number) => {
  const x = sh.cells[addr(r, c)];
  return x?.v === undefined ? "" : typeof x.v === "string" ? "s" + x.v.toLowerCase() : String(x.v);
};

/** 중복된 항목 제거: rows whose chosen columns repeat an earlier row are removed (the rows below move up). */
export function removeDuplicates(pageId: string, g: Rect, cols: number[], header: boolean): { removed: number; left: number } {
  const sh = sheetOf(pageId);
  if (!sh || !cols.length) return { removed: 0, left: 0 };
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let r = g.r0 + (header ? 1 : 0); r <= g.r1; r++) {
    const k = cols.map((c) => keyOf(sh, r, c)).join("\u0001");
    if (seen.has(k)) continue;
    seen.add(k);
    keep.push(r);
  }
  const total = g.r1 - g.r0 + 1 - (header ? 1 : 0);
  if (keep.length === total) return { removed: 0, left: total };
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const top = g.r0 + (header ? 1 : 0);
  for (let i = 0; i < total; i++) {
    const to = top + i;
    for (let c = g.c0; c <= g.c1; c++) {
      const from = i < keep.length ? sh.cells[addr(keep[i], c)] : undefined;
      edits.push({ a: addr(to, c), cell: from ? clone(from) : undefined });
    }
  }
  setCells(pageId, edits, t("sheetx.h.dedupe"));
  return { removed: total - keep.length, left: keep.length };
}

export interface SplitOpts {
  delims: string[];
  /** treat consecutive delimiters as one */
  merge: boolean;
  /** text qualifier " (none = "") */
  quote: string;
  /** fixed widths: break positions (characters) instead of delimiters */
  fixed?: number[];
}

/** One text split as 텍스트 나누기 does. */
export function splitText(s: string, o: SplitOpts): string[] {
  if (o.fixed) {
    const cuts = [0, ...o.fixed.filter((n) => n > 0 && n < s.length).sort((a, b) => a - b), s.length];
    return cuts.slice(1).map((e, i) => s.slice(cuts[i], e).trim());
  }
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (o.quote && ch === o.quote) {
      if (q && s[i + 1] === o.quote) {
        cur += ch;
        i++;
      } else q = !q;
    } else if (!q && o.delims.includes(ch)) {
      out.push(cur);
      cur = "";
      if (o.merge) while (i + 1 < s.length && o.delims.includes(s[i + 1])) i++;
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** 텍스트 나누기 of the selected column into the columns from `dest` (default: in place). */
export function textToColumns(pageId: string, g: Rect, o: SplitOpts, dest?: { r: number; c: number }): number {
  const sh = sheetOf(pageId);
  if (!sh) return 0;
  const to = dest ?? { r: g.r0, c: g.c0 };
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  let width = 0;
  for (let r = g.r0; r <= g.r1; r++) {
    const x = sh.cells[addr(r, g.c0)];
    if (!x || x.v === undefined || x.f) continue;
    const parts = splitText(String(typeof x.v === "number" ? shownText(sh, x, lang()) : x.v), o);
    width = Math.max(width, parts.length);
    parts.forEach((p, j) => {
      const a = addr(to.r + (r - g.r0), to.c + j);
      const n = /^[-+]?\d+(\.\d+)?$/.test(p.trim()) ? Number(p) : null;
      const old = sh.cells[a];
      edits.push({ a, cell: { ...(old?.s ? { s: old.s } : {}), ...(p === "" ? {} : { v: n ?? p }) } });
    });
  }
  if (edits.length) setCells(pageId, edits, t("sheetx.h.split"));
  return width;
}

type Token = { col: number; start: number; end: number };

/** Flash fill (빠른 채우기, Ctrl+E): the column's typed examples taught from the row's other cells, filled down. */
export function flashFill(pageId: string): number {
  const sh = sheetOf(pageId);
  if (!sh) return 0;
  const s = selOf(pageId);
  const c = s.ac;
  // the block of rows: the current region of the columns to the left / right
  const reg = currentRegion(sh, s.ar, c > 0 ? c - 1 : c + 1);
  const r0 = reg.r0, r1 = reg.r1;
  const srcCols: number[] = [];
  for (let k = reg.c0; k <= reg.c1; k++) if (k !== c) srcCols.push(k);
  const text = (r: number, k: number) => shownText(sh, sh.cells[addr(r, k)], lang());
  const head = guessHeader(sh, reg) && text(r0, c) !== "";
  const first = head ? r0 + 1 : r0;
  const examples: { r: number; out: string }[] = [];
  for (let r = first; r <= r1; r++) if (text(r, c) !== "") examples.push({ r, out: text(r, c) });
  if (!examples.length) return 0;
  const prog = learn(examples.map((e) => ({ src: srcCols.map((k) => text(e.r, k)), out: e.out })));
  if (!prog) {
    S().notify(t("sheetx.flash.none"));
    return 0;
  }
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  for (let r = first; r <= r1; r++) {
    if (text(r, c) !== "") continue;
    const src = srcCols.map((k) => text(r, k));
    if (src.every((x) => x === "")) continue;
    const v = run(prog, src);
    if (v == null) continue;
    const old = sh.cells[addr(r, c)];
    edits.push({ a: addr(r, c), cell: { ...(old?.s ? { s: old.s } : {}), v } });
  }
  if (edits.length) setCells(pageId, edits, t("sheetx.h.flash"));
  else S().notify(t("sheetx.flash.none"));
  return edits.length;
}

/** A flash-fill program: literal text and pieces of the row's cells (a word by its index, a slice), with a case. */
type Piece = { lit: string } | { col: number; word: number; fromEnd: boolean; caseOf: "same" | "upper" | "lower" | "proper"; part?: [number, number] };
type Prog = Piece[];

const words = (s: string): Token[] => {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  for (let m = re.exec(s); m; m = re.exec(s)) out.push({ col: 0, start: m.index, end: m.index + m[0].length });
  return out;
};
const caseLike = (w: string, out: string): "same" | "upper" | "lower" | "proper" | null => {
  if (out === w) return "same";
  if (out === w.toUpperCase()) return "upper";
  if (out === w.toLowerCase()) return "lower";
  if (out === w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()) return "proper";
  return null;
};
const applyCase = (w: string, k: "same" | "upper" | "lower" | "proper") => (k === "upper" ? w.toUpperCase() : k === "lower" ? w.toLowerCase() : k === "proper" ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w);

/** Programs that explain one example, longest pieces first (a few candidates). */
function explain(src: string[], out: string): Prog[] {
  const res: Prog[] = [];
  let steps = 0;
  const go = (i: number, acc: Prog) => {
    if (res.length > 40 || ++steps > 20000) return;
    if (i === out.length) return void res.push(acc);
    let any = false;
    for (let col = 0; col < src.length; col++) {
      const ws = words(src[col]);
      ws.forEach((w, wi) => {
        const word = src[col].slice(w.start, w.end);
        for (let len = word.length; len >= 1; len--) {
          const piece = out.slice(i, i + len);
          // a whole word, or its first letters (initials)
          const sub = len === word.length ? word : word.slice(0, len);
          const k = caseLike(sub, piece);
          if (!k) continue;
          any = true;
          go(i + len, [...acc, { col, word: wi, fromEnd: false, caseOf: k, ...(len === word.length ? {} : { part: [0, len] as [number, number] }) }]);
          go(i + len, [...acc, { col, word: ws.length - 1 - wi, fromEnd: true, caseOf: k, ...(len === word.length ? {} : { part: [0, len] as [number, number] }) }]);
          break;
        }
      });
    }
    if (!any || i < out.length) {
      // a literal character (separators, fixed text)
      const last = acc[acc.length - 1];
      const ch = out[i];
      if (!/[\p{L}\p{N}]/u.test(ch) || !any) go(i + 1, last && "lit" in last ? [...acc.slice(0, -1), { lit: last.lit + ch }] : [...acc, { lit: ch }]);
    }
  };
  go(0, []);
  return res;
}

function run(p: Prog, src: string[]): string | null {
  let s = "";
  for (const x of p) {
    if ("lit" in x) {
      s += x.lit;
      continue;
    }
    const ws = words(src[x.col] ?? "");
    const w = ws[x.fromEnd ? ws.length - 1 - x.word : x.word];
    if (!w) return null;
    let word = (src[x.col] ?? "").slice(w.start, w.end);
    if (x.part) word = word.slice(x.part[0], x.part[1]);
    s += applyCase(word, x.caseOf);
  }
  return s;
}

function learn(ex: { src: string[]; out: string }[]): Prog | null {
  const cands = explain(ex[0].src, ex[0].out);
  // the simplest program (fewest pieces) that gives every example
  cands.sort((a, b) => a.length - b.length);
  return cands.find((p) => ex.every((e) => run(p, e.src) === e.out)) ?? null;
}

// ───── hyperlinks ─────

/** Insert / edit (or with null remove) the link of a cell; `text` is what the cell shows (Excel's 표시할 텍스트). */
export function setLink(pageId: string, a: string, link: SheetLink | null, text?: string) {
  const sh = sheetOf(pageId);
  if (!sh) return;
  const old = sh.cells[a];
  const cell: SheetCell = old ? clone(old) : {};
  if (text != null && text !== "" && !(old?.f)) cell.v = text;
  else if (link && cell.v === undefined && !cell.f) cell.v = link.url ?? link.loc ?? "";
  setCells(pageId, [{ a, cell }], t("sheetx.h.link"), (after) => {
    const links = { ...(after.links ?? {}) };
    if (link) links[a] = link;
    else delete links[a];
    if (Object.keys(links).length) after.links = links;
    else delete after.links;
    // Excel's Hyperlink cell style: blue, underlined (removed with the link)
    const c = after.cells[a] ?? (after.cells[a] = {});
    const st = { ...(after.styles[c.s ?? 0] ?? {}) };
    if (link) Object.assign(st, { color: "#0563C1", underline: "single" });
    else if (st.color?.toUpperCase() === "#0563C1") {
      delete st.color;
      delete st.underline;
    }
    const s = styleIndex(after, st);
    if (s) c.s = s;
    else delete c.s;
  });
}

/** Follow a cell's link: a web address in the browser, a place in the workbook by going there. */
export function followLink(pageId: string, a: string) {
  const sh = sheetOf(pageId);
  const l = sh?.links?.[a];
  if (!l) return;
  if (l.url) {
    const url = /^(https?:|mailto:|file:)/i.test(l.url) ? l.url : "https://" + l.url;
    const tauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
    if (tauri) void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => S().notify(url));
    else window.open(url, "_blank", "noopener");
    return;
  }
  goTo(pageId, l.loc ?? "");
}

/** Go to a reference or a name ("Sheet2!B4", "SalesRange", "C9"): the sheet and the cells. */
export function goTo(pageId: string, ref: string): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return false;
  let text = ref.trim().replace(/^=/, "");
  const name = Object.keys(sh.names ?? {}).find((k) => k.toLowerCase() === text.toLowerCase());
  if (name) text = sh.names![name];
  const bang = text.lastIndexOf("!");
  const sheetName = bang > 0 ? text.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'") : null;
  const g = parseRange(text.slice(bang + 1).replace(/\$/g, "").toUpperCase());
  if (!g) return false;
  const target = sheetName ? bookPages(st.doc, page!).find((p) => p.sheet!.name.toLowerCase() === sheetName.toLowerCase()) : page;
  if (!target) return false;
  setSel(target.id, { ar: g.r0, ac: g.c0, r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1 });
  if (target.id !== pageId) st.set({ pageId: target.id });
  return true;
}

// ───── page setup ─────

export const DEFAULT_MARGINS = { l: 0.7, r: 0.7, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 };

export function setPrint(pageId: string, patch: (p: SheetPrint) => SheetPrint, label = t("sheetx.h.print")) {
  edit(pageId, label, (sh) => {
    const p = patch(clone(sh.print ?? {}));
    for (const k of Object.keys(p) as (keyof SheetPrint)[]) if (p[k] === undefined) delete p[k];
    if (Object.keys(p).length) sh.print = p;
    else delete sh.print;
  });
}

// ───── names ─────

const NAME_RE = /^[\p{L}_\\][\p{L}\p{N}_.\\]*$/u;

/** Define (or with null delete) a workbook name; false (with a message) for a bad or cell-like name. */
export function defineName(pageId: string, name: string, ref: string | null, old?: string): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  name = name.trim();
  if (ref != null) {
    if (!NAME_RE.test(name) || parseRange(name.toUpperCase()) || /^(R|C|R\d+C\d+)$/i.test(name)) return void st.notify(t("sheetx.name.bad")), false;
    const f = ref.trim().replace(/^=/, "");
    try {
      parseFormula(f);
    } catch {
      return void st.notify(t("sheet.badFormula")), false;
    }
    ref = f;
  }
  const pages = bookPages(st.doc, page);
  st.commit(t("sheetx.h.name"), (d) => {
    for (const p of pages) {
      const sh = draftPage(d, p.id)?.sheet as SheetData | undefined;
      if (!sh) continue;
      const names = { ...(sh.names ?? {}) };
      if (old && old !== name) delete names[old];
      if (ref == null) delete names[name];
      else names[name] = ref;
      if (Object.keys(names).length) sh.names = names;
      else delete sh.names;
    }
  });
  return true;
}

/** An absolute reference to a range of this sheet ('My sheet'!$B$2:$B$9). */
export function absRef(sh: SheetData, g: Rect): string {
  const q = /^[A-Za-z_][\w.]*$/.test(sh.name) ? sh.name : `'${sh.name.replace(/'/g, "''")}'`;
  const one = (r: number, c: number) => `$${colLetters(c)}$${r + 1}`;
  return `${q}!${one(g.r0, g.c0)}${g.r0 === g.r1 && g.c0 === g.c1 ? "" : ":" + one(g.r1, g.c1)}`;
}

/** 선택 영역에서 만들기: names from the top row of the selection for each column under it. */
export function namesFromSelection(pageId: string): number {
  const sh = sheetOf(pageId);
  if (!sh) return 0;
  const g = selArea(sh, pageId);
  let n = 0;
  for (let c = g.c0; c <= g.c1; c++) {
    const label = shownText(sh, sh.cells[addr(g.r0, c)], lang()).trim().replace(/[^\p{L}\p{N}_.]+/gu, "_");
    if (!label || g.r1 <= g.r0) continue;
    if (defineName(pageId, /^\p{N}/u.test(label) ? "_" + label : label, absRef(sh, { r0: g.r0 + 1, c0: c, r1: g.r1, c1: c }))) n++;
  }
  return n;
}

// ───── charts ─────

/** Office theme colours (lt1 dk1 lt2 dk2 accent1–6 hlink folHlink) for a chart made on a sheet with none of its own. */
const OFFICE_THEME = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];

/** The chart picked on the grid (선택한 차트: its 차트 디자인 tab, Delete, dragging). */
export const useChartSel = create<{ pageId: string | null; i: number }>(() => ({ pageId: null, i: -1 }));
export const pickChart = (pageId: string | null, i = -1) => useChartSel.setState({ pageId, i });

export function insertChart(pageId: string, type: string): number {
  const sh = sheetOf(pageId);
  if (!sh) return -1;
  const g = dataArea(sh, pageId);
  if (g.r0 === g.r1 && g.c0 === g.c1) {
    S().notify(t("sheetx.chart.pickData"));
    return -1;
  }
  const spec: SheetChartSpec = { type, ref: rangeText(g), title: chartTitle(sh, g, type) };
  const theme = sh.drawings?.find((d) => d.theme?.length)?.theme ?? OFFICE_THEME;
  const fonts = sh.drawings?.find((d) => d.fonts?.length)?.fonts;
  // to the right of the data, about 8 × 15 cells (Excel's default chart is 15 × 7.5 cm)
  // (each further chart a little lower and to the right, so a new one never hides the last)
  const n = (sh.drawings ?? []).filter((d) => d.kind === "chart" && d.spec).length;
  const c0 = Math.min(MAX_COL - 8, g.c1 + 2 + n), r0 = g.r0 + n * 3;
  const d: SheetDrawing = { kind: "chart", name: `Chart ${(sh.drawings?.length ?? 0) + 1}`, at: { c0, x0: 0, r0, y0: 0, w: 480, h: 288 }, spec, chart: chartXml(sh, spec), theme, ...(fonts ? { fonts } : {}) };
  let i = -1;
  edit(pageId, t("sheetx.h.chart"), (s2) => {
    s2.drawings = [...(s2.drawings ?? []), d];
    i = s2.drawings.length - 1;
  });
  pickChart(pageId, i);
  return i;
}

function chartTitle(sh: SheetData, g: Rect, type: string): string {
  // one series: its header names the chart (Excel); several: no title text but "차트 제목"
  const cols = g.c1 - g.c0;
  if (cols === 1 || type === "pie" || type === "doughnut") {
    const h = shownText(sh, sh.cells[addr(g.r0, g.c1)], lang());
    if (h && typeof sh.cells[addr(g.r0, g.c1)]?.v === "string") return h;
  }
  return t("sheetx.chart.title");
}

/** Change a chart made here (type, title, legend, labels…); a file chart: its title, legend and labels in its XML. */
export function updateChart(pageId: string, i: number, patch: Partial<SheetChartSpec>) {
  edit(pageId, t("sheetx.h.chartEdit"), (sh) => {
    const d = sh.drawings?.[i];
    if (!d || d.kind !== "chart") return;
    if (d.spec) {
      d.spec = { ...d.spec, ...patch };
      for (const k of Object.keys(d.spec) as (keyof SheetChartSpec)[]) if (d.spec[k] === undefined || d.spec[k] === "") delete d.spec[k];
      d.chart = chartXml(sh, d.spec);
    } else if (d.chart) d.chart = patchChartXml(d.chart, patch);
  });
}

/** Title / legend / data labels changed inside a file chart's own XML (the rest stays as Excel wrote it). */
export function patchChartXml(xml: string, p: Partial<SheetChartSpec>): string {
  let x = xml;
  const px = /<(\w+):chartSpace\b/.exec(x)?.[1] ?? "c";
  const a = /xmlns:(\w+)="http:\/\/schemas\.openxmlformats\.org\/drawingml\/2006\/main"/.exec(x)?.[1] ?? "a";
  const esc = (s: string) => s.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!);
  if (p.title !== undefined) {
    const chartOpen = new RegExp(`<${px}:chart>`);
    x = x.replace(new RegExp(`<${px}:title>[\\s\\S]*?</${px}:title>`), "").replace(new RegExp(`<${px}:autoTitleDeleted\\b[^>]*/>`), "");
    // the chart's own title is the first child of <c:chart> (axis titles sit inside the axes)
    const t0 = p.title
      ? `<${px}:title><${px}:tx><${px}:rich><${a}:bodyPr/><${a}:p><${a}:r><${a}:t>${esc(p.title)}</${a}:t></${a}:r></${a}:p></${px}:rich></${px}:tx><${px}:overlay val="0"/></${px}:title><${px}:autoTitleDeleted val="0"/>`
      : `<${px}:autoTitleDeleted val="1"/>`;
    x = x.replace(chartOpen, `<${px}:chart>${t0}`);
  }
  if (p.legend !== undefined) {
    x = x.replace(new RegExp(`<${px}:legend>[\\s\\S]*?</${px}:legend>`), "");
    if (p.legend !== "none") x = x.replace(new RegExp(`</${px}:plotArea>`), `</${px}:plotArea><${px}:legend><${px}:legendPos val="${p.legend}"/><${px}:overlay val="0"/></${px}:legend>`);
  }
  if (p.labels !== undefined) {
    x = x.replace(new RegExp(`<${px}:dLbls>[\\s\\S]*?</${px}:dLbls>`, "g"), "");
    if (p.labels)
      x = x.replace(new RegExp(`(<${px}:ser>[\\s\\S]*?)(<${px}:(?:cat|val|xVal|yVal)>)`, "g"), `$1<${px}:dLbls><${px}:showLegendKey val="0"/><${px}:showVal val="1"/><${px}:showCatName val="0"/><${px}:showSerName val="0"/><${px}:showPercent val="0"/><${px}:showBubbleSize val="0"/></${px}:dLbls>$2`);
  }
  return x;
}

export function deleteDrawing(pageId: string, i: number) {
  const d = sheetOf(pageId)?.drawings?.[i];
  // a file chart inside a group (or with other drawings in its anchor) cannot be taken out of the drawing part alone
  if (d?.part && d.anchorIx == null) return void S().notify(t("sheetx.chart.cantDelete"));
  edit(pageId, t("sheetx.h.chartDelete"), (sh) => {
    sh.drawings?.splice(i, 1);
    if (!sh.drawings?.length) delete sh.drawings;
  });
  pickChart(null);
}

// ───── pivot tables ─────

type Fn = PivotFn;
type PV = string | number | null;

/** The values of a pivot's source: header names and rows of shown texts / numbers. */
function sourceRows(src: SheetData, ref: string): { head: string[]; rows: (string | number)[][] } | null {
  const g = parseRange(ref);
  if (!g || g.r1 <= g.r0) return null;
  const head: string[] = [];
  for (let c = g.c0; c <= g.c1; c++) head.push(shownText(src, src.cells[addr(g.r0, c)], lang()) || colLetters(c));
  const rows: (string | number)[][] = [];
  for (let r = g.r0 + 1; r <= g.r1; r++) {
    const row: (string | number)[] = [];
    let any = false;
    for (let c = g.c0; c <= g.c1; c++) {
      const x = src.cells[addr(r, c)];
      if (x?.v !== undefined && x.v !== "") any = true;
      row.push(typeof x?.v === "number" ? x.v : shownText(src, x, lang()));
    }
    if (any) rows.push(row);
  }
  return { head, rows };
}

/** Excel's summaries of a value field (sum, count, average, max, min, product, count numbers, stdev / var of a sample / population). */
export function pivotAgg(fn: Fn, xs: number[], n: number): number | null {
  if (fn === "count") return n;
  if (fn === "countNums") return xs.length;
  if (!xs.length) return null;
  const sum = xs.reduce((a, b) => a + b, 0);
  if (fn === "sum") return sum;
  if (fn === "average") return sum / xs.length;
  if (fn === "max") return Math.max(...xs);
  if (fn === "min") return Math.min(...xs);
  if (fn === "product") return xs.reduce((a, b) => a * b, 1);
  const mean = sum / xs.length;
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const pop = fn === "stdDevp" || fn === "varp";
  if (!pop && xs.length < 2) return Number.NaN; // Excel shows #DIV/0!
  const v = ss / (pop ? xs.length : xs.length - 1);
  return fn === "var" || fn === "varp" ? v : Math.sqrt(v);
}

export interface PivotLayout {
  /** every cell, page fields first */
  cells: PV[][];
  /** the table's first row in `cells` (after the page fields and a blank row) */
  top: number;
  /** header rows of the table */
  head: number;
  /** outline level of each table row below the header (−1 = grand total) */
  levels: number[];
}

/**
 * The pivot's cells in Excel's compact layout: page fields above the table; the row fields as an outline (each outer
 * item with its subtotal, the inner items under it, indented); the column fields across (one header row each, a
 * values row when there are several value fields); grand totals at the end.
 */
export function pivotLayout(src: SheetData, p: SheetPivot): PivotLayout | null {
  const data = sourceRows(src, p.ref);
  if (!data) return null;
  const idx = (f: string) => data.head.findIndex((h) => h === f);
  const ri = p.rows.map(idx), ci = p.cols.map(idx), vi = p.vals.map((v) => ({ ...v, i: idx(v.field) }));
  const pages = (p.pages ?? []).map((x) => ({ ...x, i: idx(x.field) }));
  if ([...ri, ...ci, ...vi.map((v) => v.i), ...pages.map((x) => x.i)].some((k) => k < 0) || !vi.length) return null;
  const txt = (v: string | number) => String(v ?? "");
  // (a slicer's / field filter's pick: only the rows with the items shown)
  const shows = Object.entries(p.show ?? {}).map(([f, items]) => ({ i: idx(f), items: new Set(items) })).filter((x) => x.i >= 0);
  const rows = data.rows.filter((r) => pages.every((x) => x.item == null || txt(r[x.i]) === x.item) && shows.every((x) => x.items.has(txt(r[x.i]))));
  const cmp = (a: string, b: string) => (a !== "" && b !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b, lang()));
  const blankLabel = t("sheetx.pivot.blank");
  const show = (s: string) => (s === "" ? blankLabel : s);
  // column keys: every combination of the column fields that occurs, sorted field by field
  const colKeys: string[][] = ci.length ? [...new Map(rows.map((r) => [ci.map((k) => txt(r[k])).join("\u0001"), ci.map((k) => txt(r[k]))])).values()].sort((a, b) => a.reduce((d, x, j) => d || cmp(x, b[j]), 0)) : [[]];
  const cellOf = (rowPath: string[], colPath: string[] | null, v: (typeof vi)[number]) => {
    const hit = rows.filter((r) => rowPath.every((x, j) => txt(r[ri[j]]) === x) && (colPath == null || colPath.every((x, j) => txt(r[ci[j]]) === x)));
    const nums = hit.map((r) => r[v.i]).filter((x): x is number => typeof x === "number");
    return pivotAgg(v.fn, nums, hit.filter((r) => r[v.i] !== "").length);
  };
  const fnName = (v: (typeof vi)[number]) => t(`sheetx.pivot.fnOf.${v.fn}`, { field: v.field });
  const multi = vi.length > 1;
  const cells: PV[][] = [];
  // page fields
  for (const x of pages) cells.push([x.field, x.item == null ? t("sheetx.pivot.all") : show(x.item)]);
  if (pages.length) cells.push([]);
  const top = cells.length;
  // headers
  if (ci.length) {
    cells.push([multi ? null : fnName(vi[0]), t("sheetx.pivot.colLabels")]);
    ci.forEach((_, lv) => {
      const line: PV[] = [lv === ci.length - 1 && !multi ? t("sheetx.pivot.rowLabels") : null];
      let prev = "";
      for (const k of colKeys) {
        const label = k.slice(0, lv + 1).join("\u0001");
        vi.forEach((_v, j) => line.push(j === 0 && label !== prev ? show(k[lv]) : null));
        prev = label;
      }
      if (lv === 0) vi.forEach((v, j) => line.push(multi ? `${t("sheetx.pivot.grandOf", { name: fnName(v) })}` : j ? null : t("sheetx.pivot.grand")));
      cells.push(line);
    });
    if (multi) cells.push([t("sheetx.pivot.rowLabels"), ...colKeys.flatMap(() => vi.map(fnName))]);
  } else cells.push([ri.length ? t("sheetx.pivot.rowLabels") : null, ...vi.map(fnName)]);
  const head = cells.length - top;
  const levels: number[] = [];
  const valuesOf = (path: string[]) => {
    const out: PV[] = [];
    if (ci.length) {
      for (const k of colKeys) for (const v of vi) out.push(cellOf(path, k, v));
      for (const v of vi) out.push(cellOf(path, null, v));
    } else for (const v of vi) out.push(cellOf(path, null, v));
    return out;
  };
  // the row outline
  const walk = (path: string[], lv: number) => {
    const keys = [...new Set(rows.filter((r) => path.every((x, j) => txt(r[ri[j]]) === x)).map((r) => txt(r[ri[lv]])))].sort(cmp);
    for (const k of keys) {
      const here = [...path, k];
      cells.push([show(k), ...valuesOf(here)]);
      levels.push(lv);
      if (lv + 1 < ri.length) walk(here, lv + 1);
    }
  };
  if (ri.length) walk([], 0);
  cells.push([t("sheetx.pivot.grand"), ...valuesOf([])]);
  levels.push(-1);
  return { cells, top, head, levels };
}

/** The pivot's grid of cells (tests and the old callers): the layout's cells. */
export function pivotGrid(src: SheetData, p: SheetPivot): PV[][] | null {
  return pivotLayout(src, p)?.cells ?? null;
}

/** Write (or refresh) a pivot on its sheet: the cells of the last refresh cleared, the grid written, labels bold. */
export function writePivot(pageId: string, p: SheetPivot, index: number | null): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  const srcPage = bookPages(st.doc, page).find((x) => x.sheet!.name === p.sheet);
  if (!srcPage) return false;
  const lay = pivotLayout(srcPage.sheet!, p);
  if (!lay) return void st.notify(t("sheetx.pivot.bad")), false;
  const grid = lay.cells;
  const at = parseAddr(p.at)!;
  const h = grid.length, w = Math.max(...grid.map((r) => r.length));
  const area: Rect = { r0: at.r, c0: at.c, r1: at.r + h - 1, c1: at.c + w - 1 };
  const table: Rect = { ...area, r0: at.r + lay.top };
  const edits = new Map<string, SheetCell | undefined>();
  const old = p.area ? parseRange(p.area) : p.out ? parseRange(p.out) : null;
  if (old) for (let r = old.r0; r <= old.r1; r++) for (let c = old.c0; c <= old.c1; c++) edits.set(addr(r, c), undefined);
  // (a summary Excel cannot work out — a sample deviation of one value — is its #DIV/0!)
  grid.forEach((row, i) => row.forEach((v, j) => edits.set(addr(at.r + i, at.c + j), v == null ? undefined : typeof v === "number" && Number.isNaN(v) ? { v: "#DIV/0!", t: "e" } : { v })));
  setCells(
    pageId,
    [...edits].map(([a, cell]) => ({ a, cell })),
    t(index == null ? "sheetx.h.pivot" : "sheetx.h.pivotRefresh"),
    (after) => {
      const base = after.styles[0] ?? {};
      const band = styleIndex(after, { ...base, bold: true, fill: "#DDEBF7", bb: { style: "thin", color: "#8EA9DB" } });
      const levelStyle = (lv: number, last: boolean) => styleIndex(after, { ...base, ...(lv === 0 && !last ? { bold: true } : {}), ...(lv > 0 ? { indent: lv, h: "left" as const } : {}) });
      for (let i = lay.top; i < h; i++) {
        const k = i - lay.top - lay.head; // row of the outline
        for (let j = 0; j < w; j++) {
          const a = addr(at.r + i, at.c + j);
          const c = after.cells[a];
          if (k < 0 || lay.levels[k] === -1) (after.cells[a] = c ?? {}).s = band;
          else if (j === 0 && c) {
            const s = levelStyle(lay.levels[k], p.rows.length < 2);
            if (s) c.s = s;
          }
        }
      }
      // the table's columns fit their labels (Excel autofits a pivot table on refresh)
      for (let j = 0; j < w; j++) {
        const chars = Math.max(...grid.map((row) => String(row[j] ?? "").replace(/[^\x00-\xff]/g, "WW").length));
        const px = Math.min(320, Math.round(chars * after.mdw + 14));
        if (px > (after.colW[at.c + j] ?? after.defColW)) after.colW[at.c + j] = px;
      }
      const list = after.pivots ?? [];
      const next = { ...p, out: rangeText(table), area: rangeText(area), ...(index != null && p.part ? { refreshed: true } : {}) };
      if (index == null) list.push(next);
      else list[index] = next;
      after.pivots = list;
    },
  );
  return true;
}

/** 모두 새로 고침: every pivot of the page from its source. */
export function refreshPivots(pageId: string): number {
  const sh = sheetOf(pageId);
  let n = 0;
  (sh?.pivots ?? []).forEach((p, i) => writePivot(pageId, p, i) && n++);
  if (!n) S().notify(t("sheetx.pivot.noneHere"));
  return n;
}

// ───── the grid asked to start typing (함수 삽입, 자동 합계 ▾ 평균 …) ─────

export const useCellCmd = create<{ edit: { text: string; n: number } | null }>(() => ({ edit: null }));
let cmdN = 0;
/** Start editing the active cell with `text` (the caret at its end), as if typed. */
export const startCellEdit = (text: string) => useCellCmd.setState({ edit: { text, n: ++cmdN } });

// ───── view ─────

/** 틀 고정 ▸ 틀 고정 / 첫 행 고정 / 첫 열 고정 / 취소 (rows / cols 0 = none). */
export function setFreeze(pageId: string, rows: number, cols: number) {
  edit(pageId, t("sheet.h.freeze"), (sh) => {
    if (!rows && !cols) delete sh.freeze;
    else sh.freeze = { rows, cols };
  });
}

/** What the grid shows besides the sheet's own settings: formulas instead of values (Ctrl+`), a zoom asked for. */
/** `topLeft`: the first cell shown at the top-left of each sheet's grid now (보기 ▸ 나누기 splits from there) */
export const useGridView = create<{ formulas: boolean; zoom: { z: number | "sel"; n: number } | null; topLeft?: Record<string, { r: number; c: number }> }>(() => ({ formulas: false, zoom: null }));
let zoomN = 0;
export const askZoom = (z: number | "sel") => useGridView.setState({ zoom: { z, n: ++zoomN } });
export const toggleFormulas = () => useGridView.setState((s) => ({ formulas: !s.formulas }));

/** Flash fill's learner, for tests: the program the examples teach, and what it gives for a row. */
export const flashLearn = learn;
export const flashRun = run;

/** 보기 ▸ 머리글: the row and column headings shown or hidden (<sheetView showRowColHeaders>). */
export function toggleHeadings(pageId: string) {
  edit(pageId, t("sheetx.h.headings"), (sh) => {
    sh.headings = sh.headings === false;
  });
}

/** 숨기기 / 숨기기 취소 of whole rows or columns (the heading menu); unhiding a range shows what is hidden inside it. */
export function hideLines(pageId: string, axis: "row" | "col", g: Rect, hide: boolean) {
  edit(pageId, t(hide ? "sheetx.hide" : "sheetx.unhide"), (sh) => {
    const lo = axis === "row" ? g.r0 : g.c0, hi = axis === "row" ? g.r1 : g.c1;
    // (unhiding A:C when B is hidden: the lines inside the selection come back, as in Excel)
    const cur = new Set(axis === "row" ? sh.hiddenRows ?? [] : sh.hiddenCols ?? []);
    for (let k = lo; k <= Math.min(hi, lo + 100000); k++) hide ? cur.add(k) : cur.delete(k);
    const list = [...cur].sort((a, b) => a - b);
    if (axis === "row") list.length ? (sh.hiddenRows = list) : delete sh.hiddenRows;
    else list.length ? (sh.hiddenCols = list) : delete sh.hiddenCols;
  });
}

// ───── tables (삽입 ▸ 표 · 홈 ▸ 표 서식, Ctrl+T) ─────

/** The table styles the 표 서식 gallery offers (Excel's built-in names). */
export const TABLE_STYLES = ["TableStyleLight9", "TableStyleLight10", "TableStyleLight11", "TableStyleMedium2", "TableStyleMedium3", "TableStyleMedium4", "TableStyleMedium5", "TableStyleMedium6", "TableStyleMedium7", "TableStyleDark2", "TableStyleDark3"];

/** The table (ListObject) a cell is in. */
export function tableAt(sh: SheetData, r: number, c: number): SheetTable | undefined {
  return (sh.tables ?? []).find((t) => {
    const g = parseRange(t.ref);
    return !!g && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1;
  });
}

/**
 * 표 만들기: the range becomes an Excel table (ListObject) named 표1, 표2 … with the style picked; its first row holds
 * the column names (머리글 포함), else a header row of 열1, 열2 … goes in at the top, only the table's cells
 * shifted down (Excel). Header names are made unique as Excel does (이름, 이름2). The sheet's AutoFilter over it gives way to the
 * table's own. Returns the table's name.
 */
export function createTable(pageId: string, g: Rect, header: boolean, style = "TableStyleMedium2"): string | null {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return null;
  if ((sh.tables ?? []).some((x) => {
    const tg = parseRange(x.ref);
    return !!tg && overlaps(tg, g);
  })) {
    st.notify(t("sheetx.table.overlap"));
    return null;
  }
  const used = new Set(bookPages(st.doc, page!).flatMap((p) => p.sheet?.tables ?? []).map((x) => x.name.toLowerCase()));
  const base = t("sheetx.table.base");
  let n = 1;
  while (used.has(`${base}${n}`.toLowerCase())) n++;
  const name = `${base}${n}`;
  let area = g;
  let insert = false;
  if (!header) {
    // Excel: a header row of 열1, 열2 … goes in at the top, the data cells shifted down one row
    insert = true;
    area = { ...g, r1: g.r1 + 1 };
  }
  const shift: StructOp = { axis: "row", at: g.r0, n: 1, band: [g.c0, g.c1] };
  if (insert && insertWouldLoseData(sh, shift)) return void st.notify(t("sheet.insertLoses")), null;
  const ok = bookEdit(pageId, t("sheetx.table.h"), (sheets, ti) => {
    // the header row goes in above the data: only the table's cells move down (Excel), not the whole row
    if (insert) applyStructToBook(sheets, ti, shift);
    const s = sheets[ti];
    const cols: string[] = [];
    const seen = new Set<string>();
    for (let c = area.c0; c <= area.c1; c++) {
      const a = addr(area.r0, c);
      let nm = header ? shownText(s, s.cells[a], lang()).trim() : "";
      if (!nm) nm = t("sheetx.table.col", { n: c - area.c0 + 1 });
      let u = nm;
      for (let k = 2; seen.has(u.toLowerCase()); k++) u = `${nm}${k}`;
      seen.add(u.toLowerCase());
      cols.push(u);
      // header cells hold the names as text (Excel's table header)
      const old = s.cells[a];
      s.cells[a] = { ...(old?.s ? { s: old.s } : {}), v: u };
    }
    (s.tables ??= []).push({ name, ref: rangeText(area), cols, style, filter: { ref: rangeText(area) } });
    const fg = s.filter && parseRange(s.filter.ref);
    if (fg && overlaps(fg, area)) delete s.filter;
  });
  if (!ok) return null;
  setSel(pageId, { ar: area.r0, ac: area.c0, r0: area.r0, c0: area.c0, r1: area.r1, c1: area.c1 });
  return name;
}

/** 표 디자인: the style of the table at a cell (and its banded rows / totals row). */
export function setTableStyle(pageId: string, r: number, c: number, patch: Partial<Pick<SheetTable, "style" | "rowStripes" | "totals">>) {
  edit(pageId, t("sheetx.table.h"), (sh) => {
    const tb = tableAt(sh, r, c);
    if (tb) Object.assign(tb, patch);
  });
}

// ───── outline (데이터 ▸ 그룹 · 그룹 해제 · 세부 정보 표시/숨기기) ─────

/** 그룹 (Alt+Shift+→) / 그룹 해제 (Alt+Shift+←): the lines of `g` one outline level deeper / shallower. */
export function groupLines(pageId: string, axis: "row" | "col", g: Rect, by: 1 | -1) {
  const sh = sheetOf(pageId);
  if (!sh) return;
  const [a, b] = axis === "row" ? [g.r0, Math.min(g.r1, g.r0 + 100000)] : [g.c0, Math.min(g.c1, g.c0 + 16384)];
  const key = axis === "row" ? "rowLevel" : "colLevel";
  const cur = sh[key] ?? {};
  if (by < 0 && !Array.from({ length: b - a + 1 }, (_, i) => cur[a + i]).some(Boolean)) return void S().notify(t("sheetx.group.none"));
  if (by > 0 && Array.from({ length: b - a + 1 }, (_, i) => cur[a + i] ?? 0).some((v) => v >= 7)) return void S().notify(t("sheetx.group.max"));
  edit(pageId, t(by > 0 ? "sheetx.group.h" : "sheetx.ungroup.h"), (s) => {
    const lv = { ...(s[key] ?? {}) };
    const hidden = new Set(axis === "row" ? (s.hiddenRows ?? []) : (s.hiddenCols ?? []));
    for (let i = a; i <= b; i++) {
      const v = Math.max(0, Math.min(7, (lv[i] ?? 0) + by));
      if (v) lv[i] = v;
      else {
        delete lv[i];
        hidden.delete(i); // lines leaving every group are shown (Excel)
      }
    }
    if (Object.keys(lv).length) s[key] = lv;
    else delete s[key];
    const list = [...hidden].sort((x, y) => x - y);
    if (axis === "row") list.length ? (s.hiddenRows = list) : delete s.hiddenRows;
    else list.length ? (s.hiddenCols = list) : delete s.hiddenCols;
  });
}

/** The lines of the group a line belongs to (or, on a summary line just after a group, that group). */
function groupBlock(levels: Record<number, number>, at: number): { a: number; b: number; level: number } | null {
  let p = at;
  let level = levels[p] ?? 0;
  if (!level && (levels[at - 1] ?? 0) > 0) {
    p = at - 1;
    level = levels[p];
  }
  if (!level) return null;
  let a = p, b = p;
  while ((levels[a - 1] ?? 0) >= level) a--;
  while ((levels[b + 1] ?? 0) >= level) b++;
  return { a, b, level };
}

/** 세부 정보 숨기기 / 표시 (and the outline bar's − / +): the group at the active line folded or unfolded. */
export function showDetail(pageId: string, axis: "row" | "col", at: number, show: boolean) {
  const sh = sheetOf(pageId);
  if (!sh) return;
  const blk = groupBlock((axis === "row" ? sh.rowLevel : sh.colLevel) ?? {}, at);
  if (!blk) return void S().notify(t("sheetx.group.none"));
  edit(pageId, t(show ? "sheetx.detail.show" : "sheetx.detail.hide"), (s) => {
    const levels = (axis === "row" ? s.rowLevel : s.colLevel) ?? {};
    const hidden = new Set(axis === "row" ? (s.hiddenRows ?? []) : (s.hiddenCols ?? []));
    for (let i = blk.a; i <= blk.b; i++) {
      if (!show) hidden.add(i);
      // unfolding shows this level; groups deeper inside stay as they were folded (Excel)
      else if ((levels[i] ?? 0) <= blk.level || !hidden.has(i)) hidden.delete(i);
    }
    if (show) for (let i = blk.a; i <= blk.b; i++) if ((levels[i] ?? 0) > blk.level) hidden.delete(i);
    const list = [...hidden].sort((x, y) => x - y);
    if (axis === "row") list.length ? (s.hiddenRows = list) : delete s.hiddenRows;
    else list.length ? (s.hiddenCols = list) : delete s.hiddenCols;
  });
}

/** The outline bar's level buttons 1 2 3 …: lines deeper than `n` folded, the others shown. */
export function showLevel(pageId: string, axis: "row" | "col", n: number) {
  edit(pageId, t("sheetx.detail.show"), (s) => {
    const levels = (axis === "row" ? s.rowLevel : s.colLevel) ?? {};
    const hidden = new Set(axis === "row" ? (s.hiddenRows ?? []) : (s.hiddenCols ?? []));
    for (const [k, v] of Object.entries(levels)) {
      if (v >= n) hidden.add(Number(k));
      else hidden.delete(Number(k));
    }
    const list = [...hidden].sort((x, y) => x - y);
    if (axis === "row") list.length ? (s.hiddenRows = list) : delete s.hiddenRows;
    else list.length ? (s.hiddenCols = list) : delete s.hiddenCols;
  });
}

// ───── 부분합 (데이터 ▸ 부분합) ─────

/** Excel's SUBTOTAL function numbers the 부분합 dialog offers: 합계 9, 개수 3, 평균 1, 최대 4, 최소 5, 곱 6 … */
export const SUBTOTAL_FNS = [9, 3, 1, 4, 5, 6, 2, 7, 8, 10, 11];

/**
 * 부분합: the list `g` (header row first, sorted by the column `by`) gets a row under each group of equal `by` values
 * with =SUBTOTAL(fn, …) for the columns `cols` and its label ("서울 요약"), and a grand total row (총합계) under all;
 * rows are grouped into the outline (details level 2, group totals level 1). One undo step.
 */
export function subtotals(pageId: string, g: Rect, by: number, fn: number, cols: number[]) {
  const sh = sheetOf(pageId);
  if (!sh || g.r1 <= g.r0) return;
  const key = (r: number) => shownText(sh, sh.cells[addr(r, by)], lang());
  const groups: { a: number; b: number; k: string }[] = [];
  for (let r = g.r0 + 1; r <= g.r1; r++) {
    const k = key(r);
    const last = groups[groups.length - 1];
    if (last && last.k === k) last.b = r;
    else groups.push({ a: r, b: r, k });
  }
  bookEdit(pageId, t("sheetx.sub.h"), (sheets, ti, lines) => {
    // from the bottom group up, so the rows above keep their numbers
    for (let i = groups.length - 1; i >= 0; i--) {
      const gr = groups[i];
      lines({ axis: "row", at: gr.b + 1, n: 1 });
      const s = sheets[ti];
      const r = gr.b + 1;
      s.cells[addr(r, by)] = { v: t("sheetx.sub.label", { v: gr.k }) };
      for (const c of cols) s.cells[addr(r, c)] = { f: `SUBTOTAL(${fn},${colLetters(c)}${gr.a + 1}:${colLetters(c)}${gr.b + 1})` };
    }
    const s = sheets[ti];
    const last = g.r1 + groups.length; // the last row now (a group total)
    const total = last + 1;
    lines({ axis: "row", at: total, n: 1 });
    s.cells[addr(total, by)] = { v: t("sheetx.sub.grand") };
    for (const c of cols) s.cells[addr(total, c)] = { f: `SUBTOTAL(${fn},${colLetters(c)}${g.r0 + 2}:${colLetters(c)}${last + 1})` };
    // outline: each group's rows and its total; the details one level deeper
    const lv = { ...(s.rowLevel ?? {}) };
    let off = 0;
    for (const gr of groups) {
      for (let r = gr.a + off; r <= gr.b + off; r++) lv[r] = 2;
      lv[gr.b + off + 1] = 1;
      off++;
    }
    s.rowLevel = lv;
  });
}

// ───── 목표값 찾기 (데이터 ▸ 가상 분석) ─────

/**
 * 목표값 찾기: the value of `changing` (a number cell) that makes the formula cell `set` equal `target` — the secant
 * method on the recalculated book, at most 100 steps to within 0.001 (Excel's defaults). Nothing is changed; the
 * result is applied with setCells by the dialog when the person keeps it.
 */
export function goalSeek(pageId: string, set: string, target: number, changing: string): { found: boolean; x: number; y: number } | null {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return null;
  const pages = bookPages(st.doc, page);
  const ti = pages.findIndex((p) => p.id === pageId);
  const base = pages.map((p) => p.sheet!);
  const f = (x: number): number => {
    const sheets = base.map((s) => clone(s)) as SheetData[];
    sheets[ti].cells[changing] = { ...(sheets[ti].cells[changing] ?? {}), v: x };
    delete sheets[ti].cells[changing].t;
    const book = new Book(sheets);
    book.lang = lang();
    for (const ch of book.recalc()) applyChange(sheets[ch.sheet], ch);
    const v = sheets[ti].cells[set]?.v;
    return typeof v === "number" ? v : NaN;
  };
  const x0v = page.sheet.cells[changing]?.v;
  let x0 = typeof x0v === "number" ? x0v : 0;
  let x1 = x0 === 0 ? 1 : x0 * 1.1;
  let y0 = f(x0) - target, y1 = f(x1) - target;
  for (let i = 0; i < 100 && Number.isFinite(y1); i++) {
    if (Math.abs(y1) <= 0.001) return { found: true, x: x1, y: y1 + target };
    const d = y1 - y0;
    if (d === 0) break;
    const x2 = x1 - (y1 * (x1 - x0)) / d;
    x0 = x1;
    y0 = y1;
    x1 = x2;
    y1 = f(x1) - target;
  }
  return { found: Number.isFinite(y1) && Math.abs(y1) <= 0.001, x: x1, y: y1 + target };
}

// ───── 수식 추적 · 오류 검사 (수식 ▸ 수식 분석) ─────

/** Arrows 참조되는 셀 추적 / 참조하는 셀 추적 drew (page → arrows from a cell / range to a cell). */
export const useTrace = create<{ arrows: Record<string, { from: Rect; to: { r: number; c: number } }[]> }>(() => ({ arrows: {} }));

function refsOf(ast: Ast, out: Rect[]) {
  switch (ast.k) {
    case "ref":
      if (!ast.sheet) out.push({ r0: ast.r0, c0: ast.c0, r1: ast.r1, c1: ast.c1 });
      break;
    case "fn":
      ast.args.forEach((a) => refsOf(a, out));
      break;
    case "un":
    case "pct":
      refsOf(ast.a, out);
      break;
    case "bin":
      refsOf(ast.a, out);
      refsOf(ast.b, out);
      break;
    case "arr":
      ast.rows.forEach((row) => row.forEach((a) => refsOf(a, out)));
      break;
  }
}

/** The ranges a cell's formula refers to on its own sheet. */
export function precedentsOf(sh: SheetData, r: number, c: number): Rect[] {
  const f = sh.cells[addr(r, c)]?.f;
  if (!f) return [];
  const out: Rect[] = [];
  try {
    refsOf(parseFormula(f), out);
  } catch {
    /* a formula the reader does not follow */
  }
  return out;
}

/** 참조되는 셀 추적 (precedents: arrows into the cell) / 참조하는 셀 추적 (dependents: arrows out of it). */
export function trace(pageId: string, r: number, c: number, dependents: boolean): number {
  const sh = sheetOf(pageId);
  if (!sh) return 0;
  const add: { from: Rect; to: { r: number; c: number } }[] = [];
  if (!dependents) for (const g of precedentsOf(sh, r, c)) add.push({ from: g, to: { r, c } });
  else
    for (const a of Object.keys(sh.cells)) {
      const p = parseAddr(a);
      if (!p || !sh.cells[a].f) continue;
      if (precedentsOf(sh, p.r, p.c).some((g) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1)) add.push({ from: { r0: r, c0: c, r1: r, c1: c }, to: p });
    }
  if (!add.length) return void S().notify(t(dependents ? "sheetx.trace.noDep" : "sheetx.trace.noPrec")), 0;
  useTrace.setState((s) => ({ arrows: { ...s.arrows, [pageId]: [...(s.arrows[pageId] ?? []), ...add] } }));
  return add.length;
}

/** 연결선 제거. */
export const clearTrace = (pageId: string) => useTrace.setState((s) => ({ arrows: { ...s.arrows, [pageId]: [] } }));

/** 오류 검사: the next cell after (r, c) (row by row, wrapping) whose value is an error, or null. */
export function nextError(sh: SheetData, r: number, c: number, back = false): { r: number; c: number; err: string } | null {
  const errs = Object.entries(sh.cells)
    .filter(([, x]) => x.t === "e" && !x.sp)
    .map(([a, x]) => ({ ...parseAddr(a)!, err: String(x.v) }))
    .sort((p, q) => p.r - q.r || p.c - q.c);
  if (!errs.length) return null;
  const after = (p: { r: number; c: number }) => p.r > r || (p.r === r && p.c > c);
  if (back) return [...errs].reverse().find((p) => !after(p) && !(p.r === r && p.c === c)) ?? errs[errs.length - 1];
  return errs.find(after) ?? errs[0];
}

// ───── 지우기 (홈 ▸ 편집) ─────

/** 모두 지우기 · 서식 지우기 · 메모 지우기 · 하이퍼링크 지우기 (내용 지우기 = clearRange) for the range. */
export function clearWhat(pageId: string, g: Rect, what: "all" | "formats" | "notes" | "links") {
  const inside = (a: string) => {
    const p = parseAddr(a);
    return !!p && p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1;
  };
  const rest = (sh: SheetData) => {
    if ((what === "all" || what === "notes") && sh.notes) for (const a of Object.keys(sh.notes)) if (inside(a)) delete sh.notes[a];
    if ((what === "all" || what === "links") && sh.links) for (const a of Object.keys(sh.links)) if (inside(a)) delete sh.links[a];
    if (what === "all" || what === "formats") sh.merges = sh.merges.filter((m) => !inside(m.split(":")[0]));
  };
  // 모두 지우기 empties the cells through setCells, so the formulas that used them recalculate (one undo step)
  const cur = sheetOf(pageId);
  if (what === "all" && cur) {
    const edits = Object.keys(cur.cells).filter(inside).map((a) => ({ a, cell: undefined }));
    if (edits.length) return setCells(pageId, edits, t("sheetx.clear.all"), rest);
  }
  edit(pageId, t(`sheetx.clear.${what}`), (sh) => {
    if (what === "all" || what === "formats")
      for (const [a, cell] of Object.entries(sh.cells)) {
        if (!inside(a)) continue;
        if (what === "all") delete sh.cells[a];
        else if (cell.s) {
          delete cell.s;
          if (cell.v === undefined && !cell.f) delete sh.cells[a];
        }
      }
    rest(sh);
  });
}

// ───── 시트 탭 (오른쪽 클릭) ─────

/** 시트 삭제: the sheet page goes; formulas of the other sheets that used it show #REF! (Excel). */
export function deleteSheet(pageId: string): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  if (page.sheet.bookProtect) return void st.notify(t("sheetx.protect.bookLocked")), false;
  const pages = bookPages(st.doc, page);
  if (pages.filter((p) => !p.sheet!.hidden).length <= 1) return void st.notify(t("sheetx.tab.lastOne")), false;
  const name = page.sheet.name;
  const q = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ref = new RegExp(`(?:'${q.replace(/'/g, "''")}'|${/^[A-Za-z_][\w.]*$/.test(name) ? q : "(?!)"})!\\$?[A-Za-z]{1,3}\\$?\\d+(?::\\$?[A-Za-z]{1,3}\\$?\\d+)?`, "gi");
  st.commit(t("sheetx.tab.delete"), (d) => {
    for (const p of pages) {
      if (p.id === pageId) continue;
      const dp = draftPage(d, p.id);
      if (!dp?.sheet) continue;
      for (const c of Object.values(dp.sheet.cells)) if (c.f && c.f.includes("!")) c.f = c.f.replace(ref, "#REF!");
    }
    const i = d.pages.findIndex((p) => p.id === pageId);
    if (i >= 0) d.pages.splice(i, 1);
  });
  const next = pages.find((p) => p.id !== pageId && !p.sheet!.hidden);
  if (next) S().set({ pageId: next.id });
  return true;
}

/** 탭 색 (null = 색 없음). */
export const setTabColor = (pageId: string, color: string | null) =>
  edit(pageId, t("sheetx.tab.color"), (sh) => {
    if (color) sh.tabColor = color;
    else delete sh.tabColor;
  });

/** 숨기기 / 숨기기 취소 of a sheet (one sheet stays shown). */
export function hideSheet(pageId: string, hide: boolean): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  if (page.sheet.bookProtect) return void st.notify(t("sheetx.protect.bookLocked")), false;
  const pages = bookPages(st.doc, page);
  if (hide && pages.filter((p) => !p.sheet!.hidden).length <= 1) return void st.notify(t("sheetx.tab.lastOne")), false;
  edit(pageId, t(hide ? "sheetx.tab.hide" : "sheetx.tab.unhide"), (sh) => {
    if (hide) sh.hidden = true;
    else delete sh.hidden;
  });
  if (hide) {
    const next = pages.find((p) => p.id !== pageId && !p.sheet!.hidden);
    if (next) S().set({ pageId: next.id });
  } else S().set({ pageId });
  return true;
}

/** 이동: the sheet one place to the left / right among the book's sheets. */
export function moveSheet(pageId: string, by: -1 | 1): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return false;
  if (page.sheet.bookProtect) return void st.notify(t("sheetx.protect.bookLocked")), false;
  const pages = bookPages(st.doc, page);
  const i = pages.findIndex((p) => p.id === pageId);
  const j = i + by;
  if (j < 0 || j >= pages.length) return false;
  const other = pages[j].id;
  st.commit(t("sheetx.tab.move"), (d) => {
    const a = d.pages.findIndex((p) => p.id === pageId), b = d.pages.findIndex((p) => p.id === other);
    if (a < 0 || b < 0) return;
    const [x] = d.pages.splice(a, 1);
    d.pages.splice(b, 0, x);
  });
  return true;
}

// ───── 스파크라인 (삽입 ▸ 스파크라인) ─────

/**
 * 스파크라인 만들기: one sparkline per cell of the location range, each over the matching row (or column) of the
 * data range — B2:B4 over C2:H4 draws C2:H2 in B2, C3:H3 in B3 … (Excel). False when the ranges do not match.
 */
export function addSparklines(pageId: string, data: string, loc: string, type: "line" | "column" | "stacked"): boolean {
  const sh = sheetOf(pageId);
  if (!sh) return false;
  const bang = data.lastIndexOf("!");
  const prefix = bang > 0 ? data.slice(0, bang + 1) : `${/^[A-Za-z_][\w.]*$/.test(sh.name) ? sh.name : `'${sh.name.replace(/'/g, "''")}'`}!`;
  const dg = parseRange(data.slice(bang + 1).replace(/\$/g, "").toUpperCase());
  const lg = parseRange(loc.replace(/\$/g, "").replace(/^.*!/, "").toUpperCase());
  if (!dg || !lg) return false;
  const n = (lg.r1 - lg.r0 + 1) * (lg.c1 - lg.c0 + 1);
  const rows = dg.r1 - dg.r0 + 1, cols = dg.c1 - dg.c0 + 1;
  const items: { at: string; ref: string }[] = [];
  if (n === 1) items.push({ at: addr(lg.r0, lg.c0), ref: prefix + rangeText(dg) });
  else if (lg.c0 === lg.c1 && rows === n) for (let i = 0; i < n; i++) items.push({ at: addr(lg.r0 + i, lg.c0), ref: prefix + rangeText({ r0: dg.r0 + i, r1: dg.r0 + i, c0: dg.c0, c1: dg.c1 }) });
  else if (lg.r0 === lg.r1 && cols === n) for (let i = 0; i < n; i++) items.push({ at: addr(lg.r0, lg.c0 + i), ref: prefix + rangeText({ r0: dg.r0, r1: dg.r1, c0: dg.c0 + i, c1: dg.c0 + i }) });
  else return false;
  edit(pageId, t("sheetx.spark.h"), (s) => {
    const at = new Set(items.map((x) => x.at));
    // a cell holds one sparkline: the new group takes the cells over
    const kept = (s.sparks ?? []).map((g) => ({ ...g, items: g.items.filter((x) => !at.has(x.at)) })).filter((g) => g.items.length);
    s.sparks = [...kept, { type, color: type === "stacked" ? "#376092" : "#376092", ...(type !== "line" ? { negColor: "#D00000" } : {}), items }];
  });
  return true;
}

/** 스파크라인 지우기: the sparklines in the range. */
export function clearSparklines(pageId: string, g: Rect) {
  edit(pageId, t("sheetx.spark.clear"), (s) => {
    const inside = (a: string) => {
      const p = parseAddr(a);
      return !!p && p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1;
    };
    const left = (s.sparks ?? []).map((x) => ({ ...x, items: x.items.filter((it) => !inside(it.at)) })).filter((x) => x.items.length);
    if (left.length) s.sparks = left;
    else delete s.sparks;
  });
}

/** The outline bar's − / +: the lines a..b of a group folded (hidden) or unfolded (shown). */
export function setGroupShown(pageId: string, axis: "row" | "col", a: number, b: number, show: boolean) {
  edit(pageId, t(show ? "sheetx.detail.show" : "sheetx.detail.hide"), (s) => {
    const hidden = new Set(axis === "row" ? (s.hiddenRows ?? []) : (s.hiddenCols ?? []));
    for (let i = a; i <= b; i++) show ? hidden.delete(i) : hidden.add(i);
    const list = [...hidden].sort((x, y) => x - y);
    if (axis === "row") list.length ? (s.hiddenRows = list) : delete s.hiddenRows;
    else list.length ? (s.hiddenCols = list) : delete s.hiddenCols;
  });
}

/** Every group of an outline: level, first and last line (runs of lines at that level or deeper). */
export function outlineGroups(levels: Record<number, number> | undefined): { level: number; a: number; b: number }[] {
  const keys = Object.keys(levels ?? {}).map(Number).sort((x, y) => x - y);
  const max = Math.max(0, ...keys.map((k) => levels![k]));
  const out: { level: number; a: number; b: number }[] = [];
  for (let L = 1; L <= max; L++) {
    let run: { a: number; b: number } | null = null;
    for (const k of keys) {
      if (levels![k] < L) continue;
      if (run && k === run.b + 1) run.b = k;
      else {
        if (run) out.push({ level: L, ...run });
        run = { a: k, b: k };
      }
    }
    if (run) out.push({ level: L, ...run });
  }
  return out;
}

// ───── 슬라이서 (삽입 ▸ 슬라이서) ─────

/** The page holding a sheet of the book by name. */
function pageOfSheet(pageId: string, name: string): Page | undefined {
  const st = S();
  const page = findPage(st.doc, pageId);
  return page ? bookPages(st.doc, page).find((p) => p.sheet!.name === name) : undefined;
}

/** The table (and its page) a slicer filters, or the pivot (its page and index). */
function slicerTarget(pageId: string, s: SheetSlicer): { kind: "table"; page: Page; table: SheetTable; col: number } | { kind: "pivot"; page: Page; pivot: SheetPivot; index: number } | null {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page) return null;
  if ("table" in s.source) {
    const src = s.source;
    for (const p of bookPages(st.doc, page)) {
      const tb = p.sheet!.tables?.find((x) => x.name === src.table);
      if (tb) return { kind: "table", page: p, table: tb, col: tb.cols.indexOf(src.col) };
    }
    return null;
  }
  const src = s.source;
  const pp = pageOfSheet(pageId, src.pivotSheet);
  const index = pp?.sheet!.pivots?.findIndex((x) => x.at === src.pivotAt) ?? -1;
  return pp && index >= 0 ? { kind: "pivot", page: pp, pivot: pp.sheet!.pivots![index], index } : null;
}

/** The items a slicer shows (the column's / field's distinct texts, sorted) and which are picked (null = all). */
export function slicerState(pageId: string, s: SheetSlicer): { items: string[]; picked: Set<string> | null } | null {
  const tg = slicerTarget(pageId, s);
  if (!tg) return null;
  const sort = (xs: string[]) => [...new Set(xs)].sort((a, b) => (a !== "" && b !== "" && Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b, lang())));
  if (tg.kind === "table") {
    const sh = tg.page.sheet!;
    const g = parseRange(tg.table.ref);
    if (!g || tg.col < 0) return null;
    const vals: string[] = [];
    for (let r = g.r0 + (tg.table.noHeader ? 0 : 1); r <= g.r1 - (tg.table.totals ? 1 : 0); r++) vals.push(shownText(sh, sh.cells[addr(r, g.c0 + tg.col)], lang()));
    const f = tg.table.filter?.cols?.[tg.col];
    return { items: sort(vals), picked: f?.vals ? new Set(f.vals) : null };
  }
  const p = tg.pivot;
  const srcPage = pageOfSheet(pageId, p.sheet);
  const data = srcPage && sourceRows(srcPage.sheet!, p.ref);
  if (!data) return null;
  const k = data.head.indexOf("field" in s.source ? s.source.field : "");
  if (k < 0) return null;
  const pick = p.show?.["field" in s.source ? s.source.field : ""];
  return { items: sort(data.rows.map((r) => String(r[k] ?? ""))), picked: pick ? new Set(pick) : null };
}

/** A slicer's pick: these items only (null = all, 필터 지우기) — the table's AutoFilter, or the pivot refreshed. */
export function pickSlicer(pageId: string, s: SheetSlicer, items: string[] | null) {
  const tg = slicerTarget(pageId, s);
  if (!tg) return;
  if (tg.kind === "table") return setFilterColumn(tg.page.id, tg.col, items, false, tg.table.name);
  const field = "field" in s.source ? s.source.field : "";
  const show = { ...(tg.pivot.show ?? {}) };
  if (items) show[field] = items;
  else delete show[field];
  writePivot(tg.page.id, { ...tg.pivot, show: Object.keys(show).length ? show : undefined }, tg.index);
}

/** The fields a slicer can be made for at the active cell: a table's columns or a pivot's fields (and which). */
export function slicerSourceAt(pageId: string): { table?: SheetTable; pivot?: SheetPivot; fields: string[] } | null {
  const sh = sheetOf(pageId);
  if (!sh) return null;
  const s = selOf(pageId);
  const tb = tableAt(sh, s.ar, s.ac);
  if (tb) return { table: tb, fields: [...tb.cols] };
  const p = (sh.pivots ?? []).find((x) => {
    const g = parseRange(x.area ?? x.out ?? "");
    return !!g && s.ar >= g.r0 && s.ar <= g.r1 && s.ac >= g.c0 && s.ac <= g.c1;
  });
  if (!p) return null;
  const srcPage = pageOfSheet(pageId, p.sheet);
  const data = srcPage && sourceRows(srcPage.sheet!, p.ref);
  return data ? { pivot: p, fields: data.head } : null;
}

/** 슬라이서 삽입: one slicer per field, side by side to the right of the table / pivot (names unique in the book). */
export function insertSlicers(pageId: string, fields: string[]): number {
  const st = S();
  const page = findPage(st.doc, pageId);
  const src = slicerSourceAt(pageId);
  if (!page?.sheet || !src || !fields.length) return 0;
  const all = bookPages(st.doc, page).flatMap((p) => p.sheet!.slicers ?? []);
  const names = new Set(all.map((x) => x.name.toLowerCase())), caches = new Set(all.map((x) => x.cache.toLowerCase()));
  const area = parseRange(src.table ? src.table.ref : src.pivot!.area ?? src.pivot!.out ?? "A1")!;
  const add: SheetSlicer[] = fields.map((f, i) => {
    let name = f;
    for (let k = 1; names.has(name.toLowerCase()); k++) name = `${f} ${k}`;
    names.add(name.toLowerCase());
    const base = `${t("sheetx.slicer.prefix")}${f.replace(/[^\p{L}\p{N}_]/gu, "_")}`;
    let cache = base;
    for (let k = 1; caches.has(cache.toLowerCase()); k++) cache = `${base}${k}`;
    caches.add(cache.toLowerCase());
    const source: SheetSlicer["source"] = src.table ? { table: src.table.name, col: f } : { pivotSheet: page.sheet!.name, pivotAt: src.pivot!.at, field: f };
    return { name, cache, caption: f, source, at: { c0: area.c1 + 2 + i * 3, x0: 0, r0: area.r0, y0: 0, w: 180, h: 220 } };
  });
  edit(pageId, t("sheetx.slicer.h"), (sh) => {
    sh.slicers = [...(sh.slicers ?? []), ...add];
  });
  return add.length;
}

/** A slicer moved (끌기) or deleted (Delete). */
export function moveSlicer(pageId: string, name: string, at: SheetSlicer["at"]) {
  edit(pageId, t("sheetx.slicer.h"), (sh) => {
    const s = sh.slicers?.find((x) => x.name === name);
    if (s) s.at = at;
  });
}
export function deleteSlicer(pageId: string, name: string) {
  edit(pageId, t("sheetx.slicer.delete"), (sh) => {
    sh.slicers = (sh.slicers ?? []).filter((x) => x.name !== name);
    if (!sh.slicers.length) delete sh.slicers;
  });
}

// ───── 그림 (삽입 ▸ 그림) ─────

/** A picture file put on the sheet at the active cell, at its own size (fitted into 480 px, as Excel's large pictures). */
export async function insertPicture(pageId: string, file: File): Promise<boolean> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || (/\.png$/i.test(file.name) ? "image/png" : "image/jpeg");
  let w = 240, h = 180;
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const k = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    w = Math.round(bmp.width * k);
    h = Math.round(bmp.height * k);
    bmp.close();
  } catch {
    /* a picture the browser cannot decode keeps the default box */
  }
  const s = selOf(pageId);
  edit(pageId, t("sheetx.pic.h"), (sh) => {
    const n = (sh.drawings ?? []).filter((d) => d.kind === "pic").length + 1;
    sh.drawings = [...(sh.drawings ?? []), { kind: "pic", name: `${t("sheetx.pic.name")} ${n}`, at: { c0: s.ac, x0: 0, r0: s.ar, y0: 0, w, h }, data: bytes, mime }];
  });
  return true;
}

// ───── 이동/복사 (시트 탭) · 이동 옵션 · 채우기 ▸ 계열 ─────

/**
 * 이동/복사: the sheet put before `beforeId` (null = at the end); `copy` makes a copy named "Sheet1 (2)" (Excel)
 * with its cells, formats, sizes, merges, rules and page setup — a copy leaves out the file's tables, pivots,
 * slicers and chart parts (names that must stay unique in a workbook).
 */
export function moveCopySheet(pageId: string, beforeId: string | null, copy: boolean): string | null {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return null;
  if (sh.bookProtect) return void st.notify(t("sheetx.protect.bookLocked")), null;
  const pages = bookPages(st.doc, page!);
  if (!copy) {
    if (beforeId === pageId) return pageId;
    st.commit(t("sheetx.tab.move"), (d) => {
      const a = d.pages.findIndex((p) => p.id === pageId);
      const [x] = d.pages.splice(a, 1);
      const b = beforeId ? d.pages.findIndex((p) => p.id === beforeId) : d.pages.findIndex((p) => p.id === pages[pages.length - 1].id) + (pages[pages.length - 1].id === pageId ? 0 : 1);
      d.pages.splice(b < 0 ? d.pages.length : b, 0, x);
    });
    return pageId;
  }
  const names = new Set(pages.map((p) => p.sheet!.name.toLowerCase()));
  const base = sh.name.replace(/ \(\d+\)$/, "");
  let n = 2;
  while (names.has(`${base} (${n})`.toLowerCase())) n++;
  const dup = structuredClone(sh) as SheetData;
  dup.name = `${base} (${n})`.slice(0, 31);
  delete dup.tables;
  delete dup.pivots;
  delete dup.slicers;
  dup.drawings = (dup.drawings ?? []).filter((d) => d.kind === "pic" ? !!d.data : !!d.spec).map((d) => ({ ...d, part: undefined, anchorIx: undefined }));
  if (!dup.drawings.length) delete dup.drawings;
  const [np] = sheetPages([dup], page!.source?.name ?? "", page!.source?.format ?? "xlsx");
  if (page!.source) np.source = { format: page!.source.format, name: page!.source.name };
  else delete np.source;
  st.commit(t("sheetx.mc.copyH"), (d) => {
    const last = pages[pages.length - 1].id;
    const b = beforeId ? d.pages.findIndex((p) => p.id === beforeId) : d.pages.findIndex((p) => p.id === last) + 1;
    d.pages.splice(b < 0 ? d.pages.length : b, 0, np as (typeof d.pages)[number]);
  });
  st.set({ pageId: np.id });
  return np.id;
}

/** 이동 옵션 (Go To Special): the cells of a kind, in the selection when it is more than one cell, else the used range. */
export type GoSpecial = "blanks" | "constants" | "formulas" | "notes" | "lastCell" | "region" | "cond" | "validation";
export function goSpecial(pageId: string, kind: GoSpecial): boolean {
  const sh = sheetOf(pageId);
  if (!sh) return false;
  const s = selOf(pageId);
  const u = usedRange(sh);
  if (kind === "lastCell") return setSel(pageId, one(u.r1, u.c1)), true;
  if (kind === "region") {
    const r = currentRegion(sh, s.ar, s.ac);
    return setSel(pageId, { ar: s.ar, ac: s.ac, ...r }), true;
  }
  const g0 = norm(s);
  const g = g0.r0 === g0.r1 && g0.c0 === g0.c1 ? { r0: 0, c0: 0, r1: u.r1, c1: u.c1 } : { ...g0, r1: Math.min(g0.r1, u.r1), c1: Math.min(g0.c1, u.c1) };
  const inRanges = (list: string[] | undefined, r: number, c: number) => (list ?? []).some((x) => x.split(/\s+/).some((y) => { const q = parseRange(y); return !!q && r >= q.r0 && r <= q.r1 && c >= q.c0 && c <= q.c1; }));
  const hit = (r: number, c: number): boolean => {
    const a = addr(r, c);
    const cell = sh.cells[a];
    switch (kind) {
      case "blanks": return !cell || (cell.v === undefined || cell.v === "") && !cell.f;
      case "constants": return !!cell && cell.v !== undefined && cell.v !== "" && !cell.f;
      case "formulas": return !!cell?.f;
      case "notes": return !!sh.notes?.[a];
      case "cond": return inRanges(sh.cond?.map((x) => x.ranges.join(" ")), r, c);
      case "validation": return inRanges(sh.valid?.map((v) => v.ranges.join(" ")), r, c);
    }
    return false;
  };
  // the hits as rectangles: runs along each row, stacked when the next row has the same run
  const rects: Rect[] = [];
  let open: Rect[] = [];
  for (let r = g.r0; r <= g.r1; r++) {
    const runs: Rect[] = [];
    for (let c = g.c0; c <= g.c1; c++) {
      if (!hit(r, c)) continue;
      const last = runs[runs.length - 1];
      if (last && last.c1 === c - 1) last.c1 = c;
      else runs.push({ r0: r, c0: c, r1: r, c1: c });
    }
    const next: Rect[] = [];
    for (const run of runs) {
      const o = open.find((x) => x.c0 === run.c0 && x.c1 === run.c1 && x.r1 === r - 1);
      if (o) (o.r1 = r), next.push(o);
      else next.push(run);
    }
    for (const o of open) if (!next.includes(o)) rects.push(o);
    open = next;
    if (rects.length + open.length > 4000) break;
  }
  rects.push(...open);
  if (!rects.length) return void S().notify(t("sheetx.gs.none")), false;
  rects.sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0);
  const main = rects[0];
  setSel(pageId, { ar: main.r0, ac: main.c0, ...main, more: rects.slice(1) });
  return true;
}

/**
 * 채우기 ▸ 계열: the selection's first cell (or first row / column) carried along by `step` — linear, growth, or a
 * date stepping by days, weekdays, months or years — down the columns or across the rows, up to `stop`.
 */
export function fillSeries(pageId: string, o: { dir: "rows" | "cols"; type: "linear" | "growth" | "date"; unit: "day" | "weekday" | "month" | "year"; step: number; stop?: number }): boolean {
  const sh = sheetOf(pageId);
  if (!sh) return false;
  const g = norm(selOf(pageId));
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const lines = o.dir === "cols" ? g.c1 - g.c0 + 1 : g.r1 - g.r0 + 1;
  const len = o.dir === "cols" ? g.r1 - g.r0 + 1 : g.c1 - g.c0 + 1;
  const at = (line: number, i: number) => (o.dir === "cols" ? addr(g.r0 + i, g.c0 + line) : addr(g.r0 + line, g.c0 + i));
  const addDays = (serial: number, k: number) => {
    // weekdays: Monday–Friday only
    let d = serial;
    for (let n = 0; n < Math.abs(k); ) {
      d += Math.sign(k);
      const wd = (((Math.floor(d) - 1) % 7) + 7) % 7; // 0 = Sunday (serial 1 = 1900-01-01, a Sunday in Excel's calendar)
      if (wd !== 0 && wd !== 6) n++;
    }
    return d;
  };
  const addMonths = (serial: number, k: number) => {
    const dt = new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    const day = dt.getUTCDate();
    const m = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + k, 1));
    const last = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate();
    m.setUTCDate(Math.min(day, last));
    return Math.round((m.getTime() - Date.UTC(1899, 11, 30)) / 86400000) + (serial - Math.floor(serial));
  };
  for (let line = 0; line < lines; line++) {
    const first = sh.cells[at(line, 0)];
    if (typeof first?.v !== "number" || first.f) continue;
    let v = first.v;
    for (let i = 1; i < len; i++) {
      if (o.type === "growth") v *= o.step;
      else if (o.type === "date") v = o.unit === "day" ? v + o.step : o.unit === "weekday" ? addDays(v, o.step) : addMonths(v, o.unit === "month" ? o.step : o.step * 12);
      else v += o.step;
      if (o.stop != null && (o.step >= 0 ? v > o.stop + 1e-9 : v < o.stop - 1e-9)) break;
      const a = at(line, i);
      edits.push({ a, cell: { ...(first.s ? { s: first.s } : {}), v: Math.round(v * 1e10) / 1e10 } });
    }
  }
  if (!edits.length) return false;
  setCells(pageId, edits, t("sheetx.series.h"));
  return true;
}

// ───── 조사식 창 · 수식 계산 · 통합 · 시나리오 · 데이터 표 · 사용자 지정 목록 ─────

/** 조사식 창 (Watch Window): cells kept in view with their value and formula; not saved with the file (Excel). */
export const useWatch = create<{ open: boolean; items: { pageId: string; a: string }[] }>(() => ({ open: false, items: [] }));
export function addWatch(pageId: string) {
  const g = norm(selOf(pageId));
  const add: { pageId: string; a: string }[] = [];
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 50); r++) for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 50); c++) add.push({ pageId, a: addr(r, c) });
  useWatch.setState((s) => ({ open: true, items: [...s.items, ...add.filter((x) => !s.items.some((y) => y.pageId === x.pageId && y.a === x.a))] }));
}

/** A formula worked out in the book as it is now (a scratch cell, nothing changed): its value. */
export function evalIn(pageId: string, expr: string): unknown {
  const st = S();
  const page = findPage(st.doc, pageId);
  if (!page?.sheet) return null;
  const pages = bookPages(st.doc, page);
  const si = pages.findIndex((p) => p.id === pageId);
  const sheets = pages.map((p) => p.sheet!);
  const scratch = "XFD1048576";
  sheets[si] = { ...sheets[si], cells: { ...sheets[si].cells, [scratch]: { f: expr } } };
  const book = new Book(sheets);
  book.lang = lang();
  const ch = book.recalc([`${si}!${scratch}`]).find((x) => x.addr === scratch);
  return ch ? (ch as { v?: unknown }).v ?? null : null;
}

const shown = (v: unknown) => (typeof v === "string" ? (/^#/.test(v) ? v : `"${v}"`) : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : v == null ? "0" : String(v));

/**
 * 수식 계산 (Evaluate Formula): the formula's steps as Excel shows them — each single-cell reference by its value,
 * left to right, then the innermost function calls and the rest, to the result.
 */
export function evalSteps(pageId: string, a: string): string[] {
  const sh = sheetOf(pageId);
  const f = sh?.cells[a]?.f;
  if (!sh || !f) return [];
  let cur = f;
  const steps = ["=" + cur];
  for (let guard = 0; guard < 60; guard++) {
    const toks = tokenize(cur);
    // a single-cell reference (not a range): its value
    let pos = 0, done = false;
    for (const tk of toks) {
      if (tk.t === "ref" && !tk.s.includes(":")) {
        const v = evalIn(pageId, tk.s);
        cur = cur.slice(0, pos) + shown(v) + cur.slice(pos + tk.s.length);
        done = true;
        break;
      }
      pos += tk.s.length;
    }
    if (!done) {
      // the innermost call: a name followed by "(" … ")" with no "(" inside
      const m = /([A-Za-z_][\w.]*)\(([^()]*)\)/.exec(cur);
      if (m) {
        const v = evalIn(pageId, m[0]);
        cur = cur.slice(0, m.index) + shown(v) + cur.slice(m.index + m[0].length);
      } else {
        const v = evalIn(pageId, cur);
        const last = shown(v).replace(/^"(.*)"$/, "$1");
        // the result, shown without "=" (Excel)
        if (last !== cur) steps.push(last);
        else steps[steps.length - 1] = last;
        break;
      }
    }
    steps.push("=" + cur);
    if (steps.length > 60) break;
  }
  return steps;
}

/** 통합 (Data ▸ Consolidate): the references' numbers summed (…) at the active cell, by position or by their labels. */
export type ConsolFn = "sum" | "count" | "average" | "max" | "min" | "product";
export function consolidate(pageId: string, refs: string[], fn: ConsolFn, top: boolean, left: boolean): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return false;
  const pages = bookPages(st.doc, page!);
  const areas: { sh: SheetData; g: Rect }[] = [];
  for (const ref of refs) {
    const bang = ref.lastIndexOf("!");
    const name = bang > 0 ? ref.slice(0, bang).replace(/^'|'$/g, "").replace(/''/g, "'") : null;
    const s2 = name ? pages.find((p) => p.sheet!.name.toLowerCase() === name.toLowerCase())?.sheet : sh;
    const g = parseRange(ref.slice(bang + 1).replace(/\$/g, "").toUpperCase());
    if (!s2 || !g) return void st.notify(t("sheetx.consol.bad")), false;
    areas.push({ sh: s2, g });
  }
  if (!areas.length) return false;
  const rowKeys: string[] = [], colKeys: string[] = [];
  const acc = new Map<string, number[]>();
  const key = (r: string, c: string) => `${r}\u0001${c}`;
  for (const { sh: s2, g } of areas) {
    for (let r = g.r0 + (top ? 1 : 0); r <= g.r1; r++)
      for (let c = g.c0 + (left ? 1 : 0); c <= g.c1; c++) {
        const rk = left ? String(s2.cells[addr(r, g.c0)]?.v ?? "") : String(r - g.r0);
        const ck = top ? String(s2.cells[addr(g.r0, c)]?.v ?? "") : String(c - g.c0);
        if (!rowKeys.includes(rk)) rowKeys.push(rk);
        if (!colKeys.includes(ck)) colKeys.push(ck);
        const v = s2.cells[addr(r, c)]?.v;
        const k = key(rk, ck);
        if (!acc.has(k)) acc.set(k, []);
        if (typeof v === "number") acc.get(k)!.push(v);
        else if (fn === "count" && v !== undefined && v !== "") acc.get(k)!.push(0);
      }
  }
  const agg = (xs: number[]): number | undefined => {
    if (fn === "count") return xs.length;
    if (!xs.length) return undefined;
    switch (fn) {
      case "average": return xs.reduce((a, x) => a + x, 0) / xs.length;
      case "max": return Math.max(...xs);
      case "min": return Math.min(...xs);
      case "product": return xs.reduce((a, x) => a * x, 1);
      default: return Math.round(xs.reduce((a, x) => a + x, 0) * 1e10) / 1e10;
    }
  };
  const s = selOf(pageId);
  const r0 = s.ar, c0 = s.ac;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const at = (r: number, c: number, v: unknown) => {
    const a = addr(r, c);
    const old = sh.cells[a];
    edits.push({ a, cell: v === undefined || v === "" ? (old?.s ? { s: old.s } : undefined) : { ...(old?.s ? { s: old.s } : {}), v: v as number | string } });
  };
  const dr = top ? 1 : 0, dc = left ? 1 : 0;
  if (top) colKeys.forEach((ck, j) => at(r0, c0 + dc + j, isNaN(Number(ck)) || ck === "" ? ck : Number(ck)));
  rowKeys.forEach((rk, i) => {
    if (left) at(r0 + dr + i, c0, isNaN(Number(rk)) || rk === "" ? rk : Number(rk));
    colKeys.forEach((ck, j) => at(r0 + dr + i, c0 + dc + j, agg(acc.get(key(rk, ck)) ?? [])));
  });
  setCells(pageId, edits, t("sheetx.consol.h"));
  return true;
}

/** 시나리오 관리자: add (or replace) a scenario of the changing cells with their values now or given. */
export function saveScenario(pageId: string, name: string, cells: string[], vals: string[], comment?: string, replaceAt?: number) {
  edit(pageId, t("sheetx.scen.h"), (sh) => {
    const list = [...(sh.scenarios?.list ?? [])];
    const x = { name, cells, vals, ...(comment ? { comment } : {}) };
    if (replaceAt != null && list[replaceAt]) list[replaceAt] = x;
    else list.push(x);
    sh.scenarios = { ...(sh.scenarios?.cur != null ? { cur: sh.scenarios.cur } : {}), list };
  });
}
export function deleteScenario(pageId: string, i: number) {
  edit(pageId, t("sheetx.scen.h"), (sh) => {
    const list = (sh.scenarios?.list ?? []).filter((_, k) => k !== i);
    sh.scenarios = list.length ? { list } : undefined;
    if (!list.length) delete sh.scenarios;
  });
}
/** 표시: the scenario's values typed into its cells (one undo step) */
export function showScenario(pageId: string, i: number) {
  const sh = sheetOf(pageId);
  const x = sh?.scenarios?.list[i];
  if (!sh || !x) return;
  const edits = x.cells.map((a, k) => {
    const p = parseInput(x.vals[k] ?? "", sh.styles[sh.cells[a]?.s ?? 0] ?? {});
    const old = sh.cells[a];
    return { a, cell: { ...(old?.s ? { s: old.s } : {}), ...(p.f !== undefined ? { f: p.f } : p.v !== undefined ? { v: p.v } : {}) } as SheetCell };
  });
  setCells(pageId, edits, t("sheetx.scen.show"), (s2) => {
    if (s2.scenarios) s2.scenarios.cur = i;
  });
}
/** 요약: a new sheet "시나리오 요약" — each scenario's changing cells and the result cells worked out with them. */
export function scenarioSummary(pageId: string, results: string[]): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh?.scenarios?.list.length) return false;
  const list = sh.scenarios.list;
  const pages = bookPages(st.doc, page!);
  const si = pages.findIndex((p) => p.id === pageId);
  const valueWith = (cells: string[], vals: string[], a: string) => {
    const sheets = pages.map((p) => JSON.parse(JSON.stringify(p.sheet)) as SheetData);
    cells.forEach((c, k) => {
      const p = parseInput(vals[k] ?? "", {});
      sheets[si].cells[c] = p.f !== undefined ? { f: p.f } : { v: p.v as number | string };
    });
    const book = new Book(sheets);
    book.lang = lang();
    for (const ch of book.recalc()) applyChange(sheets[ch.sheet], ch);
    return sheets[si].cells[a]?.v;
  };
  const cells = [...new Set(list.flatMap((x) => x.cells))];
  const rows: (string | number | undefined)[][] = [[t("sheetx.scen.summary"), t("sheetx.scen.current"), ...list.map((x) => x.name)]];
  rows.push([t("sheetx.scen.changing")]);
  for (const a of cells) rows.push([a, sh.cells[a]?.v as number | string | undefined, ...list.map((x) => { const k = x.cells.indexOf(a); return k >= 0 ? (isNaN(Number(x.vals[k])) ? x.vals[k] : Number(x.vals[k])) : (sh.cells[a]?.v as number | string | undefined); })]);
  if (results.length) {
    rows.push([t("sheetx.scen.results")]);
    for (const a of results) rows.push([a, sh.cells[a]?.v as number | string | undefined, ...list.map((x) => valueWith(x.cells, x.vals, a) as number | string | undefined)]);
  }
  const id = addSheet(pageId);
  if (!id) return false;
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  rows.forEach((r, i) => r.forEach((v, j) => v !== undefined && v !== "" && edits.push({ a: addr(i + 1, j + 1), cell: { v } })));
  setCells(id, edits, t("sheetx.scen.summary"), (s2) => {
    s2.name = t("sheetx.scen.summary");
  });
  return true;
}

/**
 * 데이터 표 (What-If ▸ Data Table): the selection's first row / column holds the inputs, its corner (or the cell above /
 * left of the results) the formula; each result is the formula worked out with the input cell(s) set to that input.
 */
export function dataTable(pageId: string, rowInput: string, colInput: string): boolean {
  const st = S();
  const page = findPage(st.doc, pageId);
  const sh = page?.sheet;
  if (!sh) return false;
  const g = norm(selOf(pageId));
  const ri = rowInput.replace(/\$/g, "").toUpperCase().trim(), ci = colInput.replace(/\$/g, "").toUpperCase().trim();
  if ((!ri && !ci) || (ri && !parseAddr(ri)) || (ci && !parseAddr(ci)) || g.r1 <= g.r0 && g.c1 <= g.c0) return void st.notify(t("sheetx.dt.bad")), false;
  const pages = bookPages(st.doc, page!);
  const si = pages.findIndex((p) => p.id === pageId);
  const two = !!ri && !!ci;
  const work = (sets: [string, number | string | undefined][], formulaAt: string) => {
    const sheets = pages.map((p) => JSON.parse(JSON.stringify(p.sheet)) as SheetData);
    for (const [a, v] of sets) sheets[si].cells[a] = v === undefined ? {} : { v };
    const book = new Book(sheets);
    book.lang = lang();
    for (const ch of book.recalc()) applyChange(sheets[ch.sheet], ch);
    return sheets[si].cells[formulaAt]?.v;
  };
  const edits: { a: string; cell: SheetCell | undefined }[] = [];
  const val = (a: string) => sh.cells[a]?.v as number | string | undefined;
  let ref: string;
  if (two) {
    // corner formula; row inputs across the top, column inputs down the left
    const corner = addr(g.r0, g.c0);
    for (let r = g.r0 + 1; r <= g.r1; r++)
      for (let c = g.c0 + 1; c <= g.c1; c++) {
        const v = work([[ri, val(addr(g.r0, c))], [ci, val(addr(r, g.c0))]], corner);
        edits.push({ a: addr(r, c), cell: { ...(sh.cells[addr(r, c)]?.s ? { s: sh.cells[addr(r, c)]!.s } : {}), ...(v !== undefined ? { v: v as number | string } : {}) } });
      }
    ref = `${addr(g.r0 + 1, g.c0 + 1)}:${addr(g.r1, g.c1)}`;
  } else if (ci) {
    // inputs down the first column, formulas across the first row
    for (let c = g.c0 + 1; c <= g.c1; c++)
      for (let r = g.r0 + 1; r <= g.r1; r++) {
        const v = work([[ci, val(addr(r, g.c0))]], addr(g.r0, c));
        edits.push({ a: addr(r, c), cell: { ...(v !== undefined ? { v: v as number | string } : {}) } });
      }
    ref = `${addr(g.r0 + 1, g.c0 + 1)}:${addr(g.r1, g.c1)}`;
  } else {
    // inputs across the first row, formulas down the first column
    for (let r = g.r0 + 1; r <= g.r1; r++)
      for (let c = g.c0 + 1; c <= g.c1; c++) {
        const v = work([[ri, val(addr(g.r0, c))]], addr(r, g.c0));
        edits.push({ a: addr(r, c), cell: { ...(v !== undefined ? { v: v as number | string } : {}) } });
      }
    ref = `${addr(g.r0 + 1, g.c0 + 1)}:${addr(g.r1, g.c1)}`;
  }
  const first = parseRange(ref)!;
  const fa = addr(first.r0, first.c0);
  const head = edits.find((e) => e.a === fa);
  if (head?.cell) head.cell.dt = two ? { ref, dt2D: true, dtr: true, r1: ri, r2: ci } : ci ? { ref, r1: ci } : { ref, dtr: true, r1: ri };
  setCells(pageId, edits, t("sheetx.dt.h"));
  return true;
}

/** 사용자 지정 목록: the person's lists, kept in this browser (Excel keeps them in its options, not in the file). */
const LISTS_KEY = "omw.sheet.customLists";
export function loadUserLists(): string[][] {
  try {
    const v = JSON.parse(localStorage.getItem(LISTS_KEY) ?? "[]");
    if (Array.isArray(v)) setUserLists(v.filter((x) => Array.isArray(x) && x.length));
  } catch {
    /* no storage: the built-in lists only */
  }
  return USER_LISTS;
}
export function saveUserLists(lists: string[][]) {
  setUserLists(lists);
  try {
    localStorage.setItem(LISTS_KEY, JSON.stringify(lists));
  } catch {
    /* kept for this session */
  }
}
loadUserLists();

// ───── 메모 스레드 (검토 ▸ 새 메모: Excel 365 threaded comments) ─────

let threadSeq = 0;
/** A comment posted on a cell: a new thread, or a reply to the one there (its legacy comment kept in step). */
export function postThread(pageId: string, a: string, text: string) {
  if (!text.trim()) return;
  const now = new Date().toISOString().replace(/Z$/, "").slice(0, 22);
  const item = { id: guidOf(`${pageId}|${a}|${now}|${++threadSeq}|${text}`), author: reviewAuthor(), text: text.trim(), date: now };
  edit(pageId, t("sheetx.thread.h"), (sh) => {
    const threads = { ...(sh.threads ?? {}) };
    const th = threads[a] ? { ...threads[a], items: [...threads[a].items, item] } : { id: item.id, items: [item] };
    threads[a] = th;
    sh.threads = threads;
    sh.notes = { ...(sh.notes ?? {}), [a]: { text: legacyText(th), author: `tc=${th.id}`, threaded: true } };
  });
}
/** 스레드 해결 / 스레드 다시 열기 */
export function resolveThread(pageId: string, a: string, done: boolean) {
  edit(pageId, t(done ? "sheetx.thread.resolve" : "sheetx.thread.reopen"), (sh) => {
    const th = sh.threads?.[a];
    if (!th) return;
    sh.threads = { ...sh.threads, [a]: { ...th, ...(done ? { done: true } : { done: undefined }) } };
    if (!done) delete sh.threads[a].done;
  });
}
/** 스레드 삭제: the thread and its legacy comment */
export function deleteThread(pageId: string, a: string) {
  edit(pageId, t("sheetx.thread.delete"), (sh) => {
    if (sh.threads) {
      const th = { ...sh.threads };
      delete th[a];
      sh.threads = Object.keys(th).length ? th : undefined;
      if (!sh.threads) delete sh.threads;
    }
    if (sh.notes?.[a]) {
      const n = { ...sh.notes };
      delete n[a];
      sh.notes = n;
    }
  });
}
