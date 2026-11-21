// .omw container 2 (docs/design/FILE_SIZE.md): lossless PNG tiles, unedited PSD tiles re-derived from the original,
// history without repeated nodes, unused assets left out — and every file still opens exactly as it was saved.

import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { hashBytes, hashString } from "../../src/core/hash";
import { packHistory } from "../../src/core/history";
import { documentRoot, makeTile } from "../../src/core/loom";
import { TILE, newDocument, newImage, newPage, newRaster, newText, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { FORMATS, sameTypeExport } from "../../src/io/formats";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { PSD_MIME, PSD_RECIPE, PSD_RECIPE_CMS, derivationPortable, derivePsdTiles } from "../../src/io/omwDerive";
import { putBlob } from "../../src/core/assets";
import { importPsdPage, withoutCmykManagement } from "../../src/io/formats/psd";
import { OMW_CONTAINER } from "../../src/io/omwMigrate";
import { encodeRgbaPng } from "../../src/io/tileCodec";

const manifestOf = (bytes: Uint8Array) => JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]));

/** A photo-like tile with the Omniweave mark in its first bytes. */
function photo(seed: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(TILE * TILE * 4);
  let s = seed;
  for (let i = 0; i < d.length; i += 4) {
    const x = (i / 4) % TILE, y = Math.floor(i / 4 / TILE);
    s = (s * 1103515245 + 12345) >>> 0;
    d[i] = (x + seed * 7 + (s & 7)) & 255;
    d[i + 1] = (y + ((s >> 3) & 7)) & 255;
    d[i + 2] = ((x ^ y) + seed) & 255;
    d[i + 3] = x > 230 ? 0 : 255;
  }
  d.set(new TextEncoder().encode("omniweave"), 0);
  return d;
}

function rasterDoc(): OmwDocument {
  const doc = newDocument("Omni size");
  const p = newPage("DESIGN", 512, 512, "Omni");
  const r = newRaster("photo");
  const a = makeTile(photo(1)), b = makeTile(photo(2));
  r.tiles = { "0_0": a, "1_0": b, "0_1": a };
  p.nodes = [r, newText("오메 omniweave")];
  doc.pages = [p];
  return doc;
}

async function importPsd(path: string): Promise<{ doc: OmwDocument; bytes: Uint8Array }> {
  const bytes = new Uint8Array(readFileSync(path));
  const fmt = FORMATS.find((f) => f.id === "psd")!;
  const r = await fmt.open!({ name: path.split("/").pop()!, path: null, bytes } as any, { confirm: () => true } as any);
  const doc = newDocument("Omni PSD");
  doc.pages = r.pages!;
  doc.assets = r.assets ?? {};
  return { doc, bytes };
}

