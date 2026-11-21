// Zstandard (RFC 8878) — a small, dependency-free decoder and encoder, written from the RFC (no code taken from the
// reference library). Used for Illustrator's private data (AIPrivateData, '%AI24_ZStandard_Data' + one zstd frame,
// Illustrator 24+).
// Decoder: every frame feature except dictionaries (Raw/RLE/Compressed blocks, Huffman literals with 1 or 4 streams
// and treeless repeats, FSE sequences in predefined/RLE/FSE/repeat modes, repeat offsets, skippable frames, content
// checksum). Malformed input throws; the output is capped (maxOutput) and every block is held to the RFC's 128 KiB.
// Encoder: LZ matching (hash chains) written as Raw literals + sequences with the predefined FSE tables — no Huffman,
// no custom tables, so the code stays small; blocks that do not shrink are stored raw.

const MAGIC = 0xfd2fb528;
const MAX_BLOCK = 128 * 1024;
/** default cap on the decompressed size (Illustrator's private data is a few MB) */
export const ZSTD_MAX_OUTPUT = 512 * 1024 * 1024;

const fail = (what: string): never => {
  throw new Error("zstd: " + what);
};

class Out {
  buf: Uint8Array;
  n = 0;
  constructor(
    size: number,
    private max: number,
  ) {
    this.buf = new Uint8Array(Math.min(Math.max(1024, size), max + 1));
  }
  need(k: number) {
    if (this.n + k <= this.buf.length) return;
    if (this.n + k > this.max) fail("output larger than the limit");
    let len = this.buf.length * 2;
    while (len < this.n + k) len *= 2;
    const b = new Uint8Array(Math.min(len, this.max));
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  bytes(src: Uint8Array) {
    this.need(src.length);
    this.buf.set(src, this.n);
    this.n += src.length;
  }
  match(offset: number, len: number, frameStart: number, window: number) {
    if (offset <= 0 || this.n - offset < frameStart || offset > window) fail("bad match offset");
    this.need(len);
    const b = this.buf;
    let s = this.n - offset;
    let d = this.n;
    if (offset >= len) b.copyWithin(d, s, s + len);
    else for (let i = 0; i < len; i++) b[d++] = b[s++];
    this.n += len;
  }
}

/** Forward little-endian bit reader (FSE table headers). */
function fwdBits(src: Uint8Array, pos: number, n: number): number {
  let v = 0;
  for (let i = 0; i < n; i++) {
    const p = pos + i;
    const byte = src[p >> 3] ?? 0;
    v |= ((byte >> (p & 7)) & 1) << i;
  }
  return v >>> 0;
}

/** Backward bit stream (Huffman and FSE payloads): read from the end, highest bits first. */
class BackBits {
  private src: Uint8Array;
  private start: number;
  /** bits left to read (negative = read past the start; those bits are zero) */
  left: number;
  constructor(src: Uint8Array, start: number, end: number) {
    if (end <= start || end > src.length) fail("empty bit stream");
    const last = src[end - 1];
    if (!last) fail("bit stream without end mark");
    this.src = src;
    this.start = start;
    this.left = (end - start - 1) * 8 + (31 - Math.clz32(last));
  }
  peek(n: number): number {
    if (n <= 0) return 0;
    let pos = this.left - n;
    let skip = 0;
    if (pos < 0) {
      skip = -pos; // bits before the start read as zero
      pos = 0;
      if (skip >= n) return 0;
    }
    let v = 0;
    let got = 0;
    const want = n - skip;
    const src = this.src;
    while (got < want) {
      const off = pos & 7;
      const take = Math.min(8 - off, want - got);
      v += ((src[this.start + (pos >> 3)] >> off) & ((1 << take) - 1)) * 2 ** got;
      got += take;
      pos += take;
    }
    return skip ? v * 2 ** skip : v;
  }
  read(n: number): number {
    const v = this.peek(n);
    this.left -= n;
    return v;
  }
}

interface FseTable {
  log: number;
  sym: Uint8Array;
  bits: Uint8Array;
  base: Uint32Array;
}

function highBit(v: number) {
  return 31 - Math.clz32(v);
}

function buildFse(norm: number[], log: number): FseTable {
  const size = 1 << log;
  const sym = new Uint8Array(size);
  const bits = new Uint8Array(size);
  const base = new Uint32Array(size);
  const next: number[] = [];
  let high = size - 1;
  for (let s = 0; s < norm.length; s++) {
    if (norm[s] === -1) {
      if (high < 0) fail("bad FSE distribution");
      sym[high--] = s;
      next[s] = 1;
    } else next[s] = norm[s];
  }
  const step = (size >> 1) + (size >> 3) + 3;
  const mask = size - 1;
  let pos = 0;
  for (let s = 0; s < norm.length; s++) {
    for (let i = 0; i < norm[s]; i++) {
      sym[pos] = s;
      do pos = (pos + step) & mask;
      while (pos > high);
    }
  }
  if (pos !== 0) fail("bad FSE distribution");
  for (let u = 0; u < size; u++) {
    const s = sym[u];
    const ns = next[s]++;
    const nb = log - highBit(ns);
    bits[u] = nb;
    base[u] = (ns << nb) - size;
  }
  return { log, sym, bits, base };
}

/** Read an FSE table description (RFC 8878 §4.1.1). Returns the table and the header size in bytes. */
function readFse(src: Uint8Array, at: number, end: number, maxLog: number, maxSym: number): { t: FseTable; size: number } {
  let bit = at * 8;
  const log = fwdBits(src, bit, 4) + 5;
  bit += 4;
  if (log > maxLog) fail("FSE accuracy too large");
  let remaining = (1 << log) + 1;
  let threshold = 1 << log;
  let nb = log + 1;
  const norm: number[] = [];
  let s = 0;
  while (remaining > 1) {
    if (s > maxSym || bit > end * 8) fail("bad FSE table");
    const max = 2 * threshold - 1 - remaining;
    let count: number;
    const low = fwdBits(src, bit, nb - 1);
    if (low < max) {
      count = low;
      bit += nb - 1;
    } else {
      count = fwdBits(src, bit, nb);
      if (count >= threshold) count -= max;
      bit += nb;
    }
    count--;
    remaining -= count < 0 ? -count : count;
    if (remaining < 1) fail("bad FSE table");
    norm[s++] = count;
    if (count === 0) {
      for (;;) {
        const rep = fwdBits(src, bit, 2);
        bit += 2;
        for (let i = 0; i < rep; i++) norm[s++] = 0;
        if (s > maxSym + 1) fail("bad FSE table");
        if (rep !== 3) break;
      }
    }
    while (remaining < threshold) {
      nb--;
      threshold >>= 1;
    }
  }
  if (remaining !== 1) fail("bad FSE table");
  const size = ((bit + 7) >> 3) - at;
  if (at + size > end) fail("truncated FSE table");
  return { t: buildFse(norm, log), size };
}

interface Huff {
  maxBits: number;
  sym: Uint8Array;
  bits: Uint8Array;
}

function readHuffman(src: Uint8Array, at: number, end: number): { h: Huff; size: number } {
  if (at >= end) fail("truncated Huffman table");
  const head = src[at];
  const weights: number[] = [];
  let size: number;
  if (head >= 128) {
    const n = head - 127;
    size = 1 + ((n + 1) >> 1);
    if (at + size > end) fail("truncated Huffman table");
    for (let i = 0; i < n; i++) {
      const b = src[at + 1 + (i >> 1)];
      weights.push(i & 1 ? b & 15 : b >> 4);
    }
  } else {
    size = 1 + head;
    if (at + size > end) fail("truncated Huffman table");
    const { t, size: hs } = readFse(src, at + 1, at + 1 + head, 6, 255);
    const bs = new BackBits(src, at + 1 + hs, at + 1 + head);
    let s1 = bs.read(t.log);
    let s2 = bs.read(t.log);
    for (;;) {
      if (weights.length > 255) fail("too many Huffman weights");
      weights.push(t.sym[s1]);
      s1 = t.base[s1] + bs.read(t.bits[s1]);
      if (bs.left < 0) {
        weights.push(t.sym[s2]);
        break;
      }
      weights.push(t.sym[s2]);
      s2 = t.base[s2] + bs.read(t.bits[s2]);
      if (bs.left < 0) {
        weights.push(t.sym[s1]);
        break;
      }
    }
  }
  if (weights.length > 255) fail("too many Huffman weights");
  let total = 0;
  for (const w of weights) {
    if (w > 11) fail("bad Huffman weight");
    if (w) total += 1 << (w - 1);
  }
  if (!total) fail("empty Huffman table");
  const maxBits = highBit(total) + 1;
  if (maxBits > 11) fail("Huffman code too long");
  const rest = (1 << maxBits) - total;
  if (rest & (rest - 1)) fail("bad Huffman weights");
  weights.push(highBit(rest) + 1);
  const n = 1 << maxBits;
  const sym = new Uint8Array(n);
  const bits = new Uint8Array(n);
  let pos = 0;
  for (let w = 1; w <= maxBits; w++) {
    for (let s = 0; s < weights.length; s++) {
      if (weights[s] !== w) continue;
      const len = 1 << (w - 1);
      sym.fill(s, pos, pos + len);
      bits.fill(maxBits + 1 - w, pos, pos + len);
      pos += len;
    }
  }
  if (pos !== n) fail("bad Huffman table");
  return { h: { maxBits, sym, bits }, size };
}

function huffStream(src: Uint8Array, start: number, end: number, h: Huff, out: Uint8Array, o: number, count: number) {
  if (count < 0) fail("bad Huffman stream");
  const bs = new BackBits(src, start, end);
  for (let i = 0; i < count; i++) {
    const k = bs.peek(h.maxBits);
    out[o + i] = h.sym[k];
    bs.left -= h.bits[k];
  }
  if (bs.left !== 0) fail("Huffman stream size mismatch");
}

// literal length / match length codes (RFC 8878 §3.1.1.3.2.1.1)
const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
const ML_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051,
  4099, 8195, 16387, 32771, 65539,
];
const ML_BITS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
];
const LL_DEF = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
const ML_DEF = [
  1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1,
];
const OF_DEF = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];
let predefined: { ll: FseTable; ml: FseTable; of: FseTable } | null = null;
const defaults = () => (predefined ??= { ll: buildFse(LL_DEF, 6), ml: buildFse(ML_DEF, 6), of: buildFse(OF_DEF, 5) });

