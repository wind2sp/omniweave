// The pen family and direct selection on the canvas: pointer gestures, context cursors and the anchor / handle overlay
// (CanvasView hands its pointer events and overlay context here while one of ui/pathTools PATH_TOOLS is active).
//
// Illustrator behaviour, shared by the design mode, the image mode's pen group (Photoshop) and slides' 점 편집:
//   pen       over a selected path: segment → + add point · point → − delete · open end → / continue · first point of
//             the path being drawn → ○ close · elsewhere → new path (* cursor). Click = corner, drag = smooth point,
//             Alt while dragging = split handles, click the last point = retract its out handle.
//             Ctrl held = direct selection, Alt held = convert anchor point (both while held).
//   direct    click / Shift+click / marquee points; drag points, handles (smooth: the other handle turns, its length
//             kept · Alt: this one alone → corner), curved segments (bend) and straight ones (move); Shift = 45°.
//             Slides (PowerPoint 점 편집): Ctrl+click a line adds a point, Ctrl+click a point deletes it.
//   convert   click a point: smooth ↔ corner · drag a point: pull new symmetric handles · drag a handle: alone ·
//             drag a segment: bend it.
//   curvature click = smooth point through which the curve runs (Alt = corner), first point closes, Enter / Esc /
//             double-click end; on a selected path: drag a point, double-click it to convert, click a segment to add.

import { applyTransform, invertTransform, rectFromPoints } from "../core/geom";
import { currentPage, draftPage, useStore, type Tool } from "../core/store";
import type { Page, Vec2, VectorAnchor, VectorNode } from "../core/types";
import { autoSmooth, bendSegment, dragHandle, isStraight, moveAnchor, pullHandles, reverseContour, snap45 } from "../core/pathEdit";
import { pickableOn } from "../core/layerTree";
import { crisp, hairCss, snapSquare, snapStroke } from "../render/crisp";
import { snapOn, snapPt } from "./aids";
import { drawnPenPath } from "./drawDefaults";
import { currentEditMode } from "./editModes";
import { isolationFilter } from "./designTools";
import {
  addAnchor, akey, hl, anchorsInRect, commitPath, convertAnchor, deleteAnchor, parseKey, pathHitAt, setAnchors, shownHandles, shownPaths, useAnchors, type PathHit,
} from "./pathTools";

const S = () => useStore.getState();
// selection blue, the same as CanvasView's (VISUAL_DESIGN.md) — Illustrator's layer colour reads the same way
const ACCENT = "#2b74ec";

/** What CanvasView lends: view mapping, device pixel ratio, repaint. */
export interface PathEnv {
  zoom: number;
  dpr: number;
  toScreen: (p: Vec2) => Vec2;
  invalidate: () => void;
}

// ───────── the path being drawn (pen / curvature) ─────────

/**
 * Points of the path being drawn, page px; `cont` when it continues an open path's end. `steps` holds the points as
 * they were before each click (Illustrator: Ctrl+Z while drawing takes back the last point and its handles, one click
 * at a time; taking back the first one ends the drawing — the document history is not touched until the path is done).
 */
export const drawing: { pts: VectorAnchor[]; cont: { id: string; ci: number; atStart: boolean } | null; tool: Tool | null; steps: VectorAnchor[][] } = { pts: [], cont: null, tool: null, steps: [] };
export const isDrawing = () => drawing.pts.length > 0;

/** CanvasView's repaint, for changes to the drawn path that do not come from its own pointer events (Ctrl+Z). */
export const drawingHooks: { repaint: (() => void) | null } = { repaint: null };

export function cancelDrawing() {
  drawing.pts = [];
  drawing.cont = null;
  drawing.tool = null;
  drawing.steps = [];
}

const clone = (a: VectorAnchor): VectorAnchor => ({ anchor: [...a.anchor], handleIn: [...a.handleIn], handleOut: [...a.handleOut], isCorner: a.isCorner });

/** Remember the drawn points before a click changes them (one Ctrl+Z step). */
function drawStep() {
  drawing.steps.push(drawing.pts.map(clone));
}

/**
 * Ctrl+Z while a path is being drawn: the last click is taken back (its point and handles, or a retracted handle);
 * with nothing left the drawing ends without a path. False when no path is being drawn (the history undo runs).
 */
export function undoDrawnPoint(): boolean {
  if (!isDrawing()) return false;
  const prev = drawing.steps.pop();
  if (prev && prev.length) drawing.pts = prev;
  else cancelDrawing();
  drawingHooks.repaint?.();
  return true;
}

/** The drawn points with the curvature tool's automatic handles (and the pointer as the next point while hovering). */
function curvaturePts(extra?: Vec2): VectorAnchor[] {
  const pts = drawing.pts.map((a) => ({ ...a, handleIn: [...a.handleIn] as Vec2, handleOut: [...a.handleOut] as Vec2 }));
  if (extra) pts.push({ anchor: extra, handleIn: extra, handleOut: extra, isCorner: false });
  autoSmooth(pts, false);
  return pts;
}

/** A drag on the closing point (Illustrator): its handles follow the drag; `split` (Alt) bends the closing segment alone. */
export type CloseHandles = { delta: Vec2; split: boolean };

