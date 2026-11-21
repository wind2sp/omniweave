// Raster tiles: size and the small helpers the image worker needs. Kept apart from types.ts / loom.ts so the
// worker does not pull in the scene graph, text layout or the language files (default names use t()).

import { hashBytes } from "./hash";
import type { PixelTile } from "./types";

/** Raster tile edge in px. */
export const TILE = 256;

export function makeTile(data: Uint8ClampedArray): PixelTile {
  return { hash: hashBytes(data), data };
}

export function isBlank(data: Uint8ClampedArray): boolean {
  const u32 = new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
  for (let i = 0; i < u32.length; i++) if (u32[i] >>> 24 !== 0) return false; // alpha byte (little-endian)
  return true;
}
