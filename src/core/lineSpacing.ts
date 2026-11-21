// Line spacing of a paragraph — two kinds of "multiple" (docs/design/UNIFIED_STYLES.md 4.9, lineHeight basis):
//
//   percent of the font size  `lineSpacing` alone: line height = size × lineSpacing. 한글 PERCENT (160% = 1.6),
//                             every Omniweave document before Word multiples, PowerPoint spcPct (× 1.2, see below).
//   Word multiple             `lineMultiple` (basis "font"): line height = the font's own single line × v. Word
//                             w:line lineRule auto (240 = 1.0), the 배수 Word users set (1.0 / 1.08 / 1.15 / 1.5 / 2.0).
//
// A Word-multiple paragraph still carries `lineSpacing`: the size multiple of the same height when it was set, so
// older apps (which only know lineSpacing) draw it as tall as we do. `lineMultiple.lineSpacing` records that value;
// when an older app edits lineSpacing the two differ and the paragraph is a percent paragraph again (its edit wins).
//
// "Single" line per font, measured in Word (Microsoft 365, 2026-11-12; qa: line pitch of 1.0 / 1.5 / 2.0 at 10, 12,
// 20 pt in Word's own PDF, Pretendard embedded in the DOCX): a font with the Korean code page (OS/2 ulCodePageRange
// bit 19 — Pretendard, 맑은 고딕, 바탕, 굴림 …) gets (winAscent + winDescent) × 1.3 for ALL its text, Latin too;
// a Latin font gets ascent + descent + line gap, and its Hangul characters fall back to the East Asian font (맑은
// 고딕 on Korean Windows: 1.729). Word's pitch is these times the size, ±0.01 pt.
//
// PowerPoint is different: spcPct 100% is 1.2 × the size for every font (measured, same cases), so PPTX line
// spacing is a percent-of-size value (pptx.ts) and a Word multiple is converted to the same height there.

import type { TextParagraph, TextRun } from "./types";

/** Hangul / CJK text: Word uses the East Asian font's line height for the line. */
export const EAST_ASIAN = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

/** 맑은 고딕 (2229 + 495) / 2048 × 1.3 — Word's single line of Hangul in a Latin font on Korean Windows */
const EA_FALLBACK = 1.729;
/** fonts with the Korean code page whose win ascent + descent is 1 em (바탕, 굴림, 돋움, 궁서 and their -체) */
const KOREAN_1EM = ["바탕", "batang", "바탕체", "batangche", "굴림", "gulim", "굴림체", "gulimche", "돋움", "dotum", "돋움체", "dotumche", "궁서", "gungsuh", "궁서체", "gungsuhche"]; // i18n: keep — font names matched in files

/** Word single line ÷ size: [Latin text, lines with Hangul / CJK]. */
const LINE_RATIO: Record<string, [number, number]> = {
  pretendard: [1.551, 1.551],
  "맑은 고딕": [1.729, 1.729], "malgun gothic": [1.729, 1.729], // i18n: keep — font names matched in files
  "segoe ui": [1.33, EA_FALLBACK],
  calibri: [1.221, EA_FALLBACK], arial: [1.15, EA_FALLBACK], cambria: [1.172, EA_FALLBACK], "times new roman": [1.15, EA_FALLBACK], consolas: [1.171, EA_FALLBACK],
  ...Object.fromEntries(KOREAN_1EM.map((f) => [f, [1.3, 1.3] as [number, number]])),
  // (winAscent + winDescent) 1.15 em (font files, 2026-11-12)
  ...Object.fromEntries(["나눔고딕", "nanumgothic", "나눔명조", "nanummyeongjo", "나눔바른고딕", "nanumbarungothic"].map((f) => [f, [1.495, 1.495] as [number, number]])), // i18n: keep — font names matched in files
  // 함초롬바탕 (HANBatang: win 1070 + 230 / 1000, qa/interop/hancom-made/hcr-batang-metrics.json); 함초롬돋움 is taken as the
  // same family's metrics (not measured)
  ...Object.fromEntries(["함초롬바탕", "hcr batang", "함초롬돋움", "hcr dotum"].map((f) => [f, [1.69, 1.69] as [number, number]])), // i18n: keep — font names matched in files
};

/** HY (한양) fonts: Korean code page, win ascent + descent 1 em (every H2*.TTF) */
const HY = /^hy/;
/**
 * Other Korean fonts (a Hangul name or a Korean family prefix): one line for all their text like every Korean code page
 * font; measured ones span 1.30–1.73 (나눔 1.495, KoPub 1.43, 카카오 1.48), so 1.5 is the least wrong guess.
 */
const KOREAN_NAME = /[가-힣]|^(nanum|kopub|hcr|hancom|noto (sans|serif) (kr|cjk)|source han|spoqa|kakao|d2coding)/;
const KOREAN_GUESS = 1.5;

/**
 * Word single line ÷ size of a font: [Latin text, lines with Hangul / CJK]. Fonts not in the table: HY and other
 * Korean fonts one line for all text (above), Latin fonts 1.2 with their Hangul in the East Asian fallback (맑은 고딕).
 */
export const fontLineRatios = (family: string | undefined): [number, number] => {
  const k = (family ?? "").trim().toLowerCase();
  const known = LINE_RATIO[k];
  if (known) return known;
  if (HY.test(k)) return [1.3, 1.3];
  if (KOREAN_NAME.test(k)) return [KOREAN_GUESS, KOREAN_GUESS];
  return [1.2, EA_FALLBACK];
};

/** Word single line height ÷ size for this font and text. */
export const fontLineRatio = (family: string | undefined, text = "") => fontLineRatios(family)[EAST_ASIAN.test(text) ? 1 : 0];

