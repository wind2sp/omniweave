// Loom Infer — WebAssembly SIMD conv kernels, assembled at run time from the opcodes below (no toolchain, no binary
// blob in the repo: this file IS the source). All exports share one signature (14 × i32):
//
//   conv3(inp, rowStride, plane, cin, w, b, out, outStride, outPlane, H, xBlocks, ocBlocks, dil, relu)
//   conv1(  same; dil ignored )
//   conv3s2(same; stride 2, dil = offset of the odd columns in a row, see below)        — OCR graphs
//   dw<k>_<sy><sx>(inp, row, plane, C, w, b, out, outStride, outPlane, H, xBlocks, -, half, -)
//                                   depthwise k = 3 / 5, stride 1 or 2 per axis          — OCR graphs
//
// All pointers are byte offsets into the module's own memory. The input is already zero-padded by the caller so the
// kernel never bounds-checks: output pixel (y, x) reads padded input (y + ky·dil, x + kx·dil). Each step of the dense
// kernels computes a 4 output channels × 8 pixels block (two f32x4 per channel = 8 accumulators); weights are packed
// per 4-channel block as [ic][ky][kx][4] (see packConvWeights). Loop order is row → 8-pixel block → channel block:
// the input block (cin × 8 px) stays in L1 while every channel block reads it and the weights stay in L2. (With the
// channel blocks outermost, large planes — text detection at 1536 px — were streamed from RAM cout/4 times.) Every
// output is bias + Σ_ic Σ_ky Σ_kx w·x in exactly that order, so the result does not depend on the loop order.
// Rows are processed in 8-pixel blocks; the caller sizes the buffers so the extra columns past the real width are
// harmless.
//
// Stride 2 ("s2"): the caller stores every padded row de-interleaved — even columns first, odd columns from `half`
// floats on — so output pixel x reads column 2x + kx with plain 8-wide vector loads: kx = 0 → even[x], 1 → odd[x],
// 2 → even[x + 1], 3 → odd[x + 1], 4 → even[x + 2]. Output row y starts at padded row 2y (depthwise: row stride sy
// and column stride sx independently — the recognizer has (2, 1) and (1, 2)).
// Depthwise: weights [C][k][k] as stored, one bias per channel, out = bias + Σ_ky Σ_kx w·x (the TS loop's order).

const enc = {
  u32(n: number): number[] {
    const out: number[] = [];
    do {
      let b = n & 0x7f;
      n >>>= 7;
      if (n) b |= 0x80;
      out.push(b);
    } while (n);
    return out;
  },
  i32(n: number): number[] {
    const out: number[] = [];
    for (;;) {
      const b = n & 0x7f;
      n >>= 7;
      if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) {
        out.push(b);
        return out;
      }
      out.push(b | 0x80);
    }
  },
  str(s: string): number[] {
    const b = Array.from(new TextEncoder().encode(s));
    return [...enc.u32(b.length), ...b];
  },
  vec(items: number[][]): number[] {
    return [...enc.u32(items.length), ...items.flat()];
  },
  section(id: number, body: number[]): number[] {
    return [id, ...enc.u32(body.length), ...body];
  },
};

const I32 = 0x7f, V128 = 0x7b;

