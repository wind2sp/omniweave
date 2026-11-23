// Block flow: lays out a sequence of paragraphs, images and tables onto A4 document pages.
// Shared by Markdown, HTML, EPUB, plain/code text, CSV/XLSX and legacy-format importers.
//
// Paragraph heights are additive (core/text.ts lays paragraphs out top to bottom), so each
// paragraph is measured once on its own and the flow is O(n).

import { t } from "../../i18n";
import { layoutTable } from "../../core/table";
import { layoutText } from "../../core/text";
import {
  DEFAULT_RUN,
  MONO_FONT,
  PAGE_PRESETS,
  newImage,
  newPage,
  newParagraph,
  newTable,
  newText,
  uid,
  type AssetRef,
  type Page,
  type PageSource,
  type SceneNode,
  type TableCell,
  type TableNode,
  type TextNode,
  type TextParagraph,
  type TextRun,
} from "../../core/types";
import { storedMargins } from "../../core/pageSetup";
import { markFlowInPlace, nodeOrder, reflowPages, tableGap } from "../../core/flow";
import type { PageMargins } from "../../core/types";
import type { ListDef } from "../../core/style/types";
import { A4_MARGIN, paginate, type OfficeItem, type OfficeLayout } from "../office";
import { imageFields, picArea, type OfficePic, type PicFloat, type PicGeom } from "../officeDrawing";
import type { ObjectPlace } from "../../core/types";

export type Block =
  | { kind: "para"; para: TextParagraph }
  | { kind: "image"; assetId: string; width: number; height: number; name: string; pic?: FlowPic }
  | { kind: "table"; rows: TableCell[][]; colWidths?: number[]; headerRow?: boolean; name?: string; style?: Partial<Pick<TableNode, "fontSize" | "fontFamily" | "color" | "borderColor" | "headerFill" | "rowHeight" | "cellBox" | "wordAlign" | "wordInd">> }
  | { kind: "pagebreak" };

/**
 * A picture read from a word-processor file (io/officeDrawing.ts): placed by how the file places it — inline in the
 * flow (aligned like its paragraph), or floating on the page (kept clear of the text below it when text goes around
 * it). Its size is the file's (no fitting into the page).
 */
export interface FlowPic {
  id: string;
  g: PicGeom;
  place: ObjectPlace;
  inline?: OfficePic["inline"];
  float?: PicFloat;
  /** anchored in the paragraph before it (its top is that paragraph's), not at the flow position */
  after: boolean;
}

export interface FlowOptions {
  source?: PageSource;
  wordBreak?: TextNode["wordBreak"];
  /** TextNode.cjkSpace of the text nodes made */
  cjkSpace?: TextNode["cjkSpace"];
  /** TextNode.hangPunct of the text nodes made */
  hangPunct?: boolean;
  /** TextNode.justifyShrink of the text nodes made */
  justifyShrink?: boolean;
  /** TextNode.autoSpace of the text nodes made */
  autoSpace?: TextNode["autoSpace"];
  /** TextNode.wordSpacing of the text nodes made */
  wordSpacing?: TextNode["wordSpacing"];
  /** TextNode.lang of the text nodes made (spelling) */
  lang?: string;
  /** page size; defaults to A4 portrait */
  width?: number;
  height?: number;
  /** one margin all round (default: the default page margins) */
  margin?: number;
  /** page setup margins (office imports); stored on the pages when they are not the defaults */
  margins?: PageMargins;
}

export const PT = 96 / 72;

export function para(text: string, run: Partial<TextRun> = {}, extra: Partial<TextParagraph> = {}): Block {
  return { kind: "para", para: { ...newParagraph(text, run), ...extra } };
}

/** Paragraph from several runs. */
export function paraRuns(runs: Partial<TextRun>[], extra: Partial<TextParagraph> = {}): TextParagraph {
  const rs: TextRun[] = runs.length ? runs.map((r) => ({ ...DEFAULT_RUN, ...r, text: r.text ?? "" })) : [{ ...DEFAULT_RUN }];
  return { id: uid("p"), runs: rs, align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 6, ...extra };
}

