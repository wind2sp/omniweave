// The desktop editor on a phone ("PC 기능 전체"): the same App as the installed program — every menu command, ribbon,
// tool, panel and dialog — laid out for a phone (mobile.css `html.phone-desk`: one column, the ribbon and menus
// scroll sideways, the side panels come over the page, larger touch targets). The phone shell (MobileApp) hands it a
// file, or the document its own editor already holds; "휴대폰 화면" goes back. Nothing here re-implements an editor
// command: what the desktop does, it does here with the desktop's own code.

import { lazy, Suspense, useCallback, useEffect, useMemo } from "react";
import { t, useT } from "../../i18n";
import { setPasswordAsker } from "../../io/crypto/session";
import type { OpenedFile } from "../../io/platform";
import { useBackClose } from "./back";
import { knownPassword } from "./openDoc";
import { phonePasswordAsker } from "./prompt";

const App = lazy(() => import("../App").then((m) => ({ default: m.App })));

export interface PhoneDeskProps {
  /** a file to open in a tab of its own; none = the document already in the editor store (the phone editor's) */
  file?: OpenedFile | null;
  /** a desktop command to run once the file is open (ui/commands.ts id, e.g. "edit.find", "file.print") */
  command?: string | null;
  onExit: () => void;
}

/** class on <html> while the desktop editor is shown on the phone (mobile.css) */
export const PHONE_DESK_CLASS = "phone-desk";

export function PhoneDesk({ file, command, onExit }: PhoneDeskProps) {
  const tr = useT();
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(PHONE_DESK_CLASS);
    return () => {
      root.classList.remove(PHONE_DESK_CLASS);
      // the desktop's dialogs (SecurityDialogs) took over the password question while it was open
      setPasswordAsker(phonePasswordAsker(t));
      delete root.dataset.surface;
    };
  }, []);

  // leaving asks about unsaved tabs with the desktop's own dialog (they are kept in memory otherwise: coming back
  // shows them again)
  const exit = useCallback(async () => {
    const { anyDirty, confirmAllSaved } = await import("../tabs");
    if (anyDirty() && !(await confirmAllSaved())) return;
    onExit();
  }, [onExit]);
  useBackClose(true, () => void exit());

  const phone = useMemo(() => {
    let started = false;
    return {
      start: async () => {
        // (once, also when React runs the start-up effect twice in development)
        if (started) return !command;
        started = true;
        const [{ openInTab, fitCurrent }, { useUI }, { askPasswordDialog }] = await Promise.all([import("../actions"), import("../shell/uiStore"), import("../shell/SecurityDialogs")]);
        // panels start closed: the page gets the whole width (they open over it from the rails)
        // (and no rulers: on a phone they take a tenth of the width; 보기 ▸ 눈금자 brings them back)
        useUI.getState().set({ leftOpen: false, rightOpen: false, welcome: false, rulers: false });
        if (file) {
          // the password the phone's viewer already opened this file with is tried first
          let offered = knownPassword(file.bytes);
          setPasswordAsker((req) => {
            if (offered != null && !req.retry) {
              const pw = offered;
              offered = null;
              return Promise.resolve(pw);
            }
            return askPasswordDialog(req);
          });
          await openInTab(file);
          setPasswordAsker(askPasswordDialog);
        }
        requestAnimationFrame(() => fitCurrent());
        // again once the phone layout has settled (fonts, the ribbon's height)
        setTimeout(() => fitCurrent(), 500);
        const cmds = await import("../commands");
        // automated checks (scripts/mobile-parity-e2e.mjs): run a desktop command by id, read the editor state
        (window as any).__omwDesk = { run: (id: string) => cmds.command(id)?.run(), exportAs: (id: string) => import("../actions").then((m) => m.exportAs(id)), store: (await import("../../core/store")).useStore };
        // a picture command (글자 인식, 업스케일 …) from the phone's 더보기 works on the page's picture: select it first
        if (command?.startsWith("image.") && !(window as any).__omwDesk.store.getState().selection.length) cmds.command("edit.selectAll")?.run();
        if (command) cmds.command(command)?.run();
        return !command;
      },
      onExit: () => void exit(),
    };
    // one start per opened file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, command]);

  return (
    <Suspense fallback={<div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />}>
      <App phone={phone} />
    </Suspense>
  );
}