/** Tiny instruction builder (just what the kernel needs). */
class Code {
  b: number[] = [];
  get = (i: number) => this.op(0x20, ...enc.u32(i));
  set = (i: number) => this.op(0x21, ...enc.u32(i));
  tee = (i: number) => this.op(0x22, ...enc.u32(i));
  i32 = (v: number) => this.op(0x41, ...enc.i32(v));
  add = () => this.op(0x6a);
  mul = () => this.op(0x6c);
  shl = () => this.op(0x74);
  ltu = () => this.op(0x49);
  eqz = () => this.op(0x45);
  loop = () => this.op(0x03, 0x40);
  block = () => this.op(0x02, 0x40);
  if_ = () => this.op(0x04, 0x40);
  end = () => this.op(0x0b);
  brIf = (d: number) => this.op(0x0d, ...enc.u32(d));
  simd = (sub: number, ...imm: number[]) => this.op(0xfd, ...enc.u32(sub), ...imm);
  vload = (off = 0) => this.simd(0x00, 4, ...enc.u32(off));
  vstore = (off = 0) => this.simd(0x0b, 4, ...enc.u32(off));
  splat32 = (off = 0) => this.simd(0x09, 2, ...enc.u32(off));
  fadd = () => this.simd(0xe4);
  fmul = () => this.simd(0xe6);
  fmax = () => this.simd(0xe9);
  vzero = () => this.simd(0x0c, ...new Array(16).fill(0));
  op(...x: number[]) {
    this.b.push(...x);
    return this;
  }
  /** local[i] += local[a] * local[b] (f32x4) */
  madd(i: number, a: number, b: number) {
    return this.get(i).get(a).get(b).fmul().fadd().set(i);
  }
  /** local[i] += n (i32) */
  inc(i: number, n: number) {
    return this.get(i).i32(n).add().set(i);
  }
  /** local[i] += local[j] (i32) */
  incBy(i: number, j: number) {
    return this.get(i).get(j).add().set(i);
  }
}

// params
const P_INP = 0, P_ROW = 1, P_PLANE = 2, P_CIN = 3, P_W = 4, P_B = 5, P_OUT = 6, P_OSTR = 7, P_OPLANE = 8, P_H = 9, P_XB = 10, P_OCB = 11, P_DIL = 12, P_RELU = 13;
const NPARAM = 14;
// i32 locals
const L_OB = 14, L_Y = 15, L_XB = 16, L_IC = 17, L_KY = 18, L_WP = 19, L_IP = 20, L_RP = 21, L_P = 22, L_TMP = 23, L_ROWD = 24, L_PL4 = 25, L_ROW4 = 26, L_DIL4 = 27, L_OP = 28, L_WBLK = 29;
const NI32 = 16;
// v128 locals
const V_A = 30; // a0..a3 (first 4 pixels, channels 0..3)
const V_C = 34; // c0..c3 (next 4 pixels)
const V_V0 = 38, V_V1 = 39, V_T = 40;
const NV128 = 11;

function finish(c: Code): number[] {
  c.end(); // function end
  const locals = enc.vec([
    [...enc.u32(NI32), I32],
    [...enc.u32(NV128), V128],
  ]);
  const body = [...locals, ...c.b];
  return [...enc.u32(body.length), ...body];
}

/** for (local = 0; local < param; local++) body() — every count here is ≥ 1 */
function loop(c: Code, local: number, limit: number, body: () => void) {
  c.i32(0).set(local);
  c.loop();
  body();
  c.inc(local, 1);
  c.get(local).get(limit).ltu().brIf(0);
  c.end();
}

