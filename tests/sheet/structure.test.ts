// Row / column insert and delete (io/sheet/structure.ts): Excel's reference rules.
import { describe, expect, it } from "vitest";
import type { SheetData } from "../../src/core/sheetTypes";
import { adjustFormula, adjustRefBody, adjustSqref, applyStructToBook, shiftSpan } from "../../src/io/sheet/structure";

const ins = (axis: "row" | "col", at: number, n = 1) => ({ axis, at, n });
const del = (axis: "row" | "col", at: number, n = 1) => ({ axis, at, n: -n });

function sheet(name: string, cells: SheetData["cells"], extra: Partial<SheetData> = {}): SheetData {
  return { book: "b", name, cells, styles: [{}], colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "Calibri", baseSize: 11, mdw: 7, ...extra };
}

describe("references", () => {
  it("inserted rows move references at or below them, absolute ones too", () => {
    expect(adjustRefBody("A5", ins("row", 2))).toBe("A6");
    expect(adjustRefBody("$A$5", ins("row", 2, 3))).toBe("$A$8");
    expect(adjustRefBody("A2", ins("row", 2))).toBe("A2");
    expect(adjustRefBody("A3", ins("row", 2))).toBe("A4");
  });
  it("a range around the insert grows; a range above it stays", () => {
    expect(adjustRefBody("A1:A10", ins("row", 4, 2))).toBe("A1:A12");
    expect(adjustRefBody("A1:A3", ins("row", 3))).toBe("A1:A3");
    expect(adjustRefBody("B$2:$C4", ins("col", 2))).toBe("B$2:$D4");
  });
  it("deleted cells are #REF!, ranges shrink, a range wholly deleted is #REF!", () => {
    expect(adjustRefBody("A3", del("row", 2))).toBeNull();
    expect(adjustRefBody("A1:A10", del("row", 2, 3))).toBe("A1:A7");
    expect(adjustRefBody("A3:A4", del("row", 2, 3))).toBeNull();
    expect(adjustRefBody("A2:A6", del("row", 3, 5))).toBe("A2:A3");
    expect(adjustRefBody("A5:A9", del("row", 1, 5))).toBe("A2:A4");
  });
  it("whole columns move with column changes only, whole rows with row changes only", () => {
    expect(adjustRefBody("C:D", ins("row", 0, 5))).toBe("C:D");
    expect(adjustRefBody("C:D", ins("col", 0))).toBe("D:E");
    expect(adjustRefBody("$C:$C", del("col", 2))).toBeNull();
    expect(adjustRefBody("2:3", ins("col", 0))).toBe("2:3");
    expect(adjustRefBody("2:3", ins("row", 0))).toBe("3:4");
  });
  it("formulas: own-sheet references, sheet-qualified ones, other sheets left alone", () => {
    expect(adjustFormula("SUM(A1:A10)+A11", ins("row", 4), "S", "S")).toBe("SUM(A1:A11)+A12");
    expect(adjustFormula("A3*2", del("row", 2), "S", "S")).toBe("#REF!*2");
    expect(adjustFormula("Data!B5+B5", ins("row", 0), "Other", "Data")).toBe("Data!B6+B5");
    expect(adjustFormula("'My data'!$B$5", ins("row", 0), "Other", "My data")).toBe("'My data'!$B$6");
    expect(adjustFormula("Data!B3", del("row", 2), "Other", "Data")).toBe("Data!#REF!");
    expect(adjustFormula('"A5"&A5', ins("row", 0), "S", "S")).toBe('"A5"&A6');
  });
  it("sqref lists drop deleted ranges", () => {
    expect(adjustSqref("A1:A5 C3 D7:D9", del("row", 2))).toBe("A1:A4 D6:D8");
    expect(shiftSpan(0, 4, del("row", 0, 5))).toBeNull();
  });
});

describe("a book", () => {
  it("moves cells, sizes, merges, formats, notes, names and other sheets' references", () => {
    const a = sheet("Data", {
      A1: { v: 1 },
      A2: { v: 2 },
      A3: { v: 3 },
      A4: { f: "SUM(A1:A3)", v: 6 },
      B4: { f: "$A$3", v: 3 },
    }, {
      rowH: { 2: 30 },
      hiddenRows: [3],
      merges: ["C1:D1", "C3:D3"],
      cond: [{ ranges: ["A1:A4"], rules: [{ type: "expression", formulas: ["A1>1"], priority: 1 }] }],
      notes: { A3: { text: "three" } },
      freeze: { rows: 2, cols: 0 },
      names: { Total: "Data!$A$4" },
      filter: { ref: "A1:B4" },
    });
    const b = sheet("Sum", { A1: { f: "Data!A4*2", v: 12 }, A2: { f: "A1", v: 12 } }, { names: { Total: "Data!$A$4" } });
    applyStructToBook([a, b], 0, ins("row", 1, 2));
    expect(a.cells.A1.v).toBe(1);
    expect(a.cells.A4.v).toBe(2);
    expect(a.cells.A6.f).toBe("SUM(A1:A5)");
    expect(a.cells.B6.f).toBe("$A$5");
    expect(a.rowH).toEqual({ 4: 30 });
    expect(a.hiddenRows).toEqual([5]);
    expect(a.merges).toEqual(["C1:D1", "C5:D5"]);
    expect(a.cond![0].ranges).toEqual(["A1:A6"]);
    expect(a.cond![0].rules[0].formulas).toEqual(["A1>1"]);
    expect(Object.keys(a.notes!)).toEqual(["A5"]);
    expect(a.freeze).toEqual({ rows: 4, cols: 0 });
    expect(a.names!.Total).toBe("Data!$A$6");
    expect(a.filter!.ref).toBe("A1:B6");
    expect(b.cells.A1.f).toBe("Data!A6*2");
    expect(b.cells.A2.f).toBe("A1");
    expect(b.names!.Total).toBe("Data!$A$6");

    applyStructToBook([a, b], 0, del("row", 3, 2)); // the old rows 2–3 (values 2, 3)
    expect(a.cells.A4.f).toBe("SUM(A1:A3)");
    expect(a.cells.B4.f).toBe("#REF!");
    expect(a.notes).toEqual({});
    expect(a.merges).toEqual(["C1:D1"]);
  });
  it("columns: widths and AutoFilter columns move", () => {
    const a = sheet("S", { C1: { v: "h" } }, { colW: { 2: 100 }, hiddenCols: [4], filter: { ref: "B1:D5", cols: { 1: { vals: ["x"] } } } });
    applyStructToBook([a], 0, ins("col", 0));
    expect(a.cells.D1.v).toBe("h");
    expect(a.colW).toEqual({ 3: 100 });
    expect(a.hiddenCols).toEqual([5]);
    expect(a.filter).toEqual({ ref: "C1:E5", cols: { 1: { vals: ["x"] } } });
    applyStructToBook([a], 0, ins("col", 3));
    expect(a.filter).toEqual({ ref: "C1:F5", cols: { 2: { vals: ["x"] } } });
  });
});
