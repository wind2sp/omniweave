// PDF Surgeon — stream filters (ISO 32000-1 §7.4). Decoding only; new streams are written with Flate.
// A filter we cannot decode raises StreamDecodeError so the caller keeps the original bytes untouched.

import { Inflate, Unzlib, zlibSync } from "fflate";
import { t } from "../../i18n";
import { PdfDict, PdfName, type PdfVal } from "./syntax";

export class StreamDecodeError extends Error {}

/**
 * Largest decoded stream we accept. Content streams, fonts and object streams are far smaller; a
 * larger result is a decompression bomb (a few hundred KB can expand to gigabytes).
 */
export const MAX_DECODED = 256 * 1024 * 1024;

const tooBig = () => new StreamDecodeError(t("engine.pdf.edit.streamTooLarge", { mb: MAX_DECODED / 1048576 }));

/** Growable byte buffer with the MAX_DECODED limit. */
class Sink {
  buf = new Uint8Array(1024);
  n = 0;
  private room(k: number) {
    if (this.n + k > MAX_DECODED) throw tooBig();
    if (this.n + k <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.n + k) cap *= 2;
    const nb = new Uint8Array(Math.min(cap, MAX_DECODED));
    nb.set(this.buf.subarray(0, this.n));
    this.buf = nb;
  }
  push(v: number) {
    this.room(1);
    this.buf[this.n++] = v;
  }
  fill(v: number, k: number) {
    this.room(k);
    this.buf.fill(v, this.n, this.n + k);
    this.n += k;
  }
  bytes(src: ArrayLike<number>) {
    this.room(src.length);
    this.buf.set(src, this.n);
    this.n += src.length;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.n);
  }
}

/** Image codecs: the data is kept as-is (we never need to decode pixels to edit content). */
const IMAGE_FILTERS = new Set(["DCTDecode", "DCT", "JPXDecode", "CCITTFaxDecode", "CCF", "JBIG2Decode"]);

export interface FilterSpec {
  name: string;
  parms: PdfDict | null;
}

export function filtersOf(filter: PdfVal | undefined, parms: PdfVal | undefined): FilterSpec[] {
  const names = filter instanceof PdfName ? [filter] : Array.isArray(filter) ? filter.filter((f): f is PdfName => f instanceof PdfName) : [];
  const ps = Array.isArray(parms) ? parms : [parms];
  return names.map((n, i) => ({ name: n.name, parms: ps[i] instanceof PdfDict ? (ps[i] as PdfDict) : null }));
}

export function isImageFilter(name: string) {
  return IMAGE_FILTERS.has(name);
}

export function decodeFilters(data: Uint8Array, filters: FilterSpec[]): Uint8Array {
  let out = data;
  for (const f of filters) {
    switch (f.name) {
      case "FlateDecode":
      case "Fl":
        out = predict(inflate(out), f.parms);
        break;
      case "LZWDecode":
      case "LZW":
        out = predict(lzw(out, earlyChange(f.parms)), f.parms);
        break;
      case "ASCIIHexDecode":
      case "AHx":
        out = asciiHex(out);
        break;
      case "ASCII85Decode":
      case "A85":
        out = ascii85(out);
        break;
      case "RunLengthDecode":
      case "RL":
        out = runLength(out);
        break;
      case "Crypt":
        break; // identity crypt filter; real decryption happens before filters
      default:
        throw new StreamDecodeError(t("engine.pdf.edit.filterUnsupported", { name: f.name }));
    }
  }
  return out;
}

/** Streaming inflate that stops as soon as the output passes MAX_DECODED. */
function inflateBounded(data: Uint8Array, zlib: boolean): Uint8Array {
  const sink = new Sink();
  const ondata = (chunk: Uint8Array) => sink.bytes(chunk);
  const s = zlib ? new Unzlib(ondata) : new Inflate(ondata);
  // feed in slices so a bomb is caught after a bounded amount of output, not after expanding it all
  const STEP = 64 * 1024;
  for (let i = 0; i < data.length; i += STEP) s.push(data.subarray(i, Math.min(data.length, i + STEP)), i + STEP >= data.length);
  return sink.done();
}

