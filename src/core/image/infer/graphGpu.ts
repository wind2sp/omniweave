// Loom Infer — graph models (OCR detection / recognition) on WebGPU. Walks the same node list as runGraph (graph.ts):
// float tensors live in GPU buffers, small integer tensors (shapes, slice bounds, reshape targets) stay on the CPU and
// are evaluated by graph.ts's own evalNode, so every shape is known while recording. One run = one command buffer:
// every op is one dispatch in one compute pass (WebGPU orders dispatches, so a buffer freed after its last reader is
// reused by a later op in the same pass), parameters go in one storage buffer at 256-byte steps, and only the output
// is read back. Weights are uploaded once per model. Reshape / flatten / squeeze are views of the same buffer.
//
// Same math as the CPU path in f32 (the GPU may fuse multiply-add, so results differ in the last bits — the OCR tests
// compare decoded text, tests/ocr). Any unsupported op or GPU error makes the caller fall back to the CPU executor.

import { evalNode, type GraphModel, type GNode, type Tensor, type Val } from "./graph";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Buf = any;

const HEAD = /* wgsl */ `
@group(0) @binding(0) var<storage, read> P: array<u32>;
fn pf(i: u32) -> f32 { return bitcast<f32>(P[i]); }
fn erf1(x0: f32) -> f32 {
  let x = abs(x0); let t = 1.0 / (1.0 + 0.3275911 * x);
  let y = 1.0 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return select(y, -y, x0 < 0.0);
}
fn act(v: f32, k: u32, a0: f32, a1: f32) -> f32 {
  switch k {
    case 1u: { return max(v, 0.0); }
    case 2u: { if (v <= -3.0) { return 0.0; } if (v >= 3.0) { return v; } return v * (v + 3.0) / 6.0; }
    case 3u: { return v / (1.0 + exp(-v)); }
    case 4u: { return 1.0 / (1.0 + exp(-v)); }
    case 5u: { return clamp(v * a0 + a1, 0.0, 1.0); }
    case 7u: { return clamp(v, 0.0, 6.0); }
    case 8u: { return v * 0.5 * (1.0 + erf1(v * 0.70710678118654752)); }
    default: { return v; }
  }
}
`;
// output position of conv channel oc at (y, x); r > 1: written through a pixel shuffle (depth to space, PyTorch order)
const OUT_INDEX = `fn outIndex(oc: u32, y: u32, x: u32, oh: u32, ow: u32, r: u32) -> u32 {
  if (r <= 1u) { return (oc * oh + y) * ow + x; }
  let rr = r * r; let c = oc / rr; let i = (oc % rr) / r; let j = oc % r;
  return (c * oh * r + y * r + i) * ow * r + x * r + j;
}
`;
const IO1 = `@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(3) var<storage, read_write> O: array<f32>;`;
const IO2 = OUT_INDEX + `@group(0) @binding(1) var<storage, read> A: array<f32>;
@group(0) @binding(2) var<storage, read> B: array<f32>;
@group(0) @binding(3) var<storage, read_write> O: array<f32>;`;
const FLAT = `@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) g: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let i = g.x + g.y * nw.x * 64u;
  if (i >= P[0]) { return; }`;

