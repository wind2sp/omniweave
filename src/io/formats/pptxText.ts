// PowerPoint text formatting as PowerPoint resolves it (ECMA-376 Part 1 §19.3.1.51 txStyles, §21.1.2.3 text lists):
// list-style levels inherited master txStyles → master placeholder → layout placeholder → slide shape (lstStyle) →
// paragraph pPr → run rPr; the theme's font scheme (+mj-lt / +mn-ea …, the per-script font when a:ea is empty); and
// East Asian vs Latin characters drawn with a:ea / a:latin. Clean-room from the public schema; measured against
// PowerPoint's own PDF output (docs/design/FIDELITY_PPTX.md).

import { attr, child, children, descendants } from "../xml";

/** One list level: paragraph attributes and children, and the default run properties (defRPr). */
export interface LvlStyle {
  /** pPr attributes (marL, indent, algn, …) */
  p: Record<string, string>;
  lnSpc?: Element;
  spcBef?: Element;
  spcAft?: Element;
  /** buNone / buChar / buAutoNum / buBlip */
  bu?: Element;
  /** a:buFont typeface (null after a:buFontTx: the text's font) */
  buFont?: string | null;
  /** rPr attributes (sz, b, i, u, strike, spc, baseline, lang, altLang) */
  r: Record<string, string>;
  /** solidFill / gradFill of the text */
  fill?: Element;
  latin?: string;
  ea?: string;
  highlight?: Element;
}

export type ListStyle = LvlStyle[];

export const LEVELS = 9;

export function emptyStyle(): ListStyle {
  return Array.from({ length: LEVELS }, () => ({ p: {}, r: {} }));
}

const cloneLvl = (l: LvlStyle): LvlStyle => ({ ...l, p: { ...l.p }, r: { ...l.r } });

const R_ATTRS = ["sz", "b", "i", "u", "strike", "spc", "baseline", "lang", "altLang", "cap"];

/** Merge the run properties of an a:rPr / a:defRPr / a:endParaRPr into a level (in place). */
export function mergeRPr(l: LvlStyle, rPr: Element | null | undefined): LvlStyle {
  if (!rPr) return l;
  for (const a of R_ATTRS) {
    const v = attr(rPr, a);
    if (v != null) l.r[a] = v;
  }
  for (const c of children(rPr)) {
    switch (c.localName) {
      case "solidFill":
      case "gradFill":
      case "noFill":
        l.fill = c;
        break;
      case "latin":
        if (attr(c, "typeface") != null) l.latin = attr(c, "typeface")!;
        break;
      case "ea":
        if (attr(c, "typeface") != null) l.ea = attr(c, "typeface")!;
        break;
      case "highlight":
        l.highlight = c;
        break;
    }
  }
  return l;
}

/** Merge an a:pPr / a:lvlNpPr into a level (in place), its a:defRPr included. */
export function mergePPr(l: LvlStyle, pPr: Element | null | undefined, withDefRPr = true): LvlStyle {
  if (!pPr) return l;
  for (const a of Array.from(pPr.attributes)) l.p[a.localName || a.name] = a.value;
  for (const c of children(pPr)) {
    switch (c.localName) {
      case "lnSpc":
        l.lnSpc = c;
        break;
      case "spcBef":
        l.spcBef = c;
        break;
      case "spcAft":
        l.spcAft = c;
        break;
      case "buNone":
      case "buChar":
      case "buAutoNum":
      case "buBlip":
        l.bu = c;
        break;
      case "buFont":
        l.buFont = attr(c, "typeface") || null;
        break;
      case "buFontTx":
        l.buFont = null;
        break;
      case "defRPr":
        if (withDefRPr) mergeRPr(l, c);
        break;
    }
  }
  return l;
}

/** A list style (a:lstStyle, p:titleStyle, p:defaultTextStyle …) applied over `base`: defPPr to every level, then lvlNpPr. */
export function applyLstStyle(base: ListStyle, lst: Element | null | undefined): ListStyle {
  if (!lst) return base;
  const out = base.map(cloneLvl);
  const def = child(lst, "defPPr");
  if (def) out.forEach((l) => mergePPr(l, def));
  for (let i = 0; i < LEVELS; i++) {
    const lv = child(lst, `lvl${i + 1}pPr`);
    if (lv) mergePPr(out[i], lv);
  }
  return out;
}

/** Copy of one level with a paragraph's own pPr merged (its defRPr is for new text and does not style runs). */
export function paraLevel(levels: ListStyle, lvl: number, pPr: Element | undefined): LvlStyle {
  return mergePPr(cloneLvl(levels[Math.max(0, Math.min(LEVELS - 1, lvl))]), pPr, false);
}

export const runLevel = (l: LvlStyle, rPr: Element | undefined): LvlStyle => mergeRPr(cloneLvl(l), rPr);

