// Office Surgeon — HWPX: rewrite only the changed paragraphs / table cells of Contents/section*.xml.
//
// Design: docs/design/OFFICE_SURGEON.md §6. The edit unit is a top-level hp:p of a section. An element whose
// items are all still there, in order and unchanged, is copied as its original text. A changed paragraph keeps
// its hp:p attributes, its paragraph shape (paraPrIDRef / styleIDRef) while the format is unchanged, and the
// character shape of each run whose format exists in header.xml; shapes that do not exist yet are appended to
// header.xml (ids after the last one, itemCnt updated). Its controls (section / column settings, fields,
// bookmarks, pictures) are kept in a leading run; hp:linesegarray (한글's line layout cache) is dropped so 한글
// lays the paragraph out again. A changed table rewrites only its changed cells when the grid is the same.
// Every other entry (version, settings, BinData, Preview, META-INF, mimetype first and stored) is copied byte
// for byte. Not handled in stage 1 (the file is written anew, with a note): new or reshaped tables, changed
// text boxes / objects holding paragraphs, list or heading shapes the document has no paragraph shape for.

import { strFromU8 } from "fflate";
import { getBlob } from "../../core/assets";
import { hashString } from "../../core/hash";
import { DEFAULT_RUN, newParagraph, type NoteRef, type OfficeSourceBlock, type OfficeSourceMeta, type Page, type PageBorder, type Revision, type TableCell, type TableNode, type TextParagraph, type TextRun } from "../../core/types";
import { t } from "../../i18n";
import { TABLE_LINE, coverMap, spanOf } from "../../core/table";
import { sameBorder, sameColumns, type PageSetup } from "../../core/pageSetup";
import { layoutDiff, legacyLayout } from "./layout";
import { HF_MAP_VERSION, hfAddedToOldMap, hfStateKey, hwpxHFChanged } from "./hf";
import { borderFill, hwpxTblXml, hwpxSeqNum, hwpxPageBorderFillXml, hwpxPageBorderFills, HWPX_NO_PAGE_BORDER, collectFlow, flowNotes, hwpxLeftOut, hwpxCharPrXml, hwpxLineSpacing, hwpxColPrXml, hwpxPagePrXml, hwpxHeaderMaps, hwpxDutmalXml, hwpxLinked, hwpxText, parseHwpxFlow, pageListDefs, HWPX_NUMFMT_OUT, type HwpxHeaderMaps, type OfficeImportReport, type OfficeItem, type OfficeTable } from "../office";
import { MAX_LEVELS, isBulletLevel, levelOf, resolveDef, toHwpxLevelText } from "../../core/lists";
import type { ListDef } from "../../core/style/types";
import { esc } from "../xml";
import { cellFp, cellParagraphs, cellParas, legacyParaView, legacyRunView, MODEL_OPTIONAL_FIELDS, MODEL_VERSION, WORD_ENGINE_VERSION, itemFp, markedBodyRuns, itemId, lookKey, noteFp, paraFp, paraPropsKey, tablePropsKey, changedListDefs, fileListDefs, flowParas, itemRelisted, origParas, relistPlan, type ListSegment, type RelistPlan } from "./common";
import { SurgeryUnavailable, type SurgeryResult } from "./docx";
import { childrenOf, descendantsNamed, rootOf, type XmlEl } from "./scan";
import { entryData, readZip, rewriteZip, type ZipArchive } from "./zip";
import type { AssetRef } from "../../core/types";
import { HWPX_MEDIA, hwpxPicXml, itemTops, picFormat, picPixels, picTargets, type OfficePic, type PicMedia } from "../officeDrawing";
import { MODEL_SHAPES, shapeChanges, shapeMap, shapesKept } from "./shapes";
import { hwpxShapeXml } from "../officeShapes";
import { MODEL_PICTURES, bytesHash, emptyHwpxPara, patchElement, picChanges, picMap, type PicEdit } from "./pics";
import { MODEL_HEADING_STYLES, MODEL_PARA_STYLES, MODEL_REVIEW, sameOutlineLevels } from "./common";
import { paragraphInStyle, type DocStyle } from "../../core/docStyles";
import { isRemoved } from "../../core/review";
import { HwpxReview, withPoints } from "./hwpxReview";
import { docComments } from "../../core/review";
import { commentNeighbours, hwpxTracking } from "../officeReview";

const HEADER = "Contents/header.xml";
const PT = 96 / 72;
const tn = (key: string, n: number) => t(n === 1 ? `${key}_one` : key, { n });
const tableKey = (tb: { colWidths: number[]; headerRow: boolean } & Partial<TableNode>) => hashString(tablePropsKey(tb as TableNode));
const LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
/** run children that are text (rewritten); every other child (controls, objects) is kept */
const TEXT_KIDS = new Set(["t", "dutmal"]); // (덧말: text of the paragraph, written from the model — office.ts hwpxDutmalXml)
/** controls that may stay in front of the text without changing the meaning */
const LEADING_OK = new Set(["secPr", "ctrl"]);
/** page-level controls (columns, header, footer, page number…): their place in the paragraph does not matter */
const PAGE_CTRLS = new Set(["colPr", "header", "footer", "pageNum", "pageNumCtrl", "pageHiding", "newNum"]);

/** Block map of a freshly imported HWPX (null when the import and the element counts disagree). */
export function hwpxMeta(pages: Page[], sections: { part: string; items: number[] }[], asset: { id: string; hash: string }, pics?: OfficePic[], assets?: Record<string, AssetRef>, shapes?: OfficePic[]): OfficeSourceMeta | null {
  const flow = collectFlow(pages);
  if (sections.reduce((a, s) => a + s.items.reduce((x, y) => x + y, 0), 0) !== flow.length) return null;
  let i = 0;
  const parts = sections.map((s) => ({
    part: s.part,
    blocks: s.items.map((n): OfficeSourceBlock => {
      const its = flow.slice(i, (i += n));
      const b: OfficeSourceBlock = { ids: its.map(itemId), fp: its.map(itemFp) };
      if (its.some((it) => it.kind === "table")) b.tp = its.map((it) => (it.kind === "table" ? tableKey(it.t) : ""));
      return b;
    }),
  }));
  // pictures read (report.pictures): model 5 with the picture map; an import without them is a model 4 map
  // (shapes read, report.shapes: model 11 with the shape map — a text box's paragraphs are then no items)
  const meta: OfficeSourceMeta = { engine: WORD_ENGINE_VERSION, model: pics ? (shapes ? MODEL_VERSION : MODEL_PARA_STYLES) : MODEL_HEADING_STYLES, hf: HF_MAP_VERSION, hfKey: hfStateKey(pages), assetId: asset.id, hash: asset.hash, parts };
  if (pics?.length) meta.pics = picMap(pages, pics, assets);
  if (pics && shapes?.length) meta.shapes = shapeMap(pages, shapes);
  // footnotes / endnotes (model 7): each note's instId and the fingerprint of its text
  if (pics) meta.notes = flowNotes(flow).map((n) => ({ k: n.kind, id: n.src ?? "", fp: noteFp(n) }));
  return meta;
}

type FlowItem = ReturnType<typeof collectFlow>[number];

