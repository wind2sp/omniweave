// QA hwpx-numbering risk ① (2026-11-17, 문서부): a list read from the file whose format is changed — number format
// (가. → 1)), numbers → bullets, the bullet shape, the start number, the level — must come back so after a one-place
// save (DOCX: a w:num / w:abstractNum of its own, the original definitions left as they are; HWPX: an hh:numbering /
// hh:bullet of its own and the paragraph shape's heading). An outline (개요) numbering changed in an HWPX is written
// anew with a notice. Unedited documents and edits that do not touch numbering keep the original bytes.
import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import * as RT from "../../src/core/richtext";
import { resolveDef } from "../../src/core/lists";
import type { ListDef } from "../../src/core/style/types";
import type { OmwDocument, TextNode, TextParagraph } from "../../src/core/types";
import { exportById, formatForExt } from "../../src/io/formats";
import { installDom } from "../coverage/helpers";

const DOCX = "qa/samples/doc-features/omni-sample.docx";
const HWPX = "qa/samples/doc-features/omni-sample.hwpx";
const HANCOM = "qa/interop/hancom-made/omni-hwp-numbering.hwpx";
const STYLENUM = "qa/interop/word-made/omni-word-stylenum.docx";
const WORDLISTS = "qa/interop/word-made/omni-word-lists.docx";

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
/** the paragraph whose text after its number starts with `s` (else the first holding it), of `role` when given */
const find = (doc: OmwDocument, s: string, role?: string) => {
  const all = paras(doc).filter((q) => !role || q.role === role);
  const body = (q: TextParagraph) => text(q).slice(RT.markerLength(q));
  const p = all.find((q) => body(q).startsWith(s)) ?? all.find((q) => text(q).includes(s));
  if (!p) throw new Error("no paragraph " + s);
  return p;
};
const nodeOf = (doc: OmwDocument, s: string, role?: string) => nodes(doc).find((n) => n.paragraphs.includes(find(doc, s, role)))!;
const part = (bytes: Uint8Array, name: string) => strFromU8(unzipSync(bytes)[name]);

/** what the editor does after a list command: every node renumbered with the counters of the nodes before it */
function renumberAll(doc: OmwDocument) {
  let seed: RT.ListSeed | undefined;
  for (const n of nodes(doc)) {
    const r = RT.renumber(n.paragraphs, { defs: n.lists, seed });
    n.paragraphs = r.paras;
    seed = r.seed;
  }
}

/** the list dialog's 'level format' on an own definition: changed in place (same id) on every node that has it */
function redefineLevel(doc: OmwDocument, defId: string, level: number, patch: Partial<ListDef["levels"][number]>) {
  for (const n of nodes(doc)) {
    const d = n.lists?.find((x) => x.id === defId);
    if (!d) continue;
    n.lists = n.lists!.map((x) => (x.id === defId ? { ...x, levels: x.levels.map((l, i) => (i === level ? { ...l, ...patch } : l)) } : x));
  }
  renumberAll(doc);
}

/** a list command on the paragraphs from `a` to `b` (texts) of one node */
function onNode(doc: OmwDocument, a: string, b: string, fn: (ps: TextParagraph[], from: number, to: number, n: TextNode) => { paras: TextParagraph[] } | null, role?: string) {
  const n = nodeOf(doc, a, role);
  const from = n.paragraphs.indexOf(find(doc, a, role));
  const to = n.paragraphs.indexOf(find(doc, b, role));
  const r = fn(n.paragraphs, from, to, n);
  if (r) n.paragraphs = r.paras;
  renumberAll(doc);
}

/** edit, save in the original format, open the saved file again */
async function round(path: string, edit: (d: OmwDocument) => void, notice = false) {
  const ext = path.split(".").pop()!;
  const doc = await open(path);
  edit(doc);
  const { out, msgs } = await save(doc, ext);
  if (notice) expect(msgs.length).toBeGreaterThan(0);
  else expect(msgs).toEqual([]);
  return { doc, again: await open(path, out), out };
}

