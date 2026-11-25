// Status bar of the document edit mode: page n of m, word (and, in Korean / Japanese / Chinese, character) count,
// the text's language, save state and the zoom slider with page-width / whole-page presets. The renderer's meters
// (tiles, fps, object count) belong to the design modes and are not shown here.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../../core/store";
import { IconBtn, Menu, cx } from "./controls";
import { Icon } from "./Icons";
import { useUI } from "./uiStore";
import { zoomStep, zoomTo, ZOOM_MAX, ZOOM_MIN } from "./ops";
import { docLanguage, docPages, docStats } from "./DocNav";
import { docZoom } from "./DocRibbon";
import { toggleRulers } from "../aids";
import { FidelityBadge } from "../fidelityBadge";
import { ProgressIndicator } from "./ProgressIndicator";
import { selectPage } from "../pageActions";
import { LANGS, t as tr, useLang, useT } from "../../i18n";

const LO = Math.log2(0.1), HI = Math.log2(5);

function ago(at: number, now: number) {
  const s = Math.round((now - at) / 1000);
  if (s < 10) return tr("shell.ago.now");
  if (s < 60) return tr("shell.ago.seconds", { n: s });
  return tr("shell.ago.minutes", { n: Math.round(s / 60) });
}

/** Page n of m where n can be typed (Enter goes there; a number out of range goes to the nearest page). */
function PageBox({ n, ids }: { n: number; ids: string[] }) {
  const t = useT();
  const [text, setText] = useState<string | null>(null);
  const go = () => {
    const k = Math.round(Number(text));
    setText(null);
    if (!Number.isFinite(k)) return;
    const id = ids[Math.max(0, Math.min(ids.length - 1, k - 1))];
    if (id) selectPage(id);
  };
  return (
    <span className="sb-item sb-pagebox" data-tip={t("docmode.status.pageBoxTip")}>
      <input
        aria-label={t("docmode.status.pageBoxTip")}
        inputMode="numeric"
        value={text ?? String(n)}
        size={Math.max(2, String(ids.length).length)}
        onFocus={(e) => (setText(String(n)), requestAnimationFrame(() => e.target.select()))}
        onChange={(e) => setText(e.target.value.replace(/[^\d]/g, ""))}
        onBlur={() => setText(null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.preventDefault(), go(), (e.target as HTMLInputElement).blur());
          if (e.key === "Escape") (setText(null), (e.target as HTMLInputElement).blur());
        }}
      />
      <span>/ {t("docmode.status.pageCount", { m: ids.length })}</span>
    </span>
  );
}

export function DocStatusBar() {
  const t = useT();
  const lang = useLang((s) => s.lang);
  const doc = useStore((s) => s.doc);
  const mode = useStore((s) => s.mode);
  const pageId = useStore((s) => s.pageId);
  const zoom = useStore((s) => s.view.zoom);
  const dirty = useStore((s) => s.dirty);
  const filePath = useStore((s) => s.filePath);
  const journalAt = useUI((s) => s.journalAt);
  const rulers = useUI((s) => s.rulers);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  const pages = useMemo(() => docPages(doc, mode), [doc, mode]);
  // counting walks every paragraph: once per document change, not per render
  const st = useMemo(() => docStats(doc, mode), [doc, mode]);
  const textLang = useMemo(() => docLanguage(doc, mode), [doc, mode]);
  const n = pages.findIndex((p) => p.id === pageId) + 1;
  const page = pages[n - 1];
  const cjk = lang !== "en";
  const slider = Math.round(((Math.log2(Math.max(0.1, Math.min(5, zoom))) - LO) / (HI - LO)) * 1000);
  return (
    <footer className="statusbar doc-status">
      {page?.nodes.some((x) => x.type === "PDF") ? (
        // a PDF: the page number can be typed to go there (Acrobat's page box)
        <PageBox n={Math.max(1, n)} ids={pages.map((p) => p.id)} />
      ) : (
        <button type="button" className="sb-item sb-btn" data-tip={t("docmode.status.pageTip")} onClick={() => useUI.getState().set({ leftOpen: true })}>
          {t("docmode.status.page", { n: Math.max(1, n), m: pages.length })}
        </button>
      )}
      <span className="sb-div" />
      <button type="button" className="sb-item sb-btn" data-tip={t("docmode.status.countTip")} onClick={() => useUI.getState().set({ shellDialog: "wordCount" })}>
        {t("docmode.status.words", { n: st.words.toLocaleString() })}
        {cjk && <span className="sb-sub">{t("docmode.status.chars", { n: st.charsNoSpaces.toLocaleString() })}</span>}
      </button>
      {textLang && (
        <>
          <span className="sb-div" />
          <span className="sb-item" data-tip={t("docmode.status.langTip")}>
            {LANGS.find((l) => l.id === textLang)?.name}
          </span>
        </>
      )}
      <span className="sb-spacer" />
      <FidelityBadge page={page} />
      <span className={cx("sb-item", "save-state", dirty ? "dirty" : "clean")} data-tip={filePath ?? undefined}>
        <span className="save-dot" />
        {dirty ? t("shell.notSaved") : filePath ? t("shell.saved") : t("cmd.file.new")}
        {dirty && journalAt && <small>· {t("shell.autoRecovery", { ago: ago(journalAt, now) })}</small>}
      </span>
      <span className="sb-div" />
      <button type="button" className={cx("sb-tog", rulers && "on")} data-tip={t("cmd.view.rulers")} data-kbd="Ctrl+R" onClick={toggleRulers}>
        <Icon name="ruler" size={13} />
      </button>
      <IconBtn icon="zoomPage" size="sm" tip={t("docmode.onePage")} onClick={() => docZoom("page")} />
      <IconBtn icon="zoomWidth" size="sm" tip={t("docmode.pageWidth")} onClick={() => docZoom("width")} />
      <span className="sb-div" />
      <div className="zoom-ctl doc-zoom">
        <IconBtn icon="minus" size="sm" tip={t("cmd.view.zoomOut")} kbd="Ctrl+-" onClick={() => zoomStep(-1)} />
        <input
          type="range"
          className="zoom-slider"
          min={0}
          max={1000}
          value={slider}
          aria-label={t("shell.zoomLevel")}
          onChange={(e) => {
            const z = Math.pow(2, LO + (Number(e.target.value) / 1000) * (HI - LO));
            // 100% is a detent
            zoomTo(Math.abs(z - 1) < 0.04 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
          }}
        />
        <IconBtn icon="plus" size="sm" tip={t("cmd.view.zoomIn")} kbd="Ctrl+=" onClick={() => zoomStep(1)} />
        <Menu
          className="zoom-val"
          tip={t("shell.zoomLevel")}
          align="right"
          button={<span>{Math.round(zoom * 100)}%</span>}
          items={[
            { label: t("docmode.pageWidth"), icon: "zoomWidth", onSelect: () => docZoom("width") },
            { label: t("docmode.onePage"), icon: "zoomPage", onSelect: () => docZoom("page") },
            { sep: true },
            ...[0.5, 0.75, 1, 1.25, 1.5, 2].map((z) => ({ label: `${z * 100}%`, kbd: z === 1 ? "Ctrl+1" : undefined, checked: Math.abs(zoom - z) < 0.001, onSelect: () => zoomTo(z) })),
          ]}
        />
      </div>
      <ProgressIndicator />
    </footer>
  );
}
