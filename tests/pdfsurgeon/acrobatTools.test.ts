// Acrobat's document tools (src/io/pdfsurgeon/acrobat.ts, redact.ts): each result is read back with pdf.js / pdf-lib.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, rgb } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  addBackground,
  addFormFields,
  addHeaderFooter,
  addLinks,
  addWatermark,
  bookmarksFromLines,
  cropPages,
  getBookmarks,
  getPageLabels,
  listLinks,
  parsePageRange,
  replacePages,
  saveAsPdfA,
  setBookmarks,
  setPageLabels,
  tocLine,
} from "../../src/io/pdfsurgeon/acrobat";
import { applyRedactions, documentLines, glyphsInside, pagePictures, replacePicture, searchRedactions } from "../../src/io/pdfsurgeon/redact";
import { fallbackFont, openJs } from "./helpers";

const ROOT = join(__dirname, "..", "..");
const word = () => new Uint8Array(readFileSync(join(ROOT, "qa", "interop", "adobe-made", "word_doc.docx.ref.pdf")));

async function textOf(bytes: Uint8Array, page = 0): Promise<string> {
  const d = await openJs(bytes);
  const c = await (await d.getPage(page + 1)).getTextContent();
  return (c.items as { str: string }[]).map((i) => i.str).join("");
}

/** every stream of the file, decoded where it is deflated (what a text search of the file could find) */
function allStreams(bytes: Uint8Array): string {
  const s = Buffer.from(bytes).toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const raw = bytes.subarray(start, end);
    try {
      out += Buffer.from(inflateSync(raw)).toString("latin1");
    } catch {
      out += Buffer.from(raw).toString("latin1");
    }
  }
  return out;
}

async function sample(pages = 3): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  const f = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([595, 842]);
    p.drawText(`Page ${i + 1} title`, { x: 72, y: 760, size: 20, font: f });
    p.drawText(`Secret code OMW-${i + 1}234 and public words`, { x: 72, y: 700, size: 12, font: f });
    p.drawText("Plain line after", { x: 72, y: 680, size: 12, font: f });
  }
  return d.save();
}

describe("page ranges", () => {
  it("parses Acrobat-style ranges", () => {
    expect(parsePageRange("", 4)).toEqual([0, 1, 2, 3]);
    expect(parsePageRange("1-2, 4", 5)).toEqual([0, 1, 3]);
    expect(parsePageRange("3-", 5)).toEqual([2, 3, 4]);
    expect(parsePageRange("짝수", 5)).toEqual([1, 3]);
  });
});

describe("watermark, header / footer, background", () => {
  it("writes a text watermark on the chosen pages only", async () => {
    const out = await addWatermark(await sample(), { text: "CONFIDENTIAL", opacity: 0.3, rotation: 45, pages: "1,3" });
    expect(await textOf(out, 0)).toContain("CONFIDENTIAL");
    expect(await textOf(out, 1)).not.toContain("CONFIDENTIAL");
    // resource names written once with their slash (Acrobat refuses "//Name": "Error while parsing a Form")
    expect(allStreams(out)).not.toMatch(/\/\/Omw/);
    expect(await textOf(out, 2)).toContain("CONFIDENTIAL");
    // the page's own text is still there
    expect(await textOf(out, 0)).toContain("Page 1 title");
  });
  it("writes a Korean watermark with the TrueType fallback", async () => {
    const out = await addWatermark(await sample(1), { text: "대외비 오메", font: fallbackFont, behind: true });
    expect(await textOf(out)).toContain("대외비 오메");
  });
  it("numbers pages and Bates-stamps them", async () => {
    const out = await addHeaderFooter(await sample(3), { slots: { bottomCenter: "{page} / {pages}", topRight: "{bates}", topLeft: "{date}" }, bates: { prefix: "OMW", start: 7, digits: 5 }, date: new Date(2026, 10, 24) });
    expect(await textOf(out, 1)).toContain("2 / 3");
    expect(await textOf(out, 2)).toContain("OMW00009");
    expect(await textOf(out, 0)).toContain("2026-11-24");
  });
  it("puts a background behind the content", async () => {
    const out = await addBackground(await sample(1), { color: [1, 1, 0.8] });
    const d = await PDFDocument.load(out);
    const contents = d.getPage(0).node.Contents();
    expect(contents).toBeTruthy();
    expect(await textOf(out)).toContain("Page 1 title");
  });
});

