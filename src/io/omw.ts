// .omw (Omniweave Workspace Package) — zip container.
//
//   mimetype                     "application/x-omniweave" (stored, first entry)
//   manifest.json                metadata, Loom root address, index map, container number
//   scene_graph.cbor             container 1: the unified scene graph (pixel data replaced by thread hashes)
//   scene_graph2.cbor            container 2: the same graph (renamed so apps that only read container 1 refuse the
//                                file instead of opening it with layers missing — see docs/design/FILE_SIZE.md)
//   slides/slide_deck.json       slide order, transitions, animations (readable mirror)
//   slides/master_styles.json    slide masters
//   vectors/paths.json           vector nodes with SVG path data (readable mirror)
//   rasters/<hash>.raw           container 1: deduplicated 256x256 RGBA tiles (Loom threads), deflated
//   rasters/<hash>.png           container 2: the same tiles as lossless PNG (prediction filters + deflate)
//   rasters/derived.json         container 2: tiles re-derived from an original file in assets/ (unedited PSD layers)
//   documents/document.xml       paragraphs of every text node (readable mirror)
//   assets/<hash>.<ext>          images, PDFs, fonts — only those something in the file still uses
//   history/index.cbor           work history; container 2 (index v2) does not repeat nodes of the scene graph
//
// The readable mirrors are for interoperability; loading uses the scene graph + threads, and every thread is
// verified against its hash on load. Readers accept containers 1 and 2.

import { t } from "../i18n";
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from "fflate";
import { Encoder, decode } from "cbor-x";
import { extForMime, getBlob, putBlob } from "../core/assets";
import { hashBytes } from "../core/hash";
import { dehydrate, documentRoot, hydrate, nodeHash, type HydrateReport } from "../core/loom";
import { packHistory, unpackHistory, type HistoryEntry } from "../core/history";
import { plainText } from "../core/text";
import { vectorToSvgD } from "../core/vector";
import type { OmwDocument, SceneNode } from "../core/types";
import { OMW_CONTAINER, migrateGraph, requiredVersion, storedVersion, type MigrationReport } from "./omwMigrate";
import { PSD_RECIPE, PSD_RECIPES, derivableFor, derivationPortable, derivePsdTiles, derivesAsImported, psdSources, recipeFor, registerDerivedHashes, type DerivedIndex } from "./omwDerive";
import { decodeTile, encodeTile } from "./tileCodec";

export const OMW_MIME = "application/x-omniweave";
const encoder = new Encoder({ useRecords: false, mapsAsObjects: true });

function xmlEscape(s: string) {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

export interface PackStats {
  historyEntries: number;
  tiles: number;
  assets: number;
  bytes: number;
  root: string;
  /** tiles written as PNG / listed as derivable from an original in assets/ */
  storedTiles: number;
  derivedTiles: number;
  /** assets no node, page or history entry uses any more (left out of the file) */
  droppedAssets: number;
}

export interface PackOptions {
  /**
   * 2 (default): PNG tiles, derived tiles, history without repeated nodes. 1: the older layout (`.raw` tiles, full
   * history) for apps that read only container 1.
   */
  container?: 1 | 2;
  /** container 2: list unedited PSD tiles as derivable instead of storing them (default true) */
  derive?: boolean;
}

// ───────── tile PNG cache: content-addressed, so a tile is encoded once per session ─────────

const PNG_CACHE_LIMIT = 96 * 1024 * 1024;
const pngCache = new Map<string, Uint8Array>();
let pngCacheBytes = 0;
function cachePng(h: string, png: Uint8Array) {
  if (pngCache.has(h)) return;
  pngCache.set(h, png);
  pngCacheBytes += png.length;
  for (const [k, v] of pngCache) {
    if (pngCacheBytes <= PNG_CACHE_LIMIT) break;
    pngCache.delete(k);
    pngCacheBytes -= v.length;
  }
}
function tilePng(h: string, data: Uint8ClampedArray): Uint8Array {
  let png = pngCache.get(h);
  if (!png) cachePng(h, (png = encodeTile(data)));
  return png;
}

// ───────── unreferenced assets ─────────

/** Asset ids (or hashes) that appear anywhere in the documents outside their asset tables. */
function usedAssets(docs: OmwDocument[], table: Record<string, { id: string; hash: string }>): Set<string> {
  const wanted = new Set<string>();
  for (const a of Object.values(table)) wanted.add(a.id), wanted.add(a.hash);
  const used = new Set<string>();
  const seen = new WeakSet<object>();
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (wanted.has(v)) used.add(v);
      return;
    }
    if (!v || typeof v !== "object" || ArrayBuffer.isView(v) || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) for (const x of v) walk(x);
    else for (const x of Object.values(v)) walk(x);
  };
  for (const d of docs) for (const [k, v] of Object.entries(d)) if (k !== "assets") walk(v);
  return used;
}

