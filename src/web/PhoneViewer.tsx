// Phone browser: a simple page viewer (web/phone.ts says when). The page is laid out at the phone's own width
// (index.html keeps width=device-width), the pages of the opened file run one under the other at the screen's width,
// and the browser itself scrolls and pinch-zooms them — the gestures a phone user already knows, with no gesture
// code of ours in between. A double tap switches between the page width and 2.5×. View only: "PC 화면으로 보기"
// opens the desktop editor for this visit. Opening goes through the desktop engine (ui/actions.ts openInTab), so
// every format the editor opens (PDF, DOCX, HWPX, PPTX, XLSX, PSD, AI, DWG/DXF, pictures, .omw) shows here too.
//
// Only pages near the screen hold a canvas, each capped at MAX_PAGE_PIXELS (web/phone.ts), so a 100-page file
// does not fill a phone's memory.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStore } from "../core/store";
import type { Page } from "../core/types";
import { renderMasterOf } from "../core/headerFooter";
import { paintPage } from "../render/weave";
import { useT, t } from "../i18n";
import { FILTERS, openFiles, saveFile, shareFile, type OpenedFile } from "../io/platform";
import { openDemoIfRequested, openInTab } from "../ui/actions";
import { activeSessionId, removeSession } from "../core/sessions";
import { openLaunchedFiles } from "./pwa";
import { doubleTapZoom, isDoubleTap, pageAt, pageScale, scrollFor, switchLayout } from "./phone";
import "./phone.css";

const S = () => useStore.getState();
const GAP = 12;

interface Opened {
  name: string;
  bytes: Uint8Array | null;
  pages: Page[];
}

