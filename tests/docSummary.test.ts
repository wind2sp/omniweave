// QA doc-summary: text deleted or replaced in a DOC / HWP 5 saved in its own format must not stay readable anywhere in
// the file — not in the text streams (docWrite.ts clears the deleted characters; hwp5Body.ts writes the section anew),
// not in the preview text (HWP PrvText, made again as 한글 makes it), not in a title the program took from the first
// line (SummaryInformation / HwpSummaryInformation PIDSI_TITLE, Word's DocumentSummaryInformation parts: oleSummary.ts
// retitleText). Each stream of the saved file (inflated when it is deflated) is searched for the removed text as UTF-16LE
// and as cp949 / cp1252. A document saved unedited is the original bytes.
// Files: every DOC and HWP in qa/interop (omni-legacy-word-summary.doc: Word 2016 saved with the title set to the start
// of its first line, as Word up to 2003 set it; adobe-made/hwp_doc.hwp and hancom-made/omni-hwp-objects.hwp: titles
// 한글 took from the first line).

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { inflateSync } from "fflate";
import { cfbStreams, readCfbTree } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { previewText } from "../src/io/formats/hwp5Body";
import { lineTitle, retitleText, staleTitle, summaryProps, summaryText } from "../src/io/formats/oleSummary";
import { deleteRange, insertText } from "../src/core/richtext";
import type { OmwDocument, Page, TextNode, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const walk = (d: string, ext: RegExp): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f), ext) : ext.test(f) ? [join(d, f)] : []));
const interop = join(ROOT, "qa/interop");
const docs = existsSync(interop) ? walk(interop, /\.doc$/i) : [];
const hwps = existsSync(interop) ? walk(interop, /\.hwp$/i) : [];
const label = (f: string) => f.slice(ROOT.length + 1).replace(/\\/g, "/");
const SUMMARY_DOC = join(interop, "word-made/omni-legacy-word-summary.doc");
const HWP_TITLED = join(interop, "adobe-made/hwp_doc.hwp");
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");

async function open(ext: "doc" | "hwp", bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt(ext)!.open({ name: `omw-leak.${ext}`, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (ext: "doc" | "hwp", doc: OmwDocument) => (await exportById(ext)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
/** body paragraphs (whole ones) with the frame holding each */
const bodyParas = (doc: OmwDocument) =>
  doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !n.notes).flatMap((n) => n.paragraphs.flatMap((p, i) => (p.flowSplit || p.flowCont ? [] : [{ n, i, text: plain(p) }]))));

/** every stream of a compound file, and its inflated bytes when it inflates (HWP's deflated streams) */
function streamsOf(file: Uint8Array): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = [];
  for (const [k, v] of cfbStreams(readCfbTree(file))) {
    out.push([k, v]);
    try {
      const x = inflateSync(v);
      if (x.length) out.push([`${k} (inflated)`, x]);
    } catch {
      /* not deflated */
    }
  }
  return out;
}
const utf16 = (s: string) => Buffer.from(s, "utf16le");
const cp949 = (s: string) => {
  // (the encoder from the decoder: each Hangul syllable / ASCII letter of `s` as euc-kr bytes)
  const td = new TextDecoder("euc-kr");
  const out: number[] = [];
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x80) {
      out.push(ch.charCodeAt(0));
      continue;
    }
    let found = false;
    for (let a = 0x81; a <= 0xfe && !found; a++)
      for (let b = 0x41; b <= 0xfe && !found; b++)
        if (td.decode(Uint8Array.of(a, b)) === ch) out.push(a, b), (found = true);
    if (!found) return null;
  }
  return Buffer.from(out);
};
/** the streams that hold `s` (UTF-16LE, cp949; an ASCII text also as 8-bit) */
function holders(file: Uint8Array, s: string): string[] {
  const pats = [utf16(s), cp949(s)].filter((x): x is Buffer => !!x && x.length > 0);
  return streamsOf(file)
    .filter(([, v]) => pats.some((p) => Buffer.from(v).indexOf(p) >= 0))
    .map(([k]) => k);
}

/** times `s` is in the text streams (WordDocument; BodyText sections inflated), as UTF-16LE (an ASCII word also as
 *  8-bit: a DOC's compressed pieces) */
