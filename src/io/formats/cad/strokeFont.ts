// "Omni Stroke" (오메 단선) — Omniweave's own single-stroke font for drawings, standing in for AutoCAD's SHX fonts
// (txt, simplex, romans, isocp, whgtxt, gbcbig …, which may not be redistributed). Every glyph here was drawn for
// Omniweave as centre-line strokes on a grid (cap height 10, x-height 7, descender −3); no other font's outlines were
// copied. Hangul is composed from stroke jamo (initial · medial · final placed by vowel shape), so the data stays a few
// kilobytes. docs/design/CAD_IMPORT.md §5.4.
//
// The strokes become a TrueType font at run time (`strokeFontTtf`: each stroke widened to an outline) that is
// registered as a FontFace — text stays editable TEXT, the font file is never shipped or stored in a document.
// Widths (`strokeAdvance`) are exact, so FIT / ALIGNED text and the drawing bounds use them directly.

import { pairGlyph, type ShxPair } from "./shx";

/** grid units → font units (cap height 10 → 720 / 1000 em: the cap ratio cad/build.ts assumes) */
const U = 72;
export const STROKE_FAMILY = "Omni Stroke";
/** the txt.shx stand-in: the same strokes on txt's near-fixed advances */
export const STROKE_MONO = "Omni Stroke Mono";
/**
 * Text in an SHX style whose .shx files were found on this computer (cad/shx.ts, read from the drawing's folder or the
 * AutoCAD Fonts folder — never shipped): "Omni Stroke SHX romans" / "… txt+whgtxt". Its glyphs are the SHX shapes; a
 * character the files lack, or the whole font where they are not found (another computer), is Omni Stroke's.
 */
export const STROKE_SHX = "Omni Stroke SHX ";
export type StrokeVariant = "prop" | "mono" | `shx:${string}`;
export const strokeVariantOf = (family: string | undefined): StrokeVariant | null =>
  family === STROKE_MONO ? "mono" : family === STROKE_FAMILY ? "prop" : family?.startsWith(STROKE_SHX) && family.length > STROKE_SHX.length ? `shx:${family.slice(STROKE_SHX.length).toLowerCase()}` : null;
/** the family of a stroke variant */
export const strokeFamilyOf = (v: StrokeVariant): string => (v === "mono" ? STROKE_MONO : v === "prop" ? STROKE_FAMILY : STROKE_SHX + v.slice(4));

const shxPairs = new Map<string, ShxPair>();
/** Make an SHX pair ("main" or "main+big", lower case) available to the stroke font. */
export function registerShxPair(key: string, pair: ShxPair) {
  shxPairs.set(key.toLowerCase(), pair);
}
export const hasShxPair = (key: string) => shxPairs.has(key.toLowerCase());
export type ShxPairRef = ShxPair | undefined;
export const shxPairOf = (v: StrokeVariant): ShxPairRef => (v.startsWith("shx:") ? shxPairs.get(v.slice(4)) : undefined);
/** Omni Stroke variant standing in for an SHX variant (txt / monotxt: the fixed-pitch one) */
export const baseVariant = (v: StrokeVariant): "prop" | "mono" => (v === "mono" || (v.startsWith("shx:") && /^(txt|monotxt)\b/.test(v.slice(4))) ? "mono" : "prop");
/** grid units (cap height 10) of an SHX glyph */
function shxGridGlyph(pair: ShxPair, ch: string): Glyph | undefined {
  // a CJK character in a style without a big font: AutoCAD draws the main font's "?" in its place (omni-cad-03 OMNI-TXT)
  const g = pairGlyph(pair, ch) ?? (!pair.big && pair.main && (ch.codePointAt(0) ?? 0) >= 0x2e80 ? pairGlyph(pair, "?") : null);
  if (!g) return undefined;
  // (TrueType coordinates are 16-bit: a shape reaching past 40 cap heights — a damaged file — keeps only what fits)
  const fits = (s: Pt[]) => s.every(([x, y]) => Math.abs(x) <= 40 && Math.abs(y) <= 40);
  return { adv: Math.max(-400, Math.min(400, g.adv * 10)), strokes: g.strokes.filter(fits).map((s) => s.map(([x, y]): Pt => [x * 10, y * 10])) };
}
/** stroke width in font units (≈ 0.08 of the cap height, a plotted 0.2–0.25 mm line on 2.5–3 mm text) */
const PEN = 56;
const OBLIQUE = Math.tan((15 * Math.PI) / 180);

type Pt = [number, number];
type Stroke = Pt[];

