// PowerPoint fidelity harness (docs/design/FIDELITY_PPTX.md) — runs in a real browser engine, served by
// scripts/fidelity-pptx.mjs (vite + headless Edge/Chrome, qa/fidelity/pptx.html).
//
// For every deck with a PowerPoint-printed reference PDF ("<deck>.ref.pdf"), slide by slide:
//   image   SSIM of the PowerPoint PDF page (pdf.js) against Omniweave's own render (paintPage), and the share of
//           visibly different 8×8 windows
//   text    lines of the PDF (pdf.js text items grouped by baseline) against the lines Omniweave lays out (layoutText):
//           share of reference lines Omniweave breaks the same way (same characters on one line), and for those the
//           mean |Δx| / |Δy| of the line start and baseline in points
// A side-by-side PNG (PowerPoint | Omniweave) is posted for every slide.

import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { masterOf, useStore } from "../../src/core/store";
import { newDocument, type OmwDocument, type Page, type SceneNode } from "../../src/core/types";
import { layoutText, pageFontsSettled } from "../../src/core/text";
import { tableCells } from "../../src/core/table";
import { encodePng } from "../../src/io/formats/png";
import { ctx2d, makeCanvas } from "../../src/render/draw";
import { paintPage } from "../../src/render/weave";
import { importFile, lastImport } from "../../src/ui/actions";
import { pptxUnchanged } from "../../src/io/officesurgeon/pptx";
import { editTest, SCENARIOS } from "./pptxEdit";
import { fitSize, resizeGray, ssim, toGray } from "./ssim";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const W = 960; // compared width in px (a 16:9 slide: 960×540)
const S = () => useStore.getState();
const log = (m: string) => {
  const el = document.getElementById("log");
  if (el) el.textContent += m + "\n";
};

export interface Line {
  text: string;
  /** line start and baseline, points from the slide's top-left */
  x: number;
  y: number;
  size: number;
}

export interface SlideScore {
  slide: number;
  ssim: number;
  badShare: number;
  refLines: number;
  omniLines: number;
  sameBreak: number;
  dx: number;
  dy: number;
  /** reference lines Omniweave does not have on one line (first few) */
  missing: string[];
  /** every line as "x,y,size text" (reference and Omniweave), for looking into one slide */
  detail?: { ref: string[]; omni: string[] };
}

const norm = (s: string) => s.replace(/[\s ]+/g, "").replace(/[“”]/g, '"');
/** list markers drawn as separate glyphs in the PDF (bullets, "1.", "a)"; symbol-font bullets as PowerPoint's PDF maps them: Wingdings ü → ✓, Ø → ➢ …) */
const MARKER = /^([•▪◦‣–\-•✓✔✗✘➢➤►▶■□❑◆◇❖●○]|\(?[0-9a-zA-Z]{1,3}[.)])$/;

async function refLines(page: any): Promise<Line[]> {
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  type It = { s: string; x: number; y: number; w: number; size: number };
  const items: It[] = [];
  for (const it of tc.items as any[]) {
    if (!("str" in it) || !it.str) continue;
    const [a, b, , , e, f] = it.transform;
    if (Math.abs(b) > 0.01 * Math.abs(a)) continue; // rotated text: not compared
    items.push({ s: it.str, x: e, y: vp.height - f, w: it.width, size: Math.hypot(a, b) });
  }
  // lines: same baseline, gaps smaller than two characters
  items.sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: { its: It[] }[] = [];
  for (const it of items) {
    const ln = lines.find((l) => {
      const last = l.its[l.its.length - 1];
      return Math.abs(last.y - it.y) < 0.35 * Math.max(last.size, it.size) && it.x >= last.x - 1 && it.x - (last.x + last.w) < 1.2 * Math.max(last.size, it.size);
    });
    if (ln) ln.its.push(it);
    else lines.push({ its: [it] });
  }
  return lines
    .map((l) => {
      let its = l.its.filter((i) => i.s.trim());
      while (its.length > 1 && MARKER.test(its[0].s.trim())) its = its.slice(1);
      const text = norm(its.map((i) => i.s).join(""));
      const big = its.reduce((m, i) => Math.max(m, i.size), 0);
      return { text, x: its[0]?.x ?? 0, y: Math.max(...its.filter((i) => i.size >= big * 0.8).map((i) => i.y)), size: big };
    })
    .filter((l) => l.text && !MARKER.test(l.text));
}

