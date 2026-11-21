// "TrueType pack" — a lossless container for the bundled Pretendard TTFs (docs/design/INSTALLER_SIZE.md §7).
//
// The installer stores every bundled file brotli-compressed (Tauri, q9). A TTF's glyf table compresses poorly that
// way: flags, x and y deltas are interleaved per glyph. Here glyf is split into separate streams the way WOFF2 does
// (W3C WOFF2 §5: per-glyph contour counts, 255UInt16 point counts, one flag byte + "triplet" coordinate bytes per point,
// bounding boxes only when they differ from the points), and loca is dropped. The rest of the file is kept verbatim.
//
// Unlike a WOFF2 decoder, unpacking must give back the ORIGINAL TTF byte for byte (the PDF export embeds subsets of it,
// and those must not change). So the packer re-encodes each simple glyph the way the font compiler did (fontTools'
// greedy delta packing) and keeps the stream form only when that reproduces the glyph's bytes exactly; any other glyph
// (other encoder, overlap / reserved flag bits, padding) is stored raw. Every Pretendard glyph matches.
//
// Layout (big endian): "OTP1" | u32 n | n × u32 field (glyfOff, glyfLen, locaOff, locaLen, numGlyphs, locaFormat,
// skeletonLen, then one length per stream) | skeleton (the TTF without its glyf and loca bytes) | streams.

const MAGIC = 0x4f545031; // OTP1
const STREAMS = ["kind", "nc", "npts", "flag", "glyph", "ilen", "ins", "bbox", "clen", "comp", "rlen", "raw"] as const;
type StreamName = (typeof STREAMS)[number];
// glyph kinds
const EMPTY = 0, SIMPLE = 1, SIMPLE_BBOX = 2, COMPOSITE = 3, RAW = 4;

class Out {
  a = new Uint8Array(1024);
  n = 0;
  private room(k: number) {
    if (this.n + k > this.a.length) {
      const b = new Uint8Array(Math.max(this.a.length * 2, this.n + k));
      b.set(this.a.subarray(0, this.n));
      this.a = b;
    }
  }
  u8(v: number) {
    this.room(1);
    this.a[this.n++] = v & 255;
  }
  u16(v: number) {
    this.room(2);
    this.a[this.n++] = (v >> 8) & 255;
    this.a[this.n++] = v & 255;
  }
  u32(v: number) {
    this.u16(v >>> 16);
    this.u16(v & 0xffff);
  }
  /** WOFF2 255UInt16 */
  u255(v: number) {
    if (v < 253) this.u8(v);
    else if (v < 506) this.u8(255), this.u8(v - 253);
    else if (v < 762) this.u8(254), this.u8(v - 506);
    else this.u8(253), this.u16(v);
  }
  bytes(b: Uint8Array) {
    this.room(b.length);
    this.a.set(b, this.n);
    this.n += b.length;
  }
  done() {
    return this.a.subarray(0, this.n);
  }
}

class In {
  p = 0;
  constructor(public a: Uint8Array) {}
  private need(k: number) {
    if (this.p + k > this.a.length) throw new Error("font pack truncated");
  }
  u8() {
    this.need(1);
    return this.a[this.p++];
  }
  u16() {
    this.need(2);
    const v = (this.a[this.p] << 8) | this.a[this.p + 1];
    this.p += 2;
    return v;
  }
  i16() {
    const v = this.u16();
    return v & 0x8000 ? v - 0x10000 : v;
  }
  u32() {
    return this.u16() * 0x10000 + this.u16();
  }
  u255() {
    const c = this.u8();
    if (c === 253) return this.u16();
    if (c === 255) return 253 + this.u8();
    if (c === 254) return 506 + this.u8();
    return c;
  }
  take(k: number) {
    this.need(k);
    const b = this.a.subarray(this.p, this.p + k);
    this.p += k;
    return b;
  }
}

