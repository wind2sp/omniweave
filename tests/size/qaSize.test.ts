// QA (size-opt): derivation safety, forward compatibility of derived tiles, signature detection, PDF/A-1.

import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PDFArray, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { documentRoot } from "../../src/core/loom";
import { newDocument, type OmwDocument, type RasterNode } from "../../src/core/types";
import { FORMATS } from "../../src/io/formats";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { optimizePdf } from "../../src/io/pdfOptimize";

async function importPsdBytes(bytes: Uint8Array, name = "omni.psd"): Promise<OmwDocument> {
  const fmt = FORMATS.find((f) => f.id === "psd")!;
  const r = await fmt.open!({ name, path: null, bytes } as any, { confirm: () => true } as any);
  const doc = newDocument("Omni PSD");
  doc.pages = r.pages!;
  doc.assets = r.assets ?? {};
  return doc;
}

/** A flat (no layer records) PSD: header + raw composite planes. */
function flatPsd(mode: number, depth: number, channels: number, w: number, h: number, sample: (c: number, i: number) => number[]): Uint8Array {
  const bpc = depth / 8;
  const head = new Uint8Array(26);
  const dv = new DataView(head.buffer);
  head.set([0x38, 0x42, 0x50, 0x53]);
  dv.setUint16(4, 1);
  dv.setUint16(12, channels);
  dv.setUint32(14, h);
  dv.setUint32(18, w);
  dv.setUint16(22, depth);
  dv.setUint16(24, mode);
  const sections = new Uint8Array(12); // colour mode data, image resources, layer & mask info: all empty
  const img = new Uint8Array(2 + channels * w * h * bpc);
  for (let c = 0; c < channels; c++) for (let i = 0; i < w * h; i++) img.set(sample(c, i), 2 + (c * w * h + i) * bpc);
  const out = new Uint8Array(head.length + sections.length + img.length);
  out.set(head);
  out.set(sections, head.length);
  out.set(img, head.length + sections.length);
  return out;
}

const f32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v);
  return [...b];
};

describe("QA size-opt — derived PSD tiles only when decoding is engine-independent", () => {
  it("a 32-bit PSD (float samples, gamma via Math.pow) keeps its tiles as pixels", async () => {
    const psd = flatPsd(3, 32, 3, 40, 30, (c, i) => f32(((i * 7 + c * 31) % 997) / 997));
    const doc = await importPsdBytes(psd);
    const rasters = doc.pages.flatMap((p) => p.nodes).filter((n) => n.type === "RASTER") as RasterNode[];
    expect(rasters.length).toBeGreaterThan(0);
    const { bytes, stats } = packOmw(doc);
    expect(stats.derivedTiles).toBe(0);
    expect(stats.storedTiles).toBe(stats.tiles);
    const { doc: back, report } = unpackOmw(bytes);
    expect(report).toMatchObject({ missingTiles: 0, corruptTiles: 0, rootMatches: true });
    expect(documentRoot(back)).toBe(documentRoot(doc));
  });

  it("a Lab PSD (colour conversion with **) keeps its tiles as pixels", async () => {
    const psd = flatPsd(9, 8, 3, 33, 17, (c, i) => [(i * (c + 3)) & 255]);
    const doc = await importPsdBytes(psd);
    const { stats } = packOmw(doc);
    expect(stats.tiles).toBeGreaterThan(0);
    expect(stats.derivedTiles).toBe(0);
  });

  it("an 8-bit RGB PSD still uses derived tiles", async () => {
    const doc = await importPsdBytes(new Uint8Array(readFileSync("qa/interop/adobe-made/psd_clip_basic.psd")), "psd_clip_basic.psd");
    expect(packOmw(doc).stats.derivedTiles).toBeGreaterThan(0);
  });
});

describe("QA size-opt — derived tiles of an unknown recipe", () => {
  it("are refused with the update message instead of opening with layers missing", async () => {
    const doc = await importPsdBytes(new Uint8Array(readFileSync("qa/interop/adobe-made/psd_clip_basic.psd")), "psd_clip_basic.psd");
    const files = unzipSync(packOmw(doc).bytes);
    const d = JSON.parse(strFromU8(files["rasters/derived.json"]));
    d.recipe = "psd/99";
    files["rasters/derived.json"] = strToU8(JSON.stringify(d));
    expect(() => unpackOmw(zipSync(files))).toThrow(/Omniweave/);
  });

  it("a missing original PSD is reported and the document still opens (tiles rebuilt only from bytes that hash right)", async () => {
    const doc = await importPsdBytes(new Uint8Array(readFileSync("qa/interop/adobe-made/psd_clip_basic.psd")), "psd_clip_basic.psd");
    const files = unzipSync(packOmw(doc).bytes);
    const psdHash = Object.values(doc.assets).find((a) => a.mime === "image/vnd.adobe.photoshop")!.hash;
    for (const k of Object.keys(files)) if (k.startsWith("assets/" + psdHash)) delete files[k];
    const { report } = unpackOmw(zipSync(files));
    expect(report.missingAssets).toBe(1);
    expect(report.corruptTiles).toBe(0); // (this process still holds the PSD bytes in memory, so tiles come back)
  });
});

