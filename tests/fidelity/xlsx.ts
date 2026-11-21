// Excel picture fidelity (browser side of scripts/fidelity-xlsx.mjs): every sheet of the Excel-made workbook printed by
// Omniweave (render/sheet.ts paintSheetPage) next to the page Excel printed (its PDF), SSIM between them, plus the
// grid as the app shows it. Results go back to the driver over /__xlsx/*.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { encodePng } from "../../src/io/formats/png";
import { readXlsx } from "../../src/io/sheet/read";
import { paintSheet, paintSheetPage } from "../../src/render/sheet";
import { sheetPrintPages } from "../../src/io/sheet/printLayout";
import { expandSheetPrintPages } from "../../src/io/sheet/pages";
import { sheetPages } from "../../src/io/sheet/book";
import { newDocument } from "../../src/core/types";
import { fitSize, resizeGray, ssim, toGray } from "./ssim";
import { liveRef, preloadDrawings } from "../../src/render/sheetDrawings";
import { paintChart } from "../../src/render/sheetChart";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const log = (s: string) => ((document.getElementById("log") as HTMLElement).textContent += s + "\n");

async function postPic(name: string, c: HTMLCanvasElement) {
  const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
  await fetch(`/__xlsx/pic?name=${encodeURIComponent(name)}`, { method: "POST", body: encodePng(d.data, c.width, c.height, 6) as BlobPart });
}

async function run() {
  // --only charts (scripts/fidelity-xlsx.mjs): the chart comparison alone, for quick turns on the chart painter
  if (location.search.includes("only=printdiag")) {
    await document.fonts.load('15px "맑은 고딕"').catch(() => {}); // i18n: keep — font name
    await fetch("/__xlsx/diag", { method: "POST", body: JSON.stringify(await runPrintDiag()) });
    await fetch("/__xlsx/done", { method: "POST", body: "[]" });
    return;
  }
  // --only print: the print workbook's pages alone (OMW_PRINT_BOOK=<xlsx> measures another workbook with its <n>.pdf)
  if (location.search.includes("only=print")) {
    await document.fonts.load('15px "맑은 고딕"').catch(() => {}); // i18n: keep — font name
    await runPrint();
    await fetch("/__xlsx/done", { method: "POST", body: "[]" });
    return;
  }
  if (location.search.includes("only=charts")) {
    await document.fonts.load('15px "맑은 고딕"').catch(() => {}); // i18n: keep — font name
    await runCharts();
    await fetch("/__xlsx/done", { method: "POST", body: "[]" });
    return;
  }
  const bytes = new Uint8Array(await (await fetch("/__xlsx/file")).arrayBuffer());
  const { sheets } = readXlsx(bytes, "ko");
  await document.fonts.load('15px "맑은 고딕"').catch(() => {}); // i18n: keep — font name
  const rows: { sheet: string; ssim: number; bad: number }[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    // the grid as the app shows it
    const grid = document.createElement("canvas");
    grid.width = 1100;
    grid.height = 560;
    paintSheet(grid.getContext("2d")!, sh, { width: 1100, height: 560, zoom: 1, scrollX: 0, scrollY: 0, headings: true, lang: "ko", sheets, sel: { g: { r0: 0, c0: 0, r1: 0, c1: 0 }, ar: 0, ac: 0 } });
    await postPic(`grid-${i + 1}.png`, grid);
    // Excel's printed page 1 of this sheet and Omniweave's
    const res = await fetch(`/__xlsx/pdf?n=${i + 1}`);
    if (!res.ok) continue;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false, cMapUrl: new URL("/node_modules/pdfjs-dist/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/node_modules/pdfjs-dist/standard_fonts/", location.href).href }).promise;
    const page = await pdf.getPage(1);
    const vp = page.getViewport({ scale: 96 / 72 });
    const w = Math.round(vp.width), h = Math.round(vp.height);
    const ref = document.createElement("canvas");
    ref.width = w;
    ref.height = h;
    const rc = ref.getContext("2d")!;
    rc.fillStyle = "#fff";
    rc.fillRect(0, 0, w, h);
    await page.render({ canvasContext: rc, viewport: vp }).promise;
    const got = document.createElement("canvas");
    got.width = w;
    got.height = h;
    const gc = got.getContext("2d")!;
    gc.fillStyle = "#fff";
    gc.fillRect(0, 0, w, h);
    paintSheetPage(gc, sh, w, h, "ko");
    const size = fitSize(w, h, 900);
    const a = rc.getImageData(0, 0, w, h), b = gc.getImageData(0, 0, w, h);
    const r = ssim(resizeGray(toGray(a.data, w, h), size.w, size.h), resizeGray(toGray(b.data, w, h), size.w, size.h));
    rows.push({ sheet: sh.name, ssim: Math.round(r.ssim * 10000) / 10000, bad: Math.round(r.badShare * 1000) / 1000 });
    // side by side: Excel PDF | Omniweave
    const pair = document.createElement("canvas");
    pair.width = w * 2 + 24;
    pair.height = h + 28;
    const pc = pair.getContext("2d")!;
    pc.fillStyle = "#e6e6e6";
    pc.fillRect(0, 0, pair.width, pair.height);
    pc.drawImage(ref, 0, 28);
    pc.drawImage(got, w + 24, 28);
    pc.fillStyle = "#111";
    pc.font = "15px sans-serif";
    pc.fillText(`Excel PDF — ${sh.name}`, 8, 19);
    pc.fillText(`오메 (Omniweave) — SSIM ${r.ssim.toFixed(3)}`, w + 32, 19);
    await postPic(`pair-${i + 1}.png`, pair);
    log(`${sh.name}: SSIM ${r.ssim.toFixed(4)}`);
  }
  await runPrint();
  await runCharts();
  await fetch("/__xlsx/done", { method: "POST", body: JSON.stringify(rows) });
}