/** Lines Omniweave lays out for the slide's text nodes (unrotated), in points. */
function omniLines(page: Page): Line[] {
  const out: Line[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const n of nodes) {
      // a table whose cells are laid out from their paragraphs (TableNode.cellBox): each cell as a text box
      if (n.visible && n.type === "TABLE" && n.cellBox && !n.transform.rotation) {
        const k = n.transform.scale;
        const cells: SceneNode[] = tableCells(n).flatMap((c) => (c.rich ? [{ ...c.rich.node, visible: true, transform: { ...n.transform, x: n.transform.x + c.rich.x * k, y: n.transform.y + c.rich.y * k } } as SceneNode] : []));
        // PowerPoint's PDF has a table row on one baseline as one text line (pdf.js joins the cells): join them the same way
        const at = out.length;
        walk(cells);
        const own = out.splice(at).sort((a, b) => a.y - b.y || a.x - b.x);
        for (const l of own) {
          const row = out.length > at ? out[out.length - 1] : null;
          if (row && Math.abs(row.y - l.y) < 0.5) row.text += l.text;
          else out.push({ ...l });
        }
        continue;
      }
      if (!n.visible || n.type !== "TEXT" || n.transform.rotation) continue;
      const k = n.transform.scale;
      const lay = layoutText(n);
      lay.lines.forEach((l, li) => {
        let ps = l.pieces.filter((p) => p.text.trim());
        while (ps.length > 1 && MARKER.test(ps[0].text.trim())) ps = ps.slice(1);
        // the list marker of the paragraph's first line, whatever its character: a symbol-font bullet (Wingdings "ü")
        // is a different character in the PDF ("✓"), and it is not part of the line's text
        const mk = n.paragraphs[l.paragraph]?.list?.mk?.trim();
        if (mk && (li === 0 || lay.lines[li - 1].paragraph !== l.paragraph) && ps.length > 1 && ps[0].text.trim() === mk) ps = ps.slice(1);
        if (!ps.length) return;
        let text = norm(ps.map((p) => p.text).join(""));
        // a marker glued to the first word ("•첫째"): drop it as the PDF has it apart
        const m = /^([•▪◦‣–•]|[0-9a-zA-Z]{1,3}[.)])(?=.)/.exec(text);
        let x0 = ps[0].x;
        if (m && ps[0].text.trim().startsWith(m[1]) && MARKER.test(m[1])) text = text.slice(m[1].length);
        out.push({ text, x: (n.transform.x + x0 * k) * 0.75, y: (n.transform.y + (l.y + l.baseline) * (n.transform.scaleY ?? k)) * 0.75, size: Math.max(...ps.map((p) => p.run.fontSize)) * 0.75 * k });
      });
    }
  };
  walk(page.nodes);
  return out;
}

/** line text for matching: a list marker glued to the text ("1.번호") does not count */
const key = (t: string) => t.replace(/^(?:[•▪◦‣–•]|\(?[0-9a-zA-Z]{1,3}[.)])(?=.)/, "");

function compareLines(ref: Line[], got: Line[]): Pick<SlideScore, "refLines" | "omniLines" | "sameBreak" | "dx" | "dy" | "missing"> {
  const used = new Set<number>();
  let same = 0, dx = 0, dy = 0, nx = 0;
  const missing: string[] = [];
  for (const r of ref) {
    let best = -1, bd = Infinity;
    got.forEach((g, i) => {
      if (used.has(i) || key(g.text) !== key(r.text)) return;
      const d = Math.hypot(g.x - r.x, g.y - r.y);
      if (d < bd) (bd = d), (best = i);
    });
    if (best < 0) {
      if (missing.length < 6) missing.push(r.text.slice(0, 40));
      continue;
    }
    used.add(best);
    same++;
    // a line whose marker could not be separated starts at the marker on one side only: its x is not compared
    if (key(r.text) === r.text && key(got[best].text) === got[best].text) dx += Math.abs(got[best].x - r.x);
    else nx++;
    dy += Math.abs(got[best].y - r.y);
  }
  return { refLines: ref.length, omniLines: got.length, sameBreak: same, dx: same > nx ? dx / (same - nx) : 0, dy: same ? dy / same : 0, missing };
}

