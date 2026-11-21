// DOC same-format save, stage 3 (doc-write3 — io/formats/docWrite.ts cellEdits / placeAt, legacyWrite.ts docShape):
// text typed or deleted inside a table cell, and in a field's result. The cell, row and paragraph marks and their
// properties stay; the field's marks stay and its PlcfFld entries move with them (the edited field's end gets
// fResultDirty | fResultEdited, as Word sets them); every main-document CP table moves with the text. Structural
// changes, a cell of a nested table, a paragraph mark in a cell or a result, an edit across a field's end: refused.
// Files: every DOC in qa/interop, and word-made/omni-legacy-word-fields.doc (legacy_doc_fields_make.ps1: QUOTE, REF,
// HYPERLINK, an empty result, PAGE; a table with a field, two-paragraph cells, a bookmark, a comment, an empty first
// cell and a hyperlink in cells; a nested table). Word itself: qa/interop/scripts/doc_fields_edit.ts → doc_fields_check.ps1.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
// (the DOC open reads its formatting through the DOCX importer, which parses XML: docRich.ts)
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfbStreams, readCfb, readCfbTree, writeCfb, type CfbNode } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { docShape, docShapeV1, docTextOnly, lastLegacySave, legacySource } from "../src/io/formats/legacyWrite";
import { DocRefused, docProps } from "../src/io/formats/docWrite";
import { deleteRange, insertText, splitParagraph } from "../src/core/richtext";
import type { OmwDocument, TableNode, TextNode, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";

const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.doc$/i.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
// (OMW_LEGACY_FILES=<a.doc>;… adds machine-local files, reported as "local #n" — as tests/docWrite.test.ts)
const extra = (process.env.OMW_LEGACY_FILES ?? "")
  .split(";")
  .filter((f) => f && /\.doc$/i.test(f) && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const FIELDS = join(ROOT, "qa/interop/word-made/omni-legacy-word-fields.doc");
const TEXT_DOC = join(ROOT, "qa/interop/word-made/omni-legacy-word-text.doc");
const hasFields = existsSync(FIELDS);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const read = (f: string) => new Uint8Array(readFileSync(f));

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("doc")!.open({ name: "omw-edit3.doc", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const refusal = async (doc: OmwDocument) => {
  const err = await save(doc).catch((e) => e);
  expect(err).toBeInstanceOf(DocRefused);
  return (err as DocRefused).why;
};
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const flowTexts = (doc: OmwDocument) => collectFlow(doc.pages).map((it) => (it.kind === "p" ? plain(it.p) : it.t.rows.map((r) => r.map((c) => c.text))));
const bodyParas = (doc: OmwDocument) =>
  doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !n.notes).flatMap((n) => n.paragraphs.flatMap((p, i) => (p.flowSplit || p.flowCont ? [] : [{ n, i, text: plain(p) }]))));
const tables = (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes.filter((n): n is TableNode => n.type === "TABLE"));
/** the cells of the body's tables, in order: the table node, row, column, text */
const cellsOf = (doc: OmwDocument) => tables(doc).flatMap((t) => t.rows.flatMap((r, ri) => r.map((c, ci) => ({ t, ri, ci, text: c.text }))));
/** the cell whose text includes `find` given the text `to(text)` */
function editCell(doc: OmwDocument, find: string, to: (t: string) => string) {
  const c = cellsOf(doc).find((x) => x.text.includes(find));
  expect(c, find).toBeTruthy();
  c!.t.rows = c!.t.rows.map((r, ri) => r.map((x, ci) => (ri === c!.ri && ci === c!.ci ? { ...x, text: to(x.text) } : x)));
}
/** a body paragraph's text edited at `find` (deleted, or `ins` typed before / after it) */
function editPara(doc: OmwDocument, find: string, ins: string | null, after = true) {
  const b = bodyParas(doc).find((x) => x.text.includes(find))!;
  expect(b, find).toBeTruthy();
  const k = b.text.indexOf(find);
  if (ins === null) b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: k }, end: { p: b.i, o: k + find.length } }).paras;
  else b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: after ? k + find.length : k }, ins).paras;
}

