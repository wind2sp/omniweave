// 패스 (Photoshop's Paths panel), the basics, under the image mode's layers: paths saved with the page (Page.paths) —
// save the selected pen shape as a path, rename (double-click), make a selection from a path (and a path from the
// selection), fill it with the foreground colour or stroke it with the brush on the active layer, delete it. A click
// on a path shows it on the canvas.

import { useState } from "react";
import { create } from "zustand";
import { applyTransform } from "../../core/geom";
import { marchingSquares, rdpClosed } from "../../core/image/trace";
import { imgToTiles, tilesToImg } from "../../core/image/pixels";
import { currentPage, draftPage, useStore } from "../../core/store";
import { uid, type Contour, type Page, type RasterNode, type SavedPath, type Vec2, type VectorNode } from "../../core/types";
import { corner, contourToSvgD } from "../../core/vector";
import { t, useT } from "../../i18n";
import { ctx2d, makeCanvas } from "../../render/draw";
import { IconBtn } from "../shell/controls";
import { activeMask, paintTarget, setSelection } from "../pixelSelect";
import { tileAligned } from "./dabs";
import { localPageBox } from "./maskActions";
import { pathTarget } from "./layerOps";

const S = () => useStore.getState();

export const usePathsUI = create<{ active: string | null; set: (active: string | null) => void }>((set) => ({ active: null, set: (active) => set({ active }) }));

const pathsOf = (p: Page | undefined) => p?.paths ?? [];
const activePath = () => pathsOf(currentPage()).find((x) => x.id === usePathsUI.getState().active) ?? null;

/** A vector node's contours in page px (its transform applied to every point and handle). */
function pageContours(n: VectorNode): Contour[] {
  const f = (p: Vec2) => applyTransform(n.transform, p);
  return n.contours.map((c) => ({ closed: c.closed, nodes: c.nodes.map((a) => ({ anchor: f(a.anchor), handleIn: f(a.handleIn), handleOut: f(a.handleOut), isCorner: a.isCorner })) }));
}

function addPath(contours: Contour[], name?: string) {
  const page = currentPage();
  if (!page || !contours.length) return;
  const n = pathsOf(page).length + 1;
  const p: SavedPath = { id: uid(), name: name ?? t("psfeat.paths.name", { n }), contours };
  S().commit(t("psfeat.paths.hist.add"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg) (pg.paths ??= []).push(p as any);
  });
  usePathsUI.getState().set(p.id);
}

/** 패스로 저장: the selected (or last) pen shape. */
export function savePathFromShape() {
  const v = pathTarget();
  if (!v) return void S().notify(t("psfeat.path.pick"));
  addPath(pageContours(v));
}

/** 선택 영역에서 패스 만들기: the selection's outline (tolerance 1 px), straight segments. */
export function pathFromSelection() {
  const m = activeMask();
  if (!m) return void S().notify(t("selmod.needSelection"));
  const bin = Uint8Array.from(m.data, (v) => (v >= 128 ? 1 : 0));
  const loops = marchingSquares(bin, m.w, m.h);
  const contours: Contour[] = [];
  for (const loop of loops) {
    if (loop.length < 3) continue;
    const idx = rdpClosed(loop, 1);
    if (idx.length < 3) continue;
    contours.push({ closed: true, nodes: idx.map((i) => corner(loop[i][0], loop[i][1])) });
  }
  if (!contours.length) return void S().notify(t("psfeat.path.empty"));
  addPath(contours);
}

function pathCanvas(p: SavedPath, page: Page, draw: (g: CanvasRenderingContext2D, path: Path2D) => void): Uint8Array {
  const w = Math.max(1, Math.round(page.width)), h = Math.max(1, Math.round(page.height));
  const cv = makeCanvas(w, h);
  const g = ctx2d(cv) as CanvasRenderingContext2D;
  draw(g, new Path2D(p.contours.map(contourToSvgD).join(" ")));
  const d = g.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4 + 3];
  return out;
}

/** 패스를 선택 영역으로. */
export function selectionFromPath(p = activePath()) {
  const page = currentPage();
  if (!page || !p) return void S().notify(t("psfeat.paths.pick"));
  const data = pathCanvas(p, page, (g, path) => ((g.fillStyle = "#000"), g.fill(path)));
  setSelection({ w: Math.max(1, Math.round(page.width)), h: Math.max(1, Math.round(page.height)), data }, "replace");
}

