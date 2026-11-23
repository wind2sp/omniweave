// Glue between the image engine (src/core/image, pure) and the document: read pixels of the selected raster / image
// node, run filters / adjustments / trace in the image worker, and commit the result as one undoable step.
//
// Loom rules kept here:
//  - raster layers: only tiles whose bytes changed get new threads (imgToTiles reuses unchanged tile objects);
//  - image nodes: the result is a new PNG asset; the original asset stays in the document (and in history), so
//    undo restores it and nothing of the source file is lost.

import { getBlob, makeAsset } from "../core/assets";
import { downscale, imgToTiles, tileBounds, tilesToImg, type Img } from "../core/image/pixels";
import { opDef, opsSpread, type ImageOp, type OpDef, type ParamSpec } from "../core/image/ops";
import type { ApplyCtx } from "../core/image/filters";
import { runOps, runTrace } from "../core/image/run";
import type { TraceOptions } from "../core/image/trace";
import { draftPage, findPage, useStore } from "../core/store";
import { newVector, type ImageNode, type RasterNode, type VectorNode } from "../core/types";
import { decodeImage } from "../io/tools/imageTools";
import { t as tr } from "../i18n";

const S = () => useStore.getState();

/** Registry texts (core/image/ops.ts) in the current language; the registry's Korean is the fallback. */
export const opLabel = (def: Pick<OpDef, "id" | "label">) => tr(`image.op.${def.id}.label`, undefined, def.label);
export const opHint = (def: Pick<OpDef, "id" | "hint">) => (def.hint ? tr(`image.op.${def.id}.hint`, undefined, def.hint) : undefined);
export const paramLabel = (opId: string, s: ParamSpec) => tr(`image.op.${opId}.param.${s.key}`, undefined, s.label);
/** One of the three sliders of a "triple" param. */
export const paramPartLabel = (opId: string, s: ParamSpec, i: number, fallback: string) => tr(`image.op.${opId}.param.${s.key}.${i}`, undefined, fallback);
/** An option of a "choice" param. */
export const paramOptionLabel = (opId: string, s: ParamSpec, value: number, fallback: string) => tr(`image.op.${opId}.param.${s.key}.opt.${value}`, undefined, fallback);

export type ImageTargetNode = RasterNode | ImageNode;

export interface ImageTarget {
  pageId: string;
  node: ImageTargetNode;
}

/**
 * First selected raster layer or image on the current page. With nothing selected, the page's only picture / painted
 * raster layer (shown, unlocked) — an opened PNG / JPG / one-layer image is "the active layer" as in Photoshop, so
 * 배경 지우기 and the filters work right after opening it. Before 2026-11-23 they stayed greyed out until the layer was
 * clicked, which looked like background removal did not work at all. With several such layers one must be picked.
 */
export function imageTarget(): ImageTarget | null {
  const s = S();
  const page = findPage(s.doc, s.pageId);
  if (!page) return null;
  for (const id of s.selection) {
    const n = page.nodes.find((x) => x.id === id);
    if (n && (n.type === "RASTER" || n.type === "IMAGE")) return { pageId: page.id, node: n };
  }
  if (s.selection.length) return null;
  // a one-colour fill (the '캔버스 확장' layer of 캔버스 크기, a solid colour layer) is not a picture: it does not count
  const only = page.nodes.filter((n) => n.visible && !n.locked && (n.type === "IMAGE" || (n.type === "RASTER" && Object.keys(n.tiles).length > 0 && !solidFill(n))));
  return only.length === 1 ? { pageId: page.id, node: only[0] as ImageTargetNode } : null;
}

const solidCache = new WeakMap<object, boolean>();
/** Every painted pixel of the raster has the same colour and alpha (a flat fill, holes allowed). Cached per tile map. */
export function solidFill(n: RasterNode): boolean {
  const hit = solidCache.get(n.tiles);
  if (hit !== undefined) return hit;
  let ref = -1, solid = true;
  outer: for (const t of Object.values(n.tiles)) {
    const d = t.data;
    for (let i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      const v = ((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]) >>> 0;
      if (ref < 0) ref = v;
      else if (v !== ref) {
        solid = false;
        break outer;
      }
    }
  }
  solidCache.set(n.tiles, solid);
  return solid;
}

export interface ImageSource {
  img: Img;
  /** node-local position of image pixel (x, y) = (ox + x·sx, oy + y·sy) */
  ox: number;
  oy: number;
  sx: number;
  sy: number;
}

async function decodeAsset(node: ImageNode): Promise<Img> {
  const asset = S().doc.assets[node.assetId];
  const bytes = asset ? getBlob(asset.hash) : undefined;
  if (!asset || !bytes) throw new Error(tr("image.err.noSource"));
  const bmp = await decodeImage(bytes, asset.mime);
  const w = bmp.width, h = bmp.height;
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const data = g.getImageData(0, 0, w, h).data;
  return { width: w, height: h, data };
}

/** Pixels of a target node. Raster layers are grown by `margin` px (whole tiles) so blurs can spill outwards. */
export async function loadSource(node: ImageTargetNode, margin = 0): Promise<ImageSource> {
  if (node.type === "RASTER") {
    const b = tileBounds(node.tiles, margin);
    if (!b) throw new Error(tr("image.err.emptyRaster"));
    return { img: tilesToImg(node.tiles, b), ox: b.ox, oy: b.oy, sx: 1, sy: 1 };
  }
  const img = await decodeAsset(node);
  return { img, ox: 0, oy: 0, sx: node.width / img.width, sy: node.height / img.height };
}

/** Small preview copy (longest side ≤ maxSide) plus the context that makes spatial params match the full result. */
export function previewOf(src: Img, maxSide = 420) {
  const { img, scale } = downscale(src, maxSide);
  return { img, ctx: { scale, fullW: src.width, fullH: src.height, offX: 0, offY: 0 } };
}

