// DOC same-format save, stage 2 (io/formats/docWrite.ts, legacyWrite.ts docShape / docTextOnly): body text edits —
// letters typed or deleted, paragraphs split, joined, added, removed — are written into the WordDocument stream and
// read back with our reader; the other streams and the old bytes stay; the new letters take the look of the letter
// before them; edits next to fields, notes and pictures are written, edits in them refused; any other edit refused.
// Files: every DOC in qa/interop (adobe-made + omni-legacy-word-*); OMW_LEGACY_FILES=<a.doc>;… adds local files
// (not in the repo, reported as "local #n"). Word itself: qa/interop/scripts/doc_edit.ts → doc_check.ps1.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
// (the DOC open reads its formatting through the DOCX importer, which parses XML: docRich.ts)
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfbStreams, readCfb, readCfbTree, writeCfb } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { docShape, docTextOnly, lastLegacySave, legacySource, legacyUnchanged } from "../src/io/formats/legacyWrite";
import { DocRefused, docProps } from "../src/io/formats/docWrite";
import { summaryProps, summaryText } from "../src/io/formats/oleSummary";
import { deleteChar, deleteRange, insertText, splitParagraph } from "../src/core/richtext";
import type { OmwDocument, TextNode, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";
import { DICTS } from "../src/i18n";

const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.doc$/i.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
const extra = (process.env.OMW_LEGACY_FILES ?? "")
  .split(";")
  .filter((f) => f && /\.doc$/i.test(f) && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const TEXT_DOC = join(ROOT, "qa/interop/word-made/omni-legacy-word-text.doc");
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("doc")!.open({ name: "omw-edit.doc", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const read = (f: string) => new Uint8Array(readFileSync(f));
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
/** the body flow as texts: paragraphs, and tables as their cells */
const flowTexts = (doc: OmwDocument) => collectFlow(doc.pages).map((it) => (it.kind === "p" ? plain(it.p) : it.t.rows.map((r) => r.map((c) => c.text))));
/** body paragraphs (whole ones) with the frame holding each */
const bodyParas = (doc: OmwDocument) =>
  doc.pages.flatMap((pg) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT" && !n.notes).flatMap((n) => n.paragraphs.flatMap((p, i) => (p.flowSplit || p.flowCont ? [] : [{ n, i, text: plain(p) }]))));
const find = (doc: OmwDocument, want: (t: string, i: number, n: TextNode) => boolean) => bodyParas(doc).find((b) => want(b.text, b.i, b.n));
/** a body text paragraph (not a heading or a list item: the editor's Enter after a heading makes body text, a list's
 *  first letters go before its number — the file's styles do neither, so such edits are refused since the open reads
 *  the formatting, 2026-11-17) */
const body = (n: TextNode, i: number) => !!n.paragraphs[i] && !n.paragraphs[i].role && !n.paragraphs[i].list;
/** (doc-pic-para) the paragraphs i − 1 … i + 1 of a frame hold no picture: these tests edit the frames themselves, not
 *  through the body flow (core/flow.ts reflowSegment), which moves a picture with its text when paragraphs split or
 *  join — tests/docPicPara.test.ts edits those as the editor does */
const noPics = (d: OmwDocument, n: TextNode, i: number) => {
  const held = new Set(d.pages.flatMap((pg) => pg.nodes.flatMap((x) => (x.type === "IMAGE" && x.place?.para ? [x.place.para] : []))));
  return [i - 1, i, i + 1].every((k) => !n.paragraphs[k] || !held.has(n.paragraphs[k].id));
};
/** two paragraphs of the same look one after the other (joined, the second one's letters keep theirs) */
const alike = (n: TextNode, i: number) => {
  const look = (p: TextParagraph) => JSON.stringify({ ...p, id: "", runs: [], lineSpacing: 0, lineMultiple: p.lineMultiple?.v });
  return body(n, i) && body(n, i + 1) && look(n.paragraphs[i]) === look(n.paragraphs[i + 1]) && n.paragraphs[i].runs[0]?.fontSize === n.paragraphs[i + 1].runs[0]?.fontSize;
};

/** FIB end: FibBase … FibRgFcLcb, then cswNew and its words */
function fibEnd(wd: Uint8Array) {
  const u16 = (o: number) => wd[o] | (wd[o + 1] << 8);
  const csw = u16(0x20), lw = 0x22 + csw * 2 + 2, cslw = u16(0x22 + csw * 2), pairsAt = lw + cslw * 4, pairs = u16(pairsAt);
  const after = pairsAt + 2 + pairs * 8;
  return after + 2 + u16(after) * 2;
}
/** the main-document CP tables the writer moves in place: [fc, lcb] in the table stream (docWrite.ts MOVED) */
function movedRanges(wd: Uint8Array) {
  const u32 = (o: number) => (wd[o] | (wd[o + 1] << 8) | (wd[o + 2] << 16)) + wd[o + 3] * 0x1000000;
  return [2, 4, 6, 16, 22, 23, 40, 42, 43, 46].map((i) => [u32(154 + i * 8), u32(154 + i * 8 + 4)]).filter(([, l]) => l);
}
/** SttbfAssoc: [fc, lcb] in the table stream */
function assocRange(wd: Uint8Array) {
  const u32 = (o: number) => (wd[o] | (wd[o + 1] << 8) | (wd[o + 2] << 16)) + wd[o + 3] * 0x1000000;
  return [u32(154 + 32 * 8), u32(154 + 32 * 8 + 4)];
}

/** Edit, save, read back: the text is the one edited, every other stream and the old bytes are the original's. */
async function roundTrip(file: string, edit: (doc: OmwDocument) => boolean) {
  const bytes = read(file);
  const doc = await open(bytes);
  if (!edit(doc)) return null;
  expect(legacyUnchanged(doc.pages, "doc")).toBe(false);
  expect(docTextOnly(doc.pages)).toBe(true);
  const out = await save(doc);
  expect(lastLegacySave.doc).toBe("text");
  expect(eq(out, bytes)).toBe(false);
  // read back: the same paragraphs and tables
  const back = await open(out);
  expect(flowTexts(back)).toEqual(flowTexts(doc));
  expect(legacySource(back.pages, "doc")?.legacy).toBeTruthy(); // a DOC it keeps again
  // the other streams byte for byte; WordDocument and the table stream: the old bytes (but the FIB and the CP tables
  // moved in place) — what is new is after them
  const a = cfbStreams(readCfbTree(bytes)), b = cfbStreams(readCfbTree(out));
  expect([...b.keys()]).toEqual([...a.keys()]);
  const wdA = a.get("WordDocument")!, wdB = b.get("WordDocument")!;
  const tableName = wdA[0x0b] & 0x02 ? "1Table" : "0Table";
  for (const [k, v] of a) {
    if (k === "WordDocument") {
      const from = fibEnd(v);
      // (but the deleted characters' bytes, cleared — QA doc-write2)
      let same = true;
      for (let i = from; i < v.length; i++) if (wdB[i] !== v[i] && wdB[i] !== 0) same = false;
      expect(same, "WordDocument after the FIB").toBe(true);
    } else if (k === tableName) {
      const moved = movedRanges(wdA);
      // (QA doc-summary: SttbfAssoc's copy of a title taken from the first line goes with the summary's)
      const siA = a.get("\x05SummaryInformation"), siB = b.get("\x05SummaryInformation");
      if (siA && siB && summaryText(siA, 2) !== summaryText(siB, 2)) moved.push(assocRange(wdA));
      const tb = b.get(k)!;
      let same = true;
      for (let i = 0; i < v.length; i++) if (v[i] !== tb[i] && !moved.some(([fc, l]) => i >= fc && i < fc + l)) same = false;
      expect(same, `${k}: only the moved CP tables differ`).toBe(true);
    } else if (/^\x05(Document)?SummaryInformation$/.test(k) && !eq(b.get(k)!, v)) {
      // (QA doc-summary) a title taken from the first line goes with it (PIDSI_TITLE, the parts that list it): every
      // other property's bytes the same
      const pa = summaryProps(v)!, pb = summaryProps(b.get(k)!)!;
      const may = k.includes("Document") ? [13] : [2];
      expect([...pb.keys()].filter((id) => !may.includes(id))).toEqual([...pa.keys()].filter((id) => !may.includes(id)));
      for (const [id, x] of pa) if (!may.includes(id)) expect(eq(pb.get(id)!, x), `${k} ${id}`).toBe(true);
      if (!k.includes("Document")) expect(summaryText(v, 2)?.trim()).toBeTruthy();
    } else expect(eq(b.get(k)!, v), k).toBe(true);
  }
  return { bytes, doc, out, back };
}

const typeAt = (doc: OmwDocument, want: (t: string) => boolean, o: (t: string) => number, ins: string) => {
  const b = find(doc, want);
  if (!b) return false;
  b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: o(b.text) }, ins).paras;
  return true;
};

describe.each(files.map((f) => [label(f), f]))("text edits written: %s", (_name, file) => {
  it("letters typed in the middle of a paragraph (Korean, emoji)", async () => {
    const r = await roundTrip(file, (d) => typeAt(d, (t) => t.length >= 6, (t) => Math.floor(t.length / 2), "가나다 omw 😀"));
    expect(r).not.toBeNull();
  });
  it("letters typed at a paragraph's start and end", async () => {
    await roundTrip(file, (d) => typeAt(d, (t) => t.length >= 2, () => 0, "앞omw") && typeAt(d, (t) => t.length >= 2 && !t.startsWith("앞omw"), (t) => t.length, "omw뒤"));
  });
  it("letters deleted", async () => {
    await roundTrip(file, (d) => {
      const b = find(d, (t) => t.length >= 8);
      if (!b) return false;
      b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: 2 }, end: { p: b.i, o: 5 } }).paras;
      return true;
    });
  });
  it("a paragraph's text deleted (the paragraph left empty)", async () => {
    await roundTrip(file, (d) => {
      const b = find(d, (t) => t.length >= 3);
      if (!b) return false;
      b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: 0 }, end: { p: b.i, o: b.text.length } }).paras;
      return true;
    });
  });
  it("Enter at a paragraph's end and a new paragraph typed; Enter in the middle", async () => {
    await roundTrip(file, (d) => {
      const b = find(d, (t, i, n) => t.length >= 4 && i + 1 < n.paragraphs.length && body(n, i) && noPics(d, n, i));
      if (!b) return false;
      let r = splitParagraph(b.n.paragraphs, { p: b.i, o: b.text.length });
      r = insertText(r.paras, r.pos, "새 문단 omw");
      b.n.paragraphs = r.paras;
      // (not the paragraph right after the new one: two edits that meet are one run of changed letters, and where the
      // diff puts the new paragraph's letters there may give them the next paragraph's look — refused, sameLooks)
      const near = (n: TextNode, i: number) => n === b.n && Math.abs(i - b.i) <= 2;
      const c = find(d, (t, i, n) => t.length >= 10 && t !== "새 문단 omw" && t !== b.text && body(n, i) && !near(n, i) && noPics(d, n, i));
      if (c) c.n.paragraphs = splitParagraph(c.n.paragraphs, { p: c.i, o: 5 }).paras;
      return true;
    });
  });
  it("two paragraphs joined; a paragraph removed", async () => {
    await roundTrip(file, (d) => {
      const b = find(d, (t, i, n) => t.length >= 2 && i + 1 < n.paragraphs.length && plain(n.paragraphs[i + 1]).length >= 2 && alike(n, i) && noPics(d, n, i + 1));
      if (!b) return false;
      b.n.paragraphs = deleteChar(b.n.paragraphs, { p: b.i + 1, o: 0 }, -1).paras;
      // (a paragraph whose characters are all letters in the file: one with a field or a note mark is refused, below)
      const raw = docProps(read(file)).text;
      const c = find(d, (t, i, n) => i >= 1 && i + 1 < n.paragraphs.length && t.length >= 2 && !t.includes(b.text) && raw.includes(`\r${t}\r`) && body(n, i - 1) && noPics(d, n, i));
      if (c) c.n.paragraphs = deleteRange(c.n.paragraphs, { start: { p: c.i - 1, o: plain(c.n.paragraphs[c.i - 1]).length }, end: { p: c.i, o: c.text.length } }).paras;
      return true;
    });
  });
  it("saved again after a second edit (the pieces of the first save cut again)", async () => {
    const first = await roundTrip(file, (d) => typeAt(d, (t) => t.length >= 6, () => 3, "첫째"));
    if (!first) return;
    const doc = await open(first.out);
    expect(typeAt(doc, (t) => t.includes("첫째"), (t) => t.indexOf("첫째") + 2, "둘째")).toBe(true);
    const out = await save(doc);
    expect(flowTexts(await open(out))).toEqual(flowTexts(doc));
    // and the same text typed back to the original: as opened again
    const back = await open(out);
    const p = find(back, (t) => t.includes("첫째둘째"))!;
    p.n.paragraphs = deleteRange(p.n.paragraphs, { start: { p: p.i, o: p.text.indexOf("첫째둘째") }, end: { p: p.i, o: p.text.indexOf("첫째둘째") + 4 } }).paras;
    expect(flowTexts(await open(await save(back)))).toEqual(flowTexts(await open(first.bytes)));
  });
  it("new letters take the character format of the letter before them, new marks the paragraph's", async () => {
    const bytes = read(file);
    const doc = await open(bytes);
    const b = find(doc, (t, i, n) => t.length >= 6 && i + 1 < n.paragraphs.length && body(n, i));
    if (!b) return;
    const o = 3;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o }, "omw").paras;
    let r = splitParagraph(b.n.paragraphs, { p: b.i, o: b.text.length + 3 });
    r = insertText(r.paras, r.pos, "새줄");
    b.n.paragraphs = r.paras;
    const out = await save(doc);
    const was = docProps(bytes), now = docProps(out);
    const at = now.text.indexOf("omw"), line = now.text.indexOf("새줄");
    const wasAt = was.text.indexOf(b.text);
    expect(at).toBeGreaterThan(0);
    expect(Array.from(now.chpx(at)!)).toEqual(Array.from(now.chpx(at - 1)!));
    expect(Array.from(now.chpx(at - 1)!)).toEqual(Array.from(was.chpx(wasAt + o - 1)!));
    // the new paragraph and the one it was cut from: their own marks, the paragraph's properties
    const cut = now.para(at)!, made = now.para(line)!;
    expect(now.text[cut.mark]).toBe("\r");
    expect(cut.mark).toBe(line - 1);
    expect(now.text[made.mark]).toBe("\r");
    expect(made.mark).toBe(line + 2);
    const orig = was.para(wasAt)!;
    expect(Array.from(made.papx ?? [])).toEqual(Array.from(orig.papx ?? []));
    expect(Array.from(cut.papx ?? [])).toEqual(Array.from(orig.papx ?? []));
    // the letters typed: the paragraph goes on past them (not cut at the end of their piece)
    expect(now.para(at)!.mark).toBe(cut.mark);
  });
});

