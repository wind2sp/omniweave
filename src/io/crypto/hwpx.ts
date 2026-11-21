// Password-protected HWPX (한글 '문서 암호'): ODF-style package encryption (OASIS ODF 1.2 Part 3 §3.8,
// as declared in META-INF/manifest.xml). Each encrypted entry: start key = SHA-256(password UTF-8),
// key = PBKDF2-HMAC-SHA1(start key, salt, iteration-count, key-size), data = AES-256-CBC(IV) of the
// raw-deflated part, padded (W3C xmlenc: last byte = pad length). checksum = SHA-256 of the first
// 1024 bytes (한글 2024: of the uncompressed part; ODF: of the compressed one) — tells a wrong password.
// The password is never stored (session.ts keeps it in memory only).

import { t } from "../../i18n";
import { deflateSync, inflateSync, strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { aesCbcDecryptRaw } from "../pdfsurgeon/crypto";
import { attr, children, descendants, parseXml } from "../xml";

const MANIFEST = "META-INF/manifest.xml";
const NS_MANIFEST = "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""));
const subtle = () => globalThis.crypto.subtle;
const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const sha256 = async (d: Uint8Array) => new Uint8Array(await subtle().digest("SHA-256", ab(d)));

/** The package declares encrypted entries (a password-protected HWPX). */
export function isEncryptedHwpx(bytes: Uint8Array): boolean {
  try {
    const m = unzipSync(bytes, { filter: (f) => f.name === MANIFEST })[MANIFEST];
    return !!m && /encryption-data/.test(strFromU8(m));
  } catch {
    return false;
  }
}

interface EntryCrypto {
  path: string;
  algorithm: string;
  iv: Uint8Array;
  salt: Uint8Array;
  iterations: number;
  keySize: number;
  startKey: string;
  checksumType: string;
  checksum: Uint8Array | null;
}

function entries(manifest: string): EntryCrypto[] {
  const doc = parseXml(manifest);
  const out: EntryCrypto[] = [];
  for (const fe of descendants(doc, "file-entry")) {
    const ed = children(fe, "encryption-data")[0];
    if (!ed) continue;
    const alg = children(ed, "algorithm")[0];
    const kd = children(ed, "key-derivation")[0];
    const sk = children(ed, "start-key-generation")[0];
    if (!alg || !kd) throw new Error(t("engine.crypto.hwpxManifest"));
    out.push({
      path: attr(fe, "full-path") ?? "",
      algorithm: attr(alg, "algorithm-name") ?? "",
      iv: b64(attr(alg, "initialisation-vector") ?? ""),
      salt: b64(attr(kd, "salt") ?? ""),
      iterations: Number(attr(kd, "iteration-count")) || 1024,
      keySize: Number(attr(kd, "key-size")) || 32,
      startKey: sk ? attr(sk, "start-key-generation-name") ?? "" : "http://www.w3.org/2000/09/xmldsig#sha1",
      checksumType: attr(ed, "checksum-type") ?? "",
      checksum: attr(ed, "checksum") ? b64(attr(ed, "checksum")!) : null,
    });
    if (attr(kd, "key-derivation-name") && !/pbkdf2$/i.test(attr(kd, "key-derivation-name")!)) throw new Error(t("engine.crypto.hwpxKdf", { name: attr(kd, "key-derivation-name")! }));
  }
  return out;
}

async function deriveKey(password: string, e: EntryCrypto): Promise<Uint8Array> {
  const pw = strToU8(password);
  const start = /sha256$/i.test(e.startKey) ? await sha256(pw) : new Uint8Array(await subtle().digest("SHA-1", ab(pw)));
  const base = await subtle().importKey("raw", ab(start), "PBKDF2", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "PBKDF2", hash: "SHA-1", salt: ab(e.salt), iterations: e.iterations }, base, e.keySize * 8);
  return new Uint8Array(bits);
}

async function checksumOk(e: EntryCrypto, data: Uint8Array): Promise<boolean> {
  if (!e.checksum) return true;
  if (/sha256-1k$/i.test(e.checksumType)) return eq(await sha256(data.subarray(0, 1024)), e.checksum);
  if (/sha256$/i.test(e.checksumType)) return eq(await sha256(data), e.checksum);
  // ODF 1.2's default (manifest "SHA1/1K" or …#sha1-1k): without it a wrong password is not recognised
  if (/sha1[-/]1k$/i.test(e.checksumType)) return eq(new Uint8Array(await subtle().digest("SHA-1", ab(data.subarray(0, 1024)))), e.checksum);
  return true; // unknown checksum type: cannot verify here, inflate decides
}
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Decrypt a password-protected HWPX into a plain HWPX package (manifest without encryption data).
 * Throws Error("WRONG_PASSWORD") when the password does not match.
 */
