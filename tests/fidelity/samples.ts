// Public fidelity samples generated in memory (no personal data, safe to name in reports).
// They imitate what office programs write — styles, headers, tables, images, formulas, merged
// cells, encodings — so the round trip shows what Omniweave keeps and what it drops.
// Real-world files come from test-corpus/ (personal, read by path only) and qa/interop/adobe-made/.

import { strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { newDocument, newPage, newTable, newText, newVector } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { exportHwpx } from "../../src/io/office";
import { encodePng } from "../../src/io/formats/png";
import { exportPptx } from "../../src/io/formats/pptx";
import { buildPsd } from "../../src/io/formats/psdWrite";
import { encodeText } from "../../src/io/formats/textcodec";

export interface Sample {
  name: string;
  bytes: Uint8Array;
  /** what the sample is meant to exercise (shown in the report) */
  note: string;
}

const FONT = () => readFileSync(join(process.cwd(), "assets/fonts/Pretendard-Regular.ttf"));
const FIXED_DATE = new Date("2026-01-01T00:00:00Z");

async function pdfSample(objectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  // full embedding: pdf-lib's subsetter drops glyphs of this font for pdf.js, which would spoil the reference
  const ko = await doc.embedFont(FONT(), { subset: false });
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([595, 842]);
    page.drawRectangle({ x: 50, y: 700, width: 495, height: 2, color: rgb(0.2, 0.3, 0.6) });
    page.drawText(`Quarterly report - page ${p + 1}`, { x: 50, y: 760, size: 22, font: bold, color: rgb(0.1, 0.15, 0.3) });
    page.drawText("Revenue grew in every region this quarter.", { x: 50, y: 670, size: 12, font: helv });
    page.drawText("Operating costs stayed within the plan.", { x: 50, y: 652, size: 12, font: helv });
    page.drawText("분기 보고서 본문 한글 문장입니다", { x: 50, y: 620, size: 14, font: ko });
    page.drawText("표와 그림은 다음 쪽에 있습니다", { x: 50, y: 600, size: 12, font: ko, color: rgb(0.4, 0.1, 0.1) });
    for (let i = 0; i < 4; i++) page.drawRectangle({ x: 60 + i * 120, y: 380, width: 90, height: 60 + i * 40, color: rgb(0.2 + i * 0.15, 0.5, 0.8 - i * 0.15) });
    page.drawCircle({ x: 450, y: 200, size: 60, borderColor: rgb(0, 0.5, 0), borderWidth: 3 });
  }
  return doc.save({ useObjectStreams: objectStreams });
}

function pattern(w: number, h: number, seed: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = (x * 3 + seed * 70) & 255;
      out[i + 1] = (y * 2 + seed * 40) & 255;
      out[i + 2] = ((x + y) * 2 + seed * 90) & 255;
      out[i + 3] = Math.hypot(x - w / 2, y - h / 2) < Math.min(w, h) / 2 ? 255 : 0;
    }
  return out;
}

