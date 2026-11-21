// Office password encryption ([MS-OFFCRYPTO]) and compound-file writing ([MS-CFB]).
// Known-answer checks use an independent implementation path: Node's own crypto module
// (OpenSSL) re-implements the Agile/Standard key derivation directly from the specification.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { strToU8, unzipSync, zipSync } from "fflate";
import { readCfb } from "../../src/io/formats/cfb";
import { compareCfbNames, writeCfb } from "../../src/io/crypto/cfbWrite";
import { decryptOffice, encryptOffice, isEncryptedOffice } from "../../src/io/crypto/office";
import { sha1, sha256, sha384, sha512 } from "../../src/io/crypto/sha512";
import { parseDocx } from "../../src/io/office";
import { importPptx } from "../../src/io/formats/pptx";
import { installDom } from "../coverage/helpers";

beforeAll(() => installDom());

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** Fast byte equality (vitest's deep equal is slow on multi-megabyte arrays). */
const same = (a: Uint8Array | undefined, b: Uint8Array) => !!a && a.length === b.length && Buffer.compare(a, b) === 0;
const sampleZip = () =>
  zipSync({
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
        Array.from({ length: 400 }, (_, i) => `<w:p><w:r><w:t>문단 ${i} — 암호 왕복 시험</w:t></w:r></w:p>`).join("") +
        `</w:body></w:document>`,
    ),
    "media/blob.bin": new Uint8Array(randomBytes(9000)), // not a 4096 multiple, spans several segments
  });

// ------------------------------------------------------------------------------------------
describe("synchronous SHA-1 / SHA-256 / SHA-384 / SHA-512", () => {
  it("matches FIPS 180-2 examples", () => {
    expect(hex(sha512(strToU8("abc")))).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
    expect(hex(sha512(new Uint8Array(0)))).toBe(
      "cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e",
    );
    expect(hex(sha512(strToU8("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu")))).toBe(
      "8e959b75dae313da8cf4f72814fc143f8f7779c6eb9f7fa17299aeadb6889018501d289e4900f7e4331b99dec4b5433ac7d329eeb6dd26545e96e55b874be909",
    );
    expect(hex(sha1(strToU8("abc")))).toBe("a9993e364706816aba3e25717850c26c9cd0d89d");
    expect(hex(sha256(strToU8("abc")))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hex(sha384(strToU8("abc")))).toBe("cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7");
  });
  it("agrees with WebCrypto and Node for every length 0..300", async () => {
    for (let n = 0; n <= 300; n++) {
      const d = new Uint8Array(randomBytes(n));
      expect(hex(sha512(d))).toBe(hex(new Uint8Array(await crypto.subtle.digest("SHA-512", d))));
      expect(hex(sha384(d))).toBe(createHash("sha384").update(d).digest("hex"));
      expect(hex(sha256(d))).toBe(createHash("sha256").update(d).digest("hex"));
      expect(hex(sha1(d))).toBe(createHash("sha1").update(d).digest("hex"));
    }
  });
});

