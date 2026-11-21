// "PDF 용량 줄이기" dialog (File → export list): lossless by default; photo re-encoding ("용량 줄이기", lossy) only as
// an explicit choice, with an estimated size computed on request. Work is in ui/sizeActions.ts.

import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { buildSizedPdf, formatBytes, hasPdfSource, saveSizedPdf, type SizeOptions, type SizeSource, type SizedPdf } from "../sizeActions";
import { Modal } from "./Dialogs";
import { Seg } from "./controls";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });

export function SizeDialog() {
  const t = useT();
  const canOriginal = useMemo(hasPdfSource, []);
  const [source, setSource] = useState<SizeSource>(canOriginal ? "original" : "export");
  const [lossy, setLossy] = useState(false);
  const [quality, setQuality] = useState(0.8);
  const [maxDim, setMaxDim] = useState("2400");
  const [busy, setBusy] = useState(false);
  const [est, setEst] = useState<{ key: string; r: SizedPdf } | null>(null);
  const [error, setError] = useState("");
  const opts: SizeOptions = { source, lossy: lossy ? { quality, maxDim: Number(maxDim) } : null };
  const key = JSON.stringify(opts);
  const estimate = est && est.key === key ? est.r : null;

  const run = async (save: boolean) => {
    setBusy(true);
    setError("");
    try {
      const r = estimate ?? (await buildSizedPdf(opts));
      setEst({ key, r });
      if (save && (await saveSizedPdf(opts, r))) close();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal labelledBy="size-title" className="modal-sm" onClose={busy ? undefined : close}>
      <h2 id="size-title">{t("size.title")}</h2>
      <p className="modal-sub">{t("size.sub")}</p>
      <div className="tools-opt">
        <Seg<SizeSource>
          value={source}
          onChange={setSource}
          options={[
            { value: "export", label: t("size.source.export") },
            ...(canOriginal ? [{ value: "original" as const, label: t("size.source.original"), tip: t("size.source.originalHint") }] : []),
          ]}
        />
      </div>
      {source === "original" && <p className="modal-sub">{t("size.source.originalHint")}</p>}
      <div className="tools-opt">
        <Seg<"0" | "1">
          value={lossy ? "1" : "0"}
          onChange={(v) => setLossy(v === "1")}
          options={[
            { value: "0", label: t("size.lossless") },
            { value: "1", label: t("size.lossy"), tip: t("size.lossyHint") },
          ]}
        />
      </div>
      {lossy && (
        <>
          <p className="modal-sub">{t("size.lossyHint")}</p>
          <label className="tools-opt">
            <span>{t("size.quality")}</span>
            <input type="range" min={0.3} max={1} step={0.01} value={quality} disabled={busy} onChange={(e) => setQuality(Number(e.target.value))} />
            <b>{Math.round(quality * 100)}</b>
          </label>
          <div className="tools-opt">
            <span>{t("size.maxDim")}</span>
            <Seg
              value={maxDim}
              onChange={setMaxDim}
              options={[
                { value: "1600", label: "1600px" },
                { value: "2400", label: "2400px" },
                { value: "0", label: t("size.maxDimKeep") },
              ]}
            />
          </div>
        </>
      )}
      <p className="modal-sub" aria-live="polite">
        {busy ? t("size.estimating") : estimate ? t("size.estimated", { after: formatBytes(estimate.bytes.length), before: formatBytes(estimate.before) }) : ""}
        {!busy && estimate?.notes.length ? " " + estimate.notes.join(" ") : ""}
        {error}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(false)}>
          {t("size.estimate")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>
          {t("size.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(true)} data-autofocus>
          {t("size.save")}
        </button>
      </div>
    </Modal>
  );
}
