// QA-W (문서 3차) regressions: headers / footers / page numbers through DOCX, HWPX and Office Surgeon.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { fieldRun, hfNodesAt, hfText, insertPageNumber, newHfParagraph, setHfParas } from "../src/core/headerFooter";
import { newPage, newText, type OmwDocument, type Page } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";
import { exportDocx, exportHwpx } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const docOf = (pages: Page[], title = "omni-qa"): OmwDocument => ({ format: "omw", version: 1, id: "d", title, created: "", modified: "", pages, masters: [], assets: {} });
function bodyPages(n: number): Page[] {
  const pages = Array.from({ length: n }, (_, i) => newPage("DOCUMENT", 794, 1123, `p${i + 1}`));
  pages.forEach((p, i) => p.nodes.push(newText(`omni 본문 ${i + 1}`, 600)));
  return pages;
}
/** the page number placed by itself on each page ("" = none) */
const pageNums = (doc: OmwDocument) => doc.pages.map((_, i) => hfNodesAt(doc, i).find((n) => n.id.endsWith("pagenum"))?.paragraphs[0].runs[0].text ?? "");
const open = async (kind: "docx" | "hwpx", bytes: Uint8Array, name = `omni-qa.${kind}`) => {
  const r = await formatForExt(kind)!.open({ name, path: null, bytes }, {} as any);
  return { ...docOf(r.pages), assets: (r as any).assets ?? {} } as OmwDocument;
};
const save = async (kind: "docx" | "hwpx", doc: OmwDocument, msgs: string[] = []) =>
  (await exportById(kind)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;

describe("DOCX: different first page that shows the page number", () => {
  it("titlePg without hiding the number → DOCX → back: page 1 still numbered", async () => {
    const pages = bodyPages(3);
    pages[0].hf = { titlePg: true };
    insertPageNumber(pages, 0, { pos: "bottom-center" });
    const doc = docOf(pages);
    expect(pageNums(doc)).toEqual(["1", "2", "3"]);
    const back = await open("docx", exportDocx(doc.pages));
    expect(pageNums(back)).toEqual(["1", "2", "3"]);
    expect(back.pages[0].hf?.hideFirstNum).toBeUndefined();
  });
});

describe("HWPX: a page number's shape goes on into later sections (한글)", () => {
  it("roman numbers in both sections → HWPX → back: iii, iv on the second section", async () => {
    const pages = bodyPages(4);
    pages[2].breakBefore = "section";
    insertPageNumber(pages, 0, { pos: "bottom-center", fmt: "lowerRoman" });
    pages[2].hf = { pageFmt: "lowerRoman" };
    const f = newHfParagraph("", "CENTER");
    f.runs = [fieldRun("page")];
    setHfParas(pages, pages[0].id, "header", [f]);
    const doc = docOf(pages);
    expect(pageNums(doc)).toEqual(["i", "ii", "iii", "iv"]);
    const back = await open("hwpx", exportHwpx(doc.pages, "t"));
    expect(pageNums(back)).toEqual(["i", "ii", "iii", "iv"]);
    expect(back.pages.map((_, i) => hfText(back, i, "header"))).toEqual(["i", "ii", "iii", "iv"]);
  });

  it("a later section that sets 1 2 3 again stays 1 2 3", async () => {
    const pages = bodyPages(4);
    pages[2].breakBefore = "section";
    insertPageNumber(pages, 0, { pos: "bottom-center", fmt: "upperRoman" });
    const doc = docOf(pages);
    expect(pageNums(doc)).toEqual(["I", "II", "3", "4"]);
    expect(pageNums(await open("hwpx", exportHwpx(doc.pages, "t")))).toEqual(["I", "II", "3", "4"]);
  });
});

describe("Office Surgeon: header parts shared by sections", () => {
  it("two sections pointing at one header part: editing the second gives it a part of its own", async () => {
    const pages = bodyPages(2);
    pages[1].breakBefore = "section";
    setHfParas(pages, pages[0].id, "header", [newHfParagraph("omni 공용 머리말")]);
    pages[1].hf = { header: { default: [newHfParagraph("omni 공용 머리말")] } };
    const { strFromU8, strToU8, unzipSync, zipSync } = await import("fflate");
    const files = unzipSync(exportDocx(pages));
    const xml = strFromU8(files["word/document.xml"]);
    const ids = [...xml.matchAll(/headerReference w:type="default" r:id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    files["word/document.xml"] = strToU8(xml.split(`r:id="${ids[1]}"`).join(`r:id="${ids[0]}"`));
    const doc = await open("docx", zipSync(files), "omni-shared.docx");
    expect([0, 1].map((i) => hfText(doc, i, "header"))).toEqual(["omni 공용 머리말", "omni 공용 머리말"]);
    setHfParas(doc.pages, doc.pages[1].id, "header", [newHfParagraph("omni 둘째 구역만")]);
    const msgs: string[] = [];
    const back = await open("docx", await save("docx", doc, msgs));
    expect(msgs).toEqual([]);
    expect([0, 1].map((i) => hfText(back, i, "header"))).toEqual(["omni 공용 머리말", "omni 둘째 구역만"]);
  });
});

describe("Office Surgeon: a map from before headers were read (older .omw)", () => {
  const FILES = { docx: "qa/interop/word-made/omni-word-pages.docx", hwpx: "qa/interop/adobe-made/hwpx_doc.hwpx" } as const;
  /** the file as an older app left it in an .omw: pages without headers, a map without `hf` */
  async function oldOmw(kind: "docx" | "hwpx") {
    const doc = await open(kind, new Uint8Array(readFileSync(FILES[kind])), `omni-old.${kind}`);
    for (const p of doc.pages) {
      delete p.hf;
      if (p.source?.office) {
        delete (p.source.office as any).hf;
        delete (p.source.office as any).hfKey;
      }
    }
    return doc;
  }

  it.each(["docx", "hwpx"] as const)("%s: untouched → the original bytes (its headers kept)", async (kind) => {
    const doc = await oldOmw(kind);
    expect(Buffer.from(await save(kind, doc)).equals(readFileSync(FILES[kind]))).toBe(true);
  });

  it.each(["docx", "hwpx"] as const)("%s: a header made now is saved (written anew, with the notice), not dropped", async (kind) => {
    const doc = await oldOmw(kind);
    setHfParas(doc.pages, doc.pages[0].id, "header", [newHfParagraph("omni 새 머리말")]);
    const msgs: string[] = [];
    const out = await save(kind, doc, msgs);
    expect(msgs.length).toBe(1);
    const back = await open(kind, out);
    expect(back.pages.map((_, i) => hfText(back, i, "header")).every((s) => s === "omni 새 머리말")).toBe(true);
  });
});
