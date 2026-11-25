// Illustrator's Object › Path / Compound Path / Transform and Pathfinder › Divide in the design mode (2026-11-24, the
// owner: "AI에서 개체 TEXT 아웃라인 만들기 등도 구현이 안되는 거 같아"). Geometry checks on plain shapes, and an AI saved
// after Outline Stroke keeps the gradient of the stroke it outlined.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newVector, type Page, type VectorNode } from "../src/core/types";
import { corner, pointInContours } from "../src/core/vector";
import { averageAnchors, dividePaths, makeCompound, offsetPath, outlineStroke, releaseCompound, simplifyPaths, transformSelection } from "../src/ui/designPathOps";
import { resolveBinding } from "../src/ui/keymap";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;

function rect(name: string, x: number, y: number, w: number, h: number, fill: string | null = "#e63946"): VectorNode {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }], name);
  v.fill = fill;
  return v;
}
function load(...nodes: VectorNode[]): Page {
  const doc = newDocument();
  const p = newPage("DESIGN", 800, 600);
  p.nodes.push(...nodes);
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: nodes.map((n) => n.id), mode: "DESIGN" });
  return p;
}
const bounds = (n: VectorNode) => {
  const xs = n.contours.flatMap((c) => c.nodes.map((a) => a.anchor[0])), ys = n.contours.flatMap((c) => c.nodes.map((a) => a.anchor[1]));
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map((v) => Math.round(v));
};

describe("Object › Path", () => {
  it("Outline Stroke: an open 10 px line becomes a filled shape 10 px wide with round ends", () => {
    const line = newVector([{ closed: false, nodes: [corner(100, 100), corner(300, 100)] }], "omni-line");
    line.fill = null;
    line.stroke = "#264653";
    line.strokeWidth = 10;
    load(line);
    expect(outlineStroke()).toBe(1);
    const v = page().nodes[0] as VectorNode;
    expect([v.fill, v.stroke]).toEqual(["#264653", null]);
    expect(bounds(v)).toEqual([95, 95, 305, 105]);
    expect(pointInContours(v, [200, 103])).toBe(true);
    expect(pointInContours(v, [200, 108])).toBe(false);
  });
  it("Offset Path: a copy 10 px larger above the original (and smaller with a negative value)", () => {
    load(rect("omni-r", 100, 100, 100, 100));
    expect(offsetPath(10)).toBe(1);
    expect(page().nodes.length).toBe(2);
    expect(bounds(page().nodes[1] as VectorNode)).toEqual([90, 90, 210, 210]);
    S().set({ selection: [page().nodes[0].id] });
    offsetPath(-10);
    expect(bounds(page().nodes[1] as VectorNode)).toEqual([110, 110, 190, 190]);
  });
  it("Simplify keeps a rectangle's corners and drops the points that add nothing", () => {
    const many = newVector([{ closed: true, nodes: [corner(0, 0), corner(50, 0), corner(100, 0), corner(100, 50), corner(100, 100), corner(50, 100), corner(0, 100), corner(0, 50)] }], "omni-many");
    many.fill = "#000000";
    load(many);
    expect(simplifyPaths(1)).toBe(1);
    const v = page().nodes[0] as VectorNode;
    expect(v.contours[0].nodes.length).toBe(4);
    expect(v.contours[0].nodes.every((a) => a.isCorner)).toBe(true);
  });
  it("Average puts the selected paths' points on their centre", () => {
    load(rect("omni-a", 0, 0, 10, 10));
    averageAnchors();
    expect(bounds(page().nodes[0] as VectorNode)).toEqual([5, 5, 5, 5]);
  });
});

