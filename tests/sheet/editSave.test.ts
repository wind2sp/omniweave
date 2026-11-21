// Sheet editing stage 2 saved surgically (io/sheet/bookExtra.ts): rows / columns inserted and deleted, notes,
// data validation and AutoFilter — read back the same, only the touched parts change.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import type { SheetData } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { readXlsx } from "../../src/io/sheet/read";
import { readZip } from "../../src/io/officesurgeon/zip";
import { applyStructToBook, type StructOp } from "../../src/io/sheet/structure";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function book(sheet: string, extra: Record<string, string> = {}, sheetRels?: string, wbExtra = ""): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/><sheet name="Sum" sheetId="2" r:id="rId3"/></sheets>${wbExtra}</workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/></Relationships>`,
    ),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}>${sheet}</worksheet>`),
    "xl/worksheets/sheet2.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="1"><c r="A1"><f>SUM(Data!A1:A4)</f><v>10</v></c><c r="B1"><f>Data!B3</f><v>3</v></c></row></sheetData></worksheet>`),
  };
  if (sheetRels) files["xl/worksheets/_rels/sheet1.xml.rels"] = strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheetRels}</Relationships>`);
  for (const [k, v] of Object.entries(extra)) files[k] = strToU8(v);
  return zipSync(files);
}
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "t.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const sheets = (doc: OmwDocument) => doc.pages.filter((p) => p.sheet).map((p) => p.sheet!);
const part = (b: Uint8Array, name: string) => {
  const f = unzipSync(b)[name];
  return f ? strFromU8(f) : null;
};
const raw = (b: Uint8Array) => {
  const z = readZip(b)!;
  return Object.fromEntries(z.entries.map((e) => [e.name, Buffer.from(b.subarray(e.start, e.end)).toString("hex")]));
};
/** what the grid does on Insert / Delete */
function struct(doc: OmwDocument, name: string, op: StructOp) {
  const all = sheets(doc);
  const i = all.findIndex((s) => s.name === name);
  applyStructToBook(all, i, op);
  all[i].struct = [...(all[i].struct ?? []), op];
}
/** the saved file reads back as the model (values and formulas of every sheet) */
function sameAsModel(out: Uint8Array, doc: OmwDocument) {
  const back = readXlsx(out, "en").sheets;
  for (const sh of sheets(doc)) {
    const b = back.find((x) => x.name === sh.name)!;
    const pick = (s: SheetData) => Object.fromEntries(Object.entries(s.cells).filter(([, c]) => c.v !== undefined || c.f).map(([a, c]) => [a, [c.f ?? null, c.f ? null : c.v]]));
    expect(pick(b), sh.name).toEqual(pick(sh));
  }
  return back;
}

const SHEET1 =
  `<dimension ref="A1:C4"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="B3" sqref="B3"/></sheetView></sheetViews><cols><col min="2" max="3" width="20" customWidth="1"/></cols>` +
  `<sheetData><row r="1" spans="1:3"><c r="A1"><v>1</v></c><c r="B1"><f>A1*2</f><v>2</v></c><c r="C1"><f t="shared" ref="C1:C4" si="0">A1+1</f><v>2</v></c></row>` +
  `<row r="2" spans="1:3"><c r="A2"><v>2</v></c><c r="C2"><f t="shared" si="0"/><v>3</v></c></row>` +
  `<row r="3" spans="1:3" ht="30" customHeight="1"><c r="A3"><v>3</v></c><c r="B3"><f>SUM($A$1:A3)</f><v>6</v></c><c r="C3"><f t="shared" si="0"/><v>4</v></c></row>` +
  `<row r="4" spans="1:3"><c r="A4"><v>4</v></c><c r="C4"><f t="shared" si="0"/><v>5</v></c></row></sheetData>` +
  `<mergeCells count="1"><mergeCell ref="D3:E4"/></mergeCells>` +
  `<conditionalFormatting sqref="A1:A4"><cfRule type="expression" dxfId="0" priority="1"><formula>A1&gt;2</formula></cfRule></conditionalFormatting>` +
  `<dataValidations count="2"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="E1:E10"><formula1>"Yes,No"</formula1></dataValidation><dataValidation type="whole" operator="between" showErrorMessage="1" errorTitle="Count" error="1 to 9" sqref="F1"><formula1>1</formula1><formula2>9</formula2></dataValidation></dataValidations>` +
  `<hyperlinks><hyperlink ref="A4" location="Sum!A1"/></hyperlinks><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`;

describe("rows and columns saved", () => {
  it("insert rows: cells, shared formulas, heights, merges, formats, validation, links, panes and the other sheet move", async () => {
    const bytes = book(SHEET1, {}, undefined, `<definedNames><definedName name="Total">Data!$A$1:$A$4</definedName></definedNames>`);
    const doc = await open(bytes);
    struct(doc, "Data", { axis: "row", at: 1, n: 2 });
    const out = await save(doc);
    sameAsModel(out, doc);
    const x = part(out, "xl/worksheets/sheet1.xml")!;
    expect(x).toContain('<row r="5" ht="30" customHeight="1">');
    expect(x).toMatch(/<c r="B5"><f>SUM\(\$A\$1:A5\)<\/f>/);
    expect(x).not.toContain('si="0"');
    expect(x).toContain('<mergeCell ref="D5:E6"/>');
    expect(x).toContain('sqref="A1:A6"');
    expect(x).toContain('sqref="E1:E12"');
    expect(x).toContain('<hyperlink ref="A6"');
    expect(x).toContain('ySplit="4"');
    expect(x).toContain('<dimension ref="A1:C6"/>');
    expect(x).toContain('activeCell="B5"');
    expect(part(out, "xl/worksheets/sheet2.xml")).toContain("<f>SUM(Data!A1:A6)</f>");
    expect(part(out, "xl/worksheets/sheet2.xml")).toContain("<f>Data!B5</f>");
    expect(part(out, "xl/workbook.xml")).toContain("Data!$A$1:$A$6");
    // the reader sees the same as the model
    const back = readXlsx(out, "en").sheets[0];
    expect(back.rowH[4]).toBe(40);
    expect(back.freeze).toEqual({ rows: 4, cols: 0 });
    expect(back.valid!.map((v) => v.ranges[0])).toEqual(["E1:E12", "F1"]);
  });

  it("delete a column: #REF! where a reference pointed into it, widths split and shrink", async () => {
    const doc = await open(book(SHEET1));
    struct(doc, "Data", { axis: "col", at: 0, n: -1 });
    const out = await save(doc);
    sameAsModel(out, doc);
    const x = part(out, "xl/worksheets/sheet1.xml")!;
    expect(x).toContain('<c r="A1"><f>#REF!*2</f>');
    expect(x).toContain('<col min="1" max="2" width="20" customWidth="1"/>');
    expect(x).not.toContain("<conditionalFormatting");
    expect(x).toContain('<mergeCell ref="C3:D4"/>');
    expect(part(out, "xl/worksheets/sheet2.xml")).toContain("<f>SUM(Data!#REF!)</f>");
    expect(part(out, "xl/worksheets/sheet2.xml")).toContain("<f>Data!A3</f>");
  });

  it("drawing anchors follow inserted rows; an unedited drawing part stays byte for byte otherwise", async () => {
    const drawing = `<?xml version="1.0"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>6</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`;
    const bytes = book(SHEET1 + `<drawing r:id="rId1"/>`, { "xl/drawings/drawing1.xml": drawing }, `<Relationship Id="rId1" Type="${REL}/drawing" Target="../drawings/drawing1.xml"/>`);
    let doc = await open(bytes);
    struct(doc, "Data", { axis: "row", at: 0, n: 1 });
    const d = part(await save(doc), "xl/drawings/drawing1.xml")!;
    expect(d).toContain("<xdr:row>3</xdr:row>");
    expect(d).toContain("<xdr:row>7</xdr:row>");
    doc = await open(bytes);
    sheets(doc)[1].cells.C1 = { v: 5 };
    const out = await save(doc);
    expect(raw(out)["xl/drawings/drawing1.xml"]).toBe(raw(bytes)["xl/drawings/drawing1.xml"]);
  });
});

const COMMENTS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<comments ${NS}><authors><author>Kim</author></authors><commentList><comment ref="A1" authorId="0"><text><r><rPr><b/></rPr><t>Kim:</t></r><r><t xml:space="preserve">\nfirst</t></r></text></comment><comment ref="B2" authorId="0"><text><t>second</t></text></comment></commentList></comments>`;
const VML = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype><v:shape id="_x0000_s1025" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Anchor>1, 15, 0, 2, 3, 15, 4, 16</x:Anchor><x:Row>0</x:Row><x:Column>0</x:Column></x:ClientData></v:shape><v:shape id="_x0000_s1026" type="#_x0000_t202"><x:ClientData ObjectType="Note"><x:Anchor>2, 15, 1, 2, 4, 15, 5, 16</x:Anchor><x:Row>1</x:Row><x:Column>1</x:Column></x:ClientData></v:shape></xml>`;

describe("notes", () => {
  const withNotes = () =>
    book(
      `<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><legacyDrawing r:id="rId2"/>`,
      { "xl/comments1.xml": COMMENTS, "xl/drawings/vmlDrawing1.vml": VML },
      `<Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/><Relationship Id="rId2" Type="${REL}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/>`,
    );
  it("are read from the comments part", async () => {
    const doc = await open(withNotes());
    expect(sheets(doc)[0].notes).toEqual({ A1: { text: "Kim:\nfirst", author: "Kim" }, B2: { text: "second", author: "Kim" } });
  });
  it("edit, add and delete: unchanged notes keep their XML, the VML shapes follow", async () => {
    const doc = await open(withNotes());
    const sh = sheets(doc)[0];
    sh.notes = { A1: sh.notes!.A1, C5: { text: "new <one> & more" } };
    const out = await save(doc);
    const c = part(out, "xl/comments1.xml")!;
    expect(c).toContain('<comment ref="A1" authorId="0"><text><r><rPr><b/></rPr><t>Kim:</t></r>');
    expect(c).not.toContain('ref="B2"');
    expect(c).toContain('<comment ref="C5" authorId="0"><text><t xml:space="preserve">new &lt;one&gt; &amp; more</t></text></comment>');
    const v = part(out, "xl/drawings/vmlDrawing1.vml")!;
    expect(v).toContain("_x0000_s1025");
    expect(v).not.toContain("_x0000_s1026");
    expect(v).toContain("<x:Row>4</x:Row><x:Column>2</x:Column>");
    expect(readXlsx(out, "en").sheets[0].notes!.C5.text).toBe("new <one> & more");
  });
  it("a note on a sheet without notes creates the comments and VML parts", async () => {
    const doc = await open(book(`<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`));
    sheets(doc)[0].notes = { B3: { text: "hello" } };
    const out = await save(doc);
    const files = unzipSync(out);
    expect(Object.keys(files)).toContain("xl/comments1.xml");
    expect(Object.keys(files)).toContain("xl/drawings/vmlDrawing1.vml");
    expect(part(out, "[Content_Types].xml")).toContain('PartName="/xl/comments1.xml"');
    expect(part(out, "[Content_Types].xml")).toContain('Extension="vml"');
    expect(part(out, "xl/worksheets/_rels/sheet1.xml.rels")).toContain('Target="../comments1.xml"');
    expect(part(out, "xl/worksheets/sheet1.xml")).toMatch(/<pageMargins[^>]*\/><legacyDrawing r:id="rId2"\/><\/worksheet>/);
    expect(readXlsx(out, "en").sheets[0].notes).toEqual({ B3: { text: "hello" } });
  });
  it("deleting every note removes the parts", async () => {
    const doc = await open(withNotes());
    sheets(doc)[0].notes = {};
    const out = await save(doc);
    expect(Object.keys(unzipSync(out))).not.toContain("xl/comments1.xml");
    expect(part(out, "xl/worksheets/sheet1.xml")).not.toContain("legacyDrawing");
    expect(readXlsx(out, "en").sheets[0].notes).toBeUndefined();
  });
  it("move with inserted rows", async () => {
    const doc = await open(withNotes());
    struct(doc, "Data", { axis: "row", at: 0, n: 1 });
    const out = await save(doc);
    expect(readXlsx(out, "en").sheets[0].notes).toEqual({ A2: { text: "Kim:\nfirst", author: "Kim" }, B3: { text: "second", author: "Kim" } });
    expect(part(out, "xl/drawings/vmlDrawing1.vml")).toContain("<x:Row>2</x:Row><x:Column>1</x:Column>");
  });
  it("threaded comments show as read-only notes", async () => {
    const tc = `<?xml version="1.0"?><ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><threadedComment ref="D4" id="{1}" personId="{p}"><text>Look</text></threadedComment><threadedComment ref="D4" id="{2}" parentId="{1}" personId="{p}"><text>Done</text></threadedComment></ThreadedComments>`;
    const doc = await open(book(`<sheetData/>`, { "xl/threadedComments/threadedComment1.xml": tc }, `<Relationship Id="rId1" Type="http://schemas.microsoft.com/office/2017/10/relationships/threadedComment" Target="../threadedComments/threadedComment1.xml"/>`));
    expect(sheets(doc)[0].notes).toEqual({ D4: { text: "Look\nDone", threaded: true } });
  });
});

