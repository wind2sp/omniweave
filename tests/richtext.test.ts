import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { strToU8, zipSync } from "fflate";
import * as RT from "../src/core/richtext";
import { layoutText } from "../src/core/text";
import { DEFAULT_RUN, newPage, newParagraph, newText, type TextParagraph, type TextRun } from "../src/core/types";
import { exportDocx, exportHwpx, parseDocx, parseHwpx } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const run = (text: string, f: Partial<TextRun> = {}): TextRun => ({ ...DEFAULT_RUN, ...f, text });
const para = (...runs: TextRun[]): TextParagraph => ({ ...newParagraph(""), runs });
const texts = (ps: TextParagraph[]) => ps.map(RT.paraText);
const at = (p: number, o: number): RT.Pos => ({ p, o });
const rg = (a: RT.Pos, b: RT.Pos): RT.Range => ({ start: a, end: b });
const runsOf = (p: TextParagraph) => p.runs.map((r) => [r.text, !!r.bold]);

describe("runs: split, slice, merge", () => {
  it("splits a run in the middle and at edges", () => {
    const runs = [run("가나다"), run("라마", { bold: true })];
    const [a, i] = RT.splitRunsAt(runs, 1);
    expect(a.map((r) => r.text)).toEqual(["가", "나다", "라마"]);
    expect(i).toBe(1);
    const [b, j] = RT.splitRunsAt(runs, 3);
    expect(b).toHaveLength(2);
    expect(j).toBe(1);
    expect(RT.splitRunsAt(runs, 5)[1]).toBe(2);
    expect(RT.splitRunsAt(runs, 0)[1]).toBe(0);
  });

  it("merges neighbours with the same format and drops empty runs", () => {
    const m = RT.mergeRuns([run("a"), run(""), run("b"), run("c", { bold: true }), run("d", { bold: true, strike: false })]);
    expect(m.map((r) => r.text)).toEqual(["ab", "cd"]);
    expect("strike" in m[1]).toBe(false); // default optional fields are removed
  });

  it("keeps one empty run (with its format) for an empty paragraph", () => {
    const m = RT.mergeRuns([run("", { bold: true, fontSize: 30 })]);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ text: "", bold: true, fontSize: 30 });
  });

  it("slices runs across boundaries", () => {
    const s = RT.sliceRuns([run("abc"), run("def", { italic: true })], 2, 4);
    expect(s.map((r) => [r.text, r.italic])).toEqual([["c", false], ["d", true]]);
  });

  it("treats missing optional fields as their defaults when comparing", () => {
    expect(RT.sameFormat(run("x"), run("y", { strike: false, letterSpacing: 0 }))).toBe(true);
    expect(RT.sameFormat(run("x"), run("y", { highlight: "#ffff00" }))).toBe(false);
  });
});

