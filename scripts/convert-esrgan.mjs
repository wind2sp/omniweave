// One-off converter: Real-ESRGAN compact models (SRVGGNetCompact — realesr-general-x4v3, realesr-general-wdn-x4v3,
// realesr-animevideov3; BSD-3-Clause, official GitHub release v0.2.5.0) → Omniweave "Loom Infer" graph weights (LWT1,
// meta.format = "graph"), run by src/core/image/infer/graph.ts (CPU / WebAssembly) and graphGpu.ts (WebGPU).
//
//   node scripts/convert-esrgan.mjs <model.pth> --out <file.lwt> [--name <name>] [--f32 | --int8 [--group 9] | --mant <bits>] [--blend <other.pth> --alpha 0.5]
//   (--blend: the weights a·main + (1 − a)·other, the way Real-ESRGAN mixes x4v3 with its denoise variant "wdn")
//
// A .pth file is a zip holding a Python pickle (the dict of tensors) and raw tensor storages. The pickle is NOT
// unpickled by Python: a small reader below understands only the opcodes of a saved state dict and allows exactly four
// globals (collections.OrderedDict, torch._utils._rebuild_tensor_v2, torch.FloatStorage, torch.HalfStorage); every read
// is bounds checked and every tensor must lie inside its storage. Anything else stops with an error; nothing in the
// file is executed (tests/image/convertEsrgan.test.ts).
//
// Network (basicsr/archs/srvgg_arch.py): conv3×3(3→F) PReLU, n × [conv3×3(F→F) PReLU], conv3×3(F→3·r²), PixelShuffle(r),
// plus the input enlarged by nearest neighbour (residual). Input and output RGB in 0..1, NCHW.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { unzipSync } from "fflate";
import { quantRows, toHalf } from "./lwtQuant.mjs";

// ---------- restricted pickle reader ----------

const ALLOWED = new Set(["collections OrderedDict", "torch._utils _rebuild_tensor_v2", "torch FloatStorage", "torch HalfStorage"]);

/** Largest tensor or storage the reader accepts (elements); the compact models have at most 64·64·9 per tensor. */
const MAX_NUMEL = 1 << 26;
const isNat = (v) => Number.isSafeInteger(v) && v >= 0;

/**
 * Reads a torch state-dict pickle. Returns { name → { key, offset, size, stride, dtype } }. Every read is bounds
 * checked, the stack, marks and memo must be used the way a state dict uses them, and only the opcodes below and the
 * globals in ALLOWED are accepted. REDUCE builds an empty OrderedDict or a tensor descriptor as plain data — nothing
 * named in the file is ever called.
 */
