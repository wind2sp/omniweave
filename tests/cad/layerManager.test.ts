// The drawing page layer manager (ui/cad/layers.ts, ISSUES-2026-11-19 item 1): the panel lists drawing layers and
// AutoCAD GROUPs, never entities; current layer, on / freeze / lock on drawing and picking, rename / new / delete
// rules, QSELECT, moving a selection to another layer, and the .omw round trip of layer properties.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentPage, useStore } from "../../src/core/store";
import { resetSessionsForTest } from "../../src/core/sessions";
import { groupIndex, pickableOn, shownInTree } from "../../src/core/layerTree";
import { newDocument, type Page } from "../../src/core/types";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { openInTab } from "../../src/ui/actions";
import "../../src/ui/tabs";
import { useCadScreen } from "../../src/ui/editModes";
import { cancel, currentLayer, submit } from "../../src/ui/cad/engine";
import {
  applyQselect, cadLayers, cadPanelModel, deleteLayer, makeCurrent, moveToLayer, newLayer, nodeColor, nodeLayer, qselect, qselectOptions, renameLayer, setLayerColor, setLayerFrozen,
  setLayerLocked, setLayerLtype, setLayerLw, setLayerOn, setLayerPlot, setLayerTransparency,
} from "../../src/ui/cad/layers";

const S = () => useStore.getState();
const pg = () => currentPage()! as Page;
const layerId = (name: string) => cadLayers(pg()).find((g) => g.cad!.layer === name)!.id;
const group = (name: string) => cadLayers(pg()).find((g) => g.cad!.layer === name)!;

function drawLine(): string {
  const before = new Set(pg().nodes.map((n) => n.id));
  submit("L");
  submit("10,10");
  submit("@40,0");
  submit("");
  cancel(true);
  return pg().nodes.find((n) => !before.has(n.id))!.id;
}

