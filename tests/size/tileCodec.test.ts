// Lossless tile codec (src/io/tileCodec.ts): bit-exact RGBA round trip, real PNG, smaller than deflate alone.

import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { hashBytes } from "../../src/core/hash";
import { TILE } from "../../src/core/tile";
import { decodeRgbaPng, decodeTile, encodeRgbaPng, encodeTile } from "../../src/io/tileCodec";

/** Deterministic pseudo-random generator (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A photo-like tile: smooth gradients + noise + soft alpha edge, with "omniweave" written in its bits. */
function photoTile(seed = 1): Uint8ClampedArray {
  const r = rng(seed);
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const i = (y * TILE + x) * 4;
      d[i] = (x + Math.sin(y / 9) * 30 + r() * 6) | 0;
      d[i + 1] = (y * 0.8 + Math.cos(x / 13) * 25 + r() * 6) | 0;
      d[i + 2] = ((x + y) / 2 + r() * 6) | 0;
      d[i + 3] = x < 200 ? 255 : Math.max(0, 255 - (x - 200) * 5) | 0;
    }
  const tag = new TextEncoder().encode("omniweave 오메");
  d.set(tag, 4 * 17);
  return d;
}

describe("tile codec", () => {
  it("round-trips every byte (premultiplication-free: colour under alpha 0 kept)", () => {
    const r = rng(7);
    for (const tile of [photoTile(1), photoTile(2), new Uint8ClampedArray(TILE * TILE * 4), Uint8ClampedArray.from({ length: TILE * TILE * 4 }, () => (r() * 256) | 0)]) {
      tile[3] = 0; // transparent pixel with colour
      tile[0] = 200;
      const png = encodeTile(tile);
      const back = decodeTile(png);
      expect(back.length).toBe(tile.length);
      expect(hashBytes(back)).toBe(hashBytes(tile));
    }
  });

  it("is deterministic and writes a standard PNG", () => {
    const t = photoTile(3);
    const a = encodeTile(t), b = encodeTile(t);
    expect(hashBytes(a)).toBe(hashBytes(b));
    expect([...a.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const d = decodeRgbaPng(a)!;
    expect(d.width).toBe(TILE);
    expect(d.height).toBe(TILE);
  });

  it("is smaller than deflating the raw tile (photo-like content)", () => {
    const t = photoTile(4);
    const png = encodeTile(t).length;
    const deflated = zlibSync(new Uint8Array(t.buffer), { level: 6 }).length;
    expect(png).toBeLessThan(deflated * 0.8);
  });

  it("flags damage instead of returning wrong pixels", () => {
    const png = encodeTile(photoTile(5));
    for (const at of [3, 20, 60, png.length - 20]) {
      const bad = png.slice();
      bad[at] ^= 0xff;
      expect(decodeTile(bad).length).toBe(0);
    }
    expect(decodeTile(encodeRgbaPng(photoTile(5).subarray(0, 4 * 16 * 16), 16, 16)).length).toBe(0); // wrong size
  });
});
