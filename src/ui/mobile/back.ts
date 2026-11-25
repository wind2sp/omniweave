// Android back gesture / button for the phone shell. The app's activity (WryActivity) goes back in the WebView's
// history while it can and leaves the app otherwise, so every layer that should close on "back" (viewer, markup,
// scan, sheets) adds a history entry while it is open; "back" pops it and the newest layer closes. A layer closed by
// its own button takes its entry back out without closing anything else.

import { useEffect, useRef } from "react";

interface Entry {
  close: () => void;
  done: boolean;
}

const stack: Entry[] = [];
let skip = 0;

if (typeof window !== "undefined")
  window.addEventListener("popstate", () => {
    if (skip > 0) {
      skip--;
      return;
    }
    const top = stack.pop();
    if (top) {
      top.done = true;
      top.close();
    }
  });

// In the Android app the back button comes to the page itself (Tauri's onBackButtonPress): the WebView's own history
// cannot be relied on — Chromium skips entries a page added without a tap since (its history manipulation
// intervention), so a file opened from another app ("Open with", no tap yet) would leave the app on the first back.
// The newest layer closes (its history entry is taken out quietly); with none open, the app closes.
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && /Android/i.test(navigator.userAgent))
  void import("@tauri-apps/api/app")
    .then(({ onBackButtonPress, exit }) =>
      onBackButtonPress(() => {
        const top = stack.pop();
        if (!top) return void exit(0).catch(() => {});
        top.done = true;
        skip++;
        history.back();
        top.close();
      }),
    )
    .catch(() => {
      /* older runtime: the WebView's history handles back */
    });

/** While `open`, the back gesture calls `close` (once) instead of leaving the screen behind it. */
export function useBackClose(open: boolean, close: () => void) {
  const ref = useRef(close);
  ref.current = close;
  useEffect(() => {
    if (!open || typeof history === "undefined") return;
    const entry: Entry = { close: () => ref.current(), done: false };
    stack.push(entry);
    // a layer closed in the same moment (the viewer giving way to the editor; React's development double run of
    // effects) leaves its history entry to this one instead of going back: history.back() runs later than a
    // pushState, so back-then-push took the new layer's entry and, layer after layer, left the page (about:blank)
    if (pendingBacks > 0) pendingBacks--;
    else history.pushState({ omwLayer: stack.length }, "");
    return () => {
      if (entry.done) return;
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      pendingBacks++;
      setTimeout(flushBacks, 0);
    };
  }, [open]);
}

/** history entries of closed layers not yet taken out (see useBackClose) */
let pendingBacks = 0;
function flushBacks() {
  if (pendingBacks <= 0) return;
  // one step back over all of them: one popstate, skipped
  const n = pendingBacks;
  pendingBacks = 0;
  skip++;
  history.go(-n);
}

/** layers open now (tests, diagnostics) */
export const openLayers = () => stack.length;
