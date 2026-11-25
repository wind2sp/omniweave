// The design mode's perspective grid (Illustrator's Perspective Grid tool Shift+P and Perspective Selection tool
// Shift+V, design 2 2026-11-25).
//  • Shift+P shows the page's grid (two-point by default; one-point from the options bar) and lets its vanishing
//    points, horizon, ground line, corner and wall height be dragged by their handles. The grid is part of the page
//    (saved in .omw, and in an .ai / PDF's page-piece data): undo, redo and the file keep it.
//  • While the grid shows, the shape tools (rectangle, rounded rectangle, ellipse, polygon, star, line) draw on the
//    active plane (keys 1 left, 2 floor, 3 right, 4 none — Illustrator's plane widget, also in the options bar).
//  • Shift+V: a drag puts an object (a path, or text — as outlines) onto the active plane where it is dropped, and
//    moves an object already on a plane along it. Objects on the grid follow when the grid changes.

import { create } from "zustand";
import { applyTransform } from "../core/geom";
import { currentPage, draftPage, useStore } from "../core/store";
import { IDENTITY, type Contour, type Page, type SceneNode, type TextNode, type Vec2, type VectorAnchor, type VectorNode } from "../core/types";
import { defaultGrid, flatToPage, pageToFlat, planeAt, planeLines, planeQuad, projectContours, type PerspGrid, type PerspPlane, type SavedPerspGrid } from "../core/perspective";
import { ellipseContour } from "../core/vector";
import { drawnShape, polygonContour, roundRectContour, useShapeParams, type ShapeKind } from "./drawDefaults";
import { outlinesOf } from "./designOutlines";
import { t } from "../i18n";

const S = () => useStore.getState();
const PLANE_COLOR: Record<PerspPlane, string> = { left: "#2b74ec", right: "#e0603a", floor: "#2fa35b" };

export type ActivePlane = PerspPlane | "none";
export const usePersp = create<{ plane: ActivePlane }>(() => ({ plane: "left" }));
export const setPlane = (plane: ActivePlane) => usePersp.setState({ plane });

/** The grid of a page when it shows. */
export const gridOf = (page: Page | undefined | null): SavedPerspGrid | null => (page?.perspGrid?.shown ? page.perspGrid : null);
export const currentGrid = () => gridOf(currentPage());

/** Objects on the grid projected again from their flat outlines (inside a recipe, after the grid changed). */
function reproject(pg: Page, g: PerspGrid) {
  for (const n of pg.nodes) if (n.type === "VECTOR" && n.persp) n.contours = projectContours(g, n.persp.plane, n.persp.flat as Contour[]) as never;
}

/** Show the grid (a fresh one over the page when it has none, or `kind` asked for another kind). */
export function showGrid(kind?: 1 | 2): void {
  const page = currentPage();
  if (!page) return;
  const g = page.perspGrid;
  if (g?.shown && (!kind || g.kind === kind)) return;
  S().commit(t("design.persp.hist.show"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const fresh = !g || (!!kind && g.kind !== kind);
    pg.perspGrid = (fresh ? { ...defaultGrid(page.width, page.height, kind ?? g?.kind ?? 2), shown: true } : { ...g!, shown: true }) as never;
    if (fresh) reproject(pg as Page, pg.perspGrid as PerspGrid);
  });
}
export function hideGrid(): void {
  const page = currentPage();
  if (!page?.perspGrid?.shown) return;
  S().commit(t("design.persp.hist.hide"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg?.perspGrid) pg.perspGrid.shown = false;
  });
}
export const toggleGrid = () => (currentGrid() ? hideGrid() : showGrid());

// the Perspective Grid tool (and the Perspective Selection tool) show the grid
useStore.subscribe((s, prev) => {
  if ((s.tool === "perspGrid" || s.tool === "perspSelect") && s.tool !== prev.tool) queueMicrotask(() => showGrid());
});

// ───────── grid handles ─────────

