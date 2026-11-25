// Photoshop's toning tools (O, Shift+O steps through them): 닷지 (dodge) lightens, 번 (burn) darkens — each on the
// 어두운 영역 · 중간 영역 · 밝은 영역 the options bar picks, at its 노출 (exposure) — and 스펀지 (sponge) takes colour
// out or puts it in (채도 감소 · 채도 증가) at its 흐름 (flow). Painted with the brush's size and hardness like the
// clone stamp (ui/ps/canvasExt.ts): one undo step a stroke, inside the pixel selection when there is one.

import { create } from "zustand";
import type { Vec2 } from "../../core/types";
import type { PixelTile, RasterNode } from "../../core/types";
import { tilesToImg } from "../../core/image/pixels";
import { useStore } from "../../core/store";
import { TILE } from "../../core/tile";
import { t, useT } from "../../i18n";
import { NumField, Select } from "../shell/controls";
import { plainLive } from "../shell/ops";
import { DabStroke, type Box } from "./dabs";

const S = () => useStore.getState();

export type ToneRange = "shadows" | "midtones" | "highlights";
export type SpongeMode = "desaturate" | "saturate";
export const TONE_TOOLS = new Set<string>(["dodge", "burn", "sponge"]);

export const useToning = create<{ range: ToneRange; exposure: number; sponge: SpongeMode; spongeFlow: number; set: (p: Partial<{ range: ToneRange; exposure: number; sponge: SpongeMode; spongeFlow: number }>) => void }>((set) => ({
  // Photoshop's defaults: 중간 영역, 노출 50 %; the sponge 채도 감소 at 흐름 50 %
  range: "midtones",
  exposure: 0.5,
  sponge: "desaturate",
  spongeFlow: 0.5,
  set: (p) => set(p),
}));

/** how much a pixel of luminance l (0…1) is in the range (Photoshop's tonal ranges overlap softly) */
export function rangeWeight(range: ToneRange, l: number): number {
  if (range === "shadows") return (1 - l) * (1 - l);
  if (range === "highlights") return l * l;
  return Math.max(0, 1 - Math.abs(2 * l - 1) * Math.abs(2 * l - 1));
}

/**
 * One pixel (r, g, b 0…255) toned at strength a (0…1: coverage × exposure): dodge moves each channel toward white,
 * burn toward black, by the range's weight of the pixel's luminance; the sponge changes the saturation and keeps the
 * lightness (HSL, as Photoshop's sponge: a desaturated red goes toward a mid grey, not darker).
 */
export function tonePixel(tool: "dodge" | "burn" | "sponge", rgb: [number, number, number], a: number, o: { range: ToneRange; sponge: SpongeMode }): [number, number, number] {
  const [r, g, b] = rgb;
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  if (tool === "sponge") {
    // the channels move toward (desaturate) or away from (saturate) the HSL lightness, the hue kept
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let k = o.sponge === "saturate" ? 1 + a : 1 - a;
    if (k > 1) {
      // saturating stops where a channel reaches 0 or 255
      const room = Math.min(...[r, g, b].map((c) => (c > l ? (255 - l) / (c - l || 1) : c < l ? l / (l - c || 1) : Infinity)));
      k = Math.min(k, room);
    }
    const f = (c: number) => Math.max(0, Math.min(255, Math.round(l + (c - l) * k)));
    return [f(r), f(g), f(b)];
  }
  const w = rangeWeight(o.range, y / 255) * a;
  const f = tool === "dodge" ? (c: number) => Math.round(c + (255 - c) * w) : (c: number) => Math.round(c * (1 - w));
  return [f(r), f(g), f(b)];
}

/**
 * The drag of a toning tool on pixel layer `n`. `paint` hands the result tiles back (canvasExt.ts's tilesFrom /
 * setTiles: the layer's untouched tiles keep their identity).
 */
