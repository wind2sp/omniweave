// Lengths in their original units (design ch. 4.1 rule 2): a value read from a file keeps the unit the file used, so
// a round trip through the same format writes back the same number; conversion to px happens only for computing.

import type { Len, LenUnit } from "./types";

/** CSS px per one unit for the absolute units (96 px = 1 in = 72 pt = 1440 twip = 914400 EMU = 7200 HWPUNIT). */
export const PX_PER_UNIT: Record<Exclude<LenUnit, "pct" | "em1000">, number> = {
  px: 1,
  pt: 96 / 72,
  twip: 96 / 1440,
  emu: 96 / 914400,
  hwpunit: 96 / 7200,
};

export const len = (v: number, u: LenUnit = "px"): Len => ({ v, u });
export const px = (v: number): Len => ({ v, u: "px" });

export const isRelative = (u: LenUnit) => u === "pct" || u === "em1000";

/**
 * Length in px. `basis` (px) is what relative units refer to: the font size for em1000 / pct tracking, the
 * reference length for other percentages. Without a basis a relative length is 0.
 */
export function toPx(l: Len, basis = 0): number {
  switch (l.u) {
    case "pct":
      return (l.v / 100) * basis;
    case "em1000":
      return (l.v / 1000) * basis;
    default:
      return l.v * PX_PER_UNIT[l.u];
  }
}

/** px → a length in `u` (exact inverse of toPx; no rounding — callers round to the file's precision when writing). */
export function fromPx(pxv: number, u: LenUnit = "px", basis = 0): Len {
  switch (u) {
    case "pct":
      return { v: basis ? (pxv / basis) * 100 : 0, u };
    case "em1000":
      return { v: basis ? (pxv / basis) * 1000 : 0, u };
    default:
      return { v: pxv / PX_PER_UNIT[u], u };
  }
}

/** Same length in another unit (via px). */
export const convertLen = (l: Len, u: LenUnit, basis = 0): Len => (l.u === u ? l : fromPx(toPx(l, basis), u, basis));

/** Exactly equal (same unit, same number) — what byte preservation needs. */
export const lenEq = (a: Len | undefined, b: Len | undefined) => a === b || (!!a && !!b && a.u === b.u && a.v === b.v);

/** Equal within `eps` px after conversion (for comparing values that went through another format). */
export const lenClose = (a: Len, b: Len, eps = 1e-6, basis = 0) => Math.abs(toPx(a, basis) - toPx(b, basis)) <= eps;
