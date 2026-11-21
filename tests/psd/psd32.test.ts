// 32-bit (HDR) PSD documents (2026-11-18, PSD dept): float channels in all four compressions, the 8-bit view
// Photoshop shows by default (exposure 0, gamma 1 = the sRGB curve, clipped; transparency and masks as plain fractions),
// compositing in linear light, and Photoshop's own files omni-fid-32bit-* (made with layers kept — Image ▸ Mode ▸ 32 Bits,
// 'Don't merge') against their merged image and Photoshop's PNG exports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { zlibSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { cmykStoreOf, isLinearStore } from "../../src/core/image/cmykComposite";
import { compositeTree } from "../../src/core/image/softComposite";
import { newDocument, newRaster, type RasterNode, type SceneNode } from "../../src/core/types";
import { importPsdPage, parsePsdLayout, readChannelPlane, recordName, to8 } from "../../src/io/formats/psd";
import { makeTile } from "../../src/core/tile";
import { decodePngRgba, rasterPixels, writePsd } from "../../src/io/formats/psdWrite";
import { diff } from "../../qa/interop/scripts/psd-metrics";

const FID = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));

function floats(v: number[]): Uint8Array {
  const b = new Uint8Array(v.length * 4);
  const dv = new DataView(b.buffer);
  v.forEach((x, i) => dv.setFloat32(i * 4, x));
  return b;
}
const u16 = (v: number) => [v >> 8, v & 255];

describe("32-bit channels", () => {
  const W = 5, H = 3;
  const vals = Array.from({ length: W * H }, (_, i) => [0, 0.002, 0.05, 0.214, 0.5, 1, 2.5, -0.1][i % 8]);
  const raw = floats(vals);

  it("raw, RLE, ZIP and ZIP with prediction give the same floats", () => {
    const row = W * 4;
    // RLE: every row as one literal run
    const rle: number[] = [...u16(1)];
    for (let y = 0; y < H; y++) rle.push(...u16(row + 1));
    for (let y = 0; y < H; y++) rle.push(row - 1, ...raw.subarray(y * row, (y + 1) * row));
    // prediction: per row, the bytes regrouped into four planes (byte k of every sample), then delta coded
    const pred = new Uint8Array(raw.length);
    for (let y = 0; y < H; y++) {
      const o = y * row;
      for (let x = 0; x < W; x++) for (let k = 0; k < 4; k++) pred[o + k * W + x] = raw[o + x * 4 + k];
      for (let i = row - 1; i > 0; i--) pred[o + i] = (pred[o + i] - pred[o + i - 1]) & 255;
    }
    const cases: [string, Uint8Array][] = [
      ["raw", new Uint8Array([...u16(0), ...raw])],
      ["rle", new Uint8Array(rle)],
      ["zip", new Uint8Array([...u16(2), ...zlibSync(raw)])],
      ["zip+prediction", new Uint8Array([...u16(3), ...zlibSync(pred)])],
    ];
    for (const [name, b] of cases) expect([name, Array.from(readChannelPlane(b, 0, b.length, W, H, 4, false))]).toEqual([name, Array.from(raw)]);
  });

  it("colour through the sRGB curve (clipped), coverage as a plain fraction", () => {
    expect(Array.from(to8(raw, 8, 32))).toEqual([0, 7, 63, 127, 188, 255, 255, 0]);
    expect(Array.from(to8(raw, 8, 32, 0, true))).toEqual([0, 1, 13, 55, 128, 255, 255, 0]);
  });
});

describe("linear-light compositing", () => {
  const solid = (r: number, g: number, b: number, a = 255, w = 1, h = 1) => {
    const px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([r, g, b, a], i * 4);
    return { rgba: px, left: 0, top: 0, width: w, height: h };
  };
  const two = (top: Partial<RasterNode>) => {
    const a = newRaster("a"), b = Object.assign(newRaster("b"), top);
    return [a, b] as SceneNode[];
  };

  it("white at 50 % over black is half the light (188), not half the code value (128)", () => {
    const nodes = two({ opacity: 0.5 });
    const px = (n: SceneNode) => (n.name === "a" ? solid(0, 0, 0) : solid(255, 255, 255));
    expect(compositeTree(nodes, undefined, px, 1, 1)[0]).toBe(128);
    expect(compositeTree(nodes, undefined, px, 1, 1, undefined, true)[0]).toBe(188);
  });

  it("linear dodge keeps light past white for the layers above (Photoshop's floats)", () => {
    const [a, b] = two({ blendMode: "LINEAR_DODGE" });
    const c = Object.assign(newRaster("c"), { blendMode: "DIFFERENCE" as const });
    const px = (n: SceneNode) => (n.name === "c" ? solid(255, 255, 255) : solid(188, 188, 188));
    // 0.5 + 0.5 ≈ 1 → difference with 1 ≈ 0; and 0.8 + 0.8 = 1.6 → difference with 1 = 0.6 (a clamped dodge: 0)
    expect(compositeTree([a, b, c], undefined, px, 1, 1, undefined, true)[0]).toBeLessThan(25);
    const px2 = (n: SceneNode) => (n.name === "c" ? solid(255, 255, 255) : solid(231, 231, 231));
    expect(compositeTree([a, b, c], undefined, px2, 1, 1, undefined, true)[0]).toBeGreaterThan(190);
  });
});

