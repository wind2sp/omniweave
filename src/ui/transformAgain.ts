// Illustrator's modifier-key editing of the selection: Transform Again (Ctrl+D) after a move or an Alt-copy, the
// Alt+arrow copy, and copies made in place right above their originals (Alt+drag) — 2026-11-24, the owner's check of
// the PC installer: "Ctrl·Alt로 마우스 끌기 복사·변형·같은 자리 붙여넣기가 안 되는 것 같아".

import { currentPage, draftPage, useStore } from "../core/store";
import { copyNode, uid, type OmwDocument, type SceneNode } from "../core/types";
import { currentEditMode } from "./editModes";
import { t } from "../i18n";

const S = () => useStore.getState();

/**
 * Illustrator's selection tool picks a whole group: the members of the outermost group around `node` that is not a
 * layer (a top-level folder of an opened .ai / .svg, a drawing layer); the direct selection tool (A) still picks the
 * one object. Returns the ids to select (just the node when it is in no such group).
 */
export function groupPick(page: { nodes: SceneNode[]; groups?: { id: string; parentId: string | null; cad?: { layer?: string } }[]; source?: { format?: string } }, node: SceneNode): string[] {
  const groups = page.groups ?? [];
  if (!node.groupId || !groups.length) return [node.id];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const path: string[] = [];
  for (let g = byId.get(node.groupId); g; g = g.parentId ? byId.get(g.parentId) : undefined) path.unshift(g.id);
  const art = ["ai", "svg", "eps"].includes(page.source?.format?.toLowerCase() ?? "");
  const isLayer = (id: string) => {
    const g = byId.get(id)!;
    return !!g.cad?.layer || (art && g.parentId === null);
  };
  const top = path.find((id) => !isLayer(id));
  if (!top) return [node.id];
  const inside = (n: SceneNode) => {
    for (let g = n.groupId ? byId.get(n.groupId) : undefined; g; g = g.parentId ? byId.get(g.parentId) : undefined) if (g.id === top) return true;
    return false;
  };
  return page.nodes.filter((n) => inside(n) && !n.locked && n.visible).map((n) => n.id);
}

/** The last move of the selection (a drag, an arrow key) and whether it made a copy: what Ctrl+D repeats. */
let last: { dx: number; dy: number; copy: boolean } | null = null;

export function recordMove(dx: number, dy: number, copy: boolean) {
  if (dx || dy) last = { dx, dy, copy };
}

export const lastMove = () => last;

/**
 * Copies of the selected objects in a draft, each right above its original (same layer, same place: Illustrator's
 * Alt+drag and Alt+arrow); the image mode names them "… 복사" as Photoshop does. Returns new id → original id.
 */
export function copyAboveInDraft(doc: OmwDocument, pageId: string, ids: readonly string[]): Record<string, string> {
  const pg = draftPage(doc, pageId);
  const made: Record<string, string> = {};
  if (!pg) return made;
  const image = currentEditMode() === "IMAGE";
  for (let i = pg.nodes.length - 1; i >= 0; i--) {
    const n = pg.nodes[i] as SceneNode;
    if (!ids.includes(n.id) || n.locked) continue;
    // its own transform: the copy moves, the original stays
    const c = { ...copyNode(n, uid()), transform: { ...n.transform } } as SceneNode;
    if (image) c.name = t("doc.copyName", { name: n.name });
    pg.nodes.splice(i + 1, 0, c as any);
    made[c.id] = n.id;
  }
  return made;
}

/** Copies (new ids) of the selected, unlocked objects of a page in `doc`, with the original each stands for. */
export function copiesOf(doc: OmwDocument, pageId: string, ids: readonly string[]): { orig: string; node: SceneNode }[] {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.masters?.find((p) => p.id === pageId);
  if (!page) return [];
  const image = currentEditMode() === "IMAGE";
  return page.nodes
    .filter((n) => ids.includes(n.id) && !n.locked)
    .map((n) => {
      const c = copyNode(n, uid());
      if (image) c.name = t("doc.copyName", { name: n.name });
      return { orig: n.id, node: c };
    });
}

/** Put fresh instances of `made` right above their originals (`copies`: copy id → original id) in a page's node list. */
export function placeCopies(nodes: SceneNode[], made: readonly SceneNode[], copies: Record<string, string>) {
  for (const m of made) {
    const i = nodes.findIndex((n) => n.id === copies[m.id]);
    const fresh = { ...copyNode(m, m.id), transform: { ...m.transform } } as SceneNode;
    if (i >= 0) nodes.splice(i + 1, 0, fresh);
    else nodes.push(fresh);
  }
}

/** Move (or copy and move) the selection by (dx, dy) as one undo step; the copies become the selection. */
export function moveSelection(dx: number, dy: number, copy: boolean, label?: string) {
  const s = S();
  const page = currentPage();
  if (!page || !s.selection.length) return;
  let made: Record<string, string> = {};
  const ids = [...s.selection];
  s.commit(label ?? t(copy ? "doc.history.duplicate" : "shell.hist.move"), (d) => {
    const moving = copy ? Object.keys((made = copyAboveInDraft(d, page.id, ids))) : ids;
    draftPage(d, page.id)?.nodes.forEach((n) => {
      if (moving.includes(n.id) && !n.locked) {
        n.transform.x += dx;
        n.transform.y += dy;
      }
    });
  });
  if (copy && Object.keys(made).length) S().set({ selection: Object.keys(made) });
  recordMove(dx, dy, copy);
}

/** Illustrator's Transform Again (Ctrl+D): the last move or Alt-copy once more on the selection. */
export function transformAgain(): boolean {
  if (!last || !S().selection.length) return false;
  moveSelection(last.dx, last.dy, last.copy, t("design.hist.again"));
  return true;
}
