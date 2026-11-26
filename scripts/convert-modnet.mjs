// One-off converter: MODNet portrait matting (ZHKKKe/MODNet, Apache-2.0 — code and models; the official ONNX file
// "modnet_photographic_portrait_matting.onnx" linked from the repository's onnx/README) → Omniweave "Loom Infer"
// graph weights (LWT1, meta.format = "graph"), run by src/core/image/infer/graph.ts.
//
//   node scripts/convert-modnet.mjs <model.onnx> --out <file.lwt> [--int8 | --f32] [--mant <bits>] [--name <name>]
//
// The ONNX file is read as data only (a small protobuf reader below: graph nodes, initializers, Constant nodes); no
// third-party code runs. The graph is mapped op by op:
//   Conv (+ the Relu / Clip(0, 6) right after it)  → conv with act relu / relu6
//   BatchNormalization                             → bn (weights)
//   InstanceNormalization                          → inorm (graph.ts)
//   Slice / Concat (IBNorm's channel halves)       → slice / list + concat
//   Resize linear, pytorch_half_pixel, by scales   → bilinear_interp (graph.ts)
//   GlobalAveragePool                              → pool2d global
//   the SE block's MatMul (weight [C, K])          → 1×1 conv on the pooled [1, C, 1, 1] (weight transposed)
//   Shape / Gather / Unsqueeze / Concat of sizes, Reshape and Expand to them → dropped (the tensor stays [1, C, 1, 1]
//                                                    and the multiply broadcasts it)
// Input: RGB normalised (x − 0.5) / 0.5, sides multiples of 32. Output: the matte 0..1, same size.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { quantRows, toHalf } from "./lwtQuant.mjs";

// ---------- protobuf (data only) ----------
function* fields(b, s, e) {
  let p = s;
  const vi = () => {
    let v = 0, m = 1, by;
    do {
      if (p >= e) throw new Error("truncated varint");
      by = b[p++];
      v += (by & 0x7f) * m;
      m *= 128;
    } while (by & 0x80);
    return v;
  };
  while (p < e) {
    const key = vi(), f = Math.floor(key / 8), w = key & 7;
    if (w === 0) { const st = p; const v = vi(); yield { f, w, v, s: st, e: p }; }
    else if (w === 2) { const l = vi(); if (p + l > e) throw new Error("truncated field"); yield { f, w, s: p, e: p + l }; p += l; }
    else if (w === 5) { yield { f, w, s: p, e: p + 4 }; p += 4; }
    else if (w === 1) { yield { f, w, s: p, e: p + 8 }; p += 8; }
    else throw new Error("wire type " + w);
  }
}
function sv(b, s, e) {
  let v = 0n, sh = 0n;
  for (let p = s; p < e; p++) { v |= BigInt(b[p] & 0x7f) << sh; sh += 7n; if (!(b[p] & 0x80)) break; }
  return Number(BigInt.asIntN(64, v));
}
function packed(b, s, e) {
  const out = [];
  let p = s;
  while (p < e) { const st = p; while (b[p] & 0x80) p++; p++; out.push(sv(b, st, p)); }
  return out;
}
const clampI = (v) => Math.max(-1e9, Math.min(1e9, v));
function tensor(b, s, e) {
  const dims = [];
  let dt = 1, raw = null, name = "";
  const fl = [], i64 = [];
  for (const x of fields(b, s, e)) {
    if (x.f === 1) x.w === 0 ? dims.push(sv(b, x.s, x.e)) : dims.push(...packed(b, x.s, x.e));
    else if (x.f === 2) dt = x.v;
    else if (x.f === 8) name = b.toString("utf8", x.s, x.e);
    else if (x.f === 9) raw = b.subarray(x.s, x.e);
    else if (x.f === 4) for (let p = x.s; p < x.e; p += 4) fl.push(b.readFloatLE(p));
    else if (x.f === 7) x.w === 0 ? i64.push(sv(b, x.s, x.e)) : i64.push(...packed(b, x.s, x.e));
  }
  const n = dims.reduce((a, v) => a * v, 1);
  const data = new Float32Array(n);
  if (dt === 1) {
    if (raw) for (let i = 0; i < n; i++) data[i] = raw.readFloatLE(i * 4);
    else data.set(fl);
  } else if (dt === 7) {
    if (raw) for (let i = 0; i < n; i++) data[i] = clampI(Number(raw.readBigInt64LE(i * 8)));
    else data.set(i64.map(clampI));
  } else if (dt === 6 || dt === 9) {
    // int32 / bool (shape bookkeeping of bigger graphs — BiRefNet; the converters only read them)
    if (raw) for (let i = 0; i < n; i++) data[i] = dt === 6 ? raw.readInt32LE(i * 4) : raw[i];
    else data.set(i64.map(clampI));
  } else throw new Error(`tensor ${name}: data type ${dt}`);
  return { name, shape: dims, data };
}
function attr(b, s, e) {
  let name = "", v;
  const ints = [], floats = [];
  let type = 0;
  for (const x of fields(b, s, e)) {
    if (x.f === 1) name = b.toString("utf8", x.s, x.e);
    else if (x.f === 2) v = b.readFloatLE(x.s);
    else if (x.f === 3) v = sv(b, x.s, x.e);
    else if (x.f === 4) v = b.toString("utf8", x.s, x.e);
    else if (x.f === 5) v = tensor(b, x.s, x.e);
    else if (x.f === 7) for (let p = x.s; p < x.e; p += 4) floats.push(b.readFloatLE(p));
    else if (x.f === 8) x.w === 0 ? ints.push(sv(b, x.s, x.e)) : ints.push(...packed(b, x.s, x.e));
    else if (x.f === 20) type = x.v;
  }
  if (type === 7) v = ints;
  if (type === 6) v = floats;
  return [name, v];
}
export function readOnnx(buf) {
  let g;
  for (const x of fields(buf, 0, buf.length)) if (x.f === 7) g = x;
  if (!g) throw new Error("no graph");
  const nodes = [], inits = new Map(), inputs = [], outputs = [];
  for (const x of fields(buf, g.s, g.e)) {
    if (x.f === 1) {
      const n = { in: [], out: [], op: "", a: {} };
      for (const y of fields(buf, x.s, x.e)) {
        if (y.f === 1) n.in.push(buf.toString("utf8", y.s, y.e));
        else if (y.f === 2) n.out.push(buf.toString("utf8", y.s, y.e));
        else if (y.f === 4) n.op = buf.toString("utf8", y.s, y.e);
        else if (y.f === 3) n.name = buf.toString("utf8", y.s, y.e);
        else if (y.f === 5) { const [k, v] = attr(buf, y.s, y.e); n.a[k] = v; }
      }
      nodes.push(n);
    } else if (x.f === 5) { const t = tensor(buf, x.s, x.e); inits.set(t.name, t); }
    else if (x.f === 11 || x.f === 12) for (const y of fields(buf, x.s, x.e)) if (y.f === 1) (x.f === 11 ? inputs : outputs).push(buf.toString("utf8", y.s, y.e));
  }
  return { nodes, inits, inputs: inputs.filter((n) => !inits.has(n)), outputs };
}

