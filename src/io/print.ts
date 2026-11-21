// Printing: page ranges, sheet layout (pages · slide handouts · photo prints), the print PDF and
// sending it to the system print dialog.
//
// The print job is a PDF built from the vector export (text stays text), re-imposed on paper
// sheets with pdf-lib Form XObjects, so the preview and the printer get exactly the same file.
// Everything above `printPdfBytes` is pure (no DOM) and covered by tests/print.

import { t } from "../i18n";
import {
  PDFDocument,
  clip,
  concatTransformationMatrix,
  drawObject,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  setLineWidth,
  setStrokingRgbColor,
  stroke,
  type PDFEmbeddedPage,
} from "pdf-lib";

export const MM = 72 / 25.4; // pt per mm
export const INCH = 72; // pt per inch

// ───────── page ranges ─────────

export type RangeResult = { ok: true; pages: number[] } | { ok: false; error: string };

/**
 * "1-3, 5" → [0, 1, 2, 4] (0-based, in the order written, duplicates dropped).
 * Accepts "," ";" or spaces between parts, "-" "~" "–" for ranges, open ends ("5-" = 5 to last,
 * "-3" = 1 to 3), descending ranges ("5-3"). Empty or a word for "all" in any UI language = every page.
 */
/** Words meaning "every page" (ko · en · zh · ja), typed into the range box. */
const ALL_PAGES = /^(all|every|모두|전체|全部|所有|全部页面|すべて|全て|全ページ)$/i; // i18n: keep (input aliases matched against what the user types, not shown text)

