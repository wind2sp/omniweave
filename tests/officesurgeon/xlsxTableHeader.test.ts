// Office Surgeon — an Excel table's header cell edited in place (officesurgeon/xlsxTables.ts): the column is renamed
// with it (tableColumn name), structured references follow, Excel's naming rules for empty / repeated names, totals
// row labels; what cannot be followed is written anew with the warning. Both the sheet grid path (io/sheet/book.ts)
// and the table-page path (officesurgeon/xlsx.ts, older .omw and slide chart workbooks).
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument, TableCell, TableNode } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { readXlsx } from "../../src/io/sheet/read";
import { renameFormula } from "../../src/io/officesurgeon/xlsxTables";
import { legacyOpen } from "./legacyXlsx";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const inl = (a: string, t: string) => `<c r="${a}" t="inlineStr"><is><t>${t}</t></is></c>`;

/**
 * "오메 장부": OmniTable on A1:C4 — 이름 / 값 / 두배 (calculated column), rows 2–3, a totals row (label "합계", sum of 값);
 * E2 sums the column by a structured reference, a defined name points at it.
 */
function book(opts: { totals?: boolean; extra?: Record<string, string>; sheetExtra?: string; cells?: string } = {}): Uint8Array {
  const totals = opts.totals ?? true;
  const ref = totals ? "A1:C4" : "A1:C3";
  const rows =
    `<row r="1">${inl("A1", "이름")}${inl("B1", "값")}${inl("C1", "두배")}</row>` +
    `<row r="2">${inl("A2", "가")}<c r="B2"><v>1</v></c><c r="C2"><f>OmniTable[[#This Row],[값]]*2</f><v>2</v></c><c r="E2"><f>SUM(OmniTable[값])</f><v>3</v></c></row>` +
    `<row r="3">${inl("A3", "나")}<c r="B3"><v>2</v></c><c r="C3"><f>OmniTable[[#This Row],[값]]*2</f><v>4</v></c>${opts.cells ?? ""}</row>` +
    (totals ? `<row r="4">${inl("A4", "합계")}<c r="B4"><f>SUBTOTAL(109,OmniTable[값])</f><v>3</v></c></row>` : "");
  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="오메" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="오메값">OmniTable[값]</definedName></definedNames><calcPr calcId="191029"/></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/styles" Target="styles.xml"/></Relationships>`),
    "xl/styles.xml": strToU8(`<?xml version="1.0"?><styleSheet ${NS}><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${rows}</sheetData>${opts.sheetExtra ?? ""}<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`),
    "xl/worksheets/_rels/sheet1.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/table" Target="../tables/table1.xml"/></Relationships>`),
    "xl/tables/table1.xml": strToU8(
      `<?xml version="1.0"?><table ${NS} id="1" name="OmniTable" displayName="OmniTable" ref="${ref}"${totals ? ' totalsRowCount="1"' : ""}><autoFilter ref="A1:C3"/><tableColumns count="3"><tableColumn id="1" name="이름"${totals ? ' totalsRowLabel="합계"' : ""}/><tableColumn id="2" name="값"${totals ? ' totalsRowFunction="sum"' : ""}/><tableColumn id="3" name="두배"><calculatedColumnFormula>OmniTable[[#This Row],[값]]*2</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
    ),
  };
  for (const [k, v] of Object.entries(opts.extra ?? {})) files[k] = strToU8(v);
  return zipSync(files);
}

