// Loom Infer — the conv pool: a model's dense convolutions split across workers by output channel (background removal
// on the CPU: U²-Netp and MODNet). Message passing only — the app is not cross-origin isolated (GitHub Pages cannot send
// COOP / COEP), so there is no SharedArrayBuffer: every worker holds its own slice of every conv's weights (the model
// file is parsed once in each), the layer's input goes to each worker as a copy, and each sends back its channels.
// Every output channel is the same sum as on one thread, so the result is identical; only the time changes.
//
// Worker count: one per spare core (navigator.hardwareConcurrency − 1), at most 8 on a PC; 2–4 on a phone (memory, heat,
// and the copies grow with the count). Small layers stay on the calling thread (a round trip costs more than they do).

import { convNode, deformNode, headsOf, rowsOf, winAttn, type GNode, type GraphModel, type Tensor, type WinAttnArgs } from "./graph";
import type { ConvLayer } from "./model";
import type { T } from "./cpu";

export type ConvPoolKind = "graph" | "u2";
/** What a pool worker accepts (convWorker.ts). */
export type ConvWorkerMsg =
  | { kind: "init"; model: ConvPoolKind; bytes: ArrayBuffer; part: number; parts: number }
  | { kind: "conv"; id: number; layer: number; s: number[]; d: Float32Array; pad?: number[]; crop?: [number, number]; job?: GraphJob };
/** BiRefNet's ops in the pool: a deformable conv by output rows (the whole input, the band's offsets and mask), the
 *  window attention by heads (the heads' q, k, v channels) */
export type GraphJob = { op: "deform"; y0: number; off: Tensor; mask: Tensor } | { op: "heads"; h0: number; h1: number };
export type ConvWorkerReply = { id: number; s?: number[]; d?: Float32Array; error?: string };

interface PoolWorker {
  postMessage(m: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

const onPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent ?? "");

/** Workers for a device: cores − 1, a PC at most 8, a phone 2–4; 0 (no pool) on a single core. */
export function convPoolSize(cores = 4, phone = false): number {
  const n = cores - 1;
  if (phone) return Math.max(2, Math.min(4, n));
  return n < 2 ? 0 : Math.min(8, n);
}

/** Output channel range of part `i` of `n` (blocks of 8, so the WebAssembly kernels' 4- and 8-channel blocks stay whole). */
export function partRange(cout: number, i: number, n: number): [number, number] {
  const step = Math.ceil(cout / n / 8) * 8;
  return [Math.min(cout, i * step), Math.min(cout, (i + 1) * step)];
}

/** Below this many multiply-adds a conv stays on the calling thread (U²-Netp; MODNet: its many small 1×1 convs cost
 *  less than the round trip — measured on the phone setting, 4 workers at 480 × 320). */
export const POOL_MIN_MACS = 4e6;
export const GRAPH_MIN_MACS = 3e7;

export class ConvPool {
  private ws: PoolWorker[] = [];
  private seq = 0;
  private wait = new Map<number, { ok: (r: ConvWorkerReply) => void; fail: (e: Error) => void }>();
  broken = false;

  constructor(
    make: () => PoolWorker,
    readonly kind: ConvPoolKind,
    bytes: ArrayBuffer,
    readonly size: number,
  ) {
    for (let i = 0; i < size; i++) {
      const w = make();
      w.onmessage = (e: MessageEvent<ConvWorkerReply>) => {
        const p = this.wait.get(e.data.id);
        if (!p) return;
        this.wait.delete(e.data.id);
        if (e.data.error) p.fail(new Error(e.data.error));
        else p.ok(e.data);
      };
      w.onerror = () => {
        this.broken = true;
        for (const p of this.wait.values()) p.fail(new Error("conv pool worker failed"));
        this.wait.clear();
      };
      w.postMessage({ kind: "init", model: kind, bytes: bytes.slice(0), part: i, parts: size } satisfies ConvWorkerMsg);
      this.ws.push(w);
    }
  }

