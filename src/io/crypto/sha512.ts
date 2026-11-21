// Synchronous SHA-512 / SHA-384 / SHA-256 / SHA-1 (FIPS 180-4, public standard). Used for the Office
// key-derivation spin loops (50 000–100 000 iterations), where awaiting WebCrypto per round is slow. Bulk hashing
// elsewhere still uses WebCrypto; tests cross-check this implementation against it.

const K = (() => {
  const hex = [
    "428a2f98d728ae22", "7137449123ef65cd", "b5c0fbcfec4d3b2f", "e9b5dba58189dbbc", "3956c25bf348b538", "59f111f1b605d019",
    "923f82a4af194f9b", "ab1c5ed5da6d8118", "d807aa98a3030242", "12835b0145706fbe", "243185be4ee4b28c", "550c7dc3d5ffb4e2",
    "72be5d74f27b896f", "80deb1fe3b1696b1", "9bdc06a725c71235", "c19bf174cf692694", "e49b69c19ef14ad2", "efbe4786384f25e3",
    "0fc19dc68b8cd5b5", "240ca1cc77ac9c65", "2de92c6f592b0275", "4a7484aa6ea6e483", "5cb0a9dcbd41fbd4", "76f988da831153b5",
    "983e5152ee66dfab", "a831c66d2db43210", "b00327c898fb213f", "bf597fc7beef0ee4", "c6e00bf33da88fc2", "d5a79147930aa725",
    "06ca6351e003826f", "142929670a0e6e70", "27b70a8546d22ffc", "2e1b21385c26c926", "4d2c6dfc5ac42aed", "53380d139d95b3df",
    "650a73548baf63de", "766a0abb3c77b2a8", "81c2c92e47edaee6", "92722c851482353b", "a2bfe8a14cf10364", "a81a664bbc423001",
    "c24b8b70d0f89791", "c76c51a30654be30", "d192e819d6ef5218", "d69906245565a910", "f40e35855771202a", "106aa07032bbd1b8",
    "19a4c116b8d2d0c8", "1e376c085141ab53", "2748774cdf8eeb99", "34b0bcb5e19b48a8", "391c0cb3c5c95a63", "4ed8aa4ae3418acb",
    "5b9cca4f7763e373", "682e6ff3d6b2b8a3", "748f82ee5defb2fc", "78a5636f43172f60", "84c87814a1f0ab72", "8cc702081a6439ec",
    "90befffa23631e28", "a4506cebde82bde9", "bef9a3f7b2c67915", "c67178f2e372532b", "ca273eceea26619c", "d186b8c721c0c207",
    "eada7dd6cde0eb1e", "f57d4f7fee6ed178", "06f067aa72176fba", "0a637dc5a2c898a6", "113f9804bef90dae", "1b710b35131c471b",
    "28db77f523047d84", "32caab7b40c72493", "3c9ebe0a15c9bebc", "431d67c49c100d4c", "4cc5d4becb3e42b6", "597f299cfc657e2a",
    "5fcb6fab3ad6faec", "6c44198c4a475817",
  ];
  const k = new Int32Array(160);
  hex.forEach((h, i) => {
    k[i * 2] = parseInt(h.slice(0, 8), 16) | 0;
    k[i * 2 + 1] = parseInt(h.slice(8), 16) | 0;
  });
  return k;
})();

const IV512 = Int32Array.from([0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1, 0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179], (v) => v | 0);
const IV384 = Int32Array.from([0xcbbb9d5d, 0xc1059ed8, 0x629a292a, 0x367cd507, 0x9159015a, 0x3070dd17, 0x152fecd8, 0xf70e5939, 0x67332667, 0xffc00b31, 0x8eb44a87, 0x68581511, 0xdb0c2e0d, 0x64f98fa7, 0x47b5481d, 0xbefa4fa4], (v) => v | 0);

const W = new Int32Array(160);