// ───────── Latin, digits, symbols ─────────
// "advance|path": M x y (move), L x y (line), A cx cy rx ry a0 a1 (elliptical arc in degrees, a1 < a0 = clockwise,
// joined to the current stroke), Z (close). Grid units, x from the glyph's left edge (1 unit of side bearing is added).
const S = "A4 7.5 3.8 2.5 30 270A4 2.5 4 2.5 90 -150";
const GLYPHS: Record<string, string> = {
  " ": "7|",
  "!": "3|M0 10L0 3M0 0.6L0 0",
  '"': "4|M0 10L0 7.5M2 10L2 7.5",
  "#": "10|M3 0L3.5 10M6 0L6.5 10M1 3.3L8 3.3M1.3 6.7L8.3 6.7",
  $: `10|${S}M4 11L4 -1`,
  "%": "11|M0 0L9 10M1.8 6A1.8 8 1.8 2 270 630M7.2 0A7.2 2 1.8 2 270 630",
  "&": "10|M8 0L1.6 6.4A3 8 1.6 2 220 -40L1.2 2.2A3.4 2.4 2.4 2.4 175 320L8 4.5",
  "'": "2|M0 10L0 7.5",
  "(": "4|A4 5 4 6 120 240",
  ")": "4|A-2 5 4 6 60 -60",
  "*": "7|M2.5 9L2.5 3M0 7.5L5 4.5M0 4.5L5 7.5",
  "+": "10|M0 5L8 5M4 1L4 9",
  ",": "2|M0.5 0.6L0.5 0L-0.3 -2",
  "-": "9|M0 4.5L7 4.5",
  ".": "2|M0 0.6L0 0",
  "/": "7|M0 -1L6 11",
  "0": "9|A3.5 5 3.5 5 0 360",
  "1": "9|M1.5 8L3.5 10L3.5 0",
  "2": "9|M0.4 7.7A3.5 6.5 3.3 3.5 160 -30L0 0L7 0",
  "3": "9|M0.3 8.5A3.5 7.5 3.2 2.5 160 -90L2.5 5M3.5 5A3.5 2.5 3.5 2.5 90 -160",
  "4": "9|M5 0L5 10L0 3L7.5 3",
  "5": "9|M6.5 10L1 10L0.6 5.6A3.5 3.3 3.5 3.3 140 -150",
  "6": "9|M6.2 8.6A3.5 6.5 3.5 3.5 40 180L0 3.3A3.5 3.3 3.5 3.3 180 540",
  "7": "9|M0 10L7 10L2.5 0",
  "8": "9|A3.5 7.6 3 2.4 270 630A3.5 2.6 3.5 2.6 90 450",
  "9": "9|M0.8 1.4A3.5 3.5 3.5 3.5 220 360L7 6.7A3.5 6.7 3.5 3.3 0 360",
  ":": "2|M0 7L0 6.4M0 0.6L0 0",
  ";": "2|M0 7L0 6.4M0.5 0.6L0.5 0L-0.3 -2",
  "<": "10|M8 9L0 5L8 1",
  "=": "10|M0 3.3L8 3.3M0 6.7L8 6.7",
  ">": "10|M0 9L8 5L0 1",
  "?": "9|M0 7.5A3.5 7.5 3.5 2.5 180 -90L3.5 2.5M3.5 0.6L3.5 0",
  "@": "12|M7 3L7 7M7 5A5 5 2 2 0 360M7 3A5 5 5 5 -40 320",
  A: "11|M0 0L4.5 10L9 0M1.7 3.5L7.3 3.5",
  B: "10|M0 0L0 10L5 10A5 7.5 2.5 2.5 90 -90L0 5M5 5A5.5 2.5 2.5 2.5 90 -90L0 0",
  C: "11|A4.5 5 4.5 5 40 320",
  D: "10|M0 0L0 10L4 10A4 5 4 5 90 -90Z",
  E: "9|M7 10L0 10L0 0L7 0M0 5L5 5",
  F: "9|M7 10L0 10L0 0M0 5L5 5",
  G: "11|A4.5 5 4.5 5 45 360L5.5 5",
  H: "10|M0 0L0 10M8 0L8 10M0 5L8 5",
  I: "2|M0 0L0 10",
  J: "8|M6 10L6 3A3 3 3 3 0 -180",
  K: "10|M0 0L0 10M8 10L0 3M2.5 5.5L8 0",
  L: "8|M0 10L0 0L7 0",
  M: "12|M0 0L0 10L5 0L10 10L10 0",
  N: "10|M0 0L0 10L8 0L8 10",
  O: "11|A4.5 5 4.5 5 0 360",
  P: "9.5|M0 0L0 10L5 10A5 7.5 2.5 2.5 90 -90L0 5",
  Q: "11|A4.5 5 4.5 5 0 360M5.5 2.5L9 -0.5",
  R: "10|M0 0L0 10L5 10A5 7.5 2.5 2.5 90 -90L0 5M4 5L8 0",
  S: `10|${S}`,
  T: "10|M0 10L8 10M4 10L4 0",
  U: "10|M0 10L0 3.5A4 3.5 4 3.5 180 360L8 10",
  V: "11|M0 10L4.5 0L9 10",
  W: "14|M0 10L3 0L6 10L9 0L12 10",
  X: "10|M0 10L8 0M0 0L8 10",
  Y: "10|M0 10L4 5L8 10M4 5L4 0",
  Z: "10|M0 10L8 10L0 0L8 0",
  "[": "5|M3 11L0 11L0 -1L3 -1",
  "\\": "7|M0 11L6 -1",
  "]": "5|M0 11L3 11L3 -1L0 -1",
  "^": "8|M0 6L3 10L6 6",
  _: "9|M0 -2L9 -2",
  "`": "3|M0 10L1.5 8",
  a: "9|M7 7L7 0M7 3.5A3.5 3.5 3.5 3.5 0 360",
  b: "9|M0 10L0 0M0 3.5A3.5 3.5 3.5 3.5 180 -180",
  c: "8.5|A3.5 3.5 3.5 3.5 40 320",
  d: "9|M7 10L7 0M7 3.5A3.5 3.5 3.5 3.5 0 360",
  e: "9|M0 3.5L7 3.5A3.5 3.5 3.5 3.5 0 320",
  f: "6|M5 10A3.5 8 1.5 2 60 180L2 0M0 7L4.5 7",
  g: "9|M7 3.5A3.5 3.5 3.5 3.5 0 360M7 7L7 -1A3.5 -1 3.5 2 0 -150",
  h: "8|M0 10L0 0M0 4A3 4 3 3 180 0L6 0",
  i: "2|M0 0L0 7M0 9.4L0 10",
  j: "3|M1 7L1 -1.5A-0.5 -1.5 1.5 1.5 0 -120M1 9.4L1 10",
  k: "8|M0 0L0 10M6 7L0 2M2 3.8L6.5 0",
  l: "2|M0 0L0 10",
  m: "12|M0 0L0 7M0 4.5A2.5 4.5 2.5 2.5 180 0L5 0M5 4.5A7.5 4.5 2.5 2.5 180 0L10 0",
  n: "8|M0 0L0 7M0 4A3 4 3 3 180 0L6 0",
  o: "9|A3.5 3.5 3.5 3.5 0 360",
  p: "9|M0 7L0 -3M0 3.5A3.5 3.5 3.5 3.5 180 -180",
  q: "9|M7 7L7 -3M7 3.5A3.5 3.5 3.5 3.5 0 360",
  r: "5.5|M0 0L0 7M0 4A3.5 4 3.5 3 180 70",
  s: "8|A3 5.25 2.8 1.75 20 270A3 1.75 3 1.75 90 -160",
  t: "6|M2 10L2 1.5A3.5 1.5 1.5 1.5 180 300M0 7L4.5 7",
  u: "8|M0 7L0 3A3 3 3 3 180 360L6 7M6 7L6 0",
  v: "9|M0 7L3.5 0L7 7",
  w: "12|M0 7L2.5 0L5 7L7.5 0L10 7",
  x: "8.5|M0 7L6.5 0M0 0L6.5 7",
  y: "9|M0 7L3.5 0M7 7L2.5 -3",
  z: "8.5|M0 7L6.5 7L0 0L6.5 0",
  "{": "5|M3.5 11A3.5 9 1.5 2 90 180L2 6.5L0 5L2 3.5L2 1A3.5 1 1.5 2 180 270",
  "|": "2|M0 11L0 -1",
  "}": "5|M0 11A0 9 1.5 2 90 0L1.5 6.5L3.5 5L1.5 3.5L1.5 1A0 1 1.5 2 0 -90",
  "~": "9|M0 4A1.8 4 1.8 1.2 180 0A5.4 4 1.8 1.2 180 360",
  "°": "4|A1.3 8.7 1.3 1.3 0 360",
  "±": "10|M0 6L8 6M4 2L4 10M0 0L8 0",
  "⌀": "10|A4 5 4 4 0 360M0 0.5L8 9.5",
  Ø: "11|A4.5 5 4.5 5 0 360M0 -0.5L9 10.5",
  ø: "9|A3.5 3.5 3.5 3.5 0 360M0 -0.5L7 7.5",
  "×": "9|M0 1L7 8M0 8L7 1",
  "÷": "10|M0 5L8 5M4 8L4 7.4M4 2.6L4 2",
  "·": "3|M0 5L0 4.4",
  µ: "8|M0 7L0 -3M0 3A3 3 3 3 180 360L6 7M6 7L6 0",
  "²": "6|M0.2 8.6A2 9 1.8 1.4 160 -30L0 5.5L4 5.5",
  "³": "6|M0.2 9.4A2 9.2 1.8 1 160 -90L1.4 8.2M2 8.2A2 6.7 2 1.5 90 -160",
  "–": "9|M0 4.5L8 4.5",
  "—": "13|M0 4.5L12 4.5",
  "‘": "2|M0.5 8L0.5 8.6L1 10",
  "’": "2|M0.5 10L0.5 9.4L0 8",
  "“": "4|M0.5 8L0.5 8.6L1 10M2.5 8L2.5 8.6L3 10",
  "”": "4|M0.5 10L0.5 9.4L0 8M2.5 10L2.5 9.4L2 8",
  "…": "10|M0 0.6L0 0M4 0.6L4 0M8 0.6L8 0",
  "Ω": "11|M0 0L3 0L3 1A4.5 5.5 4.5 4.5 240 -60L6 0L9 0",
  "△": "11|M0 0L4.5 10L9 0Z",
  "□": "10|M0 0L0 10L8 10L8 0Z",
};

