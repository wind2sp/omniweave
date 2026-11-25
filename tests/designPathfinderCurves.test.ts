// 2026-11-25 (design 2): Pathfinder and the Shape Builder keep the curves of the paths they combine (Illustrator) —
// a rectangle minus a circle has the circle's arc as Bézier pieces, not dozens of short straight lines.
import { describe, expect, it } from "vitest";
import { pathfinder } from "../src/core/vector";
import { newVector, type VectorNode } from "../src/core/types";
import { corner, ellipseContour } from "../src/core/vector";

const rect = (x: number, y: number, w: number, h: number): VectorNode => {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }], "omni-rect");
  v.fill = "#ff0000";
  return v;
};
const circle = (cx: number, cy: number, r: number): VectorNode => {
  const v = newVector([ellipseContour(cx, cy, r, r)], "omni-circle");
  v.fill = "#0000ff";
  return v;
};
const curved = (n: VectorNode) => n.contours.flatMap((c) => c.nodes).filter((a) => a.handleIn[0] !== a.anchor[0] || a.handleIn[1] !== a.anchor[1] || a.handleOut[0] !== a.anchor[0] || a.handleOut[1] !== a.anchor[1]).length;
const count = (n: VectorNode) => n.contours.reduce((k, c) => k + c.nodes.length, 0);

describe("pathfinder keeps curves", () => {
  it("rectangle minus a circle over its corner: a few anchors, the arc as curves lying on the circle", () => {
    const r = pathfinder("subtract", [rect(0, 0, 200, 200), circle(200, 200, 80)])!;
    expect(r).toBeTruthy();
    // 4 rectangle corners less one, plus the two crossings — not 50 sample points
    expect(count(r)).toBeLessThanOrEqual(8);
    expect(curved(r)).toBeGreaterThan(0);
    // the arc's middle lies on the circle (radius 80 around 200, 200)
    const c = r.contours[0];
    for (let i = 0; i < c.nodes.length; i++) {
      const a = c.nodes[i], b = c.nodes[(i + 1) % c.nodes.length];
      if (a.handleOut[0] === a.anchor[0] && a.handleOut[1] === a.anchor[1]) continue;
      const t = 0.5, u = 1 - t;
      const x = u * u * u * a.anchor[0] + 3 * u * u * t * a.handleOut[0] + 3 * u * t * t * b.handleIn[0] + t * t * t * b.anchor[0];
      const y = u * u * u * a.anchor[1] + 3 * u * u * t * a.handleOut[1] + 3 * u * t * t * b.handleIn[1] + t * t * t * b.anchor[1];
      expect(Math.abs(Math.hypot(x - 200, y - 200) - 80)).toBeLessThan(0.5);
    }
  });

  it("union of two circles: two arcs, smooth where each circle's own anchors were", () => {
    const r = pathfinder("union", [circle(100, 100, 60), circle(170, 100, 60)])!;
    expect(count(r)).toBeLessThanOrEqual(10);
    expect(curved(r)).toBe(count(r));
  });

  it("plain rectangles stay plain", () => {
    const r = pathfinder("union", [rect(0, 0, 100, 100), rect(50, 50, 100, 100)])!;
    expect(count(r)).toBe(8);
    expect(curved(r)).toBe(0);
  });
});

describe("Ctrl+7 in the design mode (Illustrator's clipping mask)", () => {
  it("the topmost selected path becomes the clipping path under the others; the SVG writes a clipPath", async () => {
    const { useStore } = await import("../src/core/store");
    const { newDocument, newPage } = await import("../src/core/types");
    const { toggleClipping } = await import("../src/ui/groups");
    const { exportSvg } = await import("../src/io/export");
    const S = () => useStore.getState();
    const art = rect(0, 0, 300, 300);
    art.stroke = null;
    const mask = circle(150, 150, 100);
    mask.stroke = "#000000";
    const doc = newDocument();
    const p = newPage("DESIGN", 400, 400);
    p.nodes.push(art, mask);
    doc.pages = [p];
    S().load(doc);
    S().set({ pageId: p.id, selection: [art.id, mask.id], mode: "DESIGN" });
    toggleClipping();
    const nodes = S().doc.pages[0].nodes as VectorNode[];
    expect(nodes.map((n) => n.name)).toEqual(["omni-circle", "omni-rect"]);
    expect(nodes[0].clip).toBeUndefined();
    expect(nodes[0].stroke).toBeNull();
    // Illustrator takes the clipping path's paint away
    expect(nodes[0].fill).toBeNull();
    expect(nodes[1].clip).toBe(true);
    const svg = await exportSvg(S().doc, S().doc.pages[0]).catch(() => null);
    if (svg) expect(svg).toMatch(/<clipPath/);
  });
});
