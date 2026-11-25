// Sheet painter (표 계산 격자): draws a worksheet the way Excel shows it — column widths and row heights in Excel's
// pixels, cell fills, gridlines, fonts, number-formatted text (overflowing into empty neighbours, #### when a number
// does not fit), wrapping, indents, rotation, merges, borders, conditional formats (cell rules, colour scales, data
// bars), frozen panes, and the A B C / 1 2 3 headings. Used by the grid view (ui/sheet) and page thumbnails / prints.

import type { SheetBorder, SheetCell, SheetCondRule, SheetData, SheetStyle } from "../core/sheetTypes";
import { Book, Err, isRange, type Scalar } from "../io/sheet/calc";
import { addr, colLetters, MAX_COL, MAX_ROW, parseAddr, parseFormula, parseRange, shiftFormula, type Rect } from "../io/sheet/formula";
import { formatValue, type Formatted, type SheetLang } from "../io/sheet/numfmt";
import { printLineBox } from "../io/sheet/printFont";
import { paintSheetExtras } from "./sheetExtras";
import { paintSheetPrintPage } from "./sheetPrint";
import { paintDrawings, type DrawingPaneMap } from "./sheetDrawings";
import { drawIcon, iconCount } from "./sheetIcons";
import { periodFormula } from "../io/sheet/writeParts";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

// ───── geometry ─────

/** Column / row positions in sheet pixels (100 %), with custom sizes and hidden lines. */
export class Axis {
  private keys: number[];
  private pre: number[]; // pre[i] = sum of (size − def) of keys[0..i-1]
  constructor(
    readonly def: number,
    custom: Record<number, number>,
    hidden: number[] | undefined,
    readonly max: number,
  ) {
    const m = new Map<number, number>();
    for (const [k, v] of Object.entries(custom)) m.set(Number(k), v);
    for (const h of hidden ?? []) m.set(h, 0);
    this.keys = [...m.keys()].sort((a, b) => a - b);
    this.pre = [0];
    for (const k of this.keys) this.pre.push(this.pre[this.pre.length - 1] + (m.get(k)! - def));
    this.sizes = m;
  }
  private sizes: Map<number, number>;
  size(i: number): number {
    return this.sizes.get(i) ?? this.def;
  }
  /** start of line i */
  pos(i: number): number {
    let lo = 0, hi = this.keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.keys[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    return i * this.def + this.pre[lo];
  }
  /** line at position p (≥ 0) */
  at(p: number): number {
    let lo = 0, hi = this.max;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.pos(mid) <= p) lo = mid;
      else hi = mid - 1;
    }
    // a hidden line has no width: the visible one at that position
    while (lo < this.max && this.size(lo) === 0) lo++;
    return lo;
  }
}

export interface SheetGeom {
  cols: Axis;
  rows: Axis;
}
const geomCache = new WeakMap<SheetData, SheetGeom>();
export function geomOf(sh: SheetData): SheetGeom {
  let g = geomCache.get(sh);
  if (!g) {
    g = { cols: new Axis(sh.defColW, sh.colW, sh.hiddenCols, MAX_COL), rows: new Axis(sh.defRowH, sh.rowH, sh.hiddenRows, MAX_ROW) };
    geomCache.set(sh, g);
  }
  return g;
}

// ───── display cache ─────

const textCache = new WeakMap<SheetCell, Map<SheetStyle | undefined, Formatted>>();
export function display(sh: SheetData, cell: SheetCell, lang: SheetLang): Formatted {
  const st = sh.styles[cell.s ?? 0];
  let m = textCache.get(cell);
  if (!m) textCache.set(cell, (m = new Map()));
  let f = m.get(st);
  if (!f) {
    f = cell.t === "e" ? { text: String(cell.v) } : formatValue(cell.v ?? null, st?.fmt, { date1904: sh.date1904, lang });
    m.set(st, f);
  }
  return f;
}

// ───── conditional formats ─────

export interface CondLook {
  fill?: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  bar?: { frac: number; color: string; border?: boolean };
  /** icon set: the set and the band (0 = lowest) */
  icon?: { set: string; i: number };
  /** bar / icon only (the value is not shown) */
  hide?: boolean;
}

const condCache = new WeakMap<SheetData, Map<string, CondLook>>();

function mix(a: string, b: string, t: number): string {
  const p = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  return "#" + [0, 1, 2].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

function cfvoValue(kind: string, val: string | undefined, nums: number[], book: Book, si: number): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const min = sorted[0] ?? 0, max = sorted[sorted.length - 1] ?? 0;
  const v = Number(val);
  switch (kind) {
    case "min":
      return min;
    case "max":
      return max;
    case "percent":
      return min + ((max - min) * v) / 100;
    case "percentile": {
      if (!sorted.length) return 0;
      const k = ((sorted.length - 1) * v) / 100;
      const lo = Math.floor(k);
      return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (k - lo);
    }
    case "formula":
    case "num":
      if (Number.isFinite(v)) return v;
      try {
        const r = book.scalar(book.eval(parseFormula(val ?? "0"), si, 0, 0), 0, 0);
        return typeof r === "number" ? r : 0;
      } catch {
        return 0;
      }
    default:
      return min;
  }
}

