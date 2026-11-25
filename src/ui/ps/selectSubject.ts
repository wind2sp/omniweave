// 선택 › 피사체 (Photoshop's Select Subject): the background-removal engine's subject map of the picture layer, made
// the selection instead of a cut-out layer — nothing on the page changes; Shift / Alt add to / take from the selection.

import { scaleYOf } from "../../core/geom";
import { runMatte } from "../../core/image/run";
import type { SelOp } from "../../core/image/pixelSelection";
import { currentPage, useStore } from "../../core/store";
import { makeCanvas, ctx2d } from "../../render/draw";
import { t } from "../../i18n";
import { imageTarget } from "../imageActions";
import { matteSource } from "../matteActions";
import { setSelection } from "../pixelSelect";

const S = () => useStore.getState();
let busy = false;

export async function selectSubject(op: SelOp = "replace"): Promise<boolean> {
  const page = currentPage();
  const tg = imageTarget();
  if (!page || !tg) {
    S().notify(t("image.needTarget"));
    return false;
  }
  if (busy) return false;
  busy = true;
  try {
    S().notify(t("psfeat.subject.working"));
    const { src, bounds: b, work } = await matteSource(tg.node);
    const { value: res } = await runMatte(work, {});
    // the subject map as a picture (white where the subject is), drawn onto the page with the layer's place
    const a = makeCanvas(work.width, work.height);
    const ag = ctx2d(a);
    const id = ag.createImageData(work.width, work.height);
    for (let i = 0; i < res.alpha.length; i++) id.data[i * 4 + 3] = res.alpha[i];
    ag.putImageData(id, 0, 0);
    const W = Math.round(page.width), H = Math.round(page.height);
    const pc = makeCanvas(W, H);
    const g = ctx2d(pc);
    const tr = tg.node.transform, r = (tr.rotation * Math.PI) / 180, sx = tr.scale, sy = scaleYOf(tr);
    g.setTransform(Math.cos(r) * sx, Math.sin(r) * sx, -Math.sin(r) * sy, Math.cos(r) * sy, tr.x, tr.y);
    // local pixels: the raster's own (from its tile origin), a picture's scaled to its box
    g.translate(src.ox + (b?.x ?? 0) * src.sx, src.oy + (b?.y ?? 0) * src.sy);
    g.scale(src.sx, src.sy);
    g.drawImage(a, 0, 0);
    const px = g.getImageData(0, 0, W, H).data;
    const data = new Uint8Array(W * H);
    let any = false;
    for (let i = 0; i < data.length; i++) if ((data[i] = px[i * 4 + 3])) any = true;
    if (!any) {
      S().notify(t("image.matte.empty"));
      return false;
    }
    setSelection({ w: W, h: H, data }, op);
    S().notify(t("psfeat.subject.done"));
    return true;
  } catch (e) {
    S().notify(t("image.matte.failed", { error: e instanceof Error ? e.message : String(e) }));
    return false;
  } finally {
    busy = false;
  }
}
