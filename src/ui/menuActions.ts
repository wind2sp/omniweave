// Menu commands built on actions.ts: the canvas clipboard (cut / copy / paste / paste in place), select inverse,
// 90° rotation, lock / hide, insert image / table / media / symbol, merge down and rasterize, find & replace,
// and page extract / split. Every document change is one store.commit (one undo step).

import { docHooks } from "./editModes";
import { mergeRasterTiles, simpleRaster } from "../core/image/merge";
import { dissolveReady, loadDissolveField } from "../core/style/blend";
import { currentPage, draftPage, findPage, selectedNodes, useStore } from "../core/store";
import { nodeBounds } from "../core/loom";
import { findMatches, replaceAllInDoc } from "../core/textSearch";
import { reflowPages } from "../core/flow";
import { current } from "immer";
import { boxCenter } from "../core/transform";
import { detachCopies } from "../core/layerTree";
import { newTable, newText, uid, type AssetRef, type OmwDocument, type Page, type RasterNode, type SceneNode, type Transform, type Vec2 } from "../core/types";
import { rasterizeNode } from "../io/export";
import { formatForExt } from "../io/formats";
import { decodePngRgba, downsample } from "../io/formats/psdWrite";
import { rasterFromRgba } from "../io/formats/raster";
import { openFiles } from "../io/platform";
import { t } from "../i18n";
import { addNode, deleteSelected, importFile, updateNodes } from "./actions";
import { openOrganizer } from "./pageActions";
import { richApi } from "./RichTextEditor";
import { useUI } from "./shell/uiStore";
import { selectionBox } from "./xform";

const S = () => useStore.getState();

// ───────── clipboard (objects on the canvas) ─────────

interface Clip {
  /** the copied objects as they were (immutable snapshots, bottom to top) */
  nodes: SceneNode[];
  /** assets they refer to (images, PDFs, media, posters) */
  assets: Record<string, AssetRef>;
  /** pastes since the copy — each offset paste moves a step further */
  pastes: number;
  /** marks the system clipboard so a later Ctrl+V knows it still holds these objects */
  token: string;
}

let clip: Clip | null = null;
/** set while our own copy / cut is on its way to the system clipboard */
let armed = false;

/** MIME type of the marker written to the system clipboard with a copy of objects. */
export const CLIP_MIME = "application/x-omniweave-objects";
export const PASTE_STEP = 20;

export const hasClipboard = () => !!clip?.nodes.length;
export function clearClipboard() {
  clip = null;
}

function assetIdsOf(n: SceneNode): string[] {
  const ids: string[] = [];
  if ("assetId" in n && n.assetId) ids.push(n.assetId);
  if (n.type === "MEDIA" && n.posterAssetId) ids.push(n.posterAssetId);
  if ((n.type === "RASTER" || n.type === "IMAGE") && n.matte) ids.push(n.matte.assetId);
  return ids;
}

/** Copy the selected objects (in stacking order) to the internal clipboard. Returns how many. */
export function copySelection(): number {
  const s = S();
  const page = currentPage();
  if (!page || !s.selection.length) return 0;
  const sel = new Set(s.selection);
  const nodes = page.nodes.filter((n) => sel.has(n.id));
  if (!nodes.length) return 0;
  const assets: Record<string, AssetRef> = {};
  for (const n of nodes) for (const id of assetIdsOf(n)) if (s.doc.assets[id]) assets[id] = s.doc.assets[id];
  clip = { nodes, assets, pastes: 0, token: uid("clip") };
  return nodes.length;
}

/** Copy, then delete the originals (locked objects are copied but stay, like Delete). */
export function cutSelection(): number {
  const n = copySelection();
  if (n) deleteSelected();
  return n;
}

/** Deep copy of plain data; typed arrays (tile pixels) are shared — they are never changed in place. */
function deepClone<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepClone) as T;
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepClone(x);
    return out as T;
  }
  return v;
}

/** Fresh copies of `nodes` with new object (and paragraph) ids, moved by (dx, dy). */
export function cloneNodes(nodes: SceneNode[], dx: number, dy: number): SceneNode[] {
  return nodes.map((n) => {
    const c = deepClone(n);
    c.id = uid();
    c.transform = { ...c.transform, x: c.transform.x + dx, y: c.transform.y + dy };
    if (c.type === "TEXT") for (const p of c.paragraphs) p.id = uid("p");
    return c;
  });
}

