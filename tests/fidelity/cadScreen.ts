// CAD fidelity harness (docs/design/FIDELITY_CAD.md) — runs in a real browser engine, served by scripts/fidelity-cad.mjs
// (vite + headless Edge/Chrome, qa/fidelity/cad.html).
//
// For every AutoCAD reference drawing (qa/interop/autocad-made): the DXF (or DWG) is opened in Omniweave and
// each page (model space, every layout) is compared with the AutoCAD plot of it (DWG To PDF, rendered with pdf.js):
//   frame   both pictures are cropped to their ink (non-white) box and the Omniweave crop is scaled onto the AutoCAD one
//           — the plot window (extents + 3 %) and the Omniweave page margin differ, the drawing inside must not;
//           the two boxes' aspect ratios are reported (a wrong extent or a stray object shows there first)
//   image   SSIM of the two crops and the share of visibly different 8×8 windows
//   lines   line position: share of AutoCAD ink pixels with Omniweave ink within 2 px (recall), the other way round
//           (precision), their F1, and the mean distance (px at 1600 px width) from AutoCAD ink to the nearest Omniweave ink
// Layers that do not plot (no-plot flag, DEFPOINTS) are hidden for the comparison, as the plot leaves them out.
// A side-by-side PNG (AutoCAD | Omniweave) is posted for every page.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { masterOf, useStore } from "../../src/core/store";
import { newDocument, type OmwDocument, type Page } from "../../src/core/types";
import { encodePng } from "../../src/io/formats/png";
import { ctx2d, makeCanvas } from "../../src/render/draw";
import { paintPage } from "../../src/render/weave";
import { importFile, lastImport } from "../../src/ui/actions";
import { setCadFileReader } from "../../src/io/formats/cad/external";
import { resizeGray, ssim, toGray, type Gray } from "./ssim";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
/** compared width of the ink box, px */
const W = 1600;
const TOL = 2;
const S = () => useStore.getState();
const log = (m: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += m + "\n";
};

interface Img {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
}

export interface PageScore {
  page: string;
  ref: string;
  ssim: number;
  badShare: number;
  recall: number;
  precision: number;
  f1: number;
  /** mean px distance AutoCAD ink → Omniweave ink (at W px width), capped at 20 */
  dist: number;
  /** ink box aspect (w/h) AutoCAD, Omniweave */
  aspect: [number, number];
}

async function omniRender(doc: OmwDocument, page: Page, scale: number): Promise<Img> {
  const w = Math.max(1, Math.round(page.width * scale)), h = Math.max(1, Math.round(page.height * scale));
  const cv = makeCanvas(w, h);
  const c = ctx2d(cv);
  const master = masterOf(doc, page);
  let complete = false;
  for (let i = 0; i < 100 && !complete; i++) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, w, h);
    complete = paintPage(c, doc, page, master, scale);
    if (!complete) await new Promise((r) => setTimeout(r, 150));
  }
  return { rgba: c.getImageData(0, 0, w, h).data, w, h };
}

async function pdfRender(page: any, scale: number): Promise<Img> {
  const vp = page.getViewport({ scale });
  const cv = document.createElement("canvas");
  cv.width = Math.round(vp.width);
  cv.height = Math.round(vp.height);
  const c = cv.getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: c, viewport: vp }).promise;
  return { rgba: c.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
}

/** ink box (gray < 235) of a gray image: [x0, y0, x1, y1) */
function inkBox(g: Gray): [number, number, number, number] | null {
  let x0 = g.w, y0 = g.h, x1 = -1, y1 = -1;
  for (let y = 0; y < g.h; y++)
    for (let x = 0; x < g.w; x++)
      if (g.y[y * g.w + x] < 235) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return x1 < 0 ? null : [x0, y0, x1 + 1, y1 + 1];
}

