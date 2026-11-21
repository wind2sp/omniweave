// UNIFIED_STYLES.md appendix B (audit bugs 1-4): HWPX header/footnote leak, XLSX italic, PPTX list numbering, DOCX line breaks.
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { newPage, newTable, newText, type TableNode, type TextNode } from "../../src/core/types";
import { layoutText } from "../../src/core/text";
import { newDocument } from "../../src/core/types";
import { useLang } from "../../src/i18n";
import { exportDocx, parseDocx, parseDocxFlow, parseHwpx, parseHwpxFlow, type OfficeItem } from "../../src/io/office";
import { formatForExt } from "../../src/io/formats";
import { markdownBlocks, pagesToMarkdown } from "../../src/io/formats/markdown";
import { exportXlsx, importXlsx } from "../../src/io/formats/xlsx";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const paras = (items: OfficeItem[]) => items.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras));
const setLang = (l: "en") => useLang.getState().set(l, false);
const textsOf = (ps: { runs: { text: string }[] }[]) => ps.map((p) => p.runs.map((r) => r.text).join(""));

describe("HWPX header, footer and notes (B1)", () => {
  it("header, footer, footnote and endnote text stays out of the body (a note is its mark in the text)", () => {
    const NS = `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"`;
    const sub = (s: string) => `<hp:subList><hp:p><hp:run><hp:t>${s}</hp:t></hp:run></hp:p></hp:subList>`;
    const sec =
      `<hs:sec ${NS}><hp:p><hp:run><hp:ctrl><hp:header id="1" applyPageType="BOTH">${sub("HEADER")}</hp:header></hp:ctrl>` +
      `<hp:ctrl><hp:footer id="2" applyPageType="BOTH">${sub("FOOTER")}</hp:footer></hp:ctrl><hp:t>BODY</hp:t>` +
      `<hp:ctrl><hp:footNote number="1">${sub("FOOTNOTE")}</hp:footNote></hp:ctrl>` +
      `<hp:ctrl><hp:endNote number="1">${sub("ENDNOTE")}</hp:endNote></hp:ctrl><hp:t> MORE</hp:t></hp:run></hp:p>` +
      `<hp:p><hp:run><hp:t>AFTER</hp:t></hp:run></hp:p></hs:sec>`;
    const bytes = zipSync({ mimetype: strToU8("application/hwp+zip"), "Contents/section0.xml": strToU8(sec) });
    const ps = parseHwpx(bytes);
    // the notes are runs of their marks (한글's 1)), carrying their own text for the note areas
    expect(textsOf(ps)).toEqual(["BODY1)1) MORE", "AFTER"]);
    const notes = ps[0].runs.filter((r) => r.note).map((r) => [r.note!.kind, r.note!.paras.map((q) => q.runs.map((x) => x.text).join("")).join("")]);
    expect(notes).toEqual([["foot", "FOOTNOTE"], ["end", "ENDNOTE"]]);
  });

  it("hidden comments stay out of the body; notes come in with the body (none reported dropped)", async () => {
    const NS = `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"`;
    const sub = (s: string) => `<hp:subList><hp:p><hp:run><hp:t>${s}</hp:t></hp:run></hp:p></hp:subList>`;
    const sec =
      `<hs:sec ${NS}><hp:p><hp:run><hp:t>BODY</hp:t><hp:ctrl><hp:hiddenComment>${sub("SECRET")}</hp:hiddenComment></hp:ctrl>` +
      `<hp:ctrl><hp:footNote number="1">${sub("F1")}</hp:footNote></hp:ctrl><hp:ctrl><hp:endNote number="1">${sub("E1")}</hp:endNote></hp:ctrl></hp:run></hp:p></hs:sec>`;
    const bytes = zipSync({ mimetype: strToU8("application/hwp+zip"), "Contents/section0.xml": strToU8(sec) });
    const report = { notesDropped: 0 };
    expect(textsOf(paras(parseHwpxFlow(bytes, report)))).toEqual(["BODY1)1)"]);
    expect(report.notesDropped).toBe(0);
    setLang("en");
    const r = await formatForExt("hwpx")!.open({ name: "n.hwpx", bytes } as any);
    expect((r as any).warnings).toEqual([]);
  });

  it("DOCX footnote references come in as note runs; those in table cells are kept too (the flow gives them room at the foot of their row's page)", () => {
    const docx = zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
          `<w:p><w:r><w:t>x</w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>` +
          `<w:tbl><w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r><w:r><w:footnoteReference w:id="2"/></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
      ),
    });
    const report = { notesDropped: 0 };
    const items = parseDocxFlow(docx, report);
    expect(report.notesDropped).toBe(0);
    const p0 = items[0].kind === "p" ? items[0].p : null;
    expect(p0?.runs.map((r) => [r.text, r.note?.kind ?? null])).toEqual([["x", null], ["1", "foot"]]);
  });

  it("HWPX hp:lineBreak is a line break inside the paragraph, not a space", () => {
    const NS = `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"`;
    const sec = `<hs:sec ${NS}><hp:p><hp:run><hp:t>A<hp:lineBreak/>B</hp:t><hp:lineBreak/><hp:t>C</hp:t></hp:run></hp:p></hs:sec>`;
    const bytes = zipSync({ mimetype: strToU8("application/hwp+zip"), "Contents/section0.xml": strToU8(sec) });
    expect(textsOf(parseHwpx(bytes))).toEqual(["A\nB\nC"]);
  });
});

