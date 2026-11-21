// Lossless PDF size optimisation (docs/design/FILE_SIZE.md ch. 3).
//
//   collectGarbage  drop objects nothing reaches from the trailer (old revisions of incremental saves, copied page
//                   leaves whose private data no page draws, deleted objects still in the file)
//   dedupeStreams   one copy of byte-identical streams (fonts, images, forms from different sources)
//   flateStreams    deflate streams stored without a filter; re-deflate single-Flate streams harder when smaller
//                   (the decoded bytes — and any /DecodeParms predictor — stay exactly the same)
//   optimizePdf     full rewrite with object + cross-reference streams, verified page by page; refused for signed
//                   files (a rewrite moves the signed byte ranges, so every signature would break)
//
// Nothing here re-encodes an image or changes a content stream's decoded bytes: what a reader draws is unchanged.

import { zlibSync, unzlibSync } from "fflate";
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from "pdf-lib";
import { hashBytes, hashString } from "../core/hash";

/** Calls `fn` for every reference directly inside `obj` (dict values, array items, stream dictionaries). */
function eachRef(obj: PDFObject | undefined, fn: (r: PDFRef) => void) {
  if (!obj) return;
  if (obj instanceof PDFRef) fn(obj);
  else if (obj instanceof PDFDict) for (const [, v] of obj.entries()) eachRef(v, fn);
  else if (obj instanceof PDFArray) for (let i = 0; i < obj.size(); i++) eachRef(obj.get(i), fn);
  else if (obj instanceof PDFStream) eachRef(obj.dict, fn);
}

/** Object numbers reachable from the trailer (Root, Info, Encrypt). */
export function reachableRefs(ctx: PDFContext): Set<string> {
  const seen = new Set<string>();
  const stack: PDFRef[] = [];
  const push = (r: PDFRef) => {
    const k = r.toString();
    if (!seen.has(k)) (seen.add(k), stack.push(r));
  };
  const t = ctx.trailerInfo;
  for (const v of [t.Root, t.Info, t.Encrypt]) eachRef(v as PDFObject | undefined, push);
  while (stack.length) eachRef(ctx.lookup(stack.pop()!), push);
  return seen;
}

/** Delete every indirect object nothing reaches. Returns how many were removed. */
export function collectGarbage(ctx: PDFContext): number {
  const keep = reachableRefs(ctx);
  let n = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) if (!keep.has(ref.toString())) (ctx.delete(ref), n++);
  return n;
}

function streamBytes(s: PDFStream): Uint8Array {
  return s instanceof PDFRawStream ? s.contents : s.getContents();
}

/** Replace references in place: every `from` ref becomes `map.get(from)`. */
function remapRefs(ctx: PDFContext, map: Map<string, PDFRef>) {
  const fix = (obj: PDFObject | undefined) => {
    if (obj instanceof PDFStream) fix(obj.dict);
    else if (obj instanceof PDFDict) {
      for (const [k, v] of obj.entries()) {
        if (v instanceof PDFRef) {
          const to = map.get(v.toString());
          if (to) obj.set(k, to);
        } else fix(v);
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const v = obj.get(i);
        if (v instanceof PDFRef) {
          const to = map.get(v.toString());
          if (to) obj.set(i, to);
        } else fix(v);
      }
    }
  };
  for (const [, obj] of ctx.enumerateIndirectObjects()) fix(obj);
  const t = ctx.trailerInfo as Record<string, PDFObject | undefined>;
  for (const k of ["Root", "Info"]) {
    const v = t[k];
    if (v instanceof PDFRef && map.has(v.toString())) t[k] = map.get(v.toString());
  }
}

/**
 * Keep one copy of byte-identical streams (same dictionary, same bytes). Repeated a few times, because merging
 * two soft masks makes the images that point at them identical too. Returns the number of copies removed.
 */
export function dedupeStreams(ctx: PDFContext): number {
  let total = 0;
  for (let pass = 0; pass < 4; pass++) {
    const n = dedupeOnce(ctx);
    total += n;
    if (!n) break;
  }
  return total;
}

function dedupeOnce(ctx: PDFContext): number {
  const first = new Map<string, PDFRef>();
  const map = new Map<string, PDFRef>();
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    const bytes = streamBytes(obj);
    if (bytes.length < 64) continue;
    const key = hashString(obj.dict.toString()) + ":" + hashBytes(bytes) + ":" + bytes.length;
    const f = first.get(key);
    if (!f) first.set(key, ref);
    else map.set(ref.toString(), f);
  }
  if (!map.size) return 0;
  remapRefs(ctx, map);
  for (const k of map.keys()) {
    const [num, gen] = k.split(" ").map(Number);
    ctx.delete(PDFRef.of(num, gen));
  }
  return map.size;
}