const inBody = (file: Uint8Array, s: string) => {
  const pats = [utf16(s), ...(/^[\x20-\x7e]+$/.test(s) ? [Buffer.from(s, "latin1")] : [])].map((p) => p.toString("latin1"));
  return streamsOf(file)
    .filter(([k]) => k === "WordDocument" || /^BodyText\/Section\d+( \(inflated\))?$/.test(k))
    .reduce((n, [, v]) => n + pats.reduce((m, p) => m + Buffer.from(v).toString("latin1").split(p).length - 1, 0), 0);
};

/** A word (4+ letters, no spaces) of a body paragraph that the text streams hold once and no other stream (but the
 *  preview text) holds. */
function distinctive(doc: OmwDocument, file: Uint8Array): { b: ReturnType<typeof bodyParas>[number]; word: string; at: number } | null {
  const ok = (b: { text: string }, word: string) =>
    b.text.split(word).length === 2 && inBody(file, word) === 1 && !holders(file, word).some((k) => !/^(WordDocument|BodyText\/Section\d+|PrvText)/.test(k));
  for (const b of bodyParas(doc))
    for (const m of b.text.matchAll(/[\p{L}\p{N}]{4,}/gu)) if (ok(b, m[0])) return { b, word: m[0], at: m.index! };
  // (a document of sentences said again and again: a whole paragraph no other one holds)
  for (const b of bodyParas(doc)) if (b.text.trim().length >= 6 && ok(b, b.text)) return { b, word: b.text, at: 0 };
  return null;
}
const flowText = (doc: OmwDocument) => bodyParas(doc).map((x) => x.text).join("\n");

describe.each(docs.map((f) => [label(f), f]))("DOC: removed text left nowhere: %s", (_n, file) => {
  const orig = new Uint8Array(readFileSync(file));
  it("an unedited document saves as the original bytes", async () => {
    expect(eq(await save("doc", await open("doc", orig)), orig)).toBe(true);
  });
  it("a deleted word is in no stream", async () => {
    const doc = await open("doc", orig);
    const d = distinctive(doc, orig);
    expect(d, "a word to delete").toBeTruthy();
    const { b, word, at } = d!;
    expect(holders(orig, word).length).toBeGreaterThan(0);
    b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: at }, end: { p: b.i, o: at + word.length } }).paras;
    const out = await save("doc", doc);
    expect(holders(out, word), word).toEqual([]);
  });
  it("a replaced word is in no stream", async () => {
    const doc = await open("doc", orig);
    const { b, word, at } = distinctive(doc, orig)!;
    b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: at }, end: { p: b.i, o: at + word.length } }).paras;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: at }, "오메바꿈omw").paras;
    const out = await save("doc", doc);
    expect(holders(out, word), word).toEqual([]);
    expect(flowText(await open("doc", out))).toContain(b.text.slice(0, at) + "오메바꿈omw" + b.text.slice(at + word.length));
  });
});

