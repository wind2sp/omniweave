// Office Surgeon, PPTX — a deck is saved into its original package.
//
// stage 0  a deck saved without changes is the original file, byte for byte.
// stage 1  only what changed is written: an unchanged slide keeps its part as it was (its rels, notes, media, animations);
//          in a changed slide only the changed shapes are rewritten — a moved shape gets a new a:off, an edited text box
//          new run text in its own a:r (format, fields and line breaks untouched), anything else is written anew with
//          its shape id (so p:timing still finds it); deleted shapes leave the slide with the animations that pointed at
//          them. Added, removed and reordered slides change presentation.xml (sldIdLst, sections), its relationships and
//          [Content_Types].xml only. Layouts, masters and the theme are never touched.
//
// open: the original bytes are kept as an asset and every page gets its slide's map (page.source.office):
//   blocks[0]  ids [page id], fp [slide fingerprint, slide index, slide count, background + transition at import]
//   blocks[1]  the nodes copied from the background picture, master and layout: ids, fp [fingerprint, "bg" | ""]
//   blocks[2…] each p:spTree element that gave nodes: ids, fp [fingerprint, index among the p:spTree children,
//              "x,y,cx,cy" EMU of a placeholder placed by its layout / master]
// save: pptxUnchanged (stage 0), else pptxSurgical (stage 1), else the deck is written anew (exportPptx).

import { getBlob } from "../../core/assets";
import type { AssetRef, OfficeSourceMeta, OmwDocument, Page, SceneNode, SlideChart, TextNode, TextParagraph, TextRun } from "../../core/types";
import { t } from "../../i18n";
import { contentKey, isEmptyPh, layoutDecor, layoutPhOf } from "../../core/slides";
import { chartFrameNow, chartRun, drawChart } from "../formats/pptxChart";
import { chartPartWithData, workbookWithData } from "./pptxChart";
import { CT_CHART, chartSpaceXml, chartWorkbook } from "../formats/pptxChartWrite";
import { CT_DGM, dataModelXml } from "../formats/pptxSmartArt";
import type { SmartData } from "../../core/smartArt";
import { withAnimTiming } from "../formats/pptxAnim";
import { CT_NOTES, NOTES_MASTER_XML, importPptx, pptxLayoutSlides, slideHfXml, themeXml, notesParasXml, notesSlideXml, parasXml, relsXml, runXml, sectionExtXml, sectionLstXml, slidePartXml, slideWriter, solidBgXml, transitionXml, type Rasterize, type SlideEnv, type SlideTrace } from "../formats/pptx";
import { childNamed, childrenOf, descendantsNamed, rootOf, type XmlEl } from "./scan";
import { entryData, readZip, rewriteZip, type ZipArchive } from "./zip";

/** Rule version of PPTX maps: 1 = one map on the first page (stage 0 only), 2 = a map per page (stage 1). */
export const PPTX_ENGINE_VERSION = 2;

const EMU = 9525;
const tn = (key: string, n: number, vars: Record<string, string | number> = {}) => t(n === 1 ? `${key}_one` : key, { n, ...vars });
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_SLIDE = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";

function fnv(s: string, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
const hash = (s: string) => fnv(s, 2166136261) + fnv(s, 0x9747b28c) + s.length.toString(16);

/** Content fingerprint of a slide: everything that is drawn or played (not its name in the slide list). */
export function slideFingerprint(p: Page): string {
  // (animations only when there are some: a slide read from a file has none, so its fingerprint is as before)
  // (머리글/바닥글 only when set here: a slide read from a file has none, so its fingerprint is as before)
  return hash(JSON.stringify([p.width, p.height, p.background, p.transition, p.nodes, p.groups ?? null, ...(p.animations?.length ? [p.animations] : []), ...(p.slideHf ? [p.slideHf] : []), ...(p.bgGrad ? [p.bgGrad] : [])]));
}

/**
 * Nodes as content only: ids left out (a node read again from the original gets new ones) and assets named by their
 * content hash.
 */
function normJson(v: unknown, assets: Record<string, AssetRef>): string {
  return JSON.stringify(v, (k, x) => (k === "id" ? undefined : (k === "assetId" || k === "posterAssetId") && typeof x === "string" ? assets[x]?.hash ?? x : x));
}
const nodesFp = (nodes: readonly SceneNode[], assets: Record<string, AssetRef>) => hash(normJson(nodes, assets));
const pageLook = (p: Page) => JSON.stringify([p.background, p.transition]);
/** What the slide list and notes hold of a slide (not drawn): hidden, layout, section, speaker notes. */
const slideAttrs = (p: Page) => JSON.stringify([!!p.hidden, p.layout ?? "", p.section ?? null, p.notes ?? ""]);
/** [hidden, layout, section, notes] at import; null for maps made before these were kept (left as in the file). */
const attrsAt = (fp: string[]): [boolean, string, string | null, string] | null => (fp[4] ? JSON.parse(fp[4]) : null);

// ───────── open ─────────

/**
 * The map of a just-imported deck, one per page (`slideParts[i]` / `trace[i]` = pages[i]'s slide part and node origins;
 * `assets` = the import's). Each page gets its own, so deleting the first slide keeps the others' maps.
 */
export function attachPptxMeta(pages: Page[], slideParts: string[], trace: SlideTrace[], asset: Pick<AssetRef, "id" | "hash">, assets: Record<string, AssetRef>): void {
  pages.forEach((p, i) => {
    const tr = trace[i];
    if (!p.source || !tr || !slideParts[i]) return;
    const blocks = [{ ids: [p.id], fp: [slideFingerprint(p), String(i), String(pages.length), pageLook(p), slideAttrs(p)] }];
    const inh = p.nodes.slice(0, tr.inh);
    blocks.push({ ids: inh.map((n) => n.id), fp: [nodesFp(inh, assets), tr.bg ? "bg" : ""] });
    let at = tr.inh;
    for (const el of tr.els) {
      const nodes = p.nodes.slice(at, at + el.n);
      at += el.n;
      blocks.push({ ids: nodes.map((n) => n.id), fp: [nodesFp(nodes, assets), String(el.k), el.box ?? ""] });
    }
    p.source.office = { engine: PPTX_ENGINE_VERSION, assetId: asset.id, hash: asset.hash, parts: [{ part: slideParts[i], blocks }] };
  });
}

/** Stage-0 map of a deck (engine 1, on the first page): one part per slide, its page id and fingerprint. */
export function pptxMeta(pages: Page[], slideParts: string[], asset: Pick<AssetRef, "id" | "hash">): OfficeSourceMeta {
  return {
    engine: 1,
    assetId: asset.id,
    hash: asset.hash,
    parts: pages.map((p, i) => ({ part: slideParts[i] ?? "", blocks: [{ ids: [p.id], fp: [slideFingerprint(p)] }] })),
  };
}

const ownMeta = (p: Page) => (p.source?.format === "pptx" && p.source.office?.engine === PPTX_ENGINE_VERSION && p.source.office.parts.length === 1 ? p.source.office : undefined);

/** The original deck when `pages` are its slides unchanged (same slides, same order, same content), else null. */
export function pptxUnchanged(pages: Page[]): Uint8Array | null {
  const first = pages[0]?.source?.format === "pptx" ? pages[0].source.office : undefined;
  if (!first) return null;
  if (first.engine === 1) {
    if (first.parts.length !== pages.length) return null;
    for (let i = 0; i < pages.length; i++) {
      const b = first.parts[i].blocks[0];
      if (!b || b.ids[0] !== pages[i].id || b.fp[0] !== slideFingerprint(pages[i])) return null;
    }
    return getBlob(first.hash) ?? null;
  }
  for (let i = 0; i < pages.length; i++) {
    const m = ownMeta(pages[i]);
    const b = m?.parts[0].blocks[0];
    if (!m || m.hash !== first.hash || !b || b.ids[0] !== pages[i].id || b.fp[1] !== String(i) || b.fp[2] !== String(pages.length) || b.fp[0] !== slideFingerprint(pages[i])) return null;
    if (b.fp[4] && b.fp[4] !== slideAttrs(pages[i])) return null;
  }
  return getBlob(first.hash) ?? null;
}

// ───────── XML text helpers ─────────

const attrIn = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name.replace(":", "\\:")}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return m ? m[1] ?? m[2] : null;
};
const openTag = (s: string, el: XmlEl) => s.slice(el.start, el.openEnd);
const elText = (s: string, el: XmlEl) => s.slice(el.start, el.end);
/** `tag` with attribute `name` set to `value` (added before the tag's end when absent). */
function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}\\s*=\\s*)(?:"[^"]*"|'[^']*')`);
  if (re.test(tag)) return tag.replace(re, `$1"${value}"`);
  const end = tag.endsWith("/>") ? tag.length - 2 : tag.length - 1;
  return tag.slice(0, end) + ` ${name}="${value}"` + tag.slice(end);
}
const decode = (t: string) =>
  t.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ({ lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()],
  );
const escText = (t: string) => t.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
/** Text with element `el` (of `s`) replaced by `by` ("" removes it). */
const splice = (s: string, el: { start: number; end: number }, by: string) => s.slice(0, el.start) + by + s.slice(el.end);

/** Every shape id (cNvPr id) in a piece of slide XML. */
const shapeIds = (t: string) => [...t.matchAll(/<(?:\w+:)?cNvPr\b[^>]*?\sid\s*=\s*"(\d+)"/g)].map((m) => m[1]);

// ───────── shape surgery ─────────

/** The transforms (a:xfrm / p:xfrm) that place a top-level shape-tree element (both branches of mc:AlternateContent). */
function placements(t: string, el: XmlEl): XmlEl[] {
  switch (el.local) {
    case "sp":
    case "cxnSp":
    case "pic": {
      const pr = childNamed(t, el, "spPr");
      const x = pr && childNamed(t, pr, "xfrm");
      return x ? [x] : [];
    }
    case "grpSp": {
      const pr = childNamed(t, el, "grpSpPr");
      const x = pr && childNamed(t, pr, "xfrm");
      return x ? [x] : [];
    }
    case "graphicFrame": {
      const x = childNamed(t, el, "xfrm");
      return x ? [x] : [];
    }
    case "contentPart":
      return [];
    case "AlternateContent": {
      const out: XmlEl[] = [];
      for (const br of childrenOf(t, el)) for (const c of childrenOf(t, br)) out.push(...placements(t, c));
      return out;
    }
  }
  return [];
}

