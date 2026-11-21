// DATEVALUE / TIMEVALUE (표 계산 부서, 2026-11-16 측정 결함 ①): values checked against Excel 365 ko-KR (new instance),
// and an edited formula with them is saved with its result; a function Omniweave does not know is saved without a
// result and with fullCalcOnLoad so Excel recalculates it on open.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { SheetData } from "../../src/core/sheetTypes";
import type { OmwDocument } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { Book, recalcAll } from "../../src/io/sheet/calc";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

function calc(f: string): number | string | boolean | undefined {
  const sh: SheetData = { book: "b", name: "S", cells: { A1: { f } }, styles: [{}], colW: {}, rowH: {}, defColW: 64, defRowH: 20, merges: [], grid: true, headings: true, baseFont: "Calibri", baseSize: 11, mdw: 7 };
  const b = new Book([sh]);
  b.now = () => Date.UTC(2026, 10, 16, 3);
  for (const ch of b.recalc()) Object.assign(sh.cells[ch.addr], { v: ch.v, ...(ch.stale ? { stale: true } : {}) });
  return sh.cells.A1.stale ? "stale" : sh.cells.A1.v;
}
const q = (s: string) => `"${s}"`;

describe("DATEVALUE / TIMEVALUE — Excel's answers", () => {
  // [text, DATEVALUE, TIMEVALUE] from Excel 365 ko-KR, 2026-11-16 ("#" = #VALUE!)
  const CASES: [string, number | "#", number | "#"][] = [
    ["2026/1/2", 46024, 0], ["2026-1-2", 46024, 0], ["2026.1.2", "#", "#"], ["11/16", 46342, 0], ["11-16", 46342, 0],
    ["1/2/2026", "#", "#"], ["2026-11-16 9:30", 46342, 0.395833333333333], ["9:30", 0, 0.395833333333333],
    ["9:30:15", 0, 0.396006944444444], ["9:30 AM", 0, 0.395833333333333], ["9:30 PM", 0, 0.895833333333333],
    ["오전 9:30", "#", "#"], ["2026년 1월 2일", 46024, 0], ["1월 2일", "#", "#"], ["16-Jan", 46038, 0], ["16-Jan-2026", 46038, 0],
    ["Jan 16, 2026", 46038, 0], ["January 16, 2026", 46038, 0], ["2026-02-30", "#", "#"], ["2026-13-40", "#", "#"],
    ["26-1-2", 46024, 0], ["13/1", 46035, 0], ["2026/1", 46023, 0], ["2026-01", 46023, 0], ["25:00", 1, 0.0416666666666667],
    ["12:00:00 AM", 0, 0], [" 2026-01-02 ", 46024, 0], ["1900-01-01", 1, 0], ["1899-12-31", "#", "#"], ["9999-12-31", 2958465, 0],
    ["10000-1-1", "#", "#"], ["2026-1-2 25:00", 46025, 0.0416666666666667], ["9:60", 0, 0.416666666666667], ["", "#", "#"],
  ];
  for (const [s, d, t] of CASES)
    it(JSON.stringify(s), () => {
      const dv = calc(`DATEVALUE(${q(s)})`), tv = calc(`TIMEVALUE(${q(s)})`);
      if (d === "#") expect(dv).toBe("#VALUE!");
      else expect(dv).toBe(d);
      if (t === "#") expect(tv).toBe("#VALUE!");
      else expect(tv as number).toBeCloseTo(t, 9);
    });

  it("a number is not text: #VALUE!", () => {
    expect(calc("DATEVALUE(45000)")).toBe("#VALUE!");
    expect(calc("TIMEVALUE(0.5)")).toBe("#VALUE!");
    expect(calc('YEAR(DATEVALUE("2026-03-15"))')).toBe(2026);
  });
});

async function open(path: string): Promise<OmwDocument> {
  const bytes = new Uint8Array(readFileSync(path));
  const r = await formatForExt("xlsx")!.open({ name: "omw-book.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);

describe("an edited DATEVALUE formula is saved with its result", () => {
  it("excel_book 매출 Sales!A3: (DATEVALUE(\"2026-01-05\"))+1 → <v>46028</v>", async () => {
    const doc = await open("qa/interop/adobe-made/excel_book.xlsx");
    const sheets = doc.pages.filter((p) => p.sheet).map((p) => p.sheet!);
    const sh = sheets.find((s) => s.name === "매출 Sales")!;
    expect(sh.cells.A3.f).toBe('DATEVALUE("2026-01-05")');
    expect(sh.cells.A3.stale).toBeFalsy(); // known now: recalculated on open, not "stale"
    sh.cells.A3 = { ...sh.cells.A3, f: '(DATEVALUE("2026-01-05"))+1' };
    recalcAll(sheets);
    expect(sh.cells.A3.v).toBe(46028);
    const xml = part(await save(doc), sh.part!);
    expect(xml).toMatch(/<c r="A3"[^>]*><f>\(DATEVALUE\(&quot;2026-01-05&quot;\)\)\+1<\/f><v>46028<\/v><\/c>/);
  });

  it("a function Omniweave does not know: no stored result, and Excel recalculates on open (fullCalcOnLoad)", async () => {
    const doc = await open("qa/interop/adobe-made/excel_book.xlsx");
    const sheets = doc.pages.filter((p) => p.sheet).map((p) => p.sheet!);
    const sh = sheets.find((s) => s.name === "매출 Sales")!;
    sh.cells.A3 = { ...sh.cells.A3, f: "OMWNOSUCH(1)", v: undefined };
    recalcAll(sheets);
    expect(sh.cells.A3.stale).toBe(true);
    const out = await save(doc);
    expect(part(out, sh.part!)).toMatch(/<c r="A3"[^>]*><f>OMWNOSUCH\(1\)<\/f><\/c>/);
    expect(part(out, "xl/workbook.xml")).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
  });
});
