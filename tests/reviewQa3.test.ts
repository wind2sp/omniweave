// QA doc-review3 (stage 3 of comments and tracked changes): the risks QA doc-review / doc-review2 left — IME text in the
// text box and header editors, the right-click caret, '내가 넣은 글자' by session, the review pane's commands closing
// the typing group, memos and changes in HWPX written anew, an empty paragraph's mark format change, and format changes
// recorded while changes are recorded.

import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { exportDocx, exportHwpx, parseDocxFlow, parseHwpxFlow, type OfficeItem } from "../src/io/office";
import { collectChanges, isOwnInsertion, newRevision, setReviewAuthor, setTracking } from "../src/core/review";
import { changeAt, mapStories, newComment, pickAll, resolveChanges } from "../src/core/reviewEdit";
import * as RT from "../src/core/richtext";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newText, type OmwDocument, type Page, type TextParagraph, type TextRun } from "../src/core/types";
import { bodyBox } from "../src/core/pageSetup";
import { startEditModes } from "../src/ui/editModes";
import { attachInput, beginTyping, onCompositionEnd, onCompositionStart, onCompositionUpdate, onInput } from "../src/ui/docFlow";
import { resolveDoc } from "../src/ui/reviewActions";

const QA = "Omniweave QA";
const S = () => useStore.getState();
const textOf = (p: Pick<TextParagraph, "runs">) => p.runs.map((r) => r.text).join("");
const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ text, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000", ...extra });
const para = (id: string, runs: TextRun[], extra: Partial<TextParagraph> = {}): TextParagraph => ({ id, runs, align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 0, ...extra });
const docOf = (pages: Page[]): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets: {} });
const paras = (items: OfficeItem[]) => items.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras));
async function open(kind: "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name: `x.${kind}`, path: null, bytes }, {} as any);
  return docOf(r.pages!);
}
async function save(kind: "docx" | "hwpx", doc: OmwDocument) {
  const out = (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
  wellFormed(out);
  return out;
}
function wellFormed(out: Uint8Array) {
  for (const [name, data] of Object.entries(unzipSync(out)))
    if (/\.(xml|rels|hpf)$/.test(name)) {
      const errors: string[] = [];
      new DOMParser({ errorHandler: { warning: (m: string) => void errors.push(m), error: (m: string) => void errors.push(m), fatalError: (m: string) => void errors.push(m) } } as any).parseFromString(strFromU8(data), "text/xml");
      expect(errors, name).toEqual([]);
    }
}
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});
afterEach(() => {
  setTracking(false);
  setReviewAuthor("");
});

describe("1. IME text in the text box / header editor (RichTextEditor reads the DOM back)", () => {
  // what the browser leaves after composing "나" right after deleted text: the syllable inside the deleted run's span
  const base = () => [para("a", [run("가"), run("지움", { rev: { kind: "del", author: "Someone", src: "7" } }), run("끝")])];
  const domAfter = (text: string) => [para("a", [run("가"), run("지움" + text, { rev: { kind: "del", author: "Someone", src: "7" } }), run("끝")])];

  it("the composed text is an insertion while changes are recorded, never part of the deleted text next to it", () => {
    setReviewAuthor(QA);
    setTracking(true);
    const b = base();
    const at = { p: 0, o: 3 };
    const res = RT.insertComposed(b, at, domAfter("나"), RT.formatAt(b, at))!;
    expect(textOf(res.paras[0])).toBe("가지움나끝");
    const runs = res.paras[0].runs;
    expect(runs.find((r) => r.text === "지움")?.rev?.kind).toBe("del");
    const ins = runs.find((r) => r.text === "나");
    expect(ins?.rev?.kind).toBe("ins");
    expect(ins?.rev?.author).toBe(QA);
    expect(res.pos).toEqual({ p: 0, o: 4 });
    // the next syllable joins it (one insertion)
    const res2 = RT.insertComposed(res.paras, res.pos, [para("a", [run("가"), run("지움", { rev: { kind: "del", author: "Someone", src: "7" } }), run("나다끝")])], RT.formatAt(res.paras, res.pos))!;
    const ins2 = res2.paras[0].runs.filter((r) => r.rev?.kind === "ins");
    expect(ins2.map((r) => r.text).join("")).toBe("나다");
    expect(new Set(ins2.map((r) => r.rev!.src)).size).toBe(1);
  });

  it("recording off: plain text (not deleted text either)", () => {
    const b = base();
    const res = RT.insertComposed(b, { p: 0, o: 3 }, domAfter("나"), RT.formatAt(b, { p: 0, o: 3 }))!;
    expect(res.paras[0].runs.find((r) => r.text.includes("나"))?.rev).toBeUndefined();
    expect(textOf(res.paras[0])).toBe("가지움나끝");
  });

  it("text changed otherwise than added at the caret: null (the DOM is kept as before)", () => {
    expect(RT.composedText(base(), { p: 0, o: 3 }, [para("a", [run("X지움나끝")])])).toBeNull();
    expect(RT.composedText(base(), { p: 0, o: 3 }, [...domAfter("나"), para("b", [run("")])])).toBeNull();
    expect(RT.composedText(base(), { p: 0, o: 3 }, base())).toBe("");
  });
});

