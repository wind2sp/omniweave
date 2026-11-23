// Markdown / HTML / TXT exports of a Word document keep its pictures, footnotes and headers (QA ui-audit #34):
// qa/samples/doc-features/omni-sample.docx has a header and a picture, qa/interop/word-made/omni-fid-notes.docx (Word) footnotes.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";

const NOTES = "qa/interop/word-made/omni-fid-notes.docx";
beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

async function sample(file = "qa/samples/doc-features/omni-sample.docx") {
  const r: any = await formatForExt("docx")!.open({ name: file.split("/").pop()!, path: null, bytes: new Uint8Array(readFileSync(file)) }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "omni-sample", created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} } as any;
}
const run = async (id: string, file?: string) => {
  const d = await sample(file);
  const out = await exportById(id)!.run(d, d.pages[0], { confirm: () => true } as any);
  return typeof out === "string" ? out : new TextDecoder().decode(out as Uint8Array);
};

describe("text exports of a Word document", () => {
  it("Markdown: header, picture as a data image, footnote reference and text", async () => {
    const md = await run("md");
    expect(md.split("\n")[0]).toContain("Omni 분기 보고서");
    expect(md).toMatch(/!\[[^\]]*\]\(data:image\/[a-z+]+;base64,/);
    const mn = await run("md", NOTES);
    expect(mn).toMatch(/\[\^1\][^:]/);
    expect(mn).toMatch(/^\[\^1\]: \S/m);
    expect(md).not.toContain("\u0001");
  });

  it("HTML: <header>, <img src=data:…>, footnote links and their list", async () => {
    const html = await run("html");
    expect(html).toContain("<header>");
    expect(html).toMatch(/<img src="data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+" alt="[^"]*" width="\d+" height="\d+">/);
    const hn = await run("html", NOTES);
    expect(hn).toContain('<sup><a href="#fn1" id="fnref1">');
    expect(hn).toMatch(/<section class="footnotes"><hr><ol><li id="fn1"/);
  });

  it("TXT: header line, [n] marks with the notes at the end, a mark for the picture", async () => {
    const txt = await run("txt");
    expect(txt.split(/\r?\n/)[0]).toContain("Omni 분기 보고서");
    const tn = await run("txt", NOTES);
    expect(tn).toMatch(/\S\[1\]/);
    expect(tn).toMatch(/^\[1\] \S/m);
    expect(txt).toMatch(/\[(그림|Picture): /);
  });
});