/** The closing point's handles after a drag of `delta` (page px) from it. */
function closeHandles(a: VectorAnchor, h: CloseHandles): VectorAnchor {
  const [x, y] = a.anchor, [dx, dy] = h.delta;
  if (h.split) return { ...a, handleIn: [x - dx, y - dy], isCorner: true };
  return { ...a, handleIn: [x - dx, y - dy], handleOut: [x + dx, y + dy], isCorner: false };
}

/** Enter / double-click / tool change: the drawn path becomes an object (or joins the path it continued). */
export function finishDrawing(close: boolean, handles?: CloseHandles | null) {
  const curv = drawing.tool === "curvature";
  const pts = curv ? curvaturePts() : drawing.pts.map(clone);
  const cont = drawing.cont;
  cancelDrawing();
  if (close && curv) autoSmooth(pts, true);
  const s = S();
  if (cont) {
    const n = currentPage()?.nodes.find((x) => x.id === cont.id);
    if (n?.type !== "VECTOR" || pts.length < 2 - (close ? 1 : 0)) return;
    const loc = (v: Vec2) => invertTransform(n.transform, v);
    commitPath(hl("shell.hist.penPath"), n.id, (d) => {
      const c = d.contours[cont.ci];
      if (!c) return;
      if (cont.atStart) reverseContour(c);
      const end = c.nodes[c.nodes.length - 1];
      end.handleOut = loc(pts[0].handleOut);
      if (!pts[0].isCorner) end.isCorner = false;
      for (const a of pts.slice(1)) c.nodes.push({ anchor: loc(a.anchor), handleIn: loc(a.handleIn), handleOut: loc(a.handleOut), isCorner: a.isCorner });
      if (close && c.nodes.length > 2) {
        c.closed = true;
        // the other end, dragged on as it closed: its handles in page px → the path's own space
        if (handles) {
          const f = c.nodes[0];
          const pg = (v: Vec2) => applyTransform(n.transform, v);
          const g = closeHandles({ anchor: pg(f.anchor), handleIn: pg(f.handleIn), handleOut: pg(f.handleOut), isCorner: f.isCorner }, handles);
          f.handleIn = loc(g.handleIn);
          f.handleOut = loc(g.handleOut);
          f.isCorner = g.isCorner;
        }
      }
    });
    s.set({ selection: [n.id] });
    setAnchors([akey({ id: n.id, ci: cont.ci, ni: n.contours[cont.ci].nodes.length - 1 + pts.length - 1 })]);
    return;
  }
  if (pts.length < 2) return;
  if (close && handles) pts[0] = closeHandles(pts[0], handles);
  const v = drawnPenPath(pts, close, s);
  s.commit(hl("shell.hist.penPath"), (d) => void draftPage(d, s.pageId)?.nodes.push(v as never));
  s.set({ selection: [v.id] });
  setAnchors([akey({ id: v.id, ci: 0, ni: close ? 0 : pts.length - 1 })]);
}

// ───────── modifiers held (pen: Ctrl = direct selection, Alt = convert) ─────────

export const mods = { ctrl: false, alt: false, shift: false };

/** The tool that acts now: the pen family's temporary switches while Ctrl / Alt are held (Illustrator). */
export function effectiveTool(tool: Tool = S().tool): Tool {
  if (tool === "direct" || !["pen", "curvature", "anchorAdd", "anchorDel", "anchorConvert"].includes(tool)) return tool;
  if (mods.ctrl) return "direct";
  if (!mods.alt || isDrawing()) return tool;
  // Alt: add ↔ delete anchor point swap; the pen becomes the convert tool; the curvature tool's Alt+click is a corner
  if (tool === "anchorAdd") return "anchorDel";
  if (tool === "anchorDel") return "anchorAdd";
  if (tool === "curvature") return tool;
  return "anchorConvert";
}

// ───────── cursors (Illustrator's pen nib with a sign; white arrow for direct selection) ─────────

const svgCur = (body: string, x: number, y: number, fb = "crosshair") =>
  `url("data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>${body}</svg>`)}") ${x} ${y}, ${fb}`;