export function tonePaint(
  n: RasterNode,
  tool: "dodge" | "burn" | "sponge",
  ctx: { box: Box; size: number; sel: Float32Array | null; tb: (b: Box) => { ox: number; oy: number; width: number; height: number }; commit: (cur: ReturnType<typeof tilesToImg>, keys: Iterable<string>, tiles: Record<string, PixelTile>) => void; begin: () => void; end: (label: string) => void },
) {
  const { box, sel } = ctx;
  const s = S();
  const st = useToning.getState();
  const strength = tool === "sponge" ? st.spongeFlow : st.exposure;
  const img0 = tilesToImg(n.tiles, ctx.tb(box));
  const cur = tilesToImg(n.tiles, ctx.tb(box));
  const stroke = new DabStroke(box, n.transform, ctx.size, s.brush.hardness, s.brush.flow ?? 1);
  const tiles: Record<string, PixelTile> = { ...n.tiles };
  const W = box.w;
  ctx.begin();
  let raf = 0;
  const flush = () => {
    raf = 0;
    const keys = stroke.takeDirty();
    if (!keys.length) return;
    for (const key of keys) {
      const u = key.indexOf("_");
      const ox = +key.slice(0, u) * TILE - box.x, oy = +key.slice(u + 1) * TILE - box.y;
      for (let r = 0; r < TILE; r++)
        for (let c = 0; c < TILE; c++) {
          const i = (oy + r) * W + ox + c;
          const a = Math.min(1, stroke.cov[i]) * strength * (sel ? sel[i] : 1);
          if (a <= 0) continue;
          const o = i * 4;
          if (!img0.data[o + 3]) continue;
          const out = tonePixel(tool, [img0.data[o], img0.data[o + 1], img0.data[o + 2]], a, st);
          cur.data[o] = out[0];
          cur.data[o + 1] = out[1];
          cur.data[o + 2] = out[2];
        }
    }
    ctx.commit(cur, keys, tiles);
  };
  const queue = () => void (raf ||= requestAnimationFrame(flush));
  return {
    move(p: Vec2, e: PointerEvent) {
      stroke.add(p[0], p[1], e.pointerType === "pen" ? e.pressure || 0.5 : 1);
      queue();
    },
    up() {
      if (raf) cancelAnimationFrame(raf);
      flush();
      ctx.end(t(`psfeat.hist.${tool}`));
    },
  };
}

/** The options bar's toning part: 범위 and 노출 (dodge / burn), 모드 and 흐름 (sponge). */
export function ToningExtras({ tool }: { tool: string }) {
  const tr = useT();
  const st = useToning();
  if (tool === "sponge")
    return (
      <>
        <Select<SpongeMode>
          tip={tr("psfeat.tone.mode")}
          value={st.sponge}
          width={120}
          onChange={(v) => st.set({ sponge: v })}
          options={[
            { value: "desaturate", label: tr("psfeat.tone.desaturate") },
            { value: "saturate", label: tr("psfeat.tone.saturate") },
          ]}
        />
        <NumField icon="opacity" tip={tr("psfeat.tone.flow")} label={tr("psfeat.tone.flow")} value={st.spongeFlow} scale={100} min={1} max={100} unit="%" width={84} live={plainLive((v) => st.set({ spongeFlow: v }))} />
      </>
    );
  return (
    <>
      <Select<ToneRange>
        tip={tr("psfeat.tone.range")}
        value={st.range}
        width={120}
        onChange={(v) => st.set({ range: v })}
        options={[
          { value: "shadows", label: tr("psfeat.tone.shadows") },
          { value: "midtones", label: tr("psfeat.tone.midtones") },
          { value: "highlights", label: tr("psfeat.tone.highlights") },
        ]}
      />
      <NumField icon="opacity" tip={tr("psfeat.tone.exposure")} label={tr("psfeat.tone.exposure")} value={st.exposure} scale={100} min={1} max={100} unit="%" width={84} live={plainLive((v) => st.set({ exposure: v }))} />
    </>
  );
}
