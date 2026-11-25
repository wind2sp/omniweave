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
import { corner, ellipseContour, rectContour, smooth } from "../core/vector";
import { newVector, type Contour, type VectorAnchor, type VectorNode } from "../core/types";
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

export type ShapeKind = "rect" | "ellipse" | "roundRect" | "polygon" | "star" | "customShape";

interface ShapeParams {
  /** the rounded rectangle's corner radius (px; Illustrator starts at 12 pt) */
  radius: number;
  /** the polygon's sides (Illustrator 6) */
  sides: number;
  /** the star's points (Illustrator 5) and its inner radius as a part of the outer (Illustrator 25 / 50 pt) */
  points: number;
  inner: number;
  /** the custom shape tool's shape (CUSTOM_SHAPES) */
  custom: CustomShapeId;
  set: (p: Partial<Omit<ShapeParams, "set">>) => void;
}
/** The options of the rounded rectangle / polygon / star tools (the ribbon's fields, ↑ ↓ while drawing). */
export const useShapeParams = create<ShapeParams>((set) => ({ radius: 12 * PT, sides: 6, points: 5, inner: 0.5, custom: "heart", set }));

const K = 0.5522847498;
/** A rectangle with round corners of radius `rad` (kept to half the shorter side), clockwise from the top left. */
export function roundRectContour(w: number, h: number, rad: number): Contour {
  const r = Math.max(0, Math.min(rad, Math.abs(w) / 2, Math.abs(h) / 2));
  if (r < 0.01) return rectContour(0, 0, w, h);
  const k = r * K;
  return {
    closed: true,
    nodes: [
      smooth(r, 0, r - k, 0, r, 0), smooth(w - r, 0, w - r, 0, w - r + k, 0),
      smooth(w, r, w, r - k, w, r), smooth(w, h - r, w, h - r, w, h - r + k),
      smooth(w - r, h, w - r + k, h, w - r, h), smooth(r, h, r, h, r - k, h),
      smooth(0, h - r, 0, h - r + k, 0, h - r), smooth(0, r, 0, r, 0, r - k),
    ],
  };
}

/**
 * A regular polygon of `n` sides (or a star of `n` points with the inner radius `inner` × R) inside the circle of
 * radius R around (R, R); `angle` turns it (0 = a point straight up, Illustrator's upright shape).
 */
export function polygonContour(R: number, n: number, star: boolean, inner = 0.5, angle = 0): Contour {
  const m = star ? n * 2 : n;
  const nodes: VectorAnchor[] = [];
  for (let i = 0; i < m; i++) {
    const a = angle - Math.PI / 2 + (i * Math.PI * 2) / m;
    const rr = star && i % 2 ? R * inner : R;
    nodes.push(corner(R + rr * Math.cos(a), R + rr * Math.sin(a)));
  }
  return { closed: true, nodes };
}

/**
 * 사용자 정의 모양 (Photoshop's Custom Shape tool): a few everyday shapes in a unit square, stretched to the box drawn.
 * Corners are [x, y]; curved anchors [x, y, inX, inY, outX, outY].
 */
export const CUSTOM_SHAPES = {
  heart: [[0.5, 1, 0.75, 0.75, 0.25, 0.75], [0, 0.32, 0.05, 0.55, 0, 0.15], [0.25, 0.02, 0.1, 0.02, 0.4, 0.02], [0.5, 0.22], [0.75, 0.02, 0.6, 0.02, 0.9, 0.02], [1, 0.32, 1, 0.15, 0.95, 0.55]],
  arrow: [[0, 0.3], [0.6, 0.3], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.7], [0, 0.7]],
  bubble: [[0, 0], [1, 0], [1, 0.72], [0.45, 0.72], [0.22, 1], [0.26, 0.72], [0, 0.72]],
  check: [[0, 0.55], [0.14, 0.41], [0.38, 0.64], [0.86, 0.1], [1, 0.24], [0.38, 0.92]],
  bolt: [[0.58, 0], [0.12, 0.56], [0.44, 0.56], [0.3, 1], [0.88, 0.4], [0.55, 0.4], [0.78, 0]],
} as const;
export type CustomShapeId = keyof typeof CUSTOM_SHAPES;

export function customShapeContour(id: CustomShapeId, w: number, h: number): Contour {
  const pts = CUSTOM_SHAPES[id] ?? CUSTOM_SHAPES.heart;
  return { closed: true, nodes: pts.map((q) => (q.length === 2 ? corner(q[0] * w, q[1] * h) : smooth(q[0] * w, q[1] * h, q[2] * w, q[3] * h, q[4] * w, q[5] * h))) };
}

const SHAPE_NAME: Record<ShapeKind, string> = { rect: "cmd.insert.rect", ellipse: "cmd.insert.ellipse", roundRect: "shell.name.roundRect", polygon: "shell.name.polygon", star: "shell.name.star", customShape: "shell.name.customShape" };
export const shapeName = (kind: ShapeKind) => (kind === "customShape" ? tr(`shell.name.custom.${useShapeParams.getState().custom}`) : tr(SHAPE_NAME[kind]));

/**
 * A new shape in the rectangle `r` (for the polygon and the star: the square around its circle, `angle` its turn).
 */
export function drawnShape(kind: ShapeKind, r: { x: number; y: number; w: number; h: number }, d: ShapeDefaults, angle = 0): VectorNode {
  const p = useShapeParams.getState();
  const contour =
    kind === "rect" ? rectContour(0, 0, r.w, r.h)
    // the rounded rectangle is a rectangle with live corners (Illustrator's widgets and Corners field change it later)
    : kind === "roundRect" ? rectContour(0, 0, r.w, r.h)
    : kind === "polygon" ? polygonContour(r.w / 2, Math.max(3, p.sides), false, 0, angle)
    : kind === "star" ? polygonContour(r.w / 2, Math.max(3, p.points), true, p.inner, angle)
    : kind === "customShape" ? customShapeContour(p.custom, r.w, r.h)
    : ellipseContour(r.w / 2, r.h / 2, r.w / 2, r.h / 2);
  const v = newVector([contour], shapeName(kind));
  if (kind === "roundRect" && p.radius > 0) v.cornerRadius = p.radius;
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
