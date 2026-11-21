// QA hwpx-lines (adversarial): rows cut at a page end (한글 '쪽 경계에서 나눔', core/flow.ts cutRowAt / joinTable) under
// edits made on the pieces as the app makes them (pageSetupActions editTable → core/table *InPlace on the page's
// piece, CellEditor's Tab row): text in either part, rows inserted / deleted next to or instead of a part, cells
// merged across one part, a row cut on more than one page end; saved as a new HWPX, in place (Office Surgeon) and as
// HWP 5 — no row may be duplicated, merged into another or lost, and rowCnt / cellAddr must hold.

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { exportHwpx } from "../src/io/office";
import { joinTables } from "../src/core/flow";
import { deleteRowsInPlace, insertColsInPlace, insertRowsInPlace, mergeCellsInPlace } from "../src/core/table";
import type { OmwDocument, Page, TableCell, TableNode } from "../src/core/types";

const FILE = "qa/interop/hancom-made/omni-hwp-tables.hwpx";
const HWP = "qa/interop/hancom-made/omni-hwp-tables.hwp";
const docOf = (pages: Page[]): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: {} });
async function open(bytes: Uint8Array, ext = "hwpx"): Promise<Page[]> {
  const r = await formatForExt(ext)!.open({ name: `omw-cut.${ext}`, path: null, bytes }, {} as any);
  return r.pages as Page[];
}
const tablesOf = (pg: Page) => pg.nodes.filter((n): n is TableNode => n.type === "TABLE");
const big = (pages: Page[]) => joinTables(pages.flatMap((p) => tablesOf(p))).find((t) => t.rows.length > 20)!;
const texts = (t: TableNode) => t.rows.map((r) => r.map((c) => c.text));
const allText = (t: TableNode) => t.rows.flat().map((c) => c.text).join("|");

/** the app's table edit on one page's piece (a copy, as immer's draft) */
function editPiece(pages: Page[], pi: number, fn: (t: TableNode) => void, ti = 0): Page[] {
  return pages.map((pg, i) => {
    if (i !== pi) return pg;
    const t0 = tablesOf(pg)[ti];
    const t: TableNode = { ...t0, rows: t0.rows.map((r) => r.map((c) => ({ ...c }))), colWidths: [...t0.colWidths] };
    fn(t);
    return { ...pg, nodes: pg.nodes.map((n) => (n === t0 ? t : n)) };
  });
}

/** rowCnt / colCnt / cellAddr of every hp:tbl of the section XML agree with its hp:tr / hp:tc */
function tablesConsistent(xml: string) {
  const d = new DOMParser().parseFromString(xml, "text/xml");
  const tbls = Array.from(d.getElementsByTagName("hp:tbl"));
  for (const t of tbls) {
    const trs = Array.from(t.childNodes).filter((n: any) => n.nodeName === "hp:tr") as any[];
    expect(trs.length).toBe(Number(t.getAttribute("rowCnt")));
    trs.forEach((tr, r) => {
      const tcs = Array.from(tr.childNodes).filter((n: any) => n.nodeName === "hp:tc") as any[];
      let cols = 0;
      for (const tc of tcs) {
        const addr = Array.from(tc.childNodes).find((n: any) => n.nodeName === "hp:cellAddr") as any;
        const span = Array.from(tc.childNodes).find((n: any) => n.nodeName === "hp:cellSpan") as any;
        expect(Number(addr.getAttribute("rowAddr"))).toBe(r);
        cols += Number(span?.getAttribute("colSpan") ?? 1);
      }
      expect(cols).toBeLessThanOrEqual(Number(t.getAttribute("colCnt")));
    });
  }
  return tbls.length;
}

