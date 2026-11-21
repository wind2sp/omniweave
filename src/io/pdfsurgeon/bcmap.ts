// PDF Surgeon — CID → Unicode for CJK fonts that have no ToUnicode (common in Illustrator files
// using Adobe-Korea1/Japan1/GB1/CNS1 CFF fonts). The Adobe "<Registry>-<Ordering>-UCS2" CMaps ship
// with pdfjs-dist in its packed binary form (.bcmap); this is a reader for that public format.
// The CMap bytes are provided by a loader (browser: bundled asset URLs, Node: the file system).

export type CMapLoader = (name: string) => Promise<Uint8Array | null>;

let loader: CMapLoader | null = null;
const cache = new Map<string, Promise<Map<number, string> | null>>();

export function setCMapLoader(fn: CMapLoader | null) {
  loader = fn;
  cache.clear();
}

export const CJK_ORDERINGS = ["Korea1", "Japan1", "GB1", "CNS1"];

/** CID → Unicode for an Adobe character collection, or null when no loader/CMap is available. */
export function loadUcs2(ordering: string): Promise<Map<number, string> | null> {
  const name = `Adobe-${ordering}-UCS2`;
  let p = cache.get(name);
  if (!p) {
    p = (async () => {
      if (!loader || !CJK_ORDERINGS.includes(ordering)) return null;
      const data = await loader(name);
      return data ? readBcmap(data) : null;
    })().catch(() => null);
    cache.set(name, p);
  }
  return p;
}

class Reader {
  pos = 0;
  constructor(readonly b: Uint8Array) {}
  byte(): number {
    return this.pos < this.b.length ? this.b[this.pos++] : -1;
  }
  number(): number {
    let n = 0;
    for (;;) {
      const b = this.byte();
      if (b < 0) throw new Error("bcmap: unexpected end");
      n = n * 128 + (b & 0x7f);
      if (!(b & 0x80)) return n;
    }
  }
  signed(): number {
    const n = this.number();
    return n & 1 ? -Math.floor(n / 2) - 1 : Math.floor(n / 2);
  }
  hex(out: Uint8Array, size: number) {
    out.set(this.b.subarray(this.pos, this.pos + size + 1));
    this.pos += size + 1;
  }
  hexNumber(out: Uint8Array, size: number) {
    const stack: number[] = [];
    for (;;) {
      const b = this.byte();
      if (b < 0) throw new Error("bcmap: unexpected end");
      stack.push(b & 0x7f);
      if (!(b & 0x80)) break;
    }
    let i = size, buf = 0, bits = 0;
    while (i >= 0) {
      while (bits < 8 && stack.length) {
        buf |= stack.pop()! << bits;
        bits += 7;
      }
      out[i--] = buf & 255;
      buf >>= 8;
      bits -= 8;
    }
  }
  hexSigned(out: Uint8Array, size: number) {
    this.hexNumber(out, size);
    const sign = out[size] & 1 ? 255 : 0;
    let c = 0;
    for (let i = 0; i <= size; i++) {
      c = ((c & 1) << 8) | out[i];
      out[i] = (c >> 1) ^ sign;
    }
  }
  string(): string {
    const n = this.number();
    let s = "";
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.number());
    return s;
  }
}

const toInt = (a: Uint8Array, size: number) => {
  let n = 0;
  for (let i = 0; i <= size; i++) n = n * 256 + a[i];
  return n;
};
const add = (a: Uint8Array, b: Uint8Array, size: number) => {
  let c = 0;
  for (let i = size; i >= 0; i--) {
    c += a[i] + b[i];
    a[i] = c & 255;
    c >>= 8;
  }
};
const inc = (a: Uint8Array, size: number) => {
  let c = 1;
  for (let i = size; i >= 0 && c > 0; i--) {
    c += a[i];
    a[i] = c & 255;
    c >>= 8;
  }
};
/** destination bytes are UTF-16BE */
const utf16 = (a: Uint8Array, size: number) => {
  let s = "";
  for (let i = 0; i + 1 <= size; i += 2) s += String.fromCharCode((a[i] << 8) | a[i + 1]);
  return s;
};

