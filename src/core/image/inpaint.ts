// Retouching kernels (Photoshop's 내용 인식 채우기 / 스팟 복구 브러시 / 복구 브러시 / 패치), pure and DOM-free:
//
//   inpaint(img, hole)           content-aware fill: patch-based (PatchMatch nearest-neighbour fields with
//                                Wexler-style voting, coarse to fine) — the hole is rebuilt from the picture's own
//                                patches, so texture and edges continue into it
//   healBlend(dst, src, mask)    healing: the source's texture with the destination's colour and light — the
//                                difference dst − src along the mask's border, spread smoothly inside (a membrane /
//                                Laplace solve, coarse to fine), added to the source
//
// Images are straight RGBA 8-bit (core/image/pixels.ts Img); masks are one byte per pixel (>0 = in).

import type { Img } from "./pixels";

const R = 3; // patch radius: 7 × 7 patches
const CH = 4;

interface Level {
  w: number;
  h: number;
  /** colours 0..255, 4 per pixel */
  c: Float32Array;
  /** 1 = hole */
  hole: Uint8Array;
}

function downLevel(l: Level): Level {
  const w = Math.max(1, l.w >> 1), h = Math.max(1, l.h >> 1);
  const c = new Float32Array(w * h * CH), hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let n = 0, hc = 0;
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(l.w - 1, 2 * x + dx), sy = Math.min(l.h - 1, 2 * y + dy);
          const i = sy * l.w + sx;
          if (l.hole[i]) {
            hc++;
            continue;
          }
          for (let k = 0; k < CH; k++) acc[k] += l.c[i * CH + k];
          n++;
        }
      const o = y * w + x;
      // a coarse pixel is a hole when any of its four is (the hole never shrinks going down)
      hole[o] = hc ? 1 : 0;
      for (let k = 0; k < CH; k++) c[o * CH + k] = n ? acc[k] / n : 0;
    }
  return { w, h, c, hole };
}

/** Fill the hole of a (small) level by repeated averaging of the known neighbours — a smooth first guess. */
function diffuseFill(l: Level) {
  const { w, h, c, hole } = l;
  const known = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) known[i] = hole[i] ? 0 : 1;
  let left = hole.reduce((a, b) => a + b, 0);
  for (let pass = 0; left > 0 && pass < w + h; pass++) {
    const next = known.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let n = 0;
        const acc = [0, 0, 0, 0];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const j = Y * w + X;
          if (!known[j]) continue;
          for (let k = 0; k < CH; k++) acc[k] += c[j * CH + k];
          n++;
        }
        if (!n) continue;
        for (let k = 0; k < CH; k++) c[i * CH + k] = acc[k] / n;
        next[i] = 1;
        left--;
      }
    known.set(next);
  }
}

