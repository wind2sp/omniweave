// Stroke (design ch. 4.4). The legacy vector fields (stroke colour + strokeWidth in px) map to one Stroke with round
// caps and joins stated explicitly — that is how the renderer, SVG and PDF exports draw them today (draw.ts,
// export.ts, pdfVector.ts), so a migrated node looks exactly the same. New nodes keep that default; imported nodes
// will carry their file's own cap / join once phase B reads them.

import { colorOf, legacyColor } from "./color";
import { lenEq, toPx } from "./len";
import { normalizePaint, paintEq, representativeColor } from "./paint";
import type { Arrow, Stroke } from "./types";

/** What the renderer draws when a stroke states no cap / join / miter (the legacy look). */
export const LEGACY_STROKE_LOOK = { cap: "round", join: "round" } as const;
/** Canvas / PDF / SVG default miter limit. */
export const DEFAULT_MITER = 10;

export function strokesFromLegacy(stroke: string | null | undefined, strokeWidth: number): Stroke[] {
  const c = colorOf(stroke ?? null);
  if (!c) return [];
  return [{ paint: { type: "solid", color: c }, width: { v: strokeWidth, u: "px" }, cap: "round", join: "round" }];
}

/**
 * Strokes → legacy {stroke, strokeWidth}. `keepWidth` is the node's current strokeWidth, kept when there is no
 * stroke (the legacy field always holds a width, even with stroke = null).
 */
export function legacyStroke(strokes: readonly Stroke[] | undefined, keepWidth: number): { stroke: string | null; strokeWidth: number } {
  const s = strokes?.[strokes.length - 1];
  if (!s) return { stroke: null, strokeWidth: keepWidth };
  const color = legacyColor(representativeColor([s.paint]));
  return { stroke: color, strokeWidth: toPx(s.width) };
}

/** True when the strokes hold nothing more than the legacy fields can (one solid stroke in px, round ends). */
export function isLegacyStroke(strokes: readonly Stroke[] | undefined): boolean {
  if (!strokes?.length) return true;
  if (strokes.length > 1) return false;
  const s = strokes[0];
  return (
    s.paint.type === "solid" && !s.paint.color.space && !s.paint.color.ref && s.width.u === "px" &&
    (s.cap ?? "round") === "round" && (s.join ?? "round") === "round" &&
    !s.align && !s.dash && !s.dashPreset && !s.dashOffset && !s.compound && !s.start && !s.end && s.miter === undefined && !s.scaleWithObject
  );
}

const arrowEq = (a: Arrow | undefined, b: Arrow | undefined) => (!a || a.type === "none" ? !b || b.type === "none" : !!b && a.type === b.type && (a.w ?? "med") === (b.w ?? "med") && (a.l ?? "med") === (b.l ?? "med"));

export function strokeEq(a: Stroke | null | undefined, b: Stroke | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    paintEq(a.paint, b.paint) && lenEq(a.width, b.width) &&
    (a.align ?? "center") === (b.align ?? "center") &&
    a.cap === b.cap && a.join === b.join && (a.miter ?? DEFAULT_MITER) === (b.miter ?? DEFAULT_MITER) &&
    JSON.stringify(a.dash ?? []) === JSON.stringify(b.dash ?? []) && (a.dashPreset ?? "") === (b.dashPreset ?? "") && (a.dashOffset ?? 0) === (b.dashOffset ?? 0) &&
    (a.compound ?? "single") === (b.compound ?? "single") && arrowEq(a.start, b.start) && arrowEq(a.end, b.end) && !!a.scaleWithObject === !!b.scaleWithObject
  );
}

export const strokesEq = (a: readonly Stroke[] | undefined, b: readonly Stroke[] | undefined) => (a?.length ?? 0) === (b?.length ?? 0) && (a ?? []).every((s, i) => strokeEq(s, b![i]));

/** Canonical stroke (fixed key order, defaults dropped) for fingerprints. */
export function normalizeStroke(s: Stroke): Stroke {
  const o: Stroke = { paint: normalizePaint(s.paint), width: { v: s.width.v, u: s.width.u } };
  if (s.align && s.align !== "center") o.align = s.align;
  if (s.cap) o.cap = s.cap;
  if (s.join) o.join = s.join;
  if (s.miter !== undefined && s.miter !== DEFAULT_MITER) o.miter = s.miter;
  if (s.dash?.length) o.dash = [...s.dash];
  if (s.dashPreset) o.dashPreset = s.dashPreset;
  if (s.dashOffset) o.dashOffset = s.dashOffset;
  if (s.compound && s.compound !== "single") o.compound = s.compound;
  if (s.start && s.start.type !== "none") o.start = { ...s.start };
  if (s.end && s.end.type !== "none") o.end = { ...s.end };
  if (s.scaleWithObject) o.scaleWithObject = true;
  return o;
}
