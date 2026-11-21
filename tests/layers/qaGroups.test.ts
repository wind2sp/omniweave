// QA: groups / clipping — paste & duplicate keep the stack order, Release takes the clipped layers above along,
// deleting a group keeps the chain around a locked member, hidden / locked groups are not picked, SVG ids are
// unique across master and page, PPTX "crop to shape" keeps the base shape under the picture.
import { unzipSync, strFromU8 } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { useStore } from "../../src/core/store";
import { newDocument, newGroup, newImage, newPage, newVector, type LayerGroup, type SceneNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { exportSvg } from "../../src/io/export";
import { exportPptx } from "../../src/io/formats/pptx";
import { duplicateSelected, nodesAt, selectAll } from "../../src/ui/actions";
import { deleteGroupWithMembers, toggleClipping, useLayersUI } from "../../src/ui/groups";
import { copySelection, pasteClipboard } from "../../src/ui/menuActions";

const S = () => useStore.getState();
const page = () => S().doc.pages.find((p) => p.id === S().pageId)!;
const names = () => page().nodes.map((n) => n.name);
const byName = (name: string) => page().nodes.find((n) => n.name === name)!;
const rect = (name: string, extra: Partial<SceneNode> = {}) => ({ ...newVector([rectContour(0, 0, 10, 10)]), name, fill: "#ff0000", ...extra }) as SceneNode;

function load(nodes: SceneNode[], groups?: LayerGroup[]) {
  const doc = newDocument("t");
  const p = newPage("DESIGN", 100, 100, "P");
  p.nodes = nodes;
  if (groups) p.groups = groups;
  doc.pages = [p];
  S().load(doc);
  useLayersUI.getState().set({ activeGroup: null, folded: {} });
}

const G = { ...newGroup("G"), id: "gG" };
beforeEach(() => load([rect("a", { groupId: G.id }), rect("b", { groupId: G.id, clip: true }), rect("c"), rect("d")], [{ ...G }]));

describe("copies on top of the stack", () => {
  it("pasting a group member does not pull its whole group to the top", () => {
    S().set({ selection: [byName("a").id] });
    copySelection();
    pasteClipboard();
    expect(names().slice(0, 4)).toEqual(["a", "b", "c", "d"]);
    const pasted = page().nodes[4];
    expect(pasted.groupId).toBeUndefined();
    expect(pasted.clip).toBeUndefined();
  });

  it("duplicating a clipped member to an offset: top level, not clipped onto whatever is on top", () => {
    S().set({ selection: [byName("b").id] });
    duplicateSelected();
    expect(names().slice(0, 4)).toEqual(["a", "b", "c", "d"]);
    const dup = page().nodes[4];
    expect(dup.groupId).toBeUndefined();
    expect(dup.clip).toBeUndefined();
  });

  it("a copied clip stack stays a clip stack (the clipped copy keeps its flag)", () => {
    S().set({ selection: [byName("a").id, byName("b").id] });
    copySelection();
    pasteClipboard();
    const [pa, pb] = page().nodes.slice(4);
    expect(pa.clip).toBeUndefined();
    expect(pb.clip).toBe(true);
  });
});

describe("release clipping mask", () => {
  it("releasing a clipped layer releases the clipped layers above it too (Photoshop)", () => {
    load([rect("base"), rect("c1", { clip: true }), rect("c2", { clip: true }), rect("c3", { clip: true })]);
    S().set({ selection: [byName("c2").id] });
    toggleClipping();
    expect(page().nodes.map((n) => !!n.clip)).toEqual([false, true, false, false]);
    S().undo();
    expect(page().nodes.map((n) => !!n.clip)).toEqual([false, true, true, true]);
  });
});

describe("delete group", () => {
  it("a locked member in a subgroup keeps the subgroup and its parent", () => {
    const outer = { ...newGroup("outer"), id: "go" }, inner = { ...newGroup("inner", "go"), id: "gi" };
    load([rect("x", { groupId: "gi", locked: true }), rect("y", { groupId: "go" }), rect("z")], [outer, inner]);
    deleteGroupWithMembers("go");
    expect(names()).toEqual(["x", "z"]);
    expect(page().groups?.map((g) => `${g.id}<${g.parentId}`)).toEqual(["go<null", "gi<go"]);
  });
});

describe("hidden / locked groups on the canvas", () => {
  it("members of a hidden or locked group are not picked by click or Select All", () => {
    const hid = { ...newGroup("hid"), id: "gh", visible: false }, lock = { ...newGroup("lock"), id: "gl", locked: true };
    load([rect("free"), rect("inHidden", { groupId: "gh" }), rect("inLocked", { groupId: "gl" })], [hid, lock]);
    expect(nodesAt(5, 5).map((n) => n.name)).toEqual(["free"]);
    selectAll();
    expect(S().selection).toEqual([byName("free").id]);
  });
});

describe("exports", () => {
  it("SVG: clip ids are unique when the master and the page both have clip stacks", async () => {
    const doc = newDocument("t");
    const master = newPage("MASTER" as any, 100, 100, "M");
    master.nodes = [rect("mb"), rect("mc", { clip: true })];
    const p = newPage("SLIDE", 100, 100, "P");
    p.masterId = master.id;
    p.nodes = [rect("pb"), rect("pc", { clip: true })];
    doc.masters = [master];
    doc.pages = [p];
    const svg = await exportSvg(doc, p);
    const ids = [...svg.matchAll(/<(?:clipPath|mask) id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBe(2);
    expect(new Set(ids).size).toBe(2);
  });

  const png1x1 = () => {
    // a valid 1×1 PNG is not needed: exportPptx only embeds the bytes
    return new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  };

  it("PPTX: a picture clipped to a filled shape becomes a cropped picture over the shape itself", async () => {
    const doc = newDocument("t");
    const a = makeAsset(png1x1(), "image/png", "i.png");
    doc.assets[a.id] = a;
    const p = newPage("SLIDE", 100, 100, "P");
    const img = { ...newImage(a.id, 40, 40, "pic"), clip: true } as SceneNode;
    p.nodes = [rect("shape"), img];
    doc.pages = [p];
    const r = await exportPptx(doc, [p]);
    const xml = strFromU8(unzipSync(r.bytes)["ppt/slides/slide1.xml"]);
    expect(xml.indexOf("<p:sp>")).toBeGreaterThan(-1);
    expect(xml.indexOf("<p:sp>")).toBeLessThan(xml.indexOf("<p:pic>"));
    expect(r.warnings.length).toBe(1);
  });

  it("PPTX: a stroked base is not 'crop to shape' (the picture would miss the stroke) — painted as one picture", async () => {
    const doc = newDocument("t");
    const a = makeAsset(png1x1(), "image/png", "i.png");
    doc.assets[a.id] = a;
    const p = newPage("SLIDE", 100, 100, "P");
    const img = { ...newImage(a.id, 40, 40, "pic"), clip: true } as SceneNode;
    p.nodes = [rect("shape", { stroke: "#000000", strokeWidth: 4 } as any), img];
    doc.pages = [p];
    const calls: number[] = [];
    const r = await exportPptx(doc, [p], async (_d, _p, n) => (calls.push(Array.isArray(n) ? n.length : 1), { png: png1x1(), x: 0, y: 0, w: 10, h: 10 }));
    expect(calls).toEqual([2]);
    expect(r.warnings.length).toBe(1);
  });
});
