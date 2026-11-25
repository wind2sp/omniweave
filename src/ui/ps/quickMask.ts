// 빠른 마스크 모드 (Photoshop's Quick Mask, Q): the selection is shown as a red film over what is NOT selected, a
// layer of its own on top ("빠른 마스크", 50 %); the brush paints red there (protects) with a dark foreground colour and
// takes it away (selects) with a light one, the eraser always takes it away. Q again turns the film back into the
// selection: the less red, the more selected. Each switch is one history step, as in Photoshop.

import { create } from "zustand";
import { currentPage, draftPage, useStore } from "../../core/store";
import { IDENTITY, newRaster, type RasterNode } from "../../core/types";
import { canvasToTiles } from "../../render/brush";
import { ctx2d, drawNode, makeCanvas, type DrawEnv } from "../../render/draw";
import { t } from "../../i18n";
import { activeMask, deselect, maskCanvas, setSelection } from "../pixelSelect";

const S = () => useStore.getState();

export const useQuickMask = create<{ layerId: string | null; pageId: string | null; before: string[] }>(() => ({ layerId: null, pageId: null, before: [] }));

/** The film layer of the current page while 빠른 마스크 is on (null otherwise). */
export function quickMaskLayer(): RasterNode | null {
  const q = useQuickMask.getState();
  const page = currentPage();
  if (!q.layerId || !page || q.pageId !== page.id) return null;
  const n = page.nodes.find((x) => x.id === q.layerId);
  return n && n.type === "RASTER" ? n : null;
}
export const quickMaskOn = () => !!quickMaskLayer();

/** The brush in 빠른 마스크: red, and a light foreground colour (white) erases the film (Photoshop's white = select). */
export function quickMaskBrush(color: string): { color: string; erase: boolean } {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(color);
  const lum = m ? (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255 : 0;
  return { color: "#ff0000", erase: lum > 0.5 };
}

export function toggleQuickMask() {
  if (quickMaskOn()) return exitQuickMask();
  const page = currentPage();
  if (!page) return;
  const w = Math.round(page.width), h = Math.round(page.height);
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv);
  // the film: red where the selection is not (no selection: no film, everything may be painted over)
  const m = activeMask();
  if (m) {
    g.fillStyle = "#ff0000";
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "destination-out";
    g.drawImage(maskCanvas(m), 0, 0);
  }
  const r: RasterNode = { ...newRaster(t("psfeat.qm.layer")), transform: { ...IDENTITY }, tiles: canvasToTiles(cv), opacity: 0.5 };
  const before = [...S().selection];
  S().commit(t("psfeat.qm.on"), (d) => void draftPage(d, page.id)?.nodes.push(r as never));
  useQuickMask.setState({ layerId: r.id, pageId: page.id, before });
  S().set({ selection: [r.id], tool: "brush" });
  deselect();
}

export function exitQuickMask() {
  const page = currentPage();
  const n = quickMaskLayer();
  const q = useQuickMask.getState();
  useQuickMask.setState({ layerId: null, pageId: null, before: [] });
  if (!page || !n) return;
  const w = Math.round(page.width), h = Math.round(page.height);
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv);
  const env: DrawEnv = { doc: S().doc, clip: { x: 0, y: 0, w, h }, scale: 1, incomplete: false, onResourceReady: () => {} };
  drawNode(g, { ...n, opacity: 1 }, env, undefined, { bare: true });
  const px = g.getImageData(0, 0, w, h).data;
  const data = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < data.length; i++) {
    data[i] = 255 - px[i * 4 + 3];
    if (data[i]) any = true;
  }
  S().commit(t("psfeat.qm.off"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) pg.nodes = pg.nodes.filter((x) => x.id !== n.id) as never;
  });
  S().set({ selection: q.before.filter((id) => currentPage()?.nodes.some((x) => x.id === id)) });
  if (any) setSelection({ w, h, data });
  else deselect();
}
