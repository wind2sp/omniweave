// QA (2026-11-21, image-upscale branch): document safety of "이미지 크기 키우기" — cancel leaves the document as it
// was, tiny and odd sizes, the size limit refused before any work, a PSD layer upscaled and saved leaves the other
// layers' bytes as they were (8- and 16-bit, the 16-bit precision notice), 32-bit refused, pixel art suggested to
// the nearest method, and the 4× intermediate shrunk without a full-size float buffer.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { imgToTiles, newImg, tileBounds, tilesToImg, type Img } from "../../src/core/image/pixels";
import { encodePng } from "../../src/core/image/png";
import { classifySr, looksPixelArt } from "../../src/core/image/sr/classify";
import { setSrModelReader } from "../../src/core/image/sr/models";
import { resizeArea } from "../../src/core/image/sr/pipeline";
import { draftPage, findPage, useStore } from "../../src/core/store";
import { newDocument, newRaster, type RasterNode } from "../../src/core/types";
import { parsePsdLayout, importPsdPage } from "../../src/io/formats/psd";
import { buildPsd, decodePngRgba, writePsd, type FreshLayer } from "../../src/io/formats/psdWrite";
import { applyUpscale, setUpscaleCodec, upscaleDeepNote, upscaleRefusal } from "../../src/ui/upscaleActions";
import { t } from "../../src/i18n";
import { omwIllustration, omwLineArt, omwPhoto } from "./srSet";

const flags = vi.hoisted(() => ({ cancel: false }));
vi.mock("../../src/core/image/run", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/core/image/run")>();
  const cancelled = () => Promise.reject(new Error(m.CANCELLED));
  return {
    ...m,
    runSuperResolve: ((...a: Parameters<typeof m.runSuperResolve>) => (flags.cancel ? cancelled() : m.runSuperResolve(...a))) as typeof m.runSuperResolve,
    runUpscale: ((...a: Parameters<typeof m.runUpscale>) => (flags.cancel ? cancelled() : m.runUpscale(...a))) as typeof m.runUpscale,
  };
});

const S = useStore.getState;

beforeAll(() => {
  setSrModelReader(async (f) => new Uint8Array(readFileSync(`public/models/sr/${f}`)));
  setUpscaleCodec({
    decode: async (bytes) => {
      const p = decodePngRgba(bytes);
      return { width: p.width, height: p.height, data: new Uint8ClampedArray(p.rgba) };
    },
    encode: async (img, mime) => (mime === "image/png" ? encodePng(img.data, img.width, img.height, 4) : null),
  });
});
beforeEach(() => {
  flags.cancel = false;
});

function addRaster(img: Img): RasterNode {
  S().load(newDocument("t"));
  const n = newRaster("layer");
  n.tiles = imgToTiles(img, 0, 0, {}).tiles;
  n.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  S().commit("add", (d) => void draftPage(d, S().pageId)!.nodes.push(n as any));
  S().set({ selection: [n.id] });
  return n;
}

const painted = (n: RasterNode) => {
  const cur = findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === n.id) as RasterNode;
  const px = tilesToImg(cur.tiles, tileBounds(cur.tiles)!);
  let x1 = -1, y1 = -1;
  for (let y = 0; y < px.height; y++) for (let x = 0; x < px.width; x++) if (px.data[(y * px.width + x) * 4 + 3]) (x1 = Math.max(x1, x)), (y1 = Math.max(y1, y));
  return [x1 + 1, y1 + 1];
};