export type GridHandle = "vp1" | "vp2" | "corner" | "top" | "ox2" | "horizon";
function handles(g: PerspGrid): { h: GridHandle; at: Vec2 }[] {
  const out: { h: GridHandle; at: Vec2 }[] = [
    { h: "vp1", at: [g.vp1, g.horizon] },
    { h: "corner", at: [g.ox, g.ground] },
    { h: "top", at: [g.ox, g.ground - g.height] },
  ];
  if (g.kind === 2) out.push({ h: "vp2", at: [g.vp2, g.horizon] });
  else out.push({ h: "ox2", at: [g.ox2, g.ground] });
  return out;
}

function movedGrid(g: PerspGrid, h: GridHandle, p: Vec2): PerspGrid {
  const next = { ...g };
  switch (h) {
    case "vp1":
      next.vp1 = p[0];
      next.horizon = Math.min(p[1], g.ground - 4);
      break;
    case "vp2":
      next.vp2 = p[0];
      next.horizon = Math.min(p[1], g.ground - 4);
      break;
    case "horizon":
      next.horizon = Math.min(p[1], g.ground - 4);
      break;
    case "corner":
      next.ox = p[0];
      next.ground = Math.max(p[1], g.horizon + 4);
      break;
    case "ox2":
      next.ox2 = p[0];
      break;
    case "top":
      next.height = Math.max(4, g.ground - p[1]);
      break;
  }
  return next;
}

/** Move a grid handle to page point p (one undo step; tests and scripts). */
export function moveGridHandle(h: GridHandle, p: Vec2): boolean {
  const page = currentPage();
  const g = gridOf(page);
  if (!page || !g) return false;
  S().commit(t("design.persp.hist.edit"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.perspGrid = { ...movedGrid(g, h, p), shown: true } as never;
    reproject(pg as Page, pg.perspGrid as PerspGrid);
  });
  return true;
}

export type PlaneShape = "rect" | "ellipse" | "roundRect" | "polygon" | "star" | "line";
const PLANE_SHAPES = new Set<string>(["rect", "ellipse", "roundRect", "polygon", "star", "line"]);

type Drag =
  | { kind: "handle"; h: GridHandle; moved: boolean }
  | { kind: "draw"; plane: PerspPlane; shape: PlaneShape; a: Vec2; b: Vec2 }
  | { kind: "move"; ids: string[]; plane: PerspPlane; start: Vec2; flat0: Map<string, Contour[]>; d0: Map<string, Vec2>; moved: boolean }
  | { kind: "attach"; id: string; plane: PerspPlane; start: Vec2; cur: Vec2 };
let drag: Drag | null = null;

/** A press: grid handles, shapes on the active plane, the Perspective Selection tool. */
export function perspDown(p: Vec2, hit: (p: Vec2) => SceneNode | undefined): "drag" | "done" | false {
  const s = S();
  const g = currentGrid();
  const plane = usePersp.getState().plane;
  if (s.tool === "perspSelect") {
    const n = hit(p);
    if (!n || n.locked) {
      s.set({ selection: [] });
      return "done";
    }
    s.set({ selection: [n.id] });
    if (!g) return "done";
    if (n.type === "VECTOR" && n.persp) {
      // a text's outline paths move together
      const key = n.persp.key;
      const parts = key ? (currentPage()?.nodes ?? []).filter((x): x is VectorNode => x.type === "VECTOR" && x.persp?.key === key) : [n];
      drag = {
        kind: "move", ids: parts.map((x) => x.id), plane: n.persp.plane, start: p, moved: false,
        flat0: new Map(parts.map((x) => [x.id, x.persp!.flat as Contour[]])), d0: new Map(parts.map((x) => [x.id, (x.persp!.d ?? [0, 0]) as Vec2])),
      };
      return "drag";
    }
    if (plane === "none" || (n.type !== "VECTOR" && n.type !== "TEXT")) return "done";
    drag = { kind: "attach", id: n.id, plane, start: p, cur: p };
    return "drag";
  }
  if (!g) return false;
  if (s.tool === "perspGrid") {
    const tol = 8 / s.view.zoom;
    const h = handles(g).find((x) => Math.hypot(x.at[0] - p[0], x.at[1] - p[1]) <= tol);
    if (h) drag = { kind: "handle", h: h.h, moved: false };
    else if (Math.abs(p[1] - g.horizon) <= tol) drag = { kind: "handle", h: "horizon", moved: false };
    else return false;
    return "drag";
  }
  if (PLANE_SHAPES.has(s.tool) && plane !== "none") {
    drag = { kind: "draw", plane, shape: s.tool as PlaneShape, a: p, b: p };
    return "drag";
  }
  return false;
}

