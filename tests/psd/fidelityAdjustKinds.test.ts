// The other adjustment kinds (selective colour, channel mixer, gradient map, photo filter, vibrance, colour lookup),
// Photoshop's dissolve pattern and CMYK compositing: Photoshop-made omni-fid-adk-* / omni-fid-cmyk-* /
// omni-fid-blend-dissolve (qa/interop/adobe-made/fidelity, qa/interop/scripts/ps_make_fidelity.jsx) against their
// merged images, the settings read from the records, and an unchanged save keeping the bytes.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { adjustFn, inkFnOf } from "../../src/core/image/adjustLayer";
import { newDocument, type RasterNode } from "../../src/core/types";
import { importPsdPage } from "../../src/io/formats/psd";
import { iccLookup, labToSrgb, readAdjustment } from "../../src/io/formats/psdAdjust";
import { writePsd } from "../../src/io/formats/psdWrite";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const files = readdirSync(DIR).filter((f) => /^omni-fid-(adk-.*|cmyk-.*|blend-dissolve)\.psd$/.test(f));
const read = (name: string) => new Uint8Array(readFileSync(join(DIR, name + ".psd")));

/** within-2 % expected per file; anything not listed must be ≥ 99 %. Approximations measured 2026-11-15. */
const LIMIT: Record<string, number> = {
  // the newer gradient methods: straight in Oklab (Photoshop also rounds the corner at each stop)
  "omni-fid-adk-gradmap-default": 30,
  // vibrance: the saturation part is exact, the vibrance part a fitted approximation
  "omni-fid-adk-vibrance": 35,
  "omni-fid-adk-vibrance-sat": 20,
  // CMYK (measured 2026-11-17 on the 128 × 96 set, core/image/adjustLayer.ts "CMYK documents"; QA: each a level or so
  // under today's value, so a step back shows): brightness fitted to 1–4 levels per ink, which the conversion to RGB
  // adds up
  "omni-fid-cmyk-adj-bright-down": 84,
  "omni-fid-cmyk-adj-brightness": 85,
  // colour balance shadows: the magenta channel 2–3 levels off in the midtones (the RGB formula on C, M, Y)
  "omni-fid-cmyk-adj-balance-shadows": 63,
  // colorize: the darkest colours less saturated in Photoshop
  "omni-fid-cmyk-adj-huesat-colorize": 71,
  // photo filter and the 'linear' gradient map: Photoshop goes through its colour management there (black regenerated)
  // — within 2 levels says little there: MEAN below holds them. These files carry no profile, so the score converts
  // both sides' inks through the default FOGRA39 since 2026-11-17 (photofilter-free within-2 5.6 → 0.05 %, but mean
  // 16.9 → 8.9 and SSIM 0.923 → 0.988). Our inks did not change (the photo filter's ink formula uses no profile; no
  // pixel within 2 ink levels of Photoshop's either way) — only the yardstick: the colour-unmanaged conversion
  // multiplies C, M, Y by K / 255 and so hides ink differences in dark colours, a profile does not. With SWOP v2
  // (Photoshop's working CMYK) as the default the file scores 0.00 % (QA 2026-11-17): not FOGRA39 against SWOP.
  "omni-fid-cmyk-adj-photofilter": 45,
  "omni-fid-cmyk-adj-photofilter-free": 0,
  "omni-fid-cmyk-adj-gradmap-linear": 0,
  // outer glow and stroke at the canvas edge: the same difference as in RGB (not a CMYK one)
  "omni-fid-cmyk-fx-glow": 60,
  "omni-fid-cmyk-fx-glow-normal": 58,
  "omni-fid-cmyk-fx-stroke": 89,
  // stroke-center: 93.8 → 70.4 % within 2 once its inks are converted through the default FOGRA39 (2026-11-17; mean
  // 6.5 → 6.3 levels, SSIM 0.877 → 0.863). The stroke colour is a CMYK colour (used as inks, never separated) and our
  // composited inks are the same with or without a profile — 25 % of pixels within 2 ink levels of Photoshop's (3–5
  // levels off on the 80 %-opaque rich black, C 73 M 67 Y 65 K 81 %). The colour-unmanaged conversion scaled those
  // differences by K / 255 ≈ 0.3 and hid them; a profile shows them (SWOP v2 as the default: 68.3 %). A stroke
  // rendering difference, not a colour one (QA 2026-11-17); MEAN below holds it.
  "omni-fid-cmyk-fx-stroke-center": 69.5,
};
/** SSIM expected for those far off; anything not listed must be > 0.99. */
const SSIM: Record<string, number> = {
  "omni-fid-cmyk-adj-photofilter-free": 0.98,
  "omni-fid-cmyk-adj-gradmap-linear": 0.92,
  "omni-fid-cmyk-fx-glow": 0.855,
  "omni-fid-cmyk-fx-glow-normal": 0.91,
  "omni-fid-cmyk-fx-stroke": 0.835,
  "omni-fid-cmyk-fx-stroke-center": 0.855,
};
/**
 * Mean channel difference at most, where within-2 cannot tell (QA 2026-11-17: today 16.9 / 39.4 / 1.7 levels; the
 * RGB formulas these replaced gave 56.6 / 84.3 / 7.9).
 */
