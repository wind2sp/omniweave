// Installer size budget (docs/design/INSTALLER_SIZE.md §12) and the reproducible OCR model step.
//   Real check of a built dist:  npm run build && OMW_SIZE_BUDGET=1 npx vitest run tests/size/sizeBudget.test.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs build scripts (no types)
import { MATTE_MODEL_FILES, measure, measureGaps, overBudget, readBaseline, ruleViolations, SR_MODEL_FILES, unmeasurable } from "../../scripts/size-budget.mjs";
// @ts-expect-error — plain .mjs build scripts (no types)
import { bundlePins, installModels, seedCache } from "../../scripts/ocr-models.mjs";

const tmp = mkdtempSync(join(tmpdir(), "omw-size-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("size budget", () => {
  it("baseline is recorded in INSTALLER_SIZE.md with a small tolerance", () => {
    const b = readBaseline();
    expect(b.distBrotli).toBeGreaterThan(5_000_000);
    expect(b.tolerance).toBeLessThanOrEqual(64 * 1024);
    expect(overBudget(b.distBrotli + b.tolerance, b)).toBeNull();
    expect(overBudget(b.distBrotli + b.tolerance + 1, b)).toMatch(/over the budget/);
  });

  it("rules: no duplicate fonts or loose CMaps, no unrequested standard fonts, only pinned models", () => {
    const ok = ["index.html", "assets/index-x.js", "assets/u2netp-AbC_1.lwt", "fonts/Pretendard-Regular.ttpack", "fonts/Pretendard-Medium.woff2", "pdfjs/cmaps.pack", "pdfjs/standard_fonts/FoxitSymbol.pfb", "pdfjs/standard_fonts/LICENSE_FOXIT", "models/ocr/ppocr-det.lwt", "models/ocr/LICENSE"];
    expect(ruleViolations(ok, ["ppocr-det.lwt"])).toEqual([]);
    const bad = ["pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap", "fonts/Pretendard-Bold.woff2", "fonts/Pretendard-Regular.ttf", "pdfjs/standard_fonts/LiberationSans-Regular.ttf", "models/ocr/ppocr-rec-ko-f16.lwt", "assets/extra.lwt"];
    expect(ruleViolations(bad, ["ppocr-det.lwt"]).length).toBe(bad.length);
    // the AI upscale models: exactly the three bundled files and their licence
    expect(ruleViolations(SR_MODEL_FILES.map((p) => "models/sr/" + p))).toEqual([]);
    expect(ruleViolations(["models/sr/realesr-general-x4v3.f32.lwt", "models/sr/extra.onnx"]).length).toBe(2);
    // the person matting model (background removal): the int8 file and its licence only
    expect(ruleViolations(MATTE_MODEL_FILES.map((p) => "models/matte/" + p))).toEqual([]);
    expect(ruleViolations(["models/matte/modnet-f32.lwt", "models/matte/birefnet.onnx"]).length).toBe(2);
  });

  // 2026-11-16: department QA built with `npx vite build` (no prebuild) or without the OCR model cache — dists of 7.2 MB
  // against a 10.7 MB baseline passed while the code grew 69 KB. A dist without what prebuild adds is not measured.
  it("a dist without the prebuild assets (pdf.js CMaps / standard fonts, OCR models) cannot be measured", () => {
    const pins = ["ppocr-det.lwt", "ppocr-rec-ko.lwt"];
    const full = ["index.html", "pdfjs/cmaps.pack", "pdfjs/standard_fonts/FoxitSymbol.pfb", "pdfjs/standard_fonts/FoxitDingbats.pfb", "models/ocr/ppocr-det.lwt", "models/ocr/ppocr-rec-ko.lwt", "models/ocr/LICENSE", ...SR_MODEL_FILES.map((p) => "models/sr/" + p), ...MATTE_MODEL_FILES.map((p) => "models/matte/" + p)];
    expect(measureGaps(full, pins)).toEqual([]);
    expect(measureGaps(full.filter((p) => !p.startsWith("models/sr/")), pins)).toEqual(SR_MODEL_FILES.map((p) => "models/sr/" + p));
    const noOcr = full.filter((p) => !p.startsWith("models/ocr/"));
    expect(measureGaps(noOcr, pins)).toEqual(["models/ocr/ppocr-det.lwt", "models/ocr/ppocr-rec-ko.lwt", "models/ocr/LICENSE"]);
    expect(measureGaps(noOcr, pins, { ocr: false })).toEqual([]);
    expect(measureGaps(full.filter((p) => !p.startsWith("pdfjs/")), pins)).toEqual(["pdfjs/cmaps.pack", "pdfjs/standard_fonts/FoxitSymbol.pfb", "pdfjs/standard_fonts/FoxitDingbats.pfb"]);
    expect(unmeasurable(["pdfjs/cmaps.pack"])).toMatch(/^cannot measure: .*pdfjs\/cmaps\.pack.*npm run build/);
    expect(readBaseline().ocr).toBe(true);
  });
  it("measures per-file brotli q9 sizes", () => {
    const d = join(tmp, "dist");
    mkdirSync(join(d, "a"), { recursive: true });
    writeFileSync(join(d, "a", "x.txt"), "hello ".repeat(2000));
    writeFileSync(join(d, "y.bin"), new Uint8Array(1000).map((_, i) => (i * 7919) % 251));
    const r = measure(d);
    expect(r.files.map((f: { path: string }) => f.path).sort()).toEqual(["a/x.txt", "y.bin"]);
    expect(r.raw).toBe(13000);
    expect(r.br).toBeLessThan(r.raw);
  });

  it.runIf(!!process.env.OMW_SIZE_BUDGET)("the built dist stays within the budget and the rules", () => {
    expect(existsSync("dist/index.html")).toBe(true);
    const r = measure("dist");
    const pins = Object.keys(bundlePins().files);
    const paths = r.files.map((f: { path: string }) => f.path);
    const gaps = measureGaps(paths, pins, readBaseline());
    expect(gaps.length ? unmeasurable(gaps) : null).toBeNull();
    expect(ruleViolations(paths, pins)).toEqual([]);
    expect(overBudget(r.br, readBaseline())).toBeNull();
  });
});