describe("2. right-click: the caret moves there unless the press is inside the selection", () => {
  it("keepsSelection", () => {
    const sel = { start: { p: 0, o: 2 }, end: { p: 1, o: 3 } };
    expect(RT.keepsSelection(sel, { p: 0, o: 5 })).toBe(true);
    expect(RT.keepsSelection(sel, { p: 1, o: 3 })).toBe(true);
    expect(RT.keepsSelection(sel, { p: 0, o: 1 })).toBe(false);
    expect(RT.keepsSelection(sel, { p: 1, o: 4 })).toBe(false);
    // a caret (no selection) always moves
    expect(RT.keepsSelection({ start: { p: 0, o: 2 }, end: { p: 0, o: 2 } }, { p: 0, o: 2 })).toBe(false);
  });
});

describe("3. '내가 넣은 글자' is a change of this session, not of the same name", () => {
  it("a file's insertion by the same name (or by the fallback word) is struck, not removed; mine of this session goes", () => {
    setTracking(true);
    for (const name of [QA, ""]) {
      setReviewAuthor(name, "Author");
      const who = name || "Author";
      const ps = [para("a", [run("앞"), run("남의 글", { rev: { kind: "ins", author: who, date: "2026-11-01T10:00:00", src: "12" } }), run("뒤")])];
      expect(isOwnInsertion(ps[0].runs[1].rev)).toBe(false);
      const r = RT.deleteRange(ps, { start: { p: 0, o: 1 }, end: { p: 0, o: 5 } });
      expect(textOf(r.paras[0])).toBe("앞남의 글뒤");
      expect(r.paras[0].runs.find((x) => x.text === "남의 글")?.rev?.kind).toBe("del");
      // typing next to it starts the reviewer's own insertion (not joining the file's)
      const t = RT.insertText(ps, { p: 0, o: 5 }, "새");
      const mine = t.paras[0].runs.find((x) => x.text === "새")!;
      expect(mine.rev?.src).not.toBe("12");
      expect(isOwnInsertion(mine.rev)).toBe(true);
      const back = RT.deleteChar(t.paras, t.pos, -1);
      expect(textOf(back.paras[0])).toBe("앞남의 글뒤");
    }
  });

  it("a change made now is of this session; one with the same name read from a file is not", () => {
    setReviewAuthor(QA);
    expect(isOwnInsertion(newRevision("ins"))).toBe(true);
    expect(isOwnInsertion({ kind: "ins", author: QA, src: "omw-other-1" })).toBe(false);
    expect(isOwnInsertion({ kind: "ins", author: QA })).toBe(false);
  });
});

describe("4. the review pane's commands close the body's typing group first", () => {
  beforeEach(() => {
    startEditModes();
    S().set({ mode: "AUTO" });
  });
  function type(text: string) {
    attachInput({ value: text, blur() {}, focus() {} } as unknown as HTMLTextAreaElement);
    onInput({} as Event);
  }
  const bodyText = () => S().doc.pages[0].nodes.filter((n): n is any => n.type === "TEXT").flatMap((n: any) => n.paragraphs.map(textOf)).join("\n");
  const hasRev = () => S().doc.pages[0].nodes.some((n: any) => n.type === "TEXT" && n.paragraphs.some((p: TextParagraph) => p.markRev || p.runs.some((r) => r.rev)));

  it("모두 수락 while a syllable is being composed: the syllable is kept, the accept is not undone by the IME's end", () => {
    setReviewAuthor(QA);
    const doc = newDocument();
    const pg = newPage("DOCUMENT", 794, 1123, "1");
    const box = bodyBox(pg);
    const t = newText("", box.w);
    t.paragraphs = [para("p0", [run("본문")])];
    t.flow = true;
    t.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    pg.nodes.push(t);
    pg.trackChanges = true;
    doc.pages = [pg];
    S().load(doc);
    S().set({ mode: "DOCUMENT" });
    expect(beginTyping(pg.id, { p: 0, o: 2 })).toBe(true);
    setTracking(true);
    type("ab");
    expect(hasRev()).toBe(true);
    // composing 다 (shown, not yet typed) when the pane's 모두 수락 is pressed
    onCompositionStart();
    onCompositionUpdate("다");
    resolveDoc(true);
    // the browser ends the composition afterwards (the pane took the focus)
    onCompositionEnd("다");
    expect(bodyText()).toBe("본문ab다");
    expect(hasRev()).toBe(false);
    // the accept is one undo step after the typing
    S().undo();
    expect(bodyText()).toBe("본문ab다");
    expect(hasRev()).toBe(true);
  });
});

