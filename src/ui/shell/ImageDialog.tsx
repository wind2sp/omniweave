// Filter / adjustment dialog (shared by every op in core/image/ops.ts) and the host that mounts the image dialogs.
// Preview runs in the image worker on a ≤420 px copy ("전체") or a 100 % crop of the centre ("100%"), so sliders stay
// live on large photos; "적용" runs the op at full size and commits one undo step.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { curveLut } from "../../core/image/adjust";
import type { ApplyCtx } from "../../core/image/filters";
import { defaultParams, opDef, type OpParams, type ParamSpec } from "../../core/image/ops";
import { cropImg, histogram, type Img } from "../../core/image/pixels";
import { runOps } from "../../core/image/run";
import { applyImageOps, imageTarget, loadSource, opHint, opLabel, paramLabel, paramOptionLabel, paramPartLabel, previewOf } from "../imageActions";
import { useT } from "../../i18n";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";
import { useImageUI } from "./imageMenu";
import { TraceDialog } from "./TraceDialog";
import { MatteDialog } from "./MatteDialog";
import { OcrDialog } from "./OcrDialog";
import { UpscaleDialog } from "./UpscaleDialog";
import { CheckRow, ImgCanvas, RangeRow, imgStyles } from "./imageControls";

/** Mount point for the image dialogs (rendered into <body>, so it can live anywhere in the tree). */
export function ImageDialogs() {
  const open = useImageUI((s) => s.open);
  const set = useImageUI((s) => s.set);
  if (!open || typeof document === "undefined") return null;
  const close = () => set(null);
  return createPortal(
    open.kind === "trace" ? <TraceDialog onClose={close} /> : open.kind === "matte" ? <MatteDialog onClose={close} /> : open.kind === "ocr" ? <OcrDialog onClose={close} /> : open.kind === "upscale" ? <UpscaleDialog onClose={close} /> : <OpDialog key={open.op} opId={open.op} onClose={close} />,
    document.body,
  );
}

// ───────── curve editor ─────────

