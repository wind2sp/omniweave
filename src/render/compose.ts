// Canvas2D side of layer groups and clipping masks: walks the layer tree (core/layerTree.ts) with offscreen
// surfaces only where Photoshop's rules need one — a clip stack, an isolated group (opacity < 1, a blend mode, or
// members that blend), a faded pass-through group. A page without groups or clipping paints node by node as before.
// Layer effects: a node (or group) with effects is drawn into its own surface, read back and run through the one
// pixel implementation (core/image/effects.ts) — the same code the PSD composite and the PDF / DOCX pictures use.
// Blend modes Canvas2D lacks (linear burn / dodge, vivid / linear / pin light, hard mix, subtract, divide, darker /
// lighter colour, dissolve) are blended on the CPU over the surface's pixels (blitBlend) with the same formulas as the
// pixel compositor (core/style/blend.ts pixelBlend), so screen, PNG export and the PSD merged image agree.
// Adjustment layers (RasterNode.adjust) recolour the surface's pixels in place (adjustOnSurface), as softComposite.ts.

import type { NodeOverride } from "../core/anim";
import { buildTree, composeItems, hasStructure, type Compositor } from "../core/layerTree";
import { nodeBounds } from "../core/loom";
import { activeEffects, effectMargins, growRect, innerReach, maxMargin } from "../core/style/effects";
import { blendDef, blendIfWeight, blendMixPixel, dissolveKeep, fillParts, fxFill, needsCpuBlend, pixelBlend } from "../core/style/blend";
import type { Effect, StyleBlend } from "../core/style/types";
import type { LayerGroup, SceneNode } from "../core/types";
import { MAX_FX_PIXELS, applyEffects, premultiply, unpremultiply } from "../core/image/effects";
import { BLEND, ctx2d, drawNode, makeCanvas, type Ctx, type DrawEnv } from "./draw";
import { adjustFnOf } from "../core/image/adjustLayer";

type Cv = OffscreenCanvas | HTMLCanvasElement;

const pool: Cv[] = [];
/** device position of a surface's pixel (0, 0) relative to the painted target (tile / page canvas); absent = 0, 0 */
const origin = new WeakMap<Ctx, { x: number; y: number }>();
const org = (c: Ctx) => origin.get(c) ?? { x: 0, y: 0 };

function take(w: number, h: number): Ctx {
  const i = pool.findIndex((c) => c.width === w && c.height === h);
  const cv = i >= 0 ? pool.splice(i, 1)[0] : makeCanvas(w, h);
  const c = ctx2d(cv);
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.clearRect(0, 0, w, h);
  return c;
}

function give(c: Ctx) {
  origin.delete(c);
  if (pool.length < 16) pool.push(c.canvas as Cv);
}

/** Canvas operation of any style blend mode (modes without one draw Normal). */
const gcoOf = (b: StyleBlend | string): GlobalCompositeOperation => BLEND[b] ?? blendDef(b)?.canvas ?? "source-over";

/** Copy `src` into `dst` 1:1 in device pixels with the given operation (surfaces may differ in size and origin). */
function blitRaw(dst: Ctx, src: Ctx, alpha: number, gco: GlobalCompositeOperation) {
  const a = org(dst), b = org(src);
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.globalAlpha = alpha;
  dst.globalCompositeOperation = gco;
  dst.drawImage(src.canvas as CanvasImageSource, b.x - a.x, b.y - a.y);
  dst.restore();
}

/**
 * `src` onto `dst` (1:1 device pixels, as blitRaw) with any blend mode: Canvas operation when there is one, else on
 * the CPU — read both, blend straight colours, source-over (W3C over: where dst is partly transparent the source
 * shows unblended in proportion), write back.
 */