/** Paste the clipboard onto the current page (offset a step, or in place) as one undo step; the copies are selected. */
export function pasteClipboard(inPlace = false): number {
  const s = S();
  const page = currentPage();
  if (!page || !clip?.nodes.length) {
    s.notify(t("menu.toast.nothingToPaste"));
    return 0;
  }
  if (!inPlace) clip.pastes++;
  const d = inPlace ? 0 : PASTE_STEP * clip.pastes;
  // placed on top of the stack: out of groups, clipped only onto a pasted layer
  const copies = detachCopies(cloneNodes(clip.nodes, d, d));
  // the clipboard outlives the document: an asset id this document already uses for other bytes gets a new id
  const assets: Record<string, AssetRef> = {};
  const renamed = new Map<string, string>();
  for (const [id, a] of Object.entries(clip.assets)) {
    const have = s.doc.assets[id];
    if (have && have.hash !== a.hash) {
      const nid = uid("as");
      renamed.set(id, nid);
      assets[nid] = { ...a, id: nid };
    } else if (!have) assets[id] = a;
  }
  if (renamed.size)
    for (const c of copies) {
      if ("assetId" in c && renamed.has(c.assetId)) c.assetId = renamed.get(c.assetId)!;
      if (c.type === "MEDIA" && c.posterAssetId && renamed.has(c.posterAssetId)) c.posterAssetId = renamed.get(c.posterAssetId)!;
      if ((c.type === "RASTER" || c.type === "IMAGE") && c.matte && renamed.has(c.matte.assetId)) c.matte.assetId = renamed.get(c.matte.assetId)!;
    }
  s.commit(t("menu.hist.paste"), (doc) => {
    for (const [id, a] of Object.entries(assets)) if (!doc.assets[id]) doc.assets[id] = a;
    draftPage(doc, page.id)?.nodes.push(...(copies as any));
  });
  S().set({ selection: copies.map((c) => c.id), editingTextId: null });
  return copies.length;
}

/**
 * While a text box is being edited (the menu bar leaves the editor open), Edit → Cut / Copy / Paste act on its
 * text through the editor's own clipboard handlers — never on the object, which would cut the whole box or drop
 * copied objects onto the page. Returns false when no text is being edited.
 */
function editorClipboard(kind: "cut" | "copy" | "paste"): boolean {
  const api = richApi();
  if (!api) return false;
  api.focus();
  let done = false;
  try {
    done = !!document.execCommand?.(kind);
  } catch {
    /* no document / command refused */
  }
  // browsers refuse a scripted paste: read the clipboard's text instead (asks for permission where needed)
  if (kind === "paste" && !done && typeof navigator !== "undefined")
    void navigator.clipboard
      ?.readText?.()
      .then((text) => text && richApi() === api && api.insertText(text))
      .catch(() => {});
  return true;
}

/** Edit → Paste / Paste in place: into the text being edited, else the copied objects. */
export function pasteFromMenu(inPlace = false) {
  if (!editorClipboard("paste")) pasteClipboard(inPlace);
}

/** Copy / cut from a menu: also put the marker on the system clipboard (through the browser's copy event). */
export function copyToSystem(cut: boolean) {
  if (editorClipboard(cut ? "cut" : "copy")) return;
  if (!(cut ? cutSelection() : copySelection())) return;
  armClipboardMarker();
  try {
    document.execCommand?.("copy");
  } catch {
    /* no system clipboard: the internal one still works */
  }
  armed = false;
}

/** The next copy / cut event writes the marker (keyboard copy: the browser fires it right after the keydown). */
export function armClipboardMarker() {
  armed = true;
  setTimeout(() => (armed = false), 0);
}

/** Window copy / cut listener: write the marker for objects just copied. */
export function writeClipboardMarker(e: ClipboardEvent): boolean {
  if (!armed || !clip || !e.clipboardData) return false;
  armed = false;
  e.clipboardData.setData(CLIP_MIME, clip.token);
  e.preventDefault();
  return true;
}

