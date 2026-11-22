// File access that works the same in the browser and in the Tauri desktop shell.

import { t } from "../i18n";
import { ALL_EXTS } from "./formats";
import { isIOS } from "../web/device";

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface OpenedFile {
  name: string;
  path: string | null;
  bytes: Uint8Array;
}

export interface Filter {
  name: string;
  extensions: string[];
}

export async function openFiles(filters: Filter[], multiple = false): Promise<OpenedFile[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const sel = await open({ multiple, filters });
    if (!sel) return [];
    const paths = Array.isArray(sel) ? sel : [sel];
    return Promise.all(paths.map(async (p) => ({ name: p.split(/[\\/]/).pop()!, path: p, bytes: await readFile(p) })));
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = multiple;
    // iPhone / iPad: Safari turns `accept` into file types it knows and greys out the rest (.omw, .hwpx, .hwp, .psd
    // ...), so there every file can be picked; the format registry rejects what it cannot open
    if (!isIOS()) input.accept = filters.flatMap((f) => f.extensions.map((e) => "." + e)).join(",");
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** Returns the saved path (desktop) or the file name (browser), or null when cancelled. */
export async function saveFile(suggested: string, bytes: Uint8Array | string, filters: Filter[], existingPath?: string | null): Promise<string | null> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeFile, rename } = await import("@tauri-apps/plugin-fs");
    const path = existingPath ?? (await save({ defaultPath: suggested, filters }));
    if (!path) return null;
    // atomic save: write a sibling temp file, then rename over the target
    const tmp = path + ".omw-tmp";
    await writeFile(tmp, data);
    await rename(tmp, path);
    return path;
  }
  const w = window as any;
  if (w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({
        suggestedName: suggested,
        types: filters.map((f) => ({ description: f.name, accept: { "application/octet-stream": f.extensions.map((e) => "." + e) } })),
      });
      const ws = await handle.createWritable();
      await ws.write(data);
      await ws.close();
      return handle.name;
    } catch (e: any) {
      if (e?.name === "AbortError") return null;
    }
  }
  // iPhone / iPad: the share sheet ("Save to Files", AirDrop, mail ...) — a download from a home-screen app has no
  // place to go. Needs a recent tap: when Safari refuses (NotAllowedError) the plain download below is used.
  if (isIOS()) {
    const shared = await shareFile(suggested, data);
    if (shared !== "unsupported") return shared === "shared" ? suggested : null;
  }
  const url = URL.createObjectURL(new Blob([data as BlobPart]));
  const a = document.createElement("a");
  a.href = url;
  a.download = suggested;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return suggested;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

/** Media type for a file name (the share sheet offers apps by it); octet-stream for the rest. */
export function mimeFor(name: string): string {
  return MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}

/** Hand a file to the system share sheet (Web Share with files). */
export async function shareFile(name: string, data: Uint8Array, nav: any = typeof navigator === "undefined" ? undefined : navigator): Promise<"shared" | "cancelled" | "unsupported"> {
  if (!nav?.share || typeof nav.canShare !== "function" || typeof File === "undefined") return "unsupported";
  const file = new File([data as BlobPart], name, { type: mimeFor(name) });
  if (!nav.canShare({ files: [file] })) return "unsupported";
  try {
    await nav.share({ files: [file] });
    return "shared";
  } catch (e: any) {
    return e?.name === "AbortError" ? "cancelled" : "unsupported";
  }
}

/** File-dialog filters; names are getters so they follow the UI language when a dialog opens. */
export const FILTERS = {
  omw: { get name() { return t("engine.filter.omw"); }, extensions: ["omw"] },
  /** every extension in the format registry (src/io/formats/index.ts) */
  any: { get name() { return t("engine.filter.any"); }, extensions: ALL_EXTS },
  images: { get name() { return t("engine.filter.images"); }, extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
  pdf: { name: "PDF", extensions: ["pdf"] },
  docx: { get name() { return t("engine.filter.docx"); }, extensions: ["docx"] },
  hwpx: { get name() { return t("engine.filter.hwpx"); }, extensions: ["hwpx"] },
  png: { get name() { return t("engine.filter.png"); }, extensions: ["png"] },
  svg: { name: "SVG", extensions: ["svg"] },
};
