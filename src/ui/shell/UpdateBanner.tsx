// Auto-update from GitHub Releases (desktop only) — a quiet pill at the top right of the title bar, no banner.
// A new release is downloaded in the background and checked (the installer by the updater's signature check, the
// portable exe by size + SHA-256 + signature + its own --selftest, src-tauri/src/portable.rs); the pill shows
// "Downloading 37%", then "Restart to update". A click shows what changed and asks (docs/UPDATES.md); "Update now"
// (after a save prompt when documents are unsaved) installs it and relaunches — the installer by a passive NSIS run,
// the portable exe by swapping itself in place (same path and name). An important update (first line of the notes
// "[중요]" / "[important]") asks at once and is shown emphasised. Startup and 6-hourly checks are silent on failure
// (and retried after 30 s and 10 min, so one bad moment, e.g. right after an update restart, does not cost 6 hours);
// Help → Check for updates reports "up to date" and errors in a toast. A portable exe that cannot replace itself
// (no write access to its folder, no portable entry in latest.json, a failed check) offers the download page instead.
// Nothing is kept across launches, so a version that is now running can never be offered again, and a failed
// install is reported once and not retried in this session (the current version keeps running).

import { useEffect, useState } from "react";
import { create } from "zustand";
import { version as PKG_VERSION } from "../../../package.json";
import { useStore } from "../../core/store";
import { t as tr, useT } from "../../i18n";
import { isMobile, isTauri } from "../../io/platform";
import { anyDirty, saveAllDirty } from "../tabs";
import { Modal } from "./Dialogs";
import { Icon } from "./Icons";
import { compareVersions } from "./semver";
import { retryDelay } from "./updateRetry";
import { storePackaged } from "./storeBuild";
import { parseNotes, portableAsset } from "./updateNotes";
import { endRun } from "../../io/journal";

const RELEASES = "https://github.com/wind2sp/omniweave/releases/latest";
const PERIOD_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_MS = 4000;

type Found = { version: string; current: string; notes: string; important: boolean };
export type UpdateState =
  | { kind: "idle" }
  | (Found & { kind: "downloading"; pct: number | null })
  | (Found & { kind: "ready"; portable: boolean; update: { install: () => Promise<void> } })
  | (Found & { kind: "installing" })
  /** portable exe that cannot replace itself: offers the download page (`noWrite`: its folder is read-only) */
  | (Found & { kind: "portable"; reason: "noWrite" | "manual" });

/** Update state (exported so the browser dev build can show each state with a mock). `ask`: the "what changed"
 *  dialog is open; `prompt`: the save-first dialog is open. */
export const useUpdate = create<{ st: UpdateState; prompt: boolean; ask: boolean }>(() => ({ st: { kind: "idle" }, prompt: false, ask: false }));
const setSt = (st: UpdateState) => useUpdate.setState({ st });
// browser dev build: lets QA show each pill state (`__omwUpdate.setState({ st: { kind: "ready", … } })`)
if (import.meta.env.DEV && typeof window !== "undefined") (window as any).__omwUpdate = useUpdate;
const notify = (msg: string) => useStore.getState().notify(msg);

/** a version whose install failed in this session — not downloaded or offered again until the next launch */
let failedVersion: string | null = null;
let checking = false;
/** `--update-test`: check at once and install a found update without a click */
let testMode = false;

/** one line to %TEMP%/omniweave-update.log (desktop only; never fails) */
function log(line: string) {
  void import("@tauri-apps/api/core").then(({ invoke }) => invoke("update_log", { line })).catch(() => {});
}

export { compareVersions };

async function runningVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return PKG_VERSION;
  }
}

/** A downloaded, checked update is waiting: install at once in test mode, ask at once when it is important. */
function offer(found: Found) {
  if (testMode) void installNow();
  else if (found.important) useUpdate.setState({ ask: true });
}

/**
 * Look for a new release and download it in the background. On startup and every 6 hours (`manual` false) it
 * stays silent on errors and when offline; from Help → Check for updates it also says "checking", "up to date",
 * that an update is already on its way, or why the check or the download failed.
 */