describe("DOC: a title taken from the first line", () => {
  const orig = new Uint8Array(readFileSync(SUMMARY_DOC));
  const si = (f: Uint8Array) => cfbStreams(readCfbTree(f)).get("\u0005SummaryInformation")!;
  const dsi = (f: Uint8Array) => cfbStreams(readCfbTree(f)).get("\u0005DocumentSummaryInformation")!;
  it("the file is one: its title is the start of its first line", () => {
    expect(summaryText(si(orig), 2)).toBe("본문 글자 시험 첫 문단입니다");
  });
  it("goes with the first line, every other property kept", async () => {
    const doc = await open("doc", orig);
    const b = bodyParas(doc).find((x) => x.text.startsWith("본문 글자 시험 첫 문단입니다"))!;
    b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: 0 }, end: { p: b.i, o: "본문 글자 시험 첫 문단입니다".length } }).paras;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "오메 머리 글").paras;
    const out = await save("doc", doc);
    expect(summaryText(si(out), 2)).toBe("오메 머리 글");
    for (const w of ["첫 문단입니다", "본문 글자 시험"]) expect(holders(out, w), w).toEqual([]);
    expect(summaryText(dsi(out), 13) ?? "").not.toContain("첫 문단");
    const a = summaryProps(si(orig))!, z = summaryProps(si(out))!;
    for (const [id, v] of a) if (id !== 2) expect(eq(z.get(id)!, v), `SI ${id}`).toBe(true);
    expect(summaryText(si(out), 4)).toBe("Omniweave QA");
  });
  it("stays when the first line still starts with it", async () => {
    const doc = await open("doc", orig);
    const b = bodyParas(doc).find((x) => x.text.startsWith("본문 글자"))!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: b.text.length }, " 뒤omw").paras;
    const out = await save("doc", doc);
    expect(eq(si(out), si(orig))).toBe(true);
    expect(eq(dsi(out), dsi(orig))).toBe(true);
  });

  // (QA 11-18) the copy in SttbfAssoc read on its own (FIB fcSttbfAssoc / lcbSttbfAssoc): a longer title moved after the
  // table stream's bytes, a shorter one in its place; the other strings the same; the property sets well formed
  const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
  const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
  function assoc(file: Uint8Array) {
    const s = cfbStreams(readCfbTree(file));
    const wd = s.get("WordDocument")!;
    const table = s.get(wd[0x0b] & 0x02 ? "1Table" : "0Table")!;
    const fc = u32(wd, 154 + 32 * 8), lcb = u32(wd, 154 + 32 * 8 + 4);
    let o = fc + 6;
    const strs: string[] = [];
    for (let i = 0, n = u16(table, fc + 2); i < n; i++) strs.push(Buffer.from(table.subarray(o + 2, o + 2 + u16(table, o) * 2)).toString("utf16le")), (o += 2 + u16(table, o) * 2);
    return { fc, lcb, end: o, strs, size: table.length };
  }
  function wellFormed(b: Uint8Array) {
    expect(u16(b, 0)).toBe(0xfffe);
    for (let k = 0; k < u32(b, 24); k++) {
      const at = u32(b, 28 + k * 20 + 16), size = u32(b, at), count = u32(b, at + 4);
      expect(at + size).toBeLessThanOrEqual(b.length);
      const offs = Array.from({ length: count }, (_, i) => u32(b, at + 12 + i * 8)).sort((x, y) => x - y);
      offs.forEach((off, i) => (expect(off).toBeGreaterThanOrEqual(8 + count * 8), expect((offs[i + 1] ?? size) - off).toBeGreaterThanOrEqual(4)));
    }
  }
  it.each([
    ["a longer title", "아주 긴 새 머리 글 ".repeat(30), false, "아주 긴 새 머리 글 ".repeat(30).slice(0, 255)],
    ["a shorter title", "가", false, "가"],
    ["a first line that starts with a sign", "— 기호로 시작", false, ""],
    ["the first paragraph emptied", "", true, "모양 섞인 문단"],
  ])("(QA 11-18) %s: SttbfAssoc read on its own", async (_n, now, whole, title) => {
    const doc = await open("doc", orig);
    const b = bodyParas(doc).find((x) => x.text.startsWith("본문 글자 시험 첫 문단입니다"))!;
    b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: 0 }, end: { p: b.i, o: whole ? b.text.length : "본문 글자 시험 첫 문단입니다".length } }).paras;
    if (now) b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, now).paras;
    const out = await save("doc", doc);
    const a = assoc(orig), z = assoc(out);
    expect(z.end).toBe(z.fc + z.lcb);
    expect(z.fc + z.lcb).toBeLessThanOrEqual(z.size);
    if (z.lcb > a.lcb) expect(z.fc).toBeGreaterThanOrEqual(a.fc + a.lcb);
    else expect(z.fc).toBe(a.fc);
    expect(z.strs.map((s, i) => (i === 2 ? title : s))).toEqual(a.strs.map((s, i) => (i === 2 ? title : s)));
    expect(z.strs[2]).toBe(title);
    expect(summaryText(si(out), 2)).toBe(title);
    wellFormed(si(out));
    wellFormed(dsi(out));
    expect(holders(out, "첫 문단입니다")).toEqual([]);
  });
});