const SHADERS: Record<string, string> = {
  // P: n cin H W cout oh ow kh kw sh sw pt pl dh dw cpg opg act a0 a1 post p0 p1 xOff wOff bOff hasB
  conv: `${IO2}${FLAT}
  let ow = P[6]; let oh = P[5]; let H = P[2]; let W = P[3]; let kh = P[7]; let kw = P[8]; let cpg = P[15];
  let x = i % ow; let t = i / ow; let y = t % oh; let oc = t / oh;
  let gi = oc / P[16];
  var acc = 0.0;
  if (P[26] == 1u) { acc = B[P[25] + oc]; }
  let y0 = i32(y * P[9]) - i32(P[11]); let x0 = i32(x * P[10]) - i32(P[12]);
  for (var c = 0u; c < cpg; c++) {
    let xb = P[23] + (gi * cpg + c) * H * W;
    let wb = P[24] + (oc * cpg + c) * kh * kw;
    for (var ky = 0u; ky < kh; ky++) {
      let iy = y0 + i32(ky * P[13]);
      if (iy < 0 || iy >= i32(H)) { continue; }
      for (var kx = 0u; kx < kw; kx++) {
        let ix = x0 + i32(kx * P[14]);
        if (ix < 0 || ix >= i32(W)) { continue; }
        acc += B[wb + ky * kw + kx] * A[xb + u32(iy) * W + u32(ix)];
      }
    }
  }
  var v = act(acc, P[17], pf(18), pf(19));
  if (P[17] == 6u && v < 0.0) { v = v * B[P[27] + oc]; }
  if (P[20] == 1u) { v = v * pf(21) + pf(22); }
  O[outIndex(oc, y, x, oh, ow, P[28])] = v;
}`,
  // dense (groups 1), register tile of 4 output channels × 4 pixels of a row: every input value feeds 4 channels and
  // every weight 4 pixels (the one-output kernel above loads 2 values per multiply-add). Same P as conv, n = threads.
  conv4: `${IO2}${FLAT}
  let ow = P[6]; let oh = P[5]; let H = P[2]; let W = P[3]; let kh = P[7]; let kw = P[8]; let cin = P[1]; let cout = P[4];
  let xbs = (ow + 3u) / 4u;
  let xb = i % xbs; let t = i / xbs; let y = t % oh; let oc0 = (t / oh) * 4u;
  let x0 = xb * 4u;
  var acc: array<vec4<f32>, 4>;
  for (var q = 0u; q < 4u; q++) {
    var b = 0.0;
    if (P[26] == 1u && oc0 + q < cout) { b = B[P[25] + oc0 + q]; }
    acc[q] = vec4<f32>(b);
  }
  let iy0 = i32(y * P[9]) - i32(P[11]);
  var ix0 = vec4<i32>(0);
  for (var j = 0u; j < 4u; j++) { ix0[j] = i32((x0 + j) * P[10]) - i32(P[12]); }
  let wk = kh * kw; let wstr = cin * wk;
  var ok = vec4<f32>(0.0);
  for (var q = 0u; q < 4u; q++) { if (oc0 + q < cout) { ok[q] = 1.0; } }
  let wq = vec4<u32>(min(oc0, cout - 1u), min(oc0 + 1u, cout - 1u), min(oc0 + 2u, cout - 1u), min(oc0 + 3u, cout - 1u)) * wstr + vec4<u32>(P[24]);
  for (var c = 0u; c < cin; c++) {
    let xb0 = P[23] + c * H * W;
    for (var ky = 0u; ky < kh; ky++) {
      let iy = iy0 + i32(ky * P[13]);
      if (iy < 0 || iy >= i32(H)) { continue; }
      let row = xb0 + u32(iy) * W;
      for (var kx = 0u; kx < kw; kx++) {
        var v = vec4<f32>(0.0);
        for (var j = 0u; j < 4u; j++) {
          let ix = ix0[j] + i32(kx * P[14]);
          if (ix >= 0 && ix < i32(W)) { v[j] = A[row + u32(ix)]; }
        }
        let wo = c * wk + ky * kw + kx;
        let w = vec4<f32>(B[wq.x + wo], B[wq.y + wo], B[wq.z + wo], B[wq.w + wo]) * ok;
        acc[0] += w.x * v; acc[1] += w.y * v; acc[2] += w.z * v; acc[3] += w.w * v;
      }
    }
  }
  for (var q = 0u; q < 4u; q++) {
    if (oc0 + q >= cout) { break; }
    for (var j = 0u; j < 4u; j++) {
      if (x0 + j >= ow) { break; }
      var v = act(acc[q][j], P[17], pf(18), pf(19));
      if (P[17] == 6u && v < 0.0) { v = v * B[P[27] + oc0 + q]; }
      if (P[20] == 1u) { v = v * pf(21) + pf(22); }
      O[outIndex(oc0 + q, y, x0 + j, oh, ow, P[28])] = v;
    }
  }
}`,
  // dense 3×3, stride 1, padding 1 (super-resolution nets: 30+ of them at 64 channels). One workgroup = an 8 × 8 pixel
  // tile × 8 output channels; per step of 8 input channels the 10 × 10 input patch and the 8 × 8 × 9 weights are
  // staged in workgroup memory once and read 64 times from there. Same P as conv (n unused: tiles from the group id).
  conv3t: `${IO2}
var<workgroup> XT: array<f32, 800>;
var<workgroup> WT: array<f32, 576>;
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let H = P[2]; let W = P[3]; let cin = P[1]; let cout = P[4];
  let tw = (W + 7u) / 8u; let th = (H + 7u) / 8u;
  let wid = wg.x + wg.y * nw.x;
  let tx = wid % tw; let t1 = wid / tw; let ty = t1 % th; let ocb = t1 / th;
  let lx = li % 8u; let ly = li / 8u;
  let x = tx * 8u + lx; let y = ty * 8u + ly; let oc0 = ocb * 8u;
  var acc: array<f32, 8>;
  for (var q = 0u; q < 8u; q++) {
    acc[q] = 0.0;
    if (P[26] == 1u && oc0 + q < cout) { acc[q] = B[P[25] + oc0 + q]; }
  }
  let gx0 = i32(tx * 8u) - 1; let gy0 = i32(ty * 8u) - 1;
  for (var c0 = 0u; c0 < cin; c0 += 8u) {
    for (var k = li; k < 800u; k += 64u) {
      let c = k / 100u; let r = k % 100u; let iy = gy0 + i32(r / 10u); let ix = gx0 + i32(r % 10u);
      var v = 0.0;
      if (c0 + c < cin && iy >= 0 && iy < i32(H) && ix >= 0 && ix < i32(W)) { v = A[P[23] + ((c0 + c) * H + u32(iy)) * W + u32(ix)]; }
      XT[k] = v;
    }
    for (var k = li; k < 576u; k += 64u) {
      let q = k / 72u; let r = k % 72u; let c = r / 9u;
      var v = 0.0;
      if (oc0 + q < cout && c0 + c < cin) { v = B[P[24] + ((oc0 + q) * cin + c0 + c) * 9u + r % 9u]; }
      WT[k] = v;
    }
    workgroupBarrier();
    for (var c = 0u; c < 8u; c++) {
      let xb = c * 100u + ly * 10u + lx;
      let x00 = XT[xb]; let x01 = XT[xb + 1u]; let x02 = XT[xb + 2u];
      let x10 = XT[xb + 10u]; let x11 = XT[xb + 11u]; let x12 = XT[xb + 12u];
      let x20 = XT[xb + 20u]; let x21 = XT[xb + 21u]; let x22 = XT[xb + 22u];
      for (var q = 0u; q < 8u; q++) {
        let wb = q * 72u + c * 9u;
        acc[q] += WT[wb] * x00 + WT[wb + 1u] * x01 + WT[wb + 2u] * x02 + WT[wb + 3u] * x10 + WT[wb + 4u] * x11 + WT[wb + 5u] * x12 + WT[wb + 6u] * x20 + WT[wb + 7u] * x21 + WT[wb + 8u] * x22;
      }
    }
    workgroupBarrier();
  }
  if (x >= W || y >= H) { return; }
  for (var q = 0u; q < 8u; q++) {
    if (oc0 + q >= cout) { break; }
    var v = act(acc[q], P[17], pf(18), pf(19));
    if (P[17] == 6u && v < 0.0) { v = v * B[P[27] + oc0 + q]; }
    if (P[20] == 1u) { v = v * pf(21) + pf(22); }
    O[outIndex(oc0 + q, y, x, H, W, P[28])] = v;
  }
}`,
  // P: n cin H W cout oh ow kh kw cpg ipg xOff wOff bOff hasB   (k = stride, no padding)
  convT: `${IO2}${FLAT}
  let ow = P[6]; let oh = P[5]; let kh = P[7]; let kw = P[8]; let cpg = P[9]; let ipg = P[10];
  let x = i % ow; let t = i / ow; let y = t % oh; let oc = t / oh;
  let gi = oc / cpg; let oo = oc % cpg;
  let ky = y % kh; let kx = x % kw; let iy = y / kh; let ix = x / kw;
  var acc = 0.0;
  if (P[14] == 1u) { acc = B[P[13] + oc]; }
  for (var ci = gi * ipg; ci < (gi + 1u) * ipg; ci++) {
    acc += B[P[12] + ((ci * cpg + oo) * kh + ky) * kw + kx] * A[P[11] + (ci * P[2] + iy) * P[3] + ix];
  }
  O[i] = acc;
}`,
  // P: n op rank6 shape[6] aStr[6] bStr[6] aOff bOff     op: 0 add, 1 mul, 2 sub
  bin: `${IO2}${FLAT}
  var r = i; var ia = P[21]; var ib = P[22];
  for (var k = 0u; k < 6u; k++) {
    let d = 5u - k; let s = P[3u + d]; let q = r % s; r = r / s;
    ia += q * P[9u + d]; ib += q * P[15u + d];
  }
  let a = A[ia]; let b = B[ib];
  var v = a + b;
  if (P[1] == 1u) { v = a * b; } else if (P[1] == 2u) { v = a - b; }
  O[i] = v;
}`,
  // P: n kind a0 a1 post p0 p1 xOff
  unary: `${IO1}${FLAT}
  var v = act(A[P[7] + i], P[1], pf(2), pf(3));
  if (P[4] == 1u) { v = v * pf(5) + pf(6); }
  O[i] = v;
}`,
  // P: n shape[6] sStr[6] dStr[6] sOff dOff
  copy: `${IO1}${FLAT}
  var r = i; var s = P[19]; var d = P[20];
  for (var k = 0u; k < 6u; k++) {
    let a = 5u - k; let n = P[1u + a]; let q = r % n; r = r / n;
    s += q * P[7u + a]; d += q * P[13u + a];
  }
  O[d] = A[s];
}`,
  // P: n C H W oh ow xOff
  nearest: `${IO1}${FLAT}
  let ow = P[5]; let oh = P[4]; let H = P[2]; let W = P[3];
  let x = i % ow; let t = i / ow; let y = t % oh; let c = t / oh;
  let sy = min(H - 1u, (y * H) / oh); let sx = min(W - 1u, (x * W) / ow);
  O[i] = A[P[6] + (c * H + sy) * W + sx];
}`,
  // P: n C H W oh ow kh kw sh sw ph pw xOff   (average, padding excluded)
  pool: `${IO1}${FLAT}
  let ow = P[5]; let oh = P[4]; let H = P[2]; let W = P[3];
  let x = i % ow; let t = i / ow; let y = t % oh; let c = t / oh;
  var s = 0.0; var n = 0.0;
  for (var ky = 0u; ky < P[6]; ky++) {
    let yy = i32(y * P[8] + ky) - i32(P[10]);
    if (yy < 0 || yy >= i32(H)) { continue; }
    for (var kx = 0u; kx < P[7]; kx++) {
      let xx = i32(x * P[9] + kx) - i32(P[11]);
      if (xx < 0 || xx >= i32(W)) { continue; }
      s += A[P[12] + (c * H + u32(yy)) * W + u32(xx)]; n += 1.0;
    }
  }
  O[i] = s / max(n, 1.0);
}`,
  // P: n M K N bBatched aOff bOff — 4 rows of A per invocation (each B value feeds 4 outputs), n = threads
  matmul: `${IO2}${FLAT}
  let N = P[3]; let M = P[1]; let K = P[2]; let mbs = (M + 3u) / 4u;
  let nn = i % N; let t2 = i / N; let m0 = (t2 % mbs) * 4u; let t = t2 / mbs;
  var bo = P[6] + nn;
  if (P[4] == 1u) { bo += t * K * N; }
  var ao = vec4<u32>(0u);
  for (var j = 0u; j < 4u; j++) { ao[j] = P[5] + (t * M + min(m0 + j, M - 1u)) * K; }
  var acc = vec4<f32>(0.0);
  for (var k = 0u; k < K; k++) {
    acc += vec4<f32>(A[ao.x + k], A[ao.y + k], A[ao.z + k], A[ao.w + k]) * B[bo + k * N];
  }
  for (var j = 0u; j < 4u; j++) { if (m0 + j < M) { O[(t * M + m0 + j) * N + nn] = acc[j]; } }
}`,
  // P: rows L eps xOff gOff bOff — one invocation per row (L is small: 120 in the recognizer)
  layernorm: `${IO2}${FLAT}
  let L = P[1]; let xo = P[3] + i * L;
  var m = 0.0;
  for (var k = 0u; k < L; k++) { m += A[xo + k]; }
  m = m / f32(L);
  var v = 0.0;
  for (var k = 0u; k < L; k++) { let d = A[xo + k] - m; v += d * d; }
  let r = 1.0 / sqrt(v / f32(L) + pf(2));
  for (var k = 0u; k < L; k++) { O[i * L + k] = (A[xo + k] - m) * r * B[P[4] + k] + B[P[5] + k]; }
}`,
  // P: rows L xOff — one workgroup per row (classifier rows are 11,947 wide)
  softmax: `${IO1}
var<workgroup> red: array<f32, 64>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let row = wg.x + wg.y * nw.x;
  if (row >= P[0]) { return; }
  let L = P[1]; let xo = P[2] + row * L; let oo = row * L; let t = l.x;
  var m = -3.4e38;
  for (var k = t; k < L; k += 64u) { m = max(m, A[xo + k]); }
  red[t] = m;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) { if (t < s) { red[t] = max(red[t], red[t + s]); } workgroupBarrier(); }
  m = red[0];
  workgroupBarrier();
  var sum = 0.0;
  for (var k = t; k < L; k += 64u) { let e = exp(A[xo + k] - m); O[oo + k] = e; sum += e; }
  red[t] = sum;
  workgroupBarrier();
  for (var s = 32u; s > 0u; s = s >> 1u) { if (t < s) { red[t] = red[t] + red[t + s]; } workgroupBarrier(); }
  let inv = 1.0 / red[0];
  for (var k = t; k < L; k += 64u) { O[oo + k] = O[oo + k] * inv; }
}`,
  // P: C HW xOff — global average, one workgroup per channel
  // per-channel k·x + s (batch norm, folded on the CPU): B holds k[C] then s[C]. P: n C HW xOff
  affine: `${IO2}${FLAT}
  let c = (i / P[2]) % P[1];
  O[i] = A[P[3] + i] * B[c] + B[P[1] + c];
}`,
  // instance norm: one workgroup per channel (mean and variance over H × W), then the affine scale / shift (weights in B).
  // P: C HW xOff scOff biOff eps
  inorm: `${IO2}
var<workgroup> r1: array<f32, 64>;
var<workgroup> r2: array<f32, 64>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let c = wg.x; let n = P[1]; let xo = P[2] + c * n; let t = l.x;
  var s = 0.0;
  for (var k = t; k < n; k += 64u) { s += A[xo + k]; }
  r1[t] = s;
  workgroupBarrier();
  for (var q = 32u; q > 0u; q = q >> 1u) { if (t < q) { r1[t] = r1[t] + r1[t + q]; } workgroupBarrier(); }
  let mean = r1[0] / f32(n);
  var v = 0.0;
  for (var k = t; k < n; k += 64u) { let d = A[xo + k] - mean; v += d * d; }
  r2[t] = v;
  workgroupBarrier();
  for (var q = 32u; q > 0u; q = q >> 1u) { if (t < q) { r2[t] = r2[t] + r2[t + q]; } workgroupBarrier(); }
  let kk = B[P[3] + c] / sqrt(r2[0] / f32(n) + pf(5)); let sh = B[P[4] + c] - mean * kk;
  for (var k = t; k < n; k += 64u) { O[c * n + k] = A[xo + k] * kk + sh; }
}`,
  // bilinear resize, PyTorch align_corners = false (graph.ts bilinear). P: n C H W oh ow xOff
  bilinear: `${IO1}${FLAT}
  let ow = P[5]; let oh = P[4]; let H = P[2]; let W = P[3];
  let x = i % ow; let t = i / ow; let y = t % oh; let c = t / oh;
  var fy = 0.0; var fx = 0.0;
  if (oh > 1u) { fy = max(0.0, (f32(y) + 0.5) * f32(H) / f32(oh) - 0.5); }
  if (ow > 1u) { fx = max(0.0, (f32(x) + 0.5) * f32(W) / f32(ow) - 0.5); }
  fy = min(fy, f32(H - 1u)); fx = min(fx, f32(W - 1u));
  let y0 = u32(floor(fy)); let x0 = u32(floor(fx));
  let y1 = min(H - 1u, y0 + 1u); let x1 = min(W - 1u, x0 + 1u);
  let wy = fy - f32(y0); let wx = fx - f32(x0);
  let b = P[6] + c * H * W;
  let a0 = A[b + y0 * W + x0]; let a1 = A[b + y0 * W + x1]; let b0 = A[b + y1 * W + x0]; let b1 = A[b + y1 * W + x1];
  O[i] = (a0 + (a1 - a0) * wx) * (1.0 - wy) + (b0 + (b1 - b0) * wx) * wy;
}`,
  // ---- BiRefNet (graph.ts: ln_c, win_attn, patch_merge, resize_ac; image2patches is a copy, deform_conv igemmd) ----
  // LayerNorm over the channels of NCHW, one invocation per pixel. P: n C xOff gOff bOff eps
  lnc: `${IO2}${FLAT}
  let C = P[1]; let HW = P[0]; let xo = P[2] + i;
  var m = 0.0;
  for (var c = 0u; c < C; c++) { m += A[xo + c * HW]; }
  m = m / f32(C);
  var v = 0.0;
  for (var c = 0u; c < C; c++) { let d = A[xo + c * HW] - m; v += d * d; }
  let r = 1.0 / sqrt(v / f32(C) + pf(5));
  for (var c = 0u; c < C; c++) { O[c * HW + i] = (A[xo + c * HW] - m) * r * B[P[3] + c] + B[P[4] + c]; }
}`,
  // Swin window attention, one workgroup per (window, head): K and V of the window in workgroup memory, invocation
  // i < N is query token i (its q, scores and output in registers). Head size ≤ 32, N·d ≤ 1600.
  // P: groups C H W Hp Wp ws shift heads d xOff qbOff rbOff scale nWw
  wattn: `${IO2}
var<workgroup> KS: array<f32, 1600>;
var<workgroup> VS: array<f32, 1600>;
fn reg(s: u32, n: u32, ws: u32, sh: u32) -> u32 { if (s < n - ws) { return 0u; } if (s < n - sh) { return 1u; } return 2u; }
@compute @workgroup_size(64) fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let gid = wg.x + wg.y * nw.x;
  if (gid >= P[0]) { return; }
  let C = P[1]; let H = P[2]; let W = P[3]; let Hp = P[4]; let Wp = P[5]; let ws = P[6]; let sh = P[7]; let heads = P[8]; let d = P[9];
  let N = ws * ws; let HW = H * W;
  let h = gid % heads; let win = gid / heads; let wy = win / P[14]; let wx = win % P[14];
  for (var e = li; e < N * d; e += 64u) {
    let j = e / d; let c = e % d;
    let sy = wy * ws + j / ws; let sx = wx * ws + j % ws;
    let py = (sy + sh) % Hp; let px = (sx + sh) % Wp;
    let ck = C + h * d + c; let cv = 2u * C + h * d + c;
    if (py < H && px < W) { KS[e] = A[P[10] + ck * HW + py * W + px]; VS[e] = A[P[10] + cv * HW + py * W + px]; }
    else { KS[e] = B[P[11] + ck]; VS[e] = B[P[11] + cv]; }
  }
  workgroupBarrier();
  if (li >= N) { return; }
  let sy = wy * ws + li / ws; let sx = wx * ws + li % ws;
  let py = (sy + sh) % Hp; let px = (sx + sh) % Wp;
  if (py >= H || px >= W) { return; }
  var q: array<f32, 32>;
  for (var c = 0u; c < d; c++) { q[c] = A[P[10] + (h * d + c) * HW + py * W + px] * pf(13); }
  var ri = 0u;
  if (sh > 0u) { ri = reg(sy, Hp, ws, sh) * 3u + reg(sx, Wp, ws, sh); }
  var s: array<f32, 64>;
  var mx = -3.4e38;
  for (var j = 0u; j < N; j++) {
    var t = 0.0;
    for (var c = 0u; c < d; c++) { t += q[c] * KS[j * d + c]; }
    t += B[P[12] + (h * N + li) * N + j];
    if (sh > 0u) {
      let sj = wy * ws + j / ws; let sxj = wx * ws + j % ws;
      if (reg(sj, Hp, ws, sh) * 3u + reg(sxj, Wp, ws, sh) != ri) { t -= 100.0; }
    }
    s[j] = t;
    mx = max(mx, t);
  }
  var sum = 0.0;
  for (var j = 0u; j < N; j++) { s[j] = exp(s[j] - mx); sum += s[j]; }
  let inv = 1.0 / sum;
  for (var c = 0u; c < d; c++) {
    var acc = 0.0;
    for (var j = 0u; j < N; j++) { acc += s[j] * VS[j * d + c]; }
    O[(h * d + c) * HW + py * W + px] = acc * inv;
  }
}`,
  // Swin PatchMerging (2×2 to channels, x0 x1 x2 x3 order, zero padding). P: n C H W oh ow xOff
  pmerge: `${IO1}${FLAT}
  let C = P[1]; let H = P[2]; let W = P[3]; let oh = P[4]; let ow = P[5];
  let x = i % ow; let t = i / ow; let y = t % oh; let oc = t / oh;
  let q = oc / C; let c = oc % C;
  let iy = 2u * y + (q & 1u); let ix = 2u * x + (q >> 1u);
  var v = 0.0;
  if (iy < H && ix < W) { v = A[P[6] + (c * H + iy) * W + ix]; }
  O[i] = v;
}`,
  // bilinear, align_corners = true (graph.ts resizeAC). P: n C H W oh ow xOff
  resizeac: `${IO1}${FLAT}
  let ow = P[5]; let oh = P[4]; let H = P[2]; let W = P[3];
  let x = i % ow; let t = i / ow; let y = t % oh; let c = t / oh;
  var fy = 0.0; var fx = 0.0;
  if (oh > 1u) { fy = f32(y) * f32(H - 1u) / f32(oh - 1u); }
  if (ow > 1u) { fx = f32(x) * f32(W - 1u) / f32(ow - 1u); }
  let y0 = min(H - 1u, u32(floor(fy))); let x0 = min(W - 1u, u32(floor(fx)));
  let y1 = min(H - 1u, y0 + 1u); let x1 = min(W - 1u, x0 + 1u);
  let wy = fy - f32(y0); let wx = fx - f32(x0);
  let b = P[6] + c * H * W;
  O[i] = (A[b + y0 * W + x0] * (1.0 - wx) + A[b + y0 * W + x1] * wx) * (1.0 - wy) + (A[b + y1 * W + x0] * (1.0 - wx) + A[b + y1 * W + x1] * wx) * wy;
}`,
  gpool: `${IO1}
var<workgroup> red: array<f32, 64>;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
  let c = wg.x; let n = P[1]; let xo = P[2] + c * n; let t = l.x;
  var s = 0.0;
  for (var k = t; k < n; k += 64u) { s += A[xo + k]; }
  red[t] = s;
  workgroupBarrier();
  for (var q = 32u; q > 0u; q = q >> 1u) { if (t < q) { red[t] = red[t] + red[t + q]; } workgroupBarrier(); }
  if (t == 0u) { O[c] = red[0] / f32(n); }
}`,
};

