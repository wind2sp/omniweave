// The default CMYK profile (core/image/iccCmyk.ts defaultCmykProfile, 2026-11-17): FOGRA39L Coated from OpenICC /
// colord (zlib / CC0, characterization data by Fogra), reduced by scripts/make-default-cmyk-icc.mjs. A CMYK document
// without a profile, or with one this cannot evaluate, is shown and separated through it; its inks and its own profile
// bytes stay as they are on save; .omw lists its tiles under psd/2 (portable conversion, tests/psd/iccPortable.test.ts),
// an older app's psd/1 listing derives as that app decoded them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { DEFAULT_CMYK_ICC_SIZE } from "../../src/core/image/defaultCmykIcc";
import { cmykXform, defaultCmykProfile, iccInfo } from "../../src/core/image/iccCmyk";
import { loadDissolveField } from "../../src/core/style/blend";
import { makeTile } from "../../src/core/tile";
import { newDocument, type RasterNode } from "../../src/core/types";
import { importPsdPage, layerCmykPlanes, parsePsdLayout, psdCmykProfile, withoutCmykManagement } from "../../src/io/formats/psd";
import { writePsd } from "../../src/io/formats/psdWrite";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { PSD_MIME, PSD_RECIPE, PSD_RECIPE_CMS, derivationPortable, derivePsdTiles, recipeFor } from "../../src/io/omwDerive";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const file = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
/** a CMYK file saved without a profile, and one with U.S. Web Coated (SWOP) v2 */
const BARE = "omni-fid-cmyk-mode-multiply.psd", SWOP = "omni-fid-cmyk-blend.psd";
const s = (pct: number) => Math.round(255 - pct * 2.55);
const DEFAULT_NOTICE = "프로필이 없는 CMYK 문서를 인쇄 표준(FOGRA39) 색으로 보여 줍니다 — 편집 프로그램의 작업 프로필(SWOP 등)과 조금 다를 수 있습니다 (잉크 값은 저장 시 그대로)";

function open(bytes: Uint8Array, name: string) {
  const hash = putBlob(bytes);
  const r = importPsdPage(bytes, name, name, { id: "a1", hash });
  const doc = newDocument("t");
  doc.assets = { a1: { id: "a1", hash, mime: PSD_MIME, name, size: bytes.length } };
  doc.pages = [r.page];
  return { doc, page: r.page, warnings: r.warnings, hash };
}

/** The file's profile (resource 1039) with its colour tables renamed away: it cannot be evaluated. */
function breakProfile(b: Uint8Array) {
  const r = parsePsdLayout(b).resItems.find((it) => it.id === 1039)!;
  for (const [name, t] of iccInfo(b.subarray(r.dataStart, r.dataEnd))!.tags) if (/^(A2B|B2A)/.test(name)) b[r.dataStart + t.at + 10] = 255;
}

beforeAll(() => loadDissolveField());