const NIB = "<path d='M2 2l10 4 4 7-3 3-7-4z' fill='white' stroke='black' stroke-width='1.1' stroke-linejoin='round'/><path d='M2 2l6 6' stroke='black' stroke-width='1'/><circle cx='8.6' cy='8.6' r='1.3' fill='black'/>";
const sign = (d: string) => `<path d='${d}' stroke='white' stroke-width='3.2' stroke-linecap='round' fill='none'/><path d='${d}' stroke='black' stroke-width='1.3' stroke-linecap='round' fill='none'/>`;
export const CURSORS = {
  pen: svgCur(NIB, 2, 2),
  penNew: svgCur(NIB + sign("M17 17.5h5M19.5 15v5M17.7 15.7l3.6 3.6M21.3 15.7l-3.6 3.6"), 2, 2),
  penAdd: svgCur(NIB + sign("M16 19h6M19 16v6"), 2, 2),
  penDel: svgCur(NIB + sign("M16 19h6"), 2, 2),
  penCont: svgCur(NIB + sign("M16.5 21.5l5-6"), 2, 2),
  penClose: svgCur(NIB + "<circle cx='19' cy='19' r='2.6' fill='none' stroke='white' stroke-width='3'/><circle cx='19' cy='19' r='2.6' fill='none' stroke='black' stroke-width='1.2'/>", 2, 2),
  penConvert: svgCur(NIB + sign("M16 21l3-5 3 5"), 2, 2),
  convert: svgCur(sign("M4 20l8-15 8 15"), 12, 5),
  direct: svgCur("<path d='M3 2v16l4.2-4 2.8 6.4 2.4-1-2.8-6.3H16z' fill='white' stroke='black' stroke-width='1.1' stroke-linejoin='round'/>", 3, 2, "default"),
  directPoint: svgCur("<path d='M3 2v16l4.2-4 2.8 6.4 2.4-1-2.8-6.3H16z' fill='white' stroke='black' stroke-width='1.1' stroke-linejoin='round'/><rect x='15.5' y='15.5' width='5' height='5' fill='white' stroke='black' stroke-width='1.1'/>", 3, 2, "default"),
  curvature: svgCur(NIB + sign("M15 21c1.5-4 5.5-4 7 0"), 2, 2),
};

/** Paths a pointer may reach that are not shown yet (every pickable path, isolation respected). */
function pickablePaths(page: Page): VectorNode[] {
  const pick = pickableOn(page);
  const iso = isolationFilter();
  return page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && pick(n) && (!iso || iso(n)));
}

/** Pen: what a click would do at p (the cursor names it). */
type PenAction = { kind: "close" } | { kind: "retract" } | { kind: "continue"; hit: Extract<PathHit, { kind: "anchor" }> } | { kind: "add"; hit: Extract<PathHit, { kind: "segment" }> } | { kind: "delete"; hit: Extract<PathHit, { kind: "anchor" }> } | { kind: "new" } | { kind: "draw" };

function penAction(p: Vec2, env: PathEnv): PenAction {
  const page = currentPage();
  const near = (q: Vec2) => {
    const s = env.toScreen(q), r = env.toScreen(p);
    return Math.hypot(s[0] - r[0], s[1] - r[1]) < 8;
  };
  if (isDrawing()) {
    const pts = drawing.pts;
    if (pts.length > 1 && near(pts[0].anchor) && !drawing.cont) return { kind: "close" };
    if (drawing.cont && page) {
      // the other end of the path being continued closes it
      const n = page.nodes.find((x) => x.id === drawing.cont!.id);
      const c = n?.type === "VECTOR" ? n.contours[drawing.cont.ci] : undefined;
      if (n && c && c.nodes.length > 1) {
        const other = drawing.cont.atStart ? c.nodes[c.nodes.length - 1] : c.nodes[0];
        if (near(applyTransform(n.transform, other.anchor))) return { kind: "close" };
      }
    }
    if (near(pts[pts.length - 1].anchor) && pts.length > 0) return { kind: "retract" };
    return { kind: "draw" };
  }
  if (!page) return { kind: "new" };
  const hit = pathHitAt(p, env.zoom, 6, shownPaths(page), { handles: false });
  if (hit?.kind === "anchor") return hit.end ? { kind: "continue", hit } : { kind: "delete", hit };
  if (hit?.kind === "segment") return { kind: "add", hit };
  // an open end of any path continues it (Illustrator)
  const other = pathHitAt(p, env.zoom, 6, pickablePaths(page), { handles: false });
  if (other?.kind === "anchor" && other.end) return { kind: "continue", hit: other };
  return { kind: "new" };
}

/** The cursor for the active path tool at p. */
export function pathCursor(p: Vec2, env: PathEnv): string {
  const tool = effectiveTool();
  const page = currentPage();
  if (!page) return "default";
  if (tool === "direct") {
    const hit = pathHitAt(p, env.zoom, 6, shownPaths(page)) ?? pathHitAt(p, env.zoom, 6, pickablePaths(page), { handles: false });
    const hk = hit && (hit.kind === "anchor" ? akey({ id: hit.node.id, ci: hit.ci, ni: hit.ni }) : null);
    if (useAnchors.getState().hover !== hk) useAnchors.getState().set({ hover: hk });
    return hit && (hit.kind === "anchor" || hit.kind === "handle") ? CURSORS.directPoint : CURSORS.direct;
  }
  if (useAnchors.getState().hover) useAnchors.getState().set({ hover: null });
  if (tool === "anchorConvert") return S().tool === "anchorConvert" ? CURSORS.convert : CURSORS.penConvert;
  if (tool === "anchorAdd") return CURSORS.penAdd;
  if (tool === "anchorDel") return CURSORS.penDel;
  if (tool === "curvature") return CURSORS.curvature;
  const a = penAction(p, env);
  return a.kind === "close" ? CURSORS.penClose : a.kind === "continue" || a.kind === "retract" ? CURSORS.penCont : a.kind === "add" ? CURSORS.penAdd : a.kind === "delete" ? CURSORS.penDel : a.kind === "new" ? CURSORS.penNew : CURSORS.pen;
}

// ───────── gestures ─────────

