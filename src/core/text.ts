// Unified typography pipeline shared by Word/HWPX/slide text.
// Line breaking works on grapheme clusters (Intl.Segmenter) so Hangul syllables and
// combining sequences are never split. "keep-all" breaks only between 어절 (space-separated words).

import type { TextNode, TextParagraph, TextRun } from "./types";
import { toPx } from "./style/len";
import { wordAscent, wordLineHeight, wordMultipleOf } from "./lineSpacing";
import { fontSubstitutes, lockedWidths } from "./fontSubst";
import { boxExtra } from "./paraBox";
import { hiddenInView, setReviewRelayout } from "./review";

export type MeasureFn = (text: string, font: string) => number;

/** Approximate advance widths for environments without a canvas (Node tests). */
const approxMeasure: MeasureFn = (text, font) => {
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "16");
  let w = 0;
  for (const ch of text) w += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch) ? size : ch === " " ? size * 0.3 : size * 0.55; // i18n: keep
  return w;
};

/**
 * Default measurer: a real canvas whenever one exists, so every entry point (the app, test pages,
 * workers) lays text out with the same metrics it is drawn with — measuring with the approximation
 * while drawing with real glyphs spreads words apart and squeezes others together.
 */
/** text smaller than this is measured at this size and scaled (linear advances, no hinting) */
const MEASURE_PX = 256;

function defaultMeasure(): MeasureFn {
  try {
    const cv = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(1, 1) : typeof document !== "undefined" ? document.createElement("canvas") : null;
    const ctx = cv?.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined;
    if (ctx && typeof ctx.measureText === "function")
      return (text, font) => {
        // small sizes are measured large and scaled: fonts with hinted widths (바탕, 굴림 …) otherwise report
        // advances rounded to whole device pixels (굴림 10 pt: 13 px a syllable instead of 13.33), and Word lays text
        // out with the fonts' linear advances
        const m = /(\d+(?:\.\d+)?)px/.exec(font);
        const px = m ? parseFloat(m[1]) : 0;
        if (px > 0 && px < MEASURE_PX) {
          ctx.font = font.replace(m![0], `${MEASURE_PX}px`);
          return (ctx.measureText(text).width * px) / MEASURE_PX;
        }
        ctx.font = font;
        return ctx.measureText(text).width;
      };
  } catch {
    /* no canvas */
  }
  return approxMeasure;
}

let measureImpl: MeasureFn = defaultMeasure();

const measureCache = new Map<string, number>();
/** bumped whenever metrics may have changed (new measurer, a web font finished loading) */
let metricsEpoch = 0;
export function setMeasure(fn: MeasureFn) {
  measureImpl = fn;
  fontsChanged();
}
/** Forget every measurement and layout (call when a font finishes loading). */
export function fontsChanged() {
  measureCache.clear();
  metricsEpoch++;
}
export const textMetricsEpoch = () => metricsEpoch;
// (an export in another review view than the screen's lays the text out again: core/review.ts withReviewPrint)
setReviewRelayout(fontsChanged);
export function measure(text: string, font: string): number {
  const key = font + "\u0000" + text;
  let v = measureCache.get(key);
  if (v === undefined) {
    const lock = lockedWidths(font);
    v = lock ? lockedMeasure(text, font, lock) : measureImpl(text, font);
    if (measureCache.size > 50000) measureCache.clear();
    measureCache.set(key, v);
  }
  return v;
}

/** A document font measured at 한글's own widths (fontSubst.ts lockedWidths); other characters by the drawing face. */
function lockedMeasure(text: string, font: string, lock: (ch: string) => number | null): number {
  const size = parseFloat(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? "16");
  let w = 0;
  for (const ch of text) {
    const em = lock(ch);
    w += em === null ? measureImpl(ch, font) : em * size;
  }
  return w;
}

/** The drawing face's widths differ from the measured ones (a metric-locked document font): draw glyph by glyph. */
export const isLockedFont = (font: string) => !!lockedWidths(font);

/** Omniweave's own text (new documents, UI): Pretendard first. */
export const FONT_FALLBACK = `"Pretendard", "Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif`;
/**
 * Text in a font a file names (Word, 한글, slides …): when that font is missing, a system font of the same kind as
 * Word substitutes it on Korean Windows (맑은 고딕 for Hangul and sans text) — never Omniweave's own Pretendard first.
 */
export const DOC_FALLBACK = `"Malgun Gothic", "Apple SD Gothic Neo", "Noto Sans KR", "Pretendard", sans-serif`;
const SERIF_FALLBACK = `"Batang", "AppleMyungjo", "Noto Serif KR", "Times New Roman", serif`;

/** Korean / CJK font names (their Latin glyphs are the font's own: Word draws Latin text in them too). */
const CJK_FONT = /[가-힣ぁ-ヿ一-鿿]|^(malgun|batang|gulim|dotum|gungsuh|nanum|hcr|hy|ms (p?gothic|p?mincho)|yu (gothic|mincho)|meiryo|simsun|simhei|mingliu|pmingliu|microsoft (yahei|jhenghei)|noto (sans|serif) (kr|jp|sc|tc|cjk)|source han|apple sd|pretendard)/i; // i18n: keep — font names matched in files

/**
 * Same-kind substitutes of fonts that are often missing (metric-compatible or the same family: what Word on Windows
 * shows in their place), tried right after the font itself. Lower-case keys.
 */