// ───── print pages: every page of the print workbook (page setup) against Excel's PDF of that sheet ─────

const pdfOpts = () => ({ isEvalSupported: false, cMapUrl: new URL("/node_modules/pdfjs-dist/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/node_modules/pdfjs-dist/standard_fonts/", location.href).href });

/** Excel's page n of a PDF at 96 dpi on white. */
async function pdfPage(pdf: pdfjs.PDFDocumentProxy, n: number): Promise<HTMLCanvasElement> {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 96 / 72 });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const cx = c.getContext("2d")!;
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: cx, viewport: vp }).promise;
  return c;
}

async function runPrint() {
  const res = await fetch("/__xlsx/print/file");
  if (!res.ok) return;
  const { sheets } = readXlsx(new Uint8Array(await res.arrayBuffer()), "ko");
  const out: { sheet: string; excelPages: number; ourPages: number; ssim: number[] }[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    const r = await fetch(`/__xlsx/print/pdf?n=${i + 1}`);
    if (!r.ok) continue;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await r.arrayBuffer()), ...pdfOpts() }).promise;
    const ours = sheetPrintPages(sh).length;
    const row = { sheet: sh.name, excelPages: pdf.numPages, ourPages: ours, ssim: [] as number[] };
    for (let n = 1; n <= Math.min(pdf.numPages, ours); n++) {
      const ref = await pdfPage(pdf, n);
      const w = ref.width, h = ref.height;
      const got = document.createElement("canvas");
      got.width = w;
      got.height = h;
      const gc = got.getContext("2d")!;
      gc.fillStyle = "#fff";
      gc.fillRect(0, 0, w, h);
      paintSheetPage(gc, sh, w, h, "ko", n - 1);
      const size = fitSize(w, h, 900);
      const v = ssim(resizeGray(toGray(ref.getContext("2d")!.getImageData(0, 0, w, h).data, w, h), size.w, size.h), resizeGray(toGray(gc.getImageData(0, 0, w, h).data, w, h), size.w, size.h)).ssim;
      row.ssim.push(Math.round(v * 10000) / 10000);
      const pair = document.createElement("canvas");
      pair.width = w * 2 + 24;
      pair.height = h + 28;
      const pc = pair.getContext("2d")!;
      pc.fillStyle = "#e6e6e6";
      pc.fillRect(0, 0, pair.width, pair.height);
      pc.drawImage(ref, 0, 28);
      pc.drawImage(got, w + 24, 28);
      pc.fillStyle = "#111";
      pc.font = "15px sans-serif";
      pc.fillText(`Excel PDF — ${sh.name} ${n}/${pdf.numPages}`, 8, 19);
      pc.fillText(`오메 (Omniweave) ${n}/${ours} — SSIM ${v.toFixed(3)}`, w + 32, 19);
      await postPic(`print-${i + 1}-${n}.png`, pair);
    }
    out.push(row);
    log(`인쇄 ${sh.name}: 쪽 ${ours}/${pdf.numPages}, SSIM ${row.ssim.map((x) => x.toFixed(3)).join(" ")}`);
  }
  // the export path (PDF, pictures, printing): one picture page per printed page, at the paper size
  const doc = { ...newDocument("print"), pages: sheetPages(sheets, "omni-xlsx-print.xlsx") };
  const x = await expandSheetPrintPages(doc);
  for (const row of out) {
    const pgs = x.doc.pages.filter((p) => p.name === row.sheet || p.name.startsWith(`${row.sheet} (`));
    (row as { exportPages?: number }).exportPages = pgs.filter((p) => p.nodes.length === 1 && p.nodes[0].type === "IMAGE").length;
  }
  await fetch("/__xlsx/print/done", { method: "POST", body: JSON.stringify(out) });
}

