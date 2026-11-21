// Small PNG writer (pure, fflate deflate): RGBA or 8-bit grey. Used for mattes (grey) and as the cut-out encoder
// where no canvas exists (worker without OffscreenCanvas, tests).

import { zlibSync } from "fflate";
import type { Img } from "./pixels";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** channels: 4 = RGBA (8-bit), 1 = grey (8-bit). Rows use the "Up" filter (good for mattes and smooth photos). */
export function encodePng(pixels: Uint8Array | Uint8ClampedArray, width: number, height: number, channels: 1 | 4): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (stride + 1), s = y * stride;
    raw[o] = 2; // Up
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (pixels[s + x] - (y ? pixels[s - stride + x] : 0)) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 4 ? 6 : 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const q of parts) {
    out.set(q, p);
    p += q.length;
  }
  return out;
}

export const encodePngImg = (img: Img) => encodePng(img.data, img.width, img.height, 4);

/** One PNG chunk (length, type, data, CRC) — used to carry metadata chunks over (imageMeta.ts). */
export { chunk as pngChunk };
