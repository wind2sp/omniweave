// Recent files for the start screen: path, name, format and a small thumbnail of the first page, kept per viewer
// in localStorage (max 8). Only files with a real path (desktop app) are remembered — a browser upload cannot be
// reopened by path.

import { create } from "zustand";
import type { OmwDocument, Page } from "../../core/types";
import { renderMasterOf } from "../../core/headerFooter";
import { paintPage } from "../../render/weave";
import { ctx2d, makeCanvas } from "../../render/draw";

export interface RecentFile {
  path: string;
  name: string;
  /** extension, lower case */
  format: string;
  /** ms since epoch */
  at: number;
  /** JPEG data URL of the first page (≈ 200 px wide), or null */
  thumb: string | null;
}

const KEY = "omniweave.recent.v1";
const MAX = 8;

function load(): RecentFile[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x) => x && typeof x.path === "string" && typeof x.name === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
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
  const entry: RecentFile = { path, name, format, at, thumb };
  save([entry, ...useRecent.getState().list.filter((x) => x.path.toLowerCase() !== path.toLowerCase())].slice(0, MAX));
}

export function forgetRecent(path: string) {
  save(useRecent.getState().list.filter((x) => x.path.toLowerCase() !== path.toLowerCase()));
}

export function clearRecent() {
  save([]);
}
