// Chart painter for sheets (표 계산 차트): a DrawingML chart part (ECMA-376 Part 1 §21.2) drawn the way Excel draws it —
// column / bar (clustered, stacked, 100 %), line (markers), pie / doughnut, area, scatter (XY), combinations of these on
// one plot; value and category axes with Excel's automatic scale, number formats, gridlines, axis titles, the legend
// in any position, data labels, the chart title, series colours from the file or the theme (accent 1–6, then their
// darker / lighter turns as Excel does), manual layouts of the plot area / legend. Values come from the sheet cells the
// series refer to (so an edited cell moves the chart), else from the values cached in the part.
// Omniweave's own painter; loaded only when a sheet with a chart is shown (render/sheetDrawings.ts).

import { dmlColor, modColor } from "../io/sheet/dmlColor";
import { formatValue, type SheetLang } from "../io/sheet/numfmt";
import { attr, child, children, descendants, parseXml, textOf } from "../io/xml";
import { DICTS } from "../i18n";
import { paintChartEx } from "./sheetChartEx";
import { paint3D, paintPie3D, surfaceLegend, type Env3D } from "./sheetChart3D";

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type Val = number | string | null;
/** Values of a reference like Sheet1!$B$2:$B$9 from the workbook's cells (null: not resolvable). */
/** the values of a cell reference, row by row; `cols` is the range's width (a chartex hierarchy: a column per level) */
export type RefValues = (ref: string) => (Val[] & { cols?: number }) | null;

export interface Text {
  size: number; // pt
  color: string;
  bold?: boolean;
}
export interface Marker {
  symbol: string;
  size: number;
  fill: string | null;
  line: string | null;
}
export interface Labels {
  val: boolean;
  pct: boolean;
  cat: boolean;
  ser: boolean;
  pos?: string;
  fmt?: string;
  text: Text;
}
export interface Ser {
  name: string;
  vals: Val[];
  xs: Val[];
  fmt?: string;
  xFmt?: string;
  fill: string | null | undefined;
  line: string | null | undefined;
  lineW?: number;
  marker?: Marker | null;
  pts: Map<number, string>;
  labels?: Labels | null;
  smooth?: boolean;
  /** bubble chart: the bubble sizes */
  sizes?: Val[];
}
export interface Group {
  type: string;
  horiz: boolean;
  grouping: string;
  gap: number;
  overlap: number;
  vary: boolean;
  sers: Ser[];
  axIds: string[];
  first: number;
  hole: number;
  labels?: Labels | null;
  marker: boolean;
  index0: number;
  /** the part's own element kind (bar3D, line3D, surface3D, …) — the 3-D painter draws these in depth */
  kind: string;
  /** 3-D: gap between the series rows, % of a bar's width */
  gapDepth: number;
  /** surface: the band colours (bandFmt), by band index */
  bands: Map<number, string>;
  wireframe: boolean;
}
export interface Ax {
  id: string;
  kind: "cat" | "val" | "date" | "ser";
  pos: string;
  del: boolean;
  min?: number;
  max?: number;
  major?: number;
  reverse: boolean;
  fmt?: string;
  linked: boolean;
  grid: string | null;
  line: string | null;
  lblPos: string;
  tick: string;
  title?: { text: string; t: Text } | null;
  text: Text;
  cross?: string;
  between: boolean;
  crossesAt?: number;
  crossesMax?: boolean;
}
export interface Model {
  groups: Group[];
  axes: Map<string, Ax>;
  title: { text: string; t: Text; overlay: boolean } | null;
  legend: { pos: string; t: Text; layout: number[] | null; overlay: boolean; del: Set<number> } | null;
  bg: string | null;
  border: string | null;
  plotBg: string | null;
  plotLayout: number[] | null;
  /** a 3-D chart drawn flat / a kind drawn simplified (surface, stock, bar of pie): a note on the chart */
  is3D: boolean;
  simplified: boolean;
  base: Text;
  theme: string[];
  /** c:view3D (with Excel's defaults when a 3-D kind has none) and the floor / wall fills */
  view3D: View3D | null;
}
export interface View3D {
  rotX: number;
  rotY: number;
  depth: number;
  perspective: number;
  /** right-angle axes: the front face square to the viewer, depth drawn obliquely */
  rAng: boolean;
  floor: string | null;
  backWall: string | null;
  sideWall: string | null;
}

/** the biggest bubble's diameter at bubble scale 100 %, of the plot's shorter side (measured: 70 px of 260) */
const BUBBLE = 0.27;
/** Excel's automatic marker shapes, series by series */
const AUTO_SYM = ["diamond", "square", "triangle", "x", "star", "circle", "plus"];
const cache = new Map<string, Model | null>();
const bool = (el: Element | undefined, d = false) => (el ? !/^(0|false)$/.test(attr(el, "val") ?? "1") : d);
const num = (el: Element | undefined) => (el && attr(el, "val") != null ? Number(attr(el, "val")) : undefined);

export function textOfTx(tx: Element | undefined): string {
  if (!tx) return "";
  const rich = child(tx, "rich");
  if (rich)
    return children(rich, "p")
      .map((p) => descendants(p, "t").map(textOf).join(""))
      .join("\n");
  const v = descendants(tx, "v");
  return v.map(textOf).join(" ");
}

export function txStyle(el: Element | undefined, theme: string[], d: Text): Text {
  const out = { ...d };
  if (!el) return out;
  const tx = child(el, "txPr") ?? child(el, "tx");
  const r = tx ? descendants(tx, "defRPr")[0] ?? descendants(tx, "rPr")[0] : undefined;
  if (!r) return out;
  if (attr(r, "sz")) out.size = Number(attr(r, "sz")) / 100;
  if (attr(r, "b") != null) out.bold = /^(1|true)$/.test(attr(r, "b")!);
  const c = dmlColor(child(r, "solidFill"), theme);
  if (c) out.color = c;
  return out;
}

/** fill / line colour choice of an spPr: colour, null = none, undefined = automatic */
export function spFill(sp: Element | undefined, theme: string[]): string | null | undefined {
  if (!sp) return undefined;
  if (child(sp, "noFill")) return null;
  const s = child(sp, "solidFill");
  if (s) return dmlColor(s, theme);
  const g = child(sp, "gradFill");
  if (g) return dmlColor(descendants(g, "gs")[0], theme);
  if (child(sp, "pattFill")) return dmlColor(child(child(sp, "pattFill")!, "fgClr"), theme);
  return undefined;
}
function spLine(sp: Element | undefined, theme: string[]): { c: string | null | undefined; w?: number } {
  const ln = sp && child(sp, "ln");
  if (!ln) return { c: undefined };
  const w = attr(ln, "w") ? Number(attr(ln, "w")) / 9525 : undefined;
  return { c: spFill(ln, theme), w };
}

function refVals(el: Element | undefined, live: RefValues): { vals: Val[]; fmt?: string } {
  if (!el) return { vals: [] };
  const ref = child(el, "numRef") ?? child(el, "strRef") ?? child(el, "multiLvlStrRef");
  const lit = child(el, "numLit") ?? child(el, "strLit");
  const holder = ref ?? lit;
  if (!holder) return { vals: [] };
  const cacheEl = child(holder, "numCache") ?? child(holder, "strCache") ?? child(holder, "multiLvlStrCache") ?? holder;
  const fc = child(cacheEl, "formatCode");
  const fmt = fc ? textOf(fc) : undefined;
  const isNum = holder.localName.startsWith("num");
  const f = ref && child(ref, "f");
  if (f) {
    const got = live(textOf(f));
    if (got) return { vals: got.map((v) => (isNum ? (typeof v === "number" ? v : v == null || v === "" ? null : Number(v) || null) : v)), fmt };
  }
  const out: Val[] = [];
  const count = num(child(cacheEl, "ptCount"));
  if (count) out.length = count;
  const lvl = child(cacheEl, "lvl") ?? cacheEl;
  for (const pt of children(lvl, "pt")) {
    const v = child(pt, "v");
    const t = v ? textOf(v) : "";
    out[Number(attr(pt, "idx")) || 0] = isNum ? (t === "" ? null : Number(t)) : t;
  }
  for (let i = 0; i < out.length; i++) if (out[i] === undefined) out[i] = null;
  return { vals: out, fmt };
}

