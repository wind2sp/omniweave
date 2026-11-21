// QA regressions for the vector PDF writer: font URL under a sub-path, characters the embedded
// font cannot draw, shared resources of imported multi-page PDFs, crop-box placement.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { zlibSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { newDocument, newPage, newPdf, newTable, newText, type OmwDocument, type Page } from "../../src/core/types";
import { exportPdfVector, fontUrl, type PdfVectorOptions } from "../../src/io/pdfVector";

const FONTS = {
  regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")),
  bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")),
};

let pdfjs: any;
beforeAll(async () => {
  pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
});

async function items(bytes: Uint8Array, pageNo = 1): Promise<{ str: string; transform: number[] }[]> {
  const d = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  const tc = await (await d.getPage(pageNo)).getTextContent();
  await d.destroy();
  return tc.items;
}

function docOf(pages: Page[], extra: Partial<OmwDocument> = {}): OmwDocument {
  const d = newDocument("QA");
  d.pages = pages;
  Object.assign(d, extra);
  return d;
}

/** 1×1 opaque PNG (for the rasterize stub). */
function tinyPng(): Uint8Array {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length);
    const dv = new DataView(b.buffer);
    dv.setUint32(0, data.length);
    b.set(new TextEncoder().encode(type), 4);
    b.set(data, 8);
    dv.setUint32(8 + data.length, crc(b.subarray(4, 8 + data.length)));
    return b;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1);
  new DataView(ihdr.buffer).setUint32(4, 1);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(new Uint8Array([0, 10, 20, 30, 255]))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

describe("vector PDF — QA regressions", () => {
  it("resolves the font URL next to the app, also under a sub-path such as /app/", () => {
    const g = globalThis as any;
    const prev = g.location;
    try {
      g.location = { href: "https://example.test/app/index.html?demo" };
      expect(fontUrl("Pretendard-Regular.ttf")).toBe("https://example.test/app/fonts/Pretendard-Regular.ttf");
      g.location = { href: "tauri://localhost/" };
      expect(fontUrl("Pretendard-Bold.ttf")).toBe("tauri://localhost/fonts/Pretendard-Bold.ttf");
    } finally {
      g.location = prev;
    }
  });

  it("tabs never become U+0000 glyphs", async () => {
    const pg = newPage("DOCUMENT", 400, 300, "t");
    pg.nodes.push(newText("A\tB", 300));
    const out = await exportPdfVector(docOf([pg]), [pg], { fonts: FONTS });
    const s = (await items(out)).map((i) => i.str).join("");
    expect(s).not.toContain("\u0000");
    expect(s.replace(/\s+/g, "")).toBe("AB");
  });

  it("characters missing from Pretendard (Hanja, emoji) are warned about and drawn as an image with a searchable text layer", async () => {
    const pg = newPage("DOCUMENT", 400, 300, "t");
    const t = newText("한자 漢字 ok 😀", 300);
    t.name = "본문";
    pg.nodes.push(t);
    const tb = newTable([["표 漢", "b"]]);
    pg.nodes.push(tb);

    // no rasteriser (Node): still exported, but the loss is reported
    const warns: string[] = [];
    await exportPdfVector(docOf([pg]), [pg], { fonts: FONTS, onWarning: (m) => warns.push(m) });
    expect(warns.some((w) => w.includes("漢") && w.includes("본문"))).toBe(true);
    expect(warns.length).toBe(2); // text and table

    // with a rasteriser: the node becomes an image, its text stays extractable (invisible layer)
    const rastered: string[] = [];
    const opts: PdfVectorOptions = {
      fonts: FONTS,
      rasterize: async (_p, n) => (rastered.push(n.id), { png: tinyPng(), x: 0, y: 0, w: 10, h: 10 }),
      onWarning: () => {},
    };
    const out = await exportPdfVector(docOf([pg]), [pg], opts);
    expect(rastered).toEqual([t.id, tb.id]);
    expect(new TextDecoder("latin1").decode(out)).toMatch(/\/Subtype\s*\/Image/);
    const s = (await items(out)).map((i) => i.str).join("");
    expect(s).toContain("한자");
    expect(s).toContain("ok");
    expect(s).toContain("표");
  });

  it("pages of one imported PDF share its resources instead of copying the font per page", async () => {
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const f = await d.embedFont(FONTS.regular, { subset: false });
    for (let i = 0; i < 6; i++) d.addPage([400, 300]).drawText("페이지 " + i, { x: 20, y: 200, size: 20, font: f });
    const src = await d.save();
    const asset = makeAsset(src, "application/pdf", "s.pdf");
    const pages = Array.from({ length: 6 }, (_, i) => {
      const pg = newPage("PDF", 533, 400, "p" + i);
      pg.nodes.push(newPdf(asset.id, i, 533, 400));
      return pg;
    });
    const out = await exportPdfVector(docOf(pages, { assets: { [asset.id]: asset } }), pages, { fonts: FONTS });
    expect(out.length).toBeLessThan(src.length * 1.5);
    for (let i = 1; i <= 6; i++) expect((await items(out, i)).map((x) => x.str).join("")).toContain(`페이지 ${i - 1}`);
  }, 60_000);

  it("places an imported page by its crop box", async () => {
    const d = await PDFDocument.create();
    const hf = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([500, 400]);
    p.setCropBox(100, 50, 300, 200);
    p.drawText("CROPTEXT", { x: 110, y: 230, size: 12, font: hf });
    const asset = makeAsset(await d.save(), "application/pdf", "c.pdf");
    const pg = newPage("PDF", 400, 800 / 3, "p");
    pg.nodes.push(newPdf(asset.id, 0, 400, 800 / 3));
    const out = await exportPdfVector(docOf([pg], { assets: { [asset.id]: asset } }), [pg], { fonts: FONTS });
    const it0 = (await items(out)).find((i) => i.str === "CROPTEXT")!;
    expect(it0.transform[4]).toBeCloseTo(10, 0);
    expect(it0.transform[5]).toBeCloseTo(180, 0);
  });
});
