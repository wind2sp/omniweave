// Excel features made here and saved (표 계산 Excel 기능 쓰기): conditional formats (cell rules, top/bottom, data bars,
// colour scales, icon sets, formulas), data validation with messages, hyperlinks, sheet / workbook protection, page
// setup with print area / titles and header / footer, defined names, cell protection, and charts — written into a
// fresh workbook and surgically into an existing one, read back the same.
import { writeFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument } from "../../src/core/types";
import type { SheetData } from "../../src/core/sheetTypes";
import { exportById, formatForExt } from "../../src/io/formats";
import { readXlsx } from "../../src/io/sheet/read";
import { writeFreshXlsx } from "../../src/io/sheet/book";
import { excelPasswordHash } from "../../src/io/sheet/writeParts";
import { chartXml } from "../../src/io/sheet/writeDrawings";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function book(): Uint8Array {
  const rows = [
    `<row r="1"><c r="A1" t="inlineStr"><is><t>Month</t></is></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c><c r="C1" t="inlineStr"><is><t>Cost</t></is></c></row>`,
    ...[1, 2, 3, 4, 5].map((i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>M${i}</t></is></c><c r="B${i + 1}"><v>${i * 10}</v></c><c r="C${i + 1}"><v>${i * 4}</v></c></row>`),
  ].join("");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><bookViews><workbookView/></bookViews><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`),
  };
  return zipSync(files);
}
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "omni-feat.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const part = (b: Uint8Array, name: string) => {
  const f = unzipSync(b)[name];
  return f ? strFromU8(f) : null;
};

/** every feature of this change on one sheet */
function decorate(sh: SheetData) {
  sh.cond = [
    { ranges: ["B2:B6"], rules: [{ type: "cellIs", op: "greaterThan", formulas: ["25"], style: { fill: "#FFC7CE", color: "#9C0006" }, priority: 1 }] },
    { ranges: ["C2:C6"], rules: [{ type: "dataBar", bar: "#638EC6", scale: [{ kind: "min", color: "" }, { kind: "max", color: "" }], priority: 2 }] },
    { ranges: ["B2:B6"], rules: [{ type: "iconSet", icons: "3Arrows", scale: [{ kind: "percent", val: "0", color: "" }, { kind: "percent", val: "33", color: "" }, { kind: "percent", val: "67", color: "" }], priority: 3 }] },
    { ranges: ["C2:C6"], rules: [{ type: "colorScale", scale: [{ kind: "min", color: "#F8696B" }, { kind: "max", color: "#63BE7B" }], priority: 4 }] },
    { ranges: ["A2:A6"], rules: [{ type: "containsText", op: "containsText", text: "M3", style: { bold: true }, priority: 5 }] },
    { ranges: ["B2:B6"], rules: [{ type: "top10", rank: 2, style: { fill: "#C6EFCE" }, priority: 6 }] },
    { ranges: ["A2:C6"], rules: [{ type: "expression", formulas: ["$B2>$C2*3"], style: { italic: true }, priority: 7 }] },
  ];
  sh.valid = [
    { ranges: ["D2:D6"], type: "list", f1: '"Yes,No"', allowBlank: true, showError: true, errTitle: "Pick", error: "Yes or No" },
    { ranges: ["E2:E6"], type: "whole", op: "between", f1: "1", f2: "10", showError: true, errStyle: "warning", showInput: true, promptTitle: "Number", prompt: "1 to 10" },
  ];
  sh.links = { A1: { url: "https://example.com/omni", tip: "site" }, A2: { loc: "Data!B6" } };
  sh.protect = { allow: ["selectLocked", "selectUnlocked", "formatCells", "sort"], hash: excelPasswordHash("omni") };
  sh.bookProtect = {};
  sh.print = { paper: 9, landscape: true, fit: { w: 1, h: 0 }, area: ["A1:C6"], titleRows: [0, 0], header: "&C&A", footer: "&R&P / &N", margins: { l: 0.5, r: 0.5, t: 0.75, b: 0.75, header: 0.3, footer: 0.3 } };
  sh.names = { ...(sh.names ?? {}), SalesRange: "Data!$B$2:$B$6" };
  const s = sh.styles.push({ unlocked: true }) - 1;
  sh.cells.F2 = { v: 1, s };
  const spec = { type: "col", ref: "A1:C6", title: "Sales vs Cost", legend: "b" as const, labels: true };
  sh.drawings = [...(sh.drawings ?? []), { kind: "chart", at: { c0: 4, x0: 0, r0: 8, y0: 0, c1: 10, x1: 0, r1: 22, y1: 0 }, chart: chartXml(sh, spec), spec, theme: [], fonts: [] }];
}

