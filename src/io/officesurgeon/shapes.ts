// Office Surgeon — shapes and text boxes (DOCX wps:wsp, HWPX hp:rect / hp:ellipse / hp:line / hp:polygon; model 11).
//
// The map (OfficeSourceMeta.shapes) links every VECTOR / TEXT node read from a floating shape or text box of the body
// to its place in the file (part, top-level element, drawing index there) and its fingerprint (shapeFp).
//   unchanged → nothing is written (the drawing stays byte for byte)
//   changed / deleted → stage 1: the file is written anew (said so; every shape is written by io/officeShapes.ts)
//   new shapes and text boxes (drawn here) → written as a fresh save writes them, anchored in the paragraph at their
//               place (officeDrawing.ts picTargets)

import { hashString } from "../../core/hash";
import type { OfficeSourceMeta, OfficeSourcePic, Page, SceneNode } from "../../core/types";
import type { OfficePic } from "../officeDrawing";
import { shapesOf, type ShapeOut } from "../officeShapes";

/** Model version from which floating shapes and text boxes are VECTOR / TEXT nodes (a 한글 text box's text no body text). */
export const MODEL_SHAPES = 11;

/** Fingerprint of a shape or text box: what it shows and where. */
export function shapeFp(n: SceneNode): string {
  const t = n.transform;
  const place = [t.x, t.y, t.rotation, t.scale, t.scaleY ?? null].map((v) => (v == null ? null : Math.round(v * 100) / 100));
  if (n.type === "VECTOR") return hashString(JSON.stringify(["v", n.visible, place, n.contours, n.fill, n.stroke, n.strokeWidth, n.strokeDash ?? null, n.cornerRadius ?? null, n.strokeCap ?? null, n.strokeJoin ?? null]));
  if (n.type === "TEXT") return hashString(JSON.stringify(["t", n.visible, place, n.width, n.background, n.paragraphs]));
  return hashString(JSON.stringify([n.type, place]));
}

/** The shape map of a fresh import: each shape's node (found on the pages) and its fingerprint. */
export function shapeMap(pages: Page[], shapes: OfficePic[]): OfficeSourcePic[] {
  const nodes = new Map<string, SceneNode>();
  for (const p of pages) for (const n of p.nodes) nodes.set(n.id, n);
  const out: OfficeSourcePic[] = [];
  for (const s of shapes) {
    const n = nodes.get(s.id);
    if (n) out.push({ id: s.id, part: s.part, b: s.b, k: s.k, fp: shapeFp(n) });
  }
  return out;
}

/**
 * Whether every shape of the map that is in `part` is still in the written `out` (a shape's paragraph deleted while
 * the shape stays on the page would take it out of the file): each found by its id in the original element
 * (DOCX wp:docPr id of the element's k-th drawing, HWPX the id of its k-th drawing object).
 */
export function shapesKept(meta: OfficeSourceMeta, part: string, orig: string, els: { start: number; end: number }[], out: string, kind: "docx" | "hwpx"): boolean {
  for (const m of meta.shapes ?? []) {
    if (m.part !== part) continue;
    const el = els[m.b];
    if (!el) return false;
    const text = orig.slice(el.start, el.end);
    if (kind === "docx") {
      const id = [...text.matchAll(/<w:drawing\b[\s\S]*?<wp:docPr\b[^>]*?\sid="(\d+)"/g)][m.k]?.[1];
      if (!id || !new RegExp(`<wp:docPr\\b[^>]*?\\sid="${id}"`).test(out)) return false;
    } else {
      const hit = [...text.matchAll(/<hp:(rect|ellipse|line|polygon)\b[^>]*?\sid="(\d+)"/g)][m.k];
      if (!hit || !new RegExp(`<hp:${hit[1]}\\b[^>]*?\\sid="${hit[2]}"`).test(out)) return false;
    }
  }
  return true;
}

/** What changed among the shapes: whether a mapped one changed or went, and the new ones (to write). */
export function shapeChanges(pages: Page[], meta: OfficeSourceMeta): { changed: boolean; added: ShapeOut[] } {
  const nodes = new Map<string, SceneNode>();
  for (const p of pages) for (const n of p.nodes) nodes.set(n.id, n);
  const mapped = new Set<string>();
  let changed = false;
  for (const m of meta.shapes ?? []) {
    mapped.add(m.id);
    const n = nodes.get(m.id);
    if (!n || shapeFp(n) !== m.fp) changed = true;
  }
  const seen = new Set<string>();
  const added = shapesOf(pages).filter((s) => {
    const id = s.node.id;
    const isNew = !mapped.has(id) || seen.has(id);
    seen.add(id);
    return isNew;
  });
  return { changed, added };
}
