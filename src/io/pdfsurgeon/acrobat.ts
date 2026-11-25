// PDF Surgeon — Acrobat's document tools that change the whole file (Acrobat ▸ 도구):
//   stamps      watermark (text / picture, opacity, rotation, page range, in front / behind), header & footer
//               (page numbers, date, Bates numbers in six places), background (colour / picture)
//   navigation  bookmarks (read / write the outline tree, page links, open state), link annotations (page / URL),
//               page labels (/PageLabels: i, ii … 1, 2 …)
//   forms       new fields (text, check box, radio, list, drop-down, button, signature) with name, required flag,
//               number / date format and the page's tab order
//   pages       replace pages with pages of another file, crop box
//   archive     PDF/A-2b basics (XMP identification, sRGB output intent, document ID)
// Every function takes the file's bytes and returns a new, fully rewritten file (no incremental update: what is
// replaced is gone). Coordinates are PDF user space; "display" space is the page as shown (its /Rotate applied).

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import { padTtfSubsetGlyphs } from "../fontkitPatch";
import { collectGarbage } from "../pdfOptimize";

export type RGB = [number, number, number];
/** x0, y0, x1, y1 in PDF user space */
export type Rect = [number, number, number, number];

const LOAD = { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false } as const;
export const loadPdf = (bytes: Uint8Array) => PDFDocument.load(bytes, LOAD);

/** The whole file written again without what nothing refers to any more (replaced streams, old outline …). */
export async function savePdf(d: PDFDocument): Promise<Uint8Array> {
  collectGarbage(d.context);
  return d.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

// ───────── page ranges ─────────

/** "1-3, 5, 8-" → 0-based indices (sorted, unique, within 0..n-1); empty / "all" / "전체" → every page. */
export function parsePageRange(spec: string | undefined, n: number): number[] {
  const s = (spec ?? "").trim();
  if (!s || /^(all|\uC804\uCCB4|\uBAA8\uB450)$/i.test(s)) return [...Array(n).keys()];
  const out = new Set<number>();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d*)\s*[-~]\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1, b = m[2] ? parseInt(m[2], 10) : n;
      for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(n, Math.max(a, b)); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const i = parseInt(part, 10);
      if (i >= 1 && i <= n) out.add(i - 1);
    } else if (/^(odd|\uD640\uC218)$/i.test(part)) for (let i = 0; i < n; i += 2) out.add(i);
    else if (/^(even|\uC9DD\uC218)$/i.test(part)) for (let i = 1; i < n; i += 2) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

// ───────── display space ─────────

/** The page as shown: its size and the matrix display → user space (origin bottom-left of the shown page). */
export function displayOf(page: PDFPage): { W: number; H: number; m: number[] } {
  const b = page.getCropBox();
  const r = (((page.getRotation().angle ?? 0) % 360) + 360) % 360;
  const x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
  if (r === 90) return { W: b.height, H: b.width, m: [0, 1, -1, 0, x1, y0] };
  if (r === 180) return { W: b.width, H: b.height, m: [-1, 0, 0, -1, x1, y1] };
  if (r === 270) return { W: b.height, H: b.width, m: [0, -1, 1, 0, x0, y1] };
  return { W: b.width, H: b.height, m: [1, 0, 0, 1, x0, y0] };
}

const f = (n: number) => (Number.isFinite(n) ? (Math.abs(n) < 1e-9 ? "0" : Number(n.toFixed(4)).toString()) : "0");
const mat = (m: number[]) => m.map(f).join(" ") + " cm";
const col = (c: RGB) => c.map((v) => f(Math.max(0, Math.min(1, v)))).join(" ");

// ───────── fonts ─────────

const WIN_ANSI = /^[\x20-\x7e -ÿ\r\n\t]*$/;

/** Helvetica for Latin text; the given TrueType (subset) for anything else — Korean among it. */
export async function fontFor(d: PDFDocument, text: string, fontBytes?: () => Promise<Uint8Array>, bold = false): Promise<PDFFont> {
  if (WIN_ANSI.test(text) || !fontBytes) return d.embedFont(bold ? StandardFonts.HelveticaBold : StandardFonts.Helvetica);
  d.registerFontkit((await import("@pdf-lib/fontkit")).default);
  const font = await d.embedFont(await fontBytes(), { subset: true });
  padTtfSubsetGlyphs((font as unknown as { embedder?: { subset?: object } }).embedder?.subset);
  return font;
}

/** Characters the standard font cannot write are left out (only when no TrueType was given). */
const safeText = (font: PDFFont, s: string) => {
  try {
    font.encodeText(s);
    return s;
  } catch {
    return Array.from(s).filter((ch) => {
      try {
        font.encodeText(ch);
        return true;
      } catch {
        return false;
      }
    }).join("");
  }
};

// ───────── drawing on a page ─────────

let resSeq = 0;
/** Resource names for what an overlay draws (fonts, pictures, transparency) on this page. */
class PageRes {
  constructor(readonly page: PDFPage) {
    page.node.normalize();
  }
  font(font: PDFFont): string {
    return this.page.node.newFontDictionary("OmwF" + ++resSeq, font.ref).decodeText();
  }
  image(img: PDFImage): string {
    return this.page.node.newXObject("OmwI" + ++resSeq, img.ref).decodeText();
  }
  alpha(fill: number, stroke = fill): string {
    const gs = this.page.doc.context.obj({ Type: "ExtGState", ca: fill, CA: stroke }) as PDFDict;
    return this.page.node.newExtGState("OmwG" + ++resSeq, this.page.doc.context.register(gs)).decodeText();
  }
}

/** Add operators to the page in front of (wrapped in q … Q) or behind its content. */
export function addContent(page: PDFPage, ops: string, behind = false) {
  const ctx = page.doc.context;
  page.node.normalize();
  const ref = ctx.register(ctx.flateStream(`q\n${ops}\nQ\n`));
  const cur = page.node.get(PDFName.of("Contents"));
  const arr = ctx.lookup(cur);
  const list: PDFRef[] = arr instanceof PDFArray ? (arr.asArray() as PDFRef[]) : cur instanceof PDFRef ? [cur] : [];
  if (behind) page.node.set(PDFName.of("Contents"), ctx.obj([ref, ...list]));
  else {
    // the page's own content in q … Q, so a matrix it leaves set does not move what comes after
    const qs = ctx.register(ctx.stream("q\n"));
    const Qs = ctx.register(ctx.stream("\nQ\n"));
    page.node.set(PDFName.of("Contents"), ctx.obj([qs, ...list, Qs, ref]));
  }
}

/** Text drawn at a display-space position: `anchor` 0 = left, 0.5 = centre, 1 = right of x; y is the baseline. */
function textOps(res: PageRes, font: PDFFont, text: string, x: number, y: number, size: number, color: RGB, anchor = 0): string {
  const s = safeText(font, text);
  if (!s) return "";
  const w = font.widthOfTextAtSize(s, size);
  return `BT /${res.font(font)} ${f(size)} Tf ${col(color)} rg ${f(x - w * anchor)} ${f(y)} Td ${font.encodeText(s).toString()} Tj ET`;
}

// ───────── watermark ─────────

export interface WatermarkOptions {
  text?: string;
  image?: { bytes: Uint8Array; mime: string };
  fontSize?: number;
  /** the picture's width as a share of the page width (0..1) */
  scale?: number;
  color?: RGB;
  opacity?: number;
  /** degrees, counter-clockwise as shown */
  rotation?: number;
  pages?: string;
  /** "center" or a corner / edge: "top" "bottom" "top-left" … */
  position?: "center" | "top" | "bottom" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
  behind?: boolean;
  font?: () => Promise<Uint8Array>;
  bold?: boolean;
}

export async function addWatermark(bytes: Uint8Array, o: WatermarkOptions): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const pages = d.getPages();
  const text = (o.text ?? "").trim();
  if (!text && !o.image) throw new Error("watermark: nothing to place");
  const font = text ? await fontFor(d, text, o.font, o.bold ?? true) : null;
  const img = o.image ? (/png/i.test(o.image.mime) ? await d.embedPng(o.image.bytes) : await d.embedJpg(o.image.bytes)) : null;
  const rot = ((o.rotation ?? 45) * Math.PI) / 180;
  for (const i of parsePageRange(o.pages, pages.length)) {
    const page = pages[i];
    const res = new PageRes(page);
    const { W, H, m } = displayOf(page);
    let w: number, h: number, body: string;
    if (font) {
      const size = o.fontSize ?? Math.max(12, Math.min(W, H) / Math.max(4, Array.from(text).length * 0.62));
      const s = safeText(font, text);
      w = font.widthOfTextAtSize(s, size);
      h = font.heightAtSize(size, { descender: false });
      body = `BT /${res.font(font)} ${f(size)} Tf ${col(o.color ?? [0.5, 0.5, 0.5])} rg ${f(-w / 2)} ${f(-h / 2.6)} Td ${font.encodeText(s).toString()} Tj ET`;
    } else {
      const k = (W * (o.scale ?? 0.5)) / img!.width;
      w = img!.width * k;
      h = img!.height * k;
      body = `${f(w)} 0 0 ${f(h)} ${f(-w / 2)} ${f(-h / 2)} cm /${res.image(img!)} Do`;
    }
    const pos = o.position ?? "center";
    const ext = Math.abs(w * Math.cos(rot)) / 2 + Math.abs(h * Math.sin(rot)) / 2;
    const exty = Math.abs(w * Math.sin(rot)) / 2 + Math.abs(h * Math.cos(rot)) / 2;
    const margin = 36;
    const cx = pos.endsWith("left") ? margin + ext : pos.endsWith("right") ? W - margin - ext : W / 2;
    const cy = pos.startsWith("top") ? H - margin - exty : pos.startsWith("bottom") ? margin + exty : H / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    const ops = `${mat(m)} 1 0 0 1 ${f(cx)} ${f(cy)} cm ${f(c)} ${f(s)} ${f(-s)} ${f(c)} 0 0 cm /${res.alpha(o.opacity ?? 0.3)} gs ${body}`;
    addContent(page, ops, !!o.behind);
  }
  return savePdf(d);
}