function rleTable(s: number): FseTable {
  return { log: 0, sym: Uint8Array.of(s), bits: Uint8Array.of(0), base: Uint32Array.of(0) };
}

interface FrameState {
  huff: Huff | null;
  ll: FseTable | null;
  ml: FseTable | null;
  of: FseTable | null;
  rep: [number, number, number];
  window: number;
}

function decodeBlock(src: Uint8Array, at: number, end: number, out: Out, fs: FrameState, frameStart: number) {
  const blockStart = out.n;
  // ---- literals
  const b0 = src[at];
  const ltype = b0 & 3;
  const sf = (b0 >> 2) & 3;
  let lits: Uint8Array;
  let p: number;
  if (ltype === 0 || ltype === 1) {
    let regen: number;
    if (sf === 0 || sf === 2) (regen = b0 >> 3), (p = at + 1);
    else if (sf === 1) (regen = (b0 >> 4) | (src[at + 1] << 4)), (p = at + 2);
    else (regen = (b0 >> 4) | (src[at + 1] << 4) | (src[at + 2] << 12)), (p = at + 3);
    if (regen > MAX_BLOCK) fail("literals larger than a block");
    if (ltype === 0) {
      if (p + regen > end) fail("truncated literals");
      lits = src.subarray(p, p + regen);
      p += regen;
    } else {
      if (p >= end) fail("truncated literals");
      lits = new Uint8Array(regen).fill(src[p]);
      p += 1;
    }
  } else {
    let regen: number, comp: number, streams: number;
    const b1 = src[at + 1], b2 = src[at + 2];
    if (sf <= 1) {
      streams = sf === 0 ? 1 : 4;
      regen = (b0 >> 4) | ((b1 & 0x3f) << 4);
      comp = (b1 >> 6) | (b2 << 2);
      p = at + 3;
    } else if (sf === 2) {
      streams = 4;
      regen = (b0 >> 4) | (b1 << 4) | ((b2 & 3) << 12);
      comp = (b2 >> 2) | (src[at + 3] << 6);
      p = at + 4;
    } else {
      streams = 4;
      regen = (b0 >> 4) | (b1 << 4) | ((b2 & 0x3f) << 12);
      comp = (b2 >> 6) | (src[at + 3] << 2) | (src[at + 4] << 10);
      p = at + 5;
    }
    if (regen > MAX_BLOCK) fail("literals larger than a block");
    const cend = p + comp;
    if (cend > end) fail("truncated literals");
    if (ltype === 2) {
      const r = readHuffman(src, p, cend);
      fs.huff = r.h;
      p += r.size;
    }
    const h = fs.huff;
    if (!h) fail("treeless literals without a table");
    lits = new Uint8Array(regen);
    if (streams === 1) huffStream(src, p, cend, h!, lits, 0, regen);
    else {
      if (p + 6 > cend) fail("truncated literals");
      const s1 = src[p] | (src[p + 1] << 8), s2 = src[p + 2] | (src[p + 3] << 8), s3 = src[p + 4] | (src[p + 5] << 8);
      const seg = (regen + 3) >> 2;
      let q = p + 6;
      const sizes = [s1, s2, s3, cend - p - 6 - s1 - s2 - s3];
      if (sizes[3] <= 0) fail("bad literal streams");
      for (let i = 0; i < 4; i++) {
        const cnt = i < 3 ? seg : regen - 3 * seg;
        huffStream(src, q, q + sizes[i], h!, lits, i * seg, cnt);
        q += sizes[i];
      }
    }
    p = cend;
  }
  // ---- sequences
  if (p >= end) fail("truncated sequences");
  let nseq = src[p++];
  if (nseq >= 128) {
    if (nseq < 255) nseq = ((nseq - 128) << 8) + src[p++];
    else (nseq = src[p] + (src[p + 1] << 8) + 0x7f00), (p += 2);
  }
  if (nseq === 0) {
    if (p !== end) fail("data after the literals");
    if (lits.length > MAX_BLOCK) fail("block larger than 128 KiB");
    out.bytes(lits);
    return;
  }
  if (p >= end) fail("truncated sequences");
  const modes = src[p++];
  if (modes & 3) fail("reserved sequence mode bits set");
  const pick = (mode: number, def: FseTable, maxLog: number, maxSym: number, prev: FseTable | null): FseTable => {
    if (mode === 0) return def;
    if (mode === 1) {
      if (p >= end) fail("truncated sequences");
      const s = src[p++];
      if (s > maxSym) fail("bad sequence code");
      return rleTable(s);
    }
    if (mode === 2) {
      const r = readFse(src, p, end, maxLog, maxSym);
      p += r.size;
      return r.t;
    }
    if (!prev) fail("repeat mode without a table");
    return prev!;
  };
  const d = defaults();
  fs.ll = pick((modes >> 6) & 3, d.ll, 9, 35, fs.ll);
  fs.of = pick((modes >> 4) & 3, d.of, 8, 31, fs.of);
  fs.ml = pick((modes >> 2) & 3, d.ml, 9, 52, fs.ml);
  const ll = fs.ll, of = fs.of, ml = fs.ml;
  const bs = new BackBits(src, p, end);
  let sLL = bs.read(ll.log), sOF = bs.read(of.log), sML = bs.read(ml.log);
  const rep = fs.rep;
  const limit = blockStart + MAX_BLOCK;
  let li = 0;
  for (let i = 0; i < nseq; i++) {
    const ofCode = of.sym[sOF], mlCode = ml.sym[sML], llCode = ll.sym[sLL];
    if (ofCode > 31 || mlCode > 52 || llCode > 35) fail("bad sequence code");
    const ofVal = 2 ** ofCode + bs.read(ofCode);
    const mlen = ML_BASE[mlCode] + bs.read(ML_BITS[mlCode]);
    const llen = LL_BASE[llCode] + bs.read(LL_BITS[llCode]);
    if (bs.left < 0) fail("sequence stream overrun");
    let offset: number;
    if (ofVal > 3) {
      offset = ofVal - 3;
      rep[2] = rep[1];
      rep[1] = rep[0];
      rep[0] = offset;
    } else {
      const idx = ofVal - 1 + (llen === 0 ? 1 : 0);
      if (idx === 0) offset = rep[0];
      else {
        offset = idx === 3 ? rep[0] - 1 : rep[idx];
        if (idx > 1) rep[2] = rep[1];
        rep[1] = rep[0];
        rep[0] = offset;
      }
    }
    if (li + llen > lits.length) fail("literals overrun");
    if (out.n + llen + mlen > limit) fail("block larger than 128 KiB");
    out.bytes(lits.subarray(li, li + llen));
    li += llen;
    out.match(offset, mlen, frameStart, fs.window);
    if (i < nseq - 1) {
      sLL = ll.base[sLL] + bs.read(ll.bits[sLL]);
      sML = ml.base[sML] + bs.read(ml.bits[sML]);
      sOF = of.base[sOF] + bs.read(of.bits[sOF]);
    }
  }
  if (bs.left !== 0) fail("sequence stream size mismatch");
  if (out.n + lits.length - li > limit) fail("block larger than 128 KiB");
  out.bytes(lits.subarray(li));
}

