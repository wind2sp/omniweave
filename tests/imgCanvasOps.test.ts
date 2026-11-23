// Image / design canvas operations (2026-11-23, after the eraser / canvas-fit fix): the canvas size dialog's model
// (anchor, units, relative values, how the added room is filled), the whole-canvas flip, the crop tool's new box,
// and rasterizing a picture at its own resolution without cutting off what lies outside the canvas.
import { describe, expect, it } from "vitest";
import { anchorOffset, fillTiles, flipCanvasInPlace, resizeCanvasInPlace, type Anchor } from "../src/core/canvasSize";
import { applyTransform } from "../src/core/geom";
import { nodeBounds } from "../src/core/loom";
import { tileBounds, tilesToImg } from "../src/core/image/pixels";
import { newImage, newPage, newRaster, type Page, type RasterNode } from "../src/core/types";
import { canvasField, canvasTarget } from "../src/ui/canvasActions";
import { dragCropRect } from "../src/ui/cropTool";
import { rasterPlacement, rasterResolution } from "../src/ui/pixelSelect";
import { maskSize } from "../src/render/brush";

const px = (r: RasterNode, x: number, y: number) => {
  const img = tilesToImg(r.tiles, tileBounds(r.tiles)!);
  const i = (y * img.width + x) * 4;
  return Array.from(img.data.subarray(i, i + 4));
};

describe("canvas size", () => {
  it("anchor: the part of the old canvas that stays put, for all nine", () => {
    const want: Record<number, [number, number]> = { 0: [0, 0], 1: [100, 0], 2: [200, 0], 3: [0, 50], 4: [100, 50], 5: [200, 50], 6: [0, 100], 7: [100, 100], 8: [200, 100] };
    for (let a = 0; a < 9; a++) expect(anchorOffset(400, 300, 600, 400, a as Anchor)).toEqual(want[a]);
    expect(anchorOffset(794, 1123, 200, 150, 4)).toEqual([-297, -486]); // A4 → 200 × 150 around the middle
  });
  it("shrinking around the middle moves the layers, keeps what falls outside, adds no layer", () => {
    const p = newPage("DESIGN", 794, 1123);
    const pic = newImage("asset_omni", 794, 1123, "omni.png");
    p.nodes.push(pic);
    p.guides = { x: [397], y: [100] };
    const added = resizeCanvasInPlace(p as any, 200, 150, 4, "background", "ext");
    expect(added).toBeNull();
    expect([p.width, p.height]).toEqual([200, 150]);
    expect(p.nodes[0].transform).toMatchObject({ x: -297, y: -486 });
    expect((p.nodes[0] as any).width).toBe(794); // not resampled, nothing cut
    expect(p.guides).toEqual({ x: [100], y: [-386] });
  });
  it("growing with a colour: a bottom layer fills only the added room", () => {
    const p = newPage("DESIGN", 100, 100);
    p.nodes.push(newImage("asset_omni", 100, 100, "omni.png"));
    const added = resizeCanvasInPlace(p as any, 300, 200, 0, "#ff0000", "ext")!;
    expect(p.nodes[0].id).toBe(added.id);
    expect(px(added, 150, 50)).toEqual([255, 0, 0, 255]); // added on the right
    expect(px(added, 50, 150)).toEqual([255, 0, 0, 255]); // added below
    expect(px(added, 50, 50)[3]).toBe(0); // the old canvas stays clear
    expect(p.nodes[1].transform).toMatchObject({ x: 0, y: 0 }); // anchor top-left
  });
  it("growing transparent: the canvas turns transparent, its white stays under the old area only", () => {
    const p = newPage("DESIGN", 100, 100);
    expect(p.background).toBe("#ffffff");
    const added = resizeCanvasInPlace(p as any, 200, 200, 8, "transparent", "ext")!;
    expect(p.background).toBe("transparent");
    expect(px(added, 150, 150)).toEqual([255, 255, 255, 255]); // old canvas, now bottom-right
    expect(px(added, 50, 50)[3]).toBe(0);
  });
  it("fillTiles only makes the tiles that get pixels", () => {
    const t = fillTiles(1000, 600, "#00f", (x) => x > 900);
    expect(Object.keys(t).sort()).toEqual(["3_0", "3_1", "3_2"]);
  });
  it("dialog fields: px · % · mm and relative values", () => {
    expect(canvasTarget(50, 800, "%", false)).toBe(400);
    expect(canvasTarget(-100, 800, "px", true)).toBe(700);
    expect(canvasTarget(10, 800, "%", true)).toBe(880);
    expect(canvasTarget(210, 794, "mm", false)).toBe(794);
    expect(canvasTarget(0, 800, "px", false)).toBeNaN();
    expect(canvasField(400, 800, "%", false)).toBe(50);
    expect(canvasField(700, 800, "px", true)).toBe(-100);
  });
});