describe.each(hwps.map((f) => [label(f), f]))("HWP: removed text left nowhere: %s", (_n, file) => {
  const orig = new Uint8Array(readFileSync(file));
  it("an unedited document saves as the original bytes", async () => {
    expect(eq(await save("hwp", await open("hwp", orig)), orig)).toBe(true);
  });
  it("a deleted word is in no stream, the preview text is the new body's", async () => {
    const doc = await open("hwp", orig);
    const d = distinctive(doc, orig);
    expect(d, "a word to delete").toBeTruthy();
    const { b, word, at } = d!;
    expect(holders(orig, word).length).toBeGreaterThan(0);
    b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: at }, end: { p: b.i, o: at + word.length } }).paras;
    const out = await save("hwp", doc);
    expect(holders(out, word), word).toEqual([]);
    const s = cfbStreams(readCfbTree(out));
    const prv = s.get("PrvText");
    if (prv) {
      const comp = (s.get("FileHeader")![36] & 1) !== 0;
      const secs = [...s.keys()].filter((k) => /^BodyText\/Section\d+$/.test(k)).sort((x, y) => Number(x.slice(16)) - Number(y.slice(16)));
      expect(Buffer.from(prv).toString("utf16le")).toBe(previewText(secs.map((k) => (comp ? inflateSync(s.get(k)!) : s.get(k)!))));
    }
  });
  it("(QA 11-18) a very long first paragraph: the preview text stops at 1023 units, the title at 255", async () => {
    const doc = await open("hwp", orig);
    const b = bodyParas(doc).find((x) => x.text.trim())!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "긴글".repeat(1500)).paras;
    const s = cfbStreams(readCfbTree(await save("hwp", doc)));
    const prv = s.get("PrvText");
    if (prv) expect(Buffer.from(prv).toString("utf16le")).toBe("긴글".repeat(511));
    const t = summaryText(s.get("\u0005HwpSummaryInformation")!, 2)!;
    expect(t === summaryText(cfbStreams(readCfbTree(orig)).get("\u0005HwpSummaryInformation")!, 2) || t === "긴글".repeat(128).slice(0, 255)).toBe(true);
  });
});

describe("HWP: a title 한글 took from the first line", () => {
  const orig = new Uint8Array(readFileSync(HWP_TITLED));
  const sum = (f: Uint8Array) => cfbStreams(readCfbTree(f)).get("\u0005HwpSummaryInformation")!;
  it("the file is one", () => {
    expect(summaryText(sum(orig), 2)).toBe("한글 시험 문서 ");
  });
  it("goes with the first line, every other property kept", async () => {
    const doc = await open("hwp", orig);
    const b = bodyParas(doc).find((x) => x.text.startsWith("한글 시험 문서"))!;
    b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: 0 }, end: { p: b.i, o: "한글 시험 문서".length } }).paras;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "오메 고친 머리").paras;
    const out = await save("hwp", doc);
    expect(summaryText(sum(out), 2)).toBe("오메 고친 머리 ");
    expect(holders(out, "한글 시험 문서"), "한글 시험 문서").toEqual([]);
    const a = summaryProps(sum(orig))!, z = summaryProps(sum(out))!;
    expect([...z.keys()]).toEqual([...a.keys()]);
    for (const [id, v] of a) if (id !== 2) expect(eq(z.get(id)!, v), `HwpSummaryInformation ${id}`).toBe(true);
  });
  it("stays when the first line still starts with it; a title the author set stays", async () => {
    const doc = await open("hwp", orig);
    const b = bodyParas(doc).find((x) => x.text.startsWith("한글 시험 문서"))!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: b.text.length }, " 뒤omw").paras;
    const out = await save("hwp", doc);
    expect(eq(sum(out), sum(orig))).toBe(true);
    // (omni-hwp-tables.hwp: the title 'Omni 분기 보고서' is the start of its first line too — the generator set it so;
    // retitleText cannot tell, and takes it again only when the first line no longer starts with it)
  });
});

