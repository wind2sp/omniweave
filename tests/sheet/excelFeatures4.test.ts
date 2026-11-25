// Excel features, fourth round (표 Excel 기능 4): an .xls written anew (BIFF8: cells, formulas, formats, sizes,
// merges, panes, outline) read back by the XLS reader; cells shifted down / right within a band (셀 삽입 · 삭제) with
// the references into them; slicers on a table and on a pivot written and read back (fresh and surgically); a pivot's
// items picked (p.show) in its layout.
import { writeFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import type { SheetData, SheetPivot } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { writeFreshXls } from "../../src/io/formats/xlsFresh";
import { readXls } from "../../src/io/sheet/readXls";
import { readXlsx } from "../../src/io/sheet/read";
import { writeFreshXlsx } from "../../src/io/sheet/book";
import { applyStructToBook } from "../../src/io/sheet/structure";
import { tableToSheet } from "../../src/io/sheet/pages";
import { pivotLayout } from "../../src/ui/sheet/sheetFeatures";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const part = (b: Uint8Array, name: string) => {
  const f = unzipSync(b)[name];
  return f ? strFromU8(f) : null;
};
function sheetOf(rows: (string | number)[][], name = "Data"): SheetData {
  const sh = tableToSheet(name, rows.map((r) => r.map((v) => ({ text: String(v) }))), rows[0].map(() => 64));
  rows.forEach((r, i) => r.forEach((v, j) => {
    const a = String.fromCharCode(65 + j) + (i + 1);
    sh.cells[a] = typeof v === "number" ? { v } : { v };
  }));
  return sh;
}

describe("XLS written anew (BIFF8)", () => {
  it("cells, formulas, formats, widths, merges, panes and the outline come back through the XLS reader", () => {
    const a = sheetOf([["item", "qty"], ["pen", 2], ["ink", 5]], "Data");
    a.cells.C2 = { f: "B2*2", v: 4 };
    a.cells.C3 = { f: "SUM($B$2:B3)", v: 7 };
    a.cells.D1 = { f: 'IF(B2>1,"big","small")', v: "big" };
    a.cells.A4 = { v: "한글 텍스트" };
    a.cells.B4 = { v: true };
    const bold = a.styles.push({ bold: true, fill: "#FFC000", fmt: "#,##0.00", bb: { style: "thin", color: "#000000" }, h: "center" }) - 1;
    a.cells.B2 = { v: 2, s: bold };
    a.colW[0] = 120;
    a.rowH[2] = 30;
    a.merges.push("E1:F1");
    a.cells.E1 = { v: "merged" };
    a.freeze = { rows: 1, cols: 0 };
    a.rowLevel = { 1: 1, 2: 1 };
    a.hiddenRows = [2];
    const b = sheetOf([["x"], [1]], "Other");
    b.cells.B1 = { f: "Data!B3+1", v: 6 };
    const out = writeFreshXls([a, b]);
    if (process.env.OMNI_DUMP) writeFileSync(process.env.OMNI_DUMP + "/omni-fresh.xls", out);
    const back = readXls(out, "en").sheets;
    expect(back.map((s) => s.name)).toEqual(["Data", "Other"]);
    const r = back[0];
    expect(r.cells.A2.v).toBe("pen");
    expect(r.cells.A4.v).toBe("한글 텍스트");
    expect(r.cells.B4.v).toBe(true);
    expect(r.cells.C2.f).toBe("B2*2");
    expect(r.cells.C3.f).toBe("SUM($B$2:B3)");
    expect(r.cells.C3.v).toBe(7);
    expect(r.cells.D1.f).toBe('IF(B2>1,"big","small")');
    expect(r.cells.D1.v).toBe("big");
    expect(back[1].cells.B1.f).toBe("Data!B3+1");
    const st = r.styles[r.cells.B2.s!];
    expect(st).toMatchObject({ bold: true, fill: "#FFC000", fmt: "#,##0.00", h: "center" });
    expect(st.bb?.style).toBe("thin");
    expect(r.merges).toContain("E1:F1");
    expect(r.freeze).toEqual({ rows: 1, cols: 0 });
    expect(r.hiddenRows).toEqual([2]);
    expect(Math.abs((r.colW[0] ?? 0) - 120)).toBeLessThanOrEqual(2);
  });
});

describe("cells shifted within a band (셀 삽입 · 셀 삭제)", () => {
  it("only the band's cells move, with the references into them", () => {
    const sh = sheetOf([["a", "b", "c"], [1, 2, 3], [4, 5, 6]]);
    sh.cells.E1 = { f: "SUM(B2:B3)" };
    sh.cells.E2 = { f: "A2+C2" };
    sh.rowH[1] = 40;
    applyStructToBook([sh], 0, { axis: "row", at: 1, n: 1, band: [1, 1] });
    expect(sh.cells.B3.v).toBe(2);
    expect(sh.cells.B4.v).toBe(5);
    expect(sh.cells.B2).toBeUndefined();
    expect(sh.cells.A2.v).toBe(1); // outside the band: stays
    expect(sh.cells.E1.f).toBe("SUM(B3:B4)");
    expect(sh.cells.E2.f).toBe("A2+C2");
    expect(sh.rowH[1]).toBe(40); // the row itself stays
    applyStructToBook([sh], 0, { axis: "col", at: 0, n: -1, band: [0, 0] });
    expect(sh.cells.A1.v).toBe("b");
    expect(sh.cells.A2.v).toBe(1);
  });
});

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "omni-slicer.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;

describe("slicers", () => {
  const book = () => {
    const a = sheetOf([["region", "qty"], ["E", 2], ["W", 3], ["E", 5]], "Data");
    a.tables = [{ name: "표1", ref: "A1:B4", cols: ["region", "qty"], style: "TableStyleMedium2", filter: { ref: "A1:B4", cols: { 0: { vals: ["E"] } } } }];
    a.slicers = [{ name: "region", cache: "슬라이서_region", caption: "region", source: { table: "표1", col: "region" }, at: { c0: 3, x0: 0, r0: 0, y0: 0, w: 180, h: 200 } }];
    const p: SheetPivot = { sheet: "Data", ref: "A1:B4", at: "A3", rows: ["region"], cols: [], vals: [{ field: "qty", fn: "sum" }], out: "A3:B6", show: { region: ["W"] } };
    const b = sheetOf([["x"]], "Pivot");
    b.pivots = [p];
    b.slicers = [{ name: "region 1", cache: "슬라이서_region1", caption: "region", source: { pivotSheet: "Pivot", pivotAt: "A3", field: "region" }, at: { c0: 4, x0: 0, r0: 0, y0: 0, w: 180, h: 200 } }];
    return [a, b];
  };

  it("a fresh workbook: slicer parts, caches, anchors, names — read back", () => {
    const out = writeFreshXlsx(book());
    if (process.env.OMNI_DUMP) writeFileSync(process.env.OMNI_DUMP + "/omni-slicers-fresh.xlsx", out);
    const files = Object.keys(unzipSync(out));
    expect(files.filter((f) => /slicerCaches\/|slicers\//.test(f)).sort()).toEqual(["xl/slicerCaches/slicerCache1.xml", "xl/slicerCaches/slicerCache2.xml", "xl/slicers/slicer1.xml", "xl/slicers/slicer2.xml"]);
    const wb = part(out, "xl/workbook.xml")!;
    expect(wb).toMatch(/<definedName name="슬라이서_region">#N\/A<\/definedName>/);
    expect(wb).toMatch(/\{46BE6895-7355-4a93-B00E-2C351335B9C9\}[\s\S]*<x14:slicerCache r:id=/);
    expect(wb).toMatch(/\{BBE1A952-AA13-448e-AADC-164F8A28A991\}/);
    const caches = [part(out, "xl/slicerCaches/slicerCache1.xml"), part(out, "xl/slicerCaches/slicerCache2.xml")].join("");
    expect(caches).toMatch(/<x15:tableSlicerCache tableId="1" column="1"\/>/);
    expect(caches).toMatch(/<pivotTable tabId="2" name="PivotTable1"\/><\/pivotTables><data><tabular pivotCacheId="100001"><items count="2"><i x="0"\/><i x="1" s="1"\/>/);
    expect(part(out, "xl/pivotTables/pivotTable1.xml")).toMatch(/<item h="1" x="0"\/><item x="1"\/>/);
    expect(part(out, "xl/tables/table1.xml")).toMatch(/<filterColumn colId="0"><filters><filter val="E"\/>/);
    const back = readXlsx(out, "en", "b").sheets;
    expect(back[0].slicers?.[0]).toMatchObject({ name: "region", cache: "슬라이서_region", source: { table: "표1", col: "region" }, fromFile: true });
    expect(back[1].slicers?.[0]).toMatchObject({ name: "region 1", source: { pivotSheet: "Pivot", pivotAt: "A3", field: "region" } });
    expect(back[0].slicers?.[0].at).toMatchObject({ c0: 3, r0: 0 });
  });

  it("surgically into an existing workbook (a new table slicer), kept once on the next save", async () => {
    const [a] = book();
    const base = writeFreshXlsx([{ ...a, slicers: undefined }]);
    const doc = await open(base);
    const sh = doc.pages[0].sheet!;
    sh.slicers = [{ name: "region", cache: "슬라이서_region", caption: "region", source: { table: "표1", col: "region" }, at: { c0: 3, x0: 0, r0: 0, y0: 0, w: 180, h: 200 } }];
    sh.cells.C1 = { v: "x" };
    const out = await save(doc);
    if (process.env.OMNI_DUMP) writeFileSync(process.env.OMNI_DUMP + "/omni-slicers-surgical.xlsx", out);
    expect(Object.keys(unzipSync(out)).filter((f) => /slicer/.test(f)).sort()).toEqual(["xl/slicerCaches/slicerCache1.xml", "xl/slicers/slicer1.xml"]);
    expect(part(out, "xl/slicerCaches/slicerCache1.xml")).toMatch(/tableId="1" column="1"/);
    const back = readXlsx(out, "en", "b").sheets[0];
    expect(back.slicers?.map((s) => s.name)).toEqual(["region"]);
    const again = await open(out);
    again.pages[0].sheet!.cells.C2 = { v: 1 };
    const out2 = await save(again);
    expect(Object.keys(unzipSync(out2)).filter((f) => /slicer/.test(f)).length).toBe(2);
  });

  it("a file's pivot slicer: a new pick written back (pivot items h, cache items s); slicers follow inserted rows, a moved file slicer's anchor rewritten", async () => {
    const base = writeFreshXlsx(book());
    const doc = await open(base);
    const pv = doc.pages.find((p) => p.sheet!.name === "Pivot")!.sheet!;
    expect(pv.pivots![0].show).toEqual({ region: ["W"] });
    pv.pivots![0] = { ...pv.pivots![0], show: { region: ["E"] }, refreshed: true };
    const data = doc.pages.find((p) => p.sheet!.name === "Data")!.sheet!;
    expect(data.slicers![0].fromFile).toBe(true);
    data.slicers![0] = { ...data.slicers![0], at: { c0: 6, x0: 0, r0: 5, y0: 0, w: 180, h: 200 } };
    const out = await save(doc);
    expect(part(out, "xl/pivotTables/pivotTable1.xml")).toMatch(/<item x="0"\/><item h="1" x="1"\/>/);
    expect(part(out, "xl/slicerCaches/slicerCache2.xml") + part(out, "xl/slicerCaches/slicerCache1.xml")).toMatch(/<i x="0" s="1"\/><i x="1"\/>/);
    expect(part(out, "xl/drawings/drawing1.xml")).toMatch(/<xdr:col>6<\/xdr:col><xdr:colOff>0<\/xdr:colOff><xdr:row>5<\/xdr:row>/);
    const back = readXlsx(out, "en", "b").sheets;
    expect(back.find((s) => s.name === "Pivot")!.pivots![0].show).toEqual({ region: ["E"] });
    // rows inserted above a slicer move it
    const sh = back[0];
    const r0 = sh.slicers![0].at.r0;
    applyStructToBook(back, 0, { axis: "row", at: 0, n: 2 });
    expect(sh.slicers![0].at.r0).toBe(r0 + 2);
  });

  it("a pivot's picked items (p.show) leave the other rows out of its layout", () => {
    const [a] = book();
    const p: SheetPivot = { sheet: "Data", ref: "A1:B4", at: "A3", rows: ["region"], cols: [], vals: [{ field: "qty", fn: "sum" }], show: { region: ["E"] } };
    const lay = pivotLayout(a, p)!;
    const flat = lay.cells.map((r) => r.join("|"));
    expect(flat.some((x) => x.startsWith("E|7"))).toBe(true);
    expect(flat.some((x) => x.startsWith("W|"))).toBe(false);
  });
});
