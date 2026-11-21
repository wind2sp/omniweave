// Window buttons at the right end of the title bar (docs/design/UI_TOP_REDESIGN.md §2.2, issue 4): the window has no
// Windows title bar of its own (tauri.conf.json decorations:false), so minimise · maximise / restore · close live here,
// 46×36 like Windows 11 (close turns red on hover). Plain buttons only — no snap-layout flyout (제품 결정 2026-11-20).
// A browser build has no window to control: nothing is drawn there.
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { isTauri } from "../../io/platform";

type Win = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  onResized: (cb: () => void) => Promise<() => void>;
};

let winP: Promise<Win> | null = null;
const win = () => (winP ??= import("@tauri-apps/api/window").then((m) => m.getCurrentWindow() as unknown as Win));

/** Run a window call; a refused permission must not throw into React. */
const call = (f: (w: Win) => Promise<unknown>) => void win().then(f).catch(() => {});

/** Windows 11 caption glyphs (Segoe Fluent's ChromeMinimize / Maximize / Restore / Close), 10 px, hairline. */
function Glyph({ kind }: { kind: "min" | "max" | "restore" | "close" }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true" shapeRendering="crispEdges">
      {kind === "min" && <path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" />}
      {kind === "max" && <rect x="0.5" y="0.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />}
      {kind === "restore" && (
        <>
          <rect x="0.5" y="2.5" width="7" height="7" rx="1" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" strokeWidth="1" />
        </>
      )}
      {kind === "close" && <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" shapeRendering="geometricPrecision" />}
    </svg>
  );
}

export function WindowControls({ force }: { force?: boolean } = {}) {
  const t = useT();
  const [max, setMax] = useState(false);
  useEffect(() => {
    if (!isTauri) return;
    let off: (() => void) | undefined;
    let alive = true;
    const sync = () => call(async (w) => alive && setMax(await w.isMaximized()));
    sync();
    void win()
      .then((w) => w.onResized(sync))
      .then((u) => (alive ? (off = u) : u()))
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, []);
  if (!isTauri && !force) return null;
  const maxLabel = max ? t("topui.win.restore") : t("topui.win.maximize");
  return (
    <div className="win-ctrls" role="group" aria-label={t("topui.win.group")}>
      <button type="button" className="win-btn" aria-label={t("topui.win.minimize")} data-tip={t("topui.win.minimize")} onClick={() => call((w) => w.minimize())}>
        <Glyph kind="min" />
      </button>
      <button type="button" className="win-btn" aria-label={maxLabel} data-tip={maxLabel} onClick={() => call((w) => w.toggleMaximize())}>
        <Glyph kind={max ? "restore" : "max"} />
      </button>
      {/* close asks about unsaved tabs first: App.tsx listens to the close request */}
      <button type="button" className="win-btn win-close" aria-label={t("topui.win.close")} data-tip={t("topui.win.close")} onClick={() => call((w) => w.close())}>
        <Glyph kind="close" />
      </button>
    </div>
  );
}