function psdSample(): Uint8Array {
  const W = 320, H = 240;
  const bg = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) bg.set([240, 236, 228, 255], i * 4);
  return buildPsd({
    width: W,
    height: H,
    layers: [
      { name: "Background", px: { rgba: bg, left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL" },
      { name: "Circle A", px: { rgba: pattern(120, 120, 1), left: 30, top: 40, width: 120, height: 120 }, opacity: 1, visible: true, blend: "NORMAL" },
      { name: "Circle B 60%", px: { rgba: pattern(140, 100, 2), left: 150, top: 90, width: 140, height: 100 }, opacity: 0.6, visible: true, blend: "MULTIPLY" },
      { name: "Hidden note", px: { rgba: pattern(60, 60, 3), left: 10, top: 10, width: 60, height: 60 }, opacity: 1, visible: false, blend: "NORMAL" },
    ],
  });
}

const W_NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"`;
const XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;

/** A Word-like DOCX: styles, heading, mixed runs, list numbering, table, image, header, Letter page. */
function docxSample(): Uint8Array {
  const png = encodePng(pattern(64, 48, 4), 64, 48, 6);
  const run = (t: string, rpr = "") => `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const p = (body: string, ppr = "") => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${body}</w:p>`;
  const cell = (t: string, w = 3000) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${p(run(t))}</w:tc>`;
  const img = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1219200" cy="914400"/><wp:docPr id="1" name="Picture 1"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1219200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  const body = [
    p(run("Project status report"), `<w:pStyle w:val="Heading1"/>`),
    p(run("This paragraph mixes ") + run("bold", "<w:b/>") + run(", ") + run("italic", "<w:i/>") + run(" and ") + run("red", `<w:color w:val="C00000"/>`) + run(" text."), `<w:spacing w:after="120" w:line="276" w:lineRule="auto"/>`),
    p(run("한글 문단: 글꼴과 크기가 다른 런", `<w:rFonts w:eastAsia="Malgun Gothic"/><w:sz w:val="28"/>`), `<w:jc w:val="center"/>`),
    p(run("First list item"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720" w:hanging="360"/>`),
    p(run("Second list item"), `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="720" w:hanging="360"/>`),
    `<w:tbl><w:tblPr><w:tblW w:w="6000" w:type="dxa"/><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid><w:tr>${cell("Region")}${cell("Revenue")}</w:tr><w:tr>${cell("North")}${cell("120")}</w:tr></w:tbl>`,
    p(img),
    p(`<w:hyperlink r:id="rIdLink"><w:r><w:t>example link</w:t></w:r></w:hyperlink>`),
    p(`<w:r><w:br w:type="page"/></w:r>`),
    p(run("Second page paragraph with a field: ") + `<w:fldSimple w:instr=" PAGE "><w:r><w:t>2</w:t></w:r></w:fldSimple>`),
    `<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`,
  ].join("");
  const files: Zippable = {
    "[Content_Types].xml": strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`),
    "_rels/.rels": strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    "word/_rels/document.xml.rels": strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNum" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rIdHdr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/><Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`),
    "word/styles.xml": strToU8(`${XML}<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Malgun Gothic"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`),
    "word/numbering.xml": strToU8(`${XML}<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`),
    "word/header1.xml": strToU8(`${XML}<w:hdr ${W_NS}>${p(run("Header text"))}</w:hdr>`),
    "word/media/image1.png": png,
    "word/document.xml": strToU8(`${XML}<w:document ${W_NS}><w:body>${body}</w:body></w:document>`),
  };
  return zipSync(files);
}

/** HWPX written by Omniweave's own exporter, then given a table, a picture reference and a page number like 한글 writes. */
function hwpxSample(): Uint8Array {
  const doc = newDocument("hwpx sample");
  const page = newPage("DOCUMENT", 794, 1123, "hwpx");
  const t = newText("공문서 제목", 600, { fontSize: 24, bold: true });
  t.paragraphs.push({ ...t.paragraphs[0], id: "p2", runs: [{ ...t.paragraphs[0].runs[0], text: "본문 첫 문단입니다. 굵게와 보통 글자가 섞여 있습니다.", bold: false, fontSize: 14.7 }] });
  t.paragraphs.push({ ...t.paragraphs[0], id: "p3", align: "RIGHT", runs: [{ ...t.paragraphs[0].runs[0], text: "오른쪽 정렬 문단", bold: false, fontSize: 14.7, color: "#C00000" }] });
  page.nodes.push(t);
  doc.pages = [page];
  const base = unzipSync(exportHwpx(doc.pages, "hwpx sample"));
  const sec = new TextDecoder().decode(base["Contents/section0.xml"]);
  const tc = (txt: string, c: number) => `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="1"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0"><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${txt}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${c}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="14000" height="1000"/><hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`;
  const table = `<hp:p id="900" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:tbl id="1" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="2" cellSpacing="0" borderFillIDRef="1" noAdjust="0"><hp:sz width="28000" widthRelTo="ABSOLUTE" height="1000" heightRelTo="ABSOLUTE" protect="0"/><hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:tr>${tc("구분", 0)}${tc("금액", 1)}</hp:tr></hp:tbl></hp:run></hp:p>`;
  const pageNum = `<hp:p id="901" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl></hp:run></hp:p>`;
  base["Contents/section0.xml"] = strToU8(sec.replace(/<\/hs:sec>\s*$/, `${table}${pageNum}</hs:sec>`));
  return zipSync(base as Zippable);
}

