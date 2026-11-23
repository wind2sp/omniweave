// PDF module: pdf.js renders the page as a background layer. "Elevation" uses Omniweave's own
// engine (PDF Surgeon, ./pdfsurgeon) to turn the content stream's text lines — and on Illustrator
// pages, paths — into editable nodes linked to their original operations. The background is then
// rendered from the same PDF with exactly those operations removed (no cover rectangles), and
// "save in the original format" rewrites only the operations of changed nodes.
// The old cover-rectangle elevation remains as the fallback when the engine cannot read a page.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfjsLib } from "./pdfjsLoader";
import { getBlob, makeAsset } from "../core/assets";
import { fillForm, formFields, type FormField, type FormValue } from "./pdfsurgeon/forms";
import { addAnnots, type PdfAnnot } from "./pdfsurgeon/annots";
import { pageView } from "./pdfsurgeon/document";
import { useStore } from "../core/store";
import { askPassword, getSecret, rememberSecret } from "./crypto/session";
import { newPage, newPdf, newText, uid, type AssetRef, type OmwDocument, type Page, type PdfCover, type PdfNode, type SceneNode, type TextNode } from "../core/types";
import { ENGINE_VERSION, aiSaveNote, SURGEON_MARK, elevatePage, isSurgeonMark, openSurgeonDoc, saveSurgical, strippedForView, type PageEditInput, type SaveReport, type SurgeonDoc } from "./pdfsurgeon";
import { setCMapLoader } from "./pdfsurgeon/bcmap";
import { loadCMapPack, PackedCMapReaderFactory } from "./pdfCMaps";
import { pretendardTtf } from "./pretendard";
import { SAVE_CANCELLED } from "./errors";
import { rotatePageInPlace } from "../core/pages";
import { t } from "../i18n";

/** public/pdfjs (scripts/copy-pdfjs-assets.mjs): cmaps.pack + standard fonts; none under Node tests. */
const pdfjsBase = () => (typeof document === "undefined" ? null : new URL("pdfjs/", document.baseURI).href);

// CID → Unicode maps for CJK fonts without ToUnicode (the Adobe-*-UCS2 CMaps of the same pack, read on demand)
setCMapLoader(async (name) => {
  const base = pdfjsBase();
  if (!base) return null;
  return (await loadCMapPack(base)).get(name) ?? null;
});

function pdfjsAssetUrls() {
  const base = pdfjsBase();
  if (!base) return {};
  return { CMapReaderFactory: PackedCMapReaderFactory, cMapUrl: base, cMapPacked: true, standardFontDataUrl: base + "standard_fonts/" };
}

const docs = new Map<string, Promise<PDFDocumentProxy>>();
/** asset bytes, or a form-filled view of them (pdfViewHash below) */
const blobOf = (hash: string) => derivedBytes.get(hash) ?? getBlob(hash);
/** asset hash -> session secret id of the password that opened it (never the password itself) */
const pdfSecrets = new Map<string, string>();
export const pdfSecretFor = (hash: string) => pdfSecrets.get(hash);
function openPdf(hash: string): Promise<PDFDocumentProxy> {
  let p = docs.get(hash);
  if (!p) {
    const bytes = blobOf(hash);
    if (!bytes) return Promise.reject(new Error("PDF asset missing"));
    p = pdfjsLib()
      .then((pdfjs) => {
        const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, ...pdfjsAssetUrls() });
        // documents with an open (user) password: ask the person, never store the password
        let asked = 0;
        let lastTry: string | null = null;
        // cancelling the password prompt must settle the open promptly (pdf.js would otherwise wait)
        let cancel!: (e: Error) => void;
        const cancelled = new Promise<never>((_, rej) => (cancel = rej));
        cancelled.catch(() => {}); // late cancels after success are harmless
        task.onPassword = (update: (pw: string) => void, reason: number) => {
          if (asked++ >= 5) {
            cancel(Object.assign(new Error("password attempts exceeded"), { name: "PasswordException" }));
            return void task.destroy();
          }
          const giveUp = () => {
            cancel(Object.assign(new Error("password prompt cancelled"), { name: "PasswordException" }));
            void task.destroy();
          };
          // a failing asker (no dialog available) counts as a cancel, never as an unsettled open
          Promise.resolve()
            .then(() => askPassword({ title: t("engine.pw.pdfTitle"), message: t("engine.pw.pdfMessage"), retry: reason === 2 }))
            .then((pw) => {
              if (pw == null) return giveUp();
              lastTry = pw;
              update(pw);
            })
            .catch(giveUp);
        };
        return Promise.race([task.promise, cancelled]).then((d) => {
          if (lastTry != null) pdfSecrets.set(hash, rememberSecret(lastTry));
          lastTry = null;
          return d;
        });
      })
      .catch((e: any) => {
        docs.delete(hash);
        if (e?.name === "PasswordException" || /password/i.test(String(e?.message))) throw new Error(t("engine.pdf.needPassword"));
        throw e;
      });
    docs.set(hash, p);
  }
  return p;
}

// bitmap cache: key = hash:page:bucket
const bitmaps = new Map<string, ImageBitmap | HTMLCanvasElement | "loading">();
/**
 * Bitmap px per page px of each rendered page. The canvas is a whole number of pixels (rounded up), so stretching it
 * to the node size moved the bottom of the page by up to a pixel (SSIM 0.995 against pdf.js, 2026-11-13): drawPdf
 * draws it at its own size instead (pdfBitmapScale).
 */
const bitmapScale = new WeakMap<object, number>();
export const pdfBitmapScale = (b: object) => bitmapScale.get(b);
const exactBitmaps = new WeakSet<object>();
/** Was this bitmap rendered at an exact (non-bucket) scale? */
export const pdfBitmapIsExact = (b: object) => exactBitmaps.has(b);
const PDF_UNIT = 96 / 72; // PDF points -> CSS px

