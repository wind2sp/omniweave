// Word's paragraph spacing and page tops (docs/design/FIDELITY_DOCX.md 8), measured on Word 2021 PDFs:
//   - without compat w:doNotUseHTMLParagraphAutoSpacing (every new Word document) the gap between two paragraphs is the
//     larger of space after and space before, with it their sum (TextNode.wordSpacing "max" / "sum")
//   - a paragraph that begins a page after a page break (natural, hard, 'page break before') loses its space before
//   - a page's last line may run the room a multiple line spacing adds below its text past the bottom margin
//   - a centred / right-aligned table counts half its left border (TableNode.wordAlign, core/flow.ts tableShift)
//   - no header part: the header distance does not push the body (core/headerFooter.ts hfPush)
// Word references: qa/interop/word-made/omni-fid-spacing(.docx/.pdf) and omni-fid-spacing-sum
// (qa/interop/scripts/word_make_fidelity4.ps1).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { reflowPages, tableShift } from "../src/core/flow";
import { bodyBox } from "../src/core/pageSetup";
import { layoutText } from "../src/core/text";
import { withWordMultiple } from "../src/core/lineSpacing";
import { hfPush } from "../src/core/headerFooter";
import { newPage, newParagraph, newTable, newText, type Page, type TableNode, type TextNode, type TextParagraph } from "../src/core/types";
import { formatForExt } from "../src/io/formats";
import { installDom } from "./coverage/helpers";

beforeAll(installDom);

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
/** page-relative top of every line of the page's body frames */
const lineTops = (p: Page) => frames(p).flatMap((f) => layoutText(f).lines.map((l) => f.transform.y + l.y));

describe("Word paragraph spacing (TextNode.wordSpacing)", () => {
  it('"max": space after 8 + space before 16 → 16 between the lines\' boxes; "sum" and none → 24', () => {
    const node = (ws?: TextNode["wordSpacing"]): TextNode => ({ ...newText("", 400), paragraphs: [para("가나다", { spaceAfter: 8 }), para("라마바", { spaceBefore: 16 })], ...(ws ? { wordSpacing: ws } : {}) });
    const none = layoutText(node()), sum = layoutText(node("sum")), max = layoutText(node("max"));
    const gap = (l: typeof none) => l.lines[1].y - (l.lines[0].y + l.lines[0].height);
    expect(gap(none)).toBeCloseTo(24, 6);
    expect(gap(sum)).toBeCloseTo(24, 6);
    expect(gap(max)).toBeCloseTo(16, 6);
    expect(max.height).toBeCloseTo(none.height - 8, 6);
    // the larger space after wins too (after 20, before 5 → 20)
    const t: TextNode = { ...newText("", 400), wordSpacing: "max", paragraphs: [para("가", { spaceAfter: 20 }), para("나", { spaceBefore: 5 })] };
    const l = layoutText(t);
    expect(l.lines[1].y - (l.lines[0].y + l.lines[0].height)).toBeCloseTo(20, 6);
  });

  it("the body flow places paragraphs where the frame draws them, and drops the space before at the top of later pages", () => {
    const paras = Array.from({ length: 60 }, (_, i) => para(`문단 ${i}`, { spaceBefore: 20, spaceAfter: 10 }));
    for (const ws of ["max", "sum", undefined] as const) {
      const pages = reflowPages(flowDoc(paras.map((p) => ({ ...p })), ws));
      expect(pages.length).toBeGreaterThan(1);
      const box = bodyBox(pages[0]);
      const tops = pages.map(lineTops);
      // page 1: the first paragraph keeps its space before
      expect(tops[0][0]).toBeCloseTo(box.y + 20, 3);
      // line pitch: line + max(10, 20) or line + 30
      const lh = layoutText(frames(pages[0])[0]).lines[0].height;
      expect(tops[0][1] - tops[0][0]).toBeCloseTo(lh + (ws === "max" ? 20 : 30), 3);
      // page 2 begins with a whole paragraph: Word drops its space before (not for documents of our own)
      expect(tops[1][0]).toBeCloseTo(box.y + (ws ? 0 : 20), 3);
      // every line inside the body
      for (const [k, t] of tops.entries()) for (const y of t) expect(y).toBeLessThan(bodyBox(pages[k]).y + bodyBox(pages[k]).h);
    }
  });

  // (QA: a new section keeps what the space after of the section before does not already give — 24 − 10, Word 2021 PDF
  // omni-fid-spacing-sect; tests/docxSpacingQa.test.ts)
  it("after a hard page break the run's first paragraph loses its space before; a new section keeps it", () => {
    for (const brk of [undefined, "section"] as const) {
      const a = flowDoc([para("앞 쪽", { spaceAfter: 10 })], "max");
      const b = flowDoc([para("쪽 나눔 뒤", { spaceBefore: 24 })], "max");
      if (brk) b[0].breakBefore = brk;
      const pages = reflowPages([...a, ...b]);
      expect(pages.length).toBe(2);
      expect(lineTops(pages[1])[0]).toBeCloseTo(bodyBox(pages[1]).y + (brk ? 24 - 10 : 0), 3);
    }
  });

  it("a last line whose multiple-spacing room alone runs past the bottom stays on the page (Word)", () => {
    // line spacing 2 × the single line: half of each line is room below the text
    const mk = () => Array.from({ length: 80 }, (_, i) => withWordMultiple(para(`줄 ${i}`, { spaceAfter: 0 }), 2));
    const lh = layoutText({ ...newText("", 400), paragraphs: [mk()[0]] }).lines[0].height;
    const H = bodyBox(newPage("DOCUMENT", 794, 1123, "1")).h;
    const perPage = (ws?: TextNode["wordSpacing"]) => frames(reflowPages(flowDoc(mk(), ws))[0]).reduce((s, f) => s + f.paragraphs.length, 0);
    expect(perPage()).toBe(Math.floor(H / lh + 1e-6));
    expect(perPage("sum")).toBe(Math.floor((H - lh / 2) / lh + 1e-6) + 1);
  });
});

