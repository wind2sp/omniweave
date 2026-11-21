// One-off converter: PaddleOCR PP-OCRv5 inference models (PIR "inference.json" + "inference.pdiparams", Apache-2.0,
// official PaddlePaddle releases) → Omniweave "Loom Infer" graph weights (LWT1 container, meta.format = "graph").
//
//   node scripts/convert-ppocr.mjs <model dir> --out <file.lwt> [--int8 | --f32] [--name <model name>]
//   (--f32: lossless dev copy, the source for scripts/requant-lwt.mjs — the palettised int8 files the app ships)
//
// Reads only data files (JSON graph, raw tensors, YAML character list) — no third-party code runs. Steps:
//   1. parse the PIR program (op list) and the combined parameter file (tensors stored in name order),
//   2. fold what inference never needs at run time: conv bias reshape+add, BatchNorm after conv, the PP-LCNetV3
//      "learnable affine" scalar pairs (into the conv before them or into the activation as a post-affine),
//      dropout / assign (identities at inference),
//   3. write a small op list (graph.ts executes it) + weights as fp16 (or int8 per output channel, --int8).
//
// File layout (little endian): "LWT1" | u32 jsonLength | json | pad to 4 | blob.
// json = { model, format:"graph", dtype, params, input, mean, std, output, nodes:[...], weights:{name:{shape, w, s?, f32?}}, dict? }

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { quantRows } from "./lwtQuant.mjs";

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--"));
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
if (!dir || !opt("--out")) {
  console.error("usage: node scripts/convert-ppocr.mjs <model dir> --out <file.lwt> [--int8] [--name name]");
  process.exit(2);
}
const INT8 = args.includes("--int8");
const F32 = args.includes("--f32");
const out = opt("--out");

// ---------- parameters (Paddle save_combine: per tensor u32 ver | u64 lod | u32 ver | i32 descLen | TensorDesc | raw) ----------
function readParams(buf) {
  const list = [];
  let p = 0;
  while (p < buf.length) {
    p += 4 + 8 + 4;
    const dl = buf.readInt32LE(p);
    p += 4;
    const desc = buf.subarray(p, p + dl);
    p += dl;
    let q = 0, dt = -1;
    const dims = [];
    const vi = () => {
      let v = 0, s = 0, by;
      do {
        by = desc[q++];
        v += (by & 0x7f) * 2 ** s;
        s += 7;
      } while (by & 0x80);
      return v;
    };
    while (q < desc.length) {
      const key = desc[q++];
      if (key === 8) dt = vi();
      else if (key === 16) dims.push(vi());
      else if (key === 18) {
        const end = vi() + q;
        while (q < end) dims.push(vi());
      } else throw new Error("TensorDesc field " + key);
    }
    if (dt !== 5) throw new Error("only fp32 parameters are expected, got dtype " + dt);
    const n = dims.reduce((a, c) => a * c, 1);
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = buf.readFloatLE(p + i * 4);
    p += n * 4;
    list.push({ dims, data });
  }
  return list;
}

const prog = JSON.parse(readFileSync(join(dir, "inference.json"), "utf8"));
const ops = prog.program.regions[0].blocks[0].ops;
const pdecl = ops.filter((o) => o["#"] === "p").map((o) => ({ id: o.O["%"], name: o.A[3], shape: o.O.TT.D[1] }));
const tensors = readParams(readFileSync(join(dir, "inference.pdiparams")));
const sortedDecl = [...pdecl].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
if (sortedDecl.length !== tensors.length) throw new Error("parameter count mismatch");
const W = new Map(); // name -> {shape, data}
const idToW = new Map();
sortedDecl.forEach((d, i) => {
  if (JSON.stringify(d.shape) !== JSON.stringify(tensors[i].dims)) throw new Error("shape mismatch at " + d.name);
  W.set(d.name, { shape: d.shape, data: tensors[i].data });
  idToW.set(d.id, d.name);
});