/**
 * The page rendered for drawing at `scale` device px per page px. On screen: power-of-two buckets between 0.5x and 4x
 * (a few renders serve every zoom). `exact` (export, thumbnails, print, up to 2x): the exact scale, so the picture
 * is not resampled from the next bucket — resampling blurred thin lines and text (SSIM ≈ 0.99 against pdf.js,
 * 2026-11-13). While the exact one renders, any bucket already rendered is returned as before (a one-shot export
 * still gets a picture, not a grey box) and pdfBitmapIsExact tells the caller to paint again.
 */
export function pdfBitmap(hash: string, pageIndex: number, scale: number, onReady: () => void, exact = false): ImageBitmap | HTMLCanvasElement | null {
  exact = exact && scale <= 2;
  const bucket = exact ? Math.max(1 / 64, Math.round(scale * 1e4) / 1e4) : Math.min(4, Math.max(0.5, Math.pow(2, Math.ceil(Math.log2(Math.max(scale, 0.01))))));
  // elevated pages render without the elevated operations (their nodes draw them instead)
  const stripped = isElevatedInStore(originOf(hash), pageIndex);
  const prefix = `${hash}:${pageIndex}:${stripped ? "s" : "o"}:`;
  const key = `${prefix}${exact ? "x" : ""}${bucket}`;
  const v = bitmaps.get(key);
  if (v && v !== "loading") return v;
  if (!v) {
    bitmaps.set(key, "loading");
    (async () => {
      const pdf = stripped ? await openStripped(hash, pageIndex) : await openPdf(hash);
      const page = await pdf.getPage(pageIndex + 1);
      const vp = page.getViewport({ scale: PDF_UNIT * bucket });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d")!, viewport: vp }).promise;
      bitmapScale.set(canvas, bucket);
      if (exact) exactBitmaps.add(canvas);
      bitmaps.set(key, canvas);
      // exact renders are one-offs (an export, a thumbnail size): keep the newest finished ones within a pixel budget
      // (40 Mpx ≈ 160 MB: many thumbnails, or a few full exports), never one still loading
      if (exact) {
        let px = 0;
        const xs = [...bitmaps.entries()].filter(([k, v]) => k.includes(":x") && v !== "loading").reverse();
        for (const [k, v] of xs) if ((px += (v as HTMLCanvasElement).width * (v as HTMLCanvasElement).height) > 40_000_000 && k !== key) bitmaps.delete(k);
      }
      onReady();
    })().catch((e) => {
      console.error("PDF render failed", e);
      bitmaps.delete(key);
    });
  }
  // fall back to any already-rendered bitmap of the page while the right one loads (an exact request prefers the
  // bucket bitmaps, as before this mode existed)
  let any: ImageBitmap | HTMLCanvasElement | null = null;
  for (const [k, b] of bitmaps) if (b !== "loading" && k.startsWith(prefix)) if (!any || !k.slice(prefix.length).startsWith("x")) any = b;
  return any;
  return null;
}

// ───────── PDF Surgeon integration ─────────

const surgeonDocs = new Map<string, Promise<SurgeonDoc>>();
const strippedDocs = new Map<string, Promise<PDFDocumentProxy>>();
const surgeonPrefix = (hash: string) => hash.slice(0, 10);

/** The surgeon view of an asset; encrypted files reuse the password pdf.js was opened with. */
export function surgeonDoc(hash: string): Promise<SurgeonDoc> {
  let p = surgeonDocs.get(hash);
  if (!p) {
    const bytes = blobOf(hash);
    if (!bytes) return Promise.reject(new Error("PDF asset missing"));
    p = (async () => {
      await openPdf(hash).catch(() => undefined); // asks for the open password when needed
      return openSurgeonDoc(bytes, getSecret(pdfSecrets.get(hash)));
    })();
    p.catch(() => surgeonDocs.delete(hash));
    surgeonDocs.set(hash, p);
  }
  return p;
}

/** "hash:page" of every elevated PDF page, computed once per (immutable) document state. */
const elevatedSets = new WeakMap<OmwDocument, Set<string>>();
function isElevatedInStore(hash: string, pageIndex: number): boolean {
  let doc: OmwDocument;
  try {
    doc = useStore.getState().doc;
  } catch {
    return false;
  }
  let set = elevatedSets.get(doc);
  if (!set) {
    set = new Set();
    for (const page of [...doc.pages, ...doc.masters])
      for (const n of page.nodes) if (n.type === "PDF" && n.covers.some(isSurgeonMark) && doc.assets[n.assetId]) set.add(`${doc.assets[n.assetId].hash}:${n.pageIndex}`);
    elevatedSets.set(doc, set);
  }
  return set.has(`${hash}:${pageIndex}`);
}

function openStripped(hash: string, pageIndex: number): Promise<PDFDocumentProxy> {
  const key = `${hash}:${pageIndex}`;
  let p = strippedDocs.get(key);
  if (!p) {
    p = (async () => {
      const sd = await surgeonDoc(hash);
      const bytes = await strippedForView(sd, pageIndex, { prefix: surgeonPrefix(originOf(hash)), vectors: "auto" });
      return (await pdfjsLib()).getDocument({ data: bytes.slice(), isEvalSupported: false, ...pdfjsAssetUrls() }).promise;
    })();
    p.catch(() => strippedDocs.delete(key));
    strippedDocs.set(key, p);
  }
  return p;
}

