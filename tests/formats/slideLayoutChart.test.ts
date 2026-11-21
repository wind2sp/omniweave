// PowerPoint's everyday edits written into the original deck (officesurgeon/pptx.ts): a slide moved to another of the
// deck's layouts (placeholders pointed at the new layout's, leftover content kept), a new slide from a deck layout, and
// a chart's data edited (chart part caches and the embedded workbook agree).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { makeAsset } from "../../src/core/assets";
import { copyNode, newDocument, uid, type OmwDocument, type Page, type SlideChart, type TextNode } from "../../src/core/types";
import { layoutOfPage, swapDeckLayout } from "../../src/core/slides";
import { importPptx, pptxLayoutSlides } from "../../src/io/formats/pptx";
import { chartRun, replaceChart } from "../../src/io/formats/pptxChart";
import { parseXlsx } from "../../src/io/formats/xlsx";
import { attachPptxMeta, pptxSurgical } from "../../src/io/officesurgeon/pptx";
import { chartPartWithData, chartSheetOf } from "../../src/io/officesurgeon/pptxChart";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const SURGEON = "qa/interop/adobe-made/omni-pptx-surgeon.pptx";
const FIDELITY = "qa/interop/adobe-made/omni-pptx-fidelity.pptx";

function open(path: string): { doc: OmwDocument; bytes: Uint8Array } {
  const bytes = new Uint8Array(readFileSync(path));
  const r = importPptx(bytes, "deck.pptx");
  const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx");
  attachPptxMeta(r.pages, r.slideParts, r.slideEls, asset, r.assets);
  const doc = newDocument("deck");
  doc.pages = r.pages;
  doc.assets = { ...r.assets, [asset.id]: asset };
  return { doc, bytes };
}

const files = (b: Uint8Array) => unzipSync(b);
const text = (z: Record<string, Uint8Array>, n: string) => strFromU8(z[n]);
/** The p:sp elements of a slide part. */
const sps = (xml: string) => xml.match(/<p:sp>[\s\S]*?<\/p:sp>/g) ?? [];

