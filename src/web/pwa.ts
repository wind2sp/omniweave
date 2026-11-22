// Web app as an installable app (PWA): the offline service worker (sw.js, vite.config.ts webPwa), its update hand-over
// with the "새로 고쳐서 업데이트" pill (ui/shell/WebUpdate.tsx), the install offer (beforeinstallprompt, Android / desktop
// Chrome), files opened with the installed app (manifest file_handlers → launchQueue). Browser only: the desktop
// app (Tauri) never registers a service worker. Update policy: src/web/sw.js and docs/RELEASING.md §웹판 업데이트.

import { useSyncExternalStore } from "react";
import { isTauri } from "../io/platform";
import { isStandalone, phoneZoom } from "./device";

export interface SwEnv {
  tauri: boolean;
  prod: boolean;
  hasSW: boolean;
  secure: boolean;
  /** the build has sw.js (OMW_WEB=1 build: the page links a manifest) */
  webBuild: boolean;
}

/** Register the service worker only in the browser, in a production web build, on https / localhost. */
export function shouldRegisterSW(e: SwEnv): boolean {
  return !e.tauri && e.prod && e.hasSW && e.secure && e.webBuild;
}

function env(): SwEnv {
  return {
    tauri: isTauri,
    prod: !!import.meta.env.PROD,
    hasSW: typeof navigator !== "undefined" && "serviceWorker" in navigator,
    secure: typeof window !== "undefined" && window.isSecureContext,
    webBuild: typeof document !== "undefined" && !!document.querySelector('link[rel="manifest"]'),
  };
}

// ───────── small shared state (React reads it with usePwa) ─────────

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface PwaState {
  /** a new build is installed and waiting for this page to hand over */
  updateReady: boolean;
  /** the browser offers to install the app (Android / desktop Chrome, Edge) */
  canInstall: boolean;
}

let state: PwaState = { updateReady: false, canInstall: false };
const subs = new Set<() => void>();
const setState = (p: Partial<PwaState>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export const usePwa = (): PwaState => useSyncExternalStore(subscribe, () => state, () => state);

let reg: ServiceWorkerRegistration | null = null;
let installEvent: BeforeInstallPromptEvent | null = null;

/** A worker that finished installing while another one controls the page: an update to offer. */
function watch(r: ServiceWorkerRegistration) {
  const mark = () => {
    if (r.waiting && navigator.serviceWorker.controller) setState({ updateReady: true });
  };
  mark();
  r.addEventListener("updatefound", () => {
    const w = r.installing;
    w?.addEventListener("statechange", () => {
      if (w.state === "installed") mark();
    });
  });
}

/** `?sw=off`: support escape hatch — remove the worker and every cache of this app, then load from the network. */
async function switchOff(): Promise<void> {
  const regs = await navigator.serviceWorker.getRegistrations().catch(() => []);
  await Promise.all(regs.map((r) => r.unregister()));
  if ("caches" in window) for (const k of await caches.keys()) if (k.startsWith("omw-")) await caches.delete(k);
}

/** Called once at start-up (main.tsx). */
export function initPwa(): void {
  if (isTauri || typeof window === "undefined") return;
  // the browser's install offer comes once, early: keep it for the "install" button (ui/shell/WebInstall.tsx)
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e as BeforeInstallPromptEvent;
    setState({ canInstall: true });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    setState({ canInstall: false });
  });
  initLaunchQueue();
  // phones show the 1024 px layout scaled down: small overlays (install card, phone notice) are enlarged by this
  const zoom = () => document.documentElement.style.setProperty("--phone-zoom", phoneZoom().toFixed(3));
  zoom();
  window.addEventListener("resize", zoom);
  // an installed app's data (autosave journal, caches) should not be evicted under storage pressure
  if (isStandalone()) void navigator.storage?.persist?.().catch(() => {});

  const e = env();
  if (!e.hasSW || e.tauri) return;
  if (new URLSearchParams(location.search).get("sw") === "off") {
    void switchOff();
    return;
  }
  if (!shouldRegisterSW(e)) return;
  const register = () =>
    navigator.serviceWorker
      .register(new URL("sw.js", location.href).href, { scope: "./", updateViaCache: "none" })
      .then((r) => {
        reg = r;
        watch(r);
      })
      .catch(() => {}); // no offline copy: the app still runs from the network
  // after the page has loaded, so installing the shell does not compete with the first start
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/** Ask the browser to look for a new sw.js now (version.json named another build). */
export function checkForSwUpdate(): void {
  void reg?.update().catch(() => {});
}

/** Whether a service worker serves this page (an update then has to go through it). */
export const swControlled = () => typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;

/**
 * "새로 고쳐서 업데이트": hand over to the new build and reload. With a service worker the new worker must take over
 * first — a plain reload would get the old build from the cache again. Waits up to `maxMs` for the new build to finish
 * installing; reloads in any case (never leaves the page stuck).
 */
export async function applyUpdate(maxMs = 20000): Promise<void> {
  const reload = () => location.reload();
  if (!reg || !swControlled()) return reload();
  const deadline = Date.now() + maxMs;
  if (!reg.waiting) await reg.update().catch(() => {});
  while (!reg.waiting && reg.installing && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
  const w = reg.waiting;
  if (!w) return reload();
  let done = false;
  const go = () => {
    if (!done) (done = true), reload();
  };
  navigator.serviceWorker.addEventListener("controllerchange", go, { once: true });
  w.postMessage({ type: "SKIP_WAITING" });
  setTimeout(go, 4000);
}

/** Show the browser's own install dialog (Android / desktop Chrome). */
export async function promptInstall(): Promise<boolean> {
  const e = installEvent;
  if (!e) return false;
  installEvent = null;
  setState({ canInstall: false });
  await e.prompt();
  return (await e.userChoice).outcome === "accepted";
}

// ───────── files opened with the installed app (manifest file_handlers, desktop Chrome / Edge) ─────────

type Opened = { name: string; path: null; bytes: Uint8Array };
let pending: Opened[] = [];
let opener: ((f: Opened) => Promise<unknown>) | null = null;

function initLaunchQueue() {
  const lq = (window as any).launchQueue;
  if (!lq?.setConsumer) return;
  lq.setConsumer(async (params: { files?: { getFile(): Promise<File> }[] }) => {
    for (const h of params.files ?? []) {
      try {
        const f = await h.getFile();
        const o: Opened = { name: f.name, path: null, bytes: new Uint8Array(await f.arrayBuffer()) };
        if (opener) await opener(o).catch(() => {});
        else pending.push(o);
      } catch {
        /* unreadable file: skip it */
      }
    }
  });
}

/** Open the files the app was launched with (after start-up), and any that arrive later, each in its own tab. */
export async function openLaunchedFiles(open: (f: Opened) => Promise<unknown>): Promise<void> {
  opener = open;
  const files = pending;
  pending = [];
  for (const f of files) await open(f).catch(() => {});
}
