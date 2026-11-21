// Slide timeline: keyframe interpolation, easing, and click-step scheduling.

import type { KeyframeAnimation, Page, Vec2 } from "./types";

function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  const dsx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const d = sx(t) - x;
      if (Math.abs(d) < 1e-6) break;
      const dd = dsx(t);
      if (Math.abs(dd) < 1e-6) break;
      t -= d / dd;
    }
    if (t < 0 || t > 1) {
      let lo = 0, hi = 1;
      t = x;
      for (let i = 0; i < 30; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
    }
    return sy(t);
  };
}

const easingCache = new Map<string, (t: number) => number>();
export function easing(name: string): (t: number) => number {
  let f = easingCache.get(name);
  if (f) return f;
  const m = /cubic-bezier\(([^)]+)\)/.exec(name);
  if (m) {
    const [a, b, c, d] = m[1].split(",").map(Number);
    f = cubicBezier(a, b, c, d);
  } else {
    switch (name) {
      case "ease-in": f = cubicBezier(0.42, 0, 1, 1); break;
      case "ease-out": f = cubicBezier(0, 0, 0.58, 1); break;
      case "ease-in-out": f = cubicBezier(0.42, 0, 0.58, 1); break;
      case "ease": f = cubicBezier(0.25, 0.1, 0.25, 1); break;
      case "back-out": f = cubicBezier(0.34, 1.56, 0.64, 1); break;
      default: f = (t) => Math.max(0, Math.min(1, t));
    }
  }
  easingCache.set(name, f);
  return f;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Sample an animation at local time t (ms). Before start -> first value, after end -> last. */
export function sampleAnim(a: KeyframeAnimation, t: number): number | Vec2 {
  const kf = a.keyframes;
  if (!kf.length) return 0;
  if (t <= kf[0].time) return kf[0].value;
  for (let i = 0; i + 1 < kf.length; i++) {
    const k0 = kf[i], k1 = kf[i + 1];
    if (t <= k1.time) {
      const u = easing(k1.easing)((t - k0.time) / (k1.time - k0.time || 1));
      if (Array.isArray(k0.value) && Array.isArray(k1.value))
        return [lerp(k0.value[0], k1.value[0], u), lerp(k0.value[1], k1.value[1], u)];
      return lerp(k0.value as number, k1.value as number, u);
    }
  }
  return kf[kf.length - 1].value;
}

export const animDuration = (a: KeyframeAnimation) => (a.keyframes.length ? a.keyframes[a.keyframes.length - 1].time : 0);

export interface ScheduledAnim {
  anim: KeyframeAnimation;
  start: number; // ms within its step
}
export interface Step {
  anims: ScheduledAnim[];
  duration: number;
}

/** Group animations into click steps. Step 0 holds animations that run automatically on slide entry. */
export function buildSteps(page: Page): Step[] {
  const steps: Step[] = [{ anims: [], duration: 0 }];
  let prevStart = 0, prevEnd = 0;
  for (const a of page.animations) {
    let step = steps[steps.length - 1];
    let start: number;
    if (a.trigger === "ON_CLICK") {
      step = { anims: [], duration: 0 };
      steps.push(step);
      start = 0;
    } else if (a.trigger === "WITH_PREVIOUS") start = prevStart;
    else start = prevEnd;
    step.anims.push({ anim: a, start });
    prevStart = start;
    prevEnd = start + animDuration(a);
    step.duration = Math.max(step.duration, prevEnd);
  }
  return steps;
}

export interface NodeOverride {
  opacity: number;
  dx: number;
  dy: number;
  scale: number;
  rotation: number;
}

export const NO_OVERRIDE: NodeOverride = { opacity: 1, dx: 0, dy: 0, scale: 1, rotation: 0 };

/** Overrides for all animated nodes at (stepIndex, time within that step). */
export function sampleOverrides(steps: Step[], stepIndex: number, t: number): Map<string, NodeOverride> {
  const out = new Map<string, NodeOverride>();
  const get = (id: string) => {
    let o = out.get(id);
    if (!o) out.set(id, (o = { ...NO_OVERRIDE }));
    return o;
  };
  // Apply in order so later animations on the same property win; a future step only
  // contributes its initial value when nothing earlier has set that property.
  const touched = new Set<string>();
  steps.forEach((step, si) => {
    for (const { anim, start } of step.anims) {
      const key = anim.targetNodeId + "|" + anim.property;
      if (si > stepIndex && touched.has(key)) continue;
      touched.add(key);
      const local = si < stepIndex ? Infinity : si > stepIndex ? -Infinity : t - start;
      const v = sampleAnim(anim, local);
      const o = get(anim.targetNodeId);
      switch (anim.property) {
        case "OPACITY": o.opacity = v as number; break;
        case "SCALE": o.scale = v as number; break;
        case "ROTATION": o.rotation = v as number; break;
        case "TRANSLATION": o.dx = (v as Vec2)[0]; o.dy = (v as Vec2)[1]; break;
      }
    }
  });
  return out;
}

export type AnimPreset = "fade-in" | "fly-left" | "fly-up" | "zoom-in" | "spin-in" | "fade-out" | "pulse";
export const ANIM_PRESETS: Record<AnimPreset, { label: string; make: () => Pick<KeyframeAnimation, "property" | "keyframes">[] }> = {
  "fade-in": { label: "나타나기", make: () => [{ property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 500, value: 1, easing: "ease-out" }] }] }, // i18n: ui
  "fly-left": { label: "왼쪽에서 날아오기", make: () => [ // i18n: ui
    { property: "TRANSLATION", keyframes: [{ time: 0, value: [-400, 0], easing: "linear" }, { time: 600, value: [0, 0], easing: "ease-out" }] },
    { property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 300, value: 1, easing: "linear" }] },
  ] },
  "fly-up": { label: "아래에서 올라오기", make: () => [ // i18n: ui
    { property: "TRANSLATION", keyframes: [{ time: 0, value: [0, 120], easing: "linear" }, { time: 600, value: [0, 0], easing: "back-out" }] },
    { property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 300, value: 1, easing: "linear" }] },
  ] },
  "zoom-in": { label: "확대", make: () => [ // i18n: ui
    { property: "SCALE", keyframes: [{ time: 0, value: 0.3, easing: "linear" }, { time: 500, value: 1, easing: "back-out" }] },
    { property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 250, value: 1, easing: "linear" }] },
  ] },
  "spin-in": { label: "회전하며 등장", make: () => [ // i18n: ui
    { property: "ROTATION", keyframes: [{ time: 0, value: -180, easing: "linear" }, { time: 700, value: 0, easing: "ease-out" }] },
    { property: "OPACITY", keyframes: [{ time: 0, value: 0, easing: "linear" }, { time: 350, value: 1, easing: "linear" }] },
  ] },
  "fade-out": { label: "사라지기", make: () => [{ property: "OPACITY", keyframes: [{ time: 0, value: 1, easing: "linear" }, { time: 500, value: 0, easing: "ease-in" }] }] }, // i18n: ui
  pulse: { label: "강조(펄스)", make: () => [{ property: "SCALE", keyframes: [{ time: 0, value: 1, easing: "linear" }, { time: 250, value: 1.15, easing: "ease-out" }, { time: 500, value: 1, easing: "ease-in" }] }] }, // i18n: ui
};
