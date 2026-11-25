// Type › Type on a Path (Illustrator): a path becomes the line a text runs along — the path's own paint goes (as in
// Illustrator, where a type path has no fill or stroke) and a text node takes its place with the path in its own
// coordinates (core/pathText.ts). The type-on-a-path tool does the same on a click on a path, then types there.

import { draftPage, currentPage, useStore } from "../core/store";
import { newText, type SceneNode, type TextNode, type Vec2, type VectorNode } from "../core/types";
import { t } from "../i18n";
import { flattenContour } from "../core/pathText";
import { applyTransform } from "../core/geom";

const S = () => useStore.getState();

/** The selected (or given) path as a type path; returns the new text node, or null when there is no path. */
export function typeOnPath(pathId?: string, text = t("design.pathText.placeholder"), at?: Vec2): TextNode | null {
  const s = S();
  const page = currentPage();
  if (!page) return null;
  const id = pathId ?? s.selection.find((i) => page.nodes.find((n) => n.id === i)?.type === "VECTOR");
  const v = page.nodes.find((n) => n.id === id) as VectorNode | undefined;
  if (!v || v.type !== "VECTOR" || v.locked || !v.contours[0] || v.contours[0].nodes.length < 2) return null;
  // a size that reads along this path: a twentieth of its length (14 – 96 px)
  const f = flattenContour(v.contours[0], 8);
  const size = Math.max(14, Math.min(96, Math.round(f.len[f.len.length - 1] / 20)));
  const tx = newText(text, 360, { fontSize: size, color: v.stroke && v.stroke !== "none" ? v.stroke : "#000000" });
  tx.name = t("design.pathText.name");
  tx.transform = { ...v.transform };
  // the text starts where the path was clicked (Illustrator), else at the path's start
  let start = 0;
  if (at) {
    let best = Infinity;
    f.pts.forEach((q, i) => {
      const [x, y] = applyTransform(v.transform, q);
      const d = Math.hypot(x - at[0], y - at[1]);
      if (d < best) (best = d), (start = f.len[i]);
    });
  }
  tx.onPath = { contour: JSON.parse(JSON.stringify(v.contours[0])), start: Math.round(start * 100) / 100 };
  if (v.groupId) tx.groupId = v.groupId;
  s.commit(t("design.pathText.hist"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const i = pg.nodes.findIndex((n) => n.id === v.id);
    if (i >= 0) pg.nodes.splice(i, 1, tx as never);
  });
  S().set({ selection: [tx.id] });
  return tx;
}

/** A path under a click for the type-on-a-path tool (an unlocked, visible path). */
export const isTypePath = (n: SceneNode | undefined): n is VectorNode => !!n && n.type === "VECTOR" && !n.locked && n.visible && n.contours[0]?.nodes.length >= 2;