describe("bookmarks, links, page labels", () => {
  it("writes and reads a bookmark tree", async () => {
    const list = [
      { title: "첫 장", page: 0, open: true, children: [{ title: "1.1 절", page: 1, children: [] }] },
      { title: "Web", page: null, url: "https://example.com/", children: [] },
      { title: "끝", page: 2, bold: true, children: [] },
    ];
    const out = await setBookmarks(await sample(3), list);
    const back = await getBookmarks(out);
    expect(back.map((b) => b.title)).toEqual(["첫 장", "Web", "끝"]);
    expect(back[0].children[0]).toMatchObject({ title: "1.1 절", page: 1 });
    expect(back[1].url).toBe("https://example.com/");
    expect(back[2]).toMatchObject({ page: 2, bold: true });
    const js = await openJs(out);
    const ol = await js.getOutline();
    expect(ol.map((o: { title: string }) => o.title)).toEqual(["첫 장", "Web", "끝"]);
    // removing every bookmark removes the outline
    expect(await getBookmarks(await setBookmarks(out, []))).toEqual([]);
  });
  it("finds bookmarks in a table of contents", () => {
    expect(tocLine("1.2 개요 ........ 12")).toEqual({ title: "1.2 개요", num: 12, level: 1 });
    const lines = [
      [{ text: "목차", size: 20 }, { text: "1 Intro ..... 1", size: 11 }, { text: "2 Body ..... 2", size: 11 }, { text: "2.1 Part ..... 2", size: 11 }],
      [{ text: "1 Intro", size: 18 }, { text: "text", size: 11 }],
      [{ text: "2 Body", size: 18 }, { text: "2.1 Part", size: 14 }],
    ];
    const bm = bookmarksFromLines(lines);
    expect(bm.map((b) => [b.title, b.page])).toEqual([["1 Intro", 1], ["2 Body", 2]]);
    expect(bm[1].children[0]).toMatchObject({ title: "2.1 Part", page: 2 });
  });
  it("adds page and web links", async () => {
    const out = await addLinks(await sample(3), [
      { page: 0, rect: [72, 690, 300, 715], toPage: 2 },
      { page: 1, rect: [72, 690, 300, 715], url: "https://omniweave.example/", border: [0, 0, 1] },
    ]);
    const links = await listLinks(out);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ page: 0, toPage: 2 });
    expect(links[1]).toMatchObject({ page: 1, url: "https://omniweave.example/" });
    const ann = await (await (await openJs(out)).getPage(2)).getAnnotations();
    expect(ann.find((a: { url?: string }) => a.url === "https://omniweave.example/")).toBeTruthy();
  });
  it("labels pages i, ii, 1, 2", async () => {
    const out = await setPageLabels(await sample(4), [{ start: 0, style: "r" }, { start: 2, style: "D", prefix: "A-" }]);
    expect(await getPageLabels(out)).toEqual(["i", "ii", "A-1", "A-2"]);
    const js = await openJs(out);
    expect(await js.getPageLabels()).toEqual(["i", "ii", "A-1", "A-2"]);
  });
});

describe("pages", () => {
  it("replaces pages with pages of another file", async () => {
    const other = await PDFDocument.create();
    const f = await other.embedFont(StandardFonts.Helvetica);
    other.addPage([400, 400]).drawText("Replacement", { x: 20, y: 200, size: 20, font: f });
    const out = await replacePages(await sample(3), [1], await other.save(), [0]);
    const d = await PDFDocument.load(out);
    expect(d.getPageCount()).toBe(3);
    expect(await textOf(out, 1)).toContain("Replacement");
    expect(await textOf(out, 2)).toContain("Page 3 title");
  });
  it("crops by margins", async () => {
    const out = await cropPages(await sample(2), { pages: "2", margins: { top: 50, bottom: 40, left: 30, right: 20 } });
    const d = await PDFDocument.load(out);
    expect(d.getPage(0).getCropBox()).toMatchObject({ x: 0, y: 0, width: 595, height: 842 });
    expect(d.getPage(1).getCropBox()).toMatchObject({ x: 30, y: 40, width: 545, height: 752 });
  });
});