/** Element text with every placement moved by (dx, dy) EMU; a placeholder placed by its layout gets its own a:xfrm. Null when it has no placement. */
function moveElement(t: string, dx: number, dy: number, box: string): string | null {
  const el = rootOf(t);
  const xs = placements(t, el);
  if (!xs.length) {
    if (!box || (el.local !== "sp" && el.local !== "pic")) return null;
    const [x, y, cx, cy] = box.split(",").map(Number);
    const pr = childNamed(t, el, "spPr");
    if (!pr) return null;
    const xfrm = `<a:xfrm><a:off x="${x + dx}" y="${y + dy}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
    return pr.openEnd === pr.end ? splice(t, pr, openTag(t, pr).replace(/\s*\/>$/, ">") + xfrm + `</${pr.name}>`) : t.slice(0, pr.openEnd) + xfrm + t.slice(pr.openEnd);
  }
  // from the last one, so earlier offsets stay valid
  for (const x of [...xs].sort((a, b) => b.start - a.start)) {
    const off = childNamed(t, x, "off");
    if (!off) return null;
    let tag = elText(t, off);
    tag = setAttr(tag, "x", String(Math.round(Number(attrIn(tag, "x") ?? 0) + dx)));
    tag = setAttr(tag, "y", String(Math.round(Number(attrIn(tag, "y") ?? 0) + dy)));
    t = splice(t, off, tag);
  }
  return t;
}

/** Runs without the list marker text the importer / renumbering put in front. */
function bodyRuns(p: TextParagraph): TextRun[] {
  let k = p.list?.mk && p.runs.map((r) => r.text).join("").startsWith(p.list.mk) ? p.list.mk.length : 0;
  const out: TextRun[] = [];
  for (const r of p.runs) {
    if (k >= r.text.length) k -= r.text.length;
    else {
      out.push(k ? { ...r, text: r.text.slice(k) } : r);
      k = 0;
    }
  }
  return out;
}
const runFormat = (r: TextRun, withFont: boolean) => JSON.stringify({ ...r, text: undefined, ...(withFont ? {} : { fontFamily: undefined, latinFont: undefined }) });
const charKeys = (runs: TextRun[], withFont: boolean) => runs.flatMap((r) => Array.from({ length: r.text.length }, () => runFormat(r, withFont)));
const paraKey = (p: TextParagraph) => JSON.stringify(p, (k, x) => (k === "id" ? undefined : x));
const paraProps = (p: TextParagraph) => JSON.stringify({ ...p, runs: undefined, id: undefined, list: p.list ? { ...p.list, id: undefined, mk: undefined } : undefined });

/**
 * One a:p with its run text changed from `o` to `c` when that is all that changed: the changed characters lie in
 * plain runs (a:r) and new ones take the format of the run they are typed into. The a:p keeps its a:pPr, every
 * a:rPr, fields and line breaks. Null otherwise.
 */
function patchParagraph(t: string, pEl: XmlEl, o: TextParagraph, c: TextParagraph): string | null {
  if (paraProps(o) !== paraProps(c)) return null;
  const or = bodyRuns(o), cr = bodyRuns(c);
  const O = or.map((r) => r.text).join(""), C = cr.map((r) => r.text).join("");
  const ok = charKeys(or, true), ck = charKeys(cr, true);
  // the a:p's text pieces in order: a:r / a:fld text, a:br as "\n"
  const segs: { el: XmlEl; kind: string; text: string; tEl?: XmlEl; at: number }[] = [];
  let at = 0;
  // a slide number field reads as the slide's number (io/formats/pptx.ts), not as its saved text ("‹#›", or the
  // number of the place the slide had when saved): its piece takes the text the importer gave its run
  const nums = or.filter((r) => r.field === "page").map((r) => r.text);
  for (const ch of childrenOf(t, pEl)) {
    if (ch.local !== "r" && ch.local !== "fld" && ch.local !== "br") continue;
    const tEl = ch.local === "br" ? undefined : childNamed(t, ch, "t");
    const num = ch.local === "fld" && attrIn(openTag(t, ch), "type") === "slidenum" ? nums.shift() : undefined;
    const text = ch.local === "br" ? "\n" : num !== undefined ? num : tEl && tEl.openEnd !== tEl.end ? decode(t.slice(tEl.openEnd, tEl.closeStart)) : "";
    if (!text) continue;
    segs.push({ el: ch, kind: ch.local, text, tEl, at });
    at += text.length;
  }
  // (a field whose text the importer did not read as written, or capitals drawn from lower case: lengths differ)
  if (at !== O.length || !O.length) return null;
  let p = 0;
  while (p < O.length && p < C.length && O[p] === C[p] && ok[p] === ck[p]) p++;
  let s = 0;
  while (s < O.length - p && s < C.length - p && O[O.length - 1 - s] === C[C.length - 1 - s] && ok[O.length - 1 - s] === ck[C.length - 1 - s]) s++;
  const delFrom = p, delTo = O.length - s, ins = C.slice(p, C.length - s);
  if (delFrom === delTo && !ins) return null; // nothing to do here (format only): not a text change
  if (ins.includes("\n")) return null;
  // the run the text is typed into: the one before the change, else the one after it
  const host = segs.find((g) => (p > 0 ? g.at < p && p <= g.at + g.text.length : g.at <= p && p < g.at + g.text.length)) ?? segs[segs.length - 1];
  if (!host || host.kind !== "r" || !host.tEl) return null;
  const hostKey = runFormat(or[runIndexAt(or, p > 0 ? p - 1 : Math.min(p, O.length - 1))], false);
  for (let i = p; i < C.length - s; i++) if (runFormat(cr[runIndexAt(cr, i)], false) !== hostKey) return null;
  // removed characters only from plain runs
  for (const g of segs) if (g.at < delTo && delFrom < g.at + g.text.length && g.kind !== "r") return null;
  let out = t.slice(pEl.start, pEl.end);
  const base = pEl.start;
  for (const g of [...segs].sort((a, b) => b.el.start - a.el.start)) {
    if (g.kind !== "r") continue;
    const a0 = Math.max(delFrom, g.at) - g.at, a1 = Math.min(delTo, g.at + g.text.length) - g.at;
    let text = a0 < a1 ? g.text.slice(0, a0) + g.text.slice(a1) : g.text;
    if (g === host) {
      const k = Math.min(text.length, Math.max(0, p - g.at));
      text = text.slice(0, k) + ins + text.slice(k);
    }
    if (text === g.text) continue;
    if (!text) {
      out = splice(out, { start: g.el.start - base, end: g.el.end - base }, "");
      continue;
    }
    const tEl = g.tEl!;
    out = splice(out, { start: tEl.start - base, end: tEl.end - base }, openTag(t, tEl).replace(/\s*\/>$/, ">") + escText(text) + `</${tEl.name}>`);
  }
  return out;
}

function runIndexAt(runs: TextRun[], i: number): number {
  for (let k = 0, at = 0; k < runs.length; k++) {
    at += runs[k].text.length;
    if (i < at) return k;
  }
  return runs.length - 1;
}

/** Longest common subsequence of two key lists: matched index pairs in order. */
function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length, m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) d[i][j] = a[i] === b[j] ? d[i + 1][j + 1] + 1 : Math.max(d[i + 1][j], d[i][j + 1]);
  const out: [number, number][] = [];
  for (let i = 0, j = 0; i < n && j < m; )
    if (a[i] === b[j]) out.push([i, j]), i++, j++;
    else if (d[i + 1][j] >= d[i][j + 1]) i++;
    else j++;
  return out;
}

/**
 * The p:sp element with the text of `o` changed to `c`: unchanged paragraphs stay as they were, a paragraph whose run
 * text changed keeps its XML but that text, others are written anew (in the a:pPr of the original paragraph they
 * replace). Null when the text body does not match the original read.
 */
function patchText(t: string, o: TextNode, c: TextNode): { xml: string; paras: number } | null {
  const sp = rootOf(t);
  const tx = sp.local === "sp" ? childNamed(t, sp, "txBody") : undefined;
  if (!tx) return null;
  const pEls = childrenOf(t, tx).filter((x) => x.local === "p");
  if (pEls.length !== o.paragraphs.length) return null;
  // autofit: runs were read at fontScale; new runs are written at their size before it
  const fit = childNamed(t, childNamed(t, tx, "bodyPr") ?? tx, "normAutofit");
  const fs = fit ? Number(attrIn(openTag(t, fit), "fontScale") ?? 100000) / 100000 || 1 : 1;
  const pPrOf = (el: XmlEl) => {
    const pr = childNamed(t, el, "pPr");
    return pr ? elText(t, pr) : "";
  };
  const endOf = (el: XmlEl) => {
    const e = childNamed(t, el, "endParaRPr");
    return e ? elText(t, e) : "";
  };
  const fresh = (cp: TextParagraph, like: XmlEl | undefined): string => {
    if (like && paraProps(cp) === paraProps(o.paragraphs[pEls.indexOf(like)])) {
      const runs = bodyRuns(cp).filter((r) => r.text).map((r) => runXml(r, 1 / fs)).join("");
      return `<a:p>${pPrOf(like)}${runs}${endOf(like)}</a:p>`;
    }
    return parasXml([cp], 1 / fs, c.lists, c.wordBreak === "keep-all");
  };
  const ok = o.paragraphs.map(paraKey), ck = c.paragraphs.map(paraKey);
  const pairs = lcs(ok, ck);
  const out: string[] = [];
  let i = 0, j = 0;
  const gap = (i1: number, j1: number) => {
    // positions between matched paragraphs: paired one to one, then the rest removed / added
    for (; i < i1 && j < j1; i++, j++) out.push(patchParagraph(t, pEls[i], o.paragraphs[i], c.paragraphs[j]) ?? fresh(c.paragraphs[j], pEls[i]));
    i = i1;
    for (; j < j1; j++) out.push(fresh(c.paragraphs[j], pEls[Math.min(i, pEls.length - 1)]));
  };
  for (const [pi, pj] of pairs) {
    gap(pi, pj);
    out.push(elText(t, pEls[pi]));
    i = pi + 1;
    j = pj + 1;
  }
  gap(pEls.length, c.paragraphs.length);
  if (!out.length) return null;
  const first = pEls[0], last = pEls[pEls.length - 1];
  return { xml: t.slice(0, first.start) + out.join("") + t.slice(last.end), paras: c.paragraphs.length };
}

/** How a node differs from the original read: not at all, moved by (dx, dy) px, its text changed, or otherwise. */
function nodeDiff(o: SceneNode, c: SceneNode, assets: { o: Record<string, AssetRef>; c: Record<string, AssetRef> }): { dx: number; dy: number; text: boolean; other: boolean } {
  const ot = o.transform, ct = c.transform;
  const turn = ot.rotation !== ct.rotation || ot.scale !== ct.scale || (ot.scaleY ?? ot.scale) !== (ct.scaleY ?? ct.scale);
  const rest = (n: SceneNode, a: Record<string, AssetRef>) => normJson({ ...n, transform: undefined, ...(n.type === "TEXT" ? { paragraphs: undefined, lists: undefined } : {}) }, a);
  const text = o.type === "TEXT" && c.type === "TEXT" && normJson([o.paragraphs, o.lists ?? null], assets.o) !== normJson([c.paragraphs, c.lists ?? null], assets.c);
  return { dx: ct.x - ot.x, dy: ct.y - ot.y, text, other: turn || rest(o, assets.o) !== rest(c, assets.c) };
}

// ───────── animations ─────────

/**
 * p:timing without the animations of shapes that are gone (`gone`), the paragraph animations of shapes that have no
 * text any more (`noText`) and those of paragraphs past a shape's last one (`paras`). Empty lists left behind are
 * removed with their parents; "" when nothing is left.
 */
function pruneTiming(t: string, gone: Set<string>, noText: Set<string>, paras: Map<string, number>): { xml: string; removed: number } {
  let removed = 0;
  const bad = (x: string) => {
    for (const m of x.matchAll(/<(?:\w+:)?spTgt\b[^>]*?\sspid\s*=\s*"(\d+)"[^>]*?(\/>|>([\s\S]*?)<\/(?:\w+:)?spTgt>)/g)) {
      const id = m[1], inner = m[3] ?? "";
      if (gone.has(id)) return true;
      if (/txEl\b/.test(inner)) {
        if (noText.has(id)) return true;
        const st = /pRg\b[^>]*?\sst\s*=\s*"(\d+)"/.exec(inner);
        const lim = paras.get(id);
        if (st && lim !== undefined && Number(st[1]) >= lim) return true;
      }
    }
    return false;
  };
  const SP = (tag: string) => attrIn(tag, "spid");
  // returns the new text of `el`, or null when it goes
  const walk = (el: XmlEl): string | null => {
    const tag = openTag(t, el);
    const whole = elText(t, el);
    switch (el.local) {
      case "par": {
        const ctn = childNamed(t, el, "cTn");
        if (ctn && attrIn(openTag(t, ctn), "presetClass") !== null && bad(whole)) return removed++, null;
        break;
      }
      case "seq": {
        const ctn = childNamed(t, el, "cTn");
        const st = ctn && childNamed(t, ctn, "stCondLst");
        if (ctn && attrIn(openTag(t, ctn), "nodeType") === "interactiveSeq" && st && bad(elText(t, st))) return removed++, null;
        break;
      }
      case "video":
      case "audio":
        if (bad(whole)) return null;
        return whole;
      case "bldP":
      case "bldGraphic":
      case "bldOleChart":
      case "bldDgm": {
        const id = SP(tag);
        if (id && (gone.has(id) || (el.local === "bldP" && noText.has(id) && attrIn(tag, "build") !== "whole"))) return null;
        return whole;
      }
    }
    const kids = childrenOf(t, el);
    if (!kids.length) return whole;
    const res = kids.map(walk);
    if (res.every((r, i) => r === elText(t, kids[i]))) return whole;
    // a time node list, build list or time node whose children are all gone goes too
    if (res.every((r) => r === null) && /^(childTnLst|tnLst|bldLst|subTnLst)$/.test(el.local)) return null;
    if (/^(par|seq|cTn|excl)$/.test(el.local) && kids.some((k, i) => res[i] === null && (k.local === "childTnLst" || k.local === "cTn"))) return null;
    // the original text between the children (whitespace) stays
    let out = t.slice(el.start, el.openEnd);
    let prevEnd = el.openEnd;
    kids.forEach((k, i) => {
      out += t.slice(prevEnd, k.start) + (res[i] ?? "");
      prevEnd = k.end;
    });
    return out + t.slice(prevEnd, el.end);
  };
  const r = walk(rootOf(t));
  return { xml: r && /tnLst\b/.test(r) ? r : "", removed };
}

// ───────── package ─────────

interface Pkg {
  z: ZipArchive;
  names: Set<string>;
  changed: Map<string, Uint8Array>;
  removed: Set<string>;
  text: (name: string) => string | null;
  put: (name: string, s: string) => void;
}

function openPkg(bytes: Uint8Array): Pkg | null {
  const z = readZip(bytes);
  if (!z) return null;
  const byName = new Map(z.entries.map((e) => [e.name, e]));
  const cache = new Map<string, string>();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const pkg: Pkg = {
    z,
    names: new Set(byName.keys()),
    changed: new Map(),
    removed: new Set(),
    text: (name) => {
      if (cache.has(name)) return cache.get(name)!;
      const e = byName.get(name);
      if (!e) return null;
      const s = dec.decode(entryData(z, e));
      cache.set(name, s);
      return s;
    },
    put: (name, s) => {
      cache.set(name, s);
      pkg.changed.set(name, enc.encode(s));
      pkg.names.add(name);
    },
  };
  return pkg;
}

const relsName = (part: string) => {
  const i = part.lastIndexOf("/");
  return `${part.slice(0, i + 1)}_rels/${part.slice(i + 1)}.rels`;
};
function resolveTarget(base: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const parts = base.split("/").slice(0, -1);
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg) parts.push(seg);
  }
  return parts.join("/");
}
interface Rel {
  id: string;
  type: string;
  target: string;
  external: boolean;
  xml: string;
}
function relsOf(pkg: Pkg, part: string): Rel[] {
  const s = pkg.text(relsName(part));
  if (!s) return [];
  return childrenOf(s, rootOf(s))
    .filter((e) => e.local === "Relationship")
    .map((e) => {
      const tag = openTag(s, e);
      const external = attrIn(tag, "TargetMode") === "External";
      const tg = attrIn(tag, "Target") ?? "";
      return { id: attrIn(tag, "Id") ?? "", type: (attrIn(tag, "Type") ?? "").split("/").pop() ?? "", target: external ? tg : resolveTarget(part, decode(tg)), external, xml: elText(s, e) };
    });
}
const maxRid = (rels: Rel[]) => rels.reduce((m, r) => Math.max(m, Number(/^rId(\d+)$/.exec(r.id)?.[1] ?? 0)), 0);

/** Parts reachable from the package root through relationships. */
function reachable(pkg: Pkg): Set<string> {
  const seen = new Set<string>();
  const todo = relsOf(pkg, "").filter((r) => !r.external).map((r) => r.target);
  // the package relationships are "_rels/.rels" (relsName("") gives "_rels/.rels")
  while (todo.length) {
    const p = todo.pop()!;
    if (seen.has(p) || !pkg.names.has(p) || pkg.removed.has(p)) continue;
    seen.add(p);
    for (const r of relsOf(pkg, p)) if (!r.external) todo.push(r.target);
  }
  return seen;
}

// ───────── save ─────────

export interface PptxSurgery {
  bytes: Uint8Array;
  warnings: string[];
}

interface SlideJob {
  page: Page;
  /** the original slide part, or null for a new slide */
  part: string | null;
  blocks: { ids: string[]; fp: string[] }[];
}

/**
 * The deck written into its original package: unchanged slides as they were, changed slides with only their
 * changed shapes rewritten, added / removed / moved slides in presentation.xml. Null when the pages carry no map
 * of one original (or it cannot be read): the caller writes the deck anew.
 */
export async function pptxSurgical(doc: OmwDocument, pages: Page[], rasterize?: Rasterize): Promise<PptxSurgery | null> {
  // slides over a layout made here (core/slideLayouts.ts): the original has no such layout — the deck is written anew
  if (pages.some((p) => p.masterId && doc.masters.some((m) => m.id === p.masterId && m.layout === "@layout"))) return null;
  // slides drawn over one of the document's masters (a theme applied here, 슬라이드 마스터 edited here: core/slideTheme.ts)
  // have a new look the original's masters do not hold: the deck is written anew with that master and theme
  // the original: the one most pages came from
  const count = new Map<string, number>();
  for (const p of pages) {
    const m = ownMeta(p);
    if (m) count.set(m.hash, (count.get(m.hash) ?? 0) + 1);
  }
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!best) return null;
  const orig = getBlob(best);
  const pkg = orig && openPkg(orig);
  if (!pkg) return null;
  const pres = pkg.text("ppt/presentation.xml");
  const ctypes = pkg.text("[Content_Types].xml");
  if (!pres || !ctypes) return null;
  const presRels = relsOf(pkg, "ppt/presentation.xml");
  const presRoot = rootOf(pres);
  const sldIdLst = childNamed(pres, presRoot, "sldIdLst");
  const sldSz = childNamed(pres, presRoot, "sldSz");
  const W = Math.round(Number(sldSz ? attrIn(openTag(pres, sldSz), "cx") : 12192000) / EMU);
  const H = Math.round(Number(sldSz ? attrIn(openTag(pres, sldSz), "cy") : 6858000) / EMU);
  // original slides: sldId element, its relationship and part
  const origSlides = (sldIdLst ? childrenOf(pres, sldIdLst) : [])
    .filter((e) => e.local === "sldId")
    .map((e) => {
      const tag = openTag(pres, e);
      const rid = /\s[\w]+:id\s*=\s*"([^"]*)"/.exec(tag)?.[1] ?? "";
      return { xml: elText(pres, e), id: attrIn(tag, "id") ?? "", rid, part: presRels.find((r) => r.id === rid)?.target ?? "" };
    });
  const byPart = new Map(origSlides.map((s) => [s.part, s]));
  const used = new Set<string>();
  const jobs: SlideJob[] = pages.map((page) => {
    const m = ownMeta(page);
    const part = m?.hash === best ? m.parts[0] : undefined;
    if (part && part.blocks[0]?.ids[0] === page.id && byPart.has(part.part) && !used.has(part.part)) {
      used.add(part.part);
      return { page, part: part.part, blocks: part.blocks };
    }
    return { page, part: null, blocks: [] };
  });
  const warnings: string[] = [];
  // a chart inserted here: its own chart part and embedded workbook (io/formats/pptxChartWrite.ts), named apart from the deck's
  const chartCt: string[] = [];
  let chartN = 0;
  const addChart = (m: SlideChart) => {
    let part: string;
    do part = `ppt/charts/omwChart${++chartN}.xml`;
    while (pkg.names.has(part));
    let book: Uint8Array | null = null;
    try {
      book = chartWorkbook(m);
    } catch {
      book = null;
    }
    if (book) {
      const bp = `ppt/embeddings/omwChart${chartN}.xlsx`;
      pkg.changed.set(bp, book);
      pkg.names.add(bp);
      pkg.put(relsName(part), relsXml([`<Relationship Id="rId1" Type="${NS_REL}/package" Target="../embeddings/omwChart${chartN}.xlsx"/>`]));
    }
    pkg.put(part, chartSpaceXml(m, book ? "rId1" : null));
    pkg.names.add(part);
    chartCt.push(`<Override PartName="/${part}" ContentType="${CT_CHART}"/>`);
    return part;
  };
  // a SmartArt graphic inserted or edited here: PowerPoint's SmartArt parts (io/formats/pptxSmartArt.ts)
  let dgmN = 0;
  const addSmart = (d: SmartData): string => {
    do dgmN++;
    while (pkg.names.has(`ppt/diagrams/omwData${dgmN}.xml`));
    const p = `ppt/diagrams/omwData${dgmN}.xml`;
    pkg.put(p, dataModelXml(d));
    pkg.names.add(p);
    chartCt.push(`<Override PartName="/${p}" ContentType="${CT_DGM}Data+xml"/>`);
    return p;
  };
  const env: SlideEnv = { doc, rasterize, addMedia: mediaAdder(pkg), counts: { flattened: 0, inShape: 0, fxPictures: 0, skipped: 0 }, addChart, addSmart };
  const note = { rewritten: [] as number[], shapes: 0, anims: 0, copied: [] as number[], noNotes: 0, warn: [] as string[], pkg };
  const reachBefore = reachable(pkg);
  // the deck's layouts read as slides (only when a slide took one here)
  let looks: Map<string, LayoutLook> | null = null;
  const lookOf = (part: string) => (looks ??= layoutLooks(pkg, orig)).get(part);
  // changed slides
  for (let si = 0; si < jobs.length; si++) {
    const j = jobs[si];
    if (!j.part || j.blocks[0].fp[0] === slideFingerprint(j.page)) continue;
    const was = attrsAt(j.blocks[0].fp);
    // the deck layout the slide has (moved to here, or its placeholders put back where it has them)
    const look = was && j.page.layout ? lookOf(j.page.layout) : undefined;
    const lay = look && was ? { ...look, moved: was[1] !== j.page.layout } : undefined;
    const ok = await surgeSlide(pkg, doc, j, si, W, H, env, orig, note, lay);
    if (!ok) return null;
  }
  // new slides
  const layout = blankLayout(pkg);
  const slideNames = [...pkg.names].filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n));
  let slideN = slideNames.reduce((m, n) => Math.max(m, Number(/(\d+)\.xml$/i.exec(n)![1])), 0);
  let rid = maxRid(presRels);
  let sid = origSlides.reduce((m, s) => Math.max(m, Number(s.id) || 0), 255);
  const newRels: string[] = [];
  const ctAdd: string[] = [];
  const order: string[] = [];
  // notes in a deck that has no notes master (PowerPoint makes one with the first notes): one is added, on a copy of
  // the deck's theme, and listed in presentation.xml below (after the slide list is written)
  const notesMaster = jobs.some((j) => j.page.notes?.trim()) ? (presRels.find((r) => r.type === "notesMaster")?.target ?? addNotesMaster(pkg, ctAdd)) : undefined;
  for (let si = 0; si < jobs.length; si++) {
    const j = jobs[si];
    if (j.part) {
      order.push(byPart.get(j.part)!.xml);
      continue;
    }
    // the layout the slide was made from (the gallery offers the deck's own), else the blank one
    const lay = j.page.layout && /^ppt\/slideLayouts\/[^/]+\.xml$/i.test(j.page.layout) && pkg.names.has(j.page.layout) ? j.page.layout : layout;
    if (!lay) return null;
    const part = `ppt/slides/slide${++slideN}.xml`;
    // made from the deck's own layout: its decorations stay the layout's (not copied onto the slide), its empty
    // placeholders are written as PowerPoint writes them (p:ph only, place and look from the layout)
    const look = lay === j.page.layout ? lookOf(lay) : undefined;
    const split = look ? fromLayout(j.page.nodes, look, doc.assets) : null;
    const phs = split?.phs ?? [];
    const w = slideWriter(env, j.page, si, W, H, { id: 2 + phs.length, relBase: 0, rels: [`<Relationship Id="rId1" Type="${NS_REL}/slideLayout" Target="../slideLayouts/${lay.split("/").pop()}"/>`] });
    await w.emit(split ? split.rest : j.page.nodes);
    w.shapes.unshift(...phs.map((x, i) => phSpXml(2 + i, x.name, x.tag)));
    let sx = slidePartXml(j.page, w, !!split);
    if (split && look && j.page.background === look.page.background) sx = sx.replace(/<p:bg>[\s\S]*?<\/p:bg>/, "");
    pkg.put(part, sx);
    pkg.put(relsName(part), relsXml(w.rels));
    if (j.page.notes?.trim() && setNotes(pkg, part, j.page.notes, ctAdd, notesMaster) === "noMaster") note.noNotes++;
    const r = `rId${++rid}`;
    newRels.push(`<Relationship Id="${r}" Type="${NS_REL}/slide" Target="slides/slide${slideN}.xml"/>`);
    ctAdd.push(`<Override PartName="/${part}" ContentType="${CT_SLIDE}"/>`);
    order.push(`<p:sldId id="${++sid}" r:id="${r}"/>`);
    j.part = part;
  }
  // removed slides: out of the list and the presentation's relationships; their parts go with what only they used
  const keptParts = new Set(jobs.map((j) => j.part));
  const gone = origSlides.filter((s) => !keptParts.has(s.part));
  // hidden, layout and notes of kept slides, when they changed here (maps made before these were kept leave them)
  for (const j of jobs) {
    const was = j.blocks[0] && attrsAt(j.blocks[0].fp);
    if (!j.part || !was || slideAttrs(j.page) === j.blocks[0].fp[4]) continue;
    const p = j.page;
    if (was[0] !== !!p.hidden) pkg.put(j.part, setHidden(pkg.text(j.part)!, !!p.hidden));
    if (p.layout && was[1] !== p.layout) setLayout(pkg, j.part, p.layout);
    if (was[3] !== (p.notes ?? "") && setNotes(pkg, j.part, p.notes ?? "", ctAdd, notesMaster) === "noMaster") note.noNotes++;
  }
  // sections named, renamed or removed here: the section list is written again from the slides
  const sectionsChanged = jobs.some((j) => {
    const was = j.blocks[0] && attrsAt(j.blocks[0].fp);
    return was ? was[2] !== (j.page.section ?? null) : !j.blocks.length && j.page.section !== undefined;
  });
  const listChanged = gone.length || jobs.some((j, i) => origSlides[i]?.part !== j.part) || jobs.length !== origSlides.length;
  if (listChanged || sectionsChanged) {
    if (!sldIdLst) return null;
    let p2 = splice(pres, sldIdLst, openTag(pres, sldIdLst).replace(/\s*\/>$/, ">") + order.join("") + `</${sldIdLst.name}>`);
    if (sectionsChanged) p2 = writeSections(p2, sectionLstXml(pages, order.map((x) => attrIn(x, "id") ?? "")));
    else p2 = fixSections(p2, jobs.map((j) => (j.part ? byPart.get(j.part)?.id : undefined) ?? null), order);
    p2 = fixCustomShows(p2, new Set(gone.map((g) => g.rid)));
    pkg.put("ppt/presentation.xml", p2);
    const rs = pkg.text(relsName("ppt/presentation.xml"))!;
    let rs2 = rs;
    for (const g of gone) {
      const r = presRels.find((x) => x.id === g.rid);
      if (r) rs2 = rs2.replace(r.xml, "");
    }
    if (newRels.length) rs2 = rs2.replace(/<\/(\w+:)?Relationships>\s*$/, (m) => newRels.join("") + m);
    pkg.put(relsName("ppt/presentation.xml"), rs2);
  }
  // a notes master added here: in the presentation's list (after the slide masters) and relationships
  if (notesMaster && !presRels.some((r) => r.type === "notesMaster")) {
    const r = `rId${++rid}`;
    const px = pkg.text("ppt/presentation.xml")!;
    const pre = /<(\w+:)?sldMasterIdLst/.exec(px)?.[1] ?? "";
    const lst = `<${pre}notesMasterIdLst><${pre}notesMasterId r:id="${r}"/></${pre}notesMasterIdLst>`;
    const at = /<\/(\w+:)?sldMasterIdLst>/.exec(px);
    pkg.put("ppt/presentation.xml", at ? px.slice(0, at.index + at[0].length) + lst + px.slice(at.index + at[0].length) : px);
    const rs = pkg.text(relsName("ppt/presentation.xml"))!;
    pkg.put(relsName("ppt/presentation.xml"), rs.replace(/<\/(\w+:)?Relationships>\s*$/, (m) => `<Relationship Id="${r}" Type="${NS_REL}/notesMaster" Target="${relTarget("ppt/presentation.xml", notesMaster)}"/>` + m));
  }
  // parts no longer reachable (a removed slide, its notes; media only a rewritten shape used) leave the package
  const reachAfter = reachable(pkg);
  let ct = ctypes;
  for (const p of reachBefore) {
    if (reachAfter.has(p)) continue;
    pkg.removed.add(p);
    if (pkg.names.has(relsName(p))) pkg.removed.add(relsName(p));
    ct = ct.replace(new RegExp(`<(?:\\w+:)?Override\\b[^>]*PartName\\s*=\\s*"/${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`, "i"), "");
  }
  // a theme applied here (core/slideTheme.ts): its colours and fonts into the deck's own theme parts (the format, effect
  // and background styles stay the deck's), the theme master's shapes (its decoration, what was drawn on it in the
  // 슬라이드 마스터 view) at the end of each slide master's shape tree — the deck's masters and layouts stay as they were
  const usedMaster = doc.masters.find((m) => m.nodes.length > 0 && pages.some((p) => p.masterId === m.id));
  if (doc.theme || usedMaster) {
    const masters = relsOf(pkg, "ppt/presentation.xml").filter((r) => r.type === "slideMaster").map((r) => r.target);
    const newTheme = doc.theme ? themeXml(doc.theme) : null;
    for (const mp of masters) {
      const th = relsOf(pkg, mp).find((r) => r.type === "theme")?.target;
      const tx = th ? pkg.text(th) : null;
      if (newTheme && th && tx) {
        let out = tx;
        for (const el of ["clrScheme", "fontScheme"]) {
          const re = new RegExp(`<(\\w+:)?${el}\\b[\\s\\S]*?</\\1?${el}>`);
          const mine = re.exec(newTheme)?.[0];
          const m0 = re.exec(out);
          if (mine && m0) out = out.slice(0, m0.index) + (m0[1] && m0[1] !== "a:" ? mine.replace(/<(\/?)a:/g, `<$1${m0[1]}`) : mine) + out.slice(m0.index + m0[0].length);
        }
        out = out.replace(/(<(?:\w+:)?theme\b[^>]*?\sname=")[^"]*(")/, `$1${doc.theme!.name.replace(/[<>&"]/g, "")}$2`);
        if (out !== tx) pkg.put(th, out);
      }
      if (!usedMaster) continue;
      const ms = pkg.text(mp);
      if (!ms) continue;
      const tree = /<(\w+:)?spTree\b[\s\S]*<\/\1?spTree>/.exec(ms);
      if (!tree) continue;
      const mrels = relsOf(pkg, mp);
      const w = slideWriter(env, usedMaster, -1, W, H, { id: Math.max(1, ...shapeIds(ms).map(Number)) + 1, relBase: maxRid(mrels) });
      await w.emit(usedMaster.nodes);
      // (under the master's own shapes: the decoration is the bottom-most, as on the slides here)
      const head = /^<(?:\w+:)?spTree\b[^>]*>[\s\S]*?<\/(?:\w+:)?grpSpPr>/.exec(tree[0]);
      const at = tree.index + (head ? head[0].length : tree[0].indexOf(">") + 1);
      pkg.put(mp, ms.slice(0, at) + w.shapes.join("") + ms.slice(at));
      if (w.rels.length) {
        const rs = pkg.text(relsName(mp)) ?? relsXml([]);
        pkg.put(relsName(mp), rs.replace(/<\/(\w+:)?Relationships>\s*$/, (m) => w.rels.join("") + m));
      }
    }
  }
  // content types of new parts (slides; media extensions)
  for (const n of pkg.changed.keys()) {
    const ext = /\.([a-z0-9]+)$/i.exec(n)?.[1]?.toLowerCase();
    if (ext && !/^(xml|rels)$/.test(ext) && !new RegExp(`Extension\\s*=\\s*"${ext}"`, "i").test(ct)) {
      const mime = MIME[ext];
      if (mime) ctAdd.push(`<Default Extension="${ext}" ContentType="${mime}"/>`);
    }
  }
  ctAdd.push(...chartCt);
  if (ctAdd.length) ct = ct.replace(/<\/(\w+:)?Types>\s*$/, (m) => ctAdd.join("") + m);
  if (ct !== ctypes) pkg.put("[Content_Types].xml", ct);
  const { flattened, inShape, fxPictures } = env.counts;
  if (note.rewritten.length) warnings.push(tn("engine.officeSurgeon.pptxSlideRewritten", note.rewritten.length, { list: note.rewritten.join(", ") }));
  if (note.copied.length) warnings.push(tn("engine.officeSurgeon.pptxLayoutCopied", note.copied.length, { list: note.copied.join(", ") }));
  if (note.shapes) warnings.push(tn("engine.officeSurgeon.pptxShapeRewritten", note.shapes));
  if (note.anims) warnings.push(tn("engine.officeSurgeon.pptxAnimRemoved", note.anims));
  if (note.noNotes) warnings.push(tn("slide.save.notesNoMaster", note.noNotes));
  for (const w of new Set(note.warn)) warnings.push(w);
  if (flattened) warnings.push(tn("layers.export.pptxFlattened", flattened));
  if (fxPictures) warnings.push(t("fx.export.pptxPictures", { n: fxPictures }));
  if (inShape) warnings.push(tn("layers.export.pptxInShape", inShape));
  return { bytes: rewriteZip(pkg.z, pkg.changed, pkg.removed), warnings };
}

const MIME: Record<string, string> = { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", svg: "image/svg+xml", mp4: "video/mp4", avi: "video/x-msvideo", mov: "video/quicktime", wmv: "video/x-ms-wmv", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", wma: "audio/x-ms-wma", ogg: "audio/ogg", flac: "audio/flac" };

/** Media parts for written shapes: an original part with the same bytes is used again, else a new ppt/media/omwN part. */
function mediaAdder(pkg: Pkg) {
  const byKey = new Map<string, string>();
  let n = 0;
  return (bytes: Uint8Array, ext: string, key: string) => {
    let p = byKey.get(key);
    if (p) return p;
    const same = pkg.z.entries.find((e) => e.name.startsWith("ppt/media/") && e.usize === bytes.length && e.name.toLowerCase().endsWith("." + ext) && entryData(pkg.z, e).every((b, i) => b === bytes[i]));
    if (same) p = same.name;
    else {
      do p = `ppt/media/omw${++n}.${ext}`;
      while (pkg.names.has(p));
      pkg.changed.set(p, bytes);
      pkg.names.add(p);
    }
    byKey.set(key, p);
    return p;
  };
}

/** A layout for a new slide: the first master's blank layout, else its first one. */
function blankLayout(pkg: Pkg): string | null {
  const presRels = relsOf(pkg, "ppt/presentation.xml");
  const master = presRels.find((r) => r.type === "slideMaster")?.target;
  const layouts = master ? relsOf(pkg, master).filter((r) => r.type === "slideLayout").map((r) => r.target) : [];
  for (const l of layouts) {
    const s = pkg.text(l);
    if (s && attrIn(openTag(s, rootOf(s)), "type") === "blank") return l;
  }
  return layouts[0] ?? null;
}

// ───────── the deck's own layouts ─────────

/** A slideLayout of the original read as a slide (formats/pptx pptxLayoutSlides) and the p:ph elements of its placeholders. */
interface LayoutLook {
  page: Page;
  assets: Record<string, AssetRef>;
  /** p:ph of the layout's title / text placeholders: role as Omniweave reads it (core/types Placeholder), idx, the element */
  tags: { type: string; idx: string; tag: string }[];
  /** the slide was moved to this layout here (not only its placeholders put back) */
  moved?: boolean;
}

/** The original's layouts by part. */
function layoutLooks(pkg: Pkg, orig: Uint8Array): Map<string, LayoutLook> {
  const out = new Map<string, LayoutLook>();
  let r: ReturnType<typeof pptxLayoutSlides>;
  try {
    r = pptxLayoutSlides(orig);
  } catch {
    return out;
  }
  for (const l of r.layouts) {
    const s = pkg.text(l.part) ?? "";
    const tags: LayoutLook["tags"] = [];
    for (const m of s.matchAll(/<(?:\w+:)?ph\b([^>]*?)\/?>/g)) {
      const a = m[1];
      const ty = attrIn(`<x${a}>`, "type") ?? "obj";
      const type = ty === "title" || ty === "ctrTitle" || ty === "subTitle" ? ty : ty === "body" || ty === "obj" ? "body" : null;
      if (type) tags.push({ type, idx: attrIn(`<x${a}>`, "idx") ?? "", tag: `<p:ph${a.replace(/\s*\/$/, "")}/>` });
    }
    out.set(l.part, { page: l.page, assets: r.assets, tags });
  }
  return out;
}

/** The layout's p:ph for a placeholder of this role and idx, or undefined. */
const phTagOf = (look: LayoutLook, ph: { type: string; idx?: string }) => look.tags.find((x) => x.type === ph.type && x.idx === (ph.idx ?? ""))?.tag;

/** An empty placeholder as PowerPoint writes one on a slide: p:ph only, its place, size and look from the layout. */
const phSpXml = (id: number, name: string, tag: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${escText(name).replace(/"/g, "&quot;")}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${tag}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>`;

/** The layout's p:ph of an empty placeholder still where the layout places it (written as phSpXml), or undefined. */
function pristinePh(n: SceneNode, look: LayoutLook): string | undefined {
  if (!isEmptyPh(n) || !layoutPhOf(n, look.page)) return undefined;
  return phTagOf(look, n.ph);
}

/**
 * Nodes of a slide made from (or moved to) a deck layout: the layout's decorations (copies the slide shows; the layout
 * draws them) left out, empty placeholders where the layout has them as p:ph only, the rest to write. Null when one of
 * the layout's decorations is no longer on the slide (it is then written with its own copies, the layout's hidden).
 */
function fromLayout(nodes: readonly SceneNode[], look: LayoutLook, docAssets: Record<string, AssetRef>): { rest: SceneNode[]; phs: { name: string; tag: string }[]; decor: Set<string> } | null {
  const assets = { ...look.assets, ...docAssets };
  const want = layoutDecor(look.page).map((n) => contentKey(n, assets));
  const left = new Map<string, number>();
  for (const k of want) left.set(k, (left.get(k) ?? 0) + 1);
  const rest: SceneNode[] = [], phs: { name: string; tag: string }[] = [], decor = new Set<string>();
  for (const n of nodes) {
    const k = contentKey(n, assets);
    if (left.get(k)) {
      left.set(k, left.get(k)! - 1);
      decor.add(n.id);
      continue;
    }
    const tag = pristinePh(n, look);
    if (tag) phs.push({ name: n.name, tag });
    else rest.push(n);
  }
  return [...left.values()].some((v) => v > 0) ? null : { rest, phs, decor };
}

/** Paragraphs as text and look, without sizes (autofit scales them; the file keeps its own fontScale). */
const textOnly = (n: TextNode) => JSON.stringify([n.paragraphs, n.lists ?? null], (k, x) => (k === "id" || k === "fontSize" || k === "spaceBefore" ? undefined : x));

/**
 * A placeholder that moved into the new layout's (core/slides applyLayoutInPlace) written as PowerPoint's change
 * layout leaves it: the same shape pointed at the layout's p:ph and placed by it, its text kept (edited text patched).
 * Null when it changed in another way too (or the new layout does not place it where it is).
 */
function toLayoutPh(t: string, o: SceneNode, c: SceneNode, lay: LayoutLook, assets: { o: Record<string, AssetRef>; c: Record<string, AssetRef> }): { xml: string; paras?: number } | null {
  if (o.type !== "TEXT" || c.type !== "TEXT" || !o.ph || !c.ph || c.transform.rotation || !layoutPhOf(c, lay.page)) return null;
  const tag = phTagOf(lay, c.ph);
  if (!tag) return null;
  const rest = (n: TextNode, a: Record<string, AssetRef>) => normJson({ ...n, transform: undefined, paragraphs: undefined, lists: undefined, ph: undefined, width: undefined, name: undefined }, a);
  if (rest(o, assets.o) !== rest(c, assets.c)) return null;
  let xml = t;
  let paras: number | undefined;
  // sizes before autofit (fontSize / fit): a size set by hand is a text change too (QA: it was dropped). The text is
  // patched at the file's own fontScale (o's fit), so `c` is brought to it first.
  const k = (o.ph.fit ?? 1) / (c.ph.fit ?? 1);
  const atO: TextNode = k === 1 ? c : { ...c, paragraphs: c.paragraphs.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, fontSize: r.fontSize * k })), ...(p.spaceBefore ? { spaceBefore: p.spaceBefore * k } : {}) })) };
  const sizes = (n: TextNode) => JSON.stringify(n.paragraphs.map((p) => p.runs.map((r) => Math.round(r.fontSize * 100))));
  if ((textOnly(o) !== textOnly(c) || sizes(o) !== sizes(atO)) && !(isEmptyPh(o) && isEmptyPh(c))) {
    const r = patchText(t, o, atO);
    if (!r) return null;
    xml = r.xml;
    paras = r.paras;
  }
  const out = rePlaceholder(xml, tag);
  return out ? { xml: out, paras } : null;
}

