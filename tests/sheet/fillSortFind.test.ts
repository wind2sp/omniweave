// Fill series, sort, AutoFilter and find / replace (io/sheet/fill.ts, io/sheet/sortFilter.ts) — Excel's rules.
import { describe, expect, it } from "vitest";
import type { SheetData } from "../../src/core/sheetTypes";
import { fillEdits } from "../../src/io/sheet/fill";
import { parseRange } from "../../src/io/sheet/formula";
import { currentRegion, filterHiddenRows, filterValues, findAll, findNext, guessHeader, replaceText, sortEdits } from "../../src/io/sheet/sortFilter";

function sheet(cells: SheetData["cells"], styles: SheetData["styles"] = [{}]): SheetData {
  return { book: "b", name: "S", cells, styles, colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "Calibri", baseSize: 11, mdw: 7 };
}
const R = (s: string) => parseRange(s)!;
const vals = (e: ReturnType<typeof fillEdits>) => e.map((x) => x.cell?.f ?? x.cell?.v);

describe("fill", () => {
  it("one number copies; Ctrl makes a series", () => {
    const sh = sheet({ A1: { v: 5 } });
    expect(vals(fillEdits(sh, R("A1"), R("A1:A4")))).toEqual([5, 5, 5]);
    expect(vals(fillEdits(sh, R("A1"), R("A1:A4"), "auto", true))).toEqual([6, 7, 8]);
  });
  it("two numbers continue their step (also up / left); Ctrl copies", () => {
    const sh = sheet({ A3: { v: 1 }, A4: { v: 3 } });
    expect(vals(fillEdits(sh, R("A3:A4"), R("A3:A7")))).toEqual([5, 7, 9]);
    expect(vals(fillEdits(sh, R("A3:A4"), R("A1:A4")))).toEqual([-3, -1]);
    expect(vals(fillEdits(sh, R("A3:A4"), R("A3:A6"), "auto", true))).toEqual([1, 3]);
    const h = sheet({ A1: { v: 0.1 }, B1: { v: 0.2 } });
    expect(vals(fillEdits(h, R("A1:B1"), R("A1:D1")))).toEqual([0.3, 0.4]);
  });
  it("dates step by day, months by month", () => {
    const sh = sheet({ A1: { v: 45292, s: 1 }, B1: { v: 45322, s: 1 }, B2: { v: 45351, s: 1 } }, [{}, { fmt: "yyyy-mm-dd" }]);
    expect(vals(fillEdits(sh, R("A1"), R("A1:A3")))).toEqual([45293, 45294]);
    expect(fillEdits(sh, R("A1"), R("A1:A2"))[0].cell!.s).toBe(1);
    // 2024-01-31, 2024-02-29: not the same day — a linear step
    const m = sheet({ A1: { v: 45292, s: 1 }, A2: { v: 45323, s: 1 } }, [{}, { fmt: "yyyy-mm-dd" }]); // 2024-01-01, 2024-02-01
    expect(vals(fillEdits(m, R("A1:A2"), R("A1:A4")))).toEqual([45352, 45383]); // 2024-03-01, 2024-04-01
  });
  it("weekday and month names in the four languages, keeping case", () => {
    expect(vals(fillEdits(sheet({ A1: { v: "Mon" } }), R("A1"), R("A1:A3")))).toEqual(["Tue", "Wed"]);
    expect(vals(fillEdits(sheet({ A1: { v: "SATURDAY" } }), R("A1"), R("A1:A3")))).toEqual(["SUNDAY", "MONDAY"]);
    expect(vals(fillEdits(sheet({ A1: { v: "11월" } }), R("A1"), R("A1:A3")))).toEqual(["12월", "1월"]);
    expect(vals(fillEdits(sheet({ A1: { v: "월요일" }, A2: { v: "수요일" } }), R("A1:A2"), R("A1:A4")))).toEqual(["금요일", "일요일"]);
    expect(vals(fillEdits(sheet({ A1: { v: "木曜日" } }), R("A1"), R("A1:A2")))).toEqual(["金曜日"]);
    expect(vals(fillEdits(sheet({ A1: { v: "星期六" } }), R("A1"), R("A1:A2")))).toEqual(["星期日"]);
  });
  it("text with a number counts on (padding kept); Ctrl copies", () => {
    expect(vals(fillEdits(sheet({ A1: { v: "Item1" } }), R("A1"), R("A1:A3")))).toEqual(["Item2", "Item3"]);
    expect(vals(fillEdits(sheet({ A1: { v: "No.009" } }), R("A1"), R("A1:A3")))).toEqual(["No.010", "No.011"]);
    expect(vals(fillEdits(sheet({ A1: { v: "1번" } }), R("A1"), R("A1:A2")))).toEqual(["2번"]);
    expect(vals(fillEdits(sheet({ A1: { v: "Item1" } }), R("A1"), R("A1:A3"), "auto", true))).toEqual(["Item1", "Item1"]);
    expect(vals(fillEdits(sheet({ A1: { v: "plain" } }), R("A1"), R("A1:A2")))).toEqual(["plain"]);
  });
  it("formulas move their relative references; Ctrl+D copies", () => {
    const sh = sheet({ B1: { f: "A1*$C$1" }, A1: { v: 1 }, A2: { v: 2 } });
    expect(vals(fillEdits(sh, R("B1"), R("B1:B3")))).toEqual(["A2*$C$1", "A3*$C$1"]);
    expect(vals(fillEdits(sh, R("A1:B1"), R("A1:B2"), "copy"))).toEqual([1, "A2*$C$1"]);
    expect(vals(fillEdits(sh, R("B1"), R("B1:D1")))).toEqual(["B1*$C$1", "C1*$C$1"]);
  });
});

