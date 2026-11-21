// Layer groups and clipping masks in the UI: group / ungroup (Ctrl+G / Ctrl+Shift+G), create / release clipping
// mask (Ctrl+Alt+G, Alt+click between two layers), group selection and properties, drag into / out of groups.
// The model lives in core/layerTree.ts (flat node list + page.groups).

import { create } from "zustand";
import { contiguousOrder, groupDescendants, groupIndex, groupMemberIds, groupPath } from "../core/layerTree";
import { moveIdsTo } from "../core/pages";
import { currentPage, draftPage, useStore } from "../core/store";
import { newGroup, type LayerGroup, type Page, type SceneNode } from "../core/types";
import { t } from "../i18n";

const S = () => useStore.getState();

/** Panel state: the group picked in the layers panel (its members are the selection) and folded folders. */
export const useLayersUI = create<{ activeGroup: string | null; folded: Record<string, boolean>; set: (p: Partial<{ activeGroup: string | null; folded: Record<string, boolean> }>) => void }>((set) => ({
  activeGroup: null,
  folded: {},
  set: (p) => set(p),
}));

/** Folded in the panel (view state, not an edit): the panel's choice, else the file's (Photoshop closed folder). */
export const isFolded = (g: LayerGroup) => useLayersUI.getState().folded[g.id] ?? !!g.collapsed;

export function toggleFolded(g: LayerGroup) {
  const ui = useLayersUI.getState();
  ui.set({ folded: { ...ui.folded, [g.id]: !isFolded(g) } });
}

/** The group picked in the panel, while the selection is still exactly its members. */
export function selectedGroup(page: Page | undefined = currentPage()): LayerGroup | null {
  const id = useLayersUI.getState().activeGroup;
  const g = id && page?.groups?.find((x) => x.id === id);
  if (!g || !page) return null;
  const members = groupMemberIds(page, g.id);
  const sel = S().selection;
  return members.length === sel.length && members.every((m) => sel.includes(m)) ? g : null;
}

/** Select a group: its members (all levels) become the selection, so move / transform / align act on them. */
export function selectGroup(groupId: string, add = false) {
  const page = currentPage();
  if (!page) return;
  const ids = groupMemberIds(page, groupId);
  const s = S();
  s.set({ selection: add ? [...new Set([...s.selection, ...ids])] : ids });
  useLayersUI.getState().set({ activeGroup: add ? null : groupId });
}

function nextGroupName(page: Page): string {
  return t("layers.group.name", { n: (page.groups?.length ?? 0) + 1 });
}

/** Ctrl+G: the selected layers into a new group (Pass Through, 100 %) where the top-most of them is. */
export function groupSelection() {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const sel = page.nodes.filter((n) => s.selection.includes(n.id));
  if (!sel.length) return s.notify(t("layers.toast.selectToGroup"));
  const index = groupIndex(page.groups);
  const paths = sel.map((n) => groupPath(n.groupId, index).map((g) => g.id));
  let common = paths[0];
  for (const p of paths) {
    let k = 0;
    while (k < common.length && k < p.length && common[k] === p[k]) k++;
    common = common.slice(0, k);
  }
  const parent = common.length ? common[common.length - 1] : null;
  const g = newGroup(nextGroupName(page), parent);
  const selIds = new Set(s.selection);
  // a subgroup whose members are all selected moves in whole; otherwise the selected layers are pulled in
  const whole = new Set<string>();
  const pulled = new Set<string>();
  sel.forEach((n, i) => {
    const sub = paths[i][common.length];
    if (sub && groupMemberIds(page, sub).every((id) => selIds.has(id))) whole.add(sub);
    else pulled.add(n.id);
  });
  s.commit(t("layers.hist.group"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups = [...(pg.groups ?? []), g] as any;
    for (const gr of pg.groups!) if (whole.has(gr.id)) gr.parentId = g.id;
    for (const n of pg.nodes) if (pulled.has(n.id)) n.groupId = g.id;
  });
  useLayersUI.getState().set({ activeGroup: g.id });
}

/** Ctrl+Shift+G: dissolve the picked group, or the innermost group of each selected layer (members stay in place). */
export function ungroupSelection() {
  const s = S();
  const page = currentPage();
  if (!page?.groups?.length) return s.notify(t("layers.toast.noGroup"));
  const picked = selectedGroup(page);
  const targets = new Set<string>();
  if (picked) targets.add(picked.id);
  else for (const n of page.nodes) if (s.selection.includes(n.id) && n.groupId) targets.add(n.groupId);
  if (!targets.size) return s.notify(t("layers.toast.noGroup"));
  dissolveGroups(page.id, [...targets]);
  useLayersUI.getState().set({ activeGroup: null });
}

