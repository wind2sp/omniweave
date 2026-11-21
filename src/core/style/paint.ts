// Paint (design ch. 4.3): one fill type for vectors, text-frame backgrounds, table cells and page backgrounds.
// The legacy fields (VectorNode.fill, TextNode.background, TableCell.fill, Page.background — hex strings or null)
// map to `Paint[]` and back without loss for every value they can hold (design ch. 8.2).

import { colorEq, colorOf, legacyColor, normalizeColor } from "./color";
import type { Color, Paint } from "./types";

export const solid = (c: Color | string): Paint => ({ type: "solid", color: typeof c === "string" ? colorOf(c) ?? { hex: "#000000" } : c });

/** Legacy fill string (null = none) → fills (bottom → top). An unreadable string becomes no fill. */
export function fillsFromLegacy(fill: string | null | undefined): Paint[] {
  const c = colorOf(fill ?? null);
  return c ? [{ type: "solid", color: c }] : [];
}

/**
 * The single colour a format with only solid fills (and the dual-written legacy field) shows for `fills`: the top
 * visible paint's colour — a solid's colour, a gradient's first stop, a pattern's foreground. Null = no fill.
 */
export function representativeColor(fills: readonly Paint[] | undefined): Color | null {
  if (!fills?.length) return null;
  const p = fills[fills.length - 1];
  switch (p.type) {
    case "solid":
      return p.color;
    case "gradient":
      return p.stops[0]?.color ?? null;
    case "pattern":
      return p.fg ?? p.bg ?? null;
    default:
      return null;
  }
}

/** fills → the legacy hex string (dual-write: old app versions keep drawing the first colour). */
export const legacyFill = (fills: readonly Paint[] | undefined): string | null => legacyColor(representativeColor(fills));

/** True when the fills are exactly what the legacy string field can hold (one solid colour, or none). */
export const isLegacyFill = (fills: readonly Paint[] | undefined) => !fills?.length || (fills.length === 1 && fills[0].type === "solid" && !fills[0].color.space && !fills[0].color.ref);

export function paintEq(a: Paint | null | undefined, b: Paint | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.type !== b.type) return false;
  if (a.type === "solid" && b.type === "solid") return colorEq(a.color, b.color);
  return JSON.stringify(normalizePaint(a)) === JSON.stringify(normalizePaint(b));
}

export const fillsEq = (a: readonly Paint[] | undefined, b: readonly Paint[] | undefined) => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((p, i) => paintEq(p, b![i]));

/** Canonical paint: colours normalised, default-valued fields dropped, keys in a fixed order. */
export function normalizePaint(p: Paint): Paint {
  switch (p.type) {
    case "solid":
      return { type: "solid", color: normalizeColor(p.color) };
    case "gradient": {
      const g: Paint = {
        type: "gradient",
        kind: p.kind,
        stops: p.stops.map((s) => (s.mid !== undefined && s.mid !== 0.5 ? { at: s.at, color: normalizeColor(s.color), mid: s.mid } : { at: s.at, color: normalizeColor(s.color) })),
        from: [p.from[0], p.from[1]],
        to: [p.to[0], p.to[1]],
      };
      if (p.aspect !== undefined && p.aspect !== 1) g.aspect = p.aspect;
      if (p.spread && p.spread !== "pad") g.spread = p.spread;
      if (p.smooth !== undefined) g.smooth = p.smooth;
      if (p.dither) g.dither = true;
      return g;
    }
    case "pattern": {
      const q: Paint = { type: "pattern" };
      if (p.preset) q.preset = p.preset;
      if (p.fg) q.fg = normalizeColor(p.fg);
      if (p.bg) q.bg = normalizeColor(p.bg);
      if (p.assetId) q.assetId = p.assetId;
      if (p.scale !== undefined && p.scale !== 1) q.scale = p.scale;
      if (p.offset && (p.offset[0] || p.offset[1])) q.offset = [p.offset[0], p.offset[1]];
      return q;
    }
    case "image": {
      const q: Paint = { type: "image", assetId: p.assetId, fit: p.fit };
      if (p.crop) q.crop = { x: p.crop.x, y: p.crop.y, w: p.crop.w, h: p.crop.h };
      if (p.alpha !== undefined && p.alpha < 1) q.alpha = p.alpha;
      return q;
    }
  }
}
