// Merged table cells: layout, drawing (canvas and the PDF writer use the same cells), hit testing, 셀 합치기 / 셀 나누기.
import { describe, expect, it } from "vitest";
import { anchorOf, cellAt, coverMap, expandRange, layoutTable, mergeCellsInPlace, splitCellInPlace, tableCells } from "../src/core/table";
import { newTable, type TableCell, type TableNode } from "../src/core/types";
import { drawTable } from "../src/render/draw";

/** Omni 분기 보고서 table 1: a vertical merge in the first column, a horizontal one in the total row */
function report(): TableNode {
  const t = newTable(
    [
      ["분류", "지표", "10월"],
      [{ text: "사용", rowSpan: 2 }, "활성 사용자", "12,480"],
      ["", "새 문서", "41,205"],
      [{ text: "분기 합계", colSpan: 2, align: "CENTER" }, "", "133,407"],
    ].map((r) => r.map((c) => (typeof c === "string" ? { text: c } : (c as TableCell)))),
    [80, 160, 100],
  );
  return t;
}

/** a canvas context that records what is drawn */
function recorder() {
  const calls: { op: string; args: unknown[]; fill?: string }[] = [];
  const ctx: any = new Proxy(
    { fillStyle: "", strokeStyle: "", font: "", lineWidth: 1, textBaseline: "" },
    {
      get(target, k: string) {
        if (k in target) return (target as any)[k];
        return (...args: unknown[]) => calls.push({ op: k, args, fill: (target as any).fillStyle });
      },
      set(target, k: string, v) {
        (target as any)[k] = v;
        return true;
      },
    },
  );
  return { ctx, calls };
}

describe("merged cells", () => {
  it("the cover map and visible cells follow the spans", () => {
    const t = report();
    const cover = coverMap(t.rows);
    expect(cover[2][0]).toEqual({ r: 1, c: 0 });
    expect(cover[3][1]).toEqual({ r: 3, c: 0 });
    expect(tableCells(t).map((v) => `${v.r}${v.c}:${v.rs}x${v.cs}`)).toEqual(["00:1x1", "01:1x1", "02:1x1", "10:2x1", "11:1x1", "12:1x1", "21:1x1", "22:1x1", "30:1x2", "32:1x1"]);
  });

  it("a merged cell is laid out, drawn and hit over its whole range", () => {
    const t = report();
    const l = layoutTable(t);
    const total = tableCells(t).find((v) => v.r === 3 && v.c === 0)!;
    expect(total.rect).toEqual({ x: 0, y: l.rowY[3], w: 240, h: l.rowY[4] - l.rowY[3] });
    const use = tableCells(t).find((v) => v.r === 1 && v.c === 0)!;
    expect(use.rect.h).toBe(l.rowY[3] - l.rowY[1]);
    // hit: the covered cell answers with its top-left cell
    expect(cellAt(t, 10, l.rowY[2] + 3)).toEqual({ row: 1, col: 0 });
    expect(cellAt(t, 200, l.rowY[3] + 3)).toEqual({ row: 3, col: 0 });
    expect(anchorOf(t, 2, 1)).toEqual({ row: 2, col: 1 });
    // drawn: no line inside the merged range, the centred total in the middle of both columns
    const { ctx, calls } = recorder();
    drawTable(ctx, t);
    const rects = calls.filter((c) => c.op === "rect").map((c) => c.args.join(","));
    expect(rects).toContain(`0,${l.rowY[3]},240,${l.rowY[4] - l.rowY[3]}`);
    expect(rects).not.toContain(`80,${l.rowY[3]},160,${l.rowY[4] - l.rowY[3]}`);
    const total2 = calls.find((c) => c.op === "fillText" && c.args[0] === "분기 합계")!;
    expect(total2.args[1] as number).toBeGreaterThan(80);
    expect(calls.some((c) => c.op === "moveTo")).toBe(false); // grid lines only for tables without merges
  });

  it("a row grows when a cell spanning it needs more room than the rows give", () => {
    const t = newTable([[{ text: "긴 글\n둘\n셋\n넷\n다섯", rowSpan: 2 }, { text: "a" }], [{ text: "" }, { text: "b" }]], [100, 100]);
    t.headerRow = false;
    const l = layoutTable(t);
    expect(l.rowY[2] - l.rowY[0]).toBeGreaterThanOrEqual(5 * t.fontSize * 1.35);
    expect(l.rowY[1] - l.rowY[0]).toBe(t.rowHeight);
  });

  it("셀 합치기: the range grows over merged cells it touches, texts are kept, covered cells empty", () => {
    const t = report();
    expect(expandRange(t.rows, { r0: 2, c0: 0, r1: 2, c1: 1 })).toEqual({ r0: 1, c0: 0, r1: 2, c1: 1 });
    expect(mergeCellsInPlace(t, { r0: 1, c0: 1, r1: 2, c1: 2 })).toBe(true);
    expect(t.rows[1][1]).toMatchObject({ text: "활성 사용자\n12,480\n새 문서\n41,205", rowSpan: 2, colSpan: 2 });
    expect(t.rows[2][2]).toEqual({ text: "" });
    expect(mergeCellsInPlace(t, { r0: 0, c0: 0, r1: 0, c1: 0 })).toBe(false);
  });

  it("셀 나누기: a merged cell goes back to its grid; a single cell splits into two columns", () => {
    const t = report();
    expect(splitCellInPlace(t, 2, 0)).toBe("unmerged");
    expect(t.rows[1][0].rowSpan).toBeUndefined();
    expect(splitCellInPlace(t, 0, 2)).toBe("split");
    expect(t.colWidths).toEqual([80, 160, 50, 50]);
    expect(t.rows.every((r) => r.length === 4)).toBe(true);
    // the other rows' cells in that column now span both halves
    expect(t.rows[1][2].colSpan).toBe(2);
    expect(t.rows[3][2].colSpan).toBe(2);
    expect(t.rows[3][0].colSpan).toBe(2); // the total row's own merge is unchanged
    expect(tableCells(t).filter((v) => v.r === 0).length).toBe(4);
  });
});