// Dense conv (groups 1, any kernel / stride / padding / dilation) and modulated deformable conv as a tiled implicit GEMM:
// a workgroup computes 64 output channels × 64 output pixels, 16 values of the reduction (cin·kh·kw) at a time staged
// in workgroup memory — the weights, and the input sampled for those taps (read straight for a conv; for a deformable
// conv bilinearly at the offset position, zero outside, times the tap's mask); each invocation keeps 4 × 4 sums in
// registers. Used for the convs the converter marks (a.gemm: BiRefNet) and for every deform_conv.
// P: cout cin H W OH OW kh kw sh sw pt pl dh dw act a0 a1 post p0 p1 xOff wOff bOff hasB offOff mOff
const IGEMM = (deform: boolean) => `${IO2}
${deform ? "@group(0) @binding(4) var<storage, read> OF: array<f32>;\n@group(0) @binding(5) var<storage, read> MK: array<f32>;" : ""}
var<workgroup> AS: array<f32, 1024>;
var<workgroup> BS: array<f32, 1024>;
fn sample(k: u32, p: u32) -> f32 {
  let H = P[2]; let W = P[3]; let OW = P[5]; let kh = P[6]; let kw = P[7]; let KK = kh * kw;
  let c = k / KK; let t = k % KK; let ky = t / kw; let kx = t % kw;
  let oy = p / OW; let ox = p % OW;
  ${
    deform
      ? `let NP = P[4] * OW;
  let m = MK[P[25] + t * NP + p];
  let fy = f32(oy * P[8]) - f32(P[10]) + f32(ky * P[12]) + OF[P[24] + 2u * t * NP + p];
  let fx = f32(ox * P[9]) - f32(P[11]) + f32(kx * P[13]) + OF[P[24] + (2u * t + 1u) * NP + p];
  if (!(fy > -1.0 && fy < f32(H) && fx > -1.0 && fx < f32(W))) { return 0.0; }
  let yl = i32(floor(fy)); let xl = i32(floor(fx)); let ly = fy - f32(yl); let lx = fx - f32(xl);
  let b = i32(P[20] + c * H * W); let Wi = i32(W);
  var v = 0.0;
  if (yl >= 0 && xl >= 0) { v += (1.0 - ly) * (1.0 - lx) * A[u32(b + yl * Wi + xl)]; }
  if (yl >= 0 && xl + 1 < Wi) { v += (1.0 - ly) * lx * A[u32(b + yl * Wi + xl + 1)]; }
  if (yl + 1 < i32(H) && xl >= 0) { v += ly * (1.0 - lx) * A[u32(b + (yl + 1) * Wi + xl)]; }
  if (yl + 1 < i32(H) && xl + 1 < Wi) { v += ly * lx * A[u32(b + (yl + 1) * Wi + xl + 1)]; }
  return v * m;`
      : `let iy = i32(oy * P[8] + ky * P[12]) - i32(P[10]); let ix = i32(ox * P[9] + kx * P[13]) - i32(P[11]);
  if (iy < 0 || iy >= i32(H) || ix < 0 || ix >= i32(W)) { return 0.0; }
  return A[P[20] + (c * H + u32(iy)) * W + u32(ix)];`
  }
}
@compute @workgroup_size(256) fn main(@builtin(local_invocation_index) li: u32, @builtin(workgroup_id) wg: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let cout = P[0]; let K = P[1] * P[6] * P[7]; let NP = P[4] * P[5];
  let tilesN = (NP + 63u) / 64u;
  let wid = wg.x + wg.y * nw.x;
  let live = wid < tilesN * ((cout + 63u) / 64u);
  let m0 = (wid / tilesN) * 64u; let n0 = (wid % tilesN) * 64u;
  let tx = li % 16u; let ty = li / 16u;
  var acc: array<vec4<f32>, 4>;
  for (var k0 = 0u; k0 < K; k0 += 16u) {
    for (var q = 0u; q < 4u; q++) {
      let e = li + q * 256u;
      let mm = e / 16u; let ka = e % 16u; let oc = m0 + mm; let k = k0 + ka;
      var a = 0.0;
      if (live && oc < cout && k < K) { a = B[P[21] + oc * K + k]; }
      AS[ka * 64u + mm] = a;
      let kb = e / 64u; let nn = e % 64u; let p = n0 + nn; let k2 = k0 + kb;
      var b = 0.0;
      if (live && p < NP && k2 < K) { b = sample(k2, p); }
      BS[kb * 64u + nn] = b;
    }
    workgroupBarrier();
    for (var kk = 0u; kk < 16u; kk++) {
      let ab = kk * 64u + ty * 4u; let bb = kk * 64u + tx * 4u;
      let a = vec4<f32>(AS[ab], AS[ab + 1u], AS[ab + 2u], AS[ab + 3u]);
      let b = vec4<f32>(BS[bb], BS[bb + 1u], BS[bb + 2u], BS[bb + 3u]);
      acc[0] += a.x * b; acc[1] += a.y * b; acc[2] += a.z * b; acc[3] += a.w * b;
    }
    workgroupBarrier();
  }
  if (!live) { return; }
  for (var r = 0u; r < 4u; r++) {
    let oc = m0 + ty * 4u + r;
    if (oc >= cout) { break; }
    var bias = 0.0;
    if (P[23] == 1u) { bias = B[P[22] + oc]; }
    for (var j = 0u; j < 4u; j++) {
      let p = n0 + tx * 4u + j;
      if (p >= NP) { break; }
      var v = act(acc[r][j] + bias, P[14], pf(15), pf(16));
      if (P[17] == 1u) { v = v * pf(18) + pf(19); }
      O[oc * NP + p] = v;
    }
  }
}`;
SHADERS.igemm = IGEMM(false);
SHADERS.igemmd = IGEMM(true);

