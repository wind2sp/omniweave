// Snapping (pure; no DOM, no store): grid, guides, page edges / centre, other objects' edges and
// centres ("smart guides"), equal spacing, and angle steps.
//
// Usage: build one SnapIndex when a gesture starts (it sorts every candidate line once), then
// query it on every pointer move — each query is a binary search, so pages with thousands of
// objects stay at frame rate. Distances are in page px; callers pass a tolerance of a fixed
// number of *screen* px divided by the zoom, so snapping feels the same at every zoom.

import type { Rect } from "./geom";
import type { GridSpec } from "./units";

export type SnapKind = "guide" | "page" | "object" | "grid";

/** A candidate line. `lo`..`hi` is its extent on the other axis (used to draw the smart guide). */
export interface SnapLine {
  v: number;
  kind: SnapKind;
  lo: number;
  hi: number;
}

export interface SnapSources {
  page?: { width: number; height: number } | null;
  guides?: { x?: number[]; y?: number[] } | null;
  grid?: GridSpec | null;
  /** page-space bounds of the other objects (never the ones being moved) */
  objects?: Rect[];
  /** which kinds take part (all by default) */
  use?: Partial<Record<SnapKind, boolean>>;
}

export interface SnapIndex {
  xs: SnapLine[];
  ys: SnapLine[];
  grid: GridSpec | null;
  objects: Rect[];
  /** objects bucketed by their vertical (rows) / horizontal (cols) extent, for equal-spacing bands */
  rows: Map<number, Rect[]>;
  cols: Map<number, Rect[]>;
}

/** bucket size of the band index, page px */
const BUCKET = 256;

function bucketize(objects: Rect[], lo: (r: Rect) => number, len: (r: Rect) => number): Map<number, Rect[]> {
  const m = new Map<number, Rect[]>();
  for (const r of objects) {
    const b0 = Math.floor(lo(r) / BUCKET), b1 = Math.floor((lo(r) + len(r)) / BUCKET);
    for (let b = b0; b <= b1 && b - b0 < 4096; b++) {
      let list = m.get(b);
      if (!list) m.set(b, (list = []));
      list.push(r);
    }
  }
  return m;
}

/** Objects overlapping [q0, q1) on the other axis (each once). */
function bandOf(buckets: Map<number, Rect[]>, q0: number, q1: number, lo: (r: Rect) => number, len: (r: Rect) => number): Rect[] {
  const out: Rect[] = [];
  const seen = new Set<Rect>();
  const b0 = Math.floor(q0 / BUCKET), b1 = Math.floor(q1 / BUCKET);
  for (let b = b0; b <= b1; b++)
    for (const r of buckets.get(b) ?? [])
      if (!seen.has(r) && lo(r) < q1 && lo(r) + len(r) > q0) {
        seen.add(r);
        out.push(r);
      }
  return out;
}

const RANK: Record<SnapKind, number> = { guide: 0, page: 1, object: 2, grid: 3 };
const byV = (a: SnapLine, b: SnapLine) => a.v - b.v || RANK[a.kind] - RANK[b.kind];

export function buildSnapIndex(src: SnapSources): SnapIndex {
  const use = { guide: true, page: true, object: true, grid: true, ...src.use };
  const xs: SnapLine[] = [];
  const ys: SnapLine[] = [];
  const pw = src.page?.width ?? 0, ph = src.page?.height ?? 0;
  if (use.page && src.page) {
    for (const v of [0, pw / 2, pw]) xs.push({ v, kind: "page", lo: 0, hi: ph });
    for (const v of [0, ph / 2, ph]) ys.push({ v, kind: "page", lo: 0, hi: pw });
  }
  if (use.guide && src.guides) {
    for (const v of src.guides.x ?? []) xs.push({ v, kind: "guide", lo: -1e6, hi: 1e6 });
    for (const v of src.guides.y ?? []) ys.push({ v, kind: "guide", lo: -1e6, hi: 1e6 });
  }
  const objects = use.object ? (src.objects ?? []).filter((r) => isFinite(r.x) && isFinite(r.y) && r.w >= 0 && r.h >= 0) : [];
  for (const r of objects) {
    const y1 = r.y + r.h, x1 = r.x + r.w;
    xs.push({ v: r.x, kind: "object", lo: r.y, hi: y1 }, { v: r.x + r.w / 2, kind: "object", lo: r.y, hi: y1 }, { v: x1, kind: "object", lo: r.y, hi: y1 });
    ys.push({ v: r.y, kind: "object", lo: r.x, hi: x1 }, { v: r.y + r.h / 2, kind: "object", lo: r.x, hi: x1 }, { v: y1, kind: "object", lo: r.x, hi: x1 });
  }
  xs.sort(byV);
  ys.sort(byV);
  const grid = use.grid && src.grid && src.grid.size > 0 ? src.grid : null;
  return {
    xs,
    ys,
    grid,
    objects,
    rows: bucketize(objects, (r) => r.y, (r) => r.h),
    cols: bucketize(objects, (r) => r.x, (r) => r.w),
  };
}

