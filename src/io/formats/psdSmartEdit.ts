// Editing a PSD smart object's content (Photoshop's 'Edit Contents'), the engine part — ui/smartObject.ts drives it
// with document tabs.
//
//   smartContentBytes  the embedded file a smart layer shows now (its edited content, else the original entry)
//   smartContentOut    the content's own document → the file to embed (PSB / PSD via the PSD Surgeon, PNG) and the
//                      picture it shows (its layers composited, transparency kept)
//   applySmartContent  the parent's layer with that content: pixels drawn through its placed transform (re-centred
//                      when the content's canvas changed), the file kept as an asset; the PSD Surgeon then writes it
//                      as a smart object with the new embedded file (psdWrite.ts smartEdited)

import { getBlob, makeAsset } from "../../core/assets";
import type { AssetRef, OmwDocument, Page, PsdSmart, RasterNode } from "../../core/types";
import { encodePng } from "./png";
import { parsePsdLayout, rasterFingerprint } from "./psd";
import { linkedFiles, projectPlaced, quadForSize, trimTransparent } from "./psdSmart";
import { pageComposite, writePsd, type PsdWriteOptions } from "./psdWrite";
import { rasterFromRgba } from "./raster";
import { t } from "../../i18n";

/** The embedded file a smart node shows now, or null (linked, a kind this cannot open, original not at hand). */
export function smartContentBytes(doc: OmwDocument, page: Page, node: RasterNode): Uint8Array | null {
  const sm = node.psdSmart;
  if (!sm || sm.kind !== "embedded" || !sm.content) return null;
  if (sm.edited) return getBlob(sm.edited.hash)?.slice() ?? null;
  const meta = page.source?.format === "psd" ? page.source.psd : undefined;
  const asset = meta ? doc.assets[meta.assetId] : undefined;
  const orig = asset && asset.hash === meta!.hash ? getBlob(asset.hash) : undefined;
  if (!orig) return null;
  try {
    const f = linkedFiles(parsePsdLayout(orig)).find((x) => x.id === sm.id && x.type === "liFD" && x.data);
    return f ? orig.slice(f.data!.start, f.data!.end) : null;
  } catch {
    return null;
  }
}

/** File name a smart object's content opens under (the stored one, with an extension for its kind). */
export function smartContentName(sm: PsdSmart): string {
  const ext = sm.content === "jpg" ? "jpg" : sm.content ?? "psb";
  const base = (sm.name || "smart-object").replace(/[\\/:*?"<>|]/g, "_");
  return new RegExp(`\\.${ext}$`, "i").test(base) || (ext === "jpg" && /\.jpe?g$/i.test(base)) ? base : `${base}.${ext}`;
}

export interface SmartOut {
  bytes: Uint8Array;
  /** the picture of the content (straight RGBA, w × h) */
  rgba: Uint8Array;
  w: number;
  h: number;
  /** what was written: a JPEG's content is put back as PNG (no JPEG re-compression) */
  kind: "psd" | "psb" | "png";
  warnings: string[];
}

/** The content's document (`page`, opened from the smart object as `kind`) → the file to embed and its picture. */
export async function smartContentOut(doc: OmwDocument, page: Page, kind: NonNullable<PsdSmart["content"]>, opts: PsdWriteOptions = {}): Promise<SmartOut> {
  const w = Math.round(page.width), h = Math.round(page.height);
  const rgba = await pageComposite(doc, page, opts);
  if (kind === "psd" || kind === "psb") {
    const r = await writePsd(doc, page, opts);
    return { bytes: r.bytes, rgba, w, h, kind, warnings: r.warnings };
  }
  return { bytes: encodePng(rgba, w, h), rgba, w, h, kind: "png", warnings: kind === "jpg" ? [t("engine.psdsmart.jpegAsPng")] : [] };
}

/**
 * The parent's smart node with new content `out` in place of content of `was` (its size when it was opened): its
 * pixels drawn through the placed corners (perspective included; re-centred for a new canvas size), the file kept as
 * a new asset. The node keeps its id, name, effects, blend and opacity.
 */
export function applySmartContent(node: RasterNode, out: SmartOut, was: { w: number; h: number }): { node: RasterNode; asset: AssetRef } {
  const sm = node.psdSmart;
  if (!sm || sm.kind !== "embedded" || !sm.content) throw new Error(t("engine.psdsmart.notSmart"));
  if (!sm.redraw) throw new Error(t("engine.psdsmart.noRedraw"));
  const quad = quadForSize(sm.quad, was.w, was.h, out.w, out.h);
  const pr = trimTransparent(projectPlaced(out.rgba, out.w, out.h, quad));
  // a JPEG put back as PNG: the entry is renamed and retyped (and stays so for later edits — the Surgeon always starts
  // from the original file's entry)
  const asJpeg = (sm.content === "jpg" && out.kind === "png") || !!sm.edited?.fileType;
  const name = sm.edited?.name ?? (asJpeg ? sm.name.replace(/\.jpe?g$/i, "") + ".png" : sm.name);
  const asset = makeAsset(out.bytes, out.kind === "png" ? "image/png" : "image/vnd.adobe.photoshop", name || "smart");
  const r = pr.width && pr.height ? rasterFromRgba(pr.rgba, pr.width, pr.height, node.name) : rasterFromRgba(new Uint8Array(4), 1, 1, node.name);
  const next: RasterNode = { ...node, tiles: pr.width && pr.height ? r.tiles : {}, transform: { x: pr.left, y: pr.top, rotation: 0, scale: 1 }, crop: undefined };
  delete next.crop;
  const fp = rasterFingerprint(next);
  next.psdSmart = { ...sm, quad, ...(asJpeg ? { content: "png" as const } : {}), edited: { assetId: asset.id, hash: asset.hash, w: out.w, h: out.h, fp, ...(asJpeg ? { name, fileType: "png " } : {}) } };
  return { node: next, asset };
}
