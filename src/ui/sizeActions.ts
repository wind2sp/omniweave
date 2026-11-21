// "용량 줄이기로 PDF 저장" (docs/design/FILE_SIZE.md ch. 3): lossless by default, photo re-encoding only when chosen.
//
//   export    the document as a vector PDF (already garbage-collected and deduplicated by pdfVector)
//   original  the current PDF page's source file as "save in the original format" gives it (original + incremental
//             update), then fully rewritten by optimizePdf — kept incremental when the file is signed

import { currentPage, useStore } from "../core/store";
import { docTitle, t } from "../i18n";
import { exportPdf } from "../io/export";
import { sameTypeExport } from "../io/formats";
import { optimizePdf } from "../io/pdfOptimize";
import { FILTERS, saveFile } from "../io/platform";
import { canvasRecompressor } from "../io/tools/imageTools";
import { compressPdf, formatBytes } from "../io/tools/pdfTools";
import { protectOutput } from "./actions";

export type SizeSource = "export" | "original";

export interface SizeOptions {
  source: SizeSource;
  /** null = lossless; otherwise JPEG quality (0..1) and longest photo side in px (0 = keep) */
  lossy: { quality: number; maxDim: number } | null;
}

export interface SizedPdf {
  bytes: Uint8Array;
  /** size the plain path gives (export as it is / the original as saved now) */
  before: number;
  notes: string[];
}

/** Can the current page be saved as its original PDF / AI? */
export function hasPdfSource(): boolean {
  const p = currentPage();
  return !!p && (p.source?.format === "pdf" || p.source?.format === "ai") && !!sameTypeExport(p);
}

export async function buildSizedPdf(o: SizeOptions): Promise<SizedPdf> {
  const doc = useStore.getState().doc;
  const notes: string[] = [];
  let base: Uint8Array;
  let bytes: Uint8Array;
  if (o.source === "original") {
    const page = currentPage();
    const def = page && sameTypeExport(page);
    if (!page || !def || !hasPdfSource()) throw new Error(t("size.noSource"));
    const out = await def.run(doc, page, { confirm: (m) => (typeof confirm === "function" ? confirm(m) : true) });
    base = typeof out === "string" ? new TextEncoder().encode(out) : out;
    const r = await optimizePdf(base);
    if (r.report.signed) notes.push(t("size.signed"));
    else if (!r.report.effective) notes.push(t("size.notSmaller")); // not smaller, or the page check failed: original kept
    bytes = r.bytes;
  } else {
    base = await exportPdf(doc, doc.pages, { onWarning: () => {} });
    bytes = base;
  }
  if (o.lossy) {
    const r = await compressPdf(bytes, { quality: o.lossy.quality, maxDim: o.lossy.maxDim || 1e9, recompress: canvasRecompressor });
    if (r.effective) bytes = r.bytes;
    else if (r.note && !notes.includes(r.note)) notes.push(r.note);
  }
  return { bytes, before: base.length, notes };
}

export async function saveSizedPdf(o: SizeOptions, built?: SizedPdf): Promise<boolean> {
  const s = useStore.getState();
  const r = built ?? (await buildSizedPdf(o));
  const prot = await protectOutput("pdf", r.bytes);
  if (!prot) return false;
  const page = currentPage();
  const base = o.source === "original" && page?.source ? page.source.name.replace(/\.[^.]+$/, "") : docTitle(s.doc.title);
  const path = await saveFile(`${base.replace(/[\\/:*?"<>|]/g, "_")}.pdf`, prot.bytes, [FILTERS.pdf]);
  if (!path) return false;
  s.notify([t("size.saved", { before: formatBytes(r.before), after: formatBytes(prot.bytes.length) }), ...r.notes].join(" · "));
  return true;
}

export { formatBytes };
