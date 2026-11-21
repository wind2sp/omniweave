// Baseline TIFF 6.0 decoder (public Adobe/Aldus specification): strips or tiles, uncompressed,
// LZW, PackBits and Deflate, horizontal predictor, 8/16-bit greyscale, RGB(A), palette and 1-bit.
// First image (IFD 0) only. JPEG-in-TIFF and CCITT fax compressions are reported as unsupported.

import { inflateSync, unzlibSync } from "fflate";
import { t } from "../../i18n";
import { unpackBits } from "./psd";

export interface TiffImage {
  width: number;
  height: number;
  rgba: Uint8Array;
  pages: number;
}

function lzwDecode(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected);
  let op = 0;
  const dict: Uint8Array[] = [];
  const reset = () => {
    dict.length = 0;
    for (let i = 0; i < 256; i++) dict.push(Uint8Array.of(i));
    dict.push(new Uint8Array(0), new Uint8Array(0)); // 256 clear, 257 EOI
  };
  reset();
  let bits = 9;
  let bitPos = 0;
  let prev: Uint8Array | null = null;
  const read = () => {
    let v = 0;
    for (let i = 0; i < bits; i++) {
      const byte = src[(bitPos + i) >> 3];
      if (byte === undefined) return 257;
      v = (v << 1) | ((byte >> (7 - ((bitPos + i) & 7))) & 1);
    }
    bitPos += bits;
    return v;
  };
  while (op < expected) {
    const code = read();
    if (code === 257) break;
    if (code === 256) {
      reset();
      bits = 9;
      prev = null;
      continue;
    }
    let entry: Uint8Array;
    if (code < dict.length) {
      entry = dict[code];
      if (prev) {
        const n = new Uint8Array(prev.length + 1);
        n.set(prev);
        n[prev.length] = entry[0];
        dict.push(n);
      }
    } else if (prev) {
      entry = new Uint8Array(prev.length + 1);
      entry.set(prev);
      entry[prev.length] = prev[0];
      dict.push(entry);
    } else break;
    out.set(entry.subarray(0, Math.min(entry.length, expected - op)), op);
    op += entry.length;
    prev = entry;
    // "early change": the code width grows one code before the table is full
    if (dict.length + 1 >= 1 << bits && bits < 12) bits++;
  }
  return out;
}

