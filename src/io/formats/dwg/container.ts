// DWG container layer (stage 2 groundwork, docs/design/CAD_IMPORT.md §6): file version, the R13–R2000 section
// locator table, and for R2004 / 2010 / 2013 / 2018 (AC1018 / AC1024 / AC1027 / AC1032) the encrypted file header,
// the section page map and the section map, with the format's LZ77 variant. Written from the Open Design Alliance's
// public "Open Design Specification for .dwg files" (chapters 3–4); no code from other DWG readers.
// The object stream reader (entities → CadDrawing) is the next stage; it builds on this and on bits.ts.

import { RELEASES } from "../cad/model";

export interface DwgSectionPage {
  /** page number in the page map */
  page: number;
  /** compressed size in the file */
  size: number;
  /** offset of the page's data in the section */
  offset: number;
  /** R2007: compressed and decompressed size of the page's data */
  csize?: number;
  usize?: number;
}

export interface DwgSection {
  name: string;
  /** decompressed size of the whole section */
  size: number;
  /** R2004+: 2 = compressed */
  compressed?: number;
  /** R2004+: decompressed size of one page */
  pageSize?: number;
  encrypted?: number;
  pages?: DwgSectionPage[];
  /** R2000: file offset and size of the section */
  seeker?: number;
  /** R2007: 1 = Reed–Solomon (255, 251) interleaved pages, 4 = stored as they are */
  encoded?: number;
}

export interface DwgInfo {
  version: string;
  release: string;
  /** maintenance release number */
  maintenance: number;
  /** code page index from the file header */
  codepage: number;
  sections: DwgSection[];
  /** R2004+: page number → file address */
  pageAddress?: Map<number, number>;
  /** what could not be read (the container is still reported as far as it went) */
  problems: string[];
}

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n));

export const isDwg = (b: Uint8Array) => b.length > 0x80 && /^AC10(0\d|1[0-9]|2[0-9]|3[0-9])$/.test(ascii(b, 0, 6));

const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const i32 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** R2004 file header block at 0x80 is XOR'ed with a linear congruential byte sequence (seed 1). */
export function decryptHeader(enc: Uint8Array): Uint8Array {
  const out = new Uint8Array(enc.length);
  let seed = 1;
  for (let i = 0; i < enc.length; i++) {
    seed = (Math.imul(seed, 0x343fd) + 0x269ec3) >>> 0;
    out[i] = enc[i] ^ ((seed >>> 16) & 0xff);
  }
  return out;
}

/**
 * The DWG 2004 LZ77 variant: literal runs and back-references with 1–3 trailing literals packed into the
 * offset bytes; opcode 0x11 ends the stream.
 */
export function decompressDwg(src: Uint8Array, outSize: number): Uint8Array {
  const dst = new Uint8Array(outSize);
  let si = 0, di = 0;
  const rd = () => {
    if (si >= src.length) throw new Error("DWG_LZ_TRUNCATED");
    return src[si++];
  };
  const literalLength = (op: number) => {
    let n = op & 0x0f;
    if (n === 0) {
      n = 0x0f;
      let b = rd();
      while (b === 0) {
        n += 0xff;
        b = rd();
      }
      n += b;
    }
    return n + 3;
  };
  const longCount = () => {
    let n = 0;
    let b = rd();
    while (b === 0) {
      n += 0xff;
      b = rd();
    }
    return n + b;
  };
  const copyLiteral = (n: number) => {
    for (let i = 0; i < n; i++) {
      if (di >= outSize) throw new Error("DWG_LZ_OVERFLOW");
      dst[di++] = rd();
    }
  };
  let op = rd();
  if ((op & 0xf0) === 0) {
    copyLiteral(literalLength(op));
    op = rd();
  }
  for (;;) {
    let count: number, offset: number, lit: number;
    if (op === 0x11) break;
    if (op === 0x10 || (op >= 0x12 && op <= 0x1f) || op === 0x20 || (op >= 0x21 && op <= 0x3f)) {
      count = op === 0x10 ? longCount() + 9 : op <= 0x1f ? (op & 0x0f) + 2 : op === 0x20 ? longCount() + 0x21 : op - 0x1e;
      const b1 = rd(), b2 = rd();
      offset = ((b1 >> 2) | (b2 << 6)) + (op <= 0x1f ? 0x3fff : 0);
      lit = b1 & 3;
    } else if (op >= 0x40) {
      count = ((op & 0xf0) >> 4) - 1;
      const b2 = rd();
      offset = (b2 << 2) | ((op & 0x0c) >> 2);
      lit = op & 3;
    } else throw new Error("DWG_LZ_OPCODE");
    const from = di - offset - 1;
    if (from < 0) throw new Error("DWG_LZ_OFFSET");
    for (let i = 0; i < count; i++) {
      if (di >= outSize) throw new Error("DWG_LZ_OVERFLOW");
      dst[di++] = dst[from + i];
    }
    if (lit === 0) {
      op = rd();
      if ((op & 0xf0) === 0) {
        copyLiteral(literalLength(op));
        op = rd();
      }
    } else {
      copyLiteral(lit);
      op = rd();
    }
  }
  return di === outSize ? dst : dst.subarray(0, di);
}

