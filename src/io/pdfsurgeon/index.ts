// PDF Surgeon — Omniweave's own PDF editing engine (public API).
//
//   bytes ──openSurgeonDoc──▶ SurgeonDoc (pdf-lib object graph; encrypted files decrypted first)
//         ──elevatePage────▶ TextNode / VectorNode with deterministic ids linked to operations
//         ──saveSurgical───▶ incremental update: only the operations of changed nodes are rewritten
//
// Layers: syntax (lexer/ops) · filters · crypto/decrypt · document · fonts/encodings ·
// interpret (graphics state) · elevate (nodes) · write/incremental (output) · ai (Illustrator).

import { PDFDocument } from "pdf-lib";
import type { TextNode, VectorNode } from "../../core/types";
import { openSurgeonDoc, type SurgeonDoc } from "./document";
import { isAiWithoutPdfContent } from "./ai";
import { modelPage, type ElevateOptions } from "./elevate";
import { t } from "../../i18n";
import { applyEdits, type PageEditInput, type SaveOptions, type SaveReport } from "./write";

export { openSurgeonDoc, NeedPasswordError, type SurgeonDoc } from "./document";
export { PasswordError, UnsupportedSecurityError, decryptPdf, type EncryptionInfo } from "./decrypt";
export { aiNoPdfContentMsg, aiSaveNote, aiXmpThumbnail, isAiWithoutPdfContent, isIllustratorPdf } from "./ai";
export { isSurgeonId, modelPage, textId, vectorId, type ElevateOptions, type PageModel } from "./elevate";
export type { PageEditInput, SaveOptions, SaveReport } from "./write";
export { addAnnots, annotRect, type AnnotReport, type PdfAnnot, type PdfAnnotKind } from "./annots";
export { fillForm, formFields, type FillReport, type FormField, type FormFieldKind, type FormValue, type FormWidget } from "./forms";

/**
 * Version of the elevation rules. Node ids are only meaningful for the rules that produced them,
 * so the marker records it and saving refuses to apply edits made under different rules.
 */
export const ENGINE_VERSION = 2; // 2 (2026-11-13): vector paths under a gradient / image / kept path stay in the background (ids shift)
/** Marker cover stored on a PdfNode once its page was elevated by PDF Surgeon (zero size: draws nothing). */
export const SURGEON_MARK = { x: ENGINE_VERSION, y: 0, w: 0, h: 0, color: "transparent" } as const;
export const isSurgeonMark = (c: { x: number; y: number; w: number; h: number; color: string }) => c.w === 0 && c.h === 0 && c.color === SURGEON_MARK.color;

/** A private copy of the document for one save (saving mutates pdf-lib's object graph). */
export async function forkDoc(doc: SurgeonDoc): Promise<SurgeonDoc> {
  const pdf = await PDFDocument.load(doc.plain, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  return { ...doc, pdf, ctx: pdf.context, pageRefs: pdf.getPages().map((p) => p.ref), fontCache: new Map() };
}

export interface ElevatedPage {
  nodes: (TextNode | VectorNode)[];
  textCount: number;
  vectorCount: number;
  notes: string[];
}

/** Editable nodes for one page, bottom → top in drawing order. */
export function elevatePage(doc: SurgeonDoc, pageIndex: number, opts: ElevateOptions): ElevatedPage {
  const m = modelPage(doc, pageIndex, opts);
  // keep the original painting order between text and vectors
  const order = new Map<object, number>(m.analysis.items.map((it, i) => [it, i]));
  const tagged: [number, TextNode | VectorNode][] = [
    ...m.lines.map((l) => [order.get(l.shows[0]) ?? 0, l.node] as [number, TextNode]),
    ...m.vectors.map((v) => [order.get(v.path) ?? 0, v.node] as [number, VectorNode]),
  ];
  tagged.sort((a, b) => a[0] - b[0]);
  return { nodes: tagged.map(([, n]) => n), textCount: m.lines.length, vectorCount: m.vectors.length, notes: m.notes };
}

/**
 * Save edits. Returns the original bytes (same object) when nothing changed; otherwise the plain
 * (decrypted) file plus an incremental update. Re-encryption is the caller's choice.
 */
export async function saveSurgical(doc: SurgeonDoc, inputs: PageEditInput[], opts: SaveOptions): Promise<{ bytes: Uint8Array; report: SaveReport }> {
  if (doc.encryption && !doc.encryption.canModify) {
    const touched = inputs.some((i) => i.elevated || i.nodes.some((n) => n.type !== "PDF"));
    if (touched) throw new Error(t("engine.pdf.noModify"));
  }
  return applyEdits(await forkDoc(doc), inputs, opts);
}

/**
 * The page with every elevated operation removed — the background the editor shows under the
 * elevated nodes (no cover rectangles, so nothing shows through or looks patched).
 */
export async function strippedForView(doc: SurgeonDoc, pageIndex: number, opts: ElevateOptions): Promise<Uint8Array> {
  const { bytes, report } = await applyEdits(await forkDoc(doc), [{ pageIndex, nodes: [], elevated: true }], { ...opts, fallbackFont: undefined });
  return report.changed ? bytes : doc.plain;
}


const AI_PRIVATE = Array.from("AIPrivateData", (c) => c.charCodeAt(0));
function containsAscii(b: Uint8Array, needle: number[]): boolean {
  const first = needle[0];
  outer: for (let i = b.indexOf(first); i >= 0 && i + needle.length <= b.length; i = b.indexOf(first, i + 1)) {
    for (let k = 1; k < needle.length; k++) if (b[i + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * True when `bytes` are an Illustrator file saved without PDF content (only a notice page).
 * Cheap for ordinary PDFs: the document is only parsed when the Illustrator marker is present.
 * Damaged or encrypted files answer false (the normal open path reports those).
 */
export async function detectAiWithoutPdfContent(bytes: Uint8Array): Promise<boolean> {
  if (!containsAscii(bytes, AI_PRIVATE)) return false;
  try {
    return isAiWithoutPdfContent(await openSurgeonDoc(bytes));
  } catch {
    return false;
  }
}