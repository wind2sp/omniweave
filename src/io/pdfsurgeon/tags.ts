// PDF Surgeon — accessibility tags (Acrobat ▸ 접근성 ▸ 자동 태그 / 읽기 순서).
//
// autoTag gives an untagged file a structure tree a screen reader can follow:
//   - every text show and every picture is wrapped in a marked-content sequence with an MCID (`/P <</MCID n>> BDC …
//     EMC`, the operation itself unchanged, so the page looks exactly the same) — in the page's own content and in
//     the form XObjects it draws once (a whole page set in one form, forms in forms): such a form gets its own
//     /StructParents and its pieces are marked-content references (MCR /Stm) of the page's elements; a form drawn
//     more than once (the same stream, other places or pages) is tagged where it is drawn, its text one element
//   - columns are found by their gutters (an empty vertical band between blocks of text side by side, each column at
//     least a quarter of the text width); the page is read in bands between what spans the columns (a title across
//     the page), each band column by column, left to right, each column top to bottom
//   - in a column the shows become lines (by baseline), the lines paragraphs (same size, close together, overlapping
//     across); a paragraph clearly larger than the body text is a heading (H1 the largest sizes, H2 the next)
//   - pictures become Figure elements (with their box as a layout attribute), their alternate text (/Alt) given later
//     in the reading-order panel (setAltText)
//   - Document → H1 / H2 / P / Figure elements in reading order, each with its page (/Pg) and MCIDs (/K); the
//     ParentTree maps each page's MCIDs back to their elements (/StructParents on the page)
//   - the catalog is marked (/MarkInfo /Marked true), gets /Lang (Korean text → ko-KR) and shows the title
//     (/ViewerPreferences /DisplayDocTitle); pages get /Tabs /S (tab order by structure)
// A file that already has a structure tree is left alone. The file is written again in full.
//
// readingOrder reads any tagged file's structure tree back: the elements holding content, in tree order, with
// their role (RoleMap resolved), text, page and object — what Acrobat's 읽기 순서 panel lists.

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFObject } from "pdf-lib";
import { savePdf } from "./acrobat";
import { dget, dictOf, hiddenOcgs, look, nameOf, numOf, openSurgeonDoc, pageContent, pageDict, pageResources, refKey, textOf, type SurgeonDoc } from "./document";
import { analyzePage, type ImageDraw, type PageAnalysis, type StreamUnit, type TextShow } from "./interpret";
import { I, apply } from "./matrix";
import { PdfDict, PdfName } from "./syntax";
import { glyphBoxes } from "./redact";
import type { Rect } from "./acrobat";

export type TagRole = "H1" | "H2" | "P" | "Figure";
export interface TagItem {
  role: string;
  text: string;
  /** 0-based page */
  page: number;
  /** the structure element ("num gen"): where alternate text goes */
  ref?: string;
  /** its alternate text (/Alt), when it has one */
  alt?: string;
}
export interface AutoTagResult {
  bytes: Uint8Array;
  /** the elements made, in reading order */
  items: TagItem[];
  /** already tagged: nothing was changed (bytes are the input) */
  already: boolean;
}

const analyze = (sd: SurgeonDoc, i: number): PageAnalysis => analyzePage(sd, I, pageResources(sd, i), pageContent(sd, i), hiddenOcgs(sd));
const union = (a: Rect, b: Rect): Rect => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const boxesOf = (s: TextShow, u: StreamUnit | undefined) => glyphBoxes(s, u);
const showText = (s: TextShow) => s.glyphs.map((g) => g.ch).join("");

/** A piece of the page to tag: a text show, a form XObject with text, or a picture — each one page operation. */
interface Block {
  kind: "text" | "form" | "figure";
  /** the stream ("page", "form:<num gen>") and its operation wrapped */
  unit: string;
  op: number;
  text: string;
  box: Rect;
  size: number;
  y: number;
}
interface Para {
  role: TagRole;
  blocks: Block[];
  size: number;
  box: Rect;
}

// ───────── form XObjects drawn by the page ─────────

/**
 * Each form XObject drawn by the stream `host` (Do) with the text shows of that drawing, the forms `skip` names left
 * out (they are tagged inside). A form drawn n times has its shows n times over in the analysis (in drawing order):
 * each drawing takes its share.
 */
