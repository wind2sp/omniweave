// "Use it like an app": a short card, once, on a phone or tablet in the browser (not yet on the home screen).
// - iPhone / iPad Safari: how to add it to the home screen (Share → Add to Home Screen; iOS has no install prompt).
//   There is no App Store version: the home-screen web app is Omniweave on iPhone (decided 2026-11-22).
// - Android Chrome (and other browsers that offer it): an "Install" button for the browser's own install dialog.
// Closing it (or installing) hides it for good in this browser. Desktop browsers keep their own address-bar offer.

import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { isTauri } from "../../io/platform";
import { isAndroid, isIOS, isInAppBrowser, isStandalone } from "../../web/device";
import { promptInstall, usePwa } from "../../web/pwa";

const KEY = "omniweave.web.installHint";
/** after the start-up dialogs, not over the first paint */
const DELAY_MS = 2500;

export type HintKind = "ios" | "install" | null;

/** Which card to show (pure: tests feed the situation in). */
export function installHintKind(s: { tauri: boolean; standalone: boolean; seen: boolean; ios: boolean; android: boolean; inApp: boolean; canInstall: boolean }): HintKind {
  if (s.tauri || s.standalone || s.seen || s.inApp) return null;
  if (s.ios) return "ios";
  if (s.android && s.canInstall) return "install";
  return null;
}

function seen(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** iOS Share symbol (square with an arrow up). */
const ShareGlyph = () => (
  <svg className="web-install-glyph" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 3v12M8 7l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8a1.5 1.5 0 0 0-1.5-1.5H16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

/** iOS "Add to Home Screen" symbol (plus in a rounded square). */
const AddGlyph = () => (
  <svg className="web-install-glyph" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M12 8.5v7M8.5 12h7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

export function WebInstallHint() {
  const t = useT();
  const { canInstall } = usePwa();
  const [closed, setClosed] = useState(seen);
  const [due, setDue] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDue(true), DELAY_MS);
    return () => clearTimeout(id);
  }, []);

  const kind = installHintKind({
    tauri: isTauri,
    standalone: isStandalone(),
    seen: closed,
    ios: isIOS(),
    android: isAndroid(),
    inApp: isInAppBrowser(),
    canInstall,
  });
  if (!due || !kind) return null;

  const close = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
    setClosed(true);
  };

  return (
    <div className="web-install" role="dialog" aria-labelledby="web-install-title">
      <button type="button" className="web-install-close" aria-label={t("web.install.close")} onClick={close}>
        ×
      </button>
      <img className="web-install-icon" src="app_small.png" alt="" />
      <div className="web-install-body">
        <h2 id="web-install-title">{t(kind === "ios" ? "web.install.iosTitle" : "web.install.title")}</h2>
        {kind === "ios" ? (
          <ol className="web-install-steps">
            <li>
              {t("web.install.iosShare")} <ShareGlyph />
            </li>
            <li>
              {t("web.install.iosAdd")} <AddGlyph />
            </li>
          </ol>
        ) : (
          <p>{t("web.install.text")}</p>
        )}
        {kind === "install" && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void promptInstall().then(close);
            }}
          >
            {t("web.install.button")}
          </button>
        )}
      </div>
    </div>
  );
}
