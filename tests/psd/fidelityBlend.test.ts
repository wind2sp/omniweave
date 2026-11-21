// Photoshop's 27 blend modes (phase B): every Photoshop-made omni-fid-blend-*.psd (qa/interop/adobe-made/fidelity,
// made by qa/interop/scripts/ps_make_fidelity.jsx) must composite like Photoshop's merged image, and the whole-pixel
// formulas must hold at reference points.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { BLEND_TABLE, dissolveKeep, loadDissolveField, needsCpuBlend, pixelBlend } from "../../src/core/style/blend";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const blendFiles = readdirSync(DIR).filter((f) => /^omni-fid-blend(60)?-.*\.psd$/.test(f));

// the dissolve thresholds are their own chunk, loaded on demand
beforeAll(() => loadDissolveField());

describe("Photoshop blend modes: omni-fid-blend-* against Photoshop's merged image", () => {
  it("has a file for each of the 27 modes", () => {
    expect(blendFiles.filter((f) => f.startsWith("omni-fid-blend-"))).toHaveLength(27);
  });
  for (const f of blendFiles)
    it(f, async () => {
      const run = await scorePsd(new Uint8Array(readFileSync(join(DIR, f))));
      const s = run!.score;
      // (dissolve: Photoshop's thresholds for pixel alpha are measured for the first 256 × 256 pixels — core/style/dissolveField.ts)
      expect(s.within2).toBeGreaterThanOrEqual(99);
      expect(s.ssim).toBeGreaterThan(0.99);
    });
});

describe("whole-pixel blend formulas", () => {
  const P = (m: string, b: number[], s: number[]) => {
    const out = [0, 0, 0];
    pixelBlend(m)!(b[0], b[1], b[2], s[0], s[1], s[2], out);
    return out;
  };
  it("every mode but NORMAL and DISSOLVE has one; the Canvas-less ones are flagged for the CPU", () => {
    for (const d of BLEND_TABLE) expect(pixelBlend(d.id) == null).toBe(d.id === "NORMAL" || d.id === "DISSOLVE");
    expect(BLEND_TABLE.filter((d) => needsCpuBlend(d.id)).map((d) => d.id)).toEqual(["DISSOLVE", "LINEAR_BURN", "DARKER_COLOR", "LINEAR_DODGE", "LIGHTER_COLOR", "VIVID_LIGHT", "LINEAR_LIGHT", "PIN_LIGHT", "HARD_MIX", "SUBTRACT", "DIVIDE"]);
    expect(needsCpuBlend("PASS_THROUGH")).toBe(false);
  });
  it("separable modes apply their formula per channel", () => {
    expect(P("MULTIPLY", [0.5, 1, 0], [0.5, 0.5, 0.5])).toEqual([0.25, 0.5, 0]);
    expect(P("SUBTRACT", [0.5, 0.2, 1], [0.25, 0.5, 0])).toEqual([0.25, 0, 1]);
  });
  it("luminosity keeps the backdrop's hue and saturation; colour keeps the backdrop's luminosity", () => {
    const lum = (c: number[]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    const b = [0.8, 0.2, 0.1], s = [0.1, 0.5, 0.9];
    expect(lum(P("LUMINOSITY", b, s))).toBeCloseTo(lum(s), 9);
    expect(lum(P("COLOR", b, s))).toBeCloseTo(lum(b), 9);
    // grey source: saturation → grey at the backdrop's luminosity
    const g = P("SATURATION", b, [0.5, 0.5, 0.5]);
    expect(g[0]).toBeCloseTo(g[1], 12);
    expect(g[0]).toBeCloseTo(lum(b), 9);
  });
  it("darker / lighter colour pick the whole colour by luminosity", () => {
    // equal channel totals, different luminosity: green is lighter than blue
    expect(P("DARKER_COLOR", [0, 1, 0], [0, 0, 1])).toEqual([0, 0, 1]);
    expect(P("LIGHTER_COLOR", [0, 0, 1], [0, 1, 0])).toEqual([0, 1, 0]);
  });
  it("dissolve keeps about `a` of the pixels, always the same ones", () => {
    let n = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (dissolveKeep(x, y, 0.3)) n++;
    expect(n / 10000).toBeGreaterThan(0.27);
    expect(n / 10000).toBeLessThan(0.33);
    expect(dissolveKeep(17, 42, 0.5)).toBe(dissolveKeep(17, 42, 0.5));
    expect(dissolveKeep(3, 4, 1)).toBe(true);
    expect(dissolveKeep(3, 4, 0)).toBe(false);
    // fixed to the document position, repeating every 256 px (negative positions too)
    for (const [x, y] of [[5, 9], [200, 31]]) {
      expect(dissolveKeep(x + 256, y + 512, 0.5)).toBe(dissolveKeep(x, y, 0.5));
      expect(dissolveKeep(x - 256, y, 0.5)).toBe(dissolveKeep(x, y, 0.5));
    }
  });
});