// ---------- graph ----------
export function modnetGraph(onnx) {
  const consts = new Map(onnx.inits);
  const vals = new Map();
  const shapeLike = new Set();
  const nodes = [], weights = new Map();
  let v = 0;
  const input = v++;
  vals.set(onnx.inputs[0], input);
  const uses = new Map();
  for (const n of onnx.nodes) for (const x of n.in) uses.set(x, (uses.get(x) ?? 0) + 1);
  const val = (name) => {
    if (!vals.has(name)) throw new Error("value " + name + " not available");
    return vals.get(name);
  };
  const weight = (name, t) => {
    if (!weights.has(name)) weights.set(name, t);
    return name;
  };
  const constNode = (arr, int = true) => {
    const o = v++;
    nodes.push({ op: "const", in: [], out: [o], a: { v: arr, int } });
    return o;
  };
  /** conv node by ONNX value → { node } so a following Relu / Clip can be folded in */
  const convOf = new Map();
  let k = 0;
  for (const n of onnx.nodes) {
    k++;
    const a = n.a;
    if (n.op === "Constant") { consts.set(n.out[0], a.value); continue; }
    if (n.op === "Shape" || n.op === "Gather" || n.op === "Unsqueeze" || (n.op === "Concat" && n.in.some((x) => shapeLike.has(x)))) { shapeLike.add(n.out[0]); continue; }
    if ((n.op === "Reshape" || n.op === "Expand") && shapeLike.has(n.in[1])) { vals.set(n.out[0], val(n.in[0])); continue; }
    const o = v++;
    switch (n.op) {
      case "Conv": {
        const w = consts.get(n.in[1]), b = n.in[2] ? consts.get(n.in[2]) : null;
        const [pt, pl, pb, pr] = a.pads ?? [0, 0, 0, 0];
        const node = { op: "conv", in: [val(n.in[0])], out: [o], w: weight(n.in[1], w), a: { stride: a.strides ?? [1, 1], pad: [pt, pb, pl, pr], dil: a.dilations ?? [1, 1], groups: a.group ?? 1 } };
        if (b) node.b = weight(n.in[2], b);
        nodes.push(node);
        if (uses.get(n.out[0]) === 1) convOf.set(n.out[0], node);
        break;
      }
      case "Relu":
      case "Clip": {
        let kind = "relu";
        if (n.op === "Clip") {
          const lo = consts.get(n.in[1])?.data[0] ?? a.min, hi = consts.get(n.in[2])?.data[0] ?? a.max;
          if (lo !== 0 || hi !== 6) throw new Error(`Clip(${lo}, ${hi})`);
          kind = "relu6";
        }
        const c = convOf.get(n.in[0]);
        if (c && !c.act) {
          c.act = kind;
          v--;
          vals.set(n.out[0], c.out[0]);
          continue;
        }
        nodes.push({ op: kind, in: [val(n.in[0])], out: [o] });
        break;
      }
      case "Sigmoid": {
        const c = convOf.get(n.in[0]);
        if (c && !c.act) {
          c.act = "sigmoid";
          v--;
          vals.set(n.out[0], c.out[0]);
          continue;
        }
        nodes.push({ op: "sigmoid", in: [val(n.in[0])], out: [o] });
        break;
      }
      case "BatchNormalization": {
        const [, sc, bi, mean, vr] = n.in;
        for (const x of [sc, bi, mean, vr]) weight(x, consts.get(x));
        nodes.push({ op: "bn", in: [val(n.in[0]), "$" + mean, "$" + vr, "$" + sc, "$" + bi], out: [o], a: { eps: a.epsilon ?? 1e-5 } });
        break;
      }
      case "InstanceNormalization": {
        const sc = `in${k}.scale`, bi = `in${k}.bias`;
        weight(sc, consts.get(n.in[1]));
        weight(bi, consts.get(n.in[2]));
        nodes.push({ op: "inorm", in: [val(n.in[0]), "$" + sc, "$" + bi], out: [o], a: { eps: a.epsilon ?? 1e-5 } });
        break;
      }
      case "Slice": {
        const st = Array.from(consts.get(n.in[1]).data), en = Array.from(consts.get(n.in[2]).data), ax = Array.from(consts.get(n.in[3]).data);
        if (n.in[4] && consts.get(n.in[4]).data.some((s) => s !== 1)) throw new Error("Slice step");
        nodes.push({ op: "slice", in: [val(n.in[0]), constNode(st), constNode(en)], out: [o], a: { axes: ax, decrease: [] } });
        break;
      }
      case "Concat": {
        const l = v++;
        nodes.push({ op: "list", in: n.in.map(val), out: [l] });
        nodes.push({ op: "concat", in: [l, constNode([a.axis])], out: [o] });
        break;
      }
      case "Resize": {
        const sc = consts.get(n.in[2]);
        if (a.mode !== "linear" || a.coordinate_transformation_mode !== "pytorch_half_pixel" || !sc || sc.data.length !== 4) throw new Error("Resize variant");
        nodes.push({ op: "bilinear_interp", in: [val(n.in[0])], out: [o], a: { scale: [sc.data[2], sc.data[3]] } });
        break;
      }
      case "GlobalAveragePool":
        nodes.push({ op: "pool2d", in: [val(n.in[0]), constNode([1, 1])], out: [o], a: { global: true, type: "avg" } });
        break;
      case "MatMul": {
        const w = consts.get(n.in[1]);
        if (!w || w.shape.length !== 2) throw new Error("MatMul without a weight");
        const [C, K] = w.shape, t = new Float32Array(C * K);
        for (let i = 0; i < C; i++) for (let j = 0; j < K; j++) t[j * C + i] = w.data[i * K + j];
        nodes.push({ op: "conv", in: [val(n.in[0])], out: [o], w: weight(n.in[1], { shape: [K, C, 1, 1], data: t }), a: { stride: [1, 1], pad: [0, 0, 0, 0], dil: [1, 1], groups: 1 } });
        if (uses.get(n.out[0]) === 1) convOf.set(n.out[0], nodes[nodes.length - 1]);
        break;
      }
      case "Add":
      case "Mul":
        nodes.push({ op: n.op === "Add" ? "add" : "multiply", in: [val(n.in[0]), val(n.in[1])], out: [o] });
        break;
      default:
        throw new Error("op " + n.op);
    }
    vals.set(n.out[0], o);
  }
  return { nodes, weights, input, output: val(onnx.outputs[0]) };
}

