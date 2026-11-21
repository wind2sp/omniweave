import { describe, expect, it } from "vitest";
import * as F from "../../src/core/image/filters";
import { applyOps } from "../../src/core/image/ops";
import { cropImg, downscale, imgToTiles, tileBounds, tilesToImg } from "../../src/core/image/pixels";
import { makeTile } from "../../src/core/loom";
import { TILE } from "../../src/core/types";
import { canvas, fillRect, gradient, px } from "./helpers";

/** sum of R over the image (blur conserves it with clamped edges on a symmetric scene) */
const sumR = (d: Uint8ClampedArray) => d.reduce((s, v, i) => (i % 4 === 0 ? s + v : s), 0);

describe("gaussian blur (3 × box)", () => {
  it("box sizes reproduce the requested sigma (variance of three boxes = σ²)", () => {
    for (const s of [2.5, 5, 12, 40]) {
      const v = F.boxesForGauss(s).reduce((acc, w) => acc + (w * w - 1) / 12, 0);
      expect(Math.sqrt(v)).toBeGreaterThan(s * 0.85);
      expect(Math.sqrt(v)).toBeLessThan(s * 1.15);
    }
  });

  it("small sigma uses the exact kernel (impulse σ within 3 %)", () => {
    const img = canvas(41, 1, [0, 0, 0]);
    img.data[20 * 4] = 255;
    const f = F.toPremul(img);
    F.gaussPremul(f, 41, 1, 1.2);
    let m0 = 0, m2 = 0;
    for (let x = 0; x < 41; x++) {
      m0 += f[x * 4];
      m2 += f[x * 4] * (x - 20) ** 2;
    }
    expect(Math.abs(Math.sqrt(m2 / m0) - 1.2) / 1.2).toBeLessThan(0.03);
  });

  it("flat colour is unchanged; an impulse spreads with the right standard deviation", () => {
    const flat = canvas(50, 50, [90, 140, 200]);
    expect(Array.from(F.gaussianBlur(flat, { radius: 6 }).data)).toEqual(Array.from(flat.data));
    // 1-D impulse along a row: measure spread of the response
    const img = canvas(201, 1, [0, 0, 0]);
    img.data[100 * 4] = 255;
    const f = F.toPremul(img);
    // amplify to keep precision: work on floats directly
    F.gaussPremul(f, 201, 1, 5);
    let m0 = 0, m2 = 0;
    for (let x = 0; x < 201; x++) {
      const v = f[x * 4];
      m0 += v;
      m2 += v * (x - 100) ** 2;
    }
    expect(m0).toBeCloseTo(255, 3); // energy conserved
    expect(Math.sqrt(m2 / m0)).toBeGreaterThan(4.5);
    expect(Math.sqrt(m2 / m0)).toBeLessThan(5.5);
  });

  it("no dark fringe at transparent edges (premultiplied)", () => {
    const img = canvas(40, 40, [0, 0, 0], 0);
    fillRect(img, 10, 10, 20, 20, [255, 0, 0]);
    const out = F.gaussianBlur(img, { radius: 3 });
    for (let i = 0; i < out.data.length; i += 4) if (out.data[i + 3] > 2) expect(out.data[i]).toBeGreaterThanOrEqual(250);
    expect(px(out, 8, 20)[3]).toBeGreaterThan(0); // alpha spread outwards
  });

  it("box blur averages the (2r+1)² window", () => {
    const img = canvas(5, 5, [0, 0, 0]);
    img.data[(2 * 5 + 2) * 4] = 225;
    expect(px(F.boxBlur(img, { radius: 1 }), 2, 2)[0]).toBe(25);
  });
});