export type PathDrag =
  | { kind: "pen-drag"; index: number; outOnly: boolean }
  | { kind: "pen-close"; at: Vec2; delta: Vec2 | null; split: boolean }
  | { kind: "anchors"; start: Vec2; moved: boolean; click: string | null }
  | { kind: "handle"; id: string; ci: number; ni: number; part: "in" | "out"; split: boolean; moved: boolean }
  | { kind: "bend"; id: string; ci: number; seg: number; u: number; base: [VectorAnchor, VectorAnchor]; moved: boolean }
  | { kind: "pull"; id: string; ci: number; ni: number; moved: boolean; dbl: boolean }
  | { kind: "amarquee"; start: Vec2; cur: Vec2; add: boolean };

function selectAnchor(id: string, ci: number, ni: number, shift: boolean) {
  const s = S();
  const k = akey({ id, ci, ni });
  if (!s.selection.includes(id)) s.set({ selection: shift ? [...s.selection, id] : [id] });
  const sel = useAnchors.getState().sel;
  if (shift) setAnchors(sel.includes(k) ? sel.filter((x) => x !== k) : [...sel, k]);
  else if (!sel.includes(k)) setAnchors([k]);
}

function segmentDrag(h: Extract<PathHit, { kind: "segment" }>, shift: boolean, bendStraight: boolean): PathDrag {
  const s = S();
  const c = h.node.contours[h.ci];
  const a = c.nodes[h.seg], b = c.nodes[(h.seg + 1) % c.nodes.length];
  if (!s.selection.includes(h.node.id)) s.set({ selection: shift ? [...s.selection, h.node.id] : [h.node.id] });
  s.beginGesture();
  if (isStraight(a, b) && !bendStraight) {
    // a straight segment moves with its two points (Illustrator's direct selection)
    const ks = [akey({ id: h.node.id, ci: h.ci, ni: h.seg }), akey({ id: h.node.id, ci: h.ci, ni: (h.seg + 1) % c.nodes.length })];
    setAnchors(shift ? [...new Set([...useAnchors.getState().sel, ...ks])] : ks);
    return { kind: "anchors", start: [0, 0], moved: false, click: null };
  }
  if (!shift) setAnchors([]);
  return { kind: "bend", id: h.node.id, ci: h.ci, seg: h.seg, u: h.u, base: [clone(a), clone(b)], moved: false };
}

/**
 * Pointer down with a path tool (`e` the pointer event, p page point). Returns the drag to follow, or null when the
 * click was all (add / delete / convert). `start` of an "anchors" drag is filled in here.
 */