describe("5. HWPX written anew keeps memos and tracked changes", () => {
  it("memo fields, insert / delete marks, the header's changes and authors, recording on", () => {
    setReviewAuthor(QA);
    const c1 = newComment("새로 쓴 메모");
    const ins = { kind: "ins" as const, author: QA, date: "2026-11-16T10:00:00", src: "omw-x-1" };
    const del = { kind: "del" as const, author: "Other Reviewer", date: "2026-11-16T10:00:00", src: "omw-x-2" };
    const p1 = para("a", [run("앞 "), run("메모 단 글자", { comments: [c1.id] }), run(" 뒤")]);
    const p2 = para("b", [run("지운 ", { rev: del }), run("넣은", { rev: ins }), run(" 그대로")], { markRev: ins });
    const p3 = para("c", [run("끝")]);
    const page = { id: "pg", kind: "DOCUMENT", name: "1", width: 794, height: 1123, background: "#ffffff", nodes: [{ id: "t", type: "TEXT", name: "t", transform: { x: 76, y: 76, rotation: 0, scale: 1 }, opacity: 1, visible: true, locked: false, width: 640, height: 200, paragraphs: [p1, p2, p3] } as any], comments: [c1], trackChanges: true } as Page;
    const notes: string[] = [];
    const out = exportHwpx([page], "t", { notes });
    wellFormed(out);
    const sec = part(out, "Contents/section0.xml");
    const header = part(out, "Contents/header.xml");
    expect(sec).toMatch(/<hp:fieldBegin\b[^>]*type="MEMO"/);
    expect(sec).toContain("<hp:fieldEnd");
    expect(sec).toContain("<hp:insertBegin");
    expect(sec).toContain("<hp:deleteBegin");
    expect(sec).toContain('paraend="1"');
    expect(header).toMatch(/<hh:trackChanges itemCnt="2">/);
    expect(header).toMatch(/<hh:trackChangeAuthors itemCnt="2">/);
    expect(header).toContain('<hh:trackchageConfig flags="57"/>');
    // read back: the same memo, changes and recording
    const rep: any = { notesDropped: 0 };
    const items = parseHwpxFlow(out, rep);
    expect(rep.layout.comments.map((c: any) => [c.author, c.text])).toEqual([[QA, "새로 쓴 메모"]]);
    const ps = paras(items);
    expect(ps.flatMap((p) => p.runs.filter((r) => r.comments?.length)).map((r) => r.text).join("")).toBe("메모 단 글자");
    expect(collectChanges(ps).map((c) => [c.kind, c.author, c.text])).toEqual([
      ["del", "Other Reviewer", "지운 "],
      ["ins", QA, "넣은"],
      ["markIns", QA, "¶"],
    ]);
    expect(ps[1].markRev?.kind).toBe("ins");
    expect(rep.layout.trackChanges).toBe(true);
    expect(notes).toEqual([]);
  });

  it("a document without memos or changes is written as before (no change lists, recording off)", () => {
    const page = { id: "pg", kind: "DOCUMENT", name: "1", width: 794, height: 1123, background: "#ffffff", nodes: [{ id: "t", type: "TEXT", name: "t", transform: { x: 76, y: 76, rotation: 0, scale: 1 }, opacity: 1, visible: true, locked: false, width: 640, height: 200, paragraphs: [para("a", [run("그냥 글")])] } as any] } as Page;
    const out = exportHwpx([page], "t");
    expect(part(out, "Contents/header.xml")).not.toContain("trackChange");
    expect(part(out, "Contents/header.xml")).toContain('<hh:trackchageConfig flags="56"/>');
    expect(part(out, "Contents/section0.xml")).not.toMatch(/insertBegin|fieldBegin/);
  });
});

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function docxOf(body: string): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

