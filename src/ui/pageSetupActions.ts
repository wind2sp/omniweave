// Page setup (쪽 설정) and break commands, and the table merge / split commands — each one undo step.
// Model rules live in core/pageSetup.ts and core/table.ts; this file only reads the editor state and commits.

import { currentRegion, flowActive, flowBreak, setRegionColumns } from "./docFlow";
import { applySetupInPlace, breakPageInPlace, sectionAt, setupOf, type PageSetup } from "../core/pageSetup";
import { draftPage, findPage, useStore } from "../core/store";
import { anchorOf, deleteColsInPlace, deleteRowsInPlace, expandRange, insertColsInPlace, insertRowsInPlace, mergeCellsInPlace, spanOf, splitCellInPlace } from "../core/table";
import { uid, type Page, type PageBorder, type TableNode, type TextParagraph } from "../core/types";
import { reflowPages } from "../core/flow";
import { current } from "immer";
import { t } from "../i18n";
import { useCellSel } from "./CellEditor";
import { deleteSelected, fitCurrent } from "./actions";

const S = () => useStore.getState();

export type SetupScope = "page" | "section" | "document";

/**
 * Page indices a setup applies to: this page, its section (as the user made it), or every page — only pages of this
 * page's kind (a document's page setup never resizes its slides, design or PDF pages).
 */
export function scopePages(pages: Page[], index: number, scope: SetupScope): number[] {
  if (scope === "page") return [index];
  const kind = pages[index]?.kind;
  const all = scope === "document" ? pages.map((_, i) => i) : sectionAt(pages, index);
  return all.filter((i) => pages[i].kind === kind);
}

/** Apply a page setup to the current page / its section / the document (one undo step). Returns the page count. */
export function applyPageSetup(setup: PageSetup, scope: SetupScope): number {
  const s = S();
  const index = s.doc.pages.findIndex((p) => p.id === s.pageId);
  if (index < 0) {
    s.notify(t("pagesetup.toast.noPage"));
    return 0;
  }
  const targets = scopePages(s.doc.pages, index, scope);
  s.commit(t("pagesetup.hist.apply"), (d) => {
    for (const i of targets) applySetupInPlace(d.pages[i] as Page, setup);
  });
  s.notify(t("pagesetup.toast.applied", { n: targets.length }));
  setTimeout(fitCurrent);
  return targets.length;
}

/** 단: the current section in `cols` columns (undefined = one), the rest of its setup as it is (one undo step). */
export function setColumns(cols: PageSetup["columns"]): number {
  return applyColumns(cols, "section");
}

/** 단 설정: `cols` (undefined or one = one column) on this section or the whole document's pages, nothing else changed. */
export function applyColumns(cols: PageSetup["columns"], scope: "section" | "document"): number {
  const s = S();
  const index = s.doc.pages.findIndex((p) => p.id === s.pageId);
  if (index < 0) return 0;
  // the caret in an 이어서 구역: that part's columns
  const region = scope === "section" ? currentRegion() : null;
  if (region) return setRegionColumns(region.at, cols) ? 1 : 0;
  const targets = scopePages(s.doc.pages, index, scope);
  s.commit(t("pagesetup.hist.columns"), (d) => {
    for (const i of targets) {
      const pg = d.pages[i] as Page;
      if (cols && cols.n > 1) pg.columns = JSON.parse(JSON.stringify(cols));
      else delete pg.columns;
      // (the whole document: its 이어서 구역 too)
      if (scope === "document")
        for (const n of pg.nodes)
          if (n.type === "TEXT" && n.flow)
            for (const q of n.paragraphs as TextParagraph[])
              if (q.contSect) q.contSect = cols && cols.n > 1 ? { ...q.contSect, columns: JSON.parse(JSON.stringify(cols)) } : (({ columns: _c, ...rest }) => rest)(q.contSect);
    }
  });
  return targets.length;
}

/** 쪽 테두리 of the current page's section: `border` (null = none), drawn at once (one undo step). */
export function setPageBorder(border: PageBorder | null): number {
  const s = S();
  const index = s.doc.pages.findIndex((p) => p.id === s.pageId);
  if (index < 0 || s.doc.pages[index].kind !== "DOCUMENT") {
    s.notify(t("pagesetup.toast.noPage"));
    return 0;
  }
  const targets = scopePages(s.doc.pages, index, "section");
  s.commit(t("docux.border.hist"), (d) => {
    for (const i of targets) {
      const pg = d.pages[i] as Page;
      // (taken off: a border of width 0 — the file's own border is then removed when saved, core/pageSetup.ts sameBorder)
      pg.border = border ? { ...border } : { style: "single", width: 0, color: "#000000", space: 32, from: "page" };
    }
    d.pages = reflowPages(current(d.pages) as Page[]) as typeof d.pages;
  });
  return targets.length;
}

