// ─────────────────────────────────────────────────────────────────────────────
//  Loom engine — Omniweave's content-addressed document core.
//
//  Thread   : every immutable chunk (pixel tile, node, asset) has a 64-bit content address.
//  Weave key: the identity of a screen tile = hash of the threads that touch that region.
//             Rendering is a pure function of the key, so cached tiles never need
//             invalidation; undo/redo and page switching reuse earlier tiles for free.
//  Shuttle  : persistence writes only threads it has not written before (journal/.omw).
// ─────────────────────────────────────────────────────────────────────────────

import { hashBytes, hashString } from "./hash";
import { inverseTransformRect, intersects, transformRect, type Rect } from "./geom";
import { layoutTable } from "./table";
import { layoutText, textMetricsEpoch } from "./text";
import { vectorLocalBounds } from "./vector";
import { TILE } from "./tile";
import type { OmwDocument, Page, PixelTile, RasterNode, SceneNode } from "./types";
import { visibleBounds } from "./crop";
import { groupIndex, groupPath, hasStructure } from "./layerTree";
import { growRect, maxMargin, paintMargins, type Margins } from "./style/effects";

// ---------- threads ----------

export { isBlank, makeTile } from "./tile";

const nodeHashes = new WeakMap<object, string>();

function stripPixels(key: string, value: unknown) {
  if (key === "data" && value instanceof Uint8ClampedArray) return undefined;
  return value;
}

/** Content address of a node (memoized by identity; nodes are immutable). */
export function nodeHash(n: SceneNode): string {
  let h = nodeHashes.get(n);
  if (!h) {
    h = hashString(JSON.stringify(n, stripPixels));
    nodeHashes.set(n, h);
  }
  return h;
}

const propHashes = new WeakMap<object, string>();
/** Hash of a raster node's properties without its tile map. */
function rasterPropsHash(n: RasterNode): string {
  let h = propHashes.get(n);
  if (!h) {
    const { tiles: _t, ...rest } = n;
    h = hashString(JSON.stringify(rest));
    propHashes.set(n, h);
  }
  return h;
}

// ---------- geometry ----------

const boundsCache = new WeakMap<object, { epoch: number; rect: Rect }>();

/** Local bounds of what is shown: cropped images / raster layers / PDF pages report their crop. */
export function localBounds(n: SceneNode): Rect {
  if ((n.type === "RASTER" || n.type === "IMAGE" || n.type === "PDF") && n.crop) return visibleBounds(n);
  switch (n.type) {
    case "RASTER": {
      const keys = Object.keys(n.tiles);
      if (!keys.length) return { x: 0, y: 0, w: 0, h: 0 };
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const k of keys) {
        const [tx, ty] = k.split("_").map(Number);
        x0 = Math.min(x0, tx); y0 = Math.min(y0, ty); x1 = Math.max(x1, tx); y1 = Math.max(y1, ty);
      }
      return { x: x0 * TILE, y: y0 * TILE, w: (x1 - x0 + 1) * TILE, h: (y1 - y0 + 1) * TILE };
    }
    case "VECTOR":
      return vectorLocalBounds(n);
    case "TEXT": {
      const h = layoutText(n).height;
      if (!n.ph) return { x: 0, y: 0, w: n.width, h };
      // a slide placeholder: its whole box (the text may overflow it)
      const top = -(n.ph.dy ?? 0);
      const y0 = Math.min(0, top), y1 = Math.max(h, top + n.ph.h);
      return { x: 0, y: y0, w: n.width, h: y1 - y0 };
    }
    case "IMAGE":
    case "PDF":
    case "MEDIA":
      return { x: 0, y: 0, w: n.width, h: n.height };
    case "TABLE": {
      const l = layoutTable(n);
      return { x: 0, y: 0, w: l.width, h: l.height };
    }
  }
}

/** Page-space bounding box. */
export function nodeBounds(n: SceneNode): Rect {
  // text / table bounds depend on font metrics: recompute after a web font finished loading
  const epoch = n.type === "TEXT" || n.type === "TABLE" ? textMetricsEpoch() : 0;
  let b = boundsCache.get(n);
  if (!b || b.epoch !== epoch) {
    b = { epoch, rect: transformRect(n.transform, localBounds(n)) };
    boundsCache.set(n, b);
  }
  return b.rect;
}

