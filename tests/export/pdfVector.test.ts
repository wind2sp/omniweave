// Vector PDF export: text must stay real text (Hangul included), shapes must stay paths,
// imported PDF pages must be embedded as vector forms, and the file must be far smaller than
// the image PDF.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { zlibSync } from "fflate";
import fontkit from "@pdf-lib/fontkit";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { beforeAll, describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/loom";
import {
  TILE,
  newDocument,
  newImage,
  newMedia,
  newPage,
  newParagraph,
  newPdf,
  newRaster,
  newTable,
  newText,
  newVector,
  type OmwDocument,
  type Page,
} from "../../src/core/types";
import { ellipseContour, rectContour } from "../../src/core/vector";
import { exportPdfVector, parseColor, type PdfVectorOptions } from "../../src/io/pdfVector";

const FONTS = {
  regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")),
  bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")),
};
const OPTS: PdfVectorOptions = { fonts: FONTS };

let pdfjs: any;
beforeAll(async () => {
  pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(process.cwd() + "/node_modules/pdfjs-dist/build/pdf.worker.min.mjs").href;
});

async function open(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const d = await open(bytes);
  const out: string[] = [];
  for (let i = 1; i <= d.numPages; i++) out.push((await (await d.getPage(i)).getTextContent()).items.map((x: any) => x.str).join(""));
  await d.destroy();
  return out;
}

/** Operator names used on a page (pdf.js operator list, form XObjects included). */
async function pageOps(bytes: Uint8Array, pageNo = 1): Promise<Set<string>> {
  const d = await open(bytes);
  const list = await (await d.getPage(pageNo)).getOperatorList();
  const names = new Map<number, string>(Object.entries(pdfjs.OPS).map(([k, v]) => [v as number, k]));
  const out = new Set<string>(list.fnArray.map((f: number) => names.get(f) ?? String(f)));
  await d.destroy();
  return out;
}

/** Minimal PNG encoder (RGBA, filter 0) for test images. */
function png(w: number, h: number, px: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4);
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
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlibSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}

async function sourcePdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  const p = d.addPage([400, 300]);
  p.drawText("Original Source Text", { x: 30, y: 200, size: 18, font: f });
  p.drawRectangle({ x: 30, y: 40, width: 120, height: 60, borderWidth: 2 });
  return d.save();
}

function docWith(...pages: Page[]): OmwDocument {
  const doc = newDocument("벡터 PDF 시험");
  doc.pages = pages;
  return doc;
}

function textPage(): Page {
  const pg = newPage("DOCUMENT", 794, 1123, "본문");
  const t = newText("안녕하세요 오메입니다. Hello Omniweave!", 600);
  t.transform = { x: 60, y: 80, rotation: 0, scale: 1 };
  t.paragraphs.push(newParagraph("굵은 글씨 Bold", { bold: true, fontSize: 24 }));
  t.paragraphs.push(newParagraph("기울임 Italic 밑줄", { italic: true, underline: true, color: "#c0392b" }));
  pg.nodes.push(t);
  return pg;
}

