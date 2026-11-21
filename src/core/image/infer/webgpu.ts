// Loom Infer — WebGPU executor. Runs the static plan from gpuPlan.ts: one storage buffer per slot, all weights in one
// buffer, one compute pass per step (copies for concat). Built once per device and reused; a run uploads the input,
// records every step into one command buffer and reads the output back.
//
// The plan itself is unit-tested in Node (tests/infer: replayed with CPU kernels). The shaders below only run where
// WebGPU exists (WebView2 / Chromium); `gpuAvailable()` gates it and any failure falls back to the CPU executor.

import type { Model } from "./model";
import { planGpu, type GpuPlan } from "./gpuPlan";

/* eslint-disable @typescript-eslint/no-explicit-any */
type GPUDev = any;

const CONV = /* wgsl */ `
struct U { cin:u32, cout:u32, h:u32, w:u32, oh:u32, ow:u32, k:u32, pad:u32, dil:u32, act:u32, wOff:u32, bOff:u32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read> wts: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
// one invocation = one pixel × 4 output channels
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = g.x; let y = g.y; let ob = g.z * 4u;
  if (x >= u.ow || y >= u.oh || ob >= u.cout) { return; }
  let kk = u.k * u.k;
  var acc = vec4<f32>(0.0);
  for (var j = 0u; j < 4u; j++) { if (ob + j < u.cout) { acc[j] = wts[u.bOff + ob + j]; } }
  let plane = u.h * u.w;
  let wstride = u.cin * kk;
  for (var i = 0u; i < u.cin; i++) {
    for (var ky = 0u; ky < u.k; ky++) {
      let iy = i32(y + ky * u.dil) - i32(u.pad);
      if (iy < 0 || iy >= i32(u.h)) { continue; }
      for (var kx = 0u; kx < u.k; kx++) {
        let ix = i32(x + kx * u.dil) - i32(u.pad);
        if (ix < 0 || ix >= i32(u.w)) { continue; }
        let v = src[i * plane + u32(iy) * u.w + u32(ix)];
        let t = (i * u.k + ky) * u.k + kx;
        let base = u.wOff + ob * wstride + t;
        acc[0] += v * wts[base];
        if (ob + 1u < u.cout) { acc[1] += v * wts[base + wstride]; }
        if (ob + 2u < u.cout) { acc[2] += v * wts[base + 2u * wstride]; }
        if (ob + 3u < u.cout) { acc[3] += v * wts[base + 3u * wstride]; }
      }
    }
  }
  if (u.act == 1u) { acc = max(acc, vec4<f32>(0.0)); }
  if (u.act == 2u) { acc = 1.0 / (1.0 + exp(-acc)); }
  let op = u.oh * u.ow;
  for (var j = 0u; j < 4u; j++) { if (ob + j < u.cout) { dst[(ob + j) * op + y * u.ow + x] = acc[j]; } }
}`;

const POOL = /* wgsl */ `
struct U { c:u32, h:u32, w:u32, oh:u32, ow:u32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = g.x; let y = g.y; let c = g.z;
  if (x >= u.ow || y >= u.oh || c >= u.c) { return; }
  var m = -3.0e38;
  for (var yy = y * 2u; yy < min(u.h, y * 2u + 2u); yy++) {
    for (var xx = x * 2u; xx < min(u.w, x * 2u + 2u); xx++) { m = max(m, src[(c * u.h + yy) * u.w + xx]); }
  }
  dst[(c * u.oh + y) * u.ow + x] = m;
}`;

