// Crop session (C, the toolbox crop button, or the ribbon's "이미지 자르기").
//  • a single image / raster layer / PDF page selected: that object's crop ("이미지 자르기") — the node shows its
//    whole content, the crop rectangle is edited with handles, nothing is resampled (core/crop.ts).
//  • otherwise, in the image and design modes: the canvas crop (Photoshop's crop tool) — a box around the whole page,
//    shrunk or pulled past the page (the canvas grows; the new area is transparent / the page background), optionally
//    rotated (straighten). Applying sets the page size and moves (and, when straightened, rotates) every node — their
//    pixels stay as they are (non-destructive; a straightened PSD layer is resampled only when the PSD is written).
// Enter applies (one undo step), Esc cancels.

import { create } from "zustand";
import { CROP_RATIOS, applyRatio, canCrop, fullBounds, normalizeCrop, type Croppable } from "../core/crop";
import type { Rect } from "../core/geom";
import { currentPage, draftPage, storeHooks, useStore } from "../core/store";
import type { Transform, Vec2 } from "../core/types";
import { t } from "../i18n";
import { currentEditMode } from "./editModes";

const S = () => useStore.getState();

/** Session id of the canvas crop (no node has it). */
export const CANVAS_CROP = "__canvas__";

interface CropState {
  id: string | null;
  rect: Rect | null;
  full: Rect | null;
  ratio: string;
  /** custom W:H (ratio "custom") */
  custom: [number, number];
  /** canvas crop: straighten angle (degrees, the box's rotation on the page) and the page point it turns about */
  angle: number;
  pivot: Vec2;
  /** the box was drawn or changed in this session: until then a drag on the picture draws a new box (Photoshop) */
  drawn: boolean;
  /** 똑바로 펴기 (Photoshop's Straighten button on the crop options): the next drag draws the line to make level */
  straighten: boolean;
  set: (p: Partial<CropState>) => void;
}

export const useCrop = create<CropState>((set) => ({ id: null, rect: null, full: null, ratio: "free", custom: [3, 2], angle: 0, pivot: [0, 0], drawn: false, straighten: false, set: (p) => set(p) }));
const C = () => useCrop.getState();

let original: Rect | undefined;
let unsub: (() => void) | null = null;

/** Ratio presets offered in the crop strip (the canvas crop and the object crop alike). */
export const CROP_PRESETS: { id: string; label: string; ratio: number | null }[] = [
  CROP_RATIOS[0],
  { id: "original", label: "Original", ratio: null }, // label: ribbon.cropRatio.original
  ...CROP_RATIOS.slice(1),
  { id: "custom", label: "Custom", ratio: null }, // label: ribbon.cropRatio.custom
];

export function croppableSelection(): Croppable | null {
  const s = S();
  if (s.selection.length !== 1) return null;
  const n = currentPage()?.nodes.find((x) => x.id === s.selection[0]);
  return canCrop(n) && !n.locked ? n : null;
}

export const isCanvasCrop = () => C().id === CANVAS_CROP;

export function cropNode(): Croppable | null {
  const id = C().id;
  const n = id && id !== CANVAS_CROP ? currentPage()?.nodes.find((x) => x.id === id) : null;
  return canCrop(n) ? n : null;
}