describe("character formatting on a range", () => {
  it("bolds the middle of a run (three-way split)", () => {
    const ps = [para(run("가나다라마"))];
    const out = RT.applyRunFormat(ps, rg(at(0, 1), at(0, 3)), { bold: true });
    expect(runsOf(out[0])).toEqual([["가", false], ["나다", true], ["라마", false]]);
    expect(ps[0].runs).toHaveLength(1); // input untouched
  });

  it("re-merges when the format is removed again", () => {
    const ps = [para(run("가나다라마"))];
    const on = RT.applyRunFormat(ps, rg(at(0, 1), at(0, 3)), { bold: true });
    const off = RT.applyRunFormat(on, rg(at(0, 0), at(0, 5)), { bold: false });
    expect(off[0].runs).toHaveLength(1);
    expect(off[0].runs[0].text).toBe("가나다라마");
  });

  it("spans several paragraphs, including an empty one", () => {
    const ps = [para(run("첫째 문단")), para(run("")), para(run("셋째 문단"))];
    const out = RT.applyRunFormat(ps, rg(at(0, 3), at(2, 2)), { color: "#ff0000" });
    expect(out[0].runs.map((r) => [r.text, r.color])).toEqual([["첫째 ", "#1d1f24"], ["문단", "#ff0000"]]);
    expect(out[1].runs[0].color).toBe("#ff0000"); // empty paragraph takes the format for typing
    expect(out[2].runs.map((r) => [r.text, r.color])).toEqual([["셋째", "#ff0000"], [" 문단", "#1d1f24"]]);
  });

  it("does nothing for a collapsed range", () => {
    const ps = [para(run("abc"))];
    expect(RT.applyRunFormat(ps, rg(at(0, 1), at(0, 1)), { bold: true })).toBe(ps);
  });

  it("accepts a backwards range", () => {
    const out = RT.applyRunFormat([para(run("abcd"))], rg(at(0, 3), at(0, 1)), { italic: true });
    expect(out[0].runs.map((r) => [r.text, r.italic])).toEqual([["a", false], ["bc", true], ["d", false]]);
  });

  it("toggles Word-style: on unless everything is already on", () => {
    const ps = [para(run("ab", { bold: true }), run("cd"))];
    const on = RT.toggleRunFormat(ps, rg(at(0, 0), at(0, 4)), "bold");
    expect(on[0].runs).toHaveLength(1);
    expect(on[0].runs[0].bold).toBe(true);
    const off = RT.toggleRunFormat(on, rg(at(0, 0), at(0, 4)), "bold");
    expect(off[0].runs[0].bold).toBe(false);
  });

  it("sets and clears superscript, strike, highlight, letter spacing as optional fields", () => {
    let ps = [para(run("H2O"))];
    ps = RT.toggleScript(ps, rg(at(0, 1), at(0, 2)), "sub");
    expect(ps[0].runs.map((r) => [r.text, r.script])).toEqual([["H", undefined], ["2", "sub"], ["O", undefined]]);
    ps = RT.toggleScript(ps, rg(at(0, 1), at(0, 2)), "sub");
    expect(ps[0].runs).toHaveLength(1);
    expect("script" in ps[0].runs[0]).toBe(false);
    ps = RT.applyRunFormat(ps, rg(at(0, 0), at(0, 3)), { strike: true, highlight: "#FFFF00", letterSpacing: 2 });
    expect(ps[0].runs[0]).toMatchObject({ strike: true, highlight: "#FFFF00", letterSpacing: 2 });
    ps = RT.applyRunFormat(ps, rg(at(0, 0), at(0, 3)), { strike: false, highlight: null, letterSpacing: 0 });
    expect(Object.keys(ps[0].runs[0]).sort()).toEqual(Object.keys(DEFAULT_RUN).sort());
  });

  it("reports the common format of a selection (mixed keys absent)", () => {
    const ps = [para(run("ab", { bold: true, fontSize: 20 }), run("cd", { fontSize: 20 }))];
    const f = RT.rangeFormat(ps, rg(at(0, 0), at(0, 4)));
    expect(f.fontSize).toBe(20);
    expect("bold" in f).toBe(false);
    expect(RT.rangeFormat(ps, rg(at(0, 1), at(0, 1))).bold).toBe(true); // caret: char before
    expect(RT.rangeFormat(ps, rg(at(0, 2), at(0, 2))).bold).toBe(true); // boundary: previous run
    expect(RT.rangeFormat(ps, rg(at(0, 0), at(0, 0))).bold).toBe(true); // start: first char
  });
});

describe("Hangul graphemes", () => {
  // "한" written as conjoining jamo (3 code units, one grapheme) + an emoji with a skin tone
  const jamo = "한";
  const emoji = "👍🏽";
  it("never splits inside a grapheme", () => {
    const s = `가${jamo}나${emoji}`;
    expect(RT.snapOffset(s, 2, -1)).toBe(1);
    expect(RT.snapOffset(s, 2, 1)).toBe(4);
    const out = RT.applyRunFormat([para(run(s))], rg(at(0, 2), at(0, 6)), { bold: true });
    expect(out[0].runs.map((r) => r.text)).toEqual(["가", `${jamo}나${emoji}`]);
  });

  it("backspace deletes a whole grapheme and Delete joins paragraphs", () => {
    const ps = [para(run(`가${jamo}`)), para(run("다"))];
    const b = RT.deleteChar(ps, at(0, 4), -1);
    expect(texts(b.paras)).toEqual(["가", "다"]);
    expect(b.pos).toEqual(at(0, 1));
    const d = RT.deleteChar(b.paras, at(0, 1), 1);
    expect(texts(d.paras)).toEqual(["가다"]);
    const e = RT.deleteChar([para(run(`x${emoji}`))], at(0, 5), -1);
    expect(texts(e.paras)).toEqual(["x"]);
  });
});

