// Shuttle journal — crash-safe autosave in IndexedDB. Offered back only after a run that did not end normally (a
// crash, the task manager, a power cut): startRun / endRun below.
// Only threads (tiles/assets) never written before are stored, so an autosave after a
// brush stroke writes a few tiles plus a small scene-graph root, not the whole document.

import { getBlob, putBlob } from "../core/assets";
import { dehydrate, hydrate } from "../core/loom";
import type { OmwDocument } from "../core/types";

const DB = "omniweave-journal";
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;
const written = new Set<string>();

function db(): Promise<IDBDatabase> {
  if (!dbp)
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains("threads")) d.createObjectStore("threads");
        if (!d.objectStoreNames.contains("roots")) d.createObjectStore("roots");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  return dbp;
}

function done(tx: IDBTransaction) {
  return new Promise<void>((res, rej) => {
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

export interface JournalStats {
  newThreads: number;
  ms: number;
}

/**
 * Each open document (tab) has its own root, keyed by its session id; threads are shared by hash. "latest" is
 * the single root older versions wrote — still read on recovery.
 */
export async function journalSave(doc: OmwDocument, key = "latest"): Promise<JournalStats> {
  const t0 = performance.now();
  const d = await db();
  const { graph, tiles } = dehydrate(doc);
  const tx = d.transaction(["threads", "roots"], "readwrite");
  const threads = tx.objectStore("threads");
  let n = 0;
  for (const [h, data] of tiles)
    if (!written.has(h)) {
      threads.put(data.slice(), "t:" + h);
      written.add(h);
      n++;
    }
  for (const a of Object.values(doc.assets))
    if (!written.has(a.hash)) {
      const b = getBlob(a.hash);
      if (b) {
        // a view (a PPTX picture stored in its package) is copied out: IndexedDB clones the whole buffer behind it
        threads.put(b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b : b.slice(), "a:" + a.hash);
        written.add(a.hash);
        n++;
      }
    }
  tx.objectStore("roots").put({ graph, savedAt: Date.now(), title: doc.title }, key);
  await done(tx);
  return { newThreads: n, ms: performance.now() - t0 };
}

export interface JournalEntry {
  key: string;
  savedAt: number;
  title: string;
}

/** Every document the journal holds, newest first. */
export async function journalList(): Promise<JournalEntry[]> {
  try {
    const d = await db();
    const tx = d.transaction("roots", "readonly");
    const store = tx.objectStore("roots");
    const ask = <T,>(r: IDBRequest<T>) =>
      new Promise<T>((res, rej) => {
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    const [keys, vals] = await Promise.all([ask(store.getAllKeys()), ask(store.getAll())]);
    return keys.map((k, n) => ({ key: String(k), savedAt: vals[n]?.savedAt ?? 0, title: vals[n]?.title ?? "" })).sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** The newest journalled document, and how many there are in all (recovery dialog). */
export async function journalPeek(): Promise<{ savedAt: number; title: string; count: number } | null> {
  const list = await journalList();
  return list.length ? { savedAt: list[0].savedAt, title: list[0].title, count: list.length } : null;
}

export async function journalRestore(key = "latest"): Promise<OmwDocument | null> {
  const d = await db();
  const tx = d.transaction(["threads", "roots"], "readonly");
  const get = (store: string, k: string) =>
    new Promise<any>((res, rej) => {
      const r = tx.objectStore(store).get(k);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  const root = await get("roots", key);
  if (!root) return null;
  const tileHashes = new Set<string>();
  for (const p of [...root.graph.pages, ...root.graph.masters])
    for (const n of p.nodes) if (n.type === "RASTER") for (const h of Object.values(n.tiles as Record<string, string>)) tileHashes.add(h);
  const tiles = new Map<string, Uint8ClampedArray>();
  await Promise.all(
    [...tileHashes].map(async (h) => {
      const v = await get("threads", "t:" + h);
      if (v) tiles.set(h, v instanceof Uint8ClampedArray ? v : new Uint8ClampedArray(v));
    }),
  );
  await Promise.all(
    Object.values(root.graph.assets as Record<string, { hash: string }>).map(async (a) => {
      const v = await get("threads", "a:" + a.hash);
      if (v) putBlob(new Uint8Array(v));
    }),
  );
  const { doc } = hydrate(root.graph, (h) => tiles.get(h));
  tileHashes.forEach((h) => written.add(h));
  return doc;
}

/**
 * Forget one document's root (saved, closed or discarded); the shared threads go once no root is left.
 * Without a key every root and thread goes.
 */
export async function journalClear(key?: string): Promise<void> {
  const d = await db();
  if (key !== undefined) {
    const one = d.transaction("roots", "readwrite");
    one.objectStore("roots").delete(key);
    await done(one);
    if ((await journalList()).length) return;
  }
  const tx = d.transaction(["threads", "roots"], "readwrite");
  tx.objectStore("threads").clear();
  tx.objectStore("roots").clear();
  written.clear();
  await done(tx);
}

// ───────── did the last run end normally? ─────────

const RUNNING = "omniweave.running";

/**
 * At startup: true when the previous run never reached endRun (it crashed, was killed, the power went) — only then
 * is the journal offered back. Marks this run as running.
 */
export function startRun(): boolean {
  let crashed = false;
  try {
    crashed = localStorage.getItem(RUNNING) != null;
    localStorage.setItem(RUNNING, String(Date.now()));
  } catch {}
  return crashed;
}

let runStart: boolean | null = null;
/**
 * startRun once per page load: the startup effect may run twice (React StrictMode in development), and the second
 * call would find this run's own mark and take it for a crash.
 */
export function startRunOnce(): boolean {
  return (runStart ??= startRun());
}

/**
 * A normal end (quit, window closed or update installed — after the "save changes?" answer, 저장 안 함 included):
 * nothing is left to recover. The mark goes at once (synchronous), the journal right after.
 */
export function endRun(): Promise<void> {
  try {
    localStorage.removeItem(RUNNING);
  } catch {}
  return journalClear().catch(() => {});
}
