import { drawFormatMarks } from "./docExtrasUi";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { applyTransform, invertTransform, rectFromPoints, type Rect } from "../core/geom";
import { localBounds, nodeBounds } from "../core/loom";
import { pickableOn } from "../core/layerTree";
import { currentPage, draftPage, masterOf, toolDone, useStore } from "../core/store";
import { HF_EDIT_EVENT, hfAreaAt, hfEditNode, hfNodeId, parseHfId, renderMasterOf } from "../core/headerFooter";
import { distanceToContour, pointInContours } from "../core/vector";
import { TILE, newText, type Page, type SceneNode, type TableNode, type TextNode, type Vec2 } from "../core/types";
import { Stroke } from "../render/brush";
import { WeaveCache, type WeaveStats } from "../render/weave";
import { drawFidelity } from "./fidelity";
import { addToDictionary, drawSpelling, ignoreAll, replaceWord, spellAt, suggestionsFor } from "./spell";
import { PopMenu } from "./shell/DocTabs";
import type { MenuItem } from "./shell/controls";
import { importFile, nodesAt, openAndRemember, setViewportSize, fitCurrent, placeImage, viewIsFitted, viewportNow, keepCentre } from "./actions";
import { claimDrop, droppedFiles, placesOnPage } from "./fileDrop";
import { followCanvasSize, followsCanvas } from "./viewFollow";
import { TouchNav, applyStep, doubleTapView, isDoubleTap } from "./touchNav";
import { CellEditor, useCellSel, type CellTarget } from "./CellEditor";
import { pickForMenu, tableMenuItems } from "./tableMenu";
import { useImageUI } from "./shell/imageMenu";
import { drawnShape } from "./drawDefaults";
import { RichTextEditor } from "./RichTextEditor";
import { FlowEditor, PicLayoutButton } from "./FlowEditor";
import { NOTE_EDIT_EVENT, endTyping, flowActive, flowContextPress, focusInput,flowPointerDown, flowPointerMove, flowPointerUp, isFlowPage, useDocView } from "./docFlow";
import { pasteClipboard, pasteIsOurs, writeClipboardMarker } from "./menuActions";
import { isTyping } from "./shell/ops";
import { cellAt, cellRect, dragEnd, expandRange, layoutTable } from "../core/table";
import { bodyBox } from "../core/pageSetup";
import { hitGuide, type GuideAxis } from "../core/pages";
import { snapAxis, snapPoint, snapRect, smartGuideSegments, type SnapIndex, type SnapLine } from "../core/snap";
import { unionRect } from "../core/geom";
import { formatLength, visibleGridStep } from "../core/units";
import { GUIDE_HIT_PX, RULER, canEditGuides, gridFor, liveGuide, snapIndexFor, snapOn, snapPt, snapTol, unitFor, useAids, visibleGuides } from "./aids";
import { GuideEditor } from "./GuideEditor";
import { Rulers } from "./Rulers";
import { uiScaleFactor, useUI } from "./shell/uiStore";
import { CORNERS, EDGES, boxCenter, boxSize, handleCursor, handlePoint, insideBox, pickHandle, pointerTarget, type Handle } from "../core/transform";
import { liveResize, liveRotate, selectionBox, useXform, type SelBox } from "./xform";
import { cropFrame, cropRatioValue, dragCropRect, isCanvasCrop, setCropAngle, useCrop } from "./cropTool";
import { moveCrop, resizeCrop } from "../core/crop";
import { t as tr } from "../i18n";
import { caretAtPoint, clickTextAction, docHooks } from "./editModes";
import { docModeNow, docWheel, drawNeighbours, pickPageAt } from "./docView";
import { crisp, hairCss, snapSquare, snapStroke } from "../render/crisp";
import { sessionHooks } from "../core/sessions";
import { currentEditMode } from "./editModes";
import { isEmptyPh, phBox, promptKey } from "../core/slides";
import { attachCanvas, cadCanvas } from "./cad/hooks";
import { useCadScreenNow } from "./editModes";
import { isOpaqueColor } from "../render/weave";
import { vectorPath } from "../render/draw";
import { revealTransparencyInPlace } from "./transparency";
import { applyGradient, clipToSelection, deselect, paintTarget, lassoSelect, marqueeSelect, opFromMods, pickColorAt, usePixelSel, wandSelect, activeMask } from "./pixelSelect";
import { addAnchorAt, constrain45, deleteAnchorAt, drawnLine, enterIsolation, exitIsolation, isolationFilter, useDesign } from "./designTools";
import { countPress, type PressCount } from "../core/clickCount";
import { zoomAt } from "./shell/ops";
import { isPathTool, nudgeAnchors, pathHitAt, selectedAnchors, setInsideTest, shownPaths, useAnchors } from "./pathTools";
import {
  CURSORS, cancelDrawing, drawingHooks, drawPathEdit, drawPathHover, drawPathTool, effectiveTool, finishDrawing, hoverPath, isDrawing, mods, pathCursor, pathDown, pathMove, pathUp, type PathDrag, type PathEnv,
} from "./pathCanvas";
import type { SelOp } from "../core/image/pixelSelection";
import { PdfFormLayer } from "./pdf/PdfFormLayer"; // PDF form fields
import { PdfAnnotLayer } from "./pdf/PdfAnnotLayer"; // PDF comments
import { PdfFindLayer } from "./pdf/PdfFind"; // PDF find matches
import { PsdTextEditor, startPsdTextEdit } from "./psdText/PsdTextEditor"; // PSD text layers
import { psdTextAt } from "./psdText/psdTextRender";
import { changeHere, commentsHere, deleteComment, resolveHere, startComment } from "./reviewActions";

/** The drawing screen paints model space without an edge: entities drawn beyond the imported extents (or the new
 *  drawing's sheet) show too (QA 2026-11-19 1-2). */
const MODEL_SPACE: Rect = { x: -1e7, y: -1e7, w: 2e7, h: 2e7 };
export const useStats = create<{ stats: WeaveStats | null; fps: number }>(() => ({ stats: null, fps: 0 }));
export const weave = new WeaveCache();
// document tabs (core/sessions.ts): painted tiles of the tab left behind are dropped, so a hidden tab holds no
// canvas memory; its document is repainted from its own tiles when it comes back
sessionHooks.switched.push(() => weave.clear());
// dev-only: before / after switches and the tile cache for the crispness checks (docs/design/RENDER_CRISPNESS.md)
if (import.meta.env.DEV) Object.assign(window, { __omwCrisp: crisp, __omwWeave: weave });

const S = () => useStore.getState();
const workspaceColor = () => getComputedStyle(document.documentElement).getPropertyValue("--workspace").trim() || "#1b1d22";
const ACCENT = "#2b74ec"; // selection blue: the UI accent, a step brighter so it reads on dark pasteboard and white pages (VISUAL_DESIGN.md)
const GUIDE = "#16b8d9";
const SMART = "#ff3d9a";
const A = () => useAids.getState();
/** handle grab radius and drawn size, screen px */
const HANDLE_PX = 7;
/** a floating text box's frame (screen px) where a press selects it instead of typing (Word) */
const FRAME_PX = 5;
/** rotate zone reach outside a corner, screen px */
const ROTATE_PX = 24;
const ROTATE_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><path d='M6 14a7 7 0 1 0 2-7' fill='none' stroke='white' stroke-width='4' stroke-linecap='round'/><path d='M6 14a7 7 0 1 0 2-7' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round'/><path d='M3 5l6 1-2 5z' fill='black' stroke='white' stroke-width='1'/></svg>\") 12 12, crosshair";

const EYEDROPPER_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='20' height='20' viewBox='0 0 20 20'><path d='M2.5 17.5l1-3.5 7.5-7.5 2.5 2.5-7.5 7.5z' fill='white' stroke='black' stroke-width='1.2' stroke-linejoin='round'/><path d='M11 4.5l1.8-1.8a1.6 1.6 0 0 1 2.3 0l2.2 2.2a1.6 1.6 0 0 1 0 2.3L15.5 9z' fill='black'/></svg>\") 2 18, crosshair";

// `ix` = snap index, built lazily on the first move of a gesture (core/snap.ts)
type Drag =
  | { kind: "flow" }
  | { kind: "cells"; nodeId: string; anchor: { row: number; col: number } }
  // the drawing screen (ui/cad/view.ts) handles the press
  | { kind: "cad" }
  | { kind: "move"; start: Vec2; moved: boolean; ix?: SnapIndex; base?: Rect | null }
  | { kind: "pan"; sx: number; sy: number; panX: number; panY: number }
  | { kind: "marquee"; start: Vec2; cur: Vec2 }
  | { kind: "xform"; sb: SelBox; handle: Handle | null; startAngle: number; ix?: SnapIndex }
  | { kind: "crop"; handle: Handle | null; rect0: Rect; q0: Vec2 }
  | { kind: "cropRotate"; angle0: number; a0: number; c: Vec2 }
  | { kind: "cropNew"; rect0: Rect; q0: Vec2 }
  | { kind: "stroke"; stroke: Stroke }
  | { kind: "shape"; shape: "rect" | "ellipse"; start: Vec2; cur: Vec2; ix?: SnapIndex }
  // pen family and direct selection (ui/pathCanvas.ts)
  | { kind: "path"; d: PathDrag }
  | { kind: "guide"; axis: GuideAxis; from: number; cur: number; remove: boolean; lines: SnapLine[]; ix: SnapIndex }
  // image mode (ui/pixelSelect.ts): marquee M, lasso L, gradient G; design mode: line segment \
  | { kind: "pixmarquee"; start: Vec2; cur: Vec2; op: SelOp }
  | { kind: "lasso"; pts: Vec2[]; op: SelOp }
  | { kind: "gradient"; a: Vec2; b: Vec2 }
  | { kind: "line"; a: Vec2; b: Vec2; ix?: SnapIndex };

function screenToPage(sx: number, sy: number): Vec2 {
  const { zoom, panX, panY } = S().view;
  return [(sx - panX) / zoom, (sy - panY) / zoom];
}
function pageToScreen(p: Vec2): Vec2 {
  const { zoom, panX, panY } = S().view;
  return [p[0] * zoom + panX, p[1] * zoom + panY];
}

function cornersOf(n: SceneNode): Vec2[] {
  const b = localBounds(n);
  return ([[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]] as Vec2[]).map((p) => applyTransform(n.transform, p));
}

function hitNode(n: SceneNode, p: Vec2, tol: number): boolean {
  if (!n.visible || n.locked) return false;
  const lp = invertTransform(n.transform, p);
  switch (n.type) {
    case "VECTOR":
      if (n.fill && pointInContours(n, lp)) return true;
      return n.contours.some((c) => distanceToContour(c, lp) <= (n.stroke ? n.strokeWidth / 2 : 0) + tol / n.transform.scale);
    case "RASTER": {
      const c = n.crop;
      if (c && (lp[0] < c.x || lp[1] < c.y || lp[0] > c.x + c.w || lp[1] > c.y + c.h)) return false;
      const tx = Math.floor(lp[0] / TILE), ty = Math.floor(lp[1] / TILE);
      const t = n.tiles[`${tx}_${ty}`];
      if (!t) return false;
      const lx = Math.floor(lp[0] - tx * TILE), ly = Math.floor(lp[1] - ty * TILE);
      return t.data[(ly * TILE + lx) * 4 + 3] > 8;
    }
    default: {
      const b = localBounds(n);
      return lp[0] >= b.x && lp[0] <= b.x + b.w && lp[1] >= b.y && lp[1] <= b.y + b.h;
    }
  }
}

/**
 * Empty placeholders of a slide: a dashed box and the grey prompt (with a bullet for content), in the placeholder's
 * first font, size and alignment — drawn over the page on screen only, never painted into the slide.
 */
