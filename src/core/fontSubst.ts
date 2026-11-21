// Substitutes for Korean document fonts that are often missing (한글 and Office documents): when a document asks for
// 함초롬바탕, 한양신명조, 휴먼명조 … and the face is not installed, the text should still be set in a font of the same
// kind — a 명조 (serif) face for 명조/바탕 fonts and a 고딕 face for 고딕/돋움/굴림 fonts — as 한글's own font
// substitution does, instead of falling straight to the app's sans-serif UI font (which made serif documents look
// like a different, broken file). Only system fonts are named (Windows: 바탕·돋움·굴림·궁서·맑은 고딕·HY …;
// macOS: AppleMyungjo / Apple SD Gothic Neo; Noto CJK where installed); no font file is bundled.
// docs/design/FIDELITY_HWP.md 3.

/** Families tried after the document's own font: [test on the lower-cased name, substitutes in order] */
const RULES: [RegExp, string[]][] = [
  // 한글's built-in HFT names (한양 …) and their usual HY TrueType equivalents
  [/^(한양)?신명조|^신명|hy신명조|^hymyeongjo|hysinmyeongjo/, ["HY신명조", "Batang", "바탕"]], // i18n: keep — font names
  [/^(한양)?견명조|hy견명조|^hygyeonmyeongjo/, ["HY견명조", "HY신명조", "Batang", "바탕"]], // i18n: keep — font names
  [/^(한양)?중고딕|^중고딕|hy중고딕|^hygothic-medium|^hyjunggothic/, ["HY중고딕", "Dotum", "돋움"]], // i18n: keep — font names
  [/^(한양)?(견고딕|태고딕)|hy견고딕|^hygothic-extra|^hygyeongothic/, ["HY견고딕", "HY중고딕", "Malgun Gothic", "맑은 고딕"]], // i18n: keep — font names
  [/^(한양)?그래픽|hy그래픽/, ["HY그래픽M", "HY그래픽", "Dotum", "돋움"]], // i18n: keep — font names
  [/^(한양)?궁서|hy궁서|^gungsuh/, ["HY궁서B", "Gungsuh", "궁서"]], // i18n: keep — font names
  [/헤드라인|^hyheadline/, ["HY헤드라인M", "HY견고딕", "Malgun Gothic", "맑은 고딕"]], // i18n: keep — font names
  // serif (명조 / 바탕) faces: 함초롬바탕, 휴먼명조, 바탕, 나눔명조, KoPub바탕, 신문명조 …
  // (Latin names only when they are Korean fonts: a Word document's "Century Gothic" or "Microsoft Sans Serif" is left alone)
  [/명조|바탕|궁체|휴먼옛체|^batang|^hcr ?batang|^nanum ?myeongjo|^kopub ?batang|^noto serif (kr|cjk)/, ["Batang", "바탕", "Noto Serif KR", "Noto Serif CJK KR", "AppleMyungjo", "Nanum Myeongjo", "나눔명조"]], // i18n: keep — font names
  // gothic (고딕 / 돋움 / 굴림) faces: 함초롬돋움, 휴먼고딕, 돋움, 굴림, 맑은 고딕, 나눔고딕 …
  [/고딕|돋움|굴림|^dotum|^gulim|^hcr ?dotum|^malgun|^nanum ?(barun ?)?gothic|^kopub ?dotum|^noto sans (kr|cjk)/, ["Malgun Gothic", "맑은 고딕", "Dotum", "돋움", "Noto Sans KR", "Apple SD Gothic Neo"]], // i18n: keep — font names
];

const cache = new Map<string, string>();

// ── metric lock: the widths 한글 lays 함초롬바탕 out with, whatever face draws it ──
// HCR Batang advance widths (1/1000 em) of U+0020–U+007E, from the font's hmtx (qa/interop/hancom-made/
// hcr-batang-metrics.json; bold differs in two letters by ≤ 18 units): every Hangul syllable is 970, so a substitute
// (바탕 1000, Noto Serif KR 966 …) set at its own widths puts a different number of words on a line than 한글.
const HCR_ASCII = "300,320,320,610,610,830,724,320,320,320,550,550,320,550,320,550,550,550,550,550,550,550,550,550,550,550,320,320,550,550,550,550,830,706,605,685,719,627,617,683,734,305,315,660,605,839,734,732,603,705,660,627,664,731,706,910,705,705,626,320,550,320,550,550,320,569,597,552,597,536,356,562,635,287,288,582,287,907,635,588,597,579,478,496,356,635,563,720,542,543,486,320,320,320,550"
  .split(",")
  .map(Number);
const HCR_PUNCT: Record<string, number> = { "·": 320, "…": 960, "‘": 320, "’": 320, "“": 480, "”": 480, "「": 500, "」": 500, "『": 500, "』": 500, "〈": 500, "〉": 500, "《": 500, "》": 500, "—": 875, "–": 625, "―": 875, "※": 770, "×": 617, "÷": 678 }; // i18n: keep

/**
 * Hangul syllable advance 한글 breaks lines with: a little more than the 0.970 em its PDFs draw the glyphs at. The lines
 * 한글 saved (lineseg) of the 함초롬바탕 test files — 608 fit / overflow conditions at 9–14 pt — hold only for
 * 0.9713–0.9728 em, and a line of omni-hwp-controls (no lineseg, its PDF) needs more than 0.9723: 996/1024 em
 * (0.970 left four saved lines and two PDF lines one syllable too long: docs/design/FIDELITY_HWP.md 12).
 */
const HCR_HANGUL = 996 / 1024;

function hcrBatangEm(ch: string): number | null {
  const c = ch.charCodeAt(0);
  if (ch.length === 1 && c >= 0x20 && c <= 0x7e) return HCR_ASCII[c - 0x20] / 1000;
  if (c >= 0xac00 && c <= 0xd7a3) return HCR_HANGUL;
  const p = HCR_PUNCT[ch];
  return p ? p / 1000 : null;
}

const lockCache = new Map<string, ((ch: string) => number | null) | null>();

/**
 * Width (em) per character of the document font a CSS font list starts with, when 한글's own widths of it are known
 * (함초롬바탕); null for other fonts. Characters it does not know (null) keep the drawing face's width.
 */
export function lockedWidths(font: string): ((ch: string) => number | null) | null {
  let v = lockCache.get(font);
  if (v !== undefined) return v;
  const fam = /"([^"]+)"/.exec(font)?.[1]?.toLowerCase() ?? "";
  v = fam === "함초롬바탕" || fam === "hcr batang" || fam === "hcrbatang" ? hcrBatangEm : null; // i18n: keep
  lockCache.set(font, v);
  return v;
}

/**
 * CSS family-list text (each quoted, ending in ", ") to try after `family` and before the app's fallback, or "" when
 * the name is not a Korean document font. The family itself is never repeated.
 */
export function fontSubstitutes(family: string): string {
  let v = cache.get(family);
  if (v !== undefined) return v;
  const k = family.trim().toLowerCase();
  const rule = RULES.find(([re]) => re.test(k));
  v = rule ? rule[1].filter((f) => f.toLowerCase() !== k).map((f) => `"${f}", `).join("") : "";
  cache.set(family, v);
  return v;
}
