// Chartex charts (Excel 2016's new chart kinds, ECMA-376 extension cx: — 폭포·히스토그램·파레토·상자 수염·트리맵·선버스트·
// 깔때기형) drawn flat in Excel 2016's default look: waterfall (running total, subtotal points from zero, increase /
// decrease / total colours), histogram (Scott's bin width or the file's bin size / count, intervals "[a, b]" "(b, c]"),
// pareto (histogram of the categories sorted, with the cumulative % line), box & whisker (exclusive / inclusive
// quartiles, 1.5 IQR whiskers, mean marker, outliers), treemap (squarified), sunburst (rings), funnel. Data come from the
// workbook cells the series point at (hidden names _xlchart.v1.N), else the part's cached levels. A region map is not
// drawn — a note says so. Part of the lazy chart chunk (render/sheetChart.ts).

import { formatValue, type SheetLang } from "../io/sheet/numfmt";
import { attr, child, children, descendants, parseXml, textOf } from "../io/xml";
import { DICTS } from "../i18n";
import { AUTO_TITLE, autoColor, fmtVal, scale, spFill, text, textOfTx, type Ctx, type RefValues, type Val } from "./sheetChart";
import { shade as shadeHex } from "./sheetChart3D";

interface Dim {
  type: string;
  /** levels, leaf first */
  lvls: Val[][];
  fmt?: string;
}
interface Ser {
  layout: string;
  name: string;
  dims: Dim[];
  fill: string | null | undefined;
  labels: boolean;
  labelPos?: string;
  subtotals: Set<number>;
  bin: { size?: number; count?: number; closed: string; under?: number; over?: number };
  quartile: string;
  meanMarker: boolean;
  outliers: boolean;
}

/** bins a histogram draws at most (bars narrower than a pixel show nothing more) */
const MAX_BINS = 1000;
const say = (lang: SheetLang, k: string) => DICTS[lang]?.[`sheetchart.${k}`] ?? DICTS.en[`sheetchart.${k}`] ?? k;
const nums = (vs: Val[]) => vs.filter((v): v is number => typeof v === "number" && Number.isFinite(v));

/** a number value; null for empty, text or NaN (a cached "#N/A", a text cell) */
const finite = (v: Val): number | null => {
  const n = typeof v === "number" ? v : v == null || String(v).trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null;
};

function dimOf(el: Element, live: RefValues): Dim {
  const f = child(el, "f");
  const lvls: Val[][] = children(el, "lvl").map((l) => {
    const out: Val[] = new Array(Number(attr(l, "ptCount") ?? 0) || 0).fill(null);
    for (const pt of children(l, "pt")) {
      const t = textOf(pt);
      out[Number(attr(pt, "idx") ?? 0)] = el.localName === "numDim" ? finite(t) : t;
    }
    return out;
  });
  const fmt = lvls.length ? attr(children(el, "lvl")[0], "formatCode") ?? undefined : undefined;
  if (f) {
    const got = live(textOf(f));
    if (got && got.length) {
      const isNum = el.localName === "numDim";
      const conv = (v: Val) => (isNum ? finite(v) : v == null ? "" : String(v));
      // a hierarchy (several columns, row by row): the leaf is the last column — as many levels as the cached part
      // has, else (Excel 2016 writes no cache for a hierarchy) as the range has columns (at most 8 levels)
      const want = lvls.length > 1 ? lvls.length : el.localName === "strDim" && got.cols && got.cols > 1 && got.cols <= 8 ? got.cols : 1;
      const cols = got.length % want === 0 ? want : 1;
      const rows = got.length / cols;
      const out: Val[][] = [];
      for (let c = cols - 1; c >= 0; c--) out.push(Array.from({ length: rows }, (_, r) => conv(got[r * cols + c])));
      return { type: attr(el, "type") ?? "", lvls: out, fmt };
    }
  }
  return { type: attr(el, "type") ?? "", lvls, fmt };
}

/**
 * A histogram's bins over sorted values: the file's bin size or count, else Scott's rule with the population deviation
 * (Excel's automatic bins: 30 scores 52–99 → width 11.96), the automatic width rounded to two figures — Excel counts the
 * scores 64 and 88 in "[52, 64]" and "(76, 88]", so its bins are 12 wide, not 11.96. At most MAX_BINS bins.
 */