// ---------- op list → simple nodes ----------
const attr = (o, n) => {
  const a = (o.A || []).find((x) => x.N === n);
  if (!a) return undefined;
  const d = a.AT.D;
  return Array.isArray(d) ? d.map((x) => (x && typeof x === "object" && "D" in x ? x.D : x)) : d;
};
const ref = (i) => (idToW.has(i["%"]) ? "$" + idToW.get(i["%"]) : i["%"]);
let nodes = [];
let inputId = -1, outputId = -1;
for (const o of ops) {
  const k = o["#"].replace(/^\d\./, "");
  if (k === "p") continue;
  const ins = (o.I || []).map(ref);
  const outs = (o.O || []).map((x) => x["%"]);
  const n = { op: k, in: ins, out: outs, a: {} };
  switch (k) {
    case "data":
      inputId = outs[0];
      continue;
    case "fetch":
      outputId = ins[0];
      continue;
    case "conv2d":
    case "depthwise_conv2d":
      n.op = "conv";
      n.w = ins[1].slice(1);
      n.in = [ins[0]];
      n.a = { stride: attr(o, "strides"), pad: attr(o, "paddings"), dil: attr(o, "dilations"), groups: attr(o, "groups") };
      break;
    case "conv2d_transpose":
      n.op = "convT";
      n.w = ins[1].slice(1);
      n.in = [ins[0]];
      n.a = { stride: attr(o, "strides"), pad: attr(o, "paddings"), groups: attr(o, "groups") };
      break;
    case "batch_norm_":
      n.op = "bn";
      n.a = { eps: attr(o, "epsilon") };
      n.out = [outs[0]];
      break;
    case "full_int_array":
      n.op = "const";
      n.a = { v: attr(o, "value"), int: true };
      break;
    case "full":
      n.op = "const";
      n.a = { v: attr(o, "value"), shape: attr(o, "shape"), int: attr(o, "dtype") !== "float32" };
      break;
    case "dropout":
    case "assign":
      n.op = "id";
      n.in = [ins[0]];
      n.out = [outs[0]];
      break;
    case "layer_norm":
      n.a = { eps: attr(o, "epsilon"), axis: attr(o, "begin_norm_axis") };
      n.out = [outs[0]];
      break;
    case "pool2d":
      n.a = { type: attr(o, "pooling_type"), adaptive: attr(o, "adaptive"), stride: attr(o, "strides"), pad: attr(o, "paddings"), global: attr(o, "global_pooling") };
      break;
    case "nearest_interp":
      n.in = [ins[0]];
      n.a = { scale: attr(o, "scale"), h: attr(o, "out_h"), w: attr(o, "out_w") };
      break;
    case "hardsigmoid":
      n.a = { slope: attr(o, "slope"), offset: attr(o, "offset") };
      break;
    case "matmul":
      n.a = { tx: attr(o, "transpose_x"), ty: attr(o, "transpose_y") };
      break;
    case "scale":
      n.a = { bias: attr(o, "bias"), after: attr(o, "bias_after_scale") };
      break;
    case "softmax":
      n.a = { axis: attr(o, "axis") };
      break;
    case "transpose":
      n.a = { perm: attr(o, "perm") };
      break;
    case "slice":
      n.a = { axes: attr(o, "axes"), decrease: attr(o, "decrease_axis") };
      break;
    case "flatten":
      n.a = { start: attr(o, "start_axis"), stop: attr(o, "stop_axis") };
      break;
    case "stack":
      n.a = { axis: attr(o, "axis") };
      break;
    case "combine":
      n.op = "list";
      break;
    case "add": case "multiply": case "subtract": case "relu": case "hardswish": case "sigmoid": case "swish":
    case "reshape": case "shape64": case "concat": case "squeeze":
      break;
    default:
      throw new Error("unsupported op " + k);
  }
  nodes.push(n);
}

// ---------- folding ----------
const alias = new Map();
const res = (x) => (typeof x === "number" && alias.has(x) ? res(alias.get(x)) : x);
nodes = nodes.filter((n) => {
  if (n.op !== "id") return true;
  alias.set(n.out[0], n.in[0]);
  return false;
});
for (const n of nodes) n.in = n.in.map(res);
outputId = res(outputId);

