// Layer effects: the pixel implementation against reference formulas, compositing order (groups, clipping), the
// model helpers (angles, reach, omitted-when-empty), Weave keys, the SVG filter and the panel's pure logic.
import { describe, expect, it } from "vitest";
import { alphaOf, applyEffects, blurPlane, flattenEffects, offsetMatte, premultiply } from "../../src/core/image/effects";
import { compositeTree, type PlacedPixels } from "../../src/core/image/softComposite";
import { nodeHash, paintBounds, weaveKey } from "../../src/core/loom";
import {
  SIZE_TO_SIGMA,
  activeEffects,
  dirToPsAngle,
  effectMargins,
  exportIssues,
  fxOrder,
  newEffect,
  psAngleToDir,
  setEffects,
  shadowOffset,
  type Effect,
} from "../../src/core/style";
import { newDocument, newPage, newText, newVector, type LayerGroup, type SceneNode } from "../../src/core/types";
import { rectContour } from "../../src/core/vector";
import { requiredVersion } from "../../src/io/omwMigrate";
import { svgEffectsFilter } from "../../src/io/svgFx";
import { addEffect, panelOrder, paramPatch, paramValue, patchEffect, removeEffect, reorderEffect, toggleEffect, effectParams } from "../../src/ui/style/effectsModel";

const px = (v: number) => ({ v, u: "px" as const });
const black = { hex: "#000000" };
const shadow = (p: Partial<Extract<Effect, { type: "dropShadow" }>> = {}): Effect => ({ type: "dropShadow", on: true, blend: "NORMAL", opacity: 1, color: black, angle: 180, distance: px(0), spread: 0, size: px(0), ...p }) as Effect;

/** w×h straight RGBA, `fill` inside the rectangle, transparent outside. */
function rectRgba(w: number, h: number, x0: number, y0: number, x1: number, y1: number, rgb = [255, 0, 0]): Uint8Array {
  const o = new Uint8Array(w * h * 4);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) o.set([rgb[0], rgb[1], rgb[2], 255], (y * w + x) * 4);
  return o;
}
const erfc = (x: number) => {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
};
const nodeAt = (id: string, extra: Partial<SceneNode> = {}) => ({ id, name: id, visible: true, locked: false, opacity: 1, blendMode: "NORMAL", transform: { x: 0, y: 0, rotation: 0, scale: 1 }, ...extra }) as unknown as SceneNode;
const placed = (rgba: Uint8Array, left: number, top: number, width: number, height: number): PlacedPixels => ({ rgba, left, top, width, height });
const at = (rgba: Uint8Array, W: number, x: number, y: number) => Array.from(rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 4));

