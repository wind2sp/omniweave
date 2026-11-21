// Path editing engine (core/pathEdit.ts): add / delete anchor points keeping the shape, handle symmetry and split,
// convert, bend a segment, Delete breaking paths, Ctrl+J and the curvature tool's handles.
import { describe, expect, it } from "vitest";
import {
  autoSmooth, bendSegment, cutAt, deleteAnchors, dragHandle, insertAnchorAt, joinEnds, nearestOnContour, pullHandles, removeAnchor, shapeDistance, snap45, toggleSmooth,
} from "../src/core/pathEdit";
import { cubicAt, corner, ellipseContour, rectContour, smooth } from "../src/core/vector";
import type { Contour, Vec2 } from "../src/core/types";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wave = (): Contour => ({ closed: false, nodes: [smooth(0, 0, -30, 30, 30, -30), smooth(100, 0, 70, 30, 130, -30), smooth(200, 0, 170, 30, 230, -30)] });

describe("add anchor point", () => {
  it("keeps the curve exactly (circle, wave, straight side)", () => {
    for (const c0 of [ellipseContour(100, 100, 80, 50), wave(), rectContour(0, 0, 120, 80)]) {
      for (const [seg, u] of [[0, 0.5], [1, 0.27]] as const) {
        const c = clone(c0);
        const i = insertAnchorAt(c, seg, u);
        expect(c.nodes.length).toBe(c0.nodes.length + 1);
        expect(shapeDistance(c0, c)).toBeLessThan(0.01);
        expect(shapeDistance(c, c0)).toBeLessThan(0.01);
        // the new point lies where the nearest-point search found it
        const a = c0.nodes[seg], b = c0.nodes[(seg + 1) % c0.nodes.length];
        expect(dist(c.nodes[i].anchor, cubicAt(a.anchor, a.handleOut, b.handleIn, b.anchor, u))).toBeLessThan(1e-9);
      }
    }
  });
  it("a point on a straight side stays a corner without handles", () => {
    const c = rectContour(0, 0, 100, 50);
    const hit = nearestOnContour(c, [40, -2])!;
    const i = insertAnchorAt(c, hit.seg, hit.u);
    expect(c.nodes[i].isCorner).toBe(true);
    expect(c.nodes[i].anchor[0]).toBeCloseTo(40, 2);
    expect(c.nodes[i].handleIn).toEqual(c.nodes[i].anchor);
  });
});

describe("delete anchor point", () => {
  it("added then deleted: the shape comes back within a hair", () => {
    const c0 = ellipseContour(100, 100, 80, 50);
    const c = clone(c0);
    const i = insertAnchorAt(c, 1, 0.4);
    removeAnchor(c, i);
    expect(c.nodes.length).toBe(4);
    expect(shapeDistance(c0, c)).toBeLessThan(0.05);
  });
  it("deleting a circle's point refits the two quarters into one curve close to them", () => {
    const c0 = ellipseContour(0, 0, 100, 100);
    const c = clone(c0);
    removeAnchor(c, 1);
    expect(c.nodes.length).toBe(3);
    // one cubic cannot be a half circle; Illustrator's result is within a few % of the radius
    expect(shapeDistance(c0, c)).toBeLessThan(100 * 0.12);
    // the neighbours keep their handle directions (they stay smooth)
    const n0 = c.nodes[0];
    expect(Math.abs((n0.handleOut[1] - n0.anchor[1]))).toBeLessThan(1e-9);
  });
  it("on a gentle curve the refit is within a pixel", () => {
    const c0: Contour = { closed: false, nodes: [smooth(0, 0, 0, 0, 40, -20), smooth(100, -25, 70, -25, 130, -25), smooth(200, 0, 160, -20, 200, 0)] };
    const c = clone(c0);
    removeAnchor(c, 1);
    expect(shapeDistance(c0, c)).toBeLessThan(1);
  });
  it("straight neighbours: the point just goes, the line stays straight", () => {
    const c: Contour = { closed: false, nodes: [corner(0, 0), corner(50, 0), corner(100, 0)] };
    removeAnchor(c, 1);
    expect(c.nodes.map((n) => n.anchor)).toEqual([[0, 0], [100, 0]]);
  });
  it("end point of an open path goes with its segment", () => {
    const c = wave();
    expect(removeAnchor(c, 0)).toBe(true);
    expect(c.nodes[0].anchor).toEqual([100, 0]);
  });
});