describe(".omw container 2", () => {
  it("stores tiles as lossless PNG and reads every pixel back (same Loom root)", () => {
    const doc = rasterDoc();
    const { bytes, stats } = packOmw(doc);
    const files = unzipSync(bytes);
    expect(manifestOf(bytes).container).toBe(2);
    expect(files["scene_graph2.cbor"]).toBeDefined();
    expect(files["scene_graph.cbor"]).toBeUndefined(); // a container-1-only app refuses instead of losing tiles
    const png = Object.keys(files).filter((k) => k.startsWith("rasters/"));
    expect(png.every((k) => k.endsWith(".png"))).toBe(true);
    expect(stats.tiles).toBe(2);
    const { doc: back, report } = unpackOmw(bytes);
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0, rootMatches: true, container: 2 });
    expect(documentRoot(back)).toBe(documentRoot(doc));
    const r = back.pages[0].nodes[0] as RasterNode;
    expect(hashBytes(r.tiles["1_0"].data)).toBe(hashBytes(photo(2)));
  });

  it("is smaller than container 1 for photo-like rasters", () => {
    const doc = rasterDoc();
    const c1 = packOmw(doc, [], { container: 1 }).bytes.length;
    const c2 = packOmw(doc).bytes.length;
    expect(c2).toBeLessThan(c1 * 0.8);
  });

  it("still reads container 1 files (raw tiles, full history) and the old layout without a container number", () => {
    const doc = rasterDoc();
    const c1 = packOmw(doc, [], { container: 1 }).bytes;
    const files = unzipSync(c1);
    expect(files["scene_graph.cbor"]).toBeDefined();
    expect(Object.keys(files).some((k) => k.endsWith(".raw"))).toBe(true);
    expect(manifestOf(c1).container).toBeUndefined();
    const { doc: back, report } = unpackOmw(c1);
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0, rootMatches: true, container: 1 });
    expect(documentRoot(back)).toBe(documentRoot(doc));
  });

  it("open + save of a container 2 file gives the same bytes (tiles are not re-encoded differently)", () => {
    const a = packOmw(rasterDoc()).bytes;
    const { doc } = unpackOmw(a);
    const b = packOmw(doc).bytes;
    const fa = unzipSync(a), fb = unzipSync(b);
    for (const k of Object.keys(fa).filter((k) => k.startsWith("rasters/"))) expect(hashBytes(fb[k])).toBe(hashBytes(fa[k]));
  });

  it("a damaged PNG tile is reported and skipped, the rest opens", () => {
    const files = unzipSync(packOmw(rasterDoc()).bytes);
    const k = Object.keys(files).find((f) => f.startsWith("rasters/"))!;
    files[k] = files[k].slice();
    files[k][60] ^= 0xff;
    const { doc, report } = unpackOmw(zipSync(files));
    expect(report.corruptTiles).toBe(1);
    expect(doc.pages[0].nodes).toHaveLength(2);
  });

  it("refuses a file from a newer package format with an update message (nothing is opened half)", () => {
    const files = unzipSync(packOmw(rasterDoc()).bytes);
    const m = JSON.parse(strFromU8(files["manifest.json"]));
    m.container = OMW_CONTAINER + 1;
    files["manifest.json"] = strToU8(JSON.stringify(m));
    expect(() => unpackOmw(zipSync(files))).toThrow(/Omniweave/);
  });

  it("history does not repeat the nodes of the saved document, equal asset tables are stored once, all states come back", () => {
    const doc0 = rasterDoc();
    const img = makeAsset(encodeRgbaPng(photo(3).subarray(0, 64 * 64 * 4), 64, 64), "image/png", "omni.png");
    const doc1: OmwDocument = { ...doc0, assets: { [img.id]: img }, pages: [{ ...doc0.pages[0], nodes: [...doc0.pages[0].nodes, newImage(img.id, 64, 64)] }] };
    const doc2: OmwDocument = { ...doc1, pages: [{ ...doc1.pages[0], nodes: [...doc1.pages[0].nodes, newText("둘째 오메")] }] };
    // the image is deleted again in the last state: its asset is still needed by the older states
    const doc3: OmwDocument = { ...doc2, pages: [{ ...doc2.pages[0], nodes: doc2.pages[0].nodes.filter((n) => n.type !== "IMAGE") }] };
    const entries = [doc0, doc1, doc2, doc3].map((d, i) => ({ id: "h" + i, time: i, label: "step " + i, root: documentRoot(d), doc: d }));
    const c1 = packOmw(doc3, entries, { container: 1 }).bytes;
    const c2 = packOmw(doc3, entries).bytes;
    const n1 = unzipSync(c1)["history/nodes.cbor"].length, n2 = unzipSync(c2)["history/nodes.cbor"].length;
    expect(n2).toBeLessThan(n1);
    const { history, report } = unpackOmw(c2);
    expect(report.historySkipped).toBe(0);
    expect(history.map((e) => documentRoot(e.doc))).toEqual(entries.map((e) => e.root));
    expect(history[1].doc.assets[img.id]).toEqual(img);
    expect(Object.keys(unzipSync(c2)).some((k) => k.startsWith(`assets/${img.hash}`))).toBe(true);
    const idx = packHistory(entries, { shared: new Set() }).index;
    expect(Object.keys(idx.assetTables!).length).toBe(2); // {} and {img}
  });

  it("leaves out assets nothing uses, keeps every asset something still names (matte, fill, page source…)", () => {
    const doc = rasterDoc();
    const used = makeAsset(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), "image/png", "used.png");
    const matte = makeAsset(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]), "image/png", "matte.png");
    const orphan = makeAsset(new Uint8Array([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4]), "image/png", "deleted.png");
    doc.assets = { [used.id]: used, [matte.id]: matte, [orphan.id]: orphan };
    const r = doc.pages[0].nodes[0] as RasterNode;
    doc.pages[0].nodes[0] = { ...r, matte: { assetId: matte.id, sourceId: "x", type: "photo", edge: {} } } as RasterNode;
    (doc as any).styles = { fills: [{ type: "image", assetId: used.id, fit: "fill" }] };
    const { bytes, stats } = packOmw(doc);
    expect(stats.droppedAssets).toBe(1);
    const names = Object.keys(unzipSync(bytes));
    expect(names.some((k) => k.includes(orphan.hash))).toBe(false);
    expect(names.some((k) => k.includes(used.hash)) && names.some((k) => k.includes(matte.hash))).toBe(true);
    const { doc: back, report } = unpackOmw(bytes);
    expect(report.rootMatches).toBe(true);
    expect(Object.keys(back.assets).sort()).toEqual([used.id, matte.id].sort());
    expect(report.missingAssets).toBe(0);
  });
});