/** Looks the sheet's conditional formats give its cells (by address). */
export function condLooks(sh: SheetData, sheets: SheetData[]): Map<string, CondLook> {
  let out = condCache.get(sh);
  if (out) return out;
  out = new Map();
  condCache.set(sh, out);
  if (!sh.cond?.length) return tableLooks(sh, out);
  const list = sheets.includes(sh) ? sheets : [sh];
  const book = new Book(list);
  const si = list.indexOf(sh);
  const rules: { rule: SheetCondRule; ranges: Rect[] }[] = [];
  for (const cf of sh.cond) {
    const ranges = cf.ranges.map(parseRange).filter((g): g is Rect => !!g);
    for (const rule of cf.rules) rules.push({ rule, ranges });
  }
  rules.sort((a, b) => a.rule.priority - b.rule.priority);
  const done = new Set<string>(); // stopIfTrue
  for (const { rule, ranges } of rules) {
    const cells: { a: string; r: number; c: number; v: Scalar }[] = [];
    for (const g of ranges)
      for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++)
        for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 200); c++) {
          const a = addr(r, c);
          const cell = sh.cells[a];
          cells.push({ a, r, c, v: cell?.t === "e" ? new Err(String(cell.v)) : cell?.v ?? null });
        }
    const nums = cells.map((x) => x.v).filter((v): v is number => typeof v === "number");
    const apply = (a: string, look: CondLook) => {
      if (done.has(a)) return;
      const cur = out!.get(a) ?? {};
      // a higher-priority rule's look wins; later rules only fill in what is not set yet
      for (const k of Object.keys(look) as (keyof CondLook)[]) if (cur[k] === undefined) (cur as Record<string, unknown>)[k] = look[k];
      out!.set(a, cur);
      if (rule.stop) done.add(a);
    };
    const styleLook = (): CondLook => ({ ...(rule.style ?? {}) }) as CondLook;
    const top = ranges[0];
    const evalAt = (f: string, r: number, c: number): Scalar => {
      try {
        const moved = shiftFormula(f, r - top.r0, c - top.c0);
        const v = book.eval(parseFormula(moved), si, r, c);
        return isRange(v) ? book.scalar(v, r, c) : (v as Scalar);
      } catch {
        return null;
      }
    };
    const truthy = (v: Scalar) => v === true || (typeof v === "number" && v !== 0);
    switch (rule.type) {
      case "colorScale": {
        const sc = rule.scale ?? [];
        if (sc.length < 2 || !nums.length) break;
        const at = sc.map((s) => cfvoValue(s.kind, s.val, nums, book, si));
        for (const x of cells) {
          if (typeof x.v !== "number") continue;
          let color: string;
          if (sc.length === 2) color = mix(sc[0].color, sc[1].color, at[1] === at[0] ? 0 : Math.min(1, Math.max(0, (x.v - at[0]) / (at[1] - at[0]))));
          else if (x.v <= at[1]) color = mix(sc[0].color, sc[1].color, at[1] === at[0] ? 0 : Math.min(1, Math.max(0, (x.v - at[0]) / (at[1] - at[0]))));
          else color = mix(sc[1].color, sc[2].color, at[2] === at[1] ? 1 : Math.min(1, Math.max(0, (x.v - at[1]) / (at[2] - at[1]))));
          apply(x.a, { fill: color });
        }
        break;
      }
      case "dataBar": {
        if (!nums.length) break;
        // the bar's range from its cfvo (lowest / highest value, number, percent…); Excel 2010+ bars (an x14 extension)
        // run 0–100 % of the cell, Excel 2007 bars 10–90 %
        const sc = rule.scale ?? [];
        const min = sc.length >= 2 ? cfvoValue(sc[0].kind, sc[0].val, nums, book, si) : Math.min(...nums);
        const max = sc.length >= 2 ? cfvoValue(sc[1].kind, sc[1].val, nums, book, si) : Math.max(...nums);
        const [lo, hi] = rule.barExt ? [0, 1] : [0.1, 0.9];
        for (const x of cells)
          if (typeof x.v === "number") {
            const f = max === min ? 1 : Math.min(1, Math.max(0, (x.v - min) / (max - min)));
            apply(x.a, { bar: { frac: lo + (hi - lo) * f, color: rule.bar ?? "#638EC6" }, ...(rule.noValue ? { hide: true } : {}) });
          }
        break;
      }
      case "iconSet": {
        if (!nums.length) break;
        const set = rule.icons ?? "3TrafficLights1";
        const n = iconCount(set);
        const sc = rule.scale?.length ? rule.scale : Array.from({ length: n }, (_, k) => ({ kind: "percent", val: String(Math.round((k * 100) / n)), color: "" }));
        const at = sc.map((s) => cfvoValue(s.kind, s.val, nums, book, si));
        for (const x of cells) {
          if (typeof x.v !== "number") continue;
          let k = 0;
          for (let j = 1; j < Math.min(n, at.length); j++) if (x.v >= at[j]) k = j;
          apply(x.a, { icon: { set, i: rule.iconReverse ? n - 1 - k : k }, ...(rule.noValue ? { hide: true } : {}) });
        }
        break;
      }
      case "cellIs": {
        const fs = (rule.formulas ?? []).map((f) => f);
        for (const x of cells) {
          if (x.v === null) continue;
          const a = evalAt(fs[0] ?? "0", x.r, x.c), b = fs[1] ? evalAt(fs[1], x.r, x.c) : null;
          const cmp = (p: Scalar, q: Scalar) => {
            if (typeof p === "number" && typeof q === "number") return p - q;
            const s = String(p ?? "").toLowerCase(), t = String(q ?? "").toLowerCase();
            return s < t ? -1 : s > t ? 1 : 0;
          };
          const k = cmp(x.v, a);
          let hit = false;
          switch (rule.op) {
            case "equal": hit = k === 0; break;
            case "notEqual": hit = k !== 0; break;
            case "greaterThan": hit = k > 0; break;
            case "greaterThanOrEqual": hit = k >= 0; break;
            case "lessThan": hit = k < 0; break;
            case "lessThanOrEqual": hit = k <= 0; break;
            case "between": hit = k >= 0 && cmp(x.v, b) <= 0; break;
            case "notBetween": hit = k < 0 || cmp(x.v, b) > 0; break;
          }
          if (hit) apply(x.a, styleLook());
        }
        break;
      }
      case "expression":
        for (const x of cells) if (truthy(evalAt(rule.formulas?.[0] ?? "FALSE", x.r, x.c))) apply(x.a, styleLook());
        break;
      case "timePeriod": {
        // 발생 날짜: the rule's own formula (Excel stores one), else the one Excel would write for the period
        const f = rule.formulas?.[0] ?? periodFormula(rule.period ?? "today", addr(top.r0, top.c0));
        for (const x of cells) if (typeof x.v === "number" && truthy(evalAt(f, x.r, x.c))) apply(x.a, styleLook());
        break;
      }
      case "top10": {
        const sorted = [...nums].sort((a, b) => (rule.bottom ? a - b : b - a));
        const n = rule.percent ? Math.max(1, Math.floor((sorted.length * (rule.rank ?? 10)) / 100)) : rule.rank ?? 10;
        const edge = sorted[Math.min(n, sorted.length) - 1];
        for (const x of cells) if (typeof x.v === "number" && (rule.bottom ? x.v <= edge : x.v >= edge)) apply(x.a, styleLook());
        break;
      }
      case "aboveAverage": {
        if (!nums.length) break;
        const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
        for (const x of cells) if (typeof x.v === "number" && (rule.below ? x.v < avg : x.v > avg)) apply(x.a, styleLook());
        break;
      }
      case "duplicateValues":
      case "uniqueValues": {
        const count = new Map<string, number>();
        for (const x of cells) if (x.v !== null) count.set(String(x.v).toLowerCase(), (count.get(String(x.v).toLowerCase()) ?? 0) + 1);
        for (const x of cells) if (x.v !== null && (count.get(String(x.v).toLowerCase())! > 1) === (rule.type === "duplicateValues")) apply(x.a, styleLook());
        break;
      }
      case "containsText":
      case "notContainsText":
      case "beginsWith":
      case "endsWith": {
        const t = (rule.text ?? "").toLowerCase();
        for (const x of cells) {
          const s = x.v === null ? "" : String(x.v).toLowerCase();
          const hit = rule.type === "containsText" ? s.includes(t) : rule.type === "notContainsText" ? !s.includes(t) : rule.type === "beginsWith" ? s.startsWith(t) : s.endsWith(t);
          if (hit) apply(x.a, styleLook());
        }
        break;
      }
      case "containsBlanks":
      case "notContainsBlanks":
        for (const x of cells) if ((x.v === null || x.v === "") === (rule.type === "containsBlanks")) apply(x.a, styleLook());
        break;
      case "containsErrors":
      case "notContainsErrors":
        for (const x of cells) if (x.v instanceof Err === (rule.type === "containsErrors")) apply(x.a, styleLook());
        break;
    }
  }
  return tableLooks(sh, out);
}

/** Excel's built-in table styles, roughly: Light / Medium / Dark 1–7 by accent colour (header fill, stripe fill). */
const TABLE_ACCENTS = [
  ["#000000", "#D9D9D9"],
  ["#4472C4", "#D9E1F2"],
  ["#ED7D31", "#FCE4D6"],
  ["#A5A5A5", "#EDEDED"],
  ["#FFC000", "#FFF2CC"],
  ["#5B9BD5", "#DDEBF7"],
  ["#70AD47", "#E2EFDA"],
];

/**
 * The look of Excel tables (ListObjects) by their table style: a header row filled with the accent colour in white
 * bold (Medium / Dark), banded rows, a bold totals row. Conditional formats and the cells' own fill / font colour win.
 */
