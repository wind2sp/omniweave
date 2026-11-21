// CMYK documents: adjustment layers, effect colours and darker / lighter colour on the stored inks
// (core/image/adjustLayer.ts "CMYK documents", core/image/softComposite.ts compositeInks, core/image/cmykComposite.ts
// inkEffects) — fitted on Photoshop-made omni-fid-cmyk-adj-*, -fx-*, -mode-* (fidelityAdjustKinds.test.ts scores them).
// And the RGB path left as it was: every RGB fidelity file composites to the same bytes as before the change.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { inkFnOf, type Adjustment } from "../../src/core/image/adjustLayer";
import { composeRegion, inkColor, inkEffects } from "../../src/core/image/cmykComposite";
import { compositeInks, type PlacedPixels } from "../../src/core/image/softComposite";
import { loadDissolveField } from "../../src/core/style/blend";
import { newRaster, type SceneNode } from "../../src/core/types";
import { importPsdPage } from "../../src/io/formats/psd";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const ink = (a: Adjustment, c: number, m: number, y: number, k: number) => {
  const o = new Float64Array(4);
  inkFnOf(a)!(c, m, y, k, o);
  return [...o].map(Math.round);
};

describe("adjustments on a CMYK document's inks", () => {
  it("hue / saturation: C, M, Y as R, G, B — black kept", () => {
    const a: Adjustment = { kind: "hueSat", colorize: false, colorizeHsl: [0, 25, 0], master: [0, 0, -40], ranges: [] };
    expect(ink(a, 200, 100, 50, 120)[3]).toBe(120);
    expect(ink(a, 200, 100, 50, 120).slice(0, 3)).toEqual([120, 60, 30]);
  });
  it("threshold: black ink only, from the colour as RGB (stored value × black)", () => {
    const a: Adjustment = { kind: "threshold", level: 128 };
    expect(ink(a, 255, 255, 255, 255)).toEqual([255, 255, 255, 255]);
    // light C, M, Y but half black: 255 × 0.5 → under 128
    expect(ink(a, 255, 255, 255, 127)).toEqual([255, 255, 255, 0]);
  });
  it("curves and levels: channel 4 is the black", () => {
    const c: Adjustment = { kind: "curves", ch: [{ channel: 4, pts: [[0, 50], [255, 255]] }] };
    expect(ink(c, 0, 0, 0, 0)).toEqual([0, 0, 0, 50]);
    const l: Adjustment = { kind: "levels", ch: [{ inLo: 0, inHi: 255, outLo: 0, outHi: 255, gamma: 1 }, { inLo: 0, inHi: 255, outLo: 20, outHi: 255, gamma: 1 }] };
    expect(ink(l, 0, 0, 0, 0)).toEqual([20, 0, 0, 0]);
  });
  it("selective colour changes the black too (absolute: the amount itself)", () => {
    const ranges: [number, number, number, number][] = Array.from({ length: 9 }, () => [0, 0, 0, 0]);
    ranges[8] = [0, 0, 0, 40]; // blacks: +40 % black
    const a: Adjustment = { kind: "selectiveColor", absolute: true, ranges };
    // a black pixel (all channels full ink → the blacks range fully)
    expect(ink(a, 0, 0, 0, 255)[3]).toBeLessThan(255);
    expect(ink(a, 255, 255, 255, 255)).toEqual([255, 255, 255, 255]);
  });
  it("current brightness / contrast: one curve on every channel", () => {
    const a: Adjustment = { kind: "brightness", brightness: 40, contrast: 0, legacy: false };
    const v = ink(a, 64, 64, 64, 64);
    expect(new Set(v).size).toBe(1);
    expect(v[0]).toBeGreaterThan(75);
    const d = ink({ kind: "brightness", brightness: -40, contrast: 0, legacy: false }, 128, 128, 128, 128);
    expect(d[0]).toBeLessThan(128);
  });
  it("a gradient map mixes its CMYK stops", () => {
    const a: Adjustment = { kind: "gradientMap", stops: [{ at: 0, mid: 0.5, rgb: [0, 0, 0], ink: [0, 0, 0, 0] }, { at: 1, mid: 0.5, rgb: [255, 255, 255], ink: [255, 255, 255, 255] }], smooth: 0, method: "classic", reverse: false };
    expect(ink(a, 255, 255, 255, 255)).toEqual([255, 255, 255, 255]);
    expect(ink(a, 255, 255, 255, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe("effect colours on the ink planes", () => {
  it("a CMYK colour by its inks; an RGB one as C, M, Y = R, G, B without black", () => {
    const c = { hex: "#000000", space: "cmyk" as const, v: [0.5, 0, 1, 0.2] };
    expect(inkColor(c, 0).hex).toBe("#80ff00");
    expect(inkColor(c, 1).hex).toBe("#cccccc");
    expect(inkColor({ hex: "#102030" }, 0).hex).toBe("#102030");
    expect(inkColor({ hex: "#102030" }, 1).hex).toBe("#ffffff");
  });
  it("mapped once per effects list", () => {
    const fx = [{ on: true, blend: "NORMAL", opacity: 1, type: "overlay", paint: { type: "solid", color: { hex: "#ff0000" } } }] as never;
    expect(inkEffects(fx, 1)).toBe(inkEffects(fx, 1));
    expect(inkEffects(undefined, 0)).toBeUndefined();
  });
});

describe("darker colour compares whole CMYK colours", () => {
  // backdrop: no C, M, Y ink but 60 % black; source: full cyan, no black — darker as RGB (stored × black): the backdrop
  const px = (v: number[]): PlacedPixels => ({ rgba: new Uint8Array([v[0], v[1], v[2], 255]), left: 0, top: 0, width: 1, height: 1 });
  it("keeps the backdrop when its black makes it darker", () => {
    const base = newRaster("b"), top = newRaster("t");
    top.blendMode = "DARKER_COLOR";
    const cmy = new Map<SceneNode, number[]>([[base, [255, 255, 255]], [top, [0, 255, 255]]]);
    const k = new Map<SceneNode, number[]>([[base, [102, 102, 102]], [top, [255, 255, 255]]]);
    const [c, kk] = compositeInks([base, top], undefined, (n) => px(cmy.get(n)!), { k: (n) => px(k.get(n)!), fx: inkEffects }, 1, 1);
    expect([c[0], c[1], c[2], kk[0]]).toEqual([255, 255, 255, 102]);
  });
});

/**
 * composeRegion of every RGB fidelity file before the CMYK change (sha-256, first 16 hex digits). balance-shadows
 * updated on purpose (psd-cmyk-notice: negative shadows fitted, 62.8 → 100 % against Photoshop).
 */
const RGB_BEFORE: Record<string, string> = {"omni-fid-16bit-blend.psd":"33c3f85b42a597cf","omni-fid-16bit-curves.psd":"01cd1ad2273aa250","omni-fid-adj-blackwhite.psd":"f970c9a13ffdfe68","omni-fid-adj-brightness.psd":"6a2d9adb4078f4d6","omni-fid-adj-clip.psd":"5faa67e762ef5a6f","omni-fid-adj-colorbalance.psd":"6c06db5ec3ec67bf","omni-fid-adj-curves.psd":"a1bf9c6c3c29c218","omni-fid-adj-exposure.psd":"1dc1de58e7061eee","omni-fid-adj-group-normal.psd":"5faa67e762ef5a6f","omni-fid-adj-group.psd":"a1bf9c6c3c29c218","omni-fid-adj-huesat.psd":"ed2702e861b2152c","omni-fid-adj-invert.psd":"08af584288206ab2","omni-fid-adj-levels.psd":"4e88b5df301b13b4","omni-fid-adj-posterize.psd":"95e6d2567230b611","omni-fid-adj-threshold.psd":"cb26aeb40c6bf014","omni-fid-adjv-balance-highlights.psd":"3b2b5a588cf95e8b","omni-fid-adjv-balance-mid-free.psd":"97e62b2b6c252b5b","omni-fid-adjv-balance-shadows.psd":"11a62e5e0fabff98","omni-fid-adjv-blackwhite-tint.psd":"f2f84cc31223de52","omni-fid-adjv-bright-down.psd":"6f365c9d5270a4fc","omni-fid-adjv-bright-legacy.psd":"2974694450ce6c0c","omni-fid-adjv-bright-up.psd":"6f365c9d5270a4fc","omni-fid-adjv-contrast-down.psd":"9130ceac795f062a","omni-fid-adjv-contrast-up.psd":"930ef4bd74fa5b97","omni-fid-adjv-exposure-down.psd":"39854dc66286d64d","omni-fid-adjv-huesat-colorize.psd":"c5e904b03c15cd80","omni-fid-adjv-huesat-light-down.psd":"2bad36326afd186b","omni-fid-adjv-huesat-reds.psd":"b8fbacbe5317b971","omni-fid-adjv-huesat-satup.psd":"a8d2bed4aaf5e30f","omni-fid-adjv-levels-rgb.psd":"465fd8cb8b8111ea","omni-fid-adjv-mask-feather.psd":"005b2f5fbf8fad2d","omni-fid-adjv-opacity-multiply.psd":"807f5a4bf323d803","omni-fid-adk-gradmap-default.psd":"6d4169a367ab2d89","omni-fid-adk-gradmap-linear.psd":"a9ce2024d22d1482","omni-fid-adk-gradmap.psd":"c8179d822e8c9652","omni-fid-adk-lookup.psd":"29b51c5cd39418e6","omni-fid-adk-mixer-mono.psd":"a68d1afff156558e","omni-fid-adk-mixer.psd":"58e5e420b88822ad","omni-fid-adk-photofilter-free.psd":"d57cdcde8cd8b797","omni-fid-adk-photofilter.psd":"0618efb0c6714ace","omni-fid-adk-selective-abs.psd":"809083348f4e9904","omni-fid-adk-selective-rel.psd":"ef6ec89f58907e90","omni-fid-adk-vibrance-sat.psd":"215b3c85f2e18011","omni-fid-adk-vibrance.psd":"225b1d66fe00f754","omni-fid-blend-colorblend.psd":"9a048c3c46413222","omni-fid-blend-colorburn.psd":"81d5dacc985b051e","omni-fid-blend-colordodge.psd":"bc6432af9021a1c8","omni-fid-blend-darken.psd":"b7848aba15e0e752","omni-fid-blend-darkercolor.psd":"bd04257093a60286","omni-fid-blend-difference.psd":"2520844bcc8ca9f4","omni-fid-blend-dissolve.psd":"f32aaae9278ca6c2","omni-fid-blend-divide.psd":"1576988628571989","omni-fid-blend-exclusion.psd":"ac3c23b8adbc85c2","omni-fid-blend-hardlight.psd":"f9089fefb5ad7173","omni-fid-blend-hardmix.psd":"17ee24443aad114a","omni-fid-blend-hue.psd":"a923f07740896e5f","omni-fid-blend-lighten.psd":"ef76bc549b85a272","omni-fid-blend-lightercolor.psd":"803baae3792b98e4","omni-fid-blend-linearburn.psd":"67fa1b804fc80070","omni-fid-blend-lineardodge.psd":"c8d61a036d9a93a8","omni-fid-blend-linearlight.psd":"c19c6e33993ca4d2","omni-fid-blend-luminosity.psd":"d44cde2d3ef5ca0e","omni-fid-blend-multiply.psd":"124609383122adc4","omni-fid-blend-normal.psd":"56e5b92a985e927b","omni-fid-blend-overlay.psd":"6233bc1522a76f0e","omni-fid-blend-pinlight.psd":"6472ba98d63b8337","omni-fid-blend-saturation.psd":"06764b02e48af0ed","omni-fid-blend-screen.psd":"d0f782a5cfb98fa0","omni-fid-blend-softlight.psd":"5ba8f8d1b551b4a8","omni-fid-blend-subtract.psd":"92a945a89b5972a9","omni-fid-blend-vividlight.psd":"7fac804dff674842","omni-fid-blend60-colordodge.psd":"688b2fa0e687ad63","omni-fid-blend60-hue.psd":"790b8703ec3aeb5c","omni-fid-blend60-luminosity.psd":"d363becb97d04082","omni-fid-blend60-multiply.psd":"f4f3614889343f2f","omni-fid-blend60-overlay.psd":"7114f694b2bc9cda","omni-fid-mask-ellipse.psd":"3bbbddb52b1d8157","omni-fid-mask-feather.psd":"173b91979213ee9d","omni-fid-mask-opacity.psd":"9c657a1bbd9e4785","omni-fid-opacity-fill.psd":"5702b5bc570d74e0"};

describe("RGB documents unchanged", () => {
  beforeAll(() => loadDissolveField());
  it("every RGB fidelity file composites to the same bytes as before", () => {
    const got: Record<string, string> = {};
    for (const f of Object.keys(RGB_BEFORE)) {
      const bytes = new Uint8Array(readFileSync(join(DIR, f)));
      const { page } = importPsdPage(bytes, f, f, { id: "x", hash: "" });
      const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
      got[f] = createHash("sha256").update(composeRegion(nodes, page.groups, 0, 0, page.width, page.height, null, page)).digest("hex").slice(0, 16);
    }
    expect(got).toEqual(RGB_BEFORE);
  });
});
