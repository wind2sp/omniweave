// Headers, footers and page numbers (머리말·꼬리말·쪽 번호) as section-level parts of a document, not master-page objects.
//
// Model (core/types.ts SectionHF on the first page of a section — core/pageSetup.ts sectionsOf):
//   header / footer   variants default / first / even, each rich paragraphs; an absent variant is linked to the
//                     section before (Word "Same as Previous", 한글 머리말이 다음 구역에도 이어짐), [] is a blank one
//   titlePg           different first page: the section's first page uses the `first` variants
//   evenOdd           different odd and even pages (document-wide, on the first page): even pages use `even`
//   pageStart/pageFmt numbering of the section (Word pgNumType: start again at, 1 / i / I / a / A / - 1 - / 가)
//   pageNum           a page number placed by itself (한글 쪽 번호 매기기 hp:pageNum, top/bottom × left/center/right)
// Fields are runs with `field` (page, pages, secpages, date, file): their text is the value last shown and every page
// draws its own value.
//
// Drawing: renderMasterOf() gives each document page a master with its header / footer / page number as text nodes
// (canvas, thumbnails, PNG, SVG, PDF and print all draw the master), so there is one layout for every output.
// Editing: the canvas edits a header in place through a virtual text node (hfEditNode / setHfParas); the commands
// below change the model on plain pages or immer drafts (one undo step each in ui/headerFooterActions.ts).

import { formatNumber } from "./lists";
import { hfKey, hfNodes } from "./slideHf";
import { layoutChain } from "./slideLayouts";
import { marginsOf, sectionsOf, type SectionRun } from "./pageSetup";
import { layoutText } from "./text";
import { DEFAULT_RUN, IDENTITY, uid, type FieldKind, type HFVariants, type OmwDocument, type Page, type PageNumFormat, type PageNumPos, type SectionHF, type TextNode, type TextParagraph, type TextRun } from "./types";

export type HFArea = "header" | "footer";
export type HFVariant = "default" | "first" | "even";
export const HF_AREAS: readonly HFArea[] = ["header", "footer"];
export const HF_VARIANTS: readonly HFVariant[] = ["default", "first", "even"];
export const PAGE_NUM_FORMATS: readonly PageNumFormat[] = ["decimal", "lowerRoman", "upperRoman", "lowerLetter", "upperLetter", "dash", "ganada"];
export const PAGE_NUM_POSITIONS: readonly PageNumPos[] = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right", "top-outside", "bottom-outside", "top-inside", "bottom-inside"];
export const FIELD_KINDS: readonly FieldKind[] = ["page", "pages", "secpages", "date", "file"];

/** 10 pt: the size of new header / footer text and of a page number placed by itself (Word's and 한글's default) */
export const HF_SIZE = Math.round(10 * (96 / 72) * 100) / 100;

/** `n` in a page number format ("dash": Word numberInDash "- 1 -"). */
export function formatPageNumber(n: number, fmt: PageNumFormat = "decimal"): string {
  if (fmt === "dash") return `- ${n} -`;
  if (fmt === "decimal") return String(n);
  return formatNumber(n, fmt);
}

// ───────── numbering and variants per page ─────────

export interface PageHFInfo {
  /** section (sectionsOf run) of the page and that section's pages [start, end) */
  section: number;
  start: number;
  end: number;
  /** page number as counted (restarts included) and its format */
  num: number;
  fmt: PageNumFormat;
  /** the header / footer variant this page shows */
  variant: HFVariant;
}

export interface DocHFInfo {
  runs: SectionRun[];
  pages: PageHFInfo[];
}

const infoMemo = new WeakMap<readonly Page[], { sig: unknown[]; info: DocHFInfo }>();
/** What the numbering depends on, per page (pages edited in place — plain pages, not drafts — are noticed too). */
const infoSig = (pages: readonly Page[]) => pages.flatMap((p) => [p, p.hf, p.breakBefore, p.width, p.height, p.margins]);
function sameSig(sig: unknown[], pages: readonly Page[]): boolean {
  if (sig.length !== pages.length * 6) return false;
  for (let i = 0, k = 0; i < pages.length; i++, k += 6) {
    const p = pages[i];
    if (sig[k] !== p || sig[k + 1] !== p.hf || sig[k + 2] !== p.breakBefore || sig[k + 3] !== p.width || sig[k + 4] !== p.height || sig[k + 5] !== p.margins) return false;
  }
  return true;
}

