// Page thumbnails. Rendering is cached by page (and master) object identity — pages are
// immutable, so an unchanged page never repaints — and scheduled in idle time.

import { useEffect, useRef } from "react";
import { useStore } from "../../core/store";
import { renderMasterOf } from "../../core/headerFooter";
import type { Page } from "../../core/types";
import { ctx2d, makeCanvas } from "../../render/draw";
import { paintPage } from "../../render/weave";

type Src = OffscreenCanvas | HTMLCanvasElement;
interface Entry {
  master: Page | null;
  width: number;
  src: Src;
}
const cache = new WeakMap<Page, Entry>();

type Job = { page: Page; width: number; done: (src: Src) => void };
const queue = new Map<string, Job>();
let scheduled = false;

const idle: (cb: () => void) => void =
  // (no window when a test imports the shell)
  typeof window !== "undefined" && typeof (window as any).requestIdleCallback === "function"
    ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 600 })
    : (cb) => setTimeout(cb, 60);

function pump() {
  if (scheduled) return;
  scheduled = true;
  // debounce bursts of edits (e.g. a brush stroke) before spending idle time
  setTimeout(() =>
    idle(() => {
      scheduled = false;
      const t0 = performance.now();
      for (const [id, job] of queue) {
        queue.delete(id);
        renderNow(job);
        if (performance.now() - t0 > 12) break; // stay within one idle slice
      }
      if (queue.size) pump();
    }),
  250);
}

function renderNow({ page, width, done }: Job) {
  const doc = useStore.getState().doc;
  const master = renderMasterOf(doc, page);
  const scale = width / page.width;
  const cv = makeCanvas(Math.max(1, Math.round(page.width * scale)), Math.max(1, Math.round(page.height * scale)));
  let complete = true;
  try {
    complete = paintPage(
      ctx2d(cv),
      doc,
      page,
      master,
      scale,
      undefined,
      () => {
        // resource (image / PDF raster, a CMYK composite) arrived later: drop cache entry and repaint
        cache.delete(page);
        request(page, width, done);
      },
      true,
    );
  } catch {
    complete = false;
  }
  if (complete) cache.set(page, { master, width, src: cv });
  done(cv);
}

function request(page: Page, width: number, done: (src: Src) => void) {
  queue.set(page.id, { page, width, done });
  pump();
}

export function Thumb({ page, width, className }: { page: Page; width: number; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const master = useStore((s) => renderMasterOf(s.doc, page));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pxW = Math.round(width * dpr);
  const h = Math.max(1, Math.round((width * page.height) / page.width));

  useEffect(() => {
    let alive = true;
    const blit = (src: Src) => {
      const cv = ref.current;
      if (!alive || !cv) return;
      cv.width = src.width;
      cv.height = src.height;
      const c = cv.getContext("2d");
      c?.clearRect(0, 0, cv.width, cv.height);
      c?.drawImage(src as CanvasImageSource, 0, 0);
    };
    const hit = cache.get(page);
    if (hit && hit.master === master && hit.width === pxW) blit(hit.src);
    else request(page, pxW, blit);
    return () => {
      alive = false;
    };
  }, [page, master, pxW]);

  return <canvas ref={ref} className={"thumb" + (className ? " " + className : "")} style={{ width, height: h, aspectRatio: `${page.width} / ${page.height}` }} aria-hidden="true" />;
}