run().catch((e) => fetch("/__xlsx/done", { method: "POST", body: JSON.stringify({ error: String(e?.stack ?? e) }) }));

// ───── charts and drawings: each chart against Excel's own picture of it (Chart.Export), and the chart workbook's
// printed pages (charts, pictures, shapes on the page) against Excel's PDF ─────

const gray = (c: HTMLCanvasElement) => toGray(c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
function pairPic(a: HTMLCanvasElement, b: HTMLCanvasElement, left: string, right: string) {
  const pair = document.createElement("canvas");
  pair.width = a.width + b.width + 24;
  pair.height = Math.max(a.height, b.height) + 28;
  const pc = pair.getContext("2d")!;
  pc.fillStyle = "#e6e6e6";
  pc.fillRect(0, 0, pair.width, pair.height);
  pc.drawImage(a, 0, 28);
  pc.drawImage(b, a.width + 24, 28);
  pc.fillStyle = "#111";
  pc.font = "15px sans-serif";
  pc.fillText(left, 8, 19);
  pc.fillText(right, a.width + 32, 19);
  return pair;
}
function sim(a: HTMLCanvasElement, b: HTMLCanvasElement) {
  const size = fitSize(a.width, a.height, 900);
  return ssim(resizeGray(gray(a), size.w, size.h), resizeGray(gray(b), size.w, size.h)).ssim;
}

async function runCharts() {
  const res = await fetch("/__xlsx/chart/file");
  if (!res.ok) return;
  const truth = await (await fetch("/__xlsx/chart/truth")).json();
  const { sheets } = readXlsx(new Uint8Array(await res.arrayBuffer()), "ko");
  await preloadDrawings(sheets);
  // the grid as the app shows it, drawings over the cells
  for (let i = 0; i < sheets.length; i++) {
    const grid = document.createElement("canvas");
    grid.width = 1100;
    grid.height = 900;
    paintSheet(grid.getContext("2d")!, sheets[i], { width: 1100, height: 900, zoom: 1, scrollX: 0, scrollY: 0, headings: true, lang: "ko", sheets, sel: { g: { r0: 0, c0: 0, r1: 0, c1: 0 }, ar: 0, ac: 0 } });
    await postPic(`chartgrid-${i + 1}.png`, grid);
  }
  const charts: { name: string; ssim: number; before: number }[] = [];
  const drawn = sheets[0].drawings?.filter((d) => d.kind === "chart") ?? [];
  for (const t of truth.charts) {
    const pr0 = await fetch(`/__xlsx/chart/png?n=${t.index}`);
    const blob = await pr0.blob();
    if (!pr0.ok || !blob.size) throw new Error(`chart png ${t.index}: ${pr0.status} ${blob.size} ${blob.type}`);
    const img = await createImageBitmap(new Blob([blob], { type: "image/png" }));
    const ref = document.createElement("canvas");
    ref.width = img.width;
    ref.height = img.height;
    const rc = ref.getContext("2d")!;
    rc.fillStyle = "#fff";
    rc.fillRect(0, 0, ref.width, ref.height);
    rc.drawImage(img, 0, 0);
    const got = document.createElement("canvas");
    got.width = ref.width;
    got.height = ref.height;
    const gc = got.getContext("2d")!;
    gc.fillStyle = "#fff";
    gc.fillRect(0, 0, got.width, got.height);
    const blank = sim(ref, got);
    const d = drawn.find((x) => x.name === t.name);
    if (d) paintChart(gc, d.chart!, d.theme ?? [], 0, 0, got.width, got.height, got.width / ((t.width * 96) / 72), { lang: "ko", font: sheets[0].baseFont, fonts: d.fonts });
    const v = sim(ref, got);
    charts.push({ name: t.name, ssim: Math.round(v * 10000) / 10000, before: Math.round(blank * 10000) / 10000 });
    await postPic(`chart-${t.index}.png`, pairPic(ref, got, `Excel — ${t.name}`, `오메 — SSIM ${v.toFixed(3)}`));
    log(`차트 ${t.name}: SSIM ${v.toFixed(4)} (전 ${blank.toFixed(4)})`);
  }
  // 3-D, chartex (waterfall, histogram, box & whisker, treemap, funnel), radar, surface, bubble charts — each against
  // Excel's picture; drawn with the workbook's cells (chartex data sit behind hidden names)
  const more: typeof charts = [];
  const mr = await fetch("/__xlsx/chart/file?book=more");
  if (mr.ok) {
    const mt = await (await fetch("/__xlsx/chart/truth?book=more")).json();
    const mb = readXlsx(new Uint8Array(await mr.arrayBuffer()), "ko").sheets;
    await preloadDrawings(mb);
    const md = mb[0].drawings?.filter((d) => d.kind === "chart") ?? [];
    for (const t of mt.charts) {
      const blob = await (await fetch(`/__xlsx/chart/png?book=more&n=${t.index}`)).blob();
      const img = await createImageBitmap(new Blob([blob], { type: "image/png" }));
      const ref = document.createElement("canvas");
      ref.width = img.width;
      ref.height = img.height;
      const rc = ref.getContext("2d")!;
      rc.fillStyle = "#fff";
      rc.fillRect(0, 0, ref.width, ref.height);
      rc.drawImage(img, 0, 0);
      const got = document.createElement("canvas");
      got.width = ref.width;
      got.height = ref.height;
      const gc = got.getContext("2d")!;
      gc.fillStyle = "#fff";
      gc.fillRect(0, 0, got.width, got.height);
      const blank = sim(ref, got);
      const d = md.find((x) => x.name === t.name);
      if (d) paintChart(gc, d.chart!, d.theme ?? [], 0, 0, got.width, got.height, got.width / ((t.width * 96) / 72), { lang: "ko", font: mb[0].baseFont, fonts: d.fonts, live: liveRef(mb, mb[0]) });
      const v = sim(ref, got);
      more.push({ name: t.name, ssim: Math.round(v * 10000) / 10000, before: Math.round(blank * 10000) / 10000 });
      await postPic(`chartmore-${t.index}.png`, pairPic(ref, got, `Excel — ${t.name}`, `오메 — SSIM ${v.toFixed(3)}`));
      log(`차트(더) ${t.name}: SSIM ${v.toFixed(4)} (빈 틀 ${blank.toFixed(4)})`);
    }
  }
  // printed pages of the chart workbook (one PDF, sheets one after another)
  const pages: { sheet: string; excelPages: number; ourPages: number; ssim: number[]; before: number[] }[] = [];
  const pr = await fetch("/__xlsx/chart/pdf");
  if (pr.ok) {
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await pr.arrayBuffer()), ...pdfOpts() }).promise;
    let at = 1;
    for (const ts of truth.sheets) {
      const sh = sheets.find((s) => s.name === ts.sheet);
      if (!sh) continue;
      const ours = sheetPrintPages(sh).length;
      const row = { sheet: sh.name, excelPages: ts.pages, ourPages: ours, ssim: [] as number[], before: [] as number[] };
      for (let n = 0; n < Math.min(ts.pages, ours); n++) {
        const ref = await pdfPage(pdf, at + n);
        const mk = (withDrawings: boolean) => {
          const c = document.createElement("canvas");
          c.width = ref.width;
          c.height = ref.height;
          const cx = c.getContext("2d")!;
          cx.fillStyle = "#fff";
          cx.fillRect(0, 0, c.width, c.height);
          paintSheetPage(cx, withDrawings ? sh : { ...sh, drawings: undefined }, c.width, c.height, "ko", n);
          return c;
        };
        const got = mk(true);
        const v = sim(ref, got);
        row.ssim.push(Math.round(v * 10000) / 10000);
        row.before.push(Math.round(sim(ref, mk(false)) * 10000) / 10000);
        await postPic(`chartpage-${pages.length + 1}-${n + 1}.png`, pairPic(ref, got, `Excel PDF — ${sh.name} ${n + 1}/${ts.pages}`, `오메 ${n + 1}/${ours} — SSIM ${v.toFixed(3)}`));
      }
      at += ts.pages;
      pages.push(row);
      log(`차트 통합 문서 인쇄 ${sh.name}: 쪽 ${ours}/${ts.pages}, SSIM ${row.ssim.map((x) => x.toFixed(3)).join(" ")}`);
    }
  }
  await fetch("/__xlsx/chart/done", { method: "POST", body: JSON.stringify({ charts, more, pages }) });
}

