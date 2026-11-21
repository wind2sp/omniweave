// Reading and writing the unified style fields of a node, lazily (design ch. 8.1–8.2).
//
// Reading: a node may hold the new fields (`fills`, `strokes` — phase B onwards) or only the legacy ones; the
// readers below give the unified value either way, so callers never branch on the file's age.
// Writing: patches carry the legacy field always (dual-write: older app versions keep drawing the file) and the new
// field only when the legacy one cannot hold the value — so editing a node with plain colours changes nothing but the
// legacy field, no v2 field appears, and the file stays version 1.

import type { SceneNode, VectorNode } from "../types";
import { fillsFromLegacy, isLegacyFill, legacyFill } from "./paint";
import { isLegacyStroke, legacyStroke, strokesFromLegacy } from "./stroke";
import type { Paint, Stroke } from "./types";

/** Unified fields a node may carry (added to the node types in phase B). */
export interface StyledFields {
  fills?: Paint[];
  strokes?: Stroke[];
}

const ext = (n: SceneNode) => n as SceneNode & StyledFields;

/** Fills of a node: its `fills` if present, else the legacy fill field of its kind. */
export function fillsOf(n: SceneNode): Paint[] {
  const own = ext(n).fills;
  if (own) return own;
  switch (n.type) {
    case "VECTOR":
      return fillsFromLegacy(n.fill);
    case "TEXT":
      return fillsFromLegacy(n.background);
    case "TABLE":
      return fillsFromLegacy(n.background);
    default:
      return [];
  }
}

/** Strokes of a node: its `strokes` if present, else the legacy vector stroke. */
export function strokesOf(n: SceneNode): Stroke[] {
  const own = ext(n).strokes;
  if (own) return own;
  return n.type === "VECTOR" ? strokesFromLegacy(n.stroke, n.strokeWidth) : [];
}

/**
 * Patch that sets a vector's fills: the legacy `fill` always, `fills` only when the legacy field cannot hold them
 * (undefined in the patch = remove the field, so a node edited back to a plain colour loses it again).
 */
export function vectorFillPatch(fills: Paint[]): Pick<VectorNode, "fill"> & StyledFields {
  return { fill: legacyFill(fills), fills: isLegacyFill(fills) ? undefined : fills };
}

/** Patch that sets a vector's strokes (legacy `stroke` / `strokeWidth` always, `strokes` only when needed). */
export function vectorStrokePatch(n: VectorNode, strokes: Stroke[]): Pick<VectorNode, "stroke" | "strokeWidth"> & StyledFields {
  return { ...legacyStroke(strokes, n.strokeWidth), strokes: isLegacyStroke(strokes) ? undefined : strokes };
}

/** Apply a patch, dropping fields set to undefined (an omitted field keeps node hashes free of empty keys). */
export function applyStylePatch<T extends object>(node: T, patch: object): T {
  const out = { ...node } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}