describe("direction handles", () => {
  it("smooth point: the opposite handle turns in line and keeps its length", () => {
    const a = smooth(0, 0, -20, 0, 50, 0);
    dragHandle(a, "out", [0, 30]);
    expect(a.handleOut).toEqual([0, 30]);
    expect(a.handleIn[0]).toBeCloseTo(0, 9);
    expect(a.handleIn[1]).toBeCloseTo(-20, 9);
    expect(a.isCorner).toBe(false);
  });
  it("Alt: only that handle moves and the point becomes a corner", () => {
    const a = smooth(0, 0, -20, 0, 50, 0);
    dragHandle(a, "out", [0, 30], true);
    expect(a.handleIn).toEqual([-20, 0]);
    expect(a.isCorner).toBe(true);
    // a corner's handles keep moving alone
    dragHandle(a, "in", [-10, -10]);
    expect(a.handleOut).toEqual([0, 30]);
  });
  it("pulling handles out of a corner makes them symmetric", () => {
    const a = corner(10, 10);
    pullHandles(a, [30, 20]);
    expect(a.handleIn).toEqual([-10, 0]);
    expect(a.isCorner).toBe(false);
  });
  it("convert: smooth → corner retracts, bare corner → smooth along the neighbours", () => {
    const c = ellipseContour(0, 0, 50, 50);
    toggleSmooth(c, 0);
    expect(c.nodes[0].isCorner).toBe(true);
    expect(c.nodes[0].handleOut).toEqual(c.nodes[0].anchor);
    toggleSmooth(c, 0);
    expect(c.nodes[0].isCorner).toBe(false);
    expect(c.nodes[0].handleOut[1]).toBeCloseTo(c.nodes[0].anchor[1], 9);
  });
  it("Shift: 45° steps", () => {
    const q = snap45([0, 0], [10, 9]);
    expect(q[0]).toBeCloseTo(q[1], 9);
  });
});

describe("bend a segment", () => {
  it("the curve goes through the pointer; smooth ends stay smooth", () => {
    const c = wave();
    const base = clone([c.nodes[0], c.nodes[1]] as const) as any;
    bendSegment(c, 0, base, 0.5, [50, 40]);
    const a = c.nodes[0], b = c.nodes[1];
    expect(dist(cubicAt(a.anchor, a.handleOut, b.handleIn, b.anchor, 0.5), [50, 40])).toBeLessThan(1e-6);
    const cross = (p: Vec2, q: Vec2, o: Vec2) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
    expect(Math.abs(cross(b.handleIn, b.handleOut, b.anchor))).toBeLessThan(1e-6);
  });
  it("a straight segment bends into a curve", () => {
    const c: Contour = { closed: false, nodes: [corner(0, 0), corner(90, 0)] };
    bendSegment(c, 0, clone([c.nodes[0], c.nodes[1]]) as any, 0.5, [45, 30]);
    expect(c.nodes[0].handleOut[1]).toBeGreaterThan(10);
  });
});

describe("Delete and Ctrl+J", () => {
  it("deleting a point of a closed path opens it there", () => {
    const out = deleteAnchors([rectContour(0, 0, 10, 10)], (_, ni) => ni === 1);
    expect(out.length).toBe(1);
    expect(out[0].closed).toBe(false);
    expect(out[0].nodes.map((n) => n.anchor)).toEqual([[10, 10], [0, 10], [0, 0]]);
  });
  it("deleting a middle point of an open path splits it in two", () => {
    const c: Contour = { closed: false, nodes: [corner(0, 0), corner(1, 0), corner(2, 0), corner(3, 0), corner(4, 0)] };
    const out = deleteAnchors([c], (_, ni) => ni === 2);
    expect(out.map((x) => x.nodes.length)).toEqual([2, 2]);
  });
  it("joins the ends of one path (close) and of two paths (merge)", () => {
    const open: Contour = { closed: false, nodes: [corner(0, 0), corner(10, 0), corner(10, 10)] };
    const r = joinEnds([clone(open)], { ci: 0, ni: 2 }, { ci: 0, ni: 0 })!;
    expect(r[0].closed).toBe(true);
    const other: Contour = { closed: false, nodes: [corner(20, 20), corner(30, 30)] };
    const m = joinEnds([clone(open), clone(other)], { ci: 0, ni: 2 }, { ci: 1, ni: 1 })!;
    expect(m.length).toBe(1);
    expect(m[0].nodes.map((n) => n.anchor)).toEqual([[0, 0], [10, 0], [10, 10], [30, 30], [20, 20]]);
    // a middle point is not an end
    expect(joinEnds([clone(open)], { ci: 0, ni: 1 }, { ci: 0, ni: 0 })).toBeNull();
  });
});

