// Browser on a phone or small tablet: the editor is laid out for a desktop browser (index.html scales the 960 px
// layout to the screen), so say once per visit that small screens are best for viewing. Nothing is blocked.
// As a home-screen app (standalone) it is said once for good, not at every start. iPhone / iPad add a line on
// Safari's memory limit (a page that uses too much is reloaded; the autosave journal brings the edits back).

import { useState } from "react";
import { useT } from "../../i18n";
import { isTauri } from "../../io/platform";
import { isIOS, isStandalone } from "../../web/device";
import { switchLayout } from "../../web/phone";
import { Modal } from "./Dialogs";

const KEY = "omniweave.web.mobileNotice";

/** A phone-sized screen with a touch pointer (not a narrow desktop window, which can be widened). */
export function isSmallTouchScreen(): boolean {
  if (isTauri || typeof window === "undefined") return false;
  try {
    return Math.min(screen.width, screen.height) < 600 && matchMedia("(pointer: coarse)").matches;
  } catch {
    return false;
  }
}

/** per visit in the browser; for good in the home-screen app */
const store = (): Storage => (isStandalone() ? localStorage : sessionStorage);

function seen(): boolean {
  try {
    return store().getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function WebMobileNotice() {
  const t = useT();
  const [open, setOpen] = useState(() => isSmallTouchScreen() && !seen());
  if (!open) return null;
  const close = () => {
    try {
      store().setItem(KEY, "1");
    } catch {}
    setOpen(false);
  };
  return (
    <Modal labelledBy="web-mobile-title" className="modal-sm web-phone" onClose={close}>
      <h2 id="web-mobile-title">{t("web.mobile.title")}</h2>
      <p className="modal-text">{t("web.mobile.text")}</p>
      {isIOS() && <p className="modal-text">{t("web.mobile.iosMemory")}</p>}
      <div className="modal-actions">
        {/* back to the phone screen (ui/mobile, web/phone.ts) — this editor was chosen with "PC 화면으로 보기" */}
        <button type="button" className="btn" onClick={() => switchLayout(null)}>
          {t("webphone.phoneLayout")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={close}>
          {t("web.mobile.ok")}
        </button>
      </div>
    </Modal>
  );
}
