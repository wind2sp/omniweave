import { defineConfig, type Plugin } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import { version as PKG_VERSION } from "./package.json";

/** How src/core/{image,fidelity}/run.ts start their worker (dev server: Vite's own worker handling). */
export const WORKER_CALL = 'new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })';
/** How the image worker starts its OCR recognition workers. */
export const REC_WORKER_CALL = 'new Worker(new URL("./ocr/recWorker.ts", import.meta.url), { type: "module" })';

/**
 * Build the image and fidelity workers inside the app's own Rollup build instead of as separate bundles, so the code
 * they share with the main thread (image pipeline, formats, i18n, zustand, fflate…) lands in shared chunks that ship
 * once. The worker is an emitted ES-module chunk (hashed name, relative URL); module workers import the shared chunks
 * from the same folder, so it works in Tauri, at a site root and under /app/. docs/design/INSTALLER_SIZE.md §9.
 */
export function sharedWorkers(): Plugin {
  return {
    name: "omw-shared-workers",
    apply: "build",
    enforce: "pre",
    transform(code, id) {
      // the OCR recognition workers the image worker starts (src/core/image/ocr/recPool.ts): same treatment
      if (/[\\/]src[\\/]core[\\/]image[\\/]worker\.ts$/.test(id)) {
        if (!code.includes(REC_WORKER_CALL)) this.error(`omw-shared-workers: recognition worker construction not found in ${id}`);
        const ref = this.emitFile({ type: "chunk", id: id.replace(/worker\.ts$/, "ocr/recWorker.ts"), name: "worker-ocr-rec" });
        return code.replace(REC_WORKER_CALL, `new Worker(import.meta.ROLLUP_FILE_URL_${ref}, { type: "module" })`);
      }
      const m = /[\\/]src[\\/]core[\\/](image|fidelity)[\\/]run\.ts$/.exec(id);
      if (!m) return;
      if (!code.includes(WORKER_CALL)) this.error(`omw-shared-workers: worker construction not found in ${id}`);
      const ref = this.emitFile({ type: "chunk", id: id.replace(/run\.ts$/, "worker.ts"), name: `worker-${m[1]}` });
      return code.replace(WORKER_CALL, `new Worker(import.meta.ROLLUP_FILE_URL_${ref}, { type: "module" })`);
    },
  };
}

/** File signatures the desktop app's asset server (Tauri, content sniffing before the file extension) takes for
 *  another type when they appear near the start of a script: the browser then refuses the module (strict MIME). */
// %PDF- is the one seen (2026-11-22). The binary ones are listed too, being cheap and never legitimate in a script head;
// GIF8, RIFF and <svg sit in the first 2 KB of the sniff chunk today and are served as text/javascript (checked in the
// desktop app over WebView2 remote debugging: every dist file's content-type), so they are not traps.
export const SNIFF_TRAPS = ["%PDF-", "%!PS", "PK\u0003\u0004", "\u0089PNG"];

/** Why a built script would be served with the wrong type, or null. */
export function sniffTrap(code: string): string | null {
  const head = code.slice(0, 2048);
  const hit = SNIFF_TRAPS.find((s) => head.includes(s));
  return hit ? `"${hit}" in its first 2 KB` : null;
}

/** Stop the build when a script chunk starts like a PDF (it happened: src/io/formats/sniff.ts, 2026-11-22). */
export function sniffGuard(): Plugin {
  return {
    name: "omw-sniff-guard",
    apply: "build",
    generateBundle(_opts, bundle) {
      for (const [name, out] of Object.entries(bundle)) {
        if (out.type !== "chunk") continue;
        const why = sniffTrap(out.code);
        if (why) this.error(`omw-sniff-guard: ${name} has ${why} — the desktop app would serve it with the wrong MIME type; compare bytes instead of text (the minifier folds String.fromCharCode back into the text)`);
      }
    },
  };
}

/**
 * version.json next to index.html: the app version and the entry script of this build. The web app compares `build`
 * with the entry script it runs and offers a reload when they differ (src/ui/shell/WebUpdate.tsx,
 * docs/RELEASING.md §웹판 업데이트). The desktop app does not read it.
 */
export function webVersion(version: string): Plugin {
  return {
    name: "omw-web-version",
    apply: "build",
    generateBundle(_opts, bundle) {
      const entry = Object.values(bundle).find((o) => o.type === "chunk" && o.isEntry && o.name === "index");
      if (!entry) return;
      const build = entry.fileName.split("/").pop();
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version, build, date: new Date().toISOString() }, null, 2) + "\n" });
    },
  };
}

export default defineConfig({
  // relative asset paths: the same build runs in Tauri, at a site root, or under /app/ (browser demo)
  base: "./",
  plugins: [react(), sharedWorkers(), sniffGuard(), webVersion(PKG_VERSION)],
  clearScreen: false,
  server: { port: 5199, strictPort: true },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2500,
    // UI strings (all languages, src/i18n/**) in one chunk of their own that the app and workers share, instead of inside
    // whichever shared chunk Rollup names (it was psdScore). Each string ships once. docs/design/INSTALLER_SIZE.md §12.
    rollupOptions: { output: { manualChunks: (id: string) => (/[\\/]src[\\/]i18n[\\/]/.test(id) ? "i18n" : undefined) } },
  },
  // heavy crypto (PBKDF2 600k, AES-256 R6) runs slower when every file runs in parallel
  // .claude/worktrees holds other departments' isolated checkouts — never run their tests here
  test: { environment: "node", testTimeout: 90000, exclude: [...configDefaults.exclude, ".claude/**"] },
} as any);
