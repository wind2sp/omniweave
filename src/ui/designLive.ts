// The design mode's live appearance on the selection (Illustrator, design 2, 2026-11-24): the Effect menu's vector
// effects (Round Corners, Offset Path, Transform) and its Drop Shadow / Outer Glow, the Appearance panel's eye / edit /
// delete, Object › Expand Appearance, live corners, stroke align / profile / dashes, and the eyedropper (I) that copies
// one object's appearance to the selection. The drawing of all of it is core/liveVector.ts.

import { create } from "zustand";
import { currentPage, draftPage, useStore } from "../core/store";
import { newGroup, uid, type SceneNode, type VectorNode } from "../core/types";
import { liveParts, newVectorFx, type VectorFx, type VectorFxKind } from "../core/liveVector";
import { addEffect } from "./style/effectsModel";
import type { EffectType } from "../core/style/types";
import { t } from "../i18n";
import { useUI } from "./shell/uiStore";

const S = () => useStore.getState();

/** The selected, unlocked paths. */
export function selVectors(): VectorNode[] {
  const page = currentPage();
  const sel = new Set(S().selection);
  return (page?.nodes ?? []).filter((n): n is VectorNode => n.type === "VECTOR" && sel.has(n.id) && !n.locked);
}

/** Change every selected path (one undo step). */
export function editVectors(label: string, f: (n: VectorNode) => void): number {
  const page = currentPage();
  const ids = selVectors().map((v) => v.id);
  if (!page || !ids.length) return 0;
  S().commit(label, (d) => {
    for (const n of draftPage(d, page.id)?.nodes ?? []) if (ids.includes(n.id) && n.type === "VECTOR") f(n as VectorNode);
  });
  return ids.length;
}

// ───────── vector effects (Effect menu) ─────────

/** The effect dialog: which effect, and the index in `vfx` when an existing one is edited (null = a new one). */
export const useFxDialog = create<{ kind: VectorFxKind; index: number | null; init: VectorFx | null }>(() => ({ kind: "roundCorners", index: null, init: null }));

export function openFxDialog(kind: VectorFxKind, index: number | null = null) {
  const n = selVectors()[0];
  const init = index != null && n?.vfx?.[index]?.kind === kind ? n.vfx[index] : null;
  useFxDialog.setState({ kind, index, init });
  useUI.getState().set({ shellDialog: "designFx" });
}

/** Add `fx` to the selected paths, or replace their effect at `index`. */
export function applyVectorFx(fx: VectorFx, index: number | null): number {
  return editVectors(t(`design.fx.hist.${fx.kind}`), (n) => {
    const list = [...(n.vfx ?? [])];
    if (index != null && list[index]?.kind === fx.kind) list[index] = { ...fx };
    else list.push({ ...fx });
    n.vfx = list as VectorFx[];
  });
}

export function toggleVectorFx(index: number): number {
  return editVectors(t("design.fx.hist.toggle"), (n) => {
    const f = n.vfx?.[index];
    if (f) n.vfx = n.vfx!.map((x, i) => (i === index ? ({ ...x, on: !x.on } as VectorFx) : x));
  });
}

export function removeVectorFx(index: number): number {
  return editVectors(t("design.fx.hist.remove"), (n) => {
    if (!n.vfx) return;
    const list = n.vfx.filter((_, i) => i !== index);
    if (list.length) n.vfx = list;
    else delete n.vfx;
  });
}

/** Effect › Stylize › Drop Shadow / Outer Glow: the layer effect (core/style/effects.ts), editable in the effects panel. */
export function addLayerFx(type: EffectType): number {
  const page = currentPage();
  const ids = S().selection.filter((id) => page?.nodes.some((n) => n.id === id && !n.locked));
  if (!page || !ids.length) return 0;
  S().commit(t(`design.fx.hist.${type}`), (d) => {
    for (const n of draftPage(d, page.id)?.nodes ?? []) if (ids.includes(n.id)) n.effects = addEffect(n.effects, type) as any;
  });
  return ids.length;
}

export const newFx = newVectorFx;

// ───────── Object › Expand Appearance ─────────

export const hasLiveAppearance = () => selVectors().some((v) => !!liveParts(v));

