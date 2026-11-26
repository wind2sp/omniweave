// Experimental converter: BiRefNet-lite (ZhengPeng7/BiRefNet, MIT — the official ONNX release
// "BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx", 1024 × 1024, Swin-T backbone) → Omniweave "Loom Infer" graph
// weights (LWT1, meta.format = "graph"), run by src/core/image/infer/graph.ts / graphGpu.ts. Used by the optional high-quality
// background removal (downloaded on first use, not shipped; measured in the image department's evaluation report).
//
//   node scripts/convert-birefnet.mjs <model.onnx> --shapes <shapes.json> --out <file.lwt> [--f32 | --f16 | --int8 | --int4]
//
// The ONNX file is read as data only (convert-modnet.mjs's protobuf reader); no third-party code runs. The export is
// traced at 1024 × 1024 (16,400 nodes, most of them shape bookkeeping); `--shapes` is the value → shape table of one
// reference run at that size (a trace script kept outside the repository), used only to turn the resizes' fixed
// sizes into fractions of the input. The converted graph has no fixed size: any input whose sides are multiples of 32.
//
// Mapping (the backbone is kept in NCHW, so Swin's token reshapes / transposes are no-ops):
//   patch embed Conv 4×4/4, Swin linear layers (MatMul by a weight) → conv (1×1 for the linears, weight transposed)
//   LayerNormalization                                                → ln_c (over the channels of NCHW)
//   window attention (pad, roll, partition, qkv split, q·kᵀ, bias, mask, softmax, ·v, reverse) → conv qkv + win_attn
//                                                                       + conv proj
//   GELU (Div, Erf, Add, Mul, Mul)                                    → act "gelu" on the fc1 conv
//   PatchMerging (strided slices + concat)                            → patch_merge
//   deformable conv (the exporter's GatherND bilinear sampling + Conv stride k) → deform_conv
//   image2patches (Split / Unsqueeze / Concat)                        → image2patches
//   Resize linear align_corners                                       → resize_ac (size = input / div)
//   BatchNormalization after a conv / deform_conv                     → folded into its weights
//   the output: conv_out1(cat(resize(d1), ipt1)) — its 1×1 weights folded into the two 3×3 convs before it, so the
//   96-channel 1024² map is never made: resize(conv_a(·)) + conv_b(·); then the sigmoid (the matte 0..1)
// Input: RGB, ImageNet mean / std. Output [1, 1, H, W], 0..1.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { readOnnx } from "./convert-modnet.mjs";
import { quantRows, toHalf } from "./lwtQuant.mjs";

const norm = (name) => {
  // strip the "_1" a second call of a module adds to each path component (not the node's own name)
  const p = name.split("/");
  return p.map((c, i) => (i < p.length - 1 ? c.replace(/_\d+$/, "") : c)).join("/");
};