function tableLooks(sh: SheetData, out: Map<string, CondLook>): Map<string, CondLook> {
  for (const t of sh.tables ?? []) {
    const m = /^TableStyle(Light|Medium|Dark)(\d+)$/.exec(t.style ?? ""); // (no tableStyleInfo: no style, as Excel shows it)
    if (!m) continue;
    const g = parseRange(t.ref);
    if (!g) continue;
    const kind = m[1], n = Number(m[2]);
    const [accent, band] = TABLE_ACCENTS[(n - 1) % 7];
    const set = (r: number, c: number, look: CondLook) => {
      const a = addr(r, c);
      const st = sh.styles[sh.cells[a]?.s ?? 0] ?? {};
      const cur = out.get(a) ?? {};
      if (look.fill && cur.fill === undefined && !st.fill) cur.fill = look.fill;
      if (look.color && cur.color === undefined && !st.color) cur.color = look.color;
      if (look.bold && cur.bold === undefined) cur.bold = true;
      out.set(a, cur);
    };
    const head = t.noHeader ? -1 : g.r0;
    const foot = t.totals ? g.r1 : -1;
    const darkHead = kind !== "Light" || n >= 8;
    for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 200); c++) {
      if (head >= 0) set(head, c, darkHead ? { fill: kind === "Dark" ? "#000000" : accent, color: "#FFFFFF", bold: true } : { bold: true });
      if (foot >= 0) set(foot, c, { bold: true });
    }
    if (t.rowStripes !== false) {
      const first = head >= 0 ? head + 1 : g.r0;
      for (let r = first; r <= Math.min(foot >= 0 ? foot - 1 : g.r1, first + 5000); r++)
        if ((r - first) % 2 === 0) for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 200); c++) set(r, c, { fill: kind === "Dark" ? accent : band });
    }
  }
  return out;
}

// ───── painting ─────

export interface SheetPaint {
  /** viewport in CSS px */
  width: number;
  height: number;
  zoom: number;
  /** scroll position of the scrolling pane, sheet px (100 %) past the frozen part */
  scrollX: number;
  scrollY: number;
  headings: boolean;
  lang: SheetLang;
  /** the other sheets of the book (formulas in conditional formats) */
  sheets?: SheetData[];
  sel?: { g: Rect; ar: number; ac: number; more?: Rect[] } | null;
  /** cells being edited are drawn by the editor */
  editing?: string | null;
  theme?: "light" | "dark";
  /** show formulas instead of their values (수식 표시, Ctrl+`) */
  formulas?: boolean;
  /** cut / copy marching range */
  clip?: Rect | null;
  /** false = leave out the sheet's drawings (pictures, charts): print-title blocks repeated on each printed page */
  drawings?: boolean;
  /** gridline colour (printed gridlines are black); default the screen grey */
  gridColor?: string;
}

export const HEAD_H = 20;
export const headW = (zoom: number, lastRow: number) => Math.max(26, Math.round((String(lastRow + 1).length * 7 + 10) * Math.max(0.6, zoom)));
const ACCENT = "#2b74ec"; // Omniweave accent (same as canvas selection)

const fontOf = (sh: SheetData, st: SheetStyle | undefined, z: number, px?: number) => `${st?.italic ? "italic " : ""}${st?.bold ? "bold " : ""}${px ?? (((st?.size ?? sh.baseSize) * 96) / 72) * z}px "${st?.font ?? sh.baseFont}", "맑은 고딕", "Malgun Gothic", sans-serif`; // i18n: keep — font names

// ───── printed pages: Excel's geometry, measured on the PDFs it prints (qa/interop/excel-made/omni-xlsx-print.*.pdf,
// tests/fidelity/xlsx.ts --only printdiag). Excel lays a print out in printer dots (600 dpi). Every column / row owns an
// 8-dot line slot after its boundary — the cells of a page start one slot in from the margin and each cell's text area
// runs from the end of its left slot to its right boundary. Lines are drawn in those slots, unsnapped:
//   thin border  — an 8-dot bar filling the slot under a one-device-pixel hairline at its top / left edge
//   medium/thick — a 16 / 24-dot bar centred on the slot, no hairline
//   gridline     — a one-dot bar in the middle of the slot under the hairline
// A fill covers its cells from the middle of the slot before to just past the middle of the slot after. Text is set in
// the font at whole dots, 13 dots × scale in from the left of the area (13.5 from the right), the baseline of
// bottom-aligned text 0.385 × font − 4 dots above the area's bottom.

/** One printer dot (600 dpi) in px (96 dpi). */
export const PRINT_DOT = 1 / 6.25;
/** The printed font size, px: whole printer dots at the scale. */
export const printFontPx = (pt: number, scale: number) => Math.max(1, Math.round(((pt * 600) / 72) * scale)) * PRINT_DOT;
/** Width of a printed border line, dots. */
const printLineDots = (style: string) => (style === "thick" ? 24 : style.startsWith("medium") || style === "double" ? 16 : style === "hair" ? 1 : 8);

/** An Excel printed line: the bar (x, y, w, h) and, for thin ones, the hairline along its top / left edge. */
function printBar(ctx: Ctx, vertical: boolean, x: number, y: number, w: number, h: number, hair: number, withHair: boolean) {
  if (withHair) {
    ctx.beginPath();
    if (vertical) {
      ctx.moveTo(x + PRINT_DOT / 2, y + PRINT_DOT / 2);
      ctx.lineTo(x + PRINT_DOT / 2, y + h - PRINT_DOT / 2);
    } else {
      ctx.moveTo(x + PRINT_DOT / 2, y + PRINT_DOT / 2);
      ctx.lineTo(x + w - PRINT_DOT / 2, y + PRINT_DOT / 2);
    }
    ctx.lineWidth = hair;
    ctx.lineCap = "square";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
  ctx.fillRect(x, y, w, h);
}

/** One device pixel in the context's units (the hairline Excel's PDF strokes, as a PDF viewer draws it). */
const hairOf = (ctx: Ctx) => {
  const t = ctx.getTransform();
  return 1 / Math.max(1e-6, Math.hypot(t.a, t.b));
};

/** Printed gridline at a boundary (the line slot after `at`), from `from` to `to` along the line. */
export function printGridline(ctx: Ctx, vertical: boolean, at: number, from: number, to: number) {
  const hair = hairOf(ctx);
  if (vertical) printBar(ctx, true, at + 4 * PRINT_DOT, from, PRINT_DOT, to - from, hair, true);
  else printBar(ctx, false, from, at + 4 * PRINT_DOT, to - from, PRINT_DOT, hair, true);
}

interface PrintSeg {
  at: number;
  from: number;
  to: number;
  b: SheetBorder;
}
/** Printed borders: each boundary's segments joined along the line (Excel draws one bar per run), verticals first. */
function paintPrintBorders(ctx: Ctx, segs: { v: PrintSeg[]; h: PrintSeg[] }) {
  const hair = hairOf(ctx);
  const D = PRINT_DOT;
  const runs = (list: PrintSeg[]) => {
    const seen = new Map<string, PrintSeg>();
    for (const s of list) {
      const k = `${s.at.toFixed(3)}|${s.from.toFixed(3)}`;
      const o = seen.get(k);
      if (!o || printLineDots(s.b.style) > printLineDots(o.b.style)) seen.set(k, s);
    }
    const out: PrintSeg[] = [];
    for (const s of [...seen.values()].sort((a, b) => a.at - b.at || a.from - b.from)) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.at - s.at) < 1e-3 && Math.abs(last.to - s.from) < 1e-3 && last.b.style === s.b.style && last.b.color === s.b.color) last.to = s.to;
      else out.push({ ...s });
    }
    return out;
  };
  for (const [list, vertical] of [[segs.v, true], [segs.h, false]] as const)
    for (const s of runs(list)) {
      const wd = printLineDots(s.b.style);
      ctx.fillStyle = s.b.color;
      ctx.strokeStyle = s.b.color;
      const solid = s.b.style === "thin" || s.b.style === "medium" || s.b.style === "thick" || s.b.style === "hair";
      // verticals run from their top slot through their bottom one; horizontals start after the left slot
      const a0 = vertical ? s.from : s.from + 8 * D, a1 = s.to + 8 * D;
      const c = s.at + 4 * D - (wd * D) / 2;
      if (solid) {
        if (vertical) printBar(ctx, true, c, a0, wd * D, a1 - a0, hair, wd <= 8);
        else printBar(ctx, false, a0, c, a1 - a0, wd * D, hair, wd <= 8);
        continue;
      }
      ctx.save();
      ctx.lineWidth = s.b.style === "double" ? Math.max(hair, 2.5 * D) : wd * D;
      dash(ctx, s.b.style, 8 * D); // dashed: 24-dot dashes, 8-dot gaps
      ctx.beginPath();
      const m = s.at + 4 * D;
      const lines = s.b.style === "double" ? [m - 6 * D, m + 6 * D] : [m];
      for (const v of lines) {
        if (vertical) {
          ctx.moveTo(v, a0);
          ctx.lineTo(v, a1);
        } else {
          ctx.moveTo(a0, v);
          ctx.lineTo(a1, v);
        }
      }
      ctx.stroke();
      ctx.restore();
    }
}

