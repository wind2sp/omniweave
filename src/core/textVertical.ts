// Vertical type (Photoshop's 세로 문자 도구, a TextNode with `vertical`): each paragraph is a column read top to
// bottom, columns run right to left; Hangul, CJK, digits and Latin letters stand upright one under the other (the
// usual Korean poster setting), each in a square cell of its run's size. Shared by the screen (render/draw.ts) and the
// bounds (core/loom.ts). Pure apart from the canvas the painter is given.

import type { TextNode } from "./types";

export interface VCell {
  ch: string;
  x: number;
  y: number;
  size: number;
  font: string;
  color: string;
  bold: boolean;
  italic: boolean;
}

/** Cells of a vertical text, and its box (local px, origin at the top-left). */
export function verticalLayout(n: TextNode): { cells: VCell[]; w: number; h: number } {
  const cols = n.paragraphs.map((p) => {
    const cells: Omit<VCell, "x">[] = [];
    let y = 0, colSize = 0;
    for (const r of p.runs)
      for (const ch of Array.from(r.text)) {
        if (ch === "\n") continue;
        cells.push({ ch, y, size: r.fontSize, font: r.fontFamily, color: r.color, bold: r.bold, italic: r.italic });
        // a space is half a cell, as in Photoshop's vertical type
        y += ch === " " ? r.fontSize / 2 : r.fontSize;
        colSize = Math.max(colSize, r.fontSize);
      }
    if (!colSize) colSize = p.runs[0]?.fontSize ?? 24;
    return { cells, h: y, w: colSize * Math.max(1, p.lineSpacing || 1.2) };
  });
  const w = cols.reduce((a, c) => a + c.w, 0);
  const h = Math.max(1, ...cols.map((c) => c.h));
  const out: VCell[] = [];
  let x = w;
  for (const c of cols) {
    x -= c.w;
    for (const cell of c.cells) out.push({ ...cell, x: x + (c.w - cell.size) / 2 });
  }
  return { cells: out, w: Math.max(1, w), h };
}

/** Paint a vertical text (local px; the caller set the node's transform). */
export function drawVerticalText(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, n: TextNode) {
  const { cells, w, h } = verticalLayout(n);
  if (n.background) {
    ctx.fillStyle = n.background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const c of cells) {
    if (c.ch === " ") continue;
    ctx.font = `${c.italic ? "italic " : ""}${c.bold ? "bold " : ""}${c.size}px "${c.font}", sans-serif`;
    ctx.fillStyle = c.color;
    // vertical punctuation turned: the cell's glyph rotated where a vertical form is expected (、。 shifted up-right)
    const turn = /[\(\)\[\]{}〈〉《》「」『』【】—–~…ー-]/.test(c.ch);
    if (turn) {
      ctx.save();
      ctx.translate(c.x + c.size / 2, c.y + c.size / 2);
      ctx.rotate(Math.PI / 2);
      ctx.fillText(c.ch, 0, 0);
      ctx.restore();
    } else ctx.fillText(c.ch, c.x + c.size / 2, c.y + c.size / 2);
  }
}
