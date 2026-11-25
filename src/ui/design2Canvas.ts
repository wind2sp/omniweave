// Canvas side of the design mode's second set of tools (Illustrator, design 2, 2026-11-24): the shear tool, the flare
// tool, the shape builder (Shift+M), the blend tool (W), live-corner widgets on a selected path (selection and direct
// selection tools), the eyedropper on objects (I), and Enter for the rotate / reflect / scale / shear dialogs.
// CanvasView hands presses, moves, releases, keys and the overlay to these functions (kind "d2" drags).

import { applyTransform } from "../core/geom";
import { currentPage, draftPage, useStore, type Tool } from "../core/store";
import { newGroup, newVector, type SceneNode, type TextNode, type Vec2, type VectorNode } from "../core/types";
import { ellipseContour } from "../core/vector";
import { cornerAt, maxCornerRadius, roundableCorners } from "../core/liveVector";
import { selectedAnchors } from "./pathTools";
import type { Paint } from "../core/style/types";
import { selectionCentre, transformSelection, xformGesture, type XformValues } from "./designPathOps";
import { openDesignXform } from "./shell/DesignXformDialog";
import { buildShapes, regionAt, regions } from "./shapeBuilder";
import { makeBlend, setPatternTile, usePatternEdit } from "./designArt";
import { drawPencil, knifeCut, scissorsAt } from "./designCut";
import { smoothAlong, wandAt } from "./designMore";
import { meshCancel, meshDown, meshDraw, meshMove, meshUp } from "./designMesh";
import { editPerspText, perspCancel, perspDown, perspDraw, perspKey, perspMove, perspUp } from "./designPersp";
import { eyedropFrom } from "./designLive";
import { useDesign } from "./designTools";
import { currentEditMode } from "./editModes";
import { t } from "../i18n";

const S = () => useStore.getState();
const ACCENT = "#2b74ec";

export interface D2Env {
  toScreen: (p: Vec2) => Vec2;
  hit: (p: Vec2) => SceneNode | undefined;
  invalidate: () => void;
  hair: () => number;
  /** the rotate / reflect / scale tools' reference point (CanvasView keeps it) */
  xfOrigin: () => Vec2 | null;
  /** open the text editor on a text node (a text on a perspective plane, double-clicked) */
  editText?: (n: TextNode) => void;
}

type D2Drag =
  | { kind: "shear"; o: Vec2; start: Vec2; moved: boolean; ids: string[]; v?: XformValues }
  | { kind: "flare"; c: Vec2; cur: Vec2 }
  | { kind: "builder"; picked: number[]; pts: Vec2[]; erase: boolean }
  | { kind: "tile"; edge: "r" | "b" | "rb" }
  | { kind: "track"; tool: "pencil" | "knife" | "smoothTool"; pts: Vec2[] }
  | { kind: "mesh" }
  | { kind: "persp" }
  | { kind: "corner"; id: string; corner: Vec2; bis: Vec2; sinHalf: number; scale: number; max: number; only: [number, number][] | null };

let drag: D2Drag | null = null;
let hoverRegion = -1;
let shearRef: { key: string; p: Vec2 } | null = null;
let blendFirst: string | null = null;

const design = () => currentEditMode() === "DESIGN";
export const D2_TOOLS: readonly Tool[] = ["shearTool", "flare", "shapeBuilder", "blendTool", "pencil", "scissors", "knife", "objWand", "smoothTool", "meshTool", "perspGrid", "perspSelect"];

function shearOrigin(): Vec2 | null {
  const key = S().selection.join(",");
  return shearRef?.key === key ? shearRef.p : selectionCentre();
}

// ───────── live corner widgets ─────────

interface Widget {
  at: Vec2;
  corner: Vec2;
  bis: Vec2;
  sinHalf: number;
  /** contour and anchor index of the corner */
  ci: number;
  i: number;
}

