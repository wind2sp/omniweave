// PLOT on the drawing screen (AutoCAD's -PLOT on the command line): paper size, orientation, plot area (extents or
// the display), plot scale 1:N (or fit), monochrome — to a PDF at that true scale. The sheet is a page made for the
// plot: the drawing's nodes mapped from the page's own scale to the plot scale, centred on the paper.

import { currentPage, useStore } from "../../core/store";
import { nodeBounds } from "../../core/loom";
import { newPage, type Page, type SceneNode } from "../../core/types";
import { exportPdf } from "../../io/export";
import { FILTERS, saveFile } from "../../io/platform";
import { t } from "../../i18n";
import { mapNode, parts, say, type Cmd } from "./engine";
import { fmt } from "./geom";

const S = () => useStore.getState();
const PX_MM = 96 / 25.4;
export const PAPERS: Record<string, [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594], A0: [1189, 841] };
export interface PlotOpts {
  paper: string;
  landscape: boolean;
  /** 1:N; 0 = fit to paper */
  scale: number;
  area: "extents" | "display";
  mono: boolean;
}
export const plotSet: PlotOpts = { paper: "A3", landscape: true, scale: 0, area: "extents", mono: true };

/** The plot sheet: a page of the paper size with the drawing at 1:N. */
export function plotPage(page: Page, o: PlotOpts, view?: { x0: number; y0: number; x1: number; y1: number }): { page: Page; n: number; fits: boolean } {
  const cad = page.source!.cad!;
  // a layout is its own sheet: plotted 1:1 on its paper (the viewports carry the model's scale)
  const lay = !!cad.layout;
  const [a, b] = lay ? [page.width / PX_MM, page.height / PX_MM] : PAPERS[o.paper] ?? PAPERS.A3;
  const pw = lay ? a : o.landscape ? Math.max(a, b) : Math.min(a, b), ph = lay ? b : o.landscape ? Math.min(a, b) : Math.max(a, b);
  if (lay) (o = { ...o, scale: 1, area: "display" }), (view = { x0: 0, y0: 0, x1: page.width, y1: page.height });
  // the area in page px
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  if (o.area === "display" && view) ({ x0, y0, x1, y1 } = view);
  else
    for (const n of page.nodes) {
      if (!n.visible) continue;
      const r = nodeBounds(n);
      (x0 = Math.min(x0, r.x)), (y0 = Math.min(y0, r.y)), (x1 = Math.max(x1, r.x + r.w)), (y1 = Math.max(y1, r.y + r.h));
    }
  if (!(x1 > x0)) (x0 = 0), (y0 = 0), (x1 = page.width), (y1 = page.height);
  const margin = lay ? 0 : 5;
  // page px → drawing mm: 1 / k units · mmPerUnit
  const mmPerPx = (cad.mmPerUnit || 1) / cad.k;
  const wmm = (x1 - x0) * mmPerPx, hmm = (y1 - y0) * mmPerPx;
  const n = o.scale > 0 ? o.scale : Math.max(wmm / (pw - 2 * margin), hmm / (ph - 2 * margin), 1e-9);
  // sheet px per page px
  const f = (mmPerPx / n) * PX_MM;
  const sheet = newPage("DESIGN", pw * PX_MM, ph * PX_MM, page.name);
  const ox = (sheet.width - (x1 - x0) * f) / 2 - x0 * f, oy = (sheet.height - (y1 - y0) * f) / 2 - y0 * f;
  sheet.background = "#ffffff";
  sheet.groups = JSON.parse(JSON.stringify(page.groups ?? []));
  sheet.nodes = page.nodes.filter((x) => x.visible).map((x) => {
    const c = JSON.parse(JSON.stringify(x)) as SceneNode;
    mapNode(c, [f, 0, 0, f, ox, oy]);
    if (o.mono) {
      if (c.type === "VECTOR") {
        if (c.stroke) c.stroke = "#000000";
        if (c.fill && !c.cadHatch) c.fill = "#000000";
        if (c.fill && c.cadHatch) c.fill = c.cadHatch.pattern === "SOLID" ? "#000000" : c.fill;
      } else if (c.type === "TEXT") for (const p of c.paragraphs) for (const r of p.runs) r.color = "#000000";
    }
    return c;
  });
  const fits = (x1 - x0) * f <= sheet.width + 0.5 && (y1 - y0) * f <= sheet.height + 0.5;
  return { page: sheet, n, fits };
}

