// Rules Photoshop enforces when opening a PSD (found in an Omniweave-edited file that Photoshop 2026 refused):
// the canvas size never changes, layers sit on whole pixels, the Background-layer signature stays consistent,
// rasterized smart objects leave no orphaned linked files, and checkPsd catches the broken combinations.
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/loom";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { buildPsd, checkPsd, writePsd, type FreshLayer, type LayerPixels } from "../../src/io/formats/psdWrite";
import { rasterFromRgba } from "../../src/io/formats/raster";

const W = 40, H = 30;

function solid(w: number, h: number, c: [number, number, number, number]): Uint8Array {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set(c, i * 4);
  return o;
}
const px = (rgba: Uint8Array, left: number, top: number, width: number, height: number): LayerPixels => ({ rgba, left, top, width, height });

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
function rawBlock(key: string, data: number[]): Uint8Array {
  const n = data.length + (data.length % 2);
  const d = new Uint8Array(12 + n);
  d.set(ascii("8BIM"), 0);
  d.set(ascii(key), 4);
  new DataView(d.buffer).setUint32(8, n);
  d.set(data, 12);
  return d;
}
/** smart-object placement block that references a linked file by id */
const plld = (id: string) => rawBlock("PlLd", [...ascii("plcL"), 0, 0, 0, 3, id.length, ...ascii(id), 0, 0, 0, 0]);
/** global linked-file block with one embedded entry per id (entries 4-aligned) */
function lnk2(ids: string[]): Uint8Array {
  const data: number[] = [];
  for (const id of ids) {
    const body = [...ascii("liFD"), 0, 0, 0, 7, id.length, ...ascii(id), 1, 2, 3];
    data.push(0, 0, 0, 0, (body.length >>> 24) & 255, (body.length >> 16) & 255, (body.length >> 8) & 255, body.length & 255, ...body);
    while (data.length % 4) data.push(0);
  }
  return rawBlock("lnk2", data);
}

function fixture(): Uint8Array {
  const layers: FreshLayer[] = [
    { name: "Background", px: px(solid(W, H, [250, 250, 250, 255]), 0, 0, W, H), opacity: 1, visible: true, blend: "NORMAL", background: true },
    { name: "plain", px: px(solid(10, 8, [200, 10, 10, 255]), 3, 4, 10, 8), opacity: 1, visible: true, blend: "NORMAL" },
    { name: "smart A", px: px(solid(6, 6, [10, 200, 10, 255]), 20, 2, 6, 6), opacity: 1, visible: true, blend: "NORMAL", blocks: [plld("ID-AAAA")] },
    { name: "smart B", px: px(solid(6, 6, [10, 10, 200, 255]), 28, 12, 6, 6), opacity: 1, visible: true, blend: "NORMAL", blocks: [plld("ID-BBBB")] },
  ];
  return buildPsd({ width: W, height: H, layers, globalBlocks: [lnk2(["ID-AAAA", "ID-BBBB"])] });
}

function open(bytes: Uint8Array): { doc: OmwDocument; page: Page; byRec: (i: number) => RasterNode } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "t.psd");
  const r = importPsdPage(bytes, "t.psd", "t", asset);
  const doc = newDocument("t");
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  const meta = r.page.source!.psd!;
  return { doc, page: r.page, byRec: (i) => r.page.nodes.find((n) => n.id === meta.layers[i].node) as RasterNode };
}
const replace = (page: Page, n: RasterNode) => (page.nodes = page.nodes.map((x) => (x.id === n.id ? n : x)));
const moved = (n: RasterNode, dx: number, dy: number): RasterNode => ({ ...n, transform: { ...n.transform, x: n.transform.x + dx, y: n.transform.y + dy } });
const expectSame = (L: { width: number; height: number }) => ({ width: L.width, height: L.height, depth: 8, mode: 3, psb: false });
const bgSig = (bytes: Uint8Array) => {
  const L = parsePsdLayout(bytes);
  const r = L.records[0];
  const img = decodePsd(bytes, { metaOnly: true });
  return { alpha: r.channels.some((c) => c.id === -1), flag: r.flags & 1, lspf: img.layers[0].protect, rect: [r.left, r.top, r.right - r.left, r.bottom - r.top] };
};