const ACT: Record<string, number> = { relu: 1, hardswish: 2, swish: 3, sigmoid: 4, hardsigmoid: 5, prelu: 6, relu6: 7, gelu: 8 };

/** The tiled 3×3 kernel (conv3t) applies: dense 3×3, stride 1, padding 1, wide enough to fill its 8-channel blocks. */
let conv3tOn = true;
/** Tests / measurements: compare conv3t against the general conv4 kernel. */
export function setConv3Tiled(on: boolean) {
  conv3tOn = on;
}
const conv3Fast = (kh: number, kw: number, sh: number, sw: number, dh: number, dw: number, pt: number, pl: number, cin: number, cout: number) =>
  conv3tOn && kh === 3 && kw === 3 && sh === 1 && sw === 1 && dh === 1 && dw === 1 && pt === 1 && pl === 1 && cout >= 8 && cin >= 3;
const conv3Threads = (cout: number, oh: number, ow: number) => Math.ceil(cout / 8) * Math.ceil(oh / 8) * Math.ceil(ow / 8) * 64;
const STORAGE = 0x80, COPY_SRC = 0x04, COPY_DST = 0x08, MAP_READ = 0x01;
const size = (s: number[]) => s.reduce((a, b) => a * b, 1);
const strides = (s: number[]) => {
  const st = new Array(s.length).fill(1);
  for (let i = s.length - 2; i >= 0; i--) st[i] = st[i + 1] * s[i + 1];
  return st;
};
/** pad a shape / strides to rank 6 at the front */
const six = (v: number[], fill: number) => [...new Array(6 - v.length).fill(fill), ...v];
const f2u = (v: number) => new Uint32Array(new Float32Array([v]).buffer)[0];

