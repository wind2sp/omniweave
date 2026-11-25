// Feature coverage: vector shapes, pathfinder, fill rules, transforms and SVG export.
import { describe, expect, it } from "vitest";
import { applyTransform, invertTransform } from "../../src/core/geom";
import { nodeBounds } from "../../src/core/loom";
import { ellipseContour, flatten, pathfinder, pointInContours, rectContour, vectorToSvgD } from "../../src/core/vector";
import { exportSvg } from "../../src/io/export";
import { newDocument, newPage, newText, newVector, type VectorNode } from "../../src/core/types";
import { polyArea } from "./helpers";

const rect = (x: number, y: number, w: number, h: number): VectorNode => {
  const v = newVector([rectContour(0, 0, w, h)]);
  v.transform = { x, y, rotation: 0, scale: 1 };
  return v;
};
const area = (v: VectorNode | null) => (v ? v.contours.reduce((a, c) => a + polyArea(c.nodes.map((n) => n.anchor)), 0) : 0);

describe("shapes", () => {
  it("[PS-073][IL-021] rectangle and ellipse tools produce closed contours of the right size", () => {
    const r = rectContour(0, 0, 100, 50);
    expect(r.closed).toBe(true);
    expect(polyArea(flatten(r))).toBeCloseTo(5000);
    const e = ellipseContour(0, 0, 50, 50);
    expect(e.nodes.every((n) => !n.isCorner)).toBe(true); // true Bézier circle
    expect(polyArea(flatten(e, 0.05))).toBeCloseTo(Math.PI * 2500, -1);
    expect(vectorToSvgD(newVector([r]))).toBe("M0 0L100 0L100 50L0 50L0 0Z");
  });
});

describe("pathfinder", () => {
  const a = () => rect(0, 0, 100, 100);
  const b = () => rect(50, 0, 100, 100);
  it("[IL-030] unite", () => expect(area(pathfinder("union", [a(), b()]))).toBeCloseTo(15000));
  it("[IL-031] minus front", () => expect(area(pathfinder("subtract", [a(), b()]))).toBeCloseTo(5000));
  it("[IL-032] intersect", () => expect(area(pathfinder("intersect", [a(), b()]))).toBeCloseTo(5000));
  it("[IL-033] exclude", () => expect(area(pathfinder("exclude", [a(), b()]))).toBeCloseTo(10000));
  // (2026-11-25, design 2: the limit is lifted — the sources' Bézier curves are kept, core/curveKeep.ts)
  it("[IL-030] curved inputs keep their Bézier curves (a few anchors, not a polyline)", () => {
    const c1 = newVector([ellipseContour(50, 50, 50, 50)]);
    const c2 = newVector([ellipseContour(100, 50, 50, 50)]);
    const u = pathfinder("union", [c1, c2])!;
    const nodes = u.contours.flatMap((c) => c.nodes);
    expect(nodes.length).toBeLessThanOrEqual(10);
    expect(nodes.some((a) => a.handleOut[0] !== a.anchor[0] || a.handleOut[1] !== a.anchor[1])).toBe(true);
  });
});

describe("fill rules", () => {
  it("[IL-035] compound path: evenodd punches a hole, nonzero does not (same winding)", () => {
    const v = newVector([rectContour(0, 0, 100, 100), rectContour(25, 25, 50, 50)]);
    v.fillRule = "evenodd";
    expect(pointInContours(v, [50, 50])).toBe(false);
    expect(pointInContours(v, [10, 10])).toBe(true);
    v.fillRule = "nonzero";
    expect(pointInContours(v, [50, 50])).toBe(true);
  });
});

describe("transforms", () => {
  it("[IL-055][IL-056][PP-035] rotate and uniform scale map local↔page coordinates and bounds", () => {
    const t = { x: 100, y: 50, rotation: 90, scale: 2 };
    const p = applyTransform(t, [10, 0]);
    expect(p[0]).toBeCloseTo(100);
    expect(p[1]).toBeCloseTo(70);
    const back = invertTransform(t, p);
    expect(back[0]).toBeCloseTo(10);
    expect(back[1]).toBeCloseTo(0);
    const v = rect(0, 0, 100, 20);
    v.fill = "#000";
    const rotated = { ...v, transform: { x: 0, y: 0, rotation: 90, scale: 1 } };
    const bb = nodeBounds(rotated);
    expect(bb.w).toBeCloseTo(22, 0); // 20 + stroke pad
    expect(bb.h).toBeCloseTo(102, 0);
  });
});

describe("SVG export", () => {
  it("[IL-006][IL-040][IL-041][IL-042][PP-037] vectors and text stay live SVG with fill, stroke, width and fill rule", async () => {
    const doc = newDocument();
    const page = newPage("DESIGN", 400, 300);
    const v = rect(10, 20, 100, 50);
    v.fill = null;
    v.stroke = "#ff0000";
    v.strokeWidth = 4;
    v.fillRule = "evenodd";
    v.opacity = 0.5;
    const t = newText("안녕 <SVG>", 200, { fontSize: 24, bold: true, color: "#0000ff" });
    page.nodes.push(v, t);
    doc.pages = [page];
    const svg = await exportSvg(doc, page);
    expect(svg).toMatch(/^<svg [^>]*width="400" height="300"/);
    expect(svg).toContain(`d="M0 0L100 0L100 50L0 50L0 0Z" fill="none" fill-rule="evenodd" stroke="#ff0000" stroke-width="4"`);
    expect(svg).toContain(`transform="translate(10 20) rotate(0) scale(1)" opacity="0.5"`);
    expect(svg).toMatch(/<text [^>]*font-size="24" font-weight="700"[^>]*fill="#0000ff"[^>]*>안녕 <\/text>/);
    expect(svg).toContain("&lt;SVG&gt;");
  });
});