const consumers = () => {
  const c = new Map();
  for (const n of nodes) for (const x of n.in) if (typeof x === "number") c.set(x, (c.get(x) || 0) + 1);
  c.set(outputId, (c.get(outputId) || 0) + 1);
  return c;
};
const producer = () => {
  const m = new Map();
  for (const n of nodes) for (const o of n.out) m.set(o, n);
  return m;
};
const scalarW = (x) => typeof x === "string" && W.get(x.slice(1)).data.length === 1 ? W.get(x.slice(1)).data[0] : null;
let folded = 0;
const conv = (n) => {
  if (n.cw) return;
  const w = W.get(n.w);
  n.cw = { shape: w.shape, data: Float32Array.from(w.data), bias: new Float32Array(w.shape[n.op === "convT" ? 1 : 0] * (n.op === "convT" ? n.a.groups : 1)) };
};
for (let changed = true; changed; ) {
  changed = false;
  const cons = consumers(), prod = producer();
  for (const n of nodes) {
    // conv → add(reshape(bias)) / bn / affine(mul scalar, add scalar)
    if (n.op !== "add" && n.op !== "bn" && n.op !== "multiply") continue;
    const xi = n.in.findIndex((x) => typeof x === "number" && (prod.get(x)?.op === "conv" || prod.get(x)?.op === "convT"));
    if (xi < 0) continue;
    const c = prod.get(n.in[xi]);
    if (cons.get(n.in[xi]) !== 1 || c.act) continue;
    const other = n.in[1 - xi];
    conv(c);
    const cout = c.cw.bias.length, per = c.cw.data.length / cout;
    const isT = c.op === "convT";
    const scaleCh = (o, s) => {
      if (!isT) for (let i = o * per; i < (o + 1) * per; i++) c.cw.data[i] *= s;
      else {
        // convT weight [cin][cout/g][kh][kw]
        const [ci, co, kh, kw] = c.cw.shape;
        for (let a = 0; a < ci; a++) for (let q = 0; q < kh * kw; q++) c.cw.data[(a * co + o) * kh * kw + q] *= s;
      }
    };
    if (n.op === "bn") {
      const [mean, vr, sc, bi] = n.in.slice(1).map((x) => W.get(x.slice(1)).data);
      for (let o = 0; o < cout; o++) {
        const k = sc[o] / Math.sqrt(vr[o] + n.a.eps);
        scaleCh(o, k);
        c.cw.bias[o] = (c.cw.bias[o] - mean[o]) * k + bi[o];
      }
    } else if (n.op === "add") {
      let bv = null;
      const s = scalarW(other);
      if (s !== null) bv = new Float32Array(cout).fill(s);
      else if (typeof other === "number" && prod.get(other)?.op === "reshape" && typeof prod.get(other).in[0] === "string") bv = W.get(prod.get(other).in[0].slice(1)).data;
      else if (typeof other === "string" && W.get(other.slice(1)).data.length === cout) bv = W.get(other.slice(1)).data;
      if (!bv || bv.length !== cout) continue;
      for (let o = 0; o < cout; o++) c.cw.bias[o] += bv[o];
    } else {
      const s = scalarW(other);
      if (s === null) continue;
      for (let o = 0; o < cout; o++) {
        scaleCh(o, s);
        c.cw.bias[o] *= s;
      }
    }
    c.out = [n.out[0]];
    n.dead = true;
    changed = true;
    folded++;
    break;
  }
  if (changed) nodes = nodes.filter((n) => !n.dead);
  if (changed) continue;
  // activation directly after a conv → fused; then post-affine (mul scalar, add scalar) fused into the conv too
  for (const n of nodes) {
    if (!["relu", "hardswish", "swish", "sigmoid", "hardsigmoid", "multiply", "add"].includes(n.op)) continue;
    const xi = n.in.findIndex((x) => typeof x === "number" && prod.get(x)?.op === "conv");
    if (xi < 0) continue;
    const c = prod.get(n.in[xi]);
    if (cons.get(n.in[xi]) !== 1) continue;
    if (n.op === "multiply" || n.op === "add") {
      if (!c.act) continue;
      const s = scalarW(n.in[1 - xi]);
      if (s === null) continue;
      c.post ??= [1, 0];
      if (n.op === "multiply") c.post = [c.post[0] * s, c.post[1] * s];
      else c.post = [c.post[0], c.post[1] + s];
    } else {
      if (c.act) continue;
      c.act = n.op;
      if (n.op === "hardsigmoid") c.actA = [n.a.slope, n.a.offset];
    }
    c.out = [n.out[0]];
    n.dead = true;
    changed = true;
    folded++;
    break;
  }
  if (changed) nodes = nodes.filter((n) => !n.dead);
}
// drop dead producers (reshape of a folded bias, consts nobody reads)
for (let changed = true; changed; ) {
  changed = false;
  const cons = consumers();
  const before = nodes.length;
  nodes = nodes.filter((n) => n.out.some((o) => cons.get(o)));
  changed = nodes.length !== before;
}

