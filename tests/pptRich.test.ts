// PPT opened with its formatting (io/formats/pptRich.ts): the binary records written out as PresentationML and read by
// the PPTX importer — masters, text styles and runs, shapes, pictures, tables, backgrounds, notes, hidden slides — with
// what it does not read named in the warnings; and the PPT save on those pages (pptWrite.ts saveRich): unedited, the
// original bytes; slide text and notes typed, written into the file and read back with the formatting as it was;
// formatting, a master's text, a table cell, a slide's objects changed — refused (save as PPTX).
// Files: every PPT in qa/interop; OMW_LEGACY_FILES=<a.ppt>;… adds local files (not in the repo).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DOMParser } from "@xmldom/xmldom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { lastLegacySave, legacyFingerprint, legacyUnchanged, pptShape, pptTextOnly } from "../src/io/formats/legacyWrite";
import { pptRichOpen, pptToPptx } from "../src/io/formats/pptRich";
import { pptText } from "../src/io/formats/legacy";
import { cfbStreams, readCfb, readCfbTree, writeCfb, type CfbNode } from "../src/io/formats/cfb";
import { strFromU8, unzipSync } from "fflate";
import { bodyFormat, insertText, markerLength, splitParagraph } from "../src/core/richtext";
import type { ImageNode, OmwDocument, TableNode, TextNode, VectorNode } from "../src/core/types";
import { t } from "../src/i18n";
import { custContours } from "../src/io/formats/pptxGeom";
import { cpuNow, cpuBudget, wallTimeout } from "./budget";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const ROOT = process.cwd();
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : /\.(ppt|pps)$/i.test(f) ? [join(d, f)] : []));
const repoFiles = existsSync(join(ROOT, "qa/interop")) ? walk(join(ROOT, "qa/interop")) : [];
const extra = (process.env.OMW_LEGACY_FILES ?? "").split(";").filter((f) => f && /\.(ppt|pps)$/i.test(f) && existsSync(f));
const files = [...repoFiles, ...extra];
const label = (f: string) => (extra.includes(f) ? `local #${extra.indexOf(f) + 1}` : f.slice(ROOT.length + 1).replace(/\\/g, "/"));
const DECK = join(ROOT, "qa/interop/adobe-made/ppt_deck.ppt");
const LDECK = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-deck.ppt");
const SHAPES = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-shapes.ppt");
const TEXT = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-text.ppt");
const read = (f: string) => new Uint8Array(readFileSync(f));
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

