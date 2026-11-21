// Office Surgeon PPTX stage 1 (src/io/officesurgeon/pptx.ts): a deck edited in one place is saved into its original
// package — the other slides, their animations, notes, media, sections and the layouts stay as PowerPoint wrote them.
// Deck: qa/interop/adobe-made/omni-pptx-surgeon.pptx (qa/interop/scripts/pptx_surgeon_make.ps1).

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { makeAsset } from "../../src/core/assets";
import { newDocument, newPage, newText, type OmwDocument, type SceneNode, type TextNode } from "../../src/core/types";
import { importPptx } from "../../src/io/formats/pptx";
import { attachPptxMeta, pptxSurgical, pptxUnchanged } from "../../src/io/officesurgeon/pptx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const DECK = "qa/interop/adobe-made/omni-pptx-surgeon.pptx";
const MEDIA = "qa/interop/adobe-made/omni-pptx-media.pptx";

function open(path = DECK): { doc: OmwDocument; bytes: Uint8Array } {
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
const text = (f: Record<string, Uint8Array>, n: string) => strFromU8(f[n]);
const plain = (t: TextNode) => t.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
const named = (nodes: SceneNode[], name: string, type?: string) => nodes.find((n) => n.name === name && (!type || n.type === type))!;
/** names of entries whose content differs */
function changed(a: Record<string, Uint8Array>, b: Record<string, Uint8Array>): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k], y = b[k];
    if (!x || !y || x.length !== y.length || x.some((v, i) => v !== y[i])) out.push(k);
  }
  return out.sort();
}
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;
/** OMNIWEAVE_PPTX_SURGEON_OUT=<folder>: the saved decks, for opening in PowerPoint (qa/interop/scripts/pptx_surgeon_check.ps1) */
const keep = (name: string, b: Uint8Array) => process.env.OMNIWEAVE_PPTX_SURGEON_OUT && writeFileSync(join(process.env.OMNIWEAVE_PPTX_SURGEON_OUT, `surgeon-${name}.pptx`), b);