describe("QA size-opt — signed PDF detection", () => {
  it("a signature value written as a direct dictionary under an inherited /FT /Sig is detected", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([200, 200]);
    const ctx = pdf.context;
    const widget = ctx.register(ctx.obj({ Type: "Annot", Subtype: "Widget", Rect: [0, 0, 0, 0], P: page.ref }));
    const parent = ctx.register(ctx.obj({ FT: "Sig", T: PDFString.of("Omni"), Kids: [widget] }));
    const w = ctx.lookup(widget) as any;
    w.set(PDFName.of("Parent"), parent);
    w.set(PDFName.of("V"), ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite", ByteRange: [0, 10, 20, 30], Contents: PDFString.of("omniweave") }));
    page.node.set(PDFName.of("Annots"), ctx.obj([widget]));
    pdf.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: ctx.obj([parent]) as PDFArray, SigFlags: 3 }));
    const signed = await pdf.save({ useObjectStreams: false });
    const { bytes, report } = await optimizePdf(signed);
    expect(report.signed).toBe(true);
    expect(bytes).toBe(signed);
  });
});

describe("QA size-opt — PDF/A-1 files keep a classic cross-reference table", () => {
  it("optimizePdf writes no object or xref streams for a PDF/A-1 file (ISO 19005-1 forbids them)", async () => {
    const pdf = await PDFDocument.create();
    pdf.setTitle("Omni PDF/A");
    for (let i = 0; i < 3; i++) pdf.addPage([200, 200]).drawText("omniweave " + i, { x: 20, y: 100 });
    const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    const meta = pdf.context.stream(xmp, { Type: "Metadata", Subtype: "XML" });
    pdf.catalog.set(PDFName.of("Metadata"), pdf.context.register(meta));
    // padding an unreachable object so the rewrite is worth it
    pdf.context.register(pdf.context.flateStream("q 0 g 0 0 1 1 re f Q\n".repeat(2000)));
    const src = await pdf.save({ useObjectStreams: false });
    const { bytes, report } = await optimizePdf(src);
    expect(report.effective).toBe(true);
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).not.toMatch(/\/Type\s*\/ObjStm/);
    expect(text).not.toMatch(/\/Type\s*\/XRef/);
    expect(text).toMatch(/\nxref\n/);
  });
});

describe("QA size-opt — history after load → edit → save → load", () => {
  it("every state (old ones resolved from the scene graph) and assets only older states use survive two round trips", async () => {
    const d0 = await importPsdBytes(new Uint8Array(readFileSync("qa/interop/adobe-made/ps_layers_groups.psd")), "ps_layers_groups.psd");
    // the PSD page is replaced: its original (page.source.psd.assetId) is now used only by history
    const d1: OmwDocument = { ...d0, pages: [{ ...d0.pages[0], id: "p_omni", name: "오메", nodes: d0.pages[0].nodes.slice(0, 1), source: undefined }] };
    const entries = [d0, d1].map((d, i) => ({ id: "h" + i, time: i, label: "s" + i, root: documentRoot(d), doc: d }));
    const a = unpackOmw(packOmw(d1, entries).bytes);
    expect(a.report).toMatchObject({ historySkipped: 0, missingTiles: 0, corruptTiles: 0, missingAssets: 0 });
    expect(a.history.map((e) => documentRoot(e.doc))).toEqual(entries.map((e) => e.root));
    // edit after loading: remove the remaining node
    const d2: OmwDocument = { ...a.doc, pages: [{ ...a.doc.pages[0], nodes: [] }] };
    const entries2 = [...a.history, { id: "h2", time: 2, label: "s2", root: documentRoot(d2), doc: d2 }];
    const b = unpackOmw(packOmw(d2, entries2).bytes);
    expect(b.report).toMatchObject({ historySkipped: 0, missingTiles: 0, corruptTiles: 0, missingAssets: 0 });
    expect(b.history.map((e) => documentRoot(e.doc))).toEqual(entries2.map((e) => e.root));
    const psd = Object.values(d0.assets).find((x) => x.mime === "image/vnd.adobe.photoshop")!;
    expect(b.history[0].doc.assets[psd.id]).toEqual(psd);
    // without history the PSD is no longer used anywhere and is left out
    expect(packOmw(d2, []).stats.droppedAssets).toBe(Object.keys(d2.assets).length);
  });
});
