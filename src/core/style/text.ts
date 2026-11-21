// CharStyle / ParaStyle (design ch. 4.9) ↔ the flat legacy fields of TextRun / TextParagraph (design ch. 8.2).
// Every legacy value converts to a style and back unchanged; style values the legacy fields cannot hold (exact line
// height, weights between regular and bold, double strike…) come back as the nearest legacy value.

import { DEFAULT_RUN, type Align, type ParaRole, type TextParagraph, type TextRun } from "../types";
import { colorOf, legacyColor } from "./color";
import { toPx } from "./len";
import { withWordMultiple, wordMultipleOf } from "../lineSpacing";
import { representativeColor } from "./paint";
import type { CharStyle, ParaStyle } from "./types";

/** Character style of a legacy run (default-valued fields omitted). */
export function charStyleFromRun(r: TextRun): CharStyle {
  const s: CharStyle = { font: { family: r.fontFamily, ...(r.latinFont ? { scripts: { latin: r.latinFont } } : {}) }, size: { v: r.fontSize, u: "px" } };
  if (r.bold) s.weight = 700;
  if (r.italic) s.italic = true;
  if (r.underline) s.underline = "single";
  if (r.strike) s.strike = "single";
  if (r.script) s.baseline = r.script;
  const c = colorOf(r.color);
  if (c) s.fill = { type: "solid", color: c };
  const h = colorOf(r.highlight ?? null);
  if (h) s.highlight = h;
  if (r.letterSpacing) s.tracking = { v: r.letterSpacing, u: "px" };
  // 한글 자간 is a percent of each character's own advance (core/types.ts TextRun.spacingPct): tracking in "pct"
  else if (r.spacingPct) s.tracking = { v: r.spacingPct, u: "pct" };
  if (r.hscale && r.hscale !== 100) s.hscale = r.hscale;
  return s;
}

/** Legacy run from a character style; fields the style leaves open come from `base`. Keys in DEFAULT_RUN order. */
export function runFromCharStyle(text: string, s: CharStyle, base: TextRun = DEFAULT_RUN): TextRun {
  const fontSize = s.size ? toPx(s.size, base.fontSize) : base.fontSize;
  const r: TextRun = {
    text,
    fontFamily: s.font?.family ?? base.fontFamily,
    fontSize,
    bold: s.weight !== undefined ? s.weight >= 600 : base.bold,
    italic: s.italic ?? base.italic,
    underline: s.underline !== undefined ? true : base.underline,
    color: legacyColor(representativeColor(s.fill ? [s.fill] : undefined)) ?? base.color,
  };
  const latin = s.font ? s.font.scripts?.latin : base.latinFont;
  if (latin && latin !== r.fontFamily) r.latinFont = latin;
  const strike = s.strike !== undefined ? true : base.strike;
  if (strike) r.strike = true;
  const script = s.baseline === "super" || s.baseline === "sub" ? s.baseline : s.baseline !== undefined ? undefined : base.script;
  if (script) r.script = script;
  const hl = s.highlight ? legacyColor(s.highlight) : base.highlight;
  if (hl) r.highlight = hl;
  if (s.tracking?.u === "pct") {
    if (s.tracking.v) r.spacingPct = s.tracking.v;
  } else {
    const ls = s.tracking ? toPx(s.tracking, fontSize) : base.letterSpacing;
    if (ls) r.letterSpacing = ls;
  }
  const hs = s.hscale ?? base.hscale;
  if (hs && hs !== 100) r.hscale = hs;
  return r;
}

const ALIGN_IN: Record<Align, NonNullable<ParaStyle["align"]>> = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFY: "justify" };
const ALIGN_OUT: Record<NonNullable<ParaStyle["align"]>, Align> = { left: "LEFT", center: "CENTER", right: "RIGHT", justify: "JUSTIFY", distribute: "JUSTIFY" };

/**
 * Paragraph style of a legacy paragraph. lineSpacing is a multiple of the font size (the renderer draws size ×
 * multiple), which is lineHeight basis "em" exactly; a Word multiple (core/lineSpacing.ts) is basis "font".
 */
export function paraStyleFromParagraph(p: TextParagraph): ParaStyle {
  const wm = wordMultipleOf(p);
  const s: ParaStyle = { align: ALIGN_IN[p.align], lineHeight: wm !== undefined ? { mode: "multiple", v: wm, basis: "font" } : { mode: "multiple", v: p.lineSpacing, basis: "em" } };
  if (p.indent || p.indentLeft) {
    s.indent = {};
    if (p.indentLeft) s.indent.start = { v: p.indentLeft, u: "px" };
    if (p.indent) s.indent.first = { v: p.indent, u: "px" };
  }
  s.spaceAfter = { v: p.spaceAfter, u: "px" };
  if (p.spaceBefore) s.spaceBefore = { v: p.spaceBefore, u: "px" };
  if (p.indentRight) (s.indent ??= {}).end = { v: p.indentRight, u: "px" };
  if (p.lineHeight) s.lineHeight = p.lineHeight;
  if (p.keepNext) s.keepNext = true;
  if (p.keepLines) s.keepLines = true;
  if (p.pageBreakBefore) s.breakBefore = "page";
  if (p.list) s.list = { id: p.list.id, level: p.list.level };
  if (p.role) s.role = p.role;
  return s;
}

/** Legacy paragraph fields from a paragraph style. `fontSize` (px) turns exact / at-least line heights into a multiple. */
export function paragraphFromParaStyle(id: string, runs: TextRun[], s: ParaStyle, fontSize = runs[0]?.fontSize ?? DEFAULT_RUN.fontSize): TextParagraph {
  const lh = s.lineHeight;
  const lineSpacing = !lh ? 1.6 : lh.mode === "multiple" ? lh.v : fontSize > 0 ? toPx(lh.v, fontSize) / fontSize : 1;
  const p0: TextParagraph = {
    id,
    runs,
    align: s.align ? ALIGN_OUT[s.align] : "LEFT",
    lineSpacing,
    indent: s.indent?.first ? toPx(s.indent.first, fontSize) : 0,
    spaceAfter: s.spaceAfter ? toPx(s.spaceAfter, fontSize) : 0,
  };
  const p = lh?.mode === "multiple" && lh.basis === "font" ? withWordMultiple(p0, lh.v) : p0;
  const left = s.indent?.start ? toPx(s.indent.start, fontSize) : 0;
  if (left) p.indentLeft = left;
  if (s.spaceBefore) p.spaceBefore = toPx(s.spaceBefore, fontSize);
  if (s.indent?.end) p.indentRight = toPx(s.indent.end, fontSize);
  if (lh && lh.mode !== "multiple") p.lineHeight = lh;
  if (s.keepNext) p.keepNext = true;
  if (s.keepLines) p.keepLines = true;
  if (s.breakBefore === "page") p.pageBreakBefore = true;
  if (s.role) p.role = s.role as ParaRole;
  return p;
}
