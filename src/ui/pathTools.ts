// Pen family and anchor-point editing on the canvas (Illustrator / Photoshop pen tools, PowerPoint 점 편집) — the UI
// side of core/pathEdit.ts. One engine for every mode: design (펜·곡률·기준점 추가/삭제/변환·직접 선택), image (the
// pen group of Photoshop) and slides (점 편집, PowerPoint names, no letter keys).
//
//   selected anchors      useAnchors (keys "nodeId:contour:point"); filled squares, the others hollow
//   hit testing           pathHitAt: handle ends, anchor points, segments of the shown paths (screen tolerance)
//   edits                 one history step each (commitPath); drags go through the store gesture (CanvasView)
//   keys                  Delete (points and their segments) · Esc here; arrows (Shift ×10) in CanvasView; Ctrl+J
//                         in imageDesignKeys (design mode — Photoshop's Ctrl+J is a layer copy)

import { create } from "zustand";
import { applyTransform, invertTransform } from "../core/geom";
import { currentPage, draftPage, useStore, type Tool } from "../core/store";
import type { Contour, Page, SceneNode, Vec2, VectorNode } from "../core/types";
import {
  cutAt, deleteAnchors, endOf, insertAnchorAt, joinEnds, makeCorner, makeSmooth, moveAnchor, nearestOnContour, removeAnchor, toggleSmooth,
} from "../core/pathEdit";
import { pickableOn } from "../core/layerTree";
import { t } from "../i18n";
import { currentEditMode } from "./editModes";

const S = () => useStore.getState();

/** History labels and messages in the mode's words: PowerPoint 점 편집 terms in slides (pen.SLIDE.*), Illustrator's elsewhere. */
export const hl = (key: string) => (currentEditMode() === "SLIDE" ? t(`pen.SLIDE.${key}`, undefined, t(key)) : t(key));

/** Tools that show the anchor points of the selected paths (and edit them). */
export const PATH_TOOLS: readonly Tool[] = ["direct", "pen", "curvature", "anchorAdd", "anchorDel", "anchorConvert"];
export const isPathTool = (tool: Tool) => PATH_TOOLS.includes(tool);

export interface AnchorRef {
  id: string;
  ci: number;
  ni: number;
}
export const akey = (r: AnchorRef) => `${r.id}:${r.ci}:${r.ni}`;
export const parseKey = (k: string): AnchorRef => {
  const i = k.lastIndexOf(":"), j = k.lastIndexOf(":", i - 1);
  return { id: k.slice(0, j), ci: Number(k.slice(j + 1, i)), ni: Number(k.slice(i + 1)) };
};

/** Selected anchor points (direct selection); the paths they belong to are in the store selection too. */
export const useAnchors = create<{ sel: string[]; hover: string | null; set: (p: Partial<{ sel: string[]; hover: string | null }>) => void }>((set) => ({
  sel: [],
  hover: null,
  set,
}));
const A = () => useAnchors.getState();
export const setAnchors = (sel: string[]) => A().set({ sel });

// selected points belong to selected paths: deselecting a path drops its points
useStore.subscribe((s, p) => {
  if (s.selection === p.selection && s.pageId === p.pageId) return;
  const sel = A().sel;
  if (!sel.length) return;
  const keep = s.pageId === p.pageId ? sel.filter((k) => s.selection.includes(parseKey(k).id)) : [];
  if (keep.length !== sel.length) setAnchors(keep);
});

/** The selected points that still exist (undo can take points away). */
export function selectedAnchors(page: Page | undefined = currentPage()): AnchorRef[] {
  if (!page) return [];
  return A()
    .sel.map(parseKey)
    .filter((r) => {
      const n = page.nodes.find((x) => x.id === r.id);
      return n?.type === "VECTOR" && !!n.contours[r.ci]?.nodes[r.ni];
    });
}

export const isAnchorSelected = (r: AnchorRef) => A().sel.includes(akey(r));

/** Selected, visible, unlocked paths of the page — the ones whose points are shown. */
export function shownPaths(page: Page | undefined = currentPage()): VectorNode[] {
  if (!page) return [];
  const sel = S().selection;
  const pick = pickableOn(page);
  return page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && sel.includes(n.id) && pick(n));
}

/**
 * Which direction handles of a path are shown (Illustrator): both handles of a selected point, and the handles of
 * its neighbours that reach into the selected point's segments.
 */
