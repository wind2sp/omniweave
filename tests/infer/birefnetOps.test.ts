// BiRefNet's ops in Loom Infer (graph.ts: ln_c, win_attn, patch_merge, resize_ac, image2patches, deform_conv, the gelu
// activation, int4 weights) against reference implementations written straight from the definitions the ONNX export
// follows — PyTorch / ONNX LayerNormalization, Swin-Transformer-Object-Detection's SwinTransformerBlock (pad, roll,
// window partition, attention with the shifted-window mask built from img_mask slices as there, reverse), torchvision
// deform_conv2d, F.interpolate(align_corners=True), BiRefNet's image2patches rearrange. The whole converted model is
// checked against the ONNX reference interpreter outside the repository.
// The conv pool's splits of the new ops (deform_conv by rows, win_attn by heads) give the one-thread result.
import { describe, expect, it } from "vitest";
import { writeGraphLwt } from "../../scripts/convert-birefnet.mjs";
import { deformConv, erf, evalNode, image2patches, parseGraph, patchMerge, resizeAC, runGraph, runGraphAsync, type GNode, type Tensor } from "../../src/core/image/infer/graph";
import { ConvPool, graphJob, type ConvWorkerMsg } from "../../src/core/image/infer/convPool";

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}
const rand = (R: () => number, n: number, k = 1) => Float32Array.from({ length: n }, () => R() * 2 * k);
type W = Map<string, { shape: number[]; data: Float32Array; keep?: boolean }>;
/** a graph model from nodes and weights (written and parsed as the converter's files are) */
function model(nodes: GNode[], weights: W, output: number, dtype = "f32") {
  return parseGraph(writeGraphLwt({ nodes, weights, input: 0, output }, { name: "t", dtype }));
}
const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  expect(a.length).toBe(b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
};

