// 2026-11-25 (design 2): Illustrator's pencil, scissors and knife, the design mode's C key, and the Gaussian Blur effect.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newVector, type Page, type VectorNode } from "../src/core/types";
import { corner, ellipseContour } from "../src/core/vector";
import { cutContour, knifeCut, pencilPath, scissorsAt } from "../src/ui/designCut";
import { resolveBinding } from "../src/ui/keymap";
import { applyEffects } from "../src/core/image/effects";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
function load(...nodes: VectorNode[]): Page {
  const doc = newDocument();
  const p = newPage("DESIGN", 800, 600);
  p.nodes.push(...nodes);
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: [], mode: "DESIGN" });
  return p;
}
const rect = (x: number, y: number, w: number, h: number) => {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }], "omni-rect");
  v.fill = "#ff0000";
  return v;
};

describe("pencil", () => {
  it("a wobbly hand-drawn track becomes a few smooth anchors; ending at the start closes it", () => {
    load();
    const track: [number, number][] = [];
    for (let i = 0; i <= 200; i++) track.push([i * 2, 100 + Math.sin(i / 20) * 40 + (i % 2) * 0.4]);
    const v = pencilPath(track, 1)!;
    expect(v.contours[0].closed).toBe(false);
    expect(v.contours[0].nodes.length).toBeLessThan(30);
    expect(v.contours[0].nodes.some((a) => a.handleOut[0] !== a.anchor[0])).toBe(true);
    expect(v.fill).toBeNull();
    const loop: [number, number][] = [];
    for (let i = 0; i <= 60; i++) loop.push([200 + 80 * Math.cos((i / 60) * 2 * Math.PI), 200 + 80 * Math.sin((i / 60) * 2 * Math.PI)]);
    expect(pencilPath(loop, 1)!.contours[0].closed).toBe(true);
  });
});

describe("scissors", () => {
  it("cutting a closed path opens it at the cut; cutting an open path makes two paths", () => {
    const c = rect(0, 0, 100, 100).contours[0];
    const open = cutContour(c, 0, 0.5);
    expect(open.length).toBe(1);
    expect(open[0].closed).toBe(false);
    expect(open[0].nodes[0].anchor).toEqual([50, 0]);
    expect(open[0].nodes[open[0].nodes.length - 1].anchor).toEqual([50, 0]);
    const line = newVector([{ closed: false, nodes: [corner(0, 0), corner(200, 0)] }], "omni-line");
    line.fill = null;
    line.stroke = "#000000";
    load(line);
    expect(scissorsAt([100, 0], 4)).toBe(true);
    expect(page().nodes.length).toBe(2);
    expect(page().nodes.map((n) => (n as VectorNode).contours[0].nodes.map((a) => a.anchor[0]))).toEqual([[0, 100], [100, 200]]);
  });
});

describe("knife", () => {
  it("a cut across a circle leaves two pieces that keep the circle's curves", () => {
    const c = newVector([ellipseContour(200, 200, 100, 100)], "omni-circle");
    c.fill = "#0000ff";
    load(c);
    expect(knifeCut([[50, 200], [350, 200]])).toBe(1);
    const vs = page().nodes as VectorNode[];
    expect(vs.length).toBe(2);
    for (const v of vs) {
      expect(v.contours[0].nodes.length).toBeLessThanOrEqual(8);
      expect(v.contours[0].nodes.some((a) => a.handleOut[0] !== a.anchor[0] || a.handleOut[1] !== a.anchor[1])).toBe(true);
    }
  });
});

describe("keys", () => {
  it("C is the scissors in the design mode and still crops in the image mode; N is the pencil", () => {
    expect(resolveBinding("DESIGN", "C")?.cmd).toBe("act.tool.scissors");
    expect(resolveBinding("DESIGN", "N")?.cmd).toBe("act.tool.pencil");
    expect(resolveBinding("IMAGE", "C")?.cmd).toBe("object.crop");
  });
});

describe("Gaussian Blur effect", () => {
  it("softens the edge: alpha spreads beyond the shape and falls off", () => {
    const w = 40, h = 40, d = new Float32Array(w * h * 4);
    for (let y = 10; y < 30; y++) for (let x = 10; x < 30; x++) d.set([1, 0, 0, 1], (y * w + x) * 4);
    applyEffects(d, w, h, [{ type: "blur", on: true, radius: { v: 3, u: "px" } }], 1);
    const a = (x: number, y: number) => d[(y * w + x) * 4 + 3];
    expect(a(20, 20)).toBeGreaterThan(0.95);
    expect(a(8, 20)).toBeGreaterThan(0.02);
    expect(a(10, 20)).toBeLessThan(0.8);
  });
});
