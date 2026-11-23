// Word (DOCX / OpenXML) and Hangul (HWPX / OWPML) import & export.
// Both formats map to the same TextParagraph/TextRun model plus TABLE nodes, then flow across A4 pages.
// Clean-room: built only from the public OOXML (ECMA-376) and HWPX (KS X 6101) structures.
//
// Lists: inside Omniweave a list paragraph has role "li"/"oli" and its marker ("• ", "1. ") is real
// text (core/richtext.ts). On export the marker text is removed and the paragraph gets real list
// numbering (DOCX numbering.xml + w:numPr, HWPX bullet/numbering + paraPr heading BULLET/NUMBER); on
// import real numbering becomes role + marker text again.
//
// Line spacing (core/lineSpacing.ts): a paragraph is either a Word multiple (lineMultiple: the font's single line × v)
// or a percent of the font SIZE (lineSpacing alone: size × lineSpacing, 한글 PERCENT and every older document).
//   DOCX  w:line lineRule auto (240 = single) ↔ Word multiple exactly (v = line / 240, written back as round(v × 240)).
//         A percent paragraph is written as the same height: w:line = 240 × lineSpacing ÷ ratio, ratio = Word's single
//         line ÷ size for the font and script (fontLineRatio, measured in Word); a DOCX paragraph read before Word
//         multiples writes its original w:line back (wordLine) while its lineSpacing is unchanged.
//   HWPX  PERCENT ↔ percent paragraph 1:1 (unchanged); a Word multiple is written as the PERCENT of the same height,
//         round(v × ratio × 100) for the paragraph's font and text (Pretendard 1.08 → 168%). HWPX import stays percent.

import { t as tx } from "../i18n";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { DEFAULT_MARGINS, bodyBox, hardBreakBefore, legacyWordPages, paperOf, sectionsOf, setupOf, storedMargins, type PageSetup, type PaperId } from "../core/pageSetup";
import { formerRun, markerLength, plainFormat, renumber } from "../core/richtext";
import { endCut, joinSplit, joinTable, unpiece } from "../core/flow";
import { HWPX_NUMFMT_IN, MAX_LEVELS, fromHwpxLevelText, hwpxLevelKept, isBulletLevel, levelIndent, levelOf, resolveDef, toHwpxLevelText, type ListFormat, type ListSeed } from "../core/lists";
import type { ListDef, ListLevel } from "../core/style/types";
import { TABLE_LINE, coverMap, spanOf } from "../core/table";
import { graphemes, hwpLinesSig, layoutText, lineHeightOf, measure, runFont } from "../core/text";
import { fontLineRatio, paraLineRatio, wordMultipleOf } from "../core/lineSpacing";
import { toPx } from "../core/style/len";
import type { Len } from "../core/style/types";
import { DEFAULT_RUN, PAGE_PRESETS, type AssetRef, newPage, newParagraph, newText, uid, type Align, type FieldKind, type PageNumFormat, type PageNumPos, type SectionHF, type Page, type PageMargins, type ParaLineHeight, type ParaList, type TableCell, type TableNode, type TextNode, type TextParagraph, type TextRun, type NoteKindPr, type NoteNumFormat, type NotePr, type NoteRef, type ParaBorderLine, type ParaBorders, type DocComment, type MemoShape } from "../core/types";
import { hwpxNotePr, noteMarkText } from "../core/notes";
import { attr, child, children, descendants, esc, parseXml, textOf } from "./xml";
import { HWPX_MEDIA, NS_R, NS_WP, REL_IMAGE, docxDrawingXml, docxPicOf, docxPicPara, hwpxPicOf, hwpxPicXml, itemTops, picFormat, picMedia, picPixels, picTargets, topDrawings, topPics, type OfficePic, type PicMedia } from "./officeDrawing";
import { getBlob as defaultGetBlob } from "../core/assets";
import { docComments } from "../core/review";
import { HwpxReview, hwpxReviewRuns } from "./officesurgeon/hwpxReview";
import { commentNeighbours, COMMENTS_CT, COMMENTS_EX_CT, COMMENTS_EX_REL, COMMENTS_REL, docxCommentMarks, docxCommentXml, docxComments, docxFmtRev, docxParaRevs, docxPPrReview, docxRevXml, docxRunOrder, docxWithRPrChange, docxRunRev, docxSettingsTracking, docxTracking, hwpxFieldEnd, hwpxMemo, hwpxMemoBegin, hwpxMemoShapes, MEMO_SHAPE_KEYS, hwpxTextParts, hwpxTrackChanges, hwpxTracking, MC_NS, newParaId, W14_NS, W15_NS, withInserts, type DocxCommentIds, type HwpxRevState } from "./officeReview";

const PT = 96 / 72; // points -> px
/** default page margin (≈ 2 cm) — core/pageSetup DEFAULT_MARGINS; pages with their own margins use Page.margins */
export const A4_MARGIN = DEFAULT_MARGINS.left;

// ───────────────────────── shared model ─────────────────────────

/** A table read from a DOCX/HWPX body (cell paragraphs kept for the flattened paragraph view). */
export interface OfficeTable {
  rows: TableCell[][];
  colWidths: number[];
  headerRow: boolean;
  style: Partial<Pick<TableNode, "fontSize" | "fontFamily" | "color" | "borderColor" | "headerFill" | "rowHeight" | "cellBox" | "wordAlign" | "wordInd">>;
  paras: TextParagraph[];
}

export type OfficeItem = { kind: "p"; p: TextParagraph } | { kind: "table"; table: OfficeTable };

/** Paragraph view of a body: tables flattened to their cell paragraphs. */
const flatten = (items: OfficeItem[]) => items.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras));

export { fontLineRatio };
/** Omniweave lineSpacing → Word w:line (lineRule auto, 240 = single). */
export const wordLine = (lineSpacing: number, family: string | undefined, text = "") => Math.max(1, Math.round((240 * lineSpacing) / fontLineRatio(family, text)));
/** Word w:line (lineRule auto) → Omniweave lineSpacing, rounded to 0.01 so export → import is exact. */
export const fromWordLine = (line: number, family: string | undefined, text = "") => Math.round(((line / 240) * fontLineRatio(family, text)) * 100) / 100;

/**
 * Imported list paragraphs: multi-level ones (`plists`) get their list membership (renumbering writes the marker);
 * the others the one-level role and marker text ("• ", "1. "; numbers are fixed by renumber).
 */
function addMarkers(kinds: Map<TextParagraph, "li" | "oli">, plists?: Map<TextParagraph, ParaList>, defs?: readonly ListDef[]): void {
  for (const [p, l] of plists ?? []) {
    p.list = l;
    if (!/^h[1-6]$/.test(p.role ?? "")) p.role = isBulletLevel(levelOf(resolveDef(l.def, defs), l.level)) ? "li" : "oli";
    kinds.delete(p);
  }
  for (const [p, kind] of kinds) {
    p.role = kind;
    const marker = kind === "li" ? "• " : "1. ";
    // (a run of its own when the first run is a tracked change or under a memo: the marker is not part of it)
    const plain = plainFormat(p.runs[0]);
    if (plain === p.runs[0]) p.runs[0] = { ...p.runs[0], text: marker + p.runs[0].text };
    else p.runs.unshift({ ...plain, text: marker });
  }
}

/** Write the markers of multi-level list paragraphs in place (counters carried in `seed`). */
function renumberListsInPlace(ps: TextParagraph[], defs: readonly ListDef[], seed: ListSeed): ListSeed {
  if (!ps.some((p) => p.list)) return seed;
  const r = renumber(ps, { defs, seed });
  r.paras.forEach((q, i) => {
    if (q !== ps[i]) Object.assign(ps[i], q);
  });
  return r.seed;
}

function renumberItems(items: OfficeItem[], defs: readonly ListDef[] = []): OfficeItem[] {
  // multi-level lists count on through the whole body (tables included), like Word / 한글
  let seed: ListSeed = new Map();
  const seedAt: ListSeed[] = [];
  for (const it of items) {
    seedAt.push(seed);
    if (it.kind === "p") seed = renumberListsInPlace([it.p], defs, seed);
    else for (const row of it.table.rows) for (const c of row) if (c.richText) seed = renumberListsInPlace(c.richText, defs, seed);
  }
  // list markers were added to the cell paragraphs after the cell text was taken: refresh it
  for (const it of items)
    if (it.kind === "table")
      for (const row of it.table.rows)
        for (const c of row)
          if (c.richText) {
            renumberInPlace(c.richText);
            c.text = c.richText.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
          }
  const ps = items.filter((it): it is { kind: "p"; p: TextParagraph } => it.kind === "p").map((it) => it.p);
  if (!ps.some((p) => p.role === "oli" && !p.list)) return items;
  // renumber works on consecutive paragraphs; a table between two lists ends the first list (one-level lists; the
  // multi-level ones get the counters they had there, so their markers stay)
  const out: OfficeItem[] = [];
  let group: TextParagraph[] = [];
  let groupSeed: ListSeed = new Map();
  const flush = () => {
    out.push(...renumber(group, { defs, seed: groupSeed }).paras.map((p) => ({ kind: "p" as const, p })));
    group = [];
  };
  items.forEach((it, i) => {
    if (it.kind === "p") {
      if (!group.length) groupSeed = seedAt[i];
      group.push(it.p);
    } else {
      flush();
      out.push(it);
    }
  });
  flush();
  return out;
}

/** Runs without the first n characters (the list marker). */
function dropChars(runs: TextRun[], n: number): TextRun[] {
  const out: TextRun[] = [];
  let k = n;
  for (const r of runs) {
    if (k <= 0) out.push(r);
    else if (r.text.length <= k) k -= r.text.length;
    else {
      out.push({ ...r, text: r.text.slice(k) });
      k = 0;
    }
  }
  return out.length ? out : [{ ...(runs[0] ?? DEFAULT_RUN), text: "" }];
}

/** Cell text/format from its paragraphs; header-row bold and fills equal to the header fill are implied. */
function cellFrom(ps: TextParagraph[], fill: string | null, tableColor: string): TableCell {
  const text = ps.map((p) => p.runs.map((r) => r.text).join("")).join("\n");
  const runs = ps.flatMap((p) => p.runs).filter((r) => r.text.trim());
  const cell: TableCell = { text };
  if (runs.length && runs.every((r) => r.bold)) cell.bold = true;
  if (runs.length && runs.every((r) => r.italic)) cell.italic = true;
  const color = runs[0]?.color;
  if (color && color.toLowerCase() !== tableColor.toLowerCase() && runs.every((r) => r.color === color)) cell.color = color;
  if (ps[0] && ps[0].align !== "LEFT") cell.align = ps[0].align;
  if (fill) cell.fill = fill;
  if (ps.length) cell.richText = ps;
  return cell;
}

/** Cell paragraphs to write back: the imported ones while the cell text is unchanged. */
const cellRich = (c: TableCell): TextParagraph[] | null =>
  c.richText?.length && c.richText.map((p) => p.runs.map((r) => r.text).join("")).join("\n") === c.text ? c.richText : null;

/** Number consecutive "oli" paragraphs 1., 2., … in place (markers were inserted as "1. "). */
function renumberInPlace(ps: TextParagraph[]) {
  let n = 0;
  for (const p of ps) {
    if (p.role !== "oli" || p.list) {
      n = 0;
      continue;
    }
    n++;
    const m = /^\d+\. /.exec(p.runs[0]?.text ?? "");
    if (m && n > 1) p.runs[0] = { ...p.runs[0], text: `${n}. ` + p.runs[0].text.slice(m[0].length) };
  }
}

function tableFrom(grid: (TableCell | null)[][], colWidths: number[], headerRow: boolean, paras: TextParagraph[], borderColor: string | null): OfficeTable {
  const cols = Math.max(colWidths.length, ...grid.map((r) => r.length), 1);
  const rows = grid.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? { text: "" }));
  const firstRun = paras.flatMap((p) => p.runs).find((r) => r.text.trim());
  const style: OfficeTable["style"] = {};
  if (firstRun) {
    style.fontSize = firstRun.fontSize;
    style.fontFamily = firstRun.fontFamily;
  }
  if (borderColor) style.borderColor = borderColor;
  if (headerRow && rows[0]) {
    const fills = new Set(rows[0].map((c) => c.fill ?? ""));
    if (fills.size === 1 && [...fills][0]) {
      style.headerFill = [...fills][0];
      for (const c of rows[0]) delete c.fill;
    }
    for (const c of rows[0]) delete c.bold; // the header row is drawn bold
  }
  const widths = Array.from({ length: cols }, (_, i) => colWidths[i] || 100);
  return { rows, colWidths: widths, headerRow, style, paras };
}

// ───────────────────────── DOCX import ─────────────────────────

const JC: Record<string, Align> = { left: "LEFT", start: "LEFT", center: "CENTER", right: "RIGHT", end: "RIGHT", both: "JUSTIFY", distribute: "JUSTIFY" };

/** Word w:numFmt ↔ list format (core/lists.ts). Formats without a model number in decimal. */
const DOCX_NUMFMT_IN: Record<string, ListFormat> = {
  decimal: "decimal", decimalZero: "decimalZero", lowerLetter: "lowerLetter", upperLetter: "upperLetter", lowerRoman: "lowerRoman", upperRoman: "upperRoman",
  ganada: "ganada", chosung: "chosung", decimalEnclosedCircle: "circled", decimalEnclosedCircleChinese: "circled", bullet: "bullet", none: "none",
};
const DOCX_NUMFMT_OUT: Record<string, string> = { circled: "decimalEnclosedCircle" };
/** w:numFmt of a list format (formats Word has no name for in decimal). */
export const docxNumFmt = (format: string) => (format === "bullet" ? "bullet" : DOCX_NUMFMT_OUT[format] ?? (DOCX_NUMFMT_IN[format] ? format : "decimal"));
/**
 * Bullet characters Word stores in the Symbol / Wingdings private-use area (U+F0xx) or as a letter of a symbol font
 * ("o" in Courier New), shown as the Unicode character they draw.
 */
const PUA_BULLETS: Record<string, string> = { "": "•", "": "▪", "": "❖", "": "➢", "": "✓", "": "◆", "": "■", "": "●", "": "❑" }; // i18n: keep — symbols
function docxBulletText(text: string, font: string): string {
  if (text.length === 1 && PUA_BULLETS[text]) return PUA_BULLETS[text];
  if (text === "o" && /courier/i.test(font)) return "◦";
  if (text.length === 1 && text.charCodeAt(0) >= 0xf000 && text.charCodeAt(0) <= 0xf0ff) return "•";
  return text;
}
/** A w:abstractNum's levels as a list definition (indents in twips as written). */
function docxListDef(absId: string, lv: Map<number, DocxLevel>): ListDef {
  const levels: ListLevel[] = [];
  for (let i = 0; i < MAX_LEVELS; i++) {
    const l = lv.get(i) ?? lv.get(Math.max(0, ...[...lv.keys()].filter((k) => k < i)));
    if (!l) {
      levels.push({ format: "decimal", text: `%${i + 1}.` });
      continue;
    }
    const format = DOCX_NUMFMT_IN[l.format ?? "decimal"] ?? "decimal";
    const level: ListLevel = { format, text: format === "bullet" ? l.text || "•" : l.text ?? `%${i + 1}.` };
    if (l.start != null && l.start !== 1) level.start = l.start;
    if (l.left || l.hanging) level.indent = { start: { v: l.left, u: "twip" }, first: { v: -l.hanging, u: "twip" } };
    levels.push(level);
  }
  return { id: `docx-a${absId}`, src: absId, levels };
}

interface DocxLevel {
  bullet: boolean;
  left: number;
  hanging: number;
  /** w:numFmt, w:lvlText, w:start (multi-level lists) */
  format?: string;
  text?: string;
  start?: number;
}

export interface DocxCtx {
  defSize: number;
  defFont: string | null;
  defLine: { line: number; rule: string } | null;
  defAfter: number | null;
  /** read as the importer before Office Surgeon model 3 (11 pt default, no theme fonts, sizes to 0.1 px) */
  legacy?: boolean;
  /** theme font of a theme reference (rFonts asciiTheme / eastAsiaTheme …); absent = the importer before theme fonts */
  themeFont?: (ref: string | null | undefined) => string | null;
  /** settings.xml compatibilityMode (Word 2013+ = 15; read with `styles`) */
  compat?: number;
  /** paragraph style id → heading level (1–6) */
  headings: Map<string, number>;
  /** numId → ilvl → level */
  numbering: Map<string, Map<number, DocxLevel>>;
  /** paragraph style id → numPr of the style (list styles such as "List Bullet") */
  styleNum: Map<string, { numId: string; ilvl: number }>;
  /** numId → its w:abstractNumId and w:lvlOverride/w:startOverride per level */
  nums?: Map<string, { abs: string; starts: Map<number, number> }>;
  /** abstractNumId → list definition (core/lists.ts) */
  listDefs?: Map<string, ListDef>;
  /** heading style id → its run size / bold / font from styles.xml (absent: the importer before model 4 guessed them) */
  headingRun?: Map<string, { size?: number; bold?: boolean; font?: string }>;
  /** read fields (PAGE, NUMPAGES …) as field runs: header / footer parts (body text keeps their last value as text) */
  fields?: boolean;
  /**
   * Word's style hierarchy (Office Surgeon model 6): every paragraph and run property read through the paragraph style
   * chain (basedOn), character styles and the document defaults, attribute by attribute, and a run's Latin font kept
   * beside its East Asian one. Absent = the importer before (headings' run styles and pPrDefault spacing only).
   */
  styles?: DocxStyles;
  /**
   * Footnotes and endnotes of the file by w:id (parseDocxFlow): a reference is read as a note run carrying the note's
   * paragraphs, numbered on from `count` in the format of `pr`. Absent = references are left out (the importer before).
   */
  notes?: { foot: Map<string, Element>; end: Map<string, Element>; count: { foot: number; end: number }; pr: NotePr; read: number };
  /**
   * Comments and tracked changes (core/review.ts; Office Surgeon model 9): runs carry the change they are in (deleted
   * and moved-away text read too) and the comments whose range covers them (`open`: the ranges begun and not yet ended,
   * in document order over the paragraphs). Absent = the importer before (deleted text left out, moves read twice).
   */
  review?: { open: Set<string> };
}

/** Style chains of a DOCX (docxContext). Elements are in priority order, the document defaults last. */
export interface DocxStyles {
  /** pPr / rPr of a paragraph style and the styles it is based on ("" or unknown: the default paragraph style) */
  chain(styleId: string): { pPr: Element[]; rPr: Element[] };
  /** rPr of a character style and the styles it is based on */
  char(styleId: string): Element[];
  /** styles.xml defines this style */
  has(styleId: string): boolean;
  /** a table style and the styles it is based on (tblPr of each) */
  table(styleId: string): Element[];
  /** the default paragraph style breaks Hangul at any character (w:wordWrap 0: Word's "한글 단어 잘림 허용") */
  charWrap: boolean;
  /** punctuation may hang past the line end (w:overflowPunct of the default paragraph style; Word's default is on) */
  hangPunct: boolean;
  /** automatic space between Hangul and Latin letters / digits (w:autoSpaceDE / w:autoSpaceDN; on when absent) */
  autoSpace: { alpha: boolean; digit: boolean };
}

/** The field a Word field instruction is (" PAGE  \* MERGEFORMAT " → page), or null for fields without a model. */
export function docxFieldKind(instr: string): FieldKind | null {
  const name = instr.trim().split(/\s+/)[0]?.toUpperCase();
  return name === "PAGE" ? "page" : name === "NUMPAGES" ? "pages" : name === "SECTIONPAGES" ? "secpages" : name === "DATE" ? "date" : name === "FILENAME" ? "file" : null;
}

/** East Asian language (w:lang w:eastAsia) → the theme's a:font script used when its a:ea is empty */
const EA_SCRIPT: [RegExp, string][] = [[/^ko/i, "Hang"], [/^ja/i, "Jpan"], [/^zh-(tw|hk|mo)|^zh-hant/i, "Hant"], [/^zh/i, "Hans"]];

/** The theme's fonts (a:fontScheme): theme reference (minorHAnsi, majorEastAsia …) → typeface, null when none. */
function docxThemeFonts(files: Record<string, Uint8Array>, eaLang: string): (ref: string | null | undefined) => string | null {
  const name = files["word/theme/theme1.xml"] ? "word/theme/theme1.xml" : Object.keys(files).find((n) => /^word\/theme\/[^/]+\.xml$/.test(n));
  if (!name) return () => null;
  const th = parseXml(strFromU8(files[name]));
  const script = EA_SCRIPT.find(([re]) => re.test(eaLang))?.[1] ?? "Hang";
  const scheme = (k: "major" | "minor") => {
    const f = descendants(th, `${k}Font`)[0];
    const face = (n: string) => {
      const e = f && child(f, n);
      return (e && attr(e, "typeface")) || null;
    };
    const byScript = f ? children(f, "font").find((e) => attr(e, "script") === script) : undefined;
    // an empty a:ea: the font of the East Asian language's script (Word on Korean Windows: Hang)
    return { latin: face("latin"), ea: face("ea") || (byScript && attr(byScript, "typeface")) || null };
  };
  const major = scheme("major"), minor = scheme("minor");
  return (ref) => {
    const m = ref ? /^(major|minor)(HAnsi|Ascii|EastAsia|Bidi)$/.exec(ref) : null;
    if (!m) return null;
    const s = m[1] === "major" ? major : minor;
    return m[2] === "EastAsia" ? s.ea : m[2] === "Bidi" ? null : s.latin;
  };
}

/**
 * Font of a w:rFonts: the East Asian font, else the Latin one (a theme reference wins over the name beside it, as in
 * Word). `theme` null = the importer before theme fonts (eastAsia / ascii names only).
 */
function rFontsFamily(rf: Element | undefined | null, theme: ((ref: string | null | undefined) => string | null) | null): string | null {
  if (!rf) return null;
  if (!theme) return attr(rf, "eastAsia") || attr(rf, "ascii") || null;
  const eaRef = attr(rf, "eastAsiaTheme");
  const latinRef = attr(rf, "asciiTheme") || attr(rf, "hAnsiTheme");
  const ea = eaRef ? theme(eaRef) : attr(rf, "eastAsia");
  const latin = latinRef ? theme(latinRef) : attr(rf, "ascii");
  return ea || latin || null;
}

/** Text node settings of an imported body (OfficeLayout wordBreak / cjkSpace). */
export function textOpts(n: TextNode, o?: Pick<OfficeLayout, "wordBreak" | "cjkSpace" | "hangPunct" | "justifyShrink" | "autoSpace" | "lang" | "wordSpacing">) {
  if (o?.wordBreak) n.wordBreak = o.wordBreak;
  if (o?.lang) n.lang = o.lang;
  if (o?.cjkSpace) n.cjkSpace = o.cjkSpace;
  if (o?.hangPunct) n.hangPunct = true;
  if (o?.justifyShrink) n.justifyShrink = true;
  if (o?.autoSpace) n.autoSpace = { ...o.autoSpace };
  if (o?.wordSpacing) n.wordSpacing = o.wordSpacing;
}

/**
 * Word's paragraph spacing of a DOCX (TextNode.wordSpacing): without compat w:doNotUseHTMLParagraphAutoSpacing — every
 * document Word makes — the gap between two paragraphs is the larger of space after and space before ("max", measured
 * on Word 2021 PDFs: after 6 pt + before 12 pt → 12 pt); with it, their sum.
 */
function docxParaSpacing(files: Record<string, Uint8Array>): "max" | "sum" {
  const s = files["word/settings.xml"];
  const e = s ? descendants(parseXml(strFromU8(s)), "doNotUseHTMLParagraphAutoSpacing")[0] : undefined;
  return e && !/^(0|false|off)$/.test(attr(e, "val") ?? "") ? "sum" : "max";
}

/** settings.xml w:compatSetting compatibilityMode (Word 2013+ = 15; none = 12, Word 2007) */
function docxCompatMode(files: Record<string, Uint8Array>): number {
  const s = files["word/settings.xml"];
  if (!s) return 12;
  const e = descendants(parseXml(strFromU8(s)), "compatSetting").find((x) => attr(x, "name") === "compatibilityMode");
  return Number(e && attr(e, "val")) || 12;
}

/** settings.xml w:compat balanceSingleByteDoubleByteWidth (on in Korean Word's documents) */
/** One w:pBdr side (sz in eighths of a point, space in points; nil / none = no line). */
function docxBorderLine(e: Element | null | undefined): ParaBorderLine | undefined {
  if (!e) return undefined;
  const v = attr(e, "val") ?? "single";
  if (/^(nil|none)$/.test(v)) return undefined;
  const style = v === "double" ? "double" : /dash/i.test(v) ? "dashed" : /dot/i.test(v) ? "dotted" : undefined;
  const w = ((Number(attr(e, "sz")) || 4) / 8) * PT * (style === "double" ? 3 : 1);
  const c = attr(e, "color");
  return { w: Math.round(w * 1000) / 1000, color: c && /^[0-9a-f]{6}$/i.test(c) ? "#" + c.toLowerCase() : "#000000", space: Math.round((Number(attr(e, "space")) || 0) * PT * 100) / 100, ...(style ? { style } : {}) };
}

/** w:pBdr → paragraph borders (core/paraBox.ts), or undefined when it draws nothing. */
export function docxPBdr(el: Element | null | undefined): ParaBorders | undefined {
  if (!el) return undefined;
  const out: ParaBorders = {};
  for (const [k, a, b] of [["top", "top", "top"], ["bottom", "bottom", "bottom"], ["left", "left", "start"], ["right", "right", "end"], ["between", "between", "between"]] as const) {
    const l = docxBorderLine(child(el, a) ?? child(el, b));
    if (l) out[k] = l;
  }
  return Object.keys(out).length ? out : undefined;
}

/** w:pBdr of a paragraph's borders (CT_PBdr: top left bottom right between). */
function docxPBdrXml(b: ParaBorders | undefined): string {
  if (!b) return "";
  const side = (n: string, l: ParaBorderLine | undefined) =>
    l ? `<w:${n} w:val="${l.style === "double" ? "double" : l.style === "dashed" ? "dashed" : l.style === "dotted" ? "dotted" : "single"}" w:sz="${Math.max(2, Math.round(((l.style === "double" ? l.w / 3 : l.w) / PT) * 8))}" w:space="${Math.round(l.space / PT)}" w:color="${hex6(l.color)}"/>` : "";
  return `<w:pBdr>${side("top", b.top)}${side("left", b.left)}${side("bottom", b.bottom)}${side("right", b.right)}${side("between", b.between)}</w:pBdr>`;
}

/** Language of the document's Latin text: w:lang w:val of the default run properties (styles.xml docDefaults), for spelling. */
function docxLang(files: Record<string, Uint8Array>): string | null {
  const s = files["word/styles.xml"];
  if (!s) return null;
  const d = descendants(parseXml(strFromU8(s)), "rPrDefault")[0];
  const l = d && descendants(d, "lang")[0];
  const v = l && attr(l, "val");
  return v && /^[a-z]{2,3}(-[A-Za-z0-9]+)*$/.test(v) ? v : null;
}

function docxBalancedSpaces(files: Record<string, Uint8Array>): boolean {
  const s = files["word/settings.xml"];
  if (!s) return false;
  const e = descendants(parseXml(strFromU8(s)), "balanceSingleByteDoubleByteWidth")[0];
  return !!e && !/^(0|false|off)$/.test(attr(e, "val") ?? "");
}

/** Word's Latin font when no w:rFonts of the hierarchy names one (ECMA-376 17.3.2.26 default) */
const WORD_LATIN_DEFAULT = "Times New Roman";

/** Style chains of styles.xml (DocxStyles). */
function docxStyles(st: Document): DocxStyles {
  const byId = new Map<string, Element>();
  let def: Element | undefined;
  for (const s of descendants(st, "style")) {
    byId.set(attr(s, "styleId") ?? "", s);
    if (attr(s, "type") === "paragraph" && /^(1|true|on)$/.test(attr(s, "default") ?? "")) def ??= s;
  }
  const pd = descendants(st, "pPrDefault")[0];
  const rd = descendants(st, "rPrDefault")[0];
  const pDef = pd && child(pd, "pPr");
  const rDef = rd && child(rd, "rPr");
  const walk = (s: Element | undefined, type: string) => {
    const out: Element[] = [];
    const seen = new Set<Element>();
    for (; s && !seen.has(s) && attr(s, "type") === type; ) {
      seen.add(s);
      out.push(s);
      const b = child(s, "basedOn");
      s = b ? byId.get(attr(b, "val") ?? "") : undefined;
    }
    return out;
  };
  const cache = new Map<string, { pPr: Element[]; rPr: Element[] }>();
  const chain = (id: string) => {
    let c = cache.get(id);
    if (!c) {
      const own = byId.get(id);
      const ss = walk(own && attr(own, "type") === "paragraph" ? own : def, "paragraph");
      const pick = (n: string, d: Element | null | undefined) => [...ss.map((s) => child(s, n)), d].filter((e): e is Element => !!e);
      c = { pPr: pick("pPr", pDef), rPr: pick("rPr", rDef) };
      cache.set(id, c);
    }
    return c;
  };
  const char = (id: string) => walk(byId.get(id), "character").map((s) => child(s, "rPr")).filter((e): e is Element => !!e);
  const flag = (n: string) => chain("").pPr.map((p) => child(p, n)).find(Boolean);
  const off = (e: Element | null | undefined) => !!e && /^(0|false|off)$/.test(attr(e, "val") ?? "");
  const table = (id: string) => walk(byId.get(id), "table").map((s) => child(s, "tblPr")).filter((e): e is Element => !!e);
  return { chain, char, table, has: (id) => byId.has(id), charWrap: off(flag("wordWrap")), hangPunct: !off(flag("overflowPunct")), autoSpace: { alpha: !off(flag("autoSpaceDE")), digit: !off(flag("autoSpaceDN")) } };
}

/**
 * Fonts of a run read through the style hierarchy, attribute by attribute (Word): the East Asian font and the Latin
 * one, each from the first w:rFonts that names it (a theme reference wins over the name beside it).
 */
function docxRunFonts(rFonts: (Element | null | undefined)[], theme: ((ref: string | null | undefined) => string | null) | undefined): { ea: string | null; latin: string | null } {
  let ea: string | null | undefined, latin: string | null | undefined;
  for (const rf of rFonts) {
    if (!rf) continue;
    if (ea === undefined) {
      const ref = attr(rf, "eastAsiaTheme");
      if (ref) ea = theme?.(ref) ?? null;
      else if (attr(rf, "eastAsia")) ea = attr(rf, "eastAsia");
    }
    if (latin === undefined) {
      const ref = attr(rf, "asciiTheme") || attr(rf, "hAnsiTheme");
      if (ref) latin = theme?.(ref) ?? null;
      else if (attr(rf, "ascii") || attr(rf, "hAnsi")) latin = attr(rf, "ascii") || attr(rf, "hAnsi");
    }
  }
  return { ea: ea || null, latin: latin || null };
}

/**
 * Word's document defaults and styles. Run defaults as Word draws them: w:sz of docDefaults, then of the default
 * paragraph style (Normal), else 10 pt (Word's size when no w:sz is given anywhere; szCs is the complex-script size);
 * fonts the same way, theme references resolved through the theme. `legacy` = the importer before that (11 pt, theme
 * references and the Normal style ignored), which Office Surgeon maps before model 3 were made with.
 */
