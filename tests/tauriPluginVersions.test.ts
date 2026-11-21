// The JS guest bindings of every Tauri plugin must match the Rust plugin's minor version: a 2.0 JS
// @tauri-apps/plugin-updater read `meta.available`, which the 2.14 Rust command no longer sends, so every
// update check said "up to date" (found 2026-11-12 testing 0.1.1 → 0.1.2).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const lock = readFileSync("src-tauri/Cargo.lock", "utf8");
const rustVersion = (name: string) => new RegExp(`name = "${name}"\\r?\\nversion = "([^"]+)"`).exec(lock)?.[1];
const jsVersion = (pkg: string) => JSON.parse(readFileSync(`node_modules/${pkg}/package.json`, "utf8")).version as string;
const minor = (v: string | undefined) => v?.split(".").slice(0, 2).join(".");

describe("Tauri plugin JS ↔ Rust versions", () => {
  for (const p of ["updater", "dialog", "fs", "opener", "process"]) {
    it(`@tauri-apps/plugin-${p} matches tauri-plugin-${p}`, () => {
      const rust = rustVersion(`tauri-plugin-${p}`);
      expect(rust).toBeTruthy();
      expect(minor(jsVersion(`@tauri-apps/plugin-${p}`))).toBe(minor(rust));
    });
  }
});
