// Office (DOCX/XLSX/PPTX) password encryption per [MS-OFFCRYPTO] (public specification).
// Reads Agile (2.3.4.10–2.3.4.15) and Standard (2.3.4.5–2.3.4.9) encryption; writes Agile
// (AES-256-CBC, SHA-512, spinCount 100 000, random salts, HMAC dataIntegrity) inside a
// compound file with the \u0006DataSpaces storage (2.1–2.2). Hashing/AES use WebCrypto;
// the spin loop uses a synchronous SHA-512 when possible.
// Passwords are never logged nor included in error messages.

import { t } from "../../i18n";
import { readCfb } from "../formats/cfb";
import { writeCfb } from "./cfbWrite";
import { sha1, sha256, sha384, sha512 } from "./sha512";

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error(t("engine.crypto.noWebCrypto"));
  return s;
};

type HashName = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";
const HASHES: Record<string, { name: HashName; size: number }> = {
  SHA1: { name: "SHA-1", size: 20 },
  "SHA-1": { name: "SHA-1", size: 20 },
  SHA256: { name: "SHA-256", size: 32 },
  SHA384: { name: "SHA-384", size: 48 },
  SHA512: { name: "SHA-512", size: 64 },
};

const BLOCK_VERIFIER_INPUT = new Uint8Array([0xfe, 0xa7, 0xd2, 0x76, 0x3b, 0x4b, 0x9e, 0x79]);
const BLOCK_VERIFIER_VALUE = new Uint8Array([0xd7, 0xaa, 0x0f, 0x6d, 0x30, 0x61, 0x34, 0x4e]);
const BLOCK_KEY_VALUE = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
const BLOCK_HMAC_KEY = new Uint8Array([0x5f, 0xb2, 0xad, 0x01, 0x0c, 0xb9, 0xe1, 0xf6]);
const BLOCK_HMAC_VALUE = new Uint8Array([0xa0, 0x67, 0x7f, 0x02, 0xb2, 0x2c, 0x84, 0x33]);
const SEGMENT = 4096;

// ---------------------------------------------------------------------------------------------
// byte helpers

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const u32le = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, true);
  return b;
};
const utf16le = (s: string) => {
  const b = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    b[i * 2] = c & 0xff;
    b[i * 2 + 1] = c >> 8;
  }
  return b;
};
const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
/** Truncate to `len`, or pad with 0x36 when shorter ([MS-OFFCRYPTO] 2.3.4.11/2.3.4.12). */
const fit = (b: Uint8Array, len: number) => {
  if (b.length >= len) return b.slice(0, len);
  const out = new Uint8Array(len).fill(0x36);
  out.set(b);
  return out;
};
const padTo = (b: Uint8Array, block: number) => {
  const n = Math.ceil(b.length / block) * block;
  if (n === b.length) return b;
  const out = new Uint8Array(n);
  out.set(b);
  return out;
};
const random = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const toB64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
const fromB64 = (s: string) => {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const buf = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

// ---------------------------------------------------------------------------------------------
// hashing

const SYNC: Record<HashName, (d: Uint8Array) => Uint8Array> = { "SHA-1": sha1, "SHA-256": sha256, "SHA-384": sha384, "SHA-512": sha512 };

// Small inputs (salts, verifiers, spin rounds) hash synchronously; bulk data goes to WebCrypto.
async function hash(alg: HashName, data: Uint8Array): Promise<Uint8Array> {
  if (data.length <= 256) return SYNC[alg](data);
  return new Uint8Array(await subtle().digest(alg, buf(data)));
}

/** H0 = H(salt + password); Hn = H(LE32(n) + Hn-1) for n in [0, spinCount). */
async function spinHash(alg: HashName, salt: Uint8Array, password: string, spinCount: number): Promise<Uint8Array> {
  let h = await hash(alg, concat(salt, utf16le(password)));
  const sync = SYNC[alg];
  const tmp = new Uint8Array(4 + h.length);
  const dv = new DataView(tmp.buffer);
  for (let i = 0; i < spinCount; i++) {
    dv.setUint32(0, i, true);
    tmp.set(h, 4);
    h = sync(tmp);
  }
  return h.slice();
}

// ---------------------------------------------------------------------------------------------
// AES via WebCrypto (CBC only; "no padding" and ECB are emulated)

const aesKey = (key: Uint8Array, usage: KeyUsage) => subtle().importKey("raw", buf(key), { name: "AES-CBC" }, false, [usage]);

/** AES-CBC without padding; input length must be a multiple of 16. */
async function cbcEncrypt(key: Uint8Array | CryptoKey, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length % 16) throw new Error(t("engine.crypto.aesInputLength"));
  const k = key instanceof Uint8Array ? await aesKey(key, "encrypt") : key;
  const out = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: buf(iv) }, k, buf(data)));
  return out.subarray(0, data.length); // drop the PKCS#7 block WebCrypto appends
}