// ───────── charts edited here ─────────

/** A shape as drawn, to tell a chart's drawing from shapes changed one by one (ids, names, the chart link left out; 0.01 px). */
const drawnKey = (n: SceneNode) => JSON.stringify(n, (k, x) => (k === "id" || k === "name" || k === "chart" ? undefined : typeof x === "number" ? Math.round(x * 100) / 100 : x));
const chartData = (m: SlideChart) => JSON.stringify({ ...m, frame: undefined });

/**
 * The graphic frame of a chart whose shapes are still its drawing (io/formats/pptxChart drawChart): moved to where the
 * chart is, its data (when edited here) written into the chart part and embedded workbook. Null when its shapes were
 * changed one by one, or the chart part cannot take the data (the shapes are then written as shapes).
 */
function chartElement(t: string, cur: SceneNode[], was: SlideChart | undefined, note: Note): string | null {
  const m = cur[0].chart!.data!;
  const frame = chartFrameNow(cur, 0);
  if (!frame) return null;
  const drawn = drawChart({ ...m, frame });
  if (drawn.length !== cur.length || drawn.some((d, i) => drawnKey(d) !== drawnKey(cur[i]))) return null;
  if (!was || chartData(was) !== chartData(m)) {
    const w = writeChart(note.pkg, m, was);
    if (!w) return null;
    note.warn.push(...w);
  }
  const off = /<(?:\w+:)?xfrm\b[^>]*>\s*<(?:\w+:)?off\s+x="(-?\d+)"\s+y="(-?\d+)"/.exec(t);
  if (!off) return t;
  const dx = Math.round(frame.x * EMU) - Number(off[1]), dy = Math.round(frame.y * EMU) - Number(off[2]);
  return Math.abs(dx) > EMU / 100 || Math.abs(dy) > EMU / 100 ? moveElement(t, dx, dy, "") : t;
}

