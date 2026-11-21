import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { parseHwpx } from "../../src/io/office";
import { layoutText, measure } from "../../src/core/text";
import { DEFAULT_RUN, newParagraph, newText, type TextParagraph } from "../../src/core/types";
import { lineStartsOf, simulateParagraph } from "../../src/core/layoutcheck/simulate";
import { hancomIndent, hancomTokenizer, hancomWidth } from "../../src/core/layoutcheck/hancomRules";
import { charClass, fitProfile, koreanPrior, lockedAdvance } from "../../src/core/layoutcheck/fallbackMetrics";
import { readHwpxTruth, type HwpxParaShape } from "../../src/core/layoutcheck/hwpxLineseg";
import { compareLayout } from "../../src/core/layoutcheck/compare";
import { header, hwpx, p, run, seg, segs, t } from "./fixture";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const para = (text: string, extra: Partial<TextParagraph> = {}, size = 13.3): TextParagraph => ({ ...newParagraph(text, { fontSize: size }), ...extra });

describe("simulateParagraph reproduces layoutText", () => {
  const cases: [string, TextParagraph, number][] = [
    ["plain Korean", para("Omni 분기 보고서의 매출은 지난 분기보다 늘었고 비용은 줄었습니다. 다음 분기 계획도 함께 적습니다."), 200],
    ["hard line break", para("첫 줄\n둘째 줄 이어서 길게 쓰는 문장입니다"), 150],
    ["long token", para("가나다라마바사아자차카타파하가나다라마바사아자차카타파하 끝"), 120],
    ["indent + left", para("들여쓰기와 왼쪽 여백이 있는 문단을 여러 줄로 나눕니다 계속 씁니다", { indent: 20, indentLeft: 10 }), 180],
    ["hanging", para("내어쓰기 문단은 첫 줄이 왼쪽으로 나옵니다 계속 이어지는 문장", { indent: -15, indentLeft: 30 }), 180],
    ["letter spacing + runs", { ...para(""), runs: [{ ...DEFAULT_RUN, fontSize: 14, text: "자간이 있는 ", letterSpacing: 1.5 }, { ...DEFAULT_RUN, fontSize: 18, bold: true, text: "굵은 글자와 큰 글자 섞기 " }, { ...DEFAULT_RUN, fontSize: 12, text: "작은 글자\n다음 줄" }] }, 160],
  ];
  it("on seeded random paragraphs (any layoutText change must be mirrored in simulate.ts)", () => {
    let s = 20261112;
    const rnd = () => ((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    const words = ["Omni", "분기", "보고서의", "매출은", "가나다라마바사아자차카타파하가나다라", "report.", "(요약)", "12,345", "\t", "\n", " ", "  "];
    for (let k = 0; k < 200; k++) {
      const runs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => ({
        ...DEFAULT_RUN,
        fontSize: pick([10, 13.3, 18]),
        bold: rnd() < 0.3,
        letterSpacing: pick([0, 0, 1.5, -0.5]),
        script: pick([undefined, undefined, "super"] as const),
        text: Array.from({ length: Math.floor(rnd() * 12) }, () => pick(words) + (rnd() < 0.7 ? " " : "")).join(""),
      }));
      const q: TextParagraph = { ...para(""), runs, indent: pick([0, 12, -10]), indentLeft: pick([undefined, 0, 20]) };
      const w = pick([40, 120, 260]);
      const lay = layoutText({ ...newText("", w), paragraphs: [q] });
      const sim = simulateParagraph(q, w);
      expect(sim.map((l) => l.start), `case ${k}`).toEqual(lineStartsOf(lay, q));
      expect(sim.map((l) => l.height), `case ${k}`).toEqual(lay.lines.map((l) => l.height));
    }
  });
  for (const [name, q, w] of cases)
    it(name, () => {
      const lay = layoutText({ ...newText("", w), paragraphs: [q] });
      const sim = simulateParagraph(q, w);
      expect(sim.map((l) => l.start)).toEqual(lineStartsOf(lay, q));
      expect(sim.map((l) => l.height)).toEqual(lay.lines.map((l) => l.height));
      expect(sim.length).toBeGreaterThan(1);
    });
});

describe("Hangul rules", () => {
  const shape = (o: Partial<HwpxParaShape>) => ({ breakNonLatinWord: "KEEP_WORD", condense: 0, left: 0, intent: 0, ...o }) as HwpxParaShape;
  it("KEEP_WORD (한글 단위 글자) splits Hangul between syllables, keeps Latin words, and kinsoku keeps marks attached", () => {
    const tok = hancomTokenizer(shape({}), { breakWord: true, kinsoku: true });
    expect(tok("보고서는 Omni report다. (요약)", DEFAULT_RUN, 0)).toEqual(["보", "고", "서", "는 ", "Omni ", "report", "다. ", "(요", "약)"]);
    const keep = hancomTokenizer(shape({ breakNonLatinWord: "BREAK_WORD" }), { breakWord: true, kinsoku: false });
    expect(keep("보고서는 Omni", DEFAULT_RUN, 0)).toEqual(["보고서는 ", "Omni"]);
  });
  it("margins are plain HWPUNIT after readHeader; negative intent is 내어쓰기", () => {
    const q = hancomIndent(para("x"), shape({ left: 1500, intent: -3000 }));
    expect(q.indentLeft).toBeCloseTo(60, 5); // 1500 + 3000 hu = 4500 hu = 60 px
    expect(q.indent).toBeCloseTo(-40, 5);
  });
  it("장평 scales advances, saved tab widths replace measured ones", () => {
    const font = "400 13.3px Pretendard";
    const cs = { ratio: { hangul: 90, latin: 90 }, spacing: { hangul: 0, latin: 0 } } as any;
    const w = hancomWidth({ shapeAt: () => cs, ratio: true, spacing: false });
    expect(w("보고서", DEFAULT_RUN, font, 0)).toBeCloseTo(measure("보고서", font) * 0.9, 6);
    const tabbed = hancomWidth({ shapeAt: () => cs, ratio: false, spacing: false, tabAt: (at) => (at === 2 ? 40 : undefined) });
    expect(tabbed("가나\t다", DEFAULT_RUN, font, 0)).toBeCloseTo(measure("가나", font) + 40 + measure("다", font), 6);
  });
});

describe("metric-locked fallback", () => {
  it("classifies characters", () => {
    expect([..."가A1 .※漢"].map(charClass)).toEqual(["hangul", "latin", "digit", "space", "punct", "symbol", "cjk"]);
  });
  it("prior locks Hangul to a 1-em square, scales the rest", () => {
    const font = "400 20px Pretendard";
    expect(lockedAdvance("가나다", DEFAULT_RUN, font, koreanPrior())).toBeCloseTo(60, 6);
    const p = koreanPrior();
    p.scale.latin = 0.5;
    expect(lockedAdvance("ab", DEFAULT_RUN, font, p)).toBeCloseTo(measure("ab", font) * 0.5, 6);
  });
  it("coordinate search finds the scale an objective prefers", () => {
    const r = fitProfile(koreanPrior(), (p) => -Math.abs(p.scale.latin - 0.83) - Math.abs(p.scale.space - 1.12), ["latin", "space"]);
    expect(r.profile.scale.latin).toBeCloseTo(0.83, 2);
    expect(r.profile.scale.space).toBeCloseTo(1.12, 2);
  });
});

describe("compareLayout", () => {
  // Breaks written from our own layout are identical by construction; a moved break is reported.
  const text = "Omni 분기 보고서는 매출과 비용과 이익을 한눈에 보여 주는 문서입니다. 다음 분기 목표도 함께 적어 둡니다.";
  const width = 15000; // hu = 200 px
  const ourBreaks = () => {
    const bytes = hwpx([p(run(t(text)), segs(seg(0, 0, { horzsize: width })))]);
    // our own breaking: without the saved lines (one line here) the paragraph would be drawn with
    const { hwpLines: _saved, ...q } = parseHwpx(bytes)[0];
    return lineStartsOf(layoutText({ ...newText("", width / 75), paragraphs: [q] }), q).slice(1);
  };
  it("identical breaks score 100 %, a moved break is caught with its line", () => {
    const br = ourBreaks();
    expect(br.length).toBeGreaterThan(0);
    const make = (b: number[]) => hwpx([p(run(t(text)), segs(seg(0, 0, { horzsize: width }), ...b.map((x, k) => seg(x, 1600 * (k + 1), { horzsize: width }))))]);
    const good = make(br);
    const rep = compareLayout(readHwpxTruth(good), parseHwpx(good), { fit: false });
    expect(rep.compared).toBe(1);
    expect(rep.simulatorAgrees).toBe(1);
    expect(rep.configs[0].metrics).toMatchObject({ identical: 1, identicalPct: 100, meanAbsDeltaLines: 0 });
    expect(rep.overlay[0]).toMatchObject({ same: true, firstDiffLine: -1 });
    const bad = make([br[0] - 2, ...br.slice(1)]);
    const rep2 = compareLayout(readHwpxTruth(bad), parseHwpx(bad), { fit: false });
    expect(rep2.configs[0].metrics.identical).toBe(0);
    expect(rep2.overlay[0].firstDiffLine).toBe(1);
    expect(rep2.overlay[0].lines[1]).toMatchObject({ same: false, ourStart: br[0], truthStart: br[0] - 2 });
    expect(Object.values(rep2.primary).reduce((a, b) => a + b, 0)).toBe(1);
  });
  it("paragraphs without lineseg are skipped, not counted as matches or mismatches", () => {
    const bytes = hwpx([p(run(t(text)), segs(seg(0, 0, { horzsize: width }))), p(run(t(text))), p(run(t("짧은 문단")))]);
    const rep = compareLayout(readHwpxTruth(bytes), parseHwpx(bytes), { fit: false });
    expect(rep.paragraphs).toBe(3);
    expect(rep.compared).toBe(1);
    expect(rep.skipped).toEqual({ "no-lineseg": 2 });
    expect(rep.configs.every((c) => c.metrics.compared === 1)).toBe(true);
    expect(rep.overlay.map((o) => o.index)).toEqual([0]);
  });
  it("names the rule that explains a mismatch (글자 단위)", () => {
    // Hangul broke inside a word (between syllables) because the paragraph breaks by 글자 (OWPML KEEP_WORD)
    const head = header({ breakNonLatin: "KEEP_WORD" });
    const q = parseHwpx(hwpx([p(run(t(text)), segs(seg(0, 0, { horzsize: width })))], head))[0];
    const sim = simulateParagraph(q, width / 75, { tokenize: hancomTokenizer({ breakNonLatinWord: "KEEP_WORD" } as HwpxParaShape, { breakWord: true, kinsoku: true }) });
    const br = sim.slice(1).map((l) => l.start);
    const bytes = hwpx([p(run(t(text)), segs(seg(0, 0, { horzsize: width }), ...br.map((x, k) => seg(x, 1600 * (k + 1), { horzsize: width }))))], head);
    const rep = compareLayout(readHwpxTruth(bytes), parseHwpx(bytes), { fit: false });
    const fixed = rep.configs.find((c) => c.name === "rules")!.metrics.identical;
    expect(fixed).toBe(1);
    if (rep.configs[0].metrics.identical === 0) expect(rep.fixedAlone.breakRules).toBe(1);
  });
});