export function readStateDict(pkl) {
  const dv = new DataView(pkl.buffer, pkl.byteOffset, pkl.byteLength);
  const stack = [], memo = new Map(), marks = [];
  let p = 0;
  const bad = (what) => {
    throw new Error(`pickle: ${what} (at byte ${p})`);
  };
  const need = (n) => {
    if (!isNat(n) || p + n > pkl.length) bad(`truncated, ${n} bytes wanted`);
  };
  const u8 = () => (need(1), pkl[p++]);
  const u16 = () => (need(2), (p += 2), dv.getUint16(p - 2, true));
  const u32 = () => (need(4), (p += 4), dv.getUint32(p - 4, true));
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  const str = (n) => {
    need(n);
    const s = utf8.decode(pkl.subarray(p, p + n));
    p += n;
    return s;
  };
  const line = () => {
    const e = pkl.indexOf(10, p);
    if (e < 0 || e - p > 256) bad("bad GLOBAL line");
    const s = utf8.decode(pkl.subarray(p, e));
    p = e + 1;
    return s;
  };
  // values above the innermost MARK only
  const floor = () => marks.at(-1) ?? 0;
  const pop = () => (stack.length > floor() ? stack.pop() : bad("stack underflow"));
  const top = () => (stack.length > floor() ? stack.at(-1) : bad("stack underflow"));
  const popMark = () => (marks.length ? stack.splice(marks.pop()) : bad("no MARK"));
  const get = (k) => (memo.has(k) ? memo.get(k) : bad(`memo ${k} not set`));
  const list = () => {
    const l = top();
    return Array.isArray(l) && !Object.isFrozen(l) ? l : bad("APPEND to something that is not a list");
  };
  const dict = () => {
    const d = top();
    return d instanceof Map ? d : bad("SETITEM on something that is not a dict");
  };
  const key = (k) => (typeof k === "string" || typeof k === "number" ? k : bad("dict key of type " + typeof k));
  const global = (mod, name) => {
    if (typeof mod !== "string" || typeof name !== "string") bad("GLOBAL without names");
    const g = `${mod} ${name}`;
    if (!ALLOWED.has(g)) bad("global not allowed: " + g);
    return Object.freeze({ global: g });
  };
  // tuples are frozen arrays (APPEND cannot reach into them)
  const tuple = (a) => Object.freeze(a);
  for (;;) {
    if (p >= pkl.length) bad("no STOP");
    const op = u8();
    switch (op) {
      case 0x80: if (u8() > 5) bad("protocol"); break; // PROTO
      case 0x95: need(8); p += 8; break; // FRAME (a length hint only)
      case 0x7d: stack.push(new Map()); break; // EMPTY_DICT
      case 0x5d: stack.push([]); break; // EMPTY_LIST
      case 0x29: stack.push(tuple([])); break; // EMPTY_TUPLE
      case 0x28: marks.push(stack.length); break; // MARK
      case 0x71: memo.set(u8(), top()); break; // BINPUT
      case 0x72: memo.set(u32(), top()); break; // LONG_BINPUT
      case 0x94: memo.set(memo.size, top()); break; // MEMOIZE
      case 0x68: stack.push(get(u8())); break; // BINGET
      case 0x6a: stack.push(get(u32())); break; // LONG_BINGET
      case 0x58: stack.push(str(u32())); break; // BINUNICODE
      case 0x8c: stack.push(str(u8())); break; // SHORT_BINUNICODE
      case 0x4b: stack.push(u8()); break; // BININT1
      case 0x4d: stack.push(u16()); break; // BININT2
      case 0x4a: need(4), stack.push(dv.getInt32(p, true)), (p += 4); break; // BININT
      case 0x8a: { // LONG1 (at most 6 bytes: exact in a double)
        const n = u8();
        if (n > 6) bad("LONG1 too long");
        need(n);
        let v = 0;
        for (let i = n - 1; i >= 0; i--) v = v * 256 + pkl[p + i];
        if (n && pkl[p + n - 1] & 0x80) v -= 2 ** (8 * n);
        p += n;
        stack.push(v);
        break;
      }
      case 0x47: need(8), stack.push(dv.getFloat64(p, false)), (p += 8); break; // BINFLOAT
      case 0x4e: stack.push(null); break; // NONE
      case 0x88: stack.push(true); break; // NEWTRUE
      case 0x89: stack.push(false); break; // NEWFALSE
      case 0x85: stack.push(tuple([pop()])); break; // TUPLE1
      case 0x86: { const b = pop(), a = pop(); stack.push(tuple([a, b])); break; } // TUPLE2
      case 0x87: { const c = pop(), b = pop(), a = pop(); stack.push(tuple([a, b, c])); break; } // TUPLE3
      case 0x74: stack.push(tuple(popMark())); break; // TUPLE
      case 0x61: { const v = pop(); list().push(v); break; } // APPEND
      case 0x65: { const vs = popMark(); list().push(...vs); break; } // APPENDS
      case 0x73: { const v = pop(), k = key(pop()); dict().set(k, v); break; } // SETITEM
      case 0x75: { // SETITEMS
        const vs = popMark(), d = dict();
        if (vs.length % 2) bad("SETITEMS with an odd count");
        for (let i = 0; i < vs.length; i += 2) d.set(key(vs[i]), vs[i + 1]);
        break;
      }
      case 0x63: { const mod = line(); stack.push(global(mod, line())); break; } // GLOBAL
      case 0x93: { const name = pop(), mod = pop(); stack.push(global(mod, name)); break; } // STACK_GLOBAL
      case 0x51: { // BINPERSID: ('storage', storage type, key, location, numel)
        const pid = pop();
        if (!Array.isArray(pid) || pid.length !== 5 || pid[0] !== "storage" || !/^torch (Float|Half)Storage$/.test(pid[1]?.global ?? "")) bad("unexpected persistent id");
        const k = String(pid[2]);
        if (!/^[A-Za-z0-9_]{1,32}$/.test(k)) bad("storage key " + JSON.stringify(k));
        if (!isNat(pid[4]) || pid[4] > MAX_NUMEL) bad("storage size");
        stack.push(Object.freeze({ storage: k, dtype: pid[1].global === "torch HalfStorage" ? "f16" : "f32", numel: pid[4] }));
        break;
      }
      case 0x52: { // REDUCE — only the two allowed constructors, read as data
        const args = pop(), fn = pop();
        if (!Array.isArray(args)) bad("REDUCE arguments");
        if (fn?.global === "collections OrderedDict") {
          if (args.length) bad("OrderedDict with arguments");
          stack.push(new Map());
        } else if (fn?.global === "torch._utils _rebuild_tensor_v2") {
          const [st, offset, size, stride] = args;
          if (!st?.storage) bad("tensor without storage");
          if (!isNat(offset) || !Array.isArray(size) || !Array.isArray(stride) || size.length !== stride.length || size.length > 8 || ![...size, ...stride].every(isNat)) bad("tensor shape");
          const n = size.reduce((a, b) => a * b, 1);
          if (n > MAX_NUMEL || offset + n > st.numel) bad("tensor outside its storage");
          stack.push(Object.freeze({ key: st.storage, dtype: st.dtype, offset, size: [...size], stride: [...stride] }));
        } else bad("call not allowed");
        break;
      }
      case 0x62: { // BUILD: an OrderedDict's attributes — only torch's `_metadata` (module versions), dropped
        const state = pop(), obj = top();
        if (!(obj instanceof Map) || !(state === null || (state instanceof Map && [...state.keys()].every((k) => k === "_metadata")))) bad("BUILD not allowed");
        break;
      }
      case 0x2e: { // STOP
        const v = pop();
        if (stack.length || marks.length) bad("data left on the stack");
        return v;
      }
      default:
        bad("opcode not allowed 0x" + op.toString(16));
    }
  }
}