/** TrueType simple-glyph flags + coordinates, packed the way fontTools does (greedy, shortest per coordinate). */
function encodePoints(out: Out, on: Uint8Array, dx: Int32Array, dy: Int32Array, n: number) {
  const F: number[] = [], X = new Out(), Y = new Out();
  let last = -1, rep = 0;
  for (let i = 0; i < n; i++) {
    let fl = on[i];
    let x = dx[i], y = dy[i];
    if (x === 0) fl |= 0x10;
    else if (x >= -255 && x <= 255) {
      fl |= 0x02;
      if (x > 0) fl |= 0x10;
      else x = -x;
      X.u8(x);
    } else X.u16(x & 0xffff);
    if (y === 0) fl |= 0x20;
    else if (y >= -255 && y <= 255) {
      fl |= 0x04;
      if (y > 0) fl |= 0x20;
      else y = -y;
      Y.u8(y);
    } else Y.u16(y & 0xffff);
    if (fl === last && rep !== 255) {
      rep++;
      if (rep === 1) F.push(fl);
      else {
        F[F.length - 2] = fl | 8;
        F[F.length - 1] = rep;
      }
    } else {
      rep = 0;
      F.push(fl);
    }
    last = fl;
  }
  out.bytes(Uint8Array.from(F));
  out.bytes(X.done());
  out.bytes(Y.done());
}

function writeTriplet(flag: Out, glyph: Out, onCurve: boolean, x: number, y: number) {
  const ax = Math.abs(x), ay = Math.abs(y);
  const on = onCurve ? 0 : 128, xs = x < 0 ? 0 : 1, ys = y < 0 ? 0 : 1, xys = xs + 2 * ys;
  if (x === 0 && ay < 1280) {
    flag.u8(on + ((ay & 0xf00) >> 7) + ys);
    glyph.u8(ay);
  } else if (y === 0 && ax < 1280) {
    flag.u8(on + 10 + ((ax & 0xf00) >> 7) + xs);
    glyph.u8(ax);
  } else if (ax < 65 && ay < 65) {
    flag.u8(on + 20 + ((ax - 1) & 0x30) + (((ay - 1) & 0x30) >> 2) + xys);
    glyph.u8((((ax - 1) & 0xf) << 4) | ((ay - 1) & 0xf));
  } else if (ax < 769 && ay < 769) {
    flag.u8(on + 84 + 12 * (((ax - 1) & 0x300) >> 8) + (((ay - 1) & 0x300) >> 6) + xys);
    glyph.u8(ax - 1);
    glyph.u8(ay - 1);
  } else if (ax < 4096 && ay < 4096) {
    flag.u8(on + 120 + xys);
    glyph.u8(ax >> 4);
    glyph.u8(((ax & 0xf) << 4) | (ay >> 8));
    glyph.u8(ay);
  } else {
    flag.u8(on + 124 + xys);
    glyph.u16(ax);
    glyph.u16(ay);
  }
}

function readTriplet(fb: number, g: In): [boolean, number, number] {
  const on = !(fb & 128);
  const f = fb & 127;
  const sgn = (bit: number, v: number) => (bit & 1 ? v : -v);
  if (f < 10) return [on, 0, sgn(f, ((f & 14) << 7) + g.u8())];
  if (f < 20) return [on, sgn(f, (((f - 10) & 14) << 7) + g.u8()), 0];
  if (f < 84) {
    const b0 = f - 20, b1 = g.u8();
    return [on, sgn(f, 1 + (b0 & 0x30) + (b1 >> 4)), sgn(f >> 1, 1 + ((b0 & 0x0c) << 2) + (b1 & 0x0f))];
  }
  if (f < 120) {
    const b0 = f - 84, b1 = g.u8(), b2 = g.u8();
    return [on, sgn(f, 1 + (Math.floor(b0 / 12) << 8) + b1), sgn(f >> 1, 1 + (((b0 % 12) >> 2) << 8) + b2)];
  }
  if (f < 124) {
    const b1 = g.u8(), b2 = g.u8(), b3 = g.u8();
    return [on, sgn(f, (b1 << 4) + (b2 >> 4)), sgn(f >> 1, ((b2 & 0x0f) << 8) + b3)];
  }
  const vx = g.u16(), vy = g.u16();
  return [on, sgn(f, vx), sgn(f >> 1, vy)];
}

function tables(ttf: Uint8Array) {
  const dv = new DataView(ttf.buffer, ttf.byteOffset, ttf.byteLength);
  const n = dv.getUint16(4);
  const t: Record<string, { off: number; len: number }> = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + 16 * i;
    t[String.fromCharCode(ttf[o], ttf[o + 1], ttf[o + 2], ttf[o + 3])] = { off: dv.getUint32(o + 8), len: dv.getUint32(o + 12) };
  }
  return { dv, t };
}

