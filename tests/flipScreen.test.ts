import { describe, expect, it } from "vitest";
import { flipNodeScreen } from "../src/core/transform";
import { applyTransform } from "../src/core/geom";
import { newVector, type Vec2 } from "../src/core/types";
import { rectContour } from "../src/core/vector";
import { localBounds } from "../src/core/loom";

// An arrow-like rect pointing right, rotated 30° (screen y goes down = clockwise).
function node(rotation: number, scale = 1, scaleY?: number) {
  const n = newVector([rectContour(0, 0, 100, 20)]);
  n.transform = { x: 200, y: 100, rotation, scale, ...(scaleY !== undefined ? { scaleY } : {}) };
  return n;
}
const close = (a: Vec2, b: Vec2) => {
  expect(a[0]).toBeCloseTo(b[0], 6);
  expect(a[1]).toBeCloseTo(b[1], 6);
};

describe("flip like a screen mirror (Photoshop)", () => {
  it("horizontal flip mirrors every point across the vertical line through the centre", () => {
    const n = node(30);
    const lb = localBounds(n);
    const centre = applyTransform(n.transform, [lb.x + lb.w / 2, lb.y + lb.h / 2]);
    const t2 = flipNodeScreen(n, lb, "h");
    for (const p of [[0, 0], [100, 0], [100, 20], [0, 20], [37, 11]] as Vec2[]) {
      const before = applyTransform(n.transform, p);
      const after = applyTransform(t2, p);
      close(after, [2 * centre[0] - before[0], before[1]]);
    }
    expect(t2.rotation).toBe(-30);
  });

  it("vertical flip mirrors across the horizontal line through the centre", () => {
    const n = node(30, 1.5, 0.5);
    const lb = localBounds(n);
    const centre = applyTransform(n.transform, [lb.x + lb.w / 2, lb.y + lb.h / 2]);
    const t2 = flipNodeScreen(n, lb, "v");
    for (const p of [[0, 0], [100, 20], [10, 5]] as Vec2[]) {
      const before = applyTransform(n.transform, p);
      close(applyTransform(t2, p), [before[0], 2 * centre[1] - before[1]]);
    }
  });

  it("unrotated objects flip the same way as before and flipping twice restores the object", () => {
    const n = node(0);
    const lb = localBounds(n);
    const once = flipNodeScreen(n, lb, "h");
    expect(once.rotation).toBe(0);
    const twice = flipNodeScreen({ ...n, transform: once } as any, lb, "h");
    close([twice.x, twice.y], [n.transform.x, n.transform.y]);
    expect(twice.scale).toBe(1);
    expect(twice.rotation).toBe(0);
  });
});
