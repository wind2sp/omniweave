// .omw format versions and migrations (design ch. 8.1, work package S11).
//
//   v1  the scene graph as of 2026-11 (legacy per-node style fields only).
//   v2  v1 + the unified style fields (node fills / strokes / effects / mask…, document styles / lists / theme /
//       swatches). Every v2 field is optional and the legacy fields are still written next to it (dual-write), so a
//       v1 reader draws a v2 file almost the same — v1 → v2 needs no rewriting, only the number changes.
//
// Rules:
//   • integrity first: the Loom root is checked on the graph exactly as stored, before any migration step runs,
//     so a migration can never make an intact file look corrupt (or hide real corruption);
//   • lazy: nodes are not rewritten on open. Readers interpret legacy fields through core/style converters and a
//     node gets new fields only when it is edited (core/style/node.ts) — open + save leaves hashes and bytes alone;
//   • minimal writes: the file says v2 only when a v2 field is actually present (requiredVersion), new fields are
//     omitted when default;
//   • forward tolerant: a file from a newer version opens best-effort (unknown fields pass through untouched) and
//     the report says so.

import { DOC_CORE_KEYS } from "../core/loom";
import type { OmwDocument } from "../core/types";

/** Highest .omw version this app reads and writes. */
export const OMW_VERSION = 2;

/**
 * Package layout ("container"), separate from the graph version above (docs/design/FILE_SIZE.md):
 *   1  `scene_graph.cbor`, raw deflated tiles `rasters/<hash>.raw`, history repeats every node.
 *   2  `scene_graph2.cbor`, lossless PNG tiles `rasters/<hash>.png`, `rasters/derived.json` (unedited PSD tiles
 *      rebuilt from the original kept in assets/), history index v2 (scene nodes and equal asset tables stored once),
 *      unused assets left out. The graph is renamed so a container-1-only app refuses the file (its "scene graph
 *      missing" message) instead of opening it with layers missing and saving that loss.
 * Readers read both; `manifest.container` above this number is refused with an "update the app" message.
 */
export const OMW_CONTAINER = 2;

/** Node fields introduced in v2 (core/style). */
export const V2_NODE_FIELDS: readonly string[] = ["fills", "strokes", "effects", "mask", "vmask", "fillOpacity", "shape", "textFrame"];
/** Document fields introduced in v2 (core/style DocStyleFields). */
export const V2_DOC_FIELDS: readonly string[] = ["styles", "lists", "theme", "swatches"];

export interface GraphMigration {
  from: number;
  to: number;
  /** what the step does (for the report) */
  note: string;
  /** graph (dehydrated document, tiles as hashes) → graph of version `to`; must not touch untouched nodes */
  up: (graph: any) => any;
}

/** The migration chain, oldest first. */
export const MIGRATIONS: readonly GraphMigration[] = [
  // v2 only adds optional fields; v1 graphs are valid v2 graphs as they are
  { from: 1, to: 2, note: "v1→v2: optional style fields, nothing to rewrite", up: (g) => g },
];

export interface MigrationReport {
  /** version the file declared (manifest, else graph, else 1) */
  from: number;
  /** version of the document after migration */
  to: number;
  steps: string[];
  /** the file comes from a newer app version than this one */
  newer: boolean;
}

/** Version a stored file declares: the manifest's, else the scene graph's, else 1 (files from before versioning). */
export function storedVersion(manifest: any, graph: any): number {
  const v = Number(manifest?.version ?? graph?.version ?? 1);
  return Number.isInteger(v) && v >= 1 ? v : 1;
}

/** Run the steps from `from` up to OMW_VERSION (or the end of `chain`). Newer files are left as they are. */
export function migrateGraph(graph: any, from: number, chain: readonly GraphMigration[] = MIGRATIONS, target = OMW_VERSION): { graph: any; report: MigrationReport } {
  const report: MigrationReport = { from, to: from, steps: [], newer: from > target };
  let g = graph;
  while (report.to < target) {
    const step = chain.find((m) => m.from === report.to);
    if (!step) break;
    g = step.up(g);
    report.steps.push(step.note);
    report.to = step.to;
  }
  return { graph: g, report };
}

const hasV2NodeField = (n: object) => V2_NODE_FIELDS.some((k) => (n as Record<string, unknown>)[k] !== undefined);

/** Lowest version that can hold `doc`: 2 when any v2 field is present, else 1 (old files keep saying 1). */
export function requiredVersion(doc: OmwDocument): number {
  const d = doc as unknown as Record<string, unknown>;
  // a document opened from a newer app's file keeps that file's number (its unknown fields still mean what the
  // newer version says; writing a lower number would make the newer app migrate them a second time)
  if (Number.isInteger(doc.version) && doc.version > OMW_VERSION) return doc.version;
  if (V2_DOC_FIELDS.some((k) => d[k] !== undefined)) return 2;
  for (const p of [...doc.pages, ...doc.masters]) {
    for (const n of p.nodes) if (hasV2NodeField(n)) return 2;
    if (p.groups?.some((g) => g.effects !== undefined)) return 2;
  }
  return 1;
}

/** Document-level fields of a newer version this app does not know (kept, reported). */
export function unknownDocFields(doc: OmwDocument): string[] {
  return Object.keys(doc).filter((k) => !DOC_CORE_KEYS.includes(k) && !V2_DOC_FIELDS.includes(k));
}
