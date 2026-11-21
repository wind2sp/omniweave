// Loom thread addressing: a fast non-cryptographic 64-bit content hash.
// Two independent 32-bit lanes with multiplicative mixing (cyrb-style), word-at-a-time.
// It is used for identity and integrity of document chunks, not for security.

export function hashBytes(bytes: Uint8Array | Uint8ClampedArray, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const n = bytes.length;
  const words = n >>> 2;
  let i = 0;
  if ((bytes.byteOffset & 3) === 0) {
    const u32 = new Uint32Array(bytes.buffer, bytes.byteOffset, words);
    for (; i < words; i++) {
      const k = u32[i];
      h1 = Math.imul(h1 ^ k, 2654435761);
      h2 = Math.imul(h2 ^ k, 1597334677);
      h1 = (h1 << 13) | (h1 >>> 19);
      h2 = (h2 << 17) | (h2 >>> 15);
    }
    i = words << 2;
  } else {
    for (; i + 3 < n; i += 4) {
      const k = bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
      h1 = Math.imul(h1 ^ k, 2654435761);
      h2 = Math.imul(h2 ^ k, 1597334677);
      h1 = (h1 << 13) | (h1 >>> 19);
      h2 = (h2 << 17) | (h2 >>> 15);
    }
  }
  for (; i < n; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 2654435761);
    h2 = Math.imul(h2 ^ bytes[i], 1597334677);
  }
  h1 ^= n;
  h2 ^= Math.imul(n, 0x9e3779b1);
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
}

const enc = new TextEncoder();
export function hashString(s: string, seed = 0): string {
  return hashBytes(enc.encode(s), seed);
}
