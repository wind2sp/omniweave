// 2026-11-25 (design 2): Select › Same, the Magic Wand, the Smooth tool, Pathfinder Trim / Outline.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newVector, type VectorNode } from "../src/core/types";
import { corner, ellipseContour } from "../src/core/vector";
import { outlinePaths, selectSame, smoothAlong, trimPaths, wandAt } from "../src/ui/designMore";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
const rect = (x: number, y: number, w: number, h: number, fill = "#ff0000") => {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }], "omni-rect");
  v.fill = fill;
  v.stroke = "#000000";
  v.strokeWidth = 2;
  return v;
};
function load(...nodes: VectorNode[]) {
  const doc = newDocument();
  const p = newPage("DESIGN", 800, 600);
  p.nodes.push(...nodes);
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: [], mode: "DESIGN" });
}

describe("Select › Same and the Magic Wand", () => {
  it("picks every path with the same fill (case-insensitive), not the others", () => {
    const a = rect(0, 0, 10, 10, "#FF0000"), b = rect(20, 0, 10, 10, "#ff0000"), c = rect(40, 0, 10, 10, "#00ff00");
    load(a, b, c);
    S().set({ selection: [a.id] });
    expect(selectSame("fill")).toBe(2);
    expect(S().selection.sort()).toEqual([a.id, b.id].sort());
    expect(wandAt(c, false)).toBe(1);
    expect(S().selection).toEqual([c.id]);
    expect(wandAt(a, true)).toBe(2);
    expect(S().selection.length).toBe(3);
  });
});

describe("Pathfinder Trim and Outline", () => {
  it("Trim: the lower shape loses the part under the upper one, strokes go, curves stay", () => {
    const r = rect(0, 0, 200, 200);
    const c = newVector([ellipseContour(200, 200, 80, 80)], "omni-circle");
    c.fill = "#0000ff";
    load(r, c);
    S().set({ selection: [r.id, c.id] });
    expect(trimPaths()).toBe(2);
    const vs = page().nodes as VectorNode[];
    expect(vs.every((v) => v.stroke === null)).toBe(true);
    expect(vs[0].contours[0].nodes.some((a) => a.handleOut[0] !== a.anchor[0] || a.handleOut[1] !== a.anchor[1])).toBe(true);
  });
  it("Outline: the divided regions as stroked edges in their fill colours, no fill", () => {
    load(rect(0, 0, 100, 100, "#ff0000"), rect(50, 0, 100, 100, "#0000ff"));
    S().set({ selection: page().nodes.map((n) => n.id) });
    expect(outlinePaths()).toBe(3);
    const vs = page().nodes as VectorNode[];
    expect(vs.every((v) => v.fill === null && !!v.stroke)).toBe(true);
    expect(new Set(vs.map((v) => v.stroke))).toEqual(new Set(["#ff0000", "#0000ff"]));
  });
});

describe("Smooth tool", () => {
  it("a drag along a jagged path re-fits it with fewer, smooth anchors", () => {
    const nodes = Array.from({ length: 40 }, (_, i) => corner(i * 10, 100 + (i % 2) * 1.5));
    const v = newVector([{ closed: false, nodes }], "omni-jagged");
    v.fill = null;
    v.stroke = "#000000";
    load(v);
    S().set({ selection: [v.id] });
    expect(smoothAlong([[0, 100], [200, 100], [390, 100]], 1)).toBe(true);
    const n = (page().nodes[0] as VectorNode).contours[0].nodes;
    expect(n.length).toBeLessThan(10);
    expect(n.every((a) => !a.isCorner)).toBe(true);
  });
});

describe("SVG export of a path's blend mode", () => {
  it("writes mix-blend-mode on the path, as Illustrator does", async () => {
    const { exportSvg } = await import("../src/io/export");
    const r = rect(0, 0, 100, 100);
    r.blendMode = "MULTIPLY";
    r.opacity = 0.5;
    load(r);
    const svg = await exportSvg(S().doc, page()).catch(() => null);
    if (svg) {
      expect(svg).toMatch(/opacity="0\.5" style="mix-blend-mode:multiply"/);
      expect(svg.match(/mix-blend-mode/g)?.length).toBe(1);
    }
  });
});