function crop(g: Gray, b: [number, number, number, number]): Gray {
  const w = b[2] - b[0], h = b[3] - b[1];
  const y = new Float32Array(w * h);
  for (let r = 0; r < h; r++) y.set(g.y.subarray((b[1] + r) * g.w + b[0], (b[1] + r) * g.w + b[0] + w), r * w);
  return { w, h, y };
}

/** chamfer (3-4) distance to the nearest ink pixel, in px */
function distanceMap(g: Gray): Float32Array {
  const { w, h } = g;
  const BIG = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = g.y[i] < 200 ? 0 : BIG;
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? BIG : d[y * w + x]);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x - 1, y) + 3, at(x, y - 1) + 3, at(x - 1, y - 1) + 4, at(x + 1, y - 1) + 4);
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (!d[i]) continue;
      d[i] = Math.min(d[i], at(x + 1, y) + 3, at(x, y + 1) + 3, at(x + 1, y + 1) + 4, at(x - 1, y + 1) + 4);
    }
  for (let i = 0; i < d.length; i++) d[i] /= 3;
  return d;
}

function lineScores(ref: Gray, got: Gray) {
  const dRef = distanceMap(ref), dGot = distanceMap(got);
  let nr = 0, hitR = 0, sum = 0, ng = 0, hitG = 0;
  for (let i = 0; i < ref.y.length; i++) {
    if (ref.y[i] < 200) {
      nr++;
      if (dGot[i] <= TOL) hitR++;
      sum += Math.min(20, dGot[i]);
    }
    if (got.y[i] < 200) {
      ng++;
      if (dRef[i] <= TOL) hitG++;
    }
  }
  const recall = nr ? hitR / nr : 1, precision = ng ? hitG / ng : 1;
  return { recall, precision, f1: recall + precision ? (2 * recall * precision) / (recall + precision) : 0, dist: nr ? sum / nr : 0 };
}

/** AutoCAD | Omniweave in colour, plus an overlay (AutoCAD red, Omniweave blue, both black). */
async function postPair(name: string, a: Img, b: Img, ra: Gray, rb: Gray) {
  const ov = new Uint8ClampedArray(ra.w * ra.h * 4);
  for (let i = 0; i < ra.y.length; i++) {
    const ia = ra.y[i] < 200, ib = rb.y[i] < 200;
    ov[i * 4] = ia && ib ? 0 : ia ? 220 : ib ? 40 : 255;
    ov[i * 4 + 1] = ia && ib ? 0 : ia ? 30 : ib ? 90 : 255;
    ov[i * 4 + 2] = ia && ib ? 0 : ia ? 30 : ib ? 230 : 255;
    ov[i * 4 + 3] = 255;
  }
  const parts = [a, b, { rgba: ov, w: ra.w, h: ra.h }];
  const gap = 10, h = Math.max(...parts.map((p) => p.h)), Wd = parts.reduce((s, p) => s + p.w, 0) + gap * 2;
  const out = new Uint8ClampedArray(Wd * h * 4).fill(255);
  let x0 = 0;
  for (const p of parts) {
    for (let y = 0; y < p.h; y++) out.set(p.rgba.subarray(y * p.w * 4, (y + 1) * p.w * 4), (y * Wd + x0) * 4);
    x0 += p.w + gap;
  }
  for (let i = 0; i < out.length; i += 4)
    if (out[i + 3] < 255) {
      const k = out[i + 3] / 255;
      for (let c = 0; c < 3; c++) out[i + c] = out[i + c] * k + 255 * (1 - k);
      out[i + 3] = 255;
    }
  await fetch(`/__cad/pair?name=${encodeURIComponent(name)}`, { method: "POST", body: encodePng(out, Wd, h, 6) as BlobPart });
}

