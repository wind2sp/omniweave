// Finger navigation on the canvas (touch screens: tablets, a phone in the desktop layout). The canvas takes every
// pointer itself (.canvas-wrap touch-action: none), so without this a finger acted as a mouse — the select tool drew
// a marquee and nothing moved or zoomed. With the select / hand tool one finger moves the view; two fingers always
// zoom and move it (and drop a stroke the first finger began); a tap still clicks; a double tap switches between the
// fitted view and 2×. Pure: CanvasView feeds the pointers in and applies the steps (tests/touchNav.test.ts).
//
// A phone (browser or app) normally shows the phone shell instead (ui/mobile, io/platform.ts isMobile), which has
// its own viewer.

export interface NavView {
  zoom: number;
  panX: number;
  panY: number;
}

/** One move of the fingers: centroid shift (dx, dy), spread ratio f (1 for one finger), centroid (cx, cy) after. */
export interface NavStep {
  dx: number;
  dy: number;
  f: number;
  cx: number;
  cy: number;
}

/** a press that travels less than this (screen px) is a tap */
export const TAP_SLOP = 8;

function centroid(pts: Iterable<[number, number]>): { c: [number, number]; d: number; n: number } {
  const a = [...pts];
  if (!a.length) return { c: [0, 0], d: 0, n: 0 };
  const cx = a.reduce((s, p) => s + p[0], 0) / a.length, cy = a.reduce((s, p) => s + p[1], 0) / a.length;
  const d = a.length > 1 ? a.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / a.length : 0;
  return { c: [cx, cy], d, n: a.length };
}

export class TouchNav {
  private pts = new Map<number, [number, number]>();
  private start: [number, number] | null = null;
  /** how far the fingers travelled since the first one went down (Infinity once a second finger came) */
  travel = 0;
  /** the fingers navigate (not handed to a drawing tool) */
  navigating = false;

  get count(): number {
    return this.pts.size;
  }
  has(id: number): boolean {
    return this.pts.has(id);
  }

  down(id: number, x: number, y: number): void {
    this.pts.set(id, [x, y]);
    if (this.pts.size === 1) {
      this.start = [x, y];
      this.travel = 0;
      this.navigating = false;
    } else this.travel = Infinity;
  }

  /** The finger moved: the step to apply to the view (null for a finger we do not follow). */
  move(id: number, x: number, y: number): NavStep | null {
    if (!this.pts.has(id)) return null;
    const a = centroid(this.pts.values());
    this.pts.set(id, [x, y]);
    const b = centroid(this.pts.values());
    if (this.start && this.pts.size === 1) this.travel = Math.max(this.travel, Math.hypot(x - this.start[0], y - this.start[1]));
    return { dx: b.c[0] - a.c[0], dy: b.c[1] - a.c[1], f: b.n > 1 && a.d > 0 ? b.d / a.d : 1, cx: b.c[0], cy: b.c[1] };
  }

  /** The finger lifted (or was cancelled); true when this ends a one-finger tap. */
  up(id: number): boolean {
    if (!this.pts.delete(id)) return false;
    const tap = this.pts.size === 0 && this.travel < TAP_SLOP;
    if (this.pts.size === 0) {
      this.start = null;
      this.navigating = false;
    }
    return tap;
  }
}

/** The view after a step: moved with the centroid, zoomed about it (zoom kept within min..max). */
export function applyStep(v: NavView, s: NavStep, min = 0.02, max = 32): NavView {
  const zoom = Math.min(max, Math.max(min, v.zoom * s.f));
  const k = zoom / v.zoom;
  const px = v.panX + s.dx, py = v.panY + s.dy;
  return { zoom, panX: s.cx - (s.cx - px) * k, panY: s.cy - (s.cy - py) * k };
}

/** Double tap: zoomed in → back to the fit; at the fit → 2× about the tapped point (null = fit again). */
export function doubleTapView(v: NavView, fitZoom: number, x: number, y: number): NavView | null {
  if (v.zoom > fitZoom * 1.2) return null;
  const zoom = Math.min(32, fitZoom * 2);
  const k = zoom / v.zoom;
  return { zoom, panX: x - (x - v.panX) * k, panY: y - (y - v.panY) * k };
}

/** Two taps within 300 ms and 30 px. */
export function isDoubleTap(prev: { t: number; x: number; y: number } | null, t: number, x: number, y: number): boolean {
  return !!prev && t - prev.t < 300 && Math.hypot(x - prev.x, y - prev.y) < 30;
}
