// Fill opacity, mask density and shape layers on Photoshop's own files (2026-11-18, PSD dept), scored against
// the merged image Photoshop saved in each (core/fidelity/psdScore.ts — the compositor the screen's CMYK / 32-bit path
// and the exports share):
//   omni-fid-fill50-<mode>   the eight modes that take the fill inside the formula (were 0 – 33 %)
//   omni-fid-fill0-fx        fill 0 with an outer stroke and a drop shadow: the effects stay (was 20 %)
//   omni-fid-mask-inverted-density  a mask at 60 % density (was 59 %)
//   omni-fid-shape-ellipse   a shape layer drawn from its stored render (was 65 %: not drawn)
//   omni-fid-mask-feather-prop  a mask feathered in its properties (8 px)
//   omni-fid-blendif-*       Blend If on this layer / the underlying layer / red (were 59 – 83 %)
//   omni-fid-knockout-*      a fill-0 knockout layer in a group (was 64.5 %)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scorePsd } from "../../src/core/fidelity/psdScore";
import { fillParts, fxFill, pixelBlend } from "../../src/core/style/blend";
import { importPsdPage } from "../../src/io/formats/psd";
import { writePsd } from "../../src/io/formats/psdWrite";
import { decodePsd } from "../../src/io/formats/psd";
import { engineRender } from "../../qa/interop/scripts/psd-roundtrip-check";
import { diff } from "../../qa/interop/scripts/psd-metrics";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/tile";
import { newDocument, type RasterNode } from "../../src/core/types";

const FID = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));
function openPsdDoc(file: string) {
  const bytes = new Uint8Array(readFileSync(file));
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "x.psd");
  const page = importPsdPage(bytes, "x.psd", "x", asset).page;
  const doc = newDocument("t");
  doc.pages = [page];
  doc.assets[asset.id] = asset;
  return { doc, page };
}
const score = async (name: string) => (await scorePsd(read(name + ".psd")))!.score;

describe("fill opacity", () => {
  it("the eight special modes take the fill inside the blend; the others fade the pixels", () => {
    expect(fillParts({ fillOpacity: 0.5, blendMode: "COLOR_BURN" })).toEqual({ content: 1, blend: "COLOR_BURN@0.5" });
    expect(fillParts({ fillOpacity: 0.5, blendMode: "MULTIPLY" })).toEqual({ content: 0.5, blend: "MULTIPLY" });
    expect(fillParts({ blendMode: "DIFFERENCE" })).toEqual({ content: 1, blend: "DIFFERENCE" });
    expect(fxFill({ fillOpacity: 0.4, blendMode: "NORMAL" })).toEqual([0.4, 1]);
    expect(fxFill({ fillOpacity: 0.4, fillInterior: true, blendMode: "NORMAL" })).toEqual([1, 0.4]);
    // fill 0: no change at all; difference at half fill: |b − s/2|
    const out = [0, 0, 0];
    pixelBlend("LINEAR_DODGE@0")!(0.3, 0.3, 0.3, 1, 1, 1, out);
    expect(out[0]).toBeCloseTo(0.3);
    pixelBlend("DIFFERENCE@0.5")!(0.2, 0.2, 0.2, 1, 1, 1, out);
    expect(out[0]).toBeCloseTo(0.3);
  });

  for (const m of ["colorburn", "linearburn", "colordodge", "lineardodge", "vividlight", "linearlight", "hardmix", "difference"])
    it(`omni-fid-fill50-${m}: = Photoshop`, async () => {
      const s = await score(`omni-fid-fill50-${m}`);
      expect(s.within2).toBe(100);
      expect(s.max).toBeLessThanOrEqual(2);
    });

  it("imports fill apart from opacity (Blend Interior Effects as Group too)", () => {
    const page = importPsdPage(read("omni-fid-fill40-overlay-interior.psd"), "x.psd", "x", null).page;
    const n = page.nodes.find((x) => x.name.includes("fill40"))!;
    expect(n.opacity).toBe(1);
    expect(n.fillOpacity).toBeCloseTo(0.4, 2);
    expect(n.fillInterior).toBe(true);
  });

  it("fill 0 with effects: the stroke and the knocked-out shadow stay (20 % → over 50 %), fill 40 interior stays exact", async () => {
    expect((await score("omni-fid-fill0-fx")).within2).toBeGreaterThan(50);
    expect((await score("omni-fid-fill40-overlay-interior")).within2).toBe(100);
    expect((await score("omni-fid-opacity-fill")).within2).toBe(100);
  });
});