describe("document safety", () => {
  it("cancel mid-run (AI and classical): nothing changes, no history step, a 'cancelled' notice", async () => {
    for (const method of ["ai", "hq"] as const) {
      const n = addRaster(omwIllustration(20, 14, 3));
      const doc = S().doc, past = S().past.length;
      flags.cancel = true;
      expect(await applyUpscale({ scale: 2, method })).toBeNull();
      expect(S().doc).toBe(doc);
      expect(S().past.length).toBe(past);
      expect(S().toast).toBe(t("image.upscale.cancelled"));
      flags.cancel = false;
      // and the next run works (busy flag released)
      expect(await applyUpscale({ scale: 2, method })).toMatchObject({ width: 40, height: 28 });
      expect(S().past.length).toBe(past + 1);
      S().undo();
      expect((findPage(S().doc, S().pageId)!.nodes.find((x) => x.id === n.id) as RasterNode).tiles).toBe(n.tiles);
    }
  }, 60_000);

  it("tiny and odd sizes: 1×1, 2×3, 5×7 with AI and the classical methods", async () => {
    for (const [w, h] of [[1, 1], [2, 3], [5, 7]])
      for (const [method, scale] of [["ai", 4], ["ai", 2], ["ai", 3], ["hq", 3], ["smooth", 2], ["pixel", 2]] as const) {
        const img = newImg(w, h);
        for (let i = 0; i < w * h; i++) img.data.set([200, 60 + i * 10, 30, 255], i * 4);
        const n = addRaster(img);
        const r = await applyUpscale({ scale, method });
        expect(r, `${w}×${h} ${method} ${scale}×`).toMatchObject({ width: w * scale, height: h * scale });
        expect(painted(n)).toEqual([w * scale, h * scale]);
      }
  }, 120_000);

  it("a result above the limit is refused before any work, with the limit in the notice", async () => {
    const n = addRaster(newImgFilled(4000, 2));
    const doc = S().doc;
    expect(await applyUpscale({ scale: 8, method: "ai" })).toBeNull();
    expect(S().doc).toBe(doc);
    expect(S().toast).toContain("30,000");
    expect(n).toBeTruthy();
  });
});

function newImgFilled(w: number, h: number): Img {
  const img = newImg(w, h);
  img.data.fill(255);
  return img;
}

const fill = (w: number, h: number, c: number[]) => {
  const o = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) o.set(c, i * 4);
  return o;
};

describe("PSD layers", () => {
  for (const depth of [8, 16] as const)
    it(`${depth}-bit: the upscaled layer is bigger after save / reopen, the other layers' records and channels are the same bytes`, async () => {
      const W = 96, H = 64;
      const art = omwIllustration(24, 16, 5), photo = omwPhoto(40, 30, 2);
      const layers: FreshLayer[] = [
        { name: "Background", px: { rgba: fill(W, H, [240, 238, 230, 255]), left: 0, top: 0, width: W, height: H }, opacity: 1, visible: true, blend: "NORMAL", background: true },
        { name: "omw-photo", px: { rgba: new Uint8Array(photo.data.buffer.slice(0)), left: 50, top: 30, width: 40, height: 30 }, opacity: 0.8, visible: true, blend: "MULTIPLY" },
        { name: "omw-logo", px: { rgba: new Uint8Array(art.data.buffer.slice(0)), left: 6, top: 4, width: 24, height: 16 }, opacity: 1, visible: true, blend: "NORMAL" },
      ];
      const bytes = buildPsd({ width: W, height: H, depth, layers });
      const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-upscale-qa.psd");
      const r = importPsdPage(bytes, "omw-upscale-qa.psd", "omw-upscale-qa", asset);
      const doc = newDocument("t");
      doc.pages = [r.page];
      doc.assets[asset.id] = asset;
      S().load(doc);
      const logoId = r.page.source!.psd!.layers.find((l) => l.name === "omw-logo")!.node!;
      const target = { pageId: r.page.id, node: r.page.nodes.find((n) => n.id === logoId) as RasterNode };
      expect(upscaleRefusal(target)).toBeNull();
      expect(upscaleDeepNote(target)).toBe(depth === 16 ? "image.upscale.note16" : null);
      S().set({ pageId: r.page.id, selection: [logoId] });
      expect(await applyUpscale({ scale: 2, method: "hq" })).toMatchObject({ width: 48, height: 32 });
      const out = (await writePsd(S().doc, S().doc.pages[0])).bytes;
      const A = parsePsdLayout(bytes), B = parsePsdLayout(out);
      expect(B.depth).toBe(depth);
      const rec = (L: typeof A, name: string) => L.records.find((x) => x.nameText === name)!;
      for (const name of ["Background", "omw-photo"]) {
        const a = rec(A, name), b = rec(B, name);
        expect([b.left, b.top, b.right, b.bottom], name).toEqual([a.left, a.top, a.right, a.bottom]);
        expect(Buffer.from(B.bytes.subarray(b.start, b.end)).equals(Buffer.from(A.bytes.subarray(a.start, a.end))), name + " record").toBe(true);
        expect(b.channels.length).toBe(a.channels.length);
        a.channels.forEach((c, i) => expect(Buffer.from(B.bytes.subarray(b.channels[i].start, b.channels[i].end)).equals(Buffer.from(A.bytes.subarray(c.start, c.end))), `${name} channel ${c.id}`).toBe(true));
      }
      const logo = rec(B, "omw-logo");
      expect([logo.left, logo.top, logo.right - logo.left, logo.bottom - logo.top]).toEqual([6, 4, 48, 32]);
    });

  it("32-bit and CMYK documents are refused; 8-bit RGB is not", () => {
    for (const [mode, depth, key] of [[3, 32, "image.upscale.refuse.hdr"], [4, 8, "image.upscale.refuse.cmyk"], [4, 16, "image.upscale.refuse.cmyk"], [1, 8, null], [3, 8, null]] as const) {
      const bytes = buildPsd({ width: 8, height: 8, mode, depth, layers: [{ name: "omw-l", px: { rgba: fill(8, 8, [20, 40, 60, 255]), left: 0, top: 0, width: 8, height: 8 }, opacity: 1, visible: true, blend: "NORMAL" }] });
      const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", "omw-mode.psd");
      const r = importPsdPage(bytes, "omw-mode.psd", "omw-mode", asset);
      const doc = newDocument("t");
      doc.pages = [r.page];
      doc.assets[asset.id] = asset;
      S().load(doc);
      const node = r.page.nodes.find((n) => n.id === r.page.source!.psd!.layers[0].node) as RasterNode;
      expect(upscaleRefusal({ pageId: r.page.id, node }), `mode ${mode} / ${depth}`).toBe(key ? t(key) : null);
    }
  });
});