export const MONO_RUN: Partial<TextRun> = { fontFamily: MONO_FONT, fontSize: 13 };

/** Code / plain text lines → paragraphs with tight monospace spacing. */
export function codeBlocks(text: string, mono = true): Block[] {
  return text.split("\n").map((line) => para(line, mono ? MONO_RUN : { fontSize: 15 }, { lineSpacing: mono ? 1.35 : 1.5, spaceAfter: mono ? 0 : 2 }));
}

export function flowBlocks(blocks: Block[], title: string, assets: Record<string, AssetRef> = {}, opts: FlowOptions = {}): Page[] {
  const width = opts.width ?? PAGE_PRESETS.A4.width;
  const height = opts.height ?? PAGE_PRESETS.A4.height;
  // margins: the page setup's (office imports), one number all round, or the default page margins
  const stored = opts.margins && storedMargins(opts.margins);
  const m = opts.margins ?? (opts.margin !== undefined ? { top: opts.margin, right: opts.margin, bottom: opts.margin, left: opts.margin } : { top: A4_MARGIN, right: A4_MARGIN, bottom: A4_MARGIN, left: A4_MARGIN });
  const margin = m.left;
  const top = m.top;
  const boxW = width - m.left - m.right;
  const bottom = height - m.bottom;
  const pages: Page[] = [];
  let page: Page | null = null;
  let y = top;
  let text: TextNode | null = null;
  let textH = 0;
  let explicit = false; // the next page starts after a "pagebreak" block
  // bands of this page that text keeps clear of (floating pictures with text going around them: top and bottom, square)
  let bands: { top: number; bottom: number }[] = [];

  const newPg = () => {
    closeText();
    page = newPage("DOCUMENT", width, height, t("engine.default.pageOfFile", { title, page: pages.length + 1 }));
    bands = [];
    if (opts.source) page.source = { ...opts.source };
    if (stored) page.margins = stored;
    if (pages.length && !explicit) page.breakBefore = "flow";
    explicit = false;
    pages.push(page);
    y = top;
  };
  const closeText = () => {
    if (text && page) {
      y += textH;
      text = null;
      textH = 0;
    }
  };
  const place = (n: SceneNode, h: number) => {
    n.transform = { x: margin, y, rotation: 0, scale: 1 };
    page!.nodes.push(n);
    y += h;
  };
  const probe = newText("", boxW);
  if (opts.wordBreak) probe.wordBreak = opts.wordBreak;
  if (opts.cjkSpace) probe.cjkSpace = opts.cjkSpace;
  if (opts.hangPunct) probe.hangPunct = true;
  if (opts.justifyShrink) probe.justifyShrink = true;
  if (opts.autoSpace) probe.autoSpace = opts.autoSpace;
  if (opts.wordSpacing) probe.wordSpacing = opts.wordSpacing;
  newPg();
  let paraTop = top; // top of the last paragraph placed (a floating picture anchored in it measures from there)
  /** the place for content `h` high at `at`: below every band it would run into */
  const clear = (at: number, h: number) => {
    for (let moved = true; moved; ) {
      moved = false;
      for (const b of bands)
        if (at < b.bottom && at + h > b.top) {
          at = b.bottom;
          moved = true;
        }
    }
    return at;
  };

  const placePic = (b: Extract<Block, { kind: "image" }>, P: FlowPic) => {
    const g = P.g;
    const node = (x: number, yy: number, behind = false) => {
      const n = { ...newImage(b.assetId, g.w, g.h, b.name), ...imageFields({ ...g, x, y: yy }), id: P.id, place: P.place };
      if (behind) page!.nodes.unshift(n);
      else page!.nodes.push(n);
    };
    if (P.inline) {
      const at = P.inline;
      closeText();
      y = clear(y, at.before + g.h);
      let before = at.before;
      // a picture that does not fit goes to the next page, without the room above it
      if (y + before + g.h > bottom && y > top + 1) {
        newPg();
        before = 0;
      }
      const x = at.align === "CENTER" ? margin + (boxW - g.w) / 2 : at.align === "RIGHT" ? margin + boxW - g.w : margin + at.indent;
      node(x, y + before);
      y += before + g.h + at.after;
      return;
    }
    const f = P.float!;
    const ref = P.after ? paraTop : y + textH;
    const alignIn = (a: "left" | "center" | "right" | "top" | "bottom" | undefined, from: number, size: number, len: number) => (a === "center" ? from + (size - len) / 2 : a === "right" || a === "bottom" ? from + size - len : from);
    // offset or alignment within what the place is measured in (officeDrawing.ts picArea: page, body, margin strips)
    const ax = picArea(f.xFrom, width, margin, width - margin - boxW);
    const x = f.xAlign ? alignIn(f.xAlign, ax.from, ax.size, g.w) : ax.from + f.x;
    const ay = f.yFrom === "para" && !f.yAlign ? null : picArea(f.yFrom === "para" ? "margin" : f.yFrom, height, top, height - bottom);
    const yy = !ay ? ref + f.y : f.yAlign ? alignIn(f.yAlign, ay.from, ay.size, g.h) : ay.from + f.y;
    node(x, yy, f.wrap === "behind");
    // text going around it (square, top and bottom): text that would run into it goes below it (Word, 한글)
    if (f.wrap === "topBottom" || f.wrap === "square") {
      bands.push({ top: yy, bottom: yy + g.h + f.gapBelow });
      if (P.after) {
        closeText();
        y = clear(y, 1);
      }
    }
  };

  for (const b of blocks) {
    if (b.kind === "pagebreak") {
      explicit = true;
      newPg();
      continue;
    }
    if (b.kind === "para") {
      const h = layoutText({ ...probe, paragraphs: [b.para] }).height;
      if (text && y + textH + h > bottom) newPg();
      else if (!text && y + h > bottom && y > top + 1) newPg();
      const at = clear(y + textH, h);
      if (at !== y + textH) {
        closeText();
        y = at;
        if (y + h > bottom && y > top + 1) newPg();
      }
      paraTop = y + textH;
      if (!text) {
        text = newText("", boxW);
        text.name = t("engine.default.body");
        if (opts.wordBreak) text.wordBreak = opts.wordBreak;
        if (opts.cjkSpace) text.cjkSpace = opts.cjkSpace;
        if (opts.hangPunct) text.hangPunct = true;
        if (opts.justifyShrink) text.justifyShrink = true;
        if (opts.autoSpace) text.autoSpace = opts.autoSpace;
        if (opts.wordSpacing) text.wordSpacing = opts.wordSpacing;
        if (opts.lang) text.lang = opts.lang;
        text.paragraphs = [];
        text.transform = { x: margin, y, rotation: 0, scale: 1 };
        page!.nodes.push(text);
      }
      // the text node object is mutated only while it is being built (never after it is in a store)
      text.paragraphs.push(b.para);
      textH += h;
      continue;
    }
    if (b.kind === "image" && b.pic) {
      placePic(b, b.pic);
      continue;
    }
    closeText();
    y = clear(y, 1);
    if (b.kind === "image") {
      const k = Math.min(1, boxW / b.width, (bottom - top) / b.height);
      const w = b.width * k, h = b.height * k;
      if (y + h > bottom && y > top + 1) newPg();
      place(newImage(b.assetId, w, h, b.name), h + 8);
      continue;
    }
    // table: scale columns to the box and split rows across pages, repeating the header row
    const cols = Math.max(1, ...b.rows.map((r) => r.length));
    let widths = b.colWidths && b.colWidths.length === cols ? [...b.colWidths] : Array.from({ length: cols }, () => boxW / cols);
    const total = widths.reduce((a, c) => a + c, 0);
    // (Word's table keeps its grid however wide: it runs into the margins as its w:jc / w:tblInd place it — Word PDF)
    if (total > boxW && !b.style?.cellBox?.word) widths = widths.map((w) => (w * boxW) / total);
    const full: TableNode = { ...newTable(b.rows, widths, b.name ?? t("engine.default.table")), ...(b.style ?? {}) };
    full.headerRow = b.headerRow ?? true;
    const lay = layoutTable(full);
    const header = full.headerRow && full.rows.length > 1 ? 1 : 0;
    const headH = header ? lay.rowY[1] : 0;
    let r = header;
    if (!header && full.rows.length === 1) r = 0;
    let first = true;
    while (r < full.rows.length || first) {
      let room = bottom - y - headH;
      if (room < lay.rowY[Math.min(r + 1, full.rows.length)] - lay.rowY[r] && y > top + 1) {
        newPg();
        room = bottom - y - headH;
      }
      let end = r;
      let used = 0;
      while (end < full.rows.length && (used + (lay.rowY[end + 1] - lay.rowY[end]) <= room || end === r)) {
        used += lay.rowY[end + 1] - lay.rowY[end];
        end++;
      }
      // the pieces after the first continue the first (flowCont, as core/flow.ts tablePiece cuts them): the body flow
      // (reflowPages, Word / 한글 page rules) joins and cuts them again by its own rules, and the writers and the Office
      // Surgeon read them as the one table of the file even when the flow puts two pieces on one page — without it the
      // pieces stayed two tables there and an unchanged HWPX lost its block map (saved anew instead of byte-identical)
      const rows = header ? [full.rows[0], ...full.rows.slice(r, end)] : full.rows.slice(r, end);
      const chunk: TableNode = first ? { ...full, rows } : { ...full, id: `${full.id}~${r}`, rows, flowCont: full.id };
      if (!chunk.rows.length) chunk.rows = full.rows.slice(0, 1);
      place(chunk, headH + used + tableGap(full));
      r = end;
      first = false;
      if (r < full.rows.length) newPg();
    }
  }
  closeText();
  void assets;
  return pages;
}

