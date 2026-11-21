// "Save your changes?" for closing a tab, closing several, quitting, closing the window or updating (ui/tabs.ts).
import { docTitle, useT } from "../../i18n";
import { answerUnsaved, useTabPrompt } from "../tabs";
import { Modal } from "./Dialogs";
import { Icon } from "./Icons";
import { kindIcon } from "./DocTabs";
import { tabTitle } from "../../core/sessions";

export function TabDialogs() {
  const t = useT();
  const pending = useTabPrompt((s) => s.pending);
  if (!pending) return null;
  const { tabs } = pending;
  const one = tabs.length === 1;
  const [before, after] = t("tabs.save.one").split("{title}");
  return (
    <Modal labelledBy="tab-save-title" className="modal-sm" onClose={() => answerUnsaved("cancel")}>
      <h2 id="tab-save-title">{t("tabs.save.title")}</h2>
      <p className="modal-text">
        {one ? (
          <>
            {before}
            <b>{tabTitle(tabs[0], docTitle)}</b>
            {after}
          </>
        ) : (
          t("tabs.save.many", { n: tabs.length })
        )}
      </p>
      {!one && (
        <ul className="tab-save-list">
          {tabs.map((x) => (
            <li key={x.id}>
              <Icon name={kindIcon(x.kind)} size={14} />
              <span>{tabTitle(x, docTitle)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="modal-sub">{t("tabs.save.note")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={() => answerUnsaved("cancel")}>
          {t("tabs.save.cancel")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => answerUnsaved("discard")}>
          {t("tabs.save.discard")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => answerUnsaved("save")}>
          {one ? t("tabs.save.save") : t("tabs.save.saveAll")}
        </button>
      </div>
    </Modal>
  );
}