describe("the merged image an edited file is saved with", () => {
  it("takes the fill as the screen does (Photoshop opened it: max 2, was SSIM 0.70)", async () => {
    const bytes = read("omni-fid-fill50-colorburn.psd");
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "f.psd");
    const r = importPsdPage(bytes, "f.psd", "f", asset);
    const doc = newDocument("t");
    doc.pages = [r.page];
    doc.assets[asset.id] = asset;
    const page = r.page;
    const n = page.nodes.find((x) => x.name.includes("fill50")) as RasterNode;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    data.set([255, 255, 0, 255], 0);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    const s = (await scorePsd(out.bytes))!.score;
    expect(s.max).toBeLessThanOrEqual(2);
  });
});

describe("masks and shape layers", () => {
  it("mask feather (a property, not in the mask pixels): a Gaussian of σ = the feather", async () => {
    expect((await score("omni-fid-mask-feather-prop")).within2).toBe(100);
  });
  it("mask density: the mask hides only that share", async () => {
    expect((await score("omni-fid-mask-inverted-density")).max).toBeLessThanOrEqual(1);
  });
  it("a shape layer is drawn from Photoshop's render in its channels", async () => {
    const s = await score("omni-fid-shape-ellipse");
    expect(s.within2).toBe(100);
  });
});

describe("Blend If and knockout", () => {
  it("Blend If: this layer, the underlying layer, one channel", async () => {
    expect((await score("omni-fid-blendif-this")).within2).toBeGreaterThan(97.5);
    expect((await score("omni-fid-blendif-underlying")).within2).toBeGreaterThan(99.5);
    expect((await score("omni-fid-blendif-red")).within2).toBe(100);
    const page = importPsdPage(read("omni-fid-blendif-this.psd"), "x.psd", "x", null).page;
    expect(page.nodes.find((n) => n.name.includes("blendif"))!.blendIf!.slice(0, 8)).toEqual([40, 90, 200, 240, 0, 0, 255, 255]);
    expect(page.nodes.find((n) => n.name === "omni-base")!.blendIf).toBeUndefined();
  });

  it("knockout: the shape shows what is under its group", async () => {
    for (const k of ["shallow", "deep"]) {
      expect((await score("omni-fid-knockout-" + k)).within2).toBeGreaterThan(97);
      const page = importPsdPage(read("omni-fid-knockout-" + k + ".psd"), "x.psd", "x", null).page;
      expect(page.nodes.find((n) => n.name.includes("knockout"))!.knockout).toBe(k);
    }
  });
});

describe("the merged image of a reordered file", () => {
  it("is drawn in the order the records are written (a layer the model kept between a group's members: was max 35)", async () => {
    const { doc, page } = openPsdDoc(join(FID, "..", "ps_layers_groups.psd"));
    const ls = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode && !n.psdText);
    const del = ls[1];
    page.nodes = page.nodes.filter((n) => n.id !== del.id);
    const rest = ls.filter((n) => n !== del);
    const a = page.nodes.indexOf(rest[rest.length - 1]), b = page.nodes.indexOf(rest[rest.length - 2]);
    [page.nodes[a], page.nodes[b]] = [page.nodes[b], page.nodes[a]];
    const out = (await writePsd(doc, page)).bytes;
    const e = engineRender(out);
    expect(diff(e.rgba, decodePsd(out).composite!, e.W, e.H).max).toBeLessThanOrEqual(2);
  });
});
