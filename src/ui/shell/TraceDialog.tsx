// Image Trace dialog: presets, options, live preview on a ≤360 px copy (worker), path / anchor counts.
// "추적" runs the full-size trace and inserts editable vector nodes above the source (one undo step).

import { useEffect, useMemo, useRef, useState } from "react";
import { downscale, type Img } from "../../core/image/pixels";
import { runTrace } from "../../core/image/run";
import { TRACE_PRESETS, presetOptions, type TraceOptions, type TraceResult } from "../../core/image/trace";
import { contourToSvgD } from "../../core/vector";
import { imageTarget, loadSource, traceSelection } from "../imageActions";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";
import { CheckRow, RangeRow, imgStyles } from "./imageControls";
import { useT } from "../../i18n";

const PREVIEW_SIDE = 360;

function TracePreview({ img, res, view, fill }: { img: Img | null; res: TraceResult | null; view: "result" | "source" | "paths"; fill: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !img) return;
    c.width = img.width * 2;
    c.height = img.height * 2;
    const g = c.getContext("2d")!;
    g.clearRect(0, 0, c.width, c.height);
    if (view === "source" || !res) {
      const tmp = document.createElement("canvas");
      tmp.width = img.width;
      tmp.height = img.height;
      tmp.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
      g.imageSmoothingEnabled = false;
      g.drawImage(tmp, 0, 0, c.width, c.height);
      return;
    }
    g.scale(2, 2);
    for (const l of res.layers) {
      const p = new Path2D(l.contours.map(contourToSvgD).join(" "));
      if (view === "paths") {
        g.strokeStyle = "#4f7cff";
        g.lineWidth = 0.6;
        g.stroke(p);
        g.fillStyle = "#4f7cff";
        for (const ct of l.contours) for (const n of ct.nodes) g.fillRect(n.anchor[0] - 0.8, n.anchor[1] - 0.8, 1.6, 1.6);
      } else if (fill) {
        g.fillStyle = l.color;
        g.fill(p, "evenodd");
      } else {
        g.strokeStyle = l.color;
        g.lineWidth = 0.75;
        g.stroke(p);
      }
    }
  }, [img, res, view, fill]);
  return <canvas ref={ref} style={{ maxWidth: "100%", maxHeight: 420, display: img ? "block" : "none" }} />;
}

