// OCR — whole page: deskew → detect lines → recognize each line → layout (tables, check boxes, paragraphs).
// Pure engine code (no DOM): runs in the image worker and in tests. Models are passed in (see ./models.ts).

import { cropImg, downscale, type Img } from "../pixels";
import type { GraphModel, Tensor } from "../infer/graph";
import { deskew, grey, sauvola } from "./preprocess";
import { detectText, detectTextWith, type Box, type DetBox, type DetOptions, type DetResult } from "./detect";
import { recognizeLine, type LineText, type OcrChar, type RecOptions } from "./recognize";
import { EM_PER_CORE, findCheckBoxes, findTables, groupLines, ruling, strokeWidth, type Block, type CheckBox, type LayoutLine, type TableGrid } from "./layout";

export interface OcrLine extends LayoutLine {
  chars: OcrChar[];
  /** [table index, cell index] when the line sits in a table cell */
  cell?: [number, number];
}

export interface OcrTable extends TableGrid {
  /** text per cell (same order as cells) */
  text: string[];
  conf: number[];
}

export interface OcrPage {
  width: number;
  height: number;
  /** skew corrected, degrees (the page image below is already straightened: rotateImg by this angle about its centre;
   *  0 when it was not rotated) */
  angle: number;
  image: Img;
  lines: OcrLine[];
  tables: OcrTable[];
  checks: CheckBox[];
  /** free text (outside tables) grouped into blocks / paragraphs */
  blocks: Block[];
  /** text area: min left / max right of all lines (alignment of single lines) */
  area: Box;
  ms: { deskew: number; det: number; rec: number; layout: number; total: number };
}

export interface OcrOptions extends DetOptions {
  deskew?: boolean;
  /** geometric space restoration (default on) */
  spaces?: boolean;
  /** space threshold in em (default 0.3) */
  spaceFactor?: number;
  /** minimum recognizer input width (reference 320; less = faster on short lines) */
  minWidth?: number;
  onProgress?: (done: number, total: number) => void;
  /** image worker only: use WebGPU where it works (default true) */
  gpu?: boolean;
  /** image worker only: recognition workers (default from the core count and memory, recPool.ts poolSize) */
  workers?: number;
}

const CHECK_ON = "☑", CHECK_OFF = "☐";

/**
 * Longest side the engine works on. Larger pictures (phone photos, 600 dpi scans) are reduced first: detection reads
 * ≤ 1536 px anyway and recognition rescales every line to 48 px, while the full-size planes (Sauvola integrals at
 * 16 bytes a pixel, the straightened copy) would need gigabytes in the worker. 4096 px keeps an A4 page at ≈ 350 dpi.
 * The result's width / height are those of the reduced page; callers map back by the ratio to their source.
 */
export const OCR_MAX_SIDE = 4096;

/** The picture the engine reads (the source, or a reduced copy when it is larger than OCR_MAX_SIDE). */
export function ocrWorkImage(src: Img): Img {
  return downscale(src, OCR_MAX_SIDE).img;
}

/** One text line to recognize: its crop and options (plain data, so it can go to another worker). */
export interface RecTask {
  crop: Img;
  opts: RecOptions;
}

/**
 * Recognizes line crops (results in task order; `done` after each line). The default runs them one by one on this
 * thread; the image worker passes a pool of recognition workers (ocr/recPool.ts) — lines are independent and the
 * same code runs in every worker, so the result is the same either way.
 */
export type LineRecognizer = (tasks: RecTask[], done: () => void) => Promise<LineText[]>;

interface Detected {
  img: Img;
  angle: number;
  boxes: DetBox[];
  tasks: RecTask[];
  ms: OcrPage["ms"];
  t0: number;
}

/** Network runner for the detector or recognizer elsewhere (WebGPU: infer/graphGpu.ts); default runGraph here. */
export type NetRun = (x: Tensor) => Promise<Tensor>;

function straighten(src0: Img, o: OcrOptions) {
  const t0 = performance.now();
  const ms = { deskew: 0, det: 0, rec: 0, layout: 0, total: 0 };
  const src = ocrWorkImage(src0);
  const { img, angle } = o.deskew === false ? { img: src, angle: 0 } : deskew(src);
  ms.deskew = performance.now() - t0;
  return { img, angle, ms, t0, t: performance.now() };
}

function detectStage(det: GraphModel, src0: Img, o: OcrOptions): Detected {
  const s = straighten(src0, o);
  return lineTasks(s, detectText(det, s.img, o), o);
}