export function saveHwpxSurgical(pages: Page[], meta: OfficeSourceMeta, assets?: Record<string, AssetRef>): SurgeryResult {
  // headers made in this app on pages whose map predates headers: written anew (hf.ts hfAddedToOldMap)
  if (hfAddedToOldMap(meta, pages)) throw new SurgeryUnavailable("header / footer (older map)");
  // a map of rules version 1 (before page setup; HWPX items are read the same): usable while the pages are as that
  // app made them (layout.ts)
  const legacy = meta.engine === WORD_ENGINE_VERSION ? null : legacyLayout(pages, meta.engine);
  const orig = getBlob(meta.hash);
  if (!orig) throw new SurgeryUnavailable("asset");
  const zip = readZip(orig);
  if (!zip) throw new SurgeryUnavailable("zip");
  const read = (name: string) => {
    const e = zip.entries.find((x) => x.name === name);
    if (!e) throw new SurgeryUnavailable(name);
    return entryData(zip, e);
  };
  // the original as the importer saw it: its items in block order (formats to compare against)
  // (a map from model 5 on was made by the importer that reads pictures: the original is read the same way)
  const report: OfficeImportReport & { sectionBlocks: { part: string; items: number[] }[] } = { notesDropped: 0, sectionBlocks: [], ...((meta.model ?? 1) >= MODEL_PICTURES ? { pictures: [] } : {}), ...((meta.model ?? 1) >= MODEL_SHAPES ? { shapes: [] } : {}), ...((meta.model ?? 1) < MODEL_REVIEW ? { noReview: true as const } : {}), ...((meta.model ?? 1) < MODEL_PARA_STYLES ? { noParaStyle: true as const } : {}) };
  const reread = parseHwpxFlow(orig, report);
  // a map older than model version 2: the original in the shape that importer read it (common.ts legacyParaView)
  const origItems: OfficeItem[] =
    (meta.model ?? 1) < MODEL_OPTIONAL_FIELDS
      ? reread.map((it) =>
          it.kind === "p"
            ? { kind: "p", p: legacyParaView(it.p) }
            : { kind: "table", table: { ...it.table, paras: it.table.paras.map(legacyParaView), rows: it.table.rows.map((r) => r.map((c) => (c.richText ? { ...c, richText: c.richText.map(legacyParaView) } : c))) } },
        )
      : reread;
  if (JSON.stringify(report.sectionBlocks) !== JSON.stringify(meta.parts.map((p) => ({ part: p.part, items: p.blocks.map((b) => b.ids.length) })))) throw new SurgeryUnavailable("blocks");
  const origById = new Map<string, OfficeItem>();
  let oi = 0;
  for (const part of meta.parts) for (const b of part.blocks) for (const id of b.ids) origById.set(id, origItems[oi++]);

  const starts: number[] = [];
  const flow = collectFlow(pages, starts);
  // 이어서 구역 (한글 단 definitions in the text): changed → the file is written anew
  {
    const key = (ps: TextParagraph[]) => JSON.stringify(ps.flatMap((p) => (p.contSect ? [p.contSect.columns ?? null] : [])));
    if (key(origItems.flatMap((it) => (it.kind === "p" ? [it.p] : []))) !== key(flow.flatMap((it) => (it.kind === "p" ? [it.p] : [])))) throw new SurgeryUnavailable("column definitions");
  }
  // page layout against the original's (layout.ts): new page breaks, changed paper / margins
  const origLayout = report.layout;
  if (!origLayout) throw new SurgeryUnavailable("layout");
  const diff = legacy ?? layoutDiff(pages, flow, starts, meta.parts.flatMap((p) => p.blocks.flatMap((b) => b.ids)), origLayout);
  // (a section added here: written in place for DOCX only — 한글's hp:secPr is the first paragraph's, the file anew)
  if (diff.addSections?.size) throw new SurgeryUnavailable("sections");
  // headers / footers / page numbers: 한글 keeps them as controls in body paragraphs — a change is written anew (hf.ts)
  if (!legacy && hwpxHFChanged(meta, pages)) throw new SurgeryUnavailable("header / footer");
  const where = new Map<string, { part: number; b: number; k: number }>();
  meta.parts.forEach((part, pi) => part.blocks.forEach((bl, b) => bl.ids.forEach((id, k) => where.set(id, { part: pi, b, k }))));
  const pos = new Map<string, number>();
  flow.forEach((it, i) => pos.has(itemId(it)) || pos.set(itemId(it), i));
  // lists whose numbering changed (format, bullet, start: common.ts relistPlan) get an hh:numbering / hh:bullet of
  // their own. The outline numbering (개요 번호) is the section's: headings numbered by it are OUTLINE paragraphs —
  // with the file's own outline numbering as it is, or (another 개요 번호 모양 chosen) a numbering made from the
  // definition that the sections name as their outline shape (as 한글 does: one 개요 번호 모양 per section)
  const defsNow = pageListDefs(pages);
  const changedDefs = changedListDefs(defsNow, report.lists);
  const plan = relistPlan(flowParas(flow), origParas(flow, (id) => origById.get(id)), fileListDefs(origItems.flatMap((it) => (it.kind === "p" ? [it.p] : it.table.paras))), changedDefs, defsNow);
  if (plan.unsafe) throw new SurgeryUnavailable(plan.unsafe);
  const fileOutline = (report.lists ?? []).find((d) => d.outline) ?? null;
  let newOutline: ListDef | null = null;
  {
    const numbered = flowParas(flow).filter((p) => p.list && resolveDef(p.list.def, defsNow).outline);
    const used = new Set(numbered.map((p) => resolveDef(p.list!.def, defsNow)));
    // (only headings carry an outline number in place; one 개요 번호 모양 for the document)
    if (numbered.some((p) => !/^h[1-6]$/.test(p.role ?? "")) || used.size > 1) {
      if (numbered.some((p) => plan.at.has(p) || !fileOutline || resolveDef(p.list!.def, defsNow).id !== fileOutline.id)) throw new SurgeryUnavailable("outline numbering");
    } else if (used.size === 1) {
      const def = [...used][0];
      if (!fileOutline || !sameOutlineLevels(def, fileOutline)) newOutline = def;
    }
    for (const p of plan.at.keys()) if (/^h[1-6]$/.test(p.role ?? "") && !(p.list && resolveDef(p.list.def, defsNow).outline)) throw new SurgeryUnavailable("outline numbering");
  }
  const intact = meta.parts.map((part) =>
    part.blocks.map((bl) => {
      if (!bl.ids.length) return true;
      const at = bl.ids.map((id) => pos.get(id));
      if (at.some((x) => x === undefined) || at.some((x, k) => k > 0 && x !== at[k - 1]! + 1)) return false;
      return bl.ids.every((_, k) => itemFp(flow[at[k]!]) === bl.fp[k] && !itemRelisted(flow[at[k]!], plan));
    }),
  );
  const origIds = meta.parts.flatMap((p) => p.blocks.flatMap((b) => b.ids));
  // pictures: changed / deleted ones of the map, new IMAGE nodes (pics.ts)
  const pc = picChanges(pages, meta, assets, getBlob);
  // footnotes / endnotes: a note whose text changed is written anew inside its control; a note added or deleted is
  // not placed by this stage (the file is written anew)
  const noteEdits: { src: string; note: NoteRef }[] = [];
  const curNotes = flowNotes(flow);
  if (meta.notes) {
    const known = new Map(meta.notes.map((m) => [`${m.k}:${m.id}`, m.fp]));
    const used = new Set<string>();
    for (const n of curNotes) {
      // a note made here: 한글's footnote / endnote control written where its reference is (HwpxWriter.newNoteXml)
      if (n.src == null) continue;
      const key = `${n.kind}:${n.src}`;
      if (!known.has(key) || used.has(key)) throw new SurgeryUnavailable("new note");
      used.add(key);
      if (noteFp(n) !== known.get(key)) noteEdits.push({ src: n.src, note: n });
    }
    if (used.size !== meta.notes.length) throw new SurgeryUnavailable("deleted note");
  } else if (curNotes.some((n) => n.src == null)) throw new SurgeryUnavailable("notes (older map)");
  // memos and recording (model 9 on): the memo list and hh:trackchageConfig against the original's
  const review = (meta.model ?? 1) >= MODEL_REVIEW;
  const origComments = review ? origLayout.comments ?? [] : [];
  const curComments = review ? docComments(pages) : [];
  const commentsChanged = review && JSON.stringify(curComments) !== JSON.stringify(origComments);
  const trackChanged = review && !!pages[0]?.trackChanges !== hwpxTracking(read(HEADER));
  // named styles changed or made here (core/docStyles.ts): their hh:style elements
  const sheet = (meta.model ?? 1) >= MODEL_PARA_STYLES ? pages[0]?.docStyles : undefined;
  const stylesEdited = !!sheet?.some((x) => x.edited);
  // shapes and text boxes (model 11 map; shapes.ts): a changed or deleted one → the file is written anew (stage 1)
  const sc = shapeChanges(pages, meta);
  if (sc.changed) throw new SurgeryUnavailable("shape changed");
  if (!stylesEdited && !commentsChanged && !trackChanged && !noteEdits.length && !pc.any && !sc.added.length && diff.none && flow.length === origIds.length && flow.every((it, i) => itemId(it) === origIds[i]) && intact.every((p) => p.every(Boolean))) return { bytes: orig, unchanged: true, warnings: pc.skipped ? [tn("engine.office.picsSkipped", pc.skipped)] : [] };
  const bin = new HwpxBinData(zip);

  const rereadParas = reread.flatMap((it) => (it.kind === "p" ? [it.p] : []));
  // (or the outline items 개요 7–9 of a document without a numbered heading: QA hwpx-outline)
  const outlineDef = (rereadParas.find((q) => q.list && /^h[1-6]$/.test(q.role ?? "")) ?? rereadParas.find((q) => q.list?.id === "hwpx-outline"))?.list?.def ?? null;
  const w = new HwpxWriter(strFromU8(read(HEADER)), hwpxHeaderMaps(read(HEADER)), (meta.model ?? 1) < MODEL_OPTIONAL_FIELDS, outlineDef, plan, defsNow);
  // notes made here: their number among the notes of their kind, in document order (한글 numbers them again itself)
  {
    const count = { foot: 0, end: 0 };
    for (const n of curNotes) {
      count[n.kind]++;
      if (n.src == null) w.newNotes.set(n, count[n.kind]);
    }
  }
  if ((meta.model ?? 1) >= MODEL_PARA_STYLES) w.sheet = sheet ?? [];
  // another 개요 번호 모양: a numbering of it, named by every section as its outline shape
  const outlineShape = newOutline ? w.outlineNumbering(newOutline) : null;
  if (review) {
    const order: TextParagraph[] = [];
    for (const it of flow) {
      if (it.kind === "p") order.push(it.p);
      else for (const row of it.t.rows) for (const c of row) if (c.richText) order.push(...c.richText);
    }
    w.review = new HwpxReview(w, meta.parts.map((p) => strFromU8(read(p.part))), curComments, origComments, commentNeighbours(order));
    if (trackChanged) w.review.setTracking(!!pages[0]?.trackChanges);
  }
  const picEdited = new Set<string>();
  const sections = meta.parts.map((part) => {
    const xml = strFromU8(read(part.part));
    const root = rootOf(xml);
    const els = childrenOf(xml, root).filter((c) => c.local === "p");
    if (els.length !== part.blocks.length) throw new SurgeryUnavailable("section blocks");
    w.observe(xml, els);
    // changed / deleted pictures of this section: their paragraphs written with only those pictures changed (or left out)
    for (const [key, edits] of pc.edits) {
      if (!key.startsWith(part.part + "|")) continue;
      const b = Number(key.slice(key.lastIndexOf("|") + 1));
      if (!els[b]) throw new SurgeryUnavailable("picture map");
      const r = patchElement(xml, els[b], "pic", edits, (e, text) => bin.rewrite(e, text, assets));
      if (r == null) throw new SurgeryUnavailable("picture");
      w.patched.set(els[b], !part.blocks[b].ids.length && emptyHwpxPara(r.text) ? "" : r.text);
      picEdited.add(key);
    }
    // the paragraph holding the section settings (hp:secPr) must stay the section's first paragraph
    const secIndex = els.findIndex((el) => descendantsNamed(xml, el, "secPr").length > 0);
    return { xml, root, els, out: [] as string[], secIndex, secDone: secIndex < 0, held: [] as string[] };
  });
  /** add a paragraph to a section's output; anything that would come before its settings paragraph waits for it */
  const emit = (si: number, xml: string, block = -1) => {
    const s = sections[si];
    if (block >= 0 && block === s.secIndex) {
      s.out.push(xml, ...s.held);
      s.held = [];
      s.secDone = true;
    } else if (!s.secDone) s.held.push(xml);
    else s.out.push(xml);
  };

  // new pictures: placed like a fresh save places them, around / in the paragraph of the item at their place
  const picsAt = new Map<string, { before: string[]; after: string[]; runs: string }>();
  const lost: string[] = [];
  if (pc.added.length) {
    const ids = flow.map(itemId);
    picTargets(
      pc.added.map((m) => m.pic),
      ids,
      itemTops(pages),
    ).forEach((t, i) => {
      const m = pc.added[i];
      const pic = bin.fresh(m);
      const run = `<hp:run charPrIDRef="0">${pic}<hp:t/></hp:run>`;
      if (t.item < 0) return void lost.push(holderPara(w, run, m, t.before));
      const at = picsAt.get(ids[t.item]) ?? { before: [], after: [], runs: "" };
      picsAt.set(ids[t.item], at);
      if (m.pic.place.mode === "float" && flow[t.item].kind === "p") at.runs += run;
      else (t.after ? at.after : at.before).push(holderPara(w, run, m, t.before, t.below));
    });
  }
  // new shapes and text boxes (io/officeShapes.ts): anchored in the paragraph at their place, like a floating picture
  // (a hidden one: 한글 has no hidden objects — the save said so first)
  if (sc.added.length) {
    const ids = flow.map(itemId);
    let shapeId = 1960000000;
    picTargets(sc.added.filter((x) => x.node.visible), ids, itemTops(pages)).forEach((t) => {
      const xml = hwpxShapeXml(t.pic, { id: () => shapeId++, paras: (ps) => (ps.length ? ps : [newParagraph("")]).map((q) => w.freshPara(q)).join("") });
      const run = `<hp:run charPrIDRef="0">${xml}<hp:t/></hp:run>`;
      const fresh = () => injectHwpxRuns(w.freshPara({ id: "", runs: [], align: "LEFT", lineSpacing: 1, indent: 0, spaceAfter: 0 } as TextParagraph), run);
      if (t.item < 0) return void lost.push(fresh());
      const at = picsAt.get(ids[t.item]) ?? { before: [], after: [], runs: "" };
      picsAt.set(ids[t.item], at);
      if (flow[t.item].kind === "p") at.runs += run;
      else (t.after ? at.after : at.before).push(fresh());
    });
  }
  /** an item's paragraph with the new pictures at it (a section's settings paragraph stays its first) */
  const withPics = (ids: readonly string[], xml: string, si: number, block = -1) => {
    let before = "", after = "", runs = "";
    for (const id of ids) {
      const at = picsAt.get(id);
      if (!at) continue;
      picsAt.delete(id);
      before += at.before.join("");
      after += at.after.join("");
      runs += at.runs;
    }
    if (runs) xml = injectHwpxRuns(xml, runs);
    if (block >= 0 && block === sections[si].secIndex) return xml + before + after;
    return before + xml + after;
  };

  // sections take their items in flow order; new items go to the section of the item before them
  let cur = 0;
  const done = new Set<string>();
  const seen = new Set<string>();
  const prefixDone = sections.map(() => new Set<number>());
  const emitPrefix = (si: number, b: number) => {
    const blocks = meta.parts[si].blocks;
    for (let j = 0; j <= b; j++) {
      if (prefixDone[si].has(j) || !blocks[j].ids.length || (j < b && blocks[j].ids.some((id) => pos.has(id)))) continue;
      prefixDone[si].add(j);
      let z = j - 1;
      while (z >= 0 && !blocks[z].ids.length) z--;
      for (let q = z + 1; q < j; q++) emit(si, w.text(sections[si].xml, sections[si].els[q]), q);
      // a block whose items are all gone but holds the section settings keeps them (in an empty paragraph)
      if (j < b || !blocks[j].ids.some((id) => pos.has(id))) keepSettings(si, j);
    }
  };
  const keepSettings = (si: number, j: number) => {
    const s = sections[si];
    if (j === s.secIndex && !s.secDone) emit(si, w.rewritePara(s.xml, { id: "", runs: [], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 0 }, s.els[j], null, true), j);
  };
  for (const it of flow) {
    const id = itemId(it);
    const o = seen.has(id) ? undefined : where.get(id);
    // a new page break before this item: pageBreak="1" on its paragraph (more breaks: empty paragraphs before it)
    const brk = seen.has(id) ? 0 : diff.addBreaks.get(id) ?? 0;
    const br = (si: number, xml: string) => {
      if (!brk) return xml;
      for (let k = 1; k < brk; k++) emit(si, withPageBreak(w.freshPara({ id: "", runs: [], align: "LEFT", lineSpacing: 1.6, indent: 0, spaceAfter: 0 })));
      return withPageBreak(xml);
    };
    seen.add(id);
    if (!o) {
      // a new table: 한글's hp:tbl in a paragraph of its own (its border fills added to the header)
      emit(cur, withPics([id], br(cur, it.kind === "table" ? w.freshTable(it.t) : w.freshPara(it.p)), cur));
      continue;
    }
    cur = o.part;
    const s = sections[cur];
    emitPrefix(cur, o.b);
    const key = `${cur}:${o.b}`;
    // a break before an item that is not the first of its paragraph (a table after text) cannot be placed
    if (brk && (o.k > 0 || done.has(key))) throw new SurgeryUnavailable("break inside a paragraph");
    if (done.has(key)) continue;
    const el = s.els[o.b];
    const bl = meta.parts[cur].blocks[o.b];
    if (intact[cur][o.b]) {
      done.add(key);
      emit(cur, withPics(bl.ids, br(cur, w.text(s.xml, el)), cur, o.b), o.b);
      continue;
    }
    // a picture change in a paragraph that is rewritten (its text changed): not placed here
    if (picEdited.has(`${meta.parts[cur].part}|${o.b}`)) throw new SurgeryUnavailable("picture in a changed paragraph");
    // (a shape or text box read from the file in an element that is rewritten: not placed here either, stage 1)
    if (meta.shapes?.some((x) => x.part === meta.parts[cur].part && x.b === o.b)) throw new SurgeryUnavailable("shape in a changed paragraph");
    // a changed block: a paragraph on its own, or a paragraph holding tables whose own text is unchanged
    const items = bl.ids.map((bid) => flow[pos.get(bid) ?? -1]);
    if (bl.ids.length === 1 && it.kind === "p" && !holdsObjects(s.xml, el)) {
      emit(cur, withPics(bl.ids, br(cur, w.rewritePara(s.xml, it.p, el, origById.get(id) as { kind: "p"; p: TextParagraph })), cur, o.b), o.b);
      continue;
    }
    if (items.every((x) => x) && bl.ids.every((_, k) => (bl.tp?.[k] ? true : itemFp(items[k]!) === bl.fp[k]))) {
      done.add(key);
      emit(cur, withPics(bl.ids, br(cur, w.rewriteTables(s.xml, el, items as FlowItem[], bl, bl.ids.map((bid) => origById.get(bid)!))), cur, o.b), o.b);
      continue;
    }
    throw new SurgeryUnavailable("object block");
  }
  // changed paper / margins: the hp:pagePr of those sections' hp:secPr (numbered across the section files)
  const bySrc = new Map<number, PageSetup>();
  const colsChanged = new Set<number>();
  const borderChanged = new Set<number>();
  for (const [j, s] of diff.setups) {
    const src = origLayout.sections[j]?.src;
    if (src === undefined) throw new SurgeryUnavailable("section settings");
    bySrc.set(src, s);
    if (!sameColumns(origLayout.sections[j].setup.columns, s.columns)) colsChanged.add(src);
    // 쪽 테두리 changed: a border fill of its line in header.xml and the section's page border fills referring to it
    // (QA 11-25 real use: it was written as a whole file, asking first)
    if (!sameBorder(s.border, origLayout.sections[j].setup.border)) borderChanged.add(src);
  }
  let secBase = 0;
  const enc = new TextEncoder();
  const changed = new Map<string, Uint8Array>();
  sections.forEach((s, si) => {
    // blocks after the last item (deleted ones keep their settings / zero-item elements)
    const blocks = meta.parts[si].blocks;
    let last = blocks.length - 1;
    while (last >= 0 && !blocks[last].ids.length) last--;
    if (last >= 0) emitPrefix(si, last);
    for (let q = last + 1; q < s.els.length; q++) emit(si, w.text(s.xml, s.els[q]), q);
    if (!s.secDone) keepSettings(si, s.secIndex);
    s.out.push(...s.held);
    // new pictures of pages without items: at the end of the last section
    if (si === sections.length - 1) s.out.push(...lost, ...[...picsAt.values()].flatMap((a) => [...a.before, ...a.after]));
    const first = s.els[0], end = s.els[s.els.length - 1];
    let body = s.out.join("");
    // every shape read from the file is still in it (its paragraph deleted, the shape still on the page: written anew)
    if (!shapesKept(meta, meta.parts[si]?.part ?? "", s.xml, s.els, body, "hwpx")) throw new SurgeryUnavailable("shape's paragraph deleted");
    if (outlineShape !== null) body = body.replace(/(<hp:secPr\b[^>]*?\soutlineShapeIDRef=")\d+"/g, `$1${outlineShape}"`);
    const origSecs = (s.xml.match(SECPR) ?? []).length;
    if ([...bySrc.keys()].some((k) => k >= secBase && k < secBase + origSecs)) {
      let l = 0;
      const base = secBase;
      // (with the hp:colPr control after it: 단 changed → that control only, 한글's own form)
      body = body.replace(SECPR_COLS, (all, sec: string, cols: string | undefined) => {
        const at = base + l++;
        const setup = bySrc.get(at);
        if (!setup) return all;
        if (!/<hp:pagePr\b[\s\S]*?<\/hp:pagePr>/.test(sec)) throw new SurgeryUnavailable("pagePr");
        let out = sec.replace(/<hp:pagePr\b[\s\S]*?<\/hp:pagePr>/, hwpxPagePrXml(setup));
        if (borderChanged.has(at)) out = w.withPageBorder(out, setup.border);
        if (!colsChanged.has(at)) return out + (cols ?? "");
        return out + `<hp:ctrl>${hwpxColPrXml(setup.columns)}</hp:ctrl>`;
      });
      if (l !== origSecs) throw new SurgeryUnavailable("section settings");
    }
    secBase += origSecs;
    // memos deleted / edited in the model: taken out / written anew where they are (also in untouched paragraphs)
    if (w.review && commentsChanged) body = w.review.patchSection(body);
    // changed notes of this section: only their text, inside their controls
    for (const e of noteEdits) {
      const r = w.patchNote(body, e.src, e.note);
      if (r != null) {
        body = r;
        e.src = "";
      }
    }
    const before = first ? s.xml.slice(first.start, end.end) : "";
    if (body === before) return;
    const head = first ? s.xml.slice(0, first.start) : s.xml.slice(0, s.root.closeStart);
    const tail = first ? s.xml.slice(end.end) : s.xml.slice(s.root.closeStart);
    changed.set(meta.parts[si].part, enc.encode(head + body + tail));
  });
  if (noteEdits.some((e) => e.src)) throw new SurgeryUnavailable("note");
  w.writeStyles();
  if (w.headerChanged) changed.set(HEADER, enc.encode(w.header));
  bin.commit(changed);
  const warnings = [...w.warnings(), ...(w.review?.warnings() ?? [])];
  if (zip.entries.some((e) => /^META-INF\/signatures?\.xml$/i.test(e.name))) warnings.unshift(t("engine.officeSurgeon.signature"));
  if (pc.skipped) warnings.push(tn("engine.office.picsSkipped", pc.skipped));
  if (!changed.size) return { bytes: orig, unchanged: true, warnings };
  return { bytes: rewriteZip(zip, changed), unchanged: false, warnings };
}

const SECPR = /<hp:secPr\b[\s\S]*?<\/hp:secPr>/g;
/** an hp:secPr and the hp:colPr control right after it (in the same run, as 한글 writes them) */
const SECPR_COLS = /(<hp:secPr\b[\s\S]*?<\/hp:secPr>)(<hp:ctrl><hp:colPr\b[^>]*?(?:\/>|>[\s\S]*?<\/hp:colPr>)<\/hp:ctrl>)?/g;

/** Runs added at the end of a paragraph's runs (before 한글's line layout cache). */
function injectHwpxRuns(p: string, runs: string): string {
  const at = p.search(/<hp:linesegarray\b/);
  const end = at >= 0 ? at : p.lastIndexOf("</hp:p>");
  if (end < 0) throw new SurgeryUnavailable("paragraph");
  return p.slice(0, end) + runs + p.slice(end);
}

/** A new paragraph holding a picture (inline: aligned like it is placed). */
function holderPara(w: HwpxWriter, run: string, m: PicMedia, before = 0, after = 0): string {
  const inline = m.pic.place.mode === "inline";
  const p = w.freshPara({ id: "", runs: [], align: inline ? m.pic.align : "LEFT", lineSpacing: 1, indent: 0, spaceAfter: inline ? after : 0, ...(inline && before ? { spaceBefore: before } : {}), ...(m.pic.indent > 0 && inline ? { indentLeft: m.pic.indent } : {}) });
  return injectHwpxRuns(p, run);
}

/**
 * New pictures of a surgical HWPX save: bytes as they are under BinData (a name the package does not have) with a
 * manifest item in Contents/content.hpf; changed pictures written anew with their id, image settings and comment.
 */
class HwpxBinData {
  private hpf: string | null;
  private hpfChanged = false;
  private parts = new Map<string, Uint8Array>();
  private byHash = new Map<string, string>();
  private names: Set<string>;
  private nextId = 1800000000;

  constructor(private zip: ZipArchive) {
    const e = zip.entries.find((x) => x.name === "Contents/content.hpf");
    this.hpf = e ? strFromU8(entryData(zip, e)) : null;
    this.names = new Set(zip.entries.map((x) => x.name));
  }

  /** manifest id of these bytes (a new BinData item the first time) */
  private refFor(m: { bytes: Uint8Array; ext: string; mime: string; hash: string }): string {
    const known = this.byHash.get(m.hash);
    if (known) return known;
    if (!this.hpf) throw new SurgeryUnavailable("content.hpf");
    const ext = m.ext === "jpeg" ? "jpg" : m.ext;
    let n = 1;
    while (this.names.has(`BinData/omwimage${n}.${ext}`) || this.hpf.includes(`id="omwimage${n}"`)) n++;
    const name = `BinData/omwimage${n}.${ext}`;
    this.names.add(name);
    this.parts.set(name, m.bytes);
    const end = this.hpf.lastIndexOf("</opf:manifest>");
    if (end < 0) throw new SurgeryUnavailable("manifest");
    this.hpf = this.hpf.slice(0, end) + `<opf:item id="omwimage${n}" href="${name}" media-type="${HWPX_MEDIA[m.ext] ?? m.mime}" isEmbeded="1"/>` + this.hpf.slice(end);
    this.hpfChanged = true;
    this.byHash.set(m.hash, `omwimage${n}`);
    return `omwimage${n}`;
  }

  fresh(m: PicMedia): string {
    return hwpxPicXml({ id: this.nextId++, ref: this.refFor(m), g: m.pic.g, place: m.pic.place, z: m.pic.z, name: m.pic.node.name, dim: picPixels(m.bytes) });
  }

  /** a changed picture: its hp:pic written anew (same id, image settings, comment; new bytes → a new BinData item) */
  rewrite(e: PicEdit, p: string, assets: Record<string, AssetRef> | undefined): string | null {
    const node = e.node!, g = e.g!;
    const ref = /<hc:img\b[^>]*\bbinaryItemIDRef="([^"]*)"/.exec(p)?.[1];
    const href = ref && this.hpf ? new RegExp(`<opf:item\\b[^>]*\\bid="${ref}"[^>]*>`).exec(this.hpf)?.[0].match(/\bhref="([^"]+)"/)?.[1] : undefined;
    const entry = href && this.zip.entries.find((x) => x.name === href.replace(/^\//, ""));
    const origBytes = entry ? entryData(this.zip, entry) : null;
    const asset = assets?.[node.assetId];
    const same = !!asset && !!origBytes && asset.hash === bytesHash(origBytes);
    const bytes = same ? origBytes : asset && getBlob(asset.hash);
    const fmt = bytes && picFormat(bytes);
    if (!bytes || (!same && !fmt)) return null;
    const id = Number(/^<hp:pic\b[^>]*\sid="(\d+)"/.exec(p)?.[1]) || this.nextId++;
    const z = Number(/^<hp:pic\b[^>]*\szOrder="(\d+)"/.exec(p)?.[1]) || 0;
    const inline = /<hp:pos\b[^>]*\btreatAsChar="1"/.test(p);
    const place = node.place ?? (inline ? { mode: "inline" as const } : { mode: "float" as const, wrap: "topBottom" as const });
    return hwpxPicXml({
      id,
      ref: same ? ref! : this.refFor({ bytes, ...fmt!, hash: asset!.hash }),
      g,
      place,
      z,
      name: node.name,
      dim: picPixels(bytes),
      keep: { img: /<hc:img\b[^>]*\/>/.exec(p)?.[0], comment: /<hp:shapeComment\b[\s\S]*?<\/hp:shapeComment>/.exec(p)?.[0], instid: /^<hp:pic\b[^>]*\sinstid="([^"]*)"/.exec(p)?.[1] },
    });
  }

  commit(changed: Map<string, Uint8Array>) {
    for (const [n, b] of this.parts) changed.set(n, b);
    if (this.hpfChanged && this.hpf) changed.set("Contents/content.hpf", new TextEncoder().encode(this.hpf));
  }
}

