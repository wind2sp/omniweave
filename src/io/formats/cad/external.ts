// External files a drawing names: external references (XREF, another DWG / DXF drawn as a block) and linked pictures
// (IMAGE → IMAGEDEF path). docs/design/CAD_IMPORT.md §11.
//
// Where a file is looked for (AutoCAD's order, cut to what the user opened): the path as stored (absolute, or relative
// to the drawing that names it), then the bare file name next to that drawing, then in the folders the user pointed
// to with "경로 지정". A path is only read when it lies inside the opened drawing's folder (or a pointed-to folder) —
// opening a drawing never reaches files elsewhere on the disk. An XREF stored as .dwg is also found as a .dxf of the
// same name (a drawing saved both ways), after every .dwg candidate.
//
// Xref drawings are merged into the host drawing as AutoCAD binds them for display: their layers, line types, text
// styles and blocks get the `xref|` prefix (layer 0 and DEFPOINTS stay shared), their model space becomes the xref
// block. Attached xrefs nest; overlaid ones (flag 8) are not carried into a drawing that is itself an xref.

import type { CadRefMeta } from "../../../core/types";
import { mmPerUnit, type CadBlock, type CadDrawing, type CadEntity, type CadGeom, type P2 } from "./model";

export type CadRefKind = CadRefMeta["kind"];

/** One external file of a drawing, as remembered on the page source (re-linking, re-import). */
export type CadRef = CadRefMeta;

/** Reads one candidate path; null when it is not there. */
export type CadFileReader = (path: string) => Promise<Uint8Array | null>;

export interface CadExternalCtx {
  /** folder of the opened drawing ("" = unknown: only `known` and the search folders are tried) */
  dir: string;
  /** folders the user pointed to (경로 지정) */
  search: string[];
  read: CadFileReader | null;
  /** files already in hand by lower-case file name (picked by the user, or kept assets of an earlier import) */
  known?: Map<string, Uint8Array>;
}

const MAX_DEPTH = 4;

/** forward slashes, no trailing slash */
export const normPath = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
export const baseNameOf = (p: string) => normPath(p).split("/").pop() ?? p;
export const dirOf = (p: string) => {
  const n = normPath(p);
  const i = n.lastIndexOf("/");
  return i < 0 ? "" : n.slice(0, i);
};
const isAbs = (p: string) => /^([a-zA-Z]:\/|\/)/.test(normPath(p));

/** `a/b/../c/./d` → `a/c/d` (a drive letter or leading slash is kept) */
export function joinPath(dir: string, rel: string): string {
  const parts = (isAbs(rel) ? normPath(rel) : `${normPath(dir)}/${normPath(rel)}`).split("/");
  const out: string[] = [];
  for (const s of parts) {
    if (s === "." || (s === "" && out.length)) continue;
    if (s === "..") {
      if (out.length > 1 || (out.length === 1 && !/^[a-zA-Z]:$|^$/.test(out[0]))) out.pop();
      continue;
    }
    out.push(s);
  }
  return out.join("/");
}

/** `p` lies in folder `root` or below it (case-insensitive: Windows paths) */
export function isInside(p: string, root: string): boolean {
  if (!root) return false;
  const a = normPath(p).toLowerCase(), r = normPath(root).toLowerCase();
  return a.startsWith(r + "/");
}

/** Paths to try for a stored external path, in order, limited to the allowed folders. */
export function candidatePaths(stored: string, kind: CadRefKind, dir: string, search: string[]): string[] {
  const name = baseNameOf(stored);
  if (!name) return [];
  const roots = [dir, ...search].filter(Boolean);
  const list: string[] = [];
  if (isAbs(stored)) list.push(joinPath("", stored));
  else if (dir) list.push(joinPath(dir, stored));
  for (const r of roots) list.push(joinPath(r, name));
  if (kind === "xref" && /\.dwg$/i.test(name)) for (const p of [...list]) list.push(p.replace(/\.dwg$/i, ".dxf"));
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = p.toLowerCase();
    if (seen.has(k) || !roots.some((r) => isInside(p, r))) return false;
    seen.add(k);
    return true;
  });
}

