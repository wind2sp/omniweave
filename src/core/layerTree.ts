// Layer groups and clipping masks over the flat node list.
//
// The scene keeps one flat node list per page (bottom → top). A node may name a group (node.groupId → page.groups,
// groups nest through parentId) and may be clipped (node.clip). Everything that does not care about structure —
// selection, transform, undo, hashing, most exports — keeps working on the flat list; the renderer and the
// structure-aware exporters build a tree from it here.
//
// Photoshop semantics (public Photoshop documentation, "Layer groups", "Clipping masks", "Blending modes"):
//  • a clipped layer shows only where its clipping base — the nearest unclipped layer or group below it inside
//    the same group — has content; consecutive clipped layers share that base; a clipped layer with nothing below
//    it in its group is drawn unclipped.
//  • the base's opacity and blend mode apply to the whole clip stack ("blend clipped layers as group"): the base
//    and its clipped layers are composited on their own, then blended onto what is below.
//  • a hidden base hides its clipped layers.
//  • a Pass Through group adds no compositing step: members blend straight into what is below; its opacity fades
//    between what was below and the result. Any other blend mode isolates the group: members are composited on
//    their own first, then that result is blended with the group's opacity and mode.

import type { BlendMode, LayerGroup, Page, SceneNode } from "./types";
import type { Effect, StyleBlend } from "./style/types";
import { activeEffects } from "./style/effects";

export interface NodeItem {
  kind: "node";
  node: SceneNode;
  /** visible-or-not clipped layers on this base, bottom → top */
  clips: SceneNode[];
}

export interface GroupItem {
  kind: "group";
  group: LayerGroup;
  children: TreeItem[];
  clips: SceneNode[];
}

export type TreeItem = NodeItem | GroupItem;

const EMPTY: LayerGroup[] = [];

/** Group records of a page by id. */
export function groupIndex(groups: readonly LayerGroup[] | undefined): Map<string, LayerGroup> {
  return new Map((groups ?? EMPTY).map((g) => [g.id, g]));
}

/** Groups from the top level down to `groupId` (missing ids and cycles end the chain). */
export function groupPath(groupId: string | undefined, index: Map<string, LayerGroup>): LayerGroup[] {
  const out: LayerGroup[] = [];
  const seen = new Set<string>();
  let g = groupId ? index.get(groupId) : undefined;
  while (g && !seen.has(g.id)) {
    seen.add(g.id);
    out.unshift(g);
    g = g.parentId ? index.get(g.parentId) : undefined;
  }
  return out;
}

/** Does the page use groups or clipping at all? (memoized per node list) */
const plainMemo = new WeakMap<readonly SceneNode[], boolean>();
export function hasStructure(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined): boolean {
  if (groups?.length) return true;
  let v = plainMemo.get(nodes);
  if (v === undefined) {
    v = nodes.some((n) => n.clip || n.groupId);
    plainMemo.set(nodes, v);
  }
  return v;
}

const treeMemo = new WeakMap<readonly SceneNode[], { groups: readonly LayerGroup[] | undefined; tree: TreeItem[] }>();

/**
 * The page's layer tree. Members of a group that are not next to each other in the list (an edit that has not
 * been normalized yet) give the group more than one item — rendered correctly piece by piece, never lost.
 */
export function buildTree(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined): TreeItem[] {
  const m = treeMemo.get(nodes);
  if (m && m.groups === groups) return m.tree;
  const index = groupIndex(groups);
  const root: TreeItem[] = [];
  const stack: GroupItem[] = [];
  const container = () => (stack.length ? stack[stack.length - 1].children : root);
  for (const n of nodes) {
    const path = groupPath(n.groupId, index);
    let k = 0;
    while (k < stack.length && k < path.length && stack[k].group.id === path[k].id) k++;
    stack.length = k;
    for (; k < path.length; k++) {
      const gi: GroupItem = { kind: "group", group: path[k], children: [], clips: [] };
      container().push(gi);
      stack.push(gi);
    }
    const c = container();
    if (n.clip && c.length) c[c.length - 1].clips.push(n);
    else c.push({ kind: "node", node: n, clips: [] });
  }
  treeMemo.set(nodes, { groups, tree: root });
  return root;
}

/** Ids of the nodes inside a group, its subgroups included (stacking order). */
export function groupMemberIds(page: Pick<Page, "nodes" | "groups">, groupId: string): string[] {
  const index = groupIndex(page.groups);
  return page.nodes.filter((n) => groupPath(n.groupId, index).some((g) => g.id === groupId)).map((n) => n.id);
}

/** Group ids inside `groupId` (itself included). */
export function groupDescendants(groups: readonly LayerGroup[] | undefined, groupId: string): Set<string> {
  const out = new Set([groupId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const g of groups ?? EMPTY)
      if (g.parentId && out.has(g.parentId) && !out.has(g.id)) {
        out.add(g.id);
        grew = true;
      }
  }
  return out;
}

