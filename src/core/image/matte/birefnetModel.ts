// The "고품질(사람·동물)" background removal model (BiRefNet-lite, birefnet.ts): NOT shipped with the app or the web
// build. It is downloaded on first use from the public site, checked (size + SHA-256) and kept in the browser's Cache
// Storage (IndexedDB where there is none) — the same in the Tauri webview. The image worker reads it from there.
//
// One place for where the file is and what it must be: BIREFNET_MODEL. The file and its LICENSE are published by the
// coordinator under website/models/birefnet/ (the .lwt, its LICENSE and a README line).

export const BIREFNET_MODEL = {
  /** BiRefNet-general swin_v1_tiny (ZhengPeng7/BiRefNet release v1, MIT), int8 per output channel, LWT1 graph */
  url: "https://wind2sp.github.io/omniweave/models/birefnet/birefnet-int8.lwt",
  size: 46_082_436,
  sha256: "98af9209821c8d98a328f466d88455be69f211360ff91f90dce4724797f623d4",
  license: "https://wind2sp.github.io/omniweave/models/birefnet/LICENSE",
} as const;

/** the Cache Storage cache of the downloaded model */
export const HQ_CACHE = "hq-models";

/** a downloaded model's place in the store (by its hash: a new model file is a new entry) */
const KEY = `https://omniweave.invalid/models/birefnet-${BIREFNET_MODEL.sha256.slice(0, 16)}.lwt`;

export type BirefnetErrorCode = "network" | "http" | "size" | "hash" | "storage" | "aborted";