/**
 * Object › Expand Appearance: each selected live path becomes the plain paths it draws (its corners, aligned or
 * profiled stroke, pattern and live effects baked); layer effects move onto a group around the result.
 */
export function expandLiveAppearance(): number {
  const page = currentPage();
  if (!page) return 0;
  const made = new Map<string, { parts: VectorNode[]; group: ReturnType<typeof newGroup> | null }>();
  for (const v of selVectors()) {
    const parts = liveParts(v);
    if (!parts) continue;
    const ps: VectorNode[] = parts.filter((q) => (q.fill || (q.stroke && q.strokeWidth > 0)) && q.contours.length).map((q, i) => ({ ...q, id: i ? uid("n") : v.id, name: i ? `${v.name} ${i + 1}` : v.name }));
    for (const q of ps) delete (q as Partial<SceneNode>).effects;
    const group = v.effects?.length && ps.length > 1 ? { ...newGroup(v.name, v.groupId ?? null), effects: v.effects } : null;
    if (group) for (const q of ps) q.groupId = group.id;
    else if (v.effects?.length && ps[0]) ps[0].effects = v.effects;
    made.set(v.id, { parts: ps, group });
  }
  if (!made.size) return 0;
  S().commit(t("design.fx.hist.expand"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    for (const [id, { parts, group }] of made) {
      const i = pg.nodes.findIndex((n) => n.id === id);
      if (i >= 0) pg.nodes.splice(i, 1, ...(parts as any));
      if (group) pg.groups = [...(pg.groups ?? []), group] as any;
    }
  });
  S().set({ selection: [...made.values()].flatMap((m) => m.parts.map((q) => q.id)) });
  return made.size;
}

// ───────── live corners ─────────

export function setCornerRadius(r: number): number {
  return editVectors(t("design.corner.hist"), (n) => {
    delete n.cornerRadii;
    if (r > 0.01) n.cornerRadius = r;
    else delete n.cornerRadius;
  });
}

// ───────── eyedropper (I) ─────────

const APPEARANCE: (keyof VectorNode)[] = ["fill", "stroke", "strokeWidth", "fillRule", "strokeCap", "strokeJoin", "strokeDash", "strokeAlign", "widthProfile", "vfx", "patternFill", "opacity", "blendMode", "effects"];

/**
 * The design mode's eyedropper: a click on a path copies its appearance (fill, stroke and its settings, live effects,
 * opacity) to the selected paths — Illustrator's default; Shift copies only the colour under the pointer to the front
 * swatch. With nothing selected the picked paint becomes the new shapes' default. Returns false off any object.
 */
export function eyedropFrom(src: SceneNode | undefined, onlyColour: "fill" | "stroke" | null): boolean {
  if (!src) return false;
  const targets = selVectors().filter((v) => v.id !== src.id);
  if (src.type === "TEXT") {
    const c = src.paragraphs?.[0]?.runs?.[0]?.color;
    if (!c) return false;
    if (!targets.length) S().set({ fill: c });
    else editVectors(t("design.eyedrop.hist"), (n) => void (n.fill = c));
    return true;
  }
  if (src.type !== "VECTOR") return false;
  if (!targets.length) {
    S().set({ ...(src.fill ? { fill: src.fill } : {}), ...(src.stroke ? { stroke: src.stroke } : {}) });
    S().notify(t("design.eyedrop.msg.default"));
    return true;
  }
  const ids = targets.map((v) => v.id);
  const page = currentPage()!;
  S().commit(t("design.eyedrop.hist"), (d) => {
    for (const n of draftPage(d, page.id)?.nodes ?? []) {
      if (!ids.includes(n.id) || n.type !== "VECTOR") continue;
      if (onlyColour) {
        (n as VectorNode)[onlyColour] = (src as VectorNode).fill ?? (src as VectorNode).stroke;
        continue;
      }
      for (const k of APPEARANCE) {
        const v = (src as unknown as Record<string, unknown>)[k];
        if (v === undefined) delete (n as unknown as Record<string, unknown>)[k];
        else (n as unknown as Record<string, unknown>)[k] = JSON.parse(JSON.stringify(v));
      }
    }
  });
  return true;
}