/**
 * DOCX/HWPX body → pages: paragraphs flow like paginate(), tables become TABLE nodes between them. With the body's
 * layout, every hard page break starts a new page and every section a new page with that section's paper size and
 * margins ("section"); pages made by running out of room continue the flow ("flow").
 */
export function officePages(items: OfficeItem[], title: string, layout?: OfficeLayout, lists?: ListDef[], pics: { pic: OfficePic; assetId: string }[] = []): Page[] {
  let pages = officePagesWhole(items, title, layout, lists, pics);
  // note numbering and separators of the file (core/notes.ts)
  if (layout?.notePr && pages[0]) pages[0].notePr = layout.notePr;
  // comments of the file (core/review.ts)
  if (layout?.comments?.length && pages[0]) pages[0].comments = layout.comments;
  if (layout?.trackChanges && pages[0]) pages[0].trackChanges = true;
  // Word cuts paragraphs at page ends (widow / orphan control, keep with next) and 한글 where its saved lines begin a
  // page: the body flow lays the pages out by those rules (core/flow.ts), with the notes at the foot of their pages;
  // the Office Surgeon writes the pieces back as the one paragraph each was
  if (layout?.pageRules) {
    pages = reflowPages(pages, true);
    pages.forEach((p, i) => (p.name = t("engine.default.pageOfFile", { title, page: i + 1 })));
  }
  return pages;
}