/** The corner widgets of the one selected path (page space), or none. */
function widgets(zoom: number): { node: VectorNode; list: Widget[] } | null {
  const s = S();
  if (!design() || (s.tool !== "select" && s.tool !== "direct") || s.selection.length !== 1 || s.gestureBase) return null;
  const page = currentPage();
  const n = page?.nodes.find((x) => x.id === s.selection[0]);
  if (!n || n.type !== "VECTOR" || n.locked) return null;
  const k = Math.abs(n.transform.scale) || 1;
  // with the direct selection tool and points of this path selected, only their corners (Illustrator)
  const picked = s.tool === "direct" ? selectedAnchors(page).filter((x) => x.id === n.id) : [];
  const list: Widget[] = [];
  n.contours.forEach((c, ci) => {
    for (const i of roundableCorners(c)) {
      if (picked.length && !picked.some((x) => x.ci === ci && x.ni === i)) continue;
      const g = cornerAt(c, i)!;
      const a = applyTransform(n.transform, c.nodes[i].anchor);
      // the sides' directions on the page (the corner's own tangents, so curved sides too)
      const dir = (d: Vec2) => {
        const q = applyTransform(n.transform, [c.nodes[i].anchor[0] + d[0], c.nodes[i].anchor[1] + d[1]]);
        return norm([q[0] - a[0], q[1] - a[1]]);
      };
      const u = dir(g.u), v = dir(g.v);
      const b = norm([u[0] + v[0], u[1] + v[1]]);
      const phi = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
      const sinHalf = Math.sin(phi / 2) || 1;
      const r = (n.cornerRadii?.[ci]?.[i] ?? n.cornerRadius ?? 0) * k;
      const D = Math.max(r / sinHalf, 16 / zoom);
      list.push({ at: [a[0] + b[0] * D, a[1] + b[1] * D], corner: a, bis: b, sinHalf, ci, i });
    }
  });
  if (list.length > 80) return null;
  return list.length ? { node: n, list } : null;
}
const norm = (v: Vec2): Vec2 => {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
};

// ───────── presses ─────────

/** A press on the canvas: "drag" (CanvasView then sends the moves and the release), "done", or false (not ours). */
export function d2Down(e: { altKey: boolean; shiftKey: boolean; detail: number }, p: Vec2, env: D2Env): "drag" | "done" | false {
  const s = S();
  const page = currentPage();
  if (!page || !design()) return false;
  const zoom = s.view.zoom;
  // pattern editing: the tile box's right / bottom edge or corner sizes the tile (Illustrator's Pattern Tile tool)
  const pe = usePatternEdit.getState().edit;
  if (pe && pe.pageId === page.id) {
    const tol = 6 / zoom, r = pe.ox + pe.w, b = pe.oy + pe.h;
    const onR = Math.abs(p[0] - r) < tol && p[1] > pe.oy - tol && p[1] < b + tol, onB = Math.abs(p[1] - b) < tol && p[0] > pe.ox - tol && p[0] < r + tol;
    if (onR || onB) {
      drag = { kind: "tile", edge: onR && onB ? "rb" : onR ? "r" : "b" };
      return "drag";
    }
  }
  // a double-click on a text on a perspective plane: the text itself, flat, to edit (Illustrator)
  if (e.detail >= 2 && env.editText && (s.tool === "select" || s.tool === "direct" || s.tool === "perspSelect")) {
    const h = env.hit(p);
    if (h?.type === "VECTOR" && h.persp?.text && editPerspText(h, env.editText)) return "done";
  }
  // the Mesh tool (U); the perspective grid's handles, and shapes drawn on its active plane
  if (s.tool === "meshTool") {
    const r = meshDown(e, p, env);
    if (r === "drag") drag = { kind: "mesh" };
    return r;
  }
  const pr = perspDown(p, env.hit);
  if (pr === "drag") {
    drag = { kind: "persp" };
    return "drag";
  }
  if (pr === "done") {
    env.invalidate();
    return "done";
  }
  if (s.tool === "perspGrid" || s.tool === "perspSelect") return "done";
  // a corner widget wins over the selection's handles
  if (s.tool === "select" || s.tool === "direct") {
    const w = widgets(zoom);
    const hit = w?.list.find((x) => Math.hypot(x.at[0] - p[0], x.at[1] - p[1]) * zoom <= 6);
    if (w && hit) {
      s.beginGesture();
      // the direct selection tool with points picked: those corners alone (their own radii); else every corner
      const only = s.tool === "direct" && selectedAnchors(page).some((x) => x.id === w.node.id) ? w.list.map((x): [number, number] => [x.ci, x.i]) : null;
      drag = { kind: "corner", id: w.node.id, corner: hit.corner, bis: hit.bis, sinHalf: hit.sinHalf, scale: Math.abs(w.node.transform.scale) || 1, max: maxCornerRadius(w.node.contours), only };
      return "drag";
    }
    return false;
  }
  switch (s.tool) {
    case "eyedropper": {
      const focus = useDesign.getState().focus;
      if (!eyedropFrom(env.hit(p), e.shiftKey ? focus : null)) return false;
      env.invalidate();
      return "done";
    }
    case "shearTool": {
      if (!s.selection.length) {
        const h = env.hit(p);
        if (h && !h.locked) s.set({ selection: [h.id] });
        return "done";
      }
      const o = shearOrigin();
      if (!o) return "done";
      drag = { kind: "shear", o, start: p, moved: false, ids: [...s.selection] };
      return "drag";
    }
    case "flare":
      drag = { kind: "flare", c: p, cur: p };
      return "drag";
    case "pencil":
    case "knife":
    case "smoothTool":
      drag = { kind: "track", tool: s.tool, pts: [p] };
      return "drag";
    case "objWand": {
      const h = env.hit(p);
      wandAt(h?.type === "VECTOR" ? h : undefined, e.shiftKey);
      env.invalidate();
      return "done";
    }
    case "scissors":
      if (!scissorsAt(p, 6 / zoom)) s.notify(t("design.msg.clickPath"));
      env.invalidate();
      return "done";
    case "shapeBuilder": {
      if (regions().length < 1) {
        s.notify(t("design.sb.msg.select"));
        return "done";
      }
      const i = regionAt(p);
      drag = { kind: "builder", picked: i >= 0 ? [i] : [], pts: [p], erase: e.altKey };
      env.invalidate();
      return "drag";
    }
    case "blendTool": {
      const h = env.hit(p);
      if (!h || h.type !== "VECTOR") {
        blendFirst = null;
        s.notify(t("design.art.msg.blendTool"));
        return "done";
      }
      if (!blendFirst || blendFirst === h.id) {
        blendFirst = h.id;
        s.set({ selection: [h.id] });
        s.notify(t("design.art.msg.blendNext"));
      } else {
        s.set({ selection: [blendFirst, h.id] });
        blendFirst = null;
        makeBlend();
      }
      env.invalidate();
      return "done";
    }
  }
  return false;
}