/** A paragraph element that starts a new page: pageBreak="1" on its start tag. */
function withPageBreak(xml: string): string {
  const end = xml.indexOf(">");
  const tag = xml.slice(0, end);
  const set = / pageBreak="[^"]*"/.test(tag) ? tag.replace(/ pageBreak="[^"]*"/, ' pageBreak="1"') : tag.replace(/\/$/, "") + ' pageBreak="1"' + (tag.endsWith("/") ? "/" : "");
  return set + xml.slice(end);
}

/** page furniture and notes: controls whose paragraphs are not part of the body (kept as they are) */
// (a memo field's paragraphs are the memo's text, not body paragraphs: hp:fieldBegin type="MEMO")
const STORY_CTRLS = new Set(["header", "footer", "footNote", "endNote", "hiddenComment", "fieldBegin"]);

/** The paragraph holds objects with paragraphs of their own in the body (tables, text boxes): not a plain paragraph. */
function holdsObjects(s: string, el: XmlEl): boolean {
  if (descendantsNamed(s, el, "tbl").length) return true;
  const stories = descendantsNamed(s, el, "ctrl").flatMap((c) => childrenOf(s, c).filter((k) => STORY_CTRLS.has(k.local)));
  return descendantsNamed(s, el, "subList").some((sl) => !stories.some((st) => sl.start >= st.start && sl.end <= st.end));
}