describe("BiRefNet ops", () => {
  it("ln_c = LayerNormalization over the last axis of the NHWC transpose", () => {
    const R = rng(1), C = 12, H = 5, Wd = 7;
    const w: W = new Map([
      ["g", { shape: [C], data: rand(R, C, 2) }],
      ["b", { shape: [C], data: rand(R, C) }],
    ]);
    const m = model(
      [
        { op: "ln_c", in: [0, "$g", "$b"], out: [1], a: { eps: 1e-5 } },
        { op: "transpose", in: [0], out: [2], a: { perm: [0, 2, 3, 1] } },
        { op: "layer_norm", in: [2, "$g", "$b"], out: [3], a: { eps: 1e-5 } },
        { op: "transpose", in: [3], out: [4], a: { perm: [0, 3, 1, 2] } },
      ],
      w,
      1,
    );
    const x = { s: [1, C, H, Wd], d: rand(R, C * H * Wd, 3) };
    const env = new Map<number, Tensor>([[0, x]]);
    for (const n of m.meta.nodes) env.set(n.out[0], evalNode(m, n, (k) => (typeof k === "string" ? m.w.get(k.slice(1))! : env.get(k)!)) as Tensor);
    expect(maxDiff(env.get(1)!.d, env.get(4)!.d)).toBeLessThan(2e-6);
  });

  it("gelu activation = x·½(1 + erf(x/√2)) (erf by its series, double precision)", () => {
    const erfRef = (x: number) => {
      // Maclaurin series of erf (|x| ≤ 4 converges in a few dozen terms in doubles)
      let s = 0, t = x, n = 0;
      while (Math.abs(t) > 1e-17 && n < 200) {
        s += t / (2 * n + 1);
        n++;
        t *= (-x * x) / n;
      }
      return (2 / Math.sqrt(Math.PI)) * s;
    };
    for (const v of [-4, -2.5, -1, -0.3, 0, 0.2, 0.7, 1.5, 3.9]) expect(Math.abs(erf(v) - erfRef(v))).toBeLessThan(2e-7);
    const R = rng(2), C = 4;
    const m = model([{ op: "conv", in: [0], out: [1], w: "w", act: "gelu", a: { stride: [1, 1], pad: [0, 0, 0, 0], dil: [1, 1], groups: 1 } }], new Map([["w", { shape: [C, C, 1, 1], data: rand(R, C * C) }]]), 1);
    const x = { s: [1, C, 3, 3], d: rand(R, C * 9, 4) };
    const y = runGraph(m, x).d, w = m.w.get("w")!.d;
    for (let o = 0; o < C; o++)
      for (let p = 0; p < 9; p++) {
        let v = 0;
        for (let c = 0; c < C; c++) v += w[o * C + c] * x.d[c * 9 + p];
        expect(Math.abs(y[o * 9 + p] - v * 0.5 * (1 + erfRef(v / Math.SQRT2)))).toBeLessThan(1e-6);
      }
  });

  /** Swin window attention as Swin-Transformer-Object-Detection writes it, on tokens [H, W, C] */
  function swinRef(y: Tensor, wq: Float32Array, bq: Float32Array, relb: Float32Array, heads: number, ws: number, shift: number, scale: number): Float32Array {
    const [, C, H, W] = y.s, d = C / heads, N = ws * ws;
    const Hp = Math.ceil(H / ws) * ws, Wp = Math.ceil(W / ws) * ws;
    // x.view(B, H, W, C); F.pad(x, (0, 0, 0, pad_r, 0, pad_b))
    const xp = new Float32Array(Hp * Wp * C);
    for (let h = 0; h < H; h++) for (let w = 0; w < W; w++) for (let c = 0; c < C; c++) xp[(h * Wp + w) * C + c] = y.d[(c * H + h) * W + w];
    // torch.roll(x, shifts=(-shift, -shift), dims=(1, 2))
    const roll = (src: Float32Array, s: number, ch: number) => {
      const o = new Float32Array(src.length);
      for (let h = 0; h < Hp; h++) for (let w = 0; w < Wp; w++) for (let c = 0; c < ch; c++) o[(h * Wp + w) * ch + c] = src[((((h + s) % Hp) + Hp) % Hp * Wp + ((((w + s) % Wp) + Wp) % Wp)) * ch + c];
      return o;
    };
    const xs = shift ? roll(xp, shift, C) : xp;
    // img_mask: h_slices = (slice(0, -ws), slice(-ws, -shift), slice(-shift, None)), same for w, cnt += 1
    const img = new Float32Array(Hp * Wp);
    if (shift) {
      const sl = (n: number) => [[0, n - ws], [n - ws, n - shift], [n - shift, n]];
      let cnt = 0;
      for (const [h0, h1] of sl(Hp))
        for (const [w0, w1] of sl(Wp)) {
          for (let h = h0; h < h1; h++) for (let w = w0; w < w1; w++) img[h * Wp + w] = cnt;
          cnt++;
        }
    }
    const out = new Float32Array(Hp * Wp * C);
    for (let wy = 0; wy < Hp / ws; wy++)
      for (let wx = 0; wx < Wp / ws; wx++) {
        const tok = (i: number) => (wy * ws + Math.floor(i / ws)) * Wp + wx * ws + (i % ws);
        // qkv = Linear(C, 3C) on the window's tokens
        const qkv = new Float32Array(N * 3 * C);
        for (let i = 0; i < N; i++)
          for (let o = 0; o < 3 * C; o++) {
            let v = bq[o];
            for (let c = 0; c < C; c++) v += wq[o * C + c] * xs[tok(i) * C + c];
            qkv[i * 3 * C + o] = v;
          }
        for (let h = 0; h < heads; h++)
          for (let i = 0; i < N; i++) {
            const a = new Float64Array(N);
            for (let j = 0; j < N; j++) {
              let t = 0;
              for (let c = 0; c < d; c++) t += qkv[i * 3 * C + h * d + c] * scale * qkv[j * 3 * C + C + h * d + c];
              t += relb[(h * N + i) * N + j];
              if (shift && img[tok(i)] !== img[tok(j)]) t += -100;
              a[j] = t;
            }
            const mx = Math.max(...a);
            let sum = 0;
            for (let j = 0; j < N; j++) sum += a[j] = Math.exp(a[j] - mx);
            for (let c = 0; c < d; c++) {
              let v = 0;
              for (let j = 0; j < N; j++) v += (a[j] / sum) * qkv[j * 3 * C + 2 * C + h * d + c];
              out[tok(i) * C + h * d + c] = v;
            }
          }
      }
    const back = shift ? roll(out, -shift, C) : out;
    const r = new Float32Array(C * H * W);
    for (let h = 0; h < H; h++) for (let w = 0; w < W; w++) for (let c = 0; c < C; c++) r[(c * H + h) * W + w] = back[(h * Wp + w) * C + c];
    return r;
  }

  for (const [H, Wd, ws, shift, heads] of [
    [10, 10, 7, 3, 2],
    [9, 12, 7, 0, 2],
    [8, 11, 3, 1, 3],
    [6, 6, 3, 1, 1],
  ] as const)
    it(`win_attn = Swin's window attention (${H}×${Wd}, window ${ws}, shift ${shift}, ${heads} heads)`, () => {
      const R = rng(H * 100 + Wd), C = 4 * heads, N = ws * ws;
      const wq = rand(R, 3 * C * C), bq = rand(R, 3 * C, 0.5), relb = rand(R, heads * N * N, 2);
      const w: W = new Map([
        ["qkv", { shape: [3 * C, C, 1, 1], data: wq }],
        ["qkv.b", { shape: [3 * C], data: bq }],
        ["relb", { shape: [heads, N, N], data: relb, keep: true }],
      ]);
      const scale = 1 / Math.sqrt(C / heads);
      const m = model(
        [
          { op: "conv", in: [0], out: [1], w: "qkv", b: "qkv.b", a: { stride: [1, 1], pad: [0, 0, 0, 0], dil: [1, 1], groups: 1 } },
          { op: "win_attn", in: [1, "$qkv.b", "$relb"], out: [2], a: { heads, ws, shift, scale } },
        ],
        w,
        2,
      );
      const x = { s: [1, C, H, Wd], d: rand(R, C * H * Wd, 1.5) };
      expect(maxDiff(runGraph(m, x).d, swinRef(x, wq, bq, relb, heads, ws, shift, scale))).toBeLessThan(2e-5);
    });

  it("patch_merge = cat(x[0::2, 0::2], x[1::2, 0::2], x[0::2, 1::2], x[1::2, 1::2]) after padding odd sides", () => {
    const R = rng(3), C = 3, H = 5, Wd = 7, x = { s: [1, C, H, Wd], d: rand(R, C * H * Wd) };
    const o = patchMerge(x), oh = 3, ow = 4;
    expect(o.s).toEqual([1, 4 * C, oh, ow]);
    const at = (c: number, y: number, xx: number) => (y < H && xx < Wd ? x.d[(c * H + y) * Wd + xx] : 0);
    const parts = [[0, 0], [1, 0], [0, 1], [1, 1]];
    for (let q = 0; q < 4; q++) for (let c = 0; c < C; c++) for (let y = 0; y < oh; y++) for (let xx = 0; xx < ow; xx++) expect(o.d[((q * C + c) * oh + y) * ow + xx]).toBe(at(c, 2 * y + parts[q][0], 2 * xx + parts[q][1]));
  });

  it("resize_ac = ONNX Resize linear / align_corners (sizes as fractions of the reference input)", () => {
    const R = rng(4);
    const ref = (x: Tensor, OH: number, OW: number) => {
      const [, C, H, W] = x.s, o = new Float32Array(C * OH * OW);
      for (let c = 0; c < C; c++)
        for (let y = 0; y < OH; y++)
          for (let xx = 0; xx < OW; xx++) {
            // x_original = x_resized · (length_original − 1) / (length_resized − 1)
            const fy = OH === 1 ? 0 : (y * (H - 1)) / (OH - 1), fx = OW === 1 ? 0 : (xx * (W - 1)) / (OW - 1);
            const y0 = Math.floor(fy), x0 = Math.floor(fx), y1 = Math.min(H - 1, y0 + 1), x1 = Math.min(W - 1, x0 + 1);
            const p = (a: number, b: number) => x.d[(c * H + a) * W + b];
            o[(c * OH + y) * OW + xx] = (p(y0, x0) * (1 - (fx - x0)) + p(y0, x1) * (fx - x0)) * (1 - (fy - y0)) + (p(y1, x0) * (1 - (fx - x0)) + p(y1, x1) * (fx - x0)) * (fy - y0);
          }
      return o;
    };
    for (const [H, W, OH, OW] of [[8, 8, 16, 16], [16, 12, 8, 6], [1, 1, 4, 4], [5, 7, 5, 7], [6, 4, 9, 13]]) {
      const x = { s: [1, 2, H, W], d: rand(R, 2 * H * W) };
      expect(maxDiff(resizeAC(x, OH, OW).d, ref(x, OH, OW))).toBeLessThan(1e-6);
    }
    // in a graph: the size is the reference input's / div
    const m = model([{ op: "resize_ac", in: [1, 0], out: [2], a: { div: [2, 4] } }], new Map(), 2);
    const g = { s: [1, 3, 32, 64], d: new Float32Array(3 * 32 * 64) }, x = { s: [1, 2, 4, 4], d: rand(R, 32) };
    const r = evalNode(m, m.meta.nodes[0], (k) => (k === 0 ? g : x)) as Tensor;
    expect(r.s).toEqual([1, 2, 16, 16]);
    expect(maxDiff(r.d, ref(x, 16, 16))).toBeLessThan(1e-6);
  });

  it("image2patches = rearrange 'b c (i h) (j w) -> b (j i c) h w' (the order BiRefNet's export makes)", () => {
    const R = rng(5), C = 3, H = 8, Wd = 12;
    const x = { s: [1, C, H, Wd], d: rand(R, C * H * Wd) };
    for (const g of [1, 2, 4]) {
      const o = image2patches(x, g), h = H / g, w = Wd / g;
      expect(o.s).toEqual([1, C * g * g, h, w]);
      for (let c = 0; c < C; c++) for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) expect(o.d[(((j * g + i) * C + c) * h + y) * w + xx]).toBe(x.d[(c * H + i * h + y) * Wd + j * w + xx]);
    }
  });

  /** torchvision deform_conv2d (one offset group, with mask), straight from its CPU kernel */
  function deformRef(x: Tensor, off: Tensor, mask: Tensor, w: Tensor, b: Float32Array, pad: number) {
    const [, cin, H, W] = x.s, [cout, , kh, kw] = w.s, [, , OH, OW] = off.s;
    const bil = (c: number, h: number, ww: number) => {
      if (h <= -1 || H <= h || ww <= -1 || W <= ww) return 0;
      const hl = Math.floor(h), wl = Math.floor(ww), hh = hl + 1, wh = wl + 1, lh = h - hl, lw = ww - wl;
      const v = (a: number, bb: number) => x.d[(c * H + a) * W + bb];
      const v1 = hl >= 0 && wl >= 0 ? v(hl, wl) : 0, v2 = hl >= 0 && wh <= W - 1 ? v(hl, wh) : 0, v3 = hh <= H - 1 && wl >= 0 ? v(hh, wl) : 0, v4 = hh <= H - 1 && wh <= W - 1 ? v(hh, wh) : 0;
      return (1 - lh) * (1 - lw) * v1 + (1 - lh) * lw * v2 + lh * (1 - lw) * v3 + lh * lw * v4;
    };
    const o = new Float32Array(cout * OH * OW);
    for (let oc = 0; oc < cout; oc++)
      for (let y = 0; y < OH; y++)
        for (let xx = 0; xx < OW; xx++) {
          let s = b[oc];
          for (let ky = 0; ky < kh; ky++)
            for (let kx = 0; kx < kw; kx++) {
              const t = ky * kw + kx, p = y * OW + xx;
              const h = y - pad + ky + off.d[2 * t * OH * OW + p], ww = xx - pad + kx + off.d[(2 * t + 1) * OH * OW + p], m = mask.d[t * OH * OW + p];
              for (let c = 0; c < cin; c++) s += w.d[((oc * cin + c) * kh + ky) * kw + kx] * m * bil(c, h, ww);
            }
          o[(oc * OH + y) * OW + xx] = s;
        }
    return o;
  }

  for (const [k, pad, H, Wd] of [
    [3, 1, 9, 11],
    [1, 0, 7, 6],
    [7, 3, 10, 9],
  ] as const)
    it(`deform_conv = torchvision deform_conv2d with mask (k ${k})`, () => {
      const R = rng(k * 7 + H), cin = 5, cout = 6, KK = k * k;
      const x = { s: [1, cin, H, Wd], d: rand(R, cin * H * Wd) };
      // offsets up to ±4 px: some taps leave the picture
      const off = { s: [1, 2 * KK, H, Wd], d: rand(R, 2 * KK * H * Wd, 4) };
      const mask = { s: [1, KK, H, Wd], d: Float32Array.from({ length: KK * H * Wd }, () => (R() + 0.5) * 2) };
      const w = { s: [cout, cin, k, k], d: rand(R, cout * cin * KK) }, b = rand(R, cout);
      const want = deformRef(x, off, mask, w, b, pad);
      expect(maxDiff(deformConv(x, off, mask, w, b, { pad: [pad, pad] }).d, want)).toBeLessThan(2e-5);
      // a band of rows (what a conv pool worker computes)
      const band = deformConv(x, { s: [1, 2 * KK, 3, Wd], d: rowsOfT(off, 2, 5) }, { s: [1, KK, 3, Wd], d: rowsOfT(mask, 2, 5) }, w, b, { pad: [pad, pad] }, 2);
      for (let c = 0; c < cout; c++) for (let y = 0; y < 3; y++) for (let xx = 0; xx < Wd; xx++) expect(Math.abs(band.d[(c * 3 + y) * Wd + xx] - want[(c * H + y + 2) * Wd + xx])).toBeLessThan(2e-5);
      // zero offsets, mask 1: the plain conv
      const z = deformConv(x, { s: off.s, d: new Float32Array(off.d.length) }, { s: mask.s, d: new Float32Array(mask.d.length).fill(1) }, w, b, { pad: [pad, pad] });
      const m = model([{ op: "conv", in: [0], out: [1], w: "w", b: "b", a: { stride: [1, 1], pad: [pad, pad, pad, pad], dil: [1, 1], groups: 1 } }], new Map([["w", { shape: w.s, data: w.d }], ["b", { shape: [cout], data: b }]]), 1);
      expect(maxDiff(z.d, runGraph(m, x).d)).toBeLessThan(2e-5);
    });
  const rowsOfT = (t: Tensor, y0: number, y1: number) => {
    const [, C, H, W] = t.s, o = new Float32Array(C * (y1 - y0) * W);
    for (let c = 0; c < C; c++) o.set(t.d.subarray((c * H + y0) * W, (c * H + y1) * W), c * (y1 - y0) * W);
    return o;
  };

  it("int4 weights: one scale per 32 values, every weight within half a step", () => {
    const R = rng(6), cout = 8, cin = 40;
    const data = rand(R, cout * cin * 9);
    const m = model([{ op: "conv", in: [0], out: [1], w: "w", a: { stride: [1, 1], pad: [1, 1, 1, 1], dil: [1, 1], groups: 1 } }], new Map([["w", { shape: [cout, cin, 3, 3], data }]]), 1, "i4");
    expect(m.meta.weights.w.q4).toBe(true);
    const q = m.w.get("w")!.d;
    for (let g = 0; g < data.length / 32; g++) {
      let mx = 0;
      for (let i = g * 32; i < (g + 1) * 32; i++) mx = Math.max(mx, Math.abs(data[i]));
      for (let i = g * 32; i < (g + 1) * 32; i++) expect(Math.abs(q[i] - data[i])).toBeLessThanOrEqual((mx / 7) * 0.5001);
    }
    // a malformed scale table is refused
    const bytes = writeGraphLwt({ nodes: [], weights: new Map([["w", { shape: [cout, cin, 3, 3], data }]]), input: 0, output: 0 }, { name: "t", dtype: "i4" });
    const jl = new DataView(bytes.buffer).getUint32(4, true);
    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jl)));
    meta.weights.w.g = 16;
    let js = JSON.stringify(meta);
    while (js.length < jl) js += " ";
    if (js.length === jl) {
      const b2 = bytes.slice();
      b2.set(new TextEncoder().encode(js), 8);
      expect(() => parseGraph(b2)).toThrow(/weight scales/);
    }
  });

  it("the conv pool: deform_conv split by rows, win_attn by heads — the one-thread result", async () => {
    const R = rng(7), C = 16, H = 20, Wd = 14, heads = 4, ws = 7, N = ws * ws;
    const w: W = new Map([
      ["off", { shape: [18, C, 3, 3], data: rand(R, 18 * C * 9, 0.3) }],
      ["msk", { shape: [9, C, 3, 3], data: rand(R, 9 * C * 9, 0.3) }],
      ["dw", { shape: [48, C, 3, 3], data: rand(R, 48 * C * 9, 0.3) }],
      ["db", { shape: [48], data: rand(R, 48) }],
      ["qkv", { shape: [3 * C, 48, 1, 1], data: rand(R, 3 * C * 48, 0.3) }],
      ["qkv.b", { shape: [3 * C], data: rand(R, 3 * C) }],
      ["relb", { shape: [heads, N, N], data: rand(R, heads * N * N), keep: true }],
    ]);
    const cv = { stride: [1, 1], pad: [1, 1, 1, 1], dil: [1, 1], groups: 1 };
    const nodes: GNode[] = [
      { op: "conv", in: [0], out: [1], w: "off", a: cv },
      { op: "conv", in: [0], out: [2], w: "msk", act: "sigmoid", post: [2, 0], a: cv },
      { op: "deform_conv", in: [0, 1, 2], out: [3], w: "dw", b: "db", act: "relu", a: { pad: [1, 1], stride: [1, 1], dil: [1, 1] } },
      { op: "conv", in: [3], out: [4], w: "qkv", b: "qkv.b", a: { stride: [1, 1], pad: [0, 0, 0, 0], dil: [1, 1], groups: 1 } },
      { op: "win_attn", in: [4, "$qkv.b", "$relb"], out: [5], a: { heads, ws, shift: 3, scale: 0.35 } },
    ];
    const bytes = writeGraphLwt({ nodes, weights: w, input: 0, output: 5 }, { name: "t", dtype: "f32" });
    const m = parseGraph(bytes);
    const x = { s: [1, C, H, Wd], d: rand(R, C * H * Wd) };
    const one = runGraph(m, x);
    const fake = () => {
      let part = 0, parts = 1, g: ReturnType<typeof parseGraph> | null = null;
      const wk = {
        onmessage: null as ((e: MessageEvent) => void) | null,
        onerror: null,
        terminate() {},
        postMessage(msg: ConvWorkerMsg) {
          if (msg.kind === "init") return void ((part = msg.part), (parts = msg.parts), (g = parseGraph(new Uint8Array(msg.bytes))));
          setTimeout(() => {
            const r = graphJob(g!, msg, part, parts);
            wk.onmessage?.({ data: { id: msg.id, s: r.s, d: r.d } } as MessageEvent);
          }, 0);
        },
      };
      return wk;
    };
    const pool = new ConvPool(fake, "graph", bytes.slice().buffer, 3);
    const seen = new Set<string>();
    const out = await runGraphAsync(m, x, (i, n, t, ins) => {
      // (small test sizes: below the pool's own thresholds, so ask for the split directly)
      const p = n.op === "deform_conv" ? (pool as any).deform(m, i, n, ins) : n.op === "win_attn" ? (pool as any).heads(i, n, ins![0]) : null;
      if (p) seen.add(n.op);
      return p;
    });
    expect([...seen].sort()).toEqual(["deform_conv", "win_attn"]);
    expect(maxDiff(out.d, one.d)).toBeLessThan(1e-6);
    pool.terminate();
  });
});
