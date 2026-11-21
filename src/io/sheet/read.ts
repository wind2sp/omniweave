// Excel workbook (.xlsx / .xlsm, SpreadsheetML — ECMA-376 Part 1 §18) → sheet models (core/sheetTypes.ts): every
// worksheet with its cell values, formulas, number formats, fonts, fills, borders, alignment, column widths, row
// heights, hidden rows / columns, merges, frozen panes, conditional formats, gridline / heading settings.
// Omniweave's own reader, written from the public schema.

import { strFromU8, unzipSync } from "fflate";
import type { SheetBorder, SheetCell, SheetCond, SheetCondRule, SheetData, SheetStyle } from "../../core/sheetTypes";
import { attr, child, children, descendants, parseXml, textOf } from "../xml";
import { builtinFormat, type SheetLang } from "./numfmt";
import { addr, parseAddr, shiftFormula } from "./formula";
import { readExtra } from "./readExtra";
import { markSpills, readTables } from "./tables";
import { readPrintSetup } from "./printSetup";
import { readDrawings } from "./drawings";
import { screenDigitPx } from "./printFont";

export interface ReadResult {
  sheets: SheetData[];
  /** cells left out past the size limit */
  truncated: boolean;
}

/** More cells than this are not read (a viewer guard; Excel's own limit is far larger). */
export const MAX_CELLS = 2_000_000;

const BASIC = ["000000", "FFFFFF", "FF0000", "00FF00", "0000FF", "FFFF00", "FF00FF", "00FFFF"];
const PAL56 =
  "000000FFFFFFFF000000FF000000FFFFFF00FF00FF00FFFF800000008000000080808000800080008080C0C0C0808080" +
  "9999FF993366FFFFCCCCFFFF660066FF80800066CCCCCCFF000080FF00FFFFFF0000FFFF800080800000008080" +
  "0000FF00CCFFCCFFFFCCFFCCFFFF9999CCFFFF99CCCC99FFFFCC993366FF33CCCC99CC00FFCC00FF9900FF6600" +
  "666699969696003366339966003300333300993300993366333399333333";
// (2026-11-21, 표 계산부: indexes 43–63 were shifted by a typo — 43 is FFFF99, 52 FF9900, 63 333333 as in Excel)
export const INDEXED = [...BASIC, ...Array.from({ length: 56 }, (_, i) => PAL56.slice(i * 6, i * 6 + 6))];

/** Maximum digit width (px at 96 dpi) of a font, the unit of column widths (§18.3.1.13): GDI's hinted digit width
 * for the fonts of io/sheet/printFont.ts (Calibri 11 = 7, Arial 10 = 7, 맑은 고딕 11 = 8), else measured in Excel. */
export function digitWidth(font: string, sizePt: number): number {
  const known = screenDigitPx(font, sizePt);
  if (known) return Math.max(4, known);
  const f = font.trim().toLowerCase();
  const at11 = /맑은 고딕|malgun gothic|돋움|dotum|굴림|gulim|meiryo|游ゴシック|yu gothic|ms pgothic|ｍｓ ｐゴシック|等线|dengxian|微软雅黑|microsoft yahei/.test(f) ? 8 : 7; // i18n: keep — font names matched in files
  return Math.max(4, Math.round((at11 * sizePt) / 11));
}

/** Column width in characters (as stored) → px (§18.3.1.13, Excel's truncation). */
export const widthPx = (w: number, mdw: number) => Math.trunc(((256 * w + Math.trunc(128 / mdw)) / 256) * mdw);
/** px → stored width in characters. */
export const widthChars = (px: number, mdw: number) => Math.trunc((px / mdw) * 256) / 256;

