// Dev-only OCR evaluation on the synthetic set (scripts/ocr-synth.py). Bundled and run with plain Node (vitest's
// worker runs the same loops ~2.5× slower, which would misstate the speed):
//
//   npx esbuild scripts/ocr-eval.ts --bundle --platform=node --format=esm --outfile=<tmp>/ocr-eval.mjs
//   node <tmp>/ocr-eval.mjs <synth dir> <det.lwt> <rec.lwt> [--out results.json] [--only name] [--maxSide 1536] [--nospace]
//                           [--workers N]   (lines recognized by N worker threads through ocr/recPool.ts, as in the app)
//
// Metrics per page: CER (characters, with and without spaces), WER, line detection recall, table structure
// (cells with the right row/col/span) and cell-text CER, check boxes (found / state), font-size error, bold
// accuracy, time per stage and peak RSS.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker } from "node:worker_threads";
import { parseGraph } from "../src/core/image/infer/graph";
import { ocrPage, ocrPageWith, type OcrPage } from "../src/core/image/ocr/pipeline";
import { RecPool } from "../src/core/image/ocr/recPool";
import type { Img } from "../src/core/image/pixels";

const args = process.argv.slice(2);
const [dir, detPath, recPath] = args;
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);

function readRgba(p: string): Img {
  const b = readFileSync(p);
  const w = b.readUInt32LE(0), h = b.readUInt32LE(4);
  return { width: w, height: h, data: new Uint8ClampedArray(b.buffer, b.byteOffset + 8, w * h * 4) };
}

export function edit(a: string, b: string): number {
  const A = [...a], B = [...b];
  let prev = Array.from({ length: B.length + 1 }, (_, i) => i);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[B.length];
}

type GtLine = { text: string; box: number[]; px: number; bold: boolean; cell?: number[]; check?: number };
type GtTable = { xs: number[]; ys: number[]; cells: { r: number; c: number; rs: number; cs: number; text: string }[] };
type Gt = { name: string; skew: number; lines: GtLine[]; tables: GtTable[]; checks: { box: number[]; checked: boolean }[] };

const nospace = (s: string) => s.replace(/\s+/g, "");

function evalPage(gt: Gt, p: OcrPage) {
  let cerE = 0, cerN = 0, cerNsE = 0, cerNsN = 0, werE = 0, werN = 0, found = 0;
  const sizeErr: number[] = [], ratios: number[] = [];
  let boldOk = 0, boldN = 0;
  const allChars = p.lines.flatMap((l) => l.chars.map((c) => ({ ...c, cy: l.box.y + l.box.h / 2, l })));
  const lineOf = new Map(p.blocks.flatMap((b) => b.paragraphs.flatMap((q) => q.lines.map((l) => [l, q] as const))));
  const errs: { gt: string; got: string }[] = [];
  for (const g of gt.lines) {
    const [x, y, w, h] = g.box;
    const want = g.check !== undefined ? `${gt.checks[g.check].checked ? "☑" : "☐"} ${g.text}` : g.text;
    const gx0 = g.check !== undefined ? gt.checks[g.check].box[0] - 4 : x - h * 0.3;
    const mine = allChars.filter((c) => (c.x0 + c.x1) / 2 >= gx0 && (c.x0 + c.x1) / 2 <= x + w + h * 0.3 && c.cy >= y - h * 0.2 && c.cy <= y + h * 1.2).sort((a, b) => a.x0 - b.x0);
    const got = mine.map((c) => c.ch).join("").replace(/\s+/g, " ").trim();
    const e = edit(want, got);
    cerE += e;
    cerN += [...want].length;
    cerNsE += edit(nospace(want), nospace(got));
    cerNsN += [...nospace(want)].length;
    const ww = want.split(" "), gw = got.split(" ");
    // word errors = edit distance over word tokens
    const wd = (() => {
      let prev = Array.from({ length: gw.length + 1 }, (_, i) => i);
      for (let i = 1; i <= ww.length; i++) {
        const cur = [i];
        for (let j = 1; j <= gw.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ww[i - 1] === gw[j - 1] ? 0 : 1));
        prev = cur;
      }
      return prev[gw.length];
    })();
    werE += wd;
    werN += ww.length;
    if (e) errs.push({ gt: want, got });
    if (mine.length && edit(nospace(want), nospace(got)) / Math.max(1, [...nospace(want)].length) < 0.5) found++;
    // font size and bold (free text lines matched one-to-one)
    const ls = [...new Set(mine.map((c) => c.l))];
    if (ls.length === 1 && g.cell === undefined && g.check === undefined) {
      const l = ls[0];
      ratios.push(l.core.h / g.px);
      const q = lineOf.get(l);
      if (q) {
        sizeErr.push(Math.abs(q.size - g.px) / g.px);
        boldN++;
        if (q.bold === g.bold) boldOk++;
      }
    }
  }
  // tables
  let cellsN = 0, cellsOk = 0, cellTxtE = 0, cellTxtN = 0, tablesFound = 0;
  for (const t of gt.tables) {
    const bx = { x: t.xs[0], y: t.ys[0], w: t.xs[t.xs.length - 1] - t.xs[0], h: t.ys[t.ys.length - 1] - t.ys[0] };
    const pt = p.tables.find((q) => {
      const ix = Math.min(q.box.x + q.box.w, bx.x + bx.w) - Math.max(q.box.x, bx.x), iy = Math.min(q.box.y + q.box.h, bx.y + bx.h) - Math.max(q.box.y, bx.y);
      return ix > 0 && iy > 0 && (ix * iy) / (bx.w * bx.h + q.box.w * q.box.h - ix * iy) > 0.5;
    });
    if (pt) tablesFound++;
    for (const c of t.cells) {
      cellsN++;
      const i = pt ? pt.cells.findIndex((q) => q.r === c.r && q.c === c.c && q.rs === c.rs && q.cs === c.cs) : -1;
      if (i >= 0) cellsOk++;
      const got = i >= 0 ? pt!.text[i].replace(/\s+/g, " ").trim() : "";
      cellTxtE += edit(c.text, got);
      cellTxtN += [...c.text].length;
    }
  }
  // check boxes
  let chkFound = 0, chkState = 0;
  for (const c of gt.checks) {
    const q = p.checks.find((k) => Math.abs(k.box.x - c.box[0]) < 8 && Math.abs(k.box.y - c.box[1]) < 8);
    if (q) {
      chkFound++;
      if (q.checked === c.checked) chkState++;
    }
  }
  return {
    cer: cerE / Math.max(1, cerN),
    cerNoSpace: cerNsE / Math.max(1, cerNsN),
    wer: werE / Math.max(1, werN),
    chars: cerN,
    lineRecall: found / Math.max(1, gt.lines.length),
    tables: `${tablesFound}/${gt.tables.length}`,
    cellStruct: cellsN ? cellsOk / cellsN : null,
    cellCer: cellTxtN ? cellTxtE / cellTxtN : null,
    checks: gt.checks.length ? `${chkFound}/${gt.checks.length} found, ${chkState} state ok` : "-",
    sizeErr: sizeErr.length ? sizeErr.reduce((a, b) => a + b, 0) / sizeErr.length : null,
    coreRatio: ratios.length ? ratios.sort((a, b) => a - b)[Math.floor(ratios.length / 2)] : null,
    bold: boldN ? boldOk / boldN : null,
    skew: { gt: gt.skew, est: p.angle },
    ms: p.ms,
    errs: errs.slice(0, 40),
  };
}

