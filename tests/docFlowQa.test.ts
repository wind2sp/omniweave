// QA (body flow 1단계, DOC_FLOW.md): imported Word / 한글 files keep their bytes through the flow, one edited paragraph
// changes only that paragraph, and the layout terminates on stories that are hard to lay out.
import { DOMParser } from "@xmldom/xmldom";
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { caretBox, flowLines, gatherStory, isFlowSegment, reflowPages, reflowSegment, segmentAt, segments } from "../src/core/flow";
import { bodyBox } from "../src/core/pageSetup";
import * as RT from "../src/core/richtext";
import { newPage, newParagraph, newTable, newText, type OmwDocument, type Page, type TextParagraph, type TextRun } from "../src/core/types";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const FILES = [
  "qa/samples/doc-features/omni-sample.docx",
  "qa/samples/doc-features/omni-sample.hwpx",
  "qa/interop/word-made/omni-word-pages.docx",
  "qa/interop/word-made/omni-word-paragraphs.docx",
  "qa/interop/word-made/omni-word-table.docx",
  "qa/interop/omniweave-made/doc-01-formatting.docx",
  "qa/interop/omniweave-made/doc-02-formatting.hwpx",
  "qa/interop/adobe-made/word_doc.docx",
  "qa/interop/adobe-made/hwpx_doc.hwpx",
  "qa/interop/hancom-made/omni-hwp-breaking.hwpx",
  "qa/interop/hancom-made/omni-hwp-controls.hwpx",
  "qa/interop/hancom-made/omni-hwp-margins.hwpx",
  "qa/interop/hancom-made/omni-hwp-pages.hwpx",
  "qa/interop/hancom-made/omni-hwp-ratio-spacing.hwpx",
];