export function dissolveGroups(pageId: string, ids: string[]) {
  const set = new Set(ids);
  S().commit(t("layers.hist.ungroup"), (d) => {
    const pg = draftPage(d, pageId);
    if (!pg?.groups) return;
    const parentOf = (id: string): string | null => {
      let p = pg.groups!.find((g) => g.id === id)?.parentId ?? null;
      while (p && set.has(p)) p = pg.groups!.find((g) => g.id === p)?.parentId ?? null;
      return p;
    };
    for (const n of pg.nodes)
      if (n.groupId && set.has(n.groupId)) {
        const p = parentOf(n.groupId);
        if (p) n.groupId = p;
        else delete n.groupId;
      }
    for (const g of pg.groups) if (g.parentId && set.has(g.parentId)) g.parentId = parentOf(g.parentId);
    pg.groups = pg.groups.filter((g) => !set.has(g.id)) as any;
    if (!pg.groups!.length) delete pg.groups;
  });
}

/** Is there a layer or group under `id` inside its own group (something it can be clipped to)? */
export function canClip(page: Page, id: string): boolean {
  return clippable(page, [id]).has(id);
}

/** Of `ids`, the layers that are clipped or can be (one pass over the page, however many are selected). */
export function clippable(page: Page, ids: readonly string[]): Set<string> {
  const want = new Set(ids);
  const out = new Set<string>();
  if (!want.size) return out;
  const order = contiguousOrder(page.nodes, page.groups);
  const index = groupIndex(page.groups);
  const path = (n: SceneNode) => groupPath(n.groupId, index).map((g) => g.id);
  order.forEach((n, i) => {
    if (!want.has(n.id)) return;
    if (n.clip) return void out.add(n.id);
    if (i < 1) return;
    const mine = path(n), below = path(order[i - 1]);
    if (mine.every((g, k) => below[k] === g)) out.add(n.id);
  });
  return out;
}

/** Ctrl+Alt+G: create the clipping mask for the selected layers (onto what is below), or release it when all are clipped. */
export function toggleClipping(ids: string[] = S().selection) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const ok = clippable(page, ids);
  const nodes = page.nodes.filter((n) => ok.has(n.id));
  if (!nodes.length) return s.notify(t("layers.toast.nothingToClip"));
  const make = nodes.some((n) => !n.clip);
  const set = new Set(nodes.map((n) => n.id));
  if (!make) {
    // Release (Photoshop): the layer and the clipped layers above it leave the clipping mask — otherwise they
    // would silently move onto the released layer as their new base
    const order = contiguousOrder(page.nodes, page.groups);
    order.forEach((n, i) => {
      if (!set.has(n.id)) return;
      for (let j = i + 1; j < order.length && order[j].clip && (order[j].groupId ?? "") === (n.groupId ?? ""); j++) set.add(order[j].id);
    });
  }
  s.commit(t(make ? "layers.hist.clip" : "layers.hist.unclip"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const n of pg.nodes)
      if (set.has(n.id)) {
        if (make) n.clip = true;
        else delete n.clip;
      }
  });
}

export const clipToggleUsable = () => {
  const page = currentPage();
  const sel = S().selection;
  return !!page && clippable(page, sel).size > 0;
};
export const allClipped = () => {
  const page = currentPage();
  const sel = page?.nodes.filter((n) => S().selection.includes(n.id)) ?? [];
  return sel.length > 0 && sel.every((n) => n.clip);
};
export const ungroupUsable = () => {
  const page = currentPage();
  return !!page?.groups?.length && (!!selectedGroup(page) || page.nodes.some((n) => S().selection.includes(n.id) && !!n.groupId));
};

/** Change a group's settings (name, opacity, blend, eye, lock) — one undo step. */
export function updateGroup(groupId: string, label: string, recipe: (g: LayerGroup) => void) {
  const s = S();
  s.commit(label, (d) => {
    const g = draftPage(d, s.pageId)?.groups?.find((x) => x.id === groupId);
    if (g) recipe(g as LayerGroup);
  });
}

/**
 * Drop layers (or a whole group) in the panel: `ids` move to stored index `target` and land at level `into`
 * (a group id, null = top level). A dragged group keeps its own members and becomes a child of `into`.
 */