export function parsePageRange(input: string, total: number): RangeResult {
  const s = input.trim();
  if (total <= 0) return { ok: false, error: t("engine.print.noPages") };
  if (!s || ALL_PAGES.test(s)) return { ok: true, pages: Array.from({ length: total }, (_, i) => i) };
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (n: number) => {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  const parts = s
    .replace(/\s*([-~–])\s*/g, "$1")
    .split(/[\s,;]+/)
    .filter(Boolean);
  for (const part of parts) {
    const m = /^(\d*)[-~–](\d*)$/.exec(part);
    if (m) {
      if (!m[1] && !m[2]) return { ok: false, error: t("engine.print.badRange", { part }) };
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      if (a < 1 || b < 1 || a > total || b > total) return { ok: false, error: t("engine.print.outOfRange", { part, total }) };
      const step = a <= b ? 1 : -1;
      for (let i = a; i !== b + step; i += step) add(i - 1);
      continue;
    }
    if (!/^\d+$/.test(part)) return { ok: false, error: t("engine.print.unreadableRange", { part }) };
    const n = parseInt(part, 10);
    if (n < 1 || n > total) return { ok: false, error: t("engine.print.noSuchPage", { page: n, total }) };
    add(n - 1);
  }
  if (!out.length) return { ok: false, error: t("engine.print.noPages") };
  return { ok: true, pages: out };
}

// ───────── paper ─────────

export type PaperId = "A4" | "A3" | "A5" | "B4" | "B5" | "Letter" | "Legal" | "Photo4x6" | "Photo5x7";

/** Portrait sizes in pt. B sizes are JIS (the Korean/Japanese office standard). */
export const PAPERS: Record<PaperId, { label: string; w: number; h: number }> = {
  A4: { label: "A4 (210×297mm)", w: 210 * MM, h: 297 * MM },
  A3: { label: "A3 (297×420mm)", w: 297 * MM, h: 420 * MM },
  A5: { label: "A5 (148×210mm)", w: 148 * MM, h: 210 * MM },
  B4: { label: "B4 (257×364mm)", w: 257 * MM, h: 364 * MM },
  B5: { label: "B5 (182×257mm)", w: 182 * MM, h: 257 * MM },
  Letter: { label: "Letter (8.5×11in)", w: 8.5 * INCH, h: 11 * INCH },
  Legal: { label: "Legal (8.5×14in)", w: 8.5 * INCH, h: 14 * INCH },
  Photo4x6: { label: "사진 4×6in (10×15cm)", w: 4 * INCH, h: 6 * INCH }, // i18n: keep (fallback; shown via doc.print.paperSize.Photo4x6)
  Photo5x7: { label: "사진 5×7in (13×18cm)", w: 5 * INCH, h: 7 * INCH }, // i18n: keep (fallback; shown via doc.print.paperSize.Photo5x7)
};

export type PhotoSize = "3x5" | "4x6" | "5x7" | "A4";

/** Photo print sizes (portrait, pt). */
export const PHOTO_SIZES: Record<PhotoSize, { label: string; w: number; h: number }> = {
  "3x5": { label: "3×5in (9×13cm)", w: 3 * INCH, h: 5 * INCH },
  "4x6": { label: "4×6in (10×15cm)", w: 4 * INCH, h: 6 * INCH },
  "5x7": { label: "5×7in (13×18cm)", w: 5 * INCH, h: 7 * INCH },
  A4: { label: "A4 전체 (210×297mm)", w: 210 * MM, h: 297 * MM }, // i18n: keep (fallback; shown via doc.print.photo.A4)
};

// ───────── options & plan ─────────

export type Orientation = "auto" | "portrait" | "landscape";
export type PrintLayout = "pages" | "handout" | "photo";
export type ScaleMode = "fit" | "actual" | "custom";

export interface PrintOptions {
  copies: number;
  /** collated: 1,2,3,1,2,3 · not collated: 1,1,2,2,3,3 */
  collate: boolean;
  paper: PaperId;
  orientation: Orientation;
  layout: PrintLayout;
  /** "pages" layout */
  scale: ScaleMode;
  /** percent, "custom" scale */
  customScale: number;
  /** "handout" layout: pages per sheet */
  perSheet: 1 | 2 | 4 | 6;
  /** "photo" layout */
  photoSize: PhotoSize;
  /** photo: fill the print (crop edges) instead of fitting the whole picture */
  photoFill: boolean;
  /** sheet margin in mm */
  margin: number;
}

export const DEFAULT_PRINT: PrintOptions = {
  copies: 1,
  collate: true,
  paper: "A4",
  orientation: "auto",
  layout: "pages",
  scale: "fit",
  customScale: 100,
  perSheet: 1,
  photoSize: "4x6",
  photoFill: true,
  margin: 10,
};

export interface Size {
  w: number;
  h: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One source page placed on a sheet. Boxes are in pt from the sheet's top-left corner. */
export interface PlacedPage {
  /** index into the list of source pages handed to planPrint */
  src: number;
  /** clip rectangle (the content never leaves it) */
  box: Box;
  /** content rectangle (unrotated page = w×h, or h×w when rotated); may exceed the box (crop) */
  content: Box;
  /** 90 = page turned clockwise to match the box */
  rotate: 0 | 90;
  /** thin outline around the box (handouts) */
  frame?: boolean;
}

export interface Sheet {
  w: number;
  h: number;
  items: PlacedPage[];
}

export interface PrintPlan {
  sheets: Sheet[];
  /** sheets of one copy (before copies are applied) */
  perCopy: number;
  notes: string[];
}

function paperSize(id: PaperId, orient: "portrait" | "landscape"): Size {
  const p = PAPERS[id] ?? PAPERS.A4;
  return orient === "landscape" ? { w: Math.max(p.w, p.h), h: Math.min(p.w, p.h) } : { w: Math.min(p.w, p.h), h: Math.max(p.w, p.h) };
}

/** Largest scale at which a w×h page fits a box. */
function fitScale(page: Size, box: Size) {
  return Math.min(box.w / page.w, box.h / page.h);
}

/** Centre `page` scaled by `s` inside `box`. */
function centred(box: Box, page: Size, s: number): Box {
  const w = page.w * s, h = page.h * s;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}

/** Grid shapes (cols × rows) for n pages per sheet. */
const GRIDS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[1, 2], [2, 1]],
  4: [[2, 2]],
  6: [[2, 3], [3, 2]],
};