const R2000_NAMES = ["Header", "Classes", "ObjectMap", "Unknown3", "Template", "AuxHeader"];

function readR2000(b: Uint8Array, info: DwgInfo) {
  const n = u32(b, 0x15);
  if (n > 16) return void info.problems.push("DWG_LOCATORS");
  for (let i = 0; i < n; i++) {
    const o = 0x19 + i * 9;
    const num = b[o];
    info.sections.push({ name: R2000_NAMES[num] ?? `Section${num}`, seeker: u32(b, o + 1), size: u32(b, o + 5) });
  }
}

/** System page (page map / section map): 20-byte header, then LZ77 data. */
function systemPage(b: Uint8Array, at: number, type: number): Uint8Array {
  if (at + 20 > b.length) throw new Error("DWG_PAGE_BOUNDS");
  if (u32(b, at) !== type) throw new Error("DWG_PAGE_TYPE");
  const dsize = u32(b, at + 4), csize = u32(b, at + 8), comp = u32(b, at + 12);
  const data = b.subarray(at + 20, at + 20 + csize);
  return comp === 2 ? decompressDwg(data, dsize) : data.slice(0, dsize);
}

function readR2004(b: Uint8Array, info: DwgInfo) {
  const h = decryptHeader(b.subarray(0x80, 0x80 + 0x6c));
  if (ascii(h, 0, 11) !== "AcFssFcAJMB") return void info.problems.push("DWG_HEADER_ID");
  const pageMapAddr = u64(h, 0x54) + 0x100;
  const sectionMapId = u32(h, 0x5c);
  // page map: (page number, size) pairs; pages follow each other from 0x100; negative numbers are gaps
  const pm = systemPage(b, pageMapAddr, 0x41630e3b);
  const addr = new Map<number, number>();
  let a = 0x100;
  for (let o = 0; o + 8 <= pm.length; ) {
    const num = i32(pm, o), size = u32(pm, o + 4);
    o += 8;
    if (num < 0) o += 16;
    else addr.set(num, a);
    a += size;
  }
  info.pageAddress = addr;
  const smAt = addr.get(sectionMapId);
  if (smAt === undefined) return void info.problems.push("DWG_SECTION_MAP");
  const sm = systemPage(b, smAt, 0x4163003b);
  const count = u32(sm, 0);
  let o = 20;
  for (let i = 0; i < count && o + 96 <= sm.length; i++) {
    const size = u64(sm, o);
    const pages = u32(sm, o + 8);
    const pageSize = u32(sm, o + 12);
    const compressed = u32(sm, o + 20);
    const encrypted = u32(sm, o + 28);
    const name = ascii(sm, o + 32, 64).replace(/\0.*$/, "");
    o += 96;
    const list: DwgSectionPage[] = [];
    for (let p = 0; p < pages && o + 16 <= sm.length; p++) {
      list.push({ page: u32(sm, o), size: u32(sm, o + 4), offset: u64(sm, o + 8) });
      o += 16;
    }
    info.sections.push({ name, size, compressed, encrypted, pageSize, pages: list });
  }
}

/**
 * The bytes of one named section (R2004 family: "AcDb:Header", "AcDb:Classes", "AcDb:Handles", "AcDb:AcDbObjects" …).
 * Each data page has a 32-byte header XOR'ed with 0x4164536B ^ its file address (page type 0x4163043B, section number,
 * compressed size, decompressed size, start offset, checksums), then its LZ77 data, decompressed at its offset.
 */