describe("motion blur", () => {
  it("horizontal blur smears along x only and keeps flat colour", () => {
    const img = canvas(41, 41, [0, 0, 0]);
    fillRect(img, 20, 0, 1, 41, [255, 255, 255]); // vertical line
    const out = F.motionBlur(img, { angle: 0, distance: 10 });
    expect(px(out, 25, 20)[0]).toBeGreaterThan(0);
    expect(px(out, 20, 20)[0]).toBeLessThan(255);
    const vert = F.motionBlur(img, { angle: 90, distance: 10 });
    expect(px(vert, 25, 20)[0]).toBe(0);
    const flat = canvas(20, 20, [10, 20, 30]);
    expect(Array.from(F.motionBlur(flat, { angle: 33, distance: 12 }).data)).toEqual(Array.from(flat.data));
  });
});

describe("sharpening", () => {
  it("sharpen 100 % is the 5/−1 kernel", () => {
    const img = canvas(3, 3, [100, 100, 100]);
    img.data[(1 * 3 + 1) * 4] = 120;
    expect(px(F.sharpen(img, { amount: 100 }), 1, 1)[0]).toBe(5 * 120 - 4 * 100);
    expect(px(F.sharpen(img, { amount: 0 }), 1, 1)[0]).toBe(120);
  });

  it("unsharp mask boosts edges and honours the threshold", () => {
    const img = canvas(40, 10, [80, 80, 80]);
    fillRect(img, 20, 0, 20, 10, [160, 160, 160]);
    const out = F.unsharpMask(img, { amount: 100, radius: 2, threshold: 0 });
    expect(px(out, 19, 5)[0]).toBeLessThan(80); // dark side of the edge gets darker
    expect(px(out, 20, 5)[0]).toBeGreaterThan(160);
    expect(px(out, 2, 5)[0]).toBe(80); // flat area unchanged
    const th = F.unsharpMask(img, { amount: 100, radius: 2, threshold: 255 });
    expect(Array.from(th.data)).toEqual(Array.from(img.data));
  });
});

describe("noise reduction", () => {
  it("median removes salt-and-pepper and equals a brute-force median", () => {
    const img = gradient(32, 32);
    const rnd = (s: number) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const r = rnd(7);
    for (let k = 0; k < 60; k++) {
      const i = Math.floor(r() * 32 * 32) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = r() > 0.5 ? 255 : 0;
    }
    const rad = 2;
    const out = F.median(img, { radius: rad });
    for (let y = 0; y < 32; y += 3)
      for (let x = 0; x < 32; x += 3)
        for (let c = 0; c < 3; c++) {
          const v: number[] = [];
          for (let dy = -rad; dy <= rad; dy++)
            for (let dx = -rad; dx <= rad; dx++) {
              const xx = Math.min(31, Math.max(0, x + dx)), yy = Math.min(31, Math.max(0, y + dy));
              v.push(img.data[(yy * 32 + xx) * 4 + c]);
            }
          v.sort((a, b) => a - b);
          expect(out.data[(y * 32 + x) * 4 + c]).toBe(v[v.length >> 1]);
        }
  });

  it("bilateral smooths noise but keeps a hard edge", () => {
    const img = canvas(40, 20, [50, 50, 50]);
    fillRect(img, 20, 0, 20, 20, [200, 200, 200]);
    const rnd = (s: number) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const r = rnd(3);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = Math.round((r() - 0.5) * 16);
      for (let c = 0; c < 3; c++) img.data[i + c] += n;
    }
    const out = F.bilateral(img, { sigmaSpace: 2, sigmaRange: 20 });
    const varOf = (d: Uint8ClampedArray, x0: number, x1: number) => {
      const v: number[] = [];
      for (let y = 2; y < 18; y++) for (let x = x0; x < x1; x++) v.push(d[(y * 40 + x) * 4]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      return v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length;
    };
    expect(varOf(out.data, 3, 16)).toBeLessThan(varOf(img.data, 3, 16) / 3);
    expect(px(out, 18, 10)[0]).toBeLessThan(70);
    expect(px(out, 21, 10)[0]).toBeGreaterThan(180);
  });
});

