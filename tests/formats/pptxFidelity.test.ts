// PowerPoint fidelity of the PPTX import (docs/design/FIDELITY_PPTX.md), on the PowerPoint-made test deck
// qa/interop/adobe-made/omni-pptx-fidelity.pptx (qa/interop/scripts/pptx_fidelity_make.ps1). The numbers checked here
// are the ones PowerPoint's own PDF of the deck shows (omni-pptx-fidelity.pptx.ref.pdf).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync, writeFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { newDocument, type MediaNode, type SceneNode, type TableNode, type TextNode, type VectorNode } from "../../src/core/types";
import { makeAsset } from "../../src/core/assets";
import { pptxMeta, pptxUnchanged } from "../../src/io/officesurgeon/pptx";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { parseXml } from "../../src/io/xml";
import { resolveFace, slideAscentOf, splitScripts, themeFontsOf } from "../../src/io/formats/pptxText";
import { layoutText } from "../../src/core/text";
import { newText } from "../../src/core/types";
import { presetContours } from "../../src/io/formats/pptxGeom";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const DECK = "qa/interop/adobe-made/omni-pptx-fidelity.pptx";
const deck = () => importPptx(new Uint8Array(readFileSync(DECK)), "omni-pptx-fidelity.pptx");
const texts = (nodes: SceneNode[]) => nodes.filter((n): n is TextNode => n.type === "TEXT");
const plain = (t: TextNode) => t.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const PT = 96 / 72;