const u32 = (x: Uint8Array, o: number) => (x[o] | (x[o + 1] << 8) | (x[o + 2] << 16)) + x[o + 3] * 0x1000000;
/** the PLC at FIB pair `i`: its CPs (all, the last too) and each entry's data */
function plc(file: Uint8Array, i: number, cb: number) {
  const s = readCfb(file), wd = s.get("WordDocument")!, tb = s.get(wd[0x0b] & 0x02 ? "1Table" : "0Table")!;
  const fc = u32(wd, 154 + i * 8), lcb = u32(wd, 154 + i * 8 + 4);
  if (!lcb) return { cps: [] as number[], data: [] as number[][] };
  const n = (lcb - 4) / (4 + cb);
  return {
    cps: Array.from({ length: n + 1 }, (_, k) => u32(tb, fc + k * 4)),
    data: Array.from({ length: n }, (_, k) => Array.from(tb.subarray(fc + (n + 1) * 4 + k * cb, fc + (n + 1) * 4 + (k + 1) * cb))),
  };
}
/** main-document CP tables the writer moves (docWrite.ts MOVED): pair → bytes of data per entry */
const MOVED: Record<number, number> = { 2: 2, 4: 30, 6: 12, 16: 2, 22: 4, 23: 0, 40: 26, 42: 4, 43: 0, 46: 2 };
/** every paragraph, cell and row mark of the body (in order): its character, its PAPX and its CHPX */
function marksOf(file: Uint8Array) {
  const p = docProps(file);
  const out: string[] = [];
  for (let cp = 0; cp < p.text.length; cp++) {
    const c = p.text[cp];
    if (c !== "\r" && c !== "\x07") continue;
    out.push(`${c.charCodeAt(0)}:${Array.from(p.para(cp)?.papx ?? []).join(",")}:${Array.from(p.chpx(cp) ?? []).join(",")}`);
  }
  return out;
}
/** each field mark of the PlcfFld is that mark in the text now */
function fieldsConsistent(file: Uint8Array) {
  const text = docProps(file).text;
  const f = plc(file, 16, 2);
  return f.data.every((d, k) => text.charCodeAt(f.cps[k]) === (d[0] & 0x1f));
}

/** Edit, save, read back: the text as edited, the same tables, marks and their properties, the field marks in place. */
async function written(bytes: Uint8Array, edit: (doc: OmwDocument) => void) {
  const doc = await open(bytes);
  edit(doc);
  expect(docTextOnly(doc.pages)).toBe(true);
  const out = await save(doc);
  expect(lastLegacySave.doc).toBe("text");
  const back = await open(out);
  expect(flowTexts(back)).toEqual(flowTexts(doc));
  expect(legacySource(back.pages, "doc")?.legacy).toBeTruthy();
  expect(marksOf(out)).toEqual(marksOf(bytes));
  expect(fieldsConsistent(out)).toBe(true);
  // every stream but WordDocument and the table stream (and the summaries: a title from the first line) as it was
  const a = cfbStreams(readCfbTree(bytes)), b = cfbStreams(readCfbTree(out));
  expect([...b.keys()]).toEqual([...a.keys()]);
  for (const [k, v] of a) if (k !== "WordDocument" && !/Table$/.test(k) && !/SummaryInformation$/.test(k)) expect(eq(b.get(k)!, v), k).toBe(true);
  return { out, doc, back };
}

