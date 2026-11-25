// The contextual tab (Word's 표 디자인 / 그림 서식, PowerPoint's 도형 서식): what is selected or being edited on the
// page decides whether one shows at the end of the tab row, and its name. One hook for the tab row and the ribbon.
import { findPage, useStore } from "../../core/store";
import { hfEditNode, parseHfId } from "../../core/headerFooter";
import { useT } from "../../i18n";
import { useCrop } from "../cropTool";
import type { Surface } from "../ribbonTabs";
import { tableAt, useChartSel } from "../sheet/sheetFeatures";
import { useSheetUI } from "../sheet/sheetActions";

export interface RibbonContext {
  /** hf · crop · table · picture · shape · text · object */
  key: string;
  label: string;
}

/** Surfaces that have a contextual tab (the image / design modes show the options bar instead). */
const CTX_SURFACES: Surface[] = ["doc", "pdf", "slide", "sheet"];

export function useRibbonContext(surface: Surface): RibbonContext | null {
  const t = useT();
  const cropping = useCrop((s) => !!s.id);
  const chartPicked = useChartSel((s) => s.i >= 0 && s.pageId != null) && surface === "sheet";
  // the active cell in an Excel table: 테이블 디자인
  const inTable = useStore((s) => {
    if (surface !== "sheet") return false;
    const pg = findPage(s.doc, s.pageId);
    return !!pg?.sheet?.tables?.length && pg.id;
  });
  const tableSel = useSheetUI((s) => (inTable ? s.sel[inTable] : undefined));
  const tablePage = useStore((s) => (inTable ? findPage(s.doc, inTable)?.sheet : undefined));
  const hf = useStore((s) => !!(s.editingTextId && parseHfId(s.editingTextId) && hfEditNode(s.doc, s.editingTextId)));
  const kinds = useStore((s) => {
    const pg = findPage(s.doc, s.pageId);
    return [...new Set((pg?.nodes ?? []).filter((n) => s.selection.includes(n.id)).map((n) => n.type))].sort().join(",");
  });
  if (!CTX_SURFACES.includes(surface)) return null;
  // a chart picked on a sheet: Excel's 차트 디자인
  if (surface === "sheet") {
    if (chartPicked) return { key: "chart", label: t("sheetx.ctx.chart") };
    if (tablePage && tableSel && tableAt(tablePage, tableSel.ar, tableSel.ac)) return { key: "table", label: t("sheetx.table.design") };
    return null;
  }
  if (hf && surface === "doc") return { key: "hf", label: t("docmode.ctx.headerFooter") };
  if (cropping) return { key: "crop", label: t("docmode.ctx.picture") };
  if (!kinds) return null;
  // a text box: in a document the Home tab already formats it; on a PDF (an elevated text box) or a slide it gets its own
  if (kinds === "TEXT") return surface === "doc" ? null : { key: "text", label: t(surface === "pdf" ? "topui.ctx.textBox" : "topui.ctx.shapeFormat") };
  if (kinds === "TABLE") return { key: "table", label: t("docmode.ctx.table") };
  if (kinds === "IMAGE" || kinds === "RASTER" || kinds === "PDF") return { key: "picture", label: t("docmode.ctx.picture") };
  if (kinds === "VECTOR") return { key: "shape", label: t(surface === "slide" ? "topui.ctx.shapeFormat" : "docmode.ctx.shape") };
  return { key: "object", label: t("docmode.ctx.object") };
}
