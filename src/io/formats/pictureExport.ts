// JPG · WebP (and PNG as "the original format") of a page as a picture. The page is drawn the way the PNG export
// draws it, then encoded by the browser / WebView2 (canvas image/jpeg · image/webp). A picture opened as a file and
// not edited is written as its original bytes (no second JPEG generation); edited, it is drawn at its own pixel size.
// JPEG has no transparency: what is transparent is filled with the chosen background. The photo information (EXIF)
// of a JPG original goes into the new JPG as asked (io/formats/jpegExif.ts). Node-testable: the drawing and the
// encoding are the caller's (ExportCtx.encodeImage).

import { getBlob } from "../../core/assets";
import { IDENTITY, newImage, type OmwDocument, type Page } from "../../core/types";
import { carryExif, exifHasGps, isJpeg, jpegExif, type ExifMode } from "./jpegExif";

export type PictureFormat = "jpg" | "webp" | "png";

export const PICTURE_MIME: Record<PictureFormat, string> = { jpg: "image/jpeg", webp: "image/webp", png: "image/png" };

/** Page source formats of a picture opened as a file (ui/actions.ts canvasImagePage) that "the original format" writes. */
export const PICTURE_SOURCE = new Set<string>(["jpg", "webp", "png"]);

/** What the person picks before a JPG / WebP is written (ui/shell/ImageExportDialog.tsx). */
export interface PictureOptions {
  /** 0…100 */
  quality: number;
  /** what fills transparent pixels in a JPG */
  background: string;
  exif: ExifMode;
}

export const DEFAULT_QUALITY = 90;
export const defaultPictureOptions = (): PictureOptions => ({ quality: DEFAULT_QUALITY, background: "#ffffff", exif: "noGps" });

export interface PictureOptionsRequest {
  format: "jpg" | "webp";
  /** the original is a JPG with photo information */
  hasExif: boolean;
  hasGps: boolean;
}

/** The picture a page shows when it is a picture opened as a file: its asset and bytes. */
export function pictureOf(doc: Pick<OmwDocument, "assets">, page: Page): { bytes: Uint8Array; mime: string; name: string } | null {
  const src = page.source;
  if (!src) return null;
  for (const n of page.nodes) {
    if (n.type !== "IMAGE") continue;
    const a = doc.assets[n.assetId];
    if (!a || a.name !== src.name) continue;
    const bytes = getBlob(a.hash);
    if (bytes) return { bytes, mime: a.mime, name: a.name };
  }
  return null;
}

/** the original JPEG of the page, when it came from one (for its photo information) */
export function originalJpeg(doc: Pick<OmwDocument, "assets">, page: Page): Uint8Array | null {
  const p = pictureOf(doc, page);
  return p && isJpeg(p.bytes) ? p.bytes : null;
}

const PAGE_KEYS = new Set(["id", "name", "kind", "width", "height", "background", "nodes", "masterId", "transition", "animations", "source", "guides", "groups"]);
const IGNORED_NODE_KEYS = new Set(["id", "name", "locked"]);

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as object)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${k}:${canon((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/**
 * A picture opened as a file and not changed: one picture layer, as it was placed (its own size at 0,0, nothing
 * set on it), on a page of the picture's size with nothing else on it. Anything else counts as an edit — when in
 * doubt the picture is drawn again (never the old bytes over an edit).
 */
export function pictureUnedited(doc: Pick<OmwDocument, "assets">, page: Page): Uint8Array | null {
  if (!page.source || !PICTURE_SOURCE.has(page.source.format)) return null;
  if (page.nodes.length !== 1 || page.masterId || page.groups?.length || page.animations?.length) return null;
  for (const [k, v] of Object.entries(page)) if (v !== undefined && !PAGE_KEYS.has(k)) return null;
  const n = page.nodes[0];
  if (n.type !== "IMAGE") return null;
  const pic = pictureOf(doc, page);
  if (!pic) return null;
  const want = { ...newImage(n.assetId, page.width, page.height, n.name), transform: { ...IDENTITY, x: 0, y: 0, rotation: 0, scale: 1 } };
  const strip = (o: object) => Object.fromEntries(Object.entries(o).filter(([k]) => !IGNORED_NODE_KEYS.has(k)));
  if (canon(strip(n)) !== canon(strip(want))) return null;
  // the page background shows only where the picture is transparent (PNG / WebP): changed, it is an edit
  const bg = page.source.format === "jpg" ? null : "transparent";
  if (bg && page.background !== bg) return null;
  return pic.bytes;
}

/** A picture's own pixels (1:1) for a picture page; other pages twice their size, as the PNG export. */
export const pictureScale = (page: Page) => (page.source && PICTURE_SOURCE.has(page.source.format) ? 1 : 2);

export type EncodeImage = (doc: OmwDocument, page: Page, o: { mime: string; quality: number; background: string | null; scale: number }) => Promise<Uint8Array>;

/** The photo-information part of the options dialog for this page (whether there is any, with a location or not). */
export function pictureRequest(doc: OmwDocument, page: Page, format: "jpg" | "webp"): PictureOptionsRequest {
  const exif = format === "jpg" ? jpegExif(originalJpeg(doc, page) ?? new Uint8Array()) : null;
  return { format, hasExif: !!exif, hasGps: !!exif && exifHasGps(exif) };
}

/** The page drawn and encoded as JPG / WebP / PNG with these options; a JPG gets the original's EXIF as asked. */
export async function encodePicture(doc: OmwDocument, page: Page, format: PictureFormat, o: PictureOptions, encode: EncodeImage): Promise<Uint8Array> {
  const q = Math.max(0, Math.min(100, Math.round(o.quality))) / 100;
  const bytes = await encode(doc, page, { mime: PICTURE_MIME[format], quality: q, background: format === "jpg" ? o.background || "#ffffff" : null, scale: pictureScale(page) });
  return format === "jpg" ? carryExif(bytes, originalJpeg(doc, page), o.exif) : bytes;
}