export function sectionData(b: Uint8Array, info: DwgInfo, name: string): Uint8Array | null {
  const sec = info.sections.find((s) => s.name === name);
  if (!sec || !sec.pages || !info.pageAddress) return null;
  if (info.version === "AC1021") return sectionData2007(b, info, sec);
  const out = new Uint8Array(sec.size);
  for (const pg of sec.pages) {
    const at = info.pageAddress.get(pg.page);
    if (at === undefined || at + 32 > b.length) throw new Error("DWG_PAGE_MISSING");
    const mask = (0x4164536b ^ at) >>> 0;
    const h = new Uint8Array(32);
    for (let i = 0; i < 32; i += 4) {
      const v = (u32(b, at + i) ^ mask) >>> 0;
      h[i] = v & 0xff;
      h[i + 1] = (v >>> 8) & 0xff;
      h[i + 2] = (v >>> 16) & 0xff;
      h[i + 3] = v >>> 24;
    }
    if (u32(h, 0) !== 0x4163043b) throw new Error("DWG_DATA_PAGE");
    const csize = u32(h, 8), dsize = u32(h, 12);
    const data = b.subarray(at + 32, at + 32 + csize);
    const page = sec.compressed === 2 ? decompressDwg(data, sec.pageSize || dsize) : data;
    out.set(page.subarray(0, Math.min(page.length, out.length - pg.offset)), pg.offset);
  }
  return out;
}

// ---- R2007 (AC1021) -------------------------------------------------------------------------------------------
// Written from the public specification's chapter on the R2007 layout: the file header, the page map and the section
// map are Reed–Solomon (255, k) blocks stored interleaved; the data is compressed with the R21 LZ variant, whose
// literal runs keep their bytes in a shuffled order. Only the interleaving is undone — the parity bytes are not
// needed for a sound file and are not checked.

/** Undo the interleaving of `blocks` Reed–Solomon blocks: byte j of block i is stored at i + j × blocks. */
export function deinterleave(src: Uint8Array, blocks: number, k: number): Uint8Array {
  const out = new Uint8Array(blocks * k);
  for (let i = 0; i < blocks; i++) for (let j = 0; j < k; j++) out[i * k + j] = src[i + j * blocks] ?? 0;
  return out;
}

/**
 * Literal runs of the R21 compressor are stored in a shuffled order: whole runs of 32 bytes have their four 8-byte
 * parts in reverse order, and the rest (1–31 bytes) is a reversal of parts of 1, 2, 4 and 8 bytes. Each entry lists
 * the parts of one length as (start in the source, size), in the order they are written; parts of 2 and 3 bytes are
 * themselves reversed, 4 and 8 are kept, 16 is two 8-byte parts swapped.
 */
const R21_TAIL: [number, number][][] = [
  [],
  [[0, 1]],
  [[0, 2]],
  [[0, 3]],
  [[0, 4]],
  [[4, 1], [0, 4]],
  [[5, 1], [1, 4], [0, 1]],
  [[5, 2], [1, 4], [0, 1]],
  [[0, 8]],
  [[8, 1], [0, 8]],
  [[9, 1], [1, 8], [0, 1]],
  [[9, 2], [1, 8], [0, 1]],
  [[8, 4], [0, 8]],
  [[12, 1], [8, 4], [0, 8]],
  [[13, 1], [9, 4], [1, 8], [0, 1]],
  [[13, 2], [9, 4], [1, 8], [0, 1]],
  [[0, 16]],
  [[9, 8], [8, 1], [0, 8]],
  [[17, 1], [1, 16], [0, 1]],
  [[16, 3], [0, 16]],
  [[16, 4], [0, 16]],
  [[20, 1], [16, 4], [0, 16]],
  [[20, 2], [16, 4], [0, 16]],
  [[20, 3], [16, 4], [0, 16]],
  [[16, 8], [0, 16]],
  [[17, 8], [16, 1], [0, 16]],
  [[25, 1], [17, 8], [16, 1], [0, 16]],
  [[25, 2], [17, 8], [16, 1], [0, 16]],
  [[24, 4], [16, 8], [8, 8], [0, 8]],
  [[28, 1], [24, 4], [16, 8], [8, 8], [0, 8]],
  [[28, 2], [24, 4], [16, 8], [8, 8], [0, 8]],
  [[30, 1], [26, 4], [18, 8], [10, 8], [2, 8], [0, 2]],
];

