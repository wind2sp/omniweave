// Loom Infer — the static execution plan the WebGPU executor runs (webgpu.ts). Pure, so it is unit-tested in Node:
// tests replay the plan with CPU kernels (`emulatePlan`) using the very same buffer slots, offsets and uniforms, which
// checks buffer reuse / aliasing and the concat-as-copy layout without a GPU.
//
// Every tensor gets a slot (a GPU buffer) chosen by lifetime: a slot is reused once its tensor's last reader ran.
// Concat in CHW is plain appending, so its inputs are copied into the output slot at channel offsets.

import type { ConvLayer, Model } from "./model";

export type Step =
  | { kind: "conv"; layer: number; src: number; dst: number; u: ConvUniforms }
  | { kind: "pool"; src: number; dst: number; u: [c: number, h: number, w: number, oh: number, ow: number] }
  | { kind: "up"; src: number; dst: number; u: [c: number, h: number, w: number, oh: number, ow: number, align: number] }
  | { kind: "add"; a: number; b: number; dst: number; n: number }
  | { kind: "copy"; src: number; dst: number; dstOffset: number; n: number };

/** conv uniforms, in shader order (all u32) */
export type ConvUniforms = [cin: number, cout: number, h: number, w: number, oh: number, ow: number, k: number, pad: number, dil: number, act: number, wOff: number, bOff: number];

export interface GpuPlan {
  /** element count (f32) of every slot */
  slots: number[];
  inputSlot: number;
  outputSlot: number;
  outputLen: number;
  steps: Step[];
  /** all conv weights then biases, f32, at the offsets the conv uniforms name */
  weights: Float32Array;
}

/** act: 0 none, 1 relu, 2 sigmoid */
export function planGpu(model: Model): GpuPlan {
  const { meta } = model;
  const size = (n: string) => meta.tensors[n].reduce((a, b) => a * b, 1);
  const slots: number[] = [];
  const free: number[] = [];
  const slotOf = new Map<string, number>();
  const alloc = (n: string) => {
    const need = size(n);
    // best fit among free slots, else a new slot
    let best = -1;
    for (let i = 0; i < free.length; i++) if (slots[free[i]] >= need && (best < 0 || slots[free[i]] < slots[free[best]])) best = i;
    let s: number;
    if (best >= 0) s = free.splice(best, 1)[0];
    else if (free.length) {
      // grow the largest free slot instead of adding another buffer
      let bi = 0;
      for (let i = 1; i < free.length; i++) if (slots[free[i]] > slots[free[bi]]) bi = i;
      s = free.splice(bi, 1)[0];
      slots[s] = need;
    } else {
      s = slots.length;
      slots.push(need);
    }
    slotOf.set(n, s);
    return s;
  };
  // weights blob
  let total = 0;
  for (const L of model.layers) if (L.op === "conv") total += L.weight.length + L.bias.length;
  const weights = new Float32Array(total);
  const offs = new Map<ConvLayer, [number, number]>();
  let o = 0;
  for (const L of model.layers)
    if (L.op === "conv") {
      weights.set(L.weight, o);
      const wOff = o;
      o += L.weight.length;
      weights.set(L.bias, o);
      offs.set(L, [wOff, o]);
      o += L.bias.length;
    }

  const inputSlot = alloc("x");
  const steps: Step[] = [];
  model.layers.forEach((L, i) => {
    const ins = Array.isArray(L.in) ? L.in : [L.in];
    const dst = alloc(L.out); // allocated before freeing inputs: a step never reads and writes one buffer
    const [c, h, w] = meta.tensors[L.out];
    if (L.op === "conv") {
      const [ic, ih, iw] = meta.tensors[L.in];
      const [wOff, bOff] = offs.get(L)!;
      steps.push({ kind: "conv", layer: i, src: slotOf.get(L.in)!, dst, u: [ic, c, ih, iw, h, w, L.k, L.pad, L.dil, L.sigmoid ? 2 : L.relu ? 1 : 0, wOff, bOff] });
    } else if (L.op === "pool") {
      const [ic, ih, iw] = meta.tensors[L.in];
      steps.push({ kind: "pool", src: slotOf.get(L.in)!, dst, u: [ic, ih, iw, h, w] });
    } else if (L.op === "up") {
      const [ic, ih, iw] = meta.tensors[L.in];
      steps.push({ kind: "up", src: slotOf.get(L.in)!, dst, u: [ic, ih, iw, h, w, L.align ? 1 : 0] });
    } else if (L.op === "add") {
      steps.push({ kind: "add", a: slotOf.get(L.in[0])!, b: slotOf.get(L.in[1])!, dst, n: c * h * w });
    } else {
      let off = 0;
      for (const x of L.in) {
        const n = size(x);
        steps.push({ kind: "copy", src: slotOf.get(x)!, dst, dstOffset: off, n });
        off += n;
      }
    }
    for (const x of new Set(ins)) if (model.lastUse.get(x) === i && x !== "x") free.push(slotOf.get(x)!);
  });
  const outputSlot = slotOf.get(meta.output)!;
  return { slots, inputSlot, outputSlot, outputLen: size(meta.output), steps, weights };
}