export function docxContext(files: Record<string, Uint8Array>, legacy = false, oldHeadings = legacy, oldStyles = oldHeadings): DocxCtx {
  const ctx: DocxCtx = { ...(legacy ? { legacy } : {}), defSize: legacy ? 11 : 10, defFont: null, defLine: null, defAfter: null, headings: new Map(), numbering: new Map(), styleNum: new Map() };
  if (!oldStyles) ctx.styles = { chain: () => ({ pPr: [], rPr: [] }), char: () => [], table: () => [], has: () => false, charWrap: false, hangPunct: true, autoSpace: { alpha: true, digit: true } };
  if (!oldStyles) ctx.compat = docxCompatMode(files);
  if (files["word/styles.xml"]) {
    const st = parseXml(strFromU8(files["word/styles.xml"]));
    if (!oldStyles) ctx.styles = docxStyles(st);
    const rd = descendants(st, "rPrDefault")[0];
    const lang = rd && descendants(rd, "lang")[0];
    const theme = legacy ? null : docxThemeFonts(files, (lang && attr(lang, "eastAsia")) || "ko-KR");
    if (theme) ctx.themeFont = theme;
    const v = rd && descendants(rd, "sz")[0];
    if (v) ctx.defSize = Number(attr(v, "val")) / 2 || ctx.defSize;
    ctx.defFont = rFontsFamily(rd && descendants(rd, "rFonts")[0], theme);
    if (!legacy) {
      // the default paragraph style's run properties apply to every paragraph without a style of its own
      const normal = descendants(st, "style").find((s) => attr(s, "type") === "paragraph" && /^(1|true|on)$/.test(attr(s, "default") ?? ""));
      const nr = normal && child(normal, "rPr");
      const nsz = nr && child(nr, "sz");
      if (nsz) ctx.defSize = Number(attr(nsz, "val")) / 2 || ctx.defSize;
      ctx.defFont = rFontsFamily(nr && child(nr, "rFonts"), theme) ?? ctx.defFont;
    }
    const pd = descendants(st, "pPrDefault")[0];
    const sp = pd && descendants(pd, "spacing")[0];
    if (sp) {
      const line = Number(attr(sp, "line"));
      if (line > 0) ctx.defLine = { line, rule: attr(sp, "lineRule") ?? "auto" };
      const after = Number(attr(sp, "after"));
      if (Number.isFinite(after) && attr(sp, "after") != null) ctx.defAfter = after;
    }
    for (const s of descendants(st, "style")) {
      if (attr(s, "type") !== "paragraph") continue;
      const id = attr(s, "styleId") ?? "";
      const nameEl = child(s, "name");
      const name = (nameEl && attr(nameEl, "val")) || "";
      const pPr = child(s, "pPr");
      const ol = pPr && child(pPr, "outlineLvl");
      const byName = /^heading\s?(\d)$/i.exec(name) ?? /^제목\s?(\d)$/.exec(name); // i18n: keep — Korean Word style name matched in files
      const level = byName ? Number(byName[1]) : ol ? Number(attr(ol, "val")) + 1 : NaN;
      if (level >= 1 && level <= 6) ctx.headings.set(id, level);
      const np = pPr && child(pPr, "numPr");
      const nid = np && child(np, "numId");
      const il = np && child(np, "ilvl");
      if (nid) ctx.styleNum.set(id, { numId: attr(nid, "val") ?? "0", ilvl: il ? Number(attr(il, "val")) || 0 : 0 });
    }
    // heading styles' own run properties (through basedOn): what Word draws a heading run without its own w:sz / w:b
    // with — the importer before model 4 guessed 26 − 3 × level pt and bold instead (Office Surgeon then wrote that)
    if (!oldHeadings) {
      const byId = new Map(descendants(st, "style").filter((s) => attr(s, "type") === "paragraph").map((s) => [attr(s, "styleId") ?? "", s]));
      ctx.headingRun = new Map();
      for (const id of ctx.headings.keys()) {
        const out: { size?: number; bold?: boolean; font?: string } = {};
        const seen = new Set<string>();
        for (let s = byId.get(id); s && !seen.has(attr(s, "styleId") ?? ""); ) {
          seen.add(attr(s, "styleId") ?? "");
          const rp = child(s, "rPr");
          const sz = rp && child(rp, "sz");
          if (out.size === undefined && sz && Number(attr(sz, "val")) > 0) out.size = Number(attr(sz, "val")) / 2;
          const b = rp && child(rp, "b");
          if (out.bold === undefined && b) out.bold = !/^(0|false|off)$/.test(attr(b, "val") ?? "");
          const f = rp && rFontsFamily(child(rp, "rFonts"), ctx.themeFont ?? null);
          if (out.font === undefined && f) out.font = f;
          const based = child(s, "basedOn");
          s = based ? byId.get(attr(based, "val") ?? "") : undefined;
        }
        ctx.headingRun.set(id, out);
      }
    }
  }
  if (files["word/numbering.xml"]) {
    const nd = parseXml(strFromU8(files["word/numbering.xml"]));
    const abstract = new Map<string, Map<number, DocxLevel>>();
    ctx.nums = new Map();
    ctx.listDefs = new Map();
    for (const a of descendants(nd, "abstractNum")) {
      const lv = new Map<number, DocxLevel>();
      for (const l of children(a, "lvl")) {
        const fmt = child(l, "numFmt");
        const ind = descendants(l, "ind")[0];
        const txt = child(l, "lvlText");
        const st = child(l, "start");
        const rf = descendants(l, "rFonts")[0];
        lv.set(Number(attr(l, "ilvl")) || 0, {
          bullet: (fmt && attr(fmt, "val")) === "bullet",
          left: ind ? Number(attr(ind, "left") ?? attr(ind, "start")) || 0 : 0,
          hanging: ind ? Number(attr(ind, "hanging")) || 0 : 0,
          format: (fmt && attr(fmt, "val")) || "decimal",
          // no w:lvlText: Word's default "%n." (a bullet without one draws "•")
          ...(txt && attr(txt, "val") != null ? { text: docxBulletText(attr(txt, "val")!, rf ? attr(rf, "ascii") ?? attr(rf, "hAnsi") ?? "" : "") } : {}),
          ...(st && attr(st, "val") != null ? { start: Number(attr(st, "val")) } : {}),
        });
      }
      const absId = attr(a, "abstractNumId") ?? "";
      abstract.set(absId, lv);
      ctx.listDefs.set(absId, docxListDef(absId, lv));
    }
    // a definition of a list style (w:numStyleLink, no levels of its own): the levels of the definition the style's
    // w:numId names (styles.xml, w:type="numbering") — Word numbers its items so (QA list-format 2026-11-17)
    const absOfNum = new Map(descendants(nd, "num").map((n) => [attr(n, "numId") ?? "", attr(child(n, "abstractNumId") ?? n, "val") ?? ""]));
    const styleNum = new Map<string, string>();
    const sx = files["word/styles.xml"] && descendants(nd, "numStyleLink").length ? parseXml(strFromU8(files["word/styles.xml"])) : null;
    if (sx) for (const s of descendants(sx, "style")) if (attr(s, "type") === "numbering") { const ni = descendants(s, "numId")[0]; if (ni) styleNum.set(attr(s, "styleId") ?? "", attr(ni, "val") ?? ""); }
    for (const a of descendants(nd, "abstractNum")) {
      const link = child(a, "numStyleLink");
      const absId = attr(a, "abstractNumId") ?? "";
      if (!link || abstract.get(absId)?.size) continue;
      const src = absOfNum.get(styleNum.get(attr(link, "val") ?? "") ?? "");
      const lv = src !== undefined && src !== absId ? abstract.get(src) : undefined;
      if (!lv?.size) continue;
      abstract.set(absId, lv);
      ctx.listDefs.set(absId, docxListDef(absId, lv));
    }
    for (const n of descendants(nd, "num")) {
      const an = child(n, "abstractNumId");
      const abs = (an && attr(an, "val")) ?? "";
      const lv = abstract.get(abs);
      const starts = new Map<number, number>();
      for (const o of children(n, "lvlOverride")) {
        const so = child(o, "startOverride");
        if (so && attr(so, "val") != null) starts.set(Number(attr(o, "ilvl")) || 0, Number(attr(so, "val")));
      }
      ctx.nums.set(attr(n, "numId") ?? "", { abs, starts });
      if (lv) ctx.numbering.set(attr(n, "numId") ?? "", lv);
    }
  }
  return ctx;
}

/** Word note number formats (w:numFmt) → note mark formats (others: 1 2 3). */
const DOCX_NOTEFMT: Record<string, NoteNumFormat> = { decimal: "decimal", lowerRoman: "lowerRoman", upperRoman: "upperRoman", lowerLetter: "lowerLetter", upperLetter: "upperLetter", chicago: "symbol", ganada: "ganada" };
export const DOCX_NOTEFMT_OUT: Record<NoteNumFormat, string> = { decimal: "decimal", lowerRoman: "lowerRoman", upperRoman: "upperRoman", lowerLetter: "lowerLetter", upperLetter: "upperLetter", symbol: "chicago", ganada: "ganada", dash: "decimal" };

/**
 * Footnotes and endnotes of a DOCX by w:id, with the document's numbering (word/settings.xml w:footnotePr /
 * w:endnotePr, the last section's overriding) and the separator paragraph Word draws above them.
 */
function docxNotes(files: Record<string, Uint8Array>, ctx: DocxCtx, sectPr: Element | undefined | null): NonNullable<DocxCtx["notes"]> {
  const out: NonNullable<DocxCtx["notes"]> = { foot: new Map(), end: new Map(), count: { foot: 0, end: 0 }, pr: {}, read: 0 };
  const settings = files["word/settings.xml"] && parseXml(strFromU8(files["word/settings.xml"]));
  for (const kind of ["foot", "end"] as const) {
    const part = files[`word/${kind}notes.xml`];
    const pr: NoteKindPr = {};
    const prs = [sectPr && child(sectPr, `${kind}notePr`), settings ? descendants(settings, `${kind}notePr`)[0] : undefined];
    const nf = prs.map((e) => e && child(e, "numFmt")).find(Boolean);
    const fmt = nf ? DOCX_NOTEFMT[attr(nf, "val") ?? ""] ?? "decimal" : undefined;
    if (fmt && fmt !== (kind === "end" ? "lowerRoman" : "decimal")) pr.fmt = fmt;
    else if (kind === "end" && fmt === "lowerRoman") pr.fmt = fmt;
    const ns = prs.map((e) => e && child(e, "numStart")).find(Boolean);
    const start = ns ? Number(attr(ns, "val")) : NaN;
    if (Number.isFinite(start) && start !== 1) pr.start = start;
    // footnote numbers starting again on each page / section (w:numRestart)
    const nr = prs.map((e) => e && child(e, "numRestart")).find(Boolean);
    const rs = nr && attr(nr, "val");
    if (kind === "foot" && (rs === "eachPage" || rs === "eachSect")) pr.restart = rs === "eachPage" ? "page" : "section";
    if (part) {
      const x = parseXml(strFromU8(part));
      for (const el of children(x.documentElement, `${kind}note`)) {
        const type = attr(el, "type");
        if (type === "separator") {
          // the separator paragraph: its height is the room above the notes, the line across its middle
          const sp = children(el, "p")[0];
          if (sp) pr.para = { ...docxParagraph(sp, { ...ctx, notes: undefined }).para, id: `${kind}-sep` };
        } else if (!type || type === "normal") out[kind].set(attr(el, "id") ?? "", el);
      }
    }
    out.pr[kind] = pr;
  }
  return out;
}

/** A note reference run (w:footnoteReference / w:endnoteReference in run `r`): its mark and the note it carries. */
function docxNoteRun(ref: Element, r: Element, rPr: Element | undefined, ctx: DocxCtx, runOf: (rPr: Element | undefined, text: string) => TextRun): TextRun {
  const notes = ctx.notes!;
  notes.read++;
  const kind = ref.localName === "footnoteReference" ? "foot" : "end";
  const id = attr(ref, "id") ?? "";
  const custom = /^(1|true|on)$/.test(attr(ref, "customMarkFollows") ?? "");
  let mark = "";
  if (custom) {
    for (const c of children(r)) if (c.localName === "t") mark += textOf(c);
  } else {
    const pr = notes.pr[kind];
    mark = noteMarkText((pr?.start ?? 1) + notes.count[kind], kind, pr);
    notes.count[kind]++;
  }
  const el = notes[kind].get(id);
  const inner: DocxCtx = { ...ctx, notes: undefined };
  const paras = el ? children(el, "p").map((q) => docxParagraph(q, inner).para) : [];
  const note: NoteRef = { kind, paras: paras.length ? paras : [{ ...newParagraph(""), runs: [{ ...runOf(rPr, mark), noteMark: true }] }], src: id };
  if (custom) note.custom = true;
  return { ...runOf(rPr, mark || " "), note };
}

/**
 * One w:p → paragraph, plus its list kind (null = not a list item). `runFmts` (Office Surgeon) receives the run
 * read from each descendant w:r in document order, null for runs without text.
 */
export function docxParagraph(
  p: Element,
  ctx: DocxCtx,
  runFmts?: (TextRun | null)[],
): { para: TextParagraph; list: "li" | "oli" | null; plist?: ParaList; pageBreak?: "before" | "after" | "only" } {
  const pPr = child(p, "pPr");
  const pStyle = pPr && child(pPr, "pStyle");
  const styleName = (pStyle && attr(pStyle, "val")) || "";
  // model 6 (ctx.styles): each property from the paragraph, else its style chain, else the document defaults
  const S = ctx.styles;
  const sc = S?.chain(styleName);
  const pEls = (n: string): Element[] => [pPr && child(pPr, n), ...(sc ? sc.pPr.map((e) => child(e, n)) : [])].filter((e): e is Element => !!e);
  const pGet = (n: string) => (S ? pEls(n)[0] : pPr && child(pPr, n));
  const pAttr = (n: string, a: string) => (S ? pEls(n).find((e) => attr(e, a) != null) : undefined);
  const onOff = (n: string) => {
    const e = pGet(n);
    return !!e && !/^(0|false|off)$/.test(attr(e, "val") ?? "");
  };
  // page breaks (w:br type=page, pPr pageBreakBefore): a break before any text starts a new page before the
  // paragraph, a later one after it (there is no in-paragraph page break in the model); a paragraph holding nothing
  // but the break (Word's Ctrl+Enter) is only the break
  let brBefore = onOff("pageBreakBefore");
  let brAfter = false, brRun = false;
  const jc = pGet("jc");
  const align = JC[(jc && attr(jc, "val")) || "left"] ?? "LEFT";
  const spacing = S ? pAttr("spacing", "line") : pPr && child(pPr, "spacing");
  const lineAttr = spacing && attr(spacing, "line");
  const afterEl = S ? pAttr("spacing", "after") : spacing;
  // (model 6: no w:after anywhere is Word's 0; the importer before used 6 px)
  const after = afterEl && attr(afterEl, "after") != null ? Number(attr(afterEl, "after")) : S ? 0 : ctx.defAfter ?? NaN;
  const ind = pPr && child(pPr, "ind");
  const legacy = /^(Heading|제목)\s?(\d)/i.exec(styleName); // i18n: keep — Korean Word style name matched in files
  const ol = pPr && child(pPr, "outlineLvl");
  const level = ctx.headings.get(styleName) ?? (legacy ? Number(legacy[2]) : ol ? Number(attr(ol, "val")) + 1 : NaN);
  const heading = level >= 1 && level <= 6 ? level : 0;
  const runs: TextRun[] = [];
  let fmtRun: TextRun | null = null;
  const runOf = (rPr: Element | undefined, text: string): TextRun => {
    // model 6: the run's own property, else its character style's, else the paragraph style chain's / defaults'
    const rs = S && rPr ? child(rPr, "rStyle") : null;
    const cc = rs ? S!.char(attr(rs, "val") ?? "") : [];
    const rEls = (n: string): Element[] => [rPr && child(rPr, n), ...cc.map((e) => child(e, n)), ...(sc ? sc.rPr.map((e) => child(e, n)) : [])].filter((e): e is Element => !!e);
    const get = (n: string) => (S ? rEls(n)[0] : rPr && child(rPr, n));
    const sz = get("sz");
    const color = get("color");
    const fonts = rPr && child(rPr, "rFonts");
    const on = (name: string) => {
      const e = get(name);
      return !!e && attr(e, "val") !== "0" && attr(e, "val") !== "false";
    };
    // a heading style of styles.xml gives what the run does not say (Word); a heading without one: the old guess
    const hs = heading && !S ? ctx.headingRun?.get(styleName) : undefined;
    // (a heading style styles.xml does not define: the old guess, 26 − 3 × level pt bold)
    const guess = !!S && !!heading && !S.has(styleName);
    const size = sz ? Number(attr(sz, "val")) / 2 : guess ? Math.max(ctx.defSize, 26 - heading * 3) : S ? 10 : hs ? hs.size ?? ctx.defSize : heading ? Math.max(ctx.defSize, 26 - heading * 3) : ctx.defSize;
    const c = color && attr(color, "val");
    // model 6: East Asian and Latin fonts each through the hierarchy; with none anywhere Word's own defaults
    const rf = S ? docxRunFonts(rEls("rFonts"), ctx.themeFont) : null;
    const u = get("u");
    const run: TextRun = {
      ...DEFAULT_RUN,
      text,
      // 0.01 px (10 pt = 13.33 px: Word's line pitch within 0.01 pt); the importer before model 3 rounded to 0.1 px
      fontSize: ctx.legacy ? Math.round(size * PT * 10) / 10 : Math.round(size * PT * 100) / 100,
      bold: S ? on("b") || (guess && !get("b")) : hs ? (rPr && child(rPr, "b") ? on("b") : !!hs.bold) : on("b") || !!heading,
      italic: on("i"),
      underline: !!(u && attr(u, "val") !== "none"),
      color: c && /^[0-9a-f]{6}$/i.test(c) ? "#" + c : DEFAULT_RUN.color,
      fontFamily: rf ? rf.ea || rf.latin || WORD_LATIN_DEFAULT : rFontsFamily(fonts, ctx.themeFont ?? null) || hs?.font || ctx.defFont || DEFAULT_RUN.fontFamily,
    };
    if (rf) {
      const latin = rf.latin || (rf.ea ? WORD_LATIN_DEFAULT : null);
      if (latin && latin !== run.fontFamily) run.latinFont = latin;
    }
    if (on("strike") || on("dstrike")) run.strike = true;
    const va = get("vertAlign");
    const vav = va && attr(va, "val");
    if (vav === "superscript") run.script = "super";
    else if (vav === "subscript") run.script = "sub";
    const hl = get("highlight");
    const shd = get("shd");
    const fill = shd && attr(shd, "fill");
    const hlv = hl && attr(hl, "val");
    if (hlv && HIGHLIGHT[hlv]) run.highlight = HIGHLIGHT[hlv];
    else if (fill && /^[0-9a-f]{6}$/i.test(fill)) run.highlight = "#" + fill.toUpperCase();
    const csp = get("spacing");
    const cspv = csp ? Number(attr(csp, "val")) : NaN; // twentieths of a point
    if (Number.isFinite(cspv) && cspv) run.letterSpacing = Math.round((cspv / 20) * PT * 100) / 100;
    const ww = get("w");
    const wv = ww ? Number(attr(ww, "val")) : NaN; // 장평 / character scale, percent
    if (Number.isFinite(wv) && wv > 0 && wv !== 100) run.hscale = wv;
    return run;
  };
  // fields (ctx.fields): complex fields (fldChar begin … instrText … separate … result … end) and w:fldSimple become
  // one field run with the result as its text; fields without a model stay their result text
  let fld = null as { instr: string; result: boolean; run: TextRun | null } | null;
  let simple = null as { el: Element; run: TextRun } | null;
  // comments and tracked changes (ctx.review): the runs one w:r gave get its change and the comments open there
  const review = ctx.review;
  let tagFrom = 0;
  let tag: Pick<TextRun, "rev" | "fmtRev" | "comments"> = {};
  const tagRuns = () => {
    for (let i = tagFrom; i < runs.length; i++) Object.assign(runs[i], tag);
    tagFrom = runs.length;
  };
  for (const r of review ? docxRunOrder(p) : descendants(p, "r")) {
    if (review) {
      tagRuns();
      if (r.localName !== "r") {
        const id = attr(r, "id") ?? "";
        if (r.localName === "commentRangeStart") review.open.add(id);
        else review.open.delete(id);
        continue;
      }
      tag = {};
      const rev = docxRunRev(r, p);
      const fmtRev = docxFmtRev(child(r, "rPr"));
      if (rev) tag.rev = rev;
      if (fmtRev) tag.fmtRev = fmtRev;
      if (review.open.size) tag.comments = [...review.open];
    }
    const rPr = child(r, "rPr");
    let text = "";
    // a footnote / endnote reference: a run showing the note's mark, carrying the note (core/notes.ts)
    const ref = ctx.notes && children(r).find((c) => c.localName === "footnoteReference" || c.localName === "endnoteReference");
    if (ref && ctx.notes) {
      const run = docxNoteRun(ref, r, rPr, ctx, runOf);
      runs.push(run);
      runFmts?.push(run);
      continue;
    }
    // the note's own mark at the start of its text (w:footnoteRef / w:endnoteRef)
    if (children(r).some((c) => c.localName === "footnoteRef" || c.localName === "endnoteRef")) {
      runs.push({ ...runOf(rPr, "1"), noteMark: true });
      runFmts?.push(runs[runs.length - 1]);
      continue;
    }
    if (ctx.fields) {
      for (const c of children(r)) {
        if (c.localName === "fldChar") {
          const ty = attr(c, "fldCharType");
          if (ty === "begin") fld = { instr: "", result: false, run: null };
          else if (ty === "separate" && fld) fld.result = true;
          else if (ty === "end" && fld) {
            const kind = docxFieldKind(fld.instr);
            // a field without a shown result: its value is filled in when drawn
            if (kind && !fld.run) runs.push({ ...runOf(rPr, ""), text: kind === "page" ? "1" : " ", field: kind, ...(kind === "date" ? { fieldCode: fld.instr } : {}) });
            fld = null;
          }
        } else if (c.localName === "instrText" && fld && !fld.result) fld.instr += textOf(c);
      }
      const kind = fld?.result ? docxFieldKind(fld.instr) : null;
      const parent = r.parentNode as Element | null;
      const sKind = parent?.localName === "fldSimple" ? docxFieldKind(attr(parent, "instr") ?? "") : null;
      if (kind || sKind) {
        let t = "";
        for (const c of children(r)) if (c.localName === "t") t += textOf(c);
        if (!t) continue;
        if (kind && fld) {
          if (fld.run) fld.run.text += t;
          else runs.push((fld.run = { ...runOf(rPr, t), field: kind, ...(kind === "date" ? { fieldCode: fld.instr } : {}) }));
        } else if (sKind && parent) {
          if (simple?.el === parent) simple.run.text += t;
          else {
            simple = { el: parent, run: { ...runOf(rPr, t), field: sKind, ...(sKind === "date" ? { fieldCode: attr(parent, "instr") ?? "" } : {}) } };
            runs.push(simple.run);
          }
        }
        continue;
      }
    }
    for (const c of children(r)) {
      const ln = c.localName;
      if (ln === "t" || (ln === "delText" && review)) text += textOf(c);
      else if (ln === "tab") text += "\t";
      // a text-wrapping break is a line break inside the paragraph ("\n", written back as <w:br/>);
      // a page break moves the page boundary (above); a column break has no model and stays a space
      else if (ln === "br") {
        const type = attr(c, "type") ?? "textWrapping";
        if (type === "page") {
          brRun = true;
          if (runs.some((x) => x.text) || text) brAfter = true;
          else brBefore = true;
        } else text += type === "textWrapping" ? "\n" : " ";
      }
    }
    if (!text) {
      fmtRun ??= runOf(rPr, "");
      runFmts?.push(null);
      continue;
    }
    runs.push(runOf(rPr, text));
    runFmts?.push(runs[runs.length - 1]);
  }
  if (review) tagRuns();
  if (!runs.length) {
    const mark = pPr && child(pPr, "rPr");
    runs.push(fmtRun ?? runOf(mark, ""));
  }
  const font = runs[0].fontFamily;
  const ptext = runs.map((r) => r.text).join("");
  const sizePt = runs[0].fontSize / PT;
  // w:spacing line: auto = 240ths of the font's line height; exact / atLeast = twips
  const line = lineAttr != null ? { line: Number(lineAttr), rule: (spacing && attr(spacing, "lineRule")) || "auto" } : (S ? null : ctx.defLine) ?? { line: 240, rule: "auto" };
  const lineSpacing =
    !(line.line > 0) ? fromWordLine(240, font, ptext) : line.rule === "auto" ? fromWordLine(line.line, font, ptext) : Math.round((line.line / 20 / (sizePt || 12)) * 100) / 100;
  // exact / at-least line heights are twips: kept as such (lineSpacing above is the nearest multiple)
  // (at least: Word's natural line is the font's single line — basis "font"; the legacy importer had none)
  const lineHeight: ParaLineHeight | undefined =
    line.line > 0 && line.rule !== "auto" ? (line.rule === "exact" ? { mode: "exact", v: { v: line.line, u: "twip" } } : { mode: "atLeast", v: { v: line.line, u: "twip" }, ...(ctx.legacy ? {} : { basis: "font" as const }) }) : undefined;
  const beforeEl = S ? pAttr("spacing", "before") : spacing;
  const beforeAttr = beforeEl && attr(beforeEl, "before");
  const before = beforeAttr != null && !(beforeEl && /^(1|true|on)$/.test(attr(beforeEl, "beforeAutospacing") ?? "")) ? Number(beforeAttr) : NaN;
  // list membership (direct numPr, else the paragraph style's)
  const numPr = pPr && child(pPr, "numPr");
  const numIdEl = numPr && child(numPr, "numId");
  const ilvlEl = numPr && child(numPr, "ilvl");
  const num = numIdEl ? { numId: attr(numIdEl, "val") ?? "0", ilvl: Number(ilvlEl && attr(ilvlEl, "val")) || 0 } : ctx.styleNum.get(styleName) ?? null;
  const lvl = num && num.numId !== "0" ? ctx.numbering.get(num.numId)?.get(num.ilvl) ?? ctx.numbering.get(num.numId)?.get(0) ?? null : null;
  const list = num && num.numId !== "0" ? (lvl ? (lvl.bullet ? "li" : "oli") : "li") : null;
  // multi-level membership: the w:num instance counts, the w:abstractNum defines the levels
  const info = num && num.numId !== "0" ? ctx.nums?.get(num.numId) : undefined;
  const plist: ParaList | undefined =
    info && ctx.listDefs?.has(info.abs) ? { id: `docx-n${num!.numId}`, def: `docx-a${info.abs}`, level: Math.max(0, Math.min(MAX_LEVELS - 1, num!.ilvl)) } : undefined;
  // indent: the paragraph's own w:ind, else the list level's
  // (model 6: an attribute the paragraph does not give comes from its style chain, unless the list level gives the indent)
  const fromLevel = !!lvl && !ind;
  const indAttr = (n: string) => {
    if (ind && attr(ind, n) != null) return attr(ind, n);
    if (!S || fromLevel) return null;
    const e = pAttr("ind", n);
    return e ? attr(e, n) : null;
  };
  // the first line: hanging or firstLine of the first element that gives either
  const firstEl = S && !fromLevel ? pEls("ind").find((e) => attr(e, "hanging") != null || attr(e, "firstLine") != null) : ind;
  const hanging = firstEl && attr(firstEl, "hanging") != null ? Number(attr(firstEl, "hanging")) : NaN;
  const firstLine = Number.isFinite(hanging) ? -hanging : firstEl && attr(firstEl, "firstLine") != null ? Number(attr(firstEl, "firstLine")) : NaN;
  const leftRaw = indAttr("left") ?? indAttr("start");
  let leftInd = leftRaw != null ? Number(leftRaw) : NaN;
  let first = firstLine;
  if (!ind && lvl) {
    leftInd = lvl.left;
    first = -lvl.hanging;
  } else if (S && lvl && ind) {
    // Word's order: the paragraph's own w:ind, then the list level's, then the style's — an attribute the paragraph does
    // not give (w:ind w:leftChars="0" only) comes from the level (measured: omni-fid-cambria, bullet in the hanging indent)
    const own = (n: string) => attr(ind, n) != null;
    if (!own("left") && !own("start")) leftInd = lvl.left;
    if (!own("hanging") && !own("firstLine")) first = -lvl.hanging;
  }
  const para: TextParagraph = {
    id: uid("p"),
    runs,
    align,
    lineSpacing,
    indent: Number.isFinite(first) ? (first / 20) * PT : 0,
    spaceAfter: Number.isFinite(after) ? (after / 20) * PT : 6,
  };
  if (Number.isFinite(leftInd) && leftInd) para.indentLeft = Math.round((leftInd / 20) * PT * 100) / 100;
  const rightRaw = indAttr("right") ?? indAttr("end");
  const right = rightRaw != null ? Number(rightRaw) : NaN;
  if (Number.isFinite(right) && right) para.indentRight = (right / 20) * PT;
  if (Number.isFinite(before) && before) para.spaceBefore = (before / 20) * PT;
  if (lineHeight) para.lineHeight = lineHeight;
  // Word's multiple as Word means it (core/lineSpacing.ts); lineSpacing above is the same height for older readers
  else para.lineMultiple = { v: (line.line > 0 ? line.line : 240) / 240, lineSpacing };
  if (onOff("keepNext")) para.keepNext = true;
  if (onOff("keepLines")) para.keepLines = true;
  if (onOff("pageBreakBefore")) para.pageBreakBefore = true;
  // paragraph borders and shading (w:pBdr, pPr w:shd; model 6: through the style chain)
  if (!ctx.legacy) {
    const bdr = docxPBdr(pGet("pBdr"));
    if (bdr) para.border = bdr;
    const shd = pGet("shd");
    const fill = shd && attr(shd, "fill");
    if (fill && /^[0-9a-f]{6}$/i.test(fill)) para.shade = "#" + fill.toLowerCase();
  }
  // widow / orphan control: on unless the paragraph or its style chain turns it off (Korean Word's Normal style does)
  if (S && pGet("widowControl") && !onOff("widowControl")) para.widowControl = false;
  if (heading) para.role = `h${heading}` as TextParagraph["role"];
  if (review) Object.assign(para, docxParaRevs(pPr));
  const pageBreak = brRun && !ptext ? "only" : brBefore ? "before" : brAfter ? "after" : undefined;
  // a numbered heading (heading styles linked to a list): outline numbering
  if (heading && plist) ctx.listDefs?.get(info!.abs) && (ctx.listDefs.get(info!.abs)!.outline = true);
  return { para, list: heading ? null : list, ...(plist && (list || heading) ? { plist } : {}), ...(pageBreak ? { pageBreak } : {}) };
}