export async function decryptHwpx(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const files = unzipSync(bytes);
  const manifest = files[MANIFEST] ? strFromU8(files[MANIFEST]) : "";
  const list = entries(manifest);
  if (!list.length) return bytes;
  const out: Zippable = {};
  for (const [name, data] of Object.entries(files)) out[name] = name === "mimetype" ? [data, { level: 0 }] : data;
  for (const e of list) {
    if (!/aes256-cbc$/i.test(e.algorithm)) throw new Error(t("engine.crypto.hwpxAlgorithm", { name: e.algorithm }));
    const ct = files[e.path];
    if (!ct) continue;
    const key = await deriveKey(password, e);
    let raw: Uint8Array;
    try {
      raw = await aesCbcDecryptRaw(key, e.iv, ct);
    } catch {
      throw new Error("WRONG_PASSWORD");
    }
    const pad = raw[raw.length - 1];
    const body = pad > 0 && pad <= 16 ? raw.subarray(0, raw.length - pad) : raw;
    let plain: Uint8Array | null = null;
    try {
      plain = inflateSync(body);
    } catch {
      plain = null;
    }
    // 한글 computes the checksum over the uncompressed part, ODF over the compressed one: accept either
    const ok = (plain && (await checksumOk(e, plain))) || (await checksumOk(e, body));
    if (!ok) throw new Error("WRONG_PASSWORD");
    plain ??= body; // stored without compression
    out[e.path] = plain;
  }
  out[MANIFEST] = strToU8(stripEncryption(manifest));
  return zipSync(out);
}

function stripEncryption(manifest: string): string {
  return manifest.replace(/<([\w-]+:)?encryption-data\b[\s\S]*?<\/([\w-]+:)?encryption-data>/g, "");
}

/** Parts that stay readable in a protected package (the package structure itself). */
const CLEAR = (name: string) => name === "mimetype" || name === "version.xml" || name.startsWith("META-INF/") || name === "Contents/content.hpf";

/** Encrypt an HWPX package with a password (same scheme as 한글: AES-256-CBC, PBKDF2-SHA1 ×1024, SHA-256 start key). */
export async function encryptHwpx(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const files = unzipSync(bytes);
  const out: Zippable = {};
  const fileEntries: string[] = [];
  const enc = (e: EntryCrypto) =>
    `<odf:encryption-data checksum-type="${NS_MANIFEST}#sha256-1k" checksum="${toB64(e.checksum!)}"><odf:algorithm algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" initialisation-vector="${toB64(e.iv)}"/>` +
    `<odf:key-derivation key-derivation-name="${NS_MANIFEST}#pbkdf2" key-size="32" iteration-count="${e.iterations}" salt="${toB64(e.salt)}"/><odf:start-key-generation start-key-generation-name="http://www.w3.org/2000/09/xmldsig#sha256" key-size="32"/></odf:encryption-data>`;
  for (const [name, data] of Object.entries(files)) {
    if (name === MANIFEST) continue;
    if (CLEAR(name)) {
      out[name] = name === "mimetype" ? [data, { level: 0 }] : data;
      continue;
    }
    const e: EntryCrypto = {
      path: name,
      algorithm: "aes256-cbc",
      iv: globalThis.crypto.getRandomValues(new Uint8Array(16)),
      salt: globalThis.crypto.getRandomValues(new Uint8Array(16)),
      iterations: 1024,
      keySize: 32,
      startKey: "sha256",
      checksumType: "sha256-1k",
      checksum: null,
    };
    const packed = deflateSync(data, { level: 6 });
    e.checksum = await sha256(data.subarray(0, 1024)); // over the uncompressed part, as 한글 writes it
    const key = await subtle().importKey("raw", ab(await deriveKey(password, e)), "AES-CBC", false, ["encrypt"]);
    // WebCrypto adds PKCS#7 padding, which is a valid xmlenc padding (last byte = pad length)
    out[name] = [new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: ab(e.iv) }, key, ab(packed))), { level: 0 }];
    const media = /\.xml$/i.test(name) ? "application/xml" : /\.png$/i.test(name) ? "image/png" : /\.jpe?g$/i.test(name) ? "image/jpeg" : /\.txt$/i.test(name) ? "text/plain" : "application/octet-stream";
    fileEntries.push(`<odf:file-entry full-path="${name}" media-type="${media}" size="${data.length}">${enc(e)}</odf:file-entry>`);
  }
  out[MANIFEST] = strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="${NS_MANIFEST}">${fileEntries.join("")}</odf:manifest>`);
  // mimetype first and stored (OCF)
  const ordered: Zippable = { mimetype: out.mimetype ?? [strToU8("application/hwp+zip"), { level: 0 }] };
  for (const [k, v] of Object.entries(out)) if (k !== "mimetype") ordered[k] = v;
  return zipSync(ordered);
}