function lineTasks({ img, angle, ms, t0, t }: ReturnType<typeof straighten>, dres: DetResult, o: OcrOptions): Detected {
  ms.det = performance.now() - t;
  const boxes = dres.boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  const tasks = boxes.map((b) => {
    const pad = Math.round(b.h * 0.08);
    const crop = cropImg(img, b.x - pad, b.y - pad, b.w + 2 * pad, b.h + 2 * pad);
    return { crop, opts: { spaces: o.spaces, em: b.core.h * EM_PER_CORE, spaceFactor: o.spaceFactor, minWidth: o.minWidth } };
  });
  return { img, angle, boxes, tasks, ms, t0 };
}

/** The whole page on this thread (tests, evaluation, engines without workers). */
export function ocrPage(det: GraphModel, rec: GraphModel, src0: Img, o: OcrOptions = {}): OcrPage {
  const d = detectStage(det, src0, o);
  const t = performance.now();
  const texts = d.tasks.map((k, i) => {
    const r = recognizeLine(rec, k.crop, k.opts);
    o.onProgress?.(i + 1, d.tasks.length);
    return r;
  });
  d.ms.rec = performance.now() - t;
  return layoutStage(d, texts);
}

/** Same result as ocrPage, with the line recognition handed to `lines` (a worker pool, WebGPU) and the detector
 *  optionally run by `detRun`. */
export async function ocrPageWith(det: GraphModel, lines: LineRecognizer, src0: Img, o: OcrOptions = {}, detRun?: NetRun): Promise<OcrPage> {
  const s = straighten(src0, o);
  const d = lineTasks(s, detRun ? await detectTextWith(detRun, det, s.img, o) : detectText(det, s.img, o), o);
  const t = performance.now();
  let n = 0;
  const texts = await lines(d.tasks, () => o.onProgress?.(++n, d.tasks.length));
  d.ms.rec = performance.now() - t;
  return layoutStage(d, texts);
}

