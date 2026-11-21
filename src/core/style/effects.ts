// Layer effects — the model side (design ch. 4.5). Photoshop's layer style parameters are the reference unit; every
// other format maps to a subset (PPTX effectLst, SVG filters, PDF/DOCX pictures). This file holds what every reader,
// writer, renderer and the panel share: defaults, Photoshop's stacking order, the angle conventions, how far an
// effect reaches outside its object, and the patch helpers that keep `effects` omitted when empty.

import type { Rect } from "../geom";
import type { LayerGroup, SceneNode } from "../types";
import { toPx } from "./len";
import type { Color, Effect, EffectType, StyleBlend } from "./types";

/** Effects the renderer draws (others are kept and written back, not drawn: bevel, satin, blur, reflection). */
export const RENDERED_EFFECTS: ReadonlySet<EffectType> = new Set(["dropShadow", "innerShadow", "outerGlow", "innerGlow", "fxStroke", "overlay", "softEdge"]);

/** Effects the panel can add, in Photoshop's dialog order (top = drawn on top). */
export const PANEL_EFFECTS: readonly EffectType[] = ["fxStroke", "innerShadow", "innerGlow", "overlay", "outerGlow", "dropShadow", "softEdge", "bevel"];

/**
 * Photoshop's fixed stacking, bottom → top: Drop Shadow, Outer Glow, [layer content], Pattern / Gradient / Colour
 * Overlay, Satin, Inner Glow, Inner Shadow, Stroke, Bevel & Emboss. The array order only matters between effects of
 * the same type (Photoshop CC's "multiple" effects: a later one is drawn above an earlier one).
 */
export const FX_RANK: Record<EffectType, number> = {
  dropShadow: 0,
  outerGlow: 1,
  reflection: 2,
  overlay: 10,
  satin: 11,
  innerGlow: 12,
  innerShadow: 13,
  fxStroke: 14,
  bevel: 15,
  softEdge: 20,
  blur: 21,
};

/** Drawn below the layer content (blended with what is under the layer). */
export const isOuterEffect = (e: Effect) => e.type === "dropShadow" || e.type === "outerGlow" || e.type === "reflection";

/** Effects in drawing order (stable: same-type effects keep their array order). */
export function fxOrder(fx: readonly Effect[]): Effect[] {
  return fx.map((e, i) => ({ e, i })).sort((a, b) => FX_RANK[a.e.type] - FX_RANK[b.e.type] || a.i - b.i).map((x) => x.e);
}

/** The enabled effects the renderer draws, in drawing order; empty when none. */
export function activeEffects(fx: readonly Effect[] | undefined): Effect[] {
  if (!fx?.length) return [];
  return fxOrder(fx.filter((e) => e.on && (e.opacity ?? 1) > 0 && RENDERED_EFFECTS.has(e.type)));
}

export const hasEffects = (x: { effects?: readonly Effect[] } | null | undefined) => !!x?.effects?.some((e) => e.on);

/** Default blend mode of each effect (Photoshop's defaults). */
export function defaultBlend(type: EffectType): StyleBlend {
  switch (type) {
    case "dropShadow":
    case "innerShadow":
      return "MULTIPLY";
    case "outerGlow":
    case "innerGlow":
      return "SCREEN";
    default:
      return "NORMAL";
  }
}

export const effectBlend = (e: Effect): StyleBlend => e.blend ?? defaultBlend(e.type);
export const effectOpacity = (e: Effect) => e.opacity ?? 1;

const black: Color = { hex: "#000000" };
const glow: Color = { hex: "#ffffbe" };

