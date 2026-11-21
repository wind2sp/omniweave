// Office Surgeon — PPTX charts edited here (ui/chartEdit): the chart part's cached values (c:strCache / c:numCache),
// formulas and chart type are written into the original chartN.xml, and the same data into its embedded workbook
// (ppt/embeddings/*.xlsx) through the XLSX writers (surgical first, written anew when that cannot), so PowerPoint's
// "edit data" shows the values the slide shows. Everything else in the chart part (styles, axes, legend, text) stays.

import { putBlob } from "../../core/assets";
import { strFromU8 } from "fflate";
import type { SlideChart, TableCell, TableNode } from "../../core/types";
import { t } from "../../i18n";
import { colName, exportXlsx, importXlsx } from "../formats/xlsx";
import { SurgeryUnavailable } from "./docx";
import { childNamed, childrenOf, rootOf, type XmlEl } from "./scan";
import { saveXlsxSurgical, xlsxMeta } from "./xlsx";
import { tablesOfSheet } from "./xlsxTables";
import { entryData, readZip } from "./zip";

/** Where the chart's data sits in its workbook: sheet (as the formulas name it), category column, first series column, header row. */
export interface ChartSheet {
  /** the sheet as written before "!" in the formulas (quoted when it needs to be) */
  sheet: string;
  /** 0-based columns */
  catCol: number;
  firstCol: number;
  /** 1-based row of the series names (the data starts one row under it) */
  headRow: number;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
const elText = (s: string, el: XmlEl) => s.slice(el.start, el.end);
const colNum = (c: string) => [...c.toUpperCase()].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const num = (v: number) => (Number.isFinite(v) ? String(v) : "0");

/** The chart's sheet layout from its first series' formulas (PowerPoint's default: Sheet1, A = categories, B… = series, row 1 = names). */
export function chartSheetOf(xml: string): ChartSheet | null {
  const ser = /<(?:\w+:)?ser>[\s\S]*?<\/(?:\w+:)?ser>/.exec(xml)?.[0] ?? "";
  const fOf = (tag: string) => {
    const el = new RegExp(`<(?:\\w+:)?${tag}>[\\s\\S]*?</(?:\\w+:)?${tag}>`).exec(ser)?.[0] ?? "";
    const f = /<(?:\w+:)?f>([^<]*)<\/(?:\w+:)?f>/.exec(el)?.[1];
    return f ? /^(.*)!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(f.replace(/&amp;/g, "&").replace(/&apos;/g, "'")) : null;
  };
  const val = fOf("val"), cat = fOf("cat");
  if (!val) return ser ? { sheet: "Sheet1", catCol: 0, firstCol: 1, headRow: 1 } : null;
  // series in rows (values across one row) are not PowerPoint's layout: not written
  if (val[4] && colNum(val[4]) !== colNum(val[2])) return null;
  const firstCol = colNum(val[2]);
  return { sheet: val[1], catCol: cat ? colNum(cat[2]) : Math.max(0, firstCol - 1), firstCol, headRow: Math.max(1, Number(val[3]) - 1) };
}

const cellRef = (sh: ChartSheet, col: number, row: number) => `${sh.sheet}!$${colName(col)}$${row}`;
const rangeRef = (sh: ChartSheet, col: number, r0: number, r1: number) => `${sh.sheet}!$${colName(col)}$${r0}:$${colName(col)}$${r1}`;

/** Children of `el` by local name, kept as text. */
function kids(s: string, el: XmlEl): { local: string; xml: string }[] {
  return childrenOf(s, el).map((c) => ({ local: c.local, xml: elText(s, c) }));
}

/** Series children each chart type takes before c:cat and after c:val (ECMA-376 §21.2.2: CT_BarSer, CT_LineSer, CT_PieSer, CT_AreaSer). */
const SER_BEFORE: Record<string, string[]> = {
  barChart: ["spPr", "invertIfNegative", "pictureOptions", "dPt", "dLbls", "trendline", "errBars"],
  lineChart: ["spPr", "marker", "dPt", "dLbls", "trendline", "errBars"],
  pieChart: ["spPr", "explosion", "dPt", "dLbls"],
  doughnutChart: ["spPr", "explosion", "dPt", "dLbls"],
  areaChart: ["spPr", "pictureOptions", "dPt", "dLbls", "trendline", "errBars"],
};
const SER_AFTER: Record<string, string[]> = { barChart: ["shape", "extLst"], lineChart: ["smooth", "extLst"], pieChart: ["extLst"], doughnutChart: ["extLst"], areaChart: ["extLst"] };

const elementOf = (kind: SlideChart["kind"]) => (kind === "col" || kind === "bar" ? "barChart" : kind === "line" ? "lineChart" : kind === "pie" ? "pieChart" : kind === "doughnut" ? "doughnutChart" : "areaChart");

/**
 * The chart part with `m`'s data: series names, categories and values as caches and formulas (PowerPoint's layout of
 * the embedded sheet), series added (copied from the last) or removed, the chart type changed between column, bar,
 * line and pie. Null when the part has no chart of a kind read here.
 */
export function chartPartWithData(xml: string, m: SlideChart): { xml: string; sheet: ChartSheet | null } | null {
  const root = rootOf(xml);
  const px = root.name.includes(":") ? root.name.slice(0, root.name.indexOf(":") + 1) : "";
  const chart = childNamed(xml, root, "chart");
  const plot = chart && childNamed(xml, chart, "plotArea");
  if (!plot) return null;
  const kindEl = childrenOf(xml, plot).find((c) => /^(bar|line|pie|doughnut|area)Chart$/.test(c.local));
  if (!kindEl) return null;
  const found = chartSheetOf(xml);
  // formulas in another layout keep PowerPoint's default one (the workbook is then not written)
  const sh = found ?? { sheet: "Sheet1", catCol: 0, firstCol: 1, headRow: 1 };
  const from = kindEl.local, to = elementOf(m.kind);
  const changed = from !== to;
  const n = m.categories.length;
  const kidsOf = kids(xml, kindEl);
  const oldSers = kidsOf.filter((k) => k.local === "ser").map((k) => k.xml);
  const numericCats = n > 0 && m.categories.every((c) => c.trim() !== "" && Number.isFinite(Number(c)));
  const firstCat = oldSers[0] ? /<(?:\w+:)?cat>[\s\S]*?<\/(?:\w+:)?cat>/.exec(oldSers[0])?.[0] ?? "" : "";
  const catIsNum = /numRef|numLit/.test(firstCat) && numericCats;
  const fmtOf = (ser: string) => /<(?:\w+:)?formatCode>([^<]*)<\/(?:\w+:)?formatCode>/.exec(/<(?:\w+:)?val>[\s\S]*?<\/(?:\w+:)?val>/.exec(ser)?.[0] ?? "")?.[1] ?? "General";
  const r0 = sh.headRow + 1, r1 = sh.headRow + Math.max(1, n);
  // c:idx / c:order: a series that was there keeps its own (automatic colours follow idx; PowerPoint leaves gaps when a
  // series is deleted), an added one takes the next past the largest kept — none repeated (QA)
  const kept = Math.min(oldSers.length, m.series.length);
  const numsOf = (tag: string) => {
    const own = oldSers.slice(0, kept).map((x) => Number(new RegExp(`<(?:\\w+:)?${tag} val="(\\d+)"`).exec(x)?.[1] ?? NaN));
    const ok = own.every(Number.isFinite) && new Set(own).size === own.length;
    const base = ok ? own : own.map((_, k) => k);
    const next = Math.max(-1, ...base) + 1;
    return (k: number) => (k < kept ? base[k] : next + k - kept);
  };
  const idxAt = numsOf("idx"), orderAt = numsOf("order");
  const strCache = (vals: string[]) => `<${px}strCache><${px}ptCount val="${vals.length}"/>${vals.map((v, i) => `<${px}pt idx="${i}"><${px}v>${esc(v)}</${px}v></${px}pt>`).join("")}</${px}strCache>`;
  const numCache = (vals: number[], fmt: string) => `<${px}numCache><${px}formatCode>${esc(fmt)}</${px}formatCode><${px}ptCount val="${vals.length}"/>${vals.map((v, i) => `<${px}pt idx="${i}"><${px}v>${num(v)}</${px}v></${px}pt>`).join("")}</${px}numCache>`;
  const sers = m.series.map((s, k) => {
    const base = oldSers[k] ?? oldSers[oldSers.length - 1] ?? `<${px}ser></${px}ser>`;
    const el = rootOf(base);
    const parts = kids(base, el);
    const fmt = fmtOf(base);
    // a copied series takes the next automatic colour (its own fill and id are the copied one's)
    const keep = (local: string) => parts.filter((p) => p.local === local && !(k >= oldSers.length && (p.local === "spPr" || p.local === "extLst" || p.local === "dPt" || p.local === "dLbls")) && !(changed && p.local !== "spPr") && !(changed && to === "pieChart" && p.local === "spPr")).map((p) => p.xml);
    const before = SER_BEFORE[to].flatMap(keep);
    const after = SER_AFTER[to].flatMap(keep);
    if (changed && to === "lineChart") before.push(`<${px}marker><${px}symbol val="none"/></${px}marker>`);
    if (changed && to === "lineChart") after.unshift(`<${px}smooth val="0"/>`);
    const tx = `<${px}tx><${px}strRef><${px}f>${esc(cellRef(sh, sh.firstCol + k, sh.headRow))}</${px}f>${strCache([s.name])}</${px}strRef></${px}tx>`;
    const cat = catIsNum
      ? `<${px}cat><${px}numRef><${px}f>${esc(rangeRef(sh, sh.catCol, r0, r1))}</${px}f>${numCache(m.categories.map(Number), "General")}</${px}numRef></${px}cat>`
      : `<${px}cat><${px}strRef><${px}f>${esc(rangeRef(sh, sh.catCol, r0, r1))}</${px}f>${strCache(m.categories)}</${px}strRef></${px}cat>`;
    const vals = Array.from({ length: n }, (_, i) => s.values[i] ?? 0);
    const val = `<${px}val><${px}numRef><${px}f>${esc(rangeRef(sh, sh.firstCol + k, r0, r1))}</${px}f>${numCache(vals, fmt)}</${px}numRef></${px}val>`;
    return `<${px}ser><${px}idx val="${idxAt(k)}"/><${px}order val="${orderAt(k)}"/>${tx}${before.join("")}${cat}${val}${after.join("")}</${px}ser>`;
  });
  // the chart type element: its own settings kept when the type stays, PowerPoint's defaults for a new one
  const axIds = kidsOf.filter((k) => k.local === "axId").map((k) => /val="([^"]*)"/.exec(k.xml)?.[1] ?? "");
  const plotKids = childrenOf(xml, plot);
  const axes = plotKids.filter((c) => /^(catAx|valAx|dateAx|serAx)$/.test(c.local));
  let ids = axIds.length >= 2 ? axIds : axes.map((a) => /<(?:\w+:)?axId val="([^"]*)"/.exec(elText(xml, a))?.[1] ?? "").filter(Boolean);
  let newAxes = "";
  if (to !== "pieChart" && to !== "doughnutChart" && ids.length < 2) {
    ids = ["500000001", "500000002"];
    newAxes =
      `<${px}catAx><${px}axId val="${ids[0]}"/><${px}scaling><${px}orientation val="minMax"/></${px}scaling><${px}delete val="0"/><${px}axPos val="${m.kind === "bar" ? "l" : "b"}"/><${px}numFmt formatCode="General" sourceLinked="1"/><${px}majorTickMark val="none"/><${px}minorTickMark val="none"/><${px}tickLblPos val="nextTo"/><${px}crossAx val="${ids[1]}"/><${px}crosses val="autoZero"/><${px}auto val="1"/><${px}lblAlgn val="ctr"/><${px}lblOffset val="100"/><${px}noMultiLvlLbl val="0"/></${px}catAx>` +
      `<${px}valAx><${px}axId val="${ids[1]}"/><${px}scaling><${px}orientation val="minMax"/></${px}scaling><${px}delete val="0"/><${px}axPos val="${m.kind === "bar" ? "b" : "l"}"/><${px}majorGridlines/><${px}numFmt formatCode="General" sourceLinked="1"/><${px}majorTickMark val="none"/><${px}minorTickMark val="none"/><${px}tickLblPos val="nextTo"/><${px}crossAx val="${ids[0]}"/><${px}crosses val="autoZero"/><${px}crossBetween val="between"/></${px}valAx>`;
  }
  const axIdXml = ids.slice(0, 2).map((v) => `<${px}axId val="${v}"/>`).join("");
  let kindXml: string;
  if (!changed) {
    const firstSer = kidsOf.findIndex((k) => k.local === "ser");
    const lastSer = kidsOf.length - 1 - [...kidsOf].reverse().findIndex((k) => k.local === "ser");
    let pre = kidsOf.slice(0, firstSer < 0 ? 0 : firstSer).map((k) => k.xml).join("");
    const post = kidsOf.slice(firstSer < 0 ? 0 : lastSer + 1).filter((k) => k.local !== "ser").map((k) => k.xml).join("");
    if (to === "barChart") pre = pre.replace(/(<(?:\w+:)?barDir val=")[^"]*(")/, `$1${m.kind === "bar" ? "bar" : "col"}$2`);
    kindXml = xml.slice(kindEl.start, kindEl.openEnd) + pre + sers.join("") + post + `</${kindEl.name}>`;
  } else if (to === "barChart") {
    kindXml = `<${px}barChart><${px}barDir val="${m.kind === "bar" ? "bar" : "col"}"/><${px}grouping val="clustered"/><${px}varyColors val="0"/>${sers.join("")}<${px}gapWidth val="${Math.round(m.gapWidth) || 219}"/><${px}overlap val="${Math.round(m.overlap)}"/>${axIdXml}</${px}barChart>`;
  } else if (to === "lineChart") {
    kindXml = `<${px}lineChart><${px}grouping val="standard"/><${px}varyColors val="0"/>${sers.join("")}<${px}marker val="1"/>${axIdXml}</${px}lineChart>`;
  } else if (to === "pieChart") {
    kindXml = `<${px}pieChart><${px}varyColors val="1"/>${sers.join("")}<${px}firstSliceAng val="0"/></${px}pieChart>`;
  } else return null;
  // the plot area: the chart type element replaced; axes dropped for a pie, made for a chart that had none
  let out = "";
  let at = plot.openEnd;
  out += xml.slice(0, plot.openEnd);
  for (const c of plotKids) {
    out += xml.slice(at, c.start);
    at = c.end;
    if (c.start === kindEl.start) out += kindXml + newAxes;
    else if ((to === "pieChart" || to === "doughnutChart") && /^(catAx|valAx|dateAx|serAx)$/.test(c.local)) continue;
    else if (changed && m.kind !== "pie" && /^(catAx|valAx)$/.test(c.local)) out += setAxPos(elText(xml, c), c.local === "catAx" ? (m.kind === "bar" ? "l" : "b") : m.kind === "bar" ? "b" : "l");
    else out += elText(xml, c);
  }
  out += xml.slice(at);
  return { xml: out, sheet: found };
}

const setAxPos = (ax: string, pos: string) => ax.replace(/(<(?:\w+:)?axPos val=")[^"]*(")/, `$1${pos}$2`);

/**
 * The embedded workbook with the chart's data in its sheet (`was`: the chart before, so cells it used and no longer
 * does are cleared). Written by the XLSX surgeon (cells, and an Excel table's columns renamed with their headers); when
 * that cannot, the workbook is written anew from its sheets with the new values. Null when the sheet is not in it.
 */
export function workbookWithData(bytes: Uint8Array, m: SlideChart, was: SlideChart | undefined, sh: ChartSheet): { bytes: Uint8Array; warnings: string[] } | null {
  let read: ReturnType<typeof importXlsx>;
  try {
    read = importXlsx(bytes, "chart.xlsx");
  } catch {
    return null;
  }
  const sheetName = sh.sheet.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
  const tables = read.pages.flatMap((p) => p.nodes).filter((n): n is TableNode => n.type === "TABLE" && n.name === sheetName);
  // a sheet split over pages (thousands of rows) is not a chart's: left as it is
  if (tables.length !== 1) return null;
  const tb = tables[0];
  // the map of the workbook as read (before the cells change: the surgeon writes the rows that differ from it)
  const meta = xlsxMeta(read.pages, read.sheets, { id: "chart-xlsx", hash: putBlob(bytes) });
  const set = (row: number, col: number, text: string) => {
    while (tb.rows.length <= row) tb.rows.push(tb.colWidths.map(() => ({ text: "" })));
    if (col >= tb.colWidths.length) {
      const add = col + 1 - tb.colWidths.length;
      tb.colWidths.push(...Array.from({ length: add }, () => 64));
      for (const r of tb.rows) r.push(...Array.from({ length: add }, (): TableCell => ({ text: "" })));
    }
    const c = tb.rows[row][col];
    if (c.text !== text) tb.rows[row][col] = { ...c, text, formula: undefined };
    if (tb.rows[row][col].formula === undefined) delete tb.rows[row][col].formula;
  };
  const h = sh.headRow - 1;
  const origHead = tb.rows[h]?.map((c) => ({ ...c }));
  // the cells the chart used before and no longer does
  if (was) {
    for (let i = 0; i <= was.categories.length; i++)
      for (let k = -1; k < was.series.length; k++) {
        const col = k < 0 ? sh.catCol : sh.firstCol + k;
        if ((i === 0 && k < 0) || (i <= m.categories.length && k < m.series.length)) continue;
        if (tb.rows[h + i]?.[col]) set(h + i, col, "");
      }
  }
  m.series.forEach((s, k) => set(h, sh.firstCol + k, s.name));
  m.categories.forEach((c, i) => {
    set(h + 1 + i, sh.catCol, c);
    m.series.forEach((s, k) => set(h + 1 + i, sh.firstCol + k, num(s.values[i] ?? 0)));
  });
  if (meta) {
    // QA: PowerPoint's chart workbooks hold their data in an Excel table, so a series name is a table header. The
    // surgeon renames the table's column with its header cell (officesurgeon/xlsxTables.ts, structured references too).
    // Two chart rules on top of Excel's: a header cleared (a series removed) inside a table keeps its column's name (the
    // column stays, the chart no longer uses it); a name repeated in a table (Excel would number it, the series name in
    // the chart would not follow) is written anew as before.
    const part = meta.parts.find((p) => p.tables?.[0] === sheetName)?.part;
    const z = part && origHead && tb.rows[h] ? readZip(bytes) : null;
    let repeated = false;
    if (z && part && origHead) {
      const readPart = (name: string) => {
        const e = z.entries.find((x) => x.name === name);
        return e ? strFromU8(entryData(z, e)) : null;
      };
      const row = [...tb.rows[h]];
      for (const tab of tablesOfSheet(readPart, part).filter((x) => x.header && x.r0 === h)) {
        for (let col = tab.c0; col <= tab.c1; col++) if (row[col] && origHead[col]?.text && !row[col].text.trim()) row[col] = origHead[col];
        const names = row.slice(tab.c0, tab.c1 + 1).map((c) => (c?.text ?? "").toLowerCase());
        repeated ||= new Set(names).size !== names.length;
      }
      if (!repeated) tb.rows[h] = row;
    }
    if (!repeated)
      try {
        const r = saveXlsxSurgical(read.pages, meta);
        return { bytes: r.unchanged ? bytes : r.bytes, warnings: [] };
      } catch (e) {
        if (!(e instanceof SurgeryUnavailable)) throw e;
      }
  }
  return { bytes: exportXlsx(read.pages), warnings: [t("slideLayout.chart.save.workbookAnew")] };
}
