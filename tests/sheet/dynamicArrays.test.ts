// Dynamic arrays (spill, #SPILL!, A1#), the array functions (FILTER SORT SORTBY UNIQUE SEQUENCE LET …), element-wise
// array formulas, structured references (Table1[Col]) and how array formulas are read from and written to .xlsx.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { SheetCell, SheetData, SheetTable } from "../../src/core/sheetTypes";
import type { OmwDocument } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { applyChange, Book, recalcAll } from "../../src/io/sheet/calc";
import { fileFormula, shownFormula, writeFreshXlsx } from "../../src/io/sheet/book";
import { readXlsx } from "../../src/io/sheet/read";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

type Cells = Record<string, SheetCell>;
function sheet(cells: Cells, extra: Partial<SheetData> = {}): SheetData {
  return { book: "b", name: "S", cells, styles: [{}], colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "Calibri", baseSize: 11, mdw: 7, ...extra };
}
/** cells from "A1: value" pairs; text starting with "=" is a formula */
function cells(spec: Record<string, string | number | boolean>): Cells {
  const out: Cells = {};
  for (const [a, x] of Object.entries(spec)) out[a] = typeof x === "string" && x.startsWith("=") ? { f: x.slice(1) } : { v: x };
  return out;
}
/** a sheet calculated from scratch */
function calc(spec: Record<string, string | number | boolean>, extra: Partial<SheetData> = {}): SheetData {
  const sh = sheet(cells(spec), extra);
  recalcAll([sh]);
  return sh;
}
/** an edit with the recalculation it causes, applied as the grid does */
function edit(sheets: SheetData[], si: number, a: string, cell: SheetCell | undefined) {
  if (cell) sheets[si].cells[a] = cell;
  else delete sheets[si].cells[a];
  const b = new Book(sheets);
  for (const ch of b.recalc(b.dependents([{ sheet: si, addr: a }]))) applyChange(sheets[ch.sheet], ch);
}
const col = (sh: SheetData, list: string) => list.split(" ").map((a) => sh.cells[a]?.v);

