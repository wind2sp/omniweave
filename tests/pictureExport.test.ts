// JPG · WebP export and "save in the original format" of a picture opened as a file (io/formats/pictureExport.ts),
// the EXIF segment handling (io/formats/jpegExif.ts) and the default file names (io/exportName.ts). The JPEGs here
// are synthetic (built below: marker segments + a TIFF block, no real photo, no real location); the browser encoders
// are stood in for by a function that writes such a JPEG, so the pipeline is checked without a canvas.

import { describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { DEFAULT_TITLE, newImage, newPage, type OmwDocument, type Page } from "../src/core/types";
import { EXPORTS, exportById, sameTypeExport, type ExportCtx } from "../src/io/formats";
import { carryExif, cleanExif, exifHasGps, exifOrientation, jpegExif, jpegSegments, jpegSize, withExif } from "../src/io/formats/jpegExif";
import { pictureUnedited, type EncodeImage } from "../src/io/formats/pictureExport";
import { docFileStem, pageFileStem, stripKnownExt, withExt } from "../src/io/exportName";
import { DICTS } from "../src/i18n";

// ───────── synthetic JPEG with EXIF ─────────

type Entry = { tag: number; type: number; count: number; value: number[] | Uint8Array };
const SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 };

/** a little-endian TIFF: IFD0 (+ Exif IFD, GPS IFD, IFD1 thumbnail) — offsets laid out in order */
function tiff(o: { orientation?: number; gps?: boolean; thumb?: boolean; px?: [number, number] }): Uint8Array {
  const out: number[] = [];
  const w16 = (v: number) => out.push(v & 0xff, v >> 8);
  const w32 = (v: number) => out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  out.push(0x49, 0x49);
  w16(42);
  w32(8);
  const ascii = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)).concat(0));
  // plan the IFDs: [entries], pointer patches resolved after layout
  const ifd0: Entry[] = [{ tag: 0x010f, type: 2, count: 7, value: ascii("OmwCam") }];
  if (o.orientation) ifd0.push({ tag: 0x0112, type: 3, count: 1, value: [o.orientation] });
  ifd0.push({ tag: 0x8769, type: 4, count: 1, value: [0] }); // Exif IFD, patched
  if (o.gps) ifd0.push({ tag: 0x8825, type: 4, count: 1, value: [0] }); // GPS IFD, patched
  const exif: Entry[] = [
    { tag: 0x9003, type: 2, count: 20, value: ascii("2026:01:02 03:04:05") },
    { tag: 0xa002, type: 4, count: 1, value: [o.px?.[0] ?? 640] },
    { tag: 0xa003, type: 3, count: 1, value: [o.px?.[1] ?? 480] },
  ];
  // latitude 12°34'56" (synthetic), stored as rationals outside the entry
  const gps: Entry[] = [
    { tag: 0x0001, type: 2, count: 2, value: ascii("N") },
    { tag: 0x0002, type: 5, count: 3, value: [12, 1, 34, 1, 5600, 100] },
  ];
  const thumbJpeg = new Uint8Array([0xff, 0xd8, 0x77, 0x77, 0x77, 0x77, 0xff, 0xd9]);
  const ifd1: Entry[] = [
    { tag: 0x0201, type: 4, count: 1, value: [0] },
    { tag: 0x0202, type: 4, count: 1, value: [thumbJpeg.length] },
  ];
  const writeIfd = (list: Entry[], next: number) => {
    const start = out.length;
    const dataAt = start + 2 + list.length * 12 + 4;
    const blobs: number[] = [];
    w16(list.length);
    const at: Record<number, number> = {};
    for (const e of list) {
      at[e.tag] = out.length;
      w16(e.tag);
      w16(e.type);
      w32(e.count);
      const n = SIZE[e.type] * e.count;
      const raw: number[] = e.value instanceof Uint8Array ? [...e.value] : e.type === 3 ? e.value.flatMap((v) => [v & 0xff, v >> 8]) : e.value.flatMap((v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
      if (n <= 4) out.push(...raw, ...Array(4 - raw.length).fill(0));
      else {
        w32(dataAt + blobs.length);
        blobs.push(...raw);
      }
    }
    w32(next);
    out.push(...blobs);
    return { start, at };
  };
  const i0 = writeIfd(ifd0, 0);
  const set32 = (pos: number, v: number) => ((out[pos] = v & 0xff), (out[pos + 1] = (v >> 8) & 0xff), (out[pos + 2] = (v >> 16) & 0xff), (out[pos + 3] = (v >>> 24) & 0xff));
  const ie = writeIfd(exif, 0);
  set32(i0.at[0x8769] + 8, ie.start);
  if (o.gps) set32(i0.at[0x8825] + 8, writeIfd(gps, 0).start);
  if (o.thumb) {
    const i1 = writeIfd(ifd1, 0);
    set32(i0.start + 2 + ifd0.length * 12, i1.start);
    set32(i1.at[0x0201] + 8, out.length);
    out.push(...thumbJpeg);
  }
  return new Uint8Array(out);
}

const seg = (marker: number, data: Uint8Array | number[]) => {
  const d = data instanceof Uint8Array ? [...data] : data;
  return [0xff, marker, (d.length + 2) >> 8, (d.length + 2) & 0xff, ...d];
};
const exifBlock = (o: Parameters<typeof tiff>[0]) => new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff(o)]);

