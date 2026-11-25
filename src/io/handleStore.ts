// Browser file handles kept for the web build's recent files (Chrome / Edge: a FileSystemFileHandle can be stored in
// IndexedDB and used again in a later visit, after the browser asks once more for permission). Browsers without
// handles keep no recent files, as before.

import type { FileHandle } from "./platform";

const DB = "omniweave-handles";
const STORE = "files";

function db(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    if (typeof indexedDB === "undefined") return fail(new Error("no IndexedDB"));
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const d = await db();
  try {
    return await new Promise<T>((ok, fail) => {
      const t = d.transaction(STORE, mode);
      const req = run(t.objectStore(STORE));
      t.oncomplete = () => ok(req.result);
      t.onerror = () => fail(t.error ?? req.error);
      t.onabort = () => fail(t.error ?? req.error);
    });
  } finally {
    d.close();
  }
}

/** Keep `h` under `id` (false when the browser cannot store it: not a real handle, private mode…). */
export async function putHandle(id: string, h: FileHandle): Promise<boolean> {
  try {
    await tx("readwrite", (s) => s.put(h, id));
    return true;
  } catch {
    return false;
  }
}

export async function getHandle(id: string): Promise<FileHandle | null> {
  try {
    return ((await tx("readonly", (s) => s.get(id))) as FileHandle | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function deleteHandle(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* gone already */
  }
}

/** Can this browser keep file handles for a later visit? */
export const handlesSupported = () => typeof indexedDB !== "undefined" && typeof (globalThis as { FileSystemFileHandle?: unknown }).FileSystemFileHandle === "function";