/** AES-CBC decrypt without padding: append a forged block that decrypts to a full PKCS#7 pad. */
async function cbcDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  if (data.length === 0) return new Uint8Array(0);
  if (data.length % 16) throw new Error(t("engine.crypto.aesCipherLength"));
  const last = data.subarray(data.length - 16);
  const ek = await aesKey(key, "encrypt");
  // E(pad ^ last) is the first block of CBC-encrypting `pad` with IV = last
  const forged = new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: buf(last) }, ek, buf(new Uint8Array(16).fill(16)))).subarray(0, 16);
  const dk = await aesKey(key, "decrypt");
  return new Uint8Array(await subtle().decrypt({ name: "AES-CBC", iv: buf(iv) }, dk, buf(concat(data, forged))));
}

/** AES-ECB decrypt = CBC decrypt with zero IV, then undo the chaining XOR. */
async function ecbDecrypt(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const p = await cbcDecrypt(key, new Uint8Array(16), data);
  for (let i = 16; i < p.length; i++) p[i] ^= data[i - 16];
  return p;
}

async function hmac(alg: HashName, key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", buf(key), { name: "HMAC", hash: alg }, false, ["sign"]);
  return new Uint8Array(await subtle().sign("HMAC", k, buf(data)));
}

// ---------------------------------------------------------------------------------------------
// detection

