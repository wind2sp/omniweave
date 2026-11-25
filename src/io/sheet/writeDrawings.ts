// Charts made or changed here (삽입 ▸ 차트, 차트 디자인): the chart part (DrawingML chartSpace, ECMA-376 Part 1 §21.2)
// written from a chart spec — column / bar, line, pie, doughnut, scatter, area and combo charts with title, legend,
// axis titles and data labels, every series pointing at the sheet's cells with a cache of their values — and the
// sheet's drawing part that anchors it. A fresh workbook gets every chart of its sheets; the Office Surgeon adds the
// new ones to the sheet's drawing (or a new drawing) and rewrites a file chart's part only when its XML changed here.

import type { SheetChartSpec, SheetData, SheetDrawing } from "../../core/sheetTypes";
import { esc } from "../xml";
import { addr, colLetters, parseRange } from "./formula";
import { formatValue } from "./numfmt";
import type { SheetRels } from "./writeParts";
import { placeChildren } from "./writeParts";
import { childrenOf, rootOf } from "../officesurgeon/scan";

const xmlText = (s: string) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ""));
const EMU = 9525;
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
export const DRAWING_TYPE = "application/vnd.openxmlformats-officedocument.drawing+xml";

/** What writing a sheet's drawings needs from the package (a fresh zip or the Office Surgeon). */
export interface PkgRels extends SheetRels {
  /** the worksheet part */
  part: string;
  addRel(from: string, type: string, target: string): string;
  rels(from: string): { id: string; type: string; target: string }[];
  getPart(name: string): string | null;
  setPart(name: string, text: string, contentType?: string): void;
  /** a binary part (a picture) */
  setBytes(name: string, bytes: Uint8Array, contentType: string): void;
  freeName(pattern: (n: number) => string): string;
}

// ───── chart XML from a spec ─────

const quoteSheet = (n: string) => (/^[A-Za-z_][\w.]*$/.test(n) ? n : `'${n.replace(/'/g, "''")}'`);

interface Series {
  name: { ref: string; text: string } | null;
  cat: { ref: string; vals: string[]; num: boolean } | null;
  val: { ref: string; vals: (number | null)[]; fmt?: string };
}

/** The series of a chart range: the first row / column names the series, the first column / row holds categories. */
export function chartSeries(sh: SheetData, spec: Pick<SheetChartSpec, "ref" | "byRow">): Series[] {
  const g = parseRange(spec.ref);
  if (!g) return [];
  const q = quoteSheet(sh.name);
  const cell = (r: number, c: number) => sh.cells[addr(r, c)];
  const text = (r: number, c: number) => {
    const x = cell(r, c);
    if (!x || x.v === undefined) return "";
    return typeof x.v === "number" ? formatValue(x.v, sh.styles[x.s ?? 0]?.fmt, { date1904: sh.date1904, lang: sh.lang ?? "en" }).text : String(x.v);
  };
  const isNum = (r: number, c: number) => typeof cell(r, c)?.v === "number";
  // a header row / label column when the top-left corner is not a number (or the first row is text)
  const rows = g.r1 - g.r0 + 1, cols = g.c1 - g.c0 + 1;
  const headRow = rows > 1 && [...Array(cols).keys()].some((k) => !isNum(g.r0, g.c0 + k) && text(g.r0, g.c0 + k) !== "");
  const headCol = cols > 1 && [...Array(rows).keys()].slice(headRow ? 1 : 0).some((k) => !isNum(g.r0 + k, g.c0) && text(g.r0 + k, g.c0) !== "");
  const abs = (r0: number, c0: number, r1: number, c1: number) => `${q}!$${colLetters(c0)}$${r0 + 1}${r0 === r1 && c0 === c1 ? "" : `:$${colLetters(c1)}$${r1 + 1}`}`;
  const out: Series[] = [];
  const d0r = g.r0 + (headRow ? 1 : 0), d0c = g.c0 + (headCol ? 1 : 0);
  if (!spec.byRow) {
    for (let c = d0c; c <= g.c1; c++) {
      const vals: (number | null)[] = [];
      for (let r = d0r; r <= g.r1; r++) vals.push(isNum(r, c) ? (cell(r, c)!.v as number) : null);
      const catVals: string[] = [];
      for (let r = d0r; r <= g.r1; r++) catVals.push(headCol ? text(r, g.c0) : String(r - d0r + 1));
      out.push({
        name: headRow ? { ref: abs(g.r0, c, g.r0, c), text: text(g.r0, c) } : null,
        cat: headCol ? { ref: abs(d0r, g.c0, g.r1, g.c0), vals: catVals, num: [...Array(g.r1 - d0r + 1).keys()].every((k) => isNum(d0r + k, g.c0)) } : null,
        val: { ref: abs(d0r, c, g.r1, c), vals, fmt: sh.styles[cell(d0r, c)?.s ?? 0]?.fmt },
      });
    }
  } else {
    for (let r = d0r; r <= g.r1; r++) {
      const vals: (number | null)[] = [];
      for (let c = d0c; c <= g.c1; c++) vals.push(isNum(r, c) ? (cell(r, c)!.v as number) : null);
      const catVals: string[] = [];
      for (let c = d0c; c <= g.c1; c++) catVals.push(headRow ? text(g.r0, c) : String(c - d0c + 1));
      out.push({
        name: headCol ? { ref: abs(r, g.c0, r, g.c0), text: text(r, g.c0) } : null,
        cat: headRow ? { ref: abs(g.r0, d0c, g.r0, g.c1), vals: catVals, num: [...Array(g.c1 - d0c + 1).keys()].every((k) => isNum(g.r0, d0c + k)) } : null,
        val: { ref: abs(r, d0c, r, g.c1), vals, fmt: sh.styles[cell(r, d0c)?.s ?? 0]?.fmt },
      });
    }
  }
  return out;
}

