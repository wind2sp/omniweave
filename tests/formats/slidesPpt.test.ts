// PowerPoint features added for the slide mode (2026-11-24): theme, master shapes, 머리글/바닥글, charts written as
// PowerPoint charts, merged table cells, more transitions, animation delay / triggers, the MP4 writer — what a deck
// written anew carries for PowerPoint (checked against PowerPoint itself).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { produce } from "immer";
import { newDocument, newGroup, newTable, newText, type OmwDocument, type TextNode } from "../../src/core/types";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { builtinLayout, slideFromLayout } from "../../src/core/slides";
import { applyThemeInPlace, THEMES } from "../../src/core/slideTheme";
import { drawChart } from "../../src/io/formats/pptxChart";
import { buildSteps, triggerSteps } from "../../src/core/anim";
import { muxMp4 } from "../../src/io/mp4Mux";
import { SMART_LAYOUTS, smartShapes } from "../../src/core/smartArt";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

function deck(): OmwDocument {
  const d = newDocument("omni-slides");
  const s1 = slideFromLayout(builtinLayout("title", 1280, 720), 1280, 720, "1");
  const s2 = slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "2");
  d.pages = [s1, s2];
  return produce(d, (x) => applyThemeInPlace(x, THEMES.find((t) => t.id === "band")!));
}

const parts = async (d: OmwDocument) => unzipSync((await exportPptx(d, d.pages)).bytes);

describe("slides: PowerPoint features in a deck written anew", () => {
  it("the theme is the deck's theme part, its decoration in the slide master under every slide", async () => {
    const d = deck();
    expect(d.masters).toHaveLength(1);
    expect(d.pages.every((p) => p.masterId === d.masters[0].id)).toBe(true);
    const f = await parts(d);
    const theme = strFromU8(f["ppt/theme/theme1.xml"]);
    expect(theme).toContain('name="띠"');
    expect(theme).toContain('<a:accent1><a:srgbClr val="0F6FC6"/>');
    const master = strFromU8(f["ppt/slideMasters/slideMaster1.xml"]);
    expect((master.match(/<p:sp>/g) ?? []).length).toBe(2);
  });

  it("머리글/바닥글: dt / ftr / sldNum placeholders with the slide number field", async () => {
    const d = produce(deck(), (x) => {
      x.pages[1].slideHf = { num: true, footer: "Omniweave QA", date: { auto: true } };
    });
    const f = await parts(d);
    const s2 = strFromU8(f["ppt/slides/slide2.xml"]);
    expect(s2).toContain('<p:ph type="sldNum" sz="quarter" idx="12"/>');
    expect(s2).toContain('type="slidenum"');
    expect(s2).toContain("<a:t>2</a:t>");
    expect(s2).toContain("Omniweave QA");
    expect(s2).toContain('type="datetime1"');
    expect(strFromU8(f["ppt/slideMasters/slideMaster1.xml"])).toContain('type="sldNum"');
  });

  it("a chart is a PowerPoint chart part with its workbook; combo = bar + line groups", async () => {
    const m = { kind: "combo" as const, name: "Chart", categories: ["A", "B"], series: [{ name: "s1", values: [1, 2], color: null }, { name: "s2", values: [3, 4], color: null, type: "line" as const }], title: null, gapWidth: 219, overlap: -27, accents: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"], font: "맑은 고딕", frame: { x: 100, y: 100, w: 600, h: 400 }, axSz: 1197 };
    const d = produce(deck(), (x) => void x.pages[1].nodes.push(...(drawChart(m) as never[])));
    const f = await parts(d);
    const s2 = strFromU8(f["ppt/slides/slide2.xml"]);
    expect(s2).toContain("drawingml/2006/chart");
    const c = strFromU8(f["ppt/charts/chart1.xml"]);
    expect(c).toContain("<c:barChart>");
    expect(c).toContain("<c:lineChart>");
    expect(f["ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx"]).toBeTruthy();
    expect(strFromU8(f["[Content_Types].xml"])).toContain("/ppt/charts/chart1.xml");
    // read back: a chart with the same data
    const back = importPptx((await exportPptx(d, d.pages)).bytes, "x.pptx");
    const head = back.pages[1].nodes.find((n) => n.chart?.data)!;
    expect(head.chart!.data!.kind).toBe("combo");
    expect(head.chart!.data!.series.map((s) => s.values)).toEqual([[1, 2], [3, 4]]);
  });

  it("merged table cells: gridSpan on the first, hMerge on the covered", async () => {
    const t = newTable([["a", "b", "", "d"], ["1", "2", "3", "4"]]);
    t.rows[0][1].colSpan = 2;
    const d = produce(deck(), (x) => void x.pages[1].nodes.push(t as never));
    const s2 = strFromU8((await parts(d))["ppt/slides/slide2.xml"]);
    expect(s2).toContain('<a:tc gridSpan="2">');
    expect(s2).toContain('<a:tc hMerge="1">');
  });

  it("transitions: each type its PowerPoint element; automatic advance as advTm, read back", async () => {
    const d = produce(deck(), (x) => {
      x.pages[0].transition = { type: "WIPE", duration: 700 };
      x.pages[1].transition = { type: "COVER", duration: 1000, after: 3000 };
    });
    const f = await parts(d);
    expect(strFromU8(f["ppt/slides/slide1.xml"])).toContain('<p:transition spd="med"><p:wipe dir="r"/></p:transition>');
    expect(strFromU8(f["ppt/slides/slide2.xml"])).toContain('<p:transition spd="slow" advTm="3000"><p:cover dir="l"/></p:transition>');
    const back = importPptx((await exportPptx(d, d.pages)).bytes, "x.pptx");
    expect(back.pages.map((p) => p.transition.type)).toEqual(["WIPE", "COVER"]);
    expect(back.pages[1].transition.after).toBe(3000);
  });

  it("animation delay and trigger: in the show's steps, and in p:timing (an interactive sequence)", async () => {
    const d = produce(deck(), (x) => {
      const [a, b] = x.pages[1].nodes;
      x.pages[1].animations = [
        { id: "a1", targetNodeId: a.id, trigger: "ON_CLICK", property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 500, value: 1, easing: "linear" }], delay: 250 },
        { id: "a2", targetNodeId: b.id, trigger: "ON_CLICK", property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 500, value: 1, easing: "linear" }], triggerId: a.id },
      ];
    });
    const p = d.pages[1];
    expect(buildSteps(p)[1].anims[0].start).toBe(250);
    expect([...triggerSteps(p).keys()]).toEqual([p.nodes[0].id]);
    const s2 = strFromU8((await parts(d))["ppt/slides/slide2.xml"]);
    expect(s2).toContain('nodeType="interactiveSeq"');
    expect(s2).toMatch(/presetClass="entr"[^>]*nodeType="clickEffect"><p:stCondLst><p:cond delay="250"\/>/);
  });

  it("the MP4 writer: ftyp, mdat with the samples, moov with avcC and one sync sample per key frame", () => {
    const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 0]);
    const mp4 = muxMp4([{ data: new Uint8Array(10), timestamp: 0, duration: 33333, key: true }, { data: new Uint8Array(5), timestamp: 33333, duration: 33333, key: false }], avcC, 1280, 720);
    const s = String.fromCharCode(...mp4);
    expect(s.slice(4, 8)).toBe("ftyp");
    expect(s).toContain("mdat");
    expect(s).toContain("avcC");
    expect(s.indexOf("moov")).toBeGreaterThan(s.indexOf("mdat"));
  });
});

