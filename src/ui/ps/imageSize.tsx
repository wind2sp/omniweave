// 이미지 크기 (Photoshop's Image › Image Size, Ctrl+Alt+I): width and height in pixels, percent, inches, cm or mm, the
// resolution (ppi), the chain that keeps the proportions, and 리샘플링 (자동 · 바이큐빅 · 쌍선형 · 최단입점 · 끄기). With
// resampling the whole image gets the new pixel size — every pixel layer and mask resampled, pictures, shapes and text
// scaled with it; without, only the resolution (the print size) changes. One undo step.

import { useMemo, useState } from "react";
import { create } from "zustand";
import { maskFromPlane, maskPlane } from "../../core/image/layerMask";
import { imgToTiles, tileBounds, tilesToImg } from "../../core/image/pixels";
import { resizeImg, resizePlane, type Resample } from "../../core/image/resize";
import { currentPage, draftPage, useStore } from "../../core/store";
import type { Page, PixelTile, RasterNode, SceneNode } from "../../core/types";
import { t, useT } from "../../i18n";
import { Modal } from "../shell/Dialogs";
import { Select } from "../shell/controls";

const S = () => useStore.getState();

export const useImageSizeUI = create<{ open: boolean; set: (open: boolean) => void }>((set) => ({ open: false, set: (open) => set({ open }) }));

type Unit = "px" | "%" | "in" | "cm" | "mm";
const UNITS: Unit[] = ["px", "%", "in", "cm", "mm"];
const PER_INCH: Record<"in" | "cm" | "mm", number> = { in: 1, cm: 2.54, mm: 25.4 };

/** Resolution of a page (ppi): what the file said, else 72. */
export const pagePpi = (p: Page | undefined) => (p as (Page & { ppi?: number }) | undefined)?.ppi ?? 72;

function resampleTiles(tiles: Record<string, PixelTile>, kx: number, ky: number, how: Resample): { tiles: Record<string, PixelTile>; dx: number; dy: number } {
  const b = tileBounds(tiles);
  if (!b) return { tiles: {}, dx: 0, dy: 0 };
  const img = tilesToImg(tiles, b);
  const out = resizeImg(img, Math.max(1, Math.round(b.width * kx)), Math.max(1, Math.round(b.height * ky)), how);
  return { tiles: imgToTiles(out, 0, 0, {}).tiles, dx: b.ox * kx, dy: b.oy * ky };
}

/** A node at the new size: pixels resampled (plain pixel layers and their masks), anything else scaled. */
function resizedNode(n: SceneNode, kx: number, ky: number, how: Resample): SceneNode {
  const t0 = n.transform;
  const plain = n.type === "RASTER" && t0.rotation === 0 && t0.scale === 1 && (t0.scaleY ?? 1) === 1 && !n.crop;
  if (plain && how !== ("none" as Resample)) {
    const r = n as RasterNode;
    const c = resampleTiles(r.tiles, kx, ky, how);
    const out: RasterNode = { ...r, tiles: c.tiles, transform: { ...t0, x: Math.round(t0.x * kx + c.dx), y: Math.round(t0.y * ky + c.dy) } };
    if (r.adjust) {
      // an adjustment layer's tiles are its mask: kept on the same grid
      out.tiles = c.tiles;
    }
    if (r.mask) {
      const b = tileBounds({ ...r.tiles, ...r.mask.tiles });
      if (b) {
        // the mask on the content's new grid: its plane over the content's old box, resampled with it
        const cb = tileBounds(r.tiles) ?? b;
        const plane = maskPlane(r.mask, cb.ox, cb.oy, cb.width, cb.height);
        const w = Math.max(1, Math.round(cb.width * kx)), h = Math.max(1, Math.round(cb.height * ky));
        out.mask = { ...r.mask, tiles: maskFromPlane(resizePlane(plane, cb.width, cb.height, w, h, how), 0, 0, w, h, r.mask.hide) };
      }
    }
    return out;
  }
  const sx = t0.scale * kx, sy = (t0.scaleY ?? t0.scale) * ky;
  return { ...n, transform: { ...t0, x: t0.x * kx, y: t0.y * ky, scale: sx, ...(Math.abs(sx - sy) > 1e-9 || t0.scaleY !== undefined ? { scaleY: sy } : {}) } } as SceneNode;
}

/** Give the current image page the size w × h px (resampled) and resolution `ppi`. */
export function applyImageSize(w: number, h: number, ppi: number, how: Resample | "none"): boolean {
  const page = currentPage();
  if (!page) return false;
  w = Math.round(w);
  h = Math.round(h);
  if (!(w >= 1 && h >= 1 && w <= 30000 && h <= 30000)) return void S().notify(t("psfeat.isize.range")), false;
  const kx = w / page.width, ky = h / page.height;
  const resample = how !== "none" && (w !== page.width || h !== page.height);
  const nodes = resample ? page.nodes.map((n) => resizedNode(n, kx, ky, how as Resample)) : page.nodes;
  S().commit(t("psfeat.isize.hist"), (d) => {
    const pg = draftPage(d, page.id) as unknown as (Page & { ppi?: number }) | undefined;
    if (!pg) return;
    if (resample) {
      pg.width = w;
      pg.height = h;
      pg.nodes = nodes as any;
    }
    if (ppi !== 72 || (page as Page & { ppi?: number }).ppi !== undefined) pg.ppi = ppi;
  });
  if (resample) S().notify(t("psfeat.isize.done", { w, h }));
  return true;
}

const fmt = (v: number) => (Number.isFinite(v) ? +v.toFixed(2) : 0);

