// Page setup (쪽 설정): paper size, orientation and margins of document pages, and how pages group into sections.
//
// A page is a canvas of its own size (Page.width / height); the setup adds its margins (Page.margins, omitted =
// DEFAULT_MARGINS) and how it begins (Page.breakBefore: page break, continued flow, or a section break). The
// word-processor writers (io/office.ts, io/officesurgeon/*) turn runs of pages into sections: a section starts at the
// first page, at every "section" page, and wherever the paper or the margins change (DOCX and HWPX can only change
// them at a section break). Pure functions: they work on plain pages and on immer drafts alike.

import { layoutTable } from "./table";
import { layoutText } from "./text";
import type { Page, PageColumns, PageMargins, SceneNode, TextNode, TextParagraph } from "./types";

/** px per mm at 96 dpi */
export const PX_PER_MM = 96 / 25.4;

/**
 * Margins every document page had before they were stored (2 cm ≈ 76 px around the body; header / footer 1 cm,
 * the distances the DOCX writer always used). A page without `margins` uses these, so nothing moves in old files.
 */
export const DEFAULT_MARGINS: Readonly<PageMargins> = Object.freeze({ top: 76, right: 76, bottom: 76, left: 76, header: 37.8, footer: 37.8 });

export const marginsOf = (p: Pick<Page, "margins">): PageMargins => p.margins ?? { ...DEFAULT_MARGINS };

/** The body area of a page (inside its margins), page px. */
export function bodyBox(p: Pick<Page, "width" | "height" | "margins">): { x: number; y: number; w: number; h: number } {
  const m = marginsOf(p);
  return { x: m.left, y: m.top, w: Math.max(16, p.width - m.left - m.right), h: Math.max(16, p.height - m.top - m.bottom) };
}

export interface PageSetup {
  width: number;
  height: number;
  margins: PageMargins;
  /** 단 (columns); omitted = one column */
  columns?: PageColumns;
}

export const setupOf = (p: Pick<Page, "width" | "height" | "margins"> & { columns?: PageColumns }): PageSetup => ({ width: p.width, height: p.height, margins: marginsOf(p), ...(p.columns && p.columns.n > 1 ? { columns: p.columns } : {}) });

/** Word's default gap between columns: 1.27 cm (w:space 720 twips) */
export const DEFAULT_COL_GAP = 48;

/** The columns of a body box (x, width each), left to right: one column without `cols` (or with one). */
export function columnBoxes(box: { x: number; w: number }, cols: PageColumns | undefined): { x: number; w: number }[] {
  const n = Math.max(1, Math.min(16, Math.round(cols?.n ?? 1)));
  if (n === 1 || !cols) return [{ x: box.x, w: box.w }];
  // the columns' own widths (Word w:col / 한글 colSz) scaled into the body when they do not add up to it
  if (cols.widths && cols.widths.length === n) {
    const gaps = Array.from({ length: n - 1 }, (_, i) => Math.max(0, cols.gaps?.[i] ?? cols.gap));
    const sum = cols.widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
    const k = sum > 0 ? box.w / sum : 1;
    const out: { x: number; w: number }[] = [];
    let x = box.x;
    for (let i = 0; i < n; i++) {
      const w = Math.max(16, cols.widths[i] * k);
      out.push({ x, w });
      x += w + (gaps[i] ?? 0) * k;
    }
    return out;
  }
  const gap = Math.max(0, Math.min(cols.gap, (box.w - 16 * n) / (n - 1)));
  const w = (box.w - gap * (n - 1)) / n;
  return Array.from({ length: n }, (_, i) => ({ x: box.x + i * (w + gap), w }));
}

const colsKey = (c: PageColumns | undefined) => (c && c.n > 1 ? JSON.stringify([c.n, Math.round(c.gap), c.widths?.map(Math.round) ?? null, c.gaps?.map(Math.round) ?? null, !!c.line]) : "1");
export const sameColumns = (a: PageColumns | undefined, b: PageColumns | undefined) => colsKey(a) === colsKey(b);

const near = (a: number, b: number, tol = 0.5) => Math.abs(a - b) <= tol;
export const sameMargins = (a: PageMargins, b: PageMargins) => (["top", "right", "bottom", "left", "header", "footer"] as const).every((k) => near(a[k], b[k]));
export const sameSetup = (a: PageSetup, b: PageSetup) => near(a.width, b.width) && near(a.height, b.height) && sameMargins(a.margins, b.margins) && sameColumns(a.columns, b.columns);

/** Margins as stored: undefined when they equal the defaults (old files keep no field). */
export const storedMargins = (m: PageMargins): PageMargins | undefined => (sameMargins(m, DEFAULT_MARGINS) ? undefined : { ...m });

// ───────── paper sizes ─────────

/** Paper presets of the page setup dialog (ISO A3/A4, JIS B5 as in 한글's "B5 (46배판)", US Letter / Legal), mm portrait. */
export const PAPERS = [
  { id: "A4", w: 210, h: 297 },
  { id: "A3", w: 297, h: 420 },
  { id: "B5", w: 182, h: 257 },
  { id: "Letter", w: 215.9, h: 279.4 },
  { id: "Legal", w: 215.9, h: 355.6 },
] as const;
export type PaperId = (typeof PAPERS)[number]["id"];

