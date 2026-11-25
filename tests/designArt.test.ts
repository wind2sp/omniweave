// 2026-11-24, features-ps-ai.md (Illustrator, design 2): blends, repeats and symbols are live art — their generated
// members follow the sources (or the symbol) in the same undo step; the shape builder merges / deletes regions; the
// shear transform; live effects and Expand Appearance.
import { describe, expect, it } from "vitest";
import { useStore } from "../src/core/store";
import { newDocument, newPage, newVector, type Page, type VectorNode } from "../src/core/types";
import { corner } from "../src/core/vector";
import { replaceSpine, setPatternTile, applyPattern, editPattern, editSymbol, expandArt, finishPatternEdit, finishSymbolEdit, makeBlend, makePattern, makeRepeat, newSymbol, placeSymbol, releaseArt, setArtOptions } from "../src/ui/designArt";
import { liveParts } from "../src/core/liveVector";
import { buildShapes, regionAt, regions } from "../src/ui/shapeBuilder";
import { transformSelection } from "../src/ui/designPathOps";
import { applyVectorFx, expandLiveAppearance } from "../src/ui/designLive";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;

function rect(name: string, x: number, y: number, w: number, h: number, fill = "#ff0000"): VectorNode {
  const v = newVector([{ closed: true, nodes: [corner(x, y), corner(x + w, y), corner(x + w, y + h), corner(x, y + h)] }], name);
  v.fill = fill;
  return v;
}
function load(...nodes: VectorNode[]): Page {
  const doc = newDocument();
  const p = newPage("DESIGN", 1000, 800);
  p.nodes.push(...nodes);
  doc.pages = [p];
  S().load(doc);
  S().set({ pageId: p.id, selection: nodes.map((n) => n.id), mode: "DESIGN" });
  return p;
}
const gens = () => page().nodes.filter((n) => n.artGen) as VectorNode[];
const minX = (n: VectorNode) => Math.min(...n.contours[0].nodes.map((a) => a.anchor[0]));

describe("blend", () => {
  it("Make Blend puts the steps between the two ends with mixed colours; moving an end moves them; Release drops them", () => {
    load(rect("omni-a", 0, 0, 100, 100, "#ff0000"), rect("omni-b", 800, 0, 100, 100, "#0000ff"));
    expect(makeBlend(3)).toBe(true);
    const g = gens();
    expect(g.length).toBe(3);
    expect(g.map(minX)).toEqual([200, 400, 600]);
    expect(g[1].fill).toBe("#800080");
    // the steps sit between the two ends in the stack
    expect(page().nodes.map((n) => n.name)[0]).toBe("omni-a");
    expect(page().nodes[page().nodes.length - 1].name).toBe("omni-b");
    // move the blue end down: the steps follow in the same commit (one undo step)
    const b = page().nodes.find((n) => n.name === "omni-b")!.id;
    const past = S().past.length;
    S().commit("move", (d) => {
      const n = d.pages[0].nodes.find((x) => x.id === b)!;
      n.transform.y = 400;
    });
    expect(S().past.length).toBe(past + 1);
    expect(gens().map((n) => Math.round(Math.min(...n.contours[0].nodes.map((a) => a.anchor[1]))))).toEqual([100, 200, 300]);
    setArtOptions({ steps: 1 });
    expect(gens().length).toBe(1);
    S().undo();
    expect(gens().length).toBe(3);
    S().set({ selection: [b] });
    expect(releaseArt()).toBe(true);
    expect(gens().length).toBe(0);
    expect(page().groups ?? []).toEqual([]);
  });

  it("paths with different anchor counts blend through resampled outlines", () => {
    const tri = newVector([{ closed: true, nodes: [corner(500, 0), corner(600, 100), corner(400, 100)] }], "omni-tri");
    tri.fill = "#000000";
    load(rect("omni-a", 0, 0, 100, 100), tri);
    makeBlend(2);
    expect(gens().length).toBe(2);
    expect(gens()[0].contours[0].nodes.length).toBeGreaterThanOrEqual(48);
  });
});

describe("repeat", () => {
  it("radial makes count − 1 turned copies; options change the count; Expand keeps them as plain objects", () => {
    load(rect("omni-petal", 450, 100, 100, 200));
    makeRepeat("radial");
    expect(gens().length).toBe(7);
    setArtOptions({ count: 4 });
    expect(gens().length).toBe(3);
    // the copy opposite the original sits below the centre (radius = the larger side, 200)
    const ys = gens().map((n) => Math.round(Math.min(...n.contours[0].nodes.map((a) => a.anchor[1]))));
    expect(Math.max(...ys)).toBe(500);
    expect(expandArt()).toBe(true);
    expect(gens().length).toBe(0);
    expect(page().nodes.length).toBe(4);
  });

  it("grid 3 × 3 and mirror", () => {
    load(rect("omni-cell", 0, 0, 50, 50));
    makeRepeat("grid");
    expect(gens().length).toBe(8);
    load(rect("omni-half", 0, 0, 50, 100));
    makeRepeat("mirror");
    expect(gens().length).toBe(1);
    expect(minX(gens()[0])).toBeCloseTo(60);
  });
});