/** An Excel-like XLSX: shared strings, numbers, a formula with cached value, merged cells, number format, two sheets. */
function xlsxSample(): Uint8Array {
  const sst = ["Item", "Qty", "Price", "Total", "Widget", "Gadget", "Summary sheet", "합계"];
  const s = (i: number) => `t="s"><v>${i}</v>`;
  const sheet1 = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="4" width="11" customWidth="1"/></cols><sheetData><row r="1"><c r="A1" s="1" ${s(0)}</c><c r="B1" s="1" ${s(1)}</c><c r="C1" s="1" ${s(2)}</c><c r="D1" s="1" ${s(3)}</c></row><row r="2"><c r="A2" ${s(4)}</c><c r="B2"><v>3</v></c><c r="C2" s="2"><v>12.5</v></c><c r="D2" s="2"><f>B2*C2</f><v>37.5</v></c></row><row r="3"><c r="A3" ${s(5)}</c><c r="B3"><v>2</v></c><c r="C3" s="2"><v>40</v></c><c r="D3" s="2"><f>B3*C3</f><v>80</v></c></row><row r="4"><c r="A4" ${s(7)}</c><c r="D4" s="2"><f>SUM(D2:D3)</f><v>117.5</v></c></row><row r="6"><c r="A6" s="3"><v>46023</v></c></row></sheetData><mergeCells count="1"><mergeCell ref="A4:C4"/></mergeCells></worksheet>`;
  const sheet2 = `${XML}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" ${s(6)}</c></row><row r="2"><c r="A2"><f>Sheet1!D4</f><v>117.5</v></c></row></sheetData></worksheet>`;
  const files: Zippable = {
    "[Content_Types].xml": strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`),
    "_rels/.rels": strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`${XML}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/></sheets><definedNames><definedName name="GrandTotal">Sheet1!$D$4</definedName></definedNames></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
    "xl/sharedStrings.xml": strToU8(`${XML}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">${sst.map((t) => `<si><t>${t}</t></si>`).join("")}</sst>`),
    "xl/styles.xml": strToU8(`${XML}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(sheet1),
    "xl/worksheets/sheet2.xml": strToU8(sheet2),
  };
  return zipSync(files);
}

async function pptxSample(): Promise<Uint8Array> {
  const doc = newDocument("slides sample");
  const s1 = newPage("SLIDE", 1280, 720, "slide 1");
  const title = newText("Fidelity sample deck", 900, { fontSize: 44, bold: true });
  title.transform = { x: 80, y: 80, rotation: 0, scale: 1 };
  const body = newText("Second line of body text 한글 본문", 900, { fontSize: 24 });
  body.transform = { x: 80, y: 220, rotation: 0, scale: 1 };
  const box = newVector([rectContour(80, 400, 400, 200)], "box");
  s1.nodes.push(title, body, box);
  const s2 = newPage("SLIDE", 1280, 720, "slide 2");
  const tb = newTable([["Region", "Q1"], ["North", "120"]], [200, 120], "table");
  tb.transform = { x: 100, y: 120, rotation: 0, scale: 1 };
  s2.nodes.push(tb);
  doc.pages = [s1, s2];
  return (await exportPptx(doc, doc.pages)).bytes;
}

const enc = (t: string) => new TextEncoder().encode(t);

export async function publicSamples(): Promise<Sample[]> {
  const out: Sample[] = [
    { name: "sample-report.pdf", bytes: await pdfSample(false), note: "pdf-lib · 표준 글꼴 + 한글 글꼴 임베드 · 3쪽" },
    { name: "sample-objstm.pdf", bytes: await pdfSample(true), note: "pdf-lib · 객체 스트림(xref stream)" },
    { name: "sample-layers.psd", bytes: psdSample(), note: "레이어 4개(불투명도·곱하기·숨김)" },
    { name: "sample-word.docx", bytes: docxSample(), note: "Word 구조: 스타일·제목·목록·표·그림·머리글·하이퍼링크·필드·Letter 용지" },
    { name: "sample-hangul.hwpx", bytes: hwpxSample(), note: "오메 HWPX + 표·쪽 번호" },
    { name: "sample-sheet.xlsx", bytes: xlsxSample(), note: "공유 문자열·수식·병합·표시 형식·틀 고정·이름 정의·시트 2개" },
    { name: "sample-slides.pptx", bytes: await pptxSample(), note: "오메 PPTX(텍스트·도형·표)" },
    { name: "sample-utf8.txt", bytes: enc("첫 줄 UTF-8\r\nsecond line\r\n\r\n끝 줄\r\n"), note: "UTF-8 · CRLF" },
    { name: "sample-bom.txt", bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc("BOM이 있는 파일\nline 2\n")]), note: "UTF-8 BOM · LF" },
    { name: "sample-cp949.txt", bytes: encodeText("완성형 한글 CP949 파일\r\n두 번째 줄\r\n", { encoding: "euc-kr", eol: "\r\n" }), note: "CP949 · CRLF" },
    { name: "sample-run.bat", bytes: encodeText("@echo off\r\nrem 한글 주석\r\necho done\r\n", { encoding: "euc-kr", eol: "\r\n" }), note: "배치 파일 CP949" },
    { name: "sample.json", bytes: enc('{\n  "name": "fidelity",\n  "items": [1, 2, 3],\n  "nested": { "ok": true }\n}\n'), note: "JSON 2칸 들여쓰기" },
    { name: "sample-compact.json", bytes: enc('{"a":1,"b":[true,false],"c":"한글"}'), note: "JSON 한 줄(정렬 제안 거절)" },
    { name: "sample.xml", bytes: enc('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <item id="1">값</item>\n</root>\n'), note: "XML" },
    { name: "sample.yaml", bytes: enc("name: fidelity\nlist:\n  - a\n  - b\n"), note: "YAML" },
    { name: "sample.log", bytes: enc("2026-11-11 00:00:01 INFO start\n2026-11-11 00:00:02 WARN slow\n"), note: "로그" },
    { name: "sample-semicolon.csv", bytes: enc('name;amount;memo\r\n"Kim, J";1200;"line ""quoted"""\r\n이;300;\r\n'), note: "CSV · 세미콜론 · 따옴표" },
    { name: "sample-cp949.csv", bytes: encodeText("이름,금액\r\n가나,100\r\n다라,200\r\n", { encoding: "euc-kr", eol: "\r\n" }), note: "CSV · CP949" },
    { name: "sample.srt", bytes: enc("1\r\n00:00:01,000 --> 00:00:03,500\r\n첫 자막\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\nSecond cue\r\ntwo lines\r\n\r\n"), note: "SRT 자막 2개" },
    { name: "sample.md", bytes: enc("# 제목\n\n본문 **굵게** 와 *기울임*.\n\n- 항목 1\n- 항목 2\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n"), note: "Markdown 제목·강조·목록·표·코드" },
    { name: "sample.html", bytes: enc('<!doctype html>\n<html><head><meta charset="utf-8"><title>Sample</title><style>p{color:red}</style></head>\n<body><h1 class="t">Title</h1><p>Para <b>bold</b> <a href="https://example.com">link</a></p><ul><li>one</li><li>two</li></ul><table><tr><td>1</td><td>2</td></tr></table><script>var x=1;</script></body></html>\n'), note: "HTML 제목·문단·목록·표·스타일·스크립트" },
    { name: "sample.png", bytes: encodePng(pattern(200, 150, 5), 200, 150, 6), note: "PNG 투명도" },
    { name: "sample.svg", bytes: enc('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect x="10" y="10" width="120" height="80" fill="#3a7"/><circle cx="150" cy="60" r="40" fill="none" stroke="#a33" stroke-width="6"/></svg>'), note: "SVG" },
  ];
  return out;
}
