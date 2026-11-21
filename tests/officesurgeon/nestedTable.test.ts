// A table nested in a table cell (docs/qa/ISSUES-2026-11-19.md item 5, remaining risk): a row / column change or a
// merge of the outer table made the DOCX surgeon write the whole table anew from the cell model, which reads the
// nested table's paragraphs flat — the nested table was lost. The rebuilt table now takes each such cell's original
// content back into the cell with the same content; one that finds no place is reported, never dropped silently.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { deleteColsInPlace, deleteRowsInPlace, insertColsInPlace, insertRowsInPlace, mergeCellsInPlace } from "../../src/core/table";
import type { OmwDocument, TableNode } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const p = (t: string) => (t ? `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>` : "<w:p/>");
const tc = (inner: string, w = 2000) => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
const INNER =
  `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="double" w:sz="4" w:space="0" w:color="FF0000"/></w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="900"/><w:gridCol w:w="900"/></w:tblGrid>` +
  `<w:tr>${tc(p("안쪽 A1"), 900)}${tc(p("안쪽 A2"), 900)}</w:tr><w:tr>${tc(p("안쪽 B1"), 900)}${tc(p("안쪽 B2 &amp; 끝"), 900)}</w:tr></w:tbl>`;

/** omw-nested.docx: a 3 × 3 table, cell (1,1) holds a 2 × 2 table between two paragraphs, cell (1,2) is empty */
function nestedDocx(): Uint8Array {
  const row = (cells: string[]) => `<w:tr>${cells.map((c) => tc(c)).join("")}</w:tr>`;
  const body =
    p("오메 표 시험") +
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>` +
    row([p("항목"), p("내용"), p("비고")]) +
    row([p("첫째"), p("바깥 칸") + INNER + p("표 뒤 문단"), p("")]) +
    row([p("둘째"), p("보통 칸"), p("끝 칸")]) +
    `</w:tbl>` +
    p("마지막 문단") +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr>`;
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
      "word/document.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:document ${W}><w:body>${body}</w:body></w:document>`),
    },
    { level: 9, mtime: new Date(2026, 10, 20, 9, 30) },
  );
}

