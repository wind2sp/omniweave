// Update flow (docs/UPDATES.md): release notes and the important mark, the portable entry of latest.json, and the
// portable exe's download → check → swap path (the desktop side is mocked; src-tauri/src/portable.rs has its own
// cargo tests and the end-to-end run is recorded in docs/UPDATES.md §5).
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  return {
    portable: true,
    update: null as null | Record<string, unknown>,
    calls: [] as { cmd: string; args?: unknown }[],
    downloadError: null as null | string,
    listeners: new Map<string, (e: { payload: unknown }) => void>(),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "is_store_package") return false;
    if (cmd === "is_portable") return h.portable;
    if (cmd === "portable_update_download") {
      h.listeners.get("portable-update-progress")?.({ payload: [50, 100] });
      if (h.downloadError) throw h.downloadError;
      return null;
    }
    return null;
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, cb: (e: { payload: unknown }) => void) => {
    h.listeners.set(name, cb);
    return () => h.listeners.delete(name);
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.0" }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: async () => h.update }));
vi.mock("../src/io/journal", () => ({ endRun: async () => {} }));
vi.mock("../src/ui/tabs", () => ({ anyDirty: () => false, saveAllDirty: async () => {} }));

import { parseNotes, portableAsset } from "../src/ui/shell/updateNotes";
import { checkForUpdates, useUpdate } from "../src/ui/shell/UpdateBanner";

const SHA = "a".repeat(64);
const raw = (over: Record<string, unknown> = {}) => ({
  version: "0.2.1",
  portable: { "windows-x86_64": { url: "https://github.com/wind2sp/omniweave/releases/download/v0.2.1/Omniweave_0.2.1_x64-portable.exe", size: 1234, sha256: SHA, signature: "c2ln", ...over } },
});

afterEach(() => {
  h.calls = [];
  h.update = null;
  h.portable = true;
  h.downloadError = null;
  useUpdate.setState({ st: { kind: "idle" }, prompt: false, ask: false });
});

describe("release notes", () => {
  it("[중요] / [important] on the first line marks an important update; the mark is not shown", () => {
    expect(parseNotes("[중요] 저장 오류 수정\n- 표 그리기 개선")).toEqual({ important: true, lines: ["저장 오류 수정", "표 그리기 개선"] });
    expect(parseNotes("\r\n  [Important]\r\n## Fixes\r\n* crash on open")).toEqual({ important: true, lines: ["Fixes", "crash on open"] });
    expect(parseNotes("- a\n[중요] not on the first line")).toEqual({ important: false, lines: ["a", "[중요] not on the first line"] });
    expect(parseNotes(undefined)).toEqual({ important: false, lines: [] });
  });
});

describe("portable entry of latest.json", () => {
  it("accepts only a complete entry with an https url, a size and a sha256", () => {
    expect(portableAsset(raw())).toEqual({ url: raw().portable["windows-x86_64"].url, size: 1234, sha256: SHA, signature: "c2ln" });
    expect(portableAsset({ version: "0.2.1" })).toBeNull();
    expect(portableAsset(raw({ url: "file:///C:/x.exe" }))).toBeNull();
    expect(portableAsset(raw({ size: -1 }))).toBeNull();
    expect(portableAsset(raw({ sha256: "xyz" }))).toBeNull();
    expect(portableAsset(raw({ signature: "" }))).toBeNull();
    expect(portableAsset(null)).toBeNull();
  });
});

describe("portable exe update", () => {
  const found = (body = "- 고친 점", rawJson: unknown = raw()) => {
    h.update = { version: "0.2.1", body, rawJson };
  };

  it("downloads and checks through the desktop side, then the swap closes the app (no relaunch from here)", async () => {
    found();
    await checkForUpdates(false);
    const dl = h.calls.find((c) => c.cmd === "portable_update_download");
    expect(dl?.args).toEqual({ url: raw().portable["windows-x86_64"].url, size: 1234, sha256: SHA, signature: "c2ln" });
    const st = useUpdate.getState().st;
    expect(st.kind).toBe("ready");
    if (st.kind !== "ready") return;
    expect(st.portable).toBe(true);
    expect(st.notes).toBe("고친 점");
    expect(useUpdate.getState().ask).toBe(false); // not important: the pill waits for a click
    await st.update.install();
    expect(h.calls.some((c) => c.cmd === "portable_update_finish")).toBe(true);
  });

  it("an important update asks at once", async () => {
    found("[important] security fix");
    await checkForUpdates(false);
    const s = useUpdate.getState();
    expect(s.st.kind === "ready" && s.st.important).toBe(true);
    expect(s.ask).toBe(true);
  });

  it("a read-only folder offers the download page instead (nothing replaced)", async () => {
    found();
    h.downloadError = "no-write";
    await checkForUpdates(false);
    const st = useUpdate.getState().st;
    expect(st.kind === "portable" && st.reason).toBe("noWrite");
  });

  it("a failed check (size, sha256, signature, selftest) or no portable entry also falls back to the page", async () => {
    found();
    h.downloadError = "check failed: sha256 0000, expected aaaa";
    await checkForUpdates(false);
    let st = useUpdate.getState().st;
    expect(st.kind === "portable" && st.reason).toBe("manual");
    useUpdate.setState({ st: { kind: "idle" } });
    found("- x", { version: "0.2.1" });
    await checkForUpdates(false);
    st = useUpdate.getState().st;
    expect(st.kind === "portable" && st.reason).toBe("manual");
    expect(h.calls.some((c) => c.cmd === "portable_update_download")).toBe(true); // only from the first run
  });

  it("the installer build keeps the Tauri updater path", async () => {
    h.portable = false;
    let downloaded = false;
    h.update = { version: "0.2.1", body: "[중요] x", rawJson: raw(), download: async () => void (downloaded = true), install: async () => {} };
    await checkForUpdates(false);
    expect(downloaded).toBe(true);
    const s = useUpdate.getState();
    expect(s.st.kind === "ready" && !s.st.portable && s.st.important).toBe(true);
    expect(s.ask).toBe(true);
    expect(h.calls.some((c) => c.cmd === "portable_update_download")).toBe(false);
  });

  it("the desktop side registers the commands and handles --finish-update before anything else", () => {
    const rs = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(rs).toMatch(/generate_handler!\[[^\]]*portable::portable_update_download, portable::portable_update_finish/);
    const run = rs.slice(rs.indexOf("pub fn run()"));
    expect(run.indexOf("--finish-update")).toBeLessThan(run.indexOf("generate_context!"));
    expect(run.indexOf("--selftest")).toBeLessThan(run.indexOf("tauri::Builder"));
  });

  it("release.yml adds the signed portable entry to latest.json after the exe is uploaded", () => {
    const yml = readFileSync(".github/workflows/release.yml", "utf8");
    const up = yml.indexOf("gh release upload \"${{ github.ref_name }}\" $out");
    const manifest = yml.indexOf("latest.json", up);
    expect(up).toBeGreaterThan(0);
    expect(manifest).toBeGreaterThan(up);
    expect(yml).toMatch(/signer sign/);
    expect(yml).toMatch(/"windows-x86_64"/);
    expect(yml).not.toMatch(/OMW_OCR_MODELS_RELEASE/);
  });
});

describe("Microsoft Store build", () => {
  it("menu and About say the Store updates it, with the Store's name only", () => {
    const cmds = readFileSync("src/ui/commands.ts", "utf8");
    expect(cmds).toMatch(/id: "help\.storeUpdates", only: \(\) => isTauri && isStorePackaged\(\)/);
    expect(readFileSync("src/ui/shell/ShellDialogs.tsx", "utf8")).toMatch(/isStorePackaged\(\) && <p[^>]*>\{t\("about\.storeUpdates"\)\}/);
    for (const lang of ["ko", "en", "zh", "ja"]) {
      const upd = JSON.parse(readFileSync(`src/i18n/parts/update/${lang}.json`, "utf8"));
      const about = JSON.parse(readFileSync(`src/i18n/${lang}.json`, "utf8"));
      for (const s of [upd["update.store"], about["about.storeUpdates"]]) {
        expect(s).toContain("Microsoft Store");
        expect(s).not.toMatch(/™|®|Windows Store/);
      }
      for (const k of ["update.ask.title", "update.ask.important", "update.ask.now", "update.ask.later", "update.ask.noWrite", "update.importantTag"]) expect(upd[k], `${lang} ${k}`).toBeTruthy();
    }
  });
});