/** Layout of the panes: frozen rows / columns and where the scrolling part starts. */
export function panes(sh: SheetData, p: Pick<SheetPaint, "zoom" | "headings" | "scrollX" | "scrollY">, lastRow = 200) {
  const g = geomOf(sh);
  const z = p.zoom;
  const hw = p.headings && sh.headings ? headW(z, lastRow) : 0;
  const hh = p.headings && sh.headings ? Math.round(HEAD_H * Math.max(0.75, z)) : 0;
  const sp = !sh.freeze && sh.split ? sh.split : null;
  // a split: the bottom / right pane starts where the window was split (row / col) and scrolls from there on its own
  const fr = sp ? (sp.rows ? sp.row ?? sp.top + sp.rows : 0) : sh.freeze?.rows ?? 0, fc = sp ? (sp.cols ? sp.col ?? sp.left + sp.cols : 0) : sh.freeze?.cols ?? 0;
  const frE = sp ? (sp.rows ? sp.top + sp.rows : 0) : fr, fcE = sp ? (sp.cols ? sp.left + sp.cols : 0) : fc;
  const topRow = sh.topLeft ? parseAddr(sh.topLeft) : null;
  // frozen panes start at the saved top-left row / column of the frozen region (usually 0); split panes at their own
  const fr0 = sp ? (sp.rows ? sp.top : 0) : fr ? Math.max(0, Math.min(topRow?.r ?? 0, 0)) : 0;
  const fc0 = sp ? (sp.cols ? sp.left : 0) : 0;
  const frozenH = fr ? (g.rows.pos(frE) - g.rows.pos(fr0)) * z : 0;
  const frozenW = fc ? (g.cols.pos(fcE) - g.cols.pos(fc0)) * z : 0;
  return { g, z, hw, hh, fr, fc, fr0, fc0, frE, fcE, frozenH, frozenW, x0: hw + frozenW, y0: hh + frozenH, sx: g.cols.pos(fc) + p.scrollX, sy: g.rows.pos(fr) + p.scrollY };
}

/** Cell under a point (CSS px in the viewport); `head` = on a heading. */
export function hitCell(sh: SheetData, p: SheetPaint, x: number, y: number): { r: number; c: number; head: "col" | "row" | "corner" | null } {
  const L = panes(sh, p);
  const { g, z } = L;
  const head = x < L.hw && y < L.hh ? "corner" : y < L.hh ? "col" : x < L.hw ? "row" : null;
  const sxp = x < L.x0 ? g.cols.pos(L.fc0) + (x - L.hw) / z : L.sx + (x - L.x0) / z;
  const syp = y < L.y0 ? g.rows.pos(L.fr0) + (y - L.hh) / z : L.sy + (y - L.y0) / z;
  return { r: g.rows.at(Math.max(0, syp)), c: g.cols.at(Math.max(0, sxp)), head };
}

/** Screen rectangle of a cell (CSS px), honouring the pane it is in. */
export function cellRect(sh: SheetData, p: SheetPaint, r: number, c: number, r1 = r, c1 = c) {
  const L = panes(sh, p);
  const { g, z } = L;
  // both edges in the pane the cell starts in (a frozen cell's far edge is not in the scrolled pane)
  const fc = c < L.fc, fr = r < L.fr;
  const xOf = (col: number) => (fc ? L.hw + (g.cols.pos(col) - g.cols.pos(L.fc0)) * z : L.x0 + (g.cols.pos(col) - L.sx) * z);
  const yOf = (row: number) => (fr ? L.hh + (g.rows.pos(row) - g.rows.pos(L.fr0)) * z : L.y0 + (g.rows.pos(row) - L.sy) * z);
  const x = xOf(c), y = yOf(r);
  return { x, y, w: xOf(c1 + 1) - x, h: yOf(r1 + 1) - y };
}

function dash(ctx: Ctx, style: string, z: number) {
  const d = style === "dotted" || style === "hair" ? [1, 1] : style === "dashed" || style === "mediumDashed" ? [3 * z, 1 * z] : style.startsWith("dashDot") || style.startsWith("mediumDashDot") || style === "slantDashDot" ? [4 * z, 1 * z, 1 * z, 1 * z] : [];
  ctx.setLineDash(d);
}
const bw = (s: string) => (s === "thick" ? 3 : s.startsWith("medium") || s === "double" ? 2 : 1);

