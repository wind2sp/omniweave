// Finger navigation on the canvas (src/ui/touchNav.ts) and the phone browser viewer's geometry (src/web/phone.ts):
// pointer sequences as a touch screen sends them.
import { describe, expect, it } from "vitest";
import { TAP_SLOP, TouchNav, applyStep, doubleTapView, isDoubleTap, type NavView } from "../src/ui/touchNav";
import { doubleTapZoom, isPhoneScreen, MAX_PAGE_PIXELS, pageAt, pageScale, scrollFor, wantsPhoneViewer, type PhoneEnv } from "../src/web/phone";

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

describe("phone browser viewer (web/phone.ts)", () => {
  const env = (p: Partial<PhoneEnv>): PhoneEnv => ({ tauri: false, screenW: 412, screenH: 915, coarse: true, choice: null, search: "", ...p });

  it("phones get the viewer; tablets, desktops, the desktop app and the PC-layout choice do not", () => {
    expect(wantsPhoneViewer(env({}))).toBe(true);
    expect(wantsPhoneViewer(env({ screenW: 915, screenH: 412 }))).toBe(true); // landscape phone
    expect(wantsPhoneViewer(env({ screenW: 800, screenH: 1280 }))).toBe(false); // tablet
    expect(wantsPhoneViewer(env({ coarse: false, screenW: 500, screenH: 700 }))).toBe(false); // narrow desktop window
    expect(wantsPhoneViewer(env({ tauri: true }))).toBe(false);
    expect(wantsPhoneViewer(env({ choice: "desktop" }))).toBe(false);
    expect(wantsPhoneViewer(env({ search: "?desktop" }))).toBe(false);
    expect(wantsPhoneViewer(env({ coarse: false, screenW: 1920, screenH: 1080, search: "?phone" }))).toBe(true);
    expect(isPhoneScreen({ screenW: 599, screenH: 1000, coarse: true })).toBe(true);
  });

  it("page pictures: screen-sharp, capped in pixels", () => {
    // A4 (794 × 1123) 388 px wide on a 2.625× phone
    const s = pageScale(388, 794, 1123, 2.625);
    expect(s).toBeCloseTo((388 * 2.625) / 794);
    // a huge drawing stays under the cap
    const big = pageScale(388 * 5, 20000, 14000, 3);
    expect(20000 * 14000 * big * big).toBeLessThanOrEqual(MAX_PAGE_PIXELS * 1.0001);
  });

  it("page counter and double tap in the page column", () => {
    const tops = [0, 560, 1120], hs = [548, 548, 548];
    expect(pageAt(tops, hs, 10)).toBe(0);
    expect(pageAt(tops, hs, 555)).toBe(1); // in the gap: the next page
    expect(pageAt(tops, hs, 5000)).toBe(2);
    const z = doubleTapZoom(1, 100, 300);
    expect(z).toEqual({ zoom: 2.5, x: 250, y: 750 });
    expect(doubleTapZoom(2.5, 250, 750)).toEqual({ zoom: 1, x: 100, y: 300 });
    // the tapped point comes back under the finger
    expect(scrollFor(0, 60, 250, 750, 100, 360)).toEqual({ left: 150, top: 450 });
    expect(scrollFor(0, 60, 10, 10, 100, 360)).toEqual({ left: 0, top: 0 });
  });
});
