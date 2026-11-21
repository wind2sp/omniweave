// Align / distribute the selection (one undo step each). The math lives in core/align.ts.

import { alignDeltas, distributeDeltas, referenceRect, type AlignMode, type AlignRef, type DistributeAxis } from "../core/align";
import { nodeBounds } from "../core/loom";
import { currentPage, draftPage, selectedNodes, useStore } from "../core/store";
import { useUI } from "./shell/uiStore";
import { t } from "../i18n";

const S = () => useStore.getState();

/** "Align left" etc., in the current language */
export const alignLabel = (mode: AlignMode) => t(`ribbon.align.${mode}`);

/** "Align left (to page)" — the button tip and the undo label */
export const alignTip = (mode: AlignMode, ref: AlignRef) => t(`ribbon.alignTip.${ref}`, { align: alignLabel(mode) });

/** "Align to page" etc. — the reference picker's option labels */
export const alignRefLabel = (ref: AlignRef) => t(`ribbon.alignTo.${ref}`);

/** The key object is the one clicked last (Shift+click adds it at the end of the selection). */
export function keyObjectId(): string | null {
  const sel = S().selection;
  return sel.length > 1 ? sel[sel.length - 1] : null;
}

function apply(label: string, deltas: Map<string, [number, number]>) {
  const s = S();
  if (![...deltas.values()].some(([dx, dy]) => Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9)) return;
  s.commit(label, (d) => {
    const pg = draftPage(d, s.pageId);
    pg?.nodes.forEach((n) => {
      const m = deltas.get(n.id);
      if (!m || n.locked) return;
      n.transform.x += m[0];
      n.transform.y += m[1];
    });
  });
}

export function alignSelected(mode: AlignMode, ref: AlignRef = useUI.getState().alignRef) {
  const page = currentPage();
  const nodes = selectedNodes();
  if (!page || !nodes.length) return S().notify(t("ribbon.msg.selectToAlign"));
  const rects = nodes.map((n) => nodeBounds(n));
  const key = keyObjectId();
  const keyIndex = ref === "key" ? nodes.findIndex((n) => n.id === key) : -1;
  const target = referenceRect(ref, rects, page, keyIndex);
  const d = alignDeltas(rects, mode, target);
  const moves = new Map<string, [number, number]>();
  nodes.forEach((n, i) => i !== keyIndex && moves.set(n.id, d[i] as [number, number]));
  const movable = nodes.filter((n, i) => !n.locked && i !== keyIndex).length;
  if (!movable) return S().notify(t("ribbon.msg.lockedNoMove"));
  apply(alignTip(mode, ref === "selection" && nodes.length < 2 ? "page" : ref), moves);
}

export function distributeSelected(axis: DistributeAxis, ref: AlignRef = useUI.getState().alignRef) {
  const page = currentPage();
  const nodes = selectedNodes();
  const within = ref === "page" && page ? { x: 0, y: 0, w: page.width, h: page.height } : null;
  if (!page || nodes.length < (within ? 2 : 3)) return S().notify(within ? t("ribbon.msg.selectTwo") : t("ribbon.msg.selectThreeDist"));
  const rects = nodes.map((n) => nodeBounds(n));
  const d = distributeDeltas(rects, axis, within);
  const moves = new Map<string, [number, number]>();
  nodes.forEach((n, i) => moves.set(n.id, d[i] as [number, number]));
  apply(axis === "x" ? t("ribbon.dist.h") : t("ribbon.dist.v"), moves);
}
