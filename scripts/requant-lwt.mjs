// Offline: re-quantise a Loom Infer model (LWT1, U²-Net "layers" or OCR "graph" format) from an f32 / f16 source.
// The output loads with the unchanged runtime (infer/model.ts, infer/graph.ts). Measured choices: INSTALLER_SIZE.md.
//
//   node scripts/requant-lwt.mjs <src.lwt> --out <dst.lwt> [--f16 M | --levels K [--levels-big K2 --big N]]
//
//   (default)        int8 + one f32 scale per output row
//   --levels K       int8 palettised to a k-means codebook of K levels per tensor (0 = plain int8)
//   --levels-big K2  a different K for tensors with ≥ N values (default N = 1e6; e.g. the OCR classifier)
//   --f16 M          U²-Net format only: fp16 normalised per output channel (+ f32 scale, as the shipped file) with the
//                    mantissa rounded to M bits (10 = plain fp16)
//
// Sources: U²-Netp — scripts/convert-u2netp.mjs --f32; PP-OCRv5 — scripts/convert-ppocr.mjs --f32.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { quantRows, entropyBits, toHalf } from "./lwtQuant.mjs";

const halfToFloat = (h) => {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
};

/** Read an LWT1 file: its json and readers for the blob (offsets as in the json). */
export function readLwt(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0, false) !== 0x4c575431) throw new Error("LWT1 expected");
  const jl = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jl)));
  const base = 8 + jl;
  const f32 = (o, n) => Float32Array.from({ length: n }, (_, i) => dv.getFloat32(base + o + i * 4, true));
  const f16 = (o, n) => Float32Array.from({ length: n }, (_, i) => halfToFloat(dv.getUint16(base + o + i * 2, true)));
  return { meta, f32, f16 };
}

/**
 * @param {Uint8Array} bytes source model (f32 or f16)
 * @param {{ levels?: number, levelsBig?: number, big?: number, f16Mantissa?: number, log?: (s: string) => void }} o
 * @returns {Uint8Array}
 */
export function requant(bytes, o = {}) {
  const { meta, f32, f16 } = readLwt(bytes);
  if (meta.dtype === "i8") throw new Error("source must be f32 or f16 (re-quantising int8 compounds rounding)");
  const half = o.f16Mantissa !== undefined;
  if (half && meta.format === "graph") throw new Error("--f16 is for the U²-Net format (graph models load fp16 without per-row scales)");
  const chunks = [];
  let off = 0;
  const push = (u8) => {
    const pad = (4 - (off % 4)) % 4;
    if (pad) chunks.push(new Uint8Array(pad)), (off += pad);
    const at = off;
    chunks.push(u8);
    off += u8.length;
    return at;
  };
  const big = o.big ?? 1e6;
  const levelsFor = (n) => (n >= big && o.levelsBig !== undefined ? o.levelsBig : o.levels ?? 0);
  let hSum = 0, hN = 0;
  const q8 = (data, rows) => {
    const { q, sc } = quantRows(data, rows, { levels: levelsFor(data.length) });
    hSum += entropyBits(q) * q.length;
    hN += q.length;
    return { w: [push(new Uint8Array(q.buffer)), q.length], s: [push(new Uint8Array(sc.buffer)), rows] };
  };
  const h16 = (data, rows) => {
    const per = data.length / rows, h = new Uint16Array(data.length), sc = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let mx = 0;
      for (let i = r * per; i < (r + 1) * per; i++) mx = Math.max(mx, Math.abs(data[i]));
      sc[r] = mx || 1;
      for (let i = r * per; i < (r + 1) * per; i++) h[i] = toHalf(data[i] / sc[r], o.f16Mantissa);
    }
    return { w: [push(new Uint8Array(h.buffer)), h.length], s: [push(new Uint8Array(sc.buffer)), rows] };
  };
  if (meta.format === "graph") {
    const weights = {};
    for (const [name, m] of Object.entries(meta.weights)) {
      const n = m.w[1];
      const data = m.f32 ? f32(m.w[0], n) : f16(m.w[0], n);
      if (n <= 4096 || name.endsWith(":b")) weights[name] = { shape: m.shape, w: [push(new Uint8Array(data.buffer)), n], f32: true };
      else weights[name] = { shape: m.shape, ...q8(data, m.shape[0]) };
    }
    meta.weights = weights;
  } else {
    for (const L of meta.layers) {
      if (L.op !== "conv") continue;
      let w = meta.dtype === "f32" ? f32(L.w[0], L.w[1]) : f16(L.w[0], L.w[1]);
      if (meta.dtype === "f16" && L.s) {
        const sc = f32(L.s[0], L.s[1]), per = L.cin * L.k * L.k;
        w = w.map((v, i) => v * sc[(i / per) | 0]);
      }
      const b = f32(L.b[0], L.b[1]); // biases are f32 in every dtype
      const r = half ? h16(w, L.cout) : q8(w, L.cout);
      L.w = r.w;
      L.s = r.s;
      L.b = [push(new Uint8Array(b.buffer)), b.length];
    }
  }
  meta.dtype = half ? "f16" : "i8";
  let js = JSON.stringify(meta);
  while ((8 + new TextEncoder().encode(js).length) % 4) js += " ";
  const json = new TextEncoder().encode(js);
  const file = new Uint8Array(8 + json.length + off);
  file.set([0x4c, 0x57, 0x54, 0x31]);
  new DataView(file.buffer).setUint32(4, json.length, true);
  file.set(json, 8);
  let p = 8 + json.length;
  for (const c of chunks) file.set(c, p), (p += c.length);
  if (hN) o.log?.(`int8 values ${hN}, entropy ${(hSum / hN).toFixed(3)} bits/value`);
  return file;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const srcPath = args[0];
  if (!srcPath || !opt("--out")) {
    console.error("usage: node scripts/requant-lwt.mjs <src.lwt> --out <dst.lwt> [--f16 M | --levels K [--levels-big K2 --big N]]");
    process.exit(2);
  }
  const out = requant(new Uint8Array(readFileSync(srcPath)), {
    levels: opt("--levels") ? Number(opt("--levels")) : 0,
    levelsBig: opt("--levels-big") ? Number(opt("--levels-big")) : undefined,
    big: opt("--big") ? Number(opt("--big")) : undefined,
    f16Mantissa: opt("--f16") ? Number(opt("--f16")) : undefined,
    log: console.log,
  });
  mkdirSync(dirname(opt("--out")), { recursive: true });
  writeFileSync(opt("--out"), out);
  console.log(`wrote ${opt("--out")}: ${out.length} bytes`);
}
