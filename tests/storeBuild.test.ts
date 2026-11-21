// Microsoft Store build (packaging/msix): the Store updates the app, so the app's own updater stays off — no check
// on startup or from the menu, no "Check for updates" item. The installer / portable builds keep the updater.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  // the desktop app (src/io/platform.ts isTauri) — set before any module reads it
  (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
  return { packaged: false, checks: 0, asked: [] as string[] };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string) => {
    h.asked.push(cmd);
    if (cmd === "is_store_package") return h.packaged;
    if (cmd === "is_portable") return false;
    return null;
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.2.0" }));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: async () => {
    h.checks++;
    return null;
  },
}));

import { isStorePackaged, resetStorePackaged, storePackaged } from "../src/ui/shell/storeBuild";
import { checkForUpdates } from "../src/ui/shell/UpdateBanner";

afterEach(() => {
  resetStorePackaged();
  h.packaged = false;
  h.checks = 0;
  h.asked = [];
});

describe("Store build: updater off", () => {
  it("asks the desktop side once and remembers the answer", async () => {
    const calls: string[] = [];
    const inv = async <T,>(cmd: string) => (calls.push(cmd), true as T);
    expect(isStorePackaged()).toBe(false);
    expect(await storePackaged(inv)).toBe(true);
    expect(await storePackaged(inv)).toBe(true);
    expect(calls).toEqual(["is_store_package"]);
    expect(isStorePackaged()).toBe(true);
  });

  it("an error or a missing command counts as not packaged (the browser, an older desktop side)", async () => {
    expect(await storePackaged(async () => Promise.reject(new Error("unknown command")))).toBe(false);
    resetStorePackaged();
    expect(await storePackaged(async <T,>() => "yes" as T)).toBe(false);
  });

  it("packaged: neither the silent nor the menu check asks the release server", async () => {
    h.packaged = true;
    await checkForUpdates(false);
    await checkForUpdates(true);
    expect(h.checks).toBe(0);
    expect(h.asked).toEqual(["is_store_package"]);
  });

  it("installer / portable build: the check still runs", async () => {
    await checkForUpdates(true);
    expect(h.checks).toBe(1);
  });

  it("the menu item and the startup timers follow the answer; the desktop side registers the command", () => {
    expect(readFileSync("src/ui/commands.ts", "utf8")).toMatch(/id: "help\.checkUpdates", only: \(\) => isTauri && !isStorePackaged\(\)/);
    const banner = readFileSync("src/ui/shell/UpdateBanner.tsx", "utf8");
    expect(banner).toMatch(/storePackaged\(\)\.then\(\(store\) => \{\s*\/\/[^\n]*\n\s*if \(!alive \|\| store\) return;/);
    const rs = readFileSync("src-tauri/src/lib.rs", "utf8");
    expect(rs).toMatch(/generate_handler!\[[^\]]*\bis_store_package\b/);
    expect(rs).toMatch(/GetCurrentPackageFullName/);
    expect(rs).toMatch(/GetCurrentPackagePath/);
  });
});
