// 3-D charts (표 계산 3차원 차트) drawn in depth the way Excel draws them: c:view3D's rotX / rotY / perspective /
// depthPercent / rAngAx, the box autoscaled to the plot area, gridlines on the back and side walls, walls / floor fills,
// 3-D columns (clustered, stacked, 100 %, standard rows), 3-D lines (ribbons), 3-D areas (slabs), surfaces (value bands
// in the bandFmt colours, contour from above) and 3-D pies (an elliptical pie with its rim). Faces are shaded as Excel's
// default lighting does (top ≈ 70 %, side ≈ 60 %, the pie rim darker to the right) and painted back to front.
// Part of the lazy chart chunk (render/sheetChart.ts).

import { formatValue, type SheetLang } from "../io/sheet/numfmt";
import { autoColor, fmtVal, fontOf, scale, text, type Ax, type Ctx, type Group, type Model, type View3D } from "./sheetChart";

type P2 = [number, number];
type P3 = [number, number, number];

export interface Env3D {
  ctx: Ctx;
  m: Model;
  z: number;
  family: string;
  lang: SheetLang;
  /** the room left for the plot once the title and legend are placed */
  left: number;
  top: number;
  right: number;
  bottom: number;
  colorOf: (g: Group, k: number, i?: number) => string;
  /** surface charts: the value length the legend's bands were made for (the plot uses the same bands) */
  surfLen?: number;
}

/** A colour (#RRGGBB) darkened to f of itself; other colour strings come back unchanged. */
export function shade(c: string, f: number): string {
  const h = /^#?([0-9a-f]{6})$/i.exec(c)?.[1];
  if (!h) return c;
  const v = [0, 2, 4].map((i) => Math.round(Math.max(0, Math.min(255, parseInt(h.slice(i, i + 2), 16) * f))));
  return "#" + v.map((n) => n.toString(16).padStart(2, "0")).join("").toUpperCase();
}

const RAD = Math.PI / 180;
export const MAX_3D_POINTS = 4000;

export interface Cam {
  /** world (x across the categories, y up the values, z back from the front; box W × H × D) to the canvas */
  P: (p: P3) => P2;
  /** distance from the viewer (bigger = farther) */
  far: (p: P3) => number;
  W: number;
  H: number;
  D: number;
}

/**
 * The camera for a box W (= 1) × H × D seen as c:view3D says: right-angle axes keep the front face square to the
 * viewer and draw depth obliquely (sin rotY across, sin rotX · cos rotY up); otherwise the box turns rotY about the
 * vertical, tilts rotX and is seen in perspective (Excel's "perspective" angle). The height H is chosen so the
 * projected box fills the rectangle (Excel's autoscaling), then the picture is scaled and centred into it.
 */
