// Password-protected .omw — the whole workspace package is encrypted with AES-256-GCM under a
// key derived from the password (PBKDF2-SHA-256, 600 000 iterations). The outer container is
// still a zip with the Omniweave mimetype so the file type stays recognisable, but nothing
// about the content (titles, pages, history) is readable without the password.

import { t } from "../../i18n";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

const subtle = globalThis.crypto.subtle;
const ITER = 600_000;
const MIME = "application/x-omniweave";

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array, iterations: number) {
  const base = await subtle.importKey("raw", new TextEncoder().encode(password.normalize("NFC")) as BufferSource, "PBKDF2", false, ["deriveKey"]);
  return subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export function isEncryptedOmw(bytes: Uint8Array): boolean {
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === "encryption.json" });
    return !!files["encryption.json"];
  } catch {
    return false;
  }
}

export async function encryptOmw(plain: Uint8Array, password: string): Promise<Uint8Array> {
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITER);
  const header = { v: 1, kdf: "PBKDF2-SHA-256", iterations: ITER, salt: b64(salt), cipher: "AES-256-GCM", iv: b64(iv) };
  // the header is bound to the ciphertext as additional data, so it cannot be swapped
  const aad = strToU8(JSON.stringify(header));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource, additionalData: aad as BufferSource }, key, plain as BufferSource));
  return zipSync({
    mimetype: [strToU8(MIME), { level: 0 }],
    "manifest.json": strToU8(JSON.stringify({ format: "omw", version: 1, encrypted: true }, null, 2)),
    "encryption.json": aad,
    "payload.omw.enc": [ct, { level: 0 }],
  });
}

export async function decryptOmw(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const files = unzipSync(bytes);
  const aad = files["encryption.json"];
  const ct = files["payload.omw.enc"];
  if (!aad || !ct) throw new Error(t("engine.crypto.omwNotEncrypted"));
  const h = JSON.parse(strFromU8(aad));
  if (h.v !== 1 || h.cipher !== "AES-256-GCM") throw new Error(t("engine.crypto.omwMethod"));
  // the header is attacker-controlled until the tag verifies: bound the work it can demand
  if (!Number.isInteger(h.iterations) || h.iterations < 1 || h.iterations > 10_000_000) throw new Error(t("engine.crypto.omwIterations"));
  const key = await deriveKey(password, unb64(h.salt), h.iterations);
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: unb64(h.iv) as BufferSource, additionalData: aad as BufferSource }, key, ct as BufferSource));
  } catch {
    throw new Error("WRONG_PASSWORD");
  }
}