/** A paper's size in px, portrait (A4 → 794 × 1123, the size A4 document pages always had). */
export const paperPx = (id: PaperId): { width: number; height: number } => {
  const p = PAPERS.find((x) => x.id === id)!;
  return { width: Math.round(p.w * PX_PER_MM), height: Math.round(p.h * PX_PER_MM) };
};

/** The preset a page size matches (either orientation, within 1.5 px), else "custom". */
export function paperOf(width: number, height: number): PaperId | "custom" {
  const s = Math.min(width, height), l = Math.max(width, height);
  for (const p of PAPERS) {
    const { width: w, height: h } = paperPx(p.id);
    if (near(s, w, 1.5) && near(l, h, 1.5)) return p.id;
  }
  return "custom";
}

/** A size read from a file, snapped to its paper preset in the same orientation (A4 = 794 × 1123 however it was rounded). */
export function snapPaper(width: number, height: number): { width: number; height: number } {
  const id = paperOf(width, height);
  if (id === "custom") return { width: Math.round(width), height: Math.round(height) };
  const p = paperPx(id);
  return width > height ? { width: p.height, height: p.width } : p;
}

export const isLandscape =(p: Pick<Page, "width" | "height">) => p.width > p.height;

// ───────── units (dialog fields) ─────────

export type LengthUnit = "mm" | "cm" | "in" | "pt" | "px";
export const UNIT_PX: Record<LengthUnit, number> = { mm: PX_PER_MM, cm: PX_PER_MM * 10, in: 96, pt: 96 / 72, px: 1 };
const UNIT_STEP: Record<LengthUnit, number> = { mm: 10, cm: 100, in: 100, pt: 10, px: 1 };
/** px → value in `unit`, rounded for display (0.1 mm, 0.01 cm / in, 0.1 pt, 1 px). */
export const toUnit = (px: number, unit: LengthUnit) => Math.round((px / UNIT_PX[unit]) * UNIT_STEP[unit]) / UNIT_STEP[unit];
export const fromUnit = (v: number, unit: LengthUnit) => v * UNIT_PX[unit];

// ───────── sections ─────────

export interface SectionRun {
  /** index of the section's first page and one past its last */
  start: number;
  end: number;
  setup: PageSetup;
}

/**
 * Pages grouped into sections as a word processor sees them: a new section at the first page, at a page marked
 * "section", and wherever the paper size or margins differ from the page before (DOCX / HWPX change them only at a
 * section break).
 */
export function sectionsOf(pages: Pick<Page, "width" | "height" | "margins" | "breakBefore">[]): SectionRun[] {
  const out: SectionRun[] = [];
  pages.forEach((p, i) => {
    const s = setupOf(p);
    const last = out[out.length - 1];
    if (!last || p.breakBefore === "section" || !sameSetup(last.setup, s)) out.push({ start: i, end: i + 1, setup: s });
    else last.end = i + 1;
  });
  return out;
}

/**
 * The pages of the section holding page `i` as the user made it ("이 구역" in the page setup dialog): from the last
 * section break at or before it (or the first page) up to the next section break — whatever their setup is now.
 */
export function sectionAt(pages: Pick<Page, "breakBefore">[], i: number): number[] {
  let a = Math.max(0, Math.min(i, pages.length - 1));
  while (a > 0 && pages[a].breakBefore !== "section") a--;
  let b = a + 1;
  while (b < pages.length && pages[b].breakBefore !== "section") b++;
  return Array.from({ length: b - a }, (_, k) => a + k);
}

// ───────── documents from before page setup ─────────

const WORD_FORMATS = new Set(["docx", "hwpx"]);
const isWordPage = (p: Pick<Page, "source">) => !!p.source && WORD_FORMATS.has(p.source.format);

/**
 * Pages opened from a DOCX / HWPX by an app before page setup existed (.omw with a block map of rules version 1):
 * they were paginated automatically and carry no breakBefore, which now reads as a hard page break. Until a break is
 * made in such a document (normalizeLegacyBreaks), its word-processor pages without breakBefore continue the flow, so
 * the file is written as before (no page break at every automatic page boundary).
 */
export function legacyWordPages(pages: Pick<Page, "source" | "breakBefore">[]): boolean {
  const word = pages.filter(isWordPage);
  return word.some((p) => p.source?.office?.engine === 1) && word.every((p) => p.breakBefore === undefined);
}

/** Whether page `i` begins with a hard page break (not the first page, not "flow" / "section"). */
export function hardBreakBefore(pages: Pick<Page, "source" | "breakBefore">[], i: number, legacy = legacyWordPages(pages)): boolean {
  const p = pages[i];
  if (i === 0 || p.breakBefore) return false;
  return !(legacy && isWordPage(p));
}

/** Make a legacy document's automatic page boundaries explicit ("flow"), before a break is added to it (in place). */
export function normalizeLegacyBreaks(pages: Pick<Page, "source" | "breakBefore">[]) {
  if (!legacyWordPages(pages)) return;
  pages.forEach((p, i) => {
    if (i > 0 && isWordPage(p) && p.breakBefore === undefined) p.breakBefore = "flow";
  });
}

