// Layer masks in the image mode (Photoshop): add (모두 나타내기 · 모두 숨기기 · 선택 영역 나타내기 / 숨기기), paint on the
// mask (the brush / eraser paint grey into it while the mask thumbnail is the target), Shift+click turns it off,
// Alt+click shows it alone, apply bakes it into the pixels, delete drops it. The model: core/image/layerMask.ts.

import { create } from "zustand";
import { applyTransform, invertTransform } from "../../core/geom";
import { applyMask, invertMask, maskFromPlane, newMask, type LayerMask } from "../../core/image/layerMask";
import { currentPage, draftPage, useStore } from "../../core/store";
import { TILE } from "../../core/tile";
import type { Page, RasterNode, SceneNode, Transform } from "../../core/types";
import { t } from "../../i18n";
import { activeMask, deselect, rasterizeLayer } from "../pixelSelect";

const S = () => useStore.getState();

interface MaskUI {
  /** layer whose mask is the paint target (its mask thumbnail framed), null = the layer's pixels */
  edit: string | null;
  /** layer whose mask is shown alone, in grey, on the canvas (Alt+click on the thumbnail) */
  view: string | null;
  set: (p: Partial<MaskUI>) => void;
}
export const useMaskUI = create<MaskUI>((set) => ({ edit: null, view: null, set: (p) => set(p) }));

/** The one selected layer, or null. */
export function soleSelected(page = currentPage()): SceneNode | null {
  const sel = S().selection;
  if (!page || sel.length !== 1) return null;
  return page.nodes.find((n) => n.id === sel[0]) ?? null;
}

/** A layer that can take a pixel layer mask: pixels, pictures, shapes, text (made pixels first), not adjustment layers. */
export function maskable(n: SceneNode | null): boolean {
  return !!n && !n.locked && (n.type === "RASTER" ? !n.adjust && !n.mask : n.type === "IMAGE" || n.type === "VECTOR" || n.type === "TEXT");
}

/** The selected layer's mask (a pixel layer's mask, or an adjustment layer's own), or null. */
export function maskOf(n: SceneNode | null | undefined): LayerMask | null {
  if (!n || n.type !== "RASTER") return null;
  if (n.adjust) return { tiles: n.tiles, hide: n.adjust.hide };
  return n.mask ?? null;
}

/** Is the mask (not the pixels) the paint target of `n` now? An adjustment layer always paints its mask. */
export function paintsMask(n: SceneNode | null | undefined): boolean {
  if (!n || n.type !== "RASTER") return false;
  if (n.adjust) return true;
  return !!n.mask && useMaskUI.getState().edit === n.id;
}

/** Node-local pixel box covering the page (and the layer's own tiles). */
export function localPageBox(tr: Transform, page: { width: number; height: number }, tiles?: Record<string, unknown>): { x: number; y: number; w: number; h: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of [[0, 0], [page.width, 0], [0, page.height], [page.width, page.height]] as [number, number][]) {
    const [x, y] = invertTransform(tr, p);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  for (const k of Object.keys(tiles ?? {})) {
    const u = k.indexOf("_");
    const tx = +k.slice(0, u), ty = +k.slice(u + 1);
    x0 = Math.min(x0, tx * TILE); y0 = Math.min(y0, ty * TILE); x1 = Math.max(x1, (tx + 1) * TILE); y1 = Math.max(y1, (ty + 1) * TILE);
  }
  x0 = Math.floor(x0); y0 = Math.floor(y0);
  return { x: x0, y: y0, w: Math.max(1, Math.ceil(x1) - x0), h: Math.max(1, Math.ceil(y1) - y0) };
}

/** The pixel selection as a mask plane in the layer's own pixels (255 inside), over `box`. */
function selectionPlane(page: Page, n: RasterNode, box: { x: number; y: number; w: number; h: number }, inside: boolean): Uint8Array | null {
  const sel = activeMask();
  if (!sel) return null;
  const out = new Uint8Array(box.w * box.h);
  const simple = n.transform.rotation === 0 && n.transform.scale === 1 && (n.transform.scaleY ?? 1) === 1;
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const [px, py] = simple ? [box.x + x + n.transform.x, box.y + y + n.transform.y] : applyTransform(n.transform, [box.x + x + 0.5, box.y + y + 0.5]);
      const ix = Math.floor(px), iy = Math.floor(py);
      const v = ix >= 0 && iy >= 0 && ix < sel.w && iy < sel.h ? sel.data[iy * sel.w + ix] : 0;
      out[y * box.w + x] = inside ? v : 255 - v;
    }
  void page;
  return out;
}

export type AddMaskKind = "reveal" | "hide" | "revealSelection" | "hideSelection";

/**
 * Add a layer mask to the selected layer (a picture, shape or text layer becomes pixels first, as Photoshop asks
 * for a smart object). The panel's mask button: with a selection, the selection shows (Alt: hides); without, all.
 */
