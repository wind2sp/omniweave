// Duplicating pages / objects gives the copies' text paragraphs new ids (like copy-paste, ui/menuActions
// cloneNodes): paragraph ids map a paragraph back to its original Office element (Office Surgeon), so a copy
// must never share them. Undo removes the copy and leaves the original ids as they were.
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newDocument, newText, type Page, type TextNode } from "../../src/core/types";
import { exportById } from "../../src/io/formats";
import { exportDocx } from "../../src/io/office";
import { duplicatePage, duplicateSelected, importFile } from "../../src/ui/actions";
import { duplicatePages } from "../../src/ui/pageActions";
import { S, freshStore, installDom } from "../coverage/helpers";

beforeAll(() => {
  installDom();
  (globalThis as any).DOMParser = DOMParser;
  (globalThis as any).alert = () => {};
});

const paraIds = (pages: Page[]) => pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs.map((q) => q.id)));
const unique = (a: string[]) => new Set(a).size === a.length;

function docWithText() {
  const d = newDocument("오메 복제 시험");
  const tx = newText("Omni 첫 문단");
  d.pages[0].nodes.push(tx);
  return { d, tx };
}

describe("duplicates get new paragraph ids", () => {
  beforeEach(() => freshStore(docWithText().d));

  it("duplicatePage (ui/actions)", () => {
    const before = paraIds(S().doc.pages);
    duplicatePage(S().doc.pages[0].id);
    const after = paraIds(S().doc.pages);
    expect(after).toHaveLength(before.length * 2);
    expect(unique(after)).toBe(true);
    expect(paraIds([S().doc.pages[0]])).toEqual(before); // the original keeps its ids
    S().undo();
    expect(paraIds(S().doc.pages)).toEqual(before);
  });

  it("duplicatePages (page organiser)", () => {
    const before = paraIds(S().doc.pages);
    duplicatePages([S().doc.pages[0].id]);
    expect(unique(paraIds(S().doc.pages))).toBe(true);
    S().undo();
    expect(paraIds(S().doc.pages)).toEqual(before);
  });

  it("duplicateSelected (Ctrl+D)", () => {
    const before = paraIds(S().doc.pages);
    const tx = S().doc.pages[0].nodes.find((n) => n.type === "TEXT")!;
    S().set({ pageId: S().doc.pages[0].id, selection: [tx.id] });
    duplicateSelected();
    const after = paraIds(S().doc.pages);
    expect(after).toHaveLength(before.length * 2);
    expect(unique(after)).toBe(true);
    S().undo();
    expect(paraIds(S().doc.pages)).toEqual(before);
  });
});

describe("Office Surgeon after duplicating a page of an opened DOCX", () => {
  it("keeps the original elements and adds the copy as new paragraphs", async () => {
    const src = newDocument("오메 보고");
    src.pages[0].nodes.push(newText("Omni 보존 문단 하나"));
    const bytes = exportDocx(src.pages);
    freshStore();
    await importFile({ name: "omni.docx", path: null, bytes });
    const pg = S().doc.pages.find((p) => p.source?.format === "docx")!;
    expect(pg.source?.office).toBeTruthy();
    S().set({ doc: { ...S().doc, pages: S().doc.pages.filter((p) => p.source?.format === "docx") } } as any);
    duplicatePage(pg.id);
    expect(unique(paraIds(S().doc.pages))).toBe(true);
    const out = (await exportById("docx")!.run(S().doc, S().doc.pages[0], { confirm: () => true })) as Uint8Array;
    const xml = strFromU8(unzipSync(out)["word/document.xml"]);
    expect(xml.split("Omni 보존 문단 하나").length - 1).toBe(2);
    // the original paragraph element is still the first one, byte for byte
    const origXml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    const firstP = /<w:p[ >][\s\S]*?<\/w:p>/.exec(origXml)![0];
    expect(xml).toContain(firstP);
  });
});
