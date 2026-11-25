// Acrobat-style whole-file tools on the open PDF (ui/pdf/PdfTools.tsx): the document is written out as it stands
// (every edit, comment, form value, turn and page order — the same bytes "save in the original format" writes), a
// tool of io/pdfsurgeon/acrobat.ts or redact.ts changes that file, and the result replaces the document's pages as one
// undoable step. That is how Acrobat applies a watermark or a redaction: the file itself is changed.

import { getBlob } from "../../core/assets";
import { useStore } from "../../core/store";
import type { Page, PdfNode } from "../../core/types";
import { t } from "../../i18n";
import { exportPdf } from "../../io/export";
import { importPdf, loadFallbackFont, saveSameTypePdf } from "../../io/pdf";
import { SAVE_CANCELLED } from "../../io/errors";
import { openFiles, saveFile, type OpenedFile } from "../../io/platform";
import { isPdfPage } from "../ribbonTabs";
import { isCancelled, withProgress } from "../progress";

const S = () => useStore.getState();
const ask = (msg: string) => (typeof confirm === "function" ? confirm(msg) : true);

export const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];
export const IMAGE_FILTER = [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }];

export const pdfNodeOf = (p: Page | undefined) => p?.nodes.find((n): n is PdfNode => n.type === "PDF");
/** The first PDF page of the document (the file the tools work on), or null */
export function pdfDocPage(): Page | null {
  const s = S();
  const cur = s.doc.pages.find((p) => p.id === s.pageId);
  if (cur && isPdfPage(cur) && pdfNodeOf(cur)) return cur;
  return s.doc.pages.find((p) => isPdfPage(p) && pdfNodeOf(p)) ?? null;
}
export const hasPdfDoc = () => !!pdfDocPage();

/** Index of the current page in the written file (the file follows the document's page order). */
export const currentFileIndex = () => Math.max(0, S().doc.pages.findIndex((p) => p.id === S().pageId));

/** The document as one PDF file, as it would be saved now. */
export async function currentPdfBytes(): Promise<Uint8Array> {
  const page = pdfDocPage();
  if (!page) throw new Error(t("pdftools.err.noPdf"));
  const doc = S().doc;
  return saveSameTypePdf(doc, page, ask, (d, ps) => exportPdf(d, ps, {}));
}

/** The original file bytes of the current page's PDF (for reading only: pictures, text positions …). */
export function currentAssetBytes(): Uint8Array | null {
  const page = pdfDocPage();
  const n = pdfNodeOf(page ?? undefined);
  const a = n && S().doc.assets[n.assetId];
  return (a && getBlob(a.hash)) ?? null;
}

/** Replace the document's pages with the pages of `bytes` (one undoable step), staying on the same page number. */
export async function replaceDocument(bytes: Uint8Array, label: string) {
  const s = S();
  const first = pdfDocPage();
  const name = first?.source?.name ?? `${s.doc.title || "document"}.pdf`;
  const at = currentFileIndex();
  const { asset, pages } = await importPdf(bytes, name, "pdf");
  // a protected source stays protected when saved: the new pages keep the secret it was opened with
  const prot = first?.source?.protection;
  if (prot) for (const p of pages) p.source = { ...(p.source ?? { format: "pdf", name }), protection: prot };
  s.commit(label, (d) => {
    d.assets[asset.id] = asset;
    d.pages = pages as never;
  });
  S().set({ pageId: pages[Math.min(at, pages.length - 1)]?.id ?? pages[0].id, selection: [] });
}

/**
 * Run a whole-file tool: the file as it stands → `fn` → the document replaced. Progress shows meanwhile; errors are
 * told (alert) and leave the document as it was. Returns true when the document was changed.
 */
export async function runPdfTool(label: string, fn: (bytes: Uint8Array) => Promise<Uint8Array | null>, done?: string): Promise<boolean> {
  try {
    const ok = await withProgress(label, async () => {
      const cur = await currentPdfBytes();
      const out = await fn(cur);
      if (!out) return false;
      await replaceDocument(out, label);
      return true;
    }, { cancel: true });
    if (ok) S().notify(done ?? t("pdftools.done", { what: label }));
    return ok;
  } catch (e: any) {
    if (e?.message === SAVE_CANCELLED || isCancelled(e)) {
      S().notify(t("pdftools.cancelled"));
      return false;
    }
    console.error(e);
    if (typeof alert === "function") alert(t("pdftools.err.failed", { what: label, error: String(e?.message ?? e) }));
    return false;
  }
}

/** Save the file the tool made as a new file (PDF/A, comparison report) without changing the document. */
export async function saveNewPdf(bytes: Uint8Array, suffix: string): Promise<boolean> {
  const first = pdfDocPage();
  const stem = (first?.source?.name ?? S().doc.title ?? "document").replace(/\.[^.]+$/, "");
  return !!(await saveFile(`${stem}${suffix}.pdf`, bytes, PDF_FILTER));
}

export async function pickOne(filters: { name: string; extensions: string[] }[]): Promise<OpenedFile | null> {
  const f = await openFiles(filters, false);
  return f[0] ?? null;
}

export const mimeOf = (name: string) => (/\.png$/i.test(name) ? "image/png" : "image/jpeg");

export { loadFallbackFont };

/** A JPEG's pixels through the browser's decoder (redaction paints over photos with it). */
export async function decodeJpeg(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray } | null> {
  if (typeof createImageBitmap !== "function") return null;
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }), { colorSpaceConversion: "none" } as ImageBitmapOptions);
  const c = typeof OffscreenCanvas === "function" ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement("canvas"), { width: bmp.width, height: bmp.height });
  const ctx = c.getContext("2d") as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  ctx.drawImage(bmp, 0, 0);
  const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
  const out = { width: bmp.width, height: bmp.height, data };
  bmp.close();
  return out;
}
