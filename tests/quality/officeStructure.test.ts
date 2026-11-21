// DOCX / HWPX structure round trips: tables (TABLE nodes, merged cells, borders), heading outline
// levels, real list numbering, Word line-spacing mapping.

import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { toggleList } from "../../src/core/richtext";
import { newPage, newParagraph, newTable, newText, type Page, type TableNode, type TextParagraph } from "../../src/core/types";
import { exportDocx, exportHwpx, fontLineRatio, fromWordLine, parseDocx, parseDocxFlow, parseHwpxFlow, wordLine, type OfficeItem } from "../../src/io/office";
import { formatForExt } from "../../src/io/formats";
import { officePages } from "../../src/io/formats/flow";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const text = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const paras = (items: OfficeItem[]) => items.filter((i): i is { kind: "p"; p: TextParagraph } => i.kind === "p").map((i) => i.p);
const tables = (items: OfficeItem[]) => items.flatMap((i) => (i.kind === "table" ? [i.table] : []));

function sampleDoc(): Page[] {
  const page = newPage("DOCUMENT", 794, 1123);
  const t = newText("", 642, { fontSize: 16 });
  const body: TextParagraph[] = [
    { ...newParagraph("제목 하나", { fontSize: 32, bold: true }), role: "h1" },
    { ...newParagraph("제목 둘", { fontSize: 24, bold: true }), role: "h2" },
    { ...newParagraph("제목 셋", { fontSize: 20, bold: true }), role: "h3" },
    newParagraph("사과", { fontSize: 16 }),
    newParagraph("배", { fontSize: 16 }),
    newParagraph("중간 문단", { fontSize: 16 }),
    newParagraph("첫째", { fontSize: 16 }),
    newParagraph("둘째", { fontSize: 16 }),
    newParagraph("셋째", { fontSize: 16 }),
    newParagraph("구분 문단", { fontSize: 16 }),
    newParagraph("새 목록 하나", { fontSize: 16 }),
  ];
  let ps = toggleList(body, 3, 4, "li").paras;
  ps = toggleList(ps, 6, 8, "oli").paras;
  ps = toggleList(ps, 10, 10, "oli").paras;
  ps[5].lineSpacing = 1;
  ps[9].lineSpacing = 2;
  t.paragraphs = ps;
  t.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
  const tbl = newTable(
    [
      [{ text: "머리 A" }, { text: "머리 B" }, { text: "머리 C" }],
      [{ text: "가로 병합", colSpan: 2, align: "CENTER" }, { text: "" }, { text: "세로 병합", rowSpan: 2, fill: "#FFEEAA" }],
      [{ text: "x" }, { text: "y", bold: true }, { text: "" }],
    ],
    [200, 150, 180],
    "문서 표",
  );
  tbl.borderColor = "#336699";
  tbl.transform = { x: 76, y: 700, rotation: 0, scale: 1 };
  page.nodes.push(t, tbl);
  return [page];
}

const WANT_TEXT = ["제목 하나", "제목 둘", "제목 셋", "• 사과", "• 배", "중간 문단", "1. 첫째", "2. 둘째", "3. 셋째", "구분 문단", "1. 새 목록 하나"];
const WANT_ROLES = ["h1", "h2", "h3", "li", "li", undefined, "oli", "oli", "oli", undefined, "oli"];

function checkTable(t: ReturnType<typeof tables>[number]) {
  expect(t.rows.map((r) => r.map((c) => c.text))).toEqual([
    ["머리 A", "머리 B", "머리 C"],
    ["가로 병합", "", "세로 병합"],
    ["x", "y", ""],
  ]);
  expect(t.rows[1][0]).toMatchObject({ colSpan: 2, align: "CENTER" });
  expect(t.rows[1][2]).toMatchObject({ rowSpan: 2, fill: "#FFEEAA" });
  expect(t.rows[2][1].bold).toBe(true);
  expect(t.headerRow).toBe(true);
  expect(t.style.borderColor).toBe("#336699");
  expect(t.colWidths.map(Math.round)).toEqual([200, 150, 180]);
}

