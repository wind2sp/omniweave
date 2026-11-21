// Word fidelity harness (docs/design/FIDELITY_DOCX.md) — runs in a real browser engine with the PC's system fonts.
// Loaded by qa/fidelity/docx.html, served by scripts/fidelity-docx.mjs (vite + headless Edge/Chrome).
//
// For every DOCX with the PDF Word printed of it (the truth) it opens the DOCX with importFile, then compares
//   - page count
//   - line breaks: the text of both sides as one character stream (whitespace dropped), aligned; a Word line start
//     that falls on an Omniweave line start agrees
//   - glyph positions: for agreeing line starts on the same page, |Δx| and |Δy| of the line's first glyph (baseline), pt
//   - image: SSIM of each page (Word PDF rendered by pdf.js against paintPage), and a Word | Omniweave picture
// Lines are visual lines on both sides: fragments on the same baseline (±2 pt) of a page, left to right.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useStore } from "../../src/core/store";
import { hfNodesAt, renderMasterOf } from "../../src/core/headerFooter";
import { newDocument, type OmwDocument, type Page, type TextNode } from "../../src/core/types";
import { advance, layoutText, pageFontsSettled, runScale } from "../../src/core/text";
import { CELL_PAD_Y, TABLE_LINE, tableCells } from "../../src/core/table";
import { encodePng } from "../../src/io/formats/png";
import { ctx2d, makeCanvas } from "../../src/render/draw";
import { paintPage } from "../../src/render/weave";
import { importFile, lastImport } from "../../src/ui/actions";
import { fitSize, resizeGray, ssim, toGray } from "./ssim";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const S = () => useStore.getState();
const PX2PT = 0.75;
const MAX_IMG_PAGES = 4;
const log = (m: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += m + "\n";
};

/** A run of text at a place on a page (pt, y = baseline from the top). */
interface Frag {
  page: number;
  x: number;
  y: number;
  text: string;
  /** right edge of the visible glyphs (trailing spaces left out) */
  r: number;
}
interface VLine {
  page: number;
  r: number;
  x: number;
  y: number;
  text: string;
}

export interface DocxRow {
  key: string;
  pagesWord: number;
  pagesOmni: number;
  linesWord: number;
  linesOmni: number;
  /** Word line starts that are also Omniweave line starts / Word line starts that could be aligned */
  breakAgree: number;
  breakTotal: number;
  /** aligned characters / Word characters */
  textCover: number;
  /** line starts on the same page (of the agreeing ones) */
  samePage: number;
  dxMean: number;
  dyMean: number;
  dyMedian: number;
  ssim: number[];
  pics: string[];
  error?: string;
  /** first differing line breaks (Word line | Omniweave line), for the report of local files only */
  diffs?: string[];
  /** natural width of lines with the same text, Omniweave − Word (pt, mean; lines Word left unjustified) */
  dwMean?: number;
  dwN?: number;
  /** Word pages on which every line starts at the same character, page and place (±2 pt) */
  pagesPass?: number;
  /** text nodes beyond one per page (the body split into several text boxes; goal 0) */
  boxSplits?: number;
  /** first laid-out body line: font and pieces (text@x+width, pt) */
  probe?: string;
  /** last line of each Word page and Omniweave's last line of that page (baseline pt, first characters) */
  ends?: string[];
}

function toLines(frags: Frag[]): VLine[] {
  const out: VLine[] = [];
  const byPage = new Map<number, Frag[]>();
  for (const f of frags) if (f.text.trim()) (byPage.get(f.page) ?? byPage.set(f.page, []).get(f.page)!).push(f);
  for (const [page, fs] of [...byPage].sort((a, b) => a[0] - b[0])) {
    fs.sort((a, b) => a.y - b.y || a.x - b.x);
    let cur: Frag[] = [];
    const flush = () => {
      if (!cur.length) return;
      cur.sort((a, b) => a.x - b.x);
      out.push({ page, x: cur[0].x, y: cur[0].y, r: Math.max(...cur.filter((f) => f.text.trim()).map((f) => f.r)), text: cur.map((f) => f.text).join("") });
      cur = [];
    };
    for (const f of fs) {
      if (cur.length && Math.abs(f.y - cur[0].y) > 2) flush();
      cur.push(f);
    }
    flush();
  }
  return out;
}

