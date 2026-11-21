// Comments and tracked changes, stage 2 — saving what was added, answered, recorded, accepted and rejected in Omniweave
// (DOCX: Office Surgeon and a new file; HWPX: Office Surgeon). Test files: qa/interop (author 'Omniweave QA').

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { exportDocx, parseDocxFlow, parseHwpxFlow, type OfficeItem } from "../src/io/office";
import { docComments, setReviewAuthor, setTracking } from "../src/core/review";
import { mapStories, newComment, pickAll, resolveChanges, setThreadDone, tagComment, tagReply, untagComments, withComments, editComment } from "../src/core/reviewEdit";
import * as RT from "../src/core/richtext";
import type { OmwDocument, Page, TextParagraph, TextRun } from "../src/core/types";
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
  const out = (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
  // every XML part written is well-formed (a strict parse, not the importer's lenient one)
  for (const [name, data] of Object.entries(unzipSync(out)))
    if (/\.(xml|rels|hpf)$/.test(name)) {
      const errors: string[] = [];
      new DOMParser({ errorHandler: { warning: (m: string) => void errors.push(m), error: (m: string) => void errors.push(m), fatalError: (m: string) => void errors.push(m) } } as any).parseFromString(strFromU8(data), "text/xml");
      expect(errors, `${kind} ${name}`).toEqual([]);
    }
  return out;
}
const textOf = (p: Pick<TextParagraph, "runs">) => p.runs.map((r) => r.text).join("");
const paras = (items: OfficeItem[]) => items.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras));
const runsWith = (items: OfficeItem[], f: (r: TextRun) => boolean) => paras(items).flatMap((p) => p.runs.filter(f));
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);
function changedEntries(a: Uint8Array, b: Uint8Array) {
  const za = readZip(a)!, zb = readZip(b)!;
  return zb.entries
    .filter((e) => {
      const o = za.entries.find((x) => x.name === e.name);
      return !o || !Buffer.from(b.subarray(e.start, e.end)).equals(Buffer.from(a.subarray(o.start, o.end)));
    })
    .map((e) => e.name)
    .sort();
}
/** the story position of `needle` in the paragraph starting with `start` */
function at(ps: TextParagraph[], start: string, needle: string): RT.Range {
  const p = ps.findIndex((q) => textOf(q).startsWith(start));
  const o = textOf(ps[p]).indexOf(needle);
  return { start: { p, o }, end: { p, o: o + needle.length } };
}
/** the document with a new comment on `needle` of the paragraph starting with `start` */
function comment(doc: OmwDocument, start: string, needle: string, body: string, parent?: string) {
  const c = newComment(body, parent);
  let done = false;
  const pages = mapStories(doc.pages, (ps) => {
    if (done || !ps.some((q) => textOf(q).startsWith(start))) return ps;
    done = true;
    return tagComment(ps, at(ps, start, needle), c.id)!;
  });
  return { doc: { ...doc, pages: withComments(pages, [...docComments(doc.pages), c]) }, c };
}
/** the document with `fn` run on the story holding the paragraph starting with `start`, changes recorded */
function recorded(doc: OmwDocument, start: string, fn: (ps: TextParagraph[]) => TextParagraph[]): OmwDocument {
  setTracking(true);
  try {
    return { ...doc, pages: mapStories(doc.pages, (ps) => (ps.some((q) => textOf(q).startsWith(start)) ? fn(ps) : ps)) };
  } finally {
    setTracking(false);
  }
}

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});
afterEach(() => {
  setTracking(false);
  setReviewAuthor("");
});

