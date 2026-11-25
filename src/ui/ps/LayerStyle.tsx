// Photoshop's 레이어 스타일 dialog and the layers panel's extra fields:
//   레이어 › 레이어 스타일 › 혼합 옵션 (or a double-click on the layer row's empty part / its fx mark): 혼합 옵션 — blend
//   mode, opacity, 칠 불투명도, 내부 효과를 그룹으로 혼합, 녹아웃, 혼합 조건(이 레이어 / 밑에 있는 레이어, Alt+drag splits a
//   handle into two) — beside the effects list with each effect's settings; live on the canvas, one undo step (확인),
//   취소 puts everything back.
//   The panel bar: 칠 (fill opacity) and the locks 투명 픽셀 · 이미지 픽셀 · 위치 next to the full lock.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { currentPage, draftPage, useStore } from "../../core/store";
import type { BlendMode, SceneNode } from "../../core/types";
import type { Effect } from "../../core/style/types";
import { setEffects } from "../../core/style/effects";
import { useT } from "../../i18n";
import { Modal } from "../shell/Dialogs";
import { IconBtn, NumField, Select } from "../shell/controls";
import { nodeLive } from "../shell/ops";
import { updateSelected } from "../actions";
import { BLEND_OPTIONS } from "../shell/Ribbon";
import { EffectsSection } from "../style/EffectsSection";
import { RangeRow, imgStyles } from "../shell/imageControls";

const S = () => useStore.getState();

export const useLayerStyleUI = create<{ id: string | null; set: (id: string | null) => void }>((set) => ({ id: null, set: (id) => set({ id }) }));

/** Open the Layer Style dialog on the selected layer (or `id`). */
export function openLayerStyle(id?: string) {
  const n = id ?? S().selection[0];
  if (!n) return;
  S().set({ selection: [n] });
  useLayerStyleUI.getState().set(n);
}

type Opts = Pick<SceneNode, "blendMode" | "opacity" | "fillOpacity" | "fillInterior" | "knockout" | "blendIf" | "effects">;

export function LayerStyleDialog() {
  const id = useLayerStyleUI((s) => s.id);
  if (!id) return null;
  return <LayerStyleBody key={id} id={id} />;
}