/** Patch centres a source patch may sit on: whole patch inside the level and free of the hole. */
function validSources(l: Level): Int32Array {
  const { w, h, hole } = l;
  // a summed-area table of the hole: a patch is free when its sum is 0
  const sat = new Int32Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += hole[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const out: number[] = [];
  for (let y = R; y < h - R; y++)
    for (let x = R; x < w - R; x++) {
      const s = sat[(y + R + 1) * (w + 1) + x + R + 1] - sat[(y - R) * (w + 1) + x + R + 1] - sat[(y + R + 1) * (w + 1) + x - R] + sat[(y - R) * (w + 1) + x - R];
      if (!s) out.push(y * w + x);
    }
  return Int32Array.from(out);
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Sum of squared differences of the patches at a (target) and b (source), stopping past `cap`. */
function patchDist(l: Level, ax: number, ay: number, bx: number, by: number, cap: number): number {
  const { w, h, c } = l;
  let d = 0;
  for (let dy = -R; dy <= R; dy++) {
    const y1 = ay + dy, y2 = by + dy;
    if (y1 < 0 || y1 >= h) continue;
    for (let dx = -R; dx <= R; dx++) {
      const x1 = ax + dx, x2 = bx + dx;
      if (x1 < 0 || x1 >= w) continue;
      const i = (y1 * w + x1) * CH, j = (y2 * w + x2) * CH;
      for (let k = 0; k < CH; k++) {
        const e = c[i + k] - c[j + k];
        d += e * e;
      }
    }
    if (d > cap) return d;
  }
  return d;
}

/**
 * One level of the fill: nearest-neighbour field for every target pixel (a pixel whose patch touches the hole),
 * then each hole pixel becomes the average of what the patches over it vote for. `nnf` (source index per target, −1
 * none) comes from the coarser level, or is drawn at random.
 */
function solveLevel(l: Level, nnf: Int32Array, iters: number, rand: () => number) {
  const { w, h, hole } = l;
  const src = validSources(l);
  if (!src.length) return;
  // targets: the hole grown by the patch radius
  const tgt: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let near = false;
      for (let dy = -R; dy <= R && !near; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < w && Y < h && hole[Y * w + X]) {
            near = true;
            break;
          }
        }
      if (near) tgt.push(y * w + x);
    }
  const isSrc = new Uint8Array(w * h);
  for (const s of src) isSrc[s] = 1;
  const dist = new Float64Array(w * h).fill(Infinity);
  for (const p of tgt) {
    if (nnf[p] < 0 || !isSrc[nnf[p]]) nnf[p] = src[(rand() * src.length) | 0];
    dist[p] = patchDist(l, p % w, (p / w) | 0, nnf[p] % w, (nnf[p] / w) | 0, Infinity);
  }
  const tryOne = (p: number, q: number) => {
    if (q < 0 || !isSrc[q] || q === nnf[p]) return;
    const d = patchDist(l, p % w, (p / w) | 0, q % w, (q / w) | 0, dist[p]);
    if (d < dist[p]) {
      dist[p] = d;
      nnf[p] = q;
    }
  };
  const maxR = Math.max(w, h);
  for (let em = 0; em < iters; em++) {
    // PatchMatch: propagate from the neighbours (scan order alternates), then search around at shrinking radii
    for (let pass = 0; pass < 2; pass++) {
      const fwd = pass % 2 === 0;
      for (let ti = 0; ti < tgt.length; ti++) {
        const p = tgt[fwd ? ti : tgt.length - 1 - ti];
        const x = p % w, y = (p / w) | 0;
        const s = fwd ? -1 : 1;
        for (const [dx, dy] of [[s, 0], [0, s]]) {
          const X = x + dx, Y = y + dy;
          if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
          const nq = nnf[Y * w + X];
          if (nq < 0) continue;
          const qx = (nq % w) - dx, qy = ((nq / w) | 0) - dy;
          if (qx >= 0 && qy >= 0 && qx < w && qy < h) tryOne(p, qy * w + qx);
        }
        const bx = nnf[p] % w, by = (nnf[p] / w) | 0;
        for (let r = maxR; r >= 1; r >>= 1) {
          const qx = Math.round(bx + (rand() * 2 - 1) * r), qy = Math.round(by + (rand() * 2 - 1) * r);
          if (qx >= 0 && qy >= 0 && qx < w && qy < h) tryOne(p, qy * w + qx);
        }
      }
    }
    // voting: each hole pixel = mean of the source pixels the overlapping patches put on it
    const acc = new Float64Array(w * h * CH), wt = new Float64Array(w * h);
    for (const p of tgt) {
      const q = nnf[p];
      if (q < 0) continue;
      const px = p % w, py = (p / w) | 0, qx = q % w, qy = (q / w) | 0;
      const wgt = Math.exp(-dist[p] / (49 * 2 * 40 * 40 * CH));
      for (let dy = -R; dy <= R; dy++) {
        const Y = py + dy;
        if (Y < 0 || Y >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const X = px + dx;
          if (X < 0 || X >= w) continue;
          const o = Y * w + X;
          if (!hole[o]) continue;
          const sj = ((qy + dy) * w + qx + dx) * CH;
          for (let k = 0; k < CH; k++) acc[o * CH + k] += l.c[sj + k] * wgt;
          wt[o] += wgt;
        }
      }
    }
    for (let o = 0; o < w * h; o++) if (hole[o] && wt[o] > 0) for (let k = 0; k < CH; k++) l.c[o * CH + k] = acc[o * CH + k] / wt[o];
    // distances against the new colours
    for (const p of tgt) dist[p] = nnf[p] >= 0 ? patchDist(l, p % w, (p / w) | 0, nnf[p] % w, (nnf[p] / w) | 0, Infinity) : Infinity;
  }
}

