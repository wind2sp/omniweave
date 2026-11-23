// Work history timeline — every command since the document was started, with one-step jump.
//
// Because documents are immutable and content-addressed (Loom), a history entry is just a
// root: the nodes and pixel tiles it shares with other entries are stored once. Recording
// costs only what actually changed. History lives in a separate `history/` section of the
// .omw package; the document content itself is never affected by it.

import { create } from "zustand";
import { t, useLang, type Lang } from "../i18n";
import { hashBytes, hashString } from "./hash";
import { docExtras, documentRoot, nodeHash } from "./loom";
import { storeHooks, useStore } from "./store";
import { registerSessionPart, sessionHooks } from "./sessions";
import { TILE, newDocument, uid, type OmwDocument, type Page, type PixelTile, type SceneNode } from "./types";

export interface HistoryEntry {
  id: string;
  time: number; // epoch ms
  label: string;
  root: string;
  doc: OmwDocument;
}

interface HistoryState {
  entries: HistoryEntry[];
  recording: boolean;
  includeInFile: boolean;
  /** entry being previewed on the canvas, and the document to return to */
  previewId: string | null;
  previewBase: OmwDocument | null;
  set: (p: Partial<HistoryState>) => void;
}

export const useHistory = create<HistoryState>((set) => ({
  entries: [],
  recording: true,
  includeInFile: true,
  previewId: null,
  previewBase: null,
  set: (p) => set(p),
}));

const MERGE_MS = 1500;
const H = () => useHistory.getState();

/** Append an entry. Repeats of the same command within 1.5 s are merged into one. */
export function recordHistory(doc: OmwDocument, label: string, time = Date.now()) {
  const h = H();
  if (!h.recording) return;
  const root = documentRoot(doc);
  const last = h.entries[h.entries.length - 1];
  if (last && last.root === root) return;
  if (last && last.label === label && time - last.time < MERGE_MS) {
    h.set({ entries: [...h.entries.slice(0, -1), { ...last, time, root, doc }] });
    return;
  }
  h.set({ entries: [...h.entries, { id: uid("h"), time, label, root, doc }] });
}

/** Start a fresh timeline (new/opened document, or "clear history"). */
export function resetHistory(doc: OmwDocument, label = t("engine.history.start"), entries?: HistoryEntry[]) {
  H().set({ previewId: null, previewBase: null });
  if (entries && entries.length) {
    H().set({ entries });
    recordHistory(doc, label);
  } else H().set({ entries: [{ id: uid("h"), time: Date.now(), label, root: documentRoot(doc), doc }] });
}

export function clearHistory() {
  cancelPreview();
  resetHistory(useStore.getState().doc, t("engine.history.restart"));
}

/** Locale for the clock time in a "restored" history label, per UI language. */
const TIME_LOCALE: Record<Lang, string> = { ko: "ko-KR", en: "en-US", zh: "zh-CN", ja: "ja-JP" };

// ───────── preview & restore ─────────

export function previewEntry(id: string) {
  const h = H();
  const e = h.entries.find((x) => x.id === id);
  if (!e) return;
  const s = useStore.getState();
  const base = h.previewBase ?? s.doc;
  h.set({ previewId: id, previewBase: base });
  useStore.setState({ doc: e.doc, selection: [], editingTextId: null });
  fixPage(e.doc);
}

export function cancelPreview() {
  const h = H();
  if (!h.previewBase) return;
  const base = h.previewBase;
  h.set({ previewId: null, previewBase: null });
  useStore.setState({ doc: base });
  fixPage(base);
}

export function restoreEntry(id: string) {
  const h = H();
  const e = h.entries.find((x) => x.id === id);
  if (!e) return;
  const base = h.previewBase;
  h.set({ previewId: null, previewBase: null });
  if (base) useStore.setState({ doc: base });
  const time = new Date(e.time).toLocaleTimeString(TIME_LOCALE[useLang.getState().lang], { hour12: false });
  useStore.getState().replaceDoc(t("engine.history.restored", { label: e.label, time }), e.doc);
  fixPage(e.doc);
}

