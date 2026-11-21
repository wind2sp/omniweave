// "이미지" menu (filters, adjustments, image trace) and the state of its dialogs.
// Kept apart from uiStore so the image department does not touch shared shell state.

import { create } from "zustand";
import { OPS, defaultParams, type OpGroup } from "../../core/image/ops";
import { applyImageOps, imageTarget, opHint, opLabel } from "../imageActions";
import { removeBackgroundSelection } from "../matteActions";
import { t } from "../../i18n";
import type { MenuItem } from "./controls";

export type ImageDialogState = { kind: "op"; op: string } | { kind: "trace" } | { kind: "matte" } | { kind: "ocr" } | { kind: "upscale" } | null;

export const useImageUI = create<{ open: ImageDialogState; set: (open: ImageDialogState) => void }>((set) => ({
  open: null,
  set: (open) => set({ open }),
}));

/** ops applied at once from the menu (no settings worth a dialog) */
const INSTANT = new Set(["invert", "autoLevels", "autoContrast", "autoColor"]);

/** menu sections in order; headings are `image.menu.group.<group>` */
const GROUPS: OpGroup[] = ["adjust", "auto", "blur", "sharpen", "noise", "stylize"];

/**
 * Adjustments and filters; `withTrace` adds Image Trace on top (the Object menu has its own). `groups` limits the op
 * groups (the image mode's 이미지 ▸ 조정 vs 필터 menus); OCR comes with the full list and with the filter groups.
 */
export function imageMenuItems(withTrace = true, groups: OpGroup[] = GROUPS): MenuItem[] {
  const target = imageTarget();
  const disabled = !target;
  const items: MenuItem[] = [];
  if (disabled) items.push({ heading: t("image.menu.needTarget") });
  if (withTrace) items.push({ label: t("image.menu.trace"), icon: "pen", hint: t("image.menu.traceHint"), disabled, onSelect: () => useImageUI.getState().set({ kind: "trace" }) });
  if (groups === GROUPS || !groups.includes("adjust")) items.push({ label: `${t("ocr.menu")}…`, hint: t("ocr.menuHint"), disabled, onSelect: () => useImageUI.getState().set({ kind: "ocr" }) });
  // background removal is in the menu as commands (image.removeBackground / …Dialog); other panels use matteMenuItems
  for (const g of GROUPS.filter((x) => groups.includes(x))) {
    if (items.length) items.push({ sep: true });
    items.push({ heading: t(`image.menu.group.${g}`) });
    for (const def of OPS.filter((o) => o.group === g)) {
      const instant = INSTANT.has(def.id);
      items.push({
        label: instant ? opLabel(def) : `${opLabel(def)}…`,
        hint: opHint(def),
        disabled,
        onSelect: () => (instant ? void applyImageOps([{ op: def.id, params: defaultParams(def.id) }]) : useImageUI.getState().set({ kind: "op", op: def.id })),
      });
    }
  }
  return items;
}

/** Background removal: one click (automatic type) and the refine dialog. Also usable by other menus / panels. */
export function matteMenuItems(disabled = !imageTarget()): MenuItem[] {
  return [
    { heading: t("image.matte.menu.group") },
    { label: t("image.matte.menu.auto"), hint: t("image.matte.menu.autoHint"), disabled, onSelect: () => void removeBackgroundSelection() },
    { label: `${t("image.matte.title")}…`, hint: t("image.matte.menu.dialogHint"), disabled, onSelect: () => useImageUI.getState().set({ kind: "matte" }) },
  ];
}
