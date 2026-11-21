// Comments and tracked changes, stage 2 (core/reviewEdit.ts, core/richtext.ts with changes recorded): typing and
// deleting while recording, accepting / rejecting one change, the ones in a range or all, comments added, answered,
// resolved, edited and deleted.

import { afterEach, describe, expect, it } from "vitest";
import * as RT from "../src/core/richtext";
import { collectChanges, newRevision, setReviewAuthor, setTracking } from "../src/core/review";
import { changeAt, editComment, initialsOf, newComment, pickAll, pickInRange, resolveChanges, setThreadDone, tagComment, tagReply, threadIds, untagComments } from "../src/core/reviewEdit";
import type { TextParagraph, TextRun } from "../src/core/types";

const QA = "Omniweave QA";
const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ text, fontFamily: "Pretendard", fontSize: 16, bold: false, italic: false, underline: false, color: "#000000", ...extra });
let pid = 0;
const para = (...runs: TextRun[]): TextParagraph => ({ id: `p${++pid}`, runs, align: "LEFT", lineSpacing: 1.2, indent: 0, spaceAfter: 0 });
const marks = (p: TextParagraph) => p.runs.map((r) => [r.text, r.rev?.kind ?? ""]);
const text = (ps: TextParagraph[]) => ps.map(RT.paraText).join("|");

function recording(fn: () => void) {
  setReviewAuthor(QA);
  setTracking(true);
  try {
    fn();
  } finally {
    setTracking(false);
  }
}
afterEach(() => {
  setTracking(false);
  setReviewAuthor("");
});

