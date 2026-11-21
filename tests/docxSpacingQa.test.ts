// QA of docx-pages (docs/design/FIDELITY_DOCX.md 8): Word's paragraph spacing where the department did not compare,
// measured on Word 2021 PDFs made by qa/interop/scripts/word_make_fidelity5.ps1 (hidden new Word instance):
//   - the first paragraph of a new section (next page) keeps its space before less what the section's last paragraph's
//     space after already gives ("max": 20 − 4 → 16, 20 − 30 → 0, 20 − 10 → 10; "sum": the whole 20)
//   - a paragraph kept with the next is placed where the flow will put it (its space before overlapped), so a chain that
//     fits with the overlap stays on the page
//   - a document of our own (no wordSpacing: spacings add up) written to a new DOCX says so to Word
//     (w:doNotUseHTMLParagraphAutoSpacing), so Word and Omniweave reopened draw the gaps it had
//   - the new DOCX writer puts w:jc only on tables that had an alignment
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { reflowPages } from "../src/core/flow";
import { bodyBox } from "../src/core/pageSetup";
import { layoutText } from "../src/core/text";
import { newPage, newParagraph, newTable, newText, type Page, type TableNode, type TextNode, type TextParagraph } from "../src/core/types";
import { formatForExt } from "../src/io/formats";
import { docxTableXml, exportDocx } from "../src/io/office";
import { installDom } from "./coverage/helpers";

beforeAll(installDom);

const PT = 96 / 72;
const para = (s: string, extra: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(s, { fontSize: 16 }), ...extra });

function flowDoc(paras: TextParagraph[], ws?: TextNode["wordSpacing"]): Page[] {
  const p = newPage("DOCUMENT", 794, 1123, "1");
  const box = bodyBox(p);
  const t = newText("", box.w);
  t.paragraphs = paras;
  t.flow = true;
  if (ws) t.wordSpacing = ws;
  t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
  p.nodes.push(t);
  return [p];
}
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow);
const lineTops = (p: Page) => frames(p).flatMap((f) => layoutText(f).lines.map((l) => f.transform.y + l.y));
const open = async (name: string, bytes?: Uint8Array) => {
  const r = (await formatForExt("docx")!.open({ name, path: null, bytes: bytes ?? new Uint8Array(readFileSync(`qa/interop/word-made/${name}`)) }, {} as never)) as { doc?: { pages: Page[] }; pages?: Page[] };
  return (r.doc?.pages ?? r.pages)!;
};

describe("new section: the space before at the top of its first page (Word)", () => {
  it('"max": less the space after of the section\'s last paragraph; "sum": all of it', () => {
    for (const [ws, after, want] of [["max", 10, 14], ["max", 30, 0], ["max", 0, 24], ["sum", 10, 24]] as const) {
      const a = flowDoc([para("앞 구역", { spaceAfter: after })], ws);
      const b = flowDoc([para("새 구역 첫 문단", { spaceBefore: 24 })], ws);
      b[0].breakBefore = "section";
      const pages = reflowPages([...a, ...b]);
      expect(pages.length).toBe(2);
      expect(lineTops(pages[1])[0] - bodyBox(pages[1]).y, `${ws} ${after}`).toBeCloseTo(want, 3);
    }
  });

  it("Word references omni-fid-spacing-sect(-sum): headings on pages 2–5 where Word's PDF has them", async () => {
    // section's last paragraph space after → heading space before 20 pt (D: 6 pt): Word 2021 PDF line tops
    // "max": A 4 → 16 pt, B 30 → 0, C 10 → 10, D 10 → 0;  "sum": 20, 20, 20, 6
    for (const [name, want] of [["omni-fid-spacing-sect.docx", [16, 0, 10, 0]], ["omni-fid-spacing-sect-sum.docx", [20, 20, 20, 6]]] as const) {
      const pages = await open(name);
      expect(pages.length).toBe(5);
      for (let k = 1; k <= 4; k++) {
        const f = frames(pages[k]).sort((x, y) => x.transform.y - y.transform.y)[0];
        const top = f.transform.y + layoutText(f).lines[0].y;
        expect((top - bodyBox(pages[k]).y) / PT, `${name} page ${k + 1}`).toBeCloseTo(want[k - 1], 1);
      }
    }
  });
});