const PALETTE = ["accent1", "accent2", "accent3", "accent4", "accent5", "accent6"];

function richTitle(text: string, size = 1400, bold = false) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${size}" b="${bold ? 1 : 0}"/></a:pPr><a:r><a:rPr lang="ko-KR" sz="${size}" b="${bold ? 1 : 0}"/><a:t>${xmlText(text)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;
}

function strCache(vals: string[]) {
  return `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlText(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
}
function numCache(vals: (number | null)[], fmt = "General") {
  return `<c:numCache><c:formatCode>${xmlText(fmt)}</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v == null ? "" : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join("")}</c:numCache>`;
}

function serXml(s: Series, i: number, kind: string, labels: boolean, scatter = false): string {
  const color = PALETTE[i % 6];
  const tx = s.name ? `<c:tx><c:strRef><c:f>${xmlText(s.name.ref)}</c:f>${strCache([s.name.text])}</c:strRef></c:tx>` : "";
  const line = kind === "line" || scatter;
  const sp = scatter
    ? `<c:spPr><a:ln w="25400" cap="rnd"><a:noFill/><a:round/></a:ln></c:spPr>`
    : line
    ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:schemeClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr>`
    : `<c:spPr><a:solidFill><a:schemeClr val="${color}"/></a:solidFill></c:spPr>`;
  const marker = kind === "line" ? `<c:marker><c:symbol val="none"/></c:marker>` : scatter ? `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:schemeClr val="${color}"/></a:solidFill></c:spPr></c:marker>` : "";
  const dl = labels ? `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>` : "";
  const cat = s.cat ? (s.cat.num ? `<c:numRef><c:f>${xmlText(s.cat.ref)}</c:f>${numCache(s.cat.vals.map(Number))}</c:numRef>` : `<c:strRef><c:f>${xmlText(s.cat.ref)}</c:f>${strCache(s.cat.vals)}</c:strRef>`) : "";
  const val = `<c:numRef><c:f>${xmlText(s.val.ref)}</c:f>${numCache(s.val.vals, s.val.fmt)}</c:numRef>`;
  const pie = kind === "pie" || kind === "doughnut";
  const points = pie ? s.val.vals.map((_, k) => `<c:dPt><c:idx val="${k}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:schemeClr val="${PALETTE[k % 6]}"/></a:solidFill><a:ln w="19050"><a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join("") : "";
  if (scatter) return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${sp}${marker}${dl}${cat ? `<c:xVal>${cat}</c:xVal>` : ""}<c:yVal>${val}</c:yVal><c:smooth val="0"/></c:ser>`;
  return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${pie ? "" : sp}${kind === "bar" ? '<c:invertIfNegative val="0"/>' : ""}${marker}${points}${dl}${cat ? `<c:cat>${cat}</c:cat>` : ""}<c:val>${val}</c:val>${kind === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
}

function axes(spec: SheetChartSpec, horizontal: boolean, valX = false) {
  const title = (t?: string) => (t ? richTitle(t, 1000) : "");
  const grid = `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill></a:ln></c:spPr></c:majorGridlines>`;
  const txPr = `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>`;
  const line = `<c:spPr><a:ln w="9525"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="25000"/><a:lumOff val="75000"/></a:schemeClr></a:solidFill></a:ln></c:spPr>`;
  const catPos = horizontal ? "l" : "b", valPos = horizontal ? "b" : "l";
  const cat = valX
    ? `<c:valAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${title(spec.xTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${line}${txPr}<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`
    : `<c:catAx><c:axId val="500000001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${catPos}"/>${title(spec.xTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${line}${txPr}<c:crossAx val="500000002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const val = `<c:valAx><c:axId val="500000002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${valPos}"/>${grid}${title(spec.yTitle)}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr}<c:crossAx val="500000001"/><c:crosses val="autoZero"/><c:crossBetween val="${valX ? "midCat" : "between"}"/></c:valAx>`;
  return cat + val;
}

/** The chart part XML (c:chartSpace) of a chart spec over `sh`'s cells. */
export function chartXml(sh: SheetData, spec: SheetChartSpec): string {
  const ss = chartSeries(sh, spec);
  const labels = !!spec.labels;
  const grouping = spec.grouping ?? "clustered";
  const ax = `<c:axId val="500000001"/><c:axId val="500000002"/>`;
  const bar = (dir: "col" | "bar", list: Series[], from = 0) =>
    `<c:barChart><c:barDir val="${dir}"/><c:grouping val="${grouping === "clustered" ? "clustered" : grouping}"/><c:varyColors val="0"/>${list.map((s, i) => serXml(s, i + from, "bar", labels)).join("")}<c:gapWidth val="${grouping === "clustered" ? 219 : 150}"/>${grouping === "clustered" ? '<c:overlap val="-27"/>' : '<c:overlap val="100"/>'}${ax}</c:barChart>`;
  const lineChart = (list: Series[], from = 0) => `<c:lineChart><c:grouping val="${spec.type === "line" && grouping !== "clustered" ? grouping : "standard"}"/><c:varyColors val="0"/>${list.map((s, i) => serXml(s, i + from, "line", labels)).join("")}<c:marker val="1"/>${ax}</c:lineChart>`;
  let plot = "";
  let axXml = "";
  switch (spec.type) {
    case "bar":
      plot = bar("bar", ss);
      axXml = axes(spec, true);
      break;
    case "line":
      plot = lineChart(ss);
      axXml = axes(spec, false);
      break;
    case "area":
      plot = `<c:areaChart><c:grouping val="${grouping === "clustered" ? "standard" : grouping}"/><c:varyColors val="0"/>${ss.map((s, i) => serXml(s, i, "area", labels)).join("")}${ax}</c:areaChart>`;
      axXml = axes(spec, false);
      break;
    case "pie":
      plot = `<c:pieChart><c:varyColors val="1"/>${ss.slice(0, 1).map((s, i) => serXml(s, i, "pie", labels)).join("")}<c:firstSliceAng val="0"/></c:pieChart>`;
      break;
    case "doughnut":
      plot = `<c:doughnutChart><c:varyColors val="1"/>${ss.map((s, i) => serXml(s, i, "doughnut", labels)).join("")}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
      break;
    case "scatter":
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ss.map((s, i) => serXml({ ...s, cat: s.cat && { ...s.cat, num: true } }, i, "scatter", labels, true)).join("")}${ax}</c:scatterChart>`;
      axXml = axes(spec, false, true);
      break;
    case "combo":
      plot = bar("col", ss.slice(0, 1)) + lineChart(ss.slice(1), 1);
      axXml = axes(spec, false);
      break;
    default:
      plot = bar("col", ss);
      axXml = axes(spec, false);
  }
  const legendPos = spec.legend ?? (spec.type === "pie" || spec.type === "doughnut" || ss.length > 1 ? "b" : "none");
  const legend = legendPos === "none" ? "" : `<c:legend><c:legendPos val="${legendPos}"/><c:overlay val="0"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="900"/></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr></c:legend>`;
  const title = spec.title ? richTitle(spec.title, 1400) + '<c:autoTitleDeleted val="0"/>' : '<c:autoTitleDeleted val="1"/>';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">` +
    `<c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${axXml}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="15000"/><a:lumOff val="85000"/></a:schemeClr></a:solidFill><a:round/></a:ln></c:spPr>` +
    `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr/></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr><c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings></c:chartSpace>`
  );
}