export function histBins(d: number[], bin: { size?: number; count?: number; closed?: string; under?: number; over?: number }): { lo: number; size: number; counts: number[]; under: number | null; over: number | null } {
  // underflow / overflow bins (cx:binning underflow= / overflow=): the values at or under / over the cut get a bin of
  // their own at the end, the regular bins span the rest (with a bin count, the count includes them — Excel: 5 bins
  // with overflow 90 over 52 … 99 → 4 bins of 9.5 and "> 90")
  const under = bin.under != null && Number.isFinite(bin.under) && bin.under > (d[0] ?? 0) ? bin.under : null;
  const over = bin.over != null && Number.isFinite(bin.over) && bin.over < (d[d.length - 1] ?? 0) && (under == null || bin.over > under) ? bin.over : null;
  const lo = under ?? d[0] ?? 0, hi = over ?? d[d.length - 1] ?? 0;
  const nUnder = under == null ? null : d.filter((t) => t <= under).length;
  const nOver = over == null ? null : d.filter((t) => t > over).length;
  if (under != null || over != null) d = d.filter((t) => (under == null || t > under) && (over == null || t <= over));
  if (bin.count) bin = { ...bin, count: Math.max(1, bin.count - (under != null ? 1 : 0) - (over != null ? 1 : 0)) };
  const mean = d.reduce((a, b) => a + b, 0) / Math.max(1, d.length);
  const sd = Math.sqrt(d.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, d.length));
  let size = bin.size ?? (bin.count ? (hi - lo) / bin.count : Number(((3.49 * sd) / Math.cbrt(Math.max(1, d.length))).toPrecision(2)));
  if (!(size > 0)) size = 1;
  // a tiny bin size (or a wide range) would make millions of bins: at most MAX_BINS, wider
  if ((hi - lo) / size > MAX_BINS) size = (hi - lo) / MAX_BINS;
  const n = Math.max(1, Math.ceil((hi - lo) / size - 1e-9));
  const right = bin.closed !== "l";
  const counts = new Array(n).fill(0);
  for (const t of d) {
    let k = right ? Math.ceil((t - lo) / size - 1e-9) - 1 : Math.floor((t - lo) / size + 1e-9);
    k = Math.max(0, Math.min(n - 1, k));
    counts[k]++;
  }
  return { lo, size, counts, under: nUnder, over: nOver };
}

/** Exclusive (n+1) or inclusive (n−1) quartile, as Excel's QUARTILE.EXC / QUARTILE.INC. */
function quart(s: number[], q: number, exclusive: boolean): number {
  const n = s.length;
  if (!n) return 0;
  let h = exclusive ? (n + 1) * q - 1 : (n - 1) * q;
  h = Math.max(0, Math.min(n - 1, h));
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[Math.min(n - 1, lo + 1)] ?? s[lo]) - s[lo]);
}