export function docxTable(tbl: Element, ctx: DocxCtx, kinds: Map<TextParagraph, "li" | "oli">, plists?: Map<TextParagraph, ParaList>): OfficeTable {
  const twPx = (tw: number) => Math.round((tw / 20) * PT * 100) / 100;
  const gridEl = child(tbl, "tblGrid");
  const colWidths = gridEl ? children(gridEl, "gridCol").map((g) => twPx(Number(attr(g, "w")) || 0)) : [];
  const tblPr = child(tbl, "tblPr");
  const bTop = tblPr && descendants(tblPr, "top")[0];
  let bc = bTop && attr(bTop, "color");
  // model 6: borders of the table style too ("Table Grid": single, auto = black, as Word draws them)
  if (ctx.styles && !(bc && /^[0-9a-f]{6}$/i.test(bc))) {
    const ts = tblPr && child(tblPr, "tblStyle");
    const b = [tblPr, ...ctx.styles.table((ts && attr(ts, "val")) || "")].map((e) => e && child(e, "tblBorders")).find(Boolean);
    const top = b && (child(b, "top") ?? child(b, "insideH"));
    if (top && !/^(nil|none)$/.test(attr(top, "val") ?? "")) bc = /^[0-9a-f]{6}$/i.test(attr(top, "color") ?? "") ? attr(top, "color") : "000000";
  }
  const grid: (TableCell | null)[][] = [];
  const covered: boolean[][] = [];
  const paras: TextParagraph[] = [];
  let headerRow = false;
  children(tbl, "tr").forEach((tr, ri) => {
    const trPr = child(tr, "trPr");
    if (ri === 0 && trPr && child(trPr, "tblHeader") && attr(child(trPr, "tblHeader")!, "val") !== "0") headerRow = true;
    const gb = trPr && child(trPr, "gridBefore");
    let c = gb ? Number(attr(gb, "val")) || 0 : 0;
    const row: (TableCell | null)[] = (grid[ri] = []);
    covered[ri] = [];
    for (const tc of children(tr, "tc")) {
      const tcPr = child(tc, "tcPr");
      const gs = tcPr && child(tcPr, "gridSpan");
      const span = Math.max(1, (gs && Number(attr(gs, "val"))) || 1);
      const vm = tcPr && child(tcPr, "vMerge");
      const vmv = vm ? attr(vm, "val") ?? "continue" : null;
      const ps: TextParagraph[] = [];
      for (const p of descendants(tc, "p")) {
        const { para, list, plist } = docxParagraph(p, ctx);
        if (list) kinds.set(para, list);
        if (plist) plists?.set(para, plist);
        ps.push(para);
      }
      paras.push(...ps);
      if (vmv === "continue" && ri > 0) {
        // continue the merged range from the row above
        let r = ri - 1;
        while (r > 0 && covered[r]?.[c]) r--;
        const anchor = grid[r]?.[c];
        if (anchor) anchor.rowSpan = (anchor.rowSpan ?? 1) + 1;
        for (let j = 0; j < span; j++) {
          row[c + j] = { text: "" };
          covered[ri][c + j] = true;
        }
        c += span;
        continue;
      }
      const shd = tcPr && child(tcPr, "shd");
      const fill = shd && attr(shd, "fill");
      const cell = cellFrom(ps, fill && /^[0-9a-f]{6}$/i.test(fill) ? "#" + fill.toUpperCase() : null, DEFAULT_TABLE_COLOR);
      if (span > 1) cell.colSpan = span;
      // Word cells: content centred / at the bottom (w:vAlign), the row's own height (w:trHeight, at least)
      const va = tcPr && child(tcPr, "vAlign");
      const vav = va && attr(va, "val");
      if (vav === "center") cell.vAlign = "middle";
      else if (vav === "bottom") cell.vAlign = "bottom";
      const th = trPr && child(trPr, "trHeight");
      if (th && Number(attr(th, "val")) > 0) cell.minHeight = twPx(Number(attr(th, "val")));
      row[c] = cell;
      for (let j = 1; j < span; j++) {
        row[c + j] = { text: "" };
        covered[ri][c + j] = true;
      }
      c += span;
    }
  });
  const t = tableFrom(grid, colWidths, headerRow, paras, bc && /^[0-9a-f]{6}$/i.test(bc) ? "#" + bc.toLowerCase() : null);
  if (ctx.styles) {
    // model 6: a row as tall as Word's one-line cell (its paragraph's line, space before and after), and no header
    // shading Word does not draw
    const p = paras.find((q) => q.runs.some((r) => r.text.trim())) ?? paras[0];
    if (p) {
      const line = lineHeightOf(p, Math.max(...p.runs.map((r) => r.fontSize)), { runs: p.runs, text: p.runs.map((r) => r.text).join("") });
      t.style.rowHeight = Math.round((line + (p.spaceBefore ?? 0) + p.spaceAfter) * 100) / 100;
    }
    if (headerRow && !t.style.headerFill) t.style.headerFill = "#ffffff";
    t.style.cellBox = docxCellBox(tblPr, ctx);
    const align = docxTableAlign(tbl, tblPr, ctx);
    if (align) t.style.wordAlign = align;
    else {
      const ind = docxTableIndent(tbl, tblPr, ctx);
      if (ind) t.style.wordInd = ind;
    }
  }
  return t;
}

/**
 * Word's table alignment (TableNode.wordAlign): w:jc of the table (else of its style) — center or right (end) — with
 * the width of the table's outer left border (the first row's first cell w:tcBorders, else the table's or its style's
 * w:tblBorders; sz in eighths of a point), half of which Word counts when it places the table.
 */
function docxTableAlign(tbl: Element, tblPr: Element | null | undefined, ctx: DocxCtx): TableNode["wordAlign"] | undefined {
  const ts = tblPr && child(tblPr, "tblStyle");
  const chain = [tblPr, ...(ctx.styles?.table((ts && attr(ts, "val")) || "") ?? [])].filter((e): e is Element => !!e);
  const jcEl = chain.map((e) => child(e, "jc")).find(Boolean);
  const v = jcEl && attr(jcEl, "val");
  const jc = v === "center" ? "center" : v === "right" || v === "end" ? "right" : null;
  if (!jc) return undefined;
  return { jc, left: docxTableLeftBorder(tbl, chain) };
}

/** Width (px) of a Word table's outer left border: the first row's first cell w:tcBorders, else the table's or its style's w:tblBorders. */
function docxTableLeftBorder(tbl: Element, chain: Element[]): number {
  const width = (b: Element | null | undefined): number | null => {
    if (!b) return null;
    if (/^(nil|none)$/.test(attr(b, "val") ?? "")) return 0;
    return ((Number(attr(b, "sz")) || 0) / 8) * PT;
  };
  const row = child(tbl, "tr");
  const cells = row ? children(row, "tc") : [];
  const cellSide = (tc: Element | undefined, side: string[]) => {
    const bs = tc && child(child(tc, "tcPr") ?? tc, "tcBorders");
    return bs ? side.map((s) => child(bs, s)).find(Boolean) : undefined;
  };
  const tableSide = (side: string[]) => chain.map((e) => child(e, "tblBorders")).filter((b): b is Element => !!b).map((b) => side.map((s) => child(b, s)).find(Boolean)).find(Boolean);
  const edge = (tc: Element | undefined, side: string[]) => Math.round((width(cellSide(tc, side)) ?? width(tableSide(side)) ?? 0) * 100) / 100;
  return edge(cells[0], ["left", "start"]);
}

/**
 * Word's left-aligned table (TableNode.wordInd, px): w:tblInd of the table (else of its style), in compatibility mode
 * 14 and before less the left cell margin (Word 2010 sets the first cell's text at the indent — Word PDFs: text at the
 * margin with no w:tblInd in mode 14, cell edge at the margin in mode 15). Only twips (dxa) are read.
 */
function docxTableIndent(tbl: Element, tblPr: Element | null | undefined, ctx: DocxCtx): number {
  const twPx = (tw: number) => Math.round((tw / 20) * PT * 100) / 100;
  const ts = tblPr && child(tblPr, "tblStyle");
  const chain = [tblPr, ...(ctx.styles?.table((ts && attr(ts, "val")) || "") ?? [])].filter((e): e is Element => !!e);
  const dxa = (e: Element | null | undefined) => {
    const w = e && Number(attr(e, "w"));
    return e && Number.isFinite(w) && (attr(e, "type") ?? "dxa") === "dxa" ? (w as number) : null;
  };
  // (QA docx-flow: a right-to-left table — w:bidiVisual — measures w:tblInd from the right margin, which the table model
  // does not place: it stays at the left edge as before rather than being pushed the wrong way)
  if (chain.some((e) => child(e, "bidiVisual"))) return 0;
  // (Word's indent range is ±22 inches = ±31680 twips; a larger value in a damaged file is held there)
  const ind = Math.max(-31680, Math.min(31680, chain.map((e) => dxa(child(e, "tblInd"))).find((v) => v !== null) ?? 0));
  const old = (ctx.compat ?? 15) < 15;
  const left = old ? chain.map((e) => child(e, "tblCellMar")).map((m) => m && dxa(child(m, "left") ?? child(m, "start"))).find((v) => v != null) ?? 108 : 0;
  // (QA docx-flow: from mode 15 Word measures w:tblInd to the middle of the outer left border, as it does for centred /
  // right tables (wordAlign.left) — Word 2021 PDFs: the first cell's text 0.27 pt right of the cell edge at the indent
  // with ½ pt borders, w:tblInd 0, −5, 720 and −360 twips alike; the −5 twips table of omni-fid-spacing-top at the margin)
  const half = old ? 0 : docxTableLeftBorder(tbl, chain) / 2;
  return Math.round((twPx(ind - left) + half) * 100) / 100;
}

/**
 * Word's cell margins and border of a table (model 6): w:tblCellMar of the table, else of its style, else Word's
 * defaults (left / right 0.08 inch = 108 twips, top / bottom 0); the horizontal border width (w:insideH, else w:top,
 * sz in eighths of a point; none = 0). Cells are drawn from their own paragraphs (TableCell.richText) inside them.
 */
function docxCellBox(tblPr: Element | null | undefined, ctx: DocxCtx): NonNullable<TableNode["cellBox"]> {
  const twPx = (tw: number) => Math.round((tw / 20) * PT * 100) / 100;
  const ts = tblPr && child(tblPr, "tblStyle");
  const chain = [tblPr, ...(ctx.styles?.table((ts && attr(ts, "val")) || "") ?? [])].filter((e): e is Element => !!e);
  const mar = (side: string, alt: string, d: number) => {
    for (const e of chain) {
      const m = child(e, "tblCellMar");
      const s = m && (child(m, side) ?? child(m, alt));
      const w = s && Number(attr(s, "w"));
      if (s && Number.isFinite(w) && (attr(s, "type") ?? "dxa") === "dxa") return w as number;
    }
    return d;
  };
  const brd = (() => {
    for (const e of chain) {
      const b = child(e, "tblBorders");
      const l = b && (child(b, "insideH") ?? child(b, "top"));
      if (!l) continue;
      if (/^(nil|none)$/.test(attr(l, "val") ?? "")) return 0;
      return ((Number(attr(l, "sz")) || 4) / 8) * PT;
    }
    return 0;
  })();
  return {
    padX: twPx((mar("left", "start", 108) + mar("right", "end", 108)) / 2),
    padY: twPx((mar("top", "top", 0) + mar("bottom", "bottom", 0)) / 2),
    word: { border: Math.round(brd * 1000) / 1000 },
  };
}

const DEFAULT_TABLE_COLOR = "#1d1f24";

/**
 * Page layout of a word-processor body: item indices where a hard page break stands, and the sections (first item,
 * paper size and margins). Pages are made from it by io/formats/flow.ts officePages.
 */
export interface OfficeLayout {
  /** item index before which a page break stands (never 0) */
  pageBreaks: number[];
  /** line breaking of the body text (DOCX w:wordWrap 0 in the default paragraph style: Hangul breaks at any character) */
  wordBreak?: TextNode["wordBreak"];
  /** spaces in East Asian fonts half the size wide (DOCX compat balanceSingleByteDoubleByteWidth; TextNode.cjkSpace) */
  cjkSpace?: TextNode["cjkSpace"];
  /** TextNode.lang: the Latin-text language for spelling (DOCX docDefaults w:lang) */
  lang?: string;
  /** TextNode.hangPunct (DOCX w:overflowPunct of the default paragraph style, on unless turned off) */
  hangPunct?: boolean;
  /** TextNode.justifyShrink (DOCX compatibilityMode 15: Word 2013+ layout) */
  justifyShrink?: boolean;
  /** TextNode.autoSpace (DOCX w:autoSpaceDE / w:autoSpaceDN of the default paragraph style; on when absent) */
  autoSpace?: TextNode["autoSpace"];
  /** TextNode.wordSpacing (DOCX: "sum" with compat w:doNotUseHTMLParagraphAutoSpacing, else "max") */
  wordSpacing?: TextNode["wordSpacing"];
  /**
   * Page breaking the file's own program does (core/flow.ts): "word" = Word's (paragraphs cut at page ends, widow /
   * orphan control, keep with next); absent = whole paragraphs as paginate() places them.
   */
  pageRules?: "word" | "hwp";
  /** note numbering and separators (DOCX settings / sectPr, HWPX footNotePr / endNotePr); on the first page */
  notePr?: NotePr;
  /** comments of the document (core/review.ts); on the first page */
  comments?: DocComment[];
  /** changes are recorded (DOCX w:trackRevisions, HWPX trackchageConfig); on the first page */
  trackChanges?: true;
  /** sections in order; the first starts at 0. `src`: which settings element of the file holds the setup (DOCX w:sectPr / HWPX hp:secPr in document order) */
  sections: {
    start: number;
    setup: PageSetup;
    src?: number;
    /** headers, footers and numbering of the section (core/headerFooter.ts) */
    hf?: SectionHF;
    /** HWPX: the item a header / footer control is in (한글 shows it from that page on) */
    hfAt?: { header?: number; footer?: number };
    /** HWPX: the header / footer of the section start when another follows further down (the first page's) */
    hfEarly?: { header?: TextParagraph[]; footer?: TextParagraph[] };
    /** HWPX: header / footer hidden on the section's first page (hp:visibility, hp:pageHiding) */
    hfHide?: { header?: boolean; footer?: boolean };
  }[];
}

// ───────── headers / footers (core/headerFooter.ts) ─────────

/** Word pgNumType w:fmt ↔ page number format (formats without a model are read as 1 2 3) */
const DOCX_PGFMT: Record<string, PageNumFormat> = { decimal: "decimal", lowerRoman: "lowerRoman", upperRoman: "upperRoman", lowerLetter: "lowerLetter", upperLetter: "upperLetter", numberInDash: "dash", ganada: "ganada" };
export const DOCX_PGFMT_OUT: Record<PageNumFormat, string> = { decimal: "decimal", lowerRoman: "lowerRoman", upperRoman: "upperRoman", lowerLetter: "lowerLetter", upperLetter: "upperLetter", dash: "numberInDash", ganada: "ganada" };

const normPath = (p: string) => {
  const out: string[] = [];
  for (const s of p.split("/")) {
    if (s === "..") out.pop();
    else if (s !== "." && s) out.push(s);
  }
  return out.join("/");
};

/** Relationship id → package path, from a part's relationships (word/_rels/document.xml.rels). */
export function docxRels(files: Record<string, Uint8Array>, part = "word/document.xml"): Map<string, string> {
  const dir = part.slice(0, part.lastIndexOf("/") + 1);
  const relsPath = dir + "_rels/" + part.slice(dir.length) + ".rels";
  const out = new Map<string, string>();
  if (!files[relsPath]) return out;
  for (const r of descendants(parseXml(strFromU8(files[relsPath])), "Relationship")) {
    if (attr(r, "TargetMode") === "External") continue;
    const target = attr(r, "Target") ?? "";
    out.set(attr(r, "Id") ?? "", target.startsWith("/") ? target.slice(1) : normPath(dir + target));
  }
  return out;
}

/**
 * A w:hdr / w:ftr part → its paragraphs (paragraphs of tables in it in reading order), fields as field runs. A framed
 * paragraph holding only a PAGE field (Word's page-number frame, as Omniweave writes a page number placed by itself)
 * is returned as `pageNum` instead.
 */
export function docxHFParas(xml: Uint8Array, ctx: DocxCtx, area: "header" | "footer"): { paras: TextParagraph[]; pageNum?: { pos: PageNumPos; side?: string } } {
  const root = parseXml(strFromU8(xml)).documentElement;
  const fctx: DocxCtx = { ...ctx, fields: true };
  const paras: TextParagraph[] = [];
  let pageNum: { pos: PageNumPos; side?: string } | undefined;
  const visit = (el: Element) => {
    for (const c of children(el)) {
      if (c.localName === "p") {
        const { para } = docxParagraph(c, fctx);
        const pPr = child(c, "pPr");
        const frame = pPr && child(pPr, "framePr");
        const text = para.runs.filter((r) => !r.field).map((r) => r.text).join("");
        if (frame && !pageNum && para.runs.some((r) => r.field === "page") && para.runs.every((r) => !r.field || r.field === "page") && /^[\s\-–—]*$/.test(text)) {
          const x = attr(frame, "xAlign") ?? "left";
          const h = x === "center" || x === "right" || x === "outside" || x === "inside" ? x : "left";
          const side = para.runs.find((r) => !r.field)?.text.trim();
          pageNum = { pos: `${area === "header" ? "top" : "bottom"}-${h}` as PageNumPos, ...(side ? { side } : {}) };
          continue;
        }
        paras.push(para);
      } else if (c.localName === "tbl") for (const p of descendants(c, "p")) paras.push(docxParagraph(p, fctx).para);
      else if (c.localName === "sdt" || c.localName === "sdtContent" || c.localName === "customXml") visit(c);
    }
  };
  if (root) visit(root);
  return { paras, ...(pageNum ? { pageNum } : {}) };
}

const docxOn = (el: Element | null | undefined) => !!el && !/^(0|false|off)$/.test(attr(el, "val") ?? "");

/**
 * Header / footer settings of a w:sectPr: header and footer references by type (default / first / even), titlePg,
 * pgNumType (fmt, start); `evenOdd` (settings.xml evenAndOddHeaders) on the first section. `pnArea` carries the area
 * that held a page number placed by itself in the sections before (a section with its own part there without one ends it).
 */
export function docxSectionHF(
  sectPr: Element | undefined | null,
  files: Record<string, Uint8Array>,
  rels: Map<string, string>,
  ctx: DocxCtx,
  opts: { evenOdd?: boolean; pnArea?: { area: "header" | "footer" | null } } = {},
): SectionHF | undefined {
  const hf: SectionHF = {};
  if (opts.evenOdd) hf.evenOdd = true;
  if (!sectPr) return Object.keys(hf).length ? hf : undefined;
  const ownDefault = new Set<string>();
  // areas whose first-page part holds the page number frame (Omniweave writes it there when the first page shows it)
  const firstPn = new Set<string>();
  for (const ref of children(sectPr)) {
    const area = ref.localName === "headerReference" ? "header" : ref.localName === "footerReference" ? "footer" : null;
    if (!area) continue;
    const type = attr(ref, "type") ?? "default";
    if (type !== "default" && type !== "first" && type !== "even") continue;
    const path = rels.get(attr(ref, "id") ?? "");
    const bytes = path ? files[path] : undefined;
    if (!bytes) continue;
    const { paras, pageNum } = docxHFParas(bytes, ctx, area);
    (hf[area] ??= {})[type] = paras;
    if (type === "default") ownDefault.add(area);
    if (pageNum && type === "first") firstPn.add(area);
    if (pageNum && type === "default") {
      hf.pageNum = pageNum;
      if (opts.pnArea) opts.pnArea.area = area;
    }
  }
  if (hf.pageNum === undefined && opts.pnArea?.area && ownDefault.has(opts.pnArea.area)) {
    hf.pageNum = null;
    opts.pnArea.area = null;
  }
  if (docxOn(child(sectPr, "titlePg"))) {
    hf.titlePg = true;
    // the first page shows its own (first) part: a page number of the default part is not on it — unless that first
    // part has the page number frame too
    const area = hf.pageNum ? (hf.pageNum.pos.startsWith("top") ? "header" : "footer") : opts.pnArea?.area;
    if (area && !firstPn.has(area)) hf.hideFirstNum = true;
  }
  const pg = child(sectPr, "pgNumType");
  if (pg) {
    const fmt = DOCX_PGFMT[attr(pg, "fmt") ?? ""];
    if (fmt && fmt !== "decimal") hf.pageFmt = fmt;
    const st = Number(attr(pg, "start"));
    if (attr(pg, "start") != null && Number.isFinite(st)) hf.pageStart = st;
  }
  return Object.keys(hf).length ? hf : undefined;
}

const twPx = (tw: number) => Math.round((tw / 15) * 100) / 100; // twips → px (1440 / in, 96 px / in)

/** Page setup of a w:sectPr (pgSz / pgMar; gutter is added to the left margin). Missing values: Word's defaults (A4 2 cm). */
export function docxSetup(sectPr: Element | undefined): PageSetup {
  const sz = sectPr && child(sectPr, "pgSz");
  const mar = sectPr && child(sectPr, "pgMar");
  const num = (el: Element | undefined | null, n: string) => {
    const v = el ? Number(attr(el, n)) : NaN;
    return Number.isFinite(v) ? Math.abs(v) : NaN;
  };
  let w = num(sz, "w"), h = num(sz, "h");
  if (!(w > 0) || !(h > 0)) ({ width: w, height: h } = { width: 11906, height: 16838 });
  // orient="landscape" with portrait numbers (some writers): turn the page
  if (sz && attr(sz, "orient") === "landscape" && w < h) [w, h] = [h, w];
  const m = (n: keyof PageMargins, def: number) => {
    const v = num(mar, n);
    return twPx(Number.isFinite(v) ? v : def);
  };
  const gutter = num(mar, "gutter");
  const margins: PageMargins = { top: m("top", 1134), right: m("right", 1134), bottom: m("bottom", 1134), left: m("left", 1134), header: m("header", 567), footer: m("footer", 567) };
  if (gutter > 0) margins.left = Math.round((margins.left + twPx(gutter)) * 100) / 100;
  // Word lays lines out in the exact body width (A4 11906 twips = 793.73 px, not the 794 px preset): a body 0.2 pt wider
  // keeps a syllable Word moves down (Gulim 10 pt lines end within 0.1 pt of the margin). The paper preset is still
  // recognised (paperOf, within 1.5 px) and written back as its own twips.
  return { width: Math.round((w / 15) * 100) / 100, height: Math.round((h / 15) * 100) / 100, margins };
}

/** Paper presets in each format's own units (portrait), so A4 is written exactly as Word / 한글 write it. */
const PAPER_UNITS: Record<PaperId, { tw: [number, number]; hu: [number, number] }> = {
  A4: { tw: [11906, 16838], hu: [59528, 84186] },
  A3: { tw: [16838, 23811], hu: [84186, 119055] },
  B5: { tw: [10319, 14572], hu: [51592, 72852] },
  Letter: { tw: [12240, 15840], hu: [61200, 79200] },
  Legal: { tw: [12240, 20160], hu: [61200, 100800] },
};
/** Paper size of a setup in a format's units, portrait first: [short, long] (preset values when it is one) */
function paperUnits(s: PageSetup, unit: "tw" | "hu"): [number, number] {
  const id = paperOf(s.width, s.height);
  if (id !== "custom") return PAPER_UNITS[id][unit];
  const k = unit === "tw" ? 15 : HU;
  return [Math.round(Math.min(s.width, s.height) * k), Math.round(Math.max(s.width, s.height) * k)];
}

/** w:pgSz + w:pgMar of a page setup (shared with the Office Surgeon). */
export function docxPageXml(s: PageSetup): string {
  const m = s.margins;
  const [a, b] = paperUnits(s, "tw");
  const land = s.width > s.height;
  return `<w:pgSz w:w="${land ? b : a}" w:h="${land ? a : b}"${land ? ' w:orient="landscape"' : ""}/><w:pgMar w:top="${twip(m.top)}" w:right="${twip(m.right)}" w:bottom="${twip(m.bottom)}" w:left="${twip(m.left)}" w:header="${twip(m.header)}" w:footer="${twip(m.footer)}" w:gutter="0"/>`;
}

const HU = 75; // HWPUNIT per px (7200 / in)
const huPx = (hu: number) => Math.round((hu / HU) * 100) / 100;

/**
 * Page setup of an hp:secPr. 한글 measures the top margin to the header and adds the header area before the body
 * (body top = top + header); the model uses Word's meaning (top = paper edge → body, header = paper edge → header),
 * so top = top + header, header = top (likewise bottom / footer). landscape="NARROWLY" is 한글's 가로 (landscape)
 * with the paper's own (portrait) width and height; WIDELY is 세로.
 */
export function hwpxSetup(secPr: Element | undefined): PageSetup {
  const pp = secPr && descendants(secPr, "pagePr")[0];
  const mg = pp && child(pp, "margin");
  const n = (el: Element | undefined | null, a: string, def: number) => {
    const v = el ? Number(attr(el, a)) : NaN;
    return Number.isFinite(v) && v >= 0 ? v : def;
  };
  let w = n(pp, "width", 59528), h = n(pp, "height", 84186);
  if (pp && attr(pp, "landscape") === "NARROWLY") [w, h] = [Math.max(w, h), Math.min(w, h)];
  const top = n(mg, "top", 5668), bottom = n(mg, "bottom", 4252), header = n(mg, "header", 4252), footer = n(mg, "footer", 4252), gutter = n(mg, "gutter", 0);
  // the paper as 한글 has it (0.01 px), not snapped to a whole px (A4 794 px = 59550 HWPUNIT): the body is as wide as
  // 한글's lines (59528 − 2 × 8504 = 42520 HWPUNIT), so a paragraph without saved lines breaks where 한글's do (a
  // 0.29 px wider body kept one more syllable on 4 lines of omni-hwp-margins). Writing it back finds the preset's units.
  return {
    width: huPx(w),
    height: huPx(h),
    margins: { top: huPx(top + header), right: huPx(n(mg, "right", 8504)), bottom: huPx(bottom + footer), left: huPx(n(mg, "left", 8504) + gutter), header: huPx(top), footer: huPx(bottom) },
  };
}

/** hp:pagePr of a page setup (shared with the Office Surgeon); the inverse of hwpxSetup. */
export function hwpxPagePrXml(s: PageSetup): string {
  const m = s.margins;
  const land = s.width > s.height;
  const hu = (px: number) => Math.max(0, Math.round(px * HU));
  const [a, b] = paperUnits(s, "hu");
  // header / footer areas: from the header distance to the body (never negative)
  // (each length is rounded on its own before the difference, so a margin read from a file is written back unit for
  // unit: hwpxSetup keeps 0.01 px, i.e. ±0.375 HWPUNIT per value)
  const head = Math.min(m.header, m.top), foot = Math.min(m.footer, m.bottom);
  return (
    `<hp:pagePr landscape="${land ? "NARROWLY" : "WIDELY"}" width="${a}" height="${b}" gutterType="LEFT_ONLY">` +
    `<hp:margin header="${Math.max(0, hu(m.top) - hu(head))}" footer="${Math.max(0, hu(m.bottom) - hu(foot))}" gutter="0" left="${hu(m.left)}" right="${hu(m.right)}" top="${hu(head)}" bottom="${hu(foot)}"/></hp:pagePr>`
  );
}

/** What an office import left out, for the open message (filled when passed in). */
export interface OfficeImportReport {
  /** footnotes and endnotes: their text is not part of the body flow and is not imported */
  notesDropped: number;
  /** page breaks and sections of the body (filled when present) */
  layout?: OfficeLayout;
  /**
   * Office Surgeon block map (filled when present): DOCX — items made from each top-level w:body child, in
   * order; HWPX — per section file, items made from each top-level hp:p.
   */
  blockItems?: number[];
  sectionBlocks?: { part: string; items: number[] }[];
  /** list definitions the imported list paragraphs use (io/formats/flow.ts puts them on the text nodes) */
  lists?: ListDef[];
  /**
   * Pictures of the body (io/officeDrawing.ts), read when this is given: a paragraph holding nothing but inline
   * pictures is then no item (the pictures take its place). Without it the body is read as before pictures were.
   */
  pictures?: OfficePic[];
  /** drawings the import leaves in the original (shapes, charts, pictures in table cells / text boxes, linked) */
  picturesKept?: number;
  /**
   * Office Surgeon model 8: an empty paragraph right after a table is an item (an empty line, as Word draws it) unless
   * it ends the body; without it the body is read as before (that paragraph dropped).
   */
  afterTableParas?: true;
  /**
   * Read the file as the importer before comments and tracked changes (an Office Surgeon map before model 9): deleted
   * text left out, DOCX moves read twice, 한글 memo text read as body paragraphs.
   */
  noReview?: true;
}

/** The next element sibling. */
const nextEl = (el: Element): Element | null => {
  let n = el.nextSibling;
  while (n && n.nodeType !== 1) n = n.nextSibling;
  return n as Element | null;
};

/** Definitions of the lists in use (one per definition id). */
function usedDefs(plists: Map<TextParagraph, ParaList>, all: Map<string, ListDef> | undefined): ListDef[] {
  const ids = new Set([...plists.values()].map((l) => l.def));
  return [...(all?.values() ?? [])].filter((d) => ids.has(d.id));
}

