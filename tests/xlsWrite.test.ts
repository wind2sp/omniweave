// XLS same-format save, stage 2 (io/formats/xlsWrite.ts): a workbook opened from an .xls with cell values alone edited
// is saved as XLS with those values written into the BIFF records — read again, the values are the edited ones; every
// other stream, every other sheet's records (but INDEX, whose positions move) and every other cell stay byte for byte.
// Anything else (a format, a formula typed in, a column width …) is still refused with the advice to save as XLSX.
// Files: every XLS in qa/interop (excel-made/omni-legacy-xls-cells.xls: shared and array formulas, row blocks, an SST
// with CONTINUE records). OMW_LEGACY_FILES=<a.xls>;… adds local files (not in the repo).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfbStreams, readCfbTree } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { lastLegacySave, legacySource, legacyUnchanged, xlsShape, xlsValuesOnly } from "../src/io/formats/legacyWrite";
import { readXls } from "../src/io/sheet/readXls";
import { editWorkbook, workbookOf, type XlsCellEdit } from "../src/io/formats/xlsWrite";
import type { OmwDocument, Page } from "../src/core/types";
import type { SheetData } from "../src/core/sheetTypes";
import { packOmw, unpackOmw } from "../src/io/omw";
import { addr } from "../src/io/sheet/formula";