describe("Photoshop rules on save", () => {
  it("the fixture follows Photoshop's own Background signature and passes the checklist", () => {
    const b = fixture();
    expect(bgSig(b)).toEqual({ alpha: false, flag: 1, lspf: 0xd, rect: [0, 0, W, H] });
    expect(checkPsd(b, expectSame({ width: W, height: H }))).toEqual([]);
  });

  it("a fractional move is rounded to whole pixels — no resampling, no 1px growth", async () => {
    const { doc, page, byRec } = open(fixture());
    replace(page, moved(byRec(1), 5.4, -2.6));
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    const r = L.records[1];
    expect([r.left, r.top, r.right - r.left, r.bottom - r.top]).toEqual([8, 1, 10, 8]);
    // channel data untouched (pure move = record patch)
    const A = parsePsdLayout(fixture());
    expect(r.channels.map((c) => c.end - c.start)).toEqual(A.records[1].channels.map((c) => c.end - c.start));
  });

  it("a resized page (canvas crop / enlarge) writes its size; the Background becomes an ordinary layer", async () => {
    // 2026-11-19 decision (ISSUES 2-3): the canvas crop saves the new canvas — before, the header kept the original size
    const { doc, page, byRec } = open(fixture());
    page.width = W + 1;
    page.height = H + 1;
    replace(page, moved(byRec(1), 1, 0));
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    expect([L.width, L.height]).toEqual([W + 1, H + 1]);
    expect(out.warnings.join()).toContain("캔버스 크기");
    expect(decodePsd(out.bytes).composite!.length).toBe((W + 1) * (H + 1) * 4);
    expect(bgSig(out.bytes).alpha).toBe(true);
    expect(checkPsd(out.bytes, expectSame({ width: W + 1, height: H + 1 }))).toEqual([]);
  });

  it("moving the Background turns it into an ordinary layer (alpha, flag and lock cleared together)", async () => {
    const { doc, page, byRec } = open(fixture());
    replace(page, moved(byRec(0), -3.3, 2.2));
    const out = await writePsd(doc, page);
    expect(bgSig(out.bytes)).toEqual({ alpha: true, flag: 0, lspf: 0, rect: [-3, 2, W, H] });
    expect(checkPsd(out.bytes, expectSame({ width: W, height: H }))).toEqual([]);
  });

  it("editing the Background in place keeps it a Background (no alpha channel)", async () => {
    const { doc, page, byRec } = open(fixture());
    const bg = byRec(0);
    const d = new Uint8ClampedArray(bg.tiles["0_0"].data);
    d.set([1, 2, 3, 255], 0);
    replace(page, { ...bg, tiles: { "0_0": makeTile(d) } });
    const out = await writePsd(doc, page);
    expect(bgSig(out.bytes)).toEqual({ alpha: false, flag: 1, lspf: 0xd, rect: [0, 0, W, H] });
  });

  it("lowering the Background's opacity or changing its blend mode converts it (a Background is always 100 % Normal)", async () => {
    for (const change of [{ opacity: 0.5 }, { blendMode: "MULTIPLY" as const }]) {
      const { doc, page, byRec } = open(fixture());
      replace(page, { ...byRec(0), ...change });
      const out = await writePsd(doc, page);
      expect(bgSig(out.bytes)).toEqual({ alpha: true, flag: 0, lspf: 0, rect: [0, 0, W, H] });
      expect(checkPsd(out.bytes, expectSame({ width: W, height: H }))).toEqual([]);
    }
  });

  it("a layer put under the Background converts the Background", async () => {
    const { doc, page } = open(fixture());
    const extra = rasterFromRgba(solid(4, 4, [0, 0, 0, 255]), 4, 4, "under");
    page.nodes = [extra, ...page.nodes];
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    expect(L.records[1].channels.some((c) => c.id === -1)).toBe(true);
    expect(L.records[1].flags & 1).toBe(0);
    expect(checkPsd(out.bytes, expectSame({ width: W, height: H }))).toEqual([]);
  });

  it("rasterizing a smart object removes only its linked-file entry", async () => {
    const { doc, page, byRec } = open(fixture());
    replace(page, moved(byRec(2), 1, 1)); // moving a smart object rasterizes it
    const out = await writePsd(doc, page);
    const L = parsePsdLayout(out.bytes);
    expect(L.records[2].blocks.map((k) => k.key)).not.toContain("PlLd");
    const blk = L.globalBlocks.find((k) => k.key === "lnk2")!;
    const text = String.fromCharCode(...out.bytes.subarray(blk.dataStart, blk.dataEnd));
    expect(text).not.toContain("ID-AAAA");
    expect(text).toContain("ID-BBBB");
    expect(checkPsd(out.bytes, expectSame({ width: W, height: H }))).toEqual([]);
  });

  it("a file saved by the earlier writer (alpha + Background lock) is repaired on the next save", async () => {
    const broken = buildPsd({
      width: W,
      height: H,
      layers: [
        { name: "was bg", px: px(solid(W + 1, H + 1, [9, 9, 9, 255]), -1, -1, W + 1, H + 1), opacity: 1, visible: true, blend: "NORMAL", blocks: [rawBlock("lspf", [0, 0, 0, 0xd])] },
        { name: "top", px: px(solid(4, 4, [1, 1, 1, 255]), 0, 0, 4, 4), opacity: 1, visible: true, blend: "NORMAL" },
      ],
    });
    expect(checkPsd(broken, null).length).toBeGreaterThan(0);
    const { doc, page, byRec } = open(broken);
    replace(page, { ...byRec(1), name: "renamed" });
    const out = await writePsd(doc, page);
    expect(out.warnings.join()).toContain("배경 잠금");
    expect(checkPsd(out.bytes, expectSame({ width: W, height: H }))).toEqual([]);
    expect(bgSig(out.bytes)).toMatchObject({ alpha: true, flag: 0, lspf: 0 });
  });

  it("an unedited clean file is never touched", async () => {
    const b = fixture();
    const { doc, page } = open(b);
    const out = await writePsd(doc, page);
    expect(out.method).toBe("original");
    expect(out.bytes).toEqual(b);
  });

  it("orphaned linked files are dropped on save, even with no edit (Photoshop refuses the file otherwise)", async () => {
    const orphan = buildPsd({
      width: W,
      height: H,
      layers: [{ name: "smart", px: px(solid(6, 6, [1, 2, 3, 255]), 0, 0, 6, 6), opacity: 1, visible: true, blend: "NORMAL", blocks: [plld("ID-LIVE")] }],
      globalBlocks: [lnk2(["ID-LIVE", "ID-GONE"])],
    });
    expect(checkPsd(orphan, null).join()).toContain("연결 파일");
    const linkText = (bytes: Uint8Array) => {
      const blk = parsePsdLayout(bytes).globalBlocks.find((k) => k.key === "lnk2")!;
      return String.fromCharCode(...bytes.subarray(blk.dataStart, blk.dataEnd));
    };
    for (const edit of [false, true]) {
      const { doc, page, byRec } = open(orphan);
      if (edit) replace(page, { ...byRec(0), name: "renamed" });
      const out = await writePsd(doc, page);
      expect(out.method).toBe("surgery");
      expect(out.warnings.join()).toContain("연결 파일");
      expect(checkPsd(out.bytes, expectSame({ width: W, height: H }))).toEqual([]);
      expect(linkText(out.bytes)).toContain("ID-LIVE");
      expect(linkText(out.bytes)).not.toContain("ID-GONE");
      // unedited: the layer and its pixels are the original's
      if (!edit) {
        const chans = (bytes: Uint8Array) => {
          const r = parsePsdLayout(bytes).records[0];
          return r.channels.map((c) => Array.from(bytes.subarray(c.start, c.end)).join()).join("|");
        };
        expect(chans(out.bytes)).toBe(chans(orphan));
      }
    }
  });

  it("the save check refuses an orphaned linked file even when the original already had it", async () => {
    // pruning off reproduces the earlier writer: the result must not pass
    const orphan = buildPsd({
      width: W,
      height: H,
      layers: [{ name: "smart", px: px(solid(6, 6, [1, 2, 3, 255]), 0, 0, 6, 6), opacity: 1, visible: true, blend: "NORMAL", blocks: [plld("ID-LIVE")] }],
      globalBlocks: [lnk2(["ID-LIVE", "ID-GONE"])],
    });
    const { doc, page, byRec } = open(orphan);
    replace(page, { ...byRec(0), name: "renamed" });
    await expect(writePsd(doc, page, { pruneLinkedFiles: false })).rejects.toThrow(/연결 파일/);
  });

  it("lspf 0x08 alone is Photoshop's 'prevent auto-nesting' lock, not a Background: unedited save stays byte-identical", async () => {
    // a user can set the artboard/frame auto-nesting lock (lspf bit 3) on any layer; with transparency +
    // position locks that is 0x0D on a layer that is NOT the bottom one
    for (const lock of [0x08, 0x0d, 0x0f]) {
      const b = buildPsd({
        width: W,
        height: H,
        layers: [
          { name: "Background", px: px(solid(W, H, [250, 250, 250, 255]), 0, 0, W, H), opacity: 1, visible: true, blend: "NORMAL", background: true },
          { name: "nest-locked", px: px(solid(10, 8, [200, 10, 10, 255]), 3, 4, 10, 8), opacity: 1, visible: true, blend: "NORMAL", blocks: [rawBlock("lspf", [0, 0, 0, lock])] },
        ],
      });
      expect(checkPsd(b, null)).toEqual([]);
      const { doc, page, byRec } = open(b);
      const out = await writePsd(doc, page);
      expect(out.method).toBe("original");
      expect(out.bytes).toEqual(b);
      // an edit elsewhere keeps the user's lock flags on that layer
      const { doc: d2, page: p2, byRec: br2 } = open(b);
      replace(p2, { ...br2(0), name: "Background 2" });
      const out2 = await writePsd(d2, p2);
      expect(decodePsd(out2.bytes, { metaOnly: true }).layers[1].protect).toBe(lock);
      expect(out2.warnings.join()).not.toContain("배경 잠금");
      void byRec;
    }
  });

  it("checkPsd flags the combinations Photoshop refuses", () => {
    // Background lock on a layer with transparency (the refused file's bottom layer)
    const bad = buildPsd({ width: W, height: H, layers: [{ name: "x", px: px(solid(W + 1, H + 1, [9, 9, 9, 255]), -1, -1, W + 1, H + 1), opacity: 1, visible: true, blend: "NORMAL", blocks: [rawBlock("lspf", [0, 0, 0, 0xd])] }] });
    expect(checkPsd(bad, null).join()).toContain("배경");
    // header size changed against the original
    expect(checkPsd(fixture(), expectSame({ width: W + 1, height: H })).join()).toContain("헤더 크기");
    // a channel whose RLE table does not add up
    const b = fixture().slice();
    const L = parsePsdLayout(b);
    const ch = L.records[1].channels.find((c) => c.id === 0)!;
    b[ch.start + 3] ^= 1; // first row byte count
    expect(checkPsd(b, null).join()).toMatch(/RLE|구조/);
    // unbalanced resource 1026 / layer count is reported too (built by hand: none here) — the clean file passes
    expect(checkPsd(fixture(), null)).toEqual([]);
  });
});
