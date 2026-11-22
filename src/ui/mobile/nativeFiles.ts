// Getting a finished file out of the phone app: the system share sheet, or "save as copy" into a document the user
// picks. On Android a file goes to the app's staging folder first (src-tauri/src/mobile.rs stage_put) as base64
// pieces — the IPC bridge would otherwise send the bytes as a JSON array of numbers, several times the size — and
// Android streams it from there (SharePlugin.kt). In a browser: Web Share, else a download.

import { isTauri, saveFile } from "../../io/platform";

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  const m: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    zip: "application/zip",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    hwpx: "application/hwp+zip",
    omw: "application/x-omniweave",
    svg: "image/svg+xml",
    psd: "image/vnd.adobe.photoshop",
    psb: "image/vnd.adobe.photoshop",
    ai: "application/postscript",
    dxf: "image/vnd.dxf",
    dwg: "image/vnd.dwg",
  };
  return m[ext] ?? "application/octet-stream";
}

/** bytes → base64 without one giant intermediate string per byte */
export function toBase64(bytes: Uint8Array): string {
  let s = "";
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) s += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP) as unknown as number[]);
  return btoa(s);
}

/** 3 MB of bytes per IPC call (a multiple of 3, so the pieces are whole base64 groups) */
export const STAGE_PIECE = 3 * 1024 * 1024;

/** Write `bytes` into the app's staging folder; returns the staged file's path. */
export async function stage(name: string, bytes: Uint8Array): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  let path = "";
  for (let i = 0; i < Math.max(1, bytes.length); i += STAGE_PIECE) {
    path = await invoke<string>("stage_put", { name, data: toBase64(bytes.subarray(i, i + STAGE_PIECE)), first: i === 0 });
  }
  return path;
}

export async function shareFile(name: string, bytes: Uint8Array): Promise<void> {
  const mime = mimeOf(name);
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("share_staged", { path: await stage(name, bytes), mime });
    return;
  }
  const nav = navigator as any;
  const file = new File([bytes as BlobPart], name, { type: mime });
  if (nav.canShare?.({ files: [file] })) return nav.share({ files: [file], title: name });
  await saveFile(name, bytes, [{ name, extensions: [name.split(".").pop() ?? "bin"] }]);
}

/** "Save as copy": the system's save picker, then the bytes into the picked document. Returns false when cancelled. */
export async function saveCopy(name: string, bytes: Uint8Array): Promise<boolean> {
  const ext = name.split(".").pop() ?? "bin";
  const filters = [{ name: ext.toUpperCase(), extensions: [ext] }];
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const uri = await save({ defaultPath: name, filters });
    if (!uri) return false;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("save_staged", { path: await stage(name, bytes), uri });
    return true;
  }
  return (await saveFile(name, bytes, filters)) != null;
}

/** Can the file the document came from be written over (Android: a picked document with write access)? */
export async function canOverwrite(uri: string | null | undefined): Promise<boolean> {
  if (!isTauri || !uri?.startsWith("content://")) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("can_write_uri", { uri });
  } catch {
    return false;
  }
}

/** Save over the original document (only after canOverwrite said yes). */
export async function overwrite(uri: string, name: string, bytes: Uint8Array): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("save_staged", { path: await stage(name, bytes), uri });
}

/** Keep read access to a picked Android document (recent files); quietly false elsewhere. */
export async function persistUri(uri: string | null): Promise<boolean> {
  if (!isTauri || !uri?.startsWith("content://")) return false;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>("persist_uri", { uri });
  } catch {
    return false;
  }
}