describe("forms", () => {
  it("creates every field kind with required flag, number format and tab order", async () => {
    const out = await addFormFields(await sample(1), [
      { kind: "text", name: "이름", page: 0, rect: [72, 600, 272, 620], required: true, tooltip: "성명" },
      { kind: "text", name: "amount", page: 0, rect: [72, 570, 272, 590], format: { kind: "number", decimals: 2 } },
      { kind: "checkbox", name: "agree", page: 0, rect: [72, 540, 86, 554] },
      { kind: "radio", name: "size", page: 0, rect: [72, 510, 86, 524], value: "S" },
      { kind: "radio", name: "size", page: 0, rect: [100, 510, 114, 524], value: "L" },
      { kind: "dropdown", name: "city", page: 0, rect: [72, 480, 200, 500], options: ["Seoul", "Busan"] },
      { kind: "list", name: "fruit", page: 0, rect: [72, 400, 200, 470], options: ["사과", "배"] },
      { kind: "button", name: "send", page: 0, rect: [220, 480, 300, 500], label: "보내기" },
      { kind: "signature", name: "sign", page: 0, rect: [320, 480, 480, 520] },
    ], { tabOrder: "R" });
    const d = await PDFDocument.load(out);
    const names = d.getForm().getFields().map((f) => f.getName());
    expect(names).toEqual(expect.arrayContaining(["이름", "amount", "agree", "size", "city", "fruit", "send", "sign"]));
    expect(d.getForm().getTextField("이름").isRequired()).toBe(true);
    expect(d.getForm().getRadioGroup("size").getOptions()).toEqual(["S", "L"]);
    expect(d.getPage(0).node.get(PDFName.of("Tabs"))?.toString()).toBe("/R");
    const ann = await (await (await openJs(out)).getPage(1)).getAnnotations();
    expect(ann.filter((a: { subtype: string }) => a.subtype === "Widget").length).toBeGreaterThanOrEqual(9);
    expect(ann.find((a: { fieldName: string }) => a.fieldName === "sign")?.fieldType).toBe("Sig");
  });
});

describe("PDF/A", () => {
  it("identifies the file as PDF/A-2b with an sRGB output intent", async () => {
    const { bytes } = await saveAsPdfA(await sample(1), { title: "Omniweave QA" });
    const d = await PDFDocument.load(bytes, { updateMetadata: false });
    const meta = d.context.lookup(d.catalog.get(PDFName.of("Metadata"))) as PDFRawStream;
    const xmp = Buffer.from(meta.contents).toString("utf8");
    expect(xmp).toContain("<pdfaid:part>2</pdfaid:part>");
    expect(xmp).toContain("Omniweave QA");
    expect(d.catalog.get(PDFName.of("OutputIntents"))).toBeTruthy();
    expect(d.context.trailerInfo.ID).toBeTruthy();
  });
});

