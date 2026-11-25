// Arrowheads at the ends of an open path (Illustrator's Stroke panel › Arrowheads): a start and an end head, a scale
// in percent, the tip beyond the path's end (Illustrator's default "extend arrow tip beyond end of path"). The heads are
// plain filled shapes in the node's own coordinates, so the canvas, SVG, PDF and Illustrator saves all draw the same
// shapes in the stroke colour.

import { ellipseContour } from "./vector";
import type { Contour, Vec2, VectorAnchor, VectorNode } from "./types";

export type ArrowHead = "triangle" | "open" | "circle" | "square" | "bar";
export const ARROW_HEADS: readonly ArrowHead[] = ["triangle", "open", "circle", "square", "bar"];

export interface StrokeArrows {
  start?: ArrowHead;
  end?: ArrowHead;
  /** percent of the default size (Illustrator 100) */
  scale?: number;
}

const pt = (x: number, y: number): VectorAnchor => ({ anchor: [x, y], handleIn: [x, y], handleOut: [x, y], isCorner: true });
const same = (a: Vec2, b: Vec2) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** The end point of the path and the unit direction the path leaves it in (pointing out of the path). */
function endOf(c: Contour, atStart: boolean): { p: Vec2; d: Vec2 } | null {
  const ns = c.nodes;
  if (ns.length < 2) return null;
  const a = atStart ? ns[0] : ns[ns.length - 1];
  const b = atStart ? ns[1] : ns[ns.length - 2];
  // the tangent: the end's own handle, else the neighbour's handle, else the neighbour itself
  const h = atStart ? a.handleOut : a.handleIn;
  const hb = atStart ? b.handleIn : b.handleOut;
  const from = !same(h, a.anchor) ? h : !same(hb, a.anchor) ? hb : b.anchor;
  const dx = a.anchor[0] - from[0], dy = a.anchor[1] - from[1];
  const l = Math.hypot(dx, dy);
  if (l < 1e-9) return null;
  return { p: a.anchor, d: [dx / l, dy / l] };
}

function head(kind: ArrowHead, p: Vec2, d: Vec2, w: number): Contour {
  // u along the path (out of it), v across it; sizes in stroke widths (min 1 px stroke)
  const at = (u: number, v: number) => pt(p[0] + d[0] * u - d[1] * v, p[1] + d[1] * u + d[0] * v);
  switch (kind) {
    case "triangle":
      return { closed: true, nodes: [at(w * 4.5, 0), at(-w * 1.5, w * 2.25), at(-w * 1.5, -w * 2.25)] };
    case "open": {
      // a chevron one stroke width thick
      const t = w;
      return { closed: true, nodes: [at(w * 3, 0), at(-w * 1.5, w * 3), at(-w * 1.5 - t, w * 3 - t), at(w * 3 - t * 1.5, 0), at(-w * 1.5 - t, -w * 3 + t), at(-w * 1.5, -w * 3)] };
    }
    case "circle": {
      const r = w * 2.25;
      const c = ellipseContour(p[0] + d[0] * r * 0.5, p[1] + d[1] * r * 0.5, r, r);
      return c;
    }
    case "square":
      return { closed: true, nodes: [at(w * 2.5, w * 2), at(w * 2.5, -w * 2), at(-w * 1.5, -w * 2), at(-w * 1.5, w * 2)] };
    case "bar":
      return { closed: true, nodes: [at(w * 0.5, w * 3), at(w * 0.5, -w * 3), at(-w * 0.5, -w * 3), at(-w * 0.5, w * 3)] };
  }
}

/** The arrowheads of a path (its open contours' ends) as closed contours in the node's coordinates; [] when none. */
export function arrowContours(n: Pick<VectorNode, "contours" | "strokeWidth" | "stroke"> & { strokeArrows?: StrokeArrows }): Contour[] {
  const a = n.strokeArrows;
  if (!a || (!a.start && !a.end) || !n.stroke) return [];
  const w = Math.max(1, n.strokeWidth) * ((a.scale ?? 100) / 100);
  const out: Contour[] = [];
  for (const c of n.contours) {
    if (c.closed) continue;
    if (a.start) {
      const e = endOf(c, true);
      if (e) out.push(head(a.start, e.p, e.d, w));
    }
    if (a.end) {
      const e = endOf(c, false);
      if (e) out.push(head(a.end, e.p, e.d, w));
    }
  }
  return out;
}

/** The arrowheads as a filled path node in the stroke colour (for the writers that draw nodes: SVG, PDF). */
export function arrowNode<T extends VectorNode>(n: T): T | null {
  const contours = arrowContours(n as VectorNode & { strokeArrows?: StrokeArrows });
  if (!contours.length) return null;
  return { ...n, contours, fill: n.stroke, stroke: null, strokeWidth: 0, fillRule: "nonzero", strokeDash: undefined, fills: undefined, strokes: undefined } as T;
}
