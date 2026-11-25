// 문자 스타일 / 단락 스타일 (Illustrator's Character Styles and Paragraph Styles panels) as one small window with two
// tabs: the document's styles, the one the selected text uses marked; new from the selection, apply, redefine, rename
// (double-click) and delete. Work: ui/textStyles.ts.

import { useState } from "react";
import { create } from "zustand";
import { useStore } from "../../core/store";
import { useT } from "../../i18n";
import { applyStyle, currentStyleId, deleteStyle, newStyle, redefineStyle, renameStyle, stylesOf, type StyleKind } from "../textStyles";
import { Modal } from "./Dialogs";
import { useUI } from "./uiStore";

export const useTextStylesTab = create<{ kind: StyleKind }>(() => ({ kind: "char" }));

/** Open the styles window on a tab (the commands type.charStyles / type.paraStyles). */
export function openTextStyles(kind: StyleKind) {
  useTextStylesTab.setState({ kind });
  useUI.getState().set({ shellDialog: "textStyles" });
}

const close = () => useUI.getState().set({ shellDialog: null });

export function TextStylesDialog() {
  const t = useT();
  const kind = useTextStylesTab((s) => s.kind);
  const doc = useStore((s) => s.doc);
  const hasText = useStore((s) => s.selection.length > 0);
  const list = stylesOf(doc)[kind];
  const cur = currentStyleId(kind);
  const [picked, setPicked] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const sel = picked && list.some((s) => s.id === picked) ? picked : cur ?? null;
  const tab = (k: StyleKind) => (
    <button type="button" role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => (useTextStylesTab.setState({ kind: k }), setPicked(null))}>
      {t(k === "char" ? "cmd.type.charStyles" : "cmd.type.paraStyles")}
    </button>
  );
  return (
    <Modal labelledBy="tstyles-title" className="modal-sm" onClose={close}>
      <h2 id="tstyles-title">{t("design.styles.title")}</h2>
      <div className="seg" role="tablist">
        {tab("char")}
        {tab("para")}
      </div>
      <ul className="tstyles-list" role="listbox" aria-label={t(kind === "char" ? "cmd.type.charStyles" : "cmd.type.paraStyles")} style={{ listStyle: "none", margin: "8px 0", padding: 0, maxHeight: 220, overflow: "auto", minHeight: 80 }}>
        {!list.length && <li className="muted-note">{t("design.styles.empty")}</li>}
        {list.map((s) => (
          <li
            key={s.id}
            role="option"
            aria-selected={sel === s.id}
            className={sel === s.id ? "menu-item on" : "menu-item"}
            style={{ display: "flex", gap: 6, alignItems: "center", cursor: "default", fontWeight: s.id === cur ? 600 : 400 }}
            onClick={() => setPicked(s.id)}
            onDoubleClick={() => setRenaming(s.id)}
          >
            {renaming === s.id ? (
              <input
                autoFocus
                defaultValue={s.name}
                aria-label={t("design.styles.rename")}
                onBlur={(e) => (renameStyle(kind, s.id, e.currentTarget.value), setRenaming(null))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
            ) : (
              <span>
                {s.name}
                {s.id === cur ? ` · ${t("design.styles.inUse")}` : ""}
              </span>
            )}
          </li>
        ))}
      </ul>
      <div className="btn-row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn btn-ghost btn-sm" data-tip={t("design.styles.newTip")} onClick={() => setPicked(newStyle(kind))}>
          {t("design.styles.new")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!sel || !hasText} onClick={() => sel && applyStyle(kind, sel)}>
          {t("design.styles.apply")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!sel || !hasText} data-tip={t("design.styles.redefineTip")} onClick={() => sel && redefineStyle(kind, sel)}>
          {t("design.styles.redefine")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!sel} onClick={() => sel && setRenaming(sel)}>
          {t("design.styles.rename")}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={!sel} onClick={() => sel && (deleteStyle(kind, sel), setPicked(null))}>
          {t("design.styles.delete")}
        </button>
      </div>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" onClick={close}>
          {t("design.styles.close")}
        </button>
      </div>
    </Modal>
  );
}
