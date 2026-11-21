// XLS opened with its formatting (io/sheet/readXls.ts, 표 계산부 2026-11-21): the same sheet model an .xlsx opens as —
// checked against Excel itself. Files (qa/interop/scripts/xls_rich_make.ps1, hidden Excel):
//   adobe-made/xls-fidelity/omni-xls-rich.xls   every kind of cell format, formulas, sizes, panes, notes, page setup
//   excel-made/omni-xls-print.xls · omni-xls-fidelity.xls   Excel's own .xls of omni-xlsx-print / omni-xlsx-fidelity.xlsx:
//                                                the XLS reader must give what the XLSX reader gives for the .xlsx
//   adobe-made/excel_book.xls (with excel_book.xlsx, the same book)
// and what an XLS opened so may be saved as: unedited byte for byte, cell values written into it, anything else refused.

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import type { SheetData, SheetStyle } from "../../src/core/sheetTypes";
import type { OmwDocument } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { lastLegacySave, legacyUnchanged, xlsValuesOnly } from "../../src/io/formats/legacyWrite";
import { workbookOf } from "../../src/io/formats/xlsWrite";
import { INDEXED, readXlsx } from "../../src/io/sheet/read";
import { decodeFormula, readXls } from "../../src/io/sheet/readXls";
import { sheetPrintPages } from "../../src/io/sheet/printLayout";

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

const RICH = "qa/interop/adobe-made/xls-fidelity/omni-xls-rich.xls";
const bytes = (f: string) => new Uint8Array(readFileSync(f));
const styleOf = (sh: SheetData, a: string): SheetStyle => sh.styles[sh.cells[a]?.s ?? 0];

