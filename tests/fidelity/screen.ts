// Screen-fidelity harness (docs/DESKTOP_DONE.md item 4) — runs in a real browser engine.
// Loaded by qa/fidelity/screen.html, served by scripts/fidelity.mjs (vite on port 5205, headless Edge/Chrome).
//
// For every input it renders a *reference* and Omniweave's own page render (the Weave renderer,
// paintPage — the same code that draws the canvas and PNG export) and compares them with SSIM:
//   PDF / AI        reference = pdf.js render of the original page
//                   Omniweave = the page as opened, and the page after "PDF 텍스트 편집"(elevation)
//   PSD             reference = the merged image Photoshop stored in the file
//   images · TIFF   reference = the browser's own decode of the file (SVG opened as paths: the whole page render)
//   DOCX/HWPX/PPTX/XLSX… reference = "<file>.ref.pdf" next to the file or qa/interop/reference/<name>.pdf
//                   (PDF printed by Word / 한글 / PowerPoint / Excel — see qa/fidelity/REPORT.md)
// It also opens image/media files through importFile (they need the browser to decode).

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { masterOf, useStore } from "../../src/core/store";
import { newDocument, type OmwDocument, type Page } from "../../src/core/types";
import { elevatePdfText } from "../../src/io/pdf";
import { decryptOffice, isEncryptedOffice } from "../../src/io/crypto/office";
import { decryptPdf, isEncrypted as isEncryptedPdf } from "../../src/io/pdfsurgeon/decrypt";
import { encodePng } from "../../src/io/formats/png";
import { decodePsd, hasRealMergedData, parsePsdLayout } from "../../src/io/formats/psd";
import { decodeTiff } from "../../src/io/formats/tiff";
import { ctx2d, makeCanvas } from "../../src/render/draw";
import { paintPage } from "../../src/render/weave";
import { importFile, lastImport } from "../../src/ui/actions";
import { fitSize, heatmap, resizeGray, ssim, toGray, type Gray } from "./ssim";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const MAX = 900; // longer side of the compared images
const MAX_PAGES = 3;
const S = () => useStore.getState();
const log = (m: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += m + "\n";
};

interface Item {
  key: string;
  set: "public" | "interop" | "corpus";
  id: string;
  ext: string;
  /** key of a reference PDF, when one exists */
  ref?: string;
  /** .ai: keys of Illustrator's own artboard renders (PNG, one per artboard) — the reference instead of pdf.js */
  aiPngs?: string[];
  /** .psd/.psb: key of Photoshop's own render (<name>.ps.png) — the reference when the merged image is a placeholder */
  psPng?: string;
  /** Node-side open result (skip screens for files that did not open there) */
  nodeOpen?: string;
}

export interface ScreenPage {
  page: number;
  kind: string;
  ssim: number;
  badShare: number;
  size: string;
  heat?: string;
  note?: string;
}
export interface ScreenRow {
  key: string;
  set: string;
  id: string;
  ext: string;
  open?: { status: string; ms: number; detail: string };
  screen: { status: "측정" | "기준 렌더 없음" | "해당 없음" | "실패"; reference?: string; pages: ScreenPage[]; note?: string };
}

const BROWSER_OPEN = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "aac", "m4a", "tif", "tiff"]);
const IMAGE = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "tif", "tiff"]);

