// doc-para-write (2026-11-17): paragraph-boundary edits of a DOC opened with its formatting saved in place as Word
// represents them, so the save's look check (docWrite.ts sameLooks) passes — Enter at a heading's end makes a paragraph
// of the style the heading's style names for the one after it (Word's "style for the following paragraph": istd alone),
// Enter in the middle keeps the paragraph's PAPX in both halves, Enter at a paragraph's start puts the new one before it
// with its look, a list item's new item continues the list, paragraphs joined keep the first one's PAPX and style while
// the letters of the second keep their look (their CHPX, with what the first one's style changes set again). Checked in
// hidden Word (QA_LOG 2026-11-17 doc-para-write): styles, list numbers and letter sizes as expected, no repair prompt.
// A seeded run of random boundary edits over every DOC (OMW_LEGACY_FILES adds local ones): no lossy save.

import { DOMParser } from "@xmldom/xmldom";
(globalThis as { DOMParser?: unknown }).DOMParser ??= DOMParser;
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { docParaText, docRichOpen } from "../src/io/formats/docRich";
import { docLooks, docProps } from "../src/io/formats/docWrite";
import { collectFlow } from "../src/io/office";
import { gatherStory, isFlowSegment, reanchor, reflowSegment, segments } from "../src/core/flow";
import { bodyFormat, deleteChar, insertText, listSeedBefore, markerLength, paraText, splitParagraph } from "../src/core/richtext";
import { DICTS } from "../src/i18n";
import type { ListCtx } from "../src/core/lists";
import type { OmwDocument, Page, TextParagraph } from "../src/core/types";

const ROOT = process.cwd();
const WORD_DOC = join(ROOT, "qa/interop/adobe-made/word_doc.doc");
const WM = (n: string) => join(ROOT, "qa/interop/word-made", n);
const TEXT_DOC = WM("omni-legacy-word-text.doc"), PAGES_DOC = WM("omni-legacy-word-pages.doc");
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.doc$/i.test(f) ? [join(d, f)] : []));
const extra = (process.env.OMW_LEGACY_FILES ?? "")
  .split(";")
  .filter((f) => f && /\.doc$/i.test(f) && existsSync(f));
const files = [...(existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : []), ...extra];
const read = (f: string) => new Uint8Array(readFileSync(f));
const REFUSED = DICTS.ko["legacysave.err.edited.doc"].slice(0, 10);