describe("symbols", () => {
  it("New Symbol makes the selection an instance; a placed instance; editing one changes every instance", () => {
    load(rect("omni-sym", 0, 0, 100, 100, "#00ff00"));
    const id = newSymbol("omni")!;
    expect(S().doc.symbols?.length).toBe(1);
    expect(placeSymbol(id)).toBe(true);
    const inst = () => (page().groups ?? []).filter((g) => g.art?.kind === "symbol");
    expect(inst().length).toBe(2);
    // edit the first instance: its art turns blue, then the edit ends
    const first = inst()[0].id;
    S().set({ selection: page().nodes.filter((n) => n.groupId === first).map((n) => n.id) });
    expect(editSymbol()).toBe(true);
    const mem = page().nodes.find((n) => n.groupId === first)!.id;
    S().commit("fill", (d) => {
      const n = d.pages[0].nodes.find((x) => x.id === mem) as VectorNode;
      n.fill = "#0000ff";
    });
    // the other instance waits for the end of the edit
    expect(page().nodes.filter((n) => n.groupId === inst()[1].id).map((n) => (n as VectorNode).fill)).toEqual(["#00ff00"]);
    expect(finishSymbolEdit()).toBe(true);
    expect(page().nodes.filter((n) => n.artGen).map((n) => (n as VectorNode).fill)).toEqual(["#0000ff", "#0000ff"]);
    // the placed instance stays where it was placed (the page centre)
    const placed = page().nodes.find((n) => n.groupId === inst()[1].id) as VectorNode;
    expect(minX(placed)).toBe(450);
  });
});

describe("shape builder", () => {
  it("two overlapping squares are three regions; merging two leaves two shapes, deleting one leaves the rest", () => {
    load(rect("omni-l", 0, 0, 200, 200, "#ff0000"), rect("omni-r", 100, 0, 200, 200, "#0000ff"));
    expect(regions().length).toBe(3);
    const left = regionAt([50, 100]), mid = regionAt([150, 100]);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(buildShapes([left, mid], false)).toBe(2);
    const vs = page().nodes as VectorNode[];
    expect(vs.length).toBe(2);
    expect(vs.map((v) => v.fill).sort()).toEqual(["#0000ff", "#ff0000"]);
    S().set({ selection: vs.map((v) => v.id) });
    expect(buildShapes([regionAt([250, 100])], true)).toBe(1);
    expect(page().nodes.length).toBe(1);
  });
});

describe("shear and appearance", () => {
  it("Shear 45° on the horizontal axis about the centre moves the top right and the bottom left", () => {
    load(rect("omni-s", 0, 0, 100, 100));
    transformSelection("shear", { angle: 45, axis: 0 });
    const n = page().nodes[0] as VectorNode;
    expect(n.contours[0].nodes.map((a) => a.anchor.map((v) => Math.round(v)))).toEqual([[50, 0], [150, 0], [50, 100], [-50, 100]]);
  });

  it("a live effect and Expand Appearance", () => {
    load(rect("omni-e", 0, 0, 100, 100));
    applyVectorFx({ kind: "roundCorners", on: true, r: 20 }, null);
    expect((page().nodes[0] as VectorNode).vfx?.length).toBe(1);
    expect(expandLiveAppearance()).toBe(1);
    const n = page().nodes[0] as VectorNode;
    expect(n.vfx).toBeUndefined();
    expect(n.contours[0].nodes.length).toBe(8);
  });
});

describe("symbols keep their instances' own transforms", () => {
  it("an instance turned 90° stays turned when the symbol is redefined", () => {
    load(rect("omni-sym", 0, 0, 100, 50, "#00ff00"));
    newSymbol("omni");
    const g = (page().groups ?? [])[0];
    S().set({ selection: page().nodes.filter((n) => n.groupId === g.id).map((n) => n.id) });
    // the rotate tool's work: 90° about the art's centre (the path is baked)
    transformSelection("rotate", { angle: 90 });
    const art = (page().groups ?? [])[0].art;
    expect(art?.kind === "symbol" && art.m).toBeTruthy();
    // redefine: make the symbol red; the turned instance stays 50 wide and 100 tall
    S().set({ selection: page().nodes.filter((n) => n.groupId === g.id).map((n) => n.id) });
    editSymbol();
    const mem = page().nodes.find((n) => n.groupId === g.id)!.id;
    S().commit("fill", (d) => {
      (d.pages[0].nodes.find((x) => x.id === mem) as VectorNode).fill = "#ff0000";
    });
    finishSymbolEdit();
    const n = page().nodes.find((x) => x.groupId === g.id) as VectorNode;
    expect(n.fill).toBe("#ff0000");
    const xs = n.contours[0].nodes.map((a) => a.anchor[0]), ys = n.contours[0].nodes.map((a) => a.anchor[1]);
    expect(Math.round(Math.max(...xs) - Math.min(...xs))).toBe(50);
    expect(Math.round(Math.max(...ys) - Math.min(...ys))).toBe(100);
  });
});

