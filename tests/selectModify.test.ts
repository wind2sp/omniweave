// 선택 › 색상 범위 · 수정(확대 · 축소 · 페더 · 테두리) of the image mode (2026-11-23: the 선택 menu had only 전체 ·
// 해제 · 반전, and those picked layers, not pixels).
import { describe, expect, it } from "vitest";
import { borderMask, colorRangeMask, contractMask, expandMask, featherMask, maskBounds, rectMask } from "../src/core/image/pixelSelection";
import { command } from "../src/ui/commands";
import { IMAGE_MENUS } from "../src/ui/menus";

describe("선택 › 수정", () => {
  const sq = () => rectMask(100, 100, 30, 30, 70, 70);
  it("확대 grows by r with round corners, 축소 shrinks by r", () => {
    const e = expandMask(sq(), 5);
    expect(maskBounds(e)).toEqual({ x: 25, y: 25, w: 50, h: 50 });
    // a corner pixel 5 px out diagonally (distance 7) is not taken: round corners
    expect(e.data[25 * 100 + 25]).toBe(0);
    expect(maskBounds(contractMask(sq(), 5))).toEqual({ x: 35, y: 35, w: 30, h: 30 });
    expect(maskBounds(contractMask(expandMask(sq(), 5), 5))).toEqual({ x: 30, y: 30, w: 40, h: 40 });
  });
  it("페더 makes a soft edge, the middle stays selected", () => {
    const f = featherMask(sq(), 8);
    expect(f.data[50 * 100 + 50]).toBe(255);
    expect(f.data[50 * 100 + 30]).toBeGreaterThan(60);
    expect(f.data[50 * 100 + 30]).toBeLessThan(200);
    expect(f.data[2 * 100 + 2]).toBe(0);
  });
  it("테두리 is a band along the edge", () => {
    const b = borderMask(sq(), 6);
    expect(b.data[50 * 100 + 50]).toBe(0);
    expect(b.data[50 * 100 + 30]).toBe(255);
    expect(b.data[50 * 100 + 10]).toBe(0);
  });
  it("색상 범위 takes the colour (fully near it, fading with the fuzziness), not transparent pixels", () => {
    const w = 3, h = 1;
    const px = new Uint8ClampedArray([200, 30, 30, 255, 200, 60, 30, 255, 200, 30, 30, 0]);
    const m = colorRangeMask(px, w, h, [200, 30, 30], 40);
    expect(Array.from(m.data)).toEqual([255, Math.round((255 * 10) / 20), 0]);
  });
  it("the image mode's 선택 menu has the pixel commands, 수정 and 색상 범위", () => {
    const sel = IMAGE_MENUS.find((m) => m.id === "select")!.entries;
    const flat = JSON.stringify(sel);
    for (const id of ["select.allPixels", "select.deselectPixels", "select.reselect", "select.inversePixels", "select.colorRange", "select.expand", "select.contract", "select.feather", "select.border"]) {
      expect(flat).toContain(id);
      expect(command(id), id).toBeTruthy();
    }
  });
});
