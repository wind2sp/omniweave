// Layer groups and clipping masks: tree building, normalisation and Photoshop compositing semantics, checked with
// the canvas-free compositor (the screen renderer walks the same tree).
import { describe, expect, it } from "vitest";
import { buildTree, clipBase, groupMemberIds, normalizeGroups } from "../../src/core/layerTree";
import { compositeTree, type PlacedPixels } from "../../src/core/image/softComposite";
import { newGroup, newPage, newRaster, type LayerGroup, type RasterNode, type SceneNode } from "../../src/core/types";

const W = 4, H = 1;
type RGB = [number, number, number];

/** A layer covering columns [x0, x1) of a 4×1 canvas with one colour. */
function layer(name: string, rgb: RGB, x0 = 0, x1 = W, extra: Partial<RasterNode> = {}): { node: RasterNode; px: PlacedPixels } {
  const node = { ...newRaster(name), ...extra } as RasterNode;
  const rgba = new Uint8Array(W * H * 4);
  for (let x = x0; x < x1; x++) rgba.set([...rgb, 255], x * 4);
  return { node, px: { rgba, left: 0, top: 0, width: W, height: H } };
}

function comp(layers: { node: SceneNode; px: PlacedPixels }[], groups?: LayerGroup[]): number[][] {
  const map = new Map(layers.map((l) => [l.node.id, l.px]));
  const out = compositeTree(
    layers.map((l) => l.node),
    groups,
    (n) => map.get(n.id) ?? null,
    W,
    H,
  );
  return Array.from({ length: W }, (_, x) => Array.from(out.subarray(x * 4, x * 4 + 4)));
}

const near = (a: number[], b: number[], tol = 1) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const expectPx = (got: number[], want: number[]) => expect(near(got, want), `${got} ≈ ${want}`).toBe(true);
const WHITE: RGB = [255, 255, 255];

describe("layer tree", () => {
  it("clipped layers attach to the nearest unclipped item below in the same group; a clipped bottom layer is unclipped", () => {
    const g = newGroup("G");
    const a = newRaster("a"), b = { ...newRaster("b"), clip: true }, c = { ...newRaster("c"), clip: true };
    const d = { ...newRaster("d"), groupId: g.id, clip: true }, e = { ...newRaster("e"), groupId: g.id };
    const f = { ...newRaster("f"), clip: true };
    const tree = buildTree([a, b, c, d, e, f], [g]);
    expect(tree.map((t) => t.kind)).toEqual(["node", "group"]);
    expect(tree[0].clips.map((n) => n.name)).toEqual(["b", "c"]);
    const gi = tree[1];
    if (gi.kind !== "group") throw new Error();
    // d is the bottom of G: nothing to clip to, drawn as an ordinary layer
    expect(gi.children.map((x) => (x.kind === "node" ? x.node.name : "?"))).toEqual(["d", "e"]);
    // f clips to the group G
    expect(gi.clips.map((n) => n.name)).toEqual(["f"]);
    const page = { nodes: [a, b, c, d, e, f], groups: [g] };
    expect((clipBase(page, c.id) as SceneNode).id).toBe(a.id);
    expect(clipBase(page, d.id)).toBeNull();
    expect((clipBase(page, f.id) as LayerGroup).id).toBe(g.id);
  });

  it("normalizeGroups keeps members together (group sits at its top-most member) and drops dangling ids", () => {
    const page = newPage();
    const g = newGroup("G"), inner = newGroup("I", g.id);
    const n = (name: string, groupId?: string) => ({ ...newRaster(name), ...(groupId ? { groupId } : {}) });
    page.groups = [g, inner];
    page.nodes = [n("g1", g.id), n("x"), n("i1", inner.id), n("y"), n("g2", g.id), n("z", "missing")];
    expect(normalizeGroups(page)).toBe(true);
    expect(page.nodes.map((x) => x.name)).toEqual(["x", "y", "g1", "i1", "g2", "z"]);
    expect(page.nodes[5].groupId).toBeUndefined();
    expect(normalizeGroups(page)).toBe(false);
    expect(groupMemberIds(page, g.id).map((id) => page.nodes.find((x) => x.id === id)!.name)).toEqual(["g1", "i1", "g2"]);
  });

  it("parent cycles are broken", () => {
    const page = newPage();
    const a = newGroup("A"), b = newGroup("B", a.id);
    a.parentId = b.id;
    page.groups = [a, b];
    normalizeGroups(page);
    expect(page.groups.filter((g) => g.parentId === null).length).toBeGreaterThan(0);
  });
});