async function open(bytes: Uint8Array, name = "omni-rich.ppt"): Promise<OmwDocument & { warnings: string[] }> {
  const r = await formatForExt("ppt")!.open({ name, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {}, warnings: r.warnings ?? [] } as any;
}
const save = async (doc: OmwDocument) => (await exportById("ppt")!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const lines = (n: TextNode) => n.paragraphs.map((p) => p.runs.map((r) => r.text).join("").slice(markerLength(p))).join("\n");
const texts = (doc: OmwDocument) => doc.pages.map((p) => p.nodes.filter((n): n is TextNode => n.type === "TEXT").map(lines));
/** the first text node (of a slide's own, not a master's) whose text includes `s` */
function box(doc: OmwDocument, s: string) {
  for (const [pi, p] of doc.pages.entries())
    for (const [ni, n] of p.nodes.entries()) if (n.type === "TEXT" && lines(n).includes(s)) return { pi, ni, n };
  throw new Error(`no text box with ${s}`);
}
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

describe.each(files.map((f) => [label(f), f] as const))("PPT opened with formatting — %s", (_, file) => {
  it("every slide, every slide text atom in a text box, the notes; deterministic; unedited saves as the original", async () => {
    const bytes = read(file);
    const r = pptRichOpen(bytes, "omni-rich.ppt");
    const plain = pptText(bytes).blocks;
    const slideCount = plain.filter((b) => b.kind === "slide").length;
    expect(r.pages.length).toBe(slideCount);
    // each slide's text (as the text reader reads it) is in its page, line for line
    let k = -1;
    const want: string[][] = [];
    for (const b of plain) {
      if (b.kind === "slide") (k++, want.push([]));
      else if (b.kind === "para") want[k].push(b.text);
    }
    r.pages.forEach((p, i) => {
      const got = p.nodes.flatMap((n, j) => (n.type === "TEXT" && r.texts[i][j] && !r.texts[i][j]!.master ? lines(n).split("\n") : []));
      const tables = p.nodes.flatMap((n) => (n.type === "TABLE" ? (n as TableNode).rows.flat().flatMap((c) => c.text.split("\n")) : []));
      for (const line of want[i].filter((x) => x && !x.includes("*"))) expect([...got, ...tables], `slide ${i + 1}: ${line}`).toContain(line);
    });
    // the notes as the text reader reads them
    const notes = plain.filter((b) => b.kind === "slide").map((b) => (b.kind === "slide" ? b.notes ?? "" : ""));
    expect(r.pages.map((p) => p.notes ?? "")).toEqual(notes);
    // opened twice, the same pages (the PPT save opens the file again and compares)
    expect(legacyFingerprint("ppt", pptRichOpen(bytes, "omni-rich.ppt").pages)).toBe(legacyFingerprint("ppt", r.pages));
    // the app's open: with the formatting, the original kept; unedited → the original bytes
    const doc = await open(bytes);
    expect(doc.pages[0].source?.legacy).toBeTruthy();
    expect(legacyUnchanged(doc.pages, "ppt")).toBe(true);
    const out = await save(doc);
    expect(lastLegacySave.ppt).toBe("original");
    expect(eq(out, bytes)).toBe(true);
  });
});

describe("PPT opened with formatting — what the pages hold (ppt_deck)", () => {
  it("slide size, master text styles, placeholders, shapes, picture, table, master objects, notices", async () => {
    const doc = await open(read(DECK));
    expect(doc.pages.length).toBe(4);
    expect([doc.pages[0].width, doc.pages[0].height]).toEqual([960, 540]); // 10 × 5.625 in
    // title: the master's title style (맑은 고딕, 45 pt on the title slide, 33 pt on the others), black
    const t1 = box(doc, "PowerPoint 시험").n;
    expect(t1.paragraphs[0].runs[0]).toMatchObject({ fontFamily: "맑은 고딕", fontSize: 60, color: "#000000" });
    expect(t1.ph?.type).toBe("ctrTitle");
    const t2 = box(doc, "본문 자리표시자").n;
    expect(t2.paragraphs[0].runs[0].fontSize).toBe(44);
    // bullets: level 1 and 2 of the master's body style (• in Arial, 28 / 24 px), the second paragraph indented
    const body = box(doc, "첫째 항목").n;
    expect(body.paragraphs.map((p) => p.list?.level)).toEqual([0, 1, 0]);
    expect(body.paragraphs[0].runs[0]).toMatchObject({ text: "• ", fontFamily: "Arial" });
    expect(body.paragraphs[1].indentLeft).toBeGreaterThan(body.paragraphs[0].indentLeft ?? 0);
    expect(body.paragraphs[1].runs[1].fontSize).toBeLessThan(body.paragraphs[0].runs[1].fontSize);
    // shapes on slide 3: rectangle, ellipse, right arrow with their fills and the text in them; the picture
    const s3 = doc.pages[2].nodes;
    const vecs = s3.filter((n): n is VectorNode => n.type === "VECTOR").map((v) => v.fill);
    expect(vecs).toEqual(expect.arrayContaining(["#285ac8", "#ff9600", "#00b45a"]));
    expect(lines(box(doc, "사각형").n)).toBe("사각형");
    expect(box(doc, "사각형").n.paragraphs[0].runs[0].color).toBe("#ffffff");
    const img = s3.find((n): n is ImageNode => n.type === "IMAGE")!;
    expect(img).toBeTruthy();
    expect(doc.assets[img.assetId]?.mime).toBe("image/png");
    // the table: 3 × 3 cells with their text and fills
    const tbl = doc.pages[3].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    expect(tbl.rows.map((r) => r.map((c) => c.text))).toEqual([["항목", "Qty", "비고"], ["사과", "3", "red"], ["배", "5", "yellow"]]);
    expect(tbl.rows[0][0].fill).toBe("#4472c4");
    expect(tbl.rows[1][0].fill).toBe("#cfd5ea");
    // the master's own text box is on every slide (marked as the master's)
    for (const p of doc.pages) expect(p.nodes.some((n) => n.type === "TEXT" && lines(n).includes("Master band"))).toBe(true);
    // named: the animation of slide 3, the table's borders
    expect(doc.warnings.join("\n")).toContain(t("pptrich.gap.anim_one", { n: 1 }));
    expect(doc.warnings.join("\n")).toContain(t("pptrich.gap.tableBorder_one", { n: 1 }));
  });

  it("hidden slides, transitions, text boxes and backgrounds of the shapes deck", async () => {
    const doc = await open(read(SHAPES));
    expect(doc.pages.map((p) => !!p.hidden)).toEqual([false, true, false]);
    expect(texts(doc)[0]).toEqual(expect.arrayContaining(["사각형", "글상자 Text box — 도형 슬라이드"]));
    expect(doc.pages.every((p) => p.background === "#ffffff")).toBe(true);
  });

  it("the converter writes a package the importer reads: masters, a layout, the slides, a theme from the colour scheme", () => {
    const cv = pptToPptx(read(LDECK));
    expect(cv.slides.length).toBe(4);
    expect(cv.atoms.size).toBeGreaterThan(4);
    expect(cv.pptx.length).toBeGreaterThan(1000);
  });
});

describe("PPT save on the pages opened with formatting", () => {
  /** open, edit, save as PPT, open again */
  async function edited(file: string, edit: (doc: OmwDocument) => void) {
    const bytes = read(file);
    const doc = await open(bytes);
    edit(doc);
    expect(legacyUnchanged(doc.pages, "ppt")).toBe(false);
    expect(pptTextOnly(doc.pages)).toBe(true);
    const out = await save(doc);
    expect(lastLegacySave.ppt).toBe("text");
    const back = await open(out);
    // the text as edited, every format as it was
    expect(texts(back)).toEqual(texts(doc));
    expect(back.pages.map((p) => p.notes ?? "")).toEqual(doc.pages.map((p) => (p.notes ?? "").replace(/\r\n?/g, "\n")));
    // the other streams byte for byte (but the summaries, which may carry a slide title)
    const a = cfbStreams(readCfbTree(bytes)), b = cfbStreams(readCfbTree(out));
    for (const [k, v] of a) if (!["PowerPoint Document", "Current User", "\u0005SummaryInformation", "\u0005DocumentSummaryInformation"].includes(k)) expect(eq(b.get(k)!, v), k).toBe(true);
    return { bytes, doc, out, back };
  }

  it("letters typed into a shape's text and a title", async () => {
    const { back } = await edited(DECK, (doc) => {
      const a = box(doc, "사각형");
      a.n.paragraphs = insertText(a.n.paragraphs, { p: 0, o: 3 }, " omw").paras;
      const b = box(doc, "본문 자리표시자");
      b.n.paragraphs = insertText(b.n.paragraphs, { p: 0, o: 0 }, "새 ").paras;
    });
    expect(lines(box(back, "사각형 omw").n)).toBe("사각형 omw");
    // the new letters take the formatting of the letters next to them
    expect(box(back, "사각형 omw").n.paragraphs[0].runs.every((r) => r.color === "#ffffff")).toBe(true);
    expect(box(back, "새 본문").n.paragraphs[0].runs[0].fontSize).toBe(44);
  });

  it("Enter at the end of a bullet paragraph with new text; the speaker notes typed", async () => {
    await edited(LDECK, (doc) => {
      const a = box(doc, "하나 one");
      const i = a.n.paragraphs.findIndex((p) => p.runs.map((r) => r.text).join("").includes("하나 one"));
      const len = a.n.paragraphs[i].runs.map((r) => r.text).join("").length;
      // (as the editor splits: the body format, the node's list definitions — RichTextEditor.tsx)
      let x = splitParagraph(a.n.paragraphs, { p: i, o: len }, { body: bodyFormat(a.n.paragraphs), lc: { defs: a.n.lists } });
      x = insertText(x.paras, x.pos, "새 항목 omw");
      a.n.paragraphs = x.paras;
      const p0 = doc.pages[0];
      p0.notes = (p0.notes ?? "") + " — 고침";
    });
  });

  it("refused: a format changed, the master's text, a table cell, a shape moved", async () => {
    const bytes = read(DECK);
    // bold
    let doc = await open(bytes);
    const a = box(doc, "사각형").n;
    a.paragraphs = a.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, bold: !r.bold })) }));
    expect(pptTextOnly(doc.pages)).toBe(false);
    expect(await refusal(doc)).toBe(t("legacysave.err.edited.ppt"));
    // the master's text box, typed into on one slide
    doc = await open(bytes);
    const m = box(doc, "Master band").n;
    m.paragraphs = insertText(m.paragraphs, { p: 0, o: 0 }, "X").paras;
    expect(await refusal(doc)).toContain(t("legacysave.pptWhy.master"));
    // a table cell
    doc = await open(bytes);
    const tbl = doc.pages[3].nodes.find((n): n is TableNode => n.type === "TABLE")!;
    tbl.rows[1][0] = { ...tbl.rows[1][0], text: "사과X", richText: undefined };
    expect(await refusal(doc)).toBe(t("legacysave.err.edited.ppt"));
    // a shape moved
    doc = await open(bytes);
    const v = doc.pages[2].nodes.find((n) => n.type === "VECTOR")!;
    v.transform = { ...v.transform, x: v.transform.x + 10 };
    expect(await refusal(doc)).toBe(t("legacysave.err.edited.ppt"));
  });

  it("a placeholder's text anchored again by the editor (its box top kept) is still a text edit", async () => {
    const doc = await open(read(DECK));
    const a = box(doc, "PowerPoint 시험").n;
    a.paragraphs = insertText(a.paragraphs, { p: 0, o: 0 }, "새 ").paras;
    if (a.ph) {
      // the editor moves a centred placeholder's text when its height changes (core/slides.ts anchored)
      a.ph = { ...a.ph, dy: (a.ph.dy ?? 0) + 5 };
      a.transform = { ...a.transform, y: a.transform.y + 5 };
    }
    expect(pptShape(doc.pages)).toBe((doc.pages[0].source!.legacy as { shape?: string }).shape);
    const out = await save(doc);
    expect(lastLegacySave.ppt).toBe("text");
    expect(lines(box(await open(out), "새 PowerPoint").n)).toContain("새 PowerPoint 시험");
  });
});