/** colour crop of an RGBA image resized to (w, h) by nearest neighbour (for the picture only) */
function cropRgba(img: Img, b: [number, number, number, number], w: number, h: number): Img {
  const out = new Uint8ClampedArray(w * h * 4);
  const sx = (b[2] - b[0]) / w, sy = (b[3] - b[1]) / h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = ((b[1] + Math.floor(y * sy)) * img.w + b[0] + Math.floor(x * sx)) * 4;
      out.set(img.rgba.subarray(i, i + 4), (y * w + x) * 4);
    }
  return { rgba: out, w, h };
}

/** ink pixel positions of a gray image (every `step`-th, for the registration search) */
function inkPoints(g: Gray, step: number): Int32Array {
  const out: number[] = [];
  let n = 0;
  for (let i = 0; i < g.y.length; i++) if (g.y[i] < 200 && n++ % step === 0) out.push(i % g.w, Math.floor(i / g.w));
  return Int32Array.from(out);
}

/**
 * Registration: uniform scale s and shift (dx, dy) taking Omniweave pixels onto AutoCAD pixels,
 * x_ref = (x_omni − cg) · s + cr + d, chosen to minimise the symmetric chamfer distance (capped at 10 px).
 * Starts from the ink boxes; the box alone is thrown off by one object that is a little larger on one side.
 */
function register(ref: Gray, got: Gray, rb: number[], gb: number[]) {
  const dRef = distanceMap(ref), dGot = distanceMap(got);
  const pr = inkPoints(ref, Math.max(1, Math.round(inkCount(ref) / 4000)));
  const pg = inkPoints(got, Math.max(1, Math.round(inkCount(got) / 4000)));
  const cr = [(rb[0] + rb[2]) / 2, (rb[1] + rb[3]) / 2], cg = [(gb[0] + gb[2]) / 2, (gb[1] + gb[3]) / 2];
  const s0 = Math.sqrt(((rb[2] - rb[0]) * (rb[3] - rb[1])) / Math.max(1, (gb[2] - gb[0]) * (gb[3] - gb[1])));
  const cost = (s: number, dx: number, dy: number) => {
    let a = 0;
    for (let i = 0; i < pg.length; i += 2) {
      const x = Math.round((pg[i] - cg[0]) * s + cr[0] + dx), y = Math.round((pg[i + 1] - cg[1]) * s + cr[1] + dy);
      a += x < 0 || y < 0 || x >= ref.w || y >= ref.h ? 10 : Math.min(10, dRef[y * ref.w + x]);
    }
    let b = 0;
    for (let i = 0; i < pr.length; i += 2) {
      const x = Math.round((pr[i] - cr[0] - dx) / s + cg[0]), y = Math.round((pr[i + 1] - cr[1] - dy) / s + cg[1]);
      b += x < 0 || y < 0 || x >= got.w || y >= got.h ? 10 : Math.min(10, dGot[y * got.w + x]);
    }
    return a / Math.max(1, pg.length / 2) + b / Math.max(1, pr.length / 2);
  };
  const span = Math.max(rb[2] - rb[0], rb[3] - rb[1]);
  let best = { s: s0, dx: 0, dy: 0, c: cost(s0, 0, 0) };
  const search = (ds: number, ns: number, dd: number, nd: number) => {
    const c0 = best;
    for (let i = -ns; i <= ns; i++)
      for (let j = -nd; j <= nd; j++)
        for (let k = -nd; k <= nd; k++) {
          const s = c0.s * (1 + i * ds), dx = c0.dx + j * dd, dy = c0.dy + k * dd;
          const c = cost(s, dx, dy);
          if (c < best.c) best = { s, dx, dy, c };
        }
  };
  search(0.01, 6, Math.max(2, Math.round(span * 0.004)), 8);
  search(0.002, 5, Math.max(1, Math.round(span * 0.001)), 5);
  search(0.0005, 4, 1, 2);
  return { ...best, cr, cg };
}

const inkCount = (g: Gray) => {
  let n = 0;
  for (let i = 0; i < g.y.length; i++) if (g.y[i] < 200) n++;
  return n;
};