const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.xls$/i.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
const extra = (process.env.OMW_LEGACY_FILES ?? "").split(";").filter((f) => f && /\.xls$/i.test(f) && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const CELLS_FILE = repoFiles.find((f) => f.endsWith("omni-legacy-xls-cells.xls"))!;
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(file: string | Uint8Array) {
  const bytes = typeof file === "string" ? new Uint8Array(readFileSync(file)) : file;
  const r = await formatForExt("xls")!.open({ name: "omw-legacy.xls", path: null, bytes }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
  return { bytes, doc };
}
const save = (doc: OmwDocument) => exportById("xls")!.run(doc, doc.pages[0], { confirm: () => true } as any) as Promise<Uint8Array>;
const sheets = (d: OmwDocument) => d.pages.filter((p) => p.sheet).map((p) => p.sheet!);
/** a value typed into a cell as the sheet editor does it (sheetActions.ts setCells: the format index kept) */
const put = (sh: SheetData, a: string, v: number | string | boolean | undefined) => {
  const old = sh.cells[a];
  const cell = { ...(old?.s ? { s: old.s } : {}), ...(v !== undefined ? { v } : {}) };
  if (cell.v !== undefined || cell.s) sh.cells[a] = cell;
  else delete sh.cells[a];
};
// (read back, a logical value shows as TRUE / FALSE and a number with 15 digits, as the XLS import makes them)
const shown = (v: unknown) => (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : typeof v === "number" ? parseFloat(v.toPrecision(15)) : v);
const values = (sh: SheetData) => Object.fromEntries(Object.entries(sh.cells).filter(([, c]) => c.v !== undefined).map(([a, c]) => [a, shown(c.v)]));

// ───── BIFF records, for comparing streams ─────
interface R {
  type: number;
  data: Buffer;
}
function records(wb: Uint8Array): R[] {
  const out: R[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = wb[o] | (wb[o + 1] << 8), len = wb[o + 2] | (wb[o + 3] << 8);
    out.push({ type, data: Buffer.from(wb.subarray(o + 4, o + 4 + len)) });
    o += 4 + len;
  }
  return out;
}
/** the substreams (BOF … EOF at the top level) of a Workbook stream */
function subs(wb: Uint8Array): R[][] {
  const out: R[][] = [];
  let depth = 0;
  for (const r of records(wb)) {
    if (r.type === 0x0809 && depth++ === 0) out.push([]);
    if (depth > 0) out[out.length - 1].push(r);
    if (r.type === 0x000a) depth--;
  }
  return out;
}
const without = (rs: R[], ...types: number[]) => rs.filter((r) => !types.includes(r.type));

describe("the XLS writer, nothing changed", () => {
  it.each(files.map((f) => [label(f), f]))("rebuilding every cell table as it is gives the same stream: %s", (_n, file) => {
    const wb = workbookOf(new Uint8Array(readFileSync(file)));
    // every sheet: its BOUNDSHEET name
    const names: string[] = [];
    for (const r of subs(wb)[0])
      if (r.type === 0x0085) {
        const cch = r.data[6], wide = r.data[7] & 1;
        names.push(wide ? r.data.subarray(8, 8 + cch * 2).toString("utf16le") : r.data.subarray(8, 8 + cch).toString("latin1"));
      }
    const again = editWorkbook(wb, new Map(names.map((n) => [n, [] as XlsCellEdit[]])));
    expect(eq(again, wb)).toBe(true);
  });
});

// (omni-legacy-xls-manual.xls: manual calculation with formulas — its edits are refused, see "QA edges")
describe.each(files.filter((f) => !f.endsWith("omni-legacy-xls-manual.xls")).map((f) => [label(f), f]))("cell values written into the XLS: %s", (_name, file) => {
  it("a value changed, a text added, a cell cleared and a new cell: saved as XLS, read back as edited", async () => {
    const { bytes, doc } = await open(file);
    const sh = sheets(doc)[0];
    const filled = Object.keys(sh.cells).filter((a) => sh.cells[a].v !== undefined);
    expect(filled.length).toBeGreaterThan(1);
    put(sh, filled[0], 4242);
    put(sh, filled[1], "오메 omw 새 글");
    if (filled[2]) put(sh, filled[2], undefined);
    put(sh, "K60", 3.25);
    put(sh, "L61", true);
    expect(legacyUnchanged(doc.pages, "xls")).toBe(false);
    expect(xlsValuesOnly(doc.pages)).toBe(true);
    const want = sheets(doc).map(values);
    const out = await save(doc);
    expect(lastLegacySave.xls).toBe("cells");
    expect(eq(out, bytes)).toBe(false);
    const back = await open(out);
    expect(sheets(back.doc).map(values)).toEqual(want);
    // the saved file is kept as the new original: saving it again unedited gives it back
    expect(eq(await save(back.doc), out)).toBe(true);
    expect(lastLegacySave.xls).toBe("original");
  });

  it("other streams, other sheets and the rest of the edited sheet stay byte for byte", async () => {
    const { bytes, doc } = await open(file);
    const sh = sheets(doc)[0];
    const a = Object.keys(sh.cells).find((k) => typeof sh.cells[k].v === "number" || typeof sh.cells[k].v === "string")!;
    put(sh, a, typeof sh.cells[a].v === "number" ? (sh.cells[a].v as number) + 1 : "omw");
    const out = await save(doc);
    const s0 = cfbStreams(readCfbTree(bytes)), s1 = cfbStreams(readCfbTree(out));
    expect([...s1.keys()]).toEqual([...s0.keys()]);
    for (const [k, v] of s0) if (k !== "Workbook") expect(eq(s1.get(k)!, v), k).toBe(true);
    const w0 = subs(s0.get("Workbook")!), w1 = subs(s1.get("Workbook")!);
    expect(w1.length).toBe(w0.length);
    // the globals: the same records but BOUNDSHEET (positions), SST / CONTINUE / EXTSST and RECALCID (gone)
    const g = (rs: R[]) => without(rs, 0x0085, 0x00fc, 0x003c, 0x00ff, 0x01c1);
    expect(g(w1[0])).toEqual(g(w0[0]));
    expect(w1[0].some((r) => r.type === 0x01c1)).toBe(false);
    // the edited sheet's records outside its cell table (DIMENSIONS / INDEX aside) are the same
    const name = sh.name;
    const which = sheetSubIndex(s0.get("Workbook")!, name);
    const table = new Set([0x0208, 0x00d7, 0x0006, 0x0201, 0x00be, 0x027e, 0x00bd, 0x0205, 0x0203, 0x00fd, 0x0204, 0x0207, 0x04bc, 0x0221, 0x0236, 0x003c, 0x0200, 0x020b]);
    for (let i = 1; i < w0.length; i++) {
      if (i === which) expect(w1[i].filter((r) => !table.has(r.type))).toEqual(w0[i].filter((r) => !table.has(r.type)));
      else expect(without(w1[i], 0x020b)).toEqual(without(w0[i], 0x020b)); // INDEX: only its stream positions move
    }
  });
});

/** the substream index of a sheet, by its BOUNDSHEET position */
function sheetSubIndex(wb: Uint8Array, name: string): number {
  const starts: number[] = [];
  let depth = 0;
  const bounds: { name: string; pos: number }[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = wb[o] | (wb[o + 1] << 8), len = wb[o + 2] | (wb[o + 3] << 8);
    if (type === 0x0809 && depth++ === 0) starts.push(o);
    if (type === 0x000a) depth--;
    if (type === 0x0085) {
      const d = Buffer.from(wb.subarray(o + 4, o + 4 + len));
      const cch = d[6], wide = d[7] & 1;
      bounds.push({ name: wide ? d.subarray(8, 8 + cch * 2).toString("utf16le") : d.subarray(8, 8 + cch).toString("latin1"), pos: d.readUInt32LE(0) });
    }
    o += 4 + len;
  }
  return starts.indexOf(bounds.find((b) => b.name === name)!.pos);
}

describe("cell edits of every kind (omni-legacy-xls-cells.xls)", () => {
  const edited = async (edit: (sh: SheetData[], d: OmwDocument) => void) => {
    const { doc } = await open(CELLS_FILE);
    edit(sheets(doc), doc);
    const want = sheets(doc).map(values);
    const out = await save(doc);
    const back = await open(out);
    expect(sheets(back.doc).map(values)).toEqual(want);
    return { out, wb: workbookOf(out), back };
  };
  const cellRecs = (wb: Uint8Array, r: number, c: number) => records(wb).filter((x) => [0x0006, 0x0201, 0x027e, 0x0205, 0x0203, 0x00fd].includes(x.type) && x.data.readUInt16LE(0) === r && x.data.readUInt16LE(2) === c);

  it("is there", () => expect(existsSync(CELLS_FILE)).toBe(true));

  it("a number into an RK cell keeps its XF; a fraction becomes NUMBER", async () => {
    const { wb } = await edited(([s]) => {
      put(s, "A2", 777);
      put(s, "A3", 0.1 + 0.2);
    });
    const [a2] = cellRecs(wb, 1, 0), [a3] = cellRecs(wb, 2, 0);
    expect(a2.type).toBe(0x027e);
    expect(a3.type).toBe(0x0203);
    expect(a3.data.readDoubleLE(6)).toBe(0.1 + 0.2);
  });

  it("a formula cell given a value (a shared formula's member): FORMULA becomes the value, the others stay", async () => {
    const { wb } = await edited(([s]) => put(s, "C5", 99));
    const recs = cellRecs(wb, 4, 2);
    expect(recs.map((r) => r.type)).toEqual([0x027e]);
    expect(cellRecs(wb, 5, 2)[0].type).toBe(0x0006);
    expect(records(wb).filter((r) => r.type === 0x04bc).length).toBe(records(workbookOf(new Uint8Array(readFileSync(CELLS_FILE)))).filter((r) => r.type === 0x04bc).length);
  });

  it("the first cell of a shared formula, an array formula cell: the workbook written anew as XLS (the patcher refuses them)", async () => {
    for (const a of ["C2", "H3"]) {
      const { doc } = await open(CELLS_FILE);
      put(sheets(doc)[0], a, 5);
      const out = await save(doc);
      expect(lastLegacySave.xls, a).toBe("fresh");
      expect(readXls(out, "en").sheets[0].cells[a].v, a).toBe(5);
    }
  });

  it("many new texts, a long one: the SST continues in CONTINUE records, EXTSST points at strings", async () => {
    const long = "오메 long ".repeat(3000);
    const { wb } = await edited(([s]) => {
      for (let i = 0; i < 300; i++) put(s, addr(150 + i, 0), `새 글 ${i} new text`);
      put(s, "B150", long);
    });
    const rs = records(wb);
    const sstAt = rs.findIndex((r) => r.type === 0x00fc);
    let k = sstAt + 1;
    while (rs[k].type === 0x003c) k++;
    expect(k - sstAt).toBeGreaterThan(5);
    for (let i = sstAt; i < k; i++) expect(rs[i].data.length).toBeLessThanOrEqual(8224);
    // EXTSST: each bucket's stream position and in-record offset agree, and point inside the SST records
    const ext = rs[k];
    expect(ext.type).toBe(0x00ff);
    let pos = 0;
    const starts: number[] = [];
    for (const r of rs) {
      starts.push(pos);
      pos += 4 + r.data.length;
    }
    const n = (ext.data.length - 2) / 8;
    expect(n).toBeGreaterThan(1);
    for (let b = 0; b < n; b++) {
      const ib = ext.data.readUInt32LE(2 + b * 8), cb = ext.data.readUInt16LE(6 + b * 8);
      const rec = starts.findIndex((s, i) => i >= sstAt && i < k && s <= ib && ib < s + 4 + rs[i].data.length);
      expect(rec, `bucket ${b}`).toBeGreaterThanOrEqual(0);
      expect(ib - starts[rec]).toBe(cb);
    }
    // cstUnique counts them, cstTotal grew by the new cells
    const sst0 = records(workbookOf(new Uint8Array(readFileSync(CELLS_FILE)))).find((r) => r.type === 0x00fc)!;
    expect(rs[sstAt].data.readUInt32LE(4)).toBe(sst0.data.readUInt32LE(4) + 301);
    expect(rs[sstAt].data.readUInt32LE(0)).toBe(sst0.data.readUInt32LE(0) + 301);
  });

  it("an existing text is used again, not added", async () => {
    const { wb } = await edited(([s]) => put(s, "F10", "줄 3 / row 3"));
    const sst0 = records(workbookOf(new Uint8Array(readFileSync(CELLS_FILE)))).find((r) => r.type === 0x00fc)!;
    expect(records(wb).find((r) => r.type === 0x00fc)!.data.readUInt32LE(4)).toBe(sst0.data.readUInt32LE(4));
  });

  it("a cell of a MULBLANK given a value: the MULBLANK is cut around it, the cut cells keep their XF", async () => {
    const { wb } = await edited(([s]) => put(s, "K3", "가운데"));
    const row2 = records(wb).filter((r) => [0x0201, 0x00be, 0x00fd].includes(r.type) && r.data.readUInt16LE(0) === 2 && r.data.readUInt16LE(2) >= 9);
    expect(row2.map((r) => [r.type, r.data.readUInt16LE(2)])).toEqual([
      [0x0201, 9],
      [0x00fd, 10],
      [0x0201, 11],
    ]);
    expect(new Set(row2.map((r) => r.data.readUInt16LE(4))).size).toBe(1); // one XF for all three
  });

  it("a logical value, a cleared cell with a format (BLANK) and without (gone)", async () => {
    const { wb } = await edited(([s]) => {
      put(s, "E2", true);
      put(s, "B2", undefined); // B2 has a number format of its own? then BLANK
      put(s, "F2", undefined);
    });
    expect(cellRecs(wb, 1, 4)[0].type).toBe(0x0205);
    expect(cellRecs(wb, 1, 4)[0].data[6]).toBe(1);
    const f2 = cellRecs(wb, 1, 5);
    expect(f2.length === 0 || f2[0].type === 0x0201).toBe(true);
  });

  it("a new cell in a new row past the last: a ROW record, DIMENSIONS and INDEX grow, the row takes the row / column format", async () => {
    const { wb } = await edited(([s]) => {
      put(s, "A300", 1);
      put(s, "B140", 2); // row 140 has a format of its own (fGhostDirty)
      put(s, "I20", 3); // column I has one (COLINFO)
    });
    const rs = records(wb);
    const sheet = subs(wb)[1];
    const dim = sheet.find((r) => r.type === 0x0200)!;
    expect(dim.data.readUInt32LE(4)).toBe(300);
    const idx = sheet.find((r) => r.type === 0x020b)!;
    expect(idx.data.readUInt32LE(8)).toBe(300);
    expect(sheet.some((r) => r.type === 0x0208 && r.data.readUInt16LE(0) === 299)).toBe(true);
    const row140 = sheet.find((r) => r.type === 0x0208 && r.data.readUInt16LE(0) === 139)!;
    expect(cellRecs(wb, 139, 1)[0].data.readUInt16LE(4)).toBe(row140.data.readUInt16LE(14) & 0x0fff);
    const colI = sheet.find((r) => r.type === 0x007d && r.data.readUInt16LE(0) <= 8 && 8 <= r.data.readUInt16LE(2))!;
    expect(cellRecs(wb, 19, 8)[0].data.readUInt16LE(4)).toBe(colI.data.readUInt16LE(6));
    // INDEX points at every DBCELL of the sheet (the second substream), each DBCELL back at its block's first ROW
    let pos = 0, sub = -1, depth = 0;
    const dbs: number[] = [];
    for (const r of rs) {
      if (r.type === 0x0809 && depth++ === 0) sub++;
      if (sub === 1 && depth === 1 && r.type === 0x00d7) {
        dbs.push(pos);
        const first = pos - r.data.readUInt32LE(0);
        expect(wb[first] | (wb[first + 1] << 8), "DBCELL → ROW").toBe(0x0208);
      }
      if (r.type === 0x000a) depth--;
      pos += 4 + r.data.length;
    }
    const ptrs = Array.from({ length: (idx.data.length - 16) / 4 }, (_, i) => idx.data.readUInt32LE(16 + i * 4));
    expect(dbs.length).toBeGreaterThan(4);
    expect(ptrs).toEqual(dbs);
  });

  it("the other sheet's formula that uses an edited cell keeps its cached value (Excel recalculates)", async () => {
    const { back } = await edited(([s]) => put(s, "B2", 50));
    const ref = sheets(back.doc).find((s) => s.name.startsWith("참조"))!;
    // 1.1 × 100 as cached (the stored double, 110.00000000000001 — shown as 110); Excel shows 5000 after its recalculation (xls_check.ps1)
    expect(shown(ref.cells.A1.v)).toBe(110);
    expect(ref.cells.A1.f).toBeTruthy(); // (2026-11-21) the formula is read too, and kept
  });
});

// QA 2026-11-17 (xls-write2 검수): edges of the cell table and the SST, checked cell by cell in Excel too
// (qa/interop/scripts/xls_qa_edge_make.ps1 makes the files; xls_check.ps1 on what xls_edit-style edits wrote)
describe("QA edges (omni-legacy-xls-edge.xls, omni-legacy-xls-manual.xls)", () => {
  const EDGE = repoFiles.find((f) => f.endsWith("omni-legacy-xls-edge.xls"))!;
  const MANUAL = repoFiles.find((f) => f.endsWith("omni-legacy-xls-manual.xls"))!;
  const S = "가 Edge";
  const edited = async (file: string, edit: (by: (name: string) => SheetData) => void) => {
    const { doc } = await open(file);
    const by = (name: string) => sheets(doc).find((s) => s.name === name)!;
    edit(by);
    const want = sheets(doc).map(values);
    const out = await save(doc);
    expect(lastLegacySave.xls).toBe("cells");
    const back = await open(out);
    expect(sheets(back.doc).map(values)).toEqual(want);
    return { out, wb: workbookOf(out), back };
  };
  const row = (wb: Uint8Array, sub: number, r: number) =>
    subs(wb)[sub].filter((x) => [0x0201, 0x00be, 0x027e, 0x00bd, 0x0205, 0x0203, 0x00fd, 0x0006].includes(x.type) && x.data.readUInt16LE(0) === r);
  /** every DBCELL of substream `sub` points back at a ROW, and INDEX lists them all */
  const indexOk = (wb: Uint8Array, sub: number) => {
    let pos = 0, s = -1, depth = 0;
    const dbs: number[] = [];
    let idx: R | undefined;
    for (const r of records(wb)) {
      if (r.type === 0x0809 && depth++ === 0) s++;
      if (s === sub && depth === 1 && r.type === 0x020b) idx = r;
      if (s === sub && depth === 1 && r.type === 0x00d7) {
        dbs.push(pos);
        const first = pos - r.data.readUInt32LE(0);
        expect(wb[first] | (wb[first + 1] << 8), "DBCELL → ROW").toBe(0x0208);
      }
      if (r.type === 0x000a) depth--;
      pos += 4 + r.data.length;
    }
    expect(Array.from({ length: (idx!.data.length - 16) / 4 }, (_, i) => idx!.data.readUInt32LE(16 + i * 4))).toEqual(dbs);
  };

  it("are there", () => expect([EDGE, MANUAL].every((f) => f && existsSync(f))).toBe(true));

  it("a MULRK cut at its first, a middle and its last cell: the rest keep their values and XFs", async () => {
    const before = row(workbookOf(new Uint8Array(readFileSync(EDGE))), 1, 0);
    expect(before.map((r) => r.type)).toContain(0x00bd);
    const { wb } = await edited(EDGE, (by) => {
      put(by(S), "A1", 11);
      put(by(S), "C1", "가운데");
      put(by(S), "F1", undefined);
    });
    const after = row(wb, 1, 0);
    // B1, D1:E1 stay RK / MULRK pieces with the original XF; G1 (the SUM) stays a formula
    const cols = after.flatMap((r) => (r.type === 0x00bd ? Array.from({ length: (r.data.length - 6) / 6 }, (_, k) => [r.data.readUInt16LE(2) + k, r.type]) : [[r.data.readUInt16LE(2), r.type]]));
    expect(cols).toEqual([[0, 0x027e], [1, 0x027e], [2, 0x00fd], [3, 0x00bd], [4, 0x00bd], [6, 0x0006]]);
    indexOk(wb, 1);
  });

  it("rows on both sides of a row block (31 / 32, 63 / 64) and far past the end", async () => {
    const { wb } = await edited(EDGE, (by) => {
      for (const [a, v] of [["A32", 3200], ["A33", "블록"], ["C32", 1], ["C33", 2], ["A64", 64], ["A65", 65], ["A200", 1], ["Z5000", "멀리"]] as const) put(by(S), a, v);
    });
    indexOk(wb, 1);
    const dim = subs(wb)[1].find((r) => r.type === 0x0200)!;
    expect([dim.data.readUInt32LE(4), dim.data.readUInt16LE(10)]).toEqual([5000, 26]);
  });

  it("rich-text and phonetic SST entries: their text typed elsewhere is a new plain entry, the old ones stay", async () => {
    const sst0 = records(workbookOf(new Uint8Array(readFileSync(EDGE)))).find((r) => r.type === 0x00fc)!;
    const { wb } = await edited(EDGE, (by) => {
      put(by(S), "B10", "새 글"); // was rich text
      put(by(S), "B11", "大阪"); // was a string with phonetic data
      put(by(S), "D10", "굵게 bold 보통");
      put(by(S), "D11", "東京");
    });
    const sst = records(wb).find((r) => r.type === 0x00fc)!;
    expect(sst.data.readUInt32LE(4)).toBe(sst0.data.readUInt32LE(4) + 4);
    expect(sst.data.readUInt32LE(0)).toBe(sst0.data.readUInt32LE(0) + 2); // 4 LABELSST in, 2 out
  });

  it("long wide texts across CONTINUE records (emoji surrogate pairs, Latin-1 then Hangul, 20 000 ASCII)", async () => {
    const { wb } = await edited(EDGE, (by) => {
      put(by(S), "E40", "가😀".repeat(3000));
      put(by(S), "E41", "a" + "😀".repeat(5000));
      put(by(S), "E42", "x".repeat(20000));
      put(by(S), "E43", "é".repeat(9000) + "한");
    });
    for (const r of records(wb)) expect(r.data.length).toBeLessThanOrEqual(8224);
  });

  it("two sheets edited at once", async () => {
    const { wb } = await edited(EDGE, (by) => {
      put(by(S), "A1", 7);
      put(by(S), "H1", "끝");
      put(by("Second"), "B2", 999);
      put(by("Second"), "C5", "two");
    });
    indexOk(wb, 1);
    indexOk(wb, 2);
  });

  it("a data table: its result cells written anew (XLS), its input values are plain values", async () => {
    const { doc } = await open(EDGE);
    put(sheets(doc)[0], "F22", 5);
    await save(doc);
    expect(lastLegacySave.xls).toBe("fresh");
    await edited(EDGE, (by) => put(by(S), "E22", 50));
  });

  // Excel in manual calculation does not recalculate on load even without RECALCID (checked: B1 =A1*2 still showed the
  // old 10 after A1 became 50), and Excel itself recalculates before saving — so the edit would leave stale results
  it("manual calculation with formulas: written anew with the results recalculated, the mode never changed behind the user's back", async () => {
    const calc = (wb: Uint8Array) => subs(wb).flat().filter((r) => r.type === 0x000d).map((r) => r.data.readUInt16LE(0));
    expect(calc(workbookOf(new Uint8Array(readFileSync(MANUAL))))).toEqual([0]);
    const { doc } = await open(MANUAL);
    put(sheets(doc)[0], "A1", 50);
    expect(xlsValuesOnly(doc.pages)).toBe(true);
    const out = await save(doc);
    expect(lastLegacySave.xls).toBe("fresh");
    expect(new Set(calc(workbookOf(out)))).toEqual(new Set([0]));
  });

  it("manual calculation without a formula: the values are written, CALCMODE stays manual", async () => {
    const wb0 = workbookOf(new Uint8Array(readFileSync(MANUAL)));
    // the same workbook with every FORMULA record turned into a NUMBER (its cached result) — no formula left
    const noF = editWorkbook(wb0, new Map([["Manual", [0, 1, 2].flatMap((r) => [{ r, c: 1, v: (r + 1) * 10 }]).concat([{ r: 0, c: 2, v: 30 }])]]), true);
    const out = editWorkbook(noF, new Map([["Manual", [{ r: 0, c: 0, v: 50 }]]]));
    expect(records(out).some((r) => r.type === 0x0006)).toBe(false);
    expect(subs(out).flat().filter((r) => r.type === 0x000d).map((r) => r.data.readUInt16LE(0))).toEqual([0]);
  });
});

describe("what the record patcher refuses: the workbook written anew as XLS", () => {
  const anew = async (edit: (sh: SheetData, d: OmwDocument) => void) => {
    const { doc } = await open(CELLS_FILE);
    edit(sheets(doc)[0], doc);
    expect(xlsValuesOnly(doc.pages)).toBe(false);
    const out = await save(doc);
    expect(lastLegacySave.xls).toBe("fresh");
    return readXls(out, "en").sheets[0];
  };
  const refused = async (edit: (sh: SheetData, d: OmwDocument) => void) => {
    const { doc } = await open(CELLS_FILE);
    edit(sheets(doc)[0], doc);
    expect(xlsValuesOnly(doc.pages)).toBe(false);
    await expect(save(doc)).rejects.toThrow();
  };
  it("a formula typed in", async () => expect((await anew((s) => (s.cells.A2 = { ...s.cells.A2, f: "1+1" }))).cells.A2.f).toBe("1+1"));
  it("a value with a format change (a date typed into a general cell)", async () => {
    const back = await anew((s) => {
      s.styles.push({ fmt: "yyyy-mm-dd" });
      s.cells.A2 = { v: 46000, s: s.styles.length - 1 };
    });
    expect(back.styles[back.cells.A2.s!].fmt).toBe("yyyy-mm-dd");
  });
  it("a value and a column width", async () => {
    const back = await anew((s) => {
      put(s, "A2", 5);
      s.colW[0] = 200;
    });
    expect(Math.abs(back.colW[0] - 200)).toBeLessThanOrEqual(2);
  });
  it("a value and a page from elsewhere", () =>
    refused((s, d) => {
      put(s, "A2", 5);
      d.pages.push({ ...d.pages[0], id: "pg-omw", source: { format: "xlsx", name: "x.xlsx" } } as Page);
    }));
});

describe("the shape fingerprint", () => {
  it("is kept with the original, through an .omw save and reopen", async () => {
    const { doc } = await open(CELLS_FILE);
    const src = legacySource(doc.pages, "xls")!;
    expect(src.legacy!.shape).toBe(xlsShape(doc.pages));
    put(sheets(doc)[0], "A2", 31337);
    const back = unpackOmw(packOmw(doc).bytes).doc;
    expect(legacySource(back.pages, "xls")!.legacy).toEqual(src.legacy);
    expect(xlsValuesOnly(back.pages)).toBe(true);
    const out = await save(back);
    expect(sheets((await open(out)).doc)[0].cells.A2.v).toBe(31337);
  });

  it("a value typed and typed back is no edit", async () => {
    const { bytes, doc } = await open(CELLS_FILE);
    const s = sheets(doc)[0];
    const was = s.cells.A2.v;
    put(s, "A2", 5);
    put(s, "A2", was);
    expect(legacyUnchanged(doc.pages, "xls")).toBe(true);
    expect(eq(await save(doc), bytes)).toBe(true);
  });
});
