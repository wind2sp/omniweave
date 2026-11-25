// State of the Acrobat tools (ui/pdf/PdfTools.tsx): the tool in use on the page, pending redaction marks, the box just
// drawn for a link / field / crop and the open tool dialog. Kept apart from the components so the command table
// (commands.ts) can use it without importing the dialogs.
import { create } from "zustand";
import type { NewFieldKind, Rect } from "../../io/pdfsurgeon/acrobat";

export type PdfToolKind = "redact" | "link" | "field" | "crop" | "picture" | "measure";
export type MeasureMode = "distance" | "perimeter" | "area";
export type LenUnit = "pt" | "in" | "mm" | "cm" | "m" | "km" | "ft";
/** Acrobat's scale ratio: `page` units on the page are `real` units in reality */
export interface MeasureScale {
  page: number;
  pageUnit: LenUnit;
  real: number;
  realUnit: LenUnit;
}
export type PdfToolDialog = "redact" | "watermark" | "headerFooter" | "background" | "bookmarks" | "link" | "field" | "replace" | "crop" | "labels" | "pdfa" | "compare" | "goto" | "props" | "rotate" | "detect" | "tags";
export interface RedactMarkUi {
  id: string;
  /** document page id (its index in the document = its index in the written file) */
  pageId: string;
  /** PDF user space of that page */
  rect: Rect;
  text?: string;
}

export const usePdfTools = create<{
  tool: PdfToolKind | null;
  fieldKind: NewFieldKind;
  marks: RedactMarkUi[];
  dialog: PdfToolDialog | null;
  /** the box drawn for a link / field / crop, in the page's user space */
  pending: { pageId: string; rect: Rect } | null;
  measureMode: MeasureMode;
  scale: MeasureScale;
}>(() => ({ tool: null, fieldKind: "text", marks: [], dialog: null, pending: null, measureMode: "distance", scale: { page: 1, pageUnit: "mm", real: 1, realUnit: "mm" } }));

const PER_PT: Record<LenUnit, number> = { pt: 1, in: 1 / 72, mm: 25.4 / 72, cm: 2.54 / 72, m: 0.0254 / 72, km: 0.0000254 / 72, ft: 1 / 864 };
/** A length on the page (pt) in the real unit of the scale. */
export const realLength = (pt: number, s: MeasureScale) => pt * PER_PT[s.pageUnit] * (s.real / (s.page || 1));
/** An area on the page (pt²) in the real unit², by the scale. */
export const realArea = (pt2: number, s: MeasureScale) => pt2 * (PER_PT[s.pageUnit] * (s.real / (s.page || 1))) ** 2;
/** Shoelace area of a polygon (x, y pairs). */
export const polygonArea = (p: number[]) => {
  let a = 0;
  for (let i = 0; i + 1 < p.length; i += 2) {
    const j = (i + 2) % p.length;
    a += p[i] * p[j + 1] - p[j] * p[i + 1];
  }
  return Math.abs(a) / 2;
};
export const pathLength = (p: number[], closed = false) => {
  let l = 0;
  for (let i = 2; i + 1 < p.length; i += 2) l += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  if (closed && p.length >= 6) l += Math.hypot(p[0] - p[p.length - 2], p[1] - p[p.length - 1]);
  return l;
};
const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(1) : v.toFixed(2));
/** The label of a measurement (what Acrobat writes beside it), e.g. "100.0 mm", "12.50 m²". */
export function measureLabel(mode: MeasureMode, points: number[], s: MeasureScale): string {
  if (mode === "area") return `${fmt(realArea(polygonArea(points), s))} ${s.realUnit}²`;
  return `${fmt(realLength(pathLength(points, false), s))} ${s.realUnit}`;
}

export function setPdfTool(tool: PdfToolKind | null) {
  usePdfTools.setState((s) => ({ tool: s.tool === tool ? null : tool, pending: null }));
}
export const openPdfDialog = (dialog: PdfToolDialog | null) => usePdfTools.setState({ dialog });
