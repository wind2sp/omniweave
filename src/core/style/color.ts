// Colour (design ch. 4.2): sRGB for display + the original components (CMYK, gray, Lab, spot, theme / swatch ref).
// Legacy node fields are hex strings; colorOf() reads both, legacyColor() writes a Color back as the string the old
// fields hold. Colour management is "preserve the original values" for now (no ICC conversion): the display hex of
// a CMYK / Lab colour is a plain formula, the original components ride along untouched.

import type { Color } from "./types";

export interface Rgba {
  r: number; // 0..255
  g: number;
  b: number;
  a: number; // 0..1
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const byte = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex2 = (v: number) => byte(v).toString(16).padStart(2, "0");

/** "#rgb" "#rgba" "#rrggbb" "#rrggbbaa" "rgb(…)" "rgba(…)" "transparent" → RGBA; null when not a colour we read. */
export function parseColor(s: string | null | undefined): Rgba | null {
  if (!s) return null;
  const t = s.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(t);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split("").map((x) => x + x).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
  }
  if (/^transparent$/i.test(t)) return { r: 0, g: 0, b: 0, a: 0 };
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(t);
  if (m) return { r: byte(+m[1]), g: byte(+m[2]), b: byte(+m[3]), a: m[4] === undefined ? 1 : clamp01(+m[4]) };
  return null;
}

export const rgbHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

/** A display colour. Alpha 1 is omitted (default-valued fields are never written). */
export function rgbColor(r: number, g: number, b: number, a = 1): Color {
  const c: Color = { hex: rgbHex(r, g, b) };
  if (a < 1) c.a = clamp01(a);
  return c;
}

/**
 * Legacy string or Color → Color (null for "none" / unreadable). A 6-digit hex keeps its letter case, so
 * colorOf → legacyColor gives back the very same string (no hash churn when old fields are written again).
 */
export function colorOf(x: string | Color | null | undefined): Color | null {
  if (x == null) return null;
  if (typeof x !== "string") return x;
  const t = x.trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return { hex: t };
  if (/^#[0-9a-f]{8}$/i.test(t)) {
    const a = parseInt(t.slice(7, 9), 16) / 255;
    return a < 1 ? { hex: t.slice(0, 7), a } : { hex: t.slice(0, 7) };
  }
  const p = parseColor(t);
  return p ? rgbColor(p.r, p.g, p.b, p.a) : null;
}

/** Color → the hex string the legacy node fields hold ("#rrggbb", or "#rrggbbaa" with alpha). */
export function legacyColor(c: Color | null | undefined): string | null {
  if (!c) return null;
  if (c.a === undefined || c.a >= 1) return c.hex;
  const aa = hex2(clamp01(c.a) * 255);
  return c.hex + (/[A-F]/.test(c.hex) ? aa.toUpperCase() : aa);
}

export function rgbaOf(c: Color): Rgba {
  const p = parseColor(c.hex) ?? { r: 0, g: 0, b: 0, a: 1 };
  return { r: p.r, g: p.g, b: p.b, a: c.a ?? 1 };
}

/** CSS colour for Canvas / SVG / HTML. */
export function cssColor(c: Color): string {
  const a = c.a ?? 1;
  if (a >= 1) return c.hex;
  const { r, g, b } = rgbaOf(c);
  return `rgba(${r},${g},${b},${+a.toFixed(4)})`;
}

/** Same colour with another alpha (1 → field omitted). */
export function withAlpha(c: Color, a: number): Color {
  const { a: _old, ...rest } = c;
  return a < 1 ? { ...rest, a: clamp01(a) } : rest;
}

/**
 * Canonical form: lowercase hex, default fields dropped, keys in a fixed order. Equal colours have equal canonical
 * forms, so fingerprints do not depend on how a file spelled a colour.
 */
export function normalizeColor(c: Color): Color {
  const out: Color = { hex: c.hex.toLowerCase() };
  if (c.a !== undefined && c.a < 1) out.a = clamp01(c.a);
  if (c.space && c.space !== "rgb") out.space = c.space;
  if (c.v && c.v.length) out.v = [...c.v];
  if (c.spot) out.spot = { name: c.spot.name, tint: c.spot.tint };
  if (c.ref) out.ref = "theme" in c.ref ? (c.ref.mods && Object.keys(c.ref.mods).length ? { theme: c.ref.theme, mods: sortKeys(c.ref.mods) } : { theme: c.ref.theme }) : { swatch: c.ref.swatch };
  if (c.replay) out.replay = c.replay;
  return out;
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  const r: Record<string, T> = {};
  for (const k of Object.keys(o).sort()) r[k] = o[k];
  return r;
}

/** Same colour (hex case ignored; original components, references and alpha must match). */
export function colorEq(a: Color | null | undefined, b: Color | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return JSON.stringify(normalizeColor(a)) === JSON.stringify(normalizeColor(b));
}

// ───────── original colour spaces → display sRGB (no ICC: plain formulas, components kept) ─────────

/** Naive CMYK (0..1) → sRGB, the same formula the PDF interpreter uses for DeviceCMYK. */
export function cmykColor(c: number, m: number, y: number, k: number): Color {
  const r = 255 * (1 - c) * (1 - k), g = 255 * (1 - m) * (1 - k), b = 255 * (1 - y) * (1 - k);
  return { hex: rgbHex(r, g, b), space: "cmyk", v: [c, m, y, k] };
}

export function grayColor(g: number): Color {
  return { hex: rgbHex(g * 255, g * 255, g * 255), space: "gray", v: [g] };
}

/** CIE L*a*b* (D50, as PDF / PS use) → sRGB via Bradford-adapted D65. */
export function labColor(L: number, a: number, b: number): Color {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (f: number) => (f ** 3 > 0.008856 ? f ** 3 : (116 * f - 16) / 903.3);
  // D50 white
  const X = 0.9642 * inv(fx), Y = 1 * (L > 8 ? fy ** 3 : L / 903.3), Z = 0.8249 * inv(fz);
  // D50 → linear sRGB (Bradford-adapted matrix)
  const lr = 3.1338561 * X - 1.6168667 * Y - 0.4906146 * Z;
  const lg = -0.9787684 * X + 1.9161415 * Y + 0.033454 * Z;
  const lb = 0.0719453 * X - 0.2289914 * Y + 1.4052427 * Z;
  const gam = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
  return { hex: rgbHex(gam(lr), gam(lg), gam(lb)), space: "lab", v: [L, a, b] };
}

/** Spot (separation) colour: its alternate-space display colour plus name and tint. */
export function spotColor(name: string, tint: number, display: Color): Color {
  return { ...display, space: "spot", spot: { name, tint } };
}

// ───────── HSV (colour picker) ─────────

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s: max ? d / max : 0, v: max };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255) };
}