function formDraws(sd: SurgeonDoc, a: PageAnalysis, host = "page", skip: (key: string) => boolean = () => false): { op: number; key: string; shows: TextShow[] }[] {
  const u = a.units.get(host);
  if (!u) return [];
  const xo = dictOf(dget(sd.ctx, u.resources, "XObject"));
  const ops = new Map<string, number[]>();
  u.ops.forEach((o, k) => {
    if (o.op !== "Do" || !(o.args[0] instanceof PdfName) || !xo) return;
    const r = xo.get(PDFName.of((o.args[0] as PdfName).name));
    if (!(r instanceof PDFRef)) return;
    const key = `form:${refKey(r)}`;
    if (a.units.has(key) && !skip(key)) ops.set(key, [...(ops.get(key) ?? []), k]);
  });
  const out: { op: number; key: string; shows: TextShow[] }[] = [];
  for (const [key, list] of ops) {
    const shows = a.items.filter((it): it is TextShow => it.kind === "text" && it.unit === key && !!showText(it).trim());
    if (!shows.length) continue;
    const per = Math.ceil(shows.length / list.length);
    list.forEach((op, k) => {
      const part = shows.slice(k * per, (k + 1) * per);
      if (part.length) out.push({ op, key, shows: part });
    });
  }
  return out;
}

// ───────── the page as blocks in reading order ─────────

/** The page's pieces to tag: in the page's content and in the forms `inside` names (tagged in their own streams). */
function pageBlocks(sd: SurgeonDoc, a: PageAnalysis, inside: Set<string> = new Set()): Block[] {
  const blocks: Block[] = [];
  const tagged = (unit: string) => unit === "page" || inside.has(unit);
  const textBlock = (shows: TextShow[], u: StreamUnit | undefined) => {
    let box: Rect | null = null;
    let size = 0;
    for (const s of shows) {
      for (const g of boxesOf(s, u)) box = box ? union(box, g.box) : g.box;
      size = Math.max(size, Math.abs(s.fontSize) * (Math.hypot(s.start[2], s.start[3]) || 1));
    }
    return box ? { box, size } : null;
  };
  for (const it of a.items) {
    if (it.kind === "text" && tagged(it.unit)) {
      const text = showText(it);
      if (!text.trim()) continue;
      const b = textBlock([it], a.units.get(it.unit));
      if (b) blocks.push({ kind: "text", unit: it.unit, op: it.op, text, box: b.box, size: b.size, y: (b.box[1] + b.box[3]) / 2 });
    } else if (it.kind === "image" && tagged(it.unit) && !it.hidden && !it.name.startsWith("sh:")) {
      // a picture: the unit square through its matrix; very small ones (rules, dots) are left out
      const im = it as ImageDraw;
      const pts = [apply(im.base, 0, 0), apply(im.base, 1, 0), apply(im.base, 0, 1), apply(im.base, 1, 1)];
      const box: Rect = [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))];
      if (box[2] - box[0] < 12 || box[3] - box[1] < 12) continue;
      blocks.push({ kind: "figure", unit: im.unit, op: im.op, text: "", box, size: 0, y: (box[1] + box[3]) / 2 });
    }
  }
  // forms tagged where they are drawn (drawn more than once): their text one element
  for (const host of ["page", ...inside])
    for (const f of formDraws(sd, a, host, (k) => inside.has(k))) {
      const b = textBlock(f.shows, a.units.get(f.shows[0].unit));
      if (!b) continue;
      const pieces = f.shows.map((s) => pieceOf(s)).filter((p): p is Piece => !!p);
      blocks.push({ kind: "form", unit: host, op: f.op, text: joinPieces(pieces), box: b.box, size: b.size, y: (b.box[1] + b.box[3]) / 2 });
    }
  return blocks;
}

/**
 * Column gutters: vertical bands with (almost) no text, between text on both sides at the same heights, every
 * column at least a quarter of the text width. Returns the columns' x ranges, left to right (one when there are none).
 */
