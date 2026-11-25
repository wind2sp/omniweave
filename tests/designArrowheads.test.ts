// 2026-11-24, features-ps-ai.md (Illustrator Stroke panel): arrowheads at an open path's ends (start / end / scale),
// drawn as filled shapes in the stroke colour on screen and in every save; closed paths get none.
import { describe, expect, it } from "vitest";
import { arrowContours, arrowNode } from "../src/core/arrowheads";
import { newVector, type VectorNode } from "../src/core/types";
import { corner } from "../src/core/vector";

function line(): VectorNode {
  const v = newVector([{ closed: false, nodes: [corner(0, 0), corner(100, 0)] }], "omni-line");
  v.fill = null;
  v.stroke = "#000000";
  v.strokeWidth = 2;
  return v;
}

describe("arrowheads", () => {
  it("none without a setting, a stroke, or an open end", () => {
    const v = line();
    expect(arrowContours(v)).toEqual([]);
    v.strokeArrows = { end: "triangle" };
    v.stroke = null;
    expect(arrowContours(v)).toEqual([]);
    v.stroke = "#000000";
    v.contours[0].closed = true;
    expect(arrowContours(v)).toEqual([]);
  });

  it("the end's triangle points out of the path, its tip beyond the end; the start's the other way", () => {
    const v = line();
    v.strokeArrows = { start: "triangle", end: "triangle" };
    const [s, e] = arrowContours(v);
    expect(e.nodes[0].anchor[0]).toBeCloseTo(109); // 100 + 4.5 × 2
    expect(e.nodes[0].anchor[1]).toBeCloseTo(0);
    expect(s.nodes[0].anchor[0]).toBeCloseTo(-9);
    expect(e.closed).toBe(true);
  });

  it("the scale grows the head; the head node is filled in the stroke colour with no stroke", () => {
    const v = line();
    v.strokeArrows = { end: "bar", scale: 200 };
    const [bar] = arrowContours(v);
    const ys = bar.nodes.map((n) => n.anchor[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(24); // 6 × 2 px × 200 %
    const h = arrowNode(v)!;
    expect(h.fill).toBe("#000000");
    expect(h.stroke).toBeNull();
    expect(h.contours.length).toBe(1);
  });
});