/** marker of the paragraph holding `s` as the editor shows it and as the reopened file shows it */
const mk = (doc: OmwDocument, s: string, role?: string) => find(doc, s, role).list?.mk ?? null;

describe("list format QA: number format changed (가. → 1))", () => {
  it.each([
    [DOCX, "docx-a4", "문서 모델에 각주", "구역마다 단 수"],
    [HWPX, "hwpx-n4", "문서 모델에 각주", "구역마다 단 수"],
  ])("%s: level 2 of %s as '1)' comes back so", async (path, def, a, b) => {
    const { doc, again, out } = await round(path, (d) => redefineLevel(d, def, 1, { format: "decimal", text: "%2)" }));
    expect(mk(doc, a)).toBe("1) ");
    expect(mk(again, a)).toBe("1) ");
    expect(mk(again, b)).toBe("2) ");
    // the other levels as they were
    expect(mk(again, "각주·미주와 다단")).toBe("1. ");
    expect(mk(again, "DOCX footnotes")).toBe("1) ");
    expect(mk(again, "편집 중 자동 쪽 넘김")).toBe("3. ");
    // the original definition is not changed (other paragraphs may use it)
    const orig = readFileSync(path);
    if (path.endsWith(".docx")) {
      const abs = /<w:abstractNum\b[^>]*w:abstractNumId="4"[\s\S]*?<\/w:abstractNum>/.exec(part(orig, "word/numbering.xml"))![0];
      expect(part(out, "word/numbering.xml")).toContain(abs);
    } else {
      const num = /<hh:numbering\b[^>]*\sid="4"[\s\S]*?<\/hh:numbering>/.exec(part(orig, "Contents/header.xml"))![0];
      expect(part(out, "Contents/header.xml")).toContain(num);
    }
  });

  it("한글-made HWPX: level 2 of its numbering as 'A.' comes back so", async () => {
    const { again } = await round(HANCOM, (d) => redefineLevel(d, "hwpx-n2", 1, { format: "upperLetter", text: "%2." }));
    expect(mk(again, "각 부서는 지난 석 달")).toBe("A. ");
    expect(paras(again).filter((p) => p.list?.mk === "B. ").length).toBe(1);
    expect(paras(again).filter((p) => p.role === "oli" && p.list?.level === 0).map((p) => p.list!.mk)).toEqual(["1. ", "2. ", "3. "]);
  });

  it("the new numbering is a copy of the original: the levels not changed as 한글 / Word wrote them", async () => {
    const h = await round(HANCOM, (d) => redefineLevel(d, "hwpx-n2", 1, { format: "upperLetter", text: "%2." }));
    const header = part(h.out, "Contents/header.xml");
    const made = /<hh:numbering\b[^>]*\sid="3"[\s\S]*?<\/hh:numbering>/.exec(header)![0];
    // level 8 is ㉮ (CIRCLED_HANGUL_SYLLABLE, read as 가): written as it was, not as the nearest format
    expect(made).toContain('numFormat="CIRCLED_HANGUL_SYLLABLE"');
    expect(made).toMatch(/level="2"[^>]*numFormat="LATIN_CAPITAL"[^>]*>\^2\.</);
    const d = await round(DOCX, (x) => redefineLevel(x, "docx-a4", 1, { format: "decimal", text: "%2)" }));
    const num = part(d.out, "word/numbering.xml");
    const orig = /<w:abstractNum\b[^>]*w:abstractNumId="4"[\s\S]*?<\/w:abstractNum>/.exec(part(new Uint8Array(readFileSync(DOCX)), "word/numbering.xml"))![0];
    const copy = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g;
    const all = Array.from(num.matchAll(copy));
    const mine = all[all.length - 1][0];
    const lvl = (x: string, k: number) => new RegExp(`<w:lvl w:ilvl="${k}"[\\s\\S]*?</w:lvl>`).exec(x)![0];
    expect(lvl(mine, 0)).toBe(lvl(orig, 0));
    expect(lvl(mine, 2)).toBe(lvl(orig, 2));
    expect(lvl(mine, 1)).toContain('<w:numFmt w:val="decimal"/>');
    expect(lvl(mine, 1)).toContain('<w:lvlText w:val="%2)"/>');
  });

  it("DOCX: the numbers of a definition changed and one item's text edited — both kept", async () => {
    const { again } = await round(DOCX, (d) => {
      redefineLevel(d, "docx-a4", 0, { format: "upperRoman", text: "%1." });
      const p = find(d, "편집 중 자동 쪽 넘김");
      p.runs = p.runs.map((r, i, all) => (i === all.length - 1 ? { ...r, text: r.text + " 오메" } : r));
    });
    expect(mk(again, "각주·미주와 다단")).toBe("I. ");
    expect(mk(again, "그림·도형을 DOCX")).toBe("II. ");
    expect(text(find(again, "편집 중 자동 쪽 넘김"))).toBe("III. 편집 중 자동 쪽 넘김(본문 흐름) 오메");
  });
});

