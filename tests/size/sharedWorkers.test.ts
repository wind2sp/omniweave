// The image and fidelity workers are built inside the app's own Rollup build (vite.config.ts sharedWorkers), so the
// code they share with the main thread ships once instead of twice. docs/design/INSTALLER_SIZE.md §9.
import { describe, expect, it } from "vitest";
import { REC_WORKER_CALL, sharedWorkers, WORKER_CALL } from "../../vite.config";

describe("shared worker chunks (build plugin)", () => {
  const plugin = sharedWorkers();
  const emitted: { id: string; name: string }[] = [];
  const ctx = {
    emitFile: (f: { type: string; id: string; name: string }) => (emitted.push({ id: f.id.replace(/\\/g, "/"), name: f.name }), `ref${emitted.length}`),
    error: (m: string) => {
      throw new Error(m);
    },
  };
  const transform = (code: string, id: string) => (plugin.transform as any).call(ctx, code, id);

  it("rewrites the worker construction of both run.ts files to an emitted chunk", () => {
    const src = `x;\n    w = ${WORKER_CALL};\n`;
    const a = transform(src, "C:/repo/src/core/image/run.ts");
    const b = transform(src, "/repo/src/core/fidelity/run.ts");
    expect(a).toBe(`x;\n    w = new Worker(import.meta.ROLLUP_FILE_URL_ref1, { type: "module" });\n`);
    expect(b).toContain("import.meta.ROLLUP_FILE_URL_ref2");
    expect(emitted.map((e) => e.name)).toEqual(["worker-image", "worker-fidelity"]);
    expect(emitted[0].id).toMatch(/\/repo\/src\/core\/image\/worker\.ts$/);
    expect(emitted[1].id).toMatch(/\/repo\/src\/core\/fidelity\/worker\.ts$/);
  });

  it("rewrites the OCR recognition workers the image worker starts", () => {
    const n = emitted.length;
    const out = transform(`p = () => ${REC_WORKER_CALL};`, "C:/repo/src/core/image/worker.ts");
    expect(out).toBe(`p = () => new Worker(import.meta.ROLLUP_FILE_URL_ref${n + 1}, { type: "module" });`);
    expect(emitted[n].name).toBe("worker-ocr-rec");
    expect(emitted[n].id).toMatch(/\/repo\/src\/core\/image\/ocr\/recWorker\.ts$/);
    expect(() => transform("no worker here", "/repo/src/core/image/worker.ts")).toThrow(/recognition worker/);
  });

  it("leaves other modules alone and fails loudly if run.ts stops matching", () => {
    expect(transform(`new Worker(new URL("./worker.ts", import.meta.url))`, "/repo/src/other.ts")).toBeUndefined();
    expect(() => transform("no worker here", "/repo/src/core/image/run.ts")).toThrow(/worker/);
  });

  it("is build-only (the dev server keeps Vite's own worker handling)", () => {
    expect(plugin.apply).toBe("build");
  });
});