/** a JPEG's marker layout (not decodable pixels): SOI, APP0 JFIF, [APP1 Exif], DQT, SOF0 w×h, SOS, data, EOI */
function jpeg(w: number, h: number, exif?: Uint8Array, fill = 0x55, n = 64): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(exif ? seg(0xe1, exif) : []),
    ...seg(0xdb, Array(65).fill(1)),
    ...seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    ...Array(n).fill(fill),
    0xff, 0xd9,
  ]);
}

const contains = (hay: Uint8Array, needle: number[]) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
};
const LAT = [12, 0, 0, 0, 1, 0, 0, 0, 34, 0, 0, 0]; // the synthetic latitude's first rationals as stored
const THUMB = [0x77, 0x77, 0x77, 0x77];
const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

// ───────── a picture page as opening a file makes it (ui/actions.ts canvasImagePage) ─────────

function pictureDoc(bytes: Uint8Array, name: string, w: number, h: number, fmt: string): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, fmt === "jpg" ? "image/jpeg" : `image/${fmt}`, name);
  const page = newPage("DESIGN", w, h, name.replace(/\.[^.]+$/, ""));
  if (fmt !== "jpg") page.background = "transparent";
  const node = newImage(asset.id, w, h, name);
  node.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  page.nodes.push(node);
  page.source = { format: fmt, name };
  const doc = { format: "omw", version: 1, id: "d", title: name.replace(/\.[^.]+$/, ""), created: "", modified: "", pages: [page], masters: [], assets: { [asset.id]: asset } } as OmwDocument;
  return { doc, page };
}

/** stands in for the canvas encoder: a JPEG / WebP / PNG signature and the drawn size, the quality written as bytes */
function fakeEncoder(calls: { mime: string; quality: number; background: string | null; scale: number }[]): EncodeImage {
  return async (_d, page, o) => {
    calls.push(o);
    const w = Math.round(page.width * o.scale), h = Math.round(page.height * o.scale);
    if (o.mime === "image/jpeg") return jpeg(w, h, undefined, Math.round(o.quality * 100), 16 + Math.round(o.quality * 200));
    if (o.mime === "image/webp") return new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20, ...Array(Math.round(o.quality * 100)).fill(1)]);
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  };
}
const ctx = (calls: Parameters<typeof fakeEncoder>[0], options?: ExportCtx["pictureOptions"]): ExportCtx => ({ confirm: () => true, encodeImage: fakeEncoder(calls), pictureOptions: options });
const bytesOf = (x: Uint8Array | string) => (typeof x === "string" ? new TextEncoder().encode(x) : x);

// ───────── tests ─────────