describe("HWP: PrvText ending in a table cell (QA prvtext-cell)", () => {
  // omni-hwp-tables.hwp, table 1's first cell "위 정렬" → "위 정렬 omw칸": 한글 2024 (re-saving the same document)
  // writes a PrvText ending '…\r\n<14><>' (1023 units) — the cell '<부서 14>' that no longer fits is still closed, its
  // text cut to what fits before the '>' (here nothing); the original ends '<14><부서 14>' at exactly 1023
  const TABLES = join(interop, "hancom-made/omni-hwp-tables.hwp");
  it.skipIf(!existsSync(TABLES))("a cell that does not fit is closed: '<14><>', 1023 units", async () => {
    const orig = new Uint8Array(readFileSync(TABLES));
    const was = Buffer.from(cfbStreams(readCfbTree(orig)).get("PrvText")!).toString("utf16le");
    expect(was.length).toBe(1023);
    expect(was.endsWith("\r\n<14><부서 14>")).toBe(true);
    const doc = await open("hwp", orig);
    const cell = collectFlow(doc.pages as Page[])
      .flatMap((it) => (it.kind === "table" ? it.t.rows.flat() : []))
      .find((c) => c.text === "위 정렬")!;
    expect(cell, "the cell '위 정렬'").toBeTruthy();
    cell.text = "위 정렬 omw칸";
    if (cell.richText?.length) cell.richText = [{ ...cell.richText[0], runs: [{ ...cell.richText[0].runs[0], text: "위 정렬 omw칸" }] }];
    const out = await save("hwp", doc);
    const prv = Buffer.from(cfbStreams(readCfbTree(out)).get("PrvText")!).toString("utf16le");
    expect(prv).toContain("<위 정렬 omw칸><가운데 정렬><아래 정렬>");
    expect(prv.endsWith("\r\n<14><>")).toBe(true);
    expect(prv.length).toBe(1023);
    expect(prv.slice(0, -1)).toBe(was.slice(0, was.indexOf("<위 정렬>")) + "<위 정렬 omw칸>" + was.slice(was.indexOf("<위 정렬>") + 6, -6));
    if (process.env.OMW_PRVTEXT_OUT) writeFileSync(process.env.OMW_PRVTEXT_OUT, out);
  });
  // (coordinator, 한글 2024: the same cell "위 정렬" + X typed in 한글 and saved as HWP) the cell's text cut to what fits
  // before its '>'; a cell whose '<' and '>' do not both fit left out
  it.skipIf(!existsSync(TABLES)).each([
    ["a", "매출과 비용>\r\n<14><부서 1>", 1023],
    ["abc", "\r\n<14><부서>", 1023],
    ["abcd", "\r\n<14><부>", 1023],
    ["abcdef", "매출과 비용>\r\n<14>", 1022],
  ])("(한글 2024) '위 정렬%s': ends %j, %i units", async (x, tail, len) => {
    const orig = new Uint8Array(readFileSync(TABLES));
    const doc = await open("hwp", orig);
    const cell = collectFlow(doc.pages as Page[])
      .flatMap((it) => (it.kind === "table" ? it.t.rows.flat() : []))
      .find((c) => c.text === "위 정렬")!;
    cell.text = "위 정렬" + x;
    if (cell.richText?.length) cell.richText = [{ ...cell.richText[0], runs: [{ ...cell.richText[0].runs[0], text: cell.text }] }];
    const prv = Buffer.from(cfbStreams(readCfbTree(await save("hwp", doc))).get("PrvText")!).toString("utf16le");
    expect(prv.length).toBe(len);
    expect(prv.endsWith(tail)).toBe(true);
    expect(prv).toContain(`<위 정렬${x}><가운데 정렬><아래 정렬>`);
    // the whole PrvText 한글 wrote: set OMW_HANCOM_CELL_DIR to a folder of 한글-saved cell_<x>.hwp files
    const dir = process.env.OMW_HANCOM_CELL_DIR;
    const hancom = dir ? `${dir}/cell_${x}.hwp` : "";
    if (hancom && existsSync(hancom)) expect(prv).toBe(Buffer.from(cfbStreams(readCfbTree(new Uint8Array(readFileSync(hancom)))).get("PrvText")!).toString("utf16le"));
  });
});