interface GT {
  s: number[];
  buf: Buf;
  off: number;
}
type GVal = GT | GT[];

let device: Promise<{ dev: Buf; pipes: Map<string, Buf> } | null> | null = null;
/** True where the engine exposes WebGPU (Chromium / WebView2, also in workers). */
export function graphGpuAvailable(): boolean {
  return typeof navigator !== "undefined" && !!(navigator as any).gpu;
}
/** The device with every pipeline compiled. Compiling is most of the first use (≈ 5 s on an integrated GPU when one
 *  shader after another blocks the first run); the async variant compiles them side by side in the driver. */
function getDevice(): Promise<{ dev: Buf; pipes: Map<string, Buf> } | null> {
  if (!device)
    device = (async () => {
      if (!graphGpuAvailable()) return null;
      const ad = await (navigator as any).gpu.requestAdapter({ powerPreference: "high-performance" });
      if (!ad) return null;
      // the default binding / buffer limits (128 / 256 MB) are below BiRefNet's weights (178 MB as f32) and its largest
      // activation at 1024² (268 MB): ask for what the adapter has, up to 1 GB
      const lim = ad.limits ?? {};
      const want = (k: string, def: number) => Math.max(def, Math.min(Number(lim[k]) || def, 1 << 30));
      const dev = await ad.requestDevice({ requiredLimits: { maxStorageBufferBindingSize: want("maxStorageBufferBindingSize", 134217728), maxBufferSize: want("maxBufferSize", 268435456) } });
      dev.lost?.then(() => (device = null));
      const names = Object.keys(SHADERS);
      const ps = await Promise.all(names.map((k) => dev.createComputePipelineAsync({ layout: "auto", compute: { module: dev.createShaderModule({ code: HEAD + SHADERS[k] }), entryPoint: "main" } })));
      return { dev, pipes: new Map(names.map((k, i) => [k, ps[i]])) };
    })().catch(() => null);
  return device;
}

export class GraphGpu {
  /** free activation buffers (best fit: a run's tensors have dozens of sizes, so exact-size reuse would allocate a
   *  new buffer for most of them — on the first run alone ≈ 1 GB on the detector) */
  private free: { size: number; buf: Buf }[] = [];
  lost = false;
  /** resolves when the device is lost */
  gone: Promise<unknown> = new Promise(() => {});

  private constructor(
    private dev: Buf,
    private pipes: Map<string, Buf>,
    private m: GraphModel,
    private wbuf: Buf,
    private woff: Map<string, number>,
  ) {}

  /** null without WebGPU or when the model cannot be uploaded. */
  static async create(m: GraphModel): Promise<GraphGpu | null> {
    const d = await getDevice();
    if (!d) return null;
    const dev = d.dev;
    const woff = new Map<string, number>();
    let n = 0;
    for (const [k, t] of m.w) {
      woff.set(k, n);
      n += (t.d.length + 63) & ~63;
    }
    if (n * 4 > dev.limits.maxStorageBufferBindingSize) return null;
    const all = new Float32Array(n);
    for (const [k, t] of m.w) all.set(t.d, woff.get(k)!);
    const wbuf = dev.createBuffer({ size: Math.max(16, n * 4), usage: STORAGE | COPY_DST });
    dev.queue.writeBuffer(wbuf, 0, all);
    const g = new GraphGpu(dev, d.pipes, m, wbuf, woff);
    g.gone = dev.lost ?? new Promise(() => {});
    g.gone.then(() => (g.lost = true));
    return g;
  }

  private pipe(name: string) {
    return this.pipes.get(name)!;
  }

  /** Several runs may be in flight (one recording while the GPU executes another): each takes its own buffers from
   *  the pool and returns them when its result is back. */
  run(input: Tensor): Promise<Tensor> {
    return this.runNow(input);
  }