export function camera(v: View3D, D: number, rect: { x: number; y: number; w: number; h: number }, bars = false): Cam {
  const W = 1;
  const rx = v.rotX * RAD, ry = v.rotY * RAD;
  const persp = !v.rAng && v.perspective > 0;
  // Excel's perspective (30 by default) as a viewing distance; measured on its 3-D line chart: 1.79 box widths at 30
  const dist = persp ? Math.max(0.48 / Math.tan(Math.min(v.perspective, 200) * 0.5 * RAD), 1.2 * Math.hypot(0.5, D / 2, 0.5)) : 0;
  const raw = (H: number) => (p: P3): [number, number, number] => {
    if (v.rAng) return [p[0] + p[2] * Math.sin(ry), p[1] + p[2] * Math.sin(rx) * Math.cos(ry), p[2]];
    const x = p[0] - W / 2, y = p[1] - H / 2, zz = p[2] - D / 2;
    const x1 = x * Math.cos(ry) + zz * Math.sin(ry), z1 = -x * Math.sin(ry) + zz * Math.cos(ry);
    const y2 = y * Math.cos(rx) + z1 * Math.sin(rx), z2 = -y * Math.sin(rx) + z1 * Math.cos(rx);
    const f = persp ? dist / Math.max(1e-3, dist + z2) : 1;
    return [x1 * f, y2 * f, z2];
  };
  const box = (H: number) => {
    const f = raw(H);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const cx of [0, W]) for (const cy of [0, H]) for (const cz of [0, D]) {
      const q = f([cx, cy, cz]);
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    return { x0, x1, y0, y1 };
  };
  // autoscale: the height whose picture has the rectangle's proportions (between a flat slab and a tall tower)
  const want = rect.h / Math.max(1, rect.w);
  let lo = 0.05, hi = 6;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    const b = box(mid);
    if ((b.y1 - b.y0) / (b.x1 - b.x0) > want) hi = mid;
    else lo = mid;
  }
  // turned boxes (no right-angle axes, with or without perspective) keep the height to the room's proportions whatever
  // the depth or the angles: measured on Excel's pictures at 0/0, 15/20, 15/300, 30/40 and perspective 0 / 30 / 80 —
  // lines, areas and surfaces 0.6 of the room (their best fits 0.6 at 15/20 in all five pictures), columns 0.8 (best
  // 0.7–0.9), and never less than filling the room (columns seen straight on, rotX = rotY = 0, fill it). Right-angle
  // axes fill the room.
  const H = v.rAng ? lo : Math.max(0.05, bars ? Math.max(0.8 * want, lo) : 0.6 * want);
  const b = box(H);
  const s = Math.min(rect.w / (b.x1 - b.x0 || 1), rect.h / (b.y1 - b.y0 || 1));
  const tx = rect.x + (rect.w - s * (b.x1 - b.x0)) / 2 - s * b.x0;
  const ty = rect.y + (rect.h - s * (b.y1 - b.y0)) / 2 + s * b.y1;
  const f = raw(H);
  return {
    P: (p) => {
      const q = f(p);
      return [tx + s * q[0], ty - s * q[1]];
    },
    far: (p) => (v.rAng ? p[2] - p[0] * 1e-3 * Math.sign(v.rotY || 1) : f(p)[2]),
    W,
    H,
    D,
  };
}

