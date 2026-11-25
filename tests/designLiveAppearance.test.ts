// 2026-11-24, features-ps-ai.md (Illustrator, design 2): live corners, stroke align / width profile and live effects
// (Round Corners, Offset Path, Transform) drawn from the node's own path; nodes without them draw as before.
import { describe, expect, it } from "vitest";
import { isLive, liveBounds, liveParts, maxCornerRadius, profileAt, roundCorners, roundableCorners } from "../src/core/liveVector";
import { newVector, type VectorNode } from "../src/core/types";
import { rectContour, vectorLocalBounds } from "../src/core/vector";

function rect(w = 100, h = 60): VectorNode {
  const v = newVector([rectContour(0, 0, w, h)], "omni-rect");
  v.fill = "#ff0000";
  v.stroke = "#000000";
  v.strokeWidth = 4;
  return v;
}

describe("live appearance", () => {
  it("a plain path is not live and keeps its bounds", () => {
    const v = rect();
    expect(isLive(v)).toBe(false);
    expect(liveParts(v)).toBeNull();
    expect(vectorLocalBounds(v).w).toBeCloseTo(100 + 2 * 3);
  });

  it("live corners round every right angle with the radius, kept to half a side", () => {
    const c = roundCorners(rectContour(0, 0, 100, 60), 10);
    expect(c.nodes.length).toBe(8);
    expect(c.nodes[0].anchor[0]).toBeCloseTo(0);
    expect(c.nodes[0].anchor[1]).toBeCloseTo(10);
    expect(c.nodes[1].anchor[0]).toBeCloseTo(10);
    const big = roundCorners(rectContour(0, 0, 100, 60), 500);
    // the short side is used up from both ends
    expect(big.nodes[0].anchor[1]).toBeCloseTo(30);
    expect(roundableCorners(rectContour(0, 0, 10, 10))).toEqual([0, 1, 2, 3]);
    expect(maxCornerRadius([rectContour(0, 0, 100, 60)])).toBeCloseTo(30);
  });

  it("corners one by one (cornerRadii) and corners between curved sides", () => {
    const v = rect();
    v.cornerRadii = [[20, null, null, null]];
    const p = liveParts(v)!;
    // only the first corner is rounded: 4 + 1 anchors
    expect(p[0].contours[0].nodes.length).toBe(5);
    // a half-disc "D": a straight side and a curved one meet in two sharp corners, both rounded
    const d = newVector([{ closed: true, nodes: [
      { anchor: [0, 0], handleIn: [0, 0], handleOut: [55, 0], isCorner: true },
      { anchor: [0, 100], handleIn: [55, 100], handleOut: [0, 100], isCorner: true },
    ] }], "omni-d");
    expect(roundableCorners(d.contours[0])).toEqual([0, 1]);
    d.cornerRadius = 10;
    const q = liveParts(d)![0].contours[0].nodes;
    expect(q.length).toBe(4);
    // the fillet's ends lie on the sides: one on the straight side (x = 0), one on the curve (y > 0 near the top)
    expect(q[0].anchor[0]).toBeCloseTo(0, 3);
    expect(q[0].anchor[1]).toBeGreaterThan(5);
    expect(q[1].anchor[0]).toBeGreaterThan(5);
  });

  it("cornerRadius makes the node live: one part with the rounded path, same paint", () => {
    const v = rect();
    v.cornerRadius = 12;
    const p = liveParts(v)!;
    expect(p.length).toBe(1);
    expect(p[0].contours[0].nodes.length).toBe(8);
    expect(p[0].fill).toBe("#ff0000");
    expect(p[0].cornerRadius).toBeUndefined();
  });

  it("an outside stroke is a filled ring outside the fill; inside stays within", () => {
    const v = rect();
    v.strokeAlign = "outside";
    v.strokeJoin = "miter";
    const p = liveParts(v)!;
    expect(p.length).toBe(2);
    expect(p[0].stroke).toBeNull();
    expect(p[1].fill).toBe("#000000");
    const b = liveBounds(v)!;
    // grown by the whole stroke width (4), mitred corners stay square
    expect(b.x).toBeLessThan(-3.5);
    const q = liveParts({ ...v, strokeAlign: "inside" })!;
    const xs = q[1].contours.flatMap((c) => c.nodes.map((a) => a.anchor[0]));
    expect(Math.min(...xs)).toBeGreaterThan(-1e-6);
    expect(Math.max(...xs)).toBeLessThan(100 + 1e-6);
  });

  it("a thick outside stroke with round joins (the browser check's 24 px case) draws, never throws", () => {
    const v = { ...rect(400, 300), strokeWidth: 24, strokeAlign: "outside" as const };
    const p = liveParts(v)!;
    expect(p.length).toBe(2);
    expect(liveBounds(v)!.x).toBeLessThan(-20);
  });

  it("a width profile becomes a filled outline thinner at the tapered end", () => {
    const v = newVector([{ closed: false, nodes: [{ anchor: [0, 0], handleIn: [0, 0], handleOut: [0, 0], isCorner: true }, { anchor: [200, 0], handleIn: [200, 0], handleOut: [200, 0], isCorner: true }] }], "omni-line");
    v.fill = null;
    v.stroke = "#000000";
    v.strokeWidth = 20;
    v.widthProfile = "taperEnd";
    const p = liveParts(v)!;
    expect(p.length).toBe(1);
    expect(p[0].fill).toBe("#000000");
    const pts = p[0].contours.flatMap((c) => c.nodes.map((a) => a.anchor));
    const near = (x: number) => Math.max(...pts.filter((q) => Math.abs(q[0] - x) < 12).map((q) => Math.abs(q[1])));
    expect(near(0)).toBeGreaterThan(8);
    expect(near(200)).toBeLessThan(3);
    expect(profileAt("lens", 0.5)).toBeCloseTo(1);
  });

  it("effects: offset grows the area, transform adds copies, an effect turned off does nothing", () => {
    const v = rect();
    v.stroke = null;
    v.vfx = [{ kind: "offset", on: true, d: 10, join: "miter" }];
    const b = liveBounds(v)!;
    expect(b.x).toBeCloseTo(-11, 0);
    expect(b.w).toBeCloseTo(122, 0);
    // (parts are cached per node object: every edit is a new node, as in the app)
    const w: VectorNode = { ...v, vfx: [{ kind: "transform", on: true, sx: 100, sy: 100, dx: 50, dy: 0, angle: 0, copies: 2 }] };
    expect(liveParts(w)!.length).toBe(3);
    expect(liveBounds(w)!.w).toBeCloseTo(200 + 2, 0);
    expect(isLive({ ...v, vfx: [{ kind: "roundCorners", on: false, r: 10 }] })).toBe(false);
  });
});
