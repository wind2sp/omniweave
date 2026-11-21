// Office Surgeon — ZIP package rewriter.
//
// Copies every entry of the original package byte for byte (local header, compressed data, data descriptor,
// central-directory record) and re-deflates only the entries that changed. Entry order, names, compression,
// dates and extra fields of untouched entries stay as they were; the end record keeps the archive comment.
// Clean-room from the PKWARE APPNOTE ("ZIP File Format Specification").
//
// ZIP64 archives (> 4 GB or > 65 535 entries) are not rewritten: readZip returns null and the caller
// falls back to writing a new package.

import { deflateSync, inflateSync } from "fflate";

export interface ZipEntry {
  name: string;
  /** byte range of the whole local record (header + data + descriptor) in the archive */
  start: number;
  end: number;
  /** central-directory record of this entry (copied, offsets patched) */
  central: Uint8Array;
  method: number;
  flags: number;
  crc: number;
  csize: number;
  usize: number;
  /** DOS time / date fields */
  time: number;
  date: number;
  /** offset of the compressed data */
  dataStart: number;
}

export interface ZipArchive {
  bytes: Uint8Array;
  entries: ZipEntry[];
  /** end-of-central-directory record (with comment) */
  eocd: Uint8Array;
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const w16 = (b: Uint8Array, o: number, v: number) => ((b[o] = v & 255), (b[o + 1] = (v >>> 8) & 255));
const w32 = (b: Uint8Array, o: number, v: number) => {
  b[o] = v & 255;
  b[o + 1] = (v >>> 8) & 255;
  b[o + 2] = (v >>> 16) & 255;
  b[o + 3] = (v >>> 24) & 255;
};

/** A copy (Node Buffer.slice would return a view, and patching it would change the original). */
const copy = (b: Uint8Array, s: number, e: number) => new Uint8Array(b.subarray(s, e));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Entries of a ZIP archive in central-directory order, or null when it is not a plain (non-ZIP64) archive. */
export function readZip(bytes: Uint8Array): ZipArchive | null {
  // end of central directory: 22 bytes + comment (≤ 65 535)
  let eo = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--)
    if (u32(bytes, i) === 0x06054b50 && i + 22 + u16(bytes, i + 20) === bytes.length) {
      eo = i;
      break;
    }
  if (eo < 0) return null;
  if (eo >= 20 && u32(bytes, eo - 20) === 0x07064b50) return null; // ZIP64 locator
  const count = u16(bytes, eo + 10);
  const cdSize = u32(bytes, eo + 12);
  const cdOff = u32(bytes, eo + 16);
  if (u16(bytes, eo + 4) !== 0 || u16(bytes, eo + 8) !== count || cdOff === 0xffffffff || count === 0xffff) return null;
  if (cdOff + cdSize > eo) return null;
  const entries: ZipEntry[] = [];
  // OPC part names are case-insensitive: two entries of one name would be read differently by other programs
  const names = new Set<string>();
  let p = cdOff;
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (u32(bytes, p) !== 0x02014b50) return null;
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const time = u16(bytes, p + 12);
    const date = u16(bytes, p + 14);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nl = u16(bytes, p + 28), el = u16(bytes, p + 30), cl = u16(bytes, p + 32);
    const off = u32(bytes, p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || off === 0xffffffff) return null;
    if (flags & 1) return null; // ZIP-encrypted entry: cannot be read (and is not a valid OPC package)
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
    const key = name.toLowerCase();
    if (names.has(key)) return null;
    names.add(key);
    if (u32(bytes, off) !== 0x04034b50) return null;
    const dataStart = off + 30 + u16(bytes, off + 26) + u16(bytes, off + 28);
    entries.push({ name, start: off, end: 0, central: copy(bytes, p, p + 46 + nl + el + cl), method, flags, crc, csize, usize, time, date, dataStart });
    p += 46 + nl + el + cl;
  }
  // each local record ends where the next one starts (keeps data descriptors and any padding verbatim)
  const byStart = [...entries].sort((a, b) => a.start - b.start);
  byStart.forEach((e, i) => (e.end = i + 1 < byStart.length ? byStart[i + 1].start : cdOff));
  for (const e of entries) if (e.dataStart + e.csize > e.end) return null;
  return { bytes, entries, eocd: copy(bytes, eo, bytes.length) };
}