if (!isMainThread) {
  // a recognition worker of --workers: recWorker.ts behind a `self` shim
  const g = globalThis as unknown as { self: { postMessage(m: unknown): void; onmessage?: (e: { data: unknown }) => void } };
  g.self = { postMessage: (m) => parentPort!.postMessage(m) };
  parentPort!.on("message", (data) => g.self.onmessage?.({ data }));
  await import("../src/core/image/ocr/recWorker");
} else await main();

async function main() {
const det = parseGraph(new Uint8Array(readFileSync(detPath)));
const recBytes = readFileSync(recPath);
const rec = parseGraph(new Uint8Array(recBytes));
const nw = Number(opt("--workers") ?? 0);
const pool = nw > 0
  ? new RecPool(() => {
      const w = new Worker(fileURLToPath(import.meta.url));
      const pw = { postMessage: (m: unknown, t?: Transferable[]) => w.postMessage(m, t as never), terminate: () => void w.terminate(), onmessage: null as ((e: MessageEvent) => void) | null, onerror: null as ((e: ErrorEvent) => void) | null };
      w.on("message", (data) => pw.onmessage?.({ data } as MessageEvent));
      w.on("error", (e) => pw.onerror?.(e as unknown as ErrorEvent));
      return pw;
    }, nw)
  : null;
pool?.prepare(recBytes.buffer.slice(recBytes.byteOffset, recBytes.byteOffset + recBytes.byteLength));
let peak = 0;
const sample = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 20);
const results: Record<string, ReturnType<typeof evalPage>> = {};
const only = opt("--only");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && (!only || f.includes(only))).sort()) {
  const gt = JSON.parse(readFileSync(`${dir}/${f}`, "utf8")) as Gt;
  const img = readRgba(`${dir}/${f.replace(".json", ".rgba")}`);
  const oo = { maxSide: opt("--maxSide") ? Number(opt("--maxSide")) : undefined, spaces: !args.includes("--nospace"), spaceFactor: opt("--sf") ? Number(opt("--sf")) : undefined, minWidth: opt("--minw") ? Number(opt("--minw")) : undefined };
  const p = pool ? await ocrPageWith(det, pool.run, img, oo) : ocrPage(det, rec, img, oo);
  peak = Math.max(peak, process.memoryUsage().rss);
  const r = evalPage(gt, p);
  results[gt.name] = r;
  console.log(
    `${gt.name.padEnd(22)} CER ${(r.cer * 100).toFixed(2)}% (no-space ${(r.cerNoSpace * 100).toFixed(2)}%) WER ${(r.wer * 100).toFixed(1)}% recall ${(r.lineRecall * 100).toFixed(0)}% ` +
      `tables ${r.tables} struct ${r.cellStruct === null ? "-" : (r.cellStruct * 100).toFixed(0) + "%"} cellCER ${r.cellCer === null ? "-" : (r.cellCer * 100).toFixed(1) + "%"} checks ${r.checks} ` +
      `size±${r.sizeErr === null ? "-" : (r.sizeErr * 100).toFixed(0) + "%"} core/px ${r.coreRatio?.toFixed(3)} bold ${r.bold === null ? "-" : (r.bold * 100).toFixed(0) + "%"} skew ${r.skew.gt}/${r.skew.est} ` +
      `ms ${Math.round(r.ms.total)} (desk ${Math.round(r.ms.deskew)} det ${Math.round(r.ms.det)} rec ${Math.round(r.ms.rec)} lay ${Math.round(r.ms.layout)})`,
  );
}
clearInterval(sample);
console.log(`peak RSS ${(peak / 1e6).toFixed(0)} MB`);
if (opt("--out")) writeFileSync(opt("--out")!, JSON.stringify({ results, peakRss: peak }, null, 1));
pool?.dispose();
}