function drawPrompts(o: CanvasRenderingContext2D, page: Page, editing: string | null) {
  const { zoom, panX, panY } = S().view;
  for (const n of page.nodes) {
    if (!n.visible || n.id === editing || !isEmptyPh(n)) continue;
    const b = phBox(n)!;
    const x = b.x * zoom + panX, y = b.y * zoom + panY, w = b.w * zoom, h = b.h * zoom;
    o.save();
    o.strokeStyle = "rgba(110,116,130,.85)";
    o.lineWidth = 1;
    o.setLineDash([4, 3]);
    o.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    const para = n.paragraphs[0];
    const run = para?.runs[0];
    const size = (run?.fontSize ?? 24) * zoom * n.transform.scale;
    o.font = `${run?.bold ? "700 " : ""}${size}px "${run?.fontFamily ?? "Pretendard"}", sans-serif`;
    o.fillStyle = "rgba(110,116,130,.9)";
    o.textBaseline = "alphabetic";
    const bullet = para?.list ? "•  " : "";
    const text = bullet + tr(promptKey(n.ph));
    // wrap by characters within the box (prompts are short)
    const lines: string[] = [];
    let cur = "";
    for (const ch of text) {
      if (cur && o.measureText(cur + ch).width > w) (lines.push(cur), (cur = ""));
      cur += ch;
    }
    lines.push(cur);
    const lh = size * 1.1;
    const th = lines.length * lh;
    const anchor = n.ph.anchor;
    let ty = anchor === "ctr" ? y + (h - th) / 2 : anchor === "b" ? y + h - th : y;
    o.beginPath();
    o.rect(x, y, w, h);
    o.clip();
    for (const l of lines) {
      const lw = o.measureText(l).width;
      const lx = para?.align === "CENTER" ? x + (w - lw) / 2 : para?.align === "RIGHT" ? x + w - lw : x;
      o.fillText(l, lx, ty + size * 0.92);
      ty += lh;
    }
    o.restore();
  }
}

function topHit(p: Vec2): SceneNode | undefined {
  const tol = 5 / S().view.zoom;
  // design mode isolation (designTools.ts): only the isolated group's members can be picked
  const iso = isolationFilter();
  return nodesAt(p[0], p[1]).find((n) => (!iso || iso(n)) && hitNode(n, p, tol));
}

let previewCv: HTMLCanvasElement | null = null;
/** A scratch canvas for the selection-clipped brush preview (reused). */
function clipPreview(w: number, h: number): HTMLCanvasElement {
  previewCv ??= document.createElement("canvas");
  if (previewCv.width !== w) previewCv.width = w;
  if (previewCv.height !== h) previewCv.height = h;
  return previewCv;
}

/** Transparent page (image mode): the grey-white checkerboard of Photoshop under the pixels, 8 px squares on screen. */
let checkerPattern: { dpr: number; pat: CanvasPattern | null } | null = null;
function checker(c: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
  if (checkerPattern?.dpr === dpr) return checkerPattern.pat;
  const s = Math.max(1, Math.round(8 * dpr));
  const cv = document.createElement("canvas");
  cv.width = cv.height = s * 2;
  const g = cv.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, s * 2, s * 2);
  g.fillStyle = "#cccccc";
  g.fillRect(0, 0, s, s);
  g.fillRect(s, s, s, s);
  checkerPattern = { dpr, pat: c.createPattern(cv, "repeat") };
  return checkerPattern.pat;
}

