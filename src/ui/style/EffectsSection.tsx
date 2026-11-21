// Effects section of the one property panel (design ch. 7.1 section 5): the same list and editors for every
// selectable object — text boxes (also while being edited), shapes, images, raster layers, groups. Photoshop's
// names and units. A drag (slider, colour well) previews live and is one undo step when it ends.

import { useRef, useState } from "react";
import { draftPage, useStore } from "../../core/store";
import { setEffects } from "../../core/style/effects";
import { CAP_FORMATS, type CapFormat } from "../../core/style/caps";
import type { Effect, EffectType, StyleBlend } from "../../core/style/types";
import type { LayerGroup, NodeType, SceneNode } from "../../core/types";
import { useT } from "../../i18n";
import { CapBadge } from "./sections";
import { ColorPicker, liveEdit, type ColorPhase } from "./ColorPicker";
import { addEffect, addableEffects, effectColorOf, effectParams, panelOrder, paramPatch, paramValue, patchEffect, removeEffect, reorderEffect, toggleEffect, withEffectColor, type FxParam } from "./effectsModel";

/** Blend modes offered for effects (all drawn by every renderer; Photoshop's most used). */
export const FX_BLENDS: readonly StyleBlend[] = ["NORMAL", "MULTIPLY", "SCREEN", "OVERLAY", "DARKEN", "LIGHTEN", "COLOR_BURN", "COLOR_DODGE", "LINEAR_DODGE", "SOFT_LIGHT", "HARD_LIGHT"];

export interface EffectsSectionProps {
  effects: readonly Effect[];
  onChange: (fx: Effect[], phase: ColorPhase) => void;
  /** original format of the page, for the capability badge */
  format?: CapFormat;
  node?: NodeType;
}

/** Number with a slider: dragging previews ("live"), letting go commits once; typing commits. */
function ParamRow({ label, p, value, onChange }: { label: string; p: FxParam; value: number; onChange: (v: number, phase: ColorPhase) => void }) {
  const drag = useRef(liveEdit()).current;
  const end = (v: number) => drag.end() && onChange(v, "commit");
  return (
    <label className="fx-param">
      <span className="fx-param-label">{label}</span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.unit === "%" ? 1 : 0.5}
        value={value}
        aria-label={label}
        onChange={(e) => {
          drag.live();
          onChange(+e.target.value, "live");
        }}
        onPointerUp={(e) => end(+(e.target as HTMLInputElement).value)}
        onKeyUp={(e) => end(+(e.target as HTMLInputElement).value)}
        onBlur={(e) => end(+e.target.value)}
      />
      <input
        type="number"
        className="fx-num"
        min={p.min}
        max={p.max}
        value={value}
        aria-label={label}
        onChange={(e) => Number.isFinite(+e.target.value) && onChange(+e.target.value, "commit")}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span className="st-unit">{p.unit}</span>
    </label>
  );
}

