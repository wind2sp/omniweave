// Checks the pinned OCR model files in public/models/ocr so release builds ship them deterministically.
//
// The weights are third-party (PP-OCRv5, Apache-2.0) and stored in git in public/models/ocr (like the upscale models
// in public/models/sr; 4.9 MB). Every build checks them byte for byte against tests/fixtures/ocr/models-manifest.json
// ("bundle": name, size, sha256), and the folder ends up with exactly those files plus the Apache-2.0 licence text —
// a stale fp16 file or an experiment left in public/models/ocr can never slip into an installer. A file that is
// missing or wrong is taken from the local model cache when it has the right one, else the build stops.
//
//   node scripts/ocr-models.mjs                  build (npm run build → prebuild): fail when a file is missing or wrong
//   node scripts/ocr-models.mjs --dev            dev server (predev): same check, but only a warning when missing
//   node scripts/ocr-models.mjs --seed <dir>     check the .lwt files in <dir> against the pins and store them in the cache
//
// Cache (only for re-converted files): $OMW_MODEL_CACHE, else %LOCALAPPDATA%\omniweave\models\ocr (Windows) or
// ~/.cache/omniweave/models/ocr. The converted files come from scripts/convert-ppocr.mjs (int8) run on the pinned
// Hugging Face revisions.
// OMW_OCR_MODELS=none builds without OCR on purpose (the folder is emptied — `git checkout public/models/ocr` brings
// it back; the app then reports the model missing).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST = "tests/fixtures/ocr/models-manifest.json";
export const DEST = "public/models/ocr";

export function modelCache(env = process.env) {
  if (env.OMW_MODEL_CACHE) return resolve(env.OMW_MODEL_CACHE);
  if (process.platform === "win32" && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, "omniweave", "models", "ocr");
  return join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "omniweave", "models", "ocr");
}

export function bundlePins(manifestPath = MANIFEST) {
  const b = JSON.parse(readFileSync(manifestPath, "utf8")).bundle;
  if (!b || !b.files) throw new Error(`${manifestPath}: no "bundle" section`);
  return b;
}

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** null when `path` is exactly the pinned file, else why not. */
export function checkFile(path, pin) {
  if (!existsSync(path)) return "missing";
  const n = statSync(path).size;
  if (n !== pin.bytes) return `${n} bytes, expected ${pin.bytes}`;
  const h = sha256(path);
  return h === pin.sha256 ? null : `sha256 ${h}, expected ${pin.sha256}`;
}

/**
 * Make `dest` hold exactly the pinned files (from `cache`) and LICENSE. Returns the problems (empty = done). Files
 * already correct in `dest` are kept without needing the cache.
 */
export function installModels({ cache, dest = DEST, pins = bundlePins(), root = "." } = {}) {
  const problems = [];
  mkdirSync(dest, { recursive: true });
  const want = new Set([...Object.keys(pins.files), "LICENSE"]);
  for (const f of readdirSync(dest)) if (!want.has(f)) rmSync(join(dest, f), { recursive: true, force: true });
  for (const [name, pin] of Object.entries(pins.files)) {
    const out = join(dest, name);
    if (!checkFile(out, pin)) continue;
    const src = join(cache, name);
    const why = checkFile(src, pin);
    if (why) {
      rmSync(out, { force: true });
      problems.push(`${name}: ${why} in ${cache}`);
      continue;
    }
    copyFileSync(src, out);
  }
  copyFileSync(join(root, pins.license), join(dest, "LICENSE"));
  return problems;
}

/** Check the files of `dir` against the pins and copy the good ones into the cache. */
export function seedCache(dir, cache, pins = bundlePins()) {
  mkdirSync(cache, { recursive: true });
  const out = [];
  for (const [name, pin] of Object.entries(pins.files)) {
    const why = checkFile(join(dir, name), pin);
    if (why) out.push(`${name}: ${why}`);
    else copyFileSync(join(dir, name), join(cache, name));
  }
  return out;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const args = process.argv.slice(2);
  const cache = modelCache();
  const seed = args.indexOf("--seed");
  if (seed >= 0) {
    const bad = seedCache(resolve(args[seed + 1] ?? "."), cache);
    for (const b of bad) console.error("  " + b);
    console.log(bad.length ? `ocr-models: cache NOT complete (${cache})` : `ocr-models: cache ready (${cache})`);
    process.exit(bad.length ? 1 : 0);
  }
  if (process.env.OMW_OCR_MODELS === "none") {
    rmSync(DEST, { recursive: true, force: true });
    console.warn("ocr-models: OMW_OCR_MODELS=none — building WITHOUT text recognition models");
    process.exit(0);
  }
  const problems = installModels({ cache });
  if (!problems.length) console.log(`ocr-models: ${DEST} = pinned ${bundlePins().variant} models + LICENSE`);
  else {
    const msg = [
      "ocr-models: the pinned OCR models are not available:",
      ...problems.map((p) => "  " + p),
      `Restore them from git (git checkout public/models/ocr), or put re-converted files in the cache`,
      `(node scripts/ocr-models.mjs --seed <folder with ppocr-*.lwt>, or set OMW_MODEL_CACHE),`,
      "or build without OCR on purpose with OMW_OCR_MODELS=none.",
    ].join("\n");
    if (args.includes("--dev")) console.warn(msg);
    else {
      console.error(msg);
      process.exit(1);
    }
  }
}