function expectFeatures(sh: SheetData) {
  expect(sh.cond!.map((c) => c.rules[0].type)).toEqual(["cellIs", "dataBar", "iconSet", "colorScale", "containsText", "top10", "expression"]);
  expect(sh.cond![0].rules[0].style).toMatchObject({ fill: "#FFC7CE", color: "#9C0006" });
  expect(sh.cond![2].rules[0].icons).toBe("3Arrows");
  expect(sh.cond![5].rules[0].rank).toBe(2);
  expect(sh.valid!.map((v) => v.type)).toEqual(["list", "whole"]);
  expect(sh.valid![1]).toMatchObject({ f1: "1", f2: "10", errStyle: "warning", prompt: "1 to 10" });
  expect(sh.links!.A1.url).toBe("https://example.com/omni");
  expect(sh.links!.A2.loc).toBe("Data!B6");
  expect(sh.protect!.hash).toBe(excelPasswordHash("omni"));
  expect(sh.protect!.allow).toEqual(expect.arrayContaining(["formatCells", "sort", "selectLocked", "selectUnlocked"]));
  expect(sh.protect!.allow).not.toContain("insertRows");
  expect(sh.bookProtect).toEqual({});
  expect(sh.print).toMatchObject({ landscape: true, fit: { w: 1, h: 0 }, area: ["A1:C6"], titleRows: [0, 0], header: "&C&A", footer: "&R&P / &N" });
  expect(sh.names!.SalesRange).toBe("Data!$B$2:$B$6");
  expect(sh.styles[sh.cells.F2.s!].unlocked).toBe(true);
  const chart = sh.drawings!.find((d) => d.kind === "chart")!;
  expect(chart.chart).toContain("<c:barChart>");
  expect(chart.chart).toContain("Sales vs Cost");
}

describe("Excel features written and read back", () => {
  it("password hash matches Excel's verifier", () => {
    expect(excelPasswordHash("test")).toBe("CBEB");
    expect(excelPasswordHash("password")).toBe("83AF");
  });

  it("a fresh workbook", () => {
    const { sheets } = readXlsx(book(), "en", "b");
    decorate(sheets[0]);
    const out = writeFreshXlsx(sheets);
    if (process.env.OMNI_DUMP) writeFileSync(process.env.OMNI_DUMP + "/omni-feat-fresh.xlsx", out);
    const back = readXlsx(out, "en", "b").sheets[0];
    expectFeatures(back);
    const ws = part(out, "xl/worksheets/sheet1.xml")!;
    // schema order: sheetProtection … conditionalFormatting dataValidations hyperlinks printOptions pageMargins pageSetup headerFooter drawing
    const order = ["sheetProtection", "conditionalFormatting", "dataValidations", "hyperlinks", "pageMargins", "pageSetup", "headerFooter", "drawing"].map((k) => ws.indexOf(`<${k}`));
    expect(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1]))).toBe(true);
    expect(part(out, "[Content_Types].xml")).toContain("/xl/charts/chart1.xml");
    expect(part(out, "xl/workbook.xml")).toMatch(/<workbookProtection lockStructure="1"\/><bookViews>/);
  });

  it("a fresh workbook keeps its notes and AutoFilter (Shift+F2 · Ctrl+Shift+L in a new workbook)", () => {
    const { sheets } = readXlsx(book(), "en", "b");
    const sh = sheets[0];
    sh.notes = { B2: { text: "note text" } };
    sh.filter = { ref: "A1:B4", cols: { 0: { vals: ["b"] } } };
    const out = writeFreshXlsx(sheets);
    const ws = part(out, "xl/worksheets/sheet1.xml")!;
    expect(ws).toMatch(/<autoFilter ref="A1:B4"><filterColumn colId="0"><filters><filter val="b"\/><\/filters><\/filterColumn><\/autoFilter>/);
    expect(ws).toMatch(/<legacyDrawing r:id="rId\d+"\/>/);
    expect(part(out, "xl/comments1.xml")).toContain("note text");
    expect(part(out, "xl/drawings/vmlDrawing1.vml")).toContain("<x:Row>1</x:Row><x:Column>1</x:Column>");
    expect(part(out, "[Content_Types].xml")).toContain("/xl/comments1.xml");
    expect(part(out, "xl/workbook.xml")).toMatch(/<definedName name="_xlnm\._FilterDatabase" localSheetId="0" hidden="1">\w+!\$A\$1:\$B\$4<\/definedName>/);
    const back = readXlsx(out, "en", "b").sheets[0];
    expect(back.notes?.B2?.text).toBe("note text");
    expect(back.filter?.ref).toBe("A1:B4");
    expect(back.filter?.cols?.[0]?.vals).toEqual(["b"]);
  });

  it("surgically into the original", async () => {
    const doc = await open(book());
    if (process.env.OMNI_DUMP) writeFileSync(process.env.OMNI_DUMP + "/omni-feat-orig.xlsx", book());
    decorate(doc.pages[0].sheet!);
    const out = await save(doc);
    if (process.env.OMNI_DUMP) writeFileSync(process.env.OMNI_DUMP + "/omni-feat-surgical.xlsx", out);
    const back = readXlsx(out, "en", "b").sheets[0];
    expectFeatures(back);
    // the drawing is new, linked from the sheet
    expect(part(out, "xl/worksheets/_rels/sheet1.xml.rels")).toMatch(/drawing1\.xml/);
    expect(part(out, "xl/worksheets/_rels/sheet1.xml.rels")).toMatch(/TargetMode="External"/);
    expect(part(out, "xl/styles.xml")).toMatch(/<dxfs count="\d+">/);
    // saved again (the model already saved once): the same result, no doubled parts
    const out2 = await save(doc);
    expect(Object.keys(unzipSync(out2)).filter((k) => k.startsWith("xl/charts/")).length).toBe(1);
    // an unchanged conditional format keeps its XML when another one changes
    const doc2 = await open(out);
    const sh2 = doc2.pages[0].sheet!;
    sh2.cond![1].rules[0].bar = "#FF0000";
    const out3 = await save(doc2);
    const ws3 = part(out3, "xl/worksheets/sheet1.xml")!;
    expect(ws3).toContain("FFFF0000");
    expect((ws3.match(/<conditionalFormatting/g) ?? []).length).toBe(7);
  });
});