  private async runNow(input: Tensor): Promise<Tensor> {
    if (this.lost) throw new Error("WebGPU device lost");
    const { dev, m } = this;
    const fresh: Buf[] = [];
    const taken: [number, Buf][] = [];
    const refs = new Map<Buf, number>();
    // sizes in powers of two (≥ 256 KB): the first use of a new GPU buffer is slow (the driver commits and clears it,
    // ≈ 1 GB/s on an integrated GPU) and lines of every width then reuse the same few buffers
    const bytesOf = (n: number) => Math.max(1 << 18, 2 ** Math.ceil(Math.log2(n * 4)));
    const alloc = (n: number): GT["buf"] => {
      const need = bytesOf(n);
      let best = -1;
      this.free.forEach((f, k) => {
        if (f.size >= need && f.size <= 4 * need + (1 << 20) && (best < 0 || f.size < this.free[best].size)) best = k;
      });
      const f = best >= 0 ? this.free.splice(best, 1)[0] : { size: need, buf: dev.createBuffer({ size: need, usage: STORAGE | COPY_SRC | COPY_DST }) };
      taken.push([f.size, f.buf]);
      return f.buf;
    };
    const release = (b: Buf) => {
      const r = (refs.get(b) ?? 1) - 1;
      if (r > 0) return refs.set(b, r);
      refs.delete(b);
      const i = taken.findIndex((t) => t[1] === b);
      if (i < 0) return; // weights / uploads
      this.free.push({ size: taken[i][0], buf: b });
      taken.splice(i, 1);
    };
    /** a CPU tensor as a GPU operand (its own buffer: queue writes land before the whole pass runs) */
    const upload = (t: Tensor): GT => {
      const b = dev.createBuffer({ size: Math.max(16, Math.ceil((t.d.length * 4) / 4) * 4), usage: STORAGE | COPY_DST });
      dev.queue.writeBuffer(b, 0, t.d);
      fresh.push(b);
      return { s: t.s, buf: b, off: 0 };
    };
    const newT = (s: number[]): GT => {
      const b = alloc(size(s));
      refs.set(b, 1);
      return { s, buf: b, off: 0 };
    };
    type Rec = { pipe: string; bufs: Buf[]; p: number[]; groups: [number, number] };
    const recs: Rec[] = [];
    const dispatch = (pipe: string, bufs: Buf[], p: number[], threads: number, perGroup = 64) => {
      const g = Math.ceil(threads / perGroup);
      recs.push({ pipe, bufs, p, groups: [Math.min(g, 65535), Math.ceil(g / 65535)] });
    };

    const gpu = new Map<number, GVal>();
    const cpu = new Map<number, Val>();
    try {
      const inBuf = upload(input);
      gpu.set(m.meta.input, { s: input.s, buf: inBuf.buf, off: 0 });
      const wGT = (name: string): GT => ({ s: m.w.get(name)!.s, buf: this.wbuf, off: this.woff.get(name)! });
      const isCpu = (x: number | string) => typeof x === "string" || cpu.has(x);
      const getCpu = (x: number | string): Val => {
        if (typeof x === "string") return m.w.get(x.slice(1))!;
        const v = cpu.get(x);
        if (!v) throw new Error("value %" + x + " not on the CPU");
        return v;
      };
      const g = (x: number | string): GT => {
        if (typeof x === "string") return wGT(x.slice(1));
        const v = gpu.get(x);
        if (v && !Array.isArray(v)) return v;
        const c = cpu.get(x);
        if (c && !Array.isArray(c)) return upload(c);
        throw new Error("value %" + x);
      };
      const copy = (src: GT, dst: GT, shape: number[], sStr: number[], dStr: number[], sOff: number, dOff: number) =>
        dispatch("copy", [src.buf, dst.buf], [size(shape), ...six(shape, 1), ...six(sStr, 0), ...six(dStr, 0), src.off + sOff, dst.off + dOff], size(shape));

      const nodes = m.meta.nodes;
      for (let i = 0; i < nodes.length; i++) {
        const n: GNode = nodes[i];
        const a = n.a ?? {};
        let r: GVal | null = null;
        // values computed on the CPU: constants, shapes and anything whose inputs are all on the CPU
        if (n.op === "const" || n.op === "shape64" || (n.op !== "conv" && n.op !== "convT" && n.in.every(isCpu))) {
          if (n.op === "shape64") {
            const x = gpu.get(n.in[0] as number) as GT | undefined;
            if (x) {
              const v: Tensor = { s: [x.s.length], d: Float32Array.from(x.s), int: true };
              n.out.forEach((o) => cpu.set(o, v));
              continue;
            }
          }
          const v = evalNode(m, n, getCpu);
          n.out.forEach((o) => cpu.set(o, v));
          continue;
        }
        switch (n.op) {
          case "conv": {
            const x = g(n.in[0]);
            const w = m.w.get(n.w!)!;
            const [cout, cpg, kh, kw] = w.s;
            const [, cin, H, W] = x.s;
            const gr = a.groups || 1;
            const [sh, sw] = a.stride, [dh, dw] = a.dil ?? [1, 1];
            const pt = a.pad[0], pl = a.pad.length === 4 ? a.pad[2] : (a.pad[1] ?? a.pad[0]);
            const pb = a.pad.length === 4 ? a.pad[1] : pt, pr = a.pad.length === 4 ? a.pad[3] : pl;
            const oh = Math.floor((H + pt + pb - dh * (kh - 1) - 1) / sh) + 1;
            const ow = Math.floor((W + pl + pr - dw * (kw - 1) - 1) / sw) + 1;
            // a.shuffle: the output is written through a pixel shuffle (super-resolution nets, fused depth to space)
            const shf: number = a.shuffle ?? 1;
            const o = newT(shf > 1 ? [1, cout / (shf * shf), oh * shf, ow * shf] : [1, cout, oh, ow]);
            const k = n.act ? ACT[n.act] : 0;
            if (n.act && !k) throw new Error("activation " + n.act);
            const [a0, a1] = n.actA ?? [1 / 6, 0.5];
            const post = n.post ?? [1, 0];
            if (a.gemm && gr === 1 && shf === 1 && k !== 6) {
              const P = [cout, cin, H, W, oh, ow, kh, kw, sh, sw, pt, pl, dh, dw, k, f2u(a0), f2u(a1), n.post ? 1 : 0, f2u(post[0]), f2u(post[1]), x.off, this.woff.get(n.w!)!, n.b ? this.woff.get(n.b)! : 0, n.b ? 1 : 0, 0, 0];
              const tiles = Math.ceil(cout / 64) * Math.ceil((oh * ow) / 64);
              recs.push({ pipe: "igemm", bufs: [x.buf, this.wbuf, o.buf], p: P, groups: [Math.min(tiles, 65535), Math.ceil(tiles / 65535)] });
              r = o;
              break;
            }
            const threads = gr === 1 ? Math.ceil(cout / 4) * oh * Math.ceil(ow / 4) : size(o.s);
            const P = [threads, cin, H, W, cout, oh, ow, kh, kw, sh, sw, pt, pl, dh, dw, cpg, cout / gr, k, f2u(a0), f2u(a1), n.post ? 1 : 0, f2u(post[0]), f2u(post[1]), x.off, this.woff.get(n.w!)!, n.b ? this.woff.get(n.b)! : 0, n.b ? 1 : 0, n.p ? this.woff.get(n.p)! : 0, shf];
            dispatch(gr === 1 ? (conv3Fast(kh, kw, sh, sw, dh, dw, pt, pl, cin, cout) ? "conv3t" : "conv4") : "conv", [x.buf, this.wbuf, o.buf], P, gr === 1 && conv3Fast(kh, kw, sh, sw, dh, dw, pt, pl, cin, cout) ? conv3Threads(cout, oh, ow) : threads);
            r = o;
            break;
          }
          case "deform_conv": {
            const x = g(n.in[0]), off = g(n.in[1]), mk = g(n.in[2]);
            const w = m.w.get(n.w!)!;
            const [cout, cin, kh, kw] = w.s;
            const [, , H, W] = x.s, [, , OH, OW] = off.s;
            const [sh, sw] = a.stride ?? [1, 1], [dh, dw] = a.dil ?? [1, 1], [ph, pw] = a.pad;
            const k = n.act ? ACT[n.act] : 0;
            if ((n.act && !k) || k === 6) throw new Error("activation " + n.act);
            const [a0, a1] = n.actA ?? [1 / 6, 0.5];
            const post = n.post ?? [1, 0];
            const o = newT([1, cout, OH, OW]);
            const P = [cout, cin, H, W, OH, OW, kh, kw, sh, sw, ph, pw, dh, dw, k, f2u(a0), f2u(a1), n.post ? 1 : 0, f2u(post[0]), f2u(post[1]), x.off, this.woff.get(n.w!)!, n.b ? this.woff.get(n.b)! : 0, n.b ? 1 : 0, off.off, mk.off];
            const tiles = Math.ceil(cout / 64) * Math.ceil((OH * OW) / 64);
            recs.push({ pipe: "igemmd", bufs: [x.buf, this.wbuf, off.buf, mk.buf, o.buf], p: P, groups: [Math.min(tiles, 65535), Math.ceil(tiles / 65535)] });
            r = o;
            break;
          }
          case "ln_c": {
            const x = g(n.in[0]);
            if (typeof n.in[1] !== "string" || typeof n.in[2] !== "string") throw new Error("ln_c weights");
            const C = x.s[1], HW = size(x.s) / C;
            const o = newT(x.s.slice());
            dispatch("lnc", [x.buf, this.wbuf, o.buf], [HW, C, x.off, this.woff.get(n.in[1].slice(1))!, this.woff.get(n.in[2].slice(1))!, f2u(a.eps ?? 1e-5)], HW);
            r = o;
            break;
          }
          case "win_attn": {
            const x = g(n.in[0]);
            if (typeof n.in[1] !== "string" || typeof n.in[2] !== "string") throw new Error("win_attn weights");
            const [, C3, H, W] = x.s, C = C3 / 3, heads: number = a.heads, d = C / heads, ws: number = a.ws, N = ws * ws;
            if (d > 32 || N > 64 || N * d > 1600) throw new Error("win_attn size");
            const Hp = Math.ceil(H / ws) * ws, Wp = Math.ceil(W / ws) * ws, groups = (Hp / ws) * (Wp / ws) * heads;
            const o = newT([1, C, H, W]);
            recs.push({ pipe: "wattn", bufs: [x.buf, this.wbuf, o.buf], p: [groups, C, H, W, Hp, Wp, ws, a.shift, heads, d, x.off, this.woff.get(n.in[1].slice(1))!, this.woff.get(n.in[2].slice(1))!, f2u(a.scale), Wp / ws], groups: [Math.min(groups, 65535), Math.ceil(groups / 65535)] });
            r = o;
            break;
          }
          case "patch_merge": {
            const x = g(n.in[0]);
            const [, C, H, W] = x.s, oh = Math.ceil(H / 2), ow = Math.ceil(W / 2);
            const o = newT([1, 4 * C, oh, ow]);
            dispatch("pmerge", [x.buf, o.buf], [size(o.s), C, H, W, oh, ow, x.off], size(o.s));
            r = o;
            break;
          }
          case "resize_ac": {
            const x = g(n.in[0]);
            const ref = gpu.get(n.in[1] as number) as GT | undefined;
            if (!ref || Array.isArray(ref)) throw new Error("resize_ac reference");
            const [, C, H, W] = x.s, [dh, dw] = a.div as number[];
            const oh = ref.s[2] / dh, ow = ref.s[3] / dw;
            if (!(Number.isInteger(oh) && Number.isInteger(ow) && oh > 0 && ow > 0)) throw new Error("resize_ac size");
            const o = newT([1, C, oh, ow]);
            dispatch("resizeac", [x.buf, o.buf], [size(o.s), C, H, W, oh, ow, x.off], size(o.s));
            r = o;
            break;
          }
          case "image2patches": {
            const x = g(n.in[0]);
            const [, C, H, W] = x.s, gg: number = a.g;
            if (!Number.isInteger(gg) || gg < 1 || H % gg || W % gg) throw new Error("image2patches grid");
            // output channel (j·g + i)·C + c ← block row i, column j, channel c (graph.ts image2patches)
            const h = H / gg, w = W / gg, s5 = [gg, gg, C, h, w];
            const o = newT([1, C * gg * gg, h, w]);
            copy(x, o, s5, [w, h * W, H * W, W, 1], strides(s5), 0, 0);
            r = o;
            break;
          }
          case "convT": {
            const x = g(n.in[0]);
            const w = m.w.get(n.w!)!;
            const [, cpg, kh, kw] = w.s;
            const [, cin, H, W] = x.s;
            const gr = a.groups || 1;
            const [sh, sw] = a.stride;
            if (sh !== kh || sw !== kw || (a.pad[0] ?? 0) || (a.pad[1] ?? 0)) throw new Error("convT variant");
            const cout = cpg * gr, oh = H * kh, ow = W * kw;
            const o = newT([1, cout, oh, ow]);
            dispatch("convT", [x.buf, this.wbuf, o.buf], [size(o.s), cin, H, W, cout, oh, ow, kh, kw, cpg, cin / gr, x.off, this.woff.get(n.w!)!, n.b ? this.woff.get(n.b)! : 0, n.b ? 1 : 0], size(o.s));
            r = o;
            break;
          }
          case "add":
          case "multiply":
          case "subtract": {
            const x = g(n.in[0]), y = g(n.in[1]);
            const rank = Math.max(x.s.length, y.s.length);
            const px = six(x.s, 1).slice(6 - rank), py = six(y.s, 1).slice(6 - rank);
            const s = px.map((v, k) => {
              if (v !== py[k] && v !== 1 && py[k] !== 1) throw new Error(`broadcast ${x.s} ${y.s}`);
              return Math.max(v, py[k]);
            });
            const sx = strides(px).map((v, k) => (px[k] === 1 ? 0 : v)), sy = strides(py).map((v, k) => (py[k] === 1 ? 0 : v));
            const o = newT(s);
            dispatch("bin", [x.buf, y.buf, o.buf], [size(s), n.op === "add" ? 0 : n.op === "multiply" ? 1 : 2, rank, ...six(s, 1), ...six(sx, 0), ...six(sy, 0), x.off, y.off], size(s));
            r = o;
            break;
          }
          case "bn": {
            // folded on the CPU into k·x + s per channel
            const x = g(n.in[0]);
            const [mean, vr, sc, bi] = n.in.slice(1).map((v) => (getCpu(v) as Tensor).d);
            const C = x.s[1], ks = new Float32Array(2 * C);
            for (let c = 0; c < C; c++) {
              ks[c] = sc[c] / Math.sqrt(vr[c] + (a.eps ?? 1e-5));
              ks[C + c] = bi[c] - mean[c] * ks[c];
            }
            const kb = upload({ s: [2 * C], d: ks });
            const o = newT(x.s.slice());
            dispatch("affine", [x.buf, kb.buf, o.buf], [size(x.s), C, size(x.s) / C, x.off], size(x.s));
            r = o;
            break;
          }
          case "inorm": {
            const x = g(n.in[0]);
            if (typeof n.in[1] !== "string" || typeof n.in[2] !== "string") throw new Error("inorm weights");
            const C = x.s[1], HW = size(x.s) / C;
            const o = newT(x.s.slice());
            recs.push({ pipe: "inorm", bufs: [x.buf, this.wbuf, o.buf], p: [C, HW, x.off, this.woff.get(n.in[1].slice(1))!, this.woff.get(n.in[2].slice(1))!, f2u(a.eps ?? 1e-5)], groups: [C, 1] });
            r = o;
            break;
          }
          case "bilinear_interp": {
            const x = g(n.in[0]);
            const sc = a.scale as number[];
            const [, C, H, W] = x.s;
            const oh = Math.floor(H * sc[0]), ow = Math.floor(W * sc[1]);
            const o = newT([1, C, oh, ow]);
            dispatch("bilinear", [x.buf, o.buf], [size(o.s), C, H, W, oh, ow, x.off], size(o.s));
            r = o;
            break;
          }
          case "relu":
          case "relu6":
          case "hardswish":
          case "swish":
          case "sigmoid":
          case "hardsigmoid":
          case "scale": {
            const x = g(n.in[0]);
            const o = newT(x.s.slice());
            let k = 0, a0 = 0, a1 = 0, post = 0, p0 = 1, p1 = 0;
            if (n.op === "scale") {
              const sc = (getCpu(n.in[1]) as Tensor).d[0], bias = a.bias ?? 0;
              post = 1;
              p0 = sc;
              p1 = a.after === false ? bias * sc : bias;
            } else {
              k = ACT[n.op];
              if (n.op === "hardsigmoid") [a0, a1] = [a.slope, a.offset];
            }
            dispatch("unary", [x.buf, o.buf], [size(x.s), k, f2u(a0), f2u(a1), post, f2u(p0), f2u(p1), x.off], size(x.s));
            r = o;
            break;
          }
          case "pool2d": {
            const x = g(n.in[0]);
            const ks = Array.from((getCpu(n.in[1]) as Tensor).d);
            const [, C, H, W] = x.s;
            if (a.global || (a.adaptive && ks[0] === 1 && ks[1] === 1)) {
              if (a.type === "max") throw new Error("max pool");
              const o = newT([1, C, 1, 1]);
              recs.push({ pipe: "gpool", bufs: [x.buf, o.buf], p: [C, H * W, x.off], groups: [C, 1] });
              r = o;
              break;
            }
            if (a.adaptive || a.type !== "avg") throw new Error("pool2d variant");
            const [kh, kw] = ks, [sh, sw] = a.stride, ph = a.pad?.[0] ?? 0, pw = a.pad?.[1] ?? 0;
            const oh = Math.floor((H + 2 * ph - kh) / sh) + 1, ow = Math.floor((W + 2 * pw - kw) / sw) + 1;
            const o = newT([1, C, oh, ow]);
            dispatch("pool", [x.buf, o.buf], [size(o.s), C, H, W, oh, ow, kh, kw, sh, sw, ph, pw, x.off], size(o.s));
            r = o;
            break;
          }
          case "nearest_interp": {
            const x = g(n.in[0]);
            const sc = a.scale as number[];
            const [, C, H, W] = x.s;
            const oh = a.h > 0 ? a.h : Math.floor(H * sc[0]), ow = a.w > 0 ? a.w : Math.floor(W * sc[1]);
            const o = newT([1, C, oh, ow]);
            dispatch("nearest", [x.buf, o.buf], [size(o.s), C, H, W, oh, ow, x.off], size(o.s));
            r = o;
            break;
          }
          case "list":
            // the members stay alive as long as the list (their own last use is this node)
            r = n.in.map(g);
            for (const t of r) refs.set(t.buf, (refs.get(t.buf) ?? 1) + 1);
            break;
          case "concat": {
            const xs = gpu.get(n.in[0] as number) as GT[];
            if (!Array.isArray(xs)) throw new Error("concat input");
            let axis = Array.from((getCpu(n.in[1]) as Tensor).d)[0];
            if (axis < 0) axis += xs[0].s.length;
            const s = xs[0].s.slice();
            s[axis] = xs.reduce((q, t) => q + t.s[axis], 0);
            const o = newT(s);
            const ost = strides(s);
            let at = 0;
            for (const t of xs) {
              copy(t, o, t.s, strides(t.s), ost, 0, at * ost[axis]);
              at += t.s[axis];
            }
            r = o;
            break;
          }
          case "reshape": {
            const x = g(n.in[0]);
            const want = Array.from((getCpu(n.in[1]) as Tensor).d);
            const s = want.map((v, k) => (v === 0 ? x.s[k] : v));
            const known = s.reduce((p, v) => (v === -1 ? p : p * v), 1);
            r = { ...x, s: s.map((v) => (v === -1 ? size(x.s) / known : v)) };
            break;
          }
          case "flatten": {
            const x = g(n.in[0]);
            r = { ...x, s: [...x.s.slice(0, a.start), size(x.s.slice(a.start, a.stop + 1)), ...x.s.slice(a.stop + 1)] };
            break;
          }
          case "squeeze": {
            const x = g(n.in[0]);
            const ax = Array.from((getCpu(n.in[1]) as Tensor).d).map((v) => (v < 0 ? v + x.s.length : v));
            r = { ...x, s: x.s.filter((v, k) => !(ax.includes(k) && v === 1)) };
            break;
          }
          case "transpose": {
            const x = g(n.in[0]);
            const perm: number[] = a.perm;
            const s = perm.map((p) => x.s[p]);
            const st = strides(x.s);
            const o = newT(s);
            copy(x, o, s, perm.map((p) => st[p]), strides(s), 0, 0);
            r = o;
            break;
          }
          case "slice": {
            const x = g(n.in[0]);
            const starts = Array.from((getCpu(n.in[1]) as Tensor).d), ends = Array.from((getCpu(n.in[2]) as Tensor).d);
            const s = x.s.slice(), st = new Array(s.length).fill(0);
            (a.axes as number[]).forEach((ax, k) => {
              const len = x.s[ax];
              let b = starts[k], e = ends[k];
              if (b < 0) b += len;
              if (e < 0) e += len;
              b = Math.max(0, Math.min(len, b));
              e = Math.max(b, Math.min(len, e));
              st[ax] = b;
              s[ax] = e - b;
            });
            const xs = strides(x.s);
            const o = newT(s);
            copy(x, o, s, xs, strides(s), st.reduce((q, v, k) => q + v * xs[k], 0), 0);
            const dec: number[] = a.decrease ?? [];
            r = { ...o, s: s.filter((_, k) => !dec.includes(k)) };
            break;
          }
          case "matmul": {
            if (a.tx || a.ty) throw new Error("matmul transpose");
            const x = g(n.in[0]), y = g(n.in[1]);
            const K = x.s[x.s.length - 1], M = x.s[x.s.length - 2] ?? 1, N = y.s[y.s.length - 1];
            if (y.s[y.s.length - 2] !== K) throw new Error(`matmul ${x.s} ${y.s}`);
            const batch = size(x.s) / (M * K), bBatch = size(y.s) / (K * N);
            const o = newT([...x.s.slice(0, -1), N]);
            const th = batch * Math.ceil(M / 4) * N;
            dispatch("matmul", [x.buf, y.buf, o.buf], [th, M, K, N, bBatch === 1 ? 0 : 1, x.off, y.off], th);
            r = o;
            break;
          }
          case "layer_norm": {
            const x = g(n.in[0]);
            if (typeof n.in[1] !== "string" || typeof n.in[2] !== "string") throw new Error("layer_norm weights");
            const L = x.s[x.s.length - 1], rows = size(x.s) / L;
            const o = newT(x.s.slice());
            dispatch("layernorm", [x.buf, this.wbuf, o.buf], [rows, L, f2u(a.eps), x.off, this.woff.get(n.in[1].slice(1))!, this.woff.get(n.in[2].slice(1))!], rows);
            r = o;
            break;
          }
          case "softmax": {
            const x = g(n.in[0]);
            let ax = a.axis ?? -1;
            if (ax < 0) ax += x.s.length;
            if (ax !== x.s.length - 1) throw new Error("softmax axis");
            const L = x.s[ax], rows = size(x.s) / L;
            const o = newT(x.s.slice());
            recs.push({ pipe: "softmax", bufs: [x.buf, o.buf], p: [rows, L, x.off], groups: [Math.min(rows, 65535), Math.ceil(rows / 65535)] });
            r = o;
            break;
          }
          default:
            throw new Error("op " + n.op + " on WebGPU");
        }
        // views share their input's buffer
        if (!Array.isArray(r) && (n.op === "reshape" || n.op === "flatten" || n.op === "squeeze")) refs.set(r.buf, (refs.get(r.buf) ?? 1) + 1);
        n.out.forEach((o) => gpu.set(o, r!));
        for (const x of n.in)
          if (typeof x === "number" && m.lastUse.get(x) === i && x !== m.meta.output) {
            const v = gpu.get(x);
            if (Array.isArray(v)) v.forEach((t) => release(t.buf));
            else if (v && x !== m.meta.input) release(v.buf);
            gpu.delete(x);
            cpu.delete(x);
          }
      }
      const out = gpu.get(m.meta.output) as GT | undefined;
      if (!out || Array.isArray(out)) {
        const c = cpu.get(m.meta.output);
        if (c && !Array.isArray(c)) return c;
        throw new Error("graph output");
      }

      // parameters: one buffer, 256-byte steps (the storage binding offset alignment)
      const step = Math.max(256, dev.limits.minStorageBufferOffsetAlignment ?? 256) / 4;
      const params = new Uint32Array(Math.max(1, recs.length) * step);
      recs.forEach((r, k) => params.set(r.p, k * step));
      const pbuf = dev.createBuffer({ size: params.byteLength, usage: STORAGE | COPY_DST });
      dev.queue.writeBuffer(pbuf, 0, params);
      fresh.push(pbuf);
      const nOut = size(out.s);
      const read = dev.createBuffer({ size: Math.max(16, nOut * 4), usage: MAP_READ | COPY_DST });
      fresh.push(read);
      dev.pushErrorScope("out-of-memory");
      dev.pushErrorScope("validation");
      // several submissions of a few dispatches: Windows resets a GPU whose command packet runs > 2 s (TDR), which
      // the first run at full page size came close to (the driver commits and clears every new buffer then)
      let enc = dev.createCommandEncoder();
      let pass = enc.beginComputePass();
      recs.forEach((r, k) => {
        if (k && k % 8 === 0) {
          pass.end();
          dev.queue.submit([enc.finish()]);
          enc = dev.createCommandEncoder();
          pass = enc.beginComputePass();
        }
        const p = this.pipe(r.pipe);
        const ins = r.bufs.slice(0, -1), o = r.bufs[r.bufs.length - 1];
        const entries = [{ binding: 0, resource: { buffer: pbuf, offset: k * step * 4, size: r.p.length * 4 } }, { binding: 1, resource: { buffer: ins[0] } }];
        if (ins.length > 1) entries.push({ binding: 2, resource: { buffer: ins[1] } });
        entries.push({ binding: 3, resource: { buffer: o } });
        // (the deformable conv's offsets and mask)
        if (ins.length > 2) entries.push({ binding: 4, resource: { buffer: ins[2] } });
        if (ins.length > 3) entries.push({ binding: 5, resource: { buffer: ins[3] } });
        pass.setPipeline(p);
        pass.setBindGroup(0, dev.createBindGroup({ layout: p.getBindGroupLayout(0), entries }));
        pass.dispatchWorkgroups(r.groups[0], r.groups[1]);
      });
      pass.end();
      enc.copyBufferToBuffer(out.buf, out.off * 4, read, 0, nOut * 4);
      dev.queue.submit([enc.finish()]);
      // both scopes popped now: another run may push its own while this one waits
      const scopes = [dev.popErrorScope(), dev.popErrorScope()];
      const errs = (await Promise.all(scopes)).filter(Boolean);
      if (errs.length) throw new Error("WebGPU: " + errs.map((e: any) => e.message).join("; "));
      await read.mapAsync(MAP_READ);
      const d = new Float32Array(read.getMappedRange().slice(0));
      read.unmap();
      if (this.lost) throw new Error("WebGPU device lost");
      return { s: out.s, d };
    } finally {
      for (const b of fresh) b.destroy();
      // everything still taken (the output and its views) goes back to the pool for the next run
      for (const [size, buf] of taken) this.free.push({ size, buf });
      if (this.free.reduce((q, f) => q + f.size, 0) > 768 << 20) this.dispose(false);
    }
  }