function blitBlend(dst: Ctx, src: Ctx, alpha: number, blend: StyleBlend | string, bif?: readonly number[]) {
  if (!bif && !needsCpuBlend(blend)) return blitRaw(dst, src, alpha, gcoOf(blend));
  if (alpha <= 0) return;
  const a = org(dst), b = org(src);
  const ox = b.x - a.x, oy = b.y - a.y;
  const x0 = Math.max(0, ox), y0 = Math.max(0, oy);
  const x1 = Math.min(dst.canvas.width, ox + src.canvas.width), y1 = Math.min(dst.canvas.height, oy + src.canvas.height);
  if (x1 <= x0 || y1 <= y0) return;
  const w = x1 - x0, h = y1 - y0;
  const D = dst.getImageData(x0, y0, w, h), S = src.getImageData(x0 - ox, y0 - oy, w, h);
  const d = D.data, s = S.data;
  const P = pixelBlend(blend);
  const dis = blend === "DISSOLVE";
  const m = [0, 0, 0];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let sa = (s[i + 3] / 255) * alpha;
      if (sa <= 0) continue;
      // dissolve: a pixel shows fully or not at all (fixed pattern in target device px)
      if (dis) {
        if (!dissolveKeep(a.x + x0 + x, a.y + y0 + y, sa)) continue;
        sa = 1;
      }
      const da = d[i + 3] / 255;
      // Blend If: by this pixel's colour and the colour below (core/style/blend.ts)
      if (bif) {
        sa *= blendIfWeight(bif, s[i], s[i + 1], s[i + 2], da > 0 ? d[i] : 0, da > 0 ? d[i + 1] : 0, da > 0 ? d[i + 2] : 0);
        if (sa <= 0) continue;
      }
      blendMixPixel(P, d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, s[i] / 255, s[i + 1] / 255, s[i + 2] / 255, da, false, m);
      const ao = sa + da * (1 - sa);
      for (let c = 0; c < 3; c++) d[i + c] = Math.round(((sa * m[c] + da * (d[i + c] / 255) * (1 - sa)) / ao) * 255);
      d[i + 3] = Math.round(ao * 255);
    }
  putClipped(dst, D, x0, y0);
}

/**
 * Write pixels back into `dst` at (x0, y0) device px. putImageData ignores the canvas clip (the page clip of weave.ts
 * paintRegion / paintPage): the result goes through a surface instead — clear the region where the clip allows, then
 * draw the result there.
 */
function putClipped(dst: Ctx, D: ImageData, x0: number, y0: number) {
  const w = D.width, h = D.height;
  const R = take(w, h);
  R.putImageData(D, 0, 0);
  dst.save();
  dst.setTransform(1, 0, 0, 1, 0, 0);
  dst.globalAlpha = 1;
  dst.globalCompositeOperation = "destination-out";
  dst.fillStyle = "#000";
  dst.fillRect(x0, y0, w, h);
  dst.globalCompositeOperation = "source-over";
  dst.drawImage(R.canvas as CanvasImageSource, x0, y0);
  dst.restore();
  give(R);
}

/**
 * An adjustment layer over what `dst` holds: each pixel's colour through the adjustment, blended with the layer's
 * mode, mixed in by mask × opacity; alpha kept. The mask is the node's tiles drawn as alpha (core/image/adjustLayer.ts).
 */
function adjustOnSurface(dst: Ctx, n: SceneNode & { type: "RASTER" }, op: number, env: DrawEnv, o: NodeOverride | undefined) {
  const A = n.adjust!;
  const f = adjustFnOf(A.adj);
  if (!f || op <= 0) return;
  const w = dst.canvas.width, h = dst.canvas.height;
  const D = dst.getImageData(0, 0, w, h), d = D.data;
  let mk: Uint8ClampedArray | null = null;
  if (Object.keys(n.tiles).length) {
    const M = take(w, h);
    M.setTransform(dst.getTransform());
    const og = origin.get(dst);
    if (og) origin.set(M, og);
    drawNode(M, n, env, o ? { ...o, opacity: 1 } : undefined, { bare: true, mask: true });
    mk = M.getImageData(0, 0, w, h).data;
    give(M);
  }
  const B = pixelBlend(n.blendMode);
  const o3 = [0, 0, 0], m3 = new Float64Array(3);
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const m = mk ? mk[i + 3] / 255 : 0;
    const k = (A.hide ? 1 - m : m) * op;
    if (k <= 0) continue;
    f(d[i], d[i + 1], d[i + 2], o3);
    let sr = o3[0], sg = o3[1], sb = o3[2];
    if (B) {
      B(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255, sr / 255, sg / 255, sb / 255, m3);
      ((sr = m3[0] * 255), (sg = m3[1] * 255), (sb = m3[2] * 255));
    }
    d[i] = Math.round(d[i] + (sr - d[i]) * k);
    d[i + 1] = Math.round(d[i + 1] + (sg - d[i + 1]) * k);
    d[i + 2] = Math.round(d[i + 2] + (sb - d[i + 2]) * k);
  }
  putClipped(dst, D, 0, 0);
}

/** Device pixels per page unit of a surface. */
const scaleOf = (c: Ctx) => {
  const m = c.getTransform();
  return Math.hypot(m.a, m.b) || 1;
};