// ───────── header & footer ─────────

export type HfSlot = "topLeft" | "topCenter" | "topRight" | "bottomLeft" | "bottomCenter" | "bottomRight";
export interface HeaderFooterOptions {
  /** text of each place; tokens: {page} {pages} {date} {bates} */
  slots: Partial<Record<HfSlot, string>>;
  fontSize?: number;
  color?: RGB;
  /** distance from the page edges in pt */
  margin?: { top?: number; bottom?: number; left?: number; right?: number };
  pages?: string;
  /** page number of the first page the range starts at */
  startNumber?: number;
  date?: Date;
  /** yyyy-mm-dd · yyyy.mm.dd · mm/dd/yyyy · yyyy년 m월 d일 */
  dateFormat?: string;
  bates?: { prefix?: string; suffix?: string; start?: number; digits?: number };
  font?: () => Promise<Uint8Array>;
}

export function formatDate(d: Date, fmt = "yyyy-mm-dd"): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/mm/g, p2(d.getMonth() + 1))
    .replace(/dd/g, p2(d.getDate()))
    .replace(/(^|[^a-z])m(?=[^a-z]|$)/g, (_, a) => a + (d.getMonth() + 1))
    .replace(/(^|[^a-z])d(?=[^a-z]|$)/g, (_, a) => a + d.getDate());
}

export const batesNumber = (b: NonNullable<HeaderFooterOptions["bates"]>, k: number) => (b.prefix ?? "") + String((b.start ?? 1) + k).padStart(b.digits ?? 6, "0") + (b.suffix ?? "");

export function expandTokens(s: string, v: { page: number; pages: number; date: string; bates: string }) {
  return s.replace(/\{page\}/g, String(v.page)).replace(/\{pages\}/g, String(v.pages)).replace(/\{date\}/g, v.date).replace(/\{bates\}/g, v.bates);
}

export async function addHeaderFooter(bytes: Uint8Array, o: HeaderFooterOptions): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const pages = d.getPages();
  const list = parsePageRange(o.pages, pages.length);
  const date = formatDate(o.date ?? new Date(), o.dateFormat);
  const all = Object.values(o.slots).join(" ") + date + (o.bates?.prefix ?? "") + (o.bates?.suffix ?? "");
  const font = await fontFor(d, all, o.font, false);
  const size = o.fontSize ?? 10;
  const mg = { top: 28, bottom: 28, left: 36, right: 36, ...o.margin };
  list.forEach((i, k) => {
    const page = pages[i];
    const res = new PageRes(page);
    const { W, H, m } = displayOf(page);
    const vals = { page: (o.startNumber ?? 1) + k, pages: list.length + (o.startNumber ?? 1) - 1, date, bates: o.bates ? batesNumber(o.bates, k) : "" };
    const parts: string[] = [];
    for (const [slot, raw] of Object.entries(o.slots) as [HfSlot, string][]) {
      if (!raw?.trim()) continue;
      const text = expandTokens(raw, vals);
      const top = slot.startsWith("top");
      const y = top ? H - mg.top - size * 0.8 : mg.bottom;
      const anchor = slot.endsWith("Left") ? 0 : slot.endsWith("Right") ? 1 : 0.5;
      const x = anchor === 0 ? mg.left : anchor === 1 ? W - mg.right : W / 2;
      parts.push(textOps(res, font, text, x, y, size, o.color ?? [0, 0, 0], anchor));
    }
    if (parts.length) addContent(page, `${mat(m)} ${parts.join("\n")}`);
  });
  return savePdf(d);
}

// ───────── background ─────────

export interface BackgroundOptions {
  color?: RGB;
  image?: { bytes: Uint8Array; mime: string };
  opacity?: number;
  pages?: string;
}

export async function addBackground(bytes: Uint8Array, o: BackgroundOptions): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const pages = d.getPages();
  const img = o.image ? (/png/i.test(o.image.mime) ? await d.embedPng(o.image.bytes) : await d.embedJpg(o.image.bytes)) : null;
  for (const i of parsePageRange(o.pages, pages.length)) {
    const page = pages[i];
    const res = new PageRes(page);
    const { W, H, m } = displayOf(page);
    const a = `/${res.alpha(o.opacity ?? 1)} gs`;
    const body = img ? (() => {
      // the picture covers the page, keeping its proportions (centred)
      const k = Math.max(W / img.width, H / img.height);
      const w = img.width * k, h = img.height * k;
      return `0 0 ${f(W)} ${f(H)} re W n ${f(w)} 0 0 ${f(h)} ${f((W - w) / 2)} ${f((H - h) / 2)} cm /${res.image(img)} Do`;
    })() : `${col(o.color ?? [1, 1, 0.9])} rg 0 0 ${f(W)} ${f(H)} re f`;
    addContent(page, `${mat(m)} ${a} ${body}`, true);
  }
  return savePdf(d);
}

// ───────── bookmarks ─────────

export interface Bookmark {
  title: string;
  /** 0-based page it opens, null when it has no page in this file */
  page: number | null;
  /** a web address instead of a page */
  url?: string;
  /** where on the page (user-space y of the top), when known */
  top?: number | null;
  open?: boolean;
  bold?: boolean;
  italic?: boolean;
  color?: RGB;
  children: Bookmark[];
}

function nameTree(d: PDFDocument, root: PDFDict | undefined, out = new Map<string, unknown>(), depth = 0): Map<string, unknown> {
  if (!root || depth > 32) return out;
  const ctx = d.context;
  const names = ctx.lookup(root.get(PDFName.of("Names")));
  if (names instanceof PDFArray)
    for (let i = 0; i + 1 < names.size(); i += 2) {
      const k = ctx.lookup(names.get(i));
      const key = k instanceof PDFString || k instanceof PDFHexString ? k.decodeText() : String(k);
      out.set(key, names.get(i + 1));
    }
  const kids = ctx.lookup(root.get(PDFName.of("Kids")));
  if (kids instanceof PDFArray) for (const kid of kids.asArray()) nameTree(d, ctx.lookup(kid) as PDFDict, out, depth + 1);
  return out;
}

/** Named destinations of the file (catalog /Names /Dests and the old catalog /Dests). */
function namedDests(d: PDFDocument): Map<string, unknown> {
  const ctx = d.context;
  const out = new Map<string, unknown>();
  const names = ctx.lookup(d.catalog.get(PDFName.of("Names")));
  if (names instanceof PDFDict) nameTree(d, ctx.lookup(names.get(PDFName.of("Dests"))) as PDFDict, out);
  const old = ctx.lookup(d.catalog.get(PDFName.of("Dests")));
  if (old instanceof PDFDict) for (const [k, v] of old.entries()) out.set(k.decodeText(), v);
  return out;
}

const textOfObj = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o instanceof PDFName ? o.decodeText() : undefined);

/** A destination (array, name or string, or a dictionary with /D) → page index and top. */
function resolveDest(d: PDFDocument, dest: unknown, pageIdx: Map<string, number>, named: () => Map<string, unknown>, depth = 0): { page: number | null; top: number | null } {
  const ctx = d.context;
  let v = dest instanceof PDFRef ? ctx.lookup(dest) : dest;
  const nm = textOfObj(v);
  if (nm !== undefined && depth < 4) return resolveDest(d, named().get(nm), pageIdx, named, depth + 1);
  if (v instanceof PDFDict) v = ctx.lookup(v.get(PDFName.of("D")));
  if (!(v instanceof PDFArray) || !v.size()) return { page: null, top: null };
  const p = v.get(0);
  let page: number | null = null;
  if (p instanceof PDFRef) page = pageIdx.get(p.toString()) ?? null;
  else if (p instanceof PDFNumber) page = p.asNumber(); // remote-style index
  const kind = v.get(1) instanceof PDFName ? (v.get(1) as PDFName).decodeText() : "";
  const top = kind === "XYZ" ? (ctx.lookup(v.get(3)) instanceof PDFNumber ? (ctx.lookup(v.get(3)) as PDFNumber).asNumber() : null) : kind === "FitH" || kind === "FitBH" ? (ctx.lookup(v.get(2)) instanceof PDFNumber ? (ctx.lookup(v.get(2)) as PDFNumber).asNumber() : null) : null;
  return { page, top };
}