export async function checkForUpdates(manual = false): Promise<void> {
  // the phone app is updated by its store (Play), never by this updater
  if (!isTauri || isMobile) return;
  // Microsoft Store build: the Store updates the app (storeBuild.ts) — never ask the release server
  if (await storePackaged()) return;
  const cur = useUpdate.getState().st;
  if (cur.kind === "downloading" || cur.kind === "installing") {
    if (manual) notify(tr("update.busy", { version: cur.version }));
    return;
  }
  if (cur.kind === "ready") {
    if (manual) useUpdate.setState({ ask: true });
    return;
  }
  if (checking) return;
  checking = true;
  if (manual) notify(tr("menu.update.checking"));
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    const current = await runningVersion();
    log(`check${manual ? " (manual)" : ""}: current ${current}, found ${update ? update.version : "none"}`);
    failures = 0;
    // never offer the version that is already running (or an older one)
    if (!update || compareVersions(update.version, current) <= 0) {
      if (manual) notify(tr("menu.update.upToDate"));
      return;
    }
    if (update.version === failedVersion && !manual) return;
    const { important, lines } = parseNotes(update.body);
    const found: Found = { version: update.version, current, notes: lines.join("\n"), important };
    if (important) log(`${update.version} is marked important`);
    const { invoke } = await import("@tauri-apps/api/core");
    if (await invoke<boolean>("is_portable").catch(() => false)) {
      await portableDownload(found, update.rawJson, manual);
      return;
    }
    let total = 0, got = 0;
    setSt({ kind: "downloading", ...found, pct: 0 });
    try {
      // download() verifies the release signature before resolving; install() later uses these bytes
      await update.download((ev: any) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          setSt({ kind: "downloading", ...found, pct: total ? Math.min(100, Math.round((got / total) * 100)) : null });
        }
      });
    } catch (e: any) {
      setSt({ kind: "idle" });
      log(`download failed: ${String(e?.message ?? e)}`);
      if (manual) notify(tr("update.downloadFailed", { message: String(e?.message ?? e) }));
      else console.info("update download skipped:", e);
      return;
    }
    failedVersion = failedVersion === update.version ? null : failedVersion;
    setSt({ kind: "ready", ...found, portable: false, update });
    log(`downloaded ${update.version} (${got} bytes), ready`);
    offer(found);
  } catch (e: any) {
    // offline, private repo, or no release yet — quiet unless asked, and tried again soon (not only in 6 hours)
    const wait = manual ? null : retryDelay(++failures);
    void import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string>("update_diag"))
      .catch(() => "")
      .then((diag) => log(`check failed: ${String(e?.message ?? e)}${diag ? ` [${diag}]` : ""}${wait ? `, retry in ${wait / 1000}s` : ""}`));
    if (manual) notify(tr("menu.update.failed", { message: String(e?.message ?? e) }));
    else console.info("update check skipped:", e);
    if (wait !== null && periodic !== undefined) {
      clearTimeout(retry);
      retry = setTimeout(() => void checkForUpdates(false), wait);
    }
  } finally {
    checking = false;
  }
}

/**
 * Portable exe: download the release's portable exe next to this one (`<name>.new.exe`) and check it on the desktop
 * side (size, SHA-256, signature, --selftest). Without a usable portable entry in latest.json, without write access
 * to the folder or when a check fails, the pill offers the download page instead (nothing is replaced).
 */
