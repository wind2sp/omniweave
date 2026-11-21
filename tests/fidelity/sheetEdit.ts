// One-place edits of Excel workbooks opened as sheet pages (표 계산 model, page.sheet) — measurement helpers shared by
// tests/fidelity/fidelity.test.ts (DESKTOP_DONE 2, "한 곳 편집") and tests/fidelity/xlsxEdit.test.ts (Excel check).
// Since the sheet model (2026-11-14) a workbook has no TABLE nodes, so the old table edit found nothing ("해당 없음").
//
// An edit is typed into one cell the way the grid does (ui/sheet/sheetActions enterText: entry rules + recalculation),
// then the saved package is compared with the original part by part:
//   - parts that may change: the worksheets holding a changed cell (the edited one, recalculated formulas),
//     xl/sharedStrings.xml, xl/calcChain.xml, xl/workbook.xml only in <calcPr> (fullCalcOnLoad), and the calcChain
//     entries of [Content_Types].xml / xl/_rels/workbook.xml.rels, and the <tableColumns> of an Excel table whose
//     header or totals label cell is the edit (its column name / totalsRowLabel — QA 2026-11-16)
//   - every other part must be byte-identical; inside a changed worksheet every <row> without a changed cell too.

import { unzipSync } from "fflate";
import { addr, parseAddr } from "../../src/io/sheet/formula";
import type { SheetCell } from "../../src/core/sheetTypes";
import type { OmwDocument, Page } from "../../src/core/types";
import { readXlsx } from "../../src/io/sheet/read";
import { enterText, editText } from "../../src/ui/sheet/sheetActions";

export type SheetEditKind = "text" | "number" | "formula";
export interface SheetEditCase {
  kind: SheetEditKind;
  /** index among the workbook's sheet pages (tab order) */
  sheet: number;
  sheetName: string;
  addr: string;
  /** what is typed into the cell */
  input: string;
  /** the value Excel must show in the cell after opening (formula: computed by Excel) */
  expect: number | string | boolean;
}

export const MARK = "~";
const sheetPagesOf = (doc: OmwDocument) => doc.pages.filter((p) => p.sheet);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Formulas of the workbook referring to a cell (rough: the address appears as a reference). */
function referenced(pages: Page[], sheetName: string, a: string): boolean {
  const re = new RegExp(`(^|[^A-Z0-9_$])\\$?${a.replace(/\d+$/, "")}\\$?${a.replace(/^[A-Z]+/, "")}(?![0-9])`);
  return pages.some((p) => Object.values(p.sheet!.cells).some((c) => c.f && re.test(c.f) && (p.sheet!.name === sheetName || c.f.includes(sheetName))));
}

/** cells in reading order (sheet by sheet, row by row) */
function cellsInOrder(p: Page): [string, SheetCell][] {
  return Object.entries(p.sheet!.cells)
    .map(([a, c]) => [a, c, parseAddr(a)] as const)
    .filter((x) => x[2])
    .sort((x, y) => x[2]!.r - y[2]!.r || x[2]!.c - y[2]!.c)
    .map(([a, c]) => [a, c]);
}

/**
 * The edits to measure on a workbook: a text cell + "~", a number constant (one that formulas use when there is one)
 * + 1, and a formula f → (f)+1 on a formula with a numeric result. Cells inside array formulas, errors and stale
 * formulas (the engine cannot calculate them) are skipped.
 */
