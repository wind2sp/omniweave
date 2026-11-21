// PPT same-format save, stage 2 (io/formats/pptWrite.ts, legacyWrite.ts pptShape / pptTextOnly): slide text and
// speaker notes edits — letters typed or deleted, paragraphs split, joined, added, removed inside a text box — are
// written into the PowerPoint Document stream and read back with our reader; the other streams stay byte for byte, the
// Current User stream but its offsetToCurrentEdit; the deleted text is gone from the stream; new letters take the runs
// of the letter before them; edits across text boxes, notes where the slide has no notes box … refused.
// Files: every PPT in qa/interop (adobe-made + omni-legacy-ppt-*); OMW_LEGACY_FILES=<a.ppt>;… adds local files (not in
// the repo, reported as "local #n"). PowerPoint itself: qa/interop/scripts/ppt_edit.ts → ppt_check.ps1.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cfbStreams, readCfb, readCfbTree, writeCfb } from "../src/io/formats/cfb";
import { exportById, formatForExt } from "../src/io/formats";
import { lastLegacySave, legacySource, legacyUnchanged, pptShape, pptTextOnly } from "../src/io/formats/legacyWrite";
import { pptBoxes, savePptText } from "../src/io/formats/pptWrite";
import { pptPersist, pptText } from "../src/io/formats/legacy";
import { deleteChar, deleteRange, insertText, splitParagraph } from "../src/core/richtext";
import type { OmwDocument, Page, TextNode, TextParagraph } from "../src/core/types";
import { collectFlow } from "../src/io/office";
import { t } from "../src/i18n";