export function CanvasView() {
  const wrap = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLCanvasElement>(null);
  const over = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  /** the path under the pointer with a path tool (outlined, Illustrator) */
  const hoverId = useRef<string | null>(null);
  const cursor = useRef<Vec2>([0, 0]);
  const spaceDown = useRef(false);
  const frame = useRef(0);
  const size = useRef({ w: 1, h: 1, dpr: 1 });
  const [editing, setEditing] = useState<TextNode | null>(null);
  const [cellEdit, setCellEdit] = useState<CellTarget | null>(null);
  const [spellMenu, setSpellMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const editingRef = useRef<TextNode | null>(null);
  editingRef.current = editing;

  const invalidate = () => {
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  };
  /** what the pen family (ui/pathCanvas.ts) borrows: view mapping, device pixels, repaint */
  const penv = (): PathEnv => ({ zoom: S().view.zoom, dpr: size.current.dpr, toScreen: pageToScreen, invalidate });
  // Ctrl+Z on a path being drawn (ui/shell/shortcuts.ts → undoDrawnPoint) repaints through this
  drawingHooks.repaint = invalidate;
  attachCanvas(invalidate);
  /** pen family: cursor and highlighted path for the pointer at page point p (also when Ctrl / Alt change) */
  const pathHover = (p: Vec2) => {
    const el = wrap.current;
    if (!el || spaceDown.current || !isPathTool(S().tool)) return;
    const want = pathCursor(p, penv());
    if (el.style.cursor !== want) el.style.cursor = want;
    const h = hoverPath(p, penv())?.id ?? null;
    if (h !== hoverId.current) {
      hoverId.current = h;
      invalidate();
    }
  };
  setInsideTest(pointInContours);

  // ───────── device-pixel fitting of the overlay (display only; docs/design/RENDER_CRISPNESS.md) ─────────
  /** hairline width (CSS px) covering whole device pixels: 1 device px at 100/125 %, 2 at 150/200 % */
  const hair = () => (crisp.snapUi ? hairCss(size.current.dpr) : 1);
  /** a hairline's centre coordinate (CSS px) on the device grid */
  const px = (v: number) => (crisp.snapUi ? snapStroke(v, size.current.dpr) : 0.5 + Math.round(v));
  const pxPt = (p: Vec2): Vec2 => [px(p[0]), px(p[1])];
  /** a filled + outlined handle square of about `s` CSS px centred on q, edges on device pixels */
  const handleSquare = (o: CanvasRenderingContext2D, q: Vec2, s = 9) => {
    const [x, y, z] = crisp.snapUi ? snapSquare(q[0], q[1], s, size.current.dpr) : [Math.round(q[0]) - 4, Math.round(q[1]) - 4, 9];
    const lw = hair();
    o.fillRect(x, y, z, z);
    o.lineWidth = lw;
    o.strokeRect(x + lw / 2, y + lw / 2, z - lw, z - lw);
  };

  // ───────── painting ─────────
  let lastStats = 0;
  let frames = 0;
  let fpsT = performance.now();
  function paint() {
    frame.current = 0;
    const s = S();
    const page = currentPage();
    const cm = main.current, co = over.current;
    if (!cm || !co || !page) return;
    const { w, h, dpr } = size.current;
    const c = cm.getContext("2d")!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    // the drawing screen: model space all around (no paper, no shadow), the page in model-space colours
    const ch = cadCanvas();
    c.fillStyle = ch ? ch.background() : workspaceColor();
    c.fillRect(0, 0, cm.width, cm.height);
    const { zoom, panX, panY } = s.view;
    if (ch) {
      const st = weave.render(c, s.doc, ch.displayPage(page, zoom), null, s.view, w, h, dpr, editingRef.current ? new Set([editingRef.current.id]) : null, invalidate, MODEL_SPACE);
      useStats.setState({ stats: st, fps: useStats.getState().fps });
      paintOverlay(co, page);
      return;
    }
    // page shadow
    c.save();
    c.shadowColor = "rgba(0,0,0,.45)";
    c.shadowBlur = 24 * dpr;
    c.shadowOffsetY = 6 * dpr;
    c.fillStyle = page.background;
    // page edges on whole device pixels (the tiles inside are blitted at the same rounding)
    const fx0 = Math.round(panX * dpr), fy0 = Math.round(panY * dpr);
    c.fillRect(fx0, fy0, Math.round((panX + page.width * zoom) * dpr) - fx0, Math.round((panY + page.height * zoom) * dpr) - fy0);
    c.restore();
    const mode = currentEditMode();
    // image mode: a transparent canvas shows Photoshop's checkerboard under the pixels
    if (mode === "IMAGE" && !isOpaqueColor(page.background)) {
      c.fillStyle = checker(c, dpr) ?? "#ffffff";
      c.fillRect(fx0, fy0, Math.round((panX + page.width * zoom) * dpr) - fx0, Math.round((panY + page.height * zoom) * dpr) - fy0);
    }
    // design mode outline view (Ctrl+Y): paths as hairlines, pictures and text as framed boxes, no paint
    if (mode === "DESIGN" && useDesign.getState().outline) {
      drawOutlineView(c, page, dpr);
      paintOverlay(co, page);
      return;
    }
    const exclude = editingRef.current ? new Set([editingRef.current.id]) : null;
    const st = weave.render(c, s.doc, page, renderMasterOf(s.doc, page), s.view, w, h, dpr, exclude, invalidate);
    // docView: the document mode shows the pages above and below (read-only) — Word's print layout
    if (docModeNow()) drawNeighbours(c, s.doc, page.id, s.view, h, dpr, (pg, v) => {
      weave.render(c, s.doc, pg, renderMasterOf(s.doc, pg), v, w, h, dpr, null, invalidate);
      drawSpelling(c, pg, v, dpr, invalidate);
      drawFormatMarks(c, s.doc, pg, v, dpr);
    });
    drawFidelity(c, page, masterOf(s.doc, page), s.view, dpr, invalidate);
    // spelling: red wavy lines under misspelled words (screen only; ui/spell.ts)
    drawSpelling(c, page, s.view, dpr, invalidate, editingRef.current?.id);
    // 문단 부호 (보기 › 문단 부호): ¶ at the end of each paragraph of the body
    drawFormatMarks(c, s.doc, page, s.view, dpr);
    frames++;
    const now = performance.now();
    if (now - lastStats > 300) {
      const fps = (frames * 1000) / (now - fpsT);
      useStats.setState({ stats: st, fps: Math.round(fps) });
      lastStats = now;
      frames = 0;
      fpsT = now;
    }
    paintOverlay(co, page);
  }

  /** Outline view (Ctrl+Y, design mode): every path as a 1-device-pixel line, other objects as framed boxes. */
  function drawOutlineView(c: CanvasRenderingContext2D, page: Page, dpr: number) {
    const { zoom, panX, panY } = S().view;
    c.save();
    c.strokeStyle = "#1d1f24";
    for (const n of page.nodes) {
      if (!n.visible) continue;
      const t = n.transform;
      const k = Math.max(1e-6, Math.abs(t.scale), Math.abs(t.scaleY ?? t.scale));
      c.setTransform(dpr * zoom, 0, 0, dpr * zoom, panX * dpr, panY * dpr);
      c.translate(t.x, t.y);
      c.rotate((t.rotation * Math.PI) / 180);
      c.scale(t.scale, t.scaleY ?? t.scale);
      c.lineWidth = hairCss(dpr) / (zoom * k);
      if (n.type === "VECTOR") c.stroke(vectorPath(n));
      else {
        const b = localBounds(n);
        c.strokeRect(b.x, b.y, b.w, b.h);
        if (n.type !== "TEXT" && n.type !== "TABLE") {
          c.beginPath();
          c.moveTo(b.x, b.y);
          c.lineTo(b.x + b.w, b.y + b.h);
          c.moveTo(b.x + b.w, b.y);
          c.lineTo(b.x, b.y + b.h);
          c.stroke();
        }
      }
    }
    c.restore();
  }

  /** Marching ants: the pixel selection's edges, black and white dashes moving every 120 ms. */
  function drawAnts(o: CanvasRenderingContext2D) {
    const st = usePixelSel.getState();
    if (!st.mask || st.pageId !== S().pageId) return;
    const segs = st.outline;
    const path = new Path2D();
    if (segs) {
      for (let i = 0; i < segs.length; i += 4) {
        const a = pageToScreen([segs[i], segs[i + 1]]), b = pageToScreen([segs[i + 2], segs[i + 3]]);
        path.moveTo(px(a[0]), px(a[1]));
        path.lineTo(px(b[0]), px(b[1]));
      }
    } else if (st.bounds) {
      const a = pxPt(pageToScreen([st.bounds.x, st.bounds.y])), b = pxPt(pageToScreen([st.bounds.x + st.bounds.w, st.bounds.y + st.bounds.h]));
      path.rect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }
    o.save();
    o.lineWidth = hair();
    o.strokeStyle = "#ffffff";
    o.stroke(path);
    o.strokeStyle = "#000000";
    o.setLineDash([4, 4]);
    o.lineDashOffset = -antsPhase.current;
    o.stroke(path);
    o.restore();
  }
  const antsPhase = useRef(0);

  function paintOverlay(co: HTMLCanvasElement, page: Page) {
    const s = S();
    const { dpr } = size.current;
    const o = co.getContext("2d")!;
    o.setTransform(1, 0, 0, 1, 0, 0);
    o.clearRect(0, 0, co.width, co.height);
    o.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { zoom, panX, panY } = s.view;
    const d = drag.current;
    const ch = cadCanvas();
    if (ch) {
      ch.overlay(o, page, { w: size.current.w, h: size.current.h, dpr });
      return;
    }

    drawGridAndGuides(o, page);
    // empty slide placeholders: their box and prompt (screen only; core/slides.ts)
    if (page.kind === "SLIDE") drawPrompts(o, page, s.editingTextId);

    // live brush stroke
    if (d?.kind === "stroke") {
      const n = d.stroke.node;
      o.save();
      o.translate(panX, panY);
      o.scale(zoom, zoom);
      o.translate(n.transform.x, n.transform.y);
      o.rotate((n.transform.rotation * Math.PI) / 180);
      o.scale(n.transform.scale, n.transform.scaleY ?? n.transform.scale);
      o.globalAlpha = d.stroke.erase ? 0.35 : s.brush.opacity;
      const m = activeMask();
      if (m) {
        // image mode: the live stroke shows only inside the selection (as it will be committed)
        const tmp = clipPreview(d.stroke.mask.width, d.stroke.mask.height);
        const g = tmp.getContext("2d")!;
        g.globalCompositeOperation = "copy";
        g.drawImage(d.stroke.mask, 0, 0);
        g.globalCompositeOperation = "source-over";
        clipToSelection(tmp, n.transform);
        o.drawImage(tmp, 0, 0);
      } else o.drawImage(d.stroke.mask, 0, 0);
      o.restore();
    }

    // selection
    const typingBody = flowActive();
    // pen family / direct selection: selected paths show their outline, points and handles instead of a box
    const pathMode = isPathTool(effectiveTool()) || isPathTool(s.tool);
    for (const n of page.nodes) {
      if (typingBody || !s.selection.includes(n.id)) continue;
      if (pathMode && n.type === "VECTOR") {
        drawPathEdit(o, n, penv());
        continue;
      }
      o.lineWidth = crisp.snapUi ? hair() : 1.25;
      const pts = cornersOf(n).map((p) => pxPt(pageToScreen(p)));
      o.strokeStyle = ACCENT;
      o.beginPath();
      pts.forEach((p, i) => (i ? o.lineTo(p[0], p[1]) : o.moveTo(p[0], p[1])));
      o.closePath();
      o.stroke();
      if (n.type === "TABLE") drawCellRange(o, n);
    }
    if (useCrop.getState().id) drawCrop(o);
    else if (s.tool === "select" && !editingRef.current && !typingBody) drawTransformBox(o, page);
    drawAnts(o);
    // isolation mode (design): everything outside the isolated group is dimmed
    if (useDesign.getState().isolated) {
      const iso = isolationFilter()!;
      o.save();
      o.fillStyle = "rgba(255,255,255,.55)";
      for (const n of page.nodes) {
        if (!n.visible || iso(n)) continue;
        const pts = cornersOf(n).map(pageToScreen);
        o.beginPath();
        pts.forEach((q, i) => (i ? o.lineTo(q[0], q[1]) : o.moveTo(q[0], q[1])));
        o.closePath();
        o.fill();
      }
      o.restore();
    }
    // pixel marquee / lasso in progress
    if (d?.kind === "pixmarquee") {
      const a = pxPt(pageToScreen(d.start)), b = pxPt(pageToScreen(d.cur));
      o.save();
      o.lineWidth = hair();
      o.strokeStyle = "#fff";
      const ell = usePixelSel.getState().marquee === "ellipse";
      const path = new Path2D();
      if (ell) path.ellipse((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, Math.abs(b[0] - a[0]) / 2, Math.abs(b[1] - a[1]) / 2, 0, 0, Math.PI * 2);
      else path.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      o.stroke(path);
      o.setLineDash([4, 4]);
      o.strokeStyle = "#000";
      o.stroke(path);
      o.restore();
      const r = rectFromPoints([d.start, d.cur]);
      tag(o, `${Math.round(r.w)} × ${Math.round(r.h)} px`, Math.max(a[0], b[0]) + 10, Math.max(a[1], b[1]) + 18);
    }
    if (d?.kind === "lasso" && d.pts.length > 1) {
      o.save();
      o.lineWidth = hair();
      o.beginPath();
      d.pts.forEach((q, i) => {
        const sq = pageToScreen(q);
        if (i) o.lineTo(sq[0], sq[1]);
        else o.moveTo(sq[0], sq[1]);
      });
      o.strokeStyle = "#fff";
      o.stroke();
      o.setLineDash([4, 4]);
      o.strokeStyle = "#000";
      o.stroke();
      o.restore();
    }
    if (d?.kind === "gradient" || d?.kind === "line") {
      const a = pageToScreen(d.a), b = pageToScreen(d.b);
      o.save();
      o.lineWidth = d.kind === "line" ? Math.max(1, Math.min(40, 2 * zoom)) : 1.5;
      o.strokeStyle = d.kind === "line" ? s.stroke : "#fff";
      o.beginPath();
      o.moveTo(a[0], a[1]);
      o.lineTo(b[0], b[1]);
      o.stroke();
      if (d.kind === "gradient") {
        o.strokeStyle = "#000";
        o.lineWidth = hair();
        o.stroke();
        for (const q of [a, b]) {
          o.fillStyle = q === a ? s.brush.color : usePixelSel.getState().bg;
          o.strokeStyle = "#fff";
          handleSquare(o, q, 9);
        }
      }
      o.restore();
    }

    // marquee
    if (d?.kind === "marquee") {
      const a = pxPt(pageToScreen(d.start)), b = pxPt(pageToScreen(d.cur));
      o.lineWidth = hair();
      o.fillStyle = "rgba(43,116,236,.12)";
      o.strokeStyle = ACCENT;
      o.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
      o.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]));
    }
    // shape preview
    if (d?.kind === "shape") {
      const r = shapeRect(d.start, d.cur);
      const a = pageToScreen([r.x, r.y]);
      o.strokeStyle = ACCENT;
      o.lineWidth = hair();
      o.fillStyle = s.fill + "55";
      o.beginPath();
      if (d.shape === "rect") {
        const p0 = pxPt(a), p1 = pxPt([a[0] + r.w * zoom, a[1] + r.h * zoom]);
        o.rect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
      }
      else o.ellipse(a[0] + (r.w * zoom) / 2, a[1] + (r.h * zoom) / 2, (r.w * zoom) / 2, (r.h * zoom) / 2, 0, 0, Math.PI * 2);
      o.fill();
      o.stroke();
    }
    // pen family: the path being drawn, the anchor marquee, the path under the pointer (ui/pathCanvas.ts)
    if (isPathTool(s.tool)) {
      const hp = hoverId.current ? page.nodes.find((x) => x.id === hoverId.current) : undefined;
      if (hp?.type === "VECTOR" && !s.selection.includes(hp.id)) drawPathHover(o, hp, penv());
      drawPathTool(o, d?.kind === "path" ? d.d : null, cursor.current, penv());
    }
    drawSmart(o);
    // brush cursor
    if ((s.tool === "brush" || s.tool === "eraser") && !spaceDown.current) {
      const c = pageToScreen(cursor.current);
      o.strokeStyle = "rgba(255,255,255,.9)";
      o.beginPath();
      o.arc(c[0], c[1], Math.max(1, (s.brush.size / 2) * zoom), 0, Math.PI * 2);
      o.stroke();
      o.strokeStyle = "rgba(0,0,0,.6)";
      o.beginPath();
      o.arc(c[0], c[1], Math.max(1, (s.brush.size / 2) * zoom) + 1, 0, Math.PI * 2);
      o.stroke();
    }
  }

  /** Crop session: dim what will be hidden, rule-of-thirds lines and 8 handles on the crop box. */
  function drawCrop(o: CanvasRenderingContext2D) {
    const tf = cropFrame();
    const { rect, full } = useCrop.getState();
    if (!tf || !rect || !full) return;
    const n = { transform: tf };
    const poly = (r: Rect) => [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]].map((q) => pageToScreen(applyTransform(n.transform, q as Vec2)));
    // canvas crop: everything outside the box is dimmed (the box may reach past the page)
    const B = 1e5;
    const outer = isCanvasCrop() ? ([[-B, -B], [B, -B], [B, B], [-B, B]] as Vec2[]) : poly(full), inner = poly(rect);
    o.save();
    o.beginPath();
    for (const pts of [outer, inner]) pts.forEach((q, i) => (i ? o.lineTo(q[0], q[1]) : o.moveTo(q[0], q[1])));
    o.fillStyle = "rgba(10,12,18,.6)";
    o.fill("evenodd");
    o.strokeStyle = "rgba(255,255,255,.55)";
    o.lineWidth = hair();
    o.beginPath();
    for (const f of [1 / 3, 2 / 3]) {
      const a = pageToScreen(applyTransform(n.transform, [rect.x + rect.w * f, rect.y])), b = pageToScreen(applyTransform(n.transform, [rect.x + rect.w * f, rect.y + rect.h]));
      o.moveTo(px(a[0]), px(a[1]));
      o.lineTo(px(b[0]), px(b[1]));
      const c = pageToScreen(applyTransform(n.transform, [rect.x, rect.y + rect.h * f])), e = pageToScreen(applyTransform(n.transform, [rect.x + rect.w, rect.y + rect.h * f]));
      o.moveTo(px(c[0]), px(c[1]));
      o.lineTo(px(e[0]), px(e[1]));
    }
    o.stroke();
    o.strokeStyle = "#fff";
    o.lineWidth = 1.5;
    o.beginPath();
    inner.forEach((q, i) => (i ? o.lineTo(q[0], q[1]) : o.moveTo(q[0], q[1])));
    o.closePath();
    o.stroke();
    o.fillStyle = "#fff";
    o.strokeStyle = ACCENT;
    o.lineWidth = 1;
    for (const h of [...CORNERS, ...EDGES]) {
      const q = pageToScreen(handlePoint({ t: n.transform, lb: rect }, h));
      handleSquare(o, q);
    }
    const sz = boxSize({ t: n.transform, lb: rect });
    tag(o, `${fmtGuide(sz.w, currentPage())} × ${fmtGuide(sz.h, currentPage())}`, inner[0][0], inner[0][1] - 6, ACCENT);
    o.restore();
  }

  /** Free-transform box: 8 handles (4 on several objects), live size / angle readout. */
  function drawTransformBox(o: CanvasRenderingContext2D, page: Page) {
    const s = S();
    const sb = selectionBox(page, s.selection);
    if (!sb) return;
    const zoom = s.view.zoom;
    const pts = CORNERS.map((h) => pxPt(pageToScreen(handlePoint(sb.box, h))));
    o.lineWidth = hair();
    o.strokeStyle = ACCENT;
    if (sb.multi) {
      o.setLineDash([4, 3]);
      o.beginPath();
      pts.forEach((q, i) => (i ? o.lineTo(q[0], q[1]) : o.moveTo(q[0], q[1])));
      o.closePath();
      o.stroke();
      o.setLineDash([]);
    }
    const size = boxSize(sb.box);
    const showEdges = !sb.multi && Math.min(size.w, size.h) * zoom > HANDLE_PX * 4;
    const hs = [...CORNERS, ...(showEdges ? EDGES : [])];
    o.fillStyle = "#fff";
    for (const h of hs) {
      const q = pageToScreen(handlePoint(sb.box, h));
      handleSquare(o, q);
    }
    const ro = useXform.getState().readout;
    if (ro && drag.current?.kind === "xform") {
      const c = cursor.current;
      const q = pageToScreen(c);
      tag(o, ro, q[0] + 14, q[1] + 28, ACCENT);
    }
  }

  /** Grid (inside the page), the page's guides, its master's guides (dashed) and a guide being dragged. */
  /** The picked cell (range) of a selected table: the cells 셀 합치기 / 셀 나누기 act on. */
  function drawCellRange(o: CanvasRenderingContext2D, n: TableNode) {
    const cs = useCellSel.getState();
    if (cs.target?.nodeId !== n.id) return;
    const a = cs.target, b = cs.end ?? cs.target;
    if (Math.max(a.row, b.row) >= n.rows.length || Math.max(a.col, b.col) >= n.colWidths.length) return;
    const g = expandRange(n.rows, { r0: a.row, c0: a.col, r1: b.row, c1: b.col });
    const l = layoutTable(n);
    const q = cellRect(l, g.r0, g.c0, g.r1 - g.r0 + 1, g.c1 - g.c0 + 1);
    const pts = ([[q.x, q.y], [q.x + q.w, q.y], [q.x + q.w, q.y + q.h], [q.x, q.y + q.h]] as Vec2[]).map((pt) => pageToScreen(applyTransform(n.transform, pt)));
    o.save();
    o.fillStyle = "rgba(43,116,236,.14)";
    o.strokeStyle = ACCENT;
    o.lineWidth = 2;
    o.beginPath();
    pts.forEach((pt, i) => (i ? o.lineTo(pt[0], pt[1]) : o.moveTo(pt[0], pt[1])));
    o.closePath();
    o.fill();
    o.stroke();
    o.restore();
  }

  function drawGridAndGuides(o: CanvasRenderingContext2D, page: Page) {
    const ui = useUI.getState();
    const { zoom, panX, panY } = S().view;
    const { w, h } = size.current;
    // the body area of a document page (쪽 설정 margins), shown with the guides like a word processor's margin marks
    // (the document mode hides them like Word until 보기 > 텍스트 경계 is on)
    if (ui.guides && page.kind === "DOCUMENT" && (!docModeNow() || useDocView.getState().textBounds)) {
      const b = bodyBox(page);
      o.save();
      o.setLineDash([3, 4]);
      o.lineWidth = hair();
      o.strokeStyle = "rgba(120,130,160,.45)";
      const x0 = px(b.x * zoom + panX), y0 = px(b.y * zoom + panY);
      o.strokeRect(x0, y0, px((b.x + b.w) * zoom + panX) - x0, px((b.y + b.h) * zoom + panY) - y0);
      o.restore();
    }
    const px0 = Math.max(0, panX), py0 = Math.max(0, panY);
    const px1 = Math.min(w, panX + page.width * zoom), py1 = Math.min(h, panY + page.height * zoom);
    if (ui.grid && px1 > px0 && py1 > py0) {
      const vis = visibleGridStep(gridFor(page), zoom);
      if (vis) {
        const minor = new Path2D(), major = new Path2D();
        const ix0 = Math.ceil((px0 - panX) / zoom / vis.step), ix1 = Math.floor((px1 - panX) / zoom / vis.step);
        const iy0 = Math.ceil((py0 - panY) / zoom / vis.step), iy1 = Math.floor((py1 - panY) / zoom / vis.step);
        if (ix1 - ix0 < 2000 && iy1 - iy0 < 2000) {
          for (let i = ix0; i <= ix1; i++) {
            const x = px(i * vis.step * zoom + panX);
            const path = i % vis.every === 0 ? major : minor;
            path.moveTo(x, py0);
            path.lineTo(x, py1);
          }
          for (let i = iy0; i <= iy1; i++) {
            const y = px(i * vis.step * zoom + panY);
            const path = i % vis.every === 0 ? major : minor;
            path.moveTo(px0, y);
            path.lineTo(px1, y);
          }
          o.lineWidth = hair();
          o.strokeStyle = "rgba(120,130,160,.18)";
          o.stroke(minor);
          o.strokeStyle = "rgba(120,130,160,.42)";
          o.stroke(major);
        }
      }
    }
    const gd = A().guideDrag;
    if (ui.guides) {
      const g = visibleGuides(page);
      const line = (axis: GuideAxis, v: number) => {
        o.beginPath();
        if (axis === "x") {
          const x = px(v * zoom + panX);
          o.moveTo(x, 0);
          o.lineTo(x, h);
        } else {
          const y = px(v * zoom + panY);
          o.moveTo(0, y);
          o.lineTo(w, y);
        }
        o.stroke();
      };
      o.lineWidth = hair();
      o.globalAlpha = ui.guidesLocked ? 0.5 : 0.9;
      o.strokeStyle = GUIDE;
      o.setLineDash([6, 4]);
      for (const v of g.master.x ?? []) line("x", v);
      for (const v of g.master.y ?? []) line("y", v);
      o.setLineDash([]);
      for (const v of g.own.x ?? []) line("x", v);
      for (const v of g.own.y ?? []) line("y", v);
      o.globalAlpha = 1;
    }
    if (gd) {
      o.lineWidth = hair();
      o.strokeStyle = gd.overRuler ? "rgba(255,90,90,.9)" : GUIDE;
      o.setLineDash(gd.overRuler ? [3, 3] : []);
      o.beginPath();
      if (gd.axis === "x") {
        const x = px(gd.v * zoom + panX);
        o.moveTo(x, 0);
        o.lineTo(x, h);
      } else {
        const y = px(gd.v * zoom + panY);
        o.moveTo(0, y);
        o.lineTo(w, y);
      }
      o.stroke();
      o.setLineDash([]);
      // position label next to the pointer
      const label = gd.overRuler ? (gd.from == null ? tr("shell.cancel") : tr("cmd.edit.delete")) : fmtGuide(gd.v, page);
      const cur = A().cursor;
      const lx = gd.axis === "x" ? gd.v * zoom + panX + 6 : Math.max(RULER + 4, (cur?.[0] ?? 0) * zoom + panX + 10);
      const ly = gd.axis === "y" ? gd.v * zoom + panY - 6 : Math.max(RULER + 16, (cur?.[1] ?? 0) * zoom + panY + 18);
      tag(o, label, lx, ly);
    }
  }

  /** Smart guides: pink alignment lines and equal-spacing markers while snapping. */
  function drawSmart(o: CanvasRenderingContext2D) {
    const sm = A().smart;
    if (!sm) return;
    o.save();
    o.strokeStyle = SMART;
    o.fillStyle = SMART;
    o.lineWidth = hair();
    for (const g of sm.segs) {
      const a = pageToScreen([g.x0, g.y0]), b = pageToScreen([g.x1, g.y1]);
      o.beginPath();
      o.moveTo(px(a[0]), px(a[1]));
      o.lineTo(px(b[0]), px(b[1]));
      o.stroke();
      for (const q of [a, b]) {
        o.beginPath();
        o.moveTo(q[0] - 3, q[1] - 3);
        o.lineTo(q[0] + 3, q[1] + 3);
        o.moveTo(q[0] + 3, q[1] - 3);
        o.lineTo(q[0] - 3, q[1] + 3);
        o.stroke();
      }
    }
    for (const g of sm.gaps) {
      const a = pageToScreen(g.axis === "x" ? [g.a, g.at] : [g.at, g.a]);
      const b = pageToScreen(g.axis === "x" ? [g.b, g.at] : [g.at, g.b]);
      o.beginPath();
      o.moveTo(a[0], a[1]);
      o.lineTo(b[0], b[1]);
      if (g.axis === "x") {
        o.moveTo(a[0], a[1] - 4);
        o.lineTo(a[0], a[1] + 4);
        o.moveTo(b[0], b[1] - 4);
        o.lineTo(b[0], b[1] + 4);
      } else {
        o.moveTo(a[0] - 4, a[1]);
        o.lineTo(a[0] + 4, a[1]);
        o.moveTo(b[0] - 4, b[1]);
        o.lineTo(b[0] + 4, b[1]);
      }
      o.stroke();
    }
    const g0 = sm.gaps[0];
    if (g0) {
      const m = pageToScreen(g0.axis === "x" ? [(g0.a + g0.b) / 2, g0.at] : [g0.at, (g0.a + g0.b) / 2]);
      tag(o, fmtGuide(Math.abs(g0.b - g0.a), currentPage()), m[0] - 14, m[1] - 8, SMART);
    }
    o.restore();
  }

  function tag(o: CanvasRenderingContext2D, text: string, x: number, y: number, bg = "#1b1d22") {
    o.save();
    // on-canvas measurement tag: caption size (12px) × UI scale, like the rest of the chrome
    const k = uiScaleFactor(useUI.getState().uiScale);
    o.font = `${12 * k}px Pretendard, sans-serif`;
    const w = o.measureText(text).width + 8 * k;
    o.fillStyle = bg;
    o.globalAlpha = 0.92;
    o.fillRect(x, y - 13 * k, w, 18 * k);
    o.globalAlpha = 1;
    o.fillStyle = "#fff";
    o.textBaseline = "middle";
    o.fillText(text, x + 4 * k, y - 4 * k);
    o.restore();
  }



  /** Cursor over transform handles (resize along the object's axes / rotate) and movable guides. */
  function hoverCursor(p: Vec2) {
    const el = wrap.current;
    const page = currentPage();
    if (!el || !page || spaceDown.current) return;
    const s = S();
    let want = "";
    const cf = useCrop.getState().id ? cropFrame() : null;
    if (cf) {
      const rect = useCrop.getState().rect!;
      const box = { t: cf, lb: rect };
      const pk = pickHandle(box, p, HANDLE_PX / s.view.zoom, isCanvasCrop() ? { rotateReach: ROTATE_PX / s.view.zoom } : { rotate: false });
      want = pk?.kind === "handle" ? handleCursor(pk.handle, cf.rotation) : pk?.kind === "rotate" ? ROTATE_CURSOR : !useCrop.getState().drawn || !insideBox(box, p) ? "crosshair" : "move";
      if (el.style.cursor !== want) el.style.cursor = want;
      return;
    }
    const sb = selectionBox(page, s.selection);
    const pick = sb ? pickHandle(sb.box, p, HANDLE_PX / s.view.zoom, { edges: !sb.multi, rotateReach: ROTATE_PX / s.view.zoom }) : null;
    if (pick?.kind === "handle") want = handleCursor(pick.handle, sb!.box.t.rotation);
    else if (pick?.kind === "rotate" && pointerTarget(pick, topHit(p)?.id ?? null, s.selection, false) === "rotate") want = ROTATE_CURSOR;
    else {
      const g = canEditGuides() && page.guides ? hitGuide(page.guides, p[0], p[1], GUIDE_HIT_PX / s.view.zoom) : null;
      if (g) want = g.axis === "x" ? "col-resize" : "row-resize";
    }
    if (!want && bodyAt(page, p)) want = "text";
    if (!want) want = toolCursor(s.tool);
    if (el.style.cursor !== want) el.style.cursor = want;
  }

  /**
   * A point of a flowing document page where a press puts the caret (not on a free object or a table). Only in the
   * 문서 edit mode: in 디자인 · 이미지 · 슬라이드 the body is one text box to select and move (EDIT_MODES.md 6).
   */
  function bodyAt(page: Page, p: Vec2): boolean {
    if (page.kind !== "DOCUMENT" || currentEditMode() !== "DOCUMENT" || !isFlowPage(page)) return false;
    const hit = topHit(p);
    return !hit || (hit.type === "TEXT" && !!hit.flow);
  }

  /** Is page point `p` on the frame of text box `n` (within a few screen pixels of its edge)? */
  function onFrame(n: SceneNode, p: Vec2): boolean {
    const lb = localBounds(n);
    const q = invertTransform(n.transform, p);
    const k = Math.abs(n.transform.scale) || 1;
    const d = Math.min(q[0] - lb.x, lb.x + lb.w - q[0], q[1] - lb.y, lb.y + lb.h - q[1]);
    return d <= FRAME_PX / (useStore.getState().view.zoom * k);
  }

  function shapeRect(a: Vec2, b: Vec2): Rect {
    let w = b[0] - a[0], h = b[1] - a[1];
    if (shiftDown.current) {
      const m = Math.max(Math.abs(w), Math.abs(h));
      w = Math.sign(w || 1) * m;
      h = Math.sign(h || 1) * m;
    }
    return rectFromPoints([a, [a[0] + w, a[1] + h]]);
  }
  const shiftDown = useRef(false);
  // click count of a press: Chromium (Edge, WebView2) gives pointerdown a detail of 0, so a double-click is counted
  // here from the press time and place (core/clickCount.ts) for what only the press decides (isolation, guides)
  const presses = useRef<PressCount>({ t: -1e9, x: 0, y: 0, n: 0 });

  // ───────── setup ─────────
  useEffect(() => {
    // The canvases fill the wrap (.layer, inset 0). Their backing stores take the device-pixel size the
    // browser actually displays them at (devicePixelContentBoxSize, pixel-snapped), so one canvas pixel
    // is exactly one screen pixel at 125 % / 150 % scaling too; Math.round(clientWidth × dpr) could be a
    // pixel off and the whole canvas was then resampled (blurred) by the compositor.
    // docs/design/RENDER_CRISPNESS.md
    let seen = false;
    const ro = new ResizeObserver((entries) => {
      const el = wrap.current!;
      const dpr = window.devicePixelRatio || 1;
      const e = entries.find((x) => x.target === main.current);
      const box = crisp.backing ? e?.devicePixelContentBoxSize?.[0] : undefined;
      const w = e ? e.contentRect.width : el.clientWidth, h = e ? e.contentRect.height : el.clientHeight;
      const pw = box ? box.inlineSize : Math.round(w * dpr), ph = box ? box.blockSize : Math.round(h * dpr);
      // paint at the pixels the backing store really has: in a page the browser scales (phones and tablets lay the
      // editor out 1024 px wide and zoom it to the screen, index.html) the device box is w × dpr × that zoom, not
      // w × dpr — painting at devicePixelRatio there drew the page 1/zoom times too big, so only its top-left corner
      // showed and nothing seemed to respond (2026-11-22, Android Chrome)
      size.current = { w, h, dpr: box && w > 0 ? pw / w : dpr };
      for (const cv of [main.current!, over.current!]) {
        if (cv.width !== pw) cv.width = pw;
        if (cv.height !== ph) cv.height = ph;
      }
      const before = viewportNow();
      setViewportSize(w, h);
      if (viewIsFitted()) fitCurrent();
      // zoomed in by hand: the window's centre stays put (image / design; the document mode scrolls its own way)
      else if (seen && before.w > 1 && before.h > 1 && w > 1 && h > 1 && (before.w !== w || before.h !== h) && followsCanvas(currentEditMode()))
        S().set({ view: keepCentre(S().view, w - before.w, h - before.h) });
      seen = w > 1 && h > 1;
      invalidate();
    });
    try {
      ro.observe(main.current!, { box: "device-pixel-content-box" });
    } catch {
      ro.observe(main.current!);
    }
    const unsub = useStore.subscribe(invalidate);
    const unsubAids = useAids.subscribe((a, b) => (a.guideDrag !== b.guideDrag || a.smart !== b.smart) && invalidate());
    const unsubCrop = useCrop.subscribe(invalidate);
    const unsubCells = useCellSel.subscribe(invalidate);
    const unsubUi = useUI.subscribe((a, b) => (a.grid !== b.grid || a.guides !== b.guides || a.guidesLocked !== b.guidesLocked || a.grids !== b.grids) && invalidate());
    setTimeout(fitCurrent, 50);
    const unfollow = followCanvasSize();
    return () => {
      ro.disconnect();
      unfollow();
      unsub();
      unsubAids();
      unsubUi();
      unsubCrop();
      unsubCells();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(invalidate, [editing]);

  // pixel selection (image) and design-mode view state repaint; the marching ants move every 120 ms
  useEffect(() => {
    const unsubSel = usePixelSel.subscribe(invalidate);
    const unsubDesign = useDesign.subscribe(invalidate);
    const unsubAnchors = useAnchors.subscribe(invalidate);
    const timer = setInterval(() => {
      if (!activeMask() || document.visibilityState !== "visible" || frame.current) return;
      antsPhase.current = (antsPhase.current + 1) % 8;
      const page = currentPage();
      if (page && over.current) paintOverlay(over.current, page);
    }, 120);
    return () => {
      unsubSel();
      unsubDesign();
      unsubAnchors();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 머리말/꼬리말 편집 from the menus (ui/headerFooterActions.ts): edit the current page's header / footer in place
  const startHfRef = useRef<(page: Page, y: number | "header" | "footer") => boolean>(() => false);
  useEffect(() => {
    const on = (e: Event) => {
      const area = (e as CustomEvent<{ area: "header" | "footer" }>).detail?.area ?? "header";
      const page = currentPage();
      if (!page || editingRef.current) return;
      startHfRef.current(page, area);
    };
    window.addEventListener(HF_EDIT_EVENT, on);
    return () => window.removeEventListener(HF_EDIT_EVENT, on);
  }, []);

  // 각주 / 미주 넣기 (ui/docFlow.ts insertNote): the new note's text is typed in its note area, edited like a text box
  const startNoteRef = useRef<(id: string, para?: string) => void>(() => {});
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ id: string; para?: string }>).detail;
      if (d?.id && !editingRef.current) startNoteRef.current(d.id, d.para);
    };
    window.addEventListener(NOTE_EDIT_EVENT, on);
    return () => window.removeEventListener(NOTE_EDIT_EVENT, on);
  }, []);

  // keyboard (space-pan, pen finish, nudge)
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      shiftDown.current = e.shiftKey;
      if ((e.target as HTMLElement)?.closest?.("input,textarea,select,[contenteditable]")) return;
      if (e.code === "Space" && !spaceDown.current && !cadCanvas()) {
        spaceDown.current = true;
        wrap.current!.style.cursor = "grab";
        e.preventDefault();
      }
      // pen family: Ctrl / Alt switch the tool while held (cursor follows at once); Enter / Esc end the path being drawn
      if (e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
        mods.ctrl = e.ctrlKey || e.metaKey;
        mods.alt = e.altKey;
        if (isPathTool(S().tool)) {
          if (e.key === "Alt") e.preventDefault();
          pathHover(cursor.current);
          invalidate();
        }
      }
      // Esc while dragging points / handles / a segment / the point marquee: the drag is dropped, the path stays as it was
      const pd = drag.current?.kind === "path" ? drag.current.d : null;
      if (e.key === "Escape" && pd && pd.kind !== "pen-drag") {
        drag.current = null;
        if (pd.kind !== "amarquee") S().cancelGesture();
        invalidate();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Esc while moving / rotating / resizing (also inside a Ctrl+T session), dragging a guide or the crop box: the
      // drag is dropped — everything goes back to how it was at the press and no history step is left (the free
      // transform and crop sessions themselves stay open; a second Esc ends them)
      const dd = drag.current;
      if (e.key === "Escape" && dd && (dd.kind === "move" || dd.kind === "xform" || dd.kind === "guide" || dd.kind === "crop" || dd.kind === "cropNew" || dd.kind === "cropRotate")) {
        drag.current = null;
        if (dd.kind === "crop" || dd.kind === "cropNew") useCrop.getState().set({ rect: dd.rect0 });
        else if (dd.kind === "cropRotate") setCropAngle(dd.angle0);
        else S().cancelGesture();
        if (dd.kind === "xform") useXform.getState().set({ readout: null });
        if (dd.kind === "guide") A().set({ guideDrag: null });
        if (A().smart) A().set({ smart: null });
        wrap.current!.style.cursor = spaceDown.current ? "grab" : toolCursor(S().tool);
        invalidate();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Delete / Backspace in the middle of a drag would commit inside the open gesture: it waits for the release
      if ((e.key === "Delete" || e.key === "Backspace") && dd && dd.kind !== "pan" && dd.kind !== "flow") {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (isDrawing() && (e.key === "Enter" || e.key === "Escape")) {
        // Esc keeps what was drawn (Illustrator); a lone first point goes
        finishDrawing(false);
        invalidate();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      const arrows: Record<string, Vec2> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[e.key] && isPathTool(S().tool) && selectedAnchors().length && !S().gestureBase) {
        const k = e.shiftKey ? 10 : 1;
        nudgeAnchors(arrows[e.key][0] * k, arrows[e.key][1] * k);
        e.preventDefault();
        return;
      }
      if (arrows[e.key] && S().selection.length && !S().gestureBase) {
        const k = e.shiftKey ? 10 : 1;
        const [dx, dy] = arrows[e.key];
        const ids = S().selection;
        S().commit(tr("shell.hist.move"), (d) => {
          draftPage(d, S().pageId)?.nodes.forEach((n) => {
            if (ids.includes(n.id) && !n.locked) {
              n.transform.x += dx * k;
              n.transform.y += dy * k;
            }
          });
        });
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      shiftDown.current = e.shiftKey;
      if (e.key === "Control" || e.key === "Alt" || e.key === "Meta") {
        mods.ctrl = e.ctrlKey || e.metaKey;
        mods.alt = e.altKey;
        if (isPathTool(S().tool)) {
          pathHover(cursor.current);
          invalidate();
        }
      }
      if (e.code === "Space") {
        spaceDown.current = false;
        wrap.current!.style.cursor = toolCursor(S().tool);
      }
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a pen path in progress ends when the tool changes (also when an edit mode without the pen takes over,
  // ui/editModes.ts followMode) and is dropped when the page changes — it never lands on another page later
  useEffect(
    () =>
      useStore.subscribe((s, p) => {
        if (s.tool !== p.tool) hoverId.current = null;
        if (!isDrawing()) return;
        if (s.pageId !== p.pageId) {
          cancelDrawing();
          invalidate();
        } else if (s.tool !== p.tool) finishDrawing(false);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // wheel zoom/pan (non-passive)
  useEffect(() => {
    const el = wrap.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      const v = S().view;
      if (!e.ctrlKey && !e.metaKey && cadCanvas()?.wheel(e, sx, sy)) return;
      if (e.ctrlKey || e.metaKey) {
        const f = Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0018));
        const zoom = Math.min(32, Math.max(0.02, v.zoom * f));
        const k = zoom / v.zoom;
        S().set({ view: { zoom, panX: sx - (sx - v.panX) * k, panY: sy - (sy - v.panY) * k } });
      } else {
        const dx = e.shiftKey ? e.deltaY : e.deltaX, dy = e.shiftKey ? 0 : e.deltaY;
        // docView: in the document mode the wheel scrolls through the pages
        if (docModeNow()) docWheel(dx, dy, el.clientWidth, el.clientHeight);
        else S().set({ view: { ...v, panX: v.panX - dx, panY: v.panY - dy } });
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // paste images, or objects copied on the canvas (Ctrl+V; see menuActions); copy / cut mark the system clipboard
  useEffect(() => {
    const canvasKeys = (e: Event) => {
      const s = S();
      return !isTyping(e.target) && !s.editingTextId && !s.presenting && !useCrop.getState().id && !document.querySelector('[aria-modal="true"]');
    };
    const onCopy = (e: ClipboardEvent) => void (canvasKeys(e) && writeClipboardMarker(e));
    const onPaste = async (e: ClipboardEvent) => {
      const ours = pasteIsOurs(e); // also tells a pending keyboard paste that the event came
      if ((e.target as HTMLElement)?.closest?.("input,textarea")) return;
      if (canvasKeys(e) && ours) {
        e.preventDefault();
        pasteClipboard();
        return;
      }
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) await placeImage(new Uint8Array(await f.arrayBuffer()), f.type, tr("shell.name.pastedImage"));
        }
      }
    };
    window.addEventListener("paste", onPaste);
    window.addEventListener("copy", onCopy);
    window.addEventListener("cut", onCopy);
    return () => {
      window.removeEventListener("paste", onPaste);
      window.removeEventListener("copy", onCopy);
      window.removeEventListener("cut", onCopy);
    };
  }, []);

  // ───────── pointer ─────────
  const local = (e: React.PointerEvent | PointerEvent): Vec2 => {
    const r = wrap.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };


  function startTextEdit(n: TextNode) {
    S().set({ selection: parseHfId(n.id) ? [] : [n.id], editingTextId: n.id });
    setEditing(n);
  }

  /** Edit the header (y in the top margin) or footer (bottom margin) of a document page in place; false elsewhere. */
  function startHfEdit(page: Page, y: number | "header" | "footer"): boolean {
    const area = typeof y === "string" ? y : hfAreaAt(page, y);
    const n = area && hfEditNode(S().doc, hfNodeId(page.id, area));
    if (!n) return false;
    startTextEdit(n);
    return true;
  }
  startHfRef.current = startHfEdit;
  startNoteRef.current = (id: string, para?: string) => {
    const pg = S().doc.pages.find((q) => q.nodes.some((n) => n.id === id));
    const n = pg?.nodes.find((x) => x.id === id);
    if (!pg || n?.type !== "TEXT") return;
    if (pg.id !== S().pageId) S().set({ pageId: pg.id });
    startTextEdit(n);
    // the caret at the end of the new note's paragraph (the editor draws one .rt-p per paragraph)
    const k = para ? n.paragraphs.findIndex((q) => q.id === para) : -1;
    if (k >= 0)
      setTimeout(() => {
        const el = document.querySelector(`.rich-editor .rt-p[data-pi="${k}"]`);
        const sel = window.getSelection();
        if (!el || !sel) return;
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }, 30);
  };

  function startCellEdit(n: SceneNode, p: Vec2) {
    if (n.type !== "TABLE") return;
    const lp = invertTransform(n.transform, p);
    const c = cellAt(n, lp[0], lp[1]);
    if (!c) return;
    S().set({ selection: [n.id] });
    setCellEdit({ nodeId: n.id, ...c });
  }

  // ───────── fingers (ui/touchNav.ts): one finger moves the view with the select / hand tool, two always zoom ─────────
  const touch = useRef(new TouchNav());
  const tapDown = useRef<React.PointerEvent | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const replaying = useRef(false);

  /** A finger went down: true when navigation takes it (the tool does not see it). */
  function touchDown(e: React.PointerEvent): boolean {
    if (e.pointerType !== "touch" || replaying.current) return false;
    const tn = touch.current;
    tn.down(e.pointerId, ...local(e));
    const tool = S().tool;
    if (tn.count === 1 && tool !== "select" && tool !== "hand" && !editingRef.current) return false; // the tool draws
    if (tn.count >= 2 && drag.current) {
      // a second finger: the stroke / drag the first one began is dropped, the fingers zoom instead
      drag.current = null;
      S().cancelGesture();
      invalidate();
    }
    tn.navigating = true;
    tapDown.current = tn.count === 1 ? e : null;
    wrap.current!.setPointerCapture(e.pointerId);
    return true;
  }

  function touchMove(e: React.PointerEvent): boolean {
    const tn = touch.current;
    if (e.pointerType !== "touch" || !tn.has(e.pointerId)) return false;
    const st = tn.move(e.pointerId, ...local(e));
    if (!tn.navigating || !st) return false;
    if (tn.travel < 8 && tn.count === 1) return true; // still a tap
    const v = S().view;
    const el = wrap.current!;
    // the document mode scrolls through its pages (docView) when one finger moves
    if (st.f === 1 && docModeNow()) docWheel(-st.dx, -st.dy, el.clientWidth, el.clientHeight);
    else S().set({ view: applyStep(v, st) });
    return true;
  }

  function touchUp(e: React.PointerEvent): boolean {
    const tn = touch.current;
    if (e.pointerType !== "touch" || !tn.has(e.pointerId)) return false;
    const nav = tn.navigating;
    const tap = tn.up(e.pointerId);
    if (!nav) return false;
    const down = tapDown.current;
    if (tap && down) {
      tapDown.current = null;
      const [x, y] = local(e);
      if (isDoubleTap(lastTap.current, e.timeStamp, e.clientX, e.clientY) && !editingRef.current) {
        // double tap: fit ↔ 2× about the tapped point
        lastTap.current = null;
        const before = S().view;
        fitCurrent();
        const to = doubleTapView(before, S().view.zoom, x, y);
        if (to) S().set({ view: to });
        return true;
      }
      lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      // a tap clicks as the mouse would (select, caret, buttons on the canvas)
      replaying.current = true;
      try {
        onPointerDown(down);
        onPointerUp(e);
      } finally {
        replaying.current = false;
      }
    }
    return true;
  }

  function onPointerDown(e: React.PointerEvent) {
    if (touchDown(e)) return;
    if (editingRef.current) {
      // slides: a press on another text box while typing ends this one and types there (one click, not two)
      if (e.button === 0 && !e.shiftKey && currentEditMode() === "SLIDE" && currentPage()?.kind === "SLIDE") {
        const hit = topHit(screenToPage(...local(e)));
        const from = editingRef.current.id;
        if (hit?.type === "TEXT" && hit.id !== from && !hit.locked) {
          const cx = e.clientX, cy = e.clientY;
          setTimeout(() => {
            if (editingRef.current && editingRef.current.id !== from) return;
            const n = currentPage()?.nodes.find((x) => x.id === hit.id);
            if (n?.type !== "TEXT") return;
            if (editingRef.current) S().set({ editingTextId: null });
            startTextEdit(n);
            caretAtPoint(cx, cy);
          }, 0);
        }
      }
      return;
    }
    const el = wrap.current!;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* a finger's tap replayed after it lifted (touchUp): nothing to capture */
    }
    // docView: a press on a page above / below the current one (document mode) makes it current first
    if (e.button === 0) pickPageAt(...local(e), el.clientHeight);
    const s = S();
    const page = currentPage();
    if (!page) return;
    const [sx, sy] = local(e);
    const p = screenToPage(sx, sy);
    shiftDown.current = e.shiftKey;
    const ch = cadCanvas();
    if (ch && !spaceDown.current && s.tool !== "hand" && ch.down(e.nativeEvent, sx, sy)) {
      drag.current = { kind: "cad" };
      return;
    }

    if (e.button === 1 || spaceDown.current || s.tool === "hand") {
      drag.current = { kind: "pan", sx, sy, panX: s.view.panX, panY: s.view.panY };
      el.style.cursor = "grabbing";
      return;
    }
    if (e.button !== 0) return;
    const clicks = countPress(presses.current, e.detail, e.timeStamp, e.clientX, e.clientY);

    // crop session: the crop box takes every press
    if (useCrop.getState().id) {
      const tf = cropFrame();
      const rect = useCrop.getState().rect;
      if (!tf || !rect) return;
      const box = { t: tf, lb: rect };
      const pick = pickHandle(box, p, HANDLE_PX / s.view.zoom, isCanvasCrop() ? { rotateReach: ROTATE_PX / s.view.zoom } : { rotate: false });
      const q0 = invertTransform(tf, p);
      if (pick?.kind === "handle") drag.current = { kind: "crop", handle: pick.handle, rect0: rect, q0 };
      else if (pick?.kind === "rotate") {
        // straighten: turn the box about its centre (Photoshop's rotate outside the crop box)
        const c = applyTransform(tf, [rect.x + rect.w / 2, rect.y + rect.h / 2]);
        drag.current = { kind: "cropRotate", angle0: useCrop.getState().angle, a0: Math.atan2(p[1] - c[1], p[0] - c[0]), c };
      }
      // inside a drawn box: move it; outside, or before a box is drawn: draw a new one (Photoshop)
      else if (insideBox(box, p) && useCrop.getState().drawn) drag.current = { kind: "crop", handle: null, rect0: rect, q0 };
      else drag.current = { kind: "cropNew", rect0: rect, q0 };
      return;
    }

    // a document page whose body flows: a press puts the caret there (Word), no object handles
    if ((s.tool === "select" || s.tool === "text") && page.kind === "DOCUMENT" && currentEditMode() === "DOCUMENT") {
      // …except on a handle of the selected picture / shape: its corner lies on the text around it, and the press went
      // to the text (a selection drag) instead of resizing it (QA ui-audit #16)
      const sel = s.tool === "select" && s.selection.length ? page.nodes.filter((n) => s.selection.includes(n.id)) : [];
      const sbh = sel.length && sel.every((n) => !(n.type === "TEXT" && n.flow)) ? selectionBox(page, s.selection) : null;
      const onHandle = !!sbh && pickHandle(sbh.box, p, HANDLE_PX / s.view.zoom, { edges: !sbh.multi, rotate: false })?.kind === "handle";
      if (!onHandle && bodyAt(page, p) && flowPointerDown(page, p[0], p[1], { detail: e.detail, shift: e.shiftKey })) {
        drag.current = { kind: "flow" };
        return;
      }
      if (flowActive()) endTyping();
      // a table in the body flow: one click puts the caret in the cell (Word)
      const th = topHit(p);
      if (th?.type === "TABLE" && th.flow && !e.shiftKey && isFlowPage(page)) {
        e.preventDefault(); // no mousedown after it: the cell editor keeps the focus
        const lp = invertTransform(th.transform, p), c = cellAt(th, lp[0], lp[1]);
        if (c) drag.current = { kind: "cells", nodeId: th.id, anchor: c }; // dragging on picks a cell range (Word)
        return startCellEdit(th, p);
      }
    }

    // pen family and direct selection (ui/pathCanvas.ts); Ctrl / Alt switch the pen tools while held
    if (isPathTool(s.tool)) {
      const eff = effectiveTool();
      if (eff === "anchorAdd") {
        if (!addAnchorAt(p, 6 / s.view.zoom)) s.notify(tr("design.msg.clickPath"));
        return;
      }
      if (eff === "anchorDel") {
        if (!deleteAnchorAt(p, 7 / s.view.zoom)) s.notify(tr("design.msg.clickAnchor"));
        return;
      }
      // direct selection on a picture, text or table: select and move it as the selection tool does
      if (eff === "direct" && !isDrawing()) {
        const top = topHit(p);
        const onPath = top?.type === "VECTOR" || !!pathHitAt(p, s.view.zoom, 6, shownPaths(page));
        if (top && top.type !== "VECTOR" && !onPath) {
          s.set({ selection: e.shiftKey ? [...new Set([...s.selection, top.id])] : [top.id] });
          s.beginGesture();
          drag.current = { kind: "move", start: p, moved: false };
          return;
        }
      }
      const pd = pathDown(e, p, penv());
      if (pd) drag.current = { kind: "path", d: pd };
      invalidate();
      return;
    }

    switch (s.tool) {
      case "select": {
        // free-transform handles win only on the handle itself (core/transform pointerTarget)
        const sb = selectionBox(page, s.selection);
        const pick = sb ? pickHandle(sb.box, p, HANDLE_PX / s.view.zoom, { edges: !sb.multi, rotateReach: ROTATE_PX / s.view.zoom }) : null;
        if (sb && pick?.kind === "handle") {
          s.beginGesture();
          drag.current = { kind: "xform", sb, handle: pick.handle, startAngle: 0 };
          return;
        }
        // guides sit above objects: grab one to move it, double-click to type its position
        if (canEditGuides() && page.guides) {
          const g = hitGuide(page.guides, p[0], p[1], GUIDE_HIT_PX / s.view.zoom);
          if (g) {
            if (clicks >= 2) {
              A().set({ guideEdit: { axis: g.axis, v: g.v, sx, sy } });
              return;
            }
            const ix = snapIndexFor();
            const lines = (g.axis === "x" ? ix.xs : ix.ys).filter((l) => !(l.kind === "guide" && Math.abs(l.v - g.v) < 1e-6));
            s.beginGesture();
            drag.current = { kind: "guide", axis: g.axis, from: g.v, cur: g.v, remove: false, lines, ix };
            A().set({ guideDrag: { axis: g.axis, v: g.v, from: g.v, overRuler: false } });
            return;
          }
        }
        const hit = topHit(p);
        const target = pointerTarget(pick, hit?.id ?? null, s.selection, !!sb && !e.shiftKey && insideBox(sb.box, p));
        if (target === "rotate" && sb) {
          const c = boxCenter(sb.box);
          s.beginGesture();
          drag.current = { kind: "xform", sb, handle: null, startAngle: Math.atan2(p[1] - c[1], p[0] - c[0]) };
          return;
        }
        // slides: one click on text puts the caret there, one on a box's frame selects it to move (an empty placeholder
        // starts typing at once) — the way slide editors work (docs/design/SLIDE_MODE.md)
        if (!e.shiftKey && clicks < 2 && hit?.type === "TEXT" && target === "object" && page.kind === "SLIDE" && currentEditMode() === "SLIDE" && !hit.locked) {
          if (isEmptyPh(hit) || !onFrame(hit, p)) {
            startTextEdit(hit);
            caretAtPoint(e.clientX, e.clientY);
            return;
          }
          if (!s.selection.includes(hit.id)) {
            s.set({ selection: [hit.id] });
            s.beginGesture();
            drag.current = { kind: "move", start: p, moved: false };
            return;
          }
        }
        // editModes: the document mode puts the caret where text is clicked (one click); the flow engine may take it
        if (!e.shiftKey && clickTextAction() === "edit" && (hit?.type === "TEXT" || !hit)) {
          // the body took the press: dragging on from it selects text (as the press on the body above does)
          if (docHooks.click?.(page, p, hit, e)) {
            drag.current = { kind: "flow" };
            return;
          }
          // a floating text box (Word): a press on its frame selects it (to move / resize), inside it types
          if (hit?.type === "TEXT" && target === "object" && !hit.flow && !s.selection.includes(hit.id) && onFrame(hit, p)) {
            s.set({ selection: [hit.id] });
            s.beginGesture();
            drag.current = { kind: "move", start: p, moved: false };
            return;
          }
          if (hit?.type === "TEXT" && target === "object") {
            startTextEdit(hit);
            caretAtPoint(e.clientX, e.clientY);
            return;
          }
        }
        // a PSD text layer: double-click edits its text (docs/design/PSD_TEXT.md)
        if (clicks >= 2 && !e.shiftKey) {
          const pt = psdTextAt(page, p);
          if (pt) return startPsdTextEdit(page.id, pt);
        }
        // design mode: double-click a member of a layer group → isolation mode on that group (Illustrator)
        if (clicks >= 2 && hit?.groupId && hit.type !== "TEXT" && hit.type !== "TABLE" && currentEditMode() === "DESIGN" && useDesign.getState().isolated !== hit.groupId) {
          enterIsolation(hit.groupId);
          s.set({ selection: [hit.id] });
          return;
        }
        if (clicks >= 2 && !hit && useDesign.getState().isolated) return exitIsolation();
        if (target === "object" && hit) {
          if (e.detail >= 2 && hit.type === "TEXT") return startTextEdit(hit);
          if (e.detail >= 2 && hit.type === "TABLE") return startCellEdit(hit, p);
          // a selected table: a click picks a cell, Shift+click the other corner of a range (셀 합치기)
          if (hit.type === "TABLE" && s.selection.includes(hit.id)) {
            const lp = invertTransform(hit.transform, p);
            const c = cellAt(hit, lp[0], lp[1]);
            const cs = useCellSel.getState();
            if (c && e.shiftKey && cs.target?.nodeId === hit.id) return void useCellSel.setState({ end: c });
            if (c && !e.shiftKey) useCellSel.setState({ target: { nodeId: hit.id, ...c }, end: null });
            // document mode (Word): dragging inside a selected table picks a cell range instead of moving the table
            // (the table alone: with other objects selected too, the drag still moves them all)
            if (c && !e.shiftKey && currentEditMode() === "DOCUMENT" && s.selection.length === 1) return void (drag.current = { kind: "cells", nodeId: hit.id, anchor: c });
          }
          if (e.shiftKey) s.set({ selection: s.selection.includes(hit.id) ? s.selection.filter((i) => i !== hit.id) : [...s.selection, hit.id] });
          else if (!s.selection.includes(hit.id)) s.set({ selection: [hit.id] });
          s.beginGesture();
          drag.current = { kind: "move", start: p, moved: false };
        } else if (target === "move-selection") {
          // empty (transparent) spot inside the selection box: move what is selected
          s.beginGesture();
          drag.current = { kind: "move", start: p, moved: false };
        } else {
          // double-click in the header / footer margin of a document page: edit it there (Word)
          if (e.detail >= 2 && startHfEdit(page, p[1])) return;
          if (!e.shiftKey) s.set({ selection: [] });
          drag.current = { kind: "marquee", start: p, cur: p };
        }
        return;
      }
      // ── image mode (Photoshop) ──
      case "marquee":
        drag.current = { kind: "pixmarquee", start: p, cur: p, op: opFromMods(e) };
        return;
      case "lasso":
        drag.current = { kind: "lasso", pts: [p], op: opFromMods(e) };
        return;
      case "wand":
        wandSelect(p, opFromMods(e));
        return;
      case "eyedropper":
        pickColorAt(p, e.altKey);
        return;
      case "gradient":
        drag.current = { kind: "gradient", a: p, b: p };
        return;
      case "zoom":
        zoomAt(e.altKey ? -1 : 1, sx, sy);
        return;
      // ── design mode (Illustrator) ──
      case "line": {
        const ix = snapOn(e) ? snapIndexFor() : undefined;
        const q = ix ? snapPt(p, e, ix) : p;
        drag.current = { kind: "line", a: q, b: q, ix };
        return;
      }
      case "brush":
      case "eraser": {
        // Alt+click with the brush picks a colour (Photoshop)
        if (e.altKey && s.tool === "brush" && currentEditMode() === "IMAGE") return void pickColorAt(p);
        // the active layer (pictures are rasterized first); none for the eraser: nothing happens (a notice says why)
        const raster = paintTarget(currentPage()!, s.tool === "eraser", currentEditMode() === "IMAGE");
        if (!raster) return;
        // the brush size is in canvas pixels: a layer with more pixels than its place (a scaled photo) gets a larger dab
        const k = Math.abs(raster.transform.scale) || 1;
        const stroke = new Stroke(raster, page.width, page.height, k === 1 ? s.brush : { ...s.brush, size: s.brush.size / k }, s.tool === "eraser");
        stroke.add({ x: p[0], y: p[1], p: e.pointerType === "pen" ? e.pressure || 0.5 : 1 });
        drag.current = { kind: "stroke", stroke };
        invalidate();
        return;
      }
      case "rect":
      case "ellipse": {
        const ix = snapOn(e) ? snapIndexFor() : undefined;
        const q = ix ? snapPt(p, e, ix) : p;
        drag.current = { kind: "shape", shape: s.tool, start: q, cur: q, ix };
        return;
      }
      case "text": {
        const hit = topHit(p);
        if (hit?.type === "TEXT") return startTextEdit(hit);
        if (hit?.type === "TABLE") return startCellEdit(hit, p);
        // the type tool on a PSD text layer edits that text instead of starting a new one
        const pt = psdTextAt(page, p);
        if (pt) return startPsdTextEdit(page.id, pt);
        const q = snapPt(p, e);
        const t = newText("", Math.min(480, Math.max(40, page.width - q[0])), { fontSize: 24 });
        t.transform = { x: q[0], y: q[1], rotation: 0, scale: 1 };
        s.commit(tr("shell.hist.addText"), (d) => void draftPage(d, s.pageId)?.nodes.push(t as any));
        startTextEdit(t);
        return;
      }
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (touchMove(e)) return;
    const [sx, sy] = local(e);
    let p = screenToPage(sx, sy);
    cursor.current = p;
    const d = drag.current;
    const s = S();
    shiftDown.current = e.shiftKey;
    if (useUI.getState().rulers || cadCanvas()) A().set({ cursor: p });
    const ch = cadCanvas();
    if (ch && d?.kind !== "pan") {
      ch.move(e.nativeEvent, sx, sy);
      if (!d || d.kind === "cad") return;
    }
    if (!d) {
      mods.ctrl = e.ctrlKey || e.metaKey;
      mods.alt = e.altKey;
      if (s.tool === "brush" || s.tool === "eraser" || isDrawing()) invalidate();
      if (s.tool === "select" || useCrop.getState().id) hoverCursor(p);
      else if (isPathTool(s.tool)) pathHover(p);
      return;
    }
    switch (d.kind) {
      case "path":
        pathMove(d.d, e, p, penv());
        break;
      case "flow": {
        const pg = currentPage();
        if (pg) flowPointerMove(pg, p[0], p[1]);
        break;
      }
      case "cells": {
        const n = currentPage()?.nodes.find((x) => x.id === d.nodeId);
        if (n?.type !== "TABLE") break;
        const lp = invertTransform(n.transform, p);
        const l = layoutTable(n);
        // past the table's edge: the edge cell (the range keeps following the pointer)
        const c = cellAt(n, Math.max(0, Math.min(lp[0], l.width)), Math.max(0, Math.min(lp[1], l.height)));
        if (!c) break;
        const end = dragEnd(d.anchor, c);
        if (!end) break;
        // a range, not typing: the cell being edited is committed and closed first
        const ae = document.activeElement as HTMLElement | null;
        if (ae?.classList.contains("cell-editor")) ae.blur();
        const cs = useCellSel.getState();
        if (cs.target?.nodeId !== d.nodeId || cs.target.row !== d.anchor.row || cs.target.col !== d.anchor.col || cs.end?.row !== end.row || cs.end?.col !== end.col)
          useCellSel.setState({ target: { nodeId: d.nodeId, ...d.anchor }, end });
        break;
      }
      case "pan":
        s.set({ view: { ...s.view, panX: d.panX + sx - d.sx, panY: d.panY + sy - d.sy } });
        break;
      case "move": {
        let dx = p[0] - d.start[0], dy = p[1] - d.start[1];
        let lock: "x" | "y" | null = null;
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) (dy = 0), (lock = "y");
          else (dx = 0), (lock = "x");
        }
        d.moved = true;
        const ids = s.selection;
        if (snapOn(e)) {
          if (!d.ix) {
            const moving = (currentNodesIn(s.gestureBase ?? s.doc, ids) ?? []).filter((n) => !n.locked);
            d.base = moving.reduce<Rect | null>((a, n) => unionRect(a, nodeBounds(n)), null);
            d.ix = snapIndexFor(ids);
          }
          if (d.base) {
            const r = { ...d.base, x: d.base.x + dx, y: d.base.y + dy };
            const sr = snapRect(d.ix, r, snapTol(), { x: lock !== "x", y: lock !== "y", equal: useUI.getState().snapTo.spacing });
            dx += sr.dx;
            dy += sr.dy;
            const segs = smartGuideSegments({ ...r, x: r.x + sr.dx, y: r.y + sr.dy }, sr);
            A().set({ smart: segs.length || sr.gaps.length ? { segs, gaps: sr.gaps } : null });
          }
        } else if (A().smart) A().set({ smart: null });
        s.updateGesture((doc) => {
          draftPage(doc, s.pageId)?.nodes.forEach((n) => {
            if (ids.includes(n.id) && !n.locked) {
              const base = s.gestureBase && currentNodeIn(s.gestureBase, n.id);
              if (base) {
                n.transform.x = base.transform.x + dx;
                n.transform.y = base.transform.y + dy;
              }
            }
          });
        });
        break;
      }
      case "crop": {
        const tf = cropFrame();
        const full = useCrop.getState().full;
        if (!tf || !full) break;
        const q = invertTransform(tf, p);
        const rect = d.handle
          ? resizeCrop(d.rect0, d.handle, q, full, { ratio: cropRatioValue(), sx: tf.scale, sy: tf.scaleY ?? tf.scale, fromCenter: e.altKey })
          : moveCrop(d.rect0, q[0] - d.q0[0], q[1] - d.q0[1], full);
        useCrop.getState().set({ rect, drawn: true });
        break;
      }
      case "cropNew": {
        const tf = cropFrame();
        const full = useCrop.getState().full;
        if (!tf || !full) break;
        const rect = dragCropRect(d.q0, invertTransform(tf, p), full, cropRatioValue());
        // a click (no drag) keeps the box as it was
        const k = s.view.zoom * (tf.scale || 1);
        if (rect.w * k < 2 || rect.h * k < 2) useCrop.getState().set({ rect: d.rect0 });
        else useCrop.getState().set({ rect, drawn: true });
        break;
      }
      case "cropRotate": {
        let a = d.angle0 + ((Math.atan2(p[1] - d.c[1], p[0] - d.c[0]) - d.a0) * 180) / Math.PI;
        a = e.shiftKey ? Math.round(a) : Math.round(a * 10) / 10;
        setCropAngle(a);
        break;
      }
      case "xform": {
        const mods = { shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey || e.metaKey };
        if (d.handle) {
          // Alt means "from the centre" here, so snapping stays on while it is held
          if (useUI.getState().snap) {
            d.ix ??= snapIndexFor(d.sb.nodes.map((n) => n.id));
            const sp = snapPoint(d.ix, p[0], p[1], snapTol());
            p = [sp.x, sp.y];
            const segs = smartGuideSegments({ x: sp.x, y: sp.y, w: 0, h: 0 }, { x: sp.hx, y: sp.hy });
            A().set({ smart: segs.length ? { segs, gaps: [] } : null });
          }
          const sz = liveResize(d.sb, d.handle, p, mods);
          useXform.getState().set({ readout: `${fmtGuide(sz.w, currentPage())} × ${fmtGuide(sz.h, currentPage())}` });
        } else {
          const ang = liveRotate(d.sb, d.startAngle, p, mods, snapOn(e));
          useXform.getState().set({ readout: `${Math.round(ang * 10) / 10}°` });
        }
        break;
      }
      case "marquee":
        d.cur = p;
        invalidate();
        break;
      case "pixmarquee": {
        // Shift (after the press) = square / circle (Photoshop)
        let w = p[0] - d.start[0], h = p[1] - d.start[1];
        if (e.shiftKey && d.op !== "add") {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
        d.cur = [d.start[0] + w, d.start[1] + h];
        invalidate();
        break;
      }
      case "lasso": {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) * s.view.zoom >= 2) d.pts.push(p);
        invalidate();
        break;
      }
      case "gradient":
        d.b = e.shiftKey ? constrain45(d.a, p) : p;
        invalidate();
        break;
      case "line": {
        const q = d.ix && snapOn(e) ? snapPt(p, e, d.ix) : p;
        d.b = e.shiftKey ? constrain45(d.a, q) : q;
        invalidate();
        break;
      }
      case "stroke": {
        const evs = (e.nativeEvent as PointerEvent).getCoalescedEvents?.() ?? [e.nativeEvent];
        for (const ev of evs) {
          const q = screenToPage(...local(ev));
          d.stroke.add({ x: q[0], y: q[1], p: ev.pointerType === "pen" ? ev.pressure || 0.5 : 1 });
        }
        invalidate();
        break;
      }
      case "shape":
        d.cur = d.ix && snapOn(e) ? snapPt(p, e, d.ix) : p;
        invalidate();
        break;
      case "guide": {
        let v = d.axis === "x" ? p[0] : p[1];
        if (snapOn(e)) {
          const h = snapAxis(d.lines, d.ix.grid, [v], snapTol());
          if (h) v += h.delta;
        }
        const rulers = useUI.getState().rulers;
        const { w, h } = size.current;
        const off = sx < 0 || sy < 0 || sx > w || sy > h;
        d.remove = off || (rulers && (d.axis === "x" ? sx < RULER : sy < RULER));
        d.cur = v;
        liveGuide(d.axis, d.from, d.remove ? null : v);
        A().set({ guideDrag: { axis: d.axis, v, from: d.from, overRuler: d.remove } });
        break;
      }
    }
  }

  function onPointerUp(e: React.PointerEvent) {
    if (touchUp(e)) return;
    const d = drag.current;
    drag.current = null;
    const s = S();
    wrap.current!.style.cursor = spaceDown.current ? "grab" : toolCursor(S().tool);
    if (A().smart) A().set({ smart: null });
    if (!d) return;
    if (d.kind === "cad") {
      cadCanvas()?.up(e.nativeEvent, ...local(e));
      return;
    }
    switch (d.kind) {
      case "flow":
        flowPointerUp();
        break;
      case "crop":
      case "cropNew":
      case "cropRotate":
        break;
      case "guide":
        A().set({ guideDrag: null });
        if (!d.remove && Math.abs(d.cur - d.from) < 1e-9) s.cancelGesture();
        else s.endGesture(d.remove ? tr("shell.hist.deleteGuide") : tr("shell.hist.moveGuide"));
        break;
      case "move":
        if (d.moved) s.endGesture(tr("shell.hist.move"));
        else {
          s.cancelGesture();
          // click on a selected item in a multi-selection selects just that one
          if (!e.shiftKey) {
            const hit = topHit(screenToPage(...local(e)));
            if (hit) s.set({ selection: [hit.id] });
          }
        }
        break;
      case "xform":
        useXform.getState().set({ readout: null });
        s.endGesture(d.handle ? tr("shell.hist.resize") : tr("shell.hist.rotate"));
        break;
      case "path":
        pathUp(d.d, penv());
        pathHover(screenToPage(...local(e)));
        break;
      case "marquee": {
        const r = rectFromPoints([d.start, d.cur]);
        if (r.w * s.view.zoom > 3 || r.h * s.view.zoom > 3) {
          const page = currentPage()!;
          const ids = page.nodes
            .filter(pickableOn(page))
            .filter((n) => {
              const b = nodeBounds(n);
              return b.x >= r.x && b.y >= r.y && b.x + b.w <= r.x + r.w && b.y + b.h <= r.y + r.h;
            })
            .map((n) => n.id);
          s.set({ selection: e.shiftKey ? [...new Set([...s.selection, ...ids])] : ids });
        }
        invalidate();
        break;
      }
      case "pixmarquee": {
        const r = rectFromPoints([d.start, d.cur]);
        // a click (no drag) with the marquee drops the selection, as in Photoshop
        if (r.w * s.view.zoom < 2 && r.h * s.view.zoom < 2) {
          if (d.op === "replace") deselect();
        } else marqueeSelect(d.start, d.cur, d.op);
        invalidate();
        break;
      }
      case "lasso":
        if (d.pts.length > 2) lassoSelect(d.pts, d.op);
        else if (d.op === "replace") deselect();
        invalidate();
        break;
      case "gradient":
        if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * s.view.zoom > 3) applyGradient(d.a, d.b);
        invalidate();
        break;
      case "line": {
        if (Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) * s.view.zoom > 2) {
          const v = drawnLine(d.a, d.b);
          s.commit(tr("design.hist.drawLine"), (doc) => void draftPage(doc, s.pageId)?.nodes.push(v as any));
          S().set({ selection: [v.id] });
          toolDone("line");
        }
        invalidate();
        break;
      }
      case "stroke": {
        // image mode: a stroke paints only inside the pixel selection
        clipToSelection(d.stroke.mask, d.stroke.node.transform);
        const tiles = d.stroke.commit();
        const id = d.stroke.node.id;
        if (tiles)
          s.commit(d.stroke.erase ? tr("cmd.image.eraser") : tr("cmd.image.brush"), (doc) => {
            const dp = draftPage(doc, s.pageId);
            const n = dp?.nodes.find((x) => x.id === id) as any;
            if (n) n.tiles = tiles;
            if (dp && d.stroke.erase) revealTransparencyInPlace(dp);
          });
        invalidate();
        break;
      }
      case "shape": {
        const r = shapeRect(d.start, d.cur);
        if (r.w < 2 && r.h < 2) {
          r.w = r.h = 120;
        }
        const v = drawnShape(d.shape, r, s);
        s.commit(d.shape === "rect" ? tr("shell.hist.drawRect") : tr("shell.hist.drawEllipse"), (doc) => void draftPage(doc, s.pageId)?.nodes.push(v as any));
        S().set({ selection: [v.id] });
        toolDone(d.shape);
        break;
      }
    }
  }

  // ───────── drag & drop files ─────────
  // a picture / clip dropped on the page is placed on it; any other file opens as a document of its own (ui/fileDrop.ts)
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    if (!e.dataTransfer.files.length) return;
    claimDrop(e);
    for (const f of await droppedFiles(e.dataTransfer)) {
      if (placesOnPage(f.name) && currentPage()) await importFile(f, { place: true });
      else await openAndRemember(f);
    }
  };

  const tool = useStore((s) => s.tool);
  const rulers = useUI((s) => s.rulers);
  // the drawing screen draws its own crosshair
  const cadOn = useCadScreenNow();
  const cursorStyle = cadOn ? "none" : toolCursor(tool);

  return (
    <div
      ref={wrap}
      className="canvas-wrap"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={(e) => void (e.pointerType === "touch" && touch.current.up(e.pointerId))}
      onPointerLeave={() => {
        cadCanvas()?.leave();
        if (A().cursor) A().set({ cursor: null });
        invalidate();
      }}
      onDoubleClick={(e) => {
        // fallback for engines whose pointerdown carries no click count
        if (editingRef.current || cellEdit || flowActive() || cadCanvas() || (S().tool !== "select" && S().tool !== "text")) return;
        const r = wrap.current!.getBoundingClientRect();
        const p = screenToPage(e.clientX - r.left, e.clientY - r.top);
        const hit = topHit(p);
        if (hit?.type === "TEXT") startTextEdit(hit);
        else if (hit?.type === "TABLE") startCellEdit(hit, p);
        else if (psdTextAt(currentPage(), p)) startPsdTextEdit(currentPage()!.id, psdTextAt(currentPage(), p)!);
        else if (!hit && currentPage()) startHfEdit(currentPage()!, p[1]);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
      onContextMenu={(e) => {
        e.preventDefault();
        // a misspelled word: Word's spelling menu (suggestions, ignore all, add to dictionary)
        const page = currentPage();
        if (!page || editingRef.current) return;
        const r = wrap.current!.getBoundingClientRect();
        const pt = screenToPage(e.clientX - r.left, e.clientY - r.top);
        // the body text: the caret goes where it was pressed first (Word), unless that is inside the selection — the
        // menu's commands act there (QA doc-review2)
        const s = S();
        // a table (select / text tool): Word's table menu — rows, columns, delete, merge / split, properties
        const th = s.tool === "select" || s.tool === "text" ? topHit(pt) : undefined;
        if (th?.type === "TABLE" && !th.locked) {
          const lp = invertTransform(th.transform, pt), c = cellAt(th, lp[0], lp[1]);
          if (c) {
            pickForMenu(th, c);
            return setSpellMenu({ x: e.clientX, y: e.clientY, items: tableMenuItems() });
          }
        }
        // a picture or a raster layer (image / design modes): its image commands — 이미지 크기 키우기, 배경 지우기
        if (s.tool === "select" && (th?.type === "RASTER" || th?.type === "IMAGE") && !th.locked && (currentEditMode() === "IMAGE" || currentEditMode() === "DESIGN")) {
          if (!s.selection.includes(th.id)) s.set({ selection: [th.id] });
          return setSpellMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: `${tr("cmd.image.upscale")}…`, onSelect: () => useImageUI.getState().set({ kind: "upscale" }) },
              { label: `${tr("cmd.image.removeBackgroundDialog")}…`, onSelect: () => useImageUI.getState().set({ kind: "matte" }) },
            ],
          });
        }
        if ((s.tool === "select" || s.tool === "text") && page.kind === "DOCUMENT" && currentEditMode() === "DOCUMENT" && bodyAt(page, pt)) flowContextPress(page, pt[0], pt[1]);
        const hit = spellAt(page, pt);
        const at = { x: e.clientX, y: e.clientY };
        // in the document body: the review commands (새 메모, accept / reject the change here, delete the comment here)
        const review: MenuItem[] = [];
        if (flowActive()) {
          const change = changeHere();
          const here = commentsHere();
          review.push(
            { label: tr("review.menu.newComment"), kbd: "Ctrl+Alt+M", onSelect: () => void startComment() },
            // (the keyboard goes back to the body after: Ctrl+Z undoes the accept / reject at once — QA doc-review2)
            ...(here.length ? [{ label: tr("review.menu.deleteComment"), onSelect: () => (deleteComment(here[0]), focusInput()) }] : []),
            { sep: true, label: "" },
            { label: tr("review.menu.accept"), disabled: !change, onSelect: () => (resolveHere(true), focusInput()) },
            { label: tr("review.menu.reject"), disabled: !change, onSelect: () => (resolveHere(false), focusInput()) },
          );
        }
        if (!hit) {
          if (review.length) setSpellMenu({ ...at, items: review });
          return;
        }
        void suggestionsFor(hit.mark).then((sug) => {
          const items: MenuItem[] = sug.length
            ? sug.map((w) => ({ label: w, onSelect: () => replaceWord(hit, w) }))
            : [{ label: tr("spell.noSuggestions"), disabled: true }];
          items.push({ sep: true, label: "" }, { label: tr("spell.ignoreAll"), onSelect: () => ignoreAll(hit.mark) }, { label: tr("spell.addToDictionary"), onSelect: () => addToDictionary(hit.mark) });
          if (review.length) items.push({ sep: true, label: "" }, ...review);
          setSpellMenu({ ...at, items });
        });
      }}
    >
      <canvas ref={main} className="layer" style={{ width: "100%", height: "100%" }} />
      <canvas ref={over} className="layer" style={{ width: "100%", height: "100%" }} />
      {rulers && !cadOn && <Rulers />}
      <GuideEditor />
      {cellEdit && <CellEditor key={`${cellEdit.nodeId}:${cellEdit.row}:${cellEdit.col}`} target={cellEdit} onMove={setCellEdit} onDone={() => setCellEdit(null)} />}
      <FlowEditor />
      <PicLayoutButton />
      {spellMenu && <PopMenu at={spellMenu} items={spellMenu.items} onClose={() => setSpellMenu(null)} />}
      <PdfFormLayer />
      <PdfFindLayer />
      <PdfAnnotLayer />
      <PsdTextEditor />
      {editing && <TextEditor node={editing} onDone={() => { setEditing(null); S().set({ editingTextId: null }); toolDone("text"); }} />}
    </div>
  );
}