/** DOCX body in reading order: paragraphs and tables (TABLE nodes on import). */
export function parseDocxFlow(bytes: Uint8Array, report?: OfficeImportReport): OfficeItem[] {
  const files = unzipSync(bytes);
  const main = files["word/document.xml"];
  if (!main) throw new Error(tx("engine.office.notDocx"));
  const doc = parseXml(strFromU8(main));
  const body = descendants(doc, "body")[0] ?? doc.documentElement;
  const ctx = docxContext(files);
  // footnotes and endnotes: read with their references (their counts and settings for the open message and the flow)
  ctx.notes = docxNotes(files, ctx, child(body, "sectPr"));
  // comments and tracked changes (core/review.ts)
  if (!report?.noReview) ctx.review = { open: new Set() };
  const comments = ctx.review ? docxComments(files) : [];
  const items: OfficeItem[] = [];
  const kinds = new Map<TextParagraph, "li" | "oli">();
  const plists = new Map<TextParagraph, ParaList>();
  // page layout: hard page breaks (item index) and section ends (a w:sectPr in a paragraph ends its section there)
  const breaks = new Set<number>();
  // (`mark`: the section break is all its paragraph holds — TextParagraph.sectMark when the next section is continuous)
  const sectionEnds: { end: number; sectPr: Element; mark?: TextParagraph }[] = [];
  let afterTable = false;
  // pictures (report.pictures given): the top-level body element they are in and its drawings in order
  const pics = report?.pictures;
  const rels = docxRels(files);
  let top: { el: Element; b: number; drawings: Element[] | null } = { el: body, b: -1, drawings: null };
  /** the pictures of a body paragraph (its own drawings, not those in text boxes) with their bytes */
  const docxBodyPics = (p: Element) => {
    const out: { pic: NonNullable<ReturnType<typeof docxPicOf>>; d: Element; bytes: Uint8Array; mime: string }[] = [];
    for (const d of topDrawings(p)) {
      const pic = docxPicOf(d);
      const path = pic ? rels.get(pic.rId) : undefined;
      const bytes = path ? files[path] : undefined;
      const mime = bytes && path ? picMime(bytes, path) : undefined;
      if (pic && bytes && mime) out.push({ pic, d, bytes, mime });
    }
    return out;
  };
  /** characters of the paragraph text before a drawing (runs read as docxParagraph reads them) */
  const charsBefore = (p: Element, d: Element) => {
    let n = 0;
    for (const r of descendants(p, "r")) {
      let inside = false;
      for (let x = d.parentNode as Element | null; x && x !== p; x = x.parentNode as Element | null) if (x === r) inside = true;
      if (inside) break;
      for (const c of children(r)) n += c.localName === "t" ? textOf(c).length : c.localName === "tab" || (c.localName === "br" && (attr(c, "type") ?? "textWrapping") === "textWrapping") ? 1 : 0;
    }
    return n;
  };
  /** pictures of paragraph `p`: after its item (`para`), or — no item — in its place, `tail` = with the item before */
  const addPics = (p: Element, found: ReturnType<typeof docxBodyPics>, para: TextParagraph | null, tail: boolean, look: TextParagraph) => {
    top.drawings ??= topDrawings(top.el);
    const prev = items[items.length - 1];
    for (const f of found) {
      const k = top.drawings.indexOf(f.d);
      if (k < 0) continue;
      const pic: OfficePic = {
        id: uid("img"),
        at: items.length,
        // with no item of its own it goes with the item before, unless a page / section begins at it
        tail: !!para || tail || !(breaks.has(items.length) || sectionEnds.some((e) => e.end === items.length)),
        bytes: f.bytes,
        mime: f.mime,
        name: f.pic.name || tx("engine.default.image"),
        g: f.pic.g,
        offset: para ? charsBefore(p, f.d) : 0,
        own: !para,
        part: "word/document.xml",
        b: top.b,
        k,
        ...(para ? { para: para.id } : prev?.kind === "p" ? { para: prev.p.id } : {}),
      };
      if (f.pic.inline) pic.inline = { align: look.align, indent: look.indentLeft ?? 0, before: para ? 0 : look.spaceBefore ?? 0, after: para ? 0 : look.spaceAfter };
      else pic.float = f.pic.float;
      pics!.push(pic);
    }
  };
  const visit = (parent: Element) => {
    for (const el of children(parent)) {
      const before = items.length;
      if (parent === body) top = { el, b: top.b + 1, drawings: null };
      visitOne(el);
      if (parent === body) report?.blockItems?.push(items.length - before);
    }
  };
  const visitOne = (el: Element) => {
    const ln = el.localName;
    if (ln === "p") {
      // the empty paragraph Word needs after a table is not content — from model 8 (report.afterTableParas) only when it
      // ends the body (Word requires it there); one with content after it is a line Word draws (an empty line)
      if (afterTable && !el.firstChild && (!report?.afterTableParas || (nextEl(el)?.localName ?? "sectPr") === "sectPr")) {
        afterTable = false;
        return;
      }
      const { para, list, plist, pageBreak } = docxParagraph(el, ctx);
      const pPr = child(el, "pPr");
      const sect = pPr && child(pPr, "sectPr");
      const found = pics ? docxBodyPics(el) : [];
      // a paragraph holding nothing but inline pictures: the pictures are its content (no empty text line)
      const picsOnly = found.length > 0 && found.every((f) => f.pic.inline) && !para.runs.some((r) => r.text);
      if (pageBreak === "before" || pageBreak === "only") breaks.add(items.length);
      const kept = pageBreak !== "only" && !picsOnly;
      if (kept) {
        if (list) kinds.set(para, list);
        if (plist) plists.set(para, plist);
        items.push({ kind: "p", p: para });
      }
      if (found.length) addPics(el, found, kept ? para : null, !!sect || pageBreak === "after", para);
      if (pageBreak === "after") breaks.add(items.length);
      if (sect) sectionEnds.push({ end: items.length, sectPr: sect, ...(kept && !found.length && para.runs.every((r) => !r.text) ? { mark: para } : {}) });
      afterTable = false;
    } else if (ln === "tbl") {
      // list items in table cells stay one-level lists (a table node has no list definitions)
      // (footnotes in table cells: kept on their references; the body flow gives them room at the foot of their row's page)
      items.push({ kind: "table", table: docxTable(el, ctx, kinds) });
      afterTable = true;
    } else if (ln === "sdt") {
      const content = child(el, "sdtContent");
      if (content) visit(content);
    } else if (ln === "customXml" || ln === "ins" || ln === "smartTag") visit(el);
  };
  visit(body);
  // references the body flow does not carry (in table cells, text boxes): counted for the open message
  if (report) report.notesDropped += Math.max(0, descendants(body, "footnoteReference").length + descendants(body, "endnoteReference").length - (ctx.notes?.read ?? 0));
  if (pics && report) {
    // drawings not read (shapes, charts, groups, pictures in table cells): they stay in the original only
    const all = descendants(body, "drawing").filter((d) => {
      for (let n = d.parentNode as Element | null; n && n !== body; n = n.parentNode as Element | null) if (n.localName === "drawing") return false;
      return true;
    }).length;
    const read = pics.filter((x) => x.part === "word/document.xml").length;
    if (all > read) report.picturesKept = (report.picturesKept ?? 0) + all - read;
  }
  // Word's section break mark before a continuous section lays out no line (TextParagraph.sectMark); the next section's
  // w:type says how it starts (the body's own w:sectPr is the last section's)
  if (ctx.styles)
    sectionEnds.forEach((s, i) => {
      const next = sectionEnds[i + 1]?.sectPr ?? child(body, "sectPr");
      const type = next && child(next, "type");
      if (s.mark && s.end < items.length && type && attr(type, "val") === "continuous") s.mark.sectMark = true;
    });
  const defs = usedDefs(plists, ctx.listDefs);
  // w:lvlOverride/w:startOverride: the first item of that level of the w:num starts there
  const started = new Set<string>();
  for (const l of plists.values()) {
    const st = ctx.nums?.get(l.id.slice("docx-n".length))?.starts.get(l.level);
    if (st != null && !started.has(l.id + "/" + l.level)) {
      started.add(l.id + "/" + l.level);
      l.start = st;
    }
  }
  addMarkers(kinds, plists, defs);
  const out = renumberItems(items, defs);
  if (report && defs.length) report.lists = defs;
  if (report) {
    // the body's own w:sectPr is the last section; a section of type "continuous" starts on the same page, so its
    // page keeps the setup of the section before it (no model for a mid-page section)
    const ends = [...sectionEnds, { end: items.length, sectPr: child(body, "sectPr") }];
    const sections: OfficeLayout["sections"] = [];
    let start = 0;
    // headers / footers of each section (word/settings.xml evenAndOddHeaders is the document's)
    const settings = files["word/settings.xml"] && parseXml(strFromU8(files["word/settings.xml"]));
    const evenOdd = !!settings && docxOn(descendants(settings, "evenAndOddHeaders")[0]);
    const pnArea = { area: null as "header" | "footer" | null };
    ends.forEach((s, src) => {
      const type = s.sectPr && child(s.sectPr, "type") && attr(child(s.sectPr, "type")!, "val");
      const last = sections[sections.length - 1];
      const hf = docxSectionHF(s.sectPr, files, rels, ctx, { evenOdd: src === 0 && evenOdd, pnArea });
      const own = { setup: docxSetup(s.sectPr), src, ...(hf ? { hf } : {}) };
      if (last && last.start === start) {
        // the section before had no content
        if (!hf) delete last.hf;
        Object.assign(last, own);
      } else if (!last || (type !== "continuous" && start < items.length)) sections.push({ start, ...own });
      start = s.end;
    });
    if (evenOdd && sections[0] && !sections[0].hf?.evenOdd) sections[0].hf = { ...(sections[0].hf ?? {}), evenOdd: true };
    report.layout = { pageBreaks: [...breaks].filter((i) => i > 0 && i < items.length).sort((a, b) => a - b), sections, pageRules: "word", ...(ctx.notes && (ctx.notes.foot.size || ctx.notes.end.size) ? { notePr: ctx.notes.pr } : {}), ...(comments.length ? { comments } : {}), ...(ctx.review && docxTracking(files["word/settings.xml"]) ? { trackChanges: true as const } : {}), ...(ctx.styles?.charWrap ? { wordBreak: "normal" as const } : {}), ...(ctx.styles && docxBalancedSpaces(files) ? { cjkSpace: "half" as const } : {}), ...(ctx.styles?.hangPunct ? { hangPunct: true } : {}), ...(docxLang(files) ? { lang: docxLang(files)! } : {}), ...(ctx.styles && docxCompatMode(files) >= 15 ? { justifyShrink: true } : {}), ...(ctx.styles && (ctx.styles.autoSpace.alpha || ctx.styles.autoSpace.digit) ? { autoSpace: ctx.styles.autoSpace } : {}), ...(ctx.styles ? { wordSpacing: docxParaSpacing(files) } : {}) };
    // table cells are set like the body text (Word's line breaking, half-width spaces …)
    const L = report.layout;
    for (const it of out)
      if (it.kind === "table" && it.table.style.cellBox?.word) {
        const w = it.table.style.cellBox.word;
        if (L.wordBreak) w.wordBreak = L.wordBreak;
        if (L.cjkSpace) w.cjkSpace = L.cjkSpace;
        if (L.hangPunct) w.hangPunct = true;
        if (L.justifyShrink) w.justifyShrink = true;
        if (L.autoSpace) w.autoSpace = { ...L.autoSpace };
        if (L.wordSpacing) w.wordSpacing = L.wordSpacing;
      }
  }
  return out;
}

/** DOCX paragraphs in reading order (tables flattened to their cell paragraphs). */
export function parseDocx(bytes: Uint8Array): TextParagraph[] {
  return flatten(parseDocxFlow(bytes));
}

/** picture media types by file extension (when the bytes do not say) */
const PIC_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp", emf: "image/x-emf", wmf: "image/x-wmf" };
/**
 * Media type of picture bytes the app can show (PNG, JPEG, GIF, BMP, WebP, and EMF / WMF — drawn through
 * render/picDecode.ts, kept as their own bytes), else undefined (left in the original).
 */
