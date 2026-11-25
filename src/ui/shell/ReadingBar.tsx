// Reading mode's top bar (Word's 읽기 모드): the document's name, page n / m, full screen and the way out (Esc).
import { findPage, useStore } from "../../core/store";
import { useT } from "../../i18n";
import { toggleFullScreen, toggleReadMode, useViewModes } from "../viewModes";
import { Icon } from "./Icons";

export function ReadingBar() {
  const t = useT();
  const title = useStore((s) => s.doc.title);
  const at = useStore((s) => {
    const p = findPage(s.doc, s.pageId);
    return p ? s.doc.pages.filter((x) => x.kind === p.kind).indexOf(p) + 1 : 0;
  });
  const total = useStore((s) => {
    const p = findPage(s.doc, s.pageId);
    return p ? s.doc.pages.filter((x) => x.kind === p.kind).length : s.doc.pages.length;
  });
  const fullscreen = useViewModes((s) => s.fullscreen);
  return (
    <header className="reading-bar" role="banner" aria-label={t("cmd.view.readMode")}>
      <span className="reading-title">
        <Icon name="doc" size={15} />
        <b>{title || t("cmd.view.readMode")}</b>
        <span className="reading-tag">{t("cmd.view.readMode")}</span>
      </span>
      {at > 0 && <span className="reading-pages">{t("reading.pages", { n: at, total })}</span>}
      <span className="reading-actions">
        <button type="button" className="ibtn ibtn-md with-label" data-tip={t("cmd.view.fullScreen")} data-kbd="F11" aria-pressed={fullscreen} onClick={() => void toggleFullScreen()}>
          <Icon name="fit" size={15} />
          <span className="ibtn-label">{t(fullscreen ? "reading.exitFull" : "cmd.view.fullScreen")}</span>
        </button>
        <button type="button" className="btn btn-primary btn-sm" data-tip={t("reading.exit")} data-kbd="Esc" onClick={() => toggleReadMode(false)}>
          {t("reading.exit")}
        </button>
      </span>
    </header>
  );
}
