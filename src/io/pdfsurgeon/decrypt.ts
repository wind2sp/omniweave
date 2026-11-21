// PDF Surgeon — turn an encrypted PDF into an equivalent plain PDF (Standard Security Handler).
// We do not rely on the cross-reference table: objects are found by scanning "n g obj" headers
// in file order (later definitions win, as with incremental updates), which also survives
// damaged xrefs. Object streams are decrypted, expanded and inlined. The output has a fresh
// classic xref table; content bytes are unchanged apart from decryption.

import { t as tr } from "../../i18n";
import { aesDecryptPdf, authenticate, objectKey, rc4, type SecurityParams } from "./crypto";
import { decodeFilters, filtersOf } from "./filters";
import { Lexer, PdfDict, PdfName, PdfRef, PdfStr, latin1, parseValue, serialize, type PdfVal } from "./syntax";

export class PasswordError extends Error {
  constructor() {
    super(tr("engine.pdf.wrongPassword"));
  }
}
export class UnsupportedSecurityError extends Error {}

interface RawObj {
  num: number;
  gen: number;
  value: PdfVal;
  /** stream payload (still encrypted) */
  stream?: Uint8Array;
  /** set for objects that came out of an object stream (never individually encrypted) */
  fromObjStm?: boolean;
}

export interface EncryptionInfo {
  V: number;
  R: number;
  /** "RC4" | "AESV2" | "AESV3" | "Identity" for streams */
  method: string;
  keyBits: number;
  P: number;
  /** the password that opened it was the owner password */
  asOwner: boolean;
  /** permission bit 4: modify contents */
  canModify: boolean;
}

const OBJ_RE = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;

/** Scan every indirect object in file order. Damaged objects are skipped, never guessed. */
export function scanObjects(b: Uint8Array): { objs: Map<number, RawObj>; trailers: PdfDict[] } {
  const text = latin1(b);
  const objs = new Map<number, RawObj>();
  const trailers: PdfDict[] = [];
  const pending: { o: RawObj; dataStart: number }[] = [];
  OBJ_RE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = OBJ_RE.exec(text)); ) {
    if (m.index > 0 && /[0-9A-Za-z]/.test(text[m.index - 1])) continue;
    const lx = new Lexer(b, m.index + m[0].length);
    let value: PdfVal;
    try {
      value = parseValue(lx, true);
    } catch {
      continue;
    }
    const o: RawObj = { num: +m[1], gen: +m[2], value };
    const save = lx.pos;
    const t = lx.next();
    if (t.k === "kw" && t.v === "stream" && value instanceof PdfDict) {
      let p = t.e;
      if (b[p] === 13) p++;
      if (b[p] === 10) p++;
      pending.push({ o, dataStart: p });
      // skip over the payload when its length is known, so bytes inside it are never taken for headers
      const len = value.get("Length");
      if (typeof len === "number" && len > 0 && p + len <= b.length) lx.pos = p + len;
    } else lx.pos = save;
    objs.set(o.num, o);
    OBJ_RE.lastIndex = Math.max(OBJ_RE.lastIndex, lx.pos);
  }
  for (const { o, dataStart } of pending) o.stream = streamData(b, text, o.value as PdfDict, dataStart, objs);
  for (const m of text.matchAll(/trailer\s*<</g)) {
    try {
      const v = parseValue(new Lexer(b, m.index! + 7), true);
      if (v instanceof PdfDict) trailers.push(v);
    } catch {
      /* damaged trailer: ignore, xref-stream dictionaries below also count */
    }
  }
  for (const o of objs.values()) if (o.stream && o.value instanceof PdfDict && nameOf(o.value.get("Type")) === "XRef") trailers.push(o.value);
  return { objs, trailers };
}

function streamData(b: Uint8Array, text: string, dict: PdfDict, start: number, objs: Map<number, RawObj>): Uint8Array {
  let len = dict.get("Length");
  if (len instanceof PdfRef) len = objs.get(len.num)?.value;
  if (typeof len === "number" && len >= 0 && start + len <= b.length) {
    const after = latin1(b, start + len, Math.min(b.length, start + len + 12));
    if (/^\s*endstream/.test(after)) return b.subarray(start, start + len);
  }
  // Length missing or wrong: the data ends before "endstream" (minus its EOL)
  let end = text.indexOf("endstream", start);
  if (end < 0) end = b.length;
  if (b[end - 1] === 10) end--;
  if (b[end - 1] === 13) end--;
  return b.subarray(start, Math.max(start, end));
}

const nameOf = (v: PdfVal | undefined) => (v instanceof PdfName ? v.name : undefined);
const bytesOf = (v: PdfVal | undefined) => (v instanceof PdfStr ? v.bytes : undefined);

function resolve(v: PdfVal | undefined, objs: Map<number, RawObj>): PdfVal | undefined {
  return v instanceof PdfRef ? objs.get(v.num)?.value : v;
}

