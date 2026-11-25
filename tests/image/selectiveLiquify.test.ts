// 선택 색상 (Selective Color) and 픽셀 유동화 (Liquify) of the image mode (2026-11-25).
import { describe, expect, it } from "vitest";
import * as A from "../../src/core/image/adjust";
import { applyOps } from "../../src/core/image/ops";
import { fieldIsEmpty, liquifyImg, newField, pushField, restoreField } from "../../src/core/image/liquify";
import { canvas, fillRect, px } from "./helpers";

describe("selective colour", () => {
  it("each range takes its own colours: reds from red, nothing from grey; whites / blacks / neutrals by lightness", () => {
    expect(A.selectiveAmount(0, 255, 0, 0)).toBe(1);
    expect(A.selectiveAmount(0, 128, 128, 128)).toBe(0);
    expect(A.selectiveAmount(1, 255, 255, 0)).toBe(1); // yellow: blue is the smallest
    expect(A.selectiveAmount(6, 255, 255, 255)).toBe(1);
    expect(A.selectiveAmount(8, 0, 0, 0)).toBe(1);
    expect(A.selectiveAmount(7, 128, 128, 128)).toBeGreaterThan(0.99);
  });
  it("absolute cyan +100 on reds empties the red channel of pure red; grey and alpha stay", () => {
    const img = canvas(2, 1, [128, 128, 128], 200);
    fillRect(img, 0, 0, 1, 1, [255, 0, 0], 200);
    const out = A.selectiveColor(img, { range: 0, c: 100, m: 0, y: 0, k: 0, absolute: 1 });
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 200]);
    expect(px(out, 1, 0)).toEqual([128, 128, 128, 200]);
  });
  it("relative: a share of the ink already there (none on a white pixel); the registry op runs it", () => {
    const img = canvas(1, 1, [255, 255, 255]);
    expect(px(A.selectiveColor(img, { range: 6, c: 0, m: 0, y: 0, k: 100, absolute: 0 }), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(A.selectiveColor(img, { range: 6, c: 0, m: 0, y: 0, k: 50, absolute: 1 }), 0, 0)[0]).toBeLessThan(140);
    const red = canvas(1, 1, [255, 0, 0]);
    expect(px(applyOps(red, [{ op: "selectiveColor", params: { range: 0, c: 100, m: 0, y: 0, k: 0, absolute: 1 } }]), 0, 0)[0]).toBe(0);
  });
});

describe("liquify", () => {
  it("a forward push moves the colour under the brush the way it is dragged; restore brings it back", () => {
    const img = canvas(40, 20, [128, 128, 128]);
    fillRect(img, 0, 0, 20, 20, [255, 0, 0]);
    const f = newField(40, 20);
    expect(fieldIsEmpty(f)).toBe(true);
    for (let x = 14; x < 26; x += 2) pushField(f, x, 10, 2, 0, 8, 1);
    const out = liquifyImg(img, f);
    expect(px(out, 23, 10)[0]).toBeGreaterThan(200); // red pushed over the edge at x = 20
    expect(px(out, 23, 0)).toEqual([128, 128, 128, 255]); // outside the brush: as it was
    for (let i = 0; i < 40; i++) restoreField(f, 20, 10, 12, 0.5);
    expect(px(liquifyImg(img, f), 23, 10)).toEqual([128, 128, 128, 255]);
  });
  it("a field made on a small preview applies to the full picture at the same places", () => {
    const img = canvas(80, 40, [128, 128, 128]);
    fillRect(img, 0, 0, 40, 40, [255, 0, 0]);
    const f = newField(40, 20);
    for (let x = 14; x < 26; x += 2) pushField(f, x, 10, 2, 0, 8, 1);
    expect(px(liquifyImg(img, f), 46, 20)[0]).toBeGreaterThan(200);
  });
});
