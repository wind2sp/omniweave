// Commands of the image mode's Photoshop features (layer masks, adjustment layers, retouching, image size, fill,
// merge / stamp visible, path to selection, desaturate): registered beside the others (commands.ts spreads PS_COMMANDS
// into its list), shown in the image mode's menus (menus.ts), keys in the key table (keymap.ts, rows marked PS).

import { applyImageOps, imageTarget } from "../imageActions";
import { currentPage, draftPage, useStore, chooseTool } from "../../core/store";
import { currentEditMode } from "../editModes";
import { t } from "../../i18n";
import type { Command } from "../commands";
import { ADJ_KINDS, editAdjustment, newAdjustmentLayer, selectedAdjustment } from "./adjustLayers";
import { addLayerMask, applyLayerMask, deleteLayerMask, hasMaskSel, invertLayerMask, maskable, soleSelected, toggleLayerMask, useMaskUI } from "./maskActions";
import { activeMask, hasPixelSelection } from "../pixelSelect";
import { useImageSizeUI } from "./imageSize";
import { useFillUI } from "./FillDialog";
import { mergeVisible, pathToSelection, pathTarget, stampVisible } from "./layerOps";
import { startWarpCommand } from "./psTransform";
import { useSelectMaskUI } from "./SelectMaskDialog";
import { openLayerStyle } from "./LayerStyle";
import { canConvertToSmart, convertToSmartObject } from "./smartConvert";
import { colorModeOf, setColorMode } from "./colorMode";
import { quickMaskOn, toggleQuickMask } from "./quickMask";
import { selectSubject } from "./selectSubject";
import { openLiquify } from "./LiquifyDialog";

const S = () => useStore.getState();
const imageMode = () => currentEditMode() === "IMAGE";
const curPage = () => currentPage();