/** saved as a new HWPX and in place: both reopen with `want` as the big table's cell texts, tables consistent */
async function savesAs(pages: Page[], want: string[][]) {
  const fresh = exportHwpx(pages, "t");
  tablesConsistent(strFromU8(unzipSync(fresh)["Contents/section0.xml"]));
  expect(texts(big(await open(fresh)))).toEqual(want);
  const inPlace = (await exportById("hwpx")!.run(docOf(pages), pages[0], { confirm: () => true } as any)) as Uint8Array;
  tablesConsistent(strFromU8(unzipSync(inPlace)["Contents/section0.xml"]));
  expect(texts(big(await open(inPlace)))).toEqual(want);
}

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("QA: edits on the pieces of a cut row", () => {
  let base: Page[];
  let orig: string[][];
  beforeAll(async () => {
    base = await open(new Uint8Array(readFileSync(FILE)));
    orig = texts(big(base));
    expect(orig.length).toBe(40);
  });
  const ROW11 = ["11", "부서 11", "Omni 분기 보고서 11 행 — 매출과 비용"];

  it("deleting the continuation (page 3, its first row) does not merge row 11 into row 12", async () => {
    const pages = editPiece(base, 2, (t) => void deleteRowsInPlace(t, 1, 1));
    const t = big(pages);
    expect(t.rows.length).toBe(40);
    // (the first part is what is left of row 11)
    expect(t.rows[11].map((c) => c.text.trimEnd())).toEqual(["11", "부서 11", "Omni 분기 보고서 11"]);
    expect(t.rows[11][2].richText!.every((p) => !p.flowSplit && !p.flowCont)).toBe(true);
    expect(t.rows[12].map((c) => c.text)).toEqual(orig[12]);
    expect(allText(t)).not.toContain("11\n12");
    await savesAs(pages, texts(t));
  });

  it("deleting the first part (page 2, its last row) does not merge the rest into row 10", async () => {
    const pages = editPiece(base, 1, (t) => void deleteRowsInPlace(t, t.rows.length - 1, t.rows.length - 1));
    const t = big(pages);
    expect(t.rows.length).toBe(40);
    expect(t.rows[10].map((c) => c.text)).toEqual(orig[10]);
    expect(t.rows[11].map((c) => c.text)).toEqual(["", "", "행 — 매출과 비용"]);
    await savesAs(pages, texts(t));
  });

  it("a row inserted above the continuation is a row of its own; row 11 stays one row", async () => {
    const pages = editPiece(base, 2, (t) => insertRowsInPlace(t, 1, 1));
    const t = big(pages);
    expect(t.rows.length).toBe(41);
    expect(t.rows.filter((r) => r[0].text === "11")).toHaveLength(1);
    const i = t.rows.findIndex((r) => r[0].text === "11");
    expect(t.rows[i].map((c) => c.text)).toEqual(ROW11);
    expect(t.rows.filter((r) => r.every((c) => !c.text))).toHaveLength(1);
    await savesAs(pages, texts(t));
  });

  it("a row added after the first part (Tab in its last cell) is a row of its own; row 11 stays one row", async () => {
    const pages = editPiece(base, 1, (t) => void t.rows.push(Array.from({ length: t.colWidths.length }, () => ({ text: "" }) as TableCell)));
    const t = big(pages);
    expect(t.rows.length).toBe(41);
    const i = t.rows.findIndex((r) => r[0].text === "11");
    expect(t.rows[i].map((c) => c.text)).toEqual(ROW11);
    expect(t.rows[i + 1].every((c) => !c.text)).toBe(true);
    expect(t.rows[i + 2].map((c) => c.text)).toEqual(orig[12]);
    await savesAs(pages, texts(t));
  });

  it("merging the first part's cells loses no text of either part", async () => {
    const pages = editPiece(base, 1, (t) => void mergeCellsInPlace(t, { r0: t.rows.length - 1, c0: 0, r1: t.rows.length - 1, c1: 2 }));
    const t = big(pages);
    for (const s of ["11", "부서 11", "Omni 분기 보고서 11", "행 — 매출과 비용"]) expect(allText(t)).toContain(s);
    expect(t.rows.length).toBeGreaterThanOrEqual(40);
    await savesAs(pages, texts(t));
  });

  it("merging row 10 down into the first part loses no text", async () => {
    const pages = editPiece(base, 1, (t) => void mergeCellsInPlace(t, { r0: t.rows.length - 2, c0: 2, r1: t.rows.length - 1, c1: 2 }));
    const t = big(pages);
    for (const s of [orig[10][2], "Omni 분기 보고서 11", "행 — 매출과 비용"]) expect(allText(t)).toContain(s);
    await savesAs(pages, texts(t));
  });

  it("a column inserted in one piece loses no cell of the other", async () => {
    const pages = editPiece(base, 2, (t) => insertColsInPlace(t, 1, 1));
    const t = big(pages);
    // (the parts of row 11 no longer have as many cells: they stay rows of their own)
    for (const r of orig) for (const s of r) for (const part of s === ROW11[2] ? ["Omni 분기 보고서 11", "행 — 매출과 비용"] : [s]) expect(allText(t)).toContain(part);
  });

  it("text typed into an empty part and into both parts is kept", async () => {
    let pages = editPiece(base, 2, (t) => void (t.rows[1][0] = { ...t.rows[1][0], text: "가" }));
    pages = editPiece(pages, 1, (t) => void (t.rows[t.rows.length - 1][1] = { ...t.rows[t.rows.length - 1][1], text: "부서 11 고침" }));
    const t = big(pages);
    expect(t.rows.length).toBe(40);
    expect(t.rows[11].map((c) => c.text)).toEqual(["11\n가", "부서 11 고침", ROW11[2]]);
    await savesAs(pages, texts(t));
  });

  it("undo (the pages before the edit) joins to the file's table again", async () => {
    const edited = editPiece(base, 2, (t) => void deleteRowsInPlace(t, 1, 1));
    expect(big(edited).rows[11][2].text.trimEnd()).toBe("Omni 분기 보고서 11");
    expect(texts(big(base))).toEqual(orig);
    expect(big(base).rows.every((r) => r.every((c) => c.cutA === undefined && c.cutB === undefined))).toBe(true);
  });
});