function securityParams(enc: PdfDict, id0: Uint8Array): SecurityParams & { stmMethod: string; strMethod: string } {
  if (nameOf(enc.get("Filter")) !== "Standard") throw new UnsupportedSecurityError(tr("engine.pdf.securityHandler", { name: nameOf(enc.get("Filter")) ?? "?" }));
  const V = Number(enc.get("V") ?? 0), R = Number(enc.get("R") ?? 2);
  const O = bytesOf(enc.get("O")), U = bytesOf(enc.get("U"));
  if (!O || !U) throw new UnsupportedSecurityError(tr("engine.pdf.noOU"));
  let stm = "RC4", str = "RC4";
  let keyLen = V === 1 ? 5 : Math.round(Number(enc.get("Length") ?? 40) / 8);
  if (V >= 4) {
    const cf = enc.get("CF");
    const method = (name: string | undefined) => {
      if (!name || name === "Identity") return "Identity";
      const f = cf instanceof PdfDict ? cf.get(name) : undefined;
      const cfm = f instanceof PdfDict ? nameOf(f.get("CFM")) : undefined;
      if (f instanceof PdfDict && typeof f.get("Length") === "number" && V === 4) {
        const l = f.get("Length") as number;
        keyLen = l > 32 ? l / 8 : l; // some writers give bits, some bytes
      }
      return cfm === "AESV2" ? "AESV2" : cfm === "AESV3" ? "AESV3" : cfm === "None" ? "Identity" : "RC4";
    };
    stm = method(nameOf(enc.get("StmF")));
    str = method(nameOf(enc.get("StrF")));
  }
  if (V === 4 && (stm === "AESV2" || str === "AESV2")) keyLen = 16;
  if (keyLen < 5 || keyLen > 16) keyLen = 16;
  const em = enc.get("EncryptMetadata");
  return { V, R, keyLen, O, U, OE: bytesOf(enc.get("OE")), UE: bytesOf(enc.get("UE")), P: Number(enc.get("P") ?? -1) | 0, id0, encryptMetadata: em !== false, stmMethod: stm, strMethod: str };
}

/** Values from the newest trailer win; older trailers fill in what is missing. */
function mergedTrailer(trailers: PdfDict[]): PdfDict {
  const out = new PdfDict();
  for (let i = trailers.length - 1; i >= 0; i--) for (const [k, v] of trailers[i].map) if (!out.map.has(k)) out.map.set(k, v);
  return out;
}

export function isEncrypted(b: Uint8Array): boolean {
  const { trailers } = scanObjects(b);
  return !!mergedTrailer(trailers).get("Encrypt");
}

/**
 * Decrypt `bytes` with `password` ("" for documents that only have an owner password).
 * Throws PasswordError when the password is wrong, UnsupportedSecurityError for other handlers.
 */
export async function decryptPdf(bytes: Uint8Array, password: string): Promise<{ plain: Uint8Array; info: EncryptionInfo }> {
  const { objs, trailers } = scanObjects(bytes);
  const trailer = mergedTrailer(trailers);
  const encRef = trailer.get("Encrypt");
  const enc = resolve(encRef, objs);
  if (!(enc instanceof PdfDict)) throw new UnsupportedSecurityError(tr("engine.pdf.noEncryptDict"));
  const ids = trailer.get("ID");
  const id0 = Array.isArray(ids) && ids[0] instanceof PdfStr ? ids[0].bytes : new Uint8Array(0);
  const sp = securityParams(enc, id0);
  const auth = await authenticate(sp, password);
  if (!auth) throw new PasswordError();
  const encNum = encRef instanceof PdfRef ? encRef.num : -1;

  const decryptBytes = async (data: Uint8Array, num: number, gen: number, method: string) => {
    if (method === "Identity") return data;
    if (method === "AESV3") return aesDecryptPdf(auth.key, data);
    const k = objectKey(auth.key, num, gen, method === "AESV2");
    return method === "AESV2" ? aesDecryptPdf(k, data) : rc4(k, data);
  };
  const walk = async (v: PdfVal, num: number, gen: number): Promise<PdfVal> => {
    if (v instanceof PdfStr) return new PdfStr(await decryptBytes(v.bytes, num, gen, sp.strMethod), v.hex);
    if (Array.isArray(v)) {
      const out: PdfVal[] = [];
      for (const x of v) out.push(await walk(x, num, gen));
      return out;
    }
    if (v instanceof PdfDict) {
      const d = new PdfDict();
      for (const [k, x] of v.map) d.map.set(k, await walk(x, num, gen));
      return d;
    }
    return v;
  };

  const out = new Map<number, RawObj>();
  const order = [...objs.values()];
  for (const o of order) {
    if (o.num === encNum) continue;
    const dict = o.value instanceof PdfDict ? o.value : null;
    const type = dict ? nameOf(dict.get("Type")) : undefined;
    if (o.stream && type === "XRef") continue; // cross-reference streams are never encrypted and are rebuilt
    const value = await walk(o.value, o.num, o.gen);
    let stream = o.stream;
    if (stream && dict) {
      const filters = filtersOf(dict.get("Filter"), dict.get("DecodeParms"));
      const identityCrypt = filters.some((f) => f.name === "Crypt" && (!f.parms || nameOf(f.parms.get("Name")) === "Identity"));
      const plainMeta = type === "Metadata" && !sp.encryptMetadata;
      if (!identityCrypt && !plainMeta) stream = await decryptBytes(stream, o.num, o.gen, sp.stmMethod);
      // walk() decrypted strings in the stream dictionary too (allowed by the spec: they are encrypted)
      if (type === "ObjStm") {
        expandObjStm(value as PdfDict, stream, out);
        continue;
      }
    }
    out.set(o.num, { num: o.num, gen: o.gen, value, stream });
  }
  const info: EncryptionInfo = {
    V: sp.V,
    R: sp.R,
    method: sp.stmMethod,
    keyBits: sp.R >= 5 ? 256 : sp.keyLen * 8,
    P: sp.P,
    asOwner: auth.asOwner,
    canModify: auth.asOwner || (sp.P & 8) !== 0,
  };
  const t = new PdfDict();
  for (const k of ["Root", "Info", "ID"]) if (trailer.get(k) !== undefined) t.map.set(k, trailer.get(k)!);
  return { plain: writePlain(out, t, versionOf(bytes)), info };
}

