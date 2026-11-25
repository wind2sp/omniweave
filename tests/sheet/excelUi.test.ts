// The sheet ribbon's Excel commands without the screen: text to columns, flash fill's learner, F4 on references,
// pivot grids, a file chart's title / legend / labels patched in its own XML.
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import type { SheetData } from "../../src/core/sheetTypes";
import { flashLearn, flashRun, patchChartXml, pivotGrid, splitText } from "../../src/ui/sheet/sheetFeatures";
import { cycleRef, refAt } from "../../src/ui/sheet/SheetView";
import { chartXml } from "../../src/io/sheet/writeDrawings";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const sheet = (rows: (string | number)[][]): SheetData => {
  const cells: SheetData["cells"] = {};
  rows.forEach((r, i) => r.forEach((v, j) => (cells[String.fromCharCode(65 + j) + (i + 1)] = { v })));
  return { book: "b", name: "Sales", cells, styles: [{}], colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "Calibri", baseSize: 11, mdw: 7 };
};

describe("sheet Excel commands", () => {
  it("text to columns: delimiters, quotes, consecutive, fixed width", () => {
    expect(splitText("A-101-SEOUL", { delims: ["-"], merge: false, quote: '"' })).toEqual(["A", "101", "SEOUL"]);
    expect(splitText('a,"b,c",d', { delims: [","], merge: false, quote: '"' })).toEqual(["a", "b,c", "d"]);
    expect(splitText("a  b", { delims: [" "], merge: true, quote: "" })).toEqual(["a", "b"]);
    expect(splitText("ABCD1234", { delims: [], merge: false, quote: "", fixed: [4] })).toEqual(["ABCD", "1234"]);
  });

  it("flash fill learns words, initials, case and separators", () => {
    const p = flashLearn([{ src: ["Kim Minsu"], out: "Minsu" }])!;
    expect(flashRun(p, ["Lee Jiyoung"])).toBe("Jiyoung");
    const q = flashLearn([{ src: ["kim", "minsu"], out: "MINSU, Kim" }])!;
    expect(flashRun(q, ["lee", "jiyoung"])).toBe("JIYOUNG, Lee");
    const r = flashLearn([{ src: ["Park Junho"], out: "P.J." }])!;
    expect(flashRun(r, ["Choi Yuna"])).toBe("C.Y.");
  });

  it("F4 cycles the reference at the caret", () => {
    expect(cycleRef("A1")).toBe("$A$1");
    expect(cycleRef("$A$1")).toBe("A$1");
    expect(cycleRef("A$1")).toBe("$A1");
    expect(cycleRef("$A1")).toBe("A1");
    expect(cycleRef("B2:C9")).toBe("$B$2:$C$9");
    const f = "=SUM(B2:C9)+Sheet2!D4";
    expect(refAt(f, 7)).toEqual({ start: 5, end: 10 });
    expect(refAt(f, f.length)).toEqual({ start: 19, end: 21 });
  });

  it("pivot grid: rows × columns with totals", () => {
    const sh = sheet([["Region", "Product", "Qty"], ["East", "Apple", 2], ["West", "Pear", 3], ["East", "Pear", 5], ["East", "Apple", 1]]);
    const g = pivotGrid(sh, { sheet: "Sales", ref: "A1:C5", at: "A3", rows: ["Region"], cols: ["Product"], vals: [{ field: "Qty", fn: "sum" }] })!;
    // header, column labels, East, West, grand total
    expect(g[2]).toEqual(["East", 3, 5, 8]);
    expect(g[3]).toEqual(["West", null, 3, 3]);
    expect(g[4].slice(1)).toEqual([3, 8, 11]);
    const avg = pivotGrid(sh, { sheet: "Sales", ref: "A1:C5", at: "A3", rows: ["Product"], cols: [], vals: [{ field: "Qty", fn: "average" }, { field: "Qty", fn: "count" }] })!;
    expect(avg[1]).toEqual(["Apple", 1.5, 2]);
  });

  it("a file chart's title, legend and labels are patched in its XML", () => {
    const sh = sheet([["P", "Q"], ["a", 1], ["b", 2]]);
    const xml = chartXml(sh, { type: "col", ref: "A1:B3", legend: "none" });
    const p = patchChartXml(xml, { title: "New title", legend: "r", labels: true });
    expect(p).toContain("<a:t>New title</a:t>");
    expect(p).toContain('<c:legendPos val="r"/>');
    expect(p).toMatch(/<c:dLbls>.*<c:showVal val="1"\/>/);
    expect(patchChartXml(p, { title: "", legend: "none", labels: false })).not.toMatch(/<c:legend>|<c:dLbls>|New title/);
  });
});
