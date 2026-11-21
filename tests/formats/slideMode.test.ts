// Slide mode structure (core/slides.ts, docs/design/SLIDE_MODE.md): layouts and placeholders, autofit and anchor, and
// the PPTX round trip of placeholders, hidden slides, sections and speaker notes — written anew and into the original.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { makeAsset } from "../../src/core/assets";
import { newDocument, type OmwDocument, type TextNode } from "../../src/core/types";
import { applyLayoutInPlace, builtinLayout, isEmptyPh, phBox, sectionsOf, settleSlides, showSlides, slideFromLayout } from "../../src/core/slides";
import { exportPptx, importPptx, pptxLayoutSlides } from "../../src/io/formats/pptx";
import { attachPptxMeta, pptxSurgical, pptxUnchanged } from "../../src/io/officesurgeon/pptx";
import { layoutText } from "../../src/core/text";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const DECK = "qa/interop/adobe-made/omni-pptx-surgeon.pptx";
const text = (b: Uint8Array, n: string) => strFromU8(unzipSync(b)[n]);
const typed = (n: TextNode, s: string): TextNode => ({ ...n, paragraphs: n.paragraphs.map((p, i) => (i ? p : { ...p, runs: [{ ...p.runs[p.runs.length - 1], text: s }] })) });

function open(): OmwDocument {
  const bytes = new Uint8Array(readFileSync(DECK));
  const r = importPptx(bytes, "deck.pptx");
  const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.presentationml.presentation", "deck.pptx");
  attachPptxMeta(r.pages, r.slideParts, r.slideEls, asset, r.assets);
  const doc = newDocument("deck");
  doc.pages = r.pages;
  doc.assets = { ...r.assets, [asset.id]: asset };
  return doc;
}

describe("layouts and placeholders", () => {
  it("a slide from 'title and content' has an empty title and a bulleted text placeholder", () => {
    const p = slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "s");
    expect(p.layout).toBe("titleContent");
    const [title, body] = p.nodes as TextNode[];
    expect(title.ph?.type).toBe("title");
    expect(body.ph?.type).toBe("body");
    expect(isEmptyPh(title) && isEmptyPh(body)).toBe(true);
    expect(body.paragraphs[0].list?.def).toBe("bullet");
    // the title is centred in its box: the box is where the layout put it
    expect(phBox(title)!.y).toBeCloseTo(0.0532 * 720, 0);
    expect(title.ph!.dy).toBeGreaterThan(0);
  });

  it("the placeholder prompts never reach an export or a saved file (canvas only)", async () => {
    const { DICTS } = await import("../../src/i18n");
    const { exportSvg } = await import("../../src/io/export");
    const doc = newDocument("d");
    doc.pages = [slideFromLayout(builtinLayout("title", 1280, 720), 1280, 720, "s1"), slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "s2")];
    const prompts = Object.values(DICTS).flatMap((d) => ["slide.ph.title", "slide.ph.subtitle", "slide.ph.text", "slide.notes.prompt"].map((k) => d[k]));
    const svg = await exportSvg(doc, doc.pages[1]);
    const { bytes } = await exportPptx(doc, doc.pages);
    // slides and notes pages carry no prompt (a layout's own placeholders hold the sample text, as layouts do)
    const parts = Object.entries(unzipSync(bytes))
      .filter(([n]) => /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(n))
      .map(([, u]) => strFromU8(u));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of prompts) {
      expect(svg.includes(p), p).toBe(false);
      expect(parts.some((x) => x.includes(p)), p).toBe(false);
    }
    // the empty placeholders themselves are kept (read back as empty placeholders)
    const back = importPptx(bytes, "d.pptx").pages;
    expect(back.map((pg) => pg.nodes.filter((n) => isEmptyPh(n)).length)).toEqual([2, 2]);
  });

  it("change layout keeps the text in the matching placeholders, drops empty ones, adds missing ones", () => {
    const p = slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "s");
    p.nodes[0] = typed(p.nodes[0] as TextNode, "Hello");
    applyLayoutInPlace(p, builtinLayout("twoContent", 1280, 720));
    expect(p.layout).toBe("twoContent");
    const phs = p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.ph);
    expect(phs.map((n) => n.ph!.idx ?? "")).toEqual(["", "1", "2"]);
    expect(phs[0].paragraphs[0].runs.map((r) => r.text).join("")).toContain("Hello");
    applyLayoutInPlace(p, builtinLayout("blank", 1280, 720));
    // the title has text: it stays; the empty text placeholders go
    expect(p.nodes.length).toBe(1);
  });

  it("autofit shrinks text that overflows its box and grows it back when it fits again", () => {
    const doc = newDocument("d");
    const p = slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "s");
    doc.pages = [p];
    const body = p.nodes[1] as TextNode;
    const long = { ...body, paragraphs: Array.from({ length: 14 }, (_, i) => ({ ...body.paragraphs[0], id: `p${i}`, runs: [{ ...body.paragraphs[0].runs[0], text: `Line ${i} of a long list` }] })) };
    const d2: OmwDocument = { ...doc, pages: [{ ...p, nodes: [p.nodes[0], long] }] };
    const fitted = settleSlides(d2, doc).pages[0].nodes[1] as TextNode;
    expect(fitted.ph!.fit).toBeLessThan(1);
    expect(layoutText(fitted).height).toBeLessThanOrEqual(fitted.ph!.h + 1);
    const short = { ...fitted, paragraphs: fitted.paragraphs.slice(0, 2) };
    const d3: OmwDocument = { ...d2, pages: [{ ...d2.pages[0], nodes: [p.nodes[0], short] }] };
    const back = settleSlides(d3, d2).pages[0].nodes[1] as TextNode;
    expect(back.ph!.fit).toBeUndefined();
    expect(back.paragraphs[0].runs[0].fontSize).toBeCloseTo(body.paragraphs[0].runs[0].fontSize, 3);
  });

  it("the show skips hidden slides unless it starts on one; sections group the list", () => {
    const a = slideFromLayout(builtinLayout("title", 1280, 720), 1280, 720, "a");
    const b = { ...slideFromLayout(builtinLayout("blank", 1280, 720), 1280, 720, "b"), hidden: true as const };
    const c = { ...slideFromLayout(builtinLayout("blank", 1280, 720), 1280, 720, "c"), section: "Part 2" };
    expect(showSlides([a, b, c]).map((p) => p.name)).toEqual(["a", "c"]);
    expect(showSlides([a, b, c], b.id).map((p) => p.name)).toEqual(["a", "b", "c"]);
    expect(sectionsOf([a, b, c]).map((s) => [s.name, s.pages.length])).toEqual([[null, 2], ["Part 2", 1]]);
  });
});

