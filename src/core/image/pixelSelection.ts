// Pixel selection (선택 영역) of the image edit mode — Photoshop's marquee / lasso / magic wand selection.
//
// A selection is a page-sized 8-bit mask (255 = selected). It is view state, not document content: it is not saved,
// not undone, and it never changes the scene graph by itself. Edits that honour it (delete, fill, brush, gradient,
// layer via copy) live in ui/pixelSelect.ts. Everything here is pure (no canvas), so it is tested without a browser.

export interface SelMask {
  w: number;
  h: number;
  data: Uint8Array;
}

export type SelOp = "replace" | "add" | "subtract" | "intersect";

export function emptyMask(w: number, h: number): SelMask {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  return { w, h, data: new Uint8Array(w * h) };
}

/** Rectangle (page px; any corner order). Pixels whose centre is inside are selected. */
export function rectMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): SelMask {
  const m = emptyMask(w, h);
  const ax = Math.max(0, Math.round(Math.min(x0, x1))), bx = Math.min(m.w, Math.round(Math.max(x0, x1)));
  const ay = Math.max(0, Math.round(Math.min(y0, y1))), by = Math.min(m.h, Math.round(Math.max(y0, y1)));
  for (let y = ay; y < by; y++) m.data.fill(255, y * m.w + ax, y * m.w + bx);
  return m;
}

/** Ellipse inscribed in the rectangle (x0,y0)-(x1,y1). */
export function ellipseMask(w: number, h: number, x0: number, y0: number, x1: number, y1: number): SelMask {
  const m = emptyMask(w, h);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
  if (rx < 0.5 || ry < 0.5) return m;
  const ya = Math.max(0, Math.floor(cy - ry)), yb = Math.min(m.h - 1, Math.ceil(cy + ry));
  for (let y = ya; y <= yb; y++) {
    const dy = (y + 0.5 - cy) / ry;
    if (dy * dy > 1) continue;
    const dx = rx * Math.sqrt(1 - dy * dy);
    const a = Math.max(0, Math.round(cx - dx)), b = Math.min(m.w, Math.round(cx + dx));
    if (b > a) m.data.fill(255, y * m.w + a, y * m.w + b);
  }
  return m;
}

/** Closed polygon (lasso), even-odd rule, sampled at pixel centres. */
export function polygonMask(w: number, h: number, pts: readonly [number, number][]): SelMask {
  const m = emptyMask(w, h);
  if (pts.length < 3) return m;
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) (minY = Math.min(minY, p[1])), (maxY = Math.max(maxY, p[1]));
  const ya = Math.max(0, Math.floor(minY)), yb = Math.min(m.h - 1, Math.ceil(maxY));
  const xs: number[] = [];
  for (let y = ya; y <= yb; y++) {
    const sy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if (yi > sy !== yj > sy) xs.push(xi + ((sy - yi) * (xj - xi)) / (yj - yi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.round(xs[k])), b = Math.min(m.w, Math.round(xs[k + 1]));
      if (b > a) m.data.fill(255, y * m.w + a, y * m.w + b);
    }
  }
  return m;
}

/**
 * Magic wand: pixels whose colour is within `tolerance` (0..255, per channel, alpha included) of the clicked one;
 * `contiguous` = only those connected to it (4-neighbour flood fill), otherwise every matching pixel on the page.
 * `tiles`: `rgba` is final only in the 256 px tiles marked in `ready` (row-major, `cols` a row); a pixel the wand
 * would look at elsewhere counts as no match and its tile goes into `missing` — fill those in and run it again.
 */
