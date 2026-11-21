// "이미지 크기 키우기" in documents: one undo step, a raster layer that grows, a PSD layer saved bigger and read back,
// a picture re-encoded in its own format with its metadata, an opened picture whose canvas grows, refusals (CMYK,
// adjustment layers), .omw round trip, and the command / menu entry.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { getBlob, makeAsset } from "../../src/core/assets";
import { imgToTiles, newImg, tileBounds, tilesToImg, type Img } from "../../src/core/image/pixels";
import { encodePng } from "../../src/core/image/png";
import { keepJpegMeta, keepPngMeta, keepsProfile } from "../../src/core/image/imageMeta";
import { zlibSync } from "fflate";
import { setSrModelReader } from "../../src/core/image/sr/models";
import { draftPage, findPage, useStore } from "../../src/core/store";
import { newDocument, newImage, newPage, newRaster, type ImageNode, type RasterNode } from "../../src/core/types";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { decodePsd, importPsdPage } from "../../src/io/formats/psd";
import { buildPsd, checkPsd, decodePngRgba, writePsd, type FreshLayer } from "../../src/io/formats/psdWrite";
import { applyUpscale, setUpscaleCodec, upscaleRefusal } from "../../src/ui/upscaleActions";
import { COMMANDS } from "../../src/ui/commands";
import { menuCommandIds } from "../../src/ui/menus";
import { DICTS, t } from "../../src/i18n";
import { omwIllustration } from "./srSet";

const S = useStore.getState;

beforeAll(() => {
  setSrModelReader(async (f) => new Uint8Array(readFileSync(`public/models/sr/${f}`)));
  // no canvas in tests: PNG through the pure encoder, other formats "not writable here" (→ PNG)
  setUpscaleCodec({
    decode: async (bytes) => {
      const p = decodePngRgba(bytes);
      return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.rgba) };
    },
    encode: async (img, mime) => (mime === "image/png" ? encodePng(img.data, img.width, img.height, 4) : null),
  });
});

const fill = (w: number, h: number, c: number[]) => {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set(c, i * 4);
  return o;
};

function rasterOf(img: Img, x = 0, y = 0): RasterNode {
  const n = newRaster("layer");
  n.tiles = imgToTiles(img, 0, 0, {}).tiles;
  n.transform = { x, y, rotation: 0, scale: 1 };
  return n;
}