const UP = /* wgsl */ `
struct U { c:u32, h:u32, w:u32, oh:u32, ow:u32, align:u32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
fn srcPos(o: u32, n: u32, inN: u32) -> f32 {
  var s: f32;
  if (u.align == 1u) { s = select(0.0, f32(o) * f32(inN - 1u) / f32(n - 1u), n > 1u); }
  else { s = (f32(o) + 0.5) * f32(inN) / f32(n) - 0.5; }
  return clamp(s, 0.0, f32(inN - 1u));
}
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let x = g.x; let y = g.y; let c = g.z;
  if (x >= u.ow || y >= u.oh || c >= u.c) { return; }
  let sy = srcPos(y, u.oh, u.h); let sx = srcPos(x, u.ow, u.w);
  let y0 = u32(floor(sy)); let x0 = u32(floor(sx));
  let y1 = min(u.h - 1u, y0 + 1u); let x1 = min(u.w - 1u, x0 + 1u);
  let fy = sy - f32(y0); let fx = sx - f32(x0);
  let b = c * u.h * u.w;
  let top = mix(src[b + y0 * u.w + x0], src[b + y0 * u.w + x1], fx);
  let bot = mix(src[b + y1 * u.w + x0], src[b + y1 * u.w + x1], fx);
  dst[(c * u.oh + y) * u.ow + x] = mix(top, bot, fy);
}`;

const ADD = /* wgsl */ `
struct U { n:u32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> a: array<f32>;
@group(0) @binding(2) var<storage, read> b: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x + g.y * 65535u * 256u;
  if (i >= u.n) { return; }
  dst[i] = a[i] + b[i];
}`;

export function gpuAvailable(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).gpu;
}

const STORAGE = 0x80, COPY_SRC = 0x04, COPY_DST = 0x08, UNIFORM = 0x40, MAP_READ = 0x01;

export class GpuRunner {
  /** the device was lost (driver reset, GPU removed, sleep): the runner is dead, callers fall back to the CPU */
  lost = false;
  /** runs are serialized: they share the slot buffers and the one read-back buffer */
  private chain: Promise<unknown> = Promise.resolve();
  private constructor(
    private dev: GPUDev,
    private plan: GpuPlan,
    private bufs: any[],
    private encodeSteps: (enc: any) => void,
    private readBuf: any,
  ) {}

