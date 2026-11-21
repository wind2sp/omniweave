// Colour-well values (controls.tsx ColorField). A native <input type="color"> only fires a change when its value
// changes, so while a colour is "none" the picker must not sit on the colour the person is likely to pick:
// it starts at a remembered colour instead (the last colour this field had, or the caller's fallback).

/** used when nothing is remembered: an unlikely pick, so black and white both register as a change */
export const NONE_PICKER = "#808081";

/** "#abc" / "#AABBCCDD" → "#aabbcc"; anything else → null */
export function normHex(c: string | null | undefined): string | null {
  if (!c) return null;
  const m = /^#([0-9a-f]{3,8})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1];
  if (h.length === 3 || h.length === 4) return "#" + h.slice(0, 3).split("").map((x) => x + x).join("").toLowerCase();
  if (h.length === 6 || h.length === 8) return "#" + h.slice(0, 6).toLowerCase();
  return null;
}

/** value for the native picker: the colour itself, or while it is none the remembered fallback */
export function pickerHex(value: string | null, fallback?: string | null): string {
  return normHex(value) ?? normHex(fallback) ?? NONE_PICKER;
}

/** hex typed into the hex box → the colour to set, or null when invalid or unchanged (none → any colour is a change) */
export function hexToCommit(raw: string, value: string | null): string | null {
  const v = raw.trim().replace(/^#?/, "#");
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return null;
  const hex = normHex(v)!;
  return value != null && normHex(value) === hex ? null : hex;
}
