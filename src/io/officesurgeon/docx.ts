// Office Surgeon — DOCX: rewrite only the changed paragraphs / tables of word/document.xml.
//
// Design: docs/design/OFFICE_SURGEON.md §4. The edit unit is a top-level child of w:body. An element whose
// items (paragraphs / table) are all still there, in order and with the fingerprint they had at import, is
// copied as its original text. A changed paragraph keeps its original w:pPr (when the paragraph format is
// unchanged), the original w:rPr of each run that kept its character format, and its non-text content:
// hyperlinks, fields, equations and inline content controls whose text is unchanged are written back as the
// original elements at the same place; pictures and note references stay after the text they followed;
// bookmark / comment range marks stay. A changed table rewrites only its changed cells when the grid is the
// same. Every other package entry is copied byte for byte (zip.ts). Nothing changed → the original bytes.

import { strFromU8 } from "fflate";
import { getBlob } from "../../core/assets";
import { hashString } from "../../core/hash";
import type { NoteRef, OfficeSourceBlock, OfficeSourceMeta, Page, TableCell, TableNode, TextParagraph, TextRun } from "../../core/types";
import { t } from "../../i18n";
import { sameColumns, type PageSetup } from "../../core/pageSetup";
import { layoutDiff, legacyLayout } from "./layout";
import { HF_MAP_VERSION, applyDocxHF, hfAddedToOldMap, hfChanged, type HFCompare } from "./hf";
import {
  DOCX_PAGE_BREAK,
  DOCX_COL_BREAK,
  DOCX_NOTE_TYPES,
  docxNoteRunXml,
  docxNoteId,
  docxNoteXml,
  docxNotesPartXml,
  docxRuns,
  docxRubyXml,
  flowNotes,
  useDocxNoteIds,
  docxColsXml,
  docxPageXml,
  parseDocxFlow,
  type OfficeImportReport,
  type OfficeItem,
  type OfficeLayout,
  collectFlow,
  flowLayout,
  docxBodyRuns,
  docxCellParas,
  docxContext,
  docxNumPr,
  docxNumFmt,
  docxParagraph,
  docxAbstractNum,
  docxPPr,
  docxPPrHead,
  docxRPr,
  pageListDefs,
  docxTable,
  docxTableXml,
  docxText,
  patchDocxStyles,
  docxStyleSheet,
  docxBookmarkMarks,
  type DocxCtx,
  type FlowItem,
} from "../office";
import { children, descendants, esc, parseXml } from "../xml";
import { MAX_LEVELS, levelOf, resolveDef } from "../../core/lists";
import type { ListDef } from "../../core/style/types";
import { listDefKey, noteFp } from "./common";
import { restyleParas, type DocStyle } from "../../core/docStyles";
import { cellFp, cellParagraphs, cellParas, legacyParaView, legacyRunView, lookKey, MODEL_AFTER_TABLE, MODEL_HEADING_STYLES, MODEL_OPTIONAL_FIELDS, MODEL_PARA_STYLES, MODEL_REVIEW, MODEL_VERSION, MODEL_WORD_MULTIPLE, MODEL_WORD_STYLES, preWordMultipleView, revLookKey, WORD_ENGINE_VERSION, isListRole, itemFp, markedBodyRuns, itemId, paraFp, paraPropsKey, tablePropsKey, changedListDefs, fileListDefs, flowParas, itemRelisted, normalRuns, origParas, paraReviewKey, relistPlan, type ListSegment, type RelistPlan } from "./common";
import { commentNeighbours, COMMENTS_CT, COMMENTS_EX_CT, COMMENTS_EX_REL, COMMENTS_REL, docxAnnotationStyles, docxCommentMarks, docxCommentXml, docxComments, docxPPrReview, docxRevXml, docxWithRPrChange, docxSettingsTracking, docxTracking, newParaId, paraIdsIn, tidyDocxCommentMarks, tidyDocxMoveRanges, W15_NS, W14_NS, withW14, type DocxCommentIds } from "../officeReview";
import { docComments } from "../../core/review";
import { formerRun } from "../../core/richtext";
import type { DocComment } from "../../core/types";
import { childNamed, childrenOf, descendantsNamed, rootOf, type XmlEl } from "./scan";
import type { AssetRef } from "../../core/types";
import { NS_R, NS_WP, REL_IMAGE, docxDrawingXml, docxPicPara, itemTops, picTargets, type OfficePic, type PicMedia } from "../officeDrawing";
import { MODEL_SHAPES, shapeChanges, shapeMap, shapesKept } from "./shapes";
import { docxDml } from "../formats/docxDml";
import { docxShapeXml } from "../officeShapes";
import { MODEL_PICTURES, bytesHash, docxDrawingPlace, emptyDocxPara, patchDocxDrawing, patchElement, picChanges, picMap, placeKey, type PicEdit } from "./pics";
import { entryData, readZip, rewriteZip, type ZipArchive } from "./zip";
import { picFormat as picFormatOf } from "../officeDrawing";

const MAIN = "word/document.xml";
const MAIN_RELS = "word/_rels/document.xml.rels";
const NUMBERING = "word/numbering.xml";
const tn = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { n });
const tableKey = (tb: TableNode) => hashString(tablePropsKey(tb));
const styleTag = (id: string) => `<w:pStyle w:val="${esc(id)}"/>`;

/** Block map of a freshly imported DOCX (null when the import and the element count disagree). */
export function docxMeta(pages: Page[], blockItems: number[], asset: { id: string; hash: string }, pics?: OfficePic[], assets?: Record<string, AssetRef>, shapes?: OfficePic[]): OfficeSourceMeta | null {
  const flow = collectFlow(pages);
  if (blockItems.reduce((a, b) => a + b, 0) !== flow.length) return null;
  let i = 0;
  const blocks: OfficeSourceBlock[] = blockItems.map((n) => {
    const its = flow.slice(i, (i += n));
    const b: OfficeSourceBlock = { ids: its.map(itemId), fp: its.map(itemFp) };
    if (its.some((it) => it.kind === "table")) b.tp = its.map((it) => (it.kind === "table" ? tableKey(it.t) : ""));
    return b;
  });
  // pictures read (report.pictures): model 5 with the picture map; an import without them is a model 4 map
  // (shapes read, report.shapes: model 11 with the shape map)
  const meta: OfficeSourceMeta = { engine: WORD_ENGINE_VERSION, model: pics ? (shapes ? MODEL_VERSION : MODEL_PARA_STYLES) : MODEL_HEADING_STYLES, hf: HF_MAP_VERSION, assetId: asset.id, hash: asset.hash, parts: [{ part: MAIN, blocks }] };
  if (pics?.length) meta.pics = picMap(pages, pics, assets);
  if (pics && shapes?.length) meta.shapes = shapeMap(pages, shapes);
  // footnotes / endnotes (model 7): each note's id in the file and the fingerprint of its text
  if (pics) meta.notes = flowNotes(flow).map((n) => ({ k: n.kind, id: n.src ?? "", fp: noteFp(n) }));
  return meta;
}

/**
 * The notes of the pages against the map: the w:id each is written with (its own while it is the note of the file,
 * a new one above every id of its kind otherwise), which of the file's notes changed or are gone, and which are new.
 */
function noteChanges(flow: FlowItem[], meta: OfficeSourceMeta) {
  const cur = flowNotes(flow);
  const ids = new Map<NoteRef, string>();
  const changed: NoteRef[] = [], added: NoteRef[] = [];
  if (!meta.notes) {
    // an older map: the notes stay as in the original (a page with notes made since cannot be written into it)
    if (cur.some((n) => !n.src)) throw new SurgeryUnavailable("notes (older map)");
    return { ids, changed, added, gone: [] as { k: "foot" | "end"; id: string }[], any: false, tracked: false };
  }
  const known = new Map(meta.notes.map((m) => [`${m.k}:${m.id}`, m.fp]));
  const used = new Set<string>();
  const next = { foot: 0, end: 0 };
  for (const m of meta.notes) next[m.k] = Math.max(next[m.k], Number(m.id) || 0);
  for (const n of cur) {
    const key = `${n.kind}:${n.src ?? ""}`;
    if (n.src != null && known.has(key) && !used.has(key)) {
      used.add(key);
      ids.set(n, n.src);
      if (noteFp(n) !== known.get(key)) changed.push(n);
    } else {
      ids.set(n, String(++next[n.kind]));
      added.push(n);
    }
  }
  const gone = meta.notes.filter((m) => !used.has(`${m.k}:${m.id}`)).map((m) => ({ k: m.k, id: m.id }));
  return { ids, changed, added, gone, any: changed.length + added.length + gone.length > 0, tracked: true };
}

export interface SurgeryResult {
  bytes: Uint8Array;
  /** true = the original file, byte for byte */
  unchanged: boolean;
  /** things the user should know before saving (shown with the save confirmation) */
  warnings: string[];
}

/** Why a surgical save was not possible (the caller writes a new file and says so; `notes`: what that new file loses besides). */
export class SurgeryUnavailable extends Error {
  constructor(
    message?: string,
    readonly notes: string[] = [],
  ) {
    super(message);
  }
}

/** run content kept after the text it followed when its paragraph is rewritten */
const KEEP_IN_RUN = new Set(["drawing", "pict", "object", "AlternateContent", "footnoteReference", "endnoteReference", "commentReference", "ptab"]);
/** paragraph children written back as they were (at their place) while their text is unchanged */
const INLINE_KEEP = new Set(["hyperlink", "oMath", "oMathPara", "fldSimple", "sdt", "smartTag", "customXml"]);
const RANGE_MARKS = new Set(["bookmarkStart", "bookmarkEnd", "commentRangeStart", "commentRangeEnd", "permStart", "permEnd", "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd", "proofErr"]);
/** w:pPr children kept when the paragraph format is rewritten (they have no model): before numPr / after numPr / at the end */
const PPR_HEAD = new Set(["keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl"]);
const PPR_HEAD_UNMODELLED = new Set(["framePr", "widowControl"]);
const PPR_MID = new Set(["suppressLineNumbers", "pBdr", "shd", "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct", "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd", "snapToGrid"]);
const PPR_TAIL = new Set(["sectPr"]);

type Chunk = { xml: string; kind: "p" | "tbl" | "end" | "other"; id?: string };

/** Surgical DOCX save of `pages` (all pages of the document that came from this file). */
export function saveDocxSurgical(pages: Page[], meta: OfficeSourceMeta, assets?: Record<string, AssetRef>): SurgeryResult {
  try {
    return surgicalDocx(pages, meta, assets);
  } finally {
    useDocxNoteIds(null);
  }
}