function poly(ctx: Ctx, pts: P2[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
}
/** signed area of a projected face: > 0 when it faces the viewer (faces are listed counter-clockwise from outside) */
const facing = (q: P2[]) => {
  let a = 0;
  for (let i = 0; i < q.length; i++) {
    const [x0, y0] = q[i], [x1, y1] = q[(i + 1) % q.length];
    a += x0 * y1 - x1 * y0;
  }
  return a < 0; // canvas y runs down
};

/** Surface band scale (no headroom over the data, as Excel's surface charts): the steps both the plot and the legend use. */
export function surfaceScale(m: Model, plotLen: number, fontPx: number) {
  const vAx = [...m.axes.values()].find((a) => a.kind === "val");
  let lo = Infinity, hi = -Infinity;
  for (const g of m.groups) for (const s of g.sers) for (const v of s.vals) if (typeof v === "number" && Number.isFinite(v)) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  const vs = scale(lo, hi, vAx, plotLen, fontPx, false);
  if (vAx?.max == null && Number.isFinite(hi)) vs.max = Math.max(vs.min + vs.step, Math.ceil(hi / vs.step - 1e-9) * vs.step);
  return vs;
}

/** Legend entries of a surface chart: one per value band ("0-50", "50-100", …) in the band colours. */
export function surfaceLegend(m: Model, plotLen: number, fontPx: number, lang: SheetLang): { label: string; color: string }[] {
  const g = m.groups[0];
  const vs = surfaceScale(m, plotLen, fontPx);
  const vAx = [...m.axes.values()].find((a) => a.kind === "val");
  const f = (v: number) => fmtVal(Math.abs(v) < vs.step * 1e-9 ? 0 : v, vAx?.fmt && vAx.fmt !== "General" ? vAx.fmt : undefined, lang);
  const out: { label: string; color: string }[] = [];
  for (let k = 0; vs.min + vs.step * k < vs.max - vs.step * 1e-6 && k < 60; k++) out.push({ label: `${f(vs.min + vs.step * k)}-${f(vs.min + vs.step * (k + 1))}`, color: g.bands.get(k) ?? autoColor(m.theme, k) });
  return out;
}

/** Paint a 3-D column / line / area / surface chart into the room env gives. */
export function paint3D(env: Env3D): void {
  const { ctx, m, z, family, lang } = env;
  const v = m.view3D!;
  const g = m.groups[0];
  const kind = g.kind.replace("3D", "");
  const axes = [...m.axes.values()];
  const vAx = axes.find((a) => a.kind === "val");
  const cAx = axes.find((a) => a.kind === "cat" || a.kind === "date");
  const sAx = axes.find((a) => a.kind === "ser");
  const px = (pt: number) => ((pt * 96) / 72) * z;
  const vText = vAx?.text ?? m.base, cText = cAx?.text ?? m.base, sText = sAx?.text ?? m.base;
  const vfs = px(vText.size), cfs = px(cText.size);
  const surface = kind === "surface";
  const nSer = g.sers.length;
  // Excel draws at most 4000 points of a series in a 3-D chart (its documented limit): more would only be sub-pixel
  // faces, and a hostile file must not keep the UI busy
  const nCat = Math.min(MAX_3D_POINTS, Math.max(1, ...g.sers.map((s) => Math.max(s.vals.length, s.xs.length))));
  const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
  const percent = g.grouping === "percentStacked";
  const rows = surface || (g.grouping === "standard" && nSer > 1) ? nSer : 1;
  const edges = surface || (kind !== "bar" && vAx?.between === false);
  // box: width 1, a band per category; a row is a bar (or ribbon) and its gap in depth
  const band = 1 / Math.max(1, edges ? Math.max(1, nCat - 1) : nCat);
  const ns = kind === "bar" && g.grouping === "clustered" ? nSer : 1;
  const bw = kind === "bar" ? band / (ns + g.gap / 100) : band / (1 + g.gap / 100);
  // a row of a line / area / surface is a category's width deep (also when the points sit on the band edges); fitted
  // on Excel's 3-D line and surface pictures
  const rowD = kind === "bar" ? (bw * (1 + g.gapDepth / 100) * v.depth) / 100 : v.depth / 100 / nCat;
  const objD = kind === "bar" ? (bw * v.depth) / 100 : rowD / (1 + g.gapDepth / 100);
  const D = rows * rowD;
  // values (stacks summed; 100 % stacks as fractions)
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const totals = Array.from({ length: nCat }, (_, i) => g.sers.reduce((a, s) => a + Math.abs(num(s.vals[i]) ?? 0), 0) || 1);
  const val = (k: number, i: number) => {
    const t = num(g.sers[k].vals[i]);
    return t == null ? null : percent ? t / totals[i] : t;
  };
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < nCat; i++) {
    let pos = 0, neg = 0;
    for (let k = 0; k < nSer; k++) {
      const t = val(k, i);
      if (t == null) continue;
      if (stacked) {
        if (t >= 0) pos += t;
        else neg += t;
      } else (lo = Math.min(lo, t)), (hi = Math.max(hi, t));
    }
    if (stacked) (lo = Math.min(lo, neg)), (hi = Math.max(hi, pos));
  }
  if (!Number.isFinite(lo)) (lo = 0), (hi = 1);
  // values near the double limit: a scale whose span still is a finite number (bigger values sit on its ends)
  (lo = Math.max(-1e300, lo)), (hi = Math.min(1e300, hi));
  const vScale = (len: number) => {
    if (surface) return surfaceScale(m, env.surfLen ?? len, vfs);
    const r = scale(lo, hi, vAx, len, vfs, percent);
    // Excel's 3-D value axis ends at the first step at or over the data, without the 2-D charts' headroom (measured:
    // data up to 150 → 150 in steps of 50, 160 in steps of 20)
    if (!percent && vAx?.max == null && hi > 0 && Number.isFinite(hi)) r.max = Math.max(r.min + r.step, Math.ceil(hi / r.step - 1e-9) * r.step);
    return r;
  };
  const valFmt = (t: number) => (percent ? formatValue(t, vAx?.fmt && !vAx.linked ? vAx.fmt : "0%", { lang }).text : fmtVal(t, vAx?.fmt && (!vAx.linked || vAx.fmt !== "General") ? vAx.fmt : g.sers[0]?.fmt, lang));
  const labelsOf = (vs: { min: number; max: number; step: number }) => {
    const out: number[] = [];
    for (let t = vs.min, k = 0; t <= vs.max + vs.step * 1e-6 && k < 200; k++, t = vs.min + vs.step * k) out.push(Math.abs(t) < vs.step * 1e-9 ? 0 : t);
    return out;
  };
  const shown = (a: Ax | undefined) => !!a && !a.del && a.lblPos !== "none";
  const cats: string[] = [];
  const ref = g.sers.find((s) => s.xs.length);
  for (let i = 0; i < nCat; i++) cats.push(ref ? fmtVal(ref.xs[i] ?? "", cAx?.fmt && !cAx.linked ? cAx.fmt : ref.xFmt, lang) : String(i + 1));
  // room: value labels on the left, series labels on the right, category labels under the front edge
  let vs = vScale((env.bottom - env.top) * 0.6);
  ctx.font = fontOf(vText, z, family);
  const vGap = 11 * z;
  const vLabW = shown(vAx) ? Math.max(0, ...labelsOf(vs).map((t) => ctx.measureText(valFmt(t)).width)) : 0;
  ctx.font = fontOf(sText, z, family);
  const sGap = 12 * z;
  const sLabW = rows > 1 && shown(sAx) ? Math.max(0, ...g.sers.map((s) => ctx.measureText(s.name).width)) + sGap : 0;
  // measured on Excel's pictures: a right-angle-axes box sits about 12 px (at 100 %) in from the value labels and 20 px
  // in from the right; a box in perspective fills the room
  const rect = { x: env.left + (vLabW ? vLabW + vGap : 0) + (v.rAng ? 12 : 2) * z, y: env.top + vfs * 0.5 + (v.rAng ? 8 : 6) * z, w: 0, h: 0 };
  rect.w = Math.max(8, env.right - sLabW - (v.rAng ? 20 * z : 0) - rect.x);
  rect.h = Math.max(8, env.bottom - (shown(cAx) ? cfs * 3.4 : cfs) - rect.y);
  const cam = camera(v, D, rect, kind === "bar");
  const { P, H, W } = cam;
  vs = vScale(Math.abs(P([0, H, 0])[1] - P([0, 0, 0])[1]));
  // (halves: a scale of ±1e308 must not overflow to Infinity / Infinity)
  const yOf = (t: number) => ((Math.max(vs.min, Math.min(vs.max, t)) / 2 - vs.min / 2) / (vs.max / 2 - vs.min / 2 || 1)) * H;
  const xOf = (i: number) => (edges ? i * band : (i + 0.5) * band);
  const lr = v.rAng ? v.rotY % 360 < 180 : Math.sin(v.rotY * RAD) >= 0; // the left side is the far one
  const sideX = lr ? 0 : W;
  const lw = Math.max(1, 0.75 * z);
  // walls and floor
  const fillQ = (q: P3[], c: string) => {
    poly(ctx, q.map(P));
    ctx.fillStyle = c;
    ctx.fill();
  };
  if (v.floor) fillQ([[0, 0, 0], [W, 0, 0], [W, 0, D], [0, 0, D]], v.floor);
  if (v.backWall) fillQ([[0, 0, D], [W, 0, D], [W, H, D], [0, H, D]], v.backWall);
  if (v.sideWall) fillQ([[sideX, 0, 0], [sideX, 0, D], [sideX, H, D], [sideX, H, 0]], v.sideWall);
  // gridlines on the back and side walls
  const line = (a: P3, b: P3) => {
    const p = P(a), q = P(b);
    ctx.moveTo(p[0], p[1]);
    ctx.lineTo(q[0], q[1]);
  };
  const vl = labelsOf(vs);
  ctx.lineWidth = lw;
  if (vAx?.grid) {
    ctx.strokeStyle = vAx.grid;
    ctx.beginPath();
    for (const t of vl) {
      const y = yOf(t);
      line([sideX, y, 0], [sideX, y, D]);
      line([0, y, D], [W, y, D]);
    }
    ctx.stroke();
  }
  if (cAx?.grid) {
    ctx.strokeStyle = cAx.grid;
    ctx.beginPath();
    for (let i = 0; i <= nCat; i++) {
      const x = edges ? i * band : i * band;
      if (x > W + 1e-9) break;
      line([x, 0, D], [x, H, D]);
      line([x, 0, 0], [x, 0, D]);
    }
    ctx.stroke();
  }
  // axis lines on the floor's front and right edges, the value axis up the front-left edge
  const tk = 4 * z;
  if (cAx && !cAx.del && cAx.line) {
    ctx.strokeStyle = cAx.line;
    ctx.beginPath();
    line([0, 0, 0], [W, 0, 0]);
    if (cAx.tick !== "none")
      for (let i = 0; i <= (edges ? nCat - 1 : nCat); i++) {
        const p = P([i * band, 0, 0]);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(p[0], p[1] + tk);
      }
    ctx.stroke();
  }
  if (rows > 1 && sAx && !sAx.del && sAx.line) {
    ctx.strokeStyle = sAx.line;
    ctx.beginPath();
    line([W, 0, 0], [W, 0, D]);
    if (sAx.tick !== "none")
      for (let r = 0; r <= rows; r++) {
        const p = P([W, 0, surface ? (r * D) / Math.max(1, rows - 1) : r * rowD]);
        if (surface && r >= rows) break;
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(p[0], p[1] + tk);
      }
    ctx.stroke();
  }
  if (vAx && !vAx.del && vAx.line) {
    ctx.strokeStyle = vAx.line;
    ctx.beginPath();
    line([0, 0, 0], [0, H, 0]);
    ctx.stroke();
  }
  // ───── the data, back to front ─────
  const rowOrder = Array.from({ length: rows }, (_, r) => rows - 1 - r);
  const catOrder = Array.from({ length: nCat }, (_, i) => (lr ? i : nCat - 1 - i));
  const face = (q: P3[], c: string, cull = true) => {
    const p = q.map(P);
    if (cull && !facing(p)) return;
    poly(ctx, p);
    ctx.fillStyle = c;
    ctx.fill();
    // a hairline of the same colour closes the seams between neighbouring faces
    ctx.strokeStyle = c;
    ctx.lineWidth = 0.5;
    ctx.stroke();
  };
  if (kind === "bar") {
    const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, c: string) => {
      if (y1 < y0) [y0, y1] = [y1, y0];
      const top = shade(c, 0.7), side = shade(c, 0.6);
      face([[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]].reverse() as P3[], c); // back
      face([[x0, y0, z0], [x0, y0, z1], [x1, y0, z1], [x1, y0, z0]], top); // bottom
      face([[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]], side); // left
      face([[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], side); // right
      face([[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], top); // top
      face([[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], c); // front
    };
    for (const r of rowOrder)
      for (const i of catOrder) {
        const ks = rows > 1 ? [r] : Array.from({ length: nSer }, (_, k) => (lr ? k : nSer - 1 - k));
        let pos = 0, neg = 0;
        const z0 = r * rowD + (rowD - objD) / 2;
        for (const k of ks) {
          const t = val(k, i);
          if (t == null) continue;
          let a = 0, b = t;
          if (stacked) {
            if (t >= 0) (a = pos), (b = pos += t);
            else (a = neg), (b = neg += t);
          }
          const slot = ns > 1 ? k : 0;
          const x0 = i * band + (band - ns * bw) / 2 + slot * bw;
          box(x0, x0 + bw, yOf(Math.max(vs.min, Math.min(a, b))), yOf(Math.max(a, b)), z0, z0 + objD, env.colorOf(g, k, g.sers[k].pts.has(i) || (g.vary && nSer === 1) ? i : undefined));
        }
      }
  } else if (kind === "line" || kind === "area") {
    const base = new Array(nCat).fill(0);
    const order = rows > 1 ? rowOrder : Array.from({ length: nSer }, (_, k) => k);
    for (const r of order) {
      const k = r;
      const c = env.colorOf(g, k);
      const z0 = (rows > 1 ? r * rowD : 0) + (rowD - objD) / 2, z1 = z0 + objD;
      const tops: (number | null)[] = [], bots: number[] = [];
      for (let i = 0; i < nCat; i++) {
        const t = val(k, i);
        bots.push(stacked ? base[i] : 0);
        if (t == null) tops.push(kind === "area" ? (stacked ? base[i] : 0) : null);
        else tops.push(stacked ? (base[i] += t) : t);
      }
      // segments far to near
      const segs = Array.from({ length: Math.max(0, nCat - 1) }, (_, i) => i).filter((i) => tops[i] != null && tops[i + 1] != null);
      segs.sort((a, b) => cam.far([xOf(b + 0.5), 0, (z0 + z1) / 2]) - cam.far([xOf(a + 0.5), 0, (z0 + z1) / 2]));
      if (kind === "line") {
        for (const i of segs) {
          const ya = yOf(tops[i]!), yb = yOf(tops[i + 1]!);
          face([[xOf(i), ya, z0], [xOf(i + 1), yb, z0], [xOf(i + 1), yb, z1], [xOf(i), ya, z1]], shade(c, 0.8), false);
        }
      } else {
        const n = nCat;
        const ys = tops.map((t) => yOf(t ?? 0)), yb = bots.map((t) => yOf(t));
        const front: P3[] = [...ys.map((y, i) => [xOf(i), y, z0] as P3), ...yb.map((y, i) => [xOf(i), y, z0] as P3).reverse()];
        const back: P3[] = front.map((p) => [p[0], p[1], z1] as P3);
        face(back, c, false);
        const endL: P3[] = [[xOf(0), yb[0], z0], [xOf(0), yb[0], z1], [xOf(0), ys[0], z1], [xOf(0), ys[0], z0]];
        const endR: P3[] = [[xOf(n - 1), yb[n - 1], z0], [xOf(n - 1), ys[n - 1], z0], [xOf(n - 1), ys[n - 1], z1], [xOf(n - 1), yb[n - 1], z1]];
        if (!lr) face(endR, shade(c, 0.6), false);
        else face(endL, shade(c, 0.6), false);
        for (const i of segs) face([[xOf(i), ys[i], z0], [xOf(i + 1), ys[i + 1], z0], [xOf(i + 1), ys[i + 1], z1], [xOf(i), ys[i], z1]], shade(c, 0.7), false);
        if (lr) face(endR, shade(c, 0.6), false);
        else face(endL, shade(c, 0.6), false);
        face(front, c, false);
      }
    }
  } else if (surface) {
    // a grid over categories × series; each cell split in two triangles, each triangle cut along the value bands
    const zs = (r: number) => (rows > 1 ? (r * D) / (rows - 1) : 0);
    const cells: { i: number; r: number; far: number }[] = [];
    for (let r = 0; r < Math.max(1, rows - 1); r++) for (let i = 0; i < nCat - 1; i++) cells.push({ i, r, far: cam.far([xOf(i + 0.5), 0, zs(r) + (zs(r + 1) - zs(r)) / 2]) });
    cells.sort((a, b) => b.far - a.far);
    const bandColor = (k: number) => g.bands.get(k) ?? autoColor(m.theme, k);
    const nb = Math.max(1, Math.round((vs.max - vs.min) / vs.step));
    const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
      // a, b, c: [x, value, z]; the pieces of the triangle between band edges
      // lit from above, a little from the front-left: facets turned to the back are darker
      const lit = (() => {
        const A = [a[0], yOf(a[1]), a[2]], B = [b[0], yOf(b[1]), b[2]], C = [c[0], yOf(c[1]), c[2]];
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], w2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        let n = [u[1] * w2[2] - u[2] * w2[1], u[2] * w2[0] - u[0] * w2[2], u[0] * w2[1] - u[1] * w2[0]];
        if (n[1] < 0) n = n.map((t) => -t);
        const len = Math.hypot(n[0], n[1], n[2]) || 1;
        const dot = (-0.3 * n[0] + n[1] - 0.6 * n[2]) / len / Math.hypot(0.3, 1, 0.6);
        return Math.min(1, 0.62 + 0.5 * dot);
      })();
      // only the bands this triangle reaches
      const tLo = Math.min(a[1], b[1], c[1]), tHi = Math.max(a[1], b[1], c[1]);
      const k0 = Math.max(0, Math.floor((tLo - vs.min) / vs.step) - 1), k1 = Math.min(nb, Math.ceil((tHi - vs.min) / vs.step) + 1);
      for (let k = k0; k < k1; k++) {
        const b0 = vs.min + k * vs.step, b1 = b0 + vs.step;
        // clip the polygon to b0 <= value <= b1
        let pts: [number, number, number][] = [a, b, c];
        for (const [lim, keepAbove] of [[b0, true], [b1, false]] as [number, boolean][]) {
          const out: [number, number, number][] = [];
          for (let j = 0; j < pts.length; j++) {
            const p = pts[j], q = pts[(j + 1) % pts.length];
            const pin = keepAbove ? p[1] >= lim : p[1] <= lim, qin = keepAbove ? q[1] >= lim : q[1] <= lim;
            if (pin) out.push(p);
            if (pin !== qin) {
              const f = (lim - p[1]) / (q[1] - p[1]);
              out.push([p[0] + (q[0] - p[0]) * f, lim, p[2] + (q[2] - p[2]) * f]);
            }
          }
          pts = out;
          if (pts.length < 3) break;
        }
        if (pts.length < 3) continue;
        const c2 = g.wireframe ? null : shade(bandColor(k), lit);
        const q = pts.map((p) => P([p[0], yOf(p[1]), p[2]]));
        poly(ctx, q);
        if (c2) {
          ctx.fillStyle = c2;
          ctx.fill();
          ctx.strokeStyle = c2;
          ctx.lineWidth = 0.5;
          ctx.stroke();
        } else {
          ctx.strokeStyle = bandColor(k);
          ctx.lineWidth = lw;
          ctx.stroke();
        }
      }
    };
    const at = (i: number, r: number): [number, number, number] => [xOf(i), Math.max(vs.min, Math.min(vs.max, num(g.sers[r]?.vals[i]) ?? vs.min)), zs(r)];
    for (const { i, r } of cells) {
      if (rows < 2) {
        tri(at(i, 0), at(i + 1, 0), [xOf(i + 1), vs.min, 0]);
        continue;
      }
      tri(at(i, r), at(i + 1, r), at(i + 1, r + 1));
      tri(at(i, r), at(i + 1, r + 1), at(i, r + 1));
    }
  }
  // ───── labels ─────
  if (shown(vAx)) {
    ctx.font = fontOf(vText, z, family);
    ctx.fillStyle = vText.color;
    for (const t of vl) {
      const p = P([0, yOf(t), 0]);
      text(ctx, valFmt(t), p[0] - vGap, p[1], "right");
    }
  }
  if (shown(cAx)) {
    ctx.font = fontOf(cText, z, family);
    ctx.fillStyle = cText.color;
    const span = Math.abs(P([W, 0, 0])[0] - P([0, 0, 0])[0]) / Math.max(1, nCat);
    const widest = Math.max(1, ...cats.map((c) => ctx.measureText(c).width));
    const every = Math.max(1, Math.ceil((widest + 4 * z) / Math.max(1, span)));
    cats.forEach((c, i) => {
      if (i % every) return;
      const p = P([xOf(i), 0, 0]);
      text(ctx, c, p[0], p[1] + cfs * 1.62, "center");
    });
  }
  if (rows > 1 && shown(sAx)) {
    ctx.font = fontOf(sText, z, family);
    ctx.fillStyle = sText.color;
    g.sers.forEach((s, r) => {
      const p = P([W, 0, surface ? (rows > 1 ? (r * D) / (rows - 1) : 0) : (r + 0.5) * rowD]);
      text(ctx, s.name, p[0] + sGap, p[1], "left");
    });
  }
}

