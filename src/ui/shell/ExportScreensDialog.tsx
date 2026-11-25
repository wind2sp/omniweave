// 화면용 내보내기 (Illustrator's Export for Screens, Ctrl+Alt+E): the artboards picked, each in the formats and scales
// picked — PNG / JPG at 1x · 2x · 3x…, SVG, PDF — named "artboard name@2x.png". One file is saved as itself, more are
// saved together in one ZIP (the folder Illustrator writes them into).

import { zipSync } from "fflate";
import { useState } from "react";
import { useStore } from "../../core/store";
import type { OmwDocument, Page } from "../../core/types";
import { useT, t as tNow } from "../../i18n";
import { exportImage, exportPdf, exportPng, exportSvg } from "../../io/export";
import { saveFile } from "../../io/platform";
import { boardsOf } from "../artboards";
import { isCancelled, withProgress } from "../progress";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

export type ScreenFormat = "png" | "jpg" | "svg" | "pdf";
const FORMATS: ScreenFormat[] = ["png", "jpg", "svg", "pdf"];
const SCALES = [0.5, 1, 1.5, 2, 3, 4];

const close = () => useUI.getState().set({ shellDialog: null });

/** A file name without the characters Windows refuses. */
const safe = (s: string) => s.replace(/[\\/:*?"<>|]+/g, "_").trim() || "artboard";

/** The files of an Export for Screens: name → bytes (the scale suffix only past 1x, as Illustrator). */
export async function screenFiles(doc: OmwDocument, pages: Page[], formats: ScreenFormat[], scales: number[]): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const taken = new Set<string>();
  for (const p of pages) {
    let base = safe(p.name);
    for (let k = 2; taken.has(base); k++) base = `${safe(p.name)} ${k}`;
    taken.add(base);
    for (const f of formats) {
      if (f === "svg") out[`${base}.svg`] = new TextEncoder().encode(await exportSvg(doc, p));
      else if (f === "pdf") out[`${base}.pdf`] = await exportPdf(doc, [p]);
      else
        for (const k of scales) {
          const name = `${base}${k === 1 ? "" : `@${k}x`}.${f}`;
          out[name] = f === "png" ? await exportPng(doc, p, k) : await exportImage(doc, p, { mime: "image/jpeg", quality: 0.92, background: "#ffffff", scale: k });
        }
    }
  }
  return out;
}

export function ExportScreensDialog() {
  const t = useT();
  const doc = useStore((s) => s.doc);
  const pageId = useStore((s) => s.pageId);
  const boards = boardsOf(doc).map((b) => b.page);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(boards.map((p) => p.id)));
  const [formats, setFormats] = useState<Set<ScreenFormat>>(() => new Set(["png"]));
  const [scales, setScales] = useState<Set<number>>(() => new Set([1]));
  const toggle = <T,>(set: Set<T>, v: T, put: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    put(n);
  };
  const raster = formats.has("png") || formats.has("jpg");
  const count = picked.size * ([...formats].filter((f) => f === "svg" || f === "pdf").length + (raster ? [...formats].filter((f) => f === "png" || f === "jpg").length * scales.size : 0));
  const run = async () => {
    const pages = boards.filter((p) => picked.has(p.id));
    close();
    try {
      const files = await withProgress(tNow("design.screens.progress"), () => screenFiles(doc, pages, FORMATS.filter((f) => formats.has(f)), SCALES.filter((k) => scales.has(k))), { cancel: true });
      const names = Object.keys(files);
      if (!names.length) return;
      if (names.length === 1) {
        const ext = names[0].split(".").pop()!;
        const path = await saveFile(names[0], files[names[0]], [{ name: ext.toUpperCase(), extensions: [ext] }]);
        if (path) useStore.getState().notify(tNow("design.screens.done", { n: 1 }));
        return;
      }
      const stem = safe(doc.title ?? "") || "artboards";
      const zip = zipSync(Object.fromEntries(names.map((n) => [n, [files[n], { level: n.endsWith(".svg") || n.endsWith(".pdf") ? 6 : 0 }]])) as never);
      const path = await saveFile(`${stem}.zip`, zip, [{ name: "ZIP", extensions: ["zip"] }]);
      if (path) useStore.getState().notify(tNow("design.screens.done", { n: names.length }));
    } catch (e) {
      if (isCancelled(e)) return;
      useStore.getState().notify(String((e as Error)?.message ?? e));
    }
  };
  return (
    <Modal labelledBy="screens-title" onClose={close}>
      <h2 id="screens-title">{t("design.screens.title")}</h2>
      <fieldset className="tools-group">
        <legend>{t("design.screens.boards")}</legend>
        <div className="btn-row">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set(boards.map((p) => p.id)))}>
            {t("design.screens.all")}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPicked(new Set([pageId]))}>
            {t("design.screens.current")}
          </button>
        </div>
        <div style={{ maxHeight: 180, overflow: "auto" }}>
          {boards.map((p, i) => (
            <label key={p.id} className="tools-opt">
              <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(picked, p.id, setPicked)} />
              <span>
                {String(i + 1).padStart(2, "0")} - {p.name}
              </span>
              <span className="muted-note">
                {Math.round(p.width)} × {Math.round(p.height)} px
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="tools-group">
        <legend>{t("design.screens.formats")}</legend>
        <div className="btn-row">
          {FORMATS.map((f) => (
            <label key={f} className="tools-opt">
              <input type="checkbox" checked={formats.has(f)} onChange={() => toggle(formats, f, setFormats)} />
              <span>{f.toUpperCase()}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="tools-group" disabled={!raster}>
        <legend>{t("design.screens.scales")}</legend>
        <div className="btn-row">
          {SCALES.map((k) => (
            <label key={k} className="tools-opt">
              <input type="checkbox" checked={scales.has(k)} onChange={() => toggle(scales, k, setScales)} />
              <span>{k}x</span>
            </label>
          ))}
        </div>
      </fieldset>
      <p className="muted-note">{count > 1 ? t("design.screens.zipNote", { n: count }) : t("design.screens.oneNote")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("design.xf.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!count} onClick={() => void run()}>
          {t("design.screens.export")}
        </button>
      </div>
    </Modal>
  );
}
