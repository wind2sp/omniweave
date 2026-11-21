// Capability table (design ch. 4.1 rule 5, ch. 10 rule 2): for every style property and every save format, what
// happens to the property when the document is saved in that format —
//   native     written in the format's own structure and read back the same,
//   approx     written in the format's own structure, nearest value (unit rounding, a mode the format lacks…),
//   rasterize  the object is written as a picture (looks the same, no longer editable there),
//   drop       not written (the object or the property is lost).
// Export warnings, UI badges and the round-trip test matrix (tests/style/matrix.test.ts) all read this table, so
// it must say what the exporters really do today; the matrix test fails when a "native" claim stops being true.
// Phase A lists the properties the model holds today; every new property adds its row here (design ch. 10).

import type { NodeType, Page, SceneNode } from "../types";
import { blendDef } from "./blend";
import type { StyleBundle } from "./fingerprint";
import type { EffectType } from "./types";

export type CapLevel = "native" | "approx" | "rasterize" | "drop";

/** Save formats the table covers: the six programs' formats, plus Excel, SVG and PNG. */
export const CAP_FORMATS = ["psd", "pdf", "ai", "pptx", "docx", "hwpx", "xlsx", "svg", "png"] as const;
export type CapFormat = (typeof CAP_FORMATS)[number];

const LEVEL: Record<string, CapLevel> = { N: "native", A: "approx", R: "rasterize", D: "drop" };

export interface CapProp {
  id: string;
  /** fingerprint bundle the property belongs to (fingerprint.ts) */
  bundle: StyleBundle | "node";
  /** node kinds that can carry it */
  nodes: readonly NodeType[];
  /** levels in CAP_FORMATS order: N native, A approx, R rasterize, D drop */
  row: string;
  /**
   * Formats whose writer stores the property natively but whose Omniweave reader does not read it back yet (the
   * file is right in the other program; reopening here loses it). The round-trip matrix expects the loss, so fixing
   * the reader makes the test fail until the entry is removed.
   */
  readGap?: readonly CapFormat[];
  /** per node kind overrides: kind → row */
  byNode?: Partial<Record<NodeType, string>>;
  /** the node uses the property with a non-default value */
  detect: (n: SceneNode) => boolean;
}

const ALL: NodeType[] = ["RASTER", "VECTOR", "TEXT", "IMAGE", "PDF", "TABLE", "MEDIA"];
const runs = (n: SceneNode) => (n.type === "TEXT" ? n.paragraphs.flatMap((p) => p.runs) : []);
const paras = (n: SceneNode) => (n.type === "TEXT" ? n.paragraphs : []);
const cells = (n: SceneNode) => (n.type === "TABLE" ? n.rows.flat() : []);
const kind = (k: NodeType, row: string): CapProp => ({ id: `node.${k}`, bundle: "node", nodes: [k], row, detect: (n) => n.type === k });
const fx = (type: EffectType, row: string, byNode?: Partial<Record<NodeType, string>>): CapProp => ({
  id: `fx.${type}`,
  bundle: "effects",
  nodes: ALL,
  row,
  ...(byNode ? { byNode } : {}),
  detect: (n) => !!n.effects?.some((e) => e.on && e.type === type),
});

