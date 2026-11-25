// 2026-11-24, features-ps-ai.md (Illustrator Type on a Path): a path becomes the line a text runs along; each
// character sits on the path turned with it, what runs past an open path's end is not drawn, and the SVG / PDF
// writers place the same glyphs.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newText, newVector, type TextNode } from "../src/core/types";
import { corner } from "../src/core/vector";
import { pathTextGlyphs, pathTextBounds } from "../src/core/pathText";
import { typeOnPath } from "../src/ui/designPathText";
import { PROFILES } from "../src/ui/editModes";

const mono = (s: string) => s.length * 10;

function onLine(text: string, len = 100): TextNode {
  const t = newText(text, 360, { fontSize: 20 });
  t.onPath = { contour: { closed: false, nodes: [corner(0, 0), corner(len, 0)] } };
  return t;
}

describe("type on a path", () => {
  it("places each character along the path, left to right on a straight line", () => {
    const g = pathTextGlyphs(onLine("ABC"), mono);
    expect(g.map((x) => x.ch)).toEqual(["A", "B", "C"]);
    expect(g.map((x) => Math.round(x.x))).toEqual([0, 10, 20]);
    expect(g.every((x) => Math.abs(x.angle) < 1e-9 && Math.abs(x.y) < 1e-9)).toBe(true);
  });

  it("turns the characters with a vertical path and stops at an open path's end", () => {
    const t = onLine("ABCDEFGHIJKL", 50);
    t.onPath!.contour.nodes = [corner(0, 0), corner(0, 50)];
    const g = pathTextGlyphs(t, mono);
    expect(g.length).toBe(5);
    expect(g[0].angle).toBeCloseTo(Math.PI / 2);
    expect(g[4].y).toBeCloseTo(40);
  });

  it("the start offset moves the text along; the box is the path's grown by the size", () => {
    const t = onLine("AB");
    t.onPath!.start = 30;
    expect(Math.round(pathTextGlyphs(t, mono)[0].x)).toBe(30);
    const b = pathTextBounds(t)!;
    expect(b.w).toBeCloseTo(140);
  });

  it("Type on a Path turns the selected path into a path text in its place; the tool is in the design mode", () => {
    const doc = newDocument();
    const p = newPage("DESIGN", 800, 600, "아트보드 1");
    const v = newVector([{ closed: false, nodes: [corner(10, 10), corner(300, 10)] }], "omni-path");
    v.stroke = "#336699";
    p.nodes.push(v);
    doc.pages = [p];
    useStore.getState().load(doc);
    useStore.getState().set({ pageId: p.id, selection: [v.id], mode: "DESIGN" });
    const tx = typeOnPath()!;
    const nodes = useStore.getState().doc.pages[0].nodes;
    expect(nodes.length).toBe(1);
    expect(nodes[0].id).toBe(tx.id);
    expect((nodes[0] as TextNode).onPath?.contour.nodes.length).toBe(2);
    expect((nodes[0] as TextNode).paragraphs[0].runs[0].color).toBe("#336699");
    expect(PROFILES.DESIGN.tools).toContain("typePath");
  });
});
