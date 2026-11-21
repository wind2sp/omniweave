// QA doc-review2 (stage 2 of comments and tracked changes): what the review edits must not change — documents saved
// without any review edit, comments the model does not show on its runs (a footnote's), undo — and tracked typing.

import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { exportById, formatForExt } from "../src/io/formats";
import { docComments, setReviewAuthor, setTracking } from "../src/core/review";
import { mapStories, newComment, tagComment, withComments } from "../src/core/reviewEdit";
import * as RT from "../src/core/richtext";
import type { OmwDocument, Page, TextParagraph } from "../src/core/types";

const QA = "Omniweave QA";
const docOf = (pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets });
async function open(kind: "docx" | "hwpx", bytes: Uint8Array): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name: `x.${kind}`, path: null, bytes }, {} as any);
  return docOf(r.pages!, (r as any).assets ?? {});
}
const save = async (kind: "docx" | "hwpx", doc: OmwDocument) => (await exportById(kind)!.run(doc, doc.pages[0], { confirm: () => true } as any)) as Uint8Array;
const textOf = (p: Pick<TextParagraph, "runs">) => p.runs.map((r) => r.text).join("");
const part = (b: Uint8Array, name: string) => strFromU8(unzipSync(b)[name]);

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
/** A Word file with a comment on the text of its footnote (Word allows comments in notes) and one in the body. */
function footnoteCommentDocx(): Uint8Array {
  const files: Record<string, string> = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/footnotes" Target="footnotes.xml"/><Relationship Id="rId2" Type="${R}/comments" Target="comments.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p><w:r><w:t>첫 문단에 각주가 있다</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p><w:p><w:commentRangeStart w:id="1"/><w:r><w:t>본문 메모 글</w:t></w:r><w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p><w:p><w:r><w:t>고칠 문단</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    "word/footnotes.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes ${W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>각주 메모 글</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p></w:footnote></w:footnotes>`,
    "word/comments.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W}><w:comment w:id="0" w:author="${QA}" w:date="2026-11-15T10:00:00Z" w:initials="OQ"><w:p><w:r><w:t>각주에 단 메모</w:t></w:r></w:p></w:comment><w:comment w:id="1" w:author="${QA}" w:date="2026-11-15T10:00:00Z" w:initials="OQ"><w:p><w:r><w:t>본문에 단 메모</w:t></w:r></w:p></w:comment></w:comments>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
/** the document with `fn` run on the story holding the paragraph starting with `start` */
const onStory = (doc: OmwDocument, start: string, fn: (ps: TextParagraph[]) => TextParagraph[]): OmwDocument => ({ ...doc, pages: mapStories(doc.pages, (ps) => (ps.some((q) => textOf(q).startsWith(start)) ? fn(ps) : ps)) });
const paraAt = (ps: TextParagraph[], start: string) => ps.findIndex((q) => textOf(q).startsWith(start));

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});
afterEach(() => {
  setTracking(false);
  setReviewAuthor("");
});

describe("QA: a comment on a footnote's text (the body's runs do not hold it)", () => {
  const ids = (xml: string) => Array.from(xml.matchAll(/<w:comment\b[^>]*\bw:id="([^"]*)"/g), (m) => m[1]).sort();

  it("an ordinary edit of the body (no review edit, recording off) keeps it in comments.xml", async () => {
    const bytes = footnoteCommentDocx();
    let doc = await open("docx", bytes);
    expect(docComments(doc.pages).map((c) => c.id).sort()).toEqual(["0", "1"]);
    doc = onStory(doc, "고칠 문단", (ps) => RT.insertText(ps, { p: paraAt(ps, "고칠 문단"), o: 5 }, " 고침").paras);
    const out = await save("docx", doc);
    expect(textOf((await open("docx", out)).pages.flatMap((p) => p.nodes).flatMap((n: any) => n.paragraphs ?? []).find((q: TextParagraph) => textOf(q).startsWith("고칠"))!)).toBe("고칠 문단 고침");
    // the footnote still refers to comment 0: it must still be there
    expect(part(out, "word/footnotes.xml")).toContain('<w:commentReference w:id="0"/>');
    expect(ids(part(out, "word/comments.xml"))).toEqual(["0", "1"]);
  });

  it("a new comment in the body keeps it too, and the new one takes an unused id", async () => {
    setReviewAuthor(QA);
    const bytes = footnoteCommentDocx();
    let doc = await open("docx", bytes);
    const c = newComment("새 메모");
    doc = onStory(doc, "고칠 문단", (ps) => tagComment(ps, { start: { p: paraAt(ps, "고칠 문단"), o: 0 }, end: { p: paraAt(ps, "고칠 문단"), o: 2 } }, c.id)!);
    doc = { ...doc, pages: withComments(doc.pages, [...docComments(doc.pages), c]) };
    const out = await save("docx", doc);
    expect(ids(part(out, "word/comments.xml"))).toEqual(["0", "1", "2"]);
  });
});