/** Omniweave gray resampled onto the AutoCAD crop (box rb) with the registration, area-averaged by supersampling 2×2 */
function warp(got: Gray, rb: number[], r: ReturnType<typeof register>): Gray {
  const w = rb[2] - rb[0], h = rb[3] - rb[1];
  const y = new Float32Array(w * h);
  for (let py = 0; py < h; py++)
    for (let px = 0; px < w; px++) {
      let sum = 0;
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const X = Math.floor((rb[0] + px + ox - r.cr[0] - r.dx) / r.s + r.cg[0]), Y = Math.floor((rb[1] + py + oy - r.cr[1] - r.dy) / r.s + r.cg[1]);
        sum += X < 0 || Y < 0 || X >= got.w || Y >= got.h ? 255 : got.y[Y * got.w + X];
      }
      y[py * w + px] = sum / 4;
    }
  return { w, h, y };
}

async function comparePage(name: string, refPdf: any, doc: OmwDocument, page: Page): Promise<PageScore> {
  // the plot: rendered so its ink box is about 2 × W wide, then reduced (area average keeps thin lines)
  const pg = await refPdf.getPage(1);
  const probe = await pdfRender(pg, 1);
  const pb = inkBox(toGray(probe.rgba, probe.w, probe.h));
  if (!pb) throw new Error("AutoCAD PDF has no ink");
  const refScale = Math.min(12, (2 * W) / Math.max(1, pb[2] - pb[0]));
  const ref = await pdfRender(pg, refScale);
  const refG = toGray(ref.rgba, ref.w, ref.h);
  const ib = inkBox(refG)!;
  // a margin around the AutoCAD ink box so a shifted Omniweave line still lands inside
  const m = Math.round(Math.max(ib[2] - ib[0], ib[3] - ib[1]) * 0.02);
  const rb: [number, number, number, number] = [Math.max(0, ib[0] - m), Math.max(0, ib[1] - m), Math.min(ref.w, ib[2] + m), Math.min(ref.h, ib[3] + m)];
  // Omniweave: no-plot layers hidden (as plotted), drawn so its ink box is about as wide
  const plotted: Page = { ...page, groups: (page.groups ?? []).map((g) => (g.cad?.noPlot || g.cad?.layer?.toUpperCase() === "DEFPOINTS" ? { ...g, visible: false } : g)) };
  const p1 = await omniRender(doc, plotted, 1);
  const ob1 = inkBox(toGray(p1.rgba, p1.w, p1.h));
  const omniScale = ob1 ? Math.min(8, (ib[2] - ib[0]) / Math.max(1, ob1[2] - ob1[0])) : 1;
  const got = await omniRender(doc, plotted, omniScale);
  const gotG = toGray(got.rgba, got.w, got.h);
  const gb = inkBox(gotG);
  if (!gb) throw new Error("Omniweave page has no ink");
  const aspect: [number, number] = [(ib[2] - ib[0]) / (ib[3] - ib[1]), (gb[2] - gb[0]) / (gb[3] - gb[1])];
  const reg = register(refG, gotG, ib, gb);
  const tw = W, th = Math.max(1, Math.round((W * (rb[3] - rb[1])) / (rb[2] - rb[0])));
  const a = resizeGray(crop(refG, rb), tw, th), b = resizeGray(warp(gotG, rb, reg), tw, th);
  const s = ssim(a, b);
  const ls = lineScores(a, b);
  const pw = Math.round(tw / 2), ph = Math.round(th / 2);
  const gbox: [number, number, number, number] = [
    Math.round((rb[0] - reg.cr[0] - reg.dx) / reg.s + reg.cg[0]),
    Math.round((rb[1] - reg.cr[1] - reg.dy) / reg.s + reg.cg[1]),
    Math.round((rb[2] - reg.cr[0] - reg.dx) / reg.s + reg.cg[0]),
    Math.round((rb[3] - reg.cr[1] - reg.dy) / reg.s + reg.cg[1]),
  ];
  const clampBox = (bx: [number, number, number, number], img: Img): [number, number, number, number] => [Math.max(0, bx[0]), Math.max(0, bx[1]), Math.min(img.w, Math.max(bx[0] + 1, bx[2])), Math.min(img.h, Math.max(bx[1] + 1, bx[3]))];
  await postPair(name, cropRgba(ref, rb, pw, ph), cropRgba(got, clampBox(gbox, got), pw, ph), resizeGray(a, pw, ph), resizeGray(b, pw, ph));
  const r4 = (x: number) => Math.round(x * 10000) / 10000;
  return { page: name, ref: "", ssim: r4(s.ssim), badShare: r4(s.badShare), recall: r4(ls.recall), precision: r4(ls.precision), f1: r4(ls.f1), dist: Math.round(ls.dist * 100) / 100, aspect: [r4(aspect[0]), r4(aspect[1])] };
}