export function PhoneViewer() {
  const tr = useT();
  const [doc, setDoc] = useState<Opened | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState(() => {
    try {
      return sessionStorage.getItem("omniweave.web.phoneNotice") !== "1";
    } catch {
      return true;
    }
  });
  const toast = useStore((s) => s.toast);

  const open = useCallback(async (f: OpenedFile) => {
    setBusy(f.name);
    try {
      const before = S().doc;
      const prevTab = activeSessionId();
      const pages = await openInTab(f);
      // one file at a time on a phone: the one shown before is let go (its memory with it)
      if (activeSessionId() !== prevTab) removeSession(prevTab);
      const d = S().doc;
      const shown = pages.length ? d.pages.filter((p) => pages.some((q) => q.id === p.id)) : d !== before ? d.pages : [];
      if (shown.length) {
        // the editor's "opened — edit it with …" tips do not apply to this view-only screen
        S().set({ toast: null });
        setDoc({ name: f.name, bytes: f.bytes, pages: shown });
        // the phone's back button closes the file (back to the start screen), not the site
        history.pushState({ omwPhoneDoc: true }, "");
        window.scrollTo(0, 0);
      } else if (!S().toast) S().notify(t("webphone.openFailed", { name: f.name }));
    } catch (e: any) {
      S().notify(t("webphone.openFailed", { name: f.name }) + (e?.message ? ` — ${e.message}` : ""));
    } finally {
      setBusy(null);
    }
  }, []);

  const pick = useCallback(async () => {
    const files = await openFiles([FILTERS.any]);
    if (files[0]) await open(files[0]);
  }, [open]);

  // start-up: files the installed app was opened with, the ?demo sample
  useEffect(() => {
    void openLaunchedFiles((f) => open(f));
    if (new URLSearchParams(location.search).has("demo")) {
      setBusy("demo");
      void openDemoIfRequested()
        .then(() => {
          const d = S().doc;
          if (d.pages.length && d.title) setDoc({ name: "omniweave-demo.omw", bytes: null, pages: d.pages });
        })
        .finally(() => setBusy(null));
    }
  }, [open]);

  useEffect(() => {
    const onPop = () => setDoc(null);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const closeNotice = () => {
    try {
      sessionStorage.setItem("omniweave.web.phoneNotice", "1");
    } catch {}
    setNotice(false);
  };

  const share = async () => {
    if (!doc?.bytes) return;
    const r = await shareFile(doc.name, doc.bytes);
    if (r === "unsupported") await saveFile(doc.name, doc.bytes, [FILTERS.any]);
  };

  return (
    <div className="wp-root">
      <header className="wp-bar">
        {doc ? (
          <button type="button" className="wp-btn wp-icon" aria-label={tr("webphone.back")} onClick={() => history.back()}>
            ‹
          </button>
        ) : (
          <img className="wp-logo" src="app_small.png" alt="" />
        )}
        <div className="wp-title">{doc ? doc.name : "Omniweave"}</div>
        {doc?.bytes && (
          <button type="button" className="wp-btn" onClick={() => void share()}>
            {tr("webphone.share")}
          </button>
        )}
        <button type="button" className="wp-btn" onClick={() => void pick()}>
          {tr("webphone.open")}
        </button>
      </header>
      {notice && (
        <div className="wp-notice" role="status">
          <span>{tr("webphone.notice")}</span>
          <button type="button" className="wp-btn wp-icon" aria-label={tr("webphone.close")} onClick={closeNotice}>
            ×
          </button>
        </div>
      )}
      {doc ? (
        <PageColumn key={doc.pages[0]?.id} pages={doc.pages} />
      ) : (
        <main className="wp-start">
          <img src="app.png" alt="" className="wp-start-mark" />
          <h1>{tr("webphone.startTitle")}</h1>
          <p>{tr("webphone.startText")}</p>
          <button type="button" className="wp-primary" onClick={() => void pick()} disabled={!!busy}>
            {tr("webphone.openFile")}
          </button>
          <p className="wp-small">{tr("web.start.privacy")}</p>
          <button type="button" className="wp-link" onClick={() => switchLayout("desktop")}>
            {tr("webphone.desktop")}
          </button>
        </main>
      )}
      {doc && (
        <footer className="wp-foot">
          <button type="button" className="wp-link" onClick={() => switchLayout("desktop")}>
            {tr("webphone.desktop")}
          </button>
        </footer>
      )}
      {busy && (
        <div className="wp-busy" role="progressbar" aria-label={tr("webphone.opening")}>
          <i />
          <span>{busy === "demo" ? tr("webphone.opening") : tr("webphone.openingName", { name: busy })}</span>
        </div>
      )}
      {toast && <div className="wp-toast">{toast}</div>}
    </div>
  );
}

/** The pages one under the other at the column's width (× zoom); pages near the screen are painted. */
function PageColumn({ pages }: { pages: Page[] }) {
  const col = useRef<HTMLDivElement>(null);
  const hs = useRef<HTMLDivElement>(null);
  const pendingScroll = useRef<{ x: number; y: number; fx: number; fy: number } | null>(null);
  const [width, setWidth] = useState(() => Math.max(200, window.innerWidth - 2 * GAP));
  const [zoom, setZoom] = useState(1);
  const [current, setCurrent] = useState(0);
  const tapRef = useRef<{ t: number; x: number; y: number } | null>(null);

  // the column follows the screen width (rotation, split screen)
  useEffect(() => {
    const on = () => setWidth(Math.max(200, document.documentElement.clientWidth - 2 * GAP));
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);

  const w = width * zoom;
  const heights = pages.map((p) => (p.height / p.width) * w);
  const tops: number[] = [];
  heights.reduce((y, h) => (tops.push(y), y + h + GAP), 0);

  // page counter: the page under the middle of the screen
  useEffect(() => {
    const on = () => {
      const el = col.current;
      if (!el) return;
      const y = window.scrollY + window.innerHeight / 2 - (el.getBoundingClientRect().top + window.scrollY);
      setCurrent(pageAt(tops, heights, y));
    };
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  });

  // double tap: page width ↔ 2.5×, the tapped point staying under the finger
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") return;
    const prev = tapRef.current;
    tapRef.current = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    if (!isDoubleTap(prev, e.timeStamp, e.clientX, e.clientY)) return;
    tapRef.current = null;
    const el = col.current!;
    const r = el.getBoundingClientRect();
    const fx = e.clientX, fy = e.clientY;
    const next = doubleTapZoom(zoom, fx - r.left, fy - r.top);
    pendingScroll.current = { x: next.x, y: next.y, fx, fy };
    setZoom(next.zoom);
  };

  // after the zoomed column is laid out: the tapped point back under the finger — across in the column's own
  // scroller (a column wider than the page would make the browser zoom the whole page out), down in the window
  useLayoutEffect(() => {
    const p = pendingScroll.current;
    pendingScroll.current = null;
    const el = col.current, box = hs.current;
    if (!p || !el || !box) return;
    let tries = 0;
    const apply = () => {
      const q = el.getBoundingClientRect();
      const to = scrollFor(q.left + box.scrollLeft, q.top + window.scrollY, p.x, p.y, p.fx, p.fy);
      // the scroller may not have taken the new width yet (seen in Chrome): try again on the next frames
      if (to.left > box.scrollWidth - box.clientWidth + 1 && tries++ < 6) return void requestAnimationFrame(apply);
      box.scrollLeft = to.left;
      window.scrollTo(0, to.top);
    };
    apply();
  }, [zoom]);

  return (
    <>
      <div ref={hs} className="wp-hscroll">
        <div ref={col} className="wp-col" style={{ width: w + 2 * GAP, height: (tops.at(-1) ?? 0) + (heights.at(-1) ?? 0) + 2 * GAP }} onPointerUp={onPointerUp}>
          {pages.map((p, i) => (
            <PageCanvas key={p.id} page={p} x={GAP} y={tops[i] + GAP} w={w} h={heights[i]} />
          ))}
        </div>
      </div>
      {pages.length > 1 && (
        <div className="wp-count" aria-live="polite">
          {current + 1} / {pages.length}
        </div>
      )}
    </>
  );
}

/** One page: painted while it is near the screen (a screen above and below), dropped when it scrolls far away. */
function PageCanvas({ page, x, y, w, h }: { page: Page; x: number; y: number; w: number; h: number }) {
  const cv = useRef<HTMLCanvasElement>(null);
  const [near, setNear] = useState(false);
  const [sharp, setSharp] = useState(1);

  useEffect(() => {
    const el = cv.current!;
    const io = new IntersectionObserver((es) => setNear(es[0].isIntersecting), { rootMargin: "100% 0px 100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // the browser's own pinch zoom: paint finer once the fingers stop (visualViewport.scale)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let tm: ReturnType<typeof setTimeout> | undefined;
    const on = () => {
      clearTimeout(tm);
      tm = setTimeout(() => setSharp((s) => (Math.abs(vv.scale - s) > 0.25 ? Math.max(1, Math.min(vv.scale, 4)) : s)), 250);
    };
    vv.addEventListener("resize", on);
    return () => {
      clearTimeout(tm);
      vv.removeEventListener("resize", on);
    };
  }, []);

  useEffect(() => {
    const el = cv.current!;
    if (!near) {
      // far from the screen: give the pixels back
      el.width = el.height = 1;
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const doc = S().doc;
    const scale = pageScale(w * sharp, page.width, page.height, window.devicePixelRatio || 1);
    const paint = () => {
      if (!alive) return;
      el.width = Math.max(1, Math.round(page.width * scale));
      el.height = Math.max(1, Math.round(page.height * scale));
      const c = el.getContext("2d");
      if (!c) return;
      // pictures / PDF bitmaps that arrive later: paint again (a few times at most)
      paintPage(c, doc, page, renderMasterOf(doc, page), scale, undefined, () => {
        clearTimeout(timer);
        timer = setTimeout(paint, 60);
      });
    };
    paint();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [near, page, w, sharp]);

  return <canvas ref={cv} className="wp-page" style={{ left: x, top: y, width: w, height: h }} />;
}
