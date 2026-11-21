// The shared picture decode: every picture asset that is drawn (slides, pages, sheets, thumbnails, prints) or exported
// as pixels goes through here. Browsers decode PNG, JPEG, GIF, BMP, WebP …; SVG goes through an <img> (Chromium /
// WebView2 cannot createImageBitmap an SVG Blob) with an explicit intrinsic size so it stays vector at every zoom;
// EMF / WMF metafiles (Office's own picture format) are played into an SVG first (io/formats/metafile.ts) and then
// drawn the same way — the asset keeps the metafile's bytes, so a save writes the original picture back.

import { isMetafileMime, metafileKind } from "../io/formats/metafileSniff";
import { isSvg, svgWithSize } from "./svgSize";

export type DecodedPicture = ImageBitmap | HTMLImageElement;

/** Is this picture a metafile (by its bytes, else its media type)? */
export const isMetafilePicture = (bytes: Uint8Array, mime?: string | null) => !!metafileKind(bytes) || (isMetafileMime(mime) && bytes.length > 0);

/** A metafile picture as SVG text (null when it cannot be played). Cached by the bytes; the player is loaded the
 *  first time a metafile is shown (its own chunk). */
const svgCache = new WeakMap<Uint8Array, string | null>();
export async function metafileSvgText(bytes: Uint8Array): Promise<string | null> {
  if (svgCache.has(bytes)) return svgCache.get(bytes)!;
  let v: string | null = null;
  try {
    const { metafileToSvg } = await import("../io/formats/metafile");
    v = metafileToSvg(bytes)?.svg ?? null;
  } catch {
    v = null;
  }
  svgCache.set(bytes, v);
  return v;
}

async function svgImage(text: string): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(new Blob([svgWithSize(text)], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // the decoded image keeps its pixels; the URL is no longer needed
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/** Decode a picture for drawing on a canvas (`exifIgnored`: the stored pixels, without the EXIF orientation). */
export async function decodePicture(bytes: Uint8Array, mime: string, opts: { exifIgnored?: boolean } = {}): Promise<DecodedPicture> {
  if (typeof Image !== "undefined") {
    if (isMetafilePicture(bytes, mime)) {
      const svg = await metafileSvgText(bytes);
      if (!svg) throw new Error("metafile");
      return svgImage(svg);
    }
    if (isSvg(bytes, mime)) return svgImage(new TextDecoder().decode(bytes));
  }
  const raw = opts.exifIgnored ? withoutExifOrientation(bytes) : bytes;
  return createImageBitmap(new Blob([raw as BlobPart], { type: mime }));
}

/**
 * A JPEG with its EXIF orientation set to 1 ("as stored"), in a copy — browsers turn a picture by that tag (and
 * createImageBitmap's imageOrientation "none" still does in some Chromium versions); Office draws the stored pixels.
 * Other bytes come back as they are.
 */
export function withoutExifOrientation(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  for (let i = 2; i + 4 <= b.length; ) {
    if (b[i] !== 0xff) return b;
    const m = b[i + 1], len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xda || m === 0xd9 || len < 2) return b;
    if (m === 0xe1 && len >= 16 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
      const t = i + 10, end = Math.min(b.length, i + 2 + len);
      const le = b[t] === 0x49;
      const u16 = (o: number) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o: number) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 2 ** 24 : b[o] * 2 ** 24 + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]));
      const ifd = t + u32(t + 4);
      if (ifd + 2 > end) return b;
      const n = u16(ifd);
      for (let k = 0; k < n && ifd + 2 + k * 12 + 12 <= end; k++) {
        const e = ifd + 2 + k * 12;
        if (u16(e) !== 0x0112) continue;
        if (u16(e + 8) === 1) return b;
        const out = b.slice();
        out[e + 8] = le ? 1 : 0;
        out[e + 9] = le ? 0 : 1;
        return out;
      }
      return b;
    }
    i += 2 + len;
  }
  return b;
}

/**
 * A picture as RGBA pixels (PDF export, measurements). Vector pictures (SVG, metafiles) are drawn at `scale` × their
 * intrinsic size, at most `maxSide` px on the longer side.
 */
export async function picturePixels(bytes: Uint8Array, mime: string, scale = 3, maxSide = 4096): Promise<{ data: Uint8ClampedArray; width: number; height: number } | null> {
  if (typeof OffscreenCanvas === "undefined") return null;
  try {
    const pic = await decodePicture(bytes, mime);
    const vector = typeof HTMLImageElement !== "undefined" && pic instanceof HTMLImageElement;
    let w = vector ? (pic as HTMLImageElement).naturalWidth : pic.width, h = vector ? (pic as HTMLImageElement).naturalHeight : pic.height;
    if (vector) {
      const k = Math.min(scale, maxSide / Math.max(w, h, 1));
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
    const c = new OffscreenCanvas(w, h);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(pic, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h);
    if (!vector) (pic as ImageBitmap).close?.();
    return { data: d.data, width: d.width, height: d.height };
  } catch {
    return null;
  }
}
