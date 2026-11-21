// Lossless PDF optimisation (src/io/pdfOptimize.ts) and the vector export's size work: what a reader draws and the
// text it extracts stay the same; signed files are never rewritten.

import { readFileSync } from "node:fs";
import { unzlibSync } from "fflate";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { hashBytes } from "../../src/core/hash";
import { makeTile } from "../../src/core/loom";
import { TILE, newDocument, newPage, newRaster, type OmwDocument } from "../../src/core/types";
import { optimizePdf } from "../../src/io/pdfOptimize";
import { lastXref, writeIncremental } from "../../src/io/pdfsurgeon/incremental";
import { exportPdfVector } from "../../src/io/pdfVector";
import { unfilterRows } from "../../src/io/tileCodec";
import { compressPdf } from "../../src/io/tools/pdfTools";
import { openJs, pdfjs as loadPdfjs } from "../pdfsurgeon/helpers";

const FONTS = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };

/** Text and the drawing-operator list of every page as pdf.js sees them (image data hashed). */
async function readerView(bytes: Uint8Array): Promise<{ text: string[]; ops: string[] }> {
  const d = await openJs(bytes);
  const text: string[] = [], ops: string[] = [];
  for (let i = 1; i <= d.numPages; i++) {
    const p = await d.getPage(i);
    text.push((await p.getTextContent()).items.map((x: any) => x.str).join("|"));
    const ol = await p.getOperatorList();
    ops.push(JSON.stringify([ol.fnArray, ol.argsArray], (_k, v) => (ArrayBuffer.isView(v) ? `bytes:${hashBytes(new Uint8Array((v as Uint8Array).buffer, (v as Uint8Array).byteOffset, (v as Uint8Array).byteLength))}` : v)).replace(/g_d\d+_/g, "g_d_")); // pdf.js names fonts per loaded document
  }
  await d.destroy();
  return { text, ops };
}

/** A PDF with text, a photo-like image, then two incremental updates that replace the page content (old ones stay). */
async function incrementalPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Omni size test");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 300]);
  page.drawText("Omni report - omniweave", { x: 30, y: 250, size: 20, font, color: rgb(0.1, 0.2, 0.5) });
  let bytes = await pdf.save({ useObjectStreams: false });
  for (const line of ["first edit", "second edit"]) {
    const d = await PDFDocument.load(bytes);
    const ctx = d.context;
    const p = d.getPage(0);
    const fontName = [...p.node.Resources()!.lookup(PDFName.of("Font"), PDFDict).keys()][0].asString();
    const contents = ctx.flateStream(`BT ${fontName} 12 Tf 30 ${line === "first edit" ? 200 : 180} Td (${line} omniweave) Tj ET\n` + "q 0.5 g 0 0 10 10 re f Q\n".repeat(400));
    const ref = ctx.register(contents);
    p.node.set(PDFName.of("Contents"), ref);
    bytes = writeIncremental(bytes, ctx, [ref, p.ref]);
  }
  return bytes;
}

describe("optimizePdf (full lossless rewrite)", () => {
  it("drops the revisions an incremental save left behind; what a reader draws and extracts is unchanged", async () => {
    const before = await incrementalPdf();
    expect(new TextDecoder("latin1").decode(before).match(/%%EOF/g)!.length).toBe(3);
    const { bytes, report } = await optimizePdf(before);
    expect(report).toMatchObject({ effective: true, verified: true, signed: false });
    expect(report.removed).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThan(before.length);
    const a = await readerView(before), b = await readerView(bytes);
    expect(b.text).toEqual(a.text);
    expect(b.ops).toEqual(a.ops);
    expect(lastXref(bytes).stream).toBe(true); // object + cross-reference streams
  });

  it("keeps one copy of identical streams and deflates unfiltered ones", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const ctx = pdf.context;
    const px = new Uint8Array(64 * 64 * 3).map((_, i) => (i * 7) & 255);
    const mk = () => ctx.register(PDFRawStream.of(ctx.obj({ Type: "XObject", Subtype: "Image", Width: 64, Height: 64, ColorSpace: "DeviceRGB", BitsPerComponent: 8, Length: px.length }) as PDFDict, px));
    const a = mk(), b = mk();
    page.node.newXObject("Im", a);
    page.node.newXObject("Im", b);
    page.pushOperators();
    const raw = await pdf.save({ useObjectStreams: false });
    const { bytes, report } = await optimizePdf(raw);
    expect(report.deduped).toBe(1);
    expect(report.flated).toBe(1);
    const back = await PDFDocument.load(bytes);
    const images = back.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(images).toHaveLength(1);
    expect(hashBytes(unzlibSync((images[0][1] as PDFRawStream).contents))).toBe(hashBytes(px));
  });

  it("never rewrites a signed PDF (a rewrite invalidates the signature): bytes come back as they were", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([200, 200]);
    const ctx = pdf.context;
    const sig = ctx.register(ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", ByteRange: [0, 10, 20, 30] }));
    const field = ctx.register(ctx.obj({ FT: "Sig", T: PDFName.of("Omni"), V: sig }));
    pdf.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: ctx.obj([field]) as PDFArray, SigFlags: 3 }));
    const signed = await pdf.save({ useObjectStreams: false });
    const { bytes, report } = await optimizePdf(signed);
    expect(report.signed).toBe(true);
    expect(bytes).toBe(signed);
    const quick = await compressPdf(signed);
    expect(quick.effective).toBe(false);
    expect(quick.bytes).toBe(signed);
  });

  for (const f of ["qa/interop/adobe-made/acro_forms.pdf", "qa/interop/adobe-made/ai_layers.ai", "qa/interop/omniweave-made/pdf-01-vector-export.pdf", "qa/interop/omniweave-made/pdf-03-surgeon-edited.pdf", "qa/interop/omniweave-made/ai-01-pdf-as-ai-surgeon-edited.ai"]) {
    it(`interop file ${f.split("/").pop()}: verified rewrite or unchanged; reader view identical`, async () => {
      const before = new Uint8Array(readFileSync(f));
      const { bytes, report } = await optimizePdf(before);
      expect(report.verified || !report.effective).toBe(true);
      expect(bytes.length).toBeLessThanOrEqual(before.length);
      const a = await readerView(before), b = await readerView(bytes);
      expect(b.text).toEqual(a.text);
      expect(b.ops).toEqual(a.ops);
    });
  }
});

