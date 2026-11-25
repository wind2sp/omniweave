// Illustrator's Object › Transform dialogs (Move · Rotate · Reflect · Scale) and Object › Path › Offset Path: one small
// dialog with the dialog's fields, OK and Copy (the result as a copy above). Work: ui/designPathOps.ts.

import { useState } from "react";
import { create } from "zustand";
import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { offsetPath, transformSelection, type TransformKind } from "../designPathOps";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

export type DesignXformKind = TransformKind | "offset";
export const useDesignXform = create<{ kind: DesignXformKind; origin?: [number, number] }>(() => ({ kind: "move" }));

/** Open the dialog of `kind` (the commands xform.* / path.offset). */
export function openDesignXform(kind: DesignXformKind, origin?: [number, number]) {
  // origin: the reference point an Alt+click of the R / O / S tool set (the centre otherwise)
  useDesignXform.setState({ kind, origin });
  useUI.getState().set({ shellDialog: "designXform" });
}

const close = () => useUI.getState().set({ shellDialog: null });

export function DesignXformDialog() {
  const t = useT();
  const kind = useDesignXform((s) => s.kind);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [angle, setAngle] = useState(kind === "reflect" ? 90 : kind === "shear" ? 15 : 45);
  const [sx, setSx] = useState(100);
  const [sy, setSy] = useState(100);
  const [uniform, setUniform] = useState(true);
  const [offset, setOffset] = useState(5);
  // Shear: the axis angle (0 = horizontal, 90 = vertical; design 2)
  const [axis, setAxis] = useState(0);
  const apply = (copy: boolean) => {
    const n =
      kind === "offset"
        ? offsetPath(offset)
        : transformSelection(kind, { ...(kind === "move" ? { dx, dy } : kind === "scale" ? { sx, sy: uniform ? sx : sy } : kind === "shear" ? { angle, axis } : { angle }), origin: useDesignXform.getState().origin }, copy);
    if (!n) useStore.getState().notify(t("cmd.why.pickLayer"));
    close();
  };
  const num = (label: string, v: number, set: (x: number) => void, unit: string, first = false) => (
    <label className="tools-opt">
      <span>{t(label)}</span>
      <input type="number" aria-label={t(label)} value={v} step="any" data-autofocus={first || undefined} onChange={(e) => set(Number(e.target.value))} onKeyDown={(e) => e.key === "Enter" && apply(false)} style={{ width: 84 }} />
      <span className="muted-note">{unit}</span>
    </label>
  );
  return (
    <Modal labelledBy="dxf-title" className="modal-sm" onClose={close}>
      <h2 id="dxf-title">{t(`design.xf.title.${kind}`)}</h2>
      {kind === "move" && (
        <>
          {num("design.xf.dx", dx, setDx, "px", true)}
          {num("design.xf.dy", dy, setDy, "px")}
        </>
      )}
      {kind === "rotate" && num("design.xf.angle", angle, setAngle, "°", true)}
      {kind === "reflect" && (
        <>
          <div className="seg" role="radiogroup">
            <button type="button" className={angle === 0 ? "on" : ""} onClick={() => setAngle(0)}>
              {t("design.xf.horizontal")}
            </button>
            <button type="button" className={angle === 90 ? "on" : ""} onClick={() => setAngle(90)}>
              {t("design.xf.vertical")}
            </button>
          </div>
          {num("design.xf.axis", angle, setAngle, "°", true)}
        </>
      )}
      {kind === "scale" && (
        <>
          <label className="tools-opt">
            <input type="checkbox" checked={uniform} onChange={(e) => setUniform(e.target.checked)} />
            <span>{t("design.xf.uniform")}</span>
          </label>
          {num("design.xf.sx", sx, setSx, "%", true)}
          {!uniform && num("design.xf.sy", sy, setSy, "%")}
        </>
      )}
      {kind === "shear" && (
        <>
          {num("design.xf.shearAngle", angle, setAngle, "°", true)}
          <div className="seg" role="radiogroup" aria-label={t("design.xf.axis")}>
            <button type="button" className={axis === 0 ? "on" : ""} onClick={() => setAxis(0)}>
              {t("design.xf.horizontal")}
            </button>
            <button type="button" className={axis === 90 ? "on" : ""} onClick={() => setAxis(90)}>
              {t("design.xf.vertical")}
            </button>
          </div>
          {num("design.xf.axis", axis, setAxis, "°")}
        </>
      )}
      {kind === "offset" && num("design.xf.offset", offset, setOffset, "px", true)}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("design.xf.cancel")}
        </button>
        {kind !== "offset" && (
          <button type="button" className="btn btn-ghost" onClick={() => apply(true)}>
            {t("design.xf.copy")}
          </button>
        )}
        <button type="button" className="btn btn-primary" onClick={() => apply(false)}>
          {t("design.xf.ok")}
        </button>
      </div>
    </Modal>
  );
}