describe("spill", () => {
  it("an array result fills the cells right and below; they have values and no formula of their own", () => {
    const sh = calc({ B2: "=SEQUENCE(3,2)" });
    expect(sh.cells.B2).toMatchObject({ f: "SEQUENCE(3,2)", v: 1, spill: "B2:C4" });
    expect(col(sh, "B2 C2 B3 C3 B4 C4")).toEqual([1, 2, 3, 4, 5, 6]);
    expect(sh.cells.C4).toEqual({ v: 6, sp: "B2" });
    expect(sh.cells.B5).toBeUndefined();
  });

  it("#SPILL! when a cell in the way is not empty; clearing it spills again", () => {
    const sheets = [sheet(cells({ A1: "=SEQUENCE(3)", A3: "x" }))];
    recalcAll(sheets);
    const sh = sheets[0];
    expect(sh.cells.A1).toMatchObject({ v: "#SPILL!", t: "e", spill: "A1:A3" });
    expect(sh.cells.A2).toBeUndefined();
    edit(sheets, 0, "A3", undefined);
    expect(col(sh, "A1 A2 A3")).toEqual([1, 2, 3]);
    expect(sh.cells.A1.t).toBeUndefined();
    // typing into the spill range blocks it again and the spilled values go
    edit(sheets, 0, "A2", { v: 7 });
    expect(sh.cells.A1.v).toBe("#SPILL!");
    expect(sh.cells.A2).toEqual({ v: 7 });
    expect(sh.cells.A3).toBeUndefined();
  });

  it("a merged cell in the way, or a range past the sheet's edge, is #SPILL! too", () => {
    expect(calc({ A1: "=SEQUENCE(2,2)" }, { merges: ["B2:C2"] }).cells.A1.v).toBe("#SPILL!");
    expect(calc({ A1048575: "=SEQUENCE(5)" }).cells.A1048575.v).toBe("#SPILL!");
  });

  it("editing the anchor re-spills: a smaller result empties the cells no longer filled, readers follow", () => {
    const sheets = [sheet(cells({ A1: "=SEQUENCE(4)", C1: "=SUM(A1:A10)", D1: "=A4" }))];
    recalcAll(sheets);
    const sh = sheets[0];
    expect(sh.cells.C1.v).toBe(10);
    expect(sh.cells.D1.v).toBe(4);
    edit(sheets, 0, "A1", { f: "SEQUENCE(2,1,10)" });
    expect(col(sh, "A1 A2")).toEqual([10, 11]);
    expect(sh.cells.A3).toBeUndefined();
    expect(sh.cells.A4).toBeUndefined();
    expect(sh.cells.A1.spill).toBe("A1:A2");
    expect(sh.cells.C1.v).toBe(21);
    expect(sh.cells.D1.v).toBe(0);
    // a plain value over the anchor: the spill goes away
    edit(sheets, 0, "A1", { v: 5 });
    expect(sh.cells.A2).toBeUndefined();
    expect(sh.cells.C1.v).toBe(5);
  });

  it("a source change re-spills and A1# follows the spill range", () => {
    const sheets = [sheet(cells({ A1: 3, B1: "=SEQUENCE(A1)", C1: "=SUM(B1#)", D1: "=ROWS(B1#)", E1: "=B1#*10" }))];
    recalcAll(sheets);
    const sh = sheets[0];
    expect(sh.cells.C1.v).toBe(6);
    expect(sh.cells.D1.v).toBe(3);
    expect(col(sh, "E1 E2 E3")).toEqual([10, 20, 30]);
    edit(sheets, 0, "A1", { v: 5 });
    expect(col(sh, "B1 B2 B3 B4 B5")).toEqual([1, 2, 3, 4, 5]);
    expect(sh.cells.C1.v).toBe(15);
    expect(sh.cells.D1.v).toBe(5);
    expect(col(sh, "E4 E5")).toEqual([40, 50]);
    expect(calc({ A1: 1, B1: "=SUM(A1#)" }).cells.B1.v).toBe("#REF!");
  });

  it("chained spills: an array formula reading another one's spill", () => {
    const sh = calc({ A1: "=SEQUENCE(4)", B1: "=FILTER(A1:A4,A1:A4>2)", C1: "=SORT(B1#,1,-1)" });
    expect(col(sh, "B1 B2 C1 C2")).toEqual([3, 4, 4, 3]);
  });
});

