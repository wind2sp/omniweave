// 쪽 테두리 / Word page border (Page.border, core/pageBorder.ts): read from Word's w:pgBorders (omni-word-pageborder.docx,
// made in Word) and 한글's hp:pageBorderFill, drawn as locked line nodes by the body flow, written back to DOCX (new file
// and Office Surgeon) and HWPX.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { reflowPages } from "../src/core/flow";
import { borderRect, pageBorderNodes } from "../src/core/pageBorder";
import type { OmwDocument, PageBorder } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

async function open(kind: string, bytes: Uint8Array): Promise<OmwDocument> {
  const r: any = await formatForExt(kind)!.open({ name: `omni-border.${kind}`, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-border", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const save = async (kind: string, doc: OmwDocument) => (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const box: PageBorder = { style: "single", width: 1, color: "#FF0000", space: 32, from: "page" };

describe("page borders", () => {
  it("Word's page border is read (double, 0.75 pt, blue, 24 pt from the paper) and drawn as two locked lines", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync("qa/interop/word-made/omni-word-pageborder.docx")));
    expect(doc.pages[0].border).toEqual({ style: "double", width: 1, color: "#0070C0", space: 32, from: "page" });
    const lines = doc.pages[0].nodes.filter((n) => n.id.includes(":pgborder"));
    expect(lines.length).toBe(2);
    expect(lines.every((n) => n.locked && n.type === "VECTOR" && n.notes)).toBe(true);
    expect(borderRect(doc.pages[0], doc.pages[0].border!)).toMatchObject({ x: 32, y: 32 });
  });

  it("a border put on (or taken off) a Word file is written as w:pgBorders by Office Surgeon and read back", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.docx")));
    const pages = reflowPages(doc.pages.map((p) => ({ ...p, border: box })));
    const bytes = await save("docx", { ...doc, pages });
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toContain('<w:pgBorders w:offsetFrom="page"><w:top w:val="single" w:sz="6" w:space="24" w:color="FF0000"/>');
    expect((await open("docx", bytes)).pages[0].border).toEqual(box);
    if (process.env.OMW_BORDER_OUT) (await import("node:fs")).writeFileSync(process.env.OMW_BORDER_OUT + ".docx", bytes);
    // taken off again (a border of width 0)
    const word = await open("docx", new Uint8Array(readFileSync("qa/interop/word-made/omni-word-pageborder.docx")));
    const off = reflowPages(word.pages.map((p) => ({ ...p, border: { ...box, width: 0 } })));
    const x2 = strFromU8(unzipSync(await save("docx", { ...word, pages: off }))["word/document.xml"]);
    expect(x2).not.toContain("pgBorders");
  });

  it("HWPX: written as a border fill the section's page border fills refer to, read back", async () => {
    const doc = await open("hwpx", new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx")));
    const pages = reflowPages(doc.pages.map((p) => ({ ...p, border: { ...box, style: "dashed" as const } })));
    const bytes = await save("hwpx", { ...doc, pages });
    const sec = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    expect(sec).toMatch(/<hp:pageBorderFill type="BOTH" borderFillIDRef="\d+" textBorder="PAPER"[^>]*><hp:offset left="2400"/);
    if (process.env.OMW_BORDER_OUT) (await import("node:fs")).writeFileSync(process.env.OMW_BORDER_OUT + ".hwpx", bytes);
    const back = await open("hwpx", bytes);
    expect(back.pages[0].border).toMatchObject({ style: "dashed", color: "#FF0000", space: 32, from: "page" });
    expect(pageBorderNodes(back.pages[0]).length).toBe(1);
  });

  it("HWPX: written by Office Surgeon in place — no notice, the original's lines kept, the border fill added to the header", async () => {
    const orig = new Uint8Array(readFileSync("qa/samples/doc-features/omni-sample.hwpx"));
    const doc = await open("hwpx", orig);
    const pages = reflowPages(doc.pages.map((p) => ({ ...p, border: { ...box, style: "single" as const } })));
    let asked = 0;
    const bytes = (await exportById("hwpx")!.run({ ...doc, pages }, pages[0], { confirm: () => (asked++, false) } as any)) as Uint8Array;
    expect(asked).toBe(0);
    const z = unzipSync(bytes), o = unzipSync(orig);
    const sec = strFromU8(z["Contents/section0.xml"]), head = strFromU8(z["Contents/header.xml"]);
    const id = /<hp:pageBorderFill type="BOTH" borderFillIDRef="(\d+)"/.exec(sec)?.[1];
    expect(id).toBeTruthy();
    const bf = head.slice(head.indexOf(`<hh:borderFill id="${id}"`));
    expect(bf.slice(0, bf.indexOf("</hh:borderFill>"))).toContain('<hh:leftBorder type="SOLID"');
    // (the paragraphs as 한글 saved them: their line layouts are still there)
    expect((sec.match(/<hp:linesegarray>/g) ?? []).length).toBe((strFromU8(o["Contents/section0.xml"]).match(/<hp:linesegarray>/g) ?? []).length);
    expect((await open("hwpx", bytes)).pages[0].border).toMatchObject({ style: "single", color: "#FF0000" });
  });
});
