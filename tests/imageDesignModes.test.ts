// Image mode (Photoshop) pixel selection, design mode (Illustrator) anchor points / SVG paths, and the mode keymaps.
import { beforeEach, describe, expect, it } from "vitest";
import { DOMParser as XmlDOMParser } from "@xmldom/xmldom";
import { combine, ellipseMask, invertMask, maskBounds, maskOutline, polygonMask, rectMask, wandMask } from "../src/core/image/pixelSelection";
import { nearestOnContour, splitSegment } from "../src/core/pathEdit";
import { cubicAt, corner } from "../src/core/vector";
import { parsePathData, parseTransform, segsToContours, svgToVectors } from "../src/io/svgVectors";
import { useStore } from "../src/core/store";
import { newDocument, newPage, type VectorAnchor } from "../src/core/types";
import { PROFILES, keyOfTool, toolForKey } from "../src/ui/editModes";

const S = () => useStore.getState();
const count = (m: { data: Uint8Array }) => m.data.reduce((a, v) => a + (v ? 1 : 0), 0);

describe("pixel selection masks", () => {
  it("rectangle, ellipse and lasso select the pixels whose centres are inside", () => {
    expect(count(rectMask(10, 10, 2, 3, 6, 8))).toBe(4 * 5);
    expect(maskBounds(rectMask(10, 10, 6, 8, 2, 3))).toEqual({ x: 2, y: 3, w: 4, h: 5 });
    const e = ellipseMask(100, 100, 0, 0, 100, 100);
    expect(Math.abs(count(e) - Math.PI * 50 * 50) / (Math.PI * 2500)).toBeLessThan(0.02);
    const tri = polygonMask(20, 20, [[0, 0], [20, 0], [0, 20]]);
    expect(count(tri)).toBeGreaterThan(180);
    expect(count(tri)).toBeLessThan(220);
  });
  it("Shift adds, Alt subtracts, Shift+Alt intersects; invert", () => {
    const a = rectMask(10, 10, 0, 0, 6, 10), b = rectMask(10, 10, 4, 0, 10, 10);
    expect(count(combine(a, b, "add"))).toBe(100);
    expect(count(combine(a, b, "subtract"))).toBe(40);
    expect(count(combine(a, b, "intersect"))).toBe(20);
    expect(count(combine(a, b, "replace"))).toBe(60);
    expect(count(invertMask(a))).toBe(40);
  });
  it("magic wand: contiguous flood fill within the tolerance, or every matching pixel", () => {
    const w = 6, h = 1;
    const px = new Uint8Array(w * h * 4);
    const set = (i: number, v: number) => px.set([v, v, v, 255], i * 4);
    [10, 12, 200, 11, 14, 90].forEach((v, i) => set(i, v));
    expect(Array.from(wandMask(px, w, h, 0, 0, 5, true).data)).toEqual([255, 255, 0, 0, 0, 0]);
    expect(Array.from(wandMask(px, w, h, 0, 0, 5, false).data)).toEqual([255, 255, 0, 255, 255, 0]);
  });
  it("marching ants: the outline of a square is its four sides", () => {
    const segs = maskOutline(rectMask(10, 10, 2, 2, 5, 5))!;
    expect(segs.length / 4).toBe(4);
    const len = segs.reduce((a, _v, i) => (i % 4 === 0 ? a + Math.abs(segs[i + 2] - segs[i]) + Math.abs(segs[i + 3] - segs[i + 1]) : a), 0);
    expect(len).toBe(12);
  });
});

describe("anchor points", () => {
  it("adding a point on a curve keeps its shape", () => {
    const a: VectorAnchor = { anchor: [0, 0], handleIn: [0, 0], handleOut: [30, -40], isCorner: false };
    const b: VectorAnchor = { anchor: [100, 0], handleIn: [70, -40], handleOut: [100, 0], isCorner: false };
    const r = splitSegment(a, b, 0.3);
    const before = cubicAt(a.anchor, a.handleOut, b.handleIn, b.anchor, 0.15);
    const after = cubicAt(r.a.anchor, r.a.handleOut, r.mid.handleIn, r.mid.anchor, 0.5);
    expect(after[0]).toBeCloseTo(before[0], 6);
    expect(after[1]).toBeCloseTo(before[1], 6);
  });
  it("finds the nearest point on a straight segment", () => {
    const hit = nearestOnContour({ closed: false, nodes: [corner(0, 0), corner(100, 0)] }, [40, 3])!;
    // a straight segment keeps its handles on its points, so the parameter is not proportional to the length
    const q = cubicAt([0, 0], [0, 0], [100, 0], [100, 0], hit.u);
    expect(q[0]).toBeCloseTo(40, 1);
    expect(hit.d).toBeCloseTo(3, 2);
  });
});