export async function plotPdf(o: PlotOpts = plotSet): Promise<boolean> {
  const page = currentPage();
  if (!page?.source?.cad) return false;
  const v = S().view;
  const el = document.querySelector(".canvas-wrap") as HTMLElement | null;
  const w = el?.clientWidth ?? 1200, h = el?.clientHeight ?? 800;
  const view = { x0: -v.panX / v.zoom, y0: -v.panY / v.zoom, x1: (w - v.panX) / v.zoom, y1: (h - v.panY) / v.zoom };
  const sheet = plotPage(page, o, view);
  const doc = { ...S().doc, pages: [sheet.page] };
  const bytes = await exportPdf(doc as any, [sheet.page]);
  const name = `${(S().doc.title || page.name || "plot").replace(/[\\/:*?"<>|]/g, "_")}.pdf`;
  const path = await saveFile(name, bytes, [FILTERS.pdf]);
  if (path) S().notify(t("cadfeat.plot.done", { name: path.split(/[\\/]/).pop() ?? name }));
  return !!path;
}

export function* PLOT(): Cmd {
  const P = parts;
  if (currentPage()?.source?.cad?.layout) {
    // a layout: its paper at 1:1, only black or colour is asked
    const mo = yield { k: "key", prompt: "plMono", opts: ["yes", "no"], def: t(plotSet.mono ? "cadui.o.yes" : "cadui.o.no") };
    if (mo.k === "opt") plotSet.mono = mo.key === "yes";
    else if (mo.k !== "enter") return;
    say(t("cadfeat.msg.plotting", { paper: currentPage()!.name, scale: "1:1" }));
    return void plotPdf({ ...plotSet });
  }
  const names = Object.keys(PAPERS);
  const pp = yield { k: "text", prompt: "plPaper", vars: { list: names.join("/") }, def: plotSet.paper };
  if (pp.k === "text") {
    const u = pp.s.trim().toUpperCase();
    if (!PAPERS[u]) return say(t("cadfeat.msg.noPaper", { name: u }));
    plotSet.paper = u;
  } else if (pp.k !== "enter") return;
  const or = yield { k: "key", prompt: "plOrient", opts: ["landscape", "portrait"], def: t(plotSet.landscape ? "cadui.o.landscape" : "cadui.o.portrait") };
  if (or.k === "opt") plotSet.landscape = or.key === "landscape";
  else if (or.k !== "enter") return;
  const ar = yield { k: "key", prompt: "plArea", opts: ["extents", "display"], def: t(plotSet.area === "extents" ? "cadui.o.extents" : "cadui.o.display") };
  if (ar.k === "opt") plotSet.area = ar.key as PlotOpts["area"];
  else if (ar.k !== "enter") return;
  const sc = yield* P.point({ prompt: "plScale", opts: ["fitPaper"], number: true, def: plotSet.scale ? `1:${fmt(plotSet.scale)}` : t("cadui.o.fitPaper") });
  if (sc.k === "number" && sc.v > 0) plotSet.scale = sc.v;
  else if (sc.k === "text") {
    const m = /^\s*1\s*[:=]\s*([\d.]+)\s*$/.exec(sc.s);
    if (m) plotSet.scale = Number(m[1]);
  } else if (sc.k === "opt") plotSet.scale = 0;
  else if (sc.k !== "enter") return;
  const mo = yield { k: "key", prompt: "plMono", opts: ["yes", "no"], def: t(plotSet.mono ? "cadui.o.yes" : "cadui.o.no") };
  if (mo.k === "opt") plotSet.mono = mo.key === "yes";
  else if (mo.k !== "enter") return;
  const page = currentPage()!;
  const s = plotPage(page, plotSet);
  say(t("cadfeat.msg.plotting", { paper: plotSet.paper, scale: `1:${fmt(s.n, 2)}` }));
  if (!s.fits) say(t("cadfeat.msg.plotClip"));
  void plotPdf({ ...plotSet });
}