export function shownHandles(n: VectorNode): Set<string> {
  const out = new Set<string>();
  const sel = new Set(A().sel);
  n.contours.forEach((c, ci) => {
    const len = c.nodes.length;
    c.nodes.forEach((_, ni) => {
      if (!sel.has(`${n.id}:${ci}:${ni}`)) return;
      out.add(`${ci}:${ni}:in`).add(`${ci}:${ni}:out`);
      if (ni > 0 || c.closed) out.add(`${ci}:${(ni - 1 + len) % len}:out`);
      if (ni < len - 1 || c.closed) out.add(`${ci}:${(ni + 1) % len}:in`);
    });
  });
  return out;
}

export type PathHit =
  | { kind: "handle"; node: VectorNode; ci: number; ni: number; part: "in" | "out" }
  | { kind: "anchor"; node: VectorNode; ci: number; ni: number; end: "start" | "end" | null }
  | { kind: "segment"; node: VectorNode; ci: number; seg: number; u: number }
  | { kind: "body"; node: VectorNode };

/**
 * What lies under page point p among `nodes` (default: the shown paths), within `tol` screen px at `zoom`: shown
 * handle ends first, then anchor points, then segments, then a filled inside.
 */
export function pathHitAt(p: Vec2, zoom: number, tol = 6, nodes: VectorNode[] = shownPaths(), opts: { handles?: boolean; body?: boolean } = {}): PathHit | null {
  const scr = (n: VectorNode, q: Vec2) => {
    const r = applyTransform(n.transform, q);
    return Math.hypot(r[0] - p[0], r[1] - p[1]) * zoom;
  };
  const top = [...nodes].reverse();
  if (opts.handles !== false)
    for (const n of top) {
      const shown = shownHandles(n);
      for (let ci = 0; ci < n.contours.length; ci++)
        for (let ni = 0; ni < n.contours[ci].nodes.length; ni++) {
          const a = n.contours[ci].nodes[ni];
          for (const part of ["in", "out"] as const) {
            const h = part === "in" ? a.handleIn : a.handleOut;
            if (!shown.has(`${ci}:${ni}:${part}`) || (h[0] === a.anchor[0] && h[1] === a.anchor[1])) continue;
            if (scr(n, h) <= tol) return { kind: "handle", node: n, ci, ni, part };
          }
        }
    }
  for (const n of top)
    for (let ci = 0; ci < n.contours.length; ci++)
      for (let ni = 0; ni < n.contours[ci].nodes.length; ni++)
        if (scr(n, n.contours[ci].nodes[ni].anchor) <= tol) return { kind: "anchor", node: n, ci, ni, end: endOf(n.contours[ci], ni) };
  for (const n of top) {
    const lp = invertTransform(n.transform, p);
    const k = Math.abs(n.transform.scale) || 1;
    for (let ci = 0; ci < n.contours.length; ci++) {
      const h = nearestOnContour(n.contours[ci], lp);
      if (h && h.d * k * zoom <= tol + (n.stroke ? (n.strokeWidth * k * zoom) / 2 : 0)) return { kind: "segment", node: n, ci, seg: h.seg, u: h.u };
    }
  }
  if (opts.body)
    for (const n of top) if (n.fill && insideFill(n, p)) return { kind: "body", node: n };
  return null;
}

let insideImpl: ((n: VectorNode, lp: Vec2) => boolean) | null = null;
/** CanvasView hands its fill test over (vector.ts pointInContours) so this file stays free of the render imports. */
export const setInsideTest = (f: (n: VectorNode, lp: Vec2) => boolean) => void (insideImpl = f);
const insideFill = (n: VectorNode, p: Vec2) => !!insideImpl?.(n, invertTransform(n.transform, p));

// ───────── edits (one history step each) ─────────

/** Change one path's contours in a history step; a path left without contours is removed. */
export function commitPath(label: string, id: string, fn: (n: VectorNode) => void) {
  const pageId = S().pageId;
  S().commit(label, (d) => {
    const pg = draftPage(d, pageId);
    const n = pg?.nodes.find((x) => x.id === id);
    if (!pg || n?.type !== "VECTOR") return;
    fn(n as VectorNode);
    n.contours = n.contours.filter((c) => c.nodes.length >= 2);
    if (!n.contours.length) pg.nodes = pg.nodes.filter((x) => x.id !== id) as typeof pg.nodes;
  });
}

/** Add an anchor point on a segment (the shape stays); it becomes the selected point. */
export function addAnchor(n: VectorNode, ci: number, seg: number, u: number) {
  let at = -1;
  commitPath(hl("design.hist.addAnchor"), n.id, (d) => void (at = insertAnchorAt(d.contours[ci], seg, u)));
  if (!S().selection.includes(n.id)) S().set({ selection: [n.id] });
  // later points of this contour moved one place on
  setAnchors(at >= 0 ? [akey({ id: n.id, ci, ni: at })] : []);
}

