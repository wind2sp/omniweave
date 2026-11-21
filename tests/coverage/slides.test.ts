// Feature coverage: slide animation timeline, presets, triggers, transitions (data side).
// Visual playback (Presenter.tsx) is browser-only and listed as manual verification.
import { beforeEach, describe, expect, it } from "vitest";
import { ANIM_PRESETS, buildSteps, easing, sampleAnim, sampleOverrides } from "../../src/core/anim";
import { newDocument, newPage, newText, uid, type KeyframeAnimation } from "../../src/core/types";
import { addAnimation, duplicatePage } from "../../src/ui/actions";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { strFromU8, unzipSync } from "fflate";
import { S, freshStore, page } from "./helpers";

const anim = (target: string, trigger: KeyframeAnimation["trigger"], from: number, to: number, ms = 500): KeyframeAnimation => ({
  id: uid("an"),
  targetNodeId: target,
  trigger,
  property: "OPACITY",
  keyframes: [
    { time: 0, value: from, easing: "linear" },
    { time: ms, value: to, easing: "linear" },
  ],
});

describe("animation engine", () => {
  it("[PP-058] easing: named curves and cubic-bezier", () => {
    expect(easing("linear")(0.25)).toBeCloseTo(0.25);
    expect(easing("ease-in-out")(0.5)).toBeCloseTo(0.5, 3);
    expect(easing("ease-in")(0.25)).toBeLessThan(0.25);
    expect(easing("ease-out")(0.25)).toBeGreaterThan(0.25);
    const f = easing("cubic-bezier(0.1, 0.7, 0.9, 0.3)");
    let prev = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const y = f(Math.min(1, x));
      expect(y).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = y;
    }
    expect(easing("back-out")(0.6)).toBeGreaterThan(1); // overshoot
  });

  it("[PP-055] start conditions: on click / with previous / after previous build click steps", () => {
    const pg = newPage("SLIDE");
    pg.animations = [anim("a", "WITH_PREVIOUS", 0, 1), anim("b", "ON_CLICK", 0, 1), anim("c", "AFTER_PREVIOUS", 0, 1, 300), anim("d", "WITH_PREVIOUS", 0, 1, 200), anim("e", "ON_CLICK", 0, 1)];
    const steps = buildSteps(pg);
    expect(steps).toHaveLength(3); // auto step + 2 clicks
    expect(steps[0].anims.map((x) => x.anim.targetNodeId)).toEqual(["a"]);
    expect(steps[1].anims.map((x) => [x.anim.targetNodeId, x.start])).toEqual([["b", 0], ["c", 500], ["d", 500]]);
    expect(steps[1].duration).toBe(800);
    // before click 1, b is at its initial (hidden) value; after, fully shown
    expect(sampleOverrides(steps, 0, 1e9).get("b")!.opacity).toBe(0);
    expect(sampleOverrides(steps, 1, 250).get("b")!.opacity).toBeCloseTo(0.5);
    expect(sampleOverrides(steps, 2, 0).get("b")!.opacity).toBe(1);
  });

  it("[PP-051][PP-052][PP-053] presets: entrance (fade, fly, zoom, spin), exit (fade-out), emphasis (pulse)", () => {
    const keys = Object.keys(ANIM_PRESETS);
    expect(keys).toEqual(expect.arrayContaining(["fade-in", "fly-left", "fly-up", "zoom-in", "spin-in", "fade-out", "pulse"]));
    const fly = ANIM_PRESETS["fly-left"].make();
    const tr = fly.find((m) => m.property === "TRANSLATION")!;
    expect(sampleAnim({ id: "x", targetNodeId: "n", trigger: "ON_CLICK", ...tr }, 0)).toEqual([-400, 0]);
    expect(sampleAnim({ id: "x", targetNodeId: "n", trigger: "ON_CLICK", ...tr }, 10000)).toEqual([0, 0]);
    const out = ANIM_PRESETS["fade-out"].make()[0];
    expect(sampleAnim({ id: "x", targetNodeId: "n", trigger: "ON_CLICK", ...out }, 500)).toBe(0);
    const pulse = ANIM_PRESETS.pulse.make()[0];
    expect(sampleAnim({ id: "x", targetNodeId: "n", trigger: "ON_CLICK", ...pulse }, 250)).toBeCloseTo(1.15);
    expect(sampleAnim({ id: "x", targetNodeId: "n", trigger: "ON_CLICK", ...pulse }, 500)).toBe(1);
  });
});

describe("slide actions", () => {
  beforeEach(() => {
    const doc = newDocument();
    const slide = newPage("SLIDE", 1280, 720, "슬라이드 1");
    slide.nodes.push(newText("제목", 400));
    doc.pages = [slide];
    freshStore(doc);
  });

  it("[PP-051][PP-056] adding a preset to the selection appends ordered animations (first on click, rest with previous)", () => {
    const id = page().nodes[0].id;
    S().set({ selection: [id] });
    addAnimation("fly-up", "ON_CLICK");
    const list = page().animations;
    expect(list.map((a) => [a.property, a.trigger])).toEqual([["TRANSLATION", "ON_CLICK"], ["OPACITY", "WITH_PREVIOUS"]]);
    expect(list.every((a) => a.targetNodeId === id)).toBe(true);
    S().undo();
    expect(page().animations).toHaveLength(0);
  });

  it("[PP-011] duplicating a slide re-targets its animations to the copied objects", () => {
    const id = page().nodes[0].id;
    S().set({ selection: [id] });
    addAnimation("fade-in");
    duplicatePage(page().id);
    const copy = page();
    expect(copy.name).toContain("사본");
    expect(copy.nodes[0].id).not.toBe(id);
    expect(copy.animations[0].targetNodeId).toBe(copy.nodes[0].id);
  });

  it("[PP-045][PP-046][PP-047] transitions (type + duration) persist through .omw and its readable slide deck", () => {
    S().commit("전환", (d) => void (d.pages[0].transition = { type: "SLIDE_LEFT", duration: 900 }));
    const { bytes } = packOmw(S().doc);
    const deck = JSON.parse(strFromU8(unzipSync(bytes)["slides/slide_deck.json"]));
    expect(deck[0].transitions).toEqual({ type: "SLIDE_LEFT", duration: 900 });
    expect(unpackOmw(bytes).doc.pages[0].transition).toEqual({ type: "SLIDE_LEFT", duration: 900 });
  });
});