const attrOf = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Writes changed / new paragraphs against one original document; appends shapes to header.xml when needed. */
class HwpxWriter {
  headerChanged = false;
  /** character format key → charPr ids with that format (first = used for new text without a nearer one) */
  private chars = new Map<string, string[]>();
  /** new shapes made from a base shape: `${base}|${key}` → id (each made once) */
  private madeChar = new Map<string, string>();
  private madePara = new Map<string, string>();
  private nextPid = 1;
  private moved = 0;
  private looks = 0;
  /** tables nested in cells of a reshaped table that found no place in it (the save says so) */
  private nestedLost = 0;
  /** paragraph shape of the last paragraph written (a new paragraph takes its look) */
  private lastPP: string;

  constructor(
    public header: string,
    private maps: HwpxHeaderMaps,
    /** the map is older than model version 2: shapes are compared in the older paragraph / run shape (common.ts) */
    private legacyModel = false,
    /** list definition id of the outline numbering the importer applied to 개요 headings, if any */
    private outlineDef: string | null = null,
    /** list paragraphs written with numbering of their own (common.ts relistPlan) */
    private relist: RelistPlan = { at: new Map(), unsafe: null },
    /** list definitions of the pages */
    private defs: ListDef[] = [],
  ) {
    for (const [id, cp] of maps.charPr) {
      const key = lookKey(this.runOf(cp));
      this.chars.set(key, [...(this.chars.get(key) ?? []), id]);
    }
    this.lastPP = /<hh:style\b[^>]*\sid="0"[^>]*>/.exec(header)?.[0].match(/\sparaPrIDRef="(\d+)"/)?.[1] ?? "0";
  }

  /** a run as the importer makes it from a character shape */
  private runOf(cp: Partial<TextRun>): TextRun {
    const defined = Object.fromEntries(Object.entries(cp).filter(([, v]) => v !== undefined));
    const r: TextRun = { ...DEFAULT_RUN, fontSize: 10 * PT, ...defined, text: "" };
    return this.legacyModel ? legacyRunView(r) : r;
  }
  private charKey = (id: string) => lookKey(this.runOf(this.maps.charPr.get(id) ?? {}));

  private roleOf(pp: string, st: string): TextParagraph["role"] {
    const head = this.maps.paraPr.get(pp)?.head;
    const level = head?.type === "OUTLINE" ? head.level + 1 : this.maps.styleHeading.get(st) ?? 0;
    if (level >= 1 && level <= 6) return `h${level}` as TextParagraph["role"];
    if (head?.type === "BULLET") return "li";
    if (head?.type === "NUMBER") return "oli";
    return undefined;
  }

  private propsOf(pp: string, st: string): TextParagraph {
    const { head, ...rest } = this.maps.paraPr.get(pp) ?? { align: "LEFT" as const, lineSpacing: 1.6, indent: 0, spaceAfter: 4 };
    const role = this.roleOf(pp, st);
    const out: TextParagraph = { id: "", runs: [], ...rest, ...(role ? { role } : {}) };
    // (model 10: the paragraph's named style but 바탕글)
    if (this.sheet && st !== "0" && this.maps.styles.some((x) => x.id === st)) out.style = st;
    if (this.legacyModel) return legacyParaView(out);
    // list membership as the importer reads it (office.ts parseHwpxFlow)
    const kind = head?.type === "NUMBER" ? "n" : head?.type === "BULLET" ? "b" : null;
    if (kind && this.maps.listDefs.has(`hwpx-${kind}${head!.idRef}`)) out.list = { id: `hwpx-${kind}${head!.idRef}`, def: `hwpx-${kind}${head!.idRef}`, level: head!.level };
    // (개요 7–9 too: an outline item without a heading role — QA hwpx-outline; 개요 10 has no model level)
    else if (head?.type === "OUTLINE" && this.outlineDef && (role || (head.level >= 6 && head.level < MAX_LEVELS))) out.list = { id: "hwpx-outline", def: this.outlineDef, level: head.level };
    return out;
  }

  /** the highest paragraph id of a section (new paragraphs get ids after it) */
  observe(xml: string, _els: XmlEl[]) {
    for (const m of xml.matchAll(/<hp:p\b[^>]*>/g)) {
      const id = Number(attrOf(m[0], "id"));
      if (Number.isFinite(id) && id >= this.nextPid && id < 4294967295) this.nextPid = id + 1;
    }
  }

  /** paragraph text with picture edits (pics.ts); "" = the paragraph goes */
  patched = new Map<XmlEl, string>();
  text = (xml: string, el: XmlEl) => this.patched.get(el) ?? xml.slice(el.start, el.end);

  warnings(): string[] {
    const w: string[] = [];
    if (this.moved) w.push(tn("engine.officeSurgeon.inlineMoved", this.moved));
    if (this.looks) w.push(tn("engine.officeSurgeon.cellLookKept", this.looks));
    if (this.nestedLost) w.push(tn("engine.officeSurgeon.nestedLost", this.nestedLost));
    if (this.trackedParas.size) w.push(tn("engine.officeSurgeon.tracked", this.trackedParas.size));
    if (this.memoParas.size) w.push(tn("engine.review.memoDropped", this.memoParas.size));
    return w;
  }

  // ── header shapes ──

  /** the whole element `<hh:{tag} id="{id}" …>…</hh:{tag}>` of a header list */
  private shapeXml(tag: string, id: string): string | null {
    const re = new RegExp(`<hh:${tag}\\b[^>]*\\sid="${id}"[^>]*?(?:/>|>[\\s\\S]*?</hh:${tag}>)`);
    return re.exec(this.header)?.[0] ?? null;
  }

  /**
   * A section's hp:secPr with new page border fills (쪽 테두리): a border fill of the line appended to the header, the
   * three hp:pageBorderFill referring to it; none (taken off) → the header's first border fill, as 한글 writes it.
   */
  withPageBorder(sec: string, b: PageBorder | undefined): string {
    const fills = b && b.width > 0 ? hwpxPageBorderFills(this.append("borderFills", "borderFill", (id) => hwpxPageBorderFillXml(id, b)), b) : HWPX_NO_PAGE_BORDER;
    const re = /<hp:pageBorderFill\b[^>]*?(?:\/>|>[\s\S]*?<\/hp:pageBorderFill>)/g;
    const first = sec.search(re);
    if (first < 0) {
      const end = sec.lastIndexOf("</hp:secPr>");
      if (end < 0) throw new SurgeryUnavailable("page border");
      return sec.slice(0, end) + fills + sec.slice(end);
    }
    const rest = sec.slice(first).replace(re, "");
    return sec.slice(0, first) + fills + rest;
  }

  /** append a shape to a header list (hh:charProperties / hh:paraProperties), updating its itemCnt; its new id */
  private append(list: string, tag: string, make: (id: string) => string): string {
    const ids = Array.from(this.header.matchAll(new RegExp(`<hh:${tag}\\b[^>]*\\sid="(\\d+)"`, "g")), (m) => Number(m[1]));
    // numberings and bullets are numbered from 1 (as 한글 and the full writer write them) — shapes from 0
    const id = String(Math.max(tag === "numbering" || tag === "bullet" ? 0 : -1, ...ids) + 1);
    const xml = make(id); // may add fonts to the header first: positions are taken after
    const open = new RegExp(`<hh:${list}\\b[^>]*>`).exec(this.header);
    const close = this.header.indexOf(`</hh:${list}>`);
    if (!open || close < 0) throw new SurgeryUnavailable(list);
    const newOpen = open[0].replace(/\sitemCnt="(\d+)"/, (_, n) => ` itemCnt="${Number(n) + 1}"`);
    this.header = this.header.slice(0, open.index) + newOpen + this.header.slice(open.index + open[0].length, close) + xml + this.header.slice(close);
    this.headerChanged = true;
    return id;
  }

  /** id of a font face in one language's font list (added when missing) */
  private fontId(lang: string, face: string): number {
    const root = rootOf(this.header);
    const ff = descendantsNamed(this.header, root, "fontface").find((f) => attrOf(this.header.slice(f.start, f.openEnd), "lang") === lang);
    if (!ff || ff.openEnd === ff.end) throw new SurgeryUnavailable("fontface");
    const fonts = childrenOf(this.header, ff).filter((c) => c.local === "font");
    for (const f of fonts) if (attrOf(this.header.slice(f.start, f.openEnd), "face") === face) return Number(attrOf(this.header.slice(f.start, f.openEnd), "id"));
    const id = Math.max(-1, ...fonts.map((f) => Number(attrOf(this.header.slice(f.start, f.openEnd), "id")))) + 1;
    const open = this.header.slice(ff.start, ff.openEnd).replace(/\sfontCnt="(\d+)"/, (_, n) => ` fontCnt="${Number(n) + 1}"`);
    this.header = this.header.slice(0, ff.start) + open + this.header.slice(ff.openEnd, ff.closeStart) + `<hh:font id="${id}" face="${esc(face)}" type="TTF" isEmbedded="0"/>` + this.header.slice(ff.closeStart);
    this.headerChanged = true;
    return id;
  }

  /**
   * charPr id for a run: one of `near` (the ids the paragraph used) with its format, else any with its format,
   * else a copy of the base shape (`near[0]`) with just the changed properties (ratio, other-language fonts,
   * emphasis… stay as they were).
   */
  private charFor(r: TextRun, near: string[]): string {
    const key = lookKey(r);
    const local = near.find((id) => this.charKey(id) === key);
    if (local) return local;
    const any = this.chars.get(key)?.[0];
    if (any && !near.length) return any;
    const base = near[0] ?? any ?? "0";
    const made = this.madeChar.get(`${base}|${key}`);
    if (made) return made;
    const baseXml = this.shapeXml("charPr", base);
    const was = this.runOf(this.maps.charPr.get(base) ?? {});
    const id = this.append("charProperties", "charPr", (nid) => (baseXml ? cloneCharPr(baseXml, nid, was, r, (l) => this.fontId(l, r.fontFamily)) : hwpxCharPrXml(Number(nid), r, (l) => this.fontId(l.toUpperCase(), r.fontFamily))));
    this.madeChar.set(`${base}|${key}`, id);
    this.chars.set(key, [...(this.chars.get(key) ?? []), id]);
    return id;
  }