describe("redaction", () => {
  it("removes the covered text from the file, keeps the rest in place", async () => {
    const src = await sample(2);
    const hits = await searchRedactions(src, "OMW-1234");
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(0);
    const { bytes, report } = await applyRedactions(src, hits.map((h) => ({ page: h.page, rect: h.rect })), { fill: [0, 0, 0], overlay: "REDACTED" });
    expect(report.glyphs).toBeGreaterThanOrEqual(8);
    const t0 = await textOf(bytes, 0);
    expect(t0).not.toContain("OMW-1234");
    expect(t0).toContain("Secret code");
    expect(t0).toContain("and public words");
    expect(t0).toContain("REDACTED");
    expect(allStreams(bytes)).not.toMatch(/\/\/Omw/);
    expect(await textOf(bytes, 1)).toContain("OMW-2234");
    expect(await glyphsInside(bytes, 0, hits[0].rect)).toBe("REDACTED"); // only the overlay text is left there
    // nowhere in the file, compressed or not
    expect(allStreams(bytes)).not.toContain("OMW-1234");
    expect(Buffer.from(bytes).toString("latin1")).not.toContain("OMW-1234");
    // the words after the cut stay where they were
    const lines = await documentLines(bytes);
    const before = (await documentLines(src))[0].find((l) => l.text.includes("public"))!;
    const after = lines[0].find((l) => l.text.includes("public"))!;
    const g0 = before.glyphs.find((g) => g.ch === "p")!, g1 = after.glyphs.find((g) => g.ch === "p")!;
    expect(Math.abs(g0.box[0] - g1.box[0])).toBeLessThan(0.05);
  });
  it("redacts the Word-made sample by area, with its comments and metadata", async () => {
    const src = word();
    const lines = (await documentLines(src))[0];
    const target = lines.find((l) => l.text.replace(/\s/g, "").length > 6)!;
    const { bytes, report } = await applyRedactions(src, [{ page: 0, rect: target.box }], { scrubMetadata: true });
    expect(report.glyphs).toBeGreaterThan(5);
    expect(await glyphsInside(bytes, 0, target.box)).toBe("");
    const js = await openJs(bytes);
    const meta = await js.getMetadata();
    expect(meta.info.Author ?? "").toBe("");
    expect(meta.info.Title ?? "").toBe("");
  });
  it("paints the covered pixels of a picture and keeps the rest", async () => {
    const d = await PDFDocument.create();
    const w = 40, h = 20;
    // a white 8-bit RGB image, drawn 200 x 100 pt
    const raw = new Uint8Array(w * h * 3).fill(255);
    const { deflateSync } = await import("node:zlib");
    const img = d.context.flateStream(raw, { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 });
    void deflateSync;
    const ref = d.context.register(img);
    const p = d.addPage([400, 400]);
    const nm = p.node.newXObject("Im", ref);
    p.pushOperators();
    const cs = d.context.register(d.context.flateStream(`q 200 0 0 100 100 100 cm ${nm} Do Q`));
    p.node.set(PDFName.of("Contents"), cs);
    void rgb;
    const src = await d.save();
    // cover the left half of the picture
    const { bytes, report } = await applyRedactions(src, [{ page: 0, rect: [90, 90, 200, 210] }], { fill: [0, 0, 0] });
    expect(report.images).toBe(1);
    const out = await PDFDocument.load(bytes);
    const imgs = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o): o is PDFRawStream => o instanceof PDFRawStream && o.dict.get(PDFName.of("Subtype"))?.toString() === "/Image");
    expect(imgs).toHaveLength(1);
    const px = inflateSync(imgs[0].contents);
    expect(px[0]).toBe(0); // top-left: painted
    expect(px[(w - 1) * 3]).toBe(255); // top-right: kept
  });
  it("replaces a picture in place", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([400, 400]);
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
    const im = await d.embedPng(png);
    p.drawImage(im, { x: 50, y: 50, width: 100, height: 60 });
    const src = await d.save();
    const pics = await pagePictures(src, 0);
    expect(pics).toHaveLength(1);
    const out = await replacePicture(src, 0, pics[0].op, { bytes: new Uint8Array(png), mime: "image/png" }, "fill");
    const after = await pagePictures(out, 0);
    expect(after).toHaveLength(1);
    expect(after[0].box.map((v) => Math.round(v))).toEqual(pics[0].box.map((v) => Math.round(v)));
    expect(after[0].name).not.toBe(pics[0].name);
  });
});

