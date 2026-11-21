// QA list-format (2026-11-17): what the one-place save writes for a list whose numbering changed must number as the
// editor does — in Word (its rules for w:lvlOverride, checked in a hidden new Word: a w:startOverride counts only when
// the w:num has one for level 0 too, and is used again each time that level restarts; w:num instances of one
// w:abstractNum without an override count on from each other) and when Omniweave opens the file again. HWPX: a bullet /
// numbering made by the surgeon has an id from 1 (as 한글 and the full writer number them).
import { readdirSync, readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as RT from "../../src/core/richtext";
import type { OmwDocument, TextNode, TextParagraph } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { installDom } from "../coverage/helpers";

const DOCX = "qa/samples/doc-features/omni-sample.docx";
const HWPX = "qa/samples/doc-features/omni-sample.hwpx";
const WORDLISTS = "qa/interop/word-made/omni-word-lists.docx";
const WORDPARAS = "qa/interop/word-made/omni-word-paragraphs.docx";
const HANCOM_PLAIN = "qa/interop/hancom-made/omni-hwp-fonts.hwpx";
const COMMENTS = "qa/interop/word-made/omni-review-comments.docx";
const TRACKED = "qa/interop/word-made/omni-review-tracked.docx";

async function open(path: string, bytes: Uint8Array = new Uint8Array(readFileSync(path))): Promise<OmwDocument> {
  installDom();
  const r = await formatForExt(path.split(".").pop()!)!.open({ name: path, path: null, bytes }, {} as any);
  return { format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages: r.pages, masters: [], assets: (r as any).assets ?? {} } as OmwDocument;
}
async function save(doc: OmwDocument, ext: string) {
  const msgs: string[] = [];
  const out = (await exportById(ext)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
  return { out, msgs };
}
const nodes = (doc: OmwDocument) => doc.pages.flatMap((p) => [...p.nodes].sort((a, b) => a.transform.y - b.transform.y || a.transform.x - b.transform.x).filter((n): n is TextNode => n.type === "TEXT"));
const paras = (doc: OmwDocument) => nodes(doc).flatMap((n) => n.paragraphs);
const text = (p: TextParagraph) => p.runs.map((r) => r.text).join("");
const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name]);
function renumberAll(doc: OmwDocument) {
  let seed: RT.ListSeed | undefined;
  for (const n of nodes(doc)) {
    const r = RT.renumber(n.paragraphs, { defs: n.lists, seed });
    n.paragraphs = r.paras;
    seed = r.seed;
  }
}
const findP = (doc: OmwDocument, s: string) => {
  const p = paras(doc).find((q) => text(q).slice(RT.markerLength(q)).startsWith(s));
  if (!p) throw new Error("no paragraph " + s);
  return p;
};
function onP(doc: OmwDocument, s: string, fn: (ps: TextParagraph[], i: number, n: TextNode) => { paras: TextParagraph[] } | null) {
  const n = nodes(doc).find((x) => x.paragraphs.includes(findP(doc, s)))!;
  const r = fn(n.paragraphs, n.paragraphs.indexOf(findP(doc, s)), n);
  if (r) n.paragraphs = r.paras;
  renumberAll(doc);
}
/** a list of `def` on `count` paragraphs in a row (plain, not empty) of the `nth` node having them */
function listOn(doc: OmwDocument, def: string, count = 3, nth = 0, ok: (p: TextParagraph) => boolean = () => true): string[] {
  let k = 0;
  for (const n of nodes(doc)) {
    const idx = n.paragraphs.map((p, i) => (text(p).trim() && !p.list && !p.role && ok(p) ? i : -1)).filter((i) => i >= 0);
    for (let j = 0; j + count <= idx.length; j++)
      if (idx[j + count - 1] - idx[j] === count - 1) {
        if (k++ < nth) break;
        n.paragraphs = RT.applyList(n.paragraphs, idx[j], idx[j] + count - 1, def, { defs: n.lists }).paras;
        renumberAll(doc);
        return n.paragraphs.slice(idx[j], idx[j] + count).map((p) => text(p).slice(RT.markerLength(p)));
      }
  }
  throw new Error("no paragraphs for a list");
}
/** markers and texts of the list items, as the editor shows them */
const lists = (doc: OmwDocument) => paras(doc).filter((p) => p.list).map((p) => `${p.list!.mk}${text(p).slice(RT.markerLength(p), RT.markerLength(p) + 10)}`);

/**
 * Word's reading of the overrides (hidden new Word, 2026-11-17): a w:num's w:startOverride counts only when it has one
 * for level 0, and is used again each time its level restarts — so a w:num with an override deeper than level 0 must
 * have one for level 0, and no paragraph of it may come at a shallower level after its first one.
 */