/** The chart's data into its chart part and the workbook embedded for it; warnings, or null when the part cannot take it. */
function writeChart(pkg: Pkg, m: SlideChart, was: SlideChart | undefined): string[] | null {
  const xml = m.part ? pkg.text(m.part) : null;
  if (!xml || !m.part) return null;
  const r = chartPartWithData(xml, m);
  if (!r) return null;
  pkg.put(m.part, r.xml);
  const rid = /<(?:\w+:)?externalData\b[^>]*?\s\w+:id="([^"]*)"/.exec(xml)?.[1];
  const rel = rid ? relsOf(pkg, m.part).find((x) => x.id === rid) : undefined;
  const noBook = [t("slideLayout.chart.save.noWorkbook")];
  if (!r.sheet || !rel || rel.external || !/\.xlsx$/i.test(rel.target) || !pkg.names.has(rel.target)) return noBook;
  const entry = pkg.z.entries.find((e) => e.name === rel.target);
  const bytes = pkg.changed.get(rel.target) ?? (entry ? entryData(pkg.z, entry) : null);
  const wb = bytes && workbookWithData(bytes, m, was, r.sheet);
  if (!wb) return noBook;
  pkg.changed.set(rel.target, wb.bytes);
  return wb.warnings;
}

/** A placeholder shape pointed at another p:ph (the layout's) and placed by the layout (its own a:xfrm removed). */
function rePlaceholder(t: string, tag: string): string | null {
  const el = rootOf(t);
  if (el.local !== "sp") return null;
  const nv = childNamed(t, el, "nvSpPr");
  const nvPr = nv && childNamed(t, nv, "nvPr");
  const ph = nvPr && childNamed(t, nvPr, "ph");
  if (!ph) return null;
  const pr = childNamed(t, el, "spPr");
  const xf = pr && childNamed(t, pr, "xfrm");
  // from the later one, so the earlier offsets stay valid
  let out = xf ? splice(t, xf, "") : t;
  out = splice(out, ph, tag.replace(/^<p:/, `<${ph.name.includes(":") ? ph.name.slice(0, ph.name.indexOf(":") + 1) : ""}`));
  return out;
}