/** The current page's 쪽 테두리. */
export const pageBorderHere = (): PageBorder | undefined => {
  const s = S();
  const b = s.doc.pages.find((p) => p.id === s.pageId)?.border;
  return b && b.width > 0 ? b : undefined;
};
/** 단 where the caret is: its 이어서 구역's, else the page's section's. */
export function columnsHere(): PageSetup["columns"] {
  const r = currentRegion();
  if (r) return r.cols;
  const s = S();
  const p = s.doc.pages.find((x) => x.id === s.pageId);
  return p?.columns && p.columns.n > 1 ? p.columns : undefined;
}

/** The setup the dialog starts from: the current page's. */
export const currentSetup = (): PageSetup | null => {
  const s = S();
  const p = s.doc.pages.find((x) => x.id === s.pageId);
  return p ? setupOf(p) : null;
};

/**
 * 쪽 나누기 / 구역 나누기. With a text box split at the caret (`split`, from the text editor), the text after the caret
 * and the objects below go to the new page; otherwise a blank page with the same setup follows the current one.
 * Returns the new page and its body box (null when there is no current page).
 */
export function insertBreak(kind: "page" | "section", split?: { nodeId: string; keep: TextParagraph[]; moved: TextParagraph[] }): { pageId: string; nodeId: string } | null {
  // typing in a flowing body: the break goes at the caret and what follows starts a new page run
  if (!split && flowActive()) return flowBreak(kind) ? { pageId: S().pageId, nodeId: "" } : null;
  const s = S();
  const index = s.doc.pages.findIndex((p) => p.id === s.pageId);
  if (index < 0) return null;
  const pageId = uid("pg"), nodeId = uid();
  const name = t("doc.pageName.DOCUMENT", { n: s.doc.pages.filter((p) => p.kind === "DOCUMENT").length + 1 });
  s.commit(t(kind === "page" ? "pagesetup.hist.pageBreak" : "pagesetup.hist.sectionBreak"), (d) => {
    breakPageInPlace(d.pages as Page[], index, kind, { pageId, nodeId, name }, split);
  });
  S().set({ pageId, selection: split ? [nodeId] : [] });
  s.notify(t(kind === "page" ? "pagesetup.toast.pageBreak" : "pagesetup.toast.sectionBreak"));
  setTimeout(fitCurrent);
  return { pageId, nodeId };
}

/**
 * The current page is a document page (where page / section breaks and notes are offered). A sheet page (표 계산) is a
 * DOCUMENT page too but holds a cell grid, not a text body: Ctrl+Enter there must not add an empty page to the workbook.
 */
export const onDocumentPage = () => {
  const s = S();
  const p = s.doc.pages.find((x) => x.id === s.pageId);
  return p?.kind === "DOCUMENT" && !p.sheet;
};

// ───────── tables ─────────

/** The selected table and its picked cell range (the clicked cell and, after Shift+click, the other corner). */
export function tableSelection(): { node: TableNode; r0: number; c0: number; r1: number; c1: number } | null {
  const s = S();
  const sel = useCellSel.getState();
  if (!sel.target || !s.selection.includes(sel.target.nodeId)) return null;
  const page = findPage(s.doc, s.pageId);
  const node = page?.nodes.find((n) => n.id === sel.target!.nodeId);
  if (node?.type !== "TABLE") return null;
  const a = sel.target, b = sel.end ?? sel.target;
  if (a.row >= node.rows.length || a.col >= node.colWidths.length || b.row >= node.rows.length || b.col >= node.colWidths.length) return null;
  return { node, r0: Math.min(a.row, b.row), c0: Math.min(a.col, b.col), r1: Math.max(a.row, b.row), c1: Math.max(a.col, b.col) };
}

export const canMerge = () => {
  const g = tableSelection();
  return !!g && (g.r0 !== g.r1 || g.c0 !== g.c1);
};
export const canSplit = () => !!tableSelection();