describe("recording changes while typing", () => {
  it("typed text is the reviewer's insertion; keys typed one after another are one insertion", () => {
    recording(() => {
      let ps = [para(run("abc"))];
      let pos = { p: 0, o: 1 };
      for (const ch of "XY") ({ paras: ps, pos } = RT.insertText(ps, pos, ch));
      expect(marks(ps[0])).toEqual([["a", ""], ["XY", "ins"], ["bc", ""]]);
      expect(ps[0].runs[1].rev!.author).toBe(QA);
      expect(ps[0].runs[1].rev!.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(collectChanges(ps).length).toBe(1);
    });
  });

  it("Backspace / Delete on original text strike it through (kept), the caret steps over it; again after it: one deletion", () => {
    recording(() => {
      let ps = [para(run("abcd"))];
      let r = RT.deleteChar(ps, { p: 0, o: 3 }, -1);
      expect(marks(r.paras[0])).toEqual([["ab", ""], ["c", "del"], ["d", ""]]);
      expect(r.pos).toEqual({ p: 0, o: 2 });
      r = RT.deleteChar(r.paras, r.pos, -1);
      expect(marks(r.paras[0])).toEqual([["a", ""], ["bc", "del"], ["d", ""]]);
      expect(RT.paraText(r.paras[0])).toBe("abcd");
      // Delete: the caret goes past the struck character
      ps = [para(run("abcd"))];
      r = RT.deleteChar(ps, { p: 0, o: 1 }, 1);
      expect(marks(r.paras[0])).toEqual([["a", ""], ["b", "del"], ["cd", ""]]);
      expect(r.pos).toEqual({ p: 0, o: 2 });
      // Backspace over text already deleted only moves the caret
      const again = RT.deleteChar(r.paras, { p: 0, o: 2 }, -1);
      expect(marks(again.paras[0])).toEqual(marks(r.paras[0]));
      expect(again.pos).toEqual({ p: 0, o: 1 });
    });
  });

  it("deleting the reviewer's own new text removes it for good; another author's insertion is struck through", () => {
    recording(() => {
      // (own: made in this session — doc-review3: the author name alone is not enough)
      let ps = [para(run("ab"), run("NEW", { rev: newRevision("ins") }), run("OLD", { rev: { kind: "ins", author: "Other", src: "2" } }))];
      ps = RT.deleteRange(ps, { start: { p: 0, o: 2 }, end: { p: 0, o: 8 } }).paras;
      expect(marks(ps[0])).toEqual([["ab", ""], ["OLD", "del"]]);
    });
  });

  it("selecting and typing: the selection is struck through and the new text follows it", () => {
    recording(() => {
      const ps = [para(run("one two"))];
      const d = RT.deleteRange(ps, { start: { p: 0, o: 4 }, end: { p: 0, o: 7 } });
      const r = RT.insertText(d.paras, d.pos, "2");
      expect(marks(r.paras[0])).toEqual([["one ", ""], ["two", "del"], ["2", "ins"]]);
    });
  });

  it("Enter makes an inserted paragraph mark; Backspace at a paragraph start marks the mark deleted (both paragraphs stay)", () => {
    recording(() => {
      let ps = [para(run("abcd"))];
      const s = RT.splitParagraph(ps, { p: 0, o: 2 });
      expect(text(s.paras)).toBe("ab|cd");
      expect(s.paras[0].markRev?.kind).toBe("ins");
      expect(s.paras[1].markRev).toBeUndefined();
      // Backspace at the start of the new paragraph: own mark → the paragraphs join again for good
      const j = RT.deleteChar(s.paras, { p: 1, o: 0 }, -1);
      expect(text(j.paras)).toBe("abcd");
      expect(j.paras[0].markRev).toBeUndefined();
      // an original paragraph mark: kept, marked deleted
      ps = [para(run("ab")), para(run("cd"))];
      const k = RT.deleteChar(ps, { p: 1, o: 0 }, -1);
      expect(text(k.paras)).toBe("ab|cd");
      expect(k.paras[0].markRev?.kind).toBe("del");
      expect(k.pos).toEqual({ p: 0, o: 2 });
    });
  });

  it("a selection over two paragraphs: text and the mark between struck through, caret at its end", () => {
    recording(() => {
      const ps = [para(run("abc")), para(run("def"))];
      const r = RT.deleteRange(ps, { start: { p: 0, o: 1 }, end: { p: 1, o: 2 } });
      expect(text(r.paras)).toBe("abc|def");
      expect(marks(r.paras[0])).toEqual([["a", ""], ["bc", "del"]]);
      expect(marks(r.paras[1])).toEqual([["de", "del"], ["f", ""]]);
      expect(r.paras[0].markRev?.kind).toBe("del");
      expect(r.pos).toEqual({ p: 1, o: 2 });
    });
  });

  it("without recording, editing is as before; joining paragraphs keeps the last one's mark change (QA risk 3)", () => {
    const ps = [para(run("ab")), para(run("cd"))];
    ps[1].markRev = { kind: "ins", author: QA, src: "9" };
    const r = RT.deleteChar(ps, { p: 1, o: 0 }, -1);
    expect(text(r.paras)).toBe("abcd");
    expect(r.paras[0].markRev?.src).toBe("9");
    // splitting: the first part ends in a new plain mark, the original mark goes with the text after the caret
    const s = RT.splitParagraph([{ ...para(run("abcd")), markRev: { kind: "del", author: QA, src: "3" } }], { p: 0, o: 2 });
    expect(s.paras[0].markRev).toBeUndefined();
    expect(s.paras[1].markRev?.src).toBe("3");
  });
});

describe("accepting and rejecting", () => {
  const doc = () => [
    para(run("keep "), run("gone ", { rev: { kind: "del", author: QA, src: "1" } }), run("new", { rev: { kind: "ins", author: QA, src: "2" } }), run(" bold", { bold: true, fmtRev: { kind: "fmt", author: QA, src: "3" } })),
    { ...para(run("next")), markRev: { kind: "del", author: QA, src: "4" } } as TextParagraph,
    para(run("last")),
  ];

  it("accept all: deletions go, insertions stay as text, a deleted paragraph mark joins the paragraphs", () => {
    const r = resolveChanges(doc(), true, pickAll);
    expect(text(r.paras)).toBe("keep new bold|nextlast");
    expect(r.paras.every((p) => !p.markRev && p.runs.every((x) => !x.rev && !x.fmtRev))).toBe(true);
    expect(r.count).toBe(4);
    expect(r.paras[0].runs.find((x) => x.text.includes("bold"))!.bold).toBe(true);
  });

  it("reject all: insertions go, deletions come back as text, the deleted mark stays a paragraph end", () => {
    const r = resolveChanges(doc(), false, pickAll);
    expect(text(r.paras)).toBe("keep gone  bold|next|last");
    expect(r.paras.every((p) => !p.markRev && p.runs.every((x) => !x.rev && !x.fmtRev))).toBe(true);
  });

  it("one change at the caret (the context menu), only that one", () => {
    const ps = doc();
    const at = changeAt(ps, { p: 0, o: 7 });
    expect(at?.key).toBe(`del|${QA}|1`);
    const r = resolveChanges(ps, true, pickInRange(ps, { start: { p: 0, o: 7 }, end: { p: 0, o: 7 } })!);
    expect(text(r.paras)).toBe("keep new bold|next|last");
    expect(r.paras[0].runs.some((x) => x.rev?.kind === "ins")).toBe(true);
    expect(r.count).toBe(1);
    // the caret at the end of a paragraph with a deleted mark: that mark
    const m = resolveChanges(ps, true, pickInRange(ps, { start: { p: 1, o: 4 }, end: { p: 1, o: 4 } })!);
    expect(text(m.paras)).toBe("keep gone new bold|nextlast");
    // no change at the caret
    expect(pickInRange(ps, { start: { p: 2, o: 2 }, end: { p: 2, o: 2 } })).toBeNull();
  });

  it("the changes inside a selection", () => {
    const ps = doc();
    const r = resolveChanges(ps, false, pickInRange(ps, { start: { p: 0, o: 0 }, end: { p: 0, o: 12 } })!);
    // the deletion (rejected: text again) and the insertion (rejected: gone) were inside; the format change was not
    expect(text(r.paras)).toBe("keep gone  bold|next|last");
    expect(r.paras[0].runs.some((x) => x.fmtRev)).toBe(true);
  });

  it("recorded typing then reject all = the text before; accept all = the text after", () => {
    setReviewAuthor(QA);
    let ps = [para(run("one two three"))];
    setTracking(true);
    ps = RT.deleteRange(ps, { start: { p: 0, o: 4 }, end: { p: 0, o: 8 } }).paras;
    ps = RT.insertText(ps, { p: 0, o: 8 }, "2 ").paras;
    ps = RT.splitParagraph(ps, { p: 0, o: 3 }).paras;
    setTracking(false);
    expect(text(resolveChanges(ps, false, pickAll).paras)).toBe("one two three");
    expect(text(resolveChanges(ps, true, pickAll).paras)).toBe("one| 2 three");
  });
});

describe("printing / PDF in a view of its own (QA risk 4)", () => {
  it("withReviewPrint: the export's view while it runs (no comment shading), the screen's after", async () => {
    const { withReviewPrint, hiddenInView, reviewLook, reviewView, setReviewView } = await import("../src/core/review");
    setReviewView("final");
    const del = run("x", { rev: { kind: "del", author: QA } });
    const com = run("y", { comments: ["c"] });
    expect(hiddenInView(del)).toBe(true);
    await withReviewPrint("markup", async () => {
      expect(reviewView()).toBe("markup");
      expect(hiddenInView(del)).toBe(false);
      expect(reviewLook(del).strike).toBe(true);
      expect(reviewLook(com).highlight).toBeUndefined();
    });
    expect(reviewView()).toBe("final");
    setReviewView("markup");
    expect(reviewLook(com).highlight).toBeTruthy();
  });
});

describe("comments", () => {
  it("a comment on a range, a reply on the same text, deleting the thread takes both off the text", () => {
    const ps = [para(run("abc def")), para(run("ghi"))];
    const c = newComment("look");
    let out = tagComment(ps, { start: { p: 0, o: 4 }, end: { p: 1, o: 2 } }, c.id)!;
    const on = (id: string) => out.flatMap((p) => p.runs.filter((r) => r.comments?.includes(id)).map((r) => r.text)).join("|");
    expect(on(c.id)).toBe("def|gh");
    const rp = newComment("ok", c.id);
    out = tagReply(out, c.id, rp.id);
    expect(on(rp.id)).toBe("def|gh");
    const list = [c, rp];
    expect([...threadIds(list, c.id)]).toEqual([c.id, rp.id]);
    out = untagComments(out, threadIds(list, c.id));
    expect(out.every((p) => p.runs.every((r) => !r.comments))).toBe(true);
    expect(text(out)).toBe("abc def|ghi");
    expect(out[0].runs.length).toBe(1);
    expect(tagComment(ps, { start: { p: 0, o: 2 }, end: { p: 0, o: 2 } }, "x")).toBeNull();
  });

  it("the reviewer name of the settings, else the fallback word; initials; resolve and edit", () => {
    setReviewAuthor("", "작성자");
    expect(newComment("a").author).toBe("작성자");
    setReviewAuthor("", "Author");
    expect(newComment("a").author).toBe("Author");
    setReviewAuthor(QA);
    const c = newComment("a");
    expect(c.author).toBe(QA);
    expect(c.initials).toBe("OQ");
    expect(initialsOf("홍길동")).toBe("홍");
    const r = newComment("b", c.id);
    let list = setThreadDone([c, r], r.id, true);
    expect(list.every((x) => x.done)).toBe(true);
    list = setThreadDone(list, c.id, false);
    expect(list.some((x) => x.done)).toBe(false);
    expect(editComment(list, c.id, "new text")[0].text).toBe("new text");
  });
});
