// The layers panel's mask thumbnail (Photoshop): beside the layer thumbnail of a layer with a layer mask, and the
// thumbnail of an adjustment layer (its mask). Click: the mask is the paint target (framed); Shift+click: mask off /
// on (a red cross while off); Alt+click: the mask alone on the canvas. An adjustment layer's double-click opens its
// properties. Also the panel foot's buttons: add a mask (Alt: hiding), new adjustment layer (a menu).

import { useEffect, useRef, useState } from "react";
import { maskPlane } from "../../core/image/layerMask";
import { findPage, useStore } from "../../core/store";
import type { SceneNode } from "../../core/types";
import { useT } from "../../i18n";
import { ctx2d } from "../../render/draw";
import { IconBtn } from "../shell/controls";
import { ADJ_KINDS, editAdjustment, newAdjustmentLayer } from "./adjustLayers";
import { addLayerMask, maskOf, targetMask, toggleLayerMask, toggleMaskView, useMaskUI } from "./maskActions";
import { hasPixelSelection } from "../pixelSelect";

const BOX = 30;

export function LayerMaskThumb({ node }: { node: SceneNode }) {
  const t = useT();
  const ref = useRef<HTMLCanvasElement>(null);
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const edit = useMaskUI((s) => s.edit === node.id);
  const view = useMaskUI((s) => s.view === node.id);
  const m = maskOf(node);
  const pw = page?.width ?? 1, ph = page?.height ?? 1;
  const k = Math.min(BOX / pw, BOX / ph);
  const w = Math.max(4, Math.round(pw * k)), h = Math.max(4, Math.round(ph * k));
  useEffect(() => {
    const cv = ref.current;
    if (!cv || !m || node.type !== "RASTER") return;
    const id = requestAnimationFrame(() => {
      cv.width = w;
      cv.height = h;
      const g = ctx2d(cv) as CanvasRenderingContext2D;
      // the page area in the layer's own pixels, sampled down
      const img = g.createImageData(w, h);
      const tr = node.transform;
      const sx = tr.scale || 1, sy = tr.scaleY ?? tr.scale ?? 1;
      const lx = Math.floor(-tr.x / sx), ly = Math.floor(-tr.y / sy);
      const lw = Math.max(1, Math.ceil(pw / sx)), lh = Math.max(1, Math.ceil(ph / sy));
      const plane = lw * lh <= 25_000_000 ? maskPlane(m, lx, ly, lw, lh) : null;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const v = plane ? plane[Math.min(lh - 1, Math.floor((y / h) * lh)) * lw + Math.min(lw - 1, Math.floor((x / w) * lw))] : m.hide ? 255 : 0;
          const o = (y * w + x) * 4;
          img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
          img.data[o + 3] = 255;
        }
      g.putImageData(img, 0, 0);
    });
    return () => cancelAnimationFrame(id);
  }, [m?.tiles, m?.hide, w, h, node, pw, ph]);
  if (!m || node.type !== "RASTER") return null;
  const off = !node.adjust && !!node.mask?.off;
  const adj = !!node.adjust;
  return (
    <span
      className="layer-mask-thumb"
      role="button"
      tabIndex={-1}
      aria-pressed={edit || adj}
      title={adj ? t("psfeat.mask.thumbAdjTip") : t("psfeat.mask.thumbTip")}
      onClick={(e) => {
        e.stopPropagation();
        if (e.altKey) return toggleMaskView(node.id);
        if (e.shiftKey && !adj) return toggleLayerMask(node.id);
        targetMask(node.id, true);
      }}
      onDoubleClick={adj ? (e) => (e.stopPropagation(), editAdjustment(node.id)) : undefined}
      style={{ position: "relative", display: "inline-flex", marginLeft: 2, outline: edit || view ? "2px solid var(--accent, #4f7cff)" : "1px solid var(--line-2)", outlineOffset: 1, borderRadius: 2, cursor: "pointer" }}
    >
      <canvas ref={ref} aria-hidden="true" style={{ width: `calc(${w}px * var(--ui-scale, 1))`, height: `calc(${h}px * var(--ui-scale, 1))`, display: "block" }} />
      {off && (
        <svg viewBox="0 0 10 10" aria-hidden="true" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
          <path d="M1 1L9 9M9 1L1 9" stroke="#e5484d" strokeWidth="1.4" />
        </svg>
      )}
    </span>
  );
}

/** An adjustment layer's own thumbnail: the half-moon of Photoshop's panel (double-click opens its properties). */
export function AdjustIcon({ node }: { node: SceneNode }) {
  const t = useT();
  if (node.type !== "RASTER" || !node.adjust) return null;
  return (
    <span className="layer-adj-icon" title={t("psfeat.adj.thumbTip")} onDoubleClick={(e) => (e.stopPropagation(), editAdjustment(node.id))} onClick={(e) => (e.stopPropagation(), targetMask(node.id, false))} style={{ display: "inline-flex", width: 22, height: 22, alignItems: "center", justifyContent: "center", cursor: "pointer" }}>
      <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
        <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M10 2.5a7.5 7.5 0 0 1 0 15z" fill="currentColor" />
      </svg>
    </span>
  );
}

/** The panel foot's mask and adjustment buttons. */
export function LayerFootButtons() {
  const t = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if ((e.target as HTMLElement)?.closest?.(".ps-adj-menu")) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);
  return (
    <>
      <IconBtn icon="mask" tip={t("psfeat.mask.addTip")} onClick={(e) => void addLayerMask(hasPixelSelection() ? (e.altKey ? "hideSelection" : "revealSelection") : e.altKey ? "hide" : "reveal")} />
      <IconBtn
        icon="adjustLayer"
        tip={t("psfeat.adj.addTip")}
        haspopup="menu"
        expanded={!!menu}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.top });
        }}
      />
      {menu && (
        <div className="menu-pop ps-adj-menu" role="menu" style={{ position: "fixed", left: menu.x, bottom: window.innerHeight - menu.y + 4, zIndex: 1000 }}>
          {ADJ_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                setMenu(null);
                newAdjustmentLayer(k);
              }}
            >
              <span className="menu-label">{t(`psfeat.adj.${k}`)}…</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
