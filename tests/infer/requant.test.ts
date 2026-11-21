// Offline weight re-quantisation (scripts/lwtQuant.mjs, scripts/requant-lwt.mjs): the files it writes must load with the
// unchanged runtime (infer/model.ts, infer/graph.ts) and stay within the stated error. docs/design/INSTALLER_SIZE.md.
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build scripts (no types)
import { entropyBits, palettise, quantRows, toHalf } from "../../scripts/lwtQuant.mjs";
// @ts-expect-error — plain .mjs build scripts (no types)
import { requant } from "../../scripts/requant-lwt.mjs";
import { halfToFloat, parseModel, type ConvLayer } from "../../src/core/image/infer/model";
import { parseGraph } from "../../src/core/image/infer/graph";
import { rng } from "../matte/synth";

function lwt(meta: object, blob: Uint8Array): Uint8Array {
  let js = JSON.stringify(meta);
  while ((8 + new TextEncoder().encode(js).length) % 4) js += " ";
  const json = new TextEncoder().encode(js);
  const out = new Uint8Array(8 + json.length + blob.length);
  out.set([0x4c, 0x57, 0x54, 0x31]);
  new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8);
  out.set(blob, 8 + json.length);
  return out;
}

/** weights with a heavy tail and one tiny-weight channel (what BatchNorm folding leaves behind) */
function weights(R: () => number, cout: number, per: number): Float32Array {
  const w = new Float32Array(cout * per);
  for (let o = 0; o < cout; o++) {
    const scale = o === 1 ? 1e-7 : 0.05 + R();
    for (let i = 0; i < per; i++) w[o * per + i] = (R() - 0.5) * scale * (R() < 0.05 ? 8 : 1);
  }
  return w;
}

