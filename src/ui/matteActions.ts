// Background removal ("배경 지우기") on the selected raster / image node — non-destructive:
//  - the cut-out becomes a NEW node right above the original (same transform, same crop), the original is hidden,
//    all in one undo step; nothing of the original is changed;
//  - the cut-out joins the original's layer group and keeps its clip flag, so the clip stack is unchanged (layers
//    clipped onto the original now clip onto the visible cut-out);
//  - the matte (full-resolution alpha, grey PNG) is kept as its own asset, linked by the cut-out's `matte` field
//    (core/types.ts NodeMatte), so the coming Mask model (docs/design/UNIFIED_STYLES.md §4.6 / §6) can turn it into
//    `node.mask` without recomputing.

import { makeAsset } from "../core/assets";
import { cropImg, imgToTiles, newImg, type Img } from "../core/image/pixels";
import { runMatte } from "../core/image/run";
import { encodePng as encodePngPure } from "../core/image/png";
import { TYPE_EDGE, type MatteOptions, type MatteResult } from "../core/image/matte/pipeline";
import type { MatteType } from "../core/image/matte/classify";
import { DEFAULT_EDGE, type EdgeOptions } from "../core/image/matte/refine";
import type { MatteHint } from "../core/image/matte/hints";
import { draftPage, findPage, useStore } from "../core/store";
import { newImage, newRaster, type AssetRef, type ImageNode, type OmwDocument, type NodeMatte, type RasterNode, type SceneNode } from "../core/types";
import { imageTarget, loadSource } from "./imageActions";
import { revealTransparencyInPlace } from "./transparency";
import { t as tr } from "../i18n";

const S = () => useStore.getState();

/**
 * The matte asset of a cut-out node: its `matte` field, or — for documents made by development builds before that
 * field existed — the old naming convention `matte_<nodeId>`.
 */
export function matteAssetOf(doc: Pick<OmwDocument, "assets">, node: SceneNode): AssetRef | undefined {
  const id = (node.type === "RASTER" || node.type === "IMAGE") && node.matte ? node.matte.assetId : `matte_${node.id}`;
  return doc.assets[id];
}

export const matteTypeLabel = (type: MatteType) => tr(`image.matte.type.${type}`);