let pasteEventSeen = false;

/**
 * Keyboard Ctrl+V: the browser's paste event normally follows and decides (pasteIsOurs). Where none comes (a
 * webview or page state that fires no paste event without an editable target), paste the copied objects anyway.
 */
export function pasteSoon() {
  if (!clip?.nodes.length) return;
  pasteEventSeen = false;
  setTimeout(() => {
    if (!pasteEventSeen) pasteClipboard();
  }, 120);
}

/**
 * Window paste listener: should this paste insert the copied objects? Yes when the system clipboard carries
 * our marker, or when it holds no image (an image copied elsewhere after our copy is pasted as an image).
 */
export function pasteIsOurs(e: ClipboardEvent): boolean {
  pasteEventSeen = true;
  if (!clip?.nodes.length) return false;
  const data = e.clipboardData;
  if (!data) return true;
  if (data.getData(CLIP_MIME) === clip.token) return true;
  return !Array.from(data.items ?? []).some((i) => i.type.startsWith("image/"));
}

// ───────── selection, rotation, lock / hide ─────────

/** Objects of `page` that are not selected (locked and hidden ones are skipped, like Select all). */
export function inverseSelection(page: Page, selection: string[]): string[] {
  const sel = new Set(selection);
  return page.nodes.filter((n) => !sel.has(n.id) && !n.locked && n.visible).map((n) => n.id);
}

export function selectInverse() {
  const page = currentPage();
  if (page) S().set({ selection: inverseSelection(page, S().selection) });
}

/** A transform turned a quarter turn about `c` (dir 1 = clockwise on screen), exactly (no cos/sin rounding). */
export function rotated90About(tf: Transform, c: Vec2, dir: 1 | -1): Transform {
  const dx = tf.x - c[0], dy = tf.y - c[1];
  let r = (((tf.rotation + 90 * dir) % 360) + 360) % 360;
  if (r > 180) r -= 360;
  return { ...tf, x: c[0] - dir * dy, y: c[1] + dir * dx, rotation: r };
}

/** Rotate the selection 90° about its centre — one undo step. */
export function rotateSelected90(dir: 1 | -1) {
  const s = S();
  const sb = selectionBox(currentPage(), s.selection);
  if (!sb) return s.notify(t("menu.toast.selectToRotate"));
  const c = boxCenter(sb.box);
  const ids = new Set(sb.nodes.map((n) => n.id));
  s.commit(t(dir > 0 ? "cmd.object.rotateCW" : "cmd.object.rotateCCW"), (d) => {
    draftPage(d, s.pageId)?.nodes.forEach((n) => {
      if (ids.has(n.id)) n.transform = rotated90About(n.transform, c, dir);
    });
  });
}

export const allLocked = () => selectedNodes().length > 0 && selectedNodes().every((n) => n.locked);
export const allHidden = () => selectedNodes().length > 0 && selectedNodes().every((n) => !n.visible);

/** Lock the selection, or unlock it when every selected object is locked already. */
export function toggleLock() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const lock = !nodes.every((n) => n.locked);
  updateNodes(nodes.map((n) => n.id), t(lock ? "menu.hist.lock" : "menu.hist.unlock"), (n) => (n.locked = lock));
}

/** Hide the selection, or show it when every selected object is hidden already. */
export function toggleHide() {
  const nodes = selectedNodes();
  if (!nodes.length) return;
  const hide = nodes.some((n) => n.visible);
  updateNodes(nodes.map((n) => n.id), t(hide ? "menu.hist.hide" : "menu.hist.show"), (n) => (n.visible = !hide));
}

// ───────── insert ─────────

const extsOf = (...samples: string[]) => samples.flatMap((x) => formatForExt(x)?.exts ?? []);

/** File dialog → images placed on the current page (TIFF is converted, like Open). */
export async function insertImageFile() {
  const files = await openFiles([{ name: t("menu.filter.images"), extensions: extsOf("png", "tif") }], true);
  for (const f of files) await importFile(f, { place: true });
}

