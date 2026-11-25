// 2026-11-24, features-ps-ai.md (Illustrator): a click with the selection tool picks the whole group, the direct
// selection tool one object; a top-level folder of an opened .ai / .svg (a layer) or a CAD layer is not a group.
import { describe, expect, it } from "vitest";
import { newPage, newVector, type LayerGroup, type VectorNode } from "../src/core/types";
import { corner } from "../src/core/vector";
import { groupPick } from "../src/ui/transformAgain";

function rect(name: string, x: number, groupId?: string): VectorNode {
  const v = newVector([{ closed: true, nodes: [corner(x, 0), corner(x + 10, 0), corner(x + 10, 10), corner(x, 10)] }], name);
  if (groupId) v.groupId = groupId;
  return v;
}
const group = (id: string, parentId: string | null, extra: Partial<LayerGroup> = {}): LayerGroup => ({ id, name: id, parentId, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", ...extra });

describe("group click = group select (Illustrator)", () => {
  it("a loose object picks itself; a Ctrl+G group picks all its members, nested groups included", () => {
    const p = newPage("DESIGN", 800, 600, "아트보드 1");
    const a = rect("omni-a", 0), b = rect("omni-b", 20, "g1"), c = rect("omni-c", 40, "g2"), d = rect("omni-d", 60);
    p.nodes.push(a, b, c, d);
    p.groups = [group("g1", null), group("g2", "g1")];
    expect(groupPick(p, a)).toEqual([a.id]);
    expect(groupPick(p, c).sort()).toEqual([b.id, c.id].sort());
    expect(groupPick(p, b).sort()).toEqual([b.id, c.id].sort());
  });

  it("an .ai page's top-level layer is not a group: the group inside it is picked, a loose object in the layer alone", () => {
    const p = newPage("DESIGN", 800, 600, "아트보드 1");
    p.source = { ...(p.source ?? {}), format: "ai" } as typeof p.source;
    const a = rect("omni-a", 0, "layer"), b = rect("omni-b", 20, "g1"), c = rect("omni-c", 40, "g1");
    p.nodes.push(a, b, c);
    p.groups = [group("layer", null), group("g1", "layer")];
    expect(groupPick(p, a)).toEqual([a.id]);
    expect(groupPick(p, b).sort()).toEqual([b.id, c.id].sort());
  });

  it("a CAD layer is not a group either, and hidden / locked members stay out", () => {
    const p = newPage("DESIGN", 800, 600, "아트보드 1");
    const a = rect("omni-a", 0, "lay"), b = rect("omni-b", 20, "blk"), c = rect("omni-c", 40, "blk");
    c.locked = true;
    p.nodes.push(a, b, c);
    p.groups = [group("lay", null, { cad: { layer: "0" } as LayerGroup["cad"] }), group("blk", "lay")];
    expect(groupPick(p, a)).toEqual([a.id]);
    expect(groupPick(p, b)).toEqual([b.id]);
  });
});

describe("the design mode's right-click menu (Illustrator)", () => {
  it("shows only what applies: no selection = undo / paste / Select ▸; a selection adds the clipboard, group, Transform ▸ and Arrange ▸", async () => {
    const { useStore } = await import("../src/core/store");
    const { newDocument } = await import("../src/core/types");
    const { designContextItems } = await import("../src/ui/menus");
    const { t } = await import("../src/i18n");
    const S = () => useStore.getState();
    const doc = newDocument();
    const p = newPage("DESIGN", 800, 600, "아트보드 1");
    p.nodes.push(rect("omni-a", 0), rect("omni-b", 40));
    doc.pages = [p];
    S().load(doc);
    S().set({ pageId: p.id, selection: [], mode: "DESIGN" });
    const labels = (items: ReturnType<typeof designContextItems>) => items.filter((i) => !i.sep).map((i) => i.label);
    const empty = designContextItems();
    expect(labels(empty)).toContain(t("menu.sub.select"));
    expect(labels(empty)).not.toContain(t("menu.sub.arrange"));
    expect(empty.every((i) => !i.disabled)).toBe(true);
    S().set({ selection: [p.nodes[0].id, p.nodes[1].id] });
    const sel = designContextItems();
    expect(labels(sel)).toEqual(expect.arrayContaining([t("menu.sub.transform"), t("menu.sub.arrange"), t("menu.sub.select")]));
    expect(sel.length).toBeGreaterThan(empty.length);
    expect(sel[0].sep).toBeFalsy();
    expect(sel.at(-1)?.sep).toBeFalsy();
  });
});