async function encodePng(img: Img): Promise<Uint8Array> {
  // native encoder where there is a canvas (fast on 12 MP), else the pure one (tests, old engines)
  if (typeof ImageData === "undefined" || (typeof OffscreenCanvas === "undefined" && typeof document === "undefined")) return encodePngPure(img.data, img.width, img.height, 4);
  const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(img.width, img.height);
    (c.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(id, 0, 0);
    return new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
  }
  const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
  c.getContext("2d")!.putImageData(id, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
  if (!blob) throw new Error(tr("image.err.png"));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Grey, opaque picture of a matte (white = kept), the way Photoshop shows a layer mask. */
export function matteImage(alpha: Uint8ClampedArray, width: number, height: number): Img {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < alpha.length; p++) {
    const v = alpha[p];
    data[p * 4] = data[p * 4 + 1] = data[p * 4 + 2] = v;
    data[p * 4 + 3] = 255;
  }
  return { width, height, data };
}

/** Bounding box of the pixels with any alpha (null = nothing painted, or the whole image). */
function alphaBounds(img: Img): { x: number; y: number; w: number; h: number } | null {
  const { width: W, height: H, data: d } = img;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (d[(y * W + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === W - 1 && y1 === H - 1)) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Put a result computed on a crop back into the full source frame. */
function pasteBack(cut: Img, alpha: Uint8ClampedArray, W: number, H: number, ox: number, oy: number): { cut: Img; alpha: Uint8ClampedArray } {
  const full = newImg(W, H), a = new Uint8ClampedArray(W * H);
  for (let y = 0; y < cut.height; y++) {
    full.data.set(cut.data.subarray(y * cut.width * 4, (y + 1) * cut.width * 4), ((oy + y) * W + ox) * 4);
    a.set(alpha.subarray(y * cut.width, (y + 1) * cut.width), (oy + y) * W + ox);
  }
  return { cut: full, alpha: a };
}

/**
 * The pixels background removal works on: raster layers come padded to whole tiles, so only their painted area is
 * used (or the padding reads as "transparent"). The dialog previews the same area, so a saliency map computed there
 * lines up with the final apply.
 */
export async function matteSource(node: RasterNode | ImageNode) {
  const src = await loadSource(node);
  const bounds = node.type === "RASTER" ? alphaBounds(src.img) : null;
  const work = bounds ? cropImg(src.img, bounds.x, bounds.y, bounds.w, bounds.h) : src.img;
  return { src, bounds, work };
}

export interface MatteEditTarget {
  pageId: string;
  /** the hidden original the cut-out was made from */
  node: RasterNode | ImageNode;
  /** the selected cut-out */
  cutout: RasterNode | ImageNode;
  matte: NodeMatte;
}

/** The selected cut-out, when it still has its original on the page: the dialog re-edits it with its saved options. */
export function matteEditTarget(): MatteEditTarget | null {
  const t = imageTarget();
  const m = t?.node.matte;
  if (!t || !m) return null;
  const page = findPage(S().doc, t.pageId);
  const src = page?.nodes.find((n) => n.id === m.sourceId);
  if (!src || (src.type !== "RASTER" && src.type !== "IMAGE")) return null;
  return { pageId: t.pageId, node: src, cutout: t.node, matte: m };
}

/** Dialog options saved in a cut-out's matte record (type, edge sliders, shadow, inner regions, hints). */
export function matteOptionsOf(m: NodeMatte): { type: MatteType; edge: Partial<EdgeOptions>; keepShadow: boolean; inner: MatteOptions["inner"]; hints: MatteHint[] } {
  const { keepShadow, keepInner, ...rest } = m.edge;
  const edge: Partial<EdgeOptions> = {};
  for (const k of Object.keys(DEFAULT_EDGE) as (keyof EdgeOptions)[]) if (typeof rest[k] === "number") edge[k] = rest[k] as number;
  return { type: m.type, edge, keepShadow: keepShadow === true, inner: keepInner === undefined ? "auto" : !keepInner, hints: (m.hints ?? []).map((h) => ({ ...h })) };
}

const NON_TEXT_INPUT = new Set(["range", "checkbox", "radio", "button", "submit", "reset", "color", "file", "image"]);

/**
 * Undo / redo keys while the background-removal dialog is open: "point" = Ctrl+Z takes back the last hint point,
 * "block" = an undo / redo that must not reach the document behind the dialog (redo, or Ctrl+Z with no point left),
 * null = not ours (other keys, or a text field keeping its own undo). Letters by position when the layout gives no
 * Latin letter (Korean IME), the same rule as the global shortcuts.
 */
export function dialogUndoKey(e: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "key" | "code" | "target">): "point" | "block" | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const k = /^[a-z]$/i.test(e.key) || !/^Key[A-Z]$/.test(e.code) ? e.key.toLowerCase() : e.code.slice(3).toLowerCase();
  if (k !== "z" && k !== "y") return null;
  const el = e.target as (HTMLElement & { type?: string }) | null;
  if (el?.tagName === "INPUT" && !NON_TEXT_INPUT.has(String(el.type).toLowerCase())) return null;
  if (el?.closest?.("textarea,[contenteditable='true'],[contenteditable='']")) return null;
  return k === "z" && !e.shiftKey ? "point" : "block";
}

let busy = false;

/**
 * Remove the background of the selected raster / image. `opts.type` overrides the detected type. With `edit` the
 * cut-out `edit.cutout` is remade from its original (same node, same place) instead of adding a new one. Returns the
 * engine result (type, confidence, timings) or null when nothing was done.
 */
export async function removeBackgroundSelection(opts: MatteOptions = {}, edit?: MatteEditTarget | null): Promise<MatteResult | null> {
  const t = edit ? { pageId: edit.pageId, node: edit.node } : imageTarget();
  if (!t) {
    S().notify(tr("image.needTarget"));
    return null;
  }
  if (busy) {
    S().notify(tr("image.busy"));
    return null;
  }
  busy = true;
  try {
    S().notify(tr("image.matte.working"));
    const { src, bounds: b, work } = await matteSource(t.node);
    const { value: res, ms } = await runMatte(work, opts);
    const r = b ? { ...res, ...pasteBack(res.cut, res.alpha, src.img.width, src.img.height, b.x, b.y) } : res;
    const s = S();
    const page = findPage(s.doc, t.pageId);
    const cur = page?.nodes.find((n) => n.id === t.node.id);
    // the source changed while the engine ran: the result no longer matches it
    if (cur !== t.node || (edit && page?.nodes.find((n) => n.id === edit.cutout.id) !== edit.cutout)) {
      s.notify(tr("image.changed"));
      return null;
    }
    let any = false;
    for (let p = 0; p < r.alpha.length && !any; p++) any = r.alpha[p] > 0;
    if (!any) {
      s.notify(tr("image.matte.empty"));
      return null;
    }
    const name = tr("image.matte.layerName", { name: t.node.name });
    let node: RasterNode | ImageNode;
    const assets: AssetRef[] = [];
    if (t.node.type === "RASTER") {
      const rn = newRaster(name);
      rn.tiles = imgToTiles(r.cut, src.ox, src.oy, {}).tiles;
      if (t.node.crop) rn.crop = { ...t.node.crop };
      node = rn;
    } else {
      const orig = s.doc.assets[t.node.assetId];
      const base = (orig?.name ?? t.node.name).replace(/\.[^.]+$/, "");
      const cutAsset = makeAsset(await encodePng(r.cut), "image/png", `${base}-cutout.png`);
      assets.push(cutAsset);
      const im = newImage(cutAsset.id, t.node.width, t.node.height, name);
      if (t.node.crop) im.crop = { ...t.node.crop };
      node = im;
    }
    node.transform = { ...t.node.transform };
    node.opacity = t.node.opacity;
    node.blendMode = t.node.blendMode;
    // same place in the layer structure: same group, same clip state
    if (t.node.groupId) node.groupId = t.node.groupId;
    if (t.node.clip) node.clip = true;
    // 8-bit grey PNG, full resolution of the source pixels (raster: the source's tile bounds)
    const matteBytes = encodePngPure(r.alpha, src.img.width, src.img.height, 1);
    const matteAsset = makeAsset(matteBytes, "image/png", `${t.node.name}-matte.png`);
    assets.push(matteAsset);
    const edge: NodeMatte["edge"] = { ...DEFAULT_EDGE, ...TYPE_EDGE[r.type], ...opts.edge };
    if (opts.keepShadow) edge.keepShadow = true;
    // inner background-coloured regions: absent = automatic; keepInner true = keep all, false = remove all
    if (typeof opts.inner === "boolean") edge.keepInner = !opts.inner;
    const matte: NodeMatte = { assetId: matteAsset.id, sourceId: t.node.id, type: r.type, edge };
    if (b) matte.bounds = b;
    if (opts.hints?.length) matte.hints = opts.hints.map((h) => ({ x: h.x, y: h.y, fg: h.fg }));
    node.matte = matte;
    if (edit) {
      // re-edit: the same cut-out node gets the new pixels and options; its place, name and look stay
      const old = edit.cutout;
      Object.assign(node, { id: old.id, name: old.name, visible: old.visible, locked: old.locked, opacity: old.opacity, blendMode: old.blendMode, transform: { ...old.transform } });
      if (old.groupId) node.groupId = old.groupId;
      else delete node.groupId;
      if (old.clip) node.clip = true;
      else delete node.clip;
      // the cut-out's own crop (it may have been cropped after it was made)
      if (old.crop) node.crop = { ...old.crop };
      else delete node.crop;
    }
    s.commit(tr("image.matte.undo", { type: matteTypeLabel(r.type) }), (d) => {
      for (const a of assets) d.assets[a.id] = a;
      const pg = draftPage(d, t.pageId);
      if (!pg) return;
      // a photo (JPG) opened on a white canvas: the removed background shows as transparent, not as that white
      revealTransparencyInPlace(pg);
      if (edit) {
        const at = pg.nodes.findIndex((n) => n.id === edit.cutout.id);
        if (at >= 0) pg.nodes[at] = node as any;
        return;
      }
      const at = pg.nodes.findIndex((n) => n.id === t.node.id);
      pg.nodes.splice(at < 0 ? pg.nodes.length : at + 1, 0, node as any);
      const orig = pg.nodes.find((n) => n.id === t.node.id);
      if (orig) orig.visible = false;
    });
    s.set({ selection: [node.id] });
    s.notify(tr(r.review ? "image.matte.doneReview" : "image.matte.done", { type: matteTypeLabel(r.type), ms: Math.round(ms) }));
    return r;
  } catch (e) {
    S().notify(tr("image.matte.failed", { error: e instanceof Error ? e.message : String(e) }));
    return null;
  } finally {
    busy = false;
  }
}