/** Cell rectangles for a cols×rows grid inside a printable area. */
export function gridCells(area: Box, cols: number, rows: number, gap: number): Box[] {
  const cw = (area.w - gap * (cols - 1)) / cols, ch = (area.h - gap * (rows - 1)) / rows;
  const out: Box[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: area.x + c * (cw + gap), y: area.y + r * (ch + gap), w: cw, h: ch });
  return out;
}

/** Best handout arrangement (orientation + grid) for pages of a given shape: the one that prints them largest. */
export function handoutGrid(n: 1 | 2 | 4 | 6, page: Size, paper: PaperId, orientation: Orientation, marginPt: number, gap: number) {
  const orients: ("portrait" | "landscape")[] = orientation === "auto" ? ["portrait", "landscape"] : [orientation];
  let best: { sheet: Size; cols: number; rows: number; scale: number } | null = null;
  for (const o of orients) {
    const sheet = paperSize(paper, o);
    const area = { x: marginPt, y: marginPt, w: sheet.w - marginPt * 2, h: sheet.h - marginPt * 2 };
    for (const [cols, rows] of GRIDS[n] ?? GRIDS[1]) {
      const cell = gridCells(area, cols, rows, gap)[0];
      const scale = fitScale(page, cell);
      // prefer portrait on (near) ties, the usual handout shape
      if (!best || scale > best.scale * 1.001) best = { sheet, cols, rows, scale };
    }
  }
  return best!;
}