/** Uncompressed content of one entry. */
export function entryData(z: ZipArchive, e: ZipEntry): Uint8Array {
  const raw = z.bytes.subarray(e.dataStart, e.dataStart + e.csize);
  if (e.method === 0) return new Uint8Array(raw);
  if (e.method === 8) {
    return inflateRaw(raw, e.usize);
  }
  throw new Error(`zip method ${e.method}`);
}

const inflateRaw = (raw: Uint8Array, size: number) => inflateSync(raw, { out: new Uint8Array(size) });

/**
 * The archive with `changed` entries replaced (deflated anew) and `removed` entries left out; every other
 * entry is copied byte for byte, in the original order. New names in `changed` are appended at the end.
 */
export function rewriteZip(z: ZipArchive, changed: Map<string, Uint8Array>, removed: Set<string> = new Set()): Uint8Array {
  const parts: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let pos = 0;
  const enc = new TextEncoder();
  const push = (b: Uint8Array) => (parts.push(b), (pos += b.length));
  const fresh = (name: string, data: Uint8Array, time: number, date: number, flags: number, method: number) => {
    const comp = method === 0 ? data : deflateSync(data, { level: 6 });
    const nb = enc.encode(name);
    const crc = crc32(data);
    const fl = (flags & 0x0800) | (/[^\x00-\x7f]/.test(name) ? 0x0800 : 0); // keep only the UTF-8 name flag
    const lh = new Uint8Array(30 + nb.length);
    w32(lh, 0, 0x04034b50);
    w16(lh, 4, 20);
    w16(lh, 6, fl);
    w16(lh, 8, method);
    w16(lh, 10, time);
    w16(lh, 12, date);
    w32(lh, 14, crc);
    w32(lh, 18, comp.length);
    w32(lh, 22, data.length);
    w16(lh, 26, nb.length);
    w16(lh, 28, 0);
    lh.set(nb, 30);
    const cd = new Uint8Array(46 + nb.length);
    w32(cd, 0, 0x02014b50);
    w16(cd, 4, 20);
    w16(cd, 6, 20);
    w16(cd, 8, fl);
    w16(cd, 10, method);
    w16(cd, 12, time);
    w16(cd, 14, date);
    w32(cd, 16, crc);
    w32(cd, 20, comp.length);
    w32(cd, 24, data.length);
    w16(cd, 28, nb.length);
    w32(cd, 42, pos);
    cd.set(nb, 46);
    centrals.push(cd);
    push(lh);
    push(comp);
  };
  const seen = new Set<string>();
  for (const e of [...z.entries].sort((a, b) => a.start - b.start)) {
    seen.add(e.name);
    if (removed.has(e.name)) continue;
    const data = changed.get(e.name);
    if (data) {
      // a stored entry (e.g. HWPX mimetype) stays stored
      fresh(e.name, data, e.time, e.date, e.flags, e.method === 0 ? 0 : 8);
      continue;
    }
    const cd = new Uint8Array(e.central);
    w32(cd, 42, pos);
    centrals.push(cd);
    push(z.bytes.subarray(e.start, e.end));
  }
  const now = dosNow();
  for (const [name, data] of changed) if (!seen.has(name)) fresh(name, data, now.time, now.date, 0, 8);
  // central directory in the original order (new entries last)
  const order = new Map(z.entries.map((e, i) => [e.name, i]));
  const named = centrals.map((c) => ({ c, name: new TextDecoder().decode(c.subarray(46, 46 + u16(c, 28))) }));
  named.sort((a, b) => (order.get(a.name) ?? 1e9) - (order.get(b.name) ?? 1e9));
  const cdOff = pos;
  for (const { c } of named) push(c);
  const eocd = new Uint8Array(z.eocd);
  w16(eocd, 8, named.length);
  w16(eocd, 10, named.length);
  w32(eocd, 12, pos - cdOff);
  w32(eocd, 16, cdOff);
  push(eocd);
  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) out.set(p, o), (o += p.length);
  return out;
}

function dosNow(): { time: number; date: number } {
  const d = new Date();
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
