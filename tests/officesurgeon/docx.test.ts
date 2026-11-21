// Office Surgeon — DOCX source-preserving save (docs/design/OFFICE_SURGEON.md §4, §9).
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../../src/io/formats";
import { parseDocx } from "../../src/io/office";
import { readZip } from "../../src/io/officesurgeon/zip";
import type { OmwDocument, Page, TableNode, TextNode, TextParagraph } from "../../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const STYLED_RPR = '<w:rPr><w:rStyle w:val="OmniEmphasis"/><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="Malgun Gothic"/><w:b/><w:color w:val="1F3864"/><w:sz w:val="28"/><w:lang w:val="ko-KR"/></w:rPr>';
const PLAIN_RPR = '<w:rPr><w:rFonts w:ascii="Malgun Gothic" w:hAnsi="Malgun Gothic" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/><w:lang w:val="ko-KR"/></w:rPr>';
const BODY_PPR = '<w:pPr><w:pStyle w:val="OmniBody"/><w:spacing w:after="160" w:line="276" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr>';
const DRAWING = '<w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="omni-logo"/></wp:inline></w:drawing></w:r>';

/** "Omni 분기 보고서" — a small Word file with styles, numbering, a header, a picture run, a bookmark and a table. */
function omniReport(): Uint8Array {
  const body =
    `<w:p w14:paraId="1A2B3C4D" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Omni 분기 보고서</w:t></w:r></w:p>` +
    `<w:bookmarkStart w:id="0" w:name="omni-summary"/>` +
    `<w:p>${BODY_PPR}<w:r>${STYLED_RPR}<w:t xml:space="preserve">오메 시험 문서: </w:t></w:r><w:r>${PLAIN_RPR}<w:t>매출이 늘었습니다.</w:t></w:r>${DRAWING}</w:p>` +
    `<w:bookmarkEnd w:id="0"/>` +
    `<w:p>${BODY_PPR}<w:r>${PLAIN_RPR}<w:t>둘째 문단은 그대로 둡니다.</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r>${PLAIN_RPR}<w:t>첫 항목</w:t></w:r></w:p>` +
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r>${PLAIN_RPR}<w:t>둘째 항목</w:t></w:r></w:p>` +
    `<w:tbl><w:tblPr><w:tblStyle w:val="OmniGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>` +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/></w:tcPr><w:p><w:r><w:t>분기</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>매출</w:t></w:r></w:p></w:tc></w:tr>` +
    `<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>1분기</w:t></w:r></w:p></w:tc><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
    `<w:p/>` +
    `<w:p>${BODY_PPR}<w:r>${PLAIN_RPR}<w:t>마지막 문단</w:t></w:r></w:p>` +
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHeader"/><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1701" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>`;
  const files = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    "word/_rels/document.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>',
    ),
    "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body}</w:body></w:document>`),
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="OmniBody"><w:name w:val="Omni Body"/></w:style><w:style w:type="character" w:styleId="OmniEmphasis"><w:name w:val="Omni Emphasis"/></w:style></w:styles>`,
    ),
    "word/numbering.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><w:numbering ${W}><w:abstractNum w:abstractNumId="3"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="3"/></w:num></w:numbering>`,
    ),
    "word/header1.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}><w:p><w:r><w:t>omniweave · 오메</w:t></w:r></w:p></w:hdr>`),
    "word/media/image1.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
    "customXml/item1.xml": strToU8('<omni xmlns="urn:omniweave:test">오메</omni>'),
    "docProps/core.xml": strToU8('<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Omni 분기 보고서</dc:title></cp:coreProperties>'),
  };
  return zipSync(files, { level: 9, mtime: new Date(2026, 10, 12, 9, 30) });
}

async function open(bytes: Uint8Array, name = "omw-분기보고서.docx"): Promise<OmwDocument> {
  const r = await formatForExt("docx")!.open({ name, path: null, bytes }, {} as any);
  const assets = (r as any).assets ?? {};
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets } as OmwDocument;
}