function labelsOf(el: Element | undefined, theme: string[], base: Text): Labels | null | undefined {
  if (!el) return undefined;
  if (bool(child(el, "delete"))) return null;
  const pos = child(el, "dLblPos");
  const nf = child(el, "numFmt");
  return {
    val: bool(child(el, "showVal")),
    pct: bool(child(el, "showPercent")),
    cat: bool(child(el, "showCatName")),
    ser: bool(child(el, "showSerName")),
    pos: pos ? attr(pos, "val") ?? undefined : undefined,
    fmt: nf && !/^(1|true)$/.test(attr(nf, "sourceLinked") ?? "0") ? attr(nf, "formatCode") ?? undefined : undefined,
    text: txStyle(el, theme, base),
  };
}

function markerOf(el: Element | undefined, theme: string[]): Marker | null | undefined {
  if (!el) return undefined;
  const sym = child(el, "symbol");
  const s = sym ? attr(sym, "val") ?? "auto" : "auto";
  if (s === "none") return null;
  const sp = child(el, "spPr");
  return { symbol: s, size: num(child(el, "size")) ?? 5, fill: spFill(sp, theme) ?? null, line: spLine(sp, theme).c ?? null };
}

function layoutOf(el: Element | undefined): number[] | null {
  const ml = el && descendants(el, "manualLayout")[0];
  if (!ml) return null;
  const g = (k: string) => num(child(ml, k));
  const x = g("x"), y = g("y"), w = g("w"), h = g("h");
  if (x == null || y == null) return null;
  return [x, y, w ?? -1, h ?? -1, child(ml, "layoutTarget") && attr(child(ml, "layoutTarget")!, "val") === "inner" ? 1 : 0];
}

/** The titles Excel shows for a title element with no text of its own (an automatic title), in the sheet's language. */
export const AUTO_TITLE: Record<SheetLang, { chart: string; axis: string }> = {
  ko: { chart: "차트 제목", axis: "축 제목" },
  en: { chart: "Chart Title", axis: "Axis Title" },
  ja: { chart: "グラフ タイトル", axis: "軸ラベル" },
  zh: { chart: "图表标题", axis: "坐标轴标题" },
};

function parse(xml: string, theme: string[], live: RefValues, lang: SheetLang = "en"): Model | null {
  const doc = parseXml(xml);
  const cs = doc.documentElement;
  const chart = child(cs, "chart");
  const plot = chart && child(chart, "plotArea");
  if (!chart || !plot) return null;
  // a part without text / line properties draws with Excel 2007's chart defaults (style 2): 10 pt black text, gray lines
  const base = txStyle(cs, theme, { size: 10, color: "#000000" });
  const groups: Group[] = [];
  const flags = { is3D: false, simplified: false };
  let index0 = 0;
  for (const g of children(plot)) {
    const m = /^(bar|bar3D|line|line3D|pie|pie3D|doughnut|area|area3D|scatter|radar|ofPie|bubble|surface|surface3D|stock)Chart$/.exec(g.localName);
    if (!m) continue;
    // 3-D kinds and surfaces are drawn in depth (render/sheetChart3D.ts); horizontal 3-D bars are drawn flat and
    // stock / bar of pie simplified (a note says so)
    if (m[1] === "bar3D" && attr(child(g, "barDir") ?? g, "val") === "bar") flags.is3D = true;
    if (m[1] === "stock" || m[1] === "ofPie") flags.simplified = true;
    const type = m[1].replace("3D", "").replace("ofPie", "pie").replace("bubble", "scatter").replace(/^(surface|stock)$/, "line");
    const grouping = attr(child(g, "grouping") ?? child(g, "radarStyle") ?? g, "val") ?? (type === "bar" ? "clustered" : "standard");
    const gl = labelsOf(child(g, "dLbls"), theme, base);
    const sers: Ser[] = children(g, "ser").map((s, k) => {
      const sp = child(s, "spPr");
      const ln = spLine(sp, theme);
      const tx = child(s, "tx");
      const name = tx ? (child(tx, "strRef") ? String(refVals(tx, live).vals[0] ?? "") : textOfTx(tx)) : "";
      const v = refVals(child(s, "val") ?? child(s, "yVal"), live);
      const x = refVals(child(s, "cat") ?? child(s, "xVal"), live);
      const pts = new Map<number, string>();
      for (const dp of children(s, "dPt")) {
        const c = spFill(child(dp, "spPr"), theme);
        if (c) pts.set(Number(attr(child(dp, "idx") ?? dp, "val") ?? 0), c);
      }
      return {
        name: name || `Series${index0 + k + 1}`,
        vals: v.vals,
        fmt: v.fmt,
        xs: x.vals,
        xFmt: x.fmt,
        fill: spFill(sp, theme),
        line: ln.c,
        lineW: ln.w,
        marker: markerOf(child(s, "marker"), theme),
        pts,
        labels: labelsOf(child(s, "dLbls"), theme, base),
        smooth: bool(child(s, "smooth")),
        ...(m[1] === "bubble" ? { sizes: refVals(child(s, "bubbleSize"), live).vals } : {}),
        ...(m[1] === "stock" ? { line: null } : {}),
        // a 3-D line is a ribbon filled with the series colour: drawn as a plain line of that colour
        ...(m[1] === "line3D" ? { line: spFill(sp, theme) ?? undefined, lineW: undefined, marker: null } : {}),
      };
    });
    groups.push({
      type,
      horiz: attr(child(g, "barDir") ?? g, "val") === "bar",
      grouping,
      gap: num(child(g, "gapWidth")) ?? 150,
      overlap: num(child(g, "overlap")) ?? (grouping === "stacked" || grouping === "percentStacked" ? 100 : 0),
      vary: bool(child(g, "varyColors"), false),
      sers,
      axIds: children(g, "axId").map((a) => attr(a, "val") ?? ""),
      first: num(child(g, "firstSliceAng")) ?? 0,
      hole: num(child(g, "holeSize")) ?? 50,
      labels: gl,
      marker: type === "line" ? bool(child(g, "marker"), true) : type === "scatter",
      index0,
      kind: m[1],
      gapDepth: num(child(g, "gapDepth")) ?? 150,
      bands: new Map(
        children(child(g, "bandFmts") ?? g, "bandFmt").flatMap((b) => {
          const c = spFill(child(b, "spPr"), theme);
          return c ? [[num(child(b, "idx")) ?? 0, c] as [number, string]] : [];
        }),
      ),
      wireframe: bool(child(g, "wireframe")),
    });
    index0 += sers.length;
  }
  // a chart group without series draws nothing (and a pie without one has no points to list)
  for (let i = groups.length - 1; i >= 0; i--) if (!groups[i].sers.length) groups.splice(i, 1);
  if (!groups.length) return null;
  const axes = new Map<string, Ax>();
  for (const a of children(plot)) {
    const k = /^(cat|val|date|ser)Ax$/.exec(a.localName);
    if (!k) continue;
    const sc = child(a, "scaling");
    const nf = child(a, "numFmt");
    const sp = child(a, "spPr");
    const mg = child(a, "majorGridlines");
    const t = child(a, "title");
    axes.set(attr(child(a, "axId") ?? a, "val") ?? "", {
      id: attr(child(a, "axId") ?? a, "val") ?? "",
      kind: k[1] as Ax["kind"],
      pos: attr(child(a, "axPos") ?? a, "val") ?? "b",
      del: bool(child(a, "delete")),
      min: num(sc && child(sc, "min")),
      max: num(sc && child(sc, "max")),
      major: num(child(a, "majorUnit")),
      reverse: attr(child(sc ?? a, "orientation") ?? a, "val") === "maxMin",
      fmt: nf ? attr(nf, "formatCode") ?? undefined : undefined,
      linked: nf ? /^(1|true)$/.test(attr(nf, "sourceLinked") ?? "0") : true,
      grid: mg ? spLine(child(mg, "spPr"), theme).c ?? "#868686" : null,
      line: (() => {
        const l = spLine(sp, theme).c;
        return l === undefined ? "#868686" : l;
      })(),
      lblPos: attr(child(a, "tickLblPos") ?? a, "val") ?? "nextTo",
      tick: attr(child(a, "majorTickMark") ?? a, "val") ?? "out",
      title: t ? { text: textOfTx(child(t, "tx")) || AUTO_TITLE[lang].axis, t: txStyle(t, theme, { ...base, size: base.size, bold: false }) } : null,
      text: txStyle(a, theme, base),
      cross: attr(child(a, "crossAx") ?? a, "val") ?? undefined,
      between: attr(child(a, "crossBetween") ?? a, "val") !== "midCat",
      crossesAt: num(child(a, "crossesAt")),
      crossesMax: attr(child(a, "crosses") ?? a, "val") === "max",
    });
  }
  // the title: its own text, or the only series' name (an automatic title)
  const te = child(chart, "title");
  const autoDel = bool(child(chart, "autoTitleDeleted"));
  let title: Model["title"] = null;
  const allSers = groups.flatMap((g) => g.sers);
  if (te) title = { text: textOfTx(child(te, "tx")) || (allSers.length === 1 ? allSers[0].name : AUTO_TITLE[lang].chart), t: txStyle(te, theme, { ...base, size: base.size * 1.8, bold: true }), overlay: bool(child(te, "overlay")) };
  else if (!autoDel && allSers.length === 1 && !groups.some((g) => g.type === "scatter")) title = { text: allSers[0].name, t: { ...base, size: base.size * 1.8, bold: true }, overlay: false };
  const le = child(chart, "legend");
  const legend: Model["legend"] = le
    ? {
        pos: attr(child(le, "legendPos") ?? le, "val") ?? "r",
        t: txStyle(le, theme, base),
        layout: layoutOf(child(le, "layout")),
        overlay: bool(child(le, "overlay")),
        del: new Set(children(le, "legendEntry").filter((e) => bool(child(e, "delete"))).map((e) => Number(attr(child(e, "idx") ?? e, "val") ?? -1))),
      }
    : null;
  const csp = child(cs, "spPr");
  const psp = child(plot, "spPr");
  const bg = spFill(csp, theme);
  const border = spLine(csp, theme).c;
  // 3-D view: the part's c:view3D, else Excel's defaults for the kind (pie 30° down; others 15° down, 20° round)
  let view3D: View3D | null = null;
  const kinds = groups.map((g) => g.kind);
  if (kinds.some((k) => k.endsWith("3D") || k === "surface")) {
    const v = child(chart, "view3D");
    const pie = kinds[0] === "pie3D";
    const contour = kinds[0] === "surface";
    const wall = (k: string) => {
      const e = child(chart, k);
      return (e && spFill(child(e, "spPr"), theme)) ?? null;
    };
    view3D = {
      rotX: num(v && child(v, "rotX")) ?? (contour ? 90 : pie ? 30 : 15),
      rotY: num(v && child(v, "rotY")) ?? (contour || pie ? 0 : 20),
      depth: num(v && child(v, "depthPercent")) ?? 100,
      perspective: num(v && child(v, "perspective")) ?? (contour ? 0 : 30),
      rAng: v && child(v, "rAngAx") ? bool(child(v, "rAngAx"), true) : kinds[0] === "bar3D",
      floor: wall("floor"),
      backWall: wall("backWall"),
      sideWall: wall("sideWall"),
    };
  }
  return {
    groups,
    axes,
    title,
    legend,
    bg: bg === undefined ? "#FFFFFF" : bg,
    border: border === undefined ? "#868686" : border,
    plotBg: spFill(psp, theme) ?? null,
    plotLayout: layoutOf(child(plot, "layout")),
    ...flags,
    base,
    theme,
    view3D,
  };
}

