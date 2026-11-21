// Feature coverage: Word (DOCX) and Hangul (HWPX) import/export, pagination.
import { beforeAll, describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { A4_MARGIN, exportDocx, exportHwpx, paginate, parseDocx, parseHwpx } from "../../src/io/office";
import { PAGE_PRESETS, newPage, newParagraph, newText } from "../../src/core/types";
import { installDom } from "./helpers";

beforeAll(installDom);

const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
const docx = (body: string, styles?: string) =>
  zipSync({
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`),
    ...(styles ? { "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles ${W}>${styles}</w:styles>`) } : {}),
  });
const text = (p: { runs: { text: string }[] }) => p.runs.map((r) => r.text).join("");

describe("DOCX", () => {
  it("[WD-002][HG-007] import: runs, font, size, bold/italic/underline, colour, alignment, spacing, indent", () => {
    const paras = parseDocx(
      docx(
        `<w:p><w:pPr><w:jc w:val="both"/><w:spacing w:line="480" w:after="240"/><w:ind w:firstLine="400"/></w:pPr>` +
          `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:eastAsia="맑은 고딕"/><w:u w:val="single"/><w:i/><w:color w:val="00AA00"/><w:sz w:val="28"/></w:rPr><w:t>가나다</w:t></w:r></w:p>`,
        `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>`,
      ),
    );
    const [p] = paras;
    expect(p.align).toBe("JUSTIFY");
    // Word "auto" spacing is a Word multiple: the font's line height × 2 (맑은 고딕 1.729 × size, measured in Word);
    // lineSpacing is the same height as a size multiple (older readers)
    expect(p.lineMultiple?.v).toBe(2);
    expect(p.lineSpacing).toBeCloseTo(Math.round(2 * 1.729 * 100) / 100, 3);
    expect(p.spaceAfter).toBeCloseTo((240 / 20) * (96 / 72), 3);
    expect(p.indent).toBeCloseTo((400 / 20) * (96 / 72), 3);
    expect(p.runs[0]).toMatchObject({ text: "가나다", fontFamily: "맑은 고딕", italic: true, underline: true, color: "#00AA00" });
    expect(p.runs[0].fontSize).toBeCloseTo(14 * (96 / 72), 1);
  });

  it("[WD-041] Heading styles become larger bold text (no real style objects)", () => {
    const [h, body] = parseDocx(
      docx(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>제목</w:t></w:r></w:p><w:p><w:r><w:t>본문</w:t></w:r></w:p>`),
    );
    expect(h.runs[0].bold).toBe(true);
    expect(h.runs[0].fontSize).toBeGreaterThan(body.runs[0].fontSize);
    expect(Object.keys(h)).not.toContain("style"); // style identity is not kept
  });

  it("[WD-002] tables are flattened to their cell paragraphs (text kept, structure lost)", () => {
    const paras = parseDocx(docx(`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`));
    expect(paras.map(text)).toEqual(["A1", "B1"]);
  });

  it("[WD-003][HG-007] export → import round trip keeps text and basic formatting", () => {
    const page = newPage("DOCUMENT");
    const t = newText("첫 문단\n둘째 문단", 600, { fontSize: 24, bold: true, italic: true, underline: true, color: "#123456", fontFamily: "Batang" });
    t.paragraphs[1].align = "CENTER";
    t.paragraphs[1].indent = 20;
    t.paragraphs[1].spaceAfter = 12;
    page.nodes.push(t);
    const bytes = exportDocx([page]);
    const files = unzipSync(bytes);
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]));
    const back = parseDocx(bytes);
    expect(back.map(text)).toEqual(["첫 문단", "둘째 문단"]);
    expect(back[0].runs[0]).toMatchObject({ bold: true, italic: true, underline: true, color: "#123456", fontFamily: "Batang" });
    expect(back[0].runs[0].fontSize).toBeCloseTo(24, 0);
    expect(back[1].align).toBe("CENTER");
    expect(back[1].indent).toBeCloseTo(20, 0);
    expect(back[1].spaceAfter).toBeCloseTo(12, 0);
    expect(back[1].lineSpacing).toBeCloseTo(t.paragraphs[1].lineSpacing, 1);
  });

  it("[WD-002] (gap) images and headers/footers are not imported; list numbering becomes a list item", () => {
    const paras = parseDocx(
      docx(`<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>항목</w:t></w:r><w:r><w:drawing/></w:r></w:p>`),
    );
    expect(paras).toHaveLength(1);
    expect(text(paras[0])).toBe("• 항목"); // numbering without numbering.xml → bullet item; drawing dropped
    expect(paras[0].role).toBe("li");
  });
});

describe("HWPX", () => {
  it("[HG-002][HG-029][HG-028] import header.xml char/para shapes: font, height, bold, colour, PERCENT line spacing, align", () => {
    const NS = `xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"`;
    const header = `<hh:head ${NS}><hh:refList><hh:fontfaces><hh:fontface lang="HANGUL"><hh:font id="0" face="함초롬바탕"/></hh:fontface></hh:fontfaces>
      <hh:charProperties><hh:charPr id="3" height="1200" textColor="#0000FF"><hh:fontRef hangul="0"/><hh:bold/></hh:charPr></hh:charProperties>
      <hh:paraProperties><hh:paraPr id="2"><hh:align horizontal="DISTRIBUTE"/><hh:margin><hc:intent value="1000"/><hc:next value="600"/></hh:margin><hh:lineSpacing type="PERCENT" value="180"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>`;
    const sec = `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ${NS}><hp:p paraPrIDRef="2"><hp:run charPrIDRef="3"><hp:t>대한민국<hp:tab/>헌법</hp:t></hp:run></hp:p></hs:sec>`;
    const [p] = parseHwpx(zipSync({ "Contents/header.xml": strToU8(header), "Contents/section0.xml": strToU8(sec) }));
    expect(p.align).toBe("JUSTIFY"); // 배분 정렬 is approximated as justify
    expect(p.lineSpacing).toBeCloseTo(1.8);
    expect(p.indent).toBeCloseTo(10 * (96 / 72), 3);
    expect(p.spaceAfter).toBeCloseTo(6 * (96 / 72), 3);
    expect(p.runs[0]).toMatchObject({ text: "대한민국\t헌법", bold: true, color: "#0000FF", fontFamily: "함초롬바탕" });
    expect(p.runs[0].fontSize).toBeCloseTo(12 * (96 / 72), 1);
  });

  it("[HG-003] export is a valid OWPML package and round-trips text, char shapes and para shapes", () => {
    const page = newPage("DOCUMENT");
    const t = newText("제1조 대한민국은 민주공화국이다.\n제2조", 600, { fontSize: 20, color: "#AA0000", fontFamily: "함초롬돋움", underline: true });
    t.paragraphs[0].align = "RIGHT";
    t.paragraphs[0].lineSpacing = 2;
    t.paragraphs[1].runs.push({ ...t.paragraphs[1].runs[0], text: " 굵게", bold: true });
    page.nodes.push(t);
    const bytes = exportHwpx([page], "헌법");
    const files = unzipSync(bytes);
    expect(strFromU8(files["mimetype"])).toBe("application/hwp+zip");
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["version.xml", "META-INF/container.xml", "Contents/content.hpf", "Contents/header.xml", "Contents/section0.xml"]));
    const back = parseHwpx(bytes);
    expect(back.map(text)).toEqual(["제1조 대한민국은 민주공화국이다.", "제2조 굵게"]);
    expect(back[0]).toMatchObject({ align: "RIGHT", lineSpacing: 2 });
    expect(back[0].runs[0]).toMatchObject({ color: "#AA0000", fontFamily: "함초롬돋움", underline: true });
    expect(back[1].runs[1].bold).toBe(true);
  });
});

describe("pagination", () => {
  it("[WD-065][HG-054] long imported text flows across as many A4 pages as needed", () => {
    const paras = Array.from({ length: 120 }, (_, i) => newParagraph(`${i + 1}번째 문단입니다. 대한민국은 민주공화국이다.`, { fontSize: 16 }));
    const pages = paginate(paras, "긴 문서");
    expect(pages.length).toBeGreaterThan(2);
    for (const pg of pages) {
      expect(pg).toMatchObject({ kind: "DOCUMENT", width: PAGE_PRESETS.A4.width, height: PAGE_PRESETS.A4.height });
      expect(pg.nodes[0].transform).toMatchObject({ x: A4_MARGIN, y: A4_MARGIN });
    }
    expect(pages.flatMap((p) => (p.nodes[0].type === "TEXT" ? p.nodes[0].paragraphs : [])).length).toBe(120);
  });
});
