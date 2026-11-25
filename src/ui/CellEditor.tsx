// In-place table cell editor: double-click a cell; Tab / Shift+Tab move across, Enter moves down,
// Shift+Enter inserts a line break, Esc leaves the cell (keeping the text, as Word does). Every committed cell is one undoable step.

import { isAppChord } from "./appKeys";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { draftPage, findPage, useStore } from "../core/store";
import { CELL_PAD_X, anchorOf, cellRect, coverMap, layoutTable, spanOf } from "../core/table";
import { cssFont } from "../core/text";
import type { TableNode } from "../core/types";
import { t as tr, useT } from "../i18n";

const S = () => useStore.getState();

export interface CellTarget {
  nodeId: string;
  row: number;
  col: number;
}

/**
 * The cell most recently edited or clicked (row/column commands in the properties panel act on it), and the other
 * corner of a cell range picked with Shift+click (셀 합치기 merges target…end); end null = just the one cell.
 */
export const useCellSel = create<{ target: CellTarget | null; end: { row: number; col: number } | null }>(() => ({ target: null, end: null }));

export function commitCell(nodeId: string, row: number, col: number, text: string) {
  const s = S();
  const page = findPage(s.doc, s.pageId);
  const n = page?.nodes.find((x) => x.id === nodeId) as TableNode | undefined;
  if (!n || n.rows[row]?.[col]?.text === text) return;
  s.commit(tr("shell.hist.editCell"), (d) => {
    const t = draftPage(d, s.pageId)?.nodes.find((x) => x.id === nodeId) as TableNode | undefined;
    if (t?.rows[row]?.[col]) t.rows[row][col] = { ...t.rows[row][col], text };
  });
}

export function CellEditor({ target, onMove, onDone }: { target: CellTarget; onMove: (t: CellTarget) => void; onDone: () => void }) {
  const node = useStore((s) => findPage(s.doc, s.pageId)?.nodes.find((n) => n.id === target.nodeId)) as TableNode | undefined;
  const view = useStore((s) => s.view);
  const cell = node?.rows[target.row]?.[target.col];
  const [value, setValue] = useState(cell?.text ?? "");
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useT();

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
    useCellSel.setState({ target, end: null });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!node || !cell) return null;
  const l = layoutTable(node);
  const t = node.transform;
  const scale = view.zoom * t.scale;
  // a merged cell is edited over its whole range
  const { rs, cs } = spanOf(node.rows, target.row, target.col);
  const { x: lx, y: ly, w, h } = cellRect(l, target.row, target.col, rs, cs);
  const a = (t.rotation * Math.PI) / 180;
  const px = t.x + (lx * Math.cos(a) - ly * Math.sin(a)) * t.scale;
  const py = t.y + (lx * Math.sin(a) + ly * Math.cos(a)) * t.scale;

  const commit = () => {
    if (!cancelled.current) commitCell(node.id, target.row, target.col, value);
  };
  const go = (dr: number, dc: number) => {
    commit();
    // step over the cells a merged cell covers (they are not edited)
    const cover = coverMap(node.rows);
    const cols = node.colWidths.length;
    let r = target.row, c = target.col;
    if (dr) r += dr > 0 ? rs : -1;
    else
      do {
        c += dc;
        if (c >= cols) (c = 0), r++;
        if (c < 0) (c = cols - 1), r--;
      } while (r >= 0 && r < node.rows.length && cover[r]?.[c]);
    // Tab in the last cell adds a row and goes on in it (Word, 한글)
    if (r >= node.rows.length && dc > 0) {
      const cols0 = node.colWidths.length;
      const s0 = S();
      s0.commit(tr("docflow.hist.addRow"), (d) => {
        const tb = draftPage(d, s0.pageId)?.nodes.find((x) => x.id === node.id) as TableNode | undefined;
        if (tb) tb.rows.push(Array.from({ length: cols0 }, () => ({ text: "" })));
      });
      cancelled.current = true;
      return onMove({ nodeId: node.id, row: node.rows.length, col: 0 });
    }
    if (r < 0 || r >= node.rows.length) return onDone();
    ({ row: r, col: c } = anchorOf(node, r, c));
    cancelled.current = true; // this editor instance is done
    onMove({ nodeId: node.id, row: r, col: c });
  };

  return (
    <textarea
      ref={ref}
      className="cell-editor"
      value={value}
      spellCheck={false}
      aria-label={tr("shell.cellLabel", { row: target.row + 1, col: target.col + 1 })}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (cancelled.current) return; // moved to another cell or cancelled
        commit();
        onDone();
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Ctrl+Tab / Ctrl+Shift+Tab switch document tabs (shell/shortcuts.ts), as in every other editor
        // (열기 / 저장 / 새로 / 닫기 / 찾기 / 인쇄 too: the app's; a save blurs this editor first, which commits the cell)
        if (isAppChord(e.nativeEvent)) return;
        e.stopPropagation();
        if (e.key === "Escape") {
          // Word / 한글: Esc leaves the cell and keeps what was typed (QA 11-24 basic-ux: it used to be lost)
          e.preventDefault();
          commit();
          cancelled.current = true;
          onDone();
        } else if (e.key === "Enter" && e.ctrlKey && e.shiftKey && node.flow) {
          // 표 나누기 (Word Ctrl+Shift+Enter): this row and the ones below become a table of their own
          e.preventDefault();
          commit();
          cancelled.current = true;
          onDone();
          void import("./docFlow").then((m) => m.splitFlowTable(target.nodeId, target.row));
        } else if (e.key === "Tab") {
          e.preventDefault();
          go(0, e.shiftKey ? -1 : 1);
        } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          go(1, 0);
        }
      }}
      style={{
        // CSS zoom (not a scale transform): the text being typed is drawn crisp at its real size, like the page
        zoom: scale,
        left: (px * view.zoom + view.panX) / scale,
        top: (py * view.zoom + view.panY) / scale,
        width: w,
        minHeight: h,
        transform: t.rotation ? `rotate(${t.rotation}deg)` : undefined,
        font: cssFont({ fontFamily: node.fontFamily, fontSize: node.fontSize, bold: !!cell.bold || (node.headerRow && target.row === 0), italic: !!cell.italic }),
        lineHeight: 1.35,
        paddingLeft: CELL_PAD_X - 2,
        textAlign: (cell.align ?? "LEFT").toLowerCase() as "left" | "center" | "right",
      }}
    />
  );
}
