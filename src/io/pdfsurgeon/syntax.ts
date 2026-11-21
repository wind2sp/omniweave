// PDF Surgeon — lexical layer (ISO 32000-1 §7.2–7.3).
// One lexer serves both content streams (operands + operators) and indirect objects (with refs),
// and every token keeps its byte range so edits can splice the original bytes.

export class PdfName {
  /** raw name bytes as a latin1 string, #xx escapes resolved */
  constructor(readonly name: string) {}
}
export class PdfStr {
  constructor(readonly bytes: Uint8Array, readonly hex: boolean) {}
}
export class PdfRef {
  constructor(readonly num: number, readonly gen: number) {}
}
export class PdfDict {
  readonly map = new Map<string, PdfVal>();
  get(k: string): PdfVal | undefined {
    return this.map.get(k);
  }
}
export type PdfVal = number | boolean | null | PdfName | PdfStr | PdfRef | PdfDict | PdfVal[];

export class SyntaxError_ extends Error {
  constructor(msg: string, readonly pos: number) {
    super(`${msg} (offset ${pos})`);
  }
}

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of "()<>[]{}/%") DELIM[c.charCodeAt(0)] = 1;

export const isWhite = (c: number) => WS[c] === 1;
export const isDelim = (c: number) => DELIM[c] === 1;
const isRegular = (c: number) => !WS[c] && !DELIM[c];

export type Tok =
  | { k: "val"; v: PdfVal; s: number; e: number }
  | { k: "kw"; v: string; s: number; e: number }
  | { k: "["; s: number; e: number }
  | { k: "]"; s: number; e: number }
  | { k: "<<"; s: number; e: number }
  | { k: ">>"; s: number; e: number }
  | { k: "eof"; s: number; e: number };

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/;

export class Lexer {
  pos: number;
  constructor(readonly b: Uint8Array, start = 0, readonly end = b.length) {
    this.pos = start;
  }