describe("stylize", () => {
  it("pixelate averages each cell and anchors the grid at the full image origin", () => {
    const img = gradient(16, 16);
    const out = F.pixelate(img, { cell: 4 });
    expect(px(out, 0, 0)[0]).toBe(2); // mean of 0..3 = 1.5 → 2
    expect(px(out, 3, 3)[0]).toBe(px(out, 0, 0)[0]);
    expect(px(out, 4, 0)[0]).toBe(6);
    // a crop starting at x = 2 must still align to the same grid
    const crop = cropImg(img, 2, 0, 8, 8);
    const pc = F.pixelate(crop, { cell: 4 }, { scale: 1, fullW: 16, fullH: 16, offX: 2, offY: 0 });
    expect(px(pc, 2, 0)[0]).toBe(px(F.pixelate(cropImg(img, 4, 0, 4, 4), { cell: 4 }), 0, 0)[0]);
  });

  it("emboss of a flat image is middle grey", () => {
    const out = F.emboss(canvas(10, 10, [30, 200, 90]), { angle: 135, height: 3, amount: 100 });
    expect(px(out, 5, 5)).toEqual([128, 128, 128, 255]);
  });

  it("edge detect: flat → white (inverted), a 0→255 step → full-strength edge", () => {
    const img = canvas(20, 10, [0, 0, 0]);
    fillRect(img, 10, 0, 10, 10, [255, 255, 255]);
    const inv = F.edgeDetect(img, { invert: 1 });
    expect(px(inv, 2, 5)[0]).toBe(255);
    expect(px(inv, 9, 5)[0]).toBe(0);
    const pos = F.edgeDetect(img, { invert: 0 });
    expect(px(pos, 10, 5)[0]).toBe(255);
    expect(px(pos, 15, 5)[0]).toBe(0);
  });

  it("vignette leaves the centre alone and darkens corners; preview context matches full size", () => {
    const img = canvas(101, 101, [200, 200, 200]);
    const out = F.vignette(img, { amount: -50, midpoint: 30, feather: 50 });
    expect(px(out, 50, 50)[0]).toBe(200);
    expect(px(out, 0, 0)[0]).toBeLessThan(110);
    const lighten = F.vignette(img, { amount: 50, midpoint: 30, feather: 50 });
    expect(px(lighten, 0, 0)[0]).toBeGreaterThan(220);
    const { img: small, scale } = downscale(img, 51);
    const prev = F.vignette(small, { amount: -50, midpoint: 30, feather: 50 }, { scale, fullW: 101, fullH: 101, offX: 0, offY: 0 });
    expect(Math.abs(px(prev, 0, 0)[0] - px(out, 1, 1)[0])).toBeLessThan(8);
  });
});