// ───────── theme fonts ─────────

interface FontSet {
  latin: string;
  ea: string;
  /** a:font script="Hang" … typefaces */
  scripts: Record<string, string>;
}
export interface ThemeFonts {
  major: FontSet;
  minor: FontSet;
}

export function themeFontsOf(theme: Document | null): ThemeFonts | null {
  const fs = theme && descendants(theme, "fontScheme")[0];
  if (!fs) return null;
  const set = (name: string): FontSet => {
    const el = child(fs, name);
    const scripts: Record<string, string> = {};
    if (el) for (const f of children(el, "font")) scripts[attr(f, "script") ?? ""] = attr(f, "typeface") ?? "";
    const face = (n: string) => {
      const f = el && child(el, n);
      return (f && attr(f, "typeface")) || "";
    };
    return { latin: face("latin"), ea: face("ea"), scripts };
  };
  return { major: set("majorFont"), minor: set("minorFont") };
}

/** The theme's script for an East Asian language tag (ko-KR → Hang …); Korean when nothing tells. */
function eaScript(lang: string | undefined): string {
  const l = (lang ?? "").toLowerCase();
  if (l.startsWith("ja")) return "Jpan";
  if (l === "zh-tw" || l === "zh-hk" || l === "zh-mo") return "Hant";
  if (l.startsWith("zh")) return "Hans";
  return "Hang";
}

const isEaLang = (l?: string) => !!l && /^(ko|ja|zh)/i.test(l);

/**
 * A typeface as PowerPoint draws it: "+mj-lt" / "+mn-ea" … through the theme (an empty theme a:ea → the theme's font
 * for the text's East Asian script), any other name as it is (the Windows font name, localized or not).
 */
export function resolveFace(face: string | undefined, fonts: ThemeFonts | null, r: Record<string, string>): string | undefined {
  if (face == null) return undefined;
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(face);
  if (!m) return face || undefined;
  if (!fonts) return undefined;
  const set = m[1] === "mj" ? fonts.major : fonts.minor;
  if (m[2] === "lt") return set.latin || undefined;
  if (m[2] === "cs") return undefined;
  const lang = isEaLang(r.lang) ? r.lang : isEaLang(r.altLang) ? r.altLang : undefined;
  return set.ea || set.scripts[eaScript(lang)] || set.latin || undefined;
}

// ───────── line placement ─────────

/**
 * Baseline of an unreduced PowerPoint line below its top, × the font size (TextParagraph.slideAscent): read from
 * PowerPoint's PDFs of qa/interop/scripts/pptx_lines_make.ps1 at 12 / 21 / 33 pt (docs/design/FIDELITY_PPTX.md 5장).
 * About 1.2 × the font's Windows ascent share (ascent ÷ (ascent + descent)); fonts not measured get 0.975.
 */
const SLIDE_ASCENT: Record<string, number> = {
  "맑은 고딕": 0.982, "malgun gothic": 0.982, "맑은 고딕 semilight": 0.982, "malgun gothic semilight": 0.982, // i18n: keep — font names matched in files
  "바탕": 1.031, batang: 1.031, "굴림": 1.031, gulim: 1.031, "돋움": 1.031, dotum: 1.031, "궁서": 1.031, gungsuh: 1.031, // i18n: keep
  "나눔고딕": 0.961, nanumgothic: 0.961, // i18n: keep
  arial: 0.975, "arial black": 0.946, calibri: 0.946, "calibri light": 0.946,
  "times new roman": 0.97, "segoe ui": 0.975, verdana: 0.984, tahoma: 0.984, georgia: 0.971, cambria: 0.975,
  consolas: 0.952, "century gothic": 0.979,
};
export const SLIDE_ASCENT_DEFAULT = 0.975;
export const slideAscentOf = (font: string) => SLIDE_ASCENT[font.trim().toLowerCase()] ?? SLIDE_ASCENT_DEFAULT;

// ───────── East Asian / Latin characters ─────────

/** Characters PowerPoint draws with the East Asian font (Hangul, CJK, kana, CJK punctuation, full-width forms). */
const EA = /[ᄀ-ᇿ⺀-⿿　-〿぀-ヿ㄀-ㇿ㈀-㏿㐀-䶿一-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/;
const NEUTRAL = /[\s ]/;

/** Split text into pieces drawn with the Latin or the East Asian font; spaces stay with the text before them. */
export function splitScripts(text: string, latin: string, ea: string): { text: string; font: string }[] {
  if (latin === ea || !text) return [{ text, font: latin }];
  const out: { text: string; font: string }[] = [];
  for (const ch of text) {
    const font = NEUTRAL.test(ch) && out.length ? out[out.length - 1].font : EA.test(ch) ? ea : latin;
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += ch;
    else out.push({ text: ch, font });
  }
  return out;
}
