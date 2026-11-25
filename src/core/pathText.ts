// Type on a path (Illustrator's Type on a Path tool): a text node whose characters run along a path instead of lines in
// a box. `onPath.contour` is the path in the node's own coordinates, `onPath.start` how far along it the text begins
// (px). Each character sits with its baseline on the path, turned to the path's direction at its middle; what runs past
// the end of an open path is not drawn (Illustrator's overset text), a closed path wraps once around.
// The canvas (render/draw.ts), the SVG writer and the PDF writers all place the same glyphs from pathTextGlyphs.

import { cubicAt } from "./vector";
import { graphemes, layoutText, measure } from "./text";
import type { Contour, TextNode, TextRun, Vec2 } from "./types";

export interface PathText {
  contour: Contour;
  /** where along the path the text starts (px) */
  start?: number;
}

export interface PathGlyph {
  ch: string;
  run: TextRun;
  font: string;
  color: string;
  size: number;
  /** the glyph's baseline start (left end) on the path, and the path's direction there (radians) */
  x: number;
  y: number;
  angle: number;
  width: number;
}

/** The path as a polyline with its running length (curves sampled finely enough for text). */
export function flattenContour(c: Contour, steps = 24): { pts: Vec2[]; len: number[] } {
  const ns = c.nodes;
  const pts: Vec2[] = [];
  if (!ns.length) return { pts, len: [] };
  pts.push(ns[0].anchor);
  const segs = c.closed ? ns.length : ns.length - 1;
  for (let i = 0; i < segs; i++) {
    const a = ns[i], b = ns[(i + 1) % ns.length];
    const straight = a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1] && b.handleIn[0] === b.anchor[0] && b.handleIn[1] === b.anchor[1];
    if (straight) pts.push(b.anchor);
    else for (let k = 1; k <= steps; k++) pts.push(cubicAt(a.anchor, a.handleOut, b.handleIn, b.anchor, k / steps));
  }
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, len };
}

/** The point and direction at distance `s` along a flattened path (null past its ends). */
export function pointAt(f: { pts: Vec2[]; len: number[] }, s: number): { p: Vec2; angle: number } | null {
  const { pts, len } = f;
  if (pts.length < 2 || s < 0 || s > len[len.length - 1]) return null;
  let lo = 0, hi = len.length - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (len[m] <= s) lo = m;
    else hi = m;
  }
  const a = pts[lo], b = pts[hi];
  const seg = len[hi] - len[lo] || 1;
  const k = (s - len[lo]) / seg;
  return { p: [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

/** The characters of a path text placed along its path (node coordinates); [] for a text without a path. */
export function pathTextGlyphs(n: TextNode & { onPath?: PathText }, measureFn: (s: string, font: string) => number = measure): PathGlyph[] {
  const path = n.onPath;
  if (!path || path.contour.nodes.length < 2) return [];
  const f = flattenContour(path.contour);
  const total = f.len[f.len.length - 1];
  // the text's runs with their fonts, as one line (paragraphs joined by a space)
  const lay = layoutText({ ...n, width: 1e7, onPath: undefined } as TextNode);
  const out: PathGlyph[] = [];
  let s = path.start ?? 0;
  lay.lines.forEach((line, li) => {
    if (li > 0) s += measureFn(" ", line.pieces[0]?.font ?? "16px sans-serif");
    for (const pc of line.pieces) {
      if (pc.hidden) continue;
      const ls = pc.letterSpacing ?? 0;
      for (const ch of graphemes(pc.text)) {
        const w = measureFn(ch, pc.font) + ls;
        const mid = path.contour.closed ? (s + w / 2) % total : s + w / 2;
        const at = pointAt(f, mid);
        if (!at || (!path.contour.closed && s + w > total + 0.5) || (path.contour.closed && s - (path.start ?? 0) + w > total + 0.5)) return;
        // the glyph's left end: half its width back from the middle, along the path's direction
        out.push({ ch, run: pc.run, font: pc.font, color: pc.run.color ?? "#000000", size: pc.run.fontSize, width: w, angle: at.angle, x: at.p[0] - (Math.cos(at.angle) * w) / 2, y: at.p[1] - (Math.sin(at.angle) * w) / 2 });
        s += w;
      }
    }
  });
  return out;
}

/** The box a path text takes in its own coordinates: its path, grown by the largest font size. */
export function pathTextBounds(n: TextNode & { onPath?: PathText }): { x: number; y: number; w: number; h: number } | null {
  if (!n.onPath) return null;
  const { pts } = flattenContour(n.onPath.contour, 8);
  if (!pts.length) return null;
  const size = Math.max(12, ...n.paragraphs.flatMap((p) => p.runs.map((r) => r.fontSize)));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs) - size, y0 = Math.min(...ys) - size, x1 = Math.max(...xs) + size, y1 = Math.max(...ys) + size * 0.4;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