export function packOmw(doc: OmwDocument, history: HistoryEntry[] = [], opts: PackOptions = {}): { bytes: Uint8Array; stats: PackStats } {
  const container = opts.container ?? OMW_CONTAINER;
  const withHistory = history.length > 1;
  // assets nobody uses (a deleted image, a replaced PDF) are left out; ids and hashes are both looked for, in every
  // field of every saved state (nodes, pages, page sources, document styles…), so nothing still in use is dropped
  const allTables: Record<string, { id: string; hash: string }> = { ...doc.assets };
  if (withHistory) for (const e of history) Object.assign(allTables, e.doc.assets);
  const used = usedAssets(withHistory ? [doc, ...history.map((e) => e.doc)] : [doc], allTables);
  const keep = (table: OmwDocument["assets"]): OmwDocument["assets"] => {
    const ks = Object.keys(table).filter((k) => used.has(table[k].id) || used.has(table[k].hash));
    if (ks.length === Object.keys(table).length) return table;
    return Object.fromEntries(ks.map((k) => [k, table[k]]));
  };
  const kept = keep(doc.assets);
  const droppedAssets = Object.keys(doc.assets).length - Object.keys(kept).length;
  const saved: OmwDocument = kept === doc.assets ? doc : { ...doc, assets: kept };

  const { graph, tiles } = dehydrate(saved);
  // history/ — separate section; shares tiles with the document so unchanged pixels are stored once, and (container 2)
  // does not repeat the nodes the scene graph already has
  const shared = new Set<string>();
  if (container === 2) for (const p of [...saved.pages, ...saved.masters]) for (const n of p.nodes) shared.add(nodeHash(n));
  const hist = withHistory ? (container === 2 ? packHistory(history, { shared, assets: keep }) : packHistory(history)) : null;
  if (hist) for (const [h, d] of hist.tiles) tiles.set(h, d);
  const files: Zippable = {};
  files["mimetype"] = [strToU8(OMW_MIME), { level: 0 }];

  const root = documentRoot(saved);
  const allPages = [...saved.pages, ...saved.masters];

  // which tiles decoding a kept original (PSD) gives back exactly
  const derived: DerivedIndex = { recipe: PSD_RECIPE, from: {} };
  const derivedSet = new Set<string>();
  if (container === 2 && opts.derive !== false) {
    const assetHashes = new Set(Object.values(saved.assets).map((a) => a.hash));
    for (const h of psdSources(saved)) {
      const blob = getBlob(h);
      if (!assetHashes.has(h) || !blob || !derivationPortable(blob)) continue;
      const can = derivableFor(h, () => getBlob(h));
      const list = [...tiles.keys()].filter((t) => can.has(t) && !derivedSet.has(t));
      if (!list.length) continue;
      list.forEach((t) => derivedSet.add(t));
      derived.from[h] = list;
      // tiles of a colour-managed CMYK document need psd/2 (the other assets derive the same under either)
      if (recipeFor(blob) !== PSD_RECIPE) derived.recipe = recipeFor(blob);
    }
  }

  const manifest = {
    format: "omw",
    // 1 unless a v2 style field is present (io/omwMigrate.ts) — files without new fields stay byte-identical
    version: requiredVersion(saved),
    ...(container === 2 ? { container: 2 } : {}),
    engine: "Loom/1",
    generator: "Omniweave 0.1.0",
    title: saved.title,
    created: saved.created,
    modified: saved.modified,
    root,
    index: {
      pages: saved.pages.map((p) => ({ id: p.id, name: p.name, kind: p.kind, width: p.width, height: p.height, nodes: p.nodes.length })),
      masters: saved.masters.map((p) => ({ id: p.id, name: p.name })),
      tiles: tiles.size,
      assets: Object.keys(saved.assets).length,
    },
  };
  files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  files[container === 2 ? "scene_graph2.cbor" : "scene_graph.cbor"] = encoder.encode(graph);

  const slides = saved.pages.filter((p) => p.kind === "SLIDE");
  files["slides/slide_deck.json"] = strToU8(
    JSON.stringify(
      slides.map((p) => ({ id: p.id, masterLayoutId: p.masterId, elements: p.nodes.map((n) => n.id), transitions: p.transition, animations: p.animations })),
      null,
      1,
    ),
  );
  files["slides/master_styles.json"] = strToU8(JSON.stringify(saved.masters.map((m) => ({ id: m.id, name: m.name, background: m.background, elements: m.nodes.map((n) => n.id) })), null, 1));

  const vectors = allPages.flatMap((p) =>
    p.nodes.filter((n) => n.type === "VECTOR").map((n) => (n.type === "VECTOR" ? { pageId: p.id, id: n.id, name: n.name, d: vectorToSvgD(n), transform: n.transform, fill: n.fill, stroke: n.stroke, strokeWidth: n.strokeWidth, contours: n.contours } : null)),
  );
  files["vectors/paths.json"] = strToU8(JSON.stringify(vectors));

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<omw:document xmlns:omw="https://omniweave.app/ns/document">\n`;
  for (const p of allPages)
    for (const n of p.nodes)
      if (n.type === "TEXT") {
        xml += ` <omw:text page="${p.id}" node="${n.id}">\n`;
        for (const para of n.paragraphs) {
          xml += `  <omw:p align="${para.align}" lineSpacing="${para.lineSpacing}">`;
          for (const r of para.runs)
            xml += `<omw:r font="${xmlEscape(r.fontFamily)}" size="${r.fontSize}" bold="${r.bold}" italic="${r.italic}" color="${r.color}">${xmlEscape(r.text)}</omw:r>`;
          xml += `</omw:p>\n`;
        }
        xml += ` </omw:text>\n`;
      }
  xml += `</omw:document>\n`;
  files["documents/document.xml"] = strToU8(xml);

  if (hist) {
    files["history/index.cbor"] = encoder.encode(hist.index);
    files["history/nodes.cbor"] = encoder.encode(hist.nodes);
  }
  let storedTiles = 0;
  if (container === 2) {
    for (const [h, data] of tiles) {
      if (derivedSet.has(h)) continue;
      files[`rasters/${h}.png`] = [tilePng(h, data), { level: 0 }]; // already deflated inside the PNG
      storedTiles++;
    }
    if (derivedSet.size) files["rasters/derived.json"] = strToU8(JSON.stringify(derived));
  } else {
    for (const [h, data] of tiles) files[`rasters/${h}.raw`] = [new Uint8Array(data.buffer, data.byteOffset, data.byteLength), { level: 6 }];
    storedTiles = tiles.size;
  }

  let assetCount = 0;
  const assetsOut = new Map<string, { hash: string; mime: string }>();
  for (const a of Object.values(saved.assets)) assetsOut.set(`${a.hash}.${extForMime(a.mime)}`, a);
  if (hist) for (const tbl of Object.values(hist.index.assetTables ?? {})) for (const a of Object.values(tbl)) assetsOut.set(`${a.hash}.${extForMime(a.mime)}`, a);
  if (hist && container !== 2) for (const e of history) for (const a of Object.values(e.doc.assets)) assetsOut.set(`${a.hash}.${extForMime(a.mime)}`, a);
  for (const [file, a] of assetsOut) {
    const b = getBlob(a.hash);
    if (!b) continue;
    const name = `assets/${file}`;
    if (files[name]) continue;
    files[name] = [b, { level: assetLevel(a.mime, b) }];
    assetCount++;
  }
  // plain-text preview for search/indexers
  files["documents/preview.txt"] = strToU8(
    allPages.flatMap((p) => p.nodes.filter((n) => n.type === "TEXT").map((n) => (n.type === "TEXT" ? plainText(n) : ""))).join("\n\n"),
  );

  const bytes = zipSync(files, { level: 6 });
  return {
    bytes,
    stats: { historyEntries: hist ? history.length : 0, tiles: tiles.size, assets: assetCount, bytes: bytes.length, root, storedTiles, derivedTiles: derivedSet.size, droppedAssets },
  };
}

/** Already-compressed formats are stored (deflating them again costs time and gains nothing). */
const COMPRESSED_MIME = /^(image\/(png|jpeg|webp|gif|avif|heic|heif)|font\/woff2?|video\/.*|audio\/(mpeg|mp4|aac|ogg|webm|flac|opus)|application\/(zip|epub\+zip|vnd\.openxmlformats.*))$/;
function assetLevel(mime: string, b: Uint8Array): 0 | 6 {
  if (COMPRESSED_MIME.test(mime)) return 0;
  // zip-based containers (PPTX/DOCX/HWPX/EPUB) start with PK: their parts are deflated already
  if (b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return 0;
  return 6;
}

export interface UnpackResult {
  doc: OmwDocument;
  history: HistoryEntry[];
  report: HydrateReport & {
    missingAssets: number;
    corruptAssets: number;
    rootMatches: boolean;
    historySkipped: number;
    version: MigrationReport;
    /** container number the file declared (1 for files without one) */
    container: number;
    /** tiles rebuilt from an original file in the package (verified like stored ones) */
    derivedTiles: number;
  };
}

export function unpackOmw(bytes: Uint8Array): UnpackResult {
  const files = unzipSync(bytes);
  if (files["mimetype"] && strFromU8(files["mimetype"]) !== OMW_MIME) throw new Error(t("engine.omw.notOmw"));
  const manifest = files["manifest.json"] ? JSON.parse(strFromU8(files["manifest.json"])) : {};
  const container = Number.isInteger(manifest.container) ? manifest.container : 1;
  if (container > OMW_CONTAINER) throw new Error(t("size.omw.newerContainer", { n: container }));
  const sg = files["scene_graph2.cbor"] ?? files["scene_graph.cbor"];
  if (!sg) throw new Error(t("engine.omw.noSceneGraph"));
  const graph = decode(sg);

  // assets first: derived tiles are decoded from them
  let missingAssets = 0, corruptAssets = 0;
  const assetOk = new Set<string>();
  const loadAsset = (a: { hash: string; mime: string }) => {
    const key = `${a.hash}.${extForMime(a.mime)}`;
    if (assetOk.has(key)) return true;
    const f = files[`assets/${key}`];
    if (!f || hashBytes(f) !== a.hash) return false;
    putBlob(f);
    assetOk.add(key);
    return true;
  };
  for (const a of Object.values((graph.assets ?? {}) as Record<string, { hash: string; mime: string }>)) {
    const f = files[`assets/${a.hash}.${extForMime(a.mime)}`];
    if (!f) missingAssets++;
    else if (!loadAsset(a)) corruptAssets++;
  }

  const derivedIdx: DerivedIndex | null = files["rasters/derived.json"] ? JSON.parse(strFromU8(files["rasters/derived.json"])) : null;
  const derivedFrom = new Map<string, string>(); // tile hash → asset hash
  // tiles listed under a recipe this app does not know cannot be rebuilt: refuse (like a newer container) rather than
  // open with those layers empty, where saving would make the loss permanent
  if (derivedIdx && !PSD_RECIPES.has(derivedIdx.recipe)) throw new Error(t("size.omw.newerContainer", { n: String(derivedIdx.recipe) }));
  if (derivedIdx) for (const [a, list] of Object.entries(derivedIdx.from ?? {})) for (const h of list) derivedFrom.set(h, a);
  const derivedCache = new Map<string, Map<string, Uint8ClampedArray>>();
  const derivedUsed = new Set<string>();
  const getTile = (h: string): Uint8ClampedArray | undefined => {
    const raw = files[`rasters/${h}.raw`];
    if (raw) return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.byteLength);
    const png = files[`rasters/${h}.png`];
    if (png) {
      const data = decodeTile(png);
      if (data.length && hashBytes(data) === h) cachePng(h, png); // re-saving writes the same bytes without re-encoding
      return data;
    }
    const from = derivedFrom.get(h);
    if (!from) return undefined;
    let m = derivedCache.get(from);
    if (!m) {
      const b = getBlob(from);
      try {
        m = b && hashBytes(b) === from ? derivePsdTiles(b, derivedIdx!.recipe) : new Map();
      } catch {
        m = new Map();
      }
      derivedCache.set(from, m);
    }
    const d = m.get(h);
    if (d) derivedUsed.add(h);
    return d;
  };

  const { doc: stored, report } = hydrate(graph, getTile);
  // the derivation is known now: saving again lists the same tiles without decoding the original a second time — not
  // when the package's recipe decoded it otherwise than importing does today (CMYK listed under psd/1)
  for (const [a, m] of derivedCache) if (m.size && derivesAsImported(derivedIdx!.recipe, getBlob(a)!)) registerDerivedHashes(a, m.keys());
  // integrity is checked on the document exactly as stored, before any migration step
  const rootMatches = !manifest.root || documentRoot(stored) === manifest.root;
  const migrated = migrateGraph(stored, storedVersion(manifest, graph)) as { graph: OmwDocument; report: MigrationReport };
  const version = migrated.report;
  // a newer app's file remembers its version, so saving it here never writes a lower number (requiredVersion)
  const keepVersion = (d: OmwDocument): OmwDocument => (version.newer ? { ...d, version: version.from } : d);
  const doc = keepVersion(migrated.graph);
  let history: HistoryEntry[] = [];
  let historySkipped = 0;
  if (files["history/index.cbor"] && files["history/nodes.cbor"]) {
    try {
      const index = decode(files["history/index.cbor"]);
      // index v2 leaves out nodes the scene graph has: resolve them by node hash
      const sharedNodes = new Map<string, SceneNode>();
      if (index?.version >= 2) for (const p of [...stored.pages, ...stored.masters]) for (const n of p.nodes) sharedNodes.set(nodeHash(n), n);
      const r = unpackHistory(index, decode(files["history/nodes.cbor"]), getTile, sharedNodes);
      // assets only older states use (a deleted image you can go back to)
      for (const e of r.entries) for (const a of Object.values(e.doc.assets)) loadAsset(a);
      history = version.newer ? r.entries.map((e) => ({ ...e, doc: keepVersion(e.doc) })) : r.entries;
      historySkipped = r.skipped;
    } catch {
      historySkipped = -1; // unreadable history never blocks opening the document
    }
  }
  return { doc, history, report: { ...report, missingAssets, corruptAssets, rootMatches, historySkipped, version, container, derivedTiles: derivedUsed.size } };
}