/** Sections, page numbers and header variants of every page (memoised per pages array). */
export function hfInfo(pages: readonly Page[]): DocHFInfo {
  const hit = infoMemo.get(pages);
  // checked without building a new signature: every page thumbnail asks on every change of a long document
  if (hit && sameSig(hit.sig, pages)) return hit.info;
  const sig = infoSig(pages);
  const runs = sectionsOf(pages as Page[]);
  const evenOdd = !!pages[0]?.hf?.evenOdd;
  const out: PageHFInfo[] = [];
  let n = 0;
  runs.forEach((r, k) => {
    const hf = pages[r.start].hf;
    if (hf?.pageStart != null && Number.isFinite(hf.pageStart)) n = Math.round(hf.pageStart) - 1;
    const fmt = hf?.pageFmt ?? "decimal";
    for (let i = r.start; i < r.end; i++) {
      n++;
      const variant: HFVariant = hf?.titlePg && i === r.start ? "first" : evenOdd && n % 2 === 0 ? "even" : "default";
      out.push({ section: k, start: r.start, end: r.end, num: n, fmt, variant });
    }
  });
  const info = { runs, pages: out };
  infoMemo.set(pages, { sig, info });
  return info;
}

/** The section's own hf (on its first page). */
const sectionHF = (pages: readonly Page[], info: DocHFInfo, k: number): SectionHF | undefined => pages[info.runs[k].start]?.hf;

/** Section index that defines variant `v` of `area` for section `k` (itself or the nearest before it), or -1. */
export function variantOwner(pages: readonly Page[], info: DocHFInfo, k: number, area: HFArea, v: HFVariant): number {
  for (let j = k; j >= 0; j--) if (sectionHF(pages, info, j)?.[area]?.[v]) return j;
  return -1;
}

/** The paragraphs page `i` shows in `area` (undefined = nothing), as stored (fields hold their last value). */
export function hfContent(pages: readonly Page[], i: number, area: HFArea): TextParagraph[] | undefined {
  const info = hfInfo(pages);
  const pi = info.pages[i];
  if (!pi) return undefined;
  const o = variantOwner(pages, info, pi.section, area, pi.variant);
  return o < 0 ? undefined : sectionHF(pages, info, o)![area]![pi.variant];
}

/** The page number placed by itself on page `i` (inherited from earlier sections), or null. */
export function pageNumAt(pages: readonly Page[], i: number): { pos: PageNumPos; side?: string } | null {
  const info = hfInfo(pages);
  const pi = info.pages[i];
  if (!pi) return null;
  if (i === pi.start && sectionHF(pages, info, pi.section)?.hideFirstNum) return null;
  for (let j = pi.section; j >= 0; j--) {
    const pn = sectionHF(pages, info, j)?.pageNum;
    if (pn !== undefined) return pn;
  }
  return null;
}

// ───────── fields ─────────

export interface FieldEnv {
  /** this page's number as shown (formatted) */
  page: string;
  /** pages in the document */
  pages: number;
  /** pages in this page's section */
  secPages: number;
  /** today (yyyy-MM-dd unless the field says otherwise) */
  date: Date;
  /** file name (the document title) */
  file: string;
}

/** A DATE field picture (Word \@ "yyyy-MM-dd"): y / M / d / H / m; anything else is copied. */
export function formatDate(d: Date, picture = "yyyy-MM-dd"): string {
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  return picture.replace(/yyyy|yy|MM|M|dd|d|HH|H|mm/g, (k) => {
    switch (k) {
      case "yyyy":
        return String(d.getFullYear());
      case "yy":
        return pad(d.getFullYear() % 100, 2);
      case "MM":
        return pad(d.getMonth() + 1, 2);
      case "M":
        return String(d.getMonth() + 1);
      case "dd":
        return pad(d.getDate(), 2);
      case "d":
        return String(d.getDate());
      case "HH":
        return pad(d.getHours(), 2);
      case "H":
        return String(d.getHours());
      default:
        return pad(d.getMinutes(), 2);
    }
  });
}

/** The date picture of a field code (` DATE \@ "yyyy. M. d." `), else the default. */
const datePicture = (code?: string) => /\\@\s*"([^"]*)"/.exec(code ?? "")?.[1] ?? /\\@\s*(\S+)/.exec(code ?? "")?.[1] ?? "yyyy-MM-dd";