const FONT_SUBST: Record<string, string> = {
  "함초롬바탕": `"Batang"`, "hcr batang": `"Batang"`, "함초롬돋움": `"Malgun Gothic"`, "hcr dotum": `"Malgun Gothic"`, // i18n: keep — font names matched in files
  "나눔명조": `"Batang"`, nanummyeongjo: `"Batang"`, "나눔고딕": `"Malgun Gothic"`, nanumgothic: `"Malgun Gothic"`, // i18n: keep — font names matched in files
  "바탕": `"Batang"`, "바탕체": `"BatangChe"`, "굴림": `"Gulim"`, "굴림체": `"GulimChe"`, "돋움": `"Dotum"`, "돋움체": `"DotumChe"`, "궁서": `"Gungsuh"`, "맑은 고딕": `"Malgun Gothic"`, // i18n: keep — font names matched in files
  aptos: `"Calibri"`, "aptos display": `"Calibri Light"`, "calibri light": `"Calibri"`, helvetica: `"Arial"`, "helvetica neue": `"Arial"`, "liberation sans": `"Arial"`, arimo: `"Arial"`,
  times: `"Times New Roman"`, "liberation serif": `"Times New Roman"`, tinos: `"Times New Roman"`, carlito: `"Calibri"`, caladea: `"Cambria"`, courier: `"Courier New"`, "liberation mono": `"Courier New"`,
};
/**
 * A document font found by the name the file gives (its face's full name, any language) where Chromium's family lookup
 * does not find it: a font installed for one user under a localized or weight-in-name family ("KoPub돋움체 Medium",
 * "KoPub돋움체 Bold" — Windows 11 Edge fell back to 맑은 고딕, while @font-face local() with the same name gives the
 * very face PowerPoint draws; asking the family without the weight word at weight 700 gives a bold face of some
 * fonts and a doubled bold of others). One FontFace per name, family "omw-local <name>", tried right after the name and its
 * usual substitute; a name no installed face has fails to load and is dropped (the substitutes follow as before).
 * A face that loads drops the measurements at once (fontsChanged: text measured before is not drawn with widths of
 * the fallback font), and its "loadingdone" makes main.tsx repaint. Each name is asked once: a re-layout asks no new
 * face, so it cannot loop. Null without FontFace (Node).
 */
const localAliases = new Map<string, string | null>();
const localLoads = new Set<Promise<unknown>>();
function localAlias(name: string): string | null {
  const k = name.trim();
  if (localAliases.has(k)) return localAliases.get(k)!;
  const g = globalThis as { FontFace?: typeof FontFace; document?: Document };
  let fam: string | null = null;
  // (control characters have no font name; the app's own fonts are loaded by the app)
  if (g.FontFace && g.document?.fonts && k && !/[\u0000-\u001f\u007f]/.test(k) && !/^(pretendard|omni stroke)/i.test(k)) {
    fam = `omw-local ${k}`;
    try {
      // (FontFace takes the family as it is; its source is CSS, so the name is a quoted CSS string there)
      const face = new g.FontFace(fam, `local(${cssString(k)})`);
      g.document.fonts.add(face);
      const load: Promise<unknown> = face.load().then(
        () => fontsChanged(),
        () => g.document?.fonts.delete(face),
      );
      localLoads.add(load);
      void load.finally(() => localLoads.delete(load));
    } catch {
      fam = null;
    }
  }
  localAliases.set(k, fam);
  return fam;
}
/** A CSS string of any text: quotes and backslashes escaped, control characters as hex escapes. */
const cssString = (s: string) => `"${s.replace(/["\\]/g, "\\$&").replace(/[\u0000-\u001f\u007f]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `)}"`;
/**
 * Settles when every local() face asked for so far has loaded or failed (measurement pages and exports wait for it),
 * or after `ms` at most: a face that never answers does not hold anything up (and is not waited for again).
 */
export function localFontsSettled(ms = 3000): Promise<void> {
  if (!localLoads.size) return Promise.resolve();
  const waiting = [...localLoads];
  let t: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>(
    (r) =>
      (t = setTimeout(() => {
        for (const p of waiting) localLoads.delete(p);
        r();
      }, ms)),
  );
  return Promise.race([Promise.allSettled(waiting).then(() => undefined), late]).finally(() => clearTimeout(t));
}
/**
 * Ask for the local() face of every font the pages' text uses (without laying anything out), then wait for them
 * (localFontsSettled): a PDF export or a measurement then lays text out with the faces the screen shows.
 */