export function findColumns(blocks: { box: Rect }[]): [number, number][] {
  if (blocks.length < 6) return [[-Infinity, Infinity]];
  const x0 = Math.min(...blocks.map((b) => b.box[0])), x1 = Math.max(...blocks.map((b) => b.box[2]));
  const width = x1 - x0;
  if (width <= 0) return [[-Infinity, Infinity]];
  const n = Math.ceil(width);
  const cover = new Array<number>(n + 1).fill(0);
  for (const b of blocks) for (let x = Math.max(0, Math.floor(b.box[0] - x0)); x <= Math.min(n, Math.ceil(b.box[2] - x0) - 1); x++) cover[x]++;
  // what may still cross a gutter: titles and rules spanning the columns
  const allowed = Math.max(1, Math.floor(blocks.length * 0.12));
  const gutters: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= n; x++) {
    const free = x < n && cover[x] <= allowed;
    if (free && start < 0) start = x;
    if (!free && start >= 0) {
      if (x - start >= 8) gutters.push([x0 + start, x0 + x]);
      start = -1;
    }
  }
  const cols: [number, number][] = [];
  let from = x0;
  for (const g of gutters) {
    const left = blocks.filter((b) => b.box[2] <= g[0] + 1 && b.box[0] >= from - 1);
    const right = blocks.filter((b) => b.box[0] >= g[1] - 1);
    // side by side: text on both sides at the same heights, and wide enough to be columns rather than a table's cells
    const sideBySide = left.some((l) => right.some((r) => Math.min(l.box[3], r.box[3]) > Math.max(l.box[1], r.box[1])));
    if (left.length >= 3 && right.length >= 3 && sideBySide && g[0] - from >= width * 0.25 && x1 - g[1] >= width * 0.25) {
      cols.push([from, (g[0] + g[1]) / 2]);
      from = (g[0] + g[1]) / 2;
    }
  }
  cols.push([from, x1]);
  return cols.length > 1 ? cols.map(([a, b], i) => [i ? a : -Infinity, i === cols.length - 1 ? Infinity : b] as [number, number]) : [[-Infinity, Infinity]];
}

/** Lines of text blocks: on one baseline, left to right; lines top to bottom. Forms and figures are lines alone. */
function linesOf(blocks: Block[]): Block[][] {
  const lines: Block[][] = [];
  for (const b of [...blocks].sort((p, q) => q.y - p.y || p.box[0] - q.box[0])) {
    const l = b.kind === "text" ? lines.find((x) => x[0].kind === "text" && Math.abs(x[0].y - b.y) < Math.max(1.5, Math.min(x[0].size, b.size) * 0.45)) : undefined;
    if (l) l.push(b);
    else lines.push([b]);
  }
  for (const l of lines) l.sort((p, q) => p.box[0] - q.box[0]);
  return lines.sort((p, q) => q[0].box[3] - p[0].box[3] || p[0].box[0] - q[0].box[0]);
}

/** The page's blocks as paragraphs in reading order (text roles still P; headings are decided over the file). */
function pageParas(blocks: Block[]): Para[] {
  const cols = findColumns(blocks.filter((b) => b.kind !== "figure"));
  const colOf = (b: Block) => cols.findIndex(([l, r]) => b.box[0] >= l - 2 && b.box[2] <= r + 2);
  const ordered: Block[][] = [];
  if (cols.length === 1) ordered.push(...linesOf(blocks));
  else {
    // bands between what spans the columns, each read column by column
    const spanning = linesOf(blocks.filter((b) => colOf(b) < 0));
    const inCol = cols.map((_, c) => linesOf(blocks.filter((b) => colOf(b) === c)));
    let top = Infinity;
    for (const s of [...spanning, null]) {
      const bottom = s ? Math.max(...s.map((b) => b.box[3])) : -Infinity;
      for (const lines of inCol) for (const l of lines) if (l[0].y < top && l[0].y >= bottom) ordered.push(l);
      if (s) ordered.push(s);
      top = s ? Math.min(...s.map((b) => b.box[1])) : top;
    }
  }
  // paragraphs: a text line joins the one above when it is the same size, close below it and overlaps it across
  const paras: Para[] = [];
  for (const l of ordered) {
    const box = l.reduce((b, s) => union(b, s.box), l[0].box);
    const size = Math.max(...l.map((s) => s.size));
    const prev = paras[paras.length - 1];
    const text = l[0].kind === "text";
    const join = text && prev?.blocks[0].kind === "text" && Math.abs(prev.size - size) <= Math.max(0.5, size * 0.1) && prev.box[1] - box[3] < size * 0.9 && prev.box[1] - box[3] > -size * 0.5 && box[0] < prev.box[2] && box[2] > prev.box[0];
    if (join) {
      prev.blocks.push(...l);
      prev.box = union(prev.box, box);
    } else paras.push({ role: l[0].kind === "figure" ? "Figure" : "P", blocks: [...l], size, box });
  }
  return paras;
}

