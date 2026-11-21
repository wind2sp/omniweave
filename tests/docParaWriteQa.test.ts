// QA doc-para-write (2026-11-17): adversarial checks of paragraph-boundary edits saved in place in a DOC opened with its
// formatting (docWrite.ts textEdits / docRich.ts docStyleTools), and of the shared editor's splitParagraph with
// `styleNext` (core/richtext.ts).
//  - splitParagraph without styleNext is exactly as before for every other format (headings, lists, page breaks, the
//    mark's tracked change), and with it the paragraph mark's tracked change goes with the new paragraph;
//  - `styleNext` is not content: not in a DOCX / HWPX the pages are exported to, kept by an .omw, an old .omw without it
//    still saves in place;
//  - restyle: what the joined paragraph's style changes is set again for each property (fonts, sizes, toggles, colour,
//    kerning, languages, complex-script ones), as direct formatting;
//  - 10 Enter / join cycles: the deleted text is in no stream, the file stays near its size after one save;
//  - a seeded run of random boundary edits and pairs of them (OMW_PARA_N edits, OMW_PARA_SEEDS seeds; OMW_LEGACY_FILES
//    adds local files): never a lossy save — the saved file read again shows the pages and the text as edited.

import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { docParaText, docRichOpen } from "../src/io/formats/docRich";
import { docLooks, docProps } from "../src/io/formats/docWrite";
import { lastLegacySave } from "../src/io/formats/legacyWrite";
import { cfbStreams, readCfbTree } from "../src/io/formats/cfb";
import { collectFlow } from "../src/io/office";
import { gatherStory, isFlowSegment, reanchor, reflowSegment, segments } from "../src/core/flow";
import { bodyFormat, deleteChar, deleteRange, insertText, listSeedBefore, markerLength, paraText, splitParagraph } from "../src/core/richtext";
import { setTracking } from "../src/core/review";
import type { ListCtx } from "../src/core/lists";
import type { OmwDocument, Page, TextParagraph } from "../src/core/types";

const ROOT = process.cwd();
const WORD_DOC = join(ROOT, "qa/interop/adobe-made/word_doc.doc");
const TEXT_DOC = join(ROOT, "qa/interop/word-made/omni-legacy-word-text.doc");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.doc$/i.test(f) ? [join(d, f)] : []));
const extra = (process.env.OMW_LEGACY_FILES ?? "").split(";").filter((f) => f && /\.doc$/i.test(f) && existsSync(f));
const files = [...(existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : []), ...extra];
const read = (f: string) => new Uint8Array(readFileSync(f));