export function dropLayers(ids: string[], target: number, into: string | null, draggedGroup: string | null = null) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  if (draggedGroup && into && groupDescendants(page.groups, draggedGroup).has(into)) return; // not into itself
  const order = moveIdsTo(page.nodes, ids, target);
  const pos = new Map(order.map((n, i) => [n.id, i]));
  const moving = new Set(ids);
  s.commit(ids.length > 1 ? t("ribbon.layer.reorderN", { n: ids.length }) : t("ribbon.layer.reorder"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    if (draggedGroup) {
      const g = pg.groups?.find((x) => x.id === draggedGroup);
      if (g) g.parentId = into;
    } else
      for (const n of pg.nodes as SceneNode[])
        if (moving.has(n.id)) {
          if (into) n.groupId = into;
          else delete n.groupId;
        }
    pg.nodes.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
  });
}

/** Delete the picked group with everything in it (Delete with a group picked in the panel). */
export function deleteGroupWithMembers(groupId: string) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const groups = groupDescendants(page.groups, groupId);
  const ids = new Set(groupMemberIds(page, groupId));
  s.commit(t("layers.hist.deleteGroup"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.nodes = pg.nodes.filter((n) => !ids.has(n.id) || n.locked);
    pg.animations = pg.animations.filter((a) => !ids.has(a.targetNodeId));
    // a locked member keeps its group — and the groups around it — alive
    const index = groupIndex(pg.groups as LayerGroup[]);
    const kept = new Set(pg.nodes.flatMap((n) => groupPath(n.groupId, index).map((g) => g.id)));
    pg.groups = (pg.groups ?? []).filter((g) => !groups.has(g.id) || kept.has(g.id)) as any;
    if (!pg.groups!.length) delete pg.groups;
  });
  s.set({ selection: [] });
  useLayersUI.getState().set({ activeGroup: null });
}

export type LayerRowItem =
  | { kind: "group"; group: LayerGroup; depth: number; members: string[]; top: number; bottom: number }
  | { kind: "node"; node: SceneNode; depth: number; index: number; clipped: boolean };

/**
 * Rows of the layers panel, top of the stack first: folders (with their members indented below unless folded),
 * layers, clipped layers marked (only where they really clip — not the bottom layer of a group).
 */
export function layerRows(page: Pick<Page, "nodes" | "groups">, folded: (g: LayerGroup) => boolean): LayerRowItem[] {
  type T = { n: SceneNode } | { g: LayerGroup; kids: T[] };
  const index = groupIndex(page.groups);
  const order = contiguousOrder(page.nodes, page.groups);
  const at = new Map(page.nodes.map((n, i) => [n.id, i]));
  const root: T[] = [];
  const stack: { g: LayerGroup; kids: T[] }[] = [];
  const seen = new Set<string>();
  for (const n of order) {
    const path = groupPath(n.groupId, index);
    let k = 0;
    while (k < stack.length && k < path.length && stack[k].g.id === path[k].id) k++;
    stack.length = k;
    for (; k < path.length; k++) {
      const kids: T[] = [];
      (stack.length ? stack[stack.length - 1].kids : root).push({ g: path[k], kids });
      stack.push({ g: path[k], kids });
      seen.add(path[k].id);
    }
    (stack.length ? stack[stack.length - 1].kids : root).push({ n });
  }
  // empty groups: on top of their parent
  const place = (list: T[], parent: string | null) => {
    for (const g of page.groups ?? []) if (!seen.has(g.id) && (g.parentId ?? null) === parent) (seen.add(g.id), list.push({ g, kids: [] }));
    for (const t of list) if ("g" in t) place(t.kids, t.g.id);
  };
  place(root, null);
  const out: LayerRowItem[] = [];
  const members = (t: T): string[] => ("n" in t ? [t.n.id] : t.kids.flatMap(members));
  const emit = (list: T[], depth: number) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const t = list[i];
      if ("n" in t) out.push({ kind: "node", node: t.n, depth, index: at.get(t.n.id) ?? 0, clipped: !!t.n.clip && i > 0 });
      else {
        const ids = members(t);
        const idx = ids.map((id) => at.get(id) ?? 0);
        out.push({ kind: "group", group: t.g, depth, members: ids, top: idx.length ? Math.max(...idx) : page.nodes.length - 1, bottom: idx.length ? Math.min(...idx) : page.nodes.length });
        if (!folded(t.g)) emit(t.kids, depth + 1);
      }
    }
  };
  emit(root, 0);
  return out;
}