describe("compositing (Photoshop semantics)", () => {
  it("clip stack: clipped layer shows only on the base's pixels and takes the base's opacity", () => {
    const bg = layer("bg", WHITE);
    const base = layer("base", [255, 0, 0], 0, 2, { opacity: 0.5 });
    const top = layer("top", [0, 0, 255], 0, 4, { clip: true });
    const px = comp([bg, base, top]);
    // where the base is: blue (clipped layer) at the base's 50 % over white; elsewhere just white
    expectPx(px[0], [128, 128, 255, 255]);
    expectPx(px[1], [128, 128, 255, 255]);
    expectPx(px[2], [255, 255, 255, 255]);
    expectPx(px[3], [255, 255, 255, 255]);
  });

  it("consecutive clipped layers share the base; a clipped layer's blend mode works against the base", () => {
    const bg = layer("bg", WHITE);
    const base = layer("base", [255, 255, 0], 0, 3);
    const c1 = layer("c1", [0, 255, 255], 1, 4, { clip: true, blendMode: "MULTIPLY" });
    const c2 = layer("c2", [255, 0, 0], 2, 4, { clip: true });
    const px = comp([bg, base, c1, c2]);
    expectPx(px[0], [255, 255, 0, 255]); // base only
    expectPx(px[1], [0, 255, 0, 255]); // yellow × cyan
    expectPx(px[2], [255, 0, 0, 255]); // c2 on top
    expectPx(px[3], [255, 255, 255, 255]); // outside the base
  });

  it("a hidden base hides its clipped layers", () => {
    const bg = layer("bg", WHITE);
    const base = layer("base", [255, 0, 0], 0, 4, { visible: false });
    const top = layer("top", [0, 0, 255], 0, 4, { clip: true });
    expectPx(comp([bg, base, top])[0], [255, 255, 255, 255]);
  });

  it("the base's blend mode applies to the whole stack", () => {
    const bg = layer("bg", [255, 255, 0]);
    const base = layer("base", [255, 255, 255], 0, 4, { blendMode: "MULTIPLY" });
    const top = layer("top", [0, 255, 255], 0, 4, { clip: true });
    // (base + clipped = cyan) multiplied onto yellow = green
    expectPx(comp([bg, base, top])[0], [0, 255, 0, 255]);
  });

  it("group opacity 50 % composites the members first (isolation), unlike per-layer opacity", () => {
    const g = { ...newGroup("G"), blendMode: "NORMAL" as const, opacity: 0.5 };
    const bg = layer("bg", WHITE);
    const r = layer("r", [255, 0, 0], 0, 4, { groupId: g.id });
    const b = layer("b", [0, 0, 255], 0, 2, { groupId: g.id });
    const px = comp([bg, r, b], [g]);
    expectPx(px[0], [128, 128, 255, 255]); // only blue shows through the group, at 50 %
    expectPx(px[3], [255, 128, 128, 255]);
    // per-layer 50 % would have mixed red into the overlap
    const flat = comp([bg, layer("r", [255, 0, 0], 0, 4, { opacity: 0.5 }), layer("b", [0, 0, 255], 0, 2, { opacity: 0.5 })]);
    expect(near(flat[0], px[0], 4)).toBe(false);
  });

  it("pass-through lets members blend with what is below; a Normal group isolates them", () => {
    const pass = newGroup("P");
    const iso = { ...newGroup("N"), blendMode: "NORMAL" as const };
    const bg = layer("bg", [255, 255, 0]);
    const m1 = layer("m", [0, 255, 255], 0, 4, { groupId: pass.id, blendMode: "MULTIPLY" });
    expectPx(comp([bg, m1], [pass])[0], [0, 255, 0, 255]);
    const m2 = layer("m", [0, 255, 255], 0, 4, { groupId: iso.id, blendMode: "MULTIPLY" });
    expectPx(comp([bg, m2], [iso])[0], [0, 255, 255, 255]);
  });

  it("pass-through opacity fades between what was below and the result", () => {
    const pass = { ...newGroup("P"), opacity: 0.5 };
    const bg = layer("bg", WHITE);
    const r = layer("r", [255, 0, 0], 0, 4, { groupId: pass.id });
    const b = layer("b", [0, 0, 255], 0, 2, { groupId: pass.id });
    const px = comp([bg, r, b], [pass]);
    expectPx(px[0], [128, 128, 255, 255]);
    expectPx(px[3], [255, 128, 128, 255]);
  });

  it("nested groups multiply their opacity; a hidden group hides its members", () => {
    const outer = { ...newGroup("O"), blendMode: "NORMAL" as const, opacity: 0.5 };
    const inner = { ...newGroup("I", outer.id), opacity: 0.5 };
    const bg = layer("bg", WHITE);
    const r = layer("r", [255, 0, 0], 0, 4, { groupId: inner.id });
    expectPx(comp([bg, r], [outer, inner])[0], [255, 191, 191, 255]);
    const hidden = { ...outer, visible: false };
    expectPx(comp([bg, r], [hidden, inner])[0], [255, 255, 255, 255]);
  });

  it("a flat page composites exactly like before (no groups, no clipping)", () => {
    const bg = layer("bg", [10, 20, 30]);
    const a = layer("a", [200, 100, 50], 1, 3, { opacity: 0.4, blendMode: "SCREEN" });
    const px = comp([bg, a]);
    expectPx(px[0], [10, 20, 30, 255]);
    // screen: cb + cs − cb·cs, mixed at 40 %
    const s = (cb: number, cs: number) => cb + cs - (cb * cs) / 255;
    expectPx(px[1], [0.6 * 10 + 0.4 * s(10, 200), 0.6 * 20 + 0.4 * s(20, 100), 0.6 * 30 + 0.4 * s(30, 50), 255]);
  });
});
