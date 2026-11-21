// QA (2026-11-17, psd-cmyk-portable): the .omw recipe psd/2 under attack — mixed documents, an older psd/1 package
// edited and saved again, tampered listings and assets, unedited re-saves, and the conversion at its grid edges.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { cmykXform, defaultCmykProfile, ppow } from "../../src/core/image/iccCmyk";
import { loadDissolveField } from "../../src/core/style/blend";
import { makeTile } from "../../src/core/tile";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { importPsdPage, parsePsdLayout, rasterFingerprint, withoutCmykManagement } from "../../src/io/formats/psd";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { PSD_MIME, PSD_RECIPE, PSD_RECIPE_CMS, derivePsdTiles } from "../../src/io/omwDerive";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
const SWOP_PSD = "ps_cmyk_8bit.psd", BARE_PSD = "fidelity/omni-fid-cmyk-mode-multiply.psd", RGB_PSD = "psd_clip_basic.psd";

function docOf(files: string[], legacy = false): OmwDocument {
  const doc = newDocument("Omni PSD");
  doc.pages = [];
  doc.assets = {};
  files.forEach((f, i) => {
    const bytes = read(f);
    const hash = putBlob(bytes);
    const id = `a${i}`;
    const imp = () => importPsdPage(bytes, f, f, { id, hash });
    doc.pages.push((legacy ? withoutCmykManagement(imp) : imp()).page);
    doc.assets[id] = { id, hash, mime: PSD_MIME, name: f, size: bytes.length };
  });
  return doc;
}

const index = (omw: Uint8Array) => {
  const f = unzipSync(omw)["rasters/derived.json"];
  return f ? (JSON.parse(strFromU8(f)) as { recipe: string; from: Record<string, string[]> }) : null;
};
/** Same package content: every entry's bytes (the zip headers carry the save time, fflate's default mtime). */
const sameEntries = (a: Uint8Array, b: Uint8Array) => {
  const A = unzipSync(a), B = unzipSync(b);
  expect(Object.keys(B).sort()).toEqual(Object.keys(A).sort());
  for (const k of Object.keys(A)) expect(Buffer.compare(Buffer.from(B[k]), Buffer.from(A[k])), k).toBe(0);
};
/** every raster node's pixels (tile keys and content hashes), by page and node order */
const pixels = (d: OmwDocument) => d.pages.flatMap((p: Page) => p.nodes.filter((n): n is RasterNode => n.type === "RASTER").map(rasterFingerprint));

beforeAll(() => loadDissolveField());

describe("psd/2 packages under attack", () => {
  it("a document mixing RGB and colour-managed CMYK PSDs: psd/2, every tile derived, the same pixels back", () => {
    const doc = docOf([RGB_PSD, SWOP_PSD, BARE_PSD]);
    const p = packOmw(doc);
    expect(index(p.bytes)!.recipe).toBe(PSD_RECIPE_CMS);
    expect(p.stats.derivedTiles).toBe(p.stats.tiles);
    const { doc: back, report } = unpackOmw(p.bytes);
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0, derivedTiles: p.stats.tiles });
    expect(pixels(back)).toEqual(pixels(doc));
    // RGB alone stays psd/1
    expect(index(packOmw(docOf([RGB_PSD])).bytes)!.recipe).toBe(PSD_RECIPE);
  });

  it("an unedited psd/2 package saves again entry for entry, byte for byte (twice)", () => {
    const first = packOmw(docOf([SWOP_PSD, RGB_PSD])).bytes;
    const second = packOmw(unpackOmw(first).doc).bytes;
    sameEntries(first, second);
    sameEntries(first, packOmw(unpackOmw(second).doc).bytes);
  });

  it("an older psd/1 package of a CMYK file, edited and saved: nothing of the old decoding is listed under psd/2", () => {
    const legacy = docOf([SWOP_PSD], true);
    const asset = Object.values(legacy.assets)[0].hash;
    const files = unzipSync(packOmw(legacy, [], { derive: false }).bytes);
    const old = new Set(derivePsdTiles(read(SWOP_PSD)).keys());
    const listed: string[] = [];
    for (const k of Object.keys(files)) {
      const m = /^rasters\/(.+)\.(png|raw)$/.exec(k);
      if (m && old.has(m[1])) listed.push(m[1]), delete files[k];
    }
    files["rasters/derived.json"] = strToU8(JSON.stringify({ recipe: PSD_RECIPE, from: { [asset]: listed } }));
    const { doc } = unpackOmw(zipSync(files));
    // edit one tile of the first layer
    const n = doc.pages[0].nodes.find((x): x is RasterNode => x.type === "RASTER" && Object.keys(x.tiles).length > 0)!;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    data[0] ^= 0x55;
    // (a new node object, as an edit makes one: node hashes are memoized per object)
    doc.pages[0].nodes = doc.pages[0].nodes.map((x) => (x === n ? { ...n, tiles: { ...n.tiles, [key]: makeTile(data) } } : x));
    const want = pixels(doc);
    const saved = packOmw(doc);
    const idx = index(saved.bytes);
    const now = new Set(derivePsdTiles(read(SWOP_PSD), PSD_RECIPE_CMS).keys());
    for (const h of idx ? Object.values(idx.from).flat() : []) expect(now.has(h)).toBe(true);
    const { doc: back, report } = unpackOmw(saved.bytes);
    expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0 });
    expect(pixels(back)).toEqual(want);
    // and once more, unedited: the same bytes
    sameEntries(saved.bytes, packOmw(back).bytes);
  });

  it("tampering never shows other pixels: a changed listing, recipe or original is missing tiles, an unknown recipe is refused", () => {
    const doc = docOf([SWOP_PSD]);
    const files = unzipSync(packOmw(doc).bytes);
    const idx = JSON.parse(strFromU8(files["rasters/derived.json"])) as { recipe: string; from: Record<string, string[]> };
    const [asset, list] = Object.entries(idx.from)[0];
    const repack = (f: (fs: typeof files, i: typeof idx) => void) => {
      const fs = { ...files };
      const i = JSON.parse(JSON.stringify(idx));
      f(fs, i);
      fs["rasters/derived.json"] = strToU8(JSON.stringify(i));
      return unpackOmw(zipSync(fs));
    };
    // a listed hash changed: that tile is missing (reported), the others derive
    const a = repack((_, i) => (i.from[asset][0] = "0".repeat(list[0].length)));
    expect(a.report.missingTiles).toBeGreaterThan(0);
    expect(a.report.derivedTiles).toBe(list.length - 1);
    // the recipe turned back to psd/1: the colour-unmanaged decoding gives none of the listed tiles
    const b = repack((_, i) => (i.recipe = PSD_RECIPE));
    expect(b.report.missingTiles).toBeGreaterThan(0);
    expect(b.report.derivedTiles).toBeLessThan(list.length); // (tiles both decodings give alike — masks — are the same pixels)
    // a recipe from the future: refused as a newer file
    expect(() => repack((_, i) => (i.recipe = "psd/3"))).toThrow();
    // the original changed under its name: not used, the tiles are missing
    const c = repack((fs) => {
      const k = Object.keys(fs).find((x) => x.startsWith(`assets/${asset}`))!;
      const bad = new Uint8Array(fs[k] as Uint8Array);
      bad[bad.length - 1] ^= 1;
      fs[k] = bad;
    });
    expect(c.report.corruptAssets).toBe(1);
    // (this process still holds the genuine original by its hash, so the tiles derive from it — the right pixels;
    // a fresh app has nothing under that hash and reports them missing)
    expect(c.report.derivedTiles + c.report.missingTiles).toBe(list.length);
    expect(pixels(c.doc)).toEqual(pixels(doc));
  });
});

