// Loom Infer — model file ("LWT1") reader. Pure (no DOM): runs in the image worker, the main thread and tests.
//
// Layout (little endian): "LWT1" | u32 jsonLength | json | weight blob. Written once, offline, by
// scripts/convert-u2netp.mjs (BatchNorm already folded into each conv, graph pruned to the fused output).
// Weights are fp16 (w; b stays f32) or int8 (w, with one f32 scale per output channel; b stays f32). Both are expanded to
// f32 at load, so the executors only ever see f32.

export type LayerSpec =
  | { op: "conv"; in: string; out: string; cin: number; cout: number; k: number; pad: number; dil: number; relu: boolean; sigmoid: boolean; w: [number, number]; b: [number, number]; s?: [number, number] }
  | { op: "pool"; in: string; out: string; ceil: boolean }
  | { op: "up"; in: string; out: string; h: number; w: number; align: boolean }
  | { op: "concat"; in: string[]; out: string }
  | { op: "add"; in: string[]; out: string };

export interface ModelMeta {
  model: string;
  input: [number, number, number];
  mean: [number, number, number];
  std: [number, number, number];
  /** f16 = shipped; i8 = evaluated; f32 = dev-only lossless copy */
  dtype: "f16" | "i8" | "f32";
  params: number;
  output: string;
  /** [c, h, w] of every tensor (batch 1) */
  tensors: Record<string, [number, number, number]>;
  layers: LayerSpec[];
}

export interface ConvLayer {
  op: "conv";
  in: string;
  out: string;
  cin: number;
  cout: number;
  k: number;
  pad: number;
  dil: number;
  relu: boolean;
  sigmoid: boolean;
  /** [cout][cin][k][k] */
  weight: Float32Array;
  bias: Float32Array;
}

export type Layer = ConvLayer | Exclude<LayerSpec, { op: "conv" }>;

export interface Model {
  meta: ModelMeta;
  layers: Layer[];
  /** index of the last layer reading each tensor (executors free buffers after it) */
  lastUse: Map<string, number>;
  /** multiply-accumulates of one run (for timing reports) */
  macs: number;
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Parse an LWT1 file. Throws on a wrong magic or a truncated blob. */
export function parseModel(bytes: Uint8Array): Model {
  if (bytes.length < 8 || bytes[0] !== 0x4c || bytes[1] !== 0x57 || bytes[2] !== 0x54 || bytes[3] !== 0x31) throw new Error("LWT1 model expected");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jl = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jl))) as ModelMeta;
  const base = 8 + jl;
  const blob = (o: number, n: number, size: number) => {
    if (base + o + n * size > bytes.length) throw new Error("LWT1 model truncated");
    return base + o;
  };
  const f16 = (o: number, n: number) => {
    const p = blob(o, n, 2);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = halfToFloat(dv.getUint16(p + i * 2, true));
    return a;
  };
  const f32 = (o: number, n: number) => {
    const p = blob(o, n, 4);
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = dv.getFloat32(p + i * 4, true);
    return a;
  };
  let macs = 0;
  const layers: Layer[] = meta.layers.map((L) => {
    if (L.op !== "conv") return L;
    let weight: Float32Array, bias: Float32Array;
    if (meta.dtype === "f16") {
      weight = f16(L.w[0], L.w[1]);
      bias = f32(L.b[0], L.b[1]);
      if (L.s) {
        // per-output-channel scale (weights stored normalised to max |w| = 1)
        const sc = f32(L.s[0], L.s[1]);
        const per = L.cin * L.k * L.k;
        for (let i = 0; i < weight.length; i++) weight[i] *= sc[(i / per) | 0];
      }
    } else if (meta.dtype === "f32") {
      weight = f32(L.w[0], L.w[1]);
      bias = f32(L.b[0], L.b[1]);
    } else {
      const p = blob(L.w[0], L.w[1], 1);
      const sc = f32(L.s![0], L.s![1]);
      const per = L.cin * L.k * L.k;
      weight = new Float32Array(L.w[1]);
      for (let i = 0; i < weight.length; i++) weight[i] = dv.getInt8(p + i) * sc[(i / per) | 0];
      bias = f32(L.b[0], L.b[1]);
    }
    const t = meta.tensors[L.out];
    macs += L.cin * L.cout * L.k * L.k * t[1] * t[2];
    return { op: "conv", in: L.in, out: L.out, cin: L.cin, cout: L.cout, k: L.k, pad: L.pad, dil: L.dil, relu: L.relu, sigmoid: L.sigmoid, weight, bias };
  });
  const lastUse = new Map<string, number>();
  layers.forEach((L, i) => {
    for (const x of Array.isArray(L.in) ? L.in : [L.in]) lastUse.set(x, i);
  });
  return { meta, layers, lastUse, macs };
}
