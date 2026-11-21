// DrawingML colours (ECMA-376 Part 1 §20.1.2.3): srgbClr / schemeClr / sysClr / prstClr with their modifiers
// (lumMod lumOff tint shade alpha), resolved against a workbook theme. Shared by the sheet drawing reader
// (io/sheet/drawings.ts) and the chart painter (render/sheetChart.ts).

import { attr, children } from "../xml";

const PRESET: Record<string, string> = { black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", yellow: "FFFF00", gray: "808080", grey: "808080", orange: "FFA500", darkGray: "A9A9A9", lightGray: "D3D3D3" };
/** theme array order (read.ts themeColors): lt1 dk1 lt2 dk2 accent1–6 hlink folHlink */
const SCHEME: Record<string, number> = { bg1: 0, lt1: 0, tx1: 1, dk1: 1, bg2: 2, lt2: 2, tx2: 3, dk2: 3, accent1: 4, accent2: 5, accent3: 6, accent4: 7, accent5: 8, accent6: 9, hlink: 10, folHlink: 11 };

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function fromHsl(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t: number) => {
    t = (t + 1) % 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/** A hex colour (6 digits, no #) with DrawingML modifiers applied → "#rrggbb" or "rgba(…)". */
export function modColor(hex: string, mods: { name: string; val: number }[]): string {
  let r = parseInt(hex.slice(0, 2), 16) / 255, g = parseInt(hex.slice(2, 4), 16) / 255, b = parseInt(hex.slice(4, 6), 16) / 255;
  let a = 1;
  for (const m of mods) {
    const v = m.val / 100000;
    if (m.name === "lumMod" || m.name === "lumOff") {
      const [h, s, l] = toHsl(r, g, b);
      const l2 = m.name === "lumMod" ? l * v : l + v;
      [r, g, b] = fromHsl(h, s, Math.min(1, Math.max(0, l2)));
    } else if (m.name === "shade") [r, g, b] = [r * v, g * v, b * v];
    else if (m.name === "tint") [r, g, b] = [r + (1 - r) * (1 - v), g + (1 - g) * (1 - v), b + (1 - b) * (1 - v)];
    else if (m.name === "alpha") a = v;
  }
  const hx = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, "0");
  return a < 1 ? `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})` : `#${hx(r)}${hx(g)}${hx(b)}`;
}

/** The colour of a colour-choice element (srgbClr / schemeClr / sysClr / prstClr) — or of its parent's first such child. */
export function dmlColor(el: Element | undefined, theme: string[], phClr?: string): string | null {
  if (!el) return null;
  const c = /^(srgbClr|schemeClr|sysClr|prstClr|scrgbClr|hslClr)$/.test(el.localName) ? el : children(el).find((x) => /^(srgbClr|schemeClr|sysClr|prstClr)$/.test(x.localName));
  if (!c) return null;
  let hex: string | undefined;
  const val = attr(c, "val") ?? "";
  if (c.localName === "srgbClr") hex = val;
  else if (c.localName === "sysClr") hex = attr(c, "lastClr") ?? (val === "window" ? "FFFFFF" : "000000");
  else if (c.localName === "prstClr") hex = PRESET[val];
  else if (c.localName === "schemeClr") hex = val === "phClr" ? phClr?.replace(/^#/, "") : theme[SCHEME[val] ?? 1];
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return null;
  const mods = children(c).map((m) => ({ name: m.localName, val: Number(attr(m, "val") ?? 100000) }));
  return modColor(hex, mods);
}
