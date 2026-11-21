// Document edit mode view (Word's print layout): the pages of a document run one under the other with a gap, the
// wheel scrolls through them, and the page in the middle of the window becomes the current page. The canvas still
// edits one page (the current one); the pages around it are drawn read-only and a click on one makes it current.
//
// CanvasView calls in at three points (marked "docView" there): paint (drawNeighbours), the wheel (docWheel) and the
// pointer down (pickPageAt). Fitting (fitView in actions.ts) uses docFit through a hook.

import { useStore, type View } from "../core/store";
import type { OmwDocument, Page } from "../core/types";
import { setDocFitHook } from "./actions";
import { currentEditMode, editModeOf } from "./editModes";

const S = () => useStore.getState();

/** gap between pages, screen px */
export const PAGE_GAP = 20;
/** space kept above the first page and below the last, screen px */
const EDGE = 24;

/** The current page sits in a run of pages shown together: consecutive pages that also edit as documents. */
function runOf(doc: OmwDocument, pageId: string): { pages: Page[]; i: number } | null {
  const i = doc.pages.findIndex((p) => p.id === pageId);
  if (i < 0) return null;
  const mode = S().mode;
  const isDoc = (p: Page) => editModeOf(mode, p) === "DOCUMENT";
  if (!isDoc(doc.pages[i])) return null;
  let a = i, b = i;
  while (a > 0 && isDoc(doc.pages[a - 1])) a--;
  while (b < doc.pages.length - 1 && isDoc(doc.pages[b + 1])) b++;
  return { pages: doc.pages.slice(a, b + 1), i: i - a };
}

export const docModeNow = () => currentEditMode() === "DOCUMENT";

/** Pages around the current one that reach into the window, each with the view that draws it in place. */
export function neighbours(doc: OmwDocument, pageId: string, view: View, vh: number): { page: Page; view: View }[] {
  const run = runOf(doc, pageId);
  if (!run) return [];
  const out: { page: Page; view: View }[] = [];
  const cur = run.pages[run.i];
  const z = view.zoom;
  // above
  let top = view.panY;
  for (let j = run.i - 1; j >= 0 && top > 0; j--) {
    const p = run.pages[j];
    top -= PAGE_GAP + p.height * z;
    out.push({ page: p, view: { zoom: z, panX: view.panX + ((cur.width - p.width) / 2) * z, panY: top } });
  }
  // below
  let y = view.panY + cur.height * z;
  for (let j = run.i + 1; j < run.pages.length && y < vh; j++) {
    const p = run.pages[j];
    y += PAGE_GAP;
    out.push({ page: p, view: { zoom: z, panX: view.panX + ((cur.width - p.width) / 2) * z, panY: y } });
    y += p.height * z;
  }
  return out;
}

/** Paint the neighbouring pages (shadow, paper, content through `render`). */
export function drawNeighbours(c: CanvasRenderingContext2D, doc: OmwDocument, pageId: string, view: View, vh: number, dpr: number, render: (page: Page, view: View) => void) {
  for (const n of neighbours(doc, pageId, view, vh)) {
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.shadowColor = "rgba(0,0,0,.28)";
    c.shadowBlur = 14 * dpr;
    c.shadowOffsetY = 3 * dpr;
    c.fillStyle = n.page.background;
    // page edges on whole device pixels, rounded as the current page (CanvasView paint) and its tiles are
    const x0 = Math.round(n.view.panX * dpr), y0 = Math.round(n.view.panY * dpr);
    c.fillRect(x0, y0, Math.round((n.view.panX + n.page.width * n.view.zoom) * dpr) - x0, Math.round((n.view.panY + n.page.height * n.view.zoom) * dpr) - y0);
    c.restore();
    render(n.page, n.view);
  }
}

/**
 * The view after scrolling by (dx, dy) in the document mode: when the current page leaves the middle of the window
 * the next / previous page becomes current (view shifted so nothing moves on screen); the run's first page stops
 * below the top edge and its last page above the bottom edge.
 */