function wordOverridesSafe(out: Uint8Array): string[] {
  const num = part(out, "word/numbering.xml"), doc = part(out, "word/document.xml");
  const bad: string[] = [];
  const order = Array.from(doc.matchAll(/<w:numPr><w:ilvl w:val="(\d+)"\/><w:numId w:val="(\d+)"\/><\/w:numPr>/g), (m) => ({ lvl: Number(m[1]), num: m[2] }));
  for (const m of num.matchAll(/<w:num w:numId="(\d+)">([\s\S]*?)<\/w:num>/g)) {
    const lv = Array.from(m[2].matchAll(/<w:lvlOverride w:ilvl="(\d+)"><w:startOverride/g), (x) => Number(x[1]));
    if (!lv.length) continue;
    const top = Math.max(...lv);
    if (top > 0 && !lv.includes(0)) bad.push(`num ${m[1]}: no level-0 override`);
    const uses = order.filter((u) => u.num === m[1]);
    if (uses.slice(1).some((u) => u.lvl < top)) bad.push(`num ${m[1]}: a level above ${top} after its first paragraph`);
  }
  return bad;
}

describe("list format QA (DOCX): numbering restarted at a deeper level", () => {
  it("a level-2 item restarted at 3, an item made level 2 after the next level-1 one: Word and Omniweave as the editor", async () => {
    const doc = await open(DOCX);
    onP(doc, "문서 모델에 각주", (ps, i, n) => RT.setListStart(ps, i, 3, { defs: n.lists }));
    onP(doc, "편집 중 자동 쪽", (ps, i, n) => RT.changeListLevel(ps, i, i, 1, { defs: n.lists }));
    expect(lists(doc).slice(7, 14)).toEqual(["1. 각주·미주와 다단", "다. 문서 모델에 각주 ", "1) DOCX footn", "2) 각주 번호 필드", "라. 구역마다 단 수·단", "2. 그림·도형을 DOC", "가. 편집 중 자동 쪽 "]);
    const { out, msgs } = await save(doc, "docx");
    expect(msgs).toEqual([]);
    expect(wordOverridesSafe(out)).toEqual([]);
    expect(lists(await open(DOCX, out))).toEqual(lists(doc));
  });

  it("restarted at a deeper level twice in one list (was: written anew)", async () => {
    const doc = await open(DOCX);
    onP(doc, "DOCX footnotes", (ps, i, n) => RT.setListStart(ps, i, 4, { defs: n.lists }));
    onP(doc, "각주 번호 필드", (ps, i, n) => RT.setListStart(ps, i, 9, { defs: n.lists }));
    const { out, msgs } = await save(doc, "docx");
    expect(msgs).toEqual([]);
    expect(wordOverridesSafe(out)).toEqual([]);
    expect(lists(await open(DOCX, out))).toEqual(lists(doc));
  });
});

describe("list format QA (DOCX): lists of one definition", () => {
  it("two lists made in Omniweave with one preset: the second starts at 1 in Word too (an override for level 0)", async () => {
    const doc = await open(WORDPARAS);
    listOn(doc, "decimal", 2, 0);
    listOn(doc, "decimal", 2, 1);
    const { out } = await save(doc, "docx");
    const num = part(out, "word/numbering.xml");
    const made = Array.from(num.matchAll(/<w:num w:numId="(\d+)"><w:abstractNumId w:val="(\d+)"\/>([\s\S]*?)<\/w:num>/g)).slice(-2);
    expect(made.length).toBe(2);
    expect(made[0][2]).toBe(made[1][2]); // one w:abstractNum: Word would count the second list on from the first
    for (const m of made) expect(m[3]).toContain('<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/>');
    expect(lists(await open(WORDPARAS, out))).toEqual(lists(doc));
  });

  it("a changed format saved, opened and saved again: same bytes; a text edit then keeps numbering.xml", async () => {
    const doc = await open(WORDLISTS);
    const def = findP(doc, "첫째 과제").list!.def;
    for (const n of nodes(doc)) if (n.lists?.some((d) => d.id === def)) n.lists = n.lists.map((d) => (d.id === def ? { ...d, levels: d.levels.map((l, i) => (i === 0 ? { ...l, format: "upperRoman", text: "%1." } : l)) } : d));
    renumberAll(doc);
    const first = (await save(doc, "docx")).out;
    const again = await open(WORDLISTS, first);
    renumberAll(again);
    const second = (await save(again, "docx")).out;
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
    const p = findP(again, "둘째 과제");
    p.runs = p.runs.map((r, i, all) => (i === all.length - 1 ? { ...r, text: r.text + " 오메" } : r));
    const third = (await save(again, "docx")).out;
    expect(part(third, "word/numbering.xml")).toBe(part(first, "word/numbering.xml"));
    expect(lists(await open(WORDLISTS, third))).toEqual(lists(again));
  });
});

