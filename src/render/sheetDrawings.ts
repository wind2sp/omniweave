// Drawings over the sheet grid (시트 위 그림·차트·도형): pictures, shapes and text boxes painted here; charts by
// render/sheetChart.ts, loaded the first time a sheet with a chart is painted (the grid repaints when it arrives —
// `onDrawingReady`). Positions follow the cells they are anchored to (column widths, row heights, hidden lines, zoom).

import type { SheetData, SheetDrawing } from "../core/sheetTypes";
import { addr, parseRange } from "../io/sheet/formula";
import { printExtentHooks } from "../io/sheet/printLayout";
import type { SheetLang } from "../io/sheet/numfmt";
import { geomOf } from "./sheet";
import { decodePicture } from "./picDecode";

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type ChartMod = typeof import("./sheetChart");

let chartMod: ChartMod | null = null;
let chartLoad: Promise<void> | null = null;
const waiters = new Set<() => void>();
const ready = () => {
  for (const f of [...waiters]) f();
};
/** Call `f` when a chart painter or a picture becomes ready (repaint). Returns the unsubscribe. */
export function onDrawingReady(f: () => void): () => void {
  waiters.add(f);
  return () => void waiters.delete(f);
}
/** Load the chart painter (charts are painted from then on). */
export function loadSheetCharts(): Promise<void> {
  return (chartLoad ??= import("./sheetChart").then((m) => {
    chartMod = m;
    ready();
  }));
}

const pics = new WeakMap<Uint8Array, CanvasImageSource | "loading" | "bad">();
function picOf(d: SheetDrawing): CanvasImageSource | null {
  const data = d.data!;
  const got = pics.get(data);
  if (got && got !== "loading" && got !== "bad") return got;
  if (!got && typeof createImageBitmap === "function" && typeof Blob !== "undefined") {
    pics.set(data, "loading");
    decodePicture(data, d.mime ?? "image/png")
      .then((b) => {
        pics.set(data, b);
        ready();
      })
      .catch(() => pics.set(data, "bad"));
  }
  return null;
}
/** Decode every picture of the sheets now (prints, measurements: so a synchronous paint has them). */
export async function preloadDrawings(sheets: SheetData[]): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  for (const sh of sheets)
    for (const d of sh.drawings ?? []) {
      if (d.kind === "chart") jobs.push(loadSheetCharts());
      else if (d.kind === "pic" && d.data && !pics.has(d.data) && typeof createImageBitmap === "function")
        jobs.push(
          decodePicture(d.data, d.mime ?? "image/png").then(
            (b) => pics.set(d.data!, b),
            () => pics.set(d.data!, "bad"),
          ),
        );
    }
  await Promise.all(jobs);
}

/** The drawing's box in sheet px (100 %). */
export function drawingBox(sh: SheetData, d: SheetDrawing): { x: number; y: number; w: number; h: number } {
  const g = geomOf(sh);
  const a = d.at;
  const x = g.cols.pos(a.c0) + Math.min(a.x0, Math.max(a.x0, 0));
  const y = g.rows.pos(a.r0) + a.y0;
  const x2 = a.c1 != null ? g.cols.pos(a.c1) + Math.min(a.x1 ?? 0, g.cols.size(a.c1)) : x + (a.w ?? 0);
  const y2 = a.r1 != null ? g.rows.pos(a.r1) + Math.min(a.y1 ?? 0, g.rows.size(a.r1)) : y + (a.h ?? 0);
  let box = { x, y, w: Math.max(0, x2 - x), h: Math.max(0, y2 - y) };
  if (d.box) box = { x: box.x + d.box[0] * box.w, y: box.y + d.box[1] * box.h, w: d.box[2] * box.w, h: d.box[3] * box.h };
  return box;
}

// a sheet with drawings prints down / across to them (Excel's print range includes them)
printExtentHooks.push((sh) => {
  if (!sh.drawings?.length) return null;
  const g = geomOf(sh);
  let r1 = -1, c1 = -1;
  for (const d of sh.drawings) {
    const b = drawingBox(sh, d);
    r1 = Math.max(r1, g.rows.at(Math.max(0, b.y + b.h - 1)));
    c1 = Math.max(c1, g.cols.at(Math.max(0, b.x + b.w - 1)));
  }
  return { r1, c1 };
});