describe("PPT open falls back to text", () => {
  it("a file the formatting reader cannot read opens as text, as before", async () => {
    const saved = (globalThis as any).DOMParser;
    (globalThis as any).DOMParser = undefined;
    try {
      const doc = await open(read(DECK));
      expect(doc.pages[0].nodes.every((n) => n.type === "TEXT")).toBe(true);
      expect(doc.warnings[0]).toBe(t("engine.legacy.pptLimited"));
    } finally {
      (globalThis as any).DOMParser = saved;
    }
  });
});

describe("freeform paths (a:custGeom) — the PPT freeforms the converter writes, PPTX freeforms too", () => {
  it("lines, curves and close in the path's own space scaled to the box; unreadable guides: none", () => {
    const xml = `<a:custGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:pathLst><a:path w="100" h="50"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:cubicBezTo><a:pt x="100" y="25"/><a:pt x="50" y="50"/><a:pt x="0" y="50"/></a:cubicBezTo><a:close/></a:path><a:path w="100" h="50" fill="none"><a:moveTo><a:pt x="0" y="25"/></a:moveTo><a:lnTo><a:pt x="100" y="25"/></a:lnTo></a:path></a:pathLst></a:custGeom>`;
    const el = new DOMParser().parseFromString(xml, "application/xml").documentElement as unknown as Element;
    const cs = custContours(el, 200, 100)!;
    expect(cs.length).toBe(2);
    expect(cs[0].closed).toBe(true);
    expect(cs[0].nodes.map((n) => n.anchor)).toEqual([[0, 0], [200, 0], [0, 100]]);
    expect(cs[0].nodes[1].handleOut).toEqual([200, 50]);
    expect(cs[1].closed).toBe(false);
    const bad = new DOMParser().parseFromString(xml.replace('x="100" y="0"', 'x="w" y="0"'), "application/xml").documentElement as unknown as Element;
    expect(custContours(bad, 200, 100)).toBeNull();
  });
});
// ───────────────────────── QA 2026-11-21: dates, hostile files, arcs ─────────────────────────