const docOf = (pages: any[], assets: any): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: assets ?? {} }) as OmwDocument;
async function openGrid(bytes: Uint8Array) {
  const r = await formatForExt("xlsx")!.open({ name: "omw-오메장부.xlsx", path: null, bytes }, {} as any);
  return docOf(r.pages, (r as any).assets);
}
async function save(doc: OmwDocument, msgs: string[] = []) {
  return (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const gridSet = (doc: OmwDocument, a: string, v: string | undefined, f?: string) => {
  const sh = doc.pages.find((p) => p.sheet)!.sheet!;
  if (v === undefined && !f) delete sh.cells[a];
  else sh.cells[a] = { ...sh.cells[a], v, ...(f ? { f } : {}) };
};
const files = (b: Uint8Array) => unzipSync(b);
const text = (b: Uint8Array, name: string) => strFromU8(files(b)[name]);
const colNames = (b: Uint8Array) => Array.from(text(b, "xl/tables/table1.xml").matchAll(/<tableColumn\b[^>]*\sname="([^"]*)"/g), (m) => m[1]);

describe("Excel table header edited in place — sheet grid", () => {
  it("renames the column, its structured references, calculated column and defined name; nothing written anew", async () => {
    const orig = book();
    const doc = await openGrid(orig);
    gridSet(doc, "B1", "매출");
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    expect(colNames(out)).toEqual(["이름", "매출", "두배"]);
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">매출</t></is></c>');
    expect(sheet).toContain("<f>SUM(OmniTable[매출])</f>");
    expect(sheet).toContain("<f>OmniTable[[#This Row],[매출]]*2</f>");
    expect(sheet).toContain("<f>SUBTOTAL(109,OmniTable[매출])</f>");
    expect(text(out, "xl/tables/table1.xml")).toContain("<calculatedColumnFormula>OmniTable[[#This Row],[매출]]*2</calculatedColumnFormula>");
    expect(text(out, "xl/workbook.xml")).toContain(">OmniTable[매출]</definedName>");
    // table style, autoFilter, totals row and every other part as they were
    expect(text(out, "xl/tables/table1.xml")).toContain('<autoFilter ref="A1:C3"/>');
    expect(text(out, "xl/tables/table1.xml")).toContain('totalsRowLabel="합계"');
    expect(text(out, "xl/tables/table1.xml")).toContain("TableStyleMedium2");
    for (const k of ["xl/styles.xml", "xl/_rels/workbook.xml.rels", "[Content_Types].xml", "xl/worksheets/_rels/sheet1.xml.rels"]) expect(text(out, k)).toBe(text(orig, k));
    // read back: the table's column has the new name and the formulas still find it
    const back = readXlsx(out, "ko").sheets[0];
    expect(back.tables?.[0].cols).toEqual(["이름", "매출", "두배"]);
    expect(back.cells.B1.v).toBe("매출");
  });

  it("special characters are escaped in references (column in its own brackets), _x escapes kept in the name", async () => {
    const doc = await openGrid(book());
    gridSet(doc, "B1", "금액 [원]#'_x0041_");
    const out = await save(doc);
    expect(colNames(out)[1]).toBe("금액 [원]#'_x005F_x0041_");
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<f>SUM(OmniTable[[금액 '[원']'#''_x0041_]])</f>");
    expect(sheet).toContain("<f>OmniTable[[#This Row],[금액 '[원']'#''_x0041_]]*2</f>");
  });

  it("an empty header becomes 열N and a repeated one gets a number (Excel's rules), with a note", async () => {
    const doc = await openGrid(book());
    gridSet(doc, "B1", undefined);
    gridSet(doc, "C1", "이름");
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(colNames(out)).toEqual(["이름", "열1", "이름2"]);
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain(">열1</t>");
    expect(sheet).toContain(">이름2</t>");
    expect(sheet).toContain("<f>SUM(OmniTable[열1])</f>");
    expect(msgs.join("\n")).toContain("XLSX 표 규칙");
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
  });

  it("two headers swapping names: each reference follows its own column", async () => {
    const doc = await openGrid(book());
    gridSet(doc, "A1", "값");
    gridSet(doc, "B1", "이름");
    const out = await save(doc);
    expect(colNames(out)).toEqual(["값", "이름", "두배"]);
    expect(text(out, "xl/worksheets/sheet1.xml")).toContain("<f>SUM(OmniTable[이름])</f>");
  });

  it("a totals row label typed over goes into totalsRowLabel", async () => {
    const doc = await openGrid(book());
    gridSet(doc, "A4", "총계");
    const out = await save(doc);
    expect(text(out, "xl/tables/table1.xml")).toContain('totalsRowLabel="총계"');
    expect(text(out, "xl/worksheets/sheet1.xml")).toContain(">총계</t>");
  });

  it("what cannot be followed is written anew with the warning", async () => {
    // a formula typed into a header
    let doc = await openGrid(book());
    gridSet(doc, "B1", "x", "1+1");
    let msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
    // a chart naming the table's column (not followed here)
    doc = await openGrid(book({ extra: { "xl/charts/chart1.xml": `<?xml version="1.0"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:f>OmniTable[값]</c:f></c:chartSpace>` } }));
    gridSet(doc, "B1", "매출");
    msgs = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
    // a reference without a table name where no cell tells its table (conditional format)
    doc = await openGrid(book({ sheetExtra: `<conditionalFormatting sqref="B2:B3"><cfRule type="expression" priority="1"><formula>[값]&gt;1</formula></cfRule></conditionalFormatting>` }));
    gridSet(doc, "B1", "매출");
    msgs = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
  });

  it("a header edit with nothing referring to the column changes only the sheet, the table and workbook.xml", async () => {
    const orig = book({ totals: false });
    const doc = await openGrid(orig);
    gridSet(doc, "A1", "품목");
    const out = await save(doc);
    const a = files(orig), b = files(out);
    const diff = Object.keys(b).filter((k) => !a[k] || Buffer.compare(Buffer.from(a[k]), Buffer.from(b[k])) !== 0);
    expect(diff.sort()).toEqual(["xl/tables/table1.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml"]);
  });
});

describe("Excel table header edited in place — table pages (older .omw, chart workbooks)", () => {
  const tableOf = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).find((n): n is TableNode => n.type === "TABLE")!;
  const setCell = (doc: OmwDocument, r: number, c: number, f: (x: TableCell) => TableCell) => {
    const tb = tableOf(doc);
    tb.rows[r][c] = f(tb.rows[r][c]);
  };
  const openLegacy = (b: Uint8Array) => {
    const r = legacyOpen(b);
    return docOf(r.pages, r.assets);
  };

  it("renames the column and its references", async () => {
    const doc = openLegacy(book());
    setCell(doc, 0, 1, (c) => ({ ...c, text: "매출" }));
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    expect(colNames(out)).toEqual(["이름", "매출", "두배"]);
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">매출</t></is></c>');
    expect(sheet).toContain("<f>SUM(OmniTable[매출])</f>");
    expect(text(out, "xl/tables/table1.xml")).toContain("OmniTable[[#This Row],[매출]]*2");
    expect(text(out, "xl/workbook.xml")).toContain(">OmniTable[매출]</definedName>");
  });

  it("a number typed into a header is the column's name as text; a formula is written anew", async () => {
    let doc = openLegacy(book());
    setCell(doc, 0, 1, (c) => ({ ...c, text: "2024" }));
    let out = await save(doc);
    expect(colNames(out)[1]).toBe("2024");
    expect(text(out, "xl/worksheets/sheet1.xml")).toContain("<f>SUM(OmniTable[[2024]])</f>");
    expect(text(out, "xl/worksheets/sheet1.xml")).toContain('<c r="B1" t="inlineStr"><is><t xml:space="preserve">2024</t></is></c>');
    doc = openLegacy(book());
    setCell(doc, 0, 1, (c) => ({ ...c, text: "2", formula: "1+1" }));
    const msgs: string[] = [];
    out = await save(doc, msgs);
    expect(msgs.join("\n")).toContain("새로 만듭니다");
  });
});

// ───────── QA 2026-11-16 (xlsx-table-header 검수) ─────────

/** the workbook with parts changed (fn gets the part's text, null when missing) */
function patch(b: Uint8Array, fns: Record<string, (x: string | null) => string>): Uint8Array {
  const z = unzipSync(b);
  for (const [k, fn] of Object.entries(fns)) z[k] = strToU8(fn(z[k] ? strFromU8(z[k]) : null));
  return zipSync(z);
}
/** book() with a second table "OtherTable" on G1:H3 whose columns are 값 / 두배 too (the same names as OmniTable's) */
function twoTables(): Uint8Array {
  const t2 = (a: string, r: number) => `<c r="${a}${r}">`;
  const cells2 =
    `${inl("G1", "값")}${inl("H1", "두배")}`;
  return patch(book({ totals: false }), {
    "xl/worksheets/sheet1.xml": (x) =>
      x!
        .replace(/(<row r="1">[\s\S]*?)(<\/row>)/, `$1${cells2}$2`)
        .replace(/(<row r="2">[\s\S]*?)(<\/row>)/, `$1${t2("G", 2)}<v>5</v></c><c r="H2"><f>[@값]*2</f><v>10</v></c><c r="I2"><f>SUM(OtherTable[값])+SUM(OmniTable[값])</f><v>8</v></c>$2`)
        .replace(/(<row r="3">[\s\S]*?)(<\/row>)/, `$1${t2("G", 3)}<v>6</v></c><c r="H3"><f>OtherTable[[#This Row],[값]]*2</f><v>12</v></c>$2`)
        .replace('<tableParts count="1"><tablePart r:id="rId1"/></tableParts>', '<tableParts count="2"><tablePart r:id="rId1"/><tablePart r:id="rId2"/></tableParts>'),
    "xl/worksheets/_rels/sheet1.xml.rels": (x) => x!.replace("</Relationships>", `<Relationship Id="rId2" Type="${REL}/table" Target="../tables/table2.xml"/></Relationships>`),
    "xl/tables/table2.xml": () =>
      `<?xml version="1.0"?><table ${NS} id="2" name="OtherTable" displayName="OtherTable" ref="G1:H3"><autoFilter ref="G1:H3"/><tableColumns count="2"><tableColumn id="1" name="값"/><tableColumn id="2" name="두배"><calculatedColumnFormula>[@값]*2</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
    "[Content_Types].xml": (x) => x!.replace("</Types>", `<Override PartName="/xl/tables/table2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml"/></Types>`),
  });
}

describe("QA: what a header rename must not touch, and how references in odd places follow", () => {
  it("another table with the same column name: its references (named or not) stay", async () => {
    const orig = twoTables();
    const doc = await openGrid(orig);
    gridSet(doc, "B1", "매출");
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain("<f>[@값]*2</f>");
    expect(sheet).toContain("<f>OtherTable[[#This Row],[값]]*2</f>");
    expect(sheet).toContain("<f>SUM(OtherTable[값])+SUM(OmniTable[매출])</f>");
    expect(text(out, "xl/tables/table2.xml")).toBe(text(orig, "xl/tables/table2.xml"));
  });

  it("strings, sheet-qualified references, shared and array formulas", async () => {
    // a string naming the column is text (INDIRECT("…") does not follow in Excel either)
    let doc = await openGrid(book({ cells: `<c r="F3"><f>IF(B3&gt;0,"OmniTable[값]",OmniTable[[#Headers],[값]])</f><v>0</v></c>` }));
    gridSet(doc, "B1", "매출");
    let out = await save(doc);
    expect(text(out, "xl/worksheets/sheet1.xml")).toContain(`<f>IF(B3&gt;0,"OmniTable[값]",OmniTable[[#Headers],[매출]])</f>`);
    // a shared formula's master text follows (its other cells have no text); an array formula too
    doc = await openGrid(book({ cells: `<c r="F3"><f t="shared" ref="F3:G3" si="0">SUM(OmniTable[값])</f><v>3</v></c><c r="G3"><f t="shared" si="0"/><v>3</v></c><c r="H3"><f t="array" ref="H3">MAX(OmniTable[값]*2)</f><v>4</v></c>` }));
    gridSet(doc, "B1", "매출");
    const msgs: string[] = [];
    out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain('<f t="shared" ref="F3:G3" si="0">SUM(OmniTable[매출])</f>');
    expect(sheet).toContain('<f t="shared" si="0"/>');
    expect(sheet).toContain('<f t="array" ref="H3">MAX(OmniTable[매출]*2)</f>');
    // a sheet-qualified table reference ('시트'!Table[col], which other programs write) may name another workbook's
    // table: not guessed, written anew with the warning
    doc = await openGrid(book({ cells: `<c r="F3"><f>SUM('오메'!OmniTable[값])</f><v>3</v></c>` }));
    gridSet(doc, "B1", "매출");
    const m2: string[] = [];
    await save(doc, m2);
    expect(m2.join("\n")).toContain("새로 만듭니다");
  });

  it("table and column names are compared without case (Excel's rule)", async () => {
    const doc = await openGrid(book({ cells: `<c r="F3"><f>SUM(omnitable[값])+omniTABLE[[#This Row],[값]]</f><v>3</v></c>` }));
    gridSet(doc, "A1", "VALUE");
    gridSet(doc, "B1", "value");
    const out = await save(doc);
    // 값 → "value" is taken (VALUE, without case): numbered
    expect(colNames(out)).toEqual(["VALUE", "value2", "두배"]);
    expect(text(out, "xl/worksheets/sheet1.xml")).toContain("<f>SUM(omnitable[value2])+omniTABLE[[#This Row],[value2]]</f>");
  });

  it("a pivot table on the table: the column is renamed, the pivot cache stays (Excel drops the field on refresh, as after its own rename)", async () => {
    // Excel 2026-11-16 (QA, hidden new instance): a pivot on the table with 매출 as its data field — renaming B1 in Excel
    // and refreshing drops the data field; the surgery's file opens without repair, shows the cached pivot, and a refresh
    // gives the same as Excel's own rename. Written anew, the workbook would lose the table and the pivot.
    const cache = `<?xml version="1.0"?><pivotCacheDefinition ${NS} r:id="rId1" refreshOnLoad="1"><cacheSource type="worksheet"><worksheetSource name="OmniTable"/></cacheSource><cacheFields count="3"><cacheField name="이름" numFmtId="0"/><cacheField name="값" numFmtId="0"/><cacheField name="두배" numFmtId="0"/></cacheFields></pivotCacheDefinition>`;
    const orig = book({ extra: { "xl/pivotCache/pivotCacheDefinition1.xml": cache } });
    const doc = await openGrid(orig);
    gridSet(doc, "B1", "매출");
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toContain("새로 만듭니다");
    expect(colNames(out)[1]).toBe("매출");
    expect(text(out, "xl/pivotCache/pivotCacheDefinition1.xml")).toBe(cache);
  });

  it("a date, percent or 1,200 typed into a header names the column as the cell shows it (Excel's rule)", async () => {
    // Excel 2026-11-16 (QA, hidden new instance): typing 2026-01-02 / 50% / 1,200 / TRUE into a table's header cells
    // gives the columns "2026-01-02", "50%", "1,200", "TRUE" (the header holds that text) — not 46024, 0.5, 1200
    const doc = await openGrid(book());
    const sh = doc.pages.find((p) => p.sheet)!.sheet!;
    const st = (fmt: string) => sh.styles.push({ fmt }) - 1;
    sh.cells.A1 = { v: 46024, s: st("yyyy-mm-dd") };
    sh.cells.B1 = { v: 0.5, s: st("0%") };
    sh.cells.C1 = { v: 1200, s: st("#,##0") };
    const out = await save(doc);
    expect(colNames(out)).toEqual(["2026-01-02", "50%", "1,200"]);
    const sheet = text(out, "xl/worksheets/sheet1.xml");
    expect(sheet).toContain(">50%</t>");
    expect(sheet).toContain("<f>SUM(OmniTable[[50%]])</f>");
  });

  it("saving again with the same edit gives the same bytes (the original stays the base)", async () => {
    const doc = await openGrid(book());
    gridSet(doc, "B1", "매출");
    const a = await save(doc);
    const b = await save(doc);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  // 부서 위험 1 (QA: 고치지 않음 — 범위가 큼). The open sheet's table keeps the old column names until the file is opened
  // again: a formula typed after the rename with the new name (OmniTable[매출]) is not calculated by Omniweave, and old
  // formulas still read OmniTable[값] in the app (the saved file is right). Following it in the model means renaming
  // the model's formulas as Excel does when a header is typed over (ui/sheet). Turns green when that is done.
  it.fails("risk 1: the open sheet's table takes the new column name with the header edit", async () => {
    const doc = await openGrid(book());
    gridSet(doc, "B1", "매출");
    await save(doc);
    expect(doc.pages.find((p) => p.sheet)!.sheet!.tables?.[0].cols).toEqual(["이름", "매출", "두배"]);
  });
});

describe("structured reference renaming", () => {
  const m = new Map([["값", "매출"]]);
  const r = (f: string, table: string | undefined = undefined) => renameFormula(f, (t) => (t ? (t.toLowerCase() === "omnitable" ? m : null) : table === "own" ? m : "unknown"), ["값"]);
  it("forms Excel writes", () => {
    expect(r("SUM(OmniTable[값])")).toBe("SUM(OmniTable[매출])");
    expect(r("omnitable[[#Headers],[값]:[두배]]")).toBe("omnitable[[#Headers],[매출]:[두배]]");
    expect(r("[@값]*2", "own")).toBe("[@매출]*2");
    expect(r("OmniTable[@[값]]")).toBe("OmniTable[@[매출]]");
    expect(r('"OmniTable[값]"&OmniTable[#All]')).toBe('"OmniTable[값]"&OmniTable[#All]');
    expect(r("Other[값]+[1]Sheet1!A1")).toBe("Other[값]+[1]Sheet1!A1");
    expect(r("'시트 [1]'!A1+OmniTable[값]")).toBe("'시트 [1]'!A1+OmniTable[매출]");
    expect(() => r("[값]")).toThrow();
  });
});