describe(".omw container 2 — original packages kept by Surgeons", () => {
  it("an Office original named only by page.source.office.assetId is live, stored once and not deflated again", () => {
    const doc = rasterDoc();
    // a tiny zip-looking original (PK\3\4 …) as the Office Surgeon keeps it
    const pk = new Uint8Array(4096).map((_, i) => (i < 4 ? [0x50, 0x4b, 3, 4][i] : (i * 31) & 255));
    const a = makeAsset(pk, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "omni.docx");
    const dup = { ...a, id: "as-dup" }; // a second page from the same file: same bytes, one copy in the package
    doc.assets = { [a.id]: a, [dup.id]: dup };
    doc.pages = [
      { ...doc.pages[0], source: { format: "docx", name: "omni.docx", office: { assetId: a.id } } as any },
      { ...doc.pages[0], id: "pg2", source: { format: "docx", name: "omni.docx", office: { assetId: dup.id } } as any },
    ];
    const { bytes, stats } = packOmw(doc);
    expect(stats.droppedAssets).toBe(0);
    const names = Object.keys(unzipSync(bytes)).filter((k) => k.startsWith("assets/"));
    expect(names).toHaveLength(1);
    const { report, doc: back } = unpackOmw(bytes);
    expect(report).toMatchObject({ missingAssets: 0, corruptAssets: 0, rootMatches: true });
    expect(Object.keys(back.assets)).toHaveLength(2);
  });
});