describe("list format QA (DOCX): a list style (w:numStyleLink, Word-made: word_make_liststyle.ps1)", () => {
  const LS = "qa/interop/word-made/omni-word-liststyle.docx";
  it("the levels come from the style's definition: 1. / 가) / 2. / 3. / 4. as Word numbers them", async () => {
    expect(lists(await open(LS)).map((s) => s.split(" ")[0])).toEqual(["1.", "가)", "2.", "3.", "4."]);
  });

  it("level 1 as I. — the other levels as the style has them (가)), in Word and on opening again", async () => {
    const doc = await open(LS);
    for (const s of ["첫째 과제", "셋째 과제"]) {
      const def = findP(doc, s).list!.def;
      for (const n of nodes(doc)) if (n.lists?.some((d) => d.id === def)) n.lists = n.lists.map((d) => (d.id === def ? { ...d, levels: d.levels.map((l, i) => (i === 0 ? { ...l, format: "upperRoman", text: "%1." } : l)) } : d));
    }
    renumberAll(doc);
    const { out, msgs } = await save(doc, "docx");
    expect(msgs).toEqual([]);
    expect(lists(doc).map((s) => s.split(" ")[0])).toEqual(["I.", "가)", "II.", "III.", "IV."]);
    expect(lists(await open(LS, out))).toEqual(lists(doc));
    // the definitions Word wrote stay; the new one has the style's level 2 (ganada)
    const orig = part(new Uint8Array(readFileSync(LS)), "word/numbering.xml");
    const now = part(out, "word/numbering.xml");
    for (const m of orig.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)) expect(now).toContain(m[0]);
    const made = Array.from(now.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)).map((m) => m[0]).filter((x) => !orig.includes(x));
    expect(made.length).toBe(1);
    expect(made[0]).toMatch(/<w:lvl w:ilvl="1">[\s\S]*?<w:numFmt w:val="ganada"\/><w:lvlText w:val="%2\)"\/>/);
  });
});

describe("list format QA (DOCX): Word's paragraphs kept", () => {
  it("a Word-made list's format changed: only each item's w:numId differs (its runs, style and indents as Word wrote them)", async () => {
    const doc = await open(WORDLISTS);
    const num = findP(doc, "첫째 과제").list!.def, bul = findP(doc, "매출 요약").list!.def;
    for (const [def, lv, patch] of [[num, 0, { format: "upperRoman", text: "%1." }], [num, 1, { format: "upperLetter", text: "%2." }], [bul, 0, { text: "■" }]] as const)
      for (const n of nodes(doc)) if (n.lists?.some((d) => d.id === def)) n.lists = n.lists.map((d) => (d.id === def ? { ...d, levels: d.levels.map((l, i) => (i === lv ? { ...l, ...patch } : l)) } : d));
    renumberAll(doc);
    const { out } = await save(doc, "docx");
    const norm = (x: string) => x.replace(/<w:numId w:val="\d+"\/>/g, "");
    const a = part(new Uint8Array(readFileSync(WORDLISTS)), "word/document.xml"), b = part(out, "word/document.xml");
    expect(a).not.toBe(b);
    expect(norm(b)).toBe(norm(a));
  });
});

describe("list format QA: review marks on list paragraphs", () => {
  it.each([[COMMENTS], [TRACKED]])("%s: a paragraph with comments / tracked changes made a list — marks kept", async (path) => {
    const doc = await open(path);
    const marked = (p: TextParagraph) => p.runs.some((r) => r.comments?.length || r.rev);
    const look = (p: TextParagraph) => JSON.stringify(p.runs.map((r) => [r.text, r.comments ?? null, r.rev?.kind ?? null]).filter((x) => x[0]));
    const before = paras(doc).map(look);
    listOn(doc, "bullet", 1, 0, marked);
    const target = paras(doc).find((p) => p.list)!;
    const { out, msgs } = await save(doc, "docx");
    expect(msgs).toEqual([]);
    const again = await open(path, out);
    expect(lists(again)).toEqual(lists(doc));
    // the runs without the list marker's characters
    const strip = (p: TextParagraph) => {
      let cut = RT.markerLength(p);
      const runs = p.runs.map((r) => {
        const k = Math.min(cut, r.text.length);
        cut -= k;
        return { ...r, text: r.text.slice(k) };
      });
      return look({ ...p, runs });
    };
    expect(paras(again).map(strip)).toEqual(before);
    expect(paras(again).filter((p) => p.list).length).toBe(1);
    expect(text(target).length).toBeGreaterThan(0);
  });
});

