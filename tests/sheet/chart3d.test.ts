// 3-D charts drawn in depth (render/sheetChart3D.ts) and the chart fidelity fixes measured on Excel's pictures
// (qa/interop/excel-made/omni-xlsx-chart-more.*): the camera, the Excel-made 3-D / surface / pie charts, odd views and
// data that must still draw, histogram bins, Excel's treemap layout, bubble scales.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { readXlsx } from "../../src/io/sheet/read";
import { paintChart, type View3D } from "../../src/render/sheetChart";
import { camera, MAX_3D_POINTS, shade } from "../../src/render/sheetChart3D";
import { histBins, squarify } from "../../src/render/sheetChartEx";
import { liveRef } from "../../src/render/sheetDrawings";

(globalThis as any).DOMParser ??= DOMParser;

/** A canvas stand-in that records text, path points, fills and save / restore. */
function recorder() {
  const rec = { texts: [] as string[], pts: [] as number[], fills: [] as unknown[], save: 0, restore: 0 };
  const ctx: any = new Proxy(
    {},
    {
      get: (o: any, k) => {
        if (k in o) return o[k];
        if (k === "fillText") return (s: string, x: number, y: number) => (rec.texts.push(s), rec.pts.push(x, y));
        if (k === "measureText") return (s: string) => ({ width: s.length * 6 });
        if (k === "moveTo" || k === "lineTo" || k === "fillRect" || k === "rect" || k === "arc") return (...a: number[]) => rec.pts.push(...a.slice(0, 4));
        if (k === "fill") return () => rec.fills.push(o.fillStyle);
        if (k === "save") return () => rec.save++;
        if (k === "restore") return () => rec.restore++;
        if (k === "createLinearGradient") return () => ({ addColorStop: () => {}, gradient: true });
        return () => {};
      },
      set: (o: any, k, v) => ((o[k] = v), true),
    },
  );
  return { ctx, rec };
}

const view = (o: Partial<View3D>): View3D => ({ rotX: 15, rotY: 20, depth: 100, perspective: 30, rAng: true, floor: null, backWall: null, sideWall: null, ...o });
const rect = { x: 10, y: 20, w: 400, h: 200 };
const corners = (H: number, D: number) => [0, 1].flatMap((x) => [0, H].flatMap((y) => [0, D].map((z) => [x, y, z] as [number, number, number])));

describe("3-D camera", () => {
  it("right-angle axes keep the front face square and draw depth up and to the right, filling the room", () => {
    const cam = camera(view({}), 0.4, rect);
    const [a, b, top, back] = [cam.P([0, 0, 0]), cam.P([1, 0, 0]), cam.P([0, cam.H, 0]), cam.P([0, 0, cam.D])];
    expect(b[1]).toBeCloseTo(a[1], 6);
    expect(top[0]).toBeCloseTo(a[0], 6);
    expect(back[0]).toBeGreaterThan(a[0]);
    expect(back[1]).toBeLessThan(a[1]);
    // depth across : up = sin rotY : sin rotX · cos rotY (Excel's oblique view)
    expect((a[1] - back[1]) / (back[0] - a[0])).toBeCloseTo((Math.sin((15 * Math.PI) / 180) * Math.cos((20 * Math.PI) / 180)) / Math.sin((20 * Math.PI) / 180), 6);
    const ps = corners(cam.H, cam.D).map(cam.P);
    const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(rect.x, 3);
    expect(Math.max(...xs)).toBeCloseTo(rect.x + rect.w, 3);
    expect(Math.min(...ys)).toBeCloseTo(rect.y, 3);
    expect(Math.max(...ys)).toBeCloseTo(rect.y + rect.h, 3);
  });
  it("in perspective the near right end sits lower, verticals lean in towards the floor and the box stays in the room", () => {
    const cam = camera(view({ rAng: false }), 0.4, rect);
    const fl = cam.P([0, 0, 0]), fr = cam.P([1, 0, 0]), flTop = cam.P([0, cam.H, 0]);
    expect(fr[1]).toBeGreaterThan(fl[1]);
    expect(flTop[0]).toBeLessThan(fl[0]);
    // the height keeps to the room's proportions (fitted on Excel's pictures), whatever the depth
    expect(camera(view({ rAng: false }), 0.8, rect).H).toBeCloseTo(cam.H, 9);
    for (const p of corners(cam.H, cam.D).map(cam.P)) {
      expect(p[0]).toBeGreaterThanOrEqual(rect.x - 1e-6);
      expect(p[0]).toBeLessThanOrEqual(rect.x + rect.w + 1e-6);
      expect(p[1]).toBeGreaterThanOrEqual(rect.y - 1e-6);
      expect(p[1]).toBeLessThanOrEqual(rect.y + rect.h + 1e-6);
    }
    // farther points (the back) are farther from the viewer
    expect(cam.far([0, 0, cam.D])).toBeGreaterThan(cam.far([0, 0, 0]));
  });
  it("shade darkens a colour and leaves other colour strings alone", () => {
    expect(shade("#4472C4", 0.7)).toBe("#305089");
    expect(shade("rgba(1,2,3,0.5)", 0.7)).toBe("rgba(1,2,3,0.5)");
  });
});

