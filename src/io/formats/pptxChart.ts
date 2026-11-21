// Charts on slides (DrawingML chart parts, ECMA-376 Part 1 §21.2) drawn from the values PowerPoint caches in the part
// (c:numCache / c:strCache): clustered column / bar, line and pie charts as shapes and text, so a slide shows its chart
// where PowerPoint shows one (a .pptx carries no picture of it). Axes, gridlines, category and value labels and a
// bottom legend in PowerPoint's default layout; other chart types and styling are approximated by these.

import { corner, ellipseContour, rectContour } from "../../core/vector";
import { DEFAULT_RUN, newText, newVector, uid, type Contour, type SceneNode, type SlideChart, type TextNode } from "../../core/types";
import { attr, child, children, descendants, textOf } from "../xml";

interface Series {
  name: string;
  values: number[];
  color: string | null;
}

/** Cached points of a c:numRef / c:strRef (c:pt idx → c:v). */
function cache(el: Element | undefined): string[] {
  const out: string[] = [];
  if (!el) return out;
  for (const pt of descendants(el, "pt")) {
    const v = child(pt, "v");
    out[Number(attr(pt, "idx")) || 0] = v ? textOf(v) : "";
  }
  return out;
}

/** The smallest 1 / 2 / 5 × 10ⁿ at least v. */
const unit125 = (v: number) => {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * e >= v - 1e-12) return m * e;
  return 10 * e;
};

function label(text: string, x: number, y: number, w: number, size: number, color: string, align: "LEFT" | "CENTER" | "RIGHT", font: string): TextNode {
  const t = newText("", Math.max(4, w));
  t.paragraphs = [{ id: uid("p"), runs: [{ ...DEFAULT_RUN, text, fontSize: size, color, fontFamily: font }], align, lineSpacing: 1.2, indent: 0, spaceAfter: 0 }];
  t.transform = { x, y, rotation: 0, scale: 1 };
  t.name = text;
  return t;
}

function box(x: number, y: number, w: number, h: number, fill: string, name: string) {
  const v = newVector([rectContour(0, 0, Math.max(0.5, w), Math.max(0.5, h))], name);
  v.fill = fill;
  v.stroke = null;
  v.strokeWidth = 0;
  v.transform = { x, y, rotation: 0, scale: 1 };
  return v;
}

function line(pts: [number, number][], color: string, width: number, name: string) {
  const c: Contour = { closed: false, nodes: pts.map(([x, y]) => corner(x, y)) };
  const v = newVector([c], name);
  v.fill = null;
  v.stroke = color;
  v.strokeWidth = width;
  v.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  return v;
}

/**
 * What a chart part shows (its cached values, colours resolved), or null when it has no chart PowerPoint caches values
 * for. `colorOf` resolves a colour choice (series a:solidFill) and `accent(i)` gives the theme's accent colour i (1–6).
 */
export function readChart(doc: Document, frame: { x: number; y: number; w: number; h: number }, name: string, colorOf: (el: Element | undefined) => string | null, accent: (i: number) => string, font: string): SlideChart | null {
  const plot = descendants(doc, "plotArea")[0];
  if (!plot) return null;
  const kindEl = children(plot).find((c) => /^(bar|line|pie|doughnut|area)Chart$/.test(c.localName));
  if (!kindEl) return null;
  const series: Series[] = children(kindEl, "ser").map((s, i) => {
    const sp = child(s, "spPr");
    const fill = sp && (child(sp, "solidFill") ?? (child(sp, "ln") && child(child(sp, "ln")!, "solidFill")));
    return {
      name: cache(child(s, "tx"))[0] ?? `${i + 1}`,
      values: cache(child(s, "val")).map((v) => Number(v) || 0),
      color: fill ? colorOf(fill) : null,
    };
  });
  if (!series.length) return null;
  const local = kindEl.localName;
  const kind: SlideChart["kind"] =
    local === "barChart" ? (attr(child(kindEl, "barDir") ?? kindEl, "val") === "bar" ? "bar" : "col") : local === "lineChart" ? "line" : local === "pieChart" ? "pie" : local === "doughnutChart" ? "doughnut" : "area";
  // the axis text size the chart saved (a:defRPr sz of the axes' c:txPr; PowerPoint's default chart: 11.97 pt)
  const axSz = descendants(plot, "defRPr").map((d) => Number(attr(d, "sz"))).find((v) => v > 0);
  const title = descendants(doc, "title")[0];
  const autoDel = descendants(doc, "autoTitleDeleted")[0];
  const own = title ? descendants(title, "t").map(textOf).join("") : "";
  return {
    kind,
    name,
    categories: cache(child(children(kindEl, "ser")[0], "cat")),
    series,
    ...(title && !(autoDel && attr(autoDel, "val") === "1") ? { title: own || null } : {}),
    ...(axSz ? { axSz } : {}),
    gapWidth: Number(attr(child(kindEl, "gapWidth") ?? kindEl, "val") ?? 150),
    overlap: Number(attr(child(kindEl, "overlap") ?? kindEl, "val") ?? 0),
    accents: [1, 2, 3, 4, 5, 6].map(accent),
    font,
    frame: { ...frame },
  };
}

