// Artboards (대지) of the design mode: Illustrator keeps every artboard of a document on one canvas. Each design page is
// an artboard placed at `page.board` (its top-left in a shared canvas space, px); pages without one are laid out in a
// row after the previous artboard (Illustrator's default spacing 20 pt). The canvas draws the other artboards around the
// current one (ui/CanvasView.tsx paint); a press on one makes it current with nothing moving on screen; the artboard
// tool (Shift+O) moves, adds and deletes artboards; "모든 대지 보기" (Ctrl+Alt+0) fits them all in the window.

import { draftPage, useStore, type View } from "../core/store";
import { newPage, type OmwDocument, type Page } from "../core/types";
import { t } from "../i18n";
import { editModeOf } from "./editModes";

const S = () => useStore.getState();

/** The gap between artboards laid out automatically (20 pt). */
export const BOARD_GAP = 80 / 3;

/** Whether a page is an artboard of the design canvas (a design page). */
// Illustrator's artboards, and Photoshop's (the image mode's 대지 도구 adds one beside the picture: 2026-11-25)
export const isBoard = (p: Page, mode = S().mode) => p.kind !== "MASTER" && !p.sheet && (editModeOf(mode, p) === "DESIGN" || editModeOf(mode, p) === "IMAGE");

/** The artboards of the document with their canvas positions (explicit `board`, else right of the previous one). */
export function boardsOf(doc: OmwDocument, mode = S().mode): { page: Page; x: number; y: number }[] {
  const out: { page: Page; x: number; y: number }[] = [];
  for (const p of doc.pages) {
    if (!isBoard(p, mode)) continue;
    const prev = out[out.length - 1];
    const x = p.board?.x ?? (prev ? prev.x + prev.page.width + BOARD_GAP : 0);
    const y = p.board?.y ?? (prev ? prev.y : 0);
    out.push({ page: p, x, y });
  }
  return out;
}

/** The other artboards as the current page's view shows them (their own view each), when the current page is one. */
export function otherBoards(doc: OmwDocument, pageId: string, view: View): { page: Page; view: View; dx: number; dy: number }[] {
  const all = boardsOf(doc);
  const me = all.find((b) => b.page.id === pageId);
  if (!me || all.length < 2) return [];
  return all
    .filter((b) => b !== me)
    .map((b) => {
      const dx = b.x - me.x, dy = b.y - me.y;
      return { page: b.page, dx, dy, view: { ...view, panX: view.panX + dx * view.zoom, panY: view.panY + dy * view.zoom } };
    });
}

/** Paint the other artboards (paper with a shadow, their content via `render`, the name above each). */
export function drawBoards(c: CanvasRenderingContext2D, doc: OmwDocument, page: Page, view: View, dpr: number, vw: number, vh: number, render: (page: Page, view: View) => void) {
  const all = boardsOf(doc);
  if (all.length < 2) return;
  for (const b of otherBoards(doc, page.id, view)) {
    const x0 = b.view.panX, y0 = b.view.panY, w = b.page.width * view.zoom, h = b.page.height * view.zoom;
    // off screen: nothing to draw
    if (x0 > vw || y0 > vh || x0 + w < 0 || y0 + h < 0) continue;
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.shadowColor = "rgba(0,0,0,.35)";
    c.shadowBlur = 16 * dpr;
    c.shadowOffsetY = 4 * dpr;
    c.fillStyle = b.page.background;
    const fx = Math.round(x0 * dpr), fy = Math.round(y0 * dpr);
    c.fillRect(fx, fy, Math.round((x0 + w) * dpr) - fx, Math.round((y0 + h) * dpr) - fy);
    c.restore();
    render(b.page, b.view);
  }
  // the artboards' names above their top-left corners, "01 - 이름" (Illustrator)
  c.save();
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.font = "11px Pretendard, 'Segoe UI', sans-serif";
  c.textBaseline = "bottom";
  const me = all.find((b) => b.page.id === page.id);
  all.forEach((b, i) => {
    if (!me) return;
    const x = view.panX + (b.x - me.x) * view.zoom, y = view.panY + (b.y - me.y) * view.zoom;
    c.fillStyle = b.page.id === page.id ? "rgba(255,255,255,.95)" : "rgba(255,255,255,.6)";
    c.fillText(`${String(i + 1).padStart(2, "0")} - ${b.page.name}`, x, y - 4);
  });
  c.restore();
}

/** The artboard under the screen point (sx, sy), not the current one, with the view that keeps it in place. */
export function boardAt(sx: number, sy: number): { page: Page; view: View } | null {
  const s = S();
  for (const b of otherBoards(s.doc, s.pageId, s.view)) {
    const x0 = b.view.panX, y0 = b.view.panY;
    if (sx >= x0 && sx <= x0 + b.page.width * b.view.zoom && sy >= y0 && sy <= y0 + b.page.height * b.view.zoom) return { page: b.page, view: b.view };
  }
  return null;
}

