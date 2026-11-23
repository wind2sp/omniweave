// 2026-11-23 user report: the eraser and background removal "never work", and a canvas cut down from A4 seems to vanish.
//  - eraser: an opened PNG / JPG is a picture layer; the eraser skipped it, made an empty raster layer and erased nothing;
//  - background removal: greyed out right after opening (nothing selected), and on a JPG the removed background showed
//    the white canvas behind it;
//  - canvas size: the view stayed where it was, so a smaller canvas shrank into a corner (a bigger one ran off screen).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { newDocument, newImage, newPage, newRaster, type Page, type RasterNode } from "../src/core/types";
import { draftPage, findPage, useStore } from "../src/core/store";
import { imgToTiles, newImg, tileBounds, tilesToImg, type Img } from "../src/core/image/pixels";
import { setModelBytes } from "../src/core/image/infer";
import { removeBackground } from "../src/core/image/matte/pipeline";
import { FIT_ZOOM_MAX, fitPageIn, keepCentre } from "../src/ui/actions";
import { canvasKey, followsCanvas, needsRefit } from "../src/ui/viewFollow";
import { revealTransparencyInPlace } from "../src/ui/transparency";
import { paintTarget } from "../src/ui/pixelSelect";
import { imageTarget } from "../src/ui/imageActions";
import { removeBackgroundSelection } from "../src/ui/matteActions";
import { Stroke } from "../src/render/brush";

const S = () => useStore.getState();

function fresh(page: Page) {
  const doc = newDocument();
  doc.pages = [page];
  S().load(doc);
  S().set({ pageId: page.id, selection: [], mode: "AUTO" });
  return page;
}

/** omni-eraser-test: light grey ground, a red disc in the middle (the QA picture of this fix) */
function discImg(w = 240, h = 180): Img {
  const img = newImg(w, h);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.3;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      img.data.set(inside ? [220, 60, 40, 255] : [235, 240, 245, 255], i);
    }
  return img;
}

beforeAll(async () => {
  setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt")));
  // canvases for the brush engine (Node has none)
  const cv = await import("@napi-rs/canvas");
  const g = globalThis as any;
  g.ImageData ??= cv.ImageData;
  g.OffscreenCanvas ??= class {
    constructor(w: number, h: number) {
      return cv.createCanvas(w, h) as any;
    }
  };
});

