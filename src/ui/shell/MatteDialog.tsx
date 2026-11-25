// "배경 지우기…" dialog: detected picture type (overridable), edge refinement sliders (Photoshop Select and Mask
// style) and a live preview computed in the image worker on a ≤640 px copy. The saliency map of that copy is reused
// for every preview and for the final apply, so U²-Netp runs once per dialog.
//
// Subject hints: clicking the preview marks a subject point (Alt+click or the "background" mode: a background point).
// The points are fractions of the picture size, so they hold for the full-resolution apply, and are saved in the
// cut-out's matte record: opening the dialog on a cut-out re-edits it with its saved options and points.

import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { MATTE_TYPES, type MatteType } from "../../core/image/matte/classify";
import { DEFAULT_EDGE, type EdgeOptions } from "../../core/image/matte/refine";
import { TYPE_EDGE, type MatteOptions } from "../../core/image/matte/pipeline";
import type { MatteHint } from "../../core/image/matte/hints";
import { runMatte, runMatteAnalyze, type MatteAnalysis } from "../../core/image/run";
import type { Img } from "../../core/image/pixels";
import { imageTarget, previewOf } from "../imageActions";
import { dialogUndoKey, matteEditTarget,matteImage, matteOptionsOf, matteSource, matteTypeLabel, removeBackgroundSelection } from "../matteActions";
import { useT } from "../../i18n";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";
import { CheckRow, RangeRow, imgStyles } from "./imageControls";

const PREVIEW_SIDE = 640;

type Inner = "auto" | "keep" | "remove";
const innerOpt = (v: Inner): MatteOptions["inner"] => (v === "auto" ? "auto" : v === "remove");