// (a Symbol-font bullet comes out of Word's PDF as U+26AB, Omniweave writes U+25CF: the same mark)
const norm = (s: string) => s.normalize("NFC").replace(/\s+/g, "").replace(/[\u26AB\u2022\uF0B7]/g, "\u25CF");

/** Character stream of lines and the stream offset where each line starts. */
function stream(lines: VLine[]): { s: string; starts: number[] } {
  let s = "";
  const starts: number[] = [];
  for (const l of lines) {
    starts.push(s.length);
    s += norm(l.text);
  }
  return { s, starts };
}

/** Greedy alignment of b to a with resynchronisation on 6-character anchors: map[i] = index in b, or -1. */
function align(a: string, b: string): Int32Array {
  const map = new Int32Array(a.length).fill(-1);
  let i = 0, j = 0;
  const K = 6;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      map[i++] = j++;
      continue;
    }
    let found = false;
    for (let k = 1; k < 400 && !found; k++)
      for (let da = 0; da <= k; da++) {
        const db = k - da;
        if (i + da + K <= a.length && j + db + K <= b.length && a.substr(i + da, K) === b.substr(j + db, K)) {
          i += da;
          j += db;
          found = true;
          break;
        }
      }
    if (!found) break;
  }
  return map;
}

async function bytesOf(key: string): Promise<Uint8Array> {
  const r = await fetch(`/__docx/file?key=${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`파일을 읽지 못함 ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

const openPdf = (bytes: Uint8Array) =>
  pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, cMapUrl: new URL("/node_modules/pdfjs-dist/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/node_modules/pdfjs-dist/standard_fonts/", location.href).href }).promise;

async function wordFrags(pdf: any): Promise<Frag[]> {
  const out: Frag[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const h = page.getViewport({ scale: 1 }).height;
    const tc = await page.getTextContent();
    for (const it of tc.items as any[]) if (it.str) out.push({ page: p - 1, x: it.transform[4], y: h - it.transform[5], text: it.str, r: it.transform[4] + (it.str.trim() ? it.width : 0) });
  }
  return out;
}

/** Omniweave's laid-out text: body text nodes line by line, table cells line by line, headers and footers. */
function omniFrags(doc: OmwDocument): Frag[] {
  const out: Frag[] = [];
  doc.pages.forEach((pg, pi) => {
    const textAt = (n: TextNode, ox: number, oy: number) => {
      const L = layoutText(n);
      for (const line of L.lines)
        for (const p of line.pieces) {
          const vis = p.text.replace(/\s+$/, "");
          const w = vis === p.text ? p.width : advance(vis, p.font, p.letterSpacing, runScale(p.run));
          // (a superscript / subscript piece on its own baseline, as Word's PDF has it)
          out.push({ page: pi, x: (ox + p.x) * PX2PT, y: (oy + line.y + line.baseline + (p.dy ?? 0)) * PX2PT, text: p.text, r: (ox + p.x + w) * PX2PT });
        }
    };
    for (const n of [...pg.nodes, ...hfNodesAt(doc, pi)]) {
      if (n.type === "TEXT") textAt(n, n.transform.x, n.transform.y);
      else if (n.type === "TABLE") {
        const lh = n.fontSize * TABLE_LINE;
        for (const c of tableCells(n))
          if (c.rich) textAt(c.rich.node, n.transform.x + c.rich.x, n.transform.y + c.rich.y);
          else c.lines.forEach((l, i) =>
            out.push({ page: pi, x: (n.transform.x + c.rect.x + 6) * PX2PT, y: (n.transform.y + c.rect.y + CELL_PAD_Y + i * lh + (lh - n.fontSize) / 2 + n.fontSize * 0.8) * PX2PT, text: l.text, r: (n.transform.x + c.rect.x + 6 + l.width) * PX2PT }),
          );
      }
    }
  });
  return out;
}

async function omniRender(doc: OmwDocument, page: Page, scale: number) {
  const w = Math.max(1, Math.round(page.width * scale)), h = Math.max(1, Math.round(page.height * scale));
  const cv = makeCanvas(w, h);
  const c = ctx2d(cv);
  const master = renderMasterOf(doc, page);
  let complete = false;
  for (let i = 0; i < 60 && !complete; i++) {
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = "#fff";
    c.fillRect(0, 0, w, h);
    complete = paintPage(c, doc, page, master, scale);
    if (!complete) await new Promise((r) => setTimeout(r, 150));
  }
  return { rgba: c.getImageData(0, 0, w, h).data, w, h };
}

