// Duotone and artboard documents made by Photoshop (2026-11-18, PSD dept): omni-fid-duotone-* (a Photoshop
// duotone preset, black + magenta, opened and saved by Photoshop with layers added) and omni-fid-artboard-* (made through
// the Action Manager), against Photoshop's PNG exports.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { makeTile } from "../../src/core/tile";
import { newDocument, type RasterNode } from "../../src/core/types";
import { decodePsd, duotoneLut, importPsdPage, parsePsdLayout, readCompositePlanes } from "../../src/io/formats/psd";
import { decodePngRgba, writePsd } from "../../src/io/formats/psdWrite";
import { diff } from "../../qa/interop/scripts/psd-metrics";
import { engineRender } from "../../qa/interop/scripts/psd-roundtrip-check";

const FID = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));

function open(name: string) {
  const bytes = read(name + ".psd");
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd");
  const r = importPsdPage(bytes, name + ".psd", name, asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page, bytes, r };
}

describe("duotone", () => {
  it("the inks and their curves colour the grey (was: grey) — close to Photoshop's PNG", () => {
    for (const name of ["omni-fid-duotone-flat", "omni-fid-duotone-layers"]) {
      const img = decodePsd(read(name + ".psd"));
      const png = decodePngRgba(read(name + ".ps.png"));
      const d = diff(img.composite!, png.rgba, img.width, img.height);
      expect(d.max).toBeLessThanOrEqual(16);
      expect(d.mean).toBeLessThan(7);
      expect(img.warnings.join()).toContain("잉크 색과 곡선");
    }
    const lut = duotoneLut(parsePsdLayout(read("omni-fid-duotone-flat.psd")))!;
    // no ink → paper white; full ink → black over 70 % magenta (Photoshop: 33, 6, 17)
    expect(Array.from(lut.subarray(255 * 3, 256 * 3)).every((v) => v >= 250)).toBe(true);
    expect(lut[0]).toBeLessThan(45);
    expect(lut[1]).toBeLessThan(15);
  });

  it("layers are composited as their grey (the ink amount) and then coloured: = Photoshop's merged image", async () => {
    const s = (await scorePsd(read("omni-fid-duotone-layers.psd")))!.score;
    expect(s.within2).toBeGreaterThan(99.9);
    expect(s.max).toBeLessThanOrEqual(3);
  });

  it("saves unedited byte for byte; edited pixels go back to the grey their colours came from", async () => {
    const { doc, page, bytes } = open("omni-fid-duotone-layers");
    expect(Buffer.from((await writePsd(doc, page)).bytes).equals(Buffer.from(bytes))).toBe(true);
    const lut = duotoneLut(parsePsdLayout(bytes))!;
    const n = page.nodes.find((x) => x.name === "omni-base") as RasterNode;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    data.set([lut[100 * 3], lut[100 * 3 + 1], lut[100 * 3 + 2], 255], 0);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    const back = decodePsd(out.bytes);
    const L0 = back.layers.find((l) => l.name === "omni-base")!;
    const before = decodePsd(bytes).layers.find((l) => l.name === "omni-base")!;
    expect(Array.from(L0.rgba!.subarray(0, 4))).toEqual([lut[300], lut[301], lut[302], 255]);
    // every other pixel exactly as it was (grey → colour → grey is exact)
    let changed = 0;
    for (let i = 4; i < L0.rgba!.length; i++) if (L0.rgba![i] !== before.rgba![i]) changed++;
    expect(changed).toBe(0);
  });

  it("an unchanged pixel keeps its grey level, also where two levels show the same colour (QA 2026-11-18)", async () => {
    // 30 of the 256 levels of this duotone draw as the same colour as a neighbour: compared on the grey itself
    const { doc, page, bytes } = open("omni-fid-duotone-flat");
    const n = page.nodes.find((x) => x.type === "RASTER" && x.id !== page.source?.psd?.compositeNode) as RasterNode;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    data.set([255, 0, 0, 255], 0);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    const A = parsePsdLayout(bytes), B = parsePsdLayout(out.bytes);
    const ga = readCompositePlanes(A, A.channels)[0], gb = readCompositePlanes(B, B.channels)[0];
    let changed = 0;
    for (let i = 0; i < ga.length; i++) if (ga[i] !== gb[i]) changed++;
    expect(changed).toBeLessThanOrEqual(1);
  });
});

describe("artboards", () => {
  for (const name of ["omni-fid-artboard-two", "omni-fid-artboard-two-nomax", "omni-fid-artboard-clip"]) {
    it(`${name}: boards come in as groups and draw as Photoshop's PNG`, () => {
      const b = read(name + ".psd");
      const e = engineRender(b);
      const png = decodePngRgba(read(name + ".ps.png"));
      expect(diff(e.rgba, png.rgba, e.W, e.H).max).toBeLessThanOrEqual(1);
      expect(open(name).page.groups?.some((g) => g.name.startsWith("omni-board"))).toBe(true);
    });
  }
});
