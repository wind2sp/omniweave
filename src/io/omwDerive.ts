// Tiles that can be re-derived from an original file kept in the package (.omw container 2, docs/design/FILE_SIZE.md).
//
// A PSD opened in Omniweave is kept twice: the original bytes (asset, needed for the byte-preserving PSD save) and
// its layers decoded into raster tiles. Tiles nobody edited are exactly what decoding the original gives again, so
// the package lists them in `rasters/derived.json` instead of storing their pixels; opening decodes the PSD once and
// verifies every tile against its hash like any other tile.
//
// RECIPE: the decoder output must stay the same for a recipe. A change to PSD decoding that changes pixels of
// unchanged files must use a new recipe id (and keep reading the old one) — tests/size/omw.test.ts pins it.
//   psd/1  CMYK decoded without colour management.
//   psd/2  CMYK decoded as the importer does: colour-managed (its own profile, else the default FOGRA39) through the
//          portable profile table (core/image/iccCmyk.ts — the same bits on every engine). Everything else as psd/1.
// A package names psd/2 only when it lists tiles of a colour-managed CMYK document (`recipeFor`); every other package
// stays psd/1, byte for byte as before, and older apps keep opening it. An older app refuses a psd/2 package as one
// from a newer version (its PSD_RECIPES check) instead of opening it with those layers empty — its psd/1 decoding of
// CMYK is colour-unmanaged and cannot rebuild them. Between colour management (2026-11-17) and psd/2 such tiles were
// stored as pixels (the table was floating point); those packages open unchanged. An .omw that lists CMYK tiles
// under psd/1 (saved before colour management) still derives them without colour management, as that app decoded
// them; those hashes are not taken for today's decoding (`derivesAsImported`), so saving again never lists them
// under psd/2.

import { hashBytes } from "../core/hash";
import { importPsdPage, psdCmykProfile, withoutCmykManagement } from "./formats/psd";
import { seedCmykStore } from "../core/image/cmykComposite";
import type { OmwDocument, Page } from "../core/types";

export const PSD_RECIPE = "psd/1";
/** tiles of colour-managed CMYK documents (portable profile table, 2026-11-17) */
export const PSD_RECIPE_CMS = "psd/2";
/** recipes this app can derive tiles by */
export const PSD_RECIPES = new Set([PSD_RECIPE, PSD_RECIPE_CMS]);

/** A CMYK document the importer shows through a profile (its own or the default). */
function cmykManaged(bytes: Uint8Array): boolean {
  return bytes.length >= 26 && ((bytes[24] << 8) | bytes[25]) === 4 && !!psdCmykProfile(bytes).xf;
}

/** The recipe that derives this PSD's tiles as this app imports it. */
export function recipeFor(bytes: Uint8Array): string {
  return cmykManaged(bytes) ? PSD_RECIPE_CMS : PSD_RECIPE;
}

/** Does deriving this PSD by `recipe` give the tiles importing it gives today? (psd/1 of a colour-managed CMYK: no) */
export function derivesAsImported(recipe: string, bytes: Uint8Array): boolean {
  return !(recipe === PSD_RECIPE && cmykManaged(bytes));
}
export const PSD_MIME = "image/vnd.adobe.photoshop";

/** asset hash → hashes of the tiles decoding that asset gives (filled at import and on open; immutable data) */
const registry = new Map<string, Set<string>>();

/** Remember which tiles `page` (just imported from the PSD with this asset hash) can be derived from. */
export function registerDerived(assetHash: string, pages: Page[]) {
  let s = registry.get(assetHash);
  if (!s) registry.set(assetHash, (s = new Set()));
  // (a layer with a layer mask kept apart: its tiles are not what the recipes derive — stored as pixels)
  for (const p of pages) for (const n of p.nodes) if (n.type === "RASTER" && !n.mask) for (const t of Object.values(n.tiles)) s.add(t.hash);
}

/** Same, from tile hashes already known (an opened file's derived tiles). */
export function registerDerivedHashes(assetHash: string, hashes: Iterable<string>) {
  let s = registry.get(assetHash);
  if (!s) registry.set(assetHash, (s = new Set()));
  for (const h of hashes) s.add(h);
}

/**
 * Decode a PSD as `recipe` does (psd/1: the importer's decoding with CMYK colour-unmanaged; psd/2: the importer's
 * decoding) and return its tiles by hash.
 */
export function derivePsdTiles(bytes: Uint8Array, recipe: string = PSD_RECIPE): Map<string, Uint8ClampedArray> {
  const out = new Map<string, Uint8ClampedArray>();
  const hash = hashBytes(bytes);
  const legacy = !derivesAsImported(recipe, bytes);
  // (masks baked, as every recipe decoded them: a layer whose mask the import keeps apart is stored as pixels instead —
  // registerDerived leaves it out)
  const read = () => importPsdPage(bytes, "derive.psd", "derive", { id: "derive", hash }, { keepMasks: false });
  const r = legacy ? withoutCmykManagement(read) : read();
  // a CMYK file that blends: keep its channels while it is decoded anyway (core/image/cmykComposite.ts) — not for
  // a colour-managed file's tiles decoded the old way, which the channels (keyed by today's tiles) do not match
  if (!legacy) seedCmykStore(hash, bytes, r.page);
  for (const n of r.page.nodes) if (n.type === "RASTER") for (const t of Object.values(n.tiles)) out.set(t.hash, t.data);
  return out;
}

/** Derivable tile hashes for an asset; decodes it once when the registry does not know it yet (journal restore…). */
export function derivableFor(assetHash: string, getBytes: () => Uint8Array | undefined): Set<string> {
  let s = registry.get(assetHash);
  if (!s) {
    s = new Set();
    const b = getBytes();
    if (b)
      try {
        for (const h of derivePsdTiles(b, recipeFor(b)).keys()) s.add(h);
      } catch {
        /* not decodable: nothing derivable */
      }
    registry.set(assetHash, s);
  }
  return s;
}

/**
 * Can tiles of this PSD be re-derived on any engine? Decoding is integer arithmetic except 32-bit float samples
 * (gamma via Math.pow) and Lab colour (powers): those results may differ by one step between JavaScript engines
 * (WebView2 / WebKit), and a tile that does not decode to its hash on the opening machine would be lost. Their tiles
 * are stored as pixels. A colour-managed CMYK document's are portable since its profile table is built from exact
 * operations only (core/image/iccCmyk.ts ppow, integer interpolation; recipe psd/2).
 */
export function derivationPortable(bytes: Uint8Array): boolean {
  if (bytes.length < 26 || bytes[0] !== 0x38 || bytes[1] !== 0x42 || bytes[2] !== 0x50 || bytes[3] !== 0x53) return false;
  const depth = (bytes[22] << 8) | bytes[23], mode = (bytes[24] << 8) | bytes[25];
  return depth !== 32 && mode !== 9;
}

/** PSD assets of a document whose pages came from them (only those are worth deriving from). */
export function psdSources(doc: OmwDocument): string[] {
  const out = new Set<string>();
  for (const p of [...doc.pages, ...doc.masters]) {
    const m = p.source?.psd;
    if (m && doc.assets[m.assetId]?.mime === PSD_MIME && doc.assets[m.assetId].hash === m.hash) out.add(m.hash);
  }
  return [...out];
}

export interface DerivedIndex {
  recipe: string;
  /** asset hash → tile hashes taken from decoding it */
  from: Record<string, string[]>;
}
