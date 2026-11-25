// Image mode Photoshop features (2026-11-24): layer masks, adjustment-layer writing, retouching kernels, smart
// selection, resampling.

import { describe, expect, it } from "vitest";
import { applyMask, maskFingerprint, maskFromPlane, maskPlane, shownTiles, invertMask } from "../../src/core/image/layerMask";
import { healBlend, inpaint, proximityOffset } from "../../src/core/image/inpaint";
import { objectSelectMask, quickSelectMask } from "../../src/core/image/smartSelect";
import { resizeImg } from "../../src/core/image/resize";
import { solidImg, newImg, imgToTiles } from "../../src/core/image/pixels";
import { adjustmentBlocks } from "../../src/io/formats/psdAdjustWrite";
import { readAdjustment } from "../../src/io/formats/psdAdjust";
import { adjustFnOf, type Adjustment } from "../../src/core/image/adjustLayer";
import { mergeRasterTiles } from "../../src/core/image/merge";
import { newRaster, type RasterNode } from "../../src/core/types";

const raster = (w: number, h: number, rgb: [number, number, number]): RasterNode => {
  const r = newRaster("t");
  r.tiles = imgToTiles(solidImg(w, h, ...rgb), 0, 0, {}).tiles;
  return r;
};

describe("layer masks", () => {
  it("a white-default mask with a black square hides the square only; the tiles keep every pixel", () => {
    const r = raster(300, 300, [200, 10, 10]);
    const plane = new Uint8Array(300 * 300).fill(255);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) plane[y * 300 + x] = 0;
    r.mask = { tiles: maskFromPlane(plane, 0, 0, 300, 300, true), hide: true };
    const shown = shownTiles(r);
    expect(shown["0_0"].data[(15 * 256 + 15) * 4 + 3]).toBe(0);
    expect(shown["0_0"].data[(50 * 256 + 50) * 4 + 3]).toBe(255);
    expect(r.tiles["0_0"].data[(15 * 256 + 15) * 4 + 3]).toBe(255);
    // the tile without mask paint stays the same object
    expect(shown["1_1"]).toBe(r.tiles["1_1"]);
    // the plane reads back as painted
    const back = maskPlane(r.mask, 0, 0, 300, 300);
    expect(back[15 * 300 + 15]).toBe(0);
    expect(back[200 * 300 + 200]).toBe(255);
  });

  it("hide-all shows nothing; off shows everything; invert swaps; apply bakes", () => {
    const r = raster(100, 100, [0, 0, 255]);
    r.mask = { tiles: {}, hide: false };
    expect(Object.keys(shownTiles(r))).toEqual([]);
    r.mask = { ...r.mask, off: true };
    expect(shownTiles(r)).toBe(r.tiles);
    const inv = invertMask({ tiles: {}, hide: false });
    expect(inv.hide).toBe(true);
    const baked = applyMask({ tiles: r.tiles, mask: { tiles: {}, hide: false } });
    expect(Object.keys(baked)).toEqual([]);
    expect(maskFingerprint(undefined)).toBe("");
    expect(maskFingerprint({ tiles: {}, hide: true })).not.toBe(maskFingerprint({ tiles: {}, hide: false }));
  });

  it("merge down bakes the upper layer's mask", () => {
    const lower = raster(100, 100, [0, 0, 0]);
    const upper = raster(100, 100, [255, 255, 255]);
    upper.mask = { tiles: {}, hide: false };
    const t = mergeRasterTiles(lower, upper);
    expect(t["0_0"].data[0]).toBe(0);
  });
});