describe("XLSX italic (B2)", () => {
  it("italic cells get an italic font on export and read back italic", () => {
    const page = newPage("DOCUMENT");
    const t = newTable([["plain", "slanted", "both"]]);
    t.headerRow = false;
    t.rows[0][1].italic = true;
    t.rows[0][2].italic = true;
    t.rows[0][2].bold = true;
    page.nodes.push(t);
    const bytes = exportXlsx([page]);
    expect(strFromU8(unzipSync(bytes)["xl/styles.xml"])).toMatch(/<font><i\/>/);
    const back = importXlsx(bytes, "i.xlsx").pages[0].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    expect(back.rows[0].map((c) => !!c.italic)).toEqual([false, true, true]);
    expect(back.rows[0].map((c) => !!c.bold)).toEqual([false, false, true]);
  });
});

describe("PPTX numbered lists (B3)", () => {
  const A = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
  const pptxWith = (paras: string) => {
    const slide =
      `<p:sld ${A}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6000000" cy="3000000"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const rel = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>`;
    return zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${A}><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(rel),
      "ppt/slides/slide1.xml": strToU8(slide),
    });
  };
  const num = (text: string, opts: { lvl?: number; scheme?: string; startAt?: number } = {}) =>
    `<a:p><a:pPr${opts.lvl ? ` lvl="${opts.lvl}"` : ""}><a:buAutoNum type="${opts.scheme ?? "arabicPeriod"}"${opts.startAt ? ` startAt="${opts.startAt}"` : ""}/></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const plain = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
  const bullet = (text: string) => `<a:p><a:pPr><a:buChar char="-"/></a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`;

  // the marker follows the scheme (arabicParenR → "1)"; before batch 2 of the document features every scheme read as "1.")
  it("restarts per list run, per level and scheme, and honours startAt", () => {
    const bytes = pptxWith(
      num("a") + num("b") + plain("2024. not a list") + num("c") + num("d", { lvl: 1 }) + num("e", { lvl: 1 }) + num("f") +
        bullet("g") + num("h") + num("i", { scheme: "arabicParenR" }) + num("j", { startAt: 5 }) + num("k", { startAt: 5 }),
    );
    const t = importPptx(bytes, "n.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    expect(textsOf(t.paragraphs)).toEqual([
      "1. a", "2. b", "2024. not a list", "1. c", "1. d", "2. e", "2. f", "- g", "1. h", "1) i", "5. j", "6. k",
    ]);
  });

  it("a deeper paragraph without a list marker does not end the outer numbered list", () => {
    const bytes = pptxWith(num("a") + `<a:p><a:pPr lvl="1"/><a:r><a:t>sub</a:t></a:r></a:p>` + num("b"));
    const t = importPptx(bytes, "n.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    expect(textsOf(t.paragraphs)).toEqual(["1. a", "sub", "2. b"]);
  });
});

describe("line breaks across formats (B4 follow-up)", () => {
  it("DOCX w:br → PPTX export writes a:br (no raw newline in a:t) → PPTX import", async () => {
    const docx = zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
          `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    const doc = newDocument("t");
    const slide = newPage("SLIDE", 1280, 720, "s");
    const t = newText("", 800);
    t.paragraphs = parseDocx(docx);
    slide.nodes.push(t);
    doc.pages = [slide];
    const { bytes } = await exportPptx(doc, [slide]);
    const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]);
    for (const m of xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)) expect(m[1]).not.toMatch(/\n/);
    expect(xml).toMatch(/<a:br><a:rPr [^>]*b="1"/);
    const back = importPptx(bytes, "t.pptx").pages[0].nodes.find((n): n is TextNode => n.type === "TEXT")!;
    // PPTX import keeps a soft break inside its paragraph (a line break in the run, as Word's w:br), formatting kept
    expect(textsOf(back.paragraphs)).toEqual(["one\ntwo"]);
    expect(back.paragraphs.every((p) => p.runs[0].bold)).toBe(true);
  });

  it("a justified line that ends at a line break is not stretched", () => {
    const t = newText("x", 600);
    t.paragraphs[0].align = "JUSTIFY";
    t.paragraphs[0].runs[0] = { ...t.paragraphs[0].runs[0], text: "a few short words\nnext" };
    const [first] = layoutText(t).lines;
    const last = first.pieces[first.pieces.length - 1];
    expect(last.x + last.width).toBeLessThan(400);
  });

  it("Markdown export: a line break is a hard break and the next line cannot start a block", () => {
    const page = newPage("DOCUMENT");
    const t = newText("x", 600);
    t.paragraphs[0].runs[0] = { ...t.paragraphs[0].runs[0], text: "intro\n# not a heading\n- not a list\n1. not ordered\n> no quote\n---" };
    page.nodes.push(t);
    const md = pagesToMarkdown([page]);
    expect(md.split("\n")[0]).toBe("intro\\");
    const blocks = markdownBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind === "para" && !blocks[0].para.role).toBe(true);
  });
});

describe("DOCX line breaks (B4)", () => {
  it("w:br imports as a line break inside the paragraph", () => {
    const docx = zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
          `<w:p><w:r><w:t>one</w:t><w:br/><w:t>two</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    expect(textsOf(parseDocx(docx))).toEqual(["one\ntwo"]);
  });

  it("a line break survives export → import and lays out as two lines", () => {
    const page = newPage("DOCUMENT");
    const t = newText("x", 600);
    t.paragraphs[0].runs[0] = { ...t.paragraphs[0].runs[0], text: "first line\nsecond line" };
    page.nodes.push(t);
    const xml = strFromU8(unzipSync(exportDocx([page]))["word/document.xml"]);
    expect(xml).toContain("<w:br/>");
    const back = parseDocx(exportDocx([page]));
    expect(textsOf(back)).toEqual(["first line\nsecond line"]);
    const lines = layoutText(t).lines;
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.pieces.map((p) => p.text).join("").trim())).toEqual(["first line", "second line"]);
  });
});