const u32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

// ───────── XXH64 (content checksum: its low 32 bits) ─────────

const M64 = (1n << 64n) - 1n;
const P1 = 0x9e3779b185ebca87n, P2 = 0xc2b2ae3d27d4eb4fn, P3 = 0x165667b19e3779f9n, P4 = 0x85ebca77c2b2ae63n, P5 = 0x27d4eb2f165667c5n;
const rotl = (v: bigint, r: bigint) => ((v << r) | (v >> (64n - r))) & M64;
const round64 = (acc: bigint, lane: bigint) => (rotl((acc + lane * P2) & M64, 31n) * P1) & M64;
const merge64 = (acc: bigint, v: bigint) => (((acc ^ round64(0n, v)) * P1 + P4) & M64);

/** XXH64 with seed 0 (exported for tests). */
export function xxh64(b: Uint8Array): bigint {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const lane = (i: number) => dv.getBigUint64(i, true);
  const n = b.length;
  let i = 0;
  let h: bigint;
  if (n >= 32) {
    let v1 = (P1 + P2) & M64, v2 = P2, v3 = 0n, v4 = (M64 + 1n - P1) & M64;
    for (; i + 32 <= n; i += 32) {
      v1 = round64(v1, lane(i));
      v2 = round64(v2, lane(i + 8));
      v3 = round64(v3, lane(i + 16));
      v4 = round64(v4, lane(i + 24));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    h = merge64(h, v1);
    h = merge64(h, v2);
    h = merge64(h, v3);
    h = merge64(h, v4);
  } else h = P5;
  h = (h + BigInt(n)) & M64;
  for (; i + 8 <= n; i += 8) h = (rotl(h ^ round64(0n, lane(i)), 27n) * P1 + P4) & M64;
  if (i + 4 <= n) {
    h = (rotl(h ^ ((BigInt(dv.getUint32(i, true)) * P1) & M64), 23n) * P2 + P3) & M64;
    i += 4;
  }
  for (; i < n; i++) h = (rotl(h ^ ((BigInt(b[i]) * P5) & M64), 11n) * P1) & M64;
  h ^= h >> 33n;
  h = (h * P2) & M64;
  h ^= h >> 29n;
  h = (h * P3) & M64;
  h ^= h >> 32n;
  return h;
}

/**
 * Decompress one or more zstd frames (skippable frames are skipped). Throws on malformed input, on dictionary
 * frames, on a wrong content size or checksum, and when the output would pass `maxOutput` bytes.
 */
export function zstdDecompress(src: Uint8Array, maxOutput = ZSTD_MAX_OUTPUT): Uint8Array {
  if (!src.length) fail("empty input");
  const out = new Out(src.length * 4, maxOutput);
  let p = 0;
  while (p < src.length) {
    if (p + 4 > src.length) fail("trailing bytes after the last frame");
    const magic = u32(src, p);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (p + 8 > src.length) fail("truncated skippable frame");
      p += 8 + u32(src, p + 4);
      if (p > src.length) fail("truncated skippable frame");
      continue;
    }
    if (magic !== MAGIC) fail("bad frame magic");
    p += 4;
    if (p >= src.length) fail("truncated frame header");
    const fhd = src[p++];
    const fcsFlag = fhd >> 6, single = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    if (fhd & 8) fail("reserved bit set");
    const dictSize = [0, 1, 2, 4][dictFlag];
    const fcsSize = [single ? 1 : 0, 2, 4, 8][fcsFlag];
    if (p + (single ? 0 : 1) + dictSize + fcsSize > src.length) fail("truncated frame header");
    let window = Infinity;
    if (!single) {
      const wd = src[p++];
      const wlog = 10 + (wd >> 3);
      const wbase = 2 ** wlog;
      window = wbase + (wbase / 8) * (wd & 7);
    }
    let dictId = 0;
    for (let i = 0; i < dictSize; i++) dictId += src[p + i] * 2 ** (8 * i);
    if (dictId) fail("dictionaries are not supported");
    p += dictSize;
    let fcs = -1;
    if (fcsSize) {
      fcs = 0;
      for (let i = 0; i < fcsSize; i++) fcs += src[p + i] * 2 ** (8 * i);
      if (fcsSize === 2) fcs += 256;
      if (fcs > maxOutput - out.n) fail("output larger than the limit");
      p += fcsSize;
    }
    const frameStart = out.n;
    const fs: FrameState = { huff: null, ll: null, ml: null, of: null, rep: [1, 4, 8], window };
    for (;;) {
      if (p + 3 > src.length) fail("truncated block");
      const h = src[p] | (src[p + 1] << 8) | (src[p + 2] << 16);
      p += 3;
      const last = h & 1, type = (h >> 1) & 3, size = h >>> 3;
      if (size > MAX_BLOCK) fail("block larger than 128 KiB");
      if (type === 0) {
        if (p + size > src.length) fail("truncated block");
        out.bytes(src.subarray(p, p + size));
        p += size;
      } else if (type === 1) {
        if (p >= src.length) fail("truncated block");
        out.need(size);
        out.buf.fill(src[p], out.n, out.n + size);
        out.n += size;
        p += 1;
      } else if (type === 2) {
        if (!size || p + size > src.length) fail("truncated block");
        decodeBlock(src, p, p + size, out, fs, frameStart);
        p += size;
      } else fail("reserved block type");
      if (last) break;
    }
    if (fcs >= 0 && out.n - frameStart !== fcs) fail("content size mismatch");
    if (checksum) {
      if (p + 4 > src.length) fail("truncated checksum");
      const want = u32(src, p);
      p += 4;
      const got = Number(xxh64(out.buf.subarray(frameStart, out.n)) & 0xffffffffn);
      if (got !== want) fail("checksum mismatch");
    }
  }
  return out.buf.slice(0, out.n);
}

