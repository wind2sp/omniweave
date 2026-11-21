// DWG bit stream reader: the packed value types of the DWG object stream (B, BB, 3B, BS, BL, BLL, BD, RC, RS, RL, RD,
// MC, MS, H, TV, DD, BT, BE, CMC), as described in the Open Design Alliance's public "Open Design Specification for
// .dwg files" (chapter 2, bit codes). Written from that description; no code from other DWG readers.
// Stage 2 (docs/design/CAD_IMPORT.md §6): the object reader will build on this.

export class BitReader {
  /** bit position */
  pos = 0;
  /** bit position where this stream's part of the object ends (counts are checked against it, reads are not) */
  end = Infinity;
  constructor(public b: Uint8Array, byteOffset = 0) {
    this.pos = byteOffset * 8;
  }
  get byte() {
    return this.pos >> 3;
  }
  bitsLeft() {
    return this.b.length * 8 - this.pos;
  }
  /**
   * A count read from the file, checked before it drives a loop: `n` items of at least `bits` bits each must fit in
   * what is left of the object (or the buffer). A damaged count would otherwise read zeros past the end for billions of
   * rounds (hang) or allocate without bound — it throws instead, and the object is reported as a problem.
   */
  room(n: number, bits: number): number {
    if (!(n >= 0) || n * bits > Math.min(this.end, this.b.length * 8) - this.pos) throw new Error("DWG_COUNT");
    return n;
  }
  /** B: one bit */
  B(): number {
    const v = (this.b[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  /** n raw bits, most significant first */
  bits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.B();
    return v;
  }
  /** BB: two bits */
  BB(): number {
    return this.bits(2);
  }
  /** 3B: 1–3 bits, stops at the first 0 (R2007+ only) */
  B3(): number {
    let v = 0;
    for (let i = 0; i < 3; i++) {
      const bit = this.B();
      v = (v << 1) | bit;
      if (!bit) break;
    }
    return v;
  }
  /** RC: raw char (8 bits, possibly unaligned) */
  RC(): number {
    if ((this.pos & 7) === 0) {
      const v = this.b[this.pos >> 3];
      this.pos += 8;
      return v;
    }
    return this.bits(8);
  }
  /** RS: raw short, little-endian */
  RS(): number {
    const lo = this.RC();
    return lo | (this.RC() << 8);
  }
  /** RL: raw long, little-endian */
  RL(): number {
    const lo = this.RS();
    return (lo | (this.RS() << 16)) >>> 0;
  }
  /** RD: raw double */
  RD(): number {
    const tmp = new Uint8Array(8);
    for (let i = 0; i < 8; i++) tmp[i] = this.RC();
    return new DataView(tmp.buffer).getFloat64(0, true);
  }
  /** BS: bitshort — 00 short follows, 01 char follows, 10 = 0, 11 = 256 */
  BS(): number {
    switch (this.BB()) {
      case 0: {
        const v = this.RS();
        return v & 0x8000 ? v - 0x10000 : v;
      }
      case 1:
        return this.RC();
      case 2:
        return 0;
      default:
        return 256;
    }
  }
  /** BL: bitlong — 00 long follows, 01 char follows, 10 = 0, 11 unused */
  BL(): number {
    switch (this.BB()) {
      case 0:
        return this.RL() | 0;
      case 1:
        return this.RC();
      default:
        return 0;
    }
  }
  /** BLL: bitlonglong — 3 bits of byte count, then that many bytes little-endian */
  BLL(): number {
    const n = this.bits(3);
    let v = 0;
    for (let i = 0; i < n; i++) v += this.RC() * 2 ** (8 * i);
    return v;
  }
  /** BD: bitdouble — 00 double follows, 01 = 1.0, 10 = 0.0 */
  BD(): number {
    switch (this.BB()) {
      case 0:
        return this.RD();
      case 1:
        return 1;
      default:
        return 0;
    }
  }
  /** DD: bitdouble with default — 00 = default, 01 low 4 bytes patched, 10 bytes 4,5 + low 4 patched, 11 full double */
  DD(def: number): number {
    const code = this.BB();
    if (code === 0) return def;
    if (code === 3) return this.RD();
    const tmp = new Uint8Array(8);
    new DataView(tmp.buffer).setFloat64(0, def, true);
    if (code === 2) {
      tmp[4] = this.RC();
      tmp[5] = this.RC();
    }
    for (let i = 0; i < 4; i++) tmp[i] = this.RC();
    return new DataView(tmp.buffer).getFloat64(0, true);
  }
  /** BT: bit thickness (R2000+: 1 = 0.0, else BD) */
  BT(): number {
    return this.B() ? 0 : this.BD();
  }
  /** BE: bit extrusion (R2000+: 1 = (0,0,1), else 3 BD) */
  BE(): [number, number, number] {
    return this.B() ? [0, 0, 1] : [this.BD(), this.BD(), this.BD()];
  }
  /** MC: modular char — 7 bits per byte, high bit = more; the last byte's 0x40 is the sign */
  MC(): number {
    let v = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.RC();
      if (c & 0x80) {
        v += (c & 0x7f) * 2 ** shift;
        shift += 7;
        continue;
      }
      const neg = c & 0x40;
      v += (c & 0x3f) * 2 ** shift;
      return neg ? -v : v;
    }
    return v;
  }
  /** unsigned modular char (handle stream sizes) */
  UMC(): number {
    let v = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const c = this.RC();
      v += (c & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(c & 0x80)) break;
    }
    return v;
  }
  /** MS: modular short — 15 bits per short, high bit = more */
  MS(): number {
    let v = 0, shift = 0;
    for (let i = 0; i < 4; i++) {
      const s = this.RS();
      v += (s & 0x7fff) * 2 ** shift;
      shift += 15;
      if (!(s & 0x8000)) break;
    }
    return v;
  }
  /** H: handle reference — code (4 bits), counter (4 bits), then that many bytes big-endian */
  H(): { code: number; value: number } {
    const code = this.bits(4), n = this.bits(4);
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 256 + this.RC();
    return { code, value };
  }
  /** TV: text (R2004 and earlier) — BS length, then bytes in the drawing's code page */
  TV(dec: TextDecoder): string {
    const n = this.BS();
    const tmp = new Uint8Array(Math.max(0, n));
    for (let i = 0; i < n; i++) tmp[i] = this.RC();
    return dec.decode(tmp).replace(/\0+$/, "");
  }
  /** TU: unicode text (R2007+) — BS length in UTF-16 units */
  TU(): string {
    const n = this.BS();
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.RS());
    return s.replace(/\0+$/, "");
  }
  /** CMC: colour (R2004+: BS index, BL rgb, RC name flags + names) */
  CMC(dec: TextDecoder, r2004: boolean): { aci: number; rgb?: number } {
    const aci = this.BS();
    if (!r2004) return { aci };
    const rgb = this.BL();
    const flags = this.RC();
    if (flags & 1) this.TV(dec);
    if (flags & 2) this.TV(dec);
    // high byte: 0xC2 true colour, 0xC3 colour index in the low byte, 0xC1 BYLAYER, 0xC0 BYBLOCK
    const type = (rgb >>> 24) & 0xff;
    if (type === 0xc2) return { aci, rgb: rgb & 0xffffff };
    if (type === 0xc3) return { aci: aci < 0 ? -(rgb & 0xff) : rgb & 0xff || aci };
    if (type === 0xc1) return { aci: 256 };
    if (type === 0xc0) return { aci: 0 };
    return { aci };
  }
}