export function readBcmap(data: Uint8Array): Map<number, string> {
  const r = new Reader(data);
  const out = new Map<number, string>();
  const MAX = 16;
  const start = new Uint8Array(MAX), end = new Uint8Array(MAX), ch = new Uint8Array(MAX), code = new Uint8Array(MAX), tmp = new Uint8Array(MAX);
  r.byte(); // header
  const bfRange = (lo: number, hi: number, dst: string) => {
    const last = dst.charCodeAt(dst.length - 1);
    for (let c = lo; c <= hi && c - lo < 65536; c++) out.set(c, dst.slice(0, -1) + String.fromCharCode((last + (c - lo)) & 0xffff));
  };
  for (let b = r.byte(); b >= 0; b = r.byte()) {
    const type = b >> 5;
    if (type === 7) {
      if ((b & 0x1f) <= 1) r.string();
      continue;
    }
    const seq = !!(b & 0x10);
    const ds = b & 15;
    if (ds + 1 > MAX) throw new Error("bcmap: bad size");
    const items = r.number();
    switch (type) {
      case 0: // codespacerange
        r.hex(start, ds);
        r.hexNumber(end, ds);
        add(end, start, ds);
        for (let i = 1; i < items; i++) {
          inc(end, ds);
          r.hexNumber(start, ds);
          add(start, end, ds);
          r.hexNumber(end, ds);
          add(end, start, ds);
        }
        break;
      case 1: // notdefrange
        r.hex(start, ds);
        r.hexNumber(end, ds);
        add(end, start, ds);
        r.number();
        for (let i = 1; i < items; i++) {
          inc(end, ds);
          r.hexNumber(start, ds);
          add(start, end, ds);
          r.hexNumber(end, ds);
          add(end, start, ds);
          r.number();
        }
        break;
      case 2: {
        // cidchar (not used by UCS2 maps; parsed to stay in sync)
        r.hex(ch, ds);
        let c = r.number();
        for (let i = 1; i < items; i++) {
          inc(ch, ds);
          if (!seq) {
            r.hexNumber(tmp, ds);
            add(ch, tmp, ds);
          }
          c = r.signed() + (c + 1);
        }
        break;
      }
      case 3: // cidrange
        r.hex(start, ds);
        r.hexNumber(end, ds);
        add(end, start, ds);
        r.number();
        for (let i = 1; i < items; i++) {
          inc(end, ds);
          if (!seq) {
            r.hexNumber(start, ds);
            add(start, end, ds);
          } else start.set(end);
          r.hexNumber(end, ds);
          add(end, start, ds);
          r.number();
        }
        break;
      case 4: // bfchar: 2-byte source, (ds+1)-byte destination
        r.hex(ch, 1);
        r.hex(code, ds);
        out.set(toInt(ch, 1), utf16(code, ds));
        for (let i = 1; i < items; i++) {
          inc(ch, 1);
          if (!seq) {
            r.hexNumber(tmp, 1);
            add(ch, tmp, 1);
          }
          inc(code, ds);
          r.hexSigned(tmp, ds);
          add(code, tmp, ds);
          out.set(toInt(ch, 1), utf16(code, ds));
        }
        break;
      case 5: // bfrange
        r.hex(start, 1);
        r.hexNumber(end, 1);
        add(end, start, 1);
        r.hex(code, ds);
        bfRange(toInt(start, 1), toInt(end, 1), utf16(code, ds));
        for (let i = 1; i < items; i++) {
          inc(end, 1);
          if (!seq) {
            r.hexNumber(start, 1);
            add(start, end, 1);
          } else start.set(end);
          r.hexNumber(end, 1);
          add(end, start, 1);
          r.hex(code, ds);
          bfRange(toInt(start, 1), toInt(end, 1), utf16(code, ds));
        }
        break;
      default:
        throw new Error("bcmap: unknown record");
    }
  }
  return out;
}
