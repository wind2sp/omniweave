// The patch the paragraph dialog (ParagraphDialogs.tsx) applies: only the fields the user changed, so paragraphs
// that differ keep their own values (mixed alignment, indents) and untouched lengths keep their original units
// (twips, HWPUNIT) — "Apply" without a change changes nothing.

import type { ParaPatch } from "../../core/richtext";
import type { Align, ParaLineHeight } from "../../core/types";

/** multiple = Word's 배수 (the font's single line × mult); percent = % of the font size (한글 PERCENT, older documents) */
export type LineMode = "multiple" | "percent" | "exact" | "atLeast" | "between";
export type FirstMode = "none" | "indent" | "hanging";

/** The dialog's fields, lengths in points as shown. `align` undefined = the paragraphs differ. */
export interface ParaDialogState {
  align: Align | undefined;
  left: number;
  right: number;
  firstMode: FirstMode;
  first: number;
  before: number;
  after: number;
  mode: LineMode;
  /** Word multiple (1.0 = single) */
  mult: number;
  pct: number;
  pts: number;
  keepNext: boolean;
  keepLines: boolean;
  breakBefore: boolean;
}

const PT = 96 / 72;
const fromPt = (pt: number) => pt * PT;

/** Fields changed between the dialog's first state and now, as a paragraph patch (`size` = font size, px). */
export function paraDialogPatch(init: ParaDialogState, cur: ParaDialogState, size: number): ParaPatch {
  const patch: ParaPatch = {};
  if (cur.align && cur.align !== init.align) patch.align = cur.align;
  if (cur.left !== init.left) patch.indentLeft = fromPt(cur.left);
  if (cur.right !== init.right) patch.indentRight = fromPt(cur.right);
  if (cur.firstMode !== init.firstMode || cur.first !== init.first) patch.indent = cur.firstMode === "none" ? 0 : cur.firstMode === "indent" ? fromPt(cur.first) : -fromPt(cur.first);
  if (cur.before !== init.before) patch.spaceBefore = fromPt(cur.before);
  if (cur.after !== init.after) patch.spaceAfter = fromPt(cur.after);
  if (cur.keepNext !== init.keepNext) patch.keepNext = cur.keepNext;
  if (cur.keepLines !== init.keepLines) patch.keepLines = cur.keepLines;
  if (cur.breakBefore !== init.breakBefore) patch.pageBreakBefore = cur.breakBefore;
  const lineChanged = cur.mode !== init.mode || (cur.mode === "multiple" ? cur.mult !== init.mult : cur.mode === "percent" ? cur.pct !== init.pct : cur.pts !== init.pts);
  if (lineChanged) {
    if (cur.mode === "multiple") {
      // Word multiple: each paragraph gets the size multiple of the same height alongside (core/lineSpacing.ts)
      patch.lineMultiple = Math.max(0.06, cur.mult);
      patch.lineHeight = null;
    } else if (cur.mode === "percent") {
      patch.lineSpacing = Math.max(0.1, cur.pct / 100);
      patch.lineHeight = null;
      patch.lineMultiple = null;
    } else {
      // the length is kept in points (the unit the dialog shows); lineSpacing holds the nearest multiple for older readers
      patch.lineHeight = { mode: cur.mode, v: { v: cur.pts, u: "pt" } } as ParaLineHeight;
      patch.lineSpacing = Math.round(((cur.mode === "between" ? size + fromPt(cur.pts) : fromPt(cur.pts)) / size) * 100) / 100;
    }
  }
  return patch;
}
