// 선택 › 색상 범위… / 수정 ▸ 확대 · 축소 · 페더 · 테두리… (image mode, Photoshop's Select menu): one small dialog with a
// number (px, or the fuzziness) and, for the colour range, the colour (the foreground colour to start with).
// Work: ui/pixelSelect.ts (modifySelection, selectColorRange).

import { useState } from "react";
import { create } from "zustand";
import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { modifySelection, selectColorRange } from "../pixelSelect";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

export type SelModifyKind = "expand" | "contract" | "feather" | "border" | "colorRange";
export const useSelModify = create<{ kind: SelModifyKind }>(() => ({ kind: "expand" }));

const close = () => useUI.getState().set({ shellDialog: null });
const DEFAULT: Record<SelModifyKind, number> = { expand: 4, contract: 4, feather: 8, border: 6, colorRange: 40 };

const rgbOf = (hex: string): [number, number, number] => {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex)?.[1] ?? "000000";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
};

export function SelectModifyDialog() {
  const t = useT();
  const kind = useSelModify((s) => s.kind);
  const [value, setValue] = useState(DEFAULT[kind]);
  const [color, setColor] = useState(() => useStore.getState().brush.color);
  const range = kind === "colorRange";
  const apply = () => {
    const ok = range ? selectColorRange(rgbOf(color), value) : modifySelection(kind, value);
    if (!ok) useStore.getState().notify(t(range ? "selmod.none" : "selmod.needSelection"));
    close();
  };
  return (
    <Modal labelledBy="selmod-title" className="modal-sm" onClose={close}>
      <h2 id="selmod-title">{t(`selmod.title.${kind}`)}</h2>
      <p className="modal-sub">{t(`selmod.sub.${kind}`)}</p>
      {range && (
        <label className="tools-opt">
          <span>{t("selmod.color")}</span>
          <input type="color" aria-label={t("selmod.color")} value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
      )}
      <label className="tools-opt">
        <span>{t(range ? "selmod.fuzziness" : "selmod.amount")}</span>
        <input type="number" aria-label={t(range ? "selmod.fuzziness" : "selmod.amount")} min={range ? 0 : 1} max={range ? 200 : 500} value={value} data-autofocus onChange={(e) => setValue(Number(e.target.value))} onKeyDown={(e) => e.key === "Enter" && apply()} style={{ width: 84 }} />
        {!range && <span className="muted-note">px</span>}
      </label>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("pagesetup.cancel")}
        </button>
        <button type="button" className="btn btn-primary" onClick={apply}>
          {t("canvas.size.apply")}
        </button>
      </div>
    </Modal>
  );
}
