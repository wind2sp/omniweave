// A raster layer is drawn tile by tile (256 px). Where a seam does not fall on a device-pixel edge — any zoom but a
// whole multiple, and while panning — each tile covered the seam pixel only in part and a faint 1 px line showed
// (2026-11-23: a light line across a rasterized photo at 114 %). Every pixel inside a flat layer must be the layer's colour
// (within 2 levels) at every zoom and sub-pixel offset.
import { beforeAll, describe, expect, it } from "vitest";
import { makeTile } from "../src/core/loom";
import { newDocument, newRaster, TILE, type RasterNode } from "../src/core/types";

let cv: typeof import("@napi-rs/canvas");
beforeAll(async () => {
  cv = await import("@napi-rs/canvas");
  const g = globalThis as any;
  g.ImageData ??= cv.ImageData;
  g.OffscreenCanvas ??= class {
    constructor(w: number, h: number) {
      return cv.createCanvas(w, h) as any;
    }
  };
});

function flat(nx: number, ny: number, rgb: [number, number, number]): RasterNode {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  for (let i = 0; i < d.length; i += 4) d.set([...rgb, 255], i);
  const tile = makeTile(d);
  const n = newRaster("omni-seam");
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) n.tiles[`${x}_${y}`] = tile;
  return n;
}

describe("raster tile seams", () => {
  it("no line along the seams at 25 · 50 · 66 · 100 · 114 · 150 · 200 · 333 %, at sub-pixel offsets", async () => {
    const { drawNode } = await import("../src/render/draw");
    const n = flat(3, 3, [220, 64, 41]);
    const doc = newDocument();
    const bad: string[] = [];
    for (const z of [0.25, 0.5, 0.66, 1, 1.14, 1.5, 2, 3.33])
      for (const off of [0, 0.37, 0.5, 0.81]) {
        const W = Math.ceil(3 * TILE * z) + 4;
        const c = cv.createCanvas(W, W);
        const g = c.getContext("2d") as any;
        g.setTransform(z, 0, 0, z, off, off);
        drawNode(g, n, { doc, clip: { x: 0, y: 0, w: 3 * TILE, h: 3 * TILE }, scale: z, incomplete: false, onResourceReady: () => {} } as any);
        const img = g.getImageData(0, 0, W, W).data as Uint8ClampedArray;
        // inside the layer, two device pixels away from its outer edge
        const lo = Math.ceil(off) + 2, hi = Math.floor(off + 3 * TILE * z) - 2;
        let worst = 0;
        for (let y = lo; y < hi; y++)
          for (let x = lo; x < hi; x++) {
            const i = (y * W + x) * 4;
            worst = Math.max(worst, Math.abs(img[i] - 220), Math.abs(img[i + 1] - 64), Math.abs(img[i + 2] - 41), 255 - img[i + 3]);
          }
        // (compositing three covers may round by 2 levels of 255 — far below what shows)
        if (worst > 2) bad.push(`${Math.round(z * 100)}% +${off}: ${worst}`);
      }
    expect(bad).toEqual([]);
  });
});
