// Omniweave's own page data in a PDF / .ai (design 2, 2026-11-25): what the page model has that PDF has no place
// for — the design mode's perspective grid — kept in the page-piece dictionary under the application name
// "Omniweave" (ISO 32000-1 §14.5: /PieceInfo << /Omniweave << /LastModified (D:…) /Private (…) >> >>), next to
// Illustrator's own /Illustrator entry. Other programs keep page-piece data they do not know; Omniweave reads it
// back when the file opens again.

import { PDFDict, PDFHexString, PDFName, PDFString, type PDFContext, type PDFObject } from "pdf-lib";
import { dictOf, look, pageDict, type SurgeonDoc } from "./document";
import { cloneDict } from "./incremental";

/** The page data Omniweave keeps in a PDF page. */
export interface OmwPageData {
  perspGrid?: unknown;
}

const APP = "Omniweave";

function pdfDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** The Omniweave data of a page dictionary (null when it has none or it cannot be read). */
export function omwDataOf(ctx: PDFContext, page: PDFDict): OmwPageData | null {
  const pi = dictOf(look(ctx, page.get(PDFName.of("PieceInfo"))));
  const app = dictOf(look(ctx, pi?.get(PDFName.of(APP))));
  const priv = look(ctx, app?.get(PDFName.of("Private")));
  const text = priv instanceof PDFHexString || priv instanceof PDFString ? priv.decodeText() : null;
  if (!text) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? (v as OmwPageData) : null;
  } catch {
    return null;
  }
}

export const readOmwPiece = (doc: SurgeonDoc, i: number) => omwDataOf(doc.ctx, pageDict(doc, i));

/**
 * Set (or with null / nothing to keep, remove) the Omniweave data of a page dictionary. The PieceInfo dictionary
 * is copied, not changed in place (it may be shared). True when the page dictionary changed.
 */
export function setOmwData(ctx: PDFContext, page: PDFDict, data: OmwPageData | null): boolean {
  const keep = data && Object.values(data).some((v) => v != null) ? JSON.stringify(data) : null;
  const before = omwDataOf(ctx, page);
  if ((before ? JSON.stringify(before) : null) === keep) return false;
  const old = dictOf(look(ctx, page.get(PDFName.of("PieceInfo"))));
  const pi = old ? cloneDict(ctx, old) : (ctx.obj({}) as PDFDict);
  if (keep) pi.set(PDFName.of(APP), ctx.obj({ LastModified: PDFString.of(pdfDate()), Private: PDFHexString.fromText(keep) as PDFObject }) as PDFDict);
  else pi.delete(PDFName.of(APP));
  if (pi.keys().length) page.set(PDFName.of("PieceInfo"), pi);
  else page.delete(PDFName.of("PieceInfo"));
  return true;
}

export const writeOmwPiece = (doc: SurgeonDoc, i: number, data: OmwPageData | null) => setOmwData(doc.ctx, pageDict(doc, i), data);