function kernel(k: 1 | 3, s2 = false): number[] {
  const c = new Code();
  // byte strides
  c.get(P_PLANE).i32(2).shl().set(L_PL4);
  if (s2) {
    c.get(P_ROW).i32(3).shl().set(L_ROW4); // one output row = two padded rows
    c.get(P_ROW).i32(2).shl().set(L_ROWD); // ky step = one padded row
  } else {
    c.get(P_ROW).i32(2).shl().set(L_ROW4);
    c.get(P_DIL).get(P_ROW).mul().i32(2).shl().set(L_ROWD);
  }
  c.get(P_DIL).i32(2).shl().set(L_DIL4); // s2: bytes to the odd half of a row
  c.get(P_CIN).i32(k * k * 16).mul().set(L_WBLK); // bytes of one 4-channel weight block
  loop(c, L_Y, P_H, () =>
    loop(c, L_XB, P_XB, () =>
      loop(c, L_OB, P_OCB, () => {
        // bias
        for (let j = 0; j < 4; j++) {
          c.get(P_B).get(L_OB).i32(4).shl().add().splat32(j * 4).tee(V_A + j).set(V_C + j);
        }
        c.get(P_W).get(L_OB).get(L_WBLK).mul().add().set(L_WP);
        // ip = inp + y·rowStep + xb·32
        c.get(P_INP).get(L_Y).get(L_ROW4).mul().add().get(L_XB).i32(5).shl().add().set(L_IP);
        loop(c, L_IC, P_CIN, () => {
          const tap = () => {
            c.get(L_P).vload(0).set(V_V0);
            c.get(L_P).vload(16).set(V_V1);
            for (let j = 0; j < 4; j++) {
              c.get(L_WP).splat32(j * 4).set(V_T);
              c.madd(V_A + j, V_V0, V_T);
              c.madd(V_C + j, V_V1, V_T);
            }
            c.inc(L_WP, 16);
          };
          if (k === 1) {
            c.get(L_IP).set(L_P);
            tap();
          } else {
            c.get(L_IP).set(L_RP);
            c.i32(0).set(L_KY);
            c.loop(); // KY
            {
              c.get(L_RP).set(L_P);
              tap();
              if (s2) c.get(L_RP).get(L_DIL4).add().set(L_P);
              else c.incBy(L_P, L_DIL4);
              tap();
              if (s2) c.get(L_RP).i32(4).add().set(L_P);
              else c.incBy(L_P, L_DIL4);
              tap();
              c.incBy(L_RP, L_ROWD);
              c.inc(L_KY, 1);
              c.get(L_KY).i32(3).ltu().brIf(0);
            }
            c.end();
          }
          c.incBy(L_IP, L_PL4);
        });
        // relu
        c.get(P_RELU).if_();
        for (let j = 0; j < 4; j++) {
          c.get(V_A + j).vzero().fmax().set(V_A + j);
          c.get(V_C + j).vzero().fmax().set(V_C + j);
        }
        c.end();
        // store: out + ((ob*4 + j)*outPlane + y*outStride + xb*8)*4
        c.get(L_OB).i32(2).shl().get(P_OPLANE).mul().get(L_Y).get(P_OSTR).mul().add().get(L_XB).i32(3).shl().add().i32(2).shl().get(P_OUT).add().set(L_OP);
        for (let j = 0; j < 4; j++) {
          c.get(L_OP).get(V_A + j).vstore(0);
          c.get(L_OP).get(V_C + j).vstore(16);
          if (j < 3) c.get(L_OP).get(P_OPLANE).i32(2).shl().add().set(L_OP);
        }
      }),
    ),
  );
  return finish(c);
}

/** Depthwise k×k (one input channel per output channel), stride 1 or 2 per axis, taps fully unrolled. */
function dwKernel(k: number, sy: number, sx: number): number[] {
  const c = new Code();
  const s2 = sx === 2;
  c.get(P_PLANE).i32(2).shl().set(L_PL4);
  c.get(P_ROW).i32(sy === 2 ? 3 : 2).shl().set(L_ROW4); // output row step
  c.get(P_ROW).i32(2).shl().set(L_ROWD); // ky step
  c.get(P_DIL).i32(2).shl().set(L_DIL4); // s2: odd half
  loop(c, L_OB, P_CIN, () => {
    c.get(P_INP).get(L_OB).get(L_PL4).mul().add().set(L_IC); // channel input
    c.get(P_W).get(L_OB).i32(k * k * 4).mul().add().set(L_WP);
    loop(c, L_Y, P_H, () => {
      c.get(L_IC).get(L_Y).get(L_ROW4).mul().add().set(L_RP);
      loop(c, L_XB, P_XB, () => {
        c.get(P_B).get(L_OB).i32(2).shl().add().splat32(0).tee(V_A).set(V_C);
        c.get(L_RP).get(L_XB).i32(5).shl().add().set(L_P);
        for (let ky = 0; ky < k; ky++) {
          if (s2) c.get(L_P).get(L_DIL4).add().set(L_TMP);
          for (let kx = 0; kx < k; kx++) {
            const base = s2 && kx & 1 ? L_TMP : L_P, off = (s2 ? kx >> 1 : kx) * 4;
            c.get(L_WP).splat32((ky * k + kx) * 4).set(V_T);
            c.get(base).vload(off).set(V_V0);
            c.madd(V_A, V_V0, V_T);
            c.get(base).vload(off + 16).set(V_V0);
            c.madd(V_C, V_V0, V_T);
          }
          if (ky < k - 1) c.incBy(L_P, L_ROWD);
        }
        c.get(L_OB).get(P_OPLANE).mul().get(L_Y).get(P_OSTR).mul().add().get(L_XB).i32(3).shl().add().i32(2).shl().get(P_OUT).add().set(L_OP);
        c.get(L_OP).get(V_A).vstore(0);
        c.get(L_OP).get(V_C).vstore(16);
      });
    });
  });
  return finish(c);
}