const DATE = join(ROOT, "qa/interop/powerpoint-made/omni-legacy-ppt-date.ppt");
const streamOf = (root: CfbNode, name: string): CfbNode | undefined => {
  for (const k of root.kids ?? []) {
    if (k.name === name) return k;
    const f = streamOf(k, name);
    if (f) return f;
  }
};
/** every record header of the stream (containers walked) */
function recHeads(s: Uint8Array, from = 0, to = s.length, out: { at: number; type: number; len: number }[] = []) {
  for (let o = from; o + 8 <= to; ) {
    const vi = s[o] | (s[o + 1] << 8), type = s[o + 2] | (s[o + 3] << 8), len = (s[o + 4] | (s[o + 5] << 8) | (s[o + 6] << 16)) + s[o + 7] * 0x1000000;
    if (o + 8 + len > to) break;
    out.push({ at: o, type, len });
    if ((vi & 0xf) === 0xf) recHeads(s, o + 8, o + 8 + len, out);
    o += 8 + len;
  }
  return out;
}
/** the file with its PowerPoint Document stream changed in place (lengths kept) */
function mutated(file: string, f: (s: Uint8Array) => void): Uint8Array {
  const tree = readCfbTree(read(file));
  const n = streamOf(tree.root, "PowerPoint Document")!;
  const s = new Uint8Array(n.data!);
  f(s);
  n.data = s;
  return writeCfb(tree);
}
const put16s = (s: Uint8Array, at: number, text: string) => [...text].forEach((_, i) => ((s[at + i * 2] = text.charCodeAt(i) & 0xff), (s[at + i * 2 + 1] = text.charCodeAt(i) >> 8)));

