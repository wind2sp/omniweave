#!/usr/bin/env node
// Builds THIRD_PARTY_NOTICES.md — Omniweave's own components, then the licenses of everything it ships.
//
//   node scripts/third-party-notices.mjs          write THIRD_PARTY_NOTICES.md
//   node scripts/third-party-notices.mjs --check  only compare with the existing file (exit 1 if different)
//
// Sources (all offline):
//   • JS production dependencies: package-lock.json (packages not marked dev) + node_modules/<name>/package.json
//   • Rust crates: src-tauri/Cargo.lock; license fields are read from the local cargo registry
//     ($CARGO_HOME/registry/src) when present, otherwise the crate is listed with "not available offline".
//   • Bundled assets: Pretendard font (public/fonts/OFL.txt), pdf.js CMaps and standard fonts (node_modules/pdfjs-dist).
// Licenses are never guessed: a missing field is printed as "UNKNOWN" and reported on stderr.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "THIRD_PARTY_NOTICES.md");
const CHECK = process.argv.includes("--check");
const read = (p) => readFileSync(join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const readIf = (p) => (existsSync(join(ROOT, p)) ? read(p) : null);

const COPYRIGHT = "Copyright (C) 2026 NINEROW partners Co., Ltd. (나인로우파트너스(주)) and Omniweave contributors";

// Licenses that may be combined with and distributed under GPL-3.0-or-later.
const COMPATIBLE = /^(MIT|MIT-0|ISC|BSD-2-Clause|BSD-3-Clause|0BSD|Apache-2\.0|MPL-2\.0|Zlib|Unicode-DFS-2016|Unicode-3\.0|OFL-1\.1|CC0-1\.0|Unlicense|BSL-1\.0|Python-2\.0|BlueOak-1\.0\.0|LGPL-2\.1-or-later|LGPL-3\.0(-or-later)?|GPL-3\.0(-or-later)?|CC-BY-4\.0)$/;
const UNKNOWN = "UNKNOWN";
const NOT_OFFLINE = "not available offline";

/** True when an SPDX expression can be satisfied with GPL-compatible licenses only. */
function compatible(expr) {
  if (!expr || expr === UNKNOWN) return false;
  const e = expr.replace(/[()]/g, " ").trim();
  // "A OR B": one compatible alternative is enough. "A AND B": every part must be compatible.
  return e.split(/\s+OR\s+|\//).some((alt) => alt.split(/\s+AND\s+/).every((id) => COMPATIBLE.test(id.trim().replace(/\s+WITH\s+.*/, ""))));
}

function repoUrl(r) {
  if (!r) return "";
  let u = typeof r === "string" ? r : r.url || "";
  u = u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^git:\/\//, "https://").replace(/^git@github\.com:/, "https://github.com/");
  if (/^[\w.-]+\/[\w.-]+$/.test(u)) u = `https://github.com/${u}`;
  if (/^github:/.test(u)) u = u.replace(/^github:/, "https://github.com/");
  return u;
}

// ───────── JS ─────────
function jsDeps() {
  const lock = JSON.parse(read("package-lock.json"));
  const out = [];
  for (const [path, meta] of Object.entries(lock.packages || {})) {
    if (!path || meta.dev || meta.devOptional || meta.extraneous) continue;
    const name = meta.name || path.slice(path.lastIndexOf("node_modules/") + 13);
    let pkg = {};
    const pj = join(ROOT, path, "package.json");
    if (existsSync(pj)) pkg = JSON.parse(readFileSync(pj, "utf8"));
    let license = pkg.license || meta.license;
    if (!license && Array.isArray(pkg.licenses)) license = pkg.licenses.map((l) => l.type || l).join(" OR ");
    if (license && typeof license === "object") license = license.type;
    out.push({ name, version: meta.version || pkg.version || "", license: license || UNKNOWN, repo: repoUrl(pkg.repository), optional: !!meta.optional });
  }
  const seen = new Set();
  return out
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
    .filter((d) => (seen.has(d.name + "@" + d.version) ? false : seen.add(d.name + "@" + d.version)));
}

// ───────── Rust ─────────
function cargoRegistryDirs() {
  const home = process.env.CARGO_HOME || join(homedir(), ".cargo");
  const src = join(home, "registry", "src");
  if (!existsSync(src)) return [];
  return readdirSync(src).map((d) => join(src, d));
}

function rustDeps() {
  const lock = readIf("src-tauri/Cargo.lock");
  if (!lock) return { crates: [], offline: false };
  const regs = cargoRegistryDirs();
  const crates = [];
  for (const block of lock.split(/\n\[\[package\]\]\n/).slice(1)) {
    const get = (k) => (block.match(new RegExp(`^${k} = "([^"]*)"`, "m")) || [])[1];
    const name = get("name");
    const version = get("version");
    if (!name || !get("source")) continue; // skip the workspace's own crate
    crates.push({ name, version, license: regs.length ? UNKNOWN : NOT_OFFLINE, repo: "" });
  }
  for (const c of crates) {
    for (const r of regs) {
      const toml = join(r, `${c.name}-${c.version}`, "Cargo.toml");
      if (!existsSync(toml)) continue;
      const t = readFileSync(toml, "utf8");
      c.license = (t.match(/^license\s*=\s*"([^"]*)"/m) || [])[1] || (t.match(/^license-file\s*=/m) ? "see license file" : UNKNOWN);
      c.repo = (t.match(/^repository\s*=\s*"([^"]*)"/m) || [])[1] || "";
      break;
    }
  }
  return { crates, offline: regs.length > 0 };
}

// ───────── output ─────────
const cell = (s) => String(s || "").replace(/\|/g, "\\|");
function table(rows) {
  const lines = ["| Package | Version | License | Repository |", "| --- | --- | --- | --- |"];
  for (const r of rows) lines.push(`| ${cell(r.name)} | ${cell(r.version)} | ${cell(r.license)}${compatible(r.license) || r.license === NOT_OFFLINE ? "" : " ⚠"} | ${cell(r.repo)} |`);
  return lines.join("\n");
}
const fence = (text) => "```text\n" + text.trimEnd() + "\n```";

const js = jsDeps();
const rust = rustDeps();
const flagged = [...js, ...rust.crates.filter((c) => c.license !== NOT_OFFLINE)].filter((d) => !compatible(d.license));

const ownEngines = [
  ["Loom engine (content-addressed document core: threads, weave keys)", "src/core/loom.ts, src/core/hash.ts"],
  ["Weave Cache renderer (tile cache keyed by weave keys)", "src/render/weave.ts, src/render/draw.ts"],
  ["Shuttle Journal (crash-safe incremental autosave)", "src/io/journal.ts"],
  ["Work history timeline", "src/core/history.ts"],
  ["PDF Surgeon (incremental PDF/AI editing, parser, writer, filters)", "src/io/pdfsurgeon/"],
  ["PSD Surgeon (PSD reader and range-preserving writer)", "src/io/formats/psd.ts, src/io/formats/psdWrite.ts"],
  ["PDF AES-256 (R6) encryption and decryption", "src/io/crypto/pdfEncrypt.ts, src/io/pdfsurgeon/crypto.ts, src/io/pdfsurgeon/decrypt.ts"],
  ["Office Agile AES-256 encryption (DOCX/XLSX/PPTX), CFB writer, HWPX and .omw encryption", "src/io/crypto/"],
  ["TIFF and PSD decoders", "src/io/formats/tiff.ts, src/io/formats/psd.ts"],
  ["Image tracing (bitmap to vector)", "src/core/image/trace.ts"],
  ["Filter and adjustment engine", "src/core/image/ (filters.ts, adjust.ts, ops.ts, pixels.ts, run.ts, worker.ts)"],
  ["Loom Infer (neural network runner: WebGPU and WebAssembly SIMD kernels, LWT model format)", "src/core/image/infer/, scripts/convert-u2netp.mjs"],
  ["Background removal (image classification, keying, edge refinement, matting, colour decontamination)", "src/core/image/matte/"],
];

const md = [];
md.push("# Third-party notices", "");
md.push("<!-- Generated by scripts/third-party-notices.mjs (npm run notices). Edit the script, not this file. -->", "");
md.push("## Omniweave", "");
md.push(`${COPYRIGHT}`, "");
md.push("Director: 황경진 Kyeongjin Hwang  ", "Contact: wind2sp@9rowpar.com", "");
md.push("Omniweave is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. See [LICENSE](LICENSE).", "");
md.push("The following components were written for Omniweave and are covered by the copyright above and GPL-3.0-or-later:", "");
md.push("| Component | Source |", "| --- | --- |");
for (const [n, s] of ownEngines) md.push(`| ${n} | \`${s}\` |`);
md.push("");
md.push("The Omniweave name and logo are trademarks; the GPL does not grant rights to use them (GPL-3.0 section 7(e)). See [TRADEMARKS.md](TRADEMARKS.md).", "");

md.push("## JavaScript dependencies (production)", "");
md.push(`${js.length} packages from \`package-lock.json\` that are bundled into the app (development-only tools are not distributed and are not listed). Licenses as declared in each package's \`package.json\`. ⚠ marks a license that is unknown or not on this script's GPL-3.0-compatible list and needs review.`, "");
md.push(table(js), "");

md.push("### pdf.js", "");
md.push("`pdfjs-dist` (Mozilla pdf.js) is licensed under the Apache License 2.0, which is compatible with GPL-3.0. Its full license text is in `node_modules/pdfjs-dist/LICENSE` and at https://www.apache.org/licenses/LICENSE-2.0. The app also ships pdf.js CMaps and standard font data (`public/pdfjs/`, copied by `scripts/copy-pdfjs-assets.mjs`), whose licenses follow.", "");
for (const [title, p] of [
  ["pdf.js CMaps (Adobe, BSD-3-Clause)", "node_modules/pdfjs-dist/cmaps/LICENSE"],
  ["pdf.js standard fonts — Foxit (BSD-3-Clause)", "node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT"],
  ["pdf.js standard fonts — Liberation (SIL OFL 1.1)", "node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION"],
]) {
  const t = readIf(p);
  md.push(`#### ${title}`, "", t ? fence(t) : `_(${p} not found — run npm install and regenerate.)_`, "");
}

md.push("## Rust crates (desktop app, `src-tauri/Cargo.lock`)", "");
if (!rust.crates.length) md.push("_Cargo.lock not found._", "");
else {
  md.push(
    rust.offline
      ? `${rust.crates.length} crates. Licenses read from the local cargo registry. Not every crate is compiled on every platform; the lock file lists all targets.`
      : `${rust.crates.length} crates. **License data was not available offline** (no local cargo registry), so only names and versions are listed; licenses are not guessed. Regenerate on a machine that has built the desktop app (\`cargo fetch\`), or use \`cargo about\` / \`cargo license\`, to fill in this column. Not every crate is compiled on every platform; the lock file lists all targets.`,
    "",
  );
  md.push(table(rust.crates), "");
  // reviewed ⚠ entries: why they are acceptable (keep in sync with the table above)
  const REVIEWED = {
    "webpki-root-certs":
      "`webpki-root-certs` (Mozilla's CA certificate list as data) is under CDLA-Permissive-2.0, a permissive data license whose only condition is to keep its text with the data; it places no restriction on the program, so it is compatible with GPL-3.0. It is pulled in by `rustls-platform-verifier` on non-Windows targets only and is not compiled into the Windows build (`cargo tree -i webpki-root-certs --target x86_64-pc-windows-msvc` is empty). License text: https://cdla.dev/permissive-2-0/",
  };
  for (const c of rust.crates) if (REVIEWED[c.name] && !compatible(c.license)) md.push(`> **Review — ${c.name} ${c.version}:** ${REVIEWED[c.name]}`, "");
}

md.push("## Models", "", "### U²-Netp (Apache License 2.0)", "");
md.push(
  "Background removal bundles the weights of **U²-Netp**, the small variant of U²-Net (Xuebin Qin, Zichen Zhang, Chenyang Huang, Masood Dehghan, Osmar R. Zaiane, Martin Jagersand, *U²-Net: Going Deeper with Nested U-Structure for Salient Object Detection*, Pattern Recognition 2020), from https://github.com/xuebinqin/U-2-Net, licensed under the Apache License 2.0. The weights were taken from the `u2netp.onnx` export distributed by rembg (https://github.com/danielgatis/rembg, MIT), which carries the original U²-Netp weights.",
  "",
  "**Changes (Apache-2.0 §4(b)):** converted once by `scripts/convert-u2netp.mjs` into Omniweave's LWT format (`src/assets/models/u2netp.lwt`): graph pruned to the fused output, shape sub-graphs folded, every BatchNormalization folded into the convolution before it, convolution weights normalised per output channel and rounded to IEEE half precision with one single-precision scale per channel (biases kept in single precision); the half-precision mantissas were then rounded to 9 bits (`scripts/requant-lwt.mjs`, docs/design/INSTALLER_SIZE.md §4). No retraining. The network is run by Omniweave's own code (Loom Infer); no ONNX Runtime or other inference library is shipped.",
  "",
);
const u2 = readIf("src/assets/models/LICENSE-U2NET.txt");
md.push(u2 ? fence(u2) : "_src/assets/models/LICENSE-U2NET.txt not found._", "");

md.push("### MODNet (Apache License 2.0)", "");
md.push(
  "Background removal of person photos bundles the weights of **MODNet** (Zhanghan Ke, Jiayu Sun, Kaican Li, Qiong Yan, Rynson W.H. Lau, *MODNet: Real-Time Trimap-Free Portrait Matting via Objective Decomposition*, AAAI 2022), from https://github.com/ZHKKKe/MODNet, whose README states that the code, models and demos of the repository (except the GIF files under doc/gif) are released under the Apache License 2.0. The file used is the official ONNX export `modnet_photographic_portrait_matting.onnx` linked from the repository's onnx/README.md (25,888,640 bytes, SHA-256 `07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9`).",
  "",
  "**Changes (Apache-2.0 §4(b)):** converted once by `scripts/convert-modnet.mjs` into Omniweave's LWT graph format (`models/matte/modnet.lwt`): the ONNX file read as data only; shape sub-graphs folded, the Relu / Clip after a convolution fused into it, the squeeze-and-excitation matrix products turned into 1×1 convolutions; convolution weights stored as 8-bit integers with one single-precision scale per output channel. No retraining. The network is run by Omniweave's own code (Loom Infer); no ONNX Runtime or other inference library is shipped. The license text (the Apache License 2.0, as above for U²-Netp) ships next to the weights (`models/matte/LICENSE`).",
  "",
);

md.push("### PP-OCRv5 text detection and Korean recognition (Apache License 2.0)", "");
md.push(
  "Text recognition (OCR) bundles the weights of **PP-OCRv5_mobile_det** and **korean_PP-OCRv5_mobile_rec** by the PaddlePaddle Authors (PaddleOCR, https://github.com/PaddlePaddle/PaddleOCR), from the official model repositories https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det and https://huggingface.co/PaddlePaddle/korean_PP-OCRv5_mobile_rec (pinned revisions, file sizes and SHA-256 in `tests/fixtures/ocr/models-manifest.json`), licensed under the Apache License 2.0. The character list of the recognizer comes from the same repository.",
  "",
  "**Changes (Apache-2.0 §4(b)):** converted by `scripts/convert-ppocr.mjs` into Omniweave's LWT graph format (`models/ocr/ppocr-det.lwt`, `models/ocr/ppocr-rec-ko.lwt`): training-only parts dropped (auxiliary heads, dropout), BatchNorm and the learnable affine scalars folded into the convolutions, weights quantized to 8-bit integers with one single-precision scale per output channel. No retraining. Only the published data files were read; no PaddlePaddle code is run or shipped — the networks run on Omniweave's own code (Loom Infer). The license text ships next to the weights (`models/ocr/LICENSE`).",
  "",
);
const ppocr = readIf("src/assets/models/LICENSE-PPOCR.txt");
md.push(ppocr ? fence(ppocr) : "_src/assets/models/LICENSE-PPOCR.txt not found._", "");

md.push("### Real-ESRGAN compact super-resolution models (BSD 3-Clause)", "");
md.push(
  "Image upscale (AI) bundles the weights of **realesr-general-x4v3**, **realesr-general-wdn-x4v3** and **realesr-animevideov3** by Xintao Wang et al. (Real-ESRGAN, https://github.com/xinntao/Real-ESRGAN, release v0.2.5.0; file sizes and SHA-256 in `public/models/sr/LICENSE`), licensed under the BSD 3-Clause License.",
  "",
  "**Changes:** converted by `scripts/convert-esrgan.mjs` into Omniweave's LWT graph format (`models/sr/*.lwt`): each convolution fused with its PReLU, the pixel shuffle fused into the last convolution, weights stored as half precision with a 6-bit mantissa (general models) or 8-bit integers with one scale per output channel (animevideov3). No retraining. The PyTorch files were read as data only (no Python, no unpickling of code); no Real-ESRGAN or PyTorch code is run or shipped — the networks run on Omniweave's own code (Loom Infer). The license text ships next to the weights (`models/sr/LICENSE`).",
  "",
);
const esrgan = readIf("public/models/sr/LICENSE");
md.push(esrgan ? fence(esrgan.slice(esrgan.indexOf("BSD 3-Clause License"))) : "_public/models/sr/LICENSE not found._", "");

md.push("## Colour profiles", "", "### FOGRA39 default CMYK profile — FOGRA39L Coated (zlib / CC0)", "");
md.push(
  "CMYK documents without a usable colour profile are shown and separated through a profile embedded in the app (`src/core/image/defaultCmykIcc.ts`, the bytes of `src/assets/icc/fogra39-default.icc`). It is derived from **FOGRA39L_coated.icc** of the OpenICC / colord free profile set (https://github.com/hughsie/colord, `data/profiles/FOGRA39L_coated.iccprofile.xml`; the .icc as distributed by CTAN, https://ctan.org/pkg/colorprofiles), copyright Kai-Uwe Behrmann, Marti Maria, Photogamut, Graeme Gill and ColorSolutions, under the zlib/libpng licence (the profile itself states it is free of known copyright restrictions; colord lists it as CC0-1.0). Characterization data **FOGRA39L by Fogra** (www.fogra.org). It is not an Adobe, ECI or Fogra profile.",
  "",
  "**Altered source version (zlib §2):** unused tags removed, shaper curves resampled, table values rounded to 12 bits, description and copyright tags rewritten to say so (`scripts/make-default-cmyk-icc.mjs`, docs/legal/CMYK_PROFILES.md).",
  "",
);
const icc = readIf("src/assets/icc/LICENSE-FOGRA39L.txt");
md.push(icc ? fence(icc) : "_src/assets/icc/LICENSE-FOGRA39L.txt not found._", "");

md.push("## Fonts", "", "### Pretendard (SIL Open Font License 1.1)", "");
md.push("Used in the app and on the website (`public/fonts/`).", "");
const ofl = readIf("public/fonts/OFL.txt");
md.push(ofl ? fence(ofl) : "_public/fonts/OFL.txt not found._", "");

// ───────── full license texts (each package's own LICENSE / NOTICE files, copyright lines included) ─────────
// The same text shipped by many packages (identical bytes) is printed once with every package that carries it.
// MPL-2.0 code (§3.2): the source of those crates is named with its address.
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;
function licenseFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name) && !/\.(js|ts|json|html)$/i.test(e.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((e) => ({ file: e.name, text: readFileSync(join(dir, e.name), "utf8").replace(/\r\n/g, "\n").trimEnd() }));
}
const texts = new Map(); // text → [package labels]
const missing = [];
const addTexts = (label, dir) => {
  const files = licenseFiles(dir);
  if (!files.length) missing.push(label);
  for (const f of files) texts.set(f.text, [...(texts.get(f.text) ?? []), `${label} (${f.file})`]);
};
const lockJs = JSON.parse(read("package-lock.json")).packages || {};
for (const [path, meta] of Object.entries(lockJs)) {
  if (!path || meta.dev || meta.devOptional || meta.extraneous) continue;
  addTexts(`${meta.name || path.slice(path.lastIndexOf("node_modules/") + 13)} ${meta.version || ""}`.trim(), join(ROOT, path));
}
const regs = cargoRegistryDirs();
for (const c of rust.crates) {
  const dir = regs.map((r) => join(r, `${c.name}-${c.version}`)).find((d) => existsSync(d));
  if (dir) addTexts(`${c.name} ${c.version} (crate)`, dir);
  else missing.push(`${c.name} ${c.version} (crate)`);
}
md.push("## License texts", "");
md.push(
  "The license and notice files of every package listed above, as each package ships them (copyright lines included). A text that several packages ship unchanged is printed once, with all of them.",
  "",
);
const mpl = rust.crates.filter((c) => /MPL-2\.0/.test(c.license));
if (mpl.length) {
  md.push("### Source of MPL-2.0 components", "", "These crates are used unmodified under the Mozilla Public License 2.0; their source code is available at:", "");
  for (const c of mpl) md.push(`- ${c.name} ${c.version}: ${c.repo || `https://crates.io/crates/${c.name}/${c.version}`} (also https://crates.io/crates/${c.name}/${c.version})`);
  md.push("");
}
let n = 0;
for (const [t, who] of [...texts].sort((a, b) => a[1][0].localeCompare(b[1][0]))) {
  md.push(`### Text ${++n}`, "", `Used by: ${who.join(", ")}`, "", fence(t), "");
}
if (missing.length) md.push("### Packages without a license file in their distribution", "", `Their license is the one declared in the tables above: ${missing.join(", ")}.`, "");

const text = md.join("\n").replace(/\n{3,}/g, "\n\n");
if (CHECK) {
  const cur = existsSync(OUT) ? readFileSync(OUT, "utf8").replace(/\r\n/g, "\n") : "";
  if (cur !== text) { console.error("THIRD_PARTY_NOTICES.md is out of date — run: npm run notices"); process.exit(1); }
  console.log("THIRD_PARTY_NOTICES.md is up to date.");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote THIRD_PARTY_NOTICES.md (${js.length} JS packages, ${rust.crates.length} Rust crates${rust.offline ? "" : ", Rust licenses unavailable offline"})`);
}
if (flagged.length) {
  console.error(`\n${flagged.length} package(s) need license review:`);
  for (const f of flagged) console.error(`  ${f.name}@${f.version}: ${f.license}`);
}
