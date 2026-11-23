import { makeAsset } from "../core/assets";
import { docHooks } from "./editModes";
import { withWordDefaults } from "../core/lineSpacing";
import { getSecret, rememberSecret, withPassword } from "../io/crypto/session";
import { decryptOmw, encryptOmw, isEncryptedOmw } from "../io/crypto/omwCrypt";
import { encryptPdf } from "../io/crypto/pdfEncrypt";
import { decryptOffice, encryptOffice, isEncryptedOffice } from "../io/crypto/office";
import { encryptHwpx } from "../io/crypto/hwpx";
import { askProtection } from "./shell/SecurityDialogs";
import { askPictureOptions } from "./shell/ImageExportDialog";
import { forgetRecent, rememberRecent } from "./shell/recent";
import { historyForFile, resetHistory, useHistory } from "../core/history";
import { ANIM_PRESETS, type AnimPreset } from "../core/anim";
import { nodeBounds } from "../core/loom";
import { detachCopies, pickableOn, reorderInGroups } from "../core/layerTree";
import { currentPage, draftPage, findPage, selectedNodes, useStore } from "../core/store";
import { pathfinder, type BoolOp } from "../core/vector";
import {
  PAGE_PRESETS,
  copyNode,
  newDocument,
  newImage,
  newMedia,
  newPage,
  newRaster,
  newText,
  uid,
  type AssetRef,
  type Page,
  type PageKind,
  type SceneNode,
  type VectorNode,
} from "../core/types";
import { flattenRanges, parsePageRanges } from "../core/pages";
import { isSvg, svgIntrinsicSize } from "../render/svgSize";
import { svgToVectors } from "../io/svgVectors";
import { bakeAdjustments, exportImage, exportPdf, exportPng, exportSvg, pageRgba, rasterizeNode, webpBytesToPng } from "../io/export";
import { docFileStem, withExt } from "../io/exportName";
import { webpToPng } from "../io/webpPolicy";
import { EXPORTS, heicMessage, exportById, formatForExt, openFilters, sameTypeExport, TEXT_SOURCE_EXTS, type ExportDef } from "../io/formats";
import { SAVE_CANCELLED } from "../io/errors";
import { LARGE_MEDIA, probeMedia } from "../io/formats/media";
import { imageSize, isHeic } from "../io/formats/sniff";
import { journalClear } from "../io/journal";
import { activeSessionId, claimTab, isPristineActive, newSession, registerSessionPart, removeSession, setOpenedPath, setTabBusy, switchTo, tabForPath } from "../core/sessions";
import { packOmw, unpackOmw } from "../io/omw";
import { FILTERS, isTauri, openFiles, saveFile, type OpenedFile } from "../io/platform";
import { elevatePdfText } from "../io/pdf";
import { t } from "../i18n";
import { exportNotes } from "./exportNotes";
import { isCancelled, withProgress } from "./progress";
import { useUI } from "./shell/uiStore";
import { saveSmartToParent, smartLinkOf } from "./smartObject";

const S = () => useStore.getState();
/** count message: `<key>_one` when n is 1 (English singular), `<key>` otherwise */
const tn = (key: string, n: number, vars: Record<string, string | number> = {}) => t(n === 1 ? `${key}_one` : key, { n, ...vars });

/**
 * Most a fit enlarges a small canvas (Photoshop's 화면에 맞춤 zooms an icon-sized canvas up too): 16× shows a 16 px
 * canvas at 256 px. It was 4×, and a 64 px or 16 px canvas then sat as a speck in the middle of the window.
 */
export const FIT_ZOOM_MAX = 16;

/** The whole page centred in a viewW × viewH window with a 40 px margin, at most FIT_ZOOM_MAX. */
export function fitPageIn(page: { width: number; height: number }, viewW: number, viewH: number) {
  const zoom = Math.max(0.01, Math.min((viewW - 80) / page.width, (viewH - 80) / page.height, FIT_ZOOM_MAX));
  return { zoom, panX: (viewW - page.width * zoom) / 2, panY: (viewH - page.height * zoom) / 2 };
}

export function fitView(viewW: number, viewH: number) {
  const page = currentPage();
  if (!page) return;
  if (!docFitHook?.(page, viewW, viewH)) S().set({ view: fitPageIn(page, viewW, viewH) });
  lastFit = S().view;
}

/** the view fitView set last: while it is still the view (nobody moved or zoomed since), a canvas that changes size
 *  fits again — a file opened before the panels around the canvas settled (touch screens: the 1024 px layout grows
 *  the canvas after the first fit) no longer stays cut off */
let lastFit: unknown = null;
export const viewIsFitted = () => lastFit !== null && S().view === lastFit;

/** Fit in the document edit mode (page width, top of the page; ui/docView.ts) — a hook, so this module needs no view code. */
let docFitHook: ((page: Page, viewW: number, viewH: number) => boolean) | null = null;
export const setDocFitHook = (f: typeof docFitHook) => void (docFitHook = f);
/** The canvas size fitView last used (CanvasView reports it). */
export const viewportNow = () => viewport;

let viewport = { w: 1200, h: 800 };
export function setViewportSize(w: number, h: number) {
  viewport = { w, h };
}

/**
 * The view after the window grew / shrank by (dw, dh) without being fitted: the point at the window's centre stays at
 * the centre (Photoshop, Illustrator), so a canvas the user zoomed into does not slide towards a corner.
 */
export const keepCentre = (v: { zoom: number; panX: number; panY: number }, dw: number, dh: number) => ({ ...v, panX: v.panX + dw / 2, panY: v.panY + dh / 2 });
export const fitCurrent = () => fitView(viewport.w, viewport.h);

// ───────── file ─────────

/**
 * Browser demo: `?demo` (or the first visit to the hosted /app/) opens the sample workspace that
 * is published next to the app, so people can try Omniweave without installing anything.
 */
export async function openDemoIfRequested() {
  if (isTauri || typeof location === "undefined") return;
  const q = new URLSearchParams(location.search);
  if (!q.has("demo")) return;
  try {
    // only demo files published with the app (same origin) — never an arbitrary URL from a link
    const url = new URL(q.get("demo") || "demo.omw", location.href);
    if (url.origin !== location.origin) return;
    const res = await fetch(url.href);
    if (!res.ok) return;
    await openInTab({ name: "omniweave-demo.omw", path: null, bytes: new Uint8Array(await res.arrayBuffer()) });
  } catch {
    /* demo file missing — start empty */
  }
}

