// Word-processor ruler of the document edit mode (Rulers.tsx calls in): zero at the margin, the margins shaded,
// and the paragraph indents of the text being edited (or the selected text box) as markers you can drag —
// first line ▽ on top, hanging ▲ and left □ at the bottom left, right ▲ at the bottom right.
// Tab stops: the model has none yet, so the ruler leaves room for them but draws none (EDIT_MODES.md).

import { currentPage, useStore } from "../core/store";
import type { TextNode } from "../core/types";
import { hfEditNode, parseHfId } from "../core/headerFooter";
import { marginsOf } from "../core/pageSetup";
import { PX_PER, type Unit } from "../core/units";
import { hairCss, snapEdge, snapStroke } from "../render/crisp";
import { docRulerUnit } from "./editModes";
import { textTargetNow } from "./shell/Ribbon";
import { t } from "../i18n";

const S = () => useStore.getState();

/** Ruler unit in the document mode: the corner menu's choice, else cm (in for English) */
export const docRulerUnitFor = (setting: Unit | "auto"): Unit => (setting === "auto" ? docRulerUnit() : setting);

/** Where the ruler's zero is (page px): the left / top margin. */
export function docOrigin(horizontal: boolean): number {
  const page = currentPage();
  if (!page) return 0;
  const m = marginsOf(page);
  return horizontal ? m.left : m.top;
}

/** Shade the margins of the page span, the body brighter (like paper between grey margins). */
export function paintDocBand(g: CanvasRenderingContext2D, horizontal: boolean, at: (v: number) => number, colors: { margin: string; body: string }, dpr = 1) {
  const page = currentPage();
  if (!page) return;
  const m = marginsOf(page);
  const len = horizontal ? page.width : page.height;
  const a = horizontal ? m.left : m.top, b = len - (horizontal ? m.right : m.bottom);
  const R = 20;
  const span = (v0: number, v1: number, c: string) => {
    g.fillStyle = c;
    // band edges on device-pixel boundaries (render/crisp.ts), so the margin edge is one sharp step
    const p0 = snapEdge(at(v0), dpr), p1 = snapEdge(at(v1), dpr);
    if (horizontal) g.fillRect(p0, 3, p1 - p0, R - 6);
    else g.fillRect(3, p0, R - 6, p1 - p0);
  };
  span(0, a, colors.margin);
  span(b, len, colors.margin);
  span(a, b, colors.body);
}

export interface IndentMarks {
  node: TextNode;
  /** page px */
  left: number;
  first: number;
  right: number;
  x0: number;
  s: number;
}

/** The indents of the paragraph under the caret (or of the selected text box), in page px. */
export function indentMarks(): IndentMarks | null {
  const s = S();
  const page = currentPage();
  if (!page) return null;
  const id = s.editingTextId ?? (s.selection.length === 1 ? s.selection[0] : null);
  if (!id) return null;
  // (the document body being typed in: its frame on this page — the id names the flow, not a node; QA 11-25 real use:
  // the ruler showed no indent markers for the body)
  const node = parseHfId(id) ? hfEditNode(s.doc, id) : id.startsWith("flow:") ? page.nodes.find((n) => n.type === "TEXT" && n.flow) : page.nodes.find((n) => n.id === id);
  if (!node || node.type !== "TEXT") return null;
  const tg = textTargetNow();
  if (!tg) return null;
  const p = tg.para;
  const k = node.transform.scale;
  const x0 = node.transform.x;
  const left = x0 + (p.indentLeft ?? 0) * k;
  return { node, x0, s: k, left, first: left + (p.indent ?? 0) * k, right: x0 + (node.width - (p.indentRight ?? 0)) * k };
}

export type IndentHandle = "first" | "hanging" | "left" | "right";

/** Draw the markers (`preview` replaces one marker's position while it is dragged). */
export function drawIndentMarks(g: CanvasRenderingContext2D, at: (v: number) => number, m: IndentMarks, fill: string, edge: string, preview?: { h: IndentHandle; pos: number } | null, dpr = 1) {
  let { first, left, right } = m;
  if (preview) {
    if (preview.h === "first") first = preview.pos;
    else if (preview.h === "hanging") left = preview.pos;
    else if (preview.h === "left") {
      first += preview.pos - left;
      left = preview.pos;
    } else right = preview.pos;
  }
  g.save();
  g.fillStyle = fill;
  g.strokeStyle = edge;
  g.lineWidth = hairCss(dpr);
  const tri = (x: number, down: boolean) => {
    const cx = snapStroke(at(x), dpr);
    g.beginPath();
    if (down) {
      g.moveTo(cx - 5, 1.5);
      g.lineTo(cx + 5, 1.5);
      g.lineTo(cx, 7.5);
    } else {
      g.moveTo(cx - 5, 14);
      g.lineTo(cx + 5, 14);
      g.lineTo(cx, 8);
    }
    g.closePath();
    g.fill();
    g.stroke();
  };
  tri(first, true);
  tri(left, false);
  const lx = snapStroke(at(left), dpr);
  g.fillRect(lx - 5, 15, 10, 4);
  g.strokeRect(lx - 5, 15, 10, 4);
  tri(right, false);
  g.restore();
}

/** Which marker is under ruler point (x along the ruler, y across it), if any. */
export function hitIndent(m: IndentMarks, at: (v: number) => number, x: number, y: number): IndentHandle | null {
  const near = (v: number) => Math.abs(at(v) - x) <= 6;
  if (y < 8 && near(m.first)) return "first";
  if (y >= 8 && near(m.right) && !near(m.left)) return "right";
  if (y >= 15 && near(m.left)) return "left";
  if (y >= 8 && near(m.left)) return "hanging";
  if (y >= 8 && near(m.right)) return "right";
  return null;
}

/** Snap a dragged indent to the ruler's fine step: 0.5 mm, or 1/16 in. */
export function snapIndent(pos: number, origin: number, unit: Unit): number {
  const step = unit === "in" ? PX_PER.in / 16 : PX_PER.mm / 2;
  return origin + Math.round((pos - origin) / step) * step;
}

/** Apply a dragged marker to the paragraphs (one undo step). */
export function applyIndent(h: IndentHandle, m: IndentMarks, pos: number) {
  const tg = textTargetNow();
  if (!tg) return;
  const label = t("docmode.indent");
  const toLocal = (v: number) => Math.round(((v - m.x0) / m.s) * 100) / 100;
  if (h === "first") tg.setPara({ indent: Math.round(((pos - m.left) / m.s) * 100) / 100 }, label);
  else if (h === "hanging") {
    // the left edge of the other lines moves; the first line stays where it is
    const left = Math.max(0, toLocal(pos));
    tg.setPara({ indentLeft: left, indent: Math.round(((m.first - m.x0) / m.s - left) * 100) / 100 }, label);
  } else if (h === "left") tg.setPara({ indentLeft: Math.max(0, toLocal(pos)) }, label);
  else tg.setPara({ indentRight: Math.max(0, Math.round((m.node.width - toLocal(pos)) * 100) / 100) }, label);
}