/** A transparent surface covering `rect` (target device px), drawing page content with `like`'s mapping. */
function surfaceAt(like: Ctx, x: number, y: number, w: number, h: number): Ctx {
  const c = take(w, h);
  const m = like.getTransform();
  const o = org(like);
  c.setTransform(m.a, m.b, m.c, m.d, m.e + o.x - x, m.f + o.y - y);
  origin.set(c, { x, y });
  return c;
}

interface StyledSurface {
  key: string;
  content: Ctx;
  below: { s: Ctx; blend: StyleBlend; opacity: number }[];
}
const styledCache = new WeakMap<SceneNode, StyledSurface>();

/** Apply effects to a surface's pixels in place; the below surfaces have its size and origin. */
function fxOnSurface(s: Ctx, fx: readonly Effect[], opacity = 1, fill = 1): { s: Ctx; blend: StyleBlend; opacity: number }[] {
  const w = s.canvas.width, h = s.canvas.height;
  const img = s.getImageData(0, 0, w, h);
  const d = premultiply(img.data);
  const below = applyEffects(d, w, h, fx, scaleOf(s), null, opacity, fill);
  unpremultiply(d, img.data);
  s.putImageData(img, 0, 0);
  const o = org(s);
  return below.map((b) => {
    const c = take(w, h);
    origin.set(c, o);
    c.putImageData(new ImageData(unpremultiply(b.d), w, h), 0, 0);
    return { s: c, blend: b.blend, opacity: b.opacity };
  });
}

/**
 * Node `n` drawn bare (opacity 1, Normal) with its effects into a surface just big enough for it and its effects'
 * reach within `dst` (+ the reach, so content just outside still casts into view). Cached per node for the next
 * call with the same mapping (a clip-stack base draws its content and, separately, its outer effects).
 */
function styledNode(dst: Ctx, n: SceneNode, env: DrawEnv, o: NodeOverride | undefined): StyledSurface | null {
  const fx = activeEffects(n.effects);
  const k = scaleOf(dst);
  const m = dst.getTransform();
  const d0 = org(dst);
  const reach = Math.ceil(maxMargin(effectMargins(fx)) * k) + 2;
  const W = dst.canvas.width, H = dst.canvas.height;
  // node box in target device px (animated scale / rotation: the whole surface)
  let x0 = d0.x - reach, y0 = d0.y - reach, x1 = d0.x + W + reach, y1 = d0.y + H + reach;
  if (!o || (o.scale === 1 && o.rotation === 0)) {
    const b = growRect(nodeBounds(n), effectMargins(fx));
    const bx = b.x + (o?.dx ?? 0), by = b.y + (o?.dy ?? 0);
    const px0 = m.a * bx + m.c * by + m.e + d0.x, py0 = m.b * bx + m.d * by + m.f + d0.y;
    const px1 = m.a * (bx + b.w) + m.c * (by + b.h) + m.e + d0.x, py1 = m.b * (bx + b.w) + m.d * (by + b.h) + m.f + d0.y;
    x0 = Math.max(x0, Math.floor(Math.min(px0, px1)) - 1);
    y0 = Math.max(y0, Math.floor(Math.min(py0, py1)) - 1);
    x1 = Math.min(x1, Math.ceil(Math.max(px0, px1)) + 1);
    y1 = Math.min(y1, Math.ceil(Math.max(py0, py1)) + 1);
  }
  if (x1 <= x0 || y1 <= y0 || (x1 - x0) * (y1 - y0) > MAX_FX_PIXELS) return null;
  // the layer opacity the surfaces are drawn at (the knockout of outer effects depends on it: core/image/effects.ts)
  const op = n.opacity * (o?.opacity ?? 1);
  // `screen`: on-screen tiles fit thin rules to device pixels (draw.ts drawTable), so their surfaces must never be
  // reused by an export / thumbnail paint at the same mapping (docs/design/RENDER_CRISPNESS.md)
  const key = `${m.a},${m.b},${m.c},${m.d},${m.e + d0.x},${m.f + d0.y}|${x0},${y0},${x1},${y1}|${o ? `${o.dx},${o.dy},${o.scale},${o.rotation}` : ""}|${op}|${env.screen ? "s" : ""}`;
  const hit = styledCache.get(n);
  if (hit && hit.key === key && !env.incomplete) return hit;
  const content = surfaceAt(dst, x0, y0, x1 - x0, y1 - y0);
  // the raster painter culls tiles to env.clip: widen it by the reach (in page units)
  const grow = reach / k;
  const wide: DrawEnv = { ...env, clip: { x: env.clip.x - grow, y: env.clip.y - grow, w: env.clip.w + 2 * grow, h: env.clip.h + 2 * grow }, incomplete: false };
  drawNode(content, n, wide, o ? { ...o, opacity: 1 } : undefined, { bare: true });
  if (wide.incomplete) env.incomplete = true;
  const below = fxOnSurface(content, fx, op, fxFill(n)[0]);
  const st: StyledSurface = { key, content, below };
  if (!wide.incomplete) styledCache.set(n, st);
  return st;
}

