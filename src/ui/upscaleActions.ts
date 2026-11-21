// "이미지 크기 키우기(업스케일)" on the selected raster layer or picture — one undo step.
//
//  - raster layers (PSD layers too): the painted area is enlarged in place, its top-left corner fixed; the layer gets
//    bigger (a PSD save writes the bigger layer). Crop is scaled with it; a background-removal record is dropped (its
//    matte no longer fits the pixels).
//  - pictures: a new asset in the picture's own format (JPEG stays JPEG, PNG stays PNG, WebP stays WebP; others
//    become PNG) with the original's metadata carried over (core/image/imageMeta.ts); the node keeps its size on the
//    page, so it is simply sharper there. The original asset stays in history, so undo restores it.
//  - `canvas`: when the target covers the whole canvas (an opened picture, a one-layer image), the page grows by the
//    same factor — Photoshop's Image Size.
// Refused (with a notice): adjustment and text layers, CMYK and 32-bit PSD documents (docs/design/IMAGE_UPSCALE.md §3),
// SVG pictures (vectors need no enlarging).

import { getBlob, makeAsset } from "../core/assets";
import { psdColorMode, psdDepth } from "../core/image/cmykComposite";
import { keepJpegMeta, keepPngMeta, keepsProfile } from "../core/image/imageMeta";
import { imgToTiles, newImg, tileBounds, tilesToImg, type Img } from "../core/image/pixels";
import { encodePng } from "../core/image/png";
import { CANCELLED, runSuperResolve, runUpscale } from "../core/image/run";
import { classifySr, type SrDecision } from "../core/image/sr/classify";
import type { SrModelKind } from "../core/image/sr/models";
import { SR_MAX_4X_PIXELS } from "../core/image/sr/pipeline";
import { checkUpscale, scaledSize, type UpscaleMethod } from "../core/image/upscale";
import { ImageOpError } from "../core/image/ops";
import { draftPage, findPage, useStore } from "../core/store";
import { TILE, type ImageNode, type Page } from "../core/types";
import { t as tr } from "../i18n";
import { imageTarget, type ImageTarget } from "./imageActions";

const S = () => useStore.getState();

export interface UpscaleRequest {
  /** factor (2, 3, 4 …) — or an explicit target size */
  scale?: number;
  width?: number;
  height?: number;
  /** "ai": the network (default, 고품질); the others are the classical methods (upscale.ts) */
  method: UpscaleMethod | "ai";
  /** classical: unsharp mask 0..100 */
  sharpen?: number;
  /** classical: noise reduction before enlarging */
  denoise?: boolean;
  keepAlpha?: boolean;
  /** grow the page too (only used when the target covers the whole canvas) */
  canvas?: boolean;
  /** ai: which model ("auto" = classifySr), denoise strength 0..1 and deblocking (undefined = the automatic choice) */
  aiModel?: "auto" | SrModelKind;
  aiDenoise?: number;
  aiDeblock?: boolean;
}

/** The automatic choice for a source picture (shown in the dialog as "자동: …"). */
export function autoChoice(img: Img): SrDecision {
  return classifySr(img);
}

/** The AI path's 4× intermediate fits (else the classical method takes over, with a notice). */
export const aiFits = (w: number, h: number) => w * h * 16 <= SR_MAX_4X_PIXELS;

/** Decoding and encoding of picture files (a canvas in the app; tests put in their own). */
export interface UpscaleCodec {
  /** pixels as stored (no colour conversion, no orientation from metadata other than what the decoder applies) */
  decode(bytes: Uint8Array, mime: string): Promise<Img>;
  /** null when the format cannot be written here (the caller falls back to PNG) */
  encode(img: Img, mime: string): Promise<Uint8Array | null>;
}

