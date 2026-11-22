// The UI strings (src/i18n: shell files + parts/<area>) ship as one chunk of their own, `assets/i18n-*.js`, shared by the
// app and the workers — not folded into whichever shared chunk Rollup happens to name (it was `psdScore`).
// docs/design/INSTALLER_SIZE.md §12.
import { describe, expect, it } from "vitest";
import config from "../../vite.config";

const manualChunks = ((typeof config === "function" ? (config as any)({ mode: "production", command: "build" }) : config) as any).build.rollupOptions.output.manualChunks as (id: string) => string | undefined;

describe("i18n chunk", () => {
  it("puts every language file and the i18n module in the i18n chunk", () => {
    for (const id of [
      "C:\\w\\src\\i18n\\index.ts",
      "C:\\w\\src\\i18n\\ko.json",
      "C:\\w\\src\\i18n\\parts\\cadui\\zh.json",
      "/w/src/i18n/parts/slide/en.json",
    ])
      expect(manualChunks(id)).toBe("i18n");
  });
  it("leaves other modules to Rollup", () => {
    for (const id of ["C:\\w\\src\\ui\\cad\\view.ts", "/w/src/core/image/psdScore.ts", "/w/node_modules/zustand/esm/index.mjs"])
      expect(manualChunks(id)).toBeUndefined();
  });
});
