// A slide chart written as PowerPoint's own chart (DrawingML c:chartSpace, ECMA-376 Part 1 §21.2) with its data in an
// embedded workbook — a chart inserted here (ui/chartEdit insertChart) opens in PowerPoint as a chart whose "데이터 편집"
// shows the same table. Column / bar, line, pie, area, doughnut, scatter and combo (columns + lines); series colours
// are written as they are drawn here (io/formats/pptxChart.ts), the text in the chart's font at its axis size.

import { newPage, newTable, type SlideChart } from "../../core/types";
import { esc } from "../xml";
import { colName, exportXlsx } from "./xlsx";

export const CT_CHART = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
export const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";

const SHEET = "Sheet1";
const hex = (c: string) => c.replace("#", "").slice(0, 6).toUpperCase();
const num = (v: number) => (Number.isFinite(v) ? String(v) : "0");

const strCache = (vals: string[]) => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("")}</c:strCache>`;
const numCache = (vals: number[]) => `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${num(v)}</c:v></c:pt>`).join("")}</c:numCache>`;

/** The colour series `k` is drawn in. */
const serColor = (m: SlideChart, k: number) => m.series[k]?.color ?? m.accents[k % 6] ?? "#4472C4";

function txPr(m: SlideChart, sz: number) {
  return `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}"><a:solidFill><a:srgbClr val="595959"/></a:solidFill><a:latin typeface="${esc(m.font)}"/><a:ea typeface="${esc(m.font)}"/></a:defRPr></a:pPr><a:endParaRPr lang="ko-KR"/></a:p></c:txPr>`;
}

const lineSp = (c: string, w = 28575) => `<c:spPr><a:ln w="${w}" cap="rnd"><a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill><a:round/></a:ln></c:spPr>`;
const fillSp = (c: string) => `<c:spPr><a:solidFill><a:srgbClr val="${hex(c)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
const gridSp = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>`;

/** One c:ser: name, categories and values pointing at the embedded sheet (column B, C … for series 0, 1 …). */
function serXml(m: SlideChart, k: number, idx: number, look: "bar" | "line" | "area" | "pie" | "scatter"): string {
  const s = m.series[k];
  const n = m.categories.length || s.values.length;
  const col = colName(k + 1);
  const tx = `<c:tx><c:strRef><c:f>${SHEET}!$${col}$1</c:f>${strCache([s.name])}</c:strRef></c:tx>`;
  const catRef = `${SHEET}!$A$2:$A$${n + 1}`, valRef = `${SHEET}!$${col}$2:$${col}$${n + 1}`;
  const cats = Array.from({ length: n }, (_, i) => m.categories[i] ?? String(i + 1));
  const vals = Array.from({ length: n }, (_, i) => s.values[i] ?? 0);
  const color = serColor(m, k);
  let sp = look === "line" || look === "scatter" ? lineSp(color) : fillSp(color);
  if (look === "scatter") sp = `<c:spPr><a:ln w="25400"><a:noFill/></a:ln></c:spPr>`;
  const head = `<c:ser><c:idx val="${idx}"/><c:order val="${idx}"/>${tx}`;
  if (look === "pie") {
    const pts = vals.map((_, i) => `<c:dPt><c:idx val="${i}"/><c:bubble3D val="0"/><c:spPr><a:solidFill><a:srgbClr val="${hex(m.accents[i % 6] ?? "#4472C4")}"/></a:solidFill><a:ln w="12700"><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:dPt>`).join("");
    return `${head}${pts}<c:cat><c:strRef><c:f>${catRef}</c:f>${strCache(cats)}</c:strRef></c:cat><c:val><c:numRef><c:f>${valRef}</c:f>${numCache(vals)}</c:numRef></c:val></c:ser>`;
  }
  if (look === "scatter") {
    const xs = cats.map((c, i) => (Number.isFinite(Number(c)) && c !== "" ? Number(c) : i + 1));
    const marker = `<c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`;
    return `${head}${sp}${marker}<c:xVal><c:numRef><c:f>${catRef}</c:f>${numCache(xs)}</c:numRef></c:xVal><c:yVal><c:numRef><c:f>${valRef}</c:f>${numCache(vals)}</c:numRef></c:yVal><c:smooth val="0"/></c:ser>`;
  }
  const marker = look === "line" ? `<c:marker><c:symbol val="none"/></c:marker>` : look === "bar" ? `<c:invertIfNegative val="0"/>` : "";
  return `${head}${sp}${marker}<c:cat><c:strRef><c:f>${catRef}</c:f>${strCache(cats)}</c:strRef></c:cat><c:val><c:numRef><c:f>${valRef}</c:f>${numCache(vals)}</c:numRef></c:val>${look === "line" ? `<c:smooth val="0"/>` : ""}</c:ser>`;
}

const AX_CAT = 111111111, AX_VAL = 222222222;

