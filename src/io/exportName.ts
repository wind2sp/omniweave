// Default file names for Save (.omw) and Export: the document's name with the new extension — "photo.jpg" exported
// as PNG is "photo.png", never "photo-photo.png" (the page of a picture opened as a file carries the same name as the
// document) nor "photo.jpg.png". A page name is added once, only when the document has several pages and the page
// name says something the document name does not ("report-3.png"). Desktop save dialog and browser download alike.

import { DEFAULT_TITLE, docTitle } from "../i18n";
import type { OmwDocument, Page } from "../core/types";

/** extensions taken off a name before the new one goes on (formats Omniweave opens or writes) */
const KNOWN_EXT =
  /\.(omw|png|jpe?g|jfif|webp|gif|svg|bmp|ico|avif|tiff?|heic|heif|psd|psb|pdf|ai|eps|docx?|dotx|hwpx?|pptx?|potx|xlsx?|xltx|csv|tsv|md|markdown|html?|xhtml|txt|text|log|json|xml|ya?ml|srt|epub|rtf|odt|dxf|dwg|zip)$/i;

/** A name without the known extensions it ends with ("photo.jpg" → "photo", "a.jpg.png" → "a"); never empty. */
export function stripKnownExt(name: string): string {
  let s = name.trim();
  for (let k = 0; k < 3 && KNOWN_EXT.test(s); k++) {
    const next = s.replace(KNOWN_EXT, "").trim();
    if (!next) break;
    s = next;
  }
  return s;
}

const unsafe = (s: string) => s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");

/** "name.ext": the extension once, the name safe for a file system. */
export function withExt(name: string, ext: string): string {
  return `${unsafe(stripKnownExt(name)) || "_"}.${ext}`;
}

const sourceStem = (p: Page | undefined) => (p?.source?.name ? stripKnownExt(p.source.name.split(/[\\/]/).pop() ?? p.source.name) : "");

/** The document's name for files: its title, or — untitled — the file its first page came from, else "Untitled". */
export function docFileStem(doc: Pick<OmwDocument, "title" | "pages">): string {
  const title = doc.title?.trim();
  const untitled = !title || title === DEFAULT_TITLE || title === docTitle(DEFAULT_TITLE);
  return stripKnownExt(untitled ? sourceStem(doc.pages[0]) || docTitle(DEFAULT_TITLE) : title);
}

/**
 * The file name (without extension) of one page exported on its own (PNG · JPG · WebP · SVG · PSD): the document's
 * name; with several pages, "document-page" — unless the page name is the document's name or already starts with it.
 */
export function pageFileStem(doc: Pick<OmwDocument, "title" | "pages">, page: Page): string {
  const base = docFileStem(doc);
  const name = stripKnownExt(page.name ?? "").trim();
  if (!name || doc.pages.length <= 1) return base;
  const lo = name.toLowerCase(), b = base.toLowerCase();
  if (lo === b || (lo.startsWith(b) && /^[\s\-_.(\[]/.test(name.slice(base.length)))) return name;
  return `${base}-${name}`;
}
