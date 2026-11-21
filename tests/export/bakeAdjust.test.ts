// Adjustment layers in formats that cannot hold them (PDF, SVG, DOCX, HWPX, PPTX): the layers an adjustment touches
// go in as one picture (io/bakeAdjust.ts) — an edited PSD keeps its look; an unedited one uses Photoshop's merged image.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { produce } from "immer";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../../src/core/assets";
import { newDocument, newPage, newRaster, newText, type OmwDocument, type Page, type SceneNode } from "../../src/core/types";
import { bakeAdjustDoc, bakeCount, type BakeRasterize } from "../../src/io/bakeAdjust";
import { importPsdPage } from "../../src/io/formats/psd";
import { exportDocx, exportHwpx } from "../../src/io/office";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const PNG = new Uint8Array(readFileSync("public/app_small.png"));

function open(name: string): Page {
  const bytes = new Uint8Array(readFileSync(join(DIR, name + ".psd")));
  return importPsdPage(bytes, name + ".psd", name, makeAsset(bytes, "image/vnd.adobe.photoshop", name + ".psd")).page;
}
const docOf = (p: Page): OmwDocument => ({ ...newDocument(), pages: [p] });

function fake() {
  const calls: SceneNode[][] = [];
  const r: BakeRasterize = async (_d, _p, nodes) => (calls.push(nodes), { png: PNG, x: 4, y: 6, w: 40, h: 30 });
  return { r, calls };
}

describe("adjustment layers baked for formats without them", () => {
  it("a page without adjustment layers is passed through untouched (same objects)", async () => {
    const p = newPage("DOCUMENT", 794, 1123, "p");
    p.nodes.push(newText("hello", 200));
    const doc = docOf(p);
    const f = fake();
    const b = await bakeAdjustDoc(doc, doc.pages, f.r);
    expect(b.baked).toBe(0);
    expect(b.doc).toBe(doc);
    expect(b.pages[0]).toBe(p);
    expect(f.calls).toHaveLength(0);
  });

  it("an edited PSD: everything up to the topmost adjustment becomes one picture, layers above stay live", async () => {
    const page = open("omni-fid-adj-curves");
    const adj = page.nodes.findIndex((n) => n.type === "RASTER" && !!n.adjust);
    expect(adj).toBeGreaterThan(0);
    // an edit (a text added on top) so the page is no longer Photoshop's merged image
    const edited = produce(page, (d) => void d.nodes.push(newText("live", 100) as never));
    const n = bakeCount(edited);
    expect(n).toBeGreaterThan(adj);
    const doc = docOf(edited);
    const f = fake();
    const b = await bakeAdjustDoc(doc, doc.pages, f.r);
    expect(b.baked).toBe(1);
    expect(f.calls[0].map((x) => x.id)).toEqual(edited.nodes.slice(0, n).map((x) => x.id));
    const out = b.pages[0];
    expect(out.nodes[0].type).toBe("IMAGE");
    expect(out.nodes[0].transform).toMatchObject({ x: 4, y: 6 });
    expect(out.nodes.some((x) => x.type === "RASTER" && x.adjust)).toBe(false);
    expect(out.nodes.at(-1)!.type).toBe("TEXT");
    expect(b.doc.assets[(out.nodes[0] as { assetId: string }).assetId]).toBeTruthy();
    // the original document is not changed
    expect(edited.nodes.some((x) => x.type === "RASTER" && x.adjust)).toBe(true);
  });

  it("an unedited PSD bakes Photoshop's merged image", async () => {
    const page = open("omni-fid-adj-curves");
    const f = fake();
    const b = await bakeAdjustDoc(docOf(page), [page], f.r);
    expect(b.baked).toBe(1);
    expect(f.calls[0]).toHaveLength(1);
    expect(f.calls[0][0].id).toBe(page.source!.psd!.compositeNode);
    expect(b.pages[0].nodes.map((x) => x.type)).toEqual(["IMAGE"]);
  });

  it("an adjustment inside a folder takes the whole folder; one in a hidden folder is ignored", async () => {
    const page = open("omni-fid-adj-group");
    const edited = produce(page, (d) => void d.nodes.push(newText("live", 100) as never));
    const n = bakeCount(edited);
    const groupsBelow = new Set(edited.nodes.slice(0, n).map((x) => x.groupId).filter(Boolean));
    for (const x of edited.nodes.slice(n)) expect(x.groupId && groupsBelow.has(x.groupId)).toBeFalsy();
    const hidden = produce(edited, (d) => {
      for (const g of d.groups ?? []) g.visible = false;
      for (const x of d.nodes) if (x.type === "RASTER" && x.adjust && !x.groupId) x.visible = false;
    });
    expect(bakeCount(hidden)).toBe(0);
  });

  it("layers clipped to the cut go with it", () => {
    const p = newPage("DESIGN", 100, 100, "p");
    const a = newRaster();
    (a as { adjust?: unknown }).adjust = { adj: { kind: "invert" } };
    const c = { ...newRaster(), clip: true };
    p.nodes.push(newRaster(), a, c, newRaster());
    expect(bakeCount(p)).toBe(3);
  });

  it("DOCX and HWPX then carry the picture (an edited PSD page had no image there before)", async () => {
    const page = produce(open("omni-fid-adj-curves"), (d) => void (d.nodes[0].name += " "));
    const edited = produce(page, (d) => void (d.nodes.find((n) => n.type === "RASTER" && !n.adjust && n.visible)!.transform.x += 1));
    const b = await bakeAdjustDoc(docOf(edited), [edited], fake().r);
    const z = unzipSync(exportDocx(b.doc.pages, { assets: b.doc.assets }));
    expect(Object.keys(z).some((k) => /^word\/media\/image1\.png$/.test(k))).toBe(true);
    expect(strFromU8(z["word/document.xml"])).toContain("rIdImg1");
    const h = unzipSync(exportHwpx(b.doc.pages, "t", { assets: b.doc.assets }));
    expect(Object.keys(h).some((k) => /^BinData\//.test(k))).toBe(true);
  });
});