function parse(path: string, dx: number): Stroke[] {
  const out: Stroke[] = [];
  let cur: Stroke | null = null;
  const tok = path.match(/[MLAZ]|-?\d*\.?\d+/g) ?? [];
  let i = 0;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    const c = tok[i++];
    if (c === "M") {
      cur = [[num() + dx, num()]];
      out.push(cur);
    } else if (c === "L") (cur ??= (out.push([]), out[out.length - 1])).push([num() + dx, num()]);
    else if (c === "Z") {
      if (cur?.length) cur.push([...cur[0]] as Pt);
    } else if (c === "A") {
      const cx = num() + dx, cy = num(), rx = num(), ry = num(), a0 = num(), a1 = num();
      if (!cur) out.push((cur = []));
      const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 15));
      for (let k = 0; k <= n; k++) {
        const a = ((a0 + ((a1 - a0) * k) / n) * Math.PI) / 180;
        cur.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
      }
    }
  }
  return out.filter((s) => s.length);
}

interface Glyph {
  /** advance, grid units */
  adv: number;
  strokes: Stroke[];
}

// Advances (grid units: cap height = 10). The SHX fonts' widths were measured on AutoCAD's own output for
// omni-cad-03 (qa/interop/autocad-made): the right / centre / aligned / fit TEXT the DXF stores with both alignment
// points gives each string's exact width, the plot gives the rest. "prop" follows romans / simplex (proportional;
// listed here in 1/21 of the cap height, the unit those widths come out whole in), "mono" follows txt (one cell of
// 10 for letters and digits, half a cell for the narrow marks). The drawn strokes are fitted into each advance.
const PROP_W: Record<string, number> = {
  " ": 16, "!": 10, '"': 16, "#": 21, $: 20, "%": 24, "&": 26, "'": 10, "(": 14, ")": 14, "*": 16, "+": 26, ",": 10, "-": 26, ".": 10, "/": 22,
  ":": 10, ";": 10, "<": 24, "=": 26, ">": 24, "?": 18, "@": 27, "[": 14, "\\": 14, "]": 14, "^": 16, _: 16, "\x60": 10, "{": 14, "|": 8, "}": 14, "~": 24,
  A: 18, B: 21, C: 21, D: 21, E: 19, F: 18, G: 21, H: 22, I: 8, J: 16, K: 21, L: 17, M: 24, N: 22, O: 22, P: 21, Q: 22, R: 21, S: 20, T: 16, U: 22, V: 18, W: 24, X: 20, Y: 18, Z: 20,
  a: 19, b: 19, c: 18, d: 19, e: 18, f: 12, g: 19, h: 19, i: 8, j: 10, k: 17, l: 8, m: 30, n: 19, o: 19, p: 19, q: 19, r: 13, s: 17, t: 12, u: 19, v: 16, w: 22, x: 17, y: 16, z: 17,
};
for (const d of "0123456789") PROP_W[d] = 20;
const MONO_NARROW = "il1,.;:!'|`";