/** Paint a sheet into a viewport. The context is in CSS px (the caller scales for the device pixel ratio). */
export function paintSheet(ctx: Ctx, sh: SheetData, p: SheetPaint) {
  const L = panes(sh, p);
  const { g, z, hw, hh } = L;
  const dark = p.theme === "dark";
  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, p.width, p.height);
  const looks = condLooks(sh, p.sheets ?? [sh]);
  const merges = sh.merges.map(parseRange).filter((m): m is Rect => !!m);
  const mergeAt = new Map<string, Rect>();
  for (const m of merges) for (let r = m.r0; r <= Math.min(m.r1, m.r0 + 500); r++) for (let c = m.c0; c <= Math.min(m.c1, m.c0 + 100); c++) mergeAt.set(addr(r, c), m);
  // the four panes: [rows from, rows to (exclusive) or −1 = to the edge, x / y start]
  const lastVisible = (axis: Axis, from: number, _startPx: number, span: number) => {
    let i = from;
    // (printed: only the lines of the page — the block's clip reaches past it for the last line slots)
    while (i < axis.max && axis.pos(i) - axis.pos(from) < span / z + (p.gridColor ? -1e-6 : 1)) i++;
    return p.gridColor ? Math.max(from, i - 1) : i;
  };
  const scrollRow = g.rows.at(L.sy), scrollCol = g.cols.at(L.sx);
  const paneList = [
    { r0: scrollRow, r1: lastVisible(g.rows, scrollRow, L.sy, p.height - L.y0), c0: scrollCol, c1: lastVisible(g.cols, scrollCol, L.sx, p.width - L.x0), clip: { x: L.x0, y: L.y0, w: p.width - L.x0, h: p.height - L.y0 } },
  ];
  if (L.fr) paneList.push({ r0: L.fr0, r1: L.frE, c0: scrollCol, c1: lastVisible(g.cols, scrollCol, L.sx, p.width - L.x0), clip: { x: L.x0, y: hh, w: p.width - L.x0, h: L.frozenH } });
  if (L.fc) paneList.push({ r0: scrollRow, r1: lastVisible(g.rows, scrollRow, L.sy, p.height - L.y0), c0: L.fc0, c1: L.fcE, clip: { x: hw, y: L.y0, w: L.frozenW, h: p.height - L.y0 } });
  if (L.fr && L.fc) paneList.push({ r0: L.fr0, r1: L.frE, c0: L.fc0, c1: L.fcE, clip: { x: hw, y: hh, w: L.frozenW, h: L.frozenH } });
  const rect = (r: number, c: number, r1 = r, c1 = c) => cellRect(sh, p, r, c, r1, c1);
  // printed pages: the lines of the last column / row (and medium borders on the first) reach past the block
  const print = !!p.gridColor;
  const D = PRINT_DOT;
  for (const pane of paneList) {
    ctx.save();
    ctx.beginPath();
    if (print) ctx.rect(pane.clip.x - 8 * D, pane.clip.y - 8 * D, pane.clip.w + 24 * D, pane.clip.h + 24 * D);
    else ctx.rect(pane.clip.x, pane.clip.y, pane.clip.w, pane.clip.h);
    ctx.clip();
    const rows: number[] = [];
    for (let r = pane.r0; r <= Math.min(pane.r1, MAX_ROW); r++) if (g.rows.size(r) > 0) rows.push(r);
    const cols: number[] = [];
    for (let c = pane.c0; c <= Math.min(pane.c1, MAX_COL); c++) if (g.cols.size(c) > 0) cols.push(c);
    // gridlines
    if (sh.grid && print) {
      // printed gridlines: the line slot after each column's / row's right / bottom boundary inside the page block (the
      // block's first lines are drawn by render/sheetPrint.ts); they run past the last line as Excel's do
      const x1 = pane.clip.x + pane.clip.w, y1 = pane.clip.y + pane.clip.h;
      ctx.fillStyle = p.gridColor!;
      ctx.strokeStyle = p.gridColor!;
      for (const c of cols) {
        const q = rect(rows[0] ?? 0, c);
        if (q.x + q.w > x1 + 1e-6) break;
        printGridline(ctx, true, q.x + q.w, pane.clip.y + 4 * D, y1 + 16 * D);
      }
      for (const r of rows) {
        const q = rect(r, cols[0] ?? 0);
        if (q.y + q.h > y1 + 1e-6) break;
        printGridline(ctx, false, q.y + q.h, pane.clip.x + 4 * D, x1 + 16 * D);
      }
    } else if (sh.grid) {
      ctx.strokeStyle = p.gridColor ?? "#D4D4D4";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const c of cols) {
        const q = rect(rows[0] ?? 0, c);
        const x = Math.round(q.x + q.w) - 0.5;
        ctx.moveTo(x, pane.clip.y);
        ctx.lineTo(x, pane.clip.y + pane.clip.h);
      }
      for (const r of rows) {
        const q = rect(r, cols[0] ?? 0);
        const y = Math.round(q.y + q.h) - 0.5;
        ctx.moveTo(pane.clip.x, y);
        ctx.lineTo(pane.clip.x + pane.clip.w, y);
      }
      ctx.stroke();
    }
    // fills (cell, conditional, whole row / column formats) and merged areas
    const styleAt = (r: number, c: number, cell?: SheetCell) => sh.styles[cell?.s ?? sh.rowS?.[r] ?? sh.colS?.[c] ?? 0];
    const drawnMerge = new Set<Rect>();
    // printed: unsnapped, from the middle of the slot before to a dot past the middle of the slot after, and a row's
    // cells of one colour as one run (as Excel's PDF has them — no seams where cells meet)
    const fillRuns: { x0: number; x1: number; y0: number; y1: number; fill: string }[] = [];
    const printFill = (fill: string, q: { x: number; y: number; w: number; h: number }) => {
      const last = fillRuns[fillRuns.length - 1];
      if (last && last.fill === fill && Math.abs(last.y0 - q.y) < 1e-6 && Math.abs(last.y1 - q.y - q.h) < 1e-6 && Math.abs(last.x1 - q.x) < 1e-6) last.x1 = q.x + q.w;
      else fillRuns.push({ x0: q.x, x1: q.x + q.w, y0: q.y, y1: q.y + q.h, fill });
    };
    for (const r of rows)
      for (const c of cols) {
        const a = addr(r, c);
        const m = mergeAt.get(a);
        if (m) {
          if (drawnMerge.has(m)) continue;
          drawnMerge.add(m);
          const top = sh.cells[addr(m.r0, m.c0)];
          const fill = looks.get(addr(m.r0, m.c0))?.fill ?? styleAt(m.r0, m.c0, top)?.fill ?? "#ffffff";
          const q = rect(m.r0, m.c0, m.r1, m.c1);
          ctx.fillStyle = fill;
          if (print && fill === "#ffffff") ctx.fillRect(q.x + 5 * D, q.y + 5 * D, q.w - D, q.h - D); // hides the gridlines inside only
          else if (print) ctx.fillRect(q.x + 4 * D, q.y + 4 * D, q.w + D, q.h + D);
          else ctx.fillRect(Math.round(q.x), Math.round(q.y), Math.round(q.x + q.w) - Math.round(q.x) - (fill === "#ffffff" && sh.grid ? 1 : 0), Math.round(q.y + q.h) - Math.round(q.y) - (fill === "#ffffff" && sh.grid ? 1 : 0));
          continue;
        }
        const cell = sh.cells[a];
        const fill = looks.get(a)?.fill ?? styleAt(r, c, cell)?.fill;
        if (!fill) continue;
        const q = rect(r, c);
        if (print) {
          printFill(fill, q);
          continue;
        }
        ctx.fillStyle = fill;
        ctx.fillRect(Math.round(q.x), Math.round(q.y), Math.round(q.x + q.w) - Math.round(q.x), Math.round(q.y + q.h) - Math.round(q.y));
      }
    for (const f of fillRuns) {
      ctx.fillStyle = f.fill;
      ctx.fillRect(f.x0 + 4 * D, f.y0 + 4 * D, f.x1 - f.x0 + D, f.y1 - f.y0 + D);
    }
    // data bars
    for (const r of rows)
      for (const c of cols) {
        const bar = looks.get(addr(r, c))?.bar;
        if (!bar) continue;
        const q = rect(r, c);
        // Excel's gradient bar: the colour at the start fading to near white at the bar's own end
        const bwid = Math.max(0, (q.w - 3) * bar.frac);
        if (bwid < 0.5) continue;
        const bx = Math.round(q.x) + 1, by = Math.round(q.y) + 2, bh = Math.round(q.h) - 4;
        const grd = ctx.createLinearGradient(bx, 0, bx + bwid, 0);
        grd.addColorStop(0, bar.color);
        grd.addColorStop(1, mix(bar.color, "#ffffff", 0.9));
        ctx.fillStyle = grd;
        ctx.fillRect(bx, by, bwid, bh);
        if (bar.border) {
          ctx.strokeStyle = bar.color;
          ctx.lineWidth = 1;
          ctx.strokeRect(bx + 0.5, by + 0.5, Math.max(0, bwid - 1), bh - 1);
        }
      }
    // icon sets
    for (const r of rows)
      for (const c of cols) {
        const ic = looks.get(addr(r, c))?.icon;
        if (!ic) continue;
        const q = rect(r, c);
        const s = Math.max(6, Math.min(q.h - 4, 16 * p.zoom));
        drawIcon(ctx, ic.set, ic.i, Math.round(q.x) + 2, Math.round(q.y + (q.h - s) / 2), s);
      }
    // text
    const occupied = (r: number, c: number) => {
      const cell = sh.cells[addr(r, c)];
      return !!cell && cell.v !== undefined && cell.v !== "" || mergeAt.has(addr(r, c));
    };
    const textRows = rows;
    // cells left of the pane can overflow into it: start a few columns earlier
    const extraLeft: number[] = [];
    for (let c = pane.c0 - 1; c >= Math.max(0, pane.c0 - 12); c--) extraLeft.unshift(c);
    for (const r of textRows)
      for (const c of [...extraLeft, ...cols]) {
        const a = addr(r, c);
        const m = mergeAt.get(a);
        if (m && (m.r0 !== r || m.c0 !== c)) {
          if (!(m.c0 < pane.c0 || m.r0 < pane.r0) || !(r === Math.max(m.r0, pane.r0) && c === Math.max(m.c0, pane.c0))) continue;
          // a merge starting above / left of the pane: drawn once from its first visible cell
          drawCellText(ctx, sh, p, m.r0, m.c0, m, looks, occupied, rect);
          continue;
        }
        if (a === p.editing) continue;
        const cell = sh.cells[a];
        if (!cell || cell.v === undefined || cell.v === "") continue;
        drawCellText(ctx, sh, p, r, c, m, looks, occupied, rect);
      }
    // borders
    const segs = { v: [] as PrintSeg[], h: [] as PrintSeg[] };
    for (const r of rows)
      for (const c of cols) {
        const cell = sh.cells[addr(r, c)];
        const st = styleAt(r, c, cell);
        if (!st || !(st.bl || st.br || st.bt || st.bb)) continue;
        const m = mergeAt.get(addr(r, c));
        const q = m ? rect(m.r0, m.c0, m.r1, m.c1) : rect(r, c);
        if (print) {
          if (st.bt) segs.h.push({ at: q.y, from: q.x, to: q.x + q.w, b: st.bt });
          if (st.bb) segs.h.push({ at: q.y + q.h, from: q.x, to: q.x + q.w, b: st.bb });
          if (st.bl) segs.v.push({ at: q.x, from: q.y, to: q.y + q.h, b: st.bl });
          if (st.br) segs.v.push({ at: q.x + q.w, from: q.y, to: q.y + q.h, b: st.br });
          continue;
        }
        const line = (b: SheetBorder | undefined, x1: number, y1: number, x2: number, y2: number) => {
          if (!b) return;
          const w = bw(b.style);
          ctx.strokeStyle = b.color;
          ctx.lineWidth = w === 3 ? 3 : w === 2 ? 2 : 1;
          dash(ctx, b.style, z);
          const off = w % 2 ? 0.5 : 0;
          ctx.beginPath();
          if (b.style === "double") {
            ctx.lineWidth = 1;
            const dx = y1 === y2 ? 0 : 1, dy = y1 === y2 ? 1 : 0;
            ctx.moveTo(Math.round(x1) - dx + 0.5, Math.round(y1) - dy + 0.5);
            ctx.lineTo(Math.round(x2) - dx + 0.5, Math.round(y2) - dy + 0.5);
            ctx.moveTo(Math.round(x1) + dx + 0.5, Math.round(y1) + dy + 0.5);
            ctx.lineTo(Math.round(x2) + dx + 0.5, Math.round(y2) + dy + 0.5);
          } else {
            ctx.moveTo(Math.round(x1) - (y1 === y2 ? 0 : off) - 0.5 + off * 2, Math.round(y1) - 0.5 + off * 2 - (y1 === y2 ? 0 : 0));
            ctx.lineTo(Math.round(x2) - 0.5 + off * 2, Math.round(y2) - 0.5 + off * 2);
          }
          ctx.stroke();
          ctx.setLineDash([]);
        };
        line(st.bt, q.x - 1, q.y, q.x + q.w, q.y);
        line(st.bb, q.x - 1, q.y + q.h, q.x + q.w, q.y + q.h);
        line(st.bl, q.x, q.y - 1, q.x, q.y + q.h);
        line(st.br, q.x + q.w, q.y - 1, q.x + q.w, q.y + q.h);
      }
    if (print) paintPrintBorders(ctx, segs);
    ctx.restore();
  }
  // pictures, charts, shapes over the cells (render/sheetDrawings.ts), through each pane's mapping
  if (sh.drawings?.length && p.drawings !== false) {
    // (printed: drawings stay where the boundaries are — moving them a line slot in like the cells drops the chart
    // workbook's pages from 0.94 to 0.84 against Excel's PDF)
    const fx = (sx: number) => hw + (sx - g.cols.pos(L.fc0)) * z, sxm = (sx: number) => L.x0 + (sx - L.sx) * z;
    const fy = (sy: number) => hh + (sy - g.rows.pos(L.fr0)) * z, sym = (sy: number) => L.y0 + (sy - L.sy) * z;
    const maps: DrawingPaneMap[] = [{ x: sxm, y: sym, clip: { x: L.x0, y: L.y0, w: p.width - L.x0, h: p.height - L.y0 } }];
    if (L.fr) maps.push({ x: sxm, y: fy, clip: { x: L.x0, y: hh, w: p.width - L.x0, h: L.frozenH } });
    if (L.fc) maps.push({ x: fx, y: sym, clip: { x: hw, y: L.y0, w: L.frozenW, h: p.height - L.y0 } });
    if (L.fr && L.fc) maps.push({ x: fx, y: fy, clip: { x: hw, y: hh, w: L.frozenW, h: L.frozenH } });
    paintDrawings(ctx, sh, z, maps, { lang: p.lang, sheets: p.sheets });
  }
  // a split: Excel's grey split bars between the panes
  if (sh.split && !sh.freeze) {
    ctx.fillStyle = dark ? "#5a5a5a" : "#D6D6D6";
    if (L.fr) ctx.fillRect(0, Math.round(L.y0) - 2, p.width, 4);
    if (L.fc) ctx.fillRect(Math.round(L.x0) - 2, 0, 4, p.height);
  }
  // frozen-pane lines
  ctx.strokeStyle = "#9E9E9E";
  ctx.lineWidth = 1;
  if (L.fr) {
    ctx.beginPath();
    ctx.moveTo(hw, Math.round(L.y0) - 0.5);
    ctx.lineTo(p.width, Math.round(L.y0) - 0.5);
    ctx.stroke();
  }
  if (L.fc) {
    ctx.beginPath();
    ctx.moveTo(Math.round(L.x0) - 0.5, hh);
    ctx.lineTo(Math.round(L.x0) - 0.5, p.height);
    ctx.stroke();
  }
  // selection
  if (p.sel) paintSelection(ctx, sh, p, mergeAt);
  if (p.sel) paintSheetExtras(ctx, sh, p); // notes, filter buttons, list arrow, fill drag (render/sheetExtras.ts)
  if (p.clip) {
    const q = rect(p.clip.r0, p.clip.c0, p.clip.r1, p.clip.c1);
    ctx.strokeStyle = ACCENT;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeRect(q.x + 1, q.y + 1, q.w - 2, q.h - 2);
    ctx.setLineDash([]);
  }
  // headings
  if (hw || hh) paintHeadings(ctx, sh, p, L, dark);
  ctx.restore();
}

