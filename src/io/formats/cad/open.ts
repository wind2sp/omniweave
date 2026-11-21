// Opening a DXF / DWG (import only, docs/design/CAD_IMPORT.md): read the drawing, load the external files it names
// (xrefs, linked pictures — cad/external.ts), keep the originals as assets and build the pages. Loaded on first use, so
// none of the CAD code is in the start-up chunk.

import { makeAsset } from "../../../core/assets";
import type { AssetRef, Page } from "../../../core/types";
import { t } from "../../../i18n";
import type { OpenedFile } from "../../platform";
import { encodePng } from "../png";
import { cadKind, imageMime } from "../sniff";
import { baseName } from "../text";
import { decodeTiff } from "../tiff";
import { buildCadPages } from "./build";
import { cadFileReader, cadSearchDirs, dirOf, resolveExternal, type CadRef } from "./external";
import { RELEASES, scaleLabel, type CadDrawing } from "./model";
import { strokeVariantOf, type StrokeVariant } from "./strokeFont";

export interface CadOpened {
  pages: Page[];
  assets: Record<string, AssetRef>;
  mode: "DESIGN";
  warnings: string[];
  message: string;
  refs: CadRef[];
}

/** A picture's bytes as something the canvas can draw (TIFF → PNG); null when it cannot be shown. */
function drawable(bytes: Uint8Array): { bytes: Uint8Array; mime: string } | null {
  const mime = imageMime(bytes);
  if (!mime || mime === "image/heic") return null;
  if (mime !== "image/tiff") return { bytes, mime };
  try {
    const img = decodeTiff(bytes);
    return { bytes: encodePng(img.rgba, img.width, img.height, 3), mime: "image/png" };
  } catch {
    return null;
  }
}

/**
 * Open a CAD file. `known` holds external files already in hand by lower-case file name (the user picked them with
 * 경로 지정, or an earlier import kept them as assets); the rest are looked for next to the drawing.
 */
export async function openCadFile(f: OpenedFile, known?: Map<string, Uint8Array>): Promise<CadOpened> {
  const kind = cadKind(f.bytes);
  if (kind !== "dxf" && kind !== "dwg") throw new Error(t("engine.cad.notCad"));
  let d: CadDrawing;
  let problems: Record<string, number> = {};
  if (kind === "dxf") {
    const { readDxf } = await import("../dxf");
    try {
      d = readDxf(f.bytes);
    } catch {
      throw new Error(t("engine.cad.badDxf"));
    }
  } else {
    const [{ readDwg }, { readDwgInfo }] = await Promise.all([import("../dwg/objects"), import("../dwg/container")]);
    try {
      const read = readDwg(f.bytes);
      d = read.drawing;
      problems = read.problems;
    } catch (e) {
      let release = "";
      try {
        release = readDwgInfo(f.bytes).release ?? "";
      } catch {
        /* not even a header */
      }
      if ((e as Error).message === "DWG_OLD") throw new Error(t("engine.cad.dwgNotYet", { release }));
      throw new Error(t("engine.cad.badDwg", { release }));
    }
  }

  // external files: xrefs merged into the drawing, pictures and xref originals kept as assets
  const assets: Record<string, AssetRef> = {};
  const resolved = await resolveExternal(d, { dir: f.path ? dirOf(f.path) : "", search: cadSearchDirs(), read: f.path || cadSearchDirs().length ? cadFileReader() : null, known });
  const byHash = new Map<string, AssetRef>();
  const keep = (bytes: Uint8Array, mime: string, name: string) => {
    const a = makeAsset(bytes, mime, name);
    const same = byHash.get(a.hash);
    if (same) return same;
    byHash.set(a.hash, a);
    assets[a.id] = a;
    return a;
  };
  const refs: CadRef[] = [];
  for (const r of resolved) {
    if (r.bytes && r.ref.kind === "xref") r.ref.assetId = keep(r.bytes, cadKind(r.bytes) === "dwg" ? "image/vnd.dwg" : "image/vnd.dxf", r.ref.path.replace(/^.*[\\/]/, "")).id;
    refs.push(r.ref);
  }
  for (const [h, bytes] of d.imageBytes ?? []) {
    const ref = refs.find((r) => r.kind === "image" && r.found && !r.assetId && (d.imageDefs.get(h) ?? "") === r.path);
    const pic = drawable(bytes);
    if (!pic) {
      if (ref) ref.found = false;
      continue;
    }
    const a = keep(pic.bytes, pic.mime, (d.imageDefs.get(h) ?? "image").replace(/^.*[\\/]/, ""));
    (d.images ??= new Map()).set(h, a.id);
    if (ref) ref.assetId = a.id;
  }
  d.imageBytes = undefined;

  // SHX fonts the styles name, when this computer has them (drawing folder, 경로 지정 folders, AutoCAD's Fonts folder)
  await (await import("./shxLoad")).loadDrawingShx(d, f.path ? dirOf(f.path) : "", cadSearchDirs(), cadFileReader()).catch(() => []);

  const fmt = kind === "dwg" ? "DWG" : "DXF";
  const variants = new Set<StrokeVariant>();
  const shxText = () => {
    let s = "";
    for (const p of r.pages)
      for (const nd of p.nodes)
        if (nd.type === "TEXT")
          for (const para of nd.paragraphs)
            for (const run of para.runs) {
              const v = strokeVariantOf(run.fontFamily);
              if (v) (s += run.text), variants.add(v);
            }
    return s;
  };
  const asset = makeAsset(f.bytes, kind === "dwg" ? "image/vnd.dwg" : "image/vnd.dxf", f.name);
  const r = buildCadPages(d, { name: baseName(f.name), format: kind, asset, refs, assets });
  const skipped = Object.values(problems).reduce((a, v) => a + v, 0);
  if (skipped) r.warnings.push(t("engine.cad.warn.dwgSkipped", { n: skipped, list: Object.entries(problems).map(([k, v]) => `${k} ${v}`).slice(0, 5).join(", ") }));
  const loaded = refs.filter((x) => x.found);
  // a missing external file comes first (the message shows the first warning), then what was loaded
  if (loaded.length) r.warnings.splice(refs.some((x) => !x.found) ? 1 : 0, 0, t("engine.cad.warn.refsLoaded", { n: loaded.length, list: loaded.map((x) => x.name).slice(0, 4).join(", ") }));
  const n = Object.values(r.counts).reduce((a, v) => a + v, 0);
  // SHX text is set in Omni Stroke: the font is built before the first paint
  const text = shxText();
  if (text) await (await import("./strokeInstall")).installStrokeFont(text, variants).catch(() => {});
  const message = t("engine.open.cad", { fmt, release: RELEASES[d.version] ?? d.version, layers: r.layers, n, scale: scaleLabel(r.scale) }) + (r.warnings.length ? " · " + r.warnings[0] : "");
  return { pages: r.pages, assets: r.assets, mode: "DESIGN", warnings: r.warnings, message, refs };
}