describe("DOCX (Office Surgeon): comments made in Omniweave", () => {
  it("a new comment: comments.xml gets it, its range and reference are in the paragraph, the other comments stay", async () => {
    setReviewAuthor(QA);
    const bytes = bytesOf(COMMENTS);
    const { doc } = comment(await open("docx", bytes), "각 부서는", "석 달", "오메 2단계 새 메모");
    const out = await save("docx", doc);
    expect(changedEntries(bytes, out)).toEqual(["word/comments.xml", "word/commentsExtended.xml", "word/commentsIds.xml", "word/document.xml"]);
    const report = { notesDropped: 0 } as Parameters<typeof parseDocxFlow>[1] & object;
    const items = parseDocxFlow(out, report);
    const cs = report.layout!.comments!;
    expect(cs.length).toBe(6);
    const mine = cs.find((c) => c.text === "오메 2단계 새 메모")!;
    expect(mine.author).toBe(QA);
    expect(mine.id).toBe("5");
    expect(runsWith(items, (r) => !!r.comments?.includes("5")).map((r) => r.text).join("")).toBe("석 달");
    // the comments of the other paragraphs are as they were
    expect(runsWith(items, (r) => !!r.comments?.includes("0")).map((r) => r.text).join("")).toBe("매출과 비용, 다음 분기의 계획");
    const o = part(bytes, "word/comments.xml");
    const n = part(out, "word/comments.xml");
    for (const m of o.matchAll(/<w:comment\b[\s\S]*?<\/w:comment>/g)) expect(n).toContain(m[0]);
    // one range start, one end and one reference per comment
    const d = part(out, "word/document.xml");
    for (const id of ["0", "1", "2", "3", "4", "5"]) {
      expect(d.match(new RegExp(`<w:commentRangeStart w:id="${id}"/>`, "g"))?.length, id).toBe(1);
      expect(d.match(new RegExp(`<w:commentRangeEnd w:id="${id}"/>`, "g"))?.length, id).toBe(1);
      expect(d.match(new RegExp(`<w:commentReference w:id="${id}"/>`, "g"))?.length, id).toBe(1);
    }
  });

  it("a reply, resolving, editing and deleting a comment: commentsExtended links them, the deleted one goes everywhere", async () => {
    setReviewAuthor(QA);
    const bytes = bytesOf(COMMENTS);
    let doc = await open("docx", bytes);
    // reply to comment 3, resolve comment 0's thread, edit comment 4, delete comment 2
    const r = newComment("답글입니다", "3");
    doc = { ...doc, pages: withComments(mapStories(doc.pages, (ps) => tagReply(ps, "3", r.id)), [...docComments(doc.pages), r]) };
    let list = setThreadDone(docComments(doc.pages), "0", true);
    list = editComment(list, "4", "고친 메모 4");
    list = list.filter((c) => c.id !== "2");
    doc = { ...doc, pages: withComments(mapStories(doc.pages, (ps) => untagComments(ps, new Set(["2"]))), list) };
    const out = await save("docx", doc);
    const report = { notesDropped: 0 } as Parameters<typeof parseDocxFlow>[1] & object;
    const items = parseDocxFlow(out, report);
    const cs = report.layout!.comments!;
    expect(cs.map((c) => c.id)).toEqual(["0", "1", "3", "4", "5"]);
    expect(cs.find((c) => c.id === "5")!.parent).toBe("3");
    expect(cs.find((c) => c.id === "5")!.text).toBe("답글입니다");
    expect(cs.filter((c) => c.done).map((c) => c.id)).toEqual(["0", "1"]);
    expect(cs.find((c) => c.id === "4")!.text).toBe("고친 메모 4");
    expect(runsWith(items, (x) => !!x.comments?.includes("5")).map((x) => x.text).join("")).toBe("문단은");
    const d = part(out, "word/document.xml");
    expect(d).not.toMatch(/w:id="2"\/>/);
    expect(part(out, "word/comments.xml")).not.toContain("quarterly review");
    expect(part(out, "word/commentsIds.xml").match(/<w16cid:commentId /g)!.length).toBe(5);
  });
});

