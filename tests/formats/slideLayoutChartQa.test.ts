// QA (slide-layout): what a deck layout change, new slides and chart edits must not lose when written into the original
// deck — direct font sizes, animation targets, notes, slide ids / rels / content types, chart idx / axes, the embedded
// workbook's other sheets.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { makeAsset } from "../../src/core/assets";
import { copyNode, newDocument, uid, type OmwDocument, type Page, type SlideChart, type TextNode } from "../../src/core/types";
import { layoutOfPage, swapDeckLayout } from "../../src/core/slides";
import { importPptx, pptxLayoutSlides } from "../../src/io/formats/pptx";
import { replaceChart } from "../../src/io/formats/pptxChart";
import { importXlsx } from "../../src/io/formats/xlsx";
import { attachPptxMeta, pptxSurgical } from "../../src/io/officesurgeon/pptx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const SURGEON = "qa/interop/adobe-made/omni-pptx-surgeon.pptx";
const FIDELITY = "qa/interop/adobe-made/omni-pptx-fidelity.pptx";

function openBytes(bytes: Uint8Array): OmwDocument {
  const r = importPptx(bytes, "deck.pptx");
  const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx");
  attachPptxMeta(r.pages, r.slideParts, r.slideEls, asset, r.assets);
  const doc = newDocument("deck");
  doc.pages = r.pages;
  doc.assets = { ...r.assets, [asset.id]: asset };
  return doc;
}
const open = (path: string) => {
  const bytes = new Uint8Array(readFileSync(path));
  return { doc: openBytes(bytes), bytes };
};
const files = (b: Uint8Array) => unzipSync(b);
const text = (z: Record<string, Uint8Array>, n: string) => strFromU8(z[n]);
const runSizes = (n: TextNode) => n.paragraphs.flatMap((p) => p.runs.filter((r) => r.text).map((r) => r.fontSize));

/** Move slide `i` to the layout part ending in `to` (as ui/slideActions changeLayout does). */
function move(doc: OmwDocument, bytes: Uint8Array, i: number, to: string) {
  const { layouts, assets } = pptxLayoutSlides(bytes);
  const p = structuredClone(doc.pages[i]);
  const from = layouts.find((l) => l.part === p.layout);
  const l = layouts.find((x) => x.part.endsWith(`/${to}`))!;
  swapDeckLayout(p, from?.page, l.page, { ...layoutOfPage(l.page), id: l.part }, { ...assets, ...doc.assets });
  doc.pages = doc.pages.map((x, k) => (k === i ? p : x));
}

/** Every spTgt spid of a slide's p:timing names a shape of the slide. */
function dangling(slideXml: string): string[] {
  const ids = new Set([...slideXml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]));
  const timing = /<p:timing>[\s\S]*<\/p:timing>/.exec(slideXml)?.[0] ?? "";
  return [...timing.matchAll(/spid="(\d+)"/g)].map((m) => m[1]).filter((id) => !ids.has(id));
}

describe("QA: direct font size on a placeholder the layout places", () => {
  it("a title's font size changed by hand is saved (no layout change)", async () => {
    const { doc } = open(SURGEON);
    const p = doc.pages[0];
    const ti = p.nodes.findIndex((n) => n.type === "TEXT" && n.ph?.type === "ctrTitle");
    const t = p.nodes[ti] as TextNode;
    const before = runSizes(t);
    const big: TextNode = { ...t, paragraphs: t.paragraphs.map((q) => ({ ...q, runs: q.runs.map((r) => ({ ...r, fontSize: r.fontSize * 1.5 })) })) };
    doc.pages = doc.pages.map((x, k) => (k === 0 ? { ...x, nodes: x.nodes.map((n, j) => (j === ti ? big : n)) } : x));
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    const back = importPptx(r.bytes, "x.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT" && n.ph?.type === "ctrTitle")!;
    runSizes(back).forEach((s, k) => expect(s).toBeCloseTo(before[k] * 1.5, 0));
  });

  it("a body's font size changed by hand after a layout change is saved", async () => {
    const { doc, bytes } = open(SURGEON);
    move(doc, bytes, 1, "slideLayout4.xml");
    const p = doc.pages[1];
    const bi = p.nodes.findIndex((n) => n.type === "TEXT" && n.ph?.type === "body" && n.ph.idx === "1" && /First/.test(JSON.stringify(n.paragraphs)));
    const t = p.nodes[bi] as TextNode;
    const before = runSizes(t);
    const big: TextNode = { ...t, paragraphs: t.paragraphs.map((q) => ({ ...q, runs: q.runs.map((r) => ({ ...r, fontSize: r.fontSize * 2 })) })) };
    doc.pages = doc.pages.map((x, k) => (k === 1 ? { ...x, nodes: x.nodes.map((n, j) => (j === bi ? big : n)) } : x));
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    const back = importPptx(r.bytes, "x.pptx").pages[1].nodes.find((n): n is TextNode => n.type === "TEXT" && /First/.test(JSON.stringify(n.paragraphs)))!;
    runSizes(back).forEach((s, k) => expect(s).toBeCloseTo(before[k] * 2, 0));
  });
});

