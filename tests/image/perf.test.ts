// Performance measurements (Node, single thread — the app runs the same code in a Web Worker).
// Assertions are loose ceilings so slow CI machines do not flake; the measured numbers are printed.

import { describe, expect, it } from "vitest";
import { applyOps, defaultParams, type ImageOp } from "../../src/core/image/ops";
import { presetOptions, traceImage } from "../../src/core/image/trace";
import { logo, photo } from "./scenes";

/** best of `n` runs (the machine may be shared with other work; the minimum is the least disturbed run) */
const time = <T>(f: () => T, n = 3): [T, number] => {
  let best = Infinity, v!: T;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    v = f();
    best = Math.min(best, performance.now() - t0);
  }
  return [v, best];
};

describe("performance (Node)", () => {
  it("trace a 1000×1000 black & white logo", () => {
    const img = logo(false);
    const [r, ms] = time(() => traceImage(img, presetOptions("logo")));
    console.log(`[perf] trace 1000×1000 흑백 로고: ${ms.toFixed(0)} ms, paths ${r.paths}, anchors ${r.anchors}`);
    expect(r.paths).toBeGreaterThanOrEqual(5);
    expect(ms).toBeLessThan(3000);
  });

  it("trace a 1000×1000 colour logo (6 colours)", () => {
    const img = logo(true);
    const [r, ms] = time(() => traceImage(img, presetOptions("color6")));
    console.log(`[perf] trace 1000×1000 색상 6: ${ms.toFixed(0)} ms, layers ${r.layers.length}, paths ${r.paths}, anchors ${r.anchors}`);
    expect(r.layers.length).toBeGreaterThanOrEqual(5);
    expect(ms).toBeLessThan(5000);
  });

  it("filters and adjustments on a 1000×1000 photo", () => {
    const img = photo(1000, 1000);
    const cases: ImageOp[] = [
      { op: "gaussianBlur", params: { radius: 10 } },
      { op: "gaussianBlur", params: { radius: 1.5 } },
      { op: "motionBlur", params: { angle: 30, distance: 20 } },
      { op: "unsharpMask", params: { amount: 120, radius: 1.5, threshold: 2 } },
      { op: "sharpen", params: defaultParams("sharpen") },
      { op: "median", params: { radius: 2 } },
      { op: "bilateral", params: { sigmaSpace: 2, sigmaRange: 25 } },
      { op: "pixelate", params: { cell: 12 } },
      { op: "emboss", params: defaultParams("emboss") },
      { op: "edgeDetect", params: defaultParams("edgeDetect") },
      { op: "vignette", params: defaultParams("vignette") },
      { op: "levels", params: { ...defaultParams("levels"), gamma: 1.4 } },
      { op: "curves", params: { rgb: [0, 0, 64, 50, 192, 210, 255, 255] } },
      { op: "hueSaturation", params: { hue: 20, saturation: 30, lightness: 0 } },
      { op: "colorBalance", params: { shadows: [10, 0, -10], midtones: [0, 5, 0], highlights: [0, 0, 10], preserveLuminosity: 1 } },
      { op: "autoColor", params: { clip: 0.1 } },
    ];
    const lines: string[] = [];
    for (const op of cases) {
      const [out, ms] = time(() => applyOps(img, [op]));
      expect(out.width).toBe(1000);
      lines.push(`${op.op} ${ms.toFixed(0)}ms`);
      expect(ms).toBeLessThan(8000);
    }
    console.log(`[perf] 1000×1000: ${lines.join(", ")}`);
  });
});