export function pickSheetEdits(doc: OmwDocument): SheetEditCase[] {
  const pages = sheetPagesOf(doc);
  const out: SheetEditCase[] = [];
  const find = (pred: (c: SheetCell, a: string, p: Page) => boolean, prefer?: (c: SheetCell, a: string, p: Page) => boolean) => {
    let first: { si: number; a: string; c: SheetCell } | null = null;
    for (let si = 0; si < pages.length; si++)
      for (const [a, c] of cellsInOrder(pages[si])) {
        if (c.sp || c.spill || c.t === "e" || c.stale || !pred(c, a, pages[si])) continue;
        if (!prefer || prefer(c, a, pages[si])) return { si, a, c };
        first ??= { si, a, c };
      }
    return first;
  };
  const text = find((c) => !c.f && typeof c.v === "string" && c.v.trim() !== "" && !/^[=+\-@']/.test(c.v));
  if (text) out.push({ kind: "text", sheet: text.si, sheetName: pages[text.si].sheet!.name, addr: text.a, input: (text.c.v as string) + MARK, expect: (text.c.v as string) + MARK });
  const num = find((c) => !c.f && isNum(c.v) && Number.isInteger(c.v) && Math.abs(c.v) < 1e9, (_c, a, p) => referenced(pages, p.sheet!.name, a));
  if (num) {
    const sh = pages[num.si].sheet!;
    // typed as the grid shows it for editing (percent cells as "12%"), the value + 1 in the cell's own terms
    const shown = editText(sh, num.c, "ko");
    const pct = shown.endsWith("%");
    const v = (num.c.v as number) + (pct ? 0.01 : 1);
    const input = pct ? `${Math.round(v * 100 * 1e6) / 1e6}%` : String(v);
    if (/^-?\d+(\.\d+)?%?$/.test(input)) out.push({ kind: "number", sheet: num.si, sheetName: sh.name, addr: num.a, input, expect: v });
  }
  const fo = find((c) => !!c.f && isNum(c.v) && !/\b(RAND|RANDBETWEEN|NOW|TODAY|OFFSET|INDIRECT|CELL|INFO)\s*\(/i.test(c.f!) && c.f!.length < 400);
  if (fo) out.push({ kind: "formula", sheet: fo.si, sheetName: pages[fo.si].sheet!.name, addr: fo.a, input: `=(${editText(pages[fo.si].sheet!, fo.c, "ko").slice(1)})+1`, expect: (fo.c.v as number) + 1 });
  return out;
}

/** Type the edit into the open document (store) the way the grid does; false = the entry was refused. */
export function applySheetEdit(doc: OmwDocument, e: SheetEditCase): boolean {
  const page = sheetPagesOf(doc)[e.sheet];
  const p = parseAddr(e.addr);
  if (!page || !p) return false;
  return enterText(page.id, p.r, p.c, e.input);
}

/** Every cell whose stored value or formula differs between two states of the workbook: "sheetIndex!A1". */
export function changedCells(before: OmwDocument, after: OmwDocument): Set<string> {
  const a = sheetPagesOf(before), b = sheetPagesOf(after);
  const out = new Set<string>();
  for (let si = 0; si < Math.max(a.length, b.length); si++) {
    const ca = a[si]?.sheet?.cells ?? {}, cb = b[si]?.sheet?.cells ?? {};
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      const x = ca[k], y = cb[k];
      if (x?.v !== y?.v || x?.f !== y?.f || x?.t !== y?.t) out.add(`${si}!${k}`);
    }
  }
  return out;
}

/** value of a cell in the edited document (to tell Excel what the recalculated cells must be) */
export function cellValue(doc: OmwDocument, si: number, a: string): SheetCell["v"] {
  return sheetPagesOf(doc)[si]?.sheet?.cells[a]?.v;
}

// ───────── package comparison ─────────

const dec = new TextDecoder();
const same = (x: Uint8Array | undefined, y: Uint8Array | undefined) => !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);

/** worksheet part of each sheet, in workbook order (xl/workbook.xml + its relationships) */
export function sheetParts(files: Record<string, Uint8Array>): string[] {
  const wb = dec.decode(files["xl/workbook.xml"] ?? new Uint8Array());
  const rels = dec.decode(files["xl/_rels/workbook.xml.rels"] ?? new Uint8Array());
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\sId="([^"]+)"/.exec(m[0])?.[1], t = /\sTarget="([^"]+)"/.exec(m[0])?.[1];
    if (id && t) target.set(id, t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""));
  }
  return [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => target.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "");
}

const rowsOf = (xml: string) => {
  const m = new Map<number, string>();
  for (const r of xml.matchAll(/<(?:\w+:)?row\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?row>)/g)) {
    const n = Number(/\sr="(\d+)"/.exec(r[0])?.[1]);
    if (n) m.set(n, r[0]);
  }
  return m;
};
/**
 * Excel table parts (xl/tables) whose header row or totals row holds a changed cell: a header names its column and a
 * totals label is the column's totalsRowLabel, so such an edit changes the table's <tableColumns> (QA 2026-11-16,
 * officesurgeon/xlsxTables.ts). Read from the original package; every other table part must stay byte for byte.
 */
