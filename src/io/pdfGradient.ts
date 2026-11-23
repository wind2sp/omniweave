// Gradient paints → PDF shadings (2026-11-23): one builder for the vector PDF export (pdfVector) and the PDF surgeon's
// writer (an edited gradient shape written back into an AI / PDF).
//
// A linear / radial gradient (core/style Paint, `from` / `to` in units of the path's box) becomes ShadingType 2 / 3
// with a stitching function of exponential segments between its stops, extended at both ends like the canvas and SVG.
// Stop alphas become a second, grey shading over the same geometry, used as a luminosity soft mask.

import type { PDFContext, PDFDict } from "pdf-lib";
import type { Paint } from "../core/style/types";
import type { Vec2 } from "../core/types";

export type GradientPaint = Extract<Paint, { type: "gradient" }>;

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

function rgbOf(hex: string): [number, number, number] {
  const h = /^#?([0-9a-f]{6})/i.exec(hex)?.[1] ?? "000000";
  return [0, 2, 4].map((i) => r4(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
}

/** Is a paint a gradient this module (and the canvas) draws: linear or radial with at least one stop? */
export const drawableGradient = (p: Paint | undefined): p is GradientPaint => !!p && p.type === "gradient" && (p.kind === "linear" || p.kind === "radial") && p.stops.length > 0;

/** Does a gradient fade (a stop below full opacity)? */
export const gradientFades = (g: GradientPaint) => g.stops.some((s) => (s.color.a ?? 1) < 0.999);

/**
 * The shading dictionary of `g` in the space `at` maps unit (box) coordinates into. `alpha`: the grey shading of the
 * stop opacities (for a luminosity soft mask) instead of the colours.
 */
export function shadingDict(ctx: PDFContext, g: GradientPaint, at: (u: Vec2) => [number, number], alpha = false): PDFDict {
  const stops = [...g.stops].sort((p, q) => p.at - q.at).map((s) => ({ at: Math.min(1, Math.max(0, s.at)), c: alpha ? [r4(s.color.a ?? 1)] : rgbOf(s.color.hex) }));
  // the function's domain is 0..1: the end colours hold up to the ends
  if (stops[0].at > 0) stops.unshift({ ...stops[0], at: 0 });
  if (stops[stops.length - 1].at < 1) stops.push({ ...stops[stops.length - 1], at: 1 });
  if (stops.length === 1) stops.push({ ...stops[0], at: 1 });
  const segs = stops.slice(1).map((s, i) => ctx.obj({ FunctionType: 2, Domain: [0, 1], C0: stops[i].c, C1: s.c, N: 1 }));
  // always a stitching function (as Illustrator writes them), even over one segment
  const fn = ctx.obj({ FunctionType: 3, Domain: [0, 1], Functions: segs, Bounds: stops.slice(1, -1).map((s) => r4(s.at)), Encode: segs.flatMap(() => [0, 1]) });
  const [x0, y0] = at(g.from), [x1, y1] = at(g.to);
  let coords: number[];
  if (g.kind === "linear") coords = [x0, y0, x1, y1];
  else {
    const r = Math.hypot(x1 - x0, y1 - y0);
    const [fx, fy] = g.focal ? at(g.focal) : [x0, y0];
    coords = [fx, fy, (g.focalRadius ?? 0) * r, x0, y0, r];
  }
  return ctx.obj({
    ShadingType: g.kind === "linear" ? 2 : 3,
    ColorSpace: alpha ? "DeviceGray" : "DeviceRGB",
    Coords: coords.map(r4),
    Extend: [true, true],
    Function: fn,
  }) as PDFDict;
}
