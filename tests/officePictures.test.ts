// Pictures in DOCX / HWPX (결손 3, io/officeDrawing.ts, io/officesurgeon/pics.ts): fresh save (w:drawing + word/media,
// hp:pic + BinData + manifest), import (inline in the flow, floating at its page place, crop / rotation / flips), and the
// Office Surgeon (unchanged = same bytes, changed / deleted / new pictures, maps before pictures).
// References: qa/interop/adobe-made/word_doc.docx (Word: one inline picture 400 × 240 px) and hwpx_doc.hwpx (한글: one
// picture as a character, 500 × 300 px).
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { newImage, newPage, newParagraph, newText, type ImageNode, type OmwDocument, type Page } from "../src/core/types";
import { exportById, formatForExt } from "../src/io/formats";
import { officePages } from "../src/io/formats/flow";
import { exportDocx, exportHwpx, parseDocxFlow, parseHwpxFlow, type OfficeImportReport } from "../src/io/office";
import { imageFields, picGeomOf, picPixels } from "../src/io/officeDrawing";
import { docxMeta, hwpxMeta } from "../src/io/officesurgeon";
import { readZip } from "../src/io/officesurgeon/zip";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const PNG = new Uint8Array(readFileSync("public/app_small.png"));
const WORD = "qa/interop/adobe-made/word_doc.docx";
const HWPX = "qa/interop/adobe-made/hwpx_doc.hwpx";

const docOf = (pages: Page[], assets: OmwDocument["assets"] = {}): OmwDocument => ({ format: "omw", version: 1, id: "d", title: "t", created: "", modified: "", pages, masters: [], assets });
const imagesOf = (pages: Page[]) => pages.flatMap((p, pi) => p.nodes.filter((n): n is ImageNode => n.type === "IMAGE").map((n) => ({ n, pi })));
const near = (a: number, b: number, tol = 1) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

async function open(kind: "docx" | "hwpx", bytes: Uint8Array, name = `x.${kind}`): Promise<OmwDocument> {
  const r = await formatForExt(kind)!.open({ name, path: null, bytes }, {} as any);
  return docOf(r.pages, (r as any).assets ?? {});
}
async function save(kind: "docx" | "hwpx", doc: OmwDocument, msgs: string[] = []) {
  return (await exportById(kind)!.run(doc, doc.pages[0], { confirm: (m: string) => (msgs.push(m), true) } as any)) as Uint8Array;
}
function changedEntries(a: Uint8Array, b: Uint8Array) {
  const za = readZip(a)!, zb = readZip(b)!;
  const out: string[] = [];
  for (const e of zb.entries) {
    const o = za.entries.find((x) => x.name === e.name);
    if (!o || !Buffer.from(b.subarray(e.start, e.end)).equals(Buffer.from(a.subarray(o.start, o.end)))) out.push(e.name);
  }
  return out.sort();
}

/** A page: a paragraph, a picture below it (clear of the text), a paragraph below the picture. */
function pictureDoc(extra: Partial<ImageNode> = {}): OmwDocument {
  const asset = makeAsset(PNG, "image/png", "omni-icon.png");
  const pg = newPage("DOCUMENT", 794, 1123, "p1");
  const t1 = newText("", 680);
  t1.paragraphs = [newParagraph("위 문단 — Paragraph above")];
  t1.transform = { x: 57, y: 76, rotation: 0, scale: 1 };
  const img = { ...newImage(asset.id, 160, 120, "오메 아이콘"), ...extra };
  img.transform = { x: 200, y: 140, rotation: 0, scale: 1, ...(extra.transform ?? {}) };
  const t2 = newText("", 680);
  t2.paragraphs = [newParagraph("아래 문단 — Paragraph below")];
  t2.transform = { x: 57, y: 300, rotation: 0, scale: 1 };
  pg.nodes.push(t1, img, t2);
  return docOf([pg], { [asset.id]: asset });
}

