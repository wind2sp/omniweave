// Office Surgeon — DOCX regression cases from the code QA of the first version (2026-11-12).
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../../src/io/formats";
import { parseDocx, parseDocxFlow } from "../../src/io/office";
import type { OmwDocument, Page, TableNode, TextNode, TextParagraph } from "../../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const W =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

function mk(body: string, numbering?: string): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    ),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/omni" TargetMode="External"/></Relationships>'),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`),
    "word/styles.xml": strToU8(`<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
  };
  if (numbering) {
    files["word/numbering.xml"] = strToU8(numbering);
    const ct = strFromU8(files["[Content_Types].xml"]).replace("</Types>", '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>');
    files["[Content_Types].xml"] = strToU8(ct);
    const rels = strFromU8(files["word/_rels/document.xml.rels"]).replace("</Relationships>", '<Relationship Id="rIdN" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>');
    files["word/_rels/document.xml.rels"] = strToU8(rels);
  }
  return zipSync(files);
}

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("docx")!.open({ name: "omw-오메검수.docx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, msgs: string[] = []) {
  return (await exportById("docx")!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const paras = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs));
const para = (doc: OmwDocument, text: string) => paras(doc).find((p) => p.runs.map((r) => r.text).join("").includes(text))!;
const host = (doc: OmwDocument, p: TextParagraph) => doc.pages.flatMap((pg) => pg.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.includes(p))!;
const texts = (b: Uint8Array) => parseDocx(b).map((q) => q.runs.map((r) => r.text).join(""));
const docXml = (b: Uint8Array) => strFromU8(unzipSync(b)["word/document.xml"]);
const P = (t: string, ppr = "") => `<w:p>${ppr}<w:r><w:t>${t}</w:t></w:r></w:p>`;
const tables = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
const insertAfter = (doc: OmwDocument, after: TextParagraph, p: TextParagraph) => {
  const h = host(doc, after);
  h.paragraphs.splice(h.paragraphs.indexOf(after) + 1, 0, p);
};

describe("Office Surgeon DOCX — QA regressions", () => {
  it("a duplicated page (same paragraph ids) is written as new content; editing the original still shows", async () => {
    const doc = await open(mk(P("가") + P("나")));
    const pg = doc.pages[0];
    doc.pages.push({ ...pg, id: "pg2", nodes: pg.nodes.map((n: any) => ({ ...n, id: n.id + "x", paragraphs: n.paragraphs?.map((q: any) => ({ ...q, runs: q.runs.map((r: any) => ({ ...r })) })) })) } as Page);
    para(doc, "가").runs[0].text = "가-오메";
    expect(texts(await save(doc))).toEqual(["가-오메", "나", "가", "나"]);
  });

  it("a cell's new shading is written", async () => {
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/><w:vAlign w:val="center"/></w:tcPr><w:p><w:r><w:t>칸</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const doc = await open(mk(P("앞") + tbl + P("뒤")));
    const tb = tables(doc)[0];
    tb.rows[0][0] = { ...tb.rows[0][0], fill: "#FF0000" };
    const x = docXml(await save(doc));
    expect(x).toContain('<w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="FF0000"/><w:vAlign w:val="center"/>');
  });

  it("hidden text and character styles stay on their own runs", async () => {
    const run = (rpr: string, t: string) => `<w:r><w:rPr>${rpr}</w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
    const doc = await open(mk(`<w:p>${run("<w:vanish/>", "숨김 ")}${run('<w:rStyle w:val="Strong"/>', "강조 ")}${run("", "보통")}</w:p>`));
    const p = para(doc, "보통");
    p.runs = p.runs.map((r) => (r.text === "보통" ? { ...r, text: "보통 오메" } : r));
    const x = docXml(await save(doc));
    expect(x).toContain('<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">숨김 </w:t></w:r>');
    expect(x).toContain('<w:r><w:rPr><w:rStyle w:val="Strong"/></w:rPr><w:t xml:space="preserve">강조 </w:t></w:r>');
    expect(x).toContain('<w:r><w:rPr></w:rPr><w:t xml:space="preserve">보통 오메</w:t></w:r>');
  });

  it("the empty paragraph after a table is a line of its own (model 8, as Word: insert after it, delete the table — the line stays)", async () => {
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>셀</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const src = mk(P("앞") + tbl + "<w:p/>" + P("뒤"));
    const doc = await open(src);
    const back = para(doc, "뒤");
    const h = host(doc, back);
    h.paragraphs.splice(h.paragraphs.indexOf(back), 0, { ...back, id: "p-new", runs: [{ ...back.runs[0], text: "새" }] });
    expect(parseDocxFlow(await save(doc)).map((i) => (i.kind === "p" ? i.p.runs.map((r) => r.text).join("") : "표"))).toEqual(["앞", "표", "새", "뒤"]);
    const doc2 = await open(src);
    for (const pg of doc2.pages) pg.nodes = pg.nodes.filter((n) => n.type !== "TABLE");
    expect(texts(await save(doc2))).toEqual(["앞", "", "뒤"]);
  });

  it("shapes (mc:AlternateContent), equations, hyperlinks and fields survive an edit elsewhere in the paragraph", async () => {
    const shape = `<w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor/></w:drawing></mc:Choice><mc:Fallback><w:pict/></mc:Fallback></mc:AlternateContent></w:r>`;
    const math = `<m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath>`;
    const link = `<w:hyperlink r:id="rId9"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>오메 안내</w:t></w:r></w:hyperlink>`;
    const field = `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
    const doc = await open(mk(`<w:p><w:r><w:t xml:space="preserve">처음 </w:t></w:r>${shape}${math}<w:r><w:t xml:space="preserve"> 그리고 </w:t></w:r>${link}<w:r><w:t xml:space="preserve"> 쪽 </w:t></w:r>${field}<w:r><w:t xml:space="preserve"> 끝</w:t></w:r></w:p>`));
    const p = para(doc, "처음");
    p.runs = p.runs.map((r) => (r.text.includes("처음") ? { ...r, text: r.text.replace("처음", "Omni 처음") } : r));
    const msgs: string[] = [];
    const x = docXml(await save(doc, msgs));
    expect(x).toContain(shape);
    expect(x).toContain(math);
    expect(x).toContain(link);
    expect(x).toContain(field);
    expect(x.indexOf(math)).toBeLessThan(x.indexOf("그리고"));
    expect(x.indexOf(link)).toBeLessThan(x.indexOf(" 쪽 "));
    expect(x).not.toMatch(/<w:t[^>]*>x=1<\/w:t>/);
    expect(msgs).toEqual([]);
  });

  it("a new paragraph format keeps the section break and page break of the original w:pPr", async () => {
    const ppr = `<w:pPr><w:keepNext/><w:pageBreakBefore/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs><w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/></w:sectPr></w:pPr>`;
    const doc = await open(mk(P("가로 구역 끝", ppr) + P("다음")));
    para(doc, "가로 구역").align = "CENTER";
    const x = docXml(await save(doc));
    expect(x).toMatch(/<w:pPr><w:keepNext\/><w:pageBreakBefore\/><w:tabs>.*<\/w:tabs><w:spacing[^>]*\/>.*<w:jc w:val="center"\/>.*<w:sectPr><w:pgSz w:w="16838"[^>]*\/><\/w:sectPr><\/w:pPr><w:r>/);
    expect((x.match(/<w:sectPr/g) ?? []).length).toBe(2);
  });

  it("a cell with a nested table is not flattened into plain paragraphs", async () => {
    const inner = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="1000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>내부</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const tbl = `<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr><w:tc><w:p><w:r><w:t>바깥</w:t></w:r></w:p>${inner}<w:p/></w:tc><w:tc><w:p><w:r><w:t>옆</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const doc = await open(mk(P("앞") + tbl + P("뒤")));
    const tb = tables(doc)[0];
    tb.rows[0][1] = { ...tb.rows[0][1], text: "옆 오메", richText: tb.rows[0][1].richText?.map((q) => ({ ...q, runs: [{ ...q.runs[0], text: "옆 오메" }] })) };
    const x = docXml(await save(doc));
    expect((x.match(/<w:tbl>/g) ?? []).length).toBe(2);
    expect(x).toContain("옆 오메");
  });

  it("a table wider than the page keeps its cells' properties when one cell changes", async () => {
    const tc = (t: string) => `<w:tc><w:tcPr><w:tcW w:w="5000" w:type="dxa"/><w:noWrap/></w:tcPr><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    const tbl = `<w:tbl><w:tblPr><w:tblStyle w:val="OmniWide"/></w:tblPr><w:tblGrid><w:gridCol w:w="5000"/><w:gridCol w:w="5000"/><w:gridCol w:w="5000"/></w:tblGrid><w:tr>${tc("a")}${tc("b")}${tc("c")}</w:tr></w:tbl>`;
    const doc = await open(mk(tbl + P("뒤")));
    const tb = tables(doc)[0];
    tb.rows[0][2] = { ...tb.rows[0][2], text: "오메", richText: tb.rows[0][2].richText?.map((q) => ({ ...q, runs: [{ ...q.runs[0], text: "오메" }] })) };
    const msgs: string[] = [];
    const x = docXml(await save(doc, msgs));
    expect(msgs).toEqual([]);
    expect(x).toContain('<w:tblStyle w:val="OmniWide"/>');
    expect((x.match(/<w:noWrap\/>/g) ?? []).length).toBe(3);
  });

  it("deleting the first page (which held the block map) warns before writing a new file", async () => {
    const doc = await open(mk(Array.from({ length: 80 }, (_, i) => P(`오메 문단 ${i} — 쪽을 넘기려고 길게 씁니다. `.repeat(4))).join("")));
    expect(doc.pages.length).toBeGreaterThan(1);
    doc.pages.shift();
    const msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
  });

  it("a bullet item in a document without numbering.xml adds the part, its relationship and content type", async () => {
    const doc = await open(mk(P("첫") + P("둘")));
    const first = para(doc, "첫");
    insertAfter(doc, first, { ...first, id: "p-li", role: "li", runs: [{ ...first.runs[0], text: "• 오메 항목" }] });
    const out = await save(doc);
    const files = unzipSync(out);
    expect(strFromU8(files["word/numbering.xml"])).toContain('w:numFmt w:val="bullet"');
    expect(strFromU8(files["[Content_Types].xml"])).toContain('PartName="/word/numbering.xml"');
    expect(strFromU8(files["word/_rels/document.xml.rels"])).toContain('Target="numbering.xml"');
    const flow = parseDocxFlow(out);
    expect(flow.some((i) => i.kind === "p" && i.p.role === "li")).toBe(true);
  });

  it("a new item at the end of the second list continues that list", async () => {
    const numbering = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num><w:num w:numId="6"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const li = (n: number, t: string) => P(t, `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${n}"/></w:numPr></w:pPr>`);
    const doc = await open(mk(li(5, "A1") + li(5, "A2") + P("사이") + li(6, "B1") + li(6, "B2") + P("끝"), numbering));
    const b2 = para(doc, "B2");
    insertAfter(doc, b2, { ...b2, id: "p-b3", runs: [{ ...b2.runs[0], text: "3. B3 오메" }] });
    const x = docXml(await save(doc));
    expect(x).toMatch(/<w:numId w:val="6"\/>(?:(?!<\/w:p>).)*B3 오메/);
  });
});