const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.(ppt|pps)$/i.test(f) ? [join(d, f)] : []));
// (omni-legacy-ppt-date: its boxes are date fields and a list without its list context here — tests/pptRich.test.ts saves it)
const repoFiles = (existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : []).filter((f) => !/omni-legacy-ppt-date/.test(f));
const extra = (process.env.OMW_LEGACY_FILES ?? "")
  .split(";")
  .filter((f) => f && /\.(ppt|pps)$/i.test(f) && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const DECK = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-deck.ppt");
const SHAPES = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-shapes.ppt");
const TEXT = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-text.ppt");
/** paragraphs of text boxes whose records hold character positions (omni-legacy-ppt-text: a hyperlink, a slide number) */
const LOCKED = new Set(["첫 줄에 링크 Omniweave 있음", "둘째 줄", "슬라이드 번호: #*"]);
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt("ppt")!.open({ name: "omw-edit.ppt", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const read = (f: string) => new Uint8Array(readFileSync(f));
const save = async (doc: OmwDocument) => (await exportById("ppt")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const plain = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
/** the slides as their pages show them: each slide's paragraphs and notes */
function slides(doc: OmwDocument) {
  const out: { paras: string[]; notes: string }[] = [];
  const groups: Page[][] = [];
  for (const p of doc.pages) if (p.breakBefore === "flow" && groups.length) groups[groups.length - 1].push(p);
  else groups.push([p]);
  for (const g of groups) out.push({ paras: collectFlow(g).map((it) => (it.kind === "p" ? plain(it.p) : "")), notes: g[0].notes ?? "" });
  return out;
}
/** slide paragraphs with their text box node */
const paras = (doc: OmwDocument) =>
  doc.pages.flatMap((pg, s) => pg.nodes.filter((n): n is TextNode => n.type === "TEXT").flatMap((n) => n.paragraphs.map((p, i) => ({ s, n, i, text: plain(p) })))).filter((b) => !LOCKED.has(b.text));
const find = (doc: OmwDocument, text: string) => paras(doc).find((b) => b.text === text || b.text.includes(text));
const u16le = (s: string) => Buffer.from(s, "utf16le");
const SUMMARIES = ["\u0005SummaryInformation", "\u0005DocumentSummaryInformation"];
/**
 * A property set stream read on its own (not with oleSummary.ts): each section's property id → its value as hex, the
 * value's own bytes only (a string to its NUL, a vector of strings to its last item — Office writes no padding in them).
 */
function propSet(s: Uint8Array): Map<number, string>[] {
  const d = Buffer.from(s);
  const out: Map<number, string>[] = [];
  for (let k = 0; k < d.readUInt32LE(24); k++) {
    const sec = d.readUInt32LE(28 + k * 20 + 16), n = d.readUInt32LE(sec + 4);
    const m = new Map<number, string>();
    for (let i = 0; i < n; i++) {
      const o = sec + d.readUInt32LE(sec + 12 + i * 8), type = d.readUInt32LE(o);
      let end = o + 8;
      if (type === 0x1e) end = o + 8 + d.readUInt32LE(o + 4);
      else if (type === 0x47 || type === 0x41) end = o + 8 + d.readUInt32LE(o + 4);
      else if (type === 0x101e || type === 0x100c) {
        end = o + 8;
        for (let j = 0; j < d.readUInt32LE(o + 4); j++) {
          const t = type === 0x100c ? d.readUInt32LE(end) : 0x1e;
          if (type === 0x100c) end += 4;
          end += t === 3 ? 4 : 4 + d.readUInt32LE(end);
        }
      }
      m.set(d.readUInt32LE(sec + 8 + i * 8), d.subarray(o, end).toString("hex"));
    }
    out.push(m);
  }
  return out;
}
/** the strings of a summary property (VT_LPSTR, a vector of them, a HEADINGPAIR's) in the code page of the section */
function summaryText(s: Uint8Array, id: number): (string | number)[] | undefined {
  const d = Buffer.from(s), sec = d.readUInt32LE(28 + 16), n = d.readUInt32LE(sec + 4);
  let cp = 1252;
  const at = (want: number) => {
    for (let i = 0; i < n; i++) if (d.readUInt32LE(sec + 8 + i * 8) === want) return sec + d.readUInt32LE(sec + 12 + i * 8);
    return -1;
  };
  if (at(1) >= 0) cp = d.readUInt16LE(at(1) + 4);
  const dec = new TextDecoder(cp === 949 ? "euc-kr" : "windows-1252");
  const str = (o: number) => dec.decode(d.subarray(o + 4, o + 4 + d.readUInt32LE(o))).replace(/\0+$/, "");
  const o = at(id);
  if (o < 0) return undefined;
  const type = d.readUInt32LE(o);
  if (type === 0x1e) return [str(o + 4)];
  const items: (string | number)[] = [];
  let p = o + 8;
  for (let j = 0; j < d.readUInt32LE(o + 4); j++) {
    const t = type === 0x100c ? d.readUInt32LE(p) : 0x1e;
    if (type === 0x100c) p += 4;
    if (t === 3) items.push(d.readInt32LE(p)), (p += 4);
    else items.push(str(p)), (p += 4 + d.readUInt32LE(p));
  }
  return items;
}
const summary = (file: Uint8Array, stream: 0 | 1) => readCfb(file).get(SUMMARIES[stream])!;

/** Edit, save, read back: the text is the one edited, every other stream is the original's. */
async function roundTrip(file: string, edit: (doc: OmwDocument) => boolean | void) {
  const bytes = read(file);
  const doc = await open(bytes);
  if (edit(doc) === false) return null;
  expect(legacyUnchanged(doc.pages, "ppt")).toBe(false);
  expect(pptTextOnly(doc.pages)).toBe(true);
  const out = await save(doc);
  expect(lastLegacySave.ppt).toBe("text");
  expect(eq(out, bytes)).toBe(false);
  const back = await open(out);
  expect(slides(back)).toEqual(slides(doc));
  expect(legacySource(back.pages, "ppt")?.legacy).toBeTruthy(); // a PPT it keeps again
  // the other streams byte for byte; Current User but offsetToCurrentEdit; the summaries but the title, the slide
  // titles and the first slide's picture (QA ppt-write2: each other property's bytes as they were)
  const a = cfbStreams(readCfbTree(bytes)), b = cfbStreams(readCfbTree(out));
  expect([...b.keys()]).toEqual([...a.keys()]);
  for (const [k, v] of a) {
    if (k === "PowerPoint Document") continue;
    const w = b.get(k)!;
    if (k === "Current User") {
      expect(w.length).toBe(v.length);
      expect(eq(w.subarray(0, 16), v.subarray(0, 16)) && eq(w.subarray(20), v.subarray(20))).toBe(true);
    } else if (SUMMARIES.includes(k) && !eq(w, v)) {
      const p0 = propSet(v), p1 = propSet(w);
      expect(p1.length).toBe(p0.length);
      p0.forEach((sec, i) => {
        for (const [id, val] of sec) if (!(i === 0 && [2, 13, 17].includes(id))) expect(p1[i].get(id), `${k} ${i}/${id}`).toBe(val);
        expect([...p1[i].keys()].filter((id) => !sec.has(id))).toEqual([]);
      });
    } else expect(eq(w, v), k).toBe(true);
  }
  // the persist directory points at records of the right types again
  const s = readCfb(out).get("PowerPoint Document")!, s0 = readCfb(bytes).get("PowerPoint Document")!;
  const p0 = pptPersist(s0, readCfb(bytes).get("Current User")!), p1 = pptPersist(s, readCfb(out).get("Current User")!);
  expect([...p1.offsets.keys()]).toEqual([...p0.offsets.keys()]);
  for (const [id, at] of p1.offsets) expect(s[at + 2] | (s[at + 3] << 8)).toBe(s0[p0.offsets.get(id)! + 2] | (s0[p0.offsets.get(id)! + 3] << 8));
  return { bytes, doc, out, back };
}

/** save expecting a refusal; returns its message */
async function refusal(doc: OmwDocument) {
  let msg = "";
  try {
    await save(doc);
  } catch (e) {
    msg = (e as Error).message;
  }
  expect(msg).not.toBe("");
  return msg;
}
const why = (w: string) => t(`legacysave.pptWhy.${w}`);

describe.each(files.map((f) => [label(f), f] as const))("PPT text save — %s", (_, file) => {
  it("reads every slide (a first slide without text too) and saves unedited as the original", async () => {
    const bytes = read(file);
    const doc = await open(bytes);
    expect(slides(doc).length).toBe(pptText(bytes).blocks.filter((b) => b.kind === "slide").length);
    expect(eq(await save(doc), bytes)).toBe(true);
  });
  it("letters typed in the middle of the first paragraph", () =>
    roundTrip(file, (doc) => {
      const b = paras(doc).find((x) => x.text.length > 3);
      if (!b) return false;
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 2 }, "omw").paras;
    }));
  it("letters deleted, a paragraph's text cleared", () =>
    roundTrip(file, (doc) => {
      const ps = paras(doc).filter((x) => x.text.length > 5);
      if (ps.length < 2) return false;
      ps[0].n.paragraphs = deleteRange(ps[0].n.paragraphs, { start: { p: ps[0].i, o: 1 }, end: { p: ps[0].i, o: 4 } }).paras;
      const c = ps[ps.length - 1];
      c.n.paragraphs = deleteRange(c.n.paragraphs, { start: { p: c.i, o: 0 }, end: { p: c.i, o: c.text.length } }).paras;
    }));
  it("Enter at a paragraph's end with new text, a paragraph split", () =>
    roundTrip(file, (doc) => {
      const ps = paras(doc).filter((x) => x.text.length > 4);
      if (!ps.length) return false;
      const b = ps[ps.length - 1];
      let r = splitParagraph(b.n.paragraphs, { p: b.i, o: b.text.length });
      r = insertText(r.paras, r.pos, "새 문단 omw");
      b.n.paragraphs = r.paras;
      const c = ps[0];
      if (c !== b) c.n.paragraphs = splitParagraph(c.n.paragraphs, { p: c.i, o: 3 }).paras;
    }));
  it("Korean typed into every paragraph (8-bit text atoms become UTF-16)", () =>
    roundTrip(file, (doc) => {
      for (const pg of doc.pages)
        for (const n of pg.nodes) if (n.type === "TEXT") n.paragraphs = n.paragraphs.map((p, i) => (LOCKED.has(plain(p)) || (!plain(p) && n.paragraphs.length === 1) ? p : insertText([p], { p: 0, o: plain(p).length }, `한${i}😀`).paras[0]));
    }));
});

describe("PPT text save — the deck (omni-legacy-ppt-deck)", () => {
  it("joins and removes paragraphs in one text box; Backspace at a paragraph's start", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const b = find(doc, "둘 two")!;
      b.n.paragraphs = deleteChar(b.n.paragraphs, { p: b.i, o: 0 }, -1).paras; // 하나 one둘 two
      const c = find(doc, "셋 three")!;
      c.n.paragraphs = deleteRange(c.n.paragraphs, { start: { p: c.i - 1, o: plain(c.n.paragraphs[c.i - 1]).length }, end: { p: c.i, o: c.text.length } }).paras;
    });
    expect(slides(r!.back)[1].paras).toEqual(["글머리표 / Bullets", "하나 one둘 two"]);
  });
  it("a paragraph added before the first one of a slide, and between two text boxes", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const b = find(doc, "글머리표 / Bullets")!;
      b.n.paragraphs = splitParagraph(b.n.paragraphs, { p: b.i, o: 0 }).paras;
      const c = find(doc, "구형 PPT 시험")!;
      let x = splitParagraph(c.n.paragraphs, { p: c.i, o: c.text.length });
      x = insertText(x.paras, x.pos, "제목 다음 줄");
      c.n.paragraphs = x.paras;
    });
    const sl = slides(r!.back);
    expect(sl[1].paras.slice(0, 2)).toEqual(["", "글머리표 / Bullets"]);
    expect(sl[0].paras).toEqual(["구형 PPT 시험 / Legacy PPT", "제목 다음 줄", "Omniweave QA"]);
    // (Enter at the title's end: the new line is the title box's — a line break, a title is one paragraph in PowerPoint;
    // Enter at the start of the bullets' title too)
    const boxes = pptBoxes(r!.out);
    expect(boxes[0].texts.map((x) => x.text)).toEqual(["구형 PPT 시험 / Legacy PPT\x0b제목 다음 줄", "Omniweave QA"]);
    expect(boxes[1].texts[0].text).toBe("\x0b글머리표 / Bullets");
    expect(boxes[1].texts[1].text).toBe("하나 one\r둘 two\r셋 three");
  });
  it("edits in the title and the next box at once (a run across boxes, split by box)", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "구형 PPT 시험")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 2 }, "X").paras;
      const b = find(doc, "Omniweave QA")!;
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "Y").paras;
    });
    expect(pptBoxes(r!.out)[0].texts.map((x) => x.text)).toEqual(["구형X PPT 시험 / Legacy PPT", "YOmniweave QA"]);
  });
  it("new letters take the runs of the letter before them; a new paragraph the paragraph's", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "구형 PPT 시험")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 0 }, "앞").paras; // at the start: the letter after
      const b = find(doc, "Omniweave QA")!;
      let x = splitParagraph(b.n.paragraphs, { p: b.i, o: 9 });
      x = insertText(x.paras, x.pos, "가나");
      b.n.paragraphs = x.paras;
    });
    const before = pptBoxes(r!.bytes), after = pptBoxes(r!.out);
    // title: the runs as they were, each one letter longer where the letter went in
    const t0 = before[0].texts[0], t1 = after[0].texts[0];
    expect(t1.text).toBe("앞" + t0.text);
    expect(t1.cf!.map((x) => x.data)).toEqual(t0.cf!.map((x) => x.data));
    expect(t1.cf![0].count).toBe(t0.cf![0].count + 1);
    expect(t1.si![0].count).toBe(t0.si![0].count + 1);
    // the subtitle (8-bit, now UTF-16): "Omniweave\r가나 QA" — its one paragraph run covers both paragraphs now
    const s0 = before[0].texts[1], s1 = after[0].texts[1];
    expect(s0.bytes).toBe(true);
    expect(s1.bytes).toBe(false);
    expect(s1.text).toBe("Omniweave\r가나 QA");
    expect(s1.pf!.map((x) => x.count)).toEqual([16]);
    expect(s1.pf!.map((x) => x.data)).toEqual(s0.pf!.map((x) => x.data));
    expect(s1.cf!.map((x) => x.data)).toEqual(s0.cf!.map((x) => x.data));
    expect(s1.cf!.reduce((n, x) => n + x.count, 0)).toBe(s1.text.length + 1);
  });
  it("speaker notes edited (slide 1 and the last slide)", async () => {
    const r = await roundTrip(DECK, (doc) => {
      doc.pages[0].notes = "첫 슬라이드 발표자 노트 고침\n둘째 줄";
      doc.pages[doc.pages.length - 1].notes = "";
    });
    const sl = slides(r!.back);
    expect(sl[0].notes).toBe("첫 슬라이드 발표자 노트 고침\n둘째 줄");
    expect(sl[sl.length - 1].notes).toBe("");
    expect(pptBoxes(r!.out)[0].notes!.text).toBe("첫 슬라이드 발표자 노트 고침\r둘째 줄");
  });
  it("the deleted text is gone from the stream (laid out again, not appended)", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "구형 PPT 시험")!;
      a.n.paragraphs = deleteRange(a.n.paragraphs, { start: { p: a.i, o: a.text.indexOf("Legacy") }, end: { p: a.i, o: a.text.length } }).paras;
      doc.pages[0].notes = "";
    });
    const s0 = Buffer.from(readCfb(r!.bytes).get("PowerPoint Document")!), s1 = Buffer.from(readCfb(r!.out).get("PowerPoint Document")!);
    expect(s0.includes(u16le("Legacy PPT"))).toBe(true);
    expect(s0.includes(u16le("발표자 노트"))).toBe(true);
    expect(s1.includes(u16le("Legacy PPT"))).toBe(false);
    expect(s1.includes(u16le("발표자 노트"))).toBe(false);
    // the stream is as long as the text that changed (records laid out again in place)
    expect(s1.length - s0.length).toBe(-("Legacy PPT".length + "첫 슬라이드 발표자 노트".length) * 2);
  });
  it("saved again after reopening (a second round)", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "R2 C2")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 5 }, " 값").paras;
    });
    const doc2 = await open(r!.out);
    const b = find(doc2, "R2 C2 값")!;
    b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "둘째 ").paras;
    const out2 = await save(doc2);
    expect(lastLegacySave.ppt).toBe("text");
    expect(slides(await open(out2))).toEqual(slides(doc2));
    expect(out2.length).toBeLessThan(r!.bytes.length + 4096);
  });
  it("typing and undoing it saves the original bytes", async () => {
    const bytes = read(DECK);
    const doc = await open(bytes);
    const a = find(doc, "그림 / Picture")!;
    const was = a.n.paragraphs;
    a.n.paragraphs = insertText(was, { p: a.i, o: 2 }, "omw").paras;
    expect(pptTextOnly(doc.pages)).toBe(true);
    a.n.paragraphs = was;
    expect(legacyUnchanged(doc.pages, "ppt")).toBe(true);
    expect(eq(await save(doc), bytes)).toBe(true);
    expect(lastLegacySave.ppt).toBe("original");
  });
});