/** A new effect with Photoshop's default parameters (Photoshop 2024 "Layer Style" defaults, angle = global light 120°). */
export function newEffect(type: EffectType): Effect {
  const px = (v: number) => ({ v, u: "px" as const });
  switch (type) {
    case "dropShadow":
      return { type, on: true, blend: "MULTIPLY", opacity: 0.75, color: black, angle: 120, distance: px(5), spread: 0, size: px(5) };
    case "innerShadow":
      return { type, on: true, blend: "MULTIPLY", opacity: 0.75, color: black, angle: 120, distance: px(5), spread: 0, size: px(5) };
    case "outerGlow":
      return { type, on: true, blend: "SCREEN", opacity: 0.75, paint: { type: "solid", color: glow }, spread: 0, size: px(5) };
    case "innerGlow":
      return { type, on: true, blend: "SCREEN", opacity: 0.75, paint: { type: "solid", color: glow }, spread: 0, size: px(5), source: "edge" };
    case "fxStroke":
      return { type, on: true, stroke: { paint: { type: "solid", color: { hex: "#ff0000" } }, width: px(3), align: "outside" } };
    case "overlay":
      return { type, on: true, paint: { type: "solid", color: { hex: "#ff0000" } } };
    case "softEdge":
      return { type, on: true, radius: px(10) };
    case "bevel":
      return { type, on: true, style: "inner", depth: 1, size: px(5), soften: px(0), angle: 120, altitude: 30, highlight: { hex: "#ffffff" }, shadow: black };
    case "satin":
      return { type, on: true, blend: "MULTIPLY", opacity: 0.5, color: black, angle: 19, distance: px(11), size: px(14), invert: true };
    case "blur":
      return { type, on: true, radius: px(4) };
    case "reflection":
      return { type, on: true, distance: px(0), size: 0.5, startAlpha: 0.5, endAlpha: 0 };
  }
}

// ───────── angles (design ch. 4.5 "angle conversion") ─────────

/**
 * Photoshop angle (direction the light comes from, degrees counter-clockwise from +x) and distance → the shadow's
 * offset on the page (y down): (−cos a, +sin a)·distance. 120° → right and down.
 */
export function shadowOffset(angle: number, distance: number): [number, number] {
  const a = (angle * Math.PI) / 180;
  const dx = -Math.cos(a) * distance, dy = Math.sin(a) * distance;
  return [Math.abs(dx) < 1e-9 ? 0 : dx, Math.abs(dy) < 1e-9 ? 0 : dy];
}

/** Photoshop angle → DrawingML `dir` (degrees clockwise from +x, the direction the shadow moves): (180 − a) mod 360. */
export const psAngleToDir = (angle: number) => (((180 - angle) % 360) + 360) % 360;
/** DrawingML `dir` → Photoshop angle (inverse of psAngleToDir). */
export const dirToPsAngle = (dir: number) => (((180 - dir) % 360) + 360) % 360;

/**
 * Gaussian sigma of a Photoshop "Size" (px): the one calibration constant every renderer and exporter shares.
 * Fitted on Photoshop 2025 files (qa/interop/adobe-made/omni-fx-*, tests/psd/photoshopFxRefs.test.ts): outside the
 * glyphs the drop shadow of omni-fx-shadow-text (Size 10) is best at 0.42 (max 4 / 255; 0.5 gave max 20), the inner
 * shadow of omni-fx-inner-image (Size 8) at 0.40–0.42 and the clip-base shadow of omni-fx-clip (Size 4) at 0.40–0.42.
 */
export const SIZE_TO_SIGMA = 0.42;

// ───────── extent ─────────

export interface Margins {
  l: number;
  t: number;
  r: number;
  b: number;
}
export const NO_MARGINS: Margins = { l: 0, t: 0, r: 0, b: 0 };

/** How far the effects reach outside the object's own pixels, in page units (blur tails included). */
export function effectMargins(fx: readonly Effect[] | undefined): Margins {
  const m = { l: 0, t: 0, r: 0, b: 0 };
  // outer effects are cast by the stroked shape (core/image/effects.ts): their reach starts at the stroke's edge
  let grow = 0;
  for (const e of activeEffects(fx)) if (e.type === "fxStroke" && e.stroke.align !== "inside") grow = Math.max(grow, e.stroke.align === "center" ? toPx(e.stroke.width) / 2 : toPx(e.stroke.width));
  for (const e of activeEffects(fx)) {
    let all = 0;
    if (e.type === "dropShadow") {
      const reach = grow + toPx(e.size) * 1.25 + 1;
      const [dx, dy] = shadowOffset(e.angle, toPx(e.distance));
      m.l = Math.max(m.l, reach - dx);
      m.r = Math.max(m.r, reach + dx);
      m.t = Math.max(m.t, reach - dy);
      m.b = Math.max(m.b, reach + dy);
      continue;
    }
    if (e.type === "outerGlow") all = grow + toPx(e.size) * 1.25 + 1;
    else if (e.type === "fxStroke") all = (e.stroke.align === "inside" ? 0 : e.stroke.align === "center" ? toPx(e.stroke.width) / 2 : toPx(e.stroke.width)) + 1;
    m.l = Math.max(m.l, all);
    m.r = Math.max(m.r, all);
    m.t = Math.max(m.t, all);
    m.b = Math.max(m.b, all);
  }
  return m;
}