async function canvasDecode(bytes: Uint8Array, mime: string): Promise<Img> {
  if (mime === "image/tiff") {
    const { decodeTiff } = await import("../io/formats/tiff");
    const t = decodeTiff(bytes);
    return { width: t.width, height: t.height, data: new Uint8ClampedArray(t.rgba.buffer, t.rgba.byteOffset, t.rgba.byteLength) };
  }
  // colours as stored when the original's colour profile is carried over to the result (JPEG / PNG with an RGB
  // profile or none); otherwise (WebP, AVIF, GIF …, grey / CMYK profiles) converted to sRGB, which the result then is
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }), { colorSpaceConversion: keepsProfile(bytes, mime) ? "none" : "default", premultiplyAlpha: "none" });
  const w = bmp.width, h = bmp.height;
  const c = typeof OffscreenCanvas !== "undefined" ? new OffscreenCanvas(w, h) : Object.assign(document.createElement("canvas"), { width: w, height: h });
  const g = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  return { width: w, height: h, data: g.getImageData(0, 0, w, h).data };
}

async function canvasEncode(img: Img, mime: string): Promise<Uint8Array | null> {
  if (typeof OffscreenCanvas === "undefined" && typeof document === "undefined") return mime === "image/png" ? encodePng(img.data, img.width, img.height, 4) : null;
  const id = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(img.width, img.height);
    (c.getContext("2d") as OffscreenCanvasRenderingContext2D).putImageData(id, 0, 0);
    blob = await c.convertToBlob({ type: mime, quality: 0.95 });
  } else {
    const c = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height });
    c.getContext("2d")!.putImageData(id, 0, 0);
    blob = await new Promise<Blob | null>((r) => c.toBlob(r, mime, 0.95));
  }
  // an engine that cannot write the format hands back PNG
  return blob && blob.type === mime ? new Uint8Array(await blob.arrayBuffer()) : null;
}

let codec: UpscaleCodec = { decode: canvasDecode, encode: canvasEncode };
/** Tests: decode / encode without a canvas. */
export function setUpscaleCodec(c: UpscaleCodec) {
  codec = c;
}

const KEEP_FORMAT = new Set(["image/png", "image/jpeg", "image/webp"]);

function psdOf(page: Page | undefined): Uint8Array | null {
  const id = page?.source?.psd?.assetId;
  const a = id ? S().doc.assets[id] : undefined;
  return (a && getBlob(a.hash)) || null;
}

/** Why the target cannot be enlarged (an i18n text), or null. */
export function upscaleRefusal(t: ImageTarget): string | null {
  const n = t.node;
  if (n.type === "RASTER" && n.adjust) return tr("image.upscale.refuse.adjust");
  if (n.type === "RASTER" && n.psdText) return tr("image.upscale.refuse.text");
  if (n.type === "IMAGE" && /svg/.test(S().doc.assets[n.assetId]?.mime ?? "")) return tr("image.upscale.refuse.svg");
  const psd = psdOf(findPage(S().doc, t.pageId));
  if (psd && psdColorMode(psd) === 4) return tr("image.upscale.refuse.cmyk");
  if (psd && psdDepth(psd) === 32) return tr("image.upscale.refuse.hdr");
  return null;
}

/**
 * A 16-bit source loses its fine steps (Omniweave edits 8-bit pixels): the dialog's notice (i18n key), or null. A
 * 16-bit PSD layer is written back as 16 bits from the 8-bit values; a 16-bit PNG becomes an 8-bit PNG.
 */
export function upscaleDeepNote(t: ImageTarget): string | null {
  const n = t.node;
  if (n.type === "IMAGE") {
    const a = S().doc.assets[n.assetId];
    const b = a?.mime === "image/png" ? getBlob(a.hash) : undefined;
    // IHDR (first chunk) bit depth, byte 24
    return b && b.length > 25 && b[12] === 0x49 && b[13] === 0x48 && b[24] === 16 ? "image.upscale.note16Png" : null;
  }
  const psd = psdOf(findPage(S().doc, t.pageId));
  return psd && psdDepth(psd) === 16 ? "image.upscale.note16" : null;
}