export function perspMove(p: Vec2, shift: boolean): void {
  const d = drag;
  const page = currentPage();
  const g = gridOf(page);
  if (!d || !g || !page) return;
  const s = S();
  switch (d.kind) {
    case "draw": {
      d.b = p;
      if (shift && d.shape !== "line") {
        // a square in the plane (Shift, as for a flat rectangle)
        const a = pageToFlat(g, d.plane, d.a), b = pageToFlat(g, d.plane, p);
        const k = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
        d.b = flatToPage(g, d.plane, [a[0] + Math.sign(b[0] - a[0] || 1) * k, a[1] + Math.sign(b[1] - a[1] || 1) * k]);
      }
      return;
    }
    case "attach":
      d.cur = p;
      return;
    case "handle":
      if (!d.moved) {
        d.moved = true;
        s.beginGesture();
      }
      s.updateGesture((doc) => {
        const pg = draftPage(doc, page.id);
        if (!pg) return;
        pg.perspGrid = { ...movedGrid(g, d.h, p), shown: true } as never;
        reproject(pg as Page, pg.perspGrid as PerspGrid);
      });
      return;
    case "move": {
      if (!d.moved) {
        if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) * s.view.zoom < 3) return;
        d.moved = true;
        s.beginGesture();
      }
      const a = pageToFlat(g, d.plane, d.start), b = pageToFlat(g, d.plane, p);
      const dx = b[0] - a[0], dy = b[1] - a[1];
      s.updateGesture((doc) => {
        for (const n of draftPage(doc, page.id)?.nodes ?? []) {
          if (n.type !== "VECTOR" || !n.persp || !d.ids.includes(n.id)) continue;
          const flat = shiftContours(d.flat0.get(n.id)!, dx, dy);
          n.persp.flat = flat as never;
          if (n.persp.d) {
            const d0 = d.d0.get(n.id)!;
            n.persp.d = [d0[0] + dx, d0[1] + dy];
          }
          n.contours = projectContours(g, d.plane, flat) as never;
        }
      });
      return;
    }
  }
}

export function perspUp(): boolean {
  const d = drag;
  drag = null;
  const g = currentGrid();
  if (!d || !g) return !!d;
  const s = S();
  switch (d.kind) {
    case "draw":
      return drawOnPlane(g, d.plane, d.shape, d.a, d.b);
    case "handle":
      if (d.moved) s.endGesture(t("design.persp.hist.edit"));
      return true;
    case "move":
      if (d.moved) s.endGesture(t("design.persp.hist.move"));
      return true;
    case "attach":
      if (Math.hypot(d.cur[0] - d.start[0], d.cur[1] - d.start[1]) * s.view.zoom >= 3) void attachToPlane([d.id], d.plane, d.start, d.cur);
      return true;
  }
}
export function perspCancel(): void {
  if ((drag?.kind === "handle" || drag?.kind === "move") && drag.moved) S().cancelGesture();
  drag = null;
}

const shiftContours = (cs: Contour[], dx: number, dy: number): Contour[] =>
  cs.map((c) => ({
    closed: c.closed,
    nodes: c.nodes.map((a) => ({ ...a, anchor: [a.anchor[0] + dx, a.anchor[1] + dy] as Vec2, handleIn: [a.handleIn[0] + dx, a.handleIn[1] + dy] as Vec2, handleOut: [a.handleOut[0] + dx, a.handleOut[1] + dy] as Vec2 })),
  }));

const corner = (p: Vec2): VectorAnchor => ({ anchor: p, handleIn: p, handleOut: p, isCorner: true });
const offsetContour = (c: Contour, dx: number, dy: number) => shiftContours([c], dx, dy)[0];