describe("redaction: the harder places", () => {
  it("removes covered glyphs of vertical text (Identity-V) and keeps the others in place", async () => {
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const f = await d.embedFont(await fallbackFont(), { subset: true });
    const p = d.addPage([595, 842]);
    const hexCodes = f.encodeText("ABCD").toString();
    const nm = p.node.newFontDictionary("V", f.ref);
    p.node.set(PDFName.of("Contents"), d.context.register(d.context.flateStream(`BT /${nm.decodeText()} 20 Tf 1 0 0 1 300 700 Tm ${hexCodes} Tj ET`)));
    const src0 = await d.save();
    // the font written vertical
    const d2 = await PDFDocument.load(src0);
    for (const [, o] of d2.context.enumerateIndirectObjects()) if (o instanceof PDFDict && o.get(PDFName.of("Subtype"))?.toString() === "/Type0") o.set(PDFName.of("Encoding"), PDFName.of("Identity-V"));
    const src = await d2.save();
    // the third glyph hangs from y 660 to 640
    const { bytes, report } = await applyRedactions(src, [{ page: 0, rect: [288, 642, 312, 658] }], { fill: null });
    expect(report.glyphs).toBe(1);
    const t = await textOf(bytes);
    expect(t.replace(/\s/g, "")).toBe("ABD");
    expect(await glyphsInside(bytes, 0, [285, 682, 315, 698])).toBe("A");
  });
  it("removes text from a tiling pattern's cell under a mark", async () => {
    const d = await PDFDocument.create();
    const font = await d.embedFont(StandardFonts.Helvetica);
    const p = d.addPage([400, 400]);
    const cell = d.context.stream("BT /F1 12 Tf 5 20 Td (SECRETX) Tj ET", { Type: "Pattern", PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 100, 50], XStep: 100, YStep: 50, Resources: d.context.obj({ Font: d.context.obj({ F1: font.ref }) }) });
    const pat = d.context.register(cell);
    p.node.normalize();
    (p.node.Resources()!).set(PDFName.of("Pattern"), d.context.obj({ P0: pat }));
    p.node.set(PDFName.of("Contents"), d.context.register(d.context.flateStream("/Pattern cs /P0 scn 0 0 400 400 re f")));
    const { bytes, report } = await applyRedactions(await d.save(), [{ page: 0, rect: [0, 0, 400, 400] }], { fill: null });
    expect(report.patterns).toBe(1);
    expect(allStreams(bytes)).not.toContain("SECRETX");
    expect(allStreams(bytes)).not.toContain("<53454352455458>");
  });
  it("cuts a vector path that is only partly under a mark", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([400, 400]);
    p.node.set(PDFName.of("Contents"), d.context.register(d.context.flateStream("2 w 50 50 250 250 re S")));
    const { bytes, report } = await applyRedactions(await d.save(), [{ page: 0, rect: [100, 100, 380, 380] }], { fill: null });
    expect(report.pathsCut).toBe(1);
    // the stroke is cut at the mark: no point of the rewritten path lies inside it
    const pts = [...allStreams(bytes).matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]\b/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(pts.length).toBeGreaterThan(4);
    expect(pts.filter(([x, y]) => x > 100.01 && x < 379.99 && y > 100.01 && y < 379.99)).toEqual([]);
    expect(allStreams(bytes)).not.toContain("250 250 re");
  });
  it("cuts a filled area by the mark (area difference, no coordinate inside)", async () => {
    const d = await PDFDocument.create();
    const p = d.addPage([400, 400]);
    p.node.set(PDFName.of("Contents"), d.context.register(d.context.flateStream("0 0 1 rg 20 20 200 200 re f 0 1 0 rg 300 300 m 350 380 l 390 300 l h f")));
    const { bytes, report } = await applyRedactions(await d.save(), [{ page: 0, rect: [120, 120, 260, 260] }], { fill: null });
    expect(report.pathsCut).toBe(1);
    const s = allStreams(bytes);
    const pts = [...s.matchAll(/(-?[\d.]+) (-?[\d.]+) [ml]\b/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(pts.filter(([x, y]) => x > 120.01 && x < 259.99 && y > 120.01 && y < 259.99)).toEqual([]);
    expect(s).toContain("f*");
    expect(s).toContain("300 300 m"); // the triangle away from the mark is left as it was
  });
  it("takes a covered picture out of a form drawn on two pages, for the marked page only", async () => {
    const d = await PDFDocument.create();
    const w = 8, h = 8;
    const img = d.context.register(d.context.flateStream(new Uint8Array(w * h * 3).fill(200), { Type: "XObject", Subtype: "Image", Width: w, Height: h, ColorSpace: "DeviceRGB", BitsPerComponent: 8 }));
    const form = d.context.register(d.context.flateStream("q 100 0 0 100 50 50 cm /Im0 Do Q", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 400, 400], Resources: d.context.obj({ XObject: d.context.obj({ Im0: img }) }) }));
    for (let i = 0; i < 2; i++) {
      const p = d.addPage([400, 400]);
      p.node.normalize();
      (p.node.Resources()!).set(PDFName.of("XObject"), d.context.obj({ Fm0: form }));
      p.node.set(PDFName.of("Contents"), d.context.register(d.context.flateStream("/Fm0 Do")));
    }
    const { bytes } = await applyRedactions(await d.save(), [{ page: 0, rect: [40, 40, 160, 160] }], { fill: null });
    const out = await PDFDocument.load(bytes);
    const xoOf = (i: number) => out.context.lookup(out.getPage(i).node.Resources()!.get(PDFName.of("XObject"))) as PDFDict;
    const formOf = (i: number) => out.context.lookup([...xoOf(i).entries()][0][1]) as PDFRawStream;
    const imgs = (i: number) => (out.context.lookup((out.context.lookup(formOf(i).dict.get(PDFName.of("Resources"))) as PDFDict).get(PDFName.of("XObject"))) as PDFDict | undefined)?.keys().length ?? 0;
    expect(imgs(0)).toBe(0); // the marked page's copy of the form no longer refers to the picture
    expect(imgs(1)).toBe(1); // the other page keeps it
  });
});