function editedTables(files: Record<string, Uint8Array>, parts: string[], changedSheets: Map<string, Set<number>>, changed: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const [part] of changedSheets) {
    const si = parts.indexOf(part);
    const rels = dec.decode(files[part.replace(/([^/]+)$/, "_rels/$1.rels")] ?? new Uint8Array());
    const dir = part.slice(0, part.lastIndexOf("/") + 1);
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      if (!/\/table"/.test(m[0])) continue;
      const target = /\sTarget="([^"]+)"/.exec(m[0])?.[1] ?? "";
      const segs: string[] = [];
      for (const s of (target.startsWith("/") ? target.slice(1) : dir + target).split("/")) s === ".." ? segs.pop() : s && s !== "." && segs.push(s);
      const name = segs.join("/");
      const tag = /<(?:\w+:)?table\b[^>]*>/.exec(dec.decode(files[name] ?? new Uint8Array()))?.[0] ?? "";
      const [a, b] = (/\sref="([^"]+)"/.exec(tag)?.[1] ?? "").split(":").map((x) => parseAddr(x.replace(/\$/g, "")));
      if (!a || !b) continue;
      const rows = [...(/\sheaderRowCount="0"/.test(tag) ? [] : [a.r]), ...(Number(/\stotalsRowCount="(\d+)"/.exec(tag)?.[1] ?? 0) > 0 ? [b.r] : [])];
      for (const k of changed) {
        const [s, ad] = k.split("!");
        const p = parseAddr(ad);
        if (Number(s) === si && p && rows.includes(p.r) && p.c >= a.c && p.c <= b.c) out.add(name);
      }
    }
  }
  return out;
}
const noTableColumns = (s: string) => s.replace(/<((?:\w+:)?tableColumns)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/, "<tableColumns/>");

/** worksheet without its sheetData (everything but the cells: columns, merges, views, conditional formats…) */
const shell = (xml: string) => xml.replace(/<((?:\w+:)?sheetData)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1>)/, "<sheetData/>");

export interface PackageCheck {
  parts: number;
  /** parts byte-identical to the original */
  sameParts: number;
  /** parts that changed although nothing in them should have (classes, e.g. "styles", "other sheet") */
  stray: string[];
  /** rows outside the changed cells that are not byte-identical (in changed worksheets) */
  strayRows: number;
  /** worksheet content outside sheetData changed */
  sheetShell: number;
  /** parts added / removed */
  added: number;
  removed: number;
}