// One compression round over a 128-byte block at `off`; H holds 8 (hi, lo) word pairs.
function compress(H: Int32Array, b: Uint8Array, off: number) {
  for (let i = 0; i < 32; i++) {
    const o = off + i * 4;
    W[i] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }
  for (let i = 16; i < 80; i++) {
    // σ0(w[i-15])
    let xh = W[(i - 15) * 2], xl = W[(i - 15) * 2 + 1];
    const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
    const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
    // σ1(w[i-2])
    xh = W[(i - 2) * 2];
    xl = W[(i - 2) * 2 + 1];
    const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
    const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
    let lo = (s0l >>> 0) + (s1l >>> 0) + (W[(i - 7) * 2 + 1] >>> 0) + (W[(i - 16) * 2 + 1] >>> 0);
    const hi = s0h + s1h + W[(i - 7) * 2] + W[(i - 16) * 2] + ((lo / 0x100000000) | 0);
    W[i * 2] = hi | 0;
    W[i * 2 + 1] = lo | 0;
  }
  let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
  let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
  for (let i = 0; i < 80; i++) {
    // Σ1(e)
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
    let t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K[i * 2 + 1] >>> 0) + (W[i * 2 + 1] >>> 0);
    const t1h = (hh + S1h + chh + K[i * 2] + W[i * 2] + ((t1l / 0x100000000) | 0)) | 0;
    t1l = t1l | 0;
    // Σ0(a)
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
    const t2l = (S0l >>> 0) + (mjl >>> 0);
    const t2h = (S0h + mjh + ((t2l / 0x100000000) | 0)) | 0;
    hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
    const el2 = (dl >>> 0) + (t1l >>> 0);
    eh = (dh + t1h + ((el2 / 0x100000000) | 0)) | 0;
    el = el2 | 0;
    dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
    const al2 = (t1l >>> 0) + (t2l >>> 0);
    ah = (t1h + t2h + ((al2 / 0x100000000) | 0)) | 0;
    al = al2 | 0;
  }
  let lo: number;
  lo = (H[1] >>> 0) + (al >>> 0); H[0] = (H[0] + ah + ((lo / 0x100000000) | 0)) | 0; H[1] = lo | 0;
  lo = (H[3] >>> 0) + (bl >>> 0); H[2] = (H[2] + bh + ((lo / 0x100000000) | 0)) | 0; H[3] = lo | 0;
  lo = (H[5] >>> 0) + (cl >>> 0); H[4] = (H[4] + ch + ((lo / 0x100000000) | 0)) | 0; H[5] = lo | 0;
  lo = (H[7] >>> 0) + (dl >>> 0); H[6] = (H[6] + dh + ((lo / 0x100000000) | 0)) | 0; H[7] = lo | 0;
  lo = (H[9] >>> 0) + (el >>> 0); H[8] = (H[8] + eh + ((lo / 0x100000000) | 0)) | 0; H[9] = lo | 0;
  lo = (H[11] >>> 0) + (fl >>> 0); H[10] = (H[10] + fh + ((lo / 0x100000000) | 0)) | 0; H[11] = lo | 0;
  lo = (H[13] >>> 0) + (gl >>> 0); H[12] = (H[12] + gh + ((lo / 0x100000000) | 0)) | 0; H[13] = lo | 0;
  lo = (H[15] >>> 0) + (hl >>> 0); H[14] = (H[14] + hh + ((lo / 0x100000000) | 0)) | 0; H[15] = lo | 0;
}

const STATE = new Int32Array(16);
const TAIL = new Uint8Array(256);

function digest(iv: Int32Array, outLen: number, data: Uint8Array): Uint8Array {
  const H = STATE;
  H.set(iv);
  const n = data.length;
  const full = n - (n % 128);
  for (let o = 0; o < full; o += 128) compress(H, data, o);
  const rest = n - full;
  const tailLen = rest < 112 ? 128 : 256;
  const tail = TAIL;
  tail.fill(0, 0, tailLen);
  for (let i = 0; i < rest; i++) tail[i] = data[full + i];
  tail[rest] = 0x80;
  // message length in bits (128-bit big-endian; inputs here are far below 2^53 bits)
  const bits = n * 8;
  const hiBits = Math.floor(bits / 0x100000000), loBits = bits >>> 0;
  tail[tailLen - 8] = hiBits >>> 24; tail[tailLen - 7] = hiBits >>> 16; tail[tailLen - 6] = hiBits >>> 8; tail[tailLen - 5] = hiBits;
  tail[tailLen - 4] = loBits >>> 24; tail[tailLen - 3] = loBits >>> 16; tail[tailLen - 2] = loBits >>> 8; tail[tailLen - 1] = loBits;
  for (let o = 0; o < tailLen; o += 128) compress(H, tail, o);
  const out = new Uint8Array(outLen);
  for (let i = 0; i < outLen; i++) out[i] = H[i >> 2] >>> (24 - (i & 3) * 8);
  return out;
}