export function pathDown(e: { shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean; detail: number }, p: Vec2, env: PathEnv): PathDrag | null {
  mods.ctrl = e.ctrlKey || e.metaKey;
  mods.alt = e.altKey;
  const s = S();
  const page = currentPage();
  if (!page) return null;
  const tool = effectiveTool();
  const z = env.zoom;
  const withStart = (d: PathDrag | null): PathDrag | null => (d?.kind === "anchors" ? { ...d, start: p } : d);

  // ── the path being drawn takes the clicks first (Ctrl+click on an empty spot ends it, as in Illustrator) ──
  if (isDrawing() && (s.tool === "pen" || s.tool === "curvature")) {
    if (mods.ctrl) {
      const hit = pathHitAt(p, z, 6, shownPaths(page));
      if (!hit) return finishDrawing(false), null;
    } else {
      const a = penAction(p, env);
      if (a.kind === "close") {
        // the pen closes on release, so a drag from the closing point pulls its handles (Illustrator)
        if (s.tool === "pen") return { kind: "pen-close", at: closingPoint() ?? p, delta: null, split: false };
        return finishDrawing(true), env.invalidate(), null;
      }
      if (e.detail >= 2 && drawing.pts.length >= 2) return finishDrawing(false), env.invalidate(), null;
      if (a.kind === "retract" && s.tool === "pen") {
        drawStep();
        const last = drawing.pts[drawing.pts.length - 1];
        last.handleOut = [...last.anchor];
        last.isCorner = true;
        env.invalidate();
        return { kind: "pen-drag", index: drawing.pts.length - 1, outOnly: true };
      }
      const q = snapPt(p, e);
      drawStep();
      drawing.pts.push({ anchor: q, handleIn: q, handleOut: q, isCorner: s.tool === "curvature" ? e.altKey : true });
      env.invalidate();
      return s.tool === "pen" ? { kind: "pen-drag", index: drawing.pts.length - 1, outOnly: false } : null;
    }
  }

  const slide = currentEditMode() === "SLIDE";
  const shown = shownPaths(page);
  const any = pickablePaths(page);

  if (tool === "direct") {
    const hit = pathHitAt(p, z, 6, shown) ?? pathHitAt(p, z, 6, any, { handles: false });
    // PowerPoint 점 편집: Ctrl+click on the line adds a point, on a point deletes it
    if (slide && mods.ctrl && hit) {
      if (hit.kind === "segment") addAnchor(hit.node, hit.ci, hit.seg, hit.u);
      else if (hit.kind === "anchor") deleteAnchor(hit.node, hit.ci, hit.ni);
      return null;
    }
    if (hit?.kind === "handle") {
      s.beginGesture();
      // Alt (at the press or during the drag) moves this handle alone
      return { kind: "handle", id: hit.node.id, ci: hit.ci, ni: hit.ni, part: hit.part, split: e.altKey, moved: false };
    }
    if (hit?.kind === "anchor") {
      const k = akey({ id: hit.node.id, ci: hit.ci, ni: hit.ni });
      const already = useAnchors.getState().sel.includes(k);
      selectAnchor(hit.node.id, hit.ci, hit.ni, e.shiftKey);
      if (e.shiftKey && already) return null;
      s.beginGesture();
      return withStart({ kind: "anchors", start: p, moved: false, click: already && !e.shiftKey ? k : null });
    }
    if (hit?.kind === "segment") return withStart(segmentDrag(hit, e.shiftKey, false));
    // inside a filled path: the whole path (all its points) moves
    const body = pathHitAt(p, z, 6, any, { handles: false, body: true });
    if (body?.kind === "body") {
      const n = body.node;
      if (!s.selection.includes(n.id)) s.set({ selection: e.shiftKey ? [...s.selection, n.id] : [n.id] });
      const all = n.contours.flatMap((c, ci) => c.nodes.map((_, ni) => akey({ id: n.id, ci, ni })));
      setAnchors(e.shiftKey ? [...new Set([...useAnchors.getState().sel, ...all])] : all);
      s.beginGesture();
      return { kind: "anchors", start: p, moved: false, click: null };
    }
    if (!e.shiftKey) {
      s.set({ selection: [] });
      setAnchors([]);
    }
    return { kind: "amarquee", start: p, cur: p, add: e.shiftKey };
  }

  if (tool === "anchorConvert") {
    const hit = pathHitAt(p, z, 6, shown) ?? pathHitAt(p, z, 6, any, { handles: false });
    if (!hit || hit.kind === "body") return null;
    s.beginGesture();
    if (hit.kind === "handle") return { kind: "handle", id: hit.node.id, ci: hit.ci, ni: hit.ni, part: hit.part, split: true, moved: false };
    if (hit.kind === "anchor") {
      if (!s.selection.includes(hit.node.id)) s.set({ selection: [hit.node.id] });
      return { kind: "pull", id: hit.node.id, ci: hit.ci, ni: hit.ni, moved: false, dbl: false };
    }
    s.cancelGesture();
    return segmentDrag(hit, false, true);
  }

  if (tool === "curvature") {
    const hit = pathHitAt(p, z, 6, shown, { handles: false });
    if (hit?.kind === "anchor") {
      if (e.detail >= 2) {
        convertAnchor(hit.node, hit.ci, hit.ni);
        return null;
      }
      selectAnchor(hit.node.id, hit.ci, hit.ni, e.shiftKey);
      s.beginGesture();
      return { kind: "anchors", start: p, moved: false, click: null };
    }
    if (hit?.kind === "segment") return addAnchor(hit.node, hit.ci, hit.seg, hit.u), null;
    const q = snapPt(p, e);
    drawing.tool = "curvature";
    drawing.cont = null;
    drawing.steps = [[]];
    drawing.pts = [{ anchor: q, handleIn: q, handleOut: q, isCorner: e.altKey }];
    env.invalidate();
    return null;
  }

  // pen
  const a = penAction(p, env);
  if (a.kind === "add") return addAnchor(a.hit.node, a.hit.ci, a.hit.seg, a.hit.u), null;
  if (a.kind === "delete") return deleteAnchor(a.hit.node, a.hit.ci, a.hit.ni), null;
  if (a.kind === "continue") {
    const n = a.hit.node;
    const end = n.contours[a.hit.ci].nodes[a.hit.ni];
    const pg = (v: Vec2) => applyTransform(n.transform, v);
    const atStart = a.hit.end === "start";
    // drawing goes on from this end: its out handle is the one away from the path
    const out = atStart ? end.handleIn : end.handleOut;
    drawing.pts = [{ anchor: pg(end.anchor), handleIn: pg(atStart ? end.handleOut : end.handleIn), handleOut: pg(out), isCorner: end.isCorner }];
    drawing.cont = { id: n.id, ci: a.hit.ci, atStart };
    drawing.tool = "pen";
    drawing.steps = [[]];
    s.set({ selection: [n.id] });
    setAnchors([akey({ id: n.id, ci: a.hit.ci, ni: a.hit.ni })]);
    env.invalidate();
    return { kind: "pen-drag", index: 0, outOnly: true };
  }
  const q = snapPt(p, e);
  drawing.tool = "pen";
  drawing.cont = null;
  drawing.steps = [[]];
  drawing.pts = [{ anchor: q, handleIn: q, handleOut: q, isCorner: true }];
  env.invalidate();
  return { kind: "pen-drag", index: 0, outOnly: false };
}

/** The point a click closes the drawn path on (page px): its first point, or the other end of the path continued. */
function closingPoint(): Vec2 | null {
  const cont = drawing.cont;
  if (!cont) return drawing.pts[0]?.anchor ?? null;
  const n = currentPage()?.nodes.find((x) => x.id === cont.id);
  const c = n?.type === "VECTOR" ? n.contours[cont.ci] : undefined;
  if (!n || !c?.nodes.length) return null;
  return applyTransform(n.transform, (cont.atStart ? c.nodes[c.nodes.length - 1] : c.nodes[0]).anchor);
}