function LayerStyleBody({ id }: { id: string }) {
  const t = useT();
  const pageId = useRef(S().pageId).current;
  const node = currentPage()?.nodes.find((n) => n.id === id);
  const [o, setO] = useState<Opts | null>(() => (node ? { blendMode: node.blendMode, opacity: node.opacity, fillOpacity: node.fillOpacity, fillInterior: node.fillInterior, knockout: node.knockout, blendIf: node.blendIf?.slice(), effects: node.effects?.slice() } : null));
  const live = useRef(false);
  const [chan, setChan] = useState(0);
  useEffect(() => {
    S().beginGesture();
    live.current = true;
    return () => {
      if (live.current) S().endGesture(t("psfeat.style.hist"));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!node || !o) return null;
  const apply = (next: Opts) => {
    setO(next);
    S().updateGesture((d) => {
      const n = draftPage(d, pageId)?.nodes.find((x) => x.id === id) as SceneNode | undefined;
      if (!n) return;
      n.blendMode = next.blendMode;
      n.opacity = next.opacity;
      if ((next.fillOpacity ?? 1) < 1) n.fillOpacity = next.fillOpacity;
      else delete n.fillOpacity;
      if (next.fillInterior) n.fillInterior = true;
      else delete n.fillInterior;
      if (next.knockout) n.knockout = next.knockout;
      else delete n.knockout;
      const open = !next.blendIf || next.blendIf.every((x, i) => (i % 4 < 2 ? x === 0 : x === 255));
      if (open) delete n.blendIf;
      else n.blendIf = next.blendIf!.slice();
      setEffects(n, (next.effects ?? []) as Effect[]);
    });
  };
  const ok = () => {
    live.current = false;
    S().endGesture(t("psfeat.style.hist"));
    useLayerStyleUI.getState().set(null);
  };
  const cancel = () => {
    live.current = false;
    S().cancelGesture();
    useLayerStyleUI.getState().set(null);
  };
  // Blend If per channel (0 grey, 1 red, 2 green, 3 blue): 8 values each — this layer's black from / to, white from /
  // to, then the underlying layer's
  const full = (): number[] => {
    const b = (o.blendIf ?? []).slice();
    while (b.length < 32) b.push([0, 0, 255, 255][b.length % 4]);
    return b;
  };
  const bif = full();
  const setRange = (at: number, four: [number, number, number, number]) => {
    const b = full();
    b.splice(at, 4, ...four);
    apply({ ...o, blendIf: b });
  };
  const titleId = "ps-style-title";
  return (
    <Modal onClose={ok} labelledBy={titleId} className="ps-style">
      <style>{".modal-backdrop:has(> .ps-style){align-items:flex-start;justify-content:flex-end;padding:72px 300px 0 0;background:transparent;backdrop-filter:none}.modal.ps-style{width:640px;max-width:640px}"}</style>
      <div style={{ padding: "14px 16px 0" }}>
        <h2 id={titleId} style={{ margin: 0, fontSize: "var(--fs-title, 16px)" }}>{t("psfeat.style.title")}</h2>
        <span style={imgStyles.note}>{node.name}</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, padding: "12px 16px", maxHeight: "64vh", overflowY: "auto" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <strong style={{ fontSize: "var(--fs-ui)" }}>{t("psfeat.style.blending")}</strong>
          <div className="tools-opt">
            <span>{t("ribbon.blendMode")}</span>
            <Select<BlendMode> value={o.blendMode} options={BLEND_OPTIONS} width={150} onChange={(v) => apply({ ...o, blendMode: v })} />
          </div>
          <RangeRow label={t("ribbon.opacity")} value={Math.round(o.opacity * 100)} min={0} max={100} step={1} unit="%" def={100} onChange={(v) => apply({ ...o, opacity: v / 100 })} />
          <RangeRow label={t("psfeat.style.fill")} value={Math.round((o.fillOpacity ?? 1) * 100)} min={0} max={100} step={1} unit="%" def={100} onChange={(v) => apply({ ...o, fillOpacity: v / 100 })} />
          <label style={imgStyles.check}>
            <input type="checkbox" checked={!!o.fillInterior} onChange={(e) => apply({ ...o, fillInterior: e.target.checked || undefined })} />
            {t("psfeat.style.interior")}
          </label>
          <div className="tools-opt">
            <span>{t("psfeat.style.knockout")}</span>
            <Select<"none" | "shallow" | "deep"> value={o.knockout ?? "none"} width={110} options={(["none", "shallow", "deep"] as const).map((v) => ({ value: v, label: t(`psfeat.style.ko.${v}`) }))} onChange={(v) => apply({ ...o, knockout: v === "none" ? undefined : v })} />
          </div>
          <strong style={{ fontSize: "var(--fs-ui)", marginTop: 6 }}>{t("psfeat.style.blendIf")}</strong>
          <span style={imgStyles.note}>{t("psfeat.style.blendIfNote")}</span>
          <div className="tools-opt">
            <span>{t("psfeat.style.channel")}</span>
            <Select<string> value={String(chan)} width={110} options={["gray", "red", "green", "blue"].map((c, i) => ({ value: String(i), label: t(`psfeat.style.ch.${c}`) }))} onChange={(v) => setChan(Number(v))} />
          </div>
          {(["this", "under"] as const).map((who, w) => {
            const at = chan * 8 + w * 4;
            return (
              <div key={who} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span style={imgStyles.note}>
                  {t(`psfeat.style.${who}`)}: {bif[at] === bif[at + 1] ? bif[at] : `${bif[at]}/${bif[at + 1]}`} · {bif[at + 2] === bif[at + 3] ? bif[at + 2] : `${bif[at + 2]}/${bif[at + 3]}`}
                </span>
                <BlendIfBar values={[bif[at], bif[at + 1], bif[at + 2], bif[at + 3]]} channel={chan} label={t(`psfeat.style.${who}`)} onChange={(v) => setRange(at, v)} />
              </div>
            );
          })}
        </div>
        <div>
          <EffectsSection effects={(o.effects ?? []) as Effect[]} onChange={(fx) => apply({ ...o, effects: fx })} node={node.type} />
        </div>
      </div>
      <div style={imgStyles.foot}>
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-ghost" onClick={cancel}>
          {t("image.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={ok}>
          {t("psfeat.ok")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * One Blend If slider (Photoshop): a gradient bar with a black and a white handle. A handle moves as one; Alt+drag
 * pulls the half under the pointer away from its other half (a soft range); the black stays left of the white.
 */
export function BlendIfBar({ values, channel, label, onChange }: { values: [number, number, number, number]; channel: number; label: string; onChange: (v: [number, number, number, number]) => void }) {
  const ref = useRef<SVGSVGElement>(null);
  const drag = useRef<{ idx: number; alt: boolean } | null>(null);
  const W = 256;
  const col = ["#fff", "#ff4040", "#40d060", "#4080ff"][channel] ?? "#fff";
  const at = (e: { clientX: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(255, ((e.clientX - r.left) / r.width) * 255)));
  };
  const move = (v: number) => {
    const d = drag.current;
    if (!d) return;
    const n = values.slice() as [number, number, number, number];
    const black = d.idx < 2;
    if (d.alt) n[d.idx] = v;
    else if (black) {
      const w = n[1] - n[0];
      n[0] = v - (d.idx === 1 ? w : 0);
      n[1] = n[0] + w;
    } else {
      const w = n[3] - n[2];
      n[2] = v - (d.idx === 3 ? w : 0);
      n[3] = n[2] + w;
    }
    // order: 0 ≤ black from ≤ black to ≤ white from ≤ white to ≤ 255
    for (let i = 0; i < 4; i++) n[i] = Math.max(0, Math.min(255, n[i]));
    if (n[0] > n[1]) black ? (n[1] = n[0]) : (n[0] = n[1]);
    if (n[2] > n[3]) black ? (n[3] = n[2]) : (n[2] = n[3]);
    if (n[1] > n[2]) black ? (n[2] = Math.max(n[2], n[1])) : (n[1] = Math.min(n[1], n[2]));
    if (n[2] > n[3]) n[3] = n[2];
    if (n[0] > n[1]) n[0] = n[1];
    onChange(n);
  };
  const tri = (x: number, fill: string, half: "l" | "r" | "both") => {
    const p = half === "l" ? `${x},10 ${x - 6},20 ${x},20` : half === "r" ? `${x},10 ${x},20 ${x + 6},20` : `${x},10 ${x - 6},20 ${x + 6},20`;
    return <polygon points={p} fill={fill} stroke="#888" strokeWidth={0.8} />;
  };
  const x = (v: number) => (v / 255) * W;
  const [b0, b1, w0, w1] = values;
  return (
    <svg
      ref={ref}
      viewBox={`-8 0 ${W + 16} 22`}
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={255}
      aria-valuenow={b1}
      style={{ width: "100%", height: 28, touchAction: "none", cursor: "ew-resize" }}
      onPointerDown={(e) => {
        const v = at(e);
        // the nearest half (Alt: the half itself; else its handle)
        const d = [b0, b1, w0, w1].map((h) => Math.abs(h - v));
        let idx = d.indexOf(Math.min(...d));
        if (!e.altKey && idx === 2 && b1 === w0 && v < w0) idx = 1;
        drag.current = { idx, alt: e.altKey };
        (e.target as Element).setPointerCapture?.(e.pointerId);
      }}
      onPointerMove={(e) => drag.current && move(at(e))}
      onPointerUp={() => (drag.current = null)}
    >
      <defs>
        <linearGradient id={`bif-g-${channel}`}>
          <stop offset="0" stopColor="#000" />
          <stop offset="1" stopColor={col} />
        </linearGradient>
      </defs>
      <rect x={0} y={1} width={W} height={8} fill={`url(#bif-g-${channel})`} stroke="var(--line-2)" />
      {b0 === b1 ? tri(x(b0), "#000", "both") : tri(x(b0), "#000", "l")}
      {b0 !== b1 && tri(x(b1), "#000", "r")}
      {w0 === w1 ? tri(x(w0), "#fff", "both") : tri(x(w0), "#fff", "l")}
      {w0 !== w1 && tri(x(w1), "#fff", "r")}
    </svg>
  );
}

/** The layers panel's second bar: 칠 and the partial locks of the selected layer (image mode). */
export function LayerLockBar() {
  const t = useT();
  const n = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId)?.nodes.find((x) => s.selection.includes(x.id)));
  return (
    <div className="layer-bar" role="toolbar" aria-label={t("psfeat.lock.bar")}>
      <LayerBarExtras n={n} />
    </div>
  );
}

/** The panel bar's 칠 field and partial locks (image mode). */
export function LayerBarExtras({ n }: { n: SceneNode | undefined }) {
  const t = useT();
  const off = !n;
  const lock = (k: "lockAlpha" | "lockPixels" | "lockPosition", label: string) =>
    n && updateSelected(label, (x) => {
      if (x[k]) delete x[k];
      else x[k] = true;
    });
  return (
    <>
      <NumField icon="opacity" label={t("psfeat.style.fillShort")} tip={t("psfeat.style.fill")} value={n ? n.fillOpacity ?? 1 : null} scale={100} min={0} max={100} unit="%" width={78} disabled={off} live={nodeLive(t("psfeat.style.fill"), (x: SceneNode, v: number) => (v >= 1 ? delete x.fillOpacity : (x.fillOpacity = v)))} />
      <IconBtn icon="lockAlpha" size="sm" pressed={!!n?.lockAlpha} disabled={off} tip={t("psfeat.lock.alphaTip")} onClick={() => lock("lockAlpha", t("psfeat.lock.alpha"))} />
      <IconBtn icon="brush" size="sm" pressed={!!n?.lockPixels} disabled={off} tip={t("psfeat.lock.pixelsTip")} onClick={() => lock("lockPixels", t("psfeat.lock.pixelsName"))} />
      <IconBtn icon="lockMove" size="sm" pressed={!!n?.lockPosition} disabled={off} tip={t("psfeat.lock.positionTip")} onClick={() => lock("lockPosition", t("psfeat.lock.position"))} />
    </>
  );
}
