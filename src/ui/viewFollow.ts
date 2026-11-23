// The view follows the canvas in the image and design edit modes (Photoshop / Illustrator 화면에 맞춤).
// Whatever changes the canvas size — canvas size (W / H in the properties, the page setup dialog, the A4 / FHD chips),
// crop, image size, a 90° rotation, undo / redo of any of these, or moving to an artboard of another size — the
// view fits the new canvas: centred, whole, at a zoom one can work at (actions.ts fitPageIn: smaller canvases are
// enlarged up to FIT_ZOOM_MAX, bigger ones reduced). Before (2026-11-23) the view stayed as it was: an A4 canvas cut
// to 200 × 150 shrank into the window's top-left corner and seemed to vanish, a larger one ran off the screen.
// Switching document tabs keeps each tab's own view; the document and slide modes keep their own behaviour.

import { useStore, type StoreState } from "../core/store";
import { activeSessionId } from "../core/sessions";
import { currentEditMode, type EditMode } from "./editModes";
import { fitCurrent } from "./actions";

/** Edit modes whose view follows the canvas size. */
export const followsCanvas = (mode: EditMode) => mode === "IMAGE" || mode === "DESIGN";

export interface CanvasKey {
  pageId: string;
  w: number;
  h: number;
  /** ids of the document's pages: a page id the previous document did not have means another document (tab switch, new / opened file) */
  pages: ReadonlySet<string> | readonly string[];
}

export function canvasKey(st: Pick<StoreState, "doc" | "pageId">): CanvasKey | null {
  const p = st.doc.pages.find((x) => x.id === st.pageId);
  return p ? { pageId: p.id, w: p.width, h: p.height, pages: st.doc.pages.map((x) => x.id) } : null;
}

const has = (s: CanvasKey["pages"], id: string) => (Array.isArray(s) ? s.includes(id) : (s as ReadonlySet<string>).has(id));

/**
 * The view should fit again: the canvas on screen now has another size, in the same document (its size changed, or
 * the view moved to another page / artboard of that document), in the image / design mode. Another document coming
 * in (tab switch, new or opened file) keeps its own view or fits on its own.
 */
export function needsRefit(prev: CanvasKey | null, next: CanvasKey | null, mode: EditMode): boolean {
  if (!prev || !next || !followsCanvas(mode)) return false;
  if (!has(prev.pages, next.pageId)) return false;
  return Math.abs(prev.w - next.w) > 1e-6 || Math.abs(prev.h - next.h) > 1e-6;
}

/** Start following (CanvasView); returns the unsubscribe. One fit per frame however many changes come in it. */
export function followCanvasSize(): () => void {
  let prev = canvasKey(useStore.getState());
  let pending = 0;
  const unsub = useStore.subscribe((st, old) => {
    if (st.doc === old.doc && st.pageId === old.pageId) return;
    const next = canvasKey(st);
    if (!pending && needsRefit(prev, next, currentEditMode())) {
      const session = activeSessionId();
      pending = requestAnimationFrame(() => {
        pending = 0;
        // a tab switch swaps the document in before it names the new tab: that one keeps its own view
        if (activeSessionId() === session) fitCurrent();
      });
    }
    prev = next;
  });
  return () => {
    unsub();
    if (pending) cancelAnimationFrame(pending);
  };
}