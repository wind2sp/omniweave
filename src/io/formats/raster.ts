// RGBA buffer → sparse 256px Loom tiles (blank tiles are not stored).

import { isBlank, makeTile } from "../../core/loom";
import { TILE, newRaster, type RasterNode } from "../../core/types";

export function rasterFromRgba(rgba: Uint8Array, width: number, height: number, name: string): RasterNode {
  const node = newRaster(name);
  const tiles: RasterNode["tiles"] = {};
  for (let ty = 0; ty * TILE < height; ty++)
    for (let tx = 0; tx * TILE < width; tx++) {
      const data = new Uint8ClampedArray(TILE * TILE * 4);
      const w = Math.min(TILE, width - tx * TILE), h = Math.min(TILE, height - ty * TILE);
      for (let y = 0; y < h; y++) {
        const src = ((ty * TILE + y) * width + tx * TILE) * 4;
        data.set(rgba.subarray(src, src + w * 4), y * TILE * 4);
      }
      if (!isBlank(data)) tiles[`${tx}_${ty}`] = makeTile(data);
    }
  node.tiles = tiles;
  return node;
}