/** Pointer move during a path drag. */
export function pathMove(d: PathDrag, e: { shiftKey: boolean; altKey: boolean }, p: Vec2, env: PathEnv) {
  const s = S();
  const node = (doc: Parameters<Parameters<typeof s.updateGesture>[0]>[0], id: string) => draftPage(doc, s.pageId)?.nodes.find((x) => x.id === id) as VectorNode | undefined;
  switch (d.kind) {
    case "pen-drag": {
      const a = drawing.pts[d.index];
      if (!a) return;
      const q = e.shiftKey ? snap45(a.anchor, p) : p;
      const dx = q[0] - a.anchor[0], dy = q[1] - a.anchor[1];
      if (Math.hypot(dx, dy) * env.zoom > 3) {
        a.handleOut = [a.anchor[0] + dx, a.anchor[1] + dy];
        // Alt: split the handles — only the outgoing one follows, the point becomes a corner; a point already placed
        // (a continued end, a retracted last point) only gets its out handle
        if (e.altKey || mods.alt) a.isCorner = true;
        else if (!d.outOnly) {
          a.handleIn = [a.anchor[0] - dx, a.anchor[1] - dy];
          a.isCorner = false;
        }
      }
      env.invalidate();
      return;
    }
    case "pen-close": {
      const q = e.shiftKey ? snap45(d.at, p) : p;
      const dx = q[0] - d.at[0], dy = q[1] - d.at[1];
      d.delta = Math.hypot(dx, dy) * env.zoom > 3 ? [dx, dy] : null;
      if (e.altKey || mods.alt) d.split = true;
      env.invalidate();
      return;
    }
    case "anchors": {
      let dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      if (!d.moved && Math.hypot(dx, dy) * env.zoom < 2) return;
      d.moved = true;
      if (e.shiftKey) [dx, dy] = (([x, y]) => [x - d.start[0], y - d.start[1]])(snap45(d.start, p));
      const refs = useAnchors.getState().sel.map(parseKey);
      // snap the point under the pointer (one point moved) to the grid / guides / other objects
      if (refs.length === 1 && snapOn(e) && !e.shiftKey) {
        const base = s.gestureBase && findNode(s.gestureBase, refs[0].id);
        const a = base?.contours[refs[0].ci]?.nodes[refs[0].ni];
        if (base && a) {
          const at = applyTransform(base.transform, a.anchor);
          const q = snapPt([at[0] + dx, at[1] + dy], e, undefined, [base.id]);
          dx = q[0] - at[0];
          dy = q[1] - at[1];
        }
      }
      s.updateGesture((doc) => {
        for (const r of refs) {
          const n = node(doc, r.id);
          const base = s.gestureBase && findNode(s.gestureBase, r.id);
          const a = n?.contours[r.ci]?.nodes[r.ni], b = base?.contours[r.ci]?.nodes[r.ni];
          if (!n || !a || !b) continue;
          const o = invertTransform(n.transform, [0, 0]), q = invertTransform(n.transform, [dx, dy]);
          Object.assign(a, clone(b));
          moveAnchor(a, q[0] - o[0], q[1] - o[1]);
        }
      });
      return;
    }
    case "handle": {
      d.moved = true;
      s.updateGesture((doc) => {
        const n = node(doc, d.id);
        const a = n?.contours[d.ci]?.nodes[d.ni];
        if (!n || !a) return;
        const at = applyTransform(n.transform, a.anchor);
        const q = invertTransform(n.transform, e.shiftKey ? snap45(at, p) : p);
        if (e.altKey || mods.alt) d.split = true;
        dragHandle(a, d.part, q, d.split);
      });
      return;
    }
    case "bend": {
      d.moved = true;
      s.updateGesture((doc) => {
        const n = node(doc, d.id);
        const c = n?.contours[d.ci];
        if (n && c) bendSegment(c, d.seg, d.base, d.u, invertTransform(n.transform, p));
      });
      return;
    }
    case "pull": {
      s.updateGesture((doc) => {
        const n = node(doc, d.id);
        const a = n?.contours[d.ci]?.nodes[d.ni];
        if (!n || !a) return;
        const at = applyTransform(n.transform, a.anchor);
        if (!d.moved && Math.hypot(p[0] - at[0], p[1] - at[1]) * env.zoom < 3) return;
        d.moved = true;
        pullHandles(a, invertTransform(n.transform, e.shiftKey ? snap45(at, p) : p));
      });
      return;
    }
    case "amarquee":
      d.cur = p;
      env.invalidate();
      return;
  }
}