  static async create(model: Model): Promise<GpuRunner | null> {
    if (!gpuAvailable()) return null;
    const adapter = await (navigator as any).gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return null;
    const plan = planGpu(model);
    const maxSlot = Math.max(...plan.slots) * 4;
    const need = Math.max(maxSlot, plan.weights.byteLength);
    // the defaults (128 MiB binding, 256 MiB buffer) cover U²-Netp at 320²; only ask for more when a model needs it
    if (need > adapter.limits.maxStorageBufferBindingSize) return null;
    const dev: GPUDev = await adapter.requestDevice(need > 134217728 ? { requiredLimits: { maxStorageBufferBindingSize: need, maxBufferSize: need } } : undefined);
    // WebGPU reports most failures (shader compile, invalid bind group, out of memory) through error scopes, not
    // exceptions: without them a broken pipeline would silently read back zeros ("no subject")
    dev.pushErrorScope("out-of-memory");
    dev.pushErrorScope("validation");
    const mk = (size: number, usage: number) => dev.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    const bufs = plan.slots.map((n) => mk(n * 4, STORAGE | COPY_SRC | COPY_DST));
    const wbuf = mk(plan.weights.byteLength, STORAGE | COPY_DST);
    dev.queue.writeBuffer(wbuf, 0, plan.weights);
    const pipe = (code: string) => dev.createComputePipeline({ layout: "auto", compute: { module: dev.createShaderModule({ code }), entryPoint: "main" } });
    const P = { conv: pipe(CONV), pool: pipe(POOL), up: pipe(UP), add: pipe(ADD) };
    const uni = (vals: number[]) => {
      const b = mk(Math.max(16, vals.length * 4), UNIFORM | COPY_DST);
      dev.queue.writeBuffer(b, 0, new Uint32Array(vals));
      return b;
    };
    const ent = (binding: number, buffer: any) => ({ binding, resource: { buffer } });
    type Rec = { pipe: any; bg: any; dims: [number, number, number] } | { copy: [number, number, number, number] };
    const recs: Rec[] = plan.steps.map((s) => {
      if (s.kind === "copy") return { copy: [s.src, s.dst, s.dstOffset, s.n] };
      if (s.kind === "conv") {
        const bg = dev.createBindGroup({ layout: P.conv.getBindGroupLayout(0), entries: [ent(0, uni(s.u)), ent(1, bufs[s.src]), ent(2, wbuf), ent(3, bufs[s.dst])] });
        return { pipe: P.conv, bg, dims: [Math.ceil(s.u[5] / 8), Math.ceil(s.u[4] / 8), Math.ceil(s.u[1] / 4)] };
      }
      if (s.kind === "pool" || s.kind === "up") {
        const p = P[s.kind];
        const bg = dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [ent(0, uni(s.u)), ent(1, bufs[s.src]), ent(3, bufs[s.dst])] });
        return { pipe: p, bg, dims: [Math.ceil(s.u[4] / 8), Math.ceil(s.u[3] / 8), s.u[0]] };
      }
      const groups = Math.ceil(s.n / 256);
      const bg = dev.createBindGroup({ layout: P.add.getBindGroupLayout(0), entries: [ent(0, uni([s.n])), ent(1, bufs[s.a]), ent(2, bufs[s.b]), ent(3, bufs[s.dst])] });
      return { pipe: P.add, bg, dims: [Math.min(groups, 65535), Math.ceil(groups / 65535), 1] };
    });
    const encodeSteps = (enc: any) => {
      for (const r of recs) {
        if ("copy" in r) {
          const [src, dst, off, n] = r.copy;
          enc.copyBufferToBuffer(bufs[src], 0, bufs[dst], off * 4, n * 4);
          continue;
        }
        const pass = enc.beginComputePass();
        pass.setPipeline(r.pipe);
        pass.setBindGroup(0, r.bg);
        pass.dispatchWorkgroups(...r.dims);
        pass.end();
      }
    };
    const readBuf = mk(plan.outputLen * 4, MAP_READ | COPY_DST);
    const errs = [await dev.popErrorScope(), await dev.popErrorScope()].filter(Boolean);
    if (errs.length) {
      dev.destroy?.();
      throw new Error("WebGPU: " + errs.map((e: any) => e.message).join("; "));
    }
    const runner = new GpuRunner(dev, plan, bufs, encodeSteps, readBuf);
    dev.lost?.then(() => (runner.lost = true));
    return runner;
  }

  run(input: Float32Array): Promise<Float32Array> {
    const r = this.chain.then(() => this.runNow(input));
    this.chain = r.catch(() => undefined);
    return r;
  }

  private async runNow(input: Float32Array): Promise<Float32Array> {
    const { dev, plan, bufs } = this;
    if (this.lost) throw new Error("WebGPU device lost");
    dev.pushErrorScope("out-of-memory");
    dev.pushErrorScope("validation");
    dev.queue.writeBuffer(bufs[plan.inputSlot], 0, input);
    const enc = dev.createCommandEncoder();
    this.encodeSteps(enc);
    enc.copyBufferToBuffer(bufs[plan.outputSlot], 0, this.readBuf, 0, plan.outputLen * 4);
    dev.queue.submit([enc.finish()]);
    const errs = [await dev.popErrorScope(), await dev.popErrorScope()].filter(Boolean);
    if (errs.length) throw new Error("WebGPU: " + errs.map((e: any) => e.message).join("; "));
    await this.readBuf.mapAsync(1);
    const out = new Float32Array(this.readBuf.getMappedRange().slice(0));
    this.readBuf.unmap();
    if (this.lost) throw new Error("WebGPU device lost");
    // a lost or reset device can read back garbage instead of failing: the fused output is a sigmoid (0..1)
    for (let i = 0; i < out.length; i += 97) if (!(out[i] >= 0 && out[i] <= 1)) throw new Error("WebGPU: invalid output");
    return out;
  }
}