describe("PPT text save — refused", () => {
  it("paragraphs of two text boxes joined (two table cells)", async () => {
    const doc = await open(read(DECK));
    const b = find(doc, "R1 C2")!;
    b.n.paragraphs = deleteChar(b.n.paragraphs, { p: b.i, o: 0 }, -1).paras;
    expect(pptTextOnly(doc.pages)).toBe(true);
    expect(await refusal(doc)).toContain(why("box"));
  });
  it("the title joined with the subtitle (the looks differ: not a text edit)", async () => {
    const doc = await open(read(DECK));
    const b = find(doc, "Omniweave QA")!;
    b.n.paragraphs = deleteChar(b.n.paragraphs, { p: b.i, o: 0 }, -1).paras;
    expect(pptTextOnly(doc.pages)).toBe(false);
    expect(await refusal(doc)).toBe(t("legacysave.err.edited.ppt"));
  });
  it("notes on a slide without a notes text box", async () => {
    const doc = await open(read(SHAPES));
    doc.pages[0].notes = "omw";
    expect(pptTextOnly(doc.pages)).toBe(true);
    expect(await refusal(doc)).toContain(why("notes"));
  });
  it("control characters", async () => {
    const doc = await open(read(DECK));
    const a = find(doc, "그림 / Picture")!;
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 2 }, "\u0001").paras;
    expect(await refusal(doc)).toContain(why("chars"));
  });
  it("a format change with the text (bold) is not a text edit", async () => {
    const doc = await open(read(DECK));
    const a = find(doc, "그림 / Picture")!;
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 2 }, "omw", { bold: false } as any).paras;
    a.n.paragraphs[a.i].runs.forEach((r) => (r.italic = true));
    expect(pptTextOnly(doc.pages)).toBe(false);
    expect(await refusal(doc)).toBe(t("legacysave.err.edited.ppt"));
  });
  it("a file whose fingerprint no longer matches its reading (an .omw from before) is refused, not guessed", async () => {
    const doc = await open(read(DECK));
    const l = legacySource(doc.pages, "ppt")!.legacy!;
    const a = find(doc, "그림 / Picture")!;
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 2 }, "omw").paras;
    expect(() => savePptText(doc.pages, read(DECK), { name: l.name, fp: "other" })).toThrow(why("reader"));
  });
  it("the shape ignores the text and the notes, not the rest", async () => {
    const doc = await open(read(DECK));
    const shape = pptShape(doc.pages);
    const a = find(doc, "그림 / Picture")!;
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 2 }, "omw").paras;
    doc.pages[0].notes = "x";
    expect(pptShape(doc.pages)).toBe(shape);
    a.n.transform = { ...a.n.transform, x: a.n.transform.x + 3 };
    expect(pptShape(doc.pages)).not.toBe(shape);
  });
});