describe("edits next to special characters (omni-legacy-word-text.doc)", () => {
  const hasDoc = existsSync(TEXT_DOC);
  const edited = async (find0: string, ins: string | null, after = true) => {
    const doc = await open(read(TEXT_DOC));
    const b = find(doc, (t) => t.includes(find0))!;
    const k = b.text.indexOf(find0);
    if (ins === null) b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: k }, end: { p: b.i, o: k + find0.length } }).paras;
    else b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: after ? k + find0.length : k }, ins).paras;
    return doc;
  };
  const written = async (doc: OmwDocument) => {
    const out = await save(doc);
    expect(flowTexts(await open(out))).toEqual(flowTexts(doc));
    return docProps(out);
  };
  it.runIf(hasDoc)("after a hyperlink field: written after the field's end", async () => {
    const p = await written(await edited("예시 링크", "⊕"));
    const k = p.text.indexOf("⊕");
    expect(p.text.charCodeAt(k - 1)).toBe(0x15); // the field end right before
  });
  it.runIf(hasDoc)("before a footnote mark, next to a picture, inside a comment's range, after a table", async () => {
    let p = await written(await edited("붙는 문장", "¶"));
    expect(p.text.charCodeAt(p.text.indexOf("¶") + 1)).toBe(0x02);
    p = await written(await edited("그림 앞 글 ", "◆"));
    expect(p.text.charCodeAt(p.text.indexOf("◆") + 1)).toBe(0x01);
    await written(await edited("글 여기", "★", false));
    await written(await edited("표 뒤 문단", "표뒤", false));
  });
  it.runIf(hasDoc)("paragraphs of two styles joined: refused when the file would show them otherwise (2026-11-17: the open reads the styles)", async () => {
    const bytes = read(TEXT_DOC);
    const was = docProps(bytes);
    const heading = was.para(was.text.indexOf("제목 1 스타일"))!, bullet = was.para(was.text.indexOf("글머리표 하나"))!;
    expect(Array.from(heading.papx ?? [])).not.toEqual(Array.from(bullet.papx ?? []));
    // (the joined paragraph keeps the heading's properties, as in Word — and so its style: the bullet's letters would
    // take the heading's look in the file, not the one the pages show, and the list's number would be letters)
    for (const typed of ["", "끝"]) {
      const doc = await open(bytes);
      const b = find(doc, (t) => t === "제목 1 스타일 문단")!;
      let r = deleteChar(b.n.paragraphs, { p: b.i + 1, o: 0 }, -1);
      if (typed) r = insertText(r.paras, { p: b.i, o: plain(r.paras[b.i]).length }, typed);
      b.n.paragraphs = r.paras;
      await expect(save(doc)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
    }
  });
  it.runIf(hasDoc)("across a note mark, across a field's end: refused (inside a field's result: written — doc-write3)", async () => {
    await written(await edited("예시", "✓"));
    // (a note's reference is a run of its own since 2026-11-17: deleted with the letters around it, the note goes —
    // not a text edit)
    await expect(save(await edited("장1 그", null))).rejects.toThrow();
    const err = await save(await edited("링크 링크", null)).catch((e) => e);
    expect(err).toBeInstanceOf(DocRefused);
    expect((err as DocRefused).why).toBe("special");
  });
  it.runIf(hasDoc)("the CP tables move with the text: fields, notes, comments, sections, bookmarks", async () => {
    const bytes = read(TEXT_DOC);
    const doc = await open(bytes);
    const b = find(doc, (t) => t.startsWith("본문 글자"))!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "12345").paras;
    const out = await save(doc);
    const wdA = readCfb(bytes).get("WordDocument")!, wdB = readCfb(out).get("WordDocument")!;
    const tA = readCfb(bytes).get("1Table")!, tB = readCfb(out).get("1Table")!;
    const u32 = (x: Uint8Array, o: number) => (x[o] | (x[o + 1] << 8) | (x[o + 2] << 16)) + x[o + 3] * 0x1000000;
    // pair → bytes of data per entry (docWrite.ts MOVED)
    const CB: Record<number, number> = { 2: 2, 4: 30, 6: 12, 16: 2, 22: 4, 23: 0, 40: 26, 42: 4, 43: 0, 46: 2 };
    let tables = 0;
    for (const [i, cb] of Object.entries(CB).map(([k, v]) => [Number(k), v])) {
      const fc = u32(wdA, 154 + i * 8), lcb = u32(wdA, 154 + i * 8 + 4);
      if (!lcb) continue;
      tables++;
      expect([u32(wdB, 154 + i * 8), u32(wdB, 154 + i * 8 + 4)]).toEqual([fc, lcb]);
      const n = (lcb - 4) / (4 + cb);
      // every CP moved by the 5 letters typed at CP 0 — but the first section's start (the text is in it) — the data as it was
      for (let k = 0; k <= n; k++) expect(u32(tB, fc + k * 4), `pair ${i} entry ${k}`).toBe(i === 6 && k === 0 ? 0 : u32(tA, fc + k * 4) + 5);
      expect(eq(tB.subarray(fc + (n + 1) * 4, fc + lcb), tA.subarray(fc + (n + 1) * 4, fc + lcb))).toBe(true);
    }
    expect(tables).toBeGreaterThanOrEqual(6); // notes, comments, sections, fields, comment ranges in this file
    const ccp = (wd: Uint8Array) => u32(wd, 0x4c);
    expect(ccp(wdB)).toBe(ccp(wdA) + 5);
  });
});