export function readOutline(d: PDFDocument): Bookmark[] {
  const ctx = d.context;
  const pageIdx = new Map(d.getPages().map((p, i) => [p.ref.toString(), i]));
  let named: Map<string, unknown> | null = null;
  const getNamed = () => (named ??= namedDests(d));
  const root = ctx.lookup(d.catalog.get(PDFName.of("Outlines")));
  if (!(root instanceof PDFDict)) return [];
  const seen = new Set<string>();
  const walk = (first: unknown, depth: number): Bookmark[] => {
    const out: Bookmark[] = [];
    let ref = first;
    for (let guard = 0; ref instanceof PDFRef && guard < 100000; guard++) {
      if (seen.has(ref.toString()) || depth > 64) break;
      seen.add(ref.toString());
      const it = ctx.lookup(ref);
      if (!(it instanceof PDFDict)) break;
      const title = textOfObj(ctx.lookup(it.get(PDFName.of("Title")))) ?? "";
      let dest: { page: number | null; top: number | null } = { page: null, top: null };
      let url: string | undefined;
      const dst = it.get(PDFName.of("Dest"));
      if (dst) dest = resolveDest(d, dst, pageIdx, getNamed);
      const a = ctx.lookup(it.get(PDFName.of("A")));
      if (a instanceof PDFDict) {
        const s = (ctx.lookup(a.get(PDFName.of("S"))) as PDFName | undefined)?.decodeText?.();
        if (s === "GoTo") dest = resolveDest(d, a.get(PDFName.of("D")), pageIdx, getNamed);
        if (s === "URI") url = textOfObj(ctx.lookup(a.get(PDFName.of("URI"))));
      }
      const count = ctx.lookup(it.get(PDFName.of("Count")));
      const flags = ctx.lookup(it.get(PDFName.of("F")));
      const fl = flags instanceof PDFNumber ? flags.asNumber() : 0;
      const c = ctx.lookup(it.get(PDFName.of("C")));
      const color = c instanceof PDFArray && c.size() === 3 ? (c.asArray().map((x) => (ctx.lookup(x) as PDFNumber).asNumber()) as RGB) : undefined;
      out.push({
        title,
        page: dest.page,
        top: dest.top,
        url,
        open: count instanceof PDFNumber ? count.asNumber() > 0 : false,
        italic: !!(fl & 1) || undefined,
        bold: !!(fl & 2) || undefined,
        color: color && color.some((x) => x) ? color : undefined,
        children: walk(it.get(PDFName.of("First")), depth + 1),
      });
      ref = it.get(PDFName.of("Next"));
    }
    return out;
  };
  return walk(root.get(PDFName.of("First")), 0);
}

const visible = (l: Bookmark[]): number => l.reduce((n, b) => n + 1 + (b.open ? visible(b.children) : 0), 0);

/** Replace the file's outline with `list` (empty: the outline is removed). */
export function writeOutline(d: PDFDocument, list: Bookmark[]) {
  const ctx = d.context;
  const pages = d.getPages();
  if (!list.length) {
    d.catalog.delete(PDFName.of("Outlines"));
    return;
  }
  const rootRef = ctx.nextRef();
  const build = (items: Bookmark[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const refs = items.map(() => ctx.nextRef());
    items.forEach((b, i) => {
      const it = ctx.obj({}) as PDFDict;
      it.set(PDFName.of("Title"), PDFHexString.fromText(b.title || " "));
      it.set(PDFName.of("Parent"), parent);
      if (i > 0) it.set(PDFName.of("Prev"), refs[i - 1]);
      if (i < items.length - 1) it.set(PDFName.of("Next"), refs[i + 1]);
      if (b.url) it.set(PDFName.of("A"), ctx.obj({ S: "URI", URI: PDFString.of(b.url) }));
      else if (b.page != null && pages[b.page]) {
        const top = b.top ?? null;
        it.set(PDFName.of("Dest"), ctx.obj([pages[b.page].ref, PDFName.of("XYZ"), null, top == null ? null : top, null]));
      }
      if (b.color) it.set(PDFName.of("C"), ctx.obj(b.color));
      const fl = (b.italic ? 1 : 0) | (b.bold ? 2 : 0);
      if (fl) it.set(PDFName.of("F"), PDFNumber.of(fl));
      if (b.children.length) {
        const k = build(b.children, refs[i]);
        it.set(PDFName.of("First"), k.first);
        it.set(PDFName.of("Last"), k.last);
        const n = b.open ? visible(b.children) : -b.children.length;
        it.set(PDFName.of("Count"), PDFNumber.of(n));
      }
      ctx.assign(refs[i], it);
    });
    return { first: refs[0], last: refs[refs.length - 1] };
  };
  const k = build(list, rootRef);
  ctx.assign(rootRef, ctx.obj({ Type: "Outlines", First: k.first, Last: k.last, Count: visible(list) }));
  d.catalog.set(PDFName.of("Outlines"), rootRef);
  // the outline pane opens with the file, as Acrobat sets it when bookmarks are made
  if (!d.catalog.get(PDFName.of("PageMode"))) d.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

export async function setBookmarks(bytes: Uint8Array, list: Bookmark[]): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  writeOutline(d, list);
  return savePdf(d);
}

export async function getBookmarks(bytes: Uint8Array): Promise<Bookmark[]> {
  return readOutline(await loadPdf(bytes));
}

/** One line of a table of contents: "1.2 제목 ...... 12" → title + printed page number. */
export function tocLine(s: string): { title: string; num: number; level: number } | null {
  const m = /^\s*(.+?)[\s.·…‥_\-]{2,}\s*(\d{1,4})\s*$/.exec(s) ?? /^\s*(.+?\S)\s{2,}(\d{1,4})\s*$/.exec(s);
  if (!m) return null;
  const title = m[1].replace(/[.·…‥\s]+$/, "").trim();
  if (!title || title.length > 120 || /^\d+$/.test(title)) return null;
  const sec = /^(\d+(?:\.\d+)*)[.)]?\s/.exec(title);
  const level = sec ? sec[1].split(".").filter(Boolean).length - 1 : /^[\uAC00-\uD7A3]\.\s|^\(\d+\)\s|^[a-z]\)\s/.test(title) ? 1 : 0;
  return { title, num: parseInt(m[2], 10), level: Math.min(level, 3) };
}

/**
 * Bookmarks from the document's own table of contents (`lines`: each page's text lines, top to bottom). A title is
 * linked to the first later page whose lines start with it; otherwise to its printed page number, shifted by the
 * offset the found titles agree on. No table of contents: the lines in larger type become the bookmarks.
 */
export function bookmarksFromLines(lines: { text: string; size: number }[][]): Bookmark[] {
  const entries: { title: string; num: number; level: number; tocPage: number }[] = [];
  for (let p = 0; p < Math.min(lines.length, 12); p++) {
    const found = lines[p].map((l) => tocLine(l.text)).filter((x): x is NonNullable<typeof x> => !!x);
    if (found.length >= 3) entries.push(...found.map((e) => ({ ...e, tocPage: p })));
    else if (entries.length) break;
  }
  const norm = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  if (entries.length) {
    const after = entries[entries.length - 1].tocPage + 1;
    const offsets: number[] = [];
    const pageOf = entries.map((e) => {
      const key = norm(e.title).slice(0, 40);
      for (let p = after; p < lines.length; p++) if (lines[p].some((l) => norm(l.text).startsWith(key))) return (offsets.push(p - e.num), p);
      return null;
    });
    offsets.sort((a, b) => a - b);
    const off = offsets.length ? offsets[offsets.length >> 1] : after - 1;
    const flat = entries.map((e, i) => ({ level: e.level, b: { title: e.title, page: pageOf[i] ?? Math.max(0, Math.min(lines.length - 1, e.num + off)), open: true, children: [] } as Bookmark }));
    return nest(flat);
  }
  // headings: lines clearly larger than the body text
  const sizes = lines.flat().map((l) => l.size).filter((s) => s > 0).sort((a, b) => a - b);
  if (!sizes.length) return [];
  const body = sizes[sizes.length >> 1];
  const big = [...new Set(lines.flat().filter((l) => l.size >= body * 1.2 && l.text.trim().length > 1 && l.text.length < 100).map((l) => Math.round(l.size * 2) / 2))].sort((a, b) => b - a).slice(0, 3);
  const flat: { level: number; b: Bookmark }[] = [];
  lines.forEach((pl, p) =>
    pl.forEach((l) => {
      const lv = big.indexOf(Math.round(l.size * 2) / 2);
      if (lv >= 0 && l.text.trim().length > 1 && l.text.length < 100) flat.push({ level: lv, b: { title: l.text.trim(), page: p, open: true, children: [] } });
    }),
  );
  return nest(flat.slice(0, 500));
}

function nest(flat: { level: number; b: Bookmark }[]): Bookmark[] {
  const root: Bookmark[] = [];
  const stack: { level: number; b: Bookmark }[] = [];
  for (const e of flat) {
    while (stack.length && stack[stack.length - 1].level >= e.level) stack.pop();
    (stack.length ? stack[stack.length - 1].b.children : root).push(e.b);
    stack.push(e);
  }
  return root;
}

// ───────── links ─────────

export interface NewLink {
  page: number;
  rect: Rect;
  /** go to this 0-based page … */
  toPage?: number;
  /** … or open this address */
  url?: string;
  /** a visible frame (Acrobat's "visible rectangle"), else invisible */
  border?: RGB | null;
}

export async function addLinks(bytes: Uint8Array, links: NewLink[]): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const pages = d.getPages();
  for (const l of links) {
    const page = pages[l.page];
    if (!page) continue;
    const r = [Math.min(l.rect[0], l.rect[2]), Math.min(l.rect[1], l.rect[3]), Math.max(l.rect[0], l.rect[2]), Math.max(l.rect[1], l.rect[3])];
    const a = ctx.obj({ Type: "Annot", Subtype: "Link", Rect: r, F: 4, Border: [0, 0, l.border ? 1 : 0] }) as PDFDict;
    if (l.border) a.set(PDFName.of("C"), ctx.obj(l.border));
    if (l.url) a.set(PDFName.of("A"), ctx.obj({ S: "URI", URI: PDFString.of(l.url) }));
    else if (l.toPage != null && pages[l.toPage]) a.set(PDFName.of("Dest"), ctx.obj([pages[l.toPage].ref, PDFName.of("Fit")]));
    else continue;
    a.set(PDFName.of("P"), page.ref);
    page.node.addAnnot(ctx.register(a));
  }
  return savePdf(d);
}

