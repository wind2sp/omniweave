// 한글 fidelity score (docs/design/FIDELITY_HWP.md): every HWPX / HWP that 한글 made is opened the way the app opens it
// (format registry) and scored against 한글's own output:
//   - open: the file opens through the HWPX / HWP importer (not the text-only fallback)
//   - lines (lineseg): paragraphs whose line breaks equal the lines 한글 saved (compareLayout, "engine" = our own line
//     breaking, "screen" = what is drawn: 한글's saved lines while a paragraph is unedited), |Δ line height|
//   - lines (PDF): body lines we draw whose text is a line of 한글's PDF on the same page
//   - pages: page count against the PDF, and pages whose first and last body text are on the same PDF page
// Normal `npm test` runs it with the built-in measurer (structure checks only). OMW_LAYOUT_FONTS=1 measures with the
// fonts installed on this PC and prints the score rows; OMW_FID_ENGINE=1 drops 한글's saved lines (our breaking only).
// OMW_TEST_CORPUS (default test-corpus/) adds local files: measured only, printed as "corpus #n".

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { parseHwpx } from "../../src/io/office";
import { formatForExt } from "../../src/io/formats";
import { hwp5ToHwpx } from "../../src/io/formats/hwp5";
import { layoutText, setMeasure } from "../../src/core/text";
import { tableCells } from "../../src/core/table";
import { readHwpxTruth } from "../../src/core/layoutcheck/hwpxLineseg";
import { compareLayout } from "../../src/core/layoutcheck/compare";
import type { Page, TableNode, TextNode, TextParagraph } from "../../src/core/types";
import { isInstalled, nodeMeasure } from "./nodeFonts";

const ROOT = process.cwd();
const FONTS = process.env.OMW_LAYOUT_FONTS === "1";
const ENGINE = process.env.OMW_FID_ENGINE === "1";
const HM = join(ROOT, "qa/interop/hancom-made"), AM = join(ROOT, "qa/interop/adobe-made");
const CORPUS = join(process.env.OMW_TEST_CORPUS ?? join(ROOT, "test-corpus"), "hwpx");

interface Sample {
  label: string;
  file: string;
  pdf?: string;
}
const samples: Sample[] = [
  ...(existsSync(HM) ? readdirSync(HM).filter((f) => /\.hwpx$/i.test(f)).sort().map((f) => ({ label: f, file: join(HM, f), pdf: join(HM, f.replace(/\.hwpx$/i, ".pdf")) })) : []),
  { label: "hwpx_doc.hwpx", file: join(AM, "hwpx_doc.hwpx"), pdf: join(AM, "hwpx_doc.hwpx.ref.pdf") },
  { label: "hwp_doc.hwp", file: join(AM, "hwp_doc.hwp"), pdf: join(AM, "hwp_doc.hwp.ref.pdf") },
  ...(existsSync(CORPUS) ? readdirSync(CORPUS).filter((f) => /\.hwpx?$/i.test(f)).sort().map((f, n) => ({ label: `corpus #${n + 1} (${/\.hwp$/i.test(f) ? "HWP" : "HWPX"})`, file: join(CORPUS, f) })) : []),
].filter((s) => existsSync(s.file));

const norm = (s: string) => s.replace(/\s+/g, "");

/**
 * Text lines of every PDF page (items on one baseline joined left to right), whitespace removed. `memos`: the document
 * has 한글 memos, which 한글 prints in a column right of the (scaled-down) page — that column (from the leftmost row
 * that starts in the right half of the page) is taken out of the body lines and returned per page as `memo` text.
 */
async function pdfLines(bytes: Uint8Array, memos = false): Promise<{ body: string[][]; memo: string[] }> {
  const p: any = await import("pdfjs-dist");
  const doc = await p.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const out: string[][] = [];
  const memo: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const pg = await doc.getPage(i);
    let items = (await pg.getTextContent()).items.filter((x: any) => typeof x.str === "string" && x.str.trim()) as { str: string; transform: number[] }[];
    let memoText = "";
    if (memos) {
      const half = pg.getViewport({ scale: 1 }).width / 2;
      const starts = new Map<number, number>();
      for (const it of items) {
        const y = Math.round(it.transform[5]);
        starts.set(y, Math.min(starts.get(y) ?? Infinity, it.transform[4]));
      }
      const col = Math.min(...[...starts.values()].filter((x) => x > half));
      if (Number.isFinite(col)) {
        const inCol = (it: { transform: number[] }) => it.transform[4] >= col - 1;
        memoText = norm(items.filter(inCol).sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]).map((it) => it.str).join(""));
        items = items.filter((it) => !inCol(it));
      }
    }
    memo.push(memoText);
    const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
    for (const it of items) {
      const y = it.transform[5], x = it.transform[4];
      const row = rows.find((r) => Math.abs(r.y - y) < 2);
      if (row) row.parts.push({ x, s: it.str });
      else rows.push({ y, parts: [{ x, s: it.str }] });
    }
    out.push(rows.sort((a, b) => b.y - a.y).map((r) => norm(r.parts.sort((a, b) => a.x - b.x).map((q) => q.s).join(""))));
  }
  return { body: out, memo };
}

const strip = (ps: TextParagraph[]) => ps.map(({ hwpLines: _x, ...p }) => p);

/**
 * Body lines of a page (text nodes as laid out; table cells as their text lines), whitespace removed. `text` is the
 * page's text in the order the PDF's is read: every line (body and table cell lines) by its baseline, the pieces on
 * one baseline left to right — so a table row whose cells are set at different heights (세로 가운데) reads as 한글's
 * PDF does, not cell by cell.
 */
