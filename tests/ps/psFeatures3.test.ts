// Image mode Photoshop features, part 3: blending options and partial locks in PSD.

import { describe, expect, it } from "vitest";
import { writePsd } from "../../src/io/formats/psdWrite";
import { importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { imgToTiles, solidImg } from "../../src/core/image/pixels";
import { newDocument, newPage, newRaster } from "../../src/core/types";
import { makeAsset } from "../../src/core/assets";
import { encodePng } from "../../src/core/image/png";
import { linkedFiles, readPlaced } from "../../src/io/formats/psdSmart";

describe("blending options and locks", () => {
  it("fill opacity, knockout, Blend If and the partial locks are written and read back", async () => {
    const doc = newDocument();
    const page = newPage("DESIGN", 64, 64, "t");
    const r = newRaster("a");
    r.tiles = imgToTiles(solidImg(32, 32, 10, 20, 30), 0, 0, {}).tiles;
    r.fillOpacity = 0.4;
    r.knockout = "deep";
    r.blendIf = [20, 40, 200, 230, 0, 0, 255, 255];
    r.lockAlpha = true;
    r.lockPosition = true;
    page.nodes.push(r);
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    expect(L.records[0].blocks.some((k) => k.key === "iOpa")).toBe(true);
    const back = importPsdPage(out.bytes, "x.psd", "x", null).page.nodes.find((n) => n.name === "a")!;
    expect(back.fillOpacity).toBeCloseTo(0.4, 2);
    expect(back.knockout).toBe("deep");
    expect(back.blendIf?.slice(0, 8)).toEqual([20, 40, 200, 230, 0, 0, 255, 255]);
    expect(back.lockAlpha).toBe(true);
    expect(back.lockPosition).toBe(true);
    expect(back.lockPixels).toBeUndefined();
  });
});

describe("a smart object made here", () => {
  it("is written as a placed layer with its file in lnk2, corners following its later scale", async () => {
    const doc = newDocument();
    const page = newPage("DESIGN", 100, 80, "t");
    const r = newRaster("so");
    r.tiles = imgToTiles(solidImg(40, 20, 200, 0, 0), 0, 0, {}).tiles;
    const png = encodePng(solidImg(40, 20, 200, 0, 0).data, 40, 20, 4);
    const a = makeAsset(png, "image/png", "so.png");
    doc.assets[a.id] = a;
    r.psdSmart = { id: "11111111-2222-3333-4444-555555555555", kind: "embedded", name: "so.png", content: "png", quad: [0, 0, 40, 0, 40, 20, 0, 20], contentSize: { w: 40, h: 20 }, redraw: true, edited: { assetId: a.id, hash: a.hash, w: 40, h: 20, fp: "" }, at: { x: 0, y: 0, rotation: 0, scale: 1 } };
    r.transform = { x: 10, y: 10, rotation: 0, scale: 0.5 };
    page.nodes.push(r);
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    const pl = readPlaced(L.bytes, L.records[0])!;
    expect(pl.id).toBe(r.psdSmart.id);
    expect(pl.quad.map((v) => Math.round(v))).toEqual([10, 10, 30, 10, 30, 20, 10, 20]);
    const f = linkedFiles(L).find((x) => x.id === r.psdSmart!.id)!;
    expect(f.name).toBe("so.png");
    expect(f.data!.end - f.data!.start).toBe(png.length);
  });
});