describe("data validation and AutoFilter", () => {
  it("validation rules are read (and the x14 list on another sheet)", async () => {
    const ext = `<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:dataValidations xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main" count="1"><x14:dataValidation type="list" allowBlank="1"><x14:formula1><xm:f>Sum!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>G1:G5</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst>`;
    const doc = await open(book(SHEET1 + ext));
    const v = sheets(doc)[0].valid!;
    expect(v[0]).toMatchObject({ ranges: ["E1:E10"], type: "list", f1: '"Yes,No"', allowBlank: true, showError: true });
    expect(v[1]).toMatchObject({ type: "whole", op: "between", f1: "1", f2: "9", errTitle: "Count", error: "1 to 9" });
    expect(v[2]).toMatchObject({ ranges: ["G1:G5"], type: "list", f1: "Sum!$A$1:$A$3" });
  });
  it("an AutoFilter with value filters and its hidden rows round-trip; the hidden name is added", async () => {
    const doc = await open(book(`<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Fruit</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Apple</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Pear</t></is></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`));
    const sh = sheets(doc)[0];
    sh.filter = { ref: "A1:A3", cols: { 0: { vals: ["Apple"] } } };
    sh.hiddenRows = [2];
    const out = await save(doc);
    const x = part(out, "xl/worksheets/sheet1.xml")!;
    expect(x).toContain('</sheetData><autoFilter ref="A1:A3"><filterColumn colId="0"><filters><filter val="Apple"/></filters></filterColumn></autoFilter><pageMargins');
    expect(part(out, "xl/workbook.xml")).toContain('<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$A$3</definedName></definedNames>');
    const back = readXlsx(out, "en").sheets[0];
    expect(back.filter).toEqual(sh.filter);
    expect(back.hiddenRows).toEqual([2]);
  });
});

describe("the measured workbook", () => {
  const FIDELITY = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-fidelity.xlsx"));
  it("a row inserted into 서식 moves the formulas of 수식 that point at it, nothing else changes", async () => {
    const doc = await open(FIDELITY);
    struct(doc, "서식", { axis: "row", at: 4, n: 1 });
    struct(doc, "서식", { axis: "col", at: 1, n: 1 });
    const out = await save(doc);
    sameAsModel(out, doc);
    const a = raw(FIDELITY), b = raw(out);
    const changed = Object.keys(b).filter((k) => a[k] !== b[k]).sort();
    const p = sheets(doc).find((s) => s.name === "서식")!.part!, q = sheets(doc).find((s) => s.name === "수식")!.part!;
    // calcChain.xml goes (cells moved), with its relationship and content type
    expect(changed.filter((k) => ![p, q, "xl/workbook.xml", "[Content_Types].xml", "xl/_rels/workbook.xml.rels"].includes(k))).toEqual([]);
    expect(Object.keys(b)).not.toContain("xl/calcChain.xml");
  });
});
