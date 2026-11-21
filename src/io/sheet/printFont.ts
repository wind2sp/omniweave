// Excel's printed geometry from the default font's metrics (표 계산 인쇄 글꼴): the printer digit width that sizes a
// printed column, the printed default row, the line box that places text in a printed cell, and the digit width a
// 96-dpi screen gives a column. Excel takes them from GDI's text metrics of the font at the device's size, so they
// follow from the font's tables:
//   ppem       the em in device pixels: the size in points × dpi / 72, rounded (GDI's MulDiv; 11 pt at 600 dpi = 92)
//   digit      the widest digit's advance (hmtx) × ppem / unitsPerEm, rounded — Excel's maximum digit width
//   ascent     OS/2 usWinAscent × ppem / upm (tmAscent), descent usWinDescent (tmDescent), rounded
//   leading    hhea's line height beyond the win height (tmExternalLeading)
//   row        ascent + descent + leading + 8 dots (a printed default row: Calibri / Arial / Cambria / Consolas /
//              Tahoma / Georgia / Times New Roman at 8–20 pt), plus what Excel adds for some fonts (x, measured:
//              맑은 고딕 / Segoe UI 5–12 dots, the GDI hinting of Verdana and Times New Roman ±1–3)
//   text       a line box of ascent + leading above the baseline and descent + x below it, set 3.5 dots under the
//              row's gridline (top), centred in the row, or 7 dots above the next gridline (bottom)
// Measured with Excel 16 on 13 fonts × 8 sizes (qa/interop/scripts/xlsx_print_fonts_make.ps1, the numbers in
// qa/interop/excel-made/omni-xlsx-print-fonts.truth.json). The metrics below are numbers read from the fonts' tables
// (no font data is shipped); `screen` is GDI's hinted digit width at 6–48 ppem (base 36), the column unit of a
// 96-dpi screen (Calibri 11 = 7 px, Arial 10 = 7 px, 맑은 고딕 11 = 8 px).

interface FontFace {
  /** family names as files write them, lower case (English and local) */
  names: string[];
  upm: number;
  /** OS/2 usWinAscent / usWinDescent, hhea line height beyond them (≥ 0), widest digit advance — font units */
  asc: number;
  desc: number;
  gap: number;
  digit: number;
  /** GDI's digit width in px at 6, 7 … 48 ppem, one base-36 character each */
  screen: string;
  /** dots Excel's printed default row has beyond ascent + descent + leading + 8 at 8 9 10 11 12 14 16 20 pt */
  x?: number[];
}