describe("PPTX: what PowerPoint shows", () => {
  it("placeholders without their own position take the master's (layouts that inherit too), in the theme fonts", () => {
    const { pages, skipped } = deck();
    expect(pages).toHaveLength(10);
    expect(Object.keys(skipped).join()).not.toMatch(/위치|position/i);
    // slide 2: the title placeholder has no xfrm on the slide or the layout — the master's (x 0.69 in) is used
    const title = texts(pages[1].nodes).find((t) => plain(t).startsWith("글머리표"))!;
    expect(title).toBeDefined();
    expect(title.transform.x).toBeCloseTo(628650 / 9525 + 9.6, 0);
    // +mj-lt in a Korean Office theme = 맑은 고딕, size from the master's titleStyle (33 pt)
    expect(title.paragraphs[0].runs[0].fontFamily).toBe("맑은 고딕");
    expect(title.paragraphs[0].runs[0].fontSize).toBeCloseTo(33 * PT, 1);
  });

  it("body text inherits bullets, sizes and indents per level from the master's bodyStyle", () => {
    const body = texts(deck().pages[1].nodes).find((t) => plain(t).includes("첫째 수준"))!;
    const [p1, p2, p3] = body.paragraphs;
    expect(p1.list).toBeDefined();
    expect(p1.runs[0].text.startsWith("•")).toBe(true);
    expect([p1, p2, p3].map((p) => Math.round(p.runs.at(-1)!.fontSize / PT))).toEqual([21, 18, 15]);
    // marL / indent (EMU) of lvl1 / lvl2: 171450 / 514350, hanging 171450
    expect(p1.indentLeft).toBeCloseTo(171450 / 9525, 1);
    expect(p2.indentLeft).toBeCloseTo(514350 / 9525, 1);
    expect(p1.indent).toBeCloseTo(-171450 / 9525, 1);
    // lnSpc 90 % (× 1.2), no space before the first paragraph, 7.5 pt before the others at level 1 — placed in whole
    // points as PowerPoint does (8 pt)
    expect(p1.lineSpacing).toBeCloseTo(1.08, 3);
    expect(p1.spaceBefore).toBeUndefined();
    expect(body.paragraphs[3].spaceBefore).toBeCloseTo(8 * PT, 2);
    // PowerPoint's baseline in the line: 맑은 고딕's ascent
    expect(p1.slideAscent).toBeCloseTo(0.982, 3);
    // Hangul wraps between syllables, as PowerPoint does
    expect(body.wordBreak).toBe("normal");
  });

  it("PowerPoint's baseline in a line: reduced spacing comes off above the text, more puts it at 3/4 (pptx_lines_make.ps1)", () => {
    // first baselines PowerPoint's PDF has for 21 pt 맑은 고딕 (box top 0, no insets): 90 % 18.12, 100 % 20.64, 150 % 28.40
    const base = (font: string, pt: number, pct: number) => {
      const n = newText("가Ag");
      const run = { ...n.paragraphs[0].runs[0], fontFamily: font, fontSize: pt * PT, text: "가Ag" };
      n.paragraphs = [{ ...n.paragraphs[0], runs: [run], lineSpacing: pct * 1.2, slideAscent: slideAscentOf(font) }];
      const l = layoutText(n).lines[0];
      return (l.y + l.baseline) / PT;
    };
    // (within 0.1 pt of the PDF)
    expect(Math.abs(base("맑은 고딕", 21, 0.9) - 18.12)).toBeLessThan(0.1);
    expect(Math.abs(base("맑은 고딕", 21, 1) - 20.64)).toBeLessThan(0.1);
    expect(Math.abs(base("맑은 고딕", 21, 1.5) - 28.4)).toBeLessThan(0.1);
    // the deck: slide 2's first body line, PowerPoint's PDF baseline 129.6 pt from the slide top
    const body = texts(deck().pages[1].nodes).find((t) => plain(t).includes("첫째 수준"))!;
    const l = layoutText(body).lines[0];
    expect(Math.abs((body.transform.y + l.y + l.baseline) / PT - 129.6)).toBeLessThan(0.25);
  });

  it("table cells are laid out from their paragraphs inside PowerPoint's cell margins", () => {
    const t = deck().pages[5].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    expect(t.cellBox).toMatchObject({ padX: 91440 / 9525, padY: 45720 / 9525 });
    expect(t.rows[1][0].richText?.[0].runs.map((r) => r.text).join("")).toBe(t.rows[1][0].text);
  });

  it("star5 as presetShapeDefinitions draws it: its points touch the box (hf / vf)", () => {
    const [c] = presetContours("star5", 100, 100)!;
    const ys = c.nodes.map((p) => p.anchor[1]), xs = c.nodes.map((p) => p.anchor[0]);
    expect(Math.min(...ys)).toBeCloseTo(0, 3);
    expect(Math.min(...xs)).toBeCloseTo(0, 0);
    expect(Math.max(...xs)).toBeCloseTo(100, 0);
    expect(Math.max(...ys)).toBeCloseTo(100, 0);
  });

  it("normAutofit: the scaled size rounded to a whole point, line spacing reduced by its share", () => {
    const body = texts(deck().pages[3].nodes).find((t) => plain(t).includes("Shrink"))!;
    // 21 pt × 77.5 % → 16 pt; 90 % − 20 % = 70 % → × 1.2 (PowerPoint's PDF: 21.44 pt between lines = 0.84 × 16 + 8)
    expect(body.paragraphs[0].runs[0].fontSize).toBeCloseTo(16 * PT, 1);
    expect(body.paragraphs[0].lineSpacing).toBeCloseTo(0.84, 3);
  });

  it("a:latin / a:ea: Latin letters in the Latin font, Hangul in the East Asian one (Windows names as written)", () => {
    const box = texts(deck().pages[4].nodes).find((t) => plain(t).startsWith("Arial"))!;
    const runs = box.paragraphs[0].runs;
    expect(runs.find((r) => r.text.includes("Arial"))!.fontFamily).toBe("Arial");
    expect(runs.find((r) => /라틴/.test(r.text))!.fontFamily).toBe("바탕");
    expect(splitScripts("Omni 오메 2026", "Arial", "바탕")).toEqual([
      { text: "Omni ", font: "Arial" },
      { text: "오메 ", font: "바탕" },
      { text: "2026", font: "Arial" },
    ]);
  });

  it("theme fonts: +mn-ea with an empty a:ea uses the theme's script font for the language", () => {
    const theme = parseXml(
      `<a:theme xmlns:a="a"><a:themeElements><a:fontScheme><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:font script="Hang" typeface="맑은 고딕"/><a:font script="Jpan" typeface="游ゴシック Light"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:font script="Hang" typeface="맑은 고딕"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`,
    );
    const f = themeFontsOf(theme);
    expect(resolveFace("+mj-lt", f, {})).toBe("Calibri Light");
    expect(resolveFace("+mj-ea", f, { lang: "ko-KR" })).toBe("맑은 고딕");
    expect(resolveFace("+mj-ea", f, { lang: "en-US", altLang: "ja-JP" })).toBe("游ゴシック Light");
    expect(resolveFace("+mn-ea", f, {})).toBe("맑은 고딕");
    expect(resolveFace("Arial", f, {})).toBe("Arial");
  });

  it("table style: header fill, banded rows (tint in linear RGB, as PowerPoint), header text white and bold", () => {
    const t = deck().pages[5].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    expect(t.rows[0][0].fill).toBe("#4472c4");
    expect(t.rows[0][0].bold).toBe(true);
    expect(t.rows[0][0].color).toBe("#ffffff");
    expect(t.rows[1][0].fill).toBe("#cfd5ea"); // accent1 tint 40 %
    expect(t.rows[2][0].fill).toBe("#e9ebf5"); // accent1 tint 20 %
  });

  it("preset shapes and groups: real outlines, a rotated group turns its members about its centre", () => {
    const nodes = deck().pages[6].nodes.filter((n): n is VectorNode => n.type === "VECTOR");
    const star = nodes.find((n) => n.contours[0]?.nodes.length === 10);
    expect(star).toBeDefined();
    expect(nodes.filter((n) => n.transform.rotation && Math.abs(n.transform.rotation - 15) < 0.01).length).toBe(2);
    for (const p of ["roundRect", "triangle", "rightArrow", "chevron", "heart", "hexagon", "star5"]) expect(presetContours(p, 100, 60)).not.toBeNull();
  });

  it("pictures: a:srcRect crops without losing pixels; a picture cropped to an ellipse is clipped by one", () => {
    const nodes = deck().pages[7].nodes;
    const imgs = nodes.filter((n) => n.type === "IMAGE");
    expect(imgs.some((n) => n.type === "IMAGE" && n.crop && n.crop.x > 0 && n.crop.y > 0)).toBe(true);
    expect(imgs.some((n) => n.clip)).toBe(true);
  });

  it("SmartArt from its drawing part, a chart from its cached values", () => {
    const nodes = deck().pages[8].nodes;
    const all = texts(nodes).map(plain);
    for (const s of ["계획 Plan", "실행 Do", "확인 Check", "조치 Act", "반복"]) expect(all).toContain(s);
    // the default column chart: 4 categories × 3 series
    const bars = nodes.filter((n) => n.type === "VECTOR" && / 계열 \d$|Series \d$/.test(n.name));
    expect(bars.length).toBe(12);
  });

  it("video and audio: the clip, its poster / icon where PowerPoint draws them, trims, loop, click-to-play", () => {
    const { pages, assets } = importPptx(new Uint8Array(readFileSync("qa/interop/adobe-made/omni-pptx-media.pptx")), "omni-pptx-media.pptx");
    const clips = pages.map((p) => p.nodes.find((n): n is MediaNode => n.type === "MEDIA")!);
    const [video, audio, auto] = clips;
    expect(video.media).toBe("video");
    expect(assets[video.assetId].mime).toBe("video/x-msvideo");
    expect(video.posterAssetId).toBeTruthy();
    // where PowerPoint placed it (its a:xfrm; PowerPoint fits an inserted clip to the clip's own aspect ratio)
    const s1 = strFromU8(unzipSync(new Uint8Array(readFileSync("qa/interop/adobe-made/omni-pptx-media.pptx")))["ppt/slides/slide1.xml"]);
    const [, ox, , cx] = /<p:pic>.*?<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)"/.exec(s1)!.map(Number);
    expect(video.transform.x).toBeCloseTo(ox / 9525, 1);
    expect(video.width).toBeCloseTo(cx / 9525, 1);
    expect(video.trimStart).toBeCloseTo(0.3, 3);
    expect(video.loop).toBe(true);
    // PowerPoint's "in click sequence" / "when clicked on": not started with the slide
    expect(video.autoplay).toBe(false);
    expect(audio.media).toBe("audio");
    expect(assets[audio.assetId].mime).toBe("audio/wav");
    expect(audio.posterAssetId).toBeTruthy(); // the speaker icon
    // 1 s clip with 300 ms cut from its end: played 0 - 0.7 s
    expect(auto.trimEnd).toBeCloseTo(0.7, 3);
  });

  it("clips are written as PowerPoint embeds them (media part, p14:media, poster, p:timing) and read back the same", async () => {
    const { pages, assets } = importPptx(new Uint8Array(readFileSync("qa/interop/adobe-made/omni-pptx-media.pptx")), "omni-pptx-media.pptx");
    // the editor's own insert: a clip started with the slide, looped
    const third = pages[2].nodes.find((n): n is MediaNode => n.type === "MEDIA")!;
    third.autoplay = true;
    const doc = newDocument("t");
    doc.pages = pages;
    doc.assets = assets;
    const { bytes } = await exportPptx(doc, pages);
    const files = unzipSync(bytes);
    expect(Object.keys(files).some((f) => /^ppt\/media\/media\d+\.avi$/.test(f))).toBe(true);
    expect(strFromU8(files["[Content_Types].xml"])).toContain('Extension="avi" ContentType="video/x-msvideo"');
    const s1 = strFromU8(files["ppt/slides/slide1.xml"]);
    expect(s1).toMatch(/<a:videoFile r:link="rId\d+"\/>.*<p14:media [^>]*r:embed="rId\d+"><p14:trim st="300"\/>/);
    expect(s1).toMatch(/<p:timing>.*repeatCount="indefinite"/);
    expect(strFromU8(files["ppt/slides/slide3.xml"])).toMatch(/nodeType="mainSeq".*nodeType="afterEffect".*playFrom\(0\.0\)/);
    if (process.env.OMNIWEAVE_PPTX_MEDIA_OUT) writeFileSync(process.env.OMNIWEAVE_PPTX_MEDIA_OUT, bytes);
    const back = importPptx(bytes, "m.pptx").pages.map((p) => p.nodes.find((n): n is MediaNode => n.type === "MEDIA")!);
    expect(back.map((m) => m?.media)).toEqual(["video", "audio", "audio"]);
    expect(back[0].trimStart).toBeCloseTo(0.3, 3);
    expect(back[0].loop).toBe(true);
    expect(back[0].autoplay).toBe(false);
    expect(back[2].autoplay).toBe(true);
    expect(back[2].trimEnd).toBeCloseTo(0.7, 3);
  });

  it("a deck saved without changes is the original file byte for byte; any change writes it anew", () => {
    const bytes = new Uint8Array(readFileSync(DECK));
    const { pages, slideParts } = deck();
    const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "d.pptx");
    pages[0].source!.office = pptxMeta(pages, slideParts, asset);
    expect(slideParts[0]).toBe("ppt/slides/slide1.xml");
    const same = pptxUnchanged(pages)!;
    expect(same).not.toBeNull();
    expect(same.length).toBe(bytes.length);
    expect(same.every((b, i) => b === bytes[i])).toBe(true);
    // one slide's text changed: not the original any more
    const t = texts(pages[2].nodes)[0];
    t.paragraphs[0].runs[0] = { ...t.paragraphs[0].runs[0], text: t.paragraphs[0].runs[0].text + "~" };
    expect(pptxUnchanged(pages)).toBeNull();
    // a slide removed or reordered: anew too
    const fresh = deck();
    fresh.pages[0].source!.office = pptxMeta(fresh.pages, fresh.slideParts, asset);
    expect(pptxUnchanged(fresh.pages.slice(0, 9))).toBeNull();
    expect(pptxUnchanged([fresh.pages[0], fresh.pages[2], fresh.pages[1], ...fresh.pages.slice(3)])).toBeNull();
  });

  it("export of the imported deck is a package PowerPoint opens (parts and content types agree)", async () => {
    const { pages, assets } = deck();
    const doc = newDocument("t");
    doc.pages = pages;
    doc.assets = assets;
    const { bytes } = await exportPptx(doc, pages);
    const files = unzipSync(bytes);
    const ct = strFromU8(files["[Content_Types].xml"]);
    for (const name of Object.keys(files)) if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) expect(ct).toContain(`/${name}`);
    for (const name of Object.keys(files)) if (/\.xml$/.test(name)) expect(() => new DOMParser({ errorHandler: { error: (e: string) => { throw new Error(e); }, fatalError: (e: string) => { throw new Error(e); } } }).parseFromString(strFromU8(files[name]), "application/xml")).not.toThrow();
    if (process.env.OMNIWEAVE_PPTX_OUT) writeFileSync(process.env.OMNIWEAVE_PPTX_OUT, bytes);
  });
});
