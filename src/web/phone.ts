// Phone browser: which screen the web app shows. A phone (small touch screen) gets the simple page viewer
// (web/PhoneViewer.tsx) laid out at the phone's own width, instead of the desktop editor scaled down to 0.4 (whose
// menus could not be read and whose canvas did not move or zoom under a finger). "PC 화면으로 보기" switches back to
// the desktop editor for this visit (sessionStorage). index.html makes the same decision before the first paint (the
// viewport meta), so the two must agree.
//
// Later the phone web app is to use the phone shell of the Android app (ui/mobile, mobile branch); this viewer is the
// stop-gap until then.

/** sessionStorage key: "desktop" = this visit shows the desktop editor on a phone */
export const PHONE_LAYOUT_KEY = "omniweave.web.layout";

export interface PhoneEnv {
  tauri: boolean;
  /** screen.width / screen.height (CSS px) */
  screenW: number;
  screenH: number;
  /** matchMedia("(pointer: coarse)") */
  coarse: boolean;
  /** the sessionStorage choice (PHONE_LAYOUT_KEY) */
  choice: string | null;
  /** location.search */
  search: string;
}

/** A phone-sized touch screen: the shorter side under 600 CSS px and a finger as the main pointer. */
export function isPhoneScreen(e: Pick<PhoneEnv, "screenW" | "screenH" | "coarse">): boolean {
  return Math.min(e.screenW, e.screenH) < 600 && e.coarse;
}

/** The simple phone viewer instead of the desktop editor. `?desktop` / `?phone` force either (support, tests). */
export function wantsPhoneViewer(e: PhoneEnv): boolean {
  if (e.tauri) return false;
  const q = new URLSearchParams(e.search);
  if (q.has("desktop")) return false;
  if (q.has("phone")) return true;
  if (e.choice === "desktop") return false;
  return isPhoneScreen(e);
}

function env(): PhoneEnv {
  let choice: string | null = null;
  try {
    choice = sessionStorage.getItem(PHONE_LAYOUT_KEY);
  } catch {}
  let coarse = false;
  try {
    coarse = matchMedia("(pointer: coarse)").matches;
  } catch {}
  return { tauri: "__TAURI_INTERNALS__" in window, screenW: screen.width, screenH: screen.height, coarse, choice, search: location.search };
}

/** This page shows the phone viewer (decided once at start-up). */
export const phoneViewerNow = (): boolean => typeof window !== "undefined" && wantsPhoneViewer(env());

/** Switch this visit to the desktop editor ("desktop") or back to the phone viewer (null), then reload. */
export function switchLayout(to: "desktop" | null): void {
  try {
    if (to) sessionStorage.setItem(PHONE_LAYOUT_KEY, to);
    else sessionStorage.removeItem(PHONE_LAYOUT_KEY);
  } catch {}
  const u = new URL(location.href);
  u.searchParams.delete("phone");
  u.searchParams.delete("desktop");
  location.replace(u.href);
}

// ───────── page column geometry (pure; tests/webPhone.test.ts) ─────────

/** most pixels one page canvas may hold (≈ 32 MB RGBA), so a long document stays well under a phone's memory */
export const MAX_PAGE_PIXELS = 8_000_000;

/** Canvas pixels per page unit for a page shown `cssWidth` px wide on a `dpr` screen, at most MAX_PAGE_PIXELS. */
export function pageScale(cssWidth: number, pageW: number, pageH: number, dpr: number): number {
  const want = (cssWidth * Math.min(Math.max(dpr, 1), 4)) / pageW;
  return Math.max(0.02, Math.min(want, Math.sqrt(MAX_PAGE_PIXELS / (pageW * pageH))));
}

/** Index of the page whose box holds the line `y` (page tops `tops`, ascending; heights `hs`), for the counter. */
export function pageAt(tops: number[], hs: number[], y: number): number {
  let i = 0;
  while (i < tops.length - 1 && tops[i] + hs[i] < y) i++;
  return i;
}

/** Two taps within 300 ms and 30 px: a double tap. */
export { isDoubleTap } from "../ui/touchNav";

/**
 * Double tap: page width ↔ 2.5× zoom of the page column. (cx, cy) is the tapped point in column px; returns the new
 * zoom and where that point lands in the zoomed column (the caller scrolls it under the finger, scrollFor).
 */
export function doubleTapZoom(zoom: number, cx: number, cy: number): { zoom: number; x: number; y: number } {
  const next = zoom > 1.01 ? 1 : 2.5;
  const k = next / zoom;
  return { zoom: next, x: cx * k, y: cy * k };
}

/** Window scroll that puts column point (x, y) under the finger at client (fx, fy); colLeft / colTop are the column's
 *  document offsets. */
export function scrollFor(colLeft: number, colTop: number, x: number, y: number, fx: number, fy: number): { left: number; top: number } {
  return { left: Math.max(0, colLeft + x - fx), top: Math.max(0, colTop + y - fy) };
}