/** Excel's automatic series colour: accent 1–6, then the same accents darker / lighter (Office 2013+ chart colours). */
export function autoColor(theme: string[], i: number): string {
  const acc = theme[4 + (i % 6)] ?? "4472C4";
  const turn = Math.floor(i / 6);
  const mods = [[], [{ name: "lumMod", val: 60000 }], [{ name: "lumMod", val: 80000 }, { name: "lumOff", val: 20000 }], [{ name: "lumMod", val: 80000 }], [{ name: "lumMod", val: 60000 }, { name: "lumOff", val: 40000 }], [{ name: "lumMod", val: 50000 }]][turn % 6];
  return modColor(acc, mods);
}

/** The smallest 1 / 2 / 5 × 10ⁿ at least v. */
function nice(v: number): number {
  if (!(v > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * e >= v * (1 - 1e-9)) return m * e;
  return 10 * e;
}

/** Excel's automatic value scale: zero kept when the data is not far from it, about plotLen / (2.5 lines of text) steps. */
export function scale(lo: number, hi: number, ax: Ax | undefined, plotLen: number, fontPx: number, percent: boolean) {
  // a major unit that is not positive or would give more than 1000 steps over the axis (a damaged or hostile file) is
  // taken as automatic: every gridline, label and surface band loop stays bounded
  const okMajor = (lo2: number, hi2: number) => (ax?.major != null && ax.major > 0 && Math.abs(hi2 - lo2) / ax.major <= 1000 ? ax.major : undefined);
  if (percent) return { min: ax?.min ?? 0, max: ax?.max ?? 1, step: okMajor(ax?.min ?? 0, ax?.max ?? 1) ?? (plotLen > fontPx * 12 ? 0.1 : 0.2) };
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) (lo = 0), (hi = 1);
  if (lo === hi) hi = lo === 0 ? 1 : lo + Math.abs(lo);
  let min = lo >= 0 && (hi - lo) / hi > 1 / 6 ? 0 : lo;
  let max = hi <= 0 && (hi - lo) / -lo > 1 / 6 ? 0 : hi;
  if (ax?.min != null) min = ax.min;
  if (ax?.max != null) max = ax.max;
  const lines = Math.max(2, Math.min(10, Math.floor(plotLen / (fontPx * 1.2))));
  const major = okMajor(Math.min(min, lo), Math.max(max, hi));
  let step = major ?? nice((max - min) / lines);
  if (!major) while ((max - min) / step > lines + 0.5) step = nice(step * 1.01);
  if (ax?.max == null) {
    const top = max + (max > 0 && min >= 0 ? (max - min) * 0.05 : 0);
    max = Math.ceil(top / step - 1e-9) * step;
    if (max === hi && hi > 0) max += step;
  }
  if (ax?.min == null && min !== 0) min = Math.floor((lo - (min < 0 && max <= 0 ? (max - min) * 0.05 : 0)) / step + 1e-9) * step;
  if (max <= min) max = min + step;
  return { min, max, step };
}

export const fontOf = (t: Text, z: number, family: string) => `${t.bold ? "bold " : ""}${((t.size * 96) / 72) * z}px ${family}`;

export function fmtVal(v: Val, fmt: string | undefined, lang: SheetLang): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  return formatValue(v, fmt && fmt !== "General" ? fmt : undefined, { lang }).text;
}

function drawMarker(ctx: Ctx, m: Marker, x: number, y: number, color: string, z: number) {
  const r = ((m.size * 96) / 72 / 2) * z * 0.75 + 0.5 * z;
  ctx.beginPath();
  const s = m.symbol === "auto" ? "circle" : m.symbol;
  if (s === "square") ctx.rect(x - r, y - r, 2 * r, 2 * r);
  else if (s === "diamond") {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.3, y);
    ctx.lineTo(x, y + r * 1.3);
    ctx.lineTo(x - r * 1.3, y);
    ctx.closePath();
  } else if (s === "triangle") {
    ctx.moveTo(x, y - r * 1.3);
    ctx.lineTo(x + r * 1.2, y + r);
    ctx.lineTo(x - r * 1.2, y + r);
    ctx.closePath();
  } else if (s === "x" || s === "plus" || s === "star" || s === "dash" || s === "dot") {
    ctx.moveTo(x - r, y - r);
    ctx.lineTo(x + r, y + r);
    ctx.moveTo(x + r, y - r);
    ctx.lineTo(x - r, y + r);
    ctx.strokeStyle = m.line ?? color;
    ctx.lineWidth = 1 * z;
    ctx.stroke();
    return;
  } else ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = m.fill ?? color;
  ctx.fill();
  ctx.strokeStyle = m.line ?? color;
  ctx.lineWidth = 0.75 * z;
  ctx.stroke();
}

export function text(ctx: Ctx, s: string, x: number, y: number, align: CanvasTextAlign, base: CanvasTextBaseline = "middle") {
  ctx.textAlign = align;
  ctx.textBaseline = base;
  ctx.fillText(s, x, y);
}

/**
 * Paint a chart part into the rectangle (x, y, w, h) — CSS px; `z` = the sheet zoom (font and line sizes scale with it).
 * Returns false when the part holds no chart this painter knows (the caller leaves the frame empty).
 */