/** Box of the mask's set pixels, or null. */
export function maskBox(mask: Uint8Array, w: number, h: number): { x: number; y: number; w: number; h: number } | null {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Content-aware fill: the pixels under `hole` (>0) rebuilt from the rest of the picture (a band around the hole as
 * wide as the hole itself, at least 32 px). Returns a new image; pixels outside the hole are unchanged. `seed` makes
 * the result repeatable.
 */
export function inpaint(img: Img, hole: Uint8Array, seed = 1): Img {
  const W = img.width, H = img.height;
  const out: Img = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
  const hb = maskBox(hole, W, H);
  if (!hb) return out;
  const m = Math.max(32, Math.ceil(Math.max(hb.w, hb.h) * 1.0));
  const x0 = Math.max(0, hb.x - m), y0 = Math.max(0, hb.y - m), x1 = Math.min(W, hb.x + hb.w + m), y1 = Math.min(H, hb.y + hb.h + m);
  const w = x1 - x0, h = y1 - y0;
  const base: Level = { w, h, c: new Float32Array(w * h * CH), hole: new Uint8Array(w * h) };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + y0) * W + x + x0, o = y * w + x;
      base.hole[o] = hole[i] ? 1 : 0;
      for (let k = 0; k < CH; k++) base.c[o * CH + k] = img.data[i * 4 + k];
    }
  // the whole crop a hole (nothing to copy from): leave it
  if (base.hole.every((v) => v)) return out;
  const levels: Level[] = [base];
  while (levels.length < 8) {
    const l = levels[levels.length - 1];
    const b = maskBox(l.hole, l.w, l.h);
    if (!b || Math.max(b.w, b.h) <= 12 || l.w < 4 * R + 4 || l.h < 4 * R + 4) break;
    levels.push(downLevel(l));
  }
  const rand = rng(seed);
  let nnf: Int32Array | null = null;
  for (let li = levels.length - 1; li >= 0; li--) {
    const l = levels[li];
    if (li === levels.length - 1) diffuseFill(l);
    else {
      // colours of the hole from the coarser level (nearest), the field doubled
      const c = levels[li + 1];
      const up = new Int32Array(l.w * l.h).fill(-1);
      for (let y = 0; y < l.h; y++)
        for (let x = 0; x < l.w; x++) {
          const cx = Math.min(c.w - 1, x >> 1), cy = Math.min(c.h - 1, y >> 1);
          const o = y * l.w + x;
          if (l.hole[o]) for (let k = 0; k < CH; k++) l.c[o * CH + k] = c.c[(cy * c.w + cx) * CH + k];
          const q = nnf![cy * c.w + cx];
          if (q >= 0) {
            const qx = Math.min(l.w - 1, (q % c.w) * 2 + (x & 1)), qy = Math.min(l.h - 1, ((q / c.w) | 0) * 2 + (y & 1));
            up[o] = qy * l.w + qx;
          }
        }
      nnf = up;
    }
    if (!nnf) nnf = new Int32Array(l.w * l.h).fill(-1);
    solveLevel(l, nnf, li === 0 ? 3 : 4, rand);
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      if (!base.hole[o]) continue;
      const i = ((y + y0) * W + x + x0) * 4;
      for (let k = 0; k < CH; k++) out.data[i + k] = Math.round(base.c[o * CH + k]);
    }
  return out;
}

