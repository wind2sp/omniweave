// Display-only pixel fitting (docs/design/RENDER_CRISPNESS.md).
//
// Everything here maps *screen* coordinates (CSS px, drawn through a ×dpr transform) onto the
// device-pixel grid, so 1px UI lines cover exactly one row of device pixels and handles have
// whole-pixel edges at 100 / 125 / 150 % Windows scaling. Model / export coordinates never pass
// through these helpers.

/**
 * Switches for before / after comparison (dev builds expose them as `window.__omwCrisp`); all on in use.
 * exactTiles: weave tiles at the exact device zoom once the zoom settles (weave.ts tileScale).
 * lcdText: opaque weave tiles on opaque pages, so canvas glyphs get LCD (subpixel) anti-aliasing.
 * snapUi: overlay lines / handles / page frame on the device-pixel grid (CanvasView).
 * snapContent: table rules on whole device pixels in on-screen tiles only (pixelGrid; export unchanged).
 * backing: canvas backing store sized from devicePixelContentBoxSize (exact 1:1 with the screen).
 */
export const crisp = { exactTiles: true, lcdText: true, snapUi: true, snapContent: true, backing: true };

/** Device pixels for a hairline UI stroke: 1 at 100–149 %, 2 at 150–249 %, … */
export function hairDev(dpr: number): number {
  return Math.max(1, Math.round(dpr));
}

/** The hairline stroke width in CSS px (set as lineWidth under a ×dpr transform). */
export function hairCss(dpr: number): number {
  return hairDev(dpr) / dpr;
}

/**
 * The CSS coordinate of a stroke centre near `v` whose `devWidth`-device-pixel stroke covers whole
 * device pixels: odd widths centre on a pixel's middle, even widths on a pixel boundary.
 */
export function snapStroke(v: number, dpr: number, devWidth = hairDev(dpr)): number {
  const d = v * dpr;
  const c = devWidth % 2 ? Math.floor(d) + 0.5 : Math.round(d);
  return c / dpr;
}

/** A CSS coordinate moved onto the nearest device-pixel boundary (edges of filled boxes). */
export function snapEdge(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr;
}

/**
 * A square of about `sizeCss` CSS px centred on (x, y), with whole-device-pixel edges and an odd
 * device size so it is centred on one pixel. Returns [x, y, size] in CSS px.
 */
export function snapSquare(x: number, y: number, sizeCss: number, dpr: number): [number, number, number] {
  let s = Math.max(3, Math.round(sizeCss * dpr));
  if (s % 2 === 0) s += 1;
  const cx = Math.floor(x * dpr), cy = Math.floor(y * dpr);
  const h = (s - 1) / 2;
  return [(cx - h) / dpr, (cy - h) / dpr, s / dpr];
}

/** Hairline placement on the device grid inside a paint whose transform is an axis-aligned scale + move. */
export interface PixelGrid {
  /** local x of a stroke centre near `v` whose stroke covers whole device columns */
  x(v: number): number;
  /** local y, likewise for device rows */
  y(v: number): number;
  /** the stroke width in local units: the requested width rounded to whole device pixels, at least 1 */
  lw: number;
}

/**
 * Snap thin content lines (table rules) to device pixels the way word processors show them: at least
 * one device pixel wide and never straddling two. Only for on-screen tiles (DrawEnv.screen); null when
 * the transform rotates, skews or scales x and y differently (the line is drawn as modelled).
 */
export function pixelGrid(ctx: { getTransform(): DOMMatrix }, width = 1): PixelGrid | null {
  if (!crisp.snapContent) return null;
  const m = ctx.getTransform();
  if (Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9 || m.a <= 0 || Math.abs(m.a - m.d) > 1e-6 * m.a) return null;
  const dev = Math.max(1, Math.round(width * m.a));
  const snap = (d: number) => (dev % 2 ? Math.floor(d) + 0.5 : Math.round(d));
  return { x: (v) => (snap(m.a * v + m.e) - m.e) / m.a, y: (v) => (snap(m.d * v + m.f) - m.f) / m.d, lw: dev / m.a };
}