// 2026-11-16 size check of integ-0113: what was duplicated or loaded at start-up for nothing, kept that way.
describe("no second copy, nothing loaded early for nothing", () => {
  const src = (p: string) => readFileSync(p, "utf8");
  const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));

  it("the HWP writer (hwp5Write → hwp5Body, hwp5Preview) is imported only on the first HWP save", () => {
    const statics = walk("src").filter((p) => !/hwp5Write\.ts$/.test(p) && /^import [^;]*from "[./]*(io\/formats\/|\.\/)hwp5Write";?\s*$/m.test(src(p)));
    expect(statics).toEqual([]);
    expect(src("src/io/formats/index.ts")).toContain('await import("./hwp5Write")');
  });

  it("one compound-file writer: the encryption's is the formats one", () => {
    expect(src("src/io/crypto/cfbWrite.ts")).toMatch(/from "\.\.\/formats\/cfb"/);
    expect(walk("src").filter((p) => /\bFATSECT = 0xfffffffd\b/.test(src(p))).map((p) => p.replace(/\\/g, "/"))).toEqual(["src/io/formats/cfb.ts"]);
  });
});

describe("OCR models in the build (scripts/ocr-models.mjs)", () => {
  const data = { "m1.lwt": new Uint8Array([1, 2, 3, 4]), "m2.lwt": new Uint8Array([9, 9]) };
  const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
  const pins = { variant: "i8", license: "LICENSE-T.txt", files: Object.fromEntries(Object.entries(data).map(([k, b]) => [k, { bytes: b.length, sha256: sha(b) }])) };

  it("copies exactly the pinned files and the licence, removing anything else", () => {
    const root = join(tmp, "r1"), cache = join(root, "cache"), dest = join(root, "dest");
    mkdirSync(cache, { recursive: true });
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(root, "LICENSE-T.txt"), "Apache");
    for (const [k, b] of Object.entries(data)) writeFileSync(join(cache, k), b);
    writeFileSync(join(dest, "stale-f16.lwt"), "old");
    expect(installModels({ cache, dest, pins, root })).toEqual([]);
    expect(readdirSync(dest).sort()).toEqual(["LICENSE", "m1.lwt", "m2.lwt"]);
    expect(readFileSync(join(dest, "LICENSE"), "utf8")).toBe("Apache");
  });

  it("fails on a missing or altered file and does not leave it in the build", () => {
    const root = join(tmp, "r2"), cache = join(root, "cache"), dest = join(root, "dest");
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(root, "LICENSE-T.txt"), "Apache");
    writeFileSync(join(cache, "m1.lwt"), new Uint8Array([1, 2, 3, 5]));
    const p = installModels({ cache, dest, pins, root });
    expect(p.length).toBe(2);
    expect(p[0]).toMatch(/m1\.lwt: sha256/);
    expect(p[1]).toMatch(/m2\.lwt: missing/);
    expect(readdirSync(dest)).toEqual(["LICENSE"]);
  });

  it("--seed only stores files that match the pins", () => {
    const src = join(tmp, "seed"), cache = join(tmp, "seedcache");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "m1.lwt"), data["m1.lwt"]);
    writeFileSync(join(src, "m2.lwt"), new Uint8Array([9, 8]));
    expect(seedCache(src, cache, pins)).toEqual([expect.stringMatching(/m2\.lwt/)]);
    expect(readdirSync(cache)).toEqual(["m1.lwt"]);
  });

  it("the real pins name the files the app loads, with sizes and sha256", async () => {
    const { OCR_FILES } = await import("../../src/core/image/ocr/models");
    const b = bundlePins();
    for (const f of new Set(Object.values(OCR_FILES))) expect(b.files[f]).toMatchObject({ bytes: expect.any(Number), sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(existsSync(b.license)).toBe(true);
  });
});