function surgicalDocx(pages: Page[], meta: OfficeSourceMeta, assets?: Record<string, AssetRef>): SurgeryResult {
  // headers made in this app on pages whose map predates headers: written anew (hf.ts hfAddedToOldMap)
  if (hfAddedToOldMap(meta, pages)) throw new SurgeryUnavailable("header / footer (older map)");
  // a map of rules version 1 (before page setup): usable while the pages are as that app made them (layout.ts)
  const legacy = meta.engine === WORD_ENGINE_VERSION ? null : legacyLayout(pages, meta.engine);
  const orig = getBlob(meta.hash);
  if (!orig) throw new SurgeryUnavailable("asset");
  const zip = readZip(orig);
  if (!zip) throw new SurgeryUnavailable("zip");
  const mainEntry = zip.entries.find((e) => e.name === MAIN);
  const map = meta.parts.find((p) => p.part === MAIN);
  if (!mainEntry || !map) throw new SurgeryUnavailable("part");
  const xml = strFromU8(entryData(zip, mainEntry));
  // version 1 read a page break (w:br type=page) as a space and a break-only paragraph as an item: such a map no
  // longer matches the items read now
  if (legacy && /<w:br\b[^>]*\btype="page"/.test(xml)) throw new SurgeryUnavailable("engine");
  const body = childNamed(xml, rootOf(xml), "body");
  if (!body) throw new SurgeryUnavailable("body");
  const els = childrenOf(xml, body);
  const blocks = map.blocks;
  if (els.length !== blocks.length) throw new SurgeryUnavailable("blocks");

  const starts: number[] = [];
  const flow = collectFlow(pages, starts);
  // page layout: the original's (read again) against the pages' — new breaks, changed paper / margins (layout.ts)
  // (a map from model 5 on was made by the importer that reads pictures: the original is read the same way)
  const rep: OfficeImportReport = { notesDropped: 0, ...((meta.model ?? 1) >= MODEL_PICTURES ? { pictures: [] } : {}), ...((meta.model ?? 1) >= MODEL_SHAPES ? { shapes: [], dml: docxDml } : {}), ...((meta.model ?? 1) >= MODEL_AFTER_TABLE ? { afterTableParas: true as const } : {}), ...((meta.model ?? 1) < MODEL_REVIEW ? { noReview: true as const } : {}) };
  const origItems = parseDocxFlow(orig, rep);
  if (origItems.length !== blocks.reduce((a, b) => a + b.ids.length, 0) || !rep.layout) throw new SurgeryUnavailable("layout");
  const diff = legacy ?? layoutDiff(pages, flow, starts, blocks.flatMap((b) => b.ids), rep.layout);
  // headers / footers / numbering against the original's (hf.ts; older maps keep the original's as they are)
  // (a section added here copies its enclosing section's settings element, header / footer references with it)
  const hfc: HFCompare = { cur: flowLayout(pages, starts, flow.length).hfs.filter((_, j) => !diff.addedSections?.has(j)), orig: rep.layout.sections, curEvenOdd: !!pages[0]?.hf?.evenOdd };
  const hfDiff = !legacy && hfChanged(meta, hfc);
  const where = new Map<string, { b: number; k: number }>();
  blocks.forEach((bl, b) => bl.ids.forEach((id, k) => where.set(id, { b, k })));
  // first place of each id (a duplicated paragraph / page repeats ids: the copies are new content)
  const pos = new Map<string, number>();
  flow.forEach((it, i) => pos.has(itemId(it)) || pos.set(itemId(it), i));
  // lists whose numbering changed (format, bullet, start: common.ts relistPlan) get numbering of their own
  const origById = new Map<string, OfficeItem>();
  let oi = 0;
  for (const bl of blocks) for (const id of bl.ids) origById.set(id, origItems[oi++]);
  const defsNow = pageListDefs(pages);
  const changedDefs = changedListDefs(defsNow, rep.lists);
  const plan = relistPlan(flowParas(flow), origParas(flow, (id) => origById.get(id)), fileListDefs(origItems.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras))), changedDefs, defsNow);
  if (plan.unsafe) throw new SurgeryUnavailable(plan.unsafe);
  const intact = blocks.map((bl) => {
    if (!bl.ids.length) return true;
    const at = bl.ids.map((id) => pos.get(id));
    if (at.some((x) => x === undefined)) return false;
    if (at.some((x, k) => k > 0 && x !== at[k - 1]! + 1)) return false;
    return bl.ids.every((_, k) => itemFp(flow[at[k]!]) === bl.fp[k] && !itemRelisted(flow[at[k]!], plan));
  });
  const origIds = blocks.flatMap((b) => b.ids);
  const sameOrder = flow.length === origIds.length && flow.every((it, i) => itemId(it) === origIds[i]);
  // pictures: changed / deleted ones of the map, new IMAGE nodes (pics.ts)
  const pc = picChanges(pages, meta, assets, getBlob);
  // footnotes / endnotes: changed, new and deleted ones (their parts are patched; references are written with ids)
  const nc = noteChanges(flow, meta);
  // comments and recording (model 9 on): the comment list and w:trackRevisions against the original's
  const review = (meta.model ?? 1) >= MODEL_REVIEW;
  const part = (name: string) => {
    const e = zip.entries.find((x) => x.name === name);
    return e ? entryData(zip, e) : undefined;
  };
  const origComments = review ? docxComments({ ...(part("word/comments.xml") ? { "word/comments.xml": part("word/comments.xml")! } : {}), ...(part("word/commentsExtended.xml") ? { "word/commentsExtended.xml": part("word/commentsExtended.xml")! } : {}) }) : [];
  const curComments = review ? docComments(pages) : [];
  const commentsChanged = review && JSON.stringify(curComments) !== JSON.stringify(origComments);
  const trackChanged = review && !!pages[0]?.trackChanges !== docxTracking(part("word/settings.xml"));
  // named styles changed or made here (core/docStyles.ts): their w:style elements of styles.xml
  const stylesEdited = (meta.model ?? 1) >= MODEL_PARA_STYLES && !!pages[0]?.docStyles?.some((x) => x.edited);
  // shapes and text boxes (model 11 map; shapes.ts): a changed or deleted one → the file is written anew (stage 1)
  const sc = shapeChanges(pages, meta);
  if (sc.changed) throw new SurgeryUnavailable("shape changed");
  if (sameOrder && intact.every(Boolean) && diff.none && !hfDiff && !pc.any && !sc.added.length && !nc.any && !commentsChanged && !trackChanged && !stylesEdited) return { bytes: orig, unchanged: true, warnings: pc.skipped ? [tn("engine.office.picsSkipped", pc.skipped)] : [] };
  useDocxNoteIds(nc.tracked ? nc.ids : null);
  const w = new DocxWriter(zip, xml, els, meta.model ?? 1, defsNow, plan, changedDefs);
  if (stylesEdited) w.sheet = pages[0]!.docStyles!;
  // the file's comment id of each comment (new ones after the file's highest), the comments around each paragraph
  const ids = new Map<string, string>();
  if (review) {
    let next = Math.max(-1, ...origComments.map((c) => Number(c.id)).filter(Number.isFinite)) + 1;
    for (const c of curComments) ids.set(c.id, /^\d+$/.test(c.id) && origComments.some((o) => o.id === c.id) ? c.id : String(next++));
    const order: TextParagraph[] = [];
    for (const it of flow) {
      if (it.kind === "p") order.push(it.p);
      else for (const row of it.t.rows) for (const c of row) if (c.richText) order.push(...c.richText);
    }
    const styles = docxAnnotationStyles(part("word/styles.xml") ? strFromU8(part("word/styles.xml")!) : null);
    w.review = { idOf: (id) => ids.get(id) ?? id, refStyle: styles.ref, neighbours: commentNeighbours(order) };
  }
  w.notesTracked = nc.tracked;
  const media = new DocxMedia(zip, xml);
  // changed / deleted pictures: their elements are written with only those pictures changed (or left out)
  const picEdited = new Set<number>();
  for (const [key, edits] of pc.edits) {
    const b = Number(key.slice(key.indexOf("|") + 1));
    if (!key.startsWith(MAIN + "|") || !els[b]) throw new SurgeryUnavailable("picture map");
    const r = patchElement(xml, els[b], "drawing", edits, (e, text) => media.rewrite(e, text, assets));
    if (r == null) throw new SurgeryUnavailable("picture");
    w.patched.set(els[b].start, !blocks[b].ids.length && els[b].local === "p" && emptyDocxPara(r.text) ? "" : r.text);
    picEdited.add(b);
  }
  const chunks: Chunk[] = [];
  // sections added here (LayoutDiff.addSections), in the order their placeholders went into the chunks
  const newSects: { orig: number; setup: PageSetup }[] = [];
  const kindOf = (el: XmlEl): Chunk["kind"] => (el.local === "p" ? "p" : el.local === "tbl" ? "tbl" : el.local === "sectPr" ? "end" : "other");
  // the empty paragraph Word keeps after a table belongs to that table (dropped with it)
  const tail = new Map<number, number>();
  els.forEach((el, b) => {
    if (el.local === "tbl" && blocks[b + 1] && !blocks[b + 1].ids.length && els[b + 1].local === "p") tail.set(b, b + 1);
  });
  const owned = new Set(tail.values());
  // other elements without content travel with the next content element (or stay at the end)
  const prefixDone = new Set<number>();
  const emitPrefix = (b: number) => {
    // also the prefixes of earlier content blocks that are gone entirely
    for (let j = 0; j <= b; j++) {
      if (prefixDone.has(j) || !blocks[j].ids.length || (j < b && blocks[j].ids.some((id) => pos.has(id)))) continue;
      prefixDone.add(j);
      let z = j - 1;
      while (z >= 0 && !blocks[z].ids.length) z--;
      for (let q = z + 1; q < j; q++) if (!owned.has(q)) chunks.push({ xml: w.text(els[q]), kind: kindOf(els[q]) });
    }
  };
  const pushTail = (b: number) => {
    const q = tail.get(b);
    if (q !== undefined) chunks.push({ xml: w.text(els[q]), kind: "p" });
  };
  const doneBlocks = new Set<number>();
  const blockChunk = new Map<number, number>();
  const seen = new Set<string>();
  // the chunk each item ended up in (new pictures go before / after / into it)
  const chunkOf = new Map<string, number>();
  const mark = (id: string, b?: number) => {
    if (chunkOf.has(id)) return;
    const at = b !== undefined && blockChunk.has(b) ? blockChunk.get(b)! : chunks.length - 1;
    chunkOf.set(id, at);
    if (b !== undefined && !blockChunk.has(b)) blockChunk.set(b, at);
  };
  for (const it of flow) {
    const id = itemId(it);
    const o = seen.has(id) ? undefined : where.get(id);
    // a new page break before this item (Word's page-break paragraph)
    if (!seen.has(id)) for (let k = diff.addBreaks.get(id) ?? 0; k > 0; k--) chunks.push({ xml: DOCX_PAGE_BREAK, kind: "p" });
    // a section added before this item (구역 나누기): a placeholder for its section-break paragraph (written after the
    // original sections' settings are patched, which counts the file's own w:sectPr elements)
    if (!seen.has(id) && diff.addSections?.has(id)) {
      newSects.push(diff.addSections.get(id)!);
      chunks.push({ xml: `\u0000OMWSECT${newSects.length - 1}\u0000`, kind: "p" });
    }
    seen.add(id);
    if (!o) {
      chunks.push(it.kind === "p" ? { xml: w.freshPara(it.p), kind: "p" } : { xml: w.freshTable(it.t), kind: "tbl" });
      mark(id);
      continue;
    }
    emitPrefix(o.b);
    const el = els[o.b];
    const bl = blocks[o.b];
    if (intact[o.b]) {
      if (!doneBlocks.has(o.b)) {
        chunks.push({ xml: w.text(el), kind: kindOf(el) });
        mark(id, o.b);
        w.noteLists(el);
        pushTail(o.b);
      } else mark(id, o.b);
      doneBlocks.add(o.b);
      continue;
    }
    // a picture change in an element that is rewritten (its text changed): not placed here
    if (picEdited.has(o.b)) throw new SurgeryUnavailable("picture in a changed paragraph");
    // (a shape or text box read from the file in an element that is rewritten: not placed here either, stage 1)
    if (meta.shapes?.some((x) => x.b === o.b)) throw new SurgeryUnavailable("shape in a changed paragraph");
    const single = bl.ids.length === 1;
    if (!single) w.controlDropped(el);
    if (it.kind === "p") {
      chunks.push({ xml: single && el.local === "p" ? w.rewritePara(it.p, el, w.domOf(o.b)) : w.freshPara(it.p), kind: "p" });
      mark(id);
    } else {
      chunks.push({ xml: single && el.local === "tbl" ? w.rewriteTable(it.t, el, w.domOf(o.b), bl.tp?.[0] ?? "") : w.freshTable(it.t), kind: "tbl" });
      mark(id);
      if (single) pushTail(o.b);
    }
  }
  // new pictures, shapes and text boxes: placed like a fresh save places them (before / after the item at their place,
  // anchored in it)
  if (pc.added.length || sc.added.length) {
    const ids = flow.map(itemId);
    const tops = itemTops(pages);
    const before = new Map<number, string[]>(), after = new Map<number, string[]>(), inside = new Map<number, string>();
    const end: string[] = [];
    const holder = (run: string) => `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/></w:pPr>${run}</w:p>`;
    const place = (t: { item: number; after: boolean }, run: string, float: boolean, own: () => string) => {
      const ci = t.item >= 0 ? chunkOf.get(ids[t.item]) : undefined;
      if (ci === undefined) end.push(holder(run));
      else if (float && chunks[ci].kind === "p") inside.set(ci, (inside.get(ci) ?? "") + run);
      else {
        const map = t.after ? after : before;
        map.set(ci, [...(map.get(ci) ?? []), own()]);
      }
    };
    picTargets(
      pc.added.map((m) => m.pic),
      ids,
      tops,
    ).forEach((t, i) => {
      const m = pc.added[i];
      const run = `<w:r>${media.fresh(m)}</w:r>`;
      place(t, run, m.pic.place.mode === "float", () => (m.pic.place.mode === "inline" ? docxPicPara(run, m.pic.align, m.pic.indent, t.before, t.below) : holder(run)));
    });
    picTargets(sc.added, ids, tops).forEach((t) => {
      const run = `<w:r>${docxShapeXml(t.pic, { id: media.nextDocPr(), paras: (ps) => ps.map((q) => w.freshPara(q)).join("") || "<w:p/>" })}</w:r>`;
      place(t, run, true, () => holder(run));
    });
    const next: Chunk[] = [];
    chunks.forEach((c, i) => {
      for (const x of before.get(i) ?? []) next.push({ xml: x, kind: "p" });
      next.push(inside.has(i) ? { ...c, xml: injectRun(c.xml, inside.get(i)!) } : c);
      for (const x of after.get(i) ?? []) next.push({ xml: x, kind: "p" });
    });
    // pictures of pages without items: before what ends the body (w:sectPr)
    const tailAt = next.findIndex((c) => c.kind === "end");
    next.splice(tailAt < 0 ? next.length : tailAt, 0, ...end.map((x) => ({ xml: x, kind: "p" as const })));
    chunks.splice(0, chunks.length, ...next);
  }
  // prefixes of deleted blocks at the end, then what follows the last content element (w:sectPr)
  let last = blocks.length - 1;
  while (last >= 0 && !blocks[last].ids.length) last--;
  if (last >= 0) emitPrefix(last);
  for (let q = last + 1; q < els.length; q++) if (!owned.has(q)) chunks.push({ xml: w.text(els[q]), kind: kindOf(els[q]) });

  // Word: a table needs a paragraph after it when it ends the body or another table follows (they would merge)
  const out: string[] = [];
  chunks.forEach((c, i) => {
    out.push(c.xml);
    if (c.kind !== "tbl") return;
    let j = i + 1;
    while (j < chunks.length && chunks[j].kind === "other") j++;
    if (j >= chunks.length || chunks[j].kind === "tbl" || chunks[j].kind === "end") out.push("<w:p/>");
  });
  let bodyXml = out.join("");
  // every shape read from the file is still in it (its paragraph deleted, the shape still on the page: written anew)
  if (!shapesKept(meta, MAIN, xml, els, bodyXml, "docx")) throw new SurgeryUnavailable("shape's paragraph deleted");
  // comments: their marks one per comment, none of a deleted one; a comment whose text is all gone goes too (Word)
  let alive: DocComment[] = [];
  if (review) {
    const onRuns = new Set<string>();
    for (const it of flow) {
      const ps = it.kind === "p" ? [it.p] : it.t.rows.flatMap((row) => row.flatMap((c) => c.richText ?? []));
      for (const p of ps) for (const r of p.runs) for (const id of r.comments ?? []) onRuns.add(id);
    }
    // (a comment on the text of a footnote / endnote or of a header / footer: those parts keep its marks, so it stays —
    // QA doc-review2: it was taken out of comments.xml at the first body edit, its reference left dangling)
    const elsewhere = zip.entries
      .filter((e) => /^word\/(footnotes|endnotes|header\d*|footer\d*)\.xml$/.test(e.name))
      .map((e) => strFromU8(entryData(zip, e)))
      .join("");
    const refIn = (id: string) => new RegExp(`<w:commentReference\\b[^>]*?w:id="${id}"`).test(bodyXml) || new RegExp(`<w:comment(?:Reference|RangeStart)\\b[^>]*?w:id="${id}"`).test(elsewhere);
    alive = curComments.filter((c) => onRuns.has(c.id) || refIn(ids.get(c.id)!));
    // (replies of a comment that went go with it)
    const live = new Set(alive.map((c) => c.id));
    alive = alive.filter((c) => !c.parent || live.has(c.parent) || !curComments.some((x) => x.id === c.parent));
    const keep = new Set(alive.map((c) => ids.get(c.id)!));
    bodyXml = tidyDocxCommentMarks(bodyXml, keep);
    // (a move accepted / rejected: its range marks go with it)
    if (bodyXml !== xml.slice(body.openEnd, body.closeStart)) bodyXml = tidyDocxMoveRanges(bodyXml);
  }
  // changed paper / margins: only those sections' w:pgSz and w:pgMar
  if (diff.setups.size) bodyXml = patchSectPrs(bodyXml, xml.slice(body.openEnd, body.closeStart), diff.setups, rep.layout.sections);
  // sections added (구역 나누기): Word's section-break paragraph — the enclosing original section's w:sectPr (its header /
  // footer references, notes, grid) with the part's own paper, margins and columns, starting a new page
  if (newSects.length) {
    const origSects = [...xml.slice(body.openEnd, body.closeStart).matchAll(SECTPR)].map((m) => m[0]);
    bodyXml = bodyXml.replace(/\u0000OMWSECT(\d+)\u0000/g, (_, i: string) => {
      const ns = newSects[Number(i)];
      const src = rep.layout?.sections[ns.orig]?.src;
      const base = src !== undefined ? origSects[src] : undefined;
      if (!base) throw new SurgeryUnavailable("section settings");
      return `<w:p><w:pPr>${newSectPr(base, ns.setup, rep.layout?.sections[ns.orig]?.setup)}</w:pPr></w:p>`;
    });
  }
  // 이어서 구역 (TextParagraph.contSect): the same ones as the original's — their changed columns into their own w:sectPr
  // only; one added or taken out is written anew
  {
    const contOf = (ps: TextParagraph[]) => ps.flatMap((p) => (p.contSect ? [p.contSect] : []));
    const was = contOf(origItems.flatMap((it) => (it.kind === "p" ? [it.p] : [])));
    const now = contOf(flow.flatMap((it) => (it.kind === "p" ? [it.p] : [])));
    if (was.length !== now.length || was.some((c, i) => c.src !== now[i].src)) throw new SurgeryUnavailable("continuous sections");
    const cols = new Map<number, PageSetup>();
    now.forEach((c, i) => c.src !== undefined && !sameColumns(was[i].columns, c.columns) && cols.set(c.src, { width: 0, height: 0, margins: { top: 0, right: 0, bottom: 0, left: 0, header: 0, footer: 0 }, ...(c.columns ? { columns: c.columns } : {}) }));
    if (cols.size) {
      let i = 0;
      bodyXml = bodyXml.replace(SECTPR, (sect) => {
        const s = cols.get(i++);
        return s ? sectPrWithCols(sect, s) : sect;
      });
    }
  }
  const changed = new Map<string, Uint8Array>();
  const hfWarnings: string[] = [];
  // changed headers / footers: only their parts, references and settings
  if (hfDiff) bodyXml = applyDocxHF(zip, hfc, bodyXml, changed, hfWarnings, xml.slice(0, body.openEnd).includes('xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'));
  // pictures written anew: the drawing namespaces on the document element when the original has none
  const head = media.used ? withDrawingNs(xml.slice(0, body.openEnd)) : xml.slice(0, body.openEnd);
  const newXml = head + bodyXml + xml.slice(body.closeStart);
  const enc = new TextEncoder();
  // the main part is written only when it changed (a header-only edit leaves it byte for byte)
  if (newXml !== xml) changed.set(MAIN, enc.encode(newXml));
  if (w.numberingXml != null) {
    changed.set(NUMBERING, enc.encode(w.numberingXml));
    if (w.numberingCreated) addNumberingPart(zip, changed);
  }
  media.commit(changed);
  // (a heading style the file did not define, used by a paragraph now — Word's latent heading picked in the gallery)
  for (const m of newXml.matchAll(/<w:pStyle w:val="Heading([1-9])"\/>/g)) w.addedHeadings.add(Number(m[1]));
  if (w.addedHeadings.size) {
    const st = changed.get("word/styles.xml") ?? part("word/styles.xml");
    if (st) {
      const x = strFromU8(st);
      const y = addHeadingStyles(x, [...w.addedHeadings]);
      if (y !== x) changed.set("word/styles.xml", enc.encode(y));
    }
  }
  if (stylesEdited) {
    const st = changed.get("word/styles.xml") ?? part("word/styles.xml");
    if (st) {
      const x = strFromU8(st);
      const y = patchDocxStyles(x, pages[0]!.docStyles!);
      if (y !== x) changed.set("word/styles.xml", enc.encode(y));
    }
  }
  // notes: only the changed / new / deleted w:footnote and w:endnote elements of their parts
  if (nc.any) patchDocxNotes(zip, changed, nc, w);
  // comments: only the changed / new / deleted w:comment elements and their commentsExtended / commentsIds entries
  if (review && (commentsChanged || alive.length !== curComments.length)) patchDocxComments(zip, changed, origComments, alive, (id) => ids.get(id) ?? id, newXml);
  // recording changes on / off: w:trackRevisions of settings.xml
  if (trackChanged) {
    const s = part("word/settings.xml");
    if (s) changed.set("word/settings.xml", enc.encode(docxSettingsTracking(strFromU8(s), !!pages[0]?.trackChanges)));
  }
  const warnings = [...w.warnings(), ...hfWarnings];
  if (pc.skipped) warnings.push(tn("engine.office.picsSkipped", pc.skipped));
  if (zip.entries.some((e) => e.name.startsWith("_xmlsignatures/"))) warnings.unshift(t("engine.officeSurgeon.signature"));
  return { bytes: rewriteZip(zip, changed), unchanged: false, warnings };
}

