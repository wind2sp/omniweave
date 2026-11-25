// 2026-11-24, features-ps-ai.md (Illustrator): the rounded rectangle, polygon and star tools under the rectangle —
// corner radius 12 pt, 6 sides, 5 points with the inner radius half the outer, ↑ ↓ while drawing change them.
import { describe, expect, it } from "vitest";
import { drawnShape, polygonContour, roundRectContour, useShapeParams } from "../src/ui/drawDefaults";
import { liveParts } from "../src/core/liveVector";
import { PROFILES } from "../src/ui/editModes";
import { TOOL_GROUPS } from "../src/ui/shell/ToolGroup";

const look = { fill: "#ffffff", stroke: "#000000", strokeNone: false, strokeWidth: 1 };

describe("Illustrator shape tools", () => {
  it("the design mode offers them in the rectangle's group", () => {
    for (const t of ["roundRect", "polygon", "star"] as const) {
      expect(PROFILES.DESIGN.tools).toContain(t);
      expect(TOOL_GROUPS.shape.some((i) => i.tool === t)).toBe(true);
    }
  });

  it("a rounded rectangle has 8 smooth anchors; the radius is kept to half the shorter side", () => {
    const c = roundRectContour(100, 40, 16);
    expect(c.nodes.length).toBe(8);
    expect(c.nodes[0].anchor).toEqual([16, 0]);
    expect(c.nodes[2].anchor).toEqual([100, 16]);
    const tight = roundRectContour(100, 40, 999);
    expect(tight.nodes[0].anchor).toEqual([20, 0]);
    expect(roundRectContour(100, 40, 0).nodes.length).toBe(4);
  });

  it("a polygon's corners sit on its circle, the first straight up; a star alternates outer and inner radius", () => {
    const p = polygonContour(50, 6, false);
    expect(p.nodes.length).toBe(6);
    expect(p.nodes[0].anchor[0]).toBeCloseTo(50);
    expect(p.nodes[0].anchor[1]).toBeCloseTo(0);
    for (const n of p.nodes) expect(Math.hypot(n.anchor[0] - 50, n.anchor[1] - 50)).toBeCloseTo(50);
    const s = polygonContour(50, 5, true, 0.5);
    expect(s.nodes.length).toBe(10);
    expect(Math.hypot(s.nodes[1].anchor[0] - 50, s.nodes[1].anchor[1] - 50)).toBeCloseTo(25);
  });

  it("drawn shapes take the tool options and the new-shape look", () => {
    useShapeParams.getState().set({ sides: 8, points: 7 });
    const poly = drawnShape("polygon", { x: 10, y: 20, w: 100, h: 100 }, look);
    expect(poly.contours[0].nodes.length).toBe(8);
    expect(poly.transform.x).toBe(10);
    expect(poly.fill).toBe("#ffffff");
    expect(poly.stroke).toBe("#000000");
    expect(drawnShape("star", { x: 0, y: 0, w: 100, h: 100 }, look).contours[0].nodes.length).toBe(14);
    // the rounded rectangle is a rectangle with live corners (design 2): four anchors, the radius drawn as fillets
    const rr = drawnShape("roundRect", { x: 0, y: 0, w: 100, h: 60 }, look);
    expect(rr.contours[0].nodes.length).toBe(4);
    expect(rr.cornerRadius).toBeGreaterThan(0);
    expect(liveParts(rr)![0].contours[0].nodes.length).toBe(8);
  });
});

describe("Illustrator R / O / S tools", () => {
  it("R, O and S pick the rotate, reflect and scale tools in the design mode", () => {
    expect(PROFILES.DESIGN.keys.r).toBe("rotateTool");
    expect(PROFILES.DESIGN.keys.o).toBe("reflectTool");
    expect(PROFILES.DESIGN.keys.s).toBe("scaleTool");
    for (const t of ["rotateTool", "reflectTool", "scaleTool"] as const) expect(PROFILES.DESIGN.tools).toContain(t);
  });

  it("a transform about a reference point (the tool's click / Alt+click) keeps that point fixed", async () => {
    const { useStore } = await import("../src/core/store");
    const { newDocument, newPage } = await import("../src/core/types");
    const { transformSelection } = await import("../src/ui/designPathOps");
    const S = () => useStore.getState();
    const doc = newDocument();
    const p = newPage("DESIGN", 800, 600, "아트보드 1");
    const v = drawnShape("rect", { x: 100, y: 100, w: 100, h: 50 }, look);
    p.nodes.push(v);
    doc.pages = [p];
    S().load(doc);
    S().set({ pageId: p.id, selection: [v.id], mode: "DESIGN" });
    // 90° counter-clockwise about the rectangle's top-left corner (100, 100)
    transformSelection("rotate", { angle: 90, origin: [100, 100] });
    const pts = () => {
      const n = S().doc.pages[0].nodes[0] as typeof v;
      return n.contours[0].nodes.map((a) => [Math.round(a.anchor[0] + n.transform.x), Math.round(a.anchor[1] + n.transform.y)]);
    };
    expect(pts()).toContainEqual([100, 100]);
    expect(pts()).toContainEqual([100, 0]);
    expect(pts()).toContainEqual([150, 0]);
    // scale 200 % about (100, 100) with a copy: the original stays, the copy doubles away from the point
    transformSelection("scale", { sx: 200, sy: 200, origin: [100, 100] }, true);
    expect(S().doc.pages[0].nodes.length).toBe(2);
    const c = S().doc.pages[0].nodes[1] as typeof v;
    expect(c.contours[0].nodes.map((a) => [Math.round(a.anchor[0] + c.transform.x), Math.round(a.anchor[1] + c.transform.y)])).toContainEqual([100, -100]);
  });
});
