// Layers panel parts of the image (Photoshop) and design (Illustrator) modes: layer thumbnails, the blend mode /
// opacity bar above the list, and Alt+click on an eye to show that layer alone.

import { useEffect, useRef } from "react";
import { findPage, useStore } from "../../core/store";
import type { SceneNode } from "../../core/types";
import { ctx2d, drawNode, type DrawEnv } from "../../render/draw";
import { updateNodes, updateSelected } from "../actions";
import { useT, t } from "../../i18n";
import { IconBtn, NumField, Select } from "./controls";
import { nodeLive } from "./ops";
import { BLEND_OPTIONS } from "./Ribbon";

const S = () => useStore.getState();

/** Thumbnail box, CSS px (the canvas backing store is twice that for sharp HiDPI thumbnails). */
const BOX = 30;

/** The layer drawn alone over the whole canvas, fitted in a small box — Photoshop's layer thumbnail. */
export function LayerThumb({ node }: { node: SceneNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const page = useStore((s) => findPage(s.doc, s.pageId));
  const pw = page?.width ?? 1, ph = page?.height ?? 1;
  const k = Math.min(BOX / pw, BOX / ph);
  const w = Math.max(4, Math.round(pw * k)), h = Math.max(4, Math.round(ph * k));
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    let alive = true;
    const draw = () => {
      if (!alive) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
      const g = ctx2d(cv) as CanvasRenderingContext2D;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, cv.width, cv.height);
      g.setTransform(k * dpr, 0, 0, k * dpr, 0, 0);
      const env: DrawEnv = { doc: S().doc, clip: { x: 0, y: 0, w: pw, h: ph }, scale: k * dpr, incomplete: false, onResourceReady: () => requestAnimationFrame(draw) };
      // hidden layers still show what they hold (the eye says they are hidden)
      drawNode(g, node.visible ? node : { ...node, visible: true }, env, undefined, { bare: true });
    };
    // thumbnails of a long list are drawn when the browser is idle, a frame apart
    const id = requestAnimationFrame(draw);
    return () => {
      alive = false;
      cancelAnimationFrame(id);
    };
  }, [node, w, h, k, pw, ph]);
  return <canvas ref={ref} className="layer-thumb" style={{ width: `calc(${w}px * var(--ui-scale, 1))`, height: `calc(${h}px * var(--ui-scale, 1))` }} aria-hidden="true" />;
}

/** Visibility before an Alt+click solo, to give back on the second Alt+click. */
let soloMemo: { pageId: string; id: string; visible: Record<string, boolean> } | null = null;

/** Alt+click on an eye: show only this layer; Alt+click it again: the others come back as they were. */
export function soloLayer(node: SceneNode) {
  const s = S();
  const page = findPage(s.doc, s.pageId);
  if (!page) return;
  if (soloMemo && soloMemo.pageId === page.id && soloMemo.id === node.id) {
    const memo = soloMemo.visible;
    soloMemo = null;
    updateNodes(page.nodes.map((n) => n.id), t("layers.solo.restore"), (n) => {
      if (n.id in memo) n.visible = memo[n.id];
    });
    return;
  }
  soloMemo = { pageId: page.id, id: node.id, visible: Object.fromEntries(page.nodes.map((n) => [n.id, n.visible])) };
  updateNodes(page.nodes.map((n) => n.id), t("layers.solo.only"), (n) => (n.visible = n.id === node.id));
}

/** Blend mode · opacity · lock of the selected layers, above the list (where Photoshop and Illustrator keep them). */
export function LayerBar() {
  const t = useT();
  const nodes = useStore((s) => {
    const p = findPage(s.doc, s.pageId);
    return p ? p.nodes.filter((n) => s.selection.includes(n.id)) : [];
  });
  const n = nodes[0];
  const off = !n;
  return (
    <div className="layer-bar" role="toolbar" aria-label={t("layers.bar")}>
      <Select icon="blend" tip={t("ribbon.blendMode")} value={n?.blendMode ?? "NORMAL"} options={BLEND_OPTIONS} width={112} onChange={(v) => !off && updateSelected(t("ribbon.blendMode"), (x) => (x.blendMode = v))} />
      <NumField icon="opacity" tip={t("ribbon.opacity")} value={n ? n.opacity : null} scale={100} min={0} max={100} unit="%" width={70} disabled={off} live={nodeLive(t("ribbon.opacity"), (x, v: number) => (x.opacity = v))} />
      <IconBtn icon={n?.locked ? "lock" : "unlock"} size="sm" pressed={!!n?.locked} disabled={off} tip={n?.locked ? t("dock.unlock") : t("dock.lockTip")} onClick={() => n && updateSelected(n.locked ? t("dock.unlock") : t("dock.lock"), (x) => (x.locked = !n.locked))} />
    </div>
  );
}