describe("canvas flip", () => {
  it("mirrors every layer across the canvas middle, no selection needed, twice = as before", () => {
    const p: Page = newPage("DESIGN", 800, 600);
    const a = newImage("asset_a", 100, 50, "a.png");
    a.transform = { x: 10, y: 20, rotation: 0, scale: 1 };
    p.nodes.push(a);
    p.guides = { x: [100] };
    flipCanvasInPlace(p as any, "h");
    const b = nodeBounds(p.nodes[0]);
    expect(b.x).toBeCloseTo(690);
    expect(b.y).toBeCloseTo(20);
    expect(p.nodes[0].transform.scale).toBe(-1);
    expect(p.guides).toEqual({ x: [700] });
    flipCanvasInPlace(p as any, "h");
    expect(p.nodes[0].transform.x).toBeCloseTo(10);
    expect(p.nodes[0].transform.scale).toBe(1);
    flipCanvasInPlace(p as any, "v");
    // (bounds are cached per node object: measure the corners)
    const ys = [applyTransform(p.nodes[0].transform, [0, 0])[1], applyTransform(p.nodes[0].transform, [0, 50])[1]];
    expect(Math.min(...ys)).toBeCloseTo(530);
  });
});

describe("crop tool: a new box", () => {
  it("is the dragged rectangle (any direction), kept inside the allowed area, ratio kept", () => {
    const full = { x: -100, y: -100, w: 1000, h: 1000 };
    expect(dragCropRect([300, 200], [100, 50], full)).toEqual({ x: 100, y: 50, w: 200, h: 150 });
    expect(dragCropRect([0, 0], [5000, 5000], full)).toEqual({ x: 0, y: 0, w: 900, h: 900 });
    const r = dragCropRect([0, 0], [400, 50], full, 2);
    expect(r.w / r.h).toBeCloseTo(2);
  });
});

describe("rasterizing a picture", () => {
  it("keeps the picture's own pixels and its place (scaled, turned, flipped)", () => {
    // a 4000 px photo placed 800 wide on the page: 5 pixels per unit, not the canvas's 1
    const lb = { x: 0, y: 0, w: 800, h: 600 };
    const k = rasterResolution(lb, 800, 4000);
    expect(k).toBe(5);
    for (const tr of [
      { x: 0, y: 0, rotation: 0, scale: 1 },
      { x: -300, y: 40, rotation: 30, scale: 0.5 },
      { x: 900, y: 10, rotation: 0, scale: -1 },
      { x: 5, y: 600, rotation: 0, scale: 1, scaleY: -1.5 },
    ]) {
      const r = rasterPlacement(tr, lb, k);
      for (const [u, v] of [[0, 0], [4000, 0], [4000, 3000], [1234, 567]] as [number, number][]) {
        const a = applyTransform(r, [u, v]), b = applyTransform(tr, [u / k, v / k]);
        expect(a[0]).toBeCloseTo(b[0], 6);
        expect(a[1]).toBeCloseTo(b[1], 6);
      }
    }
    // a frame with an origin (a cropped or offset picture)
    const r = rasterPlacement({ x: 10, y: 10, rotation: 0, scale: 1 }, { x: -50, y: -20 }, 2);
    expect(applyTransform(r, [0, 0])).toEqual([-40, -10]); // the part left of the canvas is kept
    expect(rasterResolution({ w: 100000, h: 10 }, 0, 0)).toBeCloseTo(16384 / 100000);
  });
  it("a stroke on a layer with more pixels than its place covers the whole layer", () => {
    const n = { ...newRaster("omni"), transform: { x: 0, y: 0, rotation: 0, scale: 0.2 } };
    expect(maskSize(n.transform, 800, 600)).toEqual({ w: 4000, h: 3000 });
    expect(maskSize({ x: 0, y: 0, rotation: 0, scale: 1 }, 800, 600)).toEqual({ w: 800, h: 600 });
  });
});

describe("background removal after growing the canvas", () => {
  it("the '캔버스 확장' fill layer does not count: the one picture is still the target with nothing selected", async () => {
    const { useStore } = await import("../src/core/store");
    const { newDocument } = await import("../src/core/types");
    const { imageTarget, solidFill } = await import("../src/ui/imageActions");
    const p = newPage("DESIGN", 100, 100);
    const pic = newImage("asset_omni", 100, 100, "omni.png");
    p.nodes.push(pic);
    const fill = resizeCanvasInPlace(p as any, 300, 200, 4, "#000000", "ext")!;
    expect(p.nodes.length).toBe(2);
    expect(solidFill(fill)).toBe(true);
    const doc = newDocument();
    doc.pages = [p];
    useStore.getState().load(doc);
    useStore.getState().set({ pageId: p.id, selection: [], mode: "AUTO" });
    expect(imageTarget()?.node.id).toBe(pic.id);
    // a painted (several-colour) raster does count: two candidates, one must be picked
    const painted = { ...newRaster("painted"), tiles: { ...fillTiles(10, 10, "#ff0000", (x) => x < 5), ...{} } };
    painted.tiles["0_0"] = fillTiles(10, 10, "#00ff00", (x) => x >= 5)["0_0"];
    const red = fillTiles(10, 10, "#ff0000", (x) => x < 5)["0_0"].data;
    const mixed = new Uint8ClampedArray(painted.tiles["0_0"].data);
    for (let i = 0; i < mixed.length; i += 4) if (red[i + 3]) mixed.set(red.subarray(i, i + 4), i);
    painted.tiles["0_0"] = { hash: "omni-mixed", data: mixed };
    expect(solidFill(painted)).toBe(false);
  });
});