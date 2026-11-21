// Design edit mode (Illustrator feel): fill / stroke swatches, outline view, lock / hide, line segments and
// anchor points.
//
//   X 칠·선 앞으로 · Shift+X 칠↔선 바꾸기 · / 없음 · D 기본(흰 칠·검은 선)
//   Ctrl+Y 윤곽선 보기 · Ctrl+2 잠금 · Ctrl+Alt+2 모두 잠금 해제 · Ctrl+3 숨기기 · Ctrl+Alt+3 모두 표시
//   선 \ · 기준점 추가 + · 기준점 삭제 − · 펜으로 그리며 Alt 끌기 = 핸들 끊기
//   그룹 두 번 클릭 = 격리 모드 (Esc 또는 빈 곳 두 번 클릭으로 나감)

import { create } from "zustand";
import { applyTransform, invertTransform } from "../core/geom";
import { nearestOnContour } from "../core/pathEdit";
import { addAnchor, deleteAnchor } from "./pathTools";
import { currentPage, draftPage, selectedNodes, useStore } from "../core/store";
import { newVector, type SceneNode, type Vec2, type VectorNode } from "../core/types";
import { corner } from "../core/vector";
import { PT, useShapeStroke } from "./drawDefaults";
import { t } from "../i18n";

const S = () => useStore.getState();

interface DesignState {
  /** which swatch is in front (X): new colours and "/" apply to it */
  focus: "fill" | "stroke";
  /** outline view (Ctrl+Y): paths as thin lines, no paint */
  outline: boolean;
  /** isolation mode: the layer group being edited on its own (double-click a group member), or null */
  isolated: string | null;
  set: (p: Partial<DesignState>) => void;
}

export const useDesign = create<DesignState>((set) => ({ focus: "fill", outline: false, isolated: null, set }));

const vectors = () => selectedNodes().filter((n): n is VectorNode => n.type === "VECTOR");

/** X: bring the other swatch to the front. */
export function toggleSwatchFocus() {
  const d = useDesign.getState();
  d.set({ focus: d.focus === "fill" ? "stroke" : "fill" });
}

/** Shift+X: swap fill and stroke of the selected paths (or of the new-shape defaults). */
export function swapFillStroke() {
  const vs = vectors();
  if (vs.length) {
    const ids = vs.map((v) => v.id);
    S().commit(t("design.hist.swap"), (d) => {
      for (const n of draftPage(d, S().pageId)?.nodes ?? []) {
        if (!ids.includes(n.id) || n.type !== "VECTOR") continue;
        const f = n.fill;
        n.fill = n.stroke;
        n.stroke = f;
        if (n.stroke && n.strokeWidth <= 0) n.strokeWidth = 1;
      }
    });
    return;
  }
  const s = S();
  const none = useShapeStroke.getState().none;
  s.set({ fill: s.stroke, stroke: s.fill });
  useShapeStroke.getState().setNone(none);
}

/** "/": the front swatch of the selected paths becomes none. */
export function swatchNone() {
  const vs = vectors();
  const focus = useDesign.getState().focus;
  if (!vs.length) {
    if (focus === "stroke") useShapeStroke.getState().setNone(true);
    return;
  }
  const ids = vs.map((v) => v.id);
  S().commit(focus === "fill" ? t("ribbon.noFill") : t("ribbon.noStroke"), (d) => {
    for (const n of draftPage(d, S().pageId)?.nodes ?? []) if (ids.includes(n.id) && n.type === "VECTOR") n[focus] = null;
  });
}

/** D: white fill, black 1 px stroke (Illustrator's default swatches). */
export function defaultSwatches() {
  const vs = vectors();
  if (!vs.length) {
    S().set({ fill: "#ffffff", stroke: "#000000" });
    useShapeStroke.getState().setNone(false);
    return;
  }
  const ids = vs.map((v) => v.id);
  S().commit(t("design.hist.defaultSwatches"), (d) => {
    for (const n of draftPage(d, S().pageId)?.nodes ?? [])
      if (ids.includes(n.id) && n.type === "VECTOR") {
        n.fill = "#ffffff";
        n.stroke = "#000000";
        n.strokeWidth = PT;
      }
  });
}

export function toggleOutline() {
  const d = useDesign.getState();
  d.set({ outline: !d.outline });
  S().notify(d.outline ? t("design.msg.preview") : t("design.msg.outline"));
}

/** Ctrl+2: lock the selection (it is deselected, as in Illustrator). */
export function lockSelection() {
  const ids = S().selection;
  if (!ids.length) return;
  S().commit(t("dock.lock"), (d) => {
    for (const n of draftPage(d, S().pageId)?.nodes ?? []) if (ids.includes(n.id)) n.locked = true;
  });
  S().set({ selection: [] });
}