  /** paraPr id for a paragraph: a copy of the base shape with the changed format (tabs, borders, breaks… kept) */
  private paraFor(p: TextParagraph, base: string, st: string): { pp: string; st: string } {
    const seg = this.relist.at.get(p);
    if (!seg && paraPropsKey(p) === paraPropsKey(this.propsOf(base, st))) return { pp: base, st };
    // (numbering of its own: the shape names it, so the shape is made per numbering)
    let head = seg ? this.headFor(p, base, st) : null;
    const key = `${base}|${st}|${paraPropsKey(p)}${head ? "|" + JSON.stringify(head) : ""}`;
    const made = this.madePara.get(key);
    if (made) return { pp: made, st: this.styleFor(p, st) };
    const baseXml = this.shapeXml("paraPr", base);
    if (!baseXml) throw new SurgeryUnavailable("paraPr");
    if (!seg) head = this.headFor(p, base, st);
    const id = this.append("paraProperties", "paraPr", (nid) => cloneParaPr(baseXml, nid, p, head));
    this.madePara.set(key, id);
    return { pp: id, st: this.styleFor(p, st) };
  }

  /** the document's style sheet (model 10; core/docStyles.ts): named styles are written; null = a map before it */
  sheet: DocStyle[] | null = null;
  private styleIds = new Map<string, string>();
  private inStyle = false;

  /** hh:style id of the sheet's style `id`: the file's own, or — made or changed here — written into the header */
  private styleId(id: string): string {
    const done = this.styleIds.get(id);
    if (done) return done;
    const s = this.sheet?.find((x) => x.id === id);
    const exists = this.maps.styles.some((x) => x.id === id && x.type === "PARA");
    if (!s || !s.edited) return exists ? id : "0";
    // its shapes: the style's look as paragraph and character shapes (copies of its own, or of 바탕글's)
    const own = this.maps.styles.find((x) => x.id === id) ?? this.maps.styles.find((x) => x.id === "0");
    const tpl = paragraphInStyle(this.sheet!, id);
    this.inStyle = true;
    let pp: string, cp: string;
    try {
      // (against its own style: a 개요 style's shape is a heading by that style, no outline shape needed)
      pp = this.paraFor({ ...tpl, style: undefined, role: s.role }, own?.pp ?? "0", own?.id ?? "0").pp;
      cp = this.charFor({ ...this.runOf(s.run), text: "" }, own ? [own.cp] : []);
    } finally {
      this.inStyle = false;
    }
    const next = s.next ? (this.maps.styles.some((x) => x.id === s.next) ? s.next : this.styleIds.get(s.next) ?? null) : null;
    let out: string;
    if (exists) {
      out = id;
      this.header = this.header.replace(new RegExp(`<hh:style\\b[^>]*\\sid="${id}"[^>]*?/?>`), (el) =>
        el.replace(/\sparaPrIDRef="[^"]*"/, ` paraPrIDRef="${pp}"`).replace(/\scharPrIDRef="[^"]*"/, ` charPrIDRef="${cp}"`).replace(/\sname="[^"]*"/, ` name="${esc(s.name)}"`),
      );
      this.headerChanged = true;
    } else {
      out = this.append("styles", "style", (nid) => `<hh:style id="${nid}" type="PARA" name="${esc(s.name)}" engName="${esc(s.engName ?? "")}" paraPrIDRef="${pp}" charPrIDRef="${cp}" nextStyleIDRef="${next ?? nid}" langID="1042" lockForm="0"/>`);
    }
    this.styleIds.set(id, out);
    return out;
  }

  /** every style made or changed here, also one no paragraph uses (the header written once more) */
  writeStyles() {
    for (const s of this.sheet ?? []) if (s.edited && s.type === "para") this.styleId(s.id);
  }

  /** a heading by style that is no longer one (or the reverse) goes back to the normal style */
  private styleFor(p: TextParagraph, st: string): string {
    // model 10: the paragraph's named style (a style made or changed here written into the header first)
    if (this.sheet && !this.inStyle) {
      const want = p.style ?? "0";
      if (want !== st || this.sheet.some((x) => x.id === want && x.edited)) return this.styleId(want);
    }
    const byStyle = this.maps.styleHeading.get(st);
    const level = p.role && /^h([1-6])$/.exec(p.role)?.[1];
    return byStyle && (!level || Number(level) !== byStyle) ? "0" : st;
  }

  /** heading element for the new shape: kept when the role is the base's, else copied from a shape having that role */
  private headFor(p: TextParagraph, base: string, st: string): { type: string; idRef: number; level: number } | null {
    const was = this.propsOf(base, st);
    // a multi-level item: the numbering / bullet of this document it came from, at its level; a list made in Omniweave
    // or one whose format / start changed has numbering of its own (listHead)
    if (p.list && !/^h[1-6]$/.test(p.role ?? "")) {
      // numbering of its own (a changed format, bullet or start number, a list made in Omniweave: relistPlan)
      const seg = this.relist.at.get(p);
      if (seg) return this.listHead(p.list, seg);
      if (was.list && was.list.id === p.list.id && was.list.level === p.list.level) return null;
      const m = /^hwpx-([nb])(\d+)$/.exec(p.list.id);
      if (!m) throw new SurgeryUnavailable("list shape");
      return { type: m[1] === "n" ? "NUMBER" : "BULLET", idRef: Number(m[2]), level: p.list.level };
    }
    // numbering taken off a numbered (개요) heading: a shape without it, the heading one by its style (개요 n) — a heading
    // only by its OUTLINE shape has no other way (written anew). Before, the OUTLINE shape stayed and the number came
    // back (QA hwpx-numbering 2026-11-16).
    const hLevel = p.role && /^h([1-6])$/.exec(p.role)?.[1];
    if (hLevel && was.list && !p.list && (p.role ?? "") === (was.role ?? "")) {
      if (this.maps.styleHeading.get(st) !== Number(hLevel)) throw new SurgeryUnavailable("heading shape");
      return { type: "NONE", idRef: 0, level: 0 };
    }
    // outline numbering put on a heading (개요 번호): an OUTLINE shape at its level (the section's outline numbering)
    const outlined = !!hLevel && !!p.list && resolveDef(p.list.def, this.defs).outline;
    if ((p.role ?? "") === (was.role ?? "") && !(outlined && !was.list)) return null;
    if (!p.role) return { type: "NONE", idRef: 0, level: 0 };
    const level = /^h([1-6])$/.exec(p.role)?.[1];
    const want = level ? "OUTLINE" : p.role === "li" ? "BULLET" : "NUMBER";
    for (const m of this.header.matchAll(/<hh:paraPr\b[^>]*>[\s\S]*?<\/hh:paraPr>/g)) {
      const hd = /<hh:heading\b[^>]*>/.exec(m[0])?.[0];
      if (hd && attrOf(hd, "type") === want) return { type: want, idRef: Number(attrOf(hd, "idRef")) || 0, level: level ? Number(level) - 1 : Number(attrOf(hd, "level")) || 0 };
    }
    throw new SurgeryUnavailable("heading shape");
  }

  /** hh:numbering made per list segment, hh:bullet per character (made or found) */
  private segNum = new Map<ListSegment, number>();
  private bulletOf = new Map<string, number>();

  /** The heading of a list item written with numbering of its own: a bullet by its character, else its segment's numbering. */
  private listHead(l: NonNullable<TextParagraph["list"]>, seg: ListSegment): { type: string; idRef: number; level: number } {
    const def = resolveDef(l.def, this.defs);
    const lv = levelOf(def, l.level);
    if (isBulletLevel(lv)) return { type: "BULLET", idRef: this.bulletFor(lv.text), level: l.level };
    let id = this.segNum.get(seg);
    if (id === undefined) {
      id = this.numberingFor(def, seg);
      this.segNum.set(seg, id);
    }
    if (!this.paraHeadAt(id, l.level + 1)) throw new SurgeryUnavailable("numbering level");
    return { type: "NUMBER", idRef: id, level: l.level };
  }

  private paraHeadAt(id: number, level: number): boolean {
    const x = this.shapeXml("numbering", String(id)) ?? "";
    return new RegExp(`<hh:paraHead\\b[^>]*\\slevel="${level}"`).test(x);
  }

  /** an hh:bullet of the document with this character (as the importer reads it), else one appended */
  private bulletFor(text: string): number {
    const known = this.bulletOf.get(text);
    if (known !== undefined) return known;
    for (const [id, d] of this.maps.listDefs) {
      const m = /^hwpx-b(\d+)$/.exec(id);
      if (m && d.levels[0]?.text === text) {
        this.bulletOf.set(text, Number(m[1]));
        return Number(m[1]);
      }
    }
    this.ensureList("bullets", ["paraProperties"]);
    const base = /<hh:bullet\b[^>]*?(?:\/>|>[\s\S]*?<\/hh:bullet>)/.exec(this.header)?.[0];
    const id = this.append("bullets", "bullet", (nid) =>
      base
        ? base.replace(/^(<hh:bullet\b[^>]*?\s)id="[^"]*"/, `$1id="${nid}"`).replace(/^(<hh:bullet\b[^>]*?\s)char="[^"]*"/, `$1char="${esc(text)}"`).replace(/^(<hh:bullet\b[^>]*?\s)useImage="[^"]*"/, `$1useImage="0"`).replace(/<hc:img\b[^>]*\/>|<hc:img\b[\s\S]*?<\/hc:img>/g, "")
        : `<hh:bullet id="${nid}" char="${esc(text)}" useImage="0"><hh:paraHead level="0" align="LEFT" useInstWidth="0" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0"/></hh:bullet>`,
    );
    this.bulletOf.set(text, Number(id));
    return Number(id);
  }

