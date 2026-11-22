// Finger navigation on the canvas (src/ui/touchNav.ts):
// pointer sequences as a touch screen sends them.
import { describe, expect, it } from "vitest";
import { TAP_SLOP, TouchNav, applyStep, doubleTapView, isDoubleTap, type NavView } from "../src/ui/touchNav";

/** feed one gesture (frames of finger positions by id) into a TouchNav, applying each step to the view */
function run(frames: Record<number, [number, number]>[], v0: NavView) {
  const tn = new TouchNav();
  let v = v0;
  let taps = 0;
  let prev: Record<number, [number, number]> = {};
  for (const f of [...frames, {}]) {
    for (const id of Object.keys(f).map(Number)) {
      if (!(id in prev)) tn.down(id, ...f[id]);
      else {
        const st = tn.move(id, ...f[id]);
        if (st) v = applyStep(v, st);
      }
    }
    for (const id of Object.keys(prev).map(Number)) if (!(id in f)) taps += tn.up(id) ? 1 : 0;
    prev = f;
  }
  return { v, taps, tn };
}

describe("touch navigation (canvas)", () => {
  const v0: NavView = { zoom: 1, panX: 10, panY: 20 };

  it("one finger moves the view with the finger", () => {
    const { v, taps } = run([{ 1: [100, 300] }, { 1: [100, 250] }, { 1: [90, 100] }], v0);
    expect(v.zoom).toBe(1);
    expect(v.panX).toBeCloseTo(0);
    expect(v.panY).toBeCloseTo(-180);
    expect(taps).toBe(0);
  });

  it("a press that hardly moves is a tap", () => {
    const { taps } = run([{ 1: [100, 300] }, { 1: [102, 303] }], v0);
    expect(taps).toBe(1);
    expect(run([{ 1: [100, 300] }, { 1: [100 + TAP_SLOP + 1, 300] }], v0).taps).toBe(0);
  });

  it("two fingers spreading zoom in about their middle; the page point there stays put", () => {
    const mid: [number, number] = [200, 400];
    const pageAtMid = [(mid[0] - v0.panX) / v0.zoom, (mid[1] - v0.panY) / v0.zoom];
    const { v, taps } = run(
      [
        { 1: [150, 400], 2: [250, 400] },
        { 1: [125, 400], 2: [275, 400] },
        { 1: [100, 400], 2: [300, 400] },
      ],
      v0,
    );
    expect(v.zoom).toBeCloseTo(2);
    expect((mid[0] - v.panX) / v.zoom).toBeCloseTo(pageAtMid[0]);
    expect((mid[1] - v.panY) / v.zoom).toBeCloseTo(pageAtMid[1]);
    expect(taps).toBe(0); // two fingers never click
  });

  it("two fingers moving together pan; pinching in zooms out, within the zoom limits", () => {
    const pan = run([{ 1: [100, 100], 2: [200, 100] }, { 1: [130, 160], 2: [230, 160] }], v0).v;
    expect(pan.zoom).toBeCloseTo(1);
    expect(pan.panX).toBeCloseTo(40);
    expect(pan.panY).toBeCloseTo(80);
    const out = run([{ 1: [0, 0], 2: [400, 0] }, { 1: [199, 0], 2: [201, 0] }], { zoom: 0.05, panX: 0, panY: 0 }).v;
    expect(out.zoom).toBe(0.02);
  });

  it("a second finger after the first: the first finger's travel no longer counts as a tap", () => {
    const tn = new TouchNav();
    tn.down(1, 10, 10);
    tn.down(2, 50, 10);
    expect(tn.up(2)).toBe(false);
    expect(tn.up(1)).toBe(false);
    expect(tn.count).toBe(0);
  });

  it("double tap: fit → 2× about the tap, zoomed → back to the fit", () => {
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, 250, 20, 15)).toBe(true);
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, 400, 10, 10)).toBe(false);
    expect(isDoubleTap({ t: 0, x: 10, y: 10 }, 100, 80, 10)).toBe(false);
    const fit: NavView = { zoom: 0.5, panX: 40, panY: 30 };
    const z = doubleTapView(fit, 0.5, 140, 230)!;
    expect(z.zoom).toBe(1);
    expect((140 - z.panX) / z.zoom).toBeCloseTo((140 - fit.panX) / fit.zoom);
    expect(doubleTapView(z, 0.5, 140, 230)).toBeNull();
  });
});
