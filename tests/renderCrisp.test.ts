// Display-only pixel fitting (docs/design/RENDER_CRISPNESS.md): hairlines cover whole device pixels at
// 100 / 125 / 150 % scaling, handles have whole-pixel edges, table rules snap only for screen tiles, and
// weave tiles are painted at the exact device zoom except during a zoom gesture.
import { afterEach, describe, expect, it, vi } from "vitest";
import { crisp, hairCss, hairDev, pixelGrid, snapEdge, snapSquare, snapStroke } from "../src/render/crisp";
import { WeaveCache, quantizeZoom } from "../src/render/weave";

const DPRS = [1, 1.25, 1.5, 1.75, 2];
const isInt = (v: number) => Math.abs(v - Math.round(v)) < 1e-9;

describe("crisp UI hairlines", () => {
  it("a hairline is 1 device px up to 149 %, 2 from 150 %", () => {
    expect(DPRS.map(hairDev)).toEqual([1, 1, 2, 2, 2]);
    for (const d of DPRS) expect(hairCss(d) * d).toBeCloseTo(hairDev(d));
  });

  it("stroke centres put the stroke edges on device-pixel boundaries", () => {
    for (const d of DPRS)
      for (let v = 0; v < 40; v += 0.37) {
        const c = snapStroke(v, d) * d, half = hairDev(d) / 2;
        expect(isInt(c - half) && isInt(c + half)).toBe(true);
        expect(Math.abs(c - v * d)).toBeLessThanOrEqual(1); // never moves more than a device pixel
      }
  });

  it("handle squares have whole-pixel edges and an odd device size", () => {
    for (const d of DPRS)
      for (let v = 3; v < 30; v += 0.61) {
        const [x, y, s] = snapSquare(v, v * 1.3, 9, d);
        expect(isInt(x * d) && isInt(y * d) && isInt(s * d)).toBe(true);
        expect(Math.round(s * d) % 2).toBe(1);
      }
    expect(snapEdge(10.3, 1.25) * 1.25).toBe(13);
  });
});

describe("pixelGrid (table rules on screen tiles)", () => {
  const ctxAt = (a: number, d: number, e: number, f: number, b = 0) => ({ getTransform: () => ({ a, b, c: 0, d, e, f }) as DOMMatrix });

  it("snaps axis-aligned rules to device pixels, at least 1 px wide", () => {
    for (const q of [0.63, 0.75, 1, 1.25, 1.875]) {
      const g = pixelGrid(ctxAt(q, q, 12.4, -7.7))!;
      expect(g).not.toBeNull();
      expect(Math.max(1, Math.round(q))).toBeCloseTo(g.lw * q);
      for (const v of [0, 13.3, 100.5, 333.33]) {
        const dev = g.x(v) * q + 12.4;
        expect(isInt(dev - (g.lw * q) / 2)).toBe(true);
      }
    }
  });

  it("leaves rotated / non-uniform transforms and the switch-off case alone", () => {
    expect(pixelGrid(ctxAt(1, 1, 0, 0, 0.2))).toBeNull();
    expect(pixelGrid(ctxAt(1, 2, 0, 0))).toBeNull();
    crisp.snapContent = false;
    expect(pixelGrid(ctxAt(1, 1, 0, 0))).toBeNull();
    crisp.snapContent = true;
  });
});

describe("weave tile scale", () => {
  afterEach(() => vi.restoreAllMocks());

  it("paints exact after a single change, quarter-octave during a gesture, exact again once settled", () => {
    let now = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const w = new WeaveCache(4);
    const repaint = vi.fn();
    expect(w.tileScale(0.63, repaint)).toBe(0.63); // first view
    now += 2000;
    expect(w.tileScale(0.8, repaint)).toBe(0.8); // one step after a rest: exact at once
    now += 16;
    expect(w.tileScale(0.82, repaint)).toBe(quantizeZoom(0.82)); // gesture
    now += 16;
    expect(w.tileScale(0.84, repaint)).toBe(quantizeZoom(0.84));
    now += WeaveCache.SETTLE_MS;
    expect(w.tileScale(0.84, repaint)).toBe(0.84); // settled
    crisp.exactTiles = false;
    expect(w.tileScale(0.84, repaint)).toBe(quantizeZoom(0.84));
    crisp.exactTiles = true;
  });
});

describe("weave tile pools", () => {
  it("keep only a few free tiles of each kind (opaque / transparent pages do not double the cache)", () => {
    const w = new WeaveCache(4);
    const give = (w as unknown as { give(e: { canvas: object; opaque: boolean }): void }).give.bind(w);
    for (let i = 0; i < 3 * WeaveCache.POOL_MAX; i++) {
      give({ canvas: {}, opaque: false });
      give({ canvas: {}, opaque: true });
    }
    expect(w.canvases).toBe(2 * WeaveCache.POOL_MAX);
  });
});