/** All float tensors of a .pth: name → { shape, data: Float32Array }. */
export function readPth(bytes) {
  const z = unzipSync(bytes);
  const pklName = Object.keys(z).find((n) => n.endsWith("/data.pkl"));
  if (!pklName) throw new Error("not a torch zip file");
  const root = pklName.slice(0, -"data.pkl".length);
  let dict = readStateDict(z[pklName]);
  if (dict instanceof Map && !dict.has("body.0.weight")) dict = dict.get("params_ema") ?? dict.get("params") ?? dict;
  if (!(dict instanceof Map)) throw new Error("not a state dict");
  const out = new Map();
  for (const [name, t] of dict) {
    if (typeof name !== "string" || !t?.key || !Array.isArray(t.size)) throw new Error("not a tensor: " + String(name));
    const raw = z[`${root}data/${t.key}`];
    if (!raw) throw new Error("missing storage " + t.key);
    const n = t.size.reduce((a, b) => a * b, 1), bpe = t.dtype === "f16" ? 2 : 4;
    if ((t.offset + n) * bpe > raw.length) throw new Error("tensor " + name + " outside its storage file");
    // contiguous tensors only (a saved state dict is)
    let exp = 1;
    for (let i = t.size.length - 1; i >= 0; i--) {
      if (t.size[i] !== 1 && t.stride[i] !== exp) throw new Error("non-contiguous tensor " + name);
      exp *= t.size[i];
    }
    const data = new Float32Array(n);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    for (let i = 0; i < n; i++) data[i] = t.dtype === "f16" ? h2f(dv.getUint16((t.offset + i) * 2, true)) : dv.getFloat32((t.offset + i) * 4, true);
    out.set(name, { shape: t.size.slice(), data });
  }
  return out;
}

function h2f(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
  if (e === 0) return s * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * 2 ** (e - 15) * (1 + f / 1024);
}

function f2h(v) {
  const f = new Float32Array([v]), u = new Uint32Array(f.buffer)[0];
  const s = (u >>> 16) & 0x8000, e = ((u >>> 23) & 255) - 127 + 15;
  let m = u & 0x7fffff;
  if (e <= 0) {
    if (e < -10) return s;
    m |= 0x800000;
    const sh = 14 - e;
    return s | ((m + (1 << (sh - 1))) >> sh);
  }
  if (e >= 31) return s | 0x7c00;
  const r = s | (e << 10) | (m >> 13);
  return m & 0x1000 ? r + 1 : r;
}

// ---------- graph ----------

