// docx-flow (2026-11-21): the shared flow engine where Word's PDFs and Omniweave differed, measured on Word 2021 PDFs
// (scripts/fidelity-docx.mjs, with --doc for DOC):
//   - the empty paragraph holding a section break before a continuous section lays out no line, and the next section's
//     first paragraph gives up that paragraph's space after (omni-fid-spacing-top / -top14 / -sect / -sect-sum)
//   - a left-aligned table stands at its w:tblInd (negative too), in compatibility mode 14 and before less the left cell
//     margin; a table wider than the column keeps its grid and runs into the margins (omni-fid-table-ind)
//   - keep with next through a table: a table whose rows are all kept with the next moves on with what follows it
//     (word_doc.doc: heading, table, heading and picture go to page 2 together)
//   - a DOC paragraph of nothing but a page break has its paragraph mark at the top of the next page
//   - Word's page number frame stands beside the footer's first line, not below it
//   - the highlight of a centred / right line's last word is drawn whole
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { reflowPages, tableShift } from "../src/core/flow";
import { hfNodesAt } from "../src/core/headerFooter";
import { bodyBox } from "../src/core/pageSetup";
import { layoutText, shadeWidth, spacingOverlap } from "../src/core/text";
import { newPage, newParagraph, newTable, newText, type Page, type TableNode, type TextNode, type TextParagraph } from "../src/core/types";
import { formatForExt } from "../src/io/formats";
import { docRichOpen } from "../src/io/formats/docRich";
import { installDom } from "./coverage/helpers";

beforeAll(installDom);

const PT = 96 / 72;
const para = (s: string, extra: Partial<TextParagraph> = {}): TextParagraph => ({ ...newParagraph(s, { fontSize: 16 }), ...extra });
const textOf = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const frames = (p: Page) => p.nodes.filter((n): n is TextNode => n.type === "TEXT" && !!n.flow);
const tablesOf = (pages: Page[]) => pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
const open = async (name: string) => {
  const bytes = new Uint8Array(readFileSync(`qa/interop/word-made/${name}`));
  const r = (await formatForExt("docx")!.open({ name, path: null, bytes }, {} as never)) as { doc?: { pages: Page[] }; pages?: Page[] };
  return (r.doc?.pages ?? r.pages)!;
};
const wordDoc = () => docRichOpen(new Uint8Array(readFileSync("qa/interop/adobe-made/word_doc.doc")), "word_doc.doc").pages;

function frameOf(paras: TextParagraph[], ws?: TextNode["wordSpacing"]): TextNode {
  const t = newText("", 600);
  t.paragraphs = paras;
  if (ws) t.wordSpacing = ws;
  return t;
}

describe("Word's continuous section break mark (TextParagraph.sectMark)", () => {
  it("lays out no line; the next paragraph's space before gives up the mark's space after", () => {
    // Word 2021 PDFs (omni-fid-spacing-sect F, -top 2.): after 10, mark after 4 / 10, heading before 20
    for (const [ws, markAfter, want] of [["max", 4, 26], ["max", 10, 20], ["sum", 4, 30], ["max", 30, 40]] as const) {
      const a = para("앞 문단", { spaceAfter: 10 });
      const mark = para("", { spaceAfter: markAfter, sectMark: true });
      const h = para("제목", { spaceBefore: 20, spaceAfter: 4 });
      const lay = layoutText(frameOf([a, mark, h], ws));
      const la = lay.lines.find((l) => l.paragraph === 0)!;
      const lm = lay.lines.find((l) => l.paragraph === 1)!;
      const lh = lay.lines.find((l) => l.paragraph === 2)!;
      expect(lm.height, `${ws} ${markAfter}`).toBe(0);
      expect(lh.y - (la.y + la.height), `${ws} ${markAfter}`).toBeCloseTo(want, 6);
    }
  });

  it("an empty paragraph without the mark, or the mark with text, is an ordinary line", () => {
    const a = para("앞 문단", { spaceAfter: 10 });
    const h = para("제목", { spaceBefore: 20 });
    const plain = layoutText(frameOf([a, para("", { spaceAfter: 4 }), h], "max"));
    const typed = layoutText(frameOf([a, para("글", { spaceAfter: 4, sectMark: true }), h], "max"));
    expect(plain.lines[1].height).toBeGreaterThan(10);
    expect(typed.lines[1].height).toBeCloseTo(plain.lines[1].height, 6);
    expect(spacingOverlap({ wordSpacing: "max" }, para("", { sectMark: true, spaceAfter: 4 }), h)).toBe(8);
    expect(spacingOverlap({ wordSpacing: "sum" }, para("", { sectMark: true, spaceAfter: 4 }), h)).toBe(4);
    expect(spacingOverlap({ wordSpacing: "sum" }, para("", { spaceAfter: 4 }), h)).toBe(0);
  });

  it("DOCX import marks the empty section-break paragraph before a continuous section only", async () => {
    for (const name of ["omni-fid-spacing-top.docx", "omni-fid-spacing-sect.docx"]) {
      const pages = await open(name);
      const ps = pages.flatMap((p) => frames(p).flatMap((f) => f.paragraphs));
      const marks = ps.filter((p) => p.sectMark);
      expect(marks.length, name).toBe(1);
      expect(textOf(marks[0])).toBe("");
      // the heading after it is where Word's PDF has it: one line and the mark's space after higher than before
      const next = ps[ps.indexOf(marks[0]) + 1];
      expect(textOf(next), name).toMatch(/^(2\.|F\.)/);
    }
  });
});

