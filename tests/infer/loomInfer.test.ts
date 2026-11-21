// Loom Infer: kernels, model file, WebGPU plan (replayed on the CPU) and numerics against ONNX Runtime outputs
// (tests/fixtures/matte/u2netp-ref.bin, rebuilt by tests/infer/fixture.dev.test.ts + scripts/u2netp-reference.py).
import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unzlibSync } from "fflate";
import { halfToFloat, parseModel, type ConvLayer, type Layer, type Model } from "../../src/core/image/infer/model";
import { convTs, pool2, runCpu, upBilinear } from "../../src/core/image/infer/cpu";
import { convKernel, convModuleBytes } from "../../src/core/image/infer/wasm";
import { planGpu, type GpuPlan } from "../../src/core/image/infer/gpuPlan";
import { preprocess } from "../../src/core/image/infer";
import { rng } from "../matte/synth";
import { FIXTURE_CASES } from "./fixtureCases";

const MODEL = "src/assets/models/u2netp.lwt";
const model = parseModel(new Uint8Array(readFileSync(MODEL)));

function randConv(R: () => number, cin: number, cout: number, k: 1 | 3, dil: number, act: "relu" | "sigmoid" | "none"): ConvLayer {
  const weight = new Float32Array(cout * cin * k * k).map(() => (R() - 0.5) * 0.6);
  const bias = new Float32Array(cout).map(() => (R() - 0.5) * 0.2);
  return { op: "conv", in: "x", out: "y", cin, cout, k, pad: k === 3 ? dil : 0, dil, relu: act === "relu", sigmoid: act === "sigmoid", weight, bias };
}

/** a one-layer model, so the WASM path (which needs packed weights) can run a single conv */
function oneConv(L: ConvLayer, h: number, w: number): Model {
  return {
    meta: { model: "t", input: [L.cin, h, w], mean: [0, 0, 0], std: [1, 1, 1], dtype: "f16", params: 0, output: "y", tensors: { x: [L.cin, h, w], y: [L.cout, h, w] }, layers: [] },
    layers: [L],
    lastUse: new Map([["x", 0]]),
    macs: 0,
  };
}

describe("Loom Infer kernels", () => {
  it("half floats decode exactly", () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x3555)).toBeCloseTo(0.333251953125, 12);
    expect(halfToFloat(0x0001)).toBe(2 ** -24);
  });

  it("the WebAssembly SIMD module validates and compiles", () => {
    expect(WebAssembly.validate(convModuleBytes() as BufferSource)).toBe(true);
    expect(convKernel()).not.toBeNull();
  });

  it("WASM SIMD conv equals the TS conv (k 1/3, dilation 1/2/4, odd sizes, channel counts not multiple of 4)", () => {
    const R = rng(7);
    for (const [cin, cout, k, dil, h, w, act] of [
      [3, 5, 3, 1, 13, 11, "relu"],
      [6, 4, 3, 2, 9, 17, "none"],
      [5, 7, 3, 4, 20, 20, "relu"],
      [8, 1, 1, 1, 7, 9, "sigmoid"],
      [16, 12, 1, 1, 10, 3, "relu"],
    ] as const) {
      const L = randConv(R, cin, cout, k, dil, act);
      const x = new Float32Array(cin * h * w).map(() => R() * 2 - 1);
      const ref = convTs({ c: cin, h, w, d: x }, L).d;
      const out = runCpu(oneConv(L, h, w), x);
      let mx = 0;
      for (let i = 0; i < ref.length; i++) mx = Math.max(mx, Math.abs(ref[i] - out[i]));
      expect(mx, `cin${cin} cout${cout} k${k} d${dil}`).toBeLessThan(1e-5);
    }
  });

  it("2×2 max pool with ceil mode keeps the last partial window", () => {
    const x = Float32Array.from({ length: 15 }, (_, i) => i); // 1×3×5
    const r = pool2({ c: 1, h: 3, w: 5, d: x }, true);
    expect([r.h, r.w]).toEqual([2, 3]);
    expect(Array.from(r.d)).toEqual([6, 8, 9, 11, 13, 14]);
    expect(pool2({ c: 1, h: 3, w: 5, d: x }, false).d.length).toBe(2);
  });

  it("bilinear upsampling follows ONNX half_pixel (PyTorch align_corners=False)", () => {
    const r = upBilinear({ c: 1, h: 2, w: 2, d: Float32Array.from([0, 1, 2, 3]) }, 4, 4);
    // first row: src x = (o + .5)/2 − .5 → −.25(clamped 0), .25, .75, 1.25(clamped 1)
    expect(Array.from(r.d.subarray(0, 4)).map((v) => +v.toFixed(3))).toEqual([0, 0.25, 0.75, 1]);
    expect(+r.d[15].toFixed(3)).toBe(3);
  });
});