describe("array functions", () => {
  const data = { A1: "b", A2: "a", A3: "c", A4: "a", B1: 2, B2: 5, B3: 1, B4: 7 };

  it("FILTER: rows or columns by a condition, if_empty, #CALC!, shape check", () => {
    let sh = calc({ ...data, D1: "=FILTER(A1:B4,B1:B4>=2)" });
    expect(col(sh, "D1 E1 D2 E2 D3 E3")).toEqual(["b", 2, "a", 5, "a", 7]);
    expect(sh.cells.D4).toBeUndefined();
    sh = calc({ ...data, D1: '=FILTER(A1:A4,(A1:A4="a")*(B1:B4>5))' });
    expect(sh.cells.D1.v).toBe("a");
    expect(sh.cells.D2).toBeUndefined();
    expect(calc({ ...data, D1: '=FILTER(A1:A4,B1:B4>99,"none")' }).cells.D1.v).toBe("none");
    expect(calc({ ...data, D1: "=FILTER(A1:A4,B1:B4>99)" }).cells.D1).toMatchObject({ v: "#CALC!", t: "e" });
    expect(calc({ ...data, D1: "=FILTER(A1:A4,B1:B2>1)" }).cells.D1.v).toBe("#VALUE!");
    sh = calc({ A1: 1, B1: 2, C1: 3, A5: "=FILTER(A1:C1,A1:C1<>2)" });
    expect(col(sh, "A5 B5")).toEqual([1, 3]);
  });

  it("SORT: by a column, descending, several keys, by columns", () => {
    let sh = calc({ ...data, D1: "=SORT(A1:B4)" });
    expect(col(sh, "D1 D2 D3 D4")).toEqual(["a", "a", "b", "c"]);
    expect(col(sh, "E1 E2")).toEqual([5, 7]); // stable
    sh = calc({ ...data, D1: "=SORT(A1:B4,2,-1)" });
    expect(col(sh, "E1 E2 E3 E4")).toEqual([7, 5, 2, 1]);
    sh = calc({ ...data, D1: "=SORT(A1:B4,{1,2},{1,-1})" });
    expect(col(sh, "D1 E1 D2 E2")).toEqual(["a", 7, "a", 5]);
    sh = calc({ A1: 3, B1: 1, C1: 2, A3: "=SORT(A1:C1,1,1,TRUE)" });
    expect(col(sh, "A3 B3 C3")).toEqual([1, 2, 3]);
    expect(calc({ ...data, D1: "=SORT(A1:B4,3)" }).cells.D1.v).toBe("#VALUE!");
  });

  it("SORTBY: by other arrays, several keys", () => {
    let sh = calc({ ...data, D1: "=SORTBY(A1:A4,B1:B4,-1)" });
    expect(col(sh, "D1 D2 D3 D4")).toEqual(["a", "a", "b", "c"]);
    sh = calc({ ...data, D1: "=SORTBY(B1:B4,A1:A4,1,B1:B4,-1)" });
    expect(col(sh, "D1 D2 D3 D4")).toEqual([7, 5, 2, 1]);
    expect(calc({ ...data, D1: "=SORTBY(A1:A4,B1:B3)" }).cells.D1.v).toBe("#VALUE!");
  });

  it("UNIQUE: first occurrences (text without case), exactly once, by columns", () => {
    let sh = calc({ A1: "a", A2: "B", A3: "A", A4: "c", A5: "b", C1: "=UNIQUE(A1:A5)" });
    expect(col(sh, "C1 C2 C3")).toEqual(["a", "B", "c"]);
    expect(sh.cells.C4).toBeUndefined();
    sh = calc({ A1: "a", A2: "B", A3: "A", A4: "c", A5: "b", C1: "=UNIQUE(A1:A5,,TRUE)" });
    expect(sh.cells.C1.v).toBe("c");
    expect(sh.cells.C2).toBeUndefined();
    sh = calc({ A1: 1, B1: 2, C1: 1, A3: "=UNIQUE(A1:C1,TRUE)" });
    expect(col(sh, "A3 B3 C3")).toEqual([1, 2, undefined]);
    sh = calc({ A1: 1, A2: 1, C1: "=UNIQUE(A1:A2,,TRUE)" });
    expect(sh.cells.C1.v).toBe("#CALC!");
  });

  it("SEQUENCE and RANDARRAY", () => {
    const sh = calc({ A1: "=SEQUENCE(2,3,10,-2)" });
    expect(col(sh, "A1 B1 C1 A2 B2 C2")).toEqual([10, 8, 6, 4, 2, 0]);
    expect(calc({ A1: "=SEQUENCE(0)" }).cells.A1.v).toBe("#CALC!");
    const r = calc({ A1: "=RANDARRAY(3,2,5,9,TRUE)" });
    const vals = col(r, "A1 B1 A2 B2 A3 B3") as number[];
    expect(vals.every((x) => Number.isInteger(x) && x >= 5 && x <= 9)).toBe(true);
    expect(r.cells.A4).toBeUndefined();
  });

  it("TRANSPOSE, CHOOSECOLS / CHOOSEROWS, TAKE / DROP, VSTACK / HSTACK, TOCOL, WRAPROWS, EXPAND", () => {
    const g = { A1: 1, B1: 2, C1: 3, A2: 4, B2: 5, C2: 6 };
    expect(col(calc({ ...g, A4: "=LET(t,TRANSPOSE(A1:C2),t)" }), "A4 B4 A5 B5 A6 B6")).toEqual([1, 4, 2, 5, 3, 6]);
    expect(col(calc({ ...g, A4: "=CHOOSECOLS(A1:C2,3,1)" }), "A4 B4 A5 B5")).toEqual([3, 1, 6, 4]);
    expect(col(calc({ ...g, A4: "=CHOOSEROWS(A1:C2,-1)" }), "A4 B4 C4")).toEqual([4, 5, 6]);
    expect(calc({ ...g, A4: "=CHOOSECOLS(A1:C2,4)" }).cells.A4.v).toBe("#VALUE!");
    expect(col(calc({ ...g, A4: "=TAKE(A1:C2,1,-2)" }), "A4 B4")).toEqual([2, 3]);
    expect(col(calc({ ...g, A4: "=DROP(A1:C2,1,1)" }), "A4 B4")).toEqual([5, 6]);
    expect(calc({ ...g, A4: "=DROP(A1:C2,2)" }).cells.A4.v).toBe("#CALC!");
    expect(col(calc({ ...g, A4: "=VSTACK(A1:B1,C2)" }), "A4 B4 A5 B5")).toEqual([1, 2, 6, "#N/A"]);
    expect(col(calc({ ...g, A4: "=HSTACK(A1:A2,C1:C2)" }), "A4 B4 A5 B5")).toEqual([1, 3, 4, 6]);
    expect(col(calc({ ...g, A4: "=TOCOL(A1:C2,,TRUE)" }), "A4 A5 A6 A7 A8 A9")).toEqual([1, 4, 2, 5, 3, 6]);
    expect(col(calc({ ...g, A4: "=WRAPROWS(TOCOL(A1:C2),4,0)" }), "A4 D4 A5 B5 C5")).toEqual([1, 4, 5, 6, 0]);
    expect(col(calc({ ...g, A4: '=EXPAND(A1:A1,2,2,"-")' }), "A4 B4 A5 B5")).toEqual([1, "-", "-", "-"]);
  });

  it("TEXTSPLIT: columns, rows, several delimiters, ignore empty, padding", () => {
    expect(col(calc({ A1: "a,b;c", B1: '=TEXTSPLIT(A1,",",";")' }), "B1 C1 B2 C2")).toEqual(["a", "b", "c", "#N/A"]);
    expect(col(calc({ A1: "a,,b-c", B1: '=TEXTSPLIT(A1,{",","-"},,TRUE)' }), "B1 C1 D1")).toEqual(["a", "b", "c"]);
    expect(col(calc({ A1: "aXbxc", B1: '=TEXTSPLIT(A1,"x",,,1)' }), "B1 C1 D1")).toEqual(["a", "b", "c"]);
  });

  it("XLOOKUP returns a whole row (spills), searches from the end", () => {
    const sh = calc({ A1: "k1", B1: 1, C1: 2, A2: "k2", B2: 3, C2: 4, A3: "k1", B3: 5, C3: 6, E1: '=XLOOKUP("k2",A1:A3,B1:C3)', E3: '=XLOOKUP("k1",A1:A3,B1:B3,,0,-1)' });
    expect(col(sh, "E1 F1")).toEqual([3, 4]);
    expect(sh.cells.E3.v).toBe(5);
  });

  it("operators and scalar functions work element by element inside array formulas", () => {
    const d = { A1: "ab", A2: "c", A3: "def", B1: 1, B2: 2, B3: 3 };
    expect(col(calc({ ...d, D1: "=LET(x,B1:B3*2+1,x)" }), "D1 D2 D3")).toEqual([3, 5, 7]);
    expect(calc({ ...d, D1: "=LET(n,LEN(A1:A3),SUM(n))" }).cells.D1.v).toBe(6);
    expect(col(calc({ ...d, D1: '=VSTACK(IF(B1:B3>1,A1:A3,"-"))' }), "D1 D2 D3")).toEqual(["-", "c", "def"]);
    expect(col(calc({ ...d, D1: "=VSTACK(B1:B3*{10,100})" }), "D1 E1 D3 E3")).toEqual([10, 100, 30, 300]);
    // legacy formulas keep implicit intersection; SUMPRODUCT works on arrays
    expect(calc({ ...d, C2: "=B1:B3*2" }).cells.C2.v).toBe(4);
    expect(calc({ ...d, D1: "=SUMPRODUCT((B1:B3>1)*B1:B3)" }).cells.D1.v).toBe(5);
    expect(calc({ ...d, D1: "=SUMPRODUCT(LEN(A1:A3))" }).cells.D1.v).toBe(6);
  });
});