function picMime(bytes: Uint8Array, path: string): string | undefined {
  const f = picFormat(bytes)?.mime;
  if (f) return Object.values(PIC_MIME).includes(f) ? f : undefined;
  return PIC_MIME[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
}

/** w:highlight named colours (ST_HighlightColor) → hex */
const HIGHLIGHT: Record<string, string> = {
  yellow: "#FFFF00", green: "#00FF00", cyan: "#00FFFF", magenta: "#FF00FF", blue: "#0000FF", red: "#FF0000",
  darkBlue: "#000080", darkCyan: "#008080", darkGreen: "#008000", darkMagenta: "#800080", darkRed: "#800000",
  darkYellow: "#808000", darkGray: "#808080", lightGray: "#C0C0C0", black: "#000000", white: "#FFFFFF",
};

// ───────────────────────── HWPX import ─────────────────────────

const HALIGN: Record<string, Align> = { LEFT: "LEFT", CENTER: "CENTER", RIGHT: "RIGHT", JUSTIFY: "JUSTIFY", DISTRIBUTE: "JUSTIFY", DISTRIBUTE_SPACE: "JUSTIFY" };

/** hp:ctrl children whose subList text is page furniture or a note, never body text. */
const PAGE_STORY = new Set(["header", "footer", "footNote", "endNote", "hiddenComment"]);

export interface HwpxParaPr {
  align: Align;
  lineSpacing: number;
  indent: number;
  spaceAfter: number;
  indentLeft?: number;
  spaceBefore?: number;
  indentRight?: number;
  lineHeight?: ParaLineHeight;
  keepNext?: boolean;
  keepLines?: boolean;
  /** 한글 단위 '글자' (breakNonLatinWord KEEP_WORD — sic): Hangul breaks between syllables */
  breakWord?: boolean;
  /** 공백 최소값 (condense %) as a fraction */
  condense?: number;
  pageBreakBefore?: boolean;
  /** 외톨이줄 보호 off (breakSetting widowOrphan 0, 한글's default) */
  widowControl?: false;
  /** paraPr heading: OUTLINE level → heading role, BULLET / NUMBER → list */
  head?: { type: string; level: number; idRef?: string };
  /** 문단 테두리·배경 (hh:border borderFillIDRef with its offsets) */
  border?: ParaBorders;
  shade?: string;
}

/** Character / paragraph shapes, heading styles and cell fills of an HWPX header.xml (shared with the Office Surgeon). */
export function hwpxHeaderMaps(header: Uint8Array | undefined) {
  const charPr = new Map<string, Partial<TextRun>>();
  const paraPr = new Map<string, HwpxParaPr>();
  const styleHeading = new Map<string, number>();
  const fills = new Map<string, { fill: string | null; border: string | null }>();
  // paragraph shapes with a border / fill (resolved once the border fills are read)
  const paraBorders: { id: string; ref: string; off: Record<"left" | "right" | "top" | "bottom", number> }[] = [];
  const sides = new Map<string, { lines: Partial<Record<"left" | "right" | "top" | "bottom", ParaBorderLine>>; fill: string | null }>();
  const fonts: string[] = [];
  const latinFonts: string[] = [];
  /**
   * 한글 sets each language of a character shape on its own (글자 종류별 글꼴·장평·자간): where the Latin values differ
   * from the Hangul ones, the run's Latin text (U+0000–U+024F) takes these (parseHwpxFlow splits such runs).
   */
  const charPrLatin = new Map<string, Partial<TextRun>>();
  /** numbering / bullet definitions: "hwpx-n{id}" / "hwpx-b{id}" */
  const listDefs = new Map<string, ListDef>();
  if (header) {
    const headerXml = strFromU8(header);
    const h = parseXml(headerXml);
    const hangulFaces = descendants(h, "fontface").find((f) => attr(f, "lang") === "HANGUL") ?? descendants(h, "fontface")[0];
    if (hangulFaces) for (const f of children(hangulFaces, "font")) fonts[Number(attr(f, "id"))] = attr(f, "face") ?? "";
    const latinFaces = descendants(h, "fontface").find((f) => attr(f, "lang") === "LATIN");
    if (latinFaces) for (const f of children(latinFaces, "font")) latinFonts[Number(attr(f, "id"))] = attr(f, "face") ?? "";
    for (const c of descendants(h, "charPr")) {
      const id = attr(c, "id")!;
      const height = Number(attr(c, "height")); // 1/100 pt
      const fr = child(c, "fontRef");
      const fontIdx = fr ? Number(attr(fr, "hangul")) : NaN;
      const ul = child(c, "underline");
      const so = child(c, "strikeout");
      const sp = child(c, "spacing");
      const spPct = sp ? Number(attr(sp, "hangul")) : NaN; // % of each character's advance after 장평 (measured)
      const ra = child(c, "ratio");
      const ratio = ra ? Number(attr(ra, "hangul")) : NaN; // 장평 %
      const shade = attr(c, "shadeColor") ?? "";
      // (to 0.0001 px: 10 pt is 13.3333 px — the 13.3 px it was rounded to set every line 0.25 % narrow, one syllable
      // more than 한글 on a full line; hwpxHeight writes it back as the same HWPUNIT)
      const sizePx = Number.isFinite(height) ? Math.round((height / 100) * PT * 10000) / 10000 : undefined;
      charPr.set(id, {
        fontSize: sizePx,
        bold: !!child(c, "bold"),
        italic: !!child(c, "italic"),
        underline: !!ul && attr(ul, "type") !== "NONE",
        color: /^#[0-9a-f]{6}$/i.test(attr(c, "textColor") ?? "") ? attr(c, "textColor")! : undefined,
        fontFamily: Number.isFinite(fontIdx) && fonts[fontIdx] ? fonts[fontIdx] : undefined,
        strike: so && (attr(so, "shape") ?? "SOLID") !== "NONE" ? true : undefined,
        script: child(c, "supscript") ? "super" : child(c, "subscript") ? "sub" : undefined,
        highlight: /^#[0-9a-f]{6}$/i.test(shade) && shade.toUpperCase() !== "#FFFFFF" ? shade.toUpperCase() : undefined,
        spacingPct: Number.isFinite(spPct) && spPct ? spPct : undefined,
        hscale: Number.isFinite(ratio) && ratio > 0 && ratio !== 100 ? ratio : undefined,
      });
      // the Latin language's own font / 장평 / 자간 where they differ
      const lFont = fr ? latinFonts[Number(attr(fr, "latin"))] : undefined;
      const lSp = sp ? Number(attr(sp, "latin")) : NaN;
      const lRatio = ra ? Number(attr(ra, "latin")) : NaN;
      const lat: Partial<TextRun> = {};
      const hFont = Number.isFinite(fontIdx) ? fonts[fontIdx] : undefined;
      if (lFont && hFont && lFont !== hFont) lat.fontFamily = lFont;
      if (Number.isFinite(lRatio) && lRatio > 0 && lRatio !== (Number.isFinite(ratio) && ratio > 0 ? ratio : 100)) lat.hscale = lRatio;
      if (Number.isFinite(lSp) && lSp !== (Number.isFinite(spPct) ? spPct : 0)) lat.spacingPct = lSp;
      if (Object.keys(lat).length) charPrLatin.set(id, lat);
    }
    for (const p of descendants(h, "paraPr")) {
      const id = attr(p, "id")!;
      const al = descendants(p, "align")[0];
      // 한글 2014+ writes margins / line spacing twice in hp:switch: hp:case (HwpUnitChar namespace) holds HWPUNIT,
      // hp:default twice that for readers without the namespace. Unwrapped values (older files, Omniweave's own)
      // are plain HWPUNIT: 한글 2024 shows an unwrapped 2000 as 20 pt (measured, qa/interop/RESULTS-2026-11-12.md).
      const parentIs = (e: Element, n: string) => !!e.parentNode && (e.parentNode as Element).localName === n;
      const pick = (els: Element[]) => els.find((e) => parentIs(e, "case")) ?? els.find((e) => !parentIs(e, "default")) ?? els[0];
      const margin = pick(descendants(p, "margin"));
      const ls = pick(descendants(p, "lineSpacing"));
      const intent = margin && child(margin, "intent");
      const next = margin && child(margin, "next");
      const lsv = ls ? Number(attr(ls, "value")) : NaN;
      const leftEl = margin && child(margin, "left");
      const intentPx = intent ? (Number(attr(intent, "value")) / 100) * PT || 0 : 0;
      // 내어쓰기 (negative intent): 한글 keeps the first line at the left margin and indents the others by it; the model
      // indents every line by indentLeft and the first by indent from there (hwpxLeftOut writes it back)
      const leftPx = Math.round(((leftEl ? (Number(attr(leftEl, "value")) / 100) * PT || 0 : 0) - Math.min(0, intentPx)) * 100) / 100;
      const prev = margin && child(margin, "prev");
      const rightEl = margin && child(margin, "right");
      const prevPx = prev ? (Number(attr(prev, "value")) / 100) * PT || 0 : 0;
      const rightPx = rightEl ? (Number(attr(rightEl, "value")) / 100) * PT || 0 : 0;
      const hd = descendants(p, "heading")[0];
      const type = hd ? attr(hd, "type") ?? "NONE" : "NONE";
      const bs = descendants(p, "breakSetting")[0];
      const flag = (n: string) => !!bs && attr(bs, n) === "1";
      // FIXED (고정값), AT_LEAST (최소), BETWEEN_LINES (여백만): HWPUNIT, kept as such
      const lsType = (ls && attr(ls, "type")) || "PERCENT";
      const lineHeight: ParaLineHeight | undefined =
        lsType !== "PERCENT" && Number.isFinite(lsv) && lsv >= 0 ? { mode: lsType === "FIXED" ? "exact" : lsType === "AT_LEAST" ? "atLeast" : "between", v: { v: lsv, u: "hwpunit" } } : undefined;
      const pb = child(p, "border");
      const pbRef = pb && attr(pb, "borderFillIDRef");
      if (pbRef) {
        const off = (k: string) => ((Number(attr(pb!, "offset" + k)) || 0) / 100) * PT;
        paraBorders.push({ id, ref: pbRef, off: { left: off("Left"), right: off("Right"), top: off("Top"), bottom: off("Bottom") } });
      }
      paraPr.set(id, {
        align: HALIGN[(al && attr(al, "horizontal")) || "LEFT"] ?? "LEFT",
        lineSpacing: ls && attr(ls, "type") === "PERCENT" && lsv > 0 ? lsv / 100 : 1.6,
        indent: intentPx,
        spaceAfter: next ? (Number(attr(next, "value")) / 100) * PT || 0 : 4,
        ...(leftPx ? { indentLeft: leftPx } : {}),
        ...(prevPx ? { spaceBefore: prevPx } : {}),
        ...(rightPx ? { indentRight: rightPx } : {}),
        ...(lineHeight ? { lineHeight } : {}),
        ...(flag("keepWithNext") && !(type === "OUTLINE") ? { keepNext: true } : {}),
        ...(flag("keepLines") ? { keepLines: true } : {}),
        ...(flag("pageBreakBefore") ? { pageBreakBefore: true } : {}),
        // 외톨이줄 보호 (widow / orphan control): off unless the shape turns it on (한글's default)
        ...(!flag("widowOrphan") ? { widowControl: false as const } : {}),
        // OWPML names it the other way round: KEEP_WORD is 한글 단위 '글자' (한글's default), BREAK_WORD '어절' (measured:
        // qa/interop/hancom-made/omni-hwp-breaking — 어절 cases are BREAK_WORD; KEEP_WORD paragraphs break inside words)
        ...((bs ? attr(bs, "breakNonLatinWord") : null) !== "BREAK_WORD" ? { breakWord: true } : {}),
        ...(Number(attr(p, "condense")) > 0 ? { condense: Math.min(75, Number(attr(p, "condense"))) / 100 } : {}),
        ...(type !== "NONE" ? { head: { type, idRef: attr(hd!, "idRef") ?? "0", level: Number(attr(hd!, "level")) || 0 } } : {}),
      });
    }
    // the elements as written (a full rewrite writes the levels nobody changed again: hwpxListHeads)
    const rawNumbering = hwpxRawElements(headerXml, "numbering");
    const rawBullet = hwpxRawElements(headerXml, "bullet");
    for (const nb of descendants(h, "numbering")) {
      const id = attr(nb, "id") ?? "";
      const heads = children(nb, "paraHead");
      const raws = new Map<number, string>();
      for (const m of (rawNumbering.get(id) ?? "").matchAll(/<(?:\w+:)?paraHead\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?paraHead>)/g)) {
        const l = Number(/\slevel="(\d+)"/.exec(m[0])?.[1]);
        if (Number.isFinite(l) && !raws.has(l)) raws.set(l, m[0]);
      }
      const levels: ListLevel[] = Array.from({ length: MAX_LEVELS }, (_, i) => {
        const ph = heads.find((x) => Number(attr(x, "level")) === i + 1);
        const text = ph ? fromHwpxLevelText(textOf(ph)) : "";
        const fmt = (ph && attr(ph, "numFormat")) || "DIGIT";
        const lv: ListLevel = { format: HWPX_NUMFMT_IN[fmt] ?? "decimal", text };
        const st = ph ? Number(attr(ph, "start")) : NaN;
        if (Number.isFinite(st) && st !== 1) lv.start = st;
        const raw = raws.get(i + 1);
        if (ph && raw) lv.hwpx = { fmt, raw, format: lv.format, text, ...(lv.start !== undefined ? { start: lv.start } : {}) };
        return lv;
      });
      const more = [...raws].filter(([l]) => l > MAX_LEVELS).sort((a, b) => a[0] - b[0]).map(([, x]) => x);
      listDefs.set(`hwpx-n${id}`, { id: `hwpx-n${id}`, src: id, levels, ...(more.length ? { hwpxMore: more } : {}) });
    }
    for (const b of descendants(h, "bullet")) {
      const id = attr(b, "id") ?? "";
      const ch = attr(b, "char") || "•";
      const text = ch.length === 1 && ch.charCodeAt(0) >= 0xf000 && ch.charCodeAt(0) <= 0xf0ff ? PUA_BULLETS[ch] ?? "•" : ch;
      // the bullet as written: a symbol-font character (Wingdings 'l', shown ●) or a picture stays so while unchanged
      // (not a picture bullet: its hc:img names a binItem the rewrite does not carry — the character instead, as before)
      const raw = rawBullet.get(id);
      const hw = raw && !/^<[^>]*\suseImage="1"/.test(raw) ? { hwpx: { fmt: "BULLET", raw, format: "bullet", text } } : {};
      listDefs.set(`hwpx-b${id}`, { id: `hwpx-b${id}`, src: id, levels: Array.from({ length: MAX_LEVELS }, () => ({ format: "bullet", text, ...hw })) });
    }
    for (const s of descendants(h, "style")) {
      const m = /^개요\s?(\d)$/.exec(attr(s, "name") ?? "") ?? /^Outline\s?(\d)$/i.exec(attr(s, "engName") ?? ""); // i18n: keep — HWPX style name 개요 n matched in files
      if (m && Number(m[1]) >= 1 && Number(m[1]) <= 6) styleHeading.set(attr(s, "id") ?? "", Number(m[1]));
    }
    for (const b of descendants(h, "borderFill")) {
      const wb = descendants(b, "winBrush")[0];
      const face = wb && attr(wb, "faceColor");
      const top = child(b, "topBorder");
      fills.set(attr(b, "id") ?? "", {
        fill: face && /^#[0-9a-f]{6}$/i.test(face) && face.toUpperCase() !== "#FFFFFF" ? face.toUpperCase() : null,
        border: top && attr(top, "type") !== "NONE" && /^#[0-9a-f]{6}$/i.test(attr(top, "color") ?? "") ? attr(top, "color")!.toLowerCase() : null,
      });
      // every side (paragraph borders): type, width ("0.12 mm"), colour
      const lines: Partial<Record<"left" | "right" | "top" | "bottom", ParaBorderLine>> = {};
      for (const k of ["left", "right", "top", "bottom"] as const) {
        const e = child(b, k + "Border");
        const ty = e ? attr(e, "type") ?? "NONE" : "NONE";
        if (!e || ty === "NONE") continue;
        const mm = parseFloat(attr(e, "width") ?? "0.12");
        const style = ty === "DOUBLE_SLIM" || ty === "DOUBLE" ? "double" : /DASH/.test(ty) ? "dashed" : /DOT/.test(ty) ? "dotted" : undefined;
        const c = attr(e, "color") ?? "#000000";
        lines[k] = { w: Math.round(((Number.isFinite(mm) ? mm : 0.12) * 96 * 1000) / 25.4) / 1000, color: /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : "#000000", space: 0, ...(style ? { style } : {}) };
      }
      sides.set(attr(b, "id") ?? "", { lines, fill: face && /^#[0-9a-f]{6}$/i.test(face) && face.toUpperCase() !== "#FFFFFF" ? face.toLowerCase() : null });
    }
    for (const pb of paraBorders) {
      const s = sides.get(pb.ref);
      const pp = paraPr.get(pb.id);
      if (!s || !pp) continue;
      const border: ParaBorders = {};
      for (const k of ["left", "right", "top", "bottom"] as const) if (s.lines[k]) border[k] = { ...s.lines[k]!, space: Math.round(pb.off[k] * 100) / 100 };
      if (Object.keys(border).length) pp.border = border;
      if (s.fill) pp.shade = s.fill;
    }
  }
  return { charPr, paraPr, styleHeading, fills, fonts, listDefs, charPrLatin };
}

/** Elements `<prefix:name id="…">…</prefix:name>` of an HWPX header by id, exactly as written. */
function hwpxRawElements(xml: string, name: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(String.raw`<((?:\w+:)?)${name}\b[^>]*?\sid="([^"]*)"[^>]*?(?:/>|>[\s\S]*?</\1${name}>)`, "g");
  for (const m of xml.matchAll(re)) if (!out.has(m[2])) out.set(m[2], m[0]);
  return out;
}

/**
 * A numbering / bullet element kept from the file, for a full rewrite: its charPrIDRef (the 번호 글자 모양) named a
 * charPr of the original header — the rewrite numbers its charPrs anew, so it would name another one: "none" (4294967295).
 */
export const hwpxDetached = (raw: string) => raw.replace(/(\scharPrIDRef=")[^"]*"/g, (_, a: string) => `${a}4294967295"`);

/** HWPX hh:paraHead numFormat of a list format (formats read from HWPX: core/lists.ts HWPX_NUMFMT_IN). */
export const HWPX_NUMFMT_OUT: Record<string, string> = {
  decimal: "DIGIT", decimalZero: "DIGIT", circled: "CIRCLED_DIGIT", upperRoman: "ROMAN_CAPITAL", lowerRoman: "ROMAN_SMALL", upperLetter: "LATIN_CAPITAL", lowerLetter: "LATIN_SMALL",
  ganada: "HANGUL_SYLLABLE", chosung: "HANGUL_JAMO", none: "DIGIT", bullet: "DIGIT",
};

/**
 * hh:paraHead of a level read from HWPX: as written while unchanged; else the element with its numFormat, start and
 * text set (the other attributes — align, checkable, charPrIDRef … — as written; numFormat as written while only the
 * marker text changed).
 */
export function hwpxListHead(lv: ListLevel, start: number): string {
  const h = lv.hwpx!;
  if (hwpxLevelKept(lv) && start === (h.start ?? 1)) return hwpxDetached(h.raw);
  const open = /^<((?:\w+:)?)paraHead\b([^>]*?)\/?>/.exec(hwpxDetached(h.raw));
  const prefix = open?.[1] ?? "hh:";
  let attrs = open?.[2] ?? "";
  const fmt = lv.format === h.format ? h.fmt : HWPX_NUMFMT_OUT[lv.format] ?? "DIGIT";
  const set = (name: string, v: string) => (attrs = new RegExp(String.raw`\s${name}="`).test(attrs) ? attrs.replace(new RegExp(String.raw`(\s${name}=")[^"]*"`), `$1${v}"`) : attrs + ` ${name}="${v}"`);
  set("numFormat", fmt);
  set("start", String(start));
  const text = lv.format === "bullet" ? "" : toHwpxLevelText(lv.text);
  return text ? `<${prefix}paraHead${attrs}>${esc(text)}</${prefix}paraHead>` : `<${prefix}paraHead${attrs}/>`;
}

export type HwpxHeaderMaps = ReturnType<typeof hwpxHeaderMaps>;

/** HWPX body in reading order: paragraphs and tables (TABLE nodes on import). */
/**
 * A run split where its text changes language between Latin (U+0000–U+024F: letters, digits, ASCII punctuation and
 * spaces — 한글's LATIN group) and the rest (Hangul, 한자 …), the Latin pieces taking `lat` (font / 장평 / 자간 of the
 * Latin language). One run when the text is all one language.
 */
function byLanguage(run: TextRun, lat: Partial<TextRun>): TextRun[] {
  const latin = { ...run, ...lat };
  for (const k of ["hscale", "spacingPct"] as const) if (latin[k] === undefined || latin[k] === (k === "hscale" ? 100 : 0)) delete latin[k];
  // spaces, tabs and breaks stay with the text before them (no run per word space in Korean text)
  const out: TextRun[] = [];
  let cur = "", curLatin: boolean | null = null;
  for (const ch of run.text) {
    const c = ch.codePointAt(0)!;
    const isLatin: boolean = /\s/.test(ch) && curLatin !== null ? curLatin : c <= 0x24f;
    if (curLatin !== null && isLatin !== curLatin) {
      out.push({ ...(curLatin ? latin : run), text: cur });
      cur = "";
    }
    curLatin = isLatin;
    cur += ch;
  }
  if (cur) out.push({ ...(curLatin ? latin : run), text: cur });
  return out.length ? out : [run];
}

export function parseHwpxFlow(bytes: Uint8Array, report?: OfficeImportReport): OfficeItem[] {
  const files = unzipSync(bytes);
  const sections = Object.keys(files)
    .filter((f) => /^Contents\/section\d+\.xml$/i.test(f))
    .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
  if (!sections.length) throw new Error(tx("engine.office.notHwpx"));

  const { charPr, paraPr, styleHeading, fills, listDefs, charPrLatin } = hwpxHeaderMaps(files["Contents/header.xml"]);
  // pictures (report.pictures given): BinData items of the manifest (Contents/content.hpf) by id
  const pics = report?.pictures;
  const binData = new Map<string, string>();
  if (pics && files["Contents/content.hpf"])
    for (const it of descendants(parseXml(strFromU8(files["Contents/content.hpf"])), "item")) {
      const href = attr(it, "href");
      if (href) binData.set(attr(it, "id") ?? "", href.replace(/^\//, ""));
    }
  let picsSeen = 0;

  const items: OfficeItem[] = [];
  const kinds = new Map<TextParagraph, "li" | "oli">();
  const plists = new Map<TextParagraph, ParaList>();
  /** 한글's saved line starts of text paragraphs (offsets in the text as read, before list markers) */
  const savedLines: { p: TextParagraph; raw: string; at: number[]; right: number; page: number[] | null }[] = [];
  /** vertpos of the last saved line of the body so far (a line above it begins a new page in 한글) */
  let lastVert: number | null = null;
  /** the current section's default tab interval, px (한글 40 pt) */
  let tabStep = Math.round((4000 / 75) * 100) / 100;
  // 개요 번호: the numbering the section names as its outline shape numbers OUTLINE paragraphs (when it has text)
  const firstSec = sections.length ? /<hp:secPr\b[^>]*\boutlineShapeIDRef="(\d+)"/.exec(strFromU8(files[sections[0]]))?.[1] : undefined;
  const outlineDef = firstSec !== undefined ? listDefs.get(`hwpx-n${firstSec}`) : undefined;
  if (outlineDef && outlineDef.levels.some((l) => l.text)) outlineDef.outline = true;

  // footnotes / endnotes: numbered in the first section's shapes (core/notes.ts)
  const firstSecPr = sections.length ? descendants(parseXml(strFromU8(files[sections[0]])).documentElement, "secPr")[0] : undefined;
  const notes = { count: { foot: 0, end: 0 }, pr: hwpxNotePr(firstSecPr) };
  // memos and tracked changes (core/review.ts; Office Surgeon model 9): a memo's text is the comment's, not body
  // paragraphs; text between change marks carries the change (the marks may span hp:t elements and paragraphs)
  const review = !report?.noReview;
  const changes = review ? hwpxTrackChanges(files["Contents/header.xml"]) : new Map<string, never>();
  const revState: HwpxRevState = { rev: null };
  const openMemos = new Set<string>();
  const comments: DocComment[] = [];
  // memo boxes (hh:memoPr) and the one of the section being read (hp:secPr memoShapeIDRef)
  const headerBytes = files["Contents/header.xml"];
  const memoShapes = review && headerBytes ? hwpxMemoShapes(strFromU8(headerBytes)) : new Map<string, MemoShape>();
  let secMemoShape = "";
  /** the change and memos open at the reading position, as run fields */
  const reviewTag = (rev: TextRun["rev"] | null): Partial<TextRun> => {
    for (const id of openMemos) coveredMemos.add(id);
    return review ? { ...(rev ? { rev } : {}), ...(openMemos.size ? { comments: [...openMemos] } : {}) } : {};
  };
  /** memos that took in some text (one ended before any: a memo on no text, kept at its place — DocComment.at) */
  const coveredMemos = new Set<string>();

  const paragraph = (p: Element, runs: TextRun[]): TextParagraph => {
    const pp = paraPr.get(attr(p, "paraPrIDRef") ?? "") ?? { align: "LEFT" as Align, lineSpacing: 1.6, indent: 0, spaceAfter: 4 };
    const { head, ...rest } = pp;
    if (!runs.length) runs.push({ ...DEFAULT_RUN, text: "", fontSize: 10 * PT, ...firstFormat(p) });
    // 한글 sets a word space half an em wide (its PDFs: 0.50 em with 함초롬바탕, whose own space glyph is 0.30 em)
    // and puts the text at the top of its line, the line spacing below it (lineseg baseline = 0.85 × text height)
    const para: TextParagraph = { id: uid("p"), runs, ...rest, spaceEm: 0.5, lineTop: true };
    // a tab reaches the section's next default tab stop (한글 tabStopVal)
    if (runs.some((r) => r.text.includes("\t"))) para.tabStep = tabStep;
    const level = head?.type === "OUTLINE" ? head.level + 1 : styleHeading.get(attr(p, "styleIDRef") ?? "") ?? 0;
    if (level >= 1 && level <= 6) para.role = `h${level}` as TextParagraph["role"];
    else if (head?.type === "BULLET") kinds.set(para, "li");
    else if (head?.type === "NUMBER") kinds.set(para, "oli");
    // multi-level membership: the numbering / bullet the paragraph shape names, at its level
    const lvl = Math.max(0, Math.min(MAX_LEVELS - 1, head?.level ?? 0));
    if ((head?.type === "NUMBER" || head?.type === "BULLET") && listDefs.has(`hwpx-${head.type === "NUMBER" ? "n" : "b"}${head.idRef}`)) {
      const id = `hwpx-${head.type === "NUMBER" ? "n" : "b"}${head.idRef}`;
      plists.set(para, { id, def: id, level: lvl });
    }
    // 개요 1–10: numbered by the outline numbering — 개요 7 and below too (no heading role there: an outline item,
    // ① etc.; the HWPX writer gives it its OUTLINE heading again)
    // (개요 10 has no model level — MAX_LEVELS 9: left out as before, not drawn and written as 개요 9)
    else if (head?.type === "OUTLINE" && outlineDef?.outline && level >= 1 && level <= MAX_LEVELS) plists.set(para, { id: "hwpx-outline", def: outlineDef.id, level: lvl });
    return para;
  };
  const runFormat = (r: Element): Partial<TextRun> => {
    const cp = charPr.get(attr(r, "charPrIDRef") ?? "") ?? {};
    return Object.fromEntries(Object.entries(cp).filter(([, v]) => v !== undefined));
  };
  const firstFormat = (p: Element): Partial<TextRun> => {
    const r = children(p, "run")[0];
    return r ? runFormat(r) : {};
  };
  /**
   * Text of an hp:t. `u`: HWP character units counted on (lineseg textpos: a character 1, a tab 8, marks such as
   * hp:nbSpace 1 — dropped from the text — and markpen / change marks 0; core/layoutcheck/hwpxLineseg.ts) with the
   * unit position of each character pushed to u.pos.
   */
  const runText = (t: Element, u?: { n: number; pos: number[] }) => {
    let text = "";
    for (let n = t.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) {
        const s = n.nodeValue ?? "";
        text += s;
        if (u) for (let i = 0; i < s.length; i++) u.pos.push(u.n++);
      } else if (n.nodeType === 1) {
        const k = (n as Element).localName;
        if (k === "tab" || k === "lineBreak") {
          text += k === "tab" ? "\t" : "\n";
          u?.pos.push(u.n);
        }
        if (u) u.n += k === "tab" ? 8 : /^(markpen|insert|delete)(Begin|End)$|^titleMark$/.test(k) ? 0 : 1;
      }
    }
    return text;
  };

  // headers / footers / page numbers of each section (secs index): 한글 shows a header from the page its control is on
  const hfCols = new Map<number, { hf: SectionHF; at: { header?: number; footer?: number }; early: { header?: TextParagraph[]; footer?: TextParagraph[] }; types: Record<string, Set<string>>; hide: { header?: boolean; footer?: boolean }; fmtSet?: boolean }>();
  const col = () => {
    const k = Math.max(0, secs.length - 1);
    let c = hfCols.get(k);
    if (!c) hfCols.set(k, (c = { hf: {}, at: {}, early: {}, types: { header: new Set(), footer: new Set() }, hide: {} }));
    return c;
  };
  /** a page control of the body: header / footer (with its paragraphs), page number, new number, page hiding */
  const pageCtrl = (k: Element) => {
    const c = col();
    if (k.localName === "header" || k.localName === "footer") {
      const area = k.localName;
      const ps: OfficeItem[] = [];
      for (const sl of children(k, "subList")) for (const ip of children(sl, "p")) visitP(ip, ps, true);
      const paras = flatten(ps);
      const type = attr(k, "applyPageType") ?? "BOTH";
      // 양쪽 = default; 홀수 = default with different odd / even pages; 짝수 = even
      const v = type === "EVEN" ? "even" : "default";
      // a second header of the section further down (after the one at its start): the first one is the first page's
      // (as this app writes Word's different first page with text; flow.ts settles it by the page it is on)
      const had = c.hf[area]?.[v];
      if (had && v === "default" && c.at[area] !== undefined && items.length > c.at[area]! && !c.early[area]) {
        c.early[area] = had;
        c.at[area] = items.length;
      }
      (c.hf[area] ??= {})[v] = paras;
      c.types[area].add(type);
      if (type !== "BOTH") c.hf.evenOdd = true;
      c.at[area] ??= items.length;
    } else if (k.localName === "pageNum") {
      const pos = HWPX_PNPOS[attr(k, "pos") ?? ""];
      const side = (attr(k, "sideChar") ?? "").trim();
      c.hf.pageNum = pos ? { pos, ...(side ? { side } : {}) } : null;
      const fmt = HWPX_PGFMT[attr(k, "formatType") ?? ""];
      if (pos) c.fmtSet = true;
      if (fmt && fmt !== "decimal") c.hf.pageFmt = fmt;
    } else if (k.localName === "newNum" && (attr(k, "numType") ?? "PAGE") === "PAGE") {
      const n = Number(attr(k, "num"));
      if (Number.isFinite(n) && n > 0) c.hf.pageStart = n;
    } else if (k.localName === "pageHiding" && items.length === secs[secs.length - 1]?.start) {
      // hiding on the section's first paragraph: as 한글's 'hide on the first page'
      if (attr(k, "hideHeader") === "1") c.hide.header = true;
      if (attr(k, "hideFooter") === "1") c.hide.footer = true;
      if (attr(k, "hidePageNum") === "1") c.hf.hideFirstNum = true;
    }
  };

  /**
   * A paragraph and what it holds: tables become table items; other objects' text paragraphs follow. `inHF`: a header /
   * footer paragraph (its page and page-count numbers are fields).
   */
  const visitP = (p: Element, out: OfficeItem[], inHF = false, top?: { part: string; b: number }, inNote = false) => {
    const runs: TextRun[] = [];
    let objects = 0;
    let chars = 0;
    const found: { pic: NonNullable<ReturnType<typeof hwpxPicOf>>; el: Element; bytes: Uint8Array; mime: string; offset: number }[] = [];
    // memos on no text in this paragraph (their place: the text offset in the runs read so far)
    const points: { c: DocComment; offset: number }[] = [];
    const placePoints = (para: TextParagraph) => {
      for (const { c, offset } of points.splice(0)) c.at = { para: para.id, offset };
      return para;
    };
    const flush = () => {
      if (runs.length) out.push({ kind: "p", p: placePoints(paragraph(p, runs.splice(0))) });
    };
    // 한글's saved lines (hp:linesegarray) apply to a paragraph of text only: HWP units of the text so far and of
    // each character; `plain` = nothing inline but text and controls without a body (section / column / page)
    const u = { n: 0, pos: [] as number[] };
    let plain = true;
    for (const r of children(p, "run")) {
      const fmt = runFormat(r);
      for (const c of children(r)) {
        // one extended control = 8 units (a hp:ctrl, one per control it holds); hp:t and run-level tab / break below
        if (c.localName === "ctrl") u.n += 8 * Math.max(1, children(c).length);
        else if (c.localName !== "t" && c.localName !== "tab" && c.localName !== "lineBreak") {
          u.n += 8;
          if (c.localName !== "secPr") plain = false;
        }
        if (c.localName === "pic" && top && pics) {
          // a picture of a body paragraph (pictures in table cells and text boxes stay in the original)
          const pic = hwpxPicOf(c);
          const path = pic ? binData.get(pic.ref) : undefined;
          const bytes = path ? files[path] : undefined;
          const mime = bytes && path ? picMime(bytes, path) : undefined;
          if (pic && bytes && mime) found.push({ pic, el: c, bytes, mime, offset: chars });
          // its caption: text paragraphs after it
          for (const sl of outerSubLists(c)) for (const ip of children(sl, "p")) visitP(ip, out, inHF);
          continue;
        }
        if (c.localName === "t") {
          const text = runText(c, u);
          const lat = charPrLatin.get(attr(r, "charPrIDRef") ?? "");
          // (with change marks inside: one run per part, each with its change)
          for (const part of review ? hwpxTextParts(c, revState, changes) : [{ text, rev: null }]) {
            const run: TextRun = { ...DEFAULT_RUN, fontSize: 10 * PT, ...fmt, text: part.text, ...reviewTag(part.rev) };
            if (part.text && lat) runs.push(...byLanguage(run, lat));
            else if (part.text) runs.push(run);
          }
          chars += text.length;
        } else if (c.localName === "tab" || c.localName === "lineBreak") {
          chars++;
          u.pos.push(u.n);
          u.n += c.localName === "tab" ? 8 : 1;
          runs.push({ ...DEFAULT_RUN, fontSize: 10 * PT, ...fmt, text: c.localName === "tab" ? "\t" : "\n", ...reviewTag(revState.rev) });
        } else if (c.localName === "tbl") {
          flush();
          objects++;
          out.push({ kind: "table", table: hwpxTable(c) });
        } else if (c.localName === "ctrl" && review && (hwpxMemoBegin(c) || hwpxFieldEnd(c) !== undefined)) {
          // a memo (메모): its text is a comment of the document, its range the text up to the field end
          const fb = hwpxMemoBegin(c);
          if (fb) {
            const m = hwpxMemo(fb, (q) => descendants(q, "t").map(textOf).join(""), memoShapes, secMemoShape);
            comments.push(m);
            openMemos.add(m.id);
          }
          const end = hwpxFieldEnd(c);
          if (end !== undefined && openMemos.delete(end) && !coveredMemos.has(end)) {
            const m = comments.find((x) => x.id === end);
            if (m) points.push({ c: m, offset: runs.reduce((n, r) => n + r.text.length, 0) });
          }
          continue;
        } else if (c.localName === "ctrl" && inHF && child(c, "autoNum")) {
          // 쪽 번호 / 전체 쪽수 in a header or footer: a field (prefix / suffix characters as text around it)
          const an = child(c, "autoNum")!;
          const kind = HWPX_AUTONUM[attr(an, "numType") ?? ""];
          const f = child(an, "autoNumFormat");
          plain = false; // the field's text is not in 한글's character units
          if (kind) {
            const base = { ...DEFAULT_RUN, fontSize: 10 * PT, ...fmt };
            if (f && attr(f, "prefixChar")) runs.push({ ...base, text: attr(f, "prefixChar")! });
            runs.push({ ...base, text: "1", field: kind });
            if (f && attr(f, "suffixChar")) runs.push({ ...base, text: attr(f, "suffixChar")! });
            const pf = kind === "page" ? HWPX_PGFMT[(f && attr(f, "type")) ?? ""] : undefined;
            if (pf && pf !== "decimal") col().hf.pageFmt ??= pf;
            if (pf) col().fmtSet = true;
          }
        } else if (c.localName === "ctrl" && inNote && child(c, "autoNum")) {
          // the note's own number at the start of its text (shown as its reference shows it)
          plain = false;
          runs.push({ ...DEFAULT_RUN, fontSize: 10 * PT, ...fmt, text: "1", noteMark: true });
        } else if (c.localName === "ctrl" && top && !inHF && !inNote && children(c).some((k) => k.localName === "footNote" || k.localName === "endNote")) {
          // a footnote / endnote: a run showing its mark (on 한글's character units of the control), carrying the note
          const at = u.n - 8 * Math.max(1, children(c).length);
          for (const k of children(c)) {
            if (k.localName !== "footNote" && k.localName !== "endNote") {
              if (HWPX_PAGE_CTRL.has(k.localName)) pageCtrl(k);
              continue;
            }
            const kind = k.localName === "footNote" ? "foot" : "end";
            const ps: OfficeItem[] = [];
            for (const sl of children(k, "subList")) for (const ip of children(sl, "p")) visitP(ip, ps, false, undefined, true);
            const paras = flatten(ps);
            for (const q of paras) plists.delete(q);
            const pr = notes.pr[kind];
            const mark = noteMarkText((pr?.start ?? 1) + notes.count[kind]++, kind, pr);
            const note: NoteRef = { kind, paras: paras.length ? paras : [{ ...newParagraph(""), runs: [{ ...DEFAULT_RUN, fontSize: 9 * PT, text: mark, noteMark: true }] }] };
            const id = attr(k, "instId");
            if (id) note.src = id;
            runs.push({ ...DEFAULT_RUN, fontSize: 10 * PT, ...fmt, text: mark, script: "super", note });
            for (let i = 0; i < mark.length; i++) u.pos.push(at);
            chars += mark.length;
          }
          continue;
        } else if (c.localName === "ctrl" && !inHF && children(c).some((k) => HWPX_PAGE_CTRL.has(k.localName))) {
          for (const k of children(c)) if (HWPX_PAGE_CTRL.has(k.localName)) pageCtrl(k);
          continue;
        } else if (c.localName === "ctrl" && children(c).some((k) => PAGE_STORY.has(k.localName))) {
          // header, footer and note paragraphs belong to the page or the note area, not the body flow (a hidden
          // comment is not printed at all); headers and footers are read with the section (pageCtrl). Notes in table
          // cells and text boxes have no note area here: counted so the open message can say so
          if (report) report.notesDropped += children(c).filter((k) => k.localName === "footNote" || k.localName === "endNote").length;
          continue;
        } else if (descendants(c, "p").length) {
          // text boxes and other drawing objects: their paragraphs follow in reading order
          flush();
          objects++;
          // only the object's own (outermost) subLists: visitP reaches nested objects/tables itself
          for (const sl of outerSubLists(c)) for (const ip of children(sl, "p")) visitP(ip, out, inHF);
        }
      }
    }
    // a paragraph holding nothing but inline pictures: the pictures are its content (no empty text line)
    const picsOnly = found.length > 0 && found.every((f) => f.pic.inline) && !runs.length && !objects;
    const own = (runs.length || !objects) && !picsOnly ? placePoints(paragraph(p, runs)) : null;
    // a change that takes in the paragraph end (hp:insertEnd / hp:deleteEnd paraend="1"): the paragraph mark's change
    if (revState.paraEnd) {
      if (own) own.markRev = revState.paraEnd;
      revState.paraEnd = null;
    }
    const prev = out[out.length - 1];
    if (own) out.push({ kind: "p", p: own });
    // 한글's pages: a body line saved above the line before it starts a new page
    // (a table or other object may run over pages its saved line does not show: after one, the next page start is
    // not known from the lines)
    const pageAt: number[] = [];
    if (top && objects) lastVert = null;
    else if (top)
      children(child(p, "linesegarray") ?? p, "lineseg").forEach((sg, i) => {
        const v = Number(attr(sg, "vertpos"));
        if (!Number.isFinite(v)) return;
        if (lastVert !== null && v < lastVert) pageAt.push(i);
        lastVert = v;
      });
    if (own && plain && !objects && u.pos.length) {
      // 한글's lines: where each line after the first starts (first character at or after its textpos), and the right
      // end shared by all lines (lines narrowed by a floating object are not taken)
      const segs = children(child(p, "linesegarray") ?? p, "lineseg");
      const right = (s: Element) => Number(attr(s, "horzpos")) + Number(attr(s, "horzsize"));
      if (segs.length && segs.every((s) => right(s) === right(segs[0])) && Number.isFinite(right(segs[0]))) {
        const at: number[] = [];
        for (const s of segs.slice(1)) {
          const tp = Number(attr(s, "textpos"));
          const k = u.pos.findIndex((x) => x >= tp);
          at.push(k < 0 ? u.pos.length : k);
        }
        savedLines.push({ p: own, raw: own.runs.map((x) => x.text).join(""), at, right: right(segs[0]) / 75, page: top ? pageAt : null });
      }
    }
    if (top && pics) {
      const all = topPics(p);
      picsSeen += all.length;
      for (const f of found) {
        const pic: OfficePic = {
          id: uid("img"),
          at: out.length,
          // with no item of its own it goes with the item before, unless a page / section begins at it
          tail: !!own || !(breaks.has(out.length) || secs.some((x) => x.start === out.length)),
          bytes: f.bytes,
          mime: f.mime,
          name: f.pic.name || tx("engine.default.image"),
          g: f.pic.g,
          offset: own ? f.offset : 0,
          own: !own,
          part: top.part,
          b: top.b,
          k: all.indexOf(f.el),
          ...(own ? { para: own.id } : prev?.kind === "p" ? { para: prev.p.id } : {}),
        };
        if (f.pic.inline) {
          const look = paraPr.get(attr(p, "paraPrIDRef") ?? "");
          pic.inline = { align: look?.align ?? "LEFT", indent: look?.indentLeft ?? 0, before: own ? 0 : look?.spaceBefore ?? 0, after: own ? 0 : look?.spaceAfter ?? 0 };
        } else pic.float = f.pic.float;
        pics.push(pic);
      }
    }
  };

  const hwpxTable = (tbl: Element): OfficeTable => {
    const rowCnt = Number(attr(tbl, "rowCnt")) || children(tbl, "tr").length;
    const colCnt = Number(attr(tbl, "colCnt")) || 1;
    const grid: (TableCell | null)[][] = Array.from({ length: rowCnt }, () => Array.from({ length: colCnt }, () => null));
    const widths: number[] = new Array(colCnt).fill(0);
    const paras: TextParagraph[] = [];
    let headerCells = 0, firstRowCells = 0;
    children(tbl, "tr").forEach((tr, ri) => {
      let autoCol = 0;
      for (const tc of children(tr, "tc")) {
        const addr = child(tc, "cellAddr");
        const r = addr ? Number(attr(addr, "rowAddr")) : ri;
        const c = addr ? Number(attr(addr, "colAddr")) : autoCol;
        const span = child(tc, "cellSpan");
        const cs = Math.max(1, span ? Number(attr(span, "colSpan")) || 1 : 1), rs = Math.max(1, span ? Number(attr(span, "rowSpan")) || 1 : 1);
        autoCol = c + cs;
        const sz = child(tc, "cellSz");
        if (sz && cs === 1 && c < colCnt && !widths[c]) widths[c] = Math.round((Number(attr(sz, "width")) / 75) * 100) / 100;
        const ps: OfficeItem[] = [];
        for (const sl of children(tc, "subList")) for (const ip of children(sl, "p")) visitP(ip, ps);
        const cellParas = flatten(ps);
        // list items in table cells stay one-level lists (a table node has no list definitions)
        for (const q of cellParas) plists.delete(q);
        paras.push(...cellParas);
        const bf = fills.get(attr(tc, "borderFillIDRef") ?? "");
        const cell = cellFrom(cellParas, bf?.fill ?? null, DEFAULT_TABLE_COLOR);
        if (cs > 1) cell.colSpan = cs;
        if (rs > 1) cell.rowSpan = rs;
        // 한글 cells: content centred / at the bottom, and the cell's own height (the row is at least that tall)
        const va = attr(children(tc, "subList")[0] ?? tc, "vertAlign");
        if (va === "CENTER") cell.vAlign = "middle";
        else if (va === "BOTTOM") cell.vAlign = "bottom";
        const ch = sz ? Number(attr(sz, "height")) / 75 : NaN;
        if (rs === 1 && ch > 0) cell.minHeight = Math.round(ch * 100) / 100;
        if (r < rowCnt && c < colCnt) grid[r][c] = cell;
        if (r === 0) {
          firstRowCells++;
          if (attr(tc, "header") === "1") headerCells++;
        }
      }
    });
    // spans that run past a missing width: share the merged width
    for (let i = 0; i < colCnt; i++) if (!widths[i]) widths[i] = 100;
    const bf = fills.get(attr(tbl, "borderFillIDRef") ?? "");
    const t = tableFrom(grid, widths, firstRowCells > 0 && headerCells === firstRowCells, paras, bf?.border ?? null);
    // cells drawn from their own paragraphs inside 한글's cell margins (hp:inMargin; 한글's default 510 / 141 HWPUNIT)
    const im = child(tbl, "inMargin");
    const mv = (k: string, d: number) => {
      const v = im ? Number(attr(im, k)) : NaN;
      return (Number.isFinite(v) && v >= 0 ? v : d) / 75;
    };
    t.style.cellBox = { padX: Math.round(((mv("left", 510) + mv("right", 510)) / 2) * 100) / 100, padY: Math.round(((mv("top", 141) + mv("bottom", 141)) / 2) * 100) / 100 };
    // 쪽 경계에서 '나눔' (HWP 5.0 표 속성 bits 0–1 = 2): a row cut between its lines at a page end (omni-hwp-tables PDF:
    // row 11 starts on page 2 and ends on page 3); TABLE (셀 단위로 나눔) and NONE keep rows whole
    if (attr(tbl, "pageBreak") === "CELL") t.style.cellBox.cut = true;
    return t;
  };

  // page layout: a section per section file (and per further hp:secPr), hard breaks from pageBreak / columnBreak
  // (one column only: a column break moves to the next page like 한글 does in a one-column section)
  const breaks = new Set<number>();
  const secs: OfficeLayout["sections"] = [];
  let secOrd = 0;
  for (const s of sections) {
    const sec = parseXml(strFromU8(files[s]));
    lastVert = null;
    const counts: number[] = [];
    let fileStart: number | null = items.length;
    children(sec.documentElement, "p").forEach((p, pIndex) => {
      const before = items.length;
      if (attr(p, "pageBreak") === "1" || attr(p, "columnBreak") === "1" || paraPr.get(attr(p, "paraPrIDRef") ?? "")?.pageBreakBefore) breaks.add(before);
      const secPr = children(p, "run").flatMap((r) => children(r, "secPr"))[0];
      if (secPr) {
        // default tab stops: tabStopVal in HWPUNIT (tabStop beside it is twice that, like the hp:default margins)
        const tv = Number(attr(secPr, "tabStopVal")), ts = Number(attr(secPr, "tabStop"));
        tabStep = Math.round(((tv > 0 ? tv : ts > 0 ? ts / 2 : 4000) / 75) * 100) / 100;
        secMemoShape = attr(secPr, "memoShapeIDRef") ?? "";
      }
      if (secPr || fileStart !== null) {
        const at = fileStart ?? before;
        const setup = secPr ? hwpxSetup(secPr) : secs[secs.length - 1]?.setup ?? hwpxSetup(undefined);
        const src = secPr ? secOrd++ : undefined;
        const last = secs[secs.length - 1];
        if (last && last.start === at) Object.assign(last, { setup, src });
        else if (secPr || !last) secs.push({ start: at, setup, src });
        if (secPr) {
          fileStart = null;
          // page numbering and first-page hiding of the section (hp:startNum page 0 = continue)
          const sn = child(secPr, "startNum");
          const startPage = sn ? Number(attr(sn, "page")) : 0;
          if (startPage > 0) col().hf.pageStart = startPage;
          const vis = child(secPr, "visibility");
          if (vis && attr(vis, "hideFirstHeader") === "1") col().hide.header = true;
          if (vis && attr(vis, "hideFirstFooter") === "1") col().hide.footer = true;
          if (vis && attr(vis, "hideFirstPageNum") === "1") col().hf.hideFirstNum = true;
        }
      }
      visitP(p, items, false, { part: s, b: pIndex });
      counts.push(items.length - before);
    });
    // a section file without settings still starts a new section (with the settings before it)
    if (fileStart !== null && fileStart < items.length && secs[secs.length - 1]?.start !== fileStart) secs.push({ start: fileStart, setup: secs[secs.length - 1]?.setup ?? hwpxSetup(undefined) });
    report?.sectionBlocks?.push({ part: s, items: counts });
  }
  if (pics && report) {
    // pictures not read (in table cells, text boxes, unsupported formats): they stay in the original only
    const read = pics.filter((x) => /^Contents\/section/.test(x.part)).length;
    if (picsSeen > read) report.picturesKept = (report.picturesKept ?? 0) + picsSeen - read;
  }
  const defs = usedDefs(plists, listDefs);
  addMarkers(kinds, plists, defs);
  const out = renumberItems(items, defs);
  if (report && defs.length) report.lists = defs;
  // 한글's lines on the paragraphs as they now are (a list marker before the text moves every start by its length;
  // renumbering may have replaced a paragraph object — the same id)
  const finalOf = new Map<string, TextParagraph>();
  for (const it of out) if (it.kind === "p") finalOf.set(it.p.id, it.p);
  for (const s of savedLines) {
    const q = finalOf.get(s.p.id) ?? s.p;
    const text = q.runs.map((x) => x.text).join("");
    if (!text.endsWith(s.raw)) continue;
    const shift = text.length - s.raw.length;
    q.hwpLines = { at: s.at.map((a) => a + shift), right: Math.round(s.right * 100) / 100, sig: hwpLinesSig(q), ...(s.page ? { page: s.page } : {}) };
  }
  // headers / footers: 홀수 only → blank even pages, 짝수 only → blank odd pages; the item each first appears at and
  // what is hidden on the section's first page go with the section (io/formats/flow.ts settles them per page)
  // different odd / even pages is the document's setting (on the first section); with it, a 양쪽 (BOTH) header is the
  // even pages' one too
  const evenOddDoc = [...hfCols.values()].some((c) => c.hf.evenOdd);
  for (const [k, c] of hfCols) {
    const sec = secs[k];
    if (!sec) continue;
    delete c.hf.evenOdd;
    for (const area of ["header", "footer"] as const) {
      const ty = c.types[area];
      if (ty.has("ODD") && !ty.has("EVEN") && c.hf[area]) c.hf[area]!.even ??= [];
      if (ty.has("EVEN") && !ty.has("ODD") && !ty.has("BOTH") && c.hf[area]) c.hf[area]!.default ??= [];
      if (evenOddDoc && ty.has("BOTH") && !ty.has("EVEN") && c.hf[area]?.default) c.hf[area]!.even ??= c.hf[area]!.default!.map((q) => ({ ...q, id: uid("p") }));
    }
    if (Object.keys(c.hf).length) sec.hf = c.hf;
    if (c.at.header !== undefined || c.at.footer !== undefined) sec.hfAt = c.at;
    if (c.early.header || c.early.footer) sec.hfEarly = c.early;
    if (c.hide.header || c.hide.footer) sec.hfHide = c.hide;
  }
  // 한글: a page number keeps the shape of its own control (쪽 번호 매기기, or the automatic number of a header the
  // later sections show too) until a section sets another; the model's pageFmt is per section (Word), so it is said
  // on each section that goes on with a shape other than 1 2 3
  let shape: PageNumFormat = "decimal";
  secs.forEach((sec, k) => {
    if (hfCols.get(k)?.fmtSet) shape = sec.hf?.pageFmt ?? "decimal";
    else if (shape !== "decimal" && !sec.hf?.pageFmt) sec.hf = { ...(sec.hf ?? {}), pageFmt: shape };
  });
  if (evenOddDoc && secs[0]) secs[0].hf = { ...(secs[0].hf ?? {}), evenOdd: true };
  if (report)
    report.layout = {
      pageBreaks: [...breaks].filter((i) => i > 0 && i < items.length).sort((a, b) => a - b),
      sections: secs.filter((x, i) => i === 0 || (x.start > 0 && x.start < items.length)).map((x, i) => (i === 0 ? { ...x, start: 0 } : x)),
      ...(notes.count.foot || notes.count.end ? { notePr: notes.pr } : {}),
      ...(comments.length ? { comments } : {}),
      ...(review && hwpxTracking(files["Contents/header.xml"]) ? { trackChanges: true as const } : {}),
      pageRules: "hwp" as const,
    };
  return out;
}

/** 한글 쪽 번호 / 자동 번호 모양 ↔ page number format (others read as 1 2 3) */
const HWPX_PGFMT: Record<string, PageNumFormat> = { DIGIT: "decimal", ROMAN_SMALL: "lowerRoman", ROMAN_CAPITAL: "upperRoman", LATIN_SMALL: "lowerLetter", LATIN_CAPITAL: "upperLetter", HANGUL_SYLLABLE: "ganada" };
export const HWPX_PGFMT_OUT: Record<PageNumFormat, string> = { decimal: "DIGIT", lowerRoman: "ROMAN_SMALL", upperRoman: "ROMAN_CAPITAL", lowerLetter: "LATIN_SMALL", upperLetter: "LATIN_CAPITAL", dash: "DIGIT", ganada: "HANGUL_SYLLABLE" };
/** hp:pageNum pos ↔ position */
const HWPX_PNPOS: Record<string, PageNumPos> = {
  TOP_LEFT: "top-left", TOP_CENTER: "top-center", TOP_RIGHT: "top-right", BOTTOM_LEFT: "bottom-left", BOTTOM_CENTER: "bottom-center", BOTTOM_RIGHT: "bottom-right",
  OUTSIDE_TOP: "top-outside", OUTSIDE_BOTTOM: "bottom-outside", INSIDE_TOP: "top-inside", INSIDE_BOTTOM: "bottom-inside",
};
export const HWPX_PNPOS_OUT = Object.fromEntries(Object.entries(HWPX_PNPOS).map(([k, v]) => [v, k])) as Record<PageNumPos, string>;
const HWPX_AUTONUM: Record<string, FieldKind> = { PAGE: "page", TOTAL_PAGE: "pages" };
/** controls of a body paragraph that set up the page: header, footer, page number, new number, page hiding */
const HWPX_PAGE_CTRL = new Set(["header", "footer", "pageNum", "newNum", "pageHiding"]);

/** 한글's automatic number (쪽 번호 / 전체 쪽수) in a header or footer; "- 1 -" as prefix / suffix characters. */
export function hwpxAutoNum(field: "page" | "pages", fmt: PageNumFormat): string {
  const dash = field === "page" && fmt === "dash";
  const type = field === "page" ? HWPX_PGFMT_OUT[fmt] : "DIGIT";
  return `<hp:ctrl><hp:autoNum num="1" numType="${field === "page" ? "PAGE" : "TOTAL_PAGE"}"><hp:autoNumFormat type="${type}" userChar="" prefixChar="${dash ? "- " : ""}" suffixChar="${dash ? " -" : ""}" supscript="0"/></hp:autoNum></hp:ctrl>`;
}

/** 한글 쪽 번호 매기기 (hp:pageNum): position, number shape, side character ("- 1 -": DIGIT with "-"). */
export function hwpxPageNumXml(pn: { pos: PageNumPos; side?: string } | null, fmt: PageNumFormat): string {
  const side = pn?.side ?? (fmt === "dash" ? "-" : "");
  return `<hp:pageNum pos="${pn ? HWPX_PNPOS_OUT[pn.pos] ?? "BOTTOM_CENTER" : "NONE"}" formatType="${HWPX_PGFMT_OUT[fmt]}" sideChar="${esc(side)}"/>`;
}

export interface HwpxHFSection {
  /** header / footer controls the section declares (양쪽 / 홀수 / 짝수), with the number format of their page numbers */
  ctrls: { area: "header" | "footer"; type: "BOTH" | "ODD" | "EVEN"; paras: TextParagraph[]; fmt: PageNumFormat }[];
  /** controls on the section's second page (after a first page with a header / footer of its own) */
  later?: HwpxHFSection["ctrls"];
  /** page number control (undefined = none declared here) */
  pageNum?: { pos: PageNumPos; side?: string } | null;
  fmt: PageNumFormat;
  start?: number;
  hideHeader?: boolean;
  hideFooter?: boolean;
  hideNum?: boolean;
}

const blankParas = (ps: readonly TextParagraph[] | undefined) => !ps || ps.every((p) => p.runs.every((r) => !r.text.trim() && !r.field));

/**
 * The 한글 controls of each section: a header / footer where the section has its own, or where its number format
 * differs from the one the inherited header was written with (한글 keeps the shape in each automatic number); Word's
 * different first page as 'hide on the first page' when that page's header / footer is blank (a first page with other
 * text shows the usual header — 한글 has no first-page header); the page number control where it changes.
 */
export function hwpxHFSections(hfs: readonly (SectionHF | undefined)[], evenOdd: boolean): HwpxHFSection[] {
  const eff: Record<string, TextParagraph[] | undefined> = {};
  const wrote: Record<string, PageNumFormat> = {};
  let pn: { pos: PageNumPos; side?: string } | null = null;
  let pnFmt: PageNumFormat | null = null;
  return hfs.map((hf, k) => {
    const fmt = hf?.pageFmt ?? "decimal";
    const out: HwpxHFSection = { ctrls: [], fmt };
    for (const area of ["header", "footer"] as const) {
      for (const v of evenOdd ? (["default", "even"] as const) : (["default"] as const)) {
        const own = hf?.[area]?.[v];
        if (own) eff[area + v] = own;
        const content = eff[area + v];
        const hasPage = !!content?.some((p) => p.runs.some((r) => r.field === "page"));
        if (own || (k > 0 && content && hasPage && wrote[area + v] !== fmt)) {
          out.ctrls.push({ area, type: v === "even" ? "EVEN" : evenOdd ? "ODD" : "BOTH", paras: content ?? [], fmt });
          wrote[area + v] = fmt;
        }
      }
      if (hf?.titlePg) {
        const first = hf[area]?.first ?? eff[area + "first"];
        if (hf[area]?.first) eff[area + "first"] = hf[area]!.first;
        if (blankParas(first)) out[area === "header" ? "hideHeader" : "hideFooter"] = true;
        else {
          // a first page with its own text: 한글 shows a header from the page its control is on — the first page's
          // text at the section start, the usual one again on the section's second page (QA ui-audit #32, #50: it
          // was dropped and the usual header shown on the first page)
          const type = evenOdd ? "ODD" : "BOTH";
          const at = out.ctrls.findIndex((c) => c.area === area && c.type === type);
          const usual = eff[area + "default"] ?? [];
          if (at >= 0) out.ctrls[at] = { ...out.ctrls[at], paras: first! };
          else out.ctrls.push({ area, type, paras: first!, fmt });
          (out.later ??= []).push({ area, type, paras: usual, fmt });
          wrote[area + "default"] = fmt;
        }
      } else if (hf?.[area]?.first) eff[area + "first"] = hf[area]!.first;
    }
    if (hf?.pageNum !== undefined) pn = hf.pageNum;
    if (hf?.pageNum !== undefined || (pn && pnFmt !== fmt)) {
      out.pageNum = pn;
      pnFmt = fmt;
    }
    if (hf?.pageStart != null) out.start = Math.max(1, Math.round(hf.pageStart));
    if (hf?.hideFirstNum) out.hideNum = true;
    return out;
  });
}

/** HWPX paragraphs in reading order (tables flattened to their cell paragraphs). */
export function parseHwpx(bytes: Uint8Array): TextParagraph[] {
  return flatten(parseHwpxFlow(bytes));
}

// ───────────────────────── pagination ─────────────────────────

/**
 * Flow paragraphs onto as many pages as needed (A4 with the default margins unless `setup` says otherwise); pages after
 * the first continue the flow (breakBefore "flow").
 */
export function paginate(paras: TextParagraph[], title: string, setup?: PageSetup, text?: Pick<OfficeLayout, "wordBreak" | "cjkSpace" | "hangPunct" | "justifyShrink" | "autoSpace" | "lang" | "wordSpacing">): Page[] {
  const { width, height } = setup ?? PAGE_PRESETS.A4;
  const margins = setup && storedMargins(setup.margins);
  const box = bodyBox({ width, height, margins });
  const boxW = box.w, boxH = box.h;
  const pages: Page[] = [];
  let current: TextParagraph[] = [];
  const emit = () => {
    const page = newPage("DOCUMENT", width, height, tx("engine.default.pageOfFile", { title, page: pages.length + 1 }));
    if (margins) page.margins = margins;
    if (pages.length) page.breakBefore = "flow";
    const node = newText("", boxW);
    textOpts(node, text);
    node.paragraphs = current.length ? current : node.paragraphs;
    node.name = tx("engine.default.body");
    node.transform = { x: box.x, y: box.y, rotation: 0, scale: 1 };
    page.nodes.push(node);
    pages.push(page);
    current = [];
  };
  const probe = newText("", boxW);
  textOpts(probe, text);
  for (const p of paras) {
    const trial: TextNode = { ...probe, paragraphs: [...current, p] };
    if (current.length && layoutText(trial).height > boxH) emit();
    current.push(p);
  }
  if (current.length || !pages.length) emit();
  return pages;
}

// ───────────────────────── export helpers ─────────────────────────

export type FlowItem = { kind: "p"; p: TextParagraph } | { kind: "table"; t: TableNode };

/** `starts` (optional) receives, for every page, the index of its first flow item (out.length when it has none). */
export function collectFlow(pages: Page[], starts?: number[]): FlowItem[] {
  const out: FlowItem[] = [];
  let prevPage = -1; // page of the last table item
  pages.forEach((p, pi) => {
    starts?.push(out.length);
    // (the note areas the body flow lays out are not body text: the notes are written from their references)
    for (const n of [...p.nodes].filter((x) => !x.notes).sort((a, b) => a.transform.y - b.transform.y || a.transform.x - b.transform.x))
      if (n.type === "TEXT")
        for (const p of n.paragraphs) {
          // a paragraph cut at a page end by the body flow (core/flow.ts) is written as the one paragraph it is
          const prev = out[out.length - 1];
          if (p.flowCont && prev?.kind === "p" && prev.p.flowSplit && prev.p.id === p.flowCont) prev.p = joinSplit(prev.p, p);
          else out.push({ kind: "p" as const, p: p.flowCont ? unpiece(p) : p });
        }
      else if (n.type === "TABLE") {
        // A table split across pages (flowBlocks: same name and columns, continued at the top of the next
        // page, header row repeated when it has one) is written as one table again, so merged cells that
        // cross the page break and the table count survive a round trip.
        const prev = out[out.length - 1];
        const cont =
          (prev?.kind === "table" && !!n.flowCont && prev.t.id === n.flowCont) ||
          (prev?.kind === "table" &&
          prevPage === pi - 1 &&
          prev.t.name === n.name &&
          prev.t.headerRow === n.headerRow &&
          prev.t.colWidths.length === n.colWidths.length &&
          prev.t.colWidths.every((w, i) => Math.abs(w - n.colWidths[i]) < 0.5) &&
          (!n.headerRow || JSON.stringify(n.rows[0]?.map((c) => c.text)) === JSON.stringify(prev.t.rows[0]?.map((c) => c.text))));
        // (a row the flow cut at the page end, TableNode.cutRow, is one row again: core/flow.ts joinTable)
        if (cont && prev.kind === "table") prev.t = n.headerRow && n.rows.length <= 1 ? { ...prev.t, rows: [...prev.t.rows] } : joinTable(prev.t, n);
        else out.push({ kind: "table", t: n });
        prevPage = pi;
      }
  });
  for (const it of out) {
    if (it.kind === "p" && it.p.flowSplit) it.p = unpiece(it.p);
    if (it.kind === "table") it.t = endCut(it.t);
    // objects in the text like characters (core/flow.ts): written from their IMAGE node's place, not as text
    if (it.kind === "p" && it.p.runs.some((r) => r.obj)) it.p = withoutObjs(it.p);
  }
  return out;
}

const noObjMemo = new WeakMap<TextParagraph, TextParagraph>();
function withoutObjs(p: TextParagraph): TextParagraph {
  let v = noObjMemo.get(p);
  if (!v) {
    const runs = p.runs.filter((r) => !r.obj);
    v = { ...p, runs: runs.length ? runs : [{ ...p.runs[0], text: "", obj: undefined }] };
    if (!runs.length) delete v.runs[0].obj;
    noObjMemo.set(p, v);
  }
  return v;
}

/** One page as the word-processor writers see it: how it begins, its flow items [from, to) and its section. */
export interface FlowPage {
  begin: "first" | "flow" | "page" | "section";
  from: number;
  to: number;
  section: number;
}

/**
 * Pages in flow terms (collectFlow `starts`): sections as core/pageSetup sectionsOf groups the pages, and per page
 * whether a hard page break ("page") or a section break ("section") comes before it — pages that continue the flow
 * ("flow") have none.
 */
export function flowLayout(pages: Page[], starts: number[], total: number): { sections: PageSetup[]; pages: FlowPage[]; hfs: (SectionHF | undefined)[] } {
  const runs = sectionsOf(pages);
  const legacy = legacyWordPages(pages);
  const out = pages.map((_p, i): FlowPage => {
    const section = runs.findIndex((r) => i >= r.start && i < r.end);
    const begin = i === 0 ? "first" : runs[section].start === i ? "section" : hardBreakBefore(pages, i, legacy) ? "page" : "flow";
    return { begin, from: starts[i], to: starts[i + 1] ?? total, section };
  });
  // headers / footers / numbering of each section: on its first page (core/headerFooter.ts)
  return { sections: runs.map((r) => r.setup), pages: out, hfs: runs.map((r) => pages[r.start].hf) };
}

/**
 * List numbering per paragraph: one bullet list id, a fresh numbered list per run of "oli" paragraphs.
 * Body paragraphs form one sequence (a table ends a run); each table cell written from its imported
 * paragraphs is a sequence of its own.
 */
function listIds(flow: FlowItem[]): Map<TextParagraph, { kind: "li" | "oli"; id: number }> {
  const seqs: (TextParagraph | null)[][] = [flow.map((it) => (it.kind === "p" ? it.p : null))];
  for (const it of flow) if (it.kind === "table") for (const row of it.t.rows) for (const c of row) seqs.push(cellRich(c) ?? []);
  const out = new Map<TextParagraph, { kind: "li" | "oli"; id: number }>();
  let group = 0;
  for (const seq of seqs) {
    let inGroup = false;
    for (const p of seq) {
      if (p?.list) {
        inGroup = false; // a multi-level item (multiLists) ends a one-level run
      } else if (p?.role === "oli") {
        if (!inGroup) group++;
        inGroup = true;
        out.set(p, { kind: "oli", id: group });
      } else {
        inGroup = false;
        if (p?.role === "li") out.set(p, { kind: "li", id: 0 });
      }
    }
  }
  return out;
}

/** Every list definition the text nodes of `pages` carry (ids are unique: presets, imported or made in the dialog). */
export function pageListDefs(pages: Page[]): ListDef[] {
  const out = new Map<string, ListDef>();
  for (const pg of pages) for (const n of pg.nodes) if (n.type === "TEXT") for (const d of n.lists ?? []) if (!out.has(d.id)) out.set(d.id, d);
  return [...out.values()];
}

/** Multi-level list paragraphs of a flow (body, then imported cell paragraphs), in document order. */
export function flowListParas(flow: FlowItem[]): TextParagraph[] {
  const out: TextParagraph[] = [];
  for (const it of flow)
    if (it.kind === "p") {
      if (it.p.list) out.push(it.p);
    } else for (const row of it.t.rows) for (const c of row) for (const p of cellRich(c) ?? []) if (p.list) out.push(p);
  return out;
}

/**
 * Real numbering for multi-level list paragraphs: one definition per list definition in use (`defs[k]`), one
 * instance per list id — and a further instance where an item restarts the numbers (Word counts per w:num, 한글 per
 * numbering), which starts at that item's number. `of(p)` gives the paragraph's definition index, instance index
 * and level.
 */
export function multiLists(paras: TextParagraph[], allDefs: readonly ListDef[]) {
  const defs: ListDef[] = [];
  const defIdx = new Map<string, number>();
  const insts: { def: number; starts: Map<number, number> }[] = [];
  const cur = new Map<string, number>();
  const at = new Map<TextParagraph, { def: number; inst: number; level: number }>();
  for (const p of paras) {
    const l = p.list!;
    let d = defIdx.get(l.def);
    if (d === undefined) {
      d = defs.push(resolveDef(l.def, allDefs)) - 1;
      defIdx.set(l.def, d);
    }
    let inst = cur.get(l.id);
    if (inst === undefined || l.start != null) {
      inst = insts.push({ def: d, starts: new Map(l.start != null ? [[l.level, l.start]] : []) }) - 1;
      cur.set(l.id, inst);
    }
    at.set(p, { def: d, inst, level: Math.max(0, Math.min(MAX_LEVELS - 1, l.level)) });
  }
  return { defs, insts, of: (p: TextParagraph) => at.get(p) };
}

/** w:abstractNum of a list definition. */
export function docxAbstractNum(id: number, def: ListDef): string {
  const lvls = Array.from({ length: MAX_LEVELS }, (_, i) => {
    const lv = levelOf(def, i);
    const fmt = docxNumFmt(lv.format);
    const { left, first } = levelIndent(lv);
    const ind = left || first ? `<w:pPr><w:ind w:left="${twip(left)}"${first < 0 ? ` w:hanging="${twip(-first)}"` : ` w:firstLine="${twip(first)}"`}/></w:pPr>` : "";
    return `<w:lvl w:ilvl="${i}"><w:start w:val="${lv.start ?? 1}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${esc(lv.text)}"/><w:lvlJc w:val="left"/>${ind}</w:lvl>`;
  }).join("");
  return `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="${def.levels.length > 1 ? "multilevel" : "singleLevel"}"/>${lvls}</w:abstractNum>`;
}

/** w:num elements for the instances (numId = first + index), with the restart number of the item that began each. */
const docxNums = (insts: { def: number; starts: Map<number, number> }[], firstAbs: number, firstNum: number) =>
  insts
    .map(
      (n, i) =>
        `<w:num w:numId="${firstNum + i}"><w:abstractNumId w:val="${firstAbs + n.def}"/>${[...n.starts].map(([l, s]) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="${s}"/></w:lvlOverride>`).join("")}</w:num>`,
    )
    .join("");

/** Paragraph runs without the list marker text (export writes real numbering instead). */
const bodyRuns = (p: TextParagraph) => {
  const m = markerLength(p);
  return m ? dropChars(p.runs, m) : p.runs;
};

const hex6 = (c: string) => {
  const m = /^#([0-9a-f]{6})/i.exec(c);
  return m ? m[1].toUpperCase() : "000000";
};

// ───────────────────────── DOCX export ─────────────────────────

// The pieces below are shared with the Office Surgeon (io/officesurgeon/docx.ts), which writes changed
// paragraphs into an original document.
const JC_OUT: Record<Align, string> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFY: "both" };
const twip = (px: number) => Math.round((px / PT) * 20);

/**
 * Absolute letter spacing (px) a run is drawn with: its letterSpacing plus 한글 자간 (spacingPct, a percent of each
 * character's own advance) taken at the run's average character advance. Formats with one absolute value per run
 * (Word w:spacing, PPTX spc) get this — an approximation for text whose characters differ in width.
 */
export function absoluteSpacing(r: TextRun): number {
  const ls = r.letterSpacing ?? 0;
  if (!r.spacingPct) return ls;
  // 한글 adds the share after every character, spaces too (measured: a −5 % run is 5.0 % narrower in all), and Word
  // adds w:spacing after every character too: the same total is the run's whole advance ÷ its characters
  const n = graphemes(r.text).length;
  const w = n ? measure(r.text, runFont(r)) / n : r.fontSize;
  return ls + ((w * (r.hscale ?? 100)) / 100) * (r.spacingPct / 100);
}

/** w:rPr content of a run (CT_RPr child order: rFonts b i strike shadow color spacing w sz u shd vertAlign); `shadow` = Word's on/off character shadow. */
export const docxRPr = (r: TextRun, shadow = false) => {
  const sp = Math.round((absoluteSpacing(r) / PT) * 20);
  return (
    `<w:rFonts w:ascii="${esc(r.latinFont ?? r.fontFamily)}" w:hAnsi="${esc(r.latinFont ?? r.fontFamily)}" w:eastAsia="${esc(r.fontFamily)}"/>` +
    (r.bold ? "<w:b/>" : "") + (r.italic ? "<w:i/>" : "") + (r.strike ? "<w:strike/>" : "") + (shadow ? "<w:shadow/>" : "") +
    `<w:color w:val="${hex6(r.color)}"/>` +
    (sp ? `<w:spacing w:val="${sp}"/>` : "") +
    (r.hscale && r.hscale !== 100 ? `<w:w w:val="${Math.round(Math.max(1, Math.min(600, r.hscale)))}"/>` : "") +
    `<w:sz w:val="${Math.round((r.fontSize / PT) * 2)}"/>` +
    (r.underline ? '<w:u w:val="single"/>' : "") +
    (r.highlight ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(r.highlight)}"/>` : "") +
    (r.script ? `<w:vertAlign w:val="${r.script === "super" ? "superscript" : "subscript"}"/>` : "")
  );
};

