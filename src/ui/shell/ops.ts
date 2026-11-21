// Small shell helpers: zoom around the viewport centre and gesture-backed live edits
// (scrubbing a number or dragging a colour picker is one undo step, not hundreds).

import { draftPage, useStore } from "../../core/store";
import { updateNodes, setPageProps } from "../actions";
import type { Page } from "../../core/types";
import { t } from "../../i18n";

const S = () => useStore.getState();

function viewportSize() {
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  return { w: el?.clientWidth ?? 1200, h: el?.clientHeight ?? 800 };
}

export const ZOOM_MIN = 0.02;
export const ZOOM_MAX = 32;

export function zoomTo(zoom: number) {
  const { view } = S();
  const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
  const { w, h } = viewportSize();
  const cx = w / 2, cy = h / 2;
  // keep the page point under the viewport centre fixed
  const px = (cx - view.panX) / view.zoom, py = (cy - view.panY) / view.zoom;
  S().set({ view: { zoom: z, panX: cx - px * z, panY: cy - py * z } });
}

const STEPS = [0.05, 0.1, 0.125, 0.25, 0.333, 0.5, 0.667, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];
export function zoomStep(dir: 1 | -1) {
  const z = S().view.zoom;
  const next = dir > 0 ? STEPS.find((s) => s > z * 1.001) ?? ZOOM_MAX : [...STEPS].reverse().find((s) => s < z * 0.999) ?? ZOOM_MIN;
  zoomTo(next);
}

/** Zoom tool (Z): one step in (or out, Alt) keeping the clicked screen point (canvas px) in place. */
export function zoomAt(dir: 1 | -1, sx: number, sy: number) {
  const { view } = S();
  const z = view.zoom;
  const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, dir > 0 ? STEPS.find((s) => s > z * 1.001) ?? ZOOM_MAX : [...STEPS].reverse().find((s) => s < z * 0.999) ?? ZOOM_MIN));
  const px = (sx - view.panX) / z, py = (sy - view.panY) / z;
  S().set({ view: { zoom: next, panX: sx - px * next, panY: sy - py * next } });
}

/** Handlers for a value that can be edited live (scrub / colour drag) and committed once. */
export interface Live<T> {
  set: (v: T) => void;
  begin?: () => void;
  live?: (v: T) => void;
  end?: () => void;
}

/** Live edit applied to every selected node. */
export function nodeLive<T>(label: string, apply: (n: any, v: T) => void, ids: string[] = S().selection): Live<T> {
  return {
    set: (v) => updateNodes(ids, label, (n) => apply(n, v)),
    begin: () => S().beginGesture(),
    live: (v) =>
      S().updateGesture((d) => {
        draftPage(d, S().pageId)?.nodes.forEach((n) => ids.includes(n.id) && apply(n, v));
      }),
    end: () => S().endGesture(label),
  };
}

/** Live edit of the current page's properties. */
export function pageLive<T>(apply: (p: Partial<Page>, v: T) => void, label = t("image.undo.pageProps")): Live<T> {
  const patch = (v: T) => {
    const p: Partial<Page> = {};
    apply(p, v);
    return p;
  };
  return {
    set: (v) => setPageProps(patch(v)),
    begin: () => S().beginGesture(),
    live: (v) =>
      S().updateGesture((d) => {
        const pg = draftPage(d, S().pageId);
        if (pg) Object.assign(pg, patch(v));
      }),
    end: () => S().endGesture(label),
  };
}

/** Plain (non-document) value: every change is applied directly. */
export function plainLive<T>(set: (v: T) => void): Live<T> {
  return { set, live: set };
}

export function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input,textarea,select,[contenteditable='true'],[contenteditable='']");
}
