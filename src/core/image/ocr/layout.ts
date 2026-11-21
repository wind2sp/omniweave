// OCR — layout analysis (our own, no model): ruled tables from line segments, check boxes, text lines grouped into
// blocks / paragraphs with alignment, font size and bold estimates. Input is the deskewed page.
//
//   * Tables: long horizontal / vertical ink runs (Sauvola map) → segments → grid lines per connected frame →
//     cells; a missing border between two grid cells = merged cell (colSpan / rowSpan).
//   * Check boxes: small square frames (sides ≈ 0.7–1.6 × text height) found on the same segment map; filled or
//     ticked interior → checked. Written into the text as ☐ / ☑ so the form stays a form.
//   * Paragraphs: lines in reading order (columns by horizontal overlap), joined while the gap ≤ 0.9 line height
//     and the heights match; a short last line or a first-line indent ends a paragraph.
//   * Font size: the DB core box is the shrunk text region; size ≈ core height / 0.6 (calibrated on the synthetic
//     set: the DB core is the shrunk text region). Bold: stroke width (2·ink / edge count) clearly above the page median.

import type { Box } from "./detect";

export interface Seg {
  /** fixed coordinate (y of a horizontal segment, x of a vertical one) */
  at: number;
  a: number;
  b: number;
  /** thickness px */
  t: number;
}

/** Horizontal and vertical ink runs ≥ minLen (merged across adjacent rows / columns). */
export function ruling(ink: Uint8Array, W: number, H: number, minLen: number): { h: Seg[]; v: Seg[] } {
  const scan = (horizontal: boolean): Seg[] => {
    const N = horizontal ? H : W, L = horizontal ? W : H;
    const raw: { at: number; a: number; b: number }[] = [];
    for (let i = 0; i < N; i++) {
      let run = 0, gap = 0, start = 0;
      for (let j = 0; j <= L; j++) {
        const on = j < L && ink[horizontal ? i * W + j : j * W + i];
        if (on) {
          if (run === 0) start = j;
          run = j - start + 1;
          gap = 0;
        } else if (run) {
          // bridge 1–2 px gaps (JPEG / scan dropouts)
          if (++gap <= 2 && j < L) continue;
          if (run - gap + 1 >= minLen) raw.push({ at: i, a: start, b: start + run - 1 });
          run = 0;
          gap = 0;
        }
      }
    }
    // merge runs on neighbouring rows that overlap mostly
    raw.sort((p, q) => p.at - q.at || p.a - q.a);
    const segs: (Seg & { last: number; n: number })[] = [];
    for (const r of raw) {
      const s = segs.find((s) => r.at - s.last <= 1 && Math.min(s.b, r.b) - Math.max(s.a, r.a) > 0.6 * Math.min(s.b - s.a, r.b - r.a));
      if (s) {
        s.at = (s.at * s.n + r.at) / (s.n + 1);
        s.n++;
        s.last = r.at;
        s.a = Math.min(s.a, r.a);
        s.b = Math.max(s.b, r.b);
        s.t = s.n;
      } else segs.push({ at: r.at, a: r.a, b: r.b, t: 1, last: r.at, n: 1 });
    }
    // a line thicker than ~1/4 of its length is a filled shape, not a rule
    return segs.filter((s) => s.t <= Math.max(8, (s.b - s.a) / 4)).map(({ at, a, b, t }) => ({ at, a, b, t }));
  };
  return { h: scan(true), v: scan(false) };
}

export interface CellBox {
  r: number;
  c: number;
  rs: number;
  cs: number;
  box: Box;
}

export interface TableGrid {
  box: Box;
  xs: number[];
  ys: number[];
  cells: CellBox[];
}