const latin: Record<StrokeVariant, Map<string, Glyph>> = { prop: new Map(), mono: new Map() };
function latinGlyph(ch: string, v: StrokeVariant = "prop"): Glyph | undefined {
  let g = latin[v].get(ch);
  if (!g && GLYPHS[ch] !== undefined) {
    const [w, path] = GLYPHS[ch].split("|");
    const w0 = +w;
    const ascii = ch.charCodeAt(0) < 127;
    const adv = !ascii ? w0 + 2 : v === "mono" ? (ch === " " ? 8 : MONO_NARROW.includes(ch) ? 5 : 10) : PROP_W[ch] !== undefined ? (PROP_W[ch] * 10) / 21 : w0 + 2;
    const bear = v === "mono" ? 1.67 : 1.43;
    const sx = w0 > 0.5 && ascii ? Math.min(1.5, Math.max(0.55, (adv - 2 * bear) / w0)) : 1;
    const off = (adv - w0 * sx) / 2;
    g = { adv, strokes: parse(path, 0).map((s) => s.map(([x, y]): Pt => [off + x * sx, y])) };
    latin[v].set(ch, g);
  }
  return g;
}

// ───────── Hangul: stroke jamo composed into syllables ─────────
// Consonants are drawn in a unit box (0..1, y up) and placed into the part of the syllable box (0..10) their position
// takes; vowels are drawn straight into the syllable box for each layout.

const CONS: Record<string, string> = {
  ㄱ: "M0 1L1 1L1 0", // i18n: keep — glyph data
  ㄴ: "M0 1L0 0L1 0", // i18n: keep — glyph data
  ㄷ: "M1 1L0 1L0 0L1 0", // i18n: keep — glyph data
  ㄹ: "M0 1L1 1L1 0.5L0 0.5L0 0L1 0", // i18n: keep — glyph data
  ㅁ: "M0 1L1 1L1 0L0 0Z", // i18n: keep — glyph data
  ㅂ: "M0 1L0 0L1 0L1 1M0 0.5L1 0.5", // i18n: keep — glyph data
  ㅅ: "M0.5 1L0 0M0.5 0.65L1 0", // i18n: keep — glyph data
  ㅇ: "A0.5 0.5 0.5 0.5 0 360", // i18n: keep — glyph data
  ㅈ: "M0 1L1 1M0.5 1L0 0M0.5 0.6L1 0", // i18n: keep — glyph data
  ㅊ: "M0.5 1.08L0.5 0.86M0 0.86L1 0.86M0.5 0.86L0 0M0.5 0.5L1 0", // i18n: keep — glyph data
  ㅋ: "M0 1L1 1L1 0M0 0.5L1 0.5", // i18n: keep — glyph data
  ㅌ: "M1 1L0 1L0 0L1 0M0 0.5L1 0.5", // i18n: keep — glyph data
  ㅍ: "M0 1L1 1M0 0L1 0M0.3 1L0.3 0M0.7 1L0.7 0", // i18n: keep — glyph data
  ㅎ: "M0.5 1.08L0.5 0.88M0.05 0.88L0.95 0.88M0.5 0.6A0.5 0.3 0.3 0.3 90 450", // i18n: keep — glyph data
};
/** doubled and compound consonants: drawn as two side by side */
const PAIRS: Record<string, string> = { ㄲ: "ㄱㄱ", ㄸ: "ㄷㄷ", ㅃ: "ㅂㅂ", ㅆ: "ㅅㅅ", ㅉ: "ㅈㅈ", ㄳ: "ㄱㅅ", ㄵ: "ㄴㅈ", ㄶ: "ㄴㅎ", ㄺ: "ㄹㄱ", ㄻ: "ㄹㅁ", ㄼ: "ㄹㅂ", ㄽ: "ㄹㅅ", ㄾ: "ㄹㅌ", ㄿ: "ㄹㅍ", ㅀ: "ㄹㅎ", ㅄ: "ㅂㅅ" }; // i18n: keep — glyph data
const INITIAL = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ"; // i18n: keep — glyph data
const MEDIAL = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ"; // i18n: keep — glyph data
const FINAL = " ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ"; // i18n: keep — glyph data

const unitCons = new Map<string, Stroke[]>();
/** a consonant in the box x0..x1, y0..y1 */
function consonant(c: string, x0: number, y0: number, x1: number, y1: number): Stroke[] {
  const pair = PAIRS[c];
  if (pair) {
    const g = (x1 - x0) * 0.1, m = (x0 + x1) / 2;
    return [...consonant(pair[0], x0, y0, m - g / 2, y1), ...consonant(pair[1], m + g / 2, y0, x1, y1)];
  }
  let u = unitCons.get(c);
  if (!u) unitCons.set(c, (u = parse(CONS[c] ?? "", 0)));
  return u.map((s) => s.map(([x, y]): Pt => [x0 + x * (x1 - x0), y0 + y * (y1 - y0)]));
}