async function portableDownload(found: Found, rawJson: unknown, manual: boolean) {
  const asset = portableAsset(rawJson);
  if (!asset) {
    log(`portable: no portable entry in latest.json, offering the download page`);
    setSt({ kind: "portable", ...found, reason: "manual" });
    if (found.important) useUpdate.setState({ ask: true });
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  setSt({ kind: "downloading", ...found, pct: 0 });
  let unlisten: (() => void) | undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    unlisten = await listen<[number, number]>("portable-update-progress", (ev) => {
      const [got, total] = ev.payload;
      const size = total || asset.size;
      setSt({ kind: "downloading", ...found, pct: size ? Math.min(100, Math.round((got / size) * 100)) : null });
    });
  } catch {}
  try {
    await invoke("portable_update_download", { url: asset.url, size: asset.size, sha256: asset.sha256, signature: asset.signature });
  } catch (e: any) {
    unlisten?.();
    const msg = String(e?.message ?? e);
    const noWrite = msg.startsWith("no-write");
    log(`portable download failed: ${msg}`);
    setSt({ kind: "portable", ...found, reason: noWrite ? "noWrite" : "manual" });
    if (manual && !noWrite) notify(tr("update.downloadFailed", { message: msg }));
    if (manual || found.important) useUpdate.setState({ ask: true });
    return;
  }
  unlisten?.();
  failedVersion = failedVersion === found.version ? null : failedVersion;
  // install = start the new exe with --finish-update and close this app (it swaps itself in and starts again)
  setSt({ kind: "ready", ...found, portable: true, update: { install: () => invoke("portable_update_finish") } });
  log(`portable: ${found.version} downloaded and checked, ready`);
  offer(found);
}

let periodic: ReturnType<typeof setInterval> | undefined;
let first: ReturnType<typeof setTimeout> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
/** silent checks that failed in a row (reset by a check that got an answer) */
let failures = 0;
function stopChecks() {
  clearTimeout(first);
  clearTimeout(retry);
  clearInterval(periodic);
  first = periodic = retry = undefined;
}

/** Install the downloaded update and relaunch; on failure say so once and keep the current version. */
async function installNow() {
  const st = useUpdate.getState().st;
  if (st.kind !== "ready") return;
  useUpdate.setState({ prompt: false, ask: false });
  stopChecks(); // nothing of ours keeps running while the installer replaces the exe
  setSt({ kind: "installing", version: st.version, current: st.current, notes: st.notes, important: st.important });
  log(`install ${st.version}${st.portable ? " (portable swap)" : ""}`);
  try {
    // everything was saved before (the update prompt): the installer closing the app is a normal end
    await endRun();
    // Windows installer: starts the passive NSIS installer, which closes this app; portable: the new exe takes over
    await st.update.install();
    if (st.portable) return; // the app is closing; the new exe starts itself
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch (e: any) {
    failedVersion = st.version;
    setSt({ kind: "idle" });
    log(`install failed: ${String(e?.message ?? e)}`);
    notify(tr("update.installFailed", { message: String(e?.message ?? e) }));
  }
}

function openDownloadPage() {
  void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(RELEASES));
}

function onPillClick() {
  const st = useUpdate.getState().st;
  if (st.kind === "portable" || st.kind === "ready") useUpdate.setState({ ask: true });
}

/** "Update now" in the dialog: save first when documents are unsaved */
function acceptUpdate() {
  const st = useUpdate.getState().st;
  useUpdate.setState({ ask: false });
  if (st.kind === "portable") return openDownloadPage();
  if (st.kind !== "ready") return;
  if (anyDirty()) useUpdate.setState({ prompt: true }); // any open document tab
  else void installNow();
}

/** Tooltip: current → new version, then the first lines of the release notes. */
function tipFor(st: Exclude<UpdateState, { kind: "idle" }>): string {
  const head = (st.important ? tr("update.importantTag") + " · " : "") + tr("update.tip", { current: st.current, version: st.version });
  const notes = st.notes.split("\n").filter(Boolean).slice(0, 3).join(" · ");
  return notes ? `${head} — ${notes.length > 160 ? notes.slice(0, 159) + "…" : notes}` : head;
}