async function save(doc: OmwDocument, confirm: (m: string) => boolean = () => true): Promise<Uint8Array> {
  return (await exportById("docx")!.run(doc, doc.pages[0], { confirm })) as Uint8Array;
}

const paras = (doc: OmwDocument): TextParagraph[] => doc.pages.flatMap((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs));
const table = (doc: OmwDocument): TableNode => doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE")!;
const find = (doc: OmwDocument, text: string) => paras(doc).find((p) => p.runs.map((r) => r.text).join("").includes(text))!;
const docXml = (b: Uint8Array) => strFromU8(unzipSync(b)["word/document.xml"]);

/** raw local records (compressed bytes) of every entry except `skip` */
function rawEntries(b: Uint8Array, skip: string[]): Record<string, string> {
  const z = readZip(b)!;
  const out: Record<string, string> = {};
  for (const e of z.entries) if (!skip.includes(e.name)) out[e.name] = Buffer.from(b.subarray(e.dataStart, e.dataStart + e.csize)).toString("hex");
  return out;
}

describe("Office Surgeon — DOCX", () => {
  it("saving without edits returns the original file byte for byte", async () => {
    const orig = omniReport();
    const doc = await open(orig);
    expect(doc.pages[0].source?.office?.parts[0].blocks.length).toBeGreaterThan(5);
    const out = await save(doc, () => {
      throw new Error("no notes expected");
    });
    expect(Buffer.from(out).equals(Buffer.from(orig))).toBe(true);
  });

  it("editing one paragraph rewrites only that paragraph; every other entry keeps its compressed bytes", async () => {
    const orig = omniReport();
    const doc = await open(orig);
    const p = find(doc, "둘째 문단");
    p.runs[0] = { ...p.runs[0], text: "둘째 문단을 고쳤습니다." };
    const out = await save(doc);
    expect(rawEntries(out, ["word/document.xml"])).toEqual(rawEntries(orig, ["word/document.xml"]));
    const before = docXml(orig), after = docXml(out);
    // the edited paragraph keeps its w:pPr (custom style) and the original w:rPr (w:lang) of its run
    expect(after).toContain(`<w:p>${BODY_PPR}<w:r>${PLAIN_RPR}<w:t xml:space="preserve">둘째 문단을 고쳤습니다.</w:t></w:r></w:p>`);
    // everything else is the original text
    expect(after.replace(/<w:p><w:pPr><w:pStyle w:val="OmniBody"\/>(?:(?!<\/w:p>).)*둘째 문단(?:(?!<\/w:p>).)*<\/w:p>/, "")).toBe(
      before.replace(/<w:p><w:pPr><w:pStyle w:val="OmniBody"\/>(?:(?!<\/w:p>).)*둘째 문단(?:(?!<\/w:p>).)*<\/w:p>/, ""),
    );
    expect(parseDocx(out).map((q) => q.runs.map((r) => r.text).join(""))).toContain("둘째 문단을 고쳤습니다.");
  });

  it("a rewritten paragraph keeps its picture run, its original character styles and its paraId", async () => {
    const doc = await open(omniReport());
    const p = find(doc, "매출이 늘었습니다");
    p.runs = p.runs.map((r) => (r.text.includes("매출") ? { ...r, text: "매출이 크게 늘었습니다." } : r));
    const xml = docXml(await save(doc));
    expect(xml).toContain(`<w:r>${STYLED_RPR}<w:t xml:space="preserve">오메 시험 문서: </w:t></w:r>`);
    expect(xml).toContain(`<w:r>${PLAIN_RPR}<w:t xml:space="preserve">매출이 크게 늘었습니다.</w:t></w:r>${DRAWING}</w:p>`);
    // the bookmark around it is still there, in order
    expect(xml.indexOf('w:bookmarkStart w:id="0"')).toBeLessThan(xml.indexOf("매출이 크게"));
    expect(xml.indexOf("매출이 크게")).toBeLessThan(xml.indexOf('w:bookmarkEnd w:id="0"'));
  });

  it("a changed format writes new run properties; deleted and new paragraphs; the section stays last", async () => {
    const doc = await open(omniReport());
    const p = find(doc, "마지막 문단");
    p.runs[0] = { ...p.runs[0], italic: true };
    const host = doc.pages.flatMap((pg) => pg.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.includes(find(doc, "둘째 문단")))!;
    const i = host.paragraphs.indexOf(find(doc, "둘째 문단"));
    host.paragraphs.splice(i, 1, { ...host.paragraphs[i], id: "p-new", runs: [{ ...host.paragraphs[i].runs[0], text: "새로 넣은 오메 문단" }] });
    const out = await save(doc);
    const xml = docXml(out);
    expect(xml).not.toContain("둘째 문단은 그대로");
    expect(xml).toContain("새로 넣은 오메 문단");
    expect(xml).toMatch(/<w:i\/>(?:(?!<\/w:p>).)*마지막 문단/);
    expect(xml.trimEnd().endsWith("</w:sectPr></w:body></w:document>")).toBe(true);
    const texts = parseDocx(out).map((q) => q.runs.map((r) => r.text).join(""));
    expect(texts.indexOf("새로 넣은 오메 문단")).toBeGreaterThan(texts.findIndex((t) => t.includes("매출")));
  });

  it("a new list item continues the original list's numbering", async () => {
    const doc = await open(omniReport());
    const host = doc.pages.flatMap((pg) => pg.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.includes(find(doc, "둘째 항목")))!;
    const i = host.paragraphs.indexOf(find(doc, "둘째 항목"));
    const item = host.paragraphs[i];
    host.paragraphs.splice(i + 1, 0, { ...item, id: "p-item3", runs: [{ ...item.runs[0], text: "3. 셋째 항목" }] });
    const out = await save(doc);
    const xml = docXml(out);
    expect(xml).toMatch(/<w:numId w:val="5"\/>(?:(?!<\/w:p>).)*셋째 항목/);
    expect(strFromU8(unzipSync(out)["word/numbering.xml"])).toBe(strFromU8(unzipSync(omniReport())["word/numbering.xml"]));
  });

  it("editing a table cell rewrites only that cell (table style and cell shading kept)", async () => {
    const doc = await open(omniReport());
    const tb = table(doc);
    const c = tb.rows[1][1];
    tb.rows[1][1] = { ...c, text: "135", richText: c.richText?.map((q) => ({ ...q, runs: [{ ...q.runs[0], text: "135" }] })) };
    const xml = docXml(await save(doc));
    expect(xml).toContain('<w:tblPr><w:tblStyle w:val="OmniGrid"/>');
    expect(xml).toContain('<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/></w:tcPr><w:p><w:r><w:t>분기</w:t></w:r></w:p>');
    expect(xml).toContain("135");
    expect(xml).not.toContain("<w:t>120</w:t>");
    expect(xml).toMatch(/<w:tcW w:w="3000" w:type="dxa"\/><\/w:tcPr><w:p>(?:(?!<\/w:tc>).)*135/);
  });

  it("an original that cannot be matched is written anew after a warning", async () => {
    const doc = await open(omniReport());
    doc.pages[0].source!.office!.engine = 999;
    find(doc, "마지막 문단").runs[0].text = "바뀜";
    const msgs: string[] = [];
    const out = await save(doc, (m) => (msgs.push(m), true));
    expect(msgs.join("\n")).toContain("새로 만듭니다");
    // written anew: the original package is gone, but the header is part of the model now (core/headerFooter.ts)
    expect(unzipSync(out)["word/media/image1.png"]).toBeUndefined();
    expect(strFromU8(unzipSync(out)["word/header1.xml"])).toContain("omniweave · 오메");
    await expect(save(doc, () => false)).rejects.toThrow("SAVE_CANCELLED");
  });

  it("a signed package says the signature breaks", async () => {
    const files = unzipSync(omniReport());
    files["_xmlsignatures/sig1.xml"] = strToU8("<Signature/>");
    const doc = await open(zipSync(files));
    find(doc, "마지막 문단").runs[0].text = "서명 뒤 수정";
    const msgs: string[] = [];
    await save(doc, (m) => (msgs.push(m), true));
    expect(msgs.join("\n")).toContain("서명");
  });
});
