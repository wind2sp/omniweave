// Hangul (한글) layout rules the importer does not carry into the TextParagraph model yet, emulated for the
// comparator only. Each rule is a separate switch so the comparator can tell which one explains a mismatch:
//   ratio      장평: a character's advance × charPr ratio (% per language) — the importer carries the Hangul value
//   spacing    자간: charPr spacing per language, % of the character's advance after 장평 (measured, LAYOUT_TRUTH 9)
//              — the importer carries the Hangul value to all characters
//   breakWord  paraPr breakNonLatinWord = KEEP_WORD (한글 단위 '글자'; BREAK_WORD is '어절'): Hangul / CJK may break between any two syllables
//              (Latin words stay whole: breakLatinWord KEEP_WORD)
//   kinsoku    금칙 (KLREQ): no line may start with closing punctuation, end with opening punctuation
//   tab        the tab width Hangul saved (hp:tab width) instead of a measured space
//   indent     paraPr margins as Hangul uses them: stored values are twice the HWPUNIT length, and a
//              negative first-line indent (내어쓰기) indents every line after the first

import { graphemes, measure, tokenize } from "../text";
import type { TextParagraph, TextRun } from "../types";
import type { HwpxCharShape, HwpxParaShape } from "./hwpxLineseg";
import type { TokenizeFn, WidthFn } from "./simulate";

export type HwpxLang = "hangul" | "latin" | "hanja" | "japanese" | "other" | "symbol" | "user";

/** HWPX language slot of a character (decides which charPr font / ratio / spacing applies). */
export function hwpxLang(g: string): HwpxLang {
  const c = g.codePointAt(0) ?? 0;
  if ((c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) return "hangul";
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) return "hanja";
  if (c >= 0x3040 && c <= 0x30ff) return "japanese";
  if (c < 0x250) return "latin";
  if ((c >= 0x2000 && c <= 0x2bff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3200 && c <= 0x33ff)) return "symbol";
  return "other";
}

/** KLREQ / Hangul 금칙: characters that may not start a line. */
const NO_START = new Set([..."!%),.:;?]}¢°’”‰′″℃、。〉》」』】〕〗〙〛・ー゛゜！％），．：；？］｝｡｣､･ｰﾞﾟ…‥·"]); // i18n: keep — punctuation table
/** characters that may not end a line. */
const NO_END = new Set([..."$([{£¥‘“〈《「『【〔〖〘〚＄（［｛｢￡￥"]); // i18n: keep — punctuation table

const breakable = (g: string) => {
  const l = hwpxLang(g);
  return l === "hangul" || l === "hanja" || l === "japanese";
};

/**
 * Tokens for a paragraph shape: keep-all tokens, further split between syllables when the paragraph allows
 * BREAK_WORD for non-Latin text, never splitting where kinsoku forbids it.
 */
export function hancomTokenizer(shape: HwpxParaShape | undefined, opts: { breakWord: boolean; kinsoku: boolean }): TokenizeFn {
  // (OWPML's names are the other way round: KEEP_WORD = 한글 단위 '글자', BREAK_WORD = '어절' — FIDELITY_HWP.md 4)
  const split = opts.breakWord && shape?.breakNonLatinWord !== "BREAK_WORD";
  return (seg) => {
    const key = (split ? "1" : "0") + (opts.kinsoku ? "1" : "0") + seg;
    const hit = tokCache.get(key);
    if (hit) return hit;
    const out = tokens(seg);
    if (tokCache.size > 50000) tokCache.clear();
    tokCache.set(key, out);
    return out;
  };
  function tokens(seg: string): string[] {
    const base = tokenize(seg, "keep-all");
    if (!split && !opts.kinsoku) return base;
    const out: string[] = [];
    for (const t of base) {
      if (!split) {
        // kinsoku with word breaking off: a token that would start with a no-start mark joins the previous one
        if (opts.kinsoku && out.length && NO_START.has(t[0])) out[out.length - 1] += t;
        else out.push(t);
        continue;
      }
      const gs = graphemes(t);
      let cur = "";
      for (let i = 0; i < gs.length; i++) {
        const g = gs[i], next = gs[i + 1];
        cur += g;
        if (next === undefined || /\s/.test(next)) continue;
        if (/\s/.test(g)) continue;
        const allowed = breakable(g) || breakable(next);
        const forbidden = opts.kinsoku && (NO_START.has(next) || NO_END.has(g));
        if (allowed && !forbidden) {
          out.push(cur);
          cur = "";
        }
      }
      if (cur) out.push(cur);
    }
    return out;
  }
}
const tokCache = new Map<string, string[]>();
const countCache = new Map<string, number>();
const graphemeCount = (s: string) => {
  let n = countCache.get(s);
  if (n === undefined) {
    n = graphemes(s).length;
    if (countCache.size > 100000) countCache.clear();
    countCache.set(s, n);
  }
  return n;
};

