// Layer group / clipping commands on the store: Ctrl+G, Ctrl+Shift+G, Ctrl+Alt+G, panel rows, drag into groups,
// arrange inside a group, merge down of a clipped layer, undo, and the .omw round trip of the new fields.
import { beforeEach, describe, expect, it } from "vitest";
import { useStore } from "../../src/core/store";
import { newDocument, newGroup, newPage, newVector, type RasterNode, type SceneNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { rasterFromRgba } from "../../src/io/formats/raster";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { reorderSelected } from "../../src/ui/actions";
import { COMMANDS } from "../../src/ui/commands";
import { canClip, dropLayers, groupSelection, layerRows, selectGroup, selectedGroup, toggleClipping, ungroupSelection, useLayersUI } from "../../src/ui/groups";
import { mergeDown, mergeDownPair } from "../../src/ui/menuActions";
import { menuCommandIds } from "../../src/ui/menus";
import { rasterPixels } from "../../src/io/formats/psdWrite";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
const names = () => page().nodes.map((n) => n.name);
const byName = (name: string) => page().nodes.find((n) => n.name === name)!;

function rect(name: string, extra: Partial<SceneNode> = {}) {
  return { ...newVector([rectContour(0, 0, 10, 10)]), name, ...extra } as SceneNode;
}

function load(nodes: SceneNode[], groups?: any[]) {
  const doc = newDocument("t");
  const p = newPage("DESIGN", 100, 100, "P");
  p.nodes = nodes;
  if (groups) p.groups = groups;
  doc.pages = [p];
  S().load(doc);
  useLayersUI.getState().set({ activeGroup: null, folded: {} });
}

function solid(name: string, w: number, h: number, rgba: number[], extra: Partial<RasterNode> = {}): RasterNode {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return { ...rasterFromRgba(px, w, h, name), ...extra };
}

beforeEach(() => load([rect("a"), rect("b"), rect("c"), rect("d")]));

describe("group commands", () => {
  it("Ctrl+G groups the selection where its top-most layer is; undo restores", () => {
    S().set({ selection: [byName("a").id, byName("c").id] });
    groupSelection();
    const g = page().groups![0];
    expect(g).toMatchObject({ parentId: null, blendMode: "PASS_THROUGH", opacity: 1 });
    expect(names()).toEqual(["b", "a", "c", "d"]);
    expect(byName("a").groupId).toBe(g.id);
    expect(byName("b").groupId).toBeUndefined();
    expect(selectedGroup()?.id).toBe(g.id);
    S().undo();
    expect(page().groups).toBeUndefined();
    expect(names()).toEqual(["a", "b", "c", "d"]);
  });

  it("grouping a whole subgroup nests it; Ctrl+Shift+G on a picked group dissolves only that group", () => {
    S().set({ selection: [byName("b").id, byName("c").id] });
    groupSelection();
    const inner = page().groups![0];
    selectGroup(inner.id);
    S().set({ selection: [...S().selection, byName("d").id] });
    groupSelection();
    const outer = page().groups!.find((g) => g.id !== inner.id)!;
    expect(page().groups!.find((g) => g.id === inner.id)!.parentId).toBe(outer.id);
    expect(byName("d").groupId).toBe(outer.id);
    selectGroup(outer.id);
    expect(S().selection.sort()).toEqual([byName("b").id, byName("c").id, byName("d").id].sort());
    ungroupSelection();
    expect(page().groups!.map((g) => g.id)).toEqual([inner.id]);
    expect(page().groups![0].parentId).toBeNull();
    expect(byName("d").groupId).toBeUndefined();
    expect(byName("b").groupId).toBe(inner.id);
  });

  it("commands are registered with Photoshop shortcuts and appear in a menu", () => {
    const ids = ["image.groupLayers", "image.ungroupLayers", "image.clippingMask"];
    for (const id of ids) expect(menuCommandIds()).toContain(id);
    expect(COMMANDS.find((c) => c.id === "image.groupLayers")!.kbd).toBe("Ctrl+G");
    expect(COMMANDS.find((c) => c.id === "image.ungroupLayers")!.kbd).toBe("Ctrl+Shift+G");
    expect(COMMANDS.find((c) => c.id === "image.clippingMask")!.kbd).toBe("Ctrl+Alt+G");
    const kbds = COMMANDS.map((c) => c.kbd).filter(Boolean);
    expect(new Set(kbds).size).toBe(kbds.length);
  });
});

describe("clipping commands", () => {
  it("Ctrl+Alt+G clips the selected layer onto the one below and releases it again", () => {
    S().set({ selection: [byName("b").id] });
    toggleClipping();
    expect(byName("b").clip).toBe(true);
    toggleClipping();
    expect(byName("b").clip).toBeUndefined();
  });

  it("the bottom layer of a group (nothing below inside it) cannot be clipped", () => {
    const g = newGroup("G");
    load([rect("a"), rect("b", { groupId: g.id }), rect("c", { groupId: g.id })], [g]);
    expect(canClip(page(), byName("b").id)).toBe(false);
    expect(canClip(page(), byName("c").id)).toBe(true);
    S().set({ selection: [byName("b").id] });
    toggleClipping();
    expect(byName("b").clip).toBeUndefined();
  });
});

describe("panel rows and drag & drop", () => {
  it("rows are top first, members indented under their folder, clipped layers marked only when they clip", () => {
    const g = newGroup("G");
    load([rect("bottom", { clip: true }), rect("m1", { groupId: g.id, clip: true }), rect("m2", { groupId: g.id, clip: true }), rect("top")], [g]);
    const rows = layerRows(page(), () => false);
    expect(rows.map((r) => (r.kind === "group" ? `G${r.depth}` : `${r.node.name}${r.depth}${r.clipped ? "c" : ""}`))).toEqual(["top0", "G0", "m21c", "m11", "bottom0"]);
    expect(layerRows(page(), () => true).map((r) => (r.kind === "group" ? "G" : r.node.name))).toEqual(["top", "G", "bottom"]);
  });

  it("dropping a layer onto a folder moves it into the folder; next to a layer, into that layer's level", () => {
    const g = newGroup("G");
    load([rect("a"), rect("m", { groupId: g.id }), rect("b")], [g]);
    const row = layerRows(page(), () => false).find((r) => r.kind === "group")!;
    if (row.kind !== "group") throw new Error();
    dropLayers([byName("b").id], row.top + 1, g.id);
    expect(byName("b").groupId).toBe(g.id);
    expect(names()).toEqual(["a", "m", "b"]);
    dropLayers([byName("b").id], 0, null);
    expect(byName("b").groupId).toBeUndefined();
    expect(names()).toEqual(["b", "a", "m"]);
  });

  it("dragging a group re-parents it, never into itself", () => {
    const g = newGroup("G"), h = newGroup("H");
    load([rect("g1", { groupId: g.id }), rect("h1", { groupId: h.id })], [g, h]);
    dropLayers([byName("g1").id], 2, h.id, g.id);
    expect(page().groups!.find((x) => x.id === g.id)!.parentId).toBe(h.id);
    const before = page();
    dropLayers([byName("h1").id, byName("g1").id], 0, g.id, h.id);
    expect(page()).toBe(before);
  });

  it("bring forward / to front stay inside the layer's group", () => {
    const g = newGroup("G");
    load([rect("a"), rect("m1", { groupId: g.id }), rect("m2", { groupId: g.id }), rect("b")], [g]);
    S().set({ selection: [byName("m1").id] });
    reorderSelected("top");
    expect(names()).toEqual(["a", "m2", "m1", "b"]);
    reorderSelected("up");
    expect(names()).toEqual(["a", "m2", "m1", "b"]);
    S().set({ selection: [byName("a").id] });
    reorderSelected("up");
    // a whole group is one step
    expect(names()).toEqual(["m2", "m1", "a", "b"]);
  });
});

describe("merge down with clipping", () => {
  it("a clipped layer merges into its base, clipped, and the base keeps its opacity", () => {
    const base = solid("base", 2, 1, [255, 0, 0, 255], { opacity: 0.5 });
    const top = solid("top", 4, 1, [0, 0, 255, 255], { clip: true });
    load([base, top]);
    S().set({ selection: [top.id] });
    expect(mergeDownPair(page(), S().selection)).not.toBeNull();
    mergeDown();
    const merged = page().nodes[0] as RasterNode;
    expect(page().nodes).toHaveLength(1);
    expect(merged.opacity).toBe(0.5);
    const px = rasterPixels(merged)!;
    // only the base's 2 pixels, now blue
    expect(px.width).toBe(2);
    expect(Array.from(px.rgba.subarray(0, 4))).toEqual([0, 0, 255, 255]);
  });

  it("an unclipped layer cannot merge into a clipped one, nor across a group boundary", () => {
    const g = newGroup("G");
    const a = solid("a", 2, 1, [255, 0, 0, 255]);
    const b = solid("b", 2, 1, [0, 255, 0, 255], { clip: true });
    const c = solid("c", 2, 1, [0, 0, 255, 255]);
    load([a, b, c]);
    expect(mergeDownPair(page(), [c.id])).toBeNull();
    const d = solid("d", 2, 1, [0, 0, 255, 255], { groupId: g.id });
    load([a, d], [g]);
    expect(mergeDownPair(page(), [d.id])).toBeNull();
  });
});

describe(".omw", () => {
  it("groups and clipping survive save / open; files without them load as before", () => {
    const g = { ...newGroup("G"), opacity: 0.4, blendMode: "MULTIPLY" as const };
    load([rect("a", { groupId: g.id }), rect("b", { groupId: g.id, clip: true })], [g]);
    const back = unpackOmw(packOmw(S().doc).bytes);
    const p = back.doc.pages[0];
    expect(p.groups).toEqual([g]);
    expect(p.nodes.map((n) => [n.groupId, n.clip])).toEqual([
      [g.id, undefined],
      [g.id, true],
    ]);
    load([rect("plain")]);
    const plain = unpackOmw(packOmw(S().doc).bytes).doc.pages[0];
    expect(plain.groups).toBeUndefined();
    expect("groupId" in plain.nodes[0]).toBe(false);
  });
});