async function omniRender(doc: OmwDocument, page: Page, scale: number) {
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

async function pdfRender(page: any, width: number) {
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: width / vp1.width });
  const cv = document.createElement("canvas");
  cv.width = Math.round(vp.width);
  cv.height = Math.round(vp.height);
  const c = cv.getContext("2d")!;
  c.fillStyle = "#fff";
  c.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: c, viewport: vp }).promise;
  return { rgba: c.getImageData(0, 0, cv.width, cv.height).data, w: cv.width, h: cv.height };
}

async function postPair(name: string, a: { rgba: Uint8ClampedArray; w: number; h: number }, b: { rgba: Uint8ClampedArray; w: number; h: number }) {
  // PowerPoint | Omniweave | difference heat map (red = PowerPoint darker, blue = Omniweave darker, over a faint PowerPoint)
  const gap = 10, h = Math.max(a.h, b.h), Wd = a.w + gap + b.w + (a.w === b.w ? gap + a.w : 0);
  const out = new Uint8ClampedArray(Wd * h * 4).fill(255);
  for (let y = 0; y < h; y++) {
    if (y < a.h) out.set(a.rgba.subarray(y * a.w * 4, (y + 1) * a.w * 4), y * Wd * 4);
    if (y < b.h) out.set(b.rgba.subarray(y * b.w * 4, (y + 1) * b.w * 4), (y * Wd + a.w + gap) * 4);
  }
  // Omniweave's render is straight alpha over nothing: show it on white
  for (let i = 0; i < out.length; i += 4)
    if (out[i + 3] < 255) {
      const k = out[i + 3] / 255;
      out[i] = out[i] * k + 255 * (1 - k);
      out[i + 1] = out[i + 1] * k + 255 * (1 - k);
      out[i + 2] = out[i + 2] * k + 255 * (1 - k);
      out[i + 3] = 255;
    }
  if (a.w === b.w) {
    const x0 = 2 * (a.w + gap);
    for (let y = 0; y < Math.min(a.h, b.h); y++)
      for (let x = 0; x < a.w; x++) {
        const pa = (y * Wd + x) * 4, pb = (y * Wd + a.w + gap + x) * 4, q = (y * Wd + x0 + x) * 4;
        const ga = 0.299 * out[pa] + 0.587 * out[pa + 1] + 0.114 * out[pa + 2], gb = 0.299 * out[pb] + 0.587 * out[pb + 1] + 0.114 * out[pb + 2];
        const d = Math.min(255, Math.abs(ga - gb) * 3), base = 235 + ga * 0.08;
        out[q] = gb > ga ? base : base - d;
        out[q + 1] = base - d;
        out[q + 2] = gb > ga ? base - d : base;
        out[q + 3] = 255;
      }
  }
  await fetch(`/__pptx/pair?name=${encodeURIComponent(name)}`, { method: "POST", body: encodePng(out, Wd, h, 6) as BlobPart });
}