export interface HancomWidthOptions {
  /** advance of text in the run's font without letter spacing (default: the measurer) */
  base?: (text: string, run: TextRun, font: string) => number;
  /** charPr for the character at a paragraph offset */
  shapeAt: (at: number) => HwpxCharShape | undefined;
  ratio: boolean;
  spacing: boolean;
  /** saved tab width in px for a tab at a paragraph offset */
  tabAt?: (at: number) => number | undefined;
}

const uniform = (rec: Record<string, number>) => {
  const v = Object.values(rec);
  return v.every((x) => x === v[0]);
};

/** Width function applying 장평 / 자간 per language and saved tab widths. */
export function hancomWidth(o: HancomWidthOptions): WidthFn {
  const base = o.base ?? ((t: string, _r: TextRun, f: string) => measure(t, f));
  return (text, run, font, at) => {
    const shape = o.shapeAt(at);
    // 자간 is a percent of the character's own advance after 장평 (measured in 한글 2024, LAYOUT_TRUTH.md 9); with a
    // switch off the run's own values apply (the importer now carries ratio → hscale, spacing → spacingPct)
    const ls = run.letterSpacing || 0;
    const runR = (run.hscale ?? 100) / 100, runSp = (run.spacingPct ?? 0) / 100;
    const tabsHere = o.tabAt && text.includes("\t");
    const simple = !tabsHere && (!shape || ((!o.ratio || uniform(shape.ratio)) && (!o.spacing || uniform(shape.spacing))));
    if (simple) {
      const n = graphemeCount(text);
      const r = o.ratio && shape ? shape.ratio.hangul / 100 : runR;
      const sp = o.spacing && shape ? shape.spacing.hangul / 100 : runSp;
      return base(text, run, font) * r * (1 + sp) + ls * n;
    }
    let w = 0;
    let seg = "";
    let lang: HwpxLang | null = null;
    let n = 0;
    let off = at;
    const flush = () => {
      if (!seg) return;
      const r = o.ratio && shape ? (shape.ratio[lang!] ?? 100) / 100 : runR;
      const sp = o.spacing && shape ? (shape.spacing[lang!] ?? 0) / 100 : runSp;
      w += base(seg, run, font) * r * (1 + sp) + ls * n;
      seg = "";
      n = 0;
    };
    for (const g of graphemes(text)) {
      if (g === "\t" && o.tabAt) {
        const tw = o.tabAt(off);
        if (tw !== undefined) {
          flush();
          w += tw;
          off += g.length;
          continue;
        }
      }
      const l = hwpxLang(g);
      if (l !== lang) {
        flush();
        lang = l;
      }
      seg += g;
      n++;
      off += g.length;
    }
    flush();
    return w;
  };
}

/**
 * Paragraph margins as Hangul lays them out. HWPX hh:margin values are twice the HWPUNIT length (horzpos of
 * a paragraph with left = 1000 is 500); a negative intent is 내어쓰기: first line at the left margin, the
 * following lines |intent| further in. The importer reads both as px = value / 75 and treats a negative
 * indent like CSS text-indent (only visible when the left margin is larger).
 */
export function hancomIndent(para: TextParagraph, shape: HwpxParaShape | undefined, halve = false): TextParagraph {
  if (!shape) return para;
  const k = halve ? 2 : 1;
  const left = shape.left / k / 75;
  const intent = shape.intent / k / 75;
  if (intent < 0) return { ...para, indentLeft: left - intent, indent: intent };
  return { ...para, indentLeft: left, indent: intent };
}
