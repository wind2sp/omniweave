import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { fontsChanged, setMeasure } from "./core/text";
import { useStore } from "./core/store";
import { relabelStartDocument } from "./core/history";
import { initLang } from "./i18n";
import { installUiFonts } from "./io/pretendard";
import { App } from "./ui/App";
import "./ui/styles.css";
import { initPwa } from "./web/pwa";

// browser only: offline service worker, install offer, files opened with the installed app (src/web/pwa.ts)
initPwa();

// Real glyph metrics for the text engine (core/text.ts falls back to an estimate
// outside the DOM). Installed before the first layout so cached layouts are correct.
const measureCtx = document.createElement("canvas").getContext("2d");
if (measureCtx)
  setMeasure((text, font) => {
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  });

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
if ("fonts" in document) {
  let t: ReturnType<typeof setTimeout> | undefined;
  document.fonts.addEventListener("loadingdone", () => {
    clearTimeout(t);
    t = setTimeout(() => {
      fontsChanged();
      void import("./ui/CanvasView").then(({ weave }) => {
        weave.clear();
        const st = useStore.getState();
        st.set({ view: { ...st.view } });
      });
    }, 50);
  });
}

// UI language (saved choice → installer choice → OS language) is settled before the first paint
Promise.all([loadFonts(), initLang()]).finally(() => {
  // the start-up document was made at module load in Korean: name its page / layer in the chosen language
  relabelStartDocument();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});

// Development-only diagnostics hook (corpus checks drive importFile from the browser console).
if (import.meta.env.DEV) {
  void Promise.all([import("./ui/actions"), import("./core/store"), import("./core/sessions"), import("./ui/tabs")]).then(([actions, store, sessions, tabs]) => {
    (window as any).__omw = { actions, store: store.useStore, sessions, tabs };
  });
}