const cluster = (vals: number[], tol: number): number[] => {
  const s = [...vals].sort((a, b) => a - b), out: number[][] = [];
  for (const v of s) {
    const g = out[out.length - 1];
    if (g && v - g[g.length - 1] <= tol) g.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
};

/** Tables: frames of crossing horizontal + vertical segments with ≥ 2 rows or columns of cells. */
export function findTables(h: Seg[], v: Seg[], tol = 6): TableGrid[] {
  // union segments that touch (a horizontal crossing / ending at a vertical)
  const all = [...h.map((s) => ({ s, hz: true })), ...v.map((s) => ({ s, hz: false }))];
  const par = all.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < all.length; i++)
    for (let j = 0; j < all.length; j++) {
      if (!all[i].hz || all[j].hz) continue;
      const a = all[i].s, b = all[j].s;
      if (b.at >= a.a - tol && b.at <= a.b + tol && a.at >= b.a - tol && a.at <= b.b + tol) par[find(i)] = find(j);
    }
  const groups = new Map<number, { h: Seg[]; v: Seg[] }>();
  all.forEach((e, i) => {
    const g = groups.get(find(i)) ?? { h: [], v: [] };
    (e.hz ? g.h : g.v).push(e.s);
    groups.set(find(i), g);
  });
  const out: TableGrid[] = [];
  for (const g of groups.values()) {
    if (g.h.length < 2 || g.v.length < 2) continue;
    const ys = cluster(g.h.map((s) => s.at), tol), xs = cluster(g.v.map((s) => s.at), tol);
    if (ys.length < 2 || xs.length < 2 || (ys.length < 3 && xs.length < 3)) continue;
    const x0 = xs[0], x1 = xs[xs.length - 1], y0 = ys[0], y1 = ys[ys.length - 1];
    if (x1 - x0 < 60 || y1 - y0 < 30) continue;
    // border present between grid cells? (a segment covering the midpoint of that border)
    const hasH = (y: number, xa: number, xb: number) => g.h.some((s) => Math.abs(s.at - y) <= tol && s.a <= xa + (xb - xa) * 0.3 && s.b >= xb - (xb - xa) * 0.3);
    const hasV = (x: number, ya: number, yb: number) => g.v.some((s) => Math.abs(s.at - x) <= tol && s.a <= ya + (yb - ya) * 0.3 && s.b >= yb - (yb - ya) * 0.3);
    const R = ys.length - 1, C = xs.length - 1;
    const owner = new Int32Array(R * C).fill(-1);
    const cells: CellBox[] = [];
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        if (owner[r * C + c] >= 0) continue;
        let cs = 1, rs = 1;
        while (c + cs < C && !hasV(xs[c + cs], ys[r], ys[r + 1]) && owner[r * C + c + cs] < 0) cs++;
        while (r + rs < R && !hasH(ys[r + rs], xs[c], xs[c + cs])) rs++;
        for (let i = r; i < r + rs; i++) for (let j = c; j < c + cs; j++) owner[i * C + j] = cells.length;
        cells.push({ r, c, rs, cs, box: { x: xs[c], y: ys[r], w: xs[c + cs] - xs[c], h: ys[r + rs] - ys[r] } });
      }
    // a "table" of one big cell is just a frame
    if (cells.length < 2) continue;
    out.push({ box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, xs, ys, cells });
  }
  return out.sort((a, b) => a.box.y - b.box.y);
}

export interface CheckBox {
  box: Box;
  checked: boolean;
}

/** Small square frames (check boxes) between `minSide` and `maxSide`; not part of a table grid. */
export function findCheckBoxes(ink: Uint8Array, W: number, h: Seg[], v: Seg[], minSide: number, maxSide: number, tables: TableGrid[]): CheckBox[] {
  const out: CheckBox[] = [];
  const tol = 4;
  for (const top of h) {
    const len = top.b - top.a;
    if (len < minSide || len > maxSide) continue;
    if (tables.some((t) => top.at >= t.box.y - tol && top.at <= t.box.y + t.box.h + tol && top.a >= t.box.x - tol && top.b <= t.box.x + t.box.w + tol)) continue;
    const bottom = h.find((s) => s !== top && Math.abs(s.a - top.a) <= tol + 2 && Math.abs(s.b - top.b) <= tol + 2 && Math.abs(s.at - top.at - len) <= Math.max(tol + 2, len * 0.2));
    if (!bottom) continue;
    // a box frame is a thin line; the flat top of a bold O / ㅁ is a thick stroke
    if (Math.max(top.t, bottom.t) > Math.max(3, len * 0.12)) continue;
    const left = v.some((s) => Math.abs(s.at - top.a) <= tol + 2 && s.a <= top.at + tol + 2 && s.b >= bottom.at - tol - 2);
    const right = v.some((s) => Math.abs(s.at - top.b) <= tol + 2 && s.a <= top.at + tol + 2 && s.b >= bottom.at - tol - 2);
    if (!left || !right) continue;
    // interior ink (inset by the border thickness + 2)
    const ins = Math.ceil(Math.max(top.t, bottom.t)) + 2;
    let on = 0, n = 0;
    for (let y = Math.round(top.at) + ins; y < Math.round(bottom.at) - ins; y++)
      for (let x = top.a + ins; x < top.b - ins; x++) {
        n++;
        on += ink[y * W + x];
      }
    if (out.some((c) => Math.abs(c.box.x - top.a) < tol && Math.abs(c.box.y - top.at) < tol)) continue;
    // square corners (a bold O or a ring has none)
    const t0 = Math.round(top.at), b0 = Math.round(bottom.at);
    const corner = (x: number, y: number) => {
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (ink[(y + dy) * W + x + dx]) return true;
      return false;
    };
    if (!(corner(top.a + 1, t0) && corner(top.b - 1, t0) && corner(top.a + 1, b0) && corner(top.b - 1, b0))) continue;
    // straight sides: the middle of each side column is ink along most of its height
    let sideOn = 0;
    for (let y = t0 + 2; y < b0 - 1; y++) sideOn += ink[y * W + top.a] | ink[y * W + top.a + 1] | ink[y * W + top.a - 1] ? 1 : 0;
    if (sideOn < 0.8 * (b0 - t0 - 3)) continue;
    out.push({ box: { x: top.a, y: top.at, w: len, h: bottom.at - top.at }, checked: n > 0 && on / n > 0.06 });
  }
  return out;
}