describe.each(files.map((f) => [label(f), f]))("table cells written: %s", (_name, file) => {
  it("letters typed into each cell, one at a time (a nested table's cell or a row's end read as a cell: refused)", async () => {
    const bytes = read(file);
    const doc0 = await open(bytes);
    const reader = docProps(bytes).text;
    let ok = 0;
    for (const [k, c] of cellsOf(doc0).entries()) {
      const doc = await open(bytes);
      const cell = cellsOf(doc)[k];
      const o = Math.floor(c.text.length / 2);
      cell.t.rows = cell.t.rows.map((r, ri) => r.map((x, ci) => (ri === cell.ri && ci === cell.ci ? { ...x, text: x.text.slice(0, o) + "칸omw" + x.text.slice(o) } : x)));
      const err = await save(doc).catch((e) => e);
      if (err instanceof Error) {
        expect(err, `${k} ${c.text}`).toBeInstanceOf(DocRefused);
        expect((err as DocRefused).why).toBe("special");
        // (refused: a cell in a nested table, a row-end mark the reader shows as an empty cell, a cell the flow added)
        expect(c.text === "" || /안 셋/.test(c.text), `${k} ${JSON.stringify(c.text)} refused`).toBe(true);
        continue;
      }
      ok++;
      expect(flowTexts(await open(err))).toEqual(flowTexts(doc));
      expect(marksOf(err)).toEqual(marksOf(bytes));
      expect(docProps(err).text.length).toBe(reader.length + 4);
    }
    // (every cell with text but a nested table's; an empty cell too when it is one)
    expect(ok).toBeGreaterThanOrEqual(cellsOf(doc0).filter((c) => c.text && !/안 셋/.test(c.text)).length);
    if (/fields/.test(file)) expect(ok).toBe(cellsOf(doc0).filter((c) => !/안 셋/.test(c.text)).length);
  });
  it("a cell's text deleted, then saved again with a second edit", async () => {
    const bytes = read(file);
    const doc = await open(bytes);
    const c = cellsOf(doc).find((x) => x.text.length >= 3 && !x.text.includes("\n"));
    if (!c) return;
    const first = await written(bytes, (d) => editCell(d, c.text, (t) => t.slice(0, 1) + t.slice(3)));
    const second = await written(first.out, (d) => editCell(d, c.text.slice(0, 1) + c.text.slice(3), (t) => "둘째 " + t));
    expect(flowTexts(second.back).flat(2)).toContain("둘째 " + c.text.slice(0, 1) + c.text.slice(3));
  });
  it("unedited: the original bytes; a cell typed and deleted back: the original bytes", async () => {
    const bytes = read(file);
    let doc = await open(bytes);
    expect(eq(await save(doc), bytes)).toBe(true);
    doc = await open(bytes);
    const c = cellsOf(doc).find((x) => x.text.length >= 2);
    if (!c) return;
    editCell(doc, c.text, (t) => t + "x");
    editCell(doc, c.text + "x", (t) => t.slice(0, -1));
    expect(eq(await save(doc), bytes)).toBe(true);
  });
});

