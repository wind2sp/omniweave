// Installer size budget: the frontend files the installer carries (dist/), each compressed on its own with brotli q9 the
// way Tauri bundles them, summed and compared with the baseline recorded in docs/design/INSTALLER_SIZE.md §12.
// Growing past baseline + tolerance fails — raise the baseline only on purpose (--update, reviewed in the diff).
// Also checks the size rules that are easy to break silently (duplicate fonts / CMaps, unpinned model files).
//
//   npm run build && node scripts/size-budget.mjs          check (exit 1 on a breach)
//   node scripts/size-budget.mjs --update                  record the current dist as the new baseline
//   OMW_SIZE_BUDGET=1 npx vitest run tests/size/sizeBudget.test.ts   the same check as a test
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { brotliCompressSync, constants } from "node:zlib";

export const DOC = "docs/design/INSTALLER_SIZE.md";
const MARK = /<!-- size-budget: (\{[^\n]*?\}) -->/;

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Per-file raw and brotli q9 sizes of a build folder, largest compressed first. */
export function measure(dir = "dist") {
  const files = walk(dir).map((p) => {
    const b = readFileSync(p);
    const br = brotliCompressSync(b, { params: { [constants.BROTLI_PARAM_QUALITY]: 9, [constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
    return { path: relative(dir, p).replace(/\\/g, "/"), raw: b.length, br };
  });
  files.sort((a, b) => b.br - a.br);
  return { files, raw: files.reduce((a, f) => a + f.raw, 0), br: files.reduce((a, f) => a + f.br, 0) };
}

/**
 * Size rules (INSTALLER_SIZE.md §12) a build must keep. Returns the violations.
 * `pinned`: model files allowed in models/ocr (from the manifest's bundle).
 */
/** The AI upscale models (public/models/sr, in git; docs/design/IMAGE_UPSCALE.md) — exactly these files. */
export const SR_MODEL_FILES = ["realesr-general-x4v3.lwt", "realesr-general-wdn-x4v3.lwt", "realesr-animevideov3.lwt", "LICENSE"];
/** The person matting model of background removal (public/models/matte, in git; MODNet int8) — exactly these files. */
export const MATTE_MODEL_FILES = ["modnet.lwt", "LICENSE"];

export function ruleViolations(paths, pinned = []) {
  const v = [];
  for (const p of paths) {
    if (/^models\/sr\//.test(p)) {
      if (!SR_MODEL_FILES.includes(p.slice("models/sr/".length))) v.push(`${p}: not one of the AI upscale models`);
      continue;
    }
    if (/^models\/matte\//.test(p)) {
      if (!MATTE_MODEL_FILES.includes(p.slice("models/matte/".length))) v.push(`${p}: not the person matting model`);
      continue;
    }
    if (/\.bcmap$/i.test(p) || /^pdfjs\/cmaps\//.test(p)) v.push(`${p}: loose CMap (they ship as pdfjs/cmaps.pack only)`);
    if (/^fonts\/Pretendard-(Regular|Bold)\.(ttf|otf|woff2?)$/i.test(p)) v.push(`${p}: second copy of a packed font (fonts/*.ttpack serves UI and PDF)`);
    if (/^pdfjs\/standard_fonts\//.test(p) && !/\/(FoxitSymbol\.pfb|FoxitDingbats\.pfb|LICENSE_FOXIT)$/.test(p)) v.push(`${p}: standard font the app never requests (system fonts are used)`);
    if (/^models\//.test(p) && !(/^models\/ocr\//.test(p) && [...pinned, "LICENSE"].includes(p.slice("models/ocr/".length)))) v.push(`${p}: model file not pinned in the OCR manifest`);
    if (/\.(lwt|onnx|pdiparams)$/i.test(p) && !/^(models\/ocr\/|assets\/u2netp-[\w-]+\.lwt$)/.test(p)) v.push(`${p}: model outside its place`);
  }
  return v;
}

/**
 * Files a dist must hold before its size means anything (INSTALLER_SIZE.md §12): what the prebuild step puts in public/
 * (pdf.js CMaps and standard fonts, scripts/copy-pdfjs-assets.mjs; the pinned OCR models, scripts/ocr-models.mjs).
 * A `npx vite build` without prebuild, or a worktree without the model cache, leaves them out and measures 0.5–3.6 MB
 * small, so the budget would pass whatever the code grew (2026-11-16: a week of department QA measured 7.2 MB).
 * Returns the missing paths (empty = measurable). `base.ocr` false (a baseline taken without OCR) skips the models.
 */
export function measureGaps(paths, pinned = [], base = { ocr: true }) {
  const have = new Set(paths);
  const need = ["pdfjs/cmaps.pack", "pdfjs/standard_fonts/FoxitSymbol.pfb", "pdfjs/standard_fonts/FoxitDingbats.pfb", ...SR_MODEL_FILES.map((p) => "models/sr/" + p), ...MATTE_MODEL_FILES.map((p) => "models/matte/" + p)];
  if (base.ocr) need.push(...[...pinned, "LICENSE"].map((p) => "models/ocr/" + p));
  return need.filter((p) => !have.has(p));
}

/** Message for a dist that cannot be measured against the budget. */
export const unmeasurable = (missing) =>
  `cannot measure: dist lacks ${missing.join(", ")} — build with "npm run build" (prebuild copies the pdf.js assets and the OCR models; fill the model cache with "node scripts/ocr-models.mjs --seed <dir>")`;

export function readBaseline(doc = DOC) {
  const m = MARK.exec(readFileSync(doc, "utf8"));
  if (!m) throw new Error(`${doc}: no "<!-- size-budget: {...} -->" line`);
  return JSON.parse(m[1]);
}

export function writeBaseline(b, doc = DOC) {
  const s = readFileSync(doc, "utf8");
  if (!MARK.test(s)) throw new Error(`${doc}: no "<!-- size-budget: {...} -->" line`);
  writeFileSync(doc, s.replace(MARK, `<!-- size-budget: ${JSON.stringify(b)} -->`));
}

/** null = within budget, else the message. */
export function overBudget(br, base) {
  const limit = base.distBrotli + base.tolerance;
  return br > limit ? `dist is ${br} bytes brotli q9 — over the budget ${base.distBrotli} + ${base.tolerance} by ${br - limit} bytes` : null;
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const dir = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) ?? "dist";
  const r = measure(dir);
  let pinned = [];
  try {
    pinned = Object.keys(JSON.parse(readFileSync("tests/fixtures/ocr/models-manifest.json", "utf8")).bundle.files);
  } catch {}
  const viol = ruleViolations(r.files.map((f) => f.path), pinned);
  for (const f of r.files.slice(0, 12)) console.log(`${String(f.br).padStart(10)}  ${String(f.raw).padStart(10)}  ${f.path}`);
  console.log(`${r.files.length} files: ${r.raw} bytes raw, ${r.br} bytes brotli q9`);
  for (const x of viol) console.error("rule: " + x);
  if (process.argv.includes("--update")) {
    const old = readBaseline();
    const ocr = r.files.some((f) => f.path.startsWith("models/ocr/"));
    writeBaseline({ ...old, distBrotli: r.br, files: r.files.length, ocr, date: new Date().toISOString().slice(0, 10) });
    console.log(`baseline: ${old.distBrotli} → ${r.br}`);
    process.exit(viol.length ? 1 : 0);
  }
  const base = readBaseline();
  const gaps = measureGaps(r.files.map((f) => f.path), pinned, base);
  if (gaps.length) {
    console.error(unmeasurable(gaps));
    process.exit(1);
  }
  const over = overBudget(r.br, base);
  if (over) console.error(over);
  else console.log(`within budget: ${r.br} ≤ ${base.distBrotli} + ${base.tolerance}`);
  process.exit(over || viol.length ? 1 : 0);
}