async function encodePng(img: Img): Promise<Uint8Array> {
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

function opsLabel(ops: ImageOp[]): string {
  const names = ops.map((o) => {
    const d = opDef(o.op);
    return d ? opLabel(d) : o.op;
  });
  const adjust = ops.every((o) => opDef(o.op)?.group === "adjust" || opDef(o.op)?.group === "auto");
  return tr(adjust ? "image.undo.adjust" : "image.undo.filter", { names: names.join(" → ") });
}

let busy = false;

/**
 * Apply ops to the selected raster / image node as one undoable step. Returns null when nothing was selected or
 * nothing changed. The source is re-checked after the worker finishes so a concurrent edit is never overwritten.
 */
export async function applyImageOps(ops: ImageOp[], label = opsLabel(ops)): Promise<{ ms: number; tiles?: number } | null> {
  const t = imageTarget();
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
    const src = await loadSource(t.node, opsSpread(ops));
    // Raster layers are grown by the ops' spread; position-dependent ops (mosaic grid, vignette centre) must still see
    // the un-grown layer bounds — the same frame the dialog preview used — or the result shifts against the preview.
    const b0 = t.node.type === "RASTER" ? tileBounds(t.node.tiles) : null;
    const ctx: ApplyCtx | undefined = b0
      ? { scale: 1, fullW: b0.width, fullH: b0.height, offX: src.ox - b0.ox, offY: src.oy - b0.oy }
      : undefined;
    const { value: out, ms } = await runOps(src.img, ops, ctx);
    const s = S();
    const page = findPage(s.doc, t.pageId);
    const cur = page?.nodes.find((n) => n.id === t.node.id);
    if (!cur || cur.type !== t.node.type || (cur.type === "RASTER" && cur.tiles !== (t.node as RasterNode).tiles) || (cur.type === "IMAGE" && cur.assetId !== (t.node as ImageNode).assetId)) {
      s.notify(tr("image.changed"));
      return null;
    }
    if (cur.type === "RASTER") {
      const { tiles, changed } = imgToTiles(out, src.ox, src.oy, cur.tiles);
      if (!changed) {
        s.notify(tr("image.noChange", { label }));
        return null;
      }
      s.commit(label, (d) => {
        const n = draftPage(d, t.pageId)?.nodes.find((x) => x.id === cur.id);
        if (n && n.type === "RASTER") n.tiles = tiles;
      });
      s.notify(tr("image.appliedTiles", { label, n: changed, ms: Math.round(ms) }));
      return { ms, tiles: changed };
    }
    const bytes = await encodePng(out);
    const orig = s.doc.assets[cur.assetId];
    const base = (orig?.name ?? cur.name).replace(/\.[^.]+$/, "");
    const asset = makeAsset(bytes, "image/png", `${base}.png`);
    s.commit(label, (d) => {
      d.assets[asset.id] = asset;
      const n = draftPage(d, t.pageId)?.nodes.find((x) => x.id === cur.id);
      if (n && n.type === "IMAGE") n.assetId = asset.id;
    });
    s.notify(tr("image.appliedImage", { label, ms: Math.round(ms) }));
    return { ms };
  } catch (e) {
    S().notify(tr("image.failed", { error: e instanceof Error ? e.message : String(e) }));
    return null;
  } finally {
    busy = false;
  }
}

/** Trace the selected raster / image into vector nodes placed right above it (same transform). */
export async function traceSelection(opts: Partial<TraceOptions>, o: { hideSource?: boolean } = {}): Promise<{ paths: number; anchors: number; layers: number; ms: number } | null> {
  const t = imageTarget();
  if (!t) {
    S().notify(tr("image.needTarget"));
    return null;
  }
  try {
    const src = await loadSource(t.node);
    const { value: res, ms } = await runTrace(src.img, opts, { sx: src.sx, sy: src.sy, ox: src.ox, oy: src.oy });
    // the trace took a while: if the source was edited, moved or deleted meanwhile, the paths no longer match it
    const cur = findPage(S().doc, t.pageId)?.nodes.find((n) => n.id === t.node.id);
    if (cur !== t.node) {
      S().notify(tr("image.changed"));
      return null;
    }
    if (!res.paths) {
      S().notify(tr("image.trace.none"));
      return null;
    }
    const fill = opts.fill !== false;
    const nodes: VectorNode[] = res.layers.map((l, i) => {
      const v = newVector(l.contours, tr("image.trace.layerName", { n: i + 1, color: l.color }));
      v.transform = { ...t.node.transform };
      v.fillRule = "evenodd";
      if (fill) {
        v.fill = l.color;
        v.stroke = null;
      } else {
        v.fill = null;
        v.stroke = l.color;
        v.strokeWidth = 1;
      }
      return v;
    });
    const s = S();
    s.commit(tr("image.trace.undo", { n: res.paths }), (d) => {
      const pg = draftPage(d, t.pageId);
      if (!pg) return;
      const at = pg.nodes.findIndex((n) => n.id === t.node.id);
      pg.nodes.splice(at < 0 ? pg.nodes.length : at + 1, 0, ...(nodes as any[]));
      if (o.hideSource) {
        const src = pg.nodes.find((n) => n.id === t.node.id);
        if (src) src.visible = false;
      }
    });
    s.set({ selection: nodes.map((n) => n.id) });
    s.notify(tr("image.trace.done", { colors: res.layers.length, paths: res.paths, anchors: res.anchors, ms: Math.round(ms) }));
    return { paths: res.paths, anchors: res.anchors, layers: res.layers.length, ms };
  } catch (e) {
    S().notify(tr("image.trace.failed", { error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}