/**
 * The note parts of a surgical save: a changed note's element keeps its start tag and gets its paragraphs written anew
 * in the look of its original first paragraph (style, mark run); new notes are added in the look of the part's notes;
 * deleted ones go. A part the original lacks is made (separators, content type, relationship).
 */
/**
 * Word's built-in heading styles ("heading N", w:styleId HeadingN) added to a file's styles.xml that does not define them
 * (DocxWriter.addedHeadings): based on the file's default paragraph style, with Word's outline level and keep-with-next.
 */
export function addHeadingStyles(xml: string, levels: number[]): string {
  const end = xml.lastIndexOf("</w:styles>");
  if (end < 0) return xml;
  const def = /<w:style(?=[^>]*w:type="paragraph")(?=[^>]*w:default="(?:1|true)")[^>]*w:styleId="([^"]+)"/.exec(xml)?.[1];
  const add = levels
    .sort((a, b) => a - b)
    .filter((n) => !xml.includes(`w:styleId="Heading${n}"`))
    .map(
      (n) =>
        `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/>${def ? `<w:basedOn w:val="${def}"/><w:next w:val="${def}"/>` : ""}` +
        `<w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr></w:style>`,
    )
    .join("");
  return add ? xml.slice(0, end) + add + xml.slice(end) : xml;
}