export const maxMargin = (m: Margins) => Math.max(0, m.l, m.t, m.r, m.b);

/**
 * How far inside the content its interior effects look at the edge (px): a renderer working on a strip of a
 * group must see this many rows beyond the strip, or the strip's edge reads as the content's edge.
 */
export function innerReach(fx: readonly Effect[] | undefined): number {
  let r = 0;
  for (const e of activeEffects(fx)) {
    if (e.type === "innerShadow") r = Math.max(r, toPx(e.size) * 1.25 + toPx(e.distance) + 1);
    else if (e.type === "innerGlow") r = Math.max(r, toPx(e.size) * 1.25 + 1);
    else if (e.type === "fxStroke" && e.stroke.align !== "outside") r = Math.max(r, toPx(e.stroke.width) + 1);
    else if (e.type === "softEdge") r = Math.max(r, toPx(e.radius) * 1.25 + 1);
  }
  return r;
}

export const addMargins = (a: Margins, b: Margins): Margins => ({ l: a.l + b.l, t: a.t + b.t, r: a.r + b.r, b: a.b + b.b });

/** A rectangle grown by margins. */
export const growRect = (r: Rect, m: Margins): Rect => (m.l || m.t || m.r || m.b ? { x: r.x - m.l, y: r.y - m.t, w: r.w + m.l + m.r, h: r.h + m.t + m.b } : r);

/** Margins of a node: its own effects plus those of every enclosing group (a group's shadow follows its members). */
export function paintMargins(n: SceneNode, groupPath: readonly LayerGroup[] = []): Margins {
  let m = effectMargins(n.effects);
  for (const g of groupPath) if (g.effects?.length) m = addMargins(m, effectMargins(g.effects));
  return m;
}

// ───────── editing ─────────

/** `effects` value to store: undefined when the list is empty (the field is then removed — hash stability). */
export const effectsField = (fx: readonly Effect[] | undefined): Effect[] | undefined => (fx && fx.length ? [...fx] : undefined);

/** Set (or remove when empty) the effects of a node or group draft in place. */
export function setEffects(target: { effects?: Effect[] }, fx: readonly Effect[] | undefined) {
  const v = effectsField(fx);
  if (v) target.effects = v;
  else delete target.effects;
}

/** Move effect `i` up / down in the list among effects of the same type (the only order Photoshop lets change). */
export function moveEffect(fx: readonly Effect[], i: number, dir: -1 | 1): Effect[] {
  const out = [...fx];
  const type = fx[i]?.type;
  if (!type) return out;
  for (let j = i + dir; j >= 0 && j < fx.length; j += dir)
    if (fx[j].type === type) {
      [out[i], out[j]] = [out[j], out[i]];
      return out;
    }
  return out;
}

/** The colour an effect is drawn with (overlays / glows with a gradient: their first stop). */
export function effectColor(e: Effect): Color | null {
  switch (e.type) {
    case "dropShadow":
    case "innerShadow":
    case "satin":
      return e.color;
    case "outerGlow":
    case "innerGlow":
    case "overlay":
      return e.paint.type === "solid" ? e.paint.color : e.paint.type === "gradient" ? e.paint.stops[0]?.color ?? null : null;
    case "fxStroke":
      return e.stroke.paint.type === "solid" ? e.stroke.paint.color : null;
    default:
      return null;
  }
}