// ───── print page diagnosis (--only printdiag): why a printed page differs from Excel's, in numbers ─────
// Every text run on the page, Excel's (the PDF's text layer) against Omniweave's (each fillText): left edge, baseline,
// size. The SSIM is then split into windows with text and windows without (lines, fills), and "oracle" pages — our
// page with the text moved to Excel's place / size — tell how much of the gap each text error holds.

interface Run {
  s: string;
  x: number;
  y: number;
  w: number;
  size: number;
}

/** Excel's text runs of a PDF page, px at 96 dpi (left edge, baseline, advance width, font size). */
async function pdfRuns(pdf: pdfjs.PDFDocumentProxy, n: number): Promise<Run[]> {
  const page = await pdf.getPage(n);
  const vp = page.getViewport({ scale: 96 / 72 });
  const tc = await page.getTextContent();
  const out: Run[] = [];
  for (const it of tc.items as { str?: string; transform?: number[]; width?: number }[]) {
    if (!it.str || !it.transform || !it.str.trim()) continue;
    const lead = it.str.length - it.str.trimStart().length;
    const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
    const size = Math.hypot(it.transform[2], it.transform[3]) * (96 / 72);
    const w = (it.width ?? 0) * (96 / 72);
    out.push({ s: it.str.trim(), x: x + (lead ? (w * lead) / it.str.length : 0), y, w, size });
  }
  return out;
}

