// Adjustment layers made here (Photoshop's 레이어 › 새 조정 레이어 and the panel's half-moon button): a raster node
// with `adjust` settings (core/image/adjustLayer.ts) that recolours what is below it — nothing is baked into the
// pixels, the settings can be opened again (double-click its thumbnail) and its mask painted like a layer mask. With a
// pixel selection, the selection becomes its mask. The destructive 이미지 › 조정 commands stay as they were.

import { create } from "zustand";
import type { Adjustment, LayerAdjust } from "../../core/image/adjustLayer";
import { maskFromPlane } from "../../core/image/layerMask";
import { currentPage, draftPage, useStore } from "../../core/store";
import { newRaster, type RasterNode } from "../../core/types";
import { t } from "../../i18n";
import { activeMask, deselect } from "../pixelSelect";
import { useMaskUI } from "./maskActions";

const S = () => useStore.getState();

export type AdjKind = "brightness" | "levels" | "curves" | "exposure" | "vibrance" | "hueSat" | "colorBalance" | "blackWhite" | "invert" | "posterize" | "threshold";
export const ADJ_KINDS: AdjKind[] = ["brightness", "levels", "curves", "exposure", "vibrance", "hueSat", "colorBalance", "blackWhite", "invert", "posterize", "threshold"];

const LEVEL0 = { inLo: 0, inHi: 255, outLo: 0, outHi: 255, gamma: 1 };

/** Photoshop's defaults of a new adjustment layer of `kind`. */
export function defaultAdjustment(kind: AdjKind): Adjustment {
  switch (kind) {
    case "brightness":
      return { kind, brightness: 0, contrast: 0, legacy: false };
    case "levels":
      return { kind, ch: [{ ...LEVEL0 }, { ...LEVEL0 }, { ...LEVEL0 }, { ...LEVEL0 }] };
    case "curves":
      return { kind, ch: [{ channel: 0, pts: [[0, 0], [255, 255]] }] };
    case "exposure":
      return { kind, exposure: 0, offset: 0, gamma: 1 };
    case "vibrance":
      return { kind, vibrance: 0, saturation: 0 };
    case "hueSat":
      return { kind, colorize: false, colorizeHsl: [0, 25, 0], master: [0, 0, 0], ranges: [] };
    case "colorBalance":
      return { kind, shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0], preserveLum: true };
    case "blackWhite":
      return { kind, red: 40, yellow: 60, green: 40, cyan: 60, blue: 20, magenta: 80, tint: null };
    case "invert":
      return { kind };
    case "posterize":
      return { kind, levels: 4 };
    case "threshold":
      return { kind, level: 128 };
  }
}

/** The open adjustment properties (node id), and whether it was just made (Cancel then removes it). */
export const useAdjUI = create<{ id: string | null; fresh: boolean; set: (p: { id: string | null; fresh?: boolean }) => void }>((set) => ({
  id: null,
  fresh: false,
  set: (p) => set({ id: p.id, fresh: !!p.fresh }),
}));

/** Name of a new adjustment layer: "명도/대비 1", "레벨 2" … (Photoshop numbers them per kind). */
function nextName(kind: AdjKind, nodes: { name: string }[]): string {
  const base = t(`psfeat.adj.${kind}`);
  let n = 1;
  while (nodes.some((x) => x.name === `${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** 레이어 › 새 조정 레이어 › `kind`: above the selected layer (in its group), the properties opened. */
export function newAdjustmentLayer(kind: AdjKind) {
  const page = currentPage();
  if (!page) return;
  const s = S();
  const r: RasterNode = { ...newRaster(nextName(kind, page.nodes)), tiles: {} };
  r.adjust = { adj: defaultAdjustment(kind), hide: true, edited: true } as LayerAdjust;
  // a pixel selection becomes the mask (white inside): Photoshop
  const sel = activeMask();
  if (sel) {
    r.tiles = maskFromPlane(sel.data, 0, 0, sel.w, sel.h, true);
    deselect();
  }
  const at = page.nodes.reduce((m, n, i) => (s.selection.includes(n.id) ? i : m), page.nodes.length - 1);
  const above = page.nodes[at];
  if (above?.groupId) r.groupId = above.groupId;
  s.commit(t("psfeat.adj.hist.new", { name: r.name }), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) pg.nodes.splice(at + 1, 0, r as any);
  });
  s.set({ selection: [r.id] });
  useMaskUI.getState().set({ edit: null });
  useAdjUI.getState().set({ id: r.id, fresh: true });
}

/** Open the properties of an adjustment layer (double-click on its thumbnail). */
export function editAdjustment(id: string) {
  const n = currentPage()?.nodes.find((x) => x.id === id);
  if (n?.type !== "RASTER" || !n.adjust) return;
  S().set({ selection: [id] });
  useAdjUI.getState().set({ id });
}

/** The selected adjustment layer, or null. */
export function selectedAdjustment(): RasterNode | null {
  const s = S();
  const page = currentPage();
  if (!page || s.selection.length !== 1) return null;
  const n = page.nodes.find((x) => x.id === s.selection[0]);
  return n?.type === "RASTER" && n.adjust ? n : null;
}