/** Links already on the pages: rectangle and target. */
export async function listLinks(bytes: Uint8Array): Promise<{ page: number; rect: Rect; toPage: number | null; url?: string }[]> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const pageIdx = new Map(d.getPages().map((p, i) => [p.ref.toString(), i]));
  let named: Map<string, unknown> | null = null;
  const out: { page: number; rect: Rect; toPage: number | null; url?: string }[] = [];
  d.getPages().forEach((p, i) => {
    const annots = ctx.lookup(p.node.get(PDFName.of("Annots")));
    if (!(annots instanceof PDFArray)) return;
    for (const r of annots.asArray()) {
      const a = ctx.lookup(r);
      if (!(a instanceof PDFDict) || (ctx.lookup(a.get(PDFName.of("Subtype"))) as PDFName)?.decodeText?.() !== "Link") continue;
      const rect = (ctx.lookup(a.get(PDFName.of("Rect"))) as PDFArray).asArray().map((x) => (ctx.lookup(x) as PDFNumber).asNumber()) as Rect;
      const act = ctx.lookup(a.get(PDFName.of("A")));
      let url: string | undefined;
      let toPage: number | null = null;
      if (act instanceof PDFDict) {
        const s = (ctx.lookup(act.get(PDFName.of("S"))) as PDFName)?.decodeText?.();
        if (s === "URI") url = textOfObj(ctx.lookup(act.get(PDFName.of("URI"))));
        if (s === "GoTo") toPage = resolveDest(d, act.get(PDFName.of("D")), pageIdx, () => (named ??= namedDests(d))).page;
      } else if (a.get(PDFName.of("Dest"))) toPage = resolveDest(d, a.get(PDFName.of("Dest")), pageIdx, () => (named ??= namedDests(d))).page;
      out.push({ page: i, rect, toPage, url });
    }
  });
  return out;
}

// ───────── page labels ─────────

export interface PageLabelRange {
  /** 0-based first page of the range */
  start: number;
  /** D 1 2 3 · R I II · r i ii · A A B · a a b · "" no number */
  style: "D" | "R" | "r" | "A" | "a" | "";
  prefix?: string;
  first?: number;
}

export async function setPageLabels(bytes: Uint8Array, ranges: PageLabelRange[]): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const list = [...ranges].sort((a, b) => a.start - b.start).filter((r, i, l) => r.start >= 0 && r.start < d.getPageCount() && (i === 0 || l[i - 1].start !== r.start));
  if (!list.length) d.catalog.delete(PDFName.of("PageLabels"));
  else {
    if (list[0].start !== 0) list.unshift({ start: 0, style: "D" });
    const nums: unknown[] = [];
    for (const r of list) {
      const dict = ctx.obj({}) as PDFDict;
      if (r.style) dict.set(PDFName.of("S"), PDFName.of(r.style));
      if (r.prefix) dict.set(PDFName.of("P"), PDFHexString.fromText(r.prefix));
      if (r.first && r.first !== 1) dict.set(PDFName.of("St"), PDFNumber.of(r.first));
      nums.push(PDFNumber.of(r.start), dict);
    }
    d.catalog.set(PDFName.of("PageLabels"), ctx.obj({ Nums: ctx.obj(nums as never[]) }));
  }
  return savePdf(d);
}

const roman = (n: number) => {
  const t: [number, string][] = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let s = "";
  for (const [v, r] of t) while (n >= v) (s += r), (n -= v);
  return s;
};
const letters = (n: number) => String.fromCharCode(65 + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);

/** Each page's label (as Acrobat shows it in the page box), or null when the file has none. */
export function pageLabelsOf(d: PDFDocument): string[] | null {
  const ctx = d.context;
  const pl = ctx.lookup(d.catalog.get(PDFName.of("PageLabels")));
  if (!(pl instanceof PDFDict)) return null;
  const ranges: { start: number; dict: PDFDict }[] = [];
  const walk = (n: PDFDict, depth: number) => {
    if (depth > 16) return;
    const nums = ctx.lookup(n.get(PDFName.of("Nums")));
    if (nums instanceof PDFArray)
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const k = ctx.lookup(nums.get(i)), v = ctx.lookup(nums.get(i + 1));
        if (k instanceof PDFNumber && v instanceof PDFDict) ranges.push({ start: k.asNumber(), dict: v });
      }
    const kids = ctx.lookup(n.get(PDFName.of("Kids")));
    if (kids instanceof PDFArray) for (const k of kids.asArray()) walk(ctx.lookup(k) as PDFDict, depth + 1);
  };
  walk(pl, 0);
  ranges.sort((a, b) => a.start - b.start);
  if (!ranges.length) return null;
  const out: string[] = [];
  for (let i = 0; i < d.getPageCount(); i++) {
    const r = [...ranges].reverse().find((x) => x.start <= i);
    if (!r) {
      out.push(String(i + 1));
      continue;
    }
    const s = (ctx.lookup(r.dict.get(PDFName.of("S"))) as PDFName | undefined)?.decodeText?.() ?? "";
    const p = textOfObj(ctx.lookup(r.dict.get(PDFName.of("P")))) ?? "";
    const st = (ctx.lookup(r.dict.get(PDFName.of("St"))) as PDFNumber | undefined)?.asNumber?.() ?? 1;
    const n = st + i - r.start;
    out.push(p + (s === "D" ? String(n) : s === "R" ? roman(n) : s === "r" ? roman(n).toLowerCase() : s === "A" ? letters(n) : s === "a" ? letters(n).toLowerCase() : ""));
  }
  return out;
}

export async function getPageLabels(bytes: Uint8Array): Promise<string[] | null> {
  return pageLabelsOf(await loadPdf(bytes));
}

// ───────── pages: replace, crop ─────────

/** Pages `at` (0-based, in order) replaced by pages `from` of `src` (Acrobat ▸ 페이지 바꾸기). */
export async function replacePages(bytes: Uint8Array, at: number[], src: Uint8Array, from: number[]): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const s = await loadPdf(src);
  const n = Math.min(at.length, from.length);
  const copied = await d.copyPages(s, from.slice(0, n));
  // from the last, so earlier indices stay valid
  const pairs = at.slice(0, n).map((a, k) => [a, k] as const).sort((x, y) => y[0] - x[0]);
  for (const [a, k] of pairs) {
    if (a < 0 || a >= d.getPageCount()) continue;
    d.removePage(a);
    d.insertPage(a, copied[k]);
  }
  return savePdf(d);
}

/** Crop box from margins (pt, as shown: top / bottom / left / right) or an explicit rectangle in user space. */
export async function cropPages(bytes: Uint8Array, o: { pages?: string; margins?: { top: number; bottom: number; left: number; right: number }; rect?: Rect }): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const pages = d.getPages();
  for (const i of parsePageRange(o.pages, pages.length)) {
    const p = pages[i];
    const b = p.getCropBox();
    let x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height;
    if (o.rect) [x0, y0, x1, y1] = [Math.min(o.rect[0], o.rect[2]), Math.min(o.rect[1], o.rect[3]), Math.max(o.rect[0], o.rect[2]), Math.max(o.rect[1], o.rect[3])];
    else if (o.margins) {
      // margins are given as the page is shown: turn them into user-space sides
      const r = (((p.getRotation().angle ?? 0) % 360) + 360) % 360;
      const { top, bottom, left, right } = o.margins;
      const [uL, uB, uR, uT] = r === 90 ? [bottom, left, top, right] : r === 180 ? [right, top, left, bottom] : r === 270 ? [top, right, bottom, left] : [left, bottom, right, top];
      x0 += uL;
      y0 += uB;
      x1 -= uR;
      y1 -= uT;
    }
    if (x1 - x0 < 9 || y1 - y0 < 9) continue;
    p.setCropBox(x0, y0, x1 - x0, y1 - y0);
  }
  return savePdf(d);
}

// ───────── forms: new fields ─────────

export type NewFieldKind = "text" | "checkbox" | "radio" | "list" | "dropdown" | "button" | "signature";
export interface NewField {
  kind: NewFieldKind;
  name: string;
  page: number;
  rect: Rect;
  required?: boolean;
  tooltip?: string;
  /** list / drop-down choices; a radio button's export value is `value` */
  options?: string[];
  value?: string;
  multiline?: boolean;
  /** text: number (decimals) or date (format, e.g. yyyy-mm-dd) */
  format?: { kind: "number"; decimals?: number } | { kind: "date"; pattern?: string } | null;
  /** button caption */
  label?: string;
  fontSize?: number;
}

/** Field names already in the file */
export async function formFieldNames(bytes: Uint8Array): Promise<string[]> {
  const d = await loadPdf(bytes);
  try {
    return d.getForm().getFields().map((x) => x.getName());
  } catch {
    return [];
  }
}

