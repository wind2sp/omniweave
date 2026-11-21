// Per-bundle style fingerprints (design ch. 8.3 "dirty marking per property bundle"). An importer stores the
// fingerprints of a node at import time; a surgeon writer compares them with the node at save time and rewrites only
// the bundles that changed, copying the original bytes of every other bundle.
//
// Fingerprints are computed from the canonical unified model (legacy fields go through the same converters the
// lazy migration uses), so a node whose fields are migrated without being edited keeps its fingerprints — migrating
// is never mistaken for editing.

import { hashString } from "../hash";
import type { SceneNode } from "../types";
import { normalizeColor, colorOf } from "./color";
import { fillsFromLegacy, normalizePaint } from "./paint";
import { normalizeStroke, strokesFromLegacy } from "./stroke";
import { charStyleFromRun, paraStyleFromParagraph } from "./text";
import type { Effect } from "./types";

export const STYLE_BUNDLES = ["fills", "strokes", "effects", "mask", "text", "geom", "blend"] as const;
export type StyleBundle = (typeof STYLE_BUNDLES)[number];
export type BundleFingerprints = Partial<Record<StyleBundle, string>>;

/** JSON with object keys sorted (and undefined dropped), so equal values always serialise the same way. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (ArrayBuffer.isView(v)) return JSON.stringify(Array.from(v as Uint8Array));
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJson(x))).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

const nc = (s: string | null | undefined) => {
  const c = colorOf(s ?? null);
  return c ? normalizeColor(c) : null;
};

/** The canonical value of each bundle the node has (bundles it cannot carry are absent). */
export function styleBundles(n: SceneNode): Partial<Record<StyleBundle, unknown>> {
  const out: Partial<Record<StyleBundle, unknown>> = {
    blend: { opacity: n.opacity, mode: n.blendMode, clip: !!n.clip },
    geom: { t: n.transform },
    // every kind can carry layer effects; no effects and an empty list are the same value
    effects: effectsFingerprintValue(n.effects),
  };
  switch (n.type) {
    case "VECTOR":
      out.fills = fillsFromLegacy(n.fill).map(normalizePaint);
      out.strokes = strokesFromLegacy(n.stroke, n.strokeWidth).map(normalizeStroke);
      out.geom = { t: n.transform, contours: n.contours, rule: n.fillRule };
      break;
    case "TEXT":
      out.fills = fillsFromLegacy(n.background).map(normalizePaint);
      out.text = { wb: n.wordBreak, p: n.paragraphs.map((p) => ({ para: paraStyleFromParagraph(p), runs: p.runs.map((r) => ({ t: r.text, s: charStyleFromRun(r) })) })) };
      out.geom = { t: n.transform, w: n.width };
      break;
    case "TABLE":
      out.fills = { bg: nc(n.background), header: nc(n.headerFill), cells: n.rows.map((r) => r.map((c) => nc(c.fill))) };
      out.strokes = { border: nc(n.borderColor) };
      out.text = { font: n.fontFamily, size: n.fontSize, color: nc(n.color), header: n.headerRow, cells: n.rows.map((r) => r.map(({ fill: _f, colSpan: _c, rowSpan: _r, ...rest }) => rest)) };
      out.geom = { t: n.transform, cols: n.colWidths, rowH: n.rowHeight, spans: n.rows.map((r) => r.map((c) => [c.colSpan ?? 1, c.rowSpan ?? 1])) };
      break;
    case "IMAGE":
    case "PDF":
      out.geom = { t: n.transform, w: n.width, h: n.height, crop: n.crop ?? null };
      break;
    case "RASTER":
      out.geom = { t: n.transform, crop: n.crop ?? null };
      break;
    case "MEDIA":
      out.geom = { t: n.transform, w: n.width, h: n.height };
      break;
  }
  return out;
}

/** Canonical value of an effect list (colours normalised; undefined and [] alike). */
export function effectsFingerprintValue(fx: readonly Effect[] | undefined): unknown {
  return (fx ?? []).map((e) => JSON.parse(canonicalJson(e), (_k, v) => (v && typeof v === "object" && typeof v.hex === "string" ? normalizeColor(v) : v)));
}

/** Fingerprint of an effect list alone (the PSD Surgeon compares it with the import-time one). */
export const effectsFingerprint = (fx: readonly Effect[] | undefined) => hashString(canonicalJson(effectsFingerprintValue(fx)));

/** Hash of each bundle's canonical value. */
export function bundleFingerprints(n: SceneNode): BundleFingerprints {
  const b = styleBundles(n);
  const out: BundleFingerprints = {};
  for (const k of STYLE_BUNDLES) if (b[k] !== undefined) out[k] = hashString(canonicalJson(b[k]));
  return out;
}

/** Bundles whose fingerprint differs (a bundle present on one side only counts as changed). */
export function changedBundles(before: BundleFingerprints, after: BundleFingerprints): StyleBundle[] {
  return STYLE_BUNDLES.filter((k) => before[k] !== after[k]);
}