describe("cut path at points", () => {
  it("a closed path opens at the cut point (both ends there); an open one splits", () => {
    const out = cutAt([rectContour(0, 0, 10, 10)], (_, ni) => ni === 2);
    expect(out.length).toBe(1);
    expect(out[0].nodes[0].anchor).toEqual([10, 10]);
    expect(out[0].nodes[out[0].nodes.length - 1].anchor).toEqual([10, 10]);
    expect(out[0].nodes.length).toBe(5);
    const open: Contour = { closed: false, nodes: [corner(0, 0), corner(1, 0), corner(2, 0)] };
    expect(cutAt([open], (_, ni) => ni === 1).map((c) => c.nodes.length)).toEqual([2, 2]);
  });
});

describe("curvature tool", () => {
  it("smooth points through the clicks, with in-line handles", () => {
    const nodes = [smooth(0, 0, 0, 0, 0, 0), smooth(50, -40, 0, 0, 0, 0), smooth(100, 0, 0, 0, 0, 0)];
    nodes.forEach((n) => (n.handleIn = n.handleOut = [...n.anchor] as Vec2));
    autoSmooth(nodes, false);
    const m = nodes[1];
    expect(m.handleIn[1]).toBeCloseTo(-40, 9);
    expect(m.handleOut[1]).toBeCloseTo(-40, 9);
    expect(m.handleOut[0]).toBeGreaterThan(50);
  });
});

describe("compound paths (a hole) and the closing segment", () => {
  const donut = (): Contour[] => [ellipseContour(0, 0, 100, 100), ellipseContour(0, 0, 40, 40)];
  it("adding a point on the closing segment keeps the shape and appends the point", () => {
    const c0 = ellipseContour(0, 0, 100, 60);
    const c = clone(c0);
    const i = insertAnchorAt(c, c0.nodes.length - 1, 0.5);
    expect(i).toBe(c0.nodes.length);
    expect(shapeDistance(c0, c)).toBeLessThan(0.01);
    expect(shapeDistance(c, c0)).toBeLessThan(0.01);
  });
  it("Delete / cut on the hole leave the outer contour as it was", () => {
    const cs = donut();
    const del = deleteAnchors(clone(cs), (ci, ni) => ci === 1 && ni === 2);
    expect(del.length).toBe(2);
    expect(del[0]).toEqual(cs[0]);
    expect(del[1].closed).toBe(false);
    expect(del[1].nodes.length).toBe(3);
    const cut = cutAt(clone(cs), (ci, ni) => ci === 1 && ni === 0);
    expect(cut[0]).toEqual(cs[0]);
    expect(cut[1].nodes.length).toBe(5);
    expect(shapeDistance(cs[1], cut[1])).toBeLessThan(1e-9);
  });
  it("Ctrl+J on two end points of different contours of one path makes one contour", () => {
    const cs: Contour[] = [
      { closed: false, nodes: [corner(0, 0), corner(10, 0)] },
      { closed: false, nodes: [corner(20, 0), corner(30, 0)] },
      ellipseContour(0, 50, 5, 5),
    ];
    const r = joinEnds(clone(cs), { ci: 0, ni: 1 }, { ci: 1, ni: 0 })!;
    expect(r.length).toBe(2);
    expect(r[0].nodes.map((a) => a.anchor[0])).toEqual([0, 10, 20, 30]);
    expect(r[1]).toEqual(cs[2]);
  });
});
