// The design mode's Mesh tool (U) and opacity masks (Illustrator, design 2 2026-11-25).
//  • Mesh tool: a click on a path makes its fill a gradient mesh and puts mesh lines through the point; a click on a
//    mesh point picks it (its colour is then what the Fill field sets) and shows its curve handles; a drag moves the
//    point or a handle (the mesh lines are curves). Alt+click removes the mesh lines through a point. core/mesh.ts
//    holds the mesh; the renderers draw it.
//  • Opacity mask (Transparency panel › Make Mask / Release): the topmost selected object masks the others by its
//    brightness (core/layerTree.ts lumMask); Release puts it back on top as an ordinary object.

import { create } from "zustand";
import { applyTransform, invertTransform, rectFromPoints } from "../core/geom";
import { flatten } from "../core/vector";
import { currentPage, draftPage, useStore } from "../core/store";
import type { Page, SceneNode, Vec2, VectorNode } from "../core/types";
import { H_DOWN, H_RIGHT, meshAddAt, meshHandle, meshHandleAt, meshIndex, meshPointAt, meshRemoveAt, meshSetHandle, newMesh, patchPoint, type MeshFill } from "../core/mesh";
import { clipBase } from "../core/layerTree";
import { t } from "../i18n";

const S = () => useStore.getState();
const ACCENT = "#2b74ec";

/** The picked mesh point: the path and the point's index in its mesh. */
export const useMeshPick = create<{ id: string | null; idx: number }>(() => ({ id: null, idx: -1 }));

const meshNode = (page: Page | undefined, id: string | null) => {
  const n = id ? page?.nodes.find((x) => x.id === id) : undefined;
  return n?.type === "VECTOR" && n.meshFill ? n : null;
};

/** a point or (dir ≥ 0) one of its handles being dragged */
let drag: { id: string; idx: number; dir: number; moved: boolean; start: Vec2 } | null = null;

export interface MeshEnv {
  hit: (p: Vec2) => SceneNode | undefined;
  invalidate: () => void;
}

/** A press with the Mesh tool: "drag" (a point or a handle to move), "done", or false. */
export function meshDown(e: { altKey: boolean }, p: Vec2, env: MeshEnv): "drag" | "done" | false {
  const s = S();
  const page = currentPage();
  if (!page) return false;
  const zoom = s.view.zoom;
  // the picked point's handles first, then a point of a selected mesh (picked, then dragged)
  const pick = useMeshPick.getState();
  const picked = meshNode(page, pick.id);
  if (picked && !picked.locked && s.selection.includes(picked.id) && pick.idx >= 0) {
    const k = Math.abs(picked.transform.scale) || 1;
    const dir = meshHandleAt(picked.meshFill!, pick.idx, invertTransform(picked.transform, p), 6 / zoom / k);
    if (dir >= 0) {
      drag = { id: picked.id, idx: pick.idx, dir, moved: false, start: p };
      return "drag";
    }
  }
  for (const id of s.selection) {
    const n = meshNode(page, id);
    if (!n || n.locked) continue;
    const k = Math.abs(n.transform.scale) || 1;
    const i = meshPointAt(n.meshFill!, invertTransform(n.transform, p), 6 / zoom / k);
    if (i < 0) continue;
    if (e.altKey) {
      removeMeshLines(n, i);
      env.invalidate();
      return "done";
    }
    useMeshPick.setState({ id: n.id, idx: i });
    drag = { id: n.id, idx: i, dir: -1, moved: false, start: p };
    env.invalidate();
    return "drag";
  }
  const hit = env.hit(p);
  if (!hit || hit.type !== "VECTOR" || hit.locked || !hit.contours.some((c) => c.closed && c.nodes.length > 2)) {
    useMeshPick.setState({ id: null, idx: -1 });
    S().set({ selection: [] });
    env.invalidate();
    return "done";
  }
  addMeshPoint(hit, p);
  env.invalidate();
  return "done";
}

/** Mesh lines through page point p on path n (the path's fill becomes a mesh first); the new point is picked. */
export function addMeshPoint(n: VectorNode, p: Vec2): boolean {
  const page = currentPage();
  if (!page) return false;
  const q = invertTransform(n.transform, p);
  // the mesh over the path's own outline box (no stroke margin): its corners are the shape's corners
  const base: MeshFill = n.meshFill ?? newMesh(rectFromPoints(n.contours.flatMap((c) => flatten(c, 0.5))), n.fill ?? "#ffffff");
  const r = meshAddAt(base, q);
  if (!r) return false;
  S().commit(t("design.mesh.hist.add"), (d) => {
    const x = draftPage(d, page.id)?.nodes.find((y) => y.id === n.id);
    if (x?.type === "VECTOR") x.meshFill = r.mesh as never;
  });
  S().set({ selection: [n.id] });
  useMeshPick.setState({ id: n.id, idx: r.index });
  return true;
}