/** first index with lines[i].v >= v */
function lowerBound(lines: SnapLine[], v: number): number {
  let lo = 0, hi = lines.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (lines[m].v < v) lo = m + 1;
    else hi = m;
  }
  return lo;
}

export interface AxisHit {
  /** correction to add to the moving positions */
  delta: number;
  /** the line position snapped to */
  v: number;
  kind: SnapKind;
  /** which of the offered positions matched (index into `values`) */
  which: number;
  /** every line at exactly `v` (for drawing) */
  lines: SnapLine[];
}

const EPS = 1e-6;

/**
 * Nearest line to any of `values` (e.g. a rectangle's left, centre and right) within `tol`.
 * Ties go to guides, then page, then objects, then the grid.
 */
export function snapAxis(lines: SnapLine[], grid: GridSpec | null, values: number[], tol: number): AxisHit | null {
  let best: AxisHit | null = null;
  let bestD = Infinity;
  const consider = (d: number, v: number, kind: SnapKind, which: number) => {
    const ad = Math.abs(d);
    if (ad > tol + EPS) return;
    if (ad < bestD - EPS || (Math.abs(ad - bestD) <= EPS && best && RANK[kind] < RANK[best.kind])) {
      bestD = ad;
      best = { delta: d, v, kind, which, lines: [] };
    }
  };
  values.forEach((q, which) => {
    if (!isFinite(q)) return;
    let i = lowerBound(lines, q - tol - EPS);
    for (; i < lines.length && lines[i].v <= q + tol + EPS; i++) consider(lines[i].v - q, lines[i].v, lines[i].kind, which);
    if (grid) {
      const step = grid.size / Math.max(1, grid.sub);
      const g = Math.round(q / step) * step;
      consider(g - q, g, "grid", which);
    }
  });
  if (!best) return null;
  const hit = best as AxisHit;
  if (hit.kind !== "grid") {
    let i = lowerBound(lines, hit.v - EPS);
    for (; i < lines.length && lines[i].v <= hit.v + EPS; i++) hit.lines.push(lines[i]);
  }
  return hit;
}

/** A spacing marker: a gap from `a` to `b` along `axis`, drawn at `at` on the other axis. */
export interface GapMark {
  axis: "x" | "y";
  a: number;
  b: number;
  at: number;
}

export interface EqualHit {
  delta: number;
  gap: number;
  marks: GapMark[];
}

/**
 * Equal spacing along one axis: place `r` so its gap to the neighbour equals an existing gap
 * between two neighbours in the same row (column), or centre it between its two neighbours.
 * Only objects overlapping `r` on the other axis count as neighbours.
 */
export function equalSpacing(r: Rect, objects: Rect[] | SnapIndex, axis: "x" | "y", tol: number): EqualHit | null {
  const X = axis === "x";
  const p0 = (o: Rect) => (X ? o.x : o.y);
  const len = (o: Rect) => (X ? o.w : o.h);
  const q0 = (o: Rect) => (X ? o.y : o.x);
  const qlen = (o: Rect) => (X ? o.h : o.w);
  const rq0 = q0(r), rq1 = rq0 + qlen(r);
  const band = Array.isArray(objects)
    ? objects.filter((o) => q0(o) < rq1 && q0(o) + qlen(o) > rq0)
    : bandOf(X ? objects.rows : objects.cols, rq0, rq1, q0, qlen);
  if (!band.length) return null;
  const r0 = p0(r), rl = len(r);
  const at = rq0 + qlen(r) / 2;
  // nearest neighbours on each side (entirely before / after the moving box, within tolerance)
  let L: Rect | null = null, R: Rect | null = null;
  for (const o of band) {
    const e = p0(o) + len(o);
    if (e <= r0 + tol && (!L || e > p0(L) + len(L))) L = o;
    if (p0(o) >= r0 + rl - tol && (!R || p0(o) < p0(R))) R = o;
  }
  const cands: EqualHit[] = [];
  if (L && R) {
    const gap = (p0(R) - (p0(L) + len(L)) - rl) / 2;
    if (gap >= 0) {
      const x = p0(L) + len(L) + gap;
      cands.push({ delta: x - r0, gap, marks: [{ axis, a: p0(L) + len(L), b: x, at }, { axis, a: x + rl, b: p0(R), at }] });
    }
  }
  if (L) {
    // gap between L and its own left neighbour
    let LL: Rect | null = null;
    for (const o of band) {
      const e = p0(o) + len(o);
      if (o !== L && e <= p0(L) + EPS && (!LL || e > p0(LL) + len(LL))) LL = o;
    }
    if (LL) {
      const gap = p0(L) - (p0(LL) + len(LL));
      const x = p0(L) + len(L) + gap;
      cands.push({ delta: x - r0, gap, marks: [{ axis, a: p0(LL) + len(LL), b: p0(L), at }, { axis, a: p0(L) + len(L), b: x, at }] });
    }
  }
  if (R) {
    let RR: Rect | null = null;
    for (const o of band) if (o !== R && p0(o) >= p0(R) + len(R) - EPS && (!RR || p0(o) < p0(RR))) RR = o;
    if (RR) {
      const gap = p0(RR) - (p0(R) + len(R));
      const x = p0(R) - gap - rl;
      cands.push({ delta: x - r0, gap, marks: [{ axis, a: x + rl, b: p0(R), at }, { axis, a: p0(R) + len(R), b: p0(RR), at }] });
    }
  }
  let best: EqualHit | null = null;
  for (const c of cands) if (Math.abs(c.delta) <= tol + EPS && (!best || Math.abs(c.delta) < Math.abs(best.delta) - EPS)) best = c;
  return best;
}

