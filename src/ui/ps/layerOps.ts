// Layer operations of the image mode (Photoshop):
//   보이는 레이어 병합 Ctrl+Shift+E      the visible layers become one pixel layer (the hidden ones stay)
//   도장 찍기 병합 Ctrl+Alt+Shift+E     a new layer on top holding what the visible layers show; the layers stay
//   패스를 선택 영역으로 Ctrl+Enter      the selected path (or the last one drawn) becomes the pixel selection

import { currentPage, draftPage, findPage, useStore } from "../../core/store";
import type { Page, RasterNode, SceneNode, VectorNode } from "../../core/types";
import { t } from "../../i18n";
import { rasterizeNode } from "../../io/export";
import { decodePngRgba, downsample } from "../../io/formats/psdWrite";
import { rasterFromRgba } from "../../io/formats/raster";
import { setSelection } from "../pixelSelect";
import { ctx2d, makeCanvas, vectorPath } from "../../render/draw";

const S = () => useStore.getState();

/** What the visible layers show, as one pixel layer placed where it was drawn (null: nothing visible). */
async function visibleAsRaster(page: Page, name: string): Promise<RasterNode | null> {
  const shown = page.nodes.filter((n) => n.visible);
  if (!shown.length) return null;
  const r = await rasterizeNode(S().doc, page, shown);
  if (!r) return null;
  const made = rasterFromRgba(downsample(decodePngRgba(r.png), r.w, r.h), r.w, r.h, name);
  return { ...made, transform: { x: r.x, y: r.y, rotation: 0, scale: 1 } };
}

export async function mergeVisible() {
  const page = currentPage();
  if (!page) return;
  const shown = page.nodes.filter((n) => n.visible);
  if (shown.length < 2) return void S().notify(t("psfeat.merge.few"));
  if (shown.some((n) => n.locked)) return void S().notify(t("psfeat.merge.locked"));
  const before = findPage(S().doc, page.id);
  const bottom = shown[0];
  let r: RasterNode | null;
  try {
    r = await visibleAsRaster(page, bottom.name);
  } catch (e: any) {
    return void S().notify(t("menu.toast.rasterizeFailed", { error: String(e?.message ?? e) }));
  }
  if (!r) return void S().notify(t("menu.toast.rasterizeEmpty"));
  // changed while drawn: drop the result
  if (findPage(S().doc, page.id) !== before) return;
  const ids = new Set(shown.map((n) => n.id));
  const merged: RasterNode = { ...r, id: bottom.id, blendMode: "NORMAL" };
  S().commit(t("psfeat.merge.hist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const i = pg.nodes.findIndex((n) => n.id === bottom.id);
    pg.nodes = pg.nodes.filter((n) => !ids.has(n.id) || n.id === bottom.id) as any;
    const j = pg.nodes.findIndex((n) => n.id === bottom.id);
    if (j >= 0) pg.nodes[j] = merged as any;
    pg.animations = pg.animations.filter((a) => !ids.has(a.targetNodeId) || a.targetNodeId === bottom.id);
    void i;
  });
  S().set({ selection: [bottom.id] });
}

export async function stampVisible() {
  const page = currentPage();
  if (!page) return;
  const before = findPage(S().doc, page.id);
  let r: RasterNode | null;
  try {
    r = await visibleAsRaster(page, t("psfeat.stamp.name"));
  } catch (e: any) {
    return void S().notify(t("menu.toast.rasterizeFailed", { error: String(e?.message ?? e) }));
  }
  if (!r) return void S().notify(t("menu.toast.rasterizeEmpty"));
  if (findPage(S().doc, page.id) !== before) return;
  const made = r;
  S().commit(t("psfeat.stamp.hist"), (d) => void draftPage(d, page.id)?.nodes.push(made as any));
  S().set({ selection: [made.id] });
}

/** The path Ctrl+Enter makes a selection from: the selected path, else the last one drawn on the page. */
export function pathTarget(page = currentPage()): VectorNode | null {
  if (!page) return null;
  const sel = S().selection;
  const picked = page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && sel.includes(n.id));
  if (picked.length) return picked[picked.length - 1];
  const all = page.nodes.filter((n): n is VectorNode => n.type === "VECTOR" && n.visible);
  return all.length ? all[all.length - 1] : null;
}

/** 패스를 선택 영역으로 만들기: the path's filled area (anti-aliased) as the pixel selection. */
export function pathToSelection() {
  const page = currentPage();
  const n = pathTarget(page);
  if (!page || !n) return void S().notify(t("psfeat.path.pick"));
  const w = Math.max(1, Math.round(page.width)), h = Math.max(1, Math.round(page.height));
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv) as CanvasRenderingContext2D;
  const tr = n.transform;
  g.translate(tr.x, tr.y);
  g.rotate((tr.rotation * Math.PI) / 180);
  g.scale(tr.scale, tr.scaleY ?? tr.scale);
  g.fillStyle = "#000";
  g.fill(vectorPath(n), n.fillRule === "evenodd" ? "evenodd" : "nonzero");
  const d = g.getImageData(0, 0, w, h).data;
  const m = { w, h, data: new Uint8Array(w * h) };
  for (let i = 0; i < m.data.length; i++) m.data[i] = d[i * 4 + 3];
  if (!m.data.some((v) => v)) return void S().notify(t("psfeat.path.empty"));
  setSelection(m, "replace");
  S().set({ tool: "marquee", selection: [] });
  S().notify(t("psfeat.path.done"));
}

void ({} as SceneNode);
