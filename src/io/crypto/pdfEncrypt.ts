// PDF password protection — Standard Security Handler, revision 6 (AES-256, ISO 32000-2 §7.6.4).
// Input: any unencrypted PDF. Output: the same document with every string and stream encrypted
// under a random 256-bit file key that is wrapped with the user/owner password.
// Uses WebCrypto only (works in WebView2 and Node 18+).

import { t } from "../../i18n";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from "pdf-lib";

const subtle = globalThis.crypto.subtle;
const rand = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const enc = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function sha(alg: "SHA-256" | "SHA-384" | "SHA-512", data: Uint8Array) {
  return new Uint8Array(await subtle.digest(alg, data as BufferSource));
}

/** AES-CBC without padding: WebCrypto always pads, so drop the final (padding) block. */
async function aesCbcNoPad(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle.importKey("raw", key as BufferSource, "AES-CBC", false, ["encrypt"]);
  const out = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, data as BufferSource));
  return out.subarray(0, data.length);
}

async function aesCbcPkcs7(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const iv = rand(16);
  const out = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, key, data as BufferSource));
  return concat(iv, out);
}

/** Algorithm 2.B — the R6 password hash (iterated SHA-256/384/512 + AES-128). */
export async function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let K = await sha("SHA-256", concat(password, salt, udata));
  for (let round = 0; ; round++) {
    const block = concat(password, K, udata);
    const K1 = new Uint8Array(block.length * 64);
    for (let i = 0; i < 64; i++) K1.set(block, i * block.length);
    const E = await aesCbcNoPad(K.subarray(0, 16), K.subarray(16, 32), K1);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod += E[i];
    mod %= 3;
    K = await sha(mod === 0 ? "SHA-256" : mod === 1 ? "SHA-384" : "SHA-512", E);
    if (round >= 63 && E[E.length - 1] <= round - 31) break;
  }
  return K.subarray(0, 32);
}

/** UTF-8 (SASLprep is approximated by NFKC normalisation), max 127 bytes. */
export function passwordBytes(pw: string): Uint8Array {
  return enc.encode(pw.normalize("NFKC")).subarray(0, 127);
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export interface PdfEncryptOptions {
  /** defaults to the user password */
  ownerPassword?: string;
  /** permission bits (Table 22); default: everything allowed */
  permissions?: number;
}

export async function encryptPdf(input: Uint8Array, userPassword: string, opts: PdfEncryptOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(input, { updateMetadata: false });
  const ctx = pdf.context;
  if (ctx.trailerInfo.Encrypt) throw new Error(t("engine.crypto.pdfAlreadyEncrypted"));

  const fileKey = rand(32);
  const upw = passwordBytes(userPassword);
  const opw = passwordBytes(opts.ownerPassword ?? userPassword);
  const P = opts.permissions ?? -4; // all permissions (bits 1-2 must be 0)

  // U / UE (Algorithm 8)
  const uvs = rand(8), uks = rand(8);
  const U = concat(await hash2B(upw, uvs, new Uint8Array(0)), uvs, uks);
  const UE = await aesCbcNoPad(await hash2B(upw, uks, new Uint8Array(0)), new Uint8Array(16), fileKey);
  // O / OE (Algorithm 9)
  const ovs = rand(8), oks = rand(8);
  const O = concat(await hash2B(opw, ovs, U), ovs, oks);
  const OE = await aesCbcNoPad(await hash2B(opw, oks, U), new Uint8Array(16), fileKey);
  // Perms (Algorithm 10)
  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, P, true);
  perms.set([0xff, 0xff, 0xff, 0xff], 4);
  perms.set(enc.encode("Tadb"), 8);
  perms.set(rand(4), 12);
  const Perms = await aesCbcNoPad(fileKey, new Uint8Array(16), perms); // single block == ECB

  const key = await subtle.importKey("raw", fileKey as BufferSource, "AES-CBC", false, ["encrypt"]);

  // drop leftover xref / object streams from the parsed input; we write a classic xref table
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const type = obj.dict.get(PDFName.of("Type"));
      if (type === PDFName.of("XRef") || type === PDFName.of("ObjStm")) ctx.delete(ref);
    }
  }

  // encrypt every string (recursively) and every stream body
  const seen = new Set<PDFObject>();
  const encString = async (s: PDFString | PDFHexString) => PDFHexString.of(toHex(await aesCbcPkcs7(key, s.asBytes())));
  const walk = async (o: PDFObject): Promise<PDFObject> => {
    if (o instanceof PDFString || o instanceof PDFHexString) return encString(o);
    if (seen.has(o)) return o;
    seen.add(o);
    if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) {
        const nv = await walk(v);
        if (nv !== v) o.set(k, nv);
      }
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) {
        const v = o.get(i);
        const nv = await walk(v);
        if (nv !== v) o.set(i, nv);
      }
    }
    return o;
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      await walk(obj.dict);
      const raw = obj instanceof PDFRawStream ? obj.contents : obj.getContents();
      const body = await aesCbcPkcs7(key, raw);
      const dict = obj.dict.clone(ctx);
      dict.set(PDFName.of("Length"), PDFNumber.of(body.length));
      ctx.assign(ref, PDFRawStream.of(dict, body));
    } else {
      const nv = await walk(obj);
      if (nv !== obj) ctx.assign(ref, nv);
    }
  }

  const encDict = ctx.obj({
    Filter: "Standard",
    V: 5,
    R: 6,
    Length: 256,
    CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } },
    StmF: "StdCF",
    StrF: "StdCF",
    P,
    EncryptMetadata: true,
  });
  encDict.set(PDFName.of("O"), PDFHexString.of(toHex(O)));
  encDict.set(PDFName.of("U"), PDFHexString.of(toHex(U)));
  encDict.set(PDFName.of("OE"), PDFHexString.of(toHex(OE)));
  encDict.set(PDFName.of("UE"), PDFHexString.of(toHex(UE)));
  encDict.set(PDFName.of("Perms"), PDFHexString.of(toHex(Perms)));
  const encRef: PDFRef = ctx.register(encDict);
  ctx.trailerInfo.Encrypt = encRef;
  const id = PDFHexString.of(toHex(rand(16)));
  ctx.trailerInfo.ID = ctx.obj([id, id]);

  return pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}