/** `src` clipped onto what `dst` holds, with a blend mode (Photoshop: blended as if the base were opaque). */
function blitAtop(dst: Ctx, src: Ctx, op: number, blend: StyleBlend | string, copy: (s: Ctx) => Ctx, bif?: readonly number[]) {
  if (op <= 0) return;
  if (blend === "NORMAL" && !bif) return blitRaw(dst, src, op, "source-atop");
  const P = copy(dst);
  P.save();
  P.setTransform(1, 0, 0, 1, 0, 0);
  for (let k = 0; k < 8; k++) P.drawImage(P.canvas as CanvasImageSource, 0, 0);
  P.restore();
  blitBlend(P, src, op, blend, bif);
  blitRaw(dst, P, 1, "source-atop");
  give(P);
}

function canvasCompositor(env: DrawEnv, overrides?: Map<string, NodeOverride>): Compositor<Ctx> {
  const alloc = (like: Ctx) => {
    const c = take(like.canvas.width, like.canvas.height);
    c.setTransform(like.getTransform());
    const o = origin.get(like);
    if (o) origin.set(c, o);
    return c;
  };
  const alpha = (n: SceneNode) => n.opacity * (overrides?.get(n.id)?.opacity ?? 1);
  const C: Compositor<Ctx> = {
    alpha,
    alloc,
    copy(src) {
      const c = alloc(src);
      blitRaw(c, src, 1, "copy");
      return c;
    },
    free: give,
    blit(dst, src, op, blend) {
      if (op <= 0) return;
      if (blend !== "lerp") return blitBlend(dst, src, Math.min(1, op), blend);
      // dst·(1−op) + src·op: fade what is there, then add the faded source (premultiplied sums are exact)
      const a = org(dst), b = org(src);
      dst.save();
      dst.setTransform(1, 0, 0, 1, 0, 0);
      dst.globalCompositeOperation = "destination-out";
      dst.globalAlpha = Math.min(1, op);
      dst.fillStyle = "#000";
      dst.fillRect(0, 0, dst.canvas.width, dst.canvas.height);
      dst.globalCompositeOperation = "lighter";
      dst.drawImage(src.canvas as CanvasImageSource, b.x - a.x, b.y - a.y);
      dst.restore();
    },
    leaf(dst, n, how) {
      const o = overrides?.get(n.id);
      if (n.type === "RASTER" && n.adjust) {
        if (how !== "bare" && n.visible) adjustOnSurface(dst, n, alpha(n), env, o);
        return;
      }
      if (n.effects?.length && activeEffects(n.effects).length && n.visible) {
        const st = styledNode(dst, n, env, o);
        if (st) {
          const op = how === "bare" ? 1 : alpha(n);
          // fill: the content's share, or inside the blend (core/style/blend.ts fillParts); effects at the opacity
          const fp = fillParts(n);
          if (how === "normal") {
            for (const b of st.below) blitBlend(dst, b.s, Math.min(1, op * b.opacity), b.blend);
            blitBlend(dst, st.content, Math.min(1, op * fxFill(n)[1]), fp.blend, n.blendIf);
          } else if (how === "bare") blitRaw(dst, st.content, 1, "source-over");
          else {
            for (const b of st.below) blitAtop(dst, b.s, op * b.opacity, b.blend, C.copy);
            blitAtop(dst, st.content, op * fxFill(n)[1], fp.blend, C.copy, n.blendIf);
          }
          return;
        }
      }
      // a blend mode Canvas2D lacks: draw the node bare into a surface, then blend it on the CPU
      const fp = fillParts(n);
      if (how !== "bare" && n.visible && (needsCpuBlend(fp.blend) || n.blendIf)) {
        const s = alloc(dst);
        drawNode(s, n, env, o ? { ...o, opacity: 1 } : undefined, { bare: true });
        if (how === "normal") blitBlend(dst, s, Math.min(1, alpha(n) * fp.content), fp.blend, n.blendIf);
        else blitAtop(dst, s, alpha(n) * fp.content, fp.blend, C.copy, n.blendIf);
        give(s);
        return;
      }
      if (how === "normal") return drawNode(dst, n, env, o);
      if (how === "bare") return drawNode(dst, n, env, o, { bare: true });
      // clipped onto the stack so far: source-atop keeps the base's alpha
      if (n.blendMode === "NORMAL") return drawNode(dst, n, env, o, { gco: "source-atop" });
      // blend mode and clipping at once: blend over a copy, then put the copy back atop the stack. Photoshop
      // blends a clipped layer against the base's colour as if the base were opaque (its alpha only masks the
      // result), so the copy is made opaque first, colours kept: drawn onto itself, alpha a → 1−(1−a)², eight
      // times (what is left at the faintest edge is under half a level once masked by that edge's alpha)
      const P = C.copy(dst);
      P.save();
      P.setTransform(1, 0, 0, 1, 0, 0);
      for (let k = 0; k < 8; k++) P.drawImage(P.canvas as CanvasImageSource, 0, 0);
      P.restore();
      drawNode(P, n, env, o);
      blitRaw(dst, P, 1, "source-atop");
      give(P);
    },
    knock(dst, n, op) {
      if (!n.visible || op <= 0 || (n.type === "RASTER" && n.adjust)) return;
      // the node's shape erases the group's surface (destination-out) at its opacity
      dst.save();
      dst.globalAlpha = Math.min(1, op);
      drawNode(dst, n, env, overrides?.get(n.id), { bare: true, gco: "destination-out" });
      dst.restore();
    },
    under(dst, n, op) {
      if (!n.visible || !activeEffects(n.effects).length) return;
      const st = styledNode(dst, n, env, overrides?.get(n.id));
      if (st) for (const b of st.below) blitBlend(dst, b.s, Math.min(1, op * b.opacity), b.blend);
    },
    allocFx(like, fx) {
      const e = Math.ceil(Math.max(maxMargin(effectMargins(fx)), innerReach(fx)) * scaleOf(like)) + 2;
      const o = org(like);
      return surfaceAt(like, o.x - e, o.y - e, like.canvas.width + 2 * e, like.canvas.height + 2 * e);
    },
    applyFx: fxOnSurface,
  };
  return C;
}

