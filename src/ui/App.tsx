// Application shell: top bar, adaptive ribbon, docks around the Loom canvas, status bar.
import { SecurityDialogs } from "./shell/SecurityDialogs";
import { useHistory } from "../core/history";

import { useEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import type { OmwDocument } from "../core/types";
import { endRun, journalClear, journalList, journalPeek, journalRestore, journalSave, startRunOnce } from "../io/journal";
import { activeSessionId, claimTab, isPristineActive, newSession } from "../core/sessions";
import { anyDirty, confirmAllSaved } from "./tabs";
import { TabDialogs } from "./shell/TabDialogs";
import { isTauri } from "../io/platform";
import { fitCurrent, isDocProtected, openDemoIfRequested, openStartupFile } from "./actions";
import { CanvasView } from "./CanvasView";
import { NotesPane, SlideSorter } from "./shell/SlideMode";
import { useSlideUI } from "./slideActions";
import { SheetView } from "./sheet/SheetView";
import { Presenter } from "./Presenter";
import { TooltipLayer, cx } from "./shell/controls";
import { RecoveryDialog } from "./shell/Dialogs";
import { StartScreen } from "./shell/StartScreen";
import { Icon } from "./shell/Icons";
import { LeftDock } from "./shell/LeftDock";
import { Ribbon, ToolBox } from "./shell/Ribbon";
import { Backstage } from "./shell/Backstage";
import { useSurface } from "./ribbonTabs";
import { RightDock } from "./shell/RightDock";
import { useGlobalShortcuts } from "./shell/shortcuts";
import { StatusBar } from "./shell/StatusBar";
import { ToolsDialog } from "./shell/ToolsDialog";
import { ShellDialogs } from "./shell/ShellDialogs";
import { PageOrganizer } from "./shell/PageOrganizer";
import { TopBar } from "./shell/TopBar";
import { DOCK_MAX, DOCK_MIN, uiScaleFactor, useUI } from "./shell/uiStore";
import { t, useT } from "../i18n";
import { startEditModes, useCadScreenNow, useProfile } from "./editModes";
import { CadCommandLine } from "./cad/lazy";

// the edit mode follows the work mode and the current page from the start (tools, panels, desk colour)
startEditModes();

const S = () => useStore.getState();

/** A brand-new document nobody has touched yet. */
function isPristine(doc: OmwDocument) {
  const s = S();
  return !s.past.length && !s.future.length && doc.pages.length === 1 && doc.pages[0].nodes.every((n) => n.type === "RASTER" && !Object.keys(n.tiles).length);
}

function Splitter({ side }: { side: "left" | "right" }) {
  const set = useUI((s) => s.set);
  useT();
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startW = side === "left" ? useUI.getState().leftW : useUI.getState().rightW;
    const k = uiScaleFactor(useUI.getState().uiScale); // dock widths are stored at 100% and drawn × UI scale
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / k;
      const w = Math.round(Math.min(DOCK_MAX, Math.max(DOCK_MIN, startW + (side === "left" ? dx : -dx))));
      set(side === "left" ? { leftW: w } : { rightW: w });
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.body.classList.remove("resizing");
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const ui = useUI.getState();
    const d = (e.key === "ArrowRight" ? 16 : -16) * (side === "left" ? 1 : -1);
    const cur = side === "left" ? ui.leftW : ui.rightW;
    const w = Math.min(DOCK_MAX, Math.max(DOCK_MIN, cur + d));
    set(side === "left" ? { leftW: w } : { rightW: w });
  };
  return (
    <div
      className={cx("splitter", `splitter-${side}`)}
      role="separator"
      aria-orientation="vertical"
      aria-label={side === "left" ? t("shell.dock.leftWidth") : t("shell.dock.rightWidth")}
      tabIndex={0}
      onPointerDown={onDown}
      onKeyDown={onKey}
      onDoubleClick={() => set(side === "left" ? { leftW: 240 } : { rightW: 280 })}
    />
  );
}