/** A shape from page points a to b drawn on a plane of the grid (laid out flat on the plane, then projected). */
export function drawOnPlane(g: PerspGrid, plane: PerspPlane, shape: PlaneShape, a: Vec2, b: Vec2): boolean {
  const fa = pageToFlat(g, plane, a), fb = pageToFlat(g, plane, b);
  if (![...fa, ...fb].every(Number.isFinite)) return false;
  if (Math.hypot(a[0] - b[0], a[1] - b[1]) * S().view.zoom < 3) return false;
  const x = Math.min(fa[0], fb[0]), y = Math.min(fa[1], fb[1]), w = Math.abs(fb[0] - fa[0]), h = Math.abs(fb[1] - fa[1]);
  const sp = useShapeParams.getState();
  let flat: Contour;
  switch (shape) {
    case "line":
      flat = { closed: false, nodes: [corner(fa), corner(fb)] };
      break;
    case "ellipse":
      flat = ellipseContour(x + w / 2, y + h / 2, w / 2, h / 2);
      break;
    case "roundRect":
      flat = offsetContour(roundRectContour(w, h, Math.min(sp.radius, w / 2, h / 2)), x, y);
      break;
    case "polygon":
    case "star": {
      const R = Math.max(w, h) / 2;
      flat = offsetContour(polygonContour(R, Math.max(3, shape === "star" ? sp.points : sp.sides), shape === "star", sp.inner), x + w / 2 - R, y + h / 2 - R);
      break;
    }
    default:
      flat = { closed: true, nodes: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map((q) => corner(q as Vec2)) };
  }
  const s = S();
  const kind: ShapeKind = shape === "line" ? "rect" : shape;
  const v = drawnShape(kind, { x: 0, y: 0, w: 1, h: 1 }, { fill: s.fill, stroke: s.stroke });
  if (shape === "line") {
    v.fill = null;
    v.stroke = s.stroke;
  }
  delete v.cornerRadius;
  v.contours = projectContours(g, plane, [flat]);
  v.persp = { plane, flat: [flat] };
  v.name = t("design.persp.shapeName", { name: shape === "line" ? t("design.persp.line") : v.name });
  s.commit(t("design.persp.hist.draw"), (d) => void draftPage(d, s.pageId)?.nodes.push(v as never));
  s.set({ selection: [v.id] });
  return true;
}

/** Page-space outline of a path (its transform applied). */
const pageContoursOf = (n: VectorNode): Contour[] =>
  n.contours.map((c) => ({
    closed: c.closed,
    nodes: c.nodes.map((a) => ({ ...a, anchor: applyTransform(n.transform, a.anchor) as Vec2, handleIn: applyTransform(n.transform, a.handleIn) as Vec2, handleOut: applyTransform(n.transform, a.handleOut) as Vec2 })),
  }));

/**
 * The Perspective Selection tool's drop: the objects onto `plane`, the grabbed point (`from`, page) landing where it
 * was dropped (`to`); they keep their size in plane px. Text goes as its outlines (Illustrator keeps it live; here it
 * becomes paths on the plane). Resolves to the number of paths put on the plane.
 */
export async function attachToPlane(ids: string[], plane: PerspPlane, from: Vec2, to: Vec2): Promise<number> {
  const page = currentPage();
  const g = gridOf(page);
  if (!page || !g) return 0;
  const sel = page.nodes.filter((n) => ids.includes(n.id) && !n.locked && (n.type === "VECTOR" || n.type === "TEXT"));
  if (!sel.length) return 0;
  const drop = pageToFlat(g, plane, to);
  const toFlat = (cs: Contour[]) => shiftContours(cs, drop[0] - from[0], drop[1] - from[1]);
  const made = new Map<string, VectorNode[]>();
  for (const n of sel) {
    if (n.type === "VECTOR") {
      const flat = toFlat(pageContoursOf(n));
      const k = Math.abs(n.transform.scale) || 1;
      made.set(n.id, [{ ...n, transform: { ...IDENTITY }, strokeWidth: n.strokeWidth * k, persp: { plane, flat }, contours: projectContours(g, plane, flat) }]);
    } else {
      made.set(n.id, await textParts(g, plane, n as TextNode, [drop[0] - from[0], drop[1] - from[1]]));
    }
  }
  let count = 0;
  const out: string[] = [];
  S().commit(t("design.persp.hist.attach"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const next: SceneNode[] = [];
    for (const n of pg.nodes as SceneNode[]) {
      const m = made.get(n.id);
      if (!m) next.push(n);
      else {
        next.push(...m.map((v) => ({ ...v, groupId: n.groupId }) as VectorNode));
        out.push(...m.map((v) => v.id));
        count += m.length;
      }
    }
    pg.nodes = next as never;
  });
  S().set({ selection: out });
  return count;
}

