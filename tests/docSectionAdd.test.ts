// A section added in a Word file (구역 나누기, QA 11-25 real use): the Office Surgeon writes it in place — Word's
// section-break paragraph holding a copy of the enclosing section's w:sectPr with the new part's paper — instead of
// writing the whole file anew (which asked "원래 파일과 맞춰 볼 수 없어 문서 전체를 새로 만듭니다").
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument, Page, TextNode } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const WORD = "qa/interop/word-made/omni-word-ruby.docx";
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt("docx")!.open({ name: "omni-sect.docx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-sect", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (doc: OmwDocument) => (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => false } as any)) as Uint8Array;
const frame = (p: Page) => p.nodes.find((n): n is TextNode => n.type === "TEXT" && !!n.flow)!;

/** a section break before paragraph `at` of the first page: the rest goes to a new page that starts a section */
function sectionBreak(doc: OmwDocument, at: number, landscape: boolean): OmwDocument {
  const p0 = doc.pages[0];
  const f = frame(p0);
  const keep = f.paragraphs.slice(0, at), moved = f.paragraphs.slice(at);
  const [w, h] = landscape ? [p0.height, p0.width] : [p0.width, p0.height];
  const first: Page = { ...p0, nodes: [{ ...f, paragraphs: keep }] };
  const next: Page = { ...p0, id: "pg-new", width: w, height: h, breakBefore: "section", source: undefined, nodes: [{ ...f, id: `${f.id}~b1`, paragraphs: moved }] } as Page;
  return { ...doc, pages: [first, next, ...doc.pages.slice(1)] };
}

describe("a section added in a Word file", () => {
  it("is written in place: a section-break paragraph with the enclosing section's settings, the new part's paper", async () => {
    const doc = await open(new Uint8Array(readFileSync(WORD)));
    const before = frame(doc.pages[0]).paragraphs.length;
    expect(before).toBeGreaterThanOrEqual(2);
    // (confirm: () => false — a save that would write the file anew is refused: this one must not ask)
    const bytes = await save(sectionBreak(doc, 1, true));
    const x = strFromU8(unzipSync(bytes)["word/document.xml"]);
    // the original's paragraphs as Word wrote them (a file written anew has no w:rsidR)
    expect(x).toMatch(/w:rsidR="/);
    const sects = x.match(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g) ?? [];
    expect(sects.length).toBe(2);
    // the new one ends the first part: next page, the first part's portrait paper; the body's keeps the landscape part
    expect(sects[0]).toContain('<w:type w:val="nextPage"/>');
    expect(sects[0]).not.toContain('w:orient="landscape"');
    expect(sects[1]).toContain('w:orient="landscape"');
    // read back: two sections, the text where it was
    const back = await open(bytes);
    const texts = back.pages.flatMap((p) => (frame(p)?.paragraphs ?? []).map((q) => q.runs.map((r) => r.text).join("")));
    const orig = frame(doc.pages[0]).paragraphs.map((q) => q.runs.map((r) => r.text).join(""));
    for (const t of orig.filter(Boolean)) expect(texts).toContain(t);
    expect(back.pages.some((p) => p.width > p.height)).toBe(true);
    expect(back.pages.some((p) => p.width < p.height)).toBe(true);
  });
});
