// Excel features, third round (표 Excel 기능 3): SUBTOTAL (filtered rows out, nested subtotals out), Excel tables made
// here (Ctrl+T) written as table parts and read back with their style, the outline (그룹 · 부분합) as row / column
// outline levels — in a fresh workbook and surgically into an existing one — and the function argument hint.
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import type { SheetData } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { readXlsx } from "../../src/io/sheet/read";
import { writeFreshXlsx } from "../../src/io/sheet/book";
import { applyChange, Book } from "../../src/io/sheet/calc";

/** the book recalculated: the value of a cell */
function calc(sheets: SheetData[], a: string, si = 0) {
  const b = new Book(sheets);
  for (const ch of b.recalc()) applyChange(sheets[ch.sheet], ch);
  return sheets[si].cells[a]?.v;
}
import { fnArgs, openCall } from "../../src/io/sheet/fnSigs";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function book(): Uint8Array {
  const rows = [
    `<row r="1"><c r="A1" t="inlineStr"><is><t>item</t></is></c><c r="B1" t="inlineStr"><is><t>qty</t></is></c></row>`,
    ...[1, 2, 3, 4].map((i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>i${i}</t></is></c><c r="B${i + 1}"><v>${i * 10}</v></c></row>`),
  ].join("");
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><bookViews><workbookView/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetFormatPr defaultRowHeight="15"/><sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`),
  });
}
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "omni-feat3.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const part = (b: Uint8Array, name: string) => {
  const f = unzipSync(b)[name];
  return f ? strFromU8(f) : null;
};

function decorate(sh: SheetData) {
  sh.tables = [{ name: "표1", ref: "A1:B5", cols: ["item", "qty"], style: "TableStyleMedium7", rowStripes: false }];
  sh.rowLevel = { 1: 1, 2: 2, 3: 2 };
  sh.colLevel = { 1: 1 };
  sh.hiddenRows = [2, 3];
  sh.cells.D1 = { f: "SUM(표1[qty])" };
  sh.sparks = [{ type: "column", color: "#376092", negColor: "#D00000", items: [{ at: "E2", ref: "Data!B2:B5" }] }];
}
function expectBack(sh: SheetData) {
  expect(sh.tables).toMatchObject([{ name: "표1", ref: "A1:B5", cols: ["item", "qty"], style: "TableStyleMedium7", rowStripes: false }]);
  expect(sh.rowLevel).toEqual({ 1: 1, 2: 2, 3: 2 });
  expect(sh.colLevel).toEqual({ 1: 1 });
  expect(sh.hiddenRows).toEqual([2, 3]);
  expect(calc([sh], "D1")).toBe(100);
  expect(sh.sparks).toEqual([{ type: "column", color: "#376092", negColor: "#D00000", items: [{ at: "E2", ref: "Data!B2:B5" }] }]);
}

describe("SUBTOTAL", () => {
  it("leaves out rows a filter hides (1–11) and every hidden row (101–111), and nested SUBTOTALs", () => {
    const sh = readXlsx(book(), "en", "b").sheets[0];
    sh.filter = { ref: "A1:B5" };
    sh.hiddenRows = [2];
    sh.cells.B6 = { f: "SUBTOTAL(9,B2:B5)" };
    sh.cells.B7 = { f: "SUBTOTAL(9,B2:B6)" };
    sh.cells.B8 = { f: "SUM(B2:B5)" };
    sh.cells.B9 = { f: "SUBTOTAL(1,B2:B5)" };
    sh.cells.B10 = { f: "SUBTOTAL(3,A2:A5)" };
    expect(calc([sh], "B6")).toBe(80);
    expect(sh.cells.B7.v).toBe(80);
    expect(sh.cells.B8.v).toBe(100);
    expect(sh.cells.B9.v).toBeCloseTo(80 / 3);
    expect(sh.cells.B10.v).toBe(3);
    // a row hidden by hand (no filter there): 9 keeps it, 109 leaves it out
    delete sh.filter;
    sh.cells.C1 = { f: "SUBTOTAL(9,B2:B5)" };
    sh.cells.C2 = { f: "SUBTOTAL(109,B2:B5)" };
    expect(calc([sh], "C1")).toBe(100);
    expect(sh.cells.C2.v).toBe(80);
  });
});

describe("tables and the outline written and read back", () => {
  it("a fresh workbook", () => {
    const { sheets } = readXlsx(book(), "en", "b");
    decorate(sheets[0]);
    const out = writeFreshXlsx(sheets);
    const ws = part(out, "xl/worksheets/sheet1.xml")!;
    expect(ws).toMatch(/<tableParts count="1"><tablePart r:id="rId\d+"\/><\/tableParts><extLst>/);
    expect(ws).toMatch(/<sheetFormatPr [^>]*outlineLevelRow="2" outlineLevelCol="1"/);
    expect(ws).toMatch(/<row r="3"[^>]*hidden="1"[^>]*outlineLevel="2"/);
    expect(part(out, "xl/tables/table1.xml")).toMatch(/<table [^>]*id="1" name="표1" displayName="표1" ref="A1:B5"/);
    expect(part(out, "[Content_Types].xml")).toContain('PartName="/xl/tables/table1.xml"');
    expect(ws).toMatch(/<extLst><ext uri="\{05C60535-1F16-4fd2-B633-F4F36F0B64E0\}"[\s\S]*<xm:f>Data!B2:B5<\/xm:f><xm:sqref>E2<\/xm:sqref>[\s\S]*<\/extLst><\/worksheet>$/);
    expectBack(readXlsx(out, "en", "b").sheets[0]);
  });

  it("surgically into the original", async () => {
    const doc = await open(book());
    decorate(doc.pages[0].sheet!);
    const out = await save(doc);
    expect(part(out, "xl/worksheets/_rels/sheet1.xml.rels")).toMatch(/relationships\/table" Target="..\/tables\/table1.xml"/);
    expectBack(readXlsx(out, "en", "b").sheets[0]);
    // the next save of that file keeps the table once (no second part)
    const again = await open(out);
    again.pages[0].sheet!.cells.C1 = { v: 1 };
    const out2 = await save(again);
    expect(Object.keys(unzipSync(out2)).filter((n) => /xl\/tables\//.test(n))).toEqual(["xl/tables/table1.xml"]);
  });
});

describe("function argument hint", () => {
  it("finds the open call and the argument being typed", () => {
    expect(openCall("=VLOOKUP(")).toEqual({ name: "VLOOKUP", arg: 0 });
    expect(openCall('=IF(A1>2,SUM(B1,"a,b",')).toEqual({ name: "SUM", arg: 2 });
    expect(openCall("=IF(A1>2,SUM(B1),")).toEqual({ name: "IF", arg: 2 });
    expect(openCall("=A1+B1")).toBeNull();
    expect(fnArgs("vlookup")).toEqual(["lookup_value", "table_array", "col_index_num", "[range_lookup]"]);
  });
});