describe("cells and field results (omni-legacy-word-fields.doc)", () => {
  const bytes = hasFields ? read(FIELDS) : new Uint8Array();
  const text0 = hasFields ? docProps(bytes).text : "";
  /** CP tables: entries before `at` stay, after it move by `delta` (pairs whose entries are all known) */
  const shifted = (out: Uint8Array, at: number, delta: number) => {
    for (const [i, cb] of Object.entries(MOVED).map(([k, v]) => [Number(k), v])) {
      const a = plc(bytes, i, cb), b = plc(out, i, cb);
      expect(b.cps.length, `pair ${i}`).toBe(a.cps.length);
      a.cps.forEach((cp, k) => expect(b.cps[k], `pair ${i} entry ${k}`).toBe(cp < at ? cp : cp + delta));
    }
  };

  it.runIf(hasFields)("the sample: the fields, the bookmarks, the comment and the tables are there", () => {
    expect(plc(bytes, 16, 2).data.length).toBe(20); // QUOTE, REF, HYPERLINK, QUOTE "", QUOTE, HYPERLINK, PAGE
    expect(plc(bytes, 22, 4).cps.length).toBe(3); // omwTarget, omwCell (and the PLC's last CP)
    expect(plc(bytes, 4, 30).data.length).toBe(1); // the comment in a cell
    expect(fieldsConsistent(bytes)).toBe(true);
  });

  it.runIf(hasFields)("a cell with a bookmark: text typed before it moves it, inside it widens it (CP tables shifted)", async () => {
    const at = text0.indexOf("omwCell");
    const bk = (f: Uint8Array) => [plc(f, 22, 4).cps, plc(f, 23, 0).cps];
    const [bkf, bkl] = bk(bytes);
    const k = bkf.indexOf(at);
    expect(k).toBeGreaterThanOrEqual(0);
    // before it: moves
    let r = await written(bytes, (d) => editCell(d, "omwCell", (t) => t.replace("칸 omwCell", "칸앞XY omwCell")));
    shifted(r.out, at - 1, 3);
    expect(bk(r.out)[0][k]).toBe(at + 3);
    // inside it: the start stays, the end moves
    r = await written(bytes, (d) => editCell(d, "omwCell", (t) => t.replace("omwCell", "omwNewCell")));
    expect(bk(r.out)[0][k]).toBe(bkf[k]);
    const endK = bkl.indexOf(at + 7);
    expect(bk(r.out)[1][endK]).toBe(at + 10);
  });

  it.runIf(hasFields)("a cell with a comment's range and reference; a cell with a field; the empty first cell", async () => {
    const ref = text0.indexOf("\x05");
    let r = await written(bytes, (d) => editCell(d, "Comment cell", (t) => t.replace("Comment cell", "고친 메모 칸")));
    expect(plc(r.out, 4, 30).cps[0]).toBe(ref);
    expect(docProps(r.out).text.charCodeAt(ref)).toBe(5);
    r = await written(bytes, (d) => editCell(d, "메모 칸", (t) => "앞 " + t));
    expect(plc(r.out, 4, 30).cps[0]).toBe(ref + 2);
    expect(plc(r.out, 42, 4).cps[0]).toBe(plc(bytes, 42, 4).cps[0] + 2);
    // the field in a cell: letters around it and in its result
    r = await written(bytes, (d) => editCell(d, "Cell field", (t) => t.replace("칸 필드", "칸 바뀐 필드").replace("칸 뒤", "칸 뒤 끝")));
    expect(docProps(r.out).text).toContain("\x14칸 바뀐 필드 Cell field\x15칸 뒤 끝\x07");
    expect(docProps(r.out).text).toContain('QUOTE "칸 필드 Cell field"'); // (the code as it was)
    // the empty first cell
    r = await written(bytes, (d) => {
      const c = cellsOf(d).find((x, k, all) => x.text === "" && all[k + 1]?.text.startsWith("링크 칸"))!;
      c.t.rows = c.t.rows.map((row, ri) => row.map((x, ci) => (ri === c.ri && ci === c.ci ? { ...x, text: "빈칸 omw" } : x)));
    });
    expect(docProps(r.out).text).toContain("\x07빈칸 omw\x07링크 칸");
  });

  it.runIf(hasFields)("two-paragraph cells: letters and a line break typed in either paragraph; the paragraphs the reader shows as body", async () => {
    let r = await written(bytes, (d) => editCell(d, "두 문단 둘째", (t) => t.replace("둘째", "둘째 끝").replace("첫째", "첫째\n줄")));
    // (where the line break goes — after the first paragraph's text or at the second's start — is the diff's pick; the
    // cell reads the same)
    expect(docProps(r.out).text).toMatch(/두 문단 첫째(\x0b줄\r|\r줄\x0b)두 문단 둘째 끝\x07/);
    // (the row's first cell with two paragraphs: read as the cell's lines by its marks' properties since 2026-11-17 —
    // before, its first paragraph was shown as a body paragraph and the table cut in two)
    expect(bodyParas(await open(bytes)).some((x) => x.text.startsWith("첫 칸 위"))).toBe(false);
    r = await written(bytes, (d) => editCell(d, "첫 칸 위", (t) => t.replace("첫 칸 위", "첫 칸 위고친 ")));
    expect(docProps(r.out).text).toContain("첫 칸 위고친  Upper\r첫 칸 아래");
  });

  it.runIf(hasFields)("refused: a paragraph mark in a cell deleted or typed, a nested table's cell, a cell the flow added, a row added", async () => {
    let doc = await open(bytes);
    editCell(doc, "두 문단 둘째", (t) => t.replace("\n", ""));
    expect(await refusal(doc)).toBe("special");
    doc = await open(bytes);
    editCell(doc, "첫 칸 아래", (t) => t.replace("\n", ""));
    expect(await refusal(doc)).toBe("special");
    doc = await open(bytes);
    editCell(doc, "안 셋", (t) => t.replace("안 셋", "안 셋 omw"));
    expect(await refusal(doc)).toBe("special");
    doc = await open(bytes);
    const t = tables(doc).find((x) => x.rows.some((r) => r.some((c) => c.text === "이름 Name")))!;
    t.rows = [...t.rows.slice(0, 1), t.rows[0].map((c) => ({ ...c, text: "" })), ...t.rows.slice(1)];
    expect(docTextOnly(doc.pages)).toBe(false);
    await expect(save(doc)).rejects.toThrow();
  });

  it.runIf(hasFields)("a field's result edited: the marks stay, PlcfFld moves, the edited field's end gets fResultDirty | fResultEdited", async () => {
    const was = plc(bytes, 16, 2);
    const r = await written(bytes, (d) => editPara(d, "결과 Quote ", null));
    const now = plc(r.out, 16, 2);
    const t = docProps(r.out).text;
    expect(t).toContain('\x13 QUOTE "인용 결과 Quote result" \x14인용 result\x15 인용 뒤');
    const begin = text0.indexOf("\x13 QUOTE");
    const end = text0.indexOf("\x15", begin);
    // entries after the deleted 9 letters move back by 9; the QUOTE field's end: 0x80 → 0x8C (Word does the same); others as they were
    was.cps.forEach((cp, k) => expect(now.cps[k]).toBe(cp > begin + 30 ? cp - 9 : cp));
    was.data.forEach((dd, k) => expect(now.data[k]).toEqual(was.cps[k] === end ? [0x15, dd[1] | 0x0c] : dd));
    expect(was.data[was.cps.indexOf(end)]).toEqual([0x15, 0x80]);
    shifted(r.out, begin + 30, -9);
  });

  it.runIf(hasFields)("REF, hyperlink, PAGE results; letters typed at a result's start, middle and end", async () => {
    let r = await written(bytes, (d) => {
      editPara(d, "글 Target 끝", "참조 ", false); // a REF's result: in its middle
      editPara(d, "링크 글", "새 ", false); // at a hyperlink's start (a letter of the body before it: into the body)
      editPara(d, "Link text", " 고침"); // at its end (a letter of the body after it: into the body)
      editPara(d, "Link text", "X", false); // in its middle
    });
    let t = docProps(r.out).text;
    expect(t).toContain("\x14목표 참조 글 Target\x15 끝.");
    expect(t).toContain("링크 앞 새 \x13 HYPERLINK");
    expect(t).toContain("\x14링크 글 XLink text\x15 고침 링크 뒤.");
    r = await written(bytes, (d) => editPara(d, "Page 1", "0"));
    t = docProps(r.out).text;
    expect(t).toContain("\x141\x150 쪽.");
    r = await written(bytes, (d) => editCell(d, "셀링크", (x) => x.replace("셀링크", "셀 링크 고침")));
    // (" 고침" typed at the result's end, a letter of the body after it: into the body)
    expect(docProps(r.out).text).toContain("\x14셀 링크\x15 고침 뒤\x07");
    // a whole result deleted: the field stays, with an empty result
    r = await written(bytes, (d) => editPara(d, "인용 결과 Quote result", null));
    expect(docProps(r.out).text).toContain('Quote result" \x14\x15 인용 뒤');
  });

  it.runIf(hasFields)("refused: across a field's end, Enter in a result", async () => {
    let doc = await open(bytes);
    editPara(doc, "result 인용", null);
    expect(await refusal(doc)).toBe("special");
    doc = await open(bytes);
    const b = bodyParas(doc).find((x) => x.text.includes("Quote result"))!;
    b.n.paragraphs = splitParagraph(b.n.paragraphs, { p: b.i, o: b.text.indexOf("Quote result") + 5 }).paras;
    expect(await refusal(doc)).toBe("special");
  });

  it.runIf(hasFields)("deleted cell and result text is in no stream (UTF-16LE, cp949)", async () => {
    const td = new TextDecoder("euc-kr");
    const cp949 = (s: string) => {
      const out: number[] = [];
      for (const ch of s) {
        if (ch.charCodeAt(0) < 0x80) out.push(ch.charCodeAt(0));
        else
          outer: for (let a = 0x81; a <= 0xfe; a++)
            for (let b = 0x41; b <= 0xfe; b++)
              if (td.decode(Uint8Array.of(a, b)) === ch) {
                out.push(a, b);
                break outer;
              }
      }
      return Buffer.from(out);
    };
    const holders = (file: Uint8Array, s: string) => [...cfbStreams(readCfbTree(file))].filter(([, v]) => [Buffer.from(s, "utf16le"), cp949(s)].some((p) => Buffer.from(v).indexOf(p) >= 0)).map(([k]) => k);
    for (const word of ["셀링크", "Comment cell", "Link text", "두 문단 둘째"]) expect(holders(bytes, word), word).toContain("WordDocument");
    const r = await written(bytes, (d) => {
      editCell(d, "셀링크", (x) => x.replace("셀링크", "새"));
      editCell(d, "Comment cell", (x) => x.replace(" Comment cell", ""));
      editCell(d, "두 문단 둘째", (x) => x.replace("두 문단 둘째", "둘"));
      editPara(d, "Link text", null);
    });
    for (const word of ["셀링크", "Comment cell", "Link text", "두 문단 둘째"]) expect(holders(r.out, word), word).toEqual([]);
  });
});