// ───────── encoder ─────────

/** forward bit writer (bits are read back from the end by the decoder) */
class BitWriter {
  bytes: number[] = [];
  private acc = 0;
  private n = 0;
  put(v: number, bits: number) {
    if (!bits) return;
    this.acc += v * 2 ** this.n;
    this.n += bits;
    while (this.n >= 8) {
      this.bytes.push(this.acc % 256);
      this.acc = Math.floor(this.acc / 256);
      this.n -= 8;
    }
  }
  /** end mark (a single 1 bit) and padding */
  finish(): number[] {
    this.put(1, 1);
    if (this.n) this.put(0, 8 - this.n);
    return this.bytes;
  }
}

interface FseEnc {
  t: FseTable;
  /** owner[s * size + x] = the state that decodes symbol s and then reaches state x */
  owner: Int16Array;
  first: Int16Array;
}

function fseEncoder(t: FseTable, nsym: number): FseEnc {
  const size = 1 << t.log;
  const owner = new Int16Array(nsym * size).fill(-1);
  const first = new Int16Array(nsym).fill(-1);
  for (let u = 0; u < size; u++) {
    const s = t.sym[u];
    if (first[s] < 0) first[s] = u;
    for (let x = t.base[u]; x < t.base[u] + (1 << t.bits[u]); x++) owner[s * size + x] = u;
  }
  return { t, owner, first };
}
let encoders: { ll: FseEnc; ml: FseEnc; of: FseEnc } | null = null;
const encs = () => {
  const d = defaults();
  return (encoders ??= { ll: fseEncoder(d.ll, 36), ml: fseEncoder(d.ml, 53), of: fseEncoder(d.of, 29) });
};

