// Phone viewer: a file → something the viewer can page through (docs/MOBILE_PLAN.md §1.2 "열기").
// PDF goes straight to pdf.js (only the pages near the screen are drawn); DOCX · HWPX · PPTX · XLSX · .omw are read by
// the desktop engine's own importers (io/formats) into pages that render/weave paints one at a time; pictures are
// shown as they are. Password-protected PDF / Office / HWPX / .omw files ask through io/crypto/session (the phone
// installs its own dialog). Nothing here touches the desktop editor's store.

import type { OmwDocument, Page } from "../../core/types";
import { t } from "../../i18n";
import { askPassword } from "../../io/crypto/session";

export type ViewKind = "pdf" | "pages" | "image" | "media" | "other";

/** Everything the desktop's format registry opens into pages (io/formats): the phone shows the same files. */
export const PAGE_EXTS = ["docx", "hwpx", "pptx", "ppsx", "xlsx", "xlsm", "omw", "hwp", "doc", "xls", "ppt", "pps", "csv", "tsv", "md", "markdown", "html", "htm", "xhtml", "epub", "srt", "tif", "tiff", "heic", "heif", "bmp", "ico", "avif", "odt", "odp"];
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "webp", "gif"];
/** sound and video: played by the browser (the desktop places them on a slide) */
export const MEDIA_EXTS = ["mp3", "wav", "ogg", "oga", "flac", "aac", "m4a", "opus", "mp4", "m4v", "webm", "mov", "ogv", "mkv", "avi"];

/** Formats the phone opens for editing (editor/MobileEditor). */
export const EDIT_EXTS = ["pdf", "ai", "docx", "hwpx", "pptx", "xlsx", "xlsm", "psd", "psb", "dxf", "dwg", "svg", "omw"];
/** Formats the phone opens straight in the editor (no viewer for them). */
export const EDITOR_ONLY_EXTS = ["psd", "psb", "ai", "dxf", "dwg", "svg"];
export const canEdit = (name: string) => EDIT_EXTS.includes(extOf(name));

export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

export function viewKind(name: string): ViewKind {
  const ext = extOf(name);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTS.includes(ext)) return "image";
  if (PAGE_EXTS.includes(ext)) return "pages";
  if (MEDIA_EXTS.includes(ext)) return "media";
  return "other";
}

/** Pages of a non-PDF document, in a document of their own (headers / footers and slide masters resolve against it). */
export interface PagesView {
  doc: OmwDocument;
  pages: Page[];
  /** each page's text, for search (filled lazily) */
  text: (i: number) => string;
}

/** DOCX · HWPX · PPTX · XLSX · .omw → pages. Throws a readable error; a cancelled password is `t("mobile.pwCancelled")`. */
export async function openPages(name: string, bytes: Uint8Array): Promise<PagesView> {
  const ext = extOf(name);
  const { newDocument } = await import("../../core/types");
  const texts = new Map<number, string>();
  let doc: OmwDocument;
  if (ext === "omw") {
    const { decryptOmw, isEncryptedOmw } = await import("../../io/crypto/omwCrypt");
    const { withPassword } = await import("../../io/crypto/session");
    let b = bytes;
    if (isEncryptedOmw(b)) {
      const r = await withPassword({ title: t("doc.pw.omwTitle"), message: t("doc.pw.omwMessage", { name }) }, (pw) => decryptOmw(bytes, pw), (e) => (e as Error)?.message === "WRONG_PASSWORD");
      if (!r) throw new Error(t("mobile.pwCancelled"));
      b = r.value;
      byBytes.set(bytes, r.password);
    }
    doc = (await import("../../io/omw")).unpackOmw(b).doc;
  } else {
    // the desktop's own "open" (ui/actions.ts fileToPages): every registry format, the same password questions for
    // protected Office / HWPX files (answered on the phone's sheet), pictures as a page of their own
    const { fileToPages } = await import("../actions");
    const r = await fileToPages({ name, path: null, bytes }).catch((e: Error) => {
      if (e?.message === t("doc.pw.cancelled")) throw new Error(t("mobile.pwCancelled"));
      throw e;
    });
    const sid = r.pages.map((p) => p.source?.protection?.secretId).find(Boolean);
    if (sid) {
      const pw = (await import("../../io/crypto/session")).getSecret(sid);
      if (pw) byBytes.set(bytes, pw);
    }
    doc = newDocument(name.replace(/\.[^.]+$/, ""));
    doc.pages = r.pages ?? [];
    doc.assets = r.assets ?? {};
  }
  if (!doc.pages.length) throw new Error(t("mobile.noPages"));
  const { pagesToText } = await import("../../io/formats/text");
  return {
    doc,
    pages: doc.pages,
    text: (i) => {
      let s = texts.get(i);
      if (s === undefined) {
        try {
          s = pagesToText([doc.pages[i]]);
        } catch {
          s = "";
        }
        texts.set(i, s);
      }
      return s;
    },
  };
}

const passwords = new WeakMap<object, string>();
/** the password an open PDF was unlocked with, or null */
export const pdfPassword = (doc: object): string | null => passwords.get(doc) ?? null;
/** the password the viewer opened these very bytes with (memory only, gone with the file): the editor and the
 *  desktop editor on the phone try it first instead of asking again */
const byBytes = new WeakMap<Uint8Array, string>();
export const knownPassword = (bytes: Uint8Array): string | null => byBytes.get(bytes) ?? null;
/** a copy made here with the password of the file it came from (a marked-up PDF): opened without asking again */
export const rememberPassword = (bytes: Uint8Array, pw: string) => void byBytes.set(bytes, pw);

/** pdf.js document with the password asked through the phone's dialog (up to 5 tries). */
export async function openPdf(bytes: Uint8Array, name: string) {
  const { pdfjsLib } = await import("../../io/pdfjsLoader");
  const lib = await pdfjsLib();
  const task = lib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  let tries = 0;
  let password: string | null = null;
  (task as any).onPassword = (update: (pw: string) => void, reason: number) => {
    if (++tries > 5) return void task.destroy();
    // the password these very bytes were opened (or made) with: tried first, without asking
    const known = byBytes.get(bytes);
    if (known != null && tries === 1) return update((password = known));
    void askPassword({ title: t("mobile.pwPdfTitle"), message: t("mobile.pwPdfMessage", { name }), retry: reason === 2 }).then((pw) => {
      if (pw == null) void task.destroy();
      else update((password = pw));
    });
  };
  try {
    const doc = await task.promise;
    // kept in memory with the open document only: a marked-up copy is protected again with it (markup.tsx)
    if (password != null) passwords.set(doc, password), byBytes.set(bytes, password);
    return doc;
  } catch (e: any) {
    if (e?.name === "PasswordException" || /destroyed|Worker was destroyed|Loading aborted/i.test(String(e?.message))) throw new Error(t("mobile.pwCancelled"));
    throw e;
  }
}

/** Free what an opened document left in the engine's memory (picture bytes, decoded bitmaps) when the viewer closes. */
export async function releaseEngineMemory(): Promise<void> {
  const [{ clearBlobs }, { dropDecodedImages }] = await Promise.all([import("../../core/assets"), import("../../render/draw")]);
  clearBlobs();
  dropDecodedImages();
}