/** 패스 칠 / 획: the foreground colour into the active layer where the path is filled / stroked (brush size). */
export function paintPath(how: "fill" | "stroke", p = activePath()) {
  const page = currentPage();
  if (!page || !p) return void S().notify(t("psfeat.paths.pick"));
  const brush = S().brush;
  const cov = pathCanvas(p, page, (g, path) => {
    if (how === "fill") {
      g.fillStyle = "#000";
      g.fill(path);
    } else {
      g.strokeStyle = "#000";
      g.lineWidth = brush.size;
      g.lineCap = g.lineJoin = "round";
      g.stroke(path);
    }
  });
  const n = paintTarget(page, false, true);
  if (!n) return;
  const pg = currentPage()!;
  const box = tileAligned(localPageBox(n.transform, pg, n.tiles));
  const img = tilesToImg(n.tiles, { ox: box.x, oy: box.y, width: box.w, height: box.h });
  const v = parseInt(brush.color.replace("#", "").slice(0, 6), 16) || 0;
  const rgb = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  const W = Math.round(pg.width);
  for (let y = 0; y < box.h; y++)
    for (let x = 0; x < box.w; x++) {
      const [px, py] = applyTransform(n.transform, [box.x + x + 0.5, box.y + y + 0.5]);
      const ix = Math.floor(px), iy = Math.floor(py);
      if (ix < 0 || iy < 0 || ix >= W || iy >= pg.height) continue;
      const a = (cov[iy * W + ix] / 255) * brush.opacity;
      if (a <= 0) continue;
      const o = (y * box.w + x) * 4;
      const da = img.data[o + 3] / 255, ao = a + da * (1 - a);
      for (let c = 0; c < 3; c++) img.data[o + c] = Math.round((rgb[c] * a + img.data[o + c] * da * (1 - a)) / ao);
      img.data[o + 3] = Math.round(ao * 255);
    }
  const tiles = imgToTiles(img, box.x, box.y, n.tiles).tiles;
  S().commit(t(how === "fill" ? "psfeat.paths.hist.fill" : "psfeat.paths.hist.stroke"), (d) => {
    const x = draftPage(d, pg.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
    if (x) x.tiles = tiles as any;
  });
}

function deletePath(id: string) {
  const page = currentPage();
  if (!page) return;
  S().commit(t("psfeat.paths.hist.delete"), (d) => {
    const pg = draftPage(d, page.id);
    if (pg?.paths) {
      pg.paths = pg.paths.filter((x) => x.id !== id);
      if (!pg.paths.length) delete pg.paths;
    }
  });
  usePathsUI.getState().set(null);
}

function renamePath(id: string, name: string) {
  const page = currentPage();
  if (!page || !name.trim()) return;
  S().commit(t("psfeat.paths.hist.rename"), (d) => {
    const x = draftPage(d, page.id)?.paths?.find((q) => q.id === id);
    if (x) x.name = name.trim();
  });
}

/** The active path drawn on the canvas (thin line, Photoshop shows the selected path). */
export function drawActivePath(o: CanvasRenderingContext2D, page: Page, toScreen: (p: Vec2) => Vec2) {
  const id = usePathsUI.getState().active;
  const p = page.paths?.find((x) => x.id === id);
  if (!p) return;
  const v = S().view;
  o.save();
  o.setTransform(o.getTransform().multiply(new DOMMatrix([v.zoom, 0, 0, v.zoom, v.panX, v.panY])));
  o.lineWidth = 1 / v.zoom;
  o.strokeStyle = "#4f7cff";
  o.stroke(new Path2D(p.contours.map(contourToSvgD).join(" ")));
  o.restore();
  void toScreen;
}

export function PathsPanel() {
  const tt = useT();
  const page = useStore((s) => s.doc.pages.find((p) => p.id === s.pageId));
  const active = usePathsUI((s) => s.active);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const paths = pathsOf(page);
  return (
    <section className="ps-paths" aria-label={tt("psfeat.paths.title")} style={{ borderTop: "1px solid var(--line-2)", padding: "4px 6px" }}>
      <button type="button" className="btn btn-ghost" style={{ width: "100%", justifyContent: "flex-start", fontSize: "var(--fs-ui)" }} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {tt("psfeat.paths.title")} ({paths.length})
      </button>
      {open && (
        <>
          <div role="listbox" aria-label={tt("psfeat.paths.title")} style={{ maxHeight: 120, overflowY: "auto" }}>
            {paths.map((p) => (
              <div
                key={p.id}
                role="option"
                aria-selected={active === p.id}
                className={"layer-row" + (active === p.id ? " active" : "")}
                style={{ paddingLeft: 8, minHeight: 26 }}
                onClick={() => usePathsUI.getState().set(active === p.id ? null : p.id)}
                onDoubleClick={() => setEditing(p.id)}
              >
                {editing === p.id ? (
                  <input
                    className="layer-name-input"
                    autoFocus
                    defaultValue={p.name}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={(e) => (renamePath(p.id, e.target.value), setEditing(null))}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      if (e.key === "Escape") setEditing(null);
                    }}
                  />
                ) : (
                  <span className="layer-name">{p.name}</span>
                )}
              </div>
            ))}
            {!paths.length && <small style={{ color: "var(--text-3)", padding: "2px 8px", display: "block" }}>{tt("psfeat.paths.empty")}</small>}
          </div>
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            <IconBtn icon="pathFill" tip={tt("psfeat.paths.fill")} disabled={!active} onClick={() => paintPath("fill")} />
            <IconBtn icon="pathStroke" tip={tt("psfeat.paths.stroke")} disabled={!active} onClick={() => paintPath("stroke")} />
            <IconBtn icon="pathToSel" tip={tt("psfeat.paths.toSelection")} disabled={!active} onClick={() => selectionFromPath()} />
            <IconBtn icon="selToPath" tip={tt("psfeat.paths.fromSelection")} onClick={pathFromSelection} />
            <IconBtn icon="plus" tip={tt("psfeat.paths.save")} onClick={savePathFromShape} />
            <IconBtn icon="trash" tip={tt("psfeat.paths.delete")} disabled={!active} onClick={() => active && deletePath(active)} />
          </div>
        </>
      )}
    </section>
  );
}
