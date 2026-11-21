// Quick image tools (browser/WebView canvas codecs) and PDF → JPG rendering with pdf.js.
// Pure helpers at the top are Node-testable; the codec functions need a DOM.

import { zipSync, type Zippable } from "fflate";
import { imageMime, isHeic } from "../formats/sniff";
import { t } from "../../i18n";
import type { ImageRecompressor, Progress } from "./pdfTools";

export type OutFormat = "jpeg" | "png" | "webp";

export const EXT: Record<OutFormat, string> = { jpeg: "jpg", png: "png", webp: "webp" };

export function outName(name: string, fmt: OutFormat, suffix = ""): string {
  return name.replace(/\.[^.]+$/, "") + suffix + "." + EXT[fmt];
}

/** Make names unique inside a zip ("a.jpg", "a (2).jpg"). */
export function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const c = (seen.get(k) ?? 0) + 1;
    seen.set(k, c);
    return c === 1 ? n : n.replace(/(\.[^.]+)?$/, ` (${c})$1`);
  });
}

export function zipFiles(files: { name: string; bytes: Uint8Array }[]): Uint8Array {
  const z: Zippable = {};
  const names = uniqueNames(files.map((f) => f.name));
  files.forEach((f, i) => (z[names[i]] = [f.bytes, { level: /\.(jpe?g|png|webp|gif|pdf|zip)$/i.test(names[i]) ? 0 : 6 }]));
  return zipSync(z);
}

export function sniffMime(bytes: Uint8Array, name: string): string {
  const m = imageMime(bytes);
  if (m) return m;
  const ext = name.split(".").pop()!.toLowerCase();
  return ext === "jpg" ? "image/jpeg" : `image/${ext}`;
}

// ───────── browser codecs ─────────


export async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap> {
  if (isHeic(bytes)) throw new Error(t("engine.tools.heic"));
  if (mime === "image/tiff") {
    const { decodeTiff } = await import("../formats/tiff");
    const t = decodeTiff(bytes);
    return createImageBitmap(new ImageData(new Uint8ClampedArray(t.rgba.buffer, t.rgba.byteOffset, t.rgba.byteLength), t.width, t.height));
  }
  try {
    return await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
  } catch {
    throw new Error(t("engine.tools.imageDecode", { mime }));
  }
}

export async function encodeBitmap(src: CanvasImageSource & { width: number; height: number }, fmt: OutFormat, quality: number, maxDim = 0, background = "#ffffff"): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  let w = src.width, h = src.height;
  if (maxDim > 0 && Math.max(w, h) > maxDim) {
    const k = maxDim / Math.max(w, h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
  }
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  if (fmt === "jpeg") {
    // JPEG has no alpha: flatten onto white instead of the default black
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(src, 0, 0, w, h);
  const type = fmt === "jpeg" ? "image/jpeg" : fmt === "png" ? "image/png" : "image/webp";
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, type, quality));
  if (!blob) throw new Error(t("engine.tools.encodeFailed"));
  if (blob.type !== type) throw new Error(t("engine.tools.formatUnsupported", { fmt: fmt.toUpperCase() }));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

export async function compressImage(bytes: Uint8Array, name: string, opts: { quality: number; format: OutFormat | "same"; maxDim: number }): Promise<{ bytes: Uint8Array; name: string; before: number; after: number; kept: boolean }> {
  const mime = sniffMime(bytes, name);
  const bmp = await decodeImage(bytes, mime);
  const fmt: OutFormat = opts.format !== "same" ? opts.format : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpeg";
  const r = await encodeBitmap(bmp, fmt, opts.quality, opts.maxDim);
  bmp.close();
  // never hand back a bigger file when the format is unchanged
  const sameFmt = (fmt === "jpeg" && mime === "image/jpeg") || (fmt === "png" && mime === "image/png") || (fmt === "webp" && mime === "image/webp");
  // "keep the format" never returns a bigger file (AVIF/GIF sources become JPG only when that is smaller)
  const kept = (sameFmt || opts.format === "same") && r.bytes.length >= bytes.length;
  return { bytes: kept ? bytes : r.bytes, name: kept ? name : outName(name, fmt), before: bytes.length, after: kept ? bytes.length : r.bytes.length, kept };
}

export async function toJpg(bytes: Uint8Array, name: string, quality: number): Promise<{ bytes: Uint8Array; name: string }> {
  const mime = sniffMime(bytes, name);
  const bmp = await decodeImage(bytes, mime);
  const r = await encodeBitmap(bmp, "jpeg", quality);
  bmp.close();
  return { bytes: r.bytes, name: outName(name, "jpeg") };
}

/** Canvas-based JPEG re-encoder for compressPdf. */
export const canvasRecompressor: ImageRecompressor = async (input, quality, maxDim) => {
  let src: ImageBitmap;
  if (input.kind === "jpeg") src = await createImageBitmap(new Blob([input.bytes as BlobPart], { type: "image/jpeg" }));
  else {
    const rgba = new Uint8ClampedArray(input.width * input.height * 4);
    for (let i = 0; i < input.width * input.height; i++) {
      if (input.channels === 3) {
        rgba[i * 4] = input.pixels[i * 3];
        rgba[i * 4 + 1] = input.pixels[i * 3 + 1];
        rgba[i * 4 + 2] = input.pixels[i * 3 + 2];
      } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = input.pixels[i];
      rgba[i * 4 + 3] = 255;
    }
    src = await createImageBitmap(new ImageData(rgba, input.width, input.height));
  }
  const r = await encodeBitmap(src, "jpeg", quality, maxDim);
  src.close();
  return r;
};

/** Render every page of a PDF to JPEG at `dpi` (72 = 1:1 points). */
export async function pdfToJpgs(bytes: Uint8Array, name: string, opts: { dpi: number; quality: number; onProgress?: Progress }): Promise<{ name: string; bytes: Uint8Array }[]> {
  const pdfjs = await (await import("../pdfjsLoader")).pdfjsLib();
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out: { name: string; bytes: Uint8Array }[] = [];
  const pad = String(doc.numPages).length;
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      opts.onProgress?.(i - 1, doc.numPages, t("engine.tools.pageProgress", { page: i }));
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: opts.dpi / 72 });
      const c = document.createElement("canvas");
      c.width = Math.ceil(vp.width);
      c.height = Math.ceil(vp.height);
      if (c.width * c.height > 268_000_000) throw new Error(t("engine.tools.pageTooLarge", { page: i }));
      const ctx = c.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", opts.quality));
      if (!blob) throw new Error(t("engine.tools.jpgFailed"));
      out.push({ name: `${name.replace(/\.[^.]+$/, "")}-${String(i).padStart(pad, "0")}.jpg`, bytes: new Uint8Array(await blob.arrayBuffer()) });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  opts.onProgress?.(doc.numPages, doc.numPages);
  return out;
}