describe("effect pixels vs reference formulas", () => {
  it("blur: a step edge becomes ½·erfc(d / (σ√2)) (Gaussian, σ = Size·SIZE_TO_SIGMA)", () => {
    const W = 200, H = 120;
    for (const size of [4, 12, 30]) {
      const a = new Float32Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < 100; x++) a[y * W + x] = 1;
      const s = size * SIZE_TO_SIGMA;
      blurPlane(a, W, H, s);
      let worst = 0;
      for (let x = 70; x < 130; x++) {
        const want = 0.5 * erfc((x - 99.5) / (s * Math.SQRT2));
        worst = Math.max(worst, Math.abs(a[60 * W + x] - want));
      }
      expect(worst, `size ${size}`).toBeLessThan(size > 6 ? 0.02 : 0.01);
    }
  });

  it("blur: the effective σ follows the requested σ smoothly above the Gaussian-kernel range (no box-width steps)", () => {
    // variance of a blurred impulse = σ²; integer box widths stepped it (σ 3.68 and 4 gave one result)
    const W = 161;
    for (const s of [3.2, 3.68, 4, 4.2, 5.5, 7.3, 11]) {
      const a = new Float32Array(W);
      a[80] = 1;
      blurPlane(a, W, 1, s);
      let sum = 0, v = 0;
      for (let x = 0; x < W; x++) sum += a[x];
      for (let x = 0; x < W; x++) v += (a[x] / sum) * (x - 80) ** 2;
      expect(Math.sqrt(v), `σ ${s}`).toBeCloseTo(s, 1);
    }
  });

  it("inner shadow: content filling its layer box shades like the same content with transparent room around it", () => {
    // every PSD layer's pixels end at the content: the shadow sliding in must be the blurred falloff, not a hard band
    const fx = [{ ...newEffect("innerShadow"), angle: 135, distance: px(6), size: px(8), opacity: 1, blend: "NORMAL" } as Effect];
    const tight = premultiply(rectRgba(30, 20, 0, 0, 30, 20));
    applyEffects(tight, 30, 20, fx, 1);
    const R = 20, W = 30 + 2 * R, H = 20 + 2 * R;
    const roomy = premultiply(rectRgba(W, H, R, R, R + 30, R + 20));
    applyEffects(roomy, W, H, fx, 1);
    let worst = 0;
    for (let y = 0; y < 20; y++) for (let x = 0; x < 30; x++) worst = Math.max(worst, Math.abs(tight[(y * 30 + x) * 4] - roomy[((y + R) * W + x + R) * 4]));
    expect(worst).toBeLessThan(0.01);
  });

  it("spread / choke: offsetMatte grows a matte by r px with a one-pixel anti-aliased edge", () => {
    const W = 40, H = 40;
    const a = alphaOf(premultiply(rectRgba(W, H, 10, 10, 30, 30)));
    const g = offsetMatte(a, W, H, 3);
    expect(g[20 * W + 7]).toBe(1); // 3 px out
    expect(g[20 * W + 5]).toBe(0); // 5 px out
    expect(g[6 * W + 6]).toBe(0); // corner, distance √32 > 3: round join
    const s = offsetMatte(a, W, H, -3);
    expect(s[20 * W + 12]).toBe(0);
    expect(s[20 * W + 14]).toBe(1);
  });

  it("drop shadow: offset (−cos a, sin a)·distance, colour × opacity, knocked out under the layer, Multiply on white", () => {
    expect(shadowOffset(120, 10).map((v) => Math.round(v * 1000) / 1000)).toEqual([5, 8.66]);
    expect(shadowOffset(180, 5)).toEqual([5, 0]);
    const W = 40, H = 30;
    const bg = nodeAt("bg");
    const sq = nodeAt("sq", { effects: [shadow({ blend: "MULTIPLY", opacity: 0.75, distance: px(5), angle: 180 })] });
    const pix = new Map([
      ["bg", placed(rectRgba(W, H, 0, 0, W, H, [255, 255, 255]), 0, 0, W, H)],
      ["sq", placed(rectRgba(10, 10, 0, 0, 10, 10), 10, 10, 10, 10)],
    ]);
    const out = compositeTree([bg, sq], undefined, (n) => pix.get(n.id) ?? null, W, H);
    expect(at(out, W, 22, 15)).toEqual([64, 64, 64, 255]); // shadow only: 255·(1 − 0.75)
    expect(at(out, W, 15, 15)).toEqual([255, 0, 0, 255]); // content on top
    expect(at(out, W, 26, 15)).toEqual([255, 255, 255, 255]); // past the shadow
    expect(at(out, W, 12, 22)).toEqual([255, 255, 255, 255]); // shadow moved right, not down
  });

  it("drop shadow size: the falloff outside the shape follows the blurred step", () => {
    const W = 120, H = 60, S = 10;
    const d = premultiply(rectRgba(W, H, 0, 0, 60, H));
    const below = applyEffects(d, W, H, [shadow({ size: px(S) })], 1);
    const m = alphaOf(below[0].d);
    const s = S * SIZE_TO_SIGMA;
    for (let x = 61; x < 80; x++) expect(Math.abs(m[30 * W + x] - 0.5 * erfc((x - 59.5) / (s * Math.SQRT2)))).toBeLessThan(0.02);
    // knockout: nothing under the layer
    expect(m[30 * W + 30]).toBe(0);
  });

  it("outer glow (Screen) lightens around the shape; inner shadow darkens the side the light comes from", () => {
    const W = 40, H = 40;
    const d = premultiply(rectRgba(W, H, 10, 10, 30, 30, [128, 128, 128]));
    const glow = applyEffects(d.slice(), W, H, [newEffect("outerGlow")], 1);
    expect(glow).toHaveLength(1);
    expect(glow[0].blend).toBe("SCREEN");
    expect(alphaOf(glow[0].d)[20 * W + 8]).toBeGreaterThan(0.2);
    const c = d.slice();
    applyEffects(c, W, H, [{ ...newEffect("innerShadow"), opacity: 1 } as Effect], 1);
    const lum = (x: number, y: number) => c[(y * W + x) * 4] / c[(y * W + x) * 4 + 3];
    // light from 120° (upper left): the shadow falls inside along the top / left edges
    expect(lum(11, 11)).toBeLessThan(lum(28, 28) - 0.2);
    expect(lum(20, 20)).toBeCloseTo(128 / 255, 2);
    expect(alphaOf(c)[5 * W + 5]).toBe(0); // clipped to the layer
  });

  it("stroke outside / inside / center; colour overlay keeps alpha; soft edge fades the rim", () => {
    const W = 40, H = 40;
    const base = rectRgba(W, H, 10, 10, 30, 30);
    const run = (fx: Effect[]) => {
      const d = premultiply(base);
      applyEffects(d, W, H, fx, 1);
      return d;
    };
    const stroke = (align: "outside" | "inside" | "center") => ({ type: "fxStroke", on: true, stroke: { paint: { type: "solid", color: { hex: "#0000ff" } }, width: px(4), align } }) as Effect;
    const o = run([stroke("outside")]);
    expect(Array.from(o.subarray((20 * W + 7) * 4, (20 * W + 7) * 4 + 4))).toEqual([0, 0, 1, 1]);
    expect(o[(20 * W + 5) * 4 + 3]).toBe(0);
    expect(o[(20 * W + 12) * 4]).toBe(1); // interior still red
    const i = run([stroke("inside")]);
    expect(i[(20 * W + 11) * 4 + 2]).toBeCloseTo(1, 5);
    expect(i[(20 * W + 7) * 4 + 3]).toBe(0);
    expect(i[(20 * W + 20) * 4]).toBe(1);
    const c = run([stroke("center")]);
    expect(c[(20 * W + 9) * 4 + 2]).toBeCloseTo(1, 5);
    expect(c[(20 * W + 10) * 4 + 2]).toBeCloseTo(1, 5);
    const ov = run([{ type: "overlay", on: true, opacity: 0.5, paint: { type: "solid", color: { hex: "#00ff00" } } } as Effect]);
    expect(Array.from(ov.subarray((20 * W + 20) * 4, (20 * W + 20) * 4 + 4)).map((v) => Math.round(v * 100) / 100)).toEqual([0.5, 0.5, 0, 1]);
    const se = run([{ type: "softEdge", on: true, radius: px(8) } as Effect]);
    expect(se[(20 * W + 10) * 4 + 3]).toBeLessThan(0.2);
    expect(se[(20 * W + 20) * 4 + 3]).toBeGreaterThan(0.95);
  });

  it("the stroke casts the shadow too (Photoshop: outer effects come from the styled shape)", () => {
    const W = 50, H = 30;
    const d = premultiply(rectRgba(W, H, 10, 10, 20, 20));
    const below = applyEffects(d, W, H, [shadow({ distance: px(6) }), { type: "fxStroke", on: true, stroke: { paint: { type: "solid", color: black }, width: px(3), align: "outside" } } as Effect], 1);
    // stroke reaches x = 22; its shadow 6 px further
    expect(alphaOf(below[0].d)[15 * W + 27]).toBe(1);
  });

  it("disabled effects and effects not drawn (bevel) change nothing", () => {
    const W = 20, H = 20;
    const d = premultiply(rectRgba(W, H, 5, 5, 15, 15));
    const ref = d.slice();
    expect(applyEffects(d, W, H, [{ ...shadow({ distance: px(3) }), on: false }, newEffect("bevel")], 1)).toEqual([]);
    expect(d).toEqual(ref);
  });

  it("flattenEffects pads by the margin and draws shadow under content", () => {
    const f = flattenEffects(rectRgba(10, 10, 0, 0, 10, 10), 10, 10, [shadow({ distance: px(4) })], 1, 6);
    expect(f.w).toBe(22);
    expect(at(new Uint8Array(f.rgba.buffer), 22, 18, 10)).toEqual([0, 0, 0, 255]);
    expect(at(new Uint8Array(f.rgba.buffer), 22, 10, 10)).toEqual([255, 0, 0, 255]);
  });
});

