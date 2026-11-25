// The desktop editor on a phone ("PC 기능 전체"): the same App as the installed program — every menu command, ribbon,
// tool, panel and dialog — laid out for a phone (mobile.css `html.phone-desk`: one column, every control at least 44 px,
// text at least 14 px, the menus as a sheet of large rows and the frequent commands on a bottom bar (DeskBar.tsx), the
// formatting ribbon on demand, the panels as sheets from the bottom). The phone shell (MobileApp) hands it a
// file, or the document its own editor already holds; "휴대폰 화면" goes back. Nothing here re-implements an editor
// command: what the desktop does, it does here with the desktop's own code.

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t, useT } from "../../i18n";
import { setPasswordAsker } from "../../io/crypto/session";
import type { OpenedFile } from "../../io/platform";
import { useBackClose } from "./back";
import { knownPassword } from "./openDoc";
import { phonePasswordAsker } from "./prompt";

const App = lazy(() => import("../App").then((m) => ({ default: m.App })));
// large buttons for fingers: every menu, undo, ribbon, panel, save, back (DeskBar.tsx)
const DeskBar = lazy(() => import("./DeskBar").then((m) => ({ default: m.DeskBar })));

export interface PhoneDeskProps {
  /** a file to open in a tab of its own; none = the document already in the editor store (the phone editor's) */
  file?: OpenedFile | null;
  /** a desktop command to run once the file is open (ui/commands.ts id, e.g. "edit.find", "file.print") */
  command?: string | null;
  /** back to the phone screen; `saved`: the file as saved there in its own format (the phone's viewer shows that) */
  onExit: (saved?: { name: string; bytes: Uint8Array }) => void;
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

  // a slide show (발표) takes the whole phone, held sideways: no bars of ours, the browser's full screen and landscape
  // (the Android app: the system bars hidden and the screen turned by the activity, SharePlugin.kt present)
  useEffect(() => {
    let unsub: (() => void) | undefined;
    let alive = true;
    void import("../../core/store").then(({ useStore }) => {
      if (!alive) return;
      unsub = useStore.subscribe((s, prev) => {
        if (!!s.presenting === !!prev.presenting) return;
        void presentMode(!!s.presenting);
      });
    });
    return () => {
      alive = false;
      unsub?.();
      if (document.documentElement.classList.contains("pd-presenting")) void presentMode(false);
    };
  }, []);

  // leaving asks about unsaved tabs with the desktop's own dialog (they are kept in memory otherwise: coming back
  // shows them again)
  /** the file's document as it was opened here (its edits are told apart from it on the way back) */
  const opened = useRef<object | null>(null);
  const exit = useCallback(async () => {
    const { anyDirty, confirmAllSaved } = await import("../tabs");
    if (anyDirty() && !(await confirmAllSaved())) return;
    // saved after editing (not dirty, not the document it opened with): the file in its own format goes back to the
    // phone's viewer, so it shows — and 공유 sends — what was saved, never the file from before the edits
    let saved: { name: string; bytes: Uint8Array } | undefined;
    try {
      const { useStore } = await import("../../core/store");
      const st = useStore.getState();
      if (file && opened.current && st.doc !== opened.current && !st.dirty) {
        const { produce } = await import("./editor/session");
        const r = await produce("same", { name: file.name, original: file.bytes, loaded: opened.current as never, warnings: [] }, () => true);
        saved = { name: r.name, bytes: r.bytes };
      }
    } catch {
      /* a format that cannot be written again: the viewer keeps the file as it was */
    }
    onExit(saved);
  }, [onExit, file]);
  // back (Android gesture / button): the newest desktop layer closes first — a dialog, the 파일 screen, a menu — as Esc
  // does on a PC; with none open, back to the phone screen
  const [backTick, setBackTick] = useState(0);
  const onBack = useCallback(() => {
    if (document.querySelector(".modal-backdrop, .backstage, .menu-pop")) {
      (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
      setBackTick((n) => n + 1);
    } else void exit();
  }, [exit]);

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
          opened.current = (await import("../../core/store")).useStore.getState().doc;
        }
        requestAnimationFrame(() => fitCurrent());
        // again once the phone layout has settled (fonts, the ribbon's height)
        setTimeout(() => fitCurrent(), 500);
        const cmds = await import("../commands");
        // automated checks (scripts/mobile-parity-e2e.mjs): run a desktop command by id, read the editor state
        (window as any).__omwDesk = { run: (id: string) => cmds.command(id)?.run(), exportAs: (id: string) => import("../actions").then((m) => m.exportAs(id)), store: (await import("../../core/store")).useStore };
        // a picture command (글자 인식, 업스케일 …) from the phone's 더보기 works on the page's picture: select it first
        if ((command?.startsWith("image.") || command?.startsWith("op:") || command === "object.rotateCW") && !(window as any).__omwDesk.store.getState().selection.length) cmds.command("edit.selectAll")?.run();
        // "op:<id>": an adjustment of the image menu (명도/대비 …) in its own dialog
        if (command?.startsWith("op:")) (await import("../shell/imageMenu")).useImageUI.getState().set({ kind: "op", op: command.slice(3) });
        else if (command) cmds.command(command)?.run();
        return !command;
      },
      onExit: () => void exit(),
    };
    // one start per opened file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, command]);

  return (
    <Suspense fallback={<div className="m-spinner" role="progressbar" aria-label={tr("mobile.working")} />}>
      <BackGuard key={backTick} onBack={onBack} />
      <App phone={phone} />
      <DeskBar onExit={() => void exit()} />
    </Suspense>
  );
}

/** one history entry for the back gesture (a new one after each back that only closed a desktop layer) */
function BackGuard({ onBack }: { onBack: () => void }) {
  useBackClose(true, onBack);
  return null;
}

/** Full screen and sideways for a slide show, or back. */
async function presentMode(on: boolean) {
  document.documentElement.classList.toggle("pd-presenting", on);
  const { isTauri } = await import("../../io/platform");
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return void invoke("present_mode", { on }).catch(() => {});
  }
  try {
    if (on) {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.("landscape");
    } else {
      (screen.orientation as ScreenOrientation & { unlock?: () => void }).unlock?.();
      if (document.fullscreenElement) await document.exitFullscreen();
    }
  } catch {
    /* a browser that does not allow it: the show still fills the page */
  }
}
