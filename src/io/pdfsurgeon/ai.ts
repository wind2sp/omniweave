// PDF Surgeon — Adobe Illustrator (PDF-compatible .ai) files.
// An .ai saved with "Create PDF Compatible File" is a PDF whose pages also carry Illustrator's own
// native data in the page-piece dictionary (ISO 32000-1 §14.5: /PieceInfo /Illustrator /Private ...).
// Illustrator prefers that private data when it re-opens the file, so after we edit the PDF content
// Illustrator would show the OLD artwork. Edits the private data can take (text characters, path
// fill/stroke colour and width) are mirrored into it (aiPrivate.ts), so layers, hidden layers and
// editable text survive. For any other edit we drop the /Illustrator entry: Illustrator then reads
// the edited PDF content instead (as it would open any PDF — layers merge into one, Illustrator-only
// features are not restored) and the person is told why. Either way the file is then written in full
// so the old private data does not stay behind. Unedited files are never touched.

import { PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { dictOf, look, pageDict, type SurgeonDoc } from "./document";
import { modelPage } from "./elevate";
import { t } from "../../i18n";
import { cloneDict } from "./incremental";

interface Marker {
  mark(r: PDFRef | null | undefined): void;
}

/** Remove Illustrator private data from every page. Returns true when anything was removed. */
export function stripIllustratorData(doc: SurgeonDoc, se: Marker): boolean {
  let removed = false;
  doc.pageRefs.forEach((ref, i) => {
    const pd = pageDict(doc, i);
    const raw = pd.get(PDFName.of("PieceInfo"));
    const pi = dictOf(look(doc.ctx, raw));
    if (!pi || !pi.get(PDFName.of("Illustrator"))) return;
    const copy = cloneDict(doc.ctx, pi);
    copy.delete(PDFName.of("Illustrator"));
    if (copy.keys().length) pd.set(PDFName.of("PieceInfo"), copy);
    else pd.delete(PDFName.of("PieceInfo"));
    se.mark(ref);
    removed = true;
  });
  return removed;
}

/** True when any page carries Illustrator private data. */
export function isIllustratorPdf(doc: SurgeonDoc): boolean {
  return doc.pageRefs.some((_, i) => {
    const pi = dictOf(look(doc.ctx, pageDict(doc, i).get(PDFName.of("PieceInfo"))));
    return !!pi?.get(PDFName.of("Illustrator"));
  });
}

/** Key names of the page's Illustrator /Private dictionary (names only — the values are never read). */
function privateKeys(doc: SurgeonDoc, i: number): string[] {
  const pi = dictOf(look(doc.ctx, pageDict(doc, i).get(PDFName.of("PieceInfo"))));
  const ill = dictOf(look(doc.ctx, pi?.get(PDFName.of("Illustrator"))));
  const priv = dictOf(look(doc.ctx, ill?.get(PDFName.of("Private"))));
  return priv ? priv.keys().map((k) => k.decodeText()) : [];
}

/**
 * An .ai saved WITHOUT "Create PDF Compatible File": Illustrator still writes a PDF wrapper, but
 * its page only shows a notice ("…saved without PDF Content… re-save with Create PDF Compatible
 * File…") while the artwork lives solely in the private data. Detected from public structure and
 * the page text: the page has Illustrator private data, the visible text names both
 * "Illustrator" and "PDF" (true for every localisation of the notice), and the page draws no
 * artwork besides that text (no images, at most a frame or two of paths).
 */
export function isAiWithoutPdfContent(doc: SurgeonDoc): boolean {
  if (!doc.pageRefs.length || !privateKeys(doc, 0).some((k) => /^AIPrivateData/.test(k))) return false;
  return doc.pageRefs.every((_, i) => {
    const a = modelPage(doc, i, { prefix: "probe", vectors: false }).analysis;
    let text = "";
    let paths = 0;
    for (const it of a.items) {
      if (it.kind === "image") return false;
      if (it.kind === "path") paths++;
      else if (it.kind === "text") text += it.glyphs.map((g) => g.ch).join("");
    }
    const t = text.replace(/\s+/g, "");
    return paths <= 4 && /illustrator/i.test(t) && /PDF/.test(t);
  });
}

/**
 * The artwork preview Illustrator writes into the file's XMP packet (xmpGImg:image, a small base64 JPEG, about 256 px
 * wide) — present in .ai files with or without a PDF-compatible copy. Read as plain bytes: the XMP is never parsed
 * beyond this one element. Null when there is none or it is not a JPEG.
 */
export function aiXmpThumbnail(bytes: Uint8Array): Uint8Array | null {
  const n = Math.min(bytes.length, 8_000_000);
  let s = "";
  for (let i = 0; i < n; i += 65536) s += String.fromCharCode(...bytes.subarray(i, Math.min(n, i + 65536)));
  const a = s.indexOf("<xmpGImg:image>");
  if (a < 0) return null;
  const b = s.indexOf("</xmpGImg:image>", a);
  if (b < 0 || b - a > 2_000_000) return null;
  const b64 = s.slice(a + 15, b).replace(/&#x[aA];|&#10;|\s/g, "");
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return null;
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.length > 4 && out[0] === 0xff && out[1] === 0xd8 ? out : null;
}

/**
 * Remove the artwork preview (<xmp:Thumbnails>, see aiXmpThumbnail) from the document's XMP packet: after an edit it
 * shows the OLD artwork and text. Illustrator writes a new one the next time it saves. Only an unfiltered catalog
 * /Metadata stream is changed; returns true when a preview was removed (the caller writes the file in full).
 */
export function dropXmpThumbnail(doc: SurgeonDoc): boolean {
  const root = doc.ctx.trailerInfo.Root;
  const cat = root instanceof PDFRef ? dictOf(doc.ctx.lookup(root)) : undefined;
  const ref = cat?.get(PDFName.of("Metadata"));
  if (!(ref instanceof PDFRef)) return false;
  const st = doc.ctx.lookup(ref);
  if (!(st instanceof PDFRawStream) || st.dict.get(PDFName.of("Filter"))) return false;
  const b = st.contents;
  let s = "";
  for (let i = 0; i < b.length; i += 65536) s += String.fromCharCode(...b.subarray(i, i + 65536));
  const out = s.replace(/\s*<xmp:Thumbnails>[\s\S]*?<\/xmp:Thumbnails>/g, "").replace(/\s*<xmp:Thumbnails\s*\/>/g, "");
  if (out === s) return false;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  const dict = st.dict.clone(doc.ctx) as PDFDict;
  dict.set(PDFName.of("Length"), doc.ctx.obj(bytes.length));
  doc.ctx.assign(ref, PDFRawStream.of(dict, bytes));
  return true;
}

/** Why an .ai without a PDF-compatible copy cannot be opened (current UI language). */
export const aiNoPdfContentMsg = (): string => t("engine.ai.noPdfContent");

/** Shown before saving an edited .ai whose edits could not be mirrored into Illustrator's data (current UI language). */
export const aiSaveNote = (reason: string): string => t("engine.ai.saveNote", { reason });