function patchDocxNotes(zip: ZipArchive, changed: Map<string, Uint8Array>, nc: ReturnType<typeof noteChanges>, w: DocxWriter) {
  const enc = new TextEncoder();
  const read = (name: string) => {
    const c = changed.get(name);
    if (c) return strFromU8(c);
    const e = zip.entries.find((x) => x.name === name);
    return e ? strFromU8(entryData(zip, e)) : null;
  };
  for (const kind of ["foot", "end"] as const) {
    const mine = (l: NoteRef[]) => l.filter((n) => n.kind === kind);
    const ch = mine(nc.changed), add = mine(nc.added), gone = nc.gone.filter((g) => g.k === kind);
    if (!ch.length && !add.length && !gone.length) continue;
    const T = DOCX_NOTE_TYPES[kind];
    const tag = `w:${kind}note`;
    let x = read(T.part);
    const made = x == null;
    if (made) x = docxNotesPartXml(kind, "");
    let s = x!;
    const elRe = (id: string) => new RegExp(`<${tag}\\b[^>]*\\bw:id="${id.replace(/[^\w-]/g, "")}"[^>]*>[\\s\\S]*?</${tag}>`);
    // the look of notes in this part: the first normal note's paragraph properties and mark run properties
    const sample = /<w:footnote\b|<w:endnote\b/.test(s) ? new RegExp(`<${tag}\\b(?![^>]*w:type="(?:separator|continuationSeparator|continuationNotice)")[^>]*>([\\s\\S]*?)</${tag}>`).exec(s)?.[1] ?? "" : "";
    const lookOf = (inner: string) => ({
      pPr: /<w:pPr>[\s\S]*?<\/w:pPr>|<w:pPr\/>/.exec(inner)?.[0] ?? "",
      markRPr: new RegExp(`<w:r>(<w:rPr>(?:(?!</w:r>)[\\s\\S])*?</w:rPr>)<w:${kind}noteRef/>`).exec(inner)?.[1] ?? `<w:rPr><w:vertAlign w:val="superscript"/></w:rPr>`,
    });
    const write = (n: NoteRef, id: string, look: { pPr: string; markRPr: string }, open?: string) =>
      docxNoteXml(kind, id, n.paras, (p) => `<w:p>${look.pPr ? withPPr(look.pPr, p) : docxPPr(p, "", "")}${docxRuns(p.runs, (r) => (r.noteMark ? look.markRPr : null))}</w:p>`, open);
    for (const n of ch) {
      const id = nc.ids.get(n)!;
      const m = elRe(id).exec(s);
      if (!m) throw new SurgeryUnavailable("note");
      const open = /^<[^>]*>/.exec(m[0])![0];
      s = s.slice(0, m.index) + write(n, id, lookOf(m[0]), open) + s.slice(m.index + m[0].length);
    }
    for (const g of gone) s = s.replace(elRe(g.id), "");
    if (add.length) {
      const end = s.lastIndexOf(`</${tag}s>`);
      if (end < 0) throw new SurgeryUnavailable("notes part");
      const look = lookOf(sample);
      s = s.slice(0, end) + add.map((n) => write(n, nc.ids.get(n)!, look)).join("") + s.slice(end);
    }
    changed.set(T.part, enc.encode(s));
    if (made) {
      let ct = read("[Content_Types].xml");
      let rels = read(MAIN_RELS);
      if (ct == null || rels == null) throw new SurgeryUnavailable("notes part");
      if (!ct.includes(`PartName="/${T.part}"`)) ct = ct.replace("</Types>", `<Override PartName="/${T.part}" ContentType="${T.ct}"/></Types>`);
      let rid = `rIdOmw${kind === "foot" ? "Foot" : "End"}notes`;
      while (rels.includes(`Id="${rid}"`)) rid += "x";
      if (!rels.includes(T.rel + `"`)) rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="${T.rel}" Target="${T.part.slice(5)}"/></Relationships>`);
      changed.set("[Content_Types].xml", enc.encode(ct));
      changed.set(MAIN_RELS, enc.encode(rels));
    }
  }
  void w;
}

const W_NS_URI = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

/**
 * The comment parts of a surgical save: a comment deleted (or whose text is all gone) leaves comments.xml and its
 * commentsExtended / commentsIds entries; an edited one is written anew in its element (its last paragraph keeps its
 * id, so the reply / resolved entries still find it); new ones are appended (parts made when the original has none).
 * Untouched comments stay byte for byte.
 */
function patchDocxComments(zip: ZipArchive, changed: Map<string, Uint8Array>, orig: DocComment[], cur: DocComment[], idOf: (id: string) => string, docXml: string) {
  const enc = new TextEncoder();
  const read = (name: string) => {
    const c = changed.get(name);
    if (c) return strFromU8(c);
    const e = zip.entries.find((x) => x.name === name);
    return e ? strFromU8(entryData(zip, e)) : null;
  };
  const styles = docxAnnotationStyles(read("word/styles.xml"));
  const decl = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
  let cx = read("word/comments.xml");
  const made = cx == null;
  if (made) cx = `${decl}<w:comments xmlns:w="${W_NS_URI}"></w:comments>`;
  const open = /<w:comments\b[^>]*>/.exec(cx!);
  if (!open) throw new SurgeryUnavailable("comments");
  let s = cx!.slice(0, open.index) + withW14(open[0]) + cx!.slice(open.index + open[0].length);
  const used = paraIdsIn(docXml + s);
  const safe = (id: string) => id.replace(/[^\w-]/g, "");
  const elRe = (wid: string) => new RegExp(`<w:comment\\b[^>]*\\bw:id="${safe(wid)}"[^>]*>[\\s\\S]*?</w:comment>`);
  const byId = new Map(orig.map((c) => [c.id, c]));
  const curIds = new Set(cur.map((c) => c.id));
  // the w14:paraId of each comment's last paragraph (what commentsExtended / commentsIds name it by)
  const lastPara = new Map<string, string>();
  for (const o of orig) {
    const m = elRe(o.id).exec(s);
    const pids = m ? Array.from(m[0].matchAll(/w14:paraId="([0-9A-Fa-f]{8})"/g), (x) => x[1]) : [];
    if (pids.length) lastPara.set(o.id, pids[pids.length - 1]);
  }
  for (const o of orig) if (!curIds.has(o.id)) s = s.replace(elRe(o.id), "");
  const pidsFor = (c: DocComment, keepLast?: string) => {
    const n = Math.max(1, c.text.split("\n").length);
    return Array.from({ length: n }, (_, i) => (i === n - 1 && keepLast ? keepLast : newParaId(used)));
  };
  for (const c of cur) {
    const o = byId.get(c.id);
    if (!o || (o.text === c.text && o.author === c.author && (o.initials ?? "") === (c.initials ?? "") && (o.date ?? "") === (c.date ?? ""))) continue;
    const m = elRe(c.id).exec(s);
    if (!m) continue;
    const pids = pidsFor(c, lastPara.get(c.id));
    lastPara.set(c.id, pids[pids.length - 1]);
    s = s.slice(0, m.index) + docxCommentXml(c, c.id, pids, styles) + s.slice(m.index + m[0].length);
  }
  const added = cur.filter((c) => !byId.has(c.id));
  let add = "";
  for (const c of added) {
    const pids = pidsFor(c);
    lastPara.set(c.id, pids[pids.length - 1]);
    add += docxCommentXml(c, idOf(c.id), pids, styles);
  }
  const end = s.lastIndexOf("</w:comments>");
  if (end < 0) throw new SurgeryUnavailable("comments");
  s = s.slice(0, end) + add + s.slice(end);
  if (s !== cx) changed.set("word/comments.xml", enc.encode(s));

  // replies and resolved marks (commentsExtended): entries of deleted comments go, changed ones are set, new ones added
  let ex = read("word/commentsExtended.xml");
  const exMade = ex == null;
  const needEx = cur.some((c) => c.parent || c.done) || !exMade;
  if (needEx) {
    if (exMade) ex = `${decl}<w15:commentsEx xmlns:w15="${W15_NS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="w15"></w15:commentsEx>`;
    let e = ex!;
    const entryRe = (pid: string) => new RegExp(`<w15:commentEx\\b[^>]*\\bw15:paraId="${pid}"[^>]*/>`, "i");
    const entry = (c: DocComment) => {
      const parent = c.parent ? lastPara.get(c.parent) : undefined;
      return `<w15:commentEx w15:paraId="${lastPara.get(c.id)}"${parent ? ` w15:paraIdParent="${parent}"` : ""} w15:done="${c.done ? 1 : 0}"/>`;
    };
    for (const o of orig) if (!curIds.has(o.id) && lastPara.has(o.id)) e = e.replace(entryRe(lastPara.get(o.id)!), "");
    for (const c of cur) {
      const o = byId.get(c.id);
      const pid = lastPara.get(c.id);
      if (!pid) continue;
      const m = entryRe(pid).exec(e);
      if (o && m) {
        if (!!o.done === !!c.done && (o.parent ?? "") === (c.parent ?? "")) continue;
        e = e.slice(0, m.index) + entry(c) + e.slice(m.index + m[0].length);
      } else if (!m) {
        const at = e.lastIndexOf("</w15:commentsEx>");
        if (at < 0) throw new SurgeryUnavailable("commentsExtended");
        e = e.slice(0, at) + entry(c) + e.slice(at);
      }
    }
    if (e !== ex) changed.set("word/commentsExtended.xml", enc.encode(e));
  }
  // durable ids (commentsIds, when the file has the part): entries of deleted comments go, new ones get one
  const ids = read("word/commentsIds.xml");
  if (ids != null) {
    let d = ids;
    for (const o of orig) if (!curIds.has(o.id) && lastPara.has(o.id)) d = d.replace(new RegExp(`<w16cid:commentId\\b[^>]*\\bw16cid:paraId="${lastPara.get(o.id)}"[^>]*/>`, "i"), "");
    const at = d.lastIndexOf("</w16cid:commentsIds>");
    if (at >= 0 && added.length) {
      const durable = new Set(Array.from(d.matchAll(/w16cid:durableId="([0-9A-Fa-f]{8})"/g), (m) => m[1].toUpperCase()));
      d = d.slice(0, at) + added.map((c) => `<w16cid:commentId w16cid:paraId="${lastPara.get(c.id)}" w16cid:durableId="${newParaId(durable)}"/>`).join("") + d.slice(at);
    }
    if (d !== ids) changed.set("word/commentsIds.xml", enc.encode(d));
  }
  // parts the original lacks: content types and relationships
  const parts: { part: string; ct: string; rel: string }[] = [];
  if (made) parts.push({ part: "word/comments.xml", ct: COMMENTS_CT, rel: COMMENTS_REL });
  if (needEx && exMade) parts.push({ part: "word/commentsExtended.xml", ct: COMMENTS_EX_CT, rel: COMMENTS_EX_REL });
  if (parts.length) {
    let ct = read("[Content_Types].xml");
    let rels = read(MAIN_RELS);
    if (ct == null || rels == null) throw new SurgeryUnavailable("comments part");
    for (const p of parts) {
      if (!ct.includes(`PartName="/${p.part}"`)) ct = ct.replace("</Types>", `<Override PartName="/${p.part}" ContentType="${p.ct}"/></Types>`);
      let rid = `rIdOmw${p.part.slice(5, -4)}`;
      while (rels.includes(`Id="${rid}"`)) rid += "x";
      if (!rels.includes(`Type="${p.rel}"`)) rels = rels.replace("</Relationships>", `<Relationship Id="${rid}" Type="${p.rel}" Target="${p.part.slice(5)}"/></Relationships>`);
    }
    changed.set("[Content_Types].xml", enc.encode(ct));
    changed.set(MAIN_RELS, enc.encode(rels));
  }
  void W14_NS;
}

/** An original note paragraph's w:pPr with the paragraph's alignment written in when it changed (style kept). */
function withPPr(pPr: string, p: TextParagraph): string {
  const jc = `<w:jc w:val="${{ LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFY: "both" }[p.align]}"/>`;
  return /<w:jc\b[^>]*\/>/.test(pPr) ? pPr.replace(/<w:jc\b[^>]*\/>/, jc) : pPr;
}

const SECTPR = /<w:sectPr\b[^>]*?(?:\/>|>[\s\S]*?<\/w:sectPr>)/g;

/** A run put into a paragraph right after its properties (a new floating picture anchored in it). */
function injectRun(p: string, run: string): string {
  const pe = p.indexOf("</w:pPr>");
  if (pe >= 0) return p.slice(0, pe + 8) + run + p.slice(pe + 8);
  if (/^<w:p\b[^>]*\/>$/.test(p)) return p.slice(0, -2) + ">" + run + "</w:p>";
  const open = p.indexOf(">") + 1;
  return p.slice(0, open) + run + p.slice(open);
}

/** The document element's start tag with the DrawingML (wp) and relationship (r) namespaces when it lacks them. */
function withDrawingNs(head: string): string {
  const m = /<w:document\b[^>]*>/.exec(head);
  if (!m) throw new SurgeryUnavailable("document element");
  let tag = m[0];
  if (!/\sxmlns:wp=/.test(tag)) tag = tag.replace(/<w:document\b/, `<w:document xmlns:wp="${NS_WP}"`);
  else if (!tag.includes(`xmlns:wp="${NS_WP}"`)) throw new SurgeryUnavailable("namespace");
  if (!/\sxmlns:r=/.test(tag)) tag = tag.replace(/<w:document\b/, `<w:document xmlns:r="${NS_R}"`);
  return head.slice(0, m.index) + tag + head.slice(m.index + m[0].length);
}

/**
 * New picture parts of a surgical save: bytes as they are under word/media (a name the package does not have), an image
 * relationship and the content type of the extension; changed pictures patched or written anew (pics.ts).
 */
class DocxMedia {
  used = false;
  private rels: string;
  private ct: string;
  private relsChanged = false;
  private ctChanged = false;
  private parts = new Map<string, Uint8Array>();
  private relAdds: string[] = [];
  private ctAdds: { ext: string; xml: string }[] = [];
  private byHash = new Map<string, string>();
  private docPr: number;
  private names: Set<string>;

  constructor(
    private zip: ZipArchive,
    xml: string,
  ) {
    const read = (name: string) => {
      const e = zip.entries.find((x) => x.name === name);
      return e ? strFromU8(entryData(zip, e)) : null;
    };
    this.rels = read(MAIN_RELS) ?? "";
    this.ct = read("[Content_Types].xml") ?? "";
    this.names = new Set(zip.entries.map((e) => e.name));
    // new pictures' wp:docPr ids: above every id of the document — the body and its headers / footers (Word wants
    // them unique in the whole package; a header picture with the same id is reported as an error)
    const parts = [xml, ...zip.entries.filter((e) => /^word\/(header|footer)\d*\.xml$/.test(e.name)).map((e) => strFromU8(entryData(zip, e)))];
    this.docPr = Math.max(0, ...parts.flatMap((x) => Array.from(x.matchAll(/<wp:docPr\b[^>]*\sid="(\d+)"/g), (m) => Number(m[1]) || 0)));
  }

  /** relationship id of these bytes (a new part the first time) */
  private relFor(m: { bytes: Uint8Array; ext: string; mime: string; hash: string }): string {
    const known = this.byHash.get(m.hash);
    if (known) return known;
    if (!this.rels || !this.ct) throw new SurgeryUnavailable("rels");
    let n = 1;
    while (this.names.has(`word/media/omw-image${n}.${m.ext}`)) n++;
    const name = `word/media/omw-image${n}.${m.ext}`;
    this.names.add(name);
    this.parts.set(name, m.bytes);
    let id = `rIdOmwImg${n}`;
    while (this.rels.includes(`Id="${id}"`)) id += "x";
    const end = this.rels.lastIndexOf("</Relationships>");
    if (end < 0) throw new SurgeryUnavailable("rels");
    const rel = `<Relationship Id="${id}" Type="${REL_IMAGE}" Target="media/omw-image${n}.${m.ext}"/>`;
    this.rels = this.rels.slice(0, end) + rel + this.rels.slice(end);
    this.relAdds.push(rel);
    this.relsChanged = true;
    if (!new RegExp(`<Default\\b[^>]*Extension="${m.ext}"`, "i").test(this.ct)) {
      const at = this.ct.indexOf("<Default");
      const ins = `<Default Extension="${m.ext}" ContentType="${m.mime}"/>`;
      this.ct = at >= 0 ? this.ct.slice(0, at) + ins + this.ct.slice(at) : this.ct.replace("</Types>", ins + "</Types>");
      this.ctAdds.push({ ext: m.ext, xml: ins });
      this.ctChanged = true;
    }
    this.byHash.set(m.hash, id);
    return id;
  }

  /** a wp:docPr id no drawing of the document has (a new shape's) */
  nextDocPr(): number {
    return ++this.docPr;
  }

  /** w:drawing of a new picture */
  fresh(m: PicMedia): string {
    this.used = true;
    return docxDrawingXml({ rId: this.relFor(m), id: ++this.docPr, name: m.pic.node.name, g: m.pic.g, place: m.pic.place, z: m.pic.z });
  }

  /** a changed picture: patched in place, or written anew (other placement kind, other bytes) with its docPr */
  rewrite(e: PicEdit, d: string, assets: Record<string, AssetRef> | undefined): string | null {
    const node = e.node!, g = e.g!;
    const rId = /\br:embed="([^"]+)"/.exec(d)?.[1];
    const target = rId && new RegExp(`<Relationship\\b[^>]*\\bId="${rId}"[^>]*>`).exec(this.rels)?.[0].match(/\bTarget="([^"]+)"/)?.[1];
    const entry = target && this.zip.entries.find((x) => x.name === "word/" + target.replace(/^\.\//, "") || "/" + x.name === target);
    const origHash = entry ? bytesHash(entryData(this.zip, entry)) : null;
    const asset = assets?.[node.assetId];
    const sameBytes = !!asset && asset.hash === origHash;
    const place = docxDrawingPlace(d);
    if (sameBytes && placeKey(node, place) === place) return patchDocxDrawing(d, g);
    const bytes = asset && getBlob(asset.hash);
    const fmt = bytes && picFormatOf(bytes);
    if (!sameBytes && (!bytes || !fmt || !asset)) return null;
    const id = sameBytes ? rId! : this.relFor({ bytes: bytes!, ...fmt!, hash: asset!.hash });
    this.used = true;
    const docPr = /<wp:docPr\b[^>]*>/.exec(d)?.[0] ?? "";
    const at = (n: string) => new RegExp(`\\s${n}="([^"]*)"`).exec(docPr)?.[1];
    const unesc = (v: string | undefined) => v?.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    return docxDrawingXml({ rId: id, id: Number(at("id")) || ++this.docPr, name: unesc(at("name")) ?? node.name, descr: unesc(at("descr")), g, place: node.place ?? { mode: place === "inline" ? "inline" : "float", ...(place === "inline" ? {} : { wrap: place.slice(6) as "topBottom" }) } });
  }

  commit(changed: Map<string, Uint8Array>) {
    const enc = new TextEncoder();
    for (const [n, b] of this.parts) changed.set(n, b);
    // merged into what earlier stages wrote (a new header / footer part's relationship and content type): writing this
    // stage's copy of the original over them left a w:headerReference without its relationship ??Word: "damaged"
    // (QA ui-audit #31)
    const cur = (name: string) => {
      const c = changed.get(name);
      if (c) return strFromU8(c);
      const e = this.zip.entries.find((x) => x.name === name);
      return e ? strFromU8(entryData(this.zip, e)) : "";
    };
    if (this.relsChanged) {
      const now = cur(MAIN_RELS);
      const end = now.lastIndexOf("</Relationships>");
      if (end < 0) throw new SurgeryUnavailable("rels");
      changed.set(MAIN_RELS, enc.encode(now.slice(0, end) + this.relAdds.join("") + now.slice(end)));
    }
    if (this.ctChanged) {
      let now = cur("[Content_Types].xml");
      for (const a of this.ctAdds) {
        if (new RegExp(`<Default\\b[^>]*Extension="${a.ext}"`, "i").test(now)) continue;
        const at = now.indexOf("<Default");
        now = at >= 0 ? now.slice(0, at) + a.xml + now.slice(at) : now.replace("</Types>", a.xml + "</Types>");
      }
      changed.set("[Content_Types].xml", enc.encode(now));
    }
  }
}

/**
 * The body with new w:pgSz / w:pgMar in the sections whose setup changed (by their w:sectPr in document order); every
 * other part of every w:sectPr (header / footer references, columns, grid…) stays as it was.
 */