function r21Literal(dst: Uint8Array, di: number, src: Uint8Array, si: number, n: number) {
  if (di + n > dst.length || si + n > src.length) throw new Error("DWG_LZ_OVERFLOW");
  while (n >= 32) {
    for (let q = 0; q < 4; q++) dst.set(src.subarray(si + 24 - q * 8, si + 32 - q * 8), di + q * 8);
    si += 32;
    di += 32;
    n -= 32;
  }
  for (const [at, size] of R21_TAIL[n]) {
    const from = si + at;
    if (size === 2 || size === 3) for (let i = size - 1; i >= 0; i--) dst[di++] = src[from + i];
    else if (size === 16) {
      dst.set(src.subarray(from + 8, from + 16), di);
      dst.set(src.subarray(from, from + 8), di + 8);
      di += 16;
    } else {
      dst.set(src.subarray(from, from + size), di);
      di += size;
    }
  }
}

/** The R21 LZ variant of DWG 2007 (literal lengths, 4 back-reference forms; R21_TAIL gives the literal order). */
export function decompressR21(src: Uint8Array, outSize: number): Uint8Array {
  const dst = new Uint8Array(outSize);
  let si = 0, di = 0;
  const rd = () => {
    if (si >= src.length) throw new Error("DWG_LZ_TRUNCATED");
    return src[si++];
  };
  let op = rd();
  let length = 0, offset = 0;
  const literalLength = (o: number) => {
    let n = o + 8;
    if (n === 0x17) {
      let v = rd();
      n += v;
      if (v === 0xff)
        do {
          v = rd() | (rd() << 8);
          n += v;
        } while (v === 0xffff);
    }
    return n;
  };
  const instruction = () => {
    switch (op >> 4) {
      case 0:
        length = (op & 0x0f) + 0x13;
        offset = rd();
        op = rd();
        length += (op >> 3) & 0x10;
        offset += ((op & 0x78) << 5) + 1;
        break;
      case 1:
        length = (op & 0x0f) + 3;
        offset = rd();
        op = rd();
        offset += ((op & 0xf8) << 5) + 1;
        break;
      case 2: {
        offset = rd();
        offset |= (rd() << 8) & 0xff00;
        length = op & 7;
        if ((op & 8) === 0) {
          op = rd();
          length += op & 0xf8;
        } else {
          offset++;
          length += rd() << 3;
          op = rd();
          length += ((op & 0xf8) << 8) + 0x100;
        }
        break;
      }
      default:
        length = op >> 4;
        offset = op & 0x0f;
        op = rd();
        offset += ((op & 0xf8) << 1) + 1;
    }
  };
  if ((op & 0xf0) === 0x20) {
    si += 2;
    length = rd() & 7;
    if (!length) throw new Error("DWG_LZ_OPCODE");
  }
  while (si < src.length) {
    if (!length) length = literalLength(op);
    r21Literal(dst, di, src, si, length);
    di += length;
    si += length;
    length = 0;
    if (si >= src.length) break;
    op = rd();
    instruction();
    for (;;) {
      const from = di - offset;
      if (from < 0) throw new Error("DWG_LZ_OFFSET");
      if (di + length > outSize) throw new Error("DWG_LZ_OVERFLOW");
      for (let i = 0; i < length; i++) dst[di++] = dst[from + i];
      length = op & 7;
      if (length || si >= src.length) break;
      op = rd();
      if (op >> 4 === 0) break;
      if (op >> 4 === 0x0f) op &= 0x0f;
      instruction();
    }
  }
  return di === outSize ? dst : dst.subarray(0, di);
}

/** A system page (page map, section map): Reed–Solomon (255, 239) blocks, the data repeated `copies` times, compressed. */
function r21SystemPage(b: Uint8Array, at: number, csize: number, usize: number, copies: number): Uint8Array {
  const encoded = ((csize + 7) & ~7) * Math.max(1, copies);
  const blocks = Math.ceil(encoded / 239);
  const size = (blocks * 255 + 7) & ~7;
  if (at + size > b.length) throw new Error("DWG_PAGE_BOUNDS");
  const data = deinterleave(b.subarray(at, at + size), blocks, 239);
  return csize < usize ? decompressR21(data.subarray(0, csize), usize) : data.slice(0, usize);
}

