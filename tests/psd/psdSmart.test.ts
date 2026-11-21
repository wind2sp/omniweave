// PSD smart objects (2026-11-21, PSD dept, psd16-smart): the placed-layer block and the linked-file entries of
// Photoshop's own files (omni-fid-smart-*, ps_text_effects), the content opened as a document of its own ('고급 개체
// 열기'), edited, put back — the parent's layer drawn anew through its transform (a perspective one included) and the
// embedded file replaced — and the linked-file state said honestly. Unedited saves stay byte for byte.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/tile";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../../src/core/types";
import { decodeLayout, importPsdPage, parsePsdLayout, recordName } from "../../src/io/formats/psd";
import { checkPsdLinks } from "../../src/io/formats/psdLinks";
import { linkedFiles, placedWithCorners, projectPlaced, quadForSize, readPlaced, rebuildLinkedBlock, squareToQuad, trimTransparent } from "../../src/io/formats/psdSmart";
import { applySmartContent, smartContentBytes, smartContentName, smartContentOut } from "../../src/io/formats/psdSmartEdit";
import { checkPsd, pageComposite, rasterPixels, writePsd } from "../../src/io/formats/psdWrite";

const ADOBE = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const FID = join(ADOBE, "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));

function open(bytes: Uint8Array, name: string): { doc: OmwDocument; page: Page; r: ReturnType<typeof importPsdPage> } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
  const r = importPsdPage(bytes, name, name.replace(/\.ps[db]$/, ""), asset);
  const doc = newDocument(name);
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page, r };
}
const smartNode = (page: Page) => page.nodes.find((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart)!;

/** premultiplied channel difference histogram between a layer (rgba at l, t) and projected pixels */
function premulDiff(a: { rgba: Uint8Array; left: number; top: number; width: number; height: number }, b: { rgba: Uint8Array; left: number; top: number; width: number; height: number }) {
  let max = 0, over2 = 0, n = 0;
  const x0 = Math.min(a.left, b.left), y0 = Math.min(a.top, b.top);
  const x1 = Math.max(a.left + a.width, b.left + b.width), y1 = Math.max(a.top + a.height, b.top + b.height);
  const at = (p: typeof a, x: number, y: number, c: number) => {
    const u = x - p.left, v = y - p.top;
    if (u < 0 || v < 0 || u >= p.width || v >= p.height) return 0;
    const i = (v * p.width + u) * 4;
    return c === 3 ? p.rgba[i + 3] : (p.rgba[i + c] * p.rgba[i + 3]) / 255;
  };
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      for (let c = 0; c < 4; c++) {
        const d = Math.round(Math.abs(at(a, x, y, c) - at(b, x, y, c)));
        max = Math.max(max, d);
        if (d > 2) over2++;
        n++;
      }
  return { max, over2: over2 / n };
}

describe("placed layers and linked files (Photoshop's files)", () => {
  it("embedded: the entry (PSB data), its id, and the placed corners (rotated)", () => {
    const b = read("omni-fid-smart-embedded.psd");
    const L = parsePsdLayout(b);
    const files = linkedFiles(L);
    expect(files.map((f) => [f.type, f.name, f.fileType, f.data && f.data.end - f.data.start])).toEqual([["liFD", "omni-smart.psb", "8BPB", 1048576]]);
    const rec = L.records.find((r) => recordName(b, r) === "omni-smart embedded")!;
    const p = readPlaced(b, rec)!;
    expect(p.id).toBe(files[0].id);
    expect(p.size).toEqual({ w: 174, h: 126 });
    expect(p.warped || p.filters).toBe(false);
    expect(p.quad[0]).toBeCloseTo(42.018, 2);
    // the embedded content opens as a PSB of 174 × 126
    const child = importPsdPage(b.subarray(files[0].data!.start, files[0].data!.end), "omni-smart.psb", "omni-smart", null);
    expect([child.image.width, child.image.height, child.image.psb]).toEqual([174, 126, true]);
  });

  it("our drawing of the content through the corners = Photoshop's layer pixels (premultiplied: within 3, at most 0.5 % above 2)", async () => {
    for (const name of ["omni-fid-smart-embedded.psd", "omni-fid-smart-embedded-fx.psd"]) {
      const b = read(name);
      const L = parsePsdLayout(b);
      const img = decodeLayout(L);
      const f = linkedFiles(L)[0];
      const rec = L.records.find((r) => readPlaced(b, r))!;
      const p = readPlaced(b, rec)!;
      const child = open(b.slice(f.data!.start, f.data!.end), "omni-smart.psb");
      const rgba = await pageComposite(child.doc, child.page);
      const pr = trimTransparent(projectPlaced(rgba, child.page.width, child.page.height, p.quad));
      const lay = img.layers[rec.index];
      const d = premulDiff({ rgba: lay.rgba!, left: lay.left, top: lay.top, width: lay.width, height: lay.height }, pr);
      expect(d.max).toBeLessThanOrEqual(name.includes("-fx") ? 0 : 3);
      expect(d.over2).toBeLessThan(0.005);
    }
  });

  it("linked: the external file's paths, the entry kept; its state said (found / missing / not looked for)", async () => {
    const b = read("omni-fid-smart-linked.psd");
    const L = parsePsdLayout(b);
    const f = linkedFiles(L)[0];
    expect([f.type, f.name, f.relPath, f.data]).toEqual(["liFE", "omni-fid-smart-linked-src.png", "omni-fid-smart-linked-src.png", undefined]);
    const { page, r } = open(b, "omni-fid-smart-linked.psd");
    expect(r.linked).toEqual([{ node: smartNode(page).id, layer: "omni-smart linked", path: "omni-fid-smart-linked-src.png", name: "omni-fid-smart-linked-src.png" }]);
    expect(smartNode(page).psdSmart).toMatchObject({ kind: "linked", path: "omni-fid-smart-linked-src.png" });
    // no folder: not looked for — a notice naming the path
    const none = await checkPsdLinks(page, r.linked, null, null);
    expect(none.warnings.join()).toContain("찾아보지 못했습니다");
    expect(none.warnings.join()).toContain("omni-fid-smart-linked-src.png");
    // next to the document: found (only paths inside its folder are read)
    const asked: string[] = [];
    const reader = async (p: string) => (asked.push(p), p.endsWith("/omni-fid-smart-linked-src.png") ? read("omni-fid-smart-linked-src.png") : null);
    const ok = await checkPsdLinks(page, r.linked, "D:/work/omni-fid-smart-linked.psd", reader);
    expect(ok.warnings).toEqual([]);
    expect(ok.info.join()).toContain("찾았습니다");
    expect(smartNode(page).psdSmart!.found).toBe(true);
    expect(asked.every((p) => p.startsWith("D:/work/"))).toBe(true);
    const gone = await checkPsdLinks(page, r.linked, "D:/work/omni-fid-smart-linked.psd", async () => null);
    expect(gone.warnings.join()).toContain("파일이 없습니다");
    expect(smartNode(page).psdSmart!.found).toBe(false);
  });

  it("opening: embedded smart objects are no longer a loss notice (editable), unopenable ones still are", () => {
    for (const f of ["omni-fid-smart-embedded.psd", "omni-fid-smart-embedded-fx.psd"]) {
      const { r } = open(read(f), f);
      expect(r.warnings).toEqual([]);
      expect(r.info.join()).toContain("고급 개체 1개");
    }
    const { r } = open(new Uint8Array(readFileSync(join(ADOBE, "ps_text_effects.psd"))), "ps_text_effects.psd");
    expect(r.warnings.join()).not.toContain("고급 개체");
  });
});

describe("transform maths", () => {
  it("the unit square maps onto the quad (perspective too); a new content size keeps scale and centre", () => {
    const q = [10, 20, 110, 30, 90, 140, 0, 120];
    const H = squareToQuad(q);
    const map = (u: number, v: number) => {
      const w = H[6] * u + H[7] * v + H[8];
      return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w];
    };
    for (const [u, v, i] of [[0, 0, 0], [1, 0, 2], [1, 1, 4], [0, 1, 6]] as const) {
      const [x, y] = map(u, v);
      expect(x).toBeCloseTo(q[i], 9);
      expect(y).toBeCloseTo(q[i + 1], 9);
    }
    // affine: double width keeps the centre and the per-pixel scale
    const a = [100, 100, 200, 100, 200, 150, 100, 150]; // 100 × 50 for content 50 × 25 (scale 2)
    expect(quadForSize(a, 50, 25, 100, 25)).toEqual([50, 100, 250, 100, 250, 150, 50, 150]);
    expect(quadForSize(a, 50, 25, 50, 25)).toEqual(a);
  });

  it("a whole-pixel unscaled quad copies; a scaled one averages; outside the quad is transparent", () => {
    const src = new Uint8Array(4 * 4 * 4);
    for (let i = 0; i < 16; i++) src.set([i * 10, 255 - i * 10, 7, 255], i * 4);
    const c = projectPlaced(src, 4, 4, [3, 5, 7, 5, 7, 9, 3, 9]);
    expect([c.left, c.top, c.width, c.height]).toEqual([3, 5, 4, 4]);
    expect(same(c.rgba, src)).toBe(true);
    const half = projectPlaced(src, 4, 4, [0, 0, 2, 0, 2, 2, 0, 2]);
    expect([half.width, half.height]).toEqual([2, 2]);
    // top-left output pixel = mean of content pixels 0, 1, 4, 5 → red (0 + 10 + 40 + 50) / 4 = 25
    expect(half.rgba[0]).toBe(25);
    const persp = projectPlaced(src, 4, 4, [2, 0, 8, 0, 10, 10, 0, 10]);
    expect(persp.rgba[3]).toBe(0); // top-left corner pixel lies outside the trapezoid
    expect(persp.rgba[(5 * persp.width + 5) * 4 + 3]).toBe(255);
  });

  it("corners and content size are set in place; the linked block rebuilt with only the entry's data changed", () => {
    const b = read("omni-fid-smart-embedded.psd");
    const L = parsePsdLayout(b);
    const rec = L.records.find((r) => readPlaced(b, r))!;
    const so = rec.blocks.find((k) => k.key === "SoLd")!;
    const q = [1, 2, 3, 4, 5, 6, 7, 8];
    const d = placedWithCorners(b.subarray(so.dataStart, so.dataEnd), "SoLd", q)!;
    expect(d.length).toBe(so.dataEnd - so.dataStart);
    expect(readPlaced(d.length ? new Uint8Array([...d]) : d, { ...rec, blocks: [{ ...so, start: 0, end: d.length, dataStart: 0, dataEnd: d.length }] })!.quad).toEqual(q);
    const blk = L.globalBlocks.find((k) => k.key === "lnk2")!;
    const f = linkedFiles(L)[0];
    // nothing replaced: the same bytes
    expect(same(rebuildLinkedBlock(b, blk, false, new Map())!.bytes, b.subarray(blk.start, blk.dataEnd))).toBe(true);
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    const nb = rebuildLinkedBlock(b, blk, false, new Map([[f.id, { data }]]))!;
    expect(nb.replaced).toBe(1);
    const fake = { ...L, bytes: nb.bytes, globalBlocks: [{ ...blk, start: 0, dataStart: 12, dataEnd: nb.bytes.length, end: nb.bytes.length }] };
    const g = linkedFiles(fake)[0];
    expect([g.id, g.name, g.fileType, Array.from(nb.bytes.subarray(g.data!.start, g.data!.end))]).toEqual([f.id, f.name, f.fileType, [1, 2, 3, 4, 5]]);
    // renamed and retyped (a JPEG put back as PNG)
    const rn = rebuildLinkedBlock(b, blk, false, new Map([[f.id, { data, name: "x.png", fileType: "png " }]]))!;
    const h = linkedFiles({ ...fake, bytes: rn.bytes, globalBlocks: [{ ...blk, start: 0, dataStart: 12, dataEnd: rn.bytes.length, end: rn.bytes.length }] })[0];
    expect([h.name, h.fileType, h.data!.end - h.data!.start]).toEqual(["x.png", "png ", 5]);
  });
});

