// Rulers along the top and left of the canvas. Ticks follow the zoom (core/units rulerSteps), the
// unit follows the page (mm for documents / PDF, px elsewhere) unless chosen in the corner menu,
// and the mouse position and the selection's extent are marked. Drag out of a ruler to make a
// guide; drop a guide back on a ruler to delete it.

import { useEffect, useRef } from "react";
import { unionRect, type Rect } from "../core/geom";
import { nodeBounds } from "../core/loom";
import { currentPage, findPage, useStore } from "../core/store";
import { UNITS, UNIT_LABEL, rulerSteps, rulerTicks, type Tick } from "../core/units";
import { cadOf, cadRulerTicks } from "./cad";
import { RULER, addGuideAt, snapIndexFor, snapOn, snapTol, unitFor, useAids } from "./aids";
import { snapAxis } from "../core/snap";
import { Menu } from "./shell/controls";
import { useUI } from "./shell/uiStore";
import { useLang, useT } from "../i18n";
import { useRichStatus } from "./RichTextEditor";
import { editUnit, useEditMode } from "./editModes";
import { docModeNow } from "./docView";
import { applyIndent, docOrigin, docRulerUnitFor, drawIndentMarks, hitIndent, indentMarks, paintDocBand, snapIndent, type IndentHandle } from "./docRuler";
import { hairCss, snapStroke } from "../render/crisp";

const S = () => useStore.getState();