const isolated = new WeakSet<Ctx>();
const adjMemo = new WeakMap<readonly SceneNode[], boolean>();
function anyAdjust(nodes: readonly SceneNode[]): boolean {
  let v = adjMemo.get(nodes);
  if (v === undefined) adjMemo.set(nodes, (v = nodes.some((n) => n.type === "RASTER" && !!n.adjust && n.visible)));
  return v;
}

/** Does any node of the list carry effects or a blend mode Canvas2D lacks? (memoized per node list) */
const fxMemo = new WeakMap<readonly SceneNode[], boolean>();
function anyFx(nodes: readonly SceneNode[]): boolean {
  let v = fxMemo.get(nodes);
  if (v === undefined) {
    v = nodes.some((n) => !!n.effects?.length || needsCpuBlend(n.blendMode) || (n.type === "RASTER" && !!n.adjust));
    fxMemo.set(nodes, v);
  }
  return v;
}

/**
 * Paint `nodes` (one page's list, bottom → top) honouring groups and clipping. `include` limits painting to some
 * nodes (a cache tile's) — the structure is still taken from the whole list, so a clip base outside the tile
 * still decides what its clipped layers show.
 */
export function paintNodes(c: Ctx, nodes: readonly SceneNode[], groups: readonly LayerGroup[] | undefined, env: DrawEnv, include: ((n: SceneNode) => boolean) | null, overrides?: Map<string, NodeOverride>) {
  // adjustment layers recolour only what the layers paint, never the page colour below: paint into a transparent
  // surface first, then onto the page (as Photoshop's transparent canvas)
  if (anyAdjust(nodes) && !isolated.has(c)) {
    const L = take(c.canvas.width, c.canvas.height);
    L.setTransform(c.getTransform());
    const o = origin.get(c);
    if (o) origin.set(L, o);
    isolated.add(L);
    try {
      paintNodes(L, nodes, groups, env, include, overrides);
    } finally {
      isolated.delete(L);
    }
    blitRaw(c, L, 1, "source-over");
    give(L);
    return;
  }
  if (!hasStructure(nodes, groups)) {
    const C = anyFx(nodes) ? canvasCompositor(env, overrides) : null;
    for (const n of nodes) {
      if (include && !include(n)) continue;
      if (C && (n.effects?.length || needsCpuBlend(n.blendMode) || (n.type === "RASTER" && n.adjust))) C.leaf(c, n, "normal");
      else drawNode(c, n, env, overrides?.get(n.id));
    }
    return;
  }
  composeItems(buildTree(nodes, groups), c, canvasCompositor(env, overrides), include);
}