  /** Layer `layer` on input (s, d): each worker its channel range; the parts joined in channel order (NCHW). */
  private async run(layer: number, cout: number, s: number[], d: Float32Array): Promise<Tensor> {
    const parts: Promise<ConvWorkerReply>[] = [];
    for (let i = 0; i < this.size; i++) {
      const [a, b] = partRange(cout, i, this.size);
      if (a >= b) break;
      const id = ++this.seq;
      parts.push(new Promise((ok, fail) => this.wait.set(id, { ok, fail })));
      this.ws[i].postMessage({ kind: "conv", id, layer, s, d } satisfies ConvWorkerMsg);
    }
    const rs = await Promise.all(parts);
    const [, , h, w] = rs[0].s!;
    const out = new Float32Array(rs.reduce((n, r) => n + r.d!.length, 0));
    let o = 0;
    for (const r of rs) out.set(r.d!, o), (o += r.d!.length);
    return { s: [1, out.length / (h * w), h, w], d: out };
  }

  /**
   * A graph conv (graph.ts runGraphAsync), or null to run it on the calling thread. Few output channels on a large
   * picture (MODNet's high-resolution layers: 16–32 channels at 384 × 576) are split by output rows instead — each
   * worker gets only its band of the input (plus the kernel's reach), not the whole input.
   */
  graphConv(m: GraphModel, i: number, n: GNode, x: Tensor, ins?: Tensor[]): Promise<Tensor> | null {
    if (this.broken) return null;
    if (n.op === "deform_conv") {
      if (!ins) return null;
      const [cout, cin, kh, kw] = m.w.get(n.w!)!.s, [, , OH, OW] = ins[1].s;
      return OH * OW * cout * cin * kh * kw < GRAPH_MIN_MACS || OH < 2 * this.size ? null : this.deform(m, i, n, ins);
    }
    if (n.op === "win_attn") return ins ? this.heads(i, n, ins[0]) : null;
    if (n.op !== "conv") return null;
    const w = m.w.get(n.w!)!;
    const [cout, cpg, kh, kw] = w.s;
    const a = n.a ?? {};
    const [, , H, W] = x.s;
    if (H * W * cout * cpg * kh * kw < GRAPH_MIN_MACS) return null;
    if (cout >= 16 * this.size) return this.run(i, cout, x.s, x.d);
    // by rows
    const [sh, sw] = a.stride ?? [1, 1], [dh, dw] = a.dil ?? [1, 1];
    const pt = a.pad[0], pl = a.pad.length === 4 ? a.pad[2] : (a.pad[1] ?? a.pad[0]);
    const pb = a.pad.length === 4 ? a.pad[1] : pt, pr = a.pad.length === 4 ? a.pad[3] : pl;
    const OH = Math.floor((H + pt + pb - dh * (kh - 1) - 1) / sh) + 1, OW = Math.floor((W + pl + pr - dw * (kw - 1) - 1) / sw) + 1;
    if (OH < 2 * this.size) return cout >= 16 ? this.run(i, cout, x.s, x.d) : null;
    return this.rows(i, x, cout, OH, OW, { sh, dh, kh, pt, pb, pl, pr });
  }

  /** A deformable conv split by output rows: every worker gets the whole input and its band's offsets and mask. */
  private deform(m: GraphModel, layer: number, n: GNode, [x, off, mask]: Tensor[]): Promise<Tensor> {
    const cout = m.w.get(n.w!)!.s[0], [, , OH, OW] = off.s;
    return this.bands(OH, (y0, y1) => ({ kind: "conv", id: 0, layer, s: x.s, d: x.d, job: { op: "deform", y0, off: rowsOf(off, y0, y1), mask: rowsOf(mask, y0, y1) } }), cout, OW);
  }

  /** Window attention split by heads: each worker gets its heads' q, k, v channels and sends back their outputs. */
  private async heads(layer: number, n: GNode, qkv: Tensor): Promise<Tensor> {
    const a = n.a as WinAttnArgs, per = Math.ceil(a.heads / this.size);
    const jobs: Promise<ConvWorkerReply>[] = [];
    for (let p = 0; p * per < a.heads; p++) {
      const h0 = p * per, h1 = Math.min(a.heads, h0 + per), t = headsOf(qkv, a.heads, h0, h1);
      const id = ++this.seq;
      jobs.push(new Promise((ok, fail) => this.wait.set(id, { ok, fail })));
      this.ws[p].postMessage({ kind: "conv", id, layer, s: t.s, d: t.d, job: { op: "heads", h0, h1 } } satisfies ConvWorkerMsg, [t.d.buffer]);
    }
    const rs = await Promise.all(jobs);
    const out = new Float32Array(rs.reduce((q, r) => q + r.d!.length, 0));
    let o = 0;
    for (const r of rs) out.set(r.d!, o), (o += r.d!.length);
    return { s: [1, qkv.s[1] / 3, qkv.s[2], qkv.s[3]], d: out };
  }

