// Eyedropper hook (design ch. 7.2): one way to pick a colour from anywhere. Sources, in order:
//   1. a canvas sampler the canvas view registers (exact page colours, works in every webview) — phase B wires it;
//   2. the browser EyeDropper API (Chromium / WebView2) for the whole screen.
// Callers only see `supported` and `pick()`; which source answered does not matter to them.

import { useCallback, useSyncExternalStore } from "react";

/** Resolves to "#rrggbb", or null when the user cancelled. */
export type ColorSampler = () => Promise<string | null>;

let canvasSampler: ColorSampler | null = null;
const listeners = new Set<() => void>();

/** Register (or clear with null) the canvas's own sampler; returns the unregister function. */
export function setCanvasSampler(s: ColorSampler | null): () => void {
  canvasSampler = s;
  listeners.forEach((l) => l());
  return () => {
    if (canvasSampler === s) setCanvasSampler(null);
  };
}

interface EyeDropperCtor {
  new (): { open: () => Promise<{ sRGBHex: string }> };
}
const browserEyeDropper = (): EyeDropperCtor | null => (typeof window !== "undefined" && (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper) || null;

export const eyeDropperSupported = () => !!canvasSampler || !!browserEyeDropper();

/** Pick a colour with the best available source; null when cancelled or unsupported. */
export async function pickColor(): Promise<string | null> {
  if (canvasSampler) return canvasSampler();
  const E = browserEyeDropper();
  if (!E) return null;
  try {
    const r = await new E().open();
    return /^#[0-9a-f]{6}$/i.test(r.sRGBHex) ? r.sRGBHex.toLowerCase() : null;
  } catch {
    return null; // Esc
  }
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useEyeDropper(): { supported: boolean; pick: () => Promise<string | null> } {
  const supported = useSyncExternalStore(subscribe, eyeDropperSupported, eyeDropperSupported);
  const pick = useCallback(() => pickColor(), []);
  return { supported, pick };
}