function fixPage(doc: OmwDocument) {
  const s = useStore.getState();
  if (![...doc.pages, ...doc.masters].some((p) => p.id === s.pageId)) useStore.setState({ pageId: doc.pages[0]?.id ?? "" });
}

// Editing while a past state is previewed restores that state first, then applies the edit.
storeHooks.beforeCommit = () => {
  const h = H();
  if (h.previewId) restoreEntry(h.previewId);
};
storeHooks.committed = (doc, label) => recordHistory(doc, label);
storeHooks.loaded = (doc) => resetHistory(doc, t("doc.history.open"));
// each document tab keeps its own timeline (core/sessions.ts); a preview ends before the tab is parked
sessionHooks.quiesce.push(() => cancelPreview());
registerSessionPart<{ entries: HistoryEntry[]; recording: boolean; includeInFile: boolean }>({
  key: "history",
  capture: () => {
    const h = H();
    return { entries: h.entries, recording: h.recording, includeInFile: h.includeInFile };
  },
  restore: (v, doc) => {
    if (v) H().set({ entries: v.entries, recording: v.recording, includeInFile: v.includeInFile, previewId: null, previewBase: null });
    else {
      H().set({ recording: true, includeInFile: true });
      resetHistory(doc, t("engine.history.newDoc"));
    }
  },
});
// the first document and timeline are made at module load, before the language is settled (Korean then);
// relabelStartDocument() remakes them in the chosen language once it is known
resetHistory(useStore.getState().doc, t("engine.history.newDoc"));

/**
 * Remake the start-up document (default page / layer names, first history label) in the current UI language.
 * Only while it is untouched: nothing edited, opened or undone.
 */
export function relabelStartDocument() {
  const s = useStore.getState();
  if (s.dirty || s.filePath || s.past.length || s.future.length || H().entries.length > 1) return;
  const doc = newDocument();
  useStore.setState({ doc, pageId: doc.pages[0].id, selection: [] });
  resetHistory(doc, t("engine.history.newDoc"));
}

// ───────── size estimate ─────────

export function historyStats(entries: HistoryEntry[]) {
  const nodes = new Set<string>();
  const tiles = new Set<string>();
  let nodeBytes = 0;
  for (const e of entries)
    for (const p of [...e.doc.pages, ...e.doc.masters])
      for (const n of p.nodes) {
        const h = nodeHash(n);
        if (nodes.has(h)) continue;
        nodes.add(h);
        if (n.type === "RASTER") {
          nodeBytes += 200 + Object.keys(n.tiles).length * 30;
          for (const t of Object.values(n.tiles)) tiles.add(t.hash);
        } else nodeBytes += JSON.stringify(n).length;
      }
  return { entries: entries.length, nodes: nodes.size, tiles: tiles.size, approxBytes: nodeBytes + entries.length * 160 + tiles.size * TILE * TILE * 4 };
}

// ───────── serialization (.omw history/) ─────────

interface PageSnap extends Omit<Page, "nodes"> {
  nodes: string[];
}
interface EntrySnap {
  id: string;
  time: number;
  label: string;
  root: string;
  /** document fields; optional extension fields (style sheets, swatches…) ride along when present */
  meta: Pick<OmwDocument, "id" | "title" | "created" | "modified" | "assets"> & Record<string, unknown>;
  pages: PageSnap[];
  masters: PageSnap[];
}
/**
 * index v1: every node an entry uses is in `nodes`, every entry carries its full asset table.
 * index v2 (.omw container 2, docs/design/FILE_SIZE.md): nodes the saved document itself has are not repeated
 * (the reader takes them from the scene graph by node hash), and equal asset tables are stored once in
 * `assetTables` (entries name theirs with `meta.assetsRef`).
 */