/** Pointer up: the gesture becomes one history step (or the click's own action). */
export function pathUp(d: PathDrag, env: PathEnv) {
  const s = S();
  switch (d.kind) {
    case "pen-drag":
      env.invalidate();
      return;
    case "pen-close":
      finishDrawing(true, d.delta && { delta: d.delta, split: d.split });
      env.invalidate();
      return;
    case "anchors":
      if (d.moved) s.endGesture(hl("shell.hist.editAnchors"));
      else {
        s.cancelGesture();
        // a click on one of several selected points selects just that one
        if (d.click) setAnchors([d.click]);
      }
      return;
    case "handle":
    case "bend":
      if (d.moved) s.endGesture(hl(d.kind === "bend" ? "pen.hist.bend" : "shell.hist.editAnchors"));
      else s.cancelGesture();
      return;
    case "pull": {
      if (d.moved) return s.endGesture(hl("shell.hist.convertAnchor"));
      s.cancelGesture();
      const n = currentPage()?.nodes.find((x) => x.id === d.id);
      if (n?.type === "VECTOR") convertAnchor(n, d.ci, d.ni);
      return;
    }
    case "amarquee": {
      const page = currentPage();
      const r = rectFromPoints([d.start, d.cur]);
      if (page && (r.w * env.zoom > 3 || r.h * env.zoom > 3)) {
        const keys = anchorsInRect(page, r, isolationFilter());
        const ids = [...new Set(keys.map((k) => parseKey(k).id))];
        const prev = useAnchors.getState().sel;
        s.set({ selection: d.add ? [...new Set([...s.selection, ...ids])] : ids });
        setAnchors(d.add ? [...new Set([...prev, ...keys])] : keys);
      }
      env.invalidate();
      return;
    }
  }
}

function findNode(doc: ReturnType<typeof S>["doc"], id: string): VectorNode | undefined {
  const s = S();
  const pg = doc.pages.find((p) => p.id === s.pageId) ?? doc.masters.find((p) => p.id === s.pageId);
  const n = pg?.nodes.find((x) => x.id === id);
  return n?.type === "VECTOR" ? n : undefined;
}

// ───────── overlay ─────────

/** Bezier of a contour on screen (affine maps keep Bézier control points). */
function tracePath(o: CanvasRenderingContext2D, n: VectorNode, env: PathEnv) {
  const m = (v: Vec2) => env.toScreen(applyTransform(n.transform, v));
  o.beginPath();
  for (const c of n.contours) {
    if (!c.nodes.length) continue;
    const f = m(c.nodes[0].anchor);
    o.moveTo(f[0], f[1]);
    const segs = c.closed ? c.nodes.length : c.nodes.length - 1;
    for (let i = 0; i < segs; i++) {
      const a = c.nodes[i], b = c.nodes[(i + 1) % c.nodes.length];
      const p1 = m(a.handleOut), p2 = m(b.handleIn), p3 = m(b.anchor);
      o.bezierCurveTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    }
    if (c.closed) o.closePath();
  }
}

/** Anchor square (filled = selected, hollow = not), handle line + round end; on whole device pixels. */
function drawPoint(o: CanvasRenderingContext2D, q: Vec2, selected: boolean, hover: boolean, env: PathEnv) {
  const size = hover ? 9 : 7;
  const [x, y, w] = crisp.snapUi ? snapSquare(q[0], q[1], size, env.dpr) : [Math.round(q[0]) - 3, Math.round(q[1]) - 3, size];
  const lw = crisp.snapUi ? hairCss(env.dpr) : 1;
  o.fillStyle = selected ? ACCENT : "#ffffff";
  o.fillRect(x, y, w, w);
  o.strokeStyle = ACCENT;
  o.lineWidth = lw;
  o.strokeRect(x + lw / 2, y + lw / 2, w - lw, w - lw);
}

function drawHandle(o: CanvasRenderingContext2D, from: Vec2, to: Vec2, env: PathEnv) {
  const px = (v: number) => (crisp.snapUi ? snapStroke(v, env.dpr) : Math.round(v) + 0.5);
  o.strokeStyle = ACCENT;
  o.lineWidth = crisp.snapUi ? hairCss(env.dpr) : 1;
  o.beginPath();
  o.moveTo(px(from[0]), px(from[1]));
  o.lineTo(px(to[0]), px(to[1]));
  o.stroke();
  // the handle end: a filled dot centred on a device pixel
  o.fillStyle = ACCENT;
  o.beginPath();
  o.arc(px(to[0]), px(to[1]), 3.5 * Math.max(1, Math.round(env.dpr)) / env.dpr, 0, Math.PI * 2);
  o.fill();
}

/** Path outline, handles and anchor points of one shown path. */
export function drawPathEdit(o: CanvasRenderingContext2D, n: VectorNode, env: PathEnv) {
  o.save();
  o.strokeStyle = ACCENT;
  o.lineWidth = crisp.snapUi ? hairCss(env.dpr) : 1;
  tracePath(o, n, env);
  o.stroke();
  const m = (v: Vec2) => env.toScreen(applyTransform(n.transform, v));
  const shown = shownHandles(n);
  const { sel, hover } = useAnchors.getState();
  n.contours.forEach((c, ci) =>
    c.nodes.forEach((a, ni) => {
      const at = m(a.anchor);
      for (const part of ["in", "out"] as const) {
        const h = part === "in" ? a.handleIn : a.handleOut;
        if (shown.has(`${ci}:${ni}:${part}`) && (h[0] !== a.anchor[0] || h[1] !== a.anchor[1])) drawHandle(o, at, m(h), env);
      }
    }),
  );
  n.contours.forEach((c, ci) =>
    c.nodes.forEach((a, ni) => {
      const k = `${n.id}:${ci}:${ni}`;
      drawPoint(o, m(a.anchor), sel.includes(k), hover === k, env);
    }),
  );
  o.restore();
}