function patchSectPrs(bodyXml: string, origBody: string, setups: Map<number, PageSetup>, sections: OfficeLayout["sections"]): string {
  if (bodyXml.includes("sectPrChange")) throw new SurgeryUnavailable("tracked section change");
  const found = [...bodyXml.matchAll(SECTPR)];
  if (found.length !== [...origBody.matchAll(SECTPR)].length) throw new SurgeryUnavailable("section settings");
  const bySrc = new Map<number, PageSetup>();
  for (const [j, s] of setups) {
    const src = sections[j]?.src;
    if (src === undefined || src >= found.length) throw new SurgeryUnavailable("section settings");
    bySrc.set(src, s);
  }
  const origOf = new Map<number, PageSetup>();
  for (const sec of sections) if (sec.src !== undefined) origOf.set(sec.src, sec.setup);
  let out = "", last = 0;
  found.forEach((m, i) => {
    const s = bySrc.get(i);
    if (!s) return;
    let x = sectPrWithPage(m[0], s);
    // 단 changed: only the w:cols (Word's own form), in CT_SectPr order after w:pgNumType
    if (!sameColumns(origOf.get(i)?.columns, s.columns)) x = sectPrWithCols(x, s);
    out += bodyXml.slice(last, m.index) + x;
    last = m.index! + m[0].length;
  });
  return out + bodyXml.slice(last);
}