//                                       psd pdf ai pptx docx hwpx xlsx svg png
export const CAP_PROPS: readonly CapProp[] = [
  // node kinds: whether the object itself survives (a dropped kind makes its other properties moot)
  kind("RASTER", /*                   */ "NNNRDDDNN"),
  kind("VECTOR", /*                   */ "RNNNDDDNN"),
  kind("TEXT", /*                     */ "RNNNNNDNN"),
  kind("IMAGE", /*                    */ "RNNNDDDNN"),
  kind("PDF", /*                      */ "RNNRDDDRN"),
  kind("TABLE", /*                    */ "RNNNNNNRN"),
  kind("MEDIA", /*                    */ "RAANDDDRN"),

  // appearance
  {
    id: "fill.solid", bundle: "fills", nodes: ["VECTOR", "TEXT", "TABLE"], row: "RNNNNNDNN",
    // vectors and text-frame backgrounds are not written by the flow exporters (DOCX / HWPX); XLSX keeps no cell fill
    byNode: { VECTOR: "RNNNDDDNN", TEXT: "RNNNDDDNN" },
    detect: (n) => (n.type === "VECTOR" ? n.fill != null : n.type === "TEXT" ? n.background != null : n.type === "TABLE" ? cells(n).some((c) => c.fill != null) : false),
  },
  { id: "stroke.solid", bundle: "strokes", nodes: ["VECTOR"], row: "RNNNDDDNN", detect: (n) => n.type === "VECTOR" && n.stroke != null && n.strokeWidth > 0 },
  { id: "opacity", bundle: "blend", nodes: ALL, row: "NNNDDDDNN", detect: (n) => n.opacity < 1 },
  // SVG writes mix-blend-mode only on pages with groups / clipping (export.ts), hence approx
  { id: "blend", bundle: "blend", nodes: ALL, row: "NNNDDDDAN", detect: (n) => n.blendMode !== "NORMAL" && blendDef(n.blendMode)?.pdf != null },
  // Photoshop-only modes (linear burn / dodge, vivid / linear / pin light, hard mix, subtract, divide, darker / lighter
  // colour, dissolve): PDF / AI / SVG have no such mode and write Normal
  { id: "blend.photoshop", bundle: "blend", nodes: ALL, row: "NAADDDDDN", detect: (n) => n.blendMode !== "NORMAL" && blendDef(n.blendMode)?.pdf == null },
  // PPTX: a clip stack becomes a picture, except a picture clipped by one plain shape ("crop to shape")
  { id: "clip", bundle: "blend", nodes: ALL, row: "NNNRDDDNN", detect: (n) => !!n.clip },
  // PPTX: neutral groups are flattened (same look, no folder), others become pictures
  { id: "group", bundle: "blend", nodes: ALL, row: "NNNADDDNN", detect: (n) => !!n.groupId },
  { id: "crop", bundle: "geom", nodes: ["RASTER", "IMAGE", "PDF"], row: "RNNNDDDNN", byNode: { RASTER: "RNNRDDDRN", PDF: "RNNRDDDRN" }, detect: (n) => (n.type === "RASTER" || n.type === "IMAGE" || n.type === "PDF") && !!n.crop },
  { id: "transform.rotate", bundle: "geom", nodes: ALL, row: "RNNNDDDNN", detect: (n) => n.transform.rotation % 360 !== 0 },
  // PPTX writes flipH / flipV, but the PPTX reader does not read them back on shapes yet
  { id: "transform.flip", bundle: "geom", nodes: ALL, row: "RNNNDDDNN", readGap: ["pptx"], detect: (n) => n.transform.scale < 0 || (n.transform.scaleY ?? n.transform.scale) < 0 },

  // layer effects (Photoshop layer style is the reference). PSD: lfx2 as Photoshop writes it. PDF / AI: drawn as a
  // picture with transparency under / over the live content (text stays text). PPTX: a:effectLst (outerShdw,
  // innerShdw, glow, softEdge — blur and spread are approximate); effects DrawingML lacks turn the object into a
  // picture. DOCX: a text box's drop shadow is written as Word's character shadow w:shadow (on / off only), which
  // the DOCX reader does not turn back into an effect — counted as lost there. SVG: filter primitives. PNG: drawn.
  fx("dropShadow", /*                 */ "NAAADDDAN", { RASTER: "NAARDDDAN" }),
  fx("innerShadow", /*                */ "NAAADDDAN", { RASTER: "NAARDDDAN" }),
  fx("outerGlow", /*                  */ "NAAADDDAN", { RASTER: "NAARDDDAN" }),
  fx("innerGlow", /*                  */ "NAARDDDAN"),
  fx("fxStroke", /*                   */ "NAARDDDAN"),
  fx("overlay", /*                    */ "NAARDDDAN"),
  // Photoshop has no soft edge: not written there
  fx("softEdge", /*                   */ "DAANDDDAN", { RASTER: "DAARDDDAN" }),
  // kept and written back to PSD; not drawn yet (no renderer), so every other format loses them (PNG shows what the
  // screen shows: the same look)
  fx("bevel", /*                      */ "NDDDDDDDN"),
  fx("satin", /*                      */ "NDDDDDDDN"),

  // characters (TEXT runs)
  { id: "text.font", bundle: "text", nodes: ["TEXT"], row: "RAANNNDNN", detect: (n) => runs(n).length > 0 },
  { id: "text.size", bundle: "text", nodes: ["TEXT"], row: "RNNNANDNN", detect: (n) => runs(n).length > 0 },
  { id: "text.color", bundle: "text", nodes: ["TEXT"], row: "RNNNNNDNN", detect: (n) => runs(n).length > 0 },
  { id: "text.bold", bundle: "text", nodes: ["TEXT"], row: "RANNNNDNN", detect: (n) => runs(n).some((r) => r.bold) },
  { id: "text.italic", bundle: "text", nodes: ["TEXT"], row: "RAANNNDNN", detect: (n) => runs(n).some((r) => r.italic) },
  { id: "text.underline", bundle: "text", nodes: ["TEXT"], row: "RAANNNDNN", detect: (n) => runs(n).some((r) => r.underline) },
  { id: "text.strike", bundle: "text", nodes: ["TEXT"], row: "RAANNNDDN", detect: (n) => runs(n).some((r) => !!r.strike) },
  { id: "text.script", bundle: "text", nodes: ["TEXT"], row: "RAANNNDDN", detect: (n) => runs(n).some((r) => !!r.script) },
  { id: "text.highlight", bundle: "text", nodes: ["TEXT"], row: "RAANANDDN", detect: (n) => runs(n).some((r) => !!r.highlight) },
  { id: "text.tracking", bundle: "text", nodes: ["TEXT"], row: "RNNNAADDN", detect: (n) => runs(n).some((r) => !!r.letterSpacing) },
  // 장평: PDF text matrix, Word w:w, HWPX ratio; DrawingML has no character width scale
  { id: "text.hscale", bundle: "text", nodes: ["TEXT"], row: "RNNDNNDDN", detect: (n) => runs(n).some((r) => (r.hscale ?? 100) !== 100) },
  // 한글 자간 (% of each character's advance): HWPX native; Word / PPTX take one absolute spacing per run
  { id: "text.spacingPct", bundle: "text", nodes: ["TEXT"], row: "RNNAANDDN", detect: (n) => runs(n).some((r) => !!r.spacingPct) },

  // paragraphs
  { id: "para.align", bundle: "text", nodes: ["TEXT"], row: "RAANNNDAN", detect: (n) => paras(n).some((p) => p.align !== "LEFT") },
  { id: "para.lineSpacing", bundle: "text", nodes: ["TEXT"], row: "RAAAANDAN", detect: (n) => paras(n).length > 0 },
  { id: "para.indent", bundle: "text", nodes: ["TEXT"], row: "RAADNNDAN", detect: (n) => paras(n).some((p) => !!p.indent || !!p.indentLeft) },
  { id: "para.spaceAfter", bundle: "text", nodes: ["TEXT"], row: "RAANANDAN", detect: (n) => paras(n).some((p) => p.spaceAfter > 0) },
  { id: "para.list", bundle: "text", nodes: ["TEXT"], row: "RAADNNDAN", detect: (n) => paras(n).some((p) => p.role === "li" || p.role === "oli") },
  { id: "para.spaceBefore", bundle: "text", nodes: ["TEXT"], row: "RAANANDAN", detect: (n) => paras(n).some((p) => !!p.spaceBefore) },
  { id: "para.indentRight", bundle: "text", nodes: ["TEXT"], row: "RAADNNDAN", detect: (n) => paras(n).some((p) => !!p.indentRight) },
  // exact / at-least / gap-only line heights: Word and 한글 keep them (Word has no gap-only: exact), PPTX gets the multiple
  { id: "para.lineHeight", bundle: "text", nodes: ["TEXT"], row: "RAAANNDAN", detect: (n) => paras(n).some((p) => !!p.lineHeight) },
  // keep with next / keep lines / page break before: pagination flags of the word processors
  { id: "para.keep", bundle: "text", nodes: ["TEXT"], row: "DDDDNNDDN", detect: (n) => paras(n).some((p) => !!(p.keepNext || p.keepLines || p.pageBreakBefore)) },
  // multi-level lists: level and number format (PPTX: lvl + buAutoNum scheme / buChar)
  { id: "para.listLevel", bundle: "text", nodes: ["TEXT"], row: "RAANNNDAN", detect: (n) => paras(n).some((p) => !!p.list) },

  // tables
  { id: "table.merge", bundle: "geom", nodes: ["TABLE"], row: "RNNDNNDRN", detect: (n) => cells(n).some((c) => (c.colSpan ?? 1) > 1 || (c.rowSpan ?? 1) > 1) },
  { id: "table.cellFormat", bundle: "text", nodes: ["TABLE"], row: "RNNNNNARN", detect: (n) => cells(n).some((c) => c.bold || c.italic || !!c.color || (!!c.align && c.align !== "LEFT")) },
  { id: "table.formula", bundle: "text", nodes: ["TABLE"], row: "RDDDDDNDD", detect: (n) => cells(n).some((c) => !!c.formula) },
  { id: "table.numFmt", bundle: "text", nodes: ["TABLE"], row: "RDDDDDNDD", detect: (n) => cells(n).some((c) => !!c.numFmt) },
];