const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export function isEncryptedOffice(bytes: Uint8Array): boolean {
  if (bytes.length < 512 || OLE_SIG.some((v, i) => bytes[i] !== v)) return false;
  try {
    const cfb = readCfb(bytes);
    return !!cfb.get("EncryptionInfo") && !!cfb.get("EncryptedPackage");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// decryption

/** Attributes of every `<tag …>` element (any namespace prefix). */
const allAttrs = (xml: string, tag: string): Record<string, string>[] =>
  [...xml.matchAll(new RegExp(`<(?:[\\w.-]+:)?${tag}\\b([^>]*)>`, "g"))].map((m) => {
    const out: Record<string, string> = {};
    for (const a of m[1].matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) out[a[1].replace(/^.*:/, "")] = a[3] ?? a[4] ?? "";
    return out;
  });
const attrs = (xml: string, tag: string): Record<string, string> | null => allAttrs(xml, tag)[0] ?? null;

const hashOf = (name: string | undefined) => {
  const h = name ? HASHES[name.toUpperCase()] : undefined;
  if (!h) throw new Error(t("engine.crypto.hashUnsupported", { name: name ?? t("engine.common.none") }));
  return h;
};
const checkCipher = (a: Record<string, string>) => {
  if ((a.cipherAlgorithm ?? "").toUpperCase() !== "AES") throw new Error(t("engine.crypto.cipherUnsupported", { name: a.cipherAlgorithm ?? t("engine.common.none") }));
  if (a.cipherChaining !== "ChainingModeCBC") throw new Error(t("engine.crypto.chainingUnsupported", { name: a.cipherChaining ?? t("engine.common.none") }));
  const bits = Number(a.keyBits);
  if (![128, 192, 256].includes(bits)) throw new Error(t("engine.crypto.aesKeyBits", { bits: String(a.keyBits) }));
  if (Number(a.blockSize ?? 16) !== 16) throw new Error(t("engine.crypto.aesBlockSize"));
  return bits / 8;
};

/**
 * Decrypt every 4096-byte segment in one WebCrypto call: CBC-decrypt the whole body with segment 0's
 * IV, then fix the first block of each later segment (it was XORed with the previous ciphertext
 * block instead of that segment's own IV).
 */
async function decryptSegments(key: Uint8Array, salt: Uint8Array, alg: HashName, pkg: Uint8Array): Promise<Uint8Array> {
  if (pkg.length < 8) throw new Error(t("engine.crypto.packageDamaged"));
  const dv = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  const size = dv.getUint32(0, true) + dv.getUint32(4, true) * 0x100000000;
  const body = pkg.subarray(8, 8 + Math.floor((pkg.length - 8) / 16) * 16);
  if (size > body.length) throw new Error(t("engine.crypto.packageTruncated"));
  const used = body.subarray(0, Math.ceil(size / 16) * 16);
  const segIv = async (i: number) => fit(await hash(alg, concat(salt, u32le(i))), 16);
  const out = await cbcDecrypt(key, await segIv(0), used);
  for (let i = 1, p = SEGMENT; p < used.length; i++, p += SEGMENT) {
    const iv = await segIv(i);
    for (let k = 0; k < 16; k++) out[p + k] ^= used[p - 16 + k] ^ iv[k];
  }
  return out.slice(0, size);
}

async function decryptAgile(info: Uint8Array, pkg: Uint8Array, password: string): Promise<Uint8Array> {
  const xml = new TextDecoder("utf-8").decode(info.subarray(8));
  const keyData = attrs(xml, "keyData");
  // the password key encryptor is the encryptedKey carrying a spinCount (certificate ones do not)
  const enc = allAttrs(xml, "encryptedKey").find((a) => a.spinCount !== undefined);
  if (!keyData) throw new Error(t("engine.crypto.noKeyData"));
  if (!enc || !enc.spinCount) {
    if (/keyEncryptor\/certificate/.test(xml)) throw new Error(t("engine.crypto.certificateUnsupported"));
    throw new Error(t("engine.crypto.noPasswordKey"));
  }
  const kdLen = checkCipher(keyData);
  const keyLen = checkCipher(enc);
  const pAlg = hashOf(enc.hashAlgorithm);
  const dAlg = hashOf(keyData.hashAlgorithm);
  const spin = Number(enc.spinCount);
  if (!Number.isInteger(spin) || spin < 0 || spin > 10_000_000) throw new Error(t("engine.crypto.badSpinCount"));
  const pSalt = fromB64(enc.saltValue ?? "");
  const h = await spinHash(pAlg.name, pSalt, password, spin);
  const derive = async (block: Uint8Array) => fit(await hash(pAlg.name, concat(h, block)), keyLen);

  // password verifier
  const vIn = await cbcDecrypt(await derive(BLOCK_VERIFIER_INPUT), pSalt, fromB64(enc.encryptedVerifierHashInput ?? ""));
  const vHash = await cbcDecrypt(await derive(BLOCK_VERIFIER_VALUE), pSalt, fromB64(enc.encryptedVerifierHashValue ?? ""));
  const saltSize = Number(enc.saltSize ?? pSalt.length);
  const expect = await hash(pAlg.name, vIn.subarray(0, saltSize));
  if (!equalBytes(expect, vHash.subarray(0, pAlg.size))) throw new Error("WRONG_PASSWORD");

  const secret = (await cbcDecrypt(await derive(BLOCK_KEY_VALUE), pSalt, fromB64(enc.encryptedKeyValue ?? ""))).subarray(0, kdLen);
  const kdSalt = fromB64(keyData.saltValue ?? "");

  // data integrity (HMAC over the whole EncryptedPackage stream)
  const di = attrs(xml, "dataIntegrity");
  if (di?.encryptedHmacKey && di.encryptedHmacValue) {
    const ivK = fit(await hash(dAlg.name, concat(kdSalt, BLOCK_HMAC_KEY)), 16);
    const ivV = fit(await hash(dAlg.name, concat(kdSalt, BLOCK_HMAC_VALUE)), 16);
    const hKey = (await cbcDecrypt(secret, ivK, fromB64(di.encryptedHmacKey))).subarray(0, dAlg.size);
    const hVal = (await cbcDecrypt(secret, ivV, fromB64(di.encryptedHmacValue))).subarray(0, dAlg.size);
    const actual = await hmac(dAlg.name, hKey, pkg);
    if (!equalBytes(actual, hVal)) throw new Error(t("engine.crypto.integrityFailed"));
  }
  return decryptSegments(secret, kdSalt, dAlg.name, pkg);
}

async function decryptStandard(info: Uint8Array, pkg: Uint8Array, password: string): Promise<Uint8Array> {
  const dv = new DataView(info.buffer, info.byteOffset, info.byteLength);
  const flags = dv.getUint32(4, true);
  if (flags & 0x10) throw new Error(t("engine.crypto.extensibleUnsupported"));
  const headerSize = dv.getUint32(8, true);
  const h = 12;
  const algId = dv.getUint32(h + 8, true);
  const algIdHash = dv.getUint32(h + 12, true);
  const keyBits = dv.getUint32(h + 16, true);
  if (algId === 0x6801 || !(flags & 0x20)) throw new Error(t("engine.crypto.rc4Unsupported"));
  if (![0x660e, 0x660f, 0x6610, 0].includes(algId)) throw new Error(t("engine.crypto.standardAlgorithm", { id: algId.toString(16) }));
  if (algIdHash !== 0x8004 && algIdHash !== 0) throw new Error(t("engine.crypto.standardHash"));
  const keyLen = (keyBits || 128) / 8;
  let v = h + headerSize;
  const saltSize = dv.getUint32(v, true);
  const salt = info.slice(v + 4, v + 4 + saltSize);
  v += 4 + saltSize;
  const encVerifier = info.slice(v, v + 16);
  const verifierHashSize = dv.getUint32(v + 16, true);
  const encVerifierHash = info.slice(v + 20, v + 20 + 32);

  // [MS-OFFCRYPTO] 2.3.4.7: 50 000 SHA-1 rounds, block 0, then the 0x36/0x5c expansion
  const hFinal = await hash("SHA-1", concat(await spinHash("SHA-1", salt, password, 50000), u32le(0)));
  const x = async (fillByte: number) => {
    const b = new Uint8Array(64).fill(fillByte);
    for (let i = 0; i < hFinal.length; i++) b[i] ^= hFinal[i];
    return hash("SHA-1", b);
  };
  const key = concat(await x(0x36), await x(0x5c)).slice(0, keyLen);

  const verifier = await ecbDecrypt(key, encVerifier);
  const vHash = await ecbDecrypt(key, encVerifierHash);
  if (!equalBytes(await hash("SHA-1", verifier), vHash.subarray(0, verifierHashSize || 20))) throw new Error("WRONG_PASSWORD");

  if (pkg.length < 8) throw new Error(t("engine.crypto.packageDamaged"));
  const pdv = new DataView(pkg.buffer, pkg.byteOffset, pkg.byteLength);
  const size = pdv.getUint32(0, true) + pdv.getUint32(4, true) * 0x100000000;
  const body = pkg.subarray(8, 8 + Math.floor((pkg.length - 8) / 16) * 16);
  const plain = await ecbDecrypt(key, body);
  if (size > plain.length) throw new Error(t("engine.crypto.packageTruncated"));
  return plain.slice(0, size);
}

export async function decryptOffice(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  if (bytes.length < 512 || OLE_SIG.some((v, i) => bytes[i] !== v)) throw new Error(t("engine.crypto.notEncryptedOffice"));
  const cfb = readCfb(bytes);
  const info = cfb.get("EncryptionInfo");
  const pkg = cfb.get("EncryptedPackage");
  if (!info || !pkg) {
    if (cfb.get("WordDocument") || cfb.get("Workbook") || cfb.get("Book") || cfb.get("PowerPoint Document"))
      throw new Error(t("engine.crypto.legacyBinary"));
    throw new Error(t("engine.crypto.notOoxml"));
  }
  if (info.length < 8) throw new Error(t("engine.crypto.infoDamaged"));
  const major = info[0] | (info[1] << 8);
  const minor = info[2] | (info[3] << 8);
  if (major === 4 && minor === 4) return decryptAgile(info, pkg, password);
  if ((major === 2 || major === 3 || major === 4) && minor === 2) return decryptStandard(info, pkg, password);
  if ((major === 3 || major === 4) && minor === 3) throw new Error(t("engine.crypto.extensibleUnsupported"));
  throw new Error(t("engine.crypto.versionUnsupported", { major, minor }));
}

// ---------------------------------------------------------------------------------------------
// encryption (Agile, AES-256-CBC, SHA-512, spinCount 100 000)

/** UNICODE-LP-P4: byte length, UTF-16LE, padded to 4 bytes ([MS-OFFCRYPTO] 2.1.2). */
const lpp4 = (s: string) => padTo(concat(u32le(s.length * 2), utf16le(s)), 4);
const VERSION_1_0 = concat(u32le(1), u32le(1), u32le(1)); // reader/updater/writer 1.0

function dataSpaces() {
  const version = concat(lpp4("Microsoft.Container.DataSpaces"), VERSION_1_0);
  const mapEntryBody = concat(u32le(1), u32le(0), lpp4("EncryptedPackage"), lpp4("StrongEncryptionDataSpace"));
  const map = concat(u32le(8), u32le(1), u32le(4 + mapEntryBody.length), mapEntryBody);
  const definition = concat(u32le(8), u32le(1), lpp4("StrongEncryptionTransform"));
  const id = lpp4("{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}");
  const primary = concat(
    u32le(8 + id.length), // TransformLength: bytes up to (not including) TransformName
    u32le(1), // TransformType
    id,
    lpp4("Microsoft.Container.EncryptionTransform"),
    VERSION_1_0,
    u32le(0), // EncryptionName (empty UTF-8-LP-P4)
    u32le(0), // EncryptionBlockSize
    u32le(0), // CipherMode
    u32le(4), // Reserved
  );
  return {
    Version: version,
    DataSpaceMap: map,
    DataSpaceInfo: { StrongEncryptionDataSpace: definition },
    TransformInfo: { StrongEncryptionTransform: { "\u0006Primary": primary } },
  };
}

export async function encryptOffice(zip: Uint8Array, password: string): Promise<Uint8Array> {
  const alg: HashName = "SHA-512", hashSize = 64, keyLen = 32, spin = 100000;
  const kdSalt = random(16);
  const pSalt = random(16);
  const secret = random(keyLen);

  // EncryptedPackage
  const segs: Uint8Array[] = [];
  const dataKey = await aesKey(secret, "encrypt");
  for (let i = 0, p = 0; p < zip.length; i++, p += SEGMENT) {
    const iv = fit(await hash(alg, concat(kdSalt, u32le(i))), 16);
    segs.push(await cbcEncrypt(dataKey, iv, padTo(zip.subarray(p, p + SEGMENT), 16)));
  }
  const sizeField = new Uint8Array(8);
  new DataView(sizeField.buffer).setUint32(0, zip.length >>> 0, true);
  new DataView(sizeField.buffer).setUint32(4, Math.floor(zip.length / 0x100000000), true);
  const pkg = concat(sizeField, ...segs);

  // dataIntegrity
  const hmacKey = random(hashSize);
  const hmacVal = await hmac(alg, hmacKey, pkg);
  const encHmacKey = await cbcEncrypt(secret, fit(await hash(alg, concat(kdSalt, BLOCK_HMAC_KEY)), 16), padTo(hmacKey, 16));
  const encHmacVal = await cbcEncrypt(secret, fit(await hash(alg, concat(kdSalt, BLOCK_HMAC_VALUE)), 16), padTo(hmacVal, 16));

  // password key encryptor
  const h = await spinHash(alg, pSalt, password, spin);
  const derive = async (block: Uint8Array) => fit(await hash(alg, concat(h, block)), keyLen);
  const verifierInput = random(16);
  const encVIn = await cbcEncrypt(await derive(BLOCK_VERIFIER_INPUT), pSalt, verifierInput);
  const encVHash = await cbcEncrypt(await derive(BLOCK_VERIFIER_VALUE), pSalt, padTo(await hash(alg, verifierInput), 16));
  const encKey = await cbcEncrypt(await derive(BLOCK_KEY_VALUE), pSalt, secret);

  const common = `saltSize="16" blockSize="16" keyBits="256" hashSize="${hashSize}" cipherAlgorithm="AES" cipherChaining="ChainingModeCBC" hashAlgorithm="SHA512"`;
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<encryption xmlns="http://schemas.microsoft.com/office/2006/encryption" xmlns:p="http://schemas.microsoft.com/office/2006/keyEncryptor/password" xmlns:c="http://schemas.microsoft.com/office/2006/keyEncryptor/certificate">` +
    `<keyData ${common} saltValue="${toB64(kdSalt)}"/>` +
    `<dataIntegrity encryptedHmacKey="${toB64(encHmacKey)}" encryptedHmacValue="${toB64(encHmacVal)}"/>` +
    `<keyEncryptors><keyEncryptor uri="http://schemas.microsoft.com/office/2006/keyEncryptor/password">` +
    `<p:encryptedKey spinCount="${spin}" ${common} saltValue="${toB64(pSalt)}" encryptedVerifierHashInput="${toB64(encVIn)}" encryptedVerifierHashValue="${toB64(encVHash)}" encryptedKeyValue="${toB64(encKey)}"/>` +
    `</keyEncryptor></keyEncryptors></encryption>`;
  const info = concat(new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]), new TextEncoder().encode(xml));

  return writeCfb({
    "\u0006DataSpaces": dataSpaces(),
    EncryptionInfo: info,
    EncryptedPackage: pkg,
  });
}
