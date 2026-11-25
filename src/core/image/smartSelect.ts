// Selection helpers of Photoshop's W group, pure (page-sized RGBA in, page-sized SelMask out):
//   quickSelectMask   빠른 선택: painted over an area, the selection flows out to similar colours next to the stroke,
//                     stopping at edges (a colour step between neighbours) and at a band round the stroke
//   objectSelectMask  개체 선택: a box round an object; colours near the box edge are the background, the middle the
//                     object (a few colour clusters each, refined twice), then the largest piece with its holes filled

import type { SelMask } from "./pixelSelection";

const d2 = (d: Uint8ClampedArray | Uint8Array, i: number, r: number, g: number, b: number) => {
  const e0 = d[i] - r, e1 = d[i + 1] - g, e2 = d[i + 2] - b;
  return e0 * e0 + e1 * e1 + e2 * e2;
};

/** Quick selection of a stroke through `pts` (page px) with brush radius `r`. */
export function quickSelectMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, pts: readonly [number, number][], r: number): SelMask {
  const out: SelMask = { w, h, data: new Uint8Array(w * h) };
  if (!pts.length) return out;
  // how far the selection may flow from the stroke (Photoshop's quick selection takes a uniform area whole)
  const L = Math.max(160, r * 10);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x - L); y0 = Math.min(y0, y - L); x1 = Math.max(x1, x + L); y1 = Math.max(y1, y + L);
  }
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0)); x1 = Math.min(w - 1, Math.ceil(x1)); y1 = Math.min(h - 1, Math.ceil(y1));
  if (x1 < x0 || y1 < y0) return out;
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  // how far each pixel of the box is from the stroke (in the band or not), and the seeds under the brush
  const near = new Uint8Array(bw * bh);
  const seed: number[] = [];
  let sr = 0, sg = 0, sb = 0, sq = 0;
  const stamp = (cx: number, cy: number, rad: number, f: (i: number, gi: number) => void) => {
    for (let y = Math.max(y0, Math.floor(cy - rad)); y <= Math.min(y1, Math.ceil(cy + rad)); y++)
      for (let x = Math.max(x0, Math.floor(cx - rad)); x <= Math.min(x1, Math.ceil(cx + rad)); x++)
        if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= rad * rad) f((y - y0) * bw + x - x0, y * w + x);
  };
  for (const [cx, cy] of pts) {
    stamp(cx, cy, L, (i) => (near[i] = 1));
    stamp(cx, cy, r, (i, gi) => {
      if (near[i] === 2) return;
      near[i] = 2;
      seed.push(i);
      const o = gi * 4;
      sr += rgba[o]; sg += rgba[o + 1]; sb += rgba[o + 2];
    });
  }
  if (!seed.length) return out;
  const n = seed.length;
  const mr = sr / n, mg = sg / n, mb = sb / n;
  for (const i of seed) {
    const gi = ((((i / bw) | 0) + y0) * w + (i % bw) + x0) * 4;
    sq += d2(rgba, gi, mr, mg, mb);
  }
  const sd = Math.sqrt(sq / n);
  const T = Math.min(80, Math.max(22, 2.2 * sd + 16));
  const T2 = T * T, E2 = (T * 0.75) ** 2;
  const sel = new Uint8Array(bw * bh);
  const queue = new Int32Array(bw * bh);
  let qh = 0, qt = 0;
  for (const i of seed) {
    sel[i] = 1;
    queue[qt++] = i;
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % bw, y = (i / bw) | 0;
    const gi = ((y + y0) * w + x + x0) * 4;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const X = x + dx, Y = y + dy;
      if (X < 0 || Y < 0 || X >= bw || Y >= bh) continue;
      const j = Y * bw + X;
      if (sel[j] || !near[j]) continue;
      const gj = ((Y + y0) * w + X + x0) * 4;
      if (d2(rgba, gj, mr, mg, mb) > T2) continue;
      // an edge: a colour step between the two neighbours
      if (d2(rgba, gj, rgba[gi], rgba[gi + 1], rgba[gi + 2]) > E2) continue;
      sel[j] = 1;
      queue[qt++] = j;
    }
  }
  fillHoles(sel, bw, bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (sel[y * bw + x]) out.data[(y + y0) * w + x + x0] = 255;
  return out;
}

/** Pixels not reachable from the box border through unselected pixels become selected (holes filled). */
function fillHoles(sel: Uint8Array, w: number, h: number) {
  const seen = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let qh = 0, qt = 0;
  const push = (i: number) => {
    if (sel[i] || seen[i]) return;
    seen[i] = 1;
    q[qt++] = i;
  };
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x));
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1));
  while (qh < qt) {
    const i = q[qh++];
    const x = i % w, y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  for (let i = 0; i < w * h; i++) if (!sel[i] && !seen[i]) sel[i] = 1;
}

