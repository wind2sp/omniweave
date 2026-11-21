// Office Surgeon — XLSX source-preserving save (docs/design/OFFICE_SURGEON.md §5), on an Excel-made workbook.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById } from "../../src/io/formats";
import { legacyOpen } from "./legacyXlsx";
import { parseXlsx } from "../../src/io/formats/xlsx";
import { readZip } from "../../src/io/officesurgeon/zip";
import type { OmwDocument, TableCell, TableNode } from "../../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const BOOK = readFileSync("qa/interop/adobe-made/excel_book.xlsx");

async function open(bytes: Uint8Array = BOOK): Promise<OmwDocument> {
  const r = legacyOpen(bytes);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, msgs: string[] = []) {
  return (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
/** the table node of a sheet holding the cell with this text */
const cellOf = (doc: OmwDocument, text: string): { tb: TableNode; r: number; c: number } => {
  for (const tb of doc.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE"))
    for (let r = 0; r < tb.rows.length; r++) for (let c = 0; c < tb.rows[r].length; c++) if (tb.rows[r][c].text === text) return { tb, r, c };
  throw new Error(text);
};
const setCell = (doc: OmwDocument, text: string, f: (c: TableCell) => TableCell) => {
  const { tb, r, c } = cellOf(doc, text);
  tb.rows[r][c] = f(tb.rows[r][c]);
};
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
const raw = (b: Uint8Array, skip: string[]) => {
  const z = readZip(b)!;
  return Object.fromEntries(z.entries.filter((e) => !skip.includes(e.name)).map((e) => [e.name, Buffer.from(b.subarray(e.start, e.end)).toString("hex")]));
};

describe("Office Surgeon — XLSX", () => {
  it("saving without edits returns the original workbook byte for byte", async () => {
    const doc = await open();
    expect(doc.pages[0].source?.office?.parts.length).toBe(2);
    const out = await save(doc, []);
    expect(Buffer.from(out).equals(BOOK)).toBe(true);
  });

  it("one changed cell: only that sheet and workbook.xml (recalculate on open) change; its style is kept", async () => {
    const doc = await open();
    setCell(doc, "사과", (c) => ({ ...c, text: "오메 사과" }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs).toEqual([]);
    expect(raw(out, ["xl/worksheets/sheet1.xml", "xl/workbook.xml"])).toEqual(raw(BOOK, ["xl/worksheets/sheet1.xml", "xl/workbook.xml"]));
    const before = part(BOOK, "xl/worksheets/sheet1.xml"), after = part(out, "xl/worksheets/sheet1.xml");
    const s = /<c r="B3"( s="\d+")?[^>]*>/.exec(before)![1] ?? "";
    expect(after).toContain(`<c r="B3"${s} t="inlineStr"><is><t xml:space="preserve">오메 사과</t></is></c>`);
    // every other row is the original text
    const rows = (x: string) => x.match(/<row [^>]*>.*?<\/row>/g)!;
    expect(rows(after).filter((r) => !r.includes('r="3"'))).toEqual(rows(before).filter((r) => !r.includes('r="3"')));
    expect(part(out, "xl/workbook.xml")).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
    expect(parseXlsx(out)[0].rows[2][1].text).toBe("오메 사과");
    // formulas of the same row untouched
    expect(after).toContain(/<c r="E3"[^>]*>.*?<\/c>/.exec(before)![0]);
  });

  it("a number edit keeps a numeric cell; a formula replaced by a value drops calcChain.xml", async () => {
    const doc = await open();
    setCell(doc, "1200", (c) => ({ ...c, text: "1500" }));
    setCell(doc, "3600", (c) => ({ text: "3700", align: c.align }));
    const out = await save(doc);
    const x = part(out, "xl/worksheets/sheet1.xml");
    expect(x).toMatch(/<c r="D3"( s="\d+")?><v>1500<\/v><\/c>/);
    expect(x).toMatch(/<c r="E3"( s="\d+")?><v>3700<\/v><\/c>/);
    const files = unzipSync(out);
    expect(files["xl/calcChain.xml"]).toBeUndefined();
    expect(strFromU8(files["[Content_Types].xml"])).not.toContain("calcChain");
    expect(strFromU8(files["xl/_rels/workbook.xml.rels"])).not.toContain("calcChain");
  });

  it("an edited formula is written without a stale cached value", async () => {
    const doc = await open();
    setCell(doc, "35700", (c) => (c.formula === "SUM(E3:E5)" ? { ...c, formula: "SUM(E3:E4)" } : c));
    const x = part(await save(doc), "xl/worksheets/sheet1.xml");
    expect(x).toMatch(/<c r="E6"( s="\d+")?><f>SUM\(E3:E4\)<\/f><\/c>/);
  });

  it("a row added at the end is a new row element, with a note", async () => {
    const doc = await open();
    const { tb } = cellOf(doc, "Melon");
    tb.rows.push(tb.rows[0].map((_, i) => ({ text: i === 1 ? "오메 키위" : "" })));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).toContain("행이나 열 수가 바뀐");
    expect(part(out, "xl/worksheets/sheet1.xml")).toContain('<row r="7"><c r="B7" t="inlineStr"><is><t xml:space="preserve">오메 키위</t></is></c></row>');
    expect(parseXlsx(out)[0].rows[6][1].text).toBe("오메 키위");
  });

  it("a look-only change (bold) leaves the file as it was and says so", async () => {
    const doc = await open();
    setCell(doc, "배", (c) => ({ ...c, bold: !c.bold }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(Buffer.from(out).equals(BOOK)).toBe(true);
    expect(msgs.join("\n")).toContain("굵게");
  });
});
