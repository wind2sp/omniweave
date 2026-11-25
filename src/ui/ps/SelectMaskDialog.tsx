// 선택 › 선택 및 마스크 (Photoshop's Select and Mask, Ctrl+Alt+R), the basics: the selection's edge refined against the
// picture (가장자리 감지 반경: an edge-aware guided filter in a band round the edge), then 매끄럽게 · 페더 · 대비 · 가장자리
// 이동, previewed as an overlay / on black / on white / black and white, and given out as the selection, a layer mask,
// a new layer or a new layer with a mask. Kernels: core/image/matte/refine.ts (the background remover's own).

import { useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { boxMean, guidedFilter, rgbPlanes, shapeAlpha } from "../../core/image/matte/refine";
import { currentPage } from "../../core/store";
import { useT } from "../../i18n";
import { Modal } from "../shell/Dialogs";
import { Select } from "../shell/controls";
import { RangeRow, imgStyles } from "../shell/imageControls";
import { activeMask, layerViaCopy, samplePixels, setSelection } from "../pixelSelect";
import { addLayerMask } from "./maskActions";


export const useSelectMaskUI = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

export interface RefineOpts {
  radius: number;
  smooth: number;
  feather: number;
  contrast: number;
  shift: number;
}

/** The refined selection (0..255 a pixel, page size) from selection `sel` over the page's pixels `rgba`. */
export function refineSelection(sel: Uint8Array, rgba: Uint8ClampedArray, w: number, h: number, o: RefineOpts): Uint8Array {
  let a = Float32Array.from(sel, (v) => v / 255);
  if (o.radius > 0) {
    // only in a band as wide as the radius round the edge: elsewhere the selection stays as it was
    const band = boxMean(a, w, h, Math.max(1, Math.round(o.radius)));
    const I = rgbPlanes({ width: w, height: h, data: rgba }, w, h);
    const g = guidedFilter(I, a, w, h, Math.max(1, Math.round(o.radius / 2)), 1e-3);
    a = a.map((v, i) => (band[i] > 0.01 && band[i] < 0.99 ? Math.min(1, Math.max(0, g[i])) : v));
  }
  a = shapeAlpha(a, w, h, { smooth: o.smooth, contrast: o.contrast, shift: o.shift }, o.feather);
  return Uint8Array.from(a, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

export function SelectMaskDialog() {
  const open = useSelectMaskUI((s) => s.open);
  if (!open) return null;
  return <SelectMaskBody />;
}

type View = "overlay" | "black" | "white" | "bw";
type Output = "selection" | "mask" | "layer";

function SelectMaskBody() {
  const tt = useT();
  const close = () => useSelectMaskUI.getState().set(false);
  const page = useMemo(currentPage, []);
  const sel = useMemo(activeMask, []);
  const px = useMemo(() => (page ? samplePixels(page, true) : null), [page]);
  const [o, setO] = useState<RefineOpts>({ radius: 0, smooth: 0, feather: 0, contrast: 0, shift: 0 });
  const [view, setView] = useState<View>("overlay");
  const [out, setOut] = useState<Output>("selection");
  const [res, setRes] = useState<Uint8Array | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!sel || !px) return;
    const id = setTimeout(() => setRes(refineSelection(sel.data, px.data, px.w, px.h, o)), 60);
    return () => clearTimeout(id);
  }, [o, sel, px]);
  useEffect(() => {
    const c = cv.current;
    if (!c || !px || !res) return;
    c.width = px.w;
    c.height = px.h;
    const img = new ImageData(px.w, px.h);
    const d = img.data, s = px.data;
    for (let i = 0; i < res.length; i++) {
      const a = res[i] / 255, k = i * 4;
      if (view === "bw") {
        d[k] = d[k + 1] = d[k + 2] = res[i];
      } else if (view === "overlay") {
        // the unselected part under 50 % red (Photoshop's overlay)
        d[k] = s[k] * a + (s[k] * 0.5 + 255 * 0.5) * (1 - a);
        d[k + 1] = s[k + 1] * a + s[k + 1] * 0.5 * (1 - a);
        d[k + 2] = s[k + 2] * a + s[k + 2] * 0.5 * (1 - a);
      } else {
        const bg = view === "black" ? 0 : 255;
        for (let c2 = 0; c2 < 3; c2++) d[k + c2] = s[k + c2] * a + bg * (1 - a);
      }
      d[k + 3] = 255;
    }
    c.getContext("2d")!.putImageData(img, 0, 0);
  }, [res, view, px]);
  const set = (k: keyof RefineOpts) => (v: number) => setO((p) => ({ ...p, [k]: v }));
  const apply = () => {
    if (!sel || !res) return close();
    setSelection({ w: sel.w, h: sel.h, data: res }, "replace");
    close();
    if (out === "mask") addLayerMask("revealSelection");
    else if (out === "layer") layerViaCopy(false);

  };
  return (
    <Modal labelledBy="psm-title" onClose={close} className="image-dialog">
      <style>{".modal.image-dialog{max-width:900px}"}</style>
      <div style={{ padding: "18px 20px 0" }}>
        <h2 id="psm-title">{tt("psfeat.sm.title")}</h2>
        {!sel && <span style={imgStyles.note}>{tt("selmod.needSelection")}</span>}
      </div>
      <div style={imgStyles.body}>
        <div style={imgStyles.stage}>
          <canvas ref={cv} aria-label={tt("psfeat.sm.preview")} style={{ maxWidth: "100%", maxHeight: 420 }} />
        </div>
        <div style={imgStyles.side}>
          <div className="tools-opt">
            <span>{tt("psfeat.sm.view")}</span>
            <Select<View> value={view} width={150} onChange={setView} options={(["overlay", "black", "white", "bw"] as const).map((v) => ({ value: v, label: tt(`psfeat.sm.v.${v}`) }))} />
          </div>
          <RangeRow label={tt("psfeat.sm.radius")} value={o.radius} min={0} max={100} step={1} unit="px" onChange={set("radius")} />
          <RangeRow label={tt("psfeat.sm.smooth")} value={o.smooth} min={0} max={100} step={1} onChange={set("smooth")} />
          <RangeRow label={tt("psfeat.sm.feather")} value={o.feather} min={0} max={100} step={0.5} unit="px" onChange={set("feather")} />
          <RangeRow label={tt("psfeat.sm.contrast")} value={o.contrast} min={0} max={100} step={1} unit="%" onChange={set("contrast")} />
          <RangeRow label={tt("psfeat.sm.shift")} value={o.shift} min={-100} max={100} step={1} unit="%" onChange={set("shift")} />
          <div className="tools-opt">
            <span>{tt("psfeat.sm.output")}</span>
            <Select<Output> value={out} width={170} onChange={setOut} options={(["selection", "mask", "layer"] as const).map((v) => ({ value: v, label: tt(`psfeat.sm.o.${v}`) }))} />
          </div>
        </div>
      </div>
      <div style={imgStyles.foot}>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={close}>
          {tt("pagesetup.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={!sel} onClick={apply}>
          {tt("psfeat.ok")}
        </button>
      </div>
    </Modal>
  );
}
