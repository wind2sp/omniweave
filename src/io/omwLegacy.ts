// What a saved .omw does for the Omniweave versions before it (docs/RELEASING.md, .omw compatibility).
//
// 1. Body flow in columns (단, Page.columns · 이어서 구역 TextParagraph.contSect): 0.2.0 and 0.2.1 gather a page run's
//    story by the frames' position (top to bottom, then left to right) and know no column (SceneNode.flowCol). The
//    first edit there re-flows it, and the top of the right column comes before the rest of the left one — the
//    paragraphs end up out of order, for good. Such a page run is written with its flow frames held
//    (SceneNode.flowHeld instead of `flow`): an older version shows them where they are and edits them as text boxes,
//    without re-flowing them; reading turns them back into flow.
// 2. The features a file uses (manifest `features`): a version that finds one it does not know says that part of
//    the document may not show as it was made (with report.version.newer and unknown document fields).

import { isFlowNode, isFlowSegment, segments } from "../core/flow";
import { bodyBox, columnBoxes } from "../core/pageSetup";
import type { OmwDocument, Page, SceneNode } from "../core/types";
import { unknownDocFields } from "./omwMigrate";

/** A page run whose body flow uses columns: several on a page, or an 이어서 구역 with them. */
function hasColumns(pages: readonly Page[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const p = pages[i];
    if (p.columns && p.columns.n > 1) return true;
    for (const n of p.nodes) {
      if (!isFlowNode(n)) continue;
      if (n.flowCol) return true;
      if (n.type === "TEXT" && n.paragraphs.some((q) => (q.contSect?.columns?.n ?? 1) > 1)) return true;
    }
  }
  return false;
}

const held = (n: SceneNode): SceneNode => {
  const out = { ...n, flowHeld: true as const };
  delete out.flow;
  return out;
};

/** The pages with the flow of every page run in columns held (the same array when there is none). */
function holdPages(pages: readonly Page[]): readonly Page[] {
  let out: Page[] | null = null;
  for (const seg of segments(pages)) {
    if (!isFlowSegment(pages as Page[], seg) || !hasColumns(pages, seg.start, seg.end)) continue;
    out ??= [...pages];
    for (let i = seg.start; i < seg.end; i++) {
      const p = pages[i];
      if (p.nodes.some(isFlowNode)) out[i] = { ...p, nodes: p.nodes.map((n) => (isFlowNode(n) ? held(n) : n)) };
    }
  }
  return out ?? pages;
}

/** The document as it is written to a file (see 1 above); the same object when nothing is held. */
export function holdColumnFlow(doc: OmwDocument): OmwDocument {
  const pages = holdPages(doc.pages);
  return pages === doc.pages ? doc : { ...doc, pages: pages as Page[] };
}

/**
 * The document as read from a file: held flow is flow again. `held` = there was some (a file this version or a later
 * one wrote; when an older version saved it since, its frames may have been edited as boxes and are flowed again).
 */
export function releaseColumnFlow(doc: OmwDocument): { doc: OmwDocument; held: boolean } {
  let held = false;
  const pages = doc.pages.map((p) => {
    if (!p.nodes.some((n) => n.flowHeld)) return p;
    held = true;
    return {
      ...p,
      nodes: p.nodes.map((n) => {
        if (!n.flowHeld) return n;
        const out = { ...n, flow: true as const };
        delete out.flowHeld;
        return out;
      }),
    };
  });
  return held ? { doc: { ...doc, pages }, held } : { doc, held };
}

/**
 * Pages in columns whose body text runs the full width of the body: an older version re-flowed them (it knows no
 * columns; the order it gathered is what the file now says). Their indexes.
 */
export function columnsLostAt(pages: readonly Page[]): number[] {
  const out: number[] = [];
  pages.forEach((p, i) => {
    if (p.kind !== "DOCUMENT" || !p.columns || p.columns.n < 2) return;
    const w = Math.max(...columnBoxes(bodyBox(p), p.columns).map((c) => c.w));
    if (p.nodes.some((n) => isFlowNode(n) && n.type === "TEXT" && n.width > w + 1)) out.push(i);
  });
  return out;
}
/**
 * Features a file uses, by the fields that hold them (manifest `features`). Every field named here is one this
 * version reads; a later version adds its own, and this list is what decides "unknown" when reading.
 */
export const KNOWN_FEATURES: readonly string[] = [
  "columns", // Page.columns (단)
  "contSect", // 이어서 구역
  "colBreak", // 단 나누기
  "flowCol", // body flow column
  "flowHeld", // flow held for older versions (above)
  "focal", // focal radial gradients
  "strokes", // gradient / multiple strokes
  "pptx", // PowerPoint animation effects kept as written
  "pptxTiming",
  "animations",
  "annots", // PDF annotations
  "form", // PDF form values
];

/** The KNOWN_FEATURES a document uses (fields found anywhere in its pages, masters and document fields). */
export function featuresOf(doc: OmwDocument): string[] {
  const want = new Set(KNOWN_FEATURES);
  const found = new Set<string>();
  const seen = new Set<object>();
  const walk = (v: unknown, depth: number) => {
    if (!v || typeof v !== "object" || seen.has(v) || ArrayBuffer.isView(v) || depth > 40) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined || x === null || (Array.isArray(x) && !x.length)) continue;
      if (want.has(k)) found.add(k);
      if (k !== "tiles" && k !== "pixels") walk(x, depth + 1);
    }
  };
  walk(doc.pages, 0);
  walk(doc.masters, 0);
  return KNOWN_FEATURES.filter((f) => found.has(f));
}

/**
 * What a file holds that this version does not know: features from its manifest, document fields, or a newer graph
 * version. Empty when it is all known.
 */
export function unknownContent(manifestFeatures: unknown, doc: OmwDocument, newer: boolean): string[] {
  const list = Array.isArray(manifestFeatures) ? manifestFeatures.filter((f): f is string => typeof f === "string") : [];
  const out = list.filter((f) => !KNOWN_FEATURES.includes(f));
  for (const k of unknownDocFields(doc)) out.push(k);
  if (newer && !out.length) out.push("version");
  return out;
}