describe("LET", () => {
  it("names in order, each seeing the ones before", () => {
    expect(calc({ A1: 4, B1: "=LET(x,A1,y,x*3,x+y)" }).cells.B1.v).toBe(16);
  });
  it("an inner LET shadows an outer name only inside it", () => {
    expect(calc({ B1: "=LET(x,1,LET(x,2,x*10)+x)" }).cells.B1.v).toBe(21);
  });
  it("LET names do not reach defined names, other cells or after the call", () => {
    const names = { x: "100", n: "x*2" };
    expect(calc({ B1: "=LET(x,1,x+n)" }, { names }).cells.B1.v).toBe(201);
    expect(calc({ A1: "=x+1", B1: "=LET(x,1,A1)" }, { names }).cells.B1.v).toBe(101);
    expect(calc({ B1: "=LET(y,1,y)+LET(z,2,z)" }).cells.B1.v).toBe(3);
    expect(calc({ B1: "=LET(y,1,y)+y" }).cells.B1.v).toBe("#NAME?");
  });
  it("a name given a range keeps it a range; wrong shapes are #VALUE!", () => {
    expect(calc({ A1: 2, A2: 3, B1: "=LET(r,A1:A2,ROWS(r)*SUM(r))" }).cells.B1.v).toBe(10);
    expect(calc({ B1: "=LET(x,1)" }).cells.B1.v).toBe("#VALUE!");
    expect(calc({ B1: "=LET(1,1,2)" }).cells.B1.v).toBe("#VALUE!");
  });
});