describe("date fields: the day of the open (QA 2026-11-21)", () => {
  it.runIf(existsSync(DATE))("opened one day and a text edit saved the next: written; the date field's own box typed into: refused, saying why", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date(2026, 10, 21, 23, 59));
      const doc = await open(read(DATE));
      expect(doc.pages[0].source?.legacy?.day).toBe("2026-11-21");
      expect(lines(box(doc, "오늘").n)).toContain("2026-11-21");
      const a = box(doc, "첫 줄 글");
      a.n.paragraphs = insertText(a.n.paragraphs, { p: 0, o: markerLength(a.n.paragraphs[0]) + 2 }, "새 ").paras;
      vi.setSystemTime(new Date(2026, 10, 22, 0, 1));
      const out = await save(doc);
      expect(lastLegacySave.ppt).toBe("text");
      const back = await open(out);
      expect(lines(box(back, "첫 새 줄").n)).toContain("첫 새 줄 글");
      // (opened again today: today's date, as PowerPoint shows it)
      expect(lines(box(back, "오늘").n)).toContain("2026-11-22");
      const d2 = await open(read(DATE));
      const f = box(d2, "오늘").n;
      f.paragraphs = insertText(f.paragraphs, { p: 0, o: 0 }, "X").paras;
      expect(await refusal(d2)).toContain(t("legacysave.pptWhy.special"));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hostile PPT files (QA 2026-11-21)", () => {
  it("text, font and shape names with XML markup and control letters: escaped, every part well formed, no outside relationship", () => {
    const evil = '</a:t>&"\'<b/>\u0001\uffff';
    const font = 'A"/><a:x r:id="&';
    let textAt = -1;
    const bytes = mutated(LDECK, (s) => {
      const hs = recHeads(s);
      // (a text atom a slide shows)
      const shown = new Set(pptRichOpen(read(LDECK), "x.ppt").texts.flat().flatMap((x) => (x && !x.master ? [x.at] : [])));
      const tc = hs.find((h) => h.type === 0x0fa0 && h.len >= evil.length * 2 && shown.has(h.at))!;
      textAt = tc.at;
      put16s(s, tc.at + 8, evil);
      const fe = hs.find((h) => h.type === 0x0fb7)!;
      s.fill(0, fe.at + 8, fe.at + 8 + 64);
      put16s(s, fe.at + 8, font);
    });
    const cv = pptToPptx(bytes);
    const errs: string[] = [];
    const strict = new DOMParser({ errorHandler: { warning: (m: string) => errs.push(m), error: (m: string) => errs.push(m), fatalError: (m: string) => errs.push(m) } } as any);
    const parts = unzipSync(cv.pptx);
    for (const [k, v] of Object.entries(parts)) {
      if (!/\.(xml|rels)$/.test(k)) continue;
      const x = strFromU8(v);
      strict.parseFromString(x, "application/xml");
      if (k.endsWith(".rels")) for (const m of x.matchAll(/Target="([^"]*)"/g)) expect(m[1], k).toMatch(/^(\.\.\/)?[\w./-]+$/);
      expect(x, k).not.toMatch(/TargetMode="External"|<a:hlinkClick/);
    }
    expect(errs).toEqual([]);
    const r = pptRichOpen(bytes, "omni-evil.ppt");
    const all = r.pages.flatMap((p) => p.nodes.flatMap((n) => (n.type === "TEXT" ? [lines(n)] : [])));
    // the letters as written, but those XML cannot hold (and the marker letter in no name)
    expect(all.some((x) => x.includes('</a:t>&"\'<b/>')), JSON.stringify(all.slice(0, 8))).toBe(true);
    expect(all.join("").includes("\u0001")).toBe(false);
    const fonts = new Set(r.pages.flatMap((p) => p.nodes.flatMap((n) => (n.type === "TEXT" ? n.paragraphs.flatMap((q) => q.runs.map((x) => x.fontFamily)) : []))));
    expect(fonts.has(font), JSON.stringify([...fonts])).toBe(true);
    expect(r.texts.flat().some((x) => x?.at === textAt)).toBe(true);
  });

  it("truncated, record lengths and counts broken: each open ends at once — opened, or as text, or a plain error", async () => {
    for (const f of files.slice(0, 4)) {
      const bytes = read(f);
      const cases: Uint8Array[] = [];
      for (const k of [0.1, 0.3, 0.5, 0.7, 0.9, 0.99]) cases.push(bytes.slice(0, Math.floor(bytes.length * k)));
      const hs = recHeads(readCfb(bytes).get("PowerPoint Document")!);
      for (let i = 0; i < 24; i++) {
        const h = hs[Math.floor((i * hs.length) / 24)];
        cases.push(mutated(f, (s) => {
          if (i % 3 === 0) s.set([0xff, 0xff, 0xff, 0x7f], h.at + 4);
          else if (i % 3 === 1) (s[h.at] = 0xff), (s[h.at + 1] = 0xff);
          else for (let k = 8; k < Math.min(h.len + 8, 72); k += 2) (s[h.at + k] = 0xff), (s[h.at + k + 1] = 0xff);
        }));
      }
      for (const c of cases) {
        const t0 = cpuNow();
        try {
          await formatForExt("ppt")!.open({ name: "omni-cut.ppt", path: null, bytes: c }, {} as any);
        } catch (e) {
          expect(e).not.toBeInstanceOf(RangeError);
          expect(String((e as Error).message)).not.toMatch(/Offset is outside|Cannot read properties/);
        }
        expect(cpuNow() - t0).toBeLessThan(cpuBudget(5000));
      }
    }
  }, wallTimeout(120000));
});

