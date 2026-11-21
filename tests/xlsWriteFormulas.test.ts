// XLS cell save with the formulas the XLS open reads (io/formats/xlsWrite.ts, legacyWrite.ts; QA 2026-11-21):
//   a formula kept in its cell whose result the engine calculated anew after an edit gets that result as its cached
//   value (number, text with its STRING record, shared and array formulas) — read again without calculating, the file
//   shows what the app showed; a formula typed in or changed is refused; a workbook opened before the XLS open read the
//   formatting (a .omw with the old xls-shape) is refused for cell edits with its own message, saved unedited as it is.
// File: qa/interop/excel-made/omni-xls-formulas.xls (sheet F: A1:C12 = row × 10 + column, formulas in F, H … Q).

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { describe, expect, it } from "vitest";
import type { SheetData } from "../src/core/sheetTypes";
import type { OmwDocument } from "../src/core/types";
import { t } from "../src/i18n";
import { exportById, formatForExt } from "../src/io/formats";
import { legacySource, xlsShapeV1 } from "../src/io/formats/legacyWrite";
import { xlsCellEdits } from "../src/io/formats/xlsWrite";
import { applyChange, Book } from "../src/io/sheet/calc";
import { readXls } from "../src/io/sheet/readXls";

(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
const FILE = "qa/interop/excel-made/omni-xls-formulas.xls";

async function open() {
  const bytes = new Uint8Array(readFileSync(FILE));
  const r = await formatForExt("xls")!.open({ name: "omni-xls-formulas.xls", path: null, bytes }, {} as never);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as { assets?: object }).assets ?? {} } as unknown as OmwDocument;
  return { bytes, doc, sheets: doc.pages.filter((p) => p.sheet).map((p) => p.sheet!) as SheetData[] };
}
const save = (doc: OmwDocument) => exportById("xls")!.run(doc, doc.pages[0], { confirm: () => true } as never) as Promise<Uint8Array>;
/** a value typed into a cell, with the recalculation it causes (as ui/sheet/sheetActions.ts setCells does) */
function type(sheets: SheetData[], si: number, a: string, v: number | string) {
  const old = sheets[si].cells[a];
  sheets[si].cells[a] = { ...(old?.s ? { s: old.s } : {}), v };
  const book = new Book(sheets);
  for (const ch of book.recalc(book.dependents([{ sheet: si, addr: a }]))) applyChange(sheets[ch.sheet], ch);
}

describe("XLS cell save and the formulas read", () => {
  it("formulas that use an edited cell: the engine's new results are their cached values, the formulas stay", async () => {
    const { doc, sheets } = await open();
    const f = sheets.findIndex((s) => s.name === "F");
    type(sheets, f, "A1", 100);
    const sh = sheets[f];
    expect(sh.cells.F1.v).toBe(256); // =A1+B1*C1
    const out = await save(doc);
    const back = readXls(out).sheets.find((s) => s.name === "F")!;
    expect(back.cells.A1.v).toBe(100);
    expect(back.cells.F1).toMatchObject({ f: "A1+B1*C1", v: 256 });
    expect(back.cells.F14).toMatchObject({ f: 'A1&"x""y"&B1', v: '100x"y12' }); // a text result: its STRING record
    expect(back.cells.H1).toMatchObject({ f: "A1*2+$A$1", v: 300 }); // the first cell of a shared formula
    expect(back.cells.H2).toMatchObject({ f: "A2*2+$A$1", v: 142 }); // a member of it
    expect(back.cells.N1).toMatchObject({ f: "A1:A3*2", cse: true, v: 200 }); // an array formula's first cell
    // every formula still the one of the file, every result the one the app shows
    for (const [a, c] of Object.entries(sh.cells)) {
      if (c.f === undefined) continue;
      expect(back.cells[a]?.f, a).toBe(c.f);
      if (!c.stale) expect(back.cells[a]?.v, a).toEqual(c.v);
    }
  });

  it("a formula typed in or changed is refused, with why", async () => {
    const { doc, bytes, sheets } = await open();
    const sh = sheets.find((s) => s.name === "F")!;
    sh.cells.F1 = { ...sh.cells.F1, f: "A1+1" };
    sh.cells.A1 = { ...sh.cells.A1, v: 5 };
    await expect(save(doc)).rejects.toThrow(t("legacysave.err.edited.xls"));
    const l = legacySource(doc.pages, "xls")!.legacy!;
    expect(() => xlsCellEdits(doc.pages, bytes, l)).toThrow(t("legacysave.xlsWhy.formulaEdit"));
  });

  it("a .omw opened before the formatted XLS open (xls-shape): unedited as it was, a cell edit refused with its own message", async () => {
    const { doc, bytes, sheets } = await open();
    const l = legacySource(doc.pages, "xls")!.legacy!;
    l.shape = xlsShapeV1(doc.pages); // what that open kept
    expect(Buffer.from(await save(doc)).equals(Buffer.from(bytes))).toBe(true);
    const sh = sheets.find((s) => s.name === "F")!;
    sh.cells.A1 = { ...sh.cells.A1, v: 5 };
    await expect(save(doc)).rejects.toThrow(t("legacysave.err.xlsOldOpen"));
  });
});