function cssVar(name: string, fallback: string) {
  if (typeof document === "undefined") return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function Rulers() {
  const t = useT();
  const top = useRef<HTMLCanvasElement>(null);
  const left = useRef<HTMLCanvasElement>(null);
  const frame = useRef(0);
  const unitSetting = useUI((s) => s.rulerUnit);
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const doc = useEditMode() === "DOCUMENT";
  useLang((s) => s.lang);
  const unit = doc ? docRulerUnitFor(unitSetting) : unitSetting === "auto" ? editUnit(page) : unitSetting;
  /** an indent marker being dragged on the top ruler (document mode) */
  const indentDrag = useRef<{ h: IndentHandle; pos: number } | null>(null);
  const repaint = useRef<() => void>(() => {});

  useEffect(() => {
    const paint = () => {
      frame.current = 0;
      const ct = top.current, cl = left.current;
      const wrap = ct?.parentElement;
      if (!ct || !cl || !wrap) return;
      const dpr = window.devicePixelRatio || 1;
      const W = wrap.clientWidth, H = wrap.clientHeight;
      for (const [c, w, h] of [
        [ct, W - RULER, RULER],
        [cl, RULER, H - RULER],
      ] as const) {
        const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
        if (c.width !== pw || c.height !== ph) {
          c.width = pw;
          c.height = ph;
          // CSS size = backing / dpr, so the ruler is shown 1:1 on device pixels (no resampling blur at 125 %)
          c.style.width = `${pw / dpr}px`;
          c.style.height = `${ph / dpr}px`;
        }
      }
      const s = S();
      const page = currentPage();
      const { zoom, panX, panY } = s.view;
      // document mode (docRuler.ts): cm / in from the margin, margins shaded, paragraph indent markers
      const doc = !!page && docModeNow();
      const u = doc ? docRulerUnitFor(useUI.getState().rulerUnit) : unitFor(page);
      const steps = rulerSteps(zoom, u);
      const bg = cssVar("--bg-1", "#16171c"), fg = cssVar("--text-2", "#a9adb9"), line = cssVar("--line-2", "#33363f");
      const pageBg = cssVar("--bg-2", "#1e2027"), accent = cssVar("--accent", "#2f6fdc");
      const band = { margin: cssVar("--ruler-margin", "#1c1e24"), body: cssVar("--ruler-body", "#2f323b") };
      const marks = doc ? indentMarks() : null;
      // selected text in a document is shown by its indent markers, not as an object extent
      const sel = page && !doc ? page.nodes.filter((n) => s.selection.includes(n.id)).reduce<Rect | null>((a, n) => unionRect(a, nodeBounds(n)), null) : null;
      const cur = useAids.getState().cursor;

      const draw = (c: HTMLCanvasElement, horizontal: boolean) => {
        const g = c.getContext("2d")!;
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const len = horizontal ? W - RULER : H - RULER;
        const pan = horizontal ? panX : panY;
        // canvas px of page coordinate v, along this ruler (the ruler starts RULER px into the canvas)
        const at = (v: number) => v * zoom + pan - RULER;
        g.fillStyle = bg;
        g.fillRect(0, 0, horizontal ? len : RULER, horizontal ? RULER : len);
        if (page) {
          g.fillStyle = pageBg;
          const a = at(0), b = at(horizontal ? page.width : page.height);
          if (horizontal) g.fillRect(a, 0, b - a, RULER);
          else g.fillRect(0, a, RULER, b - a);
        }
        if (doc) {
          // word-processor ruler: shaded margins, numbers counted from the margin, ticks in the middle of the band
          paintDocBand(g, horizontal, at, band, dpr);
          const o = docOrigin(horizontal);
          const sv = (RULER - pan) / zoom - o, ev = (RULER + len - pan) / zoom - o;
          const dt = rulerTicks(sv, ev, steps);
          const halfSub = steps.sub % 2 === 0 ? steps.sub / 2 : 0;
          g.strokeStyle = fg;
          g.fillStyle = fg;
          g.lineWidth = hairCss(dpr); // ticks, marks and edges on whole device pixels (render/crisp.ts)
          g.font = "11px Pretendard, 'Segoe UI', sans-serif";
          g.textAlign = "center";
          g.textBaseline = "middle";
          g.beginPath();
          for (const tk of dt) {
            const p = snapStroke(at(tk.pos + o), dpr);
            if (tk.major) {
              if (!tk.label || Math.abs(tk.pos) < 1e-6) continue;
              const label = tk.label.replace(/^-/, "");
              if (horizontal) g.fillText(label, p, RULER / 2 + 0.5);
              else {
                g.save();
                g.translate(RULER / 2, p);
                g.rotate(-Math.PI / 2);
                g.fillText(label, 0, 0.5);
                g.restore();
              }
              continue;
            }
            const idx = Math.round(tk.pos / (steps.major / steps.sub));
            const size = halfSub && ((idx % steps.sub) + steps.sub) % steps.sub === halfSub ? 7 : 3;
            const c0 = RULER / 2 - size / 2, c1 = RULER / 2 + size / 2;
            if (horizontal) {
              g.moveTo(p, c0);
              g.lineTo(p, c1);
            } else {
              g.moveTo(c0, p);
              g.lineTo(c1, p);
            }
          }
          g.stroke();
          g.textAlign = "start";
          if (horizontal && marks) drawIndentMarks(g, at, marks, fg, bg, indentDrag.current, dpr);
          if (cur) {
            const p = snapStroke(at(horizontal ? cur[0] : cur[1]), dpr);
            g.strokeStyle = accent;
            g.beginPath();
            if (horizontal) {
              g.moveTo(p, 0);
              g.lineTo(p, 3);
            } else {
              g.moveTo(0, p);
              g.lineTo(3, p);
            }
            g.stroke();
          }
          if (horizontal && indentDrag.current) {
            // the line the dragged indent will move to
            g.strokeStyle = accent;
            g.beginPath();
            const p = snapStroke(at(indentDrag.current.pos), dpr);
            g.moveTo(p, 0);
            g.lineTo(p, RULER);
            g.stroke();
          }
          g.strokeStyle = line;
          g.beginPath();
          const edge = snapStroke(RULER - hairCss(dpr) / 2, dpr);
          if (horizontal) {
            g.moveTo(0, edge);
            g.lineTo(len, edge);
          } else {
            g.moveTo(edge, 0);
            g.lineTo(edge, len);
          }
          g.stroke();
          return;
        }
        if (sel) {
          g.fillStyle = accent + "40";
          const a = at(horizontal ? sel.x : sel.y), b = at(horizontal ? sel.x + sel.w : sel.y + sel.h);
          if (horizontal) g.fillRect(a, 0, Math.max(1, b - a), RULER);
          else g.fillRect(0, a, RULER, Math.max(1, b - a));
        }
        const startV = (RULER - pan) / zoom, endV = (RULER + len - pan) / zoom;
        g.strokeStyle = fg;
        g.fillStyle = fg;
        g.lineWidth = hairCss(dpr);
        g.font = "11px Pretendard, 'Segoe UI', sans-serif"; // --fs-ruler (the only UI text under 12px: the ruler band is 20px)
        g.textBaseline = "top";
        g.beginPath();
        // drawing pages (DXF / DWG): drawing coordinates, y upwards (ui/cad.ts)
        const cad = cadOf(page);
        const ticks: (Tick & { mid?: boolean })[] = cad ? cadRulerTicks(cad, startV, endV, zoom, horizontal) : rulerTicks(startV, endV, steps);
        const half = steps.sub % 2 === 0 ? steps.sub / 2 : 0;
        ticks.forEach((t) => {
          const p = snapStroke(at(t.pos), dpr);
          const idx = Math.round(t.pos / (steps.major / steps.sub));
          const size = t.major ? RULER : (t.mid ?? (half && ((idx % steps.sub) + steps.sub) % steps.sub === half)) ? RULER * 0.45 : RULER * 0.25;
          if (horizontal) {
            g.moveTo(p, RULER);
            g.lineTo(p, RULER - size);
          } else {
            g.moveTo(RULER, p);
            g.lineTo(RULER - size, p);
          }
        });
        g.stroke();
        for (const t of ticks) {
          if (!t.major || !t.label) continue;
          const p = Math.round(at(t.pos));
          if (horizontal) g.fillText(t.label, p + 3, 2);
          else {
            g.save();
            g.translate(2, p + 3);
            g.rotate(Math.PI / 2);
            g.textBaseline = "bottom";
            g.fillText(t.label, 0, 0);
            g.restore();
          }
        }
        if (cur) {
          const p = snapStroke(at(horizontal ? cur[0] : cur[1]), dpr);
          g.strokeStyle = accent;
          g.beginPath();
          if (horizontal) {
            g.moveTo(p, 0);
            g.lineTo(p, RULER);
          } else {
            g.moveTo(0, p);
            g.lineTo(RULER, p);
          }
          g.stroke();
        }
        g.strokeStyle = line;
        g.beginPath();
        if (horizontal) {
          g.moveTo(0, RULER - 0.5);
          g.lineTo(len, RULER - 0.5);
        } else {
          g.moveTo(RULER - 0.5, 0);
          g.lineTo(RULER - 0.5, len);
        }
        g.stroke();
      };
      draw(ct, true);
      draw(cl, false);
    };
    const invalidate = () => {
      if (!frame.current) frame.current = requestAnimationFrame(paint);
    };
    invalidate();
    const u1 = useStore.subscribe((s, p) => (s.view !== p.view || s.pageId !== p.pageId || s.selection !== p.selection || s.doc !== p.doc) && invalidate());
    const u2 = useAids.subscribe((s, p) => s.cursor !== p.cursor && invalidate());
    const u3 = useUI.subscribe(invalidate);
    // the indent markers follow the caret's paragraph and the edit mode
    const u4 = useRichStatus.subscribe(invalidate);
    const u5 = useStore.subscribe((s, p) => (s.editingTextId !== p.editingTextId || s.mode !== p.mode) && invalidate());
    repaint.current = invalidate;
    const ro = new ResizeObserver(invalidate);
    if (top.current?.parentElement) ro.observe(top.current.parentElement);
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      ro.disconnect();
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    };
  }, []);

  // ───────── pull a guide out of a ruler ─────────
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>, axis: "x" | "y") => {
    e.stopPropagation();
    if (e.button !== 0) return;
    // document mode: the top ruler drags paragraph indents; rulers make no guides (Word / 한글)
    if (doc) {
      // keep the caret (and the text selection) in the text being edited
      e.preventDefault();
      if (axis === "y") indentDown(e);
      return;
    }
    const ui = useUI.getState();
    if (ui.guidesLocked) return S().notify(t("ribbon.msg.guidesLocked"));
    if (!ui.guides) ui.set({ guides: true });
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const wrap = el.parentElement!;
    const ix = snapIndexFor();
    const pos = (ev: PointerEvent | React.PointerEvent) => {
      const r = wrap.getBoundingClientRect();
      const sx = ev.clientX - r.left, sy = ev.clientY - r.top;
      const { zoom, panX, panY } = S().view;
      let v = axis === "x" ? (sx - panX) / zoom : (sy - panY) / zoom;
      if (snapOn(ev)) {
        const h = snapAxis(axis === "x" ? ix.xs : ix.ys, ix.grid, [v], snapTol());
        if (h) v += h.delta;
      }
      const overRuler = axis === "x" ? sx < RULER : sy < RULER;
      const outside = sx < 0 || sy < 0 || sx > r.width || sy > r.height;
      return { v, overRuler: overRuler || outside };
    };
    useAids.getState().set({ guideDrag: { axis, from: null, ...pos(e) } });
    const move = (ev: PointerEvent) => useAids.getState().set({ guideDrag: { axis, from: null, ...pos(ev) } });
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const p = pos(ev);
      useAids.getState().set({ guideDrag: null });
      if (ev.type === "pointerup" && !p.overRuler) addGuideAt(axis, p.v);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  /** Drag an indent marker of the top ruler (document mode); applied as one undo step on release. */
  const indentDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const m = indentMarks();
    if (!m) return;
    const el = e.currentTarget;
    const r0 = el.getBoundingClientRect();
    const { zoom, panX } = S().view;
    const at = (v: number) => v * zoom + panX - RULER;
    const h = hitIndent(m, at, e.clientX - r0.left, e.clientY - r0.top);
    if (!h) return;
    el.setPointerCapture(e.pointerId);
    const o = docOrigin(true);
    const u = docRulerUnitFor(useUI.getState().rulerUnit);
    const pos = (ev: PointerEvent | React.PointerEvent) => {
      const v = (ev.clientX - el.getBoundingClientRect().left + RULER - S().view.panX) / S().view.zoom;
      return ev.altKey ? v : snapIndent(v, o, u);
    };
    indentDrag.current = { h, pos: pos(e) };
    repaint.current();
    const move = (ev: PointerEvent) => {
      indentDrag.current = { h, pos: pos(ev) };
      repaint.current();
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      const d = indentDrag.current;
      indentDrag.current = null;
      if (ev.type === "pointerup" && d) applyIndent(d.h, m, d.pos);
      repaint.current();
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  // double-click a ruler in a document: page setup (margins), as in Word
  const onDbl = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (doc) useUI.getState().set({ shellDialog: "pageSetup" });
  };

  return (
    <>
      <canvas ref={top} className="ruler ruler-top" style={{ left: RULER, height: RULER }} onPointerDown={(e) => onDown(e, "y")} onDoubleClick={onDbl} data-tip={doc ? t("docmode.ruler.topTip") : t("ribbon.ruler.topTip")} />
      <canvas ref={left} className="ruler ruler-left" style={{ top: RULER, width: RULER }} onPointerDown={(e) => onDown(e, "x")} onDoubleClick={onDbl} data-tip={doc ? t("docmode.ruler.leftTip") : t("ribbon.ruler.leftTip")} />
      <div className="ruler-corner" style={{ width: RULER, height: RULER }} onPointerDown={(e) => e.stopPropagation()}>
        <Menu
          className="ruler-unit"
          tip={t("ribbon.ruler.unit")}
          button={<span>{unit}</span>}
          items={() => [
            { heading: t("ribbon.ruler.unit") },
            { label: t("ribbon.ruler.auto"), checked: unitSetting === "auto", onSelect: () => useUI.getState().set({ rulerUnit: "auto" }) },
            { sep: true },
            ...UNITS.map((u) => ({ label: t(`ribbon.unit.${u}`, undefined, UNIT_LABEL[u]), checked: unitSetting === u, onSelect: () => useUI.getState().set({ rulerUnit: u }) })),
          ]}
        />
      </div>
    </>
  );
}