describe("the shipped profile", () => {
  it("is the reduced FOGRA39L Coated file, marked as altered, with its credits", () => {
    const d = defaultCmykProfile()!;
    expect(d.name).toBe("FOGRA39");
    expect(d.bytes.length).toBe(DEFAULT_CMYK_ICC_SIZE);
    // the module holds exactly the asset file (scripts/make-default-cmyk-icc.mjs writes both)
    const asset = new Uint8Array(readFileSync(join(__dirname, "..", "..", "src", "assets", "icc", "fogra39-default.icc")));
    expect(Buffer.compare(Buffer.from(d.bytes), Buffer.from(asset))).toBe(0);
    expect(createHash("sha256").update(asset).digest("hex")).toBe("3aad9a55749fa56baa2a3d095d78e99473f4dcf439906b67e53973cb2c825d79");
    const info = iccInfo(d.bytes)!;
    expect([info.space, info.pcs]).toEqual(["CMYK", "Lab "]);
    expect([...info.tags.keys()].sort()).toEqual(["A2B0", "A2B1", "A2B2", "B2A0", "B2A1", "B2A2", "bkpt", "cprt", "desc", "wtpt"]);
    const text = Buffer.from(d.bytes).toString("latin1");
    expect(text).toContain("FOGRA39L Coated - altered by Omniweave");
    expect(text).toContain("Characterization data FOGRA39L by Fogra (www.fogra.org)");
    expect(text).toContain("Altered source version");
    expect(text).toContain("Kai-Uwe Behrmann, Marti Maria, Photogamut, Graeme Gill, ColorSolutions");
    expect(text).not.toMatch(/Adobe/);
    // decoded once and kept
    expect(defaultCmykProfile()!.bytes).toBe(d.bytes);
  });

  it("shows the process inks as FOGRA39 is commonly quoted, paper as white; white separates to no ink", () => {
    const x = cmykXform(defaultCmykProfile()!.bytes, "FOGRA39")!;
    const o = new Uint8Array(3);
    const at = (c: number, m: number, y: number, k: number) => (x.rgb(s(c), s(m), s(y), s(k), o, 0), [...o]);
    expect(at(0, 0, 0, 0)).toEqual([255, 255, 255]);
    expect(at(100, 0, 0, 0)).toEqual([0, 159, 227]); // #009FE3
    expect(at(0, 100, 0, 0)).toEqual([230, 0, 126]); // #E6007E
    expect(at(0, 0, 100, 0)).toEqual([255, 237, 0]); // #FFED00
    const k = at(0, 0, 0, 100);
    expect(Math.max(...k)).toBeLessThan(40);
    const ink = new Uint8Array(4);
    x.cmyk(255, 255, 255, ink, 0);
    expect([...ink]).toEqual([255, 255, 255, 255]);
    // a printable colour (one the profile shows) separated again reads back as itself (B2A then A2B: a few levels)
    for (const inks of [[s(10), s(90), s(80), s(0)], [s(80), s(40), s(0), s(10)], [s(0), s(0), s(0), s(50)], [s(5), s(5), s(25), s(0)]]) {
      const rgb = (x.rgb(inks[0], inks[1], inks[2], inks[3], o, 0), [...o]);
      x.cmyk(rgb[0], rgb[1], rgb[2], ink, 0);
      x.rgb(ink[0], ink[1], ink[2], ink[3], o, 0);
      for (let c = 0; c < 3; c++) expect(Math.abs(o[c] - rgb[c]), `${rgb} → ${[...ink]} → ${[...o]}`).toBeLessThanOrEqual(4);
    }
  });
});

