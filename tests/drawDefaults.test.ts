// UNIFIED_STYLES.md appendix B5: new rectangles, ellipses and pen paths take the ribbon's "new shape" fill and stroke;
// rectangles and ellipses start with the stroke set to none.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { drawnPenPath, drawnShape, useShapeStroke } from "../src/ui/drawDefaults";
import { PT, darker, modeShapeDefaults } from "../src/ui/drawDefaults";

describe("drawn shapes use the ribbon's new-shape defaults (B5)", () => {
  const defaults = { fill: "#123456", stroke: "#AB0000", strokeNone: false };

  it("rectangles and ellipses get the ribbon fill and stroke colour", () => {
    for (const kind of ["rect", "ellipse"] as const) {
      const v = drawnShape(kind, { x: 10, y: 20, w: 100, h: 50 }, defaults);
      expect(v).toMatchObject({ fill: "#123456", stroke: "#AB0000", transform: { x: 10, y: 20, rotation: 0, scale: 1 } });
      expect(v.strokeWidth).toBe(useShapeStroke.getState().width);
    }
  });

  it("pen paths share the same stroke colour and width default as the shape tools", () => {
    const pts = [{ p: [0, 0] as [number, number] }, { p: [10, 10] as [number, number] }] as any;
    const open = drawnPenPath(pts, false, defaults);
    const closed = drawnPenPath(pts, true, defaults);
    expect(open).toMatchObject({ fill: null, stroke: "#AB0000" });
    expect(closed).toMatchObject({ fill: "#123456", stroke: "#AB0000" });
    expect(open.strokeWidth).toBe(drawnShape("rect", { x: 0, y: 0, w: 1, h: 1 }, defaults).strokeWidth);
  });

  it("with the ribbon stroke set to none, rectangles and ellipses get no stroke but pen paths keep theirs", () => {
    const none = { ...defaults, strokeNone: true };
    expect(drawnShape("rect", { x: 0, y: 0, w: 1, h: 1 }, none).stroke).toBeNull();
    expect(drawnShape("ellipse", { x: 0, y: 0, w: 1, h: 1 }, none).stroke).toBeNull();
    const pts = [{ p: [0, 0] as [number, number] }, { p: [10, 10] as [number, number] }] as any;
    expect(drawnPenPath(pts, false, none).stroke).toBe("#AB0000");
    expect(drawnPenPath(pts, true, none).stroke).toBe("#AB0000");
  });

  it("new rectangles start with no stroke until the ribbon stroke gets a colour (Photoshop / Figma)", () => {
    expect(useShapeStroke.getState().none).toBe(true);
    const s = useStore.getState();
    expect(drawnShape("rect", { x: 0, y: 0, w: 1, h: 1 }, s).stroke).toBeNull();
    useShapeStroke.getState().setNone(false);
    try {
      expect(drawnShape("rect", { x: 0, y: 0, w: 1, h: 1 }, s).stroke).toBe(s.stroke);
    } finally {
      useShapeStroke.getState().setNone(true);
    }
  });

  it("each edit mode starts as its program does: Illustrator 1 pt black / white, PowerPoint accent + darker outline, Photoshop foreground", () => {
    expect(modeShapeDefaults("DESIGN")).toEqual({ fill: "#ffffff", stroke: "#000000", none: false, width: PT, penFill: false });
    const slide = modeShapeDefaults("SLIDE");
    expect(slide.fill).toBe("#4472c4");
    expect(slide.stroke).toBe(darker("#4472c4"));
    expect(slide.width).toBeCloseTo(4 / 3, 9);
    expect(modeShapeDefaults("IMAGE", "#ff0000")).toMatchObject({ fill: "#ff0000", none: true, width: 1 });
    // nothing starts in the old dull blue / grey
    for (const m of ["DESIGN", "SLIDE", "IMAGE", "DOCUMENT"] as const) expect(modeShapeDefaults(m).fill).not.toBe("#4f7cff");
  });

  it("the store holds the defaults the ribbon edits", () => {
    const s = useStore.getState();
    expect(typeof s.fill).toBe("string");
    expect(typeof s.stroke).toBe("string");
  });
});
