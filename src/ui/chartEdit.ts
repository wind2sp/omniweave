// Slide charts (io/formats/pptxChart.ts): the chart picked on the canvas and editing its data and type. One edit is one
// store.commit (undoable); the chart is drawn again where it is, and a PPTX save writes the data into the chart part and
// its embedded workbook (officesurgeon/pptxChart.ts).

import { currentPage, useStore } from "../core/store";
import type { SceneNode, SlideChart } from "../core/types";
import { chartRun, replaceChart } from "../io/formats/pptxChart";
import { t } from "../i18n";

const S = () => useStore.getState();

/** The first shape of the chart a node belongs to (the one carrying the data), by index in `nodes`; -1 when none. */
export function chartHead(nodes: readonly SceneNode[], id: string): number {
  const at = nodes.findIndex((n) => n.id === id);
  const cid = nodes[at]?.chart?.id;
  if (!cid) return -1;
  for (let i = at; i >= 0; i--) if (nodes[i].chart?.id === cid && nodes[i].chart?.data) return i;
  return -1;
}

/** The chart among the selected shapes of the current slide: its first shape's id and data; null when none is picked. */
export function pickedChart(): { headId: string; data: SlideChart } | null {
  const s = S();
  const page = currentPage();
  if (!page) return null;
  for (const id of s.selection) {
    const i = chartHead(page.nodes, id);
    if (i >= 0) return { headId: page.nodes[i].id, data: page.nodes[i].chart!.data! };
  }
  return null;
}

/** Selects every shape of the chart a node belongs to (a click on one bar picks the chart, as PowerPoint does). */
export function chartIds(nodes: readonly SceneNode[], id: string): string[] {
  const i = chartHead(nodes, id);
  if (i < 0) return [];
  const [s, e] = chartRun(nodes, i);
  return nodes.slice(s, e).map((n) => n.id);
}

/** Draws the chart whose first shape is `headId` again from `data` (series, categories, values, type). */
export function setChartData(headId: string, data: Omit<SlideChart, "frame">) {
  const s = S();
  const page = currentPage();
  if (!page) return;
  const i = page.nodes.findIndex((n) => n.id === headId);
  if (i < 0 || !page.nodes[i].chart?.data) return;
  const nodes = replaceChart(page.nodes, i, data);
  const [a, b] = chartRun(nodes, i);
  s.commit(t("slideLayout.chart.hist"), (d) => {
    const p = d.pages.find((x) => x.id === page.id);
    if (p) p.nodes = nodes as never;
  });
  S().set({ selection: nodes.slice(a, b).map((n) => n.id) });
}