/** The text of a paragraph: its blocks in order, a space between lines and between blocks far apart. */
function paraText(p: Para): string {
  return joinPieces(p.blocks.map((b) => ({ text: b.text, x0: b.box[0], x1: b.box[2], y: b.y, size: b.size || 1 })))
    .replace(/\s+/g, " ")
    .trim();
}

/** Is there a structure tree already? */
export async function isTagged(bytes: Uint8Array): Promise<boolean> {
  const sd = await openSurgeonDoc(bytes);
  return !!dget(sd.ctx, sd.pdf.catalog, "StructTreeRoot");
}

export async function autoTag(bytes: Uint8Array): Promise<AutoTagResult> {
  const sd = await openSurgeonDoc(bytes);
  const { ctx } = sd;
  const catalog = sd.pdf.catalog;
  if (dget(ctx, catalog, "StructTreeRoot")) return { bytes, items: (await readingOrder(bytes)).items, already: true };
  const analyses = sd.pageRefs.map((_, i) => {
    try {
      return analyze(sd, i);
    } catch {
      return null;
    }
  });
  // forms drawn exactly once in the whole file: tagged inside their own streams
  const uses = new Map<string, number>();
  for (const a of analyses) for (const [k, u] of a?.units ?? []) if (k !== "page") uses.set(k, (uses.get(k) ?? 0) + u.uses);
  const inside = new Set([...uses].filter(([k, n]) => n === 1 && analyses.some((a) => a?.units.get(k)?.formRef)).map(([k]) => k));
  const pages = analyses.map((a) => {
    try {
      return { a, paras: a ? pageParas(pageBlocks(sd, a, inside)) : ([] as Para[]) };
    } catch {
      return { a, paras: [] as Para[] };
    }
  });
  // the body size: the size most of the text is set in (weighted by characters); headings stand clearly above it
  const weight = new Map<number, number>();
  const sizeKey = (s: number) => Math.round(s * 2) / 2;
  for (const p of pages) for (const q of p.paras) for (const b of q.blocks) if (b.kind === "text") weight.set(sizeKey(b.size), (weight.get(sizeKey(b.size)) ?? 0) + b.text.length);
  const body = [...weight].sort((x, y) => y[1] - x[1])[0]?.[0] ?? 10;
  const big = [...weight.keys()].filter((s) => s >= body * 1.2).sort((x, y) => y - x);
  const h1 = big.filter((s) => s >= Math.max(body * 1.6, big[0] * 0.85));
  for (const p of pages)
    for (const q of p.paras) {
      if (q.blocks[0].kind !== "text") continue;
      const sz = sizeKey(q.size);
      // a heading is short: a long block in a big size is still a paragraph
      if (sz >= body * 1.2 && paraText(q).length <= 200) q.role = h1.includes(sz) || sz >= body * 1.6 ? "H1" : "H2";
    }

  const rootRef = ctx.nextRef();
  const docRef = ctx.nextRef();
  const docKids: PDFRef[] = [];
  const nums: PDFObject[] = [];
  const items: TagItem[] = [];
  let nextKey = sd.pageRefs.length;
  pages.forEach((p, i) => {
    const pageU = p.a?.units.get("page");
    if (!pageU || !p.paras.length) return;
    const pageRef = sd.pageRefs[i];
    // per stream: its MCIDs' elements and the operations wrapped
    const parents = new Map<string, PDFRef[]>();
    const wraps = new Map<string, Map<number, { mcid: number; role: string }>>();
    for (const q of p.paras) {
      const ref = ctx.nextRef();
      const kids: PDFObject[] = [];
      // in content order inside the element (the order a reader takes the pieces of the paragraph)
      for (const b of q.blocks) {
        const w = wraps.get(b.unit) ?? new Map<number, { mcid: number; role: string }>();
        wraps.set(b.unit, w);
        if (w.has(b.op)) continue;
        const pl = parents.get(b.unit) ?? [];
        parents.set(b.unit, pl);
        const mcid = pl.length;
        pl.push(ref);
        w.set(b.op, { mcid, role: q.role });
        const formRef = b.unit === "page" ? null : p.a!.units.get(b.unit)?.formRef;
        kids.push(formRef ? ctx.obj({ Type: "MCR", Pg: pageRef, Stm: formRef, MCID: mcid }) : PDFNumber.of(mcid));
      }
      if (!kids.length) continue;
      const el = ctx.obj({ Type: "StructElem", S: q.role, P: docRef, Pg: pageRef, K: kids.length === 1 ? kids[0] : kids }) as PDFDict;
      // a figure's place on the page (Acrobat writes it as a layout attribute)
      if (q.role === "Figure") el.set(PDFName.of("A"), ctx.obj({ O: "Layout", BBox: q.box.map((v) => Math.round(v * 100) / 100) }));
      ctx.assign(ref, el);
      docKids.push(ref);
      items.push({ role: q.role, text: q.role === "Figure" ? "" : paraText(q), page: i, ref: refKey(ref) });
    }
    // each stream with its tagged operations inside their marked-content sequences
    const pd = pageDict(sd, i);
    pd.set(PDFName.of("Tabs"), PDFName.of("S"));
    for (const [unit, w] of wraps) {
      const u = p.a!.units.get(unit)!;
      const out = wrapOps(u, w);
      if (unit === "page") {
        pd.set(PDFName.of("Contents"), ctx.register(ctx.flateStream(out)));
        pd.set(PDFName.of("StructParents"), PDFNumber.of(i));
        nums.push(PDFNumber.of(i), ctx.obj(parents.get(unit)!));
        continue;
      }
      // a form drawn once: its stream rewritten, its own key in the parent tree
      const old = u.formRef && ctx.lookup(u.formRef);
      if (!(old instanceof PDFStream) || !u.formRef) continue;
      const st = ctx.flateStream(out);
      for (const [key, v] of old.dict.entries()) if (!["/Filter", "/DecodeParms", "/Length", "/DL"].includes(key.asString())) st.dict.set(key, v);
      st.dict.set(PDFName.of("StructParents"), PDFNumber.of(nextKey));
      ctx.assign(u.formRef, st);
      nums.push(PDFNumber.of(nextKey++), ctx.obj(parents.get(unit)!));
    }
  });
  ctx.assign(docRef, ctx.obj({ Type: "StructElem", S: "Document", P: rootRef, K: docKids }));
  ctx.assign(rootRef, ctx.obj({ Type: "StructTreeRoot", K: docRef, ParentTree: ctx.obj({ Nums: nums }), ParentTreeNextKey: nextKey }));
  catalog.set(PDFName.of("StructTreeRoot"), rootRef);
  catalog.set(PDFName.of("MarkInfo"), ctx.obj({ Marked: true }));
  if (!catalog.get(PDFName.of("Lang"))) catalog.set(PDFName.of("Lang"), PDFString.of(items.some((x) => /\p{Script=Hangul}/u.test(x.text)) ? "ko-KR" : "en-US"));
  const vp = dictOf(dget(ctx, catalog, "ViewerPreferences")) ?? (ctx.obj({}) as PDFDict);
  vp.set(PDFName.of("DisplayDocTitle"), ctx.obj(true));
  catalog.set(PDFName.of("ViewerPreferences"), vp);
  return { bytes: await savePdf(sd.pdf), items, already: false };
}

