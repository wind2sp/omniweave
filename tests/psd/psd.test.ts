// PSD read / "PSD Surgeon" write. Fixtures are synthesized with the writer from the public specification;
// real files from test-corpus/etc are read by path only (skipped when absent) and never printed.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/loom";
import { newDocument, newVector, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { formatForExt, sameTypeExport } from "../../src/io/formats";
import { decodePsd, importPsdPage, parsePsdLayout, PsdFormatError, unpackBits, withoutCmykManagement, type PsdLayout } from "../../src/io/formats/psd";
import { buildPsd, checkPsd, encodeChannel, isHalfBackground, rasterPixels, writePsd, type FreshLayer, type LayerPixels } from "../../src/io/formats/psdWrite";
import { rasterFromRgba } from "../../src/io/formats/raster";

// ───────── helpers ─────────

function pattern(w: number, h: number, seed: number, alpha = true): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      out[i] = (x * 7 + seed * 31) & 255;
      out[i + 1] = (y * 11 + seed * 17) & 255;
      out[i + 2] = ((x ^ y) * 5 + seed) & 255;
      out[i + 3] = alpha ? (x + y + seed) % 5 === 0 ? 0 : 255 - ((x * y) % 3) * 60 : 255;
    }
  return out;
}

const px = (rgba: Uint8Array, left: number, top: number, width: number, height: number): LayerPixels => ({ rgba, left, top, width, height });

function raster(name: string, p: LayerPixels): RasterNode {
  const r = rasterFromRgba(p.rgba, p.width, p.height, name);
  r.transform = { x: p.left, y: p.top, rotation: 0, scale: 1 };
  return r;
}

/** Straight-alpha pixels as stored (colour of fully transparent pixels is irrelevant). */
function visiblePixels(p: LayerPixels | null): string {
  if (!p) return "none";
  const parts: number[] = [p.left, p.top, p.width, p.height];
  for (let i = 0; i < p.rgba.length; i += 4) parts.push(...(p.rgba[i + 3] ? [p.rgba[i], p.rgba[i + 1], p.rgba[i + 2], p.rgba[i + 3]] : [0, 0, 0, 0]));
  return parts.join(",");
}

function open(bytes: Uint8Array, name = "test.psd"): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
  const r = importPsdPage(bytes, name, "test", asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
const slice = (L: PsdLayout, s: { start: number; end: number }) => L.bytes.subarray(s.start, s.end);
const recBytes = (L: PsdLayout, i: number) => slice(L, L.records[i]);
const chanBytes = (L: PsdLayout, i: number) => L.records[i].channels.map((c) => Array.from(slice(L, c)).join(",")).join("|");

function editPixels(n: RasterNode, color: [number, number, number, number]): RasterNode {
  const key = Object.keys(n.tiles).sort()[0];
  const data = new Uint8ClampedArray(n.tiles[key].data);
  for (let y = 2; y < 12; y++) for (let x = 2; x < 12; x++) data.set(color, (y * 256 + x) * 4);
  return { ...n, tiles: { ...n.tiles, [key]: makeTile(data) } };
}

function replaceNode(page: Page, id: string, next: RasterNode) {
  page.nodes = page.nodes.map((n) => (n.id === id ? next : n));
}

const layersOf = (page: Page) => page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode) as RasterNode[];

// ───────── synthetic fixtures ─────────

function sample(): { bytes: Uint8Array; layers: FreshLayer[] } {
  const layers: FreshLayer[] = [
    { name: "배경", px: px(pattern(40, 30, 1, false), 0, 0, 40, 30), opacity: 1, visible: true, blend: "NORMAL" },
    { name: "Multiply 반투명", px: px(pattern(12, 9, 2), 5, 4, 12, 9), opacity: 128 / 255, visible: true, blend: "MULTIPLY" },
    { name: "밖으로 나간 레이어", px: px(pattern(20, 10, 3), -6, 25, 20, 10), opacity: 1, visible: true, blend: "SCREEN" },
    { name: "숨김", px: px(pattern(8, 8, 4), 30, 2, 8, 8), opacity: 1, visible: false, blend: "NORMAL", locked: true },
  ];
  return { bytes: buildPsd({ width: 40, height: 30, layers }), layers };
}