async function open(bytes: Uint8Array) {
  const r = await formatForExt("doc")!.open({ name: "omw-para.doc", path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as unknown as OmwDocument;
}
const save = async (doc: OmwDocument) => (await exportById("doc")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;

/** the body story of the page run starting at `start`, edited by `fn` as the editor applies an edit (docFlow.ts applyParas) */
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
/** the saved file opened again shows the pages as they are (the save's own check, from outside) */
const same = (out: Uint8Array, doc: OmwDocument) => expect(JSON.stringify(docLooks(docRichOpen(out, "omw-para.doc").pages, false))).toBe(JSON.stringify(docLooks(doc.pages, false)));
/** the PAPX (istd and grpprl) of the paragraph holding the first letter of `s` */
const papxOf = (file: Uint8Array, s: string) => {
  const p = docProps(file);
  return Array.from(p.para(p.text.indexOf(s))!.papx ?? []);
};

describe.runIf(existsSync(WORD_DOC) && existsSync(TEXT_DOC) && existsSync(PAGES_DOC))("paragraph-boundary edits saved in place", () => {
  it("the open gives a heading the paragraph its style names for the one after it (Normal); not content", async () => {
    const doc = await open(read(WORD_DOC));
    const h1 = paras(doc.pages).find((p) => p.role === "h1")!;
    expect(h1.styleNext).toBeTruthy();
    expect(h1.styleNext!.role).toBeUndefined();
    expect(h1.styleNext!.keepNext).toBeFalsy();
    // a body paragraph of Normal: the same as it, nothing more
    expect(paras(doc.pages).some((p) => !p.role && !p.list && !p.styleNext)).toBe(true);
    // unedited: the original bytes
    expect(Buffer.from(await save(doc)).equals(Buffer.from(read(WORD_DOC)))).toBe(true);
  });

  it("splitParagraph: Enter at the end of a paragraph with styleNext makes that paragraph; in the middle, the same paragraph", () => {
    const run = { text: "제목", fontSize: 18, bold: true } as TextParagraph["runs"][number];
    const tpl = { runs: [{ text: "", fontSize: 10, bold: false }], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 4 } as unknown as TextParagraph;
    const h = { id: "h", runs: [run], align: "CENTER", lineSpacing: 1.5, indent: 0, spaceAfter: 12, keepNext: true, role: "h1", styleNext: tpl } as unknown as TextParagraph;
    const end = splitParagraph([h], { p: 0, o: 2 }).paras;
    expect(end[1]).toMatchObject({ align: "LEFT", spaceAfter: 4, runs: [{ text: "", fontSize: 10, bold: false }] });
    expect(end[1].role).toBeUndefined();
    expect(end[1].keepNext).toBeUndefined();
    expect(end[1].styleNext).toBeUndefined();
    expect(end[1].id).not.toBe("h");
    const mid = splitParagraph([h], { p: 0, o: 1 }).paras;
    expect(mid[1]).toMatchObject({ align: "CENTER", role: "h1", keepNext: true });
  });

  it("Enter at a heading's end (and typing): the new paragraph has the next style's istd and no PAPX of its own", async () => {
    for (const typed of ["", "새 본문 omw"]) {
      const doc = await open(read(WORD_DOC));
      editStory(doc, 0, (ps, lc) => {
        const i = ps.findIndex((p) => p.role === "h2");
        const r = enterAt(ps, lc, i, paraText(ps[i]).length);
        return typed ? insertText(r.paras, r.pos, typed).paras : r.paras;
      });
      const out = await save(doc);
      same(out, doc);
      const ps = paras(docRichOpen(out, "omw-para.doc").pages);
      const i = ps.findIndex((p) => p.role === "h2");
      expect(docParaText(ps[i + 1])).toBe(typed);
      expect(ps[i + 1].role).toBeUndefined();
      if (typed) expect(papxOf(out, typed)).toEqual([0, 0]); // Normal (istd 0), nothing else
    }
  });

  it("Enter in a heading's middle: both halves keep its PAPX", async () => {
    const bytes = read(WORD_DOC);
    const doc = await open(bytes);
    editStory(doc, 0, (ps, lc) => enterAt(ps, lc, ps.findIndex((p) => p.role === "h1"), 3).paras);
    const out = await save(doc);
    same(out, doc);
    const was = papxOf(bytes, "제목 1 —");
    expect(papxOf(out, "제목 ")).toEqual(was);
    expect(papxOf(out, "1 — Word")).toEqual(was);
  });

  it("Enter at a paragraph's start: the new empty paragraph before it, with its look", async () => {
    const doc = await open(read(WORD_DOC));
    editStory(doc, 0, (ps, lc) => enterAt(ps, lc, ps.findIndex((p) => paraText(p).startsWith("굵게")), 0).paras);
    const out = await save(doc);
    same(out, doc);
  });

  it("joined paragraphs: the first one's PAPX and style, the second's letters with their look", async () => {
    // heading 1 joined with heading 2 (Delete at its end); a body paragraph with heading 1 (Backspace at its start)
    const cases: [string, (ps: TextParagraph[]) => TextParagraph[], string, string][] = [
      [WORD_DOC, (ps) => deleteChar(ps, { p: ps.findIndex((p) => p.role === "h1"), o: paraText(ps.find((p) => p.role === "h1")!).length }, 1).paras, "제목 1 —", "제목 2 —"],
      [TEXT_DOC, (ps) => deleteChar(ps, { p: ps.findIndex((p) => paraText(p).startsWith("제목 1 스타일")), o: 0 }, -1).paras, "메모가 붙는", "제목 1 스타일"],
    ];
    for (const [file, fn, firstText, secondText] of cases) {
      const bytes = read(file);
      const doc = await open(bytes);
      const before = paras(doc.pages).find((p) => paraText(p).startsWith(secondText))!.runs.find((r) => r.text)!.fontSize;
      editStory(doc, 0, (ps) => fn(ps));
      const out = await save(doc);
      same(out, doc);
      expect(papxOf(out, secondText)).toEqual(papxOf(bytes, firstText));
      const joined = paras(docRichOpen(out, "omw-para.doc").pages).find((p) => paraText(p).includes(secondText))!;
      expect(paraText(joined).startsWith(firstText)).toBe(true);
      expect(joined.runs[joined.runs.length - 1].fontSize).toBe(before);
    }
  });

  it("a list item's Enter (and typing): the new item continues the list", async () => {
    const doc = await open(read(PAGES_DOC));
    editStory(doc, 0, (ps, lc) => {
      const i = ps.findIndex((p) => p.list && paraText(p).includes("번호 하나"));
      const r = enterAt(ps, lc, i, paraText(ps[i]).length);
      return insertText(r.paras, r.pos, "번호 새것").paras;
    });
    const out = await save(doc);
    same(out, doc);
    const ps = paras(docRichOpen(out, "omw-para.doc").pages);
    const n = ps.find((p) => paraText(p).includes("번호 새것"))!;
    expect(n.list).toBeTruthy();
    expect(paraText(n).startsWith("2.")).toBe(true);
    expect(papxOf(out, "번호 새것")).toEqual(papxOf(read(PAGES_DOC), "번호 하나"));
  });

  it("Enter at the end of an item before an empty paragraph (a page break's): the new item, not a copy of the empty one", async () => {
    const doc = await open(read(PAGES_DOC));
    editStory(doc, 0, (ps, lc) => {
      const i = ps.findIndex((p) => p.list && paraText(p).includes("번호 둘"));
      return enterAt(ps, lc, i, paraText(ps[i]).length).paras;
    });
    const out = await save(doc);
    same(out, doc);
  });

  it("an edit the file cannot show as the pages do is still refused (a list item joined with a heading: its number as letters)", async () => {
    const doc = await open(read(TEXT_DOC));
    editStory(doc, 0, (ps) => {
      const i = ps.findIndex((p) => paraText(p).startsWith("제목 1 스타일"));
      return deleteChar(ps, { p: i, o: paraText(ps[i]).length }, 1).paras;
    });
    await expect(save(doc)).rejects.toThrow(REFUSED);
  });
});

describe.runIf(files.length > 0)("random paragraph-boundary edits (seeded): saved as the pages show them, or refused — never lossy", () => {
  it("merges, Enter at the end / start / middle, Enter and typing on every DOC", async () => {
    let seed = 0x5eed;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0), seed / 0x100000000);
    const kinds = ["merge", "endEnter", "startEnter", "midEnter", "endEnterType"] as const;
    const n = { tried: 0, saved: 0 };
    for (const f of files) {
      const bytes = read(f);
      const base = await open(bytes);
      const slots: { seg: number; i: number }[] = [];
      for (const seg of segments(base.pages)) if (isFlowSegment(base.pages, seg)) gatherStory(base.pages, seg).paras.forEach((_, i) => slots.push({ seg: seg.start, i }));
      if (!slots.length) continue;
      for (const kind of kinds)
        for (let t = 0; t < 4; t++) {
          const s = slots[Math.floor(rnd() * slots.length)];
          const doc = await open(bytes);
          const ok = editStory(doc, s.seg, (ps, lc) => {
            const p = ps[s.i];
            const len = paraText(p).length, mk = markerLength(p);
            if (kind === "merge") {
              const q = ps[s.i + 1];
              return q && !markerLength(q) ? deleteChar(ps, { p: s.i, o: len }, 1).paras : null;
            }
            if (kind === "endEnter") return enterAt(ps, lc, s.i, len).paras;
            if (kind === "startEnter") return mk ? null : enterAt(ps, lc, s.i, 0).paras;
            if (kind === "midEnter") return len - mk < 2 ? null : enterAt(ps, lc, s.i, mk + 1 + Math.floor(rnd() * (len - mk - 1))).paras;
            const r = enterAt(ps, lc, s.i, len);
            return insertText(r.paras, r.pos, "omw").paras;
          });
          if (!ok) continue;
          n.tried++;
          let out: Uint8Array;
          try {
            out = await save(doc);
          } catch (e) {
            // (refused: with advice, as any edit the DOC cannot hold)
            expect(String((e as Error).message)).toMatch(/DOCX/i);
            continue;
          }
          n.saved++;
          same(out, doc);
        }
    }
    expect(n.tried).toBeGreaterThan(0);
    // (2026-11-17: 2.3 % of such edits refused over the repo DOCs and corpus #1 — nearly all next to a picture)
    expect(n.saved / n.tried).toBeGreaterThan(0.85);
  }, 600000);
});