/**
 * Healing: inside `mask` (>0, its value the blend 0..255), the source's texture (`src`) carried over in the
 * destination's colour and light. The difference dst − src is known just outside the mask; it is spread inside as a
 * membrane (Laplace solve, coarse to fine) and added to src. Same size images; returns a new one.
 */
export function healBlend(dst: Img, src: Img, mask: Uint8Array): Img {
  const W = dst.width, H = dst.height;
  const out: Img = { width: W, height: H, data: new Uint8ClampedArray(dst.data) };
  const b = maskBox(mask, W, H);
  if (!b) return out;
  const x0 = Math.max(0, b.x - 2), y0 = Math.max(0, b.y - 2), x1 = Math.min(W, b.x + b.w + 2), y1 = Math.min(H, b.y + b.h + 2);
  const w = x1 - x0, h = y1 - y0;
  // the difference field, 3 colour channels; `fix` = known (outside the mask)
  const f = new Float32Array(w * h * 3);
  const fix = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((y + y0) * W + x + x0) * 4, o = y * w + x;
      fix[o] = mask[(y + y0) * W + x + x0] ? 0 : 1;
      if (fix[o]) for (let k = 0; k < 3; k++) f[o * 3 + k] = dst.data[i + k] - src.data[i + k];
    }
  solveMembrane(f, fix, w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * w + x, gi = (y + y0) * W + x + x0;
      const mv = mask[gi];
      if (!mv) continue;
      const i = gi * 4, a = mv / 255;
      for (let k = 0; k < 3; k++) {
        const healed = src.data[i + k] + f[o * 3 + k];
        out.data[i + k] = Math.round(dst.data[i + k] + (healed - dst.data[i + k]) * a);
      }
      out.data[i + 3] = Math.round(dst.data[i + 3] + (src.data[i + 3] - dst.data[i + 3]) * a);
    }
  return out;
}

/** Laplace solve of `f` where fix = 0 (fixed values elsewhere), 3 channels: coarse grid first, then Gauss-Seidel. */
function solveMembrane(f: Float32Array, fix: Uint8Array, w: number, h: number) {
  if (w > 24 && h > 24) {
    const cw = (w + 1) >> 1, ch = (h + 1) >> 1;
    const cf = new Float32Array(cw * ch * 3), cfix = new Uint8Array(cw * ch);
    for (let y = 0; y < ch; y++)
      for (let x = 0; x < cw; x++) {
        let n = 0;
        const acc = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const X = 2 * x + dx, Y = 2 * y + dy;
            if (X >= w || Y >= h || !fix[Y * w + X]) continue;
            for (let k = 0; k < 3; k++) acc[k] += f[(Y * w + X) * 3 + k];
            n++;
          }
        // a coarse cell is fixed only when all of it is (the border stays exact on the fine grid)
        if (n === 4) {
          cfix[y * cw + x] = 1;
          for (let k = 0; k < 3; k++) cf[(y * cw + x) * 3 + k] = acc[k] / 4;
        } else if (n) for (let k = 0; k < 3; k++) cf[(y * cw + x) * 3 + k] = acc[k] / n;
      }
    solveMembrane(cf, cfix, cw, ch);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = y * w + x;
        if (fix[o]) continue;
        const c = ((y >> 1) * cw + (x >> 1)) * 3;
        for (let k = 0; k < 3; k++) f[o * 3 + k] = cf[c + k];
      }
  }
  const iters = w > 24 && h > 24 ? 30 : 200;
  for (let it = 0; it < iters; it++)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const o = y * w + x;
        if (fix[o]) continue;
        let n = 0;
        let a0 = 0, a1 = 0, a2 = 0;
        if (x > 0) ((a0 += f[(o - 1) * 3]), (a1 += f[(o - 1) * 3 + 1]), (a2 += f[(o - 1) * 3 + 2]), n++);
        if (x < w - 1) ((a0 += f[(o + 1) * 3]), (a1 += f[(o + 1) * 3 + 1]), (a2 += f[(o + 1) * 3 + 2]), n++);
        if (y > 0) ((a0 += f[(o - w) * 3]), (a1 += f[(o - w) * 3 + 1]), (a2 += f[(o - w) * 3 + 2]), n++);
        if (y < h - 1) ((a0 += f[(o + w) * 3]), (a1 += f[(o + w) * 3 + 1]), (a2 += f[(o + w) * 3 + 2]), n++);
        if (!n) continue;
        f[o * 3] = a0 / n;
        f[o * 3 + 1] = a1 / n;
        f[o * 3 + 2] = a2 / n;
      }
}