describe("Word table alignment (TableNode.wordAlign)", () => {
  it("centred: (column − table) / 2 + a quarter of the left border; right: column − table − half of it", () => {
    const t: TableNode = { ...newTable([[{ text: "a" }]], [400], "t") };
    expect(tableShift(t, 600)).toBe(0);
    expect(tableShift({ ...t, wordAlign: { jc: "center", left: 6 } }, 600)).toBeCloseTo(101.5, 6);
    expect(tableShift({ ...t, wordAlign: { jc: "right", left: 0.67 } }, 600)).toBeCloseTo(199.67, 2);
  });
});

describe("Word references (omni-fid-spacing)", () => {
  const open = async (name: string) =>
    (await formatForExt("docx")!.open({ name, path: null, bytes: new Uint8Array(readFileSync(`qa/interop/word-made/${name}`)) }, {} as never)) as { doc?: { pages: Page[] } } & { pages?: Page[] };
  const pagesOf = (r: Awaited<ReturnType<typeof open>>) => (r.doc?.pages ?? r.pages)!;

  it("a new Word document draws the larger spacing, the compat option the sum; tables keep their alignment", async () => {
    for (const [name, ws] of [["omni-fid-spacing.docx", "max"], ["omni-fid-spacing-sum.docx", "sum"]] as const) {
      const pages = pagesOf(await open(name));
      const body = pages.flatMap(frames);
      expect(body.length).toBeGreaterThan(0);
      for (const f of body) expect(f.wordSpacing).toBe(ws);
      const tables = pages.flatMap((p) => p.nodes.filter((n): n is TableNode => n.type === "TABLE"));
      const aligns = tables.map((t) => t.wordAlign?.jc);
      expect(aligns).toContain("center");
      expect(aligns).toContain("right");
      // the centred table's 4.5 pt left border = 6 px; the right table's left border is 0.5 pt
      expect(tables.find((t) => t.wordAlign?.jc === "center")!.wordAlign!.left).toBeCloseTo(6, 2);
      expect(tables.find((t) => t.wordAlign?.jc === "right")!.wordAlign!.left).toBeCloseTo(0.67, 2);
      // no header part: the 42.6 pt header distance under a 36 pt top margin does not push the body
      expect(hfPush(pages, 0)).toEqual({ top: 0, bottom: 0 });
      // centred in the 523.3 pt column: (523.3 − 380) / 2 + 4.5 / 4 pt from the margin (Word PDF: cell edge 108.77 pt)
      const box = bodyBox(pages[0]);
      const centred = pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE" && n.wordAlign?.jc === "center")!;
      expect(((centred.transform.x - box.x) * 72) / 96).toBeCloseTo(108.77 - 36, 0);
    }
  });
});
