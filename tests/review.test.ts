// Comments and tracked changes (메모·변경 내용 추적, core/review.ts) — stage 1: read from Word / 한글 files, shown in the
// markup and final views, listed for the review panel, and kept byte for byte by the Office Surgeon while untouched.
// Test files: qa/interop/scripts/word_make_review.ps1 (Word) and hwp_make_review.ps1 (한글 2024), author 'Omniweave QA'.

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { parseDocxFlow, parseHwpxFlow, type OfficeItem } from "../src/io/office";
import { reflowPages } from "../src/core/flow";
import { acceptedPages, acceptedText, collectChanges, commentThreads, commentedText, docComments, hasReview, pageParagraphs, reviewLook, setReviewView, skipHidden } from "../src/core/review";
import * as RT from "../src/core/richtext";
import { officePages } from "../src/io/formats/flow";
import { docxMeta } from "../src/io/officesurgeon/docx";
import { hwpxMeta } from "../src/io/officesurgeon/hwpx";
import { fontsChanged, layoutText } from "../src/core/text";
import { pagesToMarkdown } from "../src/io/formats/markdown";
import { newText, type OmwDocument, type Page, type TextParagraph, type TextRun } from "../src/core/types";
import { readZip } from "../src/io/officesurgeon/zip";

const COMMENTS = "qa/interop/word-made/omni-review-comments.docx";
const TRACKED = "qa/interop/word-made/omni-review-tracked.docx";
const MEMO = "qa/interop/hancom-made/omni-hwp-memo.hwpx";
const HTRACK = "qa/interop/hancom-made/omni-hwp-tracked.hwpx";
const QA = "Omniweave QA";

const bytesOf = (f: string) => new Uint8Array(readFileSync(f));
const docOf = (pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets });
async function open(kind: "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name: `x.${kind}`, path: null, bytes }, {} as any);
  return docOf(r.pages!, (r as any).assets ?? {});
}
async function save(kind: "docx" | "hwpx", doc: OmwDocument) {
  return (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
}
const textOf = (p: Pick<TextParagraph, "runs">) => p.runs.map((r) => r.text).join("");
const paras = (items: OfficeItem[]) => items.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras));
const runsWith = (items: OfficeItem[], f: (r: TextRun) => boolean) => paras(items).flatMap((p) => p.runs.filter(f));
function changedEntries(a: Uint8Array, b: Uint8Array) {
  const za = readZip(a)!, zb = readZip(b)!;
  return zb.entries
    .filter((e) => {
      const o = za.entries.find((x) => x.name === e.name);
      return !o || !Buffer.from(b.subarray(e.start, e.end)).equals(Buffer.from(a.subarray(o.start, o.end)));
    })
    .map((e) => e.name);
}
/** The document with every body paragraph passed through `f` (frames rebuilt, the flow run again). */
function editParas(doc: OmwDocument, f: (p: TextParagraph) => TextParagraph): OmwDocument {
  const pages = doc.pages.map((pg) => ({ ...pg, nodes: pg.nodes.map((n) => (n.type === "TEXT" && n.flow ? { ...n, paragraphs: n.paragraphs.map(f) } : n)) }));
  return { ...doc, pages: reflowPages(pages) };
}
/** paragraph text with `from` replaced by `to` in its run holding `from` */
const replaceIn = (p: TextParagraph, from: string, to: string): TextParagraph => ({ ...p, runs: p.runs.map((r) => (r.text.includes(from) ? { ...r, text: r.text.replace(from, to) } : r)) });

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});
afterEach(() => {
  setReviewView("markup");
  fontsChanged();
});