describe("omni-xls-rich.xls (Excel 16, hidden instance)", () => {
  const { sheets, notices } = readXls(bytes(RICH), "ko");
  const [f, p, h] = sheets;

  it("sheets, names, the hidden one", () => {
    expect(sheets.map((s) => s.name)).toEqual(["서식 Format", "인쇄 Print", "Hidden"]);
    expect(h.hidden).toBe(true);
    expect(f.hidden).toBeUndefined();
    expect(new Set(sheets.map((s) => s.book)).size).toBe(1);
    expect(f.baseFont).toBe("맑은 고딕");
    expect(f.baseSize).toBe(11);
  });

  it("fonts: bold, italic, colour, double underline, strike, name and size, theme colour with its shade", () => {
    expect(styleOf(f, "A1")).toMatchObject({ font: "Arial", size: 16, bold: true, h: "center" });
    expect(styleOf(f, "A3")).toMatchObject({ italic: true, color: "#FF0000" });
    expect(styleOf(f, "B3").underline).toBe("double");
    expect(styleOf(f, "C3").strike).toBe(true);
    expect(styleOf(f, "D3")).toMatchObject({ size: 14, bold: true });
    expect(styleOf(f, "D3").font).toBeUndefined(); // the Normal style's font
    expect(styleOf(f, "E3").color).toBe("#C55A11"); // accent 2, 25 % darker (XFEXT)
    expect(styleOf(f, "F3")).toMatchObject({ font: "Arial", size: 9 });
  });

  it("fills: a theme colour with a tint, RGB, a pattern mixed with its background", () => {
    expect(styleOf(f, "A1").fill).toBe("#B4C7E7"); // accent 1, 60 % lighter
    expect(styleOf(f, "A2").fill).toBe("#FFE699");
    expect(styleOf(f, "E8").fill).toBe("#CCFFCC");
    const pat = styleOf(f, "D8").fill!;
    expect(pat).not.toBe("#000000"); // not the hatch colour over the whole cell
    expect(parseInt(pat.slice(1, 3), 16)).toBeGreaterThan(150);
    expect(notices.find((n) => n.kind === "pattern")?.n).toBe(1);
  });

  it("borders: thin, double, medium, dashed / dotted inside, thick", () => {
    expect(styleOf(f, "A2")).toMatchObject({ bl: { style: "thin" }, bt: { style: "thin" }, bb: { style: "double" } });
    expect(styleOf(f, "A8")).toMatchObject({ bl: { style: "medium" }, bt: { style: "medium" }, br: { style: "dashed" }, bb: { style: "dotted" } });
    expect(styleOf(f, "C9").br?.style).toBe("medium");
    expect(styleOf(f, "A10").bb?.style).toBe("thick");
  });

  it("alignment: wrap, rotation 45 / -30 / stacked, indent, shrink, vertical", () => {
    expect(styleOf(f, "A5").wrap).toBe(true);
    expect(styleOf(f, "B5").rot).toBe(45);
    expect(styleOf(f, "C5").rot).toBe(120); // -30° as SpreadsheetML stores it (90 + 30)
    expect(styleOf(f, "D5").rot).toBe(255);
    expect(styleOf(f, "E5")).toMatchObject({ h: "left", indent: 2 });
    expect(styleOf(f, "F5").shrink).toBe(true);
    expect(styleOf(f, "A6").v).toBe("top");
    expect(styleOf(f, "C6").h).toBe("right");
  });

  it("number formats and values", () => {
    expect(styleOf(f, "A4").fmt).toBe("#,##0.00");
    expect(styleOf(f, "B4").fmt).toBe("0.0%");
    expect(styleOf(f, "C4").fmt).toBe("yyyy-mm-dd");
    expect(styleOf(f, "D4").fmt).toBe("0.00E+00");
    expect(styleOf(f, "E4").fmt).toBe("@");
    expect(f.cells.E4.v).toBe("00123");
    expect(f.cells.C4.v).toBe(46347);
  });

  it("formulas: decoded with their stored results — shared, array, Excel 2007 functions, other sheets", () => {
    const fm = (a: string) => f.cells[a]?.f;
    expect(fm("A11")).toBe("SUM(A4,F4)");
    expect(fm("C11")).toBe('IF(A4>1000,"큼","작음")');
    expect(fm("E11")).toBe("VLOOKUP(2,A13:B15,2,FALSE)");
    expect(fm("A12")).toBe('IFERROR(1/0,"오류")');
    expect(f.cells.A12.v).toBe("오류");
    expect(fm("C12")).toBe("'인쇄 Print'!B2*2");
    expect(fm("E12")).toBe("A4*$B$4");
    expect(fm("F12")).toBe('COUNTIF(A13:A15,">1")');
    expect(f.cells.D12).toMatchObject({ f: "SUM(A13:A15*B13:B15)", cse: true, v: 140 });
    expect([fm("C13"), fm("C14"), fm("C15")]).toEqual(["A13*B13", "A14*B14", "A15*B15"]);
    expect(notices.some((n) => n.kind === "formulaValues")).toBe(false);
  });

  it("sizes, hidden rows / columns, merges, frozen panes, the tab colour, notes", () => {
    expect(f.colW[0]).toBe(150);
    expect(f.hiddenCols).toEqual([6]);
    expect(f.hiddenRows).toEqual([15]);
    expect(f.rowH[4]).toBe(64);
    expect(f.rowAuto?.[4]).toBeUndefined(); // set by hand (48 pt)
    expect(f.merges).toEqual(["A1:F1"]);
    expect(f.freeze).toEqual({ rows: 2, cols: 1 });
    expect(p.tabColor).toBe("#FFA000");
    expect(f.notes?.A3).toEqual({ text: "메모 note 시험", author: "Omniweave QA" });
    expect(notices.find((n) => n.kind === "hyperlinks")?.n).toBe(1);
  });

  it("page setup: paper, margins, centring, gridlines, header / footer, print area and titles, fit, scale", () => {
    expect(f.print).toMatchObject({ paper: 9, hCenter: true, grid: true, header: "&C&A", footer: "&R&P쪽", area: ["A1:F17"], titleRows: [0, 1], fit: { w: 1, h: 1 } });
    expect(f.print?.margins).toEqual({ l: 0.5, r: 0.5, t: 0.8, b: 0.8, header: 0.3, footer: 0.3 });
    expect(f.print?.landscape).toBeUndefined();
    expect(p.print).toMatchObject({ paper: 9, scale: 90, firstPage: 1, header: "&C머리글 Header", footer: "&C&P" });
  });
});