/** Photo boxes that fit on a sheet: count and positions (centred grid). */
export function photoGrid(sheet: Size, photo: Size, marginPt: number, gap: number): Box[] {
  const aw = sheet.w - marginPt * 2, ah = sheet.h - marginPt * 2;
  const cols = Math.max(0, Math.floor((aw + gap) / (photo.w + gap)));
  const rows = Math.max(0, Math.floor((ah + gap) / (photo.h + gap)));
  const gw = cols * photo.w + (cols - 1) * gap, gh = rows * photo.h + (rows - 1) * gap;
  const x0 = (sheet.w - gw) / 2, y0 = (sheet.h - gh) / 2;
  const out: Box[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push({ x: x0 + c * (photo.w + gap), y: y0 + r * (photo.h + gap), w: photo.w, h: photo.h });
  return out;
}

const isLandscape = (s: Size) => s.w > s.h;

/**
 * Plan the print sheets for source pages of the given sizes (pt).
 * - pages:   one page per sheet; fit / actual size / custom %; "auto" orientation follows each page.
 * - handout: 1·2·4·6 pages per sheet in the grid that prints them largest, each framed.
 * - photo:   pages printed at a photo size (3×5 · 4×6 · 5×7 · A4), as many per sheet as fit,
 *            each picture turned to match the print and filled (cropped) or fitted.
 */
export function planPrint(pages: Size[], o: PrintOptions): PrintPlan {
  const notes: string[] = [];
  const margin = Math.max(0, o.margin) * MM;
  const one: Sheet[] = [];
  if (!pages.length) return { sheets: [], perCopy: 0, notes: [t("engine.print.noPages")] };

  if (o.layout === "handout") {
    const n = ([1, 2, 4, 6] as const).includes(o.perSheet) ? o.perSheet : 1;
    const gap = 18;
    const g = handoutGrid(n, pages[0], o.paper, o.orientation, margin, gap);
    const cells = gridCells({ x: margin, y: margin, w: g.sheet.w - margin * 2, h: g.sheet.h - margin * 2 }, g.cols, g.rows, gap);
    for (let i = 0; i < pages.length; i += n) {
      const items: PlacedPage[] = [];
      for (let k = 0; k < n && i + k < pages.length; k++) {
        const pg = pages[i + k];
        const content = centred(cells[k], pg, fitScale(pg, cells[k]));
        items.push({ src: i + k, box: content, content, rotate: 0, frame: true });
      }
      one.push({ w: g.sheet.w, h: g.sheet.h, items });
    }
  } else if (o.layout === "photo") {
    const ps = PHOTO_SIZES[o.photoSize] ?? PHOTO_SIZES["4x6"];
    const full = o.photoSize === "A4";
    const m = full ? 0 : margin;
    const gap = full ? 0 : 4 * MM;
    // pick the sheet orientation × photo orientation that fits the most prints
    let best: { sheet: Size; photo: Size; boxes: Box[] } | null = null;
    for (const so of o.orientation === "auto" ? (["portrait", "landscape"] as const) : [o.orientation]) {
      const sheet = full ? paperSize("A4", so) : paperSize(o.paper, so);
      for (const photo of [{ w: ps.w, h: ps.h }, { w: ps.h, h: ps.w }]) {
        const boxes = photoGrid(sheet, photo, m, gap);
        if (!best || boxes.length > best.boxes.length) best = { sheet, photo, boxes };
      }
    }
    let { sheet, boxes } = best!;
    if (!boxes.length) {
      // photo bigger than the paper: shrink it to the printable area
      sheet = paperSize(o.paper, isLandscape(ps) ? "landscape" : "portrait");
      const area = { x: m, y: m, w: sheet.w - m * 2, h: sheet.h - m * 2 };
      boxes = [centred(area, ps, fitScale(ps, area))];
      notes.push(
        t("engine.print.photoShrunk", {
          photo: t(`doc.print.photo.${o.photoSize}`, undefined, ps.label),
          paper: t(`doc.print.paperSize.${o.paper}`, undefined, PAPERS[o.paper].label),
        }),
      );
    }
    for (let i = 0; i < pages.length; i += boxes.length) {
      const items: PlacedPage[] = [];
      for (let k = 0; k < boxes.length && i + k < pages.length; k++) {
        const pg = pages[i + k];
        const box = boxes[k];
        // turn the picture when its orientation differs from the print's (squares never turn)
        const rotate: 0 | 90 = pg.w !== pg.h && isLandscape(pg) !== isLandscape(box) ? 90 : 0;
        const shown = rotate ? { w: pg.h, h: pg.w } : pg;
        const s = o.photoFill ? Math.max(box.w / shown.w, box.h / shown.h) : fitScale(shown, box);
        items.push({ src: i + k, box, content: centred(box, shown, s), rotate });
      }
      one.push({ w: sheet.w, h: sheet.h, items });
    }
  } else {
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      const orient = o.orientation === "auto" ? (isLandscape(pg) ? "landscape" : "portrait") : o.orientation;
      const sheet = paperSize(o.paper, orient);
      const area: Box = { x: margin, y: margin, w: sheet.w - margin * 2, h: sheet.h - margin * 2 };
      const s = o.scale === "fit" ? fitScale(pg, area) : o.scale === "custom" ? Math.max(0.01, o.customScale / 100) : 1;
      const content = centred(area, pg, s);
      if (o.scale !== "fit" && (content.w > area.w + 0.5 || content.h > area.h + 0.5) && !notes.length) notes.push(t("engine.print.edgesClipped"));
      one.push({ w: sheet.w, h: sheet.h, items: [{ src: i, box: area, content, rotate: 0 }] });
    }
  }

  const copies = Math.max(1, Math.min(999, Math.floor(o.copies) || 1));
  const sheets: Sheet[] = [];
  if (o.collate) for (let c = 0; c < copies; c++) sheets.push(...one);
  else for (const s of one) for (let c = 0; c < copies; c++) sheets.push(s);
  return { sheets, perCopy: one.length, notes };
}

// ───────── print PDF ─────────

/**
 * Impose the pages of `source` (one PDF page per source page, in planPrint order) on the planned
 * sheets. Each source page is embedded once as a Form XObject, so text stays selectable and
 * copies cost nothing.
 */