/** The stream's bytes with each operation of `w` inside its marked-content sequence. */
function wrapOps(u: StreamUnit, w: Map<number, { mcid: number; role: string }>): Uint8Array {
  const parts: Uint8Array[] = [];
  let pos = 0;
  const enc = new TextEncoder();
  for (const op of [...w.keys()].sort((x, y) => x - y)) {
    const o = u.ops[op];
    const x = w.get(op)!;
    parts.push(u.bytes.subarray(pos, o.s), enc.encode(`\n/${x.role} <</MCID ${x.mcid}>> BDC\n`), u.bytes.subarray(o.s, o.e), enc.encode("\nEMC\n"));
    pos = o.e;
  }
  parts.push(u.bytes.subarray(pos));
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let k = 0;
  for (const x of parts) out.set(x, k), (k += x.length);
  return out;
}

/** A structure element's alternate text (Acrobat ▸ 읽기 순서 ▸ 그림 ▸ 대체 텍스트); empty removes it. */
export async function setAltText(bytes: Uint8Array, ref: string, alt: string): Promise<Uint8Array> {
  const sd = await openSurgeonDoc(bytes);
  const [num, gen] = ref.split(" ").map(Number);
  const el = sd.ctx.lookup(PDFRef.of(num, gen || 0));
  if (!(el instanceof PDFDict) || nameOf(el.get(PDFName.of("Type"))) !== "StructElem") throw new Error(`no structure element ${ref}`);
  const v = alt.trim();
  if (v) el.set(PDFName.of("Alt"), /^[\x20-\x7e]*$/.test(v) ? PDFString.of(v) : PDFHexString.fromText(v));
  else el.delete(PDFName.of("Alt"));
  return savePdf(sd.pdf);
}