export async function addFormFields(bytes: Uint8Array, fields: NewField[], o: { tabOrder?: "R" | "C" | "S" | null } = {}): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const form = d.getForm();
  const pages = d.getPages();
  const taken = new Set<string>();
  try {
    for (const x of form.getFields()) taken.add(x.getName());
  } catch {
    /* damaged field tree: names may repeat, pdf-lib refuses those itself */
  }
  const unique = (n: string) => {
    let base = (n || "field").replace(/\./g, "_"), out = base, k = 1;
    while (taken.has(out)) out = `${base}_${++k}`;
    taken.add(out);
    return out;
  };
  const helv = await d.embedFont(StandardFonts.Helvetica);
  const radios = new Map<string, ReturnType<typeof form.createRadioGroup>>();
  for (const fd of fields) {
    const page = pages[fd.page];
    if (!page) continue;
    const r = fd.rect;
    const box = { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]), borderColor: rgb(0.45, 0.5, 0.6), borderWidth: 1, backgroundColor: rgb(1, 1, 1), font: helv };
    let dict: PDFDict | null = null;
    if (fd.kind === "text") {
      const t = form.createTextField(unique(fd.name));
      if (fd.multiline) t.enableMultiline();
      t.addToPage(page, box);
      if (fd.value && /^[\x20-\x7e]*$/.test(fd.value)) t.setText(fd.value);
      if (fd.fontSize) t.setFontSize(fd.fontSize);
      dict = t.acroField.dict;
      if (fd.format) {
        const js =
          fd.format.kind === "number"
            ? { F: `AFNumber_Format(${fd.format.decimals ?? 0}, 0, 0, 0, "", true);`, K: `AFNumber_Keystroke(${fd.format.decimals ?? 0}, 0, 0, 0, "", true);` }
            : { F: `AFDate_FormatEx("${fd.format.pattern ?? "yyyy-mm-dd"}");`, K: `AFDate_KeystrokeEx("${fd.format.pattern ?? "yyyy-mm-dd"}");` };
        dict.set(PDFName.of("AA"), ctx.obj({ F: ctx.obj({ S: "JavaScript", JS: PDFString.of(js.F) }), K: ctx.obj({ S: "JavaScript", JS: PDFString.of(js.K) }) }));
      }
      if (fd.required) t.enableRequired();
    } else if (fd.kind === "checkbox") {
      const c = form.createCheckBox(unique(fd.name));
      c.addToPage(page, { ...box, backgroundColor: rgb(1, 1, 1) });
      if (fd.value === "on" || fd.value === "true") c.check();
      if (fd.required) c.enableRequired();
      dict = c.acroField.dict;
    } else if (fd.kind === "radio") {
      const nm = (fd.name || "radio").replace(/\./g, "_");
      let g = radios.get(nm);
      if (!g) {
        g = form.createRadioGroup(unique(nm));
        radios.set(nm, g);
      }
      g.addOptionToPage(fd.value || `choice${g.getOptions().length + 1}`, page, box);
      if (fd.required) g.enableRequired();
      dict = g.acroField.dict;
    } else if (fd.kind === "list" || fd.kind === "dropdown") {
      const opts = (fd.options ?? []).filter((s) => s.trim());
      const latin = opts.every((s) => /^[\x20-\x7e]*$/.test(s));
      const c = fd.kind === "list" ? form.createOptionList(unique(fd.name)) : form.createDropdown(unique(fd.name));
      if (latin) c.setOptions(opts);
      c.addToPage(page, box);
      dict = c.acroField.dict;
      // choices in other scripts: written as text strings without a drawn appearance (viewers draw them)
      if (!latin) dict.set(PDFName.of("Opt"), ctx.obj(opts.map((s) => PDFHexString.fromText(s))));
      if (fd.required) c.enableRequired();
    } else if (fd.kind === "button") {
      const b = form.createButton(unique(fd.name));
      const label = fd.label && /^[\x20-\x7e]*$/.test(fd.label) ? fd.label : "Button";
      b.addToPage(label, page, { ...box, backgroundColor: rgb(0.88, 0.9, 0.94) });
      dict = b.acroField.dict;
      if (fd.label && label !== fd.label) {
        const w = b.acroField.getWidgets()[0];
        w?.dict.set(PDFName.of("MK"), ctx.obj({ CA: PDFHexString.fromText(fd.label), BG: [0.88, 0.9, 0.94], BC: [0.45, 0.5, 0.6] }));
      }
    } else if (fd.kind === "signature") {
      // pdf-lib makes no signature fields: one merged field + widget dictionary, as Acrobat writes it
      const ap = ctx.register(ctx.stream(`q 0.45 0.5 0.6 RG 1 w 0.5 0.5 ${f(box.width - 1)} ${f(box.height - 1)} re S Q`, { Type: "XObject", Subtype: "Form", BBox: [0, 0, box.width, box.height] }));
      const w = ctx.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        T: PDFHexString.fromText(unique(fd.name)),
        Rect: [box.x, box.y, box.x + box.width, box.y + box.height],
        F: 4,
        P: page.ref,
        MK: ctx.obj({ BC: [0.45, 0.5, 0.6] }),
        AP: ctx.obj({ N: ap }),
      }) as PDFDict;
      if (fd.required) w.set(PDFName.of("Ff"), PDFNumber.of(2));
      const ref = ctx.register(w);
      page.node.addAnnot(ref);
      form.acroForm.addField(ref);
      dict = w;
      // a signature field makes the file "signable": the form must not ask viewers to regenerate appearances
    }
    if (dict && fd.tooltip) dict.set(PDFName.of("TU"), PDFHexString.fromText(fd.tooltip));
  }
  if (o.tabOrder) for (const p of pages) if (p.node.get(PDFName.of("Annots"))) p.node.set(PDFName.of("Tabs"), PDFName.of(o.tabOrder));
  return savePdf(d);
}

/** Set the tab order of every page that has fields: R rows, C columns, S structure (Acrobat 페이지 속성 ▸ 탭 순서). */
export async function setTabOrder(bytes: Uint8Array, order: "R" | "C" | "S"): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  for (const p of d.getPages()) p.node.set(PDFName.of("Tabs"), PDFName.of(order));
  return savePdf(d);
}

// ───────── PDF/A ─────────

/** A small sRGB (IEC 61966-2.1 primaries, gamma 2.2 curve) ICC v2 display profile for the output intent. */
export function srgbIcc(): Uint8Array {
  const tags: [string, Uint8Array][] = [];
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const s15 = (v: number) => be32(Math.round(v * 65536) >>> 0);
  const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  const xyz = (x: number, y: number, z: number) => new Uint8Array([...ascii("XYZ "), 0, 0, 0, 0, ...s15(x), ...s15(y), ...s15(z)]);
  const name = "sRGB (Omniweave)";
  const desc = new Uint8Array([...ascii("desc"), 0, 0, 0, 0, ...be32(name.length + 1), ...ascii(name), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...new Array(67).fill(0)]);
  const cprt = new Uint8Array([...ascii("text"), 0, 0, 0, 0, ...ascii("No copyright, use freely"), 0]);
  const curv = new Uint8Array([...ascii("curv"), 0, 0, 0, 0, 0, 0, 0, 1, 2, 51, 0, 0]); // gamma 2.2 (u8Fixed8 0x0233), padded
  tags.push(["desc", desc], ["cprt", cprt], ["wtpt", xyz(0.9642, 1, 0.8249)], ["rXYZ", xyz(0.4361, 0.2225, 0.0139)], ["gXYZ", xyz(0.3851, 0.7169, 0.0971)], ["bXYZ", xyz(0.1431, 0.0606, 0.7141)], ["rTRC", curv], ["gTRC", curv], ["bTRC", curv]);
  const pad4 = (n: number) => (n + 3) & ~3;
  let off = 128 + 4 + tags.length * 12;
  const table: number[] = [...be32(tags.length)];
  const offsets = new Map<Uint8Array, number>();
  const blobs: Uint8Array[] = [];
  for (const [sig, data] of tags) {
    let o = offsets.get(data);
    if (o === undefined) {
      o = off;
      offsets.set(data, o);
      blobs.push(data);
      off += pad4(data.length);
    }
    table.push(...ascii(sig), ...be32(o), ...be32(data.length));
  }
  const out = new Uint8Array(off);
  const hdr = [...be32(off), 0, 0, 0, 0, 2, 0x10, 0, 0, ...ascii("mntr"), ...ascii("RGB "), ...ascii("XYZ "), 0, 0x7e, 0, 11, 0, 24, 0, 0, 0, 0, 0, 0, ...ascii("acsp")];
  out.set(hdr, 0);
  out.set([...s15(0.9642), ...s15(1), ...s15(0.8249)], 68);
  out.set(table, 128);
  let p = 128 + table.length;
  for (const b of blobs) {
    out.set(b, p);
    p += pad4(b.length);
  }
  return out;
}

export type SansStyle = "Regular" | "Bold" | "Italic" | "BoldItalic";

/** Courier / Courier New → the style of the monospaced font put in its place (every glyph 600 units wide). */
export function monoStyleOf(baseFont: string): SansStyle | null {
  const b = baseFont.replace(/^[A-Z]{6}\+/, "");
  if (!/^Courier(New)?(PS)?(MT)?([-,]|$)/i.test(b)) return null;
  const bold = /bold/i.test(b), it = /italic|oblique/i.test(b);
  return bold && it ? "BoldItalic" : bold ? "Bold" : it ? "Italic" : "Regular";
}

/**
 * A bare CFF font (pdf.js's Foxit Fixed files are CFF despite their .pfb name): its name, box and, when every glyph
 * has the same advance (a monospaced font), that advance — read from each Type 2 charstring's width operand.
 */
