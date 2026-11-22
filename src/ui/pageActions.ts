// Page organising: reorder / delete / duplicate / rotate / resize several pages at once, insert
// blank pages or pages from other files at a chosen position, extract and split to PDF, and
// "many files → one PDF". Every document change is one store.commit (undoable, in the history).

import { docFileStem } from "../io/exportName";
import { chunkPages, insertionIndex, moveIdsTo, parsePageRanges, rangeLabel, resizePageInPlace, rotatePageInPlace, type InsertWhere } from "../core/pages";
import { useStore } from "../core/store";
import { PAGE_PRESETS, copyNode, newDocument, newPage, newRaster, uid, type AssetRef, type OmwDocument, type Page, type PageKind } from "../core/types";
import { exportPdf } from "../io/export";
import { openFiles, saveFile, type OpenedFile } from "../io/platform";
import { zipFiles } from "../io/tools/imageTools";
import { getSecret } from "../io/crypto/session";
import { encryptPdf } from "../io/crypto/pdfEncrypt";
import { openFilters } from "../io/formats";
import { fileToPages, fitCurrent, importFile, pickPages, protectOutput } from "./actions";
import { useUI } from "./shell/uiStore";
import { t } from "../i18n";
import { SAVE_CANCELLED } from "../io/errors";

const S = () => useStore.getState();
/** count message: `<key>_one` when n is 1 (English singular), `<key>` otherwise */
const tn = (key: string, n: number, vars: Record<string, string | number> = {}) => t(n === 1 ? `${key}_one` : key, { n, ...vars });

const indexOf = (id: string) => S().doc.pages.findIndex((p) => p.id === id);

/** selected ids in document order */
export function inDocOrder(ids: Iterable<string>): string[] {
  const set = new Set(ids);
  return S().doc.pages.filter((p) => set.has(p.id)).map((p) => p.id);
}

/** Move pages so they sit before the page that is now at `target` (target = page count → end). */
export function movePagesTo(ids: string[], target: number) {
  const s = S();
  const next = moveIdsTo(s.doc.pages, ids, target);
  if (next === s.doc.pages) return;
  s.commit(ids.length > 1 ? t("doc.history.movePages", { n: ids.length }) : t("doc.history.pageOrder"), (d) => {
    const order = new Map(next.map((p, i) => [p.id, i]));
    d.pages.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  });
}

export function deletePages(ids: string[]) {
  const s = S();
  const set = new Set(ids);
  const left = s.doc.pages.filter((p) => !set.has(p.id));
  if (!left.length) return S().notify(t("doc.toast.cannotDeleteAll"));
  if (left.length === s.doc.pages.length) return;
  const first = indexOf(inDocOrder(ids)[0]);
  s.commit(t("doc.history.deletePages", { n: ids.length }), (d) => {
    d.pages = d.pages.filter((p) => !set.has(p.id));
  });
  if (set.has(S().pageId)) S().set({ pageId: left[Math.min(first, left.length - 1)].id, selection: [] });
}

function clonePage(src: Page): Page {
  const idMap = new Map<string, string>();
  const nodes = src.nodes.map((n) => {
    const nid = uid();
    idMap.set(n.id, nid);
    return copyNode(n, nid);
  });
  return {
    ...src,
    id: uid("pg"),
    name: t("doc.copyName", { name: src.name }),
    nodes,
    animations: src.animations.map((a) => ({ ...a, id: uid("an"), targetNodeId: idMap.get(a.targetNodeId) ?? a.targetNodeId })),
  };
}

/** Duplicate each page right after itself. Returns the copies' ids. */
export function duplicatePages(ids: string[]): string[] {
  const s = S();
  const order = inDocOrder(ids);
  if (!order.length) return [];
  const copies = new Map(order.map((id) => [id, clonePage(s.doc.pages[indexOf(id)])]));
  s.commit(order.length > 1 ? t("doc.history.duplicatePages", { n: order.length }) : t("doc.history.duplicatePage"), (d) => {
    const out: Page[] = [];
    for (const p of d.pages as Page[]) {
      out.push(p);
      const c = copies.get(p.id);
      if (c) out.push(c);
    }
    d.pages = out as any;
  });
  return [...copies.values()].map((c) => c.id);
}

/** Quarter turn (see core/pages rotatePageInPlace for how each kind of page turns). */
export function rotatePages(ids: string[], dir: 1 | -1) {
  const set = new Set(ids);
  if (!set.size) return;
  S().commit(t(`doc.history.rotate${dir === 1 ? "Right" : "Left"}${set.size > 1 ? "N" : ""}`, { n: set.size }), (d) => {
    for (const p of d.pages) if (set.has(p.id)) rotatePageInPlace(p as any, dir);
  });
}

