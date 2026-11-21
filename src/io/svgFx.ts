// Layer effects as SVG filter primitives (Filter Effects Module Level 1): feGaussianBlur, feMorphology, feOffset,
// feFlood, feComposite, feComponentTransfer, feMerge. The filter is applied to a <g> in page coordinates, so sizes
// and offsets are page px like the model's. Blend modes of effects are not available in SVG filters (they would
// need the backdrop): effects are drawn Normal — caps.ts marks SVG effects "approx".

import { SIZE_TO_SIGMA, activeEffects, effectColor, effectMargins, effectOpacity, growRect, shadowOffset } from "../core/style/effects";
import { rgbaOf } from "../core/style/color";
import { toPx } from "../core/style/len";
import type { Color, Effect } from "../core/style/types";
import type { Rect } from "../core/geom";

const n = (v: number) => (Math.round(v * 1000) / 1000).toString();

const flood = (c: Color | null, op: number) => {
  const v = rgbaOf(c ?? { hex: "#000000" });
  const hex = "#" + [v.r, v.g, v.b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
  return `flood-color="${hex}" flood-opacity="${n(Math.max(0, Math.min(1, op * v.a)))}"`;
};

/**
 * `<filter>` for `effects` on content whose page-space box is `box` (null when no effect is drawn). Use it as
 * `<g filter="url(#id)">content</g>` with the group in page coordinates.
 */
export function svgEffectsFilter(id: string, effects: readonly Effect[] | undefined, box: Rect): string | null {
  const fx = activeEffects(effects);
  if (!fx.length) return null;
  const r = growRect(box, effectMargins(fx));
  const p: string[] = [];
  const below: string[] = [];
  const above: string[] = [];
  let src = "SourceGraphic";
  let k = 0;
  const id2 = () => `e${k++}`;
  const inv = () => {
    const o = id2();
    p.push(`<feComponentTransfer in="SourceAlpha" result="${o}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
    return o;
  };
  const blurMorph = (input: string, size: number, spread: number) => {
    let cur = input;
    if (spread > 0 && size * spread > 0) {
      const o = id2();
      p.push(`<feMorphology in="${cur}" operator="dilate" radius="${n(size * spread)}" result="${o}"/>`);
      cur = o;
    }
    const s = size * (1 - spread) * SIZE_TO_SIGMA;
    if (s > 0) {
      const o = id2();
      p.push(`<feGaussianBlur in="${cur}" stdDeviation="${n(s)}" result="${o}"/>`);
      cur = o;
    }
    return cur;
  };
  const colourIn = (mask: string, c: Color | null, op: number, clip?: "in" | "out") => {
    const f = id2(), o = id2();
    p.push(`<feFlood ${flood(c, op)} result="${f}"/>`, `<feComposite in="${f}" in2="${mask}" operator="in" result="${o}"/>`);
    if (!clip) return o;
    const o2 = id2();
    p.push(`<feComposite in="${o}" in2="SourceAlpha" operator="${clip}" result="${o2}"/>`);
    return o2;
  };
  for (const e of fx) {
    const op = effectOpacity(e);
    switch (e.type) {
      case "dropShadow": {
        const m = blurMorph("SourceAlpha", toPx(e.size), e.spread);
        const [dx, dy] = shadowOffset(e.angle, toPx(e.distance));
        const o = id2();
        p.push(`<feOffset in="${m}" dx="${n(dx)}" dy="${n(dy)}" result="${o}"/>`);
        below.push(colourIn(o, e.color, op, "out"));
        break;
      }
      case "outerGlow":
        below.push(colourIn(blurMorph("SourceAlpha", toPx(e.size), e.spread), effectColor(e), op, "out"));
        break;
      case "innerShadow": {
        const m = blurMorph(inv(), toPx(e.size), e.spread);
        const [dx, dy] = shadowOffset(e.angle, toPx(e.distance));
        const o = id2();
        p.push(`<feOffset in="${m}" dx="${n(dx)}" dy="${n(dy)}" result="${o}"/>`);
        above.push(colourIn(o, e.color, op, "in"));
        break;
      }
      case "innerGlow": {
        let m = blurMorph(inv(), toPx(e.size), e.spread);
        if (e.source === "center") {
          const o = id2();
          p.push(`<feComponentTransfer in="${m}" result="${o}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
          m = o;
        }
        above.push(colourIn(m, effectColor(e), op, "in"));
        break;
      }
      case "overlay":
        above.push(colourIn("SourceAlpha", effectColor(e), op));
        break;
      case "fxStroke": {
        const w = toPx(e.stroke.width);
        const align = e.stroke.align ?? "outside";
        const c = effectColor(e);
        const grow = align === "outside" ? w : align === "center" ? w / 2 : 0;
        const shrink = align === "inside" ? w : align === "center" ? w / 2 : 0;
        if (grow > 0) {
          const o = id2();
          p.push(`<feMorphology in="SourceAlpha" operator="dilate" radius="${n(grow)}" result="${o}"/>`);
          below.push(colourIn(o, c, op, "out"));
        }
        if (shrink > 0) {
          const o = id2(), b = id2();
          p.push(`<feMorphology in="SourceAlpha" operator="erode" radius="${n(shrink)}" result="${o}"/>`, `<feComposite in="SourceAlpha" in2="${o}" operator="out" result="${b}"/>`);
          // drawn over the interior effects (stroke is above them in Photoshop's order)
          above.push(colourIn(b, c, op));
        }
        break;
      }
      case "softEdge": {
        const R = toPx(e.radius);
        const o = id2(), b = id2(), s = id2();
        p.push(`<feMorphology in="SourceAlpha" operator="erode" radius="${n(R / 2)}" result="${o}"/>`, `<feGaussianBlur in="${o}" stdDeviation="${n((R / 2) * SIZE_TO_SIGMA)}" result="${b}"/>`, `<feComposite in="SourceGraphic" in2="${b}" operator="in" result="${s}"/>`);
        src = s;
        break;
      }
    }
  }
  // outer effects first (drop shadow under the glow under the outside stroke), then the content and the rest
  const order = [...below, src, ...above];
  return `<filter id="${id}" filterUnits="userSpaceOnUse" x="${n(r.x)}" y="${n(r.y)}" width="${n(r.w)}" height="${n(r.h)}" color-interpolation-filters="sRGB">${p.join("")}<feMerge>${order.map((x) => `<feMergeNode in="${x}"/>`).join("")}</feMerge></filter>`;
}