/**
 * For exporters that place the original PDF page under the nodes (vector PDF/SVG export): the PDF
 * bytes to use for a PdfNode. An elevated page must be embedded WITHOUT its elevated operations,
 * otherwise its text would appear twice (once from the page, once from the nodes).
 * Encrypted sources come back decrypted.
 */
export async function pdfBytesForNode(hash: string, node: PdfNode): Promise<Uint8Array> {
  const orig = hash;
  let edits = nodeEdits(node);
  try {
    edits = viewEdits(useStore.getState().doc, hash, node);
  } catch {
    /* no store (tests): the node's own edits */
  }
  if (hasEdits(edits)) hash = (await filledHash(hash, edits)) ?? hash;
  const sd = await surgeonDoc(hash);
  if (!node.covers.some(isSurgeonMark)) return sd.plain;
  return strippedForView(sd, node.pageIndex, { prefix: surgeonPrefix(orig), vectors: "auto" });
}

// ───────── form values and new annotations (io/pdfsurgeon/forms.ts, annots.ts) ─────────
// A page with typed form values (PdfNode.form) or new annotations (PdfNode.annots) is shown, exported and saved as
// the file with them written in: those bytes are kept as a derived view ("view hash") that renders like any PDF,
// while the original asset stays the reference (elevated ids, "save in the original format").

/** What Omniweave adds to one PDF file: form values (one per field) and new annotations by page index. */
export interface PdfViewEdits {
  form: Record<string, FormValue>;
  annots: [number, PdfAnnot[]][];
  /** pictures the annotations draw (signatures): asset id → blob hash */
  images?: Record<string, string>;
}
const hasEdits = (e: PdfViewEdits) => Object.keys(e.form).length > 0 || e.annots.some(([, l]) => l.length > 0);
const nodeEdits = (n: PdfNode): PdfViewEdits => ({ form: n.form ?? {}, annots: n.annots?.length ? [[n.pageIndex, n.annots as PdfAnnot[]]] : [] });

/** The file with the edits written in (form values first, then annotations), or null when nothing changes. */
async function applyEdits(sd: SurgeonDoc, e: PdfViewEdits): Promise<{ doc: SurgeonDoc; notes: string[] } | null> {
  let cur = sd;
  let changed = false;
  const notes: string[] = [];
  if (Object.keys(e.form).length) {
    const r = await fillForm(cur, e.form, { fallbackFont: loadFallbackFont });
    notes.push(...r.report.skipped);
    if (r.report.changed) {
      cur = await openSurgeonDoc(r.bytes);
      changed = true;
    }
  }
  if (e.annots.length) {
    const r = await addAnnots(cur, new Map(e.annots), { imageBytes: (id) => (e.images?.[id] ? getBlob(e.images[id]) : undefined) });
    notes.push(...r.report.skipped);
    if (r.report.changed) {
      cur = await openSurgeonDoc(r.bytes);
      changed = true;
    }
  }
  return changed ? { doc: cur, notes } : null;
}

const filledByKey = new Map<string, Promise<string | null>>();
const readyByKey = new Map<string, string | null>();
/** derived view hash → the original asset hash */
const derivedFrom = new Map<string, string>();
/** "hash:page" → the last view hash shown, kept on screen while the next one is computed (no flicker) */
const lastView = new Map<string, string>();
const originOf = (hash: string) => derivedFrom.get(hash) ?? hash;

/** filled views kept (each holds a copy of the file and its renders): the newest few, the rest are dropped */
const FILLED_KEEP = 6;
const derivedBytes = new Map<string, Uint8Array>();
let derivedSeq = 0;
const editsKey = (hash: string, e: PdfViewEdits) => hash + "|" + JSON.stringify([Object.entries(e.form).sort(([a], [b]) => (a < b ? -1 : 1)), e.annots]);

function dropFilled(key: string) {
  const h = readyByKey.get(key);
  filledByKey.delete(key);
  readyByKey.delete(key);
  if (!h || !derivedBytes.has(h)) return;
  derivedBytes.delete(h);
  derivedFrom.delete(h);
  void docs.get(h)?.then((d) => d.destroy()).catch(() => {});
  docs.delete(h);
  surgeonDocs.delete(h);
  for (const k of [...bitmaps.keys()]) if (k.startsWith(h + ":")) bitmaps.delete(k);
  for (const k of [...strippedDocs.keys()]) if (k.startsWith(h + ":")) strippedDocs.delete(k);
  for (const [slot, v] of lastView) if (v === h) lastView.delete(slot);
}

function filledHash(hash: string, edits: PdfViewEdits): Promise<string | null> {
  const key = editsKey(hash, edits);
  let p = filledByKey.get(key);
  if (p) {
    // most recently used last
    filledByKey.delete(key);
    filledByKey.set(key, p);
  } else {
    p = (async () => {
      const done = await applyEdits(await surgeonDoc(hash), edits);
      if (!done) return hash;
      const h = `${hash}~f${++derivedSeq}`;
      derivedBytes.set(h, done.doc.plain);
      derivedFrom.set(h, hash);
      return h;
    })().catch((e) => {
      console.error("PDF form / annotation view failed", e);
      return null;
    });
    p.then((h) => readyByKey.set(key, h));
    filledByKey.set(key, p);
    while (filledByKey.size > FILLED_KEEP) dropFilled(filledByKey.keys().next().value!);
  }
  return p;
}