export function paintChart(ctx: Ctx, xml: string, theme: string[], x: number, y: number, w: number, h: number, z: number, opt: { lang: SheetLang; font: string; live?: RefValues; fonts?: string[] }): boolean {
  const key = opt.lang + xml;
  let m = opt.live ? undefined : cache.get(key);
  if (m === undefined) {
    try {
      m = parse(xml, theme, opt.live ?? (() => null), opt.lang);
    } catch {
      m = null;
    }
    if (!opt.live) {
      if (cache.size > 64) cache.clear();
      cache.set(key, m);
    }
  }
  // chart text is +mn-lt / +mn-ea: latin letters and digits in the theme's latin font, the rest in its East Asian font
  // for the chart's language (canvas falls back glyph by glyph, as Excel does by script)
  const cl = /<c:lang val="(\w\w)/.exec(xml.slice(0, 600))?.[1];
  const eaAt = ({ ko: 1, ja: 2, zh: 3, en: 0 } as Record<string, number>)[cl ?? opt.lang] ?? 1;
  const faces = [opt.fonts?.[0], eaAt ? opt.fonts?.[eaAt] : "", opt.font, "맑은 고딕", "Malgun Gothic", "Calibri"].filter((f, i, a): f is string => !!f && a.indexOf(f) === i); // i18n: keep — font names
  const family = faces.map((f) => `"${f}"`).join(", ") + ", sans-serif";
  if (!m) {
    // a chartex part (waterfall, histogram, treemap, …): its own painter
    if (/<cx:chartSpace[\s>]/.test(xml.slice(0, 400))) {
      // a painter that fails part way leaves no clip behind (the rest of the sheet draws as usual)
      ctx.save();
      try {
        return paintChartEx(ctx, xml, theme, x, y, w, h, z, opt, family);
      } catch {
        return false;
      } finally {
        ctx.restore();
      }
    }
    return false;
  }
  const px = (pt: number) => ((pt * 96) / 72) * z;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (m.bg) {
    ctx.fillStyle = m.bg;
    ctx.fillRect(x, y, w, h);
  }
  const pad = 10 * z;
  let top = y + pad, bottom = y + h - pad, left = x + pad, right = x + w - pad;
  // title
  if (m.title) {
    ctx.font = fontOf(m.title.t, z, family);
    ctx.fillStyle = m.title.t.color;
    const lines = m.title.text.split("\n");
    const fs = px(m.title.t.size);
    const lh = fs * 1.25;
    // Excel's title box is taller when the text has East Asian letters (their line height): measured at 18 pt,
    // a Korean title takes 12 px more and its text sits 6 px lower than a latin one
    const ea = /[^\u0000-ɏ -⁯]/.test(m.title.text);
    lines.forEach((l, i) => text(ctx, l, x + w / 2, top + lh * i + fs * (ea ? 1.04 : 0.71), "center"));
    if (!m.title.overlay) top += lh * (lines.length - 1) + fs * (ea ? 2.08 : 1.58);
  }
  // legend entries: per series, or per point for a varied single group (pie)
  const pieLike = m.groups[0].type === "pie" || m.groups[0].type === "doughnut";
  const varied = pieLike || (m.groups.length === 1 && m.groups[0].vary && m.groups[0].sers.length === 1);
  const colorOf = (g: Group, k: number, i?: number) => {
    const s = g.sers[k];
    if (i != null && s.pts.has(i)) return s.pts.get(i)!;
    // Excel's default chart style shades automatic pie / doughnut slices (about 88 % of the accent)
    if (i != null && (pieLike || (g.vary && g.sers.length === 1))) return pieLike ? modColor(autoColor(m!.theme, i).slice(1), [{ name: "shade", val: 88000 }]) : autoColor(m!.theme, i);
    const own = g.type === "line" || g.type === "scatter" ? s.line ?? s.fill : s.fill;
    return own ?? autoColor(m!.theme, g.index0 + k);
  };
  type Entry = { label: string; color: string; line: boolean; marker?: Marker | null };
  const entries: Entry[] = [];
  // a surface's legend lists its value bands; a 3-D line's keys are squares (ribbons, not lines)
  const surface = !!m.view3D && m.groups[0].kind.startsWith("surface");
  const surfLen = h * 0.28;
  if (surface) for (const e of surfaceLegend(m, surfLen, px(([...m.axes.values()].find((a) => a.kind === "val")?.text ?? m.base).size), opt.lang)) entries.push({ ...e, line: false });
  else if (varied) {
    const g = m.groups[0];
    const s = g.sers[0];
    const n = Math.max(s.vals.length, s.xs.length);
    for (let i = 0; i < n; i++) entries.push({ label: fmtVal(s.xs[i] ?? i + 1, s.xFmt, opt.lang), color: colorOf(g, 0, i), line: false });
  } else
    for (const g of m.groups)
      g.sers.forEach((s, k) => {
        const flat3D = g.kind === "line3D";
        const lineLike = !flat3D && (((g.type === "line" || (g.type === "radar" && g.grouping !== "filled")) && s.line !== null) || (g.type === "scatter" && s.line !== null && !s.sizes));
        entries.push({ label: s.name, color: colorOf(g, k), line: lineLike, marker: g.marker && !flat3D ? (s.marker === undefined ? { symbol: AUTO_SYM[(g.index0 + k) % 7], size: 5, fill: null, line: null } : s.marker) : null });
      });
  const lg = m.legend;
  let legendBox: { x: number; y: number; w: number; h: number } | null = null;
  if (lg) {
    ctx.font = fontOf(lg.t, z, family);
    const fs = px(lg.t.size);
    const sw = fs * 0.55;
    // a line series' key is a stretch of line (about 3.5 squares long, its marker in the middle), else a square
    const keyW = (e: Entry) => (e.line ? sw * 3.5 : sw) + 4 * z;
    let items = entries.map((e, i) => ({ ...e, i, w: keyW(e) + ctx.measureText(e.label).width })).filter((e) => !lg.del.has(e.i));
    const vertical = lg.pos === "r" || lg.pos === "l" || lg.pos === "tr";
    // Excel lists stacked columns / areas top series first in a side legend, as they are stacked
    if (vertical && !varied && m.groups.every((g) => (g.type === "bar" && !g.horiz) || g.type === "area") && m.groups.some((g) => g.grouping === "stacked" || g.grouping === "percentStacked")) items = items.reverse();
    const rowH = fs * (vertical ? 1.8 : 1.35);
    if (vertical) {
      // measured on Excel's pictures: the legend's text ends 15 px from the chart's right edge, the plot area ends
      // 22 px before the legend keys
      const lw = Math.min(w * 0.45, Math.max(0, ...items.map((e) => e.w)));
      const lh = rowH * items.length;
      const lx = lg.pos === "l" ? left : x + w - 13 * z - lw;
      const ly = lg.pos === "tr" ? top : top + (bottom - top - lh) / 2 + 2.5 * z;
      legendBox = { x: lx, y: ly, w: lw, h: lh };
      if (!lg.overlay) {
        if (lg.pos === "l") left = lx + lw + 16 * z;
        else right = lx - 20 * z;
      }
    } else {
      const rows: (typeof items)[] = [[]];
      let rw = 0;
      const gapI = 10 * z;
      for (const e of items) {
        if (rw + e.w > w - 2 * pad && rows[rows.length - 1].length) {
          rows.push([]);
          rw = 0;
        }
        rows[rows.length - 1].push(e);
        rw += e.w + gapI;
      }
      const lh = rowH * rows.length;
      const ly = lg.pos === "t" ? top + 5 * z : bottom - lh;
      legendBox = { x: left, y: ly, w: right - left, h: lh };
      if (!lg.overlay) {
        if (lg.pos === "t") top += lh + 9 * z;
        else bottom -= lh + 4 * z;
      }
    }
    if (lg.layout) legendBox = { x: x + lg.layout[0] * w, y: y + lg.layout[1] * h, w: lg.layout[2] > 0 ? lg.layout[2] * w : legendBox.w, h: lg.layout[3] > 0 ? lg.layout[3] * h : legendBox.h };
    // drawn at the end (over the plot when overlaid); remember what to draw
    const lb = legendBox;
    const drawLegend = () => {
      ctx.font = fontOf(lg.t, z, family);
      const place = (e: (typeof items)[number], ex: number, ey: number) => {
        const kw = keyW(e);
        if (!e.line && e.marker) drawMarker(ctx, e.marker, ex + sw / 2, ey, e.color, z);
        else if (e.line) {
          ctx.strokeStyle = e.color;
          ctx.lineWidth = 2 * z;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex + sw * 3.5, ey);
          ctx.stroke();
          if (e.marker) drawMarker(ctx, e.marker, ex + sw * 1.75, ey, e.color, z);
        } else {
          ctx.fillStyle = e.color;
          ctx.fillRect(Math.round(ex), Math.round(ey - sw / 2), Math.round(sw), Math.round(sw));
        }
        ctx.fillStyle = lg.t.color;
        text(ctx, e.label, ex + kw, ey, "left");
        return kw + ctx.measureText(e.label).width;
      };
      if (vertical) items.forEach((e, i) => place(e, lb.x, lb.y + rowH * (i + 0.5)));
      else {
        const gapI = 10 * z;
        const rows: (typeof items)[] = [[]];
        let rw = 0;
        for (const e of items) {
          const ew = e.w;
          if (rw + ew > lb.w && rows[rows.length - 1].length) {
            rows.push([]);
            rw = 0;
          }
          rows[rows.length - 1].push({ ...e, w: ew });
          rw += ew + gapI;
        }
        rows.forEach((row, ri) => {
          const tw = row.reduce((a, e) => a + e.w, 0) + gapI * (row.length - 1);
          let ex = lb.x + (lb.w - tw) / 2;
          for (const e of row) {
            place(e, ex, lb.y + rowH * (ri + 0.5));
            ex += e.w + gapI;
          }
        });
      }
    };
    (legendBox as any).draw = drawLegend;
  }
  ctx.strokeStyle = "transparent";
  const env3D = (): Env3D => ({ ctx, m: m!, z, family, lang: opt.lang, left, top, right, bottom, colorOf, surfLen });
  // ───── pie / doughnut ─────
  if (pieLike) {
    const g = m.groups[0];
    const s = g.sers[0];
    const vals = s.vals.map((v) => (typeof v === "number" && v > 0 ? v : 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    let pl = left, pt = top, pw = right - left, ph = bottom - top;
    if (m.plotLayout) [pl, pt, pw, ph] = [x + m.plotLayout[0] * w, y + m.plotLayout[1] * h, m.plotLayout[2] > 0 ? m.plotLayout[2] * w : pw, m.plotLayout[3] > 0 ? m.plotLayout[3] * h : ph];
    const lbl0 = s.labels ?? g.labels;
    if (m.view3D && g.kind === "pie3D") paintPie3D(env3D(), { x: pl, y: pt, w: pw, h: ph }, !!(lbl0 && (lbl0.val || lbl0.pct || lbl0.cat)));
    else {
      const r = Math.max(2, (Math.min(pw, ph) / 2) * (lbl0 && (lbl0.val || lbl0.pct || lbl0.cat) ? 0.82 : 0.97));
      const cx = pl + pw / 2 + 2 * z, cy = pt + ph / 2 + 2 * z;
      let a0 = -Math.PI / 2 + (g.first * Math.PI) / 180;
      const mids: { a: number; i: number; frac: number }[] = [];
      vals.forEach((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2;
        if (v > 0) {
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, r, a0, a1);
          ctx.closePath();
          ctx.fillStyle = colorOf(g, 0, i);
          ctx.fill();
          ctx.strokeStyle = "#FFFFFF";
          ctx.lineWidth = 1 * z;
          ctx.stroke();
        }
        mids.push({ a: (a0 + a1) / 2, i, frac: v / total });
        a0 = a1;
      });
      if (g.type === "doughnut") {
        ctx.beginPath();
        ctx.arc(cx, cy, (r * g.hole) / 100, 0, Math.PI * 2);
        ctx.fillStyle = m.bg ?? "#FFFFFF";
        ctx.fill();
      }
      const lb = s.labels ?? g.labels;
      if (lb && (lb.val || lb.pct || lb.cat || lb.ser)) {
        ctx.font = fontOf(lb.text, z, family);
        for (const md of mids) {
          if (!md.frac) continue;
          const parts: string[] = [];
          if (lb.ser) parts.push(s.name);
          if (lb.cat) parts.push(fmtVal(s.xs[md.i] ?? md.i + 1, s.xFmt, opt.lang));
          if (lb.val) parts.push(fmtVal(s.vals[md.i], lb.fmt ?? s.fmt, opt.lang));
          if (lb.pct) parts.push(formatValue(md.frac, "0%", { lang: opt.lang }).text);
          const outside = lb.pos === "outEnd";
          const rr = g.type === "doughnut" ? r * (1 + g.hole / 100) / 2 : outside ? r + px(lb.text.size) : lb.pos === "inEnd" ? r * 0.8 : r * (lb.pos === "ctr" ? 0.5 : 0.62);
          ctx.fillStyle = outside ? lb.text.color : lb.text.color === "#595959" ? "#404040" : lb.text.color;
          text(ctx, parts.join(", "), cx + rr * Math.cos(md.a), cy + rr * Math.sin(md.a), "center");
        }
      }
    }
  } else if (m.view3D && !m.is3D) {
    // ───── 3-D columns, lines, areas, surfaces ─────
    paint3D(env3D());
  } else if (m.groups[0].type === "radar") {
    // ───── radar: a spoke per category, value rings, a closed line per series ─────
    const g = m.groups[0];
    const vAx = [...m.axes.values()].find((a) => a.kind === "val");
    const n = Math.max(1, ...g.sers.map((s) => s.vals.length));
    const all = g.sers.flatMap((s) => s.vals.filter((v): v is number => typeof v === "number"));
    const vt = vAx?.text ?? m.base;
    const fsV = px(vt.size);
    const cx = (left + right) / 2, cy = (top + bottom) / 2 + fsV * 0.45;
    const R = Math.max(4, Math.min(right - left, bottom - top) / 2 - fsV * 2.5);
    const vs = scale(Math.min(0, ...all), Math.max(0, ...all), vAx, R, fsV * 1.6, false);
    const at = (i: number, v: number) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const r = ((v - vs.min) / (vs.max - vs.min || 1)) * R;
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const;
    };
    ctx.strokeStyle = vAx?.grid ?? "#D9D9D9";
    ctx.lineWidth = Math.max(1, 0.75 * z);
    for (let v = vs.min, k = 0; v <= vs.max + vs.step * 1e-6 && k < 50; k++, v = vs.min + vs.step * k) {
      ctx.beginPath();
      for (let i = 0; i <= n; i++) {
        const [px2, py] = at(i % n, v);
        if (i) ctx.lineTo(px2, py);
        else ctx.moveTo(px2, py);
      }
      ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const [px2, py] = at(i, vs.max);
      ctx.moveTo(cx, cy);
      ctx.lineTo(px2, py);
    }
    ctx.stroke();
    const ref = g.sers.find((s) => s.xs.length);
    ctx.font = fontOf(vt, z, family);
    ctx.fillStyle = vt.color;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      text(ctx, ref ? fmtVal(ref.xs[i] ?? "", ref.xFmt, opt.lang) : String(i + 1), cx + (R + fsV * 0.9) * c, cy + (R + fsV * 0.9) * sn, Math.abs(c) < 0.2 ? "center" : c > 0 ? "left" : "right");
    }
    for (let v = vs.min, k = 0; v <= vs.max + vs.step * 1e-6 && k < 50; k++, v = vs.min + vs.step * k) text(ctx, fmtVal(v, vAx?.fmt && vAx.fmt !== "General" ? vAx.fmt : undefined, opt.lang), cx - 3 * z, at(0, v)[1], "right");
    g.sers.forEach((s, k) => {
      const color = colorOf(g, k);
      ctx.beginPath();
      s.vals.forEach((v, i) => {
        const [px2, py] = at(i, typeof v === "number" ? v : vs.min);
        if (i) ctx.lineTo(px2, py);
        else ctx.moveTo(px2, py);
      });
      ctx.closePath();
      if (g.grouping === "filled") {
        ctx.fillStyle = color;
        ctx.fill();
      } else {
        ctx.strokeStyle = color;
        ctx.lineWidth = (s.lineW ?? 2.5) * z;
        ctx.stroke();
      }
    });
  } else {
    // ───── axes charts ─────
    const valAxes = [...m.axes.values()].filter((a) => a.kind === "val");
    const catAxes = [...m.axes.values()].filter((a) => a.kind !== "val");
    const scatter = m.groups.some((g) => g.type === "scatter");
    const horiz = m.groups.some((g) => g.type === "bar" && g.horiz);
    const vAx = (scatter ? valAxes.find((a) => a.pos === "l" || a.pos === "r") : valAxes[0]) ?? valAxes[0];
    const cAx = scatter ? valAxes.find((a) => a !== vAx) : catAxes[0];
    const percent = m.groups.some((g) => g.grouping === "percentStacked");
    // data extent (stacks summed)
    let lo = Infinity, hi = -Infinity, nCat = 0, xlo = Infinity, xhi = -Infinity;
    for (const g of m.groups) {
      const n = Math.max(0, ...g.sers.map((s) => Math.max(s.vals.length, s.xs.length)));
      nCat = Math.max(nCat, n);
      if (g.grouping === "stacked" || g.grouping === "percentStacked") {
        for (let i = 0; i < n; i++) {
          let pos = 0, neg = 0;
          for (const s of g.sers) {
            const v = typeof s.vals[i] === "number" ? (s.vals[i] as number) : 0;
            if (v >= 0) pos += v;
            else neg += v;
          }
          lo = Math.min(lo, neg);
          hi = Math.max(hi, pos);
        }
      } else
        for (const s of g.sers)
          for (const v of s.vals)
            if (typeof v === "number") {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
      if (g.type === "scatter")
        for (const s of g.sers)
          s.vals.forEach((_, i) => {
            const xv = typeof s.xs[i] === "number" ? (s.xs[i] as number) : i + 1;
            xlo = Math.min(xlo, xv);
            xhi = Math.max(xhi, xv);
          });
    }
    const valFmt = (v: number) => (percent ? formatValue(v, vAx?.fmt && !vAx.linked ? vAx.fmt : "0%", { lang: opt.lang }).text : fmtVal(v, vAx?.fmt && (!vAx.linked || vAx.fmt !== "General") ? vAx.fmt : m!.groups[0].sers[0]?.fmt, opt.lang));
    const vText = vAx?.text ?? m.base;
    const cText = cAx?.text ?? m.base;
    const vfs = px(vText.size), cfs = px(cText.size);
    const valLen0 = horiz ? (right - left) * 0.95 : bottom - top - cfs * 2.3 - vfs;
    let vs = scale(lo, hi, vAx, valLen0, horiz ? vfs * 3.33 : vfs, percent);
    let xs = scatter ? scale(xlo, xhi, cAx, right - left, cfs * 3.33, false) : null;
    // axis titles
    const vTitle = vAx && !vAx.del ? vAx.title : null, cTitle = cAx && !cAx.del ? cAx.title : null;
    const sideTitle = horiz ? cTitle : vTitle, bottomTitle = horiz ? vTitle : cTitle;
    if (sideTitle) left += px(sideTitle.t.size) * 1.4 + 4 * z;
    if (bottomTitle) bottom -= px(bottomTitle.t.size) * 1.4 + 4 * z;
    // label sizes
    ctx.font = fontOf(vText, z, family);
    const vLabels: { v: number; s: string }[] = [];
    for (let v = vs.min, k = 0; v <= vs.max + vs.step * 1e-6 && k < 200; k++, v = vs.min + vs.step * k) vLabels.push({ v, s: valFmt(Math.abs(v) < vs.step * 1e-9 ? 0 : v) });
    const vShow = vAx && !vAx.del && vAx.lblPos !== "none";
    const cShow = cAx && !cAx.del && cAx.lblPos !== "none";
    ctx.font = fontOf(cText, z, family);
    const cats: string[] = [];
    if (!scatter) {
      const ref = m.groups.flatMap((g) => g.sers).find((s) => s.xs.length);
      for (let i = 0; i < nCat; i++) cats.push(ref ? fmtVal(ref.xs[i] ?? "", cAx?.fmt && !cAx.linked ? cAx.fmt : ref.xFmt, opt.lang) : String(i + 1));
    }
    let pl: number, pt: number, pw: number, ph: number;
    ctx.font = fontOf(vText, z, family);
    // gaps measured on Excel's pictures (10 pt labels): value labels end 13 px before the axis, category labels 15 px;
    // under the plot, category labels take 2.3 lines and value labels (bar, XY charts) 1.8
    const vGap = 11 * z, cGap = 13 * z;
    // the plot's top: 2 px under the room for columns, 1 px for lines, areas and XY charts (their gridlines sit a pixel
    // higher on Excel's pictures: line 0.85 → 0.92, XY 0.85 → 0.97, area 0.81 → 0.86); bubbles 3.5 px (2 px lower there)
    const anyBar0 = m.groups.some((g) => g.type === "bar"), bubbly = m.groups.some((g) => g.sers.some((s) => s.sizes));
    const vLabW = vShow ? Math.max(0, ...vLabels.map((l) => ctx.measureText(l.s).width)) : 0;
    const vLast = vShow && vLabels.length ? ctx.measureText(vLabels[vLabels.length - 1].s).width : 0;
    ctx.font = fontOf(cText, z, family);
    const cLabW = cShow && horiz ? Math.max(0, ...cats.map((c) => ctx.measureText(c).width)) : 0;
    if (horiz) {
      pl = left - 2 * z + (cShow ? cLabW + cGap : 0);
      pt = top + 2 * z + vfs * 0.5;
      pw = right - pl - Math.max(2 * z, vLast / 2);
      ph = bottom - pt - (vShow ? vfs * 1.8 : 0);
    } else {
      // (a bubble chart's plot is 2 px wider on the left and 7 px narrower on the right on Excel's picture)
      pl = left + (vShow ? vLabW + vGap : 0) - (bubbly ? 1.6 * z : 0);
      pt = top + (anyBar0 ? 2 : bubbly ? 3.5 : 1) * z + vfs * 0.5;
      ctx.font = fontOf(cText, z, family);
      // the last label under the plot sits on its right edge (XY charts, categories on the band edges): half of it is room
      const edgeCats = !scatter && vAx?.between === false && !m.groups.some((g) => g.type === "bar");
      const xLast = !cShow ? 0 : scatter && xs ? ctx.measureText(fmtVal(xs.max, cAx?.fmt && cAx.fmt !== "General" ? cAx.fmt : undefined, opt.lang)).width : edgeCats && cats.length ? ctx.measureText(cats[cats.length - 1]).width : 0;
      pw = right - pl - Math.max(2 * z, xLast / 2) - (bubbly ? 5.6 * z : 0);
      ph = bottom - pt - (cShow ? cfs * (scatter ? 1.8 : 2.3) : 0);
    }
    if (m.plotLayout) {
      const [lx, ly, lw, lh, inner] = m.plotLayout;
      if (inner) {
        pl = x + lx * w;
        pt = y + ly * h;
        if (lw > 0) pw = lw * w;
        if (lh > 0) ph = lh * h;
      }
    }
    pw = Math.max(4, pw);
    ph = Math.max(4, ph);
    // bubbles: Excel widens both scales so the bubbles fit inside the plot (sizes 5…22 at y 9…22: 0–30, not 0–25)
    const bubbleSers = m.groups.flatMap((g) => g.sers.filter((s) => s.sizes));
    if (bubbleSers.length && xs) {
      const big = Math.max(1e-9, ...bubbleSers.flatMap((s) => s.sizes!.map((v) => (typeof v === "number" ? Math.abs(v) : 0))));
      const dmax = Math.min(pw, ph) * BUBBLE;
      let ylo = lo, yhi = hi, bxlo = xlo, bxhi = xhi;
      for (const s of bubbleSers)
        s.vals.forEach((v, i) => {
          const sz = s.sizes![i];
          if (typeof v !== "number" || typeof sz !== "number" || sz <= 0) return;
          const r = (Math.sqrt(sz / big) * dmax) / 2;
          const xv = typeof s.xs[i] === "number" ? (s.xs[i] as number) : i + 1;
          ylo = Math.min(ylo, v - (r * (vs.max - vs.min)) / ph);
          yhi = Math.max(yhi, v + (r * (vs.max - vs.min)) / ph);
          bxlo = Math.min(bxlo, xv - (r * (xs!.max - xs!.min)) / pw);
          bxhi = Math.max(bxhi, xv + (r * (xs!.max - xs!.min)) / pw);
        });
      // values ≥ 0 keep a zero floor (a bubble reaching under it does not move the axis below 0)
      vs = scale(lo >= 0 ? Math.max(0, ylo) : ylo, yhi, vAx, valLen0, vfs, percent);
      xs = scale(xlo >= 0 ? Math.max(0, bxlo) : bxlo, bxhi, cAx, right - left, cfs * 3.33, false);
      vLabels.length = 0;
      for (let v = vs.min, k = 0; v <= vs.max + vs.step * 1e-6 && k < 200; k++, v = vs.min + vs.step * k) vLabels.push({ v, s: valFmt(Math.abs(v) < vs.step * 1e-9 ? 0 : v) });
    }
    if (m.plotBg) {
      ctx.fillStyle = m.plotBg;
      ctx.fillRect(pl, pt, pw, ph);
    }
    const vPos = (v: number) => {
      const f = (v - vs.min) / (vs.max - vs.min || 1);
      const ff = vAx?.reverse ? 1 - f : f;
      return horiz ? pl + ff * pw : pt + ph - ff * ph;
    };
    // crossBetween sits on the value axis: "between" puts the points mid-band, "midCat" on the band edges (area charts)
    const between = scatter ? false : vAx?.between ?? true;
    const anyBar = m.groups.some((g) => g.type === "bar");
    const bands = Math.max(1, between || anyBar ? nCat : nCat - 1);
    const catRev = cAx?.reverse ?? false;
    const catPos = (i: number) => {
      const f = between || anyBar ? (i + 0.5) / bands : nCat > 1 ? i / (nCat - 1) : 0.5;
      const ff = catRev ? 1 - f : f;
      return horiz ? pt + ph - ff * ph : pl + ff * pw;
    };
    const xPos = (v: number) => pl + ((v - xs!.min) / (xs!.max - xs!.min || 1)) * pw;
    // gridlines
    ctx.lineWidth = Math.max(1, 0.75 * z);
    if (vAx?.grid) {
      ctx.strokeStyle = vAx.grid;
      ctx.beginPath();
      for (const l of vLabels) {
        const p = Math.round(vPos(l.v)) + 0.5;
        if (horiz) {
          ctx.moveTo(p, pt);
          ctx.lineTo(p, pt + ph);
        } else {
          ctx.moveTo(pl, p);
          ctx.lineTo(pl + pw, p);
        }
      }
      ctx.stroke();
    }
    if (scatter && xs && cAx?.grid) {
      ctx.strokeStyle = cAx.grid;
      ctx.beginPath();
      for (let v = xs.min, k = 0; v <= xs.max + xs.step * 1e-6 && k < 200; k++, v = xs.min + xs.step * k) {
        const p = Math.round(xPos(v)) + 0.5;
        ctx.moveTo(p, pt);
        ctx.lineTo(p, pt + ph);
      }
      ctx.stroke();
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(pl - 1, pt - 1, pw + 2, ph + 2);
    ctx.clip();
    const zeroP = vPos(Math.max(vs.min, Math.min(vs.max, 0)));
    const labelJobs: (() => void)[] = [];
    for (const g of m.groups) {
      const n = Math.max(0, ...g.sers.map((s) => s.vals.length));
      const stacked = g.grouping === "stacked" || g.grouping === "percentStacked";
      const totals = g.grouping === "percentStacked" ? Array.from({ length: n }, (_, i) => g.sers.reduce((a, s) => a + Math.abs(typeof s.vals[i] === "number" ? (s.vals[i] as number) : 0), 0) || 1) : null;
      const val = (s: Ser, i: number) => {
        const v = typeof s.vals[i] === "number" ? (s.vals[i] as number) : null;
        return v == null ? null : totals ? v / totals[i] : v;
      };
      const posBase = new Array(n).fill(0), negBase = new Array(n).fill(0);
      if (g.type === "bar") {
        const band = (horiz ? ph : pw) / bands;
        const ns = stacked ? 1 : g.sers.length;
        const ov = Math.max(-1, Math.min(1, g.overlap / 100));
        const bw = band / (ns - (ns - 1) * ov + g.gap / 100);
        g.sers.forEach((s, k) => {
          for (let i = 0; i < n; i++) {
            const v = val(s, i);
            if (v == null) continue;
            let a = 0, b = v;
            if (stacked) {
              if (v >= 0) (a = posBase[i]), (b = posBase[i] += v);
              else (a = negBase[i]), (b = negBase[i] += v);
            }
            const c0 = catPos(i) - (bw * (ns - (ns - 1) * ov)) / 2 + (stacked ? 0 : k * bw * (1 - ov));
            const p0 = vPos(a), p1 = vPos(b);
            ctx.fillStyle = colorOf(g, k, s.pts.has(i) || (g.vary && g.sers.length === 1) ? i : undefined);
            if (horiz) {
              const yy = horiz ? catPos(i) + (bw * (ns - (ns - 1) * ov)) / 2 - (stacked ? 0 : k * bw * (1 - ov)) - bw : c0;
              ctx.fillRect(Math.min(p0, p1), yy, Math.abs(p1 - p0), bw);
              if (s.line) {
                ctx.strokeStyle = s.line;
                ctx.lineWidth = (s.lineW ?? 1) * z;
                ctx.strokeRect(Math.min(p0, p1), yy, Math.abs(p1 - p0), bw);
              }
              const lb = s.labels ?? g.labels;
              if (lb && (lb.val || lb.cat || lb.ser)) labelJobs.push(() => barLabel(lb, s, i, v, p0, p1, yy + bw / 2, true, stacked));
            } else {
              ctx.fillRect(c0, Math.min(p0, p1), bw, Math.abs(p1 - p0));
              if (s.line) {
                ctx.strokeStyle = s.line;
                ctx.lineWidth = (s.lineW ?? 1) * z;
                ctx.strokeRect(c0, Math.min(p0, p1), bw, Math.abs(p1 - p0));
              }
              const lb = s.labels ?? g.labels;
              if (lb && (lb.val || lb.cat || lb.ser)) labelJobs.push(() => barLabel(lb, s, i, v, p0, p1, c0 + bw / 2, false, stacked));
            }
          }
        });
      } else if (g.type === "area") {
        g.sers.forEach((s, k) => {
          const top: [number, number][] = [], bot: [number, number][] = [];
          for (let i = 0; i < n; i++) {
            const v = val(s, i) ?? 0;
            const a = stacked ? posBase[i] : 0;
            const b = stacked ? (posBase[i] += v) : v;
            top.push([catPos(i), vPos(b)]);
            bot.push([catPos(i), vPos(a)]);
          }
          if (!top.length) return;
          ctx.beginPath();
          top.forEach(([px2, py], i) => (i ? ctx.lineTo(px2, py) : ctx.moveTo(px2, py)));
          for (let i = bot.length - 1; i >= 0; i--) ctx.lineTo(bot[i][0], bot[i][1]);
          ctx.closePath();
          ctx.fillStyle = colorOf(g, k);
          ctx.fill();
        });
      } else if (g.type === "line" || g.type === "scatter" || g.type === "radar") {
        g.sers.forEach((s, k) => {
          const color = colorOf(g, k);
          const pts: ([number, number] | null)[] = [];
          for (let i = 0; i < n; i++) {
            let v = val(s, i);
            if (v != null && stacked) v = posBase[i] += v;
            if (v == null) {
              pts.push(null);
              continue;
            }
            const xv = g.type === "scatter" ? (typeof s.xs[i] === "number" ? (s.xs[i] as number) : i + 1) : 0;
            pts.push([g.type === "scatter" ? xPos(xv) : catPos(i), vPos(v)]);
          }
          if (s.line !== null && !s.sizes) {
            ctx.strokeStyle = color;
            ctx.lineWidth = (s.lineW ?? 2.5) * z;
            ctx.lineJoin = "round";
            ctx.lineCap = "round";
            ctx.beginPath();
            let pen = false;
            for (const p of pts) {
              if (!p) {
                pen = false;
                continue;
              }
              if (pen) ctx.lineTo(p[0], p[1]);
              else ctx.moveTo(p[0], p[1]);
              pen = true;
            }
            ctx.stroke();
          }
          const mk = s.marker === undefined ? (g.marker ? { symbol: AUTO_SYM[(g.index0 + k) % 7], size: 5, fill: null, line: null } : null) : s.marker;
          if (s.sizes) {
            // bubbles: area by size, the biggest about a quarter of the plot's shorter side across (bubble scale 100 %);
            // a fill with its own alpha (Excel's default style: 75 %) is used as it is, else 75 %
            const big = Math.max(1e-9, ...s.sizes.map((v) => (typeof v === "number" ? Math.abs(v) : 0)));
            const dmax = Math.min(pw, ph) * BUBBLE;
            pts.forEach((p, i) => {
              const sz = s.sizes![i];
              if (!p || typeof sz !== "number" || sz <= 0) return;
              ctx.beginPath();
              ctx.arc(p[0], p[1], (Math.sqrt(sz / big) * dmax) / 2, 0, Math.PI * 2);
              ctx.globalAlpha = s.fill && s.fill.startsWith("rgba") ? 1 : 0.75;
              ctx.fillStyle = s.fill ?? color;
              ctx.fill();
              ctx.globalAlpha = 1;
              if (s.line !== null) {
                ctx.strokeStyle = s.line ?? "#FFFFFF";
                ctx.lineWidth = 0.75 * z;
                ctx.stroke();
              }
            });
          } else if (mk) for (const p of pts) if (p) drawMarker(ctx, mk, p[0], p[1], color, z);
          const lb = s.labels ?? g.labels;
          if (lb && (lb.val || lb.cat || lb.ser))
            labelJobs.push(() => {
              ctx.font = fontOf(lb.text, z, family);
              ctx.fillStyle = lb.text.color;
              pts.forEach((p, i) => {
                if (!p) return;
                const parts = [lb.ser ? s.name : "", lb.cat ? (g.type === "scatter" ? fmtVal(s.xs[i], s.xFmt, opt.lang) : cats[i] ?? "") : "", lb.val ? fmtVal(s.vals[i], lb.fmt ?? s.fmt, opt.lang) : ""].filter(Boolean);
                const pos = lb.pos ?? "r";
                const off = 10 * z;
                const [lx, ly, al]: [number, number, CanvasTextAlign] = pos === "t" ? [p[0], p[1] - off - px(lb.text.size) / 2, "center"] : pos === "b" ? [p[0], p[1] + off + px(lb.text.size) / 2, "center"] : pos === "l" ? [p[0] - off, p[1], "right"] : pos === "ctr" ? [p[0], p[1], "center"] : [p[0] + off, p[1], "left"];
                text(ctx, parts.join(", "), lx, ly, al);
              });
            });
        });
      }
    }
    ctx.restore();
    function barLabel(lb: Labels, s: Ser, i: number, v: number, p0: number, p1: number, mid: number, hz: boolean, stacked: boolean) {
      ctx.font = fontOf(lb.text, z, family);
      ctx.fillStyle = lb.text.color;
      const parts = [lb.ser ? s.name : "", lb.cat ? cats[i] ?? "" : "", lb.val ? fmtVal(s.vals[i], lb.fmt ?? s.fmt, opt.lang) : ""].filter(Boolean);
      const t = parts.join(", ");
      const pos = lb.pos ?? (stacked ? "ctr" : "outEnd");
      const dir = v >= 0 ? 1 : -1;
      const off = 3 * z;
      if (hz) {
        const at = pos === "ctr" ? (p0 + p1) / 2 : pos === "inEnd" ? p1 - dir * off : pos === "inBase" ? p0 + dir * off : p1 + dir * off;
        text(ctx, t, at, mid, pos === "ctr" ? "center" : (pos === "outEnd") === dir > 0 ? "left" : "right");
      } else {
        const at = pos === "ctr" ? (p0 + p1) / 2 : pos === "inEnd" ? p1 + dir * off : pos === "inBase" ? p0 - dir * off : p1 - dir * off;
        text(ctx, t, mid, at, "center", pos === "ctr" ? "middle" : (pos === "outEnd") === dir > 0 ? "bottom" : "top");
      }
    }
    for (const j of labelJobs) j();
    // axis lines
    ctx.lineWidth = Math.max(1, 0.75 * z);
    if (cAx && !cAx.del && cAx.line) {
      ctx.strokeStyle = cAx.line;
      ctx.beginPath();
      if (scatter) {
        const p = Math.round(vPos(Math.max(vs.min, Math.min(vs.max, 0)))) + 0.5;
        ctx.moveTo(pl, p);
        ctx.lineTo(pl + pw, p);
      } else if (horiz) {
        const p = Math.round(zeroP) + 0.5;
        ctx.moveTo(p, pt);
        ctx.lineTo(p, pt + ph);
      } else {
        const p = Math.round(zeroP) + 0.5;
        ctx.moveTo(pl, p);
        ctx.lineTo(pl + pw, p);
      }
      ctx.stroke();
    }
    if (vAx && !vAx.del && vAx.line) {
      ctx.strokeStyle = vAx.line;
      ctx.beginPath();
      if (horiz) {
        ctx.moveTo(pl, Math.round(pt + ph) + 0.5);
        ctx.lineTo(pl + pw, Math.round(pt + ph) + 0.5);
      } else {
        const p = scatter && xs ? Math.round(xPos(Math.max(xs.min, Math.min(xs.max, 0)))) + 0.5 : Math.round(pl) + 0.5;
        ctx.moveTo(p, pt);
        ctx.lineTo(p, pt + ph);
      }
      ctx.stroke();
    }
    // major tick marks (out / in / cross)
    const tk = 4 * z;
    const ticks = (ax: Ax | undefined, along: number[], at: number, vertical: boolean) => {
      if (!ax || ax.del || !ax.line || ax.tick === "none") return;
      const a = ax.tick === "in" ? 0 : -tk, b = ax.tick === "out" ? 0 : tk;
      ctx.strokeStyle = ax.line;
      ctx.beginPath();
      for (const p0 of along) {
        const p = Math.round(p0) + 0.5;
        if (vertical) {
          ctx.moveTo(at + a, p);
          ctx.lineTo(at + b, p);
        } else {
          ctx.moveTo(p, at - a);
          ctx.lineTo(p, at - b);
        }
      }
      ctx.stroke();
    };
    const vAt = vLabels.map((l) => vPos(l.v));
    if (horiz) ticks(vAx, vAt, Math.round(pt + ph) + 0.5, false);
    else ticks(vAx, vAt, Math.round(scatter && xs ? xPos(Math.max(xs.min, Math.min(xs.max, 0))) : pl) + 0.5, true);
    if (!scatter) {
      const edges = Array.from({ length: bands + 1 }, (_, i) => (horiz ? pt + ph - (i / bands) * ph : pl + (i / bands) * pw));
      if (horiz) ticks(cAx, edges, Math.round(zeroP) + 0.5, true);
      else ticks(cAx, edges, Math.round(zeroP) + 0.5, false);
    }
    // axis labels
    if (vShow) {
      ctx.font = fontOf(vText, z, family);
      ctx.fillStyle = vText.color;
      for (const l of vLabels) {
        const p = vPos(l.v);
        if (horiz) text(ctx, l.s, p, pt + ph + vfs * 1.37, "center");
        else text(ctx, l.s, pl - vGap, p, "right");
      }
    }
    if (cShow) {
      ctx.font = fontOf(cText, z, family);
      ctx.fillStyle = cText.color;
      if (scatter && xs) {
        for (let v = xs.min, k = 0; v <= xs.max + xs.step * 1e-6 && k < 200; k++, v = xs.min + xs.step * k) text(ctx, fmtVal(v, cAx?.fmt && cAx.fmt !== "General" ? cAx.fmt : undefined, opt.lang), xPos(v), pt + ph + cfs * 1.37, "center");
      } else if (horiz) {
        cats.forEach((c, i) => text(ctx, c, pl - cGap, catPos(i), "right"));
      } else {
        const band = pw / bands;
        const widest = Math.max(1, ...cats.map((c) => ctx.measureText(c).width));
        const every = Math.max(1, Math.ceil((widest + 4 * z) / band));
        const yAt = Math.max(pt + ph, Math.min(pt + ph, zeroP)) + cfs * 1.67;
        cats.forEach((c, i) => {
          if (i % every) return;
          text(ctx, c, catPos(i), yAt, "center");
        });
      }
    }
    // axis titles
    if (sideTitle) {
      ctx.save();
      ctx.font = fontOf(sideTitle.t, z, family);
      ctx.fillStyle = sideTitle.t.color;
      ctx.translate(left - px(sideTitle.t.size) * 0.9 - 4 * z - cLabW * 0, pt + ph / 2);
      ctx.rotate(-Math.PI / 2);
      text(ctx, sideTitle.text, 0, 0, "center");
      ctx.restore();
    }
    if (bottomTitle) {
      ctx.font = fontOf(bottomTitle.t, z, family);
      ctx.fillStyle = bottomTitle.t.color;
      text(ctx, bottomTitle.text, pl + pw / 2, bottom + px(bottomTitle.t.size) * 0.9 + 4 * z, "center");
    }
  }
  if (legendBox) (legendBox as any).draw();
  if (m.is3D || m.simplified) {
    ctx.font = `${px(7)}px ${family}`;
    ctx.fillStyle = "#8C8C8C";
    text(ctx, DICTS[opt.lang]?.[m.is3D ? "sheetchart.flat3d" : "sheetchart.simplified"] ?? "", x + 4 * z, y + 4 * z, "left", "top");
  }
  if (m.border) {
    ctx.strokeStyle = m.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(h) - 1);
  }
  ctx.restore();
  return true;
}