  /** Output rows split in bands, one per worker; the bands joined in row order (NCHW). */
  private async bands(OH: number, msg: (y0: number, y1: number) => ConvWorkerMsg & { kind: "conv" }, cout: number, OW: number): Promise<Tensor> {
    const band = Math.ceil(OH / this.size);
    const jobs: Promise<ConvWorkerReply>[] = [];
    const at: [number, number][] = [];
    for (let p = 0; p < this.size; p++) {
      const y0 = p * band, y1 = Math.min(OH, y0 + band);
      if (y0 >= y1) break;
      const id = ++this.seq;
      jobs.push(new Promise((ok, fail) => this.wait.set(id, { ok, fail })));
      this.ws[p].postMessage({ ...msg(y0, y1), id });
      at.push([y0, y1]);
    }
    const rs = await Promise.all(jobs);
    const out = new Float32Array(cout * OH * OW);
    rs.forEach((r, j) => {
      const [y0, y1] = at[j], bh = y1 - y0;
      for (let c = 0; c < cout; c++) out.set(r.d!.subarray(c * bh * OW, (c + 1) * bh * OW), (c * OH + y0) * OW);
    });
    return { s: [1, cout, OH, OW], d: out };
  }

  private async rows(layer: number, x: Tensor, cout: number, OH: number, OW: number, k: { sh: number; dh: number; kh: number; pt: number; pb: number; pl: number; pr: number }): Promise<Tensor> {
    const [, C, H, W] = x.s;
    const band = Math.ceil(OH / this.size);
    const jobs: Promise<ConvWorkerReply>[] = [];
    const at: [number, number][] = [];
    for (let p = 0; p < this.size; p++) {
      const y0 = p * band, y1 = Math.min(OH, y0 + band);
      if (y0 >= y1) break;
      const r0 = y0 * k.sh - k.pt, r1 = (y1 - 1) * k.sh - k.pt + (k.kh - 1) * k.dh + 1;
      const top = Math.max(0, r0), bot = Math.min(H, r1);
      const rows = Math.max(0, bot - top);
      const d = new Float32Array(C * rows * W);
      for (let c = 0; c < C; c++) d.set(x.d.subarray((c * H + top) * W, (c * H + top + rows) * W), c * rows * W);
      const id = ++this.seq;
      jobs.push(new Promise((ok, fail) => this.wait.set(id, { ok, fail })));
      this.ws[p].postMessage({ kind: "conv", id, layer, s: [1, C, rows, W], d, pad: [top - r0, r1 - bot, k.pl, k.pr] } satisfies ConvWorkerMsg, [d.buffer]);
      at.push([y0, y1]);
    }
    const rs = await Promise.all(jobs);
    const out = new Float32Array(cout * OH * OW);
    rs.forEach((r, j) => {
      const [y0, y1] = at[j], bh = y1 - y0;
      for (let c = 0; c < cout; c++) out.set(r.d!.subarray(c * bh * OW, (c + 1) * bh * OW), (c * OH + y0) * OW);
    });
    return { s: [1, cout, OH, OW], d: out };
  }

  /**
   * A U²-Netp conv (cpu.ts runCpuAsync), or null to run it on the calling thread. Split by output rows: each worker
   * gets its band of the input with the kernel's reach above and below (zero rows outside the picture), runs the
   * layer as it is (its symmetric padding then only adds rows that are dropped) and sends back its band's rows.
   */
  u2Conv(i: number, L: ConvLayer, x: T): Promise<T> | null {
    if (this.broken) return null;
    const reach = (L.dil * (L.k - 1)) / 2;
    // ("same" convs only — every U²-Netp conv; a band must be well taller than the reach)
    if (L.pad !== reach || x.h * x.w * L.cout * L.cin * L.k * L.k < POOL_MIN_MACS || x.h < this.size * Math.max(8, 4 * reach)) return null;
    return this.u2Rows(i, L, x, reach);
  }