export function docScroll(view: View, dx: number, dy: number, vw: number, vh: number): { view: View; pageId?: string } {
  const s = S();
  const run = runOf(s.doc, s.pageId);
  let v: View = { ...view, panX: view.panX - dx, panY: view.panY - dy };
  if (!run) return { view: v };
  let i = run.i;
  const z = v.zoom;
  // a page being typed in stays current (the editor sits on it); scrolling still moves the view. Typing in the body
  // flow (ui/docFlow.ts) is not tied to one page: its caret goes with the text from page to page.
  const locked = !!s.editingTextId && !s.editingTextId.startsWith("flow:");
  if (!locked) {
    for (let guard = 0; guard < 200; guard++) {
      const cur = run.pages[i];
      if (i < run.pages.length - 1 && v.panY + cur.height * z + PAGE_GAP / 2 < vh / 2) {
        const nx = run.pages[i + 1];
        v = { ...v, panY: v.panY + cur.height * z + PAGE_GAP, panX: v.panX + ((cur.width - nx.width) / 2) * z };
        i++;
      } else if (i > 0 && v.panY - PAGE_GAP / 2 > vh / 2) {
        const pv = run.pages[i - 1];
        v = { ...v, panY: v.panY - pv.height * z - PAGE_GAP, panX: v.panX - ((pv.width - cur.width) / 2) * z };
        i--;
      } else break;
    }
  }
  // stop at the ends of the run (total height above / below the current page)
  let above = 0, below = 0;
  for (let j = 0; j < i; j++) above += run.pages[j].height * z + PAGE_GAP;
  for (let j = i + 1; j < run.pages.length; j++) below += run.pages[j].height * z + PAGE_GAP;
  const cur = run.pages[i];
  const maxPan = EDGE + above;
  const minPan = vh - EDGE - cur.height * z - below;
  v.panY = minPan > maxPan ? maxPan : Math.min(maxPan, Math.max(minPan, v.panY));
  // horizontally: keep some of the page in view
  const w = cur.width * z;
  v.panX = Math.min(vw - 60, Math.max(60 - w, v.panX));
  return i === run.i ? { view: v } : { view: v, pageId: run.pages[i].id };
}

/** Wheel in the document mode (no Ctrl): scroll through the pages. */
export function docWheel(dx: number, dy: number, vw: number, vh: number) {
  const r = docScroll(S().view, dx, dy, vw, vh);
  S().set(r.pageId ? { view: r.view, pageId: r.pageId, selection: [] } : { view: r.view });
}

/** A press at screen point (sx, sy) on a neighbouring page makes that page current (view shifted to match). */
export function pickPageAt(sx: number, sy: number, vh: number): boolean {
  const s = S();
  if ((s.editingTextId && !s.editingTextId.startsWith("flow:")) || !docModeNow()) return false;
  for (const n of neighbours(s.doc, s.pageId, s.view, vh)) {
    const x0 = n.view.panX, y0 = n.view.panY;
    if (sx >= x0 && sx <= x0 + n.page.width * n.view.zoom && sy >= y0 && sy <= y0 + n.page.height * n.view.zoom) {
      s.set({ pageId: n.page.id, selection: [], view: n.view });
      return true;
    }
  }
  return false;
}

// ───────── zoom presets ─────────

/** Page width (쪽 너비): the page fills the window's width; `cap` limits it (the default fit stays near 100%). */
export function fitWidthView(page: Page, vw: number, cap = Infinity): View {
  const zoom = Math.max(0.05, Math.min((vw - 2 * EDGE) / page.width, cap));
  return { zoom, panX: (vw - page.width * zoom) / 2, panY: EDGE };
}

/** Whole page (한 쪽): the page fits the window. */
export function fitPageView(page: Page, vw: number, vh: number): View {
  const zoom = Math.max(0.05, Math.min((vw - 2 * EDGE) / page.width, (vh - 2 * EDGE) / page.height));
  return { zoom, panX: (vw - page.width * zoom) / 2, panY: (vh - page.height * zoom) / 2 };
}

// default fit in the document mode: page width, at most 100%, top of the page
setDocFitHook((page, vw) => {
  if (!docModeNow()) return false;
  S().set({ view: fitWidthView(page, vw, 1) });
  return true;
});
