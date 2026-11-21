// Office Surgeon — XLSX regression cases from the code QA (2026-11-12).
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById } from "../../src/io/formats";
import { legacyOpen } from "./legacyXlsx";
import { parseXlsx } from "../../src/io/formats/xlsx";
import type { OmwDocument, TableCell, TableNode } from "../../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** "오메 장부": one sheet; `extra` adds package entries (tables, rels); `macro` makes it an .xlsm package. */
function book(sheetData: string, opts: { extra?: Record<string, string>; macro?: boolean; styles?: string; calcChain?: boolean } = {}): Uint8Array {
  const main = opts.macro ? "application/vnd.ms-excel.sheet.macroEnabled.main+xml" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${main}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${opts.calcChain ? '<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>' : ""}</Types>`,
    ),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="오메" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${opts.calcChain ? '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/>' : ""}</Relationships>`,
    ),
    "xl/styles.xml": strToU8(opts.styles ?? `<?xml version="1.0"?><styleSheet ${NS}><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="10" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheetData}</sheetData></worksheet>`),
  };
  if (opts.calcChain) files["xl/calcChain.xml"] = strToU8(`<?xml version="1.0"?><calcChain ${NS}><c r="B3" i="1"/></calcChain>`);
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = strToU8(v);
  return zipSync(files);
}

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = legacyOpen(bytes);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, msgs: string[] = []) {
  return (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const tables = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
const setCell = (doc: OmwDocument, text: string, f: (c: TableCell) => TableCell) => {
  for (const tb of tables(doc)) for (const row of tb.rows) for (let i = 0; i < row.length; i++) if (row[i].text === text) return void (row[i] = f(row[i]));
  throw new Error(text);
};
const sheet = (b: Uint8Array) => strFromU8(unzipSync(b)["xl/worksheets/sheet1.xml"]);
const HEAD = `<row r="1"><c r="A1" t="inlineStr"><is><t>이름</t></is></c><c r="B1" t="inlineStr"><is><t>값</t></is></c></row>`;

describe("Office Surgeon XLSX — QA regressions", () => {
  it("a long sheet reopened from .omw: editing its header keeps every row", async () => {
    const rows = Array.from({ length: 150 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}" t="inlineStr"><is><t>r${i + 2}</t></is></c><c r="B${i + 2}"><v>${i}</v></c></row>`).join("");
    const doc0 = await open(book(HEAD + rows));
    expect(tables(doc0).length).toBeGreaterThan(1);
    const doc = JSON.parse(JSON.stringify(doc0)) as OmwDocument; // saved and reopened: no shared header objects
    tables(doc)[0].rows[0][0] = { ...tables(doc)[0].rows[0][0], text: "오메 이름" };
    const out = await save(doc);
    const back = parseXlsx(out)[0].rows;
    expect(back.length).toBe(151);
    expect(back[0][0].text).toBe("오메 이름");
    expect(back[150][0].text).toBe("r151");
  });

  it("the master cell of a shared formula is not rewritten in place (the file is written anew, with a note)", async () => {
    const data = HEAD + `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A2*2</f><v>2</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>`;
    const doc = await open(book(data));
    setCell(doc, "2", (c) => (c.formula ? { ...c, formula: "A2*3" } : c));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
    expect(sheet(out)).not.toContain('si="0"/>');
  });

  it("a value typed over a shared-formula cell drops calcChain.xml", async () => {
    const data = HEAD + `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A2*2</f><v>2</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>`;
    const doc = await open(book(data, { calcChain: true }));
    setCell(doc, "4", (c) => ({ ...c, text: "99", formula: undefined }));
    const out = await save(doc);
    expect(unzipSync(out)["xl/calcChain.xml"]).toBeUndefined();
    expect(sheet(out)).toContain('<c r="B3"><v>99</v></c>');
    expect(sheet(out)).toContain('<f t="shared" ref="B2:B3" si="0">A2*2</f>');
  });

  it("a macro workbook (.xlsm) is not saved as .xlsx with a macro content type", async () => {
    const doc = await open(book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>매크로</t></is></c></row>`, { macro: true }));
    setCell(doc, "매크로", (c) => ({ ...c, text: "오메" }));
    const out = await save(doc);
    expect(strFromU8(unzipSync(out)["[Content_Types].xml"])).not.toContain("macroEnabled");
  });

  it("a bare number typed into a percent cell is written as text, not ×100", async () => {
    const doc = await open(book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>비율</t></is></c><c r="B2" s="1"><v>0.25</v></c></row>`));
    setCell(doc, "25%", (c) => ({ ...c, text: "30" }));
    const x = sheet(await save(doc));
    expect(x).toContain('<c r="B2" s="1" t="inlineStr"><is><t xml:space="preserve">30</t></is></c>');
  });

  it("an Excel table's header cell is rewritten in place with its column's name (xlsxTables.ts)", async () => {
    const extra = {
      "xl/worksheets/_rels/sheet1.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
      "xl/tables/table1.xml": `<?xml version="1.0"?><table ${NS} id="1" name="OmniTable" displayName="OmniTable" ref="A1:B2"><tableColumns count="2"><tableColumn id="1" name="이름"/><tableColumn id="2" name="값"/></tableColumns></table>`,
    };
    const doc = await open(book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>가</t></is></c><c r="B2"><v>1</v></c></row>`, { extra }));
    setCell(doc, "이름", (c) => ({ ...c, text: "오메 이름" }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    expect(strFromU8(unzipSync(out)["xl/tables/table1.xml"])).toContain('<tableColumn id="1" name="오메 이름"/>');
    expect(sheet(out)).toContain("오메 이름");
    // a body cell of the same table is fine
    const doc2 = await open(book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>가</t></is></c><c r="B2"><v>1</v></c></row>`, { extra }));
    setCell(doc2, "가", (c) => ({ ...c, text: "오메" }));
    const msgs2: string[] = [];
    expect(sheet(await save(doc2, msgs2))).toContain("오메");
    expect(msgs2).toEqual([]);
  });

  it("cells without an address keep their column when a cell before them is emptied", async () => {
    const doc = await open(book(HEAD + `<row r="2"><c t="inlineStr"><is><t>앞</t></is></c><c t="inlineStr"><is><t>뒤</t></is></c></row>`));
    setCell(doc, "앞", (c) => ({ ...c, text: "" }));
    const back = parseXlsx(await save(doc))[0].rows;
    expect(back[1].map((c) => c.text)).toEqual(["", "뒤"]);
  });

  it("a value typed into a formula cell says it is recalculated", async () => {
    const doc = await open(book(HEAD + `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f>A2*2</f><v>2</v></c></row>`));
    setCell(doc, "2", (c) => (c.formula ? { ...c, text: "5" } : c));
    const msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("다시 계산");
  });
});