const MEAN: Record<string, number> = {
  // (through FOGRA39 since 2026-11-17: 8.9; stroke-center 6.3)
  "omni-fid-cmyk-adj-photofilter-free": 9.5,
  "omni-fid-cmyk-fx-stroke-center": 6.6,
  "omni-fid-cmyk-adj-gradmap-linear": 40.5,
  "omni-fid-cmyk-adj-photofilter": 1.9,
};
describe("Photoshop's other adjustment kinds, dissolve and CMYK against the merged image", () => {
  it("has the measured set", () => expect(files.length).toBeGreaterThanOrEqual(15));
  for (const f of files)
    it(f, async () => {
      const s = (await scorePsd(new Uint8Array(readFileSync(join(DIR, f)))))!.score;
      const name = f.replace(/\.psd$/, "");
      expect(s.within2).toBeGreaterThanOrEqual(LIMIT[name] ?? 99);
      expect(s.ssim).toBeGreaterThan(SSIM[name] ?? 0.99);
      if (MEAN[name] !== undefined) expect(s.mean).toBeLessThanOrEqual(MEAN[name]);
    });
});

const adjOf = (name: string) => {
  const page = importPsdPage(read(name), name + ".psd", name, null).page;
  return (page.nodes.find((n) => n.type === "RASTER" && n.adjust) as RasterNode).adjust!.adj;
};

describe("reading the settings", () => {
  it("selective colour, channel mixer, photo filter, vibrance", () => {
    const sc = adjOf("omni-fid-adk-selective-rel") as { kind: string; absolute: boolean; ranges: number[][] };
    expect(sc.kind).toBe("selectiveColor");
    expect(sc.absolute).toBe(false);
    expect(sc.ranges[0]).toEqual([-30, 20, 40, 0]);
    expect(sc.ranges[4]).toEqual([40, -20, 0, 10]);
    expect(sc.ranges[7]).toEqual([0, 0, -20, 15]);
    expect(adjOf("omni-fid-adk-selective-abs")).toMatchObject({ absolute: true });
    expect(adjOf("omni-fid-adk-mixer")).toEqual({ kind: "channelMixer", mono: false, rows: [[80, 30, -10, 0], [-20, 100, 40, 5], [10, -30, 90, -8]] });
    expect(adjOf("omni-fid-adk-mixer-mono")).toMatchObject({ mono: true, rows: [[40, 40, 20, 0], [0, 100, 0, 0], [0, 0, 100, 0]] });
    const pf = adjOf("omni-fid-adk-photofilter") as { rgb: number[]; density: number; preserveLum: boolean };
    expect(pf.rgb.map(Math.round)).toEqual([236, 138, 0]);
    expect([pf.density, pf.preserveLum]).toEqual([25, true]);
    expect(adjOf("omni-fid-adk-vibrance-sat")).toEqual({ kind: "vibrance", vibrance: -40, saturation: 25 });
  });
  it("gradient map: stops, midpoints, method; colour lookup: the device link's 9-point grid", () => {
    const g = adjOf("omni-fid-adk-gradmap") as { stops: { at: number; mid: number; rgb: number[] }[]; method: string; smooth: number };
    expect(g.method).toBe("classic");
    expect(g.smooth).toBe(1);
    expect(g.stops.map((s) => [s.at, s.mid, s.rgb.map(Math.round)])).toEqual([[0, 0.5, [20, 0, 80]], [0.5, 0.5, [230, 100, 40]], [1, 0.5, [255, 250, 210]]]);
    expect((adjOf("omni-fid-adk-gradmap-linear") as { method: string; stops: { mid: number }[] }).stops[1].mid).toBe(0.3);
    expect((adjOf("omni-fid-adk-gradmap-default") as { method: string }).method).toBe("smooth");
    expect(adjOf("omni-fid-adk-lookup")).toMatchObject({ kind: "colorLookup", n: 9 });
  });
  it("Lab colours (D50) to sRGB; a profile that is not an RGB device link is no lookup", () => {
    expect(labToSrgb(100, 0, 0).map(Math.round)).toEqual([255, 255, 255]);
    expect(labToSrgb(0, 0, 0).map(Math.round)).toEqual([0, 0, 0]);
    expect(iccLookup(new Uint8Array(200))).toBeNull();
  });
});

