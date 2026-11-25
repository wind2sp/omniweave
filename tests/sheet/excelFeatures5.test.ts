// Excel features, fifth round (표 Excel 기능 5): 숫자 필터 · 텍스트 필터 (custom AutoFilter conditions) matched,
// written and read back (sheet AutoFilter fresh and surgical, a table's filter); a picture put on a sheet
// (삽입 ▸ 그림) written as a drawing with its media part, fresh and surgically.
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import type { SheetData } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { readXlsx } from "../../src/io/sheet/read";
import { writeFreshXlsx } from "../../src/io/sheet/book";
import { customMatch, filterHiddenRows, findAll } from "../../src/io/sheet/sortFilter";
import { tableToSheet } from "../../src/io/sheet/pages";
import { recalcAll } from "../../src/io/sheet/calc";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const part = (b: Uint8Array, name: string) => {
  const f = unzipSync(b)[name];
  return f ? strFromU8(f) : null;
};
function sheetOf(rows: (string | number)[][], name = "Data"): SheetData {
  const sh = tableToSheet(name, rows.map((r) => r.map((v) => ({ text: String(v) }))), rows[0].map(() => 64));
  rows.forEach((r, i) => r.forEach((v, j) => (sh.cells[String.fromCharCode(65 + j) + (i + 1)] = { v })));
  return sh;
}
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "omni-f5.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;

describe("숫자 필터 · 텍스트 필터", () => {
  it("conditions match numbers as numbers and texts with wildcards; and / or", () => {
    expect(customMatch({ items: [{ op: "greaterThan", val: "2" }] }, 3, "3")).toBe(true);
    expect(customMatch({ items: [{ op: "greaterThan", val: "2" }] }, 2, "2")).toBe(false);
    expect(customMatch({ and: true, items: [{ op: "greaterThanOrEqual", val: "2" }, { op: "lessThanOrEqual", val: "4" }] }, 5, "5")).toBe(false);
    expect(customMatch({ items: [{ op: "lessThan", val: "2" }, { op: "greaterThan", val: "4" }] }, 5, "5")).toBe(true);
    expect(customMatch({ items: [{ op: "equal", val: "a*" }] }, "Apple", "Apple")).toBe(true);
    expect(customMatch({ items: [{ op: "notEqual", val: "*pp*" }] }, "apple", "apple")).toBe(false);
    expect(customMatch({ items: [{ op: "equal", val: "p?ar" }] }, "pear", "pear")).toBe(true);
  });

  it("a sheet AutoFilter's condition: rows hidden, written fresh, read back, kept surgically", async () => {
    const sh = sheetOf([["qty"], [1], [3], [2], [5]]);
    sh.filter = { ref: "A1:A5", cols: { 0: { custom: { items: [{ op: "greaterThan", val: "2" }] } } } };
    expect(filterHiddenRows(sh, sh.filter, "en")).toEqual([1, 3]);
    const out = writeFreshXlsx([sh]);
    expect(part(out, "xl/worksheets/sheet1.xml")).toMatch(/<filterColumn colId="0"><customFilters><customFilter operator="greaterThan" val="2"\/><\/customFilters><\/filterColumn>/);
    const back = readXlsx(out, "en", "b").sheets[0];
    expect(back.filter?.cols?.[0]).toEqual({ custom: { items: [{ op: "greaterThan", val: "2" }] } });
    const doc = await open(out);
    const s2 = doc.pages[0].sheet!;
    s2.filter = { ...s2.filter!, cols: { 0: { custom: { and: true, items: [{ op: "greaterThanOrEqual", val: "2" }, { op: "lessThan", val: "5" }] } } } };
    const out2 = await save(doc);
    expect(part(out2, "xl/worksheets/sheet1.xml")).toMatch(/<customFilters and="1"><customFilter operator="greaterThanOrEqual" val="2"\/><customFilter operator="lessThan" val="5"\/><\/customFilters>/);
  });

  it("a table's text condition (시작 문자 → a*) written and read back", () => {
    const sh = sheetOf([["name"], ["apple"], ["pear"], ["avocado"]]);
    sh.tables = [{ name: "표1", ref: "A1:A4", cols: ["name"], style: "TableStyleMedium2", filter: { ref: "A1:A4", cols: { 0: { custom: { items: [{ op: "equal", val: "a*" }] } } } } }];
    const out = writeFreshXlsx([sh]);
    expect(part(out, "xl/tables/table1.xml")).toMatch(/<filterColumn colId="0"><customFilters><customFilter val="a\*"\/><\/customFilters><\/filterColumn>/);
    expect(readXlsx(out, "en", "b").sheets[0].tables?.[0].filter?.cols?.[0]).toEqual({ custom: { items: [{ op: "equal", val: "a*" }] } });
  });
});