describe("raster layers", () => {
  it("the painted area grows 2× from its top-left corner, in one undo step", async () => {
    S().load(newDocument("t"));
    const img = newImg(300, 40);
    img.data.set(omwIllustration(300, 40, 2).data);
    // shift the content to start at (5, 3) inside the tile grid: the frame must keep that corner
    const shifted = newImg(310, 50);
    for (let y = 0; y < 40; y++) shifted.data.set(img.data.subarray(y * 1200, (y + 1) * 1200), ((y + 3) * 310 + 5) * 4);
    const n = rasterOf(shifted);
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    const r = await applyUpscale({ scale: 2, method: "hq" });
    expect(r).toMatchObject({ width: 600, height: 80 });
    const cur = findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === n.id) as RasterNode;
    const b = tileBounds(cur.tiles)!;
    const px = tilesToImg(cur.tiles, b);
    // first painted pixel is still at (5, 3); the area is 600 × 80
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < px.height; y++)
      for (let x = 0; x < px.width; x++)
        if (px.data[(y * px.width + x) * 4 + 3]) (x0 = Math.min(x0, x)), (y0 = Math.min(y0, y)), (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
    expect([x0 + b.ox, y0 + b.oy, x1 - x0 + 1, y1 - y0 + 1]).toEqual([5, 3, 600, 80]);
    S().undo();
    expect((findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === n.id) as RasterNode).tiles).toBe(n.tiles);
  });

  it("AI method on a raster layer (CPU here), and the result survives .omw save / load", async () => {
    S().load(newDocument("t"));
    const n = rasterOf(omwIllustration(40, 30, 7));
    S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
    S().set({ selection: [n.id] });
    expect(await applyUpscale({ scale: 4, method: "ai", aiModel: "auto" })).toMatchObject({ width: 160, height: 120 });
    const cur = findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === n.id) as RasterNode;
    const back = unpackOmw(packOmw(S().doc).bytes);
    expect(back.report.missingAssets).toBe(0);
    const re = back.doc.pages[0].nodes.find((x) => x.id === n.id) as RasterNode;
    expect(Object.keys(re.tiles).sort()).toEqual(Object.keys(cur.tiles).sort());
    for (const k of Object.keys(cur.tiles)) expect(Array.from(re.tiles[k].data.subarray(0, 4096))).toEqual(Array.from(cur.tiles[k].data.subarray(0, 4096)));
  }, 60_000);

  it("PSD layer: upscaled, saved through the PSD Surgeon and read back bigger", async () => {
    const W = 120, H = 90;
    const art = omwIllustration(30, 20, 3);
    const layers: FreshLayer[] = [
      { name: "Background", px: { rgba: fill(W, H, [250, 250, 250, 255]), left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL", background: true },
      { name: "logo", px: { rgba: new Uint8Array(art.data.buffer.slice(0)), left: 10, top: 12, width: 30, height: 20 }, opacity: 1, visible: true, blend: "NORMAL" },
    ];
    const bytes = buildPsd({ width: W, height: H, layers });
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-upscale.psd");
    const r = importPsdPage(bytes, "omw-upscale.psd", "omw-upscale", asset);
    const doc = newDocument("t");
    doc.pages = [r.page];
    doc.assets[asset.id] = asset;
    S().load(doc);
    S().set({ pageId: r.page.id, selection: [r.page.source!.psd!.layers[1].node!] });
    expect(await applyUpscale({ scale: 3, method: "hq" })).toMatchObject({ width: 90, height: 60 });
    const out = await writePsd(S().doc, S().doc.pages[0]);
    expect(checkPsd(out.bytes, { width: W, height: H, depth: 8, mode: 3, psb: false })).toEqual([]);
    const psd = decodePsd(out.bytes);
    const logo = psd.layers.find((l: any) => l.name === "logo") as any;
    expect([logo.left, logo.top, logo.width, logo.height]).toEqual([10, 12, 90, 60]);
    // reopen: the layer is the bigger one
    const again = importPsdPage(out.bytes, "omw-upscale.psd", "omw-upscale", makeAsset(out.bytes, "image/vnd.adobe.photoshop", "omw-upscale.psd"));
    const node = again.page.nodes.find((n) => n.name === "logo") as RasterNode;
    const b = tileBounds(node.tiles)!;
    const px = tilesToImg(node.tiles, b);
    let count = 0;
    for (let i = 3; i < px.data.length; i += 4) if (px.data[i]) count++;
    expect(count).toBe(90 * 60);
  });

  it("refuses CMYK documents and adjustment layers with a notice", () => {
    const bytes = buildPsd({ width: 8, height: 8, mode: 4, layers: [{ name: "c", px: { rgba: fill(8, 8, [20, 40, 60, 255]), left: 0, top: 0, width: 8, height: 8 }, opacity: 1, visible: true, blend: "NORMAL" }] });
    const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-cmyk.psd");
    const r = importPsdPage(bytes, "omw-cmyk.psd", "omw-cmyk", asset);
    const doc = newDocument("t");
    doc.pages = [r.page];
    doc.assets[asset.id] = asset;
    S().load(doc);
    const node = r.page.source!.psd!.layers[0].node!;
    expect(upscaleRefusal({ pageId: r.page.id, node: r.page.nodes.find((n) => n.id === node) as RasterNode })).toBe(t("image.upscale.refuse.cmyk"));
    const adj = newRaster("levels");
    adj.adjust = { kind: "levels" } as any;
    expect(upscaleRefusal({ pageId: r.page.id, node: adj })).toBe(t("image.upscale.refuse.adjust"));
  });
});