/** A copy of a section's w:sectPr ending a section added here: next page, its own paper / margins (and columns). */
function newSectPr(base: string, s: PageSetup, was: PageSetup | undefined): string {
  let x = sectPrWithPage(base.replace(/<w:type\b[^>]*\/>/, "").replace(/\s+w:rsid\w*="[^"]*"/g, ""), s);
  if (!sameColumns(was?.columns, s.columns)) x = sectPrWithCols(x, s);
  // w:type (nextPage) before w:pgSz: CT_SectPr order headerReference / footerReference, footnotePr, endnotePr, type, pgSz
  return x.replace(/<w:pgSz\b/, '<w:type w:val="nextPage"/><w:pgSz');
}

function sectPrWithCols(sect: string, s: PageSetup): string {
  const x = sect.replace(/<w:cols\b[^>]*?(?:\/>|>[\s\S]*?<\/w:cols>)/, "");
  let at = -1;
  for (const n of ["formProt", "vAlign", "noEndnote", "titlePg", "textDirection", "bidi", "rtlGutter", "docGrid", "printerSettings"]) {
    const m = new RegExp(`<w:${n}\\b`).exec(x);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  if (at < 0) at = x.lastIndexOf("</w:sectPr>");
  if (at < 0) throw new SurgeryUnavailable("section settings");
  return x.slice(0, at) + docxColsXml(s.columns) + x.slice(at);
}

/** A w:sectPr with new paper size and margins, in CT_SectPr order (after the header / footer references, notes and type). */
function sectPrWithPage(sect: string, s: PageSetup): string {
  if (sect.endsWith("/>")) return sect.slice(0, -2) + ">" + docxPageXml(s) + "</w:sectPr>";
  // (the page border comes with them: docxPageXml)
  const x = sect.replace(/<w:pgSz\b[^>]*\/>/, "").replace(/<w:pgMar\b[^>]*\/>/, "").replace(/<w:pgBorders\b[\s\S]*?<\/w:pgBorders>|<w:pgBorders\b[^>]*\/>/, "");
  let at = x.indexOf(">") + 1;
  for (const m of x.matchAll(/<w:(headerReference|footerReference|footnotePr|endnotePr|type)\b[^>]*?(?:\/>|>[\s\S]*?<\/w:\1>)/g)) at = Math.max(at, m.index! + m[0].length);
  return x.slice(0, at) + docxPageXml(s) + x.slice(at);
}

/**
 * A copy of w:abstractNum `id` of numbering.xml `s` under `newId`, the levels where `def` differs from `was` (the
 * definition as read) written with its number format, text and start. Its identity goes (w:nsid, w:tmpl, w:styleLink:
 * the copy is another list, not the original's style). Null when there is no such element or its levels come from a
 * numbering style (w:numStyleLink).
 */
export function cloneAbstractNum(s: string, id: string, newId: string, was: ListDef, def: ListDef): string | null {
  const x = new RegExp(`<w:abstractNum\\b[^>]*\\bw:abstractNumId="${id}"[^>]*>[\\s\\S]*?</w:abstractNum>`).exec(s)?.[0];
  if (!x || /<w:numStyleLink\b/.test(x)) return null;
  const val = (v: string) => esc(v);
  let out = x.replace(/^(<w:abstractNum\b[^>]*\bw:abstractNumId=")[^"]*"/, `$1${newId}"`).replace(/<w:(nsid|tmpl|styleLink)\b[^>]*\/>/g, "");
  const done = new Set<number>();
  out = out.replace(/<w:lvl\b([^>]*)>([\s\S]*?)<\/w:lvl>/g, (all, attrs: string, body: string) => {
    const k = Number(/\bw:ilvl="(\d+)"/.exec(attrs)?.[1]);
    if (!Number.isFinite(k) || k >= MAX_LEVELS) return all;
    done.add(k);
    const a = levelOf(was, k), b = levelOf(def, k);
    const sameMark = a.format === b.format && a.text === b.text;
    if (sameMark && (a.start ?? 1) === (b.start ?? 1)) return all;
    let y = body;
    const put = (tag: string, v: string, after: string[]) => {
      const el = `<w:${tag} w:val="${val(v)}"/>`;
      if (new RegExp(`<w:${tag}\\b[^>]*/>`).test(y)) y = y.replace(new RegExp(`<w:${tag}\\b[^>]*/>`), el);
      else {
        // CT_Lvl order: start numFmt lvlRestart pStyle isLgl suff lvlText lvlPicBulletId legacy lvlJc pPr rPr
        const at = after.map((t) => y.search(new RegExp(`<w:${t}\\b`))).find((i) => i >= 0) ?? y.length;
        y = y.slice(0, at) + el + y.slice(at);
      }
    };
    put("start", String(b.start ?? 1), ["numFmt", "lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr"]);
    if (!sameMark) {
      put("numFmt", docxNumFmt(b.format), ["lvlRestart", "pStyle", "isLgl", "suff", "lvlText", "lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr"]);
      put("lvlText", b.text, ["lvlPicBulletId", "legacy", "lvlJc", "pPr", "rPr"]);
      // a symbol font (Symbol, Wingdings) or picture of the old mark would draw the new one wrongly
      y = y.replace(/<w:lvlPicBulletId\b[^>]*\/>/g, "").replace(/(<w:rPr>[\s\S]*?)<w:rFonts\b[^>]*\/>/, "$1");
    }
    return `<w:lvl${attrs}>${y}</w:lvl>`;
  });
  // levels the element does not have (fewer than nine) are not added: a level of them that changed needs the new one
  for (let k = 0; k < MAX_LEVELS; k++) if (!done.has(k) && listDefKey({ ...was, levels: [levelOf(was, k)] }) !== listDefKey({ ...was, levels: [levelOf(def, k)] })) return null;
  return out;
}

/** Register a numbering.xml the original did not have: content type override and document relationship. */
function addNumberingPart(zip: ZipArchive, changed: Map<string, Uint8Array>) {
  const read = (name: string) => {
    // (what an earlier stage wrote first: a new header's relationship must not be dropped)
    const c = changed.get(name);
    if (c) return strFromU8(c);
    const e = zip.entries.find((x) => x.name === name);
    if (!e) throw new SurgeryUnavailable(name);
    return strFromU8(entryData(zip, e));
  };
  let ct = read("[Content_Types].xml");
  if (!ct.includes('PartName="/word/numbering.xml"')) {
    const end = ct.lastIndexOf("</Types>");
    if (end < 0) throw new SurgeryUnavailable("types");
    ct = ct.slice(0, end) + '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' + ct.slice(end);
    changed.set("[Content_Types].xml", new TextEncoder().encode(ct));
  }
  let rels = read(MAIN_RELS);
  if (!/relationships\/numbering"/.test(rels)) {
    const end = rels.lastIndexOf("</Relationships>");
    if (end < 0) throw new SurgeryUnavailable("rels");
    let id = "rIdOmwNumbering";
    while (rels.includes(`Id="${id}"`)) id += "1";
    rels = rels.slice(0, end) + `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>` + rels.slice(end);
    changed.set(MAIN_RELS, new TextEncoder().encode(rels));
  }
}

/** One original run of a paragraph: its character format, w:rPr text and place in the paragraph text. */
interface OrigRun {
  key: string;
  rPr: string;
  start: number;
  end: number;
}

/** Writes changed / new body elements against one original document. */
class DocxWriter {
  private ctx: DocxCtx;
  private dom: Element[] | null = null;
  /** w:numId last seen per list kind (new list paragraphs continue the list before them) */
  private lastNum: Record<"li" | "oli", string | null> = { li: null, oli: null };
  /** numbering.xml rewritten with an added list definition, if one was needed (created: the original had none) */
  numberingXml: string | null = null;
  numberingCreated = false;
  /** heading levels written with Word's built-in style the file does not define yet (added to styles.xml) */
  addedHeadings = new Set<number>();
  private moved = 0;
  private tracked = 0;
  /** the map keeps the notes (model 7): note references are written from the model, not copied from the original */
  notesTracked = false;
  private rebuilt = 0;
  /** tables nested in cells of a rebuilt table that found no place in it (written as plain paragraphs) */
  private nestedLost = 0;
  private controls = 0;
  /** comments are written from the model (model 9 on): the file's ids, the comments around each paragraph */
  review: DocxCommentIds | null = null;

  constructor(
    private zip: ZipArchive,
    private xml: string,
    private els: XmlEl[],
    /** model version of the map: an older one is compared against the original read in its older shape (common.ts) */
    private model = MODEL_VERSION,
    /** list definitions of the pages (multi-level lists) */
    private defs: ListDef[] = [],
    /** list paragraphs written with numbering of their own (common.ts relistPlan) */
    private relist: RelistPlan = { at: new Map(), unsafe: null },
    /** the file's list definitions the pages hold otherwise now */
    private changedDefs: ReadonlySet<string> = new Set(),
  ) {
    const files: Record<string, Uint8Array> = {};
    for (const e of zip.entries) if (e.name === "word/styles.xml" || e.name === NUMBERING || /^word\/theme\/[^/]+\.xml$/.test(e.name)) files[e.name] = entryData(zip, e);
    // a map before model 3 was made by the importer before theme fonts and Word's 10 pt default: the original is read
    // as that importer read it, so the runs of an edited paragraph still match their original w:rPr
    this.ctx = docxContext(files, model < MODEL_WORD_MULTIPLE, model < MODEL_HEADING_STYLES, model < MODEL_WORD_STYLES);
    // a map from model 9 on: the original is read with its tracked changes and comment ranges, as the importer did
    if (model >= MODEL_REVIEW) this.ctx.review = { open: new Set() };
    if (model < MODEL_PARA_STYLES) this.ctx.noParaStyle = true;
    this.files = files;
  }
  private files: Record<string, Uint8Array>;
  /** the document's style sheet when a style was changed or made here (core/docStyles.ts); null otherwise */
  sheet: DocStyle[] | null = null;
  private origSheetMemo: DocStyle[] | null = null;
  /** the original file's styles (styles.xml as it was) */
  private origSheet(): DocStyle[] {
    return (this.origSheetMemo ??= docxStyleSheet(this.files, { ...this.ctx, review: undefined }));
  }
  /** the map is older than model version 2 (no optional paragraph fields) */
  private get legacyModel() {
    return this.model < MODEL_OPTIONAL_FIELDS;
  }

  /** element text with picture edits (pics.ts), by element start; "" = the element goes */
  patched = new Map<number, string>();
  text = (el: XmlEl) => this.patched.get(el.start) ?? this.xml.slice(el.start, el.end);

  /** The DOM element of top-level block `b` (the document is parsed once, on first need). */
  domOf(b: number): Element {
    if (!this.dom) {
      const doc = parseXml(this.xml);
      const body = descendants(doc, "body")[0] ?? doc.documentElement;
      this.dom = children(body);
      if (this.dom.length !== this.els.length) throw new SurgeryUnavailable("dom");
    }
    return this.dom[b];
  }

  warnings(): string[] {
    const w: string[] = [];
    if (this.moved) w.push(tn("engine.officeSurgeon.inlineMoved", this.moved));
    if (this.tracked) w.push(tn("engine.officeSurgeon.tracked", this.tracked));
    if (this.rebuilt) w.push(tn("engine.officeSurgeon.tableRebuilt", this.rebuilt));
    if (this.nestedLost) w.push(tn("engine.officeSurgeon.nestedLost", this.nestedLost));
    if (this.controls) w.push(tn("engine.officeSurgeon.controlDropped", this.controls));
    return w;
  }

  /** A block holding several items (a content control) is written as plain paragraphs. */
  controlDropped(el: XmlEl) {
    if (el.local !== "p" && el.local !== "tbl") this.controls++;
  }

  // ── lists ──

  /** Remember the list of an original paragraph that is written as it was (new items after it continue it). */
  noteLists(el: XmlEl) {
    if (el.local !== "p") return;
    const pPr = childNamed(this.xml, el, "pPr");
    this.noteListsOf(pPr ? this.text(pPr) : "");
  }

  /**
   * Follow the list of a written paragraph from its w:pPr (own numPr, else its style's): new items continue the
   * list just before them; a paragraph outside a list ends a numbered list, so a numbered item added after it
   * starts a list of its own at 1 (as Omniweave numbers it).
   */
  private noteListsOf(pPr: string) {
    const own = /<w:numId w:val="([^"]+)"/.exec(pPr)?.[1];
    const style = /<w:pStyle w:val="([^"]+)"/.exec(pPr)?.[1];
    const numId = own ?? (style ? this.ctx.styleNum.get(style)?.numId : undefined);
    if (!numId || numId === "0") {
      this.lastNum.oli = null;
      return;
    }
    this.lastNum[this.ctx.numbering.get(numId)?.get(0)?.bullet ?? true ? "li" : "oli"] = numId;
  }

  /** w:numId for a list paragraph of `kind` without one of its own. */
  private numFor(kind: "li" | "oli"): string {
    const last = this.lastNum[kind];
    if (last) return last;
    for (const [id, lv] of this.ctx.numbering)
      if (id !== "0" && (lv.get(0)?.bullet ?? true) === (kind === "li")) return (this.lastNum[kind] = kind === "oli" ? this.restart(id) : id);
    return (this.lastNum[kind] = this.addNumbering(kind));
  }

  /** A new w:num on the list definition of `numId`, starting at 1 (a numbered list of its own). */
  private restart(numId: string): string {
    const entry = this.zip.entries.find((e) => e.name === NUMBERING);
    let s = this.numberingXml ?? (entry ? strFromU8(entryData(this.zip, entry)) : null);
    if (s == null) return numId;
    const cur = s;
    const abs = new RegExp(`<w:num\\b[^>]*w:numId="${numId}"[^>]*>\\s*<w:abstractNumId w:val="(\\d+)"`).exec(cur)?.[1];
    const end = s.lastIndexOf("</w:numbering>");
    if (abs == null || end < 0) return numId;
    const num = Math.max(0, ...Array.from(cur.matchAll(/<w:num\b[^>]*w:numId="(\d+)"/g), (m) => Number(m[1]) || 0)) + 1;
    s = s.slice(0, end) + `<w:num w:numId="${num}"><w:abstractNumId w:val="${abs}"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>` + s.slice(end);
    this.numberingXml = s;
    this.ctx.numbering.set(String(num), this.ctx.numbering.get(numId)!);
    return String(num);
  }

  /** Append a one-level list definition to numbering.xml (made when the original has none); its new w:numId. */
  private addNumbering(kind: "li" | "oli"): string {
    const entry = this.zip.entries.find((e) => e.name === NUMBERING);
    let s = this.numberingXml ?? (entry ? strFromU8(entryData(this.zip, entry)) : null);
    if (s == null) {
      s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>';
      this.numberingCreated = true;
    }
    const cur = s;
    const maxOf = (re: RegExp) => Math.max(0, ...Array.from(cur.matchAll(re), (m) => Number(m[1]) || 0));
    const abs = maxOf(/w:abstractNumId="(\d+)"/g) + 1;
    const num = maxOf(/<w:num\b[^>]*w:numId="(\d+)"/g) + 1;
    const lvl = kind === "li" ? `<w:numFmt w:val="bullet"/><w:lvlText w:val="•"/>` : `<w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>`;
    const absXml = `<w:abstractNum w:abstractNumId="${abs}"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/>${lvl}<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>`;
    const numXml = `<w:num w:numId="${num}"><w:abstractNumId w:val="${abs}"/></w:num>`;
    // schema order: every w:abstractNum before the first w:num
    const firstNum = s.search(/<w:num[\s>]/);
    const end = s.lastIndexOf("</w:numbering>");
    if (end < 0) throw new SurgeryUnavailable("numbering");
    s = firstNum >= 0 ? s.slice(0, firstNum) + absXml + s.slice(firstNum, end) + numXml + s.slice(end) : s.slice(0, end) + absXml + numXml + s.slice(end);
    this.numberingXml = s;
    this.ctx.numbering.set(String(num), new Map([[0, { bullet: kind === "li", left: 720, hanging: 360 }]]));
    return String(num);
  }

  /** w:num per multi-level list instance written so far (list id → numId) */
  private mlNum = new Map<string, string>();
  /** w:num per list segment written with numbering of its own */
  private segNum = new Map<ListSegment, string>();
  /** w:abstractNumId per list definition appended so far (definition id → abstractNumId) */
  private mlAbs = new Map<string, string>();

  /**
   * w:numPr of a multi-level list paragraph. A list read from this document keeps its w:numId (a restart gets a new
   * w:num with a start override); a list made in Omniweave gets its definition appended to numbering.xml (every
   * w:abstractNum before the first w:num, w:numIdMacAtCleanup last — CT_Numbering order) and one w:num per list.
   */
  private numPrForList(l: NonNullable<TextParagraph["list"]>, seg?: ListSegment): string {
    const own = /^docx-n(\d+)$/.exec(l.id)?.[1];
    // the file's numbering holds (its definition and start numbers unchanged): its w:num, at the item's level
    if (!seg && own && this.ctx.numbering.has(own)) return docxNumPr(own, l.level);
    let num = seg ? this.segNum.get(seg) : l.start == null ? this.mlNum.get(l.id) : undefined;
    if (!num) {
      const def = resolveDef(l.def, this.defs);
      // a definition of the file still as it was is used again; a changed one is appended (the original stays for
      // the paragraphs and styles that use it)
      const absOwn = /^docx-a(\d+)$/.exec(def.id)?.[1];
      let abs = absOwn && this.ctx.listDefs?.has(absOwn) && !this.changedDefs.has(def.id) ? absOwn : this.mlAbs.get(def.id);
      let s = this.numberingSource();
      const maxOf = (re: RegExp) => Math.max(0, ...Array.from(s.matchAll(re), (m) => Number(m[1]) || 0));
      if (abs == null) {
        abs = String(maxOf(/w:abstractNumId="(\d+)"/g) + 1);
        // a changed definition of the file: a copy of its w:abstractNum with only the changed levels written anew
        // (alignment, suffix, fonts and indents of the others as Word wrote them)
        const was = absOwn ? this.ctx.listDefs?.get(absOwn) : undefined;
        const absXml = (was && cloneAbstractNum(s, absOwn!, abs, was, def)) || docxAbstractNum(Number(abs), def);
        const firstNum = s.search(/<w:num[\s>]/);
        const at = firstNum >= 0 ? firstNum : this.numberingEnd(s);
        s = s.slice(0, at) + absXml + s.slice(at);
        this.mlAbs.set(def.id, abs);
      }
      num = String(maxOf(/<w:num\b[^>]*w:numId="(\d+)"/g) + 1);
      const starts = seg ? [...seg.starts].sort((a, b) => a[0] - b[0]) : l.start != null ? [[l.level, l.start]] : [];
      const override = starts.map(([lv, st]) => `<w:lvlOverride w:ilvl="${lv}"><w:startOverride w:val="${st}"/></w:lvlOverride>`).join("");
      const end = this.numberingEnd(s);
      s = s.slice(0, end) + `<w:num w:numId="${num}"><w:abstractNumId w:val="${abs}"/>${override}</w:num>` + s.slice(end);
      this.numberingXml = s;
      this.ctx.numbering.set(num, new Map(def.levels.map((lv, i) => [i, { bullet: lv.format === "bullet", left: 0, hanging: 0 }])));
      if (seg) this.segNum.set(seg, num);
    }
    if (!seg) this.mlNum.set(l.id, num);
    return docxNumPr(num, l.level);
  }

  /** numbering.xml as written so far (an empty one when the original has none). */
  private numberingSource(): string {
    const entry = this.zip.entries.find((e) => e.name === NUMBERING);
    const s = this.numberingXml ?? (entry ? strFromU8(entryData(this.zip, entry)) : null);
    if (s != null) return s;
    this.numberingCreated = true;
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:numbering>';
  }

  /** Where a new w:num goes: before w:numIdMacAtCleanup (last in CT_Numbering), else before the end tag. */
  private numberingEnd(s: string): number {
    const mac = s.search(/<w:numIdMacAtCleanup[\s/>]/);
    const end = s.lastIndexOf("</w:numbering>");
    if (end < 0) throw new SurgeryUnavailable("numbering");
    return mac >= 0 ? mac : end;
  }

  // ── paragraphs ──

  private headingStyle(level: number): string {
    for (const [id, l] of this.ctx.headings) if (l === level) return `<w:pStyle w:val="${id.replace(/"/g, "&quot;")}"/>`;
    // a heading made here in a file without that heading style: Word's built-in "heading N", as Word adds it when the
    // style is first applied (QA 11-25 real use: Ctrl+Alt+1 in a Word file saved a paragraph with no heading style)
    this.addedHeadings.add(level);
    return `<w:pStyle w:val="Heading${level}"/>`;
  }

  /** A paragraph that has no original element. */
  freshPara(p: TextParagraph): string {
    const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
    const list = isListRole(p) ? (p.role as "li" | "oli") : null;
    if (!list) this.lastNum.oli = null; // a paragraph outside a list ends a numbered list
    const numPr = p.list ? this.numPrForList(p.list, this.relist.at.get(p)) : list ? docxNumPr(this.numFor(list)) : "";
    const runs = docxBodyRuns(p, !!list || !!p.list);
    // comments and the paragraph mark's tracked change (a new paragraph has no move range: moves as deletion / insertion)
    const pPr = docxPPr(p, p.style && !this.ctx.noParaStyle ? styleTag(p.style) : level ? this.headingStyle(Number(level)) : "", numPr);
    const cb = (at: "before" | "after") => (p.colBreak === at ? DOCX_COL_BREAK : "");
    return `<w:p>${this.review ? docxPPrReview(pPr, p, false) : pPr}${cb("before")}${runsXml(runs, [], this.review ? docxCommentMarks(p, runs, this.review) : [])}${cb("after")}</w:p>`;
  }

  /** A changed paragraph written into its original element (`el` in the text, `dom` the same element parsed). */
  rewritePara(p: TextParagraph, el: XmlEl, dom: Element): string {
    const s = this.xml;
    const fmts: (TextRun | null)[] = [];
    const read = docxParagraph(dom, this.ctx, fmts);
    // a column break added / removed: the paragraph is written anew (the original's break run cannot be placed)
    if ((read.para.colBreak ?? "") !== (p.colBreak ?? "")) return this.freshPara(p);
    const pre = this.model < MODEL_WORD_MULTIPLE ? preWordMultipleView(read.para, p) : read.para;
    const origPara = this.legacyModel ? legacyParaView(pre) : pre;
    const origList = read.list;
    if (this.legacyModel) fmts.forEach((f, i) => f && (fmts[i] = legacyRunView(f)));
    const list = isListRole(p) ? (p.role as "li" | "oli") : null;
    const origRole = origList ?? origPara.role;
    // (the original read without its notes: the same text with other note references is not unchanged)
    const refIds = (x: string) => Array.from(x.matchAll(/<w:(foot|end)noteReference\b[^>]*\bw:id="([^"]*)"/g), (m) => `${m[1]}:${m[2]}`).join(",");
    const sameNotes = !this.notesTracked || refIds(s.slice(el.start, el.end)) === p.runs.filter((r) => r.note).map((r) => `${r.note!.kind}:${docxNoteId(r.note!) ?? ""}`).join(",");
    // numbering taken off a paragraph of a multi-level list (a numbered heading keeps its role): not unchanged, though
    // the original is read here without its list and number (QA hwpx-numbering 2026-11-16 — the number came back)
    const listOff = !!read.plist && !p.list;
    // numbering of its own (a changed format / start number: relistPlan) — not unchanged, its w:numPr written anew
    const seg = this.relist.at.get(p);
    if (sameNotes && !listOff && !seg && paraFp(p) === paraFp({ ...origPara, role: origRole })) {
      this.noteLists(el);
      return this.text(el); // unchanged (e.g. an untouched paragraph of a changed table cell)
    }
    // changed only as its style changed (core/docStyles.ts): the original element — its style in styles.xml is
    // written anew, and Word draws the paragraph from it (no direct formatting copied into the paragraph)
    if (this.sheet && sameNotes && !listOff && !seg) {
      const ex = restyleParas([{ ...origPara, role: origRole }], this.origSheet(), this.sheet)[0];
      if (paraFp(p) === paraFp(ex)) {
        this.noteLists(el);
        return this.text(el);
      }
    }
    // only the numbering changed (its format / start: numbering of its own), the item at its level and the text as they
    // were: the original element with its w:numPr changed — Word's runs and w:pPr stay (QA list-format)
    // (the original is read without its list and number: its format compared without the list, its runs as they are)
    const was = { ...origPara, role: origRole };
    if (sameNotes && seg && read.plist?.level === p.list!.level && paraPropsKey({ ...p, list: undefined }) === paraPropsKey({ ...was, list: undefined }) && paraReviewKey(p) === paraReviewKey(was) && JSON.stringify(normalRuns(p)) === JSON.stringify(normalRuns(was))) {
      const x = this.text(el);
      const pPrEnd = x.indexOf("</w:pPr>");
      const np = /<w:numPr>[\s\S]*?<\/w:numPr>/.exec(x);
      if (np && pPrEnd > np.index) {
        const out = x.slice(0, np.index) + this.numPrForList(p.list!, seg) + x.slice(np.index + np[0].length);
        this.noteListsOf(/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(out)?.[0] ?? "");
        return out;
      }
    }
    const runEls = descendantsNamed(s, el, "r");
    const aligned = runEls.length === fmts.length;
    // original runs with their place in the paragraph text
    const orig: OrigRun[] = [];
    const runAt = new Map<XmlEl, { start: number; end: number }>();
    let o = 0;
    runEls.forEach((r, i) => {
      const f = aligned ? fmts[i] : null;
      const len = f?.text.length ?? 0;
      runAt.set(r, { start: o, end: o + len });
      if (f) {
        const rp = childNamed(s, r, "rPr");
        orig.push({ key: lookKey(f), rPr: rp ? s.slice(rp.start, rp.end) : "", start: o, end: o + len });
      }
      o += len;
    });
    const origText = aligned ? fmts.map((f) => f?.text ?? "").join("") : "";
    // note references (a map that keeps the notes): written from the model where they are now — the original run while
    // it is the same note — and never copied from the original as content without text
    const runs = this.notesTracked ? markedBodyRuns(p).map((r) => (r.note ? { ...r, text: "" } : r)) : markedBodyRuns(p);
    const isRef = (r: XmlEl) => childrenOf(s, r).some((c) => c.local === "footnoteReference" || c.local === "endnoteReference");
    const noteOrig = new Map<string, string>();
    if (this.notesTracked)
      for (const r of runEls)
        if (isRef(r)) {
          const x = s.slice(r.start, r.end);
          const m = /<w:(foot|end)noteReference\b[^>]*\bw:id="([^"]*)"/.exec(x);
          if (m && !/customMarkFollows/.test(x)) noteOrig.set(`${m[1]}:${m[2]}`, x);
        }
    const newText = runs.map((r) => r.text).join("");

    // paragraph content written back as the original elements while its text is unchanged: hyperlinks, equations,
    // simple fields, inline controls, complex fields, text boxes (a picture run with text inside), page / column breaks
    const kids = childrenOf(s, el);
    const textIn = (a: number, b: number) => (aligned ? runEls.filter((r) => r.start >= a && r.end <= b).map((r) => fmts[runEls.indexOf(r)]?.text ?? "").join("") : "");
    const keysIn = (a: number, b: number) => new Set(runEls.filter((r) => r.start >= a && r.end <= b && fmts[runEls.indexOf(r)]?.text).map((r) => revLookKey(fmts[runEls.indexOf(r)]!)));
    /** paragraph-text offset of the content starting at XML index `a` */
    const offsetAt = (a: number) => {
      let off = 0;
      for (const r of runEls) if (r.end <= a) off = runAt.get(r)!.end;
      return off;
    };
    const hasKeep = (r: XmlEl) => childrenOf(s, r).some((c) => KEEP_IN_RUN.has(c.local));
    const pageBreak = (r: XmlEl) => childrenOf(s, r).some((c) => c.local === "br" && /w:type="(page|column)"/.test(s.slice(c.start, c.end)));
    const groups: { start: number; end: number; xml: string }[] = [];
    const lone: XmlEl[] = []; // field runs whose field starts or ends in another paragraph
    let field: XmlEl | null = null;
    let fieldRuns: XmlEl[] = [];
    let depth = 0;
    for (const c of kids) {
      if (INLINE_KEEP.has(c.local)) {
        groups.push({ start: c.start, end: c.end, xml: s.slice(c.start, c.end) });
        continue;
      }
      if (c.local !== "r") continue;
      const fcs = descendantsNamed(s, c, "fldChar").map((fc) => /w:fldCharType="(\w+)"/.exec(s.slice(fc.start, fc.end))?.[1]);
      if (depth || fcs.length || descendantsNamed(s, c, "instrText").length) fieldRuns.push(c);
      for (const ty of fcs) {
        if (ty === "begin") {
          if (!depth++) field = c;
        } else if (ty === "end") {
          if (depth && !--depth && field) {
            groups.push({ start: field.start, end: c.end, xml: s.slice(field.start, c.end) });
            fieldRuns = [];
            field = null;
          } else if (!depth) lone.push(c); // the end of a field begun in an earlier paragraph
        }
      }
      if (!depth && !fcs.length && fieldRuns.includes(c)) lone.push(c); // field code continued from an earlier paragraph
      if (!depth && !fieldRuns.includes(c) && ((hasKeep(c) && textIn(c.start, c.end)) || pageBreak(c))) groups.push({ start: c.start, end: c.end, xml: s.slice(c.start, c.end) });
    }
    if (depth) lone.push(...fieldRuns); // a field that goes on into the next paragraph
    groups.sort((a, b) => a.start - b.start);
    const inGroup = (r: XmlEl) => groups.some((g) => r.start >= g.start && r.end <= g.end);
    // where each new run starts, to check that text written back as an original element kept its format
    const newSpans: { start: number; end: number; key: string }[] = [];
    let q = 0;
    for (const r of runs) newSpans.push({ start: q, end: (q += r.text.length), key: revLookKey(r) });
    const sameLook = (at: number, len: number, keys: Set<string>) => newSpans.every((n) => n.end <= at || n.start >= at + len || n.start === n.end || keys.has(n.key));
    const inserts: Insert[] = [];
    let lost = false;
    let cursor = 0;
    for (const g of groups) {
      const gt = textIn(g.start, g.end);
      const from = offsetAt(g.start);
      const near = anchorAt(origText, newText, from, cursor);
      if (!gt) {
        // no text of its own (an empty field, a picture in a control): after the text that preceded it
        if (near < 0) lost = true;
        inserts.push({ pos: near < 0 ? newText.length : near, len: 0, xml: g.xml });
        continue;
      }
      let at = near >= 0 && newText.startsWith(gt, near) ? near : newText.indexOf(gt, near >= 0 ? near : cursor);
      if (at < 0) at = newText.indexOf(gt, cursor);
      if (at < 0 || !sameLook(at, gt.length, keysIn(g.start, g.end))) {
        lost = true; // its text or look was edited: the edited text is written as plain runs
        continue;
      }
      inserts.push({ pos: at, len: gt.length, xml: g.xml });
      cursor = at + gt.length;
    }
    // pictures / note references / field parts of other paragraphs: after the text they followed (a comment's reference
    // run is written from the model, model 9 on)
    const review = this.model >= MODEL_REVIEW && this.review ? this.review : null;
    const commentRef = (r: XmlEl) => !!review && childrenOf(s, r).some((c) => c.local === "commentReference");
    const zero = [...runEls.filter((r) => !inGroup(r) && !lone.some((l) => l.start === r.start) && hasKeep(r) && kids.some((k) => k.start === r.start) && !(this.notesTracked && isRef(r)) && !commentRef(r)), ...lone].sort((a, b) => a.start - b.start);
    for (const r of zero) {
      const at = anchorAt(origText, newText, offsetAt(r.start), 0);
      if (at < 0) lost = true;
      inserts.push({ pos: at < 0 ? newText.length : at, len: 0, xml: s.slice(r.start, r.end) });
    }
    if (lost) this.moved++;
    // tracked changes of a rewritten paragraph: from model 9 its insertions and deletions are written again (runsXml),
    // only moves turn into the insertion / deletion they show; before, all of them came out accepted
    // (stage 2: a paragraph of the original's move writes its moved text as w:moveFrom / w:moveTo again, inside the
    // move's range marks that stay)
    const moves = !!review && (descendantsNamed(s, el, "moveFrom").length > 0 || descendantsNamed(s, el, "moveTo").length > 0 || kids.some((c) => /^move(From|To)Range/.test(c.local)));
    const trackedKinds = review ? [] : this.model >= MODEL_REVIEW ? ["moveFrom", "moveTo"] : ["ins", "del", "moveFrom", "moveTo"];
    if (kids.some((c) => trackedKinds.includes(c.local) && !inGroup(c))) this.tracked++;

    // w:pPr: the original while the paragraph format is unchanged, else new with the original style / list / unmodelled settings
    const pPrEl = childNamed(s, el, "pPr");
    let pPr: string;
    // only the numbering is its own (a changed format / start, the same item at the same level): the original w:pPr
    // with its w:numPr changed — the style, indents and fonts Word wrote stay, not resolved into direct formatting
    // (QA list-format; the original is read without its list)
    const npEl = seg && pPrEl ? childrenOf(s, pPrEl).find((c) => c.local === "numPr") : undefined;
    const onlyNumbering = !!npEl && !!read.plist && read.plist.level === p.list!.level && paraPropsKey({ ...p, list: undefined }) === paraPropsKey({ ...origPara, role: origRole, list: undefined });
    if (!listOff && !seg && paraPropsKey(p) === paraPropsKey({ ...origPara, role: origRole })) pPr = pPrEl ? s.slice(pPrEl.start, pPrEl.end) : "";
    else if (onlyNumbering) pPr = s.slice(pPrEl!.start, npEl!.start) + this.numPrForList(p.list!, seg) + s.slice(npEl!.end, pPrEl!.end);
    else {
      const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
      const pk = pPrEl ? childrenOf(s, pPrEl) : [];
      const pick = (set: Set<string>) => pk.filter((c) => set.has(c.local)).map((c) => s.slice(c.start, c.end)).join("");
      const ps = pk.find((c) => c.local === "pStyle");
      const origHeading = !!origPara.role && /^h\d$/.test(origPara.role);
      // another named style (model 10, core/docStyles.ts): its w:pStyle (none: the default style, or a heading's)
      const restyled = !this.ctx.noParaStyle && (p.style ?? "") !== (origPara.style ?? "");
      const pStyle = restyled ? (p.style ? styleTag(p.style) : level ? this.headingStyle(Number(level)) : "") : level ? (origHeading && origPara.role === p.role && ps ? s.slice(ps.start, ps.end) : this.headingStyle(Number(level))) : ps && !origHeading ? s.slice(ps.start, ps.end) : "";
      const np = pk.find((c) => c.local === "numPr");
      const sameList = !seg && !!p.list && !!read.plist && read.plist.id === p.list.id && read.plist.level === p.list.level;
      const numPr = p.list
        ? sameList && np
          ? s.slice(np.start, np.end)
          : this.numPrForList(p.list, seg)
        : list
          ? origList === list && np && !read.plist
            ? s.slice(np.start, np.end)
            : docxNumPr(this.numFor(list))
          : listOff
            ? docxNumPr(0) // w:numId 0: no numbering, also over a style's (styles.xml w:numPr — Word writes the same)
            : "";
      const gen = docxPPr(p, pStyle, numPr);
      // <w:pPr>{pStyle}{head}{numPr}{mid}<w:spacing……{tail}</w:pPr>; keepNext / keepLines / pageBreakBefore come from
      // the model (an older map: the original's, as before)
      const sp = gen.indexOf("<w:spacing");
      const head = this.legacyModel ? pick(PPR_HEAD) : docxPPrHead(p) + pick(PPR_HEAD_UNMODELLED);
      pPr = `<w:pPr>${pStyle}${head}${numPr}${pick(PPR_MID)}${gen.slice(sp, -"</w:pPr>".length)}${pick(PPR_TAIL)}</w:pPr>`;
    }
    if (list) {
      const np = /<w:numId w:val="([^"]+)"/.exec(pPr);
      if (np) this.lastNum[list] = np[1];
    } else this.noteListsOf(pPr);
    // range marks stay (at the paragraph start); from model 9 a comment's range marks go where their text went, so an
    // edit elsewhere in the paragraph keeps the comment on its words (also marks inside an insertion / deletion)
    const commentMark = (c: XmlEl) => c.local === "commentRangeStart" || c.local === "commentRangeEnd";
    const placed = new Set<XmlEl>();
    if (review) {
      // stage 2: the comment marks come from the model's runs (comments added, deleted, their text edited), and the
      // paragraph mark's tracked change from the paragraph
      for (const x of docxCommentMarks(p, runs, review)) inserts.push(x);
      pPr = docxPPrReview(pPr, p, moves);
    } else if (this.model >= MODEL_REVIEW && aligned)
      for (const c of descendantsNamed(s, el, "commentRangeStart").concat(descendantsNamed(s, el, "commentRangeEnd"))) {
        if (inGroup(c)) continue;
        const at = anchorAt(origText, newText, offsetAt(c.start), 0);
        if (at < 0) continue;
        inserts.push({ pos: at, len: 0, xml: s.slice(c.start, c.end) });
        placed.add(c);
      }
    // (model 10: a bookmark the model has on this paragraph's text is written from the model, around its runs)
    const bmNames = new Set(this.ctx.noParaStyle ? [] : p.runs.flatMap((r) => r.bookmarks ?? []));
    const bmIdsHere = new Set<string>();
    for (const c of kids)
      if (c.local === "bookmarkStart" && bmNames.has(/\bw:name="([^"]*)"/.exec(s.slice(c.start, c.end))?.[1] ?? "\u0000")) bmIdsHere.add(/\bw:id="([^"]*)"/.exec(s.slice(c.start, c.end))?.[1] ?? "");
    const ownMark = (c: XmlEl) => (c.local === "bookmarkStart" || c.local === "bookmarkEnd") && bmIdsHere.has(/\bw:id="([^"]*)"/.exec(s.slice(c.start, c.end))?.[1] ?? "\u0000");
    const marks = kids.filter((c) => RANGE_MARKS.has(c.local) && !ownMark(c) && !(commentMark(c) && (review || [...placed].some((x) => x.start === c.start)))).map((c) => s.slice(c.start, c.end));
    const open = el.openEnd === el.end ? s.slice(el.start, el.end - 2).trimEnd() + ">" : s.slice(el.start, el.openEnd);
    return `${open}${pPr}${marks.join("")}${runsXml(runs, orig, inserts, noteOrig, moves)}</${el.name}>`;
  }

  // ── tables ──

  private para = (p: TextParagraph) => this.freshPara(p);

  freshTable(tb: TableNode): string {
    return docxTableXml(tb, this.para);
  }

  /** A changed table: only the changed cells when the grid is the same, else the whole table (original w:tblPr kept). */
  rewriteTable(tb: TableNode, el: XmlEl, dom: Element, importKey: string): string {
    const s = this.xml;
    const kinds = new Map<TextParagraph, "li" | "oli">();
    const orig = docxTable(dom, this.ctx, kinds);
    for (const [p, k] of kinds) p.role = k;
    if (this.model < MODEL_WORD_MULTIPLE) orig.rows.forEach((row, ri) => row.forEach((c, ci) => c.richText && (c.richText = c.richText.map((q, k) => preWordMultipleView(q, tb.rows[ri]?.[ci]?.richText?.[k])))));
    if (this.legacyModel) for (const row of orig.rows) for (const c of row) if (c.richText) c.richText = c.richText.map(legacyParaView);
    const tblPrEl = childNamed(s, el, "tblPr");
    const trs = childrenOf(s, el).filter((c) => c.local === "tr");
    const merged = (rows: TableCell[][]) => rows.some((r) => r.some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1));
    const tcsOf = (tr: XmlEl) => childrenOf(s, tr).filter((c) => c.local === "tc");
    const sameGrid =
      !merged(orig.rows) &&
      !merged(tb.rows) &&
      tableKey(tb) === importKey &&
      trs.length === tb.rows.length &&
      orig.rows.length === tb.rows.length &&
      trs.every((tr, ri) => tcsOf(tr).length === tb.rows[ri].length && orig.rows[ri].length === tb.rows[ri].length);
    const rebuild = () => {
      this.rebuilt++;
      return docxTableXml(tb, this.para, tableKey(tb) === importKey && tblPrEl ? s.slice(tblPrEl.start, tblPrEl.end) : undefined, this.nestedKept(trs, orig.rows, tb));
    };
    if (!sameGrid) return rebuild();
    let out = s.slice(el.start, el.openEnd);
    let at = el.openEnd;
    let cells = 0;
    for (let ri = 0; ri < trs.length; ri++) {
      const tcs = tcsOf(trs[ri]);
      for (let ci = 0; ci < tcs.length; ci++) {
        const tc = tcs[ci];
        const cell = tb.rows[ri][ci];
        if (cellFp(cell) === cellFp(orig.rows[ri][ci]) && !(cellParas(cell) ?? []).some((p) => this.relist.at.has(p))) continue;
        // paragraphs inside nested tables / controls of the cell have no place in the cell model
        if (descendantsNamed(s, tc, "p").length !== childrenOf(s, tc).filter((c) => c.local === "p").length) return rebuild();
        cells++;
        out += s.slice(at, tc.start);
        out += this.rewriteCell(tb, cell, ri === 0 && tb.headerRow, tc, orig.rows[ri][ci]);
        at = tc.end;
      }
    }
    // no cell changed: a table-level property did (border, fonts)
    if (!cells) return rebuild();
    return out + s.slice(at, el.end);
  }

  /**
   * Cells holding a table (w:tbl in the w:tc): the cell model reads its paragraphs flat, so a rebuilt table would
   * lose it. The original content of each such cell goes into the rebuilt cell with the same content (spans aside:
   * a merge with empty cells keeps it in the merged cell; rows or columns added or removed move it), each original
   * at most once. One that finds no cell while its text is still in the table (the cell was edited, or merged with
   * text) is reported (nestedLost) — never dropped silently; one whose row or column was removed is gone with it.
   */
  private nestedKept(trs: XmlEl[], origRows: TableCell[][], tb: TableNode): Map<TableCell, string> {
    const s = this.xml;
    const kept = new Map<TableCell, string>();
    const val = (el: XmlEl | undefined) => (el ? /\sw:val="([^"]*)"/.exec(s.slice(el.start, el.openEnd))?.[1] : undefined);
    const kid = (el: XmlEl | undefined, local: string) => (el ? childrenOf(s, el).find((k) => k.local === local) : undefined);
    const fp = (c: TableCell) => cellFp({ ...c, colSpan: undefined, rowSpan: undefined });
    const holders: { fp: string | null; inner: string; text: string }[] = [];
    trs.forEach((tr, ri) => {
      // the grid column of each w:tc, as docxTable reads it (w:gridBefore, w:gridSpan; a w:vMerge continuation has no cell)
      let col = Number(val(kid(kid(tr, "trPr"), "gridBefore"))) || 0;
      for (const tc of childrenOf(s, tr).filter((k) => k.local === "tc")) {
        const tcPr = kid(tc, "tcPr");
        const span = Math.max(1, Number(val(kid(tcPr, "gridSpan"))) || 1);
        const vm = kid(tcPr, "vMerge");
        const cont = !!vm && ri > 0 && (val(vm) ?? "continue") === "continue";
        if (descendantsNamed(s, tc, "tbl").length) {
          const cell = cont ? undefined : origRows[ri]?.[col];
          const body = childrenOf(s, tc).filter((k) => k.local !== "tcPr");
          const inner = body.length ? s.slice(body[0].start, body[body.length - 1].end) : "<w:p/>";
          const t = /<w:t(?:\s[^>]*)?>([^<]+)<\/w:t>/.exec(inner)?.[1] ?? "";
          holders.push({ fp: cell ? fp(cell) : null, inner, text: t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&") });
        }
        col += span;
      }
    });
    if (!holders.length) return kept;
    const used = new Set<number>();
    for (const row of tb.rows)
      for (const cell of row) {
        if (!cellParas(cell)?.length) continue;
        const f = fp(cell);
        const k = holders.findIndex((h, i) => !used.has(i) && h.fp === f);
        if (k < 0) continue;
        used.add(k);
        kept.set(cell, holders[k].inner);
      }
    holders.forEach((h, i) => {
      if (used.has(i)) return;
      const gone = !!h.text && !tb.rows.some((r) => r.some((c) => c.text.includes(h.text)));
      if (!gone) this.nestedLost++;
    });
    return kept;
  }

  /** One changed w:tc: its w:tcPr (shading updated), the paragraphs rewritten (each into its original w:p when there is one). */
  private rewriteCell(tb: TableNode, cell: TableCell, header: boolean, tc: XmlEl, orig: TableCell): string {
    const s = this.xml;
    const kids = childrenOf(s, tc);
    const tcPrEl = kids.find((c) => c.local === "tcPr");
    let tcPr = tcPrEl ? s.slice(tcPrEl.start, tcPrEl.end) : "";
    if ((cell.fill ?? null) !== (orig.fill ?? null)) tcPr = withShading(s, tcPrEl, cell.fill ?? null);
    const origPs = kids.filter((c) => c.local === "p");
    // original paragraph elements of the cell, parsed alone (namespaces of the document root kept)
    const domPs = origPs.length ? this.cellDom(tc) : [];
    let i = 0;
    const para = (p: TextParagraph) => {
      const k = i++;
      return origPs[k] && domPs[k] ? this.rewritePara(p, origPs[k], domPs[k]) : this.freshPara(p);
    };
    // an edit of the plain cell text keeps the look of the cell's original paragraphs
    const sameLook = !!cell.bold === !!orig.bold && !!cell.italic === !!orig.italic && (cell.align ?? null) === (orig.align ?? null) && (cell.color ?? null) === (orig.color ?? null);
    const paras = sameLook ? cellParagraphs(cell, cellParas(orig) ?? []) : cellParas(cell);
    const inner = (paras ? paras.map(para).join("") : docxCellParas(tb, cell, header, para)) || "<w:p/>";
    return `${s.slice(tc.start, tc.openEnd)}${tcPr}${inner}</${tc.name}>`;
  }

  /** The w:p children of a table cell as DOM elements. */
  private cellDom(tc: XmlEl): Element[] {
    const root = rootOf(this.xml);
    const doc = parseXml(this.xml.slice(root.start, root.openEnd) + this.xml.slice(tc.start, tc.end) + `</${root.name}>`);
    const cell = children(doc.documentElement)[0];
    return cell ? children(cell).filter((c) => c.localName === "p") : [];
  }
}

