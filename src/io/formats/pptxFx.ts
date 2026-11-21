// DrawingML effects (a:effectLst, ECMA-376 Part 1 §20.1.8) ↔ the Photoshop-based effect model.
//   outerShdw ↔ drop shadow   blurRad = Size, dist = Distance, dir = (180 − angle) mod 360 (core/style/effects.ts)
//   innerShdw ↔ inner shadow  (same)
//   glow      ↔ outer glow    rad = Size
//   softEdge  ↔ soft edge     rad
// Spread / choke, noise, blend modes and contours have no DrawingML equivalent (caps.ts: approx). Inner glow,
// stroke and overlay effects have none at all: the exporter places such an object as a picture (caps: rasterize).

import { dirToPsAngle, psAngleToDir } from "../../core/style/effects";
import { rgbaOf } from "../../core/style/color";
import type { Color, Effect } from "../../core/style/types";
import { attr, child, children } from "../xml";

const EMU = 9525;

/** Effects DrawingML can hold. */
export const PPTX_EFFECTS = new Set<Effect["type"]>(["dropShadow", "innerShadow", "outerGlow", "softEdge"]);

/** Does the object need to become a picture to keep its look (an enabled effect DrawingML lacks)? */
export const pptxNeedsPicture = (fx: readonly Effect[] | undefined) => !!fx?.some((e) => e.on && !PPTX_EFFECTS.has(e.type) && e.type !== "bevel" && e.type !== "satin");

const clr = (c: Color, opacity: number) => {
  const v = rgbaOf(c);
  const h = [v.r, v.g, v.b].map((x) => Math.round(x).toString(16).padStart(2, "0")).join("").toUpperCase();
  const a = Math.round(Math.max(0, Math.min(1, opacity * v.a)) * 100000);
  return `<a:srgbClr val="${h}"${a < 100000 ? `><a:alpha val="${a}"/></a:srgbClr>` : "/>"}`;
};

const emu = (px: number, k: number) => Math.round(px * k * EMU);

/** a:effectLst for the effects DrawingML holds ("" when none); `k` = page px → slide px scale. */
export function effectLstXml(effects: readonly Effect[] | undefined, k = 1): string {
  const fx = (effects ?? []).filter((e) => e.on);
  if (!fx.length) return "";
  const parts: Record<string, string> = {};
  for (const e of fx) {
    const op = e.opacity ?? 1;
    // CT_EffectList allows one of each; the first of a kind is kept
    if (e.type === "outerGlow" && !parts.glow) parts.glow = `<a:glow rad="${emu(e.size.v, k)}">${clr(e.paint.type === "solid" ? e.paint.color : e.paint.type === "gradient" ? e.paint.stops[0]?.color ?? { hex: "#ffffbe" } : { hex: "#ffffbe" }, op)}</a:glow>`;
    if ((e.type === "dropShadow" || e.type === "innerShadow") && !parts[e.type]) {
      const tag = e.type === "dropShadow" ? "outerShdw" : "innerShdw";
      const extra = e.type === "dropShadow" ? ` algn="ctr" rotWithShape="0"` : "";
      parts[e.type] = `<a:${tag} blurRad="${emu(e.size.v, k)}" dist="${emu(e.distance.v, k)}" dir="${Math.round(psAngleToDir(e.angle) * 60000) % 21600000}"${extra}>${clr(e.color, op)}</a:${tag}>`;
    }
    if (e.type === "softEdge" && !parts.softEdge) parts.softEdge = `<a:softEdge rad="${emu(e.radius.v, k)}"/>`;
  }
  // schema order: blur fillOverlay glow innerShdw outerShdw prstShdw reflection softEdge
  const body = [parts.glow, parts.innerShadow, parts.dropShadow, parts.softEdge].filter(Boolean).join("");
  return body ? `<a:effectLst>${body}</a:effectLst>` : "";
}

/** Effects of a spPr (its a:effectLst); `colorOf` resolves theme colours. Empty when none. */
export function readEffectLst(spPr: Element | undefined, colorOf: (el: Element | undefined) => string | null): Effect[] {
  const lst = spPr && child(spPr, "effectLst");
  if (!lst) return [];
  const out: Effect[] = [];
  const px = (el: Element, a: string) => ({ v: Math.round((Number(attr(el, a) ?? 0) / EMU) * 1000) / 1000, u: "px" as const });
  const colorAlpha = (el: Element): { color: Color; opacity: number } => {
    const hex = colorOf(el) ?? "#000000";
    const c = children(el).find((x) => /Clr$/.test(x.localName));
    const al = c && children(c).find((x) => x.localName === "alpha");
    return { color: { hex }, opacity: al ? Number(attr(al, "val")) / 100000 : 1 };
  };
  for (const el of children(lst)) {
    switch (el.localName) {
      case "outerShdw":
      case "innerShdw": {
        const { color, opacity } = colorAlpha(el);
        const dir = Number(attr(el, "dir") ?? 0) / 60000;
        out.push({ type: el.localName === "outerShdw" ? "dropShadow" : "innerShadow", on: true, blend: "NORMAL", opacity, color, angle: Math.round(dirToPsAngle(dir) * 1000) / 1000, distance: px(el, "dist"), spread: 0, size: px(el, "blurRad") });
        break;
      }
      case "glow": {
        const { color, opacity } = colorAlpha(el);
        out.push({ type: "outerGlow", on: true, blend: "NORMAL", opacity, paint: { type: "solid", color }, spread: 0, size: px(el, "rad") });
        break;
      }
      case "softEdge":
        out.push({ type: "softEdge", on: true, radius: px(el, "rad") });
        break;
    }
  }
  return out;
}