  skipWs() {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS[c]) this.pos++;
      else if (c === 0x25) {
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  next(): Tok {
    this.skipWs();
    const b = this.b;
    const s = this.pos;
    if (s >= this.end) return { k: "eof", s, e: s };
    const c = b[s];
    if (c === 0x5b) return (this.pos++, { k: "[", s, e: this.pos });
    if (c === 0x5d) return (this.pos++, { k: "]", s, e: this.pos });
    if (c === 0x7b || c === 0x7d) return (this.pos++, { k: "kw", v: String.fromCharCode(c), s, e: this.pos });
    if (c === 0x3c) {
      if (b[s + 1] === 0x3c) return ((this.pos += 2), { k: "<<", s, e: this.pos });
      return { k: "val", v: this.hexString(), s, e: this.pos };
    }
    if (c === 0x3e) {
      if (b[s + 1] === 0x3e) return ((this.pos += 2), { k: ">>", s, e: this.pos });
      this.pos++;
      return { k: "kw", v: ">", s, e: this.pos };
    }
    if (c === 0x28) return { k: "val", v: this.literalString(), s, e: this.pos };
    if (c === 0x29) return (this.pos++, { k: "kw", v: ")", s, e: this.pos });
    if (c === 0x2f) return { k: "val", v: this.name(), s, e: this.pos };
    let p = s;
    while (p < this.end && isRegular(b[p])) p++;
    this.pos = p;
    const word = latin1(b, s, p);
    if (NUM_RE.test(word)) return { k: "val", v: parseFloat(word), s, e: p };
    if (word === "true") return { k: "val", v: true, s, e: p };
    if (word === "false") return { k: "val", v: false, s, e: p };
    if (word === "null") return { k: "val", v: null, s, e: p };
    // lenient numbers seen in the wild ("--5", "1.2.3", "-.5-"): readers treat them as numbers
    if (/^[+-]*[\d.]+[-\d.]*$/.test(word)) {
      const n = parseFloat(word.replace(/^[+-]+/, (m) => (m.includes("-") ? "-" : "")));
      return { k: "val", v: Number.isFinite(n) ? n : 0, s, e: p };
    }
    return { k: "kw", v: word, s, e: p };
  }

  private name(): PdfName {
    const b = this.b;
    let p = this.pos + 1;
    let out = "";
    while (p < this.end && isRegular(b[p])) {
      if (b[p] === 0x23 && p + 2 < this.end && isHex(b[p + 1]) && isHex(b[p + 2])) {
        out += String.fromCharCode(parseInt(String.fromCharCode(b[p + 1], b[p + 2]), 16));
        p += 3;
      } else out += String.fromCharCode(b[p++]);
    }
    this.pos = p;
    return new PdfName(out);
  }

  private hexString(): PdfStr {
    const b = this.b;
    let p = this.pos + 1;
    const digits: number[] = [];
    while (p < this.end && b[p] !== 0x3e) {
      const c = b[p++];
      if (isHex(c)) digits.push(hexVal(c));
      else if (!WS[c]) throw new SyntaxError_("bad hex string", p - 1);
    }
    if (p >= this.end) throw new SyntaxError_("unterminated hex string", this.pos);
    this.pos = p + 1;
    if (digits.length % 2) digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = (digits[2 * i] << 4) | digits[2 * i + 1];
    return new PdfStr(out, true);
  }

  private literalString(): PdfStr {
    const b = this.b;
    let p = this.pos + 1;
    let depth = 1;
    const out: number[] = [];
    while (p < this.end) {
      const c = b[p++];
      if (c === 0x5c) {
        if (p >= this.end) break;
        const d = b[p++];
        if (d === 0x6e) out.push(10);
        else if (d === 0x72) out.push(13);
        else if (d === 0x74) out.push(9);
        else if (d === 0x62) out.push(8);
        else if (d === 0x66) out.push(12);
        else if (d === 13) {
          if (b[p] === 10) p++;
        } else if (d === 10) {
          /* line continuation */
        } else if (d >= 0x30 && d <= 0x37) {
          let v = d - 0x30;
          for (let i = 0; i < 2 && b[p] >= 0x30 && b[p] <= 0x37; i++) v = v * 8 + (b[p++] - 0x30);
          out.push(v & 0xff);
        } else out.push(d);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) {
          this.pos = p;
          return new PdfStr(Uint8Array.from(out), false);
        }
        out.push(c);
      } else out.push(c);
    }
    throw new SyntaxError_("unterminated string", this.pos);
  }
}

const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const hexVal = (c: number) => (c <= 57 ? c - 48 : (c | 32) - 87);

export function latin1(b: Uint8Array, s = 0, e = b.length): string {
  let out = "";
  for (let i = s; i < e; i += 8192) out += String.fromCharCode(...b.subarray(i, Math.min(e, i + 8192)));
  return out;
}

export function fromLatin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

// ───────── objects ─────────

/** Parse one value; `refs` enables the `n g R` form (object syntax, not content streams). */
export function parseValue(lx: Lexer, refs: boolean, first?: Tok): PdfVal {
  const t = first ?? lx.next();
  switch (t.k) {
    case "val":
      if (refs && typeof t.v === "number" && Number.isInteger(t.v) && t.v >= 0) {
        const save = lx.pos;
        const t2 = lx.next();
        if (t2.k === "val" && typeof t2.v === "number" && Number.isInteger(t2.v)) {
          const t3 = lx.next();
          if (t3.k === "kw" && t3.v === "R") return new PdfRef(t.v, t2.v);
        }
        lx.pos = save;
      }
      return t.v;
    case "[": {
      const arr: PdfVal[] = [];
      for (;;) {
        const n = lx.next();
        if (n.k === "]") return arr;
        if (n.k === "eof") throw new SyntaxError_("unterminated array", t.s);
        if (n.k === "kw" || n.k === ">>") continue; // tolerate junk inside arrays
        arr.push(parseValue(lx, refs, n));
      }
    }
    case "<<": {
      const d = new PdfDict();
      for (;;) {
        const k = lx.next();
        if (k.k === ">>") return d;
        if (k.k === "eof") throw new SyntaxError_("unterminated dictionary", t.s);
        if (k.k !== "val" || !(k.v instanceof PdfName)) continue; // skip junk keys
        const vt = lx.next();
        if (vt.k === ">>") {
          d.map.set(k.v.name, null);
          return d;
        }
        d.map.set(k.v.name, parseValue(lx, refs, vt));
      }
    }
    case "kw":
      return null;
    default:
      throw new SyntaxError_(`unexpected ${t.k}`, t.s);
  }
}