describe("Word table position (w:tblInd, wide tables)", () => {
  it("left tables at their indent, wide centred / right ones into the margins (omni-fid-table-ind, Word 2021 PDF)", async () => {
    const pages = await open("omni-fid-table-ind.docx");
    const box = bodyBox(pages[0]);
    const xs = tablesOf(pages).map((t) => (t.transform.x - box.x) / PT);
    // A: tblInd 36 pt; D: 600 pt centred in 523.3 pt; E: 600 pt set right; F: tblInd −18 pt
    // (QA docx-flow: mode 15 measures w:tblInd to the middle of the ½ pt left border — Word PDF text at 77.24 pt =
    // 36 + 36 + 4.95 + 0.29)
    expect(xs[0]).toBeCloseTo(36.25, 1);
    expect(xs[3]).toBeCloseTo((523.28 - 600) / 2, 0);
    expect(xs[4]).toBeCloseTo(523.28 - 600, 0);
    expect(xs[5]).toBeCloseTo(-17.75, 1);
    // the grid is kept (600 pt), not scaled into the column
    expect(tablesOf(pages)[3].colWidths.reduce((s, c) => s + c, 0) / PT).toBeCloseTo(600, 0);
  });

  it("compatibility mode 14: the table's text at the margin (cell edge a left cell margin into it)", async () => {
    const pages = await open("omni-fid-spacing-top14.docx");
    const t = tablesOf(pages)[0];
    expect((t.transform.x - bodyBox(pages.find((p) => p.nodes.includes(t))!).x) / PT).toBeCloseTo(-99 / 20, 1);
    expect(tableShift({ ...t, wordInd: undefined }, 600)).toBe(0);
  });
});

describe("keep with next through a table (Word)", () => {
  it("word_doc.doc: the heading, the table of kept rows and the heading after it go to page 2 together", () => {
    const pages = reflowPages(wordDoc());
    const pageOf = (pred: (n: TextNode | TableNode) => boolean) => pages.findIndex((p) => p.nodes.some((n) => (n.type === "TEXT" || n.type === "TABLE") && pred(n as TextNode | TableNode)));
    const hasPara = (re: RegExp) => (n: TextNode | TableNode) => n.type === "TEXT" && !!n.flow && n.paragraphs.some((p) => re.test(textOf(p)));
    const table = pageOf((n) => n.type === "TABLE");
    expect(table).toBe(1);
    expect(pageOf(hasPara(/^표 \/ Table/))).toBe(1);
    expect(pageOf(hasPara(/^그림 \/ Picture/))).toBe(1);
    expect(pageOf(hasPara(/번호 둘/))).toBe(0);
  });

  it("not for 한글's rules (no wordSpacing): the table stays", () => {
    const p = newPage("DOCUMENT", 794, 1123, "1");
    const box = bodyBox(p);
    const t = newText("", box.w);
    t.flow = true;
    t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    t.paragraphs = [...Array.from({ length: 30 }, (_, i) => para(`문단 ${i}`)), para("제목", { keepNext: true })];
    const tb = newTable([[{ text: "칸", richText: [para("칸", { keepNext: true })] }]], [200], "표");
    tb.flow = true;
    tb.transform = { x: box.x, y: box.y + 900, rotation: 0, scale: 1 };
    p.nodes.push(t, tb);
    const out = reflowPages([p]);
    const at = out.findIndex((pg) => pg.nodes.some((n) => n.type === "TABLE"));
    const head = out.findIndex((pg) => frames(pg).some((f) => f.paragraphs.some((q) => textOf(q) === "제목")));
    expect(at).toBe(head);
  });
});

describe("DOC page break paragraph and page number frame", () => {
  it("a paragraph of nothing but a page break: its mark at the top of the next page (word_doc.doc page 3)", () => {
    const pages = reflowPages(wordDoc());
    const first = frames(pages[2])[0].paragraphs;
    expect(textOf(first[0])).toBe("");
    expect(textOf(first[1])).toMatch(/^두 번째 쪽/);
  });

  it("the page number frame stands at the top of the footer, beside its first line", () => {
    const pages = reflowPages(wordDoc());
    const nodes = hfNodesAt({ pages, title: "word_doc" }, 0);
    const foot = nodes.find((n) => n.id.endsWith(":footer"))!;
    const pn = nodes.find((n) => n.id.endsWith(":pagenum"))!;
    expect(pn.transform.y).toBeCloseTo(foot.transform.y, 6);
  });
});

describe("highlight of a centred line's last word", () => {
  it("is the piece's own width less its trailing spaces", () => {
    const run = { highlight: "#FFFF00" };
    for (const align of ["CENTER", "RIGHT", "LEFT"] as const) {
      const p = { ...para("가운데 정렬 Center"), align };
      p.runs = p.runs.map((r) => ({ ...r, ...run }));
      const lay = layoutText(frameOf([p]));
      const line = lay.lines[0];
      const last = line.pieces[line.pieces.length - 1];
      expect(shadeWidth(line, last), align).toBeCloseTo(last.width, 6);
      const q = { ...para("가운데 정렬 Center "), align };
      const l2 = layoutText(frameOf([q])).lines[0];
      const lp = l2.pieces[l2.pieces.length - 1];
      expect(shadeWidth(l2, lp), align).toBeLessThan(lp.width);
      expect(shadeWidth(l2, lp), align).toBeGreaterThan(lp.width / 2);
    }
  });
});
