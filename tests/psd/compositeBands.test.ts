// compositeLayers works in row bands with an opaque-normal fast path; the result must stay byte-identical to the
// straightforward whole-canvas implementation it replaced (kept here as the reference).
import { describe, expect, it } from "vitest";
import { compositeLayers } from "../../src/io/formats/psdWrite";

type Blend = "NORMAL" | "MULTIPLY" | "SCREEN" | "OVERLAY" | "HARD_LIGHT";
interface L {
  px: { rgba: Uint8Array; left: number; top: number; width: number; height: number };
  opacity: number;
  blend: Blend;
}

function blendRef(mode: Blend): (cb: number, cs: number) => number {
  switch (mode) {
    case "MULTIPLY":
      return (cb, cs) => cb * cs;
    case "SCREEN":
      return (cb, cs) => cb + cs - cb * cs;
    case "OVERLAY":
      return (cb, cs) => (cb <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs));
    case "HARD_LIGHT":
      return (cb, cs) => (cs <= 0.5 ? 2 * cb * cs : 1 - 2 * (1 - cb) * (1 - cs));
    default:
      return (_cb, cs) => cs;
  }
}

/** the implementation before the band rewrite (d06177e^) */
function compositeRef(layers: L[], W: number, H: number): Uint8Array {
  const acc = new Float32Array(W * H * 4);
  for (const L of layers) {
    const { px } = L;
    const B = blendRef(L.blend);
    const normal = L.blend === "NORMAL";
    const x0 = Math.max(0, px.left), y0 = Math.max(0, px.top);
    const x1 = Math.min(W, px.left + px.width), y1 = Math.min(H, px.top + px.height);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const s = ((y - px.top) * px.width + (x - px.left)) * 4;
        const as = (px.rgba[s + 3] / 255) * L.opacity;
        if (as <= 0) continue;
        const d = (y * W + x) * 4;
        const ab = acc[d + 3];
        for (let c = 0; c < 3; c++) {
          const cs = px.rgba[s + c] / 255;
          const cbP = acc[d + c];
          let mixed = cs;
          if (!normal && ab > 0) mixed = (1 - ab) * cs + ab * B(cbP / ab, cs);
          acc[d + c] = as * mixed + (1 - as) * cbP;
        }
        acc[d + 3] = as + ab * (1 - as);
      }
  }
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = acc[i * 4 + 3];
    if (a <= 0) continue;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round((acc[i * 4 + c] / a) * 255)));
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe("compositeLayers bands", () => {
  it("matches the whole-canvas reference for random layers, blends, opacities and offsets", () => {
    const r = rng(7);
    const modes: Blend[] = ["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "HARD_LIGHT"];
    // 2500×1700 spans two 1600-row bands (band = 4M pixels / width), so layers cross a band boundary
    for (const [W, H] of [
      [5, 7],
      [64, 3],
      [2500, 1700],
    ]) {
      const layers: L[] = [];
      for (let k = 0, n = W > 1000 ? 3 : 6; k < n; k++) {
        const w = 1 + Math.floor(r() * W * 1.2), h = 1 + Math.floor(r() * H * 1.2);
        const rgba = new Uint8Array(w * h * 4);
        for (let i = 0; i < rgba.length; i++) rgba[i] = r() < 0.3 ? 255 : r() < 0.1 ? 0 : Math.floor(r() * 256);
        layers.push({ px: { rgba, left: Math.floor((r() - 0.2) * W), top: Math.floor((r() - 0.2) * H), width: w, height: h }, opacity: r() < 0.5 ? 1 : r(), blend: modes[k % modes.length] });
      }
      const got = compositeLayers(layers as any, W, H);
      const want = compositeRef(layers, W, H);
      let diff = 0;
      for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) diff++;
      expect(diff, `${W}×${H}`).toBe(0);
    }
  });

  it("zero-size canvas", () => {
    expect(compositeLayers([], 0, 10).length).toBe(0);
    expect(compositeLayers([], 10, 0).length).toBe(0);
  });
});