type Override = (i: number, r: Run) => Partial<Run> | null;
/** Paint with every fillText recorded in device px (and optionally moved: the oracle pages). */
function paintRecorded(sh: Parameters<typeof paintSheetPage>[1], w: number, h: number, n: number, override?: Override) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const cx = c.getContext("2d")!;
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, w, h);
  const runs: Run[] = [];
  const orig = cx.fillText;
  cx.fillText = function (this: CanvasRenderingContext2D, text: string, x: number, y: number, mw?: number) {
    const m = this.measureText(text);
    const t = this.getTransform();
    const al = this.textAlign;
    const lx = x - (al === "right" || al === "end" ? m.width : al === "center" ? m.width / 2 : 0);
    const by = y - (m.alphabeticBaseline ?? 0);
    const size = Number(/([\d.]+)px/.exec(this.font)?.[1] ?? 0);
    const rotated = Math.abs(t.b) > 1e-6 || Math.abs(t.c) > 1e-6;
    const r: Run = { s: String(text).trim(), x: t.a * lx + t.e, y: t.d * by + t.f, w: m.width * t.a, size: size * t.d };
    const i = runs.length;
    runs.push(rotated ? { ...r, s: "" } : r);
    const o = !rotated && override ? override(i, r) : null;
    if (!o) return mw === undefined ? orig.call(this, text, x, y) : orig.call(this, text, x, y, mw);
    this.save();
    this.setTransform(1, 0, 0, 1, 0, 0);
    this.textAlign = "left";
    this.textBaseline = "alphabetic";
    this.font = this.font.replace(/[\d.]+px/, `${o.size ?? r.size}px`);
    orig.call(this, text, o.x ?? r.x, o.y ?? r.y);
    this.restore();
  } as typeof cx.fillText;
  paintSheetPage(cx, sh, w, h, "ko", n);
  return { c, runs };
}

/** Pair our runs with Excel's: same text, nearest place. */
function matchRuns(ref: Run[], ours: Run[]) {
  const used = new Set<number>();
  const pairs: [Run, number][] = [];
  for (const r of ref) {
    let best = -1, bd = 120;
    ours.forEach((o, i) => {
      if (used.has(i) || o.s !== r.s) return;
      const d = Math.hypot(o.x - r.x, o.y - r.y);
      if (d < bd) (bd = d), (best = i);
    });
    if (best >= 0) used.add(best), pairs.push([r, best]);
  }
  return pairs;
}