describe("vector PDF export size", () => {
  it("an imported Illustrator page is exported without the private data no page draws; text and drawing stay", async () => {
    await loadPdfjs();
    const { importPdf } = await import("../../src/io/pdf");
    const src = new Uint8Array(readFileSync("qa/interop/adobe-made/ai_text_only.ai"));
    const { asset, pages } = await importPdf(src, "ai_text_only.ai", "ai");
    const doc = newDocument("Omni AI");
    doc.pages = pages;
    doc.assets = { [asset.id]: asset };
    const out = await exportPdfVector(doc, doc.pages, { fonts: FONTS });
    expect(out.length).toBeLessThan(src.length / 4);
    const a = await readerView(src), b = await readerView(out);
    expect(b.text).toEqual(a.text);
    // the page is drawn through a Form XObject in the export: same text-showing operators inside
    const count = (ops: string, fn: number) => (JSON.parse(ops.replace(/"bytes:[^"]*"/g, "0"))[0] as number[]).filter((x) => x === fn).length;
    const pdfjs = await import("pdfjs-dist");
    const showText = (pdfjs as any).OPS.showText;
    expect(count(b.ops[0], showText)).toBe(count(a.ops[0], showText));
  });

  function twoPagesSameRaster(): OmwDocument {
    const doc = newDocument("Omni export");
    const tile = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < tile.length; i += 4) {
      const x = (i / 4) % TILE, y = Math.floor(i / 4 / TILE);
      tile[i] = x;
      tile[i + 1] = y;
      tile[i + 2] = (x + y) >> 1;
      tile[i + 3] = 255;
    }
    const t = makeTile(tile);
    doc.pages = [0, 1].map((i) => {
      const p = newPage("DESIGN", 256, 256, `Omni ${i + 1}`);
      const r = newRaster("오메 photo");
      r.tiles = { "0_0": t };
      p.nodes = [r];
      return p;
    });
    return doc;
  }

  it("the same raster on two pages is one image; PNG prediction is lossless", async () => {
    const doc = twoPagesSameRaster();
    const bytes = await exportPdfVector(doc, doc.pages, { fonts: FONTS });
    const back = await PDFDocument.load(bytes);
    const images = back.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(images).toHaveLength(1);
    const s = images[0][1] as PDFRawStream;
    expect(s.dict.lookup(PDFName.of("DecodeParms"), PDFDict).get(PDFName.of("Predictor"))?.toString()).toBe("15");
    const px = new Uint8Array(TILE * TILE * 3);
    unfilterRows(unzlibSync(s.contents), TILE, TILE, px, 3);
    const want = new Uint8Array(TILE * TILE * 3);
    const src = (doc.pages[0].nodes[0] as any).tiles["0_0"].data as Uint8ClampedArray;
    for (let i = 0, j = 0; i < want.length; i += 3, j += 4) (want[i] = src[j]), (want[i + 1] = src[j + 1]), (want[i + 2] = src[j + 2]);
    expect(hashBytes(px)).toBe(hashBytes(want));
  });
});
