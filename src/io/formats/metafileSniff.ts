// Metafile recognition (EMF / WMF by their bytes and media types), the header size and the WMF placeable header —
// small enough for the importers and the picture decode to load at once; the player that draws a metafile
// (metafile.ts) is loaded only when one is shown.

export type MetaKind = "emf" | "wmf";

/** EMF / WMF by the bytes (WMF with or without the placeable header). */
export function metafileKind(b: Uint8Array): MetaKind | null {
  if (b.length >= 88 && b[0] === 1 && b[1] === 0 && b[2] === 0 && b[3] === 0 && b[40] === 0x20 && b[41] === 0x45 && b[42] === 0x4d && b[43] === 0x46) return "emf";
  if (b.length >= 40 && b[0] === 0xd7 && b[1] === 0xcd && b[2] === 0xc6 && b[3] === 0x9a) return "wmf";
  if (b.length >= 18 && (b[0] === 1 || b[0] === 2) && b[1] === 0 && b[2] === 9 && b[3] === 0 && b[4] === 0 && (b[5] === 1 || b[5] === 3)) return "wmf";
  return null;
}

/** Media types of metafiles (the names Office packages and browsers use). */
export const isMetafileMime = (mime: string | undefined | null) => !!mime && /^(image\/(x-)?(emf|wmf)|application\/x-msmetafile|image\/x-ms-(emf|wmf))$/i.test(mime);

/** Intrinsic size (CSS px at 96 dpi) from the header only, or null. */
export function metafileSize(b: Uint8Array): { width: number; height: number } | null {
  const k = metafileKind(b);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (k === "emf") {
    const fl = dv.getInt32(24, true), ft = dv.getInt32(28, true), fr = dv.getInt32(32, true), fb = dv.getInt32(36, true);
    if (fr > fl && fb > ft) return { width: ((fr - fl) / 100) * (96 / 25.4), height: ((fb - ft) / 100) * (96 / 25.4) };
    return null;
  }
  if (k === "wmf" && dv.getUint32(0, true) === 0x9ac6cdd7) {
    const w = Math.abs(dv.getInt16(10, true) - dv.getInt16(6, true)), h = Math.abs(dv.getInt16(12, true) - dv.getInt16(8, true)), inch = dv.getUint16(14, true) || 1440;
    return w && h ? { width: (w / inch) * 96, height: (h / inch) * 96 } : null;
  }
  return null;
}

/**
 * A WMF placeable header (the 22 bytes before a bare WMF) for a picture of `w`×`h` metafile units at `inch` units
 * per inch — PowerPoint's binary files keep WMFs without it, the OOXML / browsers expect it.
 */
export function wmfPlaceable(wmf: Uint8Array, l: number, t: number, r: number, b: number, inch: number): Uint8Array {
  const out = new Uint8Array(22 + wmf.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x9ac6cdd7, true);
  dv.setInt16(6, l, true);
  dv.setInt16(8, t, true);
  dv.setInt16(10, r, true);
  dv.setInt16(12, b, true);
  dv.setUint16(14, Math.max(1, Math.min(65535, Math.round(inch))), true);
  let sum = 0;
  for (let i = 0; i < 10; i++) sum ^= dv.getUint16(i * 2, true);
  dv.setUint16(20, sum, true);
  out.set(wmf, 22);
  return out;
}