describe("list format QA: every DOCX / HWPX of the repository saved unedited — the original bytes", () => {
  const files = (readdirSync("qa", { recursive: true }) as string[]).map((f) => "qa/" + f.replace(/\\/g, "/")).filter((f) => /\.(docx|hwpx)$/.test(f)).sort();
  it(`${files.length} files`, async () => {
    const differ: string[] = [];
    let saved = 0;
    for (const f of files) {
      let doc: OmwDocument;
      try {
        doc = await open(f);
      } catch {
        continue; // encrypted / not a package
      }
      renumberAll(doc);
      const { out } = await save(doc, f.endsWith(".hwpx") ? "hwpx" : "docx");
      saved++;
      if (!Buffer.from(out).equals(readFileSync(f))) differ.push(f);
    }
    expect(saved).toBeGreaterThan(60);
    expect(differ).toEqual([]);
  }, 120_000);
});

describe("list format QA (HWPX): numbering / bullets made by the surgeon", () => {
  it("a bulleted list made in a 한글 file without bullets: hh:bullet id 1 (not 0), the shape names it", async () => {
    const doc = await open(HANCOM_PLAIN);
    const items = listOn(doc, "bullet", 2);
    const { out, msgs } = await save(doc, "hwpx");
    expect(msgs).toEqual([]);
    const h = part(out, "Contents/header.xml");
    expect(Array.from(h.matchAll(/<hh:bullet\b[^>]*\sid="(\d+)"/g), (m) => m[1])).toEqual(["1"]);
    expect(h).toMatch(/<hh:heading type="BULLET" idRef="1" level="0"\/>/);
    expect(h).not.toMatch(/type="BULLET" idRef="0"/);
    const again = await open(HANCOM_PLAIN, out);
    expect(lists(again)).toEqual(lists(doc));
    expect(items.every((s) => paras(again).some((p) => p.role === "li" && text(p).slice(RT.markerLength(p)) === s))).toBe(true);
  });

  it("a numbered list made in a 한글 file: one-place save (no notice), the text and numbers as the editor's", async () => {
    const doc = await open(HANCOM_PLAIN);
    listOn(doc, "decimal", 3);
    const { out, msgs } = await save(doc, "hwpx");
    expect(msgs).toEqual([]);
    const again = await open(HANCOM_PLAIN, out);
    expect(lists(again)).toEqual(lists(doc));
    expect(paras(again).map(text)).toEqual(paras(doc).map(text));
    // the 한글 numbering stays, the new one has the next id
    const orig = part(new Uint8Array(readFileSync(HANCOM_PLAIN)), "Contents/header.xml");
    const h = part(out, "Contents/header.xml");
    expect(h).toContain(/<hh:numbering\b[\s\S]*?<\/hh:numbering>/.exec(orig)![0]);
    expect(Array.from(h.matchAll(/<hh:numbering\b[^>]*\sid="(\d+)"/g), (m) => m[1])).toEqual(["1", "2"]);
  });

  it("a deeper-level restart, an item made deeper after the next level-1 one: numberings per segment (was: 1. / 다. on opening again)", async () => {
    const doc = await open(HWPX);
    onP(doc, "문서 모델에 각주", (ps, i, n) => RT.setListStart(ps, i, 3, { defs: n.lists }));
    onP(doc, "편집 중 자동 쪽", (ps, i, n) => RT.changeListLevel(ps, i, i, 1, { defs: n.lists }));
    const { out, msgs } = await save(doc, "hwpx");
    expect(msgs).toEqual([]);
    expect(lists(await open(HWPX, out))).toEqual(lists(doc));
    // the segment from the restarted item: level 1 at the number of the item it is under, level 2 at 3; the next
    // level-1 item starts another at 2 (a paraHead start is used each time its level restarts)
    const h = part(out, "Contents/header.xml");
    const heads = (id: string) => Array.from(/<hh:numbering\b[^>]*\sid="(\d+)"[\s\S]*?<\/hh:numbering>/g[Symbol.matchAll](h)).find((m) => m[1] === id)![0];
    expect(heads("5")).toMatch(/<hh:paraHead start="1" level="1"[\s\S]*<hh:paraHead start="3" level="2"/);
    expect(heads("6")).toMatch(/<hh:paraHead start="2" level="1"/);
  });

  it("a level-0 restart still in place: the numbers as the editor's", async () => {
    const doc = await open(HWPX);
    onP(doc, "그림·도형을", (ps, i, n) => RT.setListStart(ps, i, 5, { defs: n.lists }));
    const { out, msgs } = await save(doc, "hwpx");
    expect(msgs).toEqual([]);
    expect(lists(await open(HWPX, out))).toEqual(lists(doc));
  });
});
