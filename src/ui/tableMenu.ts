// The table's right-click menu (Word): rows / columns, delete, merge / split and the table's properties panel.
// The commands act on the picked cell range (useCellSel) — a right-click outside that range picks the cell first.

import { useStore } from "../core/store";
import { expandRange } from "../core/table";
import type { TableNode } from "../core/types";
import { t } from "../i18n";
import { useCellSel } from "./CellEditor";
import { canMerge, deleteTable, deleteTableLines, insertTableCols, insertTableRows, mergeSelectedCells, splitSelectedCell } from "./pageSetupActions";
import type { MenuItem } from "./shell/controls";
import { useUI } from "./shell/uiStore";

/** Select the table and, unless the pressed cell is inside the picked range, pick that cell. */
export function pickForMenu(n: TableNode, cell: { row: number; col: number }) {
  const s = useStore.getState();
  if (!s.selection.includes(n.id) || s.selection.length !== 1) s.set({ selection: [n.id] });
  const cs = useCellSel.getState();
  if (cs.target?.nodeId === n.id && cs.target.row < n.rows.length && cs.target.col < n.colWidths.length) {
    const b = cs.end ?? cs.target;
    const g = expandRange(n.rows, { r0: cs.target.row, c0: cs.target.col, r1: b.row, c1: b.col });
    if (cell.row >= g.r0 && cell.row <= g.r1 && cell.col >= g.c0 && cell.col <= g.c1) return;
  }
  useCellSel.setState({ target: { nodeId: n.id, ...cell }, end: null });
}

export function tableMenuItems(): MenuItem[] {
  return [
    { label: t("tablemenu.rowAbove"), onSelect: () => insertTableRows("above") },
    { label: t("tablemenu.rowBelow"), onSelect: () => insertTableRows("below") },
    { label: t("tablemenu.colLeft"), onSelect: () => insertTableCols("left") },
    { label: t("tablemenu.colRight"), onSelect: () => insertTableCols("right") },
    { sep: true },
    { label: t("tablemenu.deleteRows"), onSelect: () => deleteTableLines("row") },
    { label: t("tablemenu.deleteCols"), onSelect: () => deleteTableLines("col") },
    { label: t("tablemenu.deleteTable"), icon: "trash", onSelect: deleteTable },
    { sep: true },
    { label: t("tablemenu.merge"), disabled: !canMerge(), onSelect: mergeSelectedCells },
    { label: t("tablemenu.split"), onSelect: splitSelectedCell },
    { sep: true },
    // width, shading, alignment and the table's border live in the properties panel (shell/NodePanels TablePanel)
    { label: t("tablemenu.props"), onSelect: () => useUI.getState().set({ rightOpen: true }) },
  ];
}