export function decodeTiff(b: Uint8Array): TiffImage {
  const le = b[0] === 0x49;
  if (!((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4d && b[1] === 0x4d))) throw new Error(t("engine.tiff.notTiff"));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) === 43) throw new Error(t("engine.tiff.bigTiff"));
  const first = u32(4);
  const tags = new Map<number, number[]>();
  const n = u16(first);
  const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  for (let i = 0; i < n; i++) {
    const e = first + 2 + i * 12;
    const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
    const size = (SIZE[type] ?? 1) * count;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    const vals: number[] = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      if (type === 3 || type === 8) vals.push(u16(at + k * 2));
      else if (type === 4 || type === 9 || type === 13) vals.push(u32(at + k * 4));
      else if (type === 16) vals.push(u32(at + k * 8 + (le ? 0 : 4)));
      else if (type === 5) vals.push(u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
      else vals.push(b[at + k]);
    }
    tags.set(tag, vals);
  }
  let pages = 1;
  for (let next = u32(first + 2 + n * 12); next && pages < 1000 && next < b.length; pages++) next = u32(next + 2 + u16(next) * 12);
  const T = (t: number, d?: number) => tags.get(t)?.[0] ?? d;
  const width = T(256)!, height = T(257)!;
  const bps = tags.get(258) ?? [1];
  const spp = T(277, 1)!;
  const compression = T(259, 1)!;
  const photometric = T(262, spp >= 3 ? 2 : 1)!;
  const planar = T(284, 1)!;
  const predictor = T(317, 1)!;
  const extra = tags.get(338) ?? [];
  const fillOrder = T(266, 1)!;
  if (!width || !height) throw new Error(t("engine.tiff.noSize"));
  if (![1, 5, 8, 32946, 32773].includes(compression)) throw new Error(t("engine.tiff.compression", { code: compression, kind: compression === 7 || compression === 6 ? "(JPEG)" : compression >= 2 && compression <= 4 ? t("engine.tiff.fax") : "" }));
  if (planar === 2 && spp > 1) throw new Error(t("engine.tiff.planar"));
  if (fillOrder === 2) throw new Error(t("engine.tiff.fillOrder"));
  const bits = bps[0];
  if (![1, 4, 8, 16].includes(bits)) throw new Error(t("engine.tiff.bits", { bits }));
  if (photometric === 5 || photometric === 6) throw new Error(t(photometric === 5 ? "engine.tiff.cmyk" : "engine.tiff.ycbcr"));
  const rowBytes = Math.ceil((width * spp * bits) / 8);
  const tiled = tags.has(322);
  const tw = tiled ? T(322)! : width;
  const th = tiled ? T(323)! : T(278, height)!;
  const offsets = tags.get(tiled ? 324 : 273) ?? [];
  const counts = tags.get(tiled ? 325 : 279) ?? [];
  const tileRow = Math.ceil((tw * spp * bits) / 8);
  const raw = new Uint8Array(rowBytes * height);
  const across = Math.ceil(width / tw);
  const decode = (o: number, len: number, want: number): Uint8Array => {
    const src = b.subarray(o, o + len);
    switch (compression) {
      case 1:
        return src;
      case 5:
        return lzwDecode(src, want);
      case 8:
      case 32946:
        try {
          return unzlibSync(src);
        } catch {
          return inflateSync(src);
        }
      case 32773: {
        const out = new Uint8Array(want);
        unpackBits(src, 0, src.length, out, 0, want);
        return out;
      }
    }
    return src;
  };
  offsets.forEach((off, i) => {
    const want = tileRow * th;
    const data = decode(off, counts[i] ?? want, want);
    if (predictor === 2 && bits === 8) {
      for (let y = 0; y < th; y++) for (let x = spp; x < tw * spp; x++) data[y * tileRow + x] = (data[y * tileRow + x] + data[y * tileRow + x - spp]) & 255;
    }
    const tx = tiled ? (i % across) * tw : 0;
    const ty = tiled ? Math.floor(i / across) * th : i * th;
    for (let y = 0; y < th && ty + y < height; y++) {
      const srcRow = data.subarray(y * tileRow, y * tileRow + tileRow);
      const startByte = Math.floor((tx * spp * bits) / 8);
      const copy = Math.min(tileRow, rowBytes - startByte);
      raw.set(srcRow.subarray(0, copy), (ty + y) * rowBytes + startByte);
    }
  });
  const rgba = new Uint8Array(width * height * 4);
  const map = tags.get(320);
  const hasAlpha = extra.length > 0 || (photometric === 2 && spp === 4) || ((photometric === 0 || photometric === 1) && spp === 2);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sample = (c: number): number => {
        const idx = x * spp + c;
        if (bits === 8) return raw[y * rowBytes + idx];
        if (bits === 16) {
          const o = y * rowBytes + idx * 2;
          return le ? raw[o + 1] : raw[o];
        }
        const bitIdx = idx * bits;
        const byte = raw[y * rowBytes + (bitIdx >> 3)];
        const v = (byte >> (8 - bits - (bitIdx & 7))) & ((1 << bits) - 1);
        return bits === 1 ? v * 255 : v * 17;
      };
      const o = (y * width + x) * 4;
      if (photometric === 3 && map) {
        const raw8 = bits === 8 ? raw[y * rowBytes + x] : bits === 4 ? sample(0) / 17 : sample(0) / 255;
        const k = map.length / 3;
        rgba[o] = map[raw8] >> 8;
        rgba[o + 1] = map[k + raw8] >> 8;
        rgba[o + 2] = map[2 * k + raw8] >> 8;
        rgba[o + 3] = 255;
      } else if (photometric === 2) {
        rgba[o] = sample(0);
        rgba[o + 1] = sample(1);
        rgba[o + 2] = sample(2);
        rgba[o + 3] = hasAlpha ? sample(3) : 255;
      } else {
        let v = sample(0);
        if (photometric === 0) v = 255 - v;
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = hasAlpha ? sample(1) : 255;
      }
    }
  return { width, height, rgba, pages };
}
