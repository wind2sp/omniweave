// Dialogs of the design mode's live appearance and live art (design 2): an effect's options (Round Corners, Offset
// Path, Transform) and the Blend / Repeat options. Work: ui/designLive.ts, ui/designArt.ts.

import { useState } from "react";
import { create } from "zustand";
import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import type { VectorFx } from "../../core/liveVector";
import { applyVectorFx, newFx, useFxDialog } from "../designLive";
import { makeBlend, selectedArt, setArtOptions, useArtOptions } from "../designArt";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });

function Num({ label, value, set, unit, first, min, max, onEnter }: { label: string; value: number; set: (v: number) => void; unit: string; first?: boolean; min?: number; max?: number; onEnter: () => void }) {
  return (
    <label className="tools-opt">
      <span>{label}</span>
      <input type="number" aria-label={label} value={value} step="any" min={min} max={max} data-autofocus={first || undefined} onChange={(e) => set(Number(e.target.value))} onKeyDown={(e) => e.key === "Enter" && onEnter()} style={{ width: 84 }} />
      <span className="muted-note">{unit}</span>
    </label>
  );
}

/** Effect › Stylize › Round Corners, Effect › Path › Offset Path, Effect › Distort & Transform › Transform. */
export function DesignFxDialog() {
  const t = useT();
  const { kind, index, init } = useFxDialog.getState();
  const [fx, setFx] = useState<VectorFx>(() => (init ? { ...init } : newFx(kind)));
  const put = (patch: Partial<VectorFx>) => setFx((f) => ({ ...f, ...patch }) as VectorFx);
  const ok = () => {
    if (!applyVectorFx(fx, index)) useStore.getState().notify(t("design.fx.needPath"));
    close();
  };
  return (
    <Modal labelledBy="dfx-title" className="modal-sm" onClose={close}>
      <h2 id="dfx-title">{t(`design.fx.title.${kind}`)}</h2>
      {fx.kind === "roundCorners" && <Num label={t("design.fx.radius")} value={fx.r} set={(r) => put({ r: Math.max(0, r) })} unit="px" first onEnter={ok} />}
      {fx.kind === "offset" && (
        <>
          <Num label={t("design.fx.offset")} value={fx.d} set={(d) => put({ d })} unit="px" first onEnter={ok} />
          <div className="seg" role="radiogroup" aria-label={t("design.fx.join")}>
            {(["miter", "round", "bevel"] as const).map((j) => (
              <button type="button" key={j} className={(fx.join ?? "miter") === j ? "on" : ""} onClick={() => put({ join: j })}>
                {t(`design.stroke.join.${j}`)}
              </button>
            ))}
          </div>
        </>
      )}
      {fx.kind === "transform" && (
        <>
          <Num label={t("design.fx.sx")} value={fx.sx} set={(sx) => put({ sx })} unit="%" first onEnter={ok} />
          <Num label={t("design.fx.sy")} value={fx.sy} set={(sy) => put({ sy })} unit="%" onEnter={ok} />
          <Num label={t("design.xf.dx")} value={fx.dx} set={(dx) => put({ dx })} unit="px" onEnter={ok} />
          <Num label={t("design.xf.dy")} value={fx.dy} set={(dy) => put({ dy })} unit="px" onEnter={ok} />
          <Num label={t("design.xf.angle")} value={fx.angle} set={(angle) => put({ angle })} unit="°" onEnter={ok} />
          <Num label={t("design.fx.copies")} value={fx.copies} set={(copies) => put({ copies: Math.max(0, Math.min(500, Math.round(copies))) })} unit="" min={0} max={500} onEnter={ok} />
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("design.xf.cancel")}
        </button>
        <button type="button" className="btn btn-primary" onClick={ok}>
          {t("design.xf.ok")}
        </button>
      </div>
    </Modal>
  );
}

/** Which art dialog: Blend Options (for a new blend when `make`) or a repeat's options. */
export const useArtDialog = create<{ which: "blend" | "radial" | "grid" | "mirror"; make: boolean }>(() => ({ which: "blend", make: false }));
export function openArtDialog(which: "blend" | "radial" | "grid" | "mirror", make = false) {
  useArtDialog.setState({ which, make });
  useUI.getState().set({ shellDialog: "designArt" });
}

/** Object › Blend › Blend Options; Object › Repeat › Options. */
export function DesignArtDialog() {
  const t = useT();
  const { which, make } = useArtDialog.getState();
  const g = selectedArt();
  const art = g?.art;
  const blendSteps = art?.kind === "blend" ? art.steps : useArtOptions.blendSteps;
  const [smooth, setSmooth] = useState(blendSteps == null);
  const [orient, setOrient] = useState<"page" | "path">(art?.kind === "blend" ? art.orient ?? "page" : "page");
  const [steps, setSteps] = useState(blendSteps ?? 10);
  const rep = art?.kind === "repeat" ? art : null;
  const [count, setCount] = useState(rep?.count ?? 8);
  const [radius, setRadius] = useState(rep?.radius ?? 0);
  const [rows, setRows] = useState(rep?.rows ?? 3);
  const [cols, setCols] = useState(rep?.cols ?? 3);
  const [gapX, setGapX] = useState(rep?.gapX ?? 10);
  const [gapY, setGapY] = useState(rep?.gapY ?? 10);
  const [axis, setAxis] = useState(rep?.axis ?? 90);
  const ok = () => {
    if (which === "blend") {
      const v = smooth ? null : Math.max(1, Math.min(1000, Math.round(steps)));
      useArtOptions.blendSteps = v;
      if (make) makeBlend(v);
      else if (art?.kind === "blend") setArtOptions({ steps: v, orient: orient === "path" ? "path" : null });
    } else if (which === "radial") setArtOptions({ count: Math.max(2, Math.round(count)), ...(radius > 0 ? { radius } : {}) });
    else if (which === "grid") setArtOptions({ rows: Math.max(1, Math.round(rows)), cols: Math.max(1, Math.round(cols)), gapX, gapY });
    else setArtOptions({ axis, gapX });
    close();
  };
  return (
    <Modal labelledBy="dart-title" className="modal-sm" onClose={close}>
      <h2 id="dart-title">{t(`design.art.title.${which}`)}</h2>
      {which === "blend" && (
        <>
          <div className="seg" role="radiogroup" aria-label={t("design.art.spacing")}>
            <button type="button" className={smooth ? "on" : ""} onClick={() => setSmooth(true)}>
              {t("design.art.smooth")}
            </button>
            <button type="button" className={!smooth ? "on" : ""} onClick={() => setSmooth(false)}>
              {t("design.art.steps")}
            </button>
          </div>
          {!smooth && <Num label={t("design.art.steps")} value={steps} set={setSteps} unit="" first min={1} max={1000} onEnter={ok} />}
          <div className="seg" role="radiogroup" aria-label={t("design.art.orient")}>
            <button type="button" className={orient === "page" ? "on" : ""} onClick={() => setOrient("page")}>
              {t("design.art.orient.page")}
            </button>
            <button type="button" className={orient === "path" ? "on" : ""} onClick={() => setOrient("path")}>
              {t("design.art.orient.path")}
            </button>
          </div>
        </>
      )}
      {which === "radial" && (
        <>
          <Num label={t("design.art.count")} value={count} set={setCount} unit="" first min={2} max={200} onEnter={ok} />
          <Num label={t("design.art.radius")} value={radius} set={setRadius} unit="px" onEnter={ok} />
        </>
      )}
      {which === "grid" && (
        <>
          <Num label={t("design.art.rows")} value={rows} set={setRows} unit="" first min={1} max={100} onEnter={ok} />
          <Num label={t("design.art.cols")} value={cols} set={setCols} unit="" min={1} max={100} onEnter={ok} />
          <Num label={t("design.art.gapX")} value={gapX} set={setGapX} unit="px" onEnter={ok} />
          <Num label={t("design.art.gapY")} value={gapY} set={setGapY} unit="px" onEnter={ok} />
        </>
      )}
      {which === "mirror" && (
        <>
          <Num label={t("design.xf.axis")} value={axis} set={setAxis} unit="°" first onEnter={ok} />
          <Num label={t("design.art.gapX")} value={gapX} set={setGapX} unit="px" onEnter={ok} />
        </>
      )}
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("design.xf.cancel")}
        </button>
        <button type="button" className="btn btn-primary" onClick={ok}>
          {t("design.xf.ok")}
        </button>
      </div>
    </Modal>
  );
}
