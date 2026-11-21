// 한글's '쪽 경계에서 나눔' (hp:tbl pageBreak="CELL", docs/design/FIDELITY_HWP.md 13): a table row that does not fit at
// a page end is cut between its lines, the rest going on under the repeated header row on the next page; 한글's PDF of
// qa/interop/hancom-made/omni-hwp-tables.hwpx is the reference (5 pages: page 2 ends with the first two lines of row 11).
// The cut row is one row again wherever the pieces are joined (editing, the writers, the Office Surgeon).

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { exportHwpx, parseHwpxFlow } from "../src/io/office";
import { joinTables } from "../src/core/flow";
import type { OmwDocument, Page, TableNode } from "../src/core/types";

const FILE = "qa/interop/hancom-made/omni-hwp-tables.hwpx";
const docOf = (pages: Page[]): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: {} });
async function open(bytes: Uint8Array): Promise<Page[]> {
  const r = await formatForExt("hwpx")!.open({ name: "x.hwpx", path: null, bytes }, {} as any);
  return r.pages as Page[];
}
const tablesOf = (pg: Page) => pg.nodes.filter((n): n is TableNode => n.type === "TABLE");
const big = (pages: Page[]) => joinTables(pages.flatMap((p) => tablesOf(p))).find((t) => t.rows.length > 20)!;

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

describe("한글 table rows cut at a page end", () => {
  it("lays omni-hwp-tables out on 한글's 5 pages: the header alone at the end of page 1, row 11 cut after two lines", async () => {
    const pages = await open(new Uint8Array(readFileSync(FILE)));
    expect(pages.length).toBe(5);
    // page 1 ends with the header row of table 3 (no line of row 1 fits under it)
    const t1 = tablesOf(pages[0]);
    expect(t1[t1.length - 1].rows.map((r) => r.map((c) => c.text))).toEqual([["번호", "부서", "내용"]]);
    // page 2: header, rows 1–10 and the first part of row 11 (its first two lines; the middle cells with them)
    const t2 = tablesOf(pages[1])[0];
    expect(t2.cutRow).toBe(true);
    expect(t2.rows.length).toBe(12);
    const a = t2.rows[11];
    expect(a[0].text).toBe("11");
    expect(a[1].text).toBe("부서 11");
    expect(a[2].text.replace(/\s+$/, "")).toBe("Omni 분기 보고서 11");
    // page 3: the header again, then the rest of row 11 (the other cells empty), rows 12–21
    const t3 = tablesOf(pages[2])[0];
    expect(t3.cutRow).toBeUndefined();
    expect(t3.rows[0].map((c) => c.text)).toEqual(["번호", "부서", "내용"]);
    expect(t3.rows[1].map((c) => c.text)).toEqual(["", "", "행 — 매출과 비용"]);
    expect(t3.rows[t3.rows.length - 1][0].text).toBe("21");
    // page 4 cuts row 32 the same way; page 5 ends the table and holds the paragraph after it
    expect(tablesOf(pages[3])[0].cutRow).toBe(true);
    expect(pages[4].nodes.some((n) => n.type === "TEXT" && n.flow)).toBe(true);
    // the first part is no taller than the room left on its page
    const p2 = pages[1];
    expect(t2.transform.y + (await import("../src/core/table")).layoutTable(t2).height).toBeLessThanOrEqual(p2.height - (p2.margins?.bottom ?? 0) + 0.01);
  });

  it("joins the pieces back into the file's table: 40 rows, row 11 whole with its own paragraphs", async () => {
    const bytes = new Uint8Array(readFileSync(FILE));
    const pages = await open(bytes);
    const orig = parseHwpxFlow(bytes, { notesDropped: 0 }).filter((it) => it.kind === "table").map((it: any) => (it.table?.rows ?? it.rows) as TableNode["rows"]).find((r) => r.length > 20)!;
    const joined = big(pages);
    expect(joined.cutRow).toBeUndefined();
    expect(joined.rows.map((r) => r.map((c) => c.text))).toEqual(orig.map((r) => r.map((c) => c.text)));
    const row11 = joined.rows[11];
    expect(row11[2].richText!.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["Omni 분기 보고서 11 행 — 매출과 비용"]);
    expect(row11[2].richText!.every((p) => !p.flowSplit && !p.flowCont)).toBe(true);
    // a cell's own height from the file goes back with it
    expect(row11.map((c) => c.minHeight)).toEqual(orig[11].map((c) => c.minHeight));
    expect(row11[2].richText!.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(orig[11][2].richText!.map((p) => p.runs.map((r) => r.text).join("")));
  });

  it("keeps an edit made in either part of a cut row when the pieces are joined", async () => {
    const pages = await open(new Uint8Array(readFileSync(FILE)));
    const t3 = tablesOf(pages[2])[0];
    const rows = t3.rows.map((r) => [...r]);
    rows[1][2] = { ...rows[1][2], text: "행 — 매출과 비용 (고침)" };
    const edited = pages.map((pg, i) => (i === 2 ? { ...pg, nodes: pg.nodes.map((n) => (n === t3 ? { ...t3, rows } : n)) } : pg));
    const row11 = big(edited).rows[11];
    expect(row11[2].text).toBe("Omni 분기 보고서 11 행 — 매출과 비용 (고침)");
    expect(row11[0].text).toBe("11");
  });

  it("saves the unedited file byte for byte, and a new HWPX writes the table as one 40-row table", async () => {
    const bytes = new Uint8Array(readFileSync(FILE));
    const pages = await open(bytes);
    const out = (await exportById("hwpx")!.run(docOf(pages), pages[0], { confirm: () => true } as any)) as Uint8Array;
    expect(Buffer.from(out).equals(Buffer.from(bytes))).toBe(true);
    const fresh = exportHwpx(pages, "t");
    const again = await open(fresh);
    const t = big(again);
    expect(t.rows.length).toBe(40);
    expect(t.rows[11].map((c) => c.text)).toEqual(["11", "부서 11", "Omni 분기 보고서 11 행 — 매출과 비용"]);
    const sec = strFromU8(unzipSync(fresh)["Contents/section0.xml"]);
    expect((sec.match(/Omni 분기 보고서 11 행 — 매출과 비용/g) ?? []).length).toBe(1);
  });

  it("keeps rows whole in a table set to 셀 단위로 나눔 (pageBreak TABLE), as before", async () => {
    const files = unzipSync(new Uint8Array(readFileSync(FILE)));
    files["Contents/section0.xml"] = strToU8(strFromU8(files["Contents/section0.xml"]).replace(/pageBreak="CELL"/g, 'pageBreak="TABLE"'));
    const pages = await open(zipSync(files));
    expect(pages.length).toBe(6);
    for (const pg of pages) for (const t of tablesOf(pg)) expect(t.cutRow).toBeUndefined();
  });
});