/** Page-space box of what a node paints: its bounds grown by its effects' reach (the selection box stays nodeBounds). */
export function paintBounds(n: SceneNode, groupChain: Parameters<typeof paintMargins>[1] = []): Rect {
  return n.effects?.length || groupChain.some((g) => g.effects?.length) ? growRect(nodeBounds(n), paintMargins(n, groupChain)) : nodeBounds(n);
}

/** Largest effect reach on a page (nodes plus nested groups), page units. */
export function pageEffectReach(page: Pick<Page, "nodes" | "groups">): number {
  let r = 0;
  for (const n of page.nodes) if (n.effects?.length) r = Math.max(r, maxMargin(paintMargins(n)));
  for (const g of page.groups ?? []) if (g.effects?.length) r += maxMargin(paintMargins({ effects: g.effects } as SceneNode));
  return r;
}

/** Tight raster bounds (only painted tiles), used for selection boxes. */
export function rasterTileKeysIn(n: RasterNode, pageRect: Rect): string[] {
  const local = inverseTransformRect(n.transform, pageRect);
  const tx0 = Math.floor(local.x / TILE), ty0 = Math.floor(local.y / TILE);
  const tx1 = Math.floor((local.x + local.w) / TILE), ty1 = Math.floor((local.y + local.h) / TILE);
  const out: string[] = [];
  const count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
  if (count > Object.keys(n.tiles).length) {
    for (const k of Object.keys(n.tiles)) {
      const [tx, ty] = k.split("_").map(Number);
      if (tx >= tx0 && tx <= tx1 && ty >= ty0 && ty <= ty1) out.push(k);
    }
  } else {
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) if (n.tiles[`${tx}_${ty}`]) out.push(`${tx}_${ty}`);
  }
  return out.sort();
}

/**
 * Region-addressed contribution of a node to a page rectangle.
 * Raster layers contribute only the pixel tiles under the region, so a brush stroke
 * changes the weave key of just the screen tiles it touched.
 */
export function regionKey(n: SceneNode, region: Rect, reach?: Margins): string | null {
  if (!n.visible) return null;
  // an adjustment layer with a white-default mask recolours everywhere (its tiles are only where it is held back):
  // part of every region, keyed by its settings (in the props hash) and the mask tiles there
  if (n.type === "RASTER" && n.adjust?.hide) return "adj:" + rasterPropsHash(n) + ":" + rasterTileKeysIn(n, region).map((k) => n.tiles[k].hash).join(",");
  // effects (own and the enclosing groups'): what the node paints reaches beyond its box, and pixels outside the
  // region can cast into it — the reach grows the box tested against the region and the raster tiles read
  const m = reach && (reach.l || reach.t || reach.r || reach.b) ? reach : null;
  if (!intersects(m ? growRect(nodeBounds(n), m) : nodeBounds(n), region)) return null;
  if (n.type === "RASTER") {
    const keys = rasterTileKeysIn(n, m ? growRect(region, { l: m.r, t: m.b, r: m.l, b: m.t }) : region);
    if (!keys.length) return null;
    return rasterPropsHash(n) + ":" + keys.map((k) => n.tiles[k].hash).join(",");
  }
  return nodeHash(n);
}

export function weaveKey(page: Page, master: Page | null, region: Rect, scale: number, exclude: Set<string> | null): { key: string; nodes: SceneNode[] } {
  const parts: string[] = [page.background, `${page.width}x${page.height}`, scale.toFixed(4), `${region.x},${region.y},${region.w}`];
  const nodes: SceneNode[] = [];
  const reachOf = (pg: Page) => {
    const idx = pg.groups?.some((g) => g.effects?.length) ? groupIndex(pg.groups) : null;
    return (n: SceneNode) => (n.effects?.length || idx ? paintMargins(n, idx ? groupPath(n.groupId, idx) : []) : undefined);
  };
  const reachM = master ? reachOf(master) : null, reachP = reachOf(page);
  const add = (n: SceneNode, reach: (n: SceneNode) => Margins | undefined) => {
    if (exclude?.has(n.id)) return;
    const k = regionKey(n, region, reach(n));
    if (k) {
      parts.push(k);
      nodes.push(n);
    }
  };
  if (master) master.nodes.forEach((n) => add(n, reachM!));
  page.nodes.forEach((n) => add(n, reachP));
  // groups / clipping: which base a clipped layer uses and how a group composites depend on layers outside
  // the tile too (order, membership, group settings) — that structure is part of every tile's identity
  if (master) parts.push(structureKey(master));
  parts.push(structureKey(page));
  return { key: hashString(parts.join("|")), nodes };
}