describe("Pathfinder Divide and Compound Path", () => {
  it("Divide: two overlapping squares give three pieces (the overlap takes the top's colour)", () => {
    load(rect("omni-a", 0, 0, 100, 100, "#ff0000"), rect("omni-b", 50, 50, 100, 100, "#0000ff"));
    expect(dividePaths()).toBe(3);
    expect(page().nodes.map((n) => (n as VectorNode).fill).sort()).toEqual(["#0000ff", "#0000ff", "#ff0000"]);
  });
  it("Ctrl+8 makes one even-odd path of both (a hole where they overlap); release gives them back", () => {
    load(rect("omni-a", 0, 0, 100, 100), rect("omni-b", 25, 25, 50, 50, "#0000ff"));
    expect(resolveBinding("DESIGN", "Ctrl+8")?.cmd).toBe("path.compoundMake");
    expect(resolveBinding("DESIGN", "Ctrl+Shift+O")?.cmd).toBe("type.createOutlines");
    expect(makeCompound()).toBe(1);
    const v = page().nodes[0] as VectorNode;
    expect(page().nodes.length).toBe(1);
    expect(v.fillRule).toBe("evenodd");
    expect(pointInContours(v, [50, 50])).toBe(false);
    expect(pointInContours(v, [10, 10])).toBe(true);
    releaseCompound();
    expect(page().nodes.length).toBe(2);
  });
});

describe("Object › Transform dialogs", () => {
  it("Move, Rotate (counter-clockwise), Reflect (vertical axis) and Scale about the selection's centre; Copy keeps the original", () => {
    load(rect("omni-a", 0, 0, 100, 50));
    transformSelection("move", { dx: 10, dy: 20 });
    expect(bounds(page().nodes[0] as VectorNode)).toEqual([10, 20, 110, 70]);
    transformSelection("rotate", { angle: 90 });
    expect(bounds(page().nodes[0] as VectorNode)).toEqual([35, -5, 85, 95]);
    transformSelection("rotate", { angle: -90 });
    transformSelection("scale", { sx: 200 }, true);
    expect(page().nodes.length).toBe(2);
    expect(bounds(page().nodes[1] as VectorNode)).toEqual([-40, -5, 160, 95]);
    // reflect across the vertical axis: the left edge goes right
    const tri = newVector([{ closed: true, nodes: [corner(0, 0), corner(100, 0), corner(0, 100)] }], "omni-tri");
    tri.fill = "#000";
    load(tri);
    transformSelection("reflect", { angle: 90 });
    const xs = (page().nodes[0] as VectorNode).contours[0].nodes.map((a) => Math.round(a.anchor[0]));
    expect(xs).toEqual([100, 0, 100]);
  });
});

describe("saved into the AI", () => {
  it("the ring's gradient stroke, outlined, is saved as a gradient-filled shape and reads back as one", async () => {
    const sg = await import("../src/io/pdfsurgeon");
    const doc = await sg.openSurgeonDoc(new Uint8Array(readFileSync("qa/samples/store-sample/ko/omni-store-design.ai")));
    const nodes = structuredClone(sg.elevatePage(doc, 0, { prefix: "omw", vectors: "auto" }).nodes) as VectorNode[];
    const ring = nodes.find((n) => (n as any).strokes?.[0])!;
    const d = newDocument();
    const p = newPage("PDF", 800, 533);
    p.nodes.push(...nodes);
    d.pages = [p];
    S().load(d);
    S().set({ pageId: p.id, selection: [ring.id], mode: "DESIGN" });
    expect(outlineStroke()).toBe(1);
    const out = S().doc.pages[0].nodes;
    const outlined = out.find((n) => n.type === "VECTOR" && (n as any).fills?.[0]?.type === "gradient" && !(n as any).strokes && (n as VectorNode).contours.length === 2);
    expect(outlined).toBeTruthy();
    const { bytes } = await sg.saveSurgical(doc, [{ pageIndex: 0, nodes: out, elevated: true }], { prefix: "omw", vectors: "auto" });
    const again = sg.elevatePage(await sg.openSurgeonDoc(bytes), 0, { prefix: "omw", vectors: "auto" });
    // the ring is gone as a stroke; a gradient shape stands in its place
    expect(again.nodes.some((n) => (n as any).strokes?.[0])).toBe(false);
    expect(again.nodes.filter((n) => (n as any).fills?.[0]?.type === "gradient").length).toBeGreaterThanOrEqual(6);
  });
});