function codeOf(v: number, base: number[], direct: number) {
  if (v < direct) return v;
  let c = direct;
  while (c + 1 < base.length && base[c + 1] <= v) c++;
  return c;
}

/** FSE states (backwards from the last symbol) for a symbol list; bits[i] = transition bits after symbol i. */
function fseStates(e: FseEnc, syms: number[]): { states: number[]; vals: number[]; nbs: number[] } {
  const size = 1 << e.t.log;
  const n = syms.length;
  const states = new Array<number>(n);
  const vals = new Array<number>(n).fill(0);
  const nbs = new Array<number>(n).fill(0);
  states[n - 1] = e.first[syms[n - 1]];
  for (let i = n - 2; i >= 0; i--) {
    const next = states[i + 1];
    const u = e.owner[syms[i] * size + next];
    if (u < 0) fail("symbol outside the predefined table");
    states[i] = u;
    vals[i] = next - e.t.base[u];
    nbs[i] = e.t.bits[u];
  }
  return { states, vals, nbs };
}

const ML_BASE_0 = ML_BASE.map((v) => v - 3);
const WINDOW_LOG = 21; // 2 MiB, the window Illustrator itself declares for its larger private data
const WINDOW = 1 << WINDOW_LOG;
const MIN_MATCH = 4;
const HASH_LOG = 17;
const CHAIN = 16;