const filterNames = (d: PDFDict): string[] => {
  const f = d.get(PDFName.of("Filter"));
  if (f instanceof PDFName) return [f.asString()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.asString() : "?"));
  return [];
};

export interface FlateReport {
  /** streams that had no filter and are now deflated */
  flated: number;
  /** Flate streams re-deflated smaller (decoded bytes unchanged) */
  recompressed: number;
  /** bytes saved in stream data */
  saved: number;
}

/**
 * Deflate unfiltered streams (except XMP metadata, kept readable as PDF/A asks) and, with `recompress`, re-deflate
 * single-Flate streams at level 9 when that is smaller. A stream is only replaced when the result inflates back to
 * exactly the bytes it had.
 */
export function flateStreams(ctx: PDFContext, opts: { recompress?: boolean } = {}): FlateReport {
  const r: FlateReport = { flated: 0, recompressed: 0, saved: 0 };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    const type = d.get(PDFName.of("Type"));
    if (type instanceof PDFName && (type.asString() === "/Metadata" || type.asString() === "/XRef")) continue;
    const filters = filterNames(d);
    const src = obj.contents;
    if (!filters.length) {
      if (src.length < 128) continue;
      const z = zlibSync(src, { level: 9 });
      if (z.length >= src.length * 0.95) continue;
      const nd = d.clone(ctx);
      nd.set(PDFName.of("Filter"), PDFName.of("FlateDecode"));
      nd.delete(PDFName.of("DecodeParms"));
      nd.set(PDFName.of("Length"), PDFNumber.of(z.length));
      ctx.assign(ref, PDFRawStream.of(nd, z));
      r.flated++;
      r.saved += src.length - z.length;
    } else if (opts.recompress && filters.length === 1 && filters[0] === "/FlateDecode" && src.length >= 256) {
      let plain: Uint8Array;
      try {
        plain = unzlibSync(src);
      } catch {
        continue; // damaged or raw-deflate data: leave it exactly as it is
      }
      const z = zlibSync(plain, { level: 9 });
      if (z.length >= src.length - 16) continue;
      const nd = d.clone(ctx);
      nd.set(PDFName.of("Length"), PDFNumber.of(z.length));
      ctx.assign(ref, PDFRawStream.of(nd, z));
      r.recompressed++;
      r.saved += src.length - z.length;
    }
  }
  return r;
}

/**
 * True when the file carries a digital signature (or DocMDP / usage-rights permissions bound to its bytes). Every
 * object is searched, direct dictionaries inside it too (a signature value may be written inline under a field whose
 * /FT /Sig is inherited from its parent), in every revision still in the file.
 */
export function isSignedPdf(doc: PDFDocument): boolean {
  const cat = doc.catalog;
  if (cat.get(PDFName.of("Perms"))) return true;
  const isName = (v: PDFObject | undefined, n: string) => v instanceof PDFName && v.asString() === n;
  const signed = (obj: PDFObject | undefined, depth: number): boolean => {
    if (!obj || depth > 32) return false;
    if (obj instanceof PDFStream) return signed(obj.dict, depth);
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) if (signed(obj.get(i), depth + 1)) return true;
      return false;
    }
    if (!(obj instanceof PDFDict)) return false;
    if (obj.get(PDFName.of("ByteRange"))) return true;
    const type = obj.get(PDFName.of("Type"));
    if ((isName(type, "/Sig") || isName(type, "/DocTimeStamp")) && obj.get(PDFName.of("Contents"))) return true;
    if (isName(obj.get(PDFName.of("FT")), "/Sig") && obj.get(PDFName.of("V"))) return true;
    for (const [, v] of obj.entries()) if (!(v instanceof PDFRef) && signed(v, depth + 1)) return true;
    return false;
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) if (signed(obj, 0)) return true;
  return false;
}

