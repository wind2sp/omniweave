// The table context menu's row / column commands and drag selection (ISSUES-2026-11-19 #5): the model stays a valid grid
// (every row as wide as colWidths, spans inside the grid) so the DOCX / HWPX writers get a well-formed table.
import { describe, expect, it } from "vitest";
import { coverMap, deleteColsInPlace, deleteRowsInPlace, dragEnd, insertColsInPlace, insertRowsInPlace, mergeCellsInPlace, splitCellInPlace } from "../src/core/table";
import { newTable, type TableCell, type TableNode } from "../src/core/types";

const grid = (rows: (string | TableCell)[][], w?: number[]): TableNode =>
  newTable(rows.map((r) => r.map((c) => (typeof c === "string" ? { text: c } : c))), w ?? rows[0].map(() => 100));

/** every row as wide as the grid, every span inside it, no span of 1 written out */
function valid(t: TableNode) {
  for (const row of t.rows) expect(row.length).toBe(t.colWidths.length);
  t.rows.forEach((row, r) =>
    row.forEach((c, k) => {
      expect(c.rowSpan ?? 2).toBeGreaterThan(1);
      expect(c.colSpan ?? 2).toBeGreaterThan(1);
      expect(r + (c.rowSpan ?? 1)).toBeLessThanOrEqual(t.rows.length);
      expect(k + (c.colSpan ?? 1)).toBeLessThanOrEqual(t.colWidths.length);
    }),
  );
  coverMap(t.rows);
}

const texts = (t: TableNode) => t.rows.map((r) => r.map((c) => c.text));

describe("drag selection", () => {
  it("the range follows the pointer and collapses back to the one cell", () => {
    const a = { row: 1, col: 1 };
    expect(dragEnd(a, { row: 1, col: 1 })).toBeNull();
    expect(dragEnd(a, { row: 3, col: 0 })).toEqual({ row: 3, col: 0 });
    expect(dragEnd(a, { row: 0, col: 2 })).toEqual({ row: 0, col: 2 });
  });
});

describe("insert rows / columns", () => {
  it("inserts rows above and below", () => {
    const t = grid([["a", "b"], ["c", "d"]]);
    insertRowsInPlace(t, 0, 1);
    insertRowsInPlace(t, 3, 2);
    expect(texts(t)).toEqual([["", ""], ["a", "b"], ["c", "d"], ["", ""], ["", ""]]);
    valid(t);
  });
  it("a vertical merge cut by the new row grows over it", () => {
    const t = grid([[{ text: "m", rowSpan: 2 }, "b"], ["", "d"]]);
    insertRowsInPlace(t, 1, 1);
    expect(t.rows[0][0].rowSpan).toBe(3);
    valid(t);
    insertRowsInPlace(t, 0, 1); // above the merge: it moves, it does not grow
    expect(t.rows[1][0].rowSpan).toBe(3);
    valid(t);
  });
  it("inserts columns left and right with the neighbour's width; a horizontal merge grows", () => {
    const t = grid([[{ text: "m", colSpan: 2 }, ""], ["c", "d"]], [80, 120]);
    insertColsInPlace(t, 1, 1);
    expect(t.colWidths).toEqual([80, 120, 120]);
    expect(t.rows[0][0].colSpan).toBe(3);
    expect(texts(t)[1]).toEqual(["c", "", "d"]);
    insertColsInPlace(t, 3, 1);
    expect(t.colWidths).toHaveLength(4);
    valid(t);
  });
});

describe("delete rows / columns", () => {
  it("deletes rows; a merge reaching into them shrinks", () => {
    const t = grid([[{ text: "m", rowSpan: 3 }, "b"], ["", "d"], ["", "f"], ["g", "h"]]);
    expect(deleteRowsInPlace(t, 1, 1)).toBe(true);
    expect(t.rows[0][0].rowSpan).toBe(2);
    expect(texts(t).map((r) => r[1])).toEqual(["b", "f", "h"]);
    valid(t);
  });
  it("a merge starting in the deleted rows moves down with its text", () => {
    const t = grid([["a", "b"], [{ text: "m", rowSpan: 3 }, "d"], ["", "f"], ["", "h"]]);
    expect(deleteRowsInPlace(t, 0, 1)).toBe(true);
    expect(t.rows[0][0]).toMatchObject({ text: "m", rowSpan: 2 });
    valid(t);
    expect(deleteRowsInPlace(t, 0, 1)).toBe(false); // every row: that is deleting the table
  });
  it("deletes columns and their widths; a merge shrinks to one cell", () => {
    const t = grid([[{ text: "m", colSpan: 2 }, "", "c"], ["d", "e", "f"]], [50, 60, 70]);
    expect(deleteColsInPlace(t, 1, 1)).toBe(true);
    expect(t.colWidths).toEqual([50, 70]);
    expect(t.rows[0][0].colSpan).toBeUndefined();
    expect(texts(t)).toEqual([["m", "c"], ["d", "f"]]);
    valid(t);
    expect(deleteColsInPlace(t, 0, 1)).toBe(false);
  });
});

