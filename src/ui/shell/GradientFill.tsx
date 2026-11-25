// The fill's kind and gradient editor of the design mode's properties (Illustrator's Gradient panel): solid, linear or
// radial; the gradient's colour stops on a bar (click a stop for its colour, drag it along, click the bar to add one,
// double-click a stop to remove it — two stay), its angle (linear) and a reverse button. A vector keeps the gradient
// in `fills` (the writers' and the canvas's gradient) and its plain colour stand-in in `fill`.

import { useRef } from "react";
import { gradientFallbackHex } from "../../core/style/paint";
import type { GradientStop, Paint } from "../../core/style/types";
import type { VectorNode } from "../../core/types";
import { useT } from "../../i18n";
import { updateSelected } from "../actions";
import { ColorField, IconBtn, NumField, Seg } from "./controls";
import { nodeLive } from "./ops";

export type GradPaint = Extract<Paint, { type: "gradient" }>;
type FillKind = "solid" | "linear" | "radial";
type WithFills = VectorNode & { fills?: Paint[] };

export const gradientOf = (n: VectorNode): GradPaint | null => {
  const f = (n as WithFills).fills?.[0];
  return f?.type === "gradient" && (f.kind === "linear" || f.kind === "radial") ? f : null;
};

/** The linear gradient's direction (degrees, counter-clockwise from left → right, as Illustrator) from its ends. */
export const angleOf = (g: GradPaint) => {
  const a = (Math.atan2(-(g.to[1] - g.from[1]), g.to[0] - g.from[0]) * 180) / Math.PI;
  return Math.round(a * 10) / 10 || 0;
};
/** A linear gradient's ends across the box at `deg` (centred, reaching the box's edges along that line). */
export function endsAt(deg: number): { from: [number, number]; to: [number, number] } {
  const r = (deg * Math.PI) / 180, dx = Math.cos(r) / 2, dy = -Math.sin(r) / 2;
  return { from: [0.5 - dx, 0.5 - dy], to: [0.5 + dx, 0.5 + dy] };
}

/** Put `g` on the node as its fill (null: back to the plain colour `solid`). */
export function applyGradient(x: WithFills, g: GradPaint | null, solid?: string | null) {
  if (!g) {
    delete x.fills;
    if (solid !== undefined) x.fill = solid;
    return;
  }
  const stops = [...g.stops].sort((a, b) => a.at - b.at);
  x.fills = [{ ...g, stops }];
  x.fill = gradientFallbackHex(stops);
}

/** A new gradient from the node's colour: Illustrator's default white → black, or the colour → white. */
export function newGradient(kind: "linear" | "radial", from: string | null): GradPaint {
  const c = from && /^#[0-9a-f]{6}$/i.test(from) && from.toLowerCase() !== "#ffffff" ? from : "#ffffff";
  const stops: GradientStop[] = [{ at: 0, color: { hex: c } }, { at: 1, color: { hex: c === "#ffffff" ? "#000000" : "#ffffff" } }];
  return kind === "linear" ? { type: "gradient", kind, stops, ...endsAt(0) } : { type: "gradient", kind, stops, from: [0.5, 0.5], to: [1, 0.5] };
}

const css = (g: GradPaint) => `linear-gradient(90deg, ${[...g.stops].sort((a, b) => a.at - b.at).map((s) => `${s.color.hex} ${Math.round(s.at * 100)}%`).join(", ")})`;