export function TraceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const target = useMemo(() => imageTarget(), []);
  const [preset, setPreset] = useState("logo");
  const [opts, setOpts] = useState<TraceOptions>(() => presetOptions("logo"));
  const [thumb, setThumb] = useState<{ img: Img; scale: number; full: { w: number; h: number } } | null>(null);
  const [res, setRes] = useState<TraceResult | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"result" | "source" | "paths">("result");
  const [hideSource, setHideSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    loadSource(target.node)
      .then(({ img }) => {
        if (!alive) return;
        const d = downscale(img, PREVIEW_SIDE);
        setThumb({ img: d.img, scale: d.scale, full: { w: img.width, h: img.height } });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [target]);

  useEffect(() => {
    if (!thumb) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      // spatial options follow the preview scale: areas by scale², smoothing by scale
      const k = thumb.scale;
      const po: TraceOptions = { ...opts, minArea: Math.max(1, opts.minArea * k * k), smooth: opts.smooth * k };
      runTrace(thumb.img, po)
        .then((r) => {
          if (id !== seq.current) return;
          setRes(r.value);
          setMs(r.ms);
          setError(null); // a later successful preview clears an earlier failure
        })
        .catch((e) => id === seq.current && setError(e instanceof Error ? e.message : String(e)));
    }, 80);
    return () => clearTimeout(timer);
  }, [thumb, opts]);

  const set = <K extends keyof TraceOptions>(k: K, v: TraceOptions[K]) => {
    setOpts((o) => ({ ...o, [k]: v }));
    setPreset("custom");
  };
  const titleId = "trace-title";

  return (
    <Modal onClose={busy ? undefined : onClose} labelledBy={titleId} className="image-dialog">
      <style>{".modal.image-dialog{max-width:900px}"}</style>
      <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "baseline", gap: 10 }}>
        <h2 id={titleId}>{t("image.trace.title")}</h2>
        <span style={imgStyles.note}>{t("image.trace.subtitle")}</span>
      </div>
      <div style={imgStyles.body}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <Seg value={view} options={[{ value: "result", label: t("image.trace.viewResult") }, { value: "paths", label: t("image.trace.viewPaths") }, { value: "source", label: t("image.original") }]} onChange={setView} ariaLabel={t("image.trace.viewLabel")} />
          <div style={{ ...imgStyles.stage, background: view === "paths" ? "var(--bg-0, #0f1014)" : "#ffffff" }}>
            {error ? (
              <span style={{ ...imgStyles.note, color: "var(--danger, #ff6b6b)" }}>{error}</span>
            ) : !thumb ? (
              <span style={imgStyles.note}>{target ? t("image.loading") : t("image.selectTarget")}</span>
            ) : (
              <TracePreview img={thumb.img} res={res} view={view} fill={opts.fill} />
            )}
          </div>
          <span style={imgStyles.note}>
            {res && thumb
              ? t("image.trace.stats", {
                  w: thumb.img.width,
                  h: thumb.img.height,
                  colors: res.layers.length,
                  paths: res.paths,
                  anchors: res.anchors,
                  ms: Math.round(ms ?? 0),
                  fw: thumb.full.w,
                  fh: thumb.full.h,
                })
              : t("image.trace.computing")}
          </span>
        </div>
        <div style={imgStyles.side}>
          <div style={imgStyles.row}>
            <span style={imgStyles.rowHead}>{t("image.trace.preset")}</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {TRACE_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={"btn " + (preset === p.id ? "btn-primary" : "btn-ghost")}
                  data-tip={t(`image.trace.preset.${p.id}.hint`, undefined, p.hint)}
                  style={{ height: 28, padding: "0 10px" }}
                  onClick={() => {
                    setPreset(p.id);
                    setOpts(presetOptions(p.id));
                  }}
                >
                  {t(`image.trace.preset.${p.id}.label`, undefined, p.label)}
                </button>
              ))}
            </div>
          </div>
          <div style={imgStyles.row}>
            <span style={imgStyles.rowHead}>{t("image.trace.mode")}</span>
            <Seg value={opts.mode} options={[{ value: "bw", label: t("image.trace.modeBw") }, { value: "color", label: t("image.trace.modeColor") }]} onChange={(v) => set("mode", v)} ariaLabel={t("image.trace.modeLabel")} />
          </div>
          {opts.mode === "bw" ? (
            <RangeRow label={t("image.trace.threshold")} value={opts.threshold} min={1} max={255} step={1} onChange={(v) => set("threshold", v)} />
          ) : (
            <>
              <RangeRow label={t("image.trace.colors")} value={opts.colors} min={2} max={64} step={1} onChange={(v) => set("colors", v)} />
              <div style={imgStyles.row}>
                <span style={imgStyles.rowHead}>{t("image.trace.method")}</span>
                <Seg
                  value={opts.method}
                  options={[
                    { value: "stack", label: t("image.trace.stack"), tip: t("image.trace.stackTip") },
                    { value: "abut", label: t("image.trace.abut"), tip: t("image.trace.abutTip") },
                  ]}
                  onChange={(v) => set("method", v)}
                  ariaLabel={t("image.trace.method")}
                />
              </div>
              <CheckRow label={t("image.trace.ignoreWhite")} checked={opts.ignoreWhite} onChange={(v) => set("ignoreWhite", v)} />
            </>
          )}
          <RangeRow label={t("image.trace.minArea")} value={opts.minArea} min={1} max={500} step={1} unit="px²" onChange={(v) => set("minArea", v)} />
          <RangeRow label={t("image.trace.precision")} value={opts.precision} min={0.25} max={5} step={0.05} unit="px" onChange={(v) => set("precision", v)} />
          <RangeRow label={t("image.trace.corner")} value={opts.cornerAngle} min={10} max={170} step={1} unit="°" onChange={(v) => set("cornerAngle", v)} />
          <RangeRow label={t("image.trace.smooth")} value={opts.smooth} min={0} max={6} step={0.1} unit="px" onChange={(v) => set("smooth", v)} />
          <CheckRow label={t("image.trace.curves")} checked={opts.curves} onChange={(v) => set("curves", v)} />
          <CheckRow label={t("image.trace.fill")} checked={opts.fill} onChange={(v) => set("fill", v)} />
          <CheckRow label={t("image.trace.hideSource")} checked={hideSource} onChange={setHideSource} />
        </div>
      </div>
      <div style={imgStyles.foot}>
        <span style={imgStyles.note}>{t("image.trace.note")}</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {t("image.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !thumb}
          onClick={async () => {
            setBusy(true);
            const r = await traceSelection(opts, { hideSource });
            setBusy(false);
            if (r) onClose();
          }}
        >
          {busy ? t("image.trace.tracing") : t("image.trace.run")}
        </button>
      </div>
    </Modal>
  );
}
