// Recent files for the start screen: path, name, format and a small thumbnail of the first page, kept per viewer
// in localStorage (max 8, pinned ones besides). The desktop app remembers files by path; the web build (Chrome / Edge)
// by the browser's file handle, kept in IndexedDB (io/handleStore.ts) under a "handle:<id>" path. A browser without
// handles (an upload) remembers nothing — it could not open the file again.

import { create } from "zustand";
import type { OmwDocument, Page } from "../../core/types";
import { renderMasterOf } from "../../core/headerFooter";
import { paintPage } from "../../render/weave";
import { ctx2d, makeCanvas } from "../../render/draw";
import { deleteHandle, getHandle, putHandle } from "../../io/handleStore";
import type { FileHandle } from "../../io/platform";

/** a web recent file: its handle is kept in IndexedDB under this id */
export const HANDLE_PREFIX = "handle:";
export const isHandlePath = (p: string) => p.startsWith(HANDLE_PREFIX);

export interface RecentFile {
  path: string;
  name: string;
  /** extension, lower case */
  format: string;
  /** ms since epoch */
  at: number;
  /** JPEG data URL of the first page (≈ 200 px wide), or null */
  thumb: string | null;
  /** pinned to the list (Word's 목록에 고정): stays at the top and is never pushed out */
  pinned?: boolean;
}

const KEY = "omniweave.recent.v1";
const MAX = 8;

function load(): RecentFile[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? order(v.filter((x) => x && typeof x.path === "string" && typeof x.name === "string")) : [];
  } catch {
    return [];
  }
}

/** pinned files first (in their order), then the others newest first, at most MAX of those */
function order(list: RecentFile[]): RecentFile[] {
  const pinned = list.filter((x) => x.pinned);
  return [...pinned, ...list.filter((x) => !x.pinned).slice(0, MAX)];
}

export const useRecent = create<{ list: RecentFile[] }>(() => ({ list: load() }));

function save(list: RecentFile[]) {
  useRecent.setState({ list });
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage full or blocked — the list still works for this session */
  }
}

/**
 * A thumbnail may be kept only for content that is not password-protected: localStorage is plain text, so a
 * picture of an encrypted file's first page would leak what the password hides.
 */
export function recentThumbAllowed(doc: OmwDocument, isProtected: boolean): boolean {
  return !isProtected && !doc.pages.some((p) => p.source?.protection);
}

/** Times a thumbnail is drawn again as parts of its page arrive (a CMYK composite comes in several steps). */
const THUMB_RETRIES = 32;

/**
 * Small JPEG of a document's page (default: the first). What is not ready yet (a large CMYK PSD's composite — never
 * computed here on the main thread) is drawn as it stands; `better` then gets the picture again once it is, and
 * again until it is complete.
 */
export function docThumb(doc: OmwDocument, width = 200, page: Page | undefined = doc.pages[0], better?: (thumb: string) => void, tries = THUMB_RETRIES): string | null {
  if (!page || typeof document === "undefined") return null;
  try {
    const scale = width / page.width;
    const src = makeCanvas(page.width * scale, page.height * scale);
    let again = false;
    paintPage(ctx2d(src), doc, page, renderMasterOf(doc, page), scale, undefined, () => {
      // called once per resource that arrives: one redraw for all of them
      if (again || !better || tries <= 0) return;
      again = true;
      setTimeout(() => {
        const t = docThumb(doc, width, page, better, tries - 1);
        if (t) better(t);
      }, 0);
    }, true);
    const cv = document.createElement("canvas");
    cv.width = src.width;
    cv.height = src.height;
    const g = cv.getContext("2d")!;
    g.fillStyle = page.background || "#ffffff";
    g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(src as CanvasImageSource, 0, 0);
    return cv.toDataURL("image/jpeg", 0.72);
  } catch {
    return null;
  }
}

/**
 * Put a file at the top of the list (after open or save). `page` is the page the file brought in (default: the
 * document's first); `protected` = the content came from or was saved to a password-protected file (no thumbnail).
 */
