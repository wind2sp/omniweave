// Excel print layout (docs/design/FIDELITY_XLSX.md §4): the Excel-made print workbook (qa/interop/scripts/
// xlsx_print_make.ps1) paginates as Excel did — page count per sheet, the rows / columns each page starts at.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { readXlsx } from "../../src/io/sheet/read";
import { parseRange } from "../../src/io/sheet/formula";
import { printExtent, sheetPrintPages } from "../../src/io/sheet/printLayout";
import { headerFooterText } from "../../src/render/sheetPrint";

const BOOK = "qa/interop/excel-made/omni-xlsx-print.xlsx";
const TRUTH = "qa/interop/excel-made/omni-xlsx-print.truth.json";

interface TruthSheet {
  name: string;
  pages: number;
  hBreaks: { row: number; manual: boolean }[];
  vBreaks: { col: number; manual: boolean }[];
}

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

describe("XLSX print layout (Excel 16 ground truth)", () => {
  const truth = JSON.parse(readFileSync(TRUTH, "utf8")) as { sheets: TruthSheet[] };
  const { sheets } = readXlsx(new Uint8Array(readFileSync(BOOK)), "ko");

  it("reads the page setup", () => {
    const by = (n: string) => sheets.find((s) => s.name === n)!;
    expect(by("인쇄영역").print?.area).toEqual(["B3:H80"]);
    expect(by("제목반복").print?.titleRows).toEqual([0, 1]);
    expect(by("제목반복").print?.titleCols).toEqual([0, 0]);
    expect(by("너비맞춤").print?.fit).toEqual({ w: 1, h: 0 });
    expect(by("배율70").print?.scale).toBe(70);
    expect(by("가로").print?.landscape).toBe(true);
    expect(by("수동나눔").print?.rowBreaks).toEqual([20, 40]);
    expect(by("수동나눔").print?.colBreaks).toEqual([4]);
    expect(by("가운데").print).toMatchObject({ hCenter: true, vCenter: true });
    expect(by("눈금선").print).toMatchObject({ grid: true, headings: true, firstPage: 5 });
    expect(by("넓은표").print?.overThenDown).toBe(true);
    expect(by("긴표").print?.footer).toBe("&C&P / &N");
  });

  for (const t of truth.sheets) {
    it(`paginates ${t.name} as Excel (${t.pages} pages)`, () => {
      const sh = sheets.find((s) => s.name === t.name)!;
      const pages = sheetPrintPages(sh);
      // Excel's break lists also hold the print range's own edges: keep the breaks inside it
      const g = sh.print?.area?.[0] ? parseRange(sh.print.area[0])! : { r0: 0, c0: 0, ...printExtent(sh) };
      const xlRows = t.hBreaks.map((b) => b.row).filter((r) => r - 1 > g.r0 && r - 1 <= g.r1);
      const xlCols = t.vBreaks.map((b) => b.col).filter((c) => c - 1 > g.c0 && c - 1 <= g.c1);
      const ours = (k: "rows" | "cols") => [...new Set(pages.map((p) => p[k][0] + 1))].filter((n) => n - 1 > (k === "rows" ? g.r0 : g.c0)).sort((a, b) => a - b);
      expect({ pages: pages.length, rows: ours("rows"), cols: ours("cols") }).toEqual({ pages: t.pages, rows: xlRows, cols: xlCols });
    });
  }

  it("orders pages down then over, or over then down", () => {
    const wide = sheetPrintPages(sheets.find((s) => s.name === "넓은표")!);
    expect(wide.map((p) => p.cols[0])).toEqual([...wide.map((p) => p.cols[0])].sort((a, b) => a - b)); // one row band: across
    const titles = sheetPrintPages(sheets.find((s) => s.name === "제목반복")!);
    expect(titles[1].cols[0]).toBe(titles[0].cols[0]); // down first
    expect(titles[1].titleRows).toEqual([0, 1]);
    expect(titles[4].titleCols).toEqual([0, 0]);
    expect(titles[0].titleRows).toBeUndefined();
  });

  it("prints the fidelity workbook on as many pages as Excel's PDFs", () => {
    const fid = readXlsx(new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-fidelity.xlsx")), "ko").sheets;
    const pdfPages = (n: number) => (readFileSync(`qa/interop/excel-made/omni-xlsx-fidelity.${n}.pdf`).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    expect(fid.map((s) => sheetPrintPages(s).length)).toEqual(fid.map((_, i) => pdfPages(i + 1)));
  });

  it("fills header / footer codes", () => {
    const t = headerFooterText('&L&"Arial,Bold"&14&A&C&P / &N&R&&&P+1', { number: 3, total: 9 }, "판매");
    expect(t).toMatchObject({ L: "판매", C: "3 / 9", R: "&4", size: 14 });
  });

  it("lays out Letter / landscape paper and manual breaks from the model", () => {
    const sh = { ...sheets.find((s) => s.name === "수동나눔")!, print: { paper: 1, landscape: true, rowBreaks: [10], colBreaks: [] } };
    const pages = sheetPrintPages(sh);
    expect(Math.round(pages[0].width)).toBe(1056);
    expect(Math.round(pages[0].height)).toBe(816);
    expect(pages[0].rows).toEqual([0, 9]);
    expect(pages[1].rows[0]).toBe(10);
  });

  it("numbers pages from the first page number", () => {
    const pages = sheetPrintPages(sheets.find((s) => s.name === "눈금선")!);
    expect(pages.map((p) => p.number)).toEqual([5, 6]);
    expect(pages[0].total).toBe(2);
  });
});
