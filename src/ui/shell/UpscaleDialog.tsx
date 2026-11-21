// "이미지 크기 키우기(업스케일)" dialog: size (2× · 3× · 4× · custom), method (AI 고품질 with its automatic model /
// denoise choice, or the classical sharp / smooth / pixel methods), options, and a before / after preview of a crop
// (click the thumbnail to move it). Apply runs in the image worker with progress and a cancel button.

import { useEffect, useMemo, useRef, useState } from "react";
import { cropImg, downscale, type Img } from "../../core/image/pixels";
import { cancelImageWork, CANCELLED, runSuperResolve, runUpscale } from "../../core/image/run";
import { checkUpscale, scaledSize, upscale, UPSCALE_MAX_FACTOR } from "../../core/image/upscale";
import { ImageOpError } from "../../core/image/ops";
import type { SrDecision } from "../../core/image/sr/classify";
import { imageTarget } from "../imageActions";
import { aiFits, applyUpscale, autoChoice, coversCanvas, upscaleDeepNote, upscaleRefusal, upscaleSize, upscaleSource, type UpscaleRequest, type UpscaleSource } from "../upscaleActions";
import { useT } from "../../i18n";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";
import { CheckRow, ImgCanvas, RangeRow, imgStyles } from "./imageControls";

type SizeMode = "2" | "3" | "4" | "custom";
type Method = "ai" | "hq" | "smooth" | "pixel";
type AiModel = "auto" | "photo" | "art";

/** Source size of the preview crop (the AI preview enlarges it 4×). */
const CROP = 64;

/** The size / pixel limit of the result (30,000 px a side, 100 MP), said before Apply rather than after. */
function limitError(w: number, h: number, W: number, H: number, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  try {
    checkUpscale(w, h, W, H);
    return null;
  } catch (e) {
    return e instanceof ImageOpError ? t(e.code, e.vars) : String(e);
  }
}