export function ImageSizeDialog() {
  const open = useImageSizeUI((s) => s.open);
  if (!open) return null;
  return <ImageSizeBody />;
}

function ImageSizeBody() {
  const t = useT();
  const page = useMemo(currentPage, []);
  const close = () => useImageSizeUI.getState().set(false);
  const w0 = page?.width ?? 1, h0 = page?.height ?? 1;
  const ppi0 = pagePpi(page);
  const [w, setW] = useState(w0);
  const [h, setH] = useState(h0);
  const [ppi, setPpi] = useState(ppi0);
  const [unit, setUnit] = useState<Unit>("px");
  const [link, setLink] = useState(true);
  const [how, setHow] = useState<Resample | "none">("auto");
  const resample = how !== "none";
  // shown value of a pixel length in the unit; and back
  const show = (px: number, base: number) => (unit === "px" ? px : unit === "%" ? (px / base) * 100 : (px / ppi) * PER_INCH[unit]);
  const toPx = (v: number, base: number, res = ppi) => (unit === "px" ? v : unit === "%" ? (v / 100) * base : (v / PER_INCH[unit]) * res);
  const setSide = (key: "w" | "h", v: number) => {
    if (!Number.isFinite(v) || v <= 0) return;
    if (!resample) {
      // resampling off: the pixels stay, the print size moves the resolution
      if (unit === "px" || unit === "%") return;
      const inches = v / PER_INCH[unit];
      setPpi(+((key === "w" ? w0 : h0) / inches).toFixed(3));
      return;
    }
    const px = Math.max(1, Math.round(toPx(v, key === "w" ? w0 : h0)));
    if (key === "w") {
      setW(px);
      if (link) setH(Math.max(1, Math.round((px * h0) / w0)));
    } else {
      setH(px);
      if (link) setW(Math.max(1, Math.round((px * w0) / h0)));
    }
  };
  const mb = ((w * h * 4) / 1024 / 1024).toFixed(1);
  const units = unit === "px" ? "px" : unit;
  return (
    <Modal labelledBy="isize-title" className="modal-sm" onClose={close}>
      <h2 id="isize-title">{t("psfeat.isize.title")}</h2>
      <p className="modal-sub">{t("psfeat.isize.current", { w: w0, h: h0, mb: ((w0 * h0 * 4) / 1024 / 1024).toFixed(1) })}</p>
      <div className="tools-opt">
        <span>{t("psfeat.isize.unit")}</span>
        <Select<Unit> value={unit} width={80} onChange={setUnit} options={UNITS.map((u) => ({ value: u, label: t(`psfeat.isize.u.${u === "%" ? "pct" : u}`) }))} />
      </div>
      <div className="tools-opt" style={{ alignItems: "center" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {(["w", "h"] as const).map((k) => (
            <label key={k} className="tools-opt">
              <span style={{ minWidth: 40 }}>{t(k === "w" ? "psfeat.isize.width" : "psfeat.isize.height")}</span>
              <input
                type="number"
                aria-label={t(k === "w" ? "psfeat.isize.width" : "psfeat.isize.height")}
                value={fmt(show(k === "w" ? w : h, k === "w" ? w0 : h0))}
                step={unit === "px" ? 1 : 0.01}
                style={{ width: 96 }}
                onChange={(e) => setSide(k, Number(e.target.value))}
              />
              <span className="muted-note">{units}</span>
            </label>
          ))}
        </div>
        <button type="button" className={link ? "btn btn-primary" : "btn btn-ghost"} aria-pressed={link} title={t("psfeat.isize.link")} aria-label={t("psfeat.isize.link")} onClick={() => setLink(!link)} style={{ width: 32, height: 52, padding: 0 }}>
          <svg viewBox="0 0 12 20" width="12" height="20" aria-hidden="true"><path d="M3 2h4v5M3 18h4v-5" fill="none" stroke="currentColor" strokeWidth="1.4" /><path d={link ? "M7 7v6" : "M7 8v1M7 11v1"} stroke="currentColor" strokeWidth="1.4" /></svg>
        </button>
      </div>
      <label className="tools-opt">
        <span style={{ minWidth: 40 }}>{t("psfeat.isize.res")}</span>
        <input
          type="number"
          aria-label={t("psfeat.isize.res")}
          value={fmt(ppi)}
          step={1}
          style={{ width: 96 }}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!(v > 0)) return;
            // with resampling and a print unit, the print size stays and the pixels follow the resolution (Photoshop)
            if (resample && unit !== "px" && unit !== "%") {
              setW(Math.max(1, Math.round((w / ppi) * v)));
              setH(Math.max(1, Math.round((h / ppi) * v)));
            }
            setPpi(v);
          }}
        />
        <span className="muted-note">{t("psfeat.isize.ppi")}</span>
      </label>
      <div className="tools-opt">
        <span>{t("psfeat.isize.resample")}</span>
        <Select<Resample | "none">
          value={how}
          width={170}
          onChange={(v) => {
            setHow(v);
            if (v === "none") {
              setW(w0);
              setH(h0);
            }
          }}
          options={(["auto", "bicubic", "bilinear", "nearest", "none"] as const).map((v) => ({ value: v, label: t(`psfeat.isize.m.${v}`) }))}
        />
      </div>
      <p className="modal-sub" aria-live="polite">
        {t("psfeat.isize.new", { w, h, mb })}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={close}>
          {t("pagesetup.cancel")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={() => applyImageSize(w, h, ppi, how) && close()}>
          {t("psfeat.ok")}
        </button>
      </div>
    </Modal>
  );
}
