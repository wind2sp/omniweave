// A Word document written anew (a structural edit the in-place save cannot make — here 구역 나누기(이어서)) keeps what
// Word lays the text out by: the original's document defaults (kerning, languages), its compat settings, the
// note separators and numbering, row heights, notes in table cells (QA 11-23). Every Word-made sample: the pages and
// the last paragraph's place in the edited document are those of the file read again; Word itself (2021, checked by
// hand with the same files) shows the same page counts.
import { readdirSync, readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { caretBox, flowLines, gatherStory, isFlowSegment, nodeOrder, reflowPages, segments } from "../src/core/flow";
import { splitParagraph } from "../src/core/richtext";
import { exportById, formatForExt } from "../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

function lastPos(pages: any[]) {
  let best: any = null;
  for (const seg of segments(pages)) {
    if (!isFlowSegment(pages, seg)) continue;
    const st = gatherStory(pages, seg);
    const lines = flowLines(pages, seg);
    st.paras.forEach((q, i) => {
      if (!q.runs.map((x) => x.text).join("").trim()) return;
      const cb = caretBox(lines, i, 0);
      if (cb) best = { page: cb.page, y: Math.round(cb.y * 10) / 10 };
    });
  }
  return best;
}
const FILES = readdirSync("qa/interop/word-made").filter((x) => x.endsWith(".docx"));

describe("a Word document written anew lays out as it did", () => {
  it.each(FILES)("%s", async (f) => {
    const bytes = new Uint8Array(readFileSync("qa/interop/word-made/" + f));
    const r: any = await formatForExt("docx")!.open({ name: f, path: null, bytes }, {} as any);
    const doc: any = { format: "omw", version: 1, id: "d", title: f, created: "", modified: "", pages: r.pages, masters: [], assets: r.assets ?? {} };
    const paras = doc.pages.flatMap((p: any) => p.nodes.filter((n: any) => n.flow && n.type === "TEXT").sort(nodeOrder).flatMap((n: any) => n.paragraphs));
    const target = paras.find((q: any, i: number) => i >= 2 && !q.flowCont && !q.contSect && !q.list && !q.role && q.runs.some((x: any) => x.text.trim()));
    if (!target) return;
    doc.pages = reflowPages(
      doc.pages.map((p: any) => ({
        ...p,
        nodes: p.nodes.map((n: any) =>
          n.type === "TEXT" && n.flow && n.paragraphs.some((q: any) => q.id === target.id)
            ? { ...n, paragraphs: n.paragraphs.flatMap((q: any) => (q.id !== target.id ? [q] : ((s) => [s.paras[0], { ...s.paras[1], contSect: p.columns ? { columns: p.columns } : {} }])(splitParagraph([q], { p: 0, o: 0 }, {})))) }
            : n,
        ),
      })),
    );
    const out = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
    const back: any = await formatForExt("docx")!.open({ name: f, path: null, bytes: out }, {} as any);
    expect(back.pages.length).toBe(doc.pages.length);
    expect(lastPos(back.pages)).toEqual(lastPos(doc.pages));
  });

  it("the original's document defaults and compat settings go into the new file", async () => {
    const f = "omni-fid-table-ind.docx";
    const r: any = await formatForExt("docx")!.open({ name: f, path: null, bytes: new Uint8Array(readFileSync("qa/interop/word-made/" + f)) }, {} as any);
    const { exportDocx } = await import("../src/io/office");
    const files = unzipSync(exportDocx(r.pages));
    const st = strFromU8(files["word/styles.xml"]);
    expect(st).toContain('<w:kern w:val="2"/>');
    expect(st).toMatch(/<w:pPrDefault><w:pPr>[\s\S]*<w:spacing w:after="160" w:line="259" w:lineRule="auto"\/>/);
    expect(strFromU8(files["word/settings.xml"])).toContain('w:name="compatibilityMode"');
  });
});