function drawCellText(
  ctx: Ctx,
  sh: SheetData,
  p: SheetPaint,
  r: number,
  c: number,
  m: Rect | undefined,
  looks: Map<string, CondLook>,
  occupied: (r: number, c: number) => boolean,
  rect: (r: number, c: number, r1?: number, c1?: number) => { x: number; y: number; w: number; h: number },
) {
  const a = addr(r, c);
  const cell = sh.cells[a];
  if (!cell || cell.v === undefined || cell.v === "") return;
  const z = p.zoom;
  const st: SheetStyle = sh.styles[cell.s ?? 0] ?? {};
  const look = looks.get(a);
  if (look?.hide) return;
  const f = p.formulas && cell.f ? ({ text: "=" + cell.f.replace(/_xlfn\.|_xlws\.|_xlpm\./g, "") } as Formatted) : display(sh, cell, p.lang);
  let text = f.text;
  const q = m ? rect(m.r0, m.c0, m.r1, m.c1) : rect(r, c);
  const isNum = typeof cell.v === "number" && cell.t !== "e";
  const hAlign = st.h === "center" || st.h === "centerContinuous" || st.h === "distributed" ? "center" : st.h === "right" ? "right" : st.h === "left" || st.h === "fill" || st.h === "justify" ? "left" : isNum ? "right" : typeof cell.v === "boolean" || cell.t === "e" ? "center" : "left";
  // printed pages: Excel's printed geometry (see PRINT_DOT above) — the text area starts after the cell's left line slot
  const print = !!p.gridColor;
  const sizePx = print ? printFontPx(st.size ?? sh.baseSize, z) : (((st.size ?? sh.baseSize) * 96) / 72) * z;
  ctx.font = fontOf(sh, { ...st, bold: look?.bold ?? st.bold, italic: look?.italic ?? st.italic }, z, print ? sizePx : undefined);
  const mw = (t: string) => ctx.measureText(t).width;
  ctx.fillStyle = f.color ?? look?.color ?? st.color ?? "#000000";
  const pad = 2 * z + 1;
  // (bold text starts a dot further in from 55 % up: 14 / 10 / 8 / 6 dots at 100 / 70 / 55 / 44 %)
  const padL = print ? 8 * PRINT_DOT + Math.round(13 * z + ((look?.bold ?? st.bold) ? 0.6 : 0)) * PRINT_DOT : pad, padR = print ? 13.5 * z * PRINT_DOT : pad;
  // an icon set's icon takes the left of the cell: text starts after it (a number that no longer fits shows ####)
  const indent = (st.indent ?? 0) * (sh.mdw + 1) * z + (look?.icon ? Math.max(6, Math.min(q.h - 4, 16 * z)) + 3 : 0);
  const avail = q.w - padL - padR - indent;
  // fill character (accounting formats): repeated to the width
  if (f.fillAt != null) {
    const ch = text[f.fillAt] ?? " ";
    const restW = mw(text.slice(0, f.fillAt) + text.slice(f.fillAt + 1));
    const cw = mw(ch) || 1;
    const n = Math.max(1, Math.floor((avail - restW) / cw));
    text = text.slice(0, f.fillAt) + ch.repeat(n) + text.slice(f.fillAt + 1);
  }
  let tw = mw(text);
  if (isNum && !st.wrap && tw > avail && !(st.shrink)) {
    // a number that does not fit shows ####
    const hw = mw("#") || 1;
    text = "#".repeat(Math.max(1, Math.floor(avail / hw)));
    tw = mw(text);
  }
  ctx.save();
  // clip: the cell, or — for text that does not wrap — across empty neighbours
  let cx0 = q.x, cx1 = q.x + q.w;
  if (!st.wrap && !m && !isNum && tw > avail) {
    if (hAlign === "left" || hAlign === "center") for (let k = c + 1; k < c + 30 && !occupied(r, k); k++) cx1 = rect(r, k).x + rect(r, k).w;
    if (hAlign === "right" || hAlign === "center") for (let k = c - 1; k >= Math.max(0, c - 30) && !occupied(r, k); k--) cx0 = rect(r, k).x;
  }
  ctx.beginPath();
  ctx.rect(cx0, q.y, cx1 - cx0, q.h);
  ctx.clip();
  const lines = st.wrap ? wrapText(ctx, text, Math.max(4, avail)) : text.split(/\r?\n/).slice(0, 1);
  const lh = sizePx * 1.25;
  const blockH = lines.length * lh;
  const vAlign = st.v ?? "bottom";
  const mid = vAlign === "center" || vAlign === "justify" || vAlign === "distributed";
  // (a line's baseline is y + lh − (lh − size) / 2 − 0.18 size)
  const baseToY = (lh - sizePx) / 2 + sizePx * 0.18 - lh;
  let y = vAlign === "top" ? q.y + pad : mid ? q.y + (q.h - blockH) / 2 : q.y + q.h - blockH - pad;
  if (print) {
    // Excel's line box (io/sheet/printFont.ts): the font's ascent + leading above the baseline, `box` dots in all, set
    // right under the row's line slot (top), centred in the cell below the slot, or 2.5 dots above the next slot
    // (bottom) — the same for every font measured (qa/interop/excel-made/omni-xlsx-print-fonts.truth.json: top and
    // centre within ½ dot, bottom 2–3 dots above top in a default row); the fractions are 맑은 고딕's from Excel's PDFs
    // at 40–92-dot fonts (a 92-dot centred line 38.27 dots below the slot's middle line, a top one 107.98 below the cell)
    const lb = printLineBox(st.font ?? sh.baseFont, st.size ?? sh.baseSize, z);
    const first =
      vAlign === "top"
        ? q.y + (7.98 + lb.above) * PRINT_DOT
        : mid
          ? q.y + q.h / 2 + (3.77 + lb.above - lb.box / 2) * PRINT_DOT - ((lines.length - 1) * lh) / 2
          : q.y + q.h - (2.5 + lb.box - lb.above) * PRINT_DOT - (lines.length - 1) * lh;
    y = first + baseToY;
  }
  ctx.textBaseline = "alphabetic";
  const rot = st.rot ?? 0;
  if (rot && rot !== 255) {
    const ang = rot <= 90 ? (-rot * Math.PI) / 180 : ((rot - 90) * Math.PI) / 180;
    ctx.translate(q.x + q.w / 2, q.y + q.h / 2);
    ctx.rotate(ang);
    ctx.textAlign = "center";
    ctx.fillText(text, 0, sizePx * 0.35);
    ctx.restore();
    return;
  }
  for (const line of lines) {
    const w = mw(line);
    const x = hAlign === "right" ? q.x + q.w - padR - w - (st.h === "right" ? indent : 0) : hAlign === "center" ? q.x + (print ? 8 * PRINT_DOT : 0) + (q.w - (print ? 8 * PRINT_DOT : 0) - w) / 2 : q.x + padL + indent;
    const base = y + lh - (lh - sizePx) / 2 - sizePx * 0.18;
    // (small printed type is painted once: Excel's PDF only looks heavier at small sizes as pdf.js rasterises it at
    // 96 dpi — a second pass matched that picture, not Excel's print, and thickened the 192 dpi PDF / print pages)
    ctx.fillText(line, x, base);
    const strike = look?.strike ?? st.strike;
    if (st.underline || strike) {
      ctx.strokeStyle = ctx.fillStyle as string;
      ctx.lineWidth = Math.max(1, sizePx / 14);
      ctx.beginPath();
      if (st.underline) {
        ctx.moveTo(x, base + 2 * z);
        ctx.lineTo(x + w, base + 2 * z);
        if (st.underline === "double") {
          ctx.moveTo(x, base + 4 * z);
          ctx.lineTo(x + w, base + 4 * z);
        }
      }
      if (strike) {
        ctx.moveTo(x, base - sizePx * 0.3);
        ctx.lineTo(x + w, base - sizePx * 0.3);
      }
      ctx.stroke();
    }
    y += lh;
  }
  ctx.restore();
}

