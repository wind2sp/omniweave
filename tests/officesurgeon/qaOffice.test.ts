// Office Surgeon — code QA (2026-11-12, qa-office): ZIP rewriter edge cases, XLSX cell text validity,
// array formulas, HWPX header shapes. Test content is synthetic ("오메" / Omni).
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import type { OmwDocument, TableCell, TableNode, TextNode } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { parseXlsx } from "../../src/io/formats/xlsx";
import { readZip, rewriteZip } from "../../src/io/officesurgeon/zip";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function book(sheetData: string): Uint8Array {
  return zipSync({
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="오메" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    ),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet ${NS}><sheetData>${sheetData}</sheetData></worksheet>`),
  });
}
async function openAs(ext: "xlsx" | "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt(ext)!.open({ name: `omw-오메.${ext}`, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(ext: "xlsx" | "docx" | "hwpx", doc: OmwDocument, msgs: string[] = []) {
  return (await exportById(ext)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) })) as Uint8Array;
}
const tables = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE");
/** a sheet cell (sheet grid pages) holding this value, given a new value */
const setSheetCell = (doc: OmwDocument, value: string, v: string | number) => {
  for (const p of doc.pages) for (const c of Object.values(p.sheet?.cells ?? {})) if (String(c.v) === value) return void (c.v = v);
  throw new Error(value);
};
const setCell = (doc: OmwDocument, text: string, f: (c: TableCell) => TableCell) => {
  for (const tb of tables(doc)) for (const row of tb.rows) for (let i = 0; i < row.length; i++) if (row[i].text === text) return void (row[i] = f(row[i]));
  throw new Error(text);
};
const HEAD = `<row r="1"><c r="A1" t="inlineStr"><is><t>이름</t></is></c><c r="B1" t="inlineStr"><is><t>값</t></is></c></row>`;

/** rename the n-th entry (local header and central record) to `to` (same byte length) */
function renameEntry(zip: Uint8Array, from: string, to: string): Uint8Array {
  const out = new Uint8Array(zip);
  const a = new TextEncoder().encode(from), b = new TextEncoder().encode(to);
  expect(a.length).toBe(b.length);
  for (let i = 0; i + a.length <= out.length; i++) if (a.every((x, k) => out[i + k] === x)) out.set(b, i);
  return out;
}

describe("ZIP rewriter edge cases", () => {
  it("a package with two entries of the same name is not rewritten (readZip → null, fresh save)", () => {
    const z = zipSync({ "word/document.xml": strToU8("<a/>"), "word/documenX.xml": strToU8("<b/>") });
    const dup = renameEntry(z, "word/documenX.xml", "word/document.xml");
    expect(readZip(z)).not.toBeNull();
    expect(readZip(dup)).toBeNull();
    // part names are case-insensitive in OPC
    expect(readZip(renameEntry(z, "word/documenX.xml", "word/DOCUMENT.xml"))).toBeNull();
  });

  it("a ZIP-encrypted entry (general flag bit 0) is not read or rewritten (readZip → null)", () => {
    const z = zipSync({ "a.xml": strToU8("<a/>") });
    const enc = new Uint8Array(z);
    enc[6] |= 1; // local header flags
    const cd = enc.length - 22 - 46 - "a.xml".length;
    enc[cd + 8] |= 1; // central record flags
    expect(readZip(z)).not.toBeNull();
    expect(readZip(enc)).toBeNull();
  });

  it("archive comment, entry order and untouched records survive a rewrite; offsets are consistent", () => {
    const z0 = zipSync({ "x/1.xml": strToU8("<one/>"), "x/2.xml": strToU8("<two/>"), "x/3.xml": strToU8("<three/>") });
    // add an archive comment
    const comment = new TextEncoder().encode("omniweave qa");
    const z = new Uint8Array(z0.length + comment.length);
    z.set(z0);
    z.set(comment, z0.length);
    z[z0.length - 2] = comment.length;
    const zip = readZip(z)!;
    const out = rewriteZip(zip, new Map([["x/2.xml", strToU8("<two edited='1'/>")]]));
    expect(strFromU8(out.subarray(out.length - comment.length))).toBe("omniweave qa");
    const back = unzipSync(out);
    expect(Object.keys(back)).toEqual(["x/1.xml", "x/2.xml", "x/3.xml"]);
    expect(strFromU8(back["x/2.xml"])).toBe("<two edited='1'/>");
    const r = readZip(out)!;
    expect(r.entries.map((e) => e.name)).toEqual(["x/1.xml", "x/2.xml", "x/3.xml"]);
  });
});

describe("XLSX cell text that XML cannot hold", () => {
  it("control characters typed into a cell are not written raw (Excel would ask to repair)", async () => {
    const doc = await openAs("xlsx", book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>사과</t></is></c><c r="B2"><v>1</v></c></row>`));
    setSheetCell(doc, "사과", "오메\u000b사과\u0001");
    const out = await save("xlsx", doc);
    const xml = strFromU8(unzipSync(out)["xl/worksheets/sheet1.xml"]);
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)).toBe(false);
    expect(parseXlsx(out)[0].rows[1][0].text).toContain("오메");
  });

  it("the fresh XLSX writer does not write them either", async () => {
    const doc = await openAs("xlsx", book(HEAD + `<row r="2"><c r="A2" t="inlineStr"><is><t>사과</t></is></c></row>`));
    setSheetCell(doc, "사과", "오메\u0007");
    doc.pages.forEach((p) => p.source && delete p.source.office); // no map: written anew
    const out = await save("xlsx", doc);
    const xml = strFromU8(unzipSync(out)["xl/worksheets/sheet1.xml"]);
    expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml)).toBe(false);
  });
});