async function open(bytes: Uint8Array, ext = "docx"): Promise<OmwDocument> {
  const r = await formatForExt(ext)!.open({ name: `omw-nested.${ext}`, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, msgs: string[] = [], ext = "docx"): Promise<Uint8Array> {
  return (await exportById(ext)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
}
const table = (doc: OmwDocument) => doc.pages.flatMap((pg) => pg.nodes).find((n): n is TableNode => n.type === "TABLE")!;
const els = (e: Element, local: string) => Array.from(e.childNodes).filter((n): n is Element => n.nodeType === 1 && (n as Element).localName === local);
const texts = (e: Element) => Array.from(e.getElementsByTagNameNS(NS_W, "t")).map((t) => t.textContent).join("|");

/** The outer w:tbl of a saved document, checked against Word's grid rules; its rows as lists of w:tc. */
function outer(bytes: Uint8Array) {
  const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  const body = doc.getElementsByTagNameNS(NS_W, "body")[0];
  const tbl = els(body, "tbl")[0];
  const cols = els(els(tbl, "tblGrid")[0], "gridCol").length;
  const rows = els(tbl, "tr").map((tr) => els(tr, "tc"));
  for (const r of rows) {
    // every row covers the grid exactly (w:gridSpan), every cell ends with a paragraph (after a nested table too)
    const span = r.reduce((a, c) => a + Number(c.getElementsByTagNameNS(NS_W, "gridSpan")[0]?.getAttribute("w:val") ?? 1), 0);
    expect(span).toBe(cols);
    for (const c of r) expect(Array.from(c.childNodes).filter((n) => n.nodeType === 1).pop()!.localName).toBe("p");
  }
  return { xml, cols, rows, nested: rows.flat().flatMap((c) => els(c, "tbl")) };
}

describe("DOCX: a table nested in a cell survives the outer table's row / column changes", () => {
  it("an unedited save is the original, byte for byte", async () => {
    const src = nestedDocx();
    const out = await save(await open(src));
    expect(Buffer.compare(Buffer.from(out), Buffer.from(src))).toBe(0);
  });

  it("insert a row, delete a column, merge: the nested table stays whole in its cell, also after reopening", async () => {
    const doc = await open(nestedDocx());
    const t = table(doc);
    expect(t.rows[1][1].text).toContain("안쪽 A1");
    insertRowsInPlace(t, 0); // the cell moves to row 2
    deleteColsInPlace(t, 0, 0); // … and to column 0
    expect(mergeCellsInPlace(t, { r0: 2, c0: 0, r1: 2, c1: 1 })).toBe(true); // merged with the empty cell to its right
    const msgs: string[] = [];
    const out = await save(doc, msgs);
    expect(msgs.join("\n")).not.toMatch(/칸 안의 표|inside a table cell/);
    const o = outer(out);
    expect(o.cols).toBe(2);
    expect(o.rows.length).toBe(4);
    expect(o.nested.length).toBe(1);
    const cell = o.rows[2][0];
    expect(cell.getElementsByTagNameNS(NS_W, "gridSpan")[0]?.getAttribute("w:val")).toBe("2");
    expect(els(cell, "tbl").length).toBe(1);
    // the original nested table itself: its own borders, grid and text, between the cell's two paragraphs
    expect(o.xml).toContain(INNER);
    expect(els(cell, "p").map(texts)).toEqual(["바깥 칸", "표 뒤 문단"]);
    expect(texts(els(cell, "tbl")[0])).toBe("안쪽 A1|안쪽 A2|안쪽 B1|안쪽 B2 & 끝");
    // the other cells as edited
    expect(o.rows.map((r) => r.map(texts))).toEqual([["", ""], ["내용", "비고"], [texts(cell)], ["보통 칸", "끝 칸"]]);
    // reopened: the same table, the nested text in the merged cell; saved again unchanged, byte for byte
    const again = await open(out);
    const t2 = table(again);
    expect(t2.rows[2][0].colSpan).toBe(2);
    expect(t2.rows[2][0].text).toContain("안쪽 B2 & 끝");
    const out2 = await save(again);
    expect(Buffer.compare(Buffer.from(out2), Buffer.from(out))).toBe(0);
  });

  it("a column inserted and another cell edited: the nested table stays; a second row/column change keeps it too", async () => {
    const doc = await open(nestedDocx());
    const t = table(doc);
    insertColsInPlace(t, 0);
    t.rows[2][3].text = "끝 칸 고침";
    delete t.rows[2][3].richText;
    const out = await save(doc);
    const o = outer(out);
    expect(o.cols).toBe(4);
    expect(els(o.rows[1][2], "tbl").length).toBe(1);
    expect(o.xml).toContain(INNER);
    const again = await open(out);
    deleteRowsInPlace(table(again), 0, 0);
    const o2 = outer(await save(again));
    expect(o2.rows.length).toBe(2);
    expect(els(o2.rows[0][2], "tbl").length).toBe(1);
    expect(o2.xml).toContain(INNER);
  });

  it("the nested cell edited (or merged with text) after a row change: never silently — the save says so", async () => {
    const doc = await open(nestedDocx());
    const t = table(doc);
    insertRowsInPlace(t, 3);
    expect(mergeCellsInPlace(t, { r0: 1, c0: 0, r1: 1, c1: 1 })).toBe(true); // "첫째" + the nested cell
    const msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toMatch(/칸 안의 표 1개|1 table inside a table cell/);
    // cancelled: nothing is written
    const doc2 = await open(nestedDocx());
    insertRowsInPlace(table(doc2), 3);
    mergeCellsInPlace(table(doc2), { r0: 1, c0: 0, r1: 1, c1: 1 });
    await expect(exportById("docx")!.run(doc2, doc2.pages[0], { confirm: (m: string) => !/칸 안의 표|inside a table cell/.test(m) } as any)).rejects.toThrow();
  });

  it("the nested cell's own text edited (same grid): its table is not kept, and the save says so", async () => {
    const doc = await open(nestedDocx());
    const c = table(doc).rows[1][1];
    c.text = c.text.replace("바깥 칸", "바깥 칸 고침");
    delete c.richText;
    const msgs: string[] = [];
    await save(doc, msgs);
    expect(msgs.join("\n")).toMatch(/칸 안의 표 1개|1 table inside a table cell/);
  });

  it("the nested cell's row deleted: the table goes with it, no notice", async () => {
    const doc = await open(nestedDocx());
    deleteRowsInPlace(table(doc), 1, 1);
    const msgs: string[] = [];
    const o = outer(await save(doc, msgs));
    expect(msgs.join("\n")).not.toMatch(/칸 안의 표|inside a table cell/);
    expect(o.nested.length).toBe(0);
    expect(o.rows.length).toBe(2);
  });
});

// HWPX: a table in a 한글 cell (hp:tbl in a run of a cell paragraph). A row / column change or a merge rebuilds the
// outer hp:tbl in place (HwpxWriter.reshapeTable): the cell holding the table goes as it is into its new place.
const HWPX = readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx");
function nestedHwpx(): Uint8Array {
  const files = unzipSync(new Uint8Array(HWPX));
  let s = strFromU8(files["Contents/section0.xml"]);
  const i = s.indexOf("<hp:tbl");
  const j = s.indexOf("</hp:tbl>", i) + "</hp:tbl>".length;
  const copy = s
    .slice(i, j)
    .replace(/<hp:tbl id="\d+"/, '<hp:tbl id="1244339999"')
    .replace(/<hp:t>([^<]*)<\/hp:t>/g, "<hp:t>안쪽 $1</hp:t>")
    .replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
  // into the outer table's last cell: a paragraph holding the copy, before the cell's own paragraph
  const last = s.lastIndexOf("<hp:subList", j);
  const at = s.indexOf(">", last) + 1;
  s = s.slice(0, at) + `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${copy}<hp:t/></hp:run></hp:p>` + s.slice(at);
  files["Contents/section0.xml"] = strToU8(s);
  return zipSync(files);
}
const hwpxNested = (b: Uint8Array) => {
  const s = strFromU8(unzipSync(b)["Contents/section0.xml"]);
  return { s, tbls: (s.match(/<hp:tbl\b/g) ?? []).length };
};

describe("HWPX: a table nested in a cell", () => {
  it("an unedited save is the original, byte for byte", async () => {
    const src = nestedHwpx();
    expect(hwpxNested(src).tbls).toBe(2);
    const out = await save(await open(src, "hwpx"), [], "hwpx");
    expect(Buffer.compare(Buffer.from(out), Buffer.from(src))).toBe(0);
  });

  const FALLBACK = /새로 만듭니다|written anew/;
  const LOST = /칸 안의 표|inside a table cell/;
  /** the nested hp:tbl as nestedHwpx() puts it in (the reference the saved one must equal) */
  const innerXml = () => {
    const s = strFromU8(unzipSync(nestedHwpx())["Contents/section0.xml"]);
    const i = s.indexOf('<hp:tbl id="1244339999"');
    return s.slice(i, s.indexOf("</hp:tbl>", i) + 9);
  };

  it("insert a row, delete a column, merge: the nested table stays whole in its cell, also after reopening", async () => {
    const doc = await open(nestedHwpx(), "hwpx");
    const t = table(doc);
    const R = t.rows.length, C = t.colWidths.length;
    expect(C).toBeGreaterThan(1);
    expect(t.rows[R - 1][C - 1].text).toContain("안쪽 ");
    insertRowsInPlace(t, 0); // the cell moves to row R …
    expect(deleteColsInPlace(t, 0, 0)).toBe(true); // … and to column C - 2
    insertRowsInPlace(t, R + 1); // an empty row under it
    expect(mergeCellsInPlace(t, { r0: R, c0: C - 2, r1: R + 1, c1: C - 2 })).toBe(true); // merged with the empty cell below
    const msgs: string[] = [];
    const out = await save(doc, msgs, "hwpx");
    expect(msgs.join("\n")).not.toMatch(LOST);
    expect(msgs.join("\n")).not.toMatch(FALLBACK);
    const o = hwpxOuter(out);
    expect([o.rowCnt, o.colCnt]).toEqual([R + 2, C - 1]);
    expect(o.nested).toEqual([{ r: R, c: C - 2, rs: 2, cs: 1, id: "1244339999" }]);
    expect(o.s).toContain(innerXml());
    // reopened: the same table, the nested text in the merged cell; saved again unchanged, byte for byte
    const again = await open(out, "hwpx");
    const t2 = table(again);
    expect(t2.rows[R][C - 2].rowSpan).toBe(2);
    expect(t2.rows[R][C - 2].text).toContain("안쪽 ");
    const out2 = await save(again, [], "hwpx");
    expect(Buffer.compare(Buffer.from(out2), Buffer.from(out))).toBe(0);
    // a second change (a column inserted in front) keeps it as well
    insertColsInPlace(t2, 0);
    const m2: string[] = [];
    const o2 = hwpxOuter(await save(again, m2, "hwpx"));
    expect(m2.join("\n")).not.toMatch(LOST);
    expect([o2.rowCnt, o2.colCnt]).toEqual([R + 2, C]);
    expect(o2.nested).toEqual([{ r: R, c: C - 1, rs: 2, cs: 1, id: "1244339999" }]);
    expect(o2.s).toContain(innerXml());
  });

  it("a column inserted and another cell edited: the nested table stays, the edit is written", async () => {
    const doc = await open(nestedHwpx(), "hwpx");
    const t = table(doc);
    const R = t.rows.length, C = t.colWidths.length;
    insertColsInPlace(t, 0);
    t.rows[0][1].text = "omni 고친 칸";
    delete t.rows[0][1].richText;
    const msgs: string[] = [];
    const out = await save(doc, msgs, "hwpx");
    expect(msgs.join("\n")).not.toMatch(LOST);
    const o = hwpxOuter(out);
    expect([o.rowCnt, o.colCnt]).toEqual([R, C + 1]);
    expect(o.nested).toEqual([{ r: R - 1, c: C, rs: 1, cs: 1, id: "1244339999" }]);
    expect(o.s).toContain(innerXml());
    expect(table(await open(out, "hwpx")).rows[0][1].text).toBe("omni 고친 칸");
  });

  it("the nested cell edited after a row change: never silently — the save says so, and cancel writes nothing", async () => {
    const edit = (t: TableNode) => {
      const c = t.rows[t.rows.length - 1][t.colWidths.length - 1];
      c.text += " omni 고침"; // the nested table's text stays in the cell: its table finds no place
      delete c.richText;
      insertRowsInPlace(t, 0);
    };
    const doc = await open(nestedHwpx(), "hwpx");
    edit(table(doc));
    const msgs: string[] = [];
    const out = await save(doc, msgs, "hwpx");
    expect(msgs.join("\n")).toMatch(/칸 안의 표 1개|1 table inside a table cell/);
    expect(hwpxOuter(out).nested).toEqual([]);
    const doc2 = await open(nestedHwpx(), "hwpx");
    edit(table(doc2));
    await expect(exportById("hwpx")!.run(doc2, doc2.pages[0], { confirm: (m: string) => !LOST.test(m) } as any)).rejects.toThrow();
  });

  it("the nested cell's row deleted: the table goes with it, no notice", async () => {
    const doc = await open(nestedHwpx(), "hwpx");
    const t = table(doc);
    const R = t.rows.length;
    expect(deleteRowsInPlace(t, R - 1, R - 1)).toBe(true);
    const msgs: string[] = [];
    const o = hwpxOuter(await save(doc, msgs, "hwpx"));
    expect(msgs.join("\n")).not.toMatch(LOST);
    expect(o.nested).toEqual([]);
    expect(o.rowCnt).toBe(R - 1);
  });
});

/**
 * The outer hp:tbl of a saved HWPX, checked: well-formed section XML, rowCnt / colCnt = the rows and the grid, every
 * grid position covered by exactly one cell (cellAddr + cellSpan, the row's cells in its hp:tr), hp:tbl ids and the
 * non-zero hp:p ids unique; where the tables nested in its cells are.
 */
function hwpxOuter(bytes: Uint8Array) {
  const s = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
  const errs: string[] = [];
  const doc = new DOMParser({ onError: (lvl: string, msg: string) => void (lvl !== "warning" && errs.push(msg)) } as any).parseFromString(s, "text/xml");
  expect(errs).toEqual([]);
  const all = Array.from(doc.getElementsByTagName("hp:tbl"));
  const inside = (x: Node) => { for (let p = x.parentNode; p; p = p.parentNode) if (all.includes(p as Element)) return true; return false; };
  const tbl = all.find((x) => !inside(x))!;
  const rowCnt = Number(tbl.getAttribute("rowCnt")), colCnt = Number(tbl.getAttribute("colCnt"));
  const trs = els(tbl, "tr");
  expect(trs.length).toBe(rowCnt);
  const seen = Array.from({ length: rowCnt }, () => new Array(colCnt).fill(0));
  const nested: { r: number; c: number; rs: number; cs: number; id: string | null }[] = [];
  trs.forEach((tr, ri) =>
    els(tr, "tc").forEach((tc) => {
      const a = els(tc, "cellAddr")[0], sp = els(tc, "cellSpan")[0];
      const r = Number(a.getAttribute("rowAddr")), c = Number(a.getAttribute("colAddr"));
      const rs = Number(sp.getAttribute("rowSpan")), cs = Number(sp.getAttribute("colSpan"));
      expect(r).toBe(ri);
      for (let i = 0; i < rs; i++) for (let j = 0; j < cs; j++) seen[r + i][c + j]++;
      for (const n of Array.from(tc.getElementsByTagName("hp:tbl"))) {
        nested.push({ r, c, rs, cs, id: n.getAttribute("id") });
        expect(n.getElementsByTagName("hp:t")[0]?.textContent ?? "").toContain("안쪽 ");
      }
    }),
  );
  expect(seen.flat().every((n) => n === 1)).toBe(true);
  const ids = all.map((x) => x.getAttribute("id"));
  expect(new Set(ids).size).toBe(ids.length);
  const pids = Array.from(doc.getElementsByTagName("hp:p")).map((x) => x.getAttribute("id")).filter((x) => x && x !== "0");
  expect(new Set(pids).size).toBe(pids.length);
  return { s, rowCnt, colCnt, nested };
}