/** Treemap of `vals` (sorted big first) in the rectangle, laid out as Excel does; a rectangle per input index. */
export function squarify(vals: number[], x: number, y: number, w: number, h: number): [number, number, number, number][] {
  const order = vals.map((v, i) => ({ v: Number.isFinite(v) ? Math.max(0, v) : 0, i })).filter((o) => o.v > 0).sort((a, b) => b.v - a.v);
  const out: [number, number, number, number][] = vals.map(() => [x, y, 0, 0]);
  const total = order.reduce((a, o) => a + o.v, 0);
  if (!total || !(w > 0) || !(h > 0)) return out;
  // Excel's treemap is the squarified layout (rows along the shorter side, a row grown while its worst aspect ratio
  // improves) decided in a room 0.8 as tall as the plot, then stretched to it. Measured on two Excel pictures: 120 · 80 ·
  // 70 · 60 · 45 in 580 × 245 → three full-height columns, then 60 over 45; twelve values 210 … 12 in 580 × 215 → 210 |
  // 160 | 130 over 110 | 95 over 80 | (64 beside 50) over (41 | 30 …) — the plain squarified layout (0.8 → 1) stacks
  // 70 on 60 and 160 on 130, Excel does not.
  const fy = 0.8;
  const y0 = y;
  h *= fy;
  const scaleA = (w * h) / total;
  const rest = order.map((o) => ({ ...o, a: o.v * scaleA }));
  const worst = (r: typeof rest, side: number) => {
    const s = r.reduce((a, o) => a + o.a, 0);
    let m = 0;
    for (const o of r) m = Math.max(m, (side * side * o.a) / (s * s), (s * s) / (side * side * o.a));
    return m;
  };
  while (rest.length) {
    const side = Math.min(w, h);
    const row: typeof rest = [rest.shift()!];
    while (rest.length && worst([...row, rest[0]], side) <= worst(row, side)) row.push(rest.shift()!);
    const s = row.reduce((a, o) => a + o.a, 0);
    if (w >= h) {
      const cw = s / h;
      let yy = y;
      for (const o of row) {
        const ch = o.a / cw;
        out[o.i] = [x, yy, cw, ch];
        yy += ch;
      }
      x += cw;
      w -= cw;
    } else {
      const rh = s / w;
      let xx = x;
      for (const o of row) {
        const cw = o.a / rh;
        out[o.i] = [xx, y, cw, rh];
        xx += cw;
      }
      y += rh;
      h -= rh;
    }
  }
  // back to the plot's height
  for (const r of out) if (r[2] * r[3] > 0) (r[1] = y0 + (r[1] - y0) / fy), (r[3] /= fy);
  return out;
}