export function wandMask(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  x: number,
  y: number,
  tolerance: number,
  contiguous: boolean,
  tiles?: { ready: Uint8Array; cols: number; missing: Set<number> },
): SelMask {
  const m = emptyMask(w, h);
  x = Math.floor(x);
  y = Math.floor(y);
  if (x < 0 || y < 0 || x >= w || y >= h) return m;
  const tileOf = (i: number) => (((i / w) | 0) >> 8) * tiles!.cols + ((i % w) >> 8);
  if (tiles && !tiles.ready[tileOf(y * w + x)]) {
    tiles.missing.add(tileOf(y * w + x));
    return m;
  }
  const o = (y * w + x) * 4;
  const r0 = rgba[o], g0 = rgba[o + 1], b0 = rgba[o + 2], a0 = rgba[o + 3];
  const tol = Math.max(0, tolerance);
  const near = (i: number) => {
    if (tiles) {
      const t = tileOf(i);
      if (!tiles.ready[t]) {
        tiles.missing.add(t);
        return false;
      }
    }
    const p = i * 4;
    // fully transparent pixels match each other whatever colour they carry
    if (a0 === 0 && rgba[p + 3] === 0) return true;
    return Math.abs(rgba[p] - r0) <= tol && Math.abs(rgba[p + 1] - g0) <= tol && Math.abs(rgba[p + 2] - b0) <= tol && Math.abs(rgba[p + 3] - a0) <= tol;
  };
  if (!contiguous) {
    for (let i = 0; i < w * h; i++) if (near(i)) m.data[i] = 255;
    return m;
  }
  // scanline flood fill
  const stack: number[] = [y * w + x];
  while (stack.length) {
    const i = stack.pop()!;
    if (m.data[i]) continue;
    const yy = (i / w) | 0;
    let a = i, b = i;
    const row = yy * w;
    while (a > row && !m.data[a - 1] && near(a - 1)) a--;
    while (b < row + w - 1 && !m.data[b + 1] && near(b + 1)) b++;
    m.data.fill(255, a, b + 1);
    for (const ny of [yy - 1, yy + 1]) {
      if (ny < 0 || ny >= h) continue;
      let inRun = false;
      for (let k = a; k <= b; k++) {
        const j = k + (ny - yy) * w;
        const ok = !m.data[j] && near(j);
        if (ok && !inRun) stack.push(j);
        inRun = ok;
      }
    }
  }
  return m;
}

/** Combine a new shape with the current selection (Shift = add, Alt = subtract, Shift+Alt = intersect). */
export function combine(cur: SelMask | null, next: SelMask, op: SelOp): SelMask {
  if (!cur || op === "replace" || cur.w !== next.w || cur.h !== next.h) return op === "subtract" || op === "intersect" ? (cur ?? emptyMask(next.w, next.h)) : next;
  const out = emptyMask(cur.w, cur.h);
  const a = cur.data, b = next.data, o = out.data;
  for (let i = 0; i < o.length; i++) {
    if (op === "add") o[i] = a[i] > b[i] ? a[i] : b[i];
    else if (op === "subtract") o[i] = b[i] ? Math.max(0, a[i] - b[i]) : a[i];
    else o[i] = Math.min(a[i], b[i]);
  }
  return out;
}

export function invertMask(m: SelMask): SelMask {
  const out = emptyMask(m.w, m.h);
  for (let i = 0; i < m.data.length; i++) out.data[i] = 255 - m.data[i];
  return out;
}

/** Bounding box of the selected pixels, or null when nothing is selected. */
export function maskBounds(m: SelMask): { x: number; y: number; w: number; h: number } | null {
  let x0 = m.w, y0 = m.h, x1 = -1, y1 = -1;
  for (let y = 0; y < m.h; y++) {
    const row = y * m.w;
    let a = -1, b = -1;
    for (let x = 0; x < m.w; x++)
      if (m.data[row + x]) {
        if (a < 0) a = x;
        b = x;
      }
    if (a < 0) continue;
    if (y < y0) y0 = y;
    y1 = y;
    if (a < x0) x0 = a;
    if (b > x1) x1 = b;
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

export const isEmptyMask = (m: SelMask | null) => !m || maskBounds(m) === null;

/**
 * Edges between selected and unselected pixels as segments [x0, y0, x1, y1] on pixel corners (page px), runs
 * merged — the "marching ants" outline. Capped at `limit` segments (huge noisy selections draw their bounds then).
 */
export function maskOutline(m: SelMask, limit = 200_000): number[] | null {
  const out: number[] = [];
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.data[y * m.w + x] > 127;
  // horizontal edges: between row y-1 and row y
  for (let y = 0; y <= m.h; y++) {
    let start = -1, kind = 0;
    for (let x = 0; x <= m.w; x++) {
      const k = x < m.w ? (on(x, y - 1) === on(x, y) ? 0 : on(x, y) ? 1 : 2) : 0;
      if (k !== kind) {
        if (kind) out.push(start, y, x, y);
        start = x;
        kind = k;
      }
    }
    if (out.length > limit * 4) return null;
  }
  // vertical edges: between column x-1 and column x
  for (let x = 0; x <= m.w; x++) {
    let start = -1, kind = 0;
    for (let y = 0; y <= m.h; y++) {
      const k = y < m.h ? (on(x - 1, y) === on(x, y) ? 0 : on(x, y) ? 1 : 2) : 0;
      if (k !== kind) {
        if (kind) out.push(x, start, x, y);
        start = y;
        kind = k;
      }
    }
    if (out.length > limit * 4) return null;
  }
  return out;
}

// ───────── 선택 › 수정 (Photoshop Select ▸ Modify) and 색상 범위 ─────────

/** Squared distance (px) of every pixel to the nearest pixel where `inside` holds (exact Euclidean, Felzenszwalb). */
function distance2(w: number, h: number, inside: (i: number) => boolean): Float64Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const out = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = inside(i) ? 0 : INF;
  const pass = (n: number, get: (k: number) => number, set: (k: number, val: number) => void) => {
    for (let q = 0; q < n; q++) f[q] = get(q);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let q = 0; q < n; q++) set(q, d[q]);
  };
  for (let x = 0; x < w; x++) pass(h, (y) => out[y * w + x], (y, val) => (out[y * w + x] = val));
  for (let y = 0; y < h; y++) pass(w, (x) => out[y * w + x], (x, val) => (out[y * w + x] = val));
  return out;
}

