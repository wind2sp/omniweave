// Merge down (pure): composite one raster layer onto the raster layer below it, tile by tile.
// Both layers must be unrotated, unscaled and uncropped (pixel = page px), so the result is exact. Each
// layer's opacity is baked into the pixels and the upper layer's blend mode is applied, so the merged layer
// (opacity 1, the lower layer's blend mode) looks the same as the pair did over a normal backdrop.
// Clipping (`clip`): the upper layer is clipped to the lower one (its clipping base) — it is composited source-atop
// (the lower layer's alpha is kept) and the lower layer's opacity is not baked: as the base it still applies to the
// result, so the merged layer keeps it.

import { TILE, type BlendMode, type PixelTile, type RasterNode } from "../types";
import { imgToTiles, tileBounds, tilesToImg, type TileBounds } from "./pixels";
import { blendMixPixel, dissolveKeep, pixelBlend } from "../style/blend";

/** Raster whose pixels sit 1:1 on the page (no rotation, scale or crop); not an adjustment layer (its tiles are a mask). */
export function simpleRaster(n: RasterNode): boolean {
  const t = n.transform;
  return t.rotation === 0 && t.scale === 1 && (t.scaleY === undefined || t.scaleY === 1) && !n.crop && !n.adjust;
}

/** Whole-pixel blend of a mode, null = NORMAL (formulas: core/style/blend.ts). */
const blendFn = (mode: BlendMode) => pixelBlend(mode);
const mixed = new Float64Array(3);

function union(a: TileBounds | null, b: TileBounds | null): TileBounds | null {
  if (!a) return b;
  if (!b) return a;
  const x0 = Math.min(a.ox, b.ox), y0 = Math.min(a.oy, b.oy);
  const x1 = Math.max(a.ox + a.width, b.ox + b.width), y1 = Math.max(a.oy + a.height, b.oy + b.height);
  return { ox: x0, oy: y0, width: x1 - x0, height: y1 - y0 };
}

/** Tiles of `lower` with `upper` composited on top (both simple rasters; positions rounded to whole px). */
export function mergeRasterTiles(lower: RasterNode, upper: RasterNode, clip = false): Record<string, PixelTile> {
  const dx = Math.round(upper.transform.x - lower.transform.x), dy = Math.round(upper.transform.y - lower.transform.y);
  const ub = tileBounds(upper.tiles);
  // upper bounds in lower-local pixels, grown out to whole tiles
  const shifted = ub && {
    ox: Math.floor((ub.ox + dx) / TILE) * TILE,
    oy: Math.floor((ub.oy + dy) / TILE) * TILE,
    width: 0,
    height: 0,
  };
  if (ub && shifted) {
    shifted.width = Math.ceil((ub.ox + dx + ub.width) / TILE) * TILE - shifted.ox;
    shifted.height = Math.ceil((ub.oy + dy + ub.height) / TILE) * TILE - shifted.oy;
  }
  const b = union(tileBounds(lower.tiles), shifted);
  if (!b) return lower.tiles;
  const img = tilesToImg(lower.tiles, b);
  const d = img.data;
  const lo = clip ? 1 : Math.max(0, Math.min(1, lower.opacity));
  if (lo < 1) for (let i = 3; i < d.length; i += 4) d[i] = Math.round(d[i] * lo);
  const op = Math.max(0, Math.min(1, upper.opacity));
  const B = blendFn(upper.blendMode);
  const dis = upper.blendMode === "DISSOLVE";
  for (const [k, tile] of Object.entries(upper.tiles)) {
    const u = k.indexOf("_");
    const x0 = +k.slice(0, u) * TILE + dx - b.ox, y0 = +k.slice(u + 1) * TILE + dy - b.oy;
    const s = tile.data;
    for (let r = 0; r < TILE; r++) {
      const y = y0 + r;
      if (y < 0 || y >= b.height) continue;
      for (let c = 0; c < TILE; c++) {
        const x = x0 + c;
        if (x < 0 || x >= b.width) continue;
        const si = (r * TILE + c) * 4;
        let as = (s[si + 3] / 255) * op;
        if (as <= 0) continue;
        // dissolve: each pixel fully or not at all (the same page-position pattern as the compositors)
        if (dis) {
          if (!dissolveKeep(x + b.ox, y + b.oy, as)) continue;
          as = 1;
        }
        const di = (y * b.width + x) * 4;
        const ab = d[di + 3] / 255;
        if (clip && ab <= 0) continue;
        // source-over, or source-atop for a clipped layer (alpha stays the base's)
        const ao = clip ? ab : as + ab * (1 - as);
        const fa = clip ? ab : 1;
        // a clipped layer blends against its base as if the base were opaque (Photoshop; core/style/blend.ts blendMix)
        blendMixPixel(B, d[di] / 255, d[di + 1] / 255, d[di + 2] / 255, s[si] / 255, s[si + 1] / 255, s[si + 2] / 255, ab, clip, mixed);
        for (let ch = 0; ch < 3; ch++) {
          const cb = d[di + ch] / 255;
          d[di + ch] = Math.round(((as * fa * mixed[ch] + ab * cb * (1 - as)) / ao) * 255);
        }
        d[di + 3] = Math.round(ao * 255);
      }
    }
  }
  return imgToTiles(img, b.ox, b.oy, lo < 1 ? {} : lower.tiles).tiles;
}
