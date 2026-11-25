// What a save would silently leave out (design ch. 5 "honest fallback", the worst failure being content that is gone
// without a word): before writing, the objects the target format's writer cannot hold are counted, so the person is
// asked first and can keep them (a .omw keeps everything) instead of finding them missing after reopening.
//
// The writers decide this, not the capability table alone: the flow writers (DOCX / HWPX) write the body text,
// tables, pictures, shapes and text boxes (io/officeShapes.ts); the text formats write text, tables and pictures; CSV
// and XLSX (pages without a sheet) only tables.

import { CAP_FORMATS, capOf, type CapFormat } from "../core/style/caps";
import { parseHfId } from "../core/headerFooter";
import { isPageBorderNode } from "../core/pageBorder";
import { isDocShape, isTextBox } from "../io/officeShapes";
import type { NodeType, Page, SceneNode } from "../core/types";

export interface LossItem {
  /** "node.VECTOR" … (labels style.prop.node.*) */
  prop: `node.${NodeType}`;
  count: number;
}

/** Nodes the flow made or that are drawn from other data (page border lines, note areas, headers / footers, live art). */
const derived = (n: SceneNode) => !!n.notes || !!n.artGen || isPageBorderNode(n) || !!parseHfId(n.id);

/** Node kinds each writer leaves out; null = decided by the capability table (formats it covers). */
const DROPS: Record<string, readonly NodeType[]> = {
  // DOCX / HWPX / HWP write shapes (VECTOR) and text boxes since io/officeShapes.ts; layers, PDF pages and media not
  docx: ["RASTER", "PDF", "MEDIA"],
  hwpx: ["RASTER", "PDF", "MEDIA"],
  // (HWP: the original file with text edits; any other change is refused with a message, hwp5Write.ts — nothing is
  // left out unsaid, so it is not listed here)
  md: ["RASTER", "VECTOR", "PDF", "MEDIA"],
  html: ["RASTER", "VECTOR", "PDF", "MEDIA"],
  txt: ["RASTER", "VECTOR", "PDF", "MEDIA", "IMAGE"],
  csv: ["RASTER", "VECTOR", "PDF", "MEDIA", "IMAGE", "TEXT"],
  // a drawing page as DXF: paths and text (io/formats/cad/dxfWrite2000.ts)
  dxf: ["RASTER", "IMAGE", "TABLE", "PDF", "MEDIA"],
};

const FLOW_WRITERS = new Set(["docx", "hwpx"]);

/** The objects of `pages` that saving as `ext` would leave out, by kind (empty when everything is written). */
export function unwrittenObjects(pages: readonly Page[], ext: string): LossItem[] {
  const e = ext.toLowerCase();
  const drops = DROPS[e];
  const fmt = (CAP_FORMATS as readonly string[]).includes(e) ? (e as CapFormat) : null;
  if (!drops && !fmt) return [];
  const counts = new Map<NodeType, number>();
  const charts = new Set<string>();
  for (const pg of pages) {
    // a sheet page's own content is the sheet (written by the workbook writer), not its nodes
    if (e === "xlsx" && pg.sheet) continue;
    for (const n of pg.nodes) {
      if (derived(n)) continue;
      // hidden objects: Word and 한글 have no hidden pictures, 한글 no hidden shapes or text boxes either
      const hiddenLost = !n.visible && (FLOW_WRITERS.has(e) ? n.type === "IMAGE" || (e !== "docx" && (isDocShape(n) || isTextBox(n, pg))) : false);
      // (a chart drawn on a document page: Word / 한글 charts are not written — its shapes would be left out)
      const lost = hiddenLost || (FLOW_WRITERS.has(e) && !!n.chart) || (drops ? drops.includes(n.type) : capOf(`node.${n.type}`, fmt!) === "drop");
      if (!lost) continue;
      // the shapes of one chart are one object
      if (n.chart) {
        if (charts.has(n.chart.id)) continue;
        charts.add(n.chart.id);
      }
      counts.set(n.type, (counts.get(n.type) ?? 0) + 1);
    }
  }
  return [...counts].map(([k, count]) => ({ prop: `node.${k}` as const, count }));
}