// ------------------------------------------------------------------------------------------
describe("CFB writer", () => {
  it("orders names by length, then case-insensitively", () => {
    const names = ["Zeta", "b", "EncryptionInfo", "A", "\u0006DataSpaces", "EncryptedPackage", "abc"];
    expect([...names].sort(compareCfbNames)).toEqual(["A", "b", "abc", "Zeta", "\u0006DataSpaces", "EncryptionInfo", "EncryptedPackage"]);
  });

  it("round-trips small, big and nested streams through the existing reader", () => {
    const rnd = (n: number) => new Uint8Array(randomBytes(n));
    const tree = {
      tiny: rnd(1),
      empty: new Uint8Array(0),
      edge4095: rnd(4095),
      edge4096: rnd(4096),
      big: rnd(70_000),
      Storage1: { inner: rnd(100), deeper: { leaf: rnd(5000), Leaf2: rnd(64) } },
    };
    for (let i = 0; i < 20; i++) (tree as any)[`s${i}`] = rnd(i * 37);
    const cfb = readCfb(writeCfb(tree));
    const flat = (t: any, p = ""): [string, Uint8Array][] =>
      Object.entries(t).flatMap(([k, v]) => (v instanceof Uint8Array ? [[p + k, v] as [string, Uint8Array]] : flat(v, p + k + "/")));
    const want = flat(tree);
    expect(cfb.streams.size).toBe(want.length);
    for (const [path, data] of want) expect(same(cfb.get(path), data), path).toBe(true);
  });

  it("uses DIFAT sectors when the FAT needs more than 109 sectors", () => {
    const big = new Uint8Array(110 * 128 * 512); // ~7.2 MB → >109 FAT sectors
    for (let i = 0; i < big.length; i += 997) big[i] = i & 0xff;
    const bytes = writeCfb({ big, small: strToU8("x") });
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint32(0x48, true)).toBeGreaterThan(0); // number of DIFAT sectors
    const cfb = readCfb(bytes);
    expect(same(cfb.get("big"), big)).toBe(true);
    expect(cfb.get("small")).toEqual(strToU8("x"));
  });

  // (2026-11-16) one CFB writer for the program — io/formats/cfb.ts, which also writes HWP files: sibling trees coloured
  // as valid red-black trees (it was all black here), a storage's starting sector zero ([MS-CFB] 2.6.3)
  it("writes a version-3 header, a black root and its first level, storages starting at sector 0", () => {
    const bytes = writeCfb({ a: strToU8("1"), b: { c: strToU8("2") } });
    const dv = new DataView(bytes.buffer);
    expect(dv.getUint16(0x1a, true)).toBe(3);
    expect(dv.getUint16(0x1e, true)).toBe(9);
    const dirOff = (dv.getUint32(0x30, true) + 1) * 512;
    const name = (i: number) => String.fromCharCode(...Array.from({ length: dv.getUint16(dirOff + i * 128 + 0x40, true) / 2 - 1 }, (_, k) => dv.getUint16(dirOff + i * 128 + k * 2, true)));
    const at = (n: string) => [0, 1, 2, 3].find((i) => name(i) === n)!;
    expect(bytes[dirOff + at("Root Entry") * 128 + 0x43]).toBe(1);
    // two siblings: the middle one (by the name order) black, the other a red leaf
    expect([bytes[dirOff + at("a") * 128 + 0x43], bytes[dirOff + at("b") * 128 + 0x43]].sort()).toEqual([0, 1]);
    expect(bytes[dirOff + at("b") * 128 + 0x42]).toBe(1);
    expect(dv.getUint32(dirOff + at("b") * 128 + 0x74, true)).toBe(0);
    expect(() => writeCfb({ "a/b": strToU8("1") })).toThrow();
    expect(() => writeCfb({ A: strToU8("1"), a: strToU8("2") })).toThrow();
  });
});