describe("list format QA: numbers ↔ bullets", () => {
  it.each([[DOCX], [HWPX]])("%s: numbered items made bullets stay bullets", async (path) => {
    const { again } = await round(path, (d) => onNode(d, "각주·미주와 다단", "편집 중 자동 쪽 넘김", (ps, a, b) => RT.applyList(ps, a, b, "bullet")));
    for (const s of ["각주·미주와 다단", "그림·도형을 DOCX", "편집 중 자동 쪽 넘김"]) {
      expect(find(again, s).role).toBe("li");
      expect(mk(again, s)).toBe("• ");
    }
    expect(mk(again, "문서 모델에 각주")).toBe("◦ ");
  });

  it.each([[DOCX, "원본 보존 저장"], [HWPX, "원본 보존 저장"], [HANCOM, "각 부서는 지난 석 달"]])("%s: a bulleted item made a numbered one stays numbered", async (path, s) => {
    const { again } = await round(path, (d) => onNode(d, s, s, (ps, a, b) => RT.applyList(ps, a, b, "decimal"), "li"));
    const before = await open(path);
    const body = text(find(before, s, "li")).slice(RT.markerLength(find(before, s, "li")));
    expect(paras(again).filter((p) => p.role === "li").length).toBe(paras(before).filter((p) => p.role === "li").length - 1);
    expect(paras(again).some((p) => p.role === "oli" && text(p) === "1. " + body)).toBe(true);
  });

  it.each([
    [DOCX, "docx-a3", "원본 보존 저장", "• "],
    [HWPX, "hwpx-b2", "원본 보존 저장", "• "],
    [HANCOM, "hwpx-b1", "각 부서는 지난 석 달", "● "],
  ])("%s: the bullet of %s changed to ■ comes back so", async (path, def, s, was) => {
    const doc0 = await open(path);
    expect(mk(doc0, s, "li")).toBe(was);
    const { again } = await round(path, (d) => redefineLevel(d, def, 0, { text: "■" }));
    expect(mk(again, s, "li")).toBe("■ ");
    expect(paras(again).filter((p) => p.role === "li" && p.list?.level === 0).every((p) => p.list!.mk === "■ ")).toBe(true);
  });
});