/** Preview canvas that takes clicks (hint points) and shows them as dots. */
function HintCanvas({ img, hints, onPoint }: { img: Img; hints: MatteHint[]; onPoint: (x: number, y: number, alt: boolean) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  }, [img]);
  const click = (e: MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height) return;
    onPoint(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)), e.altKey);
  };
  return (
    <div style={{ position: "relative", display: "inline-block", lineHeight: 0, maxWidth: "100%" }}>
      <canvas ref={ref} onClick={click} style={{ maxWidth: "100%", maxHeight: 420, display: "block", cursor: "crosshair" }} />
      {hints.map((h, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            position: "absolute",
            left: `${h.x * 100}%`,
            top: `${h.y * 100}%`,
            width: 12,
            height: 12,
            marginLeft: -6,
            marginTop: -6,
            borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px rgba(0,0,0,.6)",
            background: h.fg ? "#2ecc71" : "#e74c3c",
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

export function MatteDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  // a selected cut-out is re-edited from its original with its saved options
  const edit = useMemo(() => matteEditTarget(), []);
  const saved = useMemo(() => (edit ? matteOptionsOf(edit.matte) : null), [edit]);
  const target = useMemo(() => (edit ? { pageId: edit.pageId, node: edit.node } : imageTarget()), [edit]);
  const [src, setSrc] = useState<{ img: Img; scale: number } | null>(null);
  const [ana, setAna] = useState<MatteAnalysis | null>(null);
  const [type, setType] = useState<MatteType | "auto">(saved ? saved.type : "auto");
  const [edge, setEdge] = useState<Partial<EdgeOptions>>(saved ? saved.edge : {});
  const [keepShadow, setKeepShadow] = useState(saved?.keepShadow ?? false);
  const [inner, setInner] = useState<Inner>(saved?.inner === true ? "remove" : saved?.inner === false ? "keep" : "auto");
  const [hints, setHints] = useState<MatteHint[]>(saved?.hints ?? []);
  const [mode, setMode] = useState<"fg" | "bg">("fg");
  const [view, setView] = useState<"cut" | "matte" | "orig">("cut");
  const [out, setOut] = useState<{ cut: Img; matte: Img; review: boolean } | null>(null);
  const [ms, setMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** a person photo's second step is running (the person model): the preview shows the subject model's result first */
  const [personPending, setPersonPending] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    // the same pixels the apply works on (raster: painted area only), so the saliency map below lines up with it
    matteSource(target.node)
      .then(async ({ work }) => {
        const p = previewOf(work, PREVIEW_SIDE);
        if (!alive) return;
        setSrc({ img: p.img, scale: p.ctx.scale });
        // staged: the subject model's analysis (and its preview) first; a subject that looks like a person is then
        // checked with the person model, and the preview follows its result
        const a = await runMatteAnalyze(p.img, { person: false });
        if (!alive) return;
        const cand = "personCandidate" in a.value && !!a.value.personCandidate;
        setPersonPending(cand);
        setAna(a.value);
        if (!cand) return;
        const b = await runMatteAnalyze(p.img, { sal: "sal" in a.value ? a.value.sal : undefined }).finally(() => alive && setPersonPending(false));
        if (alive) setAna(b.value);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [target]);

  const effType: MatteType | null = type !== "auto" ? type : ana ? ana.type : null;
  const edgeFull: EdgeOptions = { ...DEFAULT_EDGE, ...(effType ? TYPE_EDGE[effType] : {}), ...edge };
  const sal = ana && "sal" in ana ? ana.sal : undefined;

  useEffect(() => {
    if (!src || !ana || !effType) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      runMatte(src.img, { type: effType, edge: { ...edgeFull, feather: edgeFull.feather * src.scale }, keepShadow, sal, inner: innerOpt(inner), hints, ...(personPending ? { person: false } : {}) })
        .then((r) => {
          if (id !== seq.current) return;
          setOut({ cut: r.value.cut, matte: matteImage(r.value.alpha, src.img.width, src.img.height), review: r.value.review });
          setMs(r.ms);
          setError(null);
        })
        .catch((e) => id === seq.current && setError(e instanceof Error ? e.message : String(e)));
    }, 60);
    return () => clearTimeout(timer);
    // edgeFull is derived from edge + effType
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, ana, effType, edge, keepShadow, inner, hints, personPending]);

  const setE = (k: keyof EdgeOptions, v: number) => setEdge((e) => ({ ...e, [k]: v }));
  const aiType = effType === "portrait" || effType === "animal" || effType === "object" || effType === "complex" || effType === "product";
  const titleId = "matte-title";
  const review = type === "auto" ? (out?.review ?? ana?.review ?? false) : type === "complex";
  const shown = view === "orig" ? src?.img ?? null : view === "matte" ? out?.matte ?? null : out?.cut ?? null;
  const addPoint = (x: number, y: number, alt: boolean) => setHints((h) => [...h, { x, y, fg: alt ? mode !== "fg" : mode === "fg" }]);
  const undoPoint = () => setHints((h) => h.slice(0, -1));
  // Ctrl+Z while the dialog is open takes back the last point instead of the document's undo (capture phase: the
  // app's shortcut handler listens on the window); with no point left, and for redo, the document behind the dialog
  // is not touched either (one Ctrl+Z too many must not undo the user's last edit unseen)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const a = dialogUndoKey(e);
      if (!a) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (a === "point") setHints((h) => h.slice(0, -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <Modal onClose={busy ? undefined : onClose} labelledBy={titleId} className="image-dialog">
      <style>{".modal.image-dialog{max-width:940px}"}</style>
      <div>

        <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 id={titleId}>{t("image.matte.title")}</h2>
          <span style={imgStyles.note}>{t(edit ? "image.matte.reedit" : "image.matte.hint")}</span>
        </div>
        <div style={imgStyles.body}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <Seg
              value={view}
              options={[
                { value: "cut", label: t("image.matte.view.cut") },
                { value: "matte", label: t("image.matte.view.matte") },
                { value: "orig", label: t("image.original") },
              ]}
              onChange={setView}
              ariaLabel={t("image.matte.view.label")}
            />
            <div style={imgStyles.stage}>
              {error ? (
                <span style={{ ...imgStyles.note, color: "var(--danger, #ff6b6b)" }}>{error}</span>
              ) : !src ? (
                <span style={imgStyles.note}>{target ? t("image.loading") : t("image.selectTarget")}</span>
              ) : !shown ? (
                <span style={imgStyles.note}>{t("image.matte.analyzing")}</span>
              ) : (
                <HintCanvas img={shown} hints={hints} onPoint={addPoint} />
              )}
            </div>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              {ana && (
                <span style={imgStyles.note}>
                  {t("image.matte.detected", { type: matteTypeLabel(ana.detected), pct: Math.round(ana.confidence * 100) })}
                </span>
              )}
              {ana && "backend" in ana && ana.backend && <span style={imgStyles.note}>{t(`image.matte.backend.${ana.backend}`)}</span>}
              {personPending && (
                <span style={imgStyles.note} role="status" className="matte-person-pending">
                  {t("image.matte.personChecking")}
                </span>
              )}
              {ms !== null && <span style={imgStyles.note}>{t("image.matte.previewTime", { ms: Math.round(ms) })}</span>}
            </div>
            {review && <span style={{ ...imgStyles.note, color: "var(--warn, #e0a030)" }}>{t("image.matte.review")}</span>}
          </div>
          <div style={imgStyles.side}>
            <label style={imgStyles.row}>
              <span style={imgStyles.rowHead}>{t("image.matte.typeLabel")}</span>
              <select value={type} onChange={(e) => setType(e.target.value as MatteType | "auto")} aria-label={t("image.matte.typeLabel")}>
                <option value="auto">{ana ? t("image.matte.autoType", { type: matteTypeLabel(ana.detected) }) : t("image.matte.auto")}</option>
                {MATTE_TYPES.map((m) => (
                  <option key={m} value={m}>
                    {matteTypeLabel(m)}
                  </option>
                ))}
              </select>
              {effType && <span style={imgStyles.note}>{t(`image.matte.method.${effType}`)}</span>}
            </label>
            <div style={imgStyles.row}>
              <span style={imgStyles.rowHead}>{t("image.matte.points")}</span>
              <Seg
                value={mode}
                options={[
                  { value: "fg", label: t("image.matte.points.fg") },
                  { value: "bg", label: t("image.matte.points.bg") },
                ]}
                onChange={setMode}
                ariaLabel={t("image.matte.points")}
              />
              <span style={imgStyles.note}>{t("image.matte.points.note")}</span>
              <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button type="button" className="btn btn-ghost" onClick={undoPoint} disabled={!hints.length}>
                  {t("image.matte.points.undo")}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setHints([])} disabled={!hints.length}>
                  {t("image.matte.points.clear")}
                </button>
                {hints.length > 0 && <span style={imgStyles.note}>{t("image.matte.points.count", { fg: hints.filter((h) => h.fg).length, bg: hints.filter((h) => !h.fg).length })}</span>}
              </span>
            </div>
            {effType === "graphic" && (
              <div style={imgStyles.row}>
                <span style={imgStyles.rowHead}>{t("image.matte.inner")}</span>
                <Seg
                  value={inner}
                  options={[
                    { value: "auto", label: t("image.matte.auto") },
                    { value: "keep", label: t("image.matte.inner.keep") },
                    { value: "remove", label: t("image.matte.inner.remove") },
                  ]}
                  onChange={setInner}
                  ariaLabel={t("image.matte.inner")}
                />
                <span style={imgStyles.note}>{t("image.matte.inner.note")}</span>
              </div>
            )}
            <span style={{ ...imgStyles.rowHead, marginTop: 4 }}>{t("image.matte.edge")}</span>
            {aiType && <RangeRow label={t("image.matte.radius")} value={edgeFull.radius} min={1} max={40} step={1} unit="px" def={(TYPE_EDGE[effType!].radius ?? DEFAULT_EDGE.radius)} onChange={(v) => setE("radius", v)} />}
            <RangeRow label={t("image.matte.smooth")} value={edgeFull.smooth} min={0} max={100} step={1} def={0} onChange={(v) => setE("smooth", v)} />
            <RangeRow label={t("image.matte.feather")} value={edgeFull.feather} min={0} max={40} step={0.5} unit="px" def={0} onChange={(v) => setE("feather", v)} />
            <RangeRow label={t("image.matte.contrast")} value={edgeFull.contrast} min={0} max={100} step={1} def={0} onChange={(v) => setE("contrast", v)} />
            <RangeRow label={t("image.matte.shift")} value={edgeFull.shift} min={-100} max={100} step={1} unit="%" def={0} onChange={(v) => setE("shift", v)} />
            <RangeRow label={t("image.matte.decontaminate")} value={edgeFull.decontaminate} min={0} max={100} step={1} unit="%" def={TYPE_EDGE[effType ?? "object"].decontaminate ?? 60} onChange={(v) => setE("decontaminate", v)} />
            {effType === "product" && <CheckRow label={t("image.matte.keepShadow")} checked={keepShadow} onChange={setKeepShadow} />}
          </div>
        </div>
        <div style={imgStyles.foot}>
          <button type="button" className="btn btn-ghost" onClick={() => (setEdge({}), setKeepShadow(false), setInner("auto"), setHints([]))} disabled={busy}>
            {t("image.dlg.defaults")}
          </button>
          <span style={{ flex: 1 }} />
          <span style={imgStyles.note}>{t(edit ? "image.matte.reeditNote" : "image.matte.note")}</span>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t("image.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !ana || !effType}
            onClick={async () => {
              setBusy(true);
              // the saliency map belongs to the dialog's picture: reuse it only while that is still the target
              const same = edit ? matteEditTarget()?.node === edit.node : imageTarget()?.node === target?.node;
              const opts: MatteOptions = { type: type === "auto" ? undefined : type, edge, keepShadow, sal: same ? sal : undefined, hints };
              if (inner !== "auto") opts.inner = innerOpt(inner);
              // (removeBackgroundSelection shows its own progress, with the step and Cancel)
              await removeBackgroundSelection(opts, edit);
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