describe("PPTX: placeholders, hidden, sections, notes", () => {
  it("written anew: real layouts with placeholders, p:ph on the slide, notes pages, show=0, sections — and read back", async () => {
    const doc = newDocument("d");
    const s1 = slideFromLayout(builtinLayout("title", 1280, 720), 1280, 720, "1");
    s1.nodes[0] = typed(s1.nodes[0] as TextNode, "Deck title");
    s1.notes = "Say hello\nThen go on";
    const s2 = { ...slideFromLayout(builtinLayout("titleContent", 1280, 720), 1280, 720, "2"), hidden: true as const, section: "Body" };
    doc.pages = [s1, s2];
    const { bytes } = await exportPptx(doc, doc.pages);
    const f = unzipSync(bytes);
    expect(Object.keys(f).filter((n) => /slideLayouts\/slideLayout\d+\.xml$/.test(n)).length).toBe(3);
    expect(text(bytes, "ppt/slides/slide1.xml")).toContain('<p:ph type="ctrTitle"/>');
    expect(text(bytes, "ppt/slides/slide2.xml")).toContain('show="0"');
    expect(text(bytes, "ppt/presentation.xml")).toContain("p14:sectionLst");
    expect(text(bytes, "ppt/notesSlides/notesSlide1.xml")).toContain("Say hello");
    const back = importPptx(bytes, "x.pptx").pages;
    expect(back[0].notes).toBe("Say hello\nThen go on");
    expect(back[1].hidden).toBe(true);
    expect(back[1].section).toBe("Body");
    const t0 = back[0].nodes.find((n): n is TextNode => n.type === "TEXT" && n.ph?.type === "ctrTitle")!;
    expect(t0.paragraphs[0].runs.map((r) => r.text).join("")).toBe("Deck title");
    // the empty placeholders of slide 2 come back as empty placeholders
    expect(back[1].nodes.filter((n) => isEmptyPh(n)).length).toBe(2);
    // the deck's own layouts as new-slide choices
    const lays = pptxLayoutSlides(bytes).layouts;
    expect(lays.length).toBe(3);
    expect(lays.some((l) => l.page.nodes.some((n) => n.type === "TEXT" && n.ph?.type === "body"))).toBe(true);
  });

  it("into the original: hiding a slide, its notes and a section change only what they need", async () => {
    const doc = open();
    expect(pptxUnchanged(doc.pages)).not.toBeNull();
    doc.pages = doc.pages.map((p, i) => (i === 1 ? { ...p, hidden: true as const, notes: "New notes", section: "Mine" } : p));
    expect(pptxUnchanged(doc.pages)).toBeNull();
    const r = (await pptxSurgical(doc, doc.pages))!;
    expect(r).not.toBeNull();
    const back = importPptx(r.bytes, "x.pptx").pages;
    expect(back[1].hidden).toBe(true);
    expect(back[1].notes).toBe("New notes");
    expect(back[1].section).toBe("Mine");
    expect(back[0].hidden).toBeUndefined();
    // the first slide is untouched
    const a = unzipSync(new Uint8Array(readFileSync(DECK))), b = unzipSync(r.bytes);
    expect(strFromU8(b["ppt/slides/slide1.xml"])).toBe(strFromU8(a["ppt/slides/slide1.xml"]));
  });
});