/** "sheetIndex!A1" changed cells → which parts may differ, and what else did. */
export function comparePackages(orig: Uint8Array, out: Uint8Array, changed: Set<string>): PackageCheck {
  const A = unzipSync(orig), B = unzipSync(out);
  const parts = sheetParts(A);
  const changedSheets = new Map<string, Set<number>>();
  for (const k of changed) {
    const [si, a] = k.split("!");
    const part = parts[Number(si)];
    const p = parseAddr(a);
    if (!part || !p) continue;
    if (!changedSheets.has(part)) changedSheets.set(part, new Set());
    changedSheets.get(part)!.add(p.r + 1);
  }
  const res: PackageCheck = { parts: Object.keys(A).length, sameParts: 0, stray: [], strayRows: 0, sheetShell: 0, added: 0, removed: 0 };
  const noCalcChain = (s: string) => s.replace(/<Relationship\b[^>]*calcChain\.xml"[^>]*\/>/g, "").replace(/<Override\b[^>]*calcChain\.xml"[^>]*\/>/g, "");
  const tables = editedTables(A, parts, changedSheets, changed);
  for (const name of Object.keys(A)) {
    const x = A[name], y = B[name];
    if (!y) {
      if (name !== "xl/calcChain.xml") res.removed++;
      continue;
    }
    if (same(x, y)) {
      res.sameParts++;
      continue;
    }
    if (name === "xl/sharedStrings.xml" || name === "xl/calcChain.xml") continue;
    const sx = dec.decode(x), sy = dec.decode(y);
    if (name === "xl/workbook.xml") {
      const strip = (s: string) => s.replace(/<(?:\w+:)?calcPr\b[^>]*\/>/, "");
      if (strip(sx) !== strip(sy)) res.stray.push("workbook.xml(계산 설정 밖)");
      continue;
    }
    if (name === "[Content_Types].xml" || name === "xl/_rels/workbook.xml.rels") {
      if (noCalcChain(sx) !== noCalcChain(sy)) res.stray.push(name === "[Content_Types].xml" ? "Content_Types" : "workbook 관계");
      continue;
    }
    if (tables.has(name)) {
      // a header / totals label edit of this table: only its column list (names, totals labels) may change
      if (noTableColumns(sx) !== noTableColumns(sy)) res.stray.push("표(열 목록 밖)");
      continue;
    }
    const rows = changedSheets.get(name);
    if (rows) {
      if (shell(sx) !== shell(sy)) res.sheetShell++;
      const ra = rowsOf(sx), rb = rowsOf(sy);
      for (const n of new Set([...ra.keys(), ...rb.keys()])) if (!rows.has(n) && ra.get(n) !== rb.get(n)) res.strayRows++;
      continue;
    }
    res.stray.push(parts.includes(name) ? "다른 시트" : /^xl\/styles\.xml$/.test(name) ? "styles" : /^docProps\//.test(name) ? "문서 속성" : /^xl\/(drawings|charts)\//.test(name) ? "그림·차트" : /^xl\/worksheets\/_rels\//.test(name) ? "시트 관계" : /^xl\/tables\//.test(name) ? "표" : "기타 파트");
  }
  for (const name of Object.keys(B)) if (!A[name]) res.added++;
  return res;
}

/** the problems of a package check, as diff lines ([] = 보존) */
export function packageDiffs(c: PackageCheck): string[] {
  const d: string[] = [];
  for (const s of new Set(c.stray)) d.push(`바뀌면 안 되는 파트 바뀜: ${s} ${c.stray.filter((x) => x === s).length}`);
  if (c.strayRows) d.push(`편집 밖 행 ${c.strayRows}개 바이트 바뀜`);
  if (c.sheetShell) d.push(`시트의 셀 밖 내용 바뀜 ${c.sheetShell}`);
  if (c.added) d.push(`파트 추가 ${c.added}`);
  if (c.removed) d.push(`파트 사라짐 ${c.removed}`);
  return d;
}

/**
 * Cells as the sheet reader sees the saved file: every cell outside `changed` must keep its value, formula and
 * resolved style; the edited cell must hold the edit. Returns diff lines and whether the edit is in the file.
 */
export function sheetModelDiffs(orig: Uint8Array, out: Uint8Array, changed: Set<string>, e: SheetEditCase): { diffs: string[]; reflected: boolean; valueOk: boolean } {
  const A = readXlsx(orig, "ko").sheets, B = readXlsx(out, "ko").sheets;
  const diffs: string[] = [];
  if (A.length !== B.length) diffs.push(`시트 수 ${A.length}→${B.length}`);
  let names = 0, val = 0, form = 0, style = 0, gone = 0, added = 0;
  for (let si = 0; si < Math.min(A.length, B.length); si++) {
    const a = A[si], b = B[si];
    if (a.name !== b.name) names++;
    const st = (sh: typeof a, i: number | undefined) => JSON.stringify(sh.styles[i ?? 0] ?? {});
    for (const k of new Set([...Object.keys(a.cells), ...Object.keys(b.cells)])) {
      if (changed.has(`${si}!${k}`)) continue;
      const x = a.cells[k], y = b.cells[k];
      if (!y) {
        if (x.v !== undefined || x.f) gone++;
        continue;
      }
      if (!x) {
        if (y.v !== undefined || y.f) added++;
        continue;
      }
      if (x.v !== y.v || x.t !== y.t) val++;
      if ((x.f ?? "") !== (y.f ?? "")) form++;
      if (st(a, x.s) !== st(b, y.s)) style++;
    }
  }
  if (names) diffs.push(`시트 이름 ${names}개 다름`);
  if (val) diffs.push(`편집 밖 셀 값 ${val}개 다름`);
  if (form) diffs.push(`편집 밖 수식 ${form}개 다름`);
  if (style) diffs.push(`편집 밖 셀 서식 ${style}개 다름`);
  if (gone) diffs.push(`셀 ${gone}개 사라짐`);
  if (added) diffs.push(`셀 ${added}개 생김`);
  const c = B[e.sheet]?.cells[e.addr];
  const near = (x: unknown, y: unknown) => typeof x === "number" && typeof y === "number" ? Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(y)) : x === y;
  // a formula edit is in the file when the new formula is; its stored result is Omniweave's calculation (valueOk) —
  // Excel recalculates on opening (fullCalcOnLoad), so a missing result is a calculation gap, not a damaged file
  const reflected = !!c && (e.kind === "formula" ? !!c.f && /\)\s*\+\s*1$/.test(c.f) : !c.f && near(c.v, e.expect));
  return { diffs, reflected, valueOk: !!c && near(c.v, e.expect) };
}

export interface SheetEditResult {
  /** the edit was accepted by the grid and is in the saved file */
  reflected: boolean;
  /** the value Omniweave stored for the edited cell is the expected one (formula: its own calculation) */
  valueOk: boolean;
  diffs: string[];
  out: Uint8Array | null;
  /** cells the edit changed (edited + recalculated): "sheetIndex!A1" */
  changed: Set<string>;
  pkg: PackageCheck | null;
}

/** Apply one edit to the open workbook (store document), save, compare with the original. */
export async function measureSheetEdit(doc: () => OmwDocument, orig: Uint8Array, e: SheetEditCase, save: () => Promise<Uint8Array>): Promise<SheetEditResult> {
  const before = doc();
  if (!applySheetEdit(before, e)) return { reflected: false, valueOk: false, diffs: ["입력이 거부됨"], out: null, changed: new Set(), pkg: null };
  const changed = changedCells(before, doc());
  const out = await save();
  const m = sheetModelDiffs(orig, out, changed, e);
  const pkg = comparePackages(orig, out, changed);
  return { reflected: m.reflected, valueOk: m.valueOk, diffs: [...m.diffs, ...packageDiffs(pkg)], out, changed, pkg };
}

export { addr };
