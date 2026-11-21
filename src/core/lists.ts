// Multi-level lists (글머리표·문단 번호·개요 번호 / bullets, numbering, heading outline numbering).
//
// A list paragraph carries `list: { id, def, level }` (core/types.ts ParaList). `def` names the level formats: one
// of the presets below or a ListDef stored on the text node (imported numbering, levels edited in the dialog).
// `id` is the list instance: paragraphs with the same id count on together — across text nodes and pages too, so
// a numbered list that an imported document continues on the next page keeps its numbers.
//
// The marker ("1. ", "가. ", "1.1. ", "• ") is real text at the start of the paragraph, as for the older one-level
// lists (role li / oli): every renderer, PDF and the editor draw it without knowing about lists. Renumbering
// (core/richtext.ts renumber) rewrites it; `list.mk` remembers what it wrote so the next pass can replace it.
// Exporters cut the marker off and write real numbering (DOCX numbering.xml, HWPX hh:numbering / hh:bullet,
// PPTX a:buAutoNum / a:buChar).

import type { ListDef, ListLevel } from "./style/types";
import { uid } from "./types";

export type ListFormat =
  | "bullet"
  | "decimal"
  | "decimalZero"
  | "lowerLetter"
  | "upperLetter"
  | "lowerRoman"
  | "upperRoman"
  | "ganada"
  | "chosung"
  | "circled"
  | "none";