function officePagesWhole(items: OfficeItem[], title: string, layout?: OfficeLayout, lists?: ListDef[], pics: { pic: OfficePic; assetId: string }[] = []): Page[] {
  const sections = layout?.sections.length ? layout.sections : [];
  const starts = new Set(sections.map((s) => s.start).filter((i) => i > 0));
  const cuts = [...new Set([0, ...starts, ...(layout?.pageBreaks ?? [])])].filter((i) => i >= 0 && i < Math.max(1, items.length)).sort((a, b) => a - b);
  let n = 0;
  const pages: Page[] = [];
  const secFirst = new Map<OfficeLayout["sections"][number], number>();
  cuts.forEach((a, k) => {
    const end = cuts[k + 1] ?? items.length;
    const seg = items.slice(a, end);
    const sec = [...sections].reverse().find((s) => s.start <= a);
    const setup = sec?.setup;
    // pictures of this run of items: before item j (one at the cut that goes with the item before belongs to the run before)
    // (a floating picture placed by the page or margin goes before the paragraph it is anchored in: text that would run
    // into it then goes below it, as in Word / 한글; one placed by its paragraph needs that paragraph's top first)
    const early = (pic: OfficePic) => pic.tail && !!pic.float && pic.float.yFrom !== "para" && pic.at - 1 >= a && pic.at - 1 < end;
    const mine = (j: number) =>
      pics.filter(({ pic }) => (early(pic) ? pic.at - 1 === j : pic.at === j && (j === a ? !pic.tail || a === 0 : j === end ? pic.tail || end === items.length : true)));
    const picBlocks = (j: number): Block[] =>
      mine(j).map(({ pic, assetId }) => ({
        kind: "image",
        assetId,
        width: pic.g.w,
        height: pic.g.h,
        name: pic.name,
        pic: {
          id: pic.id,
          g: pic.g,
          inline: pic.inline,
          float: pic.float,
          after: pic.tail && !!pic.float && pic.float.yFrom === "para",
          place: { mode: pic.inline ? "inline" : "float", ...(pic.float ? { wrap: pic.float.wrap } : {}), ...(pic.para ? { para: pic.para } : {}), offset: pic.offset, ...(pic.own ? { own: true } : {}), ...(pic.inline ? { space: { before: pic.inline.before, after: pic.inline.after } } : {}) },
        },
      }));
    const withPics = pics.some(({ pic }) => pic.at >= a && pic.at <= end) && Array.from({ length: end - a + 1 }, (_, i) => mine(a + i).length).some(Boolean);
    let ps: Page[];
    if (!seg.some((it) => it.kind === "table") && !withPics) ps = paginate(seg.map((it) => (it.kind === "p" ? it.p : null)).filter((p): p is TextParagraph => !!p), title, setup, layout);
    else {
      const blocks: Block[] = [];
      seg.forEach((it, i) => {
        blocks.push(...picBlocks(a + i));
        blocks.push(
          it.kind === "p" ? { kind: "para", para: it.p } : { kind: "table", rows: it.table.rows, colWidths: it.table.colWidths, headerRow: it.table.headerRow, name: t("engine.default.tableN", { n: ++n }), style: it.table.style },
        );
      });
      blocks.push(...picBlocks(end));
      ps = flowBlocks(blocks, title, {}, { ...(setup ? { width: setup.width, height: setup.height, margins: setup.margins } : {}), ...(layout?.wordBreak ? { wordBreak: layout.wordBreak } : {}), ...(layout?.cjkSpace ? { cjkSpace: layout.cjkSpace } : {}), ...(layout?.hangPunct ? { hangPunct: true } : {}), ...(layout?.justifyShrink ? { justifyShrink: true } : {}), ...(layout?.autoSpace ? { autoSpace: layout.autoSpace } : {}), ...(layout?.wordSpacing ? { wordSpacing: layout.wordSpacing } : {}), ...(layout?.lang ? { lang: layout.lang } : {}) });
    }
    // 단 of the section: on each of its pages (the body flow lays them out column by column)
    if (setup?.columns && setup.columns.n > 1) for (const pg of ps) pg.columns = { ...setup.columns };
    if (a > 0) {
      if (starts.has(a)) ps[0].breakBefore = "section";
      else delete ps[0].breakBefore;
    }
    // headers, footers and page numbering live on the section's first page (core/headerFooter.ts)
    if (sec?.hf && sec.start === a) ps[0].hf = sec.hf;
    if (sec && sec.start === a) secFirst.set(sec, pages.length);
    pages.push(...ps);
  });
  if (sections.some((s) => s.hfAt || s.hfHide)) hwpxFirstPages(pages, items, sections, secFirst);
  // the body text and tables are the document's body flow (core/flow.ts): typing goes on from page to page. The
  // pages stay as paginated here until a page run is edited.
  markFlowInPlace(pages);
  pages.forEach((p, i) => (p.name = t("engine.default.pageOfFile", { title, page: i + 1 })));
  // imported list definitions travel with the text nodes whose paragraphs use them
  if (lists?.length)
    for (const pg of pages)
      for (const n of pg.nodes)
        if (n.type === "TEXT") {
          const ids = new Set(n.paragraphs.map((q) => q.list?.def).filter(Boolean));
          const own = lists.filter((d) => ids.has(d.id));
          if (own.length) n.lists = own;
        }
  return pages;
}

