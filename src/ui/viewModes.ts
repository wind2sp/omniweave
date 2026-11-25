// Full screen (F11: the browser's Fullscreen API, the desktop window's own full screen) and reading mode (Word's
// 읽기 모드: only the pages, no ribbon, tool box, panes or editing). Esc leaves either.

import { create } from "zustand";
import { useStore } from "../core/store";
import type { Tool } from "../core/store";
import { isTauri } from "../io/platform";

interface ViewModes {
  fullscreen: boolean;
  reading: boolean;
}
export const useViewModes = create<ViewModes>(() => ({ fullscreen: false, reading: false }));

type Win = { setFullscreen(on: boolean): Promise<void>; isFullscreen(): Promise<boolean> };
let winP: Promise<Win> | null = null;
const win = () => (winP ??= import("@tauri-apps/api/window").then((m) => m.getCurrentWindow() as unknown as Win));

/** Full screen on / off (toggle when `on` is not given). */
export async function toggleFullScreen(on?: boolean): Promise<void> {
  const want = on ?? !useViewModes.getState().fullscreen;
  if (isTauri) {
    try {
      const w = await win();
      await w.setFullscreen(want);
      useViewModes.setState({ fullscreen: await w.isFullscreen() });
    } catch {
      /* no window API (a test page): nothing changes */
    }
    return;
  }
  const d = document as Document & { webkitFullscreenElement?: Element };
  try {
    if (want && !d.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
    else if (!want && d.fullscreenElement) await document.exitFullscreen?.();
  } catch {
    /* refused (no user gesture, an iframe without allowfullscreen): the state stays as it is */
  }
  useViewModes.setState({ fullscreen: !!d.fullscreenElement });
}

let toolBefore: Tool | null = null;
/** Reading mode on / off: the pages alone, the pointer only scrolls (no editing), as Word's 읽기 모드. */
export function toggleReadMode(on?: boolean) {
  const want = on ?? !useViewModes.getState().reading;
  if (want === useViewModes.getState().reading) return;
  const s = useStore.getState();
  if (want) {
    toolBefore = s.tool;
    s.set({ tool: "hand", editingTextId: null, selection: [] });
  } else if (toolBefore) {
    s.set({ tool: toolBefore });
    toolBefore = null;
  }
  useViewModes.setState({ reading: want });
}

/** Esc leaves reading mode, then full screen (before any other use of Esc); the browser's own exit is followed. */
export function installViewModeKeys(): () => void {
  const onKey = (e: KeyboardEvent) => {
    // reading mode reads only: no typing, deleting, pasting or cutting reaches the page (moving and copying do)
    if (useViewModes.getState().reading && e.key !== "Escape" && !document.querySelector("[role=dialog], .backstage")) {
      const mod = e.ctrlKey || e.metaKey;
      const edits = (!mod && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete" || e.key === "Enter" || e.key === "Tab")) || (mod && /^[vxzyb iu]$/i.test(e.key) && e.key !== " ");
      if (edits) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.querySelector("[role=dialog], .menu-pop, .backstage")) return;
    const v = useViewModes.getState();
    if (v.reading) {
      e.preventDefault();
      e.stopPropagation();
      toggleReadMode(false);
    } else if (v.fullscreen) {
      e.preventDefault();
      e.stopPropagation();
      void toggleFullScreen(false);
    }
  };
  const onChange = () => useViewModes.setState({ fullscreen: !!document.fullscreenElement });
  // (an input method's text arrives without a key: stopped here too)
  const onInput = (e: Event) => {
    if (useViewModes.getState().reading && !(e.target as Element | null)?.closest?.("[role=dialog], .backstage")) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  window.addEventListener("beforeinput", onInput, true);
  window.addEventListener("keydown", onKey, true);
  document.addEventListener("fullscreenchange", onChange);
  return () => {
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("beforeinput", onInput, true);
    document.removeEventListener("fullscreenchange", onChange);
  };
}
