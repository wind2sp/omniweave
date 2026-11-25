// 상용구 등록 / 상용구 내용 (한글 Alt+I · Ctrl+F3) — Word 자동 텍스트 (Alt+F3 · F3): keep the selected text under a
// short name, or pick a kept one to put in at the caret (ui/autoText.ts).

import { useMemo, useState } from "react";
import { useT } from "../../i18n";
import { addAutoText, autoTextMode, autoTexts, autoTextSelection, removeAutoText } from "../autoText";
import { richApi } from "../RichTextEditor";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });

export function AutoTextDialog() {
  const t = useT();
  const mode = useMemo(autoTextMode, []);
  const sel = useMemo(autoTextSelection, []);
  const [name, setName] = useState(() => sel.trim().split(/\s+/)[0]?.slice(0, 12) ?? "");
  const [list, setList] = useState(autoTexts);
  const [pick, setPick] = useState(list[0]?.name ?? "");
  const put = (text: string) => {
    const api = richApi();
    if (api) {
      api.insertText(text);
      setTimeout(() => api.focus());
    }
    close();
  };
  if (mode === "add")
    return (
      <Modal labelledBy="at-title" className="modal-sm" onClose={close}>
        <h2 id="at-title">{t("autotext.addTitle")}</h2>
        <p className="modal-sub">{t("autotext.addSub")}</p>
        <label className="tools-opt">
          <span>{t("autotext.name")}</span>
          <input type="text" data-autofocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && (addAutoText(name, sel), close())} style={{ flex: 1 }} />
        </label>
        <label className="tools-opt">
          <span>{t("autotext.text")}</span>
          <textarea readOnly value={sel} rows={3} style={{ flex: 1 }} />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={close}>
            {t("paragraph.cancel")}
          </button>
          <button type="button" className="btn btn-primary" disabled={!name.trim() || !sel} onClick={() => (addAutoText(name, sel), close())}>
            {t("autotext.add")}
          </button>
        </div>
      </Modal>
    );
  const cur = list.find((e) => e.name === pick);
  return (
    <Modal labelledBy="at-title" className="modal-sm" onClose={close}>
      <h2 id="at-title">{t("autotext.listTitle")}</h2>
      <p className="modal-sub">{list.length ? t("autotext.listSub") : t("autotext.empty")}</p>
      {list.length > 0 && (
        <select size={Math.min(8, Math.max(3, list.length))} value={pick} aria-label={t("autotext.listTitle")} onChange={(e) => setPick(e.target.value)} onDoubleClick={() => cur && put(cur.text)} style={{ width: "100%" }}>
          {list.map((e) => (
            <option key={e.name} value={e.name}>
              {e.name} — {e.text.replace(/\s+/g, " ").slice(0, 40)}
            </option>
          ))}
        </select>
      )}
      {cur && <p className="muted-note">{cur.text.slice(0, 200)}</p>}
      <div className="modal-actions">
        {cur && (
          <button type="button" className="btn btn-ghost" onClick={() => (removeAutoText(cur.name), setList(autoTexts()), setPick(autoTexts()[0]?.name ?? ""))}>
            {t("autotext.remove")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus disabled={!cur || !richApi()} onClick={() => cur && put(cur.text)}>
          {t("autotext.put")}
        </button>
      </div>
    </Modal>
  );
}