/** Lines of a wrapped cell (spaces break; CJK text breaks anywhere). */
export function wrapText(ctx: Ctx, text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    // i18n: keep — character ranges (CJK breaks anywhere), not text
    const tokens = para.match(/[ᄀ-ᇿ　-鿿가-힯豈-﫿]|\S+\s*|\s+/g) ?? [""]; // i18n: keep — format codes / character ranges
    for (const tk of tokens) {
      const next = line + tk;
      if (line && ctx.measureText(next.trimEnd()).width > width) {
        out.push(line.trimEnd());
        line = tk.trimStart();
        // a single word wider than the cell: broken by characters
        while (ctx.measureText(line).width > width && line.length > 1) {
          let k = line.length - 1;
          while (k > 1 && ctx.measureText(line.slice(0, k)).width > width) k--;
          out.push(line.slice(0, k));
          line = line.slice(k);
        }
      } else line = next;
    }
    out.push(line.trimEnd());
  }
  return out;
}

function paintSelection(ctx: Ctx, sh: SheetData, p: SheetPaint, mergeAt: Map<string, Rect>) {
  const s = p.sel!;
  const L = panes(sh, p);
  ctx.save();
  ctx.beginPath();
  ctx.rect(L.hw, L.hh, p.width - L.hw, p.height - L.hh);
  ctx.clip();
  const q = cellRect(sh, p, s.g.r0, s.g.c0, Math.min(s.g.r1, MAX_ROW), Math.min(s.g.c1, MAX_COL));
  const am = mergeAt.get(addr(s.ar, s.ac));
  const aq = am ? cellRect(sh, p, am.r0, am.c0, am.r1, am.c1) : cellRect(sh, p, s.ar, s.ac);
  // the other areas of a multi-area selection: shaded with a thin frame (Excel)
  for (const m of s.more ?? []) {
    const mq = cellRect(sh, p, m.r0, m.c0, Math.min(m.r1, MAX_ROW), Math.min(m.c1, MAX_COL));
    ctx.fillStyle = "rgba(43, 116, 236, 0.12)";
    ctx.fillRect(mq.x, mq.y, mq.w, mq.h);
    ctx.strokeStyle = "rgba(43,116,236,0.6)";
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(mq.x) + 0.5, Math.round(mq.y) + 0.5, Math.round(mq.w) - 1, Math.round(mq.h) - 1);
  }
  const multi = s.g.r0 !== s.g.r1 || s.g.c0 !== s.g.c1 || !!s.more?.length;
  if (multi && !(am && am.r0 === s.g.r0 && am.c0 === s.g.c0 && am.r1 === s.g.r1 && am.c1 === s.g.c1)) {
    // the range is shaded, the active cell in it stays clear
    ctx.fillStyle = "rgba(43, 116, 236, 0.12)";
    ctx.beginPath();
    ctx.rect(q.x, q.y, q.w, q.h);
    ctx.rect(aq.x, aq.y, aq.w, aq.h);
    ctx.fill("evenodd");
  }
  // the range a dynamic array formula fills: a thin blue frame while its anchor or one of its cells is active
  const act = sh.cells[addr(s.ar, s.ac)];
  const anchor = act?.sp ? sh.cells[act.sp] : act;
  const sg = anchor?.f && anchor.spill && !anchor.cse && !(anchor.t === "e" && anchor.v === "#SPILL!") ? parseRange(anchor.spill) : null;
  if (sg && (sg.r0 !== sg.r1 || sg.c0 !== sg.c1)) {
    const sq = cellRect(sh, p, sg.r0, sg.c0, sg.r1, sg.c1);
    ctx.strokeStyle = "#4472C4";
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(sq.x) + 0.5, Math.round(sq.y) + 0.5, Math.round(sq.w) - 1, Math.round(sq.h) - 1);
  }
  ctx.strokeStyle = ACCENT;
  ctx.lineWidth = 2;
  ctx.strokeRect(Math.round(q.x) + 0.5, Math.round(q.y) + 0.5, Math.round(q.w) - 1, Math.round(q.h) - 1);
  if (multi) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(43,116,236,0.6)";
    ctx.strokeRect(Math.round(aq.x) + 1.5, Math.round(aq.y) + 1.5, Math.round(aq.w) - 3, Math.round(aq.h) - 3);
  }
  // fill handle
  ctx.fillStyle = ACCENT;
  ctx.fillRect(Math.round(q.x + q.w) - 3, Math.round(q.y + q.h) - 3, 6, 6);
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1;
  ctx.strokeRect(Math.round(q.x + q.w) - 3.5, Math.round(q.y + q.h) - 3.5, 7, 7);
  ctx.restore();
}

