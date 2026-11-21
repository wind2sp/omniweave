// "글자 인식(OCR)…" dialog: language, output mode (invisible text layer / editable rebuild), recognition in the image
// worker, preview of the straightened page with line boxes coloured by confidence (green / amber / red, tables blue,
// check boxes magenta) and the recognized text with doubtful characters marked. "적용" inserts one undo step.

import { useEffect, useMemo, useRef, useState } from "react";
import { downscale, type Img } from "../../core/image/pixels";
import type { OcrLang } from "../../core/image/ocr/models";
import { cancelImageWork, CANCELLED, warmOcr } from "../../core/image/run";
import type { OcrMode } from "../../core/image/ocr/reconstruct";
import { applyOcr, recognizeTarget, type OcrRun } from "../ocrActions";
import { withProgress } from "../progress";
import { imageTarget } from "../imageActions";
import { useT } from "../../i18n";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";
import { CheckRow, ImgCanvas, imgStyles } from "./imageControls";

const PREVIEW_SIDE = 640;
const LOW = 0.6;

/** Preview copy of the page with the recognition boxes drawn in. */
export function overlayImage(run: OcrRun, side = PREVIEW_SIDE): Img {
  const { img, scale } = downscale(run.page.image, side);
  const out: Img = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  const rect = (x: number, y: number, w: number, h: number, c: [number, number, number]) => {
    const x0 = Math.max(0, Math.round(x * scale)), y0 = Math.max(0, Math.round(y * scale));
    const x1 = Math.min(out.width - 1, Math.round((x + w) * scale)), y1 = Math.min(out.height - 1, Math.round((y + h) * scale));
    const put = (px: number, py: number) => out.data.set([...c, 255], (py * out.width + px) * 4);
    for (let i = x0; i <= x1; i++) (put(i, y0), put(i, y1));
    for (let j = y0; j <= y1; j++) (put(x0, j), put(x1, j));
  };
  for (const t of run.page.tables) for (const c of t.cells) rect(c.box.x + 2, c.box.y + 2, c.box.w - 4, c.box.h - 4, [40, 110, 255]);
  for (const c of run.page.checks) rect(c.box.x - 3, c.box.y - 3, c.box.w + 6, c.box.h + 6, [220, 0, 200]);
  for (const l of run.page.lines) rect(l.box.x, l.box.y, l.box.w, l.box.h, l.conf >= 0.9 ? [20, 170, 60] : l.conf >= LOW ? [240, 160, 0] : [230, 30, 30]);
  return out;
}