export function d2Move(e: { shiftKey: boolean; altKey: boolean }, p: Vec2, env: D2Env): void {
  const d = drag;
  if (!d) return;
  const s = S();
  switch (d.kind) {
    case "tile": {
      const pe = usePatternEdit.getState().edit;
      if (!pe) break;
      const snap = (v: number) => Math.max(1, Math.round(v));
      setPatternTile({ ...(d.edge !== "b" ? { w: snap(p[0] - pe.ox) } : {}), ...(d.edge !== "r" ? { h: snap(p[1] - pe.oy) } : {}) });
      break;
    }
    case "corner": {
      const D = (p[0] - d.corner[0]) * d.bis[0] + (p[1] - d.corner[1]) * d.bis[1];
      const r = Math.max(0, Math.min(d.max, (D * d.sinHalf) / d.scale));
      const page = currentPage();
      if (!page) break;
      s.updateGesture((doc) => {
        const n = draftPage(doc, page.id)?.nodes.find((x) => x.id === d.id);
        if (n?.type !== "VECTOR") return;
        const v = r * d.scale * s.view.zoom < 1 ? 0 : Math.round(r * 100) / 100;
        if (d.only) {
          const radii = n.contours.map((c, ci) => c.nodes.map((_, i) => n.cornerRadii?.[ci]?.[i] ?? null));
          for (const [ci, i] of d.only) radii[ci][i] = v;
          n.cornerRadii = radii;
        } else {
          delete n.cornerRadii;
          if (v) n.cornerRadius = v;
          else delete n.cornerRadius;
        }
      });
      break;
    }
    case "shear": {
      if (!d.moved) {
        if (Math.hypot(p[0] - d.start[0], p[1] - d.start[1]) * s.view.zoom < 3) break;
        d.moved = true;
        s.beginGesture();
      }
      d.v = shearValues(d.o, d.start, p, e.shiftKey);
      xformGesture(d.ids, "shear", d.v, d.o);
      break;
    }
    case "flare":
      d.cur = p;
      break;
    case "mesh":
      meshMove(p);
      break;
    case "persp":
      perspMove(p, e.shiftKey);
      break;
    case "track":
      d.pts.push(p);
      break;
    case "builder": {
      d.pts.push(p);
      const i = regionAt(p);
      if (i >= 0 && !d.picked.includes(i)) d.picked.push(i);
      d.erase ||= e.altKey;
      break;
    }
  }
  env.invalidate();
}