export function cffMonoInfo(b: Uint8Array): { name: string; width: number; bbox: number[] } | null {
  try {
    if (b[0] !== 1) return null;
    let p = b[2];
    const index = () => {
      const count = (b[p] << 8) | b[p + 1];
      if (!count) return (p += 2), [] as Uint8Array[];
      const os = b[p + 2];
      const off = (i: number) => {
        let v = 0;
        for (let k = 0; k < os; k++) v = v * 256 + b[p + 3 + i * os + k];
        return v;
      };
      const base = p + 3 + (count + 1) * os - 1;
      const items = Array.from({ length: count }, (_, i) => b.subarray(base + off(i), base + off(i + 1)));
      p = base + off(count);
      return items;
    };
    const dict = (d: Uint8Array) => {
      const out = new Map<number, number[]>();
      let ops: number[] = [];
      for (let i = 0; i < d.length; ) {
        const v = d[i++];
        if (v <= 21) {
          out.set(v === 12 ? 1200 + d[i++] : v, ops);
          ops = [];
        } else if (v === 28) (ops.push((((d[i] << 8) | d[i + 1]) << 16) >> 16), (i += 2));
        else if (v === 29) (ops.push((d[i] << 24) | (d[i + 1] << 16) | (d[i + 2] << 8) | d[i + 3]), (i += 4));
        else if (v === 30) {
          let s = "";
          for (let done = false; !done; ) {
            const x = d[i++];
            for (const nib of [x >> 4, x & 15]) {
              if (nib === 15) done = true;
              else if (!done) s += nib <= 9 ? String(nib) : nib === 10 ? "." : nib === 11 ? "E" : nib === 12 ? "E-" : nib === 14 ? "-" : "";
            }
          }
          ops.push(parseFloat(s) || 0);
        } else if (v >= 32 && v <= 246) ops.push(v - 139);
        else if (v >= 247 && v <= 250) ops.push((v - 247) * 256 + d[i++] + 108);
        else if (v >= 251 && v <= 254) ops.push(-(v - 251) * 256 - d[i++] - 108);
      }
      return out;
    };
    const names = index();
    const top = dict(index()[0]);
    const csOff = top.get(17)?.[0], priv = top.get(18);
    if (csOff == null || !priv) return null;
    const pd = dict(b.subarray(priv[1], priv[1] + priv[0]));
    const dflt = pd.get(20)?.[0] ?? 0, nominal = pd.get(21)?.[0] ?? 0;
    p = csOff;
    const widths = new Set<number>();
    for (const cs of index()) {
      let n = 0, w = dflt;
      let first: number | null = null;
      for (let i = 0; i < cs.length; ) {
        const v = cs[i++];
        if (v === 28 || v >= 32) {
          const val = v === 28 ? ((((cs[i] << 8) | cs[i + 1]) << 16) >> 16) : v <= 246 ? v - 139 : v <= 250 ? (v - 247) * 256 + cs[i] + 108 : v <= 254 ? -(v - 251) * 256 - cs[i] - 108 : (((cs[i] << 24) | (cs[i + 1] << 16) | (cs[i + 2] << 8) | cs[i + 3]) / 65536);
          i += v === 28 ? 2 : v >= 247 && v <= 254 ? 1 : v === 255 ? 4 : 0;
          if (first === null) first = val;
          n++;
          continue;
        }
        // the first operator: an operand beyond what it takes is the width (Type 2 charstrings §4.1)
        const takes = v === 21 ? 2 : v === 22 || v === 4 ? 1 : v === 14 ? (n >= 4 ? 4 : 0) : [1, 3, 18, 23, 19, 20].includes(v) ? n - (n % 2) : n;
        if (n > takes && first !== null) w = nominal + first;
        break;
      }
      widths.add(Math.round(w));
    }
    if (widths.size !== 1) return null;
    return { name: new TextDecoder("latin1").decode(names[0] ?? new Uint8Array()), width: [...widths][0], bbox: top.get(5) ?? [0, -250, 600, 800] };
  } catch {
    return null;
  }
}

/** A Type 1 font in PFB form: its cleartext and encrypted parts, name, box and each glyph's advance (by name). */
export function parsePfb(b: Uint8Array): { clear: Uint8Array; enc: Uint8Array; fontName: string; bbox: number[]; widths: Map<string, number> } | null {
  const parts: { type: number; data: Uint8Array }[] = [];
  let i = 0;
  while (i + 6 <= b.length && b[i] === 0x80 && b[i + 1] !== 3) {
    const len = b[i + 2] | (b[i + 3] << 8) | (b[i + 4] << 16) | (b[i + 5] << 24);
    parts.push({ type: b[i + 1], data: b.subarray(i + 6, i + 6 + len) });
    i += 6 + len;
  }
  const clear = parts.find((p) => p.type === 1)?.data, enc = parts.find((p) => p.type === 2)?.data;
  if (!clear || !enc) return null;
  const head = new TextDecoder("latin1").decode(clear);
  const fontName = /\/FontName\s*\/(\S+)/.exec(head)?.[1] ?? "Type1";
  const bbox = (/\/FontBBox\s*[{[]([^}\]]*)[}\]]/.exec(head)?.[1] ?? "0 0 1000 1000").trim().split(/\s+/).map(Number);
  // eexec: r = 55665, the first four bytes are padding
  const plain = new Uint8Array(enc.length);
  let r = 55665;
  for (let k = 0; k < enc.length; k++) {
    const c = enc[k];
    plain[k] = c ^ (r >> 8);
    r = ((c + r) * 52845 + 22719) & 0xffff;
  }
  const text = new TextDecoder("latin1").decode(plain);
  const lenIV = Number(/\/lenIV\s+(\d+)/.exec(text)?.[1] ?? 4);
  const widths = new Map<string, number>();
  const at = text.indexOf("/CharStrings");
  const re = /\/([^\s/]+)\s+(\d+)\s+(RD|-\|)\s/g;
  re.lastIndex = at < 0 ? text.length : at;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const n = Number(m[2]);
    const start = m.index + m[0].length;
    const cs = plain.subarray(start, start + n);
    let q = 4330;
    const dec = new Uint8Array(cs.length);
    for (let k = 0; k < cs.length; k++) {
      const c = cs[k];
      dec[k] = c ^ (q >> 8);
      q = ((c + q) * 52845 + 22719) & 0xffff;
    }
    const st: number[] = [];
    for (let k = lenIV; k < dec.length; ) {
      const v = dec[k++];
      if (v >= 32) {
        if (v <= 246) st.push(v - 139);
        else if (v <= 250) st.push((v - 247) * 256 + dec[k++] + 108);
        else if (v <= 254) st.push(-(v - 251) * 256 - dec[k++] - 108);
        else (st.push((dec[k] << 24) | (dec[k + 1] << 16) | (dec[k + 2] << 8) | dec[k + 3]), (k += 4));
        continue;
      }
      if (v === 13 && st.length >= 2) widths.set(m[1], st[1]); // hsbw: sbx wx
      else if (v === 12 && dec[k] === 7 && st.length >= 3) widths.set(m[1], st[2]); // sbw: sbx sby wx wy
      break;
    }
    re.lastIndex = start + n;
  }
  return { clear, enc, fontName, bbox, widths };
}