function paintHeadings(ctx: Ctx, sh: SheetData, p: SheetPaint, L: ReturnType<typeof panes>, dark: boolean) {
  const { g, z, hw, hh } = L;
  const bg = dark ? "#2b2b2b" : "#F3F3F3";
  const fg = dark ? "#d6d6d6" : "#444444";
  const line = dark ? "#4a4a4a" : "#D4D4D4";
  const selBg = dark ? "#3c3c3c" : "#D2D2D2";
  const s = p.sel?.g;
  ctx.font = `${Math.round(11 * Math.max(0.75, Math.min(1.6, z)))}px "맑은 고딕", "Malgun Gothic", "Segoe UI", sans-serif`; // i18n: keep — font names
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // column headings
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, p.width, hh);
  const colRuns: [number, number, number][] = []; // [c0, c1, xStart]
  if (L.fc) colRuns.push([L.fc0, L.fcE - 1, hw]);
  colRuns.push([g.cols.at(L.sx), MAX_COL, L.x0]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(hw, 0, p.width - hw, hh);
  ctx.clip();
  for (const [c0, c1, xs] of colRuns) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(xs, 0, p.width - xs, hh);
    ctx.clip();
    for (let c = c0; c <= c1; c++) {
      if (g.cols.size(c) === 0) continue;
      const q = cellRect(sh, p, 0, c);
      if (q.x > p.width) break;
      const on = s && c >= s.c0 && c <= s.c1;
      if (on) {
        ctx.fillStyle = selBg;
        ctx.fillRect(q.x, 0, q.w, hh);
        ctx.fillStyle = ACCENT;
        ctx.fillRect(q.x, hh - 2, q.w, 2);
      }
      ctx.fillStyle = on ? (dark ? "#ffffff" : ACCENT) : fg;
      if (q.w > 8) ctx.fillText(colLetters(c), q.x + q.w / 2, hh / 2 + 0.5);
      ctx.fillStyle = line;
      ctx.fillRect(Math.round(q.x + q.w) - 1, 0, 1, hh);
    }
    ctx.restore();
  }
  ctx.restore();
  // row headings
  ctx.fillStyle = bg;
  ctx.fillRect(0, hh, hw, p.height - hh);
  const rowRuns: [number, number, number][] = [];
  if (L.fr) rowRuns.push([L.fr0, L.frE - 1, hh]);
  rowRuns.push([g.rows.at(L.sy), MAX_ROW, L.y0]);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, hh, hw, p.height - hh);
  ctx.clip();
  for (const [r0, r1, ys] of rowRuns) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, ys, hw, p.height - ys);
    ctx.clip();
    for (let r = r0; r <= r1; r++) {
      if (g.rows.size(r) === 0) continue;
      const q = cellRect(sh, p, r, 0);
      if (q.y > p.height) break;
      const on = s && r >= s.r0 && r <= s.r1;
      if (on) {
        ctx.fillStyle = selBg;
        ctx.fillRect(0, q.y, hw, q.h);
        ctx.fillStyle = ACCENT;
        ctx.fillRect(hw - 2, q.y, 2, q.h);
      }
      ctx.fillStyle = on ? (dark ? "#ffffff" : ACCENT) : fg;
      if (q.h > 6) ctx.fillText(String(r + 1), hw / 2, q.y + q.h / 2 + 0.5);
      ctx.fillStyle = line;
      ctx.fillRect(0, Math.round(q.y + q.h) - 1, hw, 1);
    }
    ctx.restore();
  }
  ctx.restore();
  // corner and edges
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, hw, hh);
  ctx.fillStyle = dark ? "#777" : "#B8B8B8";
  ctx.beginPath();
  ctx.moveTo(hw - 4, hh - 4);
  ctx.lineTo(hw - 4, hh - 4 - Math.min(10, hh * 0.5));
  ctx.lineTo(hw - 4 - Math.min(10, hh * 0.5), hh - 4);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = line;
  ctx.fillRect(0, hh - 1, p.width, 1);
  ctx.fillRect(hw - 1, 0, 1, p.height);
}

/**
 * A sheet drawn on its page (thumbnails, page pictures, prints): printed page `pageIndex` as Excel prints it — the
 * page setup's paper, margins, scale or fit to pages, print area, titles, breaks, centring, gridlines / headings and
 * header / footer (io/sheet/printLayout.ts, render/sheetPrint.ts); Excel's defaults (A4, 0.7 / 0.75 in margins, 100 %,
 * no gridlines or headings) when the file has no page setup. The paper is fitted into `width` × `height` px.
 */
export function paintSheetPage(ctx: Ctx, sh: SheetData, width: number, height: number, lang: SheetLang = sh.lang ?? "en", pageIndex = 0) {
  paintSheetPrintPage(ctx, sh, width, height, lang, pageIndex);
}
