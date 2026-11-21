// New objects drawn with the rect, ellipse, line and pen tools: one place that applies the ribbon's "new shape"
// defaults (store fill / stroke colour, useShapeStroke width / none), so every drawing tool starts from the same look.
//
// The defaults follow the edit mode, each the way its own program starts (2026-11-13 제품 결정: "선두께나 도형색이 너무
// 두껍고 칙칙하다 — 일러스트레이터를 참고"):
//   design   Illustrator — white fill, black 1 pt stroke; pen paths no fill + 1 pt black stroke
//   slides   PowerPoint  — theme accent 1 fill with a darker 1 pt outline of the same hue (also documents: Word)
//   image    Photoshop   — shape layers filled with the foreground colour, no stroke; px
// What the viewer changes in a mode is kept for that mode during the session. Line ends stay round — the one quiet
// Omniweave touch in the drawing itself (a thread's end), never a brand colour on the shapes.
import { create } from "zustand";
import { ellipseContour, rectContour } from "../core/vector";
import { newVector, type VectorAnchor, type VectorNode } from "../core/types";
import { useStore } from "../core/store";
import { t as tr } from "../i18n";

/** 1 pt in page px (96 dpi). */
export const PT = 4 / 3;

export interface ShapeDefaults {
  fill: string;
  /** colour of the ribbon's "new shape" stroke (kept while it is set to none, for open pen paths) */
  stroke: string;
  /** the ribbon's "new shape" stroke is set to none; read from useShapeStroke when not given */
  strokeNone?: boolean;
  /** stroke width in px; read from useShapeStroke when not given */
  strokeWidth?: number;
}

interface ShapeStroke {
  /** new rectangles / ellipses get no stroke */
  none: boolean;
  /** stroke width of new shapes, lines and pen paths (px) */
  width: number;
  /** a closed pen path gets the fill (PowerPoint freeform, Photoshop shape) or stays unfilled (Illustrator default here) */
  penFill: boolean;
  setNone: (none: boolean) => void;
  set: (p: Partial<Omit<ShapeStroke, "set" | "setNone">>) => void;
}

/** The ribbon's "new shape" stroke on / off and width (the colour itself is the store's `stroke`). */
export const useShapeStroke = create<ShapeStroke>((set) => ({
  none: true,
  width: PT,
  penFill: true,
  setNone: (none) => set({ none }),
  set,
}));

const strokeOf = (d: ShapeDefaults) => ((d.strokeNone ?? useShapeStroke.getState().none) ? null : d.stroke);
const widthOf = (d: ShapeDefaults) => d.strokeWidth ?? useShapeStroke.getState().width;

export function drawnShape(kind: "rect" | "ellipse", r: { x: number; y: number; w: number; h: number }, d: ShapeDefaults): VectorNode {
  const contour = kind === "rect" ? rectContour(0, 0, r.w, r.h) : ellipseContour(r.w / 2, r.h / 2, r.w / 2, r.h / 2);
  const v = newVector([contour], kind === "rect" ? tr("cmd.insert.rect") : tr("cmd.insert.ellipse"));
  v.fill = d.fill;
  v.stroke = strokeOf(d);
  v.strokeWidth = widthOf(d);
  v.transform = { x: r.x, y: r.y, rotation: 0, scale: 1 };
  return v;
}

export function drawnPenPath(nodes: VectorAnchor[], closed: boolean, d: ShapeDefaults): VectorNode {
  const v = newVector([{ nodes, closed }], closed ? tr("shell.name.path") : tr("shell.name.line"));
  v.fill = closed && useShapeStroke.getState().penFill ? d.fill : null;
  v.stroke = d.stroke;
  v.strokeWidth = widthOf(d);
  return v;
}

// ───────── per edit mode ─────────

type ModeId = "DOCUMENT" | "SLIDE" | "IMAGE" | "DESIGN";
interface ModeShape {
  fill: string;
  stroke: string;
  none: boolean;
  width: number;
  penFill: boolean;
}

/** Office's accent 1 (2013–2022 theme), when the document has no theme of its own. */
const OFFICE_ACCENT = "#4472c4";

/** A colour mixed toward black (PowerPoint's outline of a theme fill is the same hue, darker). */
export function darker(hex: string, k = 0.7): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  const c = (s: number) => Math.round(((v >> s) & 255) * k).toString(16).padStart(2, "0");
  return `#${c(16)}${c(8)}${c(0)}`;
}

/** The theme's accent 1 of the open document (PPTX / DOCX theme), else Office's. */
function themeAccent(): string {
  const doc = useStore.getState().doc as { theme?: { colors?: Record<string, { hex?: string }> } };
  const c = doc.theme?.colors;
  return c?.accent1?.hex ?? c?.accent1Color?.hex ?? OFFICE_ACCENT;
}

/** The program's own defaults for new shapes in an edit mode. `fg` = the image mode's foreground colour. */
export function modeShapeDefaults(mode: ModeId, fg = "#000000"): ModeShape {
  switch (mode) {
    case "DESIGN":
      return { fill: "#ffffff", stroke: "#000000", none: false, width: PT, penFill: false };
    case "IMAGE":
      return { fill: fg, stroke: fg, none: true, width: 1, penFill: true };
    default: {
      const a = themeAccent();
      return { fill: a, stroke: darker(a), none: false, width: PT, penFill: true };
    }
  }
}

const kept = new Map<ModeId, ModeShape>();

/** Edit mode changed (editModes followMode): keep what the viewer set in the old mode, load the new mode's. */
export function switchShapeDefaults(prev: ModeId | null, next: ModeId, fg?: string) {
  const s = useStore.getState();
  const st = useShapeStroke.getState();
  if (prev) kept.set(prev, { fill: s.fill, stroke: s.stroke, none: st.none, width: st.width, penFill: st.penFill });
  const d = kept.get(next) ?? modeShapeDefaults(next, fg);
  s.set({ fill: d.fill, stroke: d.stroke });
  st.set({ none: d.none, width: d.width, penFill: d.penFill });
}

// ───────── Omniweave swatches ─────────

/**
 * The swatch row in front of the colour fields: the three threads of the logo (violet · teal · coral, the visual
 * design tokens --brand-violet / --brand-teal / --brand-coral) and ink, then plain white and black.
 */
export const OME_SWATCHES: { hex: string; key: string }[] = [
  { hex: "#7c5cff", key: "violet" },
  { hex: "#22d3c5", key: "teal" },
  { hex: "#ff6b81", key: "coral" },
  { hex: "#1c1830", key: "ink" },
  { hex: "#ffffff", key: "white" },
  { hex: "#000000", key: "black" },
];