function pageLines(pg: Page): { lines: string[]; text: string } {
  const lines: string[] = [];
  const items: { y: number; x: number; s: string }[] = [];
  const addLines = (t: TextNode, x0: number, y0: number) => {
    for (const l of layoutText(t).lines) items.push({ y: y0 + l.y + l.baseline, x: x0 + (l.pieces[0]?.x ?? 0), s: norm(l.pieces.map((p) => p.text).join("")) });
  };
  for (const n of [...pg.nodes].sort((a, b) => a.transform.y - b.transform.y)) {
    if (n.type === "TEXT") {
      const t = n as TextNode;
      const shown = ENGINE ? { ...t, paragraphs: strip(t.paragraphs) } : t;
      const lay = layoutText(shown);
      for (const l of lay.lines) {
        // raised / lowered pieces (superscript note marks) on their own baseline, as the PDF has them
        const main = norm(l.pieces.filter((p) => !p.dy).map((p) => p.text).join(""));
        const off = norm(l.pieces.filter((p) => p.dy).map((p) => p.text).join(""));
        if (off) lines.push(off);
        if (main) lines.push(main);
      }
      addLines(shown, n.transform.x, n.transform.y);
    } else if (n.type === "TABLE")
      for (const c of tableCells(n as TableNode)) {
        if (c.rich) addLines(c.rich.node, n.transform.x + c.rich.x, n.transform.y + c.rich.y);
        else if (c.cell.text) items.push({ y: n.transform.y + c.rect.y + c.rect.h / 2, x: n.transform.x + c.rect.x, s: norm(c.cell.text) });
      }
  }
  // (one baseline: within 2.5 px, as pdfLines joins the PDF's items within 2 pt)
  items.sort((a, b) => a.y - b.y);
  const rows: (typeof items)[] = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row[0].y - it.y) < 2.5) row.push(it);
    else rows.push([it]);
  }
  const text = rows.map((r) => r.sort((a, b) => a.x - b.x).map((q) => q.s).join("")).join("");
  return { lines, text };
}

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
  if (FONTS) setMeasure(nodeMeasure());
});

describe("한글 fidelity score", () => {
  for (const s of samples)
    it(s.label, async () => {
      const bytes = new Uint8Array(readFileSync(s.file));
      const isHwp = /\.hwp$/i.test(s.file);
      const fmt = formatForExt(isHwp ? "hwp" : "hwpx")!;
      const r = await fmt.open({ name: isHwp ? "x.hwp" : "x.hwpx", path: null, bytes }, {} as any);
      const pages = (r.pages ?? []) as Page[];
      expect(pages.length).toBeGreaterThan(0);
      // the HWP path must come through the HWPX importer (sections, formats), not the text-only fallback
      const opened = pages.every((p) => p.source?.format === "hwpx");
      // lineseg score
      const hwpx = isHwp ? hwp5ToHwpx(bytes) : bytes;
      const rep = compareLayout(readHwpxTruth(hwpx), parseHwpx(hwpx), { fontAvailable: FONTS ? isInstalled : () => false, fit: false, ablations: false });
      expect(rep.skipped.unmapped ?? 0).toBe(0);
      const eng = rep.configs.find((c) => c.name === "baseline")!.metrics;
      const scr = rep.configs.find((c) => c.name === "screen")?.metrics ?? eng;
      // PDF score
      let pdfRow = "", pdfMemo = "";
      if (s.pdf && existsSync(s.pdf)) {
        // (한글 memos: their column of the PDF is not body text — Omniweave shows them in the review panel — and each
        // memo's text is looked for there)
        const memos = pages.flatMap((pg) => pg.comments ?? []);
        const { body: pdf, memo } = await pdfLines(new Uint8Array(readFileSync(s.pdf)), memos.length > 0);
        if (memos.length) {
          const col = memo.join("");
          pdfMemo = ` | memos ${memos.filter((c) => c.text && col.includes(norm(c.text))).length}/${memos.length} in 한글's memo column`;
        }
        let lines = 0, hit = 0, pass = 0;
        pages.forEach((pg, k) => {
          const ours = pageLines(pg);
          const set = new Set(pdf[k] ?? []);
          lines += ours.lines.length;
          hit += ours.lines.filter((l) => set.has(l)).length;
          if (process.env.OMW_FID_DEBUG === s.label) console.log(`PAGE ${k + 1}\n  ours: ${ours.lines.join("\n        ")}\n  pdf:  ${(pdf[k] ?? []).join("\n        ")}`);
          const all = (pdf[k] ?? []).join("");
          const head = ours.text.slice(0, 12), tail = ours.text.slice(-12);
          if (ours.text && all.includes(head) && all.includes(tail)) pass++;
          else if (!ours.text && !all) pass++;
        });
        pdfRow = ` | PDF lines ${lines ? Math.round((hit / lines) * 1000) / 10 : 0}% (${hit}/${lines}) | pages ${pages.length}/${pdf.length} pass ${pass}/${pdf.length}${pdfMemo}`;
      }
      if (FONTS)
        console.log(
          `FID ${s.label}${ENGINE ? " [engine]" : ""}${opened ? "" : " [text-only open]"}: lineseg engine ${eng.identicalPct}% (${eng.identical}/${eng.compared}) multi ${eng.multi.identical}/${eng.multi.n} | screen ${scr.identicalPct}% (${scr.identical}/${scr.compared}) multi ${scr.multi.identical}/${scr.multi.n} |Δlh| ${scr.lineHeight.meanAbsPx}px | est. pages ${scr.pages.ours}/${scr.pages.truth}${pdfRow}`,
        );
      expect(opened).toBe(true);
    }, 600000);
});
