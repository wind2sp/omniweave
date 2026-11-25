// 레이어 › 고급 개체 › 고급 개체로 변환 (Photoshop's Convert to Smart Object): the layer's pixels become the content of
// an embedded smart object (a PNG kept as an asset, RasterNode.psdSmart with `edited`), so 내용 편집 opens them in a
// tab of their own and saving there draws the layer anew (ui/smartObject.ts), and a PSD keeps it as a placed layer
// that Photoshop opens as a smart object (io/formats/psdWrite.ts smartPlaced). The layer's scale and turn stay in its
// transform: scaling it down and up again loses nothing.

import { applyTransform } from "../../core/geom";
import { makeAsset } from "../../core/assets";
import { rasterContentBounds } from "../../core/loom";
import { encodePng } from "../../core/image/png";
import { applyMask } from "../../core/image/layerMask";
import { tilesToImg, tileBounds } from "../../core/image/pixels";
import { currentPage, draftPage, useStore } from "../../core/store";
import type { RasterNode } from "../../core/types";
import { t } from "../../i18n";
import { rasterFingerprint } from "../../io/formats/psd";
import { rasterizeLayer } from "../pixelSelect";
import { soleSelected } from "./maskActions";

const S = () => useStore.getState();

const uuid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === "x" ? r : (r & 3) | 8).toString(16);
      });

export const canConvertToSmart = () => {
  const n = soleSelected();
  return !!n && !n.locked && (n.type === "RASTER" ? !n.adjust && !n.psdSmart : n.type === "IMAGE" || n.type === "VECTOR" || n.type === "TEXT");
};

export function convertToSmartObject() {
  const page = currentPage();
  let n = soleSelected(page);
  if (!page || !n || !canConvertToSmart()) return void S().notify(t("psfeat.smart.pick"));
  if (n.type !== "RASTER") {
    const r = rasterizeLayer(page, n);
    if (!r) return;
    n = r;
  }
  const r = n as RasterNode;
  const tiles = r.mask ? applyMask(r) : r.tiles;
  const tb = tileBounds(tiles);
  if (!tb) return void S().notify(t("psfeat.smart.empty"));
  // the content: the layer's painted pixels in its own resolution
  const cb = rasterContentBounds({ ...r, tiles });
  const img = tilesToImg(tiles, tb);
  const w = Math.max(1, Math.round(cb.w)), h = Math.max(1, Math.round(cb.h));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) rgba.set(img.data.subarray(((cb.y - tb.oy + y) * tb.width + (cb.x - tb.ox)) * 4, ((cb.y - tb.oy + y) * tb.width + (cb.x - tb.ox) + w) * 4), y * w * 4);
  const name = `${(r.name || "layer").replace(/[\\/:*?"<>|]/g, "_")}.png`;
  const asset = makeAsset(encodePng(rgba, w, h, 4), "image/png", name);
  const quad = ([[cb.x, cb.y], [cb.x + w, cb.y], [cb.x + w, cb.y + h], [cb.x, cb.y + h]] as [number, number][]).flatMap((p) => applyTransform(r.transform, p));
  const next: RasterNode = { ...r, tiles };
  delete next.mask;
  next.psdSmart = { id: uuid(), kind: "embedded", name, content: "png", quad, contentSize: { w, h }, redraw: true, edited: { assetId: asset.id, hash: asset.hash, w, h, fp: rasterFingerprint(next) }, at: { ...r.transform } };
  const pg = currentPage()!;
  S().commit(t("psfeat.smart.hist"), (d) => {
    d.assets[asset.id] = asset as any;
    const p = draftPage(d, pg.id);
    const i = p?.nodes.findIndex((x) => x.id === r.id) ?? -1;
    if (p && i >= 0) p.nodes[i] = next as any;
  });
  S().notify(t("psfeat.smart.done", { name: r.name }));
}