const FONTS: FontFace[] = [
  { names: ["calibri"], upm: 2048, asc: 1950, desc: 550, gap: 0, digit: 1038, screen: "3445566777899aabbccddeeffgghhiijjkkllmmnnoo" },
  { names: ["calibri light"], upm: 2048, asc: 1950, desc: 550, gap: 0, digit: 1038, screen: "3445566778899aabbccddeeffgghhiijjkkllmmnnoo" },
  { names: ["arial"], upm: 2048, asc: 1854, desc: 434, gap: 67, digit: 1139, screen: "344566778899abbccddeefgghhiijjkllmmnnoopqqr", x: [0, -1, -1, 1, 0, 0, 1, 1] },
  { names: ["verdana"], upm: 2048, asc: 2059, desc: 430, gap: 0, digit: 1302, screen: "445777889aabbcddeffghhiijkklmmnooppqrrsttuv", x: [-1, 1, 0, 3, -1, -1, -1, -1] },
  { names: ["tahoma"], upm: 2048, asc: 2049, desc: 423, gap: 0, digit: 1118, screen: "344556778899aabbcddeeffgghhijjkkllmmnnoppqq" },
  { names: ["times new roman"], upm: 2048, asc: 1825, desc: 443, gap: 87, digit: 1024, screen: "34455666778999abbbccdeeefgghhiijjkkllmmnnoo", x: [2, 2, 2, 2, 3, 3, 3, 3] },
  { names: ["segoe ui"], upm: 2048, asc: 2210, desc: 514, gap: 0, digit: 1104, screen: "344556678899aabbccddeffgghhiijjkklmmnnooppq", x: [5, 6, 5, 8, 7, 8, 7, 11] },
  { names: ["cambria"], upm: 2048, asc: 1946, desc: 455, gap: 0, digit: 1134, screen: "344566778899abbccddeefgghhiijjkklmmnnooppqr" },
  { names: ["consolas"], upm: 2048, asc: 1884, desc: 514, gap: 0, digit: 1126, screen: "344556778899aabccddeeffgghiijjkkllmnnooppqq" },
  { names: ["georgia"], upm: 2048, asc: 1878, desc: 449, gap: 0, digit: 1257, screen: "4456688999aabccdeeffghhiijkkllmnnoppqqrsstt", x: [1, 1, 2, 1, 0, 0, 1, 0] },
  { names: ["trebuchet ms"], upm: 2048, asc: 1923, desc: 455, gap: 0, digit: 1074, screen: "3445566778899aabccddeeffgghhiijjkklmmnnoopp" },
  { names: ["candara"], upm: 2048, asc: 1950, desc: 550, gap: 0, digit: 1130, screen: "344566778899aabccddeeffghhiijjkklmmnnooppqq" },
  { names: ["corbel"], upm: 2048, asc: 1950, desc: 550, gap: 0, digit: 1074, screen: "3445566778899aabccddeeffgghhiijjkklmmnnoopp" },
  { names: ["constantia"], upm: 2048, asc: 1950, desc: 550, gap: 0, digit: 1119, screen: "344556778899aabbcddeeffgghhijjkkllmmnooppqq" },
  { names: ["century"], upm: 2048, asc: 2019, desc: 442, gap: 1, digit: 1139, screen: "344566778899abbccddeefgghhiijjkllmmnnoopqqr" },
  { names: ["bookman old style"], upm: 2048, asc: 1831, desc: 473, gap: 100, digit: 1270, screen: "4456677899abbccdeefgghhijjkklmmnooppqrrsttu" },
  { names: ["맑은 고딕", "malgun gothic"], upm: 2048, asc: 2229, desc: 495, gap: 0, digit: 1128, screen: "344566778899aabccddeeffghhiijjkkllmnnooppqq", x: [5, 6, 6, 9, 8, 9, 7, 12] }, // i18n: keep — font names
  { names: ["굴림", "gulim"], upm: 1024, asc: 879, desc: 145, gap: 152, digit: 588, screen: "345566678899aabbbbddfgghhiijkkllmmnooppqqrs", x: [-1, 0, 0, -1, -1, 1, 2, 5] }, // i18n: keep — font names
  { names: ["돋움", "dotum"], upm: 1024, asc: 879, desc: 145, gap: 152, digit: 597, screen: "445566669988aabbccddfgghhijjkklmmnnoopqqrrs", x: [-1, 0, 0, -1, -1, 1, 2, 5] }, // i18n: keep — font names
  { names: ["바탕", "batang"], upm: 1024, asc: 879, desc: 145, gap: 152, digit: 610, screen: "445566678899baaaaaccfghhiijkkllmnnoopqqrrst", x: [-1, 0, 0, -1, -1, 1, 2, 5] }, // i18n: keep — font names
  // (궁서: not measured — the metrics of its family 굴림 / 돋움 / 바탕, which print alike)
  { names: ["궁서", "gungsuh"], upm: 1024, asc: 879, desc: 145, gap: 152, digit: 597, screen: "445566667799aabbccddfgghhijjkklmmnnoopqqrrs", x: [-1, 0, 0, -1, -1, 1, 2, 5] }, // i18n: keep — font names
  { names: ["游ゴシック", "yu gothic"], upm: 2048, asc: 2017, desc: 619, gap: 645, digit: 1139, screen: "344566778899abbccddeefgghhiijjkllmmnnoopqqr" }, // i18n: keep — font names
  { names: ["ｍｓ ｐゴシック", "ms pgothic"], upm: 256, asc: 220, desc: 36, gap: 0, digit: 128, screen: "3445566778899aabbccddeeffgghhiijjkkllmmnnoo" }, // i18n: keep — font names
  { names: ["ｍｓ ゴシック", "ms gothic"], upm: 256, asc: 220, desc: 36, gap: 0, digit: 128, screen: "3445566778899aabbccddeeffgghhiijjkkllmmnnoo" }, // i18n: keep — font names
  { names: ["微软雅黑", "microsoft yahei"], upm: 2048, asc: 2167, desc: 536, gap: 0, digit: 1201, screen: "44556678899abbccddeffgghiijjkllmmnnoppqqrss" }, // i18n: keep — font names
  { names: ["宋体", "simsun"], upm: 256, asc: 220, desc: 36, gap: 36, digit: 128, screen: "3445566778899aabbccddeeffgghhiijjkkllmmnnoo" }, // i18n: keep — font names
];
const BY_NAME = new Map(FONTS.flatMap((f) => f.names.map((n) => [n, f] as const)));
/** The font's metrics, or null for a font not in the table. */
export function fontFace(name: string | undefined): FontFace | null {
  return BY_NAME.get((name ?? "").trim().toLowerCase()) ?? null;
}