const ascii = (s: string) => new TextEncoder().encode(s);
function rawBlock(key: string, data: number[]): Uint8Array {
  const d = new Uint8Array(12 + data.length + (data.length % 2));
  d.set(ascii("8BIM"), 0);
  d.set(ascii(key), 4);
  new DataView(d.buffer).setUint32(8, data.length + (data.length % 2));
  d.set(data, 12);
  return d;
}
const lsct = (t: number) => rawBlock("lsct", [0, 0, 0, t]);

/** divider, child A (masked), child B, folder "그룹" (bottom → top), then a top layer outside the group. */
function grouped(): Uint8Array {
  const mask = new Uint8Array(6 * 4).fill(255);
  for (let i = 0; i < 6; i++) mask[i] = 0; // first mask row hides the layer's first row
  const layers: FreshLayer[] = [
    { name: "</Layer group>", px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [lsct(3)] },
    { name: "A", px: px(pattern(6, 4, 5, false), 2, 2, 6, 4), opacity: 1, visible: true, blend: "NORMAL", mask: { left: 2, top: 2, width: 6, height: 4, data: mask, defaultColor: 0 } },
    { name: "B", px: px(pattern(5, 5, 6), 10, 3, 5, 5), opacity: 1, visible: true, blend: "NORMAL", clipping: true },
    { name: "그룹", px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [lsct(1)] },
    { name: "위", px: px(pattern(4, 4, 7), 1, 10, 4, 4), opacity: 1, visible: true, blend: "NORMAL" },
  ];
  return buildPsd({ width: 16, height: 16, layers });
}

// ───────── tests ─────────

describe("PSD writer: new documents", () => {
  it("fresh PSD round trip keeps layer count, names, pixels, opacity, blend, visibility and locks", async () => {
    const doc = newDocument("t");
    const page = doc.pages[0];
    page.width = 40;
    page.height = 30;
    const { layers } = sample();
    page.nodes = layers.map((l) => {
      const r = raster(l.name, l.px!);
      r.opacity = l.opacity;
      r.visible = l.visible;
      r.blendMode = l.blend;
      r.locked = !!l.locked;
      return r;
    });
    const out = await writePsd(doc, page);
    expect(out.method).toBe("fresh");
    const back = open(out.bytes).page;
    const got = layersOf(back);
    expect(got.map((n) => n.name)).toEqual(layers.map((l) => l.name));
    got.forEach((n, i) => {
      expect(visiblePixels(rasterPixels(n))).toBe(visiblePixels(rasterPixels(page.nodes[i] as RasterNode)));
      expect(n.opacity).toBeCloseTo(layers[i].opacity, 5);
      expect(n.blendMode).toBe(layers[i].blend);
      expect(n.visible).toBe(layers[i].visible);
      expect(n.locked).toBe(!!layers[i].locked);
    });
    const img = decodePsd(out.bytes);
    expect(img.composite!.length).toBe(40 * 30 * 4);
    expect(img.compositeAlpha).toBe(true);
  });

  it("non-raster nodes without a renderer are reported, not silently dropped", async () => {
    const doc = newDocument("t");
    const page = doc.pages[0];
    page.nodes = [raster("r", px(pattern(4, 4, 1), 0, 0, 4, 4)), newVector([rectContour(0, 0, 10, 10)])];
    const out = await writePsd(doc, page);
    expect(out.warnings.join()).toContain("빠진 개체 1개");
    expect(decodePsd(out.bytes).layers).toHaveLength(1);
  });

  it("16-bit (Lr16), grayscale, CMYK and PSB documents decode to the written pixels", () => {
    const rgba = pattern(9, 7, 3);
    const gray = new Uint8Array(rgba);
    for (let i = 0; i < gray.length; i += 4) gray[i + 1] = gray[i + 2] = gray[i];
    for (const [spec, src] of [
      [{ depth: 16 }, rgba],
      [{ mode: 1 }, gray],
      [{ mode: 4 }, rgba],
      [{ psb: true }, rgba],
      [{ psb: true, depth: 16, mode: 4 }, rgba],
    ] as const) {
      const bytes = buildPsd({ width: 12, height: 10, ...spec, layers: [{ name: "L", px: px(src, 2, 1, 9, 7), opacity: 1, visible: true, blend: "NORMAL" }] });
      const L = parsePsdLayout(bytes);
      if (spec.depth === 16) expect(L.layerInfo?.where).toBe("Lr16");
      expect(L.psb).toBe(!!("psb" in spec && spec.psb));
      // a fresh CMYK file is written with the exact inverse of the colour-unmanaged conversion (a fixture writer; the
      // app writes new PSDs as RGB): read it back that way — without a profile it is otherwise shown through FOGRA39
      const img = "mode" in spec && spec.mode === 4 ? withoutCmykManagement(() => decodePsd(bytes)) : decodePsd(bytes);
      expect(img.layers).toHaveLength(1);
      expect(visiblePixels(px(img.layers[0].rgba!, img.layers[0].left, img.layers[0].top, 9, 7))).toBe(visiblePixels(px(src, 2, 1, 9, 7)));
      expect(img.composite!.length).toBe(12 * 10 * 4);
    }
  });

  it("PackBits encoder round-trips runs, literals and long rows", () => {
    const row = new Uint8Array(1000);
    for (let i = 0; i < row.length; i++) row[i] = i < 300 ? 7 : i < 600 ? i & 255 : (i >> 4) & 1;
    const enc = encodeChannel(row, 1000, 1, 1, false);
    const out = new Uint8Array(1000);
    const n = (enc[2] << 8) | enc[3];
    unpackBits(enc, 4, 4 + n, out, 0, 1000);
    expect(same(out, row)).toBe(true);
  });
});