/** The code → character table a simple font uses now (its encoding, or its standard one when it has none). */
async function codeTable(ctx: PDFDocument["context"], o: PDFDict, sub: string): Promise<string[]> {
  const { baseEncodingTable, glyphToUnicode } = await import("./encodings");
  const enc = ctx.lookup(o.get(PDFName.of("Encoding")));
  const baseName = (enc instanceof PDFName ? enc.decodeText() : enc instanceof PDFDict ? (ctx.lookup(enc.get(PDFName.of("BaseEncoding"))) as PDFName | undefined)?.decodeText?.() : undefined) ?? (sub === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding");
  const names = [...baseEncodingTable((["WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"].includes(baseName) ? baseName : "StandardEncoding") as never)];
  if (enc instanceof PDFDict) {
    const diff = ctx.lookup(enc.get(PDFName.of("Differences")));
    if (diff instanceof PDFArray) {
      let c = 0;
      for (const x of diff.asArray()) {
        const v = ctx.lookup(x);
        if (v instanceof PDFNumber) c = v.asNumber();
        else if (v instanceof PDFName) names[c++] = glyphToUnicode(v.decodeText());
      }
    }
  }
  return names;
}

/** Left-out Courier fonts get a monospaced Type 1 program (pdf.js's Foxit Fixed) with its own widths. */
async function embedMonoFonts(d: PDFDocument, program: (s: SansStyle) => Promise<Uint8Array | null>): Promise<number> {
  const ctx = d.context;
  const { baseEncodingTable, unicodeToGlyph } = await import("./encodings");
  type Prog = { name: string; bbox: number[]; width: (glyph: string) => number; ref: PDFRef; key: "FontFile" | "FontFile3" };
  const cache = new Map<SansStyle, Promise<Prog | null>>();
  const load = (s: SansStyle) => {
    let p = cache.get(s);
    if (!p) {
      p = (async () => {
        const bytes = await program(s).catch(() => null);
        if (!bytes) return null;
        // a bare CFF program (Type1C, FontFile3) with every glyph the same width, or a real PFB (FontFile)
        const cff = cffMonoInfo(bytes);
        if (cff) return { name: cff.name, bbox: cff.bbox, width: () => cff.width, ref: ctx.register(ctx.flateStream(bytes, { Subtype: "Type1C" })), key: "FontFile3" as const };
        const pfb = parsePfb(bytes);
        if (!pfb) return null;
        const data = new Uint8Array(pfb.clear.length + pfb.enc.length);
        data.set(pfb.clear);
        data.set(pfb.enc, pfb.clear.length);
        return { name: pfb.fontName, bbox: pfb.bbox, width: (g: string) => pfb.widths.get(g) ?? 0, ref: ctx.register(ctx.flateStream(data, { Length1: pfb.clear.length, Length2: pfb.enc.length, Length3: 0 })), key: "FontFile" as const };
      })();
      cache.set(s, p);
    }
    return p;
  };
  let n = 0;
  for (const [, o] of [...ctx.enumerateIndirectObjects()]) {
    if (!(o instanceof PDFDict) || (o.get(PDFName.of("Type")) as PDFName | undefined)?.decodeText?.() !== "Font") continue;
    const sub = (o.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
    if (sub !== "Type1" && sub !== "TrueType" && sub !== "MMType1") continue;
    const base = (ctx.lookup(o.get(PDFName.of("BaseFont"))) as PDFName | undefined)?.decodeText?.() ?? "";
    const fd0 = ctx.lookup(o.get(PDFName.of("FontDescriptor")));
    if (fd0 instanceof PDFDict && (fd0.get(PDFName.of("FontFile")) || fd0.get(PDFName.of("FontFile2")) || fd0.get(PDFName.of("FontFile3")))) continue;
    const style = monoStyleOf(base);
    if (!style) continue;
    const prog = await load(style);
    if (!prog) continue;
    const names = await codeTable(ctx, o, sub);
    const win = baseEncodingTable("WinAnsiEncoding" as never);
    const differences: (PDFNumber | PDFName)[] = [];
    const widths: number[] = [];
    for (let c = 32; c < 256; c++) {
      const gname = names[c] ? unicodeToGlyph(names[c]) : "";
      if (names[c] && names[c] !== win[c]) differences.push(PDFNumber.of(c), PDFName.of(gname));
      widths.push(gname ? prog.width(gname) : 0);
    }
    const [x0, y0, x1, y1] = prog.bbox;
    const fd = ctx.obj({
      Type: "FontDescriptor",
      FontName: PDFName.of(prog.name),
      Flags: 1 | 32 | (style.includes("Italic") ? 64 : 0),
      FontBBox: [x0, y0, x1, y1],
      ItalicAngle: style.includes("Italic") ? -12 : 0,
      Ascent: Math.round(y1),
      Descent: Math.round(y0),
      CapHeight: 562,
      StemV: style.includes("Bold") ? 106 : 51,
    }) as PDFDict;
    fd.set(PDFName.of(prog.key), prog.ref);
    o.set(PDFName.of("Subtype"), PDFName.of("Type1"));
    o.set(PDFName.of("BaseFont"), PDFName.of(prog.name));
    o.set(PDFName.of("FontDescriptor"), ctx.register(fd));
    o.set(PDFName.of("Encoding"), differences.length ? ctx.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: ctx.obj(differences) }) : PDFName.of("WinAnsiEncoding"));
    o.set(PDFName.of("FirstChar"), PDFNumber.of(32));
    o.set(PDFName.of("LastChar"), PDFNumber.of(255));
    o.set(PDFName.of("Widths"), ctx.obj(widths));
    n++;
  }
  return n;
}

/** Helvetica / Arial (the commonest fonts left out of a file) → the style of Liberation Sans with the same widths. */
export function sansStyleOf(baseFont: string): SansStyle | null {
  const b = baseFont.replace(/^[A-Z]{6}\+/, "");
  if (!/^(Helvetica|Arial(MT)?)([-,]|$)/i.test(b)) return null;
  const bold = /bold|black|heavy/i.test(b), it = /italic|oblique/i.test(b);
  return bold && it ? "BoldItalic" : bold ? "Bold" : it ? "Italic" : "Regular";
}

/**
 * PDF/A needs every font in the file. Simple fonts left out that are Helvetica or Arial get Liberation Sans (metric
 * compatible: the same advance widths) as a TrueType program; their codes keep their glyphs through the encoding
 * (written out as WinAnsi + Differences) and the widths are taken from the program. Returns how many were embedded.
 */
/** Times / Times New Roman → the style of Liberation Serif (the same widths). */
export function serifStyleOf(baseFont: string): SansStyle | null {
  const b = baseFont.replace(/^[A-Z]{6}\+/, "");
  if (!/^Times(NewRoman(PS)?(MT)?|-Roman|[-,]|$)/i.test(b)) return null;
  const bold = /bold/i.test(b), it = /italic|oblique/i.test(b);
  return bold && it ? "BoldItalic" : bold ? "Bold" : it ? "Italic" : "Regular";
}

async function embedSansFonts(d: PDFDocument, program: (s: SansStyle) => Promise<Uint8Array | null>, styleOf: (base: string) => SansStyle | null = sansStyleOf, serif = false): Promise<number> {
  const ctx = d.context;
  const { baseEncodingTable, glyphToUnicode, unicodeToGlyph } = await import("./encodings");
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  const cache = new Map<SansStyle, Promise<{ font: any; ref: PDFRef } | null>>();
  const load = (s: SansStyle) => {
    let p = cache.get(s);
    if (!p) {
      p = (async () => {
        const bytes = await program(s).catch(() => null);
        if (!bytes) return null;
        const font = fontkit.create(bytes as any);
        return { font, ref: ctx.register(ctx.flateStream(bytes, { Length1: bytes.length })) };
      })();
      cache.set(s, p);
    }
    return p;
  };
  let n = 0;
  for (const [, o] of [...ctx.enumerateIndirectObjects()]) {
    if (!(o instanceof PDFDict) || (o.get(PDFName.of("Type")) as PDFName | undefined)?.decodeText?.() !== "Font") continue;
    const sub = (o.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
    if (sub !== "Type1" && sub !== "TrueType" && sub !== "MMType1") continue;
    const base = (ctx.lookup(o.get(PDFName.of("BaseFont"))) as PDFName | undefined)?.decodeText?.() ?? "";
    const fd0 = ctx.lookup(o.get(PDFName.of("FontDescriptor")));
    if (fd0 instanceof PDFDict && (fd0.get(PDFName.of("FontFile")) || fd0.get(PDFName.of("FontFile2")) || fd0.get(PDFName.of("FontFile3")))) continue;
    const style = styleOf(base);
    if (!style) continue;
    const prog = await load(style);
    if (!prog) continue;
    // the code → character table the font had (Type1 standard fonts: StandardEncoding; TrueType: WinAnsi)
    const enc = ctx.lookup(o.get(PDFName.of("Encoding")));
    const baseName = (enc instanceof PDFName ? enc.decodeText() : enc instanceof PDFDict ? (ctx.lookup(enc.get(PDFName.of("BaseEncoding"))) as PDFName | undefined)?.decodeText?.() : undefined) ?? (sub === "TrueType" ? "WinAnsiEncoding" : "StandardEncoding");
    const names = [...baseEncodingTable((["WinAnsiEncoding", "MacRomanEncoding", "StandardEncoding"].includes(baseName) ? baseName : "StandardEncoding") as never)];
    if (enc instanceof PDFDict) {
      const diff = ctx.lookup(enc.get(PDFName.of("Differences")));
      if (diff instanceof PDFArray) {
        let c = 0;
        for (const x of diff.asArray()) {
          const v = ctx.lookup(x);
          if (v instanceof PDFNumber) c = v.asNumber();
          else if (v instanceof PDFName) names[c++] = glyphToUnicode(v.decodeText());
        }
      }
    }
    const win = baseEncodingTable("WinAnsiEncoding" as never);
    const differences: (PDFNumber | PDFName)[] = [];
    for (let c = 32; c < 256; c++) if (names[c] && names[c] !== win[c]) differences.push(PDFNumber.of(c), PDFName.of(unicodeToGlyph(names[c])));
    const k = 1000 / prog.font.unitsPerEm;
    const widths: number[] = [];
    for (let c = 32; c < 256; c++) {
      const u = names[c];
      const g = u ? prog.font.glyphForCodePoint(u.codePointAt(0)!) : null;
      widths.push(g && g.id ? Math.round(g.advanceWidth * k) : 0);
    }
    const bb = prog.font.bbox;
    const fd = ctx.obj({
      Type: "FontDescriptor",
      FontName: PDFName.of(base.replace(/[^\x21-\x7e]/g, "") || "LiberationSans"),
      Flags: 32 | (serif ? 2 : 0) | (style.includes("Italic") ? 64 : 0),
      FontBBox: [Math.round(bb.minX * k), Math.round(bb.minY * k), Math.round(bb.maxX * k), Math.round(bb.maxY * k)],
      ItalicAngle: style.includes("Italic") ? -12 : 0,
      Ascent: Math.round(prog.font.ascent * k),
      Descent: Math.round(prog.font.descent * k),
      CapHeight: Math.round((prog.font.capHeight || prog.font.ascent * 0.7) * k),
      StemV: style.includes("Bold") ? 120 : 80,
      FontFile2: prog.ref,
    }) as PDFDict;
    o.set(PDFName.of("Subtype"), PDFName.of("TrueType"));
    o.set(PDFName.of("FontDescriptor"), ctx.register(fd));
    o.set(PDFName.of("Encoding"), differences.length ? ctx.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: ctx.obj(differences) }) : PDFName.of("WinAnsiEncoding"));
    o.set(PDFName.of("FirstChar"), PDFNumber.of(32));
    o.set(PDFName.of("LastChar"), PDFNumber.of(255));
    o.set(PDFName.of("Widths"), ctx.obj(widths));
    n++;
  }
  return n;
}

