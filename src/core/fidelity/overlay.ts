// Fidelity overlay bookkeeping (pure): which mismatching tiles of a PSD score may still show Photoshop's merged
// image instead of our render. A tile shows it only while every layer that reaches the tile is exactly as it was
// imported — the moment the user edits, moves, hides, deletes or adds something there, our render shows (and the
// badge counts the tile as edited). The check is stateless, so undo brings the overlay back.
//
// The overlay is a view: it is drawn on the screen canvas only (ui/fidelity.ts). Nothing here is written into
// PSD or any export; the cached score lives in page.source.psdScore so reopening an .omw does not recompute it.

import { hashString } from "../hash";
import { nodeBounds } from "../loom";
import { rasterFingerprint } from "../../io/formats/psd";
import { effectsFingerprint } from "../style/fingerprint";
import type { Page, PsdLayerLink, RasterNode, SceneNode } from "../types";
import { badTiles, type PsdScore, type ScoreRun } from "./psdScore";

/** Edit tracking stored with the score. Node ids are values (not keys) so page-id renaming keeps them. */
export interface PsdScoreTrack {
  /** per layer drawn at scoring time: [node id, signature ("" = already edited), x, y, w, h] */
  layers: [string, string, number, number, number, number][];
  /** z-order of those nodes */
  order: string;
  /** folders (structure, opacity, visibility, blend) */
  groups: string;
  /** page size and background */
  page: string;
  /** hidden node holding Photoshop's merged image (the overlay's pixels) */
  composite: string;
}

export interface PsdScoreCache extends PsdScore {
  track: PsdScoreTrack;
  /** still running: the tiles scored so far (kept in memory only, never in page.source) */
  partial?: boolean;
}

const sigs = new WeakMap<SceneNode, string>();

/** Everything about a node that changes its pixels (not its name or lock), as a hash. */
export function nodeSig(n: SceneNode): string {
  let s = sigs.get(n);
  if (s === undefined) {
    const { id: _id, name: _name, locked: _locked, ...rest } = n as SceneNode & Record<string, unknown>;
    const body = n.type === "RASTER" ? { ...rest, tiles: rasterFingerprint(n) } : rest;
    s = hashString(JSON.stringify(body));
    sigs.set(n, s);
  }
  return s;
}

import { groupsSig, orderSig, pageSig, structureSig } from "./structureSig";

/** Is the node still the layer the PSD import made (same pixels, place, opacity, visibility, blend, clip)? */
function asImported(n: SceneNode | undefined, l: PsdLayerLink): boolean {
  if (!n || n.type !== "RASTER" || !l.node) return false;
  const t = n.transform;
  return (
    rasterFingerprint(n) === l.fp &&
    Math.abs(n.opacity - (l.opacity ?? 1)) < 1e-6 &&
    n.visible === l.visible &&
    n.blendMode === l.blend &&
    t.x === l.x && t.y === l.y && !t.rotation && t.scale === 1 && (t.scaleY ?? 1) === 1 &&
    !!n.clip === !!l.clip &&
    !n.crop &&
    // layer effects as imported (the PSD writer's rule: psdWrite.ts fxChanged)
    (l.fx !== undefined ? effectsFingerprint(n.effects) === l.fx : !n.effects?.length)
  );
}

/**
 * The cache for `page` from a scoring run of its PSD file. Layers the user already changed before scoring
 * finished get an empty signature, so their tiles never show the merged image.
 */
export function buildCache(page: Page, run: ScoreRun, hash: string, partial = false): PsdScoreCache {
  const links = page.source?.psd?.layers ?? [];
  const byId = new Map(page.nodes.map((n) => [n.id, n]));
  const layers: PsdScoreTrack["layers"] = [];
  links.forEach((l, i) => {
    if (!l.node) return;
    const n = byId.get(l.node);
    const b = run.layerBounds[i] ?? (n ? rectOf(nodeBounds(n)) : null);
    if (!b) return;
    layers.push([l.node, asImported(n, l) ? nodeSig(n!) : "", ...b]);
  });
  const ids = new Set(layers.map((l) => l[0]));
  const { heat: _heat, ...rest } = run.score;
  return {
    ...(partial ? rest : run.score),
    hash,
    ...(partial ? { partial: true } : {}),
    track: { layers, order: orderSig(page, ids), groups: groupsSig(page), page: pageSig(page), composite: page.source?.psd?.compositeNode ?? "" },
  };
}

/**
 * May the overlay draw this node's tiles as Photoshop's merged image? Only while it is the hidden, page-sized
 * raster the import made: tiles are drawn at their page-grid place, so a moved, scaled, rotated or cropped node
 * (or one the user made visible, which then is our render) must not be used.
 */