/** One compressed block (or null when it does not get smaller than the source). */
function compressBlock(data: Uint8Array, start: number, end: number, head: Int32Array, prev: Int32Array): Uint8Array | null {
  const lit: number[] = [];
  const seqs: { ll: number; ml: number; off: number }[] = [];
  const hash = (i: number) => (Math.imul(data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24), 0x9e3779b1) >>> (32 - HASH_LOG));
  const insert = (i: number) => {
    if (i + 4 > data.length) return;
    const h = hash(i);
    prev[i] = head[h];
    head[h] = i;
  };
  let i = start;
  let litStart = start;
  while (i < end) {
    let bestLen = 0, bestOff = 0;
    if (i + MIN_MATCH <= end) {
      let cand = head[hash(i)];
      for (let k = 0; k < CHAIN && cand >= 0 && i - cand <= WINDOW - 1; k++) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          const max = end - i;
          while (l < max && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestOff = i - cand;
            if (l === max) break;
          }
        }
        cand = prev[cand];
      }
    }
    if (bestLen >= MIN_MATCH) {
      for (let k = litStart; k < i; k++) lit.push(data[k]);
      seqs.push({ ll: i - litStart, ml: bestLen, off: bestOff });
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
      litStart = i;
    } else {
      insert(i);
      i++;
    }
  }
  for (let k = litStart; k < end; k++) lit.push(data[k]);
  if (!seqs.length) return null;
  const out: number[] = [];
  // literals section: Raw
  const n = lit.length;
  if (n < 32) out.push(n << 3);
  else if (n < 4096) out.push(4 | ((n & 15) << 4), n >> 4);
  else out.push(12 | ((n & 15) << 4), (n >> 4) & 255, n >> 12);
  for (const b of lit) out.push(b);
  // sequences section header: count and modes (predefined tables)
  const ns = seqs.length;
  if (ns < 128) out.push(ns);
  else if (ns < 0x7f00) out.push((ns >> 8) + 128, ns & 255);
  else out.push(255, (ns - 0x7f00) & 255, (ns - 0x7f00) >> 8);
  out.push(0);
  const llc = seqs.map((s) => codeOf(s.ll, LL_BASE, 16));
  const mlc = seqs.map((s) => codeOf(s.ml - 3, ML_BASE_0, 32));
  const ofv = seqs.map((s) => s.off + 3);
  const ofc = ofv.map(highBit);
  const e = encs();
  const sl = fseStates(e.ll, llc), sm = fseStates(e.ml, mlc), so = fseStates(e.of, ofc);
  // the reads in the decoder's order, written in reverse
  const reads: number[] = [];
  const r = (v: number, nb: number) => reads.push(v, nb);
  r(sl.states[0], 6);
  r(so.states[0], 5);
  r(sm.states[0], 6);
  for (let k = 0; k < ns; k++) {
    r(ofv[k] - 2 ** ofc[k], ofc[k]);
    r(seqs[k].ml - ML_BASE[mlc[k]], ML_BITS[mlc[k]]);
    r(seqs[k].ll - LL_BASE[llc[k]], LL_BITS[llc[k]]);
    if (k < ns - 1) {
      r(sl.vals[k], sl.nbs[k]);
      r(sm.vals[k], sm.nbs[k]);
      r(so.vals[k], so.nbs[k]);
    }
  }
  const bw = new BitWriter();
  for (let k = reads.length - 2; k >= 0; k -= 2) bw.put(reads[k], reads[k + 1]);
  for (const b of bw.finish()) out.push(b);
  if (out.length >= end - start) return null;
  return Uint8Array.from(out);
}