/** The edits of every page of one file in `doc` (pages in order; one value per field). */
const fileEditsCache = new WeakMap<OmwDocument, Map<string, PdfViewEdits>>();
export function fileEdits(doc: OmwDocument, hash: string): PdfViewEdits {
  let m = fileEditsCache.get(doc);
  if (!m) fileEditsCache.set(doc, (m = new Map()));
  let v = m.get(hash);
  if (!v) {
    v = editsOf(doc.pages.filter((p) => p.nodes.some((x) => x.type === "PDF" && doc.assets[x.assetId]?.hash === hash)));
    v.images = imagesOf(doc, v.annots);
    m.set(hash, v);
  }
  return v;
}
/** What one page node shows: the file's form values and that node's own annotations (a duplicated page has its own). */
function viewEdits(doc: OmwDocument, hash: string, n: PdfNode): PdfViewEdits {
  const annots = nodeEdits(n).annots;
  return { form: fileEdits(doc, hash).form, annots, images: imagesOf(doc, annots) };
}
function imagesOf(doc: OmwDocument, annots: [number, PdfAnnot[]][]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [, l] of annots) for (const a of l) if (a.assetId && doc.assets[a.assetId]) out[a.assetId] = doc.assets[a.assetId].hash;
  return Object.keys(out).length ? out : undefined;
}
/** Form values typed on every page of one file in `doc`. */
export const fileFormValues = (doc: OmwDocument, hash: string): Record<string, FormValue> => fileEdits(doc, hash).form;

function editsOf(pages: Page[]): PdfViewEdits {
  const form: Record<string, FormValue> = {};
  const byPage = new Map<number, PdfAnnot[]>();
  for (const p of pages) {
    const n = pdfNodeOf(p);
    if (!n) continue;
    Object.assign(form, n.form ?? {});
    // the file keeps one copy of each page (the first: saveSameTypePdf skips duplicates), so its annotations come
    // from that page's node only — a duplicate's own annotations are not written into the same page
    if (!byPage.has(n.pageIndex)) byPage.set(n.pageIndex, (n.annots as PdfAnnot[] | undefined) ?? []);
  }
  for (const [k, l] of byPage) if (!l.length) byPage.delete(k);
  return { form, annots: [...byPage] };
}

/**
 * The hash to draw a PdfNode from: its file filled with the form values typed on any page of it (`doc`; without it
 * the node's own), once ready; until then the last one shown, so the page does not flicker while typing.
 * `pending.v` is set while that stand-in is returned: a painter that caches what it drew (the screen's tiles,
 * render/weave.ts) must not keep it — otherwise new marks and typed values stayed invisible until the file was
 * opened again (실사용 점검 2026-11-23 #67, #72).
 */
export function pdfViewHash(hash: string, n: PdfNode, onReady: () => void, doc?: OmwDocument, pending?: { v: boolean }): string {
  const edits = doc ? viewEdits(doc, hash, n) : nodeEdits(n);
  if (!hasEdits(edits)) {
    lastView.delete(`${hash}:${n.id}`);
    return hash;
  }
  const key = editsKey(hash, edits);
  const slot = `${hash}:${n.id}`;
  if (readyByKey.has(key)) {
    const h = readyByKey.get(key) ?? hash;
    lastView.set(slot, h);
    return h;
  }
  void filledHash(hash, edits).then(onReady);
  if (pending) pending.v = true;
  return lastView.get(slot) ?? hash;
}

export interface PdfFormInfo {
  fields: FormField[];
  xfa: boolean;
  /** per page: the PDF box shown and its rotation, to place widget rectangles on the page node */
  pages: { view: number[]; rotate: number; userUnit: number }[];
}
const formInfos = new Map<string, Promise<PdfFormInfo | null>>();

/** The form of a PDF asset (null when it has none or cannot be read). */
export function pdfFormInfo(hash: string): Promise<PdfFormInfo | null> {
  let p = formInfos.get(hash);
  if (!p) {
    p = surgeonDoc(hash)
      .then((sd) => {
        const { fields, xfa } = formFields(sd);
        if (!fields.length) return null;
        return { fields, xfa, pages: sd.pageRefs.map((_, i) => pageView(sd, i)) };
      })
      .catch(() => null);
    formInfos.set(hash, p);
  }
  return p;
}

/** A widget rectangle (PDF user space) on the page node's local px: [x, y, w, h]. */
export function widgetRectOnNode(info: Pick<PdfFormInfo, "pages">, page: number, rect: [number, number, number, number]): [number, number, number, number] {
  const pv = info.pages[page];
  if (!pv) return [0, 0, 0, 0];
  const [vx0, vy0, vx1, vy1] = [Math.min(pv.view[0], pv.view[2]), Math.min(pv.view[1], pv.view[3]), Math.max(pv.view[0], pv.view[2]), Math.max(pv.view[1], pv.view[3])];
  const W = vx1 - vx0, H = vy1 - vy0;
  const u = PDF_UNIT * (pv.userUnit || 1); // pdf.js scales the viewport by /UserUnit too
  // PDF point → unrotated top-left space, then the page rotation (clockwise), then px
  const map = (x: number, y: number): [number, number] => {
    const u = x - vx0, v = vy1 - y;
    switch (((pv.rotate % 360) + 360) % 360) {
      case 90:
        return [H - v, u];
      case 180:
        return [W - u, H - v];
      case 270:
        return [v, W - u];
      default:
        return [u, v];
    }
  };
  const a = map(rect[0], rect[1]), b = map(rect[2], rect[3]);
  return [Math.min(a[0], b[0]) * u, Math.min(a[1], b[1]) * u, Math.abs(b[0] - a[0]) * u, Math.abs(b[1] - a[1]) * u];
}

