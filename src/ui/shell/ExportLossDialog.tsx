// "This format cannot hold these objects" — asked before a save writes a file that would leave content out
// (ui/exportGuard.ts), with a choice that loses nothing: save as .omw instead. Promise-based like SecurityDialogs.

import { useEffect } from "react";
import { create } from "zustand";
import { useT } from "../../i18n";
import type { LossItem } from "../exportGuard";
import { Icon } from "./Icons";
import { Modal } from "./Dialogs";

export type LossChoice = "save" | "omw" | null;
export interface LossRequest {
  ext: string;
  items: LossItem[];
}

type Pending = { req: LossRequest; resolve: (v: LossChoice) => void };
const useLoss = create<{ pending: Pending | null }>(() => ({ pending: null }));

/** number of mounted dialogs; with none (tests, the phone screen) the browser's own confirm asks instead */
let mounted = 0;
export const lossDialogMounted = () => mounted > 0;

export function askExportLoss(req: LossRequest): Promise<LossChoice> {
  return new Promise((resolve) => {
    if (!mounted) return resolve(null);
    const prev = useLoss.getState().pending;
    useLoss.setState({ pending: { req, resolve } });
    prev?.resolve(null);
  });
}

export function ExportLossDialog() {
  const pending = useLoss((s) => s.pending);
  const t = useT();
  useEffect(() => {
    mounted++;
    return () => {
      mounted--;
      if (!mounted) useLoss.getState().pending?.resolve(null);
    };
  }, []);
  if (!pending) return null;
  const { req } = pending;
  const done = (v: LossChoice) => {
    useLoss.setState({ pending: null });
    pending.resolve(v);
  };
  const [before, after] = t("exportloss.text").split("{ext}");
  return (
    <Modal labelledBy="el-title" className="modal-sm" onClose={() => done(null)}>
      <div className="modal-icon">
        <Icon name="info" size={22} />
      </div>
      <h2 id="el-title">{t("exportloss.title")}</h2>
      <p className="modal-text">
        {before}
        <b>.{req.ext}</b>
        {after}
      </p>
      <ul className="modal-text export-loss-list">
        {req.items.map((i) => (
          <li key={i.prop}>{t("exportloss.item", { what: t(`style.prop.${i.prop}`), n: i.count })}</li>
        ))}
      </ul>
      <p className="modal-sub">{t("exportloss.hint")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={() => done(null)}>
          {t("shell.cancel")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => done("save")}>
          {t("exportloss.saveAnyway", { ext: req.ext.toUpperCase() })}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => done("omw")}>
          {t("exportloss.saveOmw")}
        </button>
      </div>
    </Modal>
  );
}
