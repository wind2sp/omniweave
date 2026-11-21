// Office Surgeon for sheet pages (io/sheet/book.ts): an unedited workbook saves byte for byte; an edit rewrites only
// the cells, styles, widths, merges and sheet entries it touched.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument, Page } from "../../src/core/types";
import type { SheetData } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { readXlsx } from "../../src/io/sheet/read";
import { readZip } from "../../src/io/officesurgeon/zip";
import { Book } from "../../src/io/sheet/calc";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function book(sheetData: string, opts: { extra?: Record<string, string>; macro?: boolean; calcChain?: boolean } = {}): Uint8Array {
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
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="10" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheetData}</sheetData></worksheet>`),
  };
  if (opts.calcChain) files["xl/calcChain.xml"] = strToU8(`<?xml version="1.0"?><calcChain ${NS}><c r="B3" i="1"/></calcChain>`);
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = strToU8(v);
  return zipSync(files);
}

async function open(bytes: Uint8Array, name = "omw-오메장부.xlsx"): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, msgs: string[] = []) {
  return (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const sheetOf = (doc: OmwDocument, name?: string): SheetData => (name ? doc.pages.find((p) => p.sheet?.name === name) : doc.pages.find((p) => p.sheet))!.sheet!;
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
const raw = (b: Uint8Array, skip: string[]) => {
  const z = readZip(b)!;
  return Object.fromEntries(z.entries.filter((e) => !skip.includes(e.name)).map((e) => [e.name, Buffer.from(b.subarray(e.start, e.end)).toString("hex")]));
};
const HEAD = `<row r="1"><c r="A1" t="inlineStr"><is><t>이름</t></is></c><c r="B1" t="inlineStr"><is><t>값</t></is></c></row>`;
const FIDELITY = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-fidelity.xlsx"));

/** apply an edit and recalculate what depends on it, as the grid does */
function edit(doc: OmwDocument, sheet: string, a: string, f: (c: SheetData["cells"][string] | undefined) => SheetData["cells"][string] | undefined) {
  const sheets = doc.pages.filter((p) => p.sheet).map((p) => p.sheet!);
  const si = sheets.findIndex((s) => s.name === sheet);
  const next = f(sheets[si].cells[a]);
  if (next) sheets[si].cells[a] = next;
  else delete sheets[si].cells[a];
  const b = new Book(sheets);
  for (const ch of b.recalc(b.dependents([{ sheet: si, addr: a }]))) {
    const c = sheets[ch.sheet].cells[ch.addr];
    c.v = ch.v;
    if (ch.t) c.t = ch.t;
    else delete c.t;
  }
}

describe("Office Surgeon — sheet pages", () => {
  for (const f of ["qa/interop/adobe-made/excel_book.xlsx", "qa/interop/excel-made/omni-xlsx-fidelity.xlsx", "qa/interop/omniweave-made/xls-01-two-sheets.xlsx", "qa/interop/office-surgeon/omw-excel_book.same.xlsx"])
    it(`an unedited workbook is saved byte for byte: ${f.split("/").pop()}`, async () => {
      const bytes = new Uint8Array(readFileSync(f));
      const doc = await open(bytes);
      expect(doc.pages.every((p) => p.sheet)).toBe(true);
      const out = await save(doc);
      expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
    });

  it("one changed cell: its sheet and workbook.xml change, the formulas that use it are recalculated, its style is kept", async () => {
    const doc = await open(FIDELITY);
    edit(doc, "서식", "B3", (c) => ({ ...c, v: 10 }));
    const sh = sheetOf(doc, "서식");
    expect(sh.cells.D3.v).toBe(10 * 1000);
    const out = await save(doc);
    const p = sh.part!;
    // 수식 refers to 서식 (=서식!D13, =SUM(서식!B3:B12)/…): recalculated too
    const p3 = sheetOf(doc, "수식").part!;
    expect(sheetOf(doc, "수식").cells.H5.v).toBe(sh.cells.D13.v);
    expect(raw(out, [p, p3, "xl/workbook.xml"])).toEqual(raw(FIDELITY, [p, p3, "xl/workbook.xml"]));
    const before = part(FIDELITY, p), after = part(out, p);
    const s = /<c r="B3"( s="\d+")/.exec(before)![1];
    expect(after).toContain(`<c r="B3"${s}><v>10</v></c>`);
    expect(after).toMatch(/<c r="D3"[^>]*><f>B3\*C3<\/f><v>10000<\/v><\/c>/);
    expect(part(out, "xl/workbook.xml")).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
    const back = readXlsx(out, "ko").sheets.find((x) => x.name === "서식")!;
    expect(back.cells.B3.v).toBe(10);
    expect(back.styles[back.cells.B3.s ?? 0]).toEqual(sh.styles[sh.cells.B3.s ?? 0]);
  });

  it("a look change (bold, number format) adds a cell format to styles.xml instead of being dropped", async () => {
    const doc = await open(FIDELITY);
    const sh = sheetOf(doc, "서식");
    const s = sh.styles.push({ ...sh.styles[sh.cells.A3.s ?? 0], bold: true, fmt: "0.0%" }) - 1;
    sh.cells.A3 = { ...sh.cells.A3, s };
    const out = await save(doc);
    const back = readXlsx(out, "ko").sheets.find((x) => x.name === "서식")!;
    expect(back.styles[back.cells.A3.s!]).toMatchObject({ bold: true, fmt: "0.0%" });
    const xfs = (x: string) => Number(/<cellXfs count="(\d+)"/.exec(x)![1]);
    expect(xfs(part(out, "xl/styles.xml"))).toBe(xfs(part(FIDELITY, "xl/styles.xml")) + 1);
  });

  it("the master of a shared formula: every cell of the group is written with its own formula", async () => {
    const data = HEAD + `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A2*2</f><v>2</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>`;
    const doc = await open(book(data));
    edit(doc, "오메", "B2", (c) => ({ ...c!, f: "A2*3" }));
    const x = part(await save(doc), "xl/worksheets/sheet1.xml");
    expect(x).toContain('<c r="B2"><f>A2*3</f><v>3</v></c>');
    expect(x).toContain('<c r="B3"><f>A3*2</f><v>4</v></c>');
    expect(x).not.toContain('si="0"');
  });

  it("a value typed over a cell of a shared formula drops calcChain.xml and leaves the master as it was", async () => {
    const data = HEAD + `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A2*2</f><v>2</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>`;
    const doc = await open(book(data, { calcChain: true }));
    edit(doc, "오메", "B3", () => ({ v: 99 }));
    const out = await save(doc);
    expect(unzipSync(out)["xl/calcChain.xml"]).toBeUndefined();
    expect(part(out, "xl/worksheets/sheet1.xml")).toContain('<c r="B3"><v>99</v></c>');
    expect(part(out, "xl/worksheets/sheet1.xml")).toContain('<f t="shared" ref="B2:B3" si="0">A2*2</f>');
  });

  it("a macro workbook (.xlsm) is written anew as a plain workbook", async () => {
    const doc = await open(book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>매크로</t></is></c></row>`, { macro: true }));
    edit(doc, "오메", "A2", () => ({ v: "오메" }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(strFromU8(unzipSync(out)["[Content_Types].xml"])).not.toContain("macroEnabled");
    expect(msgs.join("\n")).toContain("새로 만듭니다");
  });

  it("an Excel table's header cell is rewritten in place with its column's name (xlsxTables.ts); a body cell too", async () => {
    const extra = {
      "xl/worksheets/_rels/sheet1.xml.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
      "xl/tables/table1.xml": `<?xml version="1.0"?><table ${NS} id="1" name="OmniTable" displayName="OmniTable" ref="A1:B2"><tableColumns count="2"><tableColumn id="1" name="이름"/><tableColumn id="2" name="값"/></tableColumns></table>`,
    };
    const data = HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>가</t></is></c><c r="B2"><v>1</v></c></row>`;
    const doc = await open(book(data, { extra }));
    edit(doc, "오메", "A1", () => ({ v: "오메 이름" }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    expect(part(out, "xl/tables/table1.xml")).toContain('<tableColumn id="1" name="오메 이름"/>');
    expect(part(out, "xl/worksheets/sheet1.xml")).toContain("오메 이름");
    const doc2 = await open(book(data, { extra }));
    edit(doc2, "오메", "A2", () => ({ v: "오메" }));
    const msgs2: string[] = [];
    expect(part(await save(doc2, msgs2), "xl/worksheets/sheet1.xml")).toContain("오메");
    expect(msgs2).toEqual([]);
  });

  it("cells without an address keep their column when a cell before them is emptied", async () => {
    const doc = await open(book(HEAD + `<row r="2"><c t="inlineStr"><is><t>앞</t></is></c><c t="inlineStr"><is><t>뒤</t></is></c></row>`));
    edit(doc, "오메", "A2", () => undefined);
    const back = readXlsx(await save(doc), "ko").sheets[0];
    expect(back.cells.A2).toBeUndefined();
    expect(back.cells.B2.v).toBe("뒤");
  });

  it("sheets renamed, added and removed: workbook.xml, its relationships and content types follow", async () => {
    const doc = await open(FIDELITY);
    const pages = doc.pages;
    pages[0].sheet!.name = "형식 바꿈";
    const added: Page = { ...pages[2], id: "new", name: "새 시트", sheet: { ...pages[2].sheet!, name: "새 시트", index: undefined, part: undefined, xf: undefined, cells: { A1: { v: "오메" }, B1: { f: "1+1", v: 2 } }, styles: [{}] } };
    doc.pages = [pages[0], pages[2], added]; // 서식 removed
    const out = await save(doc);
    const back = readXlsx(out, "ko").sheets;
    expect(back.map((s) => s.name)).toEqual(["형식 바꿈", "수식", "새 시트"]);
    expect(back[2].cells.B1).toMatchObject({ f: "1+1", v: 2 });
    const files = unzipSync(out);
    expect(files[pages[1].sheet!.part!]).toBeUndefined();
    expect(strFromU8(files["[Content_Types].xml"])).toContain(`/${back[2].part}`);
  });

  it("a column width dragged and a merge added are written; the rest of the sheet stays", async () => {
    const doc = await open(FIDELITY);
    const sh = sheetOf(doc, "수식");
    sh.colW[1] = 120;
    sh.merges = [...sh.merges, "H42:I43"];
    const out = await save(doc);
    const back = readXlsx(out, "ko").sheets.find((x) => x.name === "수식")!;
    expect(back.colW[1]).toBe(120);
    expect(back.merges).toContain("H42:I43");
    expect(back.cells).toEqual(readXlsx(FIDELITY, "ko").sheets.find((x) => x.name === "수식")!.cells);
  });

  it("control characters typed into a cell are not written raw", async () => {
    const doc = await open(book(HEAD));
    edit(doc, "오메", "A2", () => ({ v: "오메\u000b사과\u0001" }));
    const xml = part(await save(doc), "xl/worksheets/sheet1.xml");
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)).toBe(false);
  });
});