// depthwise exports: "dw<k>_<sy><sx>" (dw3_11, dw5_21, …)
const DW: [number, number, number][] = [3, 5].flatMap((k) => [1, 2].flatMap((sy) => [1, 2].map((sx) => [k, sy, sx] as [number, number, number])));
const EXPORTS = ["conv3", "conv1", "conv3s2", ...DW.map(([k, sy, sx]) => `dw${k}_${sy}${sx}`)];

/** The module bytes (exported for tests). */
export function convModuleBytes(): Uint8Array {
  const ftype = [0x60, ...enc.u32(NPARAM), ...new Array(NPARAM).fill(I32), 0];
  const bytes = [
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...enc.section(1, enc.vec([ftype])),
    ...enc.section(3, enc.vec(EXPORTS.map(() => [0]))),
    ...enc.section(5, enc.vec([[0x00, ...enc.u32(1)]])),
    ...enc.section(7, enc.vec([[...enc.str("mem"), 0x02, 0], ...EXPORTS.map((n, i) => [...enc.str(n), 0x00, i])])),
    ...enc.section(10, enc.vec([kernel(3), kernel(1), kernel(3, true), ...DW.map(([k, sy, sx]) => dwKernel(k, sy, sx))])),
  ];
  return new Uint8Array(bytes);
}

type KernelFn = (...a: number[]) => void;
export interface ConvKernel {
  mem: WebAssembly.Memory;
  conv3: KernelFn;
  conv1: KernelFn;
}
/** The OCR graph executor's own instance also uses the strided and depthwise kernels (dw: by "k_sysx", e.g. "5_21"). */
export interface GraphKernel extends ConvKernel {
  conv3s2: KernelFn;
  dw: Record<string, KernelFn>;
}

let cached: ConvKernel | null | undefined;

/** Compile the kernel once; null where WebAssembly SIMD is unavailable (the TS kernels take over). */
export function convKernel(): ConvKernel | null {
  if (cached !== undefined) return cached;
  try {
    if (typeof WebAssembly === "undefined") return (cached = null);
    const mod = new WebAssembly.Module(convModuleBytes() as BufferSource);
    const inst = new WebAssembly.Instance(mod, {});
    const e = inst.exports as unknown as ConvKernel;
    cached = { mem: e.mem, conv3: e.conv3, conv1: e.conv1 };
  } catch {
    cached = null;
  }
  return cached;
}

/** Repack [cout][cin][k][k] weights into 4-channel blocks [ob][ic][ky][kx][4] (cout padded to a multiple of 4). */
export function packConvWeights(w: Float32Array, b: Float32Array, cout: number, cin: number, k: number): { w: Float32Array; b: Float32Array; ocb: number } {
  const ocb = Math.ceil(cout / 4), kk = k * k;
  const out = new Float32Array(ocb * cin * kk * 4);
  const bias = new Float32Array(ocb * 4);
  for (let o = 0; o < cout; o++) {
    bias[o] = b[o];
    const blk = o >> 2, j = o & 3;
    for (let i = 0; i < cin; i++)
      for (let t = 0; t < kk; t++) out[((blk * cin + i) * kk + t) * 4 + j] = w[(o * cin + i) * kk + t];
  }
  return { w: out, b: bias, ocb };
}
