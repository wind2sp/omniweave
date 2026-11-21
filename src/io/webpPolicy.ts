// WebP in Word / 한글 files (DOCX, HWPX). A WebP the opened file held is written back as its own bytes (the Office
// Surgeon keeps it in place; a file written anew keeps it as image*.webp — officeDrawing.ts picFormat). A WebP put in
// by the person (pasted, inserted) is turned into a PNG when saving — lossless, so nothing of the picture changes —
// since older Word and 한글 do not show WebP. No notice is needed: the picture looks the same.

import { makeAsset, getBlob } from "../core/assets";
import type { AssetRef, OmwDocument, Page } from "../core/types";

export const isWebp = (b: Uint8Array | undefined): boolean =>
  !!b && b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;

/** Picture nodes read from the opened Word / 한글 file (their ids in the file's picture map). */
function fromFile(pages: readonly Page[]): Set<string> {
  return new Set(pages.flatMap((p) => p.source?.office?.pics?.map((m) => m.id) ?? []));
}

/** Assets of WebP pictures the person added (not read from the file), by asset id. */
export function newWebpAssets(doc: OmwDocument): string[] {
  const orig = fromFile(doc.pages);
  const out = new Set<string>();
  for (const p of doc.pages)
    for (const n of p.nodes) {
      if (n.type !== "IMAGE" || orig.has(n.id)) continue;
      const a = doc.assets[n.assetId];
      if (a && isWebp(getBlob(a.hash))) out.add(a.id);
    }
  return [...out];
}

/**
 * The document with the person's WebP pictures as PNG (`toPng` decodes and encodes losslessly — the browser's canvas
 * in the app). The same document when there are none; the opened file's own WebP pictures are left as they are.
 */
export async function webpToPng(doc: OmwDocument, toPng: (webp: Uint8Array) => Promise<Uint8Array | null>): Promise<OmwDocument> {
  const ids = newWebpAssets(doc);
  if (!ids.length) return doc;
  const orig = fromFile(doc.pages);
  const swap = new Map<string, AssetRef>();
  for (const id of ids) {
    const a = doc.assets[id];
    const png = await toPng(getBlob(a.hash)!);
    if (png) swap.set(id, makeAsset(png, "image/png", a.name.replace(/\.webp$/i, "") + ".png"));
  }
  if (!swap.size) return doc;
  const assets = { ...doc.assets };
  for (const a of swap.values()) assets[a.id] = a;
  const pages = doc.pages.map((p) =>
    p.nodes.some((n) => n.type === "IMAGE" && !orig.has(n.id) && swap.has(n.assetId))
      ? { ...p, nodes: p.nodes.map((n) => (n.type === "IMAGE" && !orig.has(n.id) && swap.has(n.assetId) ? { ...n, assetId: swap.get(n.assetId)!.id } : n)) }
      : p,
  );
  return { ...doc, assets, pages };
}