async function pdfRender(pdf: any, index: number, width: number) {
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

async function measureDoc(key: string, tag: string): Promise<DocxRow> {
  const bytes = await bytesOf(key);
  const pdf = await openPdf(await bytesOf(key.replace(/\.docx?$/i, ".pdf")));
  S().load(newDocument());
  await importFile({ name: key.split("/").pop()!, path: null, bytes });
  if (lastImport?.error) throw new Error(lastImport.error.split("\n")[0]);
  // the document fonts' local() faces loaded first (core/text.ts localAlias), as the screen has them
  await pageFontsSettled([...S().doc.pages, ...S().doc.masters]);
  const doc = S().doc;
  const pages = doc.pages;
  const W = toLines(await wordFrags(pdf));
  const O = toLines(omniFrags(doc));
  const sw = stream(W), so = stream(O);
  const map = align(sw.s, so.s);
  const oStart = new Map(so.starts.map((s, i) => [s, i]));
  let agree = 0, total = 0, same = 0;
  const dx: number[] = [], dy: number[] = [];
  const diffs: string[] = [];
  // a Word page passes when every line on it starts at the same character, on the same page, within 2 pt
  const rightW = Math.max(...W.map((l) => l.r));
  const dw: number[] = [];
  const pageOk = Array.from({ length: pdf.numPages }, () => pages.length === pdf.numPages);
  W.forEach((wl, wi) => {
    const at = sw.starts[wi];
    if (!norm(wl.text)) return;
    const m = map[at];
    const ok = (() => {
      if (m < 0) return false;
      const oi = oStart.get(m);
      const ol = oi === undefined ? null : O[oi];
      return !!ol && ol.page === wl.page && Math.abs(ol.x - wl.x) <= 2 && Math.abs(ol.y - wl.y) <= 2;
    })();
    if (!ok) pageOk[wl.page] = false;
    if (m < 0) return;
    total++;
    const oi = oStart.get(m);
    if (oi === undefined) {
      if (diffs.length < 12) {
        const ol = O.findIndex((_, k) => so.starts[k] <= m && (so.starts[k + 1] ?? Infinity) > m);
        diffs.push(`W: ${wl.text.slice(0, 60)} | O: ${O[ol]?.text.slice(0, 60) ?? "?"}`);
      }
      return;
    }
    agree++;
    const ol = O[oi];
    // natural line widths: lines Word did not stretch (ending well before the right margin) with the same text
    const nextW = sw.starts[wi + 1] ?? sw.s.length, nextO = so.starts[oi + 1] ?? so.s.length;
    if (map[nextW - 1] === nextO - 1 && wl.r < rightW - 6) dw.push(ol.r - ol.x - (wl.r - wl.x));
    if (ol.page === wl.page) {
      same++;
      dx.push(Math.abs(ol.x - wl.x));
      dy.push(Math.abs(ol.y - wl.y));
    }
  });
  let covered = 0;
  for (let i = 0; i < map.length; i++) if (map[i] >= 0) covered++;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
  const sorted = [...dy].sort((a, b) => a - b);
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const row: DocxRow = {
    key: tag,
    pagesWord: pdf.numPages,
    pagesOmni: pages.length,
    linesWord: W.length,
    linesOmni: O.length,
    breakAgree: agree,
    breakTotal: total,
    textCover: r2(covered / Math.max(1, sw.s.length)),
    samePage: same,
    dxMean: r2(mean(dx)),
    dyMean: r2(mean(dy)),
    dyMedian: r2(sorted[Math.floor(sorted.length / 2)] ?? NaN),
    dwMean: r2(mean(dw)),
    dwN: dw.length,
    ssim: [],
    pics: [],
    diffs,
    pagesPass: pageOk.filter(Boolean).length,
    // body split into text boxes: text nodes beyond one per page (one flowing body = 0)
    boxSplits: pages.reduce((s, pg) => s + Math.max(0, pg.nodes.filter((n) => n.type === "TEXT" && !n.notes).length - 1), 0),
  };
  // page ends: the last line of every Word page and the line Omniweave has there (baseline pt), to tell page-break rules
  row.ends = Array.from({ length: pdf.numPages }, (_, p) => {
    const wl = W.filter((l) => l.page === p).pop();
    const ol = O.filter((l) => l.page === p).pop();
    return `p${p + 1} W ${wl ? wl.y.toFixed(1) + " " + norm(wl.text).slice(0, 8) : "-"} | O ${ol ? ol.y.toFixed(1) + " " + norm(ol.text).slice(0, 8) : "-"}`;
  });
  const fmt = (l: VLine) => `p${l.page + 1} y${l.y.toFixed(1)} x${l.x.toFixed(2)} r${l.r.toFixed(2)} ${l.text}`;
  row.lines = { w: W.map(fmt), o: O.map(fmt) };
  // the first body line as laid out: font and piece advances (pt), to tell glyph widths from break rules
  const tn = pages[0]?.nodes.find((n) => n.type === "TEXT" && n.paragraphs.length > 1);
  if (tn && tn.type === "TEXT") {
    const l = layoutText(tn).lines.find((x) => x.pieces.length > 3);
    if (l) row.probe = [l.pieces[0].font, ...l.pieces.slice(0, 8).map((p) => `${JSON.stringify(p.text)}@${(p.x * PX2PT).toFixed(2)}+${(p.width * PX2PT).toFixed(2)}`)].join(" ");
  }
  // pictures: Word | Omniweave side by side, page by page
  for (let i = 0; i < Math.min(MAX_IMG_PAGES, pdf.numPages, pages.length); i++) {
    const ref = await pdfRender(pdf, i, 700);
    const got = await omniRender(doc, pages[i], ref.w / pages[i].width);
    const size = fitSize(ref.w, ref.h, 900);
    row.ssim.push(Math.round(ssim(resizeGray(toGray(ref.rgba, ref.w, ref.h), size.w, size.h), resizeGray(toGray(got.rgba, got.w, got.h), size.w, size.h)).ssim * 10000) / 10000);
    const gap = 12, h = Math.max(ref.h, got.h), Wd = ref.w + gap + got.w;
    const out = new Uint8ClampedArray(Wd * h * 4).fill(255);
    for (let y = 0; y < h; y++) {
      if (y < ref.h) out.set(ref.rgba.subarray(y * ref.w * 4, (y + 1) * ref.w * 4), y * Wd * 4);
      if (y < got.h) out.set(got.rgba.subarray(y * got.w * 4, (y + 1) * got.w * 4), (y * Wd + ref.w + gap) * 4);
      for (let x = ref.w; x < ref.w + gap; x++) out.set([200, 40, 40, 255], (y * Wd + x) * 4);
    }
    const res = await fetch(`/__docx/pic?name=${encodeURIComponent(`${tag}-p${i + 1}.png`)}`, { method: "POST", body: encodePng(out, Wd, h, 6) as BlobPart });
    if (res.ok) row.pics.push(await res.text());
  }
  await pdf.destroy();
  return row;
}

async function main() {
  (window as any).alert = () => {};
  (window as any).confirm = () => true;
  (window as any).prompt = () => null;
  const items: { key: string; tag: string }[] = await (await fetch("/__docx/list")).json();
  for (const it of items) {
    let row: DocxRow;
    try {
      row = await measureDoc(it.key, it.tag);
    } catch (e: any) {
      row = { key: it.tag, pagesWord: 0, pagesOmni: 0, linesWord: 0, linesOmni: 0, breakAgree: 0, breakTotal: 0, textCover: 0, samePage: 0, dxMean: NaN, dyMean: NaN, dyMedian: NaN, ssim: [], pics: [], error: String(e?.message ?? e).slice(0, 160) };
    }
    await fetch("/__docx/row", { method: "POST", body: JSON.stringify(row) });
    log(`${it.tag}: 줄 나눔 ${row.breakAgree}/${row.breakTotal} 쪽 ${row.pagesWord}/${row.pagesOmni} ${row.error ?? ""}`);
  }
  await fetch("/__docx/done", { method: "POST" });
}

main().catch(async (e) => {
  await fetch("/__docx/done", { method: "POST", body: String(e?.stack ?? e) });
});
