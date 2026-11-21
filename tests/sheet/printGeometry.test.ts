// Printed-page geometry (render/sheet.ts PRINT_DOT, render/sheetPrint.ts): the Excel-made print workbook painted into
// a recording context lands where Excel's own PDFs put things (qa/interop/excel-made/omni-xlsx-print.*.pdf, numbers
// read from their content streams, px at 96 dpi). Excel lays a print out in 600-dpi dots: an 8-dot line slot after
// every boundary, cells one slot in from the margin, the font at whole dots.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { readXlsx } from "../../src/io/sheet/read";
import { printRowPx, sheetPrintPages } from "../../src/io/sheet/printLayout";
import { paintSheetPage, printFontPx, PRINT_DOT } from "../../src/render/sheet";
import type { SheetData } from "../../src/core/sheetTypes";

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;

type Call = { op: "text"; s: string; x: number; y: number; font: string } | { op: "rect"; x: number; y: number; w: number; h: number; fill: string } | { op: "stroke"; lw: number };

/** A 2-D context that records text and filled rectangles in page px (translate / scale tracked). */
function recorder() {
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const calls: Call[] = [];
  const mul = (a: number[], b: number[]) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  const o: Record<string, unknown> = {
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    fillStyle: "#000000",
    lineWidth: 1,
    save: () => stack.push([...m]),
    restore: () => (m = stack.pop() ?? m),
    translate: (x: number, y: number) => (m = mul(m, [1, 0, 0, 1, x, y])),
    scale: (x: number, y: number) => (m = mul(m, [x, 0, 0, y, 0, 0])),
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => (m = [a, b, c, d, e, f]),
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    measureText: (t: string) => ({ width: t.length * 7, alphabeticBaseline: 0 }),
    fillText: (s: string, x: number, y: number) => calls.push({ op: "text", s, x: m[0] * x + m[4], y: m[3] * y + m[5], font: o.font as string }),
    fillRect: (x: number, y: number, w: number, h: number) => calls.push({ op: "rect", x: m[0] * x + m[4], y: m[3] * y + m[5], w: w * m[0], h: h * m[3], fill: o.fillStyle as string }),
    stroke: () => calls.push({ op: "stroke", lw: (o.lineWidth as number) * m[0] }),
    createLinearGradient: () => ({ addColorStop() {} }),
  };
  const ctx = new Proxy(o, { get: (t, k) => (k in t ? t[k as string] : () => {}), set: (t, k, v) => ((t[k as string] = v), true) });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function paint(sh: SheetData, page = 0) {
  const r = recorder();
  const pg = sheetPrintPages(sh)[page];
  // the paper at exactly 96 dpi (k = 1)
  paintSheetPage(r.ctx, sh, pg.width, pg.height, "ko", page);
  return r.calls;
}
const texts = (c: Call[]) => c.filter((x): x is Extract<Call, { op: "text" }> => x.op === "text");
const rects = (c: Call[]) => c.filter((x): x is Extract<Call, { op: "rect" }> => x.op === "rect");

describe("XLSX printed page geometry (Excel 16 PDFs)", () => {
  const { sheets } = readXlsx(new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-print.xlsx")), "ko");
  const by = (n: string) => sheets.find((s) => s.name === n)!;

  it("sets the font at whole printer dots", () => {
    expect(printFontPx(11, 1)).toBeCloseTo(14.72, 5); // 92 dots — Excel's PDF: 11.04 pt
    expect(printFontPx(11, 0.7)).toBeCloseTo(10.24, 5); // 64 dots — 7.68 pt
    expect(printFontPx(14, 1)).toBeCloseTo(18.72, 5); // 117 dots — 14.04 pt
    const t = texts(paint(by("긴표")));
    expect(t.find((x) => x.s === "배 1")!.font).toMatch(/^14\.72px /);
  });

  it("starts the cells one line slot in, text 13 dots further, centred baseline as Excel's", () => {
    const t = texts(paint(by("긴표")));
    // Excel: "배 1" at 52.92 pt (70.56 px), baseline 758.28 pt from the bottom (111.52 px); header row 89.28 px
    const a = t.find((x) => x.s === "배 1")!;
    expect(a.x).toBeCloseTo(70.56, 1);
    expect(Math.abs(a.y - 111.52)).toBeLessThan(0.12);
    const h = t.find((x) => x.s === "긴 열2")!;
    expect(Math.abs(h.y - 89.28)).toBeLessThan(0.12);
    // bold starts a dot further in: 108.14 pt → 144.19 px for the second column's header
    expect(Math.abs(h.x - 144.19)).toBeLessThan(0.15);
  });

  it("fills from the middle of the line slot, a row's cells as one run", () => {
    const f = rects(paint(by("긴표"))).filter((x) => x.fill === "#C5D9F2");
    expect(f).toHaveLength(1); // Excel: 50.88 770.64 275.59 16.8 re — one run for the header row
    expect(f[0].x).toBeCloseTo(67.2 + 4 * PRINT_DOT, 2);
    expect(f[0].h).toBeCloseTo(139 * PRINT_DOT + PRINT_DOT, 2);
  });

  it("centres the block with two line slots and draws thin borders as 8-dot bars", () => {
    const c = paint(by("가운데"));
    // Excel: first text at 252.19 px / 443.91 px, the left border bar 186.5 pt (248.67 px) wide 0.96 pt
    const a = texts(c).find((x) => x.s === "중 열1")!;
    expect(Math.abs(a.x - 252.19)).toBeLessThan(0.2);
    expect(Math.abs(a.y - 443.91)).toBeLessThan(0.2);
    const bars = rects(c).filter((x) => x.fill === "#000000" && Math.abs(x.w - 8 * PRINT_DOT) < 1e-6);
    expect(bars.length).toBeGreaterThan(4);
    expect(Math.abs(Math.min(...bars.map((x) => x.x)) - 248.67)).toBeLessThan(0.1);
    expect(c.some((x) => x.op === "stroke" && Math.abs(x.lw - 1) < 1e-6)).toBe(true); // the hairline over each bar
  });

  it("prints gridlines as one-dot bars mid-slot and the headings inside an 8-dot frame", () => {
    const c = rects(paint(by("눈금선")));
    // Excel: gridline 74.28 pt (99.04 px) 0.12 wide; frame 67.20 – 68.48 px; heading column line 98.40 – 99.68 px
    const grid = c.filter((x) => Math.abs(x.w - PRINT_DOT) < 1e-6);
    expect(grid.some((x) => Math.abs(x.x - 99.04) < 0.05)).toBe(true);
    const slots = c.filter((x) => Math.abs(x.w - 8 * PRINT_DOT) < 1e-6);
    expect(slots.some((x) => Math.abs(x.x - 67.2) < 0.05)).toBe(true);
    expect(slots.some((x) => Math.abs(x.x - 98.4) < 0.05)).toBe(true);
    const one = texts(paint(by("눈금선"))).find((x) => x.s === "1" && x.x < 99)!;
    expect(Math.abs(one.y - 111.2)).toBeLessThan(0.15); // row number baseline (Excel 111.20 px)
  });

  it("prints a set row height and a fitted one × the printer font's row over the screen's", () => {
    expect(by("제목반복").rowAuto?.[0]).toBe(true); // ht="20.25" without customHeight
    expect(by("가로").rowAuto?.[9]).toBeUndefined(); // ht="60" customHeight="1"
    const pg = sheetPrintPages(by("제목반복"))[0];
    expect(printRowPx(27, pg.ky, 1) * 6.25).toBeCloseTo(170, 6); // Excel: 170 dots
    expect(printRowPx(80, pg.ky, 1) * 6.25).toBeCloseTo(505, 6); // Excel: 505 dots
    expect(printRowPx(24, pg.ky, 1) * 6.25).toBeCloseTo(151, 6); // fitted 18 pt (omni-xlsx-fidelity.2.pdf)
    expect(printRowPx(22, pg.ky, 0.7) * 6.25 * 0.7).toBeCloseTo(97, 6); // default row at 70 %
  });

  it("prints the default row at the printer font's row whatever the screen row (Excel 2021's 17.4 pt)", () => {
    const old = sheets[0];
    const book = readXlsx(new Uint8Array(readFileSync("qa/interop/adobe-made/excel_book.xlsx")), "ko").sheets[0];
    expect(book.defRowH).not.toBe(old.defRowH); // 23 px against 22 px on screen …
    for (const sh of [old, book]) {
      const pg = sheetPrintPages(sh)[0];
      expect(printRowPx(sh.defRowH, pg.ky, 1) * 6.25).toBeCloseTo(139, 6); // … 139 dots on paper (22.24 px)
    }
    // a default height stored well away from the font's row without customHeight: Excel ignores it (the font's row,
    // 139 dots) and set rows keep the 96-dpi ratio; a set default height (customHeight) prints × that ratio like a set row
    const tall = { ...old, defRowH: 40 };
    const pg = sheetPrintPages(tall)[0];
    expect(printRowPx(pg.defPx, pg.ky, 1) * 6.25).toBeCloseTo(139, 6);
    expect(pg.ky).toBeCloseTo(139 / 137.5, 9);
    const set = { ...old, defRowH: 40, defRowCustom: true };
    const ps = sheetPrintPages(set)[0];
    expect(ps.defPx).toBe(40);
    expect(printRowPx(ps.defPx, ps.ky, 1) * 6.25).toBe(Math.floor(40 * 6.25 * (139 / 137.5)));
  });
});