export interface SnapOptions {
  x?: boolean;
  y?: boolean;
  /** also look for equal spacing between objects (moving whole boxes only) */
  equal?: boolean;
  /** which positions of the box take part: edges and centre (default) or only edges */
  centers?: boolean;
}

export interface RectSnap {
  dx: number;
  dy: number;
  x: AxisHit | null;
  y: AxisHit | null;
  gaps: GapMark[];
}

/** Snap a moving box. Returns the correction to add and what it snapped to. */
export function snapRect(ix: SnapIndex, r: Rect, tol: number, opts: SnapOptions = {}): RectSnap {
  const out: RectSnap = { dx: 0, dy: 0, x: null, y: null, gaps: [] };
  const centers = opts.centers !== false;
  const vx = centers ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.x, r.x + r.w];
  const vy = centers ? [r.y, r.y + r.h / 2, r.y + r.h] : [r.y, r.y + r.h];
  if (opts.x !== false) {
    out.x = snapAxis(ix.xs, ix.grid, vx, tol);
    if (opts.equal) {
      const e = equalSpacing(r, ix, "x", tol);
      if (e && (!out.x || Math.abs(e.delta) < Math.abs(out.x.delta) - EPS)) {
        out.x = null;
        out.dx = e.delta;
        out.gaps.push(...e.marks);
      }
    }
    if (out.x) out.dx = out.x.delta;
  }
  if (opts.y !== false) {
    out.y = snapAxis(ix.ys, ix.grid, vy, tol);
    if (opts.equal) {
      const e = equalSpacing({ ...r, x: r.x + out.dx }, ix, "y", tol);
      if (e && (!out.y || Math.abs(e.delta) < Math.abs(out.y.delta) - EPS)) {
        out.y = null;
        out.dy = e.delta;
        out.gaps.push(...e.marks);
      }
    }
    if (out.y) out.dy = out.y.delta;
  }
  // horizontal gap markers sit at the box's final vertical centre (vertical ones already use the final x)
  for (const g of out.gaps) if (g.axis === "x") g.at += out.dy;
  return out;
}

export interface PointSnap {
  x: number;
  y: number;
  hx: AxisHit | null;
  hy: AxisHit | null;
}

/** Snap a single point (pen anchors, shape corners, resize handles). */
export function snapPoint(ix: SnapIndex, px: number, py: number, tol: number): PointSnap {
  const hx = snapAxis(ix.xs, ix.grid, [px], tol);
  const hy = snapAxis(ix.ys, ix.grid, [py], tol);
  return { x: px + (hx?.delta ?? 0), y: py + (hy?.delta ?? 0), hx, hy };
}

/** Angle in degrees snapped to multiples of `step` when within `tol` degrees (always, when `force`). */
export function snapAngle(deg: number, step = 15, tol = 4, force = false): number {
  const s = Math.round(deg / step) * step;
  return force || Math.abs(s - deg) <= tol ? s : deg;
}

/** A line segment to draw for a smart guide (page space). */
export interface GuideSeg {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Segments for the "pink lines": each object / page line hit is drawn from the moving box to the
 * farthest object on that line. Grid and guide hits are not drawn (the grid / guide is visible).
 */
export function smartGuideSegments(r: Rect, s: { x: AxisHit | null; y: AxisHit | null }): GuideSeg[] {
  const segs: GuideSeg[] = [];
  if (s.x && s.x.kind !== "grid" && s.x.kind !== "guide") {
    let lo = r.y, hi = r.y + r.h;
    for (const l of s.x.lines) if (l.kind === "object" || l.kind === "page") (lo = Math.min(lo, l.lo)), (hi = Math.max(hi, l.hi));
    segs.push({ x0: s.x.v, y0: lo, x1: s.x.v, y1: hi });
  }
  if (s.y && s.y.kind !== "grid" && s.y.kind !== "guide") {
    let lo = r.x, hi = r.x + r.w;
    for (const l of s.y.lines) if (l.kind === "object" || l.kind === "page") (lo = Math.min(lo, l.lo)), (hi = Math.max(hi, l.hi));
    segs.push({ x0: lo, y0: s.y.v, x1: hi, y1: s.y.v });
  }
  return segs;
}

/** Keep only the objects near the visible area (fewer candidates on huge pages). */
export function nearRect(objects: Rect[], view: Rect, margin: number): Rect[] {
  const x0 = view.x - margin, y0 = view.y - margin, x1 = view.x + view.w + margin, y1 = view.y + view.h + margin;
  return objects.filter((o) => o.x <= x1 && o.x + o.w >= x0 && o.y <= y1 && o.y + o.h >= y0);
}
