// Hyperlinks (TextRun.link, QA 11-24 basic-ux): read from Word's w:hyperlink (omni-word-links.docx, made in Word),
// kept through Office Surgeon when another paragraph is edited, written as a HYPERLINK field in a new DOCX.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { nodeOrder } from "../src/core/flow";
import type { OmwDocument, Page, TextNode, TextRun } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";
import { hyperlinkTarget } from "../src/io/office";
import { normalizeLink } from "../src/ui/linkActions";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const SAMPLE = "qa/interop/word-made/omni-word-links.docx";
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt("docx")!.open({ name: "omni-links.docx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-links", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (doc: OmwDocument) => (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow).sort(nodeOrder);
const runs = (doc: OmwDocument): TextRun[] => doc.pages.flatMap(frames).flatMap((f) => f.paragraphs.flatMap((q) => q.runs));
const linked = (doc: OmwDocument) => runs(doc).filter((r) => r.link).map((r) => [r.text, r.link]);

describe("hyperlinks", () => {
  it("Word's links are read onto their runs", async () => {
    const doc = await open(new Uint8Array(readFileSync(SAMPLE)));
    expect(linked(doc)).toEqual([
      ["Omniweave site", "https://example.com/omniweave"],
      ["the QA desk", "mailto:qa@example.com"],
    ]);
  });

  it("kept when another paragraph is edited (Office Surgeon), and written as a HYPERLINK field in a new file", async () => {
    const doc = await open(new Uint8Array(readFileSync(SAMPLE)));
    // edit the text after the links, in the same paragraph
    for (const p of doc.pages) for (const f of frames(p)) for (const q of f.paragraphs) for (const r of q.runs) if (r.text.includes("Second paragraph")) r.text = r.text.replace("Second", "Edited");
    const again = await open(await save(doc));
    expect(linked(again)).toEqual(linked(doc));
    // a document without the original (written anew): the links as fields
    const fresh = { ...doc, pages: doc.pages.map((p) => ({ ...p, source: undefined })) } as OmwDocument;
    const bytes = await save(fresh);
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toContain('w:instr=" HYPERLINK &quot;https://example.com/omniweave&quot; "');
    expect(linked(await open(bytes))).toEqual(linked(doc));
  });

  it("a link put on text of a Word file is written by Office Surgeon as a HYPERLINK field and read back", async () => {
    const doc = await open(new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx")));
    const r = runs(doc).find((x) => x.text.length > 4)!;
    r.link = "https://example.com/new";
    const bytes = await save(doc);
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toContain('<w:fldSimple w:instr=" HYPERLINK &quot;https://example.com/new&quot; ">');
    expect(linked(await open(bytes))).toEqual([[r.text, "https://example.com/new"]]);
  });

  it("a table row made taller by dragging its edge is written as Word's row height (w:trHeight), the table rewritten", async () => {
    const doc = await open(new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx")));
    const tb = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE");
    if (tb?.type !== "TABLE") throw new Error("no table");
    for (const c of tb.rows[0]) c.rowMin = 60;
    const xml = strFromU8(unzipSync(await save(doc))["word/document.xml"]);
    expect(xml).toContain('<w:trHeight w:val="900"/>');
  });

  it("field instructions and typed addresses", () => {
    expect(hyperlinkTarget(' HYPERLINK "https://a.b/c" \\o "tip" ')).toBe("https://a.b/c");
    expect(hyperlinkTarget(' HYPERLINK \\l "_Toc1" ')).toBe("#_Toc1");
    expect(hyperlinkTarget(' HYPERLINK "https://a.b" \\l "x" ')).toBe("https://a.b#x");
    expect(hyperlinkTarget(" PAGE ")).toBeUndefined();
    expect(normalizeLink("www.example.com")).toBe("https://www.example.com");
    expect(normalizeLink("qa@example.com")).toBe("mailto:qa@example.com");
    expect(normalizeLink("#top")).toBe("#top");
  });
});

describe("hyperlinks in HWPX (한글)", () => {
  const openH = async (bytes: Uint8Array): Promise<OmwDocument> => {
    const r: any = await formatForExt("hwpx")!.open({ name: "omni-links.hwpx", path: null, bytes }, {} as any);
    return { format: "omw", version: 1, id: "d", title: "omni-links", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
  };
  const saveH = async (doc: OmwDocument) => (await exportById("hwpx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
  it("한글's hyperlink fields are read onto their runs, kept when another paragraph is edited", async () => {
    const doc = await openH(new Uint8Array(readFileSync("qa/interop/hancom-made/omni-hwp-links.hwpx")));
    expect(linked(doc)).toEqual([
      ["오메 누리집", "https://example.com/omniweave"],
      ["시험 창구", "mailto:qa@example.com"],
    ]);
    for (const p of doc.pages) for (const f of frames(p)) for (const q of f.paragraphs) for (const r of q.runs) if (r.text.includes("두 번째")) r.text = r.text.replace("두 번째", "고친");
    expect(linked(await openH(await saveH(doc)))).toEqual(linked(doc));
  });
  it("a link put on text is written as 한글's hyperlink field (new file and Office Surgeon)", async () => {
    const doc = await openH(new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx")));
    const r = runs(doc).find((x) => x.text.length > 4)!;
    r.link = "https://example.com/hwp";
    const bytes = await saveH(doc);
    const xml = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    expect(xml).toContain('type="HYPERLINK"');
    // (for a check in 한글 itself: qa/interop/scripts — written only when asked)
    if (process.env.OMW_LINK_OUT) (await import("node:fs")).writeFileSync(process.env.OMW_LINK_OUT, bytes);
    expect(linked(await openH(bytes))).toEqual([[r.text, "https://example.com/hwp"]]);
    const fresh = { ...doc, pages: doc.pages.map((p) => ({ ...p, source: undefined })) } as OmwDocument;
    expect(linked(await openH(await saveH(fresh)))).toEqual([[r.text, "https://example.com/hwp"]]);
  });
});
