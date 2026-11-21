// View aids glue: rulers, guides, grid and snapping between the document store, the shell's
// view settings (uiStore) and the pure logic in core/snap.ts, core/pages.ts and core/units.ts.
// Guide edits go through store.commit / gestures, so they are undoable and saved in the .omw.

import { create } from "zustand";
import type { Rect } from "../core/geom";
import { nodeBounds } from "../core/loom";
import { addGuide, cleanGuides, mergedGuides, moveGuide, removeGuide, type GuideAxis } from "../core/pages";
import { buildSnapIndex, nearRect, snapPoint, type GapMark, type GuideSeg, type SnapIndex } from "../core/snap";
import { currentPage, draftPage, masterOf, useStore } from "../core/store";
import type { Page, PageGuides, Vec2 } from "../core/types";
import { defaultGrid, formatLength, type GridSpec, type Unit } from "../core/units";
import { editUnit } from "./editModes";
import { useUI } from "./shell/uiStore";
import { t } from "../i18n";

const S = () => useStore.getState();
const U = () => useUI.getState();

/** ruler thickness, screen px */
export const RULER = 20;
/** snapping reach, screen px — the same at every zoom */
export const SNAP_PX = 6;
/** guide grab distance, screen px */
export const GUIDE_HIT_PX = 4;

// ───────── transient overlay state (not part of the document) ─────────

export interface GuideDrag {
  axis: GuideAxis;
  /** current position, page px */
  v: number;
  /** existing guide being moved (its original position), or null when pulled out of a ruler */
  from: number | null;
  /** the pointer is over a ruler: releasing deletes (moved guide) or cancels (new guide) */
  overRuler: boolean;
}

export interface GuideEdit {
  axis: GuideAxis;
  /** existing guide position, or null for "new guide at…" */
  v: number | null;
  /** popover position, canvas px */
  sx: number;
  sy: number;
}

interface AidsState {
  cursor: Vec2 | null;
  guideDrag: GuideDrag | null;
  guideEdit: GuideEdit | null;
  smart: { segs: GuideSeg[]; gaps: GapMark[] } | null;
  set: (p: Partial<AidsState>) => void;
}

export const useAids = create<AidsState>((set) => ({
  cursor: null,
  guideDrag: null,
  guideEdit: null,
  smart: null,
  set: (p) => set(p),
}));

// ───────── settings resolved for a page ─────────

export function unitFor(page: Page | undefined): Unit {
  const u = U().rulerUnit;
  // "auto": the edit mode's unit — document mm (in), print-size design mm, image / slide / screen design px
  return u === "auto" ? editUnit(page) : u;
}

export function gridFor(page: Page | undefined): GridSpec {
  const kind = page?.kind ?? "DESIGN";
  return U().grids[kind] ?? defaultGrid(kind);
}

export function fmt(px: number, page = currentPage()): string {
  return formatLength(px, unitFor(page));
}

/** The guides that take part on this page: its own plus its master's (read-only here). */
export function visibleGuides(page: Page): { own: PageGuides; master: PageGuides } {
  const m = masterOf(S().doc, page);
  return { own: page.guides ?? {}, master: m ? mergedGuides({}, m) : {} };
}

export function canEditGuides(): boolean {
  return U().guides && !U().guidesLocked;
}

// ───────── guide edits (undoable) ─────────

function editGuides(label: string, fn: (g: PageGuides | undefined, page: Page) => PageGuides | undefined) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  s.commit(label, (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const next = cleanGuides(fn(pg.guides ? { x: pg.guides.x?.slice(), y: pg.guides.y?.slice() } : undefined, page));
    if (next) pg.guides = next;
    else delete pg.guides;
  });
}

export function addGuideAt(axis: GuideAxis, v: number) {
  editGuides(t("ribbon.guide.add"), (g) => addGuide(g, axis, v));
}
export function setGuide(axis: GuideAxis, from: number, to: number) {
  editGuides(t("ribbon.guide.move"), (g) => moveGuide(g, axis, from, to));
}
export function deleteGuide(axis: GuideAxis, v: number) {
  editGuides(t("ribbon.guide.delete"), (g) => removeGuide(g, axis, v));
}
export function clearGuides() {
  const page = currentPage();
  if (!page?.guides) return S().notify(t("ribbon.msg.noGuides"));
  editGuides(t("ribbon.guide.clearAll"), () => undefined);
}
/** Guides at the page edges and centre (a quick layout start). */
export function addCenterGuides() {
  editGuides(t("ribbon.guide.center"),(g, p) => addGuide(addGuide(g, "x", p.width / 2), "y", p.height / 2));
}