describe("fonts: subset when shrinking, embed for PDF/A", () => {
  it("cuts a whole embedded TrueType font down to the glyphs shown, text unchanged", async () => {
    const { subsetFonts } = await import("../../src/io/pdfsurgeon/fontSubset");
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    const d = await PDFDocument.create();
    d.registerFontkit(fontkit);
    const f = await d.embedFont(await fallbackFont(), { subset: false });
    d.addPage([400, 400]).drawText("오메 글꼴 Subset 123", { x: 40, y: 300, size: 18, font: f });
    const src = await d.save();
    const { bytes, report } = await subsetFonts(src);
    expect(report.fonts).toHaveLength(1);
    expect(bytes.length).toBeLessThan(src.length / 4);
    expect((await textOf(bytes)).replace(/\s/g, "")).toBe("오메글꼴Subset123");
    // the program in the file has just the glyphs used (+ .notdef) and parses
    const out = await PDFDocument.load(bytes);
    const ff = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).find((o): o is PDFRawStream => o instanceof PDFRawStream && !!o.dict.get(PDFName.of("Length1")))!;
    const prog = fontkit.create(Buffer.from(inflateSync(ff.contents)));
    expect(prog.numGlyphs).toBeLessThan(20);
    expect(await subsetFonts(bytes).then((r) => r.report.fonts.length)).toBe(0); // already a subset: left alone
  });
  it("embeds Liberation Sans for left-out Helvetica, with matching widths", async () => {
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Helvetica);
    d.addPage([400, 400]).drawText("Hello PDF/A", { x: 40, y: 300, size: 18, font: f });
    const lib = (s: string) => Promise.resolve(new Uint8Array(readFileSync(join(ROOT, "node_modules/pdfjs-dist/standard_fonts", `LiberationSans-${s}.ttf`))));
    const { bytes, notes } = await saveAsPdfA(await d.save(), { title: "QA", sansProgram: lib });
    expect(notes).toContain("embedded:1");
    expect(notes.some((n) => n.startsWith("fonts:"))).toBe(false);
    const out = await PDFDocument.load(bytes);
    const font = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).find((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of("Type"))?.toString() === "/Font")!;
    expect(font.get(PDFName.of("Subtype"))?.toString()).toBe("/TrueType");
    const widths = (out.context.lookup(font.get(PDFName.of("Widths"))) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((x) => x.asNumber());
    // Helvetica's own AFM widths: H 722, e 556, space 278
    expect(widths["H".charCodeAt(0) - 32]).toBe(722);
    expect(widths["e".charCodeAt(0) - 32]).toBe(556);
    expect(widths[0]).toBe(278);
    expect(await textOf(bytes)).toContain("Hello PDF/A");
  });
});

