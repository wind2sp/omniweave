// Quick PDF tools — everything runs locally (pdf-lib / pdf.js); no file ever leaves the computer.

import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, type PDFRef } from "pdf-lib";
import { inflateSync, unzlibSync } from "fflate";
import { t } from "../../i18n";
import { collectGarbage, dedupeStreams, flateStreams, isPdfA1, isSignedPdf } from "../pdfOptimize";
import { unfilterRows } from "../tileCodec";

export type Progress = (done: number, total: number, label?: string) => void;

export interface NamedFile {
  name: string;
  bytes: Uint8Array;
}

export async function mergePdfs(files: NamedFile[], onProgress?: Progress): Promise<{ bytes: Uint8Array; pages: number }> {
  if (!files.length) throw new Error(t("engine.tools.nothingToMerge"));
  const out = await PDFDocument.create();
  out.setProducer("Omniweave (local)");
  let pages = 0;
  for (let i = 0; i < files.length; i++) {
    onProgress?.(i, files.length, files[i].name);
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(files[i].bytes, { ignoreEncryption: true, updateMetadata: false });
    } catch (e: any) {
      throw new Error(t("engine.tools.pdfReadFailed", { name: files[i].name, error: e?.message ?? String(e) }));
    }
    if (src.isEncrypted) throw new Error(t("engine.tools.mergeProtected", { name: files[i].name }));
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
    pages += copied.length;
  }
  onProgress?.(files.length, files.length);
  return { bytes: await out.save({ useObjectStreams: true }), pages };
}

export interface ImageRecompressor {
  /** re-encode an RGB/Gray image as JPEG at `quality` (0..1), optionally downscaled so the long side ≤ maxDim */
  (input: { kind: "jpeg"; bytes: Uint8Array } | { kind: "raw"; pixels: Uint8Array; width: number; height: number; channels: 1 | 3 }, quality: number, maxDim: number): Promise<{ bytes: Uint8Array; width: number; height: number } | null>;
}

export interface CompressResult {
  bytes: Uint8Array;
  before: number;
  after: number;
  images: number;
  recompressed: number;
  effective: boolean;
  note: string;
}