describe("the Excel-made 3-D, surface and pie charts", () => {
  const more = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-chart-more.xlsx"));
  const ms = readXlsx(more, "ko").sheets;
  const charts = ms[0].drawings!.filter((d) => d.kind === "chart");
  const paint = (name: string) => {
    const d = charts.find((c) => c.name === name)!;
    const { ctx, rec } = recorder();
    expect(paintChart(ctx, d.chart!, d.theme ?? [], 0, 0, 600, 360, 1.25, { lang: "ko", font: "Calibri", fonts: d.fonts, live: liveRef(ms, ms[0]) })).toBe(true);
    expect(rec.pts.every(Number.isFinite)).toBe(true);
    expect(rec.save).toBe(rec.restore);
    expect(rec.texts).not.toContain("3차원 차트 — 평면으로 표시");
    return { rec, theme: d.theme ?? [] };
  };
  it("3-D columns: boxes with lit tops and darker sides, value and category labels", () => {
    const { rec, theme } = paint("3차원 묶은 세로 막대");
    const acc1 = "#" + theme[4].toUpperCase();
    expect(rec.fills.map((f) => String(f).toUpperCase())).toEqual(expect.arrayContaining([acc1, shade(acc1, 0.7), shade(acc1, 0.6)]));
    // 15 bars, three faces each at least
    expect(rec.fills.length).toBeGreaterThanOrEqual(45);
    expect(rec.texts).toEqual(expect.arrayContaining(["160", "0", "서울", "광주"]));
  });
  it("3-D lines and areas: a row per series with the series axis named on the right", () => {
    for (const name of ["3차원 꺾은선", "3차원 영역"]) {
      const { rec } = paint(name);
      expect(rec.texts.filter((t) => t === "2분기").length, name).toBe(2); // the legend and the series axis
      expect(rec.texts).toEqual(expect.arrayContaining(["150", "서울"]));
    }
  });
  it("a surface: the value bands in the legend and on the surface, in the bandFmt colours", () => {
    const { rec } = paint("표면형");
    expect(rec.texts).toEqual(expect.arrayContaining(["0-50", "50-100", "100-150", "3분기"]));
    // the faces are the band colours (accent 2 orange, accent 3 gray), lit
    const rgb = (f: unknown) => (typeof f === "string" && /^#[0-9A-F]{6}$/i.test(f) ? [1, 3, 5].map((i) => parseInt(f.slice(i, i + 2), 16)) : null);
    const faces = rec.fills.map(rgb).filter((c): c is number[] => !!c);
    expect(faces.some(([r, g, b]) => r > g && g > b && r > 1.5 * b)).toBe(true);
    expect(faces.some(([r, g, b]) => r === g && g === b && r > 100 && r < 200)).toBe(true);
  });
  it("a 3-D pie: shaded rim and the five slices on top", () => {
    const { rec } = paint("3차원 원");
    expect(rec.fills.filter((f) => (f as any)?.gradient).length).toBeGreaterThanOrEqual(2);
    expect(rec.texts).toEqual(expect.arrayContaining(["서울", "부산", "대구", "인천", "광주"]));
  });
  it("bubbles widen the value scale so they fit (0–30, as Excel)", () => {
    const { rec } = paint("거품형");
    expect(rec.texts).toContain("30");
  });
  it("histogram bins from the cells behind the _xlchart names: Excel's rounded automatic width", () => {
    const vals = (liveRef(ms, ms[0])("_xlchart.v1.4") ?? []).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
    expect(vals.length).toBe(30);
    const b = histBins(vals, { closed: "r" });
    expect(b.size).toBe(12);
    expect(b.counts).toEqual([3, 10, 11, 6]);
    // a given bin size / count wins over the rule
    expect(histBins(vals, { size: 10 }).counts.length).toBe(5);
    expect(histBins(vals, { count: 3 }).counts.length).toBe(3);
  });
});

describe("Excel's treemap layout", () => {
  it("cuts each value, biggest first, across the longer side", () => {
    const r = squarify([120, 80, 60, 70, 45], 0, 0, 580, 245);
    const [seoul, busan, daegu, incheon, gwangju] = r;
    expect(seoul[0]).toBe(0);
    expect(seoul[3]).toBeCloseTo(245, 6);
    expect(seoul[2]).toBeCloseTo((120 / 375) * 580, 6);
    expect(busan[3]).toBeCloseTo(245, 6);
    expect(incheon[3]).toBeCloseTo(245, 6);
    expect(incheon[0]).toBeLessThan(daegu[0]);
    // 60 over 45 in the last column
    expect(daegu[0]).toBeCloseTo(gwangju[0], 6);
    expect(daegu[1]).toBeCloseTo(0, 6);
    expect(gwangju[1]).toBeCloseTo(daegu[3], 6);
    const area = r.reduce((a, q) => a + q[2] * q[3], 0);
    expect(area).toBeCloseTo(580 * 245, 3);
  });
  it("zeros and negatives take no room", () => {
    const r = squarify([0, -3, 5], 0, 0, 100, 50);
    expect(r[0][2] * r[0][3]).toBe(0);
    expect(r[1][2] * r[1][3]).toBe(0);
    expect(r[2][2] * r[2][3]).toBeCloseTo(5000, 6);
  });
});

const NS = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const part = (kind: string, view3D: string, sers: (number | null)[][], opt: { dir?: string; grouping?: string } = {}) =>
  `<c:chartSpace ${NS}><c:chart>${view3D}<c:plotArea><c:${kind}Chart>${kind === "bar3D" ? `<c:barDir val="${opt.dir ?? "col"}"/>` : ""}${opt.grouping ? `<c:grouping val="${opt.grouping}"/>` : ""}${sers
    .map(
      (v, k) =>
        `<c:ser><c:idx val="${k}"/><c:tx><c:v>S${k}</c:v></c:tx><c:cat><c:strLit><c:ptCount val="${v.length}"/>${v.map((_, i) => `<c:pt idx="${i}"><c:v>C${i}</c:v></c:pt>`).join("")}</c:strLit></c:cat><c:val><c:numLit><c:ptCount val="${v.length}"/>${v
          .map((x, i) => (x == null ? "" : `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`))
          .join("")}</c:numLit></c:val></c:ser>`,
    )
    .join("")}<c:axId val="1"/><c:axId val="2"/><c:axId val="3"/></c:${kind}Chart><c:catAx><c:axId val="1"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:majorGridlines/><c:crossAx val="1"/></c:valAx><c:serAx><c:axId val="3"/><c:crossAx val="2"/></c:serAx></c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;

describe("odd 3-D views and data still draw", () => {
  const views = [
    "",
    '<c:view3D><c:rotX val="-40"/><c:rotY val="200"/><c:rAngAx val="0"/><c:perspective val="240"/></c:view3D>',
    '<c:view3D><c:rotX val="80"/><c:rotY val="340"/><c:depthPercent val="2000"/><c:rAngAx val="1"/></c:view3D>',
    '<c:view3D><c:rotX val="90"/><c:rotY val="0"/><c:depthPercent val="20"/><c:rAngAx val="0"/><c:perspective val="0"/></c:view3D>',
  ];
  const data: (number | null)[][][] = [[[3, -5, null, 8], [1, 2, 3, 4]], [[7]], [], [[0, 0, 0], [0, 0, 0]], [[1e9, -1e9, 2]]];
  it("every kind, every view, awkward data: drawn, finite, the context balanced", () => {
    for (const kind of ["bar3D", "line3D", "area3D", "surface3D", "surface", "pie3D"])
      for (const v of views)
        for (const d of data)
          for (const grouping of [undefined, "stacked", "percentStacked", "standard", "clustered"]) {
            const { ctx, rec } = recorder();
            const ok = paintChart(ctx, part(kind, v, d, { grouping }), [], 0, 0, 480, 288, 1, { lang: "ko", font: "Calibri" });
            const tag = `${kind} ${v} ${JSON.stringify(d)} ${grouping}`;
            // a chart without series has nothing to draw (the frame stays empty)
            expect(ok, tag).toBe(d.length > 0);
            expect(rec.pts.every(Number.isFinite), tag).toBe(true);
            expect(rec.texts.some((t) => /NaN|Infinity|undefined/.test(t)), tag).toBe(false);
            expect(rec.save, tag).toBe(rec.restore);
          }
  });
  it("horizontal 3-D bars stay flat with the note", () => {
    const { ctx, rec } = recorder();
    expect(paintChart(ctx, part("bar3D", "", [[1, 2, 3]], { dir: "bar" }), [], 0, 0, 480, 288, 1, { lang: "ko", font: "Calibri" })).toBe(true);
    expect(rec.texts).toContain("3차원 차트 — 평면으로 표시");
  });
});

// QA (qa/interop/scripts/xlsx_chart_var_make.ps1 — Excel pictures at other views and chartex settings than the one
// workbook the 3-D constants were first fitted on)
describe("other views, other chartex settings (omni-xlsx-chart-var)", () => {
  const book = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-chart-var.xlsx"));
  const vs = readXlsx(book, "ko").sheets;
  const charts = vs[0].drawings!.filter((d) => d.kind === "chart");
  const paint = (name: string) => {
    const d = charts.find((c) => c.name === name)!;
    const { ctx, rec } = recorder();
    expect(paintChart(ctx, d.chart!, d.theme ?? [], 0, 0, 600, 360, 1.25, { lang: "ko", font: "Calibri", fonts: d.fonts, live: liveRef(vs, vs[0]) })).toBe(true);
    expect(rec.pts.every(Number.isFinite)).toBe(true);
    expect(rec.save).toBe(rec.restore);
    return rec;
  };
  it("every chart draws, finite and balanced", () => {
    for (const d of charts) paint(d.name!);
  });
  it("the 3-D value axis ends at the first step over the data, without the 2-D headroom (Excel: 150, not 200)", () => {
    const t = paint("세로 막대 원근 0").texts;
    expect(t).toContain("150");
    expect(t).not.toContain("200");
  });
  it("turned columns: at least the room's height seen straight on, 0.8 of it turned; lines / areas 0.6", () => {
    const v = view({ rAng: false, rotX: 0, rotY: 0 });
    const want = rect.h / rect.w;
    // straight on the box fills the room (Excel's 0/0 picture)
    expect(camera(v, 0.11, rect, true).H).toBeCloseTo(camera({ ...v, rAng: true }, 0.11, rect).H, 3);
    expect(camera(view({ rAng: false }), 0.6, rect, true).H).toBeCloseTo(0.8 * want, 6);
    expect(camera(view({ rAng: false, perspective: 0 }), 0.6, rect, true).H).toBeCloseTo(0.8 * want, 6);
    expect(camera(view({ rAng: false, perspective: 0 }), 0.2, rect).H).toBeCloseTo(0.6 * want, 6);
  });
  it("a treemap of twelve values in Excel's plot: Excel's columns and rows", () => {
    const r = squarify([210, 160, 130, 110, 95, 80, 64, 50, 41, 30, 22, 12], 10, 163, 580, 215).map((q) => q.map(Math.round));
    // measured on Excel's picture (±3 px): 가 | 나 | 다 over 라 | 마 over 바 | (사 beside 아) over (자 | 차 over (카 | 타))
    const excel = [[10, 163, 120, 215], [133, 163, 89, 215], [225, 163, 136, 115], [225, 280, 136, 98], [363, 163, 98, 115], [363, 280, 98, 98], [464, 163, 69, 109], [536, 163, 54, 109], [464, 275, 47, 103], [514, 277, 76, 45], [514, 325, 47, 53], [564, 325, 26, 53]];
    r.forEach((q, i) => q.forEach((v, j) => expect(Math.abs(v - excel[i][j]), `${i} ${j}: ${v} vs ${excel[i][j]}`).toBeLessThanOrEqual(3)));
  });
  it("a two-level treemap: a range of two columns is a hierarchy, the groups in the legend and over their leaves", () => {
    const t = paint("트리맵 2단계").texts;
    for (const g of ["과일", "채소", "곡물"]) expect(t.filter((x) => x === g).length, g).toBe(2); // legend + label
    expect(t).toEqual(expect.arrayContaining(["사과", "보리", "무"]));
  });
  it("twelve legend entries wrap into rows (Excel: two rows of six)", () => {
    const d = charts.find((c) => c.name === "트리맵 12")!;
    const ys = new Map<string, number>();
    const ctx: any = new Proxy({}, { get: (o: any, k) => (k in o ? o[k] : k === "fillText" ? (s: string, _x: number, y: number) => (ys.has(s) ? 0 : ys.set(s, y)) : k === "measureText" ? (s: string) => ({ width: s.length * 16 }) : () => {}), set: (o: any, k, v) => ((o[k] = v), true) });
    paintChart(ctx, d.chart!, d.theme ?? [], 0, 0, 600, 360, 1.25, { lang: "ko", font: "Calibri", fonts: d.fonts, live: liveRef(vs, vs[0]) });
    const at = (s: string) => ys.get(s)!;
    expect(at("바")).toBeCloseTo(at("가"), 6);
    expect(at("사")).toBeGreaterThan(at("가") + 20);
  });
  it("histogram bins: a given width; a count with an overflow bin (Excel: 4 × 9.5 and > 90)", () => {
    expect(paint("히스토그램 너비 10").texts).toEqual(expect.arrayContaining(["[52, 62]", "(92, 102]"]));
    expect(paint("히스토그램 넘침").texts).toEqual(expect.arrayContaining(["[52, 61.5]", "(80.5, 90]", "> 90"]));
    const d = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const b = histBins(d, { count: 4, under: 2, over: 8 });
    expect([b.under, b.over, b.counts.reduce((a, c) => a + c, 0)]).toEqual([2, 2, 6]);
    expect(b.counts.length).toBe(2);
  });
});

describe("hostile 3-D charts never hang the painter", () => {
  const paintMs = (x: string) => {
    const { ctx, rec } = recorder();
    const t0 = performance.now();
    paintChart(ctx, x, [], 0, 0, 480, 288, 1, { lang: "ko", font: "Calibri" });
    expect(rec.pts.every(Number.isFinite)).toBe(true);
    expect(rec.save).toBe(rec.restore);
    return { ms: performance.now() - t0, rec };
  };
  it("a major unit of 1e-6, 0 or −5, reversed or ±1e300 bounds: drawn at once", () => {
    for (const kind of ["surface3D", "surface", "bar3D", "line3D"])
      for (const vax of ['<c:majorUnit val="0.000001"/>', '<c:majorUnit val="0"/>', '<c:majorUnit val="-5"/>', '<c:scaling><c:max val="0"/><c:min val="100"/></c:scaling>', '<c:scaling><c:max val="1e300"/><c:min val="-1e300"/></c:scaling>']) {
        // (before: a surface with major unit 1e-6 cut every triangle into 10⁸ bands — the UI froze)
        const x = part(kind, "", [[1, 50, 100], [3, 60, 20]]).replace("<c:valAx><c:axId val=\"2\"/>", `<c:valAx><c:axId val="2"/>${vax}`);
        expect(x).toContain(vax);
        expect(paintMs(x).ms, `${kind} ${vax}`).toBeLessThan(2000);
      }
  });
  it("NaN, ±Infinity, 1e308 and 1e-300 values; rotY 360, perspective 240, depth 2000 %", () => {
    const v = '<c:view3D><c:rotX val="15"/><c:rotY val="360"/><c:rAngAx val="0"/><c:perspective val="240"/><c:depthPercent val="2000"/></c:view3D>';
    for (const kind of ["bar3D", "line3D", "area3D", "surface3D", "pie3D"])
      for (const d of [[["NaN", "Infinity", "-Infinity", 3]], [[1e308, 1e308, -1e308, 1e-300]]] as unknown as (number | null)[][][]) {
        const { rec } = paintMs(part(kind, v, d));
        expect(rec.texts.some((t) => /NaN|Infinity|undefined/.test(t)), `${kind} ${JSON.stringify(d)}`).toBe(false);
      }
  });
  it("10 000 points × 3 series: Excel's 4000-point 3-D limit keeps the faces bounded", () => {
    const big = Array.from({ length: 10000 }, (_, i) => Math.sin(i) * 100);
    for (const kind of ["bar3D", "surface3D"]) {
      const { rec } = paintMs(part(kind, '<c:view3D><c:rotX val="15"/><c:rotY val="20"/><c:rAngAx val="0"/></c:view3D>', [big, big, big]));
      // at most ~6 faces a box (bars) or ~4 band pieces a triangle (surface), 4000 points a series
      expect(rec.fills.length, kind).toBeLessThan(MAX_3D_POINTS * 3 * 6 + 100);
    }
  });
});
