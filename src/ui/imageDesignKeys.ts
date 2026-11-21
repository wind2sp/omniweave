// Keys of the image (Photoshop) and design (Illustrator) edit modes, bound to the mode profile (ui/editModes.ts).
// shell/shortcuts.ts asks here first (not while typing, not over a dialog); true = handled. Documents and slides
// never get these (their profiles have no tool letters and their Ctrl keys mean Word / PowerPoint things).

import { selectedNodes, useStore } from "../core/store";
import { currentEditMode } from "./editModes";
import { updateSelected } from "./actions";
import { useUI } from "./shell/uiStore";
import { useGroupLast } from "./shell/ToolGroup";
import { t } from "../i18n";
import {
  clearSelectionPixels, defaultColors, deselect, fillSelection, hasPixelSelection, invertSelection, layerViaCopy, reselect, selectAllPixels, swapColors, usePixelSel,
} from "./pixelSelect";
import { joinSelected } from "./pathTools";
import { defaultSwatches, exitIsolation, hideSelection, lockSelection, swapFillStroke, swatchNone, toggleOutline, toggleSwatchFocus, unlockAll, useDesign } from "./designTools";

const S = () => useStore.getState();

/** Tab: hide / show both panels (Photoshop and Illustrator). */
function togglePanels() {
  const ui = useUI.getState();
  const open = ui.leftOpen || ui.rightOpen;
  ui.set({ leftOpen: !open, rightOpen: !open });
}

/** Number keys (Photoshop): 1 = 10 % … 9 = 90 %, 0 = 100 % — the brush's opacity with a painting tool, else the layers'. */
function opacityKey(digit: number) {
  const v = digit === 0 ? 1 : digit / 10;
  const s = S();
  if (s.tool === "brush" || s.tool === "eraser" || s.tool === "gradient") return s.set({ brush: { ...s.brush, opacity: v } });
  if (!selectedNodes().length) return;
  updateSelected(t("ribbon.opacity"), (n) => (n.opacity = v));
  s.notify(`${t("ribbon.opacity")} ${Math.round(v * 100)}%`);
}

export function imageDesignKey(e: KeyboardEvent, k: string): boolean {
  const mode = currentEditMode();
  if (mode !== "IMAGE" && mode !== "DESIGN") return false;
  const mod = e.ctrlKey || e.metaKey;
  const s = S();

  if (e.key === "Tab" && !mod && !e.altKey && !e.shiftKey) return togglePanels(), true;

  if (mode === "IMAGE") {
    if (mod && !e.altKey) {
      if (k === "a" && !e.shiftKey) return selectAllPixels(), true;
      if (k === "d") return (e.shiftKey ? reselect() : deselect()), true;
      if (k === "i" && e.shiftKey) return invertSelection(), true;
      if (k === "j" && hasPixelSelection()) return layerViaCopy(e.shiftKey), true;
      if (e.key === "Backspace" && !e.shiftKey) return fillSelection("bg"), true;
      return false;
    }
    if (mod) return false;
    if (e.altKey && !e.shiftKey && (e.key === "Backspace" || e.key === "Delete")) return fillSelection("fg"), true;
    if (e.altKey) return false;
    if ((e.key === "Delete" || e.key === "Backspace") && hasPixelSelection()) return clearSelectionPixels(), true;
    if (e.repeat) return false;
    if (k === "d" && !e.shiftKey) return defaultColors(), true;
    if (k === "x" && !e.shiftKey) return swapColors(), true;
    // Shift+M: the other marquee shape
    if (k === "m" && e.shiftKey) {
      const ps = usePixelSel.getState();
      ps.set({ marquee: ps.marquee === "rect" ? "ellipse" : "rect" });
      s.set({ tool: "marquee" });
      return true;
    }
    // Shift+P: the next pen of the pen group (Photoshop cycles 펜 ↔ 곡률 펜; from another tool, the one after the face)
    if (k === "p" && e.shiftKey) {
      const cur = s.tool === "pen" || s.tool === "curvature" ? s.tool : useGroupLast.getState().last.pen === "curvature" ? "curvature" : "pen";
      s.set({ tool: cur === "pen" ? "curvature" : "pen" });
      return true;
    }
    if ((e.key === "[" || e.key === "]" || e.key === "{" || e.key === "}") && e.shiftKey) {
      // Shift+[ ]: softer / harder brush, 25 % steps as in Photoshop
      const h = Math.max(0, Math.min(1, Math.round((s.brush.hardness + (e.code === "BracketRight" ? 0.25 : -0.25)) * 4) / 4));
      s.set({ brush: { ...s.brush, hardness: h } });
      return true;
    }
    if (/^Digit[0-9]$/.test(e.code) && !e.shiftKey) return opacityKey(Number(e.code.slice(5))), true;
    return false;
  }

  // DESIGN
  if (mod && !e.shiftKey) {
    if (e.code === "KeyY" && !e.altKey) return toggleOutline(), true;
    // Ctrl+J: join the selected end points / close the selected open paths (Illustrator) — never the layer copy of
    // the image mode, even when there is nothing to join
    if (e.code === "KeyJ" && !e.altKey) return joinSelected(), true;
    if (e.code === "Digit2") return (e.altKey ? unlockAll("locked") : lockSelection()), true;
    if (e.code === "Digit3") return (e.altKey ? unlockAll("visible") : hideSelection()), true;
    return false;
  }
  if (mod || e.altKey || e.repeat) return false;
  if (e.key === "Escape" && useDesign.getState().isolated) return exitIsolation(), true;
  if (k === "x") return (e.shiftKey ? swapFillStroke() : toggleSwatchFocus()), true;
  if (e.key === "/" && !e.shiftKey) return swatchNone(), true;
  if (k === "d" && !e.shiftKey) return defaultSwatches(), true;
  return false;
}