describe("merged cells (QA doc-write3: Word does not show a cell merged into the one above or before it)", () => {
  /** the file with the TC80 of cell `itc` of the row ending at `ttp` (CP) given the flags `grf` (ORed in) */
  function withCellFlags(bytes: Uint8Array, rows: { ttp: number; itc: number; grf: number }[]): Uint8Array {
    const tree = readCfbTree(bytes);
    const find = (n: CfbNode): CfbNode | undefined => (n.name === "WordDocument" ? n : n.kids?.map(find).find(Boolean));
    const node = find(tree.root)!;
    const wd = node.data!.slice();
    for (const { ttp, itc, grf } of rows) {
      const g = docProps(bytes).para(ttp)!.papx!;
      const at = Buffer.from(wd).indexOf(Buffer.from(g));
      expect(at, `TTP ${ttp}`).toBeGreaterThan(0);
      expect(Buffer.from(wd).indexOf(Buffer.from(g), at + 1), `TTP ${ttp} once`).toBe(-1);
      const def = Buffer.from(g).indexOf(Buffer.from([0x08, 0xd6]));
      const itcMac = g[def + 4];
      const tc = at + def + 5 + (itcMac + 1) * 2 + itc * 20;
      wd[tc] |= grf;
    }
    node.data = wd;
    return writeCfb(tree);
  }
  it.runIf(hasFields)("a cell merged into the one above (fVertMerge) or before (fMerged): its text is not edited; the other cells are", async () => {
    const bytes0 = read(FIELDS);
    const text = docProps(bytes0).text;
    const rowEnd = (after: string) => text.indexOf("\x07\x07", text.indexOf(after)) + 1;
    // row 2, its second cell ("칸 앞 … 칸 뒤"): merged with the cell above; row 3, its third ("메모 칸"): with the one before
    const bytes = withCellFlags(bytes0, [
      { ttp: rowEnd("두 문단 둘째"), itc: 1, grf: 0x20 },
      { ttp: rowEnd("Comment cell"), itc: 2, grf: 0x02 },
    ]);
    expect(docProps(bytes).text).toBe(text);
    for (const [find, to] of [
      ["칸 뒤", (t: string) => t + "X"],
      ["Comment cell", (t: string) => "X" + t],
    ] as const) {
      const doc = await open(bytes);
      editCell(doc, find, to);
      expect(docTextOnly(doc.pages)).toBe(true);
      expect(await refusal(doc), find).toBe("special");
    }
    // (the first cell of a vertical merge — fVertMerge and fVertRestart — and cells not merged: written)
    const restart = withCellFlags(bytes0, [{ ttp: rowEnd("두 문단 둘째"), itc: 1, grf: 0x60 }]);
    await written(restart, (d) => editCell(d, "칸 뒤", (t) => t + "X"));
    await written(bytes, (d) => editCell(d, "사과 Apple", (t) => t + "X"));
    await written(bytes, (d) => editCell(d, "책갈피 칸", (t) => t + "X"));
  });
});