/** The value a field shows on a page. */
export function fieldValue(r: Pick<TextRun, "field" | "fieldCode" | "text">, env: FieldEnv): string {
  switch (r.field) {
    case "page":
      return env.page;
    case "pages":
      return String(env.pages);
    case "secpages":
      return String(env.secPages);
    case "date":
      return formatDate(env.date, datePicture(r.fieldCode));
    case "file":
      return env.file;
    default:
      return r.text;
  }
}

/** Paragraphs with every field showing its value (unchanged paragraphs keep their identity). */
export function resolveFields(paras: readonly TextParagraph[], env: FieldEnv): TextParagraph[] {
  return paras.map((p) => {
    if (!p.runs.some((r) => r.field)) return p;
    return { ...p, runs: p.runs.map((r) => (r.field ? { ...r, text: fieldValue(r, env) } : r)) };
  });
}

/** A field run in the look of `like` (its text the value it shows now). */
export const fieldRun = (field: FieldKind, like: Partial<TextRun> = {}, text = field === "date" || field === "file" ? " " : "1"): TextRun => {
  const { field: _f, fieldCode: _c, ...fmt } = like as TextRun;
  return { ...DEFAULT_RUN, fontSize: HF_SIZE, ...(fmt as Partial<TextRun>), text, field };
};

/** A new empty header / footer paragraph (10 pt, single line, no space after). */
export function newHfParagraph(text = "", align: TextParagraph["align"] = "LEFT", run: Partial<TextRun> = {}): TextParagraph {
  return { id: uid("p"), runs: [{ ...DEFAULT_RUN, fontSize: HF_SIZE, ...run, text }], align, lineSpacing: 1.2, indent: 0, spaceAfter: 0 };
}

let today = { day: "", date: new Date() };
/** Today, the same Date object all day (so drawn headers stay cached). */
function todayDate(): Date {
  const now = new Date();
  const day = now.toDateString();
  if (day !== today.day) today = { day, date: now };
  return today.date;
}

export function fieldEnv(doc: Pick<OmwDocument, "pages" | "title">, i: number): FieldEnv {
  const info = hfInfo(doc.pages);
  const pi = info.pages[i];
  return {
    page: pi ? formatPageNumber(pi.num, pi.fmt) : String(i + 1),
    pages: doc.pages.length,
    secPages: pi ? pi.end - pi.start : doc.pages.length,
    date: todayDate(),
    file: doc.title,
  };
}

// ───────── drawing ─────────

export const hfNodeId = (pageId: string, area: HFArea | "pagenum") => `hf:${pageId}:${area}`;
/** The page and area of a header / footer node id (null for any other id). */
export function parseHfId(id: string): { pageId: string; area: HFArea } | null {
  const m = /^hf:(.+):(header|footer)$/.exec(id);
  return m ? { pageId: m[1], area: m[2] as HFArea } : null;
}

function textNode(id: string, name: string, paras: TextParagraph[], x: number, y: number, width: number): TextNode {
  return {
    id,
    name,
    visible: true,
    locked: true,
    opacity: 1,
    blendMode: "NORMAL",
    transform: { ...IDENTITY, x, y },
    type: "TEXT",
    width,
    paragraphs: paras,
    wordBreak: "keep-all",
    background: null,
  };
}

/** Header / footer text box of a page: inside the side margins, the header from its distance down, the footer up to its distance. */
function placeNode(page: Page, area: HFArea | "pagenum", paras: TextParagraph[], bottom: boolean): TextNode {
  const m = marginsOf(page);
  const width = Math.max(16, page.width - m.left - m.right);
  const node = textNode(hfNodeId(page.id, area), area, paras, m.left, m.header, width);
  if (bottom) node.transform.y = page.height - m.footer - layoutText(node).height;
  return node;
}

const hfHeightMemo = new WeakMap<readonly TextParagraph[], { w: number; h: number }>();
/** Height of header / footer paragraphs laid out `width` wide (with each paragraph's space after, as Word counts it). */
function hfHeight(paras: readonly TextParagraph[] | undefined, width: number): number {
  if (!paras?.length) return 0;
  const hit = hfHeightMemo.get(paras);
  if (hit && hit.w === width) return hit.h;
  const h = layoutText(textNode("", "", paras as TextParagraph[], 0, 0, width)).height;
  hfHeightMemo.set(paras, { w: width, h });
  return h;
}

/**
 * Word: a header longer than the room above the body pushes the body down (the body starts below the header's last
 * paragraph, its space after included), and a long footer pushes the body's end up. 0 / 0 when they fit or there is
 * none (and for 한글 pages, whose header and footer areas are fixed: a long header runs over the body there).
 */