function currentNodesIn(doc: import("../core/types").OmwDocument, ids: string[]): SceneNode[] | undefined {
  const s = S();
  const pg = doc.pages.find((p) => p.id === s.pageId) ?? doc.masters.find((p) => p.id === s.pageId);
  return pg?.nodes.filter((n) => ids.includes(n.id));
}

function toolCursor(tool: string): string {
  // the drawing screen paints its own crosshair (ui/cad/view.ts)
  if (cadCanvas()) return "none";
  if (tool === "zoom") return "zoom-in";
  if (tool === "eyedropper") return EYEDROPPER_CURSOR;
  // pen family: the nib (its sign follows the pointer, ui/pathCanvas.ts pathCursor); direct selection: white arrow
  if (tool === "pen") return CURSORS.penNew;
  if (tool === "curvature") return CURSORS.curvature;
  if (tool === "anchorAdd") return CURSORS.penAdd;
  if (tool === "anchorDel") return CURSORS.penDel;
  if (tool === "anchorConvert") return CURSORS.convert;
  if (tool === "direct") return CURSORS.direct;
  return tool === "hand" ? "grab" : tool === "text" ? "text" : tool === "brush" || tool === "eraser" ? "none" : tool === "select" ? "default" : "crosshair";
}

function fmtGuide(v: number, page: Page | undefined): string {
  return formatLength(v, unitFor(page));
}

function currentNodeIn(doc: import("../core/types").OmwDocument, id: string): SceneNode | undefined {
  const s = S();
  const pg = doc.pages.find((p) => p.id === s.pageId) ?? doc.masters.find((p) => p.id === s.pageId);
  return pg?.nodes.find((n) => n.id === id);
}

// ───────── in-place text editor ─────────
// Rich text (character and paragraph formats) lives in RichTextEditor.tsx.

function TextEditor({ node, onDone }: { node: TextNode; onDone: () => void }) {
  return <RichTextEditor key={node.id} nodeId={node.id} onDone={onDone} />;
}