// ───────── content stream operations ─────────

export interface Op {
  op: string;
  args: PdfVal[];
  /** byte range of the whole operation (first operand .. end of operator) */
  s: number;
  e: number;
  /** BI … EI: byte range of the image data */
  data?: [number, number];
}

/** Tokenise a content stream into operations. Throws SyntaxError_ on unrecoverable syntax. */
export function parseOps(b: Uint8Array): Op[] {
  const lx = new Lexer(b);
  const ops: Op[] = [];
  let args: PdfVal[] = [];
  let argStart = -1;
  for (;;) {
    const t = lx.next();
    if (t.k === "eof") break;
    if (t.k === "kw") {
      const s = argStart >= 0 ? argStart : t.s;
      if (t.v === "BI") {
        ops.push(inlineImage(lx, b, s));
      } else ops.push({ op: t.v, args, s, e: t.e });
      args = [];
      argStart = -1;
      continue;
    }
    if (t.k === "]" || t.k === ">>") continue; // stray closers
    if (argStart < 0) argStart = t.s;
    args.push(parseValue(lx, false, t));
  }
  return ops;
}

function inlineImage(lx: Lexer, b: Uint8Array, s: number): Op {
  const dict = new PdfDict();
  for (;;) {
    const t = lx.next();
    if (t.k === "eof") throw new SyntaxError_("unterminated inline image", s);
    if (t.k === "kw" && t.v === "ID") break;
    if (t.k === "val" && t.v instanceof PdfName) dict.map.set(t.v.name, parseValue(lx, false));
  }
  const d0 = lx.pos + 1; // single white-space after ID
  let p = d0;
  for (;;) {
    p = indexOfEI(b, p);
    if (p < 0) throw new SyntaxError_("inline image without EI", s);
    if (looksLikeOperators(b, p + 3)) break;
    p += 2;
  }
  lx.pos = p + 3;
  return { op: "BI", args: [dict], s, e: p + 3, data: [d0, p] };
}

/** position of the white-space byte before "EI" */
function indexOfEI(b: Uint8Array, from: number): number {
  for (let i = from; i + 2 < b.length; i++) {
    if (WS[b[i]] && b[i + 1] === 0x45 && b[i + 2] === 0x49 && (i + 3 >= b.length || WS[b[i + 3]] || DELIM[b[i + 3]])) return i;
  }
  return -1;
}

function looksLikeOperators(b: Uint8Array, from: number): boolean {
  const end = Math.min(b.length, from + 48);
  for (let i = from; i < end; i++) if (b[i] > 0x7e || (b[i] < 0x20 && !WS[b[i]])) return false;
  return true;
}

// ───────── serialisation ─────────

const fmtNum = (n: number) => {
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "");
  return s === "-0" ? "0" : s;
};
export const num = fmtNum;

function nameOut(n: string): string {
  let out = "/";
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    out += c > 0x20 && c < 0x7f && c !== 0x23 && isRegular(c) ? n[i] : "#" + c.toString(16).padStart(2, "0");
  }
  return out;
}

export function hexOf(bytes: Uint8Array): string {
  let s = "<";
  for (const x of bytes) s += x.toString(16).padStart(2, "0");
  return s + ">";
}

/** Serialise a value as latin1 PDF syntax (strings always hex — unambiguous and binary-safe). */
export function serialize(v: PdfVal): string {
  if (v === null) return "null";
  if (typeof v === "number") return fmtNum(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof PdfName) return nameOut(v.name);
  if (v instanceof PdfStr) return hexOf(v.bytes);
  if (v instanceof PdfRef) return `${v.num} ${v.gen} R`;
  if (v instanceof PdfDict) {
    let s = "<<";
    for (const [k, x] of v.map) s += `${nameOut(k)} ${serialize(x)} `;
    return s + ">>";
  }
  return "[" + v.map(serialize).join(" ") + "]";
}