export async function composePrintPdf(source: Uint8Array, plan: PrintPlan, title = "Omniweave"): Promise<Uint8Array> {
  const src = await PDFDocument.load(source, { updateMetadata: false });
  const out = await PDFDocument.create();
  out.setTitle(title);
  out.setCreator("Omniweave");
  out.setProducer("Omniweave (print)");
  const used = [...new Set(plan.sheets.flatMap((s) => s.items.map((it) => it.src)))].filter((i) => i < src.getPageCount());
  const embedded = new Map<number, PDFEmbeddedPage>();
  const emb = await out.embedPages(used.map((i) => src.getPage(i)));
  used.forEach((i, k) => embedded.set(i, emb[k]));
  for (const sheet of plan.sheets) {
    const page = out.addPage([sheet.w, sheet.h]);
    const H = sheet.h;
    for (const it of sheet.items) {
      const e = embedded.get(it.src);
      if (!e) continue;
      const name = page.node.newXObject("P", e.ref);
      const b = it.box, c = it.content;
      // y-up PDF coordinates of the clip box and the content rectangle
      const ops = [pushGraphicsState(), rectangle(b.x, H - b.y - b.h, b.w, b.h), clip(), endPath()];
      if (it.rotate === 90) {
        // turn clockwise: the form's (0,0)-(w,h) lands in the content box (h×w)
        const sx = c.w / e.height, sy = c.h / e.width;
        ops.push(concatTransformationMatrix(0, -sy, sx, 0, c.x, H - c.y));
      } else {
        ops.push(concatTransformationMatrix(c.w / e.width, 0, 0, c.h / e.height, c.x, H - c.y - c.h));
      }
      ops.push(drawObject(name), popGraphicsState());
      if (it.frame) ops.push(pushGraphicsState(), setStrokingRgbColor(0.6, 0.6, 0.6), setLineWidth(0.5), rectangle(b.x, H - b.y - b.h, b.w, b.h), stroke(), popGraphicsState());
      page.pushOperators(...ops);
    }
  }
  return out.save();
}

// ───────── sending to the printer (browser / WebView2) ─────────

let frame: HTMLIFrameElement | null = null;
let frameUrl: string | null = null;

function cleanup() {
  frame?.remove();
  frame = null;
  if (frameUrl) URL.revokeObjectURL(frameUrl);
  frameUrl = null;
}

/**
 * Open the system print dialog for a PDF: the PDF is loaded into a hidden same-origin iframe
 * (blob URL) and the built-in PDF viewer (Chromium / WebView2) prints it.
 * Resolves once the dialog has been asked for; rejects when the engine cannot print PDFs inline.
 */
export function printPdfBytes(bytes: Uint8Array): Promise<void> {
  cleanup();
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  frameUrl = url;
  const f = document.createElement("iframe");
  frame = f;
  f.setAttribute("aria-hidden", "true");
  f.title = t("doc.print.title");
  // must stay rendered (display:none frames do not print) but out of sight
  f.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;";
  return new Promise<void>((resolve, reject) => {
    const fail = (e: unknown) => {
      cleanup();
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    const timer = setTimeout(() => fail(new Error(t("engine.print.frameNotReady"))), 20000);
    f.onload = () => {
      // the PDF viewer finishes its own setup after the frame's load event
      setTimeout(() => {
        clearTimeout(timer);
        try {
          const w = f.contentWindow;
          if (!w) throw new Error(t("engine.print.frameOpenFailed"));
          w.focus();
          w.print();
          resolve();
          // keep the frame until the dialog is long gone (removing it cancels a running job)
          setTimeout(() => frame === f && cleanup(), 10 * 60 * 1000);
        } catch (e) {
          fail(e);
        }
      }, 400);
    };
    f.src = url;
    document.body.appendChild(f);
  });
}

/** Fallback: show the PDF in a new window/tab where the person prints it with the viewer's own button. */
export function openPdfForPrinting(bytes: Uint8Array): boolean {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
  const w = window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 10 * 60 * 1000);
  return !!w;
}