describe("menu merge / split keep the grid valid", () => {
  it("merge a dragged range, then split it back", () => {
    const t = grid([["a", "b", "c"], ["d", "e", "f"]]);
    expect(mergeCellsInPlace(t, { r0: 1, c0: 2, r1: 0, c1: 1 })).toBe(true); // dragged up-left: corners in any order
    expect(t.rows[0][1]).toMatchObject({ rowSpan: 2, colSpan: 2 });
    valid(t);
    expect(splitCellInPlace(t, 1, 2)).toBe("unmerged");
    valid(t);
  });
});

describe("an edited table still writes a well-formed DOCX / HWPX table", () => {
  it("every w:tr spans the whole w:tblGrid; HWPX cells stay inside the grid", async () => {
    const { exportDocx, exportHwpx } = await import("../src/io/office");
    const { newPage } = await import("../src/core/types");
    const { strFromU8, unzipSync } = await import("fflate");
    const t = grid([["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"]]);
    mergeCellsInPlace(t, { r0: 0, c0: 0, r1: 1, c1: 1 });
    insertRowsInPlace(t, 1, 1);
    insertColsInPlace(t, 1, 2);
    deleteRowsInPlace(t, 3, 3);
    deleteColsInPlace(t, 4, 4);
    valid(t);
    const pg = newPage("DOCUMENT", 794, 1123, "p");
    pg.nodes.push(t);
    const xml = strFromU8(unzipSync(exportDocx([pg]))["word/document.xml"]);
    const cols = (xml.match(/<w:gridCol\b/g) ?? []).length;
    expect(cols).toBe(t.colWidths.length);
    const trs = xml.match(/<w:tr\b[\s\S]*?<\/w:tr>/g) ?? [];
    expect(trs).toHaveLength(t.rows.length);
    for (const tr of trs) {
      const spans = [...tr.matchAll(/<w:tc>([\s\S]*?)<\/w:tc>/g)].map((m) => Number(/<w:gridSpan w:val="(\d+)"/.exec(m[1])?.[1] ?? 1));
      expect(spans.reduce((a, b) => a + b, 0)).toBe(cols);
    }
    const files = unzipSync(exportHwpx([pg], "t"));
    const sec = strFromU8(files[Object.keys(files).find((k) => /section0\.xml$/i.test(k))!]);
    for (const m of sec.matchAll(/<hp:cellAddr colAddr="(\d+)" rowAddr="(\d+)"\/><hp:cellSpan colSpan="(\d+)" rowSpan="(\d+)"/g)) {
      expect(Number(m[1]) + Number(m[3])).toBeLessThanOrEqual(t.colWidths.length);
      expect(Number(m[2]) + Number(m[4])).toBeLessThanOrEqual(t.rows.length);
    }
    expect(sec).toContain(`colCnt="${t.colWidths.length}"`);
  });
});

describe("QA 11-20: spans starting in the deleted lines, and undo", () => {
  it("a horizontal merge starting in a deleted column moves right with its text", () => {
    const t = grid([[{ text: "m", colSpan: 3 }, "", ""], ["d", "e", "f"]]);
    expect(deleteColsInPlace(t, 0, 0)).toBe(true);
    expect(t.rows[0][0]).toMatchObject({ text: "m", colSpan: 2 });
    expect(texts(t)[1]).toEqual(["e", "f"]);
    valid(t);
  });
  it("a 2x2 merge starting in a deleted row keeps its width and text", () => {
    const t = grid([["a", "b", "c"], ["d", { text: "m", rowSpan: 2, colSpan: 2 }, ""], ["g", "", ""], ["j", "k", "l"]]);
    expect(deleteRowsInPlace(t, 0, 1)).toBe(true);
    expect(t.rows[0][1]).toMatchObject({ text: "m", colSpan: 2 });
    expect(t.rows[0][1].rowSpan).toBeUndefined();
    expect(texts(t)).toEqual([["g", "m", ""], ["j", "k", "l"]]);
    valid(t);
  });
  it("edits inside an immer draft leave the base (the undo state) exactly as it was", async () => {
    const { produce } = await import("immer");
    const base = grid([[{ text: "m", rowSpan: 2, colSpan: 2, richText: [{ runs: [{ text: "m" }] }] } as TableCell, "", "c"], ["", "", "f"], ["g", "h", "i"]]);
    const before = JSON.stringify(base);
    const next = produce(base, (d) => {
      insertRowsInPlace(d as TableNode, 1, 1);
      insertColsInPlace(d as TableNode, 1, 1);
      deleteRowsInPlace(d as TableNode, 0, 0);
      deleteColsInPlace(d as TableNode, 0, 0);
    });
    expect(JSON.stringify(base)).toBe(before);
    valid(next as TableNode);
    expect(next.rows[0][0]).toMatchObject({ text: "m", rowSpan: 2, colSpan: 2 });
  });
});