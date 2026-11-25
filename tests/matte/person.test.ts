// The body under a head (core/image/matte/person.ts): when the matte kept only a person's head, the shirt below it
// that runs to the bottom edge is kept too; a red mug on a table (no skin) and a head-only picture are left alone.
import { describe, expect, it } from "vitest";
import { extendBody } from "../../src/core/image/matte/person";

const W = 200, H = 200;
type Px = (x: number, y: number) => [number, number, number];
const make = (f: Px) => {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const c = f(x, y);
      data.set([c[0], c[1], c[2], 255], (y * W + x) * 4);
    }
  return { width: W, height: H, data };
};
const head = (x: number, y: number) => ((x - 100) / 28) ** 2 + ((y - 80) / 36) ** 2 <= 1;
const person: Px = (x, y) => (head(x, y) ? [226, 182, 152] : y >= 125 && Math.abs(x - 100) < 35 + (y - 125) * 0.9 ? [46, 78, 150] : Math.abs(x - 100) < 12 && y >= 110 && y < 130 ? [220, 176, 148] : [208 - x * 0.05, 202, 194]);
const headAlpha = (keepNeck = true) => {
  const a = new Uint8ClampedArray(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (head(x, y) || (keepNeck && Math.abs(x - 100) < 12 && y >= 110 && y < 130)) a[y * W + x] = 255;
  return a;
};

describe("background removal: the body under a head", () => {
  it("a person whose shirt the subject model missed: the shirt is kept, the room is not", () => {
    const img = make(person);
    const a = headAlpha();
    const r = extendBody(img, a);
    expect(r.added).toBeGreaterThan(2000);
    expect(a[180 * W + 100]).toBe(255); // shirt
    expect(a[180 * W + 30]).toBe(255); // shirt at the side (it widens toward the bottom edge)
    expect(a[20 * W + 20]).toBe(0); // room
    expect(a[100 * W + 10]).toBe(0);
  });
  it("no skin in what was kept (a red mug): nothing is grown into the table below", () => {
    const mug = (x: number, y: number) => x >= 70 && x <= 130 && y >= 40 && y <= 120;
    const img = make((x, y) => (mug(x, y) ? [196, 36, 40] : y > 130 ? [120, 84, 50] : [236, 236, 232]));
    const a = new Uint8ClampedArray(W * H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (mug(x, y)) a[y * W + x] = 255;
    const r = extendBody(img, a);
    expect(r.added).toBe(0);
    expect(r.skipped).toBe("notHead");
  });
  it("below the head only background: nothing added", () => {
    const img = make((x, y) => (head(x, y) ? [226, 182, 152] : [208, 202, 194]));
    const a = headAlpha(false);
    expect(extendBody(img, a).added).toBe(0);
  });
});