/** The node or group a clipped node is clipped to; null when the node is not (effectively) clipped. */
export function clipBase(page: Pick<Page, "nodes" | "groups">, id: string): SceneNode | LayerGroup | null {
  const walk = (items: TreeItem[]): SceneNode | LayerGroup | null | undefined => {
    for (const it of items) {
      if (it.clips.some((c) => c.id === id)) return it.kind === "node" ? it.node : it.group;
      if (it.kind === "group") {
        const r = walk(it.children);
        if (r !== undefined) return r;
      }
    }
    return undefined;
  };
  return walk(buildTree(page.nodes, page.groups)) ?? null;
}

/** Shown, counting every enclosing group's eye. */
export function shownInTree(n: SceneNode, index: Map<string, LayerGroup>): boolean {
  return n.visible && groupPath(n.groupId, index).every((g) => g.visible);
}

/** Locked by itself or by an enclosing group. */
export function lockedInTree(n: SceneNode, index: Map<string, LayerGroup>): boolean {
  return n.locked || groupPath(n.groupId, index).some((g) => g.locked);
}

/** Can a layer be picked on the canvas (click, marquee, Select All)? Shown and unlocked, enclosing groups included. */
export function pickableOn(page: Pick<Page, "groups">): (n: SceneNode) => boolean {
  if (!page.groups?.length) return (n) => n.visible && !n.locked;
  const index = groupIndex(page.groups);
  return (n) => shownInTree(n, index) && !lockedInTree(n, index);
}

/**
 * Copies placed on top of the stack (paste, duplicate to an offset): out of any group — a group id would pull the
 * whole group up to them — and clipped only onto a copy below them (the first copy is never clipped).
 */
export function detachCopies<T extends SceneNode>(copies: T[]): T[] {
  return copies.map((c, i) => {
    if (c.groupId === undefined && (!c.clip || i > 0)) return c;
    const o = { ...c };
    delete o.groupId;
    if (i === 0) delete o.clip;
    return o;
  });
}

/**
 * Bring a page into canonical form (in place; works on immer drafts): members of each group next to each other
 * — a group stays where its top-most member is — group ids that point nowhere dropped, parent cycles broken.
 * Empty groups are kept (Photoshop keeps them; the PSD Surgeon writes them back). Returns true when it changed
 * anything.
 */
export function normalizeGroups(page: Page): boolean {
  const groups = page.groups;
  if (!groups?.length) {
    let changed = false;
    for (const n of page.nodes)
      if (n.groupId) {
        delete n.groupId;
        changed = true;
      }
    if (groups && !groups.length) {
      delete page.groups;
      changed = true;
    }
    return changed;
  }
  let changed = false;
  const index = groupIndex(groups);
  // break cycles / missing parents
  for (const g of groups) {
    if (g.parentId && !index.has(g.parentId)) {
      g.parentId = null;
      changed = true;
    }
    const seen = new Set<string>([g.id]);
    let p = g.parentId ? index.get(g.parentId) : undefined;
    while (p) {
      if (seen.has(p.id)) {
        g.parentId = null;
        changed = true;
        break;
      }
      seen.add(p.id);
      p = p.parentId ? index.get(p.parentId) : undefined;
    }
  }
  for (const n of page.nodes)
    if (n.groupId && !index.has(n.groupId)) {
      delete n.groupId;
      changed = true;
    }
  // contiguity: rebuild the order as a tree walk where each group sits at its top-most member
  const order = treeOrder(page.nodes, index);
  if (order.some((n, i) => n !== page.nodes[i])) {
    page.nodes = order as any;
    changed = true;
  }
  return changed;
}

function treeOrder(nodes: readonly SceneNode[], index: Map<string, LayerGroup>): SceneNode[] {
  // contiguous already? (the common case: no allocation beyond this check)
  {
    const closed = new Set<string>();
    let stack: string[] = [];
    let ok = true;
    for (const n of nodes) {
      const path = groupPath(n.groupId, index).map((g) => g.id);
      let k = 0;
      while (k < stack.length && k < path.length && stack[k] === path[k]) k++;
      for (const id of stack.slice(k)) closed.add(id);
      if (path.slice(k).some((id) => closed.has(id))) {
        ok = false;
        break;
      }
      stack = path;
    }
    if (ok) return nodes as SceneNode[];
  }
  // key = path of (position of the top-most member of each enclosing group) → sort keeps groups contiguous
  const top = new Map<string, number>();
  nodes.forEach((n, i) => {
    for (const g of groupPath(n.groupId, index)) top.set(g.id, i);
  });
  const keyed = nodes.map((n, i) => ({ n, key: [...groupPath(n.groupId, index).map((g) => top.get(g.id)!), i] }));
  keyed.sort((a, b) => {
    // compare the enclosing groups' anchors level by level; a node at a level compares by its own index
    const len = Math.min(a.key.length, b.key.length);
    for (let k = 0; k < len; k++) if (a.key[k] !== b.key[k]) return a.key[k] - b.key[k];
    return a.key.length - b.key.length;
  });
  return keyed.map((k) => k.n);
}

