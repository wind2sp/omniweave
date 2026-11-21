// Pure editing logic of the Effects section (tests/style/effectsUi.test.ts): every operation returns a new list,
// the section turns each completed gesture into one undo step, and an empty list removes the field.

import { FX_RANK, PANEL_EFFECTS, moveEffect, newEffect } from "../../core/style/effects";
import type { Color, Effect, EffectType, Paint } from "../../core/style/types";

/** Add a new effect of `type` (Photoshop defaults). */
export const addEffect = (fx: readonly Effect[] | undefined, type: EffectType): Effect[] => [...(fx ?? []), newEffect(type)];

export const removeEffect = (fx: readonly Effect[], i: number): Effect[] => fx.filter((_, k) => k !== i);

export const toggleEffect = (fx: readonly Effect[], i: number): Effect[] => fx.map((e, k) => (k === i ? { ...e, on: !e.on } : e));

/** Same-type reorder (the only order Photoshop lets change; types keep Photoshop's fixed stacking). */
export const reorderEffect = (fx: readonly Effect[], i: number, dir: -1 | 1): Effect[] => moveEffect(fx, i, dir);

/** Merge a patch into effect `i` (fields set to undefined are removed: defaults stay omitted). */
export function patchEffect(fx: readonly Effect[], i: number, patch: Record<string, unknown>): Effect[] {
  return fx.map((e, k) => {
    if (k !== i) return e;
    const o = { ...e } as Record<string, unknown>;
    for (const [key, v] of Object.entries(patch)) {
      if (v === undefined) delete o[key];
      else o[key] = v;
    }
    return o as unknown as Effect;
  });
}

/** Rows in the order the panel lists them: Photoshop's dialog order (top = drawn on top), same types by index. */
export function panelOrder(fx: readonly Effect[]): number[] {
  return fx
    .map((e, i) => ({ e, i }))
    .sort((a, b) => FX_RANK[b.e.type] - FX_RANK[a.e.type] || b.i - a.i)
    .map((x) => x.i);
}

/** Effects the panel offers to add. */
export const addableEffects = (): readonly EffectType[] => PANEL_EFFECTS;

/** The colour an effect's colour well edits, and how to write one back. */
export function effectColorOf(e: Effect): Color | null {
  switch (e.type) {
    case "dropShadow":
    case "innerShadow":
    case "satin":
      return e.color;
    case "outerGlow":
    case "innerGlow":
    case "overlay":
      return e.paint.type === "solid" ? e.paint.color : null;
    case "fxStroke":
      return e.stroke.paint.type === "solid" ? e.stroke.paint.color : null;
    case "bevel":
      return e.highlight;
    default:
      return null;
  }
}

export function withEffectColor(e: Effect, c: Color): Effect {
  const solid: Paint = { type: "solid", color: c };
  switch (e.type) {
    case "dropShadow":
    case "innerShadow":
    case "satin":
      return { ...e, color: c };
    case "outerGlow":
    case "innerGlow":
    case "overlay":
      return { ...e, paint: solid };
    case "fxStroke":
      return { ...e, stroke: { ...e.stroke, paint: solid } };
    case "bevel":
      return { ...e, highlight: c };
    default:
      return e;
  }
}

/** Numeric parameters each effect shows, in Photoshop's dialog order: [field, min, max, unit, scale]. */
export type FxParam = { key: "opacity" | "angle" | "distance" | "spread" | "size" | "width" | "radius" | "depth" | "altitude" | "soften"; min: number; max: number; unit: "%" | "px" | "°"; scale?: number };

export function effectParams(e: Effect): FxParam[] {
  const op: FxParam = { key: "opacity", min: 0, max: 100, unit: "%", scale: 100 };
  switch (e.type) {
    case "dropShadow":
    case "innerShadow":
      return [op, { key: "angle", min: -180, max: 180, unit: "°" }, { key: "distance", min: 0, max: 300, unit: "px" }, { key: "spread", min: 0, max: 100, unit: "%", scale: 100 }, { key: "size", min: 0, max: 250, unit: "px" }];
    case "outerGlow":
    case "innerGlow":
      return [op, { key: "spread", min: 0, max: 100, unit: "%", scale: 100 }, { key: "size", min: 0, max: 250, unit: "px" }];
    case "fxStroke":
      return [op, { key: "width", min: 1, max: 250, unit: "px" }];
    case "overlay":
      return [op];
    case "softEdge":
      return [{ key: "radius", min: 0, max: 250, unit: "px" }];
    case "bevel":
      return [{ key: "depth", min: 1, max: 1000, unit: "%", scale: 100 }, { key: "size", min: 0, max: 250, unit: "px" }, { key: "soften", min: 0, max: 16, unit: "px" }, { key: "angle", min: -180, max: 180, unit: "°" }, { key: "altitude", min: 0, max: 90, unit: "°" }];
    default:
      return [op];
  }
}

/** Current value of a parameter as shown (scaled: 0.75 → 75 %). */
export function paramValue(e: Effect, p: FxParam): number {
  const x = e as any;
  let v: number;
  switch (p.key) {
    case "opacity":
      v = x.opacity ?? 1;
      break;
    case "width":
      v = x.stroke.width.v;
      break;
    case "distance":
    case "size":
    case "radius":
    case "soften":
      v = x[p.key].v;
      break;
    default:
      v = x[p.key];
  }
  return Math.round(v * (p.scale ?? 1) * 100) / 100;
}

/** Patch for a parameter set to a shown value (lengths keep their unit; changing the angle leaves global light). */
export function paramPatch(e: Effect, p: FxParam, shown: number): Record<string, unknown> {
  const v = Math.max(p.min, Math.min(p.max, shown)) / (p.scale ?? 1);
  const x = e as any;
  switch (p.key) {
    case "opacity":
      return { opacity: v };
    case "width":
      return { stroke: { ...x.stroke, width: { v, u: x.stroke.width.u } } };
    case "distance":
    case "size":
    case "radius":
    case "soften":
      return { [p.key]: { v, u: x[p.key].u } };
    case "angle":
      return { angle: v, globalLight: undefined };
    default:
      return { [p.key]: v };
  }
}