function editTable(id: string, label: string, fn: (t: TableNode) => void) {
  const s = S();
  s.commit(label, (d) => {
    const n = draftPage(d, s.pageId)?.nodes.find((x) => x.id === id);
    if (n?.type === "TABLE") fn(n as TableNode);
  });
}

/** 셀 합치기: the picked range (grown over merged cells it touches) becomes one cell. */
export function mergeSelectedCells() {
  const g = tableSelection();
  if (!g || (g.r0 === g.r1 && g.c0 === g.c1)) return S().notify(t("table.toast.needRange"));
  editTable(g.node.id, t("table.hist.merge"), (n) => void mergeCellsInPlace(n, g));
  const a = anchorOf(findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === g.node.id) as TableNode, g.r0, g.c0);
  useCellSel.setState({ target: { nodeId: g.node.id, row: a.row, col: a.col }, end: null });
}

/** 셀 나누기: a merged cell back to its cells; a single cell into two columns. */
export function splitSelectedCell() {
  const g = tableSelection();
  if (!g) return;
  const a = anchorOf(g.node, g.r0, g.c0);
  const merged = (() => {
    const { rs, cs } = spanOf(g.node.rows, a.row, a.col);
    return rs > 1 || cs > 1;
  })();
  editTable(g.node.id, t("table.hist.split"), (n) => void splitCellInPlace(n, a.row, a.col));
  useCellSel.setState({ target: { nodeId: g.node.id, row: a.row, col: a.col }, end: null });
  S().notify(t(merged ? "table.toast.unmerged" : "table.toast.split"));
}

// ───────── rows / columns (the table context menu): as many rows / columns as the range covers (Word) ─────────

const pick = (nodeId: string, row: number, col: number) => useCellSel.setState({ target: { nodeId, row, col }, end: null });

/**
 * The cell being typed in is committed and closed before rows / columns move (QA 11-20): its editor holds a row / column
 * index, and left open over a reshaped table it would write the pending text into whatever cell now sits there.
 */
function endCellEdit() {
  const ae = typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
  if (ae?.classList?.contains("cell-editor")) ae.blur();
}

/** 위에 / 아래에 행 삽입 */
export function insertTableRows(where: "above" | "below") {
  endCellEdit();
  const g0 = tableSelection();
  if (!g0) return;
  const g = expandRange(g0.node.rows, g0);
  const n = g.r1 - g.r0 + 1, at = where === "above" ? g.r0 : g.r1 + 1;
  editTable(g0.node.id, t("dock.table.insertRow"), (x) => insertRowsInPlace(x, at, n));
  pick(g0.node.id, at, g.c0);
}

/** 왼쪽에 / 오른쪽에 열 삽입 */
export function insertTableCols(where: "left" | "right") {
  endCellEdit();
  const g0 = tableSelection();
  if (!g0) return;
  const g = expandRange(g0.node.rows, g0);
  const n = g.c1 - g.c0 + 1, at = where === "left" ? g.c0 : g.c1 + 1;
  editTable(g0.node.id, t("dock.table.insertCol"), (x) => insertColsInPlace(x, at, n));
  pick(g0.node.id, g.r0, at);
}

/** 표 삭제 */
export function deleteTable() {
  endCellEdit();
  const g = tableSelection();
  if (!g) return;
  S().set({ selection: [g.node.id] });
  useCellSel.setState({ target: null, end: null });
  deleteSelected();
}

/** 행 삭제 / 열 삭제 (every row or column of the table: the table goes) */
export function deleteTableLines(axis: "row" | "col") {
  endCellEdit();
  const g0 = tableSelection();
  if (!g0) return;
  const g = expandRange(g0.node.rows, g0);
  const all = axis === "row" ? g.r1 - g.r0 + 1 >= g0.node.rows.length : g.c1 - g.c0 + 1 >= g0.node.colWidths.length;
  if (all) return deleteTable();
  editTable(g0.node.id, t(axis === "row" ? "dock.table.deleteRow" : "dock.table.deleteCol"), (x) => void (axis === "row" ? deleteRowsInPlace(x, g.r0, g.r1) : deleteColsInPlace(x, g.c0, g.c1)));
  const n = findPage(S().doc, S().pageId)?.nodes.find((x) => x.id === g0.node.id) as TableNode | undefined;
  if (!n) return;
  const a = anchorOf(n, Math.min(g.r0, n.rows.length - 1), Math.min(g.c0, n.colWidths.length - 1));
  pick(n.id, a.row, a.col);
}
