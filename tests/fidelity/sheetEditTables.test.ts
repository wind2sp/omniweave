// QA 2026-11-16 (xlsx-table-header): the one-place edit measurement (tests/fidelity/sheetEdit.ts comparePackages,
// used by scripts/fidelity-xlsx-edit.mjs) lets an Excel table part change only when the edit is that table's header
// (its column name) or totals label (totalsRowLabel), and then only inside <tableColumns>. Any other table part change
// is still "바뀌면 안 되는 파트 바뀜".
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { comparePackages, packageDiffs } from "./sheetEdit";

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const table = (id: number, ref: string, cols: string[], extra = "") =>
  `<?xml version="1.0"?><table ${NS} id="${id}" name="T${id}" displayName="T${id}" ref="${ref}"${extra}><autoFilter ref="${ref}"/><tableColumns count="${cols.length}">${cols.map((c, i) => `<tableColumn id="${i + 1}" name="${c}"/>`).join("")}</tableColumns></table>`;

function pkg(o: { sheet?: string; t1?: string; t2?: string } = {}): Uint8Array {
  return zipSync({
    "xl/workbook.xml": strToU8(`<workbook ${NS}><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="1"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(o.sheet ?? `<worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="B1" t="inlineStr"><is><t>b</t></is></c></row><row r="2"><c r="A2"><v>1</v></c></row></sheetData></worksheet>`),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/><Relationship Id="rId2" Type="${REL}/table" Target="../tables/table2.xml"/></Relationships>`),
    // T1 on A1:B3 with a totals row, T2 on D1:E2
    "xl/tables/table1.xml": strToU8(o.t1 ?? table(1, "A1:B3", ["a", "b"], ' totalsRowCount="1"')),
    "xl/tables/table2.xml": strToU8(o.t2 ?? table(2, "D1:E2", ["d", "e"])),
  });
}
const strays = (out: Uint8Array, changed: string[]) => packageDiffs(comparePackages(pkg(), out, new Set(changed))).filter((d) => d.startsWith("바뀌면 안 되는"));

describe("measurement: a table part may change only with its own header / totals label edit", () => {
  it("the table's header cell edited: its column name changed is no stray part", () => {
    expect(strays(pkg({ t1: table(1, "A1:B3", ["a", "매출"], ' totalsRowCount="1"') }), ["0!B1"])).toEqual([]);
  });

  it("the table's totals label edited: totalsRowLabel changed is no stray part", () => {
    expect(strays(pkg({ t1: table(1, "A1:B3", ["a", "b"], ' totalsRowCount="1"').replace('name="a"', 'name="a" totalsRowLabel="합계"') }), ["0!A3"])).toEqual([]);
  });

  it("a body cell edited: the table part changing is still a stray part", () => {
    expect(strays(pkg({ t1: table(1, "A1:B3", ["a", "매출"], ' totalsRowCount="1"') }), ["0!A2"])).toEqual(["바뀌면 안 되는 파트 바뀜: 표 1"]);
  });

  it("the header edited but the table changed outside its column list (range, filter): stray", () => {
    expect(strays(pkg({ t1: table(1, "A1:B4", ["a", "매출"], ' totalsRowCount="1"') }), ["0!B1"])).toEqual(["바뀌면 안 되는 파트 바뀜: 표(열 목록 밖) 1"]);
  });

  it("one table's header edited: another table's part changing is a stray part", () => {
    expect(strays(pkg({ t2: table(2, "D1:E2", ["d", "x"]) }), ["0!B1"])).toEqual(["바뀌면 안 되는 파트 바뀜: 표 1"]);
    // a cell just outside the table's columns in its header row is not its header
    expect(strays(pkg({ t1: table(1, "A1:B3", ["a", "매출"], ' totalsRowCount="1"') }), ["0!C1"])).toEqual(["바뀌면 안 되는 파트 바뀜: 표 1"]);
  });
});
