// Spelling (core/spell.ts): which words are checked, in which language, where their underline goes, and replacing a word.
import { describe, expect, it } from "vitest";
import { langOfWord, replaceInRuns, spellWords, tableMarks, textMarks, wavePoints } from "../src/core/spell";
import { DEFAULT_RUN, newParagraph, newTable, newText, type TextRun } from "../src/core/types";

const run = (text: string, extra: Partial<TextRun> = {}): TextRun => ({ ...DEFAULT_RUN, text, ...extra });

describe("spelling words", () => {
  it("checks words like Word: no digits, capitals, one letter, addresses", () => {
    const w = spellWords("I saw teh NASA file a.txt at x@y.com in 2026 abc123 don't 안녕하새요 漢字", "en-GB").map((x) => `${x.word}:${x.lang}`);
    expect(w).toEqual(["saw:en-GB", "teh:en-GB", "file:en-GB", "at:en-GB", "in:en-GB", "don't:en-GB", "안녕하새요:ko-KR"]);
  });
  it("languages by script", () => {
    expect(langOfWord("hello", "fr-FR")).toBe("fr-FR");
    expect(langOfWord("한글", "en-US")).toBe("ko-KR");
    expect(langOfWord("ひらがな", "en-US")).toBe("ja-JP");
    expect(langOfWord("漢字", "en-US")).toBeNull();
    expect(langOfWord("Привет", "en-US")).toBeNull();
  });
});

describe("spelling marks", () => {
  it("underlines a misspelled word under its own text, across runs", () => {
    const n = newText("", 400);
    const p = newParagraph();
    p.runs = [run("the qu", { fontSize: 20 }), run("ikc fox", { fontSize: 20, bold: true })];
    n.paragraphs = [p];
    const marks = textMarks(n, (w) => w === "quikc", "en-US");
    expect(marks).toHaveLength(1);
    const m = marks[0];
    expect([m.para, m.start, m.end, m.word]).toEqual([0, 4, 9, "quikc"]);
    expect(m.segs.length).toBe(2);
    expect(m.segs[0].x0).toBeGreaterThan(0);
    expect(m.segs[1].x1).toBeGreaterThan(m.segs[0].x1);
    expect(textMarks(n, () => false, "en-US")).toEqual([]);
  });
  it("finds words in plain table cells", () => {
    const t = newTable([["a", "b"], ["c", ""]], [200, 200]);
    t.rows[1][1] = { text: "good wrod" };
    const m = tableMarks(t, (w) => w === "wrod", "en-US");
    expect(m).toHaveLength(1);
    expect(m[0].cell).toEqual({ r: 1, c: 1, rich: false });
    expect([m[0].start, m[0].end]).toEqual([5, 9]);
  });
  it("replaces a word that spans runs in the first run's format", () => {
    const out = replaceInRuns([run("the qu"), run("ikc", { bold: true }), run(" fox")], 4, 9, "quick");
    expect(out.map((r) => [r.text, r.bold])).toEqual([["the quick", false], [" fox", false]]);
  });
  it("draws a wave", () => {
    const pts = wavePoints(0, 8, 10, 2, 4);
    expect(pts[0]).toEqual([0, 10]);
    expect(pts[pts.length - 1][0]).toBe(8);
    expect(Math.max(...pts.map((p) => p[1]))).toBe(12);
  });
});