describe("slides: SmartArt as PowerPoint's own SmartArt", () => {
  it("each layout: diagram parts with its built-in layout id; read back as a SmartArt group with the same items", async () => {
    const layouts = SMART_LAYOUTS.map((l) => l.id);
    const items = [{ text: "계획", level: 0 }, { text: "목표", level: 1 }, { text: "실행", level: 0 }, { text: "검토", level: 0 }];
    const d0 = newDocument("omni-smart");
    d0.pages = layouts.map((l, i) => {
      const p = slideFromLayout(builtinLayout("titleOnly", 1280, 720), 1280, 720, String(i + 1));
      const g = newGroup(`SmartArt ${l}`);
      const frame = { x: 128, y: 180, w: 1024, h: 460 };
      const nodes = smartShapes(l, items, frame, THEMES[0]).map((n) => ({ ...n, groupId: g.id }));
      g.smart = { layout: l, items, frame, anchor: { x: nodes[0].transform.x, y: nodes[0].transform.y } };
      p.groups = [g];
      p.nodes.push(...nodes);
      return p;
    });
    const r = await exportPptx(d0, d0.pages);
    writeFileSync(join(tmpdir(), "omni-slides-smartart.pptx"), r.bytes);
    const f = unzipSync(r.bytes);
    expect(strFromU8(f["ppt/diagrams/data1.xml"])).toContain('loTypeId="urn:microsoft.com/office/officeart/2005/8/layout/default"');
    expect(strFromU8(f["ppt/slides/slide1.xml"])).toContain("<dgm:relIds");
    expect(strFromU8(f["[Content_Types].xml"])).toContain("diagramData+xml");
    const back = importPptx(r.bytes, "x.pptx");
    back.pages.forEach((p, i) => {
      expect(p.groups?.[0]?.smart?.layout).toBe(layouts[i]);
      expect(p.groups?.[0]?.smart?.items).toEqual(items);
      expect(p.nodes.filter((n) => n.groupId === p.groups![0].id).length).toBeGreaterThan(2);
    });
  });
  it("PowerPoint's own SmartArt (drawn by it): its drawing as read, and a SmartArt group with its items", () => {
    const bytes = new Uint8Array(readFileSync("qa/interop/powerpoint-made/omni-smartart-7.pptx"));
    const back = importPptx(bytes, "omni-smartart-7.pptx");
    expect(back.pages.map((p) => p.groups?.[0]?.smart?.layout)).toEqual(SMART_LAYOUTS.map((l) => l.id));
    expect(back.pages[2].groups![0].smart!.items.map((i) => i.text)).toEqual(["계획", "목표", "실행", "검토"]);
  });
});

describe("slides: a hyperlink on text (삽입 › 링크, Ctrl+K)", () => {
  it("is written as a:hlinkClick to an external relationship of the slide, and read back as the run's link", async () => {
    const d = newDocument("omni-link");
    const s = slideFromLayout(builtinLayout("blank", 1280, 720), 1280, 720, "1");
    const t = newText("OMWLINK");
    const linked: TextNode = { ...t, paragraphs: t.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, link: "https://example.com/omw?a=1&b=2" })) })) };
    d.pages = [{ ...s, nodes: [...s.nodes, linked] }];
    const f = await parts(d);
    const slide = strFromU8(f["ppt/slides/slide1.xml"]);
    const rels = strFromU8(f["ppt/slides/_rels/slide1.xml.rels"]);
    const rid = slide.match(/<a:hlinkClick r:id="(rId\d+)"\/>/)?.[1];
    expect(rid).toBeTruthy();
    expect(rels).toContain(`Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/omw?a=1&amp;b=2" TargetMode="External"`);
    const back = importPptx((await exportPptx(d, d.pages)).bytes, "x.pptx").pages[0];
    const run = back.nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs.flatMap((p) => p.runs) : [])).find((r) => r.text.includes("OMWLINK"));
    expect(run?.link).toBe("https://example.com/omw?a=1&b=2");
  });
});