describe("auto choice and memory", () => {
  it("pixel art is recognised (the dialog suggests 'pixel'); line art, illustrations, photos and screenshots are not", () => {
    const pal = [[20, 12, 28], [68, 36, 52], [48, 52, 109], [208, 70, 72], [89, 125, 206], [218, 212, 94], [222, 238, 214], [52, 101, 36]];
    for (const block of [1, 2, 3]) {
      const w = 32, img = newImg(w * block, w * block);
      let s = 7;
      for (let y = 0; y < w; y++)
        for (let x = 0; x < w; x++) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          const c = pal[(x - 16) ** 2 + (y - 16) ** 2 < 120 ? 1 + (s % 7) : 6];
          for (let dy = 0; dy < block; dy++) for (let dx = 0; dx < block; dx++) img.data.set([...c, 255], ((y * block + dy) * w * block + x * block + dx) * 4);
        }
      expect(looksPixelArt(img), `block ${block}`).toBe(true);
      expect(classifySr(img).pixelArt).toBe(true);
    }
    expect(looksPixelArt(omwLineArt(160, 160, 3))).toBe(false);
    expect(looksPixelArt(omwIllustration(160, 160, 4))).toBe(false);
    expect(looksPixelArt(omwPhoto(160, 160, 1))).toBe(false);
  });

  it("area resize of a big picture: the result is right without a full-height float buffer", () => {
    // 2 × 2 → 1 × 1 means; and a 4096 × 4096 → 2048 × 2048 shrink keeps the mean
    const small = newImg(4, 2);
    small.data.set([0, 0, 0, 255, 100, 100, 100, 255, 200, 200, 200, 255, 50, 50, 50, 255, 20, 20, 20, 255, 80, 80, 80, 255, 40, 40, 40, 255, 10, 10, 10, 255]);
    expect(Array.from(resizeArea(small, 2, 1).data)).toEqual([50, 50, 50, 255, 75, 75, 75, 255]);
    const big = newImg(4096, 4096);
    for (let i = 0; i < big.data.length; i += 4) big.data[i] = big.data[i + 1] = big.data[i + 2] = (i >> 2) % 251, big.data[i + 3] = 255;
    const before = process.memoryUsage().arrayBuffers;
    const out = resizeArea(big, 2048, 2048);
    const grew = process.memoryUsage().arrayBuffers - before;
    expect(out.data.length).toBe(2048 * 2048 * 4);
    // the result (16 MB) and a few rows, not a 2048 × 4096 float buffer (128 MB)
    expect(grew).toBeLessThan(40 * 2 ** 20);
  });
});
