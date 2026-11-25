// 편집 › 칠 (Photoshop's Fill, Shift+F5) and 내용 인식 채우기: fill the selection (no selection: the whole layer) of the
// active pixel layer with the foreground / background colour, a colour, black, 50 % grey or white at an opacity — or,
// 내용 인식, rebuild it from the picture round it (core/image/inpaint.ts). One undo step.

import { applyTransform } from "../../core/geom";
import { tilesToImg } from "../../core/image/pixels";
import { currentPage, draftPage, useStore } from "../../core/store";
import { TILE } from "../../core/tile";
import type { PixelTile, RasterNode } from "../../core/types";
import { create } from "zustand";
import { useState } from "react";
import { t, useT } from "../../i18n";
import { Modal } from "../shell/Dialogs";
import { Select } from "../shell/controls";
import { activeMask, paintTarget, usePixelSel } from "../pixelSelect";
import { tileAligned } from "./dabs";
import { localPageBox } from "./maskActions";
import { fillHole } from "./canvasExt";
import { imgToTiles } from "../../core/image/pixels";

const S = () => useStore.getState();

export type FillUse = "fg" | "bg" | "color" | "content" | "black" | "grey" | "white";
export const useFillUI = create<{ open: boolean; use: FillUse; set: (p: { open: boolean; use?: FillUse }) => void }>((set) => ({
  open: false,
  use: "fg",
  set: (p) => set((s) => ({ open: p.open, use: p.use ?? s.use })),
}));

const hexRgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.replace("#", "").slice(0, 6), 16) || 0;
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** Fill the selection of the active layer. Returns whether something changed. */
export function fillWith(use: FillUse, color: string, opacity: number): boolean {
  const page = currentPage();
  if (!page) return false;
  const sel = activeMask();
  if (use === "content" && !sel) return void S().notify(t("selmod.needSelection")), false;
  const n = paintTarget(page, false, true);
  if (!n) return false;
  const pg = currentPage()!;
  const box = tileAligned(localPageBox(n.transform, pg, n.tiles));
  const img = tilesToImg(n.tiles, { ox: box.x, oy: box.y, width: box.w, height: box.h });
  const W = box.w, H = box.h;
  const cov = new Float32Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [px, py] = applyTransform(n.transform, [box.x + x + 0.5, box.y + y + 0.5]);
      const ix = Math.floor(px), iy = Math.floor(py);
      const inPage = ix >= 0 && iy >= 0 && ix < pg.width && iy < pg.height;
      cov[y * W + x] = !inPage ? 0 : sel ? (ix < sel.w && iy < sel.h ? sel.data[iy * sel.w + ix] / 255 : 0) : 1;
    }
  let out = img;
  if (use === "content") {
    const hole = new Uint8Array(W * H);
    for (let i = 0; i < hole.length; i++) hole[i] = cov[i] > 0.5 ? 1 : 0;
    const f = fillHole(img, hole, W, H, 11);
    if (!f) return false;
    out = f;
  } else {
    const rgb = use === "black" ? [0, 0, 0] : use === "white" ? [255, 255, 255] : use === "grey" ? [128, 128, 128] : hexRgb(color);
    out = { width: W, height: H, data: new Uint8ClampedArray(img.data) };
    const d = out.data;
    for (let i = 0; i < W * H; i++) {
      const a = cov[i] * opacity;
      if (a <= 0) continue;
      const o = i * 4;
      const da = d[o + 3] / 255, ao = a + da * (1 - a);
      for (let c = 0; c < 3; c++) d[o + c] = Math.round((rgb[c] * a + d[o + c] * da * (1 - a)) / ao);
      d[o + 3] = Math.round(ao * 255);
    }
  }
  const tiles: Record<string, PixelTile> = imgToTiles(out, box.x, box.y, n.tiles).tiles;
  S().commit(t(use === "content" ? "psfeat.fill.histContent" : "psfeat.fill.hist"), (d) => {
    const x = draftPage(d, pg.id)?.nodes.find((q) => q.id === n.id) as RasterNode | undefined;
    if (x) x.tiles = tiles as any;
  });
  void TILE;
  return true;
}

export function FillDialog() {
  const open = useFillUI((s) => s.open);
  if (!open) return null;
  return <FillBody />;
}

function FillBody() {
  const tt = useT();
  const [use, setUse] = useState<FillUse>(useFillUI.getState().use);
  const [color, setColor] = useState("#808080");
  const [opacity, setOpacity] = useState(100);
  const close = () => useFillUI.getState().set({ open: false });
  const fg = S().brush.color, bg = usePixelSel.getState().bg;
  return (
    <Modal labelledBy="psfill-title" className="modal-sm" onClose={close}>
      <h2 id="psfill-title">{tt("psfeat.fill.title")}</h2>
      <div className="tools-opt">
        <span>{tt("psfeat.fill.contents")}</span>
        <Select<FillUse>
          value={use}
          width={180}
          onChange={setUse}
          options={(["fg", "bg", "color", "content", "black", "grey", "white"] as const).map((v) => ({ value: v, label: tt(`psfeat.fill.use.${v}`) }))}
        />
        {use === "color" && <input type="color" aria-label={tt("psfeat.fill.use.color")} value={color} onChange={(e) => setColor(e.target.value)} />}
      </div>
      {use !== "content" && (
        <label className="tools-opt">
          <span>{tt("psfeat.fill.opacity")}</span>
          <input type="number" min={1} max={100} value={opacity} style={{ width: 70 }} aria-label={tt("psfeat.fill.opacity")} onChange={(e) => setOpacity(Math.max(1, Math.min(100, Number(e.target.value) || 100)))} />
          <span className="muted-note">%</span>
        </label>
      )}
      <p className="modal-sub">{use === "content" ? tt("psfeat.fill.contentNote") : activeMask() ? tt("psfeat.fill.inSelection") : tt("psfeat.fill.wholeLayer")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {tt("pagesetup.cancel")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          onClick={() => {
            const c = use === "fg" ? fg : use === "bg" ? bg : color;
            if (fillWith(use, c, opacity / 100)) close();
          }}
        >
          {tt("psfeat.ok")}
        </button>
      </div>
    </Modal>
  );
}