  /**
   * An hh:numbering for a list segment: a copy of the definition's own numbering (another one of the document when
   * the list was made in Omniweave) with each level's number format, text and start written from the definition and
   * the segment's restart numbers. The original numbering stays for the paragraphs that use it.
   */
  private numberingFor(def: ListDef, seg: ListSegment): number {
    this.ensureList("numberings", ["bullets", "paraProperties"]);
    const src = /^hwpx-n(\d+)$/.exec(def.id)?.[1];
    const own = src ? this.shapeXml("numbering", src) : null;
    // the levels of the numbering copied, as the importer read them (only the definition's own numbering)
    const from = own ? this.maps.listDefs.get(def.id) : undefined;
    const base = own ?? /<hh:numbering\b[^>]*?(?:\/>|>[\s\S]*?<\/hh:numbering>)/.exec(this.header)?.[0] ?? null;
    const head = (k: number) => {
      const lv = levelOf(def, k - 1);
      return { fmt: HWPX_NUMFMT_OUT[lv.format] ?? "DIGIT", text: lv.format === "bullet" ? "" : toHwpxLevelText(lv.text), start: seg.starts.get(k - 1) ?? lv.start ?? 1 };
    };
    const id = this.append("numberings", "numbering", (nid) => {
      if (!base || !/<hh:paraHead\b/.test(base))
        return `<hh:numbering id="${nid}" start="0">${Array.from({ length: 7 }, (_, i) => {
          const h = head(i + 1);
          return `<hh:paraHead start="${h.start}" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${h.fmt}" charPrIDRef="4294967295" checkable="0">${esc(h.text)}</hh:paraHead>`;
        }).join("")}</hh:numbering>`;
      return base
        .replace(/^(<hh:numbering\b[^>]*?\s)id="[^"]*"/, `$1id="${nid}"`)
        .replace(/<hh:paraHead\b([^>]*?)(\/>|>([\s\S]*?)<\/hh:paraHead>)/g, (all, attrs: string) => {
          const k = Number(attrOf(attrs, "level"));
          if (!(k >= 1 && k <= MAX_LEVELS)) return all;
          // a level as the copied numbering has it (not restarted) stays as written (formats the model reads as the
          // nearest one — CIRCLED_HANGUL_SYLLABLE as 가 — are not changed)
          const was = from && levelOf(from, k - 1);
          const now = levelOf(def, k - 1);
          const h = head(k);
          if (was && was.format === now.format && was.text === now.text && (was.start ?? 1) === h.start) return all;
          const a = attrs.replace(/(\snumFormat=")[^"]*"/, `$1${h.fmt}"`).replace(/(\sstart=")[^"]*"/, `$1${h.start}"`);
          return `<hh:paraHead${a}>${esc(h.text)}</hh:paraHead>`;
        });
    });
    return Number(id);
  }

  /** An hh:numbering of a 개요 번호 모양 (the definition's levels, from 1) for the sections' outline shape; its id. */
  outlineNumbering(def: ListDef): number {
    return this.numberingFor(def, { list: "outline", starts: new Map(), seen: new Set() } as ListSegment);
  }

  /** a header list the document does not have yet (hh:numberings / hh:bullets), before the first of `before` */
  private ensureList(list: string, before: string[]) {
    const self = new RegExp(`<hh:${list}\\b([^>]*?)\\s*/>`).exec(this.header);
    if (self) {
      this.header = this.header.slice(0, self.index) + `<hh:${list}${self[1]}></hh:${list}>` + this.header.slice(self.index + self[0].length);
      return;
    }
    if (new RegExp(`<hh:${list}\\b`).test(this.header)) return;
    const at = before.map((t) => this.header.search(new RegExp(`<hh:${t}\\b`))).find((i) => i >= 0);
    if (at === undefined) throw new SurgeryUnavailable(list);
    this.header = this.header.slice(0, at) + `<hh:${list} itemCnt="0"></hh:${list}>` + this.header.slice(at);
    this.headerChanged = true;
  }

  /** while a note's paragraphs are written: the control its own mark is (the original note's hp:autoNum) */
  noteMarkXml: string | null = null;
  /** notes made here, with their number among the notes of their kind (document order) */
  newNotes = new Map<NoteRef, number>();
  private nextNoteId = 1980000000;
  private isNewNote = (n: NoteRef | undefined) => !!n && n.src == null && this.newNotes.has(n);
  /** 한글's footnote / endnote control of a note made here, its paragraphs written as new paragraphs */
  private newNoteXml(note: NoteRef): string {
    const n = this.newNotes.get(note) ?? 1;
    const tag = note.kind === "end" ? "hp:endNote" : "hp:footNote";
    const was = this.noteMarkXml;
    this.noteMarkXml = `<hp:ctrl><hp:autoNum num="${n}" numType="${note.kind === "end" ? "ENDNOTE" : "FOOTNOTE"}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl>`;
    try {
      const ps = (note.paras.length ? note.paras : [newParagraph("")]).map((q) => this.freshPara(q)).join("");
      return `<hp:ctrl><${tag} number="${n}" suffixChar="41" instId="${this.nextNoteId++}"><hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${ps}</hp:subList></${tag}></hp:ctrl>`;
    } finally {
      this.noteMarkXml = was;
    }
  }

  /** rewritten paragraphs that had tracked changes (written accepted) / memos (not written: stage 2) */
  private trackedParas = new Set<string>();
  private memoParas = new Set<string>();

  /** memos and tracked changes written from the model (model 9 on, stage 2: hwpxReview.ts) */
  review: HwpxReview | null = null;

  /**
   * Runs of a paragraph with its memo fields (begun where a memo's text starts, ended after its last character) and its
   * tracked changes as 한글's marks inside hp:t (the paragraph mark's change on the last one, paraend="1").
   */
  private reviewRunsXml(p: TextParagraph, near: string[], R: HwpxReview): string {
    // (memos on no text at their place: QA hwpx-memo)
    const pts = withPoints(markedBodyRuns(p).filter((r) => r.text && (!r.note || this.isNewNote(r.note))), R.points(p), (r) => !r.noteMark);
    const runs = pts.runs;
    const pointXml = (ids: string[] | undefined) => (ids ?? []).map((id) => R.beginXml(id) + R.endXml(id)).join("");
    const kindOf = (rev?: Revision): "insert" | "delete" | null => (!rev ? null : rev.kind === "ins" || rev.kind === "moveTo" ? "insert" : rev.kind === "del" || rev.kind === "moveFrom" ? "delete" : null);
    const markKind = kindOf(p.markRev);
    const markOnly = (): string => {
      if (!markKind) return "";
      const id = R.markId(), tc = R.tcId(p.markRev!, markKind);
      return `<hp:${markKind}Begin Id="${id}" TcId="${tc}"/><hp:${markKind}End Id="${id}" TcId="${tc}" paraend="1"/>`;
    };
    if (!runs.length) {
      const cp = this.charFor(p.runs[0] ?? { ...DEFAULT_RUN, fontSize: 10 * PT }, near);
      const m = markOnly();
      const pt = pointXml(pts.tail);
      return m || pt ? `<hp:run charPrIDRef="${cp}">${pt}${m ? `<hp:t>${m}</hp:t>` : ""}</hp:run>` : `<hp:run charPrIDRef="${cp}"/>`;
    }
    const nb = R.neighbours.get(p) ?? { before: [], after: [] };
    // (a link: 한글's hyperlink field around its runs, office.ts hwpxLinked)
    return hwpxLinked(
      runs,
      (r, k) => {
        const cs = r.comments ?? [];
        const prev = k > 0 ? runs[k - 1].comments ?? [] : nb.before;
        const next = k < runs.length - 1 ? runs[k + 1].comments ?? [] : nb.after;
        const begins = cs.filter((id) => !prev.includes(id)).map((id) => R.beginXml(id)).join("");
        const ends = [...cs].reverse().filter((id) => !next.includes(id)).map((id) => R.endXml(id)).join("");
        const last = k === runs.length - 1;
        let text = hwpxText(r.text);
        const kind = kindOf(r.rev);
        let markDone = false;
        if (kind) {
          const id = R.markId(), tc = R.tcId(r.rev!, kind);
          const pe = last && markKind === kind;
          markDone = pe;
          text = `<hp:${kind}Begin Id="${id}" TcId="${tc}"/>${text}<hp:${kind}End Id="${id}" TcId="${tc}" paraend="${pe ? 1 : 0}"/>`;
        }
        if (last && !markDone) text += markOnly();
        // (덧말: 한글's hp:dutmal, office.ts hwpxDutmalXml; a caption number: 한글's automatic 그림 / 표 / 수식 number)
        const seq = r.field === "seq" && !kind ? hwpxSeqNum(r) : null;
        const body = r.note ? this.newNoteXml(r.note) : r.noteMark && this.noteMarkXml ? this.noteMarkXml : r.ruby && !kind ? hwpxDutmalXml(r) : seq ? seq + (text !== hwpxText(r.text) ? `<hp:t>${text.replace(hwpxText(r.text), "")}</hp:t>` : "") : `<hp:t>${text}</hp:t>`;
        return `<hp:run charPrIDRef="${this.charFor(r, near)}">${pointXml(pts.before.get(k))}${begins}${body}${ends}${last ? pointXml(pts.tail) : ""}</hp:run>`;
      },
      (x) => `<hp:run charPrIDRef="${this.charFor(runs[0], near)}">${x}</hp:run>`,
    );
  }

  private runsXml(p: TextParagraph, near: string[]): string {
    if (this.review) return this.reviewRunsXml(p, near, this.review);
    // (a note reference stays the original control of its paragraph; a note's own mark is its automatic number)
    // tracked changes come out accepted: deleted text left out, inserted text as text (core/review.ts)
    if (p.runs.some((r) => r.rev || r.fmtRev)) this.trackedParas.add(p.id);
    if (p.runs.some((r) => r.comments?.length)) this.memoParas.add(p.id);
    const runs = markedBodyRuns(p).filter((r) => r.text && (!r.note || this.isNewNote(r.note)) && !isRemoved(r));
    if (!runs.length) return `<hp:run charPrIDRef="${this.charFor(p.runs[0] ?? { ...DEFAULT_RUN, fontSize: 10 * PT }, near)}"/>`;
    // (a link: 한글's hyperlink field around its runs, office.ts hwpxLinked; a note made here: its control)
    return hwpxLinked(runs, (r) => `<hp:run charPrIDRef="${this.charFor(r, near)}">${r.note ? this.newNoteXml(r.note) : r.noteMark && this.noteMarkXml ? this.noteMarkXml : r.ruby ? hwpxDutmalXml(r) : (r.field === "seq" && hwpxSeqNum(r)) || `<hp:t>${hwpxText(r.text)}</hp:t>`}</hp:run>`, (x) => `<hp:run charPrIDRef="${this.charFor(runs[0], near)}">${x}</hp:run>`);
  }

  /** A note's text written anew inside its control (instId `src`) in a section's paragraphs; null when not there. */
  patchNote(body: string, src: string, note: NoteRef): string | null {
    const tag = note.kind === "end" ? "endNote" : "footNote";
    const m = new RegExp(`(<hp:${tag}\\b[^>]*\\binstId="${src.replace(/[^\w-]/g, "")}"[^>]*>\\s*<hp:subList\\b[^>]*>)([\\s\\S]*?)(</hp:subList>\\s*</hp:${tag}>)`).exec(body);
    if (!m) return null;
    if (m[2].includes("<hp:subList")) throw new SurgeryUnavailable("note with objects");
    const was = this.lastPP;
    this.noteMarkXml = /<hp:ctrl><hp:autoNum\b[\s\S]*?<\/hp:autoNum><\/hp:ctrl>/.exec(m[2])?.[0] ?? null;
    try {
      // each paragraph in the shapes of the original note's paragraphs and runs (new shapes only for new formats)
      const opens = Array.from(m[2].matchAll(/<hp:p\b[^>]*>/g), (x) => x[0]);
      const near = [...new Set(Array.from(m[2].matchAll(/charPrIDRef="(\d+)"/g), (x) => x[1]))];
      const inner = note.paras
        .map((p, i) => {
          const o = opens[Math.min(i, opens.length - 1)] ?? "";
          const v = this.paraFor(p, attrOf(o, "paraPrIDRef") ?? this.lastPP, attrOf(o, "styleIDRef") ?? "0");
          return `<hp:p id="${this.nextPid++}" paraPrIDRef="${v.pp}" styleIDRef="${v.st}" pageBreak="0" columnBreak="${p.colBreak === "before" ? 1 : 0}" merged="0">${this.runsXml(p, near)}</hp:p>`;
        })
        .join("");
      return body.slice(0, m.index) + m[1] + inner + m[3] + body.slice(m.index + m[0].length);
    } finally {
      this.noteMarkXml = null;
      this.lastPP = was;
    }
  }

  // ── tables ──

  private bfIds = new Map<string, string>();
  private nextTblId = 1970000000;
  /** id of a border fill with this border colour and cell fill (added to the header the first time) */
  private borderFillOf(border: string, fill: string | null): string {
    const k = `${border}|${fill ?? ""}`;
    let id = this.bfIds.get(k);
    if (!id) this.bfIds.set(k, (id = this.append("borderFills", "borderFill", (x) => borderFill(Number(x), border, fill))));
    return id;
  }

  /** A new table (made here) in a paragraph of its own, as the full writer writes it (office.ts hwpxTblXml). */
  freshTable(t: TableNode): string {
    const tbl = hwpxTblXml(t, { id: this.nextTblId++, para: (p) => this.freshPara(p), bf: (b, f) => this.borderFillOf(b, f) });
    const holder = this.freshPara({ id: "", runs: [], align: "LEFT", lineSpacing: 1, indent: 0, spaceAfter: 4 });
    return injectHwpxRuns(holder, `<hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run>`);
  }

  // ── paragraphs ──

  freshPara(p: TextParagraph): string {
    const { pp, st } = this.paraFor(p, this.lastPP, "0");
    this.lastPP = pp;
    return `<hp:p id="${this.nextPid++}" paraPrIDRef="${pp}" styleIDRef="${st}" pageBreak="0" columnBreak="${p.colBreak === "before" ? 1 : 0}" merged="0">${this.runsXml(p, [])}</hp:p>`;
  }

  /**
   * A changed paragraph written into its original hp:p: attributes kept (paragraph shape replaced when the
   * format changed), controls kept in leading runs, text runs written anew, line layout cache dropped.
   * `settingsOnly`: the paragraph's content was deleted — only its section / page settings stay.
   */
  rewritePara(s: string, p: TextParagraph, el: XmlEl, orig: { kind: "p"; p: TextParagraph } | null, settingsOnly = false): string {
    let open = el.openEnd === el.end ? s.slice(el.start, el.end - 2).trimEnd() + ">" : s.slice(el.start, el.openEnd);
    const pp = attrOf(open, "paraPrIDRef") ?? "0", st = attrOf(open, "styleIDRef") ?? "0";
    if (!settingsOnly && orig && paraFp(p) === paraFp(orig.p) && !this.relist.at.has(p)) {
      this.lastPP = pp;
      return this.text(s, el);
    }
    if (!settingsOnly) {
      const v = this.paraFor(p, pp, st);
      open = open.replace(/\sparaPrIDRef="[^"]*"/, ` paraPrIDRef="${v.pp}"`).replace(/\sstyleIDRef="[^"]*"/, ` styleIDRef="${v.st}"`);
      // 단 나누기 before the paragraph (한글 columnBreak) as the model has it
      if ((orig?.p.colBreak === "before") !== (p.colBreak === "before")) open = open.replace(/\scolumnBreak="[^"]*"/, ` columnBreak="${p.colBreak === "before" ? 1 : 0}"`);
      this.lastPP = v.pp;
    }
    let lead = "";
    let other = "";
    const near: string[] = [];
    let textSeen = false;
    for (const c of childrenOf(s, el)) {
      if (c.local === "linesegarray") continue; // 한글 lays the paragraph out again
      if (c.local !== "run") {
        other += s.slice(c.start, c.end);
        continue;
      }
      const tag = s.slice(c.start, c.openEnd);
      const cp = attrOf(tag, "charPrIDRef") ?? "0";
      const kids = childrenOf(s, c);
      if (kids.some((k) => TEXT_KIDS.has(k.local))) {
        textSeen = true;
        if (!near.includes(cp)) near.push(cp);
      }
      let keep = kids.filter((k) => !TEXT_KIDS.has(k.local));
      // (stage 2: memo fields are written from the model where their text is; a memo on no text of the paragraph — at a
      // point — stays a control at the paragraph start; a deleted memo goes)
      if (this.review) {
        const R = this.review;
        const onRuns = new Set(p.runs.flatMap((r) => r.comments ?? []));
        keep = keep.filter((k) => {
          if (k.local !== "ctrl") return true;
          const fs = childrenOf(s, k).filter((x) => x.local === "fieldBegin" || x.local === "fieldEnd");
          if (!fs.length) return true;
          const id = (x: XmlEl) => attrOf(s.slice(x.start, x.openEnd), x.local === "fieldBegin" ? "id" : "beginIDRef") ?? "";
          const memo = fs.every((x) => (x.local === "fieldBegin" ? attrOf(s.slice(x.start, x.openEnd), "type") === "MEMO" : R.isOrigMemo(id(x))));
          if (!memo) return true;
          return fs.every((x) => R.has(id(x)) && !onRuns.has(id(x)));
        });
      }
      // (model 10: a 그림 / 표 / 수식 number is a SEQ field run of the model, written where it is — not kept here)
      if (this.sheet) keep = keep.filter((k) => !(k.local === "ctrl" && childrenOf(s, k).length === 1 && childrenOf(s, k)[0].local === "autoNum" && /\snumType="(PICTURE|TABLE|EQUATION)"/.test(s.slice(childrenOf(s, k)[0].start, childrenOf(s, k)[0].openEnd))));
      if (settingsOnly) keep = keep.filter((k) => k.local === "secPr" || (k.local === "ctrl" && childrenOf(s, k).every((x) => PAGE_CTRLS.has(x.local))));
      if (!keep.length) continue;
      // a field (hyperlink, cross reference…) around text cannot be placed again in stage 1
      if (!settingsOnly && keep.some((k) => k.local === "ctrl" && childrenOf(s, k).some((x) => x.local === "fieldBegin" || x.local === "fieldEnd")) && textSeen) throw new SurgeryUnavailable("field");
      if (!settingsOnly && keep.some((k) => !LEADING_OK.has(k.local) || (k.local === "ctrl" && !childrenOf(s, k).every((x) => PAGE_CTRLS.has(x.local))))) this.moved++;
      lead += `<hp:run charPrIDRef="${cp}">${keep.map((k) => s.slice(k.start, k.end)).join("")}</hp:run>`;
    }
    if (!near.length) near.push(...childrenOf(s, el).filter((c) => c.local === "run").map((c) => attrOf(s.slice(c.start, c.openEnd), "charPrIDRef") ?? "0").slice(0, 1));
    const runs = settingsOnly ? "" : this.runsXml(p, near);
    return `${open}${lead}${runs}${settingsOnly ? "" : other}</${el.name}>`;
  }

  // ── tables ──

  /** A paragraph holding tables (its own text unchanged): only the changed cells of each table are rewritten. */
  rewriteTables(s: string, el: XmlEl, items: FlowItem[], bl: OfficeSourceBlock, origs: OfficeItem[]): string {
    // tables of this paragraph in order (not the ones nested in cells)
    const tbls = childrenOf(s, el)
      .filter((c) => c.local === "run")
      .flatMap((r) => childrenOf(s, r).filter((k) => k.local === "tbl"));
    const tableItems = items.map((it, k) => ({ it, k })).filter((x) => x.it.kind === "table");
    if (tbls.length !== tableItems.length) throw new SurgeryUnavailable("tables");
    // anything but tables changed (a text box, the paragraph text): not in stage 1
    for (const { it, k } of items.map((it, k) => ({ it, k }))) if (it.kind === "p" && (itemFp(it) !== bl.fp[k] || itemRelisted(it, this.relist))) throw new SurgeryUnavailable("object paragraph");
    let out = "";
    let at = el.start;
    tableItems.forEach(({ it, k }, n) => {
      if (itemFp(it) === bl.fp[k] && !itemRelisted(it, this.relist)) return;
      const tb = (it as { kind: "table"; t: TableNode }).t;
      const og = origs[k];
      if (og.kind !== "table") throw new SurgeryUnavailable("table");
      const el2 = tbls[n];
      out += s.slice(at, el2.start) + this.rewriteTable(s, tb, el2, og.table, bl.tp?.[k] ?? "");
      at = el2.end;
    });
    out += s.slice(at, el.end);
    // the paragraph's line layout cache covers the table height: dropped as well
    // (only the paragraph's own — the last one: a lazy match from the first would take the cells' paragraphs with it)
    return out.replace(/<hp:linesegarray>(?:(?!<hp:linesegarray>)[\s\S])*?<\/hp:linesegarray>(?=<\/hp:p>$)/, "");
  }

  private rewriteTable(s: string, tb: TableNode, el: XmlEl, orig: OfficeTable, importKey: string): string {
    const merged = (rows: TableCell[][]) => rows.some((r) => r.some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1));
    const same = !merged(tb.rows) && !merged(orig.rows) && tableKey(tb) === importKey && tb.rows.length === orig.rows.length && tb.rows.every((r, i) => r.length === orig.rows[i].length);
    if (!same) {
      // a table nested in a cell (hp:tbl inside an hp:tc): the new file writes the cells from the model, which reads
      // its paragraphs flat — said before the save, never dropped silently
      const nested = childrenOf(s, el).filter((c) => c.local === "tr").flatMap((tr) => childrenOf(s, tr).filter((c) => c.local === "tc")).filter((tc) => descendantsNamed(s, tc, "tbl").length).length;
      const reshaped = nested ? this.reshapeTable(s, tb, el, orig, importKey) : null;
      if (reshaped !== null) return reshaped;
      throw new SurgeryUnavailable("table shape", nested ? [tn("engine.officeSurgeon.nestedLost", nested)] : []);
    }
    // the table's own cells (rows → cells), not the cells of tables nested in them
    const byAddr = new Map<string, XmlEl>();
    for (const tr of childrenOf(s, el).filter((c) => c.local === "tr"))
      for (const tc of childrenOf(s, tr).filter((c) => c.local === "tc")) {
        const addr = childrenOf(s, tc).find((c) => c.local === "cellAddr");
        const tag = addr ? s.slice(addr.start, addr.openEnd) : "";
        byAddr.set(`${attrOf(tag, "rowAddr")}:${attrOf(tag, "colAddr")}`, tc);
      }
    let out = "";
    let at = el.start;
    const edits: { tc: XmlEl; xml: string }[] = [];
    tb.rows.forEach((row, ri) =>
      row.forEach((cell, ci) => {
        const was = orig.rows[ri][ci];
        if (cellFp(cell) === cellFp(was) && !(cellParas(cell) ?? []).some((p) => this.relist.at.has(p))) return;
        if ((cell.fill ?? null) !== (was.fill ?? null) || !!cell.bold !== !!was.bold || !!cell.italic !== !!was.italic || (cell.align ?? null) !== (was.align ?? null)) this.looks++;
        const tc = byAddr.get(`${ri}:${ci}`);
        if (!tc) throw new SurgeryUnavailable("cell");
        edits.push({ tc, xml: this.rewriteCell(s, tb, cell, ri === 0 && tb.headerRow, tc, was) });
      }),
    );
    edits.sort((a, b) => a.tc.start - b.tc.start);
    for (const e of edits) {
      out += s.slice(at, e.tc.start) + e.xml;
      at = e.tc.end;
    }
    return out + s.slice(at, el.end);
  }

  /**
   * The outer table rebuilt in place after a row / column change or a merge when cells hold a table (hp:tbl in a cell
   * paragraph), which the new file would keep as text only. Each original hp:tc goes at most once, as it is, into the
   * new cell with the same content (spans aside): cells holding a table first, then unchanged cells. A new or edited
   * cell is a copy of the nearest plain original cell with its paragraphs rewritten under new paragraph ids. Only the
   * outer table's rowCnt / colCnt / hp:sz and each cell's cellAddr / cellSpan / cellSz change; nested tables keep their
   * ids (each written once). A nested table that finds no cell while its text is still in the table is reported
   * (nestedLost); one whose row or column was removed goes with it. null: not safe here (table format changed, cell
   * zones, no plain cell to copy) — the caller writes the new file and says so.
   */
  private reshapeTable(s: string, tb: TableNode, el: XmlEl, orig: OfficeTable, importKey: string): string | null {
    if (tableKey({ ...tb, colWidths: orig.colWidths }) !== importKey) return null;
    const trs = childrenOf(s, el).filter((c) => c.local === "tr");
    if (!trs.length || !tb.rows.length || !tb.colWidths.length) return null;
    const lead = s.slice(el.openEnd, trs[0].start);
    if (/<hp:cellzoneList\b/.test(lead)) return null;
    const tagOf = (k: XmlEl | undefined) => (k ? s.slice(k.start, k.openEnd) : "");
    const fp = (c: TableCell) => cellFp({ ...c, colSpan: undefined, rowSpan: undefined });
    type Src = { tc: XmlEl; sub: XmlEl; r: number; c: number; cell: TableCell; fp: string; nested: boolean; plain: boolean; h: number; text: string };
    const srcs: Src[] = [];
    for (const tr of trs)
      for (const tc of childrenOf(s, tr).filter((k) => k.local === "tc")) {
        const kids = childrenOf(s, tc);
        const sub = kids.find((k) => k.local === "subList");
        const addr = tagOf(kids.find((k) => k.local === "cellAddr"));
        const span = tagOf(kids.find((k) => k.local === "cellSpan"));
        const sz = tagOf(kids.find((k) => k.local === "cellSz"));
        if (!sub || !addr || !span || !sz) return null;
        const r = Number(attrOf(addr, "rowAddr")), c = Number(attrOf(addr, "colAddr"));
        const cell = orig.rows[r]?.[c];
        if (!cell) return null;
        const rs = Math.max(1, Number(attrOf(span, "rowSpan")) || 1);
        const nested = descendantsNamed(s, tc, "tbl").length > 0;
        const t = /<hp:t(?:\s[^>]*)?>([^<]+)<\/hp:t>/.exec(s.slice(sub.start, sub.end))?.[1] ?? "";
        srcs.push({
          tc,
          sub,
          r,
          c,
          cell,
          fp: fp(cell),
          nested,
          plain: !nested && !childrenOf(s, sub).some((p) => p.local === "p" && holdsObjects(s, p)),
          h: (Number(attrOf(sz, "height")) || 0) / rs,
          text: t.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"),
        });
      }
    if (!srcs.length) return null;
    const cover = coverMap(tb.rows);
    const cells = tb.rows.flatMap((row, ri) => row.map((cell, ci) => ({ cell, ri, ci }))).filter((x) => !cover[x.ri][x.ci]);
    const used = new Set<Src>();
    const pick = new Map<TableCell, Src>();
    for (const nested of [true, false])
      for (const { cell } of cells) {
        const ps = cellParas(cell);
        if (pick.has(cell) || !ps?.length || ps.some((p) => this.relist.at.has(p))) continue;
        const f = fp(cell);
        const k = srcs.find((x) => !used.has(x) && x.nested === nested && x.fp === f);
        if (k) {
          used.add(k);
          pick.set(cell, k);
        }
      }
    const plain = srcs.filter((x) => x.plain);
    if (cells.some(({ cell }) => !pick.has(cell)) && !plain.length) return null;
    const dist = (x: Src, ri: number, ci: number) => Math.abs(x.r - ri) + Math.abs(x.c - ci);
    const near = (ri: number, ci: number) => plain.reduce((a, b) => (dist(b, ri, ci) < dist(a, ri, ci) ? b : a));
    // row heights: the tallest cell (per row it spans) placed in the row, else the original average
    const avg = srcs.reduce((a, x) => a + x.h, 0) / srcs.length || 1000;
    const rowH = tb.rows.map(() => 0);
    for (const { cell, ri, ci } of cells) rowH[ri] = Math.max(rowH[ri], (pick.get(cell) ?? near(ri, ci)).h);
    for (let i = 0; i < rowH.length; i++) if (!(rowH[i] > 0)) rowH[i] = avg;
    const colW = tb.colWidths.map((w) => Math.max(1, Math.round(w * 75)));
    const setAttrs = (x: string, tag: string, kv: Record<string, number>) =>
      x.replace(new RegExp(`<hp:${tag}\\b[^>]*>`), (m) => Object.entries(kv).reduce((a, [k, v]) => a.replace(new RegExp(`(\\s${k}=")[^"]*"`), `$1${v}"`), m));
    const place = (tail: string, ri: number, ci: number) => {
      const { cs, rs } = spanOf(tb.rows, ri, ci);
      const w = colW.slice(ci, ci + cs).reduce((a, b) => a + b, 0);
      const h = Math.round(rowH.slice(ri, ri + rs).reduce((a, b) => a + b, 0));
      return setAttrs(setAttrs(setAttrs(tail, "cellAddr", { colAddr: ci, rowAddr: ri }), "cellSpan", { colSpan: cs, rowSpan: rs }), "cellSz", { width: w, height: h });
    };
    const trOpen = s.slice(trs[0].start, trs[0].openEnd);
    const body = tb.rows
      .map((row, ri) => {
        const tcs = row.map((cell, ci) => {
          if (cover[ri][ci]) return "";
          const k = pick.get(cell);
          if (k) return s.slice(k.tc.start, k.sub.end) + place(s.slice(k.sub.end, k.tc.end), ri, ci);
          const src = near(ri, ci);
          const x = this.rewriteCell(s, tb, cell, ri === 0 && tb.headerRow, src.tc, src.cell);
          const tail = s.slice(src.sub.end, src.tc.end);
          // a copied cell's paragraphs get new ids (the original keeps its own)
          const inner = x.slice(0, x.length - tail.length).replace(/<hp:p\b([^>]*?)\sid="[^"]*"/g, (_m, a: string) => `<hp:p${a} id="${this.nextPid++}"`);
          return inner + place(tail, ri, ci);
        });
        return `${trOpen}${tcs.join("")}</hp:tr>`;
      })
      .join("");
    for (const h of srcs) if (h.nested && !used.has(h) && !(!!h.text && !tb.rows.some((r) => r.some((c) => c.text.includes(h.text))))) this.nestedLost++;
    const open = s
      .slice(el.start, el.openEnd)
      .replace(/(\srowCnt=")[^"]*"/, `$1${tb.rows.length}"`)
      .replace(/(\scolCnt=")[^"]*"/, `$1${colW.length}"`);
    const size = { width: colW.reduce((a, b) => a + b, 0), height: Math.round(rowH.reduce((a, b) => a + b, 0)) };
    return open + setAttrs(lead, "sz", size) + body + s.slice(trs[trs.length - 1].end, el.end);
  }

  /** One changed hp:tc: everything kept but the paragraphs of its subList. */
  private rewriteCell(s: string, tb: TableNode, cell: TableCell, header: boolean, tc: XmlEl, was: TableCell): string {
    const sub = childrenOf(s, tc).find((c) => c.local === "subList");
    if (!sub) throw new SurgeryUnavailable("subList");
    const ops = childrenOf(s, sub).filter((c) => c.local === "p");
    if (ops.some((p) => holdsObjects(s, p))) throw new SurgeryUnavailable("nested object");
    const origParas = cellParas(was) ?? [];
    const paras = cellParagraphs(cell, origParas) ?? cell.text.split("\n").map((line) => tableLine(tb, cell, header, line));
    const inner = paras.map((p, k) => (ops[k] ? this.rewritePara(s, p, ops[k], origParas[k] ? { kind: "p", p: origParas[k] } : null) : this.freshPara(p))).join("");
    const subOpen = sub.openEnd === sub.end ? s.slice(sub.start, sub.end - 2).trimEnd() + ">" : s.slice(sub.start, sub.openEnd);
    return s.slice(tc.start, sub.start) + subOpen + inner + `</${sub.name}>` + s.slice(sub.end, tc.end);
  }
}

