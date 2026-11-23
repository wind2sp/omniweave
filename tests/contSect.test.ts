// 이어서 구역 나누기 (Word w:type continuous, 한글 a 단 definition in the text): a section starting on the same page,
// its own columns, the columns before it balanced. Word's reference: qa/interop/word-made/omni-word-contsect.docx
// (Word 2021: 1 page; one column, then two balanced columns, then one column again starting at 594 pt from the top).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeOrder, reflowPages } from "../src/core/flow";
import type { OmwDocument, Page, TextNode } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const WORD = "qa/interop/word-made/omni-word-contsect.docx";
const PT = 96 / 72;
async function open(kind: string, bytes: Uint8Array, name = `omni-cont.${kind}`): Promise<OmwDocument> {
  const r: any = await formatForExt(kind)!.open({ name, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-cont", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (kind: string, doc: OmwDocument) => (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(nodeOrder);
const frameOf = (pages: Page[], text: string) => pages.flatMap(frames).find((f) => f.paragraphs.some((q) => q.runs.map((r) => r.text).join("").startsWith(text)))!;
const yOf = (pages: Page[], text: string) => {
  const f = frameOf(pages, text);
  let y = f.transform.y;
  for (const q of f.paragraphs) {
    if (q.runs.map((r) => r.text).join("").startsWith(text)) break;
    y += 0; // (frames start at their first paragraph: the regions' first paragraphs begin frames)
  }
  return y;
};

describe("continuous section: Word's own document", () => {
  it("reads the sections: the 2-column one starts mid-page, balanced; the one after it below, on the same page as Word", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "omni-word-contsect.docx");
    expect(doc.pages.length).toBe(1);
    const fs = frames(doc.pages[0]);
    // the two columns of the middle section
    const c1 = frameOf(doc.pages, "Column paragraph 1");
    expect(c1.width).toBeLessThan(400);
    const second = fs.filter((f) => f.width < 400 && f.transform.x > c1.transform.x + 100);
    expect(second.length).toBeGreaterThan(0);
    // balanced: both columns end within a line of each other
    const { layoutText } = await import("../src/core/text");
    const bottom = (f: TextNode) => f.transform.y + layoutText(f).height;
    const col1 = fs.filter((f) => f.width < 400 && f.transform.x <= c1.transform.x + 1);
    const b1 = Math.max(...col1.map(bottom)), b2 = Math.max(...second.map(bottom));
    expect(Math.abs(b1 - b2)).toBeLessThan(2 * 15 * PT);
    // the section after them starts where Word starts it (594 pt from the page top) within 3 pt
    const after = yOf(doc.pages, "After paragraph 1");
    expect(Math.abs(after - 594 * PT)).toBeLessThan(3 * PT); // Omniweave 593.6 pt
    // the middle section starts where Word starts it (300.6 pt)
    expect(Math.abs(c1.transform.y - 300.6 * PT)).toBeLessThan(3 * PT); // Omniweave 300.4 pt
  });

  it("saved unchanged: the original bytes", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "omni-word-contsect.docx");
    expect(Buffer.from(await save("docx", doc)).equals(readFileSync(WORD))).toBe(true);
  });
});

describe("continuous section: saving", () => {
  const contParas = (pages: Page[]) => pages.flatMap(frames).flatMap((f) => f.paragraphs).filter((q) => q.contSect);
  it("DOCX original format: the middle section in three columns → only its w:sectPr gets w:cols num 3", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "omni-word-contsect.docx");
    const mid = contParas(doc.pages)[0];
    doc.pages = reflowPages(doc.pages.map((p) => ({ ...p, nodes: p.nodes.map((n) => (n.type === "TEXT" && n.flow ? { ...n, paragraphs: n.paragraphs.map((q) => (q.id === mid.id ? { ...q, contSect: { ...q.contSect, columns: { n: 3, gap: 28.33 } } } : q)) } : n)) })));
    const out = await save("docx", doc);
    const secs = strFromU8(unzipSync(out)["word/document.xml"]).match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)!;
    expect(secs.length).toBe(3);
    expect(secs[1]).toContain('<w:type w:val="continuous"/>');
    expect(secs[1]).toMatch(/<w:cols w:num="3" w:space="425"\/>/);
    expect(secs[0]).toContain('<w:cols w:space="425"/>');
    const back = await open("docx", out);
    expect(contParas(back.pages).map((q) => q.contSect!.columns?.n ?? 1)).toEqual([3, 1]);
  });

  it("DOCX new file: sections ending in continuous w:sectPr with their columns → back the same regions", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "omni-word-contsect.docx");
    const pages = doc.pages.map((p) => ({ ...p, source: undefined })) as Page[];
    const { exportDocx } = await import("../src/io/office");
    const xml = strFromU8(unzipSync(exportDocx(pages))["word/document.xml"]);
    const secs = xml.match(/<w:sectPr>[\s\S]*?<\/w:sectPr>/g)!;
    expect(secs.length).toBe(3);
    expect(secs[0]).not.toContain("continuous");
    expect(secs[1]).toContain('<w:type w:val="continuous"/>');
    expect(secs[1]).toContain('<w:cols w:num="2"');
    expect(secs[2]).toContain('<w:type w:val="continuous"/>');
    const back = await open("docx", exportDocx(pages));
    // (the new file has the paragraphs' own spacing, not Word's document defaults: its page count is not compared here —
    // the original-format save keeps Word's file)
    expect(Math.round(frameOf(back.pages, "Column paragraph 1").transform.y)).toBe(Math.round(frameOf(doc.pages, "Column paragraph 1").transform.y));
    expect(contParas(back.pages).map((q) => q.contSect!.columns?.n ?? 1)).toEqual([2, 1]);
  });

  it("a document without continuous sections lays out as before; Enter in a section's first paragraph does not start another", async () => {
    const plain = await open("docx", new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx")));
    expect(reflowPages(plain.pages)).toBe(plain.pages);
    const { splitParagraph } = await import("../src/core/richtext");
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "omni-word-contsect.docx");
    const q = contParas(doc.pages)[0];
    const res = splitParagraph([q], { p: 0, o: 3 }, {});
    expect(res.paras[0].contSect).toBeTruthy();
    expect(res.paras[1].contSect).toBeUndefined();
  });
});

describe("continuous section: HWPX", () => {
  const contParas = (pages: Page[]) => pages.flatMap(frames).flatMap((f) => f.paragraphs).filter((q) => q.contSect);
  it("Word's document → HWPX: 단 definitions in the text (colPr in the paragraph) → back the same regions, the middle one where it was", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "omni-word-contsect.docx");
    const out = await save("hwpx", doc);
    const sec = strFromU8(unzipSync(out)["Contents/section0.xml"]);
    expect((sec.match(/<hp:colPr /g) ?? []).length).toBe(3);
    expect(sec).toMatch(/<hp:colPr [^>]*colCount="2"/);
    const back = await open("hwpx", out);
    expect(contParas(back.pages).map((q) => q.contSect!.columns?.n ?? 1)).toEqual([2, 1]);
    const y0 = frameOf(doc.pages, "Column paragraph 1").transform.y, y1 = frameOf(back.pages, "Column paragraph 1").transform.y;
    expect(Math.abs(y0 - y1)).toBeLessThan(40);
    // saved again as HWPX unchanged: the same bytes
    expect(Buffer.from(await save("hwpx", back)).equals(Buffer.from(out))).toBe(true);
  });
});