const VERT = "ㅏㅐㅑㅒㅓㅔㅕㅖㅣ"; // i18n: keep — glyph data
const HORIZ = "ㅗㅛㅜㅠㅡ"; // i18n: keep — glyph data
/** horizontal part and vertical part of a mixed vowel */
const MIXED: Record<string, [string, string]> = { ㅘ: ["ㅗ", "ㅏ"], ㅙ: ["ㅗ", "ㅐ"], ㅚ: ["ㅗ", "ㅣ"], ㅝ: ["ㅜ", "ㅓ"], ㅞ: ["ㅜ", "ㅔ"], ㅟ: ["ㅜ", "ㅣ"], ㅢ: ["ㅡ", "ㅣ"] }; // i18n: keep — glyph data

/** a vertical vowel with its stem(s) from y0 to y1, at the right of the box from x = xs */
function vertVowel(v: string, xs: number, y0: number, y1: number): Stroke[] {
  const ym = (y0 + y1) / 2, d = (y1 - y0) * 0.1;
  const L = (a: Pt, b: Pt): Stroke => [a, b];
  const st = (x: number) => L([x, y0], [x, y1]);
  switch (v) {
    case "ㅏ": // i18n: keep — glyph data
      return [st(xs + 0.8), L([xs + 0.8, ym], [xs + 2.6, ym])];
    case "ㅑ": // i18n: keep — glyph data
      return [st(xs + 0.8), L([xs + 0.8, ym + d], [xs + 2.6, ym + d]), L([xs + 0.8, ym - d], [xs + 2.6, ym - d])];
    case "ㅐ": // i18n: keep — glyph data
      return [st(xs + 0.6), st(xs + 2.6), L([xs + 0.6, ym], [xs + 2.6, ym])];
    case "ㅒ": // i18n: keep — glyph data
      return [st(xs + 0.6), st(xs + 2.6), L([xs + 0.6, ym + d], [xs + 2.6, ym + d]), L([xs + 0.6, ym - d], [xs + 2.6, ym - d])];
    case "ㅓ": // i18n: keep — glyph data
      return [st(xs + 2.4), L([xs + 0.4, ym], [xs + 2.4, ym])];
    case "ㅕ": // i18n: keep — glyph data
      return [st(xs + 2.4), L([xs + 0.4, ym + d], [xs + 2.4, ym + d]), L([xs + 0.4, ym - d], [xs + 2.4, ym - d])];
    case "ㅔ": // i18n: keep — glyph data
      return [st(xs + 1.4), st(xs + 2.8), L([xs, ym], [xs + 1.4, ym])];
    case "ㅖ": // i18n: keep — glyph data
      return [st(xs + 1.4), st(xs + 2.8), L([xs, ym + d], [xs + 1.4, ym + d]), L([xs, ym - d], [xs + 1.4, ym - d])];
    default:
      return [st(xs + 1.6)];
  }
}

/** a horizontal vowel: bar at y from x0 to x1, stubs up or down */
function horizVowel(v: string, x0: number, x1: number, y: number, stub: number): Stroke[] {
  const out: Stroke[] = [
    [
      [x0, y],
      [x1, y],
    ],
  ];
  const up = v === "ㅗ" || v === "ㅛ"; // i18n: keep — glyph data
  const xs = v === "ㅛ" || v === "ㅠ" ? [x0 + (x1 - x0) * 0.33, x0 + (x1 - x0) * 0.67] : v === "ㅡ" ? [] : [(x0 + x1) / 2]; // i18n: keep — glyph data
  for (const x of xs)
    out.push([
      [x, y],
      [x, up ? y + stub : y - stub],
    ]);
  return out;
}

function syllable(code: number): Glyph {
  const s = code - 0xac00;
  const ini = INITIAL[Math.floor(s / 588)], med = MEDIAL[Math.floor((s % 588) / 28)], fin = FINAL[s % 28];
  const hasFin = fin !== " ";
  const strokes: Stroke[] = [];
  if (VERT.includes(med)) {
    strokes.push(...consonant(ini, 0.6, hasFin ? 5.4 : 1.6, 6.2, hasFin ? 9.8 : 9.4));
    strokes.push(...vertVowel(med, 6.6, hasFin ? 4.2 : 0, 10));
    if (hasFin) strokes.push(...consonant(fin, 1.6, 0, 8.4, 3.2));
  } else if (HORIZ.includes(med)) {
    const down = med === "ㅜ" || med === "ㅠ"; // i18n: keep — glyph data
    const y = hasFin ? (down ? 6.4 : 4.6) : down ? 5.6 : 2.8;
    const stub = hasFin ? 1.1 : down ? 2.2 : 1.6;
    strokes.push(...consonant(ini, 1.6, down ? y + 0.8 : y + stub + 0.6, 8.4, 9.8));
    strokes.push(...horizVowel(med, 0.4, 9.6, y, stub));
    if (hasFin) strokes.push(...consonant(fin, 1.6, 0, 8.4, down ? y - stub - 0.7 : 3.4));
  } else {
    const [h, v] = MIXED[med];
    const down = h === "ㅜ"; // i18n: keep — glyph data
    const y = hasFin ? 5.6 : down ? 4.8 : 3.2;
    const stub = hasFin ? 0.9 : 1.4;
    strokes.push(...consonant(ini, 0.6, down ? y + 0.8 : y + stub + 0.6, 5.8, 9.8));
    strokes.push(...horizVowel(h, 0.4, 7, y, stub));
    strokes.push(...vertVowel(v, 6.6, hasFin ? 4.2 : 0, 10));
    if (hasFin) strokes.push(...consonant(fin, 1.6, 0, 8.4, y - (down ? stub : 0) - 1));
  }
  return { adv: HANGUL_ADV, strokes: strokes.map((st) => st.map(([x, y]): Pt => [x + HANGUL_PAD, y])) };
}

/** advance of a Hangul syllable, grid units (whgtxt on the AutoCAD plot: 1.25 × the cap height, ink ≈ 1.0) */
const HANGUL_ADV = 12.5;
const HANGUL_PAD = (HANGUL_ADV - 10) / 2;

