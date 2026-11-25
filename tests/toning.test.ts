// The toning tools' pixel maths (ui/ps/toning.tsx): dodge lightens and burn darkens by the tonal range's weight,
// the sponge moves colour toward / away from its grey.
import { describe, expect, it } from "vitest";
import { rangeWeight, tonePixel } from "../src/ui/ps/toning";

const o = (range: "shadows" | "midtones" | "highlights" = "midtones", sponge: "saturate" | "desaturate" = "desaturate") => ({ range, sponge });

describe("dodge · burn · sponge", () => {
  it("each range weighs its own tones most", () => {
    expect(rangeWeight("midtones", 0.5)).toBe(1);
    expect(rangeWeight("shadows", 0.1)).toBeGreaterThan(rangeWeight("highlights", 0.1));
    expect(rangeWeight("highlights", 0.9)).toBeGreaterThan(rangeWeight("shadows", 0.9));
  });
  it("dodge lightens, burn darkens a mid grey; full white / black stay", () => {
    expect(tonePixel("dodge", [128, 128, 128], 0.5, o())[0]).toBeGreaterThan(180);
    expect(tonePixel("burn", [128, 128, 128], 0.5, o())[0]).toBeLessThan(80);
    expect(tonePixel("dodge", [255, 255, 255], 1, o("highlights"))).toEqual([255, 255, 255]);
    expect(tonePixel("burn", [0, 0, 0], 1, o("shadows"))).toEqual([0, 0, 0]);
    // the range matters: a mid grey moves less in the highlights range
    expect(tonePixel("dodge", [128, 128, 128], 0.5, o("highlights"))[0]).toBeLessThan(tonePixel("dodge", [128, 128, 128], 0.5, o("midtones"))[0]);
  });
  it("the sponge desaturates toward grey and saturates away from it", () => {
    const d = tonePixel("sponge", [200, 60, 60], 1, o());
    expect(d[0]).toBe(d[1]);
    const s = tonePixel("sponge", [160, 100, 100], 0.5, o("midtones", "saturate"));
    expect(s[0] - s[1]).toBeGreaterThan(60);
  });
});
