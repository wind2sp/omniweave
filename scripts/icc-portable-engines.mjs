// Recompute the colour-managed CMYK fingerprints (tests/psd/iccPortableProbe.ts, pinned in
// tests/psd/iccPortable.test.ts) in other JavaScript engines and compare them with this Node's: the .omw recipe psd/2
// needs the same bits everywhere (core/image/iccCmyk.ts).
//
//   node scripts/icc-portable-engines.mjs [--node <path to another node.exe>]... [--no-browser]
//
// The probe is bundled with esbuild (vite's), then run here, in each other Node, and in headless Edge / Chrome
// (--headless=new --dump-dom on a local file: no window, no server). Exit code 1 when any engine differs.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const nodes = argv.flatMap((a, i) => (a === "--node" ? [argv[i + 1]] : []));
const PSDS = ["qa/interop/adobe-made/ps_cmyk_8bit.psd", "qa/interop/adobe-made/fidelity/omni-fid-cmyk-mode-multiply.psd"];

const entry = `
import { cmykXform, defaultCmykProfile } from "./src/core/image/iccCmyk";
import { parsePsdLayout } from "./src/io/formats/psd";
import { conversionFingerprint, derivedFingerprint } from "./tests/psd/iccPortableProbe";
const g = globalThis;
const bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const psds = g.__ICC_INPUT.map(bytes);
const r = parsePsdLayout(psds[0]).resItems.find((it) => it.id === 1039);
const out = {
  FOGRA39: conversionFingerprint(cmykXform(defaultCmykProfile().bytes, "FOGRA39")),
  SWOP: conversionFingerprint(cmykXform(psds[0].slice(r.dataStart, r.dataEnd), "SWOP")),
  derived: psds.map(derivedFingerprint),
};
g.__ICC_DONE(JSON.stringify(out));
`;

const dir = mkdtempSync(join(tmpdir(), "omw-icc-"));
try {
  const res = await build({ stdin: { contents: entry, resolveDir: root, loader: "ts" }, bundle: true, format: "iife", platform: "browser", target: "es2022", write: false, logLevel: "error", define: { "import.meta": "__importMeta" }, banner: { js: "var __importMeta = { url: \"file:///\", env: {}, glob: () => ({}) };" } });
  const js = res.outputFiles[0].text;
  const input = JSON.stringify(PSDS.map((f) => readFileSync(join(root, f)).toString("base64")));
  const results = {};

  // Node: this one and the others given
  const nodeJs = join(dir, "probe.cjs");
  writeFileSync(nodeJs, `globalThis.__ICC_INPUT = ${input}; globalThis.__ICC_DONE = (s) => console.log(s);\n${js}`);
  for (const exe of [process.execPath, ...nodes]) {
    const r = spawnSync(exe, [nodeJs], { encoding: "utf8", windowsHide: true, maxBuffer: 1 << 26 });
    const v = spawnSync(exe, ["-p", "process.versions.v8"], { encoding: "utf8", windowsHide: true }).stdout.trim();
    results[`node ${spawnSync(exe, ["-v"], { encoding: "utf8", windowsHide: true }).stdout.trim()} (V8 ${v})`] = r.status === 0 ? r.stdout.trim() : `error: ${r.stderr.slice(0, 400)}`;
  }

  // headless Edge / Chrome
  if (!argv.includes("--no-browser"))
    for (const exe of ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"]) {
      if (!existsSync(exe)) continue;
      const html = join(dir, "probe.html");
      writeFileSync(join(dir, "probe.js"), `window.__ICC_INPUT = ${input}; window.__ICC_DONE = (s) => { const p = document.createElement("pre"); p.id = "icc"; p.textContent = s; document.body.append(p); };\n${js}`);
      writeFileSync(html, `<!doctype html><meta charset="utf-8"><body><script src="probe.js"></script>`);
      const profile = join(dir, "profile-" + Math.random().toString(36).slice(2));
      const r = spawnSync(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, "--allow-file-access-from-files", "--virtual-time-budget=60000", "--dump-dom", pathToFileURL(html).href], { encoding: "utf8", windowsHide: true, timeout: 180_000, maxBuffer: 1 << 26 });
      const m = /<pre id="icc">([^<]*)<\/pre>/.exec(r.stdout ?? "");
      const ua = /Edge/.test(exe) ? "edge" : "chrome";
      results[`${ua} headless`] = m ? m[1].replace(/&quot;/g, '"') : `error: no result (${r.status}) ${(r.stderr ?? "").slice(0, 300)}`;
    }

  const ref = Object.values(results)[0];
  let bad = 0;
  for (const [k, v] of Object.entries(results)) {
    const same = v === ref;
    if (!same) bad++;
    console.log(`${same ? "same" : "DIFF"}  ${k}: ${v}`);
  }
  process.exitCode = bad ? 1 : 0;
} finally {
  // (a browser's helper processes may hold its profile folder for a moment after it exits)
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