/**
 * Spot healing's source (Photoshop's 근접 일치): the offset, among a ring of candidates around the spot, whose patch
 * border matches the spot's surroundings best. Returns [dx, dy] to add to a spot pixel to find its source.
 */
export function proximityOffset(img: Img, mask: Uint8Array): [number, number] {
  const W = img.width, H = img.height;
  const b = maskBox(mask, W, H);
  if (!b) return [0, 0];
  const ring: number[] = [];
  // the band just outside the spot (up to 3 px)
  for (let y = Math.max(0, b.y - 3); y < Math.min(H, b.y + b.h + 3); y++)
    for (let x = Math.max(0, b.x - 3); x < Math.min(W, b.x + b.w + 3); x++) {
      if (mask[y * W + x]) continue;
      let near = false;
      for (let dy = -3; dy <= 3 && !near; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const X = x + dx, Y = y + dy;
          if (X >= 0 && Y >= 0 && X < W && Y < H && mask[Y * W + X]) {
            near = true;
            break;
          }
        }
      if (near) ring.push(y * W + x);
    }
  const r = Math.max(b.w, b.h);
  let best: [number, number] = [r, 0], bestD = Infinity;
  for (const k of [1.2, 1.8, 2.6])
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const dx = Math.round(Math.cos(ang) * r * k), dy = Math.round(Math.sin(ang) * r * k);
      if (b.x + dx < 0 || b.y + dy < 0 || b.x + b.w + dx > W || b.y + b.h + dy > H) continue;
      let d = 0;
      for (const p of ring) {
        const x = p % W, y = (p / W) | 0;
        const q = ((y + dy) * W + x + dx) * 4;
        for (let c = 0; c < 3; c++) {
          const e = img.data[p * 4 + c] - img.data[q + c];
          d += e * e;
        }
        if (d >= bestD) break;
      }
      // the source itself must not be in the spot
      let overlaps = false;
      for (let y = b.y; y < b.y + b.h && !overlaps; y += 2)
        for (let x = b.x; x < b.x + b.w; x += 2) if (mask[y * W + x] && mask[(y + dy) * W + x + dx]) { overlaps = true; break; }
      if (!overlaps && d < bestD) ((bestD = d), (best = [dx, dy]));
    }
  return best;
}

/** `img` shifted: out(x, y) = img(x + dx, y + dy) (edge pixels repeat). */
export function shifted(img: Img, dx: number, dy: number): Img {
  const W = img.width, H = img.height;
  const out: Img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  for (let y = 0; y < H; y++) {
    const sy = Math.min(H - 1, Math.max(0, y + dy));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x + dx));
      const i = (y * W + x) * 4, j = (sy * W + sx) * 4;
      out.data[i] = img.data[j];
      out.data[i + 1] = img.data[j + 1];
      out.data[i + 2] = img.data[j + 2];
      out.data[i + 3] = img.data[j + 3];
    }
  }
  return out;
}