export function d2Up(e: { altKey: boolean }, p: Vec2, env: D2Env): void {
  const d = drag;
  drag = null;
  if (!d) return;
  const s = S();
  switch (d.kind) {
    case "corner":
      s.endGesture(t("design.corner.hist"));
      break;
    case "shear":
      if (!d.moved) {
        // a click: the reference point; Alt+click: the Shear dialog about it
        if (e.altKey) openDesignXform("shear", [d.start[0], d.start[1]]);
        else shearRef = { key: s.selection.join(","), p: d.start };
        break;
      }
      if (e.altKey && d.v) {
        s.cancelGesture();
        transformSelection("shear", { ...d.v, origin: d.o }, true);
      } else s.endGesture(t("design.xf.hist.shear"));
      shearRef = { key: S().selection.join(","), p: d.o };
      break;
    case "track":
      if (d.tool === "pencil") drawPencil(d.pts, s.view.zoom);
      else if (d.tool === "smoothTool") smoothAlong(d.pts, s.view.zoom);
      else if (!knifeCut(d.pts)) s.notify(t("design.msg.knifeMissed"));
      break;
    case "mesh":
      meshUp();
      break;
    case "persp":
      perspUp();
      break;
    case "flare":
      makeFlare(d.c, Math.hypot(p[0] - d.c[0], p[1] - d.c[1]) * s.view.zoom < 3 ? [d.c[0] + 160, d.c[1] + 90] : p);
      break;
    case "builder":
      if (!d.picked.length) break;
      buildShapes(d.picked, d.erase || e.altKey);
      hoverRegion = -1;
      break;
  }
  env.invalidate();
}

/** The shear values of a drag from `start` to `p` about `o`: the larger move picks the axis; Shift keeps it horizontal. */
function shearValues(o: Vec2, start: Vec2, p: Vec2, shift: boolean): XformValues {
  const dx = p[0] - start[0], dy = p[1] - start[1];
  const vertical = !shift && Math.abs(dy) > Math.abs(dx);
  const lever = vertical ? start[0] - o[0] : start[1] - o[1];
  if (Math.abs(lever) < 1) return { angle: 0, axis: vertical ? 90 : 0 };
  const a = (Math.atan(Math.abs(vertical ? dy : dx) / Math.abs(lever)) * 180) / Math.PI;
  // the sign that takes the pressed point along with the pointer (designPathOps' shear map)
  const v: XformValues = { angle: a, axis: vertical ? 90 : 0 };
  const q = shearMap(o, v, start);
  const moved = vertical ? q[1] - start[1] : q[0] - start[0];
  return Math.sign(moved) === Math.sign(vertical ? dy : dx) ? v : { ...v, angle: -a };
}

/** designPathOps' shear of one point (for the drag's sign). */
function shearMap([cx, cy]: Vec2, v: XformValues, p: Vec2): Vec2 {
  const x = p[0] - cx, y = p[1] - cy;
  const b = (-(v.axis ?? 0) * Math.PI) / 180, k = Math.tan(((v.angle ?? 0) * Math.PI) / 180);
  const u = x * Math.cos(b) + y * Math.sin(b), w = -x * Math.sin(b) + y * Math.cos(b);
  const u2 = u - w * k;
  return [cx + u2 * Math.cos(b) - w * Math.sin(b), cy + u2 * Math.sin(b) + w * Math.cos(b)];
}

/** The pointer moving with no button: the shape builder's region under it lights up. */
export function d2Hover(p: Vec2): boolean {
  if (S().tool !== "shapeBuilder" || !design()) return false;
  const i = regions().length ? regionAt(p) : -1;
  if (i === hoverRegion) return false;
  hoverRegion = i;
  return true;
}

/** Keys: Enter opens the rotate / reflect / scale / shear tool's dialog (Illustrator); true when used. */
export function d2Key(e: KeyboardEvent, env: D2Env): boolean {
  const s = S();
  if (design() && !drag && perspKey(e)) {
    env.invalidate();
    return true;
  }
  if (!design() || e.key !== "Enter" || e.ctrlKey || e.metaKey || e.altKey || !s.selection.length || drag) return false;
  const kinds: Partial<Record<Tool, "rotate" | "reflect" | "scale" | "shear">> = { rotateTool: "rotate", reflectTool: "reflect", scaleTool: "scale", shearTool: "shear" };
  const k = kinds[s.tool];
  if (!k) return false;
  const o = k === "shear" ? shearOrigin() : env.xfOrigin();
  openDesignXform(k, o ? [o[0], o[1]] : undefined);
  return true;
}