const name = (d: PDFDict, key: string) => {
  const v = d.get(PDFName.of(key));
  return v instanceof PDFName ? v.asString() : v ? v.toString() : null;
};
const num = (d: PDFDict, key: string) => {
  const v = d.get(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : NaN;
};

/**
 * Lossless pass (object streams, dropped unused objects) plus optional JPEG re-encoding of
 * images when a recompressor is given. Text and vector content are never touched. If the result
 * is not smaller, the original bytes are returned and `effective` is false.
 */
export async function compressPdf(bytes: Uint8Array, opts: { quality?: number; maxDim?: number; recompress?: ImageRecompressor; onProgress?: Progress } = {}): Promise<CompressResult> {
  const before = bytes.length;
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  if (doc.isEncrypted) throw new Error(t("engine.tools.compressProtected"));
  // a rewrite moves the signed byte ranges: every digital signature would become invalid
  if (isSignedPdf(doc)) return { bytes, before, after: before, images: 0, recompressed: 0, effective: false, note: t("size.signed") };
  let images = 0, recompressed = 0;
  if (opts.recompress) {
    const targets: [PDFRef, PDFRawStream][] = [];
    // soft masks are images too, but must stay single-channel: never re-encode them
    const masks = new Set<string>();
    for (const [, obj] of doc.context.enumerateIndirectObjects())
      if (obj instanceof PDFRawStream) {
        const sm = obj.dict.get(PDFName.of("SMask"));
        if (sm) masks.add(sm.toString());
      }
    for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
      if (masks.has(ref.toString())) continue;
      if (!(obj instanceof PDFRawStream)) continue;
      if (name(obj.dict, "Subtype") !== "/Image") continue;
      images++;
      targets.push([ref, obj]);
    }
    for (let i = 0; i < targets.length; i++) {
      const [ref, obj] = targets[i];
      opts.onProgress?.(i, targets.length, t("engine.tools.progress.recompress"));
      const d = obj.dict;
      const filter = name(d, "Filter");
      const cs = name(d, "ColorSpace");
      const bpc = num(d, "BitsPerComponent");
      const w = num(d, "Width"), h = num(d, "Height");
      if (d.get(PDFName.of("Mask")) || d.get(PDFName.of("ImageMask"))) continue;
      let input: Parameters<ImageRecompressor>[0] | null = null;
      if (filter === "/DCTDecode" && (cs === "/DeviceRGB" || cs === "/DeviceGray")) input = { kind: "jpeg", bytes: obj.contents };
      else if (filter === "/FlateDecode" && bpc === 8 && (cs === "/DeviceRGB" || cs === "/DeviceGray") && w * h > 4096) {
        try {
          let raw: Uint8Array;
          try {
            raw = unzlibSync(obj.contents);
          } catch {
            raw = inflateSync(obj.contents);
          }
          const channels = cs === "/DeviceRGB" ? 3 : 1;
          // PNG prediction (/Predictor 10–15, e.g. our own vector export) is undone; other parameters are left alone
          const parms = d.get(PDFName.of("DecodeParms"));
          if (parms instanceof PDFDict) {
            const pred = num(parms, "Predictor");
            const colors = num(parms, "Colors");
            const cols = num(parms, "Columns");
            if (pred >= 10 && (isNaN(colors) || colors === channels) && (isNaN(cols) || cols === w)) {
              const px = new Uint8Array(w * h * channels);
              unfilterRows(raw, w, h, px, channels);
              raw = px;
            } else if (!isNaN(pred) && pred > 1) raw = new Uint8Array(0);
          } else if (parms) raw = new Uint8Array(0);
          if (raw.length >= w * h * channels) input = { kind: "raw", pixels: raw, width: w, height: h, channels };
        } catch {
          /* leave as is */
        }
      }
      if (!input) continue;
      const res = await opts.recompress(input, opts.quality ?? 0.7, opts.maxDim ?? 2000).catch(() => null);
      if (!res || res.bytes.length >= obj.contents.length * 0.9) continue;
      const nd = doc.context.obj({}) as PDFDict;
      for (const [k, v] of d.entries()) if (!["/Filter", "/DecodeParms", "/Length", "/Width", "/Height", "/BitsPerComponent", "/ColorSpace"].includes(k.asString())) nd.set(k, v);
      nd.set(PDFName.of("Type"), PDFName.of("XObject"));
      nd.set(PDFName.of("Subtype"), PDFName.of("Image"));
      nd.set(PDFName.of("Filter"), PDFName.of("DCTDecode"));
      nd.set(PDFName.of("Width"), PDFNumber.of(res.width));
      nd.set(PDFName.of("Height"), PDFNumber.of(res.height));
      nd.set(PDFName.of("BitsPerComponent"), PDFNumber.of(8));
      nd.set(PDFName.of("ColorSpace"), PDFName.of("DeviceRGB")); // canvas JPEGs are always 3-channel
      nd.set(PDFName.of("Length"), PDFNumber.of(res.bytes.length));
      doc.context.assign(ref, PDFRawStream.of(nd, res.bytes));
      recompressed++;
    }
  }
  opts.onProgress?.(1, 1, t("engine.tools.progress.save"));
  // lossless part (io/pdfOptimize.ts): unreachable objects (old revisions…), duplicate streams, deflate
  collectGarbage(doc.context);
  dedupeStreams(doc.context);
  flateStreams(doc.context, { recompress: true });
  collectGarbage(doc.context);
  const out = await doc.save({ useObjectStreams: !isPdfA1(doc), addDefaultPage: false });
  const effective = out.length < before * 0.99;
  return {
    bytes: effective ? out : bytes,
    before,
    after: effective ? out.length : before,
    images,
    recompressed,
    effective,
    note: effective
      ? t("engine.tools.compressed", { pct: Math.round((1 - out.length / before) * 100) }) + (recompressed ? " " + t("engine.tools.recompressed", { done: recompressed, total: images }) : "")
      : images
        ? t("engine.tools.cannotShrinkOptimized")
        : t("engine.tools.cannotShrinkNoImages"),
  };
}

export type PageSize = "fit" | "A4" | "A4-landscape" | "Letter";

export interface ImageInput {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/**
 * Images → one PDF. JPEG and PNG are embedded as-is (no re-encoding); other formats go through
 * `convert` (canvas in the app). `fit` makes each page exactly the image size (1px = 0.75pt).
 */
export async function imagesToPdf(images: ImageInput[], opts: { pageSize?: PageSize; margin?: number; convert?: (img: ImageInput) => Promise<ImageInput>; onProgress?: Progress } = {}): Promise<Uint8Array> {
  if (!images.length) throw new Error(t("engine.tools.noImages"));
  const pdf = await PDFDocument.create();
  pdf.setProducer("Omniweave (local)");
  const size = opts.pageSize ?? "fit";
  const margin = size === "fit" ? 0 : opts.margin ?? 28;
  for (let i = 0; i < images.length; i++) {
    opts.onProgress?.(i, images.length, images[i].name);
    let img = images[i];
    if (img.mime !== "image/jpeg" && img.mime !== "image/png") {
      if (!opts.convert) throw new Error(t("engine.tools.needsConversion", { name: img.name, mime: img.mime }));
      img = await opts.convert(img);
    }
    const emb = img.mime === "image/jpeg" ? await pdf.embedJpg(img.bytes) : await pdf.embedPng(img.bytes);
    const iw = emb.width * 0.75, ih = emb.height * 0.75;
    let pw: number, ph: number;
    if (size === "fit") (pw = iw), (ph = ih);
    else if (size === "Letter") (pw = 612), (ph = 792);
    else if (size === "A4-landscape") (pw = 841.89), (ph = 595.28);
    else (pw = 595.28), (ph = 841.89);
    const page = pdf.addPage([pw, ph]);
    const k = Math.min(1, (pw - margin * 2) / iw, (ph - margin * 2) / ih);
    const w = iw * k, h = ih * k;
    page.drawImage(emb, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
  }
  opts.onProgress?.(images.length, images.length);
  return pdf.save();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)}KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 2 : 1)}MB`;
}