describe("colour functions", () => {
  const run = (a: Parameters<typeof adjustFn>[0], rgb: number[]) => {
    const out = [0, 0, 0];
    adjustFn(a)!(rgb[0], rgb[1], rgb[2], out);
    return out.map(Math.round);
  };
  it("channel mixer: weights and constant in percent", () => {
    expect(run({ kind: "channelMixer", mono: false, rows: [[0, 100, 0, 0], [100, 0, 0, 0], [0, 0, 50, 10]] }, [10, 20, 100])).toEqual([20, 10, Math.round(50 + 25.5)]);
  });
  it("selective colour: a change never goes past white or black before the range share weighs it", () => {
    // reds: −100 % cyan on pure red changes nothing (no ink to take), +100 % on half red takes it all the way
    const sc = (c: number) => ({ kind: "selectiveColor" as const, absolute: true, ranges: [[c, 0, 0, 0], ...Array.from({ length: 8 }, () => [0, 0, 0, 0])] as [number, number, number, number][] });
    expect(run(sc(-100), [255, 0, 0])).toEqual([255, 0, 0]);
    expect(run(sc(100), [255, 0, 0])).toEqual([0, 0, 0]);
  });
  it("photo filter on white keeps white when luminosity is kept; vibrance leaves grey alone", () => {
    expect(run({ kind: "photoFilter", rgb: [236, 138, 0], density: 25, preserveLum: true }, [255, 255, 255])).toEqual([255, 255, 255]);
    expect(run({ kind: "vibrance", vibrance: 80, saturation: 30 }, [120, 120, 120])).toEqual([120, 120, 120]);
  });
  it("empty settings change nothing", () => {
    expect(adjustFn({ kind: "vibrance", vibrance: 0, saturation: 0 })).toBeNull();
    expect(adjustFn({ kind: "photoFilter", rgb: [0, 0, 0], density: 0, preserveLum: false })).toBeNull();
  });
});

describe("saving", () => {
  for (const name of ["omni-fid-adk-lookup", "omni-fid-adk-gradmap", "omni-fid-cmyk-blend"])
    it(`${name} unchanged: the original bytes`, async () => {
      const bytes = read(name);
      const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd");
      const page = importPsdPage(bytes, name + ".psd", name, asset).page;
      const doc = newDocument("t");
      doc.pages = [page];
      doc.assets[asset.id] = asset;
      const r = await writePsd(doc, page);
      expect(r.method).toBe("original");
      expect(r.bytes).toEqual(bytes);
    });
});

