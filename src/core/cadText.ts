// An imported drawing text (TEXT / MTEXT) written back as it was read while nobody changed it: its nodes' look at
// import (position, size, text, alignment) is kept as a signature on the first node (TextNode.cadText); the DXF export
// compares it with the nodes now and, when equal, writes the source entity's own group codes (insertion point, the
// alignment point, justification, height) — the nodes' geometry gave them back a little off (2.5 → 2.5087 high,
// y −1.25 → −1.2609: realuse p-cad-move-one 2026-11-25). A text moved only (no other change) has its points moved by
// the same distance.
import type { TextNode, Transform } from "./types";

/** what a text's nodes look like, apart from where they are (transform x / y) */
export function cadTextSig(nodes: readonly TextNode[]): string {
  return JSON.stringify(nodes.map((n) => [n.transform.rotation, n.transform.scale, n.transform.scaleY ?? null, n.width, n.paragraphs.map((p) => [p.align, p.runs.map((r) => [r.text, r.fontSize, r.hscale ?? null])])]));
}
/**
 * Where a text's nodes are, in the coordinates its codes are written in: the drawing's (model space), the sheet's
 * (paper space) or its block's (a text of a block definition: through the insert it came in with). `toOwn` maps a
 * page point there. The writer compares these with the same points now (the move since import).
 */
export const cadTextAt = (nodes: readonly TextNode[], toOwn: (p: [number, number]) => [number, number] = (p) => p): [number, number][] => nodes.map((n) => toOwn([n.transform.x, n.transform.y]));
/** a point of the drawing → its place in a block inserted at `ins` (AutoCAD's insertion: scale, rotate, move) */
export function insLocal(ins: { p: [number, number]; rot: number; sx: number; sy: number }, p: [number, number]): [number, number] {
  const dx = p[0] - ins.p[0], dy = p[1] - ins.p[1], c = Math.cos(ins.rot), s = Math.sin(ins.rot);
  return [(dx * c + dy * s) / (ins.sx || 1), (-dx * s + dy * c) / (ins.sy || 1)];
}
export type { Transform };