const ext = (f: string) => f.slice(f.lastIndexOf(".") + 1) as "docx" | "hwpx";
async function open(f: string): Promise<{ doc: OmwDocument; bytes: Uint8Array }> {
  const bytes = new Uint8Array(readFileSync(f));
  const r = await formatForExt(ext(f))!.open({ name: f.slice(f.lastIndexOf("/") + 1), path: null, bytes }, {} as any);
  const doc = { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
  return { doc, bytes };
}
const save = async (doc: OmwDocument, f: string) => (await exportById(ext(f))!.run(doc, doc.pages[0], { confirm: () => true })) as Uint8Array;
const textOf = (p: TextParagraph) => p.runs.map((r) => r.text).join("");

/** XML parts that differ between two zips */
function changedParts(a: Uint8Array, b: Uint8Array): string[] {
  const za = unzipSync(a), zb = unzipSync(b);
  const names = new Set([...Object.keys(za), ...Object.keys(zb)]);
  return [...names].filter((n) => !za[n] || !zb[n] || Buffer.compare(Buffer.from(za[n]), Buffer.from(zb[n])) !== 0);
}

/** paragraphs (w:p / hp:p, top level text only) of the body part that differ */
function changedParas(a: Uint8Array, b: Uint8Array, part: string): string[] {
  const re = /<(w|hp):p[ >][\s\S]*?<\/\1:p>/g;
  const pa = strFromU8(unzipSync(a)[part]).match(re) ?? [];
  const pb = strFromU8(unzipSync(b)[part]).match(re) ?? [];
  const sa = new Set(pa);
  return pb.filter((x) => !sa.has(x));
}

describe("QA body flow: imported files through the flow", () => {
  for (const f of FILES) {
    it(`${f}: flowing every run without an edit saves the same bytes`, async () => {
      const { doc } = await open(f);
      const before = await save(doc, f);
      const flowed = reflowPages(doc.pages);
      const after = await save({ ...doc, pages: flowed }, f);
      expect(changedParts(before, after)).toEqual([]);
      expect(Buffer.compare(Buffer.from(before), Buffer.from(after))).toBe(0);
    });

    it(`${f}: editing one paragraph in a flowed run rewrites only that paragraph`, async () => {
      const { doc } = await open(f);
      const before = await save(doc, f);
      // the longest body paragraph of a flowing run
      let best: { seg: number; p: number; len: number } | null = null;
      for (const s of segments(doc.pages)) {
        if (!isFlowSegment(doc.pages, s)) continue;
        gatherStory(doc.pages, s).paras.forEach((q, i) => {
          const len = textOf(q).length;
          // (not a section's first paragraph: in 한글 it holds the section's header / footer controls, nested paragraphs)
          if (i > 0 && len > 4 && !q.list && (!best || len > best.len)) best = { seg: s.start, p: i, len };
        });
      }
      if (!best) return;
      const b = best as { seg: number; p: number; len: number };
      const edit = (q: TextParagraph) => ({ ...q, runs: q.runs.map((r, k) => (k === 0 ? { ...r, text: r.text.slice(0, 2) + "QA" + r.text.slice(2) } : r)) });
      const target = gatherStory(doc.pages, segmentAt(doc.pages, b.seg)).paras[b.p];
      // the same edit without the flow (the paragraph where the importer put it): what the writer changes for it
      const direct = doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" && n.paragraphs.some((q) => q.id === target.id) ? { ...n, paragraphs: n.paragraphs.map((q) => (q.id === target.id ? edit(q) : q)) } : n)) }));
      const ref = await save({ ...doc, pages: direct }, f);
      const flowed = reflowPages(doc.pages);
      const st = gatherStory(flowed, segmentAt(flowed, b.seg));
      expect(st.paras[b.p].id).toBe(target.id);
      const paras = st.paras.map((q, i) => (i === b.p ? edit(q) : q));
      const pages = reflowSegment(flowed, b.seg, { ...st, paras });
      const after = await save({ ...doc, pages }, f);
      // the flow adds nothing to it: the file is the one the plain edit writes
      expect(changedParts(ref, after)).toEqual([]);
      const parts = ext(f) === "docx" ? ["word/document.xml"] : changedParts(before, after).filter((n) => /Contents\/section\d+\.xml$/.test(n));
      expect(parts.map((part) => strFromU8(unzipSync(after)[part])).join("")).toContain(edit(target).runs[0].text.slice(0, 5).replace(/&/g, "&amp;").replace(/</g, "&lt;"));
      if (ext(f) === "docx") expect(changedParas(before, after, "word/document.xml").length).toBe(1);
    });
  }
});

describe("QA body flow: editing helpers shared with the text box editor", () => {
  it("pasteData: HTML from Word keeps bold / italic and replaces the selection; plain text splits paragraphs; nothing = null", () => {
    const paras = [{ ...newParagraph("앞 선택 뒤", { fontSize: 16 }) }];
    const sel = { start: { p: 0, o: 2 }, end: { p: 0, o: 4 } };
    const base = RT.formatAt(paras, sel.start);
    const html = '<html><body><!--StartFragment--><p class=MsoNormal><b>굵게</b> 보통</p><p><i>둘째</i></p><!--EndFragment--></body></html>';
    const r = RT.pasteData(paras, sel, base, html, "굵게 보통\n둘째")!;
    expect(r.paras.map(textOf)).toEqual(["앞 굵게 보통", "둘째 뒤"]);
    expect(r.paras[0].runs.find((x) => x.text.includes("굵게"))!.bold).toBe(true);
    expect(r.paras[1].runs.find((x) => x.text.includes("둘째"))!.italic).toBe(true);
    const t = RT.pasteData(paras, { start: { p: 0, o: 0 }, end: { p: 0, o: 0 } }, base, "", "a\r\nb")!;
    expect(t.paras.map(textOf)).toEqual(["a", "b앞 선택 뒤"]);
    expect(RT.pasteData(paras, sel, base, "", "")).toBeNull();
  });

  it("a line break inside a paragraph (Shift+Enter) flows as one paragraph with a new line", () => {
    const p0 = newParagraph("첫 줄둘째 줄", { fontSize: 16 });
    const r = RT.insertRun([p0], { p: 0, o: 2 }, { ...RT.plainFormat(RT.formatAt([p0], { p: 0, o: 2 })), text: "\n" } as TextRun);
    expect(r.paras.length).toBe(1);
    expect(textOf(r.paras[0])).toBe("첫 \n줄둘째 줄");
    const pages = (() => {
      const pg = newPage("DOCUMENT", 794, 1123, "1");
      const box = bodyBox(pg);
      const t = newText("", box.w);
      t.paragraphs = r.paras;
      t.flow = true;
      t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
      pg.nodes.push(t);
      return reflowPages([pg]);
    })();
    const lines = flowLines(pages, segmentAt(pages, 0));
    expect(lines.length).toBe(2);
    expect([lines[0].start, lines[0].end, lines[1].start]).toEqual([0, 2, 3]);
    expect(caretBox(lines, 0, 3)!.y).toBeGreaterThan(caretBox(lines, 0, 2)!.y);
  });
});

describe("QA body flow: hard stories end", () => {
  const flowDoc = (paras: TextParagraph[], w = 794, h = 1123): Page[] => {
    const p = newPage("DOCUMENT", w, h, "1");
    const box = bodyBox(p);
    const t = newText("", box.w);
    t.paragraphs = paras;
    t.flow = true;
    t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    p.nodes.push(t);
    return [p];
  };
  const para = (s: string, extra: Partial<TextParagraph> = {}) => ({ ...newParagraph(s, { fontSize: 16 }), ...extra });

  it("a keep-with-next chain longer than a page, keep-lines paragraphs longer than a page", () => {
    const chain = Array.from({ length: 120 }, (_, i) => para(`제목 ${i}`, { keepNext: true }));
    const big = para("긴 문단 ".repeat(3000), { keepLines: true });
    const pages = reflowPages(flowDoc([...chain, big, para("끝")]));
    expect(pages.length).toBeGreaterThan(3);
    const st = gatherStory(pages, segmentAt(pages, 0));
    expect(st.paras.length).toBe(122);
    expect(textOf(st.paras[120])).toBe(textOf(big));
    expect(reflowPages(pages)).toBe(pages);
  });

  it("paragraphs and tables cut at page ends come back as the same objects: an edit near the end keeps the pages before it", () => {
    const paras = Array.from({ length: 8 }, (_, i) => para(`${i} ` + "흐름 시험 문단입니다. ".repeat(400)));
    const pages = reflowPages(flowDoc(paras));
    expect(pages.some((pg) => pg.nodes.some((n) => n.type === "TEXT" && n.paragraphs.some((q) => q.flowSplit)))).toBe(true);
    expect(reflowPages(pages)).toBe(pages);
    const st = gatherStory(pages, segmentAt(pages, 0));
    const last = st.paras.length - 1;
    const edited = st.paras.map((q, i) => (i === last ? { ...q, runs: [{ ...q.runs[0], text: q.runs[0].text + "끝" }] } : q));
    const out = reflowSegment(pages, 0, { ...st, paras: edited });
    const lastPage = out.findIndex((pg) => pg.nodes.some((n) => n.type === "TEXT" && n.paragraphs.some((q) => q.id === st.paras[last].id)));
    for (let i = 0; i < lastPage; i++) expect(out[i]).toBe(pages[i]);
    // a table split over pages: the same pieces too
    const p0 = flowDoc([para("앞"), para("뒤")]);
    const box = bodyBox(p0[0]);
    const tb = newTable([["머리", "값"], ...Array.from({ length: 90 }, (_, i) => [`행 ${i}`, String(i)])], [box.w / 2, box.w / 2]);
    tb.headerRow = true;
    tb.flow = true;
    tb.transform = { x: box.x, y: box.y + 30, rotation: 0, scale: 1 };
    const fr = p0[0].nodes[0] as any;
    p0[0].nodes = [{ ...fr, paragraphs: [fr.paragraphs[0]] }, tb, { ...fr, id: "f2", paragraphs: [fr.paragraphs[1]], transform: { ...fr.transform, y: box.y + 900 } }];
    const tp = reflowPages(p0);
    expect(tp.length).toBeGreaterThan(1);
    expect(reflowPages(tp)).toBe(tp);
  });

  it("an empty story, a story of one empty paragraph", () => {
    const pages = reflowPages(flowDoc([para("")]));
    expect(pages.length).toBe(1);
    const st = gatherStory(pages, segmentAt(pages, 0));
    expect(st.paras.length).toBe(1);
  });

  it("a table row taller than a page goes on its own page and the flow ends", () => {
    const pages0 = flowDoc([para("앞"), para("뒤")]);
    const box = bodyBox(pages0[0]);
    const tall = "아주 긴 셀 ".repeat(2500);
    const tb = newTable([["머리", "값"], ["1", tall], ["2", "짧음"]], [box.w / 2, box.w / 2]);
    tb.headerRow = true;
    tb.flow = true;
    tb.transform = { x: box.x, y: box.y + 30, rotation: 0, scale: 1 };
    pages0[0].nodes.push(tb);
    const fr = pages0[0].nodes[0] as any;
    pages0[0].nodes[0] = { ...fr, paragraphs: [fr.paragraphs[0]] };
    pages0[0].nodes.push({ ...fr, id: "f2", paragraphs: [fr.paragraphs[1]], transform: { ...fr.transform, y: box.y + 900 } });
    const pages = reflowPages(pages0);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.length).toBeLessThan(10);
    expect(reflowPages(pages)).toBe(pages);
  });

  it("sections with different paper keep their own body width", () => {
    const a = flowDoc([para("가 ".repeat(4000))]);
    const b = flowDoc([para("나 ".repeat(4000))], 1123, 794);
    b[0].breakBefore = "section";
    const pages = reflowPages([...a, ...b]);
    const segs = segments(pages);
    expect(segs.length).toBe(2);
    for (const s of segs) for (let i = s.start; i < s.end; i++) expect(pages[i].width).toBe(pages[s.start].width);
    for (const pg of pages) for (const n of pg.nodes) if (n.type === "TEXT") expect(n.width).toBeCloseTo(bodyBox(pg).w, 3);
  });
});