function jamoGlyph(ch: string): Glyph | undefined {
  const c = ch.codePointAt(0)!;
  if (c < 0x3131 || c > 0x3163) return undefined;
  const strokes = c >= 0x314f ? (VERT.includes(ch) ? vertVowel(ch, 3, 0, 10) : HORIZ.includes(ch) ? horizVowel(ch, 1, 9, 4, 2.5) : MIXED[ch] ? [...horizVowel(MIXED[ch][0], 0.4, 7, 4, 2), ...vertVowel(MIXED[ch][1], 6.6, 0, 10)] : []) : consonant(ch, 1.5, 0.5, 8.5, 9.5);
  return { adv: HANGUL_ADV, strokes: strokes.map((st) => st.map(([x, y]): Pt => [x + HANGUL_PAD, y])) };
}

/** Glyph of one character, or undefined when the font has none (another font draws it). */
function glyphOf(ch: string, v: StrokeVariant = "prop"): Glyph | undefined {
  const pair = shxPairOf(v);
  if (pair) {
    const g = shxGridGlyph(pair, ch);
    if (g) return g;
  }
  v = baseVariant(v);
  const c = ch.codePointAt(0)!;
  if (c >= 0xac00 && c <= 0xd7a3) return syllable(c);
  return latinGlyph(ch, v) ?? jamoGlyph(ch);
}

/**
 * Width of a string in em at cap height 0.72 em (the font's own advances; characters it lacks count as a Hangul cell
 * when wide, half of it otherwise — the fallback font's rough width).
 */
export function strokeAdvance(text: string, sv: StrokeVariant = "prop"): number {
  let w = 0;
  const pair = shxPairOf(sv);
  const v = baseVariant(sv);
  for (const ch of text) {
    const s = pair && shxGridGlyph(pair, ch === "\t" ? " " : ch);
    if (s) {
      w += (ch === "\t" ? 4 : 1) * s.adv;
      continue;
    }
    const g = ch === "\t" ? latinGlyph(" ", v) : latinGlyph(ch, v) ?? (/[ᄀ-ᇿ㄰-㆏가-힣⺀-鿿＀-￯]/.test(ch) ? { adv: HANGUL_ADV } : { adv: 9 }); // i18n: keep — glyph data
    w += (ch === "\t" ? 4 : 1) * g!.adv;
  }
  return (w * U) / 1000;
}

/**
 * Centre-line strokes of a character in em (cap height 0.72 em, y up) and its advance, or undefined — PDF export draws
 * SHX text as these lines (AutoCAD plots SHX text as vectors; the user's SHX shapes are never embedded as a font).
 */
export function strokeGlyphEm(ch: string, v: StrokeVariant = "prop"): { adv: number; strokes: [number, number][][] } | undefined {
  const g = glyphOf(ch, v);
  const k = U / 1000;
  return g && { adv: Math.round(g.adv * U) / 1000, strokes: g.strokes.map((s) => s.map(([x, y]): [number, number] => [x * k, y * k])) };
}
/** pen width of the strokes, em */
export const STROKE_PEN_EM = PEN / 1000;

/** The font draws this character itself. */
export const strokeHas = (ch: string, v: StrokeVariant = "prop") => !!glyphOf(ch, v);

// ───────── strokes → outlines → TrueType ─────────

/** a widened stroke: one contour per smooth run (split at corners sharper than 40°), plus round-ish joints and ends */
function outline(st: Stroke, skew: number): Pt[][] {
  const pts = st.map(([x, y]): Pt => [x * U + y * U * skew, y * U]);
  const hw = PEN / 2;
  const out: Pt[][] = [];
  const dot = (p: Pt) => {
    const ring: Pt[] = [];
    for (let k = 0; k < 8; k++) {
      const a = (-k * Math.PI) / 4 - Math.PI / 8;
      ring.push([p[0] + hw * 1.08 * Math.cos(a), p[1] + hw * 1.08 * Math.sin(a)]);
    }
    out.push(ring);
  };
  // drop repeated points
  const p: Pt[] = [];
  for (const q of pts) if (!p.length || Math.hypot(q[0] - p[p.length - 1][0], q[1] - p[p.length - 1][1]) > 0.5) p.push(q);
  if (p.length < 2) {
    dot(pts[0]);
    return out;
  }
  const dir = (a: Pt, b: Pt): Pt => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  let start = 0;
  const strip = (i0: number, i1: number) => {
    const left: Pt[] = [], right: Pt[] = [];
    for (let i = i0; i <= i1; i++) {
      const d0 = i > i0 ? dir(p[i - 1], p[i]) : dir(p[i], p[i + 1]);
      const d1 = i < i1 ? dir(p[i], p[i + 1]) : d0;
      let nx = -(d0[1] + d1[1]), ny = d0[0] + d1[0];
      const l = Math.hypot(nx, ny) || 1;
      nx /= l;
      ny /= l;
      const cos = nx * -d1[1] + ny * d1[0];
      const k = hw / Math.max(0.5, cos);
      left.push([p[i][0] + nx * k, p[i][1] + ny * k]);
      right.push([p[i][0] - nx * k, p[i][1] - ny * k]);
    }
    const ring = [...left, ...right.reverse()];
    let area = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
    }
    out.push(area > 0 ? ring.reverse() : ring);
  };
  for (let i = 1; i < p.length; i++) {
    const last = i === p.length - 1;
    let sharp = false;
    if (!last) {
      const a = dir(p[i - 1], p[i]), b = dir(p[i], p[i + 1]);
      sharp = a[0] * b[0] + a[1] * b[1] < Math.cos((40 * Math.PI) / 180);
    }
    if (sharp || last) {
      strip(start, i);
      start = i;
    }
  }
  // joints and ends: corners where runs meet, and both ends unless the stroke is closed
  const closed = Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) < 1;
  for (let i = 0; i < p.length; i++) {
    const end = i === 0 || i === p.length - 1;
    if (end && closed && p.length > 2) {
      if (i === 0) dot(p[0]);
      continue;
    }
    if (end) dot(p[i]);
    else {
      const a = dir(p[i - 1], p[i]), b = dir(p[i], p[i + 1]);
      if (a[0] * b[0] + a[1] * b[1] < Math.cos((40 * Math.PI) / 180)) dot(p[i]);
    }
  }
  return out;
}