function Rail({ side }: { side: "left" | "right" }) {
  const set = useUI((s) => s.set);
  useT();
  // the collapsed docks offer what the edit mode shows (documents: navigation; no animations outside slides / design)
  const profile = useProfile();
  const items = (
    side === "left"
      ? profile.id === "DOCUMENT"
        ? ([["pages", "outline"]] as const)
        : ([
            ["pages", "pages"],
            ["layers", "layers"],
          ] as const)
      : profile.animations
        ? ([
            ["props", "sliders"],
            ["anim", "sparkle"],
          ] as const)
        : ([["props", "sliders"]] as const)
  ) as readonly (readonly [string, string])[];
  return (
    <div className={cx("rail", `rail-${side}`)}>
      {items.map(([tab, icon]) => (
        <button
          key={tab}
          type="button"
          className="ibtn ibtn-md"
          data-tip={t(`shell.rail.${tab}`)}
          aria-label={t(`shell.railOpen.${tab}`)}
          onClick={() => (side === "left" ? set({ leftOpen: true, leftTab: tab as "pages" | "layers" }) : set({ rightOpen: true, rightTab: tab as "props" | "anim" }))}
        >
          <Icon name={icon} size={16} />
        </button>
      ))}
    </div>
  );
}

function Toast() {
  const toast = useStore((s) => s.toast);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (toast) setShown(toast);
  }, [toast]);
  return (
    <div className={cx("toast", toast && "show")} role="status" aria-live="polite">
      {shown}
    </div>
  );
}

