import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { fontsChanged } from "./core/text";
import { initLang } from "./i18n";
import { installUiFonts } from "./io/pretendard";
import { isMobile } from "./io/platform";
import "./ui/styles.css";
import { initPwa } from "./web/pwa";

// browser only: offline service worker, install offer, files opened with the installed app (src/web/pwa.ts)
initPwa();

// Real glyph metrics for the text engine come from core/text.ts's own canvas measurer, which measures small text large
// and scales it: the fonts' linear advances, as Word lays text out. (A measurer here used the canvas at the text's own
// size, and fonts with hinted widths — 굴림, 돋움, 바탕 — reported whole pixels: 굴림 10 pt 13 px a syllable instead of
// 13.33, a syllable more on a line than Word — QA 11-23, omni-fid-gulim.)

/** Wait (briefly) for the bundled Pretendard faces so the first paint measures real glyphs. Regular/Bold come
 *  from the packed TTFs (io/pretendard.ts), Medium/SemiBold from styles.css. */
async function loadFonts() {
  if (!("fonts" in document)) return;
  const ready = (async () => {
    await installUiFonts().catch(() => {}); // missing pack: the CSS fallback fonts are used
    const faces = ["400", "500", "600", "700"].map((w) => document.fonts.load(`${w} 16px "Pretendard"`, "가A"));
    return Promise.allSettled(faces);
  })();
  await Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]);
}

// a face that finishes loading later (another weight, a Korean subset, a font chosen in a document)
// changes text metrics: drop measurements, laid-out text and painted tiles, then repaint
if (!__OMW_MOBILE__ && "fonts" in document && !isMobile) {
  let t: ReturnType<typeof setTimeout> | undefined;
  document.fonts.addEventListener("loadingdone", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      fontsChanged();
      void Promise.all([import("./ui/CanvasView"), import("./core/store")]).then(([{ weave }, { useStore }]) => {
        weave.clear();
        const st = useStore.getState();
        st.set({ view: { ...st.view } });
      });
    }, 50);
  });
}

// the phone app (Android/iOS, docs/MOBILE_PLAN.md §2) and the web app on a phone (io/platform.ts isMobile) get their own shell; the desktop editor is not loaded there
// (the phone app's own build, vite --mode mobile, leaves the desktop editor out altogether: __OMW_MOBILE__). The phone
// shows its first screen without waiting for the document fonts (its UI uses the system font until they are in;
// documents wait for them before they are drawn, ui/mobile/MobileViewer.tsx).
const phone = __OMW_MOBILE__ || isMobile;
if (phone) void loadFonts();
// UI language (saved choice → installer choice → OS language) is settled before the first paint
Promise.all([phone ? null : loadFonts(), initLang()]).finally(async () => {
  // the start-up document was made at module load in Korean: name its page / layer in the chosen language
  if (!phone) (await import("./core/history")).relabelStartDocument();
  const shell = phone ? import("./ui/mobile/MobileApp").then((m) => m.MobileApp) : import("./ui/App").then((m) => m.App);
  void shell.then((Shell) =>
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <Shell />
      </StrictMode>,
    ),
  );
});

// Development-only diagnostics hook (corpus checks drive importFile from the browser console).
if (import.meta.env.DEV) {
  void Promise.all([import("./ui/actions"), import("./core/store"), import("./core/sessions"), import("./ui/tabs")]).then(([actions, store, sessions, tabs]) => {
    (window as any).__omw = { actions, store: store.useStore, sessions, tabs };
  });
}
