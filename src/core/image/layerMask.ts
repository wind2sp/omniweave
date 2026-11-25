// Layer masks (Photoshop's pixel layer mask): how much of a raster layer shows, painted in grey — white shows, black
// hides. Stored as node-local 256 px tiles on the same grid as the layer's own tiles, with the coverage as tile alpha
// in the same convention as an adjustment layer's mask (core/image/adjustLayer.ts LayerAdjust):
//   hide: true   the usual white-default mask ("모두 나타내기"): a tile's alpha is how much is held back, a missing
//                tile shows everything
//   hide: false  a black-default mask ("모두 숨기기"): a tile's alpha is how much shows, a missing tile hides
// so painting black on a white-default mask is plain painting of alpha, painting white is erasing it — the raster
// brush (render/brush.ts Stroke) paints masks as it paints pixels. The layer's tiles keep every pixel; the mask is
// applied when the layer is drawn (render/draw.ts), composited (softComposite via the PSD writer), merged or applied.

import { TILE, isBlank, makeTile } from "../tile";
import type { PixelTile } from "../types";

export interface LayerMask {
  tiles: Record<string, PixelTile>;
  hide: boolean;
  /** turned off (Shift+click on the mask thumbnail): the layer draws unmasked, the mask is kept */
  off?: true;
}

interface Masked {
  tiles: Record<string, PixelTile>;
  hide: boolean;
  off?: true;
}

/** A new mask: white (reveal all), black (hide all), or from a coverage plane (0..255 shows, node-local box). */
export function newMask(kind: "reveal" | "hide"): LayerMask {
  return { tiles: {}, hide: kind === "reveal" };
}

/** Mask value 0..255 (255 = shows) of one tile pixel `i` (0..TILE²−1); `t` the mask tile or undefined. */
export function maskValue(m: Masked, t: PixelTile | undefined, i: number): number {
  const a = t ? t.data[i * 4 + 3] : 0;
  return m.hide ? 255 - a : a;
}

const cache = new WeakMap<object, WeakMap<object, Record<string, PixelTile>>>();
const tileCache = new WeakMap<Uint8ClampedArray, WeakMap<Uint8ClampedArray, PixelTile | null>>();

/** One content tile with the mask tile applied (cached; the same object for the same pair). */
function maskTile(c: PixelTile, m: PixelTile, hide: boolean): PixelTile | null {
  let by = tileCache.get(c.data);
  if (!by) tileCache.set(c.data, (by = new WeakMap()));
  if (by.has(m.data)) return by.get(m.data) ?? null;
  const d = new Uint8ClampedArray(c.data);
  const md = m.data;
  for (let i = 3; i < d.length; i += 4) {
    const v = hide ? 255 - md[i] : md[i];
    if (v < 255) d[i] = Math.round((d[i] * v) / 255);
  }
  const t: PixelTile | null = isBlank(d) ? null : { hash: `${c.hash}*${m.hash}`, data: d };
  by.set(m.data, t);
  return t;
}

/**
 * The tiles a layer shows: its own with the mask applied (cached per tiles / mask pair). A layer without a mask, with
 * the mask turned off, or an adjustment layer (whose tiles are its mask) shows its tiles as they are.
 */
export function shownTiles(n: { tiles: Record<string, PixelTile>; mask?: LayerMask; adjust?: unknown }): Record<string, PixelTile> {
  const m = n.mask;
  if (!m || m.off || n.adjust) return n.tiles;
  let by = cache.get(n.tiles);
  if (!by) cache.set(n.tiles, (by = new WeakMap()));
  const hit = by.get(m);
  if (hit) return hit;
  const out: Record<string, PixelTile> = {};
  for (const [k, c] of Object.entries(n.tiles)) {
    const mt = m.tiles[k];
    if (!mt) {
      if (m.hide) out[k] = c;
      continue;
    }
    const t = maskTile(c, mt, m.hide);
    if (t) out[k] = t;
  }
  by.set(m, out);
  return out;
}

/** The mask as a grey plane over node-local box (x, y, w, h): 255 = shows. */
export function maskPlane(m: Masked, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h).fill(m.hide ? 255 : 0);
  for (const [k, t] of Object.entries(m.tiles)) {
    const u = k.indexOf("_");
    const ox = +k.slice(0, u) * TILE - x, oy = +k.slice(u + 1) * TILE - y;
    if (ox >= w || oy >= h || ox + TILE <= 0 || oy + TILE <= 0) continue;
    for (let r = Math.max(0, -oy); r < TILE && oy + r < h; r++)
      for (let c = Math.max(0, -ox); c < TILE && ox + c < w; c++) {
        const a = t.data[(r * TILE + c) * 4 + 3];
        out[(oy + r) * w + ox + c] = m.hide ? 255 - a : a;
      }
  }
  return out;
}

/**
 * Mask tiles from a grey plane (255 = shows) over node-local box (x, y, w, h), in the representation `hide` (white
 * default: alpha = held back). Tiles equal to the default are left out; pixels outside the box take the default.
 */
export function maskFromPlane(plane: Uint8Array, x: number, y: number, w: number, h: number, hide: boolean): Record<string, PixelTile> {
  const tiles: Record<string, PixelTile> = {};
  const tx0 = Math.floor(x / TILE), ty0 = Math.floor(y / TILE);
  const tx1 = Math.floor((x + w - 1) / TILE), ty1 = Math.floor((y + h - 1) / TILE);
  for (let ty = ty0; ty <= ty1; ty++)
    for (let tx = tx0; tx <= tx1; tx++) {
      const d = new Uint8ClampedArray(TILE * TILE * 4);
      for (let r = 0; r < TILE; r++) {
        const py = ty * TILE + r - y;
        if (py < 0 || py >= h) continue;
        for (let c = 0; c < TILE; c++) {
          const px = tx * TILE + c - x;
          if (px < 0 || px >= w) continue;
          const v = plane[py * w + px];
          d[(r * TILE + c) * 4 + 3] = hide ? 255 - v : v;
        }
      }
      if (!isBlank(d)) tiles[`${tx}_${ty}`] = makeTile(d);
    }
  return tiles;
}

/** The layer's tiles with its mask applied for good ("레이어 마스크 적용"). */
export function applyMask(n: { tiles: Record<string, PixelTile>; mask?: LayerMask }): Record<string, PixelTile> {
  if (!n.mask) return n.tiles;
  return shownTiles({ tiles: n.tiles, mask: { ...n.mask, off: undefined } });
}

/** Inverted mask (Ctrl+I on the mask): the same tiles read the other way. */
export function invertMask(m: LayerMask): LayerMask {
  return { ...m, hide: !m.hide };
}

/** Grey preview tile of the mask (Alt+click on the mask thumbnail): opaque, white = shows. */
export function maskViewTile(m: Masked, t: PixelTile | undefined): Uint8ClampedArray {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < TILE * TILE; i++) {
    const v = maskValue(m, t, i);
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v;
    d[i * 4 + 3] = 255;
  }
  return d;
}

/** What a mask is, as a short string (the PSD writer: has the mask changed since the file was read?); "" = none. */
export function maskFingerprint(m: LayerMask | undefined): string {
  if (!m) return "";
  const keys = Object.keys(m.tiles).sort();
  return `${m.hide ? "h" : "s"}${m.off ? "0" : "1"}:` + keys.map((k) => `${k}=${m.tiles[k].hash}`).join(",");
}