describe("SVG artwork as editable paths", () => {
  (globalThis as any).DOMParser ??= XmlDOMParser;
  it("path data: relative commands, smooth curves, arcs and close", () => {
    const segs = parsePathData("m10 10 h20 v20 h-20 z");
    const cs = segsToContours(segs, parseTransform(null));
    expect(cs).toHaveLength(1);
    expect(cs[0].closed).toBe(true);
    expect(cs[0].nodes.map((n) => n.anchor)).toEqual([[10, 10], [30, 10], [30, 30], [10, 30]]);
    const arc = segsToContours(parsePathData("M0 0 A50 50 0 0 1 100 0"), parseTransform(null))[0];
    const mid = cubicAt(arc.nodes[0].anchor, arc.nodes[0].handleOut, arc.nodes[1].handleIn, arc.nodes[1].anchor, 1);
    expect(mid[0]).toBeCloseTo(arc.nodes[1].anchor[0], 6);
  });
  it("transforms are baked in, groups become layer groups, styles carry over", () => {
    const art = svgToVectors(
      `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 100 50"><g id="Icons" transform="translate(10 0)"><rect x="0" y="0" width="10" height="10" fill="#ff0000" stroke="#000" stroke-width="2" stroke-dasharray="4 2"/><circle cx="50" cy="25" r="10" fill="none" stroke="blue"/></g></svg>`,
    )!;
    expect(art).not.toBeNull();
    expect([art.width, art.height]).toEqual([200, 100]);
    expect(art.groups.map((g) => g.name)).toEqual(["Icons"]);
    const [r, c] = art.nodes as any[];
    expect(r.contours[0].nodes[0].anchor).toEqual([20, 0]);
    expect(r.strokeWidth).toBeCloseTo(4);
    expect(r.strokeDash).toEqual([8, 4]);
    expect(r.groupId).toBe(art.groups[0].id);
    expect(c.fill).toBeNull();
    expect(c.stroke).toBe("blue");
  });
  it("text, images and gradients keep the file as one picture", () => {
    expect(svgToVectors(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>Hi</text></svg>`)).toBeNull();
    expect(svgToVectors(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="5" height="5" fill="url(#g)"/></svg>`)).toBeNull();
  });
});

describe("mode keymaps", () => {
  beforeEach(() => {
    const doc = newDocument();
    doc.pages = [newPage("DESIGN", 800, 600)];
    S().load(doc);
  });
  it("Photoshop letters in images, Illustrator letters in designs, none in slides and documents", () => {
    S().set({ mode: "IMAGE" });
    expect(toolForKey("m", false)).toBe("marquee");
    expect(toolForKey("w", false)).toBe("wand");
    expect(toolForKey("l", false)).toBe("lasso");
    expect(toolForKey("a", false)).toBe("direct");
    S().set({ mode: "DESIGN" });
    expect(toolForKey("m", false)).toBe("rect");
    expect(toolForKey("l", false)).toBe("ellipse");
    expect(toolForKey("\\", false)).toBe("line");
    expect(toolForKey("+", true)).toBe("anchorAdd");
    expect(toolForKey("-", false)).toBe("anchorDel");
    expect(toolForKey("c", true)).toBe("anchorConvert");
    expect(toolForKey("~", true)).toBe("curvature");
    expect(keyOfTool(PROFILES.DESIGN, "curvature")).toBe("Shift+`");
    expect(keyOfTool(PROFILES.DESIGN, "anchorConvert")).toBe("Shift+C");
    expect(toolForKey("e", true)).toBe("eraser");
    expect(toolForKey("e", false)).toBeNull();
    S().set({ mode: "SLIDE" });
    expect(toolForKey("v", false)).toBeNull();
    expect(PROFILES.SLIDE.tools).toEqual(expect.arrayContaining(["direct", "brush", "eraser"]));
    S().set({ mode: "DOCUMENT" });
    expect(toolForKey("v", false)).toBeNull();
    expect(keyOfTool(PROFILES.IMAGE, "marquee")).toBe("M");
    expect(keyOfTool(PROFILES.DESIGN, "eraser")).toBe("Shift+E");
  });
});
