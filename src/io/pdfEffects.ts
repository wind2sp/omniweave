// Layer effects in the vector PDF: PDF has no drop shadow / glow, so the effects are drawn as pictures (image
// XObjects with a soft mask) placed under and over the live content — text stays text (selectable, searchable),
// shapes stay vectors. The pixels come from the one effect implementation (core/image/effects.ts) applied to the
// node rendered alone; caps.ts marks PDF effects "approx" (pictures at 2× resolution, blend modes of several
// stacked outer effects merged into one).

import { MAX_FX_PIXELS, effectLayers } from "../core/image/effects";
import { activeEffects, effectMargins, maxMargin } from "../core/style/effects";
import type { StyleBlend } from "../core/style/types";
import type { Page, SceneNode } from "../core/types";
import { decodePngRgba } from "./formats/psdWrite";

export interface PdfFxImage {
  rgba: Uint8ClampedArray;
  /** pixel size */
  pw: number;
  ph: number;
  /** page-space px rectangle */
  x: number;
  y: number;
  w: number;
  h: number;
  blend: StyleBlend;
}

type Rasterize = (page: Page, node: SceneNode) => Promise<{ png: Uint8Array; x: number; y: number; w: number; h: number } | null>;

/** Pictures of a node's effects: what goes under its content and what goes over it (null when nothing). */
export async function pdfEffectImages(page: Page, n: SceneNode, rasterize: Rasterize | undefined): Promise<{ below: PdfFxImage | null; above: PdfFxImage | null; tooBig?: boolean } | null> {
  const fx = activeEffects(n.effects);
  if (!fx.length || !rasterize) return null;
  const r = await rasterize(page, { ...n, effects: undefined } as SceneNode);
  if (!r || r.w <= 0 || r.h <= 0) return null;
  const png = decodePngRgba(r.png);
  const k = png.width / r.w;
  const m = Math.ceil(maxMargin(effectMargins(fx)) * k) + 2;
  if ((png.width + 2 * m) * (png.height + 2 * m) > MAX_FX_PIXELS) return { below: null, above: null, tooBig: true };
  const L = effectLayers(png.rgba, png.width, png.height, fx, k, m, n.opacity);
  const place = (rgba: Uint8ClampedArray | null, blend: StyleBlend): PdfFxImage | null =>
    rgba ? { rgba, pw: L.w, ph: L.h, x: r.x - m / k, y: r.y - m / k, w: L.w / k, h: L.h / k, blend } : null;
  const below = place(L.below, L.belowBlend);
  const above = place(L.above, "NORMAL");
  return below || above ? { below, above } : null;
}
