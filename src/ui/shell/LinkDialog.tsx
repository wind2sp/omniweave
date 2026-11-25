// 하이퍼링크 넣기 / 편집 (Ctrl+K): the text shown and the address; 링크 제거 when the text has one (ui/linkActions.ts).

import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { applyLink, linkHere, removeLink } from "../linkActions";
import { richApi } from "../RichTextEditor";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });

export function LinkDialog() {
  const t = useT();
  const sel = useMemo(() => richApi()?.selectedText?.() ?? "", []);
  const had = useMemo(linkHere, []);
  const [text, setText] = useState(sel);
  const [url, setUrl] = useState(had ?? "");
  const ok = () => {
    if (applyLink(url, text, sel)) close();
  };
  return (
    <Modal labelledBy="link-title" className="modal-sm" onClose={close}>
      <h2 id="link-title">{t(had ? "docux.link.edit" : "docux.link.title")}</h2>
      <label className="tools-opt">
        <span>{t("docux.link.text")}</span>
        <input type="text" value={text} onChange={(e) => setText(e.target.value)} style={{ flex: 1 }} />
      </label>
      <label className="tools-opt">
        <span>{t("docux.link.address")}</span>
        <input
          type="text"
          data-autofocus
          value={url}
          placeholder="https://"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), ok())}
          style={{ flex: 1 }}
        />
      </label>
      <div className="modal-actions">
        {had && (
          <button type="button" className="btn btn-ghost" onClick={() => (removeLink(), close())}>
            {t("docux.link.remove")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!url.trim()} onClick={ok}>
          {t("paragraph.apply")}
        </button>
      </div>
    </Modal>
  );
}