export function rememberRecent(path: string | null | undefined, name: string, doc?: OmwDocument, opts: { protected?: boolean; page?: Page } = {}) {
  if (!path || !(path.includes("\\") || path.includes("/"))) return;
  const format = (name.split(".").pop() ?? "").toLowerCase();
  const at = Date.now();
  // a picture that comes later replaces this entry's thumbnail, while the entry is still this one
  const better = (t: string) => save(useRecent.getState().list.map((x) => (x.path === path && x.at === at ? { ...x, thumb: t } : x)));
  const thumb = doc && recentThumbAllowed(doc, !!opts.protected) ? docThumb(doc, 200, opts.page, better) : null;
  const was = useRecent.getState().list.find((x) => x.path.toLowerCase() === path.toLowerCase());
  const entry: RecentFile = { path, name, format, at, thumb, ...(was?.pinned ? { pinned: true } : {}) };
  save(order([entry, ...useRecent.getState().list.filter((x) => x !== was)]));
}

/** Pin a file to the top of the list, or unpin it (Word's 목록에 고정 / 고정 해제). */
export function togglePinRecent(path: string) {
  const list = useRecent.getState().list.map((x) => (x.path.toLowerCase() === path.toLowerCase() ? { ...x, pinned: !x.pinned } : x));
  // newly pinned: last of the pinned; unpinned: back among the others by its time
  const pinned = list.filter((x) => x.pinned);
  const target = list.find((x) => x.path.toLowerCase() === path.toLowerCase());
  const others = list.filter((x) => !x.pinned).sort((a, b) => b.at - a.at);
  save(order(target?.pinned ? [...pinned.filter((x) => x !== target), target, ...others] : [...pinned, ...others]));
}

export function forgetRecent(path: string) {
  save(useRecent.getState().list.filter((x) => x.path.toLowerCase() !== path.toLowerCase()));
  if (isHandlePath(path)) void deleteHandle(path.slice(HANDLE_PREFIX.length));
}

/**
 * The web build's "remember": a file opened through the browser's picker or dropped with a handle. The same file
 * again (isSameEntry) keeps its entry and pin; a handle the browser cannot store is not remembered.
 */
export async function rememberRecentHandle(h: FileHandle, name: string, doc?: OmwDocument, opts: { protected?: boolean; page?: Page } = {}): Promise<boolean> {
  const same = (h as FileHandle & { isSameEntry?: (o: unknown) => Promise<boolean> }).isSameEntry;
  let id: string | null = null;
  for (const x of useRecent.getState().list) {
    if (!isHandlePath(x.path) || !same) continue;
    const old = await getHandle(x.path.slice(HANDLE_PREFIX.length));
    if (old && (await same.call(h, old).catch(() => false))) {
      id = x.path.slice(HANDLE_PREFIX.length);
      break;
    }
  }
  id ??= `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  if (!(await putHandle(id, h))) return false;
  const path = HANDLE_PREFIX + id;
  const was = useRecent.getState().list.find((x) => x.path === path);
  const at = Date.now();
  const better = (t: string) => save(useRecent.getState().list.map((x) => (x.path === path && x.at === at ? { ...x, thumb: t } : x)));
  const thumb = doc && recentThumbAllowed(doc, !!opts.protected) ? docThumb(doc, 200, opts.page, better) : null;
  const entry: RecentFile = { path, name, format: (name.split(".").pop() ?? "").toLowerCase(), at, thumb, ...(was?.pinned ? { pinned: true } : {}) };
  const before = useRecent.getState().list;
  const next = order([entry, ...before.filter((x) => x !== was)]);
  save(next);
  // handles pushed out of the list are dropped from IndexedDB too
  for (const x of before) if (isHandlePath(x.path) && !next.some((y) => y.path === x.path)) void deleteHandle(x.path.slice(HANDLE_PREFIX.length));
  return true;
}

/** A web recent file's handle, readable now (the browser asks the person once per visit). */
export async function recentHandle(path: string): Promise<FileHandle | null> {
  const h = await getHandle(path.slice(HANDLE_PREFIX.length));
  if (!h) return null;
  try {
    if ((await h.queryPermission?.({ mode: "read" })) !== "granted" && (await h.requestPermission?.({ mode: "read" })) !== "granted") return null;
  } catch {
    return null;
  }
  return h;
}

export function clearRecent() {
  save([]);
}