// ───────── compositing walk (shared by the canvas renderer and the pixel compositor) ─────────

/** How a leaf is painted: with its own opacity and blend, bare (opacity 1, normal: a clip-stack base), or clipped onto what the surface holds. */
export type LeafMode = "normal" | "bare" | "atop";

export interface Compositor<S> {
  /** paint node `n` into `dst` */
  leaf(dst: S, n: SceneNode, how: LeafMode): void;
  /** effective opacity of a node (animation overrides included) */
  alpha(n: SceneNode): number;
  /** a transparent surface like `like` */
  alloc(like: S): S;
  /** a copy of `src` */
  copy(src: S): S;
  free(s: S): void;
  /** `src` onto `dst`: source-over with `blend` at `opacity`, or "lerp" = dst·(1−opacity) + src·opacity */
  blit(dst: S, src: S, opacity: number, blend: BlendMode | StyleBlend | "lerp"): void;
  // ── layer effects (optional: a compositor without them draws no effects). A leaf draws its own node's effects
  // (outer ones too, except as a clip-stack base: "bare" draws the content and its interior effects only, and
  // `under` then draws the base's outer effects below the whole stack — Photoshop does not clip a base's shadow).
  /** a transparent surface like `like` with room around it for effects reaching `fx` */
  allocFx?(like: S, fx: readonly Effect[]): S;
  /** apply `fx` to the surface's content in place; returns the surfaces to draw below it (shadows, glows) */
  applyFx?(s: S, fx: readonly Effect[], opacity?: number): { s: S; blend: StyleBlend; opacity: number }[];
  /** the outer effects of node `n` onto `dst` at `opacity` (a clip-stack base) */
  under?(dst: S, n: SceneNode, opacity: number): void;
  /** knockout: clear `dst` under node `n`'s shape by `opacity` (a group's own surface — what is under the group shows) */
  knock?(dst: S, n: SceneNode, opacity: number): void;
}

/** Effects of a group the compositor draws. */
const groupFx = <S>(g: LayerGroup, C: Compositor<S>) => (C.applyFx ? activeEffects(g.effects) : []);

/** What one item contributes; `include` limits painting to some nodes (a tile's nodes). */
function hasContent(it: TreeItem, include: ((n: SceneNode) => boolean) | null, alpha: (n: SceneNode) => number): boolean {
  if (it.kind === "node") return it.node.visible && alpha(it.node) > 0 && (!include || include(it.node));
  return it.group.visible && it.group.opacity > 0 && it.children.some((c) => hasContent(c, include, alpha));
}

/** Would painting these items straight into a surface read what is already there (a non-normal blend, an adjustment layer)? */
function readsBackdrop(items: TreeItem[]): boolean {
  return items.some((it) => {
    if (it.kind === "node") return it.node.blendMode !== "NORMAL" || (it.node.type === "RASTER" && !!it.node.adjust) || !!it.node.knockout;
    const b = it.group.blendMode;
    return b === "PASS_THROUGH" ? readsBackdrop(it.children) : b !== "NORMAL";
  });
}

/** `own`: `dst` is a group's own surface (started transparent) — a knockout layer clears it (Compositor.knock). */
export function composeItems<S>(items: TreeItem[], dst: S, C: Compositor<S>, include: ((n: SceneNode) => boolean) | null = null, own = false): void {
  for (const it of items) {
    if (!hasContent(it, include, (n) => C.alpha(n))) continue;
    const clips = it.clips.filter((c) => c.visible && C.alpha(c) > 0 && (!include || include(c)));
    if (!clips.length) {
      if (own && it.kind === "node" && it.node.knockout && C.knock) C.knock(dst, it.node, C.alpha(it.node));
      paintItem(it, dst, C, include);
      continue;
    }
    // clip stack: base bare + clipped layers atop, on their own; then blended with the base's opacity / mode.
    // Effects (Photoshop order): the base's interior effects are part of the base the layers clip to, its outer
    // effects go below the whole stack unclipped; a clipped layer's own effects are clipped with it
    const op = it.kind === "node" ? C.alpha(it.node) : it.group.opacity;
    const blend = it.kind === "node" ? it.node.blendMode : it.group.blendMode === "PASS_THROUGH" ? "NORMAL" : it.group.blendMode;
    const gfx = it.kind === "group" ? groupFx(it.group, C) : [];
    const O = gfx.length && C.allocFx ? C.allocFx(dst, gfx) : C.alloc(dst);
    let under: { s: S; blend: StyleBlend; opacity: number }[] = [];
    if (it.kind === "node") C.leaf(O, it.node, "bare");
    else {
      composeItems(it.children, O, C, include);
      if (gfx.length) under = C.applyFx!(O, gfx, op);
    }
    for (const c of clips) C.leaf(O, c, "atop");
    if (it.kind === "node") C.under?.(dst, it.node, op);
    for (const u of under) {
      C.blit(dst, u.s, op * u.opacity, u.blend);
      C.free(u.s);
    }
    C.blit(dst, O, op, blend);
    C.free(O);
  }
}