describe("view follows the canvas (image / design modes)", () => {
  it("fit: a canvas cut from A4 to 200 × 150 is centred and enlarged to fill the window", () => {
    const v = fitPageIn({ width: 200, height: 150 }, 880, 716);
    expect(v.zoom).toBeCloseTo(Math.min(800 / 200, 636 / 150));
    expect(v.panX + (200 * v.zoom) / 2).toBeCloseTo(440);
    expect(v.panY + (150 * v.zoom) / 2).toBeCloseTo(358);
  });
  it("fit: an icon-sized canvas is enlarged up to the cap, a huge one reduced, both centred", () => {
    const tiny = fitPageIn({ width: 16, height: 16 }, 880, 716);
    expect(tiny.zoom).toBe(FIT_ZOOM_MAX);
    expect(FIT_ZOOM_MAX).toBeGreaterThanOrEqual(16);
    expect(tiny.panX + 8 * tiny.zoom).toBeCloseTo(440);
    const huge = fitPageIn({ width: 8000, height: 6000 }, 880, 716);
    expect(8000 * huge.zoom).toBeLessThanOrEqual(880 - 80 + 1e-6);
    expect(6000 * huge.zoom).toBeLessThanOrEqual(716 - 80 + 1e-6);
    expect(huge.panY + 3000 * huge.zoom).toBeCloseTo(358);
  });
  it("refits when the same document's canvas changes size; not in the document / slide modes; not for another tab", () => {
    const p = newPage("DESIGN", 794, 1123);
    const a = canvasKey({ doc: { ...newDocument(), pages: [p] }, pageId: p.id })!;
    const b = canvasKey({ doc: { ...newDocument(), pages: [{ ...p, width: 200, height: 150 }] }, pageId: p.id })!;
    for (const m of ["IMAGE", "DESIGN"] as const) expect(needsRefit(a, b, m)).toBe(true);
    for (const m of ["DOCUMENT", "SLIDE"] as const) expect(needsRefit(a, b, m)).toBe(false);
    expect(needsRefit(a, { ...a }, "IMAGE")).toBe(false); // same size (e.g. an edit of a layer)
    // another document (tab switch / opened file) with another size: it keeps its own view
    const q = newPage("DESIGN", 300, 300);
    const other = canvasKey({ doc: { ...newDocument(), pages: [q] }, pageId: q.id })!;
    expect(needsRefit(a, other, "IMAGE")).toBe(false);
    // another artboard of the same document with another size: fit it
    const both = canvasKey({ doc: { ...newDocument(), pages: [p, q] }, pageId: p.id })!;
    const toQ = canvasKey({ doc: { ...newDocument(), pages: [p, q] }, pageId: q.id })!;
    expect(needsRefit(both, toQ, "DESIGN")).toBe(true);
    expect(followsCanvas("IMAGE") && followsCanvas("DESIGN") && !followsCanvas("DOCUMENT") && !followsCanvas("SLIDE")).toBe(true);
  });
  it("a window resize keeps the point at the window's centre in place", () => {
    const v = { zoom: 2, panX: 10, panY: 20 };
    const w0 = 800, h0 = 600, w1 = 500, h1 = 450;
    const page = (vv: typeof v, w: number, h: number) => [(w / 2 - vv.panX) / vv.zoom, (h / 2 - vv.panY) / vv.zoom];
    expect(page(keepCentre(v, w1 - w0, h1 - h0), w1, h1)).toEqual(page(v, w0, h0));
  });
});

describe("eraser", () => {
  it("erases on an opened picture: the picture is rasterized (no empty layer above it), nothing selected needed", () => {
    const pg = newPage("DESIGN", 800, 600);
    const pic = newImage("asset_omni", 800, 600, "omni-eraser-test.png");
    pg.nodes.push(pic);
    fresh(pg);
    let asked: string | null = null;
    const raster = newRaster("omni-eraser-test.png");
    const stub = (page: Page, n: any) => {
      asked = n.id;
      const r: RasterNode = { ...raster, id: n.id };
      S().commit("rasterize", (d) => {
        const dp = draftPage(d, page.id)!;
        dp.nodes[dp.nodes.findIndex((x) => x.id === n.id)] = r as any;
      });
      return r;
    };
    const t = paintTarget(pg, true, true, stub);
    expect(asked).toBe(pic.id);
    expect(t?.id).toBe(pic.id);
    expect(findPage(S().doc, pg.id)!.nodes.length).toBe(1); // no extra empty raster layer
    expect(S().selection).toEqual([pic.id]);
  });
  it("the eraser never makes an empty layer; a locked selected layer is refused; the brush still makes its layer", () => {
    const pg = fresh(newPage("DESIGN", 400, 300));
    expect(paintTarget(pg, true, true, () => null)).toBeNull();
    expect(findPage(S().doc, pg.id)!.nodes.length).toBe(0);
    const brush = paintTarget(pg, false, true, () => null);
    expect(brush?.type).toBe("RASTER");
    expect(findPage(S().doc, pg.id)!.nodes.length).toBe(1);
    const locked = { ...newRaster("locked"), locked: true };
    const pg2 = newPage("DESIGN", 400, 300);
    pg2.nodes.push(locked);
    fresh(pg2);
    S().set({ selection: [locked.id] });
    expect(paintTarget(pg2, true, true, () => null)).toBeNull();
  });
  it("erased pixels become transparent, the rest keeps its colour", () => {
    const img = discImg(256, 256);
    const n = newRaster("omni-eraser-layer");
    n.tiles = imgToTiles(img, 0, 0, {}).tiles;
    const st = new Stroke(n, 256, 256, { size: 20, hardness: 1, opacity: 1, color: "#000000" } as any, true);
    st.add({ x: 30, y: 128, p: 1 });
    st.add({ x: 226, y: 128, p: 1 });
    const tiles = st.commit()!;
    expect(tiles).toBeTruthy();
    const out = tilesToImg(tiles, tileBounds(tiles)!);
    const a = (x: number, y: number) => out.data[(y * out.width + x) * 4 + 3];
    const rgb = (x: number, y: number) => Array.from(out.data.subarray((y * out.width + x) * 4, (y * out.width + x) * 4 + 3));
    expect(a(128, 128)).toBe(0); // the disc, on the stroke
    expect(a(40, 128)).toBe(0); // the ground, on the stroke
    expect(a(128, 60)).toBe(255); // the disc, off the stroke
    expect(rgb(128, 60)).toEqual([220, 60, 40]);
    expect(a(10, 10)).toBe(255);
  });
});