describe("an .xls gives what the .xlsx reader gives for the same workbook (Excel saved both)", () => {
  // (the number format Excel 16 escapes in an .xlsx — [Red]\-#,##0 — it stores unescaped in an .xls: the same format)
  const fmt = (s: SheetStyle | undefined) => JSON.stringify(Object.fromEntries(Object.entries(s ?? {}).map(([k, v]) => [k, k === "fmt" ? String(v).replace(/\\-/g, "-") : v]).sort()));
  const same = (xlsx: string, xls: string) => {
    const a = readXlsx(bytes(xlsx), "ko").sheets, b = readXls(bytes(xls), "ko").sheets;
    expect(b.map((s) => s.name)).toEqual(a.map((s) => s.name));
    a.forEach((x, i) => {
      const y = b[i];
      for (const k of ["colW", "hiddenRows", "hiddenCols", "merges", "freeze", "print", "hidden", "names", "notes", "defColW"] as const) expect(y[k], `${x.name} ${k}`).toEqual(x[k]);
      for (const ad of new Set([...Object.keys(x.cells), ...Object.keys(y.cells)])) {
        const cx = x.cells[ad], cy = y.cells[ad];
        expect(cy?.f, `${x.name}!${ad} f`).toBe(cx?.f);
        if (typeof cx?.v === "number") expect(cy?.v as number, `${x.name}!${ad}`).toBeCloseTo(cx.v, 9);
        else expect(cy?.v, `${x.name}!${ad}`).toBe(cx?.v);
        expect(fmt(y.styles[cy?.s ?? 0]), `${x.name}!${ad} style`).toBe(fmt(x.styles[cx?.s ?? 0]));
      }
    });
    return { a, b };
  };

  it("omni-xls-print.xls: page setups, and the pages print as Excel printed them", () => {
    const { b } = same("qa/interop/excel-made/omni-xlsx-print.xlsx", "qa/interop/excel-made/omni-xls-print.xls");
    const truth = JSON.parse(readFileSync("qa/interop/excel-made/omni-xlsx-print.truth.json", "utf8")) as { sheets: { name: string; pages: number }[] };
    for (const t of truth.sheets) expect(sheetPrintPages(b.find((s) => s.name === t.name)!).length, t.name).toBe(t.pages);
  });

  it("omni-xls-fidelity.xls: values, formulas, formats (its conditional formats: a notice)", () => {
    same("qa/interop/excel-made/omni-xlsx-fidelity.xlsx", "qa/interop/excel-made/omni-xls-fidelity.xls");
    expect(readXls(bytes("qa/interop/excel-made/omni-xls-fidelity.xls"), "ko").notices).toEqual([{ kind: "cond", n: 3 }]);
  });

  it("excel_book.xls and excel_book.xlsx", () => {
    same("qa/interop/adobe-made/excel_book.xlsx", "qa/interop/adobe-made/excel_book.xls");
    expect(readXls(bytes("qa/interop/adobe-made/excel_book.xls"), "ko").notices).toEqual([]);
  });
});

describe("notices: only what the file has", () => {
  it("a chart and a conditional format; a data table's cells", () => {
    expect(readXls(bytes("qa/interop/excel-made/omni-legacy-xls-chart.xls")).notices).toEqual([
      { kind: "charts", n: 1 },
      { kind: "cond", n: 1 },
    ]);
    const edge = readXls(bytes("qa/interop/excel-made/omni-legacy-xls-edge.xls")).notices;
    expect(edge.find((n) => n.kind === "formulaValues")?.n).toBe(5); // F21:F25 of the data table
  });
  it("Excel's font runs for Hangul in an Arial cell are no rich-text notice", () => {
    expect(readXls(bytes(RICH)).notices.map((n) => n.kind)).not.toContain("richText");
  });
});

