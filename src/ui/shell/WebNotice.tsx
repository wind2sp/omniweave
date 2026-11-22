// Browser on a phone or small tablet: the editor is laid out for a desktop browser (index.html scales the 960 px
// layout to the screen), so say once per visit that small screens are best for viewing. Nothing is blocked.

import { useState } from "react";
import { useT } from "../../i18n";
import { isTauri } from "../../io/platform";
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

function seen(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
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
      sessionStorage.setItem(KEY, "1");
    } catch {}
    setOpen(false);
  };
  return (
    <Modal labelledBy="web-mobile-title" className="modal-sm" onClose={close}>
      <h2 id="web-mobile-title">{t("web.mobile.title")}</h2>
      <p className="modal-text">{t("web.mobile.text")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-primary" data-autofocus onClick={close}>
          {t("web.mobile.ok")}
        </button>
      </div>
    </Modal>
  );
}