describe("DOCX (Office Surgeon): changes recorded, accepted and rejected in Omniweave", () => {
  it("typing and deleting with changes recorded → w:ins / w:del of the reviewer, the file's own changes kept", async () => {
    setReviewAuthor(QA);
    const bytes = bytesOf(COMMENTS);
    let doc = await open("docx", bytes);
    doc = recorded(doc, "각 부서는", (ps) => {
      const r = at(ps, "각 부서는", "석 달");
      let x = RT.deleteRange(ps, r);
      x = RT.insertText(x.paras, x.pos, "세 달");
      return x.paras;
    });
    doc = { ...doc, pages: [{ ...doc.pages[0], trackChanges: true }, ...doc.pages.slice(1)] };
    const out = await save("docx", doc);
    const p = paras(parseDocxFlow(out)).find((q) => textOf(q).startsWith("각 부서는"))!;
    expect(p.runs.filter((r) => r.rev?.kind === "del").map((r) => r.text)).toEqual(["석 달"]);
    expect(p.runs.filter((r) => r.rev?.kind === "ins").map((r) => r.text)).toEqual(["세 달"]);
    expect(p.runs.find((r) => r.rev?.kind === "ins")!.rev!.author).toBe(QA);
    expect(part(out, "word/document.xml")).toMatch(/<w:ins w:id="\d+" w:author="Omniweave QA" w:date="\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ">/);
    // recording on is saved with the document (Word opens it with 변경 내용 추적 on)
    expect(part(out, "word/settings.xml")).toContain("<w:trackRevisions/>");
    // and read back
    const again = await open("docx", out);
    expect(again.pages[0].trackChanges).toBe(true);
  });

  it("Enter and Backspace at a paragraph start with changes recorded: the paragraph mark's w:ins / w:del", async () => {
    setReviewAuthor(QA);
    const bytes = bytesOf(COMMENTS);
    let doc = await open("docx", bytes);
    doc = recorded(doc, "각 부서는", (ps) => {
      const i = ps.findIndex((q) => textOf(q).startsWith("각 부서는"));
      const s = RT.splitParagraph(ps, { p: i, o: 6 }).paras;
      // Backspace at the start of the paragraph after "각 부서는 …": its original mark struck
      return RT.deleteChar(s, { p: i + 2, o: 0 }, -1).paras;
    });
    const out = await save("docx", doc);
    const ps = paras(parseDocxFlow(out));
    const i = ps.findIndex((q) => textOf(q).startsWith("각 부서는"));
    expect(textOf(ps[i])).toBe("각 부서는 ");
    expect(ps[i].markRev?.kind).toBe("ins");
    expect(ps[i + 1].markRev?.kind).toBe("del");
    expect(textOf(ps[i + 2])).toMatch(/^The /);
  });

  it("accept all / reject all on Word's tracked file: no changes left, the text as accepted / as before", async () => {
    const bytes = bytesOf(TRACKED);
    const doc = await open("docx", bytes);
    for (const accept of [true, false]) {
      const out = await save("docx", { ...doc, pages: mapStories(doc.pages, (ps) => resolveChanges(ps, accept, pickAll).paras) });
      const items = parseDocxFlow(out);
      expect(runsWith(items, (r) => !!r.rev || !!r.fmtRev).length, String(accept)).toBe(0);
      expect(paras(items).some((p) => p.markRev || p.fmtRev), String(accept)).toBe(false);
      const all = paras(items).map(textOf).join("|");
      expect(all.includes("위험 요소와"), String(accept)).toBe(!accept);
      expect(all.includes("빠짐없이"), String(accept)).toBe(accept);
      // the moved paragraph is there once
      expect((all.match(/마지막 문단은/g) ?? []).length, String(accept)).toBe(1);
      const d = part(out, "word/document.xml");
      expect(d, String(accept)).not.toMatch(/<w:(ins|del|moveFrom|moveTo|pPrChange|moveFromRangeStart|moveToRangeStart|moveFromRangeEnd|moveToRangeEnd)\b/);
      // (a format change of a paragraph mark is not in the model yet: the last empty paragraph keeps its mark's)
      expect((d.match(/<w:rPrChange\b/g) ?? []).length, String(accept)).toBeLessThanOrEqual(1);
      // the comment on the inserted word: still there when accepted, gone with its text when rejected
      const cs = (b: Uint8Array) => { const rep = { notesDropped: 0 } as any; parseDocxFlow(b, rep); return rep.layout.comments ?? []; };
      expect(cs(out).length, String(accept)).toBe(accept ? 1 : 0);
    }
  });

  it("a moved paragraph edited: its move is written as a move again (w:moveTo), not as an insertion (QA risk 5)", async () => {
    const bytes = bytesOf(TRACKED);
    const doc = await open("docx", bytes);
    // (an edit inside the moved text: one character more)
    const edited = mapStories(doc.pages, (ps) => ps.map((p) => (p.runs.some((r) => r.rev?.kind === "moveTo") ? { ...p, runs: p.runs.map((r) => (r.rev?.kind === "moveTo" ? { ...r, text: r.text.replace("다음 회의", "다음 주 회의") } : r)) } : p)));
    const out = await save("docx", { ...doc, pages: edited });
    const items = parseDocxFlow(out);
    expect(runsWith(items, (r) => r.rev?.kind === "moveTo").map((r) => r.text).join("")).toContain("다음 주 회의");
    expect(runsWith(items, (r) => r.rev?.kind === "moveFrom").length).toBeGreaterThan(0);
    expect(part(out, "word/document.xml")).toMatch(/<w:moveTo w:id=/);
  });
});

