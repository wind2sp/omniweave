// QA xlsx-print (2026-11-17): rows whose height Excel fitted to their text (no customHeight — SheetData.rowAuto) print a
// little differently from rows with a set height (io/sheet/printLayout.ts printRowPx). The flag must follow the row:
// a height set in the app clears it, inserted / deleted rows move it, a save writes such a row without customHeight
// (a partial save that only hides it keeps Excel's exact ht), .omw keeps it, and the unedited save stays byte for byte.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { useStore } from "../../src/core/store";
import type { SheetData } from "../../src/core/sheetTypes";
import type { OmwDocument } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { worksheetXml } from "../../src/io/sheet/book";
import { setRowHeight } from "../../src/ui/sheet/sheetActions";
import { changeLines } from "../../src/ui/sheet/sheetEdit";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const BOOK = "qa/interop/excel-made/omni-xlsx-print.xlsx";
const BYTES = new Uint8Array(readFileSync(BOOK));
async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("xlsx")!.open({ name: "omni-xlsx-print.xlsx", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "p", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("xlsx")!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const cur = () => useStore.getState().doc;
const sheetAt = (doc: OmwDocument, i: number) => doc.pages.filter((p) => p.sheet)[i];
/** the open tag of row r (0-based) in the i-th worksheet of the package */
function rowTag(b: Uint8Array, i: number, r: number): string {
  const z = unzipSync(b);
  const name = Object.keys(z).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, c) => Number(/(\d+)\.xml/.exec(a)![1]) - Number(/(\d+)\.xml/.exec(c)![1]))[i];
  return new RegExp(`<row r="${r + 1}"[^>]*>`).exec(strFromU8(z[name]))?.[0] ?? "";
}
/** the first sheet with a row Excel fitted to its text, and that row */
function autoRow(doc: OmwDocument): { i: number; r: number; sh: SheetData } {
  const pages = doc.pages.filter((p) => p.sheet);
  for (let i = 0; i < pages.length; i++) {
    const sh = pages[i].sheet!;
    const r = Object.keys(sh.rowAuto ?? {}).map(Number)[0];
    if (r !== undefined) return { i, r, sh };
  }
  throw new Error("no fitted row");
}

describe("rowAuto: rows Excel fitted to their text", () => {
  it("read from rows with ht and no customHeight; rows with customHeight are not", async () => {
    const doc = await open(BYTES);
    const { i, r, sh } = autoRow(doc);
    expect(sh.rowH[r]).toBeGreaterThan(0);
    expect(rowTag(BYTES, i, r)).not.toMatch(/customHeight/);
    // the 60 pt row of the landscape sheet is set by hand: not fitted
    const tall = doc.pages.filter((p) => p.sheet).map((p) => p.sheet!).find((s) => s.rowH[9] === 80)!;
    expect(tall).toBeTruthy();
    expect(tall.rowAuto?.[9]).toBeUndefined();
  });

  it("an unedited save is byte for byte", async () => {
    const doc = await open(BYTES);
    expect(Buffer.from(await save(doc)).equals(Buffer.from(BYTES))).toBe(true);
  });

  it("a height set in the app clears it (even the same height): saved with customHeight, undo brings it back", async () => {
    const doc = await open(BYTES);
    useStore.getState().load(doc);
    const { i, r, sh } = autoRow(cur());
    const id = sheetAt(cur(), i).id;
    setRowHeight(id, [r], sh.rowH[r]);
    const after = sheetAt(cur(), i).sheet!;
    expect(after.rowAuto?.[r]).toBeUndefined();
    const out = await save(cur());
    expect(rowTag(out, i, r)).toMatch(/customHeight="1"/);
    expect((await open(out)).pages.filter((p) => p.sheet)[i].sheet!.rowAuto?.[r]).toBeUndefined();
    // undo brings the fitted row back
    useStore.getState().undo();
    expect(sheetAt(cur(), i).sheet!.rowAuto?.[r]).toBe(true);
    // another height: customHeight with the new ht
    setRowHeight(id, [r], 40);
    const out2 = await save(cur());
    expect(rowTag(out2, i, r)).toMatch(/ht="30" customHeight="1"/);
  });

  it("inserted and deleted rows move it with the row's height", async () => {
    const doc = await open(BYTES);
    useStore.getState().load(doc);
    const { i, r, sh } = autoRow(cur());
    const h = sh.rowH[r];
    const id = sheetAt(cur(), i).id;
    expect(changeLines(id, { axis: "row", at: r, n: 2 })).toBe(true);
    let s = sheetAt(cur(), i).sheet!;
    expect(s.rowAuto?.[r]).toBeUndefined();
    expect(s.rowAuto?.[r + 2]).toBe(true);
    expect(s.rowH[r + 2]).toBe(h);
    // saved and opened again: still a fitted row (no customHeight)
    const out = await save(cur());
    expect(rowTag(out, i, r + 2)).toMatch(/ht="/);
    expect(rowTag(out, i, r + 2)).not.toMatch(/customHeight/);
    expect((await open(out)).pages.filter((p) => p.sheet)[i].sheet!.rowAuto?.[r + 2]).toBe(true);
    // deleted: gone
    expect(changeLines(id, { axis: "row", at: r + 2, n: -1 })).toBe(true);
    s = sheetAt(cur(), i).sheet!;
    expect(s.rowAuto?.[r + 2]).toBeUndefined();
  });

  it("a partial save that only hides the row keeps Excel's ht and no customHeight", async () => {
    const doc = await open(BYTES);
    const { i, r, sh } = autoRow(doc);
    const orig = rowTag(BYTES, i, r);
    sh.hiddenRows = [...(sh.hiddenRows ?? []), r];
    const out = await save(doc);
    const tag = rowTag(out, i, r);
    expect(tag).toMatch(/hidden="1"/);
    expect(tag).not.toMatch(/customHeight/);
    expect(/ht="[^"]*"/.exec(tag)![0]).toBe(/ht="[^"]*"/.exec(orig)![0]);
  });

  it("the full rewrite writes a fitted row without customHeight, a set row with it", async () => {
    const doc = await open(BYTES);
    const { r, sh } = autoRow(doc);
    const xml = worksheetXml({ ...sh, rowH: { ...sh.rowH, [r + 1]: 40 } }, sh.mdw, () => 0);
    expect(new RegExp(`<row r="${r + 1}"[^>]*>`).exec(xml)![0]).not.toMatch(/customHeight/);
    expect(new RegExp(`<row r="${r + 2}"[^>]*>`).exec(xml)![0]).toMatch(/customHeight="1"/);
  });

  it(".omw keeps it", async () => {
    const doc = await open(BYTES);
    const { i, r } = autoRow(doc);
    const back = unpackOmw(packOmw(doc).bytes).doc;
    expect(back.pages.filter((p) => p.sheet)[i].sheet!.rowAuto?.[r]).toBe(true);
  });
});