describe("picture geometry", () => {
  it("box ↔ node: crop, rotation and flips come back", () => {
    const base = { ...newImage("a", 200, 100), crop: { x: 20, y: 10, w: 150, h: 70 } };
    for (const t of [
      { x: 10, y: 20, rotation: 0, scale: 1 },
      { x: 10, y: 20, rotation: 30, scale: 1 },
      { x: 300, y: 20, rotation: 0, scale: -1 },
      { x: 10, y: 220, rotation: 90, scale: 1, scaleY: -1 },
    ]) {
      const n: ImageNode = { ...base, transform: t };
      const g = picGeomOf(n);
      const back = picGeomOf({ ...n, ...imageFields(g) });
      for (const k of ["x", "y", "w", "h", "rot"] as const) near(back[k], g[k], 0.02);
      expect([back.flipH, back.flipV]).toEqual([g.flipH, g.flipV]);
      for (const k of ["l", "t", "r", "b"] as const) near(back.crop![k], g.crop![k], 0.001);
    }
  });

  it("reads the pixel size of PNG bytes", () => {
    expect(picPixels(PNG)).toEqual({ w: expect.any(Number), h: expect.any(Number) });
  });
});

describe("fresh save", () => {
  it("DOCX: the bytes as they are in word/media, an image relationship; clear of text = inline between the paragraphs", async () => {
    const doc = pictureDoc();
    const files = unzipSync(exportDocx(doc.pages, { assets: doc.assets }));
    expect(Buffer.from(files["word/media/image1.png"]).equals(Buffer.from(PNG))).toBe(true);
    expect(strFromU8(files["[Content_Types].xml"])).toContain('<Default Extension="png" ContentType="image/png"/>');
    expect(strFromU8(files["word/_rels/document.xml.rels"])).toContain('Target="media/image1.png"');
    const xml = strFromU8(files["word/document.xml"]);
    expect(xml).toContain("<wp:inline");
    expect(xml).toMatch(/<w:spacing w:before="\d+" w:after="\d+"\/><w:ind w:left="\d+"\/>/); // its x and the room around it
    expect(xml).toContain('<wp:extent cx="1524000" cy="1143000"/>'); // 160 × 120 px
    // a paragraph of its own between the paragraph above and the one below
    expect(xml.indexOf("<w:drawing>")).toBeGreaterThan(xml.indexOf("Paragraph above"));
    expect(xml.indexOf("<w:drawing>")).toBeLessThan(xml.indexOf("Paragraph below"));
  });

  it("DOCX without pictures is written as before (no media, no drawing namespaces)", () => {
    const pg = newPage("DOCUMENT", 794, 1123, "p");
    const t = newText("", 600);
    t.paragraphs = [newParagraph("글")];
    pg.nodes.push(t);
    const files = unzipSync(exportDocx([pg]));
    expect(Object.keys(files).some((f) => f.startsWith("word/media"))).toBe(false);
    expect(strFromU8(files["word/document.xml"])).not.toContain("xmlns:wp");
  });

  it("HWPX: BinData + manifest item + hp:pic (beside another picture: at its paper place, text above and below)", () => {
    const doc = pictureDoc();
    const other = { ...(doc.pages[0].nodes[1] as ImageNode), id: "other" };
    other.transform = { ...other.transform, x: 500 };
    doc.pages[0].nodes.push(other);
    const files = unzipSync(exportHwpx(doc.pages, "t", { assets: doc.assets }));
    expect(Buffer.from(files["BinData/image1.png"]).equals(Buffer.from(PNG))).toBe(true);
    expect(strFromU8(files["Contents/content.hpf"])).toContain('<opf:item id="image1" href="BinData/image1.png" media-type="image/png" isEmbeded="1"/>');
    const sec = strFromU8(files["Contents/section0.xml"]);
    expect(sec).toMatch(/<hp:pic [^>]*textWrap="TOP_AND_BOTTOM"/);
    expect(sec).toContain('<hc:img binaryItemIDRef="image1"');
    expect(sec).toContain('vertRelTo="PAPER" horzRelTo="PAPER" vertAlign="TOP" horzAlign="LEFT" vertOffset="10500" horzOffset="15000"'); // 140, 200 px
    expect(sec).toContain('<hp:sz width="12000" widthRelTo="ABSOLUTE" height="9000"');
    // one file for the same picture twice
    expect(Object.keys(files).filter((f) => f.startsWith("BinData/"))).toEqual(["BinData/image1.png"]);
  });

  it("a picture over text is written in front of / behind it (no wrapping)", () => {
    const doc = pictureDoc({ transform: { x: 60, y: 70, rotation: 0, scale: 1 } } as any);
    const xml = strFromU8(unzipSync(exportDocx(doc.pages, { assets: doc.assets }))["word/document.xml"]);
    expect(xml).toContain("<wp:wrapNone/>");
    expect(xml).toMatch(/behindDoc="0"/);
  });

  it("formats Word and 한글 cannot show are left out with a note (never re-encoded)", () => {
    const doc = pictureDoc();
    const a = Object.values(doc.assets)[0];
    const webp = makeAsset(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'), "image/svg+xml", "x.svg");
    (doc.pages[0].nodes.find((n) => n.type === "IMAGE") as ImageNode).assetId = webp.id;
    const notes: string[] = [];
    const files = unzipSync(exportDocx(doc.pages, { assets: { [a.id]: a, [webp.id]: webp }, notes }));
    expect(Object.keys(files).some((f) => f.startsWith("word/media"))).toBe(false);
    expect(notes.length).toBe(1);
  });

  it.each(["docx", "hwpx"] as const)("%s round trip: the picture comes back at its place, same bytes", async (kind) => {
    const doc = pictureDoc({ crop: { x: 16, y: 12, w: 128, h: 96 } } as any);
    const g0 = picGeomOf(doc.pages[0].nodes.find((n) => n.type === "IMAGE") as ImageNode);
    const bytes = kind === "docx" ? exportDocx(doc.pages, { assets: doc.assets }) : exportHwpx(doc.pages, "t", { assets: doc.assets });
    const back = await open(kind, bytes);
    const imgs = imagesOf(back.pages);
    expect(imgs.length).toBe(1);
    const g = picGeomOf(imgs[0].n);
    for (const k of ["x", "y", "w", "h"] as const) near(g[k], g0[k], 1);
    near(g.crop!.l, 0.1, 0.002);
    expect(imgs[0].n.place).toMatchObject({ mode: "inline", own: true });
    expect(back.assets[imgs[0].n.assetId].hash).toBe(Object.values(doc.assets)[0].hash);
    // the text after it starts below it (text goes around it: top and bottom)
    const below = back.pages[0].nodes.find((n) => n.type === "TEXT" && n.paragraphs.some((p) => p.runs.some((r) => r.text.includes("below"))));
    expect(below!.transform.y).toBeGreaterThanOrEqual(g.y + g.h - 0.5);
    // saved again unchanged: the same bytes (the Office Surgeon)
    expect(Buffer.from(await save(kind, { ...back, pages: back.pages })).equals(Buffer.from(bytes))).toBe(true);
  });

  it("an inline picture stays inline (its own paragraph, aligned)", async () => {
    const doc = pictureDoc({ place: { mode: "inline" } } as any);
    const bytes = exportDocx(doc.pages, { assets: doc.assets });
    const xml = strFromU8(unzipSync(bytes)["word/document.xml"]);
    expect(xml).toContain("<wp:inline");
    const back = await open("docx", bytes);
    const [img] = imagesOf(back.pages);
    expect(img.n.place).toMatchObject({ mode: "inline", own: true });
    near(picGeomOf(img.n).x, 200, 1);
  });
});

describe("import", () => {
  it("Word: an inline picture of its own paragraph is a picture in the flow (no empty text line)", async () => {
    const doc = await open("docx", new Uint8Array(readFileSync(WORD)), "word_doc.docx");
    const imgs = imagesOf(doc.pages);
    expect(imgs.length).toBe(1);
    const g = picGeomOf(imgs[0].n);
    near(g.w, 3810532 / 9525, 0.01);
    near(g.h, 2286319 / 9525, 0.01);
    expect(imgs[0].n.place).toMatchObject({ mode: "inline", own: true });
    const media = unzipSync(new Uint8Array(readFileSync(WORD)))["word/media/image1.png"];
    expect(doc.assets[imgs[0].n.assetId].size).toBe(media.length);
    // the text after the picture is below it
    const pg = doc.pages[imgs[0].pi];
    const after = pg.nodes.filter((n) => n.type === "TEXT" && n.transform.y > g.y);
    for (const n of after) expect(n.transform.y).toBeGreaterThanOrEqual(g.y + g.h - 0.5);
  });

  it("한글: a picture as a character (글자처럼 취급) comes in at its size, crop read from imgClip", async () => {
    const doc = await open("hwpx", new Uint8Array(readFileSync(HWPX)), "hwpx_doc.hwpx");
    const imgs = imagesOf(doc.pages);
    expect(imgs.length).toBe(1);
    const g = picGeomOf(imgs[0].n);
    near(g.w, 500, 0.01);
    near(g.h, 300, 0.01);
    expect(g.crop).toBeNull();
    expect(imgs[0].n.place?.mode).toBe("inline");
  });

  it("floating pictures: page / margin / paragraph offsets, alignment, crop, rotation and flips", async () => {
    const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const anchor = (pos: string, behind = 1, extra = "") =>
      `<w:p><w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" behindDoc="${behind}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>${pos}<wp:extent cx="952500" cy="476250"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/><wp:docPr id="1" name="p"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name=""/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdP"/><a:srcRect l="10000" r="10000"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm rot="5400000" flipH="1"${extra}><a:off x="0" y="0"/><a:ext cx="952500" cy="476250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r><w:r><w:t>글</w:t></w:r></w:p>`;
    const body =
      anchor('<wp:positionH relativeFrom="page"><wp:posOffset>952500</wp:posOffset></wp:positionH><wp:positionV relativeFrom="page"><wp:posOffset>1905000</wp:posOffset></wp:positionV>') +
      anchor('<wp:positionH relativeFrom="margin"><wp:align>center</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>95250</wp:posOffset></wp:positionV>', 0);
    const { zipSync, strToU8 } = await import("fflate");
    const bytes = zipSync({
      "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`),
      "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
      "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdP" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>`),
      "word/media/p.png": PNG,
      "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="${W}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`),
    });
    const doc = await open("docx", bytes);
    const imgs = imagesOf(doc.pages)
      .map((x) => x.n)
      .sort((p, q) => (p.place?.wrap === "behind" ? -1 : 1) - (q.place?.wrap === "behind" ? -1 : 1));
    expect(imgs.length).toBe(2);
    // the first: at its page place, behind the text, rotated 90°, mirrored, 10 % cut from left and right
    const g = picGeomOf(imgs[0]);
    near(g.x, 100, 0.05);
    near(g.y, 200, 0.05);
    near(g.w, 100, 0.05);
    near(g.h, 50, 0.05);
    expect(g.rot).toBe(90);
    expect(g.flipH).toBe(true);
    near(g.crop!.l, 0.1, 1e-6);
    expect(imgs[0].place).toMatchObject({ mode: "float", wrap: "behind", offset: 0 });
    expect(doc.pages[0].nodes[0]).toBe(imgs[0]); // behind = under the text
    // the second: centred in the text area (Word margin = 1 in = 96 px, text width 794 − 192)
    const g2 = picGeomOf(imgs[1]);
    near(g2.x, 96 + (11906 / 15 - 192 - 100) / 2, 0.5);
    // the paragraphs stay (a floating picture is not their content)
    expect(doc.pages[0].nodes.filter((n) => n.type === "TEXT").flatMap((n) => (n.type === "TEXT" ? n.paragraphs : [])).length).toBe(2);
  });

  it("without report.pictures the body is read as before (paragraph of a picture = an empty paragraph)", () => {
    const bytes = new Uint8Array(readFileSync(WORD));
    const before = parseDocxFlow(bytes, { notesDropped: 0 }).length;
    const rep: OfficeImportReport = { notesDropped: 0, pictures: [] };
    const now = parseDocxFlow(bytes, rep).length;
    expect(rep.pictures!.length).toBe(1);
    expect(now).toBe(before - 1);
  });
});