/** a plain cell line written with the table's look */
const tableLine = (tb: TableNode, cell: TableCell, header: boolean, line: string): TextParagraph => ({
  id: "",
  runs: [{ ...DEFAULT_RUN, text: line, fontFamily: tb.fontFamily, fontSize: tb.fontSize, bold: !!cell.bold || header, italic: !!cell.italic, color: cell.color ?? tb.color }],
  align: cell.align ?? "LEFT",
  lineSpacing: TABLE_LINE,
  indent: 0,
  spaceAfter: 0,
});

/** hh:charPr `base` copied under a new id with the run's properties that differ from `was` */
function cloneCharPr(base: string, id: string, was: TextRun, r: TextRun, fontId: (lang: string) => number): string {
  let x = base.replace(/^(<hh:charPr\b[^>]*?\s)id="[^"]*"/, `$1id="${id}"`);
  const setAttr = (tag: string, name: string, v: string) => {
    x = x.replace(new RegExp(`(<hh:${tag}\\b[^>]*?\\s${name}=")[^"]*"`), `$1${v}"`);
  };
  const setFlag = (name: string, on: boolean) => {
    const has = new RegExp(`<hh:${name}\\s*/>`).test(x);
    if (on && !has) {
      // CT_CharPr order: … offset, italic, bold, underline, strikeout, outline, shadow, emboss, engrave, supscript, subscript
      const after = (name === "italic" ? ["bold"] : []).concat(["underline", "strikeout", "outline", "shadow", "emboss", "engrave", "supscript", "subscript"]);
      const at = after.map((t) => x.search(new RegExp(`<hh:${t}\\b`))).find((i) => i >= 0) ?? x.lastIndexOf("</hh:charPr>");
      if (at >= 0) x = x.slice(0, at) + `<hh:${name}/>` + x.slice(at);
    }
    if (!on && has) x = x.replace(new RegExp(`<hh:${name}\\s*/>`), "");
  };
  if (r.fontSize !== was.fontSize) setAttr("charPr", "height", String(Math.round((r.fontSize / PT) * 100)));
  if (r.color.toLowerCase() !== was.color.toLowerCase()) setAttr("charPr", "textColor", r.color.slice(0, 7).toUpperCase());
  if ((r.highlight ?? null) !== (was.highlight ?? null)) setAttr("charPr", "shadeColor", r.highlight ? r.highlight.slice(0, 7).toUpperCase() : "none");
  if (r.fontFamily !== was.fontFamily)
    for (const l of LANGS) {
      const lc = l.toLowerCase();
      x = x.replace(new RegExp(`(<hh:fontRef\\b[^>]*?\\s${lc}=")[^"]*"`), `$1${fontId(l)}"`);
    }
  if (!!r.bold !== !!was.bold) setFlag("bold", !!r.bold);
  if (!!r.italic !== !!was.italic) setFlag("italic", !!r.italic);
  if (!!r.underline !== !!was.underline) setAttr("underline", "type", r.underline ? "BOTTOM" : "NONE");
  if (!!r.strike !== !!was.strike) setAttr("strikeout", "shape", r.strike ? "SOLID" : "NONE");
  if ((r.script ?? null) !== (was.script ?? null)) {
    x = x.replace(/<hh:(supscript|subscript)\s*\/>/g, "");
    if (r.script) x = x.replace(/(<\/hh:charPr>)$/, `<hh:${r.script === "super" ? "supscript" : "subscript"}/>$1`);
  }
  if ((r.letterSpacing ?? 0) !== (was.letterSpacing ?? 0) || (r.spacingPct ?? 0) !== (was.spacingPct ?? 0)) {
    // 자간: % of each character's advance (TextRun.spacingPct); an absolute letterSpacing is added as % of the size
    const sp = Math.max(-50, Math.min(50, Math.round((r.spacingPct ?? 0) + (r.letterSpacing ? (r.letterSpacing / r.fontSize) * 100 : 0))));
    for (const l of LANGS) x = x.replace(new RegExp(`(<hh:spacing\\b[^>]*?\\s${l.toLowerCase()}=")[^"]*"`), `$1${sp}"`);
  }
  if ((r.hscale ?? 100) !== (was.hscale ?? 100)) {
    const ratio = Math.max(50, Math.min(200, Math.round(r.hscale ?? 100)));
    for (const l of LANGS) x = x.replace(new RegExp(`(<hh:ratio\\b[^>]*?\\s${l.toLowerCase()}=")[^"]*"`), `$1${ratio}"`);
  }
  return x;
}