describe("the portable conversion at its edges", () => {
  const swop = () => {
    const b = read(SWOP_PSD);
    const r = parsePsdLayout(b).resItems.find((it) => it.id === 1039)!;
    return b.slice(r.dataStart, r.dataEnd);
  };
  for (const [name, bytes] of [["FOGRA39", () => defaultCmykProfile()!.bytes], ["SWOP", swop]] as const)
    it(`${name}: grid points, both ends of every axis and the K axis stay within the table's error of the profile itself`, () => {
      const x = cmykXform(bytes(), name)!;
      const o = new Uint8Array(3);
      let worst = 0;
      const check = (c: number, m: number, y: number, k: number) => {
        x.rgb(c, m, y, k, o, 0);
        const e = x.exact(c, m, y, k);
        for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(o[j] - Math.round(e[j])));
      };
      const ends = [0, 1, 14, 15, 16, 239, 240, 241, 254, 255];
      for (const c of ends) for (const m of ends) for (const y of ends) for (const k of ends) check(c, m, y, k);
      for (let v = 0; v < 256; v++) for (const s of [0, 255]) (check(v, s, s, s), check(s, v, s, s), check(s, s, v, s), check(s, s, s, v));
      expect(worst).toBeLessThanOrEqual(3); // the table's error (iccCmyk.test.ts: within 3, 99 % within 1)
      // no ink is paper white
      x.rgb(255, 255, 255, 255, o, 0);
      expect([...o]).toEqual([255, 255, 255]);
    });

  it("ppow: edge values (0, 1, subnormals, huge exponents, NaN) and the curve range against Math.pow", () => {
    expect([ppow(0, 2.4), ppow(0, 0), ppow(1, 1e9), ppow(5e-324, 2), ppow(0.5, 32767.99), ppow(-0.5, 2.4), ppow(NaN, 2), ppow(Infinity, -2)]).toEqual([0, 1, 1, 0, 0, 0, 0, 0]);
    expect(ppow(1e-300, -2)).toBe(Infinity);
    expect(ppow(2, -1074)).toBe(5e-324);
    expect(ppow(5e-324, 0.5)).toBeCloseTo(2.2227587494850775e-162, 170);
    let worst = 0;
    for (let i = 1; i <= 65535; i++)
      for (const y of [1 / 2.4, 2.4, 1 / 3, 1.8, 0.45, 3.0]) worst = Math.max(worst, Math.abs(ppow(i / 65535, y) - Math.pow(i / 65535, y)));
    expect(worst).toBeLessThan(1e-15);
  });
});
