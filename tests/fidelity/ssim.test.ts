// Sanity checks for the dependency-free SSIM used by the fidelity harness (npm run fidelity).
import { describe, expect, it } from "vitest";
import { fitSize, heatmap, resizeGray, ssim, toGray, type Gray } from "./ssim";

function pattern(w: number, h: number, f: (x: number, y: number) => number): Gray {
  const y = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) y[j * w + i] = f(i, j);
  return { w, h, y };
}

describe("fidelity SSIM", () => {
  const base = pattern(64, 48, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 230 : 30);

  it("identical images score 1", () => {
    expect(ssim(base, base).ssim).toBeCloseTo(1, 6);
    expect(ssim(base, base).badShare).toBe(0);
  });

  it("noise lowers the score, a local change shows only locally", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const noisy = pattern(64, 48, (x, y) => base.y[y * 64 + x] + (rnd() - 0.5) * 120);
    const s = ssim(base, noisy).ssim;
    expect(s).toBeLessThan(0.95);
    expect(s).toBeGreaterThan(0.2);
    const local = pattern(64, 48, (x, y) => (x < 16 && y < 16 ? 128 : base.y[y * 64 + x]));
    const r = ssim(base, local);
    expect(r.ssim).toBeLessThan(1);
    expect(r.map[r.map.length - 1]).toBeCloseTo(1, 6); // far corner untouched
    const hm = heatmap(base, r);
    expect(hm.length).toBe(64 * 48 * 4);
    expect(hm[0]).toBeGreaterThan(hm[1] + 40); // tinted red/yellow at the change
  });

  it("toGray composites transparency over white; resize keeps the mean", () => {
    const g = toGray(new Uint8Array([0, 0, 0, 0, 0, 0, 0, 255]), 2, 1);
    expect(g.y[0]).toBeCloseTo(255, 3);
    expect(g.y[1]).toBeCloseTo(0, 3);
    const r = resizeGray(base, 16, 12);
    const mean = (x: Gray) => x.y.reduce((a, b) => a + b, 0) / x.y.length;
    expect(Math.abs(mean(r) - mean(base))).toBeLessThan(1);
    expect(fitSize(4000, 2000, 1000)).toEqual({ w: 1000, h: 500 });
  });
});
