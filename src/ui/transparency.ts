// Pictures that open on a white canvas, and the canvas turning transparent once their pixels are erased.

/** Pictures without transparency: they open on a white canvas (ui/actions.ts canvasImagePage). */
const OPAQUE_PICTURES = new Set(["jpg", "jpeg", "jfif", "bmp", "heic", "heif"]);

/**
 * Erasing pixels (eraser, Delete in a selection, background removal) on a JPG / BMP page that still has its white
 * opening canvas turns that canvas transparent in the same undo step, so the erased parts show the checkerboard as
 * in Photoshop. Before (2026-11-23) they showed the white canvas: on a photo, erasing and background removal looked
 * as if nothing had happened. A canvas colour the user chose (another colour, or any page not opened from such a
 * picture) is kept.
 */
export function revealTransparencyInPlace(p: { background?: string | null; source?: { format?: string } }) {
  const f = p.source?.format?.toLowerCase();
  if (f && OPAQUE_PICTURES.has(f) && typeof p.background === "string" && /^#fff(fff)?$/i.test(p.background)) p.background = "transparent";
}