describe("list format QA: start number and level", () => {
  it.each([[DOCX], [HWPX]])("%s: numbering restarted at 5 — the items after it count on from it", async (path) => {
    const { doc, again } = await round(path, (d) => onNode(d, "그림·도형을 DOCX", "그림·도형을 DOCX", (ps, a, _b, n) => RT.setListStart(ps, a, 5, { defs: n.lists })));
    expect(mk(doc, "그림·도형을 DOCX")).toBe("5. ");
    expect(mk(again, "각주·미주와 다단")).toBe("1. ");
    expect(mk(again, "그림·도형을 DOCX")).toBe("5. ");
    expect(mk(again, "편집 중 자동 쪽 넘김")).toBe("6. ");
  });

  it.each([[DOCX], [HWPX], [HANCOM]])("%s: an item one level deeper comes back there", async (path) => {
    const s = path === HANCOM ? "3. 오메 시험 문서의" : "편집 중 자동 쪽 넘김";
    const { doc, again } = await round(path, (d) => onNode(d, s, s, (ps, a, b, n) => RT.changeListLevel(ps, a, b, 1, { defs: n.lists })));
    const probe = path === HANCOM ? "오메 시험 문서의 이 문단은 한글이 줄을 어디에서" : s;
    const want = path === HANCOM ? "다. " : "가. ";
    expect(paras(doc).filter((p) => text(p).includes(probe) && p.list?.level === 1).length).toBeGreaterThan(0);
    expect(paras(again).some((p) => text(p).includes(probe) && p.list?.level === 1 && p.list.mk === want)).toBe(true);
  });
});

describe("list format QA: outline (개요) numbering", () => {
  it("DOCX: heading numbers 1.1. → 1-1 come back so (one-place save)", async () => {
    const { again } = await round(DOCX, (d) => redefineLevel(d, "docx-a2", 1, { text: "%1-%2" }));
    expect(mk(again, "주요 성과")).toBe("1-1 ");
    expect(mk(again, "분기별 지표")).toBe("2-1 ");
    expect(mk(again, "요약 (Executive")).toBe("1. ");
  });

  it("DOCX, numbers from the heading styles (Word-made): level 2 as 1-1 comes back so", async () => {
    const { again } = await round(STYLENUM, (d) => redefineLevel(d, "docx-a0", 1, { text: "%1-%2" }));
    expect(mk(again, "주요 성과")).toBe("1-1 ");
    expect(mk(again, "다음 분기 과제")).toBe("1-2 ");
    expect(mk(again, "실적")).toBe("2. ");
  });

  // (in place since QA 11-25 — a numbering of the new 개요 번호 모양 named by the sections; a file with outline items that
  // are no headings, 개요 7–9, is still written anew with the notice)
  it.each([[HWPX, false], [HANCOM, true]])("%s: the outline numbering changed is kept (written anew with a notice: %s)", async (path, notice) => {
    const def = "hwpx-n1";
    const probe = path === HANCOM ? "개요 2 수준" : "주요 성과";
    const { again } = await round(path, (d) => redefineLevel(d, def, 1, { format: "upperLetter", text: "%2." }), notice);
    expect(mk(again, probe)).toBe("A. ");
  });
});

describe("list format QA: a Word-made document (gallery bullet in Symbol, multi-level numbers: word_make_lists.ps1)", () => {
  it("numbers as I. / A. and the bullet as ■ come back so; Word's own definitions stay", async () => {
    let num = "", bul = "";
    const { again, out } = await round(WORDLISTS, (d) => {
      num = find(d, "첫째 과제").list!.def;
      bul = find(d, "매출 요약").list!.def;
      redefineLevel(d, num, 0, { format: "upperRoman", text: "%1." });
      redefineLevel(d, num, 1, { format: "upperLetter", text: "%2." });
      redefineLevel(d, bul, 0, { text: "■" });
    });
    expect(["첫째 과제", "세부 과제", "둘째 과제", "셋째 과제", "매출 요약", "비용 요약"].map((s) => mk(again, s))).toEqual(["I. ", "A. ", "II. ", "III. ", "■ ", "■ "]);
    const orig = part(new Uint8Array(readFileSync(WORDLISTS)), "word/numbering.xml");
    const now = part(out, "word/numbering.xml");
    for (const m of orig.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)) expect(now).toContain(m[0]);
    // the copies have no nsid of their own (another list), and the new bullet no Symbol font
    const copies = Array.from(now.matchAll(/<w:abstractNum\b[\s\S]*?<\/w:abstractNum>/g)).map((m) => m[0]).filter((x) => !orig.includes(x));
    expect(copies.length).toBe(2);
    for (const c of copies) expect(c).not.toMatch(/<w:nsid\b/);
    const bullet = copies.find((c) => c.includes('w:val="■"'))!;
    expect(/<w:lvl w:ilvl="0"[\s\S]*?<\/w:lvl>/.exec(bullet)![0]).not.toMatch(/Symbol/);
  });

  it("numbers made bullets", async () => {
    const { again } = await round(WORDLISTS, (d) => onNode(d, "첫째 과제", "셋째 과제", (ps, a, b) => RT.applyList(ps, a, b, "bullet")));
    expect(["첫째 과제", "세부 과제", "셋째 과제"].map((s) => mk(again, s))).toEqual(["• ", "◦ ", "• "]);
  });
});