  private async u2Rows(layer: number, L: ConvLayer, x: T, p: number): Promise<T> {
    const { c: C, h: H, w: W } = x;
    const band = Math.ceil(H / this.size);
    const jobs: Promise<ConvWorkerReply>[] = [];
    const at: [number, number][] = [];
    for (let k = 0; k < this.size; k++) {
      const y0 = k * band, y1 = Math.min(H, y0 + band);
      if (y0 >= y1) break;
      const r0 = y0 - p, rows = y1 - y0 + 2 * p;
      const d = new Float32Array(C * rows * W);
      const a = Math.max(0, r0), b = Math.min(H, r0 + rows);
      for (let c = 0; c < C; c++) d.set(x.d.subarray((c * H + a) * W, (c * H + b) * W), (c * rows + (a - r0)) * W);
      const id = ++this.seq;
      jobs.push(new Promise((ok, fail) => this.wait.set(id, { ok, fail })));
      this.ws[k].postMessage({ kind: "conv", id, layer, s: [1, C, rows, W], d, crop: [p, y1 - y0] } satisfies ConvWorkerMsg, [d.buffer]);
      at.push([y0, y1]);
    }
    const rs = await Promise.all(jobs);
    const out = new Float32Array(L.cout * H * W);
    rs.forEach((r, j) => {
      const [y0, y1] = at[j], bh = y1 - y0;
      for (let c = 0; c < L.cout; c++) out.set(r.d!.subarray(c * bh * W, (c + 1) * bh * W), (c * H + y0) * W);
    });
    return { c: L.cout, h: H, w: W, d: out };
  }

  terminate() {
    for (const w of this.ws) w.terminate();
    this.ws = [];
    this.broken = true;
  }
}

/** What a pool worker computes for a graph model's message (convWorker.ts; the tests' in-process workers). */
export function graphJob(g: GraphModel, m: ConvWorkerMsg & { kind: "conv" }, part: number, parts: number): Tensor {
  const n = g.meta.nodes[m.layer];
  const x = { s: m.s, d: m.d };
  if (m.job?.op === "deform") return deformNode(g, n, x, m.job.off, m.job.mask, m.job.y0);
  if (m.job?.op === "heads") {
    const a = n.a as WinAttnArgs;
    return winAttn(x, g.w.get((n.in[1] as string).slice(1))!.d, g.w.get((n.in[2] as string).slice(1))!.d, a, m.job.h0, m.job.h1 - m.job.h0);
  }
  // a band of rows (all channels, the band's own padding) or this worker's channels (the whole input)
  return m.pad ? convNode(g, { ...n, a: { ...n.a, pad: m.pad } }, x) : convNode(g, n, x, partRange(g.w.get(n.w!)!.s[0], part, parts));
}

// ---------- pools per model (made where a worker script can be named) ----------

let maker: ((kind: ConvPoolKind, bytes: ArrayBuffer) => ConvPool | null) | null = null;
const pools = new Map<string, ConvPool>();

/** The image worker (and tests) say how pool workers are made; without it there is no pool (one thread). */
export function setConvPoolMaker(f: typeof maker) {
  maker = f;
}

/** The pool for a model (made on first use), or null when there is none (one core, no workers, tests). */
export function convPool(key: string, kind: ConvPoolKind, bytes: () => ArrayBuffer | null): ConvPool | null {
  const have = pools.get(key);
  if (have && !have.broken) return have;
  if (!maker) return null;
  const b = bytes();
  if (!b) return null;
  const p = maker(kind, b);
  if (p) pools.set(key, p);
  return p;
}

/** Default maker for a module worker environment (the image worker, the main thread fallback). */
export function defaultConvPoolMaker(): typeof maker {
  if (typeof Worker === "undefined") return null;
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  const size = convPoolSize(nav?.hardwareConcurrency ?? 4, onPhone());
  if (!size) return null;
  return (kind, bytes) => {
    try {
      return new ConvPool(() => new Worker(new URL("./convWorker.ts", import.meta.url), { type: "module" }) as unknown as PoolWorker, kind, bytes, size);
    } catch {
      return null;
    }
  };
}