const BY_ID = new Map(CAP_PROPS.map((p) => [p.id, p]));
export const capProp = (id: string) => BY_ID.get(id);

/** What saving in `fmt` does to property `prop` (on a node of kind `node`, when given). Unknown → drop. */
export function capOf(prop: string, fmt: CapFormat, node?: NodeType): CapLevel {
  const p = BY_ID.get(prop);
  if (!p) return "drop";
  const row = (node && p.byNode?.[node]) || p.row;
  return LEVEL[row[CAP_FORMATS.indexOf(fmt)]] ?? "drop";
}

/** Formats where `prop` is at least `atLeast` (native ⊂ approx). */
export function formatsWith(prop: string, levels: readonly CapLevel[] = ["native"]): CapFormat[] {
  return CAP_FORMATS.filter((f) => levels.includes(capOf(prop, f)));
}

export interface CapIssue {
  pageId: string;
  nodeId: string;
  prop: string;
  level: Exclude<CapLevel, "native">;
}

/**
 * What saving `pages` in `fmt` would change — the list an export shows before writing (design ch. 5 "honest
 * fallback"). A node whose kind is rasterised or dropped reports that once, not each of its properties.
 */
export function exportIssues(pages: readonly Page[], fmt: CapFormat): CapIssue[] {
  const out: CapIssue[] = [];
  for (const pg of pages)
    for (const n of pg.nodes) {
      if (!n.visible) continue;
      const k = capOf(`node.${n.type}`, fmt);
      if (k !== "native") {
        out.push({ pageId: pg.id, nodeId: n.id, prop: `node.${n.type}`, level: k });
        if (k === "drop" || k === "rasterize") continue;
      }
      for (const p of CAP_PROPS) {
        if (p.bundle === "node" || !p.nodes.includes(n.type) || !p.detect(n)) continue;
        const l = capOf(p.id, fmt, n.type);
        if (l !== "native") out.push({ pageId: pg.id, nodeId: n.id, prop: p.id, level: l });
      }
    }
  return out;
}

/** Issues grouped by property and level with node counts (for a short warning list). */
export function summarizeIssues(issues: readonly CapIssue[]): { prop: string; level: CapIssue["level"]; count: number }[] {
  const m = new Map<string, { prop: string; level: CapIssue["level"]; count: number }>();
  for (const i of issues) {
    const k = `${i.prop}|${i.level}`;
    const e = m.get(k);
    if (e) e.count++;
    else m.set(k, { prop: i.prop, level: i.level, count: 1 });
  }
  return [...m.values()];
}

/** The whole table as rows of levels (the "property × format" matrix of design ch. 3, generated). */
export function capsMatrix(): { prop: string; levels: Record<CapFormat, CapLevel> }[] {
  return CAP_PROPS.map((p) => ({ prop: p.id, levels: Object.fromEntries(CAP_FORMATS.map((f) => [f, capOf(p.id, f)])) as Record<CapFormat, CapLevel> }));
}
