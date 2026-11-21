// AutoCAD Color Index (ACI) 1..255 → RGB, generated from the index's structure rather than stored as a table:
// 1–9 are the named colours, 10–249 run in 24 hues (15° apart) × 5 brightness steps × (full | half saturation),
// 250–255 are greys. Colour 7 is "white on a dark background, black on paper": on Omniweave's white page it is black.

const NAMED: number[] = [0x000000, 0xff0000, 0xffff00, 0x00ff00, 0x00ffff, 0x0000ff, 0xff00ff, 0xffffff, 0x808080, 0xc0c0c0];
const GREYS = [0x33, 0x50, 0x69, 0x82, 0xbe, 0xff];
const BRIGHT = [1, 0.65, 0.5, 0.3, 0.15];

let table: number[] | null = null;

function build(): number[] {
  const t = NAMED.slice();
  for (let i = 10; i <= 249; i++) {
    const hue = (Math.floor(i / 10) - 1) * 15;
    const j = i % 10;
    const v = BRIGHT[j >> 1];
    const pastel = j & 1;
    // HSV hue → channel fractions at full saturation and value
    const ch = (n: number) => {
      const k = (n + hue / 60) % 6;
      return 1 - Math.max(0, Math.min(k, 4 - k, 1));
    };
    const rgb = [ch(5), ch(3), ch(1)].map((c) => Math.floor(255 * v * (pastel ? 1 - 0.5 * (1 - c) : c)));
    t.push((rgb[0] << 16) | (rgb[1] << 8) | rgb[2]);
  }
  for (const g of GREYS) t.push((g << 16) | (g << 8) | g);
  return t;
}

/** RGB (0xRRGGBB) of ACI 1..255; 7 = black on paper. Unknown → black. */
export function aciRgb(aci: number): number {
  if (aci === 7) return 0x000000;
  table ??= build();
  return table[Math.abs(aci)] ?? 0;
}

export const hex = (rgb: number) => "#" + (rgb & 0xffffff).toString(16).padStart(6, "0");

/** Colour as CSS hex; white (255,255,255 true colour or ACI 255) also prints black on a white page, as plotting does. */
export function cadHex(aci: number, rgb?: number): string {
  const v = rgb ?? aciRgb(aci);
  return v === 0xffffff ? "#000000" : hex(v);
}