/** The title a chart shows ("" for none). */
export const chartTitle = (m: SlideChart) => (m.title === undefined ? "" : m.title ?? (m.series.length === 1 ? m.series[0].name : ""));

/**
 * Shapes of a chart part in the frame (x, y, w, h px); null when the part has no chart PowerPoint caches values for.
 * `colorOf` resolves a colour choice (series a:solidFill) and `accent(i)` gives the theme's accent colour i (1–6).
 */
export function chartShapes(doc: Document, frame: { x: number; y: number; w: number; h: number }, name: string, colorOf: (el: Element | undefined) => string | null, accent: (i: number) => string, font: string): SceneNode[] | null {
  const m = readChart(doc, frame, name, colorOf, accent, font);
  return m && drawChart(m);
}

/**
 * A chart drawn as shapes and text in its frame (PowerPoint's default layout). The shapes share one chart id; the first
 * carries the chart (SceneNode.chart), so the chart can be edited and drawn again (ui/chartEdit).
 */
export function drawChart(m: SlideChart, id = uid("ch")): SceneNode[] {
  const out = drawShapes(m);
  out.forEach((n, i) => (n.chart = i ? { id } : { id, data: m }));
  return out;
}

function drawShapes(m: SlideChart): SceneNode[] {
  const sers = m.series;
  const cats = m.categories;
  const name = m.name, font = m.font;
  const accent = (i: number) => m.accents[(i - 1) % 6] ?? "#4472c4";
  const n = Math.max(cats.length, ...sers.map((s) => s.values.length), 0);
  const out: SceneNode[] = [];
  const { x, y, w, h } = m.frame;
  const axSz = m.axSz;
  const fs = axSz ? (axSz / 100) * (96 / 72) : 12;
  const gray = "#595959", grid = "#d9d9d9";
  const round = m.kind === "pie" || m.kind === "doughnut";
  // legend under the plot
  const legendH = sers.length > 1 || m.kind === "pie" ? fs * 2 : 0;
  const titleText = chartTitle(m);
  const titleH = titleText ? fs * 2.4 : 0;
  if (titleH) out.push(label(titleText, x, y + fs * 0.4, w, fs * 1.55, gray, "CENTER", font));
  const pad = 9;
  if (round) {
    const s = sers[0] ?? { name: "", values: [], color: null };
    const total = s.values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const r = Math.max(4, Math.min(w - 2 * pad, h - titleH - legendH - 2 * pad) / 2);
    const cx = x + w / 2, cy = y + titleH + pad + r;
    let a0 = -Math.PI / 2;
    s.values.forEach((v, i) => {
      const a1 = a0 + (Math.max(0, v) / total) * Math.PI * 2;
      const steps = Math.max(2, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 64));
      const pts: [number, number][] = [[cx, cy]];
      for (let k = 0; k <= steps; k++) {
        const a = a0 + ((a1 - a0) * k) / steps;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
      const slice = newVector([{ closed: true, nodes: pts.map(([px, py]) => corner(px, py)) }], `${name} ${cats[i] ?? i + 1}`);
      slice.fill = accent((i % 6) + 1);
      slice.stroke = "#ffffff";
      slice.strokeWidth = 1;
      slice.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
      out.push(slice);
      a0 = a1;
    });
    if (m.kind === "doughnut") {
      const hole = newVector([ellipseContour(cx, cy, r / 2, r / 2)], name);
      hole.fill = "#ffffff";
      hole.stroke = null;
      hole.strokeWidth = 0;
      hole.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
      out.push(hole);
    }
    const items = cats.length ? cats : s.values.map((_, i) => `${i + 1}`);
    legend(out, items, (i) => accent((i % 6) + 1), x, y + h - legendH, w, fs, gray, font);
    return out;
  }
  const horizontal = m.kind === "bar";
  const bars = m.kind === "bar" || m.kind === "col";
  // the automatic value axis: 5 % headroom over the largest value, a 1-2-5 major unit giving about six intervals
  const hi = Math.max(0, ...sers.flatMap((s) => s.values));
  const min = Math.min(0, ...sers.flatMap((s) => s.values));
  const target = hi + (hi - min) * 0.05 || 1;
  const step = unit125(target / 6);
  const top = Math.ceil(target / step - 1e-9) * step;
  // the widest value label as drawn (6 × 0.05 is 0.30000000000000004: its label "0.3"; a negative minimum's "-" too)
  const round2 = (v: number) => String(Math.round(v * 100) / 100);
  const labelLen = Math.max(round2(top).length, round2(min).length);
  const vLabelW = fs * (labelLen * 0.6 + 1);
  // PowerPoint's automatic layout of its default column chart (omni-pptx-fidelity slide 9, 11.97 pt text): the plot
  // starts 1.05 × the text size below the frame and as far right as its value labels need; the category labels and
  // the bottom legend take 5.33 × the text size under it
  // (and ends 0.92 × the text size before the right edge)
  const px0 = x + (horizontal ? pad + fs * 4 : axSz ? fs * (labelLen * 0.55 + 1.55) : vLabelW + pad), py0 = y + titleH + (axSz ? fs * 1.05 : pad);
  const below = axSz ? (legendH ? fs * 5.33 : fs * 2.6) : legendH + pad + fs * 1.6;
  const pw = Math.max(4, x + w - (axSz ? fs * 0.92 : pad) - px0), ph = Math.max(4, y + h - below - py0);
  const val = (v: number) => (v - min) / (top - min || 1);
  // value gridlines and labels
  for (let v = min; v <= top + 1e-9; v += step) {
    if (horizontal) {
      const gx = px0 + val(v) * pw;
      out.push(line([[gx, py0], [gx, py0 + ph]], grid, 0.75, name));
      out.push(label(round2(v), gx - fs * 2, py0 + ph + fs * 0.3, fs * 4, fs, gray, "CENTER", font));
    } else {
      const gy = py0 + ph - val(v) * ph;
      out.push(line([[px0, gy], [px0 + pw, gy]], grid, 0.75, name));
      out.push(label(round2(v), px0 - vLabelW - fs * 0.25, gy - fs * 0.6, vLabelW, fs, gray, "RIGHT", font));
    }
  }
  const band = (horizontal ? ph : pw) / Math.max(1, n);
  const gapW = m.gapWidth / 100 || 1.5;
  // c:overlap: bars of a category overlap by this share of a bar (negative: a gap between them; PowerPoint's default -27 %)
  const ov = Math.max(-1, Math.min(1, m.overlap / 100 || 0));
  const barW = band / (sers.length + (sers.length - 1) * -ov + gapW);
  for (let i = 0; i < n; i++) {
    const c0 = (horizontal ? py0 : px0) + band * i;
    const cat = cats[i] ?? `${i + 1}`;
    if (horizontal) out.push(label(cat, x + pad, c0 + band / 2 - fs * 0.6, fs * 3.6, fs, gray, "RIGHT", font));
    else out.push(label(cat, c0, py0 + ph + fs * 0.3, band, fs, gray, "CENTER", font));
    if (!bars) continue;
    sers.forEach((s, k) => {
      const v = s.values[i] ?? 0;
      const color = s.color ?? accent((k % 6) + 1);
      const b0 = c0 + barW * (gapW / 2 + k * (1 - ov));
      if (horizontal) {
        const x0 = px0 + val(Math.min(0, v)) * pw, x1 = px0 + val(Math.max(0, v)) * pw;
        out.push(box(x0, b0, x1 - x0, barW, color, `${name} ${s.name}`));
      } else {
        const y0 = py0 + ph - val(Math.max(0, v)) * ph, y1 = py0 + ph - val(Math.min(0, v)) * ph;
        out.push(box(b0, y0, barW, y1 - y0, color, `${name} ${s.name}`));
      }
    });
  }
  if (!bars)
    sers.forEach((s, k) => {
      const color = s.color ?? accent((k % 6) + 1);
      const pts = s.values.map((v, i): [number, number] => [px0 + band * (i + 0.5), py0 + ph - val(v) * ph]);
      if (pts.length > 1) out.push(line(pts, color, 2.25, `${name} ${s.name}`));
    });
  // the category axis line
  out.push(horizontal ? line([[px0, py0], [px0, py0 + ph]], grid, 0.75, name) : line([[px0, py0 + ph], [px0 + pw, py0 + ph]], grid, 0.75, name));
  if (legendH) legend(out, sers.map((s) => s.name), (i) => sers[i].color ?? accent((i % 6) + 1), x, y + h - legendH, w, fs, gray, font);
  return out;
}

