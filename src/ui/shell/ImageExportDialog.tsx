// Before a JPG / WebP is written: quality (0…100), the background a JPG puts where the picture is transparent, and
// what is kept of a JPG original's photo information (EXIF: kept without the location by default, or none at all).
// Promise-based like SecurityDialogs, so the export code can await it; with no dialog mounted the defaults are used.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { useT } from "../../i18n";
import { DEFAULT_QUALITY, defaultPictureOptions, type PictureOptions, type PictureOptionsRequest } from "../../io/formats/pictureExport";
import { Modal } from "./Dialogs";
import { Icon } from "./Icons";

type Pending = { req: PictureOptionsRequest; resolve: (v: PictureOptions | null) => void };

const usePending = create<{ pending: Pending | null }>(() => ({ pending: null }));
let mounted = 0;

/** the choices of the last export in this session (quality per format, background, photo information) */
const last: { quality: Record<string, number>; background: string; dropAll: boolean; keepGps: boolean } = { quality: {}, background: "#ffffff", dropAll: false, keepGps: false };

export function askPictureOptions(req: PictureOptionsRequest): Promise<PictureOptions | null> {
  return new Promise((resolve) => {
    if (!mounted) return resolve(defaultPictureOptions());
    usePending.getState().pending?.resolve(null);
    usePending.setState({ pending: { req, resolve } });
  });
}

export function ImageExportDialog() {
  const pending = usePending((s) => s.pending);
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      if (!mounted) {
        usePending.getState().pending?.resolve(null);
        usePending.setState({ pending: null });
      }
    };
  }, []);
  return pending ? <Body key={pending.req.format + String(pending.req.hasExif)} pending={pending} /> : null;
}

function Body({ pending }: { pending: Pending }) {
  const t = useT();
  const { req, resolve } = pending;
  const [quality, setQuality] = useState(last.quality[req.format] ?? DEFAULT_QUALITY);
  const [background, setBackground] = useState(last.background);
  const [dropAll, setDropAll] = useState(last.dropAll);
  const [keepGps, setKeepGps] = useState(last.keepGps);
  const done = (v: PictureOptions | null) => {
    usePending.setState({ pending: null });
    if (v) Object.assign(last, { background, dropAll, keepGps, quality: { ...last.quality, [req.format]: quality } });
    resolve(v);
  };
  const jpg = req.format === "jpg";
  const submit = () => done({ quality, background, exif: dropAll ? "none" : keepGps ? "keep" : "noGps" });
  return (
    <Modal labelledBy="ie-title" className="modal-sm" onClose={() => done(null)}>
      <div className="modal-icon">
        <Icon name="export" size={22} />
      </div>
      <h2 id="ie-title">{t(jpg ? "imgexport.dialog.titleJpg" : "imgexport.dialog.titleWebp")}</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="tools-options">
          <label className="tools-opt">
            <span>{t("imgexport.dialog.quality")}</span>
            <input type="range" min={0} max={100} step={1} value={quality} data-autofocus onChange={(e) => setQuality(Number(e.target.value))} />
            <b>{quality}</b>
          </label>
          {jpg && (
            <label className="tools-opt">
              <span>{t("imgexport.dialog.background")}</span>
              <input type="color" value={background} onChange={(e) => setBackground(e.target.value)} />
            </label>
          )}
          {jpg && req.hasExif && (
            <label className="tools-opt check">
              <input type="checkbox" checked={dropAll} onChange={(e) => setDropAll(e.target.checked)} />
              <span>{t("imgexport.dialog.dropExif")}</span>
            </label>
          )}
          {jpg && req.hasExif && req.hasGps && (
            <label className="tools-opt check">
              <input type="checkbox" checked={keepGps && !dropAll} disabled={dropAll} onChange={(e) => setKeepGps(e.target.checked)} />
              <span>{t("imgexport.dialog.keepGps")}</span>
            </label>
          )}
        </div>
        {jpg && <p className="modal-sub">{t("imgexport.dialog.noAlpha")}</p>}
        {jpg && req.hasExif && <p className="modal-sub">{t(dropAll ? "imgexport.dialog.exifNone" : keepGps && req.hasGps ? "imgexport.dialog.exifAll" : "imgexport.dialog.exifNoGps")}</p>}
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={() => done(null)}>
            {t("shell.cancel")}
          </button>
          <button type="submit" className="btn btn-primary">
            {t("imgexport.dialog.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