/** PDF/A-1 (ISO 19005-1) forbids object and cross-reference streams: such files are rewritten with a classic table. */
export function isPdfA1(doc: PDFDocument): boolean {
  const m = doc.catalog.lookup(PDFName.of("Metadata"));
  if (!(m instanceof PDFStream)) return false;
  let xmp: Uint8Array;
  try {
    xmp = m instanceof PDFRawStream ? decodePDFRawStream(m).decode() : m.getContents();
  } catch {
    return false;
  }
  const s = new TextDecoder("latin1").decode(xmp);
  return /pdfaid:part\s*(>\s*1\s*<|=\s*["']1["'])/.test(s);
}

/** Decoded content of every page (what a reader draws), hashed — the check that a rewrite changed nothing visible. */
export function pageFingerprints(doc: PDFDocument): string[] {
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const node = page.node;
    const parts: string[] = [String(node.MediaBox()?.toString()), String(node.get(PDFName.of("Rotate")) ?? "")];
    const c = node.get(PDFName.of("Contents"));
    const list = c instanceof PDFArray ? c.asArray() : c ? [c] : [];
    for (const item of list) {
      const s = item instanceof PDFRef ? doc.context.lookup(item) : item;
      if (!(s instanceof PDFStream)) continue;
      let bytes: Uint8Array;
      try {
        bytes = s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : s.getContents();
      } catch {
        bytes = streamBytes(s);
      }
      parts.push(hashBytes(bytes));
    }
    // resources by content: names and decoded XObject / font bytes would be ideal; their dictionaries are enough
    // to catch a dropped resource (a missing object resolves to undefined and changes the text)
    const res = node.Resources();
    parts.push(res ? hashString(resolvedText(doc.context, res, 3)) : "");
    out.push(hashString(parts.join("|")));
  }
  return out;
}

/** Dictionary text with references resolved a few levels deep (numbers of objects do change in a rewrite). */
function resolvedText(ctx: PDFContext, obj: PDFObject | undefined, depth: number): string {
  if (obj instanceof PDFRef) {
    const v = ctx.lookup(obj);
    if (v === undefined) return "∅";
    return depth > 0 ? resolvedText(ctx, v, depth - 1) : v instanceof PDFStream ? "S" + streamBytes(v).length : "R";
  }
  if (obj instanceof PDFStream) {
    let n = 0;
    try {
      n = obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode().length : obj.getContents().length;
    } catch {
      n = -1;
    }
    return `stream(${n})${resolvedText(ctx, obj.dict, depth)}`;
  }
  if (obj instanceof PDFDict) {
    const keys = [...obj.entries()].filter(([k]) => !["/Length", "/Filter", "/DecodeParms"].includes(k.asString()));
    keys.sort((a, b) => (a[0].asString() < b[0].asString() ? -1 : 1));
    return "<<" + keys.map(([k, v]) => k.asString() + " " + resolvedText(ctx, v, depth)).join(" ") + ">>";
  }
  if (obj instanceof PDFArray) return "[" + obj.asArray().map((v) => resolvedText(ctx, v, depth)).join(" ") + "]";
  return obj ? obj.toString() : "null";
}

export interface OptimizeReport {
  before: number;
  after: number;
  /** the result is smaller and verified (otherwise `bytes` are the input bytes) */
  effective: boolean;
  /** refused: the file is signed (a full rewrite would invalidate the signatures) */
  signed: boolean;
  /** refused: still encrypted (decrypt first; the caller re-applies protection) */
  encrypted: boolean;
  removed: number;
  deduped: number;
  flated: number;
  recompressed: number;
  /** page-by-page check passed */
  verified: boolean;
}

/**
 * Full lossless rewrite of a PDF: garbage collection (old incremental revisions disappear), stream dedupe,
 * deflate, object + xref streams. Signed or encrypted files come back unchanged with the reason in the report.
 */
export async function optimizePdf(bytes: Uint8Array, opts: { recompress?: boolean } = {}): Promise<{ bytes: Uint8Array; report: OptimizeReport }> {
  const report: OptimizeReport = { before: bytes.length, after: bytes.length, effective: false, signed: false, encrypted: false, removed: 0, deduped: 0, flated: 0, recompressed: 0, verified: false };
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  if (doc.isEncrypted) return { bytes, report: { ...report, encrypted: true } };
  if (isSignedPdf(doc)) return { bytes, report: { ...report, signed: true } };
  const fpBefore = pageFingerprints(doc);
  const ctx = doc.context;
  report.removed = collectGarbage(ctx);
  report.deduped = dedupeStreams(ctx);
  const fr = flateStreams(ctx, { recompress: opts.recompress ?? true });
  report.flated = fr.flated;
  report.recompressed = fr.recompressed;
  report.removed += collectGarbage(ctx);
  const out = await doc.save({ useObjectStreams: !isPdfA1(doc), addDefaultPage: false, updateFieldAppearances: false });
  const back = await PDFDocument.load(out, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const fpAfter = pageFingerprints(back);
  report.verified = fpAfter.length === fpBefore.length && fpAfter.every((f, i) => f === fpBefore[i]);
  if (!report.verified || out.length >= bytes.length) return { bytes, report };
  return { bytes: out, report: { ...report, after: out.length, effective: true } };
}

/** Lossless pass on a document being written (vector export): drop unreachable objects and duplicate streams. */
export async function tidyBeforeSave(doc: PDFDocument): Promise<{ removed: number; deduped: number }> {
  await doc.flush();
  const ctx = doc.context;
  let removed = collectGarbage(ctx);
  const deduped = dedupeStreams(ctx);
  if (deduped) removed += collectGarbage(ctx);
  return { removed, deduped };
}