/** Leave any half-done gesture (tool switched, Esc). */
export function d2Cancel(): void {
  if (drag?.kind === "corner" || (drag?.kind === "shear" && drag.moved)) S().cancelGesture();
  if (drag?.kind === "mesh") meshCancel();
  if (drag?.kind === "persp") perspCancel();
  drag = null;
  blendFirst = null;
}

// ───────── overlay ─────────

export function d2Draw(o: CanvasRenderingContext2D, env: D2Env): void {
  const s = S();
  if (!design()) return;
  const hair = env.hair();
  perspDraw(o, env.toScreen, hair);
  meshDraw(o, env.toScreen, hair);
  const path = (pts: Vec2[], close = true) => {
    o.beginPath();
    pts.forEach((q, i) => {
      const a = env.toScreen(q);
      if (i) o.lineTo(a[0], a[1]);
      else o.moveTo(a[0], a[1]);
    });
    if (close) o.closePath();
  };
  // shape builder: the hovered region (grey mesh, Illustrator) and the regions a drag has crossed
  if (s.tool === "shapeBuilder") {
    const rs = regions();
    const shown = drag?.kind === "builder" ? drag.picked : hoverRegion >= 0 ? [hoverRegion] : [];
    const erase = drag?.kind === "builder" && drag.erase;
    for (const i of shown) {
      const r = rs[i];
      if (!r) continue;
      o.save();
      o.beginPath();
      for (const ring of r.poly)
        ring.forEach((q, j) => {
          const a = env.toScreen(q as Vec2);
          if (j) o.lineTo(a[0], a[1]);
          else o.moveTo(a[0], a[1]);
        });
      o.fillStyle = erase ? "rgba(220,60,60,.35)" : "rgba(110,110,110,.38)";
      o.fill("evenodd");
      o.strokeStyle = erase ? "#d33" : ACCENT;
      o.lineWidth = hair * 1.5;
      o.stroke();
      o.restore();
    }
    if (drag?.kind === "builder" && drag.pts.length > 1) {
      o.strokeStyle = erase ? "#d33" : ACCENT;
      o.lineWidth = hair;
      path(drag.pts, false);
      o.stroke();
    }
  }
  // pattern editing: the tile box (dashed) with its sizing corner
  const pe = usePatternEdit.getState().edit;
  if (pe && pe.pageId === s.pageId) {
    const a = env.toScreen([pe.ox, pe.oy]), b = env.toScreen([pe.ox + pe.w, pe.oy + pe.h]);
    o.save();
    o.strokeStyle = ACCENT;
    o.lineWidth = hair;
    o.setLineDash([5, 3]);
    o.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    o.setLineDash([]);
    o.fillStyle = "#fff";
    o.fillRect(b[0] - 4, b[1] - 4, 8, 8);
    o.strokeRect(b[0] - 4, b[1] - 4, 8, 8);
    o.restore();
  }
  // corner widgets
  const w = widgets(s.view.zoom);
  if (w)
    for (const x of w.list) {
      const a = env.toScreen(x.at);
      o.fillStyle = "#fff";
      o.strokeStyle = ACCENT;
      o.lineWidth = hair;
      o.beginPath();
      o.arc(a[0], a[1], 4, 0, Math.PI * 2);
      o.fill();
      o.stroke();
      o.beginPath();
      o.arc(a[0], a[1], 1.4, 0, Math.PI * 2);
      o.fillStyle = ACCENT;
      o.fill();
    }
  // the shear tool's reference point
  if (s.tool === "shearTool" && s.selection.length) {
    const c = drag?.kind === "shear" ? drag.o : shearOrigin();
    if (c) {
      const a = env.toScreen(c);
      o.strokeStyle = ACCENT;
      o.lineWidth = hair;
      o.beginPath();
      o.arc(a[0], a[1], 5, 0, Math.PI * 2);
      o.moveTo(a[0] - 10, a[1]);
      o.lineTo(a[0] + 10, a[1]);
      o.moveTo(a[0], a[1] - 10);
      o.lineTo(a[0], a[1] + 10);
      o.stroke();
    }
  }
  // the pencil / knife track being drawn
  if (drag?.kind === "track" && drag.pts.length > 1) {
    o.strokeStyle = drag.tool === "knife" ? "#d33" : ACCENT;
    o.lineWidth = hair;
    path(drag.pts, false);
    o.stroke();
  }
  // the flare being drawn: its halo and the line to its rings
  if (drag?.kind === "flare") {
    const c = env.toScreen(drag.c), e = env.toScreen(drag.cur);
    const R = flareRadius(drag.c, drag.cur) * s.view.zoom;
    o.strokeStyle = ACCENT;
    o.lineWidth = hair;
    o.beginPath();
    o.arc(c[0], c[1], R, 0, Math.PI * 2);
    o.moveTo(c[0], c[1]);
    o.lineTo(e[0], e[1]);
    o.stroke();
  }
}

