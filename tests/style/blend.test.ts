// The single blend table (core/style/blend.ts) replaces four copies of the formulas (draw.ts, merge.ts,
// softComposite.ts, psdWrite.ts) and three key maps (psd.ts, psdWrite.ts, pdfVector.ts / export.ts). The old copies
// are kept here verbatim as the reference: every model mode must give bit-identical results.
import { describe, expect, it } from "vitest";
import { mergeRasterTiles } from "../../src/core/image/merge";
import { compositeTree } from "../../src/core/image/softComposite";
import { rasterFromRgba } from "../../src/io/formats/raster";
import { tileBounds, tilesToImg } from "../../src/core/image/pixels";
import type { RasterNode } from "../../src/core/types";
import { BLEND_TABLE, blendMix, CANVAS_BLEND, CSS_BLEND, MODEL_BLEND_MODES, PDF_BLEND, PSD_BLEND_IN, PSD_BLEND_OUT, anySeparableBlend, blendFromPsdKey, normalBlend, separableBlend } from "../../src/core/style/blend";
import { blendFn as softBlend } from "../../src/core/image/softComposite";
import type { BlendMode } from "../../src/core/types";

function oldBlend(mode: BlendMode): (cb: number, cs: number) => number {
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

// the five modes the model held before phase B: their formulas must stay bit-identical to the old copies
const MODES: BlendMode[] = ["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "HARD_LIGHT"];

describe("blend table", () => {
  it("lists Photoshop's 27 modes once each, with unique PSD keys", () => {
    expect(BLEND_TABLE).toHaveLength(27);
    expect(new Set(BLEND_TABLE.map((d) => d.id)).size).toBe(27);
    expect(new Set(BLEND_TABLE.map((d) => d.psd)).size).toBe(27);
    for (const d of BLEND_TABLE) expect(d.psd).toHaveLength(4);
  });

  it("the model holds all 27 modes (phase B), in menu order", () => {
    expect(MODEL_BLEND_MODES).toEqual(BLEND_TABLE.map((d) => d.id));
  });

  it("model formulas are bit-identical to the old copies on a dense grid (and in float32 accumulation)", () => {
    for (const m of MODES) {
      const a = separableBlend(m) ?? normalBlend, b = oldBlend(m);
      for (let i = 0; i <= 256; i++)
        for (let j = 0; j <= 256; j++) {
          const cb = i / 256, cs = j / 256;
          if (a(cb, cs) !== b(cb, cs)) throw new Error(`${m} ${cb} ${cs}`);
          const fb = Math.fround(cb * 0.7) / 0.7, fs = Math.fround(cs);
          if (a(fb, fs) !== b(fb, fs)) throw new Error(`${m} f32 ${cb} ${cs}`);
        }
    }
  });

  it("softComposite keeps its contract: null for NORMAL, the table formula otherwise", () => {
    expect(softBlend("NORMAL")).toBeNull();
    for (const m of MODES.slice(1)) expect(softBlend(m)).toBe(separableBlend(m));
  });

  it("per-format maps: the old values kept, every mode with a native name added", () => {
    expect(CANVAS_BLEND).toMatchObject({ NORMAL: "source-over", MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", HARD_LIGHT: "hard-light", DARKEN: "darken", LUMINOSITY: "luminosity" });
    expect(Object.keys(CANVAS_BLEND)).toHaveLength(16);
    expect(PDF_BLEND).toMatchObject({ NORMAL: "Normal", MULTIPLY: "Multiply", SCREEN: "Screen", OVERLAY: "Overlay", HARD_LIGHT: "HardLight", COLOR_DODGE: "ColorDodge" });
    expect(Object.keys(PDF_BLEND)).toHaveLength(16);
    expect(CSS_BLEND).toMatchObject({ MULTIPLY: "multiply", SCREEN: "screen", OVERLAY: "overlay", HARD_LIGHT: "hard-light", DIFFERENCE: "difference" });
    expect(CSS_BLEND).not.toHaveProperty("NORMAL");
    expect(Object.keys(PSD_BLEND_OUT)).toHaveLength(27);
    expect(PSD_BLEND_OUT).toMatchObject({ NORMAL: "norm", MULTIPLY: "mul ", SCREEN: "scrn", OVERLAY: "over", HARD_LIGHT: "hLit" });
    expect(Object.keys(PSD_BLEND_IN)).toHaveLength(27);
    for (const d of BLEND_TABLE) expect(PSD_BLEND_IN[d.psd]).toBe(d.id);
    expect(PSD_BLEND_IN["dark"]).toBe("DARKEN");
    expect(blendFromPsdKey("dark")).toBe("DARKEN");
    expect(blendFromPsdKey("????")).toBeNull();
  });

  it("phase-B formulas follow W3C / Photoshop at reference points", () => {
    const f = (m: Parameters<typeof anySeparableBlend>[0]) => anySeparableBlend(m)!;
    expect(f("DARKEN")(0.3, 0.6)).toBe(0.3);
    expect(f("LIGHTEN")(0.3, 0.6)).toBe(0.6);
    expect(f("DIFFERENCE")(0.3, 0.6)).toBeCloseTo(0.3, 12);
    expect(f("EXCLUSION")(0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(f("COLOR_DODGE")(0.25, 0.5)).toBeCloseTo(0.5, 12);
    expect(f("COLOR_BURN")(0.75, 0.5)).toBeCloseTo(0.5, 12);
    expect(f("LINEAR_BURN")(0.3, 0.4)).toBe(0);
    expect(f("LINEAR_DODGE")(0.7, 0.6)).toBe(1);
    expect(f("SOFT_LIGHT")(0.5, 0.5)).toBe(0.5);
    expect(f("HARD_MIX")(0.6, 0.6)).toBe(1);
    expect(f("HARD_MIX")(0.2, 0.2)).toBe(0);
    expect(anySeparableBlend("HUE")).toBeNull();
    // every Canvas operation named in the table is a real Canvas2D value
    const ops = new Set(["source-over", "multiply", "screen", "overlay", "darken", "lighten", "color-dodge", "color-burn", "hard-light", "soft-light", "difference", "exclusion", "hue", "saturation", "color", "luminosity"]);
    for (const d of BLEND_TABLE) if (d.canvas) expect(ops.has(d.canvas)).toBe(true);
  });

  it("blendMix: W3C for normal layers, Photoshop's opaque-base rule for clipped ones (bit-identical to the old expressions)", () => {
    for (const m of MODES.slice(1)) {
      const B = separableBlend(m)!;
      for (let i = 0; i <= 32; i++)
        for (let j = 0; j <= 32; j++)
          for (const da of [0.1, 0.5, 1]) {
            const cb = i / 32, cs = j / 32;
            expect(blendMix(B, cb, cs, da, false)).toBe((1 - da) * cs + da * B(cb, cs));
            expect(blendMix(B, cb, cs, da, true)).toBe(B(cb, cs));
          }
    }
  });

  it("merge down of a blended layer clipped to a semi-transparent base matches the compositor", () => {
    const W = 8, H = 8;
    const lowerPx = new Uint8Array(W * H * 4), upperPx = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      lowerPx.set([200, 120, 40, 60 + i * 2], i * 4);
      upperPx.set([30, 160, 220, 255 - i], i * 4);
    }
    const lower = rasterFromRgba(lowerPx, W, H, "base");
    const upper = { ...rasterFromRgba(upperPx, W, H, "clip"), blendMode: "MULTIPLY", clip: true } as RasterNode;
    const pixelsOf = (n: RasterNode) => {
      const b = tileBounds(n.tiles)!;
      const img = tilesToImg(n.tiles, b);
      return { rgba: img.data, left: b.ox, top: b.oy, width: b.width, height: b.height };
    };
    const ref = compositeTree([lower, upper], undefined, (n) => pixelsOf(n as RasterNode), W, H);
    const merged = { ...lower, tiles: mergeRasterTiles(lower, upper, true) } as RasterNode;
    const got = compositeTree([merged], undefined, (n) => pixelsOf(n as RasterNode), W, H);
    let max = 0;
    for (let i = 0; i < ref.length; i++) max = Math.max(max, Math.abs(ref[i] - got[i]));
    expect(max).toBeLessThanOrEqual(1);
  });
});