/** Delete one anchor point; the curve around it is refitted to keep the shape as well as it can. */
export function deleteAnchor(n: VectorNode, ci: number, ni: number) {
  commitPath(hl("design.hist.deleteAnchor"), n.id, (d) => {
    if (!removeAnchor(d.contours[ci], ni)) d.contours.splice(ci, 1);
  });
  setAnchors([]);
}

/** Convert anchor point tool click: smooth ↔ corner. */
export function convertAnchor(n: VectorNode, ci: number, ni: number) {
  commitPath(hl("shell.hist.convertAnchor"), n.id, (d) => toggleSmooth(d.contours[ci], ni));
}

/** The selected points grouped by path id. */
function byNode(refs: AnchorRef[]): Map<string, AnchorRef[]> {
  const m = new Map<string, AnchorRef[]>();
  for (const r of refs) m.set(r.id, [...(m.get(r.id) ?? []), r]);
  return m;
}

/** Delete: the selected points and their segments (paths break there, Illustrator). False when none is selected. */
export function deleteSelectedAnchors(): boolean {
  const refs = selectedAnchors();
  if (!refs.length) return false;
  const groups = byNode(refs);
  const pageId = S().pageId;
  S().commit(hl("design.hist.deleteAnchor"), (d) => {
    const pg = draftPage(d, pageId);
    if (!pg) return;
    for (const [id, rs] of groups) {
      const n = pg.nodes.find((x) => x.id === id) as VectorNode | undefined;
      if (!n) continue;
      n.contours = deleteAnchors(JSON.parse(JSON.stringify(n.contours)), (ci, ni) => rs.some((r) => r.ci === ci && r.ni === ni));
    }
    pg.nodes = pg.nodes.filter((x) => x.type !== "VECTOR" || !groups.has(x.id) || x.contours.length > 0) as typeof pg.nodes;
  });
  setAnchors([]);
  return true;
}

/** Remove the selected points keeping the path whole (each refitted like the delete anchor point tool). */
export function removeSelectedAnchors(): boolean {
  const refs = selectedAnchors();
  if (!refs.length) return false;
  const pageId = S().pageId;
  S().commit(hl("design.hist.deleteAnchor"), (d) => {
    const pg = draftPage(d, pageId);
    if (!pg) return;
    // from the last point back, so the earlier indices stay right
    for (const r of [...refs].sort((a, b) => b.ci - a.ci || b.ni - a.ni)) {
      const n = pg.nodes.find((x) => x.id === r.id) as VectorNode | undefined;
      const c = n?.contours[r.ci];
      if (c && !removeAnchor(c, r.ni)) c.nodes = [];
    }
    const ids = new Set(refs.map((r) => r.id));
    for (const n of pg.nodes) if (n.type === "VECTOR" && ids.has(n.id)) n.contours = n.contours.filter((c) => c.nodes.length >= 2);
    pg.nodes = pg.nodes.filter((x) => x.type !== "VECTOR" || !ids.has(x.id) || x.contours.length > 0) as typeof pg.nodes;
  });
  setAnchors([]);
  return true;
}

/** Corner / smooth for the selected points (Illustrator's control bar, PowerPoint 꼭짓점 / 부드러운 점). */
export function setSelectedKind(kind: "corner" | "smooth"): boolean {
  const refs = selectedAnchors();
  if (!refs.length) return false;
  const pageId = S().pageId;
  S().commit(hl("shell.hist.convertAnchor"), (d) => {
    const pg = draftPage(d, pageId);
    for (const r of refs) {
      const n = pg?.nodes.find((x) => x.id === r.id) as VectorNode | undefined;
      const c = n?.contours[r.ci];
      if (!c) continue;
      if (kind === "corner") makeCorner(c.nodes[r.ni]);
      else makeSmooth(c, r.ni);
    }
  });
  return true;
}

/** Cut the path at the selected points (each becomes two end points). */
export function cutSelected(): boolean {
  const refs = selectedAnchors();
  if (!refs.length) return false;
  const pageId = S().pageId;
  S().commit(hl("pen.hist.cut"), (d) => {
    const pg = draftPage(d, pageId);
    for (const [id, rs] of byNode(refs)) {
      const n = pg?.nodes.find((x) => x.id === id) as VectorNode | undefined;
      if (n) n.contours = cutAt(JSON.parse(JSON.stringify(n.contours)), (ci, ni) => rs.some((r) => r.ci === ci && r.ni === ni));
    }
  });
  setAnchors([]);
  return true;
}

/**
 * Ctrl+J (Illustrator join): two selected end points are connected (one path closes, two paths become one — across
 * two objects too, the second one's points moving into the first); with whole open paths selected and no points, each
 * open contour closes. False when there is nothing to join.
 */