export function hfPush(pages: readonly Page[], i: number): { top: number; bottom: number } {
  const page = pages[i];
  if (!page || page.kind !== "DOCUMENT" || page.source?.format === "hwpx") return { top: 0, bottom: 0 };
  const m = marginsOf(page);
  const width = Math.max(16, page.width - m.left - m.right);
  const head = hfHeight(hfContent(pages, i, "header"), width);
  const foot = hfHeight(hfContent(pages, i, "footer"), width);
  // no header (footer) at all: nothing pushes, however far down the header distance is (Word 2021 PDF: a page with
  // header distance 42.6 pt under a 36 pt top margin and no header part starts its body at the margin)
  return { top: head > 0 ? Math.max(0, m.header + head - m.top) : 0, bottom: foot > 0 ? Math.max(0, m.footer + foot - m.bottom) : 0 };
}

const ALIGN_OF: Record<string, TextParagraph["align"]> = { left: "LEFT", center: "CENTER", right: "RIGHT" };

/** Alignment of a page number placed at `pos` on a page with number `num` (outside = right on odd pages). */
export function pageNumAlign(pos: PageNumPos, num: number): TextParagraph["align"] {
  const h = pos.split("-")[1];
  if (h === "outside") return num % 2 ? "RIGHT" : "LEFT";
  if (h === "inside") return num % 2 ? "LEFT" : "RIGHT";
  return ALIGN_OF[h] ?? "CENTER";
}

/** Text of a page number placed by itself ("- 1 -" with a side character). */
export const pageNumText = (shown: string, side?: string) => (side ? `${side} ${shown} ${side}` : shown);

const nodeMemo = new WeakMap<Page, { deps: unknown[]; nodes: TextNode[] }>();

/** The header / footer / page number text nodes page `i` of `doc` shows (empty for pages that are not document pages). */
export function hfNodesAt(doc: Pick<OmwDocument, "pages" | "title">, i: number): TextNode[] {
  const page = doc.pages[i];
  if (!page || page.kind !== "DOCUMENT") return [];
  const pages = doc.pages;
  const header = hfContent(pages, i, "header");
  const footer = hfContent(pages, i, "footer");
  const pn = pageNumAt(pages, i);
  if (!header?.length && !footer?.length && !pn) return [];
  const env = fieldEnv(doc, i);
  const num = hfInfo(pages).pages[i].num;
  const deps = [header, footer, pn, env.page, env.pages, env.secPages, env.date, env.file, page.width, page.height, page.margins, page.id, num];
  const hit = nodeMemo.get(page);
  if (hit && hit.deps.length === deps.length && hit.deps.every((d, k) => d === deps[k])) return hit.nodes;
  const nodes: TextNode[] = [];
  if (header?.length) nodes.push(placeNode(page, "header", resolveFields(header, env), false));
  const foot = footer?.length ? placeNode(page, "footer", resolveFields(footer, env), true) : null;
  if (foot) nodes.push(foot);
  if (pn) {
    const para = newHfParagraph(pageNumText(env.page, pn.side), pageNumAlign(pn.pos, num));
    para.id = `${page.id}-pn`;
    const bottom = pn.pos.startsWith("bottom");
    const node = placeNode(page, "pagenum", [para], bottom);
    // Word's page number frame (w:framePr vAnchor text, read as the page number placed by itself) stands at the top
    // of the footer paragraph after it, beside the footer's first line (Word PDF of a DOC: the number on that line)
    if (bottom && foot && (page.source?.format === "docx" || page.source?.format === "doc")) node.transform.y = foot.transform.y;
    nodes.push(node);
  }
  nodeMemo.set(page, { deps, nodes });
  return nodes;
}

const masterMemo = new WeakMap<Page, { base: Page | null; nodes: TextNode[]; out: Page }>();

/**
 * The master a page is drawn with: its master page plus its header, footer and page number (or the master alone /
 * null). The same object while nothing it shows changed (renderers and thumbnails cache by identity).
 */