export interface HistoryPack {
  index: { version: 1 | 2; entries: EntrySnap[]; assetTables?: Record<string, OmwDocument["assets"]> };
  nodes: Record<string, unknown>;
  tiles: Map<string, Uint8ClampedArray>;
}

export interface PackHistoryOptions {
  /** node hashes the scene graph already holds: written as references only (index v2) */
  shared?: Set<string>;
  /** filter applied to every entry's asset table (unreferenced assets dropped on save) */
  assets?: (table: OmwDocument["assets"]) => OmwDocument["assets"];
}

function dehydrateNode(n: SceneNode, tiles: Map<string, Uint8ClampedArray>): unknown {
  if (n.type !== "RASTER") return JSON.parse(JSON.stringify(n));
  const t: Record<string, string> = {};
  for (const [k, tile] of Object.entries(n.tiles)) {
    t[k] = tile.hash;
    tiles.set(tile.hash, tile.data);
  }
  return JSON.parse(JSON.stringify({ ...n, tiles: t }));
}

export function packHistory(entries: HistoryEntry[], opts?: PackHistoryOptions): HistoryPack {
  const nodes: Record<string, unknown> = {};
  const tiles = new Map<string, Uint8ClampedArray>();
  const v2 = !!opts;
  const snapPage = (p: Page): PageSnap => ({
    ...p,
    nodes: p.nodes.map((n) => {
      const h = nodeHash(n);
      if (!(h in nodes) && !opts?.shared?.has(h)) nodes[h] = dehydrateNode(n, tiles);
      return h;
    }),
  });
  const assetTables: Record<string, OmwDocument["assets"]> = {};
  const tableMemo = new Map<object, string>();
  const tableRef = (table: OmwDocument["assets"]): string => {
    let h = tableMemo.get(table);
    if (!h) {
      const t2 = opts?.assets ? opts.assets(table) : table;
      h = hashString(JSON.stringify(t2));
      assetTables[h] = t2;
      tableMemo.set(table, h);
    }
    return h;
  };
  const snaps: EntrySnap[] = entries.map((e) => {
    const base = { id: e.doc.id, title: e.doc.title, created: e.doc.created, modified: e.doc.modified };
    const meta = v2 ? { ...base, assetsRef: tableRef(e.doc.assets), ...docExtras(e.doc) } : { ...base, assets: e.doc.assets, ...docExtras(e.doc) };
    return { id: e.id, time: e.time, label: e.label, root: e.root, meta: meta as EntrySnap["meta"], pages: e.doc.pages.map(snapPage), masters: e.doc.masters.map(snapPage) };
  });
  const index: HistoryPack["index"] = v2 ? { version: 2, entries: JSON.parse(JSON.stringify(snaps)), assetTables: JSON.parse(JSON.stringify(assetTables)) } : { version: 1, entries: JSON.parse(JSON.stringify(snaps)) };
  return { index, nodes, tiles };
}

/**
 * Read history/ back. `shared` resolves node hashes the v2 index leaves out (nodes of the saved document itself).
 * Entries whose nodes cannot all be found are kept with what was found and counted in `skipped`.
 */
