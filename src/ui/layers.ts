// Layer panel commands: new raster layer above the selection, duplicate in place, delete.
// Works the same on PSD pages (PSD Surgeon writes new / duplicated layers as standard records).

import { moveIdsTo } from "../core/pages";
import { currentPage, draftPage, useStore } from "../core/store";
import { newRaster, uid, type SceneNode } from "../core/types";
import { deleteSelected } from "./actions";
import { t } from "../i18n";
import { deleteGroupWithMembers, selectedGroup } from "./groups";

const S = () => useStore.getState();

/** New empty raster layer right above the top-most selected layer (or on top), selected. Ctrl+Shift+N. */
export function addLayer() {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const n = newRaster(t("ribbon.layer.name", { n: page.nodes.filter((x) => x.type === "RASTER").length + 1 }));
  const sel = new Set(s.selection);
  let at = page.nodes.length;
  for (let i = page.nodes.length - 1; i >= 0; i--)
    if (sel.has(page.nodes[i].id)) {
      at = i + 1;
      break;
    }
  s.commit(t("ribbon.layer.new"), (d) => void draftPage(d, s.pageId)?.nodes.splice(at, 0, n as any));
  S().set({ selection: [n.id] });
}

/** Duplicate the selected layers in place, each right above its original; the copies are selected. */
export function duplicateLayers() {
  const s = S();
  const page = currentPage();
  if (!page || !s.selection.length) return s.notify(t("ribbon.msg.selectToDuplicate"));
  const sel = new Set(s.selection);
  const copies: SceneNode[] = [];
  s.commit(t("ribbon.layer.duplicate"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const out: SceneNode[] = [];
    for (const n of pg.nodes as SceneNode[]) {
      out.push(n);
      if (sel.has(n.id)) {
        const c = { ...n, id: uid(), name: t("ribbon.layer.copyName", { name: n.name }) } as SceneNode;
        copies.push(c);
        out.push(c);
      }
    }
    pg.nodes = out as any;
  });
  S().set({ selection: copies.map((c) => c.id) });
}

/** Move layers (in their stacking order) to stored index `target` — one undo step. */
export function moveLayersTo(ids: string[], target: number) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const next = moveIdsTo(page.nodes, ids, target);
  if (next === page.nodes) return;
  const order = new Map(next.map((n, i) => [n.id, i]));
  s.commit(ids.length > 1 ? t("ribbon.layer.reorderN", { n: ids.length }) : t("ribbon.layer.reorder"), (d) => {
    draftPage(d, s.pageId)?.nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  });
}

export function deleteLayers() {
  const g = selectedGroup();
  if (g) return deleteGroupWithMembers(g.id);
  if (!S().selection.length) return S().notify(t("ribbon.msg.selectToDelete"));
  deleteSelected();
}