describe("structured references", () => {
  const sales: SheetTable = { name: "Sales", ref: "A1:C5", cols: ["Region", "Amt", "Unit Qty"], totals: true };
  const data = { A1: "Region", B1: "Amt", C1: "Unit Qty", A2: "N", B2: 10, C2: 1, A3: "S", B3: 20, C3: 2, A4: "N", B4: 30, C4: 3, A5: "Total", B5: "=SUBTOTAL(9,B2:B4)" };

  it("columns, specials and column ranges", () => {
    const sh = calc(
      {
        ...data,
        B5: 60,
        E1: "=SUM(Sales[Amt])",
        E2: "=ROWS(Sales[#All])",
        E3: "=Sales[[#Headers],[Unit Qty]]",
        E4: "=COUNTA(Sales[[Region]:[Amt]])",
        E5: '=SUMIFS(Sales[Amt],Sales[Region],"N")',
        E6: "=Sales[[#Totals],[Amt]]",
        E7: "=ROWS(Sales[[#Headers],[#Data]])",
        E8: "=SUM(Sales[Unit Qty])",
        E9: "=Nope[Amt]",
        E10: "=Sales[Nope]",
        E11: "=ROWS(Sales)",
      },
      { tables: [sales] },
    );
    expect(col(sh, "E1 E2 E3 E4 E5 E6 E7 E8")).toEqual([60, 5, "Unit Qty", 6, 40, 60, 4, 6]);
    expect(col(sh, "E9 E10")).toEqual(["#REF!", "#REF!"]);
    expect(sh.cells.E11.v).toBe(3);
  });

  it("this row: [@Col] inside the table, Table[@Col] and the file form [[#This Row],[Col]] beside it", () => {
    const sh = calc({ ...data, B5: 60, D2: "=[@Amt]*[@[Unit Qty]]", F3: "=Sales[@Amt]+1", G4: "=Sales[[#This Row],[Amt]]", F9: "=Sales[@Amt]" }, { tables: [{ ...sales, ref: "A1:D5", cols: [...sales.cols, "Calc"] }] });
    expect(sh.cells.D2.v).toBe(10);
    expect(sh.cells.F3.v).toBe(21);
    expect(sh.cells.G4.v).toBe(30);
    expect(sh.cells.F9.v).toBe("#VALUE!");
  });

  it("a table on another sheet; the reference spills where it is an array formula", () => {
    const s1 = sheet(cells(data), { name: "Data", tables: [sales] });
    const s2 = sheet(cells({ A1: "=SORT(Sales[Amt],,-1)" }), { name: "Out" });
    recalcAll([s1, s2]);
    expect(col(s2, "A1 A2 A3")).toEqual([30, 20, 10]);
  });
});