describe("XLSX array formulas", () => {
  it("a value typed into a cell inside an array formula's range is not written in place (Excel cannot change part of an array)", async () => {
    const data =
      HEAD +
      `<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f t="array" ref="B2:B3">A2:A3*2</f><v>2</v></c></row>` +
      `<row r="3"><c r="A3"><v>3</v></c><c r="B3"><v>6</v></c></row>`;
    const doc = await openAs("xlsx", book(data));
    setSheetCell(doc, "6", 7);
    const msgs: string[] = [];
    const out = await save("xlsx", doc, msgs);
    const xml = strFromU8(unzipSync(out)["xl/worksheets/sheet1.xml"]);
    // either written anew (with the note) or the array cell untouched — never a lone value inside the array range
    const surgical = !msgs.join("\n").includes("새로 만듭니다");
    if (surgical) expect(xml).not.toMatch(/<c r="B3"[^>]*><v>7<\/v>/);
    else expect(msgs.length).toBeGreaterThan(0);
  });
});

describe("HWPX header shapes (dee162c)", () => {
  it("new character shapes: unique ids, itemCnt = count, children in schema order (italic before bold), refs resolve", async () => {
    const { readFileSync } = await import("node:fs");
    const doc = await openAs("hwpx", new Uint8Array(readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx")));
    const ps = doc.pages.flatMap((pg) => pg.nodes).filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs);
    const withText = ps.filter((q) => q.runs.some((r) => r.text.trim()));
    // bold first (one new shape), then bold + italic on another paragraph
    withText[1].runs = withText[1].runs.map((r) => ({ ...r, bold: true, text: r.text + " 오메" }));
    withText[2].runs = withText[2].runs.map((r) => ({ ...r, bold: true, italic: true, text: r.text + " Omni" }));
    withText[3].align = withText[3].align === "CENTER" ? "RIGHT" : "CENTER";
    const out = await save("hwpx", doc);
    const head = strFromU8(unzipSync(out)["Contents/header.xml"]);
    const ids = Array.from(head.matchAll(/<hh:charPr\b[^>]*\sid="(\d+)"/g), (m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Number(/<hh:charProperties\b[^>]*\sitemCnt="(\d+)"/.exec(head)![1])).toBe(ids.length);
    const pids = Array.from(head.matchAll(/<hh:paraPr\b[^>]*\sid="(\d+)"/g), (m) => m[1]);
    expect(new Set(pids).size).toBe(pids.length);
    expect(Number(/<hh:paraProperties\b[^>]*\sitemCnt="(\d+)"/.exec(head)![1])).toBe(pids.length);
    for (const m of head.matchAll(/<hh:charPr\b[\s\S]*?<\/hh:charPr>/g)) {
      const i = m[0].indexOf("<hh:italic"), b = m[0].indexOf("<hh:bold");
      if (i >= 0 && b >= 0) expect(i).toBeLessThan(b);
    }
    const sec = strFromU8(unzipSync(out)["Contents/section0.xml"]);
    for (const m of sec.matchAll(/charPrIDRef="(\d+)"/g)) expect(ids).toContain(m[1]);
    for (const m of sec.matchAll(/paraPrIDRef="(\d+)"/g)) expect(pids).toContain(m[1]);
  });
});