describe(".omw container 2 — PSD tiles derived from the kept original", () => {
  const PSD = "qa/interop/adobe-made/psd_clip_basic.psd";

  it("lists unedited tiles instead of storing them; opening rebuilds and verifies every one; PSD save stays byte-identical", async () => {
    const { doc, bytes: orig } = await importPsd(PSD);
    const c1 = packOmw(doc, [], { container: 1 }).bytes;
    const { bytes, stats } = packOmw(doc);
    expect(stats.derivedTiles).toBe(stats.tiles);
    expect(stats.storedTiles).toBe(0);
    const files = unzipSync(bytes);
    const idx = JSON.parse(strFromU8(files["rasters/derived.json"]));
    expect(idx.recipe).toBe(PSD_RECIPE);
    expect(bytes.length).toBeLessThan(c1.length * 0.6);
    expect(bytes.length).toBeLessThan(orig.length);
    const { doc: back, report } = unpackOmw(bytes);
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0, missingAssets: 0, rootMatches: true });
    expect(report.derivedTiles).toBe(stats.tiles);
    expect(documentRoot(back)).toBe(documentRoot(doc));
    const same = await sameTypeExport(back.pages[0])!.run(back, back.pages[0], { confirm: () => true });
    expect(hashBytes(same as Uint8Array)).toBe(hashBytes(orig));
  });

  it("an edited tile is stored, the rest stays derived", async () => {
    const { doc } = await importPsd(PSD);
    const page = doc.pages[0];
    const i = page.nodes.findIndex((n) => n.type === "RASTER" && Object.keys(n.tiles).length > 0 && n.visible);
    const r = page.nodes[i] as RasterNode;
    const k = Object.keys(r.tiles)[0];
    const edited = makeTile(photo(9));
    const page2: Page = { ...page, nodes: page.nodes.map((n, j) => (j === i ? { ...r, tiles: { ...r.tiles, [k]: edited } } : n)) };
    const doc2 = { ...doc, pages: [page2] };
    const { bytes, stats } = packOmw(doc2);
    expect(stats.storedTiles).toBeGreaterThanOrEqual(1);
    expect(unzipSync(bytes)[`rasters/${edited.hash}.png`]).toBeDefined();
    const { doc: back, report } = unpackOmw(bytes);
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0, rootMatches: true });
    expect(documentRoot(back)).toBe(documentRoot(doc2));
  });

  it("derive: false keeps every tile in the file (pixel cache for fast opening)", async () => {
    const { doc } = await importPsd(PSD);
    const { stats } = packOmw(doc, [], { derive: false });
    expect(stats.derivedTiles).toBe(0);
    expect(stats.storedTiles).toBe(stats.tiles);
  });

  it(`recipe ${PSD_RECIPE} is pinned: decoding the interop PSDs gives exactly the tiles it gave when the recipe was made`, () => {
    // If this fails, PSD decoding output changed: files that list tiles under this recipe would no longer open fully.
    // Keep the old decoding for this recipe (or store tiles) and give the new decoder a new recipe id.
    // ps_cmyk_8bit carries U.S. Web Coated (SWOP) v2: the app shows it colour-managed and lists its tiles under psd/2
    // (pinned in tests/psd/iccPortable.test.ts); a psd/1 listing of them is derived as an older app decoded them.
    const pins: Record<string, string> = {
      "psd_clip_basic.psd": "c2a4de07516d01b7",
      "ps_layers_groups.psd": "fd1bdd90485d3c7c",
      "ps_cmyk_8bit.psd": "a9ac8072ecd233f5",
      "ps_16bit_rgb.psd": "43b6534d80fd1b7c",
    };
    // packages without colour-managed CMYK keep psd/1: older apps keep opening them
    expect(PSD_RECIPE).toBe("psd/1");
    expect(PSD_RECIPE_CMS).toBe("psd/2");
    const got: Record<string, string> = {};
    for (const f of Object.keys(pins)) got[f] = hashString([...derivePsdTiles(new Uint8Array(readFileSync("qa/interop/adobe-made/" + f))).keys()].sort().join(","));
    expect(got).toEqual(pins);
    expect(derivationPortable(new Uint8Array(readFileSync("qa/interop/adobe-made/ps_cmyk_8bit.psd")))).toBe(true);
  });

  it("an .omw an older app saved (a CMYK file with a profile, its tiles listed under psd/1) opens fully; saving again never lists them under psd/2", () => {
    const path = "qa/interop/adobe-made/ps_cmyk_8bit.psd";
    const bytes = new Uint8Array(readFileSync(path));
    // the document as an older version made it: decoded without colour management, its tiles listed under psd/1
    const hash = putBlob(bytes);
    const r = withoutCmykManagement(() => importPsdPage(bytes, "ps_cmyk_8bit.psd", "cmyk", { id: "a1", hash }));
    const doc = newDocument("Omni PSD");
    doc.pages = [r.page];
    doc.assets = { a1: { id: "a1", hash, mime: PSD_MIME, name: "ps_cmyk_8bit.psd", size: bytes.length } };
    const files = unzipSync(packOmw(doc, [], { derive: false }).bytes);
    const old = new Set(derivePsdTiles(bytes).keys());
    const listed: string[] = [];
    for (const k of Object.keys(files)) {
      const m = /^rasters\/(.+)\.(png|raw)$/.exec(k);
      if (m && old.has(m[1])) {
        listed.push(m[1]);
        delete files[k];
      }
    }
    expect(listed.length).toBeGreaterThan(0);
    files["rasters/derived.json"] = strToU8(JSON.stringify({ recipe: "psd/1", from: { [hash]: listed } }));
    const { doc: back, report } = unpackOmw(zipSync(files));
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0 });
    expect(report.derivedTiles).toBe(listed.length);
    // saved again: the old decoding's tiles are stored as pixels (psd/2 decodes colour-managed), and it opens fully
    const again = packOmw(back);
    const now = new Set(derivePsdTiles(bytes, PSD_RECIPE_CMS).keys());
    const idx = unzipSync(again.bytes)["rasters/derived.json"];
    const relisted = idx ? Object.values(JSON.parse(strFromU8(idx)).from as Record<string, string[]>).flat() : [];
    for (const h of relisted) expect(now.has(h)).toBe(true);
    expect(again.stats.storedTiles).toBe(again.stats.tiles - relisted.length);
    expect(again.stats.storedTiles).toBeGreaterThan(0);
    expect(unpackOmw(again.bytes).report).toMatchObject({ corruptTiles: 0, missingTiles: 0 });
  });
});