function expandObjStm(dict: PdfDict, data: Uint8Array, out: Map<number, RawObj>) {
  const decoded = decodeFilters(data, filtersOf(dict.get("Filter"), dict.get("DecodeParms")));
  const n = Number(dict.get("N") ?? 0), first = Number(dict.get("First") ?? 0);
  const head = new Lexer(decoded, 0, first);
  const pairs: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = head.next(), b = head.next();
    if (a.k !== "val" || b.k !== "val" || typeof a.v !== "number" || typeof b.v !== "number") break;
    pairs.push([a.v, b.v]);
  }
  for (const [num, off] of pairs) {
    if (out.has(num) && !out.get(num)!.fromObjStm) continue; // a direct (newer) definition wins
    try {
      const value = parseValue(new Lexer(decoded, first + off), true);
      out.set(num, { num, gen: 0, value, fromObjStm: true });
    } catch {
      /* damaged member object: leave it out rather than invent content */
    }
  }
}

function versionOf(b: Uint8Array): string {
  const m = /^%PDF-(\d\.\d)/.exec(latin1(b, 0, Math.min(16, b.length)));
  return m ? m[1] : "1.7";
}

const enc = new TextEncoder();

function writePlain(objs: Map<number, RawObj>, trailer: PdfDict, version: string): Uint8Array {
  const parts: Uint8Array[] = [];
  let size = 0;
  const push = (p: Uint8Array) => (parts.push(p), (size += p.length));
  const ascii = (s: string) => push(latin1Bytes(s));
  push(enc.encode(`%PDF-${version}\n%`));
  push(Uint8Array.from([0xe2, 0xe3, 0xcf, 0xd3, 10]));
  const offsets = new Map<number, [number, number]>();
  const nums = [...objs.keys()].sort((a, b) => a - b);
  for (const num of nums) {
    const o = objs.get(num)!;
    offsets.set(num, [size, o.gen]);
    if (o.stream && o.value instanceof PdfDict) {
      const d = new PdfDict();
      for (const [k, v] of o.value.map) d.map.set(k, v);
      d.map.set("Length", o.stream.length);
      dropCryptFilter(d);
      ascii(`${num} ${o.gen} obj\n${serialize(d)}\nstream\n`);
      push(o.stream);
      ascii(`\nendstream\nendobj\n`);
    } else ascii(`${num} ${o.gen} obj\n${serialize(o.value)}\nendobj\n`);
  }
  const maxNum = nums.length ? nums[nums.length - 1] : 0;
  const xrefAt = size;
  let x = `xref\n0 ${maxNum + 1}\n0000000000 65535 f\r\n`;
  for (let i = 1; i <= maxNum; i++) {
    const e = offsets.get(i);
    x += e ? `${String(e[0]).padStart(10, "0")} ${String(e[1]).padStart(5, "0")} n\r\n` : `0000000000 00001 f\r\n`;
  }
  trailer.map.set("Size", maxNum + 1);
  ascii(`${x}trailer\n${serialize(trailer)}\nstartxref\n${xrefAt}\n%%EOF\n`);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

function dropCryptFilter(d: PdfDict) {
  const f = d.get("Filter");
  if (!Array.isArray(f)) {
    if (nameOf(f) === "Crypt") (d.map.delete("Filter"), d.map.delete("DecodeParms"));
    return;
  }
  const parms = d.get("DecodeParms");
  const keep = f.map((x, i) => [x, Array.isArray(parms) ? parms[i] : null] as const).filter(([x]) => nameOf(x) !== "Crypt");
  if (keep.length === f.length) return;
  d.map.set("Filter", keep.map(([x]) => x));
  if (Array.isArray(parms)) d.map.set("DecodeParms", keep.map(([, p]) => p ?? null));
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