/** ppem of a size in points at a resolution (GDI's MulDiv rounding). */
export const ppemAt = (pt: number, dpi: number) => Math.max(1, Math.round((pt * dpi) / 72));

/** Excel's maximum digit width on a 96-dpi screen (px), or null for a font not in the table. */
export function screenDigitPx(name: string, pt: number): number | null {
  const f = fontFace(name);
  if (!f) return null;
  const p = ppemAt(pt, 96);
  if (p >= 6 && p - 6 < f.screen.length) return parseInt(f.screen[p - 6], 36);
  return Math.max(1, Math.round((f.digit * p) / f.upm));
}

/** Excel's extra row dots at a ppem: measured at 8–20 pt (600 dpi), in between linear, beyond in proportion. */
const X_PPEM = [67, 75, 83, 92, 100, 117, 133, 167];
function extra(f: FontFace, ppem: number): number {
  const x = f.x;
  if (!x) return 0;
  if (ppem <= X_PPEM[0]) return Math.round((x[0] * ppem) / X_PPEM[0]);
  const n = X_PPEM.length - 1;
  if (ppem >= X_PPEM[n]) return Math.round((x[n] * ppem) / X_PPEM[n]);
  let i = 0;
  while (X_PPEM[i + 1] < ppem) i++;
  const t = (ppem - X_PPEM[i]) / (X_PPEM[i + 1] - X_PPEM[i]);
  return Math.round(x[i] + (x[i + 1] - x[i]) * t);
}

/** GDI's text metrics of a font at a ppem (device pixels): ascent, descent, external leading, maximum digit width,
 * and Excel's extra row height. */
export function fontMetrics(f: FontFace, ppem: number): { ascent: number; descent: number; leading: number; digit: number; extra: number } {
  const k = ppem / f.upm;
  return { ascent: Math.round(f.asc * k), descent: Math.round(f.desc * k), leading: Math.round(f.gap * k), digit: Math.round(f.digit * k), extra: extra(f, ppem) };
}

/** Printed (600 dpi) default row of a font in dots, and its line box: ascent + leading above the baseline, `box` in
 * all. Null for a font not in the table. */
export function printRowOf(name: string, pt: number): { row: number; box: number; above: number } | null {
  const f = fontFace(name);
  if (!f) return null;
  const m = fontMetrics(f, ppemAt(pt, 600));
  const box = m.ascent + m.descent + m.leading + m.extra;
  return { row: box + 8, box, above: m.ascent + m.leading };
}

/** The line box of printed text at a print scale (dots): `above` the baseline, `box` in all — the 100 % box scaled,
 * as Excel scales the 100 % layout (rows too); a font not in the table as 맑은 고딕 (the model's font before these
 * metrics). */
export function printLineBox(name: string, pt: number, scale = 1): { above: number; box: number } {
  const r = printRowOf(fontFace(name) ? name : "malgun gothic", pt)!;
  return { above: r.above * scale, box: r.box * scale };
}

/** Printer digit width in dots (600 dpi), or null for a font not in the table. */
export function printDigitDots(name: string, pt: number): number | null {
  const f = fontFace(name);
  return f ? fontMetrics(f, ppemAt(pt, 600)).digit : null;
}

/** The font's default row on a 96-dpi screen (px): ascent + descent + leading + 2 at the screen's ppem. */
export function screenRowPx(name: string, pt: number): number | null {
  const f = fontFace(name);
  if (!f) return null;
  const m = fontMetrics(f, ppemAt(pt, 96));
  return m.ascent + m.descent + m.leading + 2;
}
