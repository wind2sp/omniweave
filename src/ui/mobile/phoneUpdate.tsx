// The phone screen's web update (browser only, docs/RELEASING.md §웹판 업데이트). Phones rarely close a tab, so a new
// build waiting in the service worker would never take over, and the title-bar pill (ui/shell/WebUpdate.tsx) is not on
// the phone screen: with no file open (`idle`) the phone hands over and reloads by itself; with a file open it shows a
// bar for it (unsaved edits stay in the autosave journal).

import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { applyUpdate } from "../../web/pwa";
import { mayAutoUpdate, useWebUpdate } from "../shell/WebUpdate";
import { Icon } from "./icons";

export function PhoneUpdate({ idle }: { idle: boolean }) {
  const t = useT();
  const shown = useWebUpdate();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (shown && idle && !busy && mayAutoUpdate()) {
      setBusy(true);
      void applyUpdate();
    }
  }, [shown, idle, busy]);
  if (!shown) return null;
  return (
    <button
      type="button"
      className="m-update"
      aria-live="polite"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void applyUpdate();
      }}
    >
      <Icon name="rotate" />
      <span>{busy ? t("web.update.applying") : t("web.update.phone")}</span>
    </button>
  );
}
