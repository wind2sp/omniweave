// Chartex painter (render/sheetChartEx.ts) on awkward parts: tiny bin sizes, broken values, a painter that throws.
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import { paintChart } from "../../src/render/sheetChart";

(globalThis as any).DOMParser ??= DOMParser;

const NS = 'xmlns:cx="http://schemas.microsoft.com/office/drawing/2014/chartex"';
const part = (layout: string, vals: (number | string)[], extra = "", cats?: string[]) => `<cx:chartSpace ${NS}><cx:chartData><cx:data id="0">${
  cats ? `<cx:strDim type="cat"><cx:lvl ptCount="${cats.length}">${cats.map((c, i) => `<cx:pt idx="${i}">${c}</cx:pt>`).join("")}</cx:lvl></cx:strDim>` : ""
}<cx:numDim type="val"><cx:lvl ptCount="${vals.length}" formatCode="General">${vals.map((v, i) => `<cx:pt idx="${i}">${v}</cx:pt>`).join("")}</cx:lvl></cx:numDim></cx:data></cx:chartData><cx:chart><cx:plotArea><cx:plotAreaRegion><cx:series layoutId="${layout}"><cx:dataLabels pos="outEnd"/><cx:dataId val="0"/>${extra}</cx:series></cx:plotAreaRegion></cx:plotArea></cx:chart></cx:chartSpace>`;

function fakeCtx(opt: { throwOn?: string } = {}) {
  const calls = { save: 0, restore: 0, fillRect: 0, texts: [] as string[] };
  const ctx: any = new Proxy(
    {},
    {
      get: (o: any, k) => {
        if (k in o) return o[k];
        if (k === opt.throwOn) return () => {
          throw new Error("boom");
        };
        if (k === "save") return () => calls.save++;
        if (k === "restore") return () => calls.restore++;
        if (k === "fillRect") return () => calls.fillRect++;
        if (k === "fillText") return (s: string) => calls.texts.push(s);
        if (k === "measureText") return (s: string) => ({ width: s.length * 6 });
        return () => {};
      },
      set: (o: any, k, v) => ((o[k] = v), true),
    },
  );
  return { ctx, calls };
}
const paint = (ctx: any, xml: string) => paintChart(ctx, xml, [], 0, 0, 480, 288, 1, { lang: "ko", font: "Calibri" });

describe("chartex painter on awkward parts", () => {
  it("a histogram with a tiny bin size draws a bounded number of bins", () => {
    const vals = Array.from({ length: 50 }, (_, i) => i * 20);
    const { ctx, calls } = fakeCtx();
    const t0 = Date.now();
    expect(paint(ctx, part("clusteredColumn", vals, '<cx:layoutPr><cx:binning intervalClosed="r"><cx:binSize val="0.000001"/></cx:binning></cx:layoutPr>'))).toBe(true);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(calls.fillRect).toBeLessThan(3000);
  });
  it("leaves the context balanced when the chartex painter fails", () => {
    const { ctx, calls } = fakeCtx({ throwOn: "strokeRect" });
    paint(ctx, part("waterfall", [10, -5, 20]));
    expect(calls.save).toBe(calls.restore);
  });
  it("a waterfall with a value that is not a number draws it as 0, not NaN", () => {
    const { ctx, calls } = fakeCtx();
    expect(paint(ctx, part("waterfall", [10, "abc", 20], "", ["a", "b", "c"]))).toBe(true);
    expect(calls.texts.some((s) => /NaN/.test(s))).toBe(false);
    expect(calls.texts).toEqual(expect.arrayContaining(["10", "20"]));
  });
  it("pareto of a single zero, empty data and a funnel of zeros draw without errors", () => {
    for (const xml of [part("clusteredColumn", [0], '<cx:layoutPr/>', ["x"]) .replace("</cx:plotAreaRegion>", '<cx:series layoutId="paretoLine"><cx:dataId val="0"/></cx:series></cx:plotAreaRegion>'), part("waterfall", []), part("funnel", [0, 0], "", ["a", "b"]), part("boxWhisker", []), part("treemap", [0], "", ["a"]), part("sunburst", [-1, 2], "", ["a", "b"])]) {
      const { ctx, calls } = fakeCtx();
      expect(() => paint(ctx, xml)).not.toThrow();
      expect(calls.save).toBe(calls.restore);
      expect(calls.texts.some((s) => /NaN|Infinity/.test(s))).toBe(false);
    }
  });
});