describe("6. an empty paragraph's mark format change (w:pPr/w:rPr/w:rPrChange)", () => {
  const CH = `<w:rPrChange w:id="5" w:author="${QA}" w:date="2026-11-15T10:00:00Z"><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrChange>`;
  const body = `<w:p><w:r><w:t>첫 문단</w:t></w:r></w:p><w:p><w:pPr><w:rPr><w:b/><w:sz w:val="28"/>${CH}</w:rPr></w:pPr></w:p><w:p><w:r><w:t>끝 문단</w:t></w:r></w:p>`;

  it("is read, listed and accepted; the saved file has no rPrChange left (the mark's format stays)", async () => {
    const doc = await open("docx", docxOf(body));
    const ps = doc.pages.flatMap((p) => p.nodes).flatMap((n: any) => n.paragraphs ?? []) as TextParagraph[];
    const empty = ps.find((p) => !textOf(p))!;
    expect(empty.markFmtRev?.kind).toBe("fmt");
    expect(collectChanges(ps).map((c) => c.kind)).toEqual(["fmt"]);
    const accepted = { ...doc, pages: mapStories(doc.pages, (q) => resolveChanges(q, true, pickAll).paras) };
    const out = await save("docx", accepted);
    const xml = part(out, "word/document.xml");
    expect(xml).not.toContain("rPrChange");
    expect(xml).toMatch(/<w:pPr>(?:(?!<\/w:pPr>)[\s\S])*<w:rPr><w:b\/><w:sz w:val="28"\/><\/w:rPr>/);
    expect(xml).toContain("첫 문단");
    // untouched (not accepted): the file's change stays as it was
    const kept = part(await save("docx", { ...doc, pages: mapStories(doc.pages, (q) => RT.insertText(q, { p: 0, o: 3 }, "!").paras) }), "word/document.xml");
    expect(kept).toContain(CH);
  });

  it("the caret at the empty paragraph names it; accept / reject there removes it", async () => {
    const doc = await open("docx", docxOf(body));
    let out: TextParagraph[] | null = null;
    mapStories(doc.pages, (q) => {
      const i = q.findIndex((p) => !textOf(p));
      if (i < 0) return q;
      expect(changeAt(q, { p: i, o: 0 })?.level).toBe("mark");
      out = resolveChanges(q, false, pickAll).paras;
      return q;
    });
    expect(out!.some((p) => p.markFmtRev)).toBe(false);
  });
});

