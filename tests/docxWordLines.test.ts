// Word line rules measured against Word 2021 PDFs (docs/design/FIDELITY_DOCX.md 7): the exact body width, the baseline of
// Word multiples, character spacing on half-width spaces, and spaces that never start a line.
import { describe, expect, it } from "vitest";
import { wordAscent, withWordMultiple } from "../src/core/lineSpacing";
import { layoutText, measure, runFont } from "../src/core/text";
import { DEFAULT_RUN, newParagraph, newText, type TextNode, type TextParagraph } from "../src/core/types";
import { docxSetup } from "../src/io/office";
import { DOMParser } from "@xmldom/xmldom";

const PT = 96 / 72;
const node = (paras: TextParagraph[], width = 400, extra: Partial<TextNode> = {}): TextNode => ({ ...newText("", width), paragraphs: paras, wordBreak: "normal", ...extra });

describe("Word line rules (DOCX)", () => {
  it("keeps the exact page size of the twips (A4 = 793.73 px, not the 794 px preset)", () => {
    const d = new DOMParser().parseFromString('<w:sectPr xmlns:w="w"><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>', "text/xml");
    const s = docxSetup(d.documentElement as unknown as Element);
    expect([s.width, s.height]).toEqual([793.73, 1122.53]);
    // the body is Word's 9026 twips = 451.3 pt
    expect((s.width - s.margins.left - s.margins.right) / PT).toBeCloseTo(451.3, 2);
  });

  it("puts the baseline of a Word multiple where the font's single line has it (the extra room goes below)", () => {
    const size = 10 * PT;
    const p = withWordMultiple({ ...newParagraph("굴림 본문 Gulim", { fontSize: size, fontFamily: "굴림", latinFont: "Arial" }), spaceAfter: 0 }, 1.5);
    const l = layoutText(node([p])).lines[0];
    expect(l.height).toBeCloseTo(size * 1.3 * 1.5, 3);
    // 굴림: win ascent 0.8584 + half of the 30 % → 1.0084 em (Word PDF: first baseline 10.1 pt below the margin)
    expect(l.baseline).toBeCloseTo(size * 1.0084, 3);
    expect(wordAscent([{ fontFamily: "맑은 고딕", fontSize: 11 }], "가")).toBeCloseTo(11 * 1.2879, 3);
    expect(wordAscent([{ fontFamily: "Unknown Sans", fontSize: 11 }], "a")).toBeUndefined();
  });

  it("gives a half-width space next to Hangul the run's character spacing twice", () => {
    const run = { ...DEFAULT_RUN, fontFamily: "맑은 고딕", fontSize: 10 * PT, letterSpacing: -0.5 * PT };
    const p: TextParagraph = { ...newParagraph(""), runs: [{ ...run, text: "가 나" }], spaceAfter: 0 };
    const [a, sp] = layoutText(node([p], 400, { cjkSpace: "half" })).lines[0].pieces;
    const font = a.font;
    // "가 " = syllable + spacing, then the half space (5 pt) with the spacing twice
    expect(sp.x - a.x).toBeCloseTo(measure("가", font) + run.letterSpacing + 5 * PT + 2 * run.letterSpacing, 3);
  });

  it("never starts a line with a run that is only spaces", () => {
    // the full stop hangs past the end (w:overflowPunct), so the line is already past it when the space run comes
    const r = (text: string) => ({ ...DEFAULT_RUN, fontFamily: "맑은 고딕", fontSize: 13.3, text });
    const w = measure("가나다라", runFont(r("")));
    const p: TextParagraph = { ...newParagraph(""), runs: [r("가나다라."), r(" "), r("바사")], spaceAfter: 0 };
    const lines = layoutText(node([p], w + 0.1, { hangPunct: true })).lines;
    expect(lines.map((l) => l.pieces.map((x) => x.text).join(""))).toEqual(["가나다라. ", "바사"]);
  });

  it("keeps the font's baseline at the edges: an at-least line equal to the single line, an empty Word-multiple line", () => {
    const size = 10 * PT;
    const base = { fontSize: size, fontFamily: "굴림", latinFont: "Arial" };
    // 굴림 10 pt single line = 13 pt = 260 twips: at least 259 and at least 260 are the same single line
    const atLeast = (tw: number) => layoutText(node([{ ...newParagraph("가나 다", base), spaceAfter: 0, lineHeight: { mode: "atLeast", v: { v: tw, u: "twip" }, basis: "font" } }])).lines[0];
    expect(atLeast(260).height).toBeCloseTo(atLeast(259).height, 3);
    expect(atLeast(260).baseline).toBeCloseTo(atLeast(259).baseline, 3);
    expect(atLeast(260).baseline).toBeCloseTo(size * 1.0084, 3);
    // an empty paragraph (its mark's font) has the baseline of a line with text in that font
    const line = (t: string) => layoutText(node([withWordMultiple({ ...newParagraph(t, base), spaceAfter: 0 }, 1.5)])).lines[0];
    expect(line("").height).toBeCloseTo(line("가").height, 3);
    expect(line("").baseline).toBeCloseTo(line("가").baseline, 3);
  });
});