describe("PPT text save — the text deck (omni-legacy-ppt-text)", () => {
  it("opens the first slide that has no text, and the notes", async () => {
    const sl = slides(await open(read(TEXT)));
    expect(sl.length).toBe(4);
    expect(sl[0]).toEqual({ paras: [""], notes: "" });
    expect(sl[2].paras.length).toBe(23);
    expect(sl[2].notes).toBe("긴 목록 노트 첫 문단\n둘째 문단 second");
    expect(sl[3].paras.slice(0, 2)).toEqual(["줄 바꿈 제목", "Line break title"]);
  });
  it("a long list carried onto a second page: edits on both pages", async () => {
    const r = await roundTrip(TEXT, (doc) => {
      expect(doc.pages.length).toBeGreaterThan(4);
      const a = find(doc, "항목 2 —")!, b = find(doc, "항목 21 —")!;
      expect(b.s).toBeGreaterThan(a.s);
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 4 }, "(고침)").paras;
      b.n.paragraphs = deleteChar(b.n.paragraphs, { p: b.i, o: 0 }, -1).paras;
    });
    expect(slides(r!.back)[2].paras.length).toBe(22);
  });
  it("a line break (VT) stays one when a letter is typed next to it; 8-bit text stays 8-bit with Latin-1 letters", async () => {
    const r = await roundTrip(TEXT, (doc) => {
      const a = find(doc, "Line break title")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 0 }, "→ ").paras;
      const b = find(doc, "Café")!;
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 4 }, " à la").paras;
    });
    const boxes = pptBoxes(r!.out);
    expect(boxes[3].texts[0].text).toBe("줄 바꿈 제목\x0b→ Line break title");
    const latin = boxes[1].texts.find((x) => x.text.startsWith("Café"))!;
    expect(latin.bytes).toBe(true);
    expect(latin.text).toBe("Café à la naïve\tÜnïcödé");
  });
  it("text next to a hyperlink box and a slide number box (other boxes on those slides) is written", () =>
    roundTrip(TEXT, (doc) => {
      const a = find(doc, "링크 슬라이드")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 0 }, "새 ").paras;
      const b = find(doc, "번호 없는 글상자")!;
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: b.text.length }, " 끝").paras;
      doc.pages[doc.pages.length - 1].notes = "마지막 노트 고침";
    }));
  it("refused: the hyperlink's box, the slide number's box, text on the slide without a text box", async () => {
    for (const [want, edit] of [
      ["special", (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n): n is TextNode => n.type === "TEXT").forEach((n) => (n.paragraphs = n.paragraphs.map((p) => (plain(p) === "둘째 줄" ? insertText([p], { p: 0, o: 0 }, "x").paras[0] : p))))],
      ["special", (doc: OmwDocument) => doc.pages.flatMap((p) => p.nodes).filter((n): n is TextNode => n.type === "TEXT").forEach((n) => (n.paragraphs = n.paragraphs.map((p) => (plain(p).startsWith("슬라이드 번호") ? insertText([p], { p: 0, o: 0 }, "x").paras[0] : p))))],
      ["box", (doc: OmwDocument) => doc.pages[0].nodes.filter((n): n is TextNode => n.type === "TEXT").forEach((n) => (n.paragraphs = insertText(n.paragraphs, { p: 0, o: 0 }, "omw").paras))],
    ] as const) {
      const doc = await open(read(TEXT));
      edit(doc);
      expect(pptTextOnly(doc.pages)).toBe(true);
      expect(await refusal(doc)).toContain(why(want));
    }
  });
});