// ───────── reading a structure tree ─────────

/** a piece of marked content: its text and where it starts and ends (to tell a new line or word from the next) */
interface Piece {
  text: string;
  x0: number;
  x1: number;
  y: number;
  size: number;
}
function pieceOf(s: TextShow): Piece | null {
  const g = s.glyphs;
  if (!g.length) return null;
  return { text: showText(s), x0: g[0].x0, x1: g[g.length - 1].x1, y: g[0].y0, size: Math.abs(s.fontSize) * (Math.hypot(s.start[2], s.start[3]) || 1) };
}
/** Pieces in order as one text: a space where the next starts a line or stands apart. */
function joinPieces(ps: Piece[]): string {
  let out = "";
  let prev: Piece | null = null;
  for (const p of ps) {
    if (!p.text) continue;
    if (prev && !/\s$/.test(out) && !/^\s/.test(p.text) && (Math.abs(prev.y - p.y) > Math.min(prev.size, p.size) * 0.45 || p.x0 - prev.x1 > p.size * 0.3)) out += " ";
    out += p.text;
    prev = p;
  }
  return out;
}

/**
 * Each page's marked content by stream ("page", "form:<num gen>"): MCID → what is shown inside it (text, and the text
 * of a form drawn inside the sequence when that form has no marked content of its own).
 */
function mcidText(sd: SurgeonDoc, i: number): Map<string, Map<number, Piece>> {
  const all = new Map<string, Map<number, Piece>>();
  let a: PageAnalysis;
  try {
    a = analyze(sd, i);
  } catch {
    return all;
  }
  const opMcids = new Map<string, Map<number, number>>();
  for (const [key, u] of a.units) opMcids.set(key, opMcidOf(u));
  for (const [key, u] of a.units) {
    const out = new Map<number, Piece>();
    all.set(key, out);
    const opMcid = opMcids.get(key)!;
    const add = (m: number, piece: Piece | null) => {
      if (!piece) return;
      const was = out.get(m);
      out.set(m, was ? { ...was, text: joinPieces([was, piece]), x1: piece.x1, y: piece.y } : piece);
    };
    for (const it of a.items) {
      if (it.kind !== "text" || it.unit !== key) continue;
      const m = opMcid.get(it.op);
      if (m !== undefined) add(m, pieceOf(it));
    }
    for (const f of formDraws(sd, a, u.key, (k) => (opMcids.get(k)?.size ?? 0) > 0)) {
      const m = opMcid.get(f.op);
      if (m !== undefined) for (const s of f.shows) add(m, pieceOf(s));
    }
  }
  return all;
}

/** the innermost MCID around each operation of a stream */
function opMcidOf(u: StreamUnit): Map<number, number> {
  const opMcid = new Map<number, number>();
  const stack: (number | null)[] = [];
  u.ops.forEach((o, k) => {
    if (o.op === "BDC") {
      const p = o.args[1];
      const m = p instanceof PdfDict ? p.get("MCID") : null;
      stack.push(typeof m === "number" ? m : null);
    } else if (o.op === "BMC") stack.push(null);
    else if (o.op === "EMC") stack.pop();
    else {
      for (let j = stack.length - 1; j >= 0; j--)
        if (stack[j] !== null) {
          opMcid.set(k, stack[j]!);
          break;
        }
    }
  });
  return opMcid;
}