export const LIST_FORMATS: ListFormat[] = ["decimal", "decimalZero", "lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "ganada", "chosung", "circled", "bullet", "none"];

/** Word / 한글 allow 9 / 10 levels; the model keeps 9 (DOCX ilvl 0..8). */
export const MAX_LEVELS = 9;
/** Indent step per level and the hanging width where the marker sits, px (≈ 6.35 mm, Word's 360 twips × 4/3 ÷ 1.0). */
export const LEVEL_STEP = 24;
/** Separator after the marker. A space keeps the editor and every exporter simple; layoutText moves the text after a
 * marker to the hanging indent (like Word's tab suffix) when the marker is narrower. */
export const MARKER_SEP = " ";

const GANADA = "가나다라마바사아자차카타파하"; // i18n: keep — Korean numbering sequence
const CHOSUNG = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"; // i18n: keep — Korean numbering sequence

function roman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n);
  const t: [number, string][] = [[1000, "m"], [900, "cm"], [500, "d"], [400, "cd"], [100, "c"], [90, "xc"], [50, "l"], [40, "xl"], [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"]];
  let s = "";
  for (const [v, r] of t)
    while (n >= v) {
      s += r;
      n -= v;
    }
  return s;
}

/** Word's letter numbering: a … z, aa … zz, aaa … (the letter repeats, it is not base 26). */
function letters(n: number): string {
  if (n <= 0) return String(n);
  const k = (n - 1) % 26;
  return String.fromCharCode(97 + k).repeat(Math.floor((n - 1) / 26) + 1);
}

/** `n` in a number format. */
export function formatNumber(n: number, format: string): string {
  switch (format as ListFormat) {
    case "decimalZero":
      return n >= 0 && n < 10 ? "0" + n : String(n);
    case "lowerLetter":
      return letters(n);
    case "upperLetter":
      return letters(n).toUpperCase();
    case "lowerRoman":
      return roman(n);
    case "upperRoman":
      return roman(n).toUpperCase();
    case "ganada":
      return n >= 1 ? GANADA[(n - 1) % GANADA.length] : String(n);
    case "chosung":
      return n >= 1 ? CHOSUNG[(n - 1) % CHOSUNG.length] : String(n);
    case "circled":
      // ① … ⑳, then ㉑ … ㉟, ㊱ … ㊿, then plain
      if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
      if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
      if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
      return String(n);
    case "none":
    case "bullet":
      return "";
    default:
      return String(n);
  }
}

/** HWPX hh:paraHead numFormat → list format. Formats without a model come in as the nearest one (their own glyphs: hwpxFormatNumber). */
export const HWPX_NUMFMT_IN: Record<string, ListFormat> = {
  DIGIT: "decimal", CIRCLED_DIGIT: "circled", ROMAN_CAPITAL: "upperRoman", ROMAN_SMALL: "lowerRoman", LATIN_CAPITAL: "upperLetter", LATIN_SMALL: "lowerLetter",
  CIRCLED_LATIN_CAPITAL: "upperLetter", CIRCLED_LATIN_SMALL: "lowerLetter", HANGUL_SYLLABLE: "ganada", CIRCLED_HANGUL_SYLLABLE: "ganada", HANGUL_JAMO: "chosung",
  CIRCLED_HANGUL_JAMO: "chosung", HANGUL_PHONETIC: "decimal", IDEOGRAPH: "decimal", CIRCLED_IDEOGRAPH: "circled",
};

const IDEOGRAPHS = "一二三四五六七八九十"; // i18n: keep — 한글 IDEOGRAPH numbering
const PHONETIC = ["일", "이", "삼", "사", "오", "육", "칠", "팔", "구", "십"]; // i18n: keep — 한글 HANGUL_PHONETIC numbering

/** `n` in an HWPX numFormat as 한글 draws it (formats beyond a glyph range: the nearest list format). */
export function hwpxFormatNumber(n: number, fmt: string): string {
  const cp = (base: number, count: number) => (n >= 1 && n <= count ? String.fromCodePoint(base + n - 1) : null);
  const own =
    fmt === "CIRCLED_HANGUL_SYLLABLE" ? cp(0x326e, 14) // ㉮ … ㉻
    : fmt === "CIRCLED_HANGUL_JAMO" ? cp(0x3260, 14) // ㉠ … ㉭
    : fmt === "CIRCLED_LATIN_CAPITAL" ? cp(0x24b6, 26) // Ⓐ … Ⓩ
    : fmt === "CIRCLED_LATIN_SMALL" ? cp(0x24d0, 26) // ⓐ … ⓩ
    : fmt === "CIRCLED_IDEOGRAPH" ? cp(0x3280, 10) // ㊀ … ㊉
    : fmt === "IDEOGRAPH" && n >= 1 && n <= 10 ? IDEOGRAPHS[n - 1]
    : fmt === "HANGUL_PHONETIC" && n >= 1 && n <= 10 ? PHONETIC[n - 1]
    : null;
  return own ?? formatNumber(n, HWPX_NUMFMT_IN[fmt] ?? "decimal");
}

/** A level read from HWPX and not changed since (format, marker text and start as read): its file element still holds. */
export const hwpxLevelKept = (lv: ListLevel): boolean => !!lv.hwpx && lv.format === lv.hwpx.format && lv.text === lv.hwpx.text && (lv.start ?? 1) === (lv.hwpx.start ?? 1);

/** `n` as the level shows it: in the HWPX format it was read with while its format is unchanged, else in its format. */
export function levelNumber(lv: ListLevel, n: number): string {
  if (lv.format === "bullet") return formatNumber(n, "decimal");
  return lv.hwpx && lv.format === lv.hwpx.format && lv.hwpx.fmt !== "BULLET" ? hwpxFormatNumber(n, lv.hwpx.fmt) : formatNumber(n, lv.format);
}

const lvl = (format: ListFormat, text: string, level: number, step = LEVEL_STEP, hang = LEVEL_STEP): ListLevel => ({
  format,
  text,
  indent: { start: { v: step * (level + 1), u: "px" }, first: { v: -hang, u: "px" } },
});
const nine = (f: (level: number) => ListLevel) => Array.from({ length: MAX_LEVELS }, (_, i) => f(i));
const outlineLvl = (format: ListFormat, text: string): ListLevel => ({ format, text, indent: { start: { v: 0, u: "px" }, first: { v: 0, u: "px" } } });
const chain = (k: number) => Array.from({ length: k + 1 }, (_, i) => `%${i + 1}`).join(".") + ".";

/** Built-in list definitions; their id is the preset name. */
export const LIST_PRESETS: Record<string, ListDef> = {
  bullet: { id: "bullet", preset: "bullet", levels: nine((i) => lvl("bullet", ["•", "◦", "▪"][i % 3], i)) },
  decimal: { id: "decimal", preset: "decimal", levels: nine((i) => lvl((["decimal", "lowerLetter", "lowerRoman"] as const)[i % 3], `%${i + 1}.`, i)) },
  legal: { id: "legal", preset: "legal", levels: nine((i) => lvl("decimal", chain(i), i, LEVEL_STEP, 24 + 10 * i)) },
  korean: {
    id: "korean",
    preset: "korean",
    levels: nine((i) =>
      lvl(
        (["decimal", "ganada", "decimal", "ganada", "decimal", "ganada", "circled", "circled", "circled"] as const)[i],
        ["%1.", "%2.", "%3)", "%4)", "(%5)", "(%6)", "%7", "%8", "%9"][i],
        i,
        LEVEL_STEP,
        i >= 4 && i <= 5 ? 32 : 24,
      ),
    ),
  },
  circled: { id: "circled", preset: "circled", levels: nine((i) => lvl("circled", `%${i + 1}`, i)) },
  upperAlpha: { id: "upperAlpha", preset: "upperAlpha", levels: nine((i) => lvl((["upperLetter", "lowerLetter", "decimal"] as const)[i % 3], `%${i + 1}.`, i)) },
  roman: { id: "roman", preset: "roman", levels: nine((i) => lvl((["upperRoman", "upperLetter", "decimal"] as const)[i % 3], `%${i + 1}.`, i, LEVEL_STEP, i % 3 === 0 ? 32 : 24)) },
  /** heading outline numbering 1. / 1.1. / 1.1.1. (제목 번호) */
  outline: { id: "outline", preset: "outline", outline: true, levels: nine((i) => outlineLvl("decimal", chain(i))) },
  /** 한글 개요 번호 1. / 가. / 1) / 가) / (1) / (가) / ① */
  outlineKo: {
    id: "outlineKo",
    preset: "outlineKo",
    outline: true,
    levels: nine((i) =>
      outlineLvl((["decimal", "ganada", "decimal", "ganada", "decimal", "ganada", "circled", "circled", "circled"] as const)[i], ["%1.", "%2.", "%3)", "%4)", "(%5)", "(%6)", "%7", "%8", "%9"][i]),
    ),
  },
};

export const BULLET_PRESETS = ["bullet"];
export const NUMBER_PRESETS = ["decimal", "legal", "korean", "circled", "upperAlpha", "roman"];
export const OUTLINE_PRESETS = ["outline", "outlineKo"];

/** The definition `def` names: a node's own list first, then a preset (decimal when unknown). */
export function resolveDef(def: string, defs?: readonly ListDef[]): ListDef {
  return defs?.find((d) => d.id === def) ?? LIST_PRESETS[def] ?? LIST_PRESETS.decimal;
}

/** Level `level` of a definition (the last one for deeper levels). */
export function levelOf(def: ListDef, level: number): ListLevel {
  const lv = def.levels[Math.max(0, Math.min(def.levels.length - 1, level))];
  return lv ?? { format: "decimal", text: "%1." };
}

export const isBulletLevel = (lv: ListLevel) => lv.format === "bullet";

/**
 * Marker of an item at `level` with the counters of its list (counters[k] = current number of level k; levels
 * above without a number count as their start).
 */
export function markerText(def: ListDef, level: number, counters: readonly (number | undefined)[]): string {
  const lv = levelOf(def, level);
  if (isBulletLevel(lv)) return lv.text;
  return lv.text.replace(/%([1-9])/g, (_m, d: string) => {
    const k = Number(d) - 1;
    const kl = levelOf(def, k);
    const n = counters[k] ?? kl.start ?? 1;
    return levelNumber(kl, n);
  });
}

/** Left / first-line indent of a level in px (Len units px; other units are converted elsewhere when needed). */
export function levelIndent(lv: ListLevel): { left: number; first: number } {
  const px = (l?: { v: number; u: string }) => (!l ? 0 : l.u === "px" ? l.v : l.u === "pt" ? (l.v * 4) / 3 : l.u === "twip" ? l.v / 15 : l.u === "hwpunit" ? l.v / 75 : l.v);
  return { left: px(lv.indent?.start), first: px(lv.indent?.first) };
}

/** Counters of every list instance, carried from one text node to the next (document order). */
export type ListSeed = Map<string, (number | undefined)[]>;

/** Context for renumbering: the node's own definitions and the counters reached before it. */
export interface ListCtx {
  defs?: readonly ListDef[];
  seed?: ListSeed;
}

/** A fresh list instance id. */
export const newListId = () => uid("l");

/** Placeholders %1..%9 (Word) ↔ ^1..^9 (HWPX paraHead text). */
export const toHwpxLevelText = (text: string) => text.replace(/%([1-9])/g, "^$1");
export const fromHwpxLevelText = (text: string) => text.replace(/\^([1-9])/g, "%$1");

/**
 * Counters of multi-level list paragraphs (the rules of core/richtext.ts renumber): per paragraph, its number at its
 * own level (undefined for paragraphs outside a list), and the counters reached.
 */
export function listNumbers(paras: readonly { list?: { id: string; def: string; level: number; start?: number } }[], lc: ListCtx = {}): { numbers: (number | undefined)[]; seed: ListSeed } {
  const seed: ListSeed = new Map([...(lc.seed ?? new Map())].map(([k, v]) => [k, [...v]]));
  const numbers = paras.map((p) => {
    if (!p.list) return undefined;
    const def = resolveDef(p.list.def, lc.defs);
    const level = Math.max(0, Math.min(MAX_LEVELS - 1, p.list.level | 0));
    const cs = seed.get(p.list.id) ?? [];
    cs[level] = p.list.start != null ? p.list.start : cs[level] == null ? levelOf(def, level).start ?? 1 : cs[level]! + 1;
    for (let k = level + 1; k < MAX_LEVELS; k++) cs[k] = undefined;
    seed.set(p.list.id, cs);
    return cs[level];
  });
  return { numbers, seed };
}
