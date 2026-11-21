// Free transform glue: the selection box on the current page and live resize / rotate inside a
// store gesture (one undo step per drag). The maths is in core/transform.ts.

import { localBounds, nodeBounds } from "../core/loom";
import { currentPage, draftPage, findPage, useStore } from "../core/store";
import { boxCenter, boxSize, flipNodeScreen, keepRatio, resizeFactors, resizeNode, rotatedAbout, scaleNodeAbout, type Box, type Handle } from "../core/transform";
import type { OmwDocument, Page, SceneNode, Vec2 } from "../core/types";
import { unionRect, type Rect } from "../core/geom";
import { snapAngle } from "../core/snap";
import { create } from "zustand";
import { t } from "../i18n";

const S = () => useStore.getState();

export interface SelBox {
  box: Box;
  /** unlocked selected nodes (the ones that transform) */
  nodes: SceneNode[];
  multi: boolean;
}

/** One unlocked object: its own (rotated) box. Several: their combined page-aligned box. */
export function selectionBox(page: Page | undefined, ids: string[]): SelBox | null {
  if (!page || !ids.length) return null;
  const nodes = page.nodes.filter((n) => ids.includes(n.id) && !n.locked && n.visible);
  if (!nodes.length) return null;
  if (nodes.length === 1) {
    const lb = localBounds(nodes[0]);
    if (lb.w <= 0 && lb.h <= 0) return null;
    return { box: { t: nodes[0].transform, lb }, nodes, multi: false };
  }
  const u = nodes.reduce<Rect | null>((a, n) => unionRect(a, nodeBounds(n)), null)!;
  return { box: { t: { x: 0, y: 0, rotation: 0, scale: 1 }, lb: u }, nodes, multi: true };
}

/** Live readout for the status bar and the canvas tag while transforming. */
export const useXform = create<{ readout: string | null; session: number | null; set: (p: Partial<{ readout: string | null; session: number | null }>) => void }>((set) => ({
  readout: null,
  session: null,
  set: (p) => set(p),
}));

function baseNodes(base: OmwDocument, ids: string[]): Map<string, SceneNode> {
  const pg = findPage(base, S().pageId);
  return new Map((pg?.nodes ?? []).filter((n) => ids.includes(n.id)).map((n) => [n.id, n]));
}