export function resizePages(ids: string[], width: number, height: number, scaleContent: boolean) {
  const set = new Set(ids);
  if (!set.size || !(width >= 16 && height >= 16 && width <= 16384 && height <= 16384)) return S().notify(t("doc.toast.pageSizeRange"));
  S().commit(t(set.size > 1 ? "doc.history.resizeN" : "doc.history.resize", { w: Math.round(width), h: Math.round(height), n: set.size }), (d) => {
    for (const p of d.pages) if (set.has(p.id)) resizePageInPlace(p as any, width, height, scaleContent);
  });
}

/** A blank page shaped like `like` (or A4) inserted at `at`. */
export function insertBlankPage(at: number, like?: Page | null): string {
  const s = S();
  const kind: PageKind = like && like.kind !== "MASTER" && like.kind !== "PDF" ? like.kind : "DOCUMENT";
  const w = like?.width ?? PAGE_PRESETS.A4.width, h = like?.height ?? PAGE_PRESETS.A4.height;
  const nameKey = kind === "SLIDE" ? "doc.pageName.SLIDE" : kind === "DOCUMENT" ? "doc.pageName.DOCUMENT" : "doc.pageName.DESIGN";
  const p = newPage(kind, w, h, t(nameKey, { n: s.doc.pages.filter((x) => x.kind === kind).length + 1 }));
  if (kind === "SLIDE") p.masterId = like?.masterId ?? null;
  if (kind === "DESIGN") p.nodes.push(newRaster());
  s.commit(t("doc.history.insertBlank"), (d) => {
    d.pages.splice(Math.max(0, Math.min(d.pages.length, at)), 0, p as any);
  });
  return p.id;
}

/** Ask for files and insert (some of) their pages at a position. Returns the inserted page ids. */
export async function insertFromFiles(where: InsertWhere, refIndex: number, range?: string): Promise<string[]> {
  const files = await openFiles(openFilters(), true);
  return insertFiles(files, insertionIndex(where, refIndex, S().doc.pages.length), range);
}

export async function insertFiles(files: OpenedFile[], at: number, range?: string): Promise<string[]> {
  const ids: string[] = [];
  let pos = at;
  for (const f of files) {
    const pages = await importFile(f, { at: pos, pages: range });
    pos += pages.length;
    ids.push(...pages.map((p) => p.id));
  }
  return ids;
}

// ───────── extract / split ─────────

const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_").trim() || t("doc.fileFallback");

async function pdfOf(doc: OmwDocument, pages: Page[], warnings: string[]): Promise<Uint8Array> {
  return exportPdf(doc, pages, { onWarning: (m) => warnings.push(m) });
}

/** Selected pages → one new PDF (PDF-origin pages are embedded as the original vector page). */
export async function extractPages(ids: string[]) {
  const s = S();
  const order = inDocOrder(ids);
  if (!order.length) return S().notify(t("doc.toast.pickToExtract"));
  const pages = order.map((id) => s.doc.pages[indexOf(id)]);
  const warnings: string[] = [];
  S().notify(tn("doc.toast.makingPdf", pages.length));
  try {
    const bytes = await pdfOf(s.doc, pages, warnings);
    const prot = await protectOutput("pdf", bytes);
    if (!prot) return S().notify(t("doc.toast.extractCancelled"));
    const label = rangeLabel(order.map(indexOf));
    const path = await saveFile(t("doc.file.extract", { title: safe(docFileStem(s.doc)), pages: label }), prot.bytes, [{ name: "PDF", extensions: ["pdf"] }]);
    if (path) S().notify(tn(prot.secretId ? "doc.toast.extractedProtected" : "doc.toast.extracted", pages.length));
  } catch (e: any) {
    if (e?.message === SAVE_CANCELLED) return S().notify(t("doc.toast.saveCancelled"));
    alert(t("doc.alert.extractFailed", { error: String(e?.message ?? e) }));
  }
}

export type SplitMode = { kind: "every"; n: number } | { kind: "ranges"; text: string };

/** Page groups for a split (zero-based indices into the document's pages). */
export function splitGroups(mode: SplitMode, total: number): { groups: number[][]; error?: string } {
  if (mode.kind === "every") return { groups: chunkPages(total, mode.n) };
  return parsePageRanges(mode.text, total);
}