/** Pack a TrueType (glyf) font. Throws for fonts without glyf/loca. */
export function packTtf(ttf: Uint8Array): Uint8Array {
  const { dv, t } = tables(ttf);
  const { glyf, loca, head, maxp } = t;
  if (!glyf || !loca || !head || !maxp) throw new Error("TrueType glyf font expected");
  const locaFormat = dv.getInt16(head.off + 50), ng = dv.getUint16(maxp.off + 4);
  const at = (i: number) => (locaFormat ? dv.getUint32(loca.off + 4 * i) : 2 * dv.getUint16(loca.off + 2 * i));
  const S = Object.fromEntries(STREAMS.map((k) => [k, new Out()])) as Record<StreamName, Out>;
  for (let i = 0; i < ng; i++) {
    const a = glyf.off + at(i), b = glyf.off + at(i + 1);
    if (a === b) {
      S.kind.u8(EMPTY);
      continue;
    }
    const raw = () => {
      S.kind.u8(RAW);
      S.rlen.u32(b - a);
      S.raw.bytes(ttf.subarray(a, b));
    };
    const nc = dv.getInt16(a);
    if (nc < 0) {
      S.kind.u8(COMPOSITE);
      S.nc.u16(nc & 0xffff);
      for (let k = 0; k < 4; k++) S.bbox.u16(dv.getUint16(a + 2 + 2 * k));
      S.clen.u32(b - a - 10);
      S.comp.bytes(ttf.subarray(a + 10, b));
      continue;
    }
    // simple glyph: decode, then check that re-encoding gives the same bytes
    let p = a + 10;
    const ends: number[] = [];
    for (let k = 0; k < nc; k++) ends.push(dv.getUint16(p + 2 * k));
    p += 2 * nc;
    const np = nc ? ends[nc - 1] + 1 : 0;
    if (p + 2 > b || ends.some((e, k) => k && e <= ends[k - 1])) {
      raw();
      continue;
    }
    const il = dv.getUint16(p);
    p += 2;
    const insAt = p;
    p += il;
    const fl = new Uint8Array(np);
    let ok = true;
    for (let k = 0; k < np && ok; ) {
      if (p >= b) ok = false;
      else {
        const f = ttf[p++];
        fl[k++] = f;
        if (f & 8) {
          const r = ttf[p++];
          for (let j = 0; j < r && ok; j++) k < np ? (fl[k++] = f) : (ok = false);
        }
      }
    }
    const dx = new Int32Array(np), dy = new Int32Array(np);
    for (let k = 0; k < np && ok; k++) {
      const f = fl[k];
      if (f & 2) dx[k] = f & 16 ? ttf[p++] : -ttf[p++];
      else if (!(f & 16)) (dx[k] = dv.getInt16(p)), (p += 2);
    }
    for (let k = 0; k < np && ok; k++) {
      const f = fl[k];
      if (f & 4) dy[k] = f & 32 ? ttf[p++] : -ttf[p++];
      else if (!(f & 32)) (dy[k] = dv.getInt16(p)), (p += 2);
    }
    if (!ok || p !== b || fl.some((f) => f & 0xc0)) {
      raw();
      continue;
    }
    const on = fl.map((f) => f & 1);
    const re = new Out();
    encodePoints(re, on, dx, dy, np);
    const body = ttf.subarray(insAt + il, b);
    if (re.n !== body.length || re.done().some((v, k) => v !== body[k])) {
      raw();
      continue;
    }
    let X = 0, Y = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < np; k++) {
      X += dx[k];
      Y += dy[k];
      x0 = Math.min(x0, X), x1 = Math.max(x1, X), y0 = Math.min(y0, Y), y1 = Math.max(y1, Y);
    }
    const bb = [dv.getInt16(a + 2), dv.getInt16(a + 4), dv.getInt16(a + 6), dv.getInt16(a + 8)];
    const bbSame = np > 0 && bb[0] === x0 && bb[1] === y0 && bb[2] === x1 && bb[3] === y1;
    S.kind.u8(bbSame ? SIMPLE : SIMPLE_BBOX);
    if (!bbSame) for (const v of bb) S.bbox.u16(v);
    S.nc.u16(nc);
    let prev = -1;
    for (const e of ends) S.npts.u255(e - prev), (prev = e);
    S.ilen.u255(il);
    S.ins.bytes(ttf.subarray(insAt, insAt + il));
    for (let k = 0; k < np; k++) writeTriplet(S.flag, S.glyph, !!on[k], dx[k], dy[k]);
  }
  // skeleton: the file with the glyf and loca bytes cut out
  const cuts = [glyf, loca].sort((x, y) => x.off - y.off);
  const skel = new Out();
  let q = 0;
  for (const c of cuts) {
    skel.bytes(ttf.subarray(q, c.off));
    q = c.off + c.len;
  }
  skel.bytes(ttf.subarray(q));
  const out = new Out();
  out.u32(MAGIC);
  const fields = [glyf.off, glyf.len, loca.off, loca.len, ng, locaFormat, skel.n, ...STREAMS.map((k) => S[k].n)];
  out.u32(fields.length);
  for (const v of fields) out.u32(v);
  out.bytes(skel.done());
  for (const k of STREAMS) out.bytes(S[k].done());
  return out.done().slice();
}