/**
 * Sections (p14:sectionLst) after slides were removed, added or moved: each kept slide stays in its section, a new
 * slide joins the section of the slide before it; a section's slides follow the new order (a section split by a
 * move keeps its slides where the first of them is).
 */
function fixSections(pres: string, ids: (string | null)[], order: string[]): string {
  if (!/sectionLst\b/.test(pres)) return pres;
  const root = rootOf(pres);
  const lst = descendantsNamed(pres, root, "sectionLst")[0];
  if (!lst) return pres;
  const sections = childrenOf(pres, lst).filter((e) => e.local === "section");
  const of = new Map<string, number>();
  sections.forEach((sec, k) => {
    const l = childNamed(pres, sec, "sldIdLst");
    for (const s of l ? childrenOf(pres, l) : []) of.set(attrIn(openTag(pres, s), "id") ?? "", k);
  });
  const finalIds = order.map((x) => attrIn(x, "id") ?? "");
  const lists: string[][] = sections.map(() => []);
  let cur = 0;
  finalIds.forEach((id, i) => {
    const k = ids[i] !== null && of.has(id) ? of.get(id)! : cur;
    // sections stay contiguous: a slide whose section is already behind joins the current one
    cur = k >= cur ? k : cur;
    lists[cur].push(id);
  });
  let out = pres;
  for (let k = sections.length - 1; k >= 0; k--) {
    const sec = sections[k];
    const l = childNamed(pres, sec, "sldIdLst");
    if (!l) continue;
    const prefix = l.name.includes(":") ? l.name.slice(0, l.name.indexOf(":") + 1) : "";
    const body = lists[k].map((id) => `<${prefix}sldId id="${id}"/>`).join("");
    out = splice(out, l, `${openTag(pres, l).replace(/\s*\/>$/, ">")}${body}</${l.name}>`);
  }
  return out;
}