describe("drawing page layer manager", () => {
  beforeAll(() => useCadScreen.getState().set(true));
  beforeEach(async () => {
    S().load(newDocument());
    resetSessionsForTest();
    cancel(true);
    const bytes = new Uint8Array(readFileSync("tests/fixtures/cad/omni-cad-basic.dxf"));
    await openInTab({ name: "omni-cad-basic.dxf", path: null, bytes });
    S().set({ selection: [] });
  });

  it("lists the drawing layers (and AutoCAD GROUPs), never entities", () => {
    const rows = cadPanelModel(pg());
    const layers = cadLayers(pg());
    expect(layers.length).toBeGreaterThan(0);
    expect(rows.filter((r) => r.kind === "layer").map((r) => (r.kind === "layer" ? r.name : ""))).toEqual(layers.map((g) => g.cad!.layer));
    expect(rows.length).toBe(layers.length);
    expect(pg().nodes.length).toBeGreaterThan(rows.length);
    const ids = new Set(pg().nodes.map((n) => n.id));
    expect(rows.some((r) => r.kind === "layer" && ids.has(r.id))).toBe(false);
    // entity counts add up to every entity
    expect(rows.reduce((s, r) => s + (r.kind === "layer" ? r.count : 0), 0)).toBe(pg().nodes.length);
    expect(rows.filter((r) => r.kind === "layer" && r.current).length).toBe(1);
    // an AutoCAD GROUP is one row with its members
    const two = pg().nodes.slice(0, 2).map((n) => n.id);
    S().commit("g", (d) => {
      d.pages.find((p) => p.id === pg().id)!.source!.cad!.groups = [{ name: "G1", ids: two }];
    });
    const g = cadPanelModel(pg()).filter((r) => r.kind === "group");
    expect(g).toEqual([{ kind: "group", name: "G1", ids: two }]);
  });

  it("set current: newly drawn entities go to the current layer; a frozen layer cannot be current", () => {
    const r = newLayer(pg(), "omni-walls");
    expect("id" in r).toBe(true);
    expect(makeCurrent(pg(), layerId("omni-walls"))).toBeNull();
    expect(currentLayer()).toBe("omni-walls");
    expect(cadPanelModel(pg()).find((x) => x.kind === "layer" && x.current)).toMatchObject({ name: "omni-walls" });
    const id = drawLine();
    expect(nodeLayer(pg(), pg().nodes.find((n) => n.id === id)!)).toBe("omni-walls");
    // current layer cannot be frozen; another frozen layer cannot be made current
    expect(setLayerFrozen(pg(), layerId("omni-walls"), true)).toBe("cadlm.err.freezeCurrent");
    expect(newLayer(pg(), "omni-ice")).toHaveProperty("id");
    expect(setLayerFrozen(pg(), layerId("omni-ice"), true)).toBeNull();
    expect(makeCurrent(pg(), layerId("omni-ice"))).toBe("cadlm.err.frozenCurrent");
    expect(currentLayer()).toBe("omni-walls");
  });

  it("off, freeze and lock: what is drawn and what can be picked", () => {
    newLayer(pg(), "omni-a");
    makeCurrent(pg(), layerId("omni-a"));
    const id = drawLine();
    makeCurrent(pg(), cadLayers(pg()).find((g) => g.cad!.layer !== "omni-a")!.id);
    const node = () => pg().nodes.find((n) => n.id === id)!;
    const shown = () => shownInTree(node(), groupIndex(pg().groups!));
    const pickable = () => pickableOn(pg())(node());
    expect(shown() && pickable()).toBe(true);
    // off
    setLayerOn(pg(), layerId("omni-a"), false);
    expect([shown(), pickable()]).toEqual([false, false]);
    expect(qselect(pg(), { layer: "omni-a" })).toEqual([]);
    setLayerOn(pg(), layerId("omni-a"), true);
    expect(shown()).toBe(true);
    // freeze, and off while frozen stays off after the thaw
    setLayerFrozen(pg(), layerId("omni-a"), true);
    expect([shown(), pickable()]).toEqual([false, false]);
    expect(cadPanelModel(pg()).find((r) => r.kind === "layer" && r.name === "omni-a")).toMatchObject({ frozen: true, on: true });
    setLayerOn(pg(), layerId("omni-a"), false);
    setLayerFrozen(pg(), layerId("omni-a"), false);
    expect(shown()).toBe(false);
    expect(group("omni-a").cad!.frozen).toBeUndefined();
    setLayerOn(pg(), layerId("omni-a"), true);
    expect(shown()).toBe(true);
    // lock: drawn but not picked
    setLayerLocked(pg(), layerId("omni-a"), true);
    expect([shown(), pickable()]).toEqual([true, false]);
    setLayerLocked(pg(), layerId("omni-a"), false);
    expect(pickable()).toBe(true);
  });

  it("rename, new and delete follow AutoCAD's rules", () => {
    const zero = cadLayers(pg()).find((g) => g.cad!.layer === "0");
    if (zero) {
      expect(renameLayer(pg(), zero.id, "omni-x")).toBe("cadlm.err.renameZero");
      expect(deleteLayer(pg(), zero.id)).toBe("cadlm.err.deleteZero");
    }
    // new: Layer1, Layer2 … and no duplicates (case-insensitive) or bad characters
    const a = newLayer(pg());
    const b = newLayer(pg());
    expect("id" in a && "id" in b).toBe(true);
    const na = pg().groups!.find((g) => "id" in a && g.id === a.id)!.cad!.layer!;
    const nb = pg().groups!.find((g) => "id" in b && g.id === b.id)!.cad!.layer!;
    expect(na).not.toBe(nb);
    expect(newLayer(pg(), na.toLowerCase())).toEqual({ error: "cadlm.err.exists" });
    expect(newLayer(pg(), "a<b")).toEqual({ error: "cadlm.err.badName" });
    // rename: the current layer stays current under its new name
    makeCurrent(pg(), layerId(na));
    expect(renameLayer(pg(), layerId(na), nb)).toBe("cadlm.err.exists");
    expect(renameLayer(pg(), layerId(na), "omni-renamed")).toBeNull();
    expect(currentLayer()).toBe("omni-renamed");
    expect(group("omni-renamed").name).toBe("omni-renamed");
    // delete: not the current one, not one with objects; an empty one goes (undoable)
    expect(deleteLayer(pg(), layerId("omni-renamed"))).toBe("cadlm.err.deleteCurrent");
    makeCurrent(pg(), layerId(nb));
    drawLine();
    makeCurrent(pg(), layerId("omni-renamed"));
    expect(deleteLayer(pg(), layerId(nb))).toBe("cadlm.err.deleteUsed");
    const n = cadLayers(pg()).length;
    makeCurrent(pg(), cadLayers(pg()).find((g) => g.cad!.layer !== "omni-renamed")!.id);
    expect(deleteLayer(pg(), layerId("omni-renamed"))).toBeNull();
    expect(cadLayers(pg()).length).toBe(n - 1);
    S().undo();
    expect(cadLayers(pg()).length).toBe(n);
  });

  it("QSELECT picks by object type, layer and colour", () => {
    newLayer(pg(), "omni-q");
    makeCurrent(pg(), layerId("omni-q"));
    const a = drawLine();
    const b = drawLine();
    setLayerColor(pg(), layerId("omni-q"), "#FF00FF");
    const o = qselectOptions(pg());
    expect(o.layers).toContain("omni-q");
    expect(o.colors).toContain("#ff00ff");
    expect(qselect(pg(), { layer: "OMNI-Q" }).sort()).toEqual([a, b].sort());
    expect(qselect(pg(), { color: "#ff00ff", layer: "omni-q" }).sort()).toEqual([a, b].sort());
    const kind = pg().nodes.find((n) => n.id === a)!.name;
    expect(qselect(pg(), { kind })).toEqual(expect.arrayContaining([a, b]));
    expect(qselect(pg(), { kind: "TEXT", layer: "omni-q" })).toEqual([]);
    expect(applyQselect(pg(), { layer: "omni-q" })).toBe(2);
    expect(S().selection.sort()).toEqual([a, b].sort());
    // layer colour change followed the ByLayer lines
    expect(nodeColor(pg().nodes.find((n) => n.id === a)!)).toBe("#ff00ff");
  });

  it("moves the selection to another layer, colour following ByLayer", () => {
    newLayer(pg(), "omni-from");
    newLayer(pg(), "omni-to");
    setLayerColor(pg(), layerId("omni-to"), "#00ff00");
    makeCurrent(pg(), layerId("omni-from"));
    const a = drawLine();
    moveToLayer(pg(), [a], "omni-to");
    const n = pg().nodes.find((x) => x.id === a)!;
    expect(nodeLayer(pg(), n)).toBe("omni-to");
    expect(nodeColor(n)).toBe("#00ff00");
    expect(cadPanelModel(pg()).find((r) => r.kind === "layer" && r.name === "omni-to")).toMatchObject({ count: 1 });
  });

  it("a text of several nodes moves as one, every part's ByLayer colour following (QA 11-20)", () => {
    newLayer(pg(), "omni-from");
    newLayer(pg(), "omni-to");
    setLayerColor(pg(), layerId("omni-from"), "#ff0000");
    setLayerColor(pg(), layerId("omni-to"), "#00ff00");
    makeCurrent(pg(), layerId("omni-from"));
    const a = drawLine(), b = drawLine();
    const from = layerId("omni-from");
    S().commit("t", (d) => {
      const p = d.pages.find((x) => x.id === pg().id)!;
      p.groups!.push({ id: "omni-tg", name: "t", parentId: from, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", collapsed: true, cad: { text: true } as any });
      for (const n of p.nodes) if (n.id === a || n.id === b) n.groupId = "omni-tg";
    });
    expect([a, b].map((id) => nodeColor(pg().nodes.find((x) => x.id === id)!))).toEqual(["#ff0000", "#ff0000"]);
    moveToLayer(pg(), [a, b], "omni-to");
    expect([a, b].map((id) => nodeColor(pg().nodes.find((x) => x.id === id)!))).toEqual(["#00ff00", "#00ff00"]);
    expect(pg().groups!.find((g) => g.id === "omni-tg")!.parentId).toBe(layerId("omni-to"));
    S().undo();
    expect([a, b].map((id) => nodeColor(pg().nodes.find((x) => x.id === id)!))).toEqual(["#ff0000", "#ff0000"]);
  });

  it("layer properties survive the .omw round trip", () => {
    newLayer(pg(), "omni-keep");
    const id = layerId("omni-keep");
    makeCurrent(pg(), id);
    drawLine();
    makeCurrent(pg(), cadLayers(pg()).find((g) => g.id !== id)!.id);
    setLayerColor(pg(), id, "#123456");
    setLayerLtype(pg(), id, "DASHED");
    setLayerLw(pg(), id, 0.5);
    setLayerTransparency(pg(), id, 40);
    setLayerPlot(pg(), id, false);
    setLayerLocked(pg(), id, true);
    setLayerFrozen(pg(), id, true);
    const { bytes } = packOmw(S().doc);
    const { doc } = unpackOmw(bytes);
    const page = doc.pages.find((p) => p.id === pg().id)! as Page;
    const row = cadPanelModel(page).find((r) => r.kind === "layer" && r.name === "omni-keep");
    expect(row).toMatchObject({ color: "#123456", ltype: "DASHED", lw: 0.5, transparency: 40, plot: false, locked: true, frozen: true, count: 1 });
    expect(page.groups!.find((g) => g.id === id)!.visible).toBe(false);
  });
});