describe("toHalf (fp16 with a shorter mantissa)", () => {
  it("is plain round-to-nearest fp16 at 10 bits", () => {
    for (const v of [1, -2, 0.333333, 1e-3, 6.1e-5, 1e-6, 65504, 0]) {
      const h = toHalf(v);
      expect(Math.abs(halfToFloat(h) - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11 + 2 ** -25);
    }
    expect(toHalf(1)).toBe(0x3c00);
    expect(toHalf(-2)).toBe(0xc000);
  });

  it("keeps the relative error within 2^-(M+1) and zeroes the dropped bits", () => {
    const R = rng(7);
    for (const M of [8, 6, 4]) {
      for (let k = 0; k < 2000; k++) {
        const v = (R() < 0.5 ? -1 : 1) * (1 + R()) * 2 ** -(1 + R() * 12); // normal fp16 range of normalised weights
        const h = toHalf(v, M);
        expect(h & ((1 << (10 - M)) - 1)).toBe(0);
        expect(Math.abs(halfToFloat(h) - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -(M + 1) * 1.0001);
      }
    }
  });
});

describe("quantRows / palettise", () => {
  it("plain int8: per-row scale max/127, values round(w/s)", () => {
    const w = Float32Array.from([0.5, -1, 0.25, 0, 2, -0.5, 1, 0.1]);
    const { q, sc } = quantRows(w, 2);
    expect(Array.from(sc)).toEqual([Math.fround(1 / 127), Math.fround(2 / 127)]);
    expect(Array.from(q)).toEqual([64, -127, 32, 0, 127, -32, 64, 6]);
  });

  it("a K-level codebook leaves at most K distinct values and lowers the entropy", () => {
    const R = rng(3);
    const w = weights(R, 16, 300);
    const plain = quantRows(w, 16).q;
    for (const K of [64, 16]) {
      const { q } = quantRows(w, 16, { levels: K });
      expect(new Set(q).size).toBeLessThanOrEqual(K);
      expect(entropyBits(q)).toBeLessThan(entropyBits(plain));
    }
    const few = Int8Array.from([1, 1, -3, 5]);
    expect(Array.from(palettise(few, 8))).toEqual([-3, 1, 5]);
    expect(Array.from(few)).toEqual([1, 1, -3, 5]);
  });
});

describe("requant-lwt output loads with the runtime", () => {
  // a two-conv U²-Net-format model (f32 source, as scripts/convert-u2netp.mjs --f32 writes it)
  const R = rng(11);
  const L = [
    { cin: 3, cout: 4, k: 3 },
    { cin: 4, cout: 2, k: 1 },
  ];
  const parts: Uint8Array[] = [];
  let off = 0;
  const put = (a: Float32Array) => {
    const at = off;
    parts.push(new Uint8Array(a.buffer));
    off += a.byteLength;
    return [at, a.length] as [number, number];
  };
  const W = L.map((l) => weights(R, l.cout, l.cin * l.k * l.k));
  const B = L.map((l) => Float32Array.from({ length: l.cout }, () => R() - 0.5));
  const layers = L.map((l, i) => ({ op: "conv", in: `t${i}`, out: `t${i + 1}`, cin: l.cin, cout: l.cout, k: l.k, pad: l.k >> 1, dil: 1, relu: i === 0, sigmoid: i === 1, w: put(W[i]), b: put(B[i]) }));
  const blob = new Uint8Array(off);
  parts.reduce((p, b) => (blob.set(b, p), p + b.length), 0);
  const src = lwt({ model: "t", input: [3, 4, 4], mean: [0, 0, 0], std: [1, 1, 1], dtype: "f32", params: 0, output: "t2", tensors: { t0: [3, 4, 4], t1: [4, 4, 4], t2: [2, 4, 4] }, layers }, blob);

  it("f32 source → fp16 / 6-bit-mantissa fp16 / int8, each within its error bound", () => {
    const ref = parseModel(src);
    for (const [o, bound] of [
      [{ f16Mantissa: 10 }, 2 ** -11],
      [{ f16Mantissa: 6 }, 2 ** -7],
      [{}, 0.5 / 127],
    ] as const) {
      const m = parseModel(requant(src, o));
      expect(m.meta.dtype).toBe("f16Mantissa" in o ? "f16" : "i8");
      m.layers.forEach((Lq, i) => {
        const a = Lq as ConvLayer, b = ref.layers[i] as ConvLayer;
        expect(Array.from(a.bias)).toEqual(Array.from(b.bias));
        const per = a.cin * a.k * a.k;
        for (let c = 0; c < a.cout; c++) {
          let mx = 0;
          for (let j = 0; j < per; j++) mx = Math.max(mx, Math.abs(b.weight[c * per + j]));
          for (let j = 0; j < per; j++) {
            const err = Math.abs(a.weight[c * per + j] - b.weight[c * per + j]);
            // fp16 modes: relative to the weight itself (the tiny channel keeps its precision); int8: to the channel max
            const lim = "f16Mantissa" in o ? Math.abs(b.weight[c * per + j]) * bound * 1.001 + mx * 2 ** -24 : mx * bound * 1.001;
            expect(err).toBeLessThanOrEqual(lim);
          }
        }
      });
    }
  });

  it("graph models: big tensors become int8 rows, small ones and biases stay f32", () => {
    const big = weights(R, 8, 600), small = Float32Array.from({ length: 12 }, () => R()), bias = Float32Array.from({ length: 8 }, () => R());
    const bytes = new Uint8Array(big.byteLength + small.byteLength + bias.byteLength);
    bytes.set(new Uint8Array(big.buffer), 0);
    bytes.set(new Uint8Array(small.buffer), big.byteLength);
    bytes.set(new Uint8Array(bias.buffer), big.byteLength + small.byteLength);
    const meta = {
      model: "g", format: "graph", dtype: "f16", params: 0, input: 0, output: 1, mean: [0, 0, 0], std: [1, 1, 1], nodes: [],
      weights: {
        big: { shape: [8, 600], w: [0, big.length], f32: true },
        small: { shape: [12], w: [big.byteLength, 12], f32: true },
        "x:b": { shape: [8], w: [big.byteLength + small.byteLength, 8], f32: true },
      },
    };
    const g = parseGraph(requant(lwt(meta, bytes)));
    expect(g.meta.dtype).toBe("i8");
    expect(g.meta.weights.big.s).toBeTruthy();
    expect(g.meta.weights.small.f32).toBe(true);
    expect(Array.from(g.w.get("small")!.d)).toEqual(Array.from(small));
    expect(Array.from(g.w.get("x:b")!.d)).toEqual(Array.from(bias));
    const q = g.w.get("big")!.d;
    for (let r = 0; r < 8; r++) {
      let mx = 0;
      for (let j = 0; j < 600; j++) mx = Math.max(mx, Math.abs(big[r * 600 + j]));
      for (let j = 0; j < 600; j++) expect(Math.abs(q[r * 600 + j] - big[r * 600 + j])).toBeLessThanOrEqual((mx / 127) * 0.5001);
    }
    expect(() => requant(lwt(meta, bytes), { f16Mantissa: 6 })).toThrow(/U²-Net format/);
  });
});