// ───── the drawing part ─────

/** A drawing's size in px (its w / h, or the cells its two-cell anchor spans). */
function drawingSize(d: SheetDrawing, sh: SheetData): { w: number; h: number } {
  const a = d.at;
  if (a.c1 == null) return { w: a.w ?? 0, h: a.h ?? 0 };
  const cw = (c: number) => (sh.hiddenCols?.includes(c) ? 0 : sh.colW[c] ?? sh.defColW);
  const rh = (r: number) => (sh.hiddenRows?.includes(r) ? 0 : sh.rowH[r] ?? sh.defRowH);
  let w = -a.x0 + (a.x1 ?? 0), h = -a.y0 + (a.y1 ?? 0);
  for (let c = a.c0; c < a.c1; c++) w += cw(c);
  for (let r = a.r0; r < (a.r1 ?? a.r0); r++) h += rh(r);
  return { w, h };
}

/** <from> and <to> of a drawing's place (a size in px ends in the cell it reaches). */
function fromTo(d: SheetDrawing, sh: SheetData, px = "xdr:"): string {
  const a = d.at;
  const emu = (v: number) => Math.round(v * EMU);
  let to = { c: a.c1 ?? a.c0, x: a.x1 ?? 0, r: a.r1 ?? a.r0, y: a.y1 ?? 0 };
  if (a.c1 == null && a.w != null) {
    const cw = (c: number) => (sh.hiddenCols?.includes(c) ? 0 : sh.colW[c] ?? sh.defColW);
    const rh = (r: number) => (sh.hiddenRows?.includes(r) ? 0 : sh.rowH[r] ?? sh.defRowH);
    let c = a.c0, x = a.x0 + a.w;
    while (x > cw(c) && c < 16383) x -= cw(c++);
    let r = a.r0, y = a.y0 + (a.h ?? 0);
    while (y > rh(r) && r < 1048575) y -= rh(r++);
    to = { c, x, r, y };
  }
  const m = (n: string, c: number, x: number, r: number, y: number) => `<${px}${n}><${px}col>${c}</${px}col><${px}colOff>${emu(x)}</${px}colOff><${px}row>${r}</${px}row><${px}rowOff>${emu(y)}</${px}rowOff></${px}${n}>`;
  return m("from", a.c0, a.x0, a.r0, a.y0) + m("to", to.c, to.x, to.r, to.y);
}