async function runPrintDiag() {
  const res = await fetch("/__xlsx/print/file");
  if (!res.ok) return [];
  const { sheets } = readXlsx(new Uint8Array(await res.arrayBuffer()), "ko");
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < sheets.length; i++) {
    const sh = sheets[i];
    const r = await fetch(`/__xlsx/print/pdf?n=${i + 1}`);
    if (!r.ok) continue;
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await r.arrayBuffer()), ...pdfOpts() }).promise;
    const ours = sheetPrintPages(sh).length;
    for (let n = 1; n <= Math.min(pdf.numPages, ours); n++) {
      const refC = await pdfPage(pdf, n);
      const w = refC.width, h = refC.height;
      const refRuns = await pdfRuns(pdf, n);
      const base = paintRecorded(sh, w, h, n - 1);
      const pairs = matchRuns(refRuns, base.runs);
      const byIdx = new Map(pairs.map(([rr, k]) => [k, rr]));
      const size = fitSize(w, h, 900);
      const g = (c: HTMLCanvasElement) => resizeGray(gray(c), size.w, size.h);
      const refG = g(refC);
      const s0 = ssim(refG, g(base.c));
      const oracle = (pick: (rr: Run) => Partial<Run>) => ssim(refG, g(paintRecorded(sh, w, h, n - 1, (k) => (byIdx.has(k) ? pick(byIdx.get(k)!) : null)).c)).ssim;
      // windows with text (either side) against the rest
      const k = size.w / w;
      const boxes = [...refRuns, ...base.runs.filter((x) => x.s)].map((t) => [(t.x - 2) * k, (t.y - t.size) * k, (t.x + t.w + 2) * k, (t.y + t.size * 0.3) * k]);
      let tl = 0, tn = 0, nl = 0, nn = 0;
      for (let gy = 0; gy < s0.gh; gy++)
        for (let gx = 0; gx < s0.gw; gx++) {
          const x0 = gx * s0.stride, y0 = gy * s0.stride, x1 = x0 + s0.win, y1 = y0 + s0.win;
          const v = s0.map[gy * s0.gw + gx];
          if (boxes.some((b) => b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0)) (tl += 1 - v), tn++;
          else (nl += 1 - v), nn++;
        }
      const N = s0.gw * s0.gh;
      const d = pairs.map(([rr, kk]) => ({ dx: base.runs[kk].x - rr.x, dy: base.runs[kk].y - rr.y, dr: base.runs[kk].x + base.runs[kk].w - (rr.x + rr.w), ds: base.runs[kk].size - rr.size }));
      const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
      out.push({
        sheet: sh.name,
        page: n,
        scale: sheetPrintPages(sh)[n - 1].scale,
        ssim: s0.ssim,
        textLoss: tl / N,
        otherLoss: nl / N,
        textWin: tn / N,
        runs: { excel: refRuns.length, ours: base.runs.filter((x) => x.s).length, matched: pairs.length },
        dx: mean(d.map((x) => x.dx)),
        dy: mean(d.map((x) => x.dy)),
        dr: mean(d.map((x) => x.dr)),
        ds: mean(d.map((x) => x.ds)),
        adx: mean(d.map((x) => Math.abs(x.dx))),
        ady: mean(d.map((x) => Math.abs(x.dy))),
        oracleXY: oracle((rr) => ({ x: rr.x, y: rr.y })),
        oracleY: oracle((rr) => ({ y: rr.y })),
        oracleX: oracle((rr) => ({ x: rr.x })),
        oracleAll: oracle((rr) => ({ x: rr.x, y: rr.y, size: rr.size })),
        unmatchedExcel: refRuns.filter((rr) => !pairs.some(([p]) => p === rr)).slice(0, 8).map((x) => x.s.slice(0, 12)),
        // the first page's pairs in full: [text, Excel x, y, width, size, our x, y, width, size]
        ...(n === 1 ? { pairs: pairs.slice(0, 400).map(([rr, kk]) => [rr.s.slice(0, 16), rr.x, rr.y, rr.w, rr.size, base.runs[kk].x, base.runs[kk].y, base.runs[kk].w, base.runs[kk].size].map((v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v))) } : {}),
      });
      log(`진단 ${sh.name} ${n}: SSIM ${s0.ssim.toFixed(3)}`);
    }
  }
  return out;
}