describe("U²-Netp model file", () => {
  it("is the fp16 LWT with the expected graph and stays small", () => {
    expect(model.meta.dtype).toBe("f16");
    expect(model.meta.input).toEqual([3, 320, 320]);
    const ops: Record<string, number> = {};
    for (const L of model.layers) ops[L.op] = (ops[L.op] ?? 0) + 1;
    expect(ops).toEqual({ conv: 119, pool: 33, concat: 51, up: 38, add: 11 });
    expect(model.meta.params).toBe(1125485);
    expect(statSync(MODEL).size).toBeLessThan(2_400_000); // 2.30 MB
    expect(model.meta.tensors[model.meta.output]).toEqual([1, 320, 320]);
    const last = model.layers[model.layers.length - 1] as ConvLayer;
    expect(last.sigmoid).toBe(true);
  });
});

/** Replay a GPU plan with the CPU kernels on per-slot buffers (same slots, offsets, uniforms as the shaders get). */
function emulatePlan(m: Model, plan: GpuPlan, input: Float32Array): Float32Array {
  const slots = plan.slots.map((n) => new Float32Array(n));
  slots[plan.inputSlot].set(input);
  for (const s of plan.steps) {
    if (s.kind === "copy") slots[s.dst].set(slots[s.src].subarray(0, s.n), s.dstOffset);
    else if (s.kind === "add") for (let i = 0; i < s.n; i++) slots[s.dst][i] = slots[s.a][i] + slots[s.b][i];
    else if (s.kind === "pool") {
      const [c, h, w] = s.u;
      slots[s.dst].set(pool2({ c, h, w, d: slots[s.src].subarray(0, c * h * w) }, true).d);
    } else if (s.kind === "up") {
      const [c, h, w, oh, ow, align] = s.u;
      slots[s.dst].set(upBilinear({ c, h, w, d: slots[s.src].subarray(0, c * h * w) }, oh, ow, !!align).d);
    } else {
      const [cin, cout, h, w, , , k, pad, dil, act, wOff, bOff] = s.u;
      const L = m.layers[s.layer] as ConvLayer;
      const view: ConvLayer = { ...L, cin, cout, k, pad, dil, relu: act === 1, sigmoid: act === 2, weight: plan.weights.subarray(wOff, wOff + cout * cin * k * k), bias: plan.weights.subarray(bOff, bOff + cout) };
      slots[s.dst].set(convTs({ c: cin, h, w, d: slots[s.src].subarray(0, cin * h * w) }, view).d);
    }
  }
  return slots[plan.outputSlot].subarray(0, plan.outputLen);
}