describe("adjustment layers written for Photoshop", () => {
  const kinds: Adjustment[] = [
    { kind: "levels", ch: [{ inLo: 10, inHi: 240, outLo: 0, outHi: 255, gamma: 1.2 }] },
    { kind: "curves", ch: [{ channel: 0, pts: [[0, 0], [128, 160], [255, 255]] }] },
    { kind: "hueSat", colorize: false, colorizeHsl: [0, 25, 0], master: [120, -20, 5], ranges: [] },
    { kind: "colorBalance", shadows: [10, 0, 0], midtones: [0, -20, 5], highlights: [0, 0, 30], preserveLum: true },
    { kind: "exposure", exposure: 1.5, offset: 0.01, gamma: 1.1 },
    { kind: "brightness", brightness: 30, contrast: 20, legacy: false },
    { kind: "blackWhite", red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80, tint: null },
    { kind: "vibrance", vibrance: 50, saturation: -10 },
  ];
  for (const a of kinds)
    it(`${a.kind} reads back as written`, () => {
      const blocks = new Map(adjustmentBlocks(a)!);
      const keys = new Set(blocks.keys());
      const back = readAdjustment(blocks, keys, 3)!;
      expect(back.kind).toBe(a.kind);
      // the same colours through the read settings as through the written ones
      const f = adjustFnOf(a), g = adjustFnOf(back);
      const o1 = [0, 0, 0], o2 = [0, 0, 0];
      for (const c of [[30, 60, 90], [200, 120, 40], [128, 128, 128]] as const) {
        f?.(c[0], c[1], c[2], o1);
        g?.(c[0], c[1], c[2], o2);
        if (f && g) for (let i = 0; i < 3; i++) expect(Math.abs(o1[i] - o2[i])).toBeLessThan(1.5);
      }
    });
});

describe("retouching kernels", () => {
  it("content-aware fill rebuilds a hole in a flat area with the area's colour", () => {
    const img = solidImg(80, 80, 40, 120, 200);
    const hole = new Uint8Array(80 * 80);
    for (let y = 30; y < 45; y++) for (let x = 30; x < 45; x++) {
      hole[y * 80 + x] = 1;
      img.data.set([255, 0, 0, 255], (y * 80 + x) * 4);
    }
    const out = inpaint(img, hole);
    const i = (37 * 80 + 37) * 4;
    expect(Math.abs(out.data[i] - 40)).toBeLessThan(6);
    expect(Math.abs(out.data[i + 2] - 200)).toBeLessThan(6);
  });

  it("healing keeps the source's texture in the destination's light", () => {
    const dst = solidImg(40, 40, 200, 200, 200);
    const src = solidImg(40, 40, 100, 100, 100);
    src.data.set([110, 110, 110, 255], (20 * 40 + 20) * 4);
    const mask = new Uint8Array(40 * 40);
    for (let y = 15; y < 25; y++) for (let x = 15; x < 25; x++) mask[y * 40 + x] = 255;
    const out = healBlend(dst, src, mask);
    // flat source → the destination's grey; the texture spot stays 10 brighter
    expect(Math.abs(out.data[(17 * 40 + 17) * 4] - 200)).toBeLessThan(3);
    expect(Math.abs(out.data[(20 * 40 + 20) * 4] - 210)).toBeLessThan(3);
  });

  it("the spot's source is found next to it, outside it", () => {
    const img = solidImg(100, 100, 50, 50, 50);
    const mask = new Uint8Array(100 * 100);
    for (let y = 45; y < 55; y++) for (let x = 45; x < 55; x++) mask[y * 100 + x] = 1;
    const [dx, dy] = proximityOffset(img, mask);
    expect(Math.hypot(dx, dy)).toBeGreaterThan(9);
  });
});

describe("selection tools", () => {
  const scene = () => {
    const img = solidImg(120, 100, 240, 240, 240);
    for (let y = 30; y < 70; y++) for (let x = 40; x < 80; x++) img.data.set([200, 30, 30, 255], (y * 120 + x) * 4);
    return img;
  };
  it("quick selection stops at the red square's edge", () => {
    const img = scene();
    const m = quickSelectMask(img.data, 120, 100, [[60, 50]], 4);
    expect(m.data[50 * 120 + 45]).toBe(255);
    expect(m.data[50 * 120 + 85]).toBe(0);
  });
  it("object selection finds the square in a box round it", () => {
    const img = scene();
    const m = objectSelectMask(img.data, 120, 100, { x: 30, y: 20, w: 60, h: 60 })!;
    expect(m.data[50 * 120 + 60]).toBe(255);
    expect(m.data[25 * 120 + 35]).toBe(0);
  });
});

describe("image size", () => {
  it("resamples to the asked size, colours kept", () => {
    const img = solidImg(200, 100, 10, 200, 30);
    for (const how of ["auto", "bicubic", "bilinear", "nearest"] as const) {
      const r = resizeImg(img, 50, 25, how);
      expect([r.width, r.height]).toEqual([50, 25]);
      expect(r.data[(12 * 50 + 25) * 4 + 1]).toBeGreaterThan(195);
    }
    const up = resizeImg(newImg(10, 10), 20, 20, "bicubic");
    expect(up.width).toBe(20);
  });
});