// ------------------------------------------------------------------------------------------
// Independent Agile decryptor written straight from [MS-OFFCRYPTO] 2.3.4.10–2.3.4.15 with node:crypto.
function referenceAgileDecrypt(file: Uint8Array, password: string) {
  const cfb = readCfb(file);
  const info = Buffer.from(cfb.get("EncryptionInfo")!);
  const pkg = Buffer.from(cfb.get("EncryptedPackage")!);
  expect(info.readUInt16LE(0)).toBe(4);
  expect(info.readUInt16LE(2)).toBe(4);
  expect(info.readUInt32LE(4)).toBe(0x40);
  const xml = info.subarray(8).toString("utf8");
  const attr = (el: string, name: string) => new RegExp(`<${el}\\b[^>]*\\s${name}="([^"]*)"`).exec(xml)![1];
  const b64 = (el: string, name: string) => Buffer.from(attr(el, name), "base64");
  const H = (...p: Buffer[]) => createHash("sha512").update(Buffer.concat(p)).digest();
  const aes = (key: Buffer, iv: Buffer, data: Buffer) => {
    const d = createDecipheriv("aes-256-cbc", key, iv);
    d.setAutoPadding(false);
    return Buffer.concat([d.update(data), d.final()]);
  };
  const pSalt = b64("p:encryptedKey", "saltValue");
  const spin = Number(attr("p:encryptedKey", "spinCount"));
  let h = H(pSalt, Buffer.from(password, "utf16le"));
  for (let i = 0; i < spin; i++) {
    const it = Buffer.alloc(4);
    it.writeUInt32LE(i);
    h = H(it, h);
  }
  const key = (block: string) => H(h, Buffer.from(block, "hex")).subarray(0, 32);
  const vIn = aes(key("fea7d2763b4b9e79"), pSalt, b64("p:encryptedKey", "encryptedVerifierHashInput"));
  const vVal = aes(key("d7aa0f6d3061344e"), pSalt, b64("p:encryptedKey", "encryptedVerifierHashValue"));
  const ok = H(vIn).equals(vVal.subarray(0, 64));
  if (!ok) return { ok };
  const secret = aes(key("146e0be7abacd0d6"), pSalt, b64("p:encryptedKey", "encryptedKeyValue"));
  const kdSalt = b64("keyData", "saltValue");
  const hk = aes(secret, H(kdSalt, Buffer.from("5fb2ad010cb9e1f6", "hex")).subarray(0, 16), b64("dataIntegrity", "encryptedHmacKey"));
  const hv = aes(secret, H(kdSalt, Buffer.from("a0677f02b22c8433", "hex")).subarray(0, 16), b64("dataIntegrity", "encryptedHmacValue"));
  const hmacOk = createHmac("sha512", hk).update(pkg).digest().equals(hv);
  const size = Number(pkg.readBigUInt64LE(0));
  const parts: Buffer[] = [];
  for (let i = 0, p = 8; p < pkg.length; i++, p += 4096) {
    const it = Buffer.alloc(4);
    it.writeUInt32LE(i);
    parts.push(aes(secret, H(kdSalt, it).subarray(0, 16), pkg.subarray(p, p + 4096)));
  }
  return { ok, hmacOk, data: new Uint8Array(Buffer.concat(parts).subarray(0, size)), xml };
}

// Independent Standard-encryption writer ([MS-OFFCRYPTO] 2.3.4.5–2.3.4.9, AES-128 / SHA-1).
function referenceStandardEncrypt(zip: Uint8Array, password: string): Uint8Array {
  const sha1 = (...p: Buffer[]) => createHash("sha1").update(Buffer.concat(p)).digest();
  const ecb = (key: Buffer, data: Buffer) => {
    const c = createCipheriv("aes-128-ecb", key, null);
    c.setAutoPadding(false);
    return Buffer.concat([c.update(data), c.final()]);
  };
  const salt = randomBytes(16);
  let h = sha1(salt, Buffer.from(password, "utf16le"));
  for (let i = 0; i < 50000; i++) {
    const it = Buffer.alloc(4);
    it.writeUInt32LE(i);
    h = sha1(it, h);
  }
  const hFinal = sha1(h, Buffer.alloc(4));
  const x1 = sha1(Buffer.from(Buffer.alloc(64, 0x36).map((v, i) => (i < 20 ? v ^ hFinal[i] : v))));
  const key = x1.subarray(0, 16);
  const verifier = randomBytes(16);
  const vHash = Buffer.concat([sha1(verifier), Buffer.alloc(12)]);
  const csp = Buffer.from("Microsoft Enhanced RSA and AES Cryptographic Provider\0", "utf16le");
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0x24, 0); // fCryptoAPI | fAES
  header.writeUInt32LE(0x660e, 8);
  header.writeUInt32LE(0x8004, 12);
  header.writeUInt32LE(128, 16);
  header.writeUInt32LE(0x18, 20);
  const pre = Buffer.alloc(12);
  pre.writeUInt16LE(4, 0);
  pre.writeUInt16LE(2, 2);
  pre.writeUInt32LE(0x24, 4);
  pre.writeUInt32LE(32 + csp.length, 8);
  const ver = Buffer.alloc(4);
  ver.writeUInt32LE(16);
  const vhs = Buffer.alloc(4);
  vhs.writeUInt32LE(20);
  const info = Buffer.concat([pre, header, csp, ver, salt, ecb(key, verifier), vhs, ecb(key, vHash)]);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(zip.length));
  const padded = Buffer.alloc(Math.ceil(zip.length / 16) * 16);
  Buffer.from(zip).copy(padded);
  const pkg = Buffer.concat([size, ecb(key, padded)]);
  return writeCfb({ EncryptionInfo: new Uint8Array(info), EncryptedPackage: new Uint8Array(pkg) });
}