describe("a:arcTo in a freeform path (QA 2026-11-21: drawn as a line before)", () => {
  it("a quarter of a circle: cubic pieces on the circle, ending where the arc ends", () => {
    const xml = `<a:custGeom xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="100" y="50"/></a:moveTo><a:arcTo wR="50" hR="50" stAng="0" swAng="5400000"/><a:close/></a:path></a:pathLst></a:custGeom>`;
    const el = new DOMParser().parseFromString(xml, "application/xml").documentElement as unknown as Element;
    const c = custContours(el, 100, 100)![0];
    const end = c.nodes[c.nodes.length - 1];
    expect(end.anchor[0]).toBeCloseTo(50, 6);
    expect(end.anchor[1]).toBeCloseTo(100, 6);
    // the handles of a circle's quarter (0.5523 × r), not a straight line
    expect(c.nodes[0].handleOut[1]).toBeCloseTo(50 + 50 * 0.5523, 2);
    expect(end.handleIn[0]).toBeCloseTo(50 + 50 * 0.5523, 2);
  });
});
describe("typing at the start of a bullet item and next to a field (QA 2026-11-21)", () => {
  it("letters typed right after the bullet take the item's format and save as text; after a slide number field: refused for the field", async () => {
    let doc = await open(read(LDECK));
    const a = box(doc, "하나 one").n;
    const m = markerLength(a.paragraphs[0]);
    a.paragraphs = insertText(a.paragraphs, { p: 0, o: m }, "새 ").paras;
    expect(a.paragraphs[0].runs[0].text.length).toBe(m);
    expect(pptTextOnly(doc.pages)).toBe(true);
    await save(doc);
    expect(lastLegacySave.ppt).toBe("text");
    doc = await open(read(TEXT));
    const f = doc.pages.flatMap((p) => p.nodes).find((n): n is TextNode => n.type === "TEXT" && n.paragraphs.some((q) => q.runs.some((r) => r.field)))!;
    const q = f.paragraphs.findIndex((p) => p.runs.some((r) => r.field));
    f.paragraphs = insertText(f.paragraphs, { p: q, o: f.paragraphs[q].runs.map((r) => r.text).join("").length }, "Z").paras;
    expect(await refusal(doc)).toContain(t("legacysave.pptWhy.special"));
  });
});
