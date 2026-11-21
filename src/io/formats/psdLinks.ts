// Linked smart objects of an opened PSD: is each linked file there? Looked for as Photoshop does — the stored relative
// path next to the document, then the bare file name there — but only inside the document's folder (opening a file
// never reaches elsewhere on the disk; the same path rule as a drawing's external files, cad/external.ts).
// Only whether the file is there is asked (its size, not its bytes: a linked file can be gigabytes), and never of a
// device name (CON, NUL, COM1 …) or a name with a drive / stream colon.
// The layer keeps showing the pixels Photoshop stored either way; what changes is what the person is told.

import type { Page, RasterNode } from "../../core/types";
import { t } from "../../i18n";
import { baseNameOf, candidatePaths, cadFileReader, dirOf, shownPath } from "./cad/external";

export interface PsdLinkCheck {
  warnings: string[];
  info: string[];
}

/** Is a file at this path? (true, or its bytes for a reader that has them; null / false / empty: not there) */
export type PsdLinkProbe = (path: string) => Promise<boolean | Uint8Array | null>;

/** A file name that is safe to look up: not a Windows device, no colon (drive or alternate stream), no control code. */
export function safeLinkName(name: string): boolean {
  if (!name || name === "." || name === ".." || /[:\0-\x1f]/.test(name)) return false;
  return !/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\.|$)/i.test(name.trim());
}

/**
 * The desktop probe: the file's metadata only (a regular, non-empty file), never its content. Tests and the harness
 * that set a CAD reader (cad/external.ts setCadFileReader) get that one; the browser has no file paths, so none.
 */
export function psdLinkProbe(): PsdLinkProbe | null {
  const cad = cadFileReader();
  if (!cad) return null;
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return cad;
  return async (p) => {
    const { stat } = await import("@tauri-apps/plugin-fs");
    try {
      const s = await stat(p);
      return s.isFile && s.size > 0;
    } catch {
      return false;
    }
  };
}

/**
 * Look for each linked file (`linked` from importPsdPage) next to the document at `docPath` and mark the nodes
 * (psdSmart.found). Found: information; missing, or not looked for (no folder / no file access): a notice naming
 * the path, as Photoshop's 'linked file missing' does.
 */
export async function checkPsdLinks(page: Page, linked: { node: string; layer: string; path: string; name: string }[], docPath: string | null, probe: PsdLinkProbe | null = psdLinkProbe()): Promise<PsdLinkCheck> {
  const out: PsdLinkCheck = { warnings: [], info: [] };
  const dir = docPath ? dirOf(docPath) : "";
  const found: string[] = [], missing: string[] = [], unknown: string[] = [];
  for (const k of linked) {
    const n = page.nodes.find((x) => x.id === k.node) as RasterNode | undefined;
    const label = `'${k.layer}' → ${k.path}`;
    if (!dir || !probe) {
      unknown.push(label);
      continue;
    }
    let at: string | null = null;
    // the stored relative path first, then the file's own name in the document's folder (inside it only)
    const tries = [...candidatePaths(k.path, "image", dir, []), ...(k.name && baseNameOf(k.name) !== baseNameOf(k.path) ? candidatePaths(k.name, "image", dir, []) : [])].filter((p) => safeLinkName(baseNameOf(p)));
    for (const p of tries) {
      try {
        const r = await probe(p);
        if (r === true || (r instanceof Uint8Array && r.length)) {
          at = p;
          break;
        }
      } catch {
        /* next */
      }
    }
    if (n?.psdSmart) n.psdSmart = { ...n.psdSmart, found: !!at };
    if (at) found.push(`'${k.layer}' → ${shownPath(at, dir)}`);
    else missing.push(label);
  }
  const list = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? t("engine.psdsmart.more", { n: xs.length - 3 }) : "");
  if (missing.length) out.warnings.push(t("engine.psdsmart.linkMissing", { list: list(missing) }));
  if (unknown.length) out.warnings.push(t("engine.psdsmart.linkUnknown", { list: list(unknown) }));
  if (found.length) out.info.push(t("engine.psdsmart.linkFound", { n: found.length, list: list(found) }));
  return out;
}