/** k-means centres (RGB) of the sampled pixels. */
function kmeans(rgba: Uint8ClampedArray | Uint8Array, idx: number[], k: number): number[][] {
  if (!idx.length) return [];
  const step = Math.max(1, Math.floor(idx.length / 4000));
  const sample = idx.filter((_, i) => i % step === 0);
  const c: number[][] = [];
  for (let j = 0; j < k; j++) {
    const o = sample[Math.floor(((j + 0.5) / k) * sample.length)] * 4;
    c.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
  }
  for (let it = 0; it < 6; it++) {
    const acc = c.map(() => [0, 0, 0, 0]);
    for (const p of sample) {
      const o = p * 4;
      let best = 0, bd = Infinity;
      for (let j = 0; j < c.length; j++) {
        const d = d2(rgba, o, c[j][0], c[j][1], c[j][2]);
        if (d < bd) ((bd = d), (best = j));
      }
      const a = acc[best];
      a[0] += rgba[o]; a[1] += rgba[o + 1]; a[2] += rgba[o + 2]; a[3]++;
    }
    for (let j = 0; j < c.length; j++) if (acc[j][3]) c[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
  }
  return c;
}

const nearest = (rgba: Uint8ClampedArray | Uint8Array, o: number, cs: number[][]) => {
  let bd = Infinity;
  for (const c of cs) bd = Math.min(bd, d2(rgba, o, c[0], c[1], c[2]));
  return bd;
};

/** Object selection inside `rect` (page px); null when nothing stands out from the background. */
export function objectSelectMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, rect: { x: number; y: number; w: number; h: number }): SelMask | null {
  const rx = Math.max(0, Math.floor(rect.x)), ry = Math.max(0, Math.floor(rect.y));
  const rw = Math.min(w - rx, Math.ceil(rect.w)), rh = Math.min(h - ry, Math.ceil(rect.h));
  if (rw < 4 || rh < 4) return null;
  const band = Math.max(2, Math.round(Math.min(rw, rh) * 0.04));
  const bg: number[] = [], fg: number[] = [];
  for (let y = ry; y < ry + rh; y++)
    for (let x = rx; x < rx + rw; x++) {
      const i = y * w + x;
      const e = Math.min(x - rx, y - ry, rx + rw - 1 - x, ry + rh - 1 - y);
      if (e < band) bg.push(i);
      else if (Math.abs(x - (rx + rw / 2)) < rw * 0.25 && Math.abs(y - (ry + rh / 2)) < rh * 0.25) fg.push(i);
    }
  // just outside the box is background too
  for (let x = rx; x < rx + rw; x++) for (const y of [ry - 3, ry + rh + 2]) if (y >= 0 && y < h) bg.push(y * w + x);
  for (let y = ry; y < ry + rh; y++) for (const x of [rx - 3, rx + rw + 2]) if (x >= 0 && x < w) bg.push(y * w + x);
  let cb = kmeans(rgba, bg, 6), cf = kmeans(rgba, fg, 6);
  const lab = new Uint8Array(rw * rh);
  for (let pass = 0; pass < 3; pass++) {
    const nf: number[] = [], nb: number[] = [...bg];
    for (let y = 0; y < rh; y++)
      for (let x = 0; x < rw; x++) {
        const i = (y + ry) * w + x + rx;
        const e = Math.min(x, y, rw - 1 - x, rh - 1 - y);
        const v = e >= band && nearest(rgba, i * 4, cf) * 1.15 < nearest(rgba, i * 4, cb) ? 1 : 0;
        lab[y * rw + x] = v;
        if (v) nf.push(i);
        else nb.push(i);
      }
    if (nf.length < 16) return null;
    cf = kmeans(rgba, nf, 6);
    cb = kmeans(rgba, nb, 6);
  }
  // smooth: majority of the 3 × 3 neighbourhood, twice
  for (let k = 0; k < 2; k++) {
    const src = lab.slice();
    for (let y = 1; y < rh - 1; y++)
      for (let x = 1; x < rw - 1; x++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += src[(y + dy) * rw + x + dx];
        lab[y * rw + x] = s >= 5 ? 1 : 0;
      }
  }
  // the largest connected piece, holes filled
  const comp = new Int32Array(rw * rh).fill(-1);
  let best = -1, bestN = 0, id = 0;
  const q = new Int32Array(rw * rh);
  for (let s = 0; s < rw * rh; s++) {
    if (!lab[s] || comp[s] >= 0) continue;
    let qh = 0, qt = 0;
    q[qt++] = s;
    comp[s] = id;
    while (qh < qt) {
      const i = q[qh++];
      const x = i % rw, y = (i / rw) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < rw - 1 ? i + 1 : -1, y > 0 ? i - rw : -1, y < rh - 1 ? i + rw : -1]) {
        if (j < 0 || !lab[j] || comp[j] >= 0) continue;
        comp[j] = id;
        q[qt++] = j;
      }
    }
    if (qt > bestN) ((bestN = qt), (best = id));
    id++;
  }
  if (best < 0 || bestN < 16) return null;
  const sel = new Uint8Array(rw * rh);
  for (let i = 0; i < rw * rh; i++) sel[i] = comp[i] === best ? 1 : 0;
  fillHoles(sel, rw, rh);
  const out: SelMask = { w, h, data: new Uint8Array(w * h) };
  for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) if (sel[y * rw + x]) out.data[(y + ry) * w + x + rx] = 255;
  return out;
}