/** Relative relationship Target from part `from` to part `to`. */
function relTarget(from: string, to: string): string {
  const a = from.split("/").slice(0, -1), b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

/** A slide part with show="0" set (hidden) or taken away. */
function setHidden(s: string, hidden: boolean): string {
  const root = rootOf(s);
  const tag = openTag(s, root);
  const next = hidden ? setAttr(tag, "show", "0") : tag.replace(/\sshow\s*=\s*(?:"[^"]*"|'[^']*')/, "");
  return next === tag ? s : s.slice(0, root.start) + next + s.slice(root.openEnd);
}

/** The slide pointed at another layout of the package (its relationship's Target). */
function setLayout(pkg: Pkg, part: string, layout: string): void {
  const rs = pkg.text(relsName(part));
  const r = relsOf(pkg, part).find((x) => x.type === "slideLayout");
  if (!rs || !r || r.target === layout || !pkg.names.has(layout)) return;
  pkg.put(relsName(part), rs.replace(r.xml, setAttr(r.xml, "Target", relTarget(part, layout))));
}

/**
 * Speaker notes of a slide: the body text of its notes page replaced (its other shapes, formats and placeholders
 * kept), or a notes page made on the deck's notes master. "noMaster" when the deck has none to make one on.
 */
function setNotes(pkg: Pkg, part: string, text: string, ctAdd: string[], notesMaster?: string): "ok" | "noMaster" {
  const rel = relsOf(pkg, part).find((r) => r.type === "notesSlide");
  if (rel && pkg.names.has(rel.target)) {
    const s = pkg.text(rel.target);
    if (!s) return "ok";
    const sp = descendantsNamed(s, rootOf(s), "sp").find((e) => /<(\w+:)?ph\b[^>]*\btype\s*=\s*"body"/.test(elText(s, e)));
    const tb = sp && childNamed(s, sp, "txBody");
    if (!tb || tb.openEnd === tb.end) return "ok";
    const keep = childrenOf(s, tb).filter((c) => c.local !== "p").map((c) => elText(s, c)).join("");
    pkg.put(rel.target, splice(s, tb, openTag(s, tb) + keep + notesParasXml(text) + `</${tb.name}>`));
    return "ok";
  }
  if (!text.trim()) return "ok";
  const master = notesMaster ?? relsOf(pkg, "ppt/presentation.xml").find((r) => r.type === "notesMaster")?.target;
  if (!master || !pkg.names.has(master)) return "noMaster";
  let n = 0;
  let np: string;
  do np = `ppt/notesSlides/notesSlide${++n}.xml`;
  while (pkg.names.has(np));
  pkg.put(np, notesSlideXml(text));
  pkg.put(relsName(np), relsXml([`<Relationship Id="rId1" Type="${NS_REL}/notesMaster" Target="${relTarget(np, master)}"/>`, `<Relationship Id="rId2" Type="${NS_REL}/slide" Target="${relTarget(np, part)}"/>`]));
  const rs = pkg.text(relsName(part)) ?? relsXml([]);
  const add = `<Relationship Id="rId${maxRid(relsOf(pkg, part)) + 1}" Type="${NS_REL}/notesSlide" Target="${relTarget(part, np)}"/>`;
  pkg.put(relsName(part), rs.replace(/<\/(\w+:)?Relationships>\s*$/, (m) => add + m).replace(/<Relationships([^>]*)\/>\s*$/, `<Relationships$1>${add}</Relationships>`));
  ctAdd.push(`<Override PartName="/${np}" ContentType="${CT_NOTES}"/>`);
  return "ok";
}

/**
 * A notes master for a deck without one (its notes pages are made on it): the notes master a new deck gets, with a
 * copy of the first slide master's theme. Its part name; presentation.xml lists it after the slides are written.
 */
function addNotesMaster(pkg: Pkg, ctAdd: string[]): string | undefined {
  const sm = relsOf(pkg, "ppt/presentation.xml").find((r) => r.type === "slideMaster")?.target;
  const theme = sm ? relsOf(pkg, sm).find((r) => r.type === "theme")?.target : undefined;
  const themeXml = theme && pkg.text(theme);
  if (!themeXml) return undefined;
  const free = (f: (n: number) => string) => {
    let n = 0;
    while (pkg.names.has(f(++n)));
    return f(n);
  };
  const tp = free((n) => `ppt/theme/theme${n}.xml`);
  const mp = free((n) => `ppt/notesMasters/notesMaster${n}.xml`);
  pkg.put(tp, themeXml);
  pkg.put(mp, NOTES_MASTER_XML);
  pkg.put(relsName(mp), relsXml([`<Relationship Id="rId1" Type="${NS_REL}/theme" Target="${relTarget(mp, tp)}"/>`]));
  ctAdd.push(`<Override PartName="/${tp}" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`, `<Override PartName="/${mp}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>`);
  return mp;
}

/** presentation.xml with its section list replaced by `lst` (added in an extLst entry when it had none; "" removes it). */
function writeSections(pres: string, lst: string): string {
  const root = rootOf(pres);
  const old = descendantsNamed(pres, root, "sectionLst")[0];
  if (old) {
    if (lst) return splice(pres, old, lst);
    // the whole p:ext that held it goes
    const ext = descendantsNamed(pres, root, "ext").find((e) => e.start <= old.start && e.end >= old.end);
    return splice(pres, ext ?? old, "");
  }
  if (!lst) return pres;
  const ext = sectionExtXml(lst);
  const extLst = childNamed(pres, root, "extLst");
  if (extLst) return pres.slice(0, extLst.openEnd) + ext + pres.slice(extLst.openEnd);
  return pres.slice(0, root.closeStart) + `<p:extLst>${ext}</p:extLst>` + pres.slice(root.closeStart);
}

/** Custom shows without the removed slides. */
function fixCustomShows(pres: string, goneRids: Set<string>): string {
  if (!goneRids.size || !/custShowLst\b/.test(pres)) return pres;
  return pres.replace(/<(\w+:)?sld\b[^>]*?\s\w+:id\s*=\s*"([^"]*)"[^>]*\/>/g, (m, _p, r) => (goneRids.has(r) ? "" : m));
}

/**
 * Surgery on one changed slide part (updates pkg). False when the slide cannot be matched with its original read
 * (the whole deck is then written anew).
 */
async function surgeSlide(pkg: Pkg, doc: OmwDocument, job: SlideJob, si: number, W: number, H: number, env: SlideEnv, orig: Uint8Array, note: Note, lay?: LayoutLook): Promise<boolean> {
  const part = job.part!;
  const s = pkg.text(part);
  if (!s) return false;
  const page = job.page;
  const root = rootOf(s);
  const rootTag = openTag(s, root);
  if (!/xmlns:a\s*=/.test(rootTag) || !/xmlns:r\s*=/.test(rootTag) || !/xmlns:p\s*=/.test(rootTag) || root.name !== "p:sld") return false;
  const cSld = childNamed(s, root, "cSld");
  const tree = cSld && childNamed(s, cSld, "spTree");
  if (!cSld || !tree) return false;
  const kids = childrenOf(s, tree);
  const at = new Map(page.nodes.map((n, i) => [n.id, i]));
  const inhB = job.blocks[1];
  const els = job.blocks.slice(2).map((b) => ({ ids: b.ids, fp: b.fp[0], k: Number(b.fp[1]), box: b.fp[2] ?? "" }));
  const owned = new Set([...inhB.ids, ...els.flatMap((e) => e.ids)]);
  let fresh = page.nodes.filter((n) => !owned.has(n.id));
  const inhNow = inhB.ids.map((id) => page.nodes[at.get(id) ?? -1]).filter(Boolean);
  let inhChanged = inhNow.length !== inhB.ids.length || nodesFp(inhNow, doc.assets) !== inhB.fp[0];
  // moved to another of the deck's layouts here (core/slides swapDeckLayout): the old layout's decorations left, the
  // new one's copies are what that layout draws — not the slide's own shapes
  const layIds = new Set<string>();
  if (lay && !inhNow.length) {
    const split = fromLayout(fresh, lay, doc.assets);
    if (split) {
      for (const id of split.decor) layIds.add(id);
      fresh = fresh.filter((n) => !layIds.has(n.id));
      inhChanged = false;
    }
  }
  const state = els.map((e) => {
    const cur = e.ids.map((id) => page.nodes[at.get(id) ?? -1]).filter(Boolean);
    // a chart drawn again here (io/formats/pptxChart replaceChart) may have more or fewer shapes: all of its run
    const head = cur[0]?.chart?.data ? at.get(cur[0].id)! : -1;
    if (head >= 0) {
      const [a, b] = chartRun(page.nodes, head);
      if (b - a !== cur.length || page.nodes.slice(a, b).some((n, k) => n !== cur[k])) {
        const run = page.nodes.slice(a, b);
        const ids = new Set(run.map((n) => n.id));
        fresh = fresh.filter((n) => !ids.has(n.id));
        return { cur: run, st: "changed" };
      }
    }
    return { cur, st: !cur.length ? "gone" : cur.length === e.ids.length && nodesFp(cur, doc.assets) === e.fp ? "same" : "changed" };
  });
  const relsPart = relsName(part);
  const rels = relsOf(pkg, part);
  let maxId = Math.max(1, ...shapeIds(s).map(Number));
  const relBase = { n: maxRid(rels) };
  const addedRels: string[] = [];
  /** node id → its shape id in the written slide (the page's animations point at them) */
  const spids = new Map<string, number>();
  const write = async (nodes: SceneNode[]) => {
    const w = slideWriter(env, page, si, W, H, { id: maxId + 1, relBase: relBase.n });
    await w.emit(nodes);
    for (const [k, v] of w.spids) spids.set(k, v);
    maxId = w.next() - 1;
    relBase.n += w.rels.length;
    addedRels.push(...w.rels);
    return w.shapes;
  };
  // new nodes: an empty placeholder where the new layout has it as p:ph only (PowerPoint's own), the rest written
  const writeFresh = async (nodes: SceneNode[]) => {
    const out: string[] = [];
    let run: SceneNode[] = [];
    for (const n of nodes) {
      const tag = lay && pristinePh(n, lay);
      if (!tag) {
        run.push(n);
        continue;
      }
      if (run.length) out.push(...(await write(run)));
      run = [];
      out.push(phSpXml(++maxId, n.name, tag));
    }
    if (run.length) out.push(...(await write(run)));
    return out;
  };
  const head = kids.filter((c, i) => i < 2 && (c.local === "nvGrpSpPr" || c.local === "grpSpPr"));
  const tail = kids.filter((c) => c.local === "extLst");
  const treeOf = (body: string[]) => s.slice(tree.start, tree.openEnd) + head.map((c) => elText(s, c)).join("") + body.join("") + tail.map((c) => elText(s, c)).join("") + `</${tree.name}>`;
  const gone = new Set<string>(), noText = new Set<string>(), paraLim = new Map<string, number>();
  let treeXml: string;
  // (a SmartArt group is one element of the slide, kept or written as one: core/smartArt.ts)
  if (page.width !== W || page.height !== H || page.groups?.some((g) => !g.smart)) {
    // a page of another size or with layer groups: the slide's shapes written anew (their animations go), the rest of
    // the slide (background, transition, notes, layout) as it was
    treeXml = treeOf(await write(inhChanged ? page.nodes : page.nodes.filter((n) => !inhB.ids.includes(n.id) && !layIds.has(n.id))));
    for (const k of shapeIds(elText(s, tree))) gone.add(k);
    note.rewritten.push(si + 1);
    if (inhChanged) note.copied.push(si + 1);
  } else {
    const body = await surgeTree(s, kids, els, state, inhChanged ? inhNow : [], fresh, page, doc, part, orig, write, gone, noText, paraLim, note, writeFresh, inhChanged ? undefined : lay);
    if (!body) return false;
    if (inhChanged) note.copied.push(si + 1);
    treeXml = treeOf(body);
    // elements kept or written again keep their shape id
    els.forEach((e, i) => {
      const m = state[i].st !== "gone" && kids[e.k] ? /<(?:\w+:)?cNvPr\b[^>]*?\sid="(\d+)"/.exec(elText(s, kids[e.k])) : null;
      if (m) for (const id of e.ids) spids.set(id, Number(m[1]));
    });
  }
  let out = splice(s, tree, treeXml);
  // 머리글/바닥글 set here (core/slideHf.ts): the slide's own dt / ftr / sldNum placeholders written anew at its end
  if (page.slideHf) {
    const tr0 = childNamed(out, childNamed(out, rootOf(out), "cSld")!, "spTree")!;
    const old = childrenOf(out, tr0).filter((c) => c.local === "sp" && /<(?:\w+:)?ph\b[^>]*\btype="(?:dt|ftr|sldNum)"/.test(elText(out, c)));
    for (const c of [...old].reverse()) out = out.slice(0, c.start) + out.slice(c.end);
    const tr1 = childNamed(out, childNamed(out, rootOf(out), "cSld")!, "spTree")!;
    const add = slideHfXml(doc, page, W, H, maxId + 1);
    maxId += add.length;
    out = out.slice(0, tr1.closeStart) + add.join("") + out.slice(tr1.closeStart);
  }
  // background and transition, when they changed
  const look = JSON.parse(job.blocks[0].fp[3] ?? "null") as [string, Page["transition"]] | null;
  const r2 = rootOf(out);
  const c2 = childNamed(out, r2, "cSld")!;
  // the new layout's own background (the slide had none of its own): drawn by the layout, not written on the slide
  const layBg = !!lay && !inhChanged && page.background === lay.page.background && !childNamed(out, c2, "bg");
  const bgChanged = !layBg && (!look || look[0] !== page.background || !!page.bgGrad || (inhChanged && inhB.fp[1] === "bg" && !inhNow.length));
  if (bgChanged && look) {
    const bg = childNamed(out, c2, "bg");
    out = bg ? splice(out, bg, solidBgXml(page)) : out.slice(0, c2.openEnd) + solidBgXml(page) + out.slice(c2.openEnd);
  }
  if (look && JSON.stringify(look[1]) !== JSON.stringify(page.transition)) {
    const r3 = rootOf(out);
    const old = childrenOf(out, r3).find((c) => c.local === "transition" || (c.local === "AlternateContent" && /transition\b/.test(elText(out, c))));
    const at2 = old ?? childrenOf(out, r3).find((c) => c.local === "timing" || c.local === "extLst");
    const nx = transitionXml(page);
    out = old ? splice(out, old, nx) : at2 ? out.slice(0, at2.start) + nx + out.slice(at2.start) : out.slice(0, r3.closeStart) + nx + out.slice(r3.closeStart);
  }
  // the layout's shapes hidden when they are now the slide's own
  if (inhChanged) out = splice(out, { start: 0, end: rootOf(out).openEnd }, out.slice(0, rootOf(out).start) + setAttr(openTag(out, rootOf(out)), "showMasterSp", "0"));
  // animations of shapes that are gone
  if (gone.size || noText.size || paraLim.size) {
    const r4 = rootOf(out);
    const tm = childNamed(out, r4, "timing");
    if (tm) {
      const p = pruneTiming(elText(out, tm), gone, noText, paraLim);
      note.anims += p.removed;
      out = splice(out, tm, p.xml);
    }
  }
  // the page's animations (Omniweave's): added to the slide's main sequence (io/formats/pptxAnim.ts)
  if (page.animations?.length || page.pptxTiming) out = putAnimTiming(out, page, spids);
  pkg.put(part, out);
  if (addedRels.length) {
    const rs = pkg.text(relsPart) ?? relsXml([]);
    pkg.put(relsPart, rs.replace(/<\/(\w+:)?Relationships>\s*$/, (m) => addedRels.join("") + m).replace(/<Relationships([^>]*)\/>\s*$/, `<Relationships$1>${addedRels.join("")}</Relationships>`));
  }
  return true;
}

/** The slide part with the page's animations in its p:timing (a p:timing added after the transition when it has none). */
function putAnimTiming(out: string, page: Page, spids: ReadonlyMap<string, number>): string {
  const r = rootOf(out);
  const tm = childNamed(out, r, "timing");
  // (raw: effects read from this slide and unchanged go back as PowerPoint wrote them)
  if (tm) return splice(out, tm, withAnimTiming(elText(out, tm), page, spids, true));
  const x = withAnimTiming("", page, spids, true);
  if (!x) return out;
  const ext = childNamed(out, r, "extLst");
  const at = ext ? ext.start : r.closeStart;
  return out.slice(0, at) + x + out.slice(at);
}

type Note = { rewritten: number[]; shapes: number; anims: number; copied: number[]; warn: string[]; pkg: Pkg };
type ElMap = { ids: string[]; fp: string; k: number; box: string };

/**
 * The new content of a changed slide's p:spTree (after its header): unchanged elements as they were, moved / edited
 * ones patched, others written anew under their shape id, new nodes where they are on the page, elements without
 * nodes (empty placeholders, objects Omniweave does not read) after the element they followed. `inh`: the layout's
 * and master's shapes to copy onto the slide (first). Null when the original cannot be matched.
 */
async function surgeTree(
  s: string,
  kids: XmlEl[],
  els: ElMap[],
  state: { cur: SceneNode[]; st: string }[],
  inh: SceneNode[],
  fresh: SceneNode[],
  page: Page,
  doc: OmwDocument,
  part: string,
  orig: Uint8Array,
  write: (nodes: SceneNode[]) => Promise<string[]>,
  gone: Set<string>,
  noText: Set<string>,
  paraLim: Map<string, number>,
  note: Note,
  writeFresh: (nodes: SceneNode[]) => Promise<string[]> = write,
  lay?: LayoutLook,
): Promise<string[] | null> {
  // the original read again: only when a shape changed (moves and text edits are written into its XML)
  let origRead: { nodes: SceneNode[]; assets: Record<string, AssetRef> } | null = null;
  if (state.some((x) => x.st === "changed")) {
    try {
      const r = importPptx(orig, page.source?.name ?? "deck.pptx", { only: new Set([part]) });
      const tr = r.slideEls[0];
      if (r.pages[0] && tr && tr.els.length === els.length && tr.els.every((e, i) => e.k === els[i].k && e.n === els[i].ids.length)) origRead = { nodes: r.pages[0].nodes.slice(tr.inh), assets: r.assets };
    } catch {
      origRead = null;
    }
  }
  const texts = new Map<number, string>(); // element (index in els) → its new XML
  let origAt = 0;
  for (let e = 0; e < els.length; e++) {
    const el = els[e], x = state[e];
    const kEl = kids[el.k];
    const from = origAt;
    origAt += el.ids.length;
    if (!kEl) return null;
    if (x.st === "same") {
      // the slide took another layout: a shape the old layout placed and the new one has no place for keeps its place
      if (lay?.moved && el.box && !(x.cur.length === 1 && layoutPhOf(x.cur[0], lay.page))) {
        const p = moveElement(elText(s, kEl), 0, 0, el.box);
        if (p) texts.set(e, p);
      }
      continue;
    }
    const t = elText(s, kEl);
    const spid = shapeIds(t)[0];
    if (x.st === "gone") {
      for (const id of shapeIds(t)) gone.add(id);
      continue;
    }
    // moved and / or its text changed: in the element's own XML
    let patched: string | null = null;
    const o = origRead?.nodes.slice(from, from + el.ids.length);
    // a chart edited here (ui/chartEdit): its data into the chart part and workbook, the frame where the chart is now
    const ch = x.cur[0]?.chart;
    if (ch?.data?.part && kEl.local === "graphicFrame" && x.cur.every((n) => n.chart?.id === ch.id)) {
      const r = chartElement(t, x.cur, o?.[0]?.chart?.data, note);
      if (r) {
        texts.set(e, r);
        continue;
      }
    }
    if (lay && o && o.length === 1 && x.cur.length === 1) {
      // a placeholder moved into the new layout's (same role and idx, where the layout places it): pointed at it
      const r = toLayoutPh(t, o[0], x.cur[0], lay, { o: origRead!.assets, c: doc.assets });
      if (r) {
        texts.set(e, r.xml);
        if (r.paras !== undefined && spid) paraLim.set(spid, r.paras);
        continue;
      }
    }
    if (o && x.cur.length === o.length) {
      const diffs = o.map((on, i) => nodeDiff(on, x.cur[i], { o: origRead!.assets, c: doc.assets }));
      const dx = diffs[0].dx, dy = diffs[0].dy;
      if (diffs.every((d) => !d.other && Math.abs(d.dx - dx) < 0.01 && Math.abs(d.dy - dy) < 0.01) && diffs.filter((d) => d.text).length <= 1) {
        patched = t;
        const ti = diffs.findIndex((d) => d.text);
        if (ti >= 0) {
          const r = patchText(t, o[ti] as TextNode, x.cur[ti] as TextNode);
          patched = r?.xml ?? null;
          if (r && spid) paraLim.set(spid, r.paras);
        }
        if (patched && (Math.abs(dx) >= 0.005 || Math.abs(dy) >= 0.005)) patched = moveElement(patched, Math.round(dx * EMU), Math.round(dy * EMU), el.box);
      }
    }
    if (patched === null) {
      // written anew from its nodes, under its own shape id (its animations still find it); shapes inside a group go
      const shapes = await write(x.cur);
      patched = shapes.join("");
      if (spid) patched = patched.replace(/(<p:cNvPr id=")\d+(")/, `$1${spid}$2`);
      for (const id of shapeIds(t)) if (id !== spid) gone.add(id);
      if (spid && !/<p:txBody>/.test(shapes[0] ?? "")) noText.add(spid);
      paraLim.delete(spid ?? "");
      note.shapes++;
    }
    texts.set(e, patched);
  }
  const elOfK = new Map(els.map((e, i) => [e.k, i]));
  const followers = new Map<number | "head", XmlEl[]>([["head", []]]);
  let anchor: number | "head" = "head";
  kids.forEach((c, k) => {
    if ((k < 2 && (c.local === "nvGrpSpPr" || c.local === "grpSpPr")) || c.local === "extLst") return;
    const e = elOfK.get(k);
    if (e === undefined) followers.get(anchor)!.push(c);
    else if (state[e].st !== "gone") {
      anchor = e;
      followers.set(e, []);
    }
  });
  // elements in the order of their nodes on the page; new nodes where they are
  const nodeEl = new Map<string, number>();
  els.forEach((e, i) => e.ids.forEach((id) => nodeEl.set(id, i)));
  const freshIds = new Set(fresh.map((n) => n.id));
  const seq: ({ e: number } | { nodes: SceneNode[] })[] = [];
  const placed = new Set<number>();
  for (const n of page.nodes) {
    const e = nodeEl.get(n.id);
    if (e !== undefined) {
      if (!placed.has(e)) placed.add(e), seq.push({ e });
    } else if (freshIds.has(n.id)) {
      const last = seq[seq.length - 1];
      if (last && "nodes" in last) last.nodes.push(n);
      else seq.push({ nodes: [n] });
    }
  }
  const body: string[] = [];
  // the layout's and master's shapes were edited here: copied onto the slide (the layout's own are hidden for it)
  if (inh.length) body.push(...(await write(inh)));
  for (const c of followers.get("head")!) body.push(elText(s, c));
  for (const it of seq) {
    if ("e" in it) {
      body.push(texts.get(it.e) ?? elText(s, kids[els[it.e].k]));
      for (const c of followers.get(it.e) ?? []) body.push(elText(s, c));
    } else body.push(...(await writeFresh(it.nodes)));
  }
  return body;
}
