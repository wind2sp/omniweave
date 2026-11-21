// HWP 5.0 same-format save, stage 3: PrvImage, the picture of the first page 한글 keeps in an HWP file (the file dialog
// of 한글 and Windows Explorer show it). After a text edit the original picture would still show the old text — text
// deleted in the edit would stay readable in the file — so it is written again: the first page as the app draws it
// (when the caller can draw: hwp5Write.ts saveHwp5), else a blank picture (Node, tests) — never the original.
//
// The stored picture's own format is kept: PNG (한글 2010 on writes PNG, 724 × 1024 for A4), BMP or GIF (older 한글).
// Sources: PNG — ./png.ts encodePng; BMP — the Windows BITMAPFILEHEADER / BITMAPINFOHEADER layout (24 bits, rows bottom
// up, padded to 4 bytes); GIF — the GIF89a specification (W3C / CompuServe): a 6 × 6 × 6 colour table and LZW codes kept
// at 9 bits by a clear code every 250 pixels (larger, never wrong). Written from those documents, no other code.

import { encodePng } from "./png";

export type PreviewKind = "png" | "bmp" | "gif";

/** RGBA pixels of a picture. */
export interface Rgba {
  rgba: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

/** The format and size of a stored PrvImage; null when it is none of PNG, BMP, GIF. */
export function previewInfo(b: Uint8Array | undefined): { kind: PreviewKind; width: number; height: number } | null {
  if (!b || b.length < 26) return null;
  const be32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const le16 = (o: number) => b[o] | (b[o + 1] << 8);
  const le32 = (o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { kind: "png", width: be32(16), height: be32(20) };
  if (b[0] === 0x42 && b[1] === 0x4d) return { kind: "bmp", width: le32(18), height: Math.abs(le32(22) | 0) };
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { kind: "gif", width: le16(6), height: le16(8) };
  return null;
}

/** Pixels encoded in `kind`. */
export function encodePreview(kind: PreviewKind, img: Rgba): Uint8Array {
  if (kind === "png") return encodePng(img.rgba, img.width, img.height, 9);
  if (kind === "bmp") return encodeBmp(img);
  return encodeGif(img);
}

/** A white picture `width` × `height` in `kind`. */
export function blankPreview(kind: PreviewKind, width: number, height: number): Uint8Array {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
  return encodePreview(kind, { rgba: new Uint8Array(w * h * 4).fill(255), width: w, height: h });
}

function encodeBmp({ rgba, width: w, height: h }: Rgba): Uint8Array {
  const row = (w * 3 + 3) & ~3;
  const size = 54 + row * h;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  dv.setUint32(2, size, true);
  dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, h, true); // positive: rows bottom up
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 24, true);
  dv.setUint32(34, row * h, true);
  dv.setInt32(38, 2835, true); // 72 dpi
  dv.setInt32(42, 2835, true);
  for (let y = 0; y < h; y++) {
    const o = 54 + (h - 1 - y) * row;
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4, a = rgba[s + 3] / 255;
      // on white where the pixel is see-through
      out[o + x * 3] = Math.round(rgba[s + 2] * a + 255 * (1 - a));
      out[o + x * 3 + 1] = Math.round(rgba[s + 1] * a + 255 * (1 - a));
      out[o + x * 3 + 2] = Math.round(rgba[s] * a + 255 * (1 - a));
    }
  }
  return out;
}

function encodeGif({ rgba, width: w, height: h }: Rgba): Uint8Array {
  const bytes: number[] = [];
  const put16 = (v: number) => bytes.push(v & 255, (v >>> 8) & 255);
  bytes.push(...[0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); // GIF89a
  put16(w);
  put16(h);
  bytes.push(0xf7, 0, 0); // global colour table of 256, 8 bits per primary
  for (let i = 0; i < 256; i++) {
    if (i < 216) bytes.push(Math.floor(i / 36) * 51, (Math.floor(i / 6) % 6) * 51, (i % 6) * 51);
    else bytes.push(255, 255, 255);
  }
  bytes.push(0x2c);
  put16(0);
  put16(0);
  put16(w);
  put16(h);
  bytes.push(0, 8); // no local table; LZW minimum code size 8
  // codes of 9 bits: clear (256), the pixels (a clear again every 250, so the table never needs a 10th bit), end (257)
  const data: number[] = [];
  let acc = 0, nbits = 0;
  const code = (c: number) => {
    acc |= c << nbits;
    nbits += 9;
    while (nbits >= 8) {
      data.push(acc & 255);
      acc >>>= 8;
      nbits -= 8;
    }
  };
  const q = (v: number, a: number) => Math.round((v * a + 255 * (1 - a)) / 51);
  for (let i = 0; i < w * h; i++) {
    if (i % 250 === 0) code(256);
    const a = rgba[i * 4 + 3] / 255;
    code(q(rgba[i * 4], a) * 36 + q(rgba[i * 4 + 1], a) * 6 + q(rgba[i * 4 + 2], a));
  }
  code(257);
  if (nbits) data.push(acc & 255);
  for (let o = 0; o < data.length; o += 255) {
    const n = Math.min(255, data.length - o);
    bytes.push(n);
    for (let k = 0; k < n; k++) bytes.push(data[o + k]);
  }
  bytes.push(0, 0x3b);
  return Uint8Array.from(bytes);
}