export async function pageFontsSettled(pages: readonly { nodes: readonly unknown[] }[], ms?: number): Promise<void> {
  const seen = new Set<string>();
  const ask = (r: { fontFamily?: string; latinFont?: string } | undefined) => {
    if (!r) return;
    const key = `${r.fontFamily ?? ""}\u0000${r.latinFont ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    cssFamily({ fontFamily: r.fontFamily ?? "", latinFont: r.latinFont });
  };
  const walk = (nodes: readonly unknown[]) => {
    for (const n of nodes as { paragraphs?: TextParagraph[]; children?: unknown[]; fontFamily?: string }[]) {
      if (!n || typeof n !== "object") continue;
      if (n.paragraphs) for (const p of n.paragraphs) for (const r of p.runs) ask(r);
      if (typeof n.fontFamily === "string") ask({ fontFamily: n.fontFamily });
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  for (const pg of pages) walk(pg.nodes);
  await localFontsSettled(ms);
}
const SERIF_NAME = /myeongjo|mincho|batang|명조|바탕|궁서|serif|times|cambria|georgia|garamond|book antiqua|palatino|song|ming/i; // i18n: keep — font names matched in files

/**
 * CSS family list of a font a document names: itself, its usual substitute (Word on Windows), the face of that name
 * (localAlias), then for a Korean document font the system fonts of its kind as 한글 substitutes them (fontSubst.ts: 한양신명조 → HY신명조, 바탕 …).
 */
function docFamily(name: string): string {
  const k = name.trim().toLowerCase();
  const sub = FONT_SUBST[k];
  const alias = localAlias(name);
  const out = [cssString(name), ...(sub ? [sub] : []), ...(alias ? [cssString(alias)] : [])];
  for (const f of fontSubstitutes(name).split(", ")) if (f && !out.some((o) => o.toLowerCase() === f.toLowerCase())) out.push(f);
  return out.join(", ");
}

/**
 * CSS font family of a run. A run with a Latin font of its own (Word ascii + eastAsia) lists it first, then the
 * East Asian font: the browser draws each glyph from the first font that has it, so Latin text gets the Latin
 * font and Hangul (missing from Latin fonts) the East Asian one — Word's choice by character range. A Latin
 * font that has Hangul of its own (a Korean font) goes after the East Asian font, so Hangul keeps the East Asian one.
 */
export function cssFamily(r: Pick<TextRun, "fontFamily" | "latinFont">): string {
  const latin = r.latinFont && r.latinFont !== r.fontFamily ? r.latinFont : "";
  if (r.fontFamily?.startsWith("Omni Stroke")) askStrokeFont();
  if ((!r.fontFamily || r.fontFamily === "Pretendard") && !latin) return FONT_FALLBACK;
  const f = r.fontFamily || "";
  const names = latin ? (CJK_FONT.test(latin) && f ? [f, latin] : [latin, ...(f ? [f] : [])]) : [f];
  const serif = SERIF_NAME.test(f || latin);
  return `${names.map(docFamily).join(", ")}, ${serif ? SERIF_FALLBACK + ", " : ""}${DOC_FALLBACK}`;
}

let strokeAsked = false;
/**
 * Drawing text set in Omni Stroke (Omniweave's single-stroke SHX stand-in, io/formats/cad/strokeFont.ts) is built and
 * registered the first time it is asked for — e.g. an .omw with an imported drawing; the repaint follows the font load.
 */
function askStrokeFont() {
  if (strokeAsked) return;
  strokeAsked = true;
  void import("../io/formats/cad/strokeInstall").then((m) => m.installStrokeFontForDocument()).catch(() => (strokeAsked = false));
}

export function cssFont(r: Pick<TextRun, "bold" | "italic" | "fontSize" | "fontFamily"> & { latinFont?: string }): string {
  return `${r.italic ? "italic " : ""}${r.bold ? 700 : 400} ${r.fontSize}px ${cssFamily(r)}`;
}

export interface Piece {
  text: string;
  x: number;
  width: number;
  run: TextRun;
  font: string;
  /** baseline shift in px (negative = up) for superscript / subscript; absent when 0 */
  dy?: number;
  /** letter spacing in px included in `width`; absent when 0 */
  letterSpacing?: number;
  /** 장평 (glyph width scale, 1 = 100 %); absent when 1 */
  hscale?: number;
  /** 한글 자간: fraction of each character's (scaled) advance added after it; absent when 0 */
  spacing?: number;
  /** text the view leaves out (deleted text in the final view, core/review.ts): no width, not drawn */
  hidden?: true;
}

/** Superscript/subscript glyphs are drawn at this fraction of the run size. */
export const SCRIPT_SCALE = 0.65;

/** Font actually used to draw a run (smaller for superscript/subscript). */
export function runFont(r: TextRun): string {
  return r.script ? cssFont({ ...r, fontSize: Math.round(r.fontSize * SCRIPT_SCALE * 100) / 100 }) : cssFont(r);
}

/** Baseline shift of a run: superscript up, subscript down. */
export function runBaselineShift(r: TextRun): number {
  return r.script === "super" ? -r.fontSize * 0.33 : r.script === "sub" ? r.fontSize * 0.14 : 0;
}

/**
 * Advance width of text in a run's font including letter spacing (one gap per grapheme). `scale` multiplies the
 * glyph advances (장평 × (1 + 한글 자간), runScale).
 */
export function advance(text: string, font: string, letterSpacing = 0, scale = 1): number {
  const w = measure(text, font) * scale;
  return letterSpacing ? w + letterSpacing * graphemes(text).length : w;
}

/**
 * Advance scale of a run: 장평 (hscale %) times 1 + 한글 자간 (spacingPct, % of the character's own scaled advance —
 * measured in 한글 2024, docs/design/LAYOUT_TRUTH.md 9).
 */
export function runScale(r: Pick<TextRun, "hscale" | "spacingPct">): number {
  return ((r.hscale ?? 100) / 100) * (1 + (r.spacingPct ?? 0) / 100);
}

/**
 * Width a token's word spaces add beyond the font's own space glyphs when spaces are `spaceEm` of the size wide
 * (TextParagraph.spaceEm, 한글). Spaces only ever end a token, so the glyphs before them are drawn where measured.
 */
export function spaceExtra(tok: string, run: TextRun, font: string, scale: number, spaceEm: number | undefined): number {
  if (!spaceEm) return 0;
  let n = 0;
  for (let i = tok.length - 1; i >= 0 && tok[i] === " "; i--) n++;
  if (!n) return 0;
  const size = run.script ? run.fontSize * SCRIPT_SCALE : run.fontSize;
  return n * (spaceEm * size - measure(" ", font)) * scale;
}

/** "Single" line height ÷ size used for at-least line heights (the natural line of a font). */
export const SINGLE_LINE = 1.2;

/**
 * Line height of a paragraph line whose largest glyphs are `size` px: exact / at least / between, a Word multiple of
 * the font's single line (core/lineSpacing.ts; `line` = the runs and text of that line, else the paragraph's first
 * run and text), else size × lineSpacing.
 */
export function lineHeightOf(
  para: Pick<TextParagraph, "lineSpacing" | "lineHeight" | "lineMultiple"> & { runs?: TextParagraph["runs"] },
  size: number,
  line?: { runs: readonly (Pick<TextRun, "fontFamily" | "fontSize"> & { latinFont?: string; text?: string })[]; text: string },
): number {
  const lh = para.lineHeight;
  const wm = wordMultipleOf(para);
  if (wm !== undefined) {
    if (line?.runs.length) return wordLineHeight(wm, line.runs, line.text);
    const r0 = para.runs?.[0];
    return wordLineHeight(wm, [{ fontFamily: r0?.fontFamily ?? "", fontSize: size }], para.runs?.map((r) => r.text).join("") ?? "");
  }
  if (!lh) return size * para.lineSpacing;
  const v = toPx(lh.v, size);
  if (lh.mode === "exact") return Math.max(1, v);
  if (lh.mode === "atLeast") {
    // Word: at least the font's single line (core/lineSpacing.ts); older documents and 한글: 1.2 × the size
    if (lh.basis !== "font") return Math.max(v, size * SINGLE_LINE);
    const runs = line?.runs.length ? line.runs : [{ fontFamily: para.runs?.[0]?.fontFamily ?? "", fontSize: size }];
    return Math.max(v, wordLineHeight(1, runs, line?.text ?? para.runs?.map((r) => r.text).join("") ?? ""));
  }
  return size + v; // between: the gap between lines (한글 '여백만')
}

/** Characters of the list marker a paragraph starts with (multi-level lists record it in list.mk). */
export function listMarkerChars(para: TextParagraph): number {
  const mk = para.list?.mk;
  if (!mk) return 0;
  let t = "";
  for (const r of para.runs) {
    t += r.text;
    if (t.length >= mk.length) break;
  }
  return t.startsWith(mk) ? mk.length : 0;
}

export interface LaidLine {
  y: number; // top of line
  height: number;
  baseline: number; // offset from top
  width: number;
  pieces: Piece[];
  paragraph: number;
}

export interface TextLayout {
  lines: LaidLine[];
  height: number;
  width: number;
}

const graphemeSeg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ko", { granularity: "grapheme" }) : null;
const wordSeg = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter("ko", { granularity: "word" }) : null;

export function graphemes(s: string): string[] {
  if (!graphemeSeg) return Array.from(s);
  return Array.from(graphemeSeg.segment(s), (x) => x.segment);
}

/**
 * Break text into wrap tokens. Each token carries its trailing whitespace. `latinWhole` (한글 '글자' unit with its
 * Latin words kept, TextParagraph.breakWord): a run of characters that are neither spaces nor Hangul / CJK is one
 * token — "+12.5%)" stays whole as 한글 keeps it (omni-hwp-tables: "대비 |+12.5%)", not "+|12.5%").
 */
export function tokenize(s: string, mode: "keep-all" | "normal", latinWhole = false): string[] {
  if (!s) return [];
  if (mode === "keep-all" || !wordSeg) {
    const out: string[] = [];
    const re = /\S+\s*|\s+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) out.push(m[0]);
    return out;
  }
  // normal: words for Latin, but CJK/Hangul may break between any grapheme
  const out: string[] = [];
  for (const seg of wordSeg.segment(s)) {
    const t = seg.segment;
    if (/[가-힯぀-ヿ一-鿿]/.test(t) && t.length > 1) out.push(...graphemes(t)); // i18n: keep
    else if (/^\s+$/.test(t) && out.length) out[out.length - 1] += t;
    // closing punctuation never starts a line (금칙): it stays with the character before it
    else if (out.length && /^[.,!?)\]}:;%·…、。」』》〉”’]+$/.test(t) && !/\s$/.test(out[out.length - 1])) out[out.length - 1] += t; // i18n: keep
    else out.push(t);
  }
  // line-breaking rules (금칙, as Word and 한글 apply them): closing punctuation never starts a line, opening never ends one
  const kept: string[] = [];
  for (const t of out) {
    const prev = kept[kept.length - 1];
    if (prev !== undefined && !/\s$/.test(prev) && (NO_START.test(t) || NO_END.test(prev) || (latinWhole && !CJK_CHAR.test(prev.slice(-1)) && !CJK_CHAR.test(t[0]) && !/^\s/.test(t)))) kept[kept.length - 1] = prev + t;
    else kept.push(t);
  }
  return kept;
}

/** characters that may not begin a line (closing punctuation) / end one (opening brackets) */
const NO_START = /^[)\]}>,.!?:;%'"’”」』】〉》、。，．！？：；…·〕）]/;
const NO_END = /[([{<'"‘“「『【〈《〔（]$/;

/** No line break between two neighbouring tokens of different runs (one word split by formatting, 금칙). */
export function glued(prev: string, next: string, mode: TextNode["wordBreak"]): boolean {
  if (!prev || !next || /\s$/.test(prev) || /^\s/.test(next)) return false;
  if (NO_START.test(next) || NO_END.test(prev)) return true;
  if (mode === "keep-all") return true;
  // normal: Hangul / CJK may break between any two characters, Latin words stay whole
  return !CJK_CHAR.test(prev.slice(-1)) && !CJK_CHAR.test(next[0]);
}
const CJK_CHAR = /[가-힯぀-ヿ一-鿿ᄀ-ᇿ]/; // i18n: keep
/**
 * A justified Word line (TextNode.justifyShrink) keeps a word (or syllable) that runs past the end by its spaces shrinking:
 * when the overrun is at most 40 % of the word and 20 % of the line's spaces (measured in Word 2021: kept up to 0.37
 * of the word / 17 % of the spaces, moved down from 0.42 of the word). Spaces next to Hangul set half-width
 * (`cjk`, TextNode.cjkSpace), a lone space after a syllable as well, do not shrink: Korean lines in 맑은 고딕 keep their breaks
 * (Word 2021, 굴림 + Arial 10 pt: "자 1,234,567" then "이" moves down — QA 11-23, omni-word-hangul-fonts).
 * A syllable inside a word (after a syllable, digit or letter) squeezes in only up to a quarter of it (바탕 11 pt keeps
 * "숫자" 0.13 over, 굴림 + Arial 12 pt moves "부서"'s "서" down at 0.35); one that starts a word up to half of it
 * (맑은 고딕 10.5 pt keeps "달 동" with "동" 0.44 over).
 */
function shrinkFits(cur: Piece[], over: number, word: string, wordW: number, cjk: boolean): boolean {
  const syllable = CJK_CHAR.test(word[0] ?? "");
  const limit = !syllable ? 0.4 : /\s$/.test(cur[cur.length - 1]?.text ?? " ") ? 0.5 : 0.25;
  if (!word || over > wordW * limit) return false;
  let spaces = 0;
  cur.forEach((p, i) => {
    const vis = p.text.replace(/\s+$/, "");
    if (vis === p.text) return;
    const w = p.width - advance(vis, p.font, p.letterSpacing, runScale(p.run));
    if (!(cjk && (CJK_CHAR.test((vis || cur[i - 1]?.text || "").slice(-1)) || CJK_CHAR.test((cur[i + 1]?.text ?? word)[0] ?? "")))) spaces += w;
  });
  return over <= spaces * 0.2;
}
/**
 * What a line's text may run past its width and still fit: one twip (Word's own unit; an AutoFit column is its text's
 * width rounded down to twips — omni-fid-cambria "합계 Total" fits its cell by 0.01 px).
 */
const FIT_EPS = 1 / 15;
/** punctuation that may hang past the line end (Word w:overflowPunct) */
const HANG = /[,.、。，．]+$/;
/**
 * The punctuation at the end of `text` that may hang: East Asian punctuation, or a comma / full stop set in the run's
 * East Asian font (Word: a run with a Latin font of its own sets them in the Latin font, and those do not hang —
 * measured: Arial "," after 굴림 text moves down with its syllable, 맑은 고딕 "," hangs).
 */
function hangOf(text: string, run: TextRun): RegExpExecArray | null {
  const m = HANG.exec(text);
  if (!m) return null;
  return /^[,.]+$/.test(m[0]) && run.latinFont && !CJK_FONT.test(run.latinFont) ? null : m;
}

/**
 * Word's automatic space (w:autoSpaceDE / w:autoSpaceDN, on unless a style turns them off): a quarter of the size
 * between Hangul / CJK and a Latin letter (`alpha`) or a digit (`digit`), either order — measured in Word 2021:
 * "제1조" at 10 pt has 2.52 pt on each side of the "1". Offset of the character before the boundary → space (px).
 */
function autoSpaces(r: TextRun, after: string, on: { alpha?: boolean; digit?: boolean }): Map<number, number> {
  const out = new Map<number, number>();
  const t = r.text;
  const kind = (c: string | undefined) => (!c ? 0 : CJK_CHAR.test(c) ? 1 : on.alpha && /[A-Za-z]/.test(c) ? 2 : on.digit && /[0-9]/.test(c) ? 2 : 0);
  const gap = r.fontSize * (r.script ? SCRIPT_SCALE : 1) * 0.25;
  for (let i = 0; i < t.length; i++) {
    const a = kind(t[i]), b = kind(t[i + 1] ?? after);
    if (a && b && a !== b) out.set(i, gap);
  }
  return out;
}

/**
 * Offsets of the spaces of a run that are set in its East Asian font at half the size (TextNode.cjkSpace): the spaces
 * next to Hangul / CJK in a run with an East Asian font. Spaces between Latin words keep the font's own width, in a
 * Latin font beside it and in the East Asian font alike (measured in Word 2021: Calibri + 맑은 고딕 and 맑은 고딕 alone).
 */
function cjkSpaces(r: TextRun, before: string, after: string): Set<number> {
  const out = new Set<number>();
  const t = r.text;
  const eaFont = CJK_FONT.test(r.fontFamily);
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== " ") continue;
    if (eaFont && (CJK_CHAR.test(t[i - 1] ?? before) || CJK_CHAR.test(t[i + 1] ?? after))) out.add(i);
  }
  return out;
}

/**
 * Signature of what decides a paragraph's line breaks (text, fonts, sizes, 장평·자간, indents): 한글's saved lines
 * (TextParagraph.hwpLines) apply only while it is what the import gave.
 */
export function hwpLinesSig(para: Pick<TextParagraph, "runs" | "indent" | "indentLeft" | "indentRight">): string {
  let s = `${para.indent}|${para.indentLeft ?? 0}|${para.indentRight ?? 0}`;
  for (const r of para.runs) s += `|${r.text}\u0001${r.fontFamily}\u0001${r.fontSize}\u0001${+!!r.bold}${+!!r.italic}\u0001${r.hscale ?? ""}\u0001${r.spacingPct ?? ""}\u0001${r.letterSpacing ?? ""}\u0001${r.script ?? ""}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36) + s.length.toString(36);
}

