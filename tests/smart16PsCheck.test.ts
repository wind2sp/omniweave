// 16-bit and smart-object saves → real Photoshop check (2026-11-21, psd16-smart). Writes Omniweave saves of repository
// omni-fid-* references — a 16-bit layer edited (+10 levels, one pixel), a rotated embedded smart object and a widened one
// with their content edited in its own document — with Omniweave's merged image as PNG and a manifest for
// qa/interop/scripts/ps_smart16_check.ps1 (Photoshop opens, re-saves, edits the contents and lets them redraw). Then,
// once Photoshop's outputs are in the folder, compares them (results.json). Runs only with OMW_SMART16_PS_WORK=<folder>.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeAsset } from "../src/core/assets";
import { makeTile } from "../src/core/tile";
import { newDocument, type OmwDocument, type Page, type RasterNode } from "../src/core/types";
import { decodePsd, importPsdPage, parsePsdLayout, readChannelPlane, recordName } from "../src/io/formats/psd";
import { encodePng } from "../src/io/formats/png";
import { applySmartContent, smartContentBytes, smartContentOut } from "../src/io/formats/psdSmartEdit";
import { decodePngRgba, writePsd } from "../src/io/formats/psdWrite";

const WORK = process.env.OMW_SMART16_PS_WORK;
const FID = "qa/interop/adobe-made/fidelity";
const read = (f: string) => new Uint8Array(readFileSync(join(FID, f)));

function open(bytes: Uint8Array, name: string): { doc: OmwDocument; page: Page } {
  const asset = makeAsset(bytes, "image/vnd.adobe.photoshop", name);
  const r = importPsdPage(bytes, name, name, asset);
  const doc = newDocument(name);
  doc.pages = [r.page];
  doc.assets[asset.id] = asset;
  return { doc, page: r.page };
}
const layerOf = (page: Page, name: string) => page.nodes.find((n): n is RasterNode => n.type === "RASTER" && n.name === name)!;
const firstLayer = (page: Page) => page.nodes.find((n): n is RasterNode => n.type === "RASTER" && n.id !== page.source?.psd?.compositeNode && Object.keys(n.tiles).length > 0)!;
function paint(n: RasterNode, x0: number, y0: number, w: number, h: number, rgba: number[]) {
  const key = Object.keys(n.tiles)[0];
  const data = new Uint8ClampedArray(n.tiles[key].data);
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) data.set(rgba, ((y - n.transform.y) * 256 + x - n.transform.x) * 4);
  n.tiles = { ...n.tiles, [key]: makeTile(data) };
}

async function putBack(name: string, edit: (child: Page) => void, size?: { w: number; h: number }) {
  const p = open(read(name), name);
  const node = p.page.nodes.find((n): n is RasterNode => n.type === "RASTER" && !!n.psdSmart)!;
  const c = open(smartContentBytes(p.doc, p.page, node)!, "content.psb");
  const was = { w: c.page.width, h: c.page.height };
  edit(c.page);
  if (size) Object.assign(c.page, { width: size.w, height: size.h });
  const out = await smartContentOut(c.doc, c.page, node.psdSmart!.content!);
  const put = applySmartContent(node, out, was);
  p.doc.assets[put.asset.id] = put.asset;
  p.page.nodes = p.page.nodes.map((n) => (n.id === node.id ? put.node : n));
  return { ...p, smart: node.name, content: out };
}

/** a 16-bit plane of the named layer (big-endian samples) */
function plane16(bytes: Uint8Array, layer: string, id: number) {
  const L = parsePsdLayout(bytes);
  const rec = L.records.find((r) => recordName(bytes, r) === layer)!;
  const w = rec.right - rec.left, h = rec.bottom - rec.top;
  const ch = rec.channels.find((c) => c.id === id)!;
  return { p: readChannelPlane(bytes, ch.start, ch.end, w, h, 2, L.psb), w, h, left: rec.left, top: rec.top };
}
function pngDiff(a: Uint8Array, b: Uint8Array) {
  let max = 0, over2 = 0;
  for (let i = 0; i < a.length; i++) {
    if ((i & 3) === 3) continue;
    const d = Math.abs(a[i] - b[i]);
    max = Math.max(max, d);
    if (d > 2) over2++;
  }
  return { max, over2: +(over2 / ((a.length / 4) * 3)).toFixed(5) };
}