function EffectEditor({ e, onChange }: { e: Effect; onChange: (next: Effect, phase: ColorPhase) => void }) {
  const t = useT();
  const color = effectColorOf(e);
  const set = (patch: Record<string, unknown>, phase: ColorPhase) => onChange(patchEffect([e], 0, patch)[0], phase);
  return (
    <div className="fx-editor">
      {color && <ColorPicker value={color} label={t("fx.param.color")} showAlpha={false} onChange={(c, phase) => c && onChange(withEffectColor(e, c), phase)} />}
      {e.type !== "softEdge" && e.type !== "bevel" && e.type !== "fxStroke" && (
        <label className="fx-param">
          <span className="fx-param-label">{t("fx.param.blend")}</span>
          <select value={e.blend ?? "NORMAL"} aria-label={t("fx.param.blend")} onChange={(ev) => set({ blend: ev.target.value }, "commit")}>
            {FX_BLENDS.map((b) => (
              <option key={b} value={b}>
                {t(`fx.blend.${b}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {e.type === "fxStroke" && (
        <label className="fx-param">
          <span className="fx-param-label">{t("fx.param.position")}</span>
          <select value={e.stroke.align ?? "outside"} aria-label={t("fx.param.position")} onChange={(ev) => set({ stroke: { ...e.stroke, align: ev.target.value } }, "commit")}>
            {(["outside", "inside", "center"] as const).map((a) => (
              <option key={a} value={a}>
                {t(`fx.position.${a}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {e.type === "innerGlow" && (
        <label className="fx-param">
          <span className="fx-param-label">{t("fx.param.source")}</span>
          <select value={e.source ?? "edge"} aria-label={t("fx.param.source")} onChange={(ev) => set({ source: ev.target.value }, "commit")}>
            {(["edge", "center"] as const).map((a) => (
              <option key={a} value={a}>
                {t(`fx.source.${a}`)}
              </option>
            ))}
          </select>
        </label>
      )}
      {effectParams(e).map((p) => (
        <ParamRow key={p.key} label={t(`fx.param.${p.key}`)} p={p} value={paramValue(e, p)} onChange={(v, phase) => set(paramPatch(e, p, v), phase)} />
      ))}
      {e.type === "bevel" && <p className="st-note">{t("fx.note.bevel")}</p>}
    </div>
  );
}

export function EffectsSection({ effects, onChange, format, node }: EffectsSectionProps) {
  const t = useT();
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState<EffectType | "">("");
  const fx = [...effects];
  return (
    <section className="st-section fx-section" aria-label={t("fx.title")}>
      <header className="st-section-head">
        <span>{t("fx.title")}</span>
        <select
          className="fx-add"
          value={adding}
          aria-label={t("fx.add")}
          onChange={(ev) => {
            const type = ev.target.value as EffectType;
            setAdding("");
            if (!type) return;
            const next = addEffect(fx, type);
            setOpen(next.length - 1);
            onChange(next, "commit");
          }}
        >
          <option value="">{t("fx.add")}</option>
          {addableEffects().map((k) => (
            <option key={k} value={k}>
              {t(`fx.type.${k}`)}
            </option>
          ))}
        </select>
      </header>
      {!fx.length && <p className="st-note">{t("fx.none")}</p>}
      <ul className="fx-list">
        {panelOrder(fx).map((i) => {
          const e = fx[i];
          const name = t(`fx.type.${e.type}`);
          return (
            <li key={i} className={"fx-item" + (e.on ? "" : " off") + (open === i ? " open" : "")}>
              <div className="fx-row">
                <input type="checkbox" checked={e.on} aria-label={t("fx.toggle", { name })} onChange={() => onChange(toggleEffect(fx, i), "commit")} />
                <button type="button" className="fx-name" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                  {name}
                </button>
                <CapBadge prop={`fx.${e.type}`} format={format} node={node} />
                <button type="button" className="ibtn ibtn-sm" aria-label={t("fx.up")} data-tip={t("fx.up")} onClick={() => onChange(reorderEffect(fx, i, 1), "commit")}>
                  ▲
                </button>
                <button type="button" className="ibtn ibtn-sm" aria-label={t("fx.down")} data-tip={t("fx.down")} onClick={() => onChange(reorderEffect(fx, i, -1), "commit")}>
                  ▼
                </button>
                <button
                  type="button"
                  className="ibtn ibtn-sm"
                  aria-label={t("fx.remove", { name })}
                  data-tip={t("fx.remove", { name })}
                  onClick={() => {
                    setOpen(null);
                    onChange(removeEffect(fx, i), "commit");
                  }}
                >
                  ✕
                </button>
              </div>
              {open === i && <EffectEditor e={e} onChange={(next, phase) => onChange(fx.map((x, k) => (k === i ? next : x)), phase)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ───────── store wiring ─────────

const S = () => useStore.getState();

/** The current page's original format when the capability table covers it. */
function useCapFormat(): CapFormat | undefined {
  const f = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId)?.source?.format);
  return f && (CAP_FORMATS as readonly string[]).includes(f) ? (f as CapFormat) : undefined;
}

/** Commit / live-preview an effect list on nodes or a group: one undo step per finished gesture. */
export function effectsWriter(target: { nodes: string[] } | { group: string }, label: string) {
  let inGesture = false;
  const apply = (d: any, fx: Effect[]) => {
    const pg = draftPage(d, S().pageId);
    if (!pg) return;
    if ("nodes" in target) pg.nodes.forEach((n: SceneNode) => target.nodes.includes(n.id) && setEffects(n, fx));
    else {
      const g = pg.groups?.find((x: LayerGroup) => x.id === target.group);
      if (g) setEffects(g, fx);
    }
  };
  return (fx: Effect[], phase: ColorPhase) => {
    if (phase === "live") {
      if (!inGesture) {
        S().beginGesture();
        inGesture = true;
      }
      S().updateGesture((d) => apply(d, fx));
      return;
    }
    if (inGesture) {
      S().updateGesture((d) => apply(d, fx));
      S().endGesture(label);
      inGesture = false;
      return;
    }
    S().commit(label, (d) => apply(d, fx));
  };
}

/** The Effects section for the selected nodes (the first one's list is shown; edits apply to all). */
export function NodeEffects({ nodes }: { nodes: SceneNode[] }) {
  const t = useT();
  const fmt = useCapFormat();
  const ids = nodes.map((n) => n.id).join(",");
  const writer = useRef<{ key: string; w: ReturnType<typeof effectsWriter> } | null>(null);
  if (!writer.current || writer.current.key !== ids) writer.current = { key: ids, w: effectsWriter({ nodes: nodes.map((n) => n.id) }, t("fx.undo")) };
  return <EffectsSection effects={nodes[0]?.effects ?? []} onChange={writer.current.w} format={fmt} node={nodes.length === 1 ? nodes[0].type : undefined} />;
}

/** The Effects section for a layer group. */
export function GroupEffects({ group }: { group: LayerGroup }) {
  const t = useT();
  const fmt = useCapFormat();
  const writer = useRef<{ key: string; w: ReturnType<typeof effectsWriter> } | null>(null);
  if (!writer.current || writer.current.key !== group.id) writer.current = { key: group.id, w: effectsWriter({ group: group.id }, t("fx.undo")) };
  return <EffectsSection effects={group.effects ?? []} onChange={writer.current.w} format={fmt} />;
}