function readR2007(b: Uint8Array, info: DwgInfo) {
  // file header: 3 interleaved Reed–Solomon (255, 239) blocks at 0x80 — 32 bytes of checks and sizes, then 0x110 bytes
  const fh = deinterleave(b.subarray(0x80, 0x80 + 0x3d8), 3, 239);
  const clen = i32(fh, 24);
  const hdr = clen < 0 ? fh.slice(32, 32 - clen) : decompressR21(fh.subarray(32, 32 + clen), 0x110);
  const q = (i: number) => u64(hdr, i * 8);
  const pmCopies = q(3), pmOffset = q(7), pmCsize = q(10), pmUsize = q(11);
  const smCsize = q(22), smId = q(24), smUsize = q(25), smCopies = q(27);
  // page map: (size, id) pairs; pages follow each other from 0x480
  const pm = r21SystemPage(b, pmOffset + 0x480, pmCsize, pmUsize, pmCopies);
  const addr = new Map<number, number>();
  let a = 0x480;
  for (let o = 0; o + 16 <= pm.length; o += 16) {
    const size = u64(pm, o);
    const id = i32(pm, o + 8);
    addr.set(Math.abs(id), a);
    a += size;
  }
  info.pageAddress = addr;
  const smAt = addr.get(smId);
  if (smAt === undefined) return void info.problems.push("DWG_SECTION_MAP");
  const sm = r21SystemPage(b, smAt, smCsize, smUsize, smCopies);
  // sections: size, page size, encryption, hash, name length (bytes), -, encoding, page count, UTF-16 name, pages
  for (let o = 0; o + 64 <= sm.length; ) {
    const size = u64(sm, o);
    const pageSize = u64(sm, o + 8);
    const encrypted = u64(sm, o + 16);
    const nameLength = u64(sm, o + 32);
    const encoded = u64(sm, o + 48);
    const pages = u64(sm, o + 56);
    o += 64;
    if (nameLength > 512 || pages > 1e6) throw new Error("DWG_SECTION_MAP");
    let name = "";
    for (let i = 0; i + 1 < nameLength && o + i + 1 < sm.length; i += 2) name += String.fromCharCode(sm[o + i] | (sm[o + i + 1] << 8));
    name = name.replace(/\0.*$/, "");
    o += nameLength;
    const list: DwgSectionPage[] = [];
    // pages: offset in the section, size, page id, decompressed size, compressed size, checksum, CRC
    for (let p = 0; p < pages && o + 56 <= sm.length; p++) {
      list.push({ offset: u64(sm, o), size: u64(sm, o + 8), page: u64(sm, o + 16), usize: u64(sm, o + 24), csize: u64(sm, o + 32) });
      o += 56;
    }
    info.sections.push({ name, size, pageSize, encrypted, encoded, compressed: 2, pages: list });
  }
}

/** The bytes of one named R2007 section: its pages (Reed–Solomon (255, 251) blocks), decompressed at their offsets. */
function sectionData2007(b: Uint8Array, info: DwgInfo, sec: DwgSection): Uint8Array {
  const out = new Uint8Array(sec.size);
  for (const pg of sec.pages ?? []) {
    const at = info.pageAddress?.get(pg.page);
    if (at === undefined) throw new Error("DWG_PAGE_MISSING");
    const csize = pg.csize ?? 0, usize = pg.usize ?? 0;
    let data: Uint8Array;
    if (sec.encoded === 1) data = b.subarray(at, at + csize);
    else {
      const blocks = Math.ceil(((csize + 7) & ~7) / 251);
      if (at + blocks * 255 > b.length) throw new Error("DWG_PAGE_BOUNDS");
      data = deinterleave(b.subarray(at, at + blocks * 255), blocks, 251);
    }
    const page = csize < usize ? decompressR21(data.subarray(0, csize), usize) : data.subarray(0, usize);
    out.set(page.subarray(0, Math.max(0, Math.min(page.length, out.length - pg.offset))), pg.offset);
  }
  return out;
}

/** R2000 (AC1015 and earlier): a section by its locator record, straight from the file. */
export function r2000Section(b: Uint8Array, info: DwgInfo, name: string): Uint8Array | null {
  const sec = info.sections.find((s) => s.name === name);
  if (!sec || sec.seeker === undefined) return null;
  return b.subarray(sec.seeker, sec.seeker + sec.size);
}

/** Version, sections and pages of a DWG file (no objects yet). */
export function readDwgInfo(b: Uint8Array): DwgInfo {
  if (!isDwg(b)) throw new Error("DWG_NOT_DWG");
  const version = ascii(b, 0, 6);
  const info: DwgInfo = { version, release: RELEASES[version] ?? version, maintenance: b[0x0b], codepage: b[0x13] | (b[0x14] << 8), sections: [], problems: [] };
  try {
    if (version <= "AC1015") readR2000(b, info);
    else if (version === "AC1021") readR2007(b, info);
    else readR2004(b, info);
  } catch (e) {
    info.problems.push((e as Error).message);
  }
  return info;
}