/** A press on another artboard makes it current (the view shifts with it: nothing moves on screen). */
export function pickBoardAt(sx: number, sy: number): boolean {
  const s = S();
  if (s.editingTextId) return false;
  const cur = s.doc.pages.find((p) => p.id === s.pageId);
  if (!cur || !isBoard(cur)) return false;
  // inside the current artboard: stays
  const { zoom, panX, panY } = s.view;
  if (sx >= panX && sx <= panX + cur.width * zoom && sy >= panY && sy <= panY + cur.height * zoom) return false;
  const b = boardAt(sx, sy);
  if (!b) return false;
  s.set({ pageId: b.page.id, selection: [], view: b.view });
  return true;
}

/** Fix every artboard's position (the automatic row becomes explicit), so moving one leaves the others in place. */
function pinBoards(d: OmwDocument) {
  for (const b of boardsOf(d)) {
    const p = d.pages.find((x) => x.id === b.page.id);
    if (p && !p.board) p.board = { x: b.x, y: b.y };
  }
}

/** Move the current artboard by (dx, dy) px in the canvas (its content goes with it; the view follows it). */
export function moveBoard(pageId: string, dx: number, dy: number, live = false) {
  const s = S();
  const apply = (d: OmwDocument) => {
    pinBoards(d);
    const p = d.pages.find((x) => x.id === pageId);
    if (p?.board) p.board = { x: p.board.x + dx, y: p.board.y + dy };
  };
  if (live) s.updateGesture((d) => apply(d as OmwDocument));
  else s.commit(t("design.board.hist.move"), (d) => apply(d as OmwDocument));
}

/** A new artboard at canvas rectangle (x, y, w, h) relative to the current artboard's top-left; it becomes current. */
export function addBoard(x: number, y: number, w: number, h: number): string | null {
  const s = S();
  const all = boardsOf(s.doc);
  const me = all.find((b) => b.page.id === s.pageId);
  if (!me) return null;
  const n = all.length + 1;
  const pg = newPage("DESIGN", Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), t("design.board.name", { n }));
  pg.board = { x: me.x + x, y: me.y + y };
  const cur = s.doc.pages.find((p) => p.id === s.pageId)!;
  if (cur.background) pg.background = cur.background;
  s.commit(t("design.board.hist.add"), (d) => {
    pinBoards(d as OmwDocument);
    const i = d.pages.findIndex((p) => p.id === s.pageId);
    d.pages.splice(i + 1, 0, pg as never);
  });
  const { zoom, panX, panY } = s.view;
  S().set({ pageId: pg.id, selection: [], view: { zoom, panX: panX + x * zoom, panY: panY + y * zoom } });
  return pg.id;
}

/** Delete the current artboard and what is on it (Illustrator); the last artboard stays. */
export function deleteBoard(): boolean {
  const s = S();
  const all = boardsOf(s.doc);
  if (all.length < 2) return false;
  const i = all.findIndex((b) => b.page.id === s.pageId);
  if (i < 0) return false;
  const me = all[i], next = all[i + 1] ?? all[i - 1];
  s.commit(t("design.board.hist.delete"), (d) => {
    pinBoards(d as OmwDocument);
    d.pages = d.pages.filter((p) => p.id !== me.page.id);
  });
  const { zoom, panX, panY } = s.view;
  S().set({ pageId: next.page.id, selection: [], view: { zoom, panX: panX + (next.x - me.x) * zoom, panY: panY + (next.y - me.y) * zoom } });
  return true;
}

/** Resize / rename the current artboard (the artboard tool's fields). */
export function setBoardProps(pageId: string, p: { width?: number; height?: number; name?: string }) {
  S().commit(t("design.board.hist.props"), (d) => {
    const pg = draftPage(d, pageId);
    if (!pg) return;
    if (p.width) pg.width = Math.max(1, p.width);
    if (p.height) pg.height = Math.max(1, p.height);
    if (p.name !== undefined) pg.name = p.name;
  });
}

/** The view that shows every artboard in a window of vw × vh (모든 대지 보기, Ctrl+Alt+0). */
export function fitAllBoardsView(vw: number, vh: number): View | null {
  const s = S();
  const all = boardsOf(s.doc);
  const me = all.find((b) => b.page.id === s.pageId);
  if (!me) return null;
  const x0 = Math.min(...all.map((b) => b.x)), y0 = Math.min(...all.map((b) => b.y));
  const x1 = Math.max(...all.map((b) => b.x + b.page.width)), y1 = Math.max(...all.map((b) => b.y + b.page.height));
  const pad = 40;
  const zoom = Math.max(0.02, Math.min(8, Math.min((vw - pad * 2) / Math.max(1, x1 - x0), (vh - pad * 2) / Math.max(1, y1 - y0))));
  // the current artboard's top-left on screen
  const panX = (vw - (x1 - x0) * zoom) / 2 + (me.x - x0) * zoom;
  const panY = (vh - (y1 - y0) * zoom) / 2 + (me.y - y0) * zoom;
  return { zoom, panX, panY };
}

/** 모든 대지 보기: fit every artboard in the canvas window. */
export function fitAllBoards() {
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  const v = fitAllBoardsView(el?.clientWidth ?? 1200, el?.clientHeight ?? 800);
  if (v) S().set({ view: v });
}
