// Weight quantisation shared by the offline converters (convert-ppocr.mjs, requant-lwt.mjs).
//
// Every scheme writes a format the app already loads (infer/model.ts, infer/graph.ts), so the runtime does not change.
// What changes is how much information a tensor carries. The installer stores every bundled file brotli-compressed
// (Tauri embeds assets with brotli q9; NSIS LZMA cannot shrink that further), so the entropy is what costs bytes:
//
//   quantRows, levels = 0  plain symmetric int8 + one f32 scale per output row (PP-OCRv5 — what the app ships)
//   quantRows, levels = K  int8 snapped to a per-tensor 1-D k-means codebook of K levels (weight sharing, Han et al.
//                          2016 "Deep Compression" §3, without retraining) — measured: costs OCR accuracy, not used
//   toHalf(v, M)           fp16 with the mantissa rounded to M bits (U²-Netp: M = 9)
//
// docs/design/INSTALLER_SIZE.md has the measured sizes and the CER / matte checks behind these choices.

/**
 * Quantise `data` (row-major, `rows` output rows) to int8 + per-row scale.
 * @param {Float32Array | number[]} data
 * @param {number} rows
 * @param {{ levels?: number }} [o]
 * @returns {{ q: Int8Array, sc: Float32Array }}
 */
export function quantRows(data, rows, o = {}) {
  const n = data.length, per = n / rows;
  if (!Number.isInteger(per)) throw new Error("quantRows: length not a multiple of rows");
  const q = new Int8Array(n), sc = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let mx = 0;
    for (let i = r * per; i < (r + 1) * per; i++) mx = Math.max(mx, Math.abs(data[i]));
    sc[r] = mx / 127 || 1;
    for (let i = r * per; i < (r + 1) * per; i++) q[i] = Math.round(data[i] / sc[r]);
  }
  const K = o.levels ?? 0;
  if (K > 0 && K < 255) palettise(q, K);
  return { q, sc };
}

/**
 * Replace the int8 values of `q` in place by a K-level codebook on the int8 grid (1-D k-means over the value
 * histogram — exact Lloyd iterations, the data is only 255 distinct values). Returns the codebook.
 * @param {Int8Array} q
 * @param {number} K
 */
export function palettise(q, K) {
  const hist = new Float64Array(255);
  for (let i = 0; i < q.length; i++) hist[q[i] + 127]++;
  const used = [];
  for (let v = 0; v < 255; v++) if (hist[v]) used.push(v - 127);
  if (used.length <= K) return Int8Array.from(used);
  // init: quantiles of the distribution (dense where weights are dense)
  const total = q.length;
  let c = [];
  {
    let acc = 0, k = 0;
    for (let v = 0; v < 255 && k < K; v++) {
      acc += hist[v];
      while (k < K && acc >= ((k + 0.5) / K) * total) {
        c.push(v - 127);
        k++;
      }
    }
    while (c.length < K) c.push(127);
  }
  c = [...new Set(c.map(Number))].sort((a, b) => a - b);
  // make sure the extremes are represented (the per-row max is always ±127 somewhere)
  for (let it = 0; it < 60; it++) {
    const sum = new Float64Array(c.length), cnt = new Float64Array(c.length);
    let j = 0;
    for (let v = 0; v < 255; v++) {
      if (!hist[v]) continue;
      const x = v - 127;
      while (j + 1 < c.length && Math.abs(c[j + 1] - x) < Math.abs(c[j] - x)) j++;
      sum[j] += x * hist[v];
      cnt[j] += hist[v];
    }
    const nc = c.map((old, k) => (cnt[k] ? Math.round(sum[k] / cnt[k]) : old));
    const uniq = [...new Set(nc)].sort((a, b) => a - b);
    // re-seed lost levels at the widest gap so the codebook keeps K entries
    while (uniq.length < Math.min(K, used.length)) {
      let gi = 0, gw = -1;
      for (let k = 0; k + 1 < uniq.length; k++) if (uniq[k + 1] - uniq[k] > gw) (gw = uniq[k + 1] - uniq[k]), (gi = k);
      if (gw < 2) break;
      uniq.splice(gi + 1, 0, Math.round((uniq[gi] + uniq[gi + 1]) / 2));
    }
    const same = uniq.length === c.length && uniq.every((v, k) => v === c[k]);
    c = uniq;
    if (same) break;
  }
  const map = new Int8Array(255);
  {
    let j = 0;
    for (let v = 0; v < 255; v++) {
      const x = v - 127;
      while (j + 1 < c.length && Math.abs(c[j + 1] - x) <= Math.abs(c[j] - x)) j++;
      map[v] = c[j];
    }
  }
  for (let i = 0; i < q.length; i++) q[i] = map[q[i] + 127];
  return Int8Array.from(c);
}

const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);

/**
 * IEEE half (round to nearest) of `v` rounded first to `mant` mantissa bits (10 = plain fp16). Fewer mantissa bits keep
 * the RELATIVE precision of every weight (2^-(mant+1)) — unlike int8, which loses the small weights of a channel that
 * has one large one — and leave the low bits zero, which the installer's compressor then stores almost for free.
 * @param {number} v
 * @param {number} [mant]
 */
export function toHalf(v, mant = 10) {
  f32b[0] = v;
  if (mant < 10) {
    const d = 23 - mant;
    u32b[0] = (u32b[0] + (1 << (d - 1))) & ~((1 << d) - 1) & 0xffffffff;
  }
  const x = u32b[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >>> (1 - e);
    if (m & 0x1000) m += 0x2000;
    const h = sign | (m >>> 13);
    // subnormal halves: keep the same number of significant bits as the normal ones
    return mant < 10 ? h & ~((1 << (10 - mant)) - 1) : h;
  }
  if (m & 0x1000) {
    m += 0x2000;
    if (m & 0x800000) {
      m = 0;
      e++;
      if (e >= 31) return sign | 0x7c00;
    }
  }
  return sign | (e << 10) | (m >>> 13);
}

/** Shannon entropy (bits per value) of an int8 array — what an ideal static entropy coder would spend. */
export function entropyBits(q) {
  const hist = new Float64Array(256);
  for (let i = 0; i < q.length; i++) hist[q[i] & 255]++;
  let h = 0;
  for (const c of hist) if (c) h -= (c / q.length) * Math.log2(c / q.length);
  return h;
}
