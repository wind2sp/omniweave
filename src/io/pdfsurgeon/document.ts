// PDF Surgeon — document access on top of pdf-lib's object model.
// pdf-lib parses the object graph (xref tables/streams, object streams); we add decryption,
// inherited page attributes, decoded content streams and value conversion helpers.

import { PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFObject, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFContext } from "pdf-lib";
import { t } from "../../i18n";
import { PasswordError, decryptPdf, type EncryptionInfo } from "./decrypt";
import { decodeFilters, filtersOf } from "./filters";
import { PdfDict, PdfName, PdfRef, PdfStr, type PdfVal } from "./syntax";
import type { FontInfo } from "./fonts";
import { CJK_ORDERINGS, loadUcs2 } from "./bcmap";

export interface SurgeonDoc {
  /** the bytes as opened (possibly encrypted) */
  original: Uint8Array;
  /** the bytes pdf-lib parsed: identical to `original` unless the file was encrypted */
  plain: Uint8Array;
  pdf: PDFDocument;
  ctx: PDFContext;
  encryption: EncryptionInfo | null;
  pageRefs: PDFRef[];
  /** fonts already analysed, by font dictionary ref (or resource path for direct dictionaries) */
  fontCache: Map<string, FontInfo>;
  /** CID → Unicode for Adobe CJK collections used by fonts without ToUnicode (preloaded) */
  cidUnicode: Map<string, Map<number, string>>;
}

export class NeedPasswordError extends Error {
  constructor() {
    super(t("engine.pdf.needPassword"));
  }
}

const LOAD = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false } as const;

/**
 * Open a PDF for surgery. Encrypted files are decrypted with the empty password first (owner-only
 * protection), then with `password`. The password is used once and not retained.
 */
export async function openSurgeonDoc(bytes: Uint8Array, password?: string): Promise<SurgeonDoc> {
  let pdf = await PDFDocument.load(bytes, LOAD);
  let plain = bytes;
  let encryption: EncryptionInfo | null = null;
  if (pdf.context.trailerInfo.Encrypt) {
    let r: Awaited<ReturnType<typeof decryptPdf>> | null = null;
    // the given password first: when it is the owner password it grants the owner's rights, even if
    // the empty user password would also open the file
    for (const pw of password ? [password, ""] : [""]) {
      try {
        r = await decryptPdf(bytes, pw);
        break;
      } catch (e) {
        if (!(e instanceof PasswordError)) throw e;
      }
    }
    if (!r) throw new NeedPasswordError();
    plain = r.plain;
    encryption = r.info;
    pdf = await PDFDocument.load(plain, LOAD);
  }
  const pageRefs = pdf.getPages().map((p) => p.ref);
  return { original: bytes, plain, pdf, ctx: pdf.context, encryption, pageRefs, fontCache: new Map(), cidUnicode: await preloadCidUnicode(pdf.context) };
}

/** Load the Adobe UCS2 maps for CID fonts that rely on a CJK character collection. */
async function preloadCidUnicode(ctx: PDFContext): Promise<Map<string, Map<number, string>>> {
  const want = new Set<string>();
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict)) continue;
    const sub = nameOf(o.get(PDFName.of("Subtype")));
    if (sub !== "CIDFontType0" && sub !== "CIDFontType2") continue;
    const info = dictOf(look(ctx, o.get(PDFName.of("CIDSystemInfo"))));
    const ord = textOf(dget(ctx, info, "Ordering"));
    if (ord && CJK_ORDERINGS.includes(ord)) want.add(ord);
  }
  const out = new Map<string, Map<number, string>>();
  for (const ord of want) {
    const m = await loadUcs2(ord);
    if (m) out.set(ord, m);
  }
  return out;
}

// ───────── value helpers ─────────