export function renderMasterOf(doc: Pick<OmwDocument, "pages" | "masters" | "title" | "theme">, page: Page): Page | null {
  // (a layout edited here: its master under its own decoration — core/slideLayouts.ts)
  const base = layoutChain(doc, page.masterId ? doc.masters.find((m) => m.id === page.masterId) ?? null : null);
  // a slide's 머리글/바닥글 (date, footer, number: core/slideHf.ts) is drawn with its master
  if (page.kind === "SLIDE" && page.slideHf) return slideMasterOf(doc, page, base);
  if (page.kind !== "DOCUMENT") return base;
  let i = doc.pages.indexOf(page);
  if (i < 0) i = doc.pages.findIndex((p) => p.id === page.id);
  if (i < 0) return base;
  const nodes = hfNodesAt(doc, i);
  if (!nodes.length) return base;
  const hit = masterMemo.get(page);
  if (hit && hit.base === base && hit.nodes === nodes) return hit.out;
  const out: Page = base
    ? { ...base, nodes: [...base.nodes, ...nodes] }
    : { id: `hf-master:${page.id}`, name: "", kind: "MASTER", width: page.width, height: page.height, background: "rgba(0,0,0,0)", nodes, masterId: null, transition: { type: "NONE", duration: 0 }, animations: [] };
  masterMemo.set(page, { base, nodes, out });
  return out;
}

const slideMemo = new WeakMap<Page, { base: Page | null; key: string; out: Page }>();

/** A slide's master with its foot (date, footer, slide number) added; the same object while they show the same. */
function slideMasterOf(doc: Pick<OmwDocument, "pages" | "theme">, page: Page, base: Page | null): Page | null {
  const key = hfKey(doc, page);
  if (!key) return base;
  const hit = slideMemo.get(page);
  if (hit && hit.base === base && hit.key === key) return hit.out;
  const nodes = hfNodes(doc, page);
  const out: Page = base
    ? { ...base, nodes: [...base.nodes, ...nodes] }
    : { id: `hf-master:${page.id}`, name: "", kind: "MASTER", width: page.width, height: page.height, background: "rgba(0,0,0,0)", nodes, masterId: null, transition: { type: "NONE", duration: 0 }, animations: [] };
  slideMemo.set(page, { base, key, out });
  return out;
}

// ───────── editing in place ─────────

/** Window event asking the canvas to edit the current page's header / footer (detail: { area }). */
export const HF_EDIT_EVENT = "omw:edit-header-footer";

/** The margin a point of a document page is in: above the body = header, below = footer (else null). */
export function hfAreaAt(page: Pick<Page, "kind" | "height" | "margins">, y: number): HFArea | null {
  if (page.kind !== "DOCUMENT") return null;
  const m = marginsOf(page);
  return y < m.top ? "header" : y > page.height - m.bottom ? "footer" : null;
}

const editMemo = new WeakMap<readonly Page[], Map<string, TextNode | undefined>>();

/**
 * The text node the editor works on for a page's header or footer (id hfNodeId): the paragraphs that page shows —
 * fields with this page's values — or one empty paragraph, placed where they are drawn. Same object per document state.
 */
export function hfEditNode(doc: Pick<OmwDocument, "pages" | "title">, id: string): TextNode | undefined {
  const ref = parseHfId(id);
  if (!ref) return undefined;
  let memo = editMemo.get(doc.pages);
  if (!memo) editMemo.set(doc.pages, (memo = new Map()));
  if (memo.has(id)) return memo.get(id);
  const i = doc.pages.findIndex((p) => p.id === ref.pageId);
  let node: TextNode | undefined;
  if (i >= 0 && doc.pages[i].kind === "DOCUMENT") {
    const shown = hfContent(doc.pages, i, ref.area);
    const paras = shown?.length ? resolveFields(shown, fieldEnv(doc, i)) : [newHfParagraph()];
    node = placeNode(doc.pages[i], ref.area, paras, ref.area === "footer");
    node.locked = false;
    node.name = ref.area;
  }
  memo.set(id, node);
  return node;
}

const cleanHF = (hf: SectionHF): SectionHF | undefined => {
  for (const a of HF_AREAS) if (hf[a] && !Object.keys(hf[a]!).length) delete hf[a];
  return Object.keys(hf).length ? hf : undefined;
};

