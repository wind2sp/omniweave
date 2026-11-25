// 덧말 넣기 / 고치기 (한글 입력 ▸ 덧말, Word 윗주 달기): the 덧말 over (or under) the selected text, its size;
// 덧말 지우기 when the text has one. The 덧말 is TextRun.ruby (core/richtext.ts setRuby); DOCX writes w:ruby, HWPX hp:dutmal.

import { useMemo, useState } from "react";
import type { Ruby } from "../../core/types";
import { useT } from "../../i18n";
import { richApi } from "../RichTextEditor";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

const close = () => useUI.getState().set({ shellDialog: null });

export function RubyDialog() {
  const t = useT();
  const api = richApi();
  const had = useMemo(() => api?.rubyAt?.(), [api]);
  const base = useMemo(() => api?.selectedText?.() ?? "", [api]);
  const [text, setText] = useState(had?.text ?? "");
  const [below, setBelow] = useState(!!had?.below);
  // size as a percent of the text's (blank: the default, half the size); left as it was, a size read from a file stays
  const pct0 = had?.src?.szRatio && had.src.szRatio !== "0" ? had.src.szRatio : "";
  const [pct, setPct] = useState(pct0);
  const ok = () => {
    if (!api?.setRuby || !text.trim()) return;
    const next: Ruby = { ...(had ?? { text }), text: text.trim() };
    delete next.below;
    if (below) next.below = true;
    if (pct !== pct0) {
      delete next.size;
      const n = Math.round(Number(pct));
      const src = { ...(next.src ?? {}) };
      if (n > 0) src.szRatio = String(n);
      else delete src.szRatio;
      if (Object.keys(src).length) next.src = src;
      else delete next.src;
    }
    api.setRuby(next, t("docux.ruby.hist"));
    close();
  };
  return (
    <Modal labelledBy="ruby-title" className="modal-sm" onClose={close}>
      <h2 id="ruby-title">{t(had ? "docux.ruby.edit" : "docux.ruby.title")}</h2>
      {base && (
        <label className="tools-opt">
          <span>{t("docux.ruby.base")}</span>
          <input type="text" value={base} readOnly style={{ flex: 1 }} />
        </label>
      )}
      <label className="tools-opt">
        <span>{t("docux.ruby.text")}</span>
        <input
          type="text"
          data-autofocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), ok())}
          style={{ flex: 1 }}
        />
      </label>
      <label className="tools-opt">
        <span>{t("docux.ruby.pos")}</span>
        <select value={below ? "under" : "over"} onChange={(e) => setBelow(e.target.value === "under")}>
          <option value="over">{t("docux.ruby.over")}</option>
          <option value="under">{t("docux.ruby.under")}</option>
        </select>
      </label>
      <label className="tools-opt">
        <span>{t("docux.ruby.size")}</span>
        <input type="number" min={10} max={100} step={5} value={pct} placeholder="50" onChange={(e) => setPct(e.target.value)} style={{ width: 80 }} />
      </label>
      {below && <p className="muted-note">{t("docux.ruby.underNote")}</p>}
      <div className="modal-actions">
        {had && (
          <button type="button" className="btn btn-ghost" onClick={() => (api?.setRuby?.(null, t("docux.ruby.remove")), close())}>
            {t("docux.ruby.remove")}
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("paragraph.cancel")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!text.trim()} onClick={ok}>
          {t("paragraph.apply")}
        </button>
      </div>
    </Modal>
  );
}