describe("review: DOCX comments (Word-made)", () => {
  it("reads comments.xml with authors, dates, replies and the resolved mark", () => {
    const report = { notesDropped: 0 } as Parameters<typeof parseDocxFlow>[1] & object;
    parseDocxFlow(bytesOf(COMMENTS), report);
    const cs = report.layout!.comments!;
    expect(cs.map((c) => c.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(cs.every((c) => c.author === QA && c.initials === "OQ" && /^2026-/.test(c.date ?? ""))).toBe(true);
    expect(cs[0].text).toBe("오메 시험 메모 1 — 숫자 출처를 각주로 달아 주세요.");
    // the reply answers comment 0; comment 2 is resolved
    expect(cs[1].parent).toBe("0");
    expect(cs[2].done).toBe(true);
    expect(cs.filter((c) => c.done).length).toBe(1);
    const threads = commentThreads(cs);
    expect(threads.map((t) => [t.c.id, t.replies.map((r) => r.id)])).toEqual([["0", ["1"]], ["2", []], ["3", []], ["4", []]]);
  });

  it("marks each comment's range on the runs it covers (over several character formats, in a table cell)", () => {
    const items = parseDocxFlow(bytesOf(COMMENTS));
    const covered = (id: string) => runsWith(items, (r) => !!r.comments?.includes(id)).map((r) => r.text).join("");
    expect(covered("0")).toBe("매출과 비용, 다음 분기의 계획");
    expect(covered("1")).toBe("매출과 비용, 다음 분기의 계획");
    expect(covered("2")).toBe("quarterly review");
    expect(covered("3")).toBe("문단은");
    expect(covered("4")).toBe("1,234,567");
    // the body text itself is unchanged (no comment text in the body)
    expect(textOf(paras(items)[1])).toBe("Omni 분기 보고서는 이번 분기의 매출과 비용, 다음 분기의 계획을 한 문서에 정리합니다.");
    expect(commentedText(paras(items), "0")).toBe("매출과 비용, 다음 분기의 계획");
  });

  it("puts the comments on the first page of the opened document", async () => {
    const doc = await open("docx", bytesOf(COMMENTS));
    expect(docComments(doc.pages).length).toBe(5);
    expect(hasReview(doc.pages)).toBe(true);
  });
});

describe("review: DOCX tracked changes (Word-made)", () => {
  it("reads insertions, deletions, moves and format changes with author and date", () => {
    const items = parseDocxFlow(bytesOf(TRACKED));
    const ps = paras(items);
    const ins = runsWith(items, (r) => r.rev?.kind === "ins").map((r) => r.text).join("");
    expect(ins).toBe(" 빠짐없이");
    const del = runsWith(items, (r) => r.rev?.kind === "del");
    expect(del.map((r) => r.text)).toEqual([" 위험 요소와 대응 방안을 함께"]);
    expect(del[0].rev!.author).toBe(QA);
    expect(del[0].rev!.date).toMatch(/^2026-/);
    // a move: the text where it went and where it was, each read once
    const moved = "마지막 문단은 검토 의견을 모아 다음 회의 안건으로 넘깁니다.";
    expect(runsWith(items, (r) => r.rev?.kind === "moveTo").map((r) => r.text).join("")).toBe(moved);
    expect(runsWith(items, (r) => r.rev?.kind === "moveFrom").map((r) => r.text).join("")).toBe(moved);
    expect(runsWith(items, (r) => !r.rev && r.text.includes("마지막 문단은")).length).toBe(0);
    // character format change (bold) and paragraph format change (centred)
    const fmt = runsWith(items, (r) => !!r.fmtRev);
    expect(fmt.map((r) => r.text)).toEqual(["revenue, cost"]);
    expect(fmt[0].bold).toBe(true);
    const centred = ps.find((p) => textOf(p).startsWith("The quarterly review"))!;
    expect(centred.fmtRev?.kind).toBe("fmt");
    expect(centred.align).toBe("CENTER");
    // the moved paragraph's mark is a move too
    expect(ps.filter((p) => p.markRev).map((p) => p.markRev!.kind).sort()).toEqual(["moveFrom", "moveTo"]);
    // the comment on the inserted word
    expect(runsWith(items, (r) => !!r.comments?.length).map((r) => r.text).join("")).toBe("빠짐없이");
  });

  it("an older map's view (noReview) reads the file as before: deleted text left out", () => {
    const items = parseDocxFlow(bytesOf(TRACKED), { notesDropped: 0, noReview: true });
    expect(runsWith(items, (r) => !!r.rev || !!r.comments).length).toBe(0);
    expect(paras(items).map(textOf).join("|")).not.toContain("위험 요소와");
  });

  it("lists the changes in reading order for the review panel", () => {
    const ch = collectChanges(paras(parseDocxFlow(bytesOf(TRACKED))));
    expect(ch.map((c) => c.kind)).toEqual(["ins", "del", "moveTo", "para", "fmt", "moveFrom"]);
    // (the empty last paragraph's mark format change, w:pPr/w:rPr/w:rPrChange, is read but not listed: Word 2024 does
    // not count the document's last mark either — doc-review3)
    expect(paras(parseDocxFlow(bytesOf(TRACKED))).at(-1)?.markFmtRev?.kind).toBe("fmt");
    expect(ch.every((c) => c.author === QA)).toBe(true);
    expect(ch[0].text).toBe(" 빠짐없이");
  });
});

describe("review: HWPX memos and tracked changes (한글 2024-made)", () => {
  it("reads memos as comments: author, time, text — the body keeps its paragraphs whole", () => {
    const report = { notesDropped: 0 } as Parameters<typeof parseHwpxFlow>[1] & object;
    const items = parseHwpxFlow(bytesOf(MEMO), report);
    const cs = report.layout!.comments!;
    expect(cs.map((c) => c.text)).toEqual(["오메 시험 메모 1 — 숫자 출처를 각주로 달아 주세요.", "오메 시험 메모 2 — 부서 이름을 적어 주세요.", "오메 시험 메모 3 — 표 칸 안 메모입니다."]);
    expect(cs.every((c) => c.author === QA && /^2026-/.test(c.date ?? ""))).toBe(true);
    const ps = paras(items);
    // no memo text in the body; the paragraph the memo is in is one paragraph
    expect(ps.map(textOf).join("|")).not.toContain("오메 시험 메모");
    expect(ps.map(textOf)).toContain("Omni 분기 보고서는 이번 분기의 매출과 비용, 다음 분기의 계획을 한 문서에 정리합니다.");
    const covered = (id: string) => runsWith(items, (r) => !!r.comments?.includes(id)).map((r) => r.text).join("");
    expect(covered(cs[0].id)).toBe("매출과 비용, 다음 분기의 계획");
    expect(covered(cs[1].id)).toBe("각 부서");
    expect(covered(cs[2].id)).toBe("1,234,567");
  });

  it("reads insertions and deletions (also one over two paragraphs) with the header's author and date", () => {
    const items = parseHwpxFlow(bytesOf(HTRACK));
    const ins = runsWith(items, (r) => r.rev?.kind === "ins");
    expect(ins.map((r) => r.text)).toEqual(["이번 판: ", " 빠짐없이"]);
    expect(ins.every((r) => r.rev!.author === QA && /^2026-/.test(r.rev!.date ?? ""))).toBe(true);
    const del = runsWith(items, (r) => r.rev?.kind === "del");
    expect(del.map((r) => r.text)).toEqual([" 위험 요소와 대응 방안을 함께", "니다.", "마지막 "]);
    // deleted text is still in the paragraph (shown struck through)
    expect(paras(items).map(textOf)).toContain("각 부서는 지난 석 달 동안의 실적을 바탕으로 목표를 다시 세우고, 위험 요소와 대응 방안을 함께 적어 주시기 바랍니다.");
  });

  it("an older map's view (noReview) reads memo text as body paragraphs, as the importer before did", () => {
    const items = parseHwpxFlow(bytesOf(MEMO), { notesDropped: 0, noReview: true });
    expect(paras(items).map(textOf).join("|")).toContain("오메 시험 메모 1");
  });
});

describe("review: views", () => {
  const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ text, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000", ...extra });
  const node = () => {
    const t = newText("", 600);
    t.paragraphs = [{ ...t.paragraphs[0], runs: [run("keep "), run("gone ", { rev: { kind: "del", author: QA } }), run("new", { rev: { kind: "ins", author: QA }, comments: ["c1"] })] }];
    return t;
  };

  it("markup: inserted text underlined, deleted struck through in the author's colour, commented text shaded", () => {
    const [keep, gone, added] = node().paragraphs[0].runs.map(reviewLook);
    expect(keep.underline || keep.strike || keep.highlight).toBeFalsy();
    expect(gone.strike).toBe(true);
    expect(gone.color).not.toBe("#000000");
    expect(added.underline).toBe(true);
    expect(added.color).toBe(gone.color); // one author, one colour
    expect(added.highlight).toBeTruthy();
  });

  it("final: deleted text takes no room and nothing is marked", () => {
    const markup = layoutText(node()).lines[0];
    setReviewView("final");
    fontsChanged();
    const fin = layoutText(node()).lines[0];
    const goneM = markup.pieces.find((p) => p.text.startsWith("gone"))!;
    const goneF = fin.pieces.find((p) => p.text.startsWith("gone"))!;
    expect(goneM.width).toBeGreaterThan(0);
    expect(goneF.width).toBe(0);
    expect(goneF.hidden).toBe(true);
    expect(fin.width).toBeLessThan(markup.width);
    // the pieces still hold every character (story offsets count the hidden text)
    expect(fin.pieces.map((p) => p.text).join("")).toBe("keep gone new");
    expect(reviewLook(node().paragraphs[0].runs[2]).underline).toBe(false);
  });

  it("writers without tracked changes get the accepted text (Markdown)", async () => {
    const doc = await open("docx", bytesOf(TRACKED));
    const md = pagesToMarkdown(doc.pages);
    expect(md).toContain("빠짐없이");
    expect(md).not.toContain("위험 요소와");
    expect((md.match(/마지막 문단은/g) ?? []).length).toBe(1);
    const acc = acceptedPages(doc.pages);
    expect(pageParagraphs(acc).some((p) => p.runs.some((r) => r.rev || r.comments))).toBe(false);
    expect(acc[0].comments).toBeUndefined();
    // the document itself is not changed
    expect(pageParagraphs(doc.pages).some((p) => p.runs.some((r) => r.rev?.kind === "del"))).toBe(true);
  });
});

describe("review: editing next to tracked changes and comments (QA 2026-11-15)", () => {
  const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ text, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000", ...extra });
  const para = (runs: TextRun[]): TextParagraph => ({ id: "p1", runs, align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 0 });
  const DEL = { kind: "del", author: QA, src: "7" } as const;
  const marks = (p: TextParagraph) => p.runs.map((r) => [r.text, r.rev?.kind ?? "", (r.comments ?? []).join(",")]);

  it("typing in a paragraph never merges a deletion, an insertion or a comment range into its plain neighbours", () => {
    const p = para([run("keep "), run("gone ", { rev: DEL }), run("new", { rev: { kind: "ins", author: QA } }), run(" tail", { comments: ["c1"] }), run(" end")]);
    const { paras } = RT.insertText([p], { p: 0, o: 0 }, ">");
    expect(marks(paras[0])).toEqual([
      [">keep ", "", ""],
      ["gone ", "del", ""],
      ["new", "ins", ""],
      [" tail", "", "c1"],
      [" end", "", ""],
    ]);
    // two insertions of different authors stay two changes
    const q = para([run("a", { rev: { kind: "ins", author: "A" } }), run("b", { rev: { kind: "ins", author: "B" } })]);
    expect(RT.mergeRuns(q.runs).length).toBe(2);
    // the same change split by an edit joins again
    expect(RT.mergeRuns([run("go", { rev: DEL }), run("ne", { rev: DEL })]).map((r) => r.text)).toEqual(["gone"]);
  });

  it("DOCX: text typed into a paragraph with a deletion → the deletion is still a deletion after saving", async () => {
    const bytes = bytesOf(TRACKED);
    const doc = await open("docx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("각 부서는") ? RT.insertText([p], { p: 0, o: 0 }, "[1] ").paras[0] : p));
    const back = paras(parseDocxFlow(await save("docx", edited)));
    const p = back.find((q) => textOf(q).startsWith("[1] 각 부서는"))!;
    expect(p.runs.filter((r) => r.rev?.kind === "del").map((r) => r.text).join("")).toBe(" 위험 요소와 대응 방안을 함께");
  });

  it("HWPX: text typed into a paragraph with a deletion → the deleted text does not come back as text (stage 2: still a deletion)", async () => {
    const bytes = bytesOf(HTRACK);
    const doc = await open("hwpx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("각 부서는") ? RT.insertText([p], { p: 0, o: 0 }, "[1] ").paras[0] : p));
    const out = (await exportById("hwpx")!.run(edited, edited.pages[0], { confirm: () => true } as any)) as Uint8Array;
    const p = paras(parseHwpxFlow(out)).map(acceptedText).find((q) => q.startsWith("[1] 각 부서는"))!;
    expect(p).not.toContain("위험 요소와");
    const q = paras(parseHwpxFlow(out)).find((x) => textOf(x).startsWith("[1] 각 부서는"))!;
    expect(q.runs.filter((r) => r.rev?.kind === "del").map((r) => r.text).join("")).toContain("위험 요소와");
  });

  it("DOCX edited in the final view (pages laid out without the deleted text): only the edited paragraph changes", async () => {
    const bytes = bytesOf(TRACKED);
    const doc = await open("docx", bytes);
    setReviewView("final");
    fontsChanged();
    const edited = editParas(doc, (p) => (textOf(p).startsWith("각 부서는") ? RT.insertText([p], { p: 0, o: 0 }, "[1] ").paras[0] : p));
    const out = await save("docx", edited);
    expect(changedEntries(bytes, out)).toEqual(["word/document.xml"]);
    const ps = (b: Uint8Array) => strFromU8(unzipSync(b)["word/document.xml"]).match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
    const before = ps(bytes), after = ps(out);
    expect(after.length).toBe(before.length);
    expect(after.filter((x, k) => x !== before[k]).length).toBe(1);
  });

  it("final view: Backspace and Delete skip the hidden deleted text (it is not removed unseen), the caret steps over it", () => {
    const p = para([run("ab"), run("XY", { rev: DEL }), run("cd")]);
    setReviewView("final");
    // caret after the hidden 'XY' (o 4): Backspace removes 'b', not 'Y'
    let r = RT.deleteChar([p], { p: 0, o: 4 }, -1);
    expect(marks(r.paras[0])).toEqual([["a", "", ""], ["XY", "del", ""], ["cd", "", ""]]);
    expect(r.pos).toEqual({ p: 0, o: 1 });
    // caret before the hidden 'XY' (o 2): Delete removes 'c'
    r = RT.deleteChar([p], { p: 0, o: 2 }, 1);
    expect(marks(r.paras[0])).toEqual([["ab", "", ""], ["XY", "del", ""], ["d", "", ""]]);
    // the markup view shows the deleted text: there Backspace takes its last character as before
    setReviewView("markup");
    expect(RT.paraText(RT.deleteChar([p], { p: 0, o: 4 }, -1).paras[0])).toBe("abXcd");
    setReviewView("final");
    // a caret step from before the hidden text goes past it and the next visible character
    expect(skipHidden(p, 2, 1)).toBe(4);
    expect(skipHidden(p, 4, -1)).toBe(2);
    expect(skipHidden(p, 1, 1)).toBe(1);
  });
});

describe("review: an .omw saved before model 9 (map of model 8) still opens and saves (QA 2026-11-15)", () => {
  /** the document as the importer before model 9 opened it: no review marks, its map of model 8 */
  async function openModel8(kind: "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
    const now = await open(kind, bytes);
    const office = now.pages[0].source!.office!;
    const asset = now.assets[office.assetId];
    const report: any = { notesDropped: 0, noReview: true, pictures: [], ...(kind === "docx" ? { blockItems: [], afterTableParas: true } : { sectionBlocks: [] }) };
    const items = kind === "docx" ? parseDocxFlow(bytes, report) : parseHwpxFlow(bytes, report);
    const pages = officePages(items, "x", report.layout, report.lists, []);
    pages.forEach((p) => (p.source = { format: kind, name: `x.${kind}` }));
    const meta = (kind === "docx" ? docxMeta(pages, report.blockItems, { id: asset.id, hash: asset.hash }) : hwpxMeta(pages, report.sectionBlocks, { id: asset.id, hash: asset.hash }))!;
    meta.model = 8;
    pages[0].source!.office = meta;
    expect(hasReview(pages)).toBe(false);
    return docOf(pages, { [asset.id]: asset });
  }

  it("unedited: every file saves as its original bytes", async () => {
    for (const [kind, f] of [["docx", COMMENTS], ["docx", TRACKED], ["hwpx", MEMO], ["hwpx", HTRACK]] as const) {
      const bytes = bytesOf(f);
      expect(Buffer.from(await save(kind, await openModel8(kind, bytes))).equals(Buffer.from(bytes)), f).toBe(true);
    }
  });

  it("one paragraph edited: only it changes, the other paragraphs with their comments and changes byte for byte", async () => {
    for (const [kind, f, part] of [["docx", TRACKED, "word/document.xml"], ["hwpx", MEMO, "Contents/section0.xml"]] as const) {
      const bytes = bytesOf(f);
      const doc = await openModel8(kind, bytes);
      const edited = editParas(doc, (p) => (textOf(p).startsWith("마지막 문단은") && !textOf(p).includes("새 말") ? RT.insertText([p], { p: 0, o: 0 }, "새 말 ").paras[0] : p));
      const out = await save(kind, edited);
      expect(changedEntries(bytes, out), f).toEqual([part]);
      const o = strFromU8(unzipSync(bytes)[part]);
      const n = strFromU8(unzipSync(out)[part]);
      expect(n).toContain("새 말");
      const tag = kind === "docx" ? /<w:p [^>]*>[\s\S]*?<\/w:p>/g : /<hp:p [^>]*>[\s\S]*?<\/hp:p>/g;
      const before = [...o.matchAll(tag)].map((m) => m[0]);
      const kept = before.filter((x) => n.includes(x)).length;
      // every paragraph but the edited one(s) is the original element
      expect(before.length - kept, f).toBeLessThanOrEqual(kind === "docx" ? 2 : 1);
    }
  });
});

describe("review: the Office Surgeon keeps comments and changes", () => {
  it("unedited: every file saves as its original bytes", async () => {
    for (const [kind, f] of [["docx", COMMENTS], ["docx", TRACKED], ["hwpx", MEMO], ["hwpx", HTRACK]] as const) {
      const bytes = bytesOf(f);
      const doc = await open(kind, bytes);
      expect(Buffer.from(await save(kind, doc)).equals(Buffer.from(bytes)), f).toBe(true);
    }
  });

  it("DOCX: one paragraph edited elsewhere → only document.xml changes, the comment parts and commented paragraphs byte for byte", async () => {
    const bytes = bytesOf(COMMENTS);
    const doc = await open("docx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("각 부서는") ? replaceIn(p, "석 달", "세 달") : p));
    const out = await save("docx", edited);
    expect(changedEntries(bytes, out)).toEqual(["word/document.xml"]);
    const o = strFromU8(unzipSync(bytes)["word/document.xml"]);
    const n = strFromU8(unzipSync(out)["word/document.xml"]);
    // the other paragraphs (with their comment ranges and references) are the original elements
    for (const m of o.matchAll(/<w:p [^>]*>[\s\S]*?<\/w:p>/g)) if (!m[0].includes("석 달")) expect(n).toContain(m[0]);
    const back = parseDocxFlow(out);
    expect(runsWith(back, (r) => !!r.comments?.includes("0")).map((r) => r.text).join("")).toBe("매출과 비용, 다음 분기의 계획");
  });

  it("DOCX: the commented and tracked paragraph itself edited → its comment range, insertion and the comment stay", async () => {
    const bytes = bytesOf(TRACKED);
    const doc = await open("docx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("Omni 분기 보고서는") ? replaceIn(p, "Omni 분기", "Omni 1분기") : p));
    const out = await save("docx", edited);
    expect(changedEntries(bytes, out)).toEqual(["word/document.xml"]);
    const back = parseDocxFlow(out);
    const p = paras(back).find((q) => textOf(q).startsWith("Omni 1분기"))!;
    expect(p.runs.filter((r) => r.rev?.kind === "ins").map((r) => r.text).join("")).toBe(" 빠짐없이");
    expect(p.runs.filter((r) => r.comments?.includes("1")).map((r) => r.text).join("")).toBe("빠짐없이");
    expect(p.runs.filter((r) => r.rev?.kind === "ins")[0].rev!.author).toBe(QA);
  });

  it("DOCX: a paragraph with a deletion edited → the deleted text is written as a deletion again, never as text", async () => {
    const bytes = bytesOf(TRACKED);
    const doc = await open("docx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("각 부서는") ? replaceIn(p, "석 달", "세 달") : p));
    const out = await save("docx", edited);
    const back = paras(parseDocxFlow(out));
    const p = back.find((q) => textOf(q).startsWith("각 부서는"))!;
    expect(textOf(p)).toContain("세 달");
    expect(p.runs.filter((r) => r.rev?.kind === "del").map((r) => r.text).join("")).toBe(" 위험 요소와 대응 방안을 함께");
    const accepted = paras(parseDocxFlow(out, { notesDropped: 0, noReview: true })).map(textOf);
    expect(accepted.join("|")).not.toContain("위험 요소와");
  });

  it("HWPX: one paragraph edited → the memos and the other paragraphs stay byte for byte", async () => {
    const bytes = bytesOf(MEMO);
    const doc = await open("hwpx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("마지막 문단은") ? replaceIn(p, "다음 회의", "다음 주 회의") : p));
    const out = await save("hwpx", edited);
    expect(changedEntries(bytes, out)).toEqual(["Contents/section0.xml"]);
    const report = { notesDropped: 0 } as Parameters<typeof parseHwpxFlow>[1] & object;
    const back = parseHwpxFlow(out, report);
    expect(report.layout!.comments!.length).toBe(3);
    expect(paras(back).map(textOf)).toContain("마지막 문단은 검토 의견을 모아 다음 주 회의 안건으로 넘깁니다.");
    const o = strFromU8(unzipSync(bytes)["Contents/section0.xml"]);
    const n = strFromU8(unzipSync(out)["Contents/section0.xml"]);
    for (const m of o.matchAll(/<hp:fieldBegin [^>]*type="MEMO"[\s\S]*?<\/hp:fieldBegin>/g)) expect(n).toContain(m[0]);
  });

  it("HWPX: a paragraph with a deletion edited → the deleted text does not come back as text (stage 2: written as a deletion again)", async () => {
    const bytes = bytesOf(HTRACK);
    const doc = await open("hwpx", bytes);
    const edited = editParas(doc, (p) => (textOf(p).startsWith("각 부서는") ? replaceIn(p, "석 달", "세 달") : p));
    const r = await exportById("hwpx")!.run(edited, edited.pages[0], { confirm: () => true } as any);
    const out = r as Uint8Array;
    const back = paras(parseHwpxFlow(out)).map(acceptedText);
    const p = back.find((q) => q.startsWith("각 부서는"))!;
    expect(p).toContain("세 달");
    expect(p).not.toContain("위험 요소와");
    // the untouched insertion in the paragraph before is still the file's own
    expect(runsWith(parseHwpxFlow(out), (x) => x.rev?.kind === "ins").map((x) => x.text)).toEqual(["이번 판: ", " 빠짐없이"]);
  });
});