describe("JPEG segments and EXIF", () => {
  const ex = exifBlock({ orientation: 6, gps: true, thumb: true, px: [640, 480] });
  const src = jpeg(640, 480, ex);

  it("reads the segments, the size and the EXIF block", () => {
    expect(jpegSegments(src).map((s) => s.marker)).toEqual([0xe0, 0xe1, 0xdb, 0xc0, 0xda]);
    expect(jpegSize(src)).toEqual({ width: 640, height: 480 });
    expect(eq(jpegExif(src)!, ex)).toBe(true);
    expect(exifHasGps(ex)).toBe(true);
    expect(exifOrientation(ex)).toBe(6);
    expect(jpegExif(jpeg(10, 10))).toBeNull();
  });

  it("cleanExif: orientation 1, thumbnail and (asked) location zeroed out, pixel size of the new picture", () => {
    const c = cleanExif(ex, { dropGps: true, width: 480, height: 640 })!;
    expect(c.length).toBe(ex.length); // edited in place: offsets stay valid
    expect(exifOrientation(c)).toBe(1);
    expect(exifHasGps(c)).toBe(false);
    expect(contains(c, LAT)).toBe(false); // the location's numbers are gone, not only unlinked
    expect(contains(c, THUMB)).toBe(false);
    expect(contains(ex, LAT) && contains(ex, THUMB)).toBe(true); // (the original is not changed)
    // the camera make and the date stay
    expect(contains(c, [..."OmwCam"].map((x) => x.charCodeAt(0)))).toBe(true);
    expect(contains(c, [..."2026:01:02"].map((x) => x.charCodeAt(0)))).toBe(true);
    // PixelXDimension (LONG) and PixelYDimension (SHORT) follow the new size
    expect(contains(c, [0x02, 0xa0, 4, 0, 1, 0, 0, 0, 0xe0, 0x01, 0, 0])).toBe(true);
    expect(contains(c, [0x03, 0xa0, 3, 0, 1, 0, 0, 0, 0x80, 0x02, 0, 0])).toBe(true);
    // keeping the location: still there
    const k = cleanExif(ex, { dropGps: false })!;
    expect(exifHasGps(k) && contains(k, LAT)).toBe(true);
    expect(exifOrientation(k)).toBe(1);
  });

  it("cleanExif refuses what it cannot read (nothing kept rather than a broken block)", () => {
    expect(cleanExif(new Uint8Array([1, 2, 3]), { dropGps: true })).toBeNull();
    const bad = ex.slice();
    bad[6 + 4] = 0xff; // IFD0 offset far outside
    bad[6 + 5] = 0xff;
    expect(cleanExif(bad, { dropGps: true })).toBeNull();
  });

  it("withExif puts the block after JFIF, replaces an old one and leaves the image data as it was", () => {
    const enc = jpeg(100, 50);
    const put = withExif(enc, ex);
    expect(jpegSegments(put).map((s) => s.marker)).toEqual([0xe0, 0xe1, 0xdb, 0xc0, 0xda]);
    expect(eq(put.subarray(put.length - 66), enc.subarray(enc.length - 66))).toBe(true);
    const again = withExif(put, exifBlock({ orientation: 3 }));
    expect(jpegSegments(again).filter((s) => s.marker === 0xe1)).toHaveLength(1);
    expect(exifOrientation(jpegExif(again)!)).toBe(3);
    expect(eq(withExif(put, null), enc)).toBe(true);
    expect(withExif(enc, null)).toBe(enc); // nothing to do: the same bytes
  });

  it("carryExif: keep · without location · none", () => {
    const enc = jpeg(480, 640);
    const keep = carryExif(enc, src, "keep");
    expect(exifHasGps(jpegExif(keep)!)).toBe(true);
    const noGps = carryExif(enc, src, "noGps");
    expect(exifHasGps(jpegExif(noGps)!)).toBe(false);
    expect(exifOrientation(jpegExif(noGps)!)).toBe(1);
    expect(contains(noGps, LAT) || contains(noGps, THUMB)).toBe(false);
    expect(jpegExif(carryExif(enc, src, "none"))).toBeNull();
    expect(jpegExif(carryExif(enc, null, "keep"))).toBeNull();
  });
});

