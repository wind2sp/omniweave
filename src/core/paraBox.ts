// Paragraph borders and shading (Word w:pBdr / pPr w:shd, 한글 문단 테두리·배경): the room they take in the layout and
// the boxes the renderers draw. Paragraphs in a row with the same borders, shading and indents make one box, as in
// Word: the top line over the first, the bottom line under the last, the `between` line between them.

import type { ParaBorderLine, ParaBorders, TextParagraph } from "./types";

const key = (p: TextParagraph) => JSON.stringify([p.border ?? null, p.shade ?? "", p.indentLeft ?? 0, p.indentRight ?? 0]);

/** p and q are in one bordered / shaded box */
export function sameBox(p: TextParagraph | undefined, q: TextParagraph | undefined): boolean {
  return !!p && !!q && (!!p.border || !!p.shade) && key(p) === key(q);
}

const room = (l: ParaBorderLine | undefined) => (l ? l.space + l.w : 0);

/** Extra room above and below paragraph i for its border lines (laid out outside its space before / after). */
export function boxExtra(ps: readonly TextParagraph[], i: number): { top: number; bottom: number } {
  const p = ps[i];
  const b = p?.border;
  if (!b) return { top: 0, bottom: 0 };
  const first = !sameBox(ps[i - 1], p), last = !sameBox(p, ps[i + 1]);
  return { top: first ? room(b.top) : room(b.between), bottom: last ? room(b.bottom) : 0 };
}

export interface ParaBox {
  /** the paragraph */
  pi: number;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  border?: ParaBorders;
  shade?: string;
  /** first / last of its box (top / bottom line drawn) */
  first: boolean;
  last: boolean;
}

/**
 * The boxes of the bordered / shaded paragraphs of a laid-out text (node-local): from the top of the paragraph's lines
 * less its top room to the bottom of its lines plus its bottom room; a paragraph followed by one of the same box reaches
 * down to that one's top (the space between them is inside the box).
 */
export function paraBoxes(ps: readonly TextParagraph[], width: number, lines: readonly { y: number; height: number; paragraph: number }[]): ParaBox[] {
  const span = new Map<number, { top: number; bottom: number }>();
  for (const l of lines) {
    const s = span.get(l.paragraph);
    if (!s) span.set(l.paragraph, { top: l.y, bottom: l.y + l.height });
    else s.bottom = Math.max(s.bottom, l.y + l.height);
  }
  const out: ParaBox[] = [];
  ps.forEach((p, pi) => {
    if (!p.border && !p.shade) return;
    const s = span.get(pi);
    if (!s) return;
    const e = boxExtra(ps, pi);
    const b = p.border;
    out.push({
      pi,
      x0: (p.indentLeft ?? 0) - room(b?.left),
      x1: width - (p.indentRight ?? 0) + room(b?.right),
      top: s.top - e.top,
      bottom: s.bottom + e.bottom,
      ...(b ? { border: b } : {}),
      ...(p.shade ? { shade: p.shade } : {}),
      first: !sameBox(ps[pi - 1], p),
      last: !sameBox(p, ps[pi + 1]),
    });
  });
  // a box going on into the next paragraph: down to that one's top
  for (let i = 0; i + 1 < out.length; i++) if (!out[i].last && out[i + 1].pi === out[i].pi + 1) out[i].bottom = out[i + 1].top;
  return out;
}

/** Line segments of a box's borders: [x0, y0, x1, y1, line] (the line's middle on the box edge's inside). */
export function boxLines(b: ParaBox): [number, number, number, number, ParaBorderLine][] {
  const out: [number, number, number, number, ParaBorderLine][] = [];
  const B = b.border;
  if (!B) return out;
  const top = b.first ? B.top : B.between;
  if (top) out.push([b.x0, b.top + top.w / 2, b.x1, b.top + top.w / 2, top]);
  if (b.last && B.bottom) out.push([b.x0, b.bottom - B.bottom.w / 2, b.x1, b.bottom - B.bottom.w / 2, B.bottom]);
  if (B.left) out.push([b.x0 + B.left.w / 2, b.top, b.x0 + B.left.w / 2, b.bottom, B.left]);
  if (B.right) out.push([b.x1 - B.right.w / 2, b.top, b.x1 - B.right.w / 2, b.bottom, B.right]);
  return out;
}