export const PS_COMMANDS: Command[] = [
  // layer masks (레이어 › 레이어 마스크)
  { id: "layer.mask.reveal", icon: "mask", when: () => maskable(soleSelected()), whyNot: () => t("psfeat.mask.pickLayer"), run: () => void addLayerMask("reveal") },
  { id: "layer.mask.hide", when: () => maskable(soleSelected()), whyNot: () => t("psfeat.mask.pickLayer"), run: () => void addLayerMask("hide") },
  { id: "layer.mask.revealSel", when: () => maskable(soleSelected()) && hasPixelSelection(), whyNot: () => t("selmod.needSelection"), run: () => void addLayerMask("revealSelection") },
  { id: "layer.mask.hideSel", when: () => maskable(soleSelected()) && hasPixelSelection(), whyNot: () => t("selmod.needSelection"), run: () => void addLayerMask("hideSelection") },
  { id: "layer.mask.delete", when: hasMaskSel, whyNot: () => t("psfeat.mask.none"), run: deleteLayerMask },
  { id: "layer.mask.apply", when: hasMaskSel, whyNot: () => t("psfeat.mask.none"), run: applyLayerMask },
  { id: "layer.mask.toggle", when: hasMaskSel, whyNot: () => t("psfeat.mask.none"), checked: () => { const n = soleSelected(); return n?.type === "RASTER" && !!n.mask?.off; }, run: () => toggleLayerMask() },
  { id: "layer.mask.invert", when: () => hasMaskSel() || !!selectedAdjustment(), run: invertLayerMask },
  { id: "layer.mask.edit", when: hasMaskSel, checked: () => { const n = soleSelected(); return !!n && useMaskUI.getState().edit === n.id; }, run: () => { const n = soleSelected(); if (n) useMaskUI.getState().set({ edit: useMaskUI.getState().edit === n.id ? null : n.id }); } },
  // adjustment layers (레이어 › 새 조정 레이어)
  ...ADJ_KINDS.map((k): Command => ({ id: `layer.adjust.${k}`, icon: "sliders", dialog: true, when: () => !!curPage(), label: () => t(`psfeat.adj.${k}`), keywords: () => t("psfeat.adj.keywords"), run: () => newAdjustmentLayer(k) })),
  { id: "layer.adjust.edit", dialog: true, when: () => !!selectedAdjustment(), whyNot: () => t("psfeat.adj.pick"), run: () => { const a = selectedAdjustment(); if (a) editAdjustment(a.id); } },
  // 이미지 › 모드: RGB · 회색조 · CMYK (ui/ps/colorMode.ts)
  ...(["rgb", "gray", "cmyk"] as const).map((m): Command => ({ id: `image.mode.${m}`, when: () => !!curPage() && imageMode(), checked: () => colorModeOf(curPage()) === m, run: () => void setColorMode(m) })),
  // image
  { id: "image.imageSize", dialog: true, when: () => !!curPage(), run: () => useImageSizeUI.getState().set(true) },
  { id: "image.desaturate", when: () => !!imageTarget(), run: () => void applyImageOps([{ op: "hueSaturation", params: { hue: 0, saturation: -100, lightness: 0, colorize: 0 } }]) },
  // layers: merge visible (Ctrl+Shift+E), stamp visible (Ctrl+Alt+Shift+E)
  { id: "image.mergeVisible", when: () => (curPage()?.nodes.filter((n) => n.visible).length ?? 0) > 1, run: () => void mergeVisible() },
  { id: "image.stampVisible", when: () => (curPage()?.nodes.some((n) => n.visible) ?? false), run: () => void stampVisible() },
  // edit: fill (Shift+F5) and content-aware fill
  { id: "edit.fill", dialog: true, when: () => !!curPage() && imageMode(), run: () => useFillUI.getState().set({ open: true, use: "fg" }) },
  { id: "edit.contentAwareFill", dialog: true, when: () => !!activeMask(), whyNot: () => t("selmod.needSelection"), run: () => useFillUI.getState().set({ open: true, use: "content" }) },
  // 레이어 › 고급 개체 › 고급 개체로 변환 (ui/ps/smartConvert.ts)
  { id: "layer.smart.convert", when: canConvertToSmart, whyNot: () => t("psfeat.smart.pick"), run: convertToSmartObject },
  // 레이어 › 레이어 스타일 › 혼합 옵션 (ui/ps/LayerStyle.tsx)
  { id: "layer.style", dialog: true, when: () => S().selection.length === 1, whyNot: () => t("cmd.why.pickLayer"), run: () => openLayerStyle() },
  // 선택 › 선택 및 마스크 (Ctrl+Alt+R)
  { id: "select.selectAndMask", dialog: true, when: () => !!activeMask(), whyNot: () => t("selmod.needSelection"), run: () => useSelectMaskUI.getState().set(true) },
  // 선택 › 빠른 마스크 모드로 편집 (Q) and 선택 › 피사체 (ui/ps/quickMask.ts, selectSubject.ts)
  { id: "select.quickMask", when: () => !!curPage() && imageMode(), checked: quickMaskOn, run: toggleQuickMask },
  { id: "select.subject", when: () => !!curPage() && imageMode(), run: () => void selectSubject() },
  // 필터 › 픽셀 유동화 (Shift+Ctrl+X)
  { id: "filter.liquify", dialog: true, when: () => !!imageTarget(), whyNot: () => t("image.needTarget"), run: openLiquify },
  // 편집 › 변형 › 뒤틀기 (a transform session in warp mode, ui/ps/psTransform.ts)
  { id: "edit.warp", when: () => imageMode() && S().selection.length === 1, whyNot: () => t("cmd.why.pickLayer"), run: startWarpCommand },
  // paths: make a selection from the selected path (Ctrl+Enter)
  { id: "path.toSelection", when: () => !!pathTarget(), whyNot: () => t("psfeat.path.pick"), run: pathToSelection },
  // tools of the W / J / S groups, for the menus and command search
  { id: "tool.spotHeal", icon: "spotHeal", run: () => chooseTool("spotHeal") },
  { id: "tool.heal", icon: "heal", run: () => chooseTool("heal") },
  { id: "tool.patch", icon: "patch", run: () => chooseTool("patch") },
  { id: "tool.clone", icon: "clone", run: () => chooseTool("clone") },
  { id: "tool.quickSelect", icon: "quickSelect", run: () => chooseTool("quickSelect") },
  { id: "tool.polyLasso", icon: "polyLasso", run: () => chooseTool("polyLasso") },
  { id: "tool.objectSelect", icon: "objectSelect", run: () => chooseTool("objectSelect") },
  { id: "tool.vtext", icon: "vtext", run: () => chooseTool("vtext") },
];

void draftPage;
void S;
