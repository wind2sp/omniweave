// Word table cells in a heading style without their own w:sz (adobe-made/word_doc.docx: 'heading 2' based on Normal,
// Word draws 10 pt, not bold): the importer takes the style's run properties (model 4) instead of guessing 20 pt bold,
// so editing one cell no longer writes w:sz 40 + w:b into the saved file (QA, 2026-11-12).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument, TableNode } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { docxContext, parseDocx } from "../../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const FILE = "qa/interop/adobe-made/word_doc.docx";
const PT = 96 / 72;

describe("DOCX heading-style table cells", () => {
  it("read with the style's size and weight (10 pt, not bold)", () => {
    const ps = parseDocx(new Uint8Array(readFileSync(FILE)));
    const qty = ps.find((p) => p.runs.map((r) => r.text).join("") === "수량 Qty")!;
    expect(qty.runs.every((r) => Math.abs(r.fontSize - 10 * PT) < 0.01 && !r.bold)).toBe(true);
    // a map before model 4 reads the original with the old guess (so its untouched headings stay untouched)
    expect(docxContext(unzipSync(new Uint8Array(readFileSync(FILE))), false, true).headingRun).toBeUndefined();
  });

  it("editing one cell writes 10 pt (w:sz 20), never the guessed 20 pt bold", async () => {
    const r = await formatForExt("docx")!.open({ name: "w.docx", path: null, bytes: new Uint8Array(readFileSync(FILE)) }, {} as any);
    const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
    const t = doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE")!;
    const cell = t.rows.flat().find((c) => c.text === "수량 Qty")!;
    cell.text = "수량 Count";
    const out = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    const xml = strFromU8(unzipSync(out)["word/document.xml"]);
    const at = xml.indexOf("수량 Count");
    const p = xml.slice(xml.lastIndexOf("<w:p>", at), at);
    expect(p).not.toContain('w:sz w:val="40"');
    expect(p).not.toContain("<w:b/>");
  });
});
