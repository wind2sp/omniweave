// "글자 인식(OCR)…" on the selected image / raster: recognize in the image worker, then insert the result as one
// undo step — an editable rebuild (text blocks + tables, original image kept underneath, locked) or an invisible text
// layer over the unchanged image (searchable / selectable; exported as a PDF text layer).

import { runOcr } from "../core/image/run";
import type { OcrLang } from "../core/image/ocr/models";
import type { OcrPage } from "../core/image/ocr/pipeline";
import { imageFrame, reconstruct, type OcrMode, type ReconstructOptions } from "../core/image/ocr/reconstruct";
import { draftPage, findPage, useStore } from "../core/store";
import { newGroup, type PdfNode, type SceneNode } from "../core/types";
import { imageTarget, loadSource, type ImageSource, type ImageTargetNode } from "./imageActions";
import { pdfPagePixels } from "../io/pdf";
import { t as tr } from "../i18n";

const S = () => useStore.getState();

/**
 * What OCR reads: the selected picture / raster layer, or — on a PDF page with no picture picked — the page itself
 * (a scanned PDF: 실사용 점검 2026-11-23 #81 — the button stayed grey because a PDF page offers no picture to select).
 */
export interface OcrTarget {
  pageId: string;
  node: ImageTargetNode | PdfNode;
}

export function ocrTarget(): OcrTarget | null {
  const img = imageTarget();
  if (img) return img;
  const s = S();
  const page = findPage(s.doc, s.pageId);
  const pdf = page?.nodes.find((n): n is PdfNode => n.type === "PDF" && n.visible);
  if (!page || !pdf || s.selection.some((id) => id !== pdf.id)) return null;
  return { pageId: page.id, node: pdf };
}

/** Pixels to read: a PDF page painted at 200 % (about 190 dpi: small print stays readable), else the picture's own. */
async function ocrSource(node: OcrTarget["node"]): Promise<ImageSource> {
  if (node.type !== "PDF") return loadSource(node);
  const hash = S().doc.assets[node.assetId]?.hash;
  if (!hash) throw new Error(tr("image.err.noSource"));
  const img = await pdfPagePixels(hash, node.pageIndex, 2);
  return { img, ox: 0, oy: 0, sx: node.width / img.width, sy: node.height / img.height };
}

export interface OcrRun {
  target: OcrTarget;
  src: ImageSource;
  page: OcrPage;
  ms: number;
}

export async function recognizeTarget(lang: OcrLang): Promise<OcrRun | null> {
  const target = ocrTarget();
  if (!target) {
    S().notify(tr("image.needTarget"));
    return null;
  }
  const src = await ocrSource(target.node);
  const { value: page, ms } = await runOcr(src.img, lang);
  return { target, src, page, ms };
}

export interface ApplyOcrOptions {
  mode: OcrMode;
  showImage: boolean;
  /** highlight characters below this confidence (0 = off) */
  markBelow: number;
}

/**
 * The result nodes in page coordinates, placed through the source node: its position, scale (also non-uniform),
 * rotation and mirroring, the reduced / straightened OCR page, and its crop (what the crop hides is not rebuilt).
 * The text layer follows the picture's skew so every invisible line lies over its ink.
 */
export function ocrNodes(run: Pick<OcrRun, "target" | "src" | "page">, o: Pick<ApplyOcrOptions, "mode" | "markBelow">, names?: ReconstructOptions["names"]) {
  const { target, src, page } = run;
  const { frame, keep } = imageFrame(target.node.transform, { ox: src.ox, oy: src.oy, sx: src.sx, sy: src.sy, width: src.img.width, height: src.img.height }, page, {
    straighten: o.mode === "layer",
    crop: target.node.crop,
  });
  return reconstruct(page, { mode: o.mode, pageWidth: 0, frame, keep, markBelow: o.markBelow, names });
}

/**
 * Where the result group goes in the flat node list: right above the source, but above the layers clipped in the
 * same stack too — an unclipped group between them would become their clipping base (core/layerTree.ts), so a
 * texture clipped onto the picture would suddenly clip onto the recognized text.
 */
export function ocrInsertIndex(nodes: readonly Pick<SceneNode, "id" | "groupId" | "clip">[], sourceId: string): number {
  let at = nodes.findIndex((n) => n.id === sourceId);
  if (at < 0) return nodes.length;
  const g = nodes[at].groupId;
  while (at + 1 < nodes.length && nodes[at + 1].clip && nodes[at + 1].groupId === g) at++;
  return at + 1;
}

/** Insert the recognized page next to its image (one undo step). Returns the number of nodes added. */
export function applyOcr(run: OcrRun, o: ApplyOcrOptions): number {
  const s = S();
  const { target, page } = run;
  const pg = findPage(s.doc, target.pageId);
  if (pg?.nodes.find((n) => n.id === target.node.id) !== target.node) {
    s.notify(tr("image.changed"));
    return 0;
  }
  const nodes = ocrNodes(run, o, { image: target.node.name, text: tr("ocr.node.text"), table: tr("ocr.node.table"), layer: tr("ocr.node.layer") });
  const group = newGroup(tr(o.mode === "layer" ? "ocr.group.layer" : "ocr.group.rebuild"), target.node.groupId ?? null);
  for (const n of nodes) n.groupId = group.id;
  s.commit(tr(o.mode === "layer" ? "ocr.undo.layer" : "ocr.undo.rebuild"), (d) => {
    const p = draftPage(d, target.pageId);
    if (!p) return;
    (p.groups ??= []).push(group);
    p.nodes.splice(ocrInsertIndex(p.nodes, target.node.id), 0, ...(nodes as any[]));
    const orig = p.nodes.find((n) => n.id === target.node.id);
    if (orig && o.mode === "rebuild") {
      // the original stays underneath as a locked reference layer (shown again from the layers panel)
      orig.locked = true;
      orig.visible = o.showImage;
    }
  });
  s.notify(tr("ocr.done", { lines: page.lines.length, tables: page.tables.length, ms: Math.round(run.ms) }));
  return nodes.length;
}