// ───────── the flare ─────────

const flareRadius = (c: Vec2, e: Vec2) => Math.max(12, Math.min(120, Math.hypot(e[0] - c[0], e[1] - c[1]) * 0.25));

const white = (a: number) => ({ hex: "#ffffff", a });
function radial(stops: [number, number][]): Paint {
  return { type: "gradient", kind: "radial", from: [0.5, 0.5], to: [1, 0.5], stops: stops.map(([at, a]) => ({ at, color: white(a) })) } as Paint;
}
function disc(c: Vec2, r: number, name: string, paint: Paint, opacity = 1): VectorNode {
  const v = newVector([ellipseContour(c[0], c[1], r, r)], name);
  v.fill = "#ffffff";
  v.stroke = null;
  v.strokeWidth = 0;
  v.opacity = opacity;
  (v as VectorNode & { fills?: Paint[] }).fills = [paint];
  return v;
}

/** The flare tool: a centre with its halo and rays at c, rings along the line to e (one group, Illustrator's parts). */
export function makeFlare(c: Vec2, e: Vec2): void {
  const page = currentPage();
  if (!page) return;
  const R = flareRadius(c, e);
  const parts: VectorNode[] = [];
  parts.push(disc(c, R * 2.4, t("design.flare.glow"), radial([[0, 0.55], [0.35, 0.18], [1, 0]])));
  // rays: a thin many-pointed star
  const rays = 15, nodes = [];
  for (let i = 0; i < rays * 2; i++) {
    const a = (i * Math.PI) / rays + (i % 2 ? 0 : (((i * 7919) % 13) / 13 - 0.5) * 0.12);
    const rr = i % 2 ? R * 0.06 : R * (1.8 + (((i * 104729) % 17) / 17) * 1.4);
    nodes.push({ anchor: [c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)] as Vec2, handleIn: [c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)] as Vec2, handleOut: [c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)] as Vec2, isCorner: true });
  }
  const ray = newVector([{ closed: true, nodes }], t("design.flare.rays"));
  ray.fill = "#ffffff";
  ray.stroke = null;
  ray.strokeWidth = 0;
  (ray as VectorNode & { fills?: Paint[] }).fills = [radial([[0, 0.9], [1, 0]])];
  parts.push(ray);
  parts.push(disc(c, R, t("design.flare.halo"), radial([[0, 0], [0.72, 0.05], [0.9, 0.55], [1, 0]])));
  parts.push(disc(c, R * 0.4, t("design.flare.centre"), radial([[0, 1], [0.5, 0.8], [1, 0]])));
  // rings: along the line to the end point, of different sizes (Illustrator 10 rings by default; a few read the same)
  const ring = [[1, 0.55], [0.78, 0.25], [0.6, 0.4], [0.42, 0.18], [0.25, 0.3]];
  for (const [f, k] of ring) parts.push(disc([c[0] + (e[0] - c[0]) * f, c[1] + (e[1] - c[1]) * f], R * k, t("design.flare.ring"), radial([[0, 0.28], [0.85, 0.12], [1, 0]])));
  const g = newGroup(t("design.flare.name"));
  for (const v of parts) v.groupId = g.id;
  S().commit(t("design.flare.hist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    pg.groups = [...(pg.groups ?? []), g] as any;
    pg.nodes.push(...(parts as any));
  });
  S().set({ selection: parts.map((v) => v.id) });
}

/** For tests: the corner widgets as the canvas has them at `zoom`. */
export const cornerWidgets = (zoom: number) => widgets(zoom)?.list ?? [];