/** File dialog → video / audio clips placed on the current page. */
export async function insertMediaFile() {
  const files = await openFiles([{ name: t("menu.filter.media"), extensions: extsOf("mp4", "mp3") }], true);
  for (const f of files) await importFile(f);
}

function centerOn(page: Page, n: SceneNode, w: number, h: number) {
  n.transform = { x: Math.round((page.width - w) / 2), y: Math.round((page.height - h) / 2), rotation: 0, scale: 1 };
}

/** An empty 3 × 3 table in the middle of the current page. */
export function insertTable(rows = 3, cols = 3) {
  const page = currentPage();
  if (!page) return;
  const n = newTable(Array.from({ length: rows }, () => Array.from({ length: cols }, () => "")), undefined, t("cmd.insert.table"));
  // typing in a document body: the table goes into the text at the caret (ui/docFlow.ts)
  if (docHooks.insertInline?.(n)) return;
  centerOn(page, n, n.colWidths.reduce((a, b) => a + b, 0), n.rowHeight * rows);
  addNode(n);
}

/** Insert `ch` at the caret of the text being edited; otherwise place it as a new text box. Returns where it went. */
export function insertSymbol(ch: string): "caret" | "node" | null {
  const api = richApi();
  if (api) {
    api.insertText(ch);
    setTimeout(() => api.focus());
    return "caret";
  }
  const page = currentPage();
  if (!page) return null;
  const n = newText(ch, 80, { fontSize: 36 });
  n.name = ch;
  centerOn(page, n, 80, 60);
  addNode(n);
  return "node";
}

// ───────── image: merge down, rasterize ─────────

/** The selected raster and the raster right below it, when Merge down can combine them exactly. */
export function mergeDownPair(page: Page | undefined, selection: string[]): { upper: RasterNode; lower: RasterNode } | null {
  if (!page || selection.length !== 1) return null;
  const i = page.nodes.findIndex((n) => n.id === selection[0]);
  if (i < 1) return null;
  const upper = page.nodes[i], lower = page.nodes[i - 1];
  if (upper.type !== "RASTER" || lower.type !== "RASTER") return null;
  if (upper.locked || lower.locked || !upper.visible || !lower.visible) return null;
  // groups / clipping: only within one group; a clipped layer merges into its base (or into a clipped layer
  // below on the same base); an unclipped layer cannot merge into a clipped one (that would clip it)
  if ((upper.groupId ?? "") !== (lower.groupId ?? "")) return null;
  if (lower.clip && !upper.clip) return null;
  return simpleRaster(upper) && simpleRaster(lower) ? { upper, lower } : null;
}

export function mergeDown() {
  const s = S();
  const page = currentPage();
  const pair = mergeDownPair(page, s.selection);
  if (!page || !pair) return s.notify(t("menu.toast.cannotMerge"));
  const { upper, lower } = pair;
  // dissolve dots are baked for good: wait for Photoshop's thresholds (loaded on demand, core/style/blend.ts)
  if (upper.blendMode === "DISSOLVE" && !dissolveReady()) {
    loadDissolveField().then(mergeDown, () => s.notify(t("menu.toast.cannotMerge")));
    return;
  }
  // a clipped layer onto its base: clipped (source-atop), the base keeps its opacity for the stack above it
  const ontoBase = !!upper.clip && !lower.clip;
  const tiles = mergeRasterTiles(lower, upper, ontoBase);
  s.commit(t("menu.hist.mergeDown"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const lo = pg.nodes.find((n) => n.id === lower.id) as RasterNode | undefined;
    if (!lo) return;
    lo.tiles = tiles as any;
    if (!ontoBase) lo.opacity = 1;
    pg.nodes = pg.nodes.filter((n) => n.id !== upper.id);
    pg.animations = pg.animations.filter((a) => a.targetNodeId !== upper.id);
  });
  S().set({ selection: [lower.id] });
}

const RASTERIZABLE = new Set(["VECTOR", "TEXT", "IMAGE"]);

/** The one selected vector, text or image object (unlocked), which Rasterize turns into pixels. */
export function rasterizeTarget(page: Page | undefined, selection: string[]): SceneNode | null {
  if (!page || selection.length !== 1) return null;
  const n = page.nodes.find((x) => x.id === selection[0]);
  return n && !n.locked && RASTERIZABLE.has(n.type) ? n : null;
}