/**
 * Where 한글 broke the paragraph's lines (character offsets), when its saved line layout applies: the paragraph is
 * unchanged since import and the box is as wide as 한글's lines (the column / cell less the right margin; the
 * width itself or the width before our right indent). Otherwise null (our own line breaking).
 */
function hwpBreaks(para: TextParagraph, maxW: number, lineMax: number): Set<number> | null {
  const h = para.hwpLines;
  if (!h || !(Math.abs(h.right - lineMax) <= 1.5 || Math.abs(h.right - maxW) <= 1.5) || h.sig !== hwpLinesSig(para)) return null;
  const text = para.runs.map((r) => r.text).join("");
  const out = new Set<number>();
  // a line that starts after a line break already starts there
  for (const a of h.at) if (a > 0 && a < text.length && text[a - 1] !== "\n") out.add(a);
  return out;
}

const layoutCache = new WeakMap<TextNode, { epoch: number; layout: TextLayout }>();
/**
 * Lines of one paragraph (y from the paragraph's top), per paragraph object, box width and word break: a paragraph
 * that moves to another box or page unchanged (the body flow, core/flow.ts) is not laid out again.
 */
const paraCache = new WeakMap<TextParagraph, { epoch: number; w: number; key: string; lines: LaidLine[]; height: number }>();