/** The inverse of widgetRectOnNode for one point: page node px → PDF user space. */
export function nodePointToPdf(info: Pick<PdfFormInfo, "pages">, page: number, p: [number, number]): [number, number] {
  const pv = info.pages[page];
  if (!pv) return [0, 0];
  const [vx0, vy0, vx1, vy1] = [Math.min(pv.view[0], pv.view[2]), Math.min(pv.view[1], pv.view[3]), Math.max(pv.view[0], pv.view[2]), Math.max(pv.view[1], pv.view[3])];
  const W = vx1 - vx0, H = vy1 - vy0;
  const k = PDF_UNIT * (pv.userUnit || 1);
  const [X, Y] = [p[0] / k, p[1] / k];
  let u: number, v: number;
  switch (((pv.rotate % 360) + 360) % 360) {
    case 90:
      [u, v] = [Y, H - X];
      break;
    case 180:
      [u, v] = [W - X, H - Y];
      break;
    case 270:
      [u, v] = [W - Y, X];
      break;
    default:
      [u, v] = [X, Y];
  }
  return [u + vx0, vy1 - v];
}

const pageGeoms = new Map<string, Promise<Pick<PdfFormInfo, "pages"> | null>>();
/** Every page's PDF box and rotation (to place things given in PDF user space on the page node). */
export function pdfPageGeom(hash: string): Promise<Pick<PdfFormInfo, "pages"> | null> {
  let p = pageGeoms.get(hash);
  if (!p) {
    p = surgeonDoc(hash)
      .then((sd) => ({ pages: sd.pageRefs.map((_, i) => pageView(sd, i)) }))
      .catch(() => null);
    pageGeoms.set(hash, p);
  }
  return p;
}

/** A run of text on a PDF page, as an axis-aligned box in PDF user space (horizontal text only). */
export interface PdfTextItem {
  str: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
/** pdf.js text content items → runs to mark (horizontal text only). */
export function textRunsOf(items: readonly unknown[]): PdfTextItem[] {
  const out: PdfTextItem[] = [];
  for (const it of items as { str?: string; transform?: number[]; width?: number; height?: number }[]) {
    if (!it.str?.trim() || !it.transform || !it.width) continue;
    const [a, b, c, d, e, f] = it.transform;
    if (Math.abs(b) > 1e-3 || Math.abs(c) > 1e-3 || a <= 0) continue; // rotated or mirrored text: not marked
    const h = it.height || Math.abs(d);
    // the em box Acrobat marks: a little below the baseline to a little above the cap height
    out.push({ str: it.str, x0: e, x1: e + it.width, y0: f - 0.22 * h, y1: f + 0.9 * h });
  }
  return out;
}
/**
 * A PDF page painted to RGBA pixels at `scale` px per page px (glyph recognition on a scanned page: ui/ocrActions.ts).
 * White under the page, as it is shown.
 */
export async function pdfPagePixels(hash: string, pageIndex: number, scale: number): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const page = await (await openPdf(hash)).getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: PDF_UNIT * scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const g = canvas.getContext("2d", { willReadFrequently: true })!;
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return { width: canvas.width, height: canvas.height, data: g.getImageData(0, 0, canvas.width, canvas.height).data };
}

const textItems = new Map<string, Promise<PdfTextItem[]>>();
/** The page's text runs from pdf.js (for marking text: highlight / underline / strike-out). */
export function pdfTextItems(hash: string, pageIndex: number): Promise<PdfTextItem[]> {
  const key = `${hash}:${pageIndex}`;
  let p = textItems.get(key);
  if (!p) {
    p = (async () => {
      const page = await (await openPdf(hash)).getPage(pageIndex + 1);
      return textRunsOf((await page.getTextContent()).items);
    })();
    p.catch(() => textItems.delete(key));
    textItems.set(key, p);
  }
  return p;
}


export async function importPdf(bytes: Uint8Array, name: string, format: "pdf" | "ai" = "pdf"): Promise<{ asset: AssetRef; pages: Page[] }> {
  const asset = makeAsset(bytes, "application/pdf", name);
  const pdf = await openPdf(asset.hash);
  const pages: Page[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    const p = await pdf.getPage(i + 1);
    const vp = p.getViewport({ scale: PDF_UNIT });
    const page = newPage("PDF", Math.round(vp.width), Math.round(vp.height), t("engine.default.pageOfFile", { title: name, page: i + 1 }));
    page.nodes.push(newPdf(asset.id, i, vp.width, vp.height));
    const secretId = pdfSecrets.get(asset.hash);
    // every page remembers its file so "save in the original format" can write it back surgically
    page.source = secretId ? { format, name, protection: { scheme: "pdf", secretId } } : { format, name };
    pages.push(page);
  }
  return { asset, pages };
}

/**
 * Elevate a PDF page into editable nodes with PDF Surgeon: one TextNode per text line (and, on
 * Illustrator pages, one VectorNode per path). The returned `covers` holds a single zero-size
 * marker: it tells the renderer to draw the page without the elevated operations and tells the
 * UI that the page is already elevated. Falls back to the cover-rectangle method when the engine
 * cannot read the page or finds no editable text.
 */
export async function elevatePdfText(assetHash: string, pageIndex: number, pageW: number): Promise<{ nodes: SceneNode[]; covers: PdfCover[]; keptShapes?: number }> {
  try {
    const sd = await surgeonDoc(assetHash);
    const r = elevatePage(sd, pageIndex, { prefix: surgeonPrefix(assetHash), vectors: "auto" });
    for (const n of r.notes) console.warn("PDF Surgeon:", n);
    if (r.nodes.length) {
      // warm the stripped background so the first paint after elevation is already clean
      void openStripped(assetHash, pageIndex).catch((e) => console.error("PDF Surgeon background", e));
      return { nodes: r.nodes, covers: [{ ...SURGEON_MARK }], keptShapes: r.keptShapes };
    }
  } catch (e) {
    console.warn("PDF Surgeon could not elevate this page; using cover rectangles", e);
  }
  return elevatePdfTextCovers(assetHash, pageIndex, pageW);
}