describe("text editing", () => {
  it("inserts with the caret format or an explicit next-input format", () => {
    const ps = [para(run("ab", { bold: true }), run("cd"))];
    const a = RT.insertText(ps, at(0, 2), "X");
    expect(runsOf(a.paras[0])).toEqual([["abX", true], ["cd", false]]);
    const b = RT.insertText(ps, at(0, 2), "Y", { ...RT.formatAt(ps, at(0, 2)), bold: false, italic: true });
    expect(b.paras[0].runs.map((r) => [r.text, r.bold, r.italic])).toEqual([["ab", true, false], ["Y", false, true], ["cd", false, false]]);
    expect(b.pos).toEqual(at(0, 3));
  });

  it("inserts multi-line text as new paragraphs keeping paragraph properties", () => {
    const p = { ...para(run("시작끝")), align: "CENTER" as const };
    const r = RT.insertText([p], at(0, 2), "하나\n둘\r\n셋");
    expect(texts(r.paras)).toEqual(["시작하나", "둘", "셋끝"]);
    expect(r.paras.every((x) => x.align === "CENTER")).toBe(true);
    expect(new Set(r.paras.map((x) => x.id)).size).toBe(3);
    expect(r.pos).toEqual(at(2, 1));
  });

  it("deletes across paragraphs and keeps the first paragraph's properties", () => {
    const ps = [{ ...para(run("abc")), align: "RIGHT" as const }, para(run("def")), para(run("ghi", { bold: true }))];
    const r = RT.deleteRange(ps, rg(at(0, 1), at(2, 1)));
    expect(texts(r.paras)).toEqual(["ahi"]);
    expect(r.paras[0].align).toBe("RIGHT");
    expect(runsOf(r.paras[0])).toEqual([["a", false], ["hi", true]]);
    expect(r.pos).toEqual(at(0, 1));
  });

  it("deleting everything leaves one empty paragraph with the deleted format", () => {
    const r = RT.deleteRange([para(run("굵은", { bold: true }))], rg(at(0, 0), at(0, 2)));
    expect(r.paras[0].runs).toEqual([{ ...run("", { bold: true }) }]);
  });

  it("splits a paragraph (Enter) with formats on both sides", () => {
    const ps = [para(run("ab"), run("cd", { bold: true }))];
    const r = RT.splitParagraph(ps, at(0, 3));
    expect(texts(r.paras)).toEqual(["abc", "d"]);
    expect(r.paras[1].runs[0].bold).toBe(true);
    expect(r.pos).toEqual(at(1, 0));
    const e = RT.splitParagraph(ps, at(0, 4));
    expect(e.paras[1].runs).toHaveLength(1);
    expect(e.paras[1].runs[0]).toMatchObject({ text: "", bold: true });
  });

  it("Enter after a heading starts body text", () => {
    const h = RT.setHeading([para(run("제목")), para(run("본문 글자", { fontSize: 16 }))], 0, 0, 1);
    const r = RT.splitParagraph(h, at(0, 2), { body: RT.bodyFormat(h) });
    expect(r.paras[0].role).toBe("h1");
    expect(r.paras[1].role).toBeUndefined();
    expect(r.paras[1].runs[0]).toMatchObject({ fontSize: 16, bold: false });
  });

  it("copies a range as plain text", () => {
    expect(RT.rangeText([para(run("abc")), para(run("def"))], rg(at(0, 1), at(1, 2)))).toBe("bc\nde");
  });
});