interface Item {
  key: string;
  id: string;
  name: string;
  /** layout name ("" = model space) → reference key */
  refs: Record<string, string>;
}

async function measure(it: Item) {
  const bytes = new Uint8Array(await (await fetch(`/__cad/file?key=${encodeURIComponent(it.key)}`)).arrayBuffer());
  S().load(newDocument());
  // the drawing "lives" in a virtual folder: xrefs and linked pictures next to it are served by name from the reference
  // folders (repository, then OMW_CAD_REFS) — the same lookup the desktop app does in the drawing's folder
  setCadFileReader(async (p) => {
    const r = await fetch(`/__cad/ext?name=${encodeURIComponent(p.replace(/^.*\//, ""))}`);
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  });
  await importFile({ name: it.name, path: `C:/omni-cad-refs/${it.name}`, bytes });
  setCadFileReader(null);
  if (lastImport?.error) throw new Error(lastImport.error);
  const doc = S().doc;
  const pages: PageScore[] = [];
  const cadPages = doc.pages.filter((p) => p.source?.cad);
  for (const [layout, refKey] of Object.entries(it.refs)) {
    const page = cadPages.find((p) => (p.source!.cad!.layout ?? "") === layout);
    if (!page) {
      pages.push({ page: layout || "Model", ref: refKey, ssim: 0, badShare: 1, recall: 0, precision: 0, f1: 0, dist: 20, aspect: [0, 0] });
      continue;
    }
    const refBytes = new Uint8Array(await (await fetch(`/__cad/file?key=${encodeURIComponent(refKey)}`)).arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: refBytes, isEvalSupported: false, cMapUrl: new URL("/node_modules/pdfjs-dist/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/node_modules/pdfjs-dist/standard_fonts/", location.href).href }).promise;
    const sc = await comparePage(`${it.id}-${layout || "Model"}`, pdf, doc, page);
    sc.page = layout || "Model";
    pages.push(sc);
    await pdf.destroy();
  }
  return { id: it.id, pages, warnings: lastImport?.warnings ?? [], message: lastImport?.message ?? "" };
}

async function main() {
  (window as any).alert = () => {};
  (window as any).confirm = () => true;
  try {
    await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "Pretendard"`, "가A")));
  } catch {}
  const items: Item[] = await (await fetch("/__cad/list")).json();
  for (const it of items) {
    let row: any;
    try {
      row = await measure(it);
    } catch (e: any) {
      row = { id: it.id, error: String(e?.stack ?? e?.message ?? e).slice(0, 400), pages: [] };
    }
    await fetch("/__cad/row", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row) });
    log(`${it.id}: ${row.error ?? row.pages.map((s: PageScore) => s.f1).join(" ")}`);
  }
  await fetch("/__cad/done", { method: "POST" });
}

main().catch(async (e) => {
  await fetch("/__cad/done", { method: "POST", body: String(e?.stack ?? e) });
});