describe("Photoshop's 32-bit files (omni-fid-32bit-*)", () => {
  const open = (name: string) => {
    const bytes = read(name + ".psd");
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd");
    const r = importPsdPage(bytes, name + ".psd", name, asset);
    const doc = newDocument("t");
    doc.pages = [r.page];
    doc.assets[asset.id] = asset;
    return { doc, page: r.page, r };
  };

  for (const name of ["omni-fid-32bit-blend", "omni-fid-32bit-normal-alpha", "omni-fid-32bit-mask-group", "omni-fid-32bit-blend-nomax"]) {
    it(`${name}: layers composited in linear light = Photoshop's PNG (and its merged image)`, async () => {
      const { doc, page, r } = open(name);
      expect(r.pixelLayers).toBeGreaterThan(2);
      expect(r.warnings.join()).toContain("노출 0·감마 1");
      expect(isLinearStore(cmykStoreOf(doc, page))).toBe(true);
      const png = decodePngRgba(read(name + ".ps.png"));
      const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
      const px = new Map(nodes.filter((n) => n.type === "RASTER").map((n) => [n.id, rasterPixels(n as RasterNode)]));
      const ours = compositeTree(nodes, page.groups, (n) => px.get(n.id) ?? null, page.width, page.height, undefined, true);
      expect(diff(ours, png.rgba, page.width, page.height).max).toBeLessThanOrEqual(1);
      if (!name.endsWith("-nomax")) {
        expect(diff(r.image.composite!, png.rgba, page.width, page.height).max).toBeLessThanOrEqual(1);
        const s = (await scorePsd(r.image.composite ? read(name + ".psd") : new Uint8Array()))!.score;
        expect(s.within2).toBe(100);
      }
    });
  }

  it("layer pixels = Photoshop's layer PNGs (8-bit conversion without merging)", () => {
    const { page } = open("omni-fid-32bit-normal-alpha");
    const soft = page.nodes.find((n) => n.name === "omni-soft") as RasterNode;
    const png = decodePngRgba(read("layers/omni-fid-32bit-normal-alpha.L0.png"));
    const p = rasterPixels(soft)!;
    let max = 0;
    for (let y = 0; y < p.height; y++)
      for (let x = 0; x < p.width; x++) {
        const s = (y * p.width + x) * 4, o = ((y + p.top) * page.width + x + p.left) * 4;
        max = Math.max(max, Math.abs(p.rgba[s + 3] - png.rgba[o + 3]));
        if (png.rgba[o + 3] > 250) for (let c = 0; c < 3; c++) max = Math.max(max, Math.abs(p.rgba[s + c] - png.rgba[o + c]));
      }
    expect(max).toBeLessThanOrEqual(1);
  });

  it("saves unedited byte for byte; an edit keeps every unchanged float (light past white too), new pixels as shown", async () => {
    const { doc, page } = open("omni-fid-32bit-hdr");
    const orig = read("omni-fid-32bit-hdr.psd");
    expect(Buffer.from((await writePsd(doc, page)).bytes).equals(Buffer.from(orig))).toBe(true);
    const n = page.nodes.find((x) => x.name === "omni-hot +2") as RasterNode;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    data.set([0, 0, 255, 255], (60 * 256 + 60) * 4);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    expect(out.warnings.join()).toContain("원래 값(흰색을 넘는 빛 포함) 그대로");
    // the edited layer: one pixel changed, every other float as it was (thousands past 1)
    const floats = (b: Uint8Array) => {
      const L = parsePsdLayout(b);
      const rec = L.records.find((r) => recordName(b, r) === "omni-hot +2")!;
      const w = rec.right - rec.left, h = rec.bottom - rec.top;
      const p = readChannelPlane(b, rec.channels.find((c) => c.id === 0)!.start, rec.channels.find((c) => c.id === 0)!.end, w, h, 4, false);
      return { dv: new DataView(p.buffer, p.byteOffset, p.byteLength), n: w * h, left: rec.left, top: rec.top, w };
    };
    const A = floats(orig), B = floats(out.bytes);
    let same = 0, over1 = 0;
    for (let i = 0; i < A.n; i++) {
      const v = A.dv.getFloat32(i * 4);
      if (v === B.dv.getFloat32(i * 4)) same++;
      if (v > 1) over1++;
    }
    expect(over1).toBeGreaterThan(10000);
    expect(same).toBe(A.n - 1);
    // the merged image is composited in linear light with those floats (= Photoshop's PNG, max 1)
    expect((await scorePsd(out.bytes))!.score.within2).toBe(100);
  });

  it("a blend mode Photoshop has no 32-bit form of is refused (Photoshop would not open the file)", async () => {
    const { doc, page } = open("omni-fid-32bit-blend");
    page.nodes.find((x) => x.name === "omni-multiply")!.blendMode = "SCREEN";
    await expect(writePsd(doc, page)).rejects.toThrow("허용하지 않는 혼합 모드(SCREEN)");
    page.nodes.find((x) => x.name === "omni-multiply")!.blendMode = "LIGHTEN";
    expect((await writePsd(doc, page)).method).toBe("surgery");
  });

  it("omni-fid-32bit-hdr: light past white blends as Photoshop's floats (multiply over exposure +2)", async () => {
    const { r } = open("omni-fid-32bit-hdr");
    expect((await scorePsd(read("omni-fid-32bit-hdr.psd")))!.score.max).toBeLessThanOrEqual(1);
    expect(r.warnings.join()).toContain("흰색을 넘는 빛");
  });
});