// QA doc-write2 (2026-11-17): omni-legacy-word-stories.doc (legacy_doc_stories_make.ps1) — Latin text only, so Word
// stored it as one 8-bit piece; bookmarks (one over a word, one empty), a comment's range, and stories after the body
// (footnote, endnote, comment, text box, header). Where text typed at a bookmark's or comment range's edge goes was
// measured in Word (Selection.TypeText at the edge; qa/interop/scripts/doc_stories_check.ps1 checks the saved files).
describe("QA: bookmark and comment range edges, stories after the body, 8-bit and 16-bit pieces", () => {
  const STORIES = join(ROOT, "qa/interop/word-made/omni-legacy-word-stories.doc");
  const has = existsSync(STORIES);
  const u32 = (x: Uint8Array, o: number) => (x[o] | (x[o + 1] << 8) | (x[o + 2] << 16)) + x[o + 3] * 0x1000000;
  /** the CPs of the PLC at FIB pair `i` (all but the last) */
  const plc = (file: Uint8Array, i: number, cb: number) => {
    const s = readCfb(file), wd = s.get("WordDocument")!, tb = s.get(wd[0x0b] & 0x02 ? "1Table" : "0Table")!;
    const fc = u32(wd, 154 + i * 8), lcb = u32(wd, 154 + i * 8 + 4);
    return Array.from({ length: (lcb - 4) / (4 + cb) }, (_, k) => u32(tb, fc + k * 4));
  };
  /** every story's text by CP through the piece table (body, footnotes, headers, comments, endnotes, text boxes) */
  const allText = (file: Uint8Array) => {
    const s = readCfb(file), wd = s.get("WordDocument")!, tb = s.get(wd[0x0b] & 0x02 ? "1Table" : "0Table")!;
    let o = u32(wd, 154 + 33 * 8);
    while (tb[o] === 1) o += 3 + (tb[o + 1] | (tb[o + 2] << 8));
    const lcb = u32(tb, o + 1), at = o + 5, n = (lcb - 4) / 12;
    let text = "";
    for (let i = 0; i < n; i++) {
      const cp = u32(tb, at + i * 4), end = u32(tb, at + (i + 1) * 4), fc = u32(tb, at + (n + 1) * 4 + i * 8 + 2);
      for (let k = 0; k < end - cp; k++) text += fc & 0x40000000 ? String.fromCharCode(wd[(fc & 0x3fffffff) / 2 + k]) : String.fromCharCode(wd[fc + k * 2] | (wd[fc + k * 2 + 1] << 8));
    }
    const ccp = u32(wd, 0x4c);
    return { body: text.slice(0, ccp), rest: text.slice(ccp), ccp: [0x4c, 0x50, 0x54, 0x5c, 0x60, 0x64].map((k) => u32(wd, k)) };
  };
  const typed = async (find0: string, ins: string, after: boolean) => {
    const bytes = read(STORIES);
    const doc = await open(bytes);
    const b = find(doc, (t) => t.includes(find0))!;
    const k = b.text.indexOf(find0);
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: after ? k + find0.length : k }, ins).paras;
    const out = await save(doc);
    expect(flowTexts(await open(out))).toEqual(flowTexts(doc));
    return { bytes, out };
  };
  it.runIf(has)("text typed at a bookmark's start is in it, at its end is not, at an empty one after it (as Word)", async () => {
    const body = docProps(read(STORIES)).text;
    const word = body.indexOf("MARKED"), empty = body.indexOf("here.");
    expect([plc(read(STORIES), 22, 4), plc(read(STORIES), 23, 0)]).toEqual([[word, empty], [word + 6, empty]]);
    let r = await typed("MARKED", "QQ", false);
    expect([plc(r.out, 22, 4), plc(r.out, 23, 0)]).toEqual([[word, empty + 2], [word + 8, empty + 2]]);
    r = await typed("MARKED", "QQ", true);
    expect([plc(r.out, 22, 4), plc(r.out, 23, 0)]).toEqual([[word, empty + 2], [word + 6, empty + 2]]);
    r = await typed("here.", "QQ", false);
    expect([plc(r.out, 22, 4), plc(r.out, 23, 0)]).toEqual([[word, empty], [word + 6, empty]]);
  });
  it.runIf(has)("text typed at a comment range's start or end is not in it (as Word)", async () => {
    const body = docProps(read(STORIES)).text;
    const at = body.indexOf("this\u0005 end."), ref = at + 4;
    expect([plc(read(STORIES), 42, 4), plc(read(STORIES), 43, 0)]).toEqual([[at], [ref]]);
    let r = await typed("this end.", "QQ", false);
    expect([plc(r.out, 42, 4), plc(r.out, 43, 0)]).toEqual([[at + 2], [ref + 2]]);
    // (after "this": right before the comment's reference mark — the range ends before the typed text)
    r = await typed("this", "QQ", true);
    expect(docProps(r.out).text.slice(ref, ref + 3)).toBe("QQ\u0005");
    expect([plc(r.out, 42, 4), plc(r.out, 43, 0)]).toEqual([[at], [ref]]);
  });
  it.runIf(has)("the stories after the body stay as they were; Korean typed into an 8-bit piece", async () => {
    const r = await typed("Alpha beta", "한글 글자 ", false);
    const a = allText(r.bytes), b = allText(r.out);
    expect(b.rest).toBe(a.rest);
    expect(b.ccp.slice(1)).toEqual(a.ccp.slice(1));
    expect(b.ccp[0]).toBe(a.ccp[0] + 6);
    expect(b.body).toBe(a.body.replace("Alpha beta", "한글 글자 Alpha beta"));
    expect(docProps(r.out).pieces).toBe(3);
  });
  it.runIf(has)("deleted text does not stay in the file (8-bit and 16-bit pieces, and the pieces of a save before)", async () => {
    const bytesOf = (s: string, wide: boolean) => Buffer.from(s, wide ? "utf16le" : "latin1");
    const inWd = (file: Uint8Array, s: string, wide: boolean) => Buffer.from(readCfb(file).get("WordDocument")!).indexOf(bytesOf(s, wide)) >= 0;
    const cut = async (bytes: Uint8Array, word: string) => {
      const doc = await open(bytes);
      const b = find(doc, (t) => t.includes(word))!;
      const k = b.text.indexOf(word);
      b.n.paragraphs = deleteRange(b.n.paragraphs, { start: { p: b.i, o: k }, end: { p: b.i, o: k + word.length } }).paras;
      const out = await save(doc);
      expect(flowTexts(await open(out))).toEqual(flowTexts(doc));
      return out;
    };
    const stories = read(STORIES);
    expect(inWd(stories, "Alpha beta", false)).toBe(true);
    expect(inWd(await cut(stories, "Alpha beta"), "Alpha beta", false)).toBe(false);
    const text = read(TEXT_DOC);
    expect(inWd(text, "첫 문단", true)).toBe(true);
    expect(inWd(await cut(text, "첫 문단"), "첫 문단", true)).toBe(false);
    // typed in one save, deleted in the next: gone too
    const doc = await open(stories);
    expect(typeAt(doc, (t) => t.includes("Alpha"), (t) => t.indexOf("Alpha"), "비밀 Secret ")).toBe(true);
    const once = await save(doc);
    expect(inWd(once, "비밀 Secret", true)).toBe(true);
    expect(inWd(await cut(once, "비밀 Secret"), "비밀 Secret", true)).toBe(false);
  });
  it.runIf(has)("8-bit text: every Windows-1252 letter of 0x80–0x9F read as Word shows it (Œ Š ‰ Ÿ …), kept on save", async () => {
    // (Word stores Œuvre, Š, ‰, Ÿ in an 8-bit piece as 0x8C 0x8A 0x89 0x9F — measured: Word 16 SaveAs2 .doc)
    const tree = readCfbTree(read(STORIES));
    const wd = tree.root.kids!.find((k) => k.name === "WordDocument")!;
    wd.data = wd.data!.slice();
    const at = Buffer.from(wd.data).indexOf(Buffer.from("Alpha beta gamma", "latin1"));
    wd.data.set([0x8c, 0x8a, 0x89, 0x9f, 0x83, 0x86, 0x87, 0x88, 0x8b, 0x8e, 0x98, 0x9a, 0x9b, 0x9c, 0x9e, 0x20], at);
    const bytes = writeCfb(tree);
    const want = "ŒŠ‰Ÿƒ†‡ˆ‹Ž˜š›œž ";
    const doc = await open(bytes);
    expect(find(doc, (t) => t.includes(want))).toBeTruthy();
    expect(typeAt(doc, (t) => t.includes(want), (t) => t.indexOf(want), "€")).toBe(true);
    const out = await save(doc);
    expect(flowTexts(await open(out))).toEqual(flowTexts(doc));
    expect(docProps(out).text).toContain("€" + want);
  });
  it("a password-protected DOC (FIB fEncrypted): no DOC save after a text edit, and the writer refuses it", async () => {
    const tree = readCfbTree(read(TEXT_DOC));
    const wd = tree.root.kids!.find((k) => k.name === "WordDocument")!;
    wd.data = wd.data!.slice();
    wd.data[0x0b] |= 0x01;
    const bytes = writeCfb(tree);
    let doc: OmwDocument | null = null;
    try {
      doc = await open(bytes);
    } catch {
      doc = null; // refused outright is fine too
    }
    if (doc) {
      typeAt(doc, (t) => t.length >= 4, () => 1, "x");
      expect(legacySource(doc.pages, "doc")).toBeUndefined(); // (the export menu offers DOC only with it)
      expect(docTextOnly(doc.pages)).toBe(false);
      await expect(save(doc)).rejects.toThrow();
    }
    const { saveDocText } = await import("../src/io/formats/docWrite");
    const err = (() => {
      try {
        saveDocText([], bytes, { name: "x.doc", fp: "" });
      } catch (e) {
        return e;
      }
    })();
    expect((err as DocRefused).why).toBe("layout");
  });
});

