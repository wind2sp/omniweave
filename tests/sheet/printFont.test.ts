// Printed geometry from the default font's metrics (io/sheet/printFont.ts) against Excel 16's own prints of 13 fonts × 8
// sizes (qa/interop/excel-made/omni-xlsx-print-fonts.truth.json, made by qa/interop/scripts/xlsx_print_fonts_make.ps1
// and read by scripts/xlsx-print-fonts.mjs; dots at 600 dpi, Excel's screen at 120 dpi).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { digitWidth } from "../../src/io/sheet/read";
import { printFactors } from "../../src/io/sheet/printLayout";
import { printDigitDots, printLineBox, printRowOf, screenRowPx } from "../../src/io/sheet/printFont";

interface Book {
  font: string;
  size: number;
  printSize: number;
  col: number[];
  row: number[];
  base: Record<string, number>;
  excel: { standardWidth: number; standardHeight: number; rowHeightPt: number[] };
}
const truth: { books: Book[] } = JSON.parse(readFileSync("qa/interop/excel-made/omni-xlsx-print-fonts.truth.json", "utf8"));
const NAME: Record<string, string> = { calibri: "Calibri", arial: "Arial", verdana: "Verdana", tahoma: "Tahoma", times: "Times New Roman", segoeui: "Segoe UI", cambria: "Cambria", consolas: "Consolas", georgia: "Georgia", malgun: "맑은 고딕", gulim: "굴림", dotum: "돋움", batang: "바탕" }; // i18n: keep — font names

describe("printed geometry from font metrics (Excel 16, 13 fonts × 8 sizes)", () => {
  it("has the 104 prints", () => expect(truth.books.length).toBe(104));

  it("prints a column of w characters as w × the printer digit (the widest digit at the printer's ppem)", () => {
    for (const b of truth.books) {
      if (b.font === "georgia") continue; // old-style figures: Excel's digit is not the widest one
      const slope = (b.col[3] - b.col[1]) / 4; // 1 → 5 characters
      expect(Math.abs(slope - printDigitDots(NAME[b.font], b.size)!), `${b.font} ${b.size}`).toBeLessThan(0.1);
    }
  });

  it("prints the default row at ascent + descent + leading + 8 (+ the font's measured extra)", () => {
    for (const b of truth.books) expect(Math.abs(printRowOf(NAME[b.font], b.size)!.row - b.row[0]), `${b.font} ${b.size}`).toBeLessThanOrEqual(0.5);
    // the fonts Excel adds nothing for, at every size
    for (const f of ["calibri", "cambria", "consolas", "tahoma"]) expect(truth.books.filter((b) => b.font === f).every((b) => Math.abs(printRowOf(NAME[f], b.size)!.row - b.row[0]) <= 0.5)).toBe(true);
  });

  it("prints a set row × the printer row over the sheet's default row", () => {
    for (const b of truth.books) {
      const sh = { baseFont: NAME[b.font], baseSize: b.size, mdw: digitWidth(NAME[b.font], b.size), defRowH: (b.excel.standardHeight * 96) / 72 };
      const { ky } = printFactors(sh);
      // row 13: 30 pt on a 120-dpi screen (50 px), printed × (printer row ÷ the screen's default row)
      const want = Math.floor(((b.excel.rowHeightPt[1] * 600) / 72) * ky + 1e-6);
      expect(Math.abs(want - b.row[1]), `${b.font} ${b.size}`).toBeLessThanOrEqual(2);
    }
  });

  it("places text by the font's line box: top, centre and bottom", () => {
    let n = 0;
    for (const b of truth.books) {
      const lb = printLineBox(NAME[b.font], b.size);
      const h = b.row[1];
      // (baselines below the row's top gridline; the line box's fonts at whole dots, GDI hints them within 1–3 dots)
      expect(Math.abs(b.base.A3 - (lb.above + 3.5)), `top ${b.font} ${b.size}`).toBeLessThanOrEqual(3.5);
      expect(Math.abs(b.base.C13 - (h / 2 + lb.above - lb.box / 2 - 0.5)), `centre ${b.font} ${b.size}`).toBeLessThanOrEqual(3);
      if (b.base.B13 !== undefined) {
        expect(Math.abs(b.base.B13 - (h - 7 - (lb.box - lb.above))), `bottom ${b.font} ${b.size}`).toBeLessThanOrEqual(3.5);
        n++;
      }
    }
    expect(n).toBeGreaterThan(80);
  });

  it("keeps 맑은 고딕 11 and Calibri 11 as measured before, and gives the screen Excel's digit widths", () => {
    expect(printRowOf("맑은 고딕", 11)!.row).toBe(139); // i18n: keep — font name
    expect(printDigitDots("맑은 고딕", 11)).toBe(51); // i18n: keep — font name
    expect(printRowOf("Calibri", 11)!.row).toBe(121);
    expect(printDigitDots("Calibri", 11)).toBe(47);
    expect(printRowOf("Malgun Gothic", 10)!.row).toBe(124); // was 126 (the 11 pt row in proportion)
    expect(printRowOf("Verdana", 9)!.row).toBe(100); // was 94 (no metrics)
    expect(screenRowPx("맑은 고딕", 11)).toBe(22); // i18n: keep — font name
    expect(screenRowPx("Calibri", 11)).toBe(20);
    expect(screenRowPx("Arial", 10)).toBe(17);
    expect([digitWidth("Calibri", 11), digitWidth("맑은 고딕", 11), digitWidth("Arial", 10), digitWidth("Verdana", 9)]).toEqual([7, 8, 7, 8]); // i18n: keep — font name
    expect(digitWidth("Some Unknown Font", 11)).toBe(7);
    expect(printFactors({ baseFont: "Some Unknown Font", baseSize: 11, mdw: 7, defRowH: 20 })).toEqual({ kx: 1.02, ky: 1, defPx: 20 });
  });
});