/**
 * One zstd frame holding `data`: LZ-compressed blocks with Raw literals and the predefined sequence tables (stored
 * blocks where that does not help). Frame header as Illustrator writes it for large data: 4-byte content size and
 * a 2 MiB window, no checksum, no dictionary.
 */
export function zstdCompress(data: Uint8Array): Uint8Array {
  if (data.length >= 2 ** 32) fail("input too large");
  const parts: Uint8Array[] = [];
  const n = data.length;
  parts.push(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x80, (WINDOW_LOG - 10) << 3, n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24));
  const head = new Int32Array(1 << HASH_LOG).fill(-1);
  const prev = new Int32Array(Math.max(1, n)).fill(-1);
  let at = 0;
  do {
    const end = Math.min(n, at + MAX_BLOCK);
    const last = end === n ? 1 : 0;
    const c = compressBlock(data, at, end, head, prev);
    const size = c ? c.length : end - at;
    const h = (size << 3) | ((c ? 2 : 0) << 1) | last;
    parts.push(Uint8Array.of(h & 255, (h >> 8) & 255, (h >> 16) & 255));
    parts.push(c ?? data.subarray(at, end));
    at = end;
  } while (at < n);
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

/** One zstd frame holding `data` in Raw (stored) blocks — no compression, readable by any zstd decoder. */
export function zstdStoredFrame(data: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(data.length / MAX_BLOCK));
  const out = new Uint8Array(6 + blocks * 3 + data.length);
  out.set([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x38]); // magic; no checksum/dictionary/size; window 128 KiB
  let o = 6;
  for (let i = 0; i < blocks; i++) {
    const part = data.subarray(i * MAX_BLOCK, (i + 1) * MAX_BLOCK);
    const h = (part.length << 3) | (i === blocks - 1 ? 1 : 0);
    out[o++] = h & 255;
    out[o++] = (h >> 8) & 255;
    out[o++] = (h >> 16) & 255;
    out.set(part, o);
    o += part.length;
  }
  return out;
}