describe("Office encryption", () => {
  const PW = "시험용-Pässwörd 123";

  it("encrypt → decrypt round-trips the zip and is detected", async () => {
    const zip = sampleZip();
    const enc = await encryptOffice(zip, PW);
    expect(isEncryptedOffice(enc)).toBe(true);
    expect(isEncryptedOffice(zip)).toBe(false);
    const dec = await decryptOffice(enc, PW);
    expect(same(dec, zip)).toBe(true);
    expect(Object.keys(unzipSync(dec))).toContain("word/document.xml");
  }, 60_000);

  it("rejects a wrong password with WRONG_PASSWORD", async () => {
    const enc = await encryptOffice(sampleZip(), PW);
    await expect(decryptOffice(enc, PW + "x")).rejects.toThrow("WRONG_PASSWORD");
    await expect(decryptOffice(enc, "")).rejects.toThrow("WRONG_PASSWORD");
  }, 60_000);

  it("detects a tampered package through dataIntegrity", async () => {
    const zip = sampleZip();
    const enc = await encryptOffice(zip, PW);
    const cfb = readCfb(enc);
    const pkg = cfb.get("EncryptedPackage")!.slice();
    pkg[100] ^= 1;
    const tampered = writeCfb({ EncryptionInfo: cfb.get("EncryptionInfo")!, EncryptedPackage: pkg });
    await expect(decryptOffice(tampered, PW)).rejects.toThrow(/무결성/);
  }, 60_000);

  it("output matches an independent [MS-OFFCRYPTO] Agile implementation (node:crypto)", async () => {
    const zip = sampleZip();
    const enc = await encryptOffice(zip, PW);
    const ref = referenceAgileDecrypt(enc, PW);
    expect(ref.ok).toBe(true);
    expect(ref.hmacOk).toBe(true);
    expect(same(ref.data, zip)).toBe(true);
    expect(ref.xml).toMatch(/spinCount="100000"/);
    expect(ref.xml).toMatch(/keyBits="256"/);
    expect(ref.xml).toMatch(/hashAlgorithm="SHA512"/);
    expect(referenceAgileDecrypt(enc, "nope").ok).toBe(false);
  }, 60_000);

  it("uses fresh random salts every time", async () => {
    const zip = sampleZip();
    const a = readCfb(await encryptOffice(zip, PW)).get("EncryptionInfo")!;
    const b = readCfb(await encryptOffice(zip, PW)).get("EncryptionInfo")!;
    expect(hex(a)).not.toBe(hex(b));
  }, 60_000);

  it("writes the \\u0006DataSpaces storage required by [MS-OFFCRYPTO] 2.1", async () => {
    const cfb = readCfb(await encryptOffice(sampleZip(), PW));
    const ds = "\u0006DataSpaces/";
    for (const p of ["Version", "DataSpaceMap", "DataSpaceInfo/StrongEncryptionDataSpace", "TransformInfo/StrongEncryptionTransform/\u0006Primary"])
      expect(cfb.get(ds + p), p).toBeDefined();
    const u16 = (b: Uint8Array, o: number, n: number) => Buffer.from(b.subarray(o, o + n)).toString("utf16le");
    const version = cfb.get(ds + "Version")!;
    expect(u16(version, 4, 60)).toBe("Microsoft.Container.DataSpaces");
    expect(version.length).toBe(76);
    const map = cfb.get(ds + "DataSpaceMap")!;
    expect(Buffer.from(map).readUInt32LE(8)).toBe(0x68);
    expect(map.length).toBe(8 + 0x68);
    const primary = Buffer.from(cfb.get(ds + "TransformInfo/StrongEncryptionTransform/\u0006Primary")!);
    expect(primary.readUInt32LE(0)).toBe(0x58);
    expect(u16(primary, 12, 76)).toBe("{FF9A3F03-56EF-4613-BDD5-5A41C1D07246}");
  }, 60_000);

  it("decrypts Standard (AES-128 / SHA-1) encryption built independently", async () => {
    const zip = sampleZip();
    const enc = referenceStandardEncrypt(zip, PW);
    expect(isEncryptedOffice(enc)).toBe(true);
    expect(same(await decryptOffice(enc, PW), zip)).toBe(true);
    await expect(decryptOffice(enc, "wrong")).rejects.toThrow("WRONG_PASSWORD");
  }, 60_000);

  it("explains unsupported inputs without echoing the password", async () => {
    const legacy = writeCfb({ WordDocument: new Uint8Array(10), "1Table": new Uint8Array(10) });
    await expect(decryptOffice(legacy, PW)).rejects.toThrow(/구형 바이너리/);
    const ext = writeCfb({ EncryptionInfo: new Uint8Array([4, 0, 3, 0, 0x10, 0, 0, 0]), EncryptedPackage: new Uint8Array(16) });
    await expect(decryptOffice(ext, PW)).rejects.toThrow(/Extensible/);
    await expect(decryptOffice(sampleZip(), PW)).rejects.toThrow(/OLE/);
    for (const bad of [legacy, ext]) await decryptOffice(bad, PW).catch((e: Error) => expect(e.message).not.toContain(PW));
  });
});