describe.skipIf(!WORK)("16-bit and smart-object saves for Photoshop", () => {
  it("writes the saves and a manifest", async () => {
    mkdirSync(WORK!, { recursive: true });
    const manifest: any[] = [];
    const save = async (name: string, doc: OmwDocument, page: Page, extra: Record<string, unknown> = {}) => {
      const r = await writePsd(doc, page);
      writeFileSync(join(WORK!, name + ".psd"), r.bytes);
      const img = decodePsd(r.bytes);
      if (img.composite) writeFileSync(join(WORK!, name + ".omw.png"), encodePng(img.composite, img.width, img.height));
      manifest.push({ name, method: r.method, warnings: r.warnings, ...extra });
    };
    // 16 bits: a whole layer +10 levels and one pixel; and one pixel only
    {
      const { doc, page } = open(read("omni-fid-16bit-levels.psd"), "a.psd");
      const n = layerOf(page, "omni-base");
      n.tiles = Object.fromEntries(Object.entries(n.tiles).map(([k, t]) => {
        const d = new Uint8ClampedArray(t.data);
        for (let i = 0; i < d.length; i += 4) if (d[i + 3]) for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, d[i + c] + 10);
        return [k, makeTile(d)];
      }));
      paint(n, 30, 30, 1, 1, [255, 0, 0, 255]);
      await save("omw-16-levels-plus10", doc, page, { source: "omni-fid-16bit-levels", layer: "omni-base", plus: 10, pixel: [30, 30, 255, 0, 0] });
    }
    {
      const { doc, page } = open(read("omni-fid-16bit-blend.psd"), "b.psd");
      const n = layerOf(page, "Multiply");
      paint(n, 50, 40, 1, 1, [0, 255, 0, 255]);
      await save("omw-16-blend-pixel", doc, page, { source: "omni-fid-16bit-blend", layer: "Multiply", pixel: [50, 40, 0, 255, 0] });
    }
    // smart objects: rotated content with a red block; a widened content (fx layer)
    {
      const r = await putBack("omni-fid-smart-embedded.psd", (c) => paint(firstLayer(c), 60, 50, 12, 12, [255, 0, 0, 255]));
      await save("omw-smart-rot-red", r.doc, r.page, { source: "omni-fid-smart-embedded", smart: r.smart, contentSize: [r.content.w, r.content.h] });
    }
    {
      const r = await putBack("omni-fid-smart-embedded-fx.psd", (c) => paint(firstLayer(c), 20, 20, 30, 10, [0, 0, 255, 255]), { w: 200, h: 126 });
      await save("omw-smart-fx-wide", r.doc, r.page, { source: "omni-fid-smart-embedded-fx", smart: r.smart, contentSize: [r.content.w, r.content.h] });
    }
    writeFileSync(join(WORK!, "manifest.json"), JSON.stringify(manifest, null, 1));
  });

  it("compares Photoshop's outputs (when present)", () => {
    const m = JSON.parse(readFileSync(join(WORK!, "manifest.json"), "utf8"));
    const results: any[] = [];
    for (const it of m) {
      const ours = readFileSync(join(WORK!, it.name + ".psd"));
      const res: any = { name: it.name };
      const psPng = join(WORK!, it.name + ".ps.png");
      if (existsSync(psPng)) res.compositeVsPhotoshop = pngDiff(decodePsd(new Uint8Array(ours)).composite!, decodePngRgba(new Uint8Array(readFileSync(psPng))).rgba);
      const psPsd = join(WORK!, it.name + ".ps.psd");
      if (existsSync(psPsd)) {
        // Photoshop's re-save opened here again: what it says, and whether the smart object still opens
        const back = importPsdPage(new Uint8Array(readFileSync(psPsd)), "ps.psd", "ps", null);
        res.photoshopResaveReopened = { warnings: back.warnings, smart: back.page.nodes.filter((n) => n.type === "RASTER" && n.psdSmart).map((n: any) => ({ kind: n.psdSmart.kind, content: n.psdSmart.content, redraw: n.psdSmart.redraw })) };
      }
      if (it.layer && existsSync(psPsd)) {
        // the 16-bit values Photoshop read and wrote back (it keeps 15 bits: within 2 of 65535 is the same value)
        const theirs = new Uint8Array(readFileSync(psPsd));
        let max = 0, n = 0;
        for (const id of [0, 1, 2]) {
          const A = plane16(new Uint8Array(ours), it.layer, id), B = plane16(theirs, it.layer, id);
          for (let y = 0; y < A.h; y++)
            for (let x = 0; x < A.w; x++) {
              const bx = x + A.left - B.left, by = y + A.top - B.top;
              if (bx < 0 || by < 0 || bx >= B.w || by >= B.h) continue;
              const a = (A.p[(y * A.w + x) * 2] << 8) | A.p[(y * A.w + x) * 2 + 1], b = (B.p[(by * B.w + bx) * 2] << 8) | B.p[(by * B.w + bx) * 2 + 1];
              max = Math.max(max, Math.abs(a - b));
              n++;
            }
        }
        res.layer16VsPhotoshopResave = { max, samples: n };
        // the original's samples against ours: how many kept exactly / moved by exactly +10 levels
        const orig = read(it.source + ".psd");
        let kept = 0, plus = 0, total = 0;
        for (const id of [0, 1, 2]) {
          const O = plane16(orig, it.layer, id), A = plane16(new Uint8Array(ours), it.layer, id);
          for (let i = 0; i < O.w * O.h; i++) {
            const o = (O.p[i * 2] << 8) | O.p[i * 2 + 1], a = (A.p[i * 2] << 8) | A.p[i * 2 + 1];
            total++;
            if (a === o) kept++;
            else if (it.plus && a === o + it.plus * 257) plus++;
          }
        }
        res.layer16VsOriginal = { kept, plusExact: plus, total };
      }
      const re = join(WORK!, it.name + ".psre.png");
      if (existsSync(re)) {
        const ps = decodePngRgba(new Uint8Array(readFileSync(re))).rgba;
        res.redrawnByPhotoshopVsOurs = pngDiff(decodePsd(new Uint8Array(ours)).composite!, ps);
        if (existsSync(psPng)) res.redrawnVsOpened = pngDiff(decodePngRgba(new Uint8Array(readFileSync(psPng))).rgba, ps);
      }
      results.push(res);
    }
    writeFileSync(join(WORK!, "results.json"), JSON.stringify(results, null, 1));
    expect(results.length).toBe(m.length);
  });
});