describe("QA: layout changes keep content, notes and animation targets", () => {
  for (const to of ["slideLayout4.xml", "slideLayout6.xml", "slideLayout7.xml", "slideLayout5.xml", "slideLayout1.xml"]) {
    it(`slide 2 → ${to}: every shape, its text, the notes, and every animation target are kept`, async () => {
      const { doc, bytes } = open(SURGEON);
      const a = files(bytes);
      move(doc, bytes, 1, to);
      const r = (await pptxSurgical(doc, doc.pages))!;
      expect(r).not.toBeNull();
      const z = files(r.bytes);
      const s2 = text(z, "ppt/slides/slide2.xml");
      expect(dangling(s2)).toEqual([]);
      // the original shapes (ids) are all there
      const ids = (x: string) => [...x.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      for (const id of ids(text(a, "ppt/slides/slide2.xml"))) expect(ids(s2)).toContain(id);
      // ids unique
      expect(new Set(ids(s2)).size).toBe(ids(s2).length);
      // the text and the notes
      for (const w of ["First", "Second", "Third"]) expect(s2).toContain(w);
      const rels = text(z, "ppt/slides/_rels/slide2.xml.rels");
      const notes = /Target="\.\.\/notesSlides\/([^"]+)"/.exec(rels)?.[1];
      expect(notes).toBeTruthy();
      const origNotes = /Target="\.\.\/notesSlides\/([^"]+)"/.exec(text(a, "ppt/slides/_rels/slide2.xml.rels"))![1];
      expect(text(z, `ppt/notesSlides/${notes}`)).toBe(text(a, `ppt/notesSlides/${origNotes}`));
      expect(importPptx(r.bytes, "x.pptx").pages[1].notes).toBe(importPptx(bytes, "x.pptx").pages[1].notes);
    });
  }

  it("moved twice (two content → title only → title and content) and back: text, ids and animations are kept", async () => {
    const { doc, bytes } = open(SURGEON);
    const a = files(bytes);
    const orig = doc.pages[1].layout!;
    move(doc, bytes, 1, "slideLayout4.xml");
    move(doc, bytes, 1, "slideLayout6.xml");
    move(doc, bytes, 1, orig.split("/").pop()!);
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    const z = files(r.bytes);
    const s2 = text(z, "ppt/slides/slide2.xml");
    expect(dangling(s2)).toEqual([]);
    expect(text(z, "ppt/slides/_rels/slide2.xml.rels")).toContain(`Target="../slideLayouts/${orig.split("/").pop()}"`);
    // the animations are all still there
    const anims = (x: string) => (/<p:timing>[\s\S]*<\/p:timing>/.exec(x)?.[0].match(/spid="/g) ?? []).length;
    expect(anims(s2)).toBe(anims(text(a, "ppt/slides/slide2.xml")));
    const back = importPptx(r.bytes, "x.pptx").pages[1];
    expect(back.layout).toBe(orig);
    const body = back.nodes.find((n): n is TextNode => n.type === "TEXT" && /First/.test(JSON.stringify(n.paragraphs)))!;
    expect(body.paragraphs.length).toBe(3);
  });

  it("undo: the page put back as it was saves the original slide byte for byte", async () => {
    const { doc, bytes } = open(SURGEON);
    const a = files(bytes);
    const was = doc.pages[1];
    move(doc, bytes, 1, "slideLayout6.xml");
    doc.pages = doc.pages.map((x, k) => (k === 1 ? was : x));
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(text(files(r.bytes), "ppt/slides/slide2.xml")).toBe(text(a, "ppt/slides/slide2.xml"));
  });
});