// ---------- write ----------
function f2h(v) {
  return toHalf(v, 10);
}
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
    const data = Float32Array.from(t.data);
    if (o.f32 || t.shape.length === 1) wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(data.buffer)), n], f32: true };
    else if (o.int8) {
      const { q, sc } = quantRows(data, t.shape[0]);
      wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(q.buffer)), n], s: [push(new Uint8Array(sc.buffer)), t.shape[0]] };
    } else {
      const h = new Uint16Array(n);
      for (let i = 0; i < n; i++) h[i] = o.mant && o.mant < 10 ? toHalf(data[i], o.mant) : f2h(data[i]);
      wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(h.buffer)), n] };
    }
  }
  const meta = { model: o.name, format: "graph", dtype: o.f32 ? "f32" : o.int8 ? "i8" : "f16", params, input: g.input, output: g.output, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], nodes: g.nodes, weights: wmeta };
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

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const src = args[0], out = opt("--out");
  if (!src || !out) {
    console.error("usage: node scripts/convert-modnet.mjs <model.onnx> --out <file.lwt> [--int8|--f32] [--mant n] [--name n]");
    process.exit(2);
  }
  const g = modnetGraph(readOnnx(readFileSync(src)));
  const bytes = writeLwt(g, { name: opt("--name") ?? "modnet", f32: args.includes("--f32"), int8: args.includes("--int8"), mant: Number(opt("--mant") ?? 10) });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  console.log(`${out}: ${bytes.length} bytes, ${g.nodes.length} nodes, ${g.weights.size} weights`);
}