/**
 * The drawing part with its file charts moved / sized / deleted here: each changed anchor becomes a two-cell anchor
 * at the new place (its graphic frame kept as it was); a deleted one goes.
 */
function moveFileCharts(dx: string, sh: SheetData, o: SheetData): string {
  // per anchor of the file: gone whole, members gone from its group, or moved / sized
  const byAnchor = new Map<number, { was: SheetDrawing[]; now: SheetDrawing[] }>();
  for (const od of o.drawings ?? []) if (od.anchorIx != null) (byAnchor.get(od.anchorIx) ?? byAnchor.set(od.anchorIx, { was: [], now: [] }).get(od.anchorIx)!).was.push(od);
  for (const nd of sh.drawings ?? []) if (nd.anchorIx != null && byAnchor.has(nd.anchorIx)) byAnchor.get(nd.anchorIx)!.now.push(nd);
  const key = (d: SheetDrawing) => (d.grpPath ?? []).join(".");
  const edits = new Map<number, { del: boolean; gone: number[][]; at: SheetDrawing | null }>();
  for (const [ix, { was, now }] of byAnchor) {
    if (!now.length) {
      edits.set(ix, { del: true, gone: [], at: null });
      continue;
    }
    const keep = new Set(now.map(key));
    const gone = was.filter((d) => d.grpPath && !keep.has(key(d))).map((d) => d.grpPath!);
    const moved = JSON.stringify(now[0].at) !== JSON.stringify(was[0].at) ? now[0] : null;
    if (gone.length || moved) edits.set(ix, { del: false, gone, at: moved });
  }
  if (!edits.size) return dx;
  const root = rootOf(dx);
  const anchors = childrenOf(dx, root).filter((k) => /^(twoCellAnchor|oneCellAnchor|absoluteAnchor)$/.test(k.local));
  let out = dx;
  for (let i = anchors.length - 1; i >= 0; i--) {
    const e = edits.get(i);
    if (!e) continue;
    const el = anchors[i];
    let text = out.slice(el.start, el.end);
    if (e.del) text = "";
    else {
      // members taken out of the group (deepest, last first so earlier indexes stay right)
      for (const path of [...e.gone].sort((a, b) => b.join(".").localeCompare(a.join(".")))) text = dropMember(text, path);
      if (e.at) {
        const a0 = rootOf(text);
        const px = a0.name.includes(":") ? a0.name.slice(0, a0.name.indexOf(":") + 1) : "";
        const keep = childrenOf(text, a0).filter((k) => !/^(from|to|ext|pos)$/.test(k.local)).map((k) => text.slice(k.start, k.end)).join("");
        text = `<${px}twoCellAnchor editAs="oneCell">${fromTo(e.at, sh, px)}${keep}</${px}twoCellAnchor>`;
      }
    }
    out = out.slice(0, el.start) + text + out.slice(el.end);
  }
  return out;
}