describe("documents that are not RGB", () => {
  /** A mixr block: version 1, the monochrome flag, per output channel red, green, blue, (black) weights and the constant. */
  const mixr = (mono: number, rows: number[][]) => {
    const b = new Uint8Array(4 + 40);
    const v = new DataView(b.buffer);
    v.setUint16(0, 1);
    v.setUint16(2, mono);
    rows.forEach((r, k) => r.forEach((x, i) => v.setInt16(4 + k * 10 + i * 2, x)));
    return b;
  };
  it("grayscale: a channel mixer gives grey (only the grey output exists there)", () => {
    // the grey output's weights in the first row, the other rows at their RGB defaults
    const a = readAdjustment(new Map([["mixr", mixr(0, [[50, 0, 0, 0, 10], [0, 100, 0, 0, 0], [0, 0, 100, 0, 0]])]]), new Set(), 1)!;
    const out = [0, 0, 0];
    adjustFn(a)!(100, 100, 100, out);
    expect(out.map(Math.round)).toEqual([76, 76, 76]);
  });
  it("grayscale: a gradient map of colour stops gives grey", () => {
    const g = { kind: "gradientMap" as const, stops: [{ at: 0, mid: 0.5, rgb: [255, 0, 0] as [number, number, number] }, { at: 1, mid: 0.5, rgb: [0, 0, 255] as [number, number, number] }], smooth: 0, method: "linear", reverse: false };
    const blocks = new Map([["grdm", gradmapBlock(g.stops)]]);
    const a = readAdjustment(blocks, new Set(), 1)!;
    expect(a.kind).toBe("gradientMap");
    const out = [0, 0, 0];
    adjustFn(a)!(128, 128, 128, out);
    expect(Math.round(out[0])).toBe(Math.round(out[1]));
    expect(Math.round(out[1])).toBe(Math.round(out[2]));
  });
  it("CMYK: a channel mixer weighs inks — read as ink rows, drawn by the CMYK compositor only (no RGB change)", () => {
    const a = readAdjustment(new Map([["mixr", mixr(0, [[50, 0, 0, 0, 10], [0, 100, 0, 0, 0], [0, 0, 100, 0, 0], [0, 0, 0, 100, 0]])]]), new Set(), 4)!;
    expect(a).toMatchObject({ kind: "channelMixer", ink: [[50, 0, 0, 0, 10], [0, 100, 0, 0, 0], [0, 0, 100, 0, 0], [0, 0, 0, 100, 0]] });
    expect(adjustFn(a)).toBeNull();
    // cyan: half its ink + 10 %; the rest unchanged (stored values, 255 = no ink)
    const out = new Float64Array(4);
    inkFnOf(a)!(55, 100, 150, 200, out);
    expect([...out].map(Math.round)).toEqual([130, 100, 150, 200]);
  });
  it("a colour lookup whose profile is broken is kept on save and drawn as no change", () => {
    const b = new Uint8Array(64);
    b[1] = 1;
    expect(readAdjustment(new Map([["clrL", b]]), new Set(), 3)).toEqual({ kind: "other", key: "clrL" });
  });
});

/** A version-1 grdm block of RGB colour stops (no name, no opacity stops beyond two, smoothness 4096). */
function gradmapBlock(stops: { at: number; mid: number; rgb: number[] }[]): Uint8Array {
  const b = new Uint8Array(4 + 4 + 2 + stops.length * 20 + 2 + 2 * 10 + 4 + 64);
  const v = new DataView(b.buffer);
  v.setUint16(0, 1);
  let o = 4;
  v.setUint32(o, 0);
  o += 4;
  v.setUint16(o, stops.length);
  o += 2;
  for (const s of stops) {
    v.setUint32(o, Math.round(s.at * 4096));
    v.setUint32(o + 4, Math.round(s.mid * 100));
    v.setUint16(o + 8, 0);
    s.rgb.forEach((c, i) => v.setUint16(o + 10 + i * 2, c * 257));
    o += 20;
  }
  v.setUint16(o, 2);
  o += 2;
  for (let k = 0; k < 2; k++, o += 10) {
    v.setUint32(o, k * 4096);
    v.setUint32(o + 4, 50);
    v.setUint16(o + 8, 255);
  }
  v.setUint16(o + 2, 4096);
  return b;
}