/** Find an external file: in-hand files first (by name, .dxf twin of a .dwg too), then the candidate paths. */
export async function findExternal(stored: string, kind: CadRefKind, ctx: CadExternalCtx, dir = ctx.dir): Promise<{ bytes: Uint8Array; at: string } | null> {
  const name = baseNameOf(stored).toLowerCase();
  const names = kind === "xref" && name.endsWith(".dwg") ? [name, name.replace(/\.dwg$/, ".dxf")] : [name];
  for (const n of names) {
    const b = ctx.known?.get(n);
    if (b) return { bytes: b, at: n };
  }
  if (!ctx.read) return null;
  for (const p of candidatePaths(stored, kind, dir, ctx.search)) {
    try {
      const b = await ctx.read(p);
      if (b && b.length) return { bytes: b, at: p };
    } catch {
      /* not there: next candidate */
    }
  }
  return null;
}

/** Shown path of a found file: relative to the opened drawing's folder when inside it. */
export const shownPath = (at: string, dir: string) => (dir && isInside(at, dir) ? normPath(at).slice(normPath(dir).length + 1) : at);

// ───────── merging an xref drawing into the host ─────────

const SHARED_LAYERS = new Set(["0", "DEFPOINTS"]);
const SHARED_LTYPES = new Set(["CONTINUOUS", "BYLAYER", "BYBLOCK"]);
const isLayoutBlock = (n: string) => /^\*(MODEL|PAPER)_SPACE/i.test(n);

/**
 * Merge a read xref drawing into `host` as the content of xref block `blk`: prefixed table names, its model space as
 * the block's entities, a unit factor when the two drawings' units differ (AutoCAD scales an xref by INSUNITS).
 */
export function mergeXref(host: CadDrawing, blk: CadBlock, x: CadDrawing) {
  const pre = blk.name + "|";
  const layer = (n: string) => (SHARED_LAYERS.has(n.toUpperCase()) ? n : pre + n);
  const ltype = (n: string) => (SHARED_LTYPES.has(n.toUpperCase()) ? n : pre + n);
  const block = (n: string) => pre + n;
  for (const L of x.layers.values()) {
    const name = layer(L.name);
    if (!host.layers.has(name.toUpperCase())) host.layers.set(name.toUpperCase(), { ...L, name, ltype: ltype(L.ltype), handle: undefined });
  }
  for (const lt of x.ltypes.values()) {
    const name = ltype(lt.name);
    if (!host.ltypes.has(name.toUpperCase())) host.ltypes.set(name.toUpperCase(), { ...lt, name });
  }
  for (const st of x.styles.values()) host.styles.set((pre + st.name).toUpperCase(), { ...st, name: pre + st.name });
  for (const [h, p] of x.imageDefs) host.imageDefs.set(pre + h, p);
  if (x.imageBytes) for (const [h, b] of x.imageBytes) (host.imageBytes ??= new Map()).set(pre + h, b);
  const ent = (e: CadEntity): CadEntity => ({ ...e, layer: layer(e.layer), ltype: ltype(e.ltype), owner: undefined, geom: e.geom && geom(e.geom) });
  const geom = (g: CadGeom): CadGeom => {
    switch (g.k) {
      case "text":
      case "mtext":
        return { ...g, style: pre + g.style };
      case "insert":
        return { ...g, block: block(g.block), attribs: g.attribs.map(ent) };
      case "dimension":
        return { ...g, block: block(g.block) };
      case "image":
        return { ...g, def: pre + g.def };
      default:
        return g;
    }
  };
  for (const b of x.blocks.values()) {
    if (isLayoutBlock(b.name)) continue;
    const name = block(b.name);
    host.blocks.set(name.toUpperCase(), { ...b, name, entities: b.entities.map(ent) });
  }
  const hu = mmPerUnit(host.insunits), xu = mmPerUnit(x.insunits);
  blk.unitScale = host.insunits && x.insunits && Math.abs(hu / xu - 1) > 1e-9 ? xu / hu : undefined;
  blk.entities = x.entities.filter((e) => !e.paper).map(ent);
  blk.loaded = true;
}