describe("the formula tokens", () => {
  const ctx = { sheets: ["Sheet1", "두 번째"], xti: [{ sup: 0, first: 1, last: 1 }, { sup: 1, first: 0, last: 0 }], supbooks: [{ self: true, addin: false, names: [] }, { self: false, addin: false, names: [] }], names: [] };
  const dec = (hex: string, r = 0, c = 0, rel = false) => {
    const b = Uint8Array.from(Buffer.from(hex.replace(/\s/g, ""), "hex"));
    return decodeFormula(b, 0, b.length, b.length, r, c, ctx, rel);
  };
  it("references, operators, strings, numbers, other sheets", () => {
    // A1 + $B$2 * 2.5
    expect(dec("24 0000 00c0  24 0100 0100  1f 0000000000000440  05 03")).toBe("A1+$B$2*2.5");
    // "a""b" & '두 번째'!C3:D4 (PtgArea3d)
    expect(dec("17 03 00 61 22 62  3b 0000 0200 0300 02c0 03c0  08")).toBe("\"a\"\"b\"&'두 번째'!C3:D4");
  });
  it("a shared formula's relative references move with the cell; whole rows and columns", () => {
    // PtgRefN row −1, column +1 from C5 → D4
    expect(dec("2c ffff 01c0", 4, 2)).toBe("D4");
    // PtgArea $A:$B and 2:3
    expect(dec("25 0000 ffff 0000 0100")).toBe("$A:$B");
    expect(dec("25 0100 0200 0000 ff00")).toBe("$2:$3");
  });
  it("functions: fixed (ROUND), variable (SUM by PtgAttr and PtgFuncVar), an array constant", () => {
    expect(dec("24 0000 00c0 1e 0200 21 1b00")).toBe("ROUND(A1,2)");
    expect(dec("24 0000 00c0 19 10 0000")).toBe("SUM(A1)");
    expect(dec("1e 0100 1e 0200 22 02 0400")).toBe("SUM(1,2)");
    // {1,"x"} — PtgArray, its values after the tokens (rgcb): 2 columns, 1 row
    const b = Uint8Array.from(Buffer.from("4000000000000000" + "010000" + "01000000000000f03f" + "0201000078", "hex"));
    expect(decodeFormula(b, 0, 8, b.length, 0, 0, ctx)).toBe('{1,"x"}');
  });
  it("another workbook, an unknown token: not decoded (the stored result is shown)", () => {
    expect(dec("3a 0100 0000 00c0")).toBeNull();
    expect(dec("18 01")).toBeNull();
  });
});

it("the default palette (indexed colours 43–63 were shifted)", () => {
  expect(INDEXED[43]).toBe("FFFF99");
  expect(INDEXED[52]).toBe("FF9900");
  expect(INDEXED[63]).toBe("333333");
});

// ───── what an XLS opened with its formatting can be saved as ─────