describe("list format QA: what does not touch numbering keeps the bytes", () => {
  it.each([[DOCX], [HWPX], [HANCOM], [STYLENUM], [WORDLISTS]])("%s: unedited — the original bytes", async (path) => {
    const doc = await open(path);
    renumberAll(doc);
    const { out, msgs } = await save(doc, path.split(".").pop()!);
    expect(msgs).toEqual([]);
    expect(Buffer.from(out).equals(readFileSync(path))).toBe(true);
  });

  it.each([[DOCX], [HWPX], [HANCOM]])("%s: a definition set to what it was (a new object) — the original bytes", async (path) => {
    const doc = await open(path);
    for (const n of nodes(doc)) if (n.lists) n.lists = n.lists.map((d) => ({ ...d, levels: d.levels.map((l) => ({ ...l })) }));
    renumberAll(doc);
    const { out } = await save(doc, path.split(".").pop()!);
    expect(Buffer.from(out).equals(readFileSync(path))).toBe(true);
  });

  it.each([[DOCX, "word/numbering.xml"], [HWPX, "Contents/header.xml"], [HANCOM, "Contents/header.xml"]])("%s: a list item's text edited — %s as it was, other items as they were", async (path, name) => {
    const s = path === HANCOM ? "3. 오메 시험 문서의" : "편집 중 자동 쪽 넘김";
    const { out, again } = await round(path, (d) => {
      const p = find(d, s);
      p.runs = p.runs.map((r, i, all) => (i === all.length - 1 ? { ...r, text: r.text + " 오메" } : r));
    });
    expect(part(out, name)).toBe(part(new Uint8Array(readFileSync(path)), name));
    expect(text(find(again, s)).endsWith(" 오메")).toBe(true);
    if (path === DOCX) {
      // only that paragraph's element is different
      const a = part(new Uint8Array(readFileSync(path)), "word/document.xml").split("</w:p>");
      const b = part(out, "word/document.xml").split("</w:p>");
      expect(a.length).toBe(b.length);
      expect(a.filter((x, i) => x !== b[i]).length).toBe(1);
    }
  });

  it("DOCX: the format of a list only one of two lists uses — the other list's numbering as it was", async () => {
    const { out, again } = await round(DOCX, (d) => redefineLevel(d, "docx-a3", 1, { text: "–" }));
    expect(mk(again, "글자 서식 — 취소선")).toBe("– ");
    const orig = part(new Uint8Array(readFileSync(DOCX)), "word/document.xml");
    const now = part(out, "word/document.xml");
    // the numbered list (docx-n4) keeps its w:numId 4
    const ids = (x: string) => Array.from(x.matchAll(/<w:numId w:val="4"\/>/g)).length;
    expect(ids(now)).toBe(ids(orig));
    expect(resolveDef(find(again, "글자 서식 — 취소선").list!.def, nodes(again).flatMap((n) => n.lists ?? [])).levels[1].text).toBe("–");
  });
});