describe("Office Surgeon DOCX — QA round 2", () => {
  const R = (t: string, rpr = "") => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const F = (ty: string) => `<w:r><w:fldChar w:fldCharType="${ty}"/></w:r>`;

  it("a field that spans paragraphs (table of contents) keeps both ends when either paragraph changes", async () => {
    const toc = `<w:p>${F("begin")}<w:r><w:instrText xml:space="preserve"> TOC \o "1-3" </w:instrText></w:r>${F("separate")}${R("1장 시작")}</w:p><w:p>${R("2장 끝")}${F("end")}</w:p>`;
    for (const edit of ["1장", "2장"]) {
      const doc = await open(mk(toc + P("본문")));
      const p = para(doc, edit);
      p.runs = p.runs.map((r) => (r.text.includes(edit) ? { ...r, text: r.text.replace(edit, edit + " 오메") } : r));
      const x = docXml(await save(doc));
      expect((x.match(/fldCharType="begin"/g) ?? []).length).toBe(1);
      expect((x.match(/fldCharType="separate"/g) ?? []).length).toBe(1);
      expect((x.match(/fldCharType="end"/g) ?? []).length).toBe(1);
      expect(x).toContain("TOC");
      expect(x.indexOf('fldCharType="begin"')).toBeLessThan(x.indexOf('fldCharType="end"'));
    }
  });

  it("the text of a text box is not written twice", async () => {
    const box = `<w:r><w:drawing><wp:inline><wp:docPr id="1" name="omni-box"/><w:txbxContent><w:p><w:r><w:t>상자글</w:t></w:r></w:p></w:txbxContent></wp:inline></w:drawing></w:r>`;
    const doc = await open(mk(`<w:p>${R("본문")}${box}${R(" 다음")}</w:p>`));
    const p = para(doc, "본문");
    p.runs = p.runs.map((r) => (r.text === "본문" ? { ...r, text: "본문 오메" } : r));
    const x = docXml(await save(doc));
    expect((x.match(/상자글/g) ?? []).length).toBe(1);
    expect(x.indexOf("본문 오메")).toBeLessThan(x.indexOf("상자글"));
  });

  it("a field stays where it was when the same text also appears earlier", async () => {
    const doc = await open(mk(`<w:p>${R("3장 쪽 ")}${F("begin")}<w:r><w:instrText> PAGE </w:instrText></w:r>${F("separate")}${R("3")}${F("end")}${R(" 끝")}</w:p>`));
    const p = para(doc, "끝");
    p.runs = p.runs.map((r) => (r.text === " 끝" ? { ...r, text: " 오메 끝" } : r));
    const x = docXml(await save(doc));
    expect(x).toMatch(/3장 쪽 <\/w:t><\/w:r><w:r><w:fldChar w:fldCharType="begin"\/>/);
  });

  it("a page break inside a paragraph stays a page break", async () => {
    const doc = await open(mk(`<w:p>${R("앞쪽")}<w:r><w:br w:type="page"/></w:r>${R("뒤쪽")}</w:p>`));
    const p = para(doc, "앞쪽");
    p.runs = p.runs.map((r) => (r.text.includes("뒤쪽") ? { ...r, text: r.text.replace("뒤쪽", "뒤쪽 오메") } : r));
    const x = docXml(await save(doc));
    expect(x).toContain('<w:br w:type="page"/>');
    expect(x).not.toMatch(/<w:t[^>]*> <\/w:t>/);
  });

  it("a link whose look changed is written as plain text, with a note", async () => {
    const link = `<w:hyperlink r:id="rId9">${R("오메링크")}</w:hyperlink>`;
    const doc = await open(mk(`<w:p>${R("앞 ")}${link}${R(" 뒤")}</w:p>`));
    const p = para(doc, "오메링크");
    p.runs = p.runs.map((r) => (r.text === "오메링크" ? { ...r, bold: true } : r));
    const msgs: string[] = [];
    const x = docXml(await save(doc, msgs));
    expect(x).toMatch(/<w:b\/>.*오메링크/);
    expect(msgs.join("\n")).toContain("위치가 바뀔 수");
  });

  it("an empty simple field at the end of a paragraph stays at the end", async () => {
    const doc = await open(mk(`<w:p>${R("오늘 날짜: ")}<w:fldSimple w:instr=" DATE "/></w:p>`));
    const p = para(doc, "오늘");
    p.runs = p.runs.map((r) => ({ ...r, text: r.text.replace("오늘", "오메 오늘") }));
    const x = docXml(await save(doc));
    expect(x.indexOf("오메 오늘")).toBeLessThan(x.indexOf("fldSimple"));
  });

  it("a numbered list started after ordinary text restarts at 1 (its own w:num)", async () => {
    const numbering = `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const li = (t: string) => P(t, `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr>`);
    const doc = await open(mk(li("A1") + li("A2") + li("A3") + P("사이 문단") + P("끝"), numbering));
    const mid = para(doc, "사이");
    insertAfter(doc, mid, { ...mid, id: "p-new1", role: "oli", runs: [{ ...mid.runs[0], text: "1. 새 목록 오메" }] });
    const out = await save(doc);
    const x = docXml(out);
    const id = /<w:numId w:val="(\d+)"\/>(?:(?!<\/w:p>).)*새 목록 오메/.exec(x)?.[1];
    expect(id).toBeDefined();
    expect(id).not.toBe("5");
    expect(strFromU8(unzipSync(out)["word/numbering.xml"])).toContain(`<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>`);
  });
});