/** The node options a paragraph's lines depend on besides the width: word break and the Word line rules. */
export const paraKey = (n: TextNode) =>
  `${n.wordBreak}|${n.cjkSpace ?? ""}|${n.hangPunct ? 1 : 0}|${n.justifyShrink ? 1 : 0}|${n.autoSpace ? `${n.autoSpace.alpha ? "a" : ""}${n.autoSpace.digit ? "d" : ""}` : ""}`;

/**
 * How much of paragraph `q`'s space before is already given by the space after of `p` right above it in the same frame
 * (TextNode.wordSpacing "max": Word draws the larger of the two, not their sum — measured on Word 2021 PDFs). 0 when
 * the spacing adds up, `q` continues a paragraph cut at a page end, `p` is such a head, or a border box sits between.
 */
export function spacingOverlap(n: Pick<TextNode, "wordSpacing">, p: TextParagraph, q: TextParagraph): number {
  if (q.flowCont) return 0;
  // (below Word's continuous section break mark, TextParagraph.sectMark: the space before is less the mark's space
  // after, and what is left overlaps that space after as usual — Word 2021 PDFs, both spacing rules)
  const before = q.spaceBefore ?? 0;
  const cut = isSectMark(p) ? Math.min(before, Math.max(0, p.spaceAfter)) : 0;
  if (n.wordSpacing !== "max" || p.flowSplit || p.border || q.border) return cut;
  return cut + Math.max(0, Math.min(before - cut, p.spaceAfter));
}