describe("formula text in files", () => {
  it("prefixes: _xlfn._xlws. for FILTER / SORT, _xlfn. for the others, _xlpm. for LET names, ANCHORARRAY for A1#", () => {
    expect(fileFormula("SORT(FILTER(A1:A9,A1:A9>0))")).toBe("_xlfn._xlws.SORT(_xlfn._xlws.FILTER(A1:A9,A1:A9>0))");
    expect(fileFormula("UNIQUE(A1:A3)+SEQUENCE(2)+SORTBY(A1:A2,B1:B2)")).toBe("_xlfn.UNIQUE(A1:A3)+_xlfn.SEQUENCE(2)+_xlfn.SORTBY(A1:A2,B1:B2)");
    expect(fileFormula("LET(x, 1, total, x+SUM(A1:A3), total*x)")).toBe("_xlfn.LET(_xlpm.x, 1, _xlpm.total, _xlpm.x+SUM(A1:A3), _xlpm.total*_xlpm.x)");
    expect(fileFormula("SUM(B1#)+Sheet2!C3#")).toBe("SUM(_xlfn.ANCHORARRAY(B1))+_xlfn.ANCHORARRAY(Sheet2!C3)");
    expect(fileFormula("[@Amt]*Sales[@[Unit Qty]]")).toBe("[[#This Row],[Amt]]*Sales[[#This Row],[Unit Qty]]");
    expect(fileFormula("Sales[Amt]")).toBe("Sales[Amt]");
    expect(fileFormula("@A1:A3+1")).toBe("_xlfn.SINGLE(A1:A3)+1");
    expect(fileFormula("@SEQUENCE(3)*2")).toBe("_xlfn.SINGLE(_xlfn.SEQUENCE(3))*2");
  });
  it("@ is implicit intersection (one value) inside an array formula", () => {
    const sh = calc({ A1: 1, A2: 2, A3: 3, B2: "=@A1:A3*10", C1: "=@SEQUENCE(3)+LET(x,1,x)", D1: "=_xlfn.SINGLE(A1:A3)" });
    expect(sh.cells.B2.v).toBe(20);
    expect(sh.cells.C1.v).toBe(2);
    expect(sh.cells.C2).toBeUndefined();
    expect(sh.cells.D1.v).toBe(1);
    expect(shownFormula("_xlfn.SINGLE(A1:A3)+1")).toBe("@(A1:A3)+1");
  });
  it("shown as typed: no prefixes, A1#, [@Col]", () => {
    expect(shownFormula("_xlfn._xlws.SORT(_xlfn.ANCHORARRAY(B1))")).toBe("SORT(B1#)");
    expect(shownFormula("_xlfn.LET(_xlpm.x,1,_xlpm.x+1)")).toBe("LET(x,1,x+1)");
    expect(shownFormula("Sales[[#This Row],[Amt]]+Sales[[#This Row],[Unit Qty]]")).toBe("Sales[@Amt]+Sales[@[Unit Qty]]");
  });
  it("file formulas calculate: _xlfn._xlws. names, _xlpm. names, ANCHORARRAY", () => {
    const sh = calc({ A1: "=_xlfn.SEQUENCE(3)", B1: "=_xlfn.LET(_xlpm.s,SUM(_xlfn.ANCHORARRAY(A1)),_xlpm.s*2)", C1: "=_xlfn._xlws.SORT(A1:A3,1,-1)" });
    expect(sh.cells.B1.v).toBe(12);
    expect(col(sh, "C1 C2 C3")).toEqual([3, 2, 1]);
  });
});

// ───── .xlsx round trip ─────

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function xlsx(sheetData: string, opts: { metadata?: boolean; table?: string } = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${opts.metadata ? '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>' : ""}${opts.table ? '<Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/>' : ""}</Types>`,
    ),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="DA" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${opts.metadata ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"/>' : ""}</Relationships>`,
    ),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheetData}</sheetData>${opts.table ? '<tableParts count="1"><tablePart r:id="rId1"/></tableParts>' : ""}</worksheet>`),
  };
  if (opts.metadata)
    files["xl/metadata.xml"] = strToU8(
      `<?xml version="1.0"?><metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray"><metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes><futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata><cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata></metadata>`,
    );
  if (opts.table) {
    files["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>');
    files["xl/tables/table1.xml"] = strToU8(opts.table);
  }
  return zipSync(files);
}
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "da.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
/** OMW_DA_OUT=<folder>: keep the written workbooks (to open them in Excel) */
const dump = (name: string, bytes: Uint8Array) => {
  const dir = process.env.OMW_DA_OUT;
  if (dir) writeFileSync(join(dir, name), bytes);
};
const sheetsOf = (doc: OmwDocument) => doc.pages.filter((p) => p.sheet).map((p) => p.sheet!);