describe("tiles ↔ image (Loom)", () => {
  it("round trip keeps unchanged tiles identical (same object, same hash) and only re-hashes edited ones", () => {
    const a = new Uint8ClampedArray(TILE * TILE * 4).fill(255);
    const b = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < b.length; i += 4) b.set([10, 20, 30, 255], i);
    const tiles = { "0_0": makeTile(a), "1_0": makeTile(b) };
    const bounds = tileBounds(tiles)!;
    expect(bounds).toEqual({ ox: 0, oy: 0, width: 2 * TILE, height: TILE });
    const img = tilesToImg(tiles, bounds);
    const same = imgToTiles(img, bounds.ox, bounds.oy, tiles);
    expect(same.changed).toBe(0);
    expect(same.tiles["0_0"]).toBe(tiles["0_0"]);
    img.data[(5 * img.width + TILE + 5) * 4] = 99; // edit inside tile 1_0
    const next = imgToTiles(img, bounds.ox, bounds.oy, tiles);
    expect(next.changed).toBe(1);
    expect(next.tiles["0_0"]).toBe(tiles["0_0"]);
    expect(next.tiles["1_0"].hash).not.toBe(tiles["1_0"].hash);
  });

  it("margin grows the bounds by whole tiles and blank results are dropped", () => {
    const t = new Uint8ClampedArray(TILE * TILE * 4).fill(255);
    const tiles = { "2_3": makeTile(t) };
    const b = tileBounds(tiles, 10)!;
    expect(b).toEqual({ ox: TILE, oy: 2 * TILE, width: 3 * TILE, height: 3 * TILE });
    const blurred = applyOps(tilesToImg(tiles, b), [{ op: "gaussianBlur", params: { radius: 4 } }]);
    const r = imgToTiles(blurred, b.ox, b.oy, tiles);
    expect(Object.keys(r.tiles).sort()).toEqual(["1_2", "1_3", "1_4", "2_2", "2_3", "2_4", "3_2", "3_3", "3_4"]); // soft edge spills into neighbours
    const cleared = imgToTiles({ width: b.width, height: b.height, data: new Uint8ClampedArray(b.width * b.height * 4) }, b.ox, b.oy, tiles);
    expect(Object.keys(cleared.tiles)).toEqual([]);
  });

  it("downscale keeps colour of transparent-edged shapes", () => {
    const img = canvas(100, 100, [0, 0, 0], 0);
    fillRect(img, 0, 0, 50, 100, [255, 0, 0]);
    const { img: s, scale } = downscale(img, 33);
    expect(scale).toBeCloseTo(0.33, 2);
    for (let i = 0; i < s.data.length; i += 4) if (s.data[i + 3]) expect(s.data[i]).toBe(255);
  });

  it("filters at 1/2 preview scale approximate the full result (spatial params scaled)", () => {
    const img = canvas(200, 200, [255, 255, 255]);
    fillRect(img, 50, 50, 100, 100, [0, 0, 0]);
    const full = applyOps(img, [{ op: "gaussianBlur", params: { radius: 8 } }]);
    const { img: small, scale } = downscale(img, 100);
    const prev = applyOps(small, [{ op: "gaussianBlur", params: { radius: 8 } }], { scale, fullW: 200, fullH: 200, offX: 0, offY: 0 });
    const { img: fullSmall } = downscale(full, 100);
    let maxDiff = 0;
    for (let i = 0; i < prev.data.length; i += 4) maxDiff = Math.max(maxDiff, Math.abs(prev.data[i] - fullSmall.data[i]));
    expect(maxDiff).toBeLessThan(20);
    expect(sumR(prev.data)).toBeGreaterThan(0);
  });
});

describe("transparent surroundings (raster layer padded with empty tiles)", () => {
  it("median does not paint the corners of an opaque shape black", () => {
    const img = canvas(20, 20, [0, 0, 0], 0);
    fillRect(img, 5, 5, 10, 10, [255, 255, 255]);
    const out = F.median(img, { radius: 2 });
    expect(px(out, 5, 5)).toEqual([255, 255, 255, 255]);
    expect(px(out, 14, 14)).toEqual([255, 255, 255, 255]);
    expect(px(out, 0, 0)[3]).toBe(0);
  });

  it("sharpen does not brighten the rim of a flat shape next to transparent pixels", () => {
    const img = canvas(20, 20, [0, 0, 0], 0);
    fillRect(img, 5, 5, 10, 10, [128, 128, 128]);
    const out = F.sharpen(img, { amount: 100 });
    expect(px(out, 5, 8)).toEqual([128, 128, 128, 255]);
    expect(px(out, 5, 5)).toEqual([128, 128, 128, 255]);
  });
});

describe("median — sliding histogram matches a brute-force median", () => {
  it("random image with transparent holes", () => {
    const w = 23, h = 17, r = 2;
    const img = canvas(w, h, [0, 0, 0], 0);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 256);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = rnd(); img.data[i + 1] = rnd(); img.data[i + 2] = rnd();
      img.data[i + 3] = rnd() < 60 ? 0 : 255;
    }
    const out = F.median(img, { radius: r });
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        for (let c = 0; c < 3; c++) {
          const v: number[] = [];
          for (let dy = -r; dy <= r; dy++)
            for (let dx = -r; dx <= r; dx++) {
              const j = (Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))) * 4;
              if (img.data[j + 3]) v.push(img.data[j + c]);
            }
          v.sort((a, b) => a - b);
          const i = (y * w + x) * 4 + c;
          expect(out.data[i]).toBe(v.length ? v[v.length >> 1] : img.data[i]);
        }
  });
});