function layoutStage(d: Detected, texts: LineText[]): OcrPage {
  const { img, angle, boxes, ms } = d;
  let t = performance.now();
  const ink = sauvola(grey(img), img.width, img.height);
  const lines: OcrLine[] = [];
  boxes.forEach((b, i) => {
    const r = texts[i];
    if (!r.text) return;
    const pad = Math.round(b.h * 0.08);
    const ox = Math.max(0, Math.floor(b.x - pad));
    lines.push({ box: { x: b.x, y: b.y, w: b.w, h: b.h }, core: b.core, text: r.text, conf: r.conf, chars: r.chars.map((c) => ({ ...c, x0: c.x0 + ox, x1: c.x1 + ox })), stroke: strokeWidth(ink, img.width, b.core) });
  });
  ms.rec += performance.now() - t;
  t = performance.now();

  // ruling lines → tables and check boxes
  const hs = lines.map((l) => l.core.h).sort((a, b) => a - b);
  const textH = hs.length ? hs[Math.floor(hs.length / 2)] : 20;
  const segs = ruling(ink, img.width, img.height, Math.max(14, Math.round(textH * 0.7)));
  const longH = segs.h.filter((s) => s.b - s.a >= textH * 3), longV = segs.v.filter((s) => s.b - s.a >= textH * 1.5);
  const grids = findTables(longH, longV);
  // a real check box is about as tall as its label; a closed stroke inside a large glyph (ㅁ of a bold title) is
  // much smaller than the line it sits in
  const checks = findCheckBoxes(ink, img.width, segs.h, segs.v, textH * 0.7, textH * 2.2, grids).filter((c) => {
    const cx = c.box.x + c.box.w / 2, cy = c.box.y + c.box.h / 2;
    const host = lines.find((l) => cx > l.box.x && cx < l.box.x + l.box.w && cy > l.box.y && cy < l.box.y + l.box.h && l.box.x < c.box.x - c.box.w * 0.5);
    return !host || c.box.h >= 0.45 * host.box.h;
  });

  // check boxes: drop what the recognizer made of the box glyph and put ☐ / ☑ at the box's place in its line
  for (const c of checks) {
    const cy = c.box.y + c.box.h / 2, cx1 = c.box.x + c.box.w;
    const l = lines
      .filter((l) => cy > l.box.y && cy < l.box.y + l.box.h && l.box.x + l.box.w > c.box.x && l.box.x < cx1 + 3 * textH)
      .sort((a, b) => Math.abs(a.box.x - c.box.x) - Math.abs(b.box.x - c.box.x))[0];
    const mark: OcrChar = { ch: c.checked ? CHECK_ON : CHECK_OFF, p: 1, x0: c.box.x, x1: cx1 };
    if (!l) {
      lines.push({ box: c.box, core: c.box, text: mark.ch, conf: 1, chars: [mark], stroke: 0 });
      continue;
    }
    const keep = l.chars.filter((ch) => (ch.x0 + ch.x1) / 2 < c.box.x - 2 || (ch.x0 + ch.x1) / 2 > cx1 + 2);
    const before = keep.filter((ch) => ch.x1 <= cx1), after = keep.filter((ch) => ch.x1 > cx1);
    while (after[0]?.ch === " ") after.shift();
    while (before.length && before[before.length - 1].ch === " ") before.pop();
    const sp = (x: number): OcrChar => ({ ch: " ", p: 1, x0: x, x1: x });
    l.chars = [...before, ...(before.length ? [sp(c.box.x)] : []), mark, ...(after.length ? [sp(cx1)] : []), ...after];
    l.text = l.chars.map((ch) => ch.ch).join("");
    const x1 = l.box.x + l.box.w;
    l.box = { ...l.box, x: Math.min(l.box.x, c.box.x), w: x1 - Math.min(l.box.x, c.box.x) };
  }

  // lines → table cells
  const tables: OcrTable[] = grids.map((g) => ({ ...g, text: g.cells.map(() => ""), conf: g.cells.map(() => 1) }));
  tables.forEach((tb, ti) => {
    const inCell = tb.cells.map(() => [] as OcrLine[]);
    for (const l of lines) {
      const cx = l.box.x + l.box.w / 2, cy = l.box.y + l.box.h / 2;
      const ci = tb.cells.findIndex((c) => cx >= c.box.x && cx <= c.box.x + c.box.w && cy >= c.box.y && cy <= c.box.y + c.box.h);
      if (ci >= 0) {
        l.cell = [ti, ci];
        inCell[ci].push(l);
      }
    }
    inCell.forEach((ls, ci) => {
      ls.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
      let s = "";
      ls.forEach((l, k) => {
        if (k) s += Math.abs(l.box.y - ls[k - 1].box.y) < l.box.h * 0.5 ? " " : "\n";
        s += l.text;
      });
      tb.text[ci] = s;
      tb.conf[ci] = ls.length ? Math.min(...ls.map((l) => l.conf)) : 1;
    });
  });

  const free = lines.filter((l) => !l.cell);
  const strokes = free.map((l) => l.stroke).filter((v) => v > 0).sort((a, b) => a - b);
  const blocks = groupLines(free, strokes.length ? strokes[Math.floor(strokes.length / 2)] : 0);
  const ax0 = Math.min(...lines.map((l) => l.box.x), ...tables.map((t) => t.box.x)), ax1 = Math.max(...lines.map((l) => l.box.x + l.box.w), ...tables.map((t) => t.box.x + t.box.w));
  const area = lines.length ? { x: ax0, y: 0, w: ax1 - ax0, h: img.height } : { x: 0, y: 0, w: img.width, h: img.height };
  // single-line paragraphs: alignment against the text area
  for (const b of blocks)
    for (const p of b.paragraphs) {
      if (p.lines.length !== 1) continue;
      const l = p.lines[0], h = l.core.h;
      const cOff = Math.abs(l.box.x + l.box.w / 2 - (area.x + area.w / 2));
      if (cOff < Math.max(6, h * 0.8) && l.box.x - area.x > 2 * h) p.align = "CENTER";
      else if (area.x + area.w - (l.box.x + l.box.w) < h * 0.8 && l.box.x - area.x > area.w * 0.3) p.align = "RIGHT";
    }
  ms.layout = performance.now() - t;
  ms.total = performance.now() - d.t0;
  return { width: img.width, height: img.height, angle, image: img, lines, tables, checks, blocks, area, ms };
}

/** Plain text of a page in reading order (tables row by row, cells separated by tabs). */
export function pageText(p: OcrPage): string {
  type Item = { y: number; x: number; s: string };
  const items: Item[] = [];
  for (const b of p.blocks) items.push({ y: b.box.y, x: b.box.x, s: b.paragraphs.map((q) => q.lines.map((l) => l.text).join("\n")).join("\n") });
  for (const t of p.tables) {
    const R = t.ys.length - 1;
    const rows: string[] = [];
    for (let r = 0; r < R; r++)
      rows.push(
        t.cells
          .map((c, i) => ({ c, i }))
          .filter(({ c }) => c.r === r)
          .sort((a, b) => a.c.c - b.c.c)
          .map(({ i }) => t.text[i].replace(/\n/g, " "))
          .join("\t"),
      );
    items.push({ y: t.box.y, x: t.box.x, s: rows.join("\n") });
  }
  return items
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((i) => i.s)
    .join("\n");
}