/** An anchor's XML with the group member at `path` (child index of drawable children at each level) removed. */
function dropMember(anchor: string, path: number[]): string {
  const drawable = /^(sp|pic|graphicFrame|grpSp|cxnSp)$/;
  let el = childrenOf(anchor, rootOf(anchor)).find((k) => drawable.test(k.local));
  for (let lv = 0; el && lv < path.length; lv++) {
    if (el.local !== "grpSp") return anchor;
    const kids = childrenOf(anchor, el).filter((k) => drawable.test(k.local));
    const next = kids[path[lv]];
    if (!next) return anchor;
    if (lv === path.length - 1) return anchor.slice(0, next.start) + anchor.slice(next.end);
    el = next;
  }
  return anchor;
}

function anchorXml(d: SheetDrawing, id: number, rid: string, sh: SheetData): string {
  const a = d.at;
  const emu = (px: number) => Math.round(px * EMU);
  let to = { c: a.c1 ?? a.c0, x: a.x1 ?? 0, r: a.r1 ?? a.r0, y: a.y1 ?? 0 };
  if (a.c1 == null && a.w != null) {
    // a size in px: the cell it ends in
    const cw = (c: number) => (sh.hiddenCols?.includes(c) ? 0 : sh.colW[c] ?? sh.defColW);
    const rh = (r: number) => (sh.hiddenRows?.includes(r) ? 0 : sh.rowH[r] ?? sh.defRowH);
    let c = a.c0, x = a.x0 + a.w;
    while (x > cw(c) && c < 16383) x -= cw(c++);
    let r = a.r0, y = a.y0 + (a.h ?? 0);
    while (y > rh(r) && r < 1048575) y -= rh(r++);
    to = { c, x, r, y };
  }
  return (
    `<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>${a.c0}</xdr:col><xdr:colOff>${emu(a.x0)}</xdr:colOff><xdr:row>${a.r0}</xdr:row><xdr:rowOff>${emu(a.y0)}</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>${to.c}</xdr:col><xdr:colOff>${emu(to.x)}</xdr:colOff><xdr:row>${to.r}</xdr:row><xdr:rowOff>${emu(to.y)}</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${id}" name="${xmlText(d.name ?? `Chart ${id - 1}`)}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
  );
}

const DRAWING_HEAD = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}">`;

/**
 * The worksheet XML with its charts written: charts made here (no part yet) are added to the sheet's drawing (made when
 * the sheet has none); a file chart whose XML changed here gets its part rewritten.
 */
export function writeSheetDrawings(xml: string, sh: SheetData, o: SheetData | null, pkg: PkgRels): string {
  const charts = (sh.drawings ?? []).filter((d) => d.kind === "chart" && d.chart);
  // file charts edited here
  for (const d of charts) {
    if (!d.part || !o) continue;
    const was = o.drawings?.find((x) => x.part === d.part);
    if (was && was.chart !== d.chart) pkg.setPart(d.part, d.chart!, CHART_TYPE);
  }
  // file charts moved, sized or deleted here
  if (o) {
    const r0 = pkg.rels(pkg.part).find((r) => r.type === "drawing");
    const x0 = r0 ? pkg.getPart(r0.target) : null;
    if (r0 && x0) {
      const moved = moveFileCharts(x0, sh, o);
      if (moved !== x0) pkg.setPart(r0.target, moved, DRAWING_TYPE);
    }
  }
  // fresh workbook: every chart is new; surgery: the ones without a part
  const added = charts.filter((d) => !o || !d.part);
  // pictures put in here (삽입 ▸ 그림): not of the file's drawing part (no anchorIx)
  const pics = (sh.drawings ?? []).filter((d) => d.kind === "pic" && d.data && d.anchorIx == null && (!o || !o.drawings?.includes(d)));
  if (!added.length && !pics.length) return xml;
  const rel = pkg.rels(pkg.part).find((r) => r.type === "drawing");
  let dPath = rel?.target ?? null;
  let dx = dPath ? pkg.getPart(dPath) : null;
  if (!dx || !dPath) {
    dPath = pkg.freeName((n) => `xl/drawings/drawing${n}.xml`);
    dx = DRAWING_HEAD + "</xdr:wsDr>";
    const id = pkg.addRel(pkg.part, `${REL}/drawing`, dPath);
    const r = /^<(\w+:)?worksheet\b/.exec(xml.replace(/^<\?xml[^>]*\?>\s*/, ""));
    const px = r?.[1] ?? "";
    if (!/xmlns:r=/.test(xml.slice(0, 800))) xml = xml.replace(/<((?:\w+:)?worksheet)\b/, `<$1 xmlns:r="${REL}"`);
    xml = placeChildren(xml, "drawing", [`<${px}drawing r:id="${id}"/>`]);
  }
  const dpx = /<(\w+:)?wsDr\b/.exec(dx)?.[1] ?? "xdr:";
  let nextId = Math.max(1, ...[...dx.matchAll(/<(?:\w+:)?cNvPr\b[^>]*\sid="(\d+)"/g)].map((m) => Number(m[1]))) + 1;
  let anchors = "";
  for (const d of added) {
    const cPath = pkg.freeName((n) => `xl/charts/chart${n}.xml`);
    // a chart made here is written from its spec (its cached values as the cells are now); a file chart going into a
    // fresh package loses the links to parts it no longer has (embedded data, user shapes)
    const cx = d.spec ? chartXml(sh, d.spec) : d.chart!.replace(/<(\w+:)?externalData\b[^>]*(\/>|>[\s\S]*?<\/\1externalData>)/g, "").replace(/<(\w+:)?userShapes\b[^>]*\/>/g, "");
    pkg.setPart(cPath, cx, CHART_TYPE);
    const rid = pkg.addRel(dPath, `${REL}/chart`, cPath);
    let a = anchorXml(d, nextId++, rid, sh);
    if (dpx !== "xdr:") a = a.replace(/<(\/?)xdr:/g, `<$1${dpx}`);
    anchors += a;
  }
  for (const d of pics) {
    const ext = /png/.test(d.mime ?? "") ? "png" : /gif/.test(d.mime ?? "") ? "gif" : "jpeg";
    const mPath = pkg.freeName((n) => `xl/media/image${n}.${ext}`);
    pkg.setBytes(mPath, d.data!, `image/${ext}`);
    const rid = pkg.addRel(dPath, `${REL}/image`, mPath);
    const id = nextId++;
    const box = drawingSize(d, sh);
    let a =
      `<xdr:twoCellAnchor editAs="oneCell">${fromTo(d, sh)}<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${id}" name="${esc(d.name ?? `Picture ${id - 1}`)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
      `<xdr:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(box.w * EMU)}" cy="${Math.round(box.h * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
    if (dpx !== "xdr:") a = a.replace(/<(\/?)xdr:/g, `<$1${dpx}`);
    anchors += a;
  }
  if (!/xmlns:a=/.test(dx.slice(0, 1200))) dx = dx.replace(/<((?:\w+:)?wsDr)\b/, `<$1 xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"`);
  if (!/xmlns:r=/.test(dx.slice(0, 1200))) dx = dx.replace(/<((?:\w+:)?wsDr)\b/, `<$1 xmlns:r="${REL}"`);
  dx = /<\/(?:\w+:)?wsDr>\s*$/.test(dx) ? dx.replace(/<\/((?:\w+:)?wsDr)>\s*$/, `${anchors}</$1>`) : dx.replace(/\/>\s*$/, `>${anchors}</${dpx}wsDr>`);
  pkg.setPart(dPath, dx, DRAWING_TYPE);
  return xml;
}

// ───── a fresh package's relationships ─────

/** Relationships and parts of one worksheet of a fresh workbook (zip entries written on flush). */
export class FreshRels implements PkgRels {
  private relsBy = new Map<string, { id: string; type: string; target: string; external?: boolean }[]>();
  constructor(
    public part: string,
    private files: Record<string, unknown>,
    private over: string[],
  ) {}
  private list(from: string) {
    let l = this.relsBy.get(from);
    if (!l) this.relsBy.set(from, (l = []));
    return l;
  }
  addRel(from: string, type: string, target: string): string {
    const l = this.list(from);
    const id = `rId${l.length + 1}`;
    l.push({ id, type, target });
    return id;
  }
  rels(from: string) {
    return this.list(from).map((r) => ({ ...r, type: r.type.replace(/^.*\//, "") }));
  }
  link(url: string): string {
    const l = this.list(this.part);
    const id = `rId${l.length + 1}`;
    l.push({ id, type: `${REL}/hyperlink`, target: url, external: true });
    return id;
  }
  dropLinks() {}
  getPart(name: string): string | null {
    const v = this.files[name];
    return v instanceof Uint8Array ? new TextDecoder().decode(v) : null;
  }
  setPart(name: string, text: string, contentType?: string) {
    this.files[name] = new TextEncoder().encode(text);
    if (contentType && !this.over.some((o) => o.includes(`"/${name}"`))) this.over.push(`<Override PartName="/${name}" ContentType="${contentType}"/>`);
  }
  setBytes(name: string, bytes: Uint8Array, contentType: string) {
    this.files[name] = bytes;
    if (!this.over.some((o) => o.includes(`"/${name}"`))) this.over.push(`<Override PartName="/${name}" ContentType="${contentType}"/>`);
  }
  freeName(pattern: (n: number) => string): string {
    for (let n = 1; ; n++) if (!(pattern(n) in this.files)) return pattern(n);
  }
  flush() {
    for (const [from, l] of this.relsBy) {
      if (!l.length) continue;
      const dir = from.split("/").slice(0, -1);
      const rel = (t: string) => {
        const tp = t.split("/");
        let k = 0;
        while (k < dir.length && dir[k] === tp[k]) k++;
        return [...dir.slice(k).map(() => ".."), ...tp.slice(k)].join("/");
      };
      const body = l.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${xmlText(r.external ? r.target : rel(r.target))}"${r.external ? ' TargetMode="External"' : ""}/>`).join("");
      this.files[from.replace(/([^/]+)$/, "_rels/$1.rels")] = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
    }
  }
}