/** Paint a 3-D pie into the plot rectangle: the top an ellipse (sin rotX of the width), the rim below it shaded. */
export function paintPie3D(env: Env3D, rect: { x: number; y: number; w: number; h: number }, labelRoom: boolean): void {
  const { ctx, m, z, family, lang } = env;
  const v = m.view3D!;
  const g = m.groups[0];
  const s = g.sers[0];
  // a disc of radius 1 and height T tilted rotX and seen in perspective; measured on Excel's 30° pie: the back half
  // 74 px, the front half 106 px, the rim 44 px deep for a 382 px wide pie (tilt ≈ 0.95 × sin rotX, viewer 5 radii away)
  const sa = Math.sin(Math.max(5, Math.min(85, v.rotX)) * RAD) * 0.95, ca = Math.sqrt(1 - sa * sa);
  const dist = v.perspective > 0 ? Math.max(1.6, 1.305 / Math.tan(Math.min(v.perspective, 200) * 0.5 * RAD)) : 1e6;
  const T = 0.212;
  const proj = (a: number, h: number, r = 1): P2 => {
    const zz = r * Math.cos(a);
    const f = dist / (dist + (-h * sa + zz * ca));
    return [r * Math.sin(a) * f, (h * ca + zz * sa) * f];
  };
  let mx = 0, top = -Infinity, bot = Infinity;
  for (let j = 0; j < 72; j++) {
    const a = (j / 72) * Math.PI * 2;
    const p = proj(a, 0), q = proj(a, -T);
    mx = Math.max(mx, Math.abs(p[0]));
    top = Math.max(top, p[1]);
    bot = Math.min(bot, q[1]);
  }
  const fill = labelRoom ? 0.82 : 0.86;
  const sc = Math.max(2, Math.min((rect.w / 2 / mx) * (labelRoom ? 0.82 : 0.94), (rect.h * fill) / (top - bot)));
  const cx = rect.x + rect.w / 2, y0 = rect.y + rect.h / 2 - 2 * z + (sc * (top + bot)) / 2;
  // finite positive values, as shares of the biggest (two values near the double limit must not sum to Infinity)
  const raw = s.vals.map((t) => (typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 0));
  const big = Math.max(0, ...raw) || 1;
  const vals = raw.map((t) => t / big);
  const total = vals.reduce((a, b) => a + b, 0) || 1;
  const pt = (a: number, h = 0, r = 1): P2 => {
    const q = proj(a, h, r);
    return [cx + sc * q[0], y0 - sc * q[1]];
  };
  const rX = sc * mx;
  const slices: { a0: number; a1: number; i: number; c: string }[] = [];
  let a = ((g.first || 0) * RAD) % (Math.PI * 2);
  vals.forEach((t, i) => {
    const a1 = a + (t / total) * Math.PI * 2;
    if (t > 0) slices.push({ a0: a, a1, i, c: env.colorOf(g, 0, i) });
    a = a1;
  });
  const arc = (a0: number, a1: number, h: number, out: P2[]) => {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.03));
    for (let j = 0; j <= n; j++) out.push(pt(a0 + ((a1 - a0) * j) / n, h));
  };
  // the rim: the front half (from 3 to 9 o'clock through 6), lit from the left
  const stops = [[0, 1], [0.25, 0.98], [0.5, 0.55], [0.75, 0.4], [1, 0.33]];
  for (const sl of slices)
    for (let turn = -1; turn <= 2; turn++) {
      const lo = Math.PI / 2 + turn * Math.PI * 2, hi = lo + Math.PI;
      const a0 = Math.max(sl.a0, lo), a1 = Math.min(sl.a1, hi);
      if (a1 <= a0) continue;
      const q: P2[] = [];
      arc(a0, a1, 0, q);
      const back: P2[] = [];
      arc(a0, a1, -T, back);
      q.push(...back.reverse());
      poly(ctx, q);
      // (a context without gradients — a stand-in in tests — gets the rim's middle shade)
      let gr: CanvasGradient | undefined;
      try {
        gr = ctx.createLinearGradient(cx - rX, 0, cx + rX, 0);
        if (gr && typeof gr.addColorStop === "function") for (const [o, f] of stops) gr.addColorStop(o, shade(sl.c, f));
        else gr = undefined;
      } catch {
        gr = undefined;
      }
      ctx.fillStyle = gr ?? shade(sl.c, 0.55);
      ctx.fill();
    }
  // the top: elliptical slices with white seams
  for (const sl of slices) {
    const q: P2[] = [pt(0, 0, 0)];
    arc(sl.a0, sl.a1, 0, q);
    poly(ctx, q);
    ctx.fillStyle = sl.c;
    ctx.fill();
    ctx.strokeStyle = "#FFFFFF";
    ctx.lineWidth = 1 * z;
    ctx.stroke();
  }
  const lb = s.labels ?? g.labels;
  if (lb && (lb.val || lb.pct || lb.cat || lb.ser)) {
    ctx.font = fontOf(lb.text, z, family);
    ctx.fillStyle = lb.text.color;
    for (const sl of slices) {
      const parts: string[] = [];
      if (lb.ser) parts.push(s.name);
      if (lb.cat) parts.push(fmtVal(s.xs[sl.i] ?? sl.i + 1, s.xFmt, lang));
      if (lb.val) parts.push(fmtVal(s.vals[sl.i], lb.fmt ?? s.fmt, lang));
      if (lb.pct) parts.push(formatValue(vals[sl.i] / total, "0%", { lang }).text);
      const am = (sl.a0 + sl.a1) / 2;
      const f = lb.pos === "outEnd" ? 1.15 : lb.pos === "inEnd" ? 0.8 : lb.pos === "ctr" ? 0.5 : 0.62;
      const p = pt(am, 0, f);
      text(ctx, parts.join(", "), p[0], p[1], "center");
    }
  }
}