function axes(m: SlideChart, sz: number, scatter: boolean, horizontal: boolean): string {
  const tp = txPr(m, sz);
  const noLine = `<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>`;
  const catLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="D9D9D9"/></a:solidFill></a:ln></c:spPr>`;
  const valAx = (id: number, cross: number, pos: string, grid: boolean, line: boolean) =>
    `<c:valAx><c:axId val="${id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${pos}"/>${grid ? `<c:majorGridlines>${gridSp}</c:majorGridlines>` : ""}<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${line ? catLine : noLine}${tp}<c:crossAx val="${cross}"/><c:crosses val="autoZero"/><c:crossBetween val="${scatter ? "midCat" : "between"}"/></c:valAx>`;
  if (scatter) return valAx(AX_CAT, AX_VAL, "b", false, true) + valAx(AX_VAL, AX_CAT, "l", true, false);
  const catAx = `<c:catAx><c:axId val="${AX_CAT}"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>${catLine}${tp}<c:crossAx val="${AX_VAL}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  return catAx + valAx(AX_VAL, AX_CAT, horizontal ? "b" : "l", true, false);
}

/** The chart part (ppt/charts/chartN.xml) of a slide chart; `workbookRel` the relationship id of its embedded workbook. */
export function chartSpaceXml(m: SlideChart, workbookRel: string | null): string {
  const sz = m.axSz ?? 1197;
  const ids = `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/>`;
  const all = m.series.map((_, k) => k);
  const bar = (dir: "col" | "bar", ks: number[]) =>
    `<c:barChart><c:barDir val="${dir}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ks.map((k, i) => serXml(m, k, i, "bar")).join("")}<c:gapWidth val="${Math.round(m.gapWidth)}"/><c:overlap val="${Math.round(m.overlap)}"/>${ids}</c:barChart>`;
  const lineC = (ks: number[], from = 0) => `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ks.map((k, i) => serXml(m, k, from + i, "line")).join("")}<c:marker val="1"/>${ids}</c:lineChart>`;
  const areaC = (ks: number[], from = 0) => `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${ks.map((k, i) => serXml(m, k, from + i, "area")).join("")}${ids}</c:areaChart>`;
  let plot: string;
  let ax = true;
  switch (m.kind) {
    case "bar":
    case "col":
      plot = bar(m.kind, all);
      break;
    case "line":
      plot = lineC(all);
      break;
    case "area":
      plot = areaC(all);
      break;
    case "pie":
      plot = `<c:pieChart><c:varyColors val="1"/>${serXml(m, 0, 0, "pie")}<c:firstSliceAng val="0"/></c:pieChart>`;
      ax = false;
      break;
    case "doughnut":
      plot = `<c:doughnutChart><c:varyColors val="1"/>${serXml(m, 0, 0, "pie")}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
      ax = false;
      break;
    case "scatter":
      plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${all.map((k) => serXml(m, k, k, "scatter")).join("")}${ids}</c:scatterChart>`;
      break;
    default: {
      // combo: the columns first, then the lines / areas over them on the same axes
      const cols = all.filter((k) => !m.series[k].type), lines = all.filter((k) => m.series[k].type === "line"), areas = all.filter((k) => m.series[k].type === "area");
      plot = (areas.length ? areaC(areas, cols.length + lines.length) : "") + (cols.length ? bar("col", cols) : "") + (lines.length ? lineC(lines, cols.length) : "");
    }
  }
  const round = m.kind === "pie" || m.kind === "doughnut";
  const legend = m.series.length > 1 || round ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(m, sz)}</c:legend>` : "";
  const titleText = m.title === undefined ? null : m.title ?? (m.series.length === 1 ? m.series[0].name : "");
  const title =
    titleText !== null && titleText !== ""
      ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${Math.round(sz * 1.55)}" b="0"><a:solidFill><a:srgbClr val="595959"/></a:solidFill><a:latin typeface="${esc(m.font)}"/><a:ea typeface="${esc(m.font)}"/></a:defRPr></a:pPr><a:r><a:rPr lang="ko-KR" sz="${Math.round(sz * 1.55)}" b="0"><a:solidFill><a:srgbClr val="595959"/></a:solidFill><a:latin typeface="${esc(m.font)}"/><a:ea typeface="${esc(m.font)}"/></a:rPr><a:t>${esc(titleText)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
      : `<c:autoTitleDeleted val="1"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><c:chartSpace xmlns:c="${NS_C}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><c:date1904 val="0"/><c:lang val="ko-KR"/><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}${ax ? axes(m, sz, m.kind === "scatter", m.kind === "bar") : ""}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(m, sz)}${workbookRel ? `<c:externalData r:id="${workbookRel}"><c:autoUpdate val="0"/></c:externalData>` : ""}</c:chartSpace>`;
}

/** The chart's data as the workbook PowerPoint embeds for it: categories in column A, a column per series, names in row 1. */
export function chartWorkbook(m: SlideChart): Uint8Array {
  const n = Math.max(m.categories.length, ...m.series.map((s) => s.values.length));
  const rows: string[][] = [["", ...m.series.map((s) => s.name)]];
  for (let i = 0; i < n; i++) rows.push([m.categories[i] ?? String(i + 1), ...m.series.map((s) => (s.values[i] !== undefined ? num(s.values[i]) : ""))]);
  const t = newTable(rows, undefined, SHEET);
  const p = newPage("DOCUMENT", 800, 600, SHEET);
  p.nodes = [t];
  return exportXlsx([p]);
}

/** p:graphicFrame showing the chart part `rid` in the frame (EMU). */
export function chartFrameXml(id: number, name: string, rid: string, x: number, y: number, cx: number, cy: number): string {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></p:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}