async function open(file: string | Uint8Array) {
  const b = typeof file === "string" ? bytes(file) : file;
  const r = await formatForExt("xls")!.open({ name: "omw-legacy.xls", path: null, bytes: b }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
  return { bytes: b, doc, r };
}
const save = (doc: OmwDocument) => exportById("xls")!.run(doc, doc.pages[0], { confirm: () => true } as any) as Promise<Uint8Array>;
const sheetsOf = (d: OmwDocument) => d.pages.filter((p) => p.sheet).map((p) => p.sheet!);
const recs = (wb: Uint8Array) => {
  const out: { type: number; data: Buffer }[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = wb[o] | (wb[o + 1] << 8), len = wb[o + 2] | (wb[o + 3] << 8);
    out.push({ type, data: Buffer.from(wb.subarray(o + 4, o + 4 + len)) });
    o += 4 + len;
  }
  return out;
};
const cellRec = (wb: Uint8Array, r: number, c: number) => recs(wb).find((x) => [0x0006, 0x0201, 0x027e, 0x0205, 0x0203, 0x00fd].includes(x.type) && x.data.readUInt16LE(0) === r && x.data.readUInt16LE(2) === c);

describe("saving an XLS opened with its formatting", () => {
  it("opens with the notices as warnings, no 'cell values only'", async () => {
    const { r } = await open(RICH);
    expect((r as any).warnings.length).toBe(2);
    expect((r as any).message).not.toMatch(/셀 값만|Only cell values/);
  });

  it("unedited: the original bytes", async () => {
    const { bytes: b, doc } = await open(RICH);
    expect(legacyUnchanged(doc.pages, "xls")).toBe(true);
    expect(Buffer.from(await save(doc)).equals(Buffer.from(b))).toBe(true);
    expect(lastLegacySave.xls).toBe("original");
  });

  it("formatting edits are refused (save as XLSX): bold, a fill, a merge, frozen panes, the page setup, a row height", async () => {
    const edits: ((s: SheetData) => void)[] = [
      (s) => (s.styles[s.cells.A4.s!] = { ...s.styles[s.cells.A4.s!], bold: true }),
      (s) => (s.styles[s.cells.A4.s!] = { ...s.styles[s.cells.A4.s!], fill: "#FF0000" }),
      (s) => s.merges.push("A13:B13"),
      (s) => (s.freeze = { rows: 3, cols: 0 }),
      (s) => (s.print = { ...s.print, landscape: true }),
      (s) => (s.rowH[2] = 40),
    ];
    for (const e of edits) {
      const { doc } = await open(RICH);
      e(sheetsOf(doc)[0]);
      expect(xlsValuesOnly(doc.pages)).toBe(false);
      await expect(save(doc)).rejects.toThrow(/XLSX|xlsx/);
    }
  });

  it("a formula typed in or changed is refused", async () => {
    for (const [a, f] of [["A13", "1+1"], ["E12", "A4*$B$4+1"]]) {
      const { doc } = await open(RICH);
      const s = sheetsOf(doc)[0];
      s.cells[a] = { ...s.cells[a], f };
      expect(xlsValuesOnly(doc.pages), a).toBe(false);
      await expect(save(doc)).rejects.toThrow();
    }
  });

  it("a value typed: written; formulas the engine recalculated stay formulas; a value over a formula replaces it", async () => {
    const { doc } = await open(RICH);
    const s = sheetsOf(doc)[0];
    s.cells.A13 = { v: 5 }; // C13 = A13*B13 recalculated by the engine
    s.cells.C13 = { ...s.cells.C13, v: 50 };
    s.cells.B12 = { v: 140 }; // =SUMPRODUCT(…) replaced by its own result
    s.cells.E4 = { s: s.cells.E4.s, v: "#N/A", t: "e" }; // an error typed into a text cell
    expect(xlsValuesOnly(doc.pages)).toBe(true);
    const out = await save(doc);
    expect(lastLegacySave.xls).toBe("cells");
    const wb = workbookOf(out);
    expect(cellRec(wb, 12, 2)!.type).toBe(0x0006); // C13 still a FORMULA
    expect(cellRec(wb, 11, 1)!.type).not.toBe(0x0006); // B12 a value now
    const e4 = cellRec(wb, 3, 4)!;
    expect([e4.type, e4.data[6], e4.data[7]]).toEqual([0x0205, 0x2a, 1]); // BOOLERR #N/A
    const back = sheetsOf((await open(out)).doc)[0];
    expect(back.cells.A13.v).toBe(5);
    expect(back.cells.C13.f).toBe("A13*B13");
    // the engine's result as its cached value (QA 2026-11-21: not the old 10 - a reader that does not calculate would show
    // a result of the old values; Excel recalculates on load either way)
    expect(back.cells.C13.v).toBe(50);
    expect(back.cells.B12.f).toBeUndefined();
    expect(back.cells.E4).toMatchObject({ v: "#N/A", t: "e" });
    const was = sheetsOf((await open(RICH)).doc)[0];
    expect(back.styles[back.cells.A4.s!]).toEqual(was.styles[was.cells.A4.s!]); // the formatting stays
  });
});