/** Split the document into several PDFs and save them as one ZIP. */
export async function splitToZip(mode: SplitMode) {
  const s = S();
  const total = s.doc.pages.length;
  const { groups, error } = splitGroups(mode, total);
  if (error) return S().notify(error);
  if (!groups.length) return;
  const warnings: string[] = [];
  const files: { name: string; bytes: Uint8Array }[] = [];
  try {
    for (let i = 0; i < groups.length; i++) {
      S().notify(t("doc.toast.splitting", { i: i + 1, n: groups.length }));
      const pages = groups[i].map((k) => s.doc.pages[k]);
      files.push({ name: t("doc.file.splitPart", { title: safe(docFileStem(s.doc)), num: String(i + 1).padStart(2, "0"), pages: rangeLabel(groups[i]) }), bytes: await pdfOf(s.doc, pages, warnings) });
    }
    // a protected source asks once for the whole set; each PDF gets the same choice
    const first = await protectOutput("pdf", files[0].bytes);
    if (!first) return S().notify(t("doc.toast.splitCancelled"));
    files[0].bytes = first.bytes;
    if (first.secretId) for (let i = 1; i < files.length; i++) files[i].bytes = (await protectWith(files[i].bytes, first.secretId)) ?? files[i].bytes;
    const path = await saveFile(t("doc.file.splitZip", { title: safe(docFileStem(s.doc)), n: files.length }), zipFiles(files), [{ name: "ZIP", extensions: ["zip"] }]);
    if (path) S().notify(t("doc.toast.splitSaved", { n: files.length }));
  } catch (e: any) {
    if (e?.message === SAVE_CANCELLED) return S().notify(t("doc.toast.saveCancelled"));
    alert(t("doc.alert.splitFailed", { error: String(e?.message ?? e) }));
  }
}

async function protectWith(bytes: Uint8Array, secretId: string): Promise<Uint8Array | null> {
  const pw = getSecret(secretId);
  return pw ? encryptPdf(bytes, pw) : null;
}

// ───────── many files → one PDF ─────────

export interface CombineInput {
  name: string;
  bytes: Uint8Array;
  /** only these pages of the file ("1-3, 5"); all when empty */
  range?: string;
}

export interface CombineResult {
  bytes: Uint8Array;
  pages: number;
  files: number;
  warnings: string[];
  /** set when the result was password-protected */
  protectedWith: string | null;
}

/**
 * PDF, DOCX, HWPX, PPTX, XLSX, images, .omw … in the given order → one PDF, one bookmark per file.
 * Each file goes through the same import path as "open" (protected files ask for their password);
 * PDF pages are embedded as the original vector pages. The open document is not changed.
 * `protect`: ask for a password for the result.
 */
export async function combineToPdf(inputs: CombineInput[], opts: { protect?: boolean; onProgress?: (done: number, total: number, label?: string) => void } = {}): Promise<CombineResult | null> {
  if (!inputs.length) throw new Error(t("doc.err.noFilesToCombine"));
  const pages: Page[] = [];
  const assets: Record<string, AssetRef> = {};
  const outline: { title: string; page: number }[] = [];
  const warnings: string[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const f = inputs[i];
    opts.onProgress?.(i, inputs.length + 1, f.name);
    let got: Page[];
    try {
      const r = await fileToPages({ name: f.name, path: null, bytes: f.bytes });
      got = pickPages(r.pages, f.range);
      Object.assign(assets, r.assets);
      warnings.push(...r.warnings.map((w) => `${f.name}: ${w}`));
    } catch (e: any) {
      throw new Error(`${f.name}: ${e?.message ?? e}`);
    }
    if (!got.length) {
      warnings.push(t("doc.warn.skippedNoPages", { name: f.name }));
      continue;
    }
    outline.push({ title: f.name.replace(/\.[^.]+$/, ""), page: pages.length });
    // the same file may be listed twice: page ids must stay unique within one document
    pages.push(...got.map((p) => (pages.some((q) => q.id === p.id) ? { ...p, id: uid("pg") } : p)));
  }
  if (!pages.length) throw new Error(t("doc.err.noPagesForPdf"));
  opts.onProgress?.(inputs.length, inputs.length + 1, t("doc.progress.makingPdf"));
  const doc: OmwDocument = { ...newDocument(inputs[0].name.replace(/\.[^.]+$/, "")), pages, masters: [], assets };
  const bytes = await exportPdf(doc, pages, { onWarning: (m) => warnings.push(m), outline });
  let out = bytes;
  let protectedWith: string | null = null;
  if (opts.protect) {
    const prot = await protectOutput("pdf", bytes, true);
    if (!prot) return null;
    out = prot.bytes;
    protectedWith = prot.secretId;
  }
  opts.onProgress?.(1, 1);
  return { bytes: out, pages: pages.length, files: outline.length, warnings: [...new Set(warnings)], protectedWith };
}

/** Open the full-screen page organiser. */
export function openOrganizer() {
  useUI.getState().set({ organizer: true });
}

export function selectPage(id: string) {
  if (S().pageId === id) return;
  S().set({ pageId: id, selection: [], editingTextId: null });
  setTimeout(fitCurrent);
}