function legend(out: SceneNode[], items: string[], color: (i: number) => string, x: number, y: number, w: number, fs: number, gray: string, font: string) {
  const itemW = items.map((t) => fs * 1.2 + t.length * fs * 0.62 + fs);
  const total = itemW.reduce((a, b) => a + b, 0);
  let lx = x + Math.max(0, (w - total) / 2);
  items.forEach((t, i) => {
    out.push(box(lx, y + fs * 0.45, fs * 0.6, fs * 0.6, color(i), t));
    out.push(label(t, lx + fs * 0.9, y, itemW[i] - fs * 0.9, fs, gray, "LEFT", font));
    lx += itemW[i];
  });
}

// ───────── editing ─────────

/** The shapes of the chart whose first shape (the one carrying its data) is nodes[i]: indices [i, end). */
export function chartRun(nodes: readonly SceneNode[], i: number): [number, number] {
  const id = nodes[i]?.chart?.id;
  let e = i + 1;
  while (id && e < nodes.length && nodes[e].chart?.id === id && !nodes[e].chart?.data) e++;
  return [i, e];
}

/** Where the chart at nodes[i] is now: its frame moved as its shapes were (by the first one against its drawing). */
export function chartFrameNow(nodes: readonly SceneNode[], i: number): SlideChart["frame"] | null {
  const m = nodes[i]?.chart?.data;
  if (!m) return null;
  const first = drawShapes(m)[0];
  if (!first) return { ...m.frame };
  const t = nodes[i].transform;
  return { ...m.frame, x: m.frame.x + t.x - first.transform.x, y: m.frame.y + t.y - first.transform.y };
}

/** Page nodes with the chart at nodes[i] drawn again from `data` where it is now (same chart id, same place in the order). */
export function replaceChart(nodes: readonly SceneNode[], i: number, data: Omit<SlideChart, "frame">): SceneNode[] {
  const frame = chartFrameNow(nodes, i);
  const id = nodes[i]?.chart?.id;
  if (!frame || !id) return [...nodes];
  const [s, e] = chartRun(nodes, i);
  const drawn = drawChart({ ...data, frame } as SlideChart, id);
  // the shapes keep the ids they had, in order (the selection and the source-preserving save still find the chart)
  drawn.forEach((n, k) => k < e - s && (n.id = nodes[s + k].id));
  return [...nodes.slice(0, s), ...drawn, ...nodes.slice(e)];
}