class Bin {
  b: number[] = [];
  u8(v: number) {
    this.b.push(v & 255);
  }
  u16(v: number) {
    this.b.push((v >> 8) & 255, v & 255);
  }
  i16(v: number) {
    this.u16(v < 0 ? v + 65536 : v);
  }
  u32(v: number) {
    this.u16(Math.floor(v / 65536) & 65535);
    this.u16(v & 65535);
  }
  tag(s: string) {
    for (const c of s) this.u8(c.charCodeAt(0));
  }
  pad() {
    while (this.b.length % 4) this.u8(0);
  }
}

/**
 * The font for the given characters (always ASCII and the symbols; Hangul syllables as listed) as TrueType bytes.
 * `italic` slants it 15° (AutoCAD's usual obliquing angle). `outlines` false: advances only, every glyph blank (the text
 * layer of SHX text in a PDF, drawn as lines over it).
 */
export function strokeFontTtf(chars: Iterable<string>, italic = false, variant: StrokeVariant = "prop", outlines = true): Uint8Array {
  const family = strokeFamilyOf(variant);
  const pair = shxPairOf(variant);
  const set = new Set<number>();
  // an SHX font: printable ASCII and the other characters the text uses (built per style when a drawing opens: kept
  // small — a drawing with a dozen SHX styles builds two dozen faces)
  if (pair) for (let c = 0x20; c < 0x7f; c++) set.add(c);
  else {
    for (const k of Object.keys(GLYPHS)) set.add(k.codePointAt(0)!);
    for (let c = 0x3131; c <= 0x3163; c++) set.add(c);
  }
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7a3) || (pair && c > 0x20 && c <= 0xffff && shxGridGlyph(pair, ch))) set.add(c);
  }
  const codes = [...set].filter((c) => c <= 0xffff && glyphOf(String.fromCodePoint(c), variant)).sort((a, b) => a - b);
  const skew = italic ? OBLIQUE : 0;
  interface G {
    adv: number;
    contours: Pt[][];
  }
  const glyphs: G[] = [{ adv: 500, contours: [] }];
  for (const c of codes) {
    const g = glyphOf(String.fromCodePoint(c), variant)!;
    glyphs.push({ adv: Math.round(g.adv * U), contours: !outlines ? [] : g.strokes.flatMap((s) => outline(s, skew)).map((r) => r.map(([x, y]): Pt => [Math.round(x), Math.round(y)])) });
  }
  // glyf + loca
  const glyf = new Bin();
  const loca: number[] = [];
  let maxPts = 0, maxCont = 0;
  let fx0 = 0, fy0 = 0, fx1 = 0, fy1 = 0;
  const lsb: number[] = [];
  for (const g of glyphs) {
    loca.push(glyf.b.length);
    let cs = g.contours.filter((r) => r.length >= 3);
    // (a glyph past TrueType's 16-bit point count — only a damaged SHX shape — is left blank)
    if (cs.reduce((a, r) => a + r.length, 0) > 60_000 || cs.length > 30_000) cs = [];
    if (!cs.length) {
      lsb.push(0);
      continue;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of cs)
      for (const [x, y] of r) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
    fx0 = Math.min(fx0, x0);
    fy0 = Math.min(fy0, y0);
    fx1 = Math.max(fx1, x1);
    fy1 = Math.max(fy1, y1);
    lsb.push(x0);
    glyf.i16(cs.length);
    glyf.i16(x0);
    glyf.i16(y0);
    glyf.i16(x1);
    glyf.i16(y1);
    let n = 0;
    for (const r of cs) glyf.u16((n += r.length) - 1);
    maxPts = Math.max(maxPts, n);
    maxCont = Math.max(maxCont, cs.length);
    glyf.u16(0); // no instructions
    for (let i = 0; i < n; i++) glyf.u8(1); // on-curve, 16-bit deltas
    let px = 0, py = 0;
    for (const r of cs) for (const [x] of r) glyf.i16(x - px), (px = x);
    for (const r of cs) for (const [, y] of r) glyf.i16(y - py), (py = y);
    glyf.pad();
  }
  loca.push(glyf.b.length);
  const n = glyphs.length;
  const t: Record<string, Bin> = {};
  const head = (t.head = new Bin());
  head.u32(0x10000);
  head.u32(0x10000);
  head.u32(0); // checksum adjustment (filled below)
  head.u32(0x5f0f3cf5);
  head.u16(0x000b);
  head.u16(1000);
  for (let i = 0; i < 4; i++) head.u32(0); // created, modified
  head.i16(fx0);
  head.i16(fy0);
  head.i16(fx1);
  head.i16(fy1);
  head.u16(italic ? 2 : 0);
  head.u16(8);
  head.i16(2);
  head.i16(1); // long loca
  head.i16(0);
  const maxAdv = Math.max(...glyphs.map((g) => g.adv));
  const hhea = (t.hhea = new Bin());
  hhea.u32(0x10000);
  hhea.i16(900);
  hhea.i16(-300);
  hhea.i16(0);
  hhea.u16(maxAdv);
  hhea.i16(fx0);
  hhea.i16(0);
  hhea.i16(fx1);
  hhea.i16(italic ? 1000 : 1);
  hhea.i16(italic ? Math.round(1000 * OBLIQUE) : 0);
  hhea.i16(0);
  for (let i = 0; i < 4; i++) hhea.i16(0);
  hhea.i16(0);
  hhea.u16(n);
  const maxp = (t.maxp = new Bin());
  maxp.u32(0x10000);
  maxp.u16(n);
  maxp.u16(maxPts);
  maxp.u16(maxCont);
  maxp.u16(0);
  maxp.u16(0);
  maxp.u16(2);
  for (let i = 0; i < 7; i++) maxp.u16(0);
  maxp.u16(0); // maxComponentDepth
  const os2 = (t["OS/2"] = new Bin());
  os2.u16(4);
  os2.i16(Math.round(glyphs.reduce((a, g) => a + g.adv, 0) / n));
  os2.u16(400);
  os2.u16(5);
  os2.u16(0);
  for (const v of [650, 600, 0, 75, 650, 600, 0, 350, 50, 250]) os2.i16(v); // sub/superscript, strikeout
  os2.i16(0); // family class
  for (let i = 0; i < 10; i++) os2.u8(0); // panose
  os2.u32(3); // Basic Latin, Latin-1
  os2.u32(0x01000000 | 0x10000000); // Hangul
  os2.u32(0);
  os2.u32(0);
  os2.tag("OMNI");
  os2.u16(italic ? 0x01 : 0x40);
  os2.u16(codes[0]);
  os2.u16(codes[codes.length - 1]);
  os2.i16(900);
  os2.i16(-300);
  os2.i16(0);
  os2.u16(Math.max(900, fy1));
  os2.u16(Math.max(300, -fy0));
  os2.u32(1 | (1 << 19)); // Latin 1, Korean Wansung
  os2.u32(0);
  os2.i16(504);
  os2.i16(720);
  os2.u16(0);
  os2.u16(32);
  os2.u16(1);
  const hmtx = (t.hmtx = new Bin());
  glyphs.forEach((g, i) => (hmtx.u16(g.adv), hmtx.i16(lsb[i])));
  // cmap format 4: one segment per run of consecutive code points (glyph ids follow the code points)
  const segs: [number, number, number][] = [];
  codes.forEach((c, i) => {
    const s = segs[segs.length - 1];
    if (s && s[1] === c - 1 && s[2] + (c - s[0]) === i + 1) s[1] = c;
    else segs.push([c, c, i + 1]);
  });
  segs.push([0xffff, 0xffff, 0]);
  const sub = new Bin();
  const segX2 = segs.length * 2;
  const pow = 2 ** Math.floor(Math.log2(segs.length));
  sub.u16(4);
  sub.u16(16 + segs.length * 8);
  sub.u16(0);
  sub.u16(segX2);
  sub.u16(pow * 2);
  sub.u16(Math.log2(pow));
  sub.u16(segX2 - pow * 2);
  for (const s of segs) sub.u16(s[1]);
  sub.u16(0);
  for (const s of segs) sub.u16(s[0]);
  for (const s of segs) sub.u16(s[0] === 0xffff ? 1 : (s[2] - s[0] + 65536) & 65535);
  for (let i = 0; i < segs.length; i++) sub.u16(0);
  const cmap = (t.cmap = new Bin());
  cmap.u16(0);
  cmap.u16(1);
  cmap.u16(3);
  cmap.u16(1);
  cmap.u32(12);
  cmap.b.push(...sub.b);
  const lo = (t.loca = new Bin());
  for (const v of loca) lo.u32(v);
  t.glyf = glyf;
  const name = (t.name = new Bin());
  const sub2 = italic ? "Italic" : "Regular";
  const recs: [number, string][] = [
    [1, family],
    [2, sub2],
    [4, `${family} ${sub2}`],
    [6, `${family.replace(/ /g, "")}-${sub2}`],
  ];
  name.u16(0);
  name.u16(recs.length);
  name.u16(6 + recs.length * 12);
  let off = 0;
  const strs: number[] = [];
  for (const [id, s] of recs) {
    name.u16(3);
    name.u16(1);
    name.u16(0x409);
    name.u16(id);
    name.u16(s.length * 2);
    name.u16(off);
    for (const ch of s) strs.push(0, ch.charCodeAt(0));
    off += s.length * 2;
  }
  name.b.push(...strs);
  const post = (t.post = new Bin());
  post.u32(0x30000);
  post.u32(italic ? (-15 * 65536) >>> 0 : 0);
  post.i16(-150);
  post.i16(50);
  for (let i = 0; i < 5; i++) post.u32(0);
  // assemble (tables in tag order, 4-byte aligned, checksums)
  const tags = Object.keys(t).sort();
  const outB = new Bin();
  const nt = tags.length;
  const p2 = 2 ** Math.floor(Math.log2(nt));
  outB.u32(0x10000);
  outB.u16(nt);
  outB.u16(p2 * 16);
  outB.u16(Math.log2(p2));
  outB.u16(nt * 16 - p2 * 16);
  let at = 12 + nt * 16;
  const sum = (b: number[]) => {
    let s = 0;
    for (let i = 0; i < b.length; i += 4) s = (s + ((b[i] << 24) | ((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))) >>> 0;
    return s;
  };
  const bodies: number[][] = [];
  for (const tg of tags) {
    const b = t[tg].b;
    outB.tag(tg.padEnd(4, " "));
    outB.u32(sum(b));
    outB.u32(at);
    outB.u32(b.length);
    const padded = [...b];
    while (padded.length % 4) padded.push(0);
    bodies.push(padded);
    at += padded.length;
  }
  for (const b of bodies) for (const v of b) outB.b.push(v);
  const bytes = new Uint8Array(outB.b);
  const headAt = 12 + nt * 16 + bodies.slice(0, tags.indexOf("head")).reduce((a, b) => a + b.length, 0);
  const adj = (0xb1b0afba - sum(outB.b)) >>> 0;
  bytes[headAt + 8] = adj >>> 24;
  bytes[headAt + 9] = (adj >>> 16) & 255;
  bytes[headAt + 10] = (adj >>> 8) & 255;
  bytes[headAt + 11] = adj & 255;
  return bytes;
}
