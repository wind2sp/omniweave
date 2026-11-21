// Drawing pages (DXF / DWG import, docs/design/CAD_IMPORT.md §7): rulers and the pointer position in drawing
// coordinates (WCS, y up, drawing units) the way AutoCAD shows them, and layer on/off / lock that also reaches the
// entities a block keeps on another layer (VECTOR / TEXT nodes with `cadLayer`).

import { getBlob } from "../core/assets";
import { draftPage, useStore } from "../core/store";
import type { CadSourceMeta, LayerGroup, Page } from "../core/types";
import { openFiles } from "../io/platform";
import { rulerSteps, rulerTicks, type Tick } from "../core/units";
import { t } from "../i18n";

export const cadOf = (page: Page | undefined): CadSourceMeta | undefined => page?.source?.cad;

/** Page px → drawing coordinates. */
export function cadPoint(cad: CadSourceMeta, p: readonly [number, number]): [number, number] {
  return [cad.ox + p[0] / cad.k, cad.oy - p[1] / cad.k];
}

/** A drawing length (page px → drawing units). */
export const cadLength = (cad: CadSourceMeta, px: number) => px / cad.k;

/** A drawing number the way the status bar shows it (up to 4 decimals, trailing zeros dropped). */
export function cadNumber(v: number): string {
  const s = (Math.round(v * 1e4) / 1e4).toFixed(4).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/**
 * Ruler ticks of a drawing page between page px `start` and `end`: labels are drawing coordinates (x to the right,
 * y upwards), positions page px. `mid` marks the half-way subdivision.
 */
export function cadRulerTicks(cad: CadSourceMeta, start: number, end: number, zoom: number, horizontal: boolean): (Tick & { mid?: boolean })[] {
  const steps = rulerSteps(zoom * cad.k, "px");
  const a = horizontal ? cad.ox + start / cad.k : cad.oy - end / cad.k;
  const b = horizontal ? cad.ox + end / cad.k : cad.oy - start / cad.k;
  const half = steps.sub % 2 === 0 ? steps.sub / 2 : 0;
  const minor = steps.major / steps.sub;
  return rulerTicks(a, b, steps).map((tk) => {
    const idx = Math.round(tk.pos / minor);
    return { ...tk, pos: horizontal ? (tk.pos - cad.ox) * cad.k : (cad.oy - tk.pos) * cad.k, mid: !!half && ((idx % steps.sub) + steps.sub) % steps.sub === half };
  });
}

/**
 * Turn a drawing layer on or off (its layer group's eye): the group, plus entities kept on that layer inside blocks
 * of other layers. Frozen layers thaw when turned on.
 */
export function setCadLayerVisible(g: LayerGroup, on: boolean) {
  const page = useStore.getState().doc.pages.find((p) => p.groups?.some((x) => x.id === g.id));
  const layer = g.cad?.layer;
  if (!page || !layer) return;
  useStore.getState().commit(on ? t("dock.show") : t("dock.hide"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const gr = pg.groups?.find((x) => x.id === g.id);
    if (gr) {
      gr.visible = on;
      if (on && gr.cad?.frozen) delete gr.cad.frozen;
    }
    for (const n of pg.nodes) if (n.cadLayer === layer) n.visible = on;
  });
}

/** External files (xrefs, linked pictures) the drawing of `page` names but that were not found. */
export const missingRefs = (page: Page | undefined) => cadOf(page)?.refs?.filter((r) => !r.found) ?? [];

const REF_EXTS = ["dwg", "dxf", "png", "jpg", "jpeg", "tif", "tiff", "bmp", "gif", "webp"];

/**
 * 경로 지정: the user picks the missing xref / picture files (any of them); the drawing is read again from its kept
 * original with those files, the files found before (kept assets) and — on the desktop — the picked files' folder as
 * a search folder for the rest, and all pages of the drawing (model and layouts) are replaced in one undoable step.
 */
export async function relinkCad(page: Page) {
  const cad = cadOf(page);
  const s = useStore.getState();
  const host = cad && s.doc.assets[cad.assetId];
  const hostBytes = host && getBlob(host.hash);
  if (!cad || !host || !hostBytes) return;
  const files = await openFiles([{ name: t("layers.cad.relinkFilter"), extensions: REF_EXTS }], true);
  if (!files.length) return;
  const { addCadSearchDir, baseNameOf, dirOf } = await import("../io/formats/cad/external");
  const known = new Map<string, Uint8Array>();
  for (const r of cad.refs ?? []) {
    const a = r.assetId ? s.doc.assets[r.assetId] : undefined;
    const b = a && getBlob(a.hash);
    if (b) known.set(baseNameOf(r.path).toLowerCase(), b);
  }
  const missing = missingRefs(page);
  for (const f of files) {
    known.set(f.name.toLowerCase(), f.bytes);
    if (f.path) addCadSearchDir(dirOf(f.path));
  }
  // one picked file of another name for the one missing file of its kind: that is the file
  const isPic = (n: string) => !/\.(dwg|dxf)$/i.test(n);
  if (files.length === 1) {
    const same = missing.filter((r) => (r.kind === "image") === isPic(files[0].name));
    const named = missing.some((r) => known.has(baseNameOf(r.path).toLowerCase()));
    if (same.length === 1 && !named) known.set(baseNameOf(same[0].path).toLowerCase(), files[0].bytes);
  }
  const { openCadFile } = await import("../io/formats/cad/open");
  const r = await openCadFile({ name: host.name, path: null, bytes: hostBytes }, known);
  const before = (cad.refs ?? []).filter((x) => x.found).length;
  const gained = r.refs.filter((x) => x.found).length - before;
  if (gained <= 0) {
    s.notify(t("layers.cad.relinkNone"));
    return;
  }
  const oldIds = s.doc.pages.filter((p) => p.source?.cad?.assetId === cad.assetId).map((p) => p.id);
  const at = Math.max(0, s.doc.pages.findIndex((p) => oldIds.includes(p.id)));
  const was = oldIds.indexOf(page.id);
  s.commit(t("layers.cad.relink"), (d) => {
    Object.assign(d.assets, r.assets);
    d.pages = d.pages.filter((p) => !oldIds.includes(p.id));
    d.pages.splice(Math.min(at, d.pages.length), 0, ...(r.pages as any));
  });
  s.set({ pageId: (r.pages[Math.max(0, was)] ?? r.pages[0]).id, selection: [] });
  s.notify(t("layers.cad.relinked", { n: gained }));
}

/** Lock or unlock a drawing layer (group and the block entities on it). */
export function setCadLayerLocked(g: LayerGroup, locked: boolean) {
  const page = useStore.getState().doc.pages.find((p) => p.groups?.some((x) => x.id === g.id));
  const layer = g.cad?.layer;
  if (!page || !layer) return;
  useStore.getState().commit(locked ? t("dock.lock") : t("dock.unlock"), (d) => {
    const pg = draftPage(d, page.id);
    if (!pg) return;
    const gr = pg.groups?.find((x) => x.id === g.id);
    if (gr) gr.locked = locked;
    for (const n of pg.nodes) if (n.cadLayer === layer) n.locked = locked;
  });
}