describe("Office Surgeon: pictures", () => {
  const read = (f: string) => new Uint8Array(readFileSync(f));

  it.each([
    ["docx", WORD],
    ["hwpx", HWPX],
  ] as const)("%s: a resized picture rewrites only the body part; the picture bytes stay", async (kind, file) => {
    const doc = await open(kind, read(file), `orig.${kind}`);
    const [{ n, pi }] = imagesOf(doc.pages);
    const pg = doc.pages[pi];
    pg.nodes[pg.nodes.indexOf(n)] = { ...n, width: n.width / 2, height: n.height / 2 };
    const out = await save(kind, doc);
    expect(changedEntries(read(file), out)).toEqual([kind === "docx" ? "word/document.xml" : "Contents/section0.xml"]);
    const back = await open(kind, out);
    const g = picGeomOf(imagesOf(back.pages)[0].n);
    near(g.w, picGeomOf(n).w / 2, 0.05);
    if (kind === "docx") {
      const xml = strFromU8(unzipSync(out)["word/document.xml"]);
      expect(xml).toContain('wp14:anchorId="11ADE7D3"'); // the rest of the drawing as it was
      expect(xml).toContain(`<wp:extent cx="${Math.round((3810532 / 2) * 1) - 0}"`.slice(0, 20));
    }
  });

  it.each([
    ["docx", WORD],
    ["hwpx", HWPX],
  ] as const)("%s: a deleted picture is taken out with its paragraph; nothing else changes", async (kind, file) => {
    const doc = await open(kind, read(file), `orig.${kind}`);
    const [{ n, pi }] = imagesOf(doc.pages);
    doc.pages[pi].nodes = doc.pages[pi].nodes.filter((x) => x !== n);
    const out = await save(kind, doc);
    const body = strFromU8(unzipSync(out)[kind === "docx" ? "word/document.xml" : "Contents/section0.xml"]);
    expect(body).not.toContain(kind === "docx" ? "<w:drawing>" : "<hp:pic ");
    expect(changedEntries(read(file), out)).toEqual([kind === "docx" ? "word/document.xml" : "Contents/section0.xml"]);
    expect(imagesOf((await open(kind, out)).pages).length).toBe(0);
  });

  it.each([
    ["docx", WORD],
    ["hwpx", HWPX],
  ] as const)("%s: a new picture adds its part, relationship / manifest item; the original picture stays", async (kind, file) => {
    const doc = await open(kind, read(file), `orig.${kind}`);
    const asset = makeAsset(PNG, "image/png", "omni-icon.png");
    doc.assets[asset.id] = asset;
    const img = newImage(asset.id, 64, 64, "새 그림");
    img.transform = { x: 600, y: 640, rotation: 0, scale: 1 };
    doc.pages[0].nodes.push(img);
    const out = await save(kind, doc);
    const ch = changedEntries(read(file), out);
    // (word_doc.docx already has the png content type)
    if (kind === "docx") expect(ch).toEqual(["word/_rels/document.xml.rels", "word/document.xml", "word/media/omw-image1.png"]);
    // (a new paragraph shape for the picture's paragraph may be added to header.xml)
    else expect(ch.filter((x) => x !== "Contents/header.xml")).toEqual(["BinData/omwimage1.png", "Contents/content.hpf", "Contents/section0.xml"].sort());
    const back = await open(kind, out);
    const imgs = imagesOf(back.pages);
    expect(imgs.length).toBe(2);
    const added = imgs.find((x) => back.assets[x.n.assetId].hash === asset.hash)!;
    const g = picGeomOf(added.n);
    near(g.x, 600, 0.5);
    near(g.y, 640, 0.5);
    // saved again unchanged: the same bytes
    expect(Buffer.from(await save(kind, back)).equals(Buffer.from(out))).toBe(true);
  });

  it("a map from before pictures (model 4) still opens and compares: unchanged = same bytes, an edit stays surgical", async () => {
    // as the app before this change opened it: no pictures read, the picture's paragraph an empty paragraph
    const bytes = read(WORD);
    const rep: OfficeImportReport & { blockItems: number[] } = { notesDropped: 0, blockItems: [] };
    const items = parseDocxFlow(bytes, rep);
    const pages = officePages(items, "word_doc", rep.layout, rep.lists);
    pages.forEach((p) => (p.source = { format: "docx", name: "orig.docx" }));
    const asset = makeAsset(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "orig.docx");
    const meta = docxMeta(pages, rep.blockItems, asset)!;
    expect(meta.model).toBe(4);
    expect(meta.pics).toBeUndefined();
    pages[0].source!.office = meta;
    const doc = docOf(pages, { [asset.id]: asset });
    expect(Buffer.from(await save("docx", doc)).equals(Buffer.from(bytes))).toBe(true);
    // edit one paragraph: still surgical (the picture's paragraph and the media stay)
    const tn = pages.flatMap((p) => p.nodes).find((n) => n.type === "TEXT" && n.paragraphs.some((q) => q.runs.some((r) => r.text.trim())))!;
    if (tn.type !== "TEXT") throw new Error();
    const q = tn.paragraphs.find((x) => x.runs.some((r) => r.text.trim()))!;
    q.runs = [{ ...q.runs[0], text: q.runs[0].text + " (고침)" }, ...q.runs.slice(1)];
    const msgs: string[] = [];
    const out = await save("docx", doc, msgs);
    expect(changedEntries(bytes, out)).toEqual(["word/document.xml"]);
    expect(strFromU8(unzipSync(out)["word/document.xml"])).toContain('wp14:anchorId="11ADE7D3"');
  });

  it("HWPX: a map from before pictures (model 4) still opens and compares: unchanged = same bytes", async () => {
    const bytes = read(HWPX);
    const rep: OfficeImportReport & { sectionBlocks: { part: string; items: number[] }[] } = { notesDropped: 0, sectionBlocks: [] };
    const items = parseHwpxFlow(bytes, rep);
    const pages = officePages(items, "hwpx_doc", rep.layout, rep.lists);
    pages.forEach((p) => (p.source = { format: "hwpx", name: "orig.hwpx" }));
    const asset = makeAsset(bytes, "application/hwp+zip", "orig.hwpx");
    const meta = hwpxMeta(pages, rep.sectionBlocks, asset)!;
    expect(meta.model).toBe(4);
    expect(meta.pics).toBeUndefined();
    pages[0].source!.office = meta;
    const doc = docOf(pages, { [asset.id]: asset });
    expect(Buffer.from(await save("hwpx", doc)).equals(Buffer.from(bytes))).toBe(true);
  });

  it.each([
    ["docx", WORD],
    ["hwpx", HWPX],
  ] as const)("%s: a new picture in a format Word / 한글 cannot show is not lost silently (a note, the file as it was)", async (kind, file) => {
    const doc = await open(kind, read(file), `orig.${kind}`);
    const webp = makeAsset(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'), "image/svg+xml", "x.svg");
    doc.assets[webp.id] = webp;
    const n = newImage(webp.id, 64, 64, "webp");
    n.transform = { x: 600, y: 640, rotation: 0, scale: 1 };
    doc.pages[0].nodes.push(n);
    const msgs: string[] = [];
    const out = await save(kind, doc, msgs);
    expect(Buffer.from(out).equals(Buffer.from(read(file)))).toBe(true);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toMatch(/SVG/);
  });

  it("HWPX with a new picture: BinData ids, manifest items and binaryItemIDRef stay one to one", async () => {
    const doc = await open("hwpx", read(HWPX), "orig.hwpx");
    const asset = makeAsset(PNG, "image/png", "omni-icon.png");
    doc.assets[asset.id] = asset;
    const img = newImage(asset.id, 64, 64, "새 그림");
    img.transform = { x: 600, y: 640, rotation: 0, scale: 1 };
    doc.pages[0].nodes.push(img);
    const files = unzipSync(await save("hwpx", doc));
    const hpf = strFromU8(files["Contents/content.hpf"]);
    const items = [...hpf.matchAll(/<opf:item id="([^"]+)" href="(BinData\/[^"]+)"/g)].map((m) => ({ id: m[1], href: m[2] }));
    const bins = Object.keys(files).filter((f) => f.startsWith("BinData/"));
    expect(items.map((x) => x.href).sort()).toEqual(bins.sort());
    expect(new Set(items.map((x) => x.id)).size).toBe(items.length);
    const allIds = [...hpf.matchAll(/<opf:item id="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(allIds).size).toBe(allIds.length);
    const sec = strFromU8(files["Contents/section0.xml"]);
    for (const m of sec.matchAll(/binaryItemIDRef="([^"]+)"/g)) expect(items.map((x) => x.id)).toContain(m[1]);
    const picIds = [...sec.matchAll(/<hp:pic id="(\d+)"/g)].map((m) => m[1]);
    expect(new Set(picIds).size).toBe(picIds.length);
  });
});