describe("PPTX surgeon (stage 1)", () => {
  it("saved unchanged: the original bytes (maps on every page)", () => {
    const { doc, bytes } = open();
    const same = pptxUnchanged(doc.pages)!;
    expect(same).not.toBeNull();
    expect(same.length).toBe(bytes.length);
  });

  it("one character typed: only that slide part changes, by that character in its own run", async () => {
    const { doc, bytes } = open();
    const t = doc.pages[1].nodes.find((n): n is TextNode => n.type === "TEXT" && plain(n).includes("Second"))!;
    const p = t.paragraphs[1];
    const last = p.runs[p.runs.length - 1];
    last.text += "~";
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("text", r.bytes);
    expect(r).not.toBeNull();
    expect(r.warnings).toEqual([]);
    const a = files(bytes), b = files(r.bytes);
    expect(changed(a, b)).toEqual(["ppt/slides/slide2.xml"]);
    expect(text(b, "ppt/slides/slide2.xml")).toBe(text(a, "ppt/slides/slide2.xml").replace("Second</a:t>", "Second~</a:t>"));
    // read back: the edit is there, the rest as before
    const back = importPptx(r.bytes, "x.pptx");
    expect(back.pages.map((pg) => pg.nodes.filter((n) => n.type === "TEXT").map((n) => plain(n as TextNode)))).toEqual(doc.pages.map((pg) => pg.nodes.filter((n) => n.type === "TEXT").map((n) => plain(n as TextNode))));
  });

  it("one shape moved: only its a:off changes", async () => {
    const { doc, bytes } = open();
    const left = named(doc.pages[3].nodes, "Left");
    left.transform = { ...left.transform, x: left.transform.x + 20, y: left.transform.y - 10 };
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("move", r.bytes);
    const a = files(bytes), b = files(r.bytes);
    expect(changed(a, b)).toEqual(["ppt/slides/slide4.xml"]);
    const s0 = text(a, "ppt/slides/slide4.xml"), s1 = text(b, "ppt/slides/slide4.xml");
    expect(s1.length).toBeGreaterThan(s0.length - 4);
    const off = (s: string) => /name="Left"[\s\S]*?<a:off x="(\d+)" y="(\d+)"/.exec(s)!.slice(1).map(Number);
    expect(off(s1)[0] - off(s0)[0]).toBe(20 * 9525);
    expect(off(s1)[1] - off(s0)[1]).toBe(-10 * 9525);
    expect(s1.replace(/<a:off x="\d+" y="\d+"\/>/g, "")).toBe(s0.replace(/<a:off x="\d+" y="\d+"\/>/g, ""));
  });

  it("a placeholder placed by its layout gets its own position when moved", async () => {
    const { doc, bytes } = open();
    const title = doc.pages[0].nodes.find((n): n is TextNode => n.type === "TEXT" && plain(n).startsWith("원본"))!;
    title.transform = { ...title.transform, y: title.transform.y + 30 };
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("placeholder", r.bytes);
    const s0 = text(files(bytes), "ppt/slides/slide1.xml"), s1 = text(files(r.bytes), "ppt/slides/slide1.xml");
    expect(count(s1, /<a:xfrm>/g)).toBe(count(s0, /<a:xfrm>/g) + 1);
    const back = importPptx(r.bytes, "x.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT" && plain(n).startsWith("원본"))!;
    expect(back.transform.y).toBeCloseTo(title.transform.y, 0);
  });

  it("a slide added: presentation.xml, its relationships, content types and sections; the others untouched", async () => {
    const { doc, bytes } = open();
    const page = newPage("SLIDE", doc.pages[0].width, doc.pages[0].height, "new");
    const t = newText("새 슬라이드 New", 400);
    t.transform = { x: 100, y: 100, rotation: 0, scale: 1 };
    page.nodes = [t];
    doc.pages.push(page);
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("add", r.bytes);
    const a = files(bytes), b = files(r.bytes);
    expect(changed(a, b)).toEqual(["[Content_Types].xml", "ppt/_rels/presentation.xml.rels", "ppt/presentation.xml", "ppt/slides/_rels/slide5.xml.rels", "ppt/slides/slide5.xml"]);
    const pres = text(b, "ppt/presentation.xml");
    expect(count(pres, /<p:sldId /g)).toBe(5);
    expect(count(pres, /<p14:sldId /g)).toBe(5);
    expect(text(b, "[Content_Types].xml")).toContain('PartName="/ppt/slides/slide5.xml"');
    const back = importPptx(r.bytes, "x.pptx");
    expect(back.pages).toHaveLength(5);
    expect(plain(back.pages[4].nodes.find((n): n is TextNode => n.type === "TEXT")!)).toBe("새 슬라이드 New");
  });

  it("a slide removed: its part, notes and media leave; sections follow", async () => {
    const { doc, bytes } = open();
    doc.pages.splice(2, 1);
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("remove", r.bytes);
    const a = files(bytes), b = files(r.bytes);
    const diff = changed(a, b);
    expect(diff).toContain("ppt/slides/slide3.xml");
    expect(diff).toContain("ppt/notesSlides/notesSlide3.xml");
    expect(diff).toContain("ppt/media/media1.wav");
    expect(b["ppt/slides/slide3.xml"]).toBeUndefined();
    for (const k of ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide4.xml", "ppt/notesSlides/notesSlide4.xml", "ppt/slideLayouts/slideLayout1.xml", "ppt/slideMasters/slideMaster1.xml"]) expect(diff).not.toContain(k);
    const pres = text(b, "ppt/presentation.xml");
    expect(count(pres, /<p:sldId /g)).toBe(3);
    expect(count(pres, /<p14:sldId /g)).toBe(3);
    expect(text(b, "[Content_Types].xml")).not.toContain("slide3.xml");
    expect(importPptx(r.bytes, "x.pptx").pages).toHaveLength(3);
  });

  it("slides moved: only the slide list and sections change", async () => {
    const { doc, bytes } = open();
    [doc.pages[0], doc.pages[1]] = [doc.pages[1], doc.pages[0]];
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("reorder", r.bytes);
    expect(changed(files(bytes), files(r.bytes))).toEqual(["ppt/presentation.xml"]);
    const back = importPptx(r.bytes, "x.pptx");
    expect(plain(back.pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!)).toContain("애니메이션");
  });

  it("a shape deleted: its animations go, the others stay", async () => {
    const { doc, bytes } = open();
    const pg = doc.pages[1];
    const s0 = text(files(bytes), "ppt/slides/slide2.xml");
    const pairId = /name="Pair"[^>]*/.exec(s0) && /<p:cNvPr id="(\d+)" name="Pair"/.exec(s0)![1];
    expect(pairId).toBeTruthy();
    // the group's members as Omniweave read them: the two shapes named "Dot A" / "Tag B"
    pg.nodes = pg.nodes.filter((n) => n.name !== "Dot A" && n.name !== "Tag B");
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("shape-deleted", r.bytes);
    expect(r.warnings.join()).toMatch(/1/);
    const s1 = text(files(r.bytes), "ppt/slides/slide2.xml");
    expect(s1).not.toContain('name="Pair"');
    expect(s1).not.toContain(`spid="${pairId}"`);
    expect(count(s1, /presetClass="/g)).toBe(count(s0, /presetClass="/g) - 1);
    expect(s1).toContain("<p:timing>");
  });

  it("a shape recoloured: written anew under its shape id, its animation kept", async () => {
    const { doc, bytes } = open();
    const s0 = text(files(bytes), "ppt/slides/slide4.xml");
    const id = /<p:cNvPr id="(\d+)" name="Right"/.exec(s0)![1];
    const right = named(doc.pages[3].nodes, "Right", "VECTOR");
    (right as any).fill = "#ff0000";
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("recolour", r.bytes);
    expect(r.warnings).toHaveLength(1);
    const s1 = text(files(r.bytes), "ppt/slides/slide4.xml");
    expect(s1).toContain(`<p:cNvPr id="${id}" name="Right"`);
    expect(s1).toContain('val="FF0000"');
    expect(s1).toContain(`spid="${id}"`);
  });

  it("the first slide removed: the other slides keep their maps and parts", async () => {
    const { doc, bytes } = open();
    doc.pages.shift();
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("first-removed", r.bytes);
    expect(r).not.toBeNull();
    const diff = changed(files(bytes), files(r.bytes));
    for (const k of ["ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/slides/slide4.xml"]) expect(diff).not.toContain(k);
    expect(importPptx(r.bytes, "x.pptx").pages).toHaveLength(3);
  });

  it("a paragraph removed: the animation of that paragraph goes, the others stay", async () => {
    const { doc, bytes } = open();
    const t = doc.pages[1].nodes.find((n): n is TextNode => n.type === "TEXT" && plain(n).includes("Third"))!;
    t.paragraphs.pop();
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("paragraph-removed", r.bytes);
    const s0 = text(files(bytes), "ppt/slides/slide2.xml"), s1 = text(files(r.bytes), "ppt/slides/slide2.xml");
    expect(s1).not.toContain("Third");
    expect(s1).toContain("Second</a:t>");
    expect(count(s0, /<p:pRg st="2"/g)).toBeGreaterThan(0);
    expect(count(s1, /<p:pRg st="2"/g)).toBe(0);
    expect(count(s1, /<p:pRg st="1"/g)).toBe(count(s0, /<p:pRg st="1"/g));
  });

  it("a media deck edited: clips, their timing and the other slides stay", async () => {
    const { doc, bytes } = open(MEDIA);
    const t = doc.pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    t.paragraphs[0].runs[0].text = "X" + t.paragraphs[0].runs[0].text;
    const r = (await pptxSurgical(doc, doc.pages))!;
    keep("media-text", r.bytes);
    expect(changed(files(bytes), files(r.bytes))).toEqual(["ppt/slides/slide1.xml"]);
    const s1 = text(files(r.bytes), "ppt/slides/slide1.xml");
    expect(s1).toContain("<p:timing>");
    expect(s1).toContain("p14:media");
  });
});