/** hh:paraPr `base` copied under a new id with the paragraph's alignment, margins, line spacing (and heading) */
function cloneParaPr(base: string, id: string, p: TextParagraph, head: { type: string; idRef: number; level: number } | null): string {
  const hu = (px: number) => String(Math.round((px / PT) * 100));
  let x = base.replace(/^(<hh:paraPr\b[^>]*?\s)id="[^"]*"/, `$1id="${id}"`);
  x = x.replace(/(<hh:align\b[^>]*?\shorizontal=")[^"]*"/, `$1${p.align}"`);
  // every copy of the margins: HWPUNIT in hp:case and unwrapped, twice that in hp:default (office.ts hwpxHeaderMaps)
  const margins = (s: string, k: number) =>
    s
      .replace(/(<hc:intent\b[^>]*?\svalue=")[^"]*"/g, `$1${Number(hu(p.indent)) * k}"`)
      .replace(/(<hc:left\b[^>]*?\svalue=")[^"]*"/g, `$1${Number(hu(hwpxLeftOut(p))) * k}"`)
      .replace(/(<hc:next\b[^>]*?\svalue=")[^"]*"/g, `$1${Number(hu(p.spaceAfter)) * k}"`)
      .replace(/(<hc:prev\b[^>]*?\svalue=")[^"]*"/g, `$1${Number(hu(p.spaceBefore ?? 0)) * k}"`)
      .replace(/(<hc:right\b[^>]*?\svalue=")[^"]*"/g, `$1${Number(hu(p.indentRight ?? 0)) * k}"`);
  x = x
    .split(/(<hp:default>[\s\S]*?<\/hp:default>)/)
    .map((s) => margins(s, s.startsWith("<hp:default>") ? 2 : 1))
    .join("");
  // line spacing: PERCENT, or FIXED / AT_LEAST / BETWEEN_LINES in HWPUNIT (twice that inside hp:default, like margins)
  const ls = hwpxLineSpacing(p);
  x = x
    .split(/(<hp:default>[\s\S]*?<\/hp:default>)/)
    .map((s) => {
      const k = s.startsWith("<hp:default>") && ls.type !== "PERCENT" ? 2 : 1;
      return s.replace(/<hh:lineSpacing\b[^>]*\/>/g, (m) => m.replace(/\stype="[^"]*"/, ` type="${ls.type}"`).replace(/\svalue="[^"]*"/, ` value="${ls.value * k}"`));
    })
    .join("");
  // keep with next (headings always, as 한글's outline shapes), keep lines, page break before
  const heading = /^h[1-6]$/.test(p.role ?? "");
  x = x.replace(/<hh:breakSetting\b[^>]*\/>/, (m) =>
    m
      .replace(/(\skeepWithNext=")[^"]*"/, `$1${p.keepNext || (heading && /\skeepWithNext="1"/.test(m)) ? 1 : 0}"`)
      .replace(/(\skeepLines=")[^"]*"/, `$1${p.keepLines ? 1 : 0}"`)
      .replace(/(\spageBreakBefore=")[^"]*"/, `$1${p.pageBreakBefore ? 1 : 0}"`),
  );
  if (head) x = x.replace(/<hh:heading\b[^>]*\/>/, `<hh:heading type="${head.type}" idRef="${head.idRef}" level="${head.level}"/>`);
  return x;
}