const DA_DATA =
  `<row r="1"><c r="A1"><v>3</v></c><c r="B1"><v>1</v></c><c r="C1" cm="1"><f t="array" ref="C1:C3">_xlfn._xlws.SORT(A1:A3,1,-1)</f><v>3</v></c></row>` +
  `<row r="2"><c r="A2"><v>1</v></c><c r="C2"><v>2</v></c></row>` +
  `<row r="3"><c r="A3"><v>2</v></c><c r="C3"><v>1</v></c></row>`;

describe("dynamic arrays in .xlsx", () => {
  it("reading: the anchor gets its spill range, the spilled cells their anchor; an unedited workbook saves byte for byte", async () => {
    const bytes = xlsx(DA_DATA, { metadata: true });
    const sh = readXlsx(bytes).sheets[0];
    expect(sh.cells.C1).toMatchObject({ f: "_xlfn._xlws.SORT(A1:A3,1,-1)", spill: "C1:C3", v: 3 });
    expect(sh.cells.C1.cse).toBeUndefined();
    expect(sh.cells.C3).toEqual({ v: 1, sp: "C1" });
    const doc = await open(bytes);
    expect(Buffer.from(await save(doc)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("an edit that re-spills is saved in place: <f t=array ref> with cm, spilled values as cached values", async () => {
    const bytes = xlsx(DA_DATA, { metadata: true });
    const doc = await open(bytes);
    const sheets = sheetsOf(doc);
    edit(sheets, 0, "A4", { v: 9 }); // outside the sorted range: nothing changes
    edit(sheets, 0, "C1", { f: "SORT(A1:A4,1,-1)" });
    expect(col(sheets[0], "C1 C2 C3 C4")).toEqual([9, 3, 2, 1]);
    const out = await save(doc);
    dump("surgical-respill.xlsx", out);
    const x = part(out, "xl/worksheets/sheet1.xml");
    expect(x).toContain('<c r="C1" cm="1"><f t="array" ref="C1:C4">_xlfn._xlws.SORT(A1:A4,1,-1)</f><v>9</v></c>');
    expect(x).toContain('<c r="C4"><v>1</v></c>');
    expect(part(out, "xl/metadata.xml")).toBe(part(bytes, "xl/metadata.xml"));
    expect(part(out, "xl/styles.xml")).toBe(part(bytes, "xl/styles.xml"));
    const back = readXlsx(out).sheets[0];
    expect(back.cells.C1.spill).toBe("C1:C4");
    expect(back.cells.C4.sp).toBe("C1");
  });

  it("a source change: spilled values are rewritten in place (the anchor unchanged)", async () => {
    const doc = await open(xlsx(DA_DATA, { metadata: true }));
    const sheets = sheetsOf(doc);
    edit(sheets, 0, "A2", { v: 2.5 });
    expect(col(sheets[0], "C1 C2 C3")).toEqual([3, 2.5, 2]);
    const x = part(await save(doc), "xl/worksheets/sheet1.xml");
    expect(x).toContain('<c r="C2"><v>2.5</v></c>');
    expect(x).toContain('<f t="array" ref="C1:C3">_xlfn._xlws.SORT(A1:A3,1,-1)</f>');
  });

  it("a new dynamic array in a workbook without metadata: metadata.xml, its relationship and content type are added", async () => {
    const bytes = xlsx(`<row r="1"><c r="A1"><v>1</v></c></row>`);
    const doc = await open(bytes);
    const sheets = sheetsOf(doc);
    edit(sheets, 0, "B1", { f: "LET(n,3,SEQUENCE(n))" });
    expect(sheets[0].cells.B3).toEqual({ v: 3, sp: "B1" });
    const out = await save(doc);
    dump("surgical-new.xlsx", out);
    expect(part(out, "xl/worksheets/sheet1.xml")).toContain('<c r="B1" cm="1"><f t="array" ref="B1:B3">_xlfn.LET(_xlpm.n,3,_xlfn.SEQUENCE(_xlpm.n))</f><v>1</v></c>');
    expect(part(out, "xl/metadata.xml")).toContain('name="XLDAPR"');
    expect(part(out, "xl/_rels/workbook.xml.rels")).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sheetMetadata" Target="metadata.xml"');
    expect(part(out, "[Content_Types].xml")).toContain('PartName="/xl/metadata.xml"');
    const back = readXlsx(out).sheets[0];
    expect(back.cells.B1).toMatchObject({ spill: "B1:B3" });
    expect(back.cells.B1.cse).toBeUndefined();
  });

  it("a fresh workbook (no original) gets the metadata too", () => {
    const sh = calc({ A1: 4, A2: 1, B1: "=SORT(A1:A2)", C1: "=LET(x,A1,x*2)" });
    const out = writeFreshXlsx([sh]);
    dump("fresh.xlsx", out);
    const x = part(out, "xl/worksheets/sheet1.xml");
    expect(x).toContain('<c r="B1" cm="1"><f t="array" ref="B1:B2">_xlfn._xlws.SORT(A1:A2)</f><v>1</v></c>');
    expect(x).toContain('<c r="B2"><v>4</v></c>');
    expect(x).toContain("<f>_xlfn.LET(_xlpm.x,A1,_xlpm.x*2)</f>");
    expect(part(out, "xl/metadata.xml")).toContain("dynamicArrayProperties");
    expect(part(out, "[Content_Types].xml")).toContain("sheetMetadata+xml");
  });

  it("a blocked dynamic array is written as #SPILL! covering its own cell", async () => {
    const doc = await open(xlsx(`<row r="2"><c r="A2"><v>1</v></c></row>`));
    const sheets = sheetsOf(doc);
    edit(sheets, 0, "A1", { f: "SEQUENCE(3)" });
    expect(sheets[0].cells.A1.v).toBe("#SPILL!");
    expect(part(await save(doc), "xl/worksheets/sheet1.xml")).toContain('<c r="A1" t="e" cm="1"><f t="array" ref="A1">_xlfn.SEQUENCE(3)</f><v>#SPILL!</v></c>');
  });

  it("a legacy (Ctrl+Shift+Enter) array formula keeps its range and is recalculated element by element", async () => {
    const data = `<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f t="array" ref="B1:B3">A1:A3*10</f><v>10</v></c></row><row r="2"><c r="A2"><v>2</v></c><c r="B2"><v>20</v></c></row><row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>30</v></c></row>`;
    const bytes = xlsx(data);
    const doc = await open(bytes);
    const sheets = sheetsOf(doc);
    expect(sheets[0].cells.B1).toMatchObject({ spill: "B1:B3", cse: true });
    expect(Buffer.from(await save(doc)).equals(Buffer.from(bytes))).toBe(true);
    edit(sheets, 0, "A2", { v: 5 });
    expect(col(sheets[0], "B1 B2 B3")).toEqual([10, 50, 30]);
    const x = part(await save(doc), "xl/worksheets/sheet1.xml");
    expect(x).toContain('<c r="B2"><v>50</v></c>');
    expect(x).toContain('<f t="array" ref="B1:B3">A1:A3*10</f>');
    expect(unzipSync(await save(doc))["xl/metadata.xml"]).toBeUndefined();
  });

  it("tables are read for structured references", async () => {
    const table = `<?xml version="1.0"?><table xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" id="1" name="Table1" displayName="Price" ref="A1:B3" totalsRowShown="0"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Item"/><tableColumn id="2" name="Cost"/></tableColumns></table>`;
    const data = `<row r="1"><c r="A1" t="inlineStr"><is><t>Item</t></is></c><c r="B1" t="inlineStr"><is><t>Cost</t></is></c><c r="D1"><f>SUM(Price[Cost])</f><v>0</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>a</t></is></c><c r="B2"><v>4</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>b</t></is></c><c r="B3"><v>6</v></c></row>`;
    const sh = readXlsx(xlsx(data, { table })).sheets[0];
    expect(sh.tables).toEqual([{ name: "Price", ref: "A1:B3", cols: ["Item", "Cost"] }]);
    recalcAll([sh]);
    expect(sh.cells.D1.v).toBe(10);
  });
});