/** Outline of a path under the pointer that is not selected (Illustrator's highlight). */
export function drawPathHover(o: CanvasRenderingContext2D, n: VectorNode, env: PathEnv) {
  o.save();
  o.strokeStyle = ACCENT;
  o.lineWidth = crisp.snapUi ? hairCss(env.dpr) : 1;
  tracePath(o, n, env);
  o.stroke();
  o.restore();
}

/** The path being drawn, its rubber band to the pointer and the anchor marquee. */
export function drawPathTool(o: CanvasRenderingContext2D, d: PathDrag | null, cursor: Vec2, env: PathEnv) {
  if (d?.kind === "amarquee") {
    const a = env.toScreen(d.start), b = env.toScreen(d.cur);
    const px = (v: number) => (crisp.snapUi ? snapStroke(v, env.dpr) : Math.round(v) + 0.5);
    o.save();
    o.strokeStyle = ACCENT;
    o.lineWidth = crisp.snapUi ? hairCss(env.dpr) : 1;
    o.setLineDash([4, 3]);
    o.strokeRect(px(Math.min(a[0], b[0])), px(Math.min(a[1], b[1])), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    o.restore();
  }
  if (!isDrawing()) return;
  const curv = drawing.tool === "curvature";
  const pts = curv ? curvaturePts(d ? undefined : cursor) : drawing.pts;
  const s = S();
  o.save();
  // the new path in its stroke colour, a device-pixel hairline (Illustrator previews the path itself, not a thick line)
  o.strokeStyle = ACCENT;
  o.lineWidth = crisp.snapUi ? hairCss(env.dpr) : 1;
  o.beginPath();
  const f = env.toScreen(pts[0].anchor);
  o.moveTo(f[0], f[1]);
  for (let i = 1; i < pts.length; i++) {
    const a = env.toScreen(pts[i - 1].handleOut), b = env.toScreen(pts[i].handleIn), c = env.toScreen(pts[i].anchor);
    o.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
  }
  o.stroke();
  // the closing segment as the drag on the closing point shapes it
  if (d?.kind === "pen-close") {
    const last = pts[pts.length - 1];
    const g = closeHandles({ anchor: d.at, handleIn: d.at, handleOut: d.at, isCorner: true }, { delta: d.delta ?? [0, 0], split: d.split });
    const a = env.toScreen(last.handleOut), b = env.toScreen(g.handleIn), c = env.toScreen(d.at), l = env.toScreen(last.anchor);
    o.beginPath();
    o.moveTo(l[0], l[1]);
    o.bezierCurveTo(a[0], a[1], b[0], b[1], c[0], c[1]);
    o.stroke();
    if (d.delta) {
      drawHandle(o, c, b, env);
      if (!d.split) drawHandle(o, c, env.toScreen(g.handleOut), env);
    }
  }
  // pen rubber band: the next segment as it would be with a click here
  if (!curv && !d) {
    const last = pts[pts.length - 1];
    const a = env.toScreen(last.handleOut), c = env.toScreen(cursor);
    o.strokeStyle = s.stroke && s.stroke !== "#ffffff" ? s.stroke : ACCENT;
    o.globalAlpha = 0.7;
    o.beginPath();
    o.moveTo(env.toScreen(last.anchor)[0], env.toScreen(last.anchor)[1]);
    o.bezierCurveTo(a[0], a[1], c[0], c[1], c[0], c[1]);
    o.stroke();
    o.globalAlpha = 1;
  }
  // handles of the last point, then the points (the last one selected)
  const last = drawing.pts[drawing.pts.length - 1];
  if (!curv && last) {
    const at = env.toScreen(last.anchor);
    for (const h of [last.handleIn, last.handleOut]) if (h[0] !== last.anchor[0] || h[1] !== last.anchor[1]) drawHandle(o, at, env.toScreen(h), env);
  }
  const shownPts = curv ? pts.slice(0, drawing.pts.length) : pts;
  shownPts.forEach((a, i) => drawPoint(o, env.toScreen(a.anchor), i === shownPts.length - 1, false, env));
  // close hint: a ring on the first point
  const c = env.toScreen(cursor);
  if (pts.length > 2 && !drawing.cont && Math.hypot(f[0] - c[0], f[1] - c[1]) < 8) {
    o.strokeStyle = ACCENT;
    o.beginPath();
    o.arc(f[0], f[1], 7, 0, Math.PI * 2);
    o.stroke();
  }
  o.restore();
}

/** The path under the pointer to highlight (direct selection / pen), when it is not shown already. */
export function hoverPath(p: Vec2, env: PathEnv): VectorNode | null {
  const page = currentPage();
  if (!page) return null;
  const shown = new Set(shownPaths(page).map((n) => n.id));
  const hit = pathHitAt(p, env.zoom, 6, pickablePaths(page).filter((n) => !shown.has(n.id)), { handles: false, body: effectiveTool() === "direct" });
  return hit ? hit.node : null;
}
