// AutoCAD's common hatch patterns (acad.pat), shared by the drawing screen's HATCH (ui/cad/hatch.ts) and the DXF
// export (dxfWrite2000.ts).

import type { HatchLine } from "./model";

/** acad.pat lines: angle, origin x, y, offset along, offset across, dashes (+ dash, − gap, 0 dot), at scale 1. */
export const PATTERNS: Record<string, number[][]> = {
  ANSI31: [[45, 0, 0, 0, 3.175]],
  ANSI32: [[45, 0, 0, 0, 9.525], [45, 4.49013, 0, 0, 9.525]],
  ANSI33: [[45, 0, 0, 0, 6.35], [45, 4.49013, 0, 0, 6.35, 3.175, -1.5875]],
  ANSI34: [[45, 0, 0, 0, 19.05], [45, 4.49013, 0, 0, 19.05], [45, 8.98026, 0, 0, 19.05], [45, 13.4704, 0, 0, 19.05]],
  ANSI35: [[45, 0, 0, 0, 6.35], [45, 4.49013, 0, 0, 6.35, 7.9375, -1.5875, 0, -1.5875]],
  ANSI36: [[45, 0, 0, 5.55625, 3.175, 7.9375, -1.5875, 0, -1.5875]],
  ANSI37: [[45, 0, 0, 0, 3.175], [135, 0, 0, 0, 3.175]],
  ANSI38: [[45, 0, 0, 0, 3.175], [135, 0, 0, 6.35, 3.175, 7.9375, -4.7625]],
  NET: [[0, 0, 0, 0, 3.175], [90, 0, 0, 0, 3.175]],
  LINE: [[0, 0, 0, 0, 3.175]],
  DASH: [[0, 0, 0, 3.175, 3.175, 3.175, -3.175]],
  DOTS: [[0, 0, 0, 0.79375, 1.5875, 0, -1.5875]],
  BRICK: [[0, 0, 0, 0, 6.35], [90, 0, 0, 6.35, 6.35, 6.35, -6.35], [90, 3.175, 0, 6.35, 6.35, -6.35, 6.35]],
  CROSS: [[0, 0, 0, 6.35, 6.35, 3.175, -9.525], [90, 1.5875, -1.5875, 6.35, 6.35, 3.175, -9.525]],
};
/** Names HATCH offers: SOLID, the patterns, and the gradient. */
export const HATCH_NAMES = ["SOLID", ...Object.keys(PATTERNS), "GRADIENT"];
export const isGradient = (p: string) => /^GR|GRADIENT/i.test(p);

/** A pattern's line families at a scale and angle (degrees), in drawing units. */
export function patternLines(name: string, scale: number, angle: number): HatchLine[] {
  const def = PATTERNS[name.toUpperCase()];
  if (!def) return [];
  const r = (angle * Math.PI) / 180;
  const rot = (x: number, y: number, a: number): [number, number] => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
  return def.map(([a, x, y, dx, dy, ...dashes]) => {
    const la = ((a + angle) * Math.PI) / 180;
    return { angle: a + angle, base: rot(x * scale, y * scale, r), offset: rot(dx * scale, dy * scale, la), dashes: dashes.map((v) => v * scale) };
  });
}