/** a failed download / check; `code` → the message key `image.matte.hq.err.<code>` (shown in Korean) */
export class BirefnetModelError extends Error {
  readonly code: BirefnetErrorCode;
  readonly detail: string;
  constructor(code: BirefnetErrorCode, detail = "") {
    super(`birefnet model: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "BirefnetModelError";
    this.code = code;
    this.detail = detail;
  }
}

/** where the checked model bytes are kept */
export interface ModelStore {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, bytes: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Cache Storage (browsers, the Tauri webview, workers) */
function cacheStore(): ModelStore {
  // (not "omw-…": the web app's service worker deletes every "omw-" cache that is not its own when it updates, sw.js)
  const open = () => caches.open(HQ_CACHE);
  return {
    async get(key) {
      const r = await (await open()).match(key);
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async put(key, bytes) {
      await (await open()).put(key, new Response(bytes as BlobPart, { headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) } }));
    },
    async delete(key) {
      await (await open()).delete(key);
    },
  };
}

/** IndexedDB where there is no Cache Storage (an insecure context) */
function idbStore(): ModelStore {
  const db = () =>
    new Promise<IDBDatabase>((res, rej) => {
      const q = indexedDB.open("omw-models", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("files");
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  const run = async <T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>) => {
    const d = await db();
    try {
      return await new Promise<T>((res, rej) => {
        const r = f(d.transaction("files", mode).objectStore("files"));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    } finally {
      d.close();
    }
  };
  return {
    async get(key) {
      const v = await run<unknown>("readonly", (s) => s.get(key));
      return v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
    },
    async put(key, bytes) {
      await run("readwrite", (s) => s.put(bytes, key));
    },
    async delete(key) {
      await run("readwrite", (s) => s.delete(key));
    },
  };
}

let store: ModelStore | null | undefined;
let urlOverride: string | null = null;
let expect: { size: number; sha256: string } = { size: BIREFNET_MODEL.size, sha256: BIREFNET_MODEL.sha256 };

function defaultStore(): ModelStore | null {
  if (typeof caches !== "undefined") return cacheStore();
  if (typeof indexedDB !== "undefined") return idbStore();
  return null;
}
const getStore = () => (store === undefined ? (store = defaultStore()) : store);

/** tests / the real-use scenario: another store (null = none), another download URL, another expected file */
export function setBirefnetModelEnv(o: { store?: ModelStore | null; url?: string | null; size?: number; sha256?: string }) {
  if ("store" in o) store = o.store;
  if ("url" in o) urlOverride = o.url ?? null;
  if (o.size !== undefined || o.sha256 !== undefined) expect = { size: o.size ?? expect.size, sha256: o.sha256 ?? expect.sha256 };
}

/** The download URL: the constant, or `?birefnetUrl=` / localStorage `omw.birefnetUrl` (development, the real-use
 *  scenario's local copy), or setBirefnetModelEnv's. */
export function birefnetUrl(): string {
  if (urlOverride) return urlOverride;
  try {
    const q = typeof location !== "undefined" ? new URLSearchParams(location.search).get("birefnetUrl") : null;
    if (q) return new URL(q, location.href).href;
    const l = typeof localStorage !== "undefined" ? localStorage.getItem("omw.birefnetUrl") : null;
    if (l) return l;
  } catch {
    /* no location / storage */
  }
  return BIREFNET_MODEL.url;
}

const hex = (b: ArrayBuffer) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** the bytes are the expected model file (size first: cheap) */
export async function checkBirefnetBytes(bytes: Uint8Array): Promise<void> {
  if (bytes.length !== expect.size) throw new BirefnetModelError("size", `${bytes.length} ≠ ${expect.size}`);
  const h = await sha256Hex(bytes);
  if (h !== expect.sha256) throw new BirefnetModelError("hash", h.slice(0, 12));
}

/** The kept model, checked; null when it is not there (or the kept copy is broken — it is then dropped). */
export async function readBirefnetModel(): Promise<Uint8Array | null> {
  const s = getStore();
  if (!s) return null;
  let b: Uint8Array | null;
  try {
    b = await s.get(KEY);
  } catch {
    return null;
  }
  if (!b) return null;
  try {
    await checkBirefnetBytes(b);
    return b;
  } catch {
    await s.delete(KEY).catch(() => undefined);
    return null;
  }
}

/** the model is already downloaded (size only — the full check runs when it is read) */
export async function birefnetModelReady(): Promise<boolean> {
  const s = getStore();
  if (!s) return false;
  try {
    const b = await s.get(KEY);
    return !!b && b.length === expect.size;
  } catch {
    return false;
  }
}

/**
 * The model, downloading it first when it is not kept yet: progress as bytes received / expected, `signal` stops the
 * download. Throws BirefnetModelError (network, http, size, hash, storage, aborted); nothing is kept unless it passed
 * the check.
 */
export async function ensureBirefnetModel(o: { onProgress?: (got: number, total: number) => void; signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<Uint8Array> {
  const kept = await readBirefnetModel();
  if (kept) return kept;
  const s = getStore();
  if (!s) throw new BirefnetModelError("storage", "no Cache Storage / IndexedDB");
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(birefnetUrl(), { signal: o.signal, cache: "no-store" });
  } catch (e) {
    if (o.signal?.aborted) throw new BirefnetModelError("aborted");
    throw new BirefnetModelError("network", e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) throw new BirefnetModelError("http", String(res.status));
  const total = expect.size;
  const buf = new Uint8Array(total);
  let got = 0;
  try {
    if (res.body) {
      const rd = res.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        if (got + value.length > total) {
          await rd.cancel().catch(() => undefined);
          throw new BirefnetModelError("size", `> ${total}`);
        }
        buf.set(value, got);
        got += value.length;
        o.onProgress?.(got, total);
      }
    } else {
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.length > total) throw new BirefnetModelError("size", `${b.length} ≠ ${total}`);
      buf.set(b);
      got = b.length;
      o.onProgress?.(got, total);
    }
  } catch (e) {
    if (e instanceof BirefnetModelError) throw e;
    if (o.signal?.aborted) throw new BirefnetModelError("aborted");
    throw new BirefnetModelError("network", e instanceof Error ? e.message : String(e));
  }
  const bytes = got === total ? buf : buf.subarray(0, got);
  await checkBirefnetBytes(bytes);
  try {
    await s.put(KEY, bytes);
  } catch (e) {
    throw new BirefnetModelError("storage", e instanceof Error ? e.message : String(e));
  }
  return bytes;
}

/** drop the kept model (settings / tests) */
export async function clearBirefnetModel(): Promise<void> {
  await getStore()?.delete(KEY).catch(() => undefined);
}