/**
 * Fallback elevation: lines are grouped by baseline from pdf.js text content; each line becomes
 * one text node positioned over the original, and the original glyphs are hidden with a cover
 * sampled from the page colour.
 */
export async function elevatePdfTextCovers(assetHash: string, pageIndex: number, pageW: number): Promise<{ nodes: TextNode[]; covers: PdfCover[] }> {
  const pdf = await openPdf(assetHash);
  const { Util } = await pdfjsLib();
  const page = await pdf.getPage(pageIndex + 1);
  const vp = page.getViewport({ scale: PDF_UNIT });
  const content = await page.getTextContent();
  // sample background colour from a low-res render
  const bg = await sampleBackground(page, vp.width, vp.height);

  type Item = { str: string; x: number; y: number; w: number; h: number; font: string };
  const items: Item[] = [];
  for (const it of content.items as any[]) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, , , e, f] = Util.transform(vp.transform, it.transform);
    const size = Math.hypot(a, b);
    items.push({ str: it.str, x: e, y: f - size, w: it.width * PDF_UNIT, h: size * 1.2, font: (content.styles as any)[it.fontName]?.fontFamily ?? "sans-serif" });
  }
  items.sort((p, q) => p.y - q.y || p.x - q.x);
  const lines: Item[][] = [];
  for (const it of items) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last[0].y - it.y) < it.h * 0.4 && it.x >= last[last.length - 1].x) last.push(it);
    else lines.push([it]);
  }
  const nodes: TextNode[] = [];
  const covers: PdfCover[] = [];
  for (const line of lines) {
    const x0 = Math.min(...line.map((i) => i.x)), y0 = Math.min(...line.map((i) => i.y));
    const x1 = Math.max(...line.map((i) => i.x + i.w)), y1 = Math.max(...line.map((i) => i.y + i.h));
    const size = Math.round(line[0].h / 1.2);
    let text = "";
    let cursor = line[0].x;
    for (const i of line) {
      if (text && i.x - cursor > size * 0.25) text += " ";
      text += i.str;
      cursor = i.x + i.w;
    }
    const family = /serif/i.test(line[0].font) && !/sans/i.test(line[0].font) ? "Noto Serif KR" : "Pretendard";
    const n = newText(text, Math.min(pageW - x0, (x1 - x0) * 1.08 + size), { fontSize: size, fontFamily: family });
    n.name = text.slice(0, 20);
    n.transform = { x: x0, y: y0 - size * 0.1, rotation: 0, scale: 1 };
    n.paragraphs.forEach((p) => {
      p.lineSpacing = 1.2;
      p.spaceAfter = 0;
      p.id = uid("p");
    });
    nodes.push(n);
    covers.push({ x: x0 - 1, y: y0 - 1, w: x1 - x0 + 2, h: y1 - y0 + 2, color: bg });
  }
  return { nodes, covers };
}

