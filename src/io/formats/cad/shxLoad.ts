// Finding the SHX fonts a drawing's text styles name, on this computer only: next to the drawing, in the folders the user
// pointed to (경로 지정), then in an installed AutoCAD's Fonts folder. Files are read, never copied into the repository,
// the app or a document (docs/legal/IP_CHECKLIST.md). What is found is registered with the stroke font
// (strokeFont.ts: "Omni Stroke SHX <main>[+<big>]"); what is not stays Omni Stroke.

import { joinPath, normPath, type CadFileReader } from "./external";
import type { CadDrawing } from "./model";
import { parseShx, shxKeyOf, type ShxFont } from "./shx";
import { registerShxPair, STROKE_SHX } from "./strokeFont";

/** AutoCAD's own Fonts folders tried (newest first); only read when the file is there */
export function autocadFontDirs(): string[] {
  const out: string[] = [];
  for (let y = 2027; y >= 2018; y--)
    for (const root of ["C:/Program Files/Autodesk", "D:/Program Files/Autodesk", "E:/Autodesk", "D:/Autodesk", "C:/Autodesk"]) out.push(`${root}/AutoCAD ${y}/Fonts`);
  return out;
}

/** read file path (lower case) → parsed font, or null when absent / not a shape font: each path is tried once */
const fonts = new Map<string, Promise<ShxFont | null>>();
/** folder where the last AutoCAD font was found (tried first) */
let fontDir: string | null = null;

/**
 * A plain .shx file name, or null: no folder parts, drive, "..", wildcard or control character — a style's font name or
 * a document's family name only ever picks a file inside the folders tried (docs/legal/IP_CHECKLIST.md 13).
 */
export function safeShxName(file: string): string | null {
  const f = file.trim().toLowerCase();
  return /^[a-z0-9@_$~#&() -]{1,64}\.shx$/.test(f) && !f.startsWith(".") ? f : null;
}

function readAt(path: string, file: string, read: CadFileReader): Promise<ShxFont | null> {
  const k = path.toLowerCase();
  let f = fonts.get(k);
  if (!f) {
    f = read(path)
      .catch(() => null)
      .then((bytes) => (bytes ? parseShx(bytes, file) : null))
      .catch(() => null);
    fonts.set(k, f);
  }
  return f;
}

async function readFont(name: string, dirs: string[], read: CadFileReader): Promise<ShxFont | null> {
  const file = safeShxName(name);
  if (!file) return null;
  for (const d of dirs) {
    const found = await readAt(joinPath(d, file), file, read);
    if (found) return found;
  }
  for (const d of fontDir ? [fontDir, ...autocadFontDirs().filter((x) => x !== fontDir)] : autocadFontDirs()) {
    const found = await readAt(joinPath(d, file), file, read);
    if (found) {
      fontDir = d;
      return found;
    }
  }
  return null;
}

/**
 * Load the SHX fonts of the drawing's styles that can be found (drawing folder `dir`, the user's folders `search`, an
 * AutoCAD Fonts folder) and register their pairs. Returns the keys registered.
 */
export async function loadDrawingShx(d: CadDrawing, dir: string, search: string[], read: CadFileReader | null): Promise<string[]> {
  if (!read) return [];
  const dirs = [dir, ...search].filter(Boolean).map(normPath);
  const done: string[] = [];
  const seen = new Set<string>();
  for (const st of d.styles.values()) {
    const key = shxKeyOf(st.font, st.bigFont);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const [m, b] = key.split("+");
    const main = await readFont(m + ".shx", dirs, read);
    const big = b ? await readFont(b + ".shx", dirs, read) : null;
    if (!main && !big) continue;
    registerShxPair(key, { main, big });
    done.push(key);
  }
  return done;
}

/** Load the pairs named by SHX families of an opened document (no drawing folder: the AutoCAD Fonts folder only). */
export async function loadShxFamilies(families: Iterable<string>, read: CadFileReader | null): Promise<void> {
  if (!read) return;
  for (const f of families) {
    if (!f.startsWith(STROKE_SHX)) continue;
    const key = f.slice(STROKE_SHX.length).toLowerCase();
    const [m, b, extra] = key.split("+");
    // (a family name comes from the document: only plain font names, never a path)
    if (extra !== undefined || !safeShxName(m + ".shx") || (b !== undefined && !safeShxName(b + ".shx"))) continue;
    const main = m ? await readFont(m + ".shx", [], read) : null;
    const big = b ? await readFont(b + ".shx", [], read) : null;
    if (main || big) registerShxPair(key, { main, big });
  }
}

/** forget what was read (tests) */
export function resetShxCache() {
  fonts.clear();
  fontDir = null;
}
