// QA of PSD smart objects (2026-11-21, psd16-smart review): Photoshop's own files made for it (QA reference files,
// own instance) — a duplicated smart object sharing one embedded file (omni-fid-smart-shared), a smart object inside a
// smart object (omni-fid-smart-nested), an embedded JPEG (omni-fid-smart-embedded-jpeg). Every instance follows an edit;
// an undo in the parent and a second put-back measure the corners against the layer's own content size; content tabs
// are saved before their parents; broken placed-layer / linked-file blocks never throw out of opening; linked files are
// looked for inside the document's folder only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { makeTile } from "../../src/core/tile";
import { activeSessionId, removeSession, resetSessionsForTest, sessionDoc, switchTo } from "../../src/core/sessions";
import { currentPage, useStore } from "../../src/core/store";
import { newDocument, type RasterNode } from "../../src/core/types";
import { openInTab, saveDoc } from "../../src/ui/actions";
import { openSmartObject, smartChildrenFirst, smartLinkOf } from "../../src/ui/smartObject";
import { importPsdPage, parsePsdLayout, recordName } from "../../src/io/formats/psd";
import { contentDims, linkedFiles, projectPlaced, quadForSize, readPlaced } from "../../src/io/formats/psdSmart";
import { checkPsdLinks, safeLinkName } from "../../src/io/formats/psdLinks";
import { writePsd } from "../../src/io/formats/psdWrite";
import { rasterFromRgba } from "../../src/io/formats/raster";

