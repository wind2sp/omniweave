// PDF Surgeon — Standard Security Handler primitives (ISO 32000-1 §7.6.3, ISO 32000-2 §7.6.4).
// Clean-room implementation from the published algorithms: MD5 (RFC 1321), RC4, AES-CBC via
// WebCrypto, key derivation for revisions 2–6. Passwords are only ever held in local variables.

import { hash2B, passwordBytes } from "../crypto/pdfEncrypt";

const subtle = globalThis.crypto.subtle;

// ───────── MD5 (RFC 1321) ─────────

const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

export function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const total = ((len + 8) >> 6) * 64 + 64;
  const buf = new Uint8Array(total);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, (len * 8) >>> 0, true);
  dv.setUint32(total - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) (F = (B & C) | (~B & D)), (g = i);
      else if (i < 32) (F = (D & B) | (~D & C)), (g = (5 * i + 1) % 16);
      else if (i < 48) (F = B ^ C ^ D), (g = (3 * i + 5) % 16);
      else (F = C ^ (B | ~D)), (g = (7 * i) % 16);
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}

// ───────── RC4 ─────────

export function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

// ───────── AES-CBC ─────────

async function aesKey(key: Uint8Array, usage: "encrypt" | "decrypt") {
  return subtle.importKey("raw", key as BufferSource, "AES-CBC", false, [usage]);
}

/** One raw AES block encryption (CBC with a zero IV over a single block == ECB). */
async function aesBlock(key: Uint8Array, block: Uint8Array): Promise<Uint8Array> {
  const k = await aesKey(key, "encrypt");
  const out = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: new Uint8Array(16) }, k, block as BufferSource));
  return out.subarray(0, 16);
}

/**
 * AES-CBC decryption without trusting the padding: WebCrypto insists on valid PKCS#7, so we append
 * a synthetic block that decrypts to a full padding block, then strip real padding ourselves.
 */
export async function aesCbcDecryptRaw(key: Uint8Array, iv: Uint8Array, ct: Uint8Array): Promise<Uint8Array> {
  const n = ct.length - (ct.length % 16);
  if (n === 0) return new Uint8Array(0);
  ct = ct.subarray(0, n);
  const last = ct.subarray(n - 16);
  const x = new Uint8Array(16);
  for (let i = 0; i < 16; i++) x[i] = last[i] ^ 0x10;
  const extra = await aesBlock(key, x);
  const full = new Uint8Array(n + 16);
  full.set(ct);
  full.set(extra, n);
  const k = await aesKey(key, "decrypt");
  return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, full as BufferSource));
}

export function stripPkcs7(p: Uint8Array): Uint8Array {
  const pad = p[p.length - 1];
  if (!pad || pad > 16 || pad > p.length) return p;
  for (let i = p.length - pad; i < p.length; i++) if (p[i] !== pad) return p;
  return p.subarray(0, p.length - pad);
}

/** PDF AES data: 16-byte IV followed by PKCS#5-padded ciphertext. */
export async function aesDecryptPdf(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length < 32) return new Uint8Array(0);
  return stripPkcs7(await aesCbcDecryptRaw(key, data.subarray(0, 16), data.subarray(16)));
}

export async function aesEncryptPdf(key: Uint8Array, data: Uint8Array, iv = globalThis.crypto.getRandomValues(new Uint8Array(16))): Promise<Uint8Array> {
  const k = await aesKey(key, "encrypt");
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-CBC", iv: iv as BufferSource }, k, data as BufferSource));
  const out = new Uint8Array(16 + ct.length);
  out.set(iv);
  out.set(ct, 16);
  return out;
}

// ───────── key derivation ─────────

export const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);

/** Revisions 2–4 take the password in PDFDocEncoding (≈ Latin-1), padded/truncated to 32 bytes. */
export function padPassword(pw: string): Uint8Array {
  const out = new Uint8Array(32);
  const b = Array.from(pw, (c) => c.charCodeAt(0) & 0xff).slice(0, 32);
  out.set(b);
  out.set(PAD.subarray(0, 32 - b.length), b.length);
  return out;
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
};
const le32 = (n: number) => Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

export interface SecurityParams {
  V: number;
  R: number;
  /** key length in bytes (V < 5) */
  keyLen: number;
  O: Uint8Array;
  U: Uint8Array;
  OE?: Uint8Array;
  UE?: Uint8Array;
  P: number;
  id0: Uint8Array;
  encryptMetadata: boolean;
}