// ── footnotes / endnotes (core/notes.ts) ──

/** While a DOCX is written (exportDocx, the Office Surgeon): the w:id each note is written with. */
let docxNoteIdMap: Map<NoteRef, string> | null = null;
let docxNoteKind: "foot" | "end" = "foot";
export function useDocxNoteIds(ids: Map<NoteRef, string> | null) {
  docxNoteIdMap = ids;
}
/** the w:id a note is written with now (undefined: none) */
export const docxNoteId = (n: NoteRef) => docxNoteIdMap?.get(n);

/** The w:r of a note reference or of a note's own mark (null for other runs; "" for a note without an id: left out). */
export function docxNoteRunXml(r: TextRun, rPr: string): string | null {
  if (r.note) {
    const id = docxNoteIdMap?.get(r.note);
    if (id === undefined) return "";
    const tag = r.note.kind === "end" ? "endnoteReference" : "footnoteReference";
    return `<w:r>${rPr}<w:${tag}${r.note.custom ? ' w:customMarkFollows="1"' : ""} w:id="${id}"/>${r.note.custom ? docxText(r.text) : ""}</w:r>`;
  }
  if (r.noteMark) return `<w:r>${rPr}<w:${docxNoteKind === "end" ? "endnoteRef" : "footnoteRef"}/></w:r>`;
  return null;
}

/** A w:footnote / w:endnote element: the note's paragraphs as `para` writes them (its mark run as Word's w:footnoteRef). */
export function docxNoteXml(kind: "foot" | "end", id: string, paras: readonly TextParagraph[], para: (p: TextParagraph) => string, open?: string): string {
  const was = docxNoteKind;
  docxNoteKind = kind;
  try {
    return `${open ?? `<w:${kind}note w:id="${id}">`}${paras.map(para).join("")}</w:${kind}note>`;
  } finally {
    docxNoteKind = was;
  }
}