const structMemo = new WeakMap<readonly SceneNode[], { groups: unknown; key: string }>();
/** Hash of a page's group / clipping structure ("" for a page without either). */
export function structureKey(page: Page): string {
  if (!hasStructure(page.nodes, page.groups)) return "";
  const m = structMemo.get(page.nodes);
  if (m && m.groups === page.groups) return m.key;
  const key = hashString(JSON.stringify([page.groups ?? [], page.nodes.map((n) => [n.id, n.groupId ?? "", n.clip ? 1 : 0])]));
  structMemo.set(page.nodes, { groups: page.groups, key });
  return key;
}

// ---------- dehydrate / hydrate (shared by .omw packager and the journal) ----------

export interface ThreadSink {
  tiles: Map<string, Uint8ClampedArray>;
}

/** Replace pixel buffers by their thread hashes. Returns a plain-data graph. */
export function dehydrate(doc: OmwDocument): { graph: unknown; tiles: Map<string, Uint8ClampedArray> } {
  const tiles = new Map<string, Uint8ClampedArray>();
  const mapPage = (p: Page) => ({
    ...p,
    nodes: p.nodes.map((n) => {
      if (n.type !== "RASTER") return n;
      const t: Record<string, string> = {};
      for (const [k, tile] of Object.entries(n.tiles)) {
        t[k] = tile.hash;
        tiles.set(tile.hash, tile.data);
      }
      return { ...n, tiles: t };
    }),
  });
  const graph = { ...doc, pages: doc.pages.map(mapPage), masters: doc.masters.map(mapPage) };
  return { graph: JSON.parse(JSON.stringify(graph)), tiles };
}

export interface HydrateReport {
  missingTiles: number;
  corruptTiles: number;
}

export function hydrate(graph: any, getTile: (hash: string) => Uint8ClampedArray | undefined): { doc: OmwDocument; report: HydrateReport } {
  const report: HydrateReport = { missingTiles: 0, corruptTiles: 0 };
  const verified = new Map<string, PixelTile | null>();
  const mapPage = (p: any): Page => ({
    ...p,
    nodes: (p.nodes ?? []).map((n: any) => {
      if (n.type !== "RASTER") return n;
      const tiles: Record<string, PixelTile> = {};
      for (const [k, h] of Object.entries(n.tiles as Record<string, string>)) {
        let tile = verified.get(h);
        if (tile === undefined) {
          const data = getTile(h);
          if (!data) {
            report.missingTiles++;
            tile = null;
          } else if (data.length !== TILE * TILE * 4 || hashBytes(data) !== h) {
            report.corruptTiles++;
            tile = null;
          } else tile = { hash: h, data };
          verified.set(h, tile);
        }
        if (tile) tiles[k] = tile;
      }
      return { ...n, tiles };
    }),
  });
  const doc: OmwDocument = {
    format: "omw",
    version: 1,
    id: graph.id,
    title: graph.title ?? "제목 없음", // i18n: keep
    created: graph.created,
    modified: graph.modified,
    pages: (graph.pages ?? []).map(mapPage),
    masters: (graph.masters ?? []).map(mapPage),
    assets: graph.assets ?? {},
  };
  // document-level fields beyond the core ones (style sheets, swatches, theme — and fields of newer app versions)
  // pass through untouched, so opening and saving a file never drops what this version does not know yet
  for (const [k, v] of Object.entries(docExtras(graph))) (doc as any)[k] = v;
  return { doc, report };
}

/** Keys every OmwDocument has; anything else on a document is an optional extension (core/style DocStyleFields…). */
export const DOC_CORE_KEYS: readonly string[] = ["format", "version", "id", "title", "created", "modified", "pages", "masters", "assets"];

/** A document's (or graph's) optional extension fields, defined values only, in key order. */
export function docExtras(doc: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(doc).sort()) {
    const v = (doc as Record<string, unknown>)[k];
    if (!DOC_CORE_KEYS.includes(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** Root address of a whole document — equal documents have equal roots. */
export function documentRoot(doc: OmwDocument): string {
  const parts: string[] = [];
  for (const p of [...doc.masters, ...doc.pages]) {
    const { nodes, ...rest } = p;
    parts.push(hashString(JSON.stringify(rest)));
    for (const n of nodes) parts.push(nodeHash(n));
  }
  parts.push(hashString(JSON.stringify(doc.assets)));
  // extension fields count only when present, so documents without them keep their root
  const extra = docExtras(doc);
  if (Object.keys(extra).length) parts.push(hashString(JSON.stringify(extra)));
  return hashString(parts.join("/"));
}
