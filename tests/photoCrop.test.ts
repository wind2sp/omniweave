// The phone photo screen's crop frame (ui/mobile/photoCrop.tsx): ratios centred, corners dragged with the ratio kept,
// the frame kept inside the picture.
import { describe, expect, it } from "vitest";
import { dragRect, fitRatio } from "../src/ui/mobile/photoCrop";

describe("phone photo crop frame", () => {
  it("a ratio gives the largest frame of that ratio, centred", () => {
    expect(fitRatio(400, 300, 1)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
    expect(fitRatio(400, 300, 16 / 9)).toEqual({ x: 0, y: 38, w: 400, h: 225 });
  });
  it("a corner drag keeps the ratio and the opposite corner; the frame stays in the picture", () => {
    const s = { x: 50, y: 0, w: 300, h: 300 };
    const a = dragRect(s, 2, -100, -40, 400, 300, 1);
    expect(a).toEqual({ x: 50, y: 0, w: 200, h: 200 });
    const b = dragRect(s, 0, 30, 30, 400, 300, null);
    expect(b).toEqual({ x: 80, y: 30, w: 270, h: 270 });
    // past the edge: clamped
    expect(dragRect(s, 2, 500, 500, 400, 300, 1)).toEqual({ x: 50, y: 0, w: 300, h: 300 });
  });
  it("the whole frame moves and stops at the picture's edges", () => {
    expect(dragRect({ x: 50, y: 50, w: 100, h: 100 }, -1, 500, -500, 400, 300, null)).toEqual({ x: 300, y: 0, w: 100, h: 100 });
  });
});
