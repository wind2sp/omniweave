// 이미지 › 모드 (Photoshop's Image ▸ Mode): RGB 색상 · 회색조 · CMYK 색상 of the page. RGB is the default (no field).
// 회색조 turns the pixel layers grey at once (their luminance) and saves a Grayscale PSD; CMYK keeps the screen in RGB —
// as Photoshop shows a CMYK document on an RGB screen — and saves a CMYK PSD (io/formats/psdWrite.ts), which opens
// as CMYK again (io/formats/psd.ts sets the mode from the file).

import { currentPage, draftPage, useStore } from "../../core/store";
import type { Page } from "../../core/types";
import { t } from "../../i18n";
import { applyImageOps } from "../imageActions";

const S = () => useStore.getState();
export type ColorMode = "rgb" | "gray" | "cmyk";
export const colorModeOf = (p: Page | undefined | null): ColorMode => p?.colorMode ?? "rgb";
/** the PSD colour mode number of a page (3 RGB, 1 Grayscale, 4 CMYK) */
export const psdModeOf = (p: Page): number => (p.colorMode === "cmyk" ? 4 : p.colorMode === "gray" ? 1 : 3);

export async function setColorMode(m: ColorMode): Promise<void> {
  const page = currentPage();
  if (!page || colorModeOf(page) === m) return;
  if (m === "gray") {
    // the pixels go grey: each pixel layer's luminance (adjustment layers have no pixels of their own)
    const keep = S().selection;
    for (const n of page.nodes) {
      if (!((n.type === "RASTER" && !n.adjust) || n.type === "IMAGE")) continue;
      S().set({ selection: [n.id] });
      await applyImageOps([{ op: "hueSaturation", params: { hue: 0, saturation: -100, lightness: 0, colorize: 0 } }], t("psfeat.mode.toGray"));
    }
    S().set({ selection: keep });
  }
  const label = t(`cmd.image.mode.${m}`);
  S().commit(t("psfeat.mode.hist", { mode: label }), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    if (m === "rgb") delete pg.colorMode;
    else pg.colorMode = m;
  });
  S().notify(t(m === "cmyk" ? "psfeat.mode.cmykNote" : "psfeat.mode.done", { mode: label }));
}