describe("keep with next counts the overlapped space before (Word)", () => {
  it("a heading and the next paragraph's first lines that fit with the overlap stay on the page", () => {
    const H = bodyBox(newPage("DOCUMENT", 794, 1123, "1")).h;
    const head = para("제목", { spaceBefore: 20, spaceAfter: 4, keepNext: true });
    const body = para("본문 한 줄", { spaceAfter: 0 });
    const lh = (q: TextParagraph) => layoutText({ ...newText("", 400), paragraphs: [q] }).lines[0].height;
    const first = para("앞 문단", { spaceAfter: 0 });
    // the room left below the first paragraph: the heading (its 20 overlapped by the 30 above) and one body line + 2
    const need = lh(head) + 4 + lh(body);
    first.spaceAfter = H - lh(first) - need - 2;
    expect(first.spaceAfter).toBeGreaterThan(30);
    const pages = reflowPages(flowDoc([first, head, body], "max"));
    expect(pages.length).toBe(1);
    // "sum": the heading's 20 adds up and the chain goes to the next page
    const sum = reflowPages(flowDoc([{ ...first }, { ...head }, { ...body }], "sum"));
    expect(sum.length).toBe(2);
  });
});

describe("a new DOCX keeps the spacing rule it was drawn with", () => {
  const doc = (): Page[] => flowDoc([para("첫 문단", { spaceAfter: 10 }), para("둘째 문단", { spaceBefore: 20, spaceAfter: 10 }), para("셋째 문단", { spaceBefore: 20 })]);
  const settings = (bytes: Uint8Array) => {
    const f = unzipSync(bytes)["word/settings.xml"];
    return f ? strFromU8(f) : "";
  };

  it("a document of our own (spacings add up): written with w:doNotUseHTMLParagraphAutoSpacing, reopened the same", async () => {
    const pages = reflowPages(doc());
    const before = lineTops(pages[0]).map((y) => y - bodyBox(pages[0]).y);
    const bytes = exportDocx(pages);
    expect(settings(bytes)).toContain("doNotUseHTMLParagraphAutoSpacing");
    const back = await open("own.docx", bytes);
    expect(frames(back[0])[0].wordSpacing).toBe("sum");
    const after = lineTops(back[0]).map((y) => y - bodyBox(back[0]).y);
    expect(after.length).toBe(before.length);
    // (within half a pixel: twips and the importer's line metrics; a "max" reopen would be 10 pt = 13.3 px higher)
    after.forEach((y, i) => expect(y).toBeCloseTo(before[i], 0));
  });

  it('a Word document ("max") written anew: no compat option, reopened "max"', async () => {
    const pages = await open("omni-fid-spacing.docx");
    const bytes = exportDocx(pages);
    expect(settings(bytes)).not.toContain("doNotUseHTMLParagraphAutoSpacing");
    expect(frames((await open("again.docx", bytes))[0])[0].wordSpacing).toBe("max");
    // the "sum" one keeps its option
    const sum = exportDocx(await open("omni-fid-spacing-sum.docx"));
    expect(settings(sum)).toContain("doNotUseHTMLParagraphAutoSpacing");
    expect(frames((await open("again-sum.docx", sum))[0])[0].wordSpacing).toBe("sum");
  });

  it("w:jc only on a table that had an alignment", () => {
    const t: TableNode = newTable([["a", "b"]], [100, 100], "t");
    const p = () => "<w:p/>";
    expect(docxTableXml(t, p)).not.toContain("<w:jc ");
    expect(docxTableXml({ ...t, wordAlign: { jc: "center", left: 0 } }, p)).toContain('<w:jc w:val="center"/>');
    expect(docxTableXml({ ...t, wordAlign: { jc: "right", left: 0 } }, p)).toContain('<w:jc w:val="right"/>');
  });

  it("tables of omni-fid-table-ind: only the right / centred ones get an alignment (left + w:tblInd do not)", async () => {
    const pages = await open("omni-fid-table-ind.docx");
    const tables = pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
    expect(tables.map((t) => t.wordAlign?.jc ?? "left")).toEqual(["left", "right", "center", "center", "right", "left"]);
    // the hand-made jc + w:tblInd file: Word places them as without w:tblInd (Word 2021 PDF: same x)
    const jcind = (await open("omni-fid-table-jcind.docx")).flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
    expect(jcind.map((t) => Math.round(t.transform.x))).toEqual(tables.map((t) => Math.round(t.transform.x)));
  });
});