/** Alt+click on a mesh point: the row and column lines through it go (the outer edge stays). */
export function removeMeshLines(n: VectorNode, idx: number): boolean {
  const m = n.meshFill;
  const page = currentPage();
  const next = m ? meshRemoveAt(m, idx) : null;
  if (!next || !page) return false;
  S().commit(t("design.mesh.hist.remove"), (d) => {
    const x = draftPage(d, page.id)?.nodes.find((y) => y.id === n.id);
    if (x?.type !== "VECTOR") return;
    if (next.rows === 1 && next.cols === 1 && new Set(next.pts.map((q) => q.c)).size === 1 && next.pts.every((q) => !q.h)) delete x.meshFill;
    else x.meshFill = next as never;
  });
  useMeshPick.setState({ id: null, idx: -1 });
  return true;
}

/** Drag a handle of mesh point `idx` of path `id` to page point p (one undo step per call; tests and scripts). */
export function setMeshHandle(id: string, idx: number, dir: number, p: Vec2): boolean {
  const page = currentPage();
  const n = meshNode(page, id);
  if (!n || !page) return false;
  const q = invertTransform(n.transform, p);
  const at = n.meshFill!.pts[idx]?.p;
  if (!at) return false;
  S().commit(t("design.mesh.hist.handle"), (d) => {
    const x = draftPage(d, page.id)?.nodes.find((y) => y.id === id);
    if (x?.type === "VECTOR" && x.meshFill) x.meshFill = meshSetHandle(x.meshFill as MeshFill, idx, dir, [q[0] - at[0], q[1] - at[1]]) as never;
  });
  return true;
}

export function meshMove(p: Vec2): void {
  const d = drag;
  const page = currentPage();
  if (!d || !page) return;
  const s = S();
  if (!d.moved) {
    if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) * s.view.zoom < 3) return;
    d.moved = true;
    s.beginGesture();
  }
  s.updateGesture((doc) => {
    const x = draftPage(doc, page.id)?.nodes.find((y) => y.id === d.id);
    if (x?.type !== "VECTOR" || !x.meshFill) return;
    const q = invertTransform(x.transform, p);
    const m = x.meshFill as MeshFill;
    if (d.dir < 0) m.pts[d.idx].p = q as never;
    else {
      const at = m.pts[d.idx].p;
      x.meshFill = meshSetHandle(m, d.idx, d.dir, [q[0] - at[0], q[1] - at[1]]) as never;
    }
  });
}

export function meshUp(): void {
  const d = drag;
  drag = null;
  if (d?.moved) S().endGesture(t(d.dir < 0 ? "design.mesh.hist.move" : "design.mesh.hist.handle"));
}

export function meshCancel(): void {
  if (drag?.moved) S().cancelGesture();
  drag = null;
}

/**
 * The Fill field with the Mesh tool and a mesh point picked: the point's colour (Illustrator). Call inside a commit
 * recipe on the draft node; true when it took the colour.
 */
export function meshPaint(x: SceneNode, color: string): boolean {
  const pick = useMeshPick.getState();
  if (S().tool !== "meshTool" || x.type !== "VECTOR" || !x.meshFill || pick.id !== x.id || pick.idx < 0 || pick.idx >= x.meshFill.pts.length) return false;
  x.meshFill.pts[pick.idx].c = color;
  return true;
}

/** The colour of the picked mesh point of `n`, if any (what the Fill field shows). */
export function pickedMeshColor(n: SceneNode): string | null {
  const pick = useMeshPick.getState();
  if (S().tool !== "meshTool" || n.type !== "VECTOR" || !n.meshFill || pick.id !== n.id) return null;
  return n.meshFill.pts[pick.idx]?.c ?? null;
}

