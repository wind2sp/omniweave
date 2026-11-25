// Adjustment layers (core/image/adjustLayer.ts): every Photoshop-made omni-fid-adj-* / omni-fid-adjv-* file
// (qa/interop/adobe-made/fidelity, made by qa/interop/scripts/ps_make_fidelity.jsx) composites like Photoshop's merged
// image, within the limit noted per file; the settings are read from the layer records; saving keeps the
// adjustment records as Photoshop wrote them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { adjustFn, splineLut } from "../../src/core/image/adjustLayer";
import { mergeDownPair } from "../../src/ui/menuActions";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { checkPsd, writePsd } from "../../src/io/formats/psdWrite";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const files = readdirSync(DIR).filter((f) => /^omni-fid-adjv?-.*\.psd$/.test(f));
const read = (name: string) => new Uint8Array(readFileSync(join(DIR, name + ".psd")));

/** within-2 % expected per file; anything not listed must be ≥ 99.5 %. Approximations measured 2026-11-13. */
const LIMIT: Record<string, number> = {
  // current (non-legacy) contrast: measured tables of the luminosity curve and chroma scale, not Photoshop's formula
  "omni-fid-adj-brightness": 50,
  "omni-fid-adjv-contrast-down": 50,
  "omni-fid-adjv-contrast-up": 40,
  // colour balance shadows: a gentle gamma / black point stands in (max error 3 levels)
  "omni-fid-adjv-balance-shadows": 60,
  // levels near the input black point (max error 3), colorize and hue ranges (saturation ramp)
  "omni-fid-adj-levels": 95,
  "omni-fid-adjv-huesat-colorize": 90,
  "omni-fid-adjv-huesat-reds": 90,
};

describe("Photoshop adjustment layers: omni-fid-adj* against Photoshop's merged image", () => {
  it("has the measured set", () => expect(files.length).toBeGreaterThanOrEqual(30));
  for (const f of files)
    it(f, async () => {
      const s = (await scorePsd(new Uint8Array(readFileSync(join(DIR, f)))))!.score;
      const name = f.replace(/\.psd$/, "");
      expect(s.within2).toBeGreaterThanOrEqual(LIMIT[name] ?? 99.5);
      expect(s.ssim).toBeGreaterThan(LIMIT[name] ? 0.97 : 0.998);
    });
});

function open(name: string): { doc: OmwDocument; page: Page; bytes: Uint8Array } {
  const bytes = read(name);
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd");
  const page = importPsdPage(bytes, name + ".psd", name, asset).page;
  const doc = newDocument("t");
  doc.pages = [page];
  doc.assets[asset.id] = asset;
  return { doc, page, bytes };
}
const adjOf = (page: Page) => page.nodes.find((n) => n.type === "RASTER" && n.adjust) as RasterNode;

describe("reading adjustment settings", () => {
  it("curves: composite and red point lists from the 'Crv ' section", () => {
    const a = adjOf(open("omni-fid-adj-curves").page).adjust!.adj;
    expect(a).toEqual({ kind: "curves", ch: [{ channel: 0, pts: [[0, 0], [64, 40], [128, 150], [200, 235], [255, 255]] }, { channel: 1, pts: [[0, 30], [128, 100], [255, 255]] }] });
  });
  it("levels, hue / saturation, colour balance, exposure, black & white tint", () => {
    const lv = adjOf(open("omni-fid-adj-levels").page).adjust!.adj as { kind: string; ch: unknown[] };
    expect(lv.kind).toBe("levels");
    expect(lv.ch[0]).toEqual({ inLo: 30, inHi: 220, outLo: 10, outHi: 245, gamma: 1.4 });
    expect(adjOf(open("omni-fid-adj-huesat").page).adjust!.adj).toMatchObject({ kind: "hueSat", colorize: false, master: [40, -30, 10] });
    expect(adjOf(open("omni-fid-adjv-huesat-colorize").page).adjust!.adj).toMatchObject({ kind: "hueSat", colorize: true, colorizeHsl: [-160, 40, 10] });
    expect(adjOf(open("omni-fid-adj-colorbalance").page).adjust!.adj).toEqual({ kind: "colorBalance", shadows: [0, 0, 0], midtones: [30, -20, 10], highlights: [0, 0, 0], preserveLum: true });
    const e = adjOf(open("omni-fid-adj-exposure").page).adjust!.adj as { exposure: number; offset: number; gamma: number };
    expect([e.exposure, e.offset, e.gamma].map((v) => +v.toFixed(3))).toEqual([0.8, -0.02, 1.1]);
    expect(adjOf(open("omni-fid-adjv-blackwhite-tint").page).adjust!.adj).toMatchObject({ kind: "blackWhite", red: 60, blue: -20, magenta: 120, tint: [225, 200, 150] });
    expect(adjOf(open("omni-fid-adjv-bright-legacy").page).adjust!.adj).toEqual({ kind: "brightness", brightness: 30, contrast: 30, legacy: true });
  });
  it("an adjustment without a mask applies everywhere (no tiles, held back nowhere); a feathered mask is kept as tiles", () => {
    const plain = adjOf(open("omni-fid-adj-invert").page);
    expect(plain.adjust!.hide).toBe(true);
    expect(Object.keys(plain.tiles)).toHaveLength(0);
    const masked = adjOf(open("omni-fid-adjv-mask-feather").page);
    expect(Object.keys(masked.tiles).length).toBeGreaterThan(0);
  });
});