/** 확대 (Expand): every pixel within `r` px of the selection joins it (round corners, as Photoshop). */
export function expandMask(m: SelMask, r: number): SelMask {
  if (!(r > 0)) return m;
  const d = distance2(m.w, m.h, (i) => m.data[i] >= 128);
  const out = emptyMask(m.w, m.h);
  const r2 = r * r;
  for (let i = 0; i < d.length; i++) out.data[i] = d[i] <= r2 ? 255 : 0;
  return out;
}

/** 축소 (Contract): pixels within `r` px of the unselected area leave the selection (the canvas edge does not count). */
export function contractMask(m: SelMask, r: number): SelMask {
  if (!(r > 0)) return m;
  const d = distance2(m.w, m.h, (i) => m.data[i] < 128);
  const out = emptyMask(m.w, m.h);
  const r2 = r * r;
  for (let i = 0; i < d.length; i++) out.data[i] = d[i] > r2 && m.data[i] >= 128 ? 255 : 0;
  return out;
}

/** 페더 (Feather): a soft edge `r` px wide (three box blurs ≈ a Gaussian of radius r). */
export function featherMask(m: SelMask, r: number): SelMask {
  if (!(r > 0)) return m;
  const { w, h } = m;
  let a = Float32Array.from(m.data);
  let b = new Float32Array(w * h);
  // box radius for three passes approximating a Gaussian with sigma ≈ r / 2
  const k = Math.max(1, Math.round(r / 2));
  const box = (src: Float32Array, dst: Float32Array, horiz: boolean) => {
    const n = horiz ? w : h, lines = horiz ? h : w;
    for (let l = 0; l < lines; l++) {
      const at = (q: number) => (horiz ? l * w + q : q * w + l);
      let sum = 0;
      for (let q = -k; q <= k; q++) sum += src[at(Math.min(n - 1, Math.max(0, q)))];
      for (let q = 0; q < n; q++) {
        dst[at(q)] = sum / (2 * k + 1);
        sum += src[at(Math.min(n - 1, q + k + 1))] - src[at(Math.max(0, q - k))];
      }
    }
  };
  for (let i = 0; i < 3; i++) {
    box(a, b, true);
    box(b, a, false);
  }
  const out = emptyMask(w, h);
  for (let i = 0; i < a.length; i++) out.data[i] = Math.round(Math.min(255, Math.max(0, a[i])));
  return out;
}

/** 테두리 (Border): a band `r` px wide along the selection's edge. */
export function borderMask(m: SelMask, r: number): SelMask {
  const outer = expandMask(m, r / 2), inner = contractMask(m, r / 2);
  const out = emptyMask(m.w, m.h);
  for (let i = 0; i < out.data.length; i++) out.data[i] = outer.data[i] >= 128 && inner.data[i] < 128 ? 255 : 0;
  return out;
}

/**
 * 색상 범위 (Color Range): every pixel of the RGBA sample whose colour is within `fuzziness` (0…200, Photoshop's) of
 * `rgb` — fully at half the fuzziness, fading out to the full fuzziness. Transparent pixels are not selected.
 */
export function colorRangeMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, rgb: [number, number, number], fuzziness: number): SelMask {
  const out = emptyMask(w, h);
  const full = Math.max(1, fuzziness) * 0.5, edge = Math.max(1, fuzziness);
  for (let i = 0, p = 0; p < w * h; p++, i += 4) {
    if (rgba[i + 3] < 8) continue;
    const d = Math.max(Math.abs(rgba[i] - rgb[0]), Math.abs(rgba[i + 1] - rgb[1]), Math.abs(rgba[i + 2] - rgb[2]));
    out.data[p] = d <= full ? 255 : d >= edge ? 0 : Math.round((255 * (edge - d)) / (edge - full));
  }
  return out;
}