export function look(ctx: PDFContext, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? ctx.lookup(o) : o;
}
export function dget(ctx: PDFContext, d: PDFDict | undefined, k: string): PDFObject | undefined {
  return d ? look(ctx, d.get(PDFName.of(k))) : undefined;
}
export function dictOf(o: PDFObject | undefined): PDFDict | undefined {
  if (o instanceof PDFDict) return o;
  if (o instanceof PDFStream) return o.dict;
  return undefined;
}
export function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}
export function numOf(o: PDFObject | undefined): number | undefined {
  return o instanceof PDFNumber ? o.asNumber() : undefined;
}
export function strBytes(o: PDFObject | undefined): Uint8Array | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.asBytes() : undefined;
}
export function textOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}
export function numArray(ctx: PDFContext, o: PDFObject | undefined): number[] | undefined {
  const a = look(ctx, o);
  if (!(a instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const n = numOf(look(ctx, a.get(i)));
    if (n == null) return undefined;
    out.push(n);
  }
  return out;
}
export const refKey = (r: PDFRef) => `${r.objectNumber} ${r.generationNumber}`;

/** Convert a (small) pdf-lib value to the surgeon's value model; refs stay refs. */
export function toVal(o: PDFObject | undefined, depth = 0): PdfVal {
  if (o == null || o === PDFNull || depth > 32) return null;
  if (o instanceof PDFNumber) return o.asNumber();
  if (o === PDFBool.True || o === PDFBool.False) return o === PDFBool.True;
  if (o instanceof PDFName) return new PdfName(o.decodeText());
  if (o instanceof PDFString || o instanceof PDFHexString) return new PdfStr(o.asBytes(), o instanceof PDFHexString);
  if (o instanceof PDFRef) return new PdfRef(o.objectNumber, o.generationNumber);
  if (o instanceof PDFArray) return o.asArray().map((x) => toVal(x, depth + 1));
  const d = dictOf(o);
  if (d) {
    const out = new PdfDict();
    for (const [k, v] of d.entries()) out.map.set(k.decodeText(), toVal(v, depth + 1));
    return out;
  }
  return null;
}

/** Decoded stream data. Throws StreamDecodeError for filters we cannot undo. */
export function streamBytes(ctx: PDFContext, s: PDFObject | undefined): Uint8Array {
  const st = look(ctx, s);
  if (!(st instanceof PDFStream)) return new Uint8Array(0);
  const raw = st instanceof PDFRawStream ? st.contents : st.getContents();
  const filters = filtersOf(toVal(dget(ctx, st.dict, "Filter")), toVal(dget(ctx, st.dict, "DecodeParms")));
  return decodeFilters(raw, filters);
}

// ───────── pages ─────────

/** Page attribute with inheritance through the page tree (Resources, MediaBox, CropBox, Rotate). */
export function inherited(ctx: PDFContext, page: PDFDict, key: string): PDFObject | undefined {
  let node: PDFDict | undefined = page;
  for (let guard = 0; node && guard < 64; guard++) {
    const v = node.get(PDFName.of(key));
    if (v !== undefined) return look(ctx, v);
    node = dictOf(look(ctx, node.get(PDFName.of("Parent"))));
  }
  return undefined;
}

export function pageDict(doc: SurgeonDoc, i: number): PDFDict {
  const d = doc.ctx.lookup(doc.pageRefs[i]);
  if (!(d instanceof PDFDict)) throw new Error(t("engine.pdf.pageDamaged", { page: i + 1 }));
  return d;
}

/** The visible box pdf.js uses: CropBox ∩ MediaBox (default user space). */
export function pageView(doc: SurgeonDoc, i: number): { view: number[]; rotate: number; userUnit: number } {
  const pd = pageDict(doc, i);
  const norm = (b: number[] | undefined) => (b && b.length >= 4 ? [Math.min(b[0], b[2]), Math.min(b[1], b[3]), Math.max(b[0], b[2]), Math.max(b[1], b[3])] : undefined);
  const media = norm(numArray(doc.ctx, inherited(doc.ctx, pd, "MediaBox"))) ?? [0, 0, 612, 792];
  const crop = norm(numArray(doc.ctx, inherited(doc.ctx, pd, "CropBox")));
  let view = media;
  if (crop) {
    const v = [Math.max(crop[0], media[0]), Math.max(crop[1], media[1]), Math.min(crop[2], media[2]), Math.min(crop[3], media[3])];
    if (v[2] > v[0] && v[3] > v[1]) view = v;
  }
  const rot = numOf(inherited(doc.ctx, pd, "Rotate")) ?? 0;
  const uu = numOf(dget(doc.ctx, pd, "UserUnit")) ?? 1;
  return { view, rotate: rot % 90 === 0 ? rot : 0, userUnit: uu };
}

export function pageResources(doc: SurgeonDoc, i: number): PDFDict | undefined {
  return dictOf(inherited(doc.ctx, pageDict(doc, i), "Resources"));
}

/** Content stream parts of a page (refs or direct streams), in order. */
export function contentParts(doc: SurgeonDoc, i: number): PDFObject[] {
  const c = pageDict(doc, i).get(PDFName.of("Contents"));
  const v = look(doc.ctx, c);
  if (v instanceof PDFArray) return v.asArray();
  return c ? [c] : [];
}

/**
 * The page's content: all parts decoded and joined with a newline (the spec treats the parts as
 * one stream; the separator never changes meaning because tokens cannot span parts).
 */
export function pageContent(doc: SurgeonDoc, i: number): Uint8Array {
  const parts = contentParts(doc, i).map((p) => streamBytes(doc.ctx, p));
  const total = parts.reduce((n, p) => n + p.length + 1, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
    out[o++] = 10;
  }
  return out;
}

/** The page carries Adobe Illustrator private data (PieceInfo /Illustrator). */
export function hasIllustratorData(doc: SurgeonDoc, i: number): boolean {
  const pi = dictOf(dget(doc.ctx, pageDict(doc, i), "PieceInfo"));
  return !!pi?.get(PDFName.of("Illustrator"));
}

/** Names of Optional Content Groups the default configuration turns off. */
export function hiddenOcgs(doc: SurgeonDoc): Set<string> {
  const out = new Set<string>();
  const oc = dictOf(dget(doc.ctx, doc.pdf.catalog, "OCProperties"));
  const d = dictOf(dget(doc.ctx, oc, "D"));
  const off = dget(doc.ctx, d, "OFF");
  if (off instanceof PDFArray) for (const r of off.asArray()) if (r instanceof PDFRef) out.add(refKey(r));
  return out;
}