/** Bounding box of the pixels with any alpha; null = nothing painted. */
function paintedBounds(img: Img): { x: number; y: number; w: number; h: number } | null {
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
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export interface UpscaleSource {
  img: Img;
  /** raster: node-local position of the painted area's top-left pixel */
  x: number;
  y: number;
  /** picture: the file and its type */
  bytes?: Uint8Array;
  mime?: string;
}

/** The pixels an upscale works on: a raster layer's painted area, or the whole picture as decoded. */
export async function upscaleSource(t: ImageTarget): Promise<UpscaleSource> {
  const n = t.node;
  if (n.type === "RASTER") {
    const b = tileBounds(n.tiles);
    const full = b ? tilesToImg(n.tiles, b) : null;
    const p = full && paintedBounds(full);
    if (!b || !full || !p) throw new Error(tr("image.err.emptyRaster"));
    const img = newImg(p.w, p.h);
    for (let r = 0; r < p.h; r++) img.data.set(full.data.subarray(((p.y + r) * full.width + p.x) * 4, ((p.y + r) * full.width + p.x + p.w) * 4), r * p.w * 4);
    return { img, x: b.ox + p.x, y: b.oy + p.y };
  }
  const asset = S().doc.assets[n.assetId];
  const bytes = asset ? getBlob(asset.hash) : undefined;
  if (!asset || !bytes) throw new Error(tr("image.err.noSource"));
  return { img: await codec.decode(bytes, asset.mime), x: 0, y: 0, bytes, mime: asset.mime };
}

/** Result size of a request for a w × h source. */
export function upscaleSize(w: number, h: number, r: Pick<UpscaleRequest, "scale" | "width" | "height">): { width: number; height: number } {
  if (r.width && r.height) return { width: Math.round(r.width), height: Math.round(r.height) };
  return scaledSize(w, h, r.scale ?? 2);
}

/** The target fills the canvas from its top-left corner, unturned (an opened picture, a one-layer image). */
export function coversCanvas(t: ImageTarget, src?: Pick<UpscaleSource, "img" | "x" | "y">): boolean {
  const page = findPage(S().doc, t.pageId);
  const n = t.node, tf = n.transform;
  if (!page || page.kind !== "DESIGN" || tf.x !== 0 || tf.y !== 0 || tf.rotation || tf.scale !== 1 || (tf.scaleY !== undefined && tf.scaleY !== 1)) return false;
  if (n.type === "IMAGE") return Math.abs(n.width - page.width) < 0.5 && Math.abs(n.height - page.height) < 0.5 && !n.crop;
  return !!src && src.x === 0 && src.y === 0 && src.img.width === Math.round(page.width) && src.img.height === Math.round(page.height);
}

let busy = false;

/**
 * Enlarge the selected raster / picture. Returns null when nothing was done (no target, refused, cancelled, failed —
 * each with its notice). `onProgress(done, total)` while the worker runs.
 */
export async function applyUpscale(req: UpscaleRequest, onProgress?: (done: number, total: number) => void): Promise<{ ms: number; width: number; height: number } | null> {
  const t = imageTarget();
  if (!t) {
    S().notify(tr("image.needTarget"));
    return null;
  }
  const refusal = upscaleRefusal(t);
  if (refusal) {
    S().notify(refusal);
    return null;
  }
  if (busy) {
    S().notify(tr("image.busy"));
    return null;
  }
  busy = true;
  try {
    const src = await upscaleSource(t);
    const { width: W, height: H } = upscaleSize(src.img.width, src.img.height, req);
    try {
      checkUpscale(src.img.width, src.img.height, W, H);
    } catch (e) {
      throw e instanceof ImageOpError ? new Error(tr(e.code, e.vars)) : e;
    }
    const grow = req.canvas !== false && coversCanvas(t, src);
    let res: { value: Img; ms: number } | null = null;
    if (req.method === "ai" && !aiFits(src.img.width, src.img.height)) S().notify(tr("image.upscale.aiTooLarge"));
    else if (req.method === "ai") {
      const auto = req.aiModel === "auto" || req.aiModel === undefined || req.aiDenoise === undefined || req.aiDeblock === undefined ? classifySr(src.img) : null;
      const model = !req.aiModel || req.aiModel === "auto" ? auto!.content : req.aiModel;
      try {
        res = await runSuperResolve(src.img, { model, denoise: req.aiDenoise ?? auto!.denoise, deblock: req.aiDeblock ?? auto!.deblock, width: W, height: H, keepAlpha: req.keepAlpha }, onProgress);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === CANCELLED) throw e;
        // models missing from this build, or the network failed: the classical method instead
        S().notify(tr("image.upscale.aiFallback", { error: msg }));
      }
    }
    const { value: out, ms } = res ?? (await runUpscale(src.img, { method: req.method === "ai" ? "hq" : req.method, width: W, height: H, sharpen: req.sharpen, denoise: req.denoise, keepAlpha: req.keepAlpha }, onProgress));
    const sx = W / src.img.width, sy = H / src.img.height;
    const s = S();
    const page = findPage(s.doc, t.pageId);
    const cur = page?.nodes.find((n) => n.id === t.node.id);
    if (cur !== t.node) {
      s.notify(tr("image.changed"));
      return null;
    }
    const label = tr("image.upscale.undo", { w: W, h: H });
    const growPage = (pg: Page) => {
      if (!grow) return;
      pg.width = Math.round(pg.width * sx);
      pg.height = Math.round(pg.height * sy);
    };
    if (t.node.type === "RASTER") {
      // tile-aligned frame around the new pixels (top-left of the painted area fixed)
      const T = TILE, ax = Math.floor(src.x / T) * T, ay = Math.floor(src.y / T) * T, dx = src.x - ax, dy = src.y - ay;
      const framed = dx || dy ? newImg(W + dx, H + dy) : out;
      if (framed !== out) for (let r = 0; r < H; r++) framed.data.set(out.data.subarray(r * W * 4, (r + 1) * W * 4), ((dy + r) * (W + dx) + dx) * 4);
      const tiles = imgToTiles(framed, ax, ay, {}).tiles;
      s.commit(label, (d) => {
        const pg = draftPage(d, t.pageId);
        const n = pg?.nodes.find((x) => x.id === t.node.id);
        if (!pg || !n || n.type !== "RASTER") return;
        n.tiles = tiles;
        if (n.crop) n.crop = { x: src.x + (n.crop.x - src.x) * sx, y: src.y + (n.crop.y - src.y) * sy, w: n.crop.w * sx, h: n.crop.h * sy };
        delete n.matte;
        growPage(pg);
      });
    } else {
      const node = t.node as ImageNode;
      const mime = KEEP_FORMAT.has(src.mime ?? "") ? src.mime! : "image/png";
      let bytes = (await codec.encode(out, mime)) ?? null;
      let outMime = mime;
      if (!bytes) {
        outMime = "image/png";
        bytes = (await codec.encode(out, outMime)) ?? encodePng(out.data, W, H, 4);
      }
      if (src.bytes && outMime === "image/jpeg") bytes = keepJpegMeta(src.bytes, bytes, W, H);
      if (src.bytes && outMime === "image/png" && src.mime === "image/png") bytes = keepPngMeta(src.bytes, bytes, sx, sy);
      const orig = s.doc.assets[node.assetId];
      const name = orig?.name ?? node.name;
      const asset = makeAsset(bytes, outMime, outMime === orig?.mime ? name : `${name.replace(/\.[^.]+$/, "")}.png`);
      s.commit(label, (d) => {
        d.assets[asset.id] = asset;
        const pg = draftPage(d, t.pageId);
        const n = pg?.nodes.find((x) => x.id === node.id);
        if (!pg || !n || n.type !== "IMAGE") return;
        n.assetId = asset.id;
        delete n.matte;
        if (grow) {
          n.width = W;
          n.height = H;
          growPage(pg);
        }
      });
    }
    s.notify(tr("image.upscale.done", { w: W, h: H, ms: Math.round(ms) }));
    return { ms, width: W, height: H };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    S().notify(msg === CANCELLED ? tr("image.upscale.cancelled") : tr("image.upscale.failed", { error: msg }));
    return null;
  } finally {
    busy = false;
  }
}

/** The command's state: a target that can be enlarged. */
export function canUpscale(): boolean {
  const t = imageTarget();
  return !!t && !upscaleRefusal(t);
}