const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface PdfAReport {
  bytes: Uint8Array;
  /** what may still keep a validator from accepting the file (fonts not embedded, encryption …) */
  notes: string[];
}

/**
 * PDF/A-2b basics: XMP metadata with the PDF/A identification (matching the document information), an sRGB output
 * intent, a document ID, no JavaScript / launch actions, annotations printable. Fonts are not embedded here —
 * fonts the file does not carry are listed in `notes`.
 */
export async function saveAsPdfA(bytes: Uint8Array, o: { title?: string; now?: Date; sansProgram?: (s: SansStyle) => Promise<Uint8Array | null>; serifProgram?: (s: SansStyle) => Promise<Uint8Array | null>; monoProgram?: (s: SansStyle) => Promise<Uint8Array | null> } = {}): Promise<PdfAReport> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const notes: string[] = [];
  const embedded =
    (o.sansProgram ? await embedSansFonts(d, o.sansProgram) : 0) +
    (o.serifProgram ? await embedSansFonts(d, o.serifProgram, serifStyleOf, true) : 0) +
    (o.monoProgram ? await embedMonoFonts(d, o.monoProgram) : 0);
  if (embedded) notes.push(`embedded:${embedded}`);
  const now = o.now ?? new Date();
  const title = o.title ?? d.getTitle() ?? "";
  d.setTitle(title);
  d.setProducer("Omniweave");
  d.setModificationDate(now);
  if (!d.getCreationDate()) d.setCreationDate(now);
  const iso = (x: Date) => x.toISOString().replace(/\.\d{3}Z$/, "Z");
  const created = d.getCreationDate() ?? now;
  const xmp = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>
<dc:format>application/pdf</dc:format>
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>
<xmp:CreateDate>${iso(created)}</xmp:CreateDate><xmp:ModifyDate>${iso(now)}</xmp:ModifyDate><xmp:MetadataDate>${iso(now)}</xmp:MetadataDate>
<pdf:Producer>Omniweave</pdf:Producer>
</rdf:Description></rdf:RDF></x:xmpmeta>
<?xpacket end="w"?>`;
  const meta = ctx.stream(new TextEncoder().encode(xmp), { Type: "Metadata", Subtype: "XML" });
  d.catalog.set(PDFName.of("Metadata"), ctx.register(meta));
  const icc = ctx.register(ctx.flateStream(srgbIcc(), { N: 3 }));
  d.catalog.set(PDFName.of("OutputIntents"), ctx.obj([ctx.obj({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"), Info: PDFString.of("sRGB IEC61966-2.1"), DestOutputProfile: icc })]));
  // no scripts or actions that run on their own
  d.catalog.delete(PDFName.of("OpenAction"));
  d.catalog.delete(PDFName.of("AA"));
  const names = ctx.lookup(d.catalog.get(PDFName.of("Names")));
  if (names instanceof PDFDict) names.delete(PDFName.of("JavaScript"));
  const af = ctx.lookup(d.catalog.get(PDFName.of("AcroForm")));
  if (af instanceof PDFDict) {
    af.delete(PDFName.of("NeedAppearances"));
    if (af.get(PDFName.of("XFA"))) (af.delete(PDFName.of("XFA")), notes.push("XFA"));
  }
  let unembedded = 0;
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict) {
      const type = (obj.get(PDFName.of("Type")) as PDFName | undefined)?.decodeText?.();
      if (type === "Annot") {
        obj.delete(PDFName.of("AA"));
        const sub = (obj.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
        if (sub !== "Popup" && sub !== "Link") obj.set(PDFName.of("F"), PDFNumber.of(4));
        const a = ctx.lookup(obj.get(PDFName.of("A")));
        if (a instanceof PDFDict && /JavaScript|Launch/.test((a.get(PDFName.of("S")) as PDFName | undefined)?.decodeText?.() ?? "")) obj.delete(PDFName.of("A"));
      }
      if (type === "FontDescriptor" && !obj.get(PDFName.of("FontFile")) && !obj.get(PDFName.of("FontFile2")) && !obj.get(PDFName.of("FontFile3"))) unembedded++;
      if (type === "Font") {
        const sub = (obj.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.();
        if ((sub === "Type1" || sub === "TrueType") && !obj.get(PDFName.of("FontDescriptor"))) unembedded++;
      }
    }
  }
  if (unembedded) notes.push(`fonts:${unembedded}`);
  if (!ctx.trailerInfo.ID) {
    const id = new Uint8Array(16);
    crypto.getRandomValues(id);
    const hx = PDFHexString.of(Array.from(id, (b) => b.toString(16).padStart(2, "0")).join(""));
    ctx.trailerInfo.ID = ctx.obj([hx, hx]);
  }
  collectGarbage(ctx);
  const out = await d.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes: out, notes };
}

// ───────── document properties (Acrobat Ctrl+D) ─────────

export interface DocInfo {
  title: string;
  author: string;
  subject: string;
  keywords: string;
  creator: string;
  producer: string;
  created: Date | null;
  modified: Date | null;
  version: string;
  pages: number;
  /** first page size in pt, as shown */
  pageSize: [number, number];
  fonts: { name: string; embedded: boolean; subset: boolean; type: string }[];
  tagged: boolean;
  pdfA: string | null;
  bookmarks: number;
  fields: number;
}

export async function readDocInfo(bytes: Uint8Array): Promise<DocInfo> {
  const d = await loadPdf(bytes);
  const ctx = d.context;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 16));
  const fonts = new Map<string, DocInfo["fonts"][number]>();
  for (const [, o] of ctx.enumerateIndirectObjects()) {
    if (!(o instanceof PDFDict) || (o.get(PDFName.of("Type")) as PDFName | undefined)?.decodeText?.() !== "Font") continue;
    const sub = (o.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() ?? "";
    if (sub === "Type0" || sub === "Type3") {
      if (sub === "Type3") fonts.set("Type3", { name: "Type3", embedded: true, subset: false, type: "Type3" });
      continue;
    }
    const base = (ctx.lookup(o.get(PDFName.of("BaseFont"))) as PDFName | undefined)?.decodeText?.() ?? "?";
    const fd = ctx.lookup(o.get(PDFName.of("FontDescriptor")));
    const embedded = fd instanceof PDFDict && !!(fd.get(PDFName.of("FontFile")) || fd.get(PDFName.of("FontFile2")) || fd.get(PDFName.of("FontFile3")));
    const name = base.replace(/^[A-Z]{6}\+/, "");
    fonts.set(name + sub, { name, embedded, subset: /^[A-Z]{6}\+/.test(base), type: sub });
  }
  const meta = ctx.lookup(d.catalog.get(PDFName.of("Metadata")));
  let pdfA: string | null = null;
  if (meta instanceof PDFStream) {
    try {
      const x = new TextDecoder().decode((meta as unknown as { contents?: Uint8Array }).contents ?? new Uint8Array());
      const part = /pdfaid:part[>="']+(\d)/.exec(x)?.[1], conf = /pdfaid:conformance[>="']+([ABU])/i.exec(x)?.[1];
      if (part) pdfA = `PDF/A-${part}${(conf ?? "").toLowerCase()}`;
    } catch {
      /* compressed metadata: not shown */
    }
  }
  let fields = 0;
  try {
    fields = d.getForm().getFields().length;
  } catch {
    /* damaged form */
  }
  const p0 = d.getPages()[0];
  const disp = p0 ? displayOf(p0) : { W: 0, H: 0 };
  const count = (l: Bookmark[]): number => l.reduce((n, b) => n + 1 + count(b.children), 0);
  return {
    title: d.getTitle() ?? "",
    author: d.getAuthor() ?? "",
    subject: d.getSubject() ?? "",
    keywords: d.getKeywords() ?? "",
    creator: d.getCreator() ?? "",
    producer: d.getProducer() ?? "",
    created: d.getCreationDate() ?? null,
    modified: d.getModificationDate() ?? null,
    version: /%PDF-(\d\.\d)/.exec(head)?.[1] ?? "?",
    pages: d.getPageCount(),
    pageSize: [disp.W, disp.H],
    fonts: [...fonts.values()].sort((a, b) => a.name.localeCompare(b.name)),
    tagged: !!d.catalog.get(PDFName.of("StructTreeRoot")),
    pdfA,
    bookmarks: count(readOutline(d)),
    fields,
  };
}

export async function setDocInfo(bytes: Uint8Array, o: { title?: string; author?: string; subject?: string; keywords?: string }): Promise<Uint8Array> {
  const d = await loadPdf(bytes);
  if (o.title !== undefined) d.setTitle(o.title, { showInWindowTitleBar: true });
  if (o.author !== undefined) d.setAuthor(o.author);
  if (o.subject !== undefined) d.setSubject(o.subject);
  if (o.keywords !== undefined) d.setKeywords(o.keywords.split(/[,;]\s*/).filter(Boolean));
  d.setModificationDate(new Date());
  return savePdf(d);
}

/** Is the stream an image XObject (for callers walking resources) */
export const isImageStream = (o: unknown) => o instanceof PDFStream && (o.dict.get(PDFName.of("Subtype")) as PDFName | undefined)?.decodeText?.() === "Image";
