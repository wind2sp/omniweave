// Recent files of the phone app: names, sizes, times, the picked URI and a short fingerprint only — never file
// contents — on this device (docs/MOBILE_PLAN.md §2 "최근(앱 안 목록, 파일 내용은 저장 안 함)").
// One entry per file: the same URI, or the same contents reached through another URI (a file shared twice from
// KakaoTalk gets a new content:// each time), replace the older entry.

export interface RecentItem {
  name: string;
  size: number;
  /** content:// URI or path when there was one (reopening may need the picker again) */
  path: string | null;
  at: number;
  /** size + sampled-content fingerprint (fingerprint()), to find the same file under another URI */
  fp?: string;
  /** the URI could not be read any more (the grant ended): reopening goes through the picker */
  expired?: boolean;
}

const KEY = "omniweave.mobile.recent.v2";
const OLD_KEY = "omniweave.mobile.recent.v1";
const MAX = 30;
/** a URI grant that was not kept (persistable) rarely survives this long; the entry stays, its URI is dropped */
const GRANT_DAYS = 30;
const KNOWN = /\.(pdf|png|jpe?g|webp|gif|docx|pptx|ppsx|xlsx|xlsm|hwpx|omw|zip)$/i;

/** FNV-1a over the size and up to 3 × 16 KB (start, middle, end): cheap for a 100 MB file, distinct enough for a list. */
export function fingerprint(bytes: Uint8Array): string {
  let h = 0x811c9dc5 ^ bytes.length;
  const take = (from: number, n: number) => {
    const end = Math.min(bytes.length, from + n);
    for (let i = Math.max(0, from); i < end; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  };
  const S = 16384;
  take(0, S);
  if (bytes.length > 3 * S) take((bytes.length >> 1) - (S >> 1), S);
  if (bytes.length > S) take(Math.max(S, bytes.length - S), S);
  return bytes.length.toString(36) + "-" + (h >>> 0).toString(36);
}

function clean(list: unknown, now: number): RecentItem[] {
  if (!Array.isArray(list)) return [];
  const out: RecentItem[] = [];
  for (const x of list) {
    if (!x || typeof x.name !== "string" || typeof x.at !== "number") continue;
    // entries from the first test build whose name was only a media id ("18"): unusable, dropped
    if (!KNOWN.test(x.name)) continue;
    const item: RecentItem = { name: x.name, size: Number(x.size) || 0, path: typeof x.path === "string" ? x.path : null, at: x.at, ...(typeof x.fp === "string" ? { fp: x.fp } : {}), ...(x.expired ? { expired: true } : {}) };
    if (item.path && now - item.at > GRANT_DAYS * 864e5) item.expired = true;
    if (out.some((o) => same(o, item))) continue;
    out.push(item);
  }
  return out.slice(0, MAX);
}

/** The same file: same URI, or same fingerprint, or (entries without one) same name and URI. */
export function same(a: RecentItem, b: RecentItem): boolean {
  if (a.path && b.path && a.path === b.path) return true;
  if (a.fp && b.fp) return a.fp === b.fp;
  return a.name === b.name && a.path === b.path;
}

export function loadRecent(now = Date.now()): RecentItem[] {
  try {
    let raw = localStorage.getItem(KEY);
    if (raw == null) {
      raw = localStorage.getItem(OLD_KEY);
      localStorage.removeItem(OLD_KEY);
    }
    return clean(JSON.parse(raw || "[]"), now);
  } catch {
    return [];
  }
}

function store(list: RecentItem[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

/** Put `item` first (replacing the same file, see same()) and keep the newest MAX; returns the new list. */
export function addRecent(item: RecentItem, list: RecentItem[] = loadRecent()): RecentItem[] {
  const next = [item, ...list.filter((x) => !same(x, item))].slice(0, MAX);
  store(next);
  return next;
}

/** The entry's URI could not be read: keep the entry, reopen through the picker. */
export function expireRecent(item: RecentItem, list: RecentItem[] = loadRecent()): RecentItem[] {
  const next = list.map((x) => (same(x, item) ? { ...x, expired: true } : x));
  store(next);
  return next;
}

export function removeRecent(item: RecentItem, list: RecentItem[] = loadRecent()): RecentItem[] {
  const next = list.filter((x) => !same(x, item));
  store(next);
  return next;
}

export function clearRecent(): RecentItem[] {
  store([]);
  return [];
}