export function compositeOverlayable(n: SceneNode | undefined): n is RasterNode {
  if (!n || n.type !== "RASTER" || n.visible || n.crop) return false;
  const t = n.transform;
  return t.x === 0 && t.y === 0 && !t.rotation && t.scale === 1 && (t.scaleY ?? 1) === 1;
}

const pristineMemo = new WeakMap<Page, Page | null>();

/**
 * "View" of a PSD page that is still exactly as imported: Photoshop's merged image alone (layers, folders, page and
 * order unchanged, nothing added) — what thumbnails, PNG / PDF export and the slide show draw, so an unedited file
 * looks exactly as in Photoshop (adjustment layers, dissolve… included). null once anything changed (then our
 * compositing shows; the screen keeps its per-tile overlay, ui/fidelity.ts). The layers stay in the document.
 */
export function pristinePsdView(page: Page): Page | null {
  let v = pristineMemo.get(page);
  if (v !== undefined) return v;
  v = null;
  const p = page.source?.psd;
  const comp = p?.compositeNode ? page.nodes.find((n) => n.id === p.compositeNode) : undefined;
  if (p?.importSig && compositeOverlayable(comp)) {
    const byId = new Map(page.nodes.map((n) => [n.id, n]));
    const ids = new Set<string>();
    let same = true;
    for (const l of p.layers) {
      if (!l.node) continue;
      ids.add(l.node);
      if (!asImported(byId.get(l.node), l)) same = false;
    }
    // a node the import did not make (added by the user) changes the look
    if (same) for (const n of page.nodes) if (n.id !== comp.id && !ids.has(n.id) && n.visible) same = false;
    if (same && structureSig(page, ids) === p.importSig) v = { ...page, nodes: [{ ...comp, visible: true }], groups: undefined };
  }
  pristineMemo.set(page, v);
  return v;
}

const rectOf = (r: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [r.x, r.y, r.w, r.h];

export interface LiveTiles {
  /** mismatching tiles that still show Photoshop's merged image */
  shown: number[];
  /** mismatching tiles whose layers were edited (our render shows) */
  edited: number[];
}

const live = new WeakMap<Page, { cache: PsdScoreCache; out: LiveTiles }>();
/** Effects (shadows, glows) may reach past a node's box. */
const REACH = 32;

/** Split a score's mismatching tiles into still-shown and edited for the page as it is now (memoised per page). */
export function liveTiles(page: Page, cache: PsdScoreCache): LiveTiles {
  const m = live.get(page);
  if (m && m.cache === cache) return m.out;
  const bad = [...badTiles(cache).keys()];
  const tr = cache.track;
  let out: LiveTiles;
  if (tr.groups !== groupsSig(page) || tr.page !== pageSig(page) || tr.order !== orderSig(page, new Set(tr.layers.map((l) => l[0])))) {
    out = { shown: [], edited: bad };
  } else {
    const byId = new Map(page.nodes.map((n) => [n.id, n]));
    const known = new Set<string>([tr.composite]);
    const dirty: [number, number, number, number][] = [];
    const grow = (r: { x: number; y: number; w: number; h: number }): [number, number, number, number] => [r.x - REACH, r.y - REACH, r.w + 2 * REACH, r.h + 2 * REACH];
    // an adjustment layer with a white-default mask recolours the whole page (its bounds are only its mask's); a
    // zero-size record of the score is one too
    const whole: [number, number, number, number] = [-REACH, -REACH, page.width + 2 * REACH, page.height + 2 * REACH];
    const reach = (n: Page["nodes"][number]) => (n.type === "RASTER" && n.adjust?.hide ? whole : grow(nodeBounds(n)));
    for (const [id, sig, x, y, w, h] of tr.layers) {
      known.add(id);
      const n = byId.get(id);
      if (n && sig && nodeSig(n) === sig) continue;
      dirty.push(w > 0 && h > 0 ? [x - REACH, y - REACH, w + 2 * REACH, h + 2 * REACH] : whole);
      if (n) dirty.push(reach(n));
    }
    for (const n of page.nodes) if (!known.has(n.id) && n.visible) dirty.push(reach(n));
    out = { shown: [], edited: [] };
    const T = cache.tile;
    for (const i of bad) {
      const tx = (i % cache.cols) * T, ty = Math.floor(i / cache.cols) * T;
      const hit = dirty.some(([x, y, w, h]) => x < tx + T && x + w > tx && y < ty + T && y + h > ty);
      (hit ? out.edited : out.shown).push(i);
    }
  }
  live.set(page, { cache, out });
  return out;
}