export function OcrDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const titleId = "ocr-dialog-title";
  const [lang, setLang] = useState<OcrLang>("auto");
  const [mode, setMode] = useState<OcrMode>("rebuild");
  const [showImage, setShowImage] = useState(false);
  const [mark, setMark] = useState(true);
  const [run, setRun] = useState<OcrRun | null>(null);
  const [busy, setBusy] = useState<"" | "rec" | "apply">("");
  const [error, setError] = useState("");
  const target = imageTarget();
  const preview = useMemo(() => (run ? overlayImage(run) : null), [run]);
  const doubtful = run ? run.page.lines.reduce((a, l) => a + l.chars.filter((c) => c.ch !== " " && (c.p < LOW || c.jamo)).length, 0) : 0;

  // recognition takes tens of seconds: it can be stopped (the worker is terminated), and closing the dialog stops it
  const job = useRef(0);
  const stop = () => {
    job.current++;
    cancelImageWork();
    setBusy("");
  };
  useEffect(() => () => {
    if (job.current % 2) cancelImageWork();
  }, []);
  // models and GPU set up while the user picks options (the first use compiles shaders for seconds)
  useEffect(() => warmOcr(lang), [lang]);
  const recognize = async () => {
    const id = (job.current += job.current % 2 ? 2 : 1); // odd = running
    setBusy("rec");
    setError("");
    try {
      const r = await withProgress(t("progress.ocr"), () => recognizeTarget(lang), { cancel: stop });
      if (job.current === id) setRun(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (job.current === id && msg !== CANCELLED) setError(/ocr model missing/.test(msg) ? t("ocr.err.noModel") : t("ocr.err.failed", { error: msg }));
    }
    if (job.current === id) {
      job.current++;
      setBusy("");
    }
  };
  const close = () => {
    if (busy === "rec") stop();
    onClose();
  };

  return (
    <Modal onClose={busy === "apply" ? undefined : close} labelledBy={titleId} className="image-dialog">
      <style>{".modal.image-dialog{max-width:980px}"}</style>
      <div>
        <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 id={titleId}>{t("ocr.title")}</h2>
          <span style={imgStyles.note}>{t("ocr.hint")}</span>
        </div>
        <div style={imgStyles.body}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <div style={imgStyles.stage}>
              {error ? <p style={imgStyles.note}>{error}</p> : preview ? <ImgCanvas img={preview} title={t("ocr.preview")} /> : <p style={imgStyles.note}>{busy === "rec" ? t("ocr.working") : t("ocr.ready")}</p>}
            </div>
            {run && (
              <span style={imgStyles.note}>
                {t("ocr.stats", { lines: run.page.lines.length, tables: run.page.tables.length, checks: run.page.checks.length, angle: run.page.angle, ms: Math.round(run.ms) })}
              </span>
            )}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, minWidth: 260 }}>
            <span style={imgStyles.note}>{t("ocr.lang.label")}</span>
            <Seg
              value={lang}
              options={[
                { value: "auto", label: t("ocr.lang.auto") },
                { value: "ko", label: t("ocr.lang.ko") },
                { value: "en", label: t("ocr.lang.en") },
              ]}
              onChange={(v) => (setLang(v), setRun(null))}
              ariaLabel={t("ocr.lang.label")}
            />
            <span style={imgStyles.note}>{t("ocr.mode.label")}</span>
            <Seg
              value={mode}
              options={[
                { value: "rebuild", label: t("ocr.mode.rebuild") },
                { value: "layer", label: t("ocr.mode.layer") },
              ]}
              onChange={setMode}
              ariaLabel={t("ocr.mode.label")}
            />
            <span style={imgStyles.note}>{t(mode === "layer" ? "ocr.mode.layerHint" : "ocr.mode.rebuildHint")}</span>
            {mode === "rebuild" && <CheckRow label={t("ocr.showImage")} checked={showImage} onChange={setShowImage} />}
            {mode === "rebuild" && <CheckRow label={t("ocr.mark")} checked={mark} onChange={setMark} />}
            {run && (
              <div style={{ maxHeight: 300, overflow: "auto", fontSize: 12, lineHeight: 1.6, border: "1px solid var(--line, #ddd)", borderRadius: 6, padding: 8 }} aria-label={t("ocr.textLabel")}>
                {run.page.lines.map((l, i) => (
                  <div key={i}>
                    {l.chars.map((c, j) => (
                      <span key={j} title={c.alt ? t("ocr.alt", { ch: c.alt, p: Math.round((c.altP ?? 0) * 100) }) : undefined} style={c.ch !== " " && (c.p < LOW || c.jamo) ? { background: "#fff1a8", color: "#1d1f24" } : undefined}>
                        {c.ch}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
            {run && <span style={imgStyles.note}>{t("ocr.doubtful", { n: doubtful })}</span>}
          </div>
        </div>
        <div style={imgStyles.foot}>
          <button type="button" className="btn btn-ghost" onClick={recognize} disabled={!!busy || !target}>
            {busy === "rec" ? t("ocr.working") : run ? t("ocr.again") : t("ocr.run")}
          </button>
          <span style={{ flex: 1 }} />
          <span style={imgStyles.note}>{t("ocr.note")}</span>
          <button type="button" className="btn btn-ghost" onClick={busy === "rec" ? stop : onClose} disabled={busy === "apply"}>
            {t("image.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!busy || !run}
            onClick={() => {
              if (!run) return;
              setBusy("apply");
              applyOcr(run, { mode, showImage, markBelow: mark ? LOW : 0 });
              setBusy("");
              onClose();
            }}
          >
            {t("image.dlg.apply")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