const FID = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && Buffer.from(a).equals(Buffer.from(b));
const S = () => useStore.getState();
const smarts = () => currentPage()!.nodes.filter((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart);

/** paint a 12 × 12 opaque block at (x, y) of the page's first drawn layer (one commit) */
function paint(x: number, y: number, rgba: number[]) {
  const page = currentPage()!;
  const n = page.nodes.find((k): k is RasterNode => k.type === "RASTER" && k.id !== page.source?.psd?.compositeNode && !k.psdSmart && Object.keys(k.tiles).length > 0);
  if (!n) {
    // a picture opened as an image (JPEG): a new layer with the block
    const rgb = new Uint8Array(12 * 12 * 4);
    for (let i = 0; i < rgb.length; i += 4) rgb.set(rgba, i);
    const r = rasterFromRgba(rgb, 12, 12, "omni-paint");
    r.transform = { ...r.transform, x, y };
    S().commit("paint", (d) => {
      d.pages[0].nodes = [...d.pages[0].nodes, r];
    });
    return;
  }
  const key = Object.keys(n.tiles)[0];
  const data = new Uint8ClampedArray(n.tiles[key].data);
  const ox = x - n.transform.x, oy = y - n.transform.y;
  for (let j = 0; j < 12; j++) for (let i = 0; i < 12; i++) data.set(rgba, ((oy + j) * 256 + ox + i) * 4);
  S().commit("paint", (d) => {
    const p = d.pages[0];
    p.nodes = p.nodes.map((k) => (k.id === n.id ? { ...n, tiles: { ...n.tiles, [key]: makeTile(data) } } : k));
  });
}

async function openTab(f: string) {
  await openInTab({ name: f, path: null, bytes: read(f) });
  return activeSessionId();
}

describe("Photoshop's smart-object files for the review", () => {
  it("content size from the embedded file's header (PSB, JPEG); unedited saves stay byte for byte", async () => {
    for (const [f, w, h] of [["omni-fid-smart-shared.psd", 174, 126], ["omni-fid-smart-nested.psd", 174, 126], ["omni-fid-smart-embedded-jpeg.psd", 120, 80]] as const) {
      const b = read(f);
      const e = linkedFiles(parsePsdLayout(b))[0];
      expect(contentDims(b.subarray(e.data!.start, e.data!.end))).toEqual({ w, h });
      const asset = makeAsset(b, "image/vnd.adobe.photoshop", f);
      const r = importPsdPage(b, f, f, asset);
      expect(r.warnings).toEqual([]);
      const doc = newDocument(f);
      doc.pages = [r.page];
      doc.assets[asset.id] = asset;
      expect([f, same((await writePsd(doc, r.page)).bytes, b)]).toEqual([f, true]);
    }
  });
});

describe("put back into the parent (tabs)", () => {
  beforeEach(() => resetSessionsForTest());

  it("two instances of one smart object (shared id): one tab, both layers redrawn, one entry replaced, both stay smart", async () => {
    const parent = await openTab("omni-fid-smart-shared.psd");
    const [a, b] = smarts();
    expect(a.psdSmart!.id).toBe(b.psdSmart!.id);
    expect(await openSmartObject(a.id)).toBe(true);
    const child = activeSessionId();
    // the other instance opens the same tab
    switchTo(parent);
    expect(await openSmartObject(b.id)).toBe(true);
    expect(activeSessionId()).toBe(child);
    paint(60, 50, [255, 0, 0, 255]);
    await saveDoc();
    const pdoc = sessionDoc(parent)!;
    const [a2, b2] = pdoc.pages[0].nodes.filter((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart);
    expect(a2.psdSmart!.edited).toBeDefined();
    expect(b2.psdSmart!.edited).toBeDefined();
    expect(b2.psdSmart!.edited!.assetId).toBe(a2.psdSmart!.edited!.assetId);
    expect(pdoc.assets[a2.psdSmart!.edited!.assetId]).toBeDefined();
    // each drawn through its own corners (the copy is 20 px left, 10 px down)
    expect(b2.transform.x - a2.transform.x).toBe(-20);
    expect(b2.transform.y - a2.transform.y).toBe(10);
    switchTo(parent);
    const out = await writePsd(S().doc, currentPage()!);
    expect(out.warnings.join()).toContain("고급 개체 2개");
    const L = parsePsdLayout(out.bytes);
    const files = linkedFiles(L);
    expect(files.length).toBe(1);
    for (const name of ["omni-smart embedded", "omni-smart embedded copy"]) {
      const rec = L.records.find((r) => recordName(out.bytes, r) === name)!;
      expect(readPlaced(out.bytes, rec)?.id).toBe(files[0].id);
    }
    const inner = importPsdPage(out.bytes.slice(files[0].data!.start, files[0].data!.end), "x.psb", "x", null);
    expect([inner.image.width, inner.image.height]).toEqual([174, 126]);
  });

  it("undo in the parent, then a second put-back of a resized canvas: corners measured against the layer's own content size", async () => {
    const parent = await openTab("omni-fid-smart-embedded-fx.psd");
    const node = smarts()[0];
    const q0 = node.psdSmart!.quad.slice();
    expect(await openSmartObject(node.id)).toBe(true);
    const child = activeSessionId();
    S().commit("canvas", (d) => {
      d.pages[0].width = 200;
    });
    await saveDoc();
    const want = quadForSize(q0, 174, 126, 200, 126);
    const after1 = sessionDoc(parent)!.pages[0].nodes.find((n) => n.id === node.id) as RasterNode;
    expect(after1.psdSmart!.quad).toEqual(want);
    // undo in the parent: Photoshop's layer and corners again
    switchTo(parent);
    S().undo();
    expect((currentPage()!.nodes.find((n) => n.id === node.id) as RasterNode).psdSmart!.quad).toEqual(q0);
    // the content tab saved again (its canvas still 200 wide): widened from the original 174, not from 200
    switchTo(child);
    S().set({ dirty: true });
    await saveDoc();
    const after2 = sessionDoc(parent)!.pages[0].nodes.find((n) => n.id === node.id) as RasterNode;
    expect(after2.psdSmart!.quad).toEqual(want);
    // and a third save on top of that one: measured from 200 → 200, unchanged
    S().set({ dirty: true });
    await saveDoc();
    expect((sessionDoc(parent)!.pages[0].nodes.find((n) => n.id === node.id) as RasterNode).psdSmart!.quad).toEqual(want);
  });

  it("nested: the inner smart object put back into its PSB tab, that one into the document; saved, both levels carry the edit", async () => {
    const parent = await openTab("omni-fid-smart-nested.psd");
    const outer = smarts()[0];
    expect(await openSmartObject(outer.id)).toBe(true);
    const child = activeSessionId();
    const inner = smarts()[0];
    expect(inner?.name).toBe("omni-smart inner");
    expect(await openSmartObject(inner.id)).toBe(true);
    const grand = activeSessionId();
    expect(smartLinkOf()).toMatchObject({ parent: child, nodeId: inner.id });
    // saving all: the innermost first
    expect(smartChildrenFirst([parent, child, grand])).toEqual([grand, child, parent]);
    paint(30, 30, [0, 0, 255, 255]);
    await saveDoc();
    expect(activeSessionId()).toBe(grand);
    switchTo(child);
    expect(S().dirty).toBe(true);
    expect((currentPage()!.nodes.find((n) => n.id === inner.id) as RasterNode).psdSmart!.edited).toBeDefined();
    await saveDoc();
    expect(S().dirty).toBe(false);
    switchTo(parent);
    expect(S().dirty).toBe(true);
    const out = await writePsd(S().doc, currentPage()!);
    expect(out.method).toBe("surgery");
    const orig = read("omni-fid-smart-nested.psd");
    const level1 = (b: Uint8Array) => {
      const f = linkedFiles(parsePsdLayout(b))[0];
      return b.slice(f.data!.start, f.data!.end);
    };
    const psb1 = level1(out.bytes), psb0 = level1(orig);
    expect(same(psb1, psb0)).toBe(false);
    // inside the new PSB: still a smart object whose own embedded file is the edited one
    const in1 = level1(psb1), in0 = level1(psb0);
    expect(same(in1, in0)).toBe(false);
    const L1 = parsePsdLayout(psb1);
    expect(L1.records.some((r) => recordName(psb1, r) === "omni-smart inner" && readPlaced(psb1, r))).toBe(true);
  });

  it("a content tab closed without saving changes nothing in the parent; a parent closed first leaves the tab on its own", async () => {
    const parent = await openTab("omni-fid-smart-embedded.psd");
    const node = smarts()[0];
    expect(await openSmartObject(node.id)).toBe(true);
    const child = activeSessionId();
    paint(60, 50, [255, 0, 0, 255]);
    removeSession(child);
    expect(smartLinkOf(child)).toBeNull();
    switchTo(parent);
    expect(S().dirty).toBe(false);
    expect((await writePsd(S().doc, currentPage()!)).method).toBe("original");
    // open again, then close the parent: the content tab is no longer linked (its save is an ordinary one)
    expect(await openSmartObject(node.id)).toBe(true);
    const child2 = activeSessionId();
    removeSession(parent);
    expect(smartLinkOf(child2)).toBeNull();
  });

  it("an embedded JPEG goes back as PNG: entry renamed and retyped, content PNG, a second edit keeps it so", async () => {
    const parent = await openTab("omni-fid-smart-embedded-jpeg.psd");
    const node = smarts()[0];
    expect(node.psdSmart).toMatchObject({ content: "jpg", contentSize: { w: 120, h: 80 } });
    expect(await openSmartObject(node.id)).toBe(true);
    const child = activeSessionId();
    // (the picture opens as an image node, drawn by the browser: here its pixels are replaced by a raster layer)
    const full = new Uint8Array(120 * 80 * 4).fill(200);
    S().commit("raster", (d) => {
      d.pages[0].nodes = [rasterFromRgba(full, 120, 80, "omni-jpeg")];
    });
    paint(20, 20, [255, 0, 0, 255]);
    await saveDoc();
    switchTo(parent);
    let out = await writePsd(S().doc, currentPage()!);
    let f = linkedFiles(parsePsdLayout(out.bytes))[0];
    expect([f.type, f.name, f.fileType]).toEqual(["liFD", "omni-smart-src.png", "png "]);
    // the stored count includes the terminating null, as Photoshop writes it (without, it reads "omni-smart-src.pn")
    const dv = new DataView(out.bytes.buffer, out.bytes.byteOffset);
    expect([dv.getUint32(f.nameAt), dv.getUint16(f.nameAt + 4 + 18 * 2)]).toEqual([19, 0]);
    expect(Array.from(out.bytes.subarray(f.data!.start, f.data!.start + 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    // reopened: a PNG smart object; edited again in the same session: still PNG, same name
    const again = importPsdPage(out.bytes, "again.psd", "again", null);
    expect(again.page.nodes.find((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart)!.psdSmart).toMatchObject({ content: "png", name: "omni-smart-src.png", contentSize: { w: 120, h: 80 } });
    switchTo(child);
    paint(40, 40, [0, 255, 0, 255]);
    await saveDoc();
    switchTo(parent);
    out = await writePsd(S().doc, currentPage()!);
    f = linkedFiles(parsePsdLayout(out.bytes))[0];
    expect([f.name, f.fileType]).toEqual(["omni-smart-src.png", "png "]);
  });
});

describe("broken or hostile files", () => {
  /** deterministic bytes */
  const rng = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

  it("mangled placed-layer and linked-file blocks never throw out of opening (and nothing huge is made)", () => {
    const rnd = rng(7);
    let opened = 0;
    for (const f of ["omni-fid-smart-embedded.psd", "omni-fid-smart-linked.psd", "omni-fid-smart-embedded-jpeg.psd"]) {
      const b = read(f);
      const L = parsePsdLayout(b);
      const spans: [number, number][] = [];
      for (const k of L.globalBlocks) if (k.key === "lnk2" || k.key === "lnkE") spans.push([k.dataStart, Math.min(k.dataEnd, k.dataStart + 600)]);
      for (const r of L.records) for (const k of r.blocks) if (k.key === "SoLd" || k.key === "SoLE" || k.key === "PlLd") spans.push([k.dataStart, k.dataEnd]);
      for (let t = 0; t < 120; t++) {
        const m = b.slice();
        const [s, e] = spans[Math.floor(rnd() * spans.length)];
        for (let k = 0; k < 1 + Math.floor(rnd() * 6); k++) {
          const at = s + Math.floor(rnd() * (e - s));
          m[at] = rnd() < 0.5 ? 0xff : Math.floor(rnd() * 256);
        }
        const r = importPsdPage(m, f, f, null);
        opened++;
        for (const n of r.page.nodes) if (n.type === "RASTER" && n.psdSmart) expect(n.psdSmart.quad.length).toBe(8);
      }
      // an entry claiming 2^40 bytes, a placed descriptor with a huge item count
      const m = b.slice();
      const lnk = L.globalBlocks.find((k) => k.key === "lnk2" || k.key === "lnkE")!;
      m.set([0, 0, 1, 0, 0, 0, 0, 0], lnk.dataStart);
      expect(linkedFiles(parsePsdLayout(m))).toEqual([]);
      expect(() => importPsdPage(m, f, f, null)).not.toThrow();
    }
    expect(opened).toBe(360);
  });

  it("corners from the file that are huge or not numbers: refused before anything is allocated, or empty", () => {
    const src = new Uint8Array(4 * 4 * 4);
    expect(() => projectPlaced(src, 4, 4, [0, 0, 1e9, 0, 1e9, 1e9, 0, 1e9])).toThrow();
    expect(() => projectPlaced(src, 4, 4, [0, 0, 1e300, 0, 1e300, 1e300, 0, 1e300])).toThrow();
    expect(projectPlaced(src, 4, 4, [NaN, 0, 1, 0, 1, 1, 0, 1]).width).toBe(0);
    // content claimed larger than its pixels
    expect(() => projectPlaced(src, 40, 40, [0, 0, 4, 0, 4, 4, 0, 4])).toThrow();
  });

  it("linked files: only inside the document's folder, never a device name, never the file's bytes needed", async () => {
    const asset = makeAsset(read("omni-fid-smart-linked.psd"), "image/vnd.adobe.photoshop", "l.psd");
    const r = importPsdPage(read("omni-fid-smart-linked.psd"), "l.psd", "l", asset);
    const node = r.page.nodes.find((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart)!;
    for (const stored of ["..\\..\\secret.png", "../../Users/x/secret.png", "C:\\Windows\\win.ini", "\\\\server\\share\\x.png", "file:///C:/other/x.png", "sub/../../x.png", "CON", "nul.png", "COM1.jpg", "x.png:stream", "..", "sub\\deep\\ok.png"]) {
      const asked: string[] = [];
      await checkPsdLinks(r.page, [{ node: node.id, layer: "L", path: stored, name: stored }], "D:/work/doc.psd", async (p) => (asked.push(p), false));
      for (const p of asked) {
        expect([stored, p.startsWith("D:/work/")]).toEqual([stored, true]);
        expect(safeLinkName(p.split("/").pop()!)).toBe(true);
      }
    }
    // a probe answering 'there' (no bytes): found
    const ok = await checkPsdLinks(r.page, r.linked, "D:/work/doc.psd", async (p) => p === "D:/work/omni-fid-smart-linked-src.png");
    expect(ok.warnings).toEqual([]);
    expect(node.psdSmart!.found).toBe(true);
    expect(["CON", "con.png", "LPT1", "aux", "a:b", ""].map(safeLinkName)).toEqual([false, false, false, false, false, false]);
    expect(["contour.png", "nullable.psd", "x.png"].map(safeLinkName)).toEqual([true, true, true]);
  });
});