/** Live guide move inside a gesture (beginGesture already called). */
export function liveGuide(axis: GuideAxis, from: number, to: number | null) {
  const s = S();
  s.updateGesture((d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const base = pg.guides ? { x: pg.guides.x?.slice(), y: pg.guides.y?.slice() } : undefined;
    const next = cleanGuides(to == null ? removeGuide(base, axis, from) : moveGuide(base, axis, from, to));
    if (next) pg.guides = next;
    else delete pg.guides;
  });
}

// ───────── snapping ─────────

export function snapOn(e?: { altKey?: boolean }): boolean {
  return U().snap && !e?.altKey;
}

export function snapTol(): number {
  return SNAP_PX / S().view.zoom;
}

/** visible page area (page px) with the current viewport */
function viewRect(): Rect {
  const el = typeof document !== "undefined" ? (document.querySelector(".canvas-wrap") as HTMLElement | null) : null;
  const { zoom, panX, panY } = S().view;
  const w = el?.clientWidth ?? 1600, h = el?.clientHeight ?? 1000;
  return { x: -panX / zoom, y: -panY / zoom, w: w / zoom, h: h / zoom };
}

/** cap on objects fed to the index — the nearest ones to the viewport win */
const MAX_OBJECTS = 4000;

/**
 * Snap index for a gesture on the current page. `exclude` = ids being moved (never snap to
 * yourself). Only objects near the visible area take part, so huge pages stay fast.
 */
export function snapIndexFor(exclude: Iterable<string> = []): SnapIndex {
  const page = currentPage();
  const ui = U();
  const t = ui.snapTo;
  if (!page) return buildSnapIndex({});
  const ex = new Set(exclude);
  const master = masterOf(S().doc, page);
  let rects: Rect[] = [];
  if (t.objects || t.spacing)
    for (const n of [...(master?.nodes ?? []), ...page.nodes]) {
      if (!n.visible || ex.has(n.id)) continue;
      if (n.type === "RASTER" && !Object.keys(n.tiles).length) continue;
      // a full-page background (imported PDF page, page-size image) only adds lines the page already has
      const b = nodeBounds(n);
      if (b.w <= 0 && b.h <= 0) continue;
      rects.push(b);
    }
  const vr = viewRect();
  rects = nearRect(rects, vr, Math.max(vr.w, vr.h) * 0.5);
  if (rects.length > MAX_OBJECTS) {
    const cx = vr.x + vr.w / 2, cy = vr.y + vr.h / 2;
    rects = rects
      .map((r) => ({ r, d: Math.abs(r.x + r.w / 2 - cx) + Math.abs(r.y + r.h / 2 - cy) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_OBJECTS)
      .map((x) => x.r);
  }
  const g = visibleGuides(page);
  return buildSnapIndex({
    page,
    guides: ui.guides ? mergedGuides({ guides: g.own }, { guides: g.master }) : null,
    grid: ui.grid ? gridFor(page) : null,
    objects: rects,
    use: { grid: t.grid && ui.grid, guide: t.guides && ui.guides, page: t.page, object: t.objects || t.spacing },
  });
}

/** Snap one point (pen, shapes, text boxes, guides) using a fresh index; identity when snapping is off. */
export function snapPt(p: Vec2, e?: { altKey?: boolean }, ix?: SnapIndex, exclude?: Iterable<string>): Vec2 {
  if (!snapOn(e)) return p;
  const r = snapPoint(ix ?? snapIndexFor(exclude), p[0], p[1], snapTol());
  return [r.x, r.y];
}

// ───────── toggles (menus, status bar, shortcuts) ─────────

export function toggleRulers() {
  U().set({ rulers: !U().rulers });
  S().notify(t(U().rulers ? "ribbon.aids.rulersOn" : "ribbon.aids.rulersOff"));
}
export function toggleGuides() {
  U().set({ guides: !U().guides });
  S().notify(t(U().guides ? "ribbon.aids.guidesShow" : "ribbon.aids.guidesHide"));
}
export function toggleGuidesLocked() {
  U().set({ guidesLocked: !U().guidesLocked });
  S().notify(t(U().guidesLocked ? "ribbon.aids.guidesLock" : "ribbon.aids.guidesUnlock"));
}
export function toggleGrid() {
  U().set({ grid: !U().grid });
  S().notify(t(U().grid ? "ribbon.aids.gridOn" : "ribbon.aids.gridOff"));
}
export function toggleSnap() {
  U().set({ snap: !U().snap });
  S().notify(t(U().snap ? "ribbon.aids.snapOn" : "ribbon.aids.snapOff"));
}
