// Integration checks for sheet stage 2 (integ-xlsx2): on the Excel-made chart workbook, a partial save keeps the
// chart, drawing and picture parts byte for byte, and inserted / deleted rows move the chart series references by
// Excel's rules; a merge shrunk to one cell is dropped from the model as from the XML.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import type { SheetData } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { readZip } from "../../src/io/officesurgeon/zip";
import { applyStructToBook, applyStructToSheet, type StructOp } from "../../src/io/sheet/structure";
import { useStore } from "../../src/core/store";
import { paintChart } from "../../src/render/sheetChart";
import { changeLines, setFilterColumn, sortRange, toggleFilter } from "../../src/ui/sheet/sheetEdit";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const BYTES = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-chart.xlsx"));
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "c.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "c", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const sheets = (doc: OmwDocument) => doc.pages.filter((p) => p.sheet).map((p) => p.sheet!);
const raw = (b: Uint8Array) => {
  const z = readZip(b)!;
  return Object.fromEntries(z.entries.map((e) => [e.name, Buffer.from(b.subarray(e.start, e.end)).toString("hex")]));
};
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
function struct(doc: OmwDocument, i: number, op: StructOp) {
  const all = sheets(doc);
  applyStructToBook(all, i, op);
  all[i].struct = [...(all[i].struct ?? []), op];
}
const DRAWN = /^xl\/(charts\/|drawings\/|media\/)/;

describe("chart workbook saved after edits", () => {
  it("a cell edit keeps every chart, drawing and picture part byte for byte", async () => {
    const doc = await open(BYTES);
    sheets(doc)[0].cells.B3 = { ...sheets(doc)[0].cells.B3, v: 999 };
    const out = await save(doc);
    const a = raw(BYTES), b = raw(out);
    const names = Object.keys(a).filter((n) => DRAWN.test(n));
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(b[n], n).toBe(a[n]);
    expect(part(out, "xl/worksheets/sheet1.xml")).toMatch(/<c r="B3"[^>]*><v>999<\/v>/);
  });

  it("the same with 3-D and chartex charts (waterfall, histogram, treemap, …): their parts stay byte for byte", async () => {
    const more = new Uint8Array(readFileSync("qa/interop/excel-made/omni-xlsx-chart-more.xlsx"));
    const doc = await open(more);
    sheets(doc)[0].cells.G3 = { ...sheets(doc)[0].cells.G3, v: 50 };
    const out = await save(doc);
    const a = raw(more), b = raw(out);
    const names = Object.keys(a).filter((n) => DRAWN.test(n));
    expect(names.filter((n) => /chartEx\d+\.xml$/.test(n)).length).toBe(5);
    for (const n of names) expect(b[n], n).toBe(a[n]);
    expect(part(out, "xl/worksheets/sheet1.xml")).toMatch(/<c r="G3"[^>]*><v>50<\/v>/);
  });

  it("an inserted row inside the data grows the series; the other sheet's picture stays byte for byte", async () => {
    const doc = await open(BYTES);
    struct(doc, 0, { axis: "row", at: 3, n: 1 });
    const out = await save(doc);
    const c1 = part(out, "xl/charts/chart1.xml");
    expect(c1).toContain("<c:f>차트!$B$1</c:f>");
    expect(c1).toContain("<c:f>차트!$A$2:$A$8</c:f>");
    expect(c1).toContain("<c:f>차트!$B$2:$B$8</c:f>");
    expect(part(out, "xl/charts/chart6.xml")).toContain("<c:f>차트!$G$2:$G$12</c:f>");
    const a = raw(BYTES), b = raw(out);
    for (const n of ["xl/media/image1.png", "xl/drawings/drawing2.xml"]) expect(b[n], n).toBe(a[n]);
  });

  it("deleting the header row turns the series name into #REF! and shrinks nothing else", async () => {
    const doc = await open(BYTES);
    struct(doc, 0, { axis: "row", at: 0, n: -1 });
    const c1 = part(await save(doc), "xl/charts/chart1.xml");
    expect(c1).toContain("<c:f>차트!#REF!</c:f>");
    expect(c1).toContain("<c:f>차트!$A$1:$A$6</c:f>");
  });
});

describe("sort, filter and inserted rows are one undo step each", () => {
  const snap = (id: string) => JSON.stringify(useStore.getState().doc.pages.find((p) => p.id === id)!.sheet, (k, v) => (k === "struct" ? undefined : v));
  it("undo puts the cells, the filter and the hidden rows back exactly", async () => {
    const doc = await open(BYTES);
    useStore.getState().load(doc);
    const id = doc.pages.find((p) => p.sheet)!.id;
    const before = snap(id);
    sortRange(id, { r0: 1, c0: 0, r1: 6, c1: 1 }, [{ col: 1, desc: true }], false);
    expect(snap(id)).not.toBe(before);
    useStore.getState().undo();
    expect(snap(id)).toBe(before);

    toggleFilter(id);
    const sh = () => useStore.getState().doc.pages.find((p) => p.id === id)!.sheet!;
    expect(sh().filter).toBeTruthy();
    const keep = String(sh().cells.A2.v);
    setFilterColumn(id, 0, [keep]);
    expect(sh().hiddenRows?.length).toBeGreaterThan(0);
    useStore.getState().undo();
    useStore.getState().undo();
    expect(snap(id)).toBe(before);

    expect(changeLines(id, { axis: "row", at: 2, n: 2 })).toBe(true);
    expect(snap(id)).not.toBe(before);
    useStore.getState().undo();
    expect(snap(id)).toBe(before);
  });
});

describe("automatic chart titles", () => {
  it("are drawn in the sheet's language, as the spreadsheet program shows them", () => {
    const xml = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:overlay val="0"/></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:val></c:ser><c:ser><c:idx val="1"/><c:order val="1"/><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>4</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/><c:title/><c:crossAx val="1"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`;
    const drawn = (lang: "ko" | "en") => {
      const texts: string[] = [];
      const ctx: any = new Proxy({}, {
        get: (o: any, k) => (k in o ? o[k] : k === "fillText" ? (s: string) => texts.push(s) : k === "measureText" ? (s: string) => ({ width: s.length * 6, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }) : k === "createLinearGradient" || k === "createPattern" ? () => ({ addColorStop() {} }) : () => {}),
        set: (o: any, k, v) => ((o[k] = v), true),
      });
      paintChart(ctx, xml, [], 0, 0, 400, 300, 1, { lang, font: "sans-serif" });
      return texts.join("|");
    };
    expect(drawn("ko")).toContain("차트 제목");
    expect(drawn("ko")).toContain("축 제목");
    expect(drawn("en")).toContain("Chart Title");
  });
});

describe("merges in the model", () => {
  it("a merge shrunk to one cell by a deleted column is dropped", () => {
    const sh = { name: "S", cells: {}, merges: ["A1:B1", "D1:F2"], rowH: {}, colW: {} } as unknown as SheetData;
    applyStructToSheet(sh, { axis: "col", at: 1, n: -1 });
    expect(sh.merges).toEqual(["C1:E2"]);
  });
});