/** Values of a reference (Sheet1!$B$2:$B$9, 'My sheet'!A1:A5, or a defined name such as chartex's _xlchart.v1.0) from the book's cells. */
export function liveRef(sheets: SheetData[], own: SheetData): (ref: string) => ((number | string | null)[] & { cols?: number }) | null {
  return (ref0) => {
    const ref = (own.names?.[ref0.trim()] ?? ref0).trim().replace(/^=/, "");
    const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(.+)$/.exec(ref.trim().replace(/^\(|\)$/g, ""));
    const name = m ? (m[1] ?? m[2]).replace(/''/g, "'") : own.name;
    const sh = sheets.find((s) => s.name === name);
    const g = parseRange((m ? m[3] : ref).replace(/\$/g, ""));
    if (!sh || !g || (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) > 100000) return null;
    const out: (number | string | null)[] & { cols?: number } = [];
    out.cols = g.c1 - g.c0 + 1;
    for (let r = g.r0; r <= g.r1; r++)
      for (let c = g.c0; c <= g.c1; c++) {
        const cell = sh.cells[addr(r, c)];
        const v = cell?.v;
        out.push(v === undefined || v === "" ? null : typeof v === "boolean" ? (v ? 1 : 0) : (v as number | string));
      }
    return out;
  };
}

function geomPath(ctx: Ctx, geom: string, w: number, h: number) {
  ctx.beginPath();
  const tri = (pts: [number, number][]) => {
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px * w, py * h) : ctx.moveTo(px * w, py * h)));
    ctx.closePath();
  };
  switch (geom) {
    case "ellipse":
    case "flowChartConnector":
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      break;
    case "roundRect":
    case "flowChartAlternateProcess": {
      const r = Math.min(w, h) * 0.1667;
      ctx.moveTo(r, 0);
      ctx.arcTo(w, 0, w, h, r);
      ctx.arcTo(w, h, 0, h, r);
      ctx.arcTo(0, h, 0, 0, r);
      ctx.arcTo(0, 0, w, 0, r);
      ctx.closePath();
      break;
    }
    case "triangle":
    case "flowChartExtract":
      tri([[0.5, 0], [1, 1], [0, 1]]);
      break;
    case "rtTriangle":
      tri([[0, 0], [1, 1], [0, 1]]);
      break;
    case "diamond":
    case "flowChartDecision":
      tri([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]);
      break;
    case "parallelogram":
    case "flowChartInputOutput":
      tri([[0.25, 0], [1, 0], [0.75, 1], [0, 1]]);
      break;
    case "trapezoid":
      tri([[0.25, 0], [0.75, 0], [1, 1], [0, 1]]);
      break;
    case "pentagon":
    case "homePlate":
      tri([[0, 0], [0.8, 0], [1, 0.5], [0.8, 1], [0, 1]]);
      break;
    case "hexagon":
      tri([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]);
      break;
    case "octagon":
      tri([[0.29, 0], [0.71, 0], [1, 0.29], [1, 0.71], [0.71, 1], [0.29, 1], [0, 0.71], [0, 0.29]]);
      break;
    case "rightArrow":
      tri([[0, 0.25], [0.75, 0.25], [0.75, 0], [1, 0.5], [0.75, 1], [0.75, 0.75], [0, 0.75]]);
      break;
    case "leftArrow":
      tri([[1, 0.25], [0.25, 0.25], [0.25, 0], [0, 0.5], [0.25, 1], [0.25, 0.75], [1, 0.75]]);
      break;
    case "upArrow":
      tri([[0.25, 1], [0.25, 0.25], [0, 0.25], [0.5, 0], [1, 0.25], [0.75, 0.25], [0.75, 1]]);
      break;
    case "downArrow":
      tri([[0.25, 0], [0.25, 0.75], [0, 0.75], [0.5, 1], [1, 0.75], [0.75, 0.75], [0.75, 0]]);
      break;
    case "star5": {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 0.38 : 1;
        const px = w / 2 + (r * w * Math.cos(a)) / 2, py = h / 2 + (r * h * Math.sin(a)) / 2 + h * 0.05;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.closePath();
      break;
    }
    case "line":
    case "straightConnector1":
      ctx.moveTo(0, 0);
      ctx.lineTo(w, h);
      break;
    default:
      ctx.rect(0, 0, w, h);
  }
}

function wrap(ctx: Ctx, s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split("\n")) {
    let line = "";
    for (const ch of para.match(/\s+|[^\s]+/g) ?? [""]) {
      const tryLine = line + ch;
      if (line && ctx.measureText(tryLine).width > width) {
        // a long word breaks by characters (Korean text has no spaces to break at)
        out.push(line.trimEnd());
        line = ch.trimStart();
      } else line = tryLine;
      while (ctx.measureText(line).width > width && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && ctx.measureText(line.slice(0, k)).width > width) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line);
  }
  return out;
}