describe("what a text edit is (docShape) and what is refused", () => {
  const file = repoFiles.find((f) => /omni-legacy-word-table/.test(f)) ?? repoFiles[0];
  it("the shape is kept at open; text edits keep it, formats change it", async () => {
    const doc = await open(read(file));
    const l = legacySource(doc.pages, "doc")!.legacy!;
    expect(l.shape).toBe(docShape(doc.pages));
    const b = find(doc, (t) => t.length >= 4)!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 1 }, "x").paras;
    expect(docShape(doc.pages)).toBe(l.shape);
    const r = splitParagraph(b.n.paragraphs, { p: b.i, o: 2 });
    b.n.paragraphs = r.paras;
    expect(docShape(doc.pages)).toBe(l.shape);
    b.n.paragraphs = deleteChar(b.n.paragraphs, r.pos, -1).paras;
    expect(docShape(doc.pages)).toBe(l.shape);
    b.n.paragraphs[b.i] = { ...b.n.paragraphs[b.i], runs: b.n.paragraphs[b.i].runs.map((x) => ({ ...x, bold: true })) };
    // (2026-11-17: the shape leaves the paragraphs' and letters' looks out — the save checks them against the file it
    // writes, and refuses a format changed as before)
    await expect(save(doc)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
  });
  it("text and a format changed together: refused (save as DOCX)", async () => {
    const doc = await open(read(file));
    const b = find(doc, (t) => t.length >= 4)!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 1 }, "x").paras;
    b.n.paragraphs[b.i] = { ...b.n.paragraphs[b.i], align: "CENTER" };
    await expect(save(doc)).rejects.toThrow(DICTS.ko["legacysave.err.edited.doc"].slice(0, 10));
  });
  it("a table cell's text: a text edit (doc-write3); a row added: refused", async () => {
    let doc = await open(read(file));
    let t = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE") as any;
    expect(t).toBeTruthy();
    t.rows[0][0] = { ...t.rows[0][0], text: t.rows[0][0].text + "omw" };
    expect(docTextOnly(doc.pages)).toBe(true);
    expect(flowTexts(await open(await save(doc)))).toEqual(flowTexts(doc));
    doc = await open(read(file));
    t = doc.pages.flatMap((p) => p.nodes).find((n) => n.type === "TABLE") as any;
    t.rows = [...t.rows, t.rows[t.rows.length - 1].map((c: any) => ({ ...c, text: "" }))];
    expect(docTextOnly(doc.pages)).toBe(false);
    await expect(save(doc)).rejects.toThrow();
  });
  it("a control character typed: refused", async () => {
    const doc = await open(read(file));
    const b = find(doc, (t) => t.length >= 4)!;
    b.n.paragraphs[b.i] = { ...b.n.paragraphs[b.i], runs: b.n.paragraphs[b.i].runs.map((x, i) => (i ? x : { ...x, text: x.text + "\u0007" })) };
    const err = await save(doc).catch((e) => e);
    expect((err as DocRefused).why).toBe("chars");
  });
  it("a file with a CP table this save does not know: refused", async () => {
    const bytes = read(file);
    const tree = readCfbTree(bytes);
    const wd = tree.root.kids!.find((k) => k.name === "WordDocument")!;
    wd.data = wd.data!.slice();
    // FibRgFcLcb97 PlcPad (pair 7, the outline's paragraph descriptors): 8 bytes at the start of the table stream
    wd.data.set([0, 0, 0, 0, 8, 0, 0, 0], 154 + 7 * 8);
    const doc = await open(writeCfb(tree));
    expect(typeAt(doc, (t) => t.length >= 4, () => 1, "x")).toBe(true);
    const err = await save(doc).catch((e) => e);
    expect((err as DocRefused).why).toBe("layout");
  });
  it("text typed and deleted back: the original file", async () => {
    const bytes = read(file);
    const doc = await open(bytes);
    const b = find(doc, (t) => t.length >= 4)!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 1 }, "x").paras;
    b.n.paragraphs = deleteChar(b.n.paragraphs, { p: b.i, o: 2 }, -1).paras;
    expect(eq(await save(doc), bytes)).toBe(true);
  });
  it("the messages are there in every language", () => {
    for (const lang of ["ko", "en", "zh", "ja"] as const)
      for (const k of ["savedText.doc", "err.docText", "docWhy.reader", "docWhy.layout", "docWhy.special", "docWhy.chars", "docWhy.verify"]) expect(DICTS[lang][`legacysave.${k}`], `${lang} ${k}`).toBeTruthy();
  });
});
