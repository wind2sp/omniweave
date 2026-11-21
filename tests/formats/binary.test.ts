// Binary formats: PPTX round trip, EPUB, legacy CFB (HWP/DOC/PPT/XLS), PSD, TIFF, PNG encoder, sniffing.
// Fixtures are synthesized here from the public specifications (no real documents are used).
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { deflateSync, strToU8, unzlibSync, zipSync } from "fflate";
import { getBlob, makeAsset } from "../../src/core/assets";
import { plainText } from "../../src/core/text";
import { newDocument, newImage, newMedia, newPage, newTable, newText, newVector, type TableNode, type TextNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { nodeHash } from "../../src/core/loom";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { importEpub } from "../../src/io/formats/epub";
import { readCfb } from "../../src/io/formats/cfb";
import { docText, hwpText, pptText, xlsSheets } from "../../src/io/formats/legacy";
import { encodePng } from "../../src/io/formats/png";
import { exportPptx, importPptx } from "../../src/io/formats/pptx";
import { decodePsd } from "../../src/io/formats/psd";
import { imageMime, imageSize, isHeic, mediaKind } from "../../src/io/formats/sniff";
import { decodeTiff } from "../../src/io/formats/tiff";
import { exportDocx, parseDocx } from "../../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const red2x2 = () => encodePng(new Uint8Array([255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 128]), 2, 2);

// ───────── minimal Compound File writer (test fixture only) ─────────
function makeCfb(streams: Record<string, Uint8Array>): Uint8Array {
  const SS = 512;
  type E = { name: string; type: number; data?: Uint8Array; kids: number[]; start: number; size: number };
  const entries: E[] = [{ name: "Root Entry", type: 5, kids: [], start: 0xfffffffe, size: 0 }];
  const storage = new Map<string, number>();
  for (const [path, data] of Object.entries(streams)) {
    const parts = path.split("/");
    let parent = 0;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts.slice(0, i + 1).join("/");
      if (!storage.has(key)) {
        entries.push({ name: parts[i], type: 1, kids: [], start: 0, size: 0 });
        storage.set(key, entries.length - 1);
        entries[parent].kids.push(entries.length - 1);
      }
      parent = storage.get(key)!;
    }
    entries.push({ name: parts[parts.length - 1], type: 2, data, kids: [], start: 0, size: data.length });
    entries[parent].kids.push(entries.length - 1);
  }
  const dirSectors = Math.ceil((entries.length * 128) / SS);
  const dataSectors = entries.reduce((a, e) => a + (e.data ? Math.max(1, Math.ceil(e.data.length / SS)) : 0), 0);
  const total = 1 + dirSectors + dataSectors;
  if (total > 128) throw new Error("fixture too big");
  const fat = new Uint32Array(128).fill(0xffffffff);
  fat[0] = 0xfffffffd; // FAT sector
  for (let i = 0; i < dirSectors; i++) fat[1 + i] = i === dirSectors - 1 ? 0xfffffffe : 2 + i;
  let next = 1 + dirSectors;
  const body = new Uint8Array(total * SS);
  for (const e of entries) {
    if (!e.data) continue;
    const n = Math.max(1, Math.ceil(e.data.length / SS));
    e.start = next;
    for (let i = 0; i < n; i++) fat[next + i] = i === n - 1 ? 0xfffffffe : next + i + 1;
    body.set(e.data, next * SS);
    next += n;
  }
  new Uint8Array(body.buffer, 0, SS).set(new Uint8Array(fat.buffer));
  const dv = new DataView(body.buffer);
  entries.forEach((e, i) => {
    const o = SS + i * 128;
    for (let k = 0; k < e.name.length; k++) dv.setUint16(o + k * 2, e.name.charCodeAt(k), true);
    dv.setUint16(o + 0x40, (e.name.length + 1) * 2, true);
    body[o + 0x42] = e.type;
    dv.setUint32(o + 0x44, 0xffffffff, true);
    dv.setUint32(o + 0x48, 0xffffffff, true);
    dv.setUint32(o + 0x4c, e.kids[0] ?? 0xffffffff, true);
    dv.setUint32(o + 0x74, e.start, true);
    dv.setUint32(o + 0x78, e.size, true);
  });
  // siblings as a right-leaning chain
  for (const e of entries) e.kids.forEach((k, j) => j + 1 < e.kids.length && dv.setUint32(SS + k * 128 + 0x48, e.kids[j + 1], true));
  const head = new Uint8Array(SS);
  const hv = new DataView(head.buffer);
  head.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  hv.setUint16(0x18, 0x3e, true);
  hv.setUint16(0x1a, 3, true);
  hv.setUint16(0x1c, 0xfffe, true);
  hv.setUint16(0x1e, 9, true);
  hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, 1, true);
  hv.setUint32(0x30, 1, true);
  hv.setUint32(0x38, 0, true); // mini stream cutoff 0: every stream lives in regular sectors
  hv.setUint32(0x3c, 0xfffffffe, true);
  hv.setUint32(0x44, 0xfffffffe, true);
  for (let i = 0; i < 109; i++) hv.setUint32(0x4c + i * 4, i === 0 ? 0 : 0xffffffff, true);
  const out = new Uint8Array(SS + body.length);
  out.set(head);
  out.set(body, SS);
  return out;
}