describe("the text box editor spaces paragraphs as the canvas does (RichTextEditor)", () => {
  // CSS margins of block siblings collapse to the larger one: that is Word's "max"; text whose spacings add up must not
  // collapse, or the box being typed in is shorter than the frame and the caret sits off the canvas's lines
  it('"max": margins (they collapse like Word); "sum" / none: padding (they add up)', async () => {
    const { styleParagraph } = await import("../src/ui/RichTextEditor");
    const p = para("둘째", { spaceBefore: 20, spaceAfter: 10 });
    for (const ws of ["max", "sum", undefined] as const) {
      // (a stand-in element: no DOM in these tests — only the inline style is looked at)
      const div = { style: {} as Record<string, string> };
      styleParagraph(div as unknown as HTMLElement, p, ws);
      const st = new Proxy(div.style, { get: (o, k: string) => o[k] ?? "" });
      if (ws === "max") expect([st.marginTop, st.marginBottom, st.paddingTop, st.paddingBottom]).toEqual(["20px", "10px", "", ""]);
      else expect([st.marginTop, st.marginBottom, st.paddingTop, st.paddingBottom], String(ws)).toEqual(["", "", "20px", "10px"]);
    }
  });
});

describe("editing a Word document keeps the spacing on screen and in the file", () => {
  /** every body line: page index and top (px from the page) */
  const lines = (pages: readonly Page[]) => pages.flatMap((p, k) => frames(p).flatMap((f) => layoutText(f).lines.map((l) => [k, Math.round((f.transform.y + l.y) * 10) / 10] as const)));

  it("split, join and type in omni-fid-spacing(-sum): the edited pages lay out again the same and reopen from the save the same", async () => {
    const { segmentAt, gatherStory, reanchor, reflowSegment } = await import("../src/core/flow");
    const RT = await import("../src/core/richtext");
    const { sameTypeExport } = await import("../src/io/formats");
    for (const name of ["omni-fid-spacing.docx", "omni-fid-spacing-sum.docx"]) {
      let pages = await open(name);
      const edits: ((ps: TextParagraph[]) => TextParagraph[])[] = [
        // Enter in the middle of the long body paragraph (the new one takes its spacing), …
        (ps) => RT.splitParagraph(ps, { p: ps.findIndex((q) => RT.paraText(q).length > 100), o: 40 }).paras,
        // … Backspace at the start of the heading (joined into the paragraph above), …
        (ps) => RT.deleteChar(ps, { p: ps.findIndex((q) => q.runs.map((r) => r.text).join("").startsWith("2.")), o: 0 }, -1).paras,
        // … and typing a new paragraph after the first
        (ps) => RT.insertText(RT.splitParagraph(ps, { p: 0, o: ps[0].runs.map((r) => r.text).join("").length }).paras, { p: 1, o: 0 }, "새 문단 New").paras,
      ];
      for (const edit of edits) {
        const seg = segmentAt(pages, 0);
        const st = gatherStory(pages, seg);
        const paras = edit(st.paras);
        expect(paras).not.toBe(st.paras);
        pages = reflowSegment(pages, seg.start, { ...st, paras, objs: reanchor(st.objs, st.paras, paras) });
      }
      // laid out once more from what is on the pages: nothing moves
      expect(lines(reflowPages(pages)), name).toEqual(lines(pages));
      // saved in its own format and opened again: the same lines
      const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: {} } as never;
      const page = pages.find((p) => p.source) ?? pages[0];
      let out = await sameTypeExport(page)!.run(doc, page, { confirm: () => true } as never);
      if (typeof out === "string") out = new TextEncoder().encode(out);
      const back = await open(`re-${name}`, out as Uint8Array);
      const a = lines(pages), b = lines(back);
      expect(b.length, name).toBe(a.length);
      b.forEach(([k, y], i) => {
        expect(k, `${name} line ${i}`).toBe(a[i][0]);
        expect(y, `${name} line ${i}`).toBeCloseTo(a[i][1], 0);
      });
    }
  });
});