describe("a document opened before doc-write3 (its shape taken with the cells' text: docShapeV1)", () => {
  it.runIf(existsSync(TEXT_DOC))("body text edits are still written; a cell's text is refused (save as DOCX)", async () => {
    const bytes = read(TEXT_DOC);
    const old = async () => {
      const doc = await open(bytes);
      const l = legacySource(doc.pages, "doc")!.legacy!;
      l.shape = docShapeV1(doc.pages);
      expect(l.shape).not.toBe(docShape(doc.pages));
      return doc;
    };
    let doc = await old();
    editPara(doc, "첫 문단", "omw");
    expect(docTextOnly(doc.pages)).toBe(true);
    expect(flowTexts(await open(await save(doc)))).toEqual(flowTexts(doc));
    doc = await old();
    editCell(doc, "칸 가", (t) => t + "omw");
    expect(docTextOnly(doc.pages)).toBe(false);
    await expect(save(doc)).rejects.toThrow();
  });
});

describe("a hyperlink's result in omni-legacy-word-text.doc", () => {
  it.runIf(existsSync(TEXT_DOC))("letters typed and deleted inside it (was refused in stage 2)", async () => {
    const bytes = read(TEXT_DOC);
    const r = await written(bytes, (d) => editPara(d, "예시", null));
    expect(docProps(r.out).text).toContain("\x14 링크\x15");
  });
});