async function measure(it: { key: string; id: string; name: string; ref: string | null }) {
  const bytes = new Uint8Array(await (await fetch(`/__pptx/file?key=${encodeURIComponent(it.key)}`)).arrayBuffer());
  S().load(newDocument());
  await importFile({ name: it.name, path: null, bytes });
  if (lastImport?.error) throw new Error(lastImport.error);
  const doc = S().doc;
  // the document's fonts asked for (core/text.ts localAlias) and their local() faces loaded before anything is
  // measured — as the app re-measures on each load
  await pageFontsSettled([...doc.pages, ...doc.masters]);
  const slides: SlideScore[] = [];
  // a deck without a reference PDF (corpus): only the saves are measured
  let refPages = 0;
  if (it.ref) {
    const refBytes = new Uint8Array(await (await fetch(`/__pptx/file?key=${encodeURIComponent(it.ref)}`)).arrayBuffer());
    const pdf = await pdfjs.getDocument({ data: refBytes, isEvalSupported: false, cMapUrl: new URL("/node_modules/pdfjs-dist/cmaps/", location.href).href, cMapPacked: true, standardFontDataUrl: new URL("/node_modules/pdfjs-dist/standard_fonts/", location.href).href }).promise;
    refPages = pdf.numPages;
    // PowerPoint leaves hidden slides out of its PDF: then the shown slides are compared, each with its own number
    const shown = doc.pages.filter((p) => !p.hidden);
    const list = shown.length < doc.pages.length && pdf.numPages === shown.length ? shown : doc.pages;
    const n = Math.min(pdf.numPages, list.length);
    for (let i = 0; i < n; i++) {
      const pg = await pdf.getPage(i + 1);
      const ref = await pdfRender(pg, W);
      const page = list[i];
      const got = await omniRender(doc, page, ref.w / page.width);
      const size = fitSize(ref.w, ref.h, W);
      const r = ssim(resizeGray(toGray(ref.rgba, ref.w, ref.h), size.w, size.h), resizeGray(toGray(got.rgba, got.w, got.h), size.w, size.h));
      const rl = await refLines(pg), ol = omniLines(page);
      const lines = compareLines(rl, ol);
      const brief = (ls: Line[]) => ls.map((l) => `${l.x.toFixed(1)},${l.y.toFixed(1)},${l.size.toFixed(1)} ${l.text.slice(0, 24)}`);
      slides.push({ slide: doc.pages.indexOf(page) + 1, ssim: Math.round(r.ssim * 10000) / 10000, badShare: Math.round(r.badShare * 10000) / 10000, ...lines, dx: Math.round(lines.dx * 100) / 100, dy: Math.round(lines.dy * 100) / 100, detail: { ref: brief(rl), omni: brief(ol) } });
      await postPair(`${it.id}-${i + 1}`, ref, got);
    }
    await pdf.destroy();
  }
  // saved without changes after opening (and drawing every slide): the original bytes again?
  const same = pptxUnchanged(S().doc.pages);
  const preserved = !!same && same.length === bytes.length && same.every((b, i) => b === bytes[i]);
  // edited in one place and saved: before (written anew) and after (into the original package); the files go to
  // <out>/edits for the PowerPoint check (scripts/fidelity-pptx.mjs)
  const edits: unknown[] = [];
  if (/\.pptx$/i.test(it.name) && S().doc.pages[0]?.source?.office)
    for (const sc of SCENARIOS) {
      try {
        const r = await editTest(S().doc, bytes, sc.id);
        if (!r) {
          edits.push({ scenario: sc.id, skipped: true });
          continue;
        }
        for (const [k, b] of [["before", r.before.bytes], ["after", r.after.bytes]] as const) await fetch(`/__pptx/save?name=${encodeURIComponent(`${it.id}-${sc.id}-${k}.pptx`)}`, { method: "POST", body: b as BlobPart });
        edits.push({ scenario: sc.id, where: r.where, before: { kept: r.before.kept, diffs: r.before.diffs }, after: { kept: r.after.kept, diffs: r.after.diffs, same: r.after.same } });
      } catch (e: any) {
        edits.push({ scenario: sc.id, error: String(e?.message ?? e).slice(0, 160) });
      }
    }
  return { id: it.id, slides, pages: { ref: refPages, omni: doc.pages.length }, preserved, edits, skipped: lastImport?.warnings ?? [] };
}

async function main() {
  (window as any).alert = () => {};
  (window as any).confirm = () => true;
  try {
    await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "Pretendard"`, "가A")));
  } catch {}
  const items: { key: string; id: string; name: string; ref: string | null }[] = await (await fetch("/__pptx/list")).json();
  for (const it of items) {
    let row: any;
    // the driver hands out only the decks not measured yet (a restarted browser continues after a stuck deck)
    await fetch(`/__pptx/start?key=${encodeURIComponent(it.key)}`, { method: "POST" });
    const t0 = performance.now();
    try {
      row = await measure(it);
    } catch (e: any) {
      row = { id: it.id, error: String(e?.message ?? e).slice(0, 200), slides: [] };
    }
    row.key = it.key;
    row.ms = Math.round(performance.now() - t0);
    await fetch("/__pptx/row", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row) });
    log(`${it.id}: ${row.error ?? row.slides.map((s: SlideScore) => s.ssim).join(" ")}`);
  }
  await fetch("/__pptx/done", { method: "POST" });
}

main().catch(async (e) => {
  await fetch("/__pptx/done", { method: "POST", body: String(e?.stack ?? e) });
});