describe("sort", () => {
  const data = () =>
    sheet({
      A1: { v: "Name" }, B1: { v: "Score" },
      A2: { v: "pear" }, B2: { v: 3 },
      A3: { v: "Apple" }, B3: { v: 10 },
      A4: { v: "banana" }, B4: { v: 3 },
      A5: { v: 7 },
      A6: {}, B6: { v: 1 },
      C2: { f: "B2*2" },
    });
  it("finds the current region and its header row", () => {
    const sh = data();
    expect(currentRegion(sh, 2, 1)).toEqual(R("A1:C6"));
    expect(guessHeader(sh, R("A1:C6"))).toBe(true);
    expect(guessHeader(sheet({ A1: { v: 1 }, A2: { v: 2 } }), R("A1:A2"))).toBe(false);
  });
  it("ascending: numbers, then text without case; blanks last; formulas move", () => {
    const sh = data();
    const e = sortEdits(sh, R("A1:C6"), [{ col: 0 }], true)!;
    for (const x of e) {
      if (x.cell) sh.cells[x.a] = x.cell;
      else delete sh.cells[x.a];
    }
    expect([2, 3, 4, 5, 6].map((r) => sh.cells[`A${r}`]?.v)).toEqual([7, "Apple", "banana", "pear", undefined]);
    expect(sh.cells.C5.f).toBe("B5*2");
  });
  it("descending by score then name; blanks still last", () => {
    const sh = data();
    for (const x of sortEdits(sh, R("A1:B6"), [{ col: 1, desc: true }, { col: 0 }], true)!) {
      if (x.cell) sh.cells[x.a] = x.cell;
      else delete sh.cells[x.a];
    }
    expect([2, 3, 4, 5, 6].map((r) => sh.cells[`A${r}`]?.v)).toEqual(["Apple", "banana", "pear", undefined, 7]);
  });
  it("refuses merged cells", () => {
    const sh = data();
    sh.merges = ["A3:B3"];
    expect(sortEdits(sh, R("A1:B6"), [{ col: 0 }], true)).toBeNull();
  });
});

describe("AutoFilter", () => {
  it("lists the values of a column and hides the rows that do not match", () => {
    const sh = sheet({ A1: { v: "Fruit" }, A2: { v: "Pear" }, A3: { v: "apple" }, A4: { v: "Pear" }, A6: { v: 2 } });
    const f = { ref: "A1:A6", cols: { 0: { vals: ["Pear"] } } };
    expect(filterValues(sh, f, 0, "en")).toEqual({ values: ["2", "apple", "Pear"], blank: true });
    expect(filterHiddenRows(sh, f, "en")).toEqual([2, 4, 5]);
    expect(filterHiddenRows(sh, { ref: "A1:A6", cols: { 0: { vals: ["Pear"], blank: true } } }, "en")).toEqual([2, 5]);
  });
});

describe("find and replace", () => {
  const sh = sheet({ A1: { v: "Apple pie" }, B1: { v: 12.5, s: 1 }, A2: { f: "SUM(B1:B3)", v: 12.5 }, C3: { v: "apple" } }, [{}, { fmt: "0.00%" }]);
  it("finds by rows, without case, with wildcards", () => {
    expect(findAll(sh, "apple", {}, "en")).toEqual(["A1", "C3"]);
    expect(findAll(sh, "apple", { matchCase: true }, "en")).toEqual(["C3"]);
    expect(findAll(sh, "apple", { whole: true }, "en")).toEqual(["C3"]);
    expect(findAll(sh, "a??le", { whole: true }, "en")).toEqual(["C3"]);
    expect(findAll(sh, "a*e", { whole: true }, "en")).toEqual(["A1", "C3"]);
    expect(findAll(sh, "e?p", {}, "en")).toEqual(["A1"]);
    expect(findAll(sh, "apple", { byCols: true }, "en")).toEqual(["A1", "C3"]);
  });
  it("looks in formulas or in shown values", () => {
    expect(findAll(sh, "SUM", {}, "en")).toEqual(["A2"]);
    expect(findAll(sh, "SUM", { lookIn: "values" }, "en")).toEqual([]);
    expect(findAll(sh, "1250", { lookIn: "values" }, "en")).toEqual(["B1"]);
    expect(findNext(sh, "apple", {}, "en", { r: 0, c: 0 })).toBe("C3");
    expect(findNext(sh, "apple", {}, "en", { r: 2, c: 2 })).toBe("A1");
  });
  it("replaces every match, or the whole cell", () => {
    expect(replaceText("Apple apple", "apple", "pear", {})).toBe("pear pear");
    expect(replaceText("Apple apple", "apple", "pear", { matchCase: true })).toBe("Apple pear");
    expect(replaceText("x$1", "$1", "$2", {})).toBe("x$2");
    expect(replaceText("apple", "a*", "z", { whole: true })).toBe("z");
  });
});