describe("pictures", () => {
  it("an opened PNG: the asset stays PNG with its metadata, the canvas grows, undo restores everything", async () => {
    const src = omwIllustration(24, 16, 9);
    const fresh = encodePng(src.data, 24, 16, 4);
    // the "file": PNG with a text chunk and a pixel size (2835 px/m = 72 dpi)
    const text = new TextEncoder().encode("Comment\0omw test");
    const phys = new Uint8Array([0, 0, 11, 19, 0, 0, 11, 19, 1]);
    const file = encodePngWithChunks(fresh, [["tEXt", text], ["pHYs", phys]]);
    const asset = makeAsset(file, "image/png", "omw-pic.png");
    const doc = newDocument("t");
    const page = newPage("DESIGN", 24, 16, "omw-pic");
    page.source = { format: "png", name: "omw-pic.png" };
    const img = newImage(asset.id, 24, 16, "omw-pic.png");
    img.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
    page.nodes = [img];
    doc.pages = [page];
    doc.assets[asset.id] = asset;
    S().load(doc);
    S().set({ pageId: page.id, selection: [img.id] });
    expect(await applyUpscale({ scale: 2, method: "smooth" })).toMatchObject({ width: 48, height: 32 });
    const pg = findPage(S().doc, page.id)!;
    const node = pg.nodes[0] as ImageNode;
    expect([pg.width, pg.height, node.width, node.height]).toEqual([48, 32, 48, 32]);
    const a = S().doc.assets[node.assetId];
    expect(a.mime).toBe("image/png");
    expect(a.name).toBe("omw-pic.png");
    const out = getBlob(a.hash)!;
    expect(decodePngRgba(out).width).toBe(48);
    const s = new TextDecoder("latin1").decode(out);
    expect(s).toContain("omw test");
    // pHYs doubled (the print size stays the same)
    const at = s.indexOf("pHYs");
    expect(new DataView(out.buffer, out.byteOffset + at + 4, 8).getUint32(0)).toBe(2835 * 2);
    S().undo();
    expect([findPage(S().doc, page.id)!.width, (findPage(S().doc, page.id)!.nodes[0] as ImageNode).assetId]).toEqual([24, asset.id]);
  });

  it("JPEG metadata: Exif (orientation reset, size updated), ICC and comments go into the new file", () => {
    const seg = (m: number, body: number[]) => [0xff, m, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
    // Exif: little-endian TIFF, IFD0 with Orientation = 6 and an Exif IFD pointer; Exif IFD with PixelX/YDimension
    const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 38, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0x02, 0xa0, 4, 0, 1, 0, 0, 0, 24, 0, 0, 0, 0x03, 0xa0, 4, 0, 1, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0];
    const exif = seg(0xe1, [...new TextEncoder().encode("Exif\0\0"), ...tiff]);
    const icc = seg(0xe2, [...new TextEncoder().encode("ICC_PROFILE\0"), 1, 1, ...iccHeader("RGB ")]);
    const com = seg(0xfe, [...new TextEncoder().encode("omw comment")]);
    const jfif = seg(0xe0, [...new TextEncoder().encode("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
    const dqt = seg(0xdb, new Array(65).fill(1));
    const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0xff, 0xd9];
    const orig = new Uint8Array([0xff, 0xd8, ...exif, ...icc, ...com, ...dqt, ...sos]);
    const fresh = new Uint8Array([0xff, 0xd8, ...jfif, ...dqt, ...sos]);
    const out = keepJpegMeta(orig, fresh, 48, 32);
    const s = new TextDecoder("latin1").decode(out);
    expect(s.indexOf("JFIF")).toBeLessThan(s.indexOf("Exif"));
    expect(s).toContain("ICC_PROFILE");
    expect(s).toContain("omw comment");
    const t0 = s.indexOf("Exif") + 6, dv = new DataView(out.buffer, out.byteOffset + t0);
    expect(dv.getUint16(8 + 2 + 8, true)).toBe(1); // Orientation
    expect(dv.getUint32(38 + 2 + 8, true)).toBe(48);
    expect(dv.getUint32(38 + 2 + 12 + 8, true)).toBe(32);
    expect(Array.from(out.subarray(-14))).toEqual(sos);
    expect(keepJpegMeta(new Uint8Array([1, 2, 3]), fresh, 1, 1)).toBe(fresh);
    expect(keepsProfile(orig, "image/jpeg")).toBe(true);
  });

  it("JPEG: XMP orientation reset (same length), MPF and grey / CMYK profiles not carried", () => {
    const seg = (m: number, body: number[]) => [0xff, m, ((body.length + 2) >> 8) & 255, (body.length + 2) & 255, ...body];
    const te = new TextEncoder();
    const xmpText = 'http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><rdf:Description tiff:Orientation="6" dc:title="Ömni"/><tiff:Orientation>8</tiff:Orientation></x:xmpmeta>';
    const xmp = seg(0xe1, [...te.encode(xmpText)]);
    const mpf = seg(0xe2, [...te.encode("MPF\0"), 0x49, 0x49, 42, 0, 8, 0, 0, 0]);
    const grey = seg(0xe2, [...te.encode("ICC_PROFILE\0"), 1, 1, ...iccHeader("GRAY")]);
    const dqt = seg(0xdb, new Array(65).fill(1));
    const sof = seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]);
    const sos = [0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0x12, 0x34, 0xff, 0xd9];
    const orig = new Uint8Array([0xff, 0xd8, ...xmp, ...mpf, ...grey, ...dqt, ...sof, ...sos]);
    const fresh = new Uint8Array([0xff, 0xd8, ...dqt, ...sof, ...sos]);
    const out = keepJpegMeta(orig, fresh, 32, 32);
    const s = new TextDecoder("utf-8").decode(out);
    expect(s).toContain('tiff:Orientation="1" dc:title="Ömni"');
    expect(s).toContain("<tiff:Orientation>1</tiff:Orientation>");
    expect(out.length).toBe(fresh.length + xmp.length);
    expect(s).not.toContain("MPF");
    expect(s).not.toContain("ICC_PROFILE");
    // a grey profile: decode to sRGB instead of keeping the stored values
    expect(keepsProfile(orig, "image/jpeg")).toBe(false);
    // a CMYK JPEG (4 components)
    const cmyk = new Uint8Array([0xff, 0xd8, ...dqt, ...seg(0xc0, [8, 0, 16, 0, 16, 4, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 4, 0x11, 0]), ...sos]);
    expect(keepsProfile(cmyk, "image/jpeg")).toBe(false);
    expect(keepsProfile(fresh, "image/jpeg")).toBe(true);
    expect(keepsProfile(fresh, "image/webp")).toBe(false);
  });

  it("PNG: eXIf orientation reset and size updated, a grey iCCP and the other colour chunks not carried", () => {
    const src = omwIllustration(8, 6, 2);
    const fresh = encodePng(src.data, 8, 6, 4);
    const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 2, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0x87, 0x69, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38, 0, 0, 0, 0, 0, 2, 0xa0, 0x02, 0, 4, 0, 0, 0, 1, 0, 0, 0, 8, 0xa0, 0x03, 0, 4, 0, 0, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0];
    const greyIcc = new Uint8Array([...new TextEncoder().encode("omw grey\0"), 0, ...zlibSync(new Uint8Array(iccHeader("GRAY")))]);
    const file = encodePngWithChunks(fresh, [["iCCP", greyIcc], ["gAMA", new Uint8Array([0, 0, 0xb1, 0x8f])], ["eXIf", new Uint8Array(tiff)]]);
    expect(keepsProfile(file, "image/png")).toBe(false);
    const out = keepPngMeta(file, fresh, 2, 2);
    const s = new TextDecoder("latin1").decode(out);
    expect(s).not.toContain("iCCP");
    expect(s).not.toContain("gAMA");
    const at = s.indexOf("eXIf") + 4, dv = new DataView(out.buffer, out.byteOffset + at);
    expect(dv.getUint16(8 + 2 + 8)).toBe(1); // Orientation, big-endian TIFF
    expect(dv.getUint32(38 + 2 + 8)).toBe(16);
    expect(dv.getUint32(38 + 2 + 12 + 8)).toBe(12);
    expect(decodePngRgba(out).width).toBe(8); // still a valid PNG (CRCs)
    // an RGB profile is kept
    const rgb = encodePngWithChunks(fresh, [["iCCP", new Uint8Array([...new TextEncoder().encode("omw rgb\0"), 0, ...zlibSync(new Uint8Array(iccHeader("RGB ")))])]]);
    expect(keepsProfile(rgb, "image/png")).toBe(true);
    expect(new TextDecoder("latin1").decode(keepPngMeta(rgb, fresh, 2, 2))).toContain("iCCP");
  });
});