describe("QA: new slides from deck layouts — ids, rels, content types", () => {
  const fresh = (bytes: Uint8Array, part: string): Page => {
    const l = pptxLayoutSlides(bytes).layouts.find((x) => x.part.endsWith(`/${part}`))!;
    return { ...l.page, id: uid("pg"), name: "new", nodes: l.page.nodes.map((x) => copyNode(x, uid())), animations: [], layout: l.part };
  };
  function check(b: Uint8Array, n: number) {
    const z = files(b);
    const pres = text(z, "ppt/presentation.xml");
    const sld = [...pres.matchAll(/<p:sldId id="(\d+)" r:id="([^"]+)"/g)];
    expect(sld).toHaveLength(n);
    expect(new Set(sld.map((m) => m[1])).size).toBe(n);
    expect(sld.every((m) => Number(m[1]) >= 256 && Number(m[1]) < 2147483648)).toBe(true);
    const rels = text(z, "ppt/_rels/presentation.xml.rels");
    const relIds = [...rels.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(relIds).size).toBe(relIds.length);
    // master ids and slide ids do not collide (p:sldMasterId ids are above 2^31)
    const ct = text(z, "[Content_Types].xml");
    const slides = Object.keys(z).filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k));
    expect(slides).toHaveLength(n);
    for (const s of slides) expect(ct).toContain(`PartName="/${s}"`);
    // no override for a part that is not in the package
    for (const m of ct.matchAll(/PartName="\/([^"]+)"/g)) expect(z[m[1]], m[1]).toBeDefined();
    for (const m of sld) {
      const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${m[2]}"`).exec(rels)?.[1];
      expect(z[`ppt/${target}`]).toBeDefined();
    }
    // sections name only slides that exist
    const ids = new Set(sld.map((m) => m[1]));
    for (const m of pres.matchAll(/<p14:sldId id="(\d+)"/g)) expect(ids.has(m[1])).toBe(true);
  }

  it("three new slides, one original removed, one more added: unique ids, every part typed and linked", async () => {
    const { doc, bytes } = open(SURGEON);
    doc.pages = [doc.pages[0], fresh(bytes, "slideLayout5.xml"), fresh(bytes, "slideLayout2.xml"), ...doc.pages.slice(1)];
    doc.pages = doc.pages.filter((_, i) => i !== 3); // the original slide 2
    doc.pages.push(fresh(bytes, "slideLayout7.xml"));
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    check(r.bytes, doc.pages.length);
    // saved again after another new slide (the saved file as the original)
    const d2 = openBytes(r.bytes);
    d2.pages.splice(2, 0, fresh(r.bytes, "slideLayout6.xml"));
    const r2 = (await pptxSurgical(d2, d2.pages))!;
    expect(r2).not.toBeNull();
    check(r2.bytes, d2.pages.length);
  });
});