export interface Mods {
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/** Resize the selection by dragging `handle` to page point `p` (inside a gesture). Returns "W × H". */
export function liveResize(sb: SelBox, handle: Handle, p: Vec2, m: Mods): { w: number; h: number } {
  const s = S();
  const base = s.gestureBase;
  if (!base) return boxSize(sb.box);
  const ids = sb.nodes.map((n) => n.id);
  const orig = baseNodes(base, ids);
  // several objects always scale proportionally (each keeps its own rotation)
  const f = resizeFactors(sb.box, handle, p, { keepRatio: sb.multi || keepRatio(sb.nodes, m.shift), fromCenter: m.alt });
  s.updateGesture((d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    pg.nodes.forEach((n, i) => {
      const o = orig.get(n.id);
      if (!o) return;
      // start each frame from the node as it was when the drag began
      pg.nodes[i] = structuredCloneNode(o) as any;
      const dn = pg.nodes[i] as SceneNode;
      if (sb.multi) scaleNodeAbout(dn, Math.abs(f.kx), f.anchor);
      else resizeNode(dn, f, { textScale: m.ctrl && handle.length === 2 });
    });
  });
  return { w: Math.abs(sb.box.lb.w * sb.box.t.scale * f.kx), h: Math.abs(sb.box.lb.h * (sb.box.t.scaleY ?? sb.box.t.scale) * f.ky) };
}

/** Rotate the selection about its centre (inside a gesture). Returns the new angle of the box. */
export function liveRotate(sb: SelBox, startAngle: number, p: Vec2, m: Mods, snap: boolean): number {
  const s = S();
  const base = s.gestureBase;
  const c = boxCenter(sb.box);
  let delta = ((Math.atan2(p[1] - c[1], p[0] - c[0]) - startAngle) * 180) / Math.PI;
  const start = sb.multi ? 0 : sb.box.t.rotation;
  // Shift: 15° steps · snapping on: pulled to 15° steps when within 4°
  const target = m.shift ? snapAngle(start + delta, 15, 0, true) : snap ? snapAngle(start + delta, 15, 4) : start + delta;
  delta = target - start;
  if (!base) return target;
  const orig = baseNodes(base, sb.nodes.map((n) => n.id));
  s.updateGesture((d) => {
    const pg = draftPage(d, s.pageId);
    pg?.nodes.forEach((n) => {
      const o = orig.get(n.id);
      if (o) n.transform = rotatedAbout(o.transform, c, delta);
    });
  });
  let r = ((target % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return r;
}

function structuredCloneNode(n: SceneNode): SceneNode {
  // nodes are immutable plain data; a shallow copy with a fresh transform is enough for resizeNode
  return { ...n, transform: { ...n.transform } } as SceneNode;
}

/** Mirror the selection like a screen mirror (Photoshop behaviour), each object about its own centre. */
export function flipSelected(axis: "h" | "v") {
  const s = S();
  const page = currentPage();
  const sb = selectionBox(page, s.selection);
  if (!sb) return s.notify(t("ribbon.msg.selectToFlip"));
  const ids = new Set(sb.nodes.map((n) => n.id));
  const c = sb.multi ? ([sb.box.lb.x + sb.box.lb.w / 2, sb.box.lb.y + sb.box.lb.h / 2] as Vec2) : null;
  s.commit(axis === "h" ? t("ribbon.flipH") : t("ribbon.flipV"), (d) => {
    draftPage(d, s.pageId)?.nodes.forEach((n) => {
      if (!ids.has(n.id)) return;
      n.transform = flipNodeScreen(n as SceneNode, localBounds(n as SceneNode), axis) as any;
      if (c) {
        // several objects: mirror their positions across the selection's centre too
        const b = nodeBounds(n as SceneNode);
        if (axis === "h") n.transform.x += 2 * (c[0] - (b.x + b.w / 2));
        else n.transform.y += 2 * (c[1] - (b.y + b.h / 2));
      }
    });
  });
}

/** Set the on-page width / height of one object from a number field (top-left corner stays). */
export function setSelectedSize(dim: "w" | "h", value: number, keep = false) {
  const s = S();
  const sb = selectionBox(currentPage(), s.selection);
  if (!sb || sb.multi || !(value > 0)) return;
  const cur = boxSize(sb.box);
  const k = dim === "w" ? value / Math.max(1e-9, cur.w) : value / Math.max(1e-9, cur.h);
  const kx = dim === "w" || keep ? k : 1, ky = dim === "h" || keep ? k : 1;
  const id = sb.nodes[0].id;
  s.commit(dim === "w" ? t("ribbon.width") : t("ribbon.height"), (d) => {
    const n = draftPage(d, s.pageId)?.nodes.find((x) => x.id === id) as SceneNode | undefined;
    if (n) resizeNode(n, { kx, ky, anchor: [sb.box.lb.x, sb.box.lb.y] });
  });
}

/** Ctrl+T: start a transform session — Enter keeps, Esc undoes every step made since. */
export function startTransformSession() {
  const s = S();
  if (!selectionBox(currentPage(), s.selection)) return s.notify(t("ribbon.msg.selectToTransform"));
  sessionDoc = s.doc;
  useXform.getState().set({ session: s.past.length });
  s.notify(t("ribbon.msg.transformHint"));
}

/** the document when the session started: Esc undoes back to exactly this one */
let sessionDoc: OmwDocument | null = null;

// A session belongs to the selection it was started on: another selection (or none), another page or
// document, or undoing past its start ends it silently (otherwise a later Esc — usually meant as
// "deselect" — would undo every step made since, including unrelated work).
useStore.subscribe((st, prev) => {
  if (useXform.getState().session == null) return;
  // (opening a document changes the selection too)
  const lost = st.past !== prev.past && st.doc !== sessionDoc && !st.past.some((e) => e.doc === sessionDoc);
  const reselected = st.selection !== prev.selection && (st.selection.length !== prev.selection.length || st.selection.some((id) => !prev.selection.includes(id)));
  if (reselected || st.pageId !== prev.pageId || lost) {
    sessionDoc = null;
    useXform.getState().set({ session: null });
  }
});

export function endTransformSession(cancel: boolean) {
  const start = useXform.getState().session;
  if (start == null) return false;
  const target = sessionDoc;
  sessionDoc = null;
  useXform.getState().set({ session: null });
  const s = S();
  if (cancel) {
    // back to the document the session started from (by identity: the history may be at its cap)
    if (target && (S().doc === target || S().past.some((e) => e.doc === target))) while (S().doc !== target && S().past.length) S().undo();
    s.notify(t("ribbon.msg.transformCancelled"));
  } else s.notify(t("ribbon.msg.transformCommitted"));
  return true;
}