/** SRVGGNetCompact state dict → { nodes, weights, scale }. */
export function srvggGraph(sd) {
  const convs = [...sd.keys()].filter((k) => /^body\.\d+\.weight$/.test(k) && sd.get(k).shape.length === 4).map((k) => +k.split(".")[1]).sort((a, b) => a - b);
  const last = convs.at(-1);
  const outCh = sd.get(`body.${last}.weight`).shape[0];
  const r = Math.round(Math.sqrt(outCh / 3));
  if (r * r * 3 !== outCh) throw new Error("not an SRVGGNetCompact (last conv " + outCh + " channels)");
  const nodes = [], weights = new Map();
  let v = 0;
  const input = v++;
  let x = input;
  for (const i of convs) {
    const w = `body.${i}.weight`, b = `body.${i}.bias`;
    weights.set(w, sd.get(w));
    weights.set(b, sd.get(b));
    const o = v++;
    const node = { op: "conv", in: [x], out: [o], w, b, a: { stride: [1, 1], pad: [1, 1], dil: [1, 1], groups: 1 } };
    const s = `body.${i + 1}.weight`;
    if (i !== last && sd.has(s) && sd.get(s).shape.length === 1) {
      // conv + PReLU fused into one node (graph.ts / graphGpu.ts apply the slope as the conv's activation)
      weights.set(s, sd.get(s));
      node.act = "prelu";
      node.p = s;
    } else if (i !== last) throw new Error("activation after conv " + i + " is not PReLU");
    // the last conv writes its result through the pixel shuffle (depth to space) directly
    else node.a.shuffle = r;
    nodes.push(node);
    x = o;
  }
  const ps = x;
  const up = v++;
  nodes.push({ op: "nearest_interp", in: [input], out: [up], a: { scale: [r, r], h: 0, w: 0 } });
  const y = v++;
  nodes.push({ op: "add", in: [ps, up], out: [y] });
  return { nodes, weights, input, output: y, scale: r };
}

/** LWT1 bytes of a graph (f16 by default; int8 per output channel for convs with `int8`; f32 lossless). */
export function writeLwt(g, o) {
  const chunks = [];
  let off = 0;
  const push = (b) => {
    const at = off;
    chunks.push(b);
    off += b.length;
    while (off % 4) chunks.push(new Uint8Array(1)), off++;
    return at;
  };
  const wmeta = {};
  let params = 0;
  for (const [name, t] of g.weights) {
    const n = t.data.length;
    params += n;
    if (o.f32 || t.shape.length === 1) wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(t.data.slice().buffer)), n], f32: true };
    else if (o.int8) {
      // int8 with one scale per output channel (o.group = 0) or per group of o.group weights (9 = one 3×3 kernel)
      const rows = o.group ? n / o.group : t.shape[0];
      const { q, sc } = quantRows(t.data, rows);
      wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(q.buffer)), n], s: [push(new Uint8Array(sc.buffer)), rows] };
    } else {
      // fp16, the mantissa optionally rounded to o.mant bits (fewer distinct values: smaller after brotli)
      const h = new Uint16Array(n);
      for (let i = 0; i < n; i++) h[i] = o.mant && o.mant < 10 ? toHalf(t.data[i], o.mant) : f2h(t.data[i]);
      wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(h.buffer)), n] };
    }
  }
  const meta = { model: o.name, format: "graph", dtype: o.f32 ? "f32" : o.int8 ? "i8" : "f16", params, input: g.input, output: g.output, mean: [0, 0, 0], std: [1, 1, 1], scale: g.scale, nodes: g.nodes, weights: wmeta };
  let js = JSON.stringify(meta);
  while ((8 + new TextEncoder().encode(js).length) % 4) js += " ";
  const json = new TextEncoder().encode(js);
  const file = new Uint8Array(8 + json.length + off);
  file.set([0x4c, 0x57, 0x54, 0x31]);
  new DataView(file.buffer).setUint32(4, json.length, true);
  file.set(json, 8);
  let p = 8 + json.length;
  for (const c of chunks) file.set(c, p), (p += c.length);
  return file;
}

// ---------- command line ----------

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const src = args[0], out = opt("--out");
  if (!src || !out) {
    console.error("usage: node scripts/convert-esrgan.mjs <model.pth> --out <file.lwt> [--name n] [--f32|--int8] [--blend other.pth --alpha a]");
    process.exit(2);
  }
  const sd = readPth(new Uint8Array(readFileSync(src)));
  if (opt("--blend")) {
    const other = readPth(new Uint8Array(readFileSync(opt("--blend"))));
    const a = Number(opt("--alpha") ?? 0.5);
    for (const [k, t] of sd) {
      const u = other.get(k);
      if (!u || u.data.length !== t.data.length) throw new Error("blend: different networks at " + k);
      for (let i = 0; i < t.data.length; i++) t.data[i] = a * t.data[i] + (1 - a) * u.data[i];
    }
  }
  const g = srvggGraph(sd);
  const bytes = writeLwt(g, { name: opt("--name") ?? src.split(/[\\/]/).pop().replace(/\.pth$/, ""), f32: args.includes("--f32"), int8: args.includes("--int8"), group: Number(opt("--group") ?? 0), mant: Number(opt("--mant") ?? 10) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} bytes, ${g.nodes.length} nodes, ×${g.scale}`);
}