/** The first bytes of an ICC profile with the given colour space (header bytes 16..19). */
function iccHeader(space: string): number[] {
  const h = new Array(128).fill(0);
  for (let i = 0; i < 4; i++) h[16 + i] = space.charCodeAt(i);
  return h;
}

describe("command", () => {
  it("image.upscale is registered, in the 이미지 menu, labelled, a dialog, usable with a raster / image target", () => {
    const c = COMMANDS.find((x) => x.id === "image.upscale")!;
    expect(c).toBeTruthy();
    expect(c.dialog).toBe(true);
    expect(menuCommandIds().filter((x) => x === "image.upscale").length).toBe(1);
    for (const l of ["ko", "en", "zh", "ja"] as const) expect(DICTS[l]["cmd.image.upscale"]).toBeTruthy();
    S().load(newDocument("t"));
    S().set({ selection: [] });
    expect(c.when!()).toBe(false);
    S().set({ selection: [findPage(S().doc, S().pageId)!.nodes[0].id] });
    expect(c.when!()).toBe(true);
  });
});

/** A PNG with extra chunks put before IDAT. */
function encodePngWithChunks(png: Uint8Array, chunks: [string, Uint8Array][]): Uint8Array {
  const crcT = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const v of b) c = crcT[(c ^ v) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const parts: Uint8Array[] = [png.subarray(0, 33)];
  for (const [type, data] of chunks) {
    const c = new Uint8Array(12 + data.length), dv = new DataView(c.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) c[4 + i] = type.charCodeAt(i);
    c.set(data, 8);
    dv.setUint32(8 + data.length, crc(c.subarray(4, 8 + data.length)));
    parts.push(c);
  }
  parts.push(png.subarray(33));
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let p = 0;
  for (const q of parts) out.set(q, p), (p += q.length);
  return out;
}
