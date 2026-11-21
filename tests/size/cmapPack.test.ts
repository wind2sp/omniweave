// pdf.js CMaps ship as ONE packed file (public/pdfjs/cmaps.pack) instead of 169 small .bcmap files: the installer
// compresses each bundled file on its own (Tauri brotli), so one file lets the compressor see what the CMaps share
// (951 KB → 432 KB). docs/design/INSTALLER_SIZE.md.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error — plain .mjs build script (no types)
import { packCMaps } from "../../scripts/copy-pdfjs-assets.mjs";
import { PackedCMapReaderFactory, readCMapPack } from "../../src/io/pdfCMaps";

const DIR = "node_modules/pdfjs-dist/cmaps";
const files = readdirSync(DIR).filter((f) => f.endsWith(".bcmap"));
const pack = (): Uint8Array => packCMaps(files.map((f) => ({ name: f.slice(0, -6), data: new Uint8Array(readFileSync(`${DIR}/${f}`)) })));

describe("cmap pack", () => {
  it("round-trips every bcmap of pdfjs-dist byte for byte", () => {
    const m = readCMapPack(pack());
    expect(m.size).toBe(files.length);
    expect(files.length).toBeGreaterThan(150);
    for (const f of files) expect(Buffer.from(m.get(f.slice(0, -6))!).equals(readFileSync(`${DIR}/${f}`))).toBe(true);
  });

  it("rejects a file that is not a pack, and a truncated pack", () => {
    expect(() => readCMapPack(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow();
    const p = pack();
    expect(() => readCMapPack(p.subarray(0, p.length - 10))).toThrow();
  });

  it("pdf.js reads a non-embedded Korean CID font through the pack", async () => {
    const { PDFDocument, PDFName, PDFHexString } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 100]);
    const ctx = doc.context;
    // Type0 font, Adobe-Korea1, Unicode (UCS-2) encoding CMap that pdf.js must load: UniKS-UCS2-H
    const desc = ctx.obj({ Type: "FontDescriptor", FontName: "HYGoThic-Medium", Flags: 4, FontBBox: [0, -120, 1000, 880], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 700, StemV: 80 });
    const cid = ctx.obj({ Type: "Font", Subtype: "CIDFontType0", BaseFont: "HYGoThic-Medium", CIDSystemInfo: { Registry: PDFHexString.fromText("Adobe"), Ordering: PDFHexString.fromText("Korea1"), Supplement: 1 }, FontDescriptor: ctx.register(desc), DW: 1000 });
    const font = ctx.register(ctx.obj({ Type: "Font", Subtype: "Type0", BaseFont: "HYGoThic-Medium", Encoding: "UniKS-UCS2-H", DescendantFonts: [ctx.register(cid)] }));
    page.node.setFontDictionary(PDFName.of("F1"), font);
    // 한(U+D55C) 글(U+AE00) as 2-byte UCS-2 codes
    const content = ctx.flateStream("BT /F1 24 Tf 10 40 Td <D55CAE00> Tj ET");
    page.node.set(PDFName.of("Contents"), ctx.register(content));
    const bytes = await doc.save();

    const pdfjs = await import("pdfjs-dist");
    const { pathToFileURL } = await import("node:url");
    const { resolve } = await import("node:path");
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve("node_modules/pdfjs-dist/build/pdf.worker.min.mjs")).href;
    const packed = pack();
    vi.stubGlobal("fetch", async () => new Response(packed.slice()));
    try {
      const text = async (o: object) => {
        const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, ...o }).promise;
        const tc = await (await d.getPage(1)).getTextContent();
        await d.destroy();
        return tc.items.map((i) => ("str" in i ? i.str : "")).join("");
      };
      expect(await text({ CMapReaderFactory: PackedCMapReaderFactory, cMapUrl: "https://pack.test/pdfjs/", cMapPacked: true })).toBe("한글");
      // control: the text really depends on the CMap (without it pdf.js cannot decode the UCS-2 codes)
      expect(await text({ CMapReaderFactory: PackedCMapReaderFactory, cMapUrl: null })).not.toBe("한글");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("serves pdf.js (CMapReaderFactory contract) and loads the pack once per base URL", async () => {
    const bytes = pack();
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://app.test/pdfjs/cmaps.pack");
      return new Response(bytes.slice());
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const f = new PackedCMapReaderFactory({ baseUrl: "https://app.test/pdfjs/", isCompressed: true });
      const a = await f.fetch({ name: "Adobe-Korea1-UCS2" });
      expect(a.isCompressed).toBe(true);
      expect(Buffer.from(a.cMapData).equals(readFileSync(`${DIR}/Adobe-Korea1-UCS2.bcmap`))).toBe(true);
      const g = new PackedCMapReaderFactory({ baseUrl: "https://app.test/pdfjs/", isCompressed: true });
      await g.fetch({ name: "UniKS-UCS2-H" });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await expect(g.fetch({ name: "No-Such-CMap" })).rejects.toThrow(/No-Such-CMap/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