describe("PSD reader: structure", () => {
  it("groups become page groups (plain layer names), masks are baked, clipping and locks are reported", () => {
    const img = decodePsd(grouped());
    expect(img.layers.map((l) => l.kind)).toEqual(["groupEnd", "pixel", "pixel", "group", "pixel"]);
    expect(img.layers[1].group).toEqual(["그룹"]);
    expect(img.layers[4].group).toEqual([]);
    expect(img.layers[1].maskBaked).toBe(true);
    expect(Array.from(img.layers[1].rgba!.subarray(0, 24)).filter((_, i) => i % 4 === 3)).toEqual([0, 0, 0, 0, 0, 0]); // first row masked out
    expect(img.layers[1].rgba![6 * 4 + 3]).toBe(255);
    expect(img.layers[2].clipping).toBe(true);
    const { page } = open(grouped());
    expect(layersOf(page).map((n) => n.name)).toEqual(["A", "B", "위"]);
    expect(page.groups?.map((g) => g.name)).toEqual(["그룹"]);
    expect(layersOf(page).map((n) => !!n.groupId)).toEqual([true, true, false]);
    expect(layersOf(page)[1].clip).toBe(true);
    expect(page.source?.psd?.layers.map((l) => l.node === null)).toEqual([true, false, false, true, false]);
  });

  it("import turns each layer into tiles as soon as it is decoded and keeps no full-size buffers", () => {
    const layers: FreshLayer[] = [
      { name: "a", px: px(pattern(300, 280, 1), 0, 0, 300, 280), opacity: 1, visible: true, blend: "NORMAL" },
      { name: "b", px: px(pattern(40, 30, 2), 5, 6, 40, 30), opacity: 1, visible: true, blend: "NORMAL" },
    ];
    const bytes = buildPsd({ width: 300, height: 280, layers });
    const seen: number[] = [];
    const img = decodePsd(bytes, { onLayer: (l) => seen.push(l.rgba!.length) });
    expect(seen).toEqual([300 * 280 * 4, 40 * 30 * 4]);
    const r = importPsdPage(bytes, "t.psd", "t", makeAsset(bytes, "image/vnd.adobe.photoshop", "t.psd"));
    expect(r.image.layers.every((l) => l.rgba === null)).toBe(true);
    // the streamed tiles are the same pixels a whole-buffer conversion gives
    const nodes = r.page.source!.psd!.layers.map((k) => r.page.nodes.find((n) => n.id === k.node) as RasterNode);
    expect(nodes.map((n) => Object.keys(n.tiles).sort().map((k) => n.tiles[k].hash).join())).toEqual(
      img.layers.map((l) => {
        const t = rasterFromRgba(l.rgba!, l.width, l.height, "").tiles;
        return Object.keys(t).sort().map((k) => t[k].hash).join();
      }),
    );
  });

  it("hidden groups hide their children on the canvas but keep the layer's own flag", () => {
    const layers: FreshLayer[] = [
      { name: "</Layer group>", px: null, opacity: 1, visible: true, blend: "NORMAL", blocks: [lsct(3)] },
      { name: "child", px: px(pattern(3, 3, 1), 0, 0, 3, 3), opacity: 1, visible: true, blend: "NORMAL" },
      { name: "G", px: null, opacity: 1, visible: false, blend: "NORMAL", blocks: [lsct(2)] },
    ];
    const img = decodePsd(buildPsd({ width: 4, height: 4, layers }));
    expect(img.layers[1]).toMatchObject({ visible: true, shown: false, group: ["G"] });
  });

  it("damaged files fail with a PSD error message instead of crashing or hanging", () => {
    const good = grouped();
    for (let cut = 0; cut < good.length; cut += 7) {
      const t = good.slice(0, cut);
      try {
        const img = decodePsd(t);
        expect(img.width).toBeGreaterThan(0); // tolerated truncation in the pixel data only
      } catch (e: any) {
        expect(e).toBeInstanceOf(Error);
        expect(e).not.toBeInstanceOf(RangeError);
        expect(String(e.message)).toMatch(/PSD/);
      }
    }
    // random corruption of the structural part
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < 300; k++) {
      const t = good.slice();
      for (let j = 0; j < 4; j++) t[26 + Math.floor(rnd() * Math.min(400, t.length - 26))] = Math.floor(rnd() * 256);
      try {
        decodePsd(t);
      } catch (e: any) {
        expect(e).not.toBeInstanceOf(RangeError);
        expect(e).not.toBeInstanceOf(TypeError);
      }
    }
    expect(() => decodePsd(ascii("not a psd at all, definitely not"))).toThrow(PsdFormatError);
  });
});