/** The pill in the title bar (renders nothing until a release is found). */
export function UpdatePill() {
  const { st, prompt, ask } = useUpdate();
  const t = useT();

  useEffect(() => {
    if (!isTauri || isMobile) return;
    let alive = true;
    // every start is recorded: the first line after an install shows the new version came up (docs/UPDATES.md)
    void runningVersion().then((v) => log(`start ${v}`));
    void storePackaged().then((store) => {
      // Microsoft Store build: no checks at all (the Store installs updates)
      if (!alive || store) return;
      void import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke<boolean>("update_test_mode"))
        .catch(() => false)
        .then((on) => {
          if (!alive) return;
          testMode = on;
          first = setTimeout(() => void checkForUpdates(false), on ? 500 : FIRST_CHECK_MS);
        });
      periodic = setInterval(() => void checkForUpdates(false), PERIOD_MS);
    });
    return () => {
      alive = false;
      stopChecks();
    };
  }, []);

  if (st.kind === "idle") return null;
  const label =
    st.kind === "downloading"
      ? st.pct === null
        ? t("update.downloadingNoPct")
        : t("update.downloading", { pct: st.pct })
      : st.kind === "ready"
        ? t("update.ready")
        : st.kind === "installing"
          ? t("update.installing")
          : t("update.portable");
  const actionable = st.kind === "ready" || st.kind === "portable";
  return (
    <>
      <button
        type="button"
        className={`update-pill is-${st.kind}${st.important ? " is-important" : ""}`}
        data-tip={tipFor(st)}
        aria-disabled={!actionable}
        aria-live="polite"
        onClick={actionable ? onPillClick : undefined}
      >
        {st.kind === "downloading" && <i className="update-pill-bar" style={{ width: `${st.pct ?? 0}%` }} />}
        {st.kind === "installing" && <i className="update-pill-bar indeterminate" />}
        {actionable && <Icon name={st.kind === "ready" ? "rotate" : "export"} size={14} />}
        <span className="update-pill-label">{label}</span>
      </button>
      {ask && (st.kind === "ready" || st.kind === "portable") && <WhatChanged />}
      {prompt && st.kind === "ready" && <SaveFirst />}
    </>
  );
}

/** What changed in the new version, and whether to update now (important updates open this at once). */
function WhatChanged() {
  const t = useT();
  const st = useUpdate((s) => s.st);
  if (st.kind !== "ready" && st.kind !== "portable") return null;
  const later = () => useUpdate.setState({ ask: false });
  const lines = st.notes.split("\n").filter(Boolean);
  return (
    <Modal labelledBy="update-ask-title" className={`modal-sm update-ask${st.important ? " is-important" : ""}`} onClose={later}>
      <h2 id="update-ask-title">
        {t("update.ask.title", { version: st.version })}
        {st.important && <span className="update-ask-badge">{t("update.importantTag")}</span>}
      </h2>
      {st.important && (
        <p className="update-ask-important" role="alert">
          {t("update.ask.important")}
        </p>
      )}
      <p className="modal-sub">{t("update.tip", { current: st.current, version: st.version })}</p>
      {lines.length ? (
        <ul className="update-ask-notes">
          {lines.slice(0, 12).map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      ) : (
        <p className="modal-text">{t("update.ask.noNotes")}</p>
      )}
      <p className="modal-text">
        {st.kind === "ready" ? t("update.ask.restartNote") : t(st.reason === "noWrite" ? "update.ask.noWrite" : "update.ask.manual")}
      </p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" onClick={later}>
          {t("update.ask.later")}
        </button>
        <button type="button" className="btn btn-primary" data-autofocus onClick={acceptUpdate}>
          {st.kind === "ready" ? t("update.ask.now") : t("update.ask.openPage")}
        </button>
      </div>
    </Modal>
  );
}

/** Unsaved documents: save first, install without saving (the recovery journal still has it), or cancel. */
function SaveFirst() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const cancel = () => useUpdate.setState({ prompt: false });
  return (
    <Modal labelledBy="update-save-title" className="modal-sm" onClose={busy ? undefined : cancel}>
      <h2 id="update-save-title">{t("update.save.title")}</h2>
      <p className="modal-text">{t("update.save.text")}</p>
      <div className="modal-actions">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={cancel}>
          {t("update.save.cancel")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void installNow()}>
          {t("update.save.discard")}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          data-autofocus
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await saveAllDirty();
            } catch {}
            setBusy(false);
            if (!anyDirty()) void installNow(); // saved → go on; cancelled save dialog → stay here
          }}
        >
          {t("update.save.save")}
        </button>
      </div>
    </Modal>
  );
}