describe("QA: recording off — the body editor as before", () => {
  it("typing next to someone's tracked insertion does not join it (plain text), deleting really deletes", async () => {
    const bytes = new Uint8Array(readFileSync("qa/interop/word-made/omni-review-tracked.docx"));
    const doc = await open("docx", bytes);
    let story: TextParagraph[] = [];
    mapStories(doc.pages, (ps) => {
      if (!story.length && ps.some((q) => q.runs.some((r) => r.rev?.kind === "ins"))) story = ps;
      return ps;
    });
    const p = story.findIndex((q) => q.runs.some((r) => r.rev?.kind === "ins"));
    let o = 0;
    for (const r of story[p].runs) {
      if (r.rev?.kind === "ins") break;
      o += r.text.length;
    }
    const typed = RT.insertText(story, { p, o: o + 1 }, "가");
    const run = typed.paras[p].runs.find((r) => r.text.includes("가"))!;
    expect(run.rev).toBeUndefined();
    const del = RT.deleteRange(story, { start: { p, o: 0 }, end: { p, o: 2 } });
    expect(textOf(del.paras[p])).toBe(textOf(story[p]).slice(2));
  });
});

describe("QA: recording on — paste, multi-paragraph delete, IME", () => {
  const plain = (texts: string[]): TextParagraph[] => texts.map((t, i) => ({ id: `p${i}`, runs: [{ fontFamily: "A", fontSize: 12, color: "#000", text: t } as any], align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 0 }));
  const visible = (ps: TextParagraph[]) => ps.map((q) => q.runs.filter((r) => r.rev?.kind !== "del").map((r) => r.text).join("")).join("\n");
  const all = (ps: TextParagraph[]) => ps.map(textOf).join("\n");

  it("paste over a selection across paragraphs: the old text struck, the new text once, after it", () => {
    setReviewAuthor(QA);
    setTracking(true);
    const ps = plain(["가나다라", "마바사", "아자차"]);
    const r = RT.pasteData(ps, { start: { p: 0, o: 2 }, end: { p: 2, o: 1 } }, ps[0].runs[0], "", "XY\nZ")!;
    expect(all(r.paras)).toBe("가나다라\n마바사\n아XY\nZ자차");
    expect(visible(r.paras)).toBe("가나\n\n XY\nZ자차".replace(" ", ""));
    // nothing pasted twice, nothing lost
    expect(all(r.paras).split("XY").length).toBe(2);
  });

  it("a composed syllable (IME: shown, then put in from the base) is inserted once and joins the typing before it", () => {
    setReviewAuthor(QA);
    setTracking(true);
    let ps = plain(["한글"]);
    ps = RT.insertText(ps, { p: 0, o: 2 }, "가").paras;
    const base = ps;
    // compositionupdate previews ("ㄴ", "나") are thrown away; compositionend inserts into the base
    RT.insertText(base, { p: 0, o: 3 }, "ㄴ");
    const end = RT.insertText(base, { p: 0, o: 3 }, "나");
    expect(textOf(end.paras[0])).toBe("한글가나");
    const ins = end.paras[0].runs.filter((r) => r.rev?.kind === "ins");
    expect(ins.map((r) => r.text).join("")).toBe("가나");
    expect(new Set(ins.map((r) => r.rev!.src)).size).toBe(1);
  });

  it("Backspace over my own typing removes it; over the original strikes it and steps over", () => {
    setReviewAuthor(QA);
    setTracking(true);
    let r = RT.insertText(plain(["abc"]), { p: 0, o: 3 }, "d");
    r = RT.deleteChar(r.paras, r.pos, -1);
    expect(textOf(r.paras[0])).toBe("abc");
    r = RT.deleteChar(r.paras, r.pos, -1);
    expect(textOf(r.paras[0])).toBe("abc");
    expect(r.pos).toEqual({ p: 0, o: 2 });
    expect(r.paras[0].runs.find((x) => x.text === "c")?.rev?.kind).toBe("del");
  });
});