function CurveEditor({ points, onChange, hist, color }: { points: number[]; onChange: (p: number[]) => void; hist: Uint32Array | null; color: string }) {
  const t = useT();
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<number | null>(null);
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < points.length; i += 2) pts.push([points[i], points[i + 1]]);
  const lut = useMemo(() => curveLut(points), [points]);
  const histPath = useMemo(() => {
    if (!hist) return "";
    let max = 1;
    for (let i = 1; i < 255; i++) max = Math.max(max, hist[i]);
    let d = "M0 256";
    for (let i = 0; i < 256; i++) d += ` L${i} ${256 - Math.min(256, (hist[i] / max) * 220)}`;
    return d + " L255 256 Z";
  }, [hist]);
  const toLocal = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.round(Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255))), Math.round(Math.min(255, Math.max(0, 255 - ((e.clientY - r.top) / r.height) * 255)))];
  };
  const emit = (list: [number, number][]) => onChange(list.flat());
  const move = (i: number, x: number, y: number) => {
    const list = pts.map((p) => [...p] as [number, number]);
    const lo = i > 0 ? list[i - 1][0] + 1 : 0, hi = i < list.length - 1 ? list[i + 1][0] - 1 : 255;
    list[i] = [Math.min(hi, Math.max(lo, x)), y];
    emit(list);
  };
  return (
    <svg
      ref={svg}
      viewBox="-2 -2 260 260"
      style={{ width: "100%", aspectRatio: "1", touchAction: "none", background: "var(--bg-0, #0f1014)", borderRadius: 8, border: "1px solid var(--line-2)", cursor: "crosshair" }}
      onPointerDown={(e) => {
        const [x, y] = toLocal(e);
        let idx = pts.findIndex((p) => Math.abs(p[0] - x) < 8 && Math.abs(p[1] - y) < 12);
        if (idx < 0) {
          if (pts.some((p) => p[0] === x)) return;
          const list = [...pts, [x, lut[x]] as [number, number]].sort((a, b) => a[0] - b[0]);
          idx = list.findIndex((p) => p[0] === x);
          emit(list);
        }
        drag.current = idx;
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current === null) return;
        const [x, y] = toLocal(e);
        move(drag.current, x, y);
      }}
      onPointerUp={() => (drag.current = null)}
      onDoubleClick={(e) => {
        const [x, y] = toLocal(e);
        const idx = pts.findIndex((p) => Math.abs(p[0] - x) < 8 && Math.abs(p[1] - y) < 12);
        if (idx >= 0 && pts.length > 2) emit(pts.filter((_, i) => i !== idx));
      }}
      role="img"
      aria-label={t("image.dlg.curveEditor")}
    >
      {[64, 128, 192].map((v) => (
        <g key={v} stroke="var(--line-2)" strokeWidth={0.6}>
          <line x1={v} y1={0} x2={v} y2={256} />
          <line x1={0} y1={v} x2={256} y2={v} />
        </g>
      ))}
      {histPath && <path d={histPath} fill="var(--text-3)" opacity={0.25} />}
      <line x1={0} y1={256} x2={256} y2={0} stroke="var(--line-2)" strokeDasharray="3 3" />
      <polyline fill="none" stroke={color} strokeWidth={1.6} points={Array.from(lut, (v, i) => `${i},${255 - v}`).join(" ")} />
      {pts.map(([x, y], i) => (
        <rect key={i} x={x - 4} y={255 - y - 4} width={8} height={8} fill="var(--bg-1)" stroke={color} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

function Histogram({ hist }: { hist: Uint32Array | null }) {
  const t = useT();
  if (!hist) return null;
  let max = 1;
  for (let i = 1; i < 255; i++) max = Math.max(max, hist[i]);
  let d = "M0 64";
  for (let i = 0; i < 256; i++) d += ` L${i} ${64 - Math.min(64, (hist[i] / max) * 60)}`;
  return (
    <svg viewBox="0 0 256 64" preserveAspectRatio="none" style={{ width: "100%", height: 56, background: "var(--bg-0, #0f1014)", borderRadius: 6, border: "1px solid var(--line-2)" }} aria-label={t("image.dlg.histogram")}>
      <path d={d + " L255 64 Z"} fill="var(--text-2)" opacity={0.6} />
    </svg>
  );
}

// ───────── op dialog ─────────

const CURVE_COLORS: Record<string, string> = { rgb: "var(--text)", r: "#ff5a5a", g: "#46c46a", b: "#4f8bff" };

interface PreviewSrc {
  thumb: Img;
  thumbCtx: ApplyCtx;
  crop: Img;
  cropCtx: ApplyCtx;
  hist: ReturnType<typeof histogram>;
}

function OpDialog({ opId, onClose }: { opId: string; onClose: () => void }) {
  const t = useT();
  const def = opDef(opId);
  const target = useMemo(() => imageTarget(), []);
  const [params, setParams] = useState<OpParams>(() => defaultParams(opId));
  const [src, setSrc] = useState<PreviewSrc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(true);
  const [view, setView] = useState<"fit" | "crop">("fit");
  const [compare, setCompare] = useState<"after" | "before" | "both">("after");
  const [out, setOut] = useState<Img | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [curveKey, setCurveKey] = useState("rgb");
  const seq = useRef(0);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    loadSource(target.node)
      .then(({ img }) => {
        if (!alive) return;
        const p = previewOf(img, 420);
        const cw = Math.min(img.width, 420), ch = Math.min(img.height, 300);
        const cx = Math.floor((img.width - cw) / 2), cy = Math.floor((img.height - ch) / 2);
        setSrc({ thumb: p.img, thumbCtx: p.ctx, crop: cropImg(img, cx, cy, cw, ch), cropCtx: { scale: 1, fullW: img.width, fullH: img.height, offX: cx, offY: cy }, hist: histogram(p.img) });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [target]);

  useEffect(() => {
    if (!src || !preview) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      const input = view === "fit" ? src.thumb : src.crop;
      runOps(input, [{ op: opId, params }], view === "fit" ? src.thumbCtx : src.cropCtx)
        .then((r) => {
          if (id !== seq.current) return;
          setOut(r.value);
          setMs(r.ms);
          setError(null); // a later successful preview clears an earlier failure
        })
        .catch((e) => id === seq.current && setError(e instanceof Error ? e.message : String(e)));
    }, 40);
    return () => clearTimeout(timer);
  }, [src, params, preview, view, opId]);

  if (!def) return null;
  const set = (k: string, v: number | number[]) => setParams((p) => ({ ...p, [k]: v }));
  const before = src ? (view === "fit" ? src.thumb : src.crop) : null;
  const after = preview ? out : before;
  const titleId = "img-op-title";
  const histFor = (k: string) => (src ? (k === "r" ? src.hist.r : k === "g" ? src.hist.g : k === "b" ? src.hist.b : src.hist.l) : null);

  const control = (s: ParamSpec) => {
    const v = params[s.key];
    switch (s.kind) {
      case "range":
        return <RangeRow key={s.key} label={paramLabel(opId, s)} value={typeof v === "number" ? v : s.def} min={s.min} max={s.max} step={s.step} unit={s.unit} def={s.def} onChange={(x) => set(s.key, x)} />;
      case "toggle":
        return <CheckRow key={s.key} label={paramLabel(opId, s)} checked={!!v} onChange={(x) => set(s.key, x ? 1 : 0)} />;
      case "choice":
        return (
          <div key={s.key} style={imgStyles.row}>
            <span style={imgStyles.rowHead}>{paramLabel(opId, s)}</span>
            <Seg value={String(v)} options={s.options.map((o) => ({ value: String(o.value), label: paramOptionLabel(opId, s, o.value, o.label) }))} onChange={(x) => set(s.key, Number(x))} ariaLabel={paramLabel(opId, s)} />
          </div>
        );
      case "triple": {
        const arr = Array.isArray(v) ? v : s.def;
        return (
          <fieldset key={s.key} style={{ border: "1px solid var(--line-2)", borderRadius: 8, padding: "6px 10px 8px", display: "flex", flexDirection: "column", gap: 6 }}>
            <legend style={{ ...imgStyles.note, padding: "0 4px" }}>{paramLabel(opId, s)}</legend>
            {s.labels.map((lab, i) => (
              <RangeRow key={i} label={paramPartLabel(opId, s, i, lab)}value={arr[i] ?? 0} min={s.min} max={s.max} step={1} onChange={(x) => set(s.key, arr.map((a, j) => (j === i ? x : a)))} />
            ))}
          </fieldset>
        );
      }
      case "curve":
        return null; // rendered once below with a channel switch
    }
  };
  const curveSpecs = def.params.filter((s) => s.kind === "curve");

  return (
    <Modal onClose={busy ? undefined : onClose} labelledBy={titleId} className="image-dialog">
      <style>{".modal.image-dialog{max-width:900px}"}</style>
      <div>
        <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "baseline", gap: 10 }}>
          <h2 id={titleId}>{opLabel(def)}</h2>
          {def.hint && <span style={imgStyles.note}>{opHint(def)}</span>}
        </div>
        <div style={imgStyles.body}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Seg
                value={view}
                options={[
                  { value: "fit", label: t("image.dlg.viewFit"), tip: t("image.dlg.viewFitTip") },
                  { value: "crop", label: t("image.dlg.viewCrop"), tip: t("image.dlg.viewCropTip") },
                ]}
                onChange={setView}
                ariaLabel={t("image.dlg.viewRange")}
              />
              <Seg
                value={compare}
                options={[
                  { value: "after", label: t("image.dlg.after") },
                  { value: "before", label: t("image.original") },
                  { value: "both", label: t("image.dlg.both") },
                ]}
                onChange={setCompare}
                ariaLabel={t("image.dlg.compare")}
              />
            </div>
            <div style={imgStyles.stage}>
              {error ? (
                <span style={{ ...imgStyles.note, color: "var(--danger, #ff6b6b)" }}>{error}</span>
              ) : !src ? (
                <span style={imgStyles.note}>{target ? t("image.loading") : t("image.selectTarget")}</span>
              ) : compare === "both" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, width: "100%", padding: 8 }}>
                  <ImgCanvas img={before} title={t("image.original")} />
                  <ImgCanvas img={after} title={preview ? t("image.dlg.after") : t("image.dlg.afterOff")} />
                </div>
              ) : (
                <ImgCanvas img={compare === "before" ? before : after} />
              )}
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <CheckRow label={t("image.dlg.preview")} checked={preview} onChange={setPreview} />
              {preview && ms !== null && <span style={imgStyles.note}>{t(view === "fit" ? "image.dlg.previewTimeFit" : "image.dlg.previewTimeCrop", { ms: Math.round(ms) })}</span>}
            </div>
          </div>
          <div style={imgStyles.side}>
            {(opId === "levels" || def.group === "auto") && <Histogram hist={src ? src.hist.l : null} />}
            {curveSpecs.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <Seg value={curveKey} options={curveSpecs.map((s) => ({ value: s.key, label: paramLabel(opId, s) }))} onChange={setCurveKey} ariaLabel={t("image.dlg.curveChannel")} />
                <CurveEditor
                  points={(params[curveKey] as number[]) ?? [0, 0, 255, 255]}
                  onChange={(p) => set(curveKey, p)}
                  hist={histFor(curveKey)}
                  color={CURVE_COLORS[curveKey] ?? "var(--accent)"}
                />
                <span style={imgStyles.note}>{t("image.dlg.curveHelp")}</span>
              </div>
            )}
            {def.params.map(control)}
            {!def.params.length && <span style={imgStyles.note}>{t("image.dlg.noParams")}</span>}
          </div>
        </div>
        <div style={imgStyles.foot}>
          <button type="button" className="btn btn-ghost" onClick={() => setParams(defaultParams(opId))} disabled={busy}>
            {t("image.dlg.defaults")}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            data-tip={t("image.dlg.copyTip")}
            onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ op: opId, params }))}
          >
            {t("image.dlg.copy")}
          </button>
          <span style={{ flex: 1 }} />
          <span style={imgStyles.note}>{target?.node.type === "IMAGE" ? t("image.dlg.noteImage") : t("image.dlg.noteRaster")}</span>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("image.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !src}
            onClick={async () => {
              setBusy(true);
              await applyImageOps([{ op: opId, params }]);
              setBusy(false);
              onClose();
            }}
          >
            {busy ? t("image.dlg.applying") : t("image.dlg.apply")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