describe("PPT text save — outline text in the slide list (PowerPoint 97-2003 files)", () => {
  /**
   * omni-legacy-ppt-shapes with its last slide's title also in the slide list (SlideListWithText: TextHeaderAtom,
   * TextCharsAtom, StyleTextPropAtom after its SlidePersistAtom), as PowerPoint 97-2003 wrote it — the reader then reads
   * the slide list's text. Built here: the atoms go in at the list's end; the records after it, and every offset to them,
   * move by their size.
   */
  function withOutline(file: Uint8Array): Uint8Array {
    const tree = readCfbTree(file);
    const node = (n: string) => tree.root.kids!.find((k) => k.name === n)!;
    const s = node("PowerPoint Document").data!, cu = node("Current User").data!.slice();
    const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
    const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000;
    const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
    const rec = (type: number, body: Uint8Array) => {
      const r = new Uint8Array(8 + body.length);
      dv(r).setUint16(2, type, true);
      dv(r).setUint32(4, body.length, true);
      r.set(body, 8);
      return r;
    };
    // the slide list (instance 0) inside the document container at 0, and the last slide's title box
    let list = -1;
    for (let o = 8; o < 8 + u32(s, 4); o += 8 + u32(s, o + 4)) if (u16(s, o + 2) === 0x0ff0 && u16(s, o) >> 4 === 0) list = o;
    const at = list + 8 + u32(s, list + 4);
    const title = Buffer.from(s).indexOf(Buffer.from("끝 / End", "utf16le")) - 8;
    const style = title + 8 + u32(s, title + 4);
    expect(u16(s, title + 2)).toBe(0x0fa0);
    expect(u16(s, style + 2)).toBe(0x0fa1);
    const add = Buffer.concat([rec(0x0f9f, new Uint8Array([6, 0, 0, 0])), s.subarray(title, style), s.subarray(style, style + 8 + u32(s, style + 4))]);
    const out = new Uint8Array(s.length + add.length);
    out.set(s.subarray(0, at));
    out.set(add, at);
    out.set(s.subarray(at), at + add.length);
    const d = dv(out), n = add.length;
    d.setUint32(4, u32(out, 4) + n, true);
    d.setUint32(list + 4, u32(out, list + 4) + n, true);
    const move = (o: number) => (o >= at ? o + n : o);
    // the persist directory, the user edit, the current user (one edit in this file)
    const ue = move(u32(cu, 16));
    dv(cu).setUint32(16, ue, true);
    const dir = move(u32(out, ue + 20));
    d.setUint32(ue + 20, dir, true);
    for (let o = dir + 8; o < dir + 8 + u32(out, dir + 4); ) {
      const k = u32(out, o) >>> 20;
      for (let i = 0; i < k; i++) d.setUint32(o + 4 + i * 4, move(u32(out, o + 4 + i * 4)), true);
      o += 4 + k * 4;
    }
    node("PowerPoint Document").data = out;
    node("Current User").data = cu;
    return writeCfb(tree);
  }

  it("reads the slide list's text, and writes an edit into it and into the same text box in the slide", async () => {
    const bytes = withOutline(read(SHAPES));
    const doc = await open(bytes);
    expect(slides(doc).map((x) => x.paras)).toEqual([[""], [""], ["끝 / End"]]);
    const a = find(doc, "끝 / End")!;
    a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 1 }, "맺음").paras;
    const out = await save(doc);
    expect(lastLegacySave.ppt).toBe("text");
    expect(slides(await open(out))[2].paras).toEqual(["끝맺음 / End"]);
    // both copies: the slide list's and the slide's title box
    const st = Buffer.from(readCfb(out).get("PowerPoint Document")!);
    const hits: number[] = [];
    for (let i = st.indexOf(u16le("끝맺음 / End")); i >= 0; i = st.indexOf(u16le("끝맺음 / End"), i + 1)) hits.push(i);
    expect(hits.length).toBe(2);
    expect(st.includes(u16le("끝 / End"))).toBe(false);
    // the style runs of both grew by the two letters
    for (const h of hits) expect(st.readUInt32LE(h - 8 + 8 + "끝맺음 / End".length * 2 + 8)).toBe("끝맺음 / End".length + 1);
  });
});