export function UpscaleDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const target = useMemo(() => imageTarget(), []);
  const refusal = target ? upscaleRefusal(target) : null;
  const [src, setSrc] = useState<UpscaleSource | null>(null);
  const [auto, setAuto] = useState<SrDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState<SizeMode>("2");
  const [cw, setCw] = useState(0);
  const [ch, setCh] = useState(0);
  const [lock, setLock] = useState(true);
  const [method, setMethod] = useState<Method>("ai");
  const [aiModel, setAiModel] = useState<AiModel>("auto");
  const [autoDenoise, setAutoDenoise] = useState(true);
  const [denoiseStr, setDenoiseStr] = useState(50);
  const [deblock, setDeblock] = useState<boolean | null>(null);
  const [sharpen, setSharpen] = useState(0);
  const [denoise, setDenoise] = useState(false);
  const [keepAlpha, setKeepAlpha] = useState(true);
  const [canvas, setCanvas] = useState(true);
  const [centre, setCentre] = useState<[number, number]>([0.5, 0.5]);
  const [compare, setCompare] = useState<"both" | "before" | "after">("both");
  const [after, setAfter] = useState<Img | null>(null);
  const [previewMs, setPreviewMs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const seq = useRef(0);
  const methodTouched = useRef(false);

  useEffect(() => {
    if (!target || refusal) return;
    let alive = true;
    upscaleSource(target)
      .then((s) => {
        if (!alive) return;
        setSrc(s);
        setCw(s.img.width * 2);
        setCh(s.img.height * 2);
        const a = autoChoice(s.img);
        setAuto(a);
        setDenoiseStr(Math.round(a.denoise * 100));
        // pixel art: the network would paint over the blocks — suggest "픽셀 그대로" (the user can still pick AI)
        if (a.pixelArt && !methodTouched.current) setMethod("pixel");
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [target, refusal]);

  const req: UpscaleRequest = {
    ...(size === "custom" ? { width: cw, height: ch } : { scale: Number(size) }),
    method,
    sharpen,
    denoise,
    keepAlpha,
    canvas,
    aiModel,
    aiDenoise: autoDenoise ? undefined : denoiseStr / 100,
    aiDeblock: deblock ?? undefined,
  };
  const out = src ? upscaleSize(src.img.width, src.img.height, req) : null;
  const tooBigForAi = !!src && method === "ai" && !aiFits(src.img.width, src.img.height);
  const factor = src && out ? Math.max(out.width / src.img.width, out.height / src.img.height) : 1;
  const sizeError = src && out && (out.width < src.img.width || out.height < src.img.height || (out.width === src.img.width && out.height === src.img.height) || factor > UPSCALE_MAX_FACTOR) ? t("image.upscale.sizeHint", { max: UPSCALE_MAX_FACTOR }) : src && out ? limitError(src.img.width, src.img.height, out.width, out.height, t) : null;

  // the preview crop and its "before" (nearest neighbour to the same size)
  const crop = useMemo(() => {
    if (!src) return null;
    const w = Math.min(CROP, src.img.width), h = Math.min(CROP, src.img.height);
    // on the 8 × 8 grid, so the preview's JPEG deblocking and damage reading see the file's own blocks
    const x = Math.max(0, Math.min(src.img.width - w, Math.round(centre[0] * src.img.width - w / 2))) & ~7;
    const y = Math.max(0, Math.min(src.img.height - h, Math.round(centre[1] * src.img.height - h / 2))) & ~7;
    return cropImg(src.img, x, y, w, h);
  }, [src, centre]);
  const k = Math.min(4, Math.max(1.01, factor));
  const pw = crop ? Math.max(crop.width + 1, Math.round(crop.width * k)) : 0, ph = crop ? Math.max(crop.height, Math.round(crop.height * k)) : 0;
  const before = useMemo(() => (crop ? (upscale(crop, { method: "pixel", width: pw, height: ph }) as Img) : null), [crop, pw, ph]);
  const thumb = useMemo(() => (src ? downscale(src.img, 180).img : null), [src]);

  useEffect(() => {
    if (!crop || sizeError) return;
    const id = ++seq.current;
    const timer = setTimeout(() => {
      const t0 = performance.now();
      const run =
        method === "ai" && !tooBigForAi
          ? runSuperResolve(crop, { model: aiModel === "auto" ? (auto?.content ?? "photo") : aiModel, denoise: autoDenoise ? (auto?.denoise ?? 0.5) : denoiseStr / 100, deblock: deblock ?? auto?.deblock ?? false, width: pw, height: ph, keepAlpha }).then((r) => r.value)
          : runUpscale(crop, { method: method === "ai" ? "hq" : method, width: pw, height: ph, sharpen, denoise, keepAlpha }).then((r) => r.value as Img);
      run
        .then((img) => {
          if (id !== seq.current) return;
          setAfter(img);
          setPreviewMs(performance.now() - t0);
          setError(null);
        })
        // a preview stopped by Cancel during Apply (the worker is restarted) is not an error to show
        .catch((e) => id === seq.current && (e as Error)?.message !== CANCELLED && setError(e instanceof Error ? e.message : String(e)));
    }, 120);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crop, method, aiModel, autoDenoise, denoiseStr, deblock, sharpen, denoise, keepAlpha, pw, ph, auto, sizeError, tooBigForAi]);

  const autoLabel = auto
    ? t("image.upscale.autoIs", { content: t(`image.upscale.content.${auto.content}`), damage: t(`image.upscale.damage.${auto.damage}`) })
    : t("image.loading");
  const titleId = "img-upscale-title";
  const covers = target && src ? coversCanvas(target, src) : false;
  const setW = (v: number) => {
    setCw(v);
    if (lock && src) setCh(Math.max(1, Math.round((v * src.img.height) / src.img.width)));
  };
  const setH = (v: number) => {
    setCh(v);
    if (lock && src) setCw(Math.max(1, Math.round((v * src.img.width) / src.img.height)));
  };

  return (
    <Modal onClose={busy ? undefined : onClose} labelledBy={titleId} className="image-dialog">
      <style>{".modal.image-dialog{max-width:940px}"}</style>
      <div>
        <div style={{ padding: "18px 20px 0", display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 id={titleId}>{t("image.upscale.title")}</h2>
          {src && <span style={imgStyles.note}>{t("image.upscale.sizes", { w: src.img.width, h: src.img.height, W: out?.width ?? 0, H: out?.height ?? 0 })}</span>}
        </div>
        <div style={imgStyles.body}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <Seg
                value={compare}
                options={[
                  { value: "both", label: t("image.dlg.both") },
                  { value: "before", label: t("image.original") },
                  { value: "after", label: t("image.dlg.after") },
                ]}
                onChange={setCompare}
                ariaLabel={t("image.dlg.compare")}
              />
              {previewMs !== null && <span style={imgStyles.note}>{t("image.upscale.previewTime", { ms: Math.round(previewMs) })}</span>}
            </div>
            <div style={imgStyles.stage}>
              {refusal ? (
                <span style={{ ...imgStyles.note, color: "var(--warn, #e0a030)", padding: 16 }}>{refusal}</span>
              ) : error ? (
                <span style={{ ...imgStyles.note, color: "var(--danger, #ff6b6b)", padding: 16 }}>{error}</span>
              ) : !src ? (
                <span style={imgStyles.note}>{target ? t("image.loading") : t("image.selectTarget")}</span>
              ) : compare === "both" ? (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, width: "100%", padding: 8 }}>
                  <ImgCanvas img={before} title={t("image.original")} />
                  <ImgCanvas img={after} title={t("image.dlg.after")} />
                </div>
              ) : (
                <ImgCanvas img={compare === "before" ? before : after} />
              )}
            </div>
            {thumb && (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <div
                  style={{ position: "relative", cursor: "crosshair", lineHeight: 0, border: "1px solid var(--line-2)", borderRadius: 6, overflow: "hidden", flex: "none" }}
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setCentre([(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]);
                  }}
                  role="button"
                  aria-label={t("image.upscale.pickCrop")}
                >
                  <div style={{ width: thumb.width, height: thumb.height }}>
                    <ImgCanvas img={thumb} />
                  </div>
                  {src && (
                    <span
                      style={{
                        position: "absolute",
                        left: `${(centre[0] - Math.min(CROP, src.img.width) / src.img.width / 2) * 100}%`,
                        top: `${(centre[1] - Math.min(CROP, src.img.height) / src.img.height / 2) * 100}%`,
                        width: `${(Math.min(CROP, src.img.width) / src.img.width) * 100}%`,
                        height: `${(Math.min(CROP, src.img.height) / src.img.height) * 100}%`,
                        outline: "2px solid var(--accent)",
                        pointerEvents: "none",
                      }}
                    />
                  )}
                </div>
                <span style={imgStyles.note}>{t("image.upscale.pickCropNote")}</span>
              </div>
            )}
          </div>
          <div style={imgStyles.side}>
            <div style={imgStyles.row}>
              <span style={imgStyles.rowHead}>{t("image.upscale.size")}</span>
              <Seg
                value={size}
                options={[
                  { value: "2", label: "2×" },
                  { value: "3", label: "3×" },
                  { value: "4", label: "4×" },
                  { value: "custom", label: t("image.upscale.custom") },
                ]}
                onChange={(v) => {
                  setSize(v);
                  if (v !== "custom" && src) {
                    const s = scaledSize(src.img.width, src.img.height, Number(v));
                    setCw(s.width);
                    setCh(s.height);
                  }
                }}
                ariaLabel={t("image.upscale.size")}
              />
              {size === "custom" && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input type="number" min={1} value={cw} onChange={(e) => setW(Math.max(1, Math.round(Number(e.target.value) || 1)))} style={{ width: 84 }} aria-label={t("image.upscale.width")} />
                  <span>×</span>
                  <input type="number" min={1} value={ch} onChange={(e) => setH(Math.max(1, Math.round(Number(e.target.value) || 1)))} style={{ width: 84 }} aria-label={t("image.upscale.height")} />
                  <span style={imgStyles.note}>px</span>
                  <CheckRow label={t("image.upscale.keepRatio")} checked={lock} onChange={setLock} />
                </div>
              )}
              {sizeError && <span style={{ ...imgStyles.note, color: "var(--warn, #e0a030)" }}>{sizeError}</span>}
            </div>
            <div style={imgStyles.row}>
              <span style={imgStyles.rowHead}>{t("image.upscale.method")}</span>
              <select
                value={method}
                onChange={(e) => {
                  methodTouched.current = true;
                  setMethod(e.target.value as Method);
                }}
                aria-label={t("image.upscale.method")}
              >
                <option value="ai">{t("image.upscale.method.ai")}</option>
                <option value="hq">{t("image.upscale.method.hq")}</option>
                <option value="smooth">{t("image.upscale.method.smooth")}</option>
                <option value="pixel">{t("image.upscale.method.pixel")}</option>
              </select>
              <span style={imgStyles.note}>{t(`image.upscale.method.${method}.note`)}</span>
              {auto?.pixelArt && <span style={imgStyles.note}>{t("image.upscale.pixelArtNote")}</span>}
              {tooBigForAi && <span style={{ ...imgStyles.note, color: "var(--warn, #e0a030)" }}>{t("image.upscale.aiTooLarge")}</span>}
            </div>
            {method === "ai" && (
              <>
                <div style={imgStyles.row}>
                  <span style={imgStyles.rowHead}>{t("image.upscale.model")}</span>
                  <Seg
                    value={aiModel}
                    options={[
                      { value: "auto", label: t("image.upscale.model.auto") },
                      { value: "photo", label: t("image.upscale.content.photo") },
                      { value: "art", label: t("image.upscale.content.art") },
                    ]}
                    onChange={setAiModel}
                    ariaLabel={t("image.upscale.model")}
                  />
                  <span style={imgStyles.note}>{autoLabel}</span>
                </div>
                {(aiModel === "photo" || (aiModel === "auto" && auto?.content === "photo")) && (
                  <>
                    <CheckRow label={t("image.upscale.denoiseAuto")} checked={autoDenoise} onChange={setAutoDenoise} />
                    {!autoDenoise && <RangeRow label={t("image.upscale.denoiseStrength")} value={denoiseStr} min={0} max={100} step={5} unit="%" def={50} onChange={setDenoiseStr} />}
                  </>
                )}
                <CheckRow label={t("image.upscale.deblock")} checked={deblock ?? auto?.deblock ?? false} onChange={setDeblock} />
              </>
            )}
            {method !== "ai" && method !== "pixel" && (
              <>
                <RangeRow label={t("image.upscale.sharpen")} value={sharpen} min={0} max={100} step={1} unit="%" def={0} onChange={setSharpen} />
                <CheckRow label={t("image.upscale.denoise")} checked={denoise} onChange={setDenoise} />
              </>
            )}
            <CheckRow label={t("image.upscale.keepAlpha")} checked={keepAlpha} onChange={setKeepAlpha} />
            {covers && <CheckRow label={t("image.upscale.canvas")} checked={canvas} onChange={setCanvas} />}
            {target && upscaleDeepNote(target) && <span style={{ ...imgStyles.note, color: "var(--warn, #e0a030)" }}>{t(upscaleDeepNote(target)!)}</span>}
            <span style={imgStyles.note}>{target?.node.type === "IMAGE" ? t("image.upscale.noteImage") : t("image.upscale.noteRaster")}</span>
          </div>
        </div>
        <div style={imgStyles.foot}>
          {busy && progress && (
            <span style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
              <progress value={progress[0]} max={progress[1]} style={{ flex: 1 }} />
              <span style={imgStyles.note}>{Math.round((progress[0] / Math.max(1, progress[1])) * 100)}%</span>
            </span>
          )}
          {!busy && <span style={{ flex: 1 }} />}
          {busy ? (
            <button type="button" className="btn btn-ghost" onClick={() => cancelImageWork()}>
              {t("image.cancel")}
            </button>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              {t("image.cancel")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !src || !!refusal || !!sizeError}
            onClick={async () => {
              setBusy(true);
              setProgress([0, 1]);
              const r = await applyUpscale(req, (d, tot) => setProgress([d, tot]));
              setBusy(false);
              setProgress(null);
              if (r) onClose();
            }}
          >
            {busy ? t("image.dlg.applying") : t("image.dlg.apply")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