function hsl(rgb: string): [number, number, number] {
  const r = parseInt(rgb.slice(0, 2), 16) / 255, g = parseInt(rgb.slice(2, 4), 16) / 255, b = parseInt(rgb.slice(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function rgbOf(h: number, s: number, l: number): string {
  const f = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = f(p, q, h + 1 / 3);
    g = f(p, q, h);
    b = f(p, q, h - 1 / 3);
  }
  return [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("").toUpperCase();
}
/** A colour lightened / darkened by a tint (§18.8.19 CT_Color tint). */
export function tinted(rgb: string, tint: number): string {
  if (!tint) return rgb;
  const [h, s, l] = hsl(rgb);
  const l2 = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return rgbOf(h, s, Math.min(1, Math.max(0, l2)));
}

interface Ctx {
  theme: string[];
  indexed: string[];
}

function color(el: Element | undefined, ctx: Ctx): string | undefined {
  if (!el) return undefined;
  if (attr(el, "auto") === "1") return undefined;
  let rgb: string | undefined;
  const a = attr(el, "rgb");
  const th = attr(el, "theme");
  const ix = attr(el, "indexed");
  if (a) rgb = a.length === 8 ? a.slice(2) : a.slice(-6);
  else if (th != null) rgb = ctx.theme[Number(th)];
  else if (ix != null) {
    const n = Number(ix);
    if (n === 64 || n === 65) return undefined; // system foreground / background
    rgb = ctx.indexed[n];
  }
  if (!rgb) return undefined;
  const tint = Number(attr(el, "tint") ?? 0);
  return "#" + tinted(rgb.toUpperCase(), tint);
}

export function themeColors(xml: string | undefined): string[] {
  // SpreadsheetML theme indexes: 0 lt1, 1 dk1, 2 lt2, 3 dk2, 4–9 accent1–6, 10 hlink, 11 folHlink
  const def = ["FFFFFF", "000000", "E7E6E6", "44546A", "4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47", "0563C1", "954F72"];
  if (!xml) return def;
  const doc = parseXml(xml);
  const scheme = descendants(doc, "clrScheme")[0];
  if (!scheme) return def;
  const get = (name: string, i: number) => {
    const el = child(scheme, name);
    const c = el && children(el)[0];
    if (!c) return def[i];
    return (attr(c, "lastClr") ?? attr(c, "val") ?? def[i]).toUpperCase();
  };
  const order = ["lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink"];
  return order.map(get);
}

interface Font {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: "single" | "double";
  strike?: boolean;
  color?: string;
}

const flag = (el: Element | undefined) => !!el && !/^(0|false)$/.test(attr(el, "val") ?? "1");

function readFont(f: Element, ctx: Ctx): Font {
  const u = child(f, "u");
  const uv = u && (attr(u, "val") ?? "single");
  return {
    name: attr(child(f, "name") ?? f, "val") ?? undefined,
    size: Number(attr(child(f, "sz") ?? f, "val")) || undefined,
    bold: flag(child(f, "b")),
    italic: flag(child(f, "i")),
    underline: u && uv !== "none" ? (/double/.test(uv!) ? "double" : "single") : undefined,
    strike: flag(child(f, "strike")),
    color: color(child(f, "color"), ctx),
  };
}

function readFill(f: Element, ctx: Ctx): string | undefined {
  const p = child(f, "patternFill");
  if (p) {
    const type = attr(p, "patternType") ?? (child(p, "fgColor") || child(p, "bgColor") ? "solid" : "none");
    if (type === "none") return undefined;
    // patterns other than solid: their foreground colour (a light approximation of the hatch)
    return color(child(p, type === "solid" ? "fgColor" : "fgColor"), ctx) ?? color(child(p, "bgColor"), ctx) ?? (type === "solid" ? "#000000" : undefined);
  }
  const g = child(f, "gradientFill");
  const stop = g && children(g, "stop")[0];
  return stop ? color(child(stop, "color"), ctx) : undefined;
}

function readBorder(b: Element, ctx: Ctx): Pick<SheetStyle, "bl" | "br" | "bt" | "bb"> {
  const side = (name: string): SheetBorder | undefined => {
    const e = child(b, name) ?? (name === "left" ? child(b, "start") : name === "right" ? child(b, "end") : undefined);
    const st = e && attr(e, "style");
    if (!e || !st || st === "none") return undefined;
    return { style: st, color: color(child(e, "color"), ctx) ?? "#000000" };
  };
  const out: Pick<SheetStyle, "bl" | "br" | "bt" | "bb"> = {};
  const l = side("left"), r = side("right"), t = side("top"), bt = side("bottom");
  if (l) out.bl = l;
  if (r) out.br = r;
  if (t) out.bt = t;
  if (bt) out.bb = bt;
  return out;
}

const strip = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === false) delete o[k];
  return o;
};

/** Read every worksheet of a workbook. `lang` = the reader's locale (built-in date formats 14, 22…). */
export function readXlsx(bytes: Uint8Array, lang: SheetLang = "en", book = "book"): ReadResult {
  const files = unzipSync(bytes, { filter: (f) => /\.(xml|rels)$/i.test(f.name) || /^xl\/media\//i.test(f.name) });
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : undefined);
  const wbXml = read("xl/workbook.xml");
  if (!wbXml) throw new Error("not a workbook");
  const wb = parseXml(wbXml);
  const date1904 = descendants(wb, "workbookPr").some((e) => /^(1|true)$/.test(attr(e, "date1904") ?? ""));
  const rels = new Map<string, string>();
  const relFile = read("xl/_rels/workbook.xml.rels");
  if (relFile)
    for (const r of descendants(parseXml(relFile), "Relationship")) {
      const t = attr(r, "Target") ?? "";
      rels.set(attr(r, "Id") ?? "", t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, ""));
    }
  const ctx: Ctx = { theme: themeColors(read("xl/theme/theme1.xml")), indexed: INDEXED.slice() };

  // shared strings (phonetic runs are not part of the value)
  const shared: string[] = [];
  const ssXml = read("xl/sharedStrings.xml");
  if (ssXml)
    for (const si of descendants(parseXml(ssXml), "si")) {
      let s = "";
      const visit = (n: Element) => {
        for (const c of children(n)) {
          if (c.localName === "rPh" || c.localName === "phoneticPr") continue;
          if (c.localName === "t") s += textOf(c);
          else visit(c);
        }
      };
      visit(si);
      shared.push(s);
    }

  // styles
  const xfs: SheetStyle[] = [];
  const dxfs: SheetCondRule["style"][] = [];
  let baseFont = "Calibri", baseSize = 11;
  const stXml = read("xl/styles.xml");
  if (stXml) {
    const sd = parseXml(stXml);
    const custom = descendants(sd, "colors")[0];
    const ixEl = custom && child(custom, "indexedColors");
    if (ixEl) children(ixEl, "rgbColor").forEach((c, i) => (ctx.indexed[i] = (attr(c, "rgb") ?? "").slice(-6)));
    const fmts = new Map<number, string>();
    for (const f of descendants(sd, "numFmt")) fmts.set(Number(attr(f, "numFmtId")), attr(f, "formatCode") ?? "General");
    const fontsEl = descendants(sd, "fonts")[0];
    const fonts = fontsEl ? children(fontsEl, "font").map((f) => readFont(f, ctx)) : [];
    const fillsEl = descendants(sd, "fills")[0];
    const fills = fillsEl ? children(fillsEl, "fill").map((f) => readFill(f, ctx)) : [];
    const bordersEl = descendants(sd, "borders")[0];
    const borders = bordersEl ? children(bordersEl, "border").map((b) => readBorder(b, ctx)) : [];
    const styleXfs = descendants(sd, "cellStyleXfs")[0];
    const f0 = fonts[Number((styleXfs && children(styleXfs, "xf")[0] && attr(children(styleXfs, "xf")[0], "fontId")) ?? 0)] ?? fonts[0];
    if (f0?.name) baseFont = f0.name;
    if (f0?.size) baseSize = f0.size;
    const cellXfs = descendants(sd, "cellXfs")[0];
    for (const xf of cellXfs ? children(cellXfs, "xf") : []) {
      const id = Number(attr(xf, "numFmtId") ?? 0);
      const font = fonts[Number(attr(xf, "fontId") ?? 0)] ?? {};
      const al = child(xf, "alignment");
      const st: SheetStyle = {
        fmt: id === 0 ? undefined : fmts.get(id) ?? builtinFormat(id, lang),
        font: font.name && font.name !== baseFont ? font.name : undefined,
        size: font.size && font.size !== baseSize ? font.size : undefined,
        bold: font.bold,
        italic: font.italic,
        underline: font.underline,
        strike: font.strike,
        color: font.color && font.color !== "#000000" ? font.color : undefined,
        fill: fills[Number(attr(xf, "fillId") ?? 0)],
        ...borders[Number(attr(xf, "borderId") ?? 0)],
      };
      if (st.fmt === "General") delete st.fmt;
      if (al) {
        const h = attr(al, "horizontal");
        if (h && h !== "general") st.h = h as SheetStyle["h"];
        const v = attr(al, "vertical");
        if (v && v !== "bottom") st.v = v as SheetStyle["v"];
        if (flag(al) && attr(al, "wrapText") && /^(1|true)$/.test(attr(al, "wrapText")!)) st.wrap = true;
        if (/^(1|true)$/.test(attr(al, "shrinkToFit") ?? "")) st.shrink = true;
        const ind = Number(attr(al, "indent") ?? 0);
        if (ind) st.indent = ind;
        const rot = Number(attr(al, "textRotation") ?? 0);
        if (rot) st.rot = rot;
      }
      xfs.push(strip(st));
    }
    const dxfsEl = descendants(sd, "dxfs")[0];
    for (const d of dxfsEl ? children(dxfsEl, "dxf") : []) {
      const f = child(d, "font");
      const fl = child(d, "fill");
      const font = f ? readFont(f, ctx) : {};
      // a dxf fill's solid colour is its bgColor (§18.8.17)
      const pf = fl && child(fl, "patternFill");
      const fill = pf ? color(child(pf, "bgColor"), ctx) ?? color(child(pf, "fgColor"), ctx) : undefined;
      dxfs.push(strip({ color: font.color, fill, bold: font.bold, italic: font.italic, strike: font.strike, underline: font.underline }));
    }
  }
  if (!xfs.length) xfs.push({});
  const mdw = digitWidth(baseFont, baseSize);

  // defined names
  const sheetEls = descendants(wb, "sheet");
  const names: Record<string, string> = {};
  const localNames = new Map<number, Record<string, string>>();
  for (const dn of descendants(wb, "definedName")) {
    const n = attr(dn, "name") ?? "";
    if (!n || /^_xlnm\./i.test(n)) continue;
    const ls = attr(dn, "localSheetId");
    if (ls != null) {
      const m = localNames.get(Number(ls)) ?? {};
      m[n] = textOf(dn);
      localNames.set(Number(ls), m);
    } else names[n] = textOf(dn);
  }

  const out: SheetData[] = [];
  let truncated = false;
  let total = 0;
  sheetEls.forEach((s, si) => {
    const path = rels.get(attr(s, "id") ?? "") ?? `xl/worksheets/sheet${si + 1}.xml`;
    const xml = read(path);
    if (!xml) return; // chart sheets, dialog sheets
    const doc = parseXml(xml);
    const root = doc.documentElement;
    const used = new Map<number, number>([[0, 0]]); // workbook xf → sheet style index
    const styles: SheetStyle[] = [xfs[0]];
    const styleOf = (x: string | null) => {
      const n = Number(x ?? 0);
      if (!n || !xfs[n]) return 0;
      let k = used.get(n);
      if (k === undefined) {
        k = styles.push(xfs[n]) - 1;
        used.set(n, k);
      }
      return k;
    };
    const sh: SheetData = {
      book,
      name: attr(s, "name") ?? `Sheet${si + 1}`,
      index: si,
      cells: {},
      styles,
      colW: {},
      rowH: {},
      defColW: 64,
      defRowH: 20,
      merges: [],
      grid: true,
      headings: true,
      baseFont,
      baseSize,
      mdw,
      lang,
    };
    if (attr(s, "state") && attr(s, "state") !== "visible") sh.hidden = true;
    if (date1904) sh.date1904 = true;
    const nm = { ...names, ...(localNames.get(si) ?? {}) };
    if (Object.keys(nm).length) sh.names = nm;
    const pr = child(root, "sheetPr");
    const tab = pr && color(child(pr, "tabColor"), ctx);
    if (tab) sh.tabColor = tab;
    // view
    const view = descendants(root, "sheetView")[0];
    if (view) {
      if (/^(0|false)$/.test(attr(view, "showGridLines") ?? "")) sh.grid = false;
      if (/^(0|false)$/.test(attr(view, "showRowColHeaders") ?? "")) sh.headings = false;
      if (/^(1|true)$/.test(attr(view, "rightToLeft") ?? "")) sh.rtl = true;
      const z = Number(attr(view, "zoomScale") ?? 100);
      if (z && z !== 100) sh.zoom = z / 100;
      const pane = child(view, "pane");
      if (pane && /frozen/.test(attr(pane, "state") ?? "")) {
        const rows = Math.round(Number(attr(pane, "ySplit") ?? 0)), cols = Math.round(Number(attr(pane, "xSplit") ?? 0));
        if (rows || cols) sh.freeze = { rows, cols };
      }
      const tl = attr(view, "topLeftCell");
      if (tl && tl !== "A1") sh.topLeft = tl;
      const sel = children(view, "selection").pop();
      const ac = sel && attr(sel, "activeCell");
      if (ac) sh.active = ac;
    }
    // sizes
    const fmt = child(root, "sheetFormatPr");
    if (fmt) {
      const dcw = Number(attr(fmt, "defaultColWidth"));
      const base = Number(attr(fmt, "baseColWidth") ?? 8);
      sh.defColW = dcw > 0 ? widthPx(dcw, mdw) : Math.ceil((base * mdw + 5) / 8) * 8;
      const drh = Number(attr(fmt, "defaultRowHeight"));
      if (drh > 0) sh.defRowH = Math.round((drh * 96) / 72);
      if (drh > 0 && /^(1|true)$/.test(attr(fmt, "customHeight") ?? "")) sh.defRowCustom = true;
    } else sh.defColW = Math.ceil((8 * mdw + 5) / 8) * 8;
    const hiddenCols: number[] = [];
    const colS: Record<number, number> = {};
    for (const c of descendants(root, "col")) {
      const min = Number(attr(c, "min")) - 1, max = Math.min(Number(attr(c, "max")) - 1, 16383);
      const w = Number(attr(c, "width"));
      const hid = /^(1|true)$/.test(attr(c, "hidden") ?? "");
      const st = attr(c, "style");
      for (let i = min; i <= max; i++) {
        if (w >= 0 && attr(c, "width") != null && (i < 1024 || max - min < 64)) sh.colW[i] = widthPx(w, mdw);
        if (hid && (max - min < 4096)) hiddenCols.push(i);
        if (st && st !== "0" && max - min < 4096) colS[i] = styleOf(st);
      }
    }
    if (hiddenCols.length) sh.hiddenCols = hiddenCols;
    if (Object.keys(colS).length) sh.colS = colS;
    // cells
    const hiddenRows: number[] = [];
    const rowS: Record<number, number> = {};
    const sharedF = new Map<string, { f: string; r: number; c: number }>();
    const sheetData = child(root, "sheetData");
    let autoRow = 0;
    for (const r of sheetData ? children(sheetData, "row") : []) {
      const rn = Number(attr(r, "r") ?? autoRow + 1) - 1;
      autoRow = rn + 1;
      const ht = attr(r, "ht");
      if (ht != null && (/^(1|true)$/.test(attr(r, "customHeight") ?? "") || Math.round((Number(ht) * 96) / 72) !== sh.defRowH)) {
        sh.rowH[rn] = Math.round((Number(ht) * 96) / 72);
        if (!/^(1|true)$/.test(attr(r, "customHeight") ?? "")) (sh.rowAuto ??= {})[rn] = true;
      }
      if (/^(1|true)$/.test(attr(r, "hidden") ?? "")) hiddenRows.push(rn);
      if (/^(1|true)$/.test(attr(r, "customFormat") ?? "") && attr(r, "s")) rowS[rn] = styleOf(attr(r, "s"));
      let autoCol = 0;
      for (const c of children(r, "c")) {
        const ref = parseAddr(attr(c, "r") ?? "");
        const col = ref ? ref.c : autoCol;
        autoCol = col + 1;
        if (++total > MAX_CELLS) {
          truncated = true;
          break;
        }
        const t = attr(c, "t") ?? "n";
        const vEl = child(c, "v");
        const raw = vEl ? textOf(vEl) : null;
        const cell: SheetCell = {};
        const sIdx = styleOf(attr(c, "s"));
        if (sIdx) cell.s = sIdx;
        if (t === "s") cell.v = raw != null ? shared[Number(raw)] ?? "" : undefined;
        else if (t === "inlineStr") cell.v = descendants(c, "t").map(textOf).join("");
        else if (t === "b") cell.v = raw != null ? raw === "1" || raw === "true" : undefined;
        else if (t === "e") {
          cell.v = raw ?? "#N/A";
          cell.t = "e";
        } else if (t === "str") cell.v = raw ?? "";
        else if (t === "d") {
          const d = raw ? Date.parse(raw.endsWith("Z") ? raw : raw + "Z") : NaN;
          if (Number.isFinite(d)) cell.v = d / 86400000 + 25569;
        } else if (raw != null && raw !== "") cell.v = Number(raw);
        const fEl = child(c, "f");
        if (fEl) {
          const ft = attr(fEl, "t");
          const text = textOf(fEl);
          if (ft === "shared") {
            const si2 = attr(fEl, "si") ?? "";
            if (text) sharedF.set(si2, { f: text, r: rn, c: col });
            else {
              const m = sharedF.get(si2);
              if (m) cell.f = shiftFormula(m.f, rn - m.r, col - m.c);
            }
            if (text) cell.f = text;
          } else if (text) cell.f = text;
          // array formula: dynamic (cm = dynamic array metadata) or legacy Ctrl+Shift+Enter
          if (ft === "array" && text) cell.spill = attr(fEl, "ref") ?? addr(rn, col);
          if (ft === "array" && text && attr(c, "cm") == null) cell.cse = true;
        }
        if (cell.v === undefined && !cell.f && !cell.s) continue;
        sh.cells[addr(rn, col)] = cell;
      }
      if (truncated) break;
    }
    if (hiddenRows.length) sh.hiddenRows = hiddenRows;
    if (Object.keys(rowS).length) sh.rowS = rowS;
    markSpills(sh);
    const tables = readTables(read, path);
    if (tables.length) sh.tables = tables;
    for (const m of descendants(root, "mergeCell")) {
      const ref = attr(m, "ref");
      if (ref && ref.includes(":")) sh.merges.push(ref);
    }
    // conditional formatting
    const conds: SheetCond[] = [];
    for (const cf of children(root, "conditionalFormatting")) {
      const ranges = (attr(cf, "sqref") ?? "").split(/\s+/).filter(Boolean);
      const rules: SheetCondRule[] = [];
      for (const r of children(cf, "cfRule")) {
        const type = attr(r, "type") ?? "";
        const rule: SheetCondRule = { type, priority: Number(attr(r, "priority") ?? 0) };
        const op = attr(r, "operator");
        if (op) rule.op = op;
        const fs = children(r, "formula").map(textOf);
        if (fs.length) rule.formulas = fs;
        const dx = attr(r, "dxfId");
        if (dx != null && dxfs[Number(dx)]) rule.style = dxfs[Number(dx)];
        if (/^(1|true)$/.test(attr(r, "stopIfTrue") ?? "")) rule.stop = true;
        if (attr(r, "rank")) rule.rank = Number(attr(r, "rank"));
        if (/^(1|true)$/.test(attr(r, "bottom") ?? "")) rule.bottom = true;
        if (/^(1|true)$/.test(attr(r, "percent") ?? "")) rule.percent = true;
        if (attr(r, "text") != null) rule.text = attr(r, "text")!;
        const cs = child(r, "colorScale");
        if (cs) {
          const cfvo = children(cs, "cfvo");
          const cols = children(cs, "color");
          rule.scale = cfvo.map((v, i) => strip({ kind: attr(v, "type") ?? "min", val: attr(v, "val") ?? undefined, color: color(cols[i], ctx) ?? "#FFFFFF" }));
        }
        const db = child(r, "dataBar");
        if (db) {
          rule.bar = color(child(db, "color"), ctx) ?? "#638EC6";
          rule.scale = children(db, "cfvo").map((v) => strip({ kind: attr(v, "type") ?? "min", val: attr(v, "val") ?? undefined, color: rule.bar! }));
          if (child(r, "extLst")) rule.barExt = true;
        }
        rules.push(rule);
      }
      if (rules.length) conds.push({ ranges, rules });
    }
    if (conds.length) sh.cond = conds;
    readExtra(sh, root, path, read); // notes, data validation, AutoFilter (io/sheet/readExtra.ts)
    readPrintSetup(sh, root, wb, si); // page setup, print area / titles (io/sheet/printSetup.ts)
    readDrawings(sh, root, path, read, (p) => files[p], ctx.theme); // charts, pictures, shapes (io/sheet/drawings.ts)
    sh.part = path;
    sh.xf = [0];
    for (const [x, k] of used) sh.xf[k] = x;
    out.push(sh);
  });
  return { sheets: out, truncated };
}