/** Local → page transform of the canvas crop box (a rotation by `angle` about `pivot`). */
export function canvasFrame(angle = C().angle, pivot = C().pivot): Transform {
  const a = (angle * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  return { x: pivot[0] - (pivot[0] * cos - pivot[1] * sin), y: pivot[1] - (pivot[0] * sin + pivot[1] * cos), rotation: angle, scale: 1 };
}

/** The frame the crop box is edited in: the node's transform (object crop) or the canvas frame. */
export function cropFrame(): Transform | null {
  if (isCanvasCrop()) return canvasFrame();
  return cropNode()?.transform ?? null;
}

/** Whether the canvas crop is offered here (image and design modes, a page open). */
export function canvasCropAvailable(): boolean {
  const m = currentEditMode();
  return !!currentPage() && (m === "IMAGE" || m === "DESIGN");
}

export function startCrop() {
  if (C().id) return;
  const n = croppableSelection();
  if (!n) {
    if (canvasCropAvailable()) return startCanvasCrop();
    return S().notify(t("image.crop.selectOne"));
  }
  const full = fullBounds(n);
  if (full.w <= 0 || full.h <= 0) return S().notify(t("image.crop.empty"));
  original = n.crop;
  const s = S();
  s.beginGesture();
  // show the whole content while the rectangle is edited
  s.updateGesture((d) => {
    const dn = draftPage(d, s.pageId)?.nodes.find((x) => x.id === n.id) as Croppable | undefined;
    if (dn) delete dn.crop;
  });
  C().set({ id: n.id, full, rect: n.crop ? { ...n.crop } : { ...full }, ratio: "free", angle: 0, pivot: [0, 0], drawn: !!n.crop });
  open();
  s.notify(t("image.crop.hint"));
}

/** Canvas crop (Photoshop's crop tool): a box around the whole page. */
export function startCanvasCrop() {
  if (C().id) return;
  const page = currentPage();
  if (!page) return;
  const W = page.width, H = page.height;
  S().beginGesture();
  // the box may go well past the page (the canvas grows), not without end
  const full = { x: -4 * W, y: -4 * H, w: 9 * W, h: 9 * H };
  C().set({ id: CANVAS_CROP, full, rect: { x: 0, y: 0, w: W, h: H }, ratio: "free", angle: 0, pivot: [W / 2, H / 2], drawn: false });
  open();
  S().notify(t("image.canvasCrop.hint"));
}

function open() {
  const pageId = S().pageId;
  unsub = useStore.subscribe((st) => {
    if (st.pageId !== pageId || !st.gestureBase) cancelCrop();
  });
  // any other change while the box is up (menu command, property field, undo …) closes the session
  // first: an edit keeps the crop as its own step (like Ctrl+S), undo / redo drop it
  storeHooks.interrupt = (why) => (why === "edit" ? applyCrop() : cancelCrop());
}

function finish() {
  unsub?.();
  unsub = null;
  storeHooks.interrupt = null;
  C().set({ id: null, rect: null, full: null, angle: 0, drawn: false });
}

export function applyCrop() {
  const { id, rect, full, angle, pivot } = C();
  if (!id || !full) return;
  if (id === CANVAS_CROP) return applyCanvasCrop(rect, angle, pivot);
  const s = S();
  const next = normalizeCrop(rect, full);
  finish();
  const same = (!next && !original) || (next && original && next.x === original.x && next.y === original.y && next.w === original.w && next.h === original.h);
  if (same) return s.cancelGesture();
  s.updateGesture((d) => {
    const dn = draftPage(d, s.pageId)?.nodes.find((x) => x.id === id) as Croppable | undefined;
    if (!dn) return;
    if (next) dn.crop = next;
    else delete dn.crop;
  });
  s.endGesture(t(next ? "image.crop.undo" : "image.crop.undoRemove"));
}

const norm180 = (a: number) => {
  let r = ((a % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return Math.abs(r) < 1e-9 ? 0 : Math.round(r * 1e6) / 1e6;
};
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * The page after a canvas crop: `rect` in the box frame (rotation `angle` about `pivot`) becomes the page. Pure — the
 * nodes' positions (and rotations, when straightened) are mapped; pixels are not touched. Whole pixels without a
 * rotation, so a PSD keeps its layers at whole-pixel offsets.
 */
export function canvasCropPlan(page: { width: number; height: number }, rect: Rect, angle: number, pivot: Vec2) {
  const a = norm180(angle);
  const r = a ? rect : { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h) };
  const w = Math.max(1, Math.round(r.w)), h = Math.max(1, Math.round(r.h));
  const rad = (-a * Math.PI) / 180, cos = Math.cos(rad), sin = Math.sin(rad);
  // page → new page: rotate by -angle about the pivot, then the box's corner to the origin
  const map = (p: Vec2): Vec2 => {
    const dx = p[0] - pivot[0], dy = p[1] - pivot[1];
    return [r6(dx * cos - dy * sin + pivot[0] - r.x), r6(dx * sin + dy * cos + pivot[1] - r.y)];
  };
  const unchanged = !a && r.x === 0 && r.y === 0 && w === page.width && h === page.height;
  return { width: w, height: h, angle: a, map, unchanged };
}

function applyCanvasCrop(rect: Rect | null, angle: number, pivot: Vec2) {
  const s = S();
  const page = currentPage();
  finish();
  if (!rect || !page) return s.cancelGesture();
  const plan = canvasCropPlan(page, rect, angle, pivot);
  if (plan.unchanged) return s.cancelGesture();
  s.updateGesture((d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    pg.width = plan.width;
    pg.height = plan.height;
    for (const n of pg.nodes) {
      const [x, y] = plan.map([n.transform.x, n.transform.y]);
      n.transform.x = x;
      n.transform.y = y;
      if (plan.angle) n.transform.rotation = norm180(n.transform.rotation - plan.angle);
    }
    // ruler guides follow the content (dropped when straightened: they would no longer be straight)
    if (pg.guides) {
      if (plan.angle) delete pg.guides;
      else {
        const [ox, oy] = plan.map([0, 0]);
        pg.guides = { ...(pg.guides.x ? { x: pg.guides.x.map((v) => v + ox) } : {}), ...(pg.guides.y ? { y: pg.guides.y.map((v) => v + oy) } : {}) };
      }
    }
  });
  s.endGesture(t(plan.angle ? "image.canvasCrop.undoStraighten" : "image.canvasCrop.undo"));
  s.notify(t("image.canvasCrop.done", { w: plan.width, h: plan.height }));
}

export function cancelCrop() {
  if (!C().id) return;
  finish();
  S().cancelGesture();
}

/** Show everything again (object crop: the crop is removed when applied; canvas crop: the whole page, not rotated). */
export function resetCrop() {
  const { full, id } = C();
  if (id === CANVAS_CROP) {
    const page = currentPage();
    if (page) C().set({ rect: { x: 0, y: 0, w: page.width, h: page.height }, ratio: "free", angle: 0, pivot: [page.width / 2, page.height / 2] });
    return;
  }
  if (full) C().set({ rect: { ...full }, ratio: "free" });
}

function presetRatio(id: string): number | null {
  if (id === "custom") {
    const [w, h] = C().custom;
    return w > 0 && h > 0 ? w / h : null;
  }
  if (id === "original") {
    if (isCanvasCrop()) {
      const p = currentPage();
      return p && p.height > 0 ? p.width / p.height : null;
    }
    const n = cropNode();
    const f = C().full;
    if (!n || !f || f.h <= 0) return null;
    return (f.w * Math.abs(n.transform.scale)) / (f.h * Math.abs(n.transform.scaleY ?? n.transform.scale));
  }
  return CROP_PRESETS.find((x) => x.id === id)?.ratio ?? null;
}

export function setCropRatio(id: string) {
  const { rect, full } = C();
  const f = cropFrame();
  if (!rect || !full || !f || !CROP_PRESETS.some((x) => x.id === id)) return;
  const r = presetRatio(id);
  const sx = isCanvasCrop() ? 1 : f.scale, sy = isCanvasCrop() ? 1 : (f.scaleY ?? f.scale);
  C().set({ ratio: id, rect: r ? applyRatio(rect, full, r, sx, sy) : rect });
}

/** Custom W:H (picks the "custom" preset). */
export function setCropCustom(w: number, h: number) {
  if (!(w > 0) || !(h > 0)) return;
  C().set({ custom: [w, h] });
  setCropRatio("custom");
}

export function cropRatioValue(): number | null {
  return presetRatio(C().ratio);
}

/** Straighten: turn the canvas crop box to `angle` degrees (−45…45) about its own centre. */
export function setCropAngle(angle: number) {
  const { rect, id } = C();
  if (id !== CANVAS_CROP || !rect || !Number.isFinite(angle)) return;
  const a = Math.max(-45, Math.min(45, norm180(angle)));
  const f = canvasFrame();
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  const a0 = (f.rotation * Math.PI) / 180;
  const c: Vec2 = [cx * Math.cos(a0) - cy * Math.sin(a0) + f.x, cx * Math.sin(a0) + cy * Math.cos(a0) + f.y];
  // the box centre stays where it is on the page; the frame now turns about it
  C().set({ angle: a, pivot: c, rect: { x: c[0] - rect.w / 2, y: c[1] - rect.h / 2, w: rect.w, h: rect.h } });
}

/**
 * 똑바로 펴기: the line drawn from `a` to `b` (page px) along what should be level — a horizon, or a wall's edge
 * (steeper than 45°: made upright) — turns the box by its slant, so applying the crop turns the picture straight.
 */
export function straightenAngle(a: Vec2, b: Vec2): number | null {
  if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 2) return null;
  let d = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
  while (d > 45) d -= 90;
  while (d <= -45) d += 90;
  return d;
}
export function straightenBy(a: Vec2, b: Vec2) {
  C().set({ straighten: false });
  const d = straightenAngle(a, b);
  if (d !== null) setCropAngle(C().angle + d);
}

/**
 * A new crop box dragged from `a` to `b` (box frame), kept inside `full`; with a ratio (W / H in the frame's units)
 * the height follows the width. Photoshop: a drag outside the box — or anywhere before the first box is drawn —
 * draws a new box; a drag inside a drawn box moves it. Before (2026-11-23) the first box was the whole canvas, so
 * every drag on the picture moved that box and Enter shifted the picture instead of cropping it.
 */
export function dragCropRect(a: Vec2, b: Vec2, full: Rect, ratio: number | null = null): Rect {
  const cl = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const ax = cl(a[0], full.x, full.x + full.w), ay = cl(a[1], full.y, full.y + full.h);
  let bx = cl(b[0], full.x, full.x + full.w), by = cl(b[1], full.y, full.y + full.h);
  if (ratio && ratio > 0) {
    const w = Math.abs(bx - ax);
    by = ay + Math.sign(by - ay || 1) * (w / ratio);
    by = cl(by, full.y, full.y + full.h);
    bx = ax + Math.sign(bx - ax || 1) * Math.abs(by - ay) * ratio;
  }
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}