/** Parse an xref file (DXF or DWG by content); null when it is neither or cannot be read. */
async function parseDrawing(bytes: Uint8Array): Promise<CadDrawing | null> {
  const { cadKind } = await import("../sniff");
  const kind = cadKind(bytes);
  try {
    if (kind === "dxf") return (await import("../dxf")).readDxf(bytes);
    if (kind === "dwg") return (await import("../dwg/objects")).readDwg(bytes).drawing;
  } catch {
    /* unreadable: reported as not found */
  }
  return null;
}

export interface ResolvedFile {
  ref: CadRef;
  bytes?: Uint8Array;
  /** picture size in pixels (images) */
  size?: P2;
}

/**
 * Load every xref (recursively) and linked picture a drawing names. Xrefs are merged into `d`; pictures come back with
 * their bytes on `d.imageBytes` (def handle → bytes) for the caller to turn into assets (`d.images`). Never throws: what is
 * not found is listed with `found: false`.
 */
export async function resolveExternal(d: CadDrawing, ctx: CadExternalCtx): Promise<ResolvedFile[]> {
  const out: ResolvedFile[] = [];
  const seenFiles = new Set<string>();
  const visit = async (dr: CadDrawing, dir: string, depth: number, prefix: string) => {
    for (const blk of [...dr.blocks.values()]) {
      if (!(blk.flags & 4) || blk.loaded) continue;
      if (depth > 0 && blk.flags & 8) continue; // overlays are not carried along
      const stored = blk.xref || blk.name + ".dwg";
      const found = depth < MAX_DEPTH ? await findExternal(stored, "xref", ctx, dir) : null;
      const x = found && !seenFiles.has(found.at.toLowerCase()) ? await parseDrawing(found.bytes) : null;
      const ref: CadRef = { kind: "xref", name: prefix + blk.name, path: stored, found: !!x };
      if (found && x) {
        seenFiles.add(found.at.toLowerCase());
        ref.at = shownPath(found.at, ctx.dir);
        // nested xrefs are looked for next to the xref file itself
        await visit(x, found.at.includes("/") ? dirOf(found.at) : dir, depth + 1, prefix + blk.name + "|");
        await visitImages(x, found.at.includes("/") ? dirOf(found.at) : dir, prefix + blk.name + "|");
        mergeXref(dr, blk, x);
      }
      out.push({ ref, bytes: found && x ? found.bytes : undefined });
    }
  };
  const visitImages = async (dr: CadDrawing, dir: string, prefix: string) => {
    for (const [h, stored] of dr.imageDefs) {
      if (!stored) continue;
      const found = await findExternal(stored, "image", ctx, dir);
      const ref: CadRef = { kind: "image", name: prefix + baseNameOf(stored), path: stored, found: !!found };
      if (found) ref.at = shownPath(found.at, ctx.dir);
      out.push({ ref, bytes: found?.bytes });
      // remembered on the drawing by def handle; the caller turns the bytes into an asset
      if (found) (dr.imageBytes ??= new Map()).set(h, found.bytes);
    }
  };
  await visit(d, ctx.dir, 0, "");
  await visitImages(d, ctx.dir, "");
  return out;
}

// ───────── where files are read from ─────────

let override: CadFileReader | null = null;
const searchDirs: string[] = [];

/** Replace the file reader (tests, the fidelity harness); null = the desktop reader again. */
export function setCadFileReader(r: CadFileReader | null) {
  override = r;
}

/**
 * The reader for paths next to an opened drawing: the desktop app reads them (only the candidate paths above, all
 * inside the drawing's folder or a folder the user pointed to); the browser has no file paths, so none.
 */
export function cadFileReader(): CadFileReader | null {
  if (override) return override;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  return async (p) => {
    const { readFile } = await import("@tauri-apps/plugin-fs");
    try {
      return await readFile(p);
    } catch {
      return null;
    }
  };
}

/** Folders the user pointed to with 경로 지정 (this session). */
export const cadSearchDirs = () => [...searchDirs];
export function addCadSearchDir(dir: string) {
  const n = normPath(dir);
  if (n && !searchDirs.some((x) => x.toLowerCase() === n.toLowerCase())) searchDirs.push(n);
}
