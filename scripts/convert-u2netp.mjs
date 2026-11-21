// One-off converter: U²-Netp ONNX (xuebinqin/U-2-Net, Apache-2.0; ONNX export as published by rembg) →
// Omniweave "Loom Infer" weights (src/assets/models/u2netp.lwt).
//
//   node scripts/convert-u2netp.mjs <u2netp.onnx> [--out src/assets/models/u2netp.lwt] [--int8] [--dump]
//   The shipped file is fp16 with a 9-bit mantissa: --f32 --out u-f32.lwt, then
//   node scripts/requant-lwt.mjs u-f32.lwt --f16 9 --out src/assets/models/u2netp.lwt (docs/design/INSTALLER_SIZE.md §4).
//
// Runs once, offline. No runtime dependency: a tiny protobuf reader decodes just the ONNX fields we need, the shape
// sub-graphs (Shape/Gather/Concat → Resize sizes) are folded statically for the fixed 1×3×320×320 input, every
// BatchNormalization is folded into the conv before it, and the graph is pruned to what the fused output (d0) needs.
//
// File layout (little endian):
//   "LWT1" | u32 jsonLength | json (utf-8) | pad to 4 | weight blob
// json = { model, input:[c,h,w], dtype:"f16"|"i8", layers:[...], tensors:{name:{shape}} , output }
// Each conv layer: { op:"conv", in, out, cin, cout, k, pad, dil, relu, w:[offset,count], b:[offset,count], s?:[offset,count] }
//   f16: w and b are float16; i8: w is int8 with one f32 scale per output channel (s), b stays float32.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const args = process.argv.slice(2);
const src = args.find((a) => !a.startsWith("--"));
if (!src) {
  console.error("usage: node scripts/convert-u2netp.mjs <u2netp.onnx> [--out file] [--int8] [--dump]");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const INT8 = args.includes("--int8");
const F32 = args.includes("--f32"); // dev only: lossless reference copy to separate engine error from weight rounding
const out = outIdx >= 0 ? args[outIdx + 1] : INT8 ? "src/assets/models/u2netp-i8.lwt" : "src/assets/models/u2netp.lwt";
const DUMP = args.includes("--dump");

// ---------- minimal protobuf ----------
function reader(buf) {
  let p = 0;
  const varint = () => {
    let r = 0n, s = 0n;
    for (;;) {
      const b = buf[p++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7n;
    }
    return r;
  };
  return {
    get done() {
      return p >= buf.length;
    },
    next() {
      const key = Number(varint());
      const field = key >>> 3, wt = key & 7;
      if (wt === 0) return { field, wt, v: varint() };
      if (wt === 1) {
        const v = buf.subarray(p, p + 8);
        p += 8;
        return { field, wt, v };
      }
      if (wt === 2) {
        const n = Number(varint());
        const v = buf.subarray(p, p + n);
        p += n;
        return { field, wt, v };
      }
      if (wt === 5) {
        const v = buf.subarray(p, p + 4);
        p += 4;
        return { field, wt, v };
      }
      throw new Error("wire type " + wt);
    },
  };
}
const td = new TextDecoder();
const str = (b) => td.decode(b);
const toInt64 = (v) => {
  let x = BigInt.asIntN(64, v);
  return Number(x);
};
function packedVarints(b) {
  const r = reader(b);
  const out = [];
  // packed: just a sequence of varints without keys
  let p = 0;
  while (p < b.length) {
    let v = 0n, s = 0n;
    for (;;) {
      const c = b[p++];
      v |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) break;
      s += 7n;
    }
    out.push(toInt64(v));
  }
  void r;
  return out;
}
function f32(b) {
  return new DataView(b.buffer, b.byteOffset, 4).getFloat32(0, true);
}

function parseTensor(b) {
  const t = { dims: [], type: 1, name: "", raw: null, floats: [], ints: [] };
  const r = reader(b);
  while (!r.done) {
    const { field, wt, v } = r.next();
    if (field === 1) wt === 2 ? t.dims.push(...packedVarints(v)) : t.dims.push(toInt64(v));
    else if (field === 2) t.type = Number(v);
    else if (field === 4) {
      if (wt === 2) for (let i = 0; i < v.length; i += 4) t.floats.push(f32(v.subarray(i)));
      else t.floats.push(f32(v));
    } else if (field === 7) wt === 2 ? t.ints.push(...packedVarints(v)) : t.ints.push(toInt64(v));
    else if (field === 8) t.name = str(v);
    else if (field === 9) t.raw = v;
  }
  return t;
}
function tensorValues(t) {
  const n = t.dims.reduce((a, b) => a * b, 1);
  if (t.type === 1) {
    if (t.raw) {
      const a = new Float32Array(n);
      const dv = new DataView(t.raw.buffer, t.raw.byteOffset, t.raw.length);
      for (let i = 0; i < n; i++) a[i] = dv.getFloat32(i * 4, true);
      return a;
    }
    return Float32Array.from(t.floats);
  }
  if (t.type === 7) {
    if (t.raw) {
      const a = [];
      const dv = new DataView(t.raw.buffer, t.raw.byteOffset, t.raw.length);
      for (let i = 0; i < t.raw.length / 8; i++) a.push(Number(dv.getBigInt64(i * 8, true)));
      return a;
    }
    return t.ints;
  }
  if (t.type === 6) {
    if (t.raw) {
      const a = [];
      const dv = new DataView(t.raw.buffer, t.raw.byteOffset, t.raw.length);
      for (let i = 0; i < t.raw.length / 4; i++) a.push(dv.getInt32(i * 4, true));
      return a;
    }
    return t.ints;
  }
  throw new Error("tensor type " + t.type + " " + t.name);
}
function parseAttr(b) {
  const a = { name: "", f: 0, i: 0, s: "", t: null, floats: [], ints: [], type: 0 };
  const r = reader(b);
  while (!r.done) {
    const { field, wt, v } = r.next();
    if (field === 1) a.name = str(v);
    else if (field === 2) a.f = f32(v);
    else if (field === 3) a.i = toInt64(v);
    else if (field === 4) a.s = str(v);
    else if (field === 5) a.t = parseTensor(v);
    else if (field === 7) {
      if (wt === 2) for (let i = 0; i < v.length; i += 4) a.floats.push(f32(v.subarray(i)));
      else a.floats.push(f32(v));
    } else if (field === 8) wt === 2 ? a.ints.push(...packedVarints(v)) : a.ints.push(toInt64(v));
    else if (field === 20) a.type = Number(v);
  }
  return a;
}
function parseNode(b) {
  const n = { input: [], output: [], name: "", op: "", attrs: {} };
  const r = reader(b);
  while (!r.done) {
    const { field, v } = r.next();
    if (field === 1) n.input.push(str(v));
    else if (field === 2) n.output.push(str(v));
    else if (field === 3) n.name = str(v);
    else if (field === 4) n.op = str(v);
    else if (field === 5) {
      const a = parseAttr(v);
      n.attrs[a.name] = a;
    }
  }
  return n;
}
function parseValueInfoName(b) {
  const r = reader(b);
  while (!r.done) {
    const { field, v } = r.next();
    if (field === 1) return str(v);
  }
  return "";
}
function parseGraph(b) {
  const g = { nodes: [], inits: new Map(), inputs: [], outputs: [] };
  const r = reader(b);
  while (!r.done) {
    const { field, v } = r.next();
    if (field === 1) g.nodes.push(parseNode(v));
    else if (field === 5) {
      const t = parseTensor(v);
      g.inits.set(t.name, t);
    } else if (field === 11) g.inputs.push(parseValueInfoName(v));
    else if (field === 12) g.outputs.push(parseValueInfoName(v));
  }
  return g;
}
function parseModel(buf) {
  const r = reader(buf);
  while (!r.done) {
    const { field, v } = r.next();
    if (field === 7) return parseGraph(v);
  }
  throw new Error("no graph");
}

// ---------- load ----------
const g = parseModel(new Uint8Array(readFileSync(src)));
const graphInputs = g.inputs.filter((n) => !g.inits.has(n));
if (DUMP) {
  const ops = {};
  for (const n of g.nodes) ops[n.op] = (ops[n.op] ?? 0) + 1;
  console.log("inputs", graphInputs, "outputs", g.outputs, "nodes", g.nodes.length, "inits", g.inits.size);
  console.log(ops);
  for (const n of g.nodes.slice(0, 40)) console.log(n.op, n.input.join(","), "->", n.output.join(","), Object.values(n.attrs).map((a) => `${a.name}=${a.ints.length ? a.ints : a.i || a.f || a.s}`).join(" "));
}

// ---------- static evaluation of constants / shapes ----------
const consts = new Map(); // name -> { shape, values (plain array or Float32Array) }
for (const [name, t] of g.inits) consts.set(name, { shape: t.dims, values: tensorValues(t) });
const shapes = new Map(); // activation name -> [c,h,w] (batch 1 dropped)
const IN = graphInputs[0];
shapes.set(IN, [3, 320, 320]);

const producer = new Map();
for (const n of g.nodes) for (const o of n.output) producer.set(o, n);

const layers = [];
const alias = new Map(); // tensor name -> name it is identical to (Identity etc.)
const A = (n) => (alias.has(n) ? A(alias.get(n)) : n);
const pendingBN = new Map(); // conv output name -> conv layer (to fold a following BatchNormalization)

const convOut = (h, k, pad, dil, stride) => Math.floor((h + 2 * pad - dil * (k - 1) - 1) / stride) + 1;

for (const n of g.nodes) {
  const ins = n.input.map(A);
  const allConst = ins.every((x) => x === "" || consts.has(x));
  const at = n.attrs;
  if (n.op === "Constant") {
    const t = at.value.t;
    consts.set(n.output[0], { shape: t.dims, values: tensorValues(t) });
    continue;
  }
  if (n.op === "Shape") {
    const s = shapes.get(ins[0]);
    if (!s) throw new Error("shape of unknown " + ins[0]);
    consts.set(n.output[0], { shape: [4], values: [1, ...s] });
    continue;
  }
  if (allConst && ["Gather", "Unsqueeze", "Concat", "Cast", "Slice", "Mul", "Div", "Floor", "Squeeze"].includes(n.op)) {
    const v = ins.map((x) => (x ? consts.get(x) : null));
    let res;
    if (n.op === "Gather") {
      const idx = v[1].values;
      res = { shape: v[1].shape, values: Array.from(idx, (i) => v[0].values[i < 0 ? v[0].values.length + i : i]) };
    } else if (n.op === "Unsqueeze" || n.op === "Squeeze" || n.op === "Cast" || n.op === "Floor") {
      res = { shape: [v[0].values.length], values: Array.from(v[0].values, n.op === "Floor" ? Math.floor : (x) => x) };
    } else if (n.op === "Concat") {
      res = { shape: [0], values: v.flatMap((x) => Array.from(x.values)) };
    } else if (n.op === "Slice") {
      const data = Array.from(v[0].values);
      const starts = at.starts ? at.starts.ints : Array.from(v[1].values);
      const ends = at.ends ? at.ends.ints : Array.from(v[2].values);
      let s0 = starts[0], e0 = Math.min(ends[0], data.length);
      if (s0 < 0) s0 += data.length;
      if (e0 < 0) e0 += data.length;
      res = { shape: [0], values: data.slice(s0, e0) };
    } else if (n.op === "Mul" || n.op === "Div") {
      const a = Array.from(v[0].values), b = Array.from(v[1].values);
      res = { shape: [a.length], values: a.map((x, i) => (n.op === "Mul" ? x * b[b.length === 1 ? 0 : i] : x / b[b.length === 1 ? 0 : i])) };
    }
    consts.set(n.output[0], res);
    continue;
  }
  if (n.op === "Identity" || n.op === "Dropout") {
    alias.set(n.output[0], ins[0]);
    if (consts.has(ins[0])) consts.set(n.output[0], consts.get(ins[0]));
    continue;
  }
  if (n.op === "Conv") {
    const W = consts.get(ins[1]);
    const B = ins[2] ? consts.get(ins[2]) : null;
    const [cout, cin, kh, kw] = W.shape;
    if (kh !== kw) throw new Error("non-square kernel");
    const pads = at.pads ? at.pads.ints : [0, 0, 0, 0];
    const dil = at.dilations ? at.dilations.ints[0] : 1;
    const stride = at.strides ? at.strides.ints[0] : 1;
    const group = at.group ? at.group.i : 1;
    if (stride !== 1 || group !== 1 || pads[0] !== pads[2] || pads[1] !== pads[3] || pads[0] !== pads[1]) throw new Error("unsupported conv " + n.name);
    const s = shapes.get(ins[0]);
    if (s[0] !== cin) throw new Error("cin mismatch");
    const layer = { op: "conv", in: ins[0], out: n.output[0], cin, cout, k: kh, pad: pads[0], dil, relu: false, W: Float32Array.from(W.values), B: B ? Float32Array.from(B.values) : new Float32Array(cout) };
    layers.push(layer);
    shapes.set(n.output[0], [cout, convOut(s[1], kh, pads[0], dil, 1), convOut(s[2], kh, pads[0], dil, 1)]);
    pendingBN.set(n.output[0], layer);
    continue;
  }
  if (n.op === "BatchNormalization") {
    const layer = pendingBN.get(ins[0]);
    if (!layer) throw new Error("BN not after conv");
    const [sc, bi, mean, vr] = ins.slice(1).map((x) => consts.get(x).values);
    const eps = at.epsilon ? at.epsilon.f : 1e-5;
    const per = layer.cin * layer.k * layer.k;
    for (let o = 0; o < layer.cout; o++) {
      const m = sc[o] / Math.sqrt(vr[o] + eps);
      for (let i = 0; i < per; i++) layer.W[o * per + i] *= m;
      layer.B[o] = (layer.B[o] - mean[o]) * m + bi[o];
    }
    layer.out = n.output[0];
    pendingBN.delete(ins[0]);
    pendingBN.set(n.output[0], layer);
    shapes.set(n.output[0], shapes.get(ins[0]));
    continue;
  }
  if (n.op === "Relu") {
    const layer = pendingBN.get(ins[0]);
    if (layer && layer.out === ins[0]) {
      layer.relu = true;
      layer.out = n.output[0];
      pendingBN.delete(ins[0]);
    } else layers.push({ op: "relu", in: ins[0], out: n.output[0] });
    shapes.set(n.output[0], shapes.get(ins[0]));
    continue;
  }
  if (n.op === "Add") {
    // residual add (x + hxin) in the RSU blocks
    layers.push({ op: "add", in: [ins[0], ins[1]], out: n.output[0] });
    shapes.set(n.output[0], shapes.get(ins[0]));
    continue;
  }
  if (n.op === "MaxPool") {
    const k = at.kernel_shape.ints[0], st = at.strides ? at.strides.ints[0] : k;
    const ceil = at.ceil_mode ? at.ceil_mode.i : 0;
    const pads = at.pads ? at.pads.ints : [0, 0, 0, 0];
    if (k !== 2 || st !== 2 || pads.some((p) => p)) throw new Error("unsupported pool");
    const s = shapes.get(ins[0]);
    const o = (h) => (ceil ? Math.ceil((h - 2) / 2) + 1 : Math.floor((h - 2) / 2) + 1);
    layers.push({ op: "pool", in: ins[0], out: n.output[0], ceil: !!ceil });
    shapes.set(n.output[0], [s[0], o(s[1]), o(s[2])]);
    continue;
  }
  if (n.op === "Concat") {
    const ss = ins.map((x) => shapes.get(x));
    layers.push({ op: "concat", in: ins, out: n.output[0] });
    shapes.set(n.output[0], [ss.reduce((a, b) => a + b[0], 0), ss[0][1], ss[0][2]]);
    continue;
  }
  if (n.op === "Resize" || n.op === "Upsample") {
    const s = shapes.get(ins[0]);
    // inputs: X, roi, scales, sizes (opset 11+) ; or X, scales (Upsample / opset 10)
    let oh, ow;
    const sizes = ins[3] && consts.get(ins[3]);
    const scales = (ins[2] && consts.get(ins[2])) || (n.op === "Upsample" && consts.get(ins[1]));
    if (sizes && sizes.values.length === 4) {
      oh = sizes.values[2];
      ow = sizes.values[3];
    } else if (scales && scales.values.length === 4) {
      oh = Math.floor(s[1] * scales.values[2]);
      ow = Math.floor(s[2] * scales.values[3]);
    } else throw new Error("resize without static size " + n.name);
    const mode = at.mode ? at.mode.s : "nearest";
    const ctm = at.coordinate_transformation_mode ? at.coordinate_transformation_mode.s : "half_pixel";
    if (mode !== "linear") throw new Error("resize mode " + mode);
    if (ctm !== "half_pixel" && ctm !== "pytorch_half_pixel" && ctm !== "align_corners") throw new Error("resize ctm " + ctm);
    layers.push({ op: "up", in: ins[0], out: n.output[0], h: oh, w: ow, align: ctm === "align_corners" });
    shapes.set(n.output[0], [s[0], oh, ow]);
    continue;
  }
  if (n.op === "Sigmoid") {
    const layer = pendingBN.get(ins[0]);
    layers.push({ op: "sigmoid", in: ins[0], out: n.output[0] });
    void layer;
    shapes.set(n.output[0], shapes.get(ins[0]));
    continue;
  }
  throw new Error(`unsupported op ${n.op} (${n.name}) inputs ${ins.join(",")}`);
}

// ---------- prune to the fused output ----------
const OUT = A(g.outputs[0]);
const need = new Set([OUT]);
const kept = [];
for (let i = layers.length - 1; i >= 0; i--) {
  const L = layers[i];
  if (!need.has(L.out)) continue;
  kept.unshift(L);
  for (const x of Array.isArray(L.in) ? L.in : [L.in]) need.add(x);
}
// fuse sigmoid into the last conv when it directly follows
const fused = [];
for (const L of kept) {
  const prev = fused[fused.length - 1];
  if (L.op === "sigmoid" && prev && prev.op === "conv" && prev.out === L.in && !prev.relu && kept.filter((x) => (Array.isArray(x.in) ? x.in : [x.in]).includes(L.in)).length === 1) {
    prev.sigmoid = true;
    prev.out = L.out;
    continue;
  }
  fused.push(L);
}

// rename tensors to short ids
const ids = new Map([[IN, "x"]]);
const id = (n) => {
  if (!ids.has(n)) ids.set(n, "t" + ids.size);
  return ids.get(n);
};

// ---------- pack weights ----------
const chunks = [];
let off = 0;
function push(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  const o = off;
  chunks.push(bytes);
  off += bytes.length;
  const pad = (4 - (off % 4)) % 4;
  if (pad) {
    chunks.push(new Uint8Array(pad));
    off += pad;
  }
  return [o, arr.length];
}
// IEEE half from float (round to nearest even)
const f32b = new Float32Array(1), u32b = new Uint32Array(f32b.buffer);
function toHalf(v) {
  f32b[0] = v;
  const x = u32b[0];
  const sign = (x >>> 16) & 0x8000;
  let e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    m = (m | 0x800000) >>> (1 - e);
    if (m & 0x1000) m += 0x2000;
    return sign | (m >>> 13);
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

let params = 0;
const jl = fused.map((L) => {
  const io = { in: Array.isArray(L.in) ? L.in.map(id) : id(L.in), out: id(L.out) };
  if (L.op !== "conv") {
    const r = { op: L.op, ...io };
    if (L.op === "up") Object.assign(r, { h: L.h, w: L.w, align: L.align });
    if (L.op === "pool") r.ceil = L.ceil;
    return r;
  }
  params += L.W.length + L.B.length;
  const r = { op: "conv", ...io, cin: L.cin, cout: L.cout, k: L.k, pad: L.pad, dil: L.dil, relu: L.relu, sigmoid: !!L.sigmoid };
  if (INT8) {
    const per = L.cin * L.k * L.k;
    const q = new Int8Array(L.W.length), sc = new Float32Array(L.cout);
    for (let o = 0; o < L.cout; o++) {
      let mx = 0;
      for (let i = 0; i < per; i++) mx = Math.max(mx, Math.abs(L.W[o * per + i]));
      const s = mx / 127 || 1;
      sc[o] = s;
      for (let i = 0; i < per; i++) q[o * per + i] = Math.max(-127, Math.min(127, Math.round(L.W[o * per + i] / s)));
    }
    r.w = push(q);
    r.s = push(sc);
    r.b = push(Float32Array.from(L.B));
  } else if (F32) {
    r.w = push(Float32Array.from(L.W));
    r.b = push(Float32Array.from(L.B));
  } else {
    // fp16 with one f32 scale per output channel: BN folding leaves some channels with tiny weights (1e-6 … 1e-11)
    // that plain fp16 would flush to subnormals / zero; normalising each channel to max |w| = 1 keeps 11-bit
    // precision for every channel. Biases stay f32 (≈1% of the params, up to ~1e3 after folding).
    const per = L.cin * L.k * L.k;
    const h = new Uint16Array(L.W.length), sc = new Float32Array(L.cout);
    for (let o = 0; o < L.cout; o++) {
      let mx = 0;
      for (let i = 0; i < per; i++) mx = Math.max(mx, Math.abs(L.W[o * per + i]));
      const s = mx || 1;
      sc[o] = s;
      for (let i = 0; i < per; i++) h[o * per + i] = toHalf(L.W[o * per + i] / s);
    }
    r.w = push(h);
    r.s = push(sc);
    r.b = push(Float32Array.from(L.B));
  }
  return r;
});

const tensors = {};
for (const [n, i] of ids) tensors[i] = shapes.get(n);
const meta = {
  model: "u2netp",
  source: "xuebinqin/U-2-Net (Apache-2.0), u2netp.onnx as published by rembg",
  input: [3, 320, 320],
  mean: [0.485, 0.456, 0.406],
  std: [0.229, 0.224, 0.225],
  dtype: INT8 ? "i8" : F32 ? "f32" : "f16",
  params,
  output: id(OUT),
  tensors,
  layers: jl,
};
const json = new TextEncoder().encode(JSON.stringify(meta));
const headLen = 8 + json.length;
const pad = (4 - (headLen % 4)) % 4;
const file = new Uint8Array(headLen + pad + off);
file.set([0x4c, 0x57, 0x54, 0x31], 0); // "LWT1"
new DataView(file.buffer).setUint32(4, json.length + pad, true);
file.set(json, 8);
for (let i = 0; i < pad; i++) file[8 + json.length + i] = 0x20; // spaces keep the JSON valid
let p = headLen + pad;
for (const c of chunks) {
  file.set(c, p);
  p += c.length;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, file);
const counts = {};
for (const L of jl) counts[L.op] = (counts[L.op] ?? 0) + 1;
console.log(`wrote ${out}: ${file.length} bytes, ${jl.length} layers ${JSON.stringify(counts)}, ${params} params, dtype ${meta.dtype}`);