describe("DOCX written anew: comments.xml and tracked changes (QA risk 2, DOCX)", () => {
  it("a document with comments, a reply, a resolved one and tracked changes", () => {
    setReviewAuthor(QA);
    const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ text, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000", ...extra });
    const c1 = newComment("첫 메모");
    const c2 = newComment("답글", c1.id);
    const c3 = { ...newComment("해결한 메모"), done: true as const };
    const p1: TextParagraph = { id: "a", runs: [run("앞 "), run("메모 단 글자", { comments: [c1.id, c2.id] }), run(" 뒤")], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 0 };
    const p2: TextParagraph = { id: "b", runs: [run("지운 ", { rev: { kind: "del", author: QA, date: "2026-11-15T10:00:00" } }), run("넣은", { rev: { kind: "ins", author: QA, date: "2026-11-15T10:00:00" }, comments: [c3.id] })], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 0, markRev: { kind: "ins", author: QA } };
    const p3: TextParagraph = { id: "c", runs: [run("끝")], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 0 };
    const page: Page = { id: "pg", kind: "DOCUMENT", name: "1", width: 794, height: 1123, background: "#ffffff", nodes: [{ id: "t", type: "TEXT", name: "t", transform: { x: 76, y: 76, rotation: 0, scale: 1 }, opacity: 1, visible: true, locked: false, width: 640, height: 200, paragraphs: [p1, p2, p3] } as any], comments: [c1, c2, c3], trackChanges: true } as Page;
    const out = exportDocx([page]);
    const report = { notesDropped: 0 } as Parameters<typeof parseDocxFlow>[1] & object;
    const items = parseDocxFlow(out, report);
    const cs = report.layout!.comments!;
    expect(cs.map((c) => c.text)).toEqual(["첫 메모", "답글", "해결한 메모"]);
    expect(cs[1].parent).toBe(cs[0].id);
    expect(cs[2].done).toBe(true);
    expect(cs.every((c) => c.author === QA && c.initials === "OQ")).toBe(true);
    expect(runsWith(items, (r) => !!r.comments?.includes(cs[0].id)).map((r) => r.text).join("")).toBe("메모 단 글자");
    expect(runsWith(items, (r) => !!r.comments?.includes(cs[2].id)).map((r) => r.text).join("")).toBe("넣은");
    expect(runsWith(items, (r) => r.rev?.kind === "del").map((r) => r.text)).toEqual(["지운 "]);
    expect(paras(items)[1].markRev?.kind).toBe("ins");
    expect(report.layout!.trackChanges).toBe(true);
    // a document without comments or changes is written as before (no comment parts)
    const plain = exportDocx([{ ...page, comments: undefined, trackChanges: undefined, nodes: [{ ...(page.nodes[0] as any), paragraphs: [p3] }] } as Page]);
    expect(Object.keys(unzipSync(plain)).some((k) => /comments|settings/.test(k))).toBe(false);
  });
});