export function GradientFill({ node }: { node: VectorNode }) {
  const t = useT();
  const g = gradientOf(node);
  const kind: FillKind = g ? (g.kind as FillKind) : "solid";
  const bar = useRef<HTMLDivElement>(null);
  const edit = (label: string, f: (g: GradPaint) => GradPaint | null) =>
    updateSelected(label, (x) => {
      if (x.type !== "VECTOR") return;
      const cur = gradientOf(x) ?? newGradient("linear", x.fill);
      applyGradient(x, f(JSON.parse(JSON.stringify(cur)) as GradPaint));
    });
  const setKind = (k: FillKind) =>
    updateSelected(t("design.grad.kind"), (x) => {
      if (x.type !== "VECTOR") return;
      const cur = gradientOf(x);
      if (k === "solid") return applyGradient(x, null, cur ? cur.stops[0].color.hex : x.fill);
      const base = cur ? { ...JSON.parse(JSON.stringify(cur)) as GradPaint, kind: k } : newGradient(k, x.fill);
      if (k === "radial") Object.assign(base, { from: [0.5, 0.5], to: [1, 0.5] });
      else if (cur?.kind !== "linear") Object.assign(base, endsAt(0));
      applyGradient(x, base);
    });
  const posAt = (clientX: number) => {
    const r = bar.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  };
  const dragStop = (i: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const live = nodeLive<number>(t("design.grad.stop"), (x: WithFills, at: number) => {
      const cur = gradientOf(x);
      if (!cur) return;
      const stops = cur.stops.map((s, j) => (j === i ? { ...s, at } : s));
      x.fills = [{ ...cur, stops }];
      x.fill = gradientFallbackHex([...stops].sort((a, b) => a.at - b.at));
    });
    const x0 = e.clientX;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      if (!moved) live.begin?.();
      moved = true;
      live.live?.(posAt(ev.clientX));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (moved) live.end?.();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div className="grad-fill">
      <Seg<FillKind>
        value={kind}
        ariaLabel={t("design.grad.kind")}
        onChange={setKind}
        options={[
          { value: "solid", label: t("design.grad.solid") },
          { value: "linear", label: t("design.grad.linear") },
          { value: "radial", label: t("design.grad.radial") },
        ]}
      />
      {g && (
        <>
          <div
            ref={bar}
            className="grad-bar"
            role="group"
            aria-label={t("design.grad.stops")}
            data-tip={t("design.grad.barTip")}
            style={{ background: css(g), position: "relative", height: 16, borderRadius: 3, margin: "8px 6px 26px", cursor: "copy", border: "1px solid var(--border, #555)" }}
            onPointerDown={(e) => {
              // a click on the bar adds a stop there in the gradient's colour at that point
              const at = posAt(e.clientX);
              edit(t("design.grad.addStop"), (cur) => {
                const s = [...cur.stops].sort((a, b) => a.at - b.at);
                const right = s.find((x) => x.at >= at) ?? s[s.length - 1];
                const left = [...s].reverse().find((x) => x.at <= at) ?? s[0];
                // the colour the gradient already has there (Illustrator)
                const k = right.at > left.at ? (at - left.at) / (right.at - left.at) : 0;
                const mix = (i: number) => Math.round(parseInt(left.color.hex.slice(i, i + 2), 16) * (1 - k) + parseInt(right.color.hex.slice(i, i + 2), 16) * k).toString(16).padStart(2, "0");
                const hex = /^#[0-9a-f]{6}$/i.test(left.color.hex) && /^#[0-9a-f]{6}$/i.test(right.color.hex) ? `#${mix(1)}${mix(3)}${mix(5)}` : right.color.hex;
                cur.stops.push({ at: Math.round(at * 1000) / 1000, color: { hex } });
                return cur;
              });
            }}
          >
            {g.stops.map((s, i) => (
              <span
                key={i}
                className="grad-stop"
                style={{ position: "absolute", left: `calc(${s.at * 100}% - 8px)`, top: 17, cursor: "ew-resize" }}
                onPointerDown={(e) => dragStop(i, e)}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  if (g.stops.length > 2) edit(t("design.grad.removeStop"), (cur) => ((cur.stops = cur.stops.filter((_, j) => j !== i)), cur));
                }}
                data-tip={t("design.grad.stopTip", { at: Math.round(s.at * 100) })}
              >
                <ColorField
                  value={s.color.hex}
                  live={nodeLive<string>(t("design.grad.stop"), (x: WithFills, v: string) => {
                    const cur = gradientOf(x);
                    if (!cur) return;
                    const stops = cur.stops.map((st, j) => (j === i ? { ...st, color: { ...st.color, hex: v } } : st));
                    x.fills = [{ ...cur, stops }];
                    x.fill = gradientFallbackHex([...stops].sort((a, b) => a.at - b.at));
                  })}
                />
              </span>
            ))}
          </div>
          <span className="btn-row">
            {g.kind === "linear" && (
              <NumField
                label={t("design.grad.angle")}
                tip={t("design.grad.angle")}
                value={angleOf(g)}
                min={-180}
                max={180}
                unit="°"
                width={74}
                live={nodeLive<number>(t("design.grad.angle"), (x: WithFills, v: number) => {
                  const cur = gradientOf(x);
                  if (cur) x.fills = [{ ...cur, ...endsAt(v) }];
                })}
              />
            )}
            <IconBtn icon="swapArrows" size="sm" tip={t("design.grad.reverse")} onClick={() => edit(t("design.grad.reverse"), (cur) => ((cur.stops = cur.stops.map((s) => ({ ...s, at: 1 - s.at }))), cur))} />
          </span>
        </>
      )}
    </div>
  );
}