describe("PSD Surgeon: edits on an imported PSD", () => {
  it("unchanged → original bytes; registry offers 'save as original type'", async () => {
    const { bytes } = sample();
    const { doc, page } = open(bytes);
    const out = await writePsd(doc, page);
    expect(out.method).toBe("original");
    expect(same(out.bytes, bytes)).toBe(true);
    const def = sameTypeExport(page)!;
    expect(def.label).toContain(".psd");
    expect(def.ext).toBe("psd");
    const viaRegistry = await def.run(doc, page, { confirm: () => true });
    expect(same(viaRegistry as Uint8Array, bytes)).toBe(true);
    expect(formatForExt("psb")?.saveAs).toBe("psd");
  });

  it("pixel edit re-encodes only that layer; other records and channel data stay byte-identical", async () => {
    const { bytes } = sample();
    const { doc, page } = open(bytes);
    const target = layersOf(page)[1];
    const edited = editPixels(target, [255, 0, 0, 255]);
    replaceNode(page, target.id, edited);
    const out = await writePsd(doc, page);
    expect(out.method).toBe("surgery");
    const A = parsePsdLayout(bytes), B = parsePsdLayout(out.bytes);
    expect(B.records).toHaveLength(A.records.length);
    for (let i = 0; i < A.records.length; i++) {
      if (i === 1) continue;
      expect(same(recBytes(A, i), recBytes(B, i))).toBe(true);
      expect(chanBytes(A, i)).toBe(chanBytes(B, i));
    }
    // the edited record keeps its additional-info blocks verbatim
    expect(B.records[1].blocks.map((k) => Array.from(slice(B, k)).join())).toEqual(A.records[1].blocks.map((k) => Array.from(slice(A, k)).join()));
    const back = open(out.bytes).page;
    expect(visiblePixels(rasterPixels(layersOf(back)[1]))).toBe(visiblePixels(rasterPixels(edited)));
    expect(visiblePixels(rasterPixels(layersOf(back)[0]))).toBe(visiblePixels(rasterPixels(layersOf(page)[0])));
    // merged image regenerated: red square visible through the multiply layer
    const img = decodePsd(out.bytes);
    expect(img.composite!.length).toBe(40 * 30 * 4);
    // second generation without edits is stable
    const again = open(out.bytes);
    expect(same((await writePsd(again.doc, again.page)).bytes, out.bytes)).toBe(true);
  });

  it("rename, hide, opacity, blend, lock and move patch the record but keep channel data", async () => {
    const { bytes } = sample();
    const { doc, page } = open(bytes);
    const [bg, mul, out_, hid] = layersOf(page);
    replaceNode(page, mul.id, { ...mul, name: "새 이름", visible: false, opacity: 0.25, blendMode: "SCREEN" });
    replaceNode(page, out_.id, { ...out_, transform: { ...out_.transform, x: out_.transform.x + 3, y: out_.transform.y - 2 } });
    replaceNode(page, hid.id, { ...hid, locked: false });
    const res = await writePsd(doc, page);
    const A = parsePsdLayout(bytes), B = parsePsdLayout(res.bytes);
    expect(same(recBytes(A, 0), recBytes(B, 0))).toBe(true);
    for (let i = 0; i < 4; i++) expect(chanBytes(A, i)).toBe(chanBytes(B, i));
    const img = decodePsd(res.bytes);
    expect(img.layers[1]).toMatchObject({ name: "새 이름", visible: false, blend: "scrn" });
    expect(img.layers[1].opacity).toBeCloseTo(0.25, 2);
    expect(img.layers[2]).toMatchObject({ left: -3, top: 23 });
    expect(img.layers[3].protect).toBe(0);
    void bg;
  });

  it("delete, reorder and add layers; groups and their markers stay balanced", async () => {
    const bytes = grouped();
    const { doc, page } = open(bytes);
    const [a, b, top] = layersOf(page);
    const added = raster("새 레이어", px(pattern(3, 3, 9), 0, 0, 3, 3));
    // order bottom → top: B, new, top, (A deleted)
    page.nodes = [b, added, top, ...page.nodes.filter((n) => n.id === page.source?.psd?.compositeNode)];
    void a;
    const res = await writePsd(doc, page);
    const img = decodePsd(res.bytes);
    expect(img.layers.map((l) => `${l.kind}:${l.name}`)).toEqual(["groupEnd:</Layer group>", "pixel:B", "group:그룹", "pixel:새 레이어", "pixel:위"]);
    expect(img.layers[1].group).toEqual(["그룹"]);
    expect(img.layers[3].id).toBeGreaterThan(Math.max(...decodePsd(bytes).layers.map((l) => l.id)));
    // untouched records are byte-identical (B and "위"), even though they moved
    const A = parsePsdLayout(bytes), B = parsePsdLayout(res.bytes);
    expect(same(recBytes(A, 2), recBytes(B, 1))).toBe(true);
    expect(same(recBytes(A, 4), recBytes(B, 4))).toBe(true);
  });

  it("editing a masked layer bakes the mask once (no double masking) and drops the mask channel", async () => {
    const bytes = grouped();
    const { doc, page } = open(bytes);
    const a = layersOf(page)[0];
    const edited = editPixels(a, [0, 0, 255, 255]);
    replaceNode(page, a.id, edited);
    const res = await writePsd(doc, page);
    expect(res.warnings.join()).toContain("마스크");
    const B = parsePsdLayout(res.bytes);
    expect(B.records[1].channels.map((c) => c.id)).not.toContain(-2);
    expect(visiblePixels(rasterPixels(layersOf(open(res.bytes).page)[0]))).toBe(visiblePixels(rasterPixels(edited)));
  });

  it("rotated / scaled layers are resampled into a new pixel layer", async () => {
    const { bytes } = sample();
    const { doc, page } = open(bytes);
    const t = layersOf(page)[3];
    replaceNode(page, t.id, { ...t, transform: { x: 20, y: 5, rotation: 30, scale: 1.5 } });
    const img = decodePsd((await writePsd(doc, page)).bytes);
    expect(img.layers[3].width).toBeGreaterThan(8);
    expect(img.layers[3].height).toBeGreaterThan(8);
  });

  it("flat PSD (no layers): editing the merged image keeps the file flat", async () => {
    const W = 20, H = 12;
    const bytes = buildPsd({ width: W, height: H, layers: [], composite: pattern(W, H, 2, false) });
    const { doc, page } = open(bytes);
    expect(page.nodes).toHaveLength(1);
    expect(same((await writePsd(doc, page)).bytes, bytes)).toBe(true);
    const edited = editPixels(page.nodes[0] as RasterNode, [9, 8, 7, 255]);
    replaceNode(page, edited.id, edited);
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    expect(L.records).toHaveLength(0);
    const img = decodePsd(out.bytes);
    expect(visiblePixels(px(img.composite!, 0, 0, W, H))).toBe(visiblePixels(rasterPixels(edited)));
    // a .psb source keeps its extension
    const psbPage = open(buildPsd({ width: 4, height: 4, psb: true, layers: [{ name: "x", px: px(pattern(2, 2, 1), 0, 0, 2, 2), opacity: 1, visible: true, blend: "NORMAL" }] }), "big.psb").page;
    expect(sameTypeExport(psbPage)!.ext).toBe("psb");
  });

  it("missing original asset falls back to a fresh PSD with a warning", async () => {
    const { bytes } = sample();
    const { doc, page } = open(bytes);
    doc.assets = {};
    const out = await writePsd(doc, page);
    expect(out.method).toBe("fresh");
    expect(out.warnings[0]).toContain("원본 PSD");
    expect(decodePsd(out.bytes).layers).toHaveLength(4);
  });
});