// ---------- weights to write ----------
const outW = new Map(); // name -> {shape, data}
for (const n of nodes) {
  if (n.op === "conv" || n.op === "convT") {
    conv(n);
    outW.set(n.w, { shape: n.cw.shape, data: n.cw.data });
    outW.set(n.w + ":b", { shape: [n.cw.bias.length], data: n.cw.bias });
    n.b = n.w + ":b";
    delete n.cw;
  }
  for (const x of n.in) if (typeof x === "string") outW.set(x.slice(1), W.get(x.slice(1)));
}

const f2h = (() => {
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  return (v) => {
    f[0] = v;
    const x = u[0], s = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15, m = x & 0x7fffff;
    if (e <= 0) {
      if (e < -10) return s;
      m |= 0x800000;
      const sh = 14 - e;
      let h = m >> sh;
      if ((m >> (sh - 1)) & 1) h++;
      return s | h;
    }
    if (e >= 31) return s | 0x7c00;
    let h = s | (e << 10) | (m >> 13);
    if (m & 0x1000) h++;
    return h;
  };
})();

const chunks = [];
let off = 0;
const push = (u8) => {
  const pad = (4 - (off % 4)) % 4;
  if (pad) {
    chunks.push(new Uint8Array(pad));
    off += pad;
  }
  const o = off;
  chunks.push(u8);
  off += u8.length;
  return o;
};
const wmeta = {};
let params = 0;
for (const [name, t] of outW) {
  const n = t.data.length;
  params += n;
  if (F32 || n <= 4096 || name.endsWith(":b")) {
    wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(Float32Array.from(t.data).buffer)), n], f32: true };
    continue;
  }
  const rows = t.shape[0];
  if (INT8) {
    const { q, sc } = quantRows(t.data, rows);
    wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(q.buffer)), n], s: [push(new Uint8Array(sc.buffer)), rows] };
  } else {
    const h = new Uint16Array(n);
    for (let i = 0; i < n; i++) h[i] = f2h(t.data[i]);
    wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(h.buffer)), n] };
  }
}

// ---------- character list (recognition models) ----------
let dict;
try {
  const yml = readFileSync(join(dir, "inference.yml"), "utf8").split(/\r?\n/);
  const i0 = yml.findIndex((l) => /^\s*character_dict:\s*$/.test(l));
  if (i0 >= 0) {
    dict = [];
    for (let i = i0 + 1; i < yml.length; i++) {
      const m = /^\s*- (.*)$/.exec(yml[i]);
      if (!m) break;
      let v = m[1];
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
      else if (v.startsWith('"') && v.endsWith('"')) v = JSON.parse(v);
      dict.push(v);
    }
  }
} catch {}
const isDet = !dict;
const meta = {
  model: opt("--name") ?? JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).Global?.model_name ?? "ppocr",
  format: "graph",
  dtype: INT8 ? "i8" : "f16",
  params,
  input: inputId,
  output: outputId,
  mean: isDet ? [0.485, 0.456, 0.406] : [0.5, 0.5, 0.5],
  std: isDet ? [0.229, 0.224, 0.225] : [0.5, 0.5, 0.5],
  nodes: nodes.map((n) => {
    const o = { op: n.op, in: n.in, out: n.out };
    if (Object.keys(n.a || {}).length) o.a = n.a;
    if (n.w) o.w = n.w;
    if (n.b) o.b = n.b;
    if (n.act) o.act = n.act;
    if (n.actA) o.actA = n.actA;
    if (n.post) o.post = n.post;
    return o;
  }),
  weights: wmeta,
  ...(dict ? { dict } : {}),
};
let js = JSON.stringify(meta);
while ((8 + new TextEncoder().encode(js).length) % 4) js += " "; // blob starts 4-aligned right after the json
const json = new TextEncoder().encode(js);
const head = new Uint8Array(8);
head.set([0x4c, 0x57, 0x54, 0x31]);
new DataView(head.buffer).setUint32(4, json.length, true);
const jpad = 0;
const total = 8 + json.length + jpad + off;
const file = new Uint8Array(total);
file.set(head, 0);
file.set(json, 8);
let p = 8 + json.length + jpad;
for (const c of chunks) {
  file.set(c, p);
  p += c.length;
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, file);
const cnt = {};
for (const n of nodes) cnt[n.op] = (cnt[n.op] || 0) + 1;
console.log(`${meta.model}: ${nodes.length} nodes (${folded} folds), ${params} params, ${(total / 1e6).toFixed(2)} MB ${meta.dtype}${dict ? `, dict ${dict.length}` : ""}`);
console.log(cnt);