describe("pattern swatches", () => {
  it("a tile's stroke is drawn too; editing the swatch changes every path filled with it", () => {
    const dot = rect("omni-dot", 0, 0, 20, 20, "#0000ff");
    dot.stroke = "#000000";
    dot.strokeWidth = 2;
    const box = rect("omni-box", 100, 100, 200, 100, "#ffffff");
    load(dot, box);
    S().set({ selection: [dot.id] });
    const id = makePattern()!;
    S().set({ selection: [box.id] });
    expect(applyPattern(id)).toBe(1);
    const filled = () => page().nodes.find((n) => n.name === "omni-box") as VectorNode;
    const fills = () => liveParts(filled())!.map((q) => q.fill);
    expect(fills()).toContain("#0000ff");
    expect(fills()).toContain("#000000");
    // edit: the tile art turns red
    expect(editPattern(id)).toBe(true);
    const tile = page().nodes.filter((n) => n.groupId && n.type === "VECTOR").map((n) => n.id);
    S().commit("red", (d) => {
      for (const n of d.pages[0].nodes) if (tile.includes(n.id)) (n as VectorNode).fill = "#ff0000";
    });
    expect(finishPatternEdit()).toBe(true);
    expect(page().nodes.some((n) => n.groupId)).toBe(false);
    expect(fills()).toContain("#ff0000");
    expect(fills()).not.toContain("#0000ff");
  });
});

describe("blend spine", () => {
  it("Replace Spine: the ends go to the path's ends and the steps follow the curve; Align to Path turns them", () => {
    const a = rect("omni-a", 0, 0, 20, 20, "#ff0000"), b = rect("omni-b", 400, 0, 20, 20, "#0000ff");
    // an arc-like path from (0, 300) up through (200, 100) down to (400, 300)
    const arc = newVector([{ closed: false, nodes: [{ anchor: [0, 300], handleIn: [0, 300], handleOut: [0, 100], isCorner: false }, { anchor: [400, 300], handleIn: [400, 100], handleOut: [400, 300], isCorner: false }] }], "omni-spine");
    arc.fill = null;
    load(a, b, arc);
    S().set({ selection: [a.id, b.id] });
    makeBlend(3);
    S().set({ selection: [...S().selection, arc.id] });
    expect(replaceSpine()).toBe(true);
    expect(page().nodes.some((n) => n.name === "omni-spine")).toBe(false);
    const cy = (n: VectorNode) => {
      const ys = n.contours[0].nodes.map((p) => p.anchor[1] + n.transform.y);
      return (Math.min(...ys) + Math.max(...ys)) / 2;
    };
    const ends = page().nodes.filter((n) => !n.artGen) as VectorNode[];
    expect(ends.map((n) => Math.round(cy(n)))).toEqual([300, 300]);
    // the middle step sits at the top of the curve (y = 150 for this Bézier), not on the straight line (y = 300)
    expect(Math.round(cy(gens()[1]))).toBe(150);
    setArtOptions({ orient: "path" });
    // the first step, on the rising part of the curve, is turned
    const st = gens()[0];
    const n0 = st.contours[0].nodes;
    expect(Math.abs(n0[1].anchor[1] - n0[0].anchor[1])).toBeGreaterThan(1);
  });
});

describe("pattern options", () => {
  it("a bigger tile spaces the copies out; art past the tile overlaps with the chosen neighbour in front", () => {
    const dot = rect("omni-dot", 0, 0, 20, 20, "#0000ff");
    const box = rect("omni-box", 0, 0, 100, 20, "#ffffff");
    load(dot, box);
    S().set({ selection: [dot.id] });
    const id = makePattern()!;
    S().set({ selection: [box.id] });
    applyPattern(id);
    const filled = () => page().nodes.find((n) => n.name === "omni-box") as VectorNode;
    const blueArea = () =>
      liveParts(filled())!
        .filter((q) => q.fill === "#0000ff")
        .flatMap((q) => q.contours)
        .reduce((a, c) => {
          let s = 0;
          const ps = c.nodes.map((x) => x.anchor);
          for (let i = 0; i < ps.length; i++) s += ps[i][0] * ps[(i + 1) % ps.length][1] - ps[(i + 1) % ps.length][0] * ps[i][1];
          return a + Math.abs(s / 2);
        }, 0);
    // 20 × 20 tiles over a 100 × 20 box: all blue
    expect(Math.round(blueArea())).toBe(2000);
    editPattern(id);
    setPatternTile({ w: 40 });
    finishPatternEdit();
    // 40 wide: blue at 0–20, 40–60, 80–100
    expect(Math.round(blueArea())).toBe(1200);
    // the swatch keeps its options
    expect(S().doc.patterns?.[0].w).toBe(40);
    editPattern(id);
    setPatternTile({ w: 10, overlapH: "right" });
    finishPatternEdit();
    expect(S().doc.patterns?.[0].overlapH).toBe("right");
    // art past a 10 px tile: drawn copy by copy, still covering the box
    expect(liveParts(filled())!.length).toBeGreaterThan(5);
    expect(Math.round(blueArea())).toBeGreaterThanOrEqual(2000);
  });
});
