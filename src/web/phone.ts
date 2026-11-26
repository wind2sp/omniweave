// Phone browser: which screen the web app shows. A phone (small touch screen) gets the phone shell of the Android
// app (ui/mobile; io/platform.ts isMobile decides, index.html makes the same decision before the first paint for the
// viewport meta, so the two must agree). "PC 화면으로 보기" (the phone shell's settings) switches to the desktop
// editor for this visit (sessionStorage); the desktop editor's phone notice (ui/shell/WebNotice.tsx) switches back.
// (No imports: io/platform.ts loads this before the first screen.)

/** sessionStorage key for this visit: "desktop" = the desktop editor on a phone, "phone" = the phone screen even
 *  where the automatic test says otherwise (so "휴대폰 화면으로" always lands on the phone screen) */
export const PHONE_LAYOUT_KEY = "omniweave.web.layout";

/**
 * Chrome's "데스크톱 사이트" (desktop site) ignores the viewport meta and lays the page out ~980 px wide on a phone,
 * so the phone screen would be drawn at desktop width and shrunk to tiny type. The zoom that brings it back to the
 * phone's real width: layout width ÷ screen width when the layout is clearly wider than the screen, else 1.
 */
export function desktopSiteZoom(layoutWidth: number, screenWidth: number): number {
  if (!(layoutWidth > 0) || !(screenWidth > 0) || layoutWidth <= screenWidth * 1.15) return 1;
  return Math.round((layoutWidth / screenWidth) * 1000) / 1000;
}

/** Switch this visit to the desktop editor ("desktop") or the phone screen ("phone"), then reload. */
export function switchLayout(to: "desktop" | "phone"): void {
  try {
    sessionStorage.setItem(PHONE_LAYOUT_KEY, to);
  } catch {}
  const u = new URL(location.href);
  for (const k of ["phone", "mobile", "desktop"]) u.searchParams.delete(k);
  location.replace(u.href);
}