describe("deck layouts: change layout and new slide, written into the original", () => {
  it("imports p:ph idx, so 'two content' tells its two text placeholders apart", () => {
    const { bytes } = open(SURGEON);
    const two = pptxLayoutSlides(bytes).layouts.find((l) => l.part.endsWith("slideLayout4.xml"))!;
    const idx = two.page.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.ph && n.ph.type === "body").map((n) => n.ph!.idx);
    expect(idx).toEqual(["1", "2"]);
  });

  it("a slide moved to 'two content' keeps its shapes; its placeholders point at the new layout's (no own place)", async () => {
    const { doc, bytes } = open(SURGEON);
    const { layouts, assets } = pptxLayoutSlides(bytes);
    const from = layouts.find((l) => l.part === doc.pages[1].layout)!;
    const two = layouts.find((l) => l.part.endsWith("slideLayout4.xml"))!;
    const p = structuredClone(doc.pages[1]);
    swapDeckLayout(p, from.page, two.page, { ...layoutOfPage(two.page), id: two.part }, { ...assets, ...doc.assets });
    expect(p.layout).toBe(two.part);
    doc.pages = doc.pages.map((x, i) => (i === 1 ? p : x));
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    // nothing rewritten as new shapes
    expect(r.warnings).toEqual([]);
    const z = files(r.bytes), a = files(bytes);
    expect(text(z, "ppt/slides/_rels/slide2.xml.rels")).toContain('Target="../slideLayouts/slideLayout4.xml"');
    const s2 = text(z, "ppt/slides/slide2.xml");
    expect(s2).not.toContain("showMasterSp");
    const body = sps(s2).find((s) => s.includes(">First<"))!;
    expect(body).toMatch(/<p:ph sz="half" idx="1"\/>/);
    expect(body).not.toContain("<a:xfrm>");
    // the layout's second text placeholder, empty, as PowerPoint writes one
    expect(sps(s2).some((s) => /<p:ph sz="half" idx="2"\/>/.test(s) && s.includes("<p:spPr/>"))).toBe(true);
    // the other shapes byte for byte
    const box = (x: string) => sps(x).find((s) => s.includes('name="Box"'));
    expect(box(s2)).toBe(box(text(a, "ppt/slides/slide2.xml")));
    // read back: the layout and the text
    const back = importPptx(r.bytes, "x.pptx").pages[1];
    expect(back.layout).toBe(two.part);
    const t = back.nodes.filter((n): n is TextNode => n.type === "TEXT" && n.ph?.type === "body");
    expect(t.map((n) => n.ph!.idx)).toEqual(["1", "2"]);
    expect(t[0].paragraphs.map((q) => q.runs.map((x) => x.text).join(""))[0]).toContain("첫째 문단 First");
    // the slides and the other parts as they were
    expect(text(z, "ppt/slides/slide1.xml")).toBe(text(a, "ppt/slides/slide1.xml"));
    expect(text(z, "ppt/presentation.xml")).toBe(text(a, "ppt/presentation.xml"));
  });

  it("content without a place in the new layout stays where it was ('title only': the text keeps its own box)", async () => {
    const { doc, bytes } = open(SURGEON);
    const { layouts, assets } = pptxLayoutSlides(bytes);
    const from = layouts.find((l) => l.part === doc.pages[1].layout)!;
    const only = layouts.find((l) => l.part.endsWith("slideLayout6.xml"))!;
    const p = structuredClone(doc.pages[1]);
    const before = p.nodes.find((n): n is TextNode => n.type === "TEXT" && n.ph?.type === "body")!;
    swapDeckLayout(p, from.page, only.page, { ...layoutOfPage(only.page), id: only.part }, { ...assets, ...doc.assets });
    const kept = p.nodes.find((n) => n.id === before.id) as TextNode;
    expect(kept).toBeDefined();
    expect(kept.transform).toEqual(before.transform);
    doc.pages = doc.pages.map((x, i) => (i === 1 ? p : x));
    const r = (await pptxSurgical(doc, doc.pages))!;
    const s2 = text(files(r.bytes), "ppt/slides/slide2.xml");
    const body = sps(s2).find((s) => s.includes(">First<"))!;
    // the old layout placed it: it now has its own a:xfrm (the new layout has no body placeholder)
    expect(body).toContain("<a:xfrm>");
    const back = importPptx(r.bytes, "x.pptx").pages[1];
    const bt = back.nodes.find((n): n is TextNode => n.type === "TEXT" && n.ph?.type === "body")!;
    expect(Math.abs(bt.transform.x - before.transform.x)).toBeLessThan(1);
    expect(Math.abs(bt.transform.y - before.transform.y)).toBeLessThan(1);
  });

  it("a new slide from a deck layout: its own part, rels, content type and list entry; placeholders as p:ph only", async () => {
    const { doc, bytes } = open(SURGEON);
    const cmp = pptxLayoutSlides(bytes).layouts.find((l) => l.part.endsWith("slideLayout5.xml"))!;
    const np: Page = { ...cmp.page, id: uid("pg"), name: "new", nodes: cmp.page.nodes.map((x) => copyNode(x, uid())), animations: [], layout: cmp.part };
    doc.pages = [doc.pages[0], np, ...doc.pages.slice(1)];
    const r = (await pptxSurgical(doc, doc.pages))!;
    const z = files(r.bytes);
    const n = doc.pages.length;
    const part = `ppt/slides/slide${n}.xml`;
    expect(z[part]).toBeDefined();
    expect(text(z, "[Content_Types].xml")).toContain(`PartName="/${part}"`);
    const presRels = text(z, "ppt/_rels/presentation.xml.rels");
    const rid = new RegExp(`Id="(rId\\d+)"[^>]*Target="slides/slide${n}.xml"`).exec(presRels)?.[1];
    expect(rid).toBeTruthy();
    const ids = [...text(z, "ppt/presentation.xml").matchAll(/<p:sldId [^>]*r:id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(n);
    expect(ids[1]).toBe(rid);
    expect(text(z, `ppt/slides/_rels/slide${n}.xml.rels`)).toContain('Target="../slideLayouts/slideLayout5.xml"');
    const s = text(z, part);
    expect(s).not.toContain("showMasterSp");
    expect(s).not.toContain("<p:bg>");
    const phs = sps(s);
    expect(phs).toHaveLength(5);
    for (const x of phs) expect(x).toContain("<p:spPr/>");
    const back = importPptx(r.bytes, "x.pptx").pages[1];
    expect(back.layout).toBe(cmp.part);
    expect(back.nodes.filter((x) => x.type === "TEXT" && (x as TextNode).ph).length).toBe(5);
  });
});

describe("chart data: the chart part's caches and the embedded workbook", () => {
  function chartDeck() {
    const o = open(FIDELITY);
    const pi = o.doc.pages.findIndex((p) => p.nodes.some((n) => n.chart?.data));
    const page = o.doc.pages[pi];
    const head = page.nodes.findIndex((n) => n.chart?.data);
    return { ...o, pi, head, data: page.nodes[head].chart!.data! };
  }
  const edit = (doc: OmwDocument, pi: number, head: number, data: Omit<SlideChart, "frame">) => {
    doc.pages = doc.pages.map((p, i) => (i === pi ? { ...p, nodes: replaceChart(p.nodes, head, data) } : p));
  };
  const caches = (xml: string, tag: string) => [...(new RegExp(`<c:${tag}>[\\s\\S]*?</c:${tag}>`, "g").exec(xml) ? xml.match(new RegExp(`<c:${tag}>[\\s\\S]*?</c:${tag}>`, "g"))! : [])].map((el) => [...el.matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((m) => m[1]));
  const sheetGrid = (b: Uint8Array) => parseXlsx(b)[0].rows.map((r) => r.map((c) => c.text));

  it("reads the chart with its part, series, categories and values", () => {
    const { data } = chartDeck();
    expect(data.part).toBe("ppt/charts/chart1.xml");
    expect(data.kind).toBe("col");
    expect(data.series.map((s) => s.name)).toEqual(["계열 1", "계열 2", "계열 3"]);
    expect(data.categories).toEqual(["항목 1", "항목 2", "항목 3", "항목 4"]);
    expect(data.series[0].values).toEqual([4.3, 2.5, 3.5, 4.5]);
  });

  it("values edited: caches and workbook cells change, the workbook's table and the rest of the deck stay", async () => {
    const { doc, bytes, pi, head, data } = chartDeck();
    const { frame: _f, ...d } = data;
    edit(doc, pi, head, { ...d, series: d.series.map((s, k) => (k === 0 ? { ...s, values: [10, 20, 30, 40] } : s)) });
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    expect(r.warnings).toEqual([]);
    const z = files(r.bytes), a = files(bytes);
    const xml = text(z, "ppt/charts/chart1.xml");
    expect(caches(xml, "val")[0]).toEqual(["10", "20", "30", "40"]);
    // the other series: the same numbers (4.4000000000000004 is the double 4.4)
    expect(caches(xml, "val")[1].map(Number)).toEqual(caches(text(a, "ppt/charts/chart1.xml"), "val")[1].map(Number));
    const wb = z["ppt/embeddings/Microsoft_Excel_Worksheet.xlsx"];
    const grid = sheetGrid(wb);
    expect(grid.slice(1).map((r) => r[1])).toEqual(["10", "20", "30", "40"]);
    // cells only: the Excel table is still there
    expect(Object.keys(unzipSync(wb))).toContain("xl/tables/table1.xml");
    // the slide part is untouched (the chart did not move)
    const sp = Object.keys(a).find((k) => /ppt\/slides\/slide\d+\.xml$/.test(k) && strFromU8(a[k]).includes("chart"))!;
    expect(text(z, sp)).toBe(text(a, sp));
    // read back: the same chart data
    const back = importPptx(r.bytes, "x.pptx").pages[pi].nodes.find((n) => n.chart?.data)!.chart!.data!;
    expect(back.series[0].values).toEqual([10, 20, 30, 40]);
  });

  it("series renamed, a category and a series added: caches, formulas and workbook agree", async () => {
    const { doc, pi, head, data } = chartDeck();
    const { frame: _f, ...d } = data;
    const categories = [...d.categories, "항목 5"];
    const series = [...d.series.map((s, k) => ({ ...s, name: k === 1 ? "매출" : s.name, values: [...s.values, k + 1] })), { name: "새 계열", values: [1, 2, 3, 4, 5], color: null }];
    edit(doc, pi, head, { ...d, categories, series });
    const r = (await pptxSurgical(doc, doc.pages))!;
    const z = files(r.bytes);
    const xml = text(z, "ppt/charts/chart1.xml");
    expect(caches(xml, "tx").map((v) => v[0])).toEqual(["계열 1", "매출", "계열 3", "새 계열"]);
    expect(caches(xml, "cat")[0]).toEqual(categories);
    expect(caches(xml, "val")[3]).toEqual(["1", "2", "3", "4", "5"]);
    expect(xml).toContain("<c:f>Sheet1!$E$2:$E$6</c:f>");
    expect(xml).toContain("<c:f>Sheet1!$A$2:$A$6</c:f>");
    // the workbook holds the same table of values
    const grid = sheetGrid(z["ppt/embeddings/Microsoft_Excel_Worksheet.xlsx"]);
    expect(grid[0].slice(1, 5)).toEqual(["계열 1", "매출", "계열 3", "새 계열"]);
    expect(grid.slice(1, 6).map((r) => r[0])).toEqual(categories);
    for (let k = 0; k < 4; k++) expect(grid.slice(1, 6).map((r) => Number(r[k + 1]))).toEqual(series[k].values);
    const back = importPptx(r.bytes, "x.pptx").pages[pi].nodes.find((n) => n.chart?.data)!.chart!.data!;
    expect(back.series.map((s) => s.name)).toEqual(series.map((s) => s.name));
    expect(back.categories).toEqual(categories);
  });

  it("chart type changed to line and to pie: the chart part takes the new type (axes kept / dropped)", async () => {
    for (const kind of ["line", "pie", "bar"] as const) {
      const { doc, pi, head, data } = chartDeck();
      const { frame: _f, ...d } = data;
      edit(doc, pi, head, { ...d, kind });
      const r = (await pptxSurgical(doc, doc.pages))!;
      const xml = text(files(r.bytes), "ppt/charts/chart1.xml");
      if (kind === "line") {
        expect(xml).toContain("<c:lineChart>");
        expect(xml).not.toContain("<c:barChart>");
        expect(xml).toContain("<c:catAx>");
      } else if (kind === "pie") {
        expect(xml).toContain("<c:pieChart>");
        expect(xml).not.toContain("<c:catAx>");
      } else expect(xml).toContain('<c:barDir val="bar"/>');
      const back = importPptx(r.bytes, "x.pptx").pages[pi].nodes.find((n) => n.chart?.data)!.chart!.data!;
      expect(back.kind).toBe(kind);
      expect(back.series[0].values).toEqual(data.series[0].values);
    }
  });

  it("a chart edited and redrawn stays one run of shapes where it was moved", () => {
    const { doc, pi, head, data } = chartDeck();
    const page = doc.pages[pi];
    const [s, e] = chartRun(page.nodes, head);
    const moved = page.nodes.map((n, i) => (i >= s && i < e ? { ...n, transform: { ...n.transform, x: n.transform.x + 40, y: n.transform.y + 10 } } : n));
    const { frame: _f, ...d } = data;
    const out = replaceChart(moved, head, { ...d, categories: d.categories.slice(0, 2), series: d.series.map((x) => ({ ...x, values: x.values.slice(0, 2) })) });
    const m = out[head].chart!.data!;
    expect(m.frame.x).toBeCloseTo(data.frame.x + 40, 6);
    expect(m.frame.y).toBeCloseTo(data.frame.y + 10, 6);
    const [s2, e2] = chartRun(out, head);
    expect(out.slice(s2, e2).every((n) => n.chart?.id === page.nodes[head].chart!.id)).toBe(true);
    expect(out.length - (e2 - s2)).toBe(page.nodes.length - (e - s));
  });

  it("finds the sheet layout from the first series' formulas; series in rows are not PowerPoint's layout", () => {
    const xml = (cat: string, val: string) => `<c:chartSpace xmlns:c="c"><c:chart><c:plotArea><c:barChart><c:ser><c:cat><c:strRef><c:f>${cat}</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>${val}</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
    expect(chartSheetOf(xml("Sheet1!$A$2:$A$5", "Sheet1!$B$2:$B$5"))).toEqual({ sheet: "Sheet1", catCol: 0, firstCol: 1, headRow: 1 });
    expect(chartSheetOf(xml("'My data'!$C$4:$C$6", "'My data'!$D$4:$D$6"))).toEqual({ sheet: "'My data'", catCol: 2, firstCol: 3, headRow: 3 });
    expect(chartSheetOf(xml("Sheet1!$B$1:$E$1", "Sheet1!$B$2:$E$2"))).toBeNull();
    // the part still takes the data (caches), with no workbook layout
    const r = chartPartWithData(xml("Sheet1!$B$1:$E$1", "Sheet1!$B$2:$E$2"), { kind: "col", name: "c", categories: ["a"], series: [{ name: "s", values: [1], color: null }], gapWidth: 150, overlap: 0, accents: [], font: "Arial", frame: { x: 0, y: 0, w: 1, h: 1 } })!;
    expect(r.sheet).toBeNull();
    expect(r.xml).toContain("<c:v>1</c:v>");
  });
});