/**
 * A page just big enough for `n`, with `n` moved there by whole pixels (dx, dy): Rasterize draws on it so the
 * parts of the object outside the page are kept, like the pixels of any other layer, instead of being cut off.
 */
export function rasterFrame(page: Page, n: SceneNode): { page: Page; node: SceneNode; dx: number; dy: number } {
  const b = nodeBounds(n);
  const dx = Math.floor(b.x), dy = Math.floor(b.y);
  const node = { ...n, transform: { ...n.transform, x: n.transform.x - dx, y: n.transform.y - dy } } as SceneNode;
  return { page: { ...page, width: Math.max(1, Math.ceil(b.x + b.w) - dx), height: Math.max(1, Math.ceil(b.y + b.h) - dy) }, node, dx, dy };
}

/** Replace the selected object by a raster layer of how it looks (same place, opacity and blend; all of it, on the page or not). */
export async function rasterizeSelected() {
  const s = S();
  const page = currentPage();
  const n = rasterizeTarget(page, s.selection);
  if (!page || !n) return s.notify(t("menu.toast.cannotRasterize"));
  if (s.editingTextId) {
    // close the text editor first and let it save what was typed, so that text is what gets drawn
    s.set({ editingTextId: null });
    await new Promise((r) => setTimeout(r, 0));
  }
  let raster: RasterNode;
  const cur = findPage(S().doc, page.id) ?? page;
  const src = cur.nodes.find((x) => x.id === n.id) ?? n;
  try {
    const f = rasterFrame(cur, { ...src, visible: true, opacity: 1, blendMode: "NORMAL" } as SceneNode);
    const r = await rasterizeNode(S().doc, f.page, f.node);
    if (!r) return S().notify(t("menu.toast.rasterizeEmpty"));
    const rgba = downsample(decodePngRgba(r.png), r.w, r.h);
    const made = rasterFromRgba(rgba, r.w, r.h, src.name);
    raster = { ...made, id: src.id, visible: src.visible, locked: false, opacity: src.opacity, blendMode: src.blendMode, transform: { x: r.x + f.dx, y: r.y + f.dy, rotation: 0, scale: 1 } };
    // stays in its group and clip stack
    if (src.groupId) raster.groupId = src.groupId;
    if (src.clip) raster.clip = true;
  } catch (e: any) {
    return S().notify(t("menu.toast.rasterizeFailed", { error: String(e?.message ?? e) }));
  }
  // the object changed (or went away, or the document was replaced) while it was drawn: drop the result quietly
  if (findPage(S().doc, page.id)?.nodes.find((x) => x.id === src.id) !== src) return;
  S().commit(t("menu.hist.rasterize"), (d) => {
    const pg = draftPage(d, page.id);
    const i = pg ? pg.nodes.findIndex((x) => x.id === raster.id) : -1;
    if (pg && i >= 0) pg.nodes[i] = raster as any;
  });
  S().set({ selection: [raster.id] });
}

// ───────── find & replace ─────────

/** Replace every match in the document — one undo step; a toast tells how many. */
export function replaceAll(query: string, replacement: string, matchCase: boolean): number {
  const s = S();
  if (!query) return 0;
  if (s.editingTextId) s.set({ editingTextId: null });
  let n = 0;
  // find first, so a search with no match leaves no history entry
  if (findMatches(S().doc, query, matchCase).length)
    S().commit(t("menu.hist.replaceAll"), (d) => {
      n = replaceAllInDoc(d as OmwDocument, query, replacement, matchCase);
      // a flowing body takes its lines again within the margins (its frames kept the old lines and widths: the text
      // ran past the right margin, selected like a text box — QA ui-audit #11)
      if (n) d.pages = reflowPages(current(d).pages) as typeof d.pages;
    });
  if (n) S().set({ selection: [] });
  S().notify(n ? t("menu.toast.replaced", { n }) : t("menu.toast.noMatch"));
  return n;
}

// ───────── pages ─────────

/** Page → Split: the organiser with its split panel open. */
export function openSplit() {
  useUI.getState().set({ organizerPanel: "split" });
  openOrganizer();
}
