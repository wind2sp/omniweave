// Properties of an adjustment layer (Photoshop's 속성 panel for 명도/대비 · 레벨 · 곡선 · 노출 · 활기 · 색조/채도 · 색상 균형
// · 흑백 …): the sliders change the layer live on the canvas (one undo step when closed with 확인 or a click outside;
// 취소 / Esc puts the settings back, and takes away a layer that was just made). It sits at the right, the canvas stays
// in view.

import { useEffect, useRef, useState } from "react";
import type { Adjustment, Hsl3, LevelsChannel } from "../../core/image/adjustLayer";
import { currentPage, draftPage, useStore } from "../../core/store";
import type { RasterNode } from "../../core/types";
import { useT } from "../../i18n";
import { Modal } from "../shell/Dialogs";
import { Seg } from "../shell/controls";
import { CheckRow, RangeRow, imgStyles } from "../shell/imageControls";
import { CurveEditor } from "../shell/ImageDialog";
import { defaultAdjustment, useAdjUI, type AdjKind } from "./adjustLayers";

const S = () => useStore.getState();

const CH_COLORS = ["var(--text)", "#ff5a5a", "#46c46a", "#4f8bff"];

export function AdjustDialog() {
  const id = useAdjUI((s) => s.id);
  if (!id) return null;
  return <AdjustPanel key={id} id={id} />;
}