/** The mesh lines (curves) and points of the selected meshes, and the picked point's handles. */
export function meshDraw(o: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2, hair: number): void {
  const s = S();
  if (s.tool !== "meshTool" && s.tool !== "direct") return;
  const page = currentPage();
  const pick = useMeshPick.getState();
  for (const id of s.selection) {
    const n = meshNode(page, id);
    if (!n) continue;
    const m = n.meshFill!;
    const T = (q: Vec2) => toScreen(applyTransform(n.transform, q));
    const P = (i: number) => T(m.pts[i].p);
    o.save();
    o.strokeStyle = ACCENT;
    o.lineWidth = hair;
    o.beginPath();
    // each mesh line as its cubic (Bézier through the handles)
    const line = (r: number, c: number, dir: number) => {
      const [r2, c2] = dir === H_RIGHT ? [r, c + 1] : [r + 1, c];
      const a = m.pts[meshIndex(m, r, c)].p, b = m.pts[meshIndex(m, r2, c2)].p;
      const ha = meshHandle(m, r, c, dir)!, hb = meshHandle(m, r2, c2, dir === H_RIGHT ? 0 : 2)!;
      const A = T(a), B = T(b), A1 = T([a[0] + ha[0], a[1] + ha[1]]), B1 = T([b[0] + hb[0], b[1] + hb[1]]);
      o.moveTo(A[0], A[1]);
      o.bezierCurveTo(A1[0], A1[1], B1[0], B1[1], B[0], B[1]);
    };
    for (let r = 0; r <= m.rows; r++)
      for (let c = 0; c <= m.cols; c++) {
        if (c < m.cols) line(r, c, H_RIGHT);
        if (r < m.rows) line(r, c, H_DOWN);
      }
    o.stroke();
    // the picked point's handles
    if (pick.id === n.id && pick.idx >= 0 && pick.idx < m.pts.length) {
      const r = Math.floor(pick.idx / (m.cols + 1)), c = pick.idx % (m.cols + 1);
      const a = m.pts[pick.idx].p, A = T(a);
      for (let dir = 0; dir < 4; dir++) {
        const h = meshHandle(m, r, c, dir);
        if (!h) continue;
        const H = T([a[0] + h[0], a[1] + h[1]]);
        o.beginPath();
        o.moveTo(A[0], A[1]);
        o.lineTo(H[0], H[1]);
        o.stroke();
        o.beginPath();
        o.fillStyle = ACCENT;
        o.arc(H[0], H[1], 3.5, 0, Math.PI * 2);
        o.fill();
      }
    }
    m.pts.forEach((_, i) => {
      const a = P(i);
      const on = pick.id === n.id && pick.idx === i;
      o.fillStyle = on ? ACCENT : "#ffffff";
      o.fillRect(a[0] - 3.5, a[1] - 3.5, 7, 7);
      o.strokeRect(a[0] - 3.5, a[1] - 3.5, 7, 7);
    });
    o.restore();
  }
}

/** A point of mesh patch (r, c) on the page (tests and scripts: where to click). */
export function meshPatchPoint(n: VectorNode, r: number, c: number, u: number, v: number): Vec2 | null {
  return n.meshFill ? (applyTransform(n.transform, patchPoint(n.meshFill, r, c, u, v)) as Vec2) : null;
}

// ───────── opacity masks ─────────

const ordered = (page: Page, ids: readonly string[]) => {
  const want = new Set(ids);
  return page.nodes.filter((n) => want.has(n.id) && !n.locked);
};

export const canMakeOpacityMask = () => {
  const page = currentPage();
  return !!page && ordered(page, S().selection).filter((n) => !n.lumMask).length >= 2;
};

/** The opacity mask the selection belongs to (a selected mask, or the mask of a selected masked object). */
function maskOfSelection(page: Page): SceneNode | null {
  for (const n of page.nodes.filter((x) => S().selection.includes(x.id))) {
    if (n.lumMask) return n;
    if (n.clip) {
      const b = clipBase(page, n.id);
      if (b && "type" in b && (b as SceneNode).lumMask) return b as SceneNode;
    }
  }
  return null;
}
export const canReleaseOpacityMask = () => {
  const page = currentPage();
  return !!page && !!maskOfSelection(page);
};

/** Transparency panel › Make Mask: the topmost selected object masks the others by its brightness. */
export function makeOpacityMask(): boolean {
  const page = currentPage();
  if (!page) return false;
  const sel = ordered(page, S().selection).filter((n) => !n.lumMask);
  if (sel.length < 2) {
    S().notify(t("design.mask.need2"));
    return false;
  }
  const top = sel[sel.length - 1];
  const others = new Set(sel.slice(0, -1).map((n) => n.id));
  S().commit(t("design.mask.hist.make"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const [mask] = pg.nodes.splice(pg.nodes.findIndex((n) => n.id === top.id), 1);
    // the masked objects next to each other right above the mask (the stack is contiguous)
    const moved = pg.nodes.filter((n) => others.has(n.id));
    const at = Math.max(0, pg.nodes.findIndex((n) => others.has(n.id)));
    const rest = pg.nodes.filter((n) => !others.has(n.id));
    // (the nodes before the lowest masked one are all unmasked: rest starts with them)
    const before = rest.slice(0, at), after = rest.slice(at);
    delete mask.clip;
    mask.lumMask = true;
    for (const n of moved) {
      n.clip = true;
      n.groupId = mask.groupId;
    }
    pg.nodes = [...before, mask, ...moved, ...after] as never;
  });
  S().set({ selection: [...others] });
  return true;
}

/** Transparency panel › Release: the mask becomes an ordinary object again, on top of what it masked. */
export function releaseOpacityMask(): boolean {
  const page = currentPage();
  const mask = page ? maskOfSelection(page) : null;
  if (!page || !mask) return false;
  S().commit(t("design.mask.hist.release"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const i = pg.nodes.findIndex((n) => n.id === mask.id);
    const m = pg.nodes[i];
    let j = i + 1;
    for (; j < pg.nodes.length && pg.nodes[j].clip && (pg.nodes[j].groupId ?? "") === (m.groupId ?? ""); j++) delete pg.nodes[j].clip;
    delete m.lumMask;
    pg.nodes.splice(i, 1);
    pg.nodes.splice(j - 1, 0, m);
  });
  S().set({ selection: [mask.id] });
  return true;
}
