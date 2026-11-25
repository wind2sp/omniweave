// 서식 복사 (Word's Format Painter, 한글 모양 복사) and the font size keys, shared by the document body (ui/docFlow.ts),
// the text boxes of slides and designs (RichTextEditor.tsx) and selected text boxes (commands.ts):
//   Ctrl+Shift+C copies the character format at the selection, Ctrl+Shift+V puts it on the selection (or the word at
//   the caret); the 서식 복사 brush button copies it and puts it on the next selection made with the mouse.
//   Ctrl+] / Ctrl+[ make the text 1 pt larger / smaller, Ctrl+Shift+. / Ctrl+Shift+, step through the size list (Word).

import { create } from "zustand";
import * as RT from "../core/richtext";
import { t } from "../i18n";

/** What a text being edited (or selected) offers here: its format now and a one-step character format patch. */
export interface PaintTarget {
  fmt: Partial<RT.RunFormat>;
  applyRun?: (patch: RT.RunPatch, label: string) => void;
  /** at a caret: select the word there first (Word / PowerPoint paint the word at the caret) */
  wordFirst?: () => void;
}

/** The word around a caret (letters and digits), or null between words. */
export function wordAround(paras: readonly import("../core/types").TextParagraph[], pos: RT.Pos): RT.Range | null {
  const t = paras[pos.p] ? RT.paraText(paras[pos.p]) : "";
  const w = /[\p{L}\p{N}_]/u;
  let a = pos.o, b = pos.o;
  while (a > 0 && w.test(t[a - 1])) a--;
  while (b < t.length && w.test(t[b])) b++;
  return b > a ? { start: { p: pos.p, o: a }, end: { p: pos.p, o: b } } : null;
}

/** The character format fields the painter carries (not notes, fields, objects or review marks). */
export const PAINT_KEYS = ["fontFamily", "latinFont", "fontSize", "bold", "italic", "underline", "strike", "color", "highlight", "script", "letterSpacing", "hscale", "spacingPct"] as const;

/** The look of a shape or picture the painter carries (slides and designs: ui/slidePainter.ts). */
export interface ObjFormat {
  fill?: string | null;
  stroke?: string | null;
  strokeWidth?: number;
  effects?: import("../core/style/types").Effect[];
  opacity: number;
}

export const usePainter = create<{
  /** the copied character format (null: none copied) */
  fmt: RT.RunPatch | null;
  /** the copied look of a shape / picture (null: none copied); a copy of one kind clears the other */
  obj: ObjFormat | null;
  /** the brush is waiting for a selection made with the mouse (or the next object picked) */
  armed: boolean;
  /** a double-clicked brush: it stays armed until Esc */
  sticky: boolean;
  /** the objects the format was taken from (picking them again does not paint) */
  source: string[];
}>(() => ({ fmt: null, obj: null, armed: false, sticky: false, source: [] }));

/** The copied format of `fmt`: every painter field, the ones it does not have cleared (null). */
function patchOf(fmt: Partial<RT.RunFormat>): RT.RunPatch {
  const out: Record<string, unknown> = {};
  for (const k of PAINT_KEYS) out[k] = (fmt as Record<string, unknown>)[k] ?? null;
  // (a mixed selection has no single size / font: those are left as the target has them)
  for (const k of ["fontFamily", "fontSize", "color"]) if (out[k] === null) delete out[k];
  return out as RT.RunPatch;
}

/** Ctrl+Shift+C: copy the format of the target's selection. */
export function copyFormat(tg: PaintTarget | null, arm = false): boolean {
  if (!tg) return false;
  usePainter.setState({ fmt: patchOf(tg.fmt), obj: null, armed: arm, sticky: false, source: [] });
  return true;
}

/** Ctrl+Shift+V (or the armed brush): put the copied format on the target's selection. False when nothing was copied. */
export function pasteFormat(tg: PaintTarget | null): boolean {
  const { fmt } = usePainter.getState();
  if (!tg?.applyRun || !fmt) return false;
  tg.wordFirst?.();
  tg.applyRun(fmt, t("cmd.format.pasteFormat"));
  usePainter.setState({ armed: usePainter.getState().sticky });
  return true;
}

/** The brush button: copy now and paint the next mouse selection; pressed again while armed: put it away. */
export function toggleBrush(tg: PaintTarget | null): boolean {
  if (usePainter.getState().armed) {
    usePainter.setState({ armed: false, sticky: false });
    return true;
  }
  return copyFormat(tg, true);
}

/** A selection made with the mouse just ended: the armed brush paints it. */
export function brushSelectionDone(tg: PaintTarget | null, collapsed: boolean): boolean {
  if (!usePainter.getState().armed || collapsed) return false;
  return pasteFormat(tg);
}

// ───────── font size ─────────

/** Word's font size list (pt). */
export const SIZE_LIST = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
const PX_PER_PT = 96 / 72;

/** The next size in pt: by 1 pt (`step`, Ctrl+] / Ctrl+[) or to the next size of the list (`list`, Ctrl+Shift+. / ,). */
export function nextSize(pt: number, dir: 1 | -1, how: "step" | "list"): number {
  if (how === "step") return Math.max(1, Math.min(1638, Math.round(pt) + dir));
  if (dir > 0) return SIZE_LIST.find((s) => s > pt + 0.01) ?? Math.min(1638, (Math.floor(pt / 10) + 1) * 10); // (past 72: by 10, Word)
  for (let i = SIZE_LIST.length - 1; i >= 0; i--) if (SIZE_LIST[i] < pt - 0.01) return SIZE_LIST[i];
  return Math.max(1, Math.floor(pt) - 1);
}

/** Make the target's text larger / smaller (sizes in px in the model, pt for the steps). */
export function stepFontSize(tg: PaintTarget | null, dir: 1 | -1, how: "step" | "list"): boolean {
  if (!tg?.applyRun) return false;
  const px = tg.fmt.fontSize ?? 16;
  const pt = nextSize(px / PX_PER_PT, dir, how);
  tg.applyRun({ fontSize: Math.round(pt * PX_PER_PT * 100) / 100 }, t(dir > 0 ? "cmd.text.sizeUp" : "cmd.text.sizeDown"));
  return true;
}