describe("paragraph formatting", () => {
  const three = () => [para(run("하나")), para(run("둘")), para(run("셋"))];

  it("changes only the paragraphs under the caret / selection", () => {
    const out = RT.applyParaFormat(three(), 1, 2, { align: "CENTER", lineSpacing: 2, indentLeft: 30, spaceAfter: 12, indent: -10 });
    expect(out.map((p) => p.align)).toEqual(["LEFT", "CENTER", "CENTER"]);
    expect(out[1]).toMatchObject({ lineSpacing: 2, indentLeft: 30, spaceAfter: 12, indent: -10 });
    expect("indentLeft" in out[0]).toBe(false);
    expect("indentLeft" in RT.applyParaFormat(out, 1, 1, { indentLeft: 0 })[1]).toBe(false);
  });

  it("reports common paragraph properties", () => {
    const out = RT.applyParaFormat(three(), 1, 1, { align: "RIGHT" });
    expect(RT.paraFormat(out, 0, 0).align).toBe("LEFT");
    expect(RT.paraFormat(out, 0, 1).align).toBeUndefined();
    expect(RT.paraFormat(out, 0, 2).lineSpacing).toBe(1.6);
  });

  it("toggles bullets with real marker text", () => {
    const r = RT.toggleList(three(), 0, 1, "li");
    expect(texts(r.paras)).toEqual(["• 하나", "• 둘", "셋"]);
    expect(r.paras[0].role).toBe("li");
    expect(r.delta).toEqual([2, 2, 0]);
    const back = RT.toggleList(r.paras, 0, 1, "li");
    expect(texts(back.paras)).toEqual(["하나", "둘", "셋"]);
    expect(back.paras[0].role).toBeUndefined();
    expect(back.delta).toEqual([-2, -2, 0]);
  });

  it("numbers lists and renumbers after edits", () => {
    const r = RT.toggleList(three(), 0, 2, "oli");
    expect(texts(r.paras)).toEqual(["1. 하나", "2. 둘", "3. 셋"]);
    // bullets → numbers replaces the marker
    const b = RT.toggleList(RT.toggleList(three(), 0, 2, "li").paras, 0, 2, "oli");
    expect(texts(b.paras)).toEqual(["1. 하나", "2. 둘", "3. 셋"]);
    // Enter in the middle of a numbered item continues and renumbers
    const s = RT.splitParagraph(r.paras, at(0, 5));
    expect(texts(s.paras)).toEqual(["1. 하나", "2. ", "3. 둘", "4. 셋"]);
    expect(s.pos).toEqual(at(1, 3));
    // Enter on the empty item ends the list
    const e = RT.splitParagraph(s.paras, s.pos);
    expect(texts(e.paras)).toEqual(["1. 하나", "", "1. 둘", "2. 셋"]);
    expect(e.paras[1].role).toBeUndefined();
  });

  it("applies heading 1–3 and back to body", () => {
    const ps = [para(run("제목", { fontSize: 18 })), para(run("본문", { fontSize: 18 }))];
    const h2 = RT.setHeading(ps, 0, 0, 2);
    expect(h2[0].role).toBe("h2");
    expect(h2[0].runs[0]).toMatchObject({ bold: true, fontSize: 25.2 });
    expect(h2[1]).toBe(ps[1]);
    const body = RT.setHeading(h2, 0, 0, 0);
    expect(body[0].role).toBeUndefined();
    expect(body[0].runs[0]).toMatchObject({ bold: false, fontSize: 18 });
  });

  it("whole-box helpers format every run", () => {
    const ps = [para(run("a", { bold: true }), run("b")), para(run(""))];
    const on = RT.toggleAll(ps, "bold");
    expect(on.flatMap((p) => p.runs.map((r) => r.bold))).toEqual([true, true]);
    expect(RT.scriptAll(on, "super")[0].runs[0].script).toBe("super");
    expect(RT.formatAll(on, { color: "#00ff00" })[1].runs[0].color).toBe("#00ff00");
  });
});