/** Paint a chartex part (cx:chartSpace) into (x, y, w, h). False when the part holds nothing drawable. */
export function paintChartEx(ctx: Ctx, xml: string, theme: string[], x: number, y: number, w: number, h: number, z: number, opt: { lang: SheetLang; live?: RefValues }, family: string): boolean {
  const doc = parseXml(xml);
  const cs = doc.documentElement;
  const live = opt.live ?? (() => null);
  const data = new Map<string, Dim[]>();
  for (const d of descendants(child(cs, "chartData") ?? cs, "data")) data.set(attr(d, "id") ?? "0", children(d).filter((k) => k.localName === "strDim" || k.localName === "numDim").map((k) => dimOf(k, live)));
  const chart = child(cs, "chart");
  if (!chart) return false;
  const sers: Ser[] = descendants(chart, "series").map((s) => {
    const tx = child(s, "tx");
    const td = tx && child(tx, "txData");
    let name = td ? textOf(child(td, "v") ?? td) : textOfTx(tx);
    const tf = td && child(td, "f");
    if (tf) {
      const got = live(textOf(tf));
      if (got && got[0] != null) name = String(got[0]);
    }
    const dl = child(s, "dataLabels");
    const vis = dl && child(dl, "visibility");
    const lp = child(s, "layoutPr");
    const bin = lp && child(lp, "binning");
    const st = lp && child(lp, "statistics");
    const v2 = lp && child(lp, "visibility");
    const numAttr = (el: Element | undefined, k: string) => (el && attr(el, k) != null && attr(el, k) !== "auto" && attr(el, k) !== "" ? Number(attr(el, k)) : undefined);
    return {
      layout: attr(s, "layoutId") ?? "",
      name,
      dims: data.get(attr(child(s, "dataId") ?? s, "val") ?? "0") ?? [],
      fill: spFill(child(s, "spPr"), theme),
      labels: !!dl && (vis ? attr(vis, "value") !== "0" : true),
      labelPos: dl ? attr(dl, "pos") ?? undefined : undefined,
      subtotals: new Set(descendants(lp ?? s, "idx").map((e) => Number(attr(e, "val")))),
      bin: { size: numAttr(bin && child(bin, "binSize"), "val"), count: numAttr(bin && child(bin, "binCount"), "val"), closed: (bin && attr(bin, "intervalClosed")) ?? "r", under: numAttr(bin, "underflow"), over: numAttr(bin, "overflow") },
      quartile: (st && attr(st, "quartileMethod")) ?? "exclusive",
      meanMarker: v2 ? attr(v2, "meanMarker") !== "0" : true,
      outliers: v2 ? attr(v2, "outliers") !== "0" : true,
    };
  });
  const main = sers[0];
  if (!main) return false;
  const px = (pt: number) => ((pt * 96) / 72) * z;
  const gray = "#595959", grid = "#D9D9D9";
  const fsT = px(14), fs = px(9);
  // the caller (paintChart) saves / restores the context around this painter, also when it throws
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(x, y, w, h);
  const pad = 10 * z;
  let top = y + pad, bottom = y + h - pad;
  const left = x + pad, right = x + w - pad;
  // title (Excel 2016: 14 pt, gray)
  const te = child(chart, "title");
  if (te) {
    const tx = child(te, "tx");
    const td = tx && child(tx, "txData");
    const t = (td ? textOf(child(td, "v") ?? td) : textOfTx(tx)) || AUTO_TITLE[opt.lang].chart;
    ctx.font = `${fsT}px ${family}`;
    ctx.fillStyle = gray;
    text(ctx, t, x + w / 2, top + fsT * 0.88, "center");
    top += fsT * 1.9;
  }
  const cats = (s: Ser) => s.dims.find((d) => d.type === "cat")?.lvls ?? [];
  const vals = (s: Ser) => s.dims.find((d) => d.type === "val" || d.type === "size")?.lvls[0] ?? [];
  const color = (i: number) => autoColor(theme, i);
  // legend entries
  const le = child(chart, "legend");
  let legend: { label: string; color: string }[] = [];
  const L = main.layout;
  if (le) {
    if (L === "waterfall") legend = [{ label: say(opt.lang, "increase"), color: color(0) }, { label: say(opt.lang, "decrease"), color: color(1) }, { label: say(opt.lang, "total"), color: color(2) }];
    else if (L === "treemap" || L === "sunburst") {
      const c = cats(main);
      const topLv = c[c.length - 1] ?? [];
      legend = [...new Set(topLv.map((v) => String(v ?? "")))].map((label, i) => ({ label, color: color(i) }));
    } else legend = sers.map((s, i) => ({ label: s.name, color: s.fill ?? color(i) }));
  }
  if (legend.length) {
    ctx.font = `${fs}px ${family}`;
    const sw = fs * 0.75;
    const ws = legend.map((e) => sw + 4 * z + ctx.measureText(e.label).width);
    const pos = attr(le!, "pos") ?? "t";
    // rows of entries no wider than about half the chart (measured: twelve entries of a treemap 600 px wide wrap into
    // two rows of six, 260 px each — seven would be 303 px), each row centred, rows 1.93 lines apart
    const maxW = Math.max(ws[0] ?? 0, w * 0.47);
    const rowsL: number[][] = [];
    let rw = 0;
    ws.forEach((wi, i) => {
      if (!rowsL.length || rw + 10 * z + wi > maxW) rowsL.push([i]), (rw = wi);
      else rowsL[rowsL.length - 1].push(i), (rw += 10 * z + wi);
    });
    const step = fs * 1.93;
    // a hostile number of entries: at most as many rows as fit in a third of the chart
    const nRows = Math.max(1, Math.min(rowsL.length, Math.floor(h / 3 / step)));
    // measured on Excel's pictures: a legend on top sits 1.27 lines under the title, the plot 3.2 lines under it
    const ly0 = pos === "b" ? bottom - fs * 0.7 - (nRows - 1) * step : top + fs * 1.27;
    rowsL.slice(0, nRows).forEach((row, r) => {
      const ly = ly0 + r * step;
      const tw = row.reduce((a, i) => a + ws[i], 0) + 10 * z * (row.length - 1);
      let lx = x + (w - tw) / 2;
      for (const i of row) {
        const e = legend[i];
        ctx.fillStyle = e.color;
        ctx.fillRect(Math.round(lx), Math.round(ly - sw / 2), Math.round(sw), Math.round(sw));
        ctx.fillStyle = gray;
        text(ctx, e.label, lx + sw + 4 * z, ly, "left");
        lx += ws[i] + 10 * z;
      }
    });
    if (pos === "b") bottom -= fs * 1.9 + (nRows - 1) * step;
    else top += fs * 3.2 + (nRows - 1) * step;
  }
  ctx.font = `${fs}px ${family}`;
  const fmtN = (v: number, f?: string) => fmtVal(v, f, opt.lang);
  // ───── value-axis charts: waterfall, histogram / pareto, box & whisker ─────
  type Bar = { label: string; a: number; b: number; color: string; val?: number };
  let bars: Bar[] | null = null;
  let boxes: { label: string; q1: number; q2: number; q3: number; lo: number; hi: number; mean: number; out: number[]; color: string }[] | null = null;
  let pareto: number[] | null = null;
  if (L === "waterfall") {
    const c = cats(main)[0] ?? [];
    const v = vals(main);
    let run = 0;
    bars = v.map((raw, i) => {
      const n = typeof raw === "number" ? raw : 0;
      const lab = String(c[i] ?? i + 1);
      if (main.subtotals.has(i)) {
        run = n;
        return { label: lab, a: 0, b: n, color: color(2), val: n };
      }
      const a = run;
      run += n;
      return { label: lab, a, b: run, color: n >= 0 ? color(0) : color(1), val: n };
    });
  } else if (L === "clusteredColumn" || L === "paretoLine") {
    const c = cats(main)[0] ?? [];
    const v = vals(main);
    if (c.length && c.some((k) => k != null && k !== "")) {
      // categories given: counts / sums per category (pareto: sorted, with the cumulative line)
      const sums = new Map<string, number>();
      v.forEach((n, i) => sums.set(String(c[i] ?? ""), (sums.get(String(c[i] ?? "")) ?? 0) + (typeof n === "number" ? n : 0)));
      let list = [...sums].map(([label, n]) => ({ label, n }));
      if (sers.some((s) => s.layout === "paretoLine")) list = list.sort((a, b) => b.n - a.n);
      bars = list.map((o) => ({ label: o.label, a: 0, b: o.n, color: main.fill ?? color(0), val: o.n }));
    } else {
      const d = nums(v).sort((a, b) => a - b);
      if (!d.length) return false;
      const { lo, size, counts, under, over } = histBins(d, main.bin);
      const n = counts.length;
      const right = main.bin.closed !== "l";
      const dec = size >= 10 || Number.isInteger(size) ? 0 : size >= 1 ? 1 : 2;
      // rounded to the bin width's decimals, shown without trailing zeros (Excel: [52, 61.5], (61.5, 71])
      const f = (t: number) => formatValue(Math.round(t * 10 ** dec) / 10 ** dec, undefined, { lang: opt.lang }).text;
      bars = counts.map((k, i) => {
        const a = lo + i * size, b = lo + (i + 1) * size;
        const label = right ? `${i === 0 ? "[" : "("}${f(a)}, ${f(b)}]` : `[${f(a)}, ${f(b)}${i === n - 1 ? "]" : ")"}`; // i18n: keep — interval notation
        return { label, a: 0, b: k, color: main.fill ?? color(0), val: k };
      });
      if (under != null) bars.unshift({ label: `≤ ${f(main.bin.under!)}`, a: 0, b: under, color: main.fill ?? color(0), val: under }); // i18n: keep — interval notation
      if (over != null) bars.push({ label: `> ${f(main.bin.over!)}`, a: 0, b: over, color: main.fill ?? color(0), val: over }); // i18n: keep — interval notation
    }
    if (sers.some((s) => s.layout === "paretoLine")) {
      const tot = bars.reduce((a, b) => a + b.b, 0) || 1;
      let acc = 0;
      pareto = bars.map((b) => (acc += b.b) / tot);
    }
  } else if (L === "boxWhisker") {
    boxes = sers.map((s, si) => {
      const d = nums(vals(s)).sort((a, b) => a - b);
      const ex = s.quartile !== "inclusive";
      const q1 = quart(d, 0.25, ex), q2 = quart(d, 0.5, ex), q3 = quart(d, 0.75, ex);
      const iqr = q3 - q1;
      const inl = d.filter((t) => t >= q1 - 1.5 * iqr && t <= q3 + 1.5 * iqr);
      return { label: s.name, q1, q2, q3, lo: inl[0] ?? q1, hi: inl[inl.length - 1] ?? q3, mean: d.reduce((a, b) => a + b, 0) / Math.max(1, d.length), out: s.outliers ? d.filter((t) => !inl.includes(t)) : [], color: s.fill ?? color(si) };
    });
  }
  if (bars || boxes) {
    const los = bars ? bars.flatMap((b) => [b.a, b.b]) : boxes!.flatMap((b) => [b.lo, ...b.out]);
    const his = bars ? bars.flatMap((b) => [b.a, b.b]) : boxes!.flatMap((b) => [b.hi, ...b.out]);
    const lo = Math.min(0, ...los), hi = Math.max(...his);
    const plotH0 = bottom - top - fs * 2.2;
    const vs = scale(lo, hi, undefined, plotH0, fs * 1.6, false);
    const labs: number[] = [];
    for (let k = 0, v = vs.min; v <= vs.max + vs.step * 1e-6 && k < 200; k++, v = vs.min + vs.step * k) labs.push(Math.abs(v) < vs.step * 1e-9 ? 0 : v);
    const fmt = (main.dims.find((d) => d.type === "val")?.fmt) || undefined;
    const labW = Math.max(...labs.map((v) => ctx.measureText(fmtN(v, fmt)).width));
    // measured on Excel's pictures: the plot ends 9 px (at 100 %) from the right edge and 1.77 lines over the bottom
    const pl = left + labW + 6 * z, pt = top + fs * 0.5, pr = pareto ? right - ctx.measureText("100%").width - 6 * z : x + w - 9 * z, pb = bottom - fs * 1.77;
    const pw = Math.max(4, pr - pl), ph = Math.max(4, pb - pt);
    const vy = (v: number) => pb - ((v - vs.min) / (vs.max - vs.min || 1)) * ph;
    ctx.strokeStyle = grid;
    ctx.lineWidth = Math.max(1, 0.75 * z);
    ctx.beginPath();
    for (const v of labs) {
      const p = Math.round(vy(v)) + 0.5;
      ctx.moveTo(pl, p);
      ctx.lineTo(pl + pw, p);
    }
    // Excel 2016 also rules the plot's left edge (measured on its waterfall, histogram and box pictures)
    ctx.moveTo(Math.round(pl) + 0.5, vy(vs.max));
    ctx.lineTo(Math.round(pl) + 0.5, vy(vs.min));
    ctx.stroke();
    ctx.fillStyle = gray;
    for (const v of labs) text(ctx, fmtN(v, fmt), pl - 6 * z, vy(v), "right");
    const n = bars ? bars.length : boxes!.length;
    const band = pw / Math.max(1, n);
    const catLabel = (s: string, i: number) => {
      ctx.fillStyle = gray;
      text(ctx, s, pl + band * (i + 0.5), pb + fs * 1.47, "center");
    };
    if (bars) {
      // waterfall gap 50 % of a bar, histogram bars touch (a 1 px white seam)
      const bw = L === "waterfall" ? band / 1.5 : band;
      bars.forEach((b, i) => {
        const x0 = pl + band * i + (band - bw) / 2;
        const y0 = vy(Math.max(b.a, b.b)), y1 = vy(Math.min(b.a, b.b));
        ctx.fillStyle = b.color;
        ctx.fillRect(x0, y0, bw, Math.max(1, y1 - y0));
        if (L !== "waterfall") {
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 1 * z;
          ctx.strokeRect(x0, y0, bw, Math.max(1, y1 - y0));
        }
        if (L === "waterfall" && i < bars!.length - 1) {
          ctx.strokeStyle = "#A6A6A6";
          ctx.lineWidth = Math.max(1, 0.75 * z);
          ctx.beginPath();
          const p = Math.round(vy(b.b)) + 0.5;
          ctx.moveTo(x0 + bw, p);
          ctx.lineTo(x0 + band, p);
          ctx.stroke();
        }
        if (main.labels && b.val != null && L === "waterfall") {
          ctx.fillStyle = gray;
          const neg = b.val < 0;
          text(ctx, fmtN(b.val, fmt), x0 + bw / 2, neg ? y1 + 3 * z : y0 - 3 * z, "center", neg ? "top" : "bottom");
        }
        catLabel(b.label, i);
      });
      if (pareto) {
        ctx.strokeStyle = color(1);
        ctx.lineWidth = 2 * z;
        ctx.beginPath();
        pareto.forEach((f, i) => {
          const px2 = pl + band * (i + 0.5), py = pb - f * ph;
          if (i) ctx.lineTo(px2, py);
          else ctx.moveTo(px2, py);
        });
        ctx.stroke();
        ctx.fillStyle = gray;
        for (let k = 0; k <= 10; k += 2) text(ctx, `${k * 10}%`, pl + pw + 4 * z, pb - (k / 10) * ph, "left");
      }
    } else {
      const bw = band / 2;
      boxes!.forEach((b, i) => {
        // Excel 2016's look: the box filled, its outline, median, whiskers and mean marker in the colour darkened to
        // 80 %, whisker caps 30 % of the box wide
        const cx = Math.round(pl + band * (i + 0.5)) + 0.5, x0 = cx - bw / 2;
        const dark = shadeHex(b.color, 0.8);
        ctx.fillStyle = b.color;
        ctx.fillRect(x0, vy(b.q3), bw, vy(b.q1) - vy(b.q3));
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(1, 0.75 * z);
        ctx.beginPath();
        ctx.moveTo(cx, vy(b.hi));
        ctx.lineTo(cx, vy(b.q3));
        ctx.moveTo(cx, vy(b.q1));
        ctx.lineTo(cx, vy(b.lo));
        ctx.moveTo(cx - bw * 0.15, Math.round(vy(b.hi)) + 0.5);
        ctx.lineTo(cx + bw * 0.15, Math.round(vy(b.hi)) + 0.5);
        ctx.moveTo(cx - bw * 0.15, Math.round(vy(b.lo)) + 0.5);
        ctx.lineTo(cx + bw * 0.15, Math.round(vy(b.lo)) + 0.5);
        ctx.moveTo(x0, Math.round(vy(b.q2)) + 0.5);
        ctx.lineTo(x0 + bw, Math.round(vy(b.q2)) + 0.5);
        ctx.stroke();
        ctx.strokeRect(Math.round(x0) + 0.5, Math.round(vy(b.q3)) + 0.5, Math.round(bw), Math.round(vy(b.q1) - vy(b.q3)));
        if (main.meanMarker) {
          const r = 3 * z, my = vy(b.mean);
          ctx.beginPath();
          ctx.moveTo(cx - r, my - r);
          ctx.lineTo(cx + r, my + r);
          ctx.moveTo(cx + r, my - r);
          ctx.lineTo(cx - r, my + r);
          ctx.stroke();
        }
        ctx.fillStyle = b.color;
        for (const o of b.out) {
          ctx.beginPath();
          ctx.arc(cx, vy(o), 2.5 * z, 0, Math.PI * 2);
          ctx.fill();
        }
        catLabel(cats(sers[i])[0]?.[0] != null ? String(cats(sers[i])[0][0]) : String(i + 1), i);
      });
    }
  } else if (L === "funnel") {
    const c = cats(main)[0] ?? [];
    const v = vals(main).map((t) => (typeof t === "number" ? t : 0));
    const max = Math.max(1e-9, ...v.map(Math.abs));
    const labW = Math.max(0, ...c.map((k) => ctx.measureText(String(k ?? "")).width));
    const pl = left + labW + 8 * z, pw = right - pl, n = Math.max(1, v.length);
    const band = (bottom - top) / n;
    const bh = band * (1 - 0.06);
    const fmt = main.dims.find((d) => d.type === "val")?.fmt;
    // the category axis: a light line just left of the widest bar, the plot's height
    ctx.strokeStyle = grid;
    ctx.lineWidth = Math.max(1, 0.75 * z);
    ctx.beginPath();
    ctx.moveTo(Math.round(pl - 1.5 * z) + 0.5, top);
    ctx.lineTo(Math.round(pl - 1.5 * z) + 0.5, bottom);
    ctx.stroke();
    v.forEach((t, i) => {
      const bw = (Math.abs(t) / max) * pw;
      const cy = top + band * (i + 0.5);
      ctx.fillStyle = main.fill ?? color(0);
      ctx.fillRect(pl + (pw - bw) / 2, cy - bh / 2, bw, bh);
      ctx.fillStyle = gray;
      text(ctx, String(c[i] ?? ""), left, cy, "left");
      if (main.labels) {
        ctx.fillStyle = "#FFFFFF";
        text(ctx, fmtN(t, fmt), pl + pw / 2, cy, "center");
      }
    });
  } else if (L === "treemap" || L === "sunburst") {
    const lv = cats(main);
    const leaf = lv[0] ?? [];
    const parent = lv[lv.length - 1] ?? leaf;
    const v = vals(main).map((t) => (typeof t === "number" && t > 0 ? t : 0));
    const groups = [...new Set(parent.map((p) => String(p ?? "")))];
    const colorOf = (i: number) => color(Math.max(0, groups.indexOf(String(parent[i] ?? ""))));
    if (L === "treemap") {
      // squarify the groups, then each group's leaves inside its rectangle
      const gv = groups.map((g) => v.reduce((a, t, i) => a + (String(parent[i] ?? "") === g ? t : 0), 0));
      const gr = squarify(gv, left, top, right - left, bottom - top);
      groups.forEach((g, gi) => {
        const idx = v.map((_, i) => i).filter((i) => String(parent[i] ?? "") === g);
        const rs = lv.length > 1 ? squarify(idx.map((i) => v[i]), ...gr[gi]) : [gr[gi]];
        idx.forEach((i, k) => {
          const [rx, ry, rw, rh] = rs[lv.length > 1 ? k : 0];
          if (rw < 1 || rh < 1) return;
          ctx.fillStyle = colorOf(i);
          ctx.fillRect(rx, ry, rw, rh);
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 1.5 * z;
          ctx.strokeRect(rx, ry, rw, rh);
          ctx.fillStyle = "#FFFFFF";
          ctx.save();
          ctx.beginPath();
          ctx.rect(rx, ry, rw, rh);
          ctx.clip();
          text(ctx, String(leaf[i] ?? ""), rx + 4 * z, ry + rh - fs * 0.8, "left");
          ctx.restore();
        });
        // a hierarchy: the group's name over its top-left corner (Excel's "overlapping" parent labels)
        const [gx, gy, gw, gh] = gr[gi];
        if (lv.length > 1 && gw >= 1 && gh >= 1) {
          ctx.fillStyle = "#FFFFFF";
          ctx.save();
          ctx.beginPath();
          ctx.rect(gx, gy, gw, gh);
          ctx.clip();
          text(ctx, g, gx + 4 * z, gy + fs * 1.0, "left");
          ctx.restore();
        }
      });
    } else {
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      const R = Math.max(4, Math.min(right - left, bottom - top) / 2);
      const rings = Math.max(1, lv.length);
      const inner = R * 0.2;
      const tot = v.reduce((a, b) => a + b, 0) || 1;
      for (let r = 0; r < rings; r++) {
        const lvl = lv[rings - 1 - r] ?? leaf;
        const r0 = inner + ((R - inner) * r) / rings, r1 = inner + ((R - inner) * (r + 1)) / rings;
        let a0 = -Math.PI / 2;
        // consecutive equal labels on a level make one segment
        for (let i = 0; i < v.length; ) {
          let j = i, sum = 0;
          while (j < v.length && String(lvl[j] ?? "") === String(lvl[i] ?? "") && String(parent[j] ?? "") === String(parent[i] ?? "")) sum += v[j++];
          const a1 = a0 + (sum / tot) * Math.PI * 2;
          ctx.beginPath();
          ctx.arc(cx, cy, r1, a0, a1);
          ctx.arc(cx, cy, r0, a1, a0, true);
          ctx.closePath();
          ctx.fillStyle = colorOf(i);
          ctx.fill();
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 1.5 * z;
          ctx.stroke();
          if (sum / tot > 0.03) {
            ctx.fillStyle = "#FFFFFF";
            const am = (a0 + a1) / 2, rm = (r0 + r1) / 2;
            text(ctx, String(lvl[i] ?? ""), cx + rm * Math.cos(am), cy + rm * Math.sin(am), "center");
          }
          a0 = a1;
          i = j;
        }
      }
    }
  } else {
    // region map and kinds this painter does not know: the frame with a note
    ctx.fillStyle = gray;
    text(ctx, say(opt.lang, "unsupported"), x + w / 2, (top + bottom) / 2, "center");
  }
  ctx.strokeStyle = grid;
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  return true;
}