/**
 * Width of a piece's highlight: the last piece of a line without its trailing spaces (Word) — measured on the piece, as
 * the line's width is the one before a centred / right line is moved.
 */
export function shadeWidth(line: Pick<LaidLine, "pieces">, p: Piece): number {
  if (p !== line.pieces[line.pieces.length - 1]) return p.width;
  const trimmed = p.text.replace(/\s+$/, "");
  return trimmed === p.text ? p.width : Math.min(p.width, advance(trimmed, p.font, p.letterSpacing, runScale(p.run)) * (p.hscale ?? 1));
}

/** An empty paragraph holding Word's section break before a continuous section (TextParagraph.sectMark): no line. */
export const isSectMark = (p: TextParagraph) => !!p.sectMark && p.runs.every((r) => !r.text);

export function layoutText(node: TextNode): TextLayout {
  const cached = layoutCache.get(node);
  if (cached && cached.epoch === metricsEpoch) return cached.layout;
  const lines: LaidLine[] = [];
  const maxW = Math.max(10, node.width);
  let y = 0;
  const pk = paraKey(node);
  node.paragraphs.forEach((para, pi) => {
    // Word's HTML paragraph spacing: the space before overlaps the space after of the paragraph above
    if (pi > 0) y -= spacingOverlap(node, node.paragraphs[pi - 1], para);
    // paragraph borders take room above and below the paragraph's own layout (core/paraBox.ts)
    const bx = para.border ? boxExtra(node.paragraphs, pi) : null;
    if (bx) y += bx.top;
    const pc = paraCache.get(para);
    if (pc && pc.epoch === metricsEpoch && pc.w === maxW && pc.key === pk) {
      for (const l of pc.lines) lines.push({ ...l, y: l.y + y, paragraph: pi });
      y += pc.height + (bx?.bottom ?? 0);
      return;
    }
    const y0 = y;
    const first = lines.length;
    let lineStart = lines.length;
    let cur: Piece[] = [];
    const left = para.indentLeft ?? 0;
    // right indent: lines end that far before the box edge (alignment too)
    const lineMax = Math.max(left + 10, maxW - (para.indentRight ?? 0));
    // the rest of a paragraph cut at a page end (core/flow.ts) continues at the left indent, without space before
    const cont = !!para.flowCont;
    const sectMark = isSectMark(para);
    // (a slide paragraph's list marker stands at marL + indent even left of the text box's edge — PowerPoint: marL 0,
    // indent −8.5 pt puts the bullet 8.5 pt into the inset and the text at the edge; other text starts at 0 at least)
    const slideMk = !cont && para.slideAscent !== undefined && para.indent < 0 && listMarkerChars(para) > 0;
    let x = slideMk ? left + para.indent : Math.max(0, cont ? left : left + para.indent);
    // 한글's own line breaks while the paragraph is as the file saved it (TextParagraph.hwpLines)
    const forced = para.hwpLines ? hwpBreaks(para, maxW, lineMax) : null;
    const step = para.tabStep && para.tabStep > 1 ? para.tabStep : 0;
    // 공백 최소값: the word spaces of the line so far may give up this share of their width for one more word
    const cond = para.condense ?? 0;
    let spaceW = 0;
    let maxSize = 0;
    // Word-multiple paragraphs: the runs of the current line (their fonts decide the single line height)
    const wm = wordMultipleOf(para);
    // (and at-least lines measured from the font's single line, as Word does)
    const perLine = wm !== undefined || (para.lineHeight?.mode === "atLeast" && para.lineHeight.basis === "font");
    let lineRuns: TextRun[] = [];
    let lastOfPara = false;
    // tallest inline object (그림 글자처럼) on the current line: its bottom sits on the baseline
    let objH = 0;
    const grow = (run: TextRun) => {
      maxSize = Math.max(maxSize, run.fontSize);
      if (perLine) lineRuns.push(run);
    };
    // a list marker in the hanging indent: the text after it starts at the left indent (Word's tab after the number)
    const mkChars = para.indent < 0 && !cont ? listMarkerChars(para) : 0;
    let consumed = 0;
    if (!cont) y += para.spaceBefore ?? 0;
    const flush = (last: boolean) => {
      const size = maxSize || para.runs[0]?.fontSize || 16;
      // each piece by its own text (a Latin font's Latin text has the font's line, its Hangul the East Asian fallback's)
      const lineOf = perLine && lineRuns.length ? { runs: cur.length ? cur.map((p) => ({ fontFamily: p.run.fontFamily, latinFont: p.run.latinFont, fontSize: p.run.fontSize, text: p.text })) : lineRuns.map((r) => ({ fontFamily: r.fontFamily, latinFont: r.latinFont, fontSize: r.fontSize })), text: cur.map((p) => p.text).join("") } : null;
      const height = lineOf ? lineHeightOf(para, size, lineOf) : lineHeightOf(para, size);
      // trim trailing whitespace width for alignment
      let width = 0;
      if (cur.length) {
        const lp = cur[cur.length - 1];
        const trimmed = lp.text.replace(/\s+$/, "");
        width = lp.x + (lp.hidden || trimmed === lp.text ? lp.width : advance(trimmed, lp.font, lp.letterSpacing, runScale(lp.run)));
      }
      // 한글's line set in a wider substitute font: narrowed to 한글's line width (glyphs and advances alike), so
      // the line keeps the original's breaks and right edge
      if (forced && width > lineMax + 0.25 && cur.length) {
        const x0 = cur[0].x;
        const f = Math.max(0.5, (lineMax - x0) / (width - x0));
        for (const p of cur) {
          p.x = x0 + (p.x - x0) * f;
          p.width *= f;
          p.hscale = (p.hscale ?? 1) * f;
          if (p.letterSpacing) p.letterSpacing *= f;
        }
        width = x0 + (width - x0) * f;
      }
      let shift = 0;
      if (para.align === "CENTER") shift = (lineMax - width) / 2;
      else if (para.align === "RIGHT") shift = lineMax - width;
      else if (para.align === "JUSTIFY" && (!last || (para.flowSplit && lastOfPara)) && cur.length > 1) {
        // the extra room goes into the spaces of the line (Word, 한글); a line without spaces spreads it between pieces
        const gaps = cur.slice(0, -1).filter((p) => !p.hidden && /\s$/.test(p.text)).length;
        // (punctuation hanging past the end is outside the line; a Word line set tight shrinks its spaces)
        const lp = cur[cur.length - 1];
        const hung = node.hangPunct ? hangOf(lp.text.replace(/\s+$/, ""), lp.run) : null;
        const fitWidth = hung && hung.index > 0 ? lp.x + advance(lp.text.slice(0, hung.index), lp.font, lp.letterSpacing, runScale(lp.run)) : width;
        const room = lineMax - fitWidth;
        const extra = (room < 0 && !(gaps && node.justifyShrink) ? 0 : room) / (gaps || cur.length - 1);
        let add = 0;
        cur.forEach((p) => {
          p.x += add;
          if (!p.hidden && (!gaps || /\s$/.test(p.text))) add += extra;
        });
      }
      if (shift) cur.forEach((p) => (p.x += shift));
      // a Word multiple of 1 or more adds its extra room below the text: the baseline sits where it does in the font's
      // single line (core/lineSpacing.ts wordAscent; measured in Word 2021: 1.5 / 2.0 lines are 4.3 / 8.7 pt higher than
      // centred in their pitch at 10.5 pt). Fonts not measured: centred in the single line.
      // (an at-least line no taller than the font's single line is that single line; an empty line has its paragraph
      // mark's font, as lineHeightOf)
      const lhm = para.lineHeight;
      const ascOf = lineOf ?? (perLine ? { runs: [{ fontFamily: para.runs[0]?.fontFamily ?? "", fontSize: size }], text: para.runs.map((r) => r.text).join("") } : null);
      const single = ascOf ? (wm !== undefined ? (wm >= 1 ? height / wm : 0) : lhm?.mode === "atLeast" && lhm.basis === "font" && toPx(lhm.v, size) <= wordLineHeight(1, ascOf.runs, ascOf.text) + 0.01 ? height : 0) : 0;
      const asc = single && ascOf ? wordAscent(ascOf.runs, ascOf.text) : undefined;
      let baseline = para.lineTop
        ? Math.min(height, size) * 0.85
        : para.slideAscent !== undefined
          ? Math.max(para.slideAscent * size - Math.max(0, SINGLE_LINE * size - height), 0.75 * height)
          : asc !== undefined && asc < height
          ? asc
          : // a Word exact line (twips) has its baseline at 80 % of the line (Word 2021: 18 pt line, 10 pt 맑은 고딕 → 14.5 pt)
            lhm?.mode === "exact" && lhm.v.u === "twip" && !wm
            ? height * 0.8
            : ((single || height) - size) / 2 + size * 0.8;
      // (Word's continuous section break mark takes no line: TextParagraph.sectMark)
      let lh = sectMark ? 0 : height;
      if (sectMark) baseline = 0;
      if (objH > baseline) {
        lh = height + objH - baseline;
        baseline = objH;
      }
      lines.push({ y, height: lh, baseline, width, pieces: cur, paragraph: pi });
      y += lh;
      cur = [];
      x = left;
      maxSize = 0;
      objH = 0;
      lineRuns = [];
      spaceW = 0;
    };
    // character offset of the run in the paragraph (한글's saved line starts)
    let runAt = 0;
    // pieces of one word split over runs (cur[glueFrom..]): a line break before it moves all of them down
    let glueFrom = 0;
    para.runs.forEach((run, ri) => {
      if (hiddenInView(run)) {
        // deleted text in the final view (core/review.ts): kept in the line with no width, so story offsets still count it
        if (run.text) cur.push({ text: run.text, x, width: 0, run, font: runFont(run), hidden: true });
        consumed += run.text.length;
        runAt += run.text.length;
        return;
      }
      if (run.obj) {
        // an object like a character (그림 글자처럼): one unbreakable piece as wide as the object (drawn as nothing;
        // core/flow.ts places the object's node there)
        const w = Math.max(1, run.obj.w);
        if (x + w > lineMax && cur.length) flush(false);
        cur.push({ text: "\u200B", x, width: w, run, font: runFont(run) });
        grow(run);
        objH = Math.max(objH, run.obj.h);
        x += w;
        consumed += run.text.length;
        runAt += run.text.length;
        glueFrom = cur.length; // a word right after the object does not take the object with it to the next line
        return;
      }
      const font = runFont(run);
      const ls = run.letterSpacing || 0;
      const k = runScale(run);
      const extra: Pick<Piece, "dy" | "letterSpacing" | "hscale" | "spacing"> = {};
      const dy = runBaselineShift(run);
      if (dy) extra.dy = dy;
      if (ls) extra.letterSpacing = ls;
      if (run.hscale && run.hscale !== 100) extra.hscale = run.hscale / 100;
      if (run.spacingPct) extra.spacing = run.spacingPct / 100;
      // with 한글's saved lines: the run cut where they start (a new line before every part after the first)
      const parts: string[] = [];
      if (forced) {
        let from = 0;
        for (let i = 1; i < run.text.length; i++)
          if (forced.has(runAt + i)) {
            parts.push(run.text.slice(from, i));
            from = i;
          }
        parts.push(run.text.slice(from));
        if (forced.has(runAt) && runAt > 0) parts.unshift("");
      } else parts.push(run.text);
      runAt += run.text.length;
      for (let part = 0, partAt = 0; part < parts.length; partAt += parts[part].length, part++) {
      if (part && cur.length) flush(false);
      // "\n" inside a run is a line break within the paragraph (Word w:br, HWPX hp:lineBreak)
      // (한글 '글자 단위' paragraphs break Hangul between syllables; with default tab stops a tab is a token of its own)
      const wb = para.breakWord ? "normal" : node.wordBreak;
      const toks0 = parts[part]
        .split("\n")
        .flatMap((seg, i) => (i ? ["\n", ...tokenize(seg, wb, !!para.breakWord)] : tokenize(seg, wb, !!para.breakWord)))
        .flatMap((tk) => (step && tk.includes("\t") ? tk.split(/(\t)/).filter(Boolean) : [tk]));
      // Word's automatic space between Hangul and Latin letters / digits (node.autoSpace): a token is cut where one
      // falls inside it (the parts stay together), and the space follows the character before the boundary
      const gaps = node.autoSpace ? autoSpaces(run, para.runs[ri + 1]?.text[0] ?? "", node.autoSpace) : null;
      const toks: string[] = [];
      const joined = new Set<number>(); // indexes of toks glued to the one before
      const gapOf = new Map<number, number>(); // toks index → space after it
      {
        let o = partAt;
        for (const tk of toks0) {
          let s0 = 0;
          if (gaps?.size)
            for (let i = 0; i < tk.length; i++) {
              const g = gaps.get(o + i);
              if (!g) continue;
              if (s0 > 0) joined.add(toks.length);
              toks.push(tk.slice(s0, i + 1));
              gapOf.set(toks.length - 1, g);
              s0 = i + 1;
            }
          if (s0 < tk.length) {
            if (s0 > 0) joined.add(toks.length);
            toks.push(tk.slice(s0));
          }
          o += tk.length;
        }
      }
      // half-width East Asian spaces (node.cjkSpace): what each such space adds to the measured one
      const half = node.cjkSpace === "half" ? cjkSpaces(run, para.runs[ri - 1]?.text.slice(-1) ?? "", para.runs[ri + 1]?.text[0] ?? "") : null;
      const fix = half?.size ? ((run.script ? run.fontSize * SCRIPT_SCALE : run.fontSize) * 0.5 - measure(" ", font)) * k : 0;
      let off = partAt;
      toks.forEach((tok, ti) => {
        const at = off;
        off += tok.length;
        if (tok === "\n") {
          grow(run);
          consumed += 1;
          flush(true); // like a paragraph's last line: never stretched by justification
          glueFrom = 0;
          return;
        }
        if (step && tok === "\t") {
          const tw = Math.max(1, left + Math.floor((x - left) / step + 1e-6) * step + step - x);
          cur.push({ text: tok, x, width: tw, run, font, ...extra });
          grow(run);
          x += tw;
          consumed += 1;
          glueFrom = cur.length;
          return;
        }
        let w = advance(tok, font, ls, k) + (gapOf.get(ti) ?? 0) + spaceExtra(tok, run, font, k, para.spaceEm);
        // (a half-width space takes the run's character spacing twice — Word 2021: 맑은 고딕 10 pt with −0.5 pt
        // spacing has 9.5 pt syllables and 4.0 pt spaces, with +1 pt a space is wider than 6.7 pt)
        if (half?.size) for (let i = tok.length - 1; i >= 0 && tok[i] === " "; i--) if (half.has(at + i)) w += fix + ls;
        const vis = tok.replace(/\s+$/, "");
        const visW = advance(vis, font, ls, k);
        // closing punctuation may hang past the line end (node.hangPunct): the token fits when the rest of it does
        const hang = node.hangPunct ? hangOf(vis, run) : null;
        const fitW = hang && hang.index > 0 ? advance(vis.slice(0, hang.index), font, ls, k) : visW;
        const glue = cur.length > 0 && (joined.has(ti) || (ti === 0 && glued(cur[cur.length - 1].text, tok, node.wordBreak)));
        if (!glue) glueFrom = cur.length;
        // (a run that is only spaces never starts a line: spaces past the end hang, also after a line kept tight)
        if (!forced && vis && x - spaceW * cond + fitW > lineMax + FIT_EPS && cur.length && !(node.justifyShrink && para.align === "JUSTIFY" && shrinkFits(cur, x + fitW - lineMax, vis, fitW, !!node.cjkSpace))) {
          if (glue && glueFrom > 0) {
            // the word began in an earlier run on this line: it goes to the next line whole
            const moved = cur.splice(glueFrom);
            maxSize = Math.max(0, ...cur.map((p) => p.run.fontSize));
            if (perLine) lineRuns = cur.map((p) => p.run);
            flush(false);
            for (const p of moved) {
              p.x = x;
              x += p.width;
              cur.push(p);
              grow(p.run);
            }
          } else flush(false);
          glueFrom = 0;
        }
        if (!forced && visW > lineMax - left) {
          consumed += tok.length;
          // a single token longer than the line: break by grapheme cluster
          let chunk = "";
          for (const g of graphemes(tok)) {
            const cw = advance(chunk + g, font, ls, k);
            if (x + cw > lineMax && chunk) {
              cur.push({ text: chunk, x, width: advance(chunk, font, ls, k), run, font, ...extra });
              grow(run);
              flush(false);
              chunk = g;
            } else chunk += g;
          }
          if (chunk) {
            w = advance(chunk, font, ls, k);
            cur.push({ text: chunk, x, width: w, run, font, ...extra });
            grow(run);
            x += w;
          }
          glueFrom = Math.max(0, cur.length - 1);
          return;
        }
        cur.push({ text: tok, x, width: w, run, font, ...extra });
        grow(run);
        x += w;
        if (cond) spaceW += w - visW;
        consumed += tok.length;
        if (mkChars && consumed === mkChars && lines.length === lineStart && x < left) x = left;
      });
      }
    });
    lastOfPara = true;
    flush(true);
    lastOfPara = false;
    if (lines.length === lineStart) lineStart = lines.length;
    // the head of a paragraph cut at a page end: its last line is not the paragraph's end
    if (!para.flowSplit) y += para.spaceAfter;
    paraCache.set(para, { epoch: metricsEpoch, w: maxW, key: pk, lines: lines.slice(first).map((l) => ({ ...l, y: l.y - y0, paragraph: 0 })), height: y - y0 });
    if (bx) y += bx.bottom;
  });
  const layout: TextLayout = { lines, height: Math.max(y, 4), width: maxW };
  layoutCache.set(node, { epoch: metricsEpoch, layout });
  return layout;
}

export function plainText(node: TextNode): string {
  return node.paragraphs.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
}