describe("paste HTML", () => {
  it("keeps only bold, italic and underline, with block breaks", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><p>일반 <b>굵게</b> <span style="font-style: italic">기울임</span></p><p><u>밑줄</u><br/>둘째 줄<span style="color:red;font-size:40px">색</span></p><script>x()</script></body></html>`,
      "text/html",
    );
    const lines = RT.htmlToSegments(doc as unknown as Node);
    expect(lines.map((l) => l.map((s) => s.text).join(""))).toEqual(["일반 굵게 기울임", "밑줄", "둘째 줄색"]);
    expect(lines[0].find((s) => s.text === "굵게")?.bold).toBe(true);
    expect(lines[0].find((s) => s.text === "기울임")?.italic).toBe(true);
    expect(lines[1][0].underline).toBe(true);
    const r = RT.insertSegments([para(run("[]", { fontSize: 30 }))], at(0, 1), lines);
    expect(texts(r.paras)).toEqual(["[일반 굵게 기울임", "밑줄", "둘째 줄색]"]);
    expect(r.paras.flatMap((p) => p.runs).every((x) => x.fontSize === 30)).toBe(true); // caret format
    expect(r.paras[0].runs.find((x) => x.text === "굵게")?.bold).toBe(true);
  });
});

describe("layout of the new formats", () => {
  it("letter spacing widens pieces, scripts shift the baseline, left indent moves lines", () => {
    const base = newText("가나다", 1000);
    const wide = { ...base, paragraphs: [{ ...base.paragraphs[0], runs: [{ ...base.paragraphs[0].runs[0], letterSpacing: 5 }] }] };
    expect(layoutText(wide).lines[0].width - layoutText(base).lines[0].width).toBeCloseTo(15, 5);
    const sup = { ...base, paragraphs: [{ ...base.paragraphs[0], runs: [run("x"), run("2", { script: "super" })] }] };
    const pieces = layoutText(sup).lines[0].pieces;
    expect(pieces[1].dy).toBeLessThan(0);
    expect(pieces[0].dy).toBeUndefined();
    const ind = { ...base, paragraphs: [{ ...base.paragraphs[0], indentLeft: 40 }] };
    expect(layoutText(ind).lines[0].pieces[0].x).toBe(40);
  });

  it("wrapped lines start at the left indent; the first line adds the first-line indent", () => {
    const t = newText("가나다라 마바사아 자차카타 파하가나", 120);
    t.paragraphs[0] = { ...t.paragraphs[0], indentLeft: 20, indent: 10 };
    const lines = layoutText(t).lines;
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0].pieces[0].x).toBe(30);
    expect(lines[1].pieces[0].x).toBe(20);
  });
});

describe("DOCX / HWPX round trip of the new formats", () => {
  const sample = () => {
    const page = newPage("DOCUMENT");
    const t = newText("", 600);
    t.paragraphs = [
      { ...para(run("제목", { fontSize: 32, bold: true })), role: "h1" },
      {
        ...para(
          run("보통 "),
          run("취소", { strike: true }),
          run("x"),
          run("2", { script: "super" }),
          run("H"),
          run("2", { script: "sub" }),
          run(" 형광", { highlight: "#FFFF00" }),
          run(" 자간", { letterSpacing: 2 }),
        ),
        indentLeft: 24,
        indent: -12,
        align: "JUSTIFY" as const,
      },
    ];
    page.nodes.push(t);
    return page;
  };
  const find = (ps: TextParagraph[], text: string) => ps.flatMap((p) => p.runs).find((r) => r.text === text);

  it("DOCX keeps strike, super/subscript, highlight, letter spacing, indents and headings", () => {
    const back = parseDocx(exportDocx([sample()]));
    expect(texts(back)).toEqual(["제목", "보통 취소x2H2 형광 자간"]);
    expect(back[0].role).toBe("h1");
    expect(find(back, "취소")?.strike).toBe(true);
    const twos = back[1].runs.filter((r) => r.text === "2");
    expect(twos.map((r) => r.script)).toEqual(["super", "sub"]);
    expect(find(back, " 형광")?.highlight).toBe("#FFFF00");
    expect(find(back, " 자간")?.letterSpacing).toBeCloseTo(2, 1);
    expect(find(back, "보통 ")?.strike).toBeUndefined();
    expect(back[1].indentLeft).toBeCloseTo(24, 0);
    expect(back[1].indent).toBeCloseTo(-12, 0);
    expect(back[1].align).toBe("JUSTIFY");
  });

  it("DOCX reads named w:highlight colours", () => {
    const bytes = zipSync({
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:rPr><w:highlight w:val="green"/><w:dstrike/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>`,
      ),
    });
    expect(parseDocx(bytes)[0].runs[0]).toMatchObject({ highlight: "#00FF00", strike: true });
  });

  it("HWPX keeps strikeout, supscript/subscript, shadeColor, spacing and left margin", () => {
    const back = parseHwpx(exportHwpx([sample()], "서식"));
    expect(texts(back)).toEqual(["제목", "보통 취소x2H2 형광 자간"]);
    expect(find(back, "취소")?.strike).toBe(true);
    expect(find(back, "보통 ")?.strike).toBeUndefined();
    expect(back[1].runs.filter((r) => r.text === "2").map((r) => r.script)).toEqual(["super", "sub"]);
    expect(find(back, " 형광")?.highlight).toBe("#FFFF00");
    // HWPX stores 자간 as % of each character's advance: 2 px is written as 2 ÷ size % and comes back as that
    // (한글 semantics, core/types.ts TextRun.spacingPct) instead of an absolute letterSpacing
    const sp = find(back, " 자간");
    expect(sp?.letterSpacing).toBeUndefined();
    expect(sp?.spacingPct).toBe(Math.round((2 / sp!.fontSize) * 100));
    expect(back[1].indentLeft).toBeCloseTo(24, 0);
    expect(back[1].indent).toBeCloseTo(-12, 0);
  });
});