/** A text's outlines on a plane: paths in perspective that keep the text (flat, `d` = plane px − page px) to edit. */
async function textParts(g: PerspGrid, plane: PerspPlane, text: TextNode, d: Vec2): Promise<VectorNode[]> {
  const { vectors } = await outlinesOf(text);
  const snap = JSON.parse(JSON.stringify(text)) as TextNode;
  return vectors.map((v) => {
    const flat = shiftContours(pageContoursOf(v), d[0], d[1]);
    return { ...v, name: text.name, transform: { ...IDENTITY }, persp: { plane, flat, text: snap, key: text.id, d }, contours: projectContours(g, plane, flat) };
  });
}

/** Texts taken off their plane to edit (Illustrator's isolation): text id → its plane and offset. */
const editingFlat = new Map<string, { plane: PerspPlane; d: Vec2 }>();

/**
 * A double-click on a text on a plane: its outline paths give way to the text itself, flat, and the text editor
 * opens on it (`edit`). When the editing ends the text goes back onto the plane (outlines in perspective again).
 */
export function editPerspText(part: VectorNode, edit: (n: TextNode) => void): boolean {
  const page = currentPage();
  const at = part.persp;
  if (!page || !at?.text || !at.key) return false;
  const key = at.key;
  const text = JSON.parse(JSON.stringify(at.text)) as TextNode;
  S().commit(t("design.persp.hist.editText"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const i = pg.nodes.findIndex((x) => x.type === "VECTOR" && x.persp?.key === key);
    pg.nodes = pg.nodes.filter((x) => !(x.type === "VECTOR" && x.persp?.key === key)) as never;
    pg.nodes.splice(Math.max(0, i), 0, { ...text, groupId: part.groupId } as never);
  });
  editingFlat.set(text.id, { plane: at.plane, d: (at.d ?? [0, 0]) as Vec2 });
  const n = currentPage()?.nodes.find((x) => x.id === text.id);
  if (n?.type === "TEXT") edit(n);
  return true;
}

/** The edited text back onto its plane (its new outlines in perspective); an emptied text goes. */
export async function returnTextToPlane(id: string): Promise<boolean> {
  const info = editingFlat.get(id);
  editingFlat.delete(id);
  const page = currentPage();
  const n = page?.nodes.find((x) => x.id === id);
  const g = page?.perspGrid;
  if (!info || !page || !g || n?.type !== "TEXT") return false;
  const parts = await textParts(g, info.plane, n, info.d);
  S().commit(t("design.persp.hist.attach"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const i = pg.nodes.findIndex((x) => x.id === id);
    if (i < 0) return;
    pg.nodes.splice(i, 1, ...(parts.map((v) => ({ ...v, groupId: n.groupId })) as never[]));
  });
  S().set({ selection: parts.map((v) => v.id) });
  return true;
}

// a text taken off its plane goes back when its editing ends
useStore.subscribe((s, prev) => {
  const was = prev.editingTextId;
  if (was && was !== s.editingTextId && editingFlat.has(was)) queueMicrotask(() => void returnTextToPlane(was));
});

/** Keys while the grid shows: 1 left, 2 floor, 3 right, 4 none (Illustrator's plane switching). */
export function perspKey(e: KeyboardEvent): boolean {
  if (!currentGrid() || e.ctrlKey || e.metaKey || e.altKey) return false;
  const s = S();
  if (s.tool !== "perspGrid" && s.tool !== "perspSelect" && !PLANE_SHAPES.has(s.tool)) return false;
  const map: Record<string, ActivePlane> = { "1": "left", "2": "floor", "3": "right", "4": "none" };
  const pl = map[e.key];
  if (!pl) return false;
  setPlane(pl);
  return true;
}