describe("PPT text save — the summaries keep no old slide title (QA ppt-write2)", () => {
  it("a changed first-slide title: the presentation title, the slide titles list, the first slide's picture", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "구형 PPT 시험")!;
      a.n.paragraphs = deleteRange(a.n.paragraphs, { start: { p: a.i, o: a.text.indexOf(" / Legacy") }, end: { p: a.i, o: a.text.length } }).paras;
      const b = find(doc, "글머리표 / Bullets")!;
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: "글머리표 / ".length }, "목록 ").paras;
    });
    const { bytes, out } = r!;
    expect(summaryText(summary(bytes, 0), 2)).toEqual(["구형 PPT 시험 / Legacy PPT"]);
    expect(summaryText(summary(out, 0), 2)).toEqual(["구형 PPT 시험"]);
    // the slide titles: after the fonts and the theme
    expect(summaryText(summary(bytes, 1), 12)).toEqual(summaryText(summary(out, 1), 12));
    expect(summaryText(summary(out, 1), 13)!.slice(3)).toEqual(["구형 PPT 시험", "글머리표 / 목록 Bullets", "표 / Table", "그림 / Picture"]);
    expect(summaryText(summary(out, 1), 13)!.slice(0, 3)).toEqual(summaryText(summary(bytes, 1), 13)!.slice(0, 3));
    // the picture of the first slide (its old title) is gone; the other properties as they were (roundTrip)
    expect(propSet(summary(bytes, 0))[0].has(17)).toBe(true);
    expect(propSet(summary(out, 0))[0].has(17)).toBe(false);
    // nowhere in the file: the old titles, in the summaries' code page or UTF-16
    const all = Buffer.from(out);
    for (const s of ["Legacy PPT", "/ Bullets"]) expect(all.includes(Buffer.from(s, "latin1")) || all.includes(u16le(s)), s).toBe(false);
    expect(Buffer.from(bytes).includes(Buffer.from("Legacy PPT", "latin1"))).toBe(true);
  });
  it("a letter the code page cannot hold is listed as ?; Korean titles in the code page; the user-defined section stays", async () => {
    const r = await roundTrip(TEXT, (doc) => {
      const a = find(doc, "Line break title")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: a.text.length }, " 😀").paras;
      const b = find(doc, "링크 슬라이드")!;
      b.n.paragraphs = insertText(b.n.paragraphs, { p: b.i, o: 0 }, "새 ").paras;
    });
    const { bytes, out } = r!;
    expect(summaryText(summary(out, 1), 13)!.slice(3)).toEqual(["PowerPoint 프레젠테이션", "새 링크 슬라이드 / Links", "긴 목록 / Long list", "줄 바꿈 제목 Line break title ?"]);
    // the presentation title was no slide's title; the first slide did not change: both stay
    expect(eq(summary(out, 0), summary(bytes, 0))).toBe(true);
    expect(propSet(summary(out, 1))[1]).toEqual(propSet(summary(bytes, 1))[1]);
    expect(summary(out, 1).length).toBe(summary(bytes, 1).length);
    expect(Buffer.from(out).includes(Buffer.from("Line break title\0", "latin1"))).toBe(false);
  });
  it("notes and body text alone: the summaries byte for byte", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "둘 two")!;
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 1 }, "x").paras;
      doc.pages[doc.pages.length - 1].notes = "고침";
    });
    for (const k of [0, 1] as const) expect(eq(summary(r!.out, k), summary(r!.bytes, k))).toBe(true);
  });
});

