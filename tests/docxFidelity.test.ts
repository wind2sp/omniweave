// Word fidelity (docs/design/FIDELITY_DOCX.md): DOCX read through Word's style hierarchy with per-script fonts, and
// the line-breaking rules Word applies to Korean documents (measured in Word 2021 against its own PDF).
import { beforeAll, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseDocx, parseDocxFlow, type OfficeImportReport } from "../src/io/office";
import { officePages } from "../src/io/formats/flow";
import { applyPatch } from "../src/core/richtext";
import { cssFamily, cssFont, layoutText, setMeasure, tokenize, type MeasureFn } from "../src/core/text";
import { wordLineHeight } from "../src/core/lineSpacing";
import { DEFAULT_RUN, newParagraph, newText, type TextNode, type TextParagraph, type TextRun } from "../src/core/types";
import { installDom } from "./coverage/helpers";

beforeAll(installDom);

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const docx = (body: string, styles = "", settings = "") =>
  zipSync({
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
    ...(styles ? { "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles ${W}>${styles}</w:styles>`) } : {}),
    ...(settings ? { "word/settings.xml": strToU8(`<?xml version="1.0"?><w:settings ${W}>${settings}</w:settings>`) } : {}),
  });
const KOREAN_NORMAL =
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="맑은 고딕" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/><w:pPr><w:widowControl w:val="0"/><w:wordWrap w:val="0"/></w:pPr></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="a"/><w:pPr><w:spacing w:before="200"/><w:ind w:left="864"/><w:jc w:val="center"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>` +
  `<w:style w:type="character" w:styleId="Strong"><w:name w:val="Strong"/><w:rPr><w:b/></w:rPr></w:style>`;

describe("DOCX through Word's style hierarchy (model 6)", () => {
  it("document defaults and the default paragraph style apply to plain paragraphs (justified, 8 pt after, Word multiple)", () => {
    const [p] = parseDocx(docx(`<w:p><w:r><w:t>가나다 abc</w:t></w:r></w:p>`, KOREAN_NORMAL));
    expect(p.align).toBe("JUSTIFY");
    expect(p.spaceAfter).toBeCloseTo((160 / 20) * (96 / 72), 3);
    expect(p.lineMultiple?.v).toBeCloseTo(259 / 240, 6);
    expect(p.runs[0]).toMatchObject({ fontFamily: "맑은 고딕", latinFont: "Calibri" });
    expect(p.runs[0].fontSize).toBeCloseTo(11 * (96 / 72), 2);
  });
  it("paragraph style chain, character style and run properties merge attribute by attribute", () => {
    const [p] = parseDocx(
      docx(
        `<w:p><w:pPr><w:pStyle w:val="Quote"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:rStyle w:val="Strong"/><w:rFonts w:ascii="Arial"/></w:rPr><w:t>굵게 Bold</w:t></w:r></w:p>`,
        KOREAN_NORMAL,
      ),
    );
    expect(p.align).toBe("CENTER");
    expect(p.spaceAfter).toBe(0);
    expect(p.spaceBefore).toBeCloseTo((200 / 20) * (96 / 72), 3);
    expect(p.indentLeft).toBeCloseTo((864 / 20) * (96 / 72), 2);
    expect(p.lineMultiple?.v).toBeCloseTo(259 / 240, 6); // the line from the document defaults
    // run: Latin font from the run, East Asian font from the defaults, bold from the character style, italic and colour from the paragraph style
    expect(p.runs[0]).toMatchObject({ fontFamily: "맑은 고딕", latinFont: "Arial", bold: true, italic: true, color: "#404040" });
  });
  it("no w:after anywhere is Word's 0 (the importer before used 6 px)", () => {
    const [p] = parseDocx(docx(`<w:p><w:r><w:t>x</w:t></w:r></w:p>`, `<w:style w:type="paragraph" w:default="1" w:styleId="a"><w:name w:val="Normal"/></w:style>`));
    expect(p.spaceAfter).toBe(0);
  });
  it("theme fonts: +본문 Latin and East Asian from the theme", () => {
    const theme = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:fontScheme name="x"><a:majorFont><a:latin typeface="Cambria"/><a:ea typeface=""/><a:font script="Hang" typeface="바탕"/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:font script="Hang" typeface="맑은 고딕"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
    const z = zipSync({
      "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W}><w:body><w:p><w:r><w:t>가 a</w:t></w:r></w:p></w:body></w:document>`),
      "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:asciiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:hAnsiTheme="minorHAnsi"/><w:lang w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`),
      "word/theme/theme1.xml": strToU8(theme),
    });
    expect(parseDocx(z)[0].runs[0]).toMatchObject({ fontFamily: "맑은 고딕", latinFont: "Calibri" });
  });
  it("a heading style styles.xml does not define keeps the old guess (larger, bold)", () => {
    const [h] = parseDocx(docx(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>T</w:t></w:r></w:p>`, KOREAN_NORMAL));
    expect(h.runs[0].bold).toBe(true);
    expect(h.runs[0].fontSize).toBeGreaterThan(11 * (96 / 72));
  });
  it("Korean Normal (w:wordWrap 0, balanced spaces, hanging punctuation) → the body text nodes break Hangul anywhere", () => {
    const report: OfficeImportReport = { notesDropped: 0 };
    const items = parseDocxFlow(docx(`<w:p><w:r><w:t>가나다</w:t></w:r></w:p>`, KOREAN_NORMAL, `<w:compat><w:balanceSingleByteDoubleByteWidth/></w:compat>`), report);
    expect(report.layout).toMatchObject({ wordBreak: "normal", cjkSpace: "half", hangPunct: true });
    const t = officePages(items, "t", report.layout)[0].nodes.find((n) => n.type === "TEXT") as TextNode;
    expect(t).toMatchObject({ wordBreak: "normal", cjkSpace: "half", hangPunct: true });
  });
  it("export writes the Latin font back as w:ascii / w:hAnsi beside w:eastAsia", async () => {
    const { exportDocx } = await import("../src/io/office");
    const { newPage } = await import("../src/core/types");
    const pg = newPage("DOCUMENT", 794, 1123, "p");
    const t = newText("", 600);
    t.paragraphs = [{ ...newParagraph("가 a"), runs: [{ ...DEFAULT_RUN, text: "가 a", fontFamily: "맑은 고딕", latinFont: "Calibri" }] }];
    pg.nodes.push(t);
    const { strFromU8, unzipSync } = await import("fflate");
    const xml = strFromU8(unzipSync(exportDocx([pg]))["word/document.xml"]);
    expect(xml).toContain(`<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="맑은 고딕"/>`);
  });
});

describe("fonts by character range (core/text.ts)", () => {
  it("a Latin font first, then the East Asian one, then a system substitute — never Pretendard first for a file's font", () => {
    expect(cssFamily({ fontFamily: "맑은 고딕", latinFont: "Calibri" }).startsWith(`"Calibri", "맑은 고딕"`)).toBe(true);
    expect(cssFamily({ fontFamily: "바탕", latinFont: "Times New Roman" })).toMatch(/^"Times New Roman", "바탕", "Batang".*serif/);
    // a Korean Latin font goes after the East Asian one (Hangul keeps the East Asian font)
    expect(cssFamily({ fontFamily: "바탕", latinFont: "굴림" }).startsWith(`"바탕"`)).toBe(true);
    expect(cssFamily({ fontFamily: "Aptos" })).toMatch(/^"Aptos", "Calibri", "Malgun Gothic"/);
    // Omniweave's own text: Pretendard first, as before
    expect(cssFont({ ...DEFAULT_RUN })).toContain(`"Pretendard", "Noto Sans KR"`);
  });
  it("a new font drops the run's Latin font", () => {
    const r: TextRun = { ...DEFAULT_RUN, text: "a", fontFamily: "맑은 고딕", latinFont: "Calibri" };
    expect(applyPatch(r, { fontFamily: "궁서" }).latinFont).toBeUndefined();
    expect(applyPatch(r, { bold: true }).latinFont).toBe("Calibri");
  });
  it("Word line height: Latin text in the Latin font's line, Hangul in the East Asian font's", () => {
    const run = { fontFamily: "맑은 고딕", latinFont: "Calibri", fontSize: 10 };
    expect(wordLineHeight(1, [{ ...run, text: "abc" }], "abc")).toBeCloseTo(12.21, 2);
    expect(wordLineHeight(1, [{ ...run, text: "가나" }], "가나")).toBeCloseTo(17.29, 2);
  });
});

describe("line breaking (core/text.ts)", () => {
  // every character 10 px, a space 3 px (approximate measurer, independent of fonts)
  const fixed: MeasureFn = (s) => [...s].reduce((w, c) => w + (c === " " ? 3 : 10), 0);
  const lay = (runs: Partial<TextRun>[], width: number, extra: Partial<TextNode> = {}, para: Partial<TextParagraph> = {}) => {
    setMeasure(fixed);
    const t: TextNode = { ...newText("", width), ...extra, paragraphs: [{ ...newParagraph(""), lineSpacing: 1, spaceAfter: 0, ...para, runs: runs.map((r) => ({ ...DEFAULT_RUN, fontSize: 10, text: "", ...r })) }] };
    return layoutText(t).lines.map((l) => l.pieces.map((p) => p.text).join(""));
  };
  it("a word split over runs moves to the next line whole (no break at a run boundary)", () => {
    expect(lay([{ text: "aaa bb" }, { text: "cc", bold: true }], 70)).toEqual(["aaa ", "bbcc"]);
  });
  it("normal (Word wordWrap 0): Hangul breaks anywhere, closing punctuation never starts a line", () => {
    expect(tokenize("가나다.", "normal")).toEqual(["가", "나", "다."]);
    expect(lay([{ text: "가나다라." }], 40, { wordBreak: "normal" })).toEqual(["가나다", "라."]);
  });
  it("hanging punctuation: a closing comma may pass the line end", () => {
    expect(lay([{ text: "가나다, 라" }], 30, { wordBreak: "normal", hangPunct: true })[0]).toBe("가나다, ");
    expect(lay([{ text: "가나다, 라" }], 30, { wordBreak: "normal" })[0]).toBe("가나");
  });
  it("half-width spaces next to Hangul in an East Asian font (cjkSpace)", () => {
    setMeasure(fixed);
    const t: TextNode = { ...newText("", 500), cjkSpace: "half", paragraphs: [{ ...newParagraph(""), runs: [{ ...DEFAULT_RUN, fontFamily: "맑은 고딕", fontSize: 10, text: "가 나 a b" }] }] };
    const ps = layoutText(t).lines[0].pieces;
    // "가 " and "나 " get 5 px spaces (half of 10 px); the space between "a" and "b" keeps its 3 px
    expect(ps.map((p) => p.width)).toEqual([15, 15, 13, 10]);
  });
  it("justification goes into the spaces", () => {
    setMeasure(fixed);
    const t: TextNode = { ...newText("", 100), paragraphs: [{ ...newParagraph(""), align: "JUSTIFY", runs: [{ ...DEFAULT_RUN, fontSize: 10, text: "aa bb cc dd ee ff gg" }] }] };
    const l = layoutText(t).lines[0];
    const xs = l.pieces.map((p) => p.x);
    // equal gaps between words
    const gaps = xs.slice(1).map((x, i) => x - xs[i]);
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(0.001);
  });
  it("a comma in a run's own Latin font does not hang (Word: Arial ',' after 굴림 moves down with its syllable)", () => {
    expect(lay([{ text: "가나다, 라", fontFamily: "굴림", latinFont: "Arial" }], 30, { wordBreak: "normal", hangPunct: true })[0]).toBe("가나");
  });
  it("justifyShrink: a justified line keeps a word that overruns a little by shrinking its spaces", () => {
    // 6 words of 2 letters + 5 spaces = 135 px; the box is 132: 3 px over, the word 20 px (≤ 40 %), spaces 15 px (≤ 20 %)
    const words = [{ text: "aa bb cc dd ee ff gg" }];
    expect(lay(words, 132, { justifyShrink: true }, { align: "JUSTIFY" })[0]).toBe("aa bb cc dd ee ff ");
    expect(lay(words, 132, { justifyShrink: true }, { align: "JUSTIFY" })[0]).not.toContain("gg");
    expect(lay([{ text: "aa bb cc dd ee ff" }], 132, { justifyShrink: true }, { align: "JUSTIFY" })).toEqual(["aa bb cc dd ee ff"]);
    expect(lay([{ text: "aa bb cc dd ee ff" }], 132, {}, { align: "JUSTIFY" })).toEqual(["aa bb cc dd ee ", "ff"]);
  });
  it("autoSpace: a quarter of the size between Hangul and Latin letters / digits, the word kept whole", () => {
    setMeasure(fixed);
    const t: TextNode = { ...newText("", 500), autoSpace: { alpha: true, digit: true }, paragraphs: [{ ...newParagraph(""), runs: [{ ...DEFAULT_RUN, fontSize: 10, text: "제1조 끝" }] }] };
    const ps = layoutText(t).lines[0].pieces;
    expect(ps.map((p) => p.text)).toEqual(["제", "1", "조 ", "끝"]);
    expect(ps.map((p) => p.width)).toEqual([12.5, 12.5, 13, 10]);
    // the word moves down whole at a line end (keep-all)
    const u: TextNode = { ...t, width: 40, paragraphs: [{ ...t.paragraphs[0], runs: [{ ...t.paragraphs[0].runs[0], text: "가 제1조 끝" }] }] };
    expect(layoutText(u).lines.map((l) => l.pieces.map((p) => p.text).join(""))).toEqual(["가 ", "제1조 ", "끝"]);
  });
});

describe("DOCX tables (model 6)", () => {
  it("Table Grid borders are black and a row is as tall as Word's one-line cell", async () => {
    const { parseDocxFlow } = await import("../src/io/office");
    const styles = KOREAN_NORMAL + `<w:style w:type="table" w:styleId="TG"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:color="auto"/></w:tblBorders></w:tblPr></w:style>`;
    const items = parseDocxFlow(
      docx(`<w:tbl><w:tblPr><w:tblStyle w:val="TG"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>가</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>나</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`, styles),
      { notesDropped: 0 },
    );
    const t = items.find((i) => i.kind === "table");
    expect(t?.kind === "table" && t.table.style).toMatchObject({ borderColor: "#000000", headerFill: "#ffffff" });
    // 11 pt 맑은 고딕 × 1.729 × 259/240 + 8 pt after
    const want = 11 * (96 / 72) * 1.729 * (259 / 240) + 8 * (96 / 72);
    expect(t?.kind === "table" && t.table.style.rowHeight).toBeCloseTo(want, 0);
  });
});