describe("a CMYK document without a profile", () => {
  it("opens through FOGRA39 with one notice; an unedited save is the original bytes", async () => {
    const bytes = file(BARE);
    const p = psdCmykProfile(bytes);
    expect([p.source, p.embedded, p.name, p.xf?.name]).toEqual(["default", null, "FOGRA39", "FOGRA39"]);
    const { doc, page, warnings } = open(bytes, BARE);
    expect(warnings.filter((w) => /CMYK/.test(w))).toEqual([DEFAULT_NOTICE]);
    const out = await writePsd(doc, page);
    expect(Buffer.compare(Buffer.from(out.bytes), Buffer.from(bytes))).toBe(0);
    // no profile is added to the file
    expect(parsePsdLayout(out.bytes).resItems.some((r) => r.id === 1039)).toBe(false);
  });

  it("colours a level off FOGRA39's (another engine's floating point) keep their inks (QA 2026-11-17)", async () => {
    const bytes = file(BARE);
    const { doc, page } = open(bytes, BARE);
    const L0 = parsePsdLayout(bytes);
    const links = page.source!.psd!.layers;
    const pick = page.nodes.map((x) => ({ x, i: links.findIndex((l) => l.node === x.id) })).find(({ x, i }) => x.type === "RASTER" && x.visible && !x.adjust && i >= 0 && Object.keys(x.tiles).length > 0)!;
    const n = pick.x as RasterNode;
    const before = layerCmykPlanes(L0, L0.records[pick.i])!;
    const tiles: RasterNode["tiles"] = {};
    for (const [k, t] of Object.entries(n.tiles)) {
      const d = new Uint8ClampedArray(t.data);
      for (let i = 0; i < d.length; i += 4) d[i] = d[i] < 255 ? d[i] + 1 : 254;
      tiles[k] = makeTile(d);
    }
    n.tiles = tiles;
    const out = await writePsd(doc, page);
    const L1 = parsePsdLayout(out.bytes);
    const after = layerCmykPlanes(L1, L1.records[pick.i])!;
    let differ = 0, seen = 0;
    for (let i = 0; i < before.w * before.h; i++)
      if (before.a[i]) {
        seen++;
        if (before.c[i] !== after.c[i] || before.m[i] !== after.m[i] || before.y[i] !== after.y[i] || before.k[i] !== after.k[i]) differ++;
      }
    expect(seen).toBeGreaterThan(100);
    expect(differ).toBe(0);
    // still no profile written into the file
    expect(L1.resItems.some((r) => r.id === 1039)).toBe(false);
  });

  it("shows other colours than the colour-unmanaged conversion did (the layers' pixels)", () => {
    const bytes = file(BARE);
    const managed = importPsdPage(bytes, BARE, BARE, null).page;
    const plain = withoutCmykManagement(() => importPsdPage(bytes, BARE, BARE, null).page);
    const tiles = (pg: typeof managed) => pg.nodes.flatMap((n) => (n.type === "RASTER" ? Object.values(n.tiles).map((t) => t.hash) : []));
    expect(tiles(managed)).not.toEqual(tiles(plain));
  });

  it(".omw: its tiles are listed under psd/2; an older app's psd/1 listing of them derives as that app decoded", () => {
    expect(PSD_RECIPE).toBe("psd/1");
    const bytes = file(BARE);
    expect(derivationPortable(bytes)).toBe(true);
    expect(recipeFor(bytes)).toBe(PSD_RECIPE_CMS);
    // what an older app (no default profile) decoded and listed
    const hash = putBlob(bytes);
    const r = withoutCmykManagement(() => importPsdPage(bytes, BARE, "cmyk", { id: "a1", hash }));
    const old = new Set(r.page.nodes.flatMap((n) => (n.type === "RASTER" ? Object.values(n.tiles).map((t) => t.hash) : [])));
    const derived = derivePsdTiles(bytes);
    for (const h of old) expect(derived.has(h)).toBe(true);
    const doc = newDocument("Omni PSD");
    doc.pages = [r.page];
    doc.assets = { a1: { id: "a1", hash, mime: PSD_MIME, name: BARE, size: bytes.length } };
    const files = unzipSync(packOmw(doc, [], { derive: false }).bytes);
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
    // saved by this app: the old decoding's tiles are not taken for psd/2's (only those psd/2 gives are listed)
    const again = packOmw(back);
    const idx = unzipSync(again.bytes)["rasters/derived.json"];
    const now = new Set(derivePsdTiles(bytes, PSD_RECIPE_CMS).keys());
    if (idx) for (const h of Object.values(JSON.parse(Buffer.from(idx).toString()).from as Record<string, string[]>).flat()) expect(now.has(h)).toBe(true);
    expect(again.stats.storedTiles).toBeGreaterThan(0);
    expect(unpackOmw(again.bytes).report).toMatchObject({ corruptTiles: 0, missingTiles: 0 });
    // and a fresh import lists all its tiles
    const fresh = open(bytes, BARE);
    const p = packOmw(fresh.doc);
    expect(p.stats.derivedTiles).toBe(p.stats.tiles);
    expect(unpackOmw(p.bytes).report).toMatchObject({ corruptTiles: 0, missingTiles: 0, derivedTiles: p.stats.tiles });
  });
});

describe("a CMYK document whose profile cannot be evaluated", () => {
  it("is shown through FOGRA39 with a notice naming its profile, which a save keeps byte for byte", async () => {
    const bytes = file(SWOP);
    breakProfile(bytes);
    const p = psdCmykProfile(bytes);
    expect(p.source).toBe("default");
    expect(p.xf?.name).toBe("FOGRA39");
    expect(p.name).toBe("U.S. Web Coated (SWOP) v2");
    expect(p.embedded!.length).toBeGreaterThan(500_000);
    const { doc, page, warnings } = open(bytes, "omni-qa-broken-profile.psd");
    expect(warnings.filter((w) => /CMYK|프로필/.test(w))).toEqual(["들어 있는 프로필 'U.S. Web Coated (SWOP) v2'을 읽지 못해 기본 프로필(FOGRA39)로 보여 줍니다 — PSD 편집 프로그램·인쇄에서 보는 CMYK 색과 다를 수 있습니다 (잉크 값·프로필은 저장 시 그대로)"]);
    const out = await writePsd(doc, page);
    expect(Buffer.compare(Buffer.from(out.bytes), Buffer.from(bytes))).toBe(0);
    expect(derivationPortable(bytes)).toBe(true);
    expect(recipeFor(bytes)).toBe(PSD_RECIPE_CMS);
  });

  it("a usable embedded profile still wins over the default", () => {
    const p = psdCmykProfile(file(SWOP));
    expect(p.source).toBe("embedded");
    expect(p.xf?.name).toBe("U.S. Web Coated (SWOP) v2");
  });
});