export function App() {
  const presenting = useStore((s) => s.presenting);
  // a sheet page (표 계산) in the document edit mode is the Excel grid; in the other modes it is a page like any other
  const profileId = useProfile().id;
  const sheetPage = useStore((s) => !!s.doc.pages.find((p) => p.id === s.pageId)?.sheet) && profileId === "DOCUMENT";
  const cadOn = useCadScreenNow();
  const slideStage = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId)?.kind === "SLIDE") && profileId === "SLIDE";
  const slideUI = useSlideUI();
  const ui = useUI();
  // the tab set (ribbonTabs.ts) sets the ribbon row's height: a ribbon (documents, PDF, CAD, slides) or one options bar
  const surface = useSurface();
  useEffect(() => {
    document.documentElement.dataset.surface = surface;
  }, [surface]);
  const [recovery, setRecovery] = useState<{ savedAt: number; title: string; count: number } | null>(null);
  const [ready, setReady] = useState(false); // recovery decision made → autosave allowed
  const [firstRun, setFirstRun] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);

  useGlobalShortcuts(!recovery && !ui.welcome);

  // theme
  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme;
    document.documentElement.style.colorScheme = ui.theme;
  }, [ui.theme]);

  // UI size (Preferences): one root variable that every --fs-* / --ctl* token follows; not browser zoom
  const uiK = uiScaleFactor(ui.uiScale);
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", String(uiK));
  }, [uiK]);

  // startup: crash recovery, then files passed on the command line
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // the recovery offer only after a run that did not end normally; a normal end leaves nothing (endRun)
      const crashed = startRunOnce();
      if (!crashed) await journalClear().catch(() => {});
      const info = crashed ? await journalPeek().catch(() => null) : null;
      if (cancelled) return;
      if (info) setRecovery(info);
      else finishStartup(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const finishStartup = (restored: boolean) => {
    setRecovery(null);
    setReady(true);
    Promise.all([openStartupFile(), openDemoIfRequested()])
      .catch(() => {})
      .finally(() => {
        if (!restored && isPristine(S().doc)) {
          setFirstRun(true);
          useUI.getState().set({ welcome: true });
        }
      });
  };

  // Shuttle autosave: 1.5s after the last change, only while there are unsaved edits
  useEffect(() => {
    if (!ready) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = useStore.subscribe((s, prev) => {
      if (s.doc === prev.doc || !s.dirty || s.gestureBase || useHistory.getState().previewId) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        const st = S();
        // nothing to recover in an untouched new document (edited and undone back to it, too)
        if (!st.dirty || isPristine(st.doc)) return void journalClear(activeSessionId()).catch(() => {});
        // never write decrypted content of a password-protected document to the plain journal
        // each document tab has its own journal entry (io/journal.ts)
        if (isDocProtected()) return void journalClear(activeSessionId()).catch(() => {});
        journalSave(st.doc, activeSessionId())
          .then(() => useUI.getState().set({ journalAt: Date.now() }))
          .catch(() => {});
      }, 1500);
    });
    return () => {
      clearTimeout(timer);
      unsub();
    };
  }, [ready]);

  // warn before closing with unsaved changes in any tab (browser); the desktop window asks with its own dialog
  useEffect(() => {
    const onBefore = (e: BeforeUnloadEvent) => {
      if (!anyDirty()) return void endRun();
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBefore);
    let unlisten: (() => void) | undefined;
    let alive = true;
    if (isTauri)
      void import("@tauri-apps/api/window")
        .then(async ({ getCurrentWindow }) => {
          const win = getCurrentWindow();
          const off = await win.onCloseRequested(async (ev) => {
            ev.preventDefault();
            // saved, or 저장 안 함: a normal end — no recovery offer next time
            if (anyDirty() && !(await confirmAllSaved())) return;
            await endRun();
            await win.destroy();
          });
          if (alive) unlisten = off;
          else off();
        })
        .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
      window.removeEventListener("beforeunload", onBefore);
    };
  }, []);

  // keep the page fitted when docks open/close
  const prevDocks = useRef(`${ui.leftOpen}${ui.rightOpen}`);
  useEffect(() => {
    const key = `${ui.leftOpen}${ui.rightOpen}`;
    if (key !== prevDocks.current) {
      prevDocks.current = key;
      requestAnimationFrame(() => fitCurrent());
    }
  }, [ui.leftOpen, ui.rightOpen]);

  // don't let a file dropped outside the canvas navigate the window away
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  return (
    <div className="app" style={{ ["--left-w" as any]: `${Math.round(ui.leftW * uiK)}px`, ["--right-w" as any]: `${Math.round(ui.rightW * uiK)}px` }}>
      <TopBar />
      <Ribbon />
      <main className="workspace">
        <ToolBox />
        {ui.leftOpen ? (
          <>
            <LeftDock />
            <Splitter side="left" />
          </>
        ) : (
          <Rail side="left" />
        )}
        <div className="stage" ref={stageRef}>
          {slideStage ? (
            slideUI.sorter ? (
              <SlideSorter />
            ) : (
              // slides: the slide with its speaker notes under it (docs/design/SLIDE_MODE.md)
              <div className="slide-stage">
                <div className="slide-canvas">
                  <CanvasView />
                </div>
                {slideUI.notes && <NotesPane />}
              </div>
            )
          ) : sheetPage ? (
            <SheetView />
          ) : (
            <CanvasView />
          )}
          {cadOn && <CadCommandLine />}
        </div>
        {ui.rightOpen ? (
          <>
            <Splitter side="right" />
            <RightDock />
          </>
        ) : (
          <Rail side="right" />
        )}
      </main>
      <StatusBar />
      <Backstage />
      <Toast />
      <TooltipLayer />

      {recovery && (
        <RecoveryDialog
          info={recovery}
          onRestore={async () => {
            try {
              // every journalled document comes back in a tab of its own (oldest first, so the newest ends up active)
              const entries = (await journalList()).reverse();
              let restored = 0;
              for (const e of entries) {
                const doc = await journalRestore(e.key);
                if (!doc) continue;
                if (!isPristineActive()) newSession();
                S().load(doc);
                S().set({ dirty: true });
                claimTab();
                restored++;
                // re-file it under this tab's key before the old entry goes
                await journalSave(doc, activeSessionId()).catch(() => {});
                if (e.key !== activeSessionId()) await journalClear(e.key).catch(() => {});
              }
              if (restored) {
                S().notify(t("shell.recover.done"));
                setTimeout(fitCurrent);
              } else S().notify(t("shell.recover.nothing"));
              finishStartup(restored > 0);
            } catch (e) {
              console.error(e);
              S().notify(t("shell.recover.failed"));
              finishStartup(false);
            }
          }}
          onDiscard={() => {
            journalClear().catch(() => {});
            finishStartup(false);
          }}
        />
      )}
      {ui.welcome && !recovery && (
        <StartScreen
          first={firstRun}
          onClose={() => {
            setFirstRun(false);
            ui.set({ welcome: false });
          }}
        />
      )}
      <PageOrganizer />
      <ToolsDialog />
      <SecurityDialogs />
      <TabDialogs />
      <ShellDialogs />
      {presenting && <Presenter />}
    </div>
  );
}
