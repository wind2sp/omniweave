// Length units, ruler tick spacing and per-page-kind grid defaults (pure; no DOM).
//
// Page space is CSS px (96 per inch). Documents and PDF pages show millimetres by default,
// design / slide pages show pixels.

import type { PageKind } from "./types";

export type Unit = "px" | "mm" | "cm" | "pt" | "in";
export const UNITS: Unit[] = ["px", "mm", "cm", "pt", "in"];
export const UNIT_LABEL: Record<Unit, string> = { px: "픽셀 (px)", mm: "밀리미터 (mm)", cm: "센티미터 (cm)", pt: "포인트 (pt)", in: "인치 (in)" }; // i18n: ui

/** page px per one unit */
export const PX_PER: Record<Unit, number> = { px: 1, mm: 96 / 25.4, cm: 96 / 2.54, pt: 96 / 72, in: 96 };

export const toUnit = (px: number, u: Unit) => px / PX_PER[u];
export const fromUnit = (v: number, u: Unit) => v * PX_PER[u];

export function defaultUnit(kind: PageKind | undefined): Unit {
  return kind === "DOCUMENT" || kind === "PDF" ? "mm" : "px";
}

/** decimals worth showing for a value in this unit */
export function unitDigits(u: Unit): number {
  return u === "px" || u === "pt" ? 1 : u === "mm" ? 1 : 2;
}

/** "12.5 mm" — trailing zeros dropped. */
export function formatLength(px: number, u: Unit, digits = unitDigits(u)): string {
  const v = toUnit(px, u);
  const s = (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits).replace(/\.?0+$/, "");
  return `${s === "-0" ? "0" : s} ${u}`;
}

/** Unit words a person may type, in every UI language (input data, not display text). Keys are lower case. */
const UNIT_ALIASES: Record<string, Unit> = {
  px: "px", pixel: "px", pixels: "px", 픽셀: "px", 像素: "px", ピクセル: "px", // i18n: keep
  mm: "mm", millimeter: "mm", millimeters: "mm", millimetre: "mm", millimetres: "mm", 밀리: "mm", 밀리미터: "mm", 毫米: "mm", ミリ: "mm", ミリメートル: "mm", // i18n: keep
  cm: "cm", centimeter: "cm", centimeters: "cm", centimetre: "cm", centimetres: "cm", 센티: "cm", 센티미터: "cm", 厘米: "cm", 公分: "cm", センチ: "cm", センチメートル: "cm", // i18n: keep
  pt: "pt", point: "pt", points: "pt", 포인트: "pt", 磅: "pt", ポイント: "pt", // i18n: keep
  in: "in", inch: "in", inches: "in", 인치: "in", 英寸: "in", インチ: "in", '"': "in", // i18n: keep
};

/**
 * Parse a length typed by a person: "120", "12.5mm", "3 cm", "-4px", "1,5 in" (comma decimal).
 * A bare number uses `fallback`. Returns page px, or null when it cannot be read.
 */
export function parseLength(text: string, fallback: Unit): number | null {
  const m = /^\s*([+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+))\s*([a-zA-Z가-힣぀-ヿ一-鿿"]*)\s*$/.exec(text); // i18n: keep
  if (!m) return null;
  const v = Number(m[1].replace(",", "."));
  if (!isFinite(v)) return null;
  const suffix = m[2].toLowerCase();
  const u = suffix ? UNIT_ALIASES[suffix] : fallback;
  if (!u) return null;
  return fromUnit(v, u);
}

// ───────── ruler ticks ─────────

export interface RulerSteps {
  /** distance between labelled ticks, page px */
  major: number;
  /** subdivisions between labelled ticks */
  sub: number;
  /** labelled step expressed in the unit (for labels) */
  unitStep: number;
}

/**
 * Pick a 1-2-5 step in the unit so labelled ticks are at least `minGap` screen px apart, and
 * as many subdivisions (10 / 5 / 4 / 2) as fit with ≥ `minSubGap` screen px between them.
 */
export function rulerSteps(zoom: number, u: Unit, minGap = 56, minSubGap = 5): RulerSteps {
  const pxPerUnitScreen = Math.max(1e-9, zoom * PX_PER[u]);
  const target = minGap / pxPerUnitScreen;
  const exp = Math.floor(Math.log10(target));
  let unitStep = 10 ** exp;
  for (const m of [1, 2, 5, 10]) {
    if (m * 10 ** exp >= target - 1e-12) {
      unitStep = m * 10 ** exp;
      break;
    }
  }
  const lead = Math.round(unitStep / 10 ** Math.floor(Math.log10(unitStep) + 1e-9));
  const options = lead === 2 ? [4, 2, 1] : lead === 5 ? [5, 1] : [10, 5, 2, 1];
  const majorScreen = unitStep * pxPerUnitScreen;
  const sub = options.find((s) => majorScreen / s >= minSubGap) ?? 1;
  return { major: unitStep * PX_PER[u], sub, unitStep };
}

export interface Tick {
  /** page px */
  pos: number;
  major: boolean;
  label?: string;
}

/** Ticks covering [start, end] (page px) for the given steps; labels are in the unit, relative to 0. */
export function rulerTicks(start: number, end: number, steps: RulerSteps, maxTicks = 4000): Tick[] {
  const out: Tick[] = [];
  const minor = steps.major / steps.sub;
  if (!(minor > 0) || !isFinite(start) || !isFinite(end) || end <= start) return out;
  const i0 = Math.floor(start / minor), i1 = Math.ceil(end / minor);
  if (i1 - i0 > maxTicks) return out;
  const decimals = Math.max(0, -Math.floor(Math.log10(steps.unitStep) + 1e-9));
  for (let i = i0; i <= i1; i++) {
    const pos = i * minor;
    const major = i % steps.sub === 0;
    const t: Tick = { pos, major };
    if (major) {
      const v = (i / steps.sub) * steps.unitStep;
      t.label = (Math.abs(v) < 1e-9 ? 0 : v).toFixed(decimals);
    }
    out.push(t);
  }
  return out;
}

// ───────── grid ─────────

export interface GridSpec {
  /** major line spacing, page px */
  size: number;
  /** subdivisions per major cell (1 = no minor lines) */
  sub: number;
}

/** Grid defaults per page kind: 10 mm / 2 for documents and PDF, 40 px / 4 for slides, 80 px / 4 for design. */
export function defaultGrid(kind: PageKind | undefined): GridSpec {
  switch (kind) {
    case "DOCUMENT":
    case "PDF":
      return { size: fromUnit(10, "mm"), sub: 2 };
    case "SLIDE":
    case "MASTER":
      return { size: 40, sub: 4 };
    default:
      return { size: 80, sub: 4 };
  }
}

/** Grid lines worth painting: the minor spacing is dropped when it would be denser than `minGap` screen px. */
export function visibleGridStep(g: GridSpec, zoom: number, minGap = 6): { step: number; every: number } | null {
  const minor = g.size / Math.max(1, g.sub);
  if (minor * zoom >= minGap) return { step: minor, every: Math.max(1, g.sub) };
  if (g.size * zoom >= minGap) return { step: g.size, every: 1 };
  return null;
}
