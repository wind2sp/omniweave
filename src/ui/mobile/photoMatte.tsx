// The phone photo screen's 배경 지우기 on the phone itself, with fingers: the background is removed at once, then a
// tap on the picture marks a place to keep (남길 곳) or to remove (지울 곳) and the cut is made again with those points
// — the PC dialog's subject points (core/image/matte/hints.ts), on the phone. 완료 gives a PNG with the background
// transparent, shown at once like 회전 / 자르기 (saved with 새로 저장). Before, the photo went to the PC function screen,
// whose automatic result could not be corrected by finger.
import { useEffect, useRef, useState } from "react";
import { useT } from "../../i18n";
import { cancelImageWork, CANCELLED, runMatte } from "../../core/image/run";
import type { MatteStage } from "../../core/image/matte/pipeline";
import type { MatteHint } from "../../core/image/matte/hints";
import type { Img } from "../../core/image/pixels";
import { useBackClose } from "./back";

async function decode(bytes: Uint8Array): Promise<Img> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext("2d")!;
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const d = g.getImageData(0, 0, c.width, c.height);
  return { width: d.width, height: d.height, data: d.data };
}

export function PhotoMatte({ bytes, name, onDone, onCancel }: { bytes: Uint8Array; name: string; onDone: (bytes: Uint8Array, name: string) => void; onCancel: () => void }) {
  const tr = useT();
  useBackClose(true, () => cancel());
  const [src, setSrc] = useState<Img | null>(null);
  const [cut, setCut] = useState<Img | null>(null);
  const [hints, setHints] = useState<MatteHint[]>([]);
  const [mode, setMode] = useState<"fg" | "bg">("fg");
  const [busy, setBusy] = useState(true);
  /** what the engine is doing ("person": a first result is shown, the person model's follows) */
  const [stage, setStage] = useState<MatteStage | null>(null);
  /** what the shown cut came from (data-matte on the picture: realuse reports it) */
  const [from, setFrom] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const run = useRef(0);

  useEffect(() => {
    void decode(bytes).then(setSrc, (e) => setErr(String(e?.message ?? e)));
  }, [bytes]);
  // the cut, again whenever the points change (a later run wins over an earlier one still working). In the image
  // worker, staged: the subject model's cut shows first; when the subject looks like a person the person model's cut
  // (core/image/matte/modnet.ts) replaces it — the picture is never blank while the slower step runs.
  useEffect(() => {
    if (!src) return;
    const id = ++run.current;
    const live = () => id === run.current;
    setBusy(true);
    setStage("subject");
    const opts = hints.length ? { hints } : {};
    void (async () => {
      try {
        const first = await runMatte(src, { ...opts, person: false, onStage: (st) => live() && st !== "person" && setStage(st) });
        if (!live()) return;
        setCut(first.value.cut);
        setFrom(`${first.value.type}${first.value.personCandidate ? " candidate" : ""}`);
        if (!first.value.personCandidate) return;
        setStage("person");
        const sal = first.value.sal;
        const second = await runMatte(src, { ...opts, ...(sal ? { sal } : {}) });
        if (live()) {
          setCut(second.value.cut);
          setFrom(`${second.value.type} ${second.value.person ? "person" : "no-person"}`);
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (live() && msg !== CANCELLED) setErr(msg);
      } finally {
        if (live()) {
          setBusy(false);
          setStage(null);
        }
      }
    })();
  }, [src, hints]);
  // leaving while it works stops the image worker (its next request starts a fresh one)
  const cancel = () => {
    if (busy) {
      run.current++;
      cancelImageWork();
    }
    onCancel();
  };
  useEffect(() => {
    const c = cv.current;
    if (!c || !cut) return;
    c.width = cut.width;
    c.height = cut.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(cut.data), cut.width, cut.height), 0, 0);
  }, [cut]);

  const tap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !r.height || busy) return;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setHints((h) => [...h, { x, y, fg: mode === "fg" }]);
  };
  const done = async () => {
    if (!cut) return;
    const c = document.createElement("canvas");
    c.width = cut.width;
    c.height = cut.height;
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(cut.data), cut.width, cut.height), 0, 0);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, "image/png"));
    if (!blob) return;
    onDone(new Uint8Array(await blob.arrayBuffer()), name.replace(/\.[^.]+$/, "") + "-cutout.png");
  };

  return (
    <div className="m-crop m-matte" role="dialog" aria-modal="true" aria-label={tr("mobile.photo.bgTitle")}>
      <header className="m-top m-crop-top">
        <button type="button" className="m-btn" onClick={cancel}>
          {tr("mobile.cancel")}
        </button>
        <h1 className="m-doc-name">{tr("mobile.photo.bgTitle")}</h1>
        <button type="button" className="m-btn m-btn-primary" onClick={() => void done()} disabled={!cut || busy}>
          {tr("mobile.photo.cropDone")}
        </button>
      </header>
      <div className="m-crop-area">
        {err ? (
          <div className="m-unsupported">{tr("mobile.failed", { error: err })}</div>
        ) : (
          <div className="m-crop-pic m-matte-pic">
            <canvas ref={cv} onPointerDown={tap} aria-label={tr("mobile.photo.bgHint")} data-matte={from} />
            {hints.map((h, i) => (
              <span key={i} className={`m-matte-dot ${h.fg ? "keep" : "drop"}`} style={{ left: `${h.x * 100}%`, top: `${h.y * 100}%` }} aria-hidden />
            ))}
            {busy && <div className={`m-spinner m-matte-busy${cut ? " m-matte-busy-over" : ""}`} role="progressbar" aria-label={tr(stage === "person" ? "mobile.photo.bgPerson" : "mobile.photo.bgWorking")} />}
          </div>
        )}
      </div>
      <div className="m-crop-ratios" role="radiogroup" aria-label={tr("mobile.photo.bgHint")}>
        <button type="button" role="radio" aria-checked={mode === "fg"} className={mode === "fg" ? "on" : ""} onClick={() => setMode("fg")}>
          {tr("mobile.photo.bgKeep")}
        </button>
        <button type="button" role="radio" aria-checked={mode === "bg"} className={mode === "bg" ? "on" : ""} onClick={() => setMode("bg")}>
          {tr("mobile.photo.bgDrop")}
        </button>
        <button type="button" onClick={() => setHints((h) => h.slice(0, -1))} disabled={!hints.length || busy}>
          {tr("mobile.photo.bgUndo")}
        </button>
      </div>
      <div className="m-crop-size" role="status">
        {busy ? tr(stage === "person" ? "mobile.photo.bgPerson" : "mobile.photo.bgWorking") : tr("mobile.photo.bgHint")}
      </div>
    </div>
  );
}