const le16 = (v: number) => [v & 255, (v >> 8) & 255];
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
const utf16 = (s: string) => Array.from(s).flatMap((c) => le16(c.charCodeAt(0)));

describe("PPTX", () => {
  it("export → import keeps slides, text, shapes, pictures and tables", async () => {
    const doc = newDocument("발표");
    const s1 = newPage("SLIDE", 1280, 720, "표지");
    s1.background = "#102030";
    const title = newText("오메 발표\n둘째 줄", 600, { fontSize: 40, bold: true, color: "#ffffff" });
    title.transform = { x: 100, y: 80, rotation: 0, scale: 1 };
    const box = newVector([rectContour(0, 0, 200, 100)], "상자");
    box.fill = "#ff8800";
    box.transform = { x: 300, y: 400, rotation: 30, scale: 1 };
    const png = makeAsset(red2x2(), "image/png", "red.png");
    doc.assets[png.id] = png;
    const img = newImage(png.id, 100, 100, "그림");
    img.transform = { x: 900, y: 500, rotation: 0, scale: 1 };
    s1.nodes = [box, title, img];
    const s2 = newPage("SLIDE", 1280, 720, "표");
    const tbl = newTable([["항목", "값"], ["가", "1"]], [200, 120]);
    tbl.transform = { x: 50, y: 50, rotation: 0, scale: 1 };
    s2.nodes = [tbl];
    doc.pages = [s1, s2];
    const { bytes, skipped } = await exportPptx(doc, doc.pages);
    expect(skipped).toBe(0);
    const r = importPptx(bytes, "발표.pptx");
    expect(r.pages).toHaveLength(2);
    expect(r.pages[0]).toMatchObject({ kind: "SLIDE", width: 1280, height: 720, background: "#102030" });
    const t = r.pages[0].nodes.find((n) => n.type === "TEXT") as TextNode;
    expect(plainText(t)).toBe("오메 발표\n둘째 줄");
    expect(t.paragraphs[0].runs[0]).toMatchObject({ bold: true, color: "#ffffff" });
    expect(t.paragraphs[0].runs[0].fontSize).toBeCloseTo(40, 0);
    expect(t.transform.x).toBeCloseTo(100, 0);
    const v = r.pages[0].nodes.find((n) => n.type === "VECTOR")!;
    expect(v.transform.rotation).toBeCloseTo(30, 3);
    expect(v.transform.x).toBeCloseTo(300, 0); // rotation pivot converted both ways
    expect(v.transform.y).toBeCloseTo(400, 0);
    const im = r.pages[0].nodes.find((n) => n.type === "IMAGE")!;
    expect(im.type === "IMAGE" && getBlob(r.assets[im.assetId].hash)).toEqual(red2x2());
    const tt = r.pages[1].nodes.find((n) => n.type === "TABLE") as TableNode;
    expect(tt.rows.map((x) => x.map((c) => c.text))).toEqual([["항목", "값"], ["가", "1"]]);
    expect(tt.colWidths[0]).toBeCloseTo(200, 0);
  });

  it("inherits placeholder positions from the layout and resolves theme colours", () => {
    const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
    const rel = (items: string) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items}</Relationships>`;
    const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const zip = zipSync({
      "ppt/presentation.xml": strToU8(`<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`),
      "ppt/_rels/presentation.xml.rels": strToU8(rel(`<Relationship Id="rId2" Type="${R}/slide" Target="slides/slide1.xml"/>`)),
      "ppt/slides/slide1.xml": strToU8(`<p:sld ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr><a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill></a:rPr><a:t>제목</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`),
      "ppt/slides/_rels/slide1.xml.rels": strToU8(rel(`<Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`)),
      "ppt/slideLayouts/slideLayout1.xml": strToU8(`<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="T"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="952500" y="476250"/><a:ext cx="4762500" cy="952500"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`),
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rel(`<Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>`)),
      "ppt/slideMasters/slideMaster1.xml": strToU8(`<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="lt2"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`),
      "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(rel(`<Relationship Id="rId1" Type="${R}/theme" Target="../theme/theme1.xml"/>`)),
      "ppt/theme/theme1.xml": strToU8(`<a:theme ${NS}><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="FF0000"/></a:accent1></a:clrScheme></a:themeElements></a:theme>`),
    });
    const r = importPptx(zip, "t.pptx");
    expect(r.pages[0]).toMatchObject({ width: 960, height: 720, background: "#eeeeee" });
    const t = r.pages[0].nodes[0] as TextNode;
    expect(t.transform.x).toBeCloseTo(100 + 9.6, 0); // layout off.x 952500 EMU = 100px, plus inset
    expect(t.paragraphs[0].runs[0].color).toBe("#800000"); // accent1 with lumMod 50%
  });
});

describe("EPUB", () => {
  it("reads the spine in order with headings, paragraphs and images", () => {
    const xhtml = (body: string) => strToU8(`<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>c</title></head><body>${body}</body></html>`);
    const epub = zipSync({
      mimetype: strToU8("application/epub+zip"),
      "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
      "OEBPS/content.opf": strToU8(`<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>시집</dc:title></metadata><manifest><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/><item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="i" href="img/a.png" media-type="image/png"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`),
      "OEBPS/text/c1.xhtml": xhtml(`<h1>첫 장</h1><p>첫 문단</p><img src="../img/a.png" alt="그림"/>`),
      "OEBPS/text/c2.xhtml": xhtml(`<h2>둘째 장</h2><p>둘째 문단</p>`),
      "OEBPS/img/a.png": red2x2(),
    });
    const r = importEpub(epub, "book.epub");
    expect(r.title).toBe("시집");
    expect(r.chapters).toBe(2);
    expect(r.pages.length).toBe(2); // chapters start on a new page
    const t1 = r.pages[0].nodes.filter((n) => n.type === "TEXT").map((n) => plainText(n as TextNode)).join("\n");
    expect(t1).toContain("첫 장");
    expect(r.pages[0].nodes.some((n) => n.type === "IMAGE")).toBe(true);
    expect(Object.values(r.assets)[0].mime).toBe("image/png");
    expect(plainText(r.pages[1].nodes.find((n) => n.type === "TEXT") as TextNode)).toContain("둘째 장");
  });
});

describe("legacy binary formats (text extraction)", () => {
  it("CFB reader walks storages and streams", () => {
    const c = readCfb(makeCfb({ "A/B": new Uint8Array([1, 2, 3]), C: new Uint8Array(700).fill(7) }));
    expect([...c.streams.keys()].sort()).toEqual(["A/B", "C"]);
    expect(c.get("A/B")).toEqual(new Uint8Array([1, 2, 3]));
    expect(c.get("C")!.length).toBe(700);
  });

  it("HWP 5.0: compressed body text with a table", () => {
    const rec = (tag: number, level: number, data: number[]) => [...le32(tag | (level << 10) | (data.length << 20)), ...data];
    // a tab is an inline control: 8 WCHARs (code, 6 WCHARs of data, code)
    const para = (level: number, text: string) => rec(0x43, level, [...text.split("\t").flatMap((part, i) => [...(i ? [...le16(9), ...new Array(12).fill(0), ...le16(9)] : []), ...utf16(part)]), ...le16(13)]);
    const ctrl = (level: number) => rec(0x47, level, [0x20, 0x6c, 0x62, 0x74, 0, 0, 0, 0]); // 'tbl ' little-endian
    const table = (level: number, rows: number, cols: number) => rec(0x4d, level, [...le32(0), ...le16(rows), ...le16(cols)]);
    const cell = (level: number, row: number, col: number) => rec(0x48, level, [...le16(1), 0, 0, ...le32(0), ...le16(col), ...le16(row), ...le16(1), ...le16(1)]);
    const body = new Uint8Array([
      ...rec(0x42, 0, [0, 0, 0, 0]),
      ...para(1, "첫 문단\t탭"),
      ...rec(0x42, 0, [0, 0, 0, 0]),
      ...ctrl(1),
      ...table(2, 1, 2),
      ...cell(2, 0, 0),
      ...rec(0x42, 2, [0, 0]),
      ...para(3, "셀1"),
      ...cell(2, 0, 1),
      ...rec(0x42, 2, [0, 0]),
      ...para(3, "셀2"),
      ...rec(0x42, 0, [0, 0, 0, 0]),
      ...para(1, "끝"),
    ]);
    const header = new Uint8Array(256);
    header.set(strToU8("HWP Document File"));
    header.set(le32(1), 36); // compressed
    const r = hwpText(makeCfb({ FileHeader: header, "BodyText/Section0": deflateSync(body) }));
    expect(r.blocks).toEqual([
      { kind: "para", text: "첫 문단\t탭" },
      { kind: "table", rows: [["셀1", "셀2"]] },
      { kind: "para", text: "끝" },
    ]);
    const enc = new Uint8Array(header);
    enc.set(le32(1 | 4), 36);
    expect(() => hwpText(makeCfb({ FileHeader: enc, "BodyText/Section0": deflateSync(body) }))).toThrow(/배포용/);
  });

  it("DOC: piece table text (unicode and compressed pieces) and cell marks", () => {
    const text1 = "안녕\r셀A\x07셀B\x07\x07";
    const text2 = "End\r";
    const wd = new Uint8Array(2048);
    const dv = new DataView(wd.buffer);
    dv.setUint16(0, 0xa5ec, true);
    dv.setUint16(0x0a, 0x0200, true); // 1Table
    dv.setUint32(0x4c, text1.length + text2.length, true);
    const fc1 = 1024;
    utf16(text1).forEach((b, i) => (wd[fc1 + i] = b));
    const fc2 = 1600;
    Array.from(text2).forEach((ch, i) => (wd[fc2 + i] = ch.charCodeAt(0)));
    const table = new Uint8Array([
      0x02,
      ...le32(4 * 3 + 8 * 2),
      ...le32(0),
      ...le32(text1.length),
      ...le32(text1.length + text2.length),
      ...[0, 0, ...le32(fc1), 0, 0],
      ...[0, 0, ...le32((fc2 * 2) | 0x40000000), 0, 0],
    ]);
    dv.setUint32(0x1a2, 0, true);
    dv.setUint32(0x1a6, table.length, true);
    const r = docText(makeCfb({ WordDocument: wd, "1Table": table }));
    expect(r.blocks).toEqual([
      { kind: "para", text: "안녕" },
      { kind: "table", rows: [["셀A", "셀B"]] },
      { kind: "para", text: "End" },
    ]);
  });

  it("PPT: text atoms grouped per slide", () => {
    const atom = (type: number, data: number[]) => [...le16(0), ...le16(type), ...le32(data.length), ...data];
    const cont = (type: number, inst: number, kids: number[]) => [...le16(0x0f | (inst << 4)), ...le16(type), ...le32(kids.length), ...kids];
    const list = cont(0x0ff0, 0, [...atom(0x03f3, new Array(20).fill(0)), ...atom(0x0fa0, utf16("제목 하나")), ...atom(0x0fa8, Array.from("body", (c) => c.charCodeAt(0))), ...atom(0x03f3, new Array(20).fill(0)), ...atom(0x0fa0, utf16("두 번째"))]);
    const stream = new Uint8Array(cont(0x03e8, 0, list));
    const r = pptText(makeCfb({ "PowerPoint Document": stream }));
    expect(r.blocks).toEqual([
      { kind: "slide", index: 0 },
      { kind: "para", text: "제목 하나" },
      { kind: "para", text: "body" },
      { kind: "slide", index: 1 },
      { kind: "para", text: "두 번째" },
    ]);
  });

  it("XLS (BIFF8): shared strings across CONTINUE, numbers, RK", () => {
    const rec = (type: number, data: number[]) => [...le16(type), ...le16(data.length), ...data];
    const bof = rec(0x0809, [...le16(0x0600), ...le16(0x0005), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // SST: "가나다" split across SST and CONTINUE (wide), then "ab" (compressed)
    const sst = rec(0x00fc, [...le32(2), ...le32(2), ...le16(3), 1, ...utf16("가")]);
    const cont = rec(0x003c, [1, ...utf16("나다"), ...le16(2), 0, 0x61, 0x62]);
    const sheetName = Array.from("시트", (c) => c.charCodeAt(0));
    const boundsheetLen = 4 + 6 + 2 + 4;
    const globals = [...bof, ...sst, ...cont];
    const bsPos = globals.length + boundsheetLen + 4; // after BOUNDSHEET + EOF
    const bs = rec(0x0085, [...le32(bsPos), 0, 0, 2, 1, ...utf16("시트")]);
    void sheetName;
    const eof = rec(0x000a, []);
    const num = new DataView(new ArrayBuffer(8));
    num.setFloat64(0, 3.5, true);
    const sheet = [...bof, ...rec(0x00fd, [...le16(0), ...le16(0), ...le16(0), ...le32(0)]), ...rec(0x00fd, [...le16(0), ...le16(1), ...le16(0), ...le32(1)]), ...rec(0x0203, [...le16(1), ...le16(0), ...le16(0), ...new Uint8Array(num.buffer)]), ...rec(0x027e, [...le16(1), ...le16(1), ...le16(0), ...le32((42 << 2) | 2)]), ...eof];
    const wb = new Uint8Array([...globals, ...bs, ...eof, ...sheet]);
    expect(globals.length + bs.length + eof.length).toBe(bsPos);
    const { sheets } = xlsSheets(makeCfb({ Workbook: wb }));
    expect(sheets).toHaveLength(1);
    expect(sheets[0].name).toBe("시트");
    expect(sheets[0].rows.map((r) => r.map((c) => c.text))).toEqual([["가나다", "ab"], ["3.5", "42"]]);
  });
});

describe("PSD / TIFF / PNG", () => {
  function psd(): Uint8Array {
    const w = 4, h = 2;
    const out: number[] = [];
    const u16 = (v: number) => out.push((v >> 8) & 255, v & 255);
    const u32 = (v: number) => out.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
    out.push(...Array.from("8BPS", (c) => c.charCodeAt(0)));
    u16(1);
    out.push(0, 0, 0, 0, 0, 0);
    u16(3);
    u32(h);
    u32(w);
    u16(8);
    u16(3);
    u32(0);
    u32(0);
    // layer section: one 2x1 layer at (1,1) named "레이어" via luni, RLE channels
    const layer: number[] = [];
    const L16 = (v: number) => layer.push((v >> 8) & 255, v & 255);
    const L32 = (v: number) => layer.push((v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255);
    L16(1);
    L32(1);
    L32(1);
    L32(2);
    L32(3); // top,left,bottom,right
    L16(3);
    const chanData = [0, 1, 2].map((c) => [0, 1, 0, 2, 0xff, c === 0 ? 200 : 10]); // RLE: one row of 2 bytes = PackBits "repeat twice"
    for (let c = 0; c < 3; c++) {
      L16(c);
      L32(chanData[c].length);
    }
    layer.push(...Array.from("8BIMnorm", (c) => c.charCodeAt(0)), 255, 0, 0, 0);
    const extra: number[] = [0, 0, 0, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63];
    const luni = [...Array.from("8BIMluni", (c) => c.charCodeAt(0)), 0, 0, 0, 10, 0, 0, 0, 3, 0xb8, 0x08, 0xc7, 0x74, 0xc5, 0xb4];
    extra.push(...luni);
    L32(extra.length);
    layer.push(...extra);
    for (const d of chanData) layer.push(...d);
    const li = [...le32(layer.length).reverse(), ...layer];
    u32(li.length);
    out.push(...li);
    // composite: raw RGB planes
    u16(0);
    for (let c = 0; c < 3; c++) for (let i = 0; i < w * h; i++) out.push(c === 0 ? 255 : c === 1 ? i * 10 : 0);
    return new Uint8Array(out);
  }

  it("PSD: composite and pixel layers with Unicode names", () => {
    const img = decodePsd(psd());
    expect(img).toMatchObject({ width: 4, height: 2, depth: 8, mode: 3 });
    expect(Array.from(img.composite!.subarray(0, 8))).toEqual([255, 0, 0, 255, 255, 10, 0, 255]);
    expect(img.layers).toHaveLength(1);
    expect(img.layers[0]).toMatchObject({ name: "레이어", left: 1, top: 1, width: 2, height: 1, visible: true });
    expect(Array.from(img.layers[0].rgba!)).toEqual([200, 10, 10, 255, 200, 10, 10, 255]);
  });

  it("TIFF: uncompressed RGB strips and PackBits greyscale", () => {
    const tiff = (w: number, h: number, spp: number, comp: number, data: number[]) => {
      const entries: [number, number, number, number][] = [
        [256, 3, 1, w],
        [257, 3, 1, h],
        [258, 3, 1, 8],
        [259, 3, 1, comp],
        [262, 3, 1, spp === 3 ? 2 : 1],
        [273, 4, 1, 8 + 2 + 9 * 12 + 4],
        [277, 3, 1, spp],
        [278, 3, 1, h],
        [279, 4, 1, data.length],
      ];
      const out = [0x49, 0x49, 42, 0, ...le32(8), ...le16(entries.length)];
      for (const [tag, type, count, v] of entries) out.push(...le16(tag), ...le16(type), ...le32(count), ...(type === 3 ? [...le16(v), 0, 0] : le32(v)));
      out.push(...le32(0), ...data);
      return new Uint8Array(out);
    };
    const rgb = decodeTiff(tiff(2, 1, 3, 1, [1, 2, 3, 4, 5, 6]));
    expect(Array.from(rgb.rgba)).toEqual([1, 2, 3, 255, 4, 5, 6, 255]);
    const gray = decodeTiff(tiff(4, 1, 1, 32773, [0xfd, 77])); // PackBits: repeat 77 four times
    expect(Array.from(gray.rgba)).toEqual([77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255, 77, 77, 77, 255]);
    expect(imageMime(tiff(1, 1, 1, 1, [0]))).toBe("image/tiff");
  });

  it("PNG encoder output is a valid PNG", () => {
    const png = red2x2();
    expect(imageMime(png)).toBe("image/png");
    expect(imageSize(png)).toEqual({ width: 2, height: 2 });
    const idatLen = new DataView(png.buffer).getUint32(33);
    const raw = unzlibSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe((2 * 4 + 1) * 2);
    expect(raw[1 + 2 * 4 + 1 + 4 + 3]).toBe(128);
  });

  it("sniffing: image sizes and media containers", () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 20, 0]);
    expect(imageSize(gif)).toEqual({ width: 10, height: 20 });
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 30, 0, 40, 3, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ width: 40, height: 30 });
    const svg = strToU8('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 150"></svg>');
    expect(imageSize(svg)).toEqual({ width: 300, height: 150 });
    const ftyp = (brand: string) => new Uint8Array([0, 0, 0, 24, ...strToU8("ftyp" + brand), 0, 0, 0, 0, ...strToU8("mif1heic")]);
    expect(isHeic(ftyp("heic"))).toBe(true);
    expect(imageMime(ftyp("avif"))).toBe("image/avif");
    expect(mediaKind(ftyp("isom"))).toEqual({ media: "video", mime: "video/mp4" });
    expect(mediaKind(ftyp("qt  "))?.mime).toBe("video/quicktime");
    expect(mediaKind(strToU8("RIFF\0\0\0\0AVI LIST"))?.mime).toBe("video/x-msvideo");
    expect(mediaKind(strToU8("ID3\x03"))?.media).toBe("audio");
    expect(mediaKind(strToU8("OggS"))?.mime).toBe("audio/ogg");
    expect(mediaKind(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))?.mime).toBe("video/webm");
  });
});

describe("new node types through the Loom pipeline", () => {
  it("TABLE and MEDIA survive .omw save/open, hash by content, and DOCX exports tables", () => {
    const doc = newDocument("t");
    const v = makeAsset(new Uint8Array([0, 0, 0, 24, ...strToU8("ftypisom")]), "video/mp4", "clip.mp4");
    doc.assets[v.id] = v;
    const m = newMedia("video", v.id, 320, 180, "clip");
    m.trimStart = 1.5;
    const t = newTable([["a", "b"], [{ text: "1", bold: true }, { text: "2", formula: "A2+1" }]]);
    doc.pages[0].nodes = [t, m];
    const { doc: back, report } = unpackOmw(packOmw(doc).bytes);
    expect(report).toMatchObject({ missingAssets: 0, corruptAssets: 0, rootMatches: true });
    const [t2, m2] = back.pages[0].nodes;
    expect(nodeHash(t2)).toBe(nodeHash(t));
    expect(nodeHash(m2)).toBe(nodeHash(m));
    expect(m2.type === "MEDIA" && m2.trimStart).toBe(1.5);
    const page = newPage("DOCUMENT");
    page.nodes = [newText("앞 문단", 600), { ...t, transform: { ...t.transform, y: 100 } }];
    const docx = exportDocx([page]);
    const paras = parseDocx(docx);
    expect(paras.map((p) => p.runs.map((r) => r.text).join(""))).toEqual(["앞 문단", "a", "b", "1", "2"]); // the empty paragraph Word needs after a final table is not content
  });
});