describe("background removal", () => {
  it("removes the ground of a flat picture: alpha 0 around, 255 on the subject", async () => {
    const r = await removeBackground(discImg());
    const w = 240;
    expect(r.alpha[5 * w + 5]).toBe(0);
    expect(r.alpha[90 * w + 120]).toBe(255);
  });
  it("works right after opening (nothing selected) and the JPG's white canvas turns transparent in the same step", async () => {
    const pg = newPage("DESIGN", 240, 180);
    pg.source = { format: "jpg", name: "omni-eraser-test.jpg" };
    expect(pg.background).toBe("#ffffff");
    const n = newRaster("omni-eraser-test.jpg");
    n.tiles = imgToTiles(discImg(), 0, 0, {}).tiles;
    pg.nodes.push(n);
    fresh(pg);
    expect(imageTarget()?.node.id).toBe(n.id);
    const before = S().past.length;
    const r = await removeBackgroundSelection();
    expect(r).toBeTruthy();
    const p = findPage(S().doc, pg.id)!;
    expect(p.background).toBe("transparent");
    expect(S().past.length).toBe(before + 1); // one undo step
    const cut = p.nodes.find((x) => x.id !== n.id) as RasterNode;
    const out = tilesToImg(cut.tiles, tileBounds(cut.tiles)!);
    expect(out.data[(5 * out.width + 5) * 4 + 3]).toBe(0);
    expect(out.data[(90 * out.width + 120) * 4 + 3]).toBe(255);
    S().undo();
    expect(findPage(S().doc, pg.id)!.background).toBe("#ffffff");
  });
  it("with nothing selected it only picks the page's one picture (several: one must be chosen)", () => {
    const pg = newPage("DESIGN", 100, 100);
    const a = newImage("asset_a", 50, 50, "a.png");
    pg.nodes.push(a);
    fresh(pg);
    expect(imageTarget()?.node.id).toBe(a.id);
    const pg2 = newPage("DESIGN", 100, 100);
    pg2.nodes.push(newImage("asset_a", 50, 50, "a.png"), newImage("asset_b", 50, 50, "b.png"));
    fresh(pg2);
    expect(imageTarget()).toBeNull();
    const pg3 = newPage("DESIGN", 100, 100);
    pg3.nodes.push({ ...newImage("asset_a", 50, 50, "a.png"), locked: true });
    fresh(pg3);
    expect(imageTarget()).toBeNull();
  });
  it("the canvas colour the user chose, and pictures with transparency, are left alone", () => {
    const keep = [
      { background: "#ffffff", source: { format: "png" } },
      { background: "#ff0000", source: { format: "jpg" } },
      { background: "#ffffff" },
    ];
    for (const p of keep) {
      const q = { ...p };
      revealTransparencyInPlace(q);
      expect(q.background).toBe(p.background);
    }
    const jpg = { background: "#FFFFFF", source: { format: "JPG" } };
    revealTransparencyInPlace(jpg);
    expect(jpg.background).toBe("transparent");
  });
});