describe("DOCX structure", () => {
  it("tables, merged cells, headings, real numbering and line spacing round-trip", () => {
    const bytes = exportDocx(sampleDoc());
    const files = unzipSync(bytes);
    const doc = strFromU8(files["word/document.xml"]);
    // real numbering, no marker text in the file
    expect(files["word/numbering.xml"]).toBeTruthy();
    expect(strFromU8(files["word/numbering.xml"])).toContain('w:numFmt w:val="bullet"');
    expect(strFromU8(files["word/numbering.xml"])).toContain('w:lvlText w:val="%1."');
    expect(doc).not.toContain(">• ");
    expect(doc).not.toContain(">1. ");
    expect((doc.match(/<w:numPr>/g) ?? []).length).toBe(6);
    // two numbered lists → two w:num restarting at 1
    expect((strFromU8(files["word/numbering.xml"]).match(/w:startOverride/g) ?? []).length).toBe(2);
    expect(doc).toContain('<w:gridSpan w:val="2"/>');
    expect(doc).toContain('<w:vMerge w:val="restart"/>');
    expect(doc).toContain("<w:vMerge/>");
    expect(strFromU8(files["[Content_Types].xml"])).toContain("numbering+xml");

    const items = parseDocxFlow(bytes);
    const ps = paras(items);
    expect(ps.map(text)).toEqual(WANT_TEXT);
    expect(ps.map((p) => p.role)).toEqual(WANT_ROLES);
    expect(ps[5].lineSpacing).toBe(1);
    expect(ps[9].lineSpacing).toBe(2);
    expect(ps[0].lineSpacing).toBe(1.6);
    const [t] = tables(items);
    checkTable(t);
    // the legacy paragraph view still flattens the table
    expect(parseDocx(bytes).map(text)).toContain("가로 병합");
  });

  it("Word-made lists (numbering.xml, style headings with numeric ids) import as role + marker text", () => {
    const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
    const p = (t: string, ppr = "") => `<w:p><w:pPr>${ppr}</w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
    const num = (id: number) => `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${id}"/></w:numPr>`;
    const bytes = zipSync({
      "word/document.xml": strToU8(
        `<w:document ${W}><w:body>${p("제목", '<w:pStyle w:val="1"/>')}${p("가", num(5))}${p("나", num(5))}${p("하나", num(7))}${p("둘", num(7))}</w:body></w:document>`,
      ),
      "word/styles.xml": strToU8(`<w:styles ${W}><w:style w:type="paragraph" w:styleId="1"><w:name w:val="heading 1"/></w:style></w:styles>`),
      "word/numbering.xml": strToU8(
        `<w:numbering ${W}><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val=""/><w:pPr><w:ind w:left="800" w:hanging="400"/></w:pPr></w:lvl></w:abstractNum>` +
          `<w:abstractNum w:abstractNumId="4"><w:lvl w:ilvl="0"><w:numFmt w:val="ganada"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num><w:num w:numId="7"><w:abstractNumId w:val="4"/></w:num></w:numbering>`,
      ),
    });
    const ps = parseDocx(bytes);
    // numFmt ganada numbers 가. 나. as Word does (multi-level lists, document features batch 2; before: "1." "2.")
    expect(ps.map(text)).toEqual(["제목", "• 가", "• 나", "가. 하나", "나. 둘"]);
    expect(ps.map((x) => x.role)).toEqual(["h1", "li", "li", "oli", "oli"]);
    // the list level's indent applies when the paragraph has none
    expect(ps[1].indentLeft).toBeCloseTo((800 / 20) * (96 / 72), 1);
    expect(ps[1].indent).toBeCloseTo((-400 / 20) * (96 / 72), 1);
  });

  it("line spacing: w:line = 240 × lineSpacing ÷ the font's line-height ratio, exact and atLeast in twips", () => {
    // measured in Word (core/lineSpacing.ts): fonts with the Korean code page are (win ascent + descent) × 1.3 for all text
    expect(fontLineRatio("Pretendard")).toBeCloseTo(1.551, 3);
    expect(fontLineRatio("맑은 고딕", "가나다")).toBeCloseTo(1.729, 3);
    expect(fontLineRatio("Arial", "가나다")).toBeCloseTo(1.729, 3); // Hangul in a Latin font: 맑은 고딕's line
    expect(fontLineRatio("Arial", "Latin")).toBeCloseTo(1.15, 3);
    for (const font of ["Pretendard", "맑은 고딕", "Arial", "Unknown Font"])
      for (const text of ["Latin", "한글"])
        for (const ls of [0.8, 1, 1.15, 1.2, 1.35, 1.5, 1.6, 2, 2.5, 3]) expect(fromWordLine(wordLine(ls, font, text), font, text)).toBe(ls);
    expect(wordLine(1.729, "맑은 고딕", "Latin")).toBe(240); // Malgun Gothic single line (Latin too) = 1.729 × size
    const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
    const bytes = zipSync({
      "word/document.xml": strToU8(
        `<w:document ${W}><w:body><w:p><w:pPr><w:spacing w:line="480" w:lineRule="exact"/></w:pPr><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>exact</w:t></w:r></w:p>` +
          `<w:p><w:r><w:rPr><w:rFonts w:eastAsia="맑은 고딕"/></w:rPr><w:t>default single</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    const [exact, single] = parseDocx(bytes);
    expect(exact.lineSpacing).toBe(2); // 24pt line / 12pt text
    expect(single.lineSpacing).toBe(1.73); // Latin text in 맑은 고딕: Word single = 1.729 × size
    expect(single.lineMultiple?.v).toBe(1);
  });

  it("opening a DOCX with a table gives a TABLE node; saving it again keeps it a table", async () => {
    const bytes = exportDocx(sampleDoc());
    const opened = await formatForExt("docx")!.open!({ name: "t.docx", path: null, bytes }, { confirm: () => true });
    const tbls = opened.pages!.flatMap((p) => p.nodes.filter((n): n is TableNode => n.type === "TABLE"));
    expect(tbls.length).toBe(1);
    expect(tbls[0].borderColor).toBe("#336699");
    const again = parseDocxFlow(exportDocx(opened.pages!));
    checkTable(tables(again)[0]);
    expect(paras(again).map(text)).toEqual(WANT_TEXT);
  });

  it("a table split across pages is written as one table", () => {
    const rows = [[{ text: "H1" }, { text: "H2" }], ...Array.from({ length: 80 }, (_, i) => [{ text: `r${i}` }, { text: `${i}` }])];
    const pages = officePages([{ kind: "table", table: { rows, colWidths: [200, 200], headerRow: true, style: {}, paras: [] } }], "split");
    expect(pages.length).toBeGreaterThan(1);
    const t = tables(parseDocxFlow(exportDocx(pages)));
    expect(t.length).toBe(1);
    expect(t[0].rows.length).toBe(81);
  });
});

describe("HWPX structure", () => {
  it("tables (hp:tbl, cellSpan, borderFill), outline headings and bullet/number lists round-trip", () => {
    const bytes = exportHwpx(sampleDoc(), "구조");
    const files = unzipSync(bytes);
    const sec = strFromU8(files["Contents/section0.xml"]);
    const head = strFromU8(files["Contents/header.xml"]);
    expect(sec).toContain("<hp:tbl ");
    expect(sec).toContain('<hp:cellSpan colSpan="2" rowSpan="1"/>');
    expect(sec).toContain('<hp:cellSpan colSpan="1" rowSpan="2"/>');
    expect((sec.match(/<hp:tc /g) ?? []).length).toBe(7); // 9 grid cells − 2 covered
    expect(head).toContain('<hh:heading type="OUTLINE" idRef="0" level="0"/>');
    expect(head).toContain('<hh:heading type="OUTLINE" idRef="0" level="2"/>');
    expect(head).toContain('type="BULLET" idRef="1"');
    expect(head).toContain('type="NUMBER" idRef="2"');
    expect(head).toContain('type="NUMBER" idRef="3"');
    expect(head).toContain('name="개요 1"');
    expect(head).toContain('faceColor="#FFEEAA"');
    expect(head).toContain('color="#336699"');
    expect(sec).not.toContain("<hp:t>• ");
    expect(sec).not.toContain("<hp:t>1. ");

    const items = parseHwpxFlow(bytes);
    const ps = paras(items);
    expect(ps.map(text)).toEqual(WANT_TEXT);
    expect(ps.map((p) => p.role)).toEqual(WANT_ROLES);
    expect(ps[5].lineSpacing).toBe(1);
    const [t] = tables(items);
    checkTable(t);
  });

  it("opening an HWPX with a table gives a TABLE node", async () => {
    const bytes = exportHwpx(sampleDoc(), "구조");
    const opened = await formatForExt("hwpx")!.open!({ name: "t.hwpx", path: null, bytes }, { confirm: () => true });
    expect(opened.pages!.flatMap((p) => p.nodes.filter((n) => n.type === "TABLE")).length).toBe(1);
    expect(opened.message).toContain("표 1개");
  });
});

describe("unedited 'save as the same type' keeps every paragraph", () => {
  /** A long table (split across pages) whose cells carry their own fonts, a list and a merge across the page break. */
  function richTableDoc(fmt: "docx" | "hwpx"): Uint8Array {
    const page = newPage("DOCUMENT", 794, 1123);
    const rows = Array.from({ length: 70 }, (_, i) => [{ text: `행 ${i}` }, { text: String(i * 3) }]);
    const t = newTable(rows, [300, 200], "긴 표");
    t.headerRow = false;
    t.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
    page.nodes.push(t);
    const bytes0 = fmt === "docx" ? exportDocx([page]) : exportHwpx([page], "r");
    // give the imported cells mixed formatting and a list item, then merge two rows around the page break
    const items = fmt === "docx" ? parseDocxFlow(bytes0) : parseHwpxFlow(bytes0);
    const tbl = tables(items)[0];
    const c = tbl.rows[3][0];
    c.richText = [
      { ...c.richText![0], runs: [{ ...c.richText![0].runs[0], text: "굵은 ", bold: true, fontFamily: "맑은 고딕", fontSize: 11 }, { ...c.richText![0].runs[0], text: "궁서", fontFamily: "궁서", strike: true }] },
      { ...c.richText![0], id: "x", role: "li", runs: [{ ...c.richText![0].runs[0], text: "• 목록" }] },
    ];
    c.text = "굵은 궁서\n• 목록";
    tbl.rows[30][1] = { ...tbl.rows[30][1], rowSpan: 3 };
    tbl.rows[31][1] = { text: "" };
    tbl.rows[32][1] = { text: "" };
    const pages = officePages(items, "r");
    return fmt === "docx" ? exportDocx(pages) : exportHwpx(pages, "r");
  }

  for (const fmt of ["docx", "hwpx"] as const)
    it(`${fmt}: open → save without edits → same paragraphs, formats, tables`, async () => {
      const src = richTableDoc(fmt);
      const parse = fmt === "docx" ? parseDocxFlow : parseHwpxFlow;
      const opened = await formatForExt(fmt)!.open!({ name: `r.${fmt}`, path: null, bytes: src }, { confirm: () => true });
      expect(opened.pages!.length).toBeGreaterThan(1); // the table was split across pages
      const out = fmt === "docx" ? exportDocx(opened.pages!) : exportHwpx(opened.pages!, "r");
      const a = parse(src), b = parse(out);
      const flat = (items: OfficeItem[]) => items.flatMap((i) => (i.kind === "p" ? [i.p] : i.table.paras));
      const sig = (p: TextParagraph) => JSON.stringify([p.role ?? "", p.align, p.lineSpacing, p.runs.map((r) => [r.text, r.fontFamily, r.fontSize, r.bold, !!r.strike])]);
      expect(flat(b).map(sig)).toEqual(flat(a).map(sig));
      expect(tables(b).length).toBe(1);
      expect(tables(b)[0].rows.length).toBe(70);
      expect(tables(b)[0].rows[30][1].rowSpan).toBe(3);
      expect(tables(b)[0].rows[3][0].richText?.[1].role).toBe("li");
    });
});

describe("control characters are written as elements, never raw text", () => {
  function tabbed(): Page[] {
    const page = newPage("DOCUMENT", 794, 1123);
    const t = newText("", 600, { fontSize: 16 });
    t.paragraphs = [newParagraph("이름\t값\t비고", { fontSize: 16 }), newParagraph("줄\n바꿈\u0007벨", { fontSize: 16 })];
    page.nodes.push(t);
    return [page];
  }
  it("HWPX: no control character inside <hp:t> (한글 opens such a file as an empty document); tabs read back", () => {
    const bytes = exportHwpx(tabbed(), "탭");
    const sec = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    for (const m of sec.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)) expect(/[\u0000-\u001f]/.test(m[1].replace(/<[^>]+>/g, ""))).toBe(false);
    expect((sec.match(/<hp:tab /g) ?? []).length).toBe(2);
    expect(sec).toContain("<hp:lineBreak/>");
    const ps = paras(parseHwpxFlow(bytes)).map(text);
    expect(ps[0]).toBe("이름\t값\t비고");
    expect(ps[1]).toBe("줄\n바꿈벨"); // hp:lineBreak reads back as the line break it was written from
  });
  it("DOCX: tabs as <w:tab/>, breaks as <w:br/>", () => {
    const doc = strFromU8(unzipSync(exportDocx(tabbed()))["word/document.xml"]);
    for (const m of doc.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)) expect(/[\u0000-\u001f]/.test(m[1])).toBe(false);
    expect((doc.match(/<w:tab\/>/g) ?? []).length).toBe(2);
    expect(paras(parseDocxFlow(exportDocx(tabbed()))).map(text)[0]).toBe("이름\t값\t비고");
  });
});