// ───────── applying a setup ─────────

type MutablePage = Pick<Page, "width" | "height" | "nodes" | "margins">;

/** A body object: an unrotated text box or table starting at the left margin (it follows the margins). */
const isBody = (n: SceneNode, box: { x: number; w: number }) =>
  (n.type === "TEXT" || n.type === "TABLE") && !n.transform.rotation && n.transform.scale === 1 && near(n.transform.x, box.x, 1.5);

/**
 * Give a page a new paper size and margins. Body text boxes and tables (those starting at the left margin) follow the
 * margins: they move with the top-left corner, a text box as wide as the old body becomes as wide as the new one, and
 * a table wider than the new body is narrowed. Other objects keep their coordinates (they are placed on the paper).
 * Text is not re-flowed onto other pages (no automatic flow yet): a body that no longer fits runs past the margin.
 */
export function applySetupInPlace(p: MutablePage, setup: PageSetup) {
  const old = bodyBox(p);
  p.width = setup.width;
  p.height = setup.height;
  const m = storedMargins(setup.margins);
  if (m) p.margins = m;
  else delete p.margins;
  // 단: only when the setup says (columns of one = none); a setup without them (paper, margins applied to the document)
  // leaves each section's own columns as they are
  if (setup.columns && setup.columns.n > 1) (p as { columns?: PageColumns }).columns = { ...setup.columns };
  else if (setup.columns) delete (p as { columns?: PageColumns }).columns;
  const box = bodyBox(p);
  for (const n of p.nodes) {
    if (!isBody(n, old)) continue;
    n.transform.x = box.x;
    if (n.transform.y >= old.y - 1.5) n.transform.y = box.y + (n.transform.y - old.y);
    if (n.type === "TEXT" && near(n.width, old.w, 2)) n.width = box.w;
    if (n.type === "TABLE") {
      const total = n.colWidths.reduce((a, b) => a + b, 0);
      if (total > box.w + 0.5) n.colWidths = n.colWidths.map((w) => Math.round(((w * box.w) / total) * 100) / 100);
    }
  }
}

/**
 * 쪽 나누기 / 구역 나누기 (in place, on plain pages or a draft): a new page right after page `index` with the same
 * kind, paper, margins, master and background. With a text box split at the caret (`keep` stays, `moved` goes), the
 * moved paragraphs start the new page's body in a copy of the box, and the objects below the box follow them;
 * without one the new page is blank. A section break starts a new section (its setup can then be changed alone).
 * Returns the new page.
 */
export function breakPageInPlace(
  pages: Page[],
  index: number,
  kind: "page" | "section",
  make: { pageId: string; nodeId: string; name: string },
  split?: { nodeId: string; keep: TextParagraph[]; moved: TextParagraph[] },
): Page {
  normalizeLegacyBreaks(pages);
  const pg = pages[index];
  const next: Page = {
    id: make.pageId,
    name: make.name,
    kind: pg.kind,
    width: pg.width,
    height: pg.height,
    background: pg.background,
    nodes: [],
    masterId: pg.masterId,
    transition: { ...pg.transition },
    animations: [],
  };
  if (pg.margins) next.margins = { ...pg.margins };
  if (pg.columns) next.columns = { ...pg.columns };
  if (kind === "section") next.breakBefore = "section";
  // a page made from an Office file stays part of it ("save as the same type"); its block map stays on the first page
  if (pg.source) {
    const { office: _office, fragments: _fragments, ...src } = pg.source;
    next.source = src;
  }
  const box = split && (pg.nodes.find((n) => n.id === split.nodeId) as TextNode | undefined);
  if (box && split) {
    const bottom = box.transform.y + layoutText(box).height * box.transform.scale;
    box.paragraphs = split.keep;
    const copy: TextNode = { ...box, id: make.nodeId, paragraphs: split.moved, transform: { ...box.transform, y: bodyBox(pg).y } };
    next.nodes.push(copy);
    // objects below the box go with the text after the caret, keeping their distance to it
    const dy = copy.transform.y + layoutText(copy).height * copy.transform.scale - bottom;
    const below = pg.nodes.filter((n) => n !== box && n.transform.y >= bottom - 0.5);
    pg.nodes = pg.nodes.filter((n) => !below.includes(n));
    for (const n of below) next.nodes.push({ ...n, transform: { ...n.transform, y: n.transform.y + dy } } as SceneNode);
    // animations of moved objects move with them
    next.animations = pg.animations.filter((a) => below.some((n) => n.id === a.targetNodeId));
    pg.animations = pg.animations.filter((a) => !next.animations.includes(a));
  }
  pages.splice(index + 1, 0, next);
  return next;
}

/** Height a node takes in the body flow (text / table layout height, else its box). */
export function flowHeight(n: SceneNode): number {
  if (n.type === "TEXT") return layoutText(n).height;
  if (n.type === "TABLE") return layoutTable(n).height;
  return "height" in n ? (n as { height: number }).height * n.transform.scale : 0;
}