/** w:tcPr with its w:shd replaced (fill null = removed); CT_TcPr order: … vMerge tcBorders shd noWrap … */
function withShading(s: string, tcPr: XmlEl | undefined, fill: string | null): string {
  const shd = fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${/^#([0-9a-f]{6})/i.exec(fill)?.[1].toUpperCase() ?? "FFFFFF"}"/>` : "";
  if (!tcPr) return shd ? `<w:tcPr>${shd}</w:tcPr>` : "";
  const kids = childrenOf(s, tcPr);
  const old = kids.find((c) => c.local === "shd");
  if (old) return s.slice(tcPr.start, old.start) + shd + s.slice(old.end, tcPr.end);
  const before = ["cnfStyle", "tcW", "gridSpan", "hMerge", "vMerge", "tcBorders"];
  const after = [...kids].reverse().find((c) => before.includes(c.local));
  const at = after ? after.end : tcPr.openEnd === tcPr.end ? -1 : tcPr.openEnd;
  if (at < 0) return `<w:tcPr>${shd}</w:tcPr>`;
  return s.slice(tcPr.start, at) + shd + s.slice(at, tcPr.end);
}

/** Original content placed in the new paragraph text: `len` characters at `pos` replaced by `xml` (0 = inserted). */
interface Insert {
  pos: number;
  len: number;
  xml: string;
}

/**
 * Where something that came after `origText[0, at)` goes in `newText`: right after the same few characters
 * (searched from `from`), the start when it was at the start; -1 when that text is gone.
 */
function anchorAt(origText: string, newText: string, at: number, from: number): number {
  if (at <= 0) return 0;
  if (at >= origText.length && origText === newText) return newText.length;
  const before = origText.slice(Math.max(0, at - 12), at);
  const i = newText.indexOf(before, Math.min(from, newText.length));
  return i < 0 ? -1 : i + before.length;
}

/**
 * w:r elements for `runs`, with `inserts` placed at their positions. A run reuses the original w:rPr of the
 * original run with the same character format — the one at the same place when several differ (hidden text,
 * character styles the model does not read), else a new w:rPr.
 */
function runsXml(runs: TextRun[], orig: OrigRun[], inserts: Insert[], noteOrig?: Map<string, string>, moves = false): string {
  const ins = [...inserts].sort((a, b) => a.pos - b.pos || a.len - b.len);
  const started = new Set<Insert>();
  const rPrOf = (r: TextRun, at: number, keepChange: boolean) => {
    const key = lookKey(r);
    const same = orig.filter((o) => o.key === key);
    if (!same.length) return `<w:rPr>${docxRPr(r)}</w:rPr>`;
    // (a format change accepted / rejected: the original w:rPr without its w:rPrChange)
    const pick = (x: string) => (keepChange ? x : x.replace(/<w:rPrChange\b[\s\S]*?<\/w:rPrChange>|<w:rPrChange\b[^>]*\/>/g, ""));
    if (same.every((o) => o.rPr === same[0].rPr)) return pick(same[0].rPr);
    const here = same.find((o) => at >= o.start && at < o.end) ?? same.reduce((a, b) => (Math.abs(b.start - at) < Math.abs(a.start - at) ? b : a));
    return pick(here.rPr);
  };
  const rPrFor = (r: TextRun, at: number) => {
    // a format change made here (recorded while changes are recorded: Revision.was): the new format with Word's
    // w:rPrChange holding the format before it — the original w:rPr of that format when there is one
    const former = formerRun(r);
    if (!former) return rPrOf(r, at, !!r.fmtRev);
    const old = rPrOf(former, at, false).replace(/^<w:rPr>([\s\S]*)<\/w:rPr>$/, "$1").replace(/^<w:rPr\/>$/, "");
    return docxWithRPrChange(rPrOf(r, at, false), r.fmtRev!, old);
  };
  let out = "";
  let pos = 0;
  let k = 0;
  // runs with a link (TextRun.link) not written back as their original w:hyperlink: inside Word's HYPERLINK field
  let open: string | null = null;
  const linkTo = (link: string | null) => {
    if (open === link) return;
    if (open) out += "</w:fldSimple>";
    open = link;
    if (link) out += `<w:fldSimple w:instr="${esc(link.startsWith("#") ? ` HYPERLINK \\l "${link.slice(1)}" ` : ` HYPERLINK "${link}" `)}">`;
  };
  /** emit what is due at `pos`; the cut `pos` is inside, if any */
  const due = (): Insert | null => {
    while (k < ins.length && ins[k].pos <= pos) {
      const x = ins[k];
      linkTo(null);
      if (!x.len) {
        out += x.xml;
        k++;
        continue;
      }
      if (!started.has(x)) {
        out += x.xml; // an element written back, once, where its text starts
        started.add(x);
      }
      if (pos >= x.pos + x.len) {
        k++;
        continue;
      }
      return x;
    }
    return null;
  };
  // bookmarks of the model (core/docRefs.ts) around the runs they cover
  const marks = runs.some((r) => r.bookmarks?.length) ? docxBookmarkMarks(runs) : null;
  let ri = -1;
  for (const r of runs) {
    ri++;
    if (marks?.before[ri]) {
      linkTo(null);
      out += marks.before[ri];
    }
    const end = () => {
      if (marks?.after[ri]) {
        linkTo(null);
        out += marks.after[ri];
      }
    };
    // a caption number / cross-reference made here (SEQ, REF, PAGEREF): Word's simple field, its value as result
    if ((r.field === "seq" || r.field === "ref" || r.field === "pageref") && r.fieldCode) {
      due();
      linkTo(null);
      out += `<w:fldSimple w:instr="${esc(r.fieldCode)}">${docxRevXml(r, `<w:r>${rPrFor(r, pos)}${docxText(r.text)}</w:r>`, moves)}</w:fldSimple>`;
      pos += r.text.length;
      end();
      continue;
    }
    if (r.note || r.noteMark) {
      // a note reference: its original run while it is the same note (as numbered: the note's id), else a new one
      due();
      linkTo(null);
      const id = r.note ? docxNoteId(r.note) : undefined;
      const kept = r.note && id !== undefined ? noteOrig?.get(`${r.note.kind}:${id}`) : undefined;
      out += kept ?? docxNoteRunXml(r, rPrFor(r, pos)) ?? "";
      end();
      continue;
    }
    if (!r.text) {
      due();
      linkTo(null);
      out += docxRevXml(r, `<w:r>${rPrFor(r, pos)}</w:r>`, moves);
      end();
      continue;
    }
    if (r.ruby) {
      // 덧말 / 윗주: one w:ruby with the run's text as its base
      due();
      linkTo(r.link && !r.field ? r.link : null);
      out += docxRevXml(r, docxRubyXml(r, rPrFor(r, pos)), moves);
      pos += r.text.length;
      continue;
    }
    let i = 0;
    while (i < r.text.length) {
      const cut = due();
      if (cut) {
        const skip = Math.min(cut.pos + cut.len - pos, r.text.length - i);
        pos += skip;
        i += skip;
        continue;
      }
      const next = k < ins.length ? ins[k].pos : Infinity;
      const take = Math.min(r.text.length - i, next - pos);
      linkTo(r.link && !r.field ? r.link : null);
      out += docxRevXml(r, `<w:r>${rPrFor(r, pos)}${docxText(r.text.slice(i, i + take))}</w:r>`, moves);
      pos += take;
      i += take;
    }
    end();
  }
  linkTo(null);
  for (; k < ins.length; k++) if (!started.has(ins[k])) out += ins[k].xml;
  return out;
}

export type { FlowItem };