export function joinSelected(): boolean {
  const page = currentPage();
  if (!page) return false;
  const refs = selectedAnchors(page);
  const node = (id: string) => page.nodes.find((x) => x.id === id) as VectorNode;
  if (refs.length === 2) {
    const [p, q] = refs;
    if (!endOf(node(p.id).contours[p.ci], p.ni) || !endOf(node(q.id).contours[q.ci], q.ni)) return notJoinable();
    if (p.id === q.id) {
      let ok = false;
      commitPath(hl("pen.hist.join"), p.id, (d) => {
        const r = joinEnds(JSON.parse(JSON.stringify(d.contours)), p, q);
        if (r) (d.contours = r), (ok = true);
      });
      setAnchors([]);
      return ok || notJoinable();
    }
    // two objects: the second path's contours move into the first (page → its local space), then join
    const a = node(p.id), b = node(q.id);
    const moved: Contour[] = b.contours.map((c) => ({
      closed: c.closed,
      nodes: c.nodes.map((x) => {
        const m = (v: Vec2) => invertTransform(a.transform, applyTransform(b.transform, v));
        return { anchor: m(x.anchor), handleIn: m(x.handleIn), handleOut: m(x.handleOut), isCorner: x.isCorner };
      }),
    }));
    const pageId = S().pageId;
    S().commit(hl("pen.hist.join"), (d) => {
      const pg = draftPage(d, pageId);
      const da = pg?.nodes.find((x) => x.id === a.id) as VectorNode | undefined;
      if (!pg || !da) return;
      const base = da.contours.length;
      const all = [...JSON.parse(JSON.stringify(da.contours)), ...moved] as Contour[];
      const r = joinEnds(all, p, { ci: base + q.ci, ni: q.ni });
      if (!r) return;
      da.contours = r;
      pg.nodes = pg.nodes.filter((x) => x.id !== b.id) as typeof pg.nodes;
    });
    S().set({ selection: [a.id] });
    setAnchors([]);
    return true;
  }
  if (refs.length) return notJoinable();
  const open = shownPaths(page).filter((n) => n.contours.some((c) => !c.closed && c.nodes.length > 2));
  if (!open.length) return false;
  S().commit(hl("pen.hist.join"), (d) => {
    const pg = draftPage(d, S().pageId);
    for (const n of open) {
      const dn = pg?.nodes.find((x) => x.id === n.id) as VectorNode | undefined;
      dn?.contours.forEach((c) => {
        if (c.nodes.length > 2) c.closed = true;
      });
    }
  });
  return true;
}
const notJoinable = () => (S().notify(hl("pen.msg.joinEnds")), true);

/** Arrow keys with points selected: move them (page px; Shift = 10). */
export function nudgeAnchors(dx: number, dy: number): boolean {
  const refs = selectedAnchors();
  if (!refs.length) return false;
  const page = currentPage()!;
  const pageId = page.id;
  S().commit(hl("shell.hist.editAnchors"), (d) => {
    const pg = draftPage(d, pageId);
    for (const r of refs) {
      const n = pg?.nodes.find((x) => x.id === r.id) as VectorNode | undefined;
      if (!n) continue;
      const o = invertTransform(n.transform, [0, 0]), q = invertTransform(n.transform, [dx, dy]);
      moveAnchor(n.contours[r.ci].nodes[r.ni], q[0] - o[0], q[1] - o[1]);
    }
  });
  return true;
}

/** Anchor points of the pickable paths inside a page rectangle (direct selection marquee). */
export function anchorsInRect(page: Page, r: { x: number; y: number; w: number; h: number }, filter?: ((n: SceneNode) => boolean) | null): string[] {
  const pick = pickableOn(page);
  const out: string[] = [];
  for (const n of page.nodes) {
    if (n.type !== "VECTOR" || !pick(n) || (filter && !filter(n))) continue;
    n.contours.forEach((c, ci) =>
      c.nodes.forEach((a, ni) => {
        const q = applyTransform(n.transform, a.anchor);
        if (q[0] >= r.x && q[0] <= r.x + r.w && q[1] >= r.y && q[1] <= r.y + r.h) out.push(akey({ id: n.id, ci, ni }));
      }),
    );
  }
  return out;
}

/** Keys while a path tool is active (shortcuts.ts asks before its own Delete / arrows / Esc). True = handled. */
export function pathKey(e: KeyboardEvent): boolean {
  if (!isPathTool(S().tool) || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === "Delete" || e.key === "Backspace") return deleteSelectedAnchors();
  if (e.key === "Escape" && A().sel.length) return setAnchors([]), true;
  return false;
}