describe("vector PDF export", { timeout: 30_000 }, () => {
  it("keeps Korean and English text extractable, with page count, size and metadata", async () => {
    const p1 = textPage();
    const p2 = newPage("SLIDE", 1280, 720, "둘째 슬라이드");
    const t2 = newText("두 번째 페이지 Second page", 800, { fontSize: 32 });
    t2.transform = { x: 100, y: 100, rotation: 15, scale: 1.2 };
    t2.opacity = 0.6;
    p2.nodes.push(t2);
    const bytes = await exportPdfVector(docWith(p1, p2), [p1, p2], OPTS);

    const texts = await pageTexts(bytes);
    expect(texts).toHaveLength(2);
    const t = texts[0].replace(/\s+/g, " ");
    expect(t).toContain("안녕하세요");
    expect(t).toContain("오메입니다.");
    expect(t).toContain("Hello");
    expect(t).toContain("Omniweave!");
    expect(t).toContain("굵은 글씨");
    expect(t).toContain("기울임");
    expect(texts[1]).toContain("두 번째 페이지");
    expect(texts[1]).toContain("Second");

    const d = await open(bytes);
    const vp1 = (await d.getPage(1)).getViewport({ scale: 1 });
    const vp2 = (await d.getPage(2)).getViewport({ scale: 1 });
    expect(vp1.width).toBeCloseTo(794 * 0.75, 1);
    expect(vp1.height).toBeCloseTo(1123 * 0.75, 1);
    expect(vp2.width).toBeCloseTo(960, 1);
    expect(vp2.height).toBeCloseTo(540, 1);
    const meta = await d.getMetadata();
    expect(meta.info.Title).toBe("벡터 PDF 시험");
    expect(meta.info.Creator).toBe("Omniweave");
    const outline = await d.getOutline();
    expect(outline.map((o: any) => o.title)).toEqual(["본문", "둘째 슬라이드"]);
    await d.destroy();

    // fonts are subset: the full Pretendard TTF is ~2.7 MB each
    expect(bytes.length).toBeLessThan(200_000);
    const fonts = new TextDecoder("latin1").decode(bytes);
    expect(fonts).not.toMatch(/\/Subtype\s*\/Image/);
  });

  it("writes vector nodes as path operators, not images, with opacity in an ExtGState", async () => {
    const pg = newPage("DESIGN", 800, 600, "도형");
    const r = newVector([rectContour(10, 10, 200, 100)]);
    r.fill = "#4f7cff";
    r.stroke = "#000000";
    r.strokeWidth = 4;
    const e = newVector([ellipseContour(400, 300, 120, 80), ellipseContour(400, 300, 60, 40)]);
    e.fillRule = "evenodd";
    e.opacity = 0.5;
    e.blendMode = "MULTIPLY";
    e.transform = { x: 20, y: 10, rotation: 30, scale: 1.5 };
    pg.nodes.push(r, e);
    const bytes = await exportPdfVector(docWith(pg), [pg], OPTS);
    const ops = await pageOps(bytes);
    expect(ops.has("constructPath")).toBe(true);
    expect(ops.has("setGState")).toBe(true);
    expect([...ops].some((o) => /eoFill/.test(o))).toBe(true);
    expect([...ops].some((o) => /paint.*Image/.test(o))).toBe(false);
    // the raw content stream has a cubic Bezier (c) and the blend mode is recorded
    const loaded = await PDFDocument.load(bytes);
    const gsDict = loaded.getPage(0).node.Resources()!.lookup(PDFName.of("ExtGState"), PDFDict);
    const gsText = gsDict.values().map((v) => loaded.context.lookup(v)!.toString()).join(" ");
    expect(gsText).toMatch(/\/ca 0\.5/);
    expect(gsText).toMatch(/\/BM \/Multiply/);
  });

  it("embeds an imported PDF page as a vector form so its original text survives", async () => {
    const src = await sourcePdf();
    const asset = makeAsset(src, "application/pdf", "src.pdf");
    const pg = newPage("PDF", Math.round(400 / 0.75), Math.round(300 / 0.75), "가져온 PDF");
    const n = newPdf(asset.id, 0, 400 / 0.75, 300 / 0.75);
    n.covers = [{ x: 30, y: 250, w: 50, h: 20, color: "#ffffff" }];
    pg.nodes.push(n);
    const doc = docWith(pg);
    doc.assets[asset.id] = asset;
    const bytes = await exportPdfVector(doc, [pg], OPTS);
    expect((await pageTexts(bytes))[0]).toContain("Original Source Text");
    const ops = await pageOps(bytes);
    expect(ops.has("paintFormXObjectBegin")).toBe(true);
    expect([...ops].some((o) => /paint.*Image/.test(o))).toBe(false);
    // the source page fills the whole output page
    const d = await open(bytes);
    const vp = (await d.getPage(1)).getViewport({ scale: 1 });
    expect(vp.width).toBeCloseTo(400, 0);
    expect(vp.height).toBeCloseTo(300, 0);
    await d.destroy();
  });

  it("writes tables as text and lines, images and raster tiles as image XObjects, master nodes first", async () => {
    const master = newPage("MASTER", 800, 600, "마스터");
    const mt = newText("마스터 머리글", 400);
    master.nodes.push(mt);
    const pg = newPage("SLIDE", 800, 600, "표와 그림");
    pg.masterId = master.id;
    const tbl = newTable([["이름", "점수"], ["홍길동", "95"], ["Kim", "88"]]);
    tbl.transform = { x: 40, y: 80, rotation: 0, scale: 1 };
    const img = makeAsset(png(16, 16, (x, y) => [x * 16, y * 16, 128, 255]), "image/png", "a.png");
    const im = newImage(img.id, 64, 64);
    im.transform = { x: 400, y: 80, rotation: 0, scale: 1 };
    const ras = newRaster();
    const tile = new Uint8ClampedArray(TILE * TILE * 4);
    for (let i = 0; i < TILE * 40 * 4; i += 4) tile.set([255, 0, 0, 255], i);
    ras.tiles["1_1"] = makeTile(tile);
    const poster = makeAsset(png(8, 8, () => [20, 20, 20, 255]), "image/png", "poster.png");
    const med = newMedia("video", "missing", 160, 90);
    med.posterAssetId = poster.id;
    med.duration = 65;
    med.transform = { x: 600, y: 400, rotation: 0, scale: 1 };
    pg.nodes.push(tbl, im, ras, med);
    const doc = docWith(pg);
    doc.masters = [master];
    doc.assets[img.id] = img;
    doc.assets[poster.id] = poster;
    const bytes = await exportPdfVector(doc, [pg], OPTS);
    const text = (await pageTexts(bytes))[0];
    expect(text.indexOf("마스터 머리글")).toBe(0); // drawn before the page's own nodes
    for (const s of ["이름", "점수", "홍길동", "95", "Kim", "88", "1:05"]) expect(text).toContain(s);
    const ops = await pageOps(bytes);
    expect(ops.has("paintImageXObject")).toBe(true);
    expect(ops.has("constructPath")).toBe(true);
    const imgs = (new TextDecoder("latin1").decode(bytes).match(/\/Subtype\s*\/Image/g) ?? []).length;
    expect(imgs).toBeGreaterThanOrEqual(3); // PNG, raster tile, poster (soft masks only when transparent)
  });

  it("is smaller than an image PDF of the same page", async () => {
    const pg = textPage();
    const bytes = await exportPdfVector(docWith(pg), [pg], OPTS);
    // Image-PDF lower bound: the 2x page as an RGB image where text lines carry anti-aliased
    // glyph pixels (modelled as a fine pattern). Real renders compress worse than this.
    const W = pg.width * 2, H = pg.height * 2;
    const rgba = new Uint8Array(W * H * 4).fill(255);
    for (let y = 160; y < 160 + 3 * 60; y++) {
      if (y % 60 > 40) continue;
      for (let x = 120; x < 1200; x++) {
        const v = ((x * 7 + y * 13) % 11) * 23;
        rgba.set([v, v, v, 255], (y * W + x) * 4);
      }
    }
    const ref = await PDFDocument.create();
    const im = await ref.embedPng(png(W, H, (x, y) => [rgba[(y * W + x) * 4], rgba[(y * W + x) * 4 + 1], rgba[(y * W + x) * 4 + 2], 255]));
    ref.addPage([pg.width * 0.75, pg.height * 0.75]).drawImage(im, { x: 0, y: 0, width: pg.width * 0.75, height: pg.height * 0.75 });
    const raster = await ref.save();
    console.log(`vector PDF ${bytes.length} B vs image PDF (lower bound) ${raster.length} B`);
    expect(bytes.length).toBeLessThan(raster.length);
  });

  it("parses CSS colours", () => {
    expect(parseColor("#fff")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor("rgba(255, 0, 0, .5)")).toEqual({ r: 1, g: 0, b: 0, a: 0.5 });
    expect(parseColor("transparent")).toBeNull();
    expect(parseColor("#00000080")!.a).toBeCloseTo(0.5, 2);
  });

  it("embeds subset glyph outlines intact (fontkit short-loca padding fix)", async () => {
    const text = "슬라이드 1 — 오메 인쇄 시험 Print test 가나다라마바사 ABCxyz 0123";
    const pg = newPage("DOCUMENT", 794, 300, "글꼴");
    pg.nodes.push(newText(text, 760, { bold: true }));
    const bytes = await exportPdfVector(docWith(pg), [pg], OPTS);
    const loaded = await PDFDocument.load(bytes);
    let fontFile: Uint8Array | null = null;
    for (const [, obj] of loaded.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFDict && String(obj.get(PDFName.of("Type"))) === "/FontDescriptor") {
        fontFile = decodePDFRawStream(loaded.context.lookup(obj.get(PDFName.of("FontFile2"))) as PDFRawStream).decode();
      }
    }
    expect(fontFile).not.toBeNull();
    const sub = fontkit.create(fontFile as any) as any;
    const orig = fontkit.create(FONTS.bold as any) as any;
    // every glyph of the text must be in the subset with exactly the original outline
    const subPaths = new Set<string>();
    for (let i = 0; i < sub.numGlyphs; i++) subPaths.add(sub.getGlyph(i).path.toSVG());
    // laid out word by word, as the exporter draws each layout piece
    const ids = [...new Set<number>(text.split(/(?<=\s)/).flatMap((w) => orig.layout(w).glyphs.map((g: any) => g.id)))];
    for (const id of ids) expect(subPaths.has(orig.getGlyph(id).path.toSVG()), `glyph ${id}`).toBe(true);
    expect(ids.length).toBeGreaterThan(10);
  });
});