const textOf = (p: Pick<TextParagraph, "runs">) => p.runs.map((r) => r.text).join("");

/** Word single line ÷ size of a paragraph (its first run's font, its text). */
export const paraLineRatio = (p: Pick<TextParagraph, "runs">) => fontLineRatio(p.runs[0]?.fontFamily, textOf(p));

/**
 * The Word multiple a paragraph is drawn with, or undefined for a percent-of-size paragraph (no lineMultiple, an
 * exact / at-least height, or a lineSpacing an older app changed since).
 */
export function wordMultipleOf(p: Pick<TextParagraph, "lineSpacing" | "lineHeight" | "lineMultiple">): number | undefined {
  const m = p.lineMultiple;
  return m && !p.lineHeight && m.v > 0 && m.lineSpacing === p.lineSpacing ? m.v : undefined;
}

/** Size multiple of the same height as Word multiple `v` for this paragraph (what older readers draw), 0.01 steps. */
export const emOfWordMultiple = (p: Pick<TextParagraph, "runs">, v: number) => Math.round(v * paraLineRatio(p) * 100) / 100;

/** The paragraph with Word multiple `v` (lineSpacing = the same height as a size multiple; no exact height). */
export function withWordMultiple<T extends TextParagraph>(p: T, v: number): T {
  const lineSpacing = emOfWordMultiple(p, v);
  const out: T = { ...p, lineSpacing, lineMultiple: { v, lineSpacing } };
  delete out.lineHeight;
  return out;
}

/** The paragraph as a percent-of-size paragraph (lineMultiple dropped; lineSpacing kept). */
export function withoutWordMultiple<T extends TextParagraph>(p: T): T {
  if (!p.lineMultiple) return p;
  const { lineMultiple: _m, ...rest } = p;
  return rest as T;
}

/**
 * Line height of a Word-multiple line: the tallest run's single line × the multiple. Each run is Hangul or Latin by
 * its own `text` on the line when given (Word: a Latin font's Latin text has the font's line, its Hangul the East
 * Asian fallback's), else by the line's text.
 */
export function wordLineHeight(v: number, runs: readonly (Pick<TextRun, "fontFamily" | "fontSize"> & { latinFont?: string; text?: string })[], text: string): number {
  const ea = EAST_ASIAN.test(text) ? 1 : 0;
  let single = 0;
  for (const r of runs) {
    const k = r.text !== undefined ? (EAST_ASIAN.test(r.text) ? 1 : 0) : ea;
    // a run with its own Latin font (Word ascii + eastAsia): Latin text has the Latin font's line, Hangul the East Asian font's
    const ratio = r.latinFont && !k ? fontLineRatios(r.latinFont)[0] : fontLineRatios(r.fontFamily)[k];
    single = Math.max(single, r.fontSize * ratio);
  }
  return single * v;
}

/**
 * Where Word puts the baseline in a font's single line, ÷ size: [Latin text, lines with Hangul / CJK]. The font's win
 * ascent plus half of what the single line adds to win ascent + descent (Korean code page fonts: half of the 30 %;
 * Arial / Times: half the line gap). Font files (2026-11-15): 굴림·바탕·돋움·궁서 win 0.8584 + 0.1416, 맑은 고딕
 * 1.0884 + 0.2417, Calibri 0.9521 + 0.2686, Arial 0.9053 + 0.2119 (gap 0.0327), Times New Roman 0.8911 + 0.2163 (gap
 * 0.0425). Checked against Word 2021 PDFs (docs/design/FIDELITY_DOCX.md 7).
 */
const KOREAN_1EM_ASC = 0.8584 + 0.15;
const MALGUN_ASC = 1.0884 + 0.15 * (1.0884 + 0.2417);
const ASC_RATIO: Record<string, [number, number]> = {
  "맑은 고딕": [MALGUN_ASC, MALGUN_ASC], "malgun gothic": [MALGUN_ASC, MALGUN_ASC], // i18n: keep — font names matched in files
  calibri: [0.9521, MALGUN_ASC], cambria: [0.9502, MALGUN_ASC], arial: [0.9053 + 0.0327 / 2, MALGUN_ASC], "times new roman": [0.8911 + 0.0425 / 2, MALGUN_ASC],
  ...Object.fromEntries(KOREAN_1EM.map((f) => [f, [KOREAN_1EM_ASC, KOREAN_1EM_ASC] as [number, number]])),
};

/**
 * Baseline of a Word single line from its top (px): the largest of the runs' ascents (each run Latin or Hangul by its
 * own text, as wordLineHeight). Undefined when a run's font is not measured (the caller keeps its own estimate).
 */
export function wordAscent(runs: readonly (Pick<TextRun, "fontFamily" | "fontSize"> & { latinFont?: string; text?: string })[], text: string): number | undefined {
  const ea = EAST_ASIAN.test(text) ? 1 : 0;
  let asc = 0;
  for (const r of runs) {
    const k = r.text !== undefined ? (EAST_ASIAN.test(r.text) ? 1 : 0) : ea;
    const known = ASC_RATIO[(r.latinFont && !k ? r.latinFont : r.fontFamily ?? "").trim().toLowerCase()];
    if (!known) return undefined;
    asc = Math.max(asc, r.fontSize * known[k]);
  }
  return asc || undefined;
}

/** New documents (blank document, new text on a document page): Word's defaults — multiple 1.08, 8 pt after. */
export const WORD_DEFAULT_MULTIPLE = 1.08;
export const WORD_DEFAULT_AFTER = 8 * (96 / 72);

/** A paragraph with the Word defaults of a new document. */
export const withWordDefaults = <T extends TextParagraph>(p: T): T => ({ ...withWordMultiple(p, WORD_DEFAULT_MULTIPLE), spaceAfter: WORD_DEFAULT_AFTER });
