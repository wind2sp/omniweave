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
 * visible paint's colour — a solid's colour, a gradient's opacity-weighted average (gradientFallbackHex: what an app
 * version that cannot draw the gradient shows instead), a pattern's foreground. Null = no fill. Its callers are only
 * such stand-ins (the legacy `fill` / `stroke` fields, a text run's plain colour); format writers keep their own
 * gradient values.
 */
export function representativeColor(fills: readonly Paint[] | undefined): Color | null {
  if (!fills?.length) return null;
  const p = fills[fills.length - 1];
  switch (p.type) {
    case "solid":
      return p.color;
    case "gradient":
      return p.stops.length ? { hex: gradientFallbackHex(p.stops) } : null;
    case "pattern":
      return p.fg ?? p.bg ?? null;
    default:
      return null;
  }
}

/**
 * The plain colour that stands in for a gradient where only a plain colour can be drawn (the legacy `fill` / `stroke`
 * field, which app versions before 0.2.2 draw instead of the gradient): its colours averaged along the gradient,
 * weighted by their opacity (linear between stops), so a gradient that fades out leans to its visible colours; one
 * that is wholly transparent gives its darkest colour. Its first stop alone would make a white → transparent green
 * gradient white (unseen on white paper) and a two-colour one its first colour.
 */
export function gradientFallbackHex(stops: readonly { at: number; color: { hex: string; a?: number } }[]): string {
  const ss = [...stops].sort((p, q) => p.at - q.at);
  if (!ss.length) return "#000000";
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
  const pts = ss.map((s) => ({ t: Math.min(1, Math.max(0, s.at)), c: rgb(s.color.hex), a: Math.min(1, Math.max(0, s.color.a ?? 1)) }));
  // the end colours hold to 0 and 1
  if (pts[0].t > 0) pts.unshift({ ...pts[0], t: 0 });
  if (pts[pts.length - 1].t < 1) pts.push({ ...pts[pts.length - 1], t: 1 });
  const sum = [0, 0, 0];
  let w = 0;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], L = q.t - p.t;
    if (L <= 0) continue;
    // ∫ colour × alpha and ∫ alpha over the segment, both linear in t
    for (let k = 0; k < 3; k++) sum[k] += (L * (p.c[k] * (2 * p.a + q.a) + q.c[k] * (p.a + 2 * q.a))) / 6;
    w += (L * (p.a + q.a)) / 2;
  }
  const hex = (c: number[]) => "#" + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0")).join("");
  if (w < 1e-6) return hex([...pts].sort((p, q) => p.c[0] * 0.3 + p.c[1] * 0.59 + p.c[2] * 0.11 - (q.c[0] * 0.3 + q.c[1] * 0.59 + q.c[2] * 0.11))[0].c);
  return hex(sum.map((v) => v / w));
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