/** Browser start screen "예시 열기": the sample workspace published next to the app (demo.omw), in a tab of its own. */
export async function openSample() {
  try {
    const res = await fetch(new URL("demo.omw", location.href).href);
    if (!res.ok) throw new Error(String(res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    await withProgress(t("progress.open", { name: "omniweave-demo.omw" }), () => openInTab({ name: "omniweave-demo.omw", path: null, bytes }));
  } catch {
    S().notify(t("web.start.sampleFailed"));
  }
}

/**
 * Desktop: open the files the app was launched with (double-click, Windows "Open with", files dropped on the exe,
 * CLI arguments), each in its own tab, in order. One that cannot be read does not stop the others.
 */
export async function openStartupFile() {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const paths = await invoke<string[]>("startup_files");
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    try {
      const buf = await invoke<ArrayBuffer>("startup_bytes", { index });
      await openAndRemember({ name: path.split(/[\\/]/).pop()!, path, bytes: new Uint8Array(buf) });
    } catch (e: any) {
      S().notify(String(e?.message ?? e));
    }
  }
}

/**
 * Load a new document into its own tab: the active tab when it is an untouched new document, a new tab after it
 * otherwise (docs/design/SHELL_LAYOUT.md §5). Nothing is replaced, so nothing needs a "discard changes?" question.
 */
export function loadNewDocument(doc: import("../core/types").OmwDocument) {
  if (!isPristineActive()) newSession();
  S().load(doc);
  claimTab();
  omwSecretId = null; // a new document is not the protected file that was open before
  S().set({ mode: "AUTO" }); // the edit mode follows the page (ui/editModes.ts)
  setTimeout(fitCurrent);
}

export function newFile(kind: keyof typeof PAGE_PRESETS = "ARTBOARD") {
  const doc = newDocument();
  const preset = PAGE_PRESETS[kind];
  const p = doc.pages[0];
  p.width = preset.width;
  p.height = preset.height;
  p.kind = preset.kind;
  p.name = t(`doc.preset.${kind}`, undefined, preset.label);
  if (preset.kind !== "DESIGN") p.nodes = [];
  if (preset.kind === "SLIDE") p.transition = { type: "FADE", duration: 400 };
  if (preset.kind === "DOCUMENT") {
    const tx = newText(t("doc.newDocText"), preset.width - 152);
    // a new document: Word's paragraph defaults (multiple 1.08, 8 pt after; core/lineSpacing.ts)
    tx.paragraphs = tx.paragraphs.map(withWordDefaults);
    tx.transform = { x: 76, y: 76, rotation: 0, scale: 1 };
    p.nodes.push(tx);
  }
  loadNewDocument(doc);
}

export async function openAny() {
  const files = await openFiles(openFilters(), true);
  for (const f of files) await openAndRemember(f);
}

/**
 * Open a file as a document of its own (public API for every "open"): a file that is already open just brings
 * its tab forward; otherwise it goes into the active tab when that is an untouched new document, or into a new
 * tab. A file that fails to open (or is cancelled at its password prompt) leaves no empty tab behind.
 * Returns the pages it brought in (an image placed on the new document's page counts as opened, with no pages).
 */
export async function openInTab(f: OpenedFile, opts: { asSource?: boolean } = {}): Promise<Page[]> {
  if (f.path) {
    const open = tabForPath(f.path);
    if (open) {
      switchTo(open);
      S().notify(t("tabs.alreadyOpen", { name: f.name }));
      return [];
    }
  }
  const from = activeSessionId();
  const reuse = isPristineActive();
  const id = reuse ? from : newSession(f.name.replace(/\.[^.]+$/, ""));
  const before = S().doc;
  setTabBusy(id, true);
  let pages: Page[] = [];
  try {
    pages = await importFile(f, opts);
  } finally {
    setTabBusy(id, false);
  }
  const opened = pages.length > 0 || S().doc !== before;
  if (!opened) {
    // nothing came in: drop the tab made for it and go back where the person was
    if (!reuse && activeSessionId() === id) {
      removeSession(id);
      switchTo(from);
    }
    return [];
  }
  if (activeSessionId() === id) {
    claimTab(id);
    if (f.path) setOpenedPath(id, f.path);
    // a drawing (DXF / DWG) is read by its layers, as in AutoCAD: show the layer panel (folders = drawing layers)
    if (pages.some((p) => p.source?.cad)) useUI.getState().set({ leftTab: "layers" });
    // a file opened into a tab of its own is not an edit (Word, 한글): nothing to undo back to an empty page and no
    // "save changes?" when the tab or the app closes untouched
    if (S().past.length || S().dirty) {
      S().set({ past: [], future: [], dirty: false });
      resetHistory(S().doc, t("doc.history.open"));
    }
  }
  return pages;
}

/** Open a file in a tab and, when it came from disk and opened, put it on the start screen's recent list. */
export async function openAndRemember(f: OpenedFile) {
  const pages = await withProgress(t("progress.open", { name: f.name }), () => openInTab(f));
  // after first paint of images; the thumbnail is of the first page this file brought in (opening into an open
  // document appends), and none at all for password-protected content (localStorage is plain text)
  if (pages.length && f.path) setTimeout(() => rememberRecent(f.path, f.name, S().doc, { protected: isDocProtected(), page: S().doc.pages.find((p) => p.id === pages[0].id) }), 600);
  return pages;
}

/** Reopen a recent file by path (desktop); a file that is gone is dropped from the list. */
export async function openRecentFile(path: string) {
  if (!isTauri) return;
  const open = tabForPath(path);
  if (open) return void switchTo(open);
  try {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const bytes = await readFile(path);
    await openAndRemember({ name: path.split(/[\\/]/).pop()!, path, bytes });
  } catch (e: any) {
    forgetRecent(path);
    S().notify(t("start.recent.missing", { message: String(e?.message ?? e) }));
  }
}

/** New document whose first page is `page` (start-screen templates and custom sizes). */
export function newFileFromPage(page: Page, title?: string) {
  const doc = newDocument();
  if (title) doc.title = title;
  if (page.kind === "SLIDE" && page.transition.type === "NONE") page.transition = { type: "FADE", duration: 400 };
  doc.pages = [page];
  // a template opens in the edit mode of its kind (ui/editModes.ts)
  loadNewDocument(doc);
}

/** Open text-like files (HTML, Markdown, CSV, SRT, JSON…) as raw source text in a monospace editor. */
export async function openAsSource() {
  const files = await openFiles([{ name: t("doc.filter.textSource"), extensions: TEXT_SOURCE_EXTS }], true);
  for (const f of files) await openInTab(f, { asSource: true });
}

const ask = (msg: string) => (typeof confirm === "function" ? confirm(msg) : false);

/** Result of the most recent importFile call (for diagnostics and corpus tests). */
export let lastImport: { name: string; format: string; pages: number; nodes: number; warnings: string[]; message: string; error?: string } | null = null;

export interface ImportOptions {
  asSource?: boolean;
  /**
   * Insert the file's pages at this index of the page list (0 = before the first page) instead of
   * after the current page. Images become a page of their own in this mode.
   */
  at?: number;
  /** Only these pages of the file, as a range string ("1-3, 5, 8-"); all when omitted */
  pages?: string;
  /**
   * Put a picture (PNG · JPG · SVG …) on the current page — at the caret when typing in a document body — instead
   * of opening it as a canvas of its own: Insert ▸ Picture and dropping onto the canvas.
   */
  place?: boolean;
}

/** Pages made from one file, without touching the open document. */
export interface FilePages {
  pages: Page[];
  assets: Record<string, AssetRef>;
  format: string;
  mode?: "DOCUMENT" | "SLIDE" | "DESIGN";
  message?: string;
  warnings: string[];
}

/** A page holding one image, A4 in the image's orientation, the image fitted inside. */
export async function imagePage(bytes: Uint8Array, mime: string, name: string): Promise<{ page: Page; assets: Record<string, AssetRef> }> {
  const size = await measureImage(bytes, mime);
  const asset = makeAsset(bytes, mime, name);
  const landscape = size.width > size.height;
  const W = landscape ? PAGE_PRESETS.A4.height : PAGE_PRESETS.A4.width, H = landscape ? PAGE_PRESETS.A4.width : PAGE_PRESETS.A4.height;
  const page = newPage("DOCUMENT", W, H, name);
  const k = Math.min(W / size.width, H / size.height);
  const node = newImage(asset.id, size.width * k, size.height * k, name);
  node.transform = { x: (W - node.width) / 2, y: (H - node.height) / 2, rotation: 0, scale: 1 };
  page.nodes.push(node);
  page.source = { format: "image", name };
  return { page, assets: { [asset.id]: asset } };
}

/** Formats whose pixels may be transparent: their canvas starts transparent (Photoshop's checkerboard). */
const ALPHA_EXTS = new Set(["png", "webp", "gif", "avif", "ico", "tif", "tiff"]);

/**
 * A picture opened as a file: a canvas page of the picture's own size with the picture on it at 100 %, its source
 * format kept (png / jpg / svg …) so AUTO opens it in the image or design edit mode.
 */
export async function canvasImagePage(bytes: Uint8Array, mime: string, name: string, ext: string): Promise<{ page: Page; assets: Record<string, AssetRef> }> {
  const size = await measureImage(bytes, mime);
  const asset = makeAsset(bytes, mime, name);
  const W = Math.max(1, Math.round(size.width)), H = Math.max(1, Math.round(size.height));
  // the page (and so the tab / document title) is the file name without its extension, as for DOCX · PSD · PDF —
  // Word's title and tab, with Windows' default of hiding known extensions; the source keeps the full name
  const stem = name.replace(/\.[^.]+$/, "") || name;
  const page = newPage("DESIGN", W, H, stem);
  const svg = isSvg(bytes, mime);
  // SVG artwork opens as editable paths (Illustrator); one that needs more than paths stays a picture
  const art = svg ? svgToVectors(new TextDecoder().decode(bytes)) : null;
  if (art) {
    const vp = newPage("DESIGN", Math.max(1, art.width), Math.max(1, art.height), stem);
    vp.nodes = art.nodes;
    if (art.groups.length) vp.groups = art.groups;
    vp.source = { format: "svg", name };
    return { page: vp, assets: {} };
  }
  if (!svg && ALPHA_EXTS.has(ext)) page.background = "transparent";
  const node = newImage(asset.id, W, H, name);
  node.transform = { x: 0, y: 0, rotation: 0, scale: 1 };
  page.nodes.push(node);
  page.source = { format: svg ? "svg" : ext === "jpeg" ? "jpg" : ext, name };
  return { page, assets: { [asset.id]: asset } };
}

/**
 * Turn a file into pages the same way "open" does (format registry, password prompts for
 * protected PDF / Office / .omw files), but without adding them to the document. Images become
 * a page each; video and audio cannot become pages.
 */
export async function fileToPages(f: OpenedFile, opts: { asSource?: boolean } = {}): Promise<FilePages> {
  const ext = f.name.split(".").pop()!.toLowerCase();
  if (ext === "omw") {
    let bytes = f.bytes;
    if (isEncryptedOmw(bytes)) {
      const r = await withPassword({ title: t("doc.pw.omwTitle"), message: t("doc.pw.omwMessage", { name: f.name }) }, (pw) => decryptOmw(f.bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
      if (!r) throw new Error(t("doc.pw.cancelled"));
      bytes = r.value;
    }
    const { doc } = unpackOmw(bytes);
    // master pages travel with the slides that use them: inline the master's objects underneath
    const pages = doc.pages.map((p) => {
      const m = p.masterId ? doc.masters.find((x) => x.id === p.masterId) : null;
      return m ? { ...p, masterId: null, nodes: [...m.nodes.map((n) => ({ ...n, id: uid(), locked: true })), ...p.nodes] } : p;
    });
    return { pages, assets: doc.assets, format: "omw", warnings: [] };
  }
  const fmt = formatForExt(opts.asSource && ext === "svg" ? "txt" : ext);
  if (!fmt?.open) throw new Error(t("doc.err.unsupported", { ext }));
  let officeSecret: string | null = null;
  if (["docx", "xlsx", "xlsm", "pptx", "ppsx"].includes(ext) && isEncryptedOffice(f.bytes)) {
    const r0 = await withPassword({ title: t("doc.pw.officeTitle"), message: t("doc.pw.officeMessage", { name: f.name }) }, (pw) => decryptOffice(f.bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
    if (!r0) throw new Error(t("doc.pw.cancelled"));
    f = { ...f, bytes: r0.value };
    officeSecret = rememberSecret(r0.password);
  }
  // decrypted: the Office Surgeon keeps no copy of the original (no plaintext package in .omw / journal)
  const r = await fmt.open(f, { confirm: ask, asSource: opts.asSource, decrypted: !!officeSecret });
  const pages = r.pages ? [...r.pages] : [];
  const assets: Record<string, AssetRef> = { ...(r.assets ?? {}) };
  if (officeSecret) for (const p of pages) p.source = { ...(p.source ?? { format: ext, name: f.name }), protection: { scheme: "office-agile", secretId: officeSecret } };
  if (r.place?.kind === "image") {
    if (isHeic(r.place.bytes)) throw new Error(heicMessage());
    const ip = await imagePage(r.place.bytes, r.place.mime, r.place.name);
    pages.push(ip.page);
    Object.assign(assets, ip.assets);
  } else if (r.place?.kind === "media") throw new Error(t("doc.err.mediaNotPage"));
  return { pages, assets, format: fmt.id, mode: r.mode, message: r.message, warnings: r.warnings ?? [] };
}

/** Keep only the pages named by a range string (1-based, "1-3, 5, 8-"). */
export function pickPages(pages: Page[], range: string | undefined): Page[] {
  if (!range || !range.trim()) return pages;
  const r = parsePageRanges(range, pages.length);
  if (r.error) throw new Error(r.error);
  return flattenRanges(r.groups).map((i) => pages[i]);
}

/**
 * Open a file. Without options it behaves as before (pages go after the current page, images and
 * media are placed on the current page). With `at` / `pages` the chosen pages are inserted at that
 * position. Returns the pages that were added.
 */
export async function importFile(f: OpenedFile, opts: ImportOptions = {}): Promise<Page[]> {
  const ext = f.name.split(".").pop()!.toLowerCase();
  if (opts.at !== undefined || opts.pages) {
    try {
      const r = await fileToPages(f, { asSource: opts.asSource });
      let pages = pickPages(r.pages, opts.pages);
      if (!pages.length) {
        lastImport = { name: f.name, format: r.format, pages: 0, nodes: 0, warnings: r.warnings, message: "", error: "페이지 없음" }; // i18n: keep
        S().notify(t("doc.toast.noPagesIn", { name: f.name }));
        return [];
      }
      pages = addPages(pages, r.assets, { at: opts.at, label: t("doc.history.insertPagesFrom", { name: f.name }) });
      lastImport = { name: f.name, format: r.format, pages: pages.length, nodes: pages.reduce((a, p) => a + p.nodes.length, 0), warnings: r.warnings, message: r.message ?? "" };
      S().notify(tn("doc.toast.insertedPages", pages.length, { name: f.name }));
      return pages;
    } catch (e: any) {
      console.error(e);
      lastImport = { name: f.name, format: ext, pages: 0, nodes: 0, warnings: [], message: "", error: String(e?.message ?? e) };
      if (typeof alert === "function") alert(t("doc.alert.insertFailed", { name: f.name, error: String(e?.message ?? e) }));
      return [];
    }
  }
  try {
    if (ext === "omw") {
      if (S().dirty && !ask(t("doc.confirm.openUnsaved"))) return [];
      const t0 = performance.now();
      let bytes = f.bytes;
      // the open document keeps its own protection until the new one has actually loaded
      let secretId: string | null = null;
      if (isEncryptedOmw(bytes)) {
        const r = await withPassword({ title: t("doc.pw.omwTitle"), message: t("doc.pw.omwMessage", { name: f.name }) }, (pw) => decryptOmw(f.bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
        if (!r) {
          S().notify(t("doc.toast.openCancelled"));
          return [];
        }
        bytes = r.value;
        secretId = rememberSecret(r.password);
      }
      const { doc, report, history } = unpackOmw(bytes);
      S().load(doc, f.path);
      omwSecretId = secretId;
      if (history.length) resetHistory(doc, t("doc.history.open"), history);
      const problems = report.corruptTiles + report.missingTiles + report.missingAssets + report.corruptAssets;
      S().notify(
        problems
          ? t("doc.toast.openedSkipped", { n: problems })
          : t("doc.toast.openedVerified", { name: f.name, ms: Math.round(performance.now() - t0) }),
      );
      setTimeout(fitCurrent);
      return doc.pages;
    }
    const fmt = formatForExt(opts.asSource && ext === "svg" ? "txt" : ext);
    if (!fmt?.open) {
      lastImport = { name: f.name, format: ext, pages: 0, nodes: 0, warnings: [], message: "", error: "지원하지 않는 형식" }; // i18n: keep
      S().notify(t("doc.err.unsupported", { ext }));
      return [];
    }
    // password-protected Office documents: ask, decrypt in memory, remember only a session key
    let officeSecret: string | null = null;
    if (["docx", "xlsx", "xlsm", "pptx", "ppsx"].includes(ext) && isEncryptedOffice(f.bytes)) {
      const r0 = await withPassword({ title: t("doc.pw.officeTitle"), message: t("doc.pw.officeMessage", { name: f.name }) }, (pw) => decryptOffice(f.bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
      if (!r0) {
        S().notify(t("doc.toast.openCancelled"));
        return [];
      }
      f = { ...f, bytes: r0.value };
      officeSecret = rememberSecret(r0.password);
    }
    // decrypted: the Office Surgeon keeps no copy of the original (no plaintext package in .omw / journal)
    const r = await fmt.open(f, { confirm: ask, asSource: opts.asSource, decrypted: !!officeSecret });
    if (officeSecret && r.pages)
      for (const p of r.pages) p.source = { ...(p.source ?? { format: ext, name: f.name }), protection: { scheme: "office-agile", secretId: officeSecret } };
    // opening a picture (PNG · JPG · SVG …) opens it as a canvas of its own size that remembers its format, so the
    // edit mode follows it (image → Photoshop-like, SVG → Illustrator-like; ui/editModes.ts), in a document tab of
    // its own: openInTab has already given it one; called on its own, a new tab is opened here unless the active
    // one is an untouched new document. Placing a picture on the current page is Insert ▸ Picture / paste / drop
    // (`place`).
    if (r.place?.kind === "image" && opts.place) await placeImage(r.place.bytes, r.place.mime, r.place.name);
    else if (r.place?.kind === "image") {
      if (isHeic(r.place.bytes)) throw new Error(heicMessage());
      // (an .ai / .pdf that opened as its preview picture is that picture, not the PDF: its source format is the picture's)
      const ip = await canvasImagePage(r.place.bytes, r.place.mime, r.place.name, /^(ai|pdf)$/.test(ext) ? (r.place.name.split(".").pop() ?? ext).toLowerCase() : ext);
      if (!isPristineActive()) newSession(f.name.replace(/\.[^.]+$/, ""));
      r.pages = [...(r.pages ?? []), ip.page];
      r.assets = { ...(r.assets ?? {}), ...ip.assets };
      claimTab();
    } else if (r.place?.kind === "media") {
      if (!(await placeMedia(r.place.bytes, r.place.mime, r.place.media, r.place.name))) {
        lastImport = { name: f.name, format: fmt.id, pages: 0, nodes: 0, warnings: [], message: "", error: "취소" }; // i18n: keep
        return [];
      }
    }
    let added: Page[] = [];
    if (r.pages?.length) {
      added = addPages(r.pages, r.assets ?? {}, { title: f.name.replace(/\.[^.\\/]+$/, "") || f.name });
      // no explicit work mode is set: AUTO gives each page the edit mode of its kind and source format (ui/editModes.ts)
    }
    if (r.message) S().notify(r.message);
    lastImport = { name: f.name, format: fmt.id, pages: r.pages?.length ?? 0, nodes: r.pages ? r.pages.reduce((a, p) => a + p.nodes.length, 0) : r.place ? 1 : 0, warnings: r.warnings ?? [], message: r.message ?? "" };
    return added;
  } catch (e: any) {
    console.error(e);
    lastImport = { name: f.name, format: ext, pages: 0, nodes: 0, warnings: [], message: "", error: String(e?.message ?? e) };
    if (typeof alert === "function") alert(t("doc.alert.openFailed", { name: f.name, error: String(e?.message ?? e) }));
    return [];
  }
}

/**
 * Copy of `v` with every string equal to an old id replaced by its new id — object ids, animation targets and
 * the round-trip maps in `page.source` (PSD layer links, Markdown fragments) alike. Binary data is shared.
 */
function renameIds(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === "string") return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => renameIds(x, map));
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = renameIds(x, map);
    return out;
  }
  return v;
}

/**
 * Add pages (and their assets) as one undoable step. Default: after the current page; `at` = index
 * in the page list. A pristine blank document's only page is replaced instead of kept.
 */
export function addPages(pages: Page[], assets: Record<string, AssetRef>, opts: { at?: number; label?: string; title?: string } = {}): Page[] {
  if (!pages.length) return pages;
  const s = S();
  const cur = currentPage();
  // replace a pristine blank first page instead of appending after it
  const pristine = s.doc.pages.length === 1 && !s.past.length && cur && cur.nodes.every((n) => n.type === "RASTER" && !Object.keys(n.tiles).length);
  // pages of an .omw keep their stored page / object ids: inserting a file into itself, twice, or an older
  // copy of this document must not repeat one (text editing and lookups find objects by id document-wide)
  const keep = pristine ? [] : [...s.doc.pages, ...s.doc.masters];
  const taken = new Set(keep.map((p) => p.id));
  const takenNodes = new Set(keep.flatMap((p) => p.nodes.map((n) => n.id)));
  pages = pages.map((p) => {
    const map = new Map<string, string>();
    for (const n of p.nodes) {
      if (takenNodes.has(n.id)) map.set(n.id, uid());
      takenNodes.add(map.get(n.id) ?? n.id);
    }
    const q = map.size ? (renameIds(p, map) as Page) : p;
    const out = taken.has(q.id) ? { ...q, id: uid("pg") } : q;
    taken.add(out.id);
    return out;
  });
  s.commit(opts.label ?? t("doc.history.importPages"), (d) => {
    Object.assign(d.assets, assets);
    if (pristine) d.pages = pages as any;
    else {
      const i = opts.at !== undefined ? Math.max(0, Math.min(d.pages.length, opts.at)) : d.pages.findIndex((p) => p.id === s.pageId) + 1;
      d.pages.splice(i, 0, ...(pages as any));
    }
    // the document is named after the file it was opened from ("report" for report.pdf, deck.odp, book.xlsx …), not
    // after its first page: a slide, sheet or PDF page name gave tabs like "Sheet1" or "deck - 1" (QA 2026-11-23)
    if (pristine) d.title = opts.title ?? pages[0]?.name.split(" · ")[0] ?? d.title;
  });
  S().set({ pageId: pages[0].id, selection: [] });
  setTimeout(fitCurrent);
  return pages;
}

async function measureImage(bytes: Uint8Array, mime: string): Promise<{ width: number; height: number }> {
  if (isHeic(bytes)) throw new Error(heicMessage());
  // SVG: its own width / height / viewBox (createImageBitmap cannot decode SVG in Chromium)
  if (isSvg(bytes, mime)) return svgIntrinsicSize(new TextDecoder().decode(bytes));
  let size = imageSize(bytes);
  if (typeof createImageBitmap === "function") {
    try {
      const bmp = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
      size = { width: bmp.width, height: bmp.height };
      bmp.close();
    } catch {
      if (mime !== "image/svg+xml") throw new Error(t("doc.err.imageDecode", { mime }));
    }
  }
  return size ?? { width: 400, height: 300 };
}

export async function placeImage(bytes: Uint8Array, mime: string, name: string) {
  const size = await measureImage(bytes, mime);
  const asset = makeAsset(bytes, mime, name);
  const page = currentPage()!;
  const k = Math.min(1, (page.width * 0.8) / size.width, (page.height * 0.8) / size.height);
  const node = newImage(asset.id, size.width * k, size.height * k, name);
  // typing in a document body: the picture goes into the text at the caret (ui/docFlow.ts)
  if (docHooks.insertInline?.(node, { [asset.id]: asset })) return;
  node.transform = { x: (page.width - node.width) / 2, y: (page.height - node.height) / 2, rotation: 0, scale: 1 };
  addNode(node, { [asset.id]: asset });
}

/** Place a video or audio clip on the current page. Undecodable containers are refused with the reason. */
export async function placeMedia(bytes: Uint8Array, mime: string, media: "video" | "audio", name: string): Promise<boolean> {
  if (bytes.length > LARGE_MEDIA && !ask(t("doc.confirm.largeMedia", { name, mb: (bytes.length / 1048576).toFixed(0) }))) return false;
  const probe = await probeMedia(bytes, mime, media);
  if (!probe.ok && typeof document !== "undefined")
    throw new Error(t("doc.err.mediaHelp", { reason: probe.error ?? t("doc.err.unplayable") }));
  const asset = makeAsset(bytes, mime, name);
  const assets: Record<string, import("../core/types").AssetRef> = { [asset.id]: asset };
  const page = currentPage()!;
  const w0 = media === "audio" ? 360 : probe.width || 640, h0 = media === "audio" ? 72 : probe.height || 360;
  const k = Math.min(1, (page.width * 0.8) / w0, (page.height * 0.8) / h0);
  const node = newMedia(media, asset.id, w0 * k, h0 * k, name);
  node.duration = probe.duration;
  if (probe.poster) {
    const pa = makeAsset(probe.poster, "image/jpeg", t("doc.posterName", { name }));
    assets[pa.id] = pa;
    node.posterAssetId = pa.id;
  }
  node.transform = { x: (page.width - node.width) / 2, y: (page.height - node.height) / 2, rotation: 0, scale: 1 };
  addNode(node, assets);
  S().notify(t(`doc.toast.${media === "video" ? "video" : "audio"}Placed${probe.duration ? "Dur" : ""}`, { name, s: Math.round(probe.duration ?? 0) }));
  return true;
}

// ───────── password protection ─────────

/** session secret of the encrypted .omw this document was opened from */
let omwSecretId: string | null = null;
// … per document tab (core/sessions.ts)
registerSessionPart<string | null>({ key: "omwSecret", capture: () => omwSecretId, restore: (v) => void (omwSecretId = v ?? null) });

/** formats that can carry a password, and how to apply it */
const ENCRYPTORS: Record<string, (bytes: Uint8Array, pw: string) => Promise<Uint8Array>> = {
  pdf: encryptPdf,
  ai: encryptPdf, // PDF-compatible Illustrator files carry standard PDF encryption
  omw: encryptOmw,
  docx: encryptOffice,
  xlsx: encryptOffice,
  pptx: encryptOffice,
  hwpx: encryptHwpx,
};

export function registerEncryptor(ext: string, fn: (bytes: Uint8Array, pw: string) => Promise<Uint8Array>) {
  ENCRYPTORS[ext] = fn;
}

function docProtection() {
  const ids = [omwSecretId, ...S().doc.pages.map((p) => p.source?.protection?.secretId)].filter((x): x is string => !!x);
  return { wasProtected: ids.length > 0, secretId: ids.find((id) => getSecret(id)) ?? null };
}

/** The open document came from (or was saved as) a password-protected file. Autosave/journal code
 * should not persist such content in the clear. */
export function isDocProtected(): boolean {
  return docProtection().wasProtected;
}

/**
 * Apply the protection the person chooses. Asked automatically when the content came from a
 * protected file; `force` asks even for unprotected documents ("암호 걸어 저장").
 * Returns null when cancelled; `secretId` is the session secret actually used (null = written unprotected).
 */
export async function protectOutput(ext: string, bytes: Uint8Array, force = false): Promise<{ bytes: Uint8Array; secretId: string | null } | null> {
  const { wasProtected, secretId } = docProtection();
  if (!wasProtected && !force) return { bytes, secretId: null };
  const supported = !!ENCRYPTORS[ext];
  const choice = await askProtection({ ext, wasProtected, canReuse: !!secretId, supported });
  if (!choice) return null;
  if (choice.mode === "none" || !supported) return { bytes, secretId: null };
  const usedId = choice.mode === "same" ? secretId : choice.password ? rememberSecret(choice.password) : null;
  const pw = getSecret(usedId ?? undefined);
  // asked to protect but no password is available: refuse rather than write the content in the clear
  if (!pw || !usedId) throw new Error(t("doc.err.noPassword"));
  S().notify(t("doc.toast.encrypting"));
  return { bytes: await ENCRYPTORS[ext](bytes, pw), secretId: usedId };
}

export async function saveDoc(as = false, forceProtect = false) {
  // a smart object's content tab: saving puts it back into its parent document (Photoshop's Edit Contents)
  if (!as && !forceProtect && smartLinkOf() && (await saveSmartToParent())) return;
  const s = S();
  // a Word / 한글 document opened from its file and not yet kept as .omw: 저장 writes its own format, as Word and 한글
  // do (a save that would lose something asks first — the original-format export's confirm); 다른 이름으로 저장 keeps
  // the work file (QA ui-audit #51: Ctrl+S on an HWPX wrote .omw)
  const cur = currentPage();
  if (!as && !forceProtect && !s.filePath && cur?.source && WORD_SAVE_SAME.has(cur.source.format) && sameTypeExport(cur, s.doc.pages)) {
    if (await exportAs("same")) S().set({ dirty: false });
    return;
  }
  // a format Omniweave opens but cannot write back (ODP): which format 저장 writes instead is said and asked
  const instead = cur?.source && !s.filePath && !as && !forceProtect ? SAVE_INSTEAD[cur.source.format] : undefined;
  if (instead) {
    if (!ask(t("doc.confirm.saveInstead", { from: instead.from, to: instead.to }))) return S().notify(t("doc.toast.saveCancelled"));
    if (await exportAs(instead.id)) S().set({ dirty: false });
    return;
  }
  const t0 = performance.now();
  const h = useHistory.getState();
  const packed = await withProgress(t("progress.save"), () => packOmw(s.doc, h.includeInFile ? historyForFile(h.entries, s.doc) : []));
  const stats = packed.stats;
  let prot: Awaited<ReturnType<typeof protectOutput>>;
  try {
    prot = await protectOutput("omw", packed.bytes, forceProtect);
  } catch (e: any) {
    if (typeof alert === "function") alert(t("doc.alert.saveFailed", { error: String(e?.message ?? e) }));
    return;
  }
  if (!prot) return S().notify(t("doc.toast.saveCancelled"));
  const bytes = prot.bytes;
  const name = withExt(docFileStem(s.doc), "omw");
  const path = await saveFile(name, bytes, [FILTERS.omw], as || forceProtect ? null : s.filePath);
  if (!path) return;
  // the file on disk is now protected with this secret: later saves must ask (and offer it as "same")
  if (prot.secretId) omwSecretId = prot.secretId;
  S().set({ dirty: false, filePath: path.includes("\\") || path.includes("/") ? path : s.filePath });
  rememberRecent(path, path.split(/[\\/]/).pop() ?? name, S().doc, { protected: isDocProtected() });
  journalClear(activeSessionId()).catch(() => {});
  S().notify(
    t(stats.historyEntries ? "doc.toast.savedWithHistory" : "doc.toast.saved", {
      kb: (stats.bytes / 1024).toFixed(0),
      tiles: stats.tiles,
      steps: stats.historyEntries,
      ms: Math.round(performance.now() - t0),
    }),
  );
}

/** Export target ids from the format registry ("same" = the current page's original format). */
export type ExportKind = string;

export function exportTargets(): ExportDef[] {
  const page = currentPage();
  const same = page ? sameTypeExport(page, S().doc.pages) : null;
  return same ? [same, ...EXPORTS] : EXPORTS;
}

/** Export formats with no adjustment layer (PDF bakes inside exportPdf, also for print). */
const BAKE_ADJUST = new Set(["svg", "docx", "hwpx", "pptx"]);

export async function exportAs(kind: ExportKind, forceProtect = false) {
  // PDF export warnings (missing glyphs placed as images, dropped objects) are shown to the person
  const pdfWarnings: string[] = [];
  let adjNote: string | null = null;
  let saved = false;
  const s = S();
  const page = currentPage();
  if (!page) return;
  const def = kind === "same" ? sameTypeExport(page, s.doc.pages) : exportById(kind);
  if (!def) return S().notify(t("doc.toast.unknownExport", { kind }));
  // "name.ext": the document's name (untitled: the file its page came from) with the extension once; per-page
  // formats (PNG · JPG · WebP · SVG · PSD) add the page name only when it says more (io/exportName.ts)
  const fileName = withExt(def.fileName?.(s.doc, page) ?? docFileStem(s.doc), def.ext);
  try {
    const out = await withProgress(t("progress.export", { fmt: def.ext.toUpperCase() }), async () => {
      // formats without adjustment layers: what they touch goes in as a picture (PDF does this itself, exportPdf)
      const b = BAKE_ADJUST.has(def.id) ? await bakeAdjustments(s.doc, [page]) : { doc: s.doc, pages: [page], note: null };
      adjNote = b.note;
      // Word / 한글: a WebP the person put in is saved as a PNG (lossless); the file's own WebP stay (io/webpPolicy.ts)
      const d = def.id === "docx" || def.id === "hwpx" || (def.id === "same" && (def.ext === "docx" || def.ext === "hwpx")) ? await webpToPng(b.doc, webpBytesToPng) : b.doc;
      return def.run(d, d.pages.find((p) => p.id === b.pages[0].id) ?? b.pages[0], {
        confirm: ask,
        rasterize: rasterizeNode,
        png: (d, p) => exportPng(d, p, 2),
        pdf: (d, ps) => exportPdf(d, ps, { onWarning: (m) => pdfWarnings.push(m) }),
        svg: (d, p) => exportSvg(d, p),
        pageRgba: (d, p, k) => pageRgba(d, p, k),
        encodeImage: (d, p, o) => exportImage(d, p, o),
        pictureOptions: (req) => askPictureOptions(req),
      });
    }, { cancel: true });
    const raw = typeof out === "string" ? new TextEncoder().encode(out) : out;
    const prot = typeof out === "string" && !forceProtect && !docProtection().wasProtected ? { bytes: out, secretId: null } : await protectOutput(def.ext, raw, forceProtect);
    if (prot == null) return S().notify(t("doc.toast.exportCancelled"));
    const path = await saveFile(fileName, prot.bytes, [def.filter]);
    // a format with its own notice (DOC / XLS / PPT: "saved as the original file") says it in place of "exported"
    saved = !!path;
    if (path) S().notify((def.doneNote && !prot.secretId ? def.doneNote : t(prot.secretId ? "doc.toast.exportedProtected" : "doc.toast.exported", { fmt: def.ext.toUpperCase() })) + (adjNote ? ` · ${adjNote}` : ""));
    // what this format keeps of effects and other properties (core/style/caps.ts), after the saved notice
    const capNotes = path ? exportNotes(def.ext === "pdf" ? s.doc.pages : [page], def.ext) : [];
    if (capNotes.length) setTimeout(() => S().notify(capNotes.join(" · ")), pdfWarnings.length ? 5200 : 2400);
    if (path && pdfWarnings.length) {
      const uniq = [...new Set(pdfWarnings)];
      const notes = uniq.slice(0, 2).join(" · ");
      setTimeout(() => S().notify(uniq.length > 2 ? t("doc.toast.pdfNoteMore", { notes, n: uniq.length - 2 }) : t("doc.toast.pdfNote", { notes })), 2400);
    }
  } catch (e: any) {
    if (e?.message === SAVE_CANCELLED) return S().notify(t("doc.toast.saveCancelled"));
    if (isCancelled(e)) return S().notify(t("doc.toast.exportCancelled"));
    alert(t("doc.alert.exportFailed", { error: String(e?.message ?? e) }));
  }
  return saved;
}

/**
 * Source formats whose 저장 (Ctrl+S) writes the original format: Word / 한글 documents, and the workbooks, decks and PDFs
 * Omniweave saves back the same way (Excel / PowerPoint / Acrobat: Ctrl+S keeps the file's format; 다른 이름으로 저장 = .omw).
 */
const WORD_SAVE_SAME = new Set(["docx", "hwpx", "hwp", "xlsx", "xlsm", "csv", "pptx", "ppsx", "pdf"]);
/** Formats opened but not written back: 저장 offers this one instead, saying why (ODP → PPTX). */
const SAVE_INSTEAD: Record<string, { id: string; from: string; to: string }> = { odp: { id: "pptx", from: "ODP (.odp)", to: "PowerPoint (.pptx)" } };
/** What 저장 (Ctrl+S) writes for a document opened from a file of this format and not yet kept as .omw. */
export const saveTargetFor = (format: string): "same" | string | "omw" => (WORD_SAVE_SAME.has(format) ? "same" : SAVE_INSTEAD[format]?.id ?? "omw");

// ───────── pages ─────────

export function addPage(kind: PageKind = "DESIGN") {
  const s = S();
  const cur = currentPage();
  // a document page after a document page continues its section: same paper, orientation and margins (쪽 설정)
  const sameDoc = kind === "DOCUMENT" && cur?.kind === "DOCUMENT";
  const preset = kind === "SLIDE" ? PAGE_PRESETS.SLIDE_16_9 : sameDoc ? { width: cur.width, height: cur.height } : kind === "DOCUMENT" ? PAGE_PRESETS.A4 : { width: cur?.width ?? 1920, height: cur?.height ?? 1080 };
  const nameKey = kind === "SLIDE" ? "doc.pageName.SLIDE" : kind === "DOCUMENT" ? "doc.pageName.DOCUMENT" : "doc.pageName.DESIGN";
  const p = newPage(kind, preset.width, preset.height, t(nameKey, { n: s.doc.pages.filter((x) => x.kind === kind).length + 1 }));
  if (sameDoc && cur.margins) p.margins = { ...cur.margins };
  if (kind === "SLIDE") p.masterId = cur?.masterId ?? null;
  if (kind === "DESIGN") p.nodes.push(newRaster());
  s.commit(t("doc.history.addPage"), (d) => {
    const i = d.pages.findIndex((x) => x.id === s.pageId);
    d.pages.splice(i + 1, 0, p as any);
  });
  S().set({ pageId: p.id, selection: [] });
  setTimeout(fitCurrent);
}

export function duplicatePage(id: string) {
  const s = S();
  const src = findPage(s.doc, id);
  if (!src || src.kind === "MASTER") return;
  const idMap = new Map<string, string>();
  const nodes = src.nodes.map((n) => {
    const nid = uid();
    idMap.set(n.id, nid);
    return copyNode(n, nid);
  });
  const copy = { ...src, id: uid("pg"), name: t("doc.copyName", { name: src.name }), nodes, animations: src.animations.map((a) => ({ ...a, id: uid("an"), targetNodeId: idMap.get(a.targetNodeId) ?? a.targetNodeId })) };
  s.commit(t("doc.history.duplicatePage"), (d) => {
    const i = d.pages.findIndex((x) => x.id === id);
    d.pages.splice(i + 1, 0, copy as any);
  });
  S().set({ pageId: copy.id, selection: [] });
}

export function deletePage(id: string) {
  const s = S();
  const isMaster = s.doc.masters.some((m) => m.id === id);
  if (!isMaster && s.doc.pages.length <= 1) return S().notify(t("doc.toast.lastPage"));
  s.commit(t("doc.history.deletePage"), (d) => {
    if (isMaster) {
      d.masters = d.masters.filter((m) => m.id !== id);
      d.pages.forEach((p) => p.masterId === id && (p.masterId = null));
    } else d.pages = d.pages.filter((p) => p.id !== id);
  });
  if (s.pageId === id) S().set({ pageId: S().doc.pages[0].id, selection: [] });
}

export function movePage(id: string, delta: number) {
  S().commit(t("doc.history.pageOrder"), (d) => {
    const i = d.pages.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= d.pages.length) return;
    const [p] = d.pages.splice(i, 1);
    d.pages.splice(j, 0, p);
  });
}

export function addMaster() {
  const s = S();
  const cur = currentPage();
  const m = newPage("MASTER", cur?.width ?? 1280, cur?.height ?? 720, t("doc.masterName", { n: s.doc.masters.length + 1 }));
  m.background = "#ffffff";
  s.commit(t("doc.history.addMaster"),(d) => void d.masters.push(m as any));
  S().set({ pageId: m.id, selection: [] });
}

export function setPageProps(p: Partial<import("../core/types").Page>) {
  const s = S();
  s.commit(t("doc.history.pageProps"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (pg) Object.assign(pg, p);
  });
}

// ───────── nodes ─────────

export function addNode(node: SceneNode, assets: Record<string, import("../core/types").AssetRef> = {}) {
  const s = S();
  s.commit(t("doc.history.addNode", { name: node.name }), (d) => {
    Object.assign(d.assets, assets);
    draftPage(d, s.pageId)?.nodes.push(node as any);
  });
  S().set({ selection: [node.id] });
}

export function updateNodes(ids: string[], label: string, fn: (n: any) => void) {
  const s = S();
  s.commit(label, (d) => {
    const pg = draftPage(d, s.pageId);
    pg?.nodes.forEach((n) => ids.includes(n.id) && fn(n));
  });
}

export function updateSelected(label: string, fn: (n: any) => void) {
  updateNodes(S().selection, label, fn);
}

export function deleteSelected() {
  const s = S();
  if (!s.selection.length) return;
  const ids = new Set(s.selection);
  s.commit(t("doc.history.delete"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    pg.nodes = pg.nodes.filter((n) => !ids.has(n.id) || n.locked);
    pg.animations = pg.animations.filter((a) => !ids.has(a.targetNodeId));
  });
  S().set({ selection: [] });
}

export function duplicateSelected() {
  const s = S();
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const copies = detachCopies(nodes.map((n) => ({ ...copyNode(n, uid()), name: t("doc.copyName", { name: n.name }), transform: { ...n.transform, x: n.transform.x + 20, y: n.transform.y + 20 } })));
  s.commit(t("doc.history.duplicate"),(d) => void draftPage(d, s.pageId)?.nodes.push(...(copies as any)));
  S().set({ selection: copies.map((c) => c.id) });
}

export function reorderSelected(where: "up" | "down" | "top" | "bottom") {
  const s = S();
  const ids = new Set(s.selection);
  s.commit(t("doc.history.reorder"), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const arr = pg.nodes;
    // groups: arrange among the layer's siblings (a group moves as one), as Photoshop does
    if (pg.groups?.length) return void (pg.nodes = reorderInGroups(arr as SceneNode[], pg.groups, ids, where) as any);
    if (where === "top") pg.nodes = [...arr.filter((n) => !ids.has(n.id)), ...arr.filter((n) => ids.has(n.id))];
    else if (where === "bottom") pg.nodes = [...arr.filter((n) => ids.has(n.id)), ...arr.filter((n) => !ids.has(n.id))];
    else if (where === "up") {
      for (let i = arr.length - 2; i >= 0; i--) if (ids.has(arr[i].id) && !ids.has(arr[i + 1].id)) [arr[i], arr[i + 1]] = [arr[i + 1], arr[i]];
    } else for (let i = 1; i < arr.length; i++) if (ids.has(arr[i].id) && !ids.has(arr[i - 1].id)) [arr[i], arr[i - 1]] = [arr[i - 1], arr[i]];
  });
}

export function runPathfinder(op: BoolOp) {
  const s = S();
  const vecs = selectedNodes().filter((n): n is VectorNode => n.type === "VECTOR");
  if (vecs.length < 2) return S().notify(t("doc.toast.pathfinderNeed2"));
  const ordered = currentPage()!.nodes.filter((n): n is VectorNode => vecs.includes(n as VectorNode));
  // subtract uses the bottom-most as the base
  const result = pathfinder(op, op === "subtract" ? ordered : ordered.reverse());
  const ids = new Set(vecs.map((v) => v.id));
  s.commit(t("doc.history.pathfinder", { op }), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    const at = pg.nodes.findIndex((n) => ids.has(n.id));
    pg.nodes = pg.nodes.filter((n) => !ids.has(n.id));
    if (result) pg.nodes.splice(at, 0, result as any);
  });
  S().set({ selection: result ? [result.id] : [] });
}

export async function elevatePdf() {
  const s = S();
  const page = currentPage();
  const pdfNode = page?.nodes.find((n) => n.type === "PDF");
  if (!page || !pdfNode || pdfNode.type !== "PDF") return S().notify(t("doc.toast.notPdfPage"));
  if (pdfNode.covers.length) return S().notify(t("doc.toast.alreadyElevated"));
  const asset = s.doc.assets[pdfNode.assetId];
  S().notify(t("doc.toast.analyzingPdf"));
  const { nodes, covers, keptShapes } = await elevatePdfText(asset.hash, pdfNode.pageIndex, page.width);
  if (!nodes.length) return S().notify(t("doc.toast.nothingToEdit"));
  // shapes that could not become objects (gradient fills, paths under them) are said, not left to be discovered
  const kept = keptShapes ? " " + t("doc.toast.elevatedKept", { n: keptShapes }) : "";
  s.commit(t("doc.history.elevatePdf"), (d) => {
    const pg = draftPage(d, page.id)!;
    const n = pg.nodes.find((x) => x.id === pdfNode.id) as any;
    n.covers = covers;
    pg.nodes.push(...(nodes as any));
  });
  const nText = nodes.filter((n) => n.type === "TEXT").length, nVec = nodes.filter((n) => n.type === "VECTOR").length;
  S().notify(t(nVec ? "doc.toast.elevatedVec" : "doc.toast.elevated", { lines: nText, vectors: nVec }) + kept);
}

export function addAnimation(preset: AnimPreset, trigger: "ON_CLICK" | "WITH_PREVIOUS" | "AFTER_PREVIOUS" = "ON_CLICK") {
  const s = S();
  if (!s.selection.length) return S().notify(t("doc.toast.selectForAnim"));
  s.commit(t("doc.history.animation", { name: t(`doc.anim.${preset}`, undefined, ANIM_PRESETS[preset].label) }), (d) => {
    const pg = draftPage(d, s.pageId);
    if (!pg) return;
    s.selection.forEach((id, si) => {
      ANIM_PRESETS[preset].make().forEach((m, i) => {
        pg.animations.push({ id: uid("an"), targetNodeId: id, trigger: i === 0 ? (si === 0 ? trigger : "WITH_PREVIOUS") : "WITH_PREVIOUS", ...m } as any);
      });
    });
  });
}

export function selectAll() {
  const page = currentPage();
  if (page) S().set({ selection: page.nodes.filter(pickableOn(page)).map((n) => n.id) });
}

export function nodesAt(x: number, y: number): SceneNode[] {
  const page = currentPage();
  if (!page) return [];
  // a layer in a hidden or locked group cannot be picked either
  const pick = page.groups?.length ? pickableOn(page) : null;
  return [...page.nodes].reverse().filter((n) => {
    if (pick && !pick(n)) return false;
    const b = nodeBounds(n);
    return n.visible && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
  });
}