/** Algorithm 2: file key from a (padded) user password, revisions 2–4. */
export function legacyFileKey(sp: SecurityParams, padded: Uint8Array): Uint8Array {
  let h = md5(cat(padded, sp.O.subarray(0, 32), le32(sp.P), sp.id0, sp.R >= 4 && !sp.encryptMetadata ? Uint8Array.from([255, 255, 255, 255]) : new Uint8Array(0)));
  const n = sp.R === 2 ? 5 : sp.keyLen;
  if (sp.R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.slice(0, n);
}

/** Algorithms 4/5: the /U value for a file key. */
export function computeU(sp: SecurityParams, key: Uint8Array): Uint8Array {
  if (sp.R === 2) return rc4(key, PAD);
  let x = rc4(key, md5(cat(PAD, sp.id0)));
  for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return cat(x, new Uint8Array(16));
}

function ownerRc4Key(sp: SecurityParams, ownerPw: string): Uint8Array {
  let h = md5(padPassword(ownerPw));
  const n = sp.R === 2 ? 5 : sp.keyLen;
  if (sp.R >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  return h.slice(0, n);
}

/** Algorithm 3: the /O value (used to build test fixtures and to verify owner passwords). */
export function computeO(sp: Omit<SecurityParams, "O" | "U">, ownerPw: string, userPw: string): Uint8Array {
  const key = ownerRc4Key(sp as SecurityParams, ownerPw);
  let x = rc4(key, padPassword(userPw));
  if (sp.R >= 3) for (let i = 1; i <= 19; i++) x = rc4(key.map((b) => b ^ i), x);
  return x;
}

const eq = (a: Uint8Array, b: Uint8Array, n: number) => {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
};

function checkUserLegacy(sp: SecurityParams, padded: Uint8Array): Uint8Array | null {
  const key = legacyFileKey(sp, padded);
  return eq(computeU(sp, key), sp.U, sp.R === 2 ? 32 : 16) ? key : null;
}

async function sha256(d: Uint8Array) {
  return new Uint8Array(await subtle.digest("SHA-256", d as BufferSource));
}

async function aes256Key(sp: SecurityParams, pw: string): Promise<Uint8Array | null> {
  const p = passwordBytes(pw);
  const U = sp.U, O = sp.O;
  const h = sp.R >= 6 ? (pwd: Uint8Array, salt: Uint8Array, u: Uint8Array) => hash2B(pwd, salt, u) : (pwd: Uint8Array, salt: Uint8Array, u: Uint8Array) => sha256(cat(pwd, salt, u));
  const none = new Uint8Array(0);
  if (eq(await h(p, U.subarray(32, 40), none), U, 32) && sp.UE) {
    const k = await h(p, U.subarray(40, 48), none);
    return aesCbcDecryptRaw(k, new Uint8Array(16), sp.UE.subarray(0, 32));
  }
  const u48 = U.subarray(0, 48);
  if (eq(await h(p, O.subarray(32, 40), u48), O, 32) && sp.OE) {
    const k = await h(p, O.subarray(40, 48), u48);
    return aesCbcDecryptRaw(k, new Uint8Array(16), sp.OE.subarray(0, 32));
  }
  return null;
}

/**
 * Authenticate `password` as user or owner password. Returns the file key, or null when wrong.
 * `asOwner` reports which one matched (owner access lifts the permission flags).
 */
export async function authenticate(sp: SecurityParams, password: string): Promise<{ key: Uint8Array; asOwner: boolean } | null> {
  if (sp.R >= 5) {
    const key = await aes256Key(sp, password);
    if (!key) return null;
    // which password matched: re-test the user hash
    const p = passwordBytes(password);
    const userHash = sp.R >= 6 ? await hash2B(p, sp.U.subarray(32, 40), new Uint8Array(0)) : await sha256(cat(p, sp.U.subarray(32, 40)));
    return { key, asOwner: !eq(userHash, sp.U, 32) };
  }
  const asUser = checkUserLegacy(sp, padPassword(password));
  if (asUser) return { key: asUser, asOwner: false };
  // Algorithm 7: recover the user password from /O with the owner password
  const okey = ownerRc4Key(sp, password);
  let x = sp.O.subarray(0, 32);
  if (sp.R === 2) x = rc4(okey, x);
  else for (let i = 19; i >= 0; i--) x = rc4(okey.map((b) => b ^ i), x);
  const k = checkUserLegacy(sp, x);
  return k ? { key: k, asOwner: true } : null;
}

/** Algorithm 1: per-object key for revisions ≤ 4. */
export function objectKey(fileKey: Uint8Array, num: number, gen: number, aes: boolean): Uint8Array {
  const ext = cat(fileKey, Uint8Array.from([num & 255, (num >> 8) & 255, (num >> 16) & 255, gen & 255, (gen >> 8) & 255]), aes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0));
  return md5(ext).slice(0, Math.min(fileKey.length + 5, 16));
}