function paintShape(ctx: Ctx, d: SheetDrawing, w: number, h: number, z: number, font: string) {
  geomPath(ctx, d.geom ?? "rect", w, h);
  if (d.fill) {
    ctx.fillStyle = d.fill;
    ctx.fill();
  }
  if (d.line) {
    ctx.strokeStyle = d.line;
    ctx.lineWidth = (d.lineW ?? 1) * z;
    ctx.stroke();
  }
  if (!d.paras?.some((p) => p.text)) return;
  // the text rectangle of the geometry (an ellipse keeps its text inside the curve), then the insets
  const k = d.geom === "ellipse" ? 0.146 : d.geom === "roundRect" ? 0.049 : 0;
  const [li, ti, ri, bi] = (d.inset ?? [9.6, 4.8, 9.6, 4.8]).map((v, i) => v * z + (i % 2 ? h : w) * k);
  const tw = Math.max(4, w - li - ri);
  const lines: { s: string; p: (typeof d.paras)[number]; size: number }[] = [];
  for (const p of d.paras) {
    const size = (((p.size ?? 11) * 96) / 72) * z;
    ctx.font = `${p.italic ? "italic " : ""}${p.bold ? "bold " : ""}${size}px "${font}", "맑은 고딕", sans-serif`; // i18n: keep — font name
    for (const s of wrap(ctx, p.text, tw)) lines.push({ s, p, size });
  }
  const lh = (l: { size: number }) => l.size * 1.7; // Malgun Gothic at DrawingML single spacing, as Excel lays out shape text
  const total = lines.reduce((a, l) => a + lh(l), 0);
  let y = d.anchor === "ctr" ? (h - total) / 2 : d.anchor === "b" ? h - bi - total : ti;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  ctx.clip();
  ctx.textBaseline = "middle";
  for (const l of lines) {
    ctx.font = `${l.p.italic ? "italic " : ""}${l.p.bold ? "bold " : ""}${l.size}px "${font}", "맑은 고딕", sans-serif`; // i18n: keep — font name
    ctx.fillStyle = l.p.color ?? "#000000";
    const al = l.p.align ?? "l";
    ctx.textAlign = al === "ctr" ? "center" : al === "r" ? "right" : "left";
    ctx.fillText(l.s, al === "ctr" ? li + tw / 2 : al === "r" ? w - ri : li, y + lh(l) / 2);
    y += lh(l);
  }
  ctx.restore();
}

export interface DrawingPaneMap {
  /** sheet px → screen px */
  x: (sx: number) => number;
  y: (sy: number) => number;
  clip: { x: number; y: number; w: number; h: number };
}

/** Paint the drawings of a sheet through each pane's mapping (frozen panes clip what is not theirs). */
export function paintDrawings(ctx: Ctx, sh: SheetData, z: number, panes: DrawingPaneMap[], opt: { lang: SheetLang; sheets?: SheetData[] }) {
  const ds = sh.drawings;
  if (!ds?.length) return;
  if (!chartMod && ds.some((d) => d.kind === "chart")) void loadSheetCharts();
  const live = liveRef(opt.sheets ?? [sh], sh);
  for (const pane of panes) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(pane.clip.x, pane.clip.y, pane.clip.w, pane.clip.h);
    ctx.clip();
    for (const d of ds) {
      const b = drawingBox(sh, d);
      const x = pane.x(b.x), y = pane.y(b.y), w = b.w * z, h = b.h * z;
      if (x > pane.clip.x + pane.clip.w || y > pane.clip.y + pane.clip.h || x + w < pane.clip.x || y + h < pane.clip.y || w < 1 || h < 1) continue;
      ctx.save();
      if (d.rot || d.flipH || d.flipV) {
        ctx.translate(x + w / 2, y + h / 2);
        if (d.rot) ctx.rotate((d.rot * Math.PI) / 180);
        ctx.scale(d.flipH ? -1 : 1, d.flipV ? -1 : 1);
        ctx.translate(-w / 2, -h / 2);
      } else ctx.translate(x, y);
      if (d.kind === "chart") {
        if (chartMod) chartMod.paintChart(ctx, d.chart!, d.theme ?? [], 0, 0, w, h, z, { lang: opt.lang, font: sh.baseFont, live, fonts: d.fonts });
        else {
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, w, h);
          ctx.strokeStyle = "#D9D9D9";
          ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
        }
      } else if (d.kind === "pic") {
        const img = picOf(d);
        if (img) {
          const iw = (img as ImageBitmap).width, ih = (img as ImageBitmap).height;
          const [cl, ct, cr, cb] = d.crop ?? [0, 0, 0, 0];
          const sx = cl * iw, sy = ct * ih, sw = Math.max(1, iw * (1 - cl - cr)), shh = Math.max(1, ih * (1 - ct - cb));
          ctx.imageSmoothingQuality = "high";
          ctx.drawImage(img, sx, sy, sw, shh, 0, 0, w, h);
        }
        if (d.line) {
          ctx.strokeStyle = d.line;
          ctx.lineWidth = (d.lineW ?? 1) * z;
          ctx.strokeRect(0, 0, w, h);
        }
      } else paintShape(ctx, d, w, h, z, sh.baseFont);
      ctx.restore();
    }
    ctx.restore();
  }
}