export function sha512(data: Uint8Array): Uint8Array {
  return digest(IV512, 64, data);
}

export function sha384(data: Uint8Array): Uint8Array {
  return digest(IV384, 48, data);
}

// ---- SHA-1 and SHA-256 (FIPS 180-4) for the same purpose: Standard encryption spins SHA-1
// 50 000 times, and Agile files may use SHA-1/SHA-256 for their spin loop.

const W32 = new Int32Array(80);
const S32 = new Int32Array(8);
const TAIL32 = new Uint8Array(128);

function md32(data: Uint8Array, iv: number[], outWords: number, block: (H: Int32Array, b: Uint8Array, o: number) => void): Uint8Array {
  const H = S32;
  for (let i = 0; i < iv.length; i++) H[i] = iv[i] | 0;
  const n = data.length;
  const full = n - (n % 64);
  for (let o = 0; o < full; o += 64) block(H, data, o);
  const rest = n - full;
  const tailLen = rest < 56 ? 64 : 128;
  TAIL32.fill(0, 0, tailLen);
  for (let i = 0; i < rest; i++) TAIL32[i] = data[full + i];
  TAIL32[rest] = 0x80;
  const bits = n * 8;
  const hiBits = Math.floor(bits / 0x100000000), loBits = bits >>> 0;
  TAIL32[tailLen - 8] = hiBits >>> 24; TAIL32[tailLen - 7] = hiBits >>> 16; TAIL32[tailLen - 6] = hiBits >>> 8; TAIL32[tailLen - 5] = hiBits;
  TAIL32[tailLen - 4] = loBits >>> 24; TAIL32[tailLen - 3] = loBits >>> 16; TAIL32[tailLen - 2] = loBits >>> 8; TAIL32[tailLen - 1] = loBits;
  for (let o = 0; o < tailLen; o += 64) block(H, TAIL32, o);
  const out = new Uint8Array(outWords * 4);
  for (let i = 0; i < out.length; i++) out[i] = H[i >> 2] >>> (24 - (i & 3) * 8);
  return out;
}

function sha1Block(H: Int32Array, b: Uint8Array, off: number) {
  const w = W32;
  for (let i = 0; i < 16; i++) {
    const o = off + i * 4;
    w[i] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }
  for (let i = 16; i < 80; i++) {
    const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
    w[i] = (x << 1) | (x >>> 31);
  }
  let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4];
  for (let i = 0; i < 80; i++) {
    let f: number, k: number;
    if (i < 20) { f = (bb & c) | (~bb & d); k = 0x5a827999; }
    else if (i < 40) { f = bb ^ c ^ d; k = 0x6ed9eba1; }
    else if (i < 60) { f = (bb & c) | (bb & d) | (c & d); k = 0x8f1bbcdc; }
    else { f = bb ^ c ^ d; k = 0xca62c1d6; }
    const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) | 0;
    e = d; d = c; c = (bb << 30) | (bb >>> 2); bb = a; a = t;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0;
}

const K256 = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
], (v) => v | 0);

function sha256Block(H: Int32Array, b: Uint8Array, off: number) {
  const w = W32;
  for (let i = 0; i < 16; i++) {
    const o = off + i * 4;
    w[i] = (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
  }
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15], y = w[i - 2];
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
  }
  let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
  for (let i = 0; i < 64; i++) {
    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) | 0;
    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    const t2 = (S0 + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
  }
  H[0] = (H[0] + a) | 0; H[1] = (H[1] + bb) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
  H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
}

export function sha1(data: Uint8Array): Uint8Array {
  return md32(data, [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], 5, sha1Block);
}

export function sha256(data: Uint8Array): Uint8Array {
  return md32(data, [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], 8, sha256Block);
}