async function sampleBackground(page: any, w: number, h: number): Promise<string> {
  try {
    const s = 0.25;
    const vp = page.getViewport({ scale: PDF_UNIT * s });
    const c = document.createElement("canvas");
    c.width = Math.ceil(vp.width);
    c.height = Math.ceil(vp.height);
    const ctx = c.getContext("2d")!;
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const counts = new Map<number, number>();
    for (let i = 0; i < d.length; i += 16) {
      const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    let best = 0, bestN = -1;
    for (const [k, n] of counts) if (n > bestN) (best = k), (bestN = n);
    const r = ((best >> 10) & 31) * 8 + 4, g = ((best >> 5) & 31) * 8 + 4, b = (best & 31) * 8 + 4;
    void w;
    void h;
    return `rgb(${Math.min(255, r)}, ${Math.min(255, g)}, ${Math.min(255, b)})`;
  } catch {
    return "#ffffff";
  }
}

// ───────── save in the original format (PDF / AI) ─────────

let fallbackFontBytes: Promise<Uint8Array> | null = null;
function loadFallbackFont(): Promise<Uint8Array> {
  if (!fallbackFontBytes) {
    fallbackFontBytes = (async () => {
      try {
        return await pretendardTtf("regular"); // the original TTF, unpacked from fonts/Pretendard-Regular.ttpack
      } catch (e) {
        throw new Error(t("engine.pdf.fallbackFontFailed", { status: /\d{3}$/.exec((e as Error).message)?.[0] ?? "-" }));
      }
    })();
    fallbackFontBytes.catch(() => (fallbackFontBytes = null));
  }
  return fallbackFontBytes;
}

const pdfNodeOf = (p: Page) => p.nodes.find((n): n is PdfNode => n.type === "PDF");

/** Pages of `doc` that came from the same PDF/AI file as `page`, in document order. */
export function pagesFromSameFile(doc: OmwDocument, page: Page): Page[] {
  const src = page.source;
  const asset = pdfNodeOf(page) && doc.assets[pdfNodeOf(page)!.assetId];
  if (!src || !asset) return [];
  return doc.pages.filter((p) => {
    const n = pdfNodeOf(p);
    return p.source?.format === src.format && p.source.name === src.name && n && doc.assets[n.assetId]?.hash === asset.hash;
  });
}

function reportText(r: SaveReport): string[] {
  const out: string[] = [];
  const n = r.fallbackChars.length;
  if (n) out.push(t(n === 1 ? "engine.pdf.fallbackChars_one" : "engine.pdf.fallbackChars", { n, chars: r.fallbackChars.slice(0, 12).join("") + (n > 12 ? "…" : "") }));
  out.push(...r.skipped.slice(0, 6));
  if (r.skipped.length > 6) out.push(t("engine.pdf.moreNotes", { n: r.skipped.length - 6 }));
  return out;
}

/**
 * "Save in the original format" for PDF and AI pages: unchanged → the original bytes as they were;
 * changed → the original file plus an incremental update that rewrites only the changed
 * operations. Encrypted sources are written decrypted so the caller's protection step can apply
 * the password the person chooses.
 */
export async function saveSameTypePdf(doc: OmwDocument, page: Page, confirm: (msg: string) => boolean, renderPdf?: (doc: OmwDocument, pages: Page[]) => Promise<Uint8Array>): Promise<Uint8Array> {
  // the file is the document's first PDF page's: saved from a page taken from another file, it is still this file
  // (it used to write that other file back on its own — 실사용 점검 2026-11-23 #75)
  const fmt = page.source?.format;
  page = doc.pages.find((p) => p.source?.format === fmt && pdfNodeOf(p)) ?? page;
  const pages = pagesFromSameFile(doc, page);
  const own = new Set(pages.map((p) => p.id));
  const others = doc.pages.filter((p) => !own.has(p.id));
  const dupes = pages.length - new Set(pages.map((p) => pdfNodeOf(p)!.pageIndex)).size;
  // pages taken from other files, new pages and copies of a page cannot go into an update of this file: the file is
  // written again with them in their places (PDF; an .ai keeps Illustrator's data only as an update, so it says so)
  if ((others.length || dupes) && fmt === "pdf") return saveMergedPdf(doc, page, pages, others, confirm, renderPdf);
  const r = await saveFileUpdate(doc, page, pages, fmt === "ai" && others.length ? [t("engine.pdf.otherPagesLeft", { n: others.length })] : []);
  if (r.notes.length && !confirm(t("engine.pdf.saveConfirm", { notes: r.notes.join("\n\n") }))) throw new Error(SAVE_CANCELLED);
  return r.turns.size ? applyTurns(r.bytes, r.turns, r.order) : r.bytes;
}

/** Quarter turns given to a page in Omniweave (쪽 ▸ 회전): its PDF page node turned with it (core/pages.ts). */
const quarterTurns = (n: PdfNode) => ((Math.round((n.transform.rotation ?? 0) / 90) % 4) + 4) % 4;

/**
 * The page as it was before its quarter turns: every object turned back with it (rotatePageInPlace in reverse), so the
 * surgical save compares and writes it in the file's own orientation and the turn is written as the page's /Rotate.
 * Without this the turn was dropped on save (실사용 점검 2026-11-23 #75).
 */
function unturned(p: Page, q: number): Page {
  if (!q) return p;
  const c = structuredClone(p) as Page;
  for (let i = 0; i < q; i++) rotatePageInPlace(c as any, -1);
  return c;
}

/** Each page's turn added to its /Rotate (`turns`: original page index → quarter turns; `order`: output order). */
async function applyTurns(bytes: Uint8Array, turns: Map<number, number>, order: number[]): Promise<Uint8Array> {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const d = await PDFDocument.load(bytes, { updateMetadata: false });
  for (const [idx, q] of turns) {
    const at = order.indexOf(idx);
    const pg = at >= 0 ? d.getPage(at) : null;
    if (pg) pg.setRotation(degrees((((pg.getRotation().angle + 90 * q) % 360) + 360) % 360));
  }
  return d.save({ useObjectStreams: false });
}

interface FileUpdate {
  bytes: Uint8Array;
  notes: string[];
  /** original page indices in output order */
  order: number[];
  /** original page index → quarter turns to add to its /Rotate */
  turns: Map<number, number>;
}

/**
 * One PDF file with its pages' edits: form values and annotations, then the page edits as an incremental update.
 * Encrypted sources come back decrypted (the caller's protection step applies the password chosen).
 */
async function saveFileUpdate(doc: OmwDocument, page: Page, pages: Page[], extraNotes: string[] = []): Promise<FileUpdate> {
  const first = pages[0] && pdfNodeOf(pages[0]);
  if (!first) throw new Error(t("engine.pdf.sourceMissing"));
  const asset = doc.assets[first.assetId];
  let sd = await surgeonDoc(asset.hash);
  // typed form values and new annotations first (their own incremental updates), then the page edits on top
  const formNotes: string[] = [];
  const edits = editsOf(pages);
  edits.images = imagesOf(doc, edits.annots);
  const done = await applyEdits(sd, edits);
  if (done) {
    sd = done.doc;
    formNotes.push(...done.notes);
  }
  const seen = new Set<number>();
  const inputs: PageEditInput[] = [];
  const order: number[] = [];
  const turns = new Map<number, number>();
  for (const turned of pages) {
    const tn = pdfNodeOf(turned)!;
    if (seen.has(tn.pageIndex)) continue; // a duplicated page cannot appear twice in the page tree
    seen.add(tn.pageIndex);
    order.push(tn.pageIndex);
    const q = quarterTurns(tn);
    if (q) turns.set(tn.pageIndex, q);
    const p = unturned(turned, q);
    const n = pdfNodeOf(p)!;
    const mark = n.covers.find(isSurgeonMark);
    if (mark && mark.x !== ENGINE_VERSION) throw new Error(t("engine.pdf.otherEngineVersion", { name: p.name }));
    inputs.push({
      pageIndex: n.pageIndex,
      nodes: p.nodes,
      elevated: n.covers.some(isSurgeonMark),
      covers: n.covers.filter((c) => !isSurgeonMark(c)),
      pdfNode: { transform: n.transform, width: n.width, crop: n.crop },
    });
  }
  const { bytes, report } = await saveSurgical(sd, inputs, {
    prefix: surgeonPrefix(asset.hash),
    vectors: "auto",
    fallbackFont: loadFallbackFont,
    imageBytes: (id) => {
      const a = doc.assets[id];
      const b = a && getBlob(a.hash);
      return b ? { bytes: b, mime: a.mime } : undefined;
    },
    pageOrder: order,
  });
  const notes = [...extraNotes, ...formNotes, ...reportText(report)];
  // edits Illustrator's private data could not take: the person is told the layers merge in Illustrator — also for
  // a .pdf saved by Illustrator with its editing data, which Illustrator reopens the same way
  if (report.illustratorDataRemoved) notes.unshift(aiSaveNote(report.illustratorNote));
  // protected sources go out decrypted; the export step re-applies the password the person picks
  const out = !report.changed && (page.source?.protection || turns.size) ? sd.plain : bytes;
  return { bytes: out, notes, order, turns };
}

/**
 * The document's pages as one PDF in their order: this file's pages (with its edits, turns and form) as the base, then
 * pages taken from other PDF files (each file with its own edits) and pages that are not PDF pages (drawn by the PDF
 * exporter) put in their places — Acrobat's "insert pages", saved under this file's name.
 */
async function saveMergedPdf(doc: OmwDocument, page: Page, pages: Page[], others: Page[], confirm: (msg: string) => boolean, renderPdf?: (doc: OmwDocument, pages: Page[]) => Promise<Uint8Array>): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const base = await saveFileUpdate(doc, page, pages);
  if (base.turns.size) base.bytes = await applyTurns(base.bytes, base.turns, base.order);
  const notes = [...base.notes];
  const out = await PDFDocument.load(base.bytes, { updateMetadata: false });
  // other files: each saved with its own edits once, its pages copied from that
  const files = new Map<string, Promise<{ src: Awaited<ReturnType<typeof PDFDocument.load>>; up: FileUpdate }>>();
  const fileOf = (p: Page) => {
    const n = pdfNodeOf(p)!;
    const key = doc.assets[n.assetId]?.hash ?? n.assetId;
    let f = files.get(key);
    if (!f) {
      f = (async () => {
        const group = pagesFromSameFile(doc, p);
        const up = await saveFileUpdate(doc, group[0], group);
        if (up.turns.size) up.bytes = await applyTurns(up.bytes, up.turns, up.order);
        notes.push(...up.notes);
        return { src: await PDFDocument.load(up.bytes, { updateMetadata: false }), up };
      })();
      files.set(key, f);
    }
    return f;
  };
  // the base file once more, for copies of its pages (a page cannot be in the page tree twice)
  let baseCopy: Promise<Awaited<ReturnType<typeof PDFDocument.load>>> | null = null;
  const own = new Set(pages.map((p) => p.id));
  const placed = new Set<number>();
  let at = 0;
  let drawn = 0;
  for (const p of doc.pages) {
    const n = pdfNodeOf(p);
    if (own.has(p.id) && n && !placed.has(n.pageIndex)) {
      placed.add(n.pageIndex);
      at++;
      continue;
    }
    let copied;
    if (own.has(p.id) && n) {
      baseCopy ??= PDFDocument.load(base.bytes, { updateMetadata: false });
      [copied] = await out.copyPages(await baseCopy, [base.order.indexOf(n.pageIndex)]);
    } else if (n && (p.source?.format === "pdf" || p.source?.format === "ai") && doc.assets[n.assetId]) {
      const { src, up } = await fileOf(p);
      [copied] = await out.copyPages(src, [Math.max(0, up.order.indexOf(n.pageIndex))]);
      await keepFields(out, copied);
    } else if (renderPdf) {
      // a page that is not a PDF page (a new blank page, a picture, a slide): as the PDF exporter writes it
      const one = await PDFDocument.load(await renderPdf(doc, [p]), { updateMetadata: false });
      [copied] = await out.copyPages(one, [0]);
      drawn++;
    } else continue;
    out.insertPage(at++, copied);
  }
  notes.unshift(t("engine.pdf.mergedSave", { n: others.length + (pages.length - placed.size) }));
  if (drawn) notes.push(t("engine.pdf.drawnPages", { n: drawn }));
  if (notes.length > 1 && !confirm(t("engine.pdf.saveConfirm", { notes: notes.join("\n\n") }))) throw new Error(SAVE_CANCELLED);
  return out.save({ useObjectStreams: false });
}