/** The grid on the overlay: each plane's lines in its colour (the active one stronger), the handles, previews. */
export function perspDraw(o: CanvasRenderingContext2D, toScreen: (p: Vec2) => Vec2, hair: number): void {
  const g = currentGrid();
  const plane = usePersp.getState().plane;
  if (!g) return;
  o.save();
  const planes: PerspPlane[] = ["floor", "left", "right"];
  for (const pl of planes) {
    o.strokeStyle = PLANE_COLOR[pl];
    o.globalAlpha = pl === plane ? 0.85 : 0.35;
    o.lineWidth = hair;
    o.beginPath();
    for (const [a, b] of planeLines(g, pl)) {
      const p = toScreen(a), q = toScreen(b);
      o.moveTo(p[0], p[1]);
      o.lineTo(q[0], q[1]);
    }
    o.stroke();
    if (pl === plane) {
      o.globalAlpha = 0.08;
      o.fillStyle = PLANE_COLOR[pl];
      o.beginPath();
      planeQuad(g, pl).forEach((c, i) => {
        const p = toScreen(c);
        if (i) o.lineTo(p[0], p[1]);
        else o.moveTo(p[0], p[1]);
      });
      o.closePath();
      o.fill();
    }
  }
  o.globalAlpha = 0.7;
  o.strokeStyle = "#7a7a7a";
  o.setLineDash([6, 4]);
  o.beginPath();
  const h0 = toScreen([Math.min(g.vp1, g.ox) - 2000, g.horizon]), h1 = toScreen([Math.max(g.vp2, g.ox2) + 2000, g.horizon]);
  o.moveTo(h0[0], h0[1]);
  o.lineTo(h1[0], h1[1]);
  o.stroke();
  o.setLineDash([]);
  o.globalAlpha = 1;
  if (S().tool === "perspGrid")
    for (const x of handles(g)) {
      const p = toScreen(x.at);
      o.fillStyle = "#ffffff";
      o.strokeStyle = "#333";
      o.beginPath();
      o.arc(p[0], p[1], 5, 0, Math.PI * 2);
      o.fill();
      o.stroke();
    }
  const outline = (cs: Contour[], color: string) => {
    o.strokeStyle = color;
    o.lineWidth = hair * 1.5;
    o.beginPath();
    for (const c of cs) {
      const seg = (a: VectorAnchor, b: VectorAnchor) => {
        const c1 = toScreen(a.handleOut), c2 = toScreen(b.handleIn), p = toScreen(b.anchor);
        o.bezierCurveTo(c1[0], c1[1], c2[0], c2[1], p[0], p[1]);
      };
      if (!c.nodes.length) continue;
      const p0 = toScreen(c.nodes[0].anchor);
      o.moveTo(p0[0], p0[1]);
      for (let i = 1; i < c.nodes.length; i++) seg(c.nodes[i - 1], c.nodes[i]);
      if (c.closed && c.nodes.length > 1) seg(c.nodes[c.nodes.length - 1], c.nodes[0]);
    }
    o.stroke();
  };
  if (drag?.kind === "draw") {
    const fa = pageToFlat(g, drag.plane, drag.a), fb = pageToFlat(g, drag.plane, drag.b);
    const box: Contour = { closed: true, nodes: [[fa[0], fa[1]], [fb[0], fa[1]], [fb[0], fb[1]], [fa[0], fb[1]]].map((q) => corner(q as Vec2)) };
    outline(projectContours(g, drag.plane, [box]), PLANE_COLOR[drag.plane]);
  }
  if (drag?.kind === "attach") {
    const d = drag;
    const n = currentPage()?.nodes.find((x) => x.id === d.id);
    if (n?.type === "VECTOR") {
      const drop = pageToFlat(g, d.plane, d.cur);
      outline(projectContours(g, d.plane, shiftContours(pageContoursOf(n), drop[0] - d.start[0], drop[1] - d.start[1])), PLANE_COLOR[d.plane]);
    }
  }
  o.restore();
}

/** Which plane a page point is on (for the status line / tests). */
export const planeUnder = (p: Vec2) => {
  const g = currentGrid();
  return g ? planeAt(g, p) : null;
};