describe("colour functions", () => {
  const run = (a: Parameters<typeof adjustFn>[0], rgb: number[]) => {
    const out = [0, 0, 0];
    adjustFn(a)!(rgb[0], rgb[1], rgb[2], out);
    return out.map(Math.round);
  };
  it("invert, threshold (0.3 / 0.59 / 0.11, rounded), posterize", () => {
    expect(run({ kind: "invert" }, [0, 100, 255])).toEqual([255, 155, 0]);
    expect(run({ kind: "threshold", level: 128 }, [128, 128, 128])).toEqual([255, 255, 255]);
    expect(run({ kind: "threshold", level: 128 }, [255, 0, 0])).toEqual([0, 0, 0]);
    expect(run({ kind: "posterize", levels: 4 }, [0, 100, 255])).toEqual([0, 85, 255]);
  });
  it("curves: the spline passes through its points, flat beyond the ends", () => {
    const t = splineLut([[30, 10], [128, 150], [220, 240]]);
    expect([t[0], t[30], t[128], t[220], t[255]]).toEqual([10, 10, 150, 240, 240]);
  });
  it("colour balance midtones: a gamma 2^(−a/100) per channel, shifted about the middle when luminosity is kept", () => {
    const free = run({ kind: "colorBalance", shadows: [0, 0, 0], midtones: [100, 0, 0], highlights: [0, 0, 0], preserveLum: false }, [64, 64, 64]);
    expect(free).toEqual([Math.round(255 * Math.pow(64 / 255, 0.5)), 64, 64]);
    const kept = run({ kind: "colorBalance", shadows: [0, 0, 0], midtones: [100, 0, 0], highlights: [0, 0, 0], preserveLum: true }, [64, 64, 64]);
    expect(kept[1]).toBe(Math.round(255 * Math.pow(64 / 255, Math.SQRT2)));
  });
  it("unread kinds and empty settings change nothing", () => {
    expect(adjustFn({ kind: "other", key: "selc" })).toBeNull();
    expect(adjustFn({ kind: "brightness", brightness: 0, contrast: 0, legacy: false })).toBeNull();
  });
});

describe("saving a PSD with adjustment layers", () => {
  it("unchanged: the original bytes", async () => {
    const { doc, page, bytes } = open("omni-fid-adj-curves");
    const r = await writePsd(doc, page);
    expect(r.method).toBe("original");
    expect(r.bytes.length).toBe(bytes.length);
  });
  it("opacity / name of an adjustment layer: its record (settings, mask) kept, only those fields change", async () => {
    const { doc, page, bytes } = open("omni-fid-adj-curves");
    const n = adjOf(page);
    n.opacity = 0.5;
    n.name = "Curves 50";
    const r = await writePsd(doc, page);
    expect(r.method).toBe("surgery");
    const A = parsePsdLayout(bytes), B = parsePsdLayout(r.bytes);
    expect(checkPsd(r.bytes, { width: A.width, height: A.height, depth: A.depth, mode: A.mode, psb: A.psb })).toEqual([]);
    const i = A.records.findIndex((rec) => rec.blocks.some((k) => k.key === "curv"));
    const ra = A.records[i], rb = B.records[i];
    expect(rb.opacity).toBe(128);
    const curv = (L: typeof A, rec: typeof ra) => { const k = rec.blocks.find((x) => x.key === "curv")!; return [...L.bytes.subarray(k.dataStart, k.dataEnd)].join(); };
    expect(curv(B, rb)).toBe(curv(A, ra));
    expect(rb.channels.map((c) => c.id)).toEqual(ra.channels.map((c) => c.id));
    // reopened: still the same adjustment at half opacity
    const again = importPsdPage(r.bytes, "x.psd", "x", null).page;
    expect(adjOf(again).opacity).toBeCloseTo(128 / 255, 3);
    expect(adjOf(again).adjust!.adj).toEqual(n.adjust!.adj);
  });
  it("another layer edited: the rewritten merged image applies the adjustment (no mask drawn as a picture)", async () => {
    const { doc, page } = open("omni-fid-adjv-mask-feather");
    (page.nodes.find((n) => n.name === "Top") as RasterNode).visible = false;
    const r = await writePsd(doc, page);
    expect(r.method).toBe("surgery");
    const s = (await scorePsd(r.bytes))!.score;
    expect(s.within2).toBe(100);
  });
  it("a new PSD from scratch writes the adjustment layer of a kind it can write (2026-11-24: before, it was left out)", async () => {
    const { doc, page } = open("omni-fid-adj-invert");
    const copy: Page = { ...page, source: undefined };
    const r = await writePsd(doc, copy);
    expect(r.method).toBe("fresh");
    expect(r.warnings.join(" ")).not.toContain("Adjust invert");
    expect(parsePsdLayout(r.bytes).records.some((x) => x.blocks.some((k) => k.key === "nvrt"))).toBe(true);
  });
  it("an adjustment layer is never merged down as pixels", () => {
    const { page } = open("omni-fid-adj-invert");
    expect(mergeDownPair(page, [adjOf(page).id])).toBeNull();
  });
});
