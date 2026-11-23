// The design mode's paintbrush and eraser work on vector paths, as in Illustrator (2026-11-23 audit: the brush painted
// pixels on a hidden raster layer, and the eraser left drawn lines alone while it erased that raster):
//  - paintbrush (B): the stroke becomes a smooth open path in the brush colour and size;
//  - eraser (Shift+E): where it passes, paths are cut (lines, open paths, outlines) or lose the covered area (filled
//    shapes) — the selected paths, or every unlocked path when none is selected. One undo step each.

import { pickableOn } from "../core/layerTree";
import { autoSmooth } from "../core/pathEdit";
import { draftPage, findPage, useStore } from "../core/store";
import { newVector, type SceneNode, type Vec2, type VectorAnchor, type VectorNode } from "../core/types";
import { eraseVector } from "../core/vectorErase";
import { t } from "../i18n";

const S = () => useStore.getState();

/** Ramer–Douglas–Peucker: the track's corners within `tol` px. */
export function simplifyTrack(pts: Vec2[], tol: number): Vec2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = pts[a], [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / l;
      if (d > best) (best = d), (bi = i);
    }
    if (best > tol && bi > 0) {
      keep[bi] = 1;
      stack.push([a, bi], [bi, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** The paintbrush stroke as a smooth open path (page coordinates), or null for a click without a drag. */
export function brushPath(track: Vec2[], color: string, size: number, zoom: number): VectorNode | null {
  const pts = simplifyTrack(track, Math.max(0.5, 1.5 / Math.max(zoom, 1e-3)));
  if (pts.length < 2 || Math.hypot(pts.at(-1)![0] - pts[0][0], pts.at(-1)![1] - pts[0][1]) * zoom < 2 && pts.length < 3) return null;
  const nodes: VectorAnchor[] = pts.map((p) => ({ anchor: [p[0], p[1]], handleIn: [p[0], p[1]], handleOut: [p[0], p[1]], isCorner: false }));
  autoSmooth(nodes, false);
  const v = newVector([{ closed: false, nodes }], t("design.name.brush"));
  v.fill = null;
  v.stroke = color;
  v.strokeWidth = Math.max(0.25, size);
  v.strokeCap = "round";
  v.strokeJoin = "round";
  return v;
}

/** Paths the eraser works on: the selected unlocked ones, else every shown unlocked one. */
export function eraserPaths(nodes: SceneNode[], selection: string[], pick: (n: SceneNode) => boolean): VectorNode[] {
  const vecs = nodes.filter((n): n is VectorNode => n.type === "VECTOR" && pick(n));
  const sel = vecs.filter((n) => selection.includes(n.id));
  return sel.length ? sel : vecs;
}

/** Erase along `track` (page px) with an eraser `size` px wide; returns how many paths changed. */
export function eraseVectorsOnPage(pageId: string, track: Vec2[], size: number): number {
  const s = S();
  const page = findPage(s.doc, pageId);
  if (!page) return 0;
  const done = new Map<string, VectorNode | null>();
  for (const v of eraserPaths(page.nodes, s.selection, pickableOn(page))) {
    const r = eraseVector(v, track, size / 2);
    if (r !== undefined) done.set(v.id, r);
  }
  if (!done.size) {
    s.notify(t("design.msg.eraserMissed"));
    return 0;
  }
  s.commit(t("cmd.image.eraser"), (d) => {
    const pg = draftPage(d, pageId);
    if (!pg) return;
    pg.nodes = pg.nodes.flatMap((n) => (done.has(n.id) ? (done.get(n.id) ? [done.get(n.id) as any] : []) : [n]));
  });
  s.set({ selection: s.selection.filter((id) => !done.has(id) || done.get(id)) });
  return done.size;
}

/** The design eraser has paths to work on (otherwise it erases pixels, as in the image mode). */
export function hasErasablePaths(pageId: string): boolean {
  const page = findPage(S().doc, pageId);
  return !!page && eraserPaths(page.nodes, S().selection, pickableOn(page)).length > 0;
}