function paintItem<S>(it: TreeItem, dst: S, C: Compositor<S>, include: ((n: SceneNode) => boolean) | null) {
  if (it.kind === "node") return C.leaf(dst, it.node, "normal");
  const g = it.group;
  const gfx = groupFx(g, C);
  if (gfx.length) {
    // a group with a layer style is composited on its own, styled like one layer, then blended
    const G = C.allocFx ? C.allocFx(dst, gfx) : C.alloc(dst);
    composeItems(it.children, G, C, include, true);
    for (const u of C.applyFx!(G, gfx, g.opacity)) {
      C.blit(dst, u.s, g.opacity * u.opacity, u.blend);
      C.free(u.s);
    }
    C.blit(dst, G, g.opacity, g.blendMode === "PASS_THROUGH" ? "NORMAL" : g.blendMode);
    C.free(G);
    return;
  }
  if (g.blendMode === "PASS_THROUGH") {
    if (g.opacity >= 1) return composeItems(it.children, dst, C, include);
    const X = C.copy(dst);
    composeItems(it.children, X, C, include);
    C.blit(dst, X, g.opacity, "lerp");
    C.free(X);
    return;
  }
  if (g.opacity >= 1 && g.blendMode === "NORMAL" && !readsBackdrop(it.children)) return composeItems(it.children, dst, C, include);
  const G = C.alloc(dst);
  composeItems(it.children, G, C, include, true);
  C.blit(dst, G, g.opacity, g.blendMode);
  C.free(G);
}

/** The node list with every group's members next to each other (no change when they already are). */
export function contiguousOrder(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined): SceneNode[] {
  if (!groups?.length) return nodes as SceneNode[];
  return treeOrder(nodes, groupIndex(groups));
}

/**
 * Bring forward / send backward inside the layer's own group (Photoshop: Arrange works among siblings; a whole
 * group counts as one sibling). `ids` are node ids; returns the new node order (same array when unchanged).
 */
export function reorderInGroups(nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined, ids: Set<string>, where: "up" | "down" | "top" | "bottom"): SceneNode[] {
  type T = { n: SceneNode } | { g: string; kids: T[] };
  const index = groupIndex(groups);
  const ordered = contiguousOrder(nodes, groups);
  const root: T[] = [];
  const stack: { id: string; kids: T[] }[] = [];
  for (const n of ordered) {
    const path = groupPath(n.groupId, index);
    let k = 0;
    while (k < stack.length && k < path.length && stack[k].id === path[k].id) k++;
    stack.length = k;
    for (; k < path.length; k++) {
      const kids: T[] = [];
      (stack.length ? stack[stack.length - 1].kids : root).push({ g: path[k].id, kids });
      stack.push({ id: path[k].id, kids });
    }
    (stack.length ? stack[stack.length - 1].kids : root).push({ n });
  }
  const sel = (t: T) => "n" in t && ids.has(t.n.id);
  const apply = (list: T[]): T[] => {
    for (const t of list) if ("g" in t) t.kids = apply(t.kids);
    if (!list.some(sel)) return list;
    if (where === "top") return [...list.filter((t) => !sel(t)), ...list.filter(sel)];
    if (where === "bottom") return [...list.filter(sel), ...list.filter((t) => !sel(t))];
    const a = [...list];
    if (where === "up") {
      for (let i = a.length - 2; i >= 0; i--) if (sel(a[i]) && !sel(a[i + 1])) [a[i], a[i + 1]] = [a[i + 1], a[i]];
    } else for (let i = 1; i < a.length; i++) if (sel(a[i]) && !sel(a[i - 1])) [a[i], a[i - 1]] = [a[i - 1], a[i]];
    return a;
  };
  const out: SceneNode[] = [];
  const flat = (list: T[]) => list.forEach((t) => ("n" in t ? out.push(t.n) : flat(t.kids)));
  flat(apply(root));
  return out.every((n, i) => n === nodes[i]) ? (nodes as SceneNode[]) : out;
}