describe("editing the content and putting it back (Photoshop's Edit Contents)", () => {
  async function editAndPutBack(name: string, paint: (child: Page) => void, resize?: { w: number; h: number }) {
    const parentBytes = read(name);
    const parent = open(parentBytes, name);
    const node = smartNode(parent.page);
    const content = smartContentBytes(parent.doc, parent.page, node)!;
    expect(content).not.toBeNull();
    expect(smartContentName(node.psdSmart!)).toBe("omni-smart.psb");
    const child = open(content, "omni-smart.psb");
    const was = { w: child.page.width, h: child.page.height };
    paint(child.page);
    if (resize) {
      child.page.width = resize.w;
      child.page.height = resize.h;
    }
    const out = await smartContentOut(child.doc, child.page, node.psdSmart!.content!);
    const put = applySmartContent(node, out, was);
    parent.doc.assets[put.asset.id] = put.asset;
    parent.page.nodes = parent.page.nodes.map((n) => (n.id === node.id ? put.node : n));
    const saved = await writePsd(parent.doc, parent.page);
    return { parentBytes, parent, node: put.node, out, saved };
  }

  /** paint a 10 × 10 red block at (60, 50) of the content's first layer */
  const paintRed = (child: Page) => {
    const n = child.nodes.find((x): x is RasterNode => x.type === "RASTER" && x.id !== child.source?.psd?.compositeNode && Object.keys(x.tiles).length > 0)!;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    const ox = 60 - n.transform.x, oy = 50 - n.transform.y;
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) data.set([255, 0, 0, 255], ((oy + y) * 256 + ox + x) * 4);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
  };

  it("unedited: the parent saves byte for byte, and so does the content", async () => {
    for (const f of ["omni-fid-smart-embedded.psd", "omni-fid-smart-embedded-fx.psd", "omni-fid-smart-linked.psd", "omni-fid-smart-embedded-nomax.psd"]) {
      const { doc, page } = open(read(f), f);
      expect([f, same((await writePsd(doc, page)).bytes, read(f))]).toEqual([f, true]);
    }
    const { doc, page } = open(read("omni-fid-smart-embedded.psd"), "p.psd");
    const content = smartContentBytes(doc, page, smartNode(page))!;
    const child = open(content, "omni-smart.psb");
    expect(same((await writePsd(child.doc, child.page)).bytes, content)).toBe(true);
  });

  it("an edit inside a rotated smart object: the parent keeps a smart object with the new PSB, its pixels drawn anew", async () => {
    const { saved, out, parentBytes } = await editAndPutBack("omni-fid-smart-embedded.psd", paintRed);
    expect(saved.method).toBe("surgery");
    expect(saved.warnings.join()).toContain("고급 개체로 유지");
    expect(saved.warnings.join()).not.toContain("래스터 레이어로");
    expect(checkPsd(saved.bytes, { width: 200, height: 150, depth: 8, mode: 3, psb: false })).toEqual([]);
    const L = parsePsdLayout(saved.bytes);
    const rec = L.records.find((r) => recordName(saved.bytes, r) === "omni-smart embedded")!;
    // still a smart object (placed-layer blocks kept, corners unchanged), the entry holds the new PSB
    expect(rec.blocks.map((k) => k.key)).toEqual(expect.arrayContaining(["PlLd", "SoLd"]));
    const orig = parsePsdLayout(parentBytes);
    expect(readPlaced(saved.bytes, rec)!.quad).toEqual(readPlaced(parentBytes, orig.records[rec.index])!.quad);
    const f = linkedFiles(L)[0];
    expect(f.id).toBe(linkedFiles(orig)[0].id);
    expect(same(saved.bytes.subarray(f.data!.start, f.data!.end), out.bytes)).toBe(true);
    // the new content: a PSB with the red block
    const inner = importPsdPage(saved.bytes.slice(f.data!.start, f.data!.end), "x.psb", "x", null);
    expect(inner.image.psb).toBe(true);
    // the layer pixels: red where the block lands through the rotation, the rest as Photoshop drew it (within 3)
    const img = decodeLayout(L);
    const lay = img.layers[rec.index];
    const before = decodeLayout(orig).layers[rec.index];
    let red = 0, changed = 0;
    for (let y = 0; y < lay.height; y++)
      for (let x = 0; x < lay.width; x++) {
        const i = (y * lay.width + x) * 4;
        if (lay.rgba![i] > 200 && lay.rgba![i + 1] < 40 && lay.rgba![i + 3] > 200) red++;
        const bx = x + lay.left - before.left, by = y + lay.top - before.top;
        const j = (by * before.width + bx) * 4;
        if (bx >= 0 && by >= 0 && bx < before.width && by < before.height && Math.abs(lay.rgba![i + 3] * lay.rgba![i] - before.rgba![j + 3] * before.rgba![j]) > 3 * 255) changed++;
      }
    expect(red).toBeGreaterThan(60);
    expect(red).toBeLessThan(140);
    expect(changed).toBeLessThan(220);
    // the other layers byte for byte
    for (const r of orig.records) {
      if (r.index === rec.index) continue;
      const o = L.records[r.index];
      expect(same(saved.bytes.subarray(o.start, o.end), parentBytes.subarray(r.start, r.end))).toBe(true);
    }
    // reopened: still an editable smart object showing the new content, and saved again byte for byte
    const again = open(saved.bytes, "again.psd");
    expect(again.r.warnings).toEqual([]);
    expect(smartNode(again.page).psdSmart).toMatchObject({ kind: "embedded", content: "psb", redraw: true });
    expect(same((await writePsd(again.doc, again.page)).bytes, saved.bytes)).toBe(true);
  });

  it("a larger content canvas: corners widened about the centre, the size in the placed block follows", async () => {
    const { saved, node } = await editAndPutBack("omni-fid-smart-embedded-fx.psd", paintRed, { w: 200, h: 126 });
    const L = parsePsdLayout(saved.bytes);
    const rec = L.records.find((r) => readPlaced(saved.bytes, r))!;
    const p = readPlaced(saved.bytes, rec)!;
    expect(p.size).toEqual({ w: 200, h: 126 });
    expect(p.quad.map((v) => Math.round(v * 1e6) / 1e6)).toEqual([0, 13, 200, 13, 200, 139, 0, 139]); // 174 → 200 wide about x = 100
    expect(node.psdSmart!.quad).toEqual(p.quad);
  });

  it("painting over the drawn-back layer afterwards rasterizes it, as before (Photoshop asks to rasterize)", async () => {
    const { parent, node } = await editAndPutBack("omni-fid-smart-embedded-fx.psd", paintRed);
    const key = Object.keys(node.tiles)[0];
    const data = new Uint8ClampedArray(node.tiles[key].data);
    data.set([0, 0, 255, 255], 0);
    const painted = { ...node, tiles: { ...node.tiles, [key]: makeTile(data) } };
    parent.page.nodes = parent.page.nodes.map((n) => (n.id === node.id ? painted : n));
    const r = await writePsd(parent.doc, parent.page);
    expect(r.warnings.join()).toContain("래스터 레이어로");
    expect(parsePsdLayout(r.bytes).globalBlocks.some((k) => k.key === "lnk2" && k.dataEnd > k.dataStart)).toBe(false);
    expect(rasterPixels(painted)).not.toBeNull();
  });
});