describe("QA: a row cut on more than one page end", () => {
  const files = unzipSync(new Uint8Array(readFileSync(FILE)));
  const sec = strFromU8(files["Contents/section0.xml"]);
  const p0 = /<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>Omni 분기 보고서 11 행 — 매출과 비용<\/hp:t><\/hp:run><hp:linesegarray>[\s\S]*?<\/hp:linesegarray><\/hp:p>/;
  const para = (s: string) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:t>${s}</hp:t></hp:run></hp:p>`;
  const variant = (body: string) => {
    expect(p0.test(sec)).toBe(true);
    const f = { ...files, "Contents/section0.xml": strToU8(sec.replace(p0, body)) };
    return zipSync(f);
  };

  for (const [name, body, n] of [
    ["120 one-line paragraphs", Array.from({ length: 120 }, (_, i) => para(`줄 ${i + 1}`)).join(""), 120],
    ["one long paragraph", para(Array.from({ length: 140 }, (_, i) => `가나다 ${i + 1}`).join(" ")), 1],
  ] as const)
    it(`${name}: joined as the file's row, saved once`, async () => {
      const bytes = variant(body);
      const pages = await open(bytes);
      const pieces = pages.flatMap((p) => tablesOf(p)).filter((t) => t.id.startsWith(big(pages).id.split("~")[0]));
      expect(pieces.filter((t) => t.cutRow).length).toBeGreaterThanOrEqual(2);
      const t = big(pages);
      expect(t.rows.length).toBe(40);
      const cell = t.rows[11][2];
      expect(cell.richText!.length).toBe(n);
      expect(cell.richText!.every((p) => !p.flowSplit && !p.flowCont)).toBe(true);
      expect(t.rows[11][0].text).toBe("11");
      expect(t.rows[12][0].text).toBe("12");
      // unedited: the original bytes; a new HWPX: one row 11 with all of its text
      const same = (await exportById("hwpx")!.run(docOf(pages), pages[0], { confirm: () => true } as any)) as Uint8Array;
      expect(Buffer.from(same).equals(Buffer.from(bytes))).toBe(true);
      const fresh = exportHwpx(pages, "t");
      tablesConsistent(strFromU8(unzipSync(fresh)["Contents/section0.xml"]));
      const again = big(await open(fresh));
      expect(again.rows.length).toBe(40);
      expect(again.rows[11][2].richText!.length).toBe(n);
      expect(again.rows[11][2].text).toBe(cell.text);
    });
});

describe("QA: HWP 5 save of a cut table", () => {
  it("omni-hwp-tables.hwp: cut like the HWPX, unedited bytes kept, a cell edit in the continuation saved once", async () => {
    const bytes = new Uint8Array(readFileSync(HWP));
    const pages = await open(bytes, "hwp");
    expect(pages.flatMap((p) => tablesOf(p)).some((t) => t.cutRow)).toBe(true);
    const t0 = big(pages);
    expect(t0.rows.length).toBe(40);
    const { saveHwp5 } = await import("../src/io/formats/hwp5Write");
    expect(Buffer.from(saveHwp5(pages, {})).equals(Buffer.from(bytes))).toBe(true);
    // the continuation's text cell edited
    const pi = pages.findIndex((p) => tablesOf(p).some((t) => t.rows.some((r) => r[0].cutB !== undefined)));
    expect(pi).toBeGreaterThan(0);
    const ti = tablesOf(pages[pi]).findIndex((t) => t.rows.some((r) => r[0].cutB !== undefined));
    const ri = tablesOf(pages[pi])[ti].rows.findIndex((r) => r[0].cutB !== undefined);
    const edited = editPiece(pages, pi, (t) => void (t.rows[ri][2] = { ...t.rows[ri][2], text: t.rows[ri][2].text + " 고침" }), ti);
    const want = texts(big(edited));
    expect(want.length).toBe(40);
    // (written into the cell's records: reopened, the table is the edited one, row 11 / 12 / 23 / 34 each once)
    const out = saveHwp5(edited, {});
    expect(texts(big(await open(out, "hwp")))).toEqual(want);
    // a row deleted next to the cut: the same-format writer takes it or refuses it, never writes rows merged
    const del = editPiece(pages, pi, (t) => void deleteRowsInPlace(t, ri, ri), ti);
    const wantDel = texts(big(del));
    expect(wantDel.filter((r) => r[0] === "11" || r[0] === "12").length).toBe(2);
    let out2: Uint8Array | null = null;
    try {
      out2 = saveHwp5(del, {});
    } catch {
      out2 = null;
    }
    if (out2) expect(texts(big(await open(out2, "hwp")))).toEqual(wantDel);
  });
});