/** The original TTF from a pack (byte for byte). */
export function unpackTtf(pack: Uint8Array): Uint8Array {
  const h = new In(pack);
  if (pack.length < 8 || h.u32() !== MAGIC) throw new Error("font pack expected");
  const nf = h.u32();
  if (nf !== 7 + STREAMS.length) throw new Error("font pack: unknown layout");
  const fields = Array.from({ length: nf }, () => h.u32());
  const [glyfOff, glyfLen, locaOff, locaLen, ng, locaFormat, skelLen] = fields;
  const skel = h.take(skelLen);
  const S = {} as Record<StreamName, In>;
  STREAMS.forEach((k, i) => (S[k] = new In(h.take(fields[7 + i]))));
  const glyf = new Out();
  const offs: number[] = [0];
  const on = new Uint8Array(65536), dx = new Int32Array(65536), dy = new Int32Array(65536);
  for (let i = 0; i < ng; i++) {
    const kind = S.kind.u8();
    if (kind === RAW) glyf.bytes(S.raw.take(S.rlen.u32()));
    else if (kind === COMPOSITE) {
      glyf.u16(S.nc.u16());
      for (let k = 0; k < 4; k++) glyf.u16(S.bbox.u16());
      glyf.bytes(S.comp.take(S.clen.u32()));
    } else if (kind === SIMPLE || kind === SIMPLE_BBOX) {
      const bb = kind === SIMPLE_BBOX ? [S.bbox.i16(), S.bbox.i16(), S.bbox.i16(), S.bbox.i16()] : null;
      const nc = S.nc.u16();
      const ends: number[] = [];
      let e = -1;
      for (let k = 0; k < nc; k++) ends.push((e += S.npts.u255()));
      const np = nc ? ends[nc - 1] + 1 : 0;
      if (np > 65535) throw new Error("font pack: bad glyph");
      const il = S.ilen.u255();
      const ins = S.ins.take(il);
      let X = 0, Y = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let k = 0; k < np; k++) {
        const [c, x, y] = readTriplet(S.flag.u8(), S.glyph);
        on[k] = c ? 1 : 0;
        dx[k] = x;
        dy[k] = y;
        X += x;
        Y += y;
        x0 = Math.min(x0, X), x1 = Math.max(x1, X), y0 = Math.min(y0, Y), y1 = Math.max(y1, Y);
      }
      glyf.u16(nc);
      for (const v of bb ?? [x0, y0, x1, y1]) glyf.u16(v & 0xffff);
      for (const v of ends) glyf.u16(v);
      glyf.u16(il);
      glyf.bytes(ins);
      encodePoints(glyf, on, dx, dy, np);
    } else if (kind !== EMPTY) throw new Error("font pack: bad glyph kind");
    offs.push(glyf.n);
  }
  if (glyf.n !== glyfLen) throw new Error("font pack: glyf size mismatch");
  const loca = new Out();
  for (const o of offs) locaFormat ? loca.u32(o) : loca.u16(o >> 1);
  if (loca.n !== locaLen) throw new Error("font pack: loca size mismatch");
  // splice glyf and loca back into the skeleton at their original offsets
  const total = skelLen + glyfLen + locaLen;
  const out = new Uint8Array(total);
  const cuts = [
    { off: glyfOff, b: glyf.done() },
    { off: locaOff, b: loca.done() },
  ].sort((x, y) => x.off - y.off);
  let s = 0, d = 0;
  for (const c of cuts) {
    const k = c.off - d;
    if (k < 0 || s + k > skelLen) throw new Error("font pack: bad table offsets");
    out.set(skel.subarray(s, s + k), d);
    s += k;
    d += k;
    out.set(c.b, d);
    d += c.b.length;
  }
  out.set(skel.subarray(s), d);
  // the restored table directory must point at the tables just spliced in (a wrong offset would otherwise give a
  // shifted, silently different file)
  const { t } = tables(out);
  if (t.glyf?.off !== glyfOff || t.glyf.len !== glyfLen || t.loca?.off !== locaOff || t.loca.len !== locaLen) throw new Error("font pack: table directory mismatch");
  return out;
}