  /** Free the buffers (and the weights, unless only the activation cache is being trimmed). */
  dispose(weights = true) {
    if (weights) this.wbuf.destroy();
    for (const f of this.free) f.buf.destroy();
    this.free = [];
  }
}

const runners = new WeakMap<GraphModel, Promise<GraphGpu | null>>();
const live = new Set<GraphGpu>();
/** Free every runner's cached activation buffers (hundreds of MB after a full page; weights stay). Only between
 *  runs: a buffer in the cache may still be read by a run that is in flight. */
export function trimGraphGpu() {
  for (const g of live) g.dispose(false);
}
/** Free one model's runner altogether — weights and cached activations (the high-quality background removal after a
 *  minute unused: ≈ 1.3 GB). The next graphGpu(m) makes a new one. Only between runs, as trimGraphGpu. */
export async function releaseGraphGpu(m: GraphModel): Promise<boolean> {
  const r = runners.get(m);
  if (!r) return false;
  runners.delete(m);
  const g = await r;
  if (!g) return false;
  live.delete(g);
  g.dispose(true);
  return true;
}
/** The model's WebGPU runner (created once), or null where WebGPU is missing or failed. */
export function graphGpu(m: GraphModel): Promise<GraphGpu | null> {
  let r = runners.get(m);
  if (!r) {
    const p = GraphGpu.create(m).catch(() => null);
    runners.set(m, (r = p));
    // a lost device (driver reset, sleep) makes a new runner on the next call
    p.then((g) => {
      if (!g) return;
      live.add(g);
      g.gone.then(() => {
        live.delete(g);
        if (runners.get(m) === p) runners.delete(m);
      });
    });
  }
  return r;
}