describe("PPT text save — letters at the edge of a run (QA ppt-write2)", () => {
  // the title of the deck: spelling runs [3, 4, 3, 12, 1] — "구형 " "PPT " "시험 " "/ Legacy PPT" and the end mark (a run of a
  // space next to a deleted one is not checked: either space may be the one deleted, the text is the same)
  it("typed where a run starts takes the run before; a whole run deleted leaves the others", async () => {
    const r = await roundTrip(DECK, (doc) => {
      const a = find(doc, "구형 PPT 시험")!;
      a.n.paragraphs = deleteRange(a.n.paragraphs, { start: { p: a.i, o: 10 }, end: { p: a.i, o: a.text.length } }).paras; // "/ Legacy PPT"
      a.n.paragraphs = insertText(a.n.paragraphs, { p: a.i, o: 3 }, "새").paras; // where "PPT " starts
    });
    const before = pptBoxes(r!.bytes)[0].texts[0], after = pptBoxes(r!.out)[0].texts[0];
    expect(after.text).toBe("구형 새PPT 시험 ");
    expect(before.si!.map((x) => x.count)).toEqual([3, 4, 3, 12, 1]);
    expect(after.si!.map((x) => x.count)).toEqual([4, 4, 3, 1]);
    expect(after.si!.map((x) => x.data)).toEqual([before.si![0].data, before.si![1].data, before.si![2].data, before.si![4].data]);
  });
});