describe("7. format changes recorded while changes are recorded", () => {
  it("bold on recorded text: a format change with the format before it; reject puts it back, accept keeps the bold", () => {
    setReviewAuthor(QA);
    setTracking(true);
    const ps = [para("a", [run("가나다라마")])];
    const f = RT.applyRunFormat(ps, { start: { p: 0, o: 1 }, end: { p: 0, o: 3 } }, { bold: true });
    const b = f[0].runs.find((r) => r.bold)!;
    expect(b.text).toBe("나다");
    expect(b.fmtRev?.kind).toBe("fmt");
    expect(b.fmtRev?.author).toBe(QA);
    expect(b.fmtRev?.was?.bold).toBe(false);
    expect(collectChanges(f).map((c) => [c.kind, c.text])).toEqual([["fmt", "나다"]]);
    const rej = resolveChanges(f, false, pickAll).paras;
    expect(rej[0].runs).toHaveLength(1);
    expect(rej[0].runs[0].bold).toBe(false);
    expect(rej[0].runs[0].fmtRev).toBeUndefined();
    const acc = resolveChanges(f, true, pickAll).paras;
    expect(acc[0].runs.find((r) => r.text === "나다")?.bold).toBe(true);
    expect(acc[0].runs.some((r) => r.fmtRev)).toBe(false);
    // a second change on it keeps the format before the first one
    const f2 = RT.applyRunFormat(f, { start: { p: 0, o: 1 }, end: { p: 0, o: 3 } }, { fontSize: 30 });
    const b2 = f2[0].runs.find((r) => r.text === "나다")!;
    expect(b2.fontSize).toBe(30);
    expect(b2.fmtRev).toEqual(b.fmtRev);
    expect(RT.formerRun(b2)?.fontSize).toBe(16);
    expect(RT.formerRun(b2)?.bold).toBe(false);
  });

  it("not recorded: my own new text, recording off", () => {
    setReviewAuthor(QA);
    setTracking(true);
    const t = RT.insertText([para("a", [run("가")])], { p: 0, o: 1 }, "나다");
    const f = RT.applyRunFormat(t.paras, { start: { p: 0, o: 1 }, end: { p: 0, o: 3 } }, { italic: true });
    expect(f[0].runs.some((r) => r.fmtRev)).toBe(false);
    setTracking(false);
    expect(RT.applyRunFormat([para("a", [run("가나")])], { start: { p: 0, o: 0 }, end: { p: 0, o: 2 } }, { bold: true })[0].runs[0].fmtRev).toBeUndefined();
  });

  // QA doc-review3: bold over a range holding recorded deleted text made the deleted text bold with no change of its
  // own — rejecting the deletion brought it back bold (the format before it lost)
  it("QA: deleted text in the range keeps its format; reject all gives the original text and look back", () => {
    setReviewAuthor(QA);
    setTracking(true);
    const look = (ps: TextParagraph[]) => ps[0].runs.flatMap((r) => Array.from(r.text).map((c) => `${c}${r.bold ? "B" : ""}${r.italic ? "I" : ""}${r.fontSize}`)).join(",");
    const b0 = [para("a", [run("abc", { italic: true }), run("defgh", { color: "#ff0000" }), run("ij")])];
    let ps = RT.deleteRange(b0, { start: { p: 0, o: 2 }, end: { p: 0, o: 4 } }).paras;
    ps = RT.insertText(ps, { p: 0, o: 6 }, "XY", RT.formatAt(ps, { p: 0, o: 6 })).paras;
    ps = RT.toggleRunFormat(ps, { start: { p: 0, o: 0 }, end: { p: 0, o: 12 } }, "bold");
    ps = RT.applyRunFormat(ps, { start: { p: 0, o: 1 }, end: { p: 0, o: 9 } }, { fontSize: 30 });
    const del = ps[0].runs.filter((r) => r.rev?.kind === "del");
    expect(del.map((r) => r.text).join("")).toBe("cd");
    expect(del.every((r) => !r.bold && r.fontSize === 16 && !r.fmtRev)).toBe(true);
    const rej = resolveChanges(ps, false, pickAll).paras;
    expect(textOf(rej[0])).toBe("abcdefghij");
    expect(look(rej)).toBe(look(b0));
    const acc = resolveChanges(ps, true, pickAll).paras;
    expect(textOf(acc[0])).toBe("abefXYghij");
    expect(acc[0].runs.every((r) => r.bold)).toBe(true);
    expect(collectChanges(acc)).toEqual([]);
  });

  it("DOCX (Office Surgeon and written anew): w:rPrChange with the format before it; Word's reading gives the change back", async () => {
    setReviewAuthor(QA);
    const doc = await open("docx", docxOf(`<w:p><w:r><w:rPr><w:sz w:val="22"/></w:rPr><w:t>바꿀 글자가 있는 문단</w:t></w:r></w:p>`));
    setTracking(true);
    const pages = mapStories(doc.pages, (ps) => RT.applyRunFormat(ps, { start: { p: 0, o: 0 }, end: { p: 0, o: 2 } }, { bold: true }));
    setTracking(false);
    const out = await save("docx", { ...doc, pages });
    const xml = part(out, "word/document.xml");
    expect(xml).toMatch(/<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<w:b\/>(?:(?!<w:rPrChange)[\s\S])*<w:rPrChange w:id="\d+" w:author="Omniweave QA" w:date="[^"]+Z"><w:rPr><w:sz w:val="22"\/><\/w:rPr><\/w:rPrChange><\/w:rPr>/);
    const back = paras(parseDocxFlow(out, { notesDropped: 0 } as any));
    expect(collectChanges(back).map((c) => [c.kind, c.author, c.text])).toEqual([["fmt", QA, "바꿀"]]);
    // written anew
    const fresh = exportDocx(pages.map((p) => ({ ...p, source: undefined })) as Page[]);
    wellFormed(fresh);
    expect(part(fresh, "word/document.xml")).toContain("<w:rPrChange");
    expect(collectChanges(paras(parseDocxFlow(fresh, { notesDropped: 0 } as any))).map((c) => c.kind)).toEqual(["fmt"]);
  });
});