/** Set (or with undefined, clear) a section's hf fields, on plain pages or a draft. */
export function patchSectionHF(pages: Page[], start: number, patch: Partial<Record<keyof SectionHF, unknown>>) {
  const pg = pages[start];
  if (!pg) return;
  const hf: SectionHF = { ...(pg.hf ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete (hf as Record<string, unknown>)[k];
    else (hf as Record<string, unknown>)[k] = v;
  }
  const out = cleanHF(hf);
  if (out) pg.hf = out;
  else delete pg.hf;
}

/**
 * Store edited paragraphs of the header / footer page `pageId` shows: into the section that defines what it shows
 * (editing a linked header edits the one it is linked to, as in Word), else into the page's own section.
 */
export function setHfParas(pages: Page[], pageId: string, area: HFArea, paras: TextParagraph[]) {
  const i = pages.findIndex((p) => p.id === pageId);
  if (i < 0) return;
  const info = hfInfo(pages);
  const pi = info.pages[i];
  const owner = variantOwner(pages, info, pi.section, area, pi.variant);
  const start = info.runs[owner < 0 ? pi.section : owner].start;
  const cur: HFVariants = { ...(pages[start].hf?.[area] ?? {}) };
  cur[pi.variant] = paras.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r })) }));
  patchSectionHF(pages, start, { [area]: cur });
}

/** First page of the section holding page `i` (where its hf lives). */
export const sectionStartOf = (pages: readonly Page[], i: number) => hfInfo(pages).pages[i]?.start ?? 0;

/** A copy of paragraphs with new ids (an unlinked header gets its own paragraphs). */
const copyParas = (ps: readonly TextParagraph[]) => ps.map((p) => ({ ...p, id: uid("p"), runs: p.runs.map((r) => ({ ...r })) }));

/**
 * Link (true) or unlink (false) the section of page `i`'s `area` variant `v` to the section before: linking drops the
 * section's own variant, unlinking gives it a copy of what it showed.
 */
export function setLinked(pages: Page[], i: number, area: HFArea, v: HFVariant, linked: boolean) {
  const info = hfInfo(pages);
  const pi = info.pages[i];
  if (!pi) return;
  const own = pages[pi.start].hf?.[area]?.[v];
  if (linked === !own) return;
  const cur: HFVariants = { ...(pages[pi.start].hf?.[area] ?? {}) };
  if (linked) delete cur[v];
  else {
    const o = pi.section > 0 ? variantOwner(pages, info, pi.section - 1, area, v) : -1;
    cur[v] = o < 0 ? [] : copyParas(sectionHF(pages, info, o)![area]![v]!);
  }
  patchSectionHF(pages, pi.start, { [area]: cur });
}

/** Whether the section of page `i` takes `area` variant `v` from a section before it. */
export function isLinked(pages: readonly Page[], i: number, area: HFArea, v: HFVariant): boolean {
  const pi = hfInfo(pages).pages[i];
  return !!pi && pi.section > 0 && !pages[pi.start].hf?.[area]?.[v];
}

/** 쪽 번호 넣기: a page number placed at `pos` in the section of page `i` (and the sections after it), format / start. */
export function insertPageNumber(pages: Page[], i: number, opts: { pos: PageNumPos | null; fmt?: PageNumFormat; start?: number | null; side?: string }) {
  const start = sectionStartOf(pages, i);
  patchSectionHF(pages, start, {
    pageNum: opts.pos ? { pos: opts.pos, ...(opts.side ? { side: opts.side } : {}) } : null,
    ...(opts.fmt ? { pageFmt: opts.fmt === "decimal" ? undefined : opts.fmt } : {}),
    ...(opts.start !== undefined ? { pageStart: opts.start ?? undefined } : {}),
  });
}

/** Different first page (also hides a page number placed by itself on it, as Word's cover pages do). */
export function setTitlePage(pages: Page[], i: number, on: boolean) {
  patchSectionHF(pages, sectionStartOf(pages, i), { titlePg: on || undefined, hideFirstNum: on || undefined });
}

/** Different odd and even pages (the document's setting, kept on its first page). */
export function setEvenOdd(pages: Page[], on: boolean) {
  if (pages.length) patchSectionHF(pages, 0, { evenOdd: on || undefined });
}

/** A field run inserted into header / footer text is a field of this page: its value right now. */
export function fieldNow(doc: Pick<OmwDocument, "pages" | "title">, i: number, field: FieldKind, like: Partial<TextRun> = {}): TextRun {
  const r = fieldRun(field, like);
  return { ...r, text: fieldValue(r, fieldEnv(doc, i)) };
}

/** Plain text of the header or footer a page shows (fields with that page's values), for tests and accessibility. */
export function hfText(doc: Pick<OmwDocument, "pages" | "title">, i: number, area: HFArea): string {
  const c = hfContent(doc.pages, i, area);
  return c ? resolveFields(c, fieldEnv(doc, i)).map((p) => p.runs.map((r) => r.text).join("")).join("\n") : "";
}
