import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icons";
import { cx } from "./controls";
import { docTitle, useLang, useT } from "../../i18n";

/** Date-format locale for each UI language. */
const DATE_LOCALE = { ko: "ko-KR", en: "en-US", zh: "zh-CN", ja: "ja-JP" } as const;

export function Modal({ children, onClose, labelledBy, className }: { children: ReactNode; onClose?: () => void; labelledBy: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    (ref.current?.querySelector<HTMLElement>("[data-autofocus]") ?? ref.current?.querySelector<HTMLElement>("button"))?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && closeRef.current) {
        e.stopPropagation();
        closeRef.current();
      }
      if (e.key === "Tab" && ref.current) {
        // keep focus inside the dialog
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>("button:not(:disabled), input, [tabindex='0']"));
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, []);
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div ref={ref} className={cx("modal", className)} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}

export function RecoveryDialog({ info, onRestore, onDiscard }: { info: { savedAt: number; title: string; count?: number }; onRestore: () => Promise<void>; onDiscard: () => void }) {
  const [busy, setBusy] = useState(false);
  const t = useT();
  const lang = useLang((s) => s.lang);
  const when = new Date(info.savedAt);
  const fmt = when.toLocaleString(DATE_LOCALE[lang], { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });
  // the document title is shown in bold inside the translated sentence
  const [before, after] = t("shell.recover.found").split("{title}");
  return (
    <Modal labelledBy="recover-title" className="modal-sm">
      <div className="modal-icon">
        <Icon name="clock" size={22} />
      </div>
      <h2 id="recover-title">{t("shell.recover.title")}</h2>
      <p className="modal-text">
        {before}
        <b>{docTitle(info.title)}</b>
        {(info.count ?? 1) > 1 && <> {t("tabs.recover.more", { n: (info.count ?? 1) - 1 })}</>}
        {after}
        <br />
        {t("shell.recover.lastSaved", { time: fmt })}
      </p>
      <p className="modal-sub">{t("shell.recover.journal")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={onDiscard}>
          {t("shell.recover.startNew")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onRestore();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? t("shell.recover.restoring") : t("shell.recover.restore")}
        </button>
      </div>
    </Modal>
  );
}