/** Ctrl+3: hide the selection. */
export function hideSelection() {
  const ids = S().selection;
  if (!ids.length) return;
  S().commit(t("dock.hide"), (d) => {
    for (const n of draftPage(d, S().pageId)?.nodes ?? []) if (ids.includes(n.id)) n.visible = false;
  });
  S().set({ selection: [] });
}

/** Ctrl+Alt+2 / Ctrl+Alt+3: unlock / show everything on the page; what changed is selected. */
export function unlockAll(which: "locked" | "visible") {
  const page = currentPage();
  if (!page) return;
  const ids = page.nodes.filter((n) => (which === "locked" ? n.locked : !n.visible)).map((n) => n.id);
  if (!ids.length) return;
  S().commit(which === "locked" ? t("design.hist.unlockAll") : t("design.hist.showAll"), (d) => {
    for (const n of draftPage(d, S().pageId)?.nodes ?? [])
      if (ids.includes(n.id)) {
        if (which === "locked") n.locked = false;
        else n.visible = true;
      }
  });
  S().set({ selection: ids });
}

// ───────── line segment tool ─────────

/** A straight line from a to b (page px) with the current stroke colour (a line needs a stroke even when shapes start without one). */
export function drawnLine(a: Vec2, b: Vec2): VectorNode {
  const s = S();
  const v = newVector([{ closed: false, nodes: [corner(0, 0), corner(b[0] - a[0], b[1] - a[1])] }], t("design.name.line"));
  v.fill = null;
  v.stroke = s.stroke;
  v.strokeWidth = useShapeStroke.getState().width;
  v.transform = { x: a[0], y: a[1], rotation: 0, scale: 1 };
  return v;
}

/** Shift: snap the line to 45° steps. */
export function constrain45(a: Vec2, b: Vec2): Vec2 {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [a[0] + Math.cos(ang) * len, a[1] + Math.sin(ang) * len];
}

// ───────── anchor points (add / delete anchor point tools; the engine is core/pathEdit.ts, ui/pathTools.ts) ─────────

/** Paths a click may edit: the selected ones first, then the others from the top. */
function candidates(): VectorNode[] {
  const page = currentPage();
  if (!page) return [];
  const sel = S().selection;
  const iso = isolationFilter();
  return [...page.nodes]
    .reverse()
    .filter((n): n is VectorNode => n.type === "VECTOR" && n.visible && !n.locked && (!iso || iso(n)))
    .sort((a, b) => Number(sel.includes(b.id)) - Number(sel.includes(a.id)));
}

/** Add an anchor point where page point p lies on a path (selected first, else any unlocked path); true when added. */
export function addAnchorAt(p: Vec2, tolPage: number): boolean {
  for (const n of candidates()) {
    const lp = invertTransform(n.transform, p);
    const k = Math.abs(n.transform.scale) || 1;
    for (let ci = 0; ci < n.contours.length; ci++) {
      const hit = nearestOnContour(n.contours[ci], lp);
      if (!hit || hit.d * k > tolPage || hit.u < 0.01 || hit.u > 0.99) continue;
      addAnchor(n, ci, hit.seg, hit.u);
      return true;
    }
  }
  return false;
}

/** Delete the anchor point under page point p (the curve is refitted to keep its shape); true when one was removed. */
export function deleteAnchorAt(p: Vec2, tolPage: number): boolean {
  for (const n of candidates())
    for (let ci = 0; ci < n.contours.length; ci++)
      for (let ni = 0; ni < n.contours[ci].nodes.length; ni++) {
        const q = applyTransform(n.transform, n.contours[ci].nodes[ni].anchor);
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) > tolPage) continue;
        deleteAnchor(n, ci, ni);
        return true;
      }
  return false;
}

// ───────── isolation mode ─────────

/** The nodes a click may pick while a group is isolated (its members); everything when none is. */
export function isolationFilter(): ((n: SceneNode) => boolean) | null {
  const g = useDesign.getState().isolated;
  if (!g) return null;
  const page = currentPage();
  const groups = page?.groups ?? [];
  const inside = (gid: string | undefined): boolean => {
    for (let id = gid; id; id = groups.find((x) => x.id === id)?.parentId ?? undefined) if (id === g) return true;
    return false;
  };
  return (n) => inside(n.groupId);
}

export function enterIsolation(groupId: string) {
  useDesign.getState().set({ isolated: groupId });
  S().set({ selection: [] });
}
export function exitIsolation() {
  if (useDesign.getState().isolated) useDesign.getState().set({ isolated: null });
}

// leave isolation when the page changes or the group disappears
useStore.subscribe((s, p) => {
  const g = useDesign.getState().isolated;
  if (!g) return;
  if (s.pageId !== p.pageId) return exitIsolation();
  const page = s.doc.pages.find((x) => x.id === s.pageId) ?? s.doc.masters.find((x) => x.id === s.pageId);
  if (!page?.groups?.some((x) => x.id === g)) exitIsolation();
});