async function open(bytes: Uint8Array) {
  const r = await formatForExt("doc")!.open({ name: "omw-paraqa.doc", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
function editStory(doc: OmwDocument, start: number, fn: (ps: TextParagraph[], lc: ListCtx) => TextParagraph[] | null): boolean {
  const seg = segments(doc.pages).find((s) => s.start === start)!;
  const st = gatherStory(doc.pages, seg);
  const first = doc.pages[seg.start].nodes.find((n) => n.type === "TEXT" && n.flow);
  const out = fn(st.paras, { defs: st.lists, seed: first ? listSeedBefore(doc.pages, first.id) : undefined });
  if (!out) return false;
  doc.pages = reflowSegment(doc.pages, seg.start, { ...st, paras: out, objs: reanchor(st.objs, st.paras, out) }) as Page[];
  return true;
}
const enterAt = (ps: TextParagraph[], lc: ListCtx, i: number, o: number) => splitParagraph(ps, { p: i, o }, { body: bodyFormat(ps), lc });
const paras = (pages: readonly Page[]) => collectFlow(pages).flatMap((it) => (it.kind === "p" ? [it.p] : []));
const texts = (pages: readonly Page[]) => collectFlow(pages).map((it) => (it.kind === "p" ? docParaText(it.p) : it.t.rows.map((r) => r.map((c) => c.text))));
/** whether the saved file read again shows the pages and the text as they are */
const faithful = (out: Uint8Array, doc: OmwDocument) => {
  const again = docRichOpen(out, "omw-paraqa.doc").pages;
  return JSON.stringify(docLooks(again, false)) === JSON.stringify(docLooks(doc.pages, false)) && JSON.stringify(texts(again)) === JSON.stringify(texts(doc.pages)) && JSON.stringify(picPlaces(again)) === JSON.stringify(picPlaces(doc.pages));
};
/** (QA doc-pic-para) each picture's place: its kind, the paragraph it is in (flow order) and the letters before it */
const picPlaces = (pages: readonly Page[]) => {
  const at = new Map(paras(pages).map((p, i) => [p.id, i]));
  return pages
    .flatMap((pg) => pg.nodes)
    .flatMap((n) => (n.type === "IMAGE" ? [`${n.place?.mode}|${at.get(n.place?.para ?? "") ?? -1}|${n.place?.offset ?? 0}`] : []))
    .sort();
};
const leaks = (file: Uint8Array, s: string) => {
  const forms = [Buffer.from(s, "utf16le"), Buffer.from(s, "latin1")];
  const all = [Buffer.from(file), ...[...cfbStreams(readCfbTree(file)).values()].map((v) => Buffer.from(v))];
  return all.some((b) => forms.some((f) => b.includes(f)));
};
const P = (o: Partial<TextParagraph> & { text?: string }): TextParagraph => {
  const { text = "", ...rest } = o;
  return { id: Math.random().toString(36).slice(2), runs: [{ text, fontSize: 12 } as TextParagraph["runs"][number]], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 6, ...rest } as TextParagraph;
};

describe("splitParagraph for the other formats (no styleNext): as before", () => {
  it("a heading's end: body text with the body format, no role, no page break; its middle: the heading twice", () => {
    const h = P({ text: "Head", role: "h2", pageBreakBefore: true, keepNext: true, align: "CENTER" });
    const r = splitParagraph([h], { p: 0, o: 4 }, { body: { fontSize: 10 } as any });
    expect(r.paras[1].role).toBeUndefined();
    expect(r.paras[1].pageBreakBefore).toBeUndefined();
    expect(r.paras[1].align).toBe("CENTER"); // (the paragraph's other properties go on, as before)
    expect(r.paras[1].runs).toEqual([{ fontSize: 10, text: "" }]);
    const m = splitParagraph([h], { p: 0, o: 2 });
    expect(m.paras.map((p) => [p.role, paraText(p), !!p.pageBreakBefore])).toEqual([["h2", "He", true], ["h2", "ad", false]]);
  });
  it("a list item continues the list; an empty one ends it; a page-break paragraph's new one has none", () => {
    const li = P({ text: "• one", role: "li" });
    const r = splitParagraph([li], { p: 0, o: 5 });
    expect(paraText(r.paras[1])).toBe("• ");
    expect(r.pos).toEqual({ p: 1, o: 2 });
    const e = splitParagraph(r.paras, r.pos);
    expect(e.paras[1].role).toBeUndefined();
    const pb = P({ text: "x", pageBreakBefore: true });
    expect(splitParagraph([pb], { p: 0, o: 1 }).paras[1].pageBreakBefore).toBeUndefined();
  });
  it("the paragraph's mark and its tracked change go with the second part (with styleNext too); tracking: a new insertion", () => {
    const rev = { kind: "ins", author: "QA", date: "2026-11-17T00:00:00Z", id: 7 } as any;
    const tpl = { runs: [{ text: "", fontSize: 10 }], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 4 } as any;
    for (const styleNext of [undefined, tpl]) {
      const h = P({ text: "Head", role: "h1", markRev: rev, styleNext });
      const r = splitParagraph([h], { p: 0, o: 4 });
      expect(r.paras[1].markRev).toBe(rev);
      expect(r.paras[0].markRev).toBeUndefined();
      setTracking(true);
      try {
        const t = splitParagraph([h], { p: 0, o: 4 });
        expect(t.paras[1].markRev).toBe(rev);
        expect(t.paras[0].markRev?.kind).toBe("ins");
      } finally {
        setTracking(false);
      }
    }
  });
  it("styleNext: a list item (not a heading) keeps the list; Enter then Backspace gives the paragraph back with it", () => {
    const tpl = { runs: [{ text: "", fontSize: 10 }], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 4 } as any;
    const li = P({ text: "• one", role: "li", styleNext: tpl });
    expect(paraText(splitParagraph([li], { p: 0, o: 5 }).paras[1])).toBe("• ");
    const h = P({ text: "Head", role: "h1", styleNext: tpl, spaceAfter: 20 });
    const r = splitParagraph([h], { p: 0, o: 4 });
    expect(r.paras[1].spaceAfter).toBe(4);
    const back = deleteChar(r.paras, r.pos, -1).paras;
    expect(back).toHaveLength(1);
    expect(back[0].styleNext).toEqual(tpl);
    expect(back[0].role).toBe("h1");
    // (the template is copied: the new paragraph's runs are not the template's)
    r.paras[1].runs[0].text = "x";
    expect(tpl.runs[0].text).toBe("");
  });
});

describe.runIf(existsSync(WORD_DOC) && existsSync(TEXT_DOC))("styleNext is not content", () => {
  it("DOCX and HWPX exports of the pages have nothing of it; the .omw keeps it; an old .omw without it still saves in place", async () => {
    const doc = await open(read(WORD_DOC));
    const doc2 = await open(read(WORD_DOC));
    for (const p of paras(doc2.pages)) delete p.styleNext;
    // compared byte for byte: the zip entries carry the save time (fflate's Date.now(), DOS 2-second steps), so the
    // clock stands still while both are written (under full-suite load the two saves fell into different steps)
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 20, 9, 0, 0));
      const docx = (await exportById("docx")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
      const docx2 = (await exportById("docx")!.run(doc2, doc2.pages[0], { confirm: () => true } as any)) as Uint8Array;
      expect(Buffer.from(docx).equals(Buffer.from(docx2))).toBe(true);
      const hwpx = exportById("hwpx");
      if (hwpx) {
        const a = (await hwpx.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
        const b = (await hwpx.run(doc2, doc2.pages[0], { confirm: () => true } as any)) as Uint8Array;
        expect(a.length).toBe(b.length);
      }
    } finally {
      vi.useRealTimers();
    }
    // .omw (JSON): kept as written, and read back
    const json = JSON.parse(JSON.stringify(doc)) as OmwDocument;
    expect(paras(json.pages).some((p) => p.styleNext)).toBe(true);
    // an old .omw: no styleNext — unedited, the original bytes; Enter at a heading's end (the editor's old way): saved in
    // place as Word's next style, or refused, never lossy
    expect(Buffer.from(await save(doc2)).equals(Buffer.from(read(WORD_DOC)))).toBe(true);
    editStory(doc2, 0, (ps, lc) => {
      const i = ps.findIndex((p) => p.role === "h2");
      const r = enterAt(ps, lc, i, paraText(ps[i]).length);
      return insertText(r.paras, r.pos, "omw old").paras;
    });
    try {
      const out = await save(doc2);
      expect(faithful(out, doc2)).toBe(true);
    } catch (e) {
      expect(String((e as Error).message)).toMatch(/DOCX/i);
    }
  });
});

/** the sprms of a grpprl ([MS-DOC] Sprm: spra in the top 3 bits gives the operand's size; 6: its first byte) */
const sprmsOf = (g: Uint8Array | null) => {
  const out: number[] = [];
  for (let o = 0; g && o + 2 <= g.length; ) {
    const s = g[o] | (g[o + 1] << 8);
    const spra = s >> 13;
    const n = spra === 0 || spra === 1 ? 1 : spra === 2 || spra === 4 || spra === 5 ? 2 : spra === 3 ? 4 : spra === 7 ? 3 : 1 + (g[o + 2] ?? 0);
    out.push(s);
    o += 2 + n;
  }
  return out;
};

describe.runIf(existsSync(WORD_DOC))("joined paragraphs of other styles: what Word shows beyond the model is set back too", () => {
  it("heading 1 + heading 2: the second's letters get the complex-script size of heading 2 again (Word read it 14 pt → 11 pt before)", async () => {
    const doc = await open(read(WORD_DOC));
    editStory(doc, 0, (ps) => {
      const i = ps.findIndex((p) => p.role === "h1");
      return deleteChar(ps, { p: i, o: paraText(ps[i]).length }, 1).paras;
    });
    const out = await save(doc);
    expect(faithful(out, doc)).toBe(true);
    const p = docProps(out);
    const s = sprmsOf(p.chpx(p.text.indexOf("제목 2 —")));
    expect(s).toContain(0x4a43); // the size
    expect(s).toContain(0x4a61); // the complex-script size
  });
});

describe.runIf(existsSync(WORD_DOC))("10 Enter / join cycles: deleted text gone, the size bounded", () => {
  it("Enter at a heading's end with a secret (and a body paragraph split); the secret joined to the heading (its letters written again with the heading's style set back); then deleted (and the split joined)", async () => {
    let bytes = read(WORD_DOC);
    const sizes: number[] = [];
    let secret = "";
    for (let i = 0; i < 10; i++) {
      const doc = await open(bytes);
      const step = i % 3;
      if (step === 0) {
        secret = `omwparasecret${i}x`;
        editStory(doc, 0, (ps, lc) => {
          const h = ps.findIndex((p) => p.role === "h2");
          let r = enterAt(ps, lc, h, paraText(ps[h]).length);
          r = insertText(r.paras, r.pos, secret);
          const b = r.paras.findIndex((p) => paraText(p).startsWith("굵게"));
          return enterAt(r.paras, lc, b, 3).paras;
        });
      } else if (step === 1) {
        // Backspace at the secret paragraph's start: joined to the heading, with the look of Normal's letters
        editStory(doc, 0, (ps) => deleteChar(ps, { p: ps.findIndex((p) => paraText(p) === secret), o: 0 }, -1).paras);
        const h = paras(doc.pages).find((p) => p.role === "h2")!;
        expect(paraText(h).endsWith(secret)).toBe(true);
      } else {
        editStory(doc, 0, (ps) => {
          const h = ps.findIndex((p) => p.role === "h2");
          const len = paraText(ps[h]).length;
          let out = deleteRange(ps, { start: { p: h, o: len - secret.length }, end: { p: h, o: len } }).paras;
          const b = out.findIndex((p) => paraText(p).startsWith("굵게"));
          out = deleteChar(out, { p: b, o: paraText(out[b]).length }, 1).paras;
          return out;
        });
      }
      const want = texts(doc.pages);
      const out = await save(doc);
      expect(lastLegacySave.doc, `cycle ${i}`).toBe("text");
      expect(faithful(out, doc), `cycle ${i}`).toBe(true);
      expect(texts((await open(out)).pages)).toEqual(want);
      expect(leaks(out, secret), `cycle ${i}`).toBe(step !== 2);
      sizes.push(out.length);
      bytes = out;
    }
    for (const s of sizes) expect(s).toBeLessThanOrEqual(sizes[0] + 2048);
  }, 120000);
});

describe.runIf(files.length > 0)("random boundary edits, more seeds and pairs: never lossy", () => {
  it("saved faithfully or refused with advice", async () => {
    const N = Number(process.env.OMW_PARA_N ?? 300);
    const seeds = (process.env.OMW_PARA_SEEDS ?? "0x1234,0xbeef").split(",").map((s) => Number(s));
    const kinds = ["merge", "backspace", "endEnter", "startEnter", "midEnter", "endEnterType", "enterBack", "pair", "joinType", "mergeMerge"] as const;
    const n = { tried: 0, saved: 0, refused: 0, lossy: 0, errors: 0 };
    const byKind: Record<string, [number, number]> = {};
    const bad: string[] = [];
    const base = new Map<string, { bytes: Uint8Array; slots: { seg: number; i: number }[] }>();
    for (const f of files) {
      const bytes = read(f);
      const d = await open(bytes);
      const slots: { seg: number; i: number }[] = [];
      for (const seg of segments(d.pages)) if (isFlowSegment(d.pages, seg)) gatherStory(d.pages, seg).paras.forEach((_, i) => slots.push({ seg: seg.start, i }));
      if (slots.length) base.set(f, { bytes, slots });
    }
    const names = [...base.keys()];
    for (const seed0 of seeds) {
      let seed = seed0 >>> 0;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0), seed / 0x100000000);
      const per = Math.ceil(N / seeds.length);
      for (let t = 0; t < per; t++) {
        const f = names[Math.floor(rnd() * names.length)];
        const { bytes, slots } = base.get(f)!;
        const s = slots[Math.floor(rnd() * slots.length)];
        const kind = kinds[Math.floor(rnd() * kinds.length)];
        const doc = await open(bytes);
        const one = (ps: TextParagraph[], lc: ListCtx, i: number, k: string): TextParagraph[] | null => {
          const p = ps[i];
          if (!p) return null;
          const len = paraText(p).length, mk = markerLength(p);
          if (k === "merge") return ps[i + 1] && !markerLength(ps[i + 1]) ? deleteChar(ps, { p: i, o: len }, 1).paras : null;
          if (k === "backspace") return i > 0 && !mk ? deleteChar(ps, { p: i, o: 0 }, -1).paras : null;
          if (k === "endEnter") return enterAt(ps, lc, i, len).paras;
          if (k === "startEnter") return mk ? null : enterAt(ps, lc, i, 0).paras;
          if (k === "midEnter") return len - mk < 2 ? null : enterAt(ps, lc, i, mk + 1 + Math.floor(rnd() * (len - mk - 1))).paras;
          if (k === "enterBack") {
            const r = enterAt(ps, lc, i, len);
            return deleteChar(r.paras, r.pos, -1).paras;
          }
          if (k === "joinType") {
            if (!ps[i + 1] || markerLength(ps[i + 1])) return null;
            const r = deleteChar(ps, { p: i, o: len }, 1);
            return insertText(r.paras, r.pos, "omwJ").paras;
          }
          if (k === "mergeMerge") {
            if (!ps[i + 2] || markerLength(ps[i + 1]) || markerLength(ps[i + 2])) return null;
            const r = deleteChar(ps, { p: i, o: len }, 1).paras;
            return deleteChar(r, { p: i, o: paraText(r[i]).length }, 1).paras;
          }
          const r = enterAt(ps, lc, i, len);
          return insertText(r.paras, r.pos, "omw 새 글").paras;
        };
        const ok = editStory(doc, s.seg, (ps, lc) => {
          if (kind !== "pair") return one(ps, lc, s.i, kind);
          // two edits in the same story, the later one first so the index of the first holds
          const j = Math.floor(rnd() * ps.length);
          const [lo, hi] = s.i < j ? [s.i, j] : [j, s.i];
          if (hi - lo < 3) return null;
          const k1 = kinds[Math.floor(rnd() * 7)], k2 = kinds[Math.floor(rnd() * 7)];
          const a = one(ps, lc, hi, k2);
          return a ? one(a, lc, lo, k1) : null;
        });
        if (!ok) continue;
        n.tried++;
        byKind[kind] ??= [0, 0];
        byKind[kind][0]++;
        let out: Uint8Array;
        try {
          out = await save(doc);
        } catch (e) {
          const m = String((e as Error).message);
          if (/DOCX/i.test(m)) n.refused++, byKind[kind][1]++;
          else n.errors++, bad.push(`${kind} ${f.slice(-24)} #${s.i}: ${m.slice(0, 80)}`);
          continue;
        }
        n.saved++;
        let good = false;
        try {
          good = faithful(out, doc);
        } catch {
          good = false;
        }
        if (!good) n.lossy++, bad.push(`lossy ${kind} ${f.slice(-24)} #${s.i}`);
      }
    }
    console.log("doc-para-write QA:", JSON.stringify(n), "refused", ((100 * n.refused) / Math.max(1, n.tried)).toFixed(1) + "%", JSON.stringify(byKind), bad.slice(0, 10));
    expect(bad).toEqual([]);
    expect(n.lossy).toBe(0);
    expect(n.tried).toBeGreaterThan(N / 3);
    expect(n.saved / n.tried).toBeGreaterThan(0.8);
  }, 1800000);
});
