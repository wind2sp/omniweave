import { describe, expect, it } from "vitest";
import { applyRatio, canCrop, clampInto, fullBounds, moveCrop, normalizeCrop, resizeCrop, visibleBounds } from "../src/core/crop";
import { localBounds, makeTile, nodeBounds } from "../src/core/loom";
import { reversedDropIndex } from "../src/core/pages";
import { resizeFactors, resizeNode } from "../src/core/transform";
import { TILE, newDocument, newImage, newPdf, newRaster, newText } from "../src/core/types";
import { useStore } from "../src/core/store";
import { moveLayersTo } from "../src/ui/layers";

const R = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe("non-destructive crop maths", () => {
  const full = R(0, 0, 400, 200);
  it("which nodes can be cropped", () => {
    expect(canCrop(newImage("a", 1, 1))).toBe(true);
    expect(canCrop(newPdf("a", 0, 1, 1))).toBe(true);
    expect(canCrop(newRaster())).toBe(true);
    expect(canCrop(newText("x"))).toBe(false);
  });
  it("edge and corner handles, clamped to the content", () => {
    expect(resizeCrop(full, "e", [300, 999], full)).toEqual(R(0, 0, 300, 200));
    expect(resizeCrop(full, "nw", [-50, 20], full)).toEqual(R(0, 20, 400, 180));
    // Alt: the opposite side moves the same amount (about the centre)
    expect(resizeCrop(R(100, 50, 100, 100), "w", [120, 0], full, { fromCenter: true })).toEqual(R(120, 50, 60, 100));
  });
  it("ratio presets keep the on-page ratio, also for a stretched node", () => {
    const sq = applyRatio(full, full, 1);
    expect(sq).toEqual(R(100, 0, 200, 200));
    // node drawn twice as wide: a square on the page is half as wide locally
    const st = applyRatio(full, full, 1, 2, 1);
    expect(st.w * 2).toBeCloseTo(st.h);
    const r = resizeCrop(R(0, 0, 160, 90), "se", [300, 100], full, { ratio: 16 / 9 });
    expect(r.w / r.h).toBeCloseTo(16 / 9);
    expect(r.x).toBe(0);
  });
  it("moving stays inside the content", () => {
    expect(moveCrop(R(0, 0, 100, 100), 350, -20, full)).toEqual(R(300, 0, 100, 100));
    expect(clampInto(R(-10, 0, 1000, 50), full)).toEqual(R(0, 0, 400, 50));
  });
  it("a crop that shows everything is not stored", () => {
    expect(normalizeCrop(full, full)).toBeUndefined();
    expect(normalizeCrop(R(10.12345, 0, 100, 50), full)).toEqual(R(10.123, 0, 100, 50));
  });
});

describe("crop in bounds, hit area and resizing", () => {
  it("images report the visible part; pixels and size are untouched", () => {
    const img = newImage("a", 400, 200);
    img.transform = { x: 10, y: 20, rotation: 0, scale: 1 };
    img.crop = R(100, 50, 200, 100);
    expect(localBounds(img)).toEqual(R(100, 50, 200, 100));
    expect(nodeBounds(img)).toEqual(R(110, 70, 200, 100));
    expect(fullBounds(img)).toEqual(R(0, 0, 400, 200));
    expect(img.width).toBe(400);
  });
  it("raster layers: crop intersects the painted tiles", () => {
    const r = newRaster();
    r.tiles["0_0"] = makeTile(new Uint8ClampedArray(TILE * TILE * 4));
    r.crop = R(200, 200, 500, 500);
    expect(visibleBounds(r)).toEqual(R(200, 200, 56, 56));
  });
  it("resizing a cropped image stretches its crop with it", () => {
    const img = newImage("a", 400, 200);
    img.crop = R(100, 50, 200, 100);
    resizeNode(img, resizeFactors({ t: img.transform, lb: localBounds(img) }, "se", [500, 250]));
    expect([img.width, img.height]).toEqual([800, 400]);
    expect(img.crop).toEqual(R(200, 100, 400, 200));
    expect(nodeBounds(img)).toEqual(R(100, 50, 400, 200)); // top-left of the visible part stayed
  });
});

describe("PSD and PDF writers honour the crop", () => {
  it("rasterPixels re-encodes only the visible area of a cropped layer", async () => {
    const { rasterPixels } = await import("../src/io/formats/psdWrite");
    const r = newRaster();
    const d = new Uint8ClampedArray(TILE * TILE * 4);
    d.fill(255);
    r.tiles["0_0"] = makeTile(d);
    expect(rasterPixels(r)!.width).toBe(256);
    r.crop = R(10, 20, 30, 40);
    const px = rasterPixels(r)!;
    expect([px.left, px.top, px.width, px.height]).toEqual([10, 20, 30, 40]);
  });
  it("vector PDF export clips a cropped image (original kept whole)", async () => {
    const { readFileSync } = await import("node:fs");
    const { exportPdfVector } = await import("../src/io/pdfVector");
    const { makeAsset } = await import("../src/core/assets");
    const { PDFDocument } = await import("pdf-lib");
    // 1×1 red PNG
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    const doc = newDocument();
    const a = makeAsset(png, "image/png", "red.png");
    doc.assets[a.id] = a;
    const img = newImage(a.id, 100, 100);
    img.crop = R(0, 0, 50, 100);
    doc.pages[0].nodes = [img];
    const fonts = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };
    const bytes = await exportPdfVector(doc, doc.pages, { fonts });
    const pdf = await PDFDocument.load(bytes);
    const { inflateSync, unzlibSync } = await import("fflate");
    const contents = pdf.getPage(0).node.Contents();
    const raw = (contents as any).asArray ? (contents as any).asArray().map((r: any) => pdf.context.lookup(r)) : [contents];
    const text = raw.map((st: any) => {
      try {
        return new TextDecoder().decode(unzlibSync(st.contents));
      } catch {
        try {
          return new TextDecoder().decode(inflateSync(st.contents));
        } catch {
          return new TextDecoder().decode(st.contents);
        }
      }
    }).join("\n");
    expect(text).toMatch(/0 0 50 100 re\s+W\s+n/);
  });
});

describe("layer panel drag & drop", () => {
  it("top-first rows map to stored indices", () => {
    // 4 layers shown top-first: row 0 = stored index 3
    expect(reversedDropIndex(4, 0, false)).toBe(4); // above the top row → very top
    expect(reversedDropIndex(4, 0, true)).toBe(3); // below the top row
    expect(reversedDropIndex(4, 3, true)).toBe(0); // below the bottom row → very bottom
  });
  it("moves several layers together in one undo step", () => {
    const S = () => useStore.getState();
    const doc = newDocument();
    const ids = ["a", "b", "c", "d"].map((name) => {
      const n = newRaster(name);
      doc.pages[0].nodes.push(n);
      return n.id;
    });
    doc.pages[0].nodes.splice(0, 1); // drop the default background layer
    S().load(doc);
    moveLayersTo([ids[0], ids[2]], 4); // a and c to the top, keeping a below c
    const names = () => S().doc.pages[0].nodes.map((n) => n.name).join("");
    expect(names()).toBe("bdac");
    expect(S().past).toHaveLength(1);
    S().undo();
    expect(names()).toBe("abcd");
  });
});