describe("PDF/A: Courier", () => {
  it("embeds a monospaced Type 1 program for left-out Courier, widths 600 from the program", async () => {
    const { cffMonoInfo } = await import("../../src/io/pdfsurgeon/acrobat");
    const pfbOf = (s: string) => new Uint8Array(readFileSync(join(ROOT, "node_modules/pdfjs-dist/standard_fonts", `FoxitFixed${s === "Regular" ? "" : s}.pfb`)));
    // pdf.js ships these as bare CFF (Type1C): monospaced, every glyph 600 wide
    for (const s of ["Regular", "Bold", "Italic", "BoldItalic"]) expect(cffMonoInfo(pfbOf(s))?.width, s).toBe(600);
    const d = await PDFDocument.create();
    const f = await d.embedFont(StandardFonts.Courier);
    const fb = await d.embedFont(StandardFonts.CourierBold);
    const pg = d.addPage([400, 400]);
    pg.drawText("Courier line", { x: 40, y: 300, size: 14, font: f });
    pg.drawText("Courier bold", { x: 40, y: 280, size: 14, font: fb });
    const { bytes, notes } = await saveAsPdfA(await d.save(), { monoProgram: (s) => Promise.resolve(pfbOf(s)) });
    expect(notes).toContain("embedded:2");
    const out = await PDFDocument.load(bytes);
    const fonts = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of("Type"))?.toString() === "/Font");
    for (const font of fonts) {
      const fd = out.context.lookup(font.get(PDFName.of("FontDescriptor"))) as PDFDict;
      expect(fd.get(PDFName.of("FontFile3"))).toBeTruthy();
      const widths = (out.context.lookup(font.get(PDFName.of("Widths"))) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((x) => x.asNumber());
      expect(widths["C".charCodeAt(0) - 32]).toBe(600);
    }
    expect(await textOf(bytes)).toContain("Courier line");
  });
});

describe("PDF/A: Times", () => {
  it("embeds the cut-down Liberation Serif (Omni PDFA Serif) for left-out Times, Times' own widths", async () => {
    const d = await PDFDocument.create();
    const pg = d.addPage([400, 400]);
    pg.drawText("Times line é’", { x: 40, y: 300, size: 14, font: await d.embedFont(StandardFonts.TimesRoman) });
    pg.drawText("Times bold italic", { x: 40, y: 280, size: 14, font: await d.embedFont(StandardFonts.TimesRomanBoldItalic) });
    const serif = (s: string) => Promise.resolve(new Uint8Array(readFileSync(join(ROOT, "assets/fonts/pdfa", `OmniPDFASerif-${s}.ttf`))));
    // a modified OFL font: not named with the Reserved Font Name "Liberation" (OFL §3)
    const { default: fontkit } = await import("@pdf-lib/fontkit");
    const prog = fontkit.create(Buffer.from(await serif("Regular")));
    expect(prog.familyName).toBe("Omni PDFA Serif");
    expect(prog.postscriptName).toBe("OmniPDFASerif-Regular");
    const { bytes, notes } = await saveAsPdfA(await d.save(), { serifProgram: serif });
    expect(notes).toContain("embedded:2");
    expect(notes.some((n) => n.startsWith("fonts:"))).toBe(false);
    const out = await PDFDocument.load(bytes);
    const fonts = [...out.context.enumerateIndirectObjects()].map(([, o]) => o).filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of("Type"))?.toString() === "/Font");
    const regular = fonts.find((f) => !/Bold/.test(String(f.get(PDFName.of("BaseFont")))))!;
    const widths = (out.context.lookup(regular.get(PDFName.of("Widths"))) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((x) => x.asNumber());
    // Times-Roman AFM: H 722, e 444, space 250, eacute 444
    expect(widths["H".charCodeAt(0) - 32]).toBe(722);
    expect(widths["e".charCodeAt(0) - 32]).toBe(444);
    expect(widths[0]).toBe(250);
    expect(widths[0xe9 - 32]).toBe(444);
    expect(await textOf(bytes)).toContain("Times line");
  });
});