describe("삽입 ▸ 그림", () => {
  const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
  const pic = () => ({ kind: "pic" as const, name: "Picture 1", at: { c0: 1, x0: 0, r0: 2, y0: 0, w: 96, h: 48 }, data: png, mime: "image/png" });

  it("a fresh workbook: the drawing's xdr:pic, the media part, its rel and content type", () => {
    const sh = sheetOf([["x"]]);
    sh.drawings = [pic()];
    const out = writeFreshXlsx([sh]);
    const dr = part(out, "xl/drawings/drawing1.xml")!;
    expect(dr).toMatch(/<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>1<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>2<\/xdr:row>/);
    expect(dr).toMatch(/<xdr:pic>[\s\S]*<a:blip r:embed="rId\d+"\/>[\s\S]*<a:ext cx="914400" cy="457200"\/>/);
    expect(part(out, "xl/drawings/_rels/drawing1.xml.rels")).toMatch(/Type="[^"]*\/image" Target="\.\.\/media\/image1\.png"/);
    expect(unzipSync(out)["xl/media/image1.png"]).toEqual(png);
    expect(part(out, "[Content_Types].xml")).toMatch(/image\/png/);
  });

  it("surgically into a workbook (a new picture), the next save keeps one", async () => {
    const doc = await open(writeFreshXlsx([sheetOf([["x"]])]));
    const sh = doc.pages[0].sheet!;
    sh.drawings = [...(sh.drawings ?? []), pic()];
    const out = await save(doc);
    expect(Object.keys(unzipSync(out)).filter((f) => /^xl\/media\//.test(f))).toEqual(["xl/media/image1.png"]);
    expect(part(out, "xl/drawings/drawing1.xml")).toMatch(/<xdr:pic>/);
    expect(part(out, "xl/worksheets/sheet1.xml")).toMatch(/<drawing r:id="rId\d+"\/>/);
    const again = await open(out);
    again.pages[0].sheet!.cells.B1 = { v: 1 };
    const out2 = await save(again);
    expect(Object.keys(unzipSync(out2)).filter((f) => /^xl\/media\//.test(f))).toEqual(["xl/media/image1.png"]);
    expect((part(out2, "xl/drawings/drawing1.xml")!.match(/<xdr:pic>/g) ?? []).length).toBe(1);
  });
});

describe("functions added: MODE, PERCENTILE, QUARTILE, PMT / FV / PV / NPV / RATE / NPER / IPMT / PPMT, XMATCH, ADDRESS, WORKDAY, TRANSPOSE spills", () => {
  it("give Excel's values", () => {
    const sh = sheetOf([[2], [4], [4], [6], [9]]);
    const f: Record<string, string> = {
      C1: "MODE(A1:A5)", C2: "PERCENTILE(A1:A5,0.25)", C3: "QUARTILE(A1:A5,3)", C4: "ROUND(PMT(0.05/12,36,-10000000),0)", C5: "ROUND(FV(0.03/12,12,-100000),0)",
      C6: "ROUND(PV(0.04,10,-1000),2)", C7: "ROUND(NPV(0.1,-1000,300,400,500),2)", C8: "ROUND(RATE(10,-100,800),4)", C9: "ROUND(NPER(0.01,-100,1000),2)",
      C10: "ROUND(IPMT(0.1,1,3,1000),2)", C11: "ROUND(PPMT(0.1,1,3,1000),2)", C12: "XMATCH(4,A1:A5)", C13: "XMATCH(5,A1:A5,1)", C14: "XMATCH(5,A1:A5,-1)", C15: "ADDRESS(2,3)",
      C16: "ADDRESS(2,3,4)", C17: "WORKDAY(DATE(2026,3,13),1)", C18: "PERCENTILE.EXC(A1:A5,0.5)",
    };
    for (const [a, x] of Object.entries(f)) sh.cells[a] = { f: x };
    sh.cells.E1 = { f: "TRANSPOSE(A1:A3)" };
    recalcAll([sh]);
    const v = (a: string) => sh.cells[a]?.v;
    expect(Object.keys(f).map(v)).toEqual([4, 4, 6, 299709, 1216638, 8110.9, -19.12, 0.0428, 10.59, -100, -302.11, 2, 4, 2, "$C$2", "C2", 46097, 4]);
    expect([v("E1"), v("F1"), v("G1")]).toEqual([2, 4, 4]);
  });
});

describe("계산 옵션 수동, 데이터 표, 시나리오, 서식 찾기 in the file", () => {
  it("calcMode=manual written fresh and surgically, read back; switched off surgically", async () => {
    const sh = sheetOf([[1]]);
    sh.calcManual = true;
    const out = writeFreshXlsx([sh]);
    expect(part(out, "xl/workbook.xml")).toMatch(/<calcPr calcId="191029" calcMode="manual"/);
    expect(readXlsx(out, "en", "b").sheets[0].calcManual).toBe(true);
    const doc = await open(writeFreshXlsx([sheetOf([[1]])]));
    doc.pages[0].sheet!.calcManual = true;
    const out2 = await save(doc);
    expect(part(out2, "xl/workbook.xml")).toMatch(/<calcPr[^>]*calcMode="manual"/);
    const back = await open(out2);
    delete back.pages[0].sheet!.calcManual;
    back.pages[0].sheet!.cells.B1 = { v: 2 };
    expect(part(await save(back), "xl/workbook.xml")).not.toMatch(/calcMode=/);
  });

  it("a data table's f t=\"dataTable\" and the scenarios written and read back", () => {
    const sh = sheetOf([["r", 2], ["", ""], ["", 0], [1], [3]]);
    sh.cells.B3 = { f: "B1*10", v: 20 };
    sh.cells.B4 = { v: 10, dt: { ref: "B4:B5", r1: "B1" } };
    sh.cells.B5 = { v: 30 };
    sh.scenarios = { cur: 1, list: [{ name: "low", cells: ["B1"], vals: ["1"] }, { name: "high", cells: ["B1"], vals: ["9"], comment: "c" }] };
    const out = writeFreshXlsx([sh]);
    const x = part(out, "xl/worksheets/sheet1.xml")!;
    expect(x).toMatch(/<c r="B4"><f t="dataTable" ref="B4:B5" r1="B1"\/><v>10<\/v><\/c>/);
    expect(x).toMatch(/<scenarios current="1" show="1" sqref="B1"><scenario name="low" count="1"><inputCells r="B1" val="1"\/><\/scenario><scenario name="high" count="1" comment="c">/);
    // CT_Worksheet order: scenarios after sheetData, before mergeCells / pageMargins
    expect(x.indexOf("<scenarios")).toBeGreaterThan(x.indexOf("</sheetData>"));
    const back = readXlsx(out, "en", "b").sheets[0];
    expect(back.cells.B4.dt).toEqual({ ref: "B4:B5", r1: "B1" });
    expect(back.scenarios).toEqual(sh.scenarios);
  });

  it("찾기 ▸ 서식: only the cells with the formats, with or without text", () => {
    const sh = sheetOf([["x1"], ["x2"], ["y3"]]);
    sh.styles.push({ bold: true });
    sh.cells.A2.s = 1;
    sh.cells.A3.s = 1;
    expect(findAll(sh, "", { format: { bold: true } }, "en")).toEqual(["A2", "A3"]);
    expect(findAll(sh, "x", { format: { bold: true } }, "en")).toEqual(["A2"]);
    expect(findAll(sh, "x", {}, "en")).toEqual(["A1", "A2"]);
  });
});

describe("창 나누기, 메모 스레드, 데이터 표 다시 계산", () => {
  it("a split pane written (twips, state split) and read back as rows / columns", () => {
    const sh = sheetOf([[1]]);
    sh.split = { rows: 3, cols: 2, top: 0, left: 0 };
    const out = writeFreshXlsx([sh]);
    const x = part(out, "xl/worksheets/sheet1.xml")!;
    expect(x).toMatch(/<pane xSplit="\d+" ySplit="\d+" topLeftCell="C4" activePane="bottomRight" state="split"\/>/);
    expect(readXlsx(out, "en", "b").sheets[0].split).toEqual({ rows: 3, cols: 2, top: 0, left: 0, row: 3, col: 2 });
  });

  it("threads: threadedComments + persons + the legacy comment, read back; a reply added surgically", async () => {
    const sh = sheetOf([["x"]]);
    const th = { id: "{11111111-2222-4333-8444-555555555555}", items: [{ id: "{11111111-2222-4333-8444-555555555555}", author: "Omniweave QA", text: "check", date: "2026-11-25T10:00:00.00" }] };
    sh.threads = { A1: th };
    sh.notes = { A1: { text: "[Threaded comment] check", author: `tc=${th.id}`, threaded: true } };
    const out = writeFreshXlsx([sh]);
    const files = Object.keys(unzipSync(out));
    expect(files).toContain("xl/threadedComments/threadedComment1.xml");
    expect(files).toContain("xl/persons/person.xml");
    expect(part(out, "xl/_rels/workbook.xml.rels")).toMatch(/relationships\/person" Target="persons\/person.xml"/);
    expect(part(out, "xl/comments1.xml")).toMatch(/<author>tc=\{11111111-2222-4333-8444-555555555555\}<\/author>/);
    const back = readXlsx(out, "en", "b").sheets[0];
    expect(back.threads?.A1.items.map((x) => [x.author, x.text])).toEqual([["Omniweave QA", "check"]]);
    const doc = await open(out);
    const s2 = doc.pages[0].sheet!;
    const t2 = s2.threads!.A1;
    s2.threads = { A1: { ...t2, done: true, items: [...t2.items, { id: "{AAAAAAAA-2222-4333-8444-555555555555}", author: "Lee", text: "done", date: "2026-11-25T11:00:00.00" }] } };
    const out2 = await save(doc);
    const tx = part(out2, "xl/threadedComments/threadedComment1.xml")!;
    expect(tx).toMatch(/done="1"/);
    expect(tx).toMatch(/parentId="\{11111111-2222-4333-8444-555555555555\}"><text>done<\/text>/);
    expect(part(out2, "xl/persons/person.xml")).toMatch(/displayName="Lee"/);
  });
});