/** Stroke width estimate of a region: 2·ink / (ink-to-paper transitions). */
export function strokeWidth(ink: Uint8Array, W: number, b: Box): number {
  let on = 0, edges = 0;
  const x0 = Math.max(0, Math.floor(b.x)), x1 = Math.floor(b.x + b.w), y0 = Math.max(0, Math.floor(b.y)), y1 = Math.floor(b.y + b.h);
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const v = ink[y * W + x];
      on += v;
      if (x > x0 && v !== ink[y * W + x - 1]) edges++;
    }
  return edges ? (2 * on) / edges : 0;
}

export interface LayoutLine {
  box: Box;
  core: Box;
  text: string;
  conf: number;
  stroke: number;
}

export interface Paragraph {
  lines: LayoutLine[];
  align: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY";
  /** estimated font size in image px (em) */
  size: number;
  bold: boolean;
  indent: number;
}

export interface Block {
  box: Box;
  paragraphs: Paragraph[];
}

const overlapX = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);

/** em size from the DB core height (calibrated: see tests/ocr). */
export const EM_PER_CORE = 1 / 0.6;

/** Group lines into blocks (columns kept apart) and paragraphs. `pageW` = width of the text area for alignment. */
export function groupLines(lines: LayoutLine[], strokeMedian: number): Block[] {
  const sorted = [...lines].sort((a, b) => a.box.y + a.box.h / 2 - (b.box.y + b.box.h / 2) || a.box.x - b.box.x);
  const blocks: { lines: LayoutLine[]; box: Box }[] = [];
  for (const l of sorted) {
    const h = l.core.h;
    let best: (typeof blocks)[number] | null = null;
    for (const b of blocks) {
      const last = b.lines[b.lines.length - 1];
      const gap = l.core.y - (last.core.y + last.core.h);
      const hr = h / last.core.h;
      if (gap < -0.3 * h || gap > 1.1 * Math.max(h, last.core.h) || hr < 0.75 || hr > 1.33) continue;
      if (overlapX(l.box, b.box) < 0.25 * Math.min(l.box.w, b.box.w)) continue;
      // another line of this block already shares this row → a different column / cell
      if (b.lines.some((q) => Math.abs(q.box.y + q.box.h / 2 - (l.box.y + l.box.h / 2)) < 0.5 * h)) continue;
      best = b;
    }
    if (best) {
      best.lines.push(l);
      const x0 = Math.min(best.box.x, l.box.x), y0 = Math.min(best.box.y, l.box.y);
      best.box = { x: x0, y: y0, w: Math.max(best.box.x + best.box.w, l.box.x + l.box.w) - x0, h: Math.max(best.box.y + best.box.h, l.box.y + l.box.h) - y0 };
    } else blocks.push({ lines: [l], box: { ...l.box } });
  }
  return blocks.map((b) => ({ box: b.box, paragraphs: splitParagraphs(b.lines, b.box, strokeMedian) }));
}

function splitParagraphs(lines: LayoutLine[], box: Box, strokeMedian: number): Paragraph[] {
  const paras: LayoutLine[][] = [];
  let cur: LayoutLine[] = [];
  const right = box.x + box.w;
  lines.forEach((l, i) => {
    if (cur.length) {
      const prev = cur[cur.length - 1];
      const h = l.core.h;
      const prevShort = right - (prev.box.x + prev.box.w) > 3 * h;
      const indented = l.box.x - box.x > 1.2 * h && Math.abs(prev.box.x - box.x) < 0.5 * h;
      const centered = Math.abs(l.box.x + l.box.w / 2 - (box.x + box.w / 2)) < 0.5 * h && Math.abs(prev.box.x + prev.box.w / 2 - (box.x + box.w / 2)) < 0.5 * h;
      if ((prevShort && !centered) || indented) {
        paras.push(cur);
        cur = [];
      }
    }
    cur.push(l);
    void i;
  });
  if (cur.length) paras.push(cur);
  return paras.map((ls) => {
    const h = ls.reduce((a, l) => a + l.core.h, 0) / ls.length;
    const tol = Math.max(4, 0.6 * h);
    const lefts = ls.map((l) => l.box.x - box.x), rights = ls.map((l) => right - (l.box.x + l.box.w));
    const centers = ls.map((l) => l.box.x + l.box.w / 2 - (box.x + box.w / 2));
    const body = ls.length > 1 ? ls.slice(0, -1) : ls;
    let align: Paragraph["align"] = "LEFT";
    const allL = lefts.slice(ls.length > 1 ? 1 : 0).every((v) => v < tol);
    const allR = (ls.length > 1 ? rights.slice(0, -1) : rights).every((v) => v < tol);
    const allC = centers.every((v) => Math.abs(v) < tol);
    if (ls.length > 1 && allL && allR) align = "JUSTIFY";
    else if (allC && !(allL && allR) && ls.length > 1) align = "CENTER";
    else if (allR && !allL) align = "RIGHT";
    void body;
    const stroke = ls.reduce((a, l) => a + l.stroke, 0) / ls.length;
    return {
      lines: ls,
      align,
      size: h * EM_PER_CORE,
      bold: strokeMedian > 0 && stroke > strokeMedian * 1.28,
      indent: ls.length > 1 ? Math.max(0, ls[0].box.x - ls[1].box.x) : 0,
    };
  });
}