function AdjustPanel({ id }: { id: string }) {
  const t = useT();
  const pageId = useRef(S().pageId).current;
  const fresh = useRef(useAdjUI.getState().fresh).current;
  const node = currentPage()?.nodes.find((x) => x.id === id) as RasterNode | undefined;
  const [adj, setAdj] = useState<Adjustment | null>(() => (node?.adjust ? structuredClone(node.adjust.adj) : null));
  const [ch, setCh] = useState(0);
  const [tone, setTone] = useState<"shadows" | "midtones" | "highlights">("midtones");
  const started = useRef(false);

  useEffect(() => {
    // the edit is one gesture: live on the canvas, one history step at the end
    S().beginGesture();
    started.current = true;
    return () => {
      if (started.current) S().endGesture(t("psfeat.adj.hist.edit"));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!node?.adjust || !adj) return null;
  const kind = adj.kind as AdjKind;
  const apply = (next: Adjustment) => {
    setAdj(next);
    S().updateGesture((d) => {
      const n = draftPage(d, pageId)?.nodes.find((x) => x.id === id) as RasterNode | undefined;
      if (n?.adjust) {
        n.adjust.adj = structuredClone(next) as any;
        n.adjust.edited = true;
      }
    });
  };
  const ok = () => {
    started.current = false;
    S().endGesture(t("psfeat.adj.hist.edit"));
    useAdjUI.getState().set({ id: null });
  };
  const cancel = () => {
    started.current = false;
    S().cancelGesture();
    // a layer just made: Cancel takes it away again (as Photoshop's dialog of the same name does)
    if (fresh) S().undo();
    useAdjUI.getState().set({ id: null });
  };
  const set = <K extends Adjustment["kind"]>(f: (a: Extract<Adjustment, { kind: K }>) => void) => {
    const next = structuredClone(adj) as Extract<Adjustment, { kind: K }>;
    f(next);
    apply(next);
  };
  const titleId = "ps-adjust-title";

  const range = (label: string, value: number, min: number, max: number, step: number, on: (v: number) => void, def = 0, unit?: string) => (
    <RangeRow key={label} label={label} value={value} min={min} max={max} step={step} def={def} unit={unit} onChange={on} />
  );

  let body: React.ReactNode = null;
  switch (adj.kind) {
    case "brightness":
      body = (
        <>
          {range(t("psfeat.adj.p.brightness"), adj.brightness, adj.legacy ? -100 : -150, adj.legacy ? 100 : 150, 1, (v) => set<"brightness">((a) => void (a.brightness = v)))}
          {range(t("psfeat.adj.p.contrast"), adj.contrast, adj.legacy ? -100 : -50, 100, 1, (v) => set<"brightness">((a) => void (a.contrast = v)))}
          <CheckRow label={t("psfeat.adj.p.legacy")} checked={adj.legacy} onChange={(v) => set<"brightness">((a) => void (a.legacy = v))} />
        </>
      );
      break;
    case "levels": {
      const c: LevelsChannel = adj.ch[ch] ?? { inLo: 0, inHi: 255, outLo: 0, outHi: 255, gamma: 1 };
      const put = (f: (c: LevelsChannel) => void) =>
        set<"levels">((a) => {
          while (a.ch.length < 4) a.ch.push({ inLo: 0, inHi: 255, outLo: 0, outHi: 255, gamma: 1 });
          f(a.ch[ch]);
        });
      body = (
        <>
          <Seg value={String(ch)} options={["RGB", t("psfeat.adj.ch.r"), t("psfeat.adj.ch.g"), t("psfeat.adj.ch.b")].map((l, i) => ({ value: String(i), label: l }))} onChange={(v) => setCh(Number(v))} ariaLabel={t("psfeat.adj.p.channel")} />
          {range(t("psfeat.adj.p.inLo"), c.inLo, 0, 253, 1, (v) => put((x) => void (x.inLo = Math.min(v, x.inHi - 2))))}
          {range(t("psfeat.adj.p.gamma"), c.gamma, 0.01, 9.99, 0.01, (v) => put((x) => void (x.gamma = v)), 1)}
          {range(t("psfeat.adj.p.inHi"), c.inHi, 2, 255, 1, (v) => put((x) => void (x.inHi = Math.max(v, x.inLo + 2))), 255)}
          {range(t("psfeat.adj.p.outLo"), c.outLo, 0, 255, 1, (v) => put((x) => void (x.outLo = v)))}
          {range(t("psfeat.adj.p.outHi"), c.outHi, 0, 255, 1, (v) => put((x) => void (x.outHi = v)), 255)}
        </>
      );
      break;
    }
    case "curves": {
      const cur = adj.ch.find((x) => x.channel === ch)?.pts ?? [[0, 0], [255, 255]];
      body = (
        <>
          <Seg value={String(ch)} options={["RGB", t("psfeat.adj.ch.r"), t("psfeat.adj.ch.g"), t("psfeat.adj.ch.b")].map((l, i) => ({ value: String(i), label: l }))} onChange={(v) => setCh(Number(v))} ariaLabel={t("psfeat.adj.p.channel")} />
          <CurveEditor
            points={cur.flat()}
            hist={null}
            color={CH_COLORS[ch]}
            onChange={(p) =>
              set<"curves">((a) => {
                const pts: [number, number][] = [];
                for (let i = 0; i + 1 < p.length; i += 2) pts.push([p[i], p[i + 1]]);
                const k = a.ch.find((x) => x.channel === ch);
                if (k) k.pts = pts;
                else a.ch.push({ channel: ch, pts });
              })
            }
          />
          <span style={imgStyles.note}>{t("image.dlg.curveHelp")}</span>
        </>
      );
      break;
    }
    case "exposure":
      body = (
        <>
          {range(t("psfeat.adj.p.exposure"), adj.exposure, -20, 20, 0.01, (v) => set<"exposure">((a) => void (a.exposure = v)))}
          {range(t("psfeat.adj.p.offset"), adj.offset, -0.5, 0.5, 0.0001, (v) => set<"exposure">((a) => void (a.offset = v)))}
          {range(t("psfeat.adj.p.gammaFix"), adj.gamma, 0.01, 9.99, 0.01, (v) => set<"exposure">((a) => void (a.gamma = v)), 1)}
        </>
      );
      break;
    case "vibrance":
      body = (
        <>
          {range(t("psfeat.adj.p.vibrance"), adj.vibrance, -100, 100, 1, (v) => set<"vibrance">((a) => void (a.vibrance = v)))}
          {range(t("psfeat.adj.p.saturation"), adj.saturation, -100, 100, 1, (v) => set<"vibrance">((a) => void (a.saturation = v)))}
        </>
      );
      break;
    case "hueSat": {
      const hsl: Hsl3 = adj.colorize ? adj.colorizeHsl : adj.master;
      const put = (i: number, v: number) => set<"hueSat">((a) => void ((a.colorize ? a.colorizeHsl : a.master)[i] = v));
      body = (
        <>
          {range(t("psfeat.adj.p.hue"), hsl[0], adj.colorize ? 0 : -180, adj.colorize ? 360 : 180, 1, (v) => put(0, v), 0, "°")}
          {range(t("psfeat.adj.p.saturation"), hsl[1], adj.colorize ? 0 : -100, 100, 1, (v) => put(1, v), adj.colorize ? 25 : 0)}
          {range(t("psfeat.adj.p.lightness"), hsl[2], -100, 100, 1, (v) => put(2, v))}
          <CheckRow label={t("psfeat.adj.p.colorize")} checked={adj.colorize} onChange={(v) => set<"hueSat">((a) => void (a.colorize = v))} />
        </>
      );
      break;
    }
    case "colorBalance": {
      const v3 = adj[tone];
      const labels = [t("psfeat.adj.p.cr"), t("psfeat.adj.p.mg"), t("psfeat.adj.p.yb")];
      body = (
        <>
          <Seg
            value={tone}
            options={(["shadows", "midtones", "highlights"] as const).map((k) => ({ value: k, label: t(`psfeat.adj.tone.${k}`) }))}
            onChange={(v) => setTone(v as typeof tone)}
            ariaLabel={t("psfeat.adj.p.tone")}
          />
          {labels.map((l, i) => range(l, v3[i], -100, 100, 1, (v) => set<"colorBalance">((a) => void (a[tone][i] = v))))}
          <CheckRow label={t("psfeat.adj.p.preserveLum")} checked={adj.preserveLum} onChange={(v) => set<"colorBalance">((a) => void (a.preserveLum = v))} />
        </>
      );
      break;
    }
    case "blackWhite":
      body = (
        <>
          {(["red", "yellow", "green", "cyan", "blue", "magenta"] as const).map((k) => range(t(`psfeat.adj.bw.${k}`), adj[k], -200, 300, 1, (v) => set<"blackWhite">((a) => void (a[k] = v)), defaultAdjustment("blackWhite")[k as never] as number, "%"))}
          <CheckRow label={t("psfeat.adj.p.tint")} checked={!!adj.tint} onChange={(v) => set<"blackWhite">((a) => void (a.tint = v ? [225, 211, 179] : null))} />
          {adj.tint && (
            <input
              type="color"
              aria-label={t("psfeat.adj.p.tintColor")}
              value={"#" + adj.tint.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("")}
              onChange={(e) => {
                const v = parseInt(e.target.value.slice(1), 16);
                set<"blackWhite">((a) => void (a.tint = [(v >> 16) & 255, (v >> 8) & 255, v & 255]));
              }}
            />
          )}
        </>
      );
      break;
    case "posterize":
      body = range(t("psfeat.adj.p.levels"), adj.levels, 2, 255, 1, (v) => set<"posterize">((a) => void (a.levels = v)), 4);
      break;
    case "threshold":
      body = range(t("psfeat.adj.p.threshold"), adj.level, 1, 255, 1, (v) => set<"threshold">((a) => void (a.level = v)), 128);
      break;
    case "invert":
      body = <span style={imgStyles.note}>{t("image.dlg.noParams")}</span>;
      break;
    default:
      body = <span style={imgStyles.note}>{t("psfeat.adj.notEditable")}</span>;
  }

  return (
    <Modal onClose={ok} labelledBy={titleId} className="ps-adjust">
      <style>{".modal-backdrop:has(> .ps-adjust){align-items:flex-start;justify-content:flex-end;padding:88px 300px 0 0;background:transparent;backdrop-filter:none}.modal.ps-adjust{width:320px;max-width:320px}"}</style>
      <div style={{ padding: "14px 16px 0" }}>
        <h2 id={titleId} style={{ fontSize: "var(--fs-title, 16px)", margin: 0 }}>
          {t("psfeat.adj.props", { kind: t(`psfeat.adj.${kind}`) })}
        </h2>
        <span style={imgStyles.note}>{node.name}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "12px 16px", maxHeight: "60vh", overflowY: "auto" }}>{body}</div>
      <div style={imgStyles.foot}>
        <button type="button" className="btn btn-ghost" onClick={() => apply(defaultAdjustment(kind))}>
          {t("image.dlg.defaults")}
        </button>
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