describe("HWPX (Office Surgeon): memos and tracked changes", () => {
  it("a paragraph with a memo edited keeps its memo (QA risk 1)", async () => {
    const bytes = bytesOf(MEMO);
    const doc = await open("hwpx", bytes);
    const pages = mapStories(doc.pages, (ps) => ps.map((p) => (textOf(p).startsWith("각 부서는") ? { ...p, runs: p.runs.map((r) => (r.text.includes("석 달") ? { ...r, text: r.text.replace("석 달", "세 달") } : r)) } : p)));
    const out = await save("hwpx", { ...doc, pages });
    const report = { notesDropped: 0 } as Parameters<typeof parseHwpxFlow>[1] & object;
    const items = parseHwpxFlow(out, report);
    expect(report.layout!.comments!.length).toBe(3);
    const cs = report.layout!.comments!;
    expect(paras(items).map(textOf)).toContain("각 부서는 지난 세 달 동안의 실적을 바탕으로 목표를 다시 세우고, 위험 요소와 대응 방안을 함께 적어 주시기 바랍니다.");
    expect(runsWith(items, (r) => !!r.comments?.includes(cs[1].id)).map((r) => r.text).join("")).toBe("각 부서");
    expect(cs[1].text).toBe("오메 시험 메모 2 — 부서 이름을 적어 주세요.");
  });

  it("a paragraph with tracked changes edited keeps them (QA risk 1): the deletion is still a deletion", async () => {
    const bytes = bytesOf(HTRACK);
    const doc = await open("hwpx", bytes);
    const pages = mapStories(doc.pages, (ps) => ps.map((p) => (textOf(p).startsWith("각 부서는") ? { ...p, runs: p.runs.map((r) => (r.text.includes("석 달") ? { ...r, text: r.text.replace("석 달", "세 달") } : r)) } : p)));
    const out = await save("hwpx", { ...doc, pages });
    const items = parseHwpxFlow(out);
    const p = paras(items).find((q) => textOf(q).startsWith("각 부서는"))!;
    expect(textOf(p)).toContain("세 달");
    expect(p.runs.filter((r) => r.rev?.kind === "del").map((r) => r.text)).toEqual([" 위험 요소와 대응 방안을 함께", "니다."]);
    expect(p.runs.find((r) => r.rev?.kind === "del")!.rev!.author).toBe(QA);
  });

  it("a new memo and changes recorded in Omniweave: memo field, insert / delete marks, header author and change entries", async () => {
    setReviewAuthor(QA);
    const bytes = bytesOf(MEMO);
    let doc = (await open("hwpx", bytes));
    doc = comment(doc, "마지막 문단은", "검토 의견", "오메 2단계 한글 메모").doc;
    doc = recorded(doc, "마지막 문단은", (ps) => {
      const r = at(ps, "마지막 문단은", "다음 회의");
      let x = RT.deleteRange(ps, r);
      x = RT.insertText(x.paras, x.pos, "다음 주 회의");
      return x.paras;
    });
    doc = { ...doc, pages: [{ ...doc.pages[0], trackChanges: true }, ...doc.pages.slice(1)] };
    const out = await save("hwpx", doc);
    expect(changedEntries(bytes, out)).toEqual(["Contents/header.xml", "Contents/section0.xml"]);
    const report = { notesDropped: 0 } as Parameters<typeof parseHwpxFlow>[1] & object;
    const items = parseHwpxFlow(out, report);
    const cs = report.layout!.comments!;
    expect(cs.length).toBe(4);
    const mine = cs.find((c) => c.text === "오메 2단계 한글 메모")!;
    expect(mine.author).toBe(QA);
    expect(runsWith(items, (r) => !!r.comments?.includes(mine.id)).map((r) => r.text).join("")).toBe("검토 의견");
    const p = paras(items).find((q) => textOf(q).startsWith("마지막 문단은"))!;
    expect(p.runs.filter((r) => r.rev?.kind === "del").map((r) => r.text)).toEqual(["다음 회의"]);
    expect(p.runs.filter((r) => r.rev?.kind === "ins").map((r) => r.text)).toEqual(["다음 주 회의"]);
    expect(p.runs.find((r) => r.rev?.kind === "ins")!.rev!.author).toBe(QA);
    const h = part(out, "Contents/header.xml");
    expect(h).toMatch(/<hh:trackChangeAuthor name="Omniweave QA"/);
    expect(h).toMatch(/<hh:trackChange type="Insert"/);
    expect(h).toMatch(/<hh:trackchageConfig flags="\d+"/);
    expect(Number(/trackchageConfig flags="(\d+)"/.exec(h)![1]) & 1).toBe(1);
    expect(report.layout!.trackChanges).toBe(true);
    // the other memos byte for byte
    const o = part(bytes, "Contents/section0.xml");
    const n = part(out, "Contents/section0.xml");
    for (const m of o.matchAll(/<hp:fieldBegin [^>]*type="MEMO"[\s\S]*?<\/hp:fieldBegin>/g)) expect(n).toContain(m[0]);
  });

  it("accept all / reject all on 한글's tracked file", async () => {
    const bytes = bytesOf(HTRACK);
    const doc = await open("hwpx", bytes);
    for (const accept of [true, false]) {
      const out = await save("hwpx", { ...doc, pages: mapStories(doc.pages, (ps) => resolveChanges(ps, accept, pickAll).paras) });
      const items = parseHwpxFlow(out);
      expect(runsWith(items, (r) => !!r.rev).length, String(accept)).toBe(0);
      const all = paras(items).map(textOf).join("|");
      expect(all.includes("위험 요소와"), String(accept)).toBe(!accept);
      expect(all.includes("빠짐없이"), String(accept)).toBe(accept);
      expect(part(out, "Contents/section0.xml"), String(accept)).not.toMatch(/<hp:(insertBegin|deleteBegin)\b/);
    }
  });

  it("memo edited / deleted in an untouched paragraph", async () => {
    const bytes = bytesOf(MEMO);
    const doc = await open("hwpx", bytes);
    const cs = docComments(doc.pages);
    let list = editComment(cs, cs[0].id, "고친 한글 메모");
    list = list.filter((c) => c.id !== cs[2].id);
    const pages = withComments(mapStories(doc.pages, (ps) => untagComments(ps, new Set([cs[2].id]))), list);
    const out = await save("hwpx", { ...doc, pages });
    const report = { notesDropped: 0 } as Parameters<typeof parseHwpxFlow>[1] & object;
    parseHwpxFlow(out, report);
    expect(report.layout!.comments!.map((c) => c.text)).toEqual(["고친 한글 메모", "오메 시험 메모 2 — 부서 이름을 적어 주세요."]);
    expect(part(out, "Contents/section0.xml")).not.toContain("오메 시험 메모 3");
    // the table whose cell had the deleted memo is all there (QA 2026-11-15: a cell edit cut the table short)
    expect(part(out, "Contents/section0.xml")).toContain("1,234,567");
    expect(part(out, "Contents/section0.xml")).toContain("</hp:tbl>");
  });
});