export async function readingOrder(bytes: Uint8Array): Promise<{ tagged: boolean; items: TagItem[] }> {
  const sd = await openSurgeonDoc(bytes);
  const { ctx } = sd;
  const root = dictOf(dget(ctx, sd.pdf.catalog, "StructTreeRoot"));
  if (!root) return { tagged: false, items: [] };
  const roleMap = dictOf(dget(ctx, root, "RoleMap"));
  const role = (s: string) => {
    let r = s;
    for (let n = 0; n < 8; n++) {
      const m = nameOf(dget(ctx, roleMap, r));
      if (!m || m === r) break;
      r = m;
    }
    return r;
  };
  const pageNo = new Map(sd.pageRefs.map((r, i) => [r.toString(), i]));
  const texts = new Map<number, Map<string, Map<number, Piece>>>();
  const pieceOn = (page: number, mcid: number, stream = "page"): Piece[] => {
    if (!texts.has(page)) texts.set(page, mcidText(sd, page));
    const p = texts.get(page)!.get(stream)?.get(mcid);
    return p ? [p] : [];
  };
  const pageOf = (o: PDFObject | undefined, inherited: number) => (o instanceof PDFRef ? (pageNo.get(o.toString()) ?? inherited) : inherited);
  const items: TagItem[] = [];
  const seen = new Set<PDFDict>();
  interface El {
    d: PDFDict;
    pg: number;
    ref?: PDFRef;
  }
  /** the element's kids: MCIDs (with their page) and child elements */
  const kids = (e: PDFDict, pg: number) => {
    const k = look(ctx, e.get(PDFName.of("K")));
    const list = k instanceof PDFArray ? k.asArray() : e.get(PDFName.of("K")) !== undefined ? [e.get(PDFName.of("K"))!] : [];
    const mc: { page: number; mcid: number; stream?: string }[] = [];
    const elems: El[] = [];
    for (const x of list) {
      const v = look(ctx, x);
      if (v instanceof PDFNumber) mc.push({ page: pg, mcid: v.asNumber() });
      else if (v instanceof PDFDict) {
        const t = nameOf(v.get(PDFName.of("Type")));
        if (t === "MCR") {
          const m = numOf(look(ctx, v.get(PDFName.of("MCID"))));
          // in a form XObject's stream (/Stm) or the page's
          const stm = v.get(PDFName.of("Stm"));
          if (m !== undefined) mc.push({ page: pageOf(v.get(PDFName.of("Pg")), pg), mcid: m, stream: stm instanceof PDFRef ? `form:${refKey(stm)}` : undefined });
        } else if (t !== "OBJR" && v.get(PDFName.of("S"))) elems.push({ d: v, pg: pageOf(v.get(PDFName.of("Pg")), pg), ref: x instanceof PDFRef ? x : undefined });
      }
    }
    return { mc, elems };
  };
  const piecesOf = (e: PDFDict, pg: number, depth = 0): Piece[] => {
    if (depth > 64) return [];
    const { mc, elems } = kids(e, pg);
    return [...mc.flatMap((m) => pieceOn(m.page, m.mcid, m.stream)), ...elems.flatMap((c) => piecesOf(c.d, c.pg, depth + 1))];
  };
  const walk = ({ d: e, pg, ref }: El, depth: number) => {
    if (seen.has(e) || depth > 64 || items.length > 5000) return;
    seen.add(e);
    const { mc, elems } = kids(e, pg);
    const s = role(nameOf(e.get(PDFName.of("S"))) ?? "");
    const alt = textOf(look(ctx, e.get(PDFName.of("Alt"))));
    const actual = textOf(look(ctx, e.get(PDFName.of("ActualText"))));
    if (mc.length || alt !== undefined || actual !== undefined || s === "Figure") {
      // an element holding content: listed with all the text under it
      const text = s === "Figure" ? "" : (actual ?? joinPieces(piecesOf(e, pg)));
      items.push({ role: s, text: text.replace(/\s+/g, " ").trim(), page: mc[0]?.page ?? pg, ref: ref ? refKey(ref) : undefined, alt });
      return;
    }
    for (const c of elems) walk(c, depth + 1);
  };
  const topRaw = root.get(PDFName.of("K"));
  const top = look(ctx, topRaw);
  for (const x of top instanceof PDFArray ? top.asArray() : topRaw ? [topRaw] : []) {
    const d = look(ctx, x);
    if (d instanceof PDFDict) walk({ d, pg: pageOf(d.get(PDFName.of("Pg")), 0), ref: x instanceof PDFRef ? x : undefined }, 0);
  }
  return { tagged: true, items };
}