async function bytesOf(key: string): Promise<Uint8Array> {
  const r = await fetch(`/__fidelity/file?key=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`파일을 읽지 못함 ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const timeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 시간 초과(${ms / 1000}s)`)), ms))]);

/** Render a page with the Weave renderer, repainting until every async resource is ready. */
async function omniRender(doc: OmwDocument, page: Page, scale: number): Promise<{ rgba: Uint8ClampedArray; w: number; h: number; incomplete?: boolean }> {
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
  return { rgba: c.getImageData(0, 0, w, h).data, w, h, incomplete: !complete };
}

async function decodeImage(bytes: Uint8Array, mime: string): Promise<ImageBitmap | HTMLImageElement> {
  if (mime !== "image/svg+xml") {
    try {
      return await createImageBitmap(new Blob([bytes as BlobPart]));
    } catch {}
  }
  // SVG (and anything createImageBitmap refuses): an <img>, as the app's placeImage fallback does
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime || "application/octet-stream" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

async function pdfRender(pdf: any, index: number, width: number): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const p = await pdf.getPage(index + 1);
  const vp1 = p.getViewport({ scale: 1 });
  const vp = p.getViewport({ scale: width / vp1.width });
  const cv = document.createElement("canvas");
  cv.width = Math.round(vp.width);
  cv.height = Math.round(vp.height);
  const c = cv.getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  await p.render({ canvasContext: c, viewport: vp }).promise;
  return { rgba: c.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
}

/** a reference PNG (Illustrator's render) as RGBA on white */
async function pngRender(bytes: Uint8Array): Promise<{ rgba: Uint8ClampedArray; w: number; h: number }> {
  const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/png" }));
  const cv = document.createElement("canvas");
  cv.width = bmp.width;
  cv.height = bmp.height;
  const c = cv.getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  c.drawImage(bmp, 0, 0);
  bmp.close();
  return { rgba: c.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
}

const openPdfJs = (bytes: Uint8Array) =>
  pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, cMapUrl: new URL("/node_modules/pdfjs-dist/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/node_modules/pdfjs-dist/standard_fonts/", location.href).href }).promise;

/** One PNG: reference | Omniweave | difference map (gray, so the panels compare at a glance). */
async function postHeat(row: ScreenRow, p: ScreenPage, ref: Gray, got: Gray, r: ReturnType<typeof ssim>) {
  const { w, h } = ref;
  const gap = 8, W = w * 3 + gap * 2;
  const out = new Uint8ClampedArray(W * h * 4).fill(255);
  const hm = heatmap(ref, r);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = ((y * W + x) * 4), b = ((y * W + x + w + gap) * 4), c = ((y * W + x + 2 * (w + gap)) * 4);
      out[a] = out[a + 1] = out[a + 2] = ref.y[i];
      out[b] = out[b + 1] = out[b + 2] = got.y[i];
      out.set(hm.subarray(i * 4, i * 4 + 4), c);
    }
  const png = encodePng(out, W, h, 6);
  const name = `${row.key}#${p.page}-${p.kind === "열기" ? "open" : "edit"}`;
  const res = await fetch(`/__fidelity/heat?name=${encodeURIComponent(name)}&set=${row.set}`, { method: "POST", body: png as BlobPart });
  if (res.ok) p.heat = await res.text();
}

async function compare(row: ScreenRow, page: number, kind: string, ref: { rgba: Uint8ClampedArray | Uint8Array; w: number; h: number }, got: { rgba: Uint8ClampedArray | Uint8Array; w: number; h: number; incomplete?: boolean }, note?: string) {
  if (got.incomplete) note = [note, "오메 렌더가 15초 안에 완성되지 않음"].filter(Boolean).join(" · ");
  const size = fitSize(ref.w, ref.h, MAX);
  const a = resizeGray(toGray(ref.rgba, ref.w, ref.h), size.w, size.h);
  const b = resizeGray(toGray(got.rgba, got.w, got.h), size.w, size.h);
  const r = ssim(a, b);
  const aspect = Math.abs(ref.w / ref.h - got.w / got.h) / (ref.w / ref.h);
  const p: ScreenPage = { page, kind, ssim: Math.round(r.ssim * 10000) / 10000, badShare: Math.round(r.badShare * 10000) / 10000, size: `${size.w}×${size.h}`, note: [note, aspect > 0.02 ? `가로세로 비 ${(aspect * 100).toFixed(1)}% 다름` : ""].filter(Boolean).join(" · ") || undefined };
  if (r.ssim < 0.999) await postHeat(row, p, a, b, r);
  row.screen.pages.push(p);
}

async function measure(it: Item): Promise<ScreenRow> {
  const row: ScreenRow = { key: it.key, set: it.set, id: it.id, ext: it.ext, screen: { status: "해당 없음", pages: [] } };
  let bytes = await bytesOf(it.key);
  // interop test files carry the published test password (qa/interop request) — open them decrypted
  if (it.set === "interop" && /^(docx|xlsx|pptx)$/.test(it.ext) && isEncryptedOffice(bytes)) bytes = await decryptOffice(bytes, "omw-test-1234");
  if (it.set === "interop" && /^(pdf|ai)$/.test(it.ext) && isEncryptedPdf(bytes)) bytes = (await decryptPdf(bytes, "omw-test-1234")).plain;
  const name = it.key.split("/").pop()!;
  if (it.nodeOpen && /실패|안내/.test(it.nodeOpen)) {
    row.screen.note = "열기 실패·미지원(노드 측정)";
    return row;
  }
  S().load(newDocument());
  const t0 = performance.now();
  await timeout(importFile({ name, path: null, bytes }), 90_000, "열기");
  const r = lastImport;
  if (BROWSER_OPEN.has(it.ext)) {
    const status = !r ? "실패" : r.error ? (/HEIC|재생할 수 없|코덱|컨테이너|암호/.test(r.error) || it.ext === "heic" ? "안내(미지원)" : r.error === "취소" ? "실패" : "실패") : r.warnings.length ? "부분" : "성공";
    row.open = { status, ms: Math.round(performance.now() - t0), detail: r?.error ? r.error.split("\n")[0].slice(0, 140) : (r?.warnings ?? []).join(" / ").slice(0, 140) };
  }
  if (r?.error) {
    row.screen.note = "열지 못함";
    return row;
  }
  const doc = S().doc;
  const pages = doc.pages;
  try {
    if (it.ext === "pdf" || it.ext === "ai") {
      const ai = it.aiPngs?.length ? it.aiPngs : null;
      row.screen.reference = ai ? "Illustrator 대지 렌더(PNG)" : "pdf.js 원본 렌더";
      const pdf = await openPdfJs(bytes);
      for (let i = 0; i < Math.min(MAX_PAGES, pages.length); i++) {
        const pg = pages[i];
        const ref = ai?.[i] ? await pngRender(await bytesOf(ai[i])) : await pdfRender(pdf, i, Math.min(MAX * 1.5, pg.width * 2));
        const scale = ref.w / pg.width;
        await compare(row, i + 1, "열기", ref, await omniRender(doc, pg, scale));
        // after "PDF 텍스트 편집": elevated nodes drawn by Omniweave over the stripped background
        const node = pg.nodes.find((n) => n.type === "PDF");
        if (node && node.type === "PDF") {
          const el = await timeout(elevatePdfText(doc.assets[node.assetId].hash, node.pageIndex, pg.width), 60_000, "승격");
          if (el.nodes.length) {
            // committed like actions.elevatePdf: the renderer picks the stripped background from the store's document
            S().commit("PDF 텍스트 승격", (d) => {
              const p = d.pages.find((x) => x.id === pg.id)!;
              (p.nodes.find((x) => x.id === node.id) as any).covers = el.covers;
              p.nodes.push(...(el.nodes as any));
            });
            const nd = S().doc;
            const nText = el.nodes.filter((n) => n.type === "TEXT").length, nVec = el.nodes.length - nText;
            await compare(row, i + 1, "편집 모드", ref, await omniRender(nd, nd.pages.find((x) => x.id === pg.id)!, scale), `텍스트 ${nText}줄·벡터 ${nVec}개 승격`);
          }
        }
      }
      await pdf.destroy();
    } else if (it.ext === "psd" || it.ext === "psb") {
      row.screen.reference = "PSD 합쳐진 이미지(Photoshop 저장)";
      const img = decodePsd(bytes);
      // saved with 'Maximize PSD Compatibility' off: the merged image in the file is Photoshop's placeholder, not the
      // picture, and the app draws the layers itself (psd.ts hasRealMergedData) — Photoshop's own PNG is the truth then
      // (2026-11-21, 측정 부서: the -nomax files measured 0.002–0.743 against the placeholder)
      const placeholder = !hasRealMergedData(parsePsdLayout(bytes));
      const psRef = placeholder && it.psPng ? await pngRender(await bytesOf(it.psPng)) : null;
      if (psRef) row.screen.reference = "Photoshop PNG(호환성 최대화 끔 — 파일 속 합성은 자리표시)";
      if (!img.composite && !psRef) row.screen.note = "합쳐진 이미지 없음";
      else {
        const pg = pages[0];
        const ref = psRef ?? { rgba: img.composite!, w: img.width, h: img.height };
        await compare(row, 1, "열기", ref, await omniRender(doc, pg, ref.w / pg.width));
        // "열기" is what the app shows an unedited file (Photoshop's merged image: core/fidelity/overlay.ts pristinePsdView);
        // "엔진" is our compositing of the layers (what shows once a layer is edited) — reported apart (VIEWER_GOAL)
        const psd = pg.source?.psd;
        if (psd?.importSig) await compare(row, 1, "엔진", ref, await omniRender(doc, { ...pg, source: { ...pg.source!, psd: { ...psd, importSig: undefined } } }, ref.w / pg.width));
      }
    } else if (IMAGE.has(it.ext)) {
      row.screen.reference = "브라우저 디코딩 원본";
      let ref: { rgba: Uint8ClampedArray | Uint8Array; w: number; h: number };
      if (it.ext === "tif" || it.ext === "tiff") {
        const t = decodeTiff(bytes);
        ref = { rgba: t.rgba, w: t.width, h: t.height };
      } else {
        const bmp = await decodeImage(bytes, it.ext === "svg" ? "image/svg+xml" : "");
        // natural size up to 2400px, so both sides resample only once (in the final box filter)
        const fit = fitSize(bmp.width || 400, bmp.height || 300, 2400);
        const cv = makeCanvas(fit.w, fit.h);
        const c = ctx2d(cv);
        c.drawImage(bmp, 0, 0, fit.w, fit.h);
        ref = { rgba: c.getImageData(0, 0, fit.w, fit.h).data, w: fit.w, h: fit.h };
      }
      const pg = pages.find((p) => p.nodes.some((n) => n.type === "IMAGE")) ?? pages[0];
      const node = pg.nodes.find((n) => n.type === "IMAGE");
      if (!node) {
        // SVG artwork opens as editable paths (0.1.7, ui/actions canvasImagePage): the page is the artwork's own box
        // (its viewBox / width × height), so the whole page render is compared with the browser's render of the file
        if (!pg.nodes.length) row.screen.note = "이미지 개체 없음";
        else await compare(row, 1, "열기", ref, await omniRender(doc, pg, ref.w / pg.width), `쪽 전체 렌더(편집 가능한 경로 ${pg.nodes.length}개)`);
      } else {
        const k = ref.w / (node.width * node.transform.scale);
        const full = await omniRender(doc, pg, k);
        const x0 = Math.round(node.transform.x * k), y0 = Math.round(node.transform.y * k);
        const w = Math.min(ref.w, full.w - x0), h = Math.min(ref.h, full.h - y0);
        const crop = new Uint8ClampedArray(w * h * 4);
        for (let y = 0; y < h; y++) crop.set(full.rgba.subarray(((y0 + y) * full.w + x0) * 4, ((y0 + y) * full.w + x0 + w) * 4), y * w * 4);
        // the page background shows through transparent pixels on screen: composite the reference the same way (white)
        await compare(row, 1, "열기", ref, { rgba: crop, w, h }, node.transform.rotation ? "회전된 배치" : undefined);
      }
    } else if (it.ref) {
      row.screen.reference = "기준 PDF(오피스 프로그램 출력)";
      const pdf = await openPdfJs(await bytesOf(it.ref));
      const n = Math.min(6, pdf.numPages, pages.length);
      const sizes = async (i: number) => (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
      const pt = (v: number) => Math.round(v);
      const v0 = await sizes(0);
      // page count and size: reference in points, Omniweave pages converted px → pt (×0.75)
      row.screen.note = [`쪽 수 기준 ${pdf.numPages} / 오메 ${pages.length}`, `쪽 크기 기준 ${pt(v0.width)}×${pt(v0.height)}pt / 오메 ${pt(pages[0].width * 0.75)}×${pt(pages[0].height * 0.75)}pt`].join(" · ");
      for (let i = 0; i < n; i++) {
        const ref = await pdfRender(pdf, i, MAX * 1.5);
        const vi = await sizes(i);
        const sizeNote = Math.abs(vi.width - pages[i].width * 0.75) > 2 || Math.abs(vi.height - pages[i].height * 0.75) > 2 ? `크기 ${pt(vi.width)}×${pt(vi.height)} → ${pt(pages[i].width * 0.75)}×${pt(pages[i].height * 0.75)}pt` : undefined;
        await compare(row, i + 1, "열기", ref, await omniRender(doc, pages[i], ref.w / pages[i].width), sizeNote);
      }
      await pdf.destroy();
    } else {
      row.screen.status = /^(docx|hwpx|pptx|xlsx|doc|hwp|ppt|xls|epub|html|md)$/.test(it.ext) ? "기준 렌더 없음" : "해당 없음";
      return row;
    }
    row.screen.status = row.screen.pages.length ? "측정" : row.screen.status;
  } catch (e: any) {
    row.screen.status = "실패";
    row.screen.note = String(e?.message ?? e).split("\n")[0].slice(0, 120);
  }
  return row;
}

async function main() {
  (window as any).alert = () => {};
  (window as any).confirm = () => true;
  (window as any).prompt = () => null;
  try {
    await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "Pretendard"`, "가A")));
  } catch {}
  const items: Item[] = await (await fetch("/__fidelity/list")).json();
  log(`${items.length}개 측정 시작`);
  for (const it of items) {
    let row: ScreenRow;
    try {
      row = await timeout(measure(it), 240_000, "측정");
    } catch (e: any) {
      row = { key: it.key, set: it.set, id: it.id, ext: it.ext, screen: { status: "실패", pages: [], note: String(e?.message ?? e).slice(0, 120) } };
    }
    await fetch("/__fidelity/row", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row) });
    log(`${it.id}: ${row.screen.status} ${row.screen.pages.map((p) => `${p.kind}${p.page}=${p.ssim}`).join(" ")}`);
  }
  await fetch("/__fidelity/done", { method: "POST" });
  log("완료");
}

main().catch(async (e) => {
  await fetch("/__fidelity/done", { method: "POST", body: String(e?.stack ?? e) });
});