export function unpackHistory(
  index: { entries: EntrySnap[]; assetTables?: Record<string, OmwDocument["assets"]> },
  nodes: Record<string, any>,
  getTile: (h: string) => Uint8ClampedArray | undefined,
  shared?: Map<string, SceneNode>,
): { entries: HistoryEntry[]; skipped: number } {
  const tileCache = new Map<string, PixelTile | null>();
  const nodeCache = new Map<string, SceneNode | null>();
  const tile = (h: string) => {
    let t = tileCache.get(h);
    if (t === undefined) {
      const d = getTile(h);
      t = d && d.length === TILE * TILE * 4 && hashBytes(d) === h ? { hash: h, data: d } : null;
      tileCache.set(h, t);
    }
    return t;
  };
  const node = (h: string): SceneNode | null => {
    let n = nodeCache.get(h);
    if (n === undefined) {
      const raw = nodes[h];
      if (!raw) n = shared?.get(h) ?? null;
      else if (raw.type === "RASTER") {
        const tiles: Record<string, PixelTile> = {};
        for (const [k, th] of Object.entries(raw.tiles as Record<string, string>)) {
          const t = tile(th);
          if (t) tiles[k] = t;
        }
        n = { ...raw, tiles } as SceneNode;
      } else n = raw as SceneNode;
      nodeCache.set(h, n);
    }
    return n;
  };
  let skipped = 0;
  const entries: HistoryEntry[] = [];
  for (const e of index.entries ?? []) {
    let broken = false;
    const page = (p: PageSnap): Page => ({
      ...p,
      nodes: p.nodes.map((h) => node(h)).filter((n): n is SceneNode => (n ? true : ((broken = true), false))),
    });
    const { assetsRef, ...meta } = e.meta as EntrySnap["meta"] & { assetsRef?: string };
    if (assetsRef !== undefined) {
      const table = index.assetTables?.[assetsRef];
      if (!table) broken = true;
      meta.assets = table ?? {};
    }
    const doc: OmwDocument = { format: "omw", version: 1, ...meta, pages: e.pages.map(page), masters: e.masters.map(page) };
    if (broken) skipped++;
    entries.push({ id: e.id, time: e.time, label: e.label, root: e.root, doc });
  }
  return { entries, skipped };
}

/** Bytes a raster tile adds to a saved file, roughly (a 256 × 256 PNG of photo pixels). */
const TILE_BYTES = 64 * 1024;

/**
 * The newest history entries a saved file keeps: as many as fit a budget of what history adds beyond the document
 * itself (pictures and pixel tiles only earlier steps use) — max(4 MB, twice the document's own). The document is
 * saved whole either way; only the oldest steps drop out (2026-11-23: an 800 × 600 photo after 48 steps was 7.1 MB,
 * most of it full copies of the picture from early filter steps).
 */
export function historyForFile(entries: HistoryEntry[], doc: OmwDocument): HistoryEntry[] {
  const seenAssets = new Set<string>(), seenTiles = new Set<string>();
  let own = 0;
  // pictures the pages use (an edit makes a new picture; the old one stays in the asset table for undo)
  const assetsOf = (d: OmwDocument) => d.pages.flatMap((p) => p.nodes.flatMap((n) => { const id = (n as { assetId?: string }).assetId; const a = id ? d.assets[id] : undefined; return a ? [a] : []; }));
  for (const a of assetsOf(doc)) if (!seenAssets.has(a.hash)) (seenAssets.add(a.hash), (own += a.size || 0));
  const tilesOf = (d: OmwDocument, out: Set<string>) => {
    for (const p of d.pages) for (const n of p.nodes) if (n.type === "RASTER") for (const tile of Object.values(n.tiles)) out.add(tile.hash);
  };
  tilesOf(doc, seenTiles);
  own += seenTiles.size * TILE_BYTES;
  const budget = Math.max(4 * 1024 * 1024, 2 * own);
  let extra = 0;
  let from = entries.length;
  for (let i = entries.length - 1; i >= 0; i--) {
    const d = entries[i].doc;
    let add = 0;
    const newAssets: string[] = [];
    for (const a of assetsOf(d)) if (!seenAssets.has(a.hash)) (seenAssets.add(a.hash), newAssets.push(a.hash), (add += a.size || 0));
    const ts = new Set<string>();
    tilesOf(d, ts);
    const newTiles = [...ts].filter((h) => !seenTiles.has(h));
    add += newTiles.length * TILE_BYTES;
    // the newest steps are always kept (the last one is the document itself)
    if (extra + add > budget && entries.length - i > 2) break;
    extra += add;
    for (const h of newAssets) seenAssets.add(h);
    for (const h of newTiles) seenTiles.add(h);
    from = i;
  }
  return from === 0 ? entries : entries.slice(from);
}