export function birefnetGraph(onnx, shapes) {
  const C = new Map(onnx.inits);
  // the second backbone pass reads the same weights through Identity nodes: one name per tensor
  const canon = new Map();
  const K = (x) => canon.get(x) ?? x;
  for (const n of onnx.nodes) {
    if (n.op === "Constant") {
      const a = n.a;
      C.set(n.out[0], a.value ?? (a.value_float !== undefined ? { shape: [], data: Float32Array.of(a.value_float) } : { shape: [a.value_ints.length], data: Float32Array.from(a.value_ints) }));
    } else if (n.op === "Identity" && C.has(n.in[0])) {
      C.set(n.out[0], C.get(n.in[0]));
      canon.set(n.out[0], K(n.in[0]));
    }
  }
  const input = onnx.inputs[0];
  // input-dependent values
  const dd = new Set([input]);
  const ddNodes = [];
  for (const n of onnx.nodes) if (n.op !== "Shape" && n.in.some((x) => dd.has(x))) n.out.forEach((o) => dd.add(o)), ddNodes.push(n);
  const uses = new Map();
  for (const n of ddNodes) for (const x of n.in) if (dd.has(x)) uses.set(x, (uses.get(x) ?? 0) + 1);
  const S = (name) => {
    const s = shapes[name];
    if (!s) throw new Error("no shape for " + name);
    return s;
  };
  const INS = shapes[input] ?? [1, 3, 1024, 1024];

  const nodes = [], weights = new Map();
  let v = 0;
  const vin = v++;
  const vals = new Map([[input, vin]]);
  const prod = new Map(); // my value → node making it
  const val = (name) => {
    if (!vals.has(name)) throw new Error("value " + name + " not available");
    return vals.get(name);
  };
  const W = (name0, shape, data, keep = false) => {
    const name = K(name0);
    if (!weights.has(name)) weights.set(name, { shape, data: Float32Array.from(data), keep });
    return name;
  };
  const emit = (node) => {
    nodes.push(node);
    for (const o of node.out) prod.set(o, node);
    return node.out[0];
  };
  const constNode = (arr) => emit({ op: "const", in: [], out: [v++], a: { v: arr, int: true } });
  const sole = (name) => uses.get(name) === 1;
  const cval = (name) => {
    const t = C.get(name);
    if (!t) throw new Error("constant " + name + " missing");
    return t;
  };
  const conv = (x, w, shape, b, a, wname) => {
    const node = { op: "conv", in: [x], out: [v++], w: W(wname, shape, w), a };
    if (b) node.b = W(wname + ".b", [shape[0]], b);
    // the tiled implicit-GEMM WebGPU kernel (graphGpu.ts) for the wide dense convs
    if ((a.groups ?? 1) === 1 && shape[0] >= 32) a.gemm = 1;
    emit(node);
    return node;
  };
  /** MatMul by a [K, N] weight → 1×1 conv with weight [N, K, 1, 1] */
  const linear = (x, wname0) => {
    const wname = K(wname0), w = cval(wname), [Kd, N] = w.shape, t = new Float32Array(Kd * N);
    for (let k = 0; k < Kd; k++) for (let n = 0; n < N; n++) t[n * Kd + k] = w.data[k * N + n];
    return conv(x, t, [N, Kd, 1, 1], null, { stride: [1, 1], pad: [0, 0, 0, 0], dil: [1, 1], groups: 1 }, wname + ".T");
  };
  /** fold a per-channel k·x + s into a conv / deform_conv's weights */
  const foldAffine = (node, k, s) => {
    const w = weights.get(node.w), cout = w.shape[0], per = w.data.length / cout;
    const nw = Float32Array.from(w.data), nb = new Float32Array(cout);
    const b = node.b ? weights.get(node.b).data : new Float32Array(cout);
    for (let o = 0; o < cout; o++) {
      for (let i = 0; i < per; i++) nw[o * per + i] *= k[o];
      nb[o] = b[o] * k[o] + s[o];
    }
    const name = node.w + ".f" + nodes.length;
    node.w = W(name, w.shape, nw);
    node.b = W(name + ".b", [cout], nb);
  };

  // per Swin block (normalised scope): its attention parameters; the pending norm1 output of the instance being read
  const blocks = new Map();
  const blockOf = (nm) => nm.match(/^(\/bb\/layers\.\d+\/blocks\.\d+)\//)?.[1];
  for (const n of ddNodes) {
    const nm = norm(n.name), b = blockOf(nm);
    if (!b) continue;
    const p = blocks.get(b) ?? { shift: 0 };
    blocks.set(b, p);
    const leaf = nm.slice(b.length + 1);
    const cin = n.in.find((x) => C.has(x));
    if (leaf === "attn/qkv/MatMul") p.qkvW = cin;
    else if (leaf === "attn/qkv/Add") p.qkvB = cin;
    else if (leaf === "attn/Mul") p.scale = cval(cin).data[0];
    else if (leaf === "attn/Add") p.relb = cin;
    else if (leaf === "attn/proj/MatMul") p.projW = cin;
    else if (leaf === "attn/proj/Add") p.projB = cin;
    else if (/^Concat/.test(leaf)) p.shift = 1;
  }
  const pend = {};

  for (const n of ddNodes) {
    const nm = norm(n.name), a = n.a;
    const leaf = nm.split("/").pop();
    const b = blockOf(nm);
    const ddIn = n.in.filter((x) => dd.has(x));
    const cIn = n.in.filter((x) => x && !dd.has(x));
    const set = (id) => vals.set(n.out[0], id);

    // ---- Swin block ----
    if (b) {
      const bl = nm.slice(b.length + 1);
      if (bl === "norm1/LayerNormalization") {
        set(emit({ op: "ln_c", in: [val(n.in[0]), "$" + W(n.in[1], cval(n.in[1]).shape, cval(n.in[1]).data), "$" + W(n.in[2], cval(n.in[2]).shape, cval(n.in[2]).data)], out: [v++], a: { eps: a.epsilon ?? 1e-5 } }));
        pend.attnIn = vals.get(n.out[0]);
        continue;
      }
      if (bl === "Add" && ddIn.some((x) => !vals.has(x))) {
        // the window attention region ends here: qkv conv → win_attn → proj conv, then the residual add
        const p = blocks.get(b);
        const qkv = linear(pend.attnIn, p.qkvW);
        const qb = cval(p.qkvB), relb = cval(p.relb);
        qkv.b = W(K(p.qkvW) + ".T.b", [qb.data.length], qb.data);
        const heads = relb.shape[relb.shape.length - 3], ws = Math.round(Math.sqrt(relb.shape[relb.shape.length - 1]));
        const att = emit({ op: "win_attn", in: [qkv.out[0], "$" + qkv.b, "$" + W(p.relb, [heads, ws * ws, ws * ws], relb.data, true)], out: [v++], a: { heads, ws, shift: p.shift ? ws >> 1 : 0, scale: p.scale } });
        const proj = linear(att, p.projW);
        proj.b = W(K(p.projW) + ".T.b", [cval(p.projB).data.length], cval(p.projB).data);
        const sc = ddIn.find((x) => vals.has(x));
        set(emit({ op: "add", in: [val(sc), proj.out[0]], out: [v++] }));
        continue;
      }
      if (bl.startsWith("mlp/act/")) {
        // GELU: Div(x, √2) Erf Add(1) Mul(x) Mul(½) → act on the fc1 conv
        if (leaf === "Div") pend.gelu = val(n.in[0]);
        else if (leaf === "Mul_1") {
          const c = prod.get(pend.gelu);
          if (c.op !== "conv" || c.act) throw new Error("GELU input");
          c.act = "gelu";
          set(pend.gelu);
        }
        continue;
      }
      if (!/^(norm2\/|mlp\/|Add_1$)/.test(bl)) continue; // the attention region (read above)
    }
    // ---- PatchMerging ----
    if (/\/downsample\/(Reshape|Slice|Concat)/.test(nm) && !/\/downsample\/(norm|reduction)\//.test(nm)) {
      if (leaf === "Reshape") pend.merge = val(n.in[0]);
      if (leaf === "Reshape_1") set(emit({ op: "patch_merge", in: [pend.merge], out: [v++] }));
      continue;
    }
    // ---- token layout changes: no-ops in NCHW ----
    if ((n.op === "Reshape" || n.op === "Transpose") && /^\/bb\/(patch_embed\/)?(Reshape|Transpose)(_\d+)?$/.test(nm)) {
      set(val(n.in[0]));
      continue;
    }
    // ---- deformable conv ----
    const dm = nm.match(/^(.*\/atrous_conv)\/(.*)$/);
    if (dm && !/^(offset_conv|modulator_conv)\//.test(dm[2]) && leaf !== "Sigmoid" && dm[2] !== "Mul") {
      const r = dm[2];
      if (r === "Pad") pend.dx = val(n.in[0]);
      else if (r === "Reshape") pend.doff = val(n.in[0]);
      else if (r === "Reshape_18") pend.dmask = val(n.in[0]);
      else if (r === "Conv") pend.dw = n.in[1];
      else if (r === "Add_3") {
        const w = cval(pend.dw), [cout, , kh, kw] = w.shape;
        const node = { op: "deform_conv", in: [pend.dx, pend.doff, pend.dmask], out: [v++], w: W(pend.dw, w.shape, w.data), b: W(pend.dw + ".b", [cout], cval(cIn[0]).data), a: { pad: [(kh - 1) >> 1, (kw - 1) >> 1], stride: [1, 1], dil: [1, 1] } };
        set(emit(node));
      }
      continue;
    }
    // ---- image2patches (Split / Split / Unsqueeze / Concat / Concat) ----
    if (n.op === "Gather" && n.in[0] === input) {
      // x[0] (batch 1): the picture
      if (cval(n.in[1]).data[0] !== 0) throw new Error("Gather of the input");
      set(vin);
      continue;
    }
    if (/^\/decoder\/(Split|Unsqueeze)(_\d+)?$/.test(nm) || (/^\/decoder\/Concat/.test(nm) && n.in.some((x) => /Unsqueeze/.test(x)))) {
      if (n.op === "Split" && /\/decoder\/Gather/.test(n.in[0])) pend.patch = { x: val(n.in[0]), g: n.out.length };
      if (n.op === "Unsqueeze" || n.op === "Split") vals.set(n.out[0], -1);
      continue;
    }
    if (n.op === "Concat" && n.in.length === 1 && vals.get(n.in[0]) === undefined && pend.patch) {
      // the second concat of image2patches
      set(emit({ op: "image2patches", in: [pend.patch.x], out: [v++], a: { g: pend.patch.g } }));
      pend.patch = null;
      continue;
    }
    // ---- the output ----
    if (nm === "/decoder/Resize_7") {
      pend.tailA = val(n.in[0]);
      continue;
    }
    if (nm === "/decoder/Concat_29") {
      pend.tailB = val(n.in[1]);
      continue;
    }
    if (nm === "/decoder/conv_out1/conv_out1.0/Conv") {
      const w = cval(n.in[1]), bias = cval(n.in[2]).data[0];
      const A = prod.get(pend.tailA), B = prod.get(pend.tailB);
      const ca = weights.get(A.w).shape[0];
      // fold a 1×1 (1 output) into a conv: W'[ci, k] = Σ_o w[o] W[o, ci, k], b' = Σ_o w[o] b[o]
      const fold = (node, w1, extra) => {
        const t = weights.get(node.w), [cout, cin, kh, kw] = t.shape, per = cin * kh * kw;
        const nw = new Float32Array(per);
        let nb = extra;
        const bb = node.b ? weights.get(node.b).data : new Float32Array(cout);
        for (let o = 0; o < cout; o++) {
          for (let i = 0; i < per; i++) nw[i] += w1[o] * t.data[o * per + i];
          nb += w1[o] * bb[o];
        }
        if (node.act) throw new Error("fold over an activation");
        node.w = W(node.w + ".out", [1, cin, kh, kw], nw);
        node.b = W(node.w + ".b", [1], [nb]);
        delete node.a.gemm;
      };
      fold(A, w.data.subarray(0, ca), bias);
      fold(B, w.data.subarray(ca), 0);
      const sA = S("/decoder/decoder_block1/conv_out/Conv_output_0"), sO = S(n.out[0]);
      const up = emit({ op: "resize_ac", in: [A.out[0], vin], out: [v++], a: { div: [INS[2] / sO[2], INS[3] / sO[3]] } });
      void sA;
      const sum = emit({ op: "add", in: [up, B.out[0]], out: [v++] });
      set(emit({ op: "sigmoid", in: [sum], out: [v++] }));
      continue;
    }
    // ---- generic ----
    switch (n.op) {
      case "Conv": {
        const w = cval(n.in[1]);
        const [pt, pl, pb, pr] = a.pads ?? [0, 0, 0, 0];
        set(conv(val(n.in[0]), w.data, w.shape, n.in[2] ? cval(n.in[2]).data : null, { stride: a.strides ?? [1, 1], pad: [pt, pb, pl, pr], dil: a.dilations ?? [1, 1], groups: a.group ?? 1 }, n.in[1]).out[0]);
        break;
      }
      case "MatMul":
        set(linear(val(n.in[0]), n.in[1]).out[0]);
        break;
      case "Relu":
      case "Sigmoid": {
        const kind = n.op.toLowerCase(), x = val(n.in[0]), c = prod.get(x);
        if (c && (c.op === "conv" || c.op === "deform_conv") && !c.act && !c.post && sole(n.in[0])) {
          c.act = kind;
          set(x);
        } else set(emit({ op: kind, in: [x], out: [v++] }));
        break;
      }
      case "BatchNormalization": {
        const x = val(n.in[0]), c = prod.get(x);
        const [, sc, bi, mean, vr] = n.in.map((q) => (q && C.has(q) ? cval(q).data : null));
        const k = sc.map((s, i) => s / Math.sqrt(vr[i] + (a.epsilon ?? 1e-5))), sh = bi.map((q, i) => q - mean[i] * k[i]);
        if (!c || (c.op !== "conv" && c.op !== "deform_conv") || c.act || !sole(n.in[0])) throw new Error("BatchNormalization not after a conv: " + n.name);
        foldAffine(c, k, sh);
        set(x);
        break;
      }
      case "LayerNormalization":
        set(emit({ op: "ln_c", in: [val(n.in[0]), "$" + W(n.in[1], cval(n.in[1]).shape, cval(n.in[1]).data), "$" + W(n.in[2], cval(n.in[2]).shape, cval(n.in[2]).data)], out: [v++], a: { eps: a.epsilon ?? 1e-5 } }));
        break;
      case "Add":
      case "Mul": {
        if (ddIn.length === 2) {
          set(emit({ op: n.op === "Add" ? "add" : "multiply", in: ddIn.map(val), out: [v++] }));
          break;
        }
        const x = val(ddIn[0]), c = prod.get(x), k = cval(cIn[0]);
        if (!c || c.op !== "conv" || !sole(ddIn[0])) throw new Error(n.op + " by a constant not after a conv: " + n.name);
        if (n.op === "Add") {
          if (c.b || c.act) throw new Error("bias after bias / activation: " + n.name);
          c.b = W(c.w + ".b", [k.data.length], k.data);
        } else {
          if (k.data.length !== 1 || c.post) throw new Error("Mul by a tensor: " + n.name);
          c.post = [k.data[0], 0];
        }
        set(x);
        break;
      }
      case "Concat": {
        const l = v++;
        emit({ op: "list", in: n.in.map(val), out: [l] });
        set(emit({ op: "concat", in: [l, constNode([a.axis])], out: [v++] }));
        break;
      }
      case "GlobalAveragePool":
        set(emit({ op: "pool2d", in: [val(n.in[0]), constNode([1, 1])], out: [v++], a: { global: true, type: "avg" } }));
        break;
      case "Resize": {
        if (a.mode !== "linear" || a.coordinate_transformation_mode !== "align_corners") throw new Error("Resize variant " + n.name);
        const so = S(n.out[0]);
        set(emit({ op: "resize_ac", in: [val(n.in[0]), vin], out: [v++], a: { div: [INS[2] / so[2], INS[3] / so[3]] } }));
        break;
      }
      default:
        throw new Error(`op ${n.op} (${n.name})`);
    }
  }
  // only the weights the nodes read (folding left the unfolded originals behind)
  const used = new Set();
  for (const n of nodes) {
    for (const k of ["w", "b", "p"]) if (n[k]) used.add(n[k]);
    for (const x of n.in) if (typeof x === "string") used.add(x.slice(1));
  }
  for (const k of [...weights.keys()]) if (!used.has(k)) weights.delete(k);
  return { nodes, weights, input: vin, output: val(onnx.outputs[0]), vals };
}

// ---------- write ----------
/**
 * LWT1 graph file. Weights: f32 (dev / reference), f16, int8 (one scale per output row), or int4 (one scale per 32
 * values). Vectors (biases, norms) and `keep` tensors (the attention's relative position bias) stay f32.
 */
export function writeGraphLwt(g, o) {
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
    const data = t.data;
    if (o.dtype === "f32" || t.shape.length === 1 || t.keep) wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(Float32Array.from(data).buffer)), n], f32: true };
    else if (o.dtype === "i8") {
      const { q, sc } = quantRows(data, t.shape[0]);
      wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(q.buffer)), n], s: [push(new Uint8Array(sc.buffer)), t.shape[0]] };
    } else if (o.dtype === "i4") {
      const G = 32, ng = Math.ceil(n / G), sc = new Float32Array(ng), q = new Uint8Array(Math.ceil(n / 2));
      for (let gI = 0; gI < ng; gI++) {
        let mx = 0;
        for (let i = gI * G; i < Math.min(n, (gI + 1) * G); i++) mx = Math.max(mx, Math.abs(data[i]));
        sc[gI] = mx / 7 || 1;
        for (let i = gI * G; i < Math.min(n, (gI + 1) * G); i++) {
          const c = Math.max(-8, Math.min(7, Math.round(data[i] / sc[gI]))) + 8;
          q[i >> 1] |= c << ((i & 1) * 4);
        }
      }
      wmeta[name] = { shape: t.shape, w: [push(q), n], s: [push(new Uint8Array(sc.buffer)), ng], q4: true, g: G };
    } else {
      const h = new Uint16Array(n);
      for (let i = 0; i < n; i++) h[i] = toHalf(data[i], 10);
      wmeta[name] = { shape: t.shape, w: [push(new Uint8Array(h.buffer)), n] };
    }
  }
  const meta = { model: o.name, format: "graph", dtype: o.dtype === "i4" ? "i8" : o.dtype, params, input: g.input, output: g.output, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], nodes: g.nodes, weights: wmeta };
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
  const src = args[0], out = opt("--out"), shapes = opt("--shapes");
  if (!src || !out || !shapes) {
    console.error("usage: node scripts/convert-birefnet.mjs <model.onnx> --shapes <shapes.json> --out <file.lwt> [--f32|--f16|--int8|--int4]");
    process.exit(2);
  }
  const dtype = args.includes("--f32") ? "f32" : args.includes("--int8") ? "i8" : args.includes("--int4") ? "i4" : "f16";
  const g = birefnetGraph(readOnnx(readFileSync(src)), JSON.parse(readFileSync(shapes, "utf8")));
  const bytes = writeGraphLwt(g, { name: "birefnet-lite", dtype });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, bytes);
  // (checking: which value of the converted graph holds an ONNX value)
  if (opt("--map")) writeFileSync(opt("--map"), JSON.stringify(Object.fromEntries(g.vals)));
  const ops = {};
  for (const n of g.nodes) ops[n.op] = (ops[n.op] ?? 0) + 1;
  console.log(`${out}: ${bytes.length} bytes, ${g.nodes.length} nodes, ${g.weights.size} weights`, JSON.stringify(ops));
}