/**
 * The form fields on a page copied from another file stay fields: their widgets came with the page, the fields they
 * belong to are added to this file's form (otherwise they showed their values but could no longer be filled).
 */
async function keepFields(out: import("pdf-lib").PDFDocument, page: import("pdf-lib").PDFPage) {
  const { PDFDict, PDFName, PDFRef } = await import("pdf-lib");
  const annots = page.node.Annots();
  if (!annots) return;
  const tops = new Set<string>();
  for (let i = 0; i < annots.size(); i++) {
    let ref: unknown = annots.get(i);
    const first = out.context.lookup(ref as import("pdf-lib").PDFObject);
    if (!(first instanceof PDFDict) || first.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) continue;
    let d: import("pdf-lib").PDFDict = first;
    // the field is the top of the /Parent chain
    for (let k = 0; k < 32; k++) {
      const parent: import("pdf-lib").PDFObject | undefined = d.get(PDFName.of("Parent"));
      const pd: unknown = parent && out.context.lookup(parent);
      if (!(parent instanceof PDFRef) || !(pd instanceof PDFDict)) break;
      ref = parent;
      d = pd;
    }
    if (!(ref instanceof PDFRef) || tops.has(ref.toString())) continue;
    tops.add(ref.toString());
    out.catalog.getOrCreateAcroForm().addField(ref);
  }
}