// Which browser / device the web app runs in (no imports: used by io/platform.ts and web/pwa.ts alike).

type Nav = { userAgent: string; platform?: string; maxTouchPoints?: number; standalone?: boolean };

const nav = (): Nav | null => (typeof navigator === "undefined" ? null : (navigator as unknown as Nav));

/** iPhone, iPod or iPad (iPadOS asks for desktop pages and names itself "MacIntel", but has a touch screen). */
export function isIOS(n: Nav | null = nav()): boolean {
  if (!n) return false;
  return /iPhone|iPad|iPod/.test(n.userAgent) || (n.platform === "MacIntel" && (n.maxTouchPoints ?? 0) > 1);
}

/** Android phone or tablet. */
export function isAndroid(n: Nav | null = nav()): boolean {
  return !!n && /Android/i.test(n.userAgent);
}

/** A browser built into another app (KakaoTalk, LINE, Facebook, Instagram, NAVER ...): it cannot add to the home
 *  screen, so the add-to-home-screen hint is not shown there. */
export function isInAppBrowser(n: Nav | null = nav()): boolean {
  return !!n && /KAKAOTALK|Line\/|FBAN|FBAV|Instagram|NAVER\(inapp|DaumApps|wv\)/i.test(n.userAgent);
}

/** Started from the home screen / as an installed app (its own window, no address bar). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  if (nav()?.standalone === true) return true; // iOS home-screen app
  try {
    return matchMedia("(display-mode: standalone)").matches || matchMedia("(display-mode: fullscreen)").matches;
  } catch {
    return false;
  }
}

/** Phones show the 1024 px layout scaled down (index.html): how much to enlarge a small overlay so it reads at the
 *  phone's normal text size. 1 on wider screens. */
export function phoneZoom(): number {
  if (typeof window === "undefined" || typeof screen === "undefined") return 1;
  try {
    const landscape = matchMedia("(orientation: landscape)").matches;
    const w = landscape ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    if (!w || w >= 960) return 1;
    return Math.max(1, Math.min(3, window.innerWidth / w));
  } catch {
    return 1;
  }
}