/** small U-shaped net with every op kind and slot reuse */
function miniNet(): Model {
  const R = rng(3);
  const c = (i: string, o: string, cin: number, cout: number, k: 1 | 3, dil = 1, act: "relu" | "sigmoid" | "none" = "relu"): Layer => ({ ...randConv(R, cin, cout, k, dil, act), in: i, out: o });
  const layers: Layer[] = [
    c("x", "a", 3, 4, 3),
    { op: "pool", in: "a", out: "p", ceil: true },
    c("p", "b", 4, 6, 3, 2),
    { op: "up", in: "b", out: "u", h: 9, w: 11, align: false },
    { op: "concat", in: ["u", "a"], out: "cat" },
    c("cat", "d", 10, 4, 3),
    { op: "add", in: ["d", "a"], out: "s" },
    c("s", "y", 4, 1, 1, 1, "sigmoid"),
  ];
  const tensors: Record<string, [number, number, number]> = { x: [3, 9, 11], a: [4, 9, 11], p: [4, 5, 6], b: [6, 5, 6], u: [6, 9, 11], cat: [10, 9, 11], d: [4, 9, 11], s: [4, 9, 11], y: [1, 9, 11] };
  const lastUse = new Map<string, number>();
  layers.forEach((L, i) => (Array.isArray(L.in) ? L.in : [L.in]).forEach((x) => lastUse.set(x, i)));
  return { meta: { model: "mini", input: [3, 9, 11], mean: [0, 0, 0], std: [1, 1, 1], dtype: "f16", params: 0, output: "y", tensors, layers: [] }, layers, lastUse, macs: 0 };
}

describe("WebGPU plan", () => {
  it("replayed on the CPU it gives exactly the CPU executor's result", () => {
    const m = miniNet();
    const x = new Float32Array(3 * 9 * 11).map(rng(5));
    const plan = planGpu(m);
    expect(Array.from(emulatePlan(m, plan, x))).toEqual(Array.from(runCpu(m, x, { noWasm: true })));
  });

  it("U²-Netp plan: no step reads the buffer it writes, slots are large enough, buffers are reused", () => {
    const plan = planGpu(model);
    const size = (n: string) => model.meta.tensors[n].reduce((a, b) => a * b, 1);
    for (const s of plan.steps) {
      if (s.kind === "add") expect(s.dst !== s.a && s.dst !== s.b).toBe(true);
      else expect(s.dst).not.toBe(s.src);
    }
    let i = 0;
    for (const L of model.layers) {
      const conv = plan.steps.filter((s) => s.kind === "conv")[i];
      if (L.op === "conv") {
        expect(plan.slots[conv.dst]).toBeGreaterThanOrEqual(size(L.out));
        i++;
      }
    }
    expect(plan.slots.length).toBeLessThan(40); // 253 tensors share a few dozen buffers
    const mb = plan.slots.reduce((a, b) => a + b, 0) * 4 / 2 ** 20;
    console.log(`WebGPU plan: ${plan.slots.length} buffers, ${mb.toFixed(0)} MB activations, ${plan.steps.length} steps`);
    expect(mb).toBeLessThan(400);
  });
});

describe("U²-Netp numerics vs ONNX Runtime", () => {
  it("max abs difference of the fused sigmoid output stays small (fp16 weights)", () => {
    const ref = unzlibSync(new Uint8Array(readFileSync("tests/fixtures/matte/u2netp-ref.bin")));
    const imgs = FIXTURE_CASES();
    let worst = 0, sum = 0, n = 0;
    imgs.forEach((img, k) => {
      const t0 = performance.now();
      const out = runCpu(model, preprocess(img));
      const ms = performance.now() - t0;
      let mx = 0;
      for (let i = 0; i < out.length; i++) {
        const d = Math.abs(out[i] - ref[k * out.length + i] / 255);
        mx = Math.max(mx, d);
        sum += d;
        n++;
      }
      worst = Math.max(worst, mx);
      console.log(`u2netp case ${k}: max |Δ| ${mx.toFixed(4)} (incl. ±0.002 fixture rounding), ${ms.toFixed(0)} ms`);
    });
    console.log(`u2netp mean |Δ| ${(sum / n).toExponential(2)}`);
    expect(worst).toBeLessThan(0.02);
    expect(sum / n).toBeLessThan(1e-3);
  }, 120_000);
});