export const DOCX_NOTE_TYPES = {
  foot: { part: "word/footnotes.xml", ct: "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml", rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" },
  end: { part: "word/endnotes.xml", ct: "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml", rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes" },
};

/** A whole footnotes.xml / endnotes.xml: Word's separator and continuation separator, then `notes`. */
export function docxNotesPartXml(kind: "foot" | "end", notes: string): string {
  const sep = (type: string, el: string) => `<w:${kind}note w:type="${type}" w:id="${type === "separator" ? -1 : 0}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${el}/></w:r></w:p></w:${kind}note>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${kind}notes ${W_NS}>${sep("separator", "separator")}${sep("continuationSeparator", "continuationSeparator")}${notes}</w:${kind}notes>`;
}

/** The notes of written items in order (references in body paragraphs). */
export function flowNotes(flow: readonly FlowItem[]): NoteRef[] {
  const out: NoteRef[] = [];
  for (const it of flow) if (it.kind === "p") for (const r of it.p.runs) if (r.note) out.push(r.note);
  return out;
}

/** One w:r per run; `rPrOf` may return an original w:rPr element to reuse instead of a new one. */
export const docxRuns = (runs: TextRun[], rPrOf?: (r: TextRun) => string | null | undefined, shadow = false) =>
  runs
    .map((r) => {
      const nx = r.note || r.noteMark ? docxNoteRunXml(r, rPrOf?.(r) ?? `<w:rPr>${docxRPr(r, shadow)}</w:rPr>`) : null;
      if (nx != null) return nx;
      // (a tracked insertion / deletion: inside Word's w:ins / w:del, officeReview.ts; a format change made here: its
      // w:rPrChange with the format before it)
      const former = formerRun(r);
      const rPr = rPrOf?.(r) ?? (former ? docxWithRPrChange(`<w:rPr>${docxRPr(r, shadow)}</w:rPr>`, r.fmtRev!, docxRPr(former, shadow)) : `<w:rPr>${docxRPr(r, shadow)}</w:rPr>`);
      const run = docxRevXml(r, `<w:r>${rPr}${docxText(r.field && !r.text ? "1" : r.text)}</w:r>`);
      // a field (header / footer page number …): Word's simple field with the value shown now as its result
      return r.field ? `<w:fldSimple w:instr="${esc(r.fieldCode ?? DOCX_FIELD_INSTR[r.field])}">${run}</w:fldSimple>` : run;
    })
    .join("");

/** Word field instruction of each field (a DATE read from a file keeps its own, fieldCode). */
export const DOCX_FIELD_INSTR: Record<FieldKind, string> = { page: " PAGE  \\* MERGEFORMAT ", pages: " NUMPAGES  \\* MERGEFORMAT ", secpages: " SECTIONPAGES  \\* MERGEFORMAT ", date: ' DATE \\@ "yyyy-MM-dd" ', file: " FILENAME " };

/** Runs as written: a list paragraph without its marker text (the numbering draws it). */
export const docxBodyRuns = (p: TextParagraph, list: boolean) => (list ? bodyRuns(p) : p.runs);

export const docxNumPr = (numId: string | number, ilvl = 0) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

/** A length in twips (Word keeps twips as they were). */
const lenTwip = (l: Len, basis = 0) => (l.u === "twip" ? Math.round(l.v) : twip(toPx(l, basis)));

/** w:spacing line / lineRule of a paragraph: a multiple (auto, converted per font) or exact / at-least twips. */
export function docxLineAttrs(p: TextParagraph): string {
  const mark = p.runs[0] ?? DEFAULT_RUN;
  const lh = p.lineHeight;
  if (lh?.mode === "exact" || lh?.mode === "atLeast") return `w:line="${Math.max(1, lenTwip(lh.v, mark.fontSize))}" w:lineRule="${lh.mode}"`;
  // 한글 '여백만' (gap between lines): Word has none — the line height it gives the paragraph's size, exactly
  if (lh?.mode === "between") return `w:line="${Math.max(1, twip(lineHeightOf(p, mark.fontSize)))}" w:lineRule="exact"`;
  // a Word multiple: exactly (2.0 → 480)
  const wm = wordMultipleOf(p);
  if (wm !== undefined) return `w:line="${Math.max(1, Math.round(wm * 240))}" w:lineRule="auto"`;
  // a DOCX paragraph read before Word multiples whose line spacing was not changed: Word's own value as it was
  if (p.wordLine && p.wordLine.lineSpacing === p.lineSpacing && p.wordLine.line > 0) return `w:line="${Math.round(p.wordLine.line)}" w:lineRule="auto"`;
  return `w:line="${wordLine(p.lineSpacing, mark.fontFamily, p.runs.map((r) => r.text).join(""))}" w:lineRule="auto"`;
}

/** The w:pPr children before w:numPr that the model holds: keepNext, keepLines, pageBreakBefore (CT_PPr order). */
export const docxPPrHead = (p: TextParagraph) => (p.keepNext ? "<w:keepNext/>" : "") + (p.keepLines ? "<w:keepLines/>" : "") + (p.pageBreakBefore ? "<w:pageBreakBefore/>" : "");

/**
 * w:pPr of a paragraph with the given w:pStyle / w:numPr elements (CT_PPr order: pStyle keepNext keepLines
 * pageBreakBefore numPr spacing ind jc outlineLvl rPr).
 */
export function docxPPr(p: TextParagraph, pStyle: string, numPr: string): string {
  const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
  const right = p.indentRight ? ` w:right="${twip(p.indentRight)}"` : "";
  const ind =
    p.indent || p.indentLeft || numPr || right
      ? `<w:ind w:left="${twip(p.indentLeft ?? 0)}"${right}${p.indent < 0 ? ` w:hanging="${twip(-p.indent)}"` : ` w:firstLine="${twip(p.indent)}"`}/>`
      : "";
  const mark = p.runs[0] ?? DEFAULT_RUN;
  const before = p.spaceBefore ? ` w:before="${twip(p.spaceBefore)}"` : "";
  return (
    `<w:pPr>${pStyle}${docxPPrHead(p)}${p.widowControl === false ? `<w:widowControl w:val="0"/>` : ""}${numPr}${docxPBdrXml(p.border)}${p.shade ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(p.shade)}"/>` : ""}` +
    `<w:spacing${before} w:after="${twip(p.spaceAfter)}" ${docxLineAttrs(p)}/>${ind}<w:jc w:val="${JC_OUT[p.align]}"/>` +
    `${level ? `<w:outlineLvl w:val="${Number(level) - 1}"/>` : ""}<w:rPr>${docxRPr({ ...mark, underline: false, strike: false, highlight: undefined, script: undefined })}</w:rPr></w:pPr>`
  );
}

/** The paragraphs of one table cell: its imported rich paragraphs, else one paragraph per text line. */
export function docxCellParas(t: TableNode, c: TableCell, header: boolean, para: (p: TextParagraph) => string): string {
  const rich = cellRich(c);
  const ps = rich
    ? rich.map(para)
    : c.text.split("\n").map((line) => {
        const run = { ...DEFAULT_RUN, text: line, fontFamily: t.fontFamily, fontSize: t.fontSize, bold: !!c.bold || header, italic: !!c.italic, color: c.color ?? t.color };
        return para({ id: "", runs: [run], align: c.align ?? "LEFT", lineSpacing: TABLE_LINE, indent: 0, spaceAfter: 0 });
      });
  return ps.join("");
}

/**
 * A whole w:tbl, `para` writing each cell paragraph; `tblPr` (an original w:tblPr) replaces the generated one;
 * `inner`: original content (paragraphs and a table nested in the cell) written as is for these cells.
 */
export function docxTableXml(t: TableNode, para: (p: TextParagraph) => string, tblPr?: string, inner?: Map<TableCell, string>): string {
    const border = `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((b) => `<w:${b} w:val="single" w:sz="4" w:space="0" w:color="${hex6(t.borderColor)}"/>`).join("")}</w:tblBorders>`;
    const cover = coverMap(t.rows);
    const tc = (ci: number, inner: string, fill: string | null, cs: number, vMerge: string, va?: TableCell["vAlign"]) => {
      const w = t.colWidths.slice(ci, ci + cs).reduce((a, b) => a + b, 0) || 100;
      // CT_TcPr child order: tcW gridSpan vMerge shd vAlign
      return `<w:tc><w:tcPr><w:tcW w:w="${twip(w)}" w:type="dxa"/>${cs > 1 ? `<w:gridSpan w:val="${cs}"/>` : ""}${vMerge}${fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${hex6(fill)}"/>` : ""}${va ? `<w:vAlign w:val="${va === "middle" ? "center" : "bottom"}"/>` : ""}</w:tcPr>${inner}</w:tc>`;
    };
    // Word's cell margins of a table read from DOCX (TableNode.cellBox.word): written back (CT_TblCellMar: top left bottom right)
    const box = t.cellBox?.word ? t.cellBox : null;
    const mar = box ? `<w:tblCellMar><w:top w:w="${twip(box.padY)}" w:type="dxa"/><w:left w:w="${twip(box.padX)}" w:type="dxa"/><w:bottom w:w="${twip(box.padY)}" w:type="dxa"/><w:right w:w="${twip(box.padX)}" w:type="dxa"/></w:tblCellMar>` : "";
    const rows = t.rows
      .map((r, ri) => {
        const header = t.headerRow && ri === 0;
        const cells = r
          .map((c, ci) => {
            const cv = cover[ri][ci];
            if (cv) {
              // vertical continuation: one cell (as wide as the anchor) at the anchor's column
              if (cv.r === ri || cv.c !== ci) return "";
              const { cs } = spanOf(t.rows, cv.r, cv.c);
              return tc(ci, "<w:p/>", t.rows[cv.r][cv.c].fill ?? null, cs, "<w:vMerge/>");
            }
            const { cs, rs } = spanOf(t.rows, ri, ci);
            const fill = c.fill ?? (header ? t.headerFill : null);
            return tc(ci, inner?.get(c) ?? (docxCellParas(t, c, header, para) || "<w:p/>"), fill, cs, rs > 1 ? '<w:vMerge w:val="restart"/>' : "", c.vAlign);
          })
          .join("");
        return `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells}</w:tr>`;
      })
      .join("");
    return `<w:tbl>${tblPr ?? `<w:tblPr><w:tblW w:w="0" w:type="auto"/>${t.wordAlign ? `<w:jc w:val="${t.wordAlign.jc}"/>` : ""}${border}<w:tblLayout w:type="fixed"/>${mar}</w:tblPr>`}<w:tblGrid>${t.colWidths.map((w) => `<w:gridCol w:w="${twip(w)}"/>`).join("")}</w:tblGrid>${rows}</w:tbl>`;
}

/** A w:sectPr for a section with this page setup. */
export const docxSectPr = (s: PageSetup, hf?: DocxSectHFXml) => (hf ? `<w:sectPr>${hf.refs}${docxPageXml(s)}${hf.pgNumType}${hf.titlePg}</w:sectPr>` : `<w:sectPr>${docxPageXml(s)}</w:sectPr>`);

// ───────── DOCX headers / footers out (exportDocx, Office Surgeon) ─────────

/** One header / footer part a section gets: its paragraphs and the page number placed by itself in it (if any). */
export interface DocxHFPart {
  area: "header" | "footer";
  variant: "default" | "first" | "even";
  paras: TextParagraph[];
  pn: { pos: PageNumPos; side?: string } | null;
}
/** What a section's w:sectPr says about headers, footers and numbering. */
export interface DocxHFSection {
  parts: DocxHFPart[];
  titlePg: boolean;
  fmt?: PageNumFormat;
  start?: number;
}
export interface DocxSectHFXml {
  refs: string;
  pgNumType: string;
  titlePg: string;
}

const HF_AREAS_OUT = ["header", "footer"] as const;
const HF_VARIANTS_OUT = ["default", "first", "even"] as const;
const samePn = (a: { pos: string; side?: string } | null, b: { pos: string; side?: string } | null) => (a?.pos ?? "") === (b?.pos ?? "") && (a?.side ?? "") === (b?.side ?? "");
const pnArea = (pn: { pos: string } | null) => (pn ? (pn.pos.startsWith("top") ? "header" : "footer") : null);

/**
 * The parts each section writes (Word: a section without a reference of a type shows the section before's): a variant
 * of its own, and — where a page number placed by itself starts, changes or ends — the variants of that area with the
 * number (as Word's framed page number paragraph) so the pages show it as Omniweave does.
 */
export function docxHFSections(hfs: readonly (SectionHF | undefined)[], evenOdd: boolean): DocxHFSection[] {
  let pn: { pos: PageNumPos; side?: string } | null = null;
  const eff: Record<string, TextParagraph[] | undefined> = {};
  return hfs.map((hf) => {
    const prev = pn;
    if (hf?.pageNum !== undefined) pn = hf.pageNum;
    const changed = !samePn(pn, prev);
    const parts: DocxHFPart[] = [];
    for (const area of HF_AREAS_OUT)
      for (const v of HF_VARIANTS_OUT) {
        const own = hf?.[area]?.[v];
        if (own) eff[area + v] = own;
        const active = v === "default" || (v === "even" && evenOdd) || (v === "first" && !!hf?.titlePg);
        const want = pnArea(pn) === area && active && !(v === "first" && hf?.hideFirstNum);
        const write = !!own || (active && changed && (pnArea(pn) === area || pnArea(prev) === area)) || (want && v === "first");
        if (write) parts.push({ area, variant: v, paras: eff[area + v] ?? [], pn: want ? pn : null });
      }
    return { parts, titlePg: !!hf?.titlePg, ...(hf?.pageFmt ? { fmt: hf.pageFmt } : {}), ...(hf?.pageStart != null ? { start: hf.pageStart } : {}) };
  });
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

/** A page number placed by itself: Word's framed page number paragraph (read back as one, docxHFParas). */
export function docxPageNumPara(pn: { pos: PageNumPos; side?: string }): string {
  const h = pn.pos.split("-")[1];
  const run = (text: string) => `<w:r><w:rPr><w:sz w:val="20"/></w:rPr>${docxText(text)}</w:r>`;
  return (
    `<w:p><w:pPr><w:framePr w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="${h}" w:y="1"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>` +
    (pn.side ? run(pn.side + " ") : "") +
    `<w:fldSimple w:instr="${esc(DOCX_FIELD_INSTR.page)}">${run("1")}</w:fldSimple>` +
    (pn.side ? run(" " + pn.side) : "") +
    `</w:p>`
  );
}

/** The XML of a header / footer part. */
export function docxHFPartXml(part: DocxHFPart): string {
  const tag = part.area === "header" ? "w:hdr" : "w:ftr";
  const body = part.paras.map((p) => `<w:p>${docxPPr(p, "", "")}${docxRuns(p.runs)}</w:p>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><${tag} ${W_NS}>${part.pn ? docxPageNumPara(part.pn) : ""}${body || "<w:p/>"}</${tag}>`;
}

/** w:sectPr pieces of a section: references (rId per part, in its order), pgNumType, titlePg. */
export function docxSectHFXml(sec: DocxHFSection, rIds: string[]): DocxSectHFXml {
  const refs = sec.parts.map((p, k) => `<w:${p.area}Reference w:type="${p.variant}" r:id="${rIds[k]}"/>`).join("");
  const fmt = sec.fmt && sec.fmt !== "decimal" ? ` w:fmt="${DOCX_PGFMT_OUT[sec.fmt]}"` : "";
  const start = sec.start != null ? ` w:start="${Math.round(sec.start)}"` : "";
  return { refs, pgNumType: fmt || start ? `<w:pgNumType${fmt}${start}/>` : "", titlePg: sec.titlePg ? "<w:titlePg/>" : "" };
}

export const DOCX_HF_TYPES = {
  header: { rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/header", ct: "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml" },
  footer: { rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer", ct: "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml" },
  settings: { rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings", ct: "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml" },
};
/** Word's Ctrl+Enter: a paragraph holding only a page break (read back as just the break). */
export const DOCX_PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/** Options of the DOCX / HWPX writers: the document's assets (pictures), where their bytes are, notes for the save. */
export interface OfficeExportOptions {
  assets?: Record<string, AssetRef>;
  getBlob?: (hash: string) => Uint8Array | undefined;
  /** what the file cannot hold (said before saving) */
  notes?: string[];
}

/**
 * Where the pictures of the pages go in a flow (io/officeDrawing.ts picTargets): paragraphs of their own before / after
 * a flow item (inline), runs anchored in a flow paragraph (floating), or — a page without items — at the page.
 */
export function placePics(pages: Page[], flow: FlowItem[], opts: OfficeExportOptions) {
  const media = picMedia(pages, opts.assets, opts.getBlob ?? defaultGetBlob);
  if (media.skipped && opts.notes) opts.notes.push(tx(media.skipped === 1 ? "engine.office.picsSkipped_one" : "engine.office.picsSkipped", { n: media.skipped }));
  const tops = itemTops(pages);
  const ids = flow.map((it) => (it.kind === "p" ? it.p.id : it.t.id));
  const targets = picTargets(
    media.list.map((m) => m.pic),
    ids,
    tops,
  ).map((t, i) => ({ ...t, media: media.list[i] }));
  // one file per distinct picture
  const files: { hash: string; n: number; m: PicMedia }[] = [];
  const fileOf = (m: PicMedia) => {
    let f = files.find((x) => x.hash === m.hash);
    if (!f) files.push((f = { hash: m.hash, n: files.length + 1, m }));
    return f;
  };
  for (const t of targets) fileOf(t.media);
  return { targets, files, fileOf };
}

export function exportDocx(pages: Page[], opts: OfficeExportOptions = {}): Uint8Array {
  try {
    return exportDocxNotes(pages, opts);
  } finally {
    useDocxNoteIds(null);
  }
}

function exportDocxNotes(pages: Page[], opts: OfficeExportOptions): Uint8Array {
  const starts: number[] = [];
  const flow = collectFlow(pages, starts);
  // footnotes / endnotes: w:id 1, 2 … per kind in document order (word/footnotes.xml, word/endnotes.xml)
  const noteList = flowNotes(flow);
  const noteIds = new Map<NoteRef, string>();
  const noteN = { foot: 0, end: 0 };
  for (const n of noteList) if (!noteIds.has(n)) noteIds.set(n, String(++noteN[n.kind]));
  useDocxNoteIds(noteIds);
  // pictures: inline ones as paragraphs of their own, floating ones anchored in the paragraph at their place
  const pics = placePics(pages, flow, opts);
  const picBefore = new Map<number, string[]>(), picAfter = new Map<number, string[]>(), picAlone = new Map<number, string[]>();
  const anchorRuns = new Map<TextParagraph, string>();
  const push = (m: Map<number, string[]>, k: number, x: string) => m.set(k, [...(m.get(k) ?? []), x]);
  let docPr = 0;
  for (const t of pics.targets) {
    const { pic } = t.media;
    const f = pics.fileOf(t.media);
    const run = `<w:r>${docxDrawingXml({ rId: `rIdImg${f.n}`, id: ++docPr, name: pic.node.name, g: pic.g, place: pic.place, z: pic.z })}</w:r>`;
    const it = t.item >= 0 ? flow[t.item] : undefined;
    if (pic.place.mode === "float" && it?.kind === "p") anchorRuns.set(it.p, (anchorRuns.get(it.p) ?? "") + run);
    else {
      // inline: its own paragraph; floating at a table or on a page without text: a holder paragraph of its own
      const xml = pic.place.mode === "inline" ? docxPicPara(run, pic.align, pic.indent, t.before, t.below) : `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${run}</w:p>`;
      if (t.item < 0) push(picAlone, pic.page, xml);
      else push(t.after ? picAfter : picBefore, t.item, xml);
    }
  }
  const lists = listIds(flow);
  const numbered = Math.max(0, ...[...lists.values()].map((l) => (l.kind === "oli" ? l.id : 0)));
  // multi-level lists: abstractNum 2.. per definition, w:num after the one-level ones
  const ml = multiLists(flowListParas(flow), pageListDefs(pages));
  const firstMlNum = numbered + 2;
  // a drop shadow on a text box: Word's character shadow (on / off only — caps.ts fx.dropShadow approx)
  const shadowed = new Set(pages.flatMap((pg) => pg.nodes).flatMap((n) => (n.type === "TEXT" && n.effects?.some((e) => e.on && e.type === "dropShadow") ? n.paragraphs : [])));
  // comments (core/review.ts): w:id 0, 1 … in list order, those still on the text; their marks around the runs
  const order: TextParagraph[] = [];
  for (const it of flow) {
    if (it.kind === "p") order.push(it.p);
    else for (const row of it.t.rows) for (const c of row) if (cellRich(c)) order.push(...cellRich(c)!);
  }
  // (a 한글 memo on no text, DocComment.at: a comment range of no text at its place)
  const paraIds = new Set(order.map((p) => p.id));
  const atPara = (c: DocComment) => !!c.at && paraIds.has(c.at.para);
  const onRuns = new Set([...order.flatMap((p) => p.runs.flatMap((r) => r.comments ?? [])), ...docComments(pages).filter(atPara).map((c) => c.id)]);
  const comments = docComments(pages).filter((c) => onRuns.has(c.id));
  const live = new Set(comments.map((c) => c.id));
  const cids = new Map(comments.filter((c) => !c.parent || live.has(c.parent) || !docComments(pages).some((x) => x.id === c.parent)).map((c, i) => [c.id, String(i)]));
  const points = (p: TextParagraph) => comments.filter((c) => c.at?.para === p.id).map((c) => ({ id: c.id, offset: c.at!.offset }));
  const cmarks: DocxCommentIds | null = cids.size ? { idOf: (id) => cids.get(id) ?? "", refStyle: "", neighbours: commentNeighbours(order), points } : null;
  const para = (p: TextParagraph, sect = "") => {
    const list = lists.get(p);
    const m = ml.of(p);
    const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
    const numPr = m ? docxNumPr(firstMlNum + m.inst, m.level) : list ? docxNumPr(list.kind === "li" ? 1 : list.id + 1) : "";
    let pPr = docxPPr(p, level ? `<w:pStyle w:val="Heading${level}"/>` : "", numPr);
    // the paragraph mark's tracked change (a new file has no move ranges: moves as deletion / insertion)
    if (p.markRev) pPr = docxPPrReview(pPr, p, false);
    if (sect) pPr = pPr.slice(0, -"</w:pPr>".length) + sect + "</w:pPr>"; // CT_PPr: sectPr after rPr
    const runs = docxBodyRuns(p, !!list || !!m);
    const shadow = shadowed.has(p);
    const marks = cmarks ? docxCommentMarks(p, runs, cmarks).filter((x) => !x.xml.includes('w:id=""')) : [];
    return `<w:p>${pPr}${anchorRuns.get(p) ?? ""}${marks.length ? withInserts(runs, marks, (r) => docxRuns([r], undefined, shadow)) : docxRuns(runs, undefined, shadow)}</w:p>`;
  };
  const table = (t: TableNode) => docxTableXml(t, para);
  // page layout: a section ends with a w:sectPr in its last paragraph (an empty paragraph when it ends with a table
  // or has no text); the last section's w:sectPr closes the body; a hard page break is Word's page-break paragraph
  const lay = flowLayout(pages, starts, flow.length);
  // headers / footers: header{n}.xml / footer{n}.xml per part, referenced from the section's w:sectPr
  const evenOdd = !!pages[0]?.hf?.evenOdd;
  const hfSecs = docxHFSections(lay.hfs, evenOdd);
  const hfParts: { name: string; id: string; area: "header" | "footer"; xml: string }[] = [];
  const hfXml = hfSecs.map((sec) => {
    const ids = sec.parts.map((p) => {
      const n = hfParts.filter((x) => x.area === p.area).length + 1;
      const id = `rId${p.area === "header" ? "H" : "F"}${n}`;
      hfParts.push({ name: `${p.area}${n}.xml`, id, area: p.area, xml: docxHFPartXml(p) });
      return id;
    });
    return sec.parts.length || sec.titlePg || sec.fmt || sec.start != null ? docxSectHFXml(sec, ids) : undefined;
  });
  const sectOf = (k: number) => docxSectPr(lay.sections[k], hfXml[k]);
  const chunks: { xml: string; tbl?: boolean; p?: TextParagraph; sect?: boolean }[] = [];
  lay.pages.forEach((pg, i) => {
    if (pg.begin === "section") {
      const sect = sectOf(lay.pages[i - 1].section);
      const last = chunks[chunks.length - 1];
      if (last?.p && !last.sect) Object.assign(last, { xml: para(last.p, sect), sect: true });
      else chunks.push({ xml: `<w:p><w:pPr>${sect}</w:pPr></w:p>`, sect: true });
    } else if (pg.begin === "page") {
      // a paragraph that starts a new page by itself (pageBreakBefore) needs no break paragraph
      const first = flow[pg.from];
      if (!(first?.kind === "p" && first.p.pageBreakBefore && pg.from < pg.to)) chunks.push({ xml: DOCX_PAGE_BREAK });
    }
    for (let k = pg.from; k < pg.to; k++) {
      const it = flow[k];
      for (const x of picBefore.get(k) ?? []) chunks.push({ xml: x });
      chunks.push(it.kind === "p" ? { xml: para(it.p), p: it.p } : { xml: table(it.t), tbl: true });
      for (const x of picAfter.get(k) ?? []) chunks.push({ xml: x });
    }
    if (pg.from >= pg.to) for (const x of picAlone.get(i) ?? []) chunks.push({ xml: x });
  });
  // a paragraph must follow a table that ends the body or precedes another table (two adjacent tables would merge)
  const body = chunks.map((c, i) => c.xml + (c.tbl && (!chunks[i + 1] || chunks[i + 1].tbl) ? "<w:p/>" : "")).join("");
  const lastSect = lay.sections.length ? sectOf(lay.sections.length - 1) : docxSectPr(setupOf(PAGE_PRESETS.A4));
  // numbering: abstract 0 = bullet, 1 = decimal; num 1 = bullets, num 2.. = one per numbered list (restart at 1)
  const lvl = (fmt: string, text: string) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:suff w:val="space"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="0" w:firstLine="0"/></w:pPr></w:lvl>`;
  const numbering =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${lvl("bullet", "•")}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${lvl("decimal", "%1.")}</w:abstractNum>` +
    `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
    Array.from({ length: numbered }, (_, i) => `<w:num w:numId="${i + 2}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`).join("") +
    `</w:numbering>`;
  // schema order: every w:abstractNum before the first w:num (multi-level ones are added only when used, so files
  // without them are written as before)
  const numberingXml = !ml.defs.length
    ? numbering
    : numbering
        .replace(`<w:num w:numId="1">`, ml.defs.map((d, k) => docxAbstractNum(2 + k, d)).join("") + `<w:num w:numId="1">`)
        .replace(`</w:numbering>`, docxNums(ml.insts, 2, firstMlNum) + `</w:numbering>`);
  const files: Zippable = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/_rels/document.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdNumbering" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`,
    ),
    // heading styles so paragraphs exported with pStyle HeadingN show up as headings (navigation pane, outline)
    "word/styles.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>` +
        [1, 2, 3, 4, 5, 6]
          .map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/></w:rPr></w:style>`)
          .join("") +
        `</w:styles>`,
    ),
    "word/numbering.xml": strToU8(numberingXml),
    "word/document.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"${pics.files.length ? ` xmlns:wp="${NS_WP}" xmlns:r="${NS_R}"` : ""}><w:body>${body}${lastSect}</w:body></w:document>`,
    ),
  };
  // pictures: their bytes as they are (word/media), a relationship each and the content type of each extension; only
  // when there are any, so documents without pictures are written byte for byte as before
  if (pics.files.length) {
    let ct = strFromU8(files["[Content_Types].xml"] as Uint8Array);
    let rels = strFromU8(files["word/_rels/document.xml.rels"] as Uint8Array);
    for (const f of pics.files) {
      files[`word/media/image${f.n}.${f.m.ext}`] = f.m.bytes;
      if (!ct.includes(`Extension="${f.m.ext}"`)) ct = ct.replace("<Default Extension=\"rels\"", `<Default Extension="${f.m.ext}" ContentType="${f.m.mime}"/><Default Extension="rels"`);
      rels = rels.replace("</Relationships>", `<Relationship Id="rIdImg${f.n}" Type="${REL_IMAGE}" Target="media/image${f.n}.${f.m.ext}"/></Relationships>`);
    }
    files["[Content_Types].xml"] = strToU8(ct);
    files["word/_rels/document.xml.rels"] = strToU8(rels);
  }
  // header / footer parts (and settings.xml for different odd and even pages): only when there are any, so documents
  // without them are written byte for byte as before
  if (hfParts.length || evenOdd) {
    const add = (name: string, xml: string) => (files[name] = strToU8(xml));
    let ct = strFromU8(files["[Content_Types].xml"] as Uint8Array);
    let rels = strFromU8(files["word/_rels/document.xml.rels"] as Uint8Array);
    for (const p of hfParts) {
      add(`word/${p.name}`, p.xml);
      ct = ct.replace("</Types>", `<Override PartName="/word/${p.name}" ContentType="${DOCX_HF_TYPES[p.area].ct}"/></Types>`);
      rels = rels.replace("</Relationships>", `<Relationship Id="${p.id}" Type="${DOCX_HF_TYPES[p.area].rel}" Target="${p.name}"/></Relationships>`);
    }
    if (evenOdd) {
      add("word/settings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W_NS}><w:evenAndOddHeaders/></w:settings>`);
      ct = ct.replace("</Types>", `<Override PartName="/word/settings.xml" ContentType="${DOCX_HF_TYPES.settings.ct}"/></Types>`);
      rels = rels.replace("</Relationships>", `<Relationship Id="rIdSettings" Type="${DOCX_HF_TYPES.settings.rel}" Target="settings.xml"/></Relationships>`);
    }
    add("[Content_Types].xml", ct);
    add("word/_rels/document.xml.rels", rels);
    if (!pics.files.length) add("word/document.xml", strFromU8(files["word/document.xml"] as Uint8Array).replace("<w:document xmlns:w=", `<w:document xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w=`));
  }
  // footnotes / endnotes parts: only when there are notes (documents without them are written as before)
  if (noteIds.size) {
    let ct = strFromU8(files["[Content_Types].xml"] as Uint8Array);
    let rels = strFromU8(files["word/_rels/document.xml.rels"] as Uint8Array);
    for (const kind of ["foot", "end"] as const) {
      const mine = [...noteIds].filter(([n]) => n.kind === kind);
      if (!mine.length) continue;
      const T = DOCX_NOTE_TYPES[kind];
      files[T.part] = strToU8(docxNotesPartXml(kind, mine.map(([n, id]) => docxNoteXml(kind, id, n.paras, (p) => para(p))).join("")));
      ct = ct.replace("</Types>", `<Override PartName="/${T.part}" ContentType="${T.ct}"/></Types>`);
      rels = rels.replace("</Relationships>", `<Relationship Id="rId${kind === "foot" ? "Foot" : "End"}notes" Type="${T.rel}" Target="${T.part.slice(5)}"/></Relationships>`);
    }
    files["[Content_Types].xml"] = strToU8(ct);
    files["word/_rels/document.xml.rels"] = strToU8(rels);
  }
  // comments (word/comments.xml, replies and resolved marks in commentsExtended.xml) and recording changes
  // (settings.xml w:trackRevisions): only when there are any, so other documents are written as before
  if (cids.size || pages[0]?.trackChanges) {
    let ct = strFromU8(files["[Content_Types].xml"] as Uint8Array);
    let rels = strFromU8(files["word/_rels/document.xml.rels"] as Uint8Array);
    if (cids.size) {
      const used = new Set<string>();
      const last = new Map<string, string>();
      const written = comments.filter((c) => cids.has(c.id));
      const xml = written
        .map((c) => {
          const pids = Array.from({ length: Math.max(1, c.text.split("\n").length) }, () => newParaId(used));
          last.set(c.id, pids[pids.length - 1]);
          return docxCommentXml(c, cids.get(c.id)!, pids, { text: "", ref: "" });
        })
        .join("");
      files["word/comments.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments ${W_NS} xmlns:w14="${W14_NS}" xmlns:mc="${MC_NS}" mc:Ignorable="w14">${xml}</w:comments>`);
      ct = ct.replace("</Types>", `<Override PartName="/word/comments.xml" ContentType="${COMMENTS_CT}"/></Types>`);
      rels = rels.replace("</Relationships>", `<Relationship Id="rIdComments" Type="${COMMENTS_REL}" Target="comments.xml"/></Relationships>`);
      if (written.some((c) => c.parent || c.done)) {
        const ex = written.map((c) => `<w15:commentEx w15:paraId="${last.get(c.id)}"${c.parent && last.has(c.parent) ? ` w15:paraIdParent="${last.get(c.parent)}"` : ""} w15:done="${c.done ? 1 : 0}"/>`).join("");
        files["word/commentsExtended.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w15:commentsEx xmlns:w15="${W15_NS}" xmlns:mc="${MC_NS}" mc:Ignorable="w15">${ex}</w15:commentsEx>`);
        ct = ct.replace("</Types>", `<Override PartName="/word/commentsExtended.xml" ContentType="${COMMENTS_EX_CT}"/></Types>`);
        rels = rels.replace("</Relationships>", `<Relationship Id="rIdCommentsEx" Type="${COMMENTS_EX_REL}" Target="commentsExtended.xml"/></Relationships>`);
      }
    }
    if (pages[0]?.trackChanges) {
      const s = files["word/settings.xml"] ? strFromU8(files["word/settings.xml"] as Uint8Array) : null;
      if (s) files["word/settings.xml"] = strToU8(docxSettingsTracking(s, true));
      else {
        files["word/settings.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W_NS}><w:trackRevisions/></w:settings>`);
        ct = ct.replace("</Types>", `<Override PartName="/word/settings.xml" ContentType="${DOCX_HF_TYPES.settings.ct}"/></Types>`);
        rels = rels.replace("</Relationships>", `<Relationship Id="rIdSettings" Type="${DOCX_HF_TYPES.settings.rel}" Target="settings.xml"/></Relationships>`);
      }
    }
    files["[Content_Types].xml"] = strToU8(ct);
    files["word/_rels/document.xml.rels"] = strToU8(rels);
  }
  // spacings that add up (a document of our own, 한글's, a Word file with the option): Word is told so
  // (w:doNotUseHTMLParagraphAutoSpacing) — else it draws only the larger of two touching spacings, and so would
  // Omniweave reopening the file (TextNode.wordSpacing). Only when a gap would differ, so other documents are written
  // as before.
  if (docxSpacingAddsUp(pages)) {
    const compat = "<w:compat><w:doNotUseHTMLParagraphAutoSpacing/></w:compat>";
    const s = files["word/settings.xml"] ? strFromU8(files["word/settings.xml"] as Uint8Array) : null;
    if (s) files["word/settings.xml"] = strToU8(s.replace("</w:settings>", `${compat}</w:settings>`));
    else {
      files["word/settings.xml"] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:settings ${W_NS}>${compat}</w:settings>`);
      files["[Content_Types].xml"] = strToU8(strFromU8(files["[Content_Types].xml"] as Uint8Array).replace("</Types>", `<Override PartName="/word/settings.xml" ContentType="${DOCX_HF_TYPES.settings.ct}"/></Types>`));
      files["word/_rels/document.xml.rels"] = strToU8(strFromU8(files["word/_rels/document.xml.rels"] as Uint8Array).replace("</Relationships>", `<Relationship Id="rIdSettings" Type="${DOCX_HF_TYPES.settings.rel}" Target="settings.xml"/></Relationships>`));
    }
  }
  return zipSync(files);
}

/**
 * The pages' text adds spacings up (TextNode.wordSpacing "sum" or none) and some paragraph has both a space after and,
 * below it in the same frame, a space before — the gap Word would otherwise draw as the larger one alone. A "max" text
 * anywhere (a Word document of the usual kind) says no.
 */
export function docxSpacingAddsUp(pages: readonly Page[]): boolean {
  const texts: Pick<TextNode, "wordSpacing" | "paragraphs">[] = [];
  for (const p of pages)
    for (const n of p.nodes) {
      if (n.type === "TEXT") texts.push(n);
      else if (n.type === "TABLE") for (const row of n.rows) for (const c of row) if (c.richText?.length) texts.push({ wordSpacing: n.cellBox?.word?.wordSpacing, paragraphs: c.richText });
    }
  if (texts.some((t) => t.wordSpacing === "max")) return false;
  if (texts.some((t) => t.wordSpacing === "sum")) return true;
  return texts.some((t) => t.paragraphs.some((q, i) => i > 0 && (q.spaceBefore ?? 0) > 0 && t.paragraphs[i - 1].spaceAfter > 0));
}

// ───────────────────────── HWPX export ─────────────────────────

/**
 * hh:charPr height (1/100 pt) of a font size in px, in 한글's 0.1 pt steps: a size read from HWPX comes back as it was
 * (10 pt is kept as 13.3 px — written to the 1/100 pt it would be 998, and the smaller text broke its lines elsewhere).
 * A size the px value holds exactly stays to the 1/100 pt (8.25 pt = 11 px, 9.75 pt = 13 px: QA hwpx-outline — rounded
 * to 0.1 pt they came back 8.3 / 9.8); a 0.1 pt step only where it reads back as the same px (sizes read to 0.1 px).
 */
export function hwpxHeight(px: number): number {
  const e = (px / PT) * 100;
  // (a size HWPX gives is read to 0.0001 px — hwpxHeaderMaps — i.e. within 0.00375 of its 1/100 pt: every height
  // 1–400 pt comes back as it was, 10.01 pt too; a size kept to 0.1 px by older files is k × 7.5, never that close)
  if (Math.abs(e - Math.round(e)) < 0.01) return Math.round(e);
  const h10 = Math.round(e / 10) * 10;
  return Math.abs(e - h10) <= 3.75 ? h10 : Math.round(e);
}

/** hh:charPr of a run; `fontRef` gives the font id per fontface language (shared with the Office Surgeon). */
export function hwpxCharPrXml(i: number, r: TextRun, fontRef: (lang: string) => number, borderFillIDRef: string | number = 1): string {
  const langs = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"];
  // 자간: % of each character's advance after 장평 (-50..50); an absolute letterSpacing is added as % of the size
  const sp = Math.max(-50, Math.min(50, Math.round((r.spacingPct ?? 0) + (r.letterSpacing ? (r.letterSpacing / r.fontSize) * 100 : 0))));
  const spAll = langs.map((l) => `${l}="${sp}"`).join(" ");
  const ratio = Math.max(50, Math.min(200, Math.round(r.hscale ?? 100)));
  const shade = r.highlight && /^#[0-9a-f]{6}/i.test(r.highlight) ? r.highlight.slice(0, 7).toUpperCase() : "none";
  return (
    `<hh:charPr id="${i}" height="${hwpxHeight(r.fontSize)}" textColor="${r.color.slice(0, 7).toUpperCase()}" shadeColor="${shade}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="${borderFillIDRef}">` +
    `<hh:fontRef ${langs.map((l) => `${l}="${fontRef(l)}"`).join(" ")}/>` +
    `<hh:ratio ${langs.map((l) => `${l}="${ratio}"`).join(" ")}/>` +
    `<hh:spacing ${spAll}/>` +
    `<hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>` +
    `<hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>` +
    (r.bold ? "<hh:bold/>" : "") + (r.italic ? "<hh:italic/>" : "") +
    `<hh:underline type="${r.underline ? "BOTTOM" : "NONE"}" shape="SOLID" color="#000000"/>` +
    `<hh:strikeout shape="${r.strike ? "SOLID" : "NONE"}" color="#000000"/>` +
    `<hh:outline type="NONE"/><hh:shadow type="NONE" color="#C0C0C0" offsetX="10" offsetY="10"/>` +
    (r.script === "super" ? "<hh:supscript/>" : r.script === "sub" ? "<hh:subscript/>" : "") +
    `</hh:charPr>`
  );
}

/** hh:lineSpacing type and value of a paragraph (HWPUNIT lengths kept as they were). */
export function hwpxLineSpacing(p: TextParagraph): { type: string; value: number } {
  const lh = p.lineHeight;
  // a Word multiple: the PERCENT of the same height (the font's single line ÷ size × v)
  const wm = wordMultipleOf(p);
  if (wm !== undefined) return { type: "PERCENT", value: Math.round(wm * paraLineRatio(p) * 100) };
  if (!lh) return { type: "PERCENT", value: Math.round(p.lineSpacing * 100) };
  const size = p.runs[0]?.fontSize ?? DEFAULT_RUN.fontSize;
  const v = lh.v.u === "hwpunit" ? Math.round(lh.v.v) : Math.round((toPx(lh.v, size) / PT) * 100);
  return { type: lh.mode === "exact" ? "FIXED" : lh.mode === "atLeast" ? "AT_LEAST" : "BETWEEN_LINES", value: Math.max(0, v) };
}

/** hh:paraPr of a paragraph with its heading (NONE / OUTLINE / BULLET / NUMBER) (shared with the Office Surgeon). */
/** 한글 left margin of a paragraph: the model's left indent less a hanging first line (내어쓰기, office.ts import) */
export const hwpxLeftOut = (p: Pick<TextParagraph, "indent" | "indentLeft">) => Math.max(0, (p.indentLeft ?? 0) + Math.min(0, p.indent));

/** px → HWPUNIT of a paragraph border offset (0 when none) */
const hu100 = (px: number | undefined) => Math.round(((px ?? 0) / PT) * 100);

export function hwpxParaPrXml(i: number, p: TextParagraph, head: { type: string; idRef: number; level: number }, borderFillIDRef: string | number = 1): string {
  const ls = hwpxLineSpacing(p);
  const keepNext = head.type === "OUTLINE" || p.keepNext ? 1 : 0;
  return (
    `<hh:paraPr id="${i}" tabPrIDRef="0" condense="${Math.round((p.condense ?? 0) * 100)}" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="LTR">` +
    `<hh:align horizontal="${p.align}" vertical="BASELINE"/>` +
    `<hh:heading type="${head.type}" idRef="${head.idRef}" level="${head.level}"/>` +
    `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${p.breakWord ? "KEEP_WORD" : "BREAK_WORD"}" widowOrphan="0" keepWithNext="${keepNext}" keepLines="${p.keepLines ? 1 : 0}" pageBreakBefore="${p.pageBreakBefore ? 1 : 0}" lineWrap="BREAK"/>` +
    `<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>` +
    `<hh:margin><hc:intent value="${Math.round((p.indent / PT) * 100)}" unit="HWPUNIT"/><hc:left value="${Math.round((hwpxLeftOut(p) / PT) * 100)}" unit="HWPUNIT"/><hc:right value="${Math.round(((p.indentRight ?? 0) / PT) * 100)}" unit="HWPUNIT"/><hc:prev value="${Math.round(((p.spaceBefore ?? 0) / PT) * 100)}" unit="HWPUNIT"/><hc:next value="${Math.round((p.spaceAfter / PT) * 100)}" unit="HWPUNIT"/></hh:margin>` +
    `<hh:lineSpacing type="${ls.type}" value="${ls.value}" unit="HWPUNIT"/>` +
    `<hh:border borderFillIDRef="${borderFillIDRef}" offsetLeft="${hu100(p.border?.left?.space)}" offsetRight="${hu100(p.border?.right?.space)}" offsetTop="${hu100(p.border?.top?.space)}" offsetBottom="${hu100(p.border?.bottom?.space)}" connect="0" ignoreMargin="0"/>` +
    `</hh:paraPr>`
  );
}

export function exportHwpx(pages: Page[], title: string, opts: OfficeExportOptions = {}): Uint8Array {
  const starts: number[] = [];
  const flow = collectFlow(pages, starts);
  if (!flow.length) flow.push({ kind: "p", p: newParagraph("") });
  // memos and tracked changes as 한글 writes them (officesurgeon/hwpxReview.ts, as the Office Surgeon does): memo fields
  // around their text, insert / delete marks inside hp:t, the changes and their authors in header.xml — QA doc-review2
  const reviewHost = { header: "<hh:refList></hh:refList>", headerChanged: false };
  const order: TextParagraph[] = [];
  for (const it of flow) {
    if (it.kind === "p") order.push(it.p);
    else for (const row of it.t.rows) for (const c of row) order.push(...(cellRich(c) ?? []));
  }
  const memos = docComments(pages);
  // memo text in 한글's 메모 style (its paragraph / character shape: 9 pt 함초롬돋움, 자간 -5%, 줄 간격 130%), the style's id
  // settled once the heading styles are known; memo boxes (hh:memoPr) as read, one per section on its hp:secPr
  // memoShapeIDRef (a memo of another box in that section names its own) — QA hwpx-memo
  let memoLook: { pOpen: string; cp: string } | null = null;
  const memoBoxes: string[] = [];
  const secBox = new Map<number, string>();
  let curSection = 0;
  const review = new HwpxReview(reviewHost, [], memos, [], commentNeighbours(order), 1248135443, {
    look: () => {
      if (memoLook) return memoLook;
      const run: TextRun = { ...DEFAULT_RUN, fontFamily: "함초롬돋움", fontSize: 9 * PT, spacingPct: -5, color: "#000000" }; // i18n: keep — 한글's memo font name
      const p: TextParagraph = { ...newParagraph(""), runs: [run], align: "LEFT", lineSpacing: 1.3, indent: 0, spaceAfter: 0 };
      memoLook = { pOpen: `<hp:p id="0" paraPrIDRef="${paraId(p)}" styleIDRef="${MEMO_STYLE}" pageBreak="0" columnBreak="0" merged="0">`, cp: String(charId(run)) };
      return memoLook;
    },
    shapeRef: (c) => {
      if (!c.shape) return "65535";
      const key = JSON.stringify(MEMO_SHAPE_KEYS.map((k) => c.shape![k] ?? ""));
      let i = memoBoxes.indexOf(key);
      if (i < 0) i = memoBoxes.push(key) - 1;
      const id = String(i + 1);
      if (!secBox.has(curSection)) secBox.set(curSection, id);
      return secBox.get(curSection) === id ? "65535" : id;
    },
  });
  const reviewed = (p: TextParagraph) => !!p.markRev || p.runs.some((r) => r.rev || r.comments?.length) || review.points(p).length > 0;
  // pictures (BinData + hp:pic): inline ones as paragraphs of their own, floating ones in the paragraph at their place
  const pics = placePics(pages, flow, opts);
  type HPic = { xml: string; align: Align; indent: number; before?: number; after?: number };
  const before = new Map<number, HPic[]>(), after = new Map<number, HPic[]>(), alone = new Map<number, HPic[]>(), anchorRuns = new Map<number, string>();
  const lists = listIds(flow);
  // multi-level lists: an outline list numbers the 개요 headings (numbering 1); numbered lists one numbering per
  // instance after the one-level ones; bullets one hh:bullet per character after bullet 1
  const ml = multiLists(flowListParas(flow), pageListDefs(pages));
  const outlineDef = ml.defs.find((d) => d.outline);
  // the lists that number the 개요 headings (and 한글's outline items): only their items below 개요 6 become OUTLINE
  // paragraphs — a plain list in the outline format keeps its own numbering (QA hwpx-outline)
  const outlineLists = new Set(["hwpx-outline", ...flowListParas(flow).filter((p) => p.role && /^h[1-6]$/.test(p.role)).map((p) => p.list!.id)]);
  // bullets: one per character — or per hh:bullet read from the file while unchanged (its symbol-font character, picture …)
  const mlBullets: { key: string; ch: string; raw?: string }[] = [];
  const bulletId = (lv: ListLevel) => {
    const raw = lv.hwpx?.fmt === "BULLET" && lv.text === lv.hwpx.text ? lv.hwpx.raw : undefined;
    const ch = lv.text || "•";
    const key = raw ?? ch;
    let i = mlBullets.findIndex((b) => b.key === key);
    if (i < 0) i = mlBullets.push({ key, ch, ...(raw ? { raw } : {}) }) - 1;
    return i + 2;
  };
  const legacyNumbered = Math.max(0, ...[...lists.values()].map((l) => (l.kind === "oli" ? l.id : 0)));
  // de-duplicate character and paragraph shapes
  const fontList: string[] = [];
  const fontId = (f: string) => {
    let i = fontList.indexOf(f);
    if (i < 0) i = fontList.push(f) - 1;
    return i;
  };
  const charKeys: string[] = [];
  const charXml: string[] = [];
  const charId = (r: TextRun) => {
    const k = [r.fontFamily, r.fontSize, r.bold, r.italic, r.underline, r.color, !!r.strike, r.script ?? "", r.highlight ?? "", r.letterSpacing ?? 0, r.hscale ?? 100, r.spacingPct ?? 0].join("|");
    let i = charKeys.indexOf(k);
    if (i < 0) {
      i = charKeys.push(k) - 1;
      charXml.push(hwpxCharPrXml(i, r, () => fontId(r.fontFamily)));
    }
    return i;
  };
  // paraPr heading: NONE, OUTLINE (제목 → 개요 수준), BULLET (idRef = bullet 1), NUMBER (idRef = numbering 2..)
  const headOf = (p: TextParagraph) => {
    const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
    // with outline numbering on, 한글 numbers every OUTLINE paragraph: a heading left out of it keeps its 개요 style
    // (styleIDRef) but no outline heading
    if (level) return outlineDef && !p.list ? { type: "NONE", idRef: 0, level: 0 } : { type: "OUTLINE", idRef: 0, level: Number(level) - 1 };
    const m = ml.of(p);
    if (m) {
      // 개요 7 and below (no heading role): an OUTLINE paragraph at its level, numbered by the outline numbering
      if (outlineDef && ml.defs[m.def] === outlineDef && m.level >= 6 && outlineLists.has(p.list!.id)) return { type: "OUTLINE", idRef: 0, level: m.level };
      const lv = levelOf(ml.defs[m.def], m.level);
      return isBulletLevel(lv) ? { type: "BULLET", idRef: bulletId(lv), level: m.level } : { type: "NUMBER", idRef: legacyNumbered + 2 + m.inst, level: m.level };
    }
    const l = lists.get(p);
    if (l) return l.kind === "li" ? { type: "BULLET", idRef: 1, level: 0 } : { type: "NUMBER", idRef: l.id + 1, level: 0 };
    return { type: "NONE", idRef: 0, level: 0 };
  };
  const paraKeys: string[] = [];
  const paraXml: string[] = [];
  const paraId = (p: TextParagraph) => {
    const head = headOf(p);
    const k = [p.align, hwpxLineSpacing(p).value, p.lineSpacing, p.indent, p.spaceAfter, p.indentLeft ?? 0, head.type, head.idRef, head.level, p.spaceBefore ?? 0, p.indentRight ?? 0, JSON.stringify(p.lineHeight ?? null), !!p.keepNext, !!p.keepLines, !!p.pageBreakBefore, !!p.breakWord, p.condense ?? 0, JSON.stringify(p.border ?? null), p.shade ?? ""].join("|");
    let i = paraKeys.indexOf(k);
    if (i < 0) {
      i = paraKeys.push(k) - 1;
      // 문단 테두리·배경: a border fill of the first side's colour (한글's border fills here draw all four sides alike)
      const b = p.border;
      const line = b && (b.top ?? b.left ?? b.bottom ?? b.right);
      paraXml.push(hwpxParaPrXml(i, p, head, b || p.shade ? bfId(line ? line.color : "", p.shade ?? null) : 1));
    }
    return i;
  };
  // border/fill shapes: 1 = none (characters, paragraphs), then table borders with an optional cell fill
  const bfKeys = ["none|"];
  const bfXml: string[] = [borderFill(1, null, null)];
  const bfId = (border: string, fill: string | null) => {
    const k = `${border}|${fill ?? ""}`;
    let i = bfKeys.indexOf(k);
    if (i < 0) {
      i = bfKeys.push(k) - 1;
      bfXml.push(borderFill(i + 1, border, fill));
    }
    return i + 1;
  };
  // styles: 0 바탕글, 1..6 개요 1..6 (headings), 7..10 개요 7..10 when an outline item below 개요 6 is written
  const headingStyle: { para: number; char: number }[] = [];
  const NS = HWPX_NS;
  let pid = 0, tid = 0;
  const hu = (px: number) => Math.round(px * 75); // px → HWPUNIT (1/7200 inch)
  const pXml = (p: TextParagraph, prefix = "", pageBreak = false, fmt: PageNumFormat = "decimal"): string => {
    const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
    const runList = lists.has(p) || p.list ? bodyRuns(p) : p.runs;
    // header / footer fields: 쪽 번호 / 전체 쪽수 as 한글's automatic numbers, the others as their text; a note
    // reference as 한글's footnote / endnote control holding the note (its number 한글 counts itself)
    const special = (r: TextRun) => (r.note ? noteXml(r.note) : r.noteMark ? noteNum() : r.field === "page" || r.field === "pages" ? hwpxAutoNum(r.field, fmt) : null);
    const runs = reviewed(p)
      ? hwpxReviewRuns(p, runList, review, charId, special, hwpxText, DEFAULT_RUN)
      : runList.map((r) => `<hp:run charPrIDRef="${charId(r)}">${special(r) ?? `<hp:t>${hwpxText(r.text)}</hp:t>`}</hp:run>`).join("");
    const ppr = paraId(p);
    let style = 0;
    const deep = level ? null : headOf(p);
    if (level || (deep?.type === "OUTLINE" && deep.level >= 6 && deep.level <= 9)) {
      const n = level ? Number(level) : deep!.level + 1;
      headingStyle[n] ??= { para: ppr, char: charId(p.runs[0] ?? DEFAULT_RUN) };
      style = n;
    }
    return `<hp:p id="${pid++}" paraPrIDRef="${ppr}" styleIDRef="${style}" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${prefix}${runs}</hp:p>`;
  };
  // footnotes / endnotes: 한글's controls, numbered in document order (the note being written: its kind and number)
  const noteN = { foot: 0, end: 0 };
  let noteNow: { kind: "foot" | "end"; n: number } = { kind: "foot", n: 1 };
  const noteNum = () => `<hp:ctrl><hp:autoNum num="${noteNow.n}" numType="${noteNow.kind === "end" ? "ENDNOTE" : "FOOTNOTE"}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl>`;
  const noteXml = (note: NoteRef): string => {
    const was = noteNow;
    noteNow = { kind: note.kind, n: ++noteN[note.kind] };
    try {
      const tag = note.kind === "end" ? "hp:endNote" : "hp:footNote";
      const ps = (note.paras.length ? note.paras : [newParagraph("")]).map((p) => pXml(p)).join("");
      return `<hp:ctrl><${tag} number="${noteNow.n}" suffixChar="41" instId="${2000000000 + noteN.foot + noteN.end}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${ps}</hp:subList></${tag}></hp:ctrl>`;
    } finally {
      noteNow = was;
    }
  };
  const tblXml = (t: TableNode) => {
    const cover = coverMap(t.rows);
    const rows = t.rows.length, cols = t.colWidths.length;
    const width = t.colWidths.reduce((a, b) => a + b, 0);
    const rowH = Math.max(t.rowHeight, t.fontSize * TABLE_LINE + 8);
    const trs = t.rows
      .map((r, ri) => {
        const header = t.headerRow && ri === 0;
        const tcs = r
          .map((c, ci) => {
            if (cover[ri][ci]) return ""; // covered by a merged cell: not written (OWPML)
            const { cs, rs } = spanOf(t.rows, ri, ci);
            const fill = c.fill ?? (header ? t.headerFill : null);
            const rich = cellRich(c);
            const ps = rich
              ? rich.map((p) => pXml(p))
              : c.text.split("\n").map((line) => {
                  const run: TextRun = { ...DEFAULT_RUN, text: line, fontFamily: t.fontFamily, fontSize: t.fontSize, bold: !!c.bold || header, italic: !!c.italic, color: c.color ?? t.color };
                  return pXml({ id: "", runs: [run], align: c.align ?? "LEFT", lineSpacing: TABLE_LINE, indent: 0, spaceAfter: 0 });
                });
            const w = t.colWidths.slice(ci, ci + cs).reduce((a, b) => a + b, 0);
            return (
              `<hp:tc name="" header="${header ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${bfId(t.borderColor, fill)}">` +
              `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${ps.join("")}</hp:subList>` +
              `<hp:cellAddr colAddr="${ci}" rowAddr="${ri}"/><hp:cellSpan colSpan="${cs}" rowSpan="${rs}"/><hp:cellSz width="${hu(w)}" height="${hu(rowH * rs)}"/>` +
              `<hp:cellMargin left="510" right="510" top="141" bottom="141"/></hp:tc>`
            );
          })
          .join("");
        return `<hp:tr>${tcs}</hp:tr>`;
      })
      .join("");
    return (
      `<hp:tbl id="${1000 + tid++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${t.headerRow ? 1 : 0}" rowCnt="${rows}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${bfId(t.borderColor, null)}" noAdjust="0">` +
      `<hp:sz width="${hu(width)}" widthRelTo="ABSOLUTE" height="${hu(rowH * rows)}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>${trs}</hp:tbl>`
    );
  };
  // page layout: one section file per section (its hp:secPr in its first paragraph: paper, orientation, margins);
  // a hard page break is pageBreak="1" on the first paragraph of the page (an empty one for a page without text)
  const lay = flowLayout(pages, starts, flow.length);
  if (!lay.pages.length) lay.pages.push({ begin: "first", from: 0, to: flow.length, section: 0 });
  if (!lay.sections.length) lay.sections.push(setupOf(PAGE_PRESETS.A4));
  // headers / footers / page numbers: 한글's own controls after the section settings (hwpxHFSections)
  const hwSecs = hwpxHFSections(lay.hfs, !!pages[0]?.hf?.evenOdd);
  const hfCtrls = (k: number, setup: PageSetup, later = false) => {
    curSection = k;
    const sec = hwSecs[k];
    if (!sec) return "";
    const m = setup.margins;
    const textW = hu(Math.max(16, setup.width - m.left - m.right));
    const out = (later ? sec.later ?? [] : sec.ctrls).map((c) => {
      const tag = c.area === "header" ? "hp:header" : "hp:footer";
      const ps = (c.paras.length ? c.paras : [newParagraph("", { fontSize: 10 * PT })]).map((p) => pXml(p, "", false, c.fmt)).join("");
      const h = hu(Math.max(0, c.area === "header" ? m.top - m.header : m.bottom - m.footer));
      return `<hp:ctrl><${tag} id="" applyPageType="${c.type}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${c.area === "header" ? "TOP" : "BOTTOM"}" linkListIDRef="0" linkListNextIDRef="0" textWidth="${textW}" textHeight="${h}" hasTextRef="0" hasNumRef="0">${ps}</hp:subList></${tag}></hp:ctrl>`;
    });
    if (!later && sec.pageNum !== undefined) out.push(`<hp:ctrl>${hwpxPageNumXml(sec.pageNum, sec.fmt)}</hp:ctrl>`);
    return out.join("");
  };
  const secPrOf = (setup: PageSetup, run: TextRun, k = 0) => {
    const sec = hwSecs[k];
    const on = (b: boolean | undefined) => (b ? 1 : 0);
    return `<hp:run charPrIDRef="${charId(run)}"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="\u0004${k}\u0004" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="${sec?.start ?? 0}" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="${on(sec?.hideHeader)}" hideFirstFooter="${on(sec?.hideFooter)}" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="${on(sec?.hideNum)}" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>${hwpxPagePrXml(setup)}${NOTE_PR}${PAGE_BORDERS}</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>${hfCtrls(k, setup)}</hp:run>`;
  };
  const itemXml = (it: FlowItem, prefix: string, pageBreak: boolean) => {
    if (it.kind === "p") return pXml(it.p, prefix, pageBreak);
    // a table is an object inside a run of its own paragraph
    const holder = newParagraph("", { fontFamily: it.t.fontFamily, fontSize: it.t.fontSize });
    holder.lineSpacing = 1;
    holder.spaceAfter = 4;
    const ppr = paraId(holder);
    return `<hp:p id="${pid++}" paraPrIDRef="${ppr}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${prefix}<hp:run charPrIDRef="${charId(holder.runs[0])}">${tblXml(it.t)}</hp:run></hp:p>`;
  };
  const push = (m: Map<number, HPic[]>, k: number, x: HPic) => m.set(k, [...(m.get(k) ?? []), x]);
  pics.targets.forEach((t, i) => {
    const { pic } = t.media;
    const f = pics.fileOf(t.media);
    const xml = hwpxPicXml({ id: 1900000000 + i, ref: `image${f.n}`, g: pic.g, place: pic.place, z: pic.z, name: pic.node.name, dim: picPixels(t.media.bytes) });
    const it = t.item >= 0 ? flow[t.item] : undefined;
    if (pic.place.mode === "float" && it) {
      const first = it.kind === "p" ? it.p.runs[0] ?? DEFAULT_RUN : DEFAULT_RUN;
      anchorRuns.set(t.item, (anchorRuns.get(t.item) ?? "") + `<hp:run charPrIDRef="${charId(first)}">${xml}<hp:t/></hp:run>`);
    } else if (t.item < 0) push(alone, pic.page, { xml, align: pic.align, indent: pic.indent, before: t.before });
    else push(t.after ? after : before, t.item, { xml, align: pic.align, indent: pic.indent, before: t.before, after: t.below });
  });
  /** a paragraph holding one picture (inline: aligned like it is placed) */
  const picParaXml = (x: HPic, prefix: string, pageBreak: boolean) => {
    const holder = newParagraph("", { fontSize: 10 * PT });
    holder.align = x.align;
    holder.spaceAfter = x.after ?? 0;
    if (x.before) holder.spaceBefore = x.before;
    holder.lineSpacing = 1;
    if (x.indent > 0) holder.indentLeft = x.indent;
    return `<hp:p id="${pid++}" paraPrIDRef="${paraId(holder)}" styleIDRef="0" pageBreak="${pageBreak ? 1 : 0}" columnBreak="0" merged="0">${prefix}<hp:run charPrIDRef="${charId(holder.runs[0])}">${x.xml}<hp:t/></hp:run></hp:p>`;
  };
  const secBodies: string[] = lay.sections.map(() => "");
  let pending: { section: number; prefix: string; pageBreak: boolean } | null = null; // what the next paragraph carries
  const flushEmpty = () => {
    // a page without text (or a section without text): an empty paragraph carries its break / settings
    if (!pending) return;
    const p = newParagraph("", { fontSize: 10 * PT });
    secBodies[pending.section] += pXml(p, pending.prefix, pending.pageBreak);
    pending = null;
  };
  lay.pages.forEach((pg) => {
    curSection = pg.section;
    if (pg.begin === "first" || pg.begin === "section") {
      flushEmpty();
      const first = flow[pg.from];
      const run = first?.kind === "p" ? first.p.runs[0] ?? DEFAULT_RUN : DEFAULT_RUN;
      pending = { section: pg.section, prefix: secPrOf(lay.sections[pg.section], run, pg.section), pageBreak: false };
    } else if (pg.begin === "page") {
      flushEmpty();
      pending = { section: pg.section, prefix: "", pageBreak: true };
    }
    // the section's second page after a first page with its own header / footer: the usual ones again from here
    const pi = lay.pages.indexOf(pg);
    if (pi > 0 && lay.pages[pi - 1].section === pg.section && (pi < 2 || lay.pages[pi - 2].section !== pg.section) && hwSecs[pg.section]?.later?.length) {
      const first = flow[pg.from];
      const run = first?.kind === "p" ? first.p.runs[0] ?? DEFAULT_RUN : DEFAULT_RUN;
      const ctrl = `<hp:run charPrIDRef="${charId(run)}">${hfCtrls(pg.section, lay.sections[pg.section], true)}</hp:run>`;
      if (pending) (pending as { prefix: string }).prefix += ctrl;
      else pending = { section: pg.section, prefix: ctrl, pageBreak: false };
    }
    const take = () => {
      const c: { section: number; prefix: string; pageBreak: boolean } | null = pending;
      pending = null;
      return c;
    };
    const picPara = (x: HPic) => {
      const c = take();
      secBodies[pg.section] += picParaXml(x, c?.prefix ?? "", !!c?.pageBreak);
    };
    for (let k = pg.from; k < pg.to; k++) {
      for (const x of before.get(k) ?? []) picPara(x);
      const carry = take();
      secBodies[pg.section] += itemXml(flow[k], (carry?.prefix ?? "") + (anchorRuns.get(k) ?? ""), !!carry?.pageBreak);
      for (const x of after.get(k) ?? []) picPara(x);
    }
    if (pg.from >= pg.to) for (const x of alone.get(lay.pages.indexOf(pg)) ?? []) picPara(x);
  });
  flushEmpty();
  const fontsXml = (lang: string) =>
    `<hh:fontface lang="${lang}" fontCnt="${fontList.length}">${fontList.map((f, i) => `<hh:font id="${i}" face="${esc(f)}" type="TTF" isEmbedded="0"/>`).join("")}</hh:fontface>`;
  // numbering 1: outline (개요) without visible numbers; 2..: one per numbered list, "^1." from 1
  const paraHead = (level: number, fmt: string, text: string, start = 1) =>
    `<hh:paraHead start="${start}" level="${level}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="0">${text}</hh:paraHead>`;
  const numberedLists = legacyNumbered;
  // a multi-level numbering: its levels (paraHead level 1..), the restart number of the item that began it
  // (levels read from HWPX: every level the file had, each as written while unchanged — hwpxListHead)
  const mlHeads = (def: ListDef, starts: Map<number, number> = new Map()) =>
    Array.from({ length: Math.max(7, def.levels.reduce((n, l, i) => (l.hwpx && l.hwpx.fmt !== "BULLET" ? i + 1 : n), 0)) }, (_, i) => {
      const lv = levelOf(def, i);
      const fmt = HWPX_NUMFMT_OUT[lv.format] ?? "DIGIT";
      const text = lv.format === "bullet" ? "" : toHwpxLevelText(lv.text);
      const start = starts.get(i) ?? lv.start ?? 1;
      return lv.hwpx && lv.hwpx.fmt !== "BULLET" && i < def.levels.length ? hwpxListHead(lv, start) : paraHead(i + 1, fmt, esc(text), start);
    }).join("") + (def.hwpxMore ?? []).map(hwpxDetached).join("");
  const numberings =
    `<hh:numbering id="1" start="0">${outlineDef ? mlHeads(outlineDef) : [1, 2, 3, 4, 5, 6, 7].map((l) => paraHead(l, "DIGIT", "")).join("")}</hh:numbering>` +
    Array.from({ length: numberedLists }, (_, i) => `<hh:numbering id="${i + 2}" start="0">${paraHead(1, "DIGIT", "^1.")}</hh:numbering>`).join("") +
    ml.insts.map((n, i) => `<hh:numbering id="${numberedLists + 2 + i}" start="0">${mlHeads(ml.defs[n.def], n.starts)}</hh:numbering>`).join("");
  const bulletXml = (id: number, ch: string) =>
    `<hh:bullet id="${id}" char="${esc(ch)}" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/></hh:bullet>`;
  const bullets = bulletXml(1, "•") + mlBullets.map((b, i) => (b.raw ? hwpxDetached(b.raw).replace(/(\sid=")[^"]*"/, (_, a: string) => `${a}${i + 2}"`) :bulletXml(i + 2, b.ch))).join("");
  const styles =
    `<hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>` + // i18n: keep — HWPX style name 바탕글 required by the format
    Array.from({ length: Math.max(6, headingStyle.length - 1) }, (_, i) => i + 1)
      .map((n) => {
        const hs = headingStyle[n];
        return `<hh:style id="${n}" type="PARA" name="개요 ${n}" engName="Outline ${n}" paraPrIDRef="${hs ? hs.para : 0}" charPrIDRef="${hs ? hs.char : 0}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`; // i18n: keep — HWPX style name 개요 n required by the format
      })
      .join("");
  // 메모: after the outline styles, when a memo was written (its paragraphs name it)
  const styleCnt = Math.max(7, headingStyle.length);
  const look = memoLook as { pOpen: string; cp: string } | null; // (set while the sections were written)
  const memoStyle = look
    ? `<hh:style id="${styleCnt}" type="PARA" name="메모" engName="Memo" paraPrIDRef="${/paraPrIDRef="(\d+)"/.exec(look.pOpen)![1]}" charPrIDRef="${look.cp}" nextStyleIDRef="${styleCnt}" langID="1042" lockForm="0"/>` // i18n: keep — HWPX style name 메모 as 한글 writes it
    : "";
  const memoBoxXml = memoBoxes.length
    ? `<hh:memoProperties itemCnt="${memoBoxes.length}">${memoBoxes
        .map((key, i) => {
          const v = JSON.parse(key) as string[];
          const def: Record<string, string> = { width: "15591", lineWidth: "1", lineType: "SOLID", lineColor: "#B6D7AE", fillColor: "#F0FFE9", activeColor: "#CFF1C7", memoType: "NOMAL" };
          return `<hh:memoPr id="${i + 1}" ${MEMO_SHAPE_KEYS.map((k, j) => `${k}="${esc(v[j] || def[k])}"`).join(" ")}/>`;
        })
        .join("")}</hh:memoProperties>`
    : "";
  // memo fields: each ends after its last text; sections name their memo box (0: 한글's own)
  const bodies = review.finish(secBodies).map((b) => b.replace(/\u0003memo-style\u0003/g, String(styleCnt)).replace(/\u0004(\d+)\u0004/g, (_, k: string) => secBox.get(Number(k)) ?? "0"));
  const header =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hh:head ${NS} version="1.4" secCnt="${secBodies.length}"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
    `<hh:fontfaces itemCnt="7">${["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"].map(fontsXml).join("")}</hh:fontfaces>` +
    `<hh:borderFills itemCnt="${bfXml.length}">${bfXml.join("")}</hh:borderFills>` +
    `<hh:charProperties itemCnt="${charXml.length}">${charXml.join("")}</hh:charProperties>` +
    `<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>` +
    `<hh:numberings itemCnt="${numberedLists + 1 + ml.insts.length}">${numberings}</hh:numberings>` +
    `<hh:bullets itemCnt="${1 + mlBullets.length}">${bullets}</hh:bullets>` +
    `<hh:paraProperties itemCnt="${paraXml.length}">${paraXml.join("")}</hh:paraProperties>` +
    `<hh:styles itemCnt="${styleCnt + (memoStyle ? 1 : 0)}">${styles}${memoStyle}</hh:styles>` +
    memoBoxXml +
    review.madeLists() +
    `</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="${pages[0]?.trackChanges ? 57 : 56}"/></hh:head>`;
  // (what HWPX cannot hold: replies and the resolved mark)
  opts.notes?.push(...review.warnings());
  // (header is built after the section bodies, so every charPr/paraPr/borderFill id used there exists)
  const sectionFiles = Object.fromEntries(bodies.map((b, k) => [`Contents/section${k}.xml`, strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hs:sec ${NS}>${b}</hs:sec>`)]));
  const secIds = secBodies.map((_, k) => `section${k}`);
  const preview = flow.flatMap((it) => (it.kind === "p" ? [it.p.runs.map((r) => r.text).join("")] : it.t.rows.map((r) => r.map((c) => c.text.replace(/\n/g, " ")).join("\t"))));
  const files: Zippable = {
    mimetype: [strToU8("application/hwp+zip"), { level: 0 }],
    "version.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.4" application="Omniweave" appVersion="0.1.0"/>`),
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`),
    "META-INF/manifest.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`),
    "Contents/content.hpf": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title xml:space="preserve">${esc(title)}</opf:title><opf:language>ko</opf:language></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>${pics.files.map((f) => `<opf:item id="image${f.n}" href="BinData/image${f.n}.${hwpxExt(f.m.ext)}" media-type="${HWPX_MEDIA[f.m.ext] ?? f.m.mime}" isEmbeded="1"/>`).join("")}${secIds.map((id) => `<opf:item id="${id}" href="Contents/${id}.xml" media-type="application/xml"/>`).join("")}<opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/>${secIds.map((id) => `<opf:itemref idref="${id}" linear="yes"/>`).join("")}</opf:spine></opf:package>`,
    ),
    "Contents/header.xml": strToU8(header),
    ...Object.fromEntries(pics.files.map((f) => [`BinData/image${f.n}.${hwpxExt(f.m.ext)}`, f.m.bytes])),
    ...sectionFiles,
    "Preview/PrvText.txt": strToU8(preview.join("\r\n").slice(0, 1024)),
    "settings.xml": strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`),
  };
  return zipSync(files);
}

/** the 메모 style's id in memo paragraphs until the header's styles are known (control characters never come from text) */
const MEMO_STYLE = "\u0003memo-style\u0003";

/** BinData file extension 한글 uses for a picture format */
const hwpxExt = (ext: string) => (ext === "jpeg" ? "jpg" : ext);

const HWPX_NS =
  `xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"`;

/** Footnote / endnote shapes of a section (KS X 6101 hp:footNotePr / hp:endNotePr, 한글's defaults). */
const notePr = (tag: string, place: string, length: number, between: number) =>
  `<hp:${tag}><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="${length}" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="${between}" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/></hp:${tag}>`;
const NOTE_PR = notePr("footNotePr", "EACH_COLUMN", -1, 283) + notePr("endNotePr", "END_OF_DOCUMENT", 14692344, 0);
const PAGE_BORDERS = ["BOTH", "EVEN", "ODD"]
  .map((t) => `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`)
  .join("");

/** Run content for WordprocessingML: text in w:t, tabs as <w:tab/>, line breaks as <w:br/>, no other controls. */
export function docxText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split(/(\t|\n)/)
    .map((part) => (part === "\t" ? "<w:tab/>" : part === "\n" ? "<w:br/>" : part ? `<w:t xml:space="preserve">${esc(part)}</w:t>` : ""))
    .join("") || '<w:t xml:space="preserve"></w:t>';
}

/**
 * Run text for <hp:t>: control characters are not allowed as text (한글 then opens an empty document);
 * a tab is the <hp:tab/> element and a line break <hp:lineBreak/> (KS X 6101 hp:t mixed content),
 * other C0 controls are dropped.
 */
export function hwpxText(text: string): string {
  return esc(text)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, '<hp:tab width="4000" leader="0" type="1"/>')
    .replace(/[\n\u000b\u2028]/g, "<hp:lineBreak/>")
    .replace(/[\u0000-\u0008\u000c\u000e-\u001f\u007f]/g, "");
}

/** hp:subList elements under `el` that are not inside another subList (nested ones belong to inner objects). */
function outerSubLists(el: Element): Element[] {
  const out: Element[] = [];
  for (const c of children(el)) {
    if (c.localName === "subList") out.push(c);
    else out.push(...outerSubLists(c));
  }
  return out;
}

/** hh:borderFill: border colour (null = no borders) and optional cell fill. */
function borderFill(id: number, border: string | null, fill: string | null): string {
  const side = (n: string) => `<hh:${n} type="${border ? "SOLID" : "NONE"}" width="0.12 mm" color="#${border ? hex6(border) : "000000"}"/>`;
  return (
    `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>` +
    `${side("leftBorder")}${side("rightBorder")}${side("topBorder")}${side("bottomBorder")}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>` +
    (fill ? `<hc:fillBrush><hc:winBrush faceColor="#${hex6(fill)}" hatchColor="#000000" alpha="0"/></hc:fillBrush>` : "") +
    `</hh:borderFill>`
  );
}
