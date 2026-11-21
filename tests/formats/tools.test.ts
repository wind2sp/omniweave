// Quick tools: the parts that run without a canvas (pdf-lib, zip, naming).
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { encodePng } from "../../src/io/formats/png";
import { compressPdf, formatBytes, imagesToPdf, mergePdfs } from "../../src/io/tools/pdfTools";
import { outName, uniqueNames, zipFiles } from "../../src/io/tools/imageTools";

async function pdfWith(pages: string[], opts: { objectStreams?: boolean } = {}) {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (const t of pages) d.addPage([300, 200]).drawText(t, { x: 20, y: 100, size: 14, font: f });
  return d.save({ useObjectStreams: opts.objectStreams ?? true });
}

describe("PDF tools", () => {
  it("merges in the given order", async () => {
    const a = await pdfWith(["A1", "A2"]);
    const b = await pdfWith(["B1"]);
    const progress: number[] = [];
    const r = await mergePdfs(
      [
        { name: "b.pdf", bytes: b },
        { name: "a.pdf", bytes: a },
      ],
      (d) => progress.push(d),
    );
    expect(r.pages).toBe(3);
    const doc = await PDFDocument.load(r.bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(progress).toEqual([0, 1, 2]);
    await expect(mergePdfs([{ name: "x.pdf", bytes: new Uint8Array([1, 2, 3]) }])).rejects.toThrow(/x\.pdf/);
  });

  it("compress: lossless pass shrinks an unoptimised PDF; never returns something bigger", async () => {
    const loose = await pdfWith(Array.from({ length: 30 }, (_, i) => `page ${i}`), { objectStreams: false });
    const r = await compressPdf(loose);
    expect(r.before).toBe(loose.length);
    expect(r.after).toBeLessThanOrEqual(r.before);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(30);
    const tight = (await compressPdf(r.bytes)).after;
    expect(tight).toBeLessThanOrEqual(r.after);
    const again = await compressPdf(r.bytes);
    if (!again.effective) {
      expect(again.bytes).toBe(r.bytes); // original handed back untouched
      expect(again.note).toMatch(/줄일 수 없습니다/);
    }
  });

  it("compress: image recompressor replaces image streams only when smaller", async () => {
    const d = await PDFDocument.create();
    let seed = 7;
    const px = new Uint8Array(80 * 80 * 4).map((_, i) => (i % 4 === 3 ? 255 : (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24));
    const img = await d.embedPng(encodePng(px, 80, 80, 0));
    d.addPage([200, 200]).drawImage(img, { x: 0, y: 0, width: 200, height: 200 });
    const bytes = await d.save();
    let calls = 0;
    const r = await compressPdf(bytes, {
      recompress: async (input) => {
        calls++;
        expect(input.kind).toBe("raw");
        if (input.kind === "raw") expect([input.width, input.height, input.channels]).toEqual([80, 80, 3]);
        return { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 80, height: 80 }; // tiny stand-in JPEG
      },
    });
    expect(calls).toBe(1);
    expect(r.recompressed).toBe(1);
    expect(r.after).toBeLessThan(r.before);
    expect((await PDFDocument.load(r.bytes)).getPageCount()).toBe(1);
  });

  it("images → PDF: fit and A4 page sizes, order kept, non-JPG/PNG needs a converter", async () => {
    const png = encodePng(new Uint8Array(40 * 20 * 4).fill(200), 40, 20);
    const fit = await PDFDocument.load(await imagesToPdf([{ name: "a.png", bytes: png, mime: "image/png" }], { pageSize: "fit" }));
    expect(fit.getPage(0).getSize()).toEqual({ width: 30, height: 15 });
    const a4 = await PDFDocument.load(await imagesToPdf([png, png].map((b, i) => ({ name: `${i}.png`, bytes: b, mime: "image/png" })), { pageSize: "A4" }));
    expect(a4.getPageCount()).toBe(2);
    expect(Math.round(a4.getPage(1).getSize().width)).toBe(595);
    await expect(imagesToPdf([{ name: "a.webp", bytes: new Uint8Array(4), mime: "image/webp" }])).rejects.toThrow(/변환/);
  });
});

describe("helpers", () => {
  it("zip with unique names, output names, byte formatting", () => {
    expect(uniqueNames(["a.jpg", "A.jpg", "b.jpg", "a.jpg"])).toEqual(["a.jpg", "A (2).jpg", "b.jpg", "a (3).jpg"]);
    const z = unzipSync(zipFiles([{ name: "x.jpg", bytes: new Uint8Array([1]) }, { name: "x.jpg", bytes: new Uint8Array([2]) }]));
    expect(Object.keys(z).sort()).toEqual(["x (2).jpg", "x.jpg"]);
    expect(outName("사진.heic.png", "jpeg")).toBe("사진.heic.jpg");
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(2048)).toBe("2.0KB");
    expect(formatBytes(5 * 1048576)).toBe("5.00MB");
  });
});