export function addLayerMask(kind: AddMaskKind): boolean {
  const page = currentPage();
  let n = soleSelected(page);
  if (!page || !n) return void S().notify(t("psfeat.mask.pickLayer")), false;
  if (n.type === "RASTER" && n.mask) return void S().notify(t("psfeat.mask.already")), false;
  if (!maskable(n)) return void S().notify(t("psfeat.mask.cannot")), false;
  if (n.type !== "RASTER") {
    const r = rasterizeLayer(page, n);
    if (!r) return false;
    n = r;
  }
  const r = n as RasterNode;
  const pg = currentPage()!;
  let mask: LayerMask;
  if ((kind === "revealSelection" || kind === "hideSelection") && activeMask()) {
    const box = localPageBox(r.transform, pg, r.tiles);
    const plane = selectionPlane(pg, r, box, kind === "revealSelection")!;
    mask = { tiles: maskFromPlane(plane, box.x, box.y, box.w, box.h, true), hide: true };
    deselect();
  } else mask = newMask(kind === "hide" || kind === "hideSelection" ? "hide" : "reveal");
  S().commit(t("psfeat.mask.hist.add"), (d) => {
    const x = draftPage(d, pg.id)?.nodes.find((q) => q.id === r.id) as RasterNode | undefined;
    if (x) x.mask = mask as any;
  });
  useMaskUI.getState().set({ edit: r.id });
  return true;
}

function updateMasked(label: string, f: (n: RasterNode) => void) {
  const page = currentPage();
  const n = soleSelected(page);
  if (!page || !n || n.type !== "RASTER" || !n.mask) return void S().notify(t("psfeat.mask.none"));
  S().commit(label, (d) => {
    const x = draftPage(d, page.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
    if (x) f(x);
  });
}

export const hasMaskSel = () => {
  const n = soleSelected();
  return !!n && n.type === "RASTER" && !!n.mask;
};

/** 레이어 마스크 삭제. */
export function deleteLayerMask() {
  updateMasked(t("psfeat.mask.hist.delete"), (x) => void delete x.mask);
  useMaskUI.getState().set({ edit: null, view: null });
}

/** 레이어 마스크 적용: the mask baked into the pixels, then dropped. */
export function applyLayerMask() {
  const n = soleSelected();
  if (!n || n.type !== "RASTER" || !n.mask) return void S().notify(t("psfeat.mask.none"));
  const tiles = applyMask(n);
  updateMasked(t("psfeat.mask.hist.apply"), (x) => {
    x.tiles = tiles as any;
    delete x.mask;
  });
  useMaskUI.getState().set({ edit: null, view: null });
}

/** Shift+click on the mask thumbnail: 레이어 마스크 사용 안 함 / 사용. */
export function toggleLayerMask(id?: string) {
  const page = currentPage();
  const n = id ? page?.nodes.find((q) => q.id === id) : soleSelected(page);
  if (!page || !n || n.type !== "RASTER" || !n.mask) return void S().notify(t("psfeat.mask.none"));
  const off = !n.mask.off;
  S().commit(t(off ? "psfeat.mask.hist.off" : "psfeat.mask.hist.on"), (d) => {
    const x = draftPage(d, page.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
    if (!x?.mask) return;
    if (off) x.mask.off = true;
    else delete x.mask.off;
  });
  S().notify(t(off ? "psfeat.mask.offToast" : "psfeat.mask.onToast"));
}

/** Ctrl+I with the mask as the target: invert the mask. */
export function invertLayerMask() {
  const page = currentPage();
  const n = soleSelected(page);
  if (!page || !n || n.type !== "RASTER") return;
  if (n.adjust) {
    S().commit(t("psfeat.mask.hist.invert"), (d) => {
      const x = draftPage(d, page.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
      if (x?.adjust) x.adjust.hide = !x.adjust.hide;
    });
    return;
  }
  if (!n.mask) return;
  const m = invertMask(n.mask);
  updateMasked(t("psfeat.mask.hist.invert"), (x) => void (x.mask = m as any));
}

/** Click on a layer's thumbnails (Photoshop): the mask thumbnail targets the mask, the layer thumbnail the pixels. */
export function targetMask(id: string, mask: boolean) {
  S().set({ selection: [id] });
  useMaskUI.getState().set({ edit: mask ? id : null });
}

/** Alt+click on the mask thumbnail: show the mask alone in grey (again: back to the picture). */
export function toggleMaskView(id: string) {
  const ui = useMaskUI.getState();
  ui.set({ view: ui.view === id ? null : id, edit: id });
  S().set({ selection: [id] });
}

// a layer that went away or lost its mask is no target any more
useStore.subscribe((s, p) => {
  if (s.doc === p.doc && s.selection === p.selection) return;
  const ui = useMaskUI.getState();
  if (!ui.edit && !ui.view) return;
  const page = s.doc.pages.find((x) => x.id === s.pageId);
  const ok = (id: string | null) => {
    if (!id) return null;
    const n = page?.nodes.find((q) => q.id === id);
    return n && n.type === "RASTER" && (n.mask || n.adjust) && s.selection.includes(id) ? id : null;
  };
  const edit = ok(ui.edit), view = ok(ui.view);
  if (edit !== ui.edit || view !== ui.view) ui.set({ edit, view });
});