describe("QA: chart saves", () => {
  function chartDeck(bytes?: Uint8Array) {
    const b = bytes ?? new Uint8Array(readFileSync(FIDELITY));
    const doc = openBytes(b);
    const pi = doc.pages.findIndex((p) => p.nodes.some((n) => n.chart?.data));
    const head = doc.pages[pi].nodes.findIndex((n) => n.chart?.data);
    return { doc, bytes: b, pi, head, data: doc.pages[pi].nodes[head].chart!.data! };
  }
  const edit = (doc: OmwDocument, pi: number, head: number, data: Omit<SlideChart, "frame">) => {
    doc.pages = doc.pages.map((p, i) => (i === pi ? { ...p, nodes: replaceChart(p.nodes, head, data) } : p));
  };
  const BOOK = "ppt/embeddings/Microsoft_Excel_Worksheet.xlsx";

  it("values only: every other part of the deck byte for byte; caches = workbook cells", async () => {
    const { doc, bytes, pi, head, data } = chartDeck();
    const { frame: _f, ...d } = data;
    edit(doc, pi, head, { ...d, series: d.series.map((s, k) => ({ ...s, values: s.values.map((v) => v * 10 + k) })) });
    const r = (await pptxSurgical(doc, doc.pages))!;
    const z = files(r.bytes), a = files(bytes);
    for (const k of Object.keys(a)) if (k !== "ppt/charts/chart1.xml" && k !== BOOK) expect(z[k], k).toEqual(a[k]);
    expect(Object.keys(z).sort()).toEqual(Object.keys(a).sort());
    const xml = text(z, "ppt/charts/chart1.xml");
    const vals = [...xml.matchAll(/<c:val>[\s\S]*?<\/c:val>/g)].map((m) => [...m[0].matchAll(/<c:v>([^<]*)<\/c:v>/g)].map((x) => Number(x[1])));
    const grid = importXlsx(z[BOOK], "b.xlsx").pages[0].nodes.find((n) => n.type === "TABLE") as any;
    vals.forEach((col, k) => expect(col).toEqual(grid.rows.slice(1, 1 + col.length).map((row: any) => Number(row[k + 1].text))));
  });

  it("series added: c:idx and c:order unique; the existing series keep their own idx (automatic colours)", async () => {
    const { doc, bytes, pi, head, data } = chartDeck();
    const { frame: _f, ...d } = data;
    edit(doc, pi, head, { ...d, series: [...d.series, { name: "추가", values: [1, 2, 3, 4], color: null }, { name: "추가2", values: [4, 3, 2, 1], color: null }] });
    const r = (await pptxSurgical(doc, doc.pages))!;
    const xml = text(files(r.bytes), "ppt/charts/chart1.xml");
    const idx = [...xml.matchAll(/<c:ser><c:idx val="(\d+)"\/><c:order val="(\d+)"\/>/g)];
    expect(idx).toHaveLength(5);
    expect(new Set(idx.map((m) => m[1])).size).toBe(5);
    expect(new Set(idx.map((m) => m[2])).size).toBe(5);
    const orig = [...text(files(bytes), "ppt/charts/chart1.xml").matchAll(/<c:ser><c:idx val="(\d+)"\/><c:order val="(\d+)"\/>/g)];
    orig.forEach((m, k) => expect([idx[k][1], idx[k][2]]).toEqual([m[1], m[2]]));
    // c16:uniqueId not repeated
    const uids = [...xml.matchAll(/c16:uniqueId val="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(uids).size).toBe(uids.length);
  });

  it("original idx not 0..n-1 (a series deleted in PowerPoint): an edit keeps them", async () => {
    const b0 = new Uint8Array(readFileSync(FIDELITY));
    const z0 = files(b0);
    let x = text(z0, "ppt/charts/chart1.xml");
    // series 2 and 3 as idx / order 2 and 5 (gaps), as PowerPoint leaves them after deleting series
    let k = 0;
    x = x.replace(/<c:ser><c:idx val="(\d+)"\/><c:order val="(\d+)"\/>/g, (m) => (k++ === 0 ? m : `<c:ser><c:idx val="${k === 2 ? 2 : 5}"/><c:order val="${k === 2 ? 2 : 5}"/>`));
    z0["ppt/charts/chart1.xml"] = strToU8(x);
    const { doc, pi, head, data } = chartDeck(zipSync(z0));
    const { frame: _f, ...d } = data;
    edit(doc, pi, head, { ...d, series: [...d.series.map((s) => ({ ...s, values: s.values.map((v) => v + 1) })), { name: "추가", values: [1, 2, 3, 4], color: null }] });
    const r = (await pptxSurgical(doc, doc.pages))!;
    const xml = text(files(r.bytes), "ppt/charts/chart1.xml");
    const idx = [...xml.matchAll(/<c:ser><c:idx val="(\d+)"\/><c:order val="(\d+)"\/>/g)].map((m) => m[1]);
    expect(idx.slice(0, 3)).toEqual(["0", "2", "5"]);
    expect(Number(idx[3])).toBeGreaterThan(5);
  });

  function axesOk(xml: string) {
    const plot = /<c:plotArea>[\s\S]*<\/c:plotArea>/.exec(xml)![0];
    const groups = [...plot.matchAll(/<c:(bar|line|area)Chart>[\s\S]*?<\/c:\1Chart>/g)];
    const axes = [...plot.matchAll(/<c:(catAx|valAx|dateAx|serAx)>[\s\S]*?<\/c:\1>/g)].map((m) => ({ id: /<c:axId val="([^"]+)"/.exec(m[0])![1], cross: /<c:crossAx val="([^"]+)"/.exec(m[0])?.[1] }));
    const ids = new Set(axes.map((a) => a.id));
    for (const g of groups) {
      const used = [...g[0].matchAll(/<c:axId val="([^"]+)"\/>/g)].map((m) => m[1]);
      expect(used).toHaveLength(2);
      for (const u of used) expect(ids.has(u)).toBe(true);
    }
    for (const a of axes) expect(a.cross && ids.has(a.cross)).toBe(true);
    if (/<c:pieChart>/.test(plot)) {
      expect(axes).toHaveLength(0);
      expect(/<c:pieChart>[\s\S]*?<\/c:pieChart>/.exec(plot)![0]).not.toContain("<c:axId");
    }
  }

  it("type changed column → pie → column (saved and opened again between): axis ids pair up", async () => {
    let { doc, pi, head, data } = chartDeck();
    let { frame: _f, ...d } = data;
    edit(doc, pi, head, { ...d, kind: "pie" });
    const r1 = (await pptxSurgical(doc, doc.pages))!;
    axesOk(text(files(r1.bytes), "ppt/charts/chart1.xml"));
    for (const kind of ["col", "bar", "line"] as const) {
      ({ doc, pi, head, data } = chartDeck(r1.bytes));
      ({ frame: _f, ...d } = data);
      expect(d.kind).toBe("pie");
      edit(doc, pi, head, { ...d, kind });
      const r2 = (await pptxSurgical(doc, doc.pages))!;
      axesOk(text(files(r2.bytes), "ppt/charts/chart1.xml"));
      expect(importPptx(r2.bytes, "x.pptx").pages[pi].nodes.find((n) => n.chart?.data)!.chart!.data!.kind).toBe(kind);
    }
    for (const kind of ["line", "bar", "pie"] as const) {
      ({ doc, pi, head, data } = chartDeck());
      ({ frame: _f, ...d } = data);
      edit(doc, pi, head, { ...d, kind });
      axesOk(text(files((await pptxSurgical(doc, doc.pages))!.bytes), "ppt/charts/chart1.xml"));
    }
  });

  it("a series renamed (an Excel table's header): the workbook keeps its table and its other sheets", async () => {
    // the embedded workbook with a second sheet
    const b0 = new Uint8Array(readFileSync(FIDELITY));
    const z0 = files(b0);
    const wb = unzipSync(z0[BOOK]);
    wb["xl/worksheets/sheet2.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>다른 시트</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`);
    wb["xl/workbook.xml"] = strToU8(strFromU8(wb["xl/workbook.xml"]).replace(/(<sheet [^>]*\/>)(<\/sheets>)/, `$1<sheet name="Notes" sheetId="9" r:id="rIdQa2"/>$2`));
    wb["xl/_rels/workbook.xml.rels"] = strToU8(strFromU8(wb["xl/_rels/workbook.xml.rels"]).replace("</Relationships>", `<Relationship Id="rIdQa2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`));
    wb["[Content_Types].xml"] = strToU8(strFromU8(wb["[Content_Types].xml"]).replace("</Types>", `<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`));
    z0[BOOK] = zipSync(wb);
    const { doc, pi, head, data } = chartDeck(zipSync(z0));
    const { frame: _f, ...d } = data;
    edit(doc, pi, head, { ...d, series: d.series.map((s, k) => (k === 1 ? { ...s, name: "매출" } : s)) });
    const r = (await pptxSurgical(doc, doc.pages))!;
    const out = files(r.bytes)[BOOK];
    const read = importXlsx(out, "b.xlsx");
    const names = read.pages.flatMap((p) => p.nodes).filter((n) => n.type === "TABLE").map((n) => n.name);
    expect(names).toContain("Notes");
    const notes = read.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE" && n.name === "Notes") as any;
    expect(notes.rows[0].map((c: any) => c.text)).toEqual(["다른 시트", "42"]);
    const ow = unzipSync(out);
    // the Excel table stays, its column named as the header cell
    expect(Object.keys(ow)).toContain("xl/tables/table1.xml");
    expect(strFromU8(ow["xl/tables/table1.xml"])).toContain('name="매출"');
    const sheet1 = read.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE" && n.name !== "Notes") as any;
    expect(sheet1.rows[0][2].text).toBe("매출");
    // no warning that the workbook was written anew
    expect(r.warnings.join("\n")).not.toMatch(/새로|anew/i);
  });
});