// ───────── real files (private corpus, read by path only) ─────────

/** records written by the earlier writer with transparency plus the Background lock (repaired on save) */
function halfBackgrounds(bytes: Uint8Array): Set<number> {
  const L = parsePsdLayout(bytes);
  const out = new Set<number>();
  L.records.forEach((r, i) => {
    if (isHalfBackground(bytes, r, i)) out.add(i);
  });
  return out;
}

const CORPUS = path.resolve(__dirname, "../../test-corpus/etc");
const corpusFiles = fs.existsSync(CORPUS) ? fs.readdirSync(CORPUS).filter((n) => /\.ps[db]$/i.test(n)) : [];

describe.skipIf(!corpusFiles.length)("PSD Surgeon: corpus files", () => {
  corpusFiles.forEach((file, k) => {
    const load = () => new Uint8Array(fs.readFileSync(path.join(CORPUS, file)));

    it(`corpus #${k + 1}: unchanged save is byte-identical (a file Photoshop refuses is repaired instead)`, async () => {
      const bytes = load();
      const { doc, page } = open(bytes, `corpus${k}.psd`);
      const out = await writePsd(doc, page);
      const bad = halfBackgrounds(bytes);
      if (!bad.size) {
        expect(out.method).toBe("original");
        expect(same(out.bytes, bytes)).toBe(true);
        return;
      }
      // saved by the earlier writer with a half-converted Background: only those records change
      expect(out.method).toBe("surgery");
      expect(checkPsd(out.bytes, null)).toEqual([]);
      const A = parsePsdLayout(bytes), B = parsePsdLayout(out.bytes);
      for (let i = 0; i < A.records.length; i++) if (!bad.has(i)) expect(same(recBytes(A, i), recBytes(B, i))).toBe(true);
      for (let i = 0; i < A.records.length; i++) expect(chanBytes(A, i) === chanBytes(B, i)).toBe(true);
    }, 60_000);

    it(`corpus #${k + 1}: one edited layer — others keep record, channel and block bytes; merged image valid`, async () => {
      const bytes = load();
      const { doc, page } = open(bytes, `corpus${k}.psd`);
      const meta = page.source!.psd!;
      // edit the first plain pixel layer
      const A = parsePsdLayout(bytes);
      const info = decodePsd(bytes, { metaOnly: true }).layers;
      const bad = halfBackgrounds(bytes);
      const ri = info.findIndex((l, i) => l.kind === "pixel" && meta.layers[i].node && !bad.has(i));
      expect(ri).toBeGreaterThanOrEqual(0);
      const node = page.nodes.find((n) => n.id === meta.layers[ri].node) as RasterNode;
      const edited = editPixels(node, [255, 0, 0, 255]);
      replaceNode(page, node.id, edited);
      const out = await writePsd(doc, page);
      expect(out.method).toBe("surgery");
      const B = parsePsdLayout(out.bytes);
      expect(B.records).toHaveLength(A.records.length);
      for (let i = 0; i < A.records.length; i++) {
        if (i === ri) continue;
        if (!bad.has(i)) expect(same(recBytes(A, i), recBytes(B, i)), `record ${i}`).toBe(true);
        expect(chanBytes(A, i) === chanBytes(B, i), `channels ${i}`).toBe(true);
      }
      // the edited layer keeps all its additional-info blocks
      expect(B.records[ri].blocks.map((x) => Array.from(slice(B, x)).join())).toEqual(A.records[ri].blocks.map((x) => Array.from(slice(A, x)).join()));
      // global blocks, colour data and non-thumbnail resources unchanged
      // (orphaned linked files left by an earlier version are removed on save — Photoshop refuses them)
      const orphans = checkPsd(bytes, null).some((p) => p.includes("연결 파일"));
      const globals = (L: PsdLayout) => L.globalBlocks.filter((x) => !(orphans && ["lnk2", "lnk3", "lnkD"].includes(x.key))).map((x) => Array.from(slice(L, x)).join()).join("|");
      expect(globals(A) === globals(B)).toBe(true);
      expect(same(slice(A, A.colorData), slice(B, B.colorData))).toBe(true);
      const res = (L: PsdLayout) => L.resItems.filter((r) => r.id !== 1036 && r.id !== 1033).map((r) => Array.from(slice(L, r)).join()).join("|");
      expect(res(A) === res(B)).toBe(true);
      // the edited pixels read back exactly
      const back = decodePsd(out.bytes);
      const bl = back.layers[ri];
      expect(visiblePixels(px(bl.rgba!, bl.left, bl.top, bl.width, bl.height)) === visiblePixels(rasterPixels(edited))).toBe(true);
      // merged image: header size and channel count intact, decodes fully
      expect([B.width, B.height, B.channels, B.depth, B.mode]).toEqual([A.width, A.height, A.channels, A.depth, A.mode]);
      expect(back.composite!.length).toBe(A.width * A.height * 4);
      expect(back.warnings.join()).not.toContain("합쳐진 이미지를 읽지 못했");
    }, 120_000);

    it(`corpus #${k + 1}: editing a smart-object / text / masked layer keeps everything else`, async () => {
      const bytes = load();
      const { doc, page } = open(bytes, `corpus${k}.psd`);
      const meta = page.source!.psd!;
      const info = decodePsd(bytes, { metaOnly: true }).layers;
      const ri = info.findIndex((l, i) => (l.kind === "smart" || l.kind === "text") && meta.layers[i].node);
      if (ri < 0) return;
      const node = page.nodes.find((n) => n.id === meta.layers[ri].node) as RasterNode;
      replaceNode(page, node.id, editPixels(node, [0, 255, 0, 255]));
      const out = await writePsd(doc, page);
      const A = parsePsdLayout(bytes), B = parsePsdLayout(out.bytes);
      const bad = halfBackgrounds(bytes);
      for (let i = 0; i < A.records.length; i++) if (i !== ri && !bad.has(i)) expect(same(recBytes(A, i), recBytes(B, i))).toBe(true);
      expect(checkPsd(out.bytes, null)).toEqual([]);
      const keys = B.records[ri].blocks.map((x) => x.key);
      expect(keys).not.toContain("SoLd");
      expect(keys).not.toContain("TySh");
      expect(keys).toEqual(A.records[ri].blocks.map((x) => x.key).filter((x) => !["TySh", "tySh", "SoLd", "SoLE", "PlLd", "plLd", "vscg", "vstk", "vogk", "vmsk", "vsms"].includes(x)));
      expect(decodePsd(out.bytes).composite!.length).toBe(A.width * A.height * 4);
    }, 120_000);
  });
});
