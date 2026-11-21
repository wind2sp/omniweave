// Drawings on sheets (시트 위 차트·그림·도형): the Excel-made chart workbook (qa/interop/scripts/xlsx_chart_make.ps1)
// reads into anchored drawings, and an unedited save keeps every byte (the drawing parts are never rewritten).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { readXlsx } from "../../src/io/sheet/read";
import { openSheetBook, saveSheetBook } from "../../src/io/sheet/book";
import { paintChart } from "../../src/render/sheetChart";
import { liveRef } from "../../src/render/sheetDrawings";

(globalThis as any).DOMParser ??= DOMParser;
const BOOK = "qa/interop/excel-made/omni-xlsx-chart.xlsx";
const truth = JSON.parse(readFileSync("qa/interop/excel-made/omni-xlsx-chart.truth.json", "utf8").replace(/^﻿/, ""));

describe("sheet drawings (Excel 16 chart workbook)", () => {
  const bytes = new Uint8Array(readFileSync(BOOK));
  const { sheets } = readXlsx(bytes, "ko");
  it("reads every chart with its chart part and anchor", () => {
    const charts = sheets[0].drawings!.filter((d) => d.kind === "chart");
    expect(charts.map((d) => d.name)).toEqual(truth.charts.map((c: { name: string }) => c.name));
    for (const d of charts) {
      expect(d.chart).toMatch(/plotArea/);
      expect(d.at.c1).toBeGreaterThan(d.at.c0);
      expect(d.theme?.length).toBe(12);
    }
  });
  it("reads the picture bytes and the shapes with their text", () => {
    const ds = sheets[1].drawings!;
    const pic = ds.find((d) => d.kind === "pic")!;
    expect(pic.mime).toBe("image/png");
    expect(pic.data!.length).toBeGreaterThan(1000);
    const shapes = ds.filter((d) => d.kind === "shape");
    expect(shapes.map((s) => s.geom)).toEqual(["rect", "ellipse", "roundRect", "rightArrow", "rect"]);
    expect(shapes[0].paras?.[0].text).toBe("사각형 도형");
    expect(shapes[0].fill).toMatch(/^#/);
    expect(shapes[4].paras?.[0].text).toMatch(/^글상자/);
  });
  it("reads chartex charts (waterfall, histogram, …) from their Choice, 3-D and other kinds as charts, and paints them all", () => {
    const more = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-chart-more.xlsx"));
    const mt = JSON.parse(readFileSync("qa/interop/excel-made/omni-xlsx-chart-more.truth.json", "utf8").replace(/^﻿/, ""));
    const ms = readXlsx(more, "ko").sheets;
    const charts = ms[0].drawings!.filter((d) => d.kind === "chart");
    expect(charts.map((d) => d.name)).toEqual(mt.charts.map((c: { name: string }) => c.name));
    expect(charts.filter((d) => /<cx:chartSpace/.test(d.chart!)).length).toBe(5);
    expect(charts[0].fonts?.slice(0, 2)).toEqual(["Calibri", "맑은 고딕"]);
    const texts: string[] = [];
    const ctx: any = new Proxy({}, {
      get: (o: any, k) => (k in o ? o[k] : k === "fillText" ? (s: string) => texts.push(s) : k === "measureText" ? (s: string) => ({ width: s.length * 6 }) : () => {}),
      set: (o: any, k, v) => ((o[k] = v), true),
    });
    for (const d of charts) expect(paintChart(ctx, d.chart!, d.theme ?? [], 0, 0, 480, 288, 1, { lang: "ko", font: "Calibri", fonts: d.fonts, live: liveRef(ms, ms[0]) }), d.name).toBe(true);
    // waterfall legend and labels, histogram bins from the cells behind _xlchart names, the surface's value bands; 3-D
    // charts are drawn in depth now (no "shown flat" note)
    expect(texts).toEqual(expect.arrayContaining(["증가", "감소", "합계", "-30", "[52, 64]", "(88, 100]", "0-50", "50-100", "100-150"]));
    expect(texts).not.toContain("3차원 차트 — 평면으로 표시");
    const saved = saveSheetBook(openSheetBook(more, "m.xlsx", "ko").pages, () => {
      throw new Error("fresh save");
    });
    expect(saved.length === more.length && saved.every((b, i) => b === more[i])).toBe(true);
  });
  it("saves an unedited chart workbook byte for byte", () => {
    const opened = openSheetBook(bytes, "c.xlsx", "ko");
    const saved = saveSheetBook(opened.pages, () => {
      throw new Error("fresh save");
    });
    expect(saved.length === bytes.length && saved.every((b, i) => b === bytes[i])).toBe(true);
  });
});