describe("oleSummary: a title taken from the text", () => {
  it("is the first line up to its first sign, as 한글 takes it", () => {
    expect(lineTitle("한글 시험 문서 / HWP Test Document")).toBe("한글 시험 문서 ");
    expect(lineTitle("오메 3단계 시험 문서 — 글자 옆 컨트롤과 병합 칸")).toBe("오메 3단계 시험 문서 ");
    expect(lineTitle("본문 글자 시험 첫 문단입니다. Text edit test.")).toBe("본문 글자 시험 첫 문단입니다");
    expect(lineTitle("가".repeat(400)).length).toBe(255);
  });
  it("goes only when it was the start of the first line and is not now", () => {
    expect(staleTitle("한글 시험 문서 ", "한글 시험 문서 / HWP", "새 머리 / HWP")).toBe("새 머리 ");
    expect(staleTitle("한글 시험 문서 ", "한글 시험 문서 / HWP", "한글 시험 문서 v2")).toBeUndefined();
    expect(staleTitle("작성자가 쓴 제목", "한글 시험 문서 / HWP", "새 머리")).toBeUndefined();
    expect(staleTitle("", "한글", "새")).toBeUndefined();
  });
  it("(QA 11-18) goes only when it ends where the program would have ended it: at a sign, the line's end or the cut", () => {
    // a title the author wrote that is the start of the first line but stops in the middle of its words stays
    expect(staleTitle("Report", "Report on Q3 sales", "Quarterly report")).toBeUndefined();
    expect(staleTitle("분기 보고서", "분기 보고서 초안 2026", "새 머리")).toBeUndefined();
    expect(staleTitle("Report on Q3", "Report on Q3, draft", "New head")).toBe("New head");
    expect(staleTitle("Report on Q3 ", "Report on Q3", "New head")).toBe("New head");
    expect(staleTitle("가".repeat(255), "가".repeat(400), "나")).toBe("나");
  });
  it("(QA 11-18) cuts at 255 units without halving a letter outside the BMP", () => {
    const t = lineTitle("𠀀".repeat(200));
    expect(t.length).toBe(254);
    expect(/[\ud800-\udbff]$/.test(t)).toBe(false);
  });
  it("drops the picture of the first page (PIDSI_THUMBNAIL) when asked, the other properties kept", () => {
    // a SummaryInformation of three properties: code page 949, title "abc" (VT_LPSTR), a picture (VT_CF)
    const put = (b: Uint8Array, o: number, v: number) => ((b[o] = v & 0xff), (b[o + 1] = (v >> 8) & 0xff), (b[o + 2] = (v >> 16) & 0xff), (b[o + 3] = (v >>> 24) & 0xff));
    const cpv = new Uint8Array(8), title = new Uint8Array(12), pic = new Uint8Array(24);
    put(cpv, 0, 2), put(cpv, 4, 949);
    put(title, 0, 0x1e), put(title, 4, 4), title.set([0x61, 0x62, 0x63], 8);
    put(pic, 0, 0x47), put(pic, 4, 16), pic.fill(0x5a, 8);
    const tableLen = 8 + 3 * 8, size = tableLen + 8 + 12 + 24;
    const si = new Uint8Array(48 + size);
    si[0] = 0xfe, si[1] = 0xff, put(si, 24, 1);
    si.set(Buffer.from("e0859ff2f94f6810ab9108002b27b3d9", "hex"), 28);
    put(si, 44, 48);
    put(si, 48, size), put(si, 52, 3);
    [[1, tableLen], [2, tableLen + 8], [17, tableLen + 20]].forEach(([id, off], i) => (put(si, 56 + i * 8, id), put(si, 60 + i * 8, off)));
    si.set(cpv, 48 + tableLen), si.set(title, 48 + tableLen + 8), si.set(pic, 48 + tableLen + 20);
    expect([...summaryProps(si)!.keys()]).toEqual([1, 2, 17]);
    const got = retitleText({ si }, "abc. def", "xyz", true);
    expect(got.title).toEqual({ was: "abc", now: "xyz" });
    expect([...summaryProps(got.si!)!.keys()]).toEqual([1, 2]);
    expect(summaryText(got.si!, 2)).toBe("xyz");
    expect(eq(summaryProps(got.si!)!.get(1)!, cpv)).toBe(true);
    // (the title kept: only the picture goes)
    const kept = retitleText({ si }, "abc def", "abc ghi", true);
    expect(kept.title).toBeUndefined();
    expect([...summaryProps(kept.si!)!.keys()]).toEqual([1, 2]);
    expect(Buffer.from(kept.si!).indexOf(Buffer.from([0x5a, 0x5a, 0x5a, 0x5a]))).toBe(-1);
  });
  it("leaves streams it does not understand, and an unchanged title, as they are", () => {
    expect(retitleText({ si: new Uint8Array(64) }, "a", "b", true)).toEqual({});
    const si = cfbStreams(readCfbTree(new Uint8Array(readFileSync(SUMMARY_DOC)))).get("\u0005SummaryInformation")!;
    expect(retitleText({ si }, "본문 글자 시험 첫 문단입니다.", "본문 글자 시험 첫 문단입니다. 더", false)).toEqual({});
  });
});