// ------------------------------------------------------------------------------------------
// Real documents from test-corpus/ (private; read by path only, contents never copied).
const ROOT = join(process.cwd(), "test-corpus");
const corpus = (dir: string, ext: string) =>
  existsSync(join(ROOT, dir)) ? readdirSync(join(ROOT, dir)).filter((f) => f.toLowerCase().endsWith(ext)).map((f) => join(ROOT, dir, f)) : [];
const docx = corpus("docx", ".docx");
const pptx = corpus("pptx", ".pptx");

describe.skipIf(!docx.length && !pptx.length)("test-corpus encrypt → decrypt → import", () => {
  const PW = "corpus-pw";
  it.each(docx.map((f, i) => [`docx #${i + 1}`, f]))("%s", async (_n, f) => {
    const orig = new Uint8Array(readFileSync(f));
    const dec = await decryptOffice(await encryptOffice(orig, PW), PW);
    expect(same(dec, orig)).toBe(true);
    expect(parseDocx(dec).length).toBe(parseDocx(orig).length);
  }, 180_000);
  it.each(pptx.map((f, i) => [`pptx #${i + 1}`, f]))("%s", async (_n, f) => {
    const orig = new Uint8Array(readFileSync(f));
    const dec = await decryptOffice(await encryptOffice(orig, PW), PW);
    expect(same(dec, orig)).toBe(true);
    expect(importPptx(dec, "x.pptx").pages.length).toBe(importPptx(orig, "x.pptx").pages.length);
  }, 180_000);
});