/**
 * 한글 shows a header / footer from the page its control is on, and can hide them on a section's first page. Both
 * become Word's different first page: the section's first page shows a blank one (or, for the other area, the same
 * as its other pages). A control further down than the second page is taken as on the second page.
 */
function hwpxFirstPages(pages: Page[], items: OfficeItem[], sections: OfficeLayout["sections"], secFirst: Map<OfficeLayout["sections"][number], number>) {
  const pageOfPara = new Map<string, number>();
  pages.forEach((pg, i) => {
    for (const nd of pg.nodes) if (nd.type === "TEXT") for (const q of nd.paragraphs) if (!pageOfPara.has(q.id)) pageOfPara.set(q.id, i);
  });
  const eff: Record<"header" | "footer", TextParagraph[] | undefined> = { header: undefined, footer: undefined };
  for (const sec of sections) {
    const first = secFirst.get(sec);
    const hf = sec.hf;
    for (const area of ["header", "footer"] as const) if (hf?.[area]?.default) eff[area] = hf[area]!.default;
    if (first === undefined) continue;
    const hide = { ...(sec.hfHide ?? {}) };
    const early: { header?: TextParagraph[]; footer?: TextParagraph[] } = {};
    for (const area of ["header", "footer"] as const) {
      const at = sec.hfAt?.[area];
      const it = at !== undefined ? items[at] : undefined;
      const pi = it?.kind === "p" ? pageOfPara.get(it.p.id) : undefined;
      if (pi !== undefined && pi > first) {
        // a header at the section start and the usual one from the second page: the first one is the first page's
        if (sec.hfEarly?.[area] && !hide[area]) early[area] = sec.hfEarly[area];
        else hide[area] = true;
      }
    }
    if (!hide.header && !hide.footer && !early.header && !early.footer) continue;
    const own = { ...(hf ?? {}) };
    own.titlePg = true;
    for (const area of ["header", "footer"] as const) {
      const v = { ...(own[area] ?? {}) };
      v.first = (hide[area] ? [] : early[area] ?? eff[area] ?? []).map((q) => ({ ...q, id: uid("p") }));
      own[area] = v;
    }
    pages[first].hf = own;
  }
}

/** Text of every text node and table in reading order (top→bottom, left→right) across pages. */
export function readingOrder(pages: Page[]): SceneNode[] {
  const out: SceneNode[] = [];
  // (note areas laid out by the body flow are not body text)
  for (const p of pages) out.push(...p.nodes.filter((n) => !n.notes).sort(nodeOrder));
  return out;
}

/** Pages to export for a "same type" save: the pages that came from that format, else every page. */
export function pagesFor(pages: Page[], formats: string[]): Page[] {
  const own = pages.filter((p) => p.source && formats.includes(p.source.format));
  return own.length ? own : pages;
}

export function sourceOf(pages: Page[], formats: string[]): PageSource | undefined {
  return pages.find((p) => p.source && formats.includes(p.source.format))?.source;
}
