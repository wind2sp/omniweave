// Lossless raster-tile codec for .omw v3 (docs/design/FILE_SIZE.md).
//
// A 256×256 RGBA tile is stored as an ordinary PNG (8-bit RGBA, non-interlaced) — the PNG prediction filters
// (None/Sub/Up/Average/Paeth, chosen per row) followed by deflate (fflate). Every byte, alpha included, comes back
// exactly (no premultiplication, no colour management: the codec never goes through a canvas). The tile's
// Loom address stays the hash of the raw RGBA bytes, so the decoded tile is verified exactly like a v1/v2 `.raw`.
// Being a real PNG, `rasters/<hash>.png` can also be looked at with any image viewer.
// No new dependency: fflate is already used for the zip container.

import { unzlibSync, zlibSync } from "fflate";
import { TILE } from "../core/tile";

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let CRC: Uint32Array | null = null;
function crc32(data: Uint8Array, start: number, end: number): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * PNG-filter 8-bit samples (`bpp` bytes a pixel: 4 RGBA, 3 RGB, 1 grey): per row the filter with the smallest sum of
 * |signed residuals| (libpng's heuristic). The same bytes serve a PDF /Predictor 15 stream.
 */
export function filterRows(px: Uint8Array | Uint8ClampedArray, w: number, h: number, bpp = 4, only?: number): Uint8Array {
  const stride = w * bpp;
  const out = new Uint8Array((stride + 1) * h);
  const cand = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < h; y++) {
    const row = y * stride, prev = row - stride;
    let best = 0, bestSum = Infinity;
    for (let f = only ?? 0; f < (only === undefined ? 5 : only + 1); f++) {
      const c = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = px[row + i];
        const a = i >= bpp ? px[row + i - bpp] : 0;
        const b = y > 0 ? px[prev + i] : 0;
        const cc = i >= bpp && y > 0 ? px[prev + i - bpp] : 0;
        const v = (f === 0 ? x : f === 1 ? x - a : f === 2 ? x - b : f === 3 ? x - ((a + b) >> 1) : x - paeth(a, b, cc)) & 255;
        c[i] = v;
        sum += v < 128 ? v : 256 - v;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    // the winner's row may have stopped early only if it did not win, so cand[best] is complete
    out[y * (stride + 1)] = best;
    out.set(cand[best], y * (stride + 1) + 1);
  }
  return out;
}

/** Undo PNG filtering (filters 0–4) into RGBA. Throws on an unknown filter type. */
export function unfilterRows(raw: Uint8Array, w: number, h: number, out: Uint8Array | Uint8ClampedArray, bpp = 4): void {
  const stride = w * bpp;
  if (raw.length < (stride + 1) * h) throw new Error("tile data too short");
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[row + i - bpp] : 0;
      const b = y > 0 ? out[prev + i] : 0;
      let v: number;
      switch (f) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: v = x + paeth(a, b, i >= bpp && y > 0 ? out[prev + i - bpp] : 0); break;
        default: throw new Error("bad PNG filter");
      }
      out[row + i] = v & 255;
    }
  }
}

/** Encode an RGBA image (a tile: 256×256) as PNG. Deterministic: the same pixels always give the same bytes. */
export function encodeRgbaPng(px: Uint8Array | Uint8ClampedArray, w = TILE, h = TILE, level: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 6): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  // adaptive filters suit photos; flat artwork (brush strokes on transparency) often deflates smaller unfiltered
  const a = zlibSync(filterRows(px, w, h), { level, mem: 8 });
  const b = zlibSync(filterRows(px, w, h, 4, 0), { level, mem: 8 });
  const idat = b.length < a.length ? b : a;
  const parts = [new Uint8Array(SIG), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

/** Decode a PNG written by encodeRgbaPng (8-bit RGBA, no interlace). Returns null for anything else or damage. */
export function decodeRgbaPng(b: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } | null {
  try {
    for (let i = 0; i < 8; i++) if (b[i] !== SIG[i]) return null;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let p = 8, w = 0, h = 0;
    const idat: Uint8Array[] = [];
    while (p + 12 <= b.length) {
      const len = dv.getUint32(p);
      const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
      if (p + 12 + len > b.length) return null;
      if (crc32(b, p + 4, p + 8 + len) !== dv.getUint32(p + 8 + len)) return null;
      const d = b.subarray(p + 8, p + 8 + len);
      if (type === "IHDR") {
        w = dv.getUint32(p + 8);
        h = dv.getUint32(p + 12);
        if (d[8] !== 8 || d[9] !== 6 || d[10] !== 0 || d[11] !== 0 || d[12] !== 0) return null;
      } else if (type === "IDAT") idat.push(d);
      else if (type === "IEND") break;
      p += 12 + len;
    }
    if (!w || !h || !idat.length) return null;
    const z = new Uint8Array(idat.reduce((s, d) => s + d.length, 0));
    let o = 0;
    for (const d of idat) z.set(d, o), (o += d.length);
    const raw = unzlibSync(z);
    const data = new Uint8ClampedArray(w * h * 4);
    unfilterRows(raw, w, h, data);
    return { data, width: w, height: h };
  } catch {
    return null;
  }
}

/** Encode one raster tile. */
export const encodeTile = (data: Uint8Array | Uint8ClampedArray): Uint8Array => encodeRgbaPng(data, TILE, TILE);

/** Decode one raster tile; a damaged or wrong-sized PNG gives an empty array (counted as a corrupt tile). */
export function decodeTile(png: Uint8Array): Uint8ClampedArray {
  const r = decodeRgbaPng(png);
  return r && r.width === TILE && r.height === TILE ? r.data : new Uint8ClampedArray(0);
}
