import { describe, expect, it } from "vitest";
import { applyTransform, invertTransform, transformRect } from "../src/core/geom";
import { localBounds, nodeBounds } from "../src/core/loom";
import {
  boxCorners,
  flipNode,
  handleCursor,
  handlePoint,
  keepRatio,
  pickHandle,
  pointerTarget,
  resizeFactors,
  resizeNode,
  rotatedAbout,
  scaleNodeAbout,
  scaledTransform,
  type Box,
} from "../src/core/transform";
import { newImage, newRaster, newText, newVector, type Transform } from "../src/core/types";
import { rectContour } from "../src/core/vector";

const T = (x: number, y: number, rotation = 0, scale = 1, scaleY?: number): Transform => (scaleY === undefined ? { x, y, rotation, scale } : { x, y, rotation, scale, scaleY });
const close = (a: number[], b: number[]) => a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 6));

describe("non-uniform transform (scaleY)", () => {
  it("apply / invert round-trip with rotation and different x / y scales", () => {
    const t = T(10, 20, 30, 2, -0.5);
    for (const p of [[0, 0], [3, 7], [-5, 11]] as [number, number][]) close(invertTransform(t, applyTransform(t, p)), p);
    close(applyTransform(T(0, 0, 0, 2, 3), [1, 1]), [2, 3]);
  });
  it("omitted scaleY means uniform (older files unchanged)", () => {
    close(applyTransform(T(0, 0, 0, 2), [1, 1]), [2, 2]);
    expect(transformRect(T(5, 5, 0, 1, 1), { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 5, y: 5, w: 10, h: 10 });
    expect(transformRect(T(0, 0, 0, 1, 2), { x: 0, y: 0, w: 10, h: 10 })).toEqual({ x: 0, y: 0, w: 10, h: 20 });
  });
});

describe("handles", () => {
  const box: Box = { t: T(100, 100), lb: { x: 0, y: 0, w: 200, h: 100 } };
  it("8 handle positions follow the box", () => {
    expect(handlePoint(box, "nw")).toEqual([100, 100]);
    expect(handlePoint(box, "e")).toEqual([300, 150]);
    expect(handlePoint(box, "s")).toEqual([200, 200]);
  });
  it("handles follow a rotated box", () => {
    const r: Box = { t: T(0, 0, 90), lb: { x: 0, y: 0, w: 100, h: 50 } };
    close(handlePoint(r, "ne"), [0, 100]);
    close(boxCorners(r)[2], [-50, 100]);
    expect(pickHandle(r, [1, 99], 5)).toEqual({ kind: "handle", handle: "ne" });
  });
  it("corners beat edges, edges only on boxes big enough, rotate zone only outside", () => {
    expect(pickHandle(box, [302, 151], 6)).toEqual({ kind: "handle", handle: "e" });
    expect(pickHandle(box, [299, 99], 6)).toEqual({ kind: "handle", handle: "ne" });
    expect(pickHandle(box, [310, 90], 6)).toEqual({ kind: "rotate", corner: "ne" });
    expect(pickHandle(box, [290, 110], 6)).toBeNull(); // inside, off the handle → normal hit test
    const tiny: Box = { t: T(0, 0), lb: { x: 0, y: 0, w: 10, h: 10 } };
    expect(pickHandle(tiny, [5, 0], 4)).toBeNull(); // edge handles hidden on tiny boxes
    expect(pickHandle(box, [310, 90], 6, { rotate: false })).toBeNull();
  });
  it("resize cursors turn with the object", () => {
    expect(handleCursor("e", 0)).toBe("ew-resize");
    expect(handleCursor("e", 90)).toBe("ns-resize");
    expect(handleCursor("nw", 0)).toBe("nwse-resize");
    expect(handleCursor("ne", 0)).toBe("nesw-resize");
  });
});

describe("pointer priority — click a pixel to select and move stays first", () => {
  it("handle only on the handle itself", () => {
    expect(pointerTarget({ kind: "handle", handle: "se" }, "other", ["a"], false)).toBe("handle");
  });
  it("another object's pixel beats the rotate zone", () => {
    expect(pointerTarget({ kind: "rotate", corner: "ne" }, "b", ["a"], false)).toBe("object");
    expect(pointerTarget({ kind: "rotate", corner: "ne" }, null, ["a"], false)).toBe("rotate");
    expect(pointerTarget({ kind: "rotate", corner: "ne" }, "a", ["a"], false)).toBe("rotate");
  });
  it("pixel hit selects even inside the current selection box", () => {
    expect(pointerTarget(null, "b", ["a"], true)).toBe("object");
  });
  it("empty spot inside the box moves the selection, outside starts a marquee", () => {
    expect(pointerTarget(null, null, ["a"], true)).toBe("move-selection");
    expect(pointerTarget(null, null, ["a"], false)).toBe("marquee");
  });
});

describe("resize maths", () => {
  const box: Box = { t: T(100, 100), lb: { x: 0, y: 0, w: 200, h: 100 } };
  it("corner: both directions, opposite corner fixed", () => {
    const f = resizeFactors(box, "se", [500, 300]);
    expect([f.kx, f.ky]).toEqual([2, 2]);
    expect(f.anchor).toEqual([0, 0]);
    const t = scaledTransform(box.t, f.kx, f.ky, f.anchor);
    close(applyTransform(t, [0, 0]), [100, 100]);
    close(applyTransform(t, [200, 100]), [500, 300]);
  });
  it("edge: one direction; Alt: from the centre", () => {
    const f = resizeFactors(box, "w", [0, 999]);
    expect([f.kx, f.ky]).toEqual([1.5, 1]);
    expect(f.anchor).toEqual([200, 50]);
    const c = resizeFactors(box, "e", [350, 0], { fromCenter: true });
    expect(c.kx).toBeCloseTo(1.5);
    expect(c.anchor).toEqual([100, 50]);
  });
  it("keep ratio on corners uses the larger factor; dragging past the anchor flips", () => {
    const f = resizeFactors(box, "se", [500, 150], { keepRatio: true });
    expect([f.kx, f.ky]).toEqual([2, 2]);
    const g = resizeFactors(box, "e", [0, 0]);
    expect(g.kx).toBeCloseTo(-0.5);
  });
  it("works in the axes of a rotated object", () => {
    const r: Box = { t: T(0, 0, 90), lb: { x: 0, y: 0, w: 100, h: 50 } };
    // the local x axis points down the page: dragging "e" to y=200 doubles the width
    const f = resizeFactors(r, "e", [-25, 200]);
    expect(f.kx).toBeCloseTo(2);
    expect(f.ky).toBe(1);
  });
  it("proportions: images / raster / PDF keep them unless Shift, others the other way round", () => {
    expect(keepRatio([{ type: "RASTER" }], false)).toBe(true);
    expect(keepRatio([{ type: "IMAGE" }], true)).toBe(false);
    expect(keepRatio([{ type: "VECTOR" }], false)).toBe(false);
    expect(keepRatio([{ type: "VECTOR" }], true)).toBe(true);
    expect(keepRatio([{ type: "VECTOR" }, { type: "TEXT" }], false)).toBe(true);
  });
});

describe("resizeNode per kind", () => {
  it("image: width / height change, opposite corner stays", () => {
    const n = newImage("a", 100, 50);
    n.transform = T(10, 10);
    const box: Box = { t: n.transform, lb: localBounds(n) };
    resizeNode(n, resizeFactors(box, "nw", [-90, -40]));
    expect([n.width, n.height]).toEqual([200, 100]);
    expect(nodeBounds(n)).toEqual({ x: -90, y: -40, w: 200, h: 100 });
    expect(n.transform.scale).toBe(1);
  });
  it("raster layer: non-uniform scale with scaleY, bounds follow", () => {
    const n = newRaster();
    n.tiles["0_0"] = { hash: "h", data: new Uint8ClampedArray(4) };
    const box: Box = { t: n.transform, lb: localBounds(n) };
    resizeNode(n, resizeFactors(box, "s", [0, 512]));
    expect(n.transform.scale).toBe(1);
    expect(n.transform.scaleY).toBe(2);
    expect(nodeBounds(n)).toEqual({ x: 0, y: 0, w: 256, h: 512 });
  });
  it("text: handles change the box width; Ctrl+corner scales glyphs", () => {
    const n = newText("가나다", 200);
    const box: Box = { t: n.transform, lb: localBounds(n) };
    resizeNode(n, resizeFactors(box, "e", [300, 0]));
    expect(n.width).toBeCloseTo(300);
    expect(n.transform.scale).toBe(1);
    const m = newText("가나다", 200);
    resizeNode(m, resizeFactors({ t: m.transform, lb: localBounds(m) }, "se", [400, 999]), { textScale: true });
    expect(m.width).toBe(200);
    expect(m.transform.scale).toBeGreaterThan(1.9);
  });
  it("vector: transform scale (stroke follows), flips, multi-object scale and rotation", () => {
    const v = newVector([rectContour(0, 0, 100, 100)]);
    const before = nodeBounds(v);
    flipNode(v, localBounds(v), "h");
    expect(v.transform.scale).toBe(-1);
    expect(v.transform.scaleY).toBe(1);
    expect(nodeBounds(v)).toEqual(before); // mirrored in place
    const w = newVector([rectContour(0, 0, 10, 10)]);
    w.transform = T(100, 100);
    scaleNodeAbout(w, 2, [0, 0]);
    expect(w.transform).toMatchObject({ x: 200, y: 200, scale: 2 });
    const r = rotatedAbout(T(10, 0), [0, 0], 90);
    close([r.x, r.y, r.rotation], [0, 10, 90]);
  });
});

describe("PSD save path resamples non-uniform layers", () => {
  it("rasterPixels honours scaleY (not mistaken for a pure translation)", async () => {
    const { rasterPixels } = await import("../src/io/formats/psdWrite");
    const { makeTile } = await import("../src/core/loom");
    const { TILE } = await import("../src/core/types");
    const n = newRaster();
    const d = new Uint8ClampedArray(TILE * TILE * 4);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 20; x++) d.set([255, 0, 0, 255], (y * TILE + x) * 4);
    n.tiles["0_0"] = makeTile(d);
    const plain = rasterPixels(n)!;
    expect([plain.width, plain.height]).toEqual([20, 10]);
    n.transform = { x: 0, y: 0, rotation: 0, scale: 1, scaleY: 2 };
    const tall = rasterPixels(n)!;
    // bilinear resampling may add one soft edge row / column
    expect(Math.abs(tall.width - 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(tall.height - 20)).toBeLessThanOrEqual(1);
    n.transform = { x: 0, y: 0, rotation: 0, scale: -1, scaleY: 1 };
    const flipped = rasterPixels(n)!;
    expect(Math.abs(flipped.left + 20)).toBeLessThanOrEqual(1);
    expect(Math.abs(flipped.width - 20)).toBeLessThanOrEqual(1);
  });
});