export function inflate(data: Uint8Array): Uint8Array {
  if (!data.length) return data;
  try {
    return inflateBounded(data, true);
  } catch (e0) {
    if (e0 instanceof StreamDecodeError) throw e0;
    try {
      // some producers omit or damage the zlib header, or cut the Adler-32 trailer short (Illustrator files saved
      // without PDF content: header 0x48 0x89, one trailer byte — pdf.js reads them): raw deflate after any valid
      // zlib header (CM 8, header check), not only the common 0x78
      const zlibHeader = data.length > 2 && (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
      return inflateBounded(zlibHeader ? data.subarray(2) : data, false);
    } catch (e) {
      if (e instanceof StreamDecodeError) throw e;
      throw new StreamDecodeError(t("engine.pdf.edit.flateFailed", { error: (e as Error).message }));
    }
  }
}

export function deflate(data: Uint8Array): Uint8Array {
  return zlibSync(data, { level: 6 });
}

const intParm = (p: PdfDict | null, k: string, d: number) => {
  const v = p?.get(k);
  return typeof v === "number" ? v : d;
};
const earlyChange = (p: PdfDict | null) => intParm(p, "EarlyChange", 1);

function predict(data: Uint8Array, p: PdfDict | null): Uint8Array {
  const pred = intParm(p, "Predictor", 1);
  if (pred <= 1) return data;
  const colors = intParm(p, "Colors", 1), bpc = intParm(p, "BitsPerComponent", 8), cols = intParm(p, "Columns", 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((colors * bpc * cols) / 8);
  // parameters come from the file: a row longer than the data (or nonsense) cannot be decoded
  if (!(rowLen >= 1 && bpp <= rowLen)) throw new StreamDecodeError(t("engine.pdf.edit.badPredictor"));
  if (rowLen > data.length) return new Uint8Array(0);
  if (pred === 2) {
    if (bpc !== 8) throw new StreamDecodeError(t("engine.pdf.edit.tiffPredictor"));
    const out = data.slice();
    for (let r = 0; r + rowLen <= out.length; r += rowLen) for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    return out;
  }
  // PNG predictors: each row starts with a filter-type byte
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const t = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const row = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      if (t === 1) v += a;
      else if (t === 2) v += b;
      else if (t === 3) v += (a + b) >> 1;
      else if (t === 4) {
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v & 0xff;
    }
    prev.set(row);
  }
  return out;
}

function asciiHex(data: Uint8Array): Uint8Array {
  const out = new Sink();
  let hi = -1;
  for (const c of data) {
    if (c === 0x3e) break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else (out.push((hi << 4) | v), (hi = -1));
  }
  if (hi >= 0) out.push(hi << 4);
  return out.done();
}

function ascii85(data: Uint8Array): Uint8Array {
  const out = new Sink();
  const group: number[] = [];
  const flush = (n: number) => {
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const g of group) v = v * 85 + g;
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.bytes(bytes.slice(0, n));
    group.length = 0;
  };
  let i = data[0] === 0x3c && data[1] === 0x7e ? 2 : 0;
  for (; i < data.length; i++) {
    const c = data[i];
    if (c === 0x7e) break;
    if (c === 0x7a && group.length === 0) {
      out.fill(0, 4);
      continue;
    }
    if (c < 33 || c > 117) continue;
    group.push(c - 33);
    if (group.length === 5) flush(4);
  }
  if (group.length > 1) flush(group.length - 1);
  return out.done();
}

function runLength(data: Uint8Array): Uint8Array {
  const out = new Sink();
  for (let i = 0; i < data.length; ) {
    const n = data[i++];
    if (n === 128) break;
    if (n < 128) {
      const k = Math.min(n + 1, data.length - i);
      out.bytes(data.subarray(i, i + k));
      i += k;
    } else {
      if (i >= data.length) break;
      out.fill(data[i++], 257 - n);
    }
  }
  return out.done();
}

function lzw(data: Uint8Array, early: number): Uint8Array {
  const out = new Sink();
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push([], []);
  };
  reset();
  let bits = 9, buf = 0, nbuf = 0, prev: number[] | null = null;
  for (let i = 0; i < data.length; i++) {
    buf = (buf << 8) | data[i];
    nbuf += 8;
    while (nbuf >= bits) {
      const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1);
      nbuf -= bits;
      if (code === 256) {
        reset();
        bits = 9;
        prev = null;
        continue;
      }
      if (code === 257) return out.done();
      let entry: number[];
      if (code < dict.length) entry = dict[code];
      else if (prev) entry = [...prev, prev[0]];
      else throw new StreamDecodeError(t("engine.pdf.edit.lzwDamaged"));
      out.bytes(entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= 1 << bits && bits < 12) bits++;
    }
  }
  return out.done();
}
