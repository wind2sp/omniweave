// File access that works the same in the browser and in the Tauri desktop shell.

import { t } from "../i18n";
import { isIOS } from "../web/device";
import { PHONE_LAYOUT_KEY } from "../web/phone";
// (no static import of the format registry here: the phone app shows its first screen without loading the whole
// engine — formats/index.ts hands its extension list over when it loads, setRegistryExts)
let registryExts: string[] = [];
/** called by io/formats/index.ts with every extension it opens */
export function setRegistryExts(exts: string[]) {
  registryExts = exts;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** OS of the Tauri shell from tauri-plugin-os ("windows", "android", "ios", …), read from the value the plugin
 *  injects before the page loads (what `@tauri-apps/plugin-os` platform() returns, without the extra package);
 *  null in a browser. */
export function osPlatform(): string | null {
  if (typeof window === "undefined") return null;
  const os = (window as any).__TAURI_OS_PLUGIN_INTERNALS__;
  return os && typeof os.platform === "string" ? os.platform : null;
}

/** The Android/iOS app (Tauri mobile): the phone shell (ui/mobile) instead of the desktop editor, no in-app
 *  updater, files through the system picker and share sheet (docs/MOBILE_PLAN.md §3.2). `?mobile` previews the
 *  phone shell in a desktop browser or window (development and screenshots). */
export const isMobile: boolean = (() => {
  if (typeof window === "undefined") return false;
  const os = osPlatform();
  if (os === "android" || os === "ios") return true;
  if (isTauri && typeof navigator !== "undefined" && /Android|iPhone|iPad/i.test(navigator.userAgent)) return true;
  try {
    const q = new URLSearchParams(window.location.search);
    if (q.has("mobile") || q.has("phone")) return true;
    // `?desktop` keeps the desktop editor on any screen
    if (q.has("desktop") || isTauri) return false;
  } catch {
    /* no URL */
  }
  // the visitor's choice for this visit (web/phone.ts switchLayout): "PC 화면으로 보기" = desktop, "휴대폰 화면으로" = phone
  const chosen = layoutChoice();
  if (chosen === "desktop") return false;
  if (chosen === "phone") return true;
  // the web app on a phone (iPhone Safari, Android Chrome, a home-screen app): a narrow touch screen gets the same
  // phone screen as the Android app — tablets and touch laptops keep the desktop editor
  return narrowTouchScreen();
})();

function layoutChoice(): string | null {
  try {
    return sessionStorage.getItem(PHONE_LAYOUT_KEY);
  } catch {
    return null;
  }
}

/** A phone-sized touch screen: primary pointer coarse, the short side under 600 CSS px. A pen or mouse alongside
 *  (Galaxy S Pen, a Bluetooth mouse) does not make it a PC — the same test as index.html and ui/shell/WebNotice.tsx. */
export function narrowTouchScreen(): boolean {
  if (typeof window === "undefined" || typeof matchMedia !== "function") return false;
  try {
    const coarse = matchMedia("(pointer: coarse)").matches;
    const short = Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight);
    return coarse && short > 0 && short < 600;
  } catch {
    return false;
  }
}

/** Tauri on Android/iOS: picked files are content:// (Android) or security-scoped URLs, not paths. */
const nativeMobile = isTauri && isMobile;

/** Name of a picked file; on Android a content:// URI often carries only an id, so the provider is asked. */
async function pickedName(p: string): Promise<string> {
  if (nativeMobile && p.startsWith("content://")) {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const n = await invoke<string | null>("content_name", { uri: p });
      if (n) return n;
    } catch {}
  }
  return displayName(p);
}

/** File name for a picked path or URI. Android's picker returns content://…/document/primary%3ADownload%2Fa.pdf
 *  (the name is the last segment once decoded) or an opaque id (…/document/msf%3A31), which has no name. */
export function displayName(p: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return p.split(/[\\/]/).pop()!;
  let last = p.split("/").pop() ?? p;
  try {
    last = decodeURIComponent(last);
  } catch {}
  return last.split(/[\\/:]/).pop() || "file";
}

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
    return Promise.all(paths.map(async (p) => ({ name: await pickedName(p), path: p, bytes: await readFile(p) })));
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
    // Android/iOS: the picker hands back a document URI the app may write but not rename into: write it directly
    if (nativeMobile) {
      await writeFile(path, data);
      return path;
    }
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
  any: { get name() { return t("engine.filter.any"); }, get extensions() { return registryExts; } },
  images: { get name() { return t("engine.filter.images"); }, extensions: ["png", "jpg", "jpeg", "webp", "gif", "svg"] },
  pdf: { name: "PDF", extensions: ["pdf"] },
  docx: { get name() { return t("engine.filter.docx"); }, extensions: ["docx"] },
  hwpx: { get name() { return t("engine.filter.hwpx"); }, extensions: ["hwpx"] },
  png: { get name() { return t("engine.filter.png"); }, extensions: ["png"] },
  svg: { name: "SVG", extensions: ["svg"] },
};