describe("effects in the layer tree (Photoshop order)", () => {
  const W = 40, H = 30;
  const white = placed(rectRgba(W, H, 0, 0, W, H, [255, 255, 255]), 0, 0, W, H);

  it("a group's effects apply to its composite: same as one layer holding the members' pixels", () => {
    const g: LayerGroup = { id: "g", name: "G", parentId: null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", effects: [shadow({ distance: px(4), size: px(3) })] };
    const a = nodeAt("a", { groupId: "g" }), b = nodeAt("b", { groupId: "g" });
    const pix = new Map([
      ["bg", white],
      ["a", placed(rectRgba(6, 6, 0, 0, 6, 6), 5, 5, 6, 6)],
      ["b", placed(rectRgba(6, 6, 0, 0, 6, 6, [0, 0, 255]), 14, 12, 6, 6)],
    ]);
    const grouped = compositeTree([nodeAt("bg"), a, b], [g], (n) => pix.get(n.id) ?? null, W, H);
    const merged = compositeTree([nodeAt("a"), nodeAt("b")], undefined, (n) => pix.get(n.id) ?? null, W, H);
    const one = nodeAt("m", { effects: g.effects });
    const flat = compositeTree([nodeAt("bg"), one], undefined, (n) => (n.id === "m" ? placed(merged, 0, 0, W, H) : white), W, H);
    let worst = 0;
    for (let i = 0; i < grouped.length; i++) worst = Math.max(worst, Math.abs(grouped[i] - flat[i]));
    expect(worst).toBeLessThanOrEqual(1);
    // the shadow is there (below b, right of it)
    expect(at(grouped, W, 22, 17)[0]).toBeLessThan(200);
  });

  it("a clip base keeps its shadow unclipped below the stack; clipped layers show only inside the base", () => {
    const base = nodeAt("base", { effects: [shadow({ distance: px(6) })] });
    const clip = nodeAt("clip", { clip: true });
    const pix = new Map([
      ["bg", white],
      ["base", placed(rectRgba(10, 10, 0, 0, 10, 10), 5, 5, 10, 10)],
      ["clip", placed(rectRgba(W, H, 0, 0, W, H, [0, 255, 0]), 0, 0, W, H)],
    ]);
    const out = compositeTree([nodeAt("bg"), base, clip], undefined, (n) => pix.get(n.id) ?? null, W, H);
    expect(at(out, W, 10, 10)).toEqual([0, 255, 0, 255]); // clipped layer inside the base
    expect(at(out, W, 18, 10)).toEqual([0, 0, 0, 255]); // base's shadow, not clipped, not green
    expect(at(out, W, 30, 10)).toEqual([255, 255, 255, 255]);
  });

  it("a clipped layer's own shadow is clipped to the base", () => {
    const base = nodeAt("base");
    const clip = nodeAt("clip", { clip: true, effects: [shadow({ distance: px(4) })] });
    const pix = new Map([
      ["bg", white],
      ["base", placed(rectRgba(20, 10, 0, 0, 20, 10, [255, 255, 0]), 5, 5, 20, 10)],
      ["clip", placed(rectRgba(4, 10, 0, 0, 4, 10, [0, 0, 255]), 5, 5, 4, 10)],
    ]);
    const out = compositeTree([nodeAt("bg"), base, clip], undefined, (n) => pix.get(n.id) ?? null, W, H);
    expect(at(out, W, 11, 8)).toEqual([0, 0, 0, 255]); // shadow on the base
    expect(at(out, W, 11, 17)).toEqual([255, 255, 255, 255]); // below the base: clipped away
  });
});

describe("effect model", () => {
  it("angles: Photoshop ↔ DrawingML dir", () => {
    for (const a of [0, 45, 90, 120, 180, 270, -30]) expect(dirToPsAngle(psAngleToDir(a))).toBeCloseTo(((a % 360) + 360) % 360, 9);
    expect(psAngleToDir(120)).toBe(60);
    expect(psAngleToDir(90)).toBe(90);
  });

  it("drawing order follows Photoshop, whatever the array order", () => {
    const fx = [newEffect("fxStroke"), newEffect("dropShadow"), newEffect("overlay"), newEffect("innerShadow"), newEffect("outerGlow")];
    expect(fxOrder(fx).map((e) => e.type)).toEqual(["dropShadow", "outerGlow", "overlay", "innerShadow", "fxStroke"]);
    expect(activeEffects([newEffect("bevel"), { ...newEffect("dropShadow"), on: false }])).toEqual([]);
  });

  it("reach: drop shadow toward its offset, glow all round; paint bounds grow, the selection box does not", () => {
    const m = effectMargins([shadow({ distance: px(10), angle: 180, size: px(4) })]);
    expect(m.r).toBeGreaterThan(15);
    expect(m.l).toBeLessThan(m.r);
    const v = { ...newVector([rectContour(0, 0, 10, 10)]), effects: [shadow({ distance: px(10), angle: 180 })] } as SceneNode;
    const pb = paintBounds(v);
    expect(pb.w).toBeGreaterThan(20);
  });

  it("knockout: the result is (content over its shadow) faded by the layer opacity — no dark rim on anti-aliased edges", () => {
    // a half-covered edge column over a solid black shadow (size 0, offset 0, big spread is not needed: the shadow
    // equals the matte), white backdrop
    const W = 12, H = 6;
    const rgba = new Uint8Array(W * H * 4);
    for (let y = 0; y < H; y++)
      for (let x = 4; x < 8; x++) rgba.set([255, 0, 0, x === 4 ? 128 : 255], (y * W + x) * 4);
    const bg = new Uint8Array(W * H * 4).fill(255);
    for (const op of [1, 0.5]) {
      const nodes = [nodeAt("bg"), nodeAt("a", { opacity: op, effects: [shadow({ distance: px(1), angle: 180, size: px(0) })] })];
      const out = compositeTree(nodes, undefined, (n) => (n.id === "bg" ? placed(bg, 0, 0, W, H) : placed(rgba, 0, 0, W, H)), W, H);
      // pixel x = 5: content opaque; the shadow (moved 1 px right) lies under it → only the content, faded
      expect(at(out, W, 5, 2)[1]).toBeCloseTo(255 * (1 - op), -1);
      // pixel x = 4: a = 0.5 content; the shadow under it comes from x = 3 (empty): the content faded by op
      const a = 128 / 255;
      const want4 = (c: number) => 255 * (1 - op * a) + op * a * c;
      expect(at(out, W, 4, 2)[0]).toBeCloseTo(want4(255), -1);
      expect(at(out, W, 4, 2)[1]).toBeCloseTo(want4(0), -1);
    }
    // the case that showed it: an anti-aliased edge pixel whose shadow comes from the layer itself (distance 0)
    const nodes = [nodeAt("bg"), nodeAt("a", { effects: [shadow({ size: px(0) })] })];
    const out = compositeTree(nodes, undefined, (n) => (n.id === "bg" ? placed(bg, 0, 0, W, H) : placed(rgba, 0, 0, W, H)), W, H);
    // Photoshop: content (a = 0.5 red) over its own shadow (a = 0.5 black) over white → G = 255·(1−a)·(1−a)
    const a = 128 / 255;
    expect(at(out, W, 4, 2)[1]).toBeCloseTo(255 * (1 - a) * (1 - a), -1);
  });

  it("group interior effects: the pixel compositor's row bands do not show as seams (inner shadow / glow)", () => {
    const g: LayerGroup = { id: "g", name: "g", parentId: null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", effects: [{ ...newEffect("innerGlow"), size: px(6), opacity: 1, blend: "NORMAL" } as Effect] };
    const n = nodeAt("a", { groupId: "g" });
    const px0 = () => placed(rectRgba(40, 60, 0, 0, 40, 60), 5, 5, 40, 60);
    const whole = compositeTree([n], [g], px0, 50, 70);
    const banded = compositeTree([n], [g], px0, 50, 70, 16);
    let worst = 0;
    for (let i = 0; i < whole.length; i++) worst = Math.max(worst, Math.abs(whole[i] - banded[i]));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("an effect reach beyond the surface cap (Photoshop allows a 30000 px shadow distance): the layer is drawn without it, no huge allocation", () => {
    const n = nodeAt("a", { effects: [shadow({ distance: px(30000), size: px(250) })] });
    const out = compositeTree([n], undefined, () => placed(rectRgba(10, 10, 0, 0, 10, 10), 5, 5, 10, 10), 20, 20);
    expect(at(out, 20, 8, 8)).toEqual([255, 0, 0, 255]);
  });

  it("reach of a shadow / glow on a stroked layer starts at the stroke's outer edge (the stroke casts it)", () => {
    const stroke: Effect = { type: "fxStroke", on: true, stroke: { paint: { type: "solid", color: black }, width: px(8), align: "outside" } };
    const alone = effectMargins([shadow({ size: px(10) })]);
    const both = effectMargins([shadow({ size: px(10) }), stroke]);
    expect(both.l).toBeCloseTo(alone.l + 8, 5);
    const glow = { ...newEffect("outerGlow"), size: px(10) } as Effect;
    expect(effectMargins([glow, stroke]).t).toBeCloseTo(effectMargins([glow]).t + 8, 5);
    // the composited shadow is not cut at the padded surface's edge: the far tail stays a smooth falloff
    const W = 60, H = 60;
    const out = compositeTree([nodeAt("a", { effects: [shadow({ size: px(10) }), stroke] })], undefined, () => placed(rectRgba(10, 10, 0, 0, 10, 10), 25, 25, 10, 10), W, H);
    // straight left of the square: alpha falls monotonically and has no jump bigger than the blur allows
    let prev = -1;
    for (let x = 0; x < 17; x++) {
      const a = at(out, W, x, 30)[3];
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    expect(at(out, W, 6, 30)[3]).toBeGreaterThan(0);
  });

  it("no effects = no field: hashes of untouched nodes stay, an emptied list removes the field, v1 files stay v1", () => {
    const v = newVector([rectContour(0, 0, 10, 10)]);
    const h = nodeHash(v);
    expect("effects" in v).toBe(false);
    const w = { ...v };
    setEffects(w, [shadow()]);
    expect(nodeHash(w)).not.toBe(h);
    setEffects(w, []);
    expect("effects" in w).toBe(false);
    expect(nodeHash({ ...w })).toBe(h);
    const doc = newDocument("t");
    const p = newPage("DESIGN", 100, 100, "P");
    p.nodes = [v];
    doc.pages = [p];
    expect(requiredVersion(doc)).toBe(1);
    p.groups = [{ id: "g", name: "G", parentId: null, visible: true, locked: false, opacity: 1, blendMode: "PASS_THROUGH", effects: [shadow()] }];
    expect(requiredVersion(doc)).toBe(2);
  });

  it("Weave keys: a tile reached only by a shadow includes the node; nodes without effects are unchanged", () => {
    const p = newPage("DESIGN", 400, 200, "P");
    const v = { ...newVector([rectContour(0, 0, 50, 50)]), fill: "#ff0000" } as SceneNode;
    p.nodes = [v];
    const tile = { x: 60, y: 0, w: 40, h: 40 };
    expect(weaveKey(p, null, tile, 1, null).nodes).toHaveLength(0);
    p.nodes = [{ ...v, effects: [shadow({ distance: px(20), angle: 180 })] } as SceneNode];
    const k1 = weaveKey(p, null, tile, 1, null);
    expect(k1.nodes).toHaveLength(1);
    p.nodes = [{ ...v, effects: [shadow({ distance: px(22), angle: 180 })] } as SceneNode];
    expect(weaveKey(p, null, tile, 1, null).key).not.toBe(k1.key);
  });

  it("caps: export issues name effect × format", () => {
    const p = newPage("SLIDE", 100, 100, "P");
    const t = newText("OMNI");
    t.effects = [newEffect("innerGlow"), newEffect("dropShadow")];
    p.nodes = [t];
    const pptx = exportIssues([p], "pptx").map((i) => `${i.prop}:${i.level}`);
    expect(pptx).toContain("fx.innerGlow:rasterize");
    expect(pptx).toContain("fx.dropShadow:approx");
    expect(exportIssues([p], "psd").some((i) => i.prop.startsWith("fx."))).toBe(false);
    expect(exportIssues([p], "png").some((i) => i.prop.startsWith("fx."))).toBe(false);
  });
});

describe("SVG filter", () => {
  it("drop shadow, inner shadow, glow, stroke and soft edge become filter primitives in page space", () => {
    const f = svgEffectsFilter("fx1", [shadow({ distance: px(5), size: px(4), opacity: 0.5 }), newEffect("innerShadow"), newEffect("outerGlow"), newEffect("fxStroke"), newEffect("softEdge")], { x: 10, y: 10, w: 100, h: 40 })!;
    expect(f).toMatch(/^<filter id="fx1" filterUnits="userSpaceOnUse"/);
    expect(f).toContain(`<feGaussianBlur in="SourceAlpha" stdDeviation="${+(4 * SIZE_TO_SIGMA).toFixed(3)}"`);
    expect(f).toContain('<feOffset in="e0" dx="5" dy="0"');
    expect(f).toContain('flood-opacity="0.5"');
    expect(f).toContain('operator="dilate" radius="3"');
    expect(f).toContain('<feFuncA type="table" tableValues="1 0"/>');
    expect(f).toContain('operator="erode"');
    expect(f).toMatch(/<feMerge>(<feMergeNode in="e\d+"\/>)+<feMergeNode in="e\d+"\/>/);
    expect(svgEffectsFilter("x", [newEffect("bevel")], { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});

describe("Effects panel logic", () => {
  it("add / toggle / patch / reorder among the same type / remove; panel lists Photoshop's dialog order", () => {
    let fx = addEffect(undefined, "dropShadow");
    fx = addEffect(fx, "fxStroke");
    fx = addEffect(fx, "dropShadow");
    expect(panelOrder(fx)).toEqual([1, 2, 0]); // stroke on top, then the two shadows (later one above)
    fx = toggleEffect(fx, 0);
    expect(fx[0].on).toBe(false);
    const moved = reorderEffect(fx, 0, 1);
    expect(moved[2].on).toBe(false);
    expect(moved[1].type).toBe("fxStroke");
    expect(reorderEffect(fx, 1, 1)).toEqual(fx); // no other stroke: unchanged
    fx = patchEffect(fx, 2, { opacity: 0.3, noise: undefined });
    expect(fx[2].opacity).toBe(0.3);
    fx = removeEffect(fx, 1);
    expect(fx.map((e) => e.type)).toEqual(["dropShadow", "dropShadow"]);
  });

  it("parameters show Photoshop units and patch lengths in their own unit; editing the angle leaves global light", () => {
    const e = { ...shadow({ distance: { v: 4, u: "pt" }, spread: 0.25, opacity: 0.75 }), globalLight: true } as Effect;
    const ps = effectParams(e);
    expect(ps.map((p) => p.key)).toEqual(["opacity", "angle", "distance", "spread", "size"]);
    expect(paramValue(e, ps[0])).toBe(75);
    expect(paramValue(e, ps[3])).toBe(25);
    expect(paramPatch(e, ps[2], 9)).toEqual({ distance: { v: 9, u: "pt" } });
    expect(paramPatch(e, ps[1], 90)).toEqual({ angle: 90, globalLight: undefined });
    expect(patchEffect([e], 0, paramPatch(e, ps[1], 90))[0]).not.toHaveProperty("globalLight");
    expect(paramPatch(e, ps[0], 150)).toEqual({ opacity: 1 });
  });
});