describe("JPG / WebP export", () => {
  it("are in the export list with their own names in every language", () => {
    for (const id of ["jpg", "webp"]) {
      const e = exportById(id)!;
      expect(e.ext).toBe(id);
      for (const l of ["ko", "en", "zh", "ja"] as const)
        for (const k of [`imgexport.label.${id}`, `imgexport.hint.${id}`, `imgexport.filter.${id}`]) expect(DICTS[l][k], `${l} ${k}`).toBeTruthy();
    }
    expect(exportById("jpg")!.filter.extensions).toEqual(["jpg", "jpeg"]);
    expect(EXPORTS.findIndex((e) => e.id === "jpg")).toBe(EXPORTS.findIndex((e) => e.id === "png") + 1);
  });

  it("JPG: signature, the picture's own size, quality as chosen, transparent filled with the background, EXIF without GPS by default", async () => {
    const src = jpeg(640, 480, exifBlock({ orientation: 6, gps: true, thumb: true }));
    const { doc, page } = pictureDoc(src, "omw-photo.jpg", 480, 640, "jpg");
    page.nodes[0].opacity = 0.5; // an edit
    const calls: Parameters<typeof fakeEncoder>[0] = [];
    const asked: unknown[] = [];
    const out = bytesOf(await exportById("jpg")!.run(doc, page, ctx(calls, async (r) => (asked.push(r), { quality: 90, background: "#ffffff", exif: "noGps" }))));
    expect([...out.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(asked).toEqual([{ format: "jpg", hasExif: true, hasGps: true }]);
    expect(calls).toEqual([{ mime: "image/jpeg", quality: 0.9, background: "#ffffff", scale: 1 }]);
    expect(jpegSize(out)).toEqual({ width: 480, height: 640 });
    const ex = jpegExif(out)!;
    expect(exifOrientation(ex)).toBe(1); // drawn upright already: no second turn
    expect(exifHasGps(ex)).toBe(false);
    // a lower quality makes a smaller file (the stand-in encoder writes more bytes for higher quality, as JPEG does)
    const low = bytesOf(await exportById("jpg")!.run(doc, page, ctx([], async () => ({ quality: 40, background: "#000000", exif: "none" }))));
    expect(low.length).toBeLessThan(out.length);
    expect(jpegExif(low)).toBeNull();
  });

  it("JPG of a page that is not a picture: twice its size like PNG, chosen background; no dialog → defaults (90)", async () => {
    const page = newPage("DESIGN", 300, 200, "Page 1");
    page.background = "transparent";
    const doc = { format: "omw", version: 1, id: "d", title: "poster", created: "", modified: "", pages: [page], masters: [], assets: {} } as OmwDocument;
    const calls: Parameters<typeof fakeEncoder>[0] = [];
    const out = bytesOf(await exportById("jpg")!.run(doc, page, ctx(calls)));
    expect(calls).toEqual([{ mime: "image/jpeg", quality: 0.9, background: "#ffffff", scale: 2 }]);
    expect(jpegSize(out)).toEqual({ width: 600, height: 400 });
  });

  it("WebP: RIFF/WEBP signature, quality as chosen, transparency kept (no background)", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const { doc, page } = pictureDoc(png, "omw-pic.png", 64, 32, "png");
    const calls: Parameters<typeof fakeEncoder>[0] = [];
    const out = bytesOf(await exportById("webp")!.run(doc, page, ctx(calls, async (r) => (expect(r).toEqual({ format: "webp", hasExif: false, hasGps: false }), { quality: 75, background: "#ffffff", exif: "noGps" }))));
    expect(String.fromCharCode(...out.subarray(0, 4), ...out.subarray(8, 12))).toBe("RIFFWEBP");
    expect(calls).toEqual([{ mime: "image/webp", quality: 0.75, background: null, scale: 1 }]);
  });

  it("cancelling the dialog cancels the export", async () => {
    const { doc, page } = pictureDoc(jpeg(8, 8), "omw-c.jpg", 8, 8, "jpg");
    await expect(exportById("jpg")!.run(doc, page, ctx([], async () => null))).rejects.toThrow("SAVE_CANCELLED");
  });
});

describe("save in the original format (JPG · WebP · PNG)", () => {
  it("a JPG opened and not edited: the original bytes, EXIF and all, without asking", async () => {
    const src = jpeg(640, 480, exifBlock({ orientation: 6, gps: true, thumb: true }));
    const { doc, page } = pictureDoc(src, "omw-photo.jpg", 480, 640, "jpg");
    const same = sameTypeExport(page, doc.pages)!;
    expect(same.ext).toBe("jpg");
    expect(same.fileName!(doc, page)).toBe("omw-photo");
    expect(same.label).toContain(".jpg");
    const calls: Parameters<typeof fakeEncoder>[0] = [];
    let asked = 0;
    const out = bytesOf(await same.run(doc, page, ctx(calls, async () => (asked++, null))));
    expect(eq(out, src)).toBe(true);
    expect(calls.length + asked).toBe(0);
  });

  it("edited: drawn again in its own format (asked like an export); PNG without asking", async () => {
    const src = jpeg(40, 30, exifBlock({ gps: true }));
    const { doc, page } = pictureDoc(src, "omw-photo.jpeg", 40, 30, "jpg");
    const extra = newImage(Object.keys(doc.assets)[0], 10, 10, "copy");
    page.nodes.push(extra); // an edit: a second layer
    expect(pictureUnedited(doc, page)).toBeNull();
    const same = sameTypeExport(page, doc.pages)!;
    expect(same.ext).toBe("jpeg");
    expect(same.filter.extensions).toEqual(["jpeg", "jpg"]);
    const calls: Parameters<typeof fakeEncoder>[0] = [];
    const out = bytesOf(await same.run(doc, page, ctx(calls, async () => ({ quality: 85, background: "#ffffff", exif: "noGps" }))));
    expect(calls).toEqual([{ mime: "image/jpeg", quality: 0.85, background: "#ffffff", scale: 1 }]);
    expect(exifHasGps(jpegExif(out)!)).toBe(false);

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const p = pictureDoc(png, "omw-pic.png", 16, 16, "png");
    expect(eq(bytesOf(await sameTypeExport(p.page)!.run(p.doc, p.page, ctx([]))), png)).toBe(true);
    p.page.background = "#ff0000"; // shows through transparent pixels: an edit
    const c2: Parameters<typeof fakeEncoder>[0] = [];
    await sameTypeExport(p.page)!.run(p.doc, p.page, ctx(c2, async () => null));
    expect(c2).toEqual([{ mime: "image/png", quality: 0.9, background: null, scale: 1 }]);
  });

  it("every kind of change counts as an edit", () => {
    const edits: ((p: Page) => void)[] = [
      (p) => (p.nodes[0].transform = { ...p.nodes[0].transform, rotation: 90 }),
      (p) => (p.nodes[0].visible = false),
      (p) => ((p.nodes[0] as { width: number }).width = 10),
      (p) => (p.width = 100),
      (p) => ((p.nodes[0] as unknown as Record<string, unknown>).filters = [{ kind: "blur" }]),
      (p) => ((p as unknown as Record<string, unknown>).hf = {}),
    ];
    for (const edit of edits) {
      const { doc, page } = pictureDoc(jpeg(20, 20), "omw-e.jpg", 20, 20, "jpg");
      expect(pictureUnedited(doc, page)).not.toBeNull();
      edit(page);
      expect(pictureUnedited(doc, page)).toBeNull();
    }
    // renaming or locking the layer is not an edit of the picture
    const { doc, page } = pictureDoc(jpeg(20, 20), "omw-e.jpg", 20, 20, "jpg");
    page.nodes[0].name = "renamed";
    page.nodes[0].locked = true;
    expect(pictureUnedited(doc, page)).not.toBeNull();
  });

  it("GIF / BMP keep their old behaviour (no original-format row)", () => {
    const { page } = pictureDoc(new Uint8Array([0x47, 0x49, 0x46]), "omw-a.gif", 4, 4, "gif");
    expect(sameTypeExport(page)).toBeNull();
  });
});

describe("default file names (the name once, the extension once)", () => {
  it("a picture opened as a file: photo.jpg → photo.png / photo.jpg / photo.webp / photo.pdf / photo.omw", () => {
    const { doc, page } = pictureDoc(jpeg(8, 8), "photo.jpg", 8, 8, "jpg");
    expect(doc.title).toBe(page.name); // (the cause of the report: title and page name are the same word)
    for (const id of ["png", "jpg", "webp", "svg", "psd"]) expect(withExt(exportById(id)!.fileName!(doc, page), exportById(id)!.ext), id).toBe(`photo.${exportById(id)!.ext}`);
    for (const id of ["pdf", "docx", "hwpx", "pptx", "md", "txt"]) expect(withExt(exportById(id)!.fileName?.(doc, page) ?? docFileStem(doc), exportById(id)!.ext)).toBe(`photo.${exportById(id)!.ext}`);
    expect(withExt(docFileStem(doc), "omw")).toBe("photo.omw");
    expect(withExt(sameTypeExport(page)!.fileName!(doc, page), "jpg")).toBe("photo.jpg");
  });

  it("names that already carry an extension do not get a second one", () => {
    expect(withExt("photo.jpg", "png")).toBe("photo.png");
    expect(withExt("photo.png", "png")).toBe("photo.png");
    expect(withExt("photo.jpg.png", "png")).toBe("photo.png");
    expect(withExt("report v1.2", "pdf")).toBe("report v1.2.pdf"); // not an extension
    expect(withExt("a/b:c", "omw")).toBe("a_b_c.omw");
    expect(stripKnownExt(".png")).toBe(".png");
  });

  it("several pages: document-page once; a page named like the document is not repeated", () => {
    const pages = [newPage("DESIGN", 10, 10, "cover"), newPage("DESIGN", 10, 10, "report"), newPage("DESIGN", 10, 10, "report (2)"), newPage("DESIGN", 10, 10, "")];
    const doc = { title: "report", pages } as OmwDocument;
    expect(pages.map((p) => pageFileStem(doc, p))).toEqual(["report-cover", "report", "report (2)", "report"]);
    expect(pageFileStem({ title: "report", pages: [pages[0]] } as OmwDocument, pages[0])).toBe("report"); // one page: the name alone
    expect(pageFileStem({ title: "re", pages } as OmwDocument, pages[1])).toBe("re-report"); // (not a prefix of a longer word)
  });

  it("untitled: the name of the file the page came from, else the localized 'Untitled'", () => {
    const { doc } = pictureDoc(jpeg(8, 8), "omw-img.jpg", 8, 8, "jpg");
    expect(docFileStem({ ...doc, title: DEFAULT_TITLE })).toBe("omw-img");
    expect(docFileStem({ title: DEFAULT_TITLE, pages: [newPage("DESIGN", 1, 1, "x")] })).toBeTruthy();
  });
});

describe("PNG export size", () => {
  it("a picture opened as a file: its own pixels (1:1); other pages twice their size as before", async () => {
    const { doc, page } = pictureDoc(jpeg(64, 48), "omw-p.jpg", 64, 48, "jpg");
    const calls: Parameters<typeof fakeEncoder>[0] = [];
    let png2 = 0;
    const c: ExportCtx = { ...ctx(calls), png: async () => (png2++, new Uint8Array([0x89, 0x50])) };
    await exportById("png")!.run(doc, page, c);
    expect(calls).toEqual([{ mime: "image/png", quality: 1, background: null, scale: 1 }]);
    expect(png2).toBe(0);
    const other = newPage("DESIGN", 30, 20, "Page 1");
    const d2 = { format: "omw", version: 1, id: "d", title: "poster", created: "", modified: "", pages: [other], masters: [], assets: {} } as OmwDocument;
    calls.length = 0;
    await exportById("png")!.run(d2, other, c);
    expect(calls).toEqual([]);
    expect(png2).toBe(1);
  });
});
