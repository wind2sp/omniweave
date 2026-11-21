// node scripts/make-doc-sample.mjs — builds the Word/한글 feature sample (docs/design/WORD_HWP_FEATURES.md).
//
// The document is made in a real browser engine so text is measured and drawn with the same fonts the app uses:
//   vite dev server (port 5206, in this process) + a middleware (/__docsample/*) + headless Edge/Chrome opening
//   scripts/doc-sample/index.html → scripts/doc-sample/build.ts, which builds the pages with the engine's own APIs
//   and posts back omni-sample.{omw,docx,hwpx,pdf}, page-N.png and roundtrip.json → qa/samples/doc-features/.
// No new packages: vite is already a dev dependency; the browser is the one installed on the PC. No window is shown.
//   --headed   show the browser window instead of running headless

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const store = process.argv.includes("--store");
// --store: the Store-screenshot variant (no internal engine name, no usage numbers; scripts/doc-sample/build.ts STORE)
const OUT = join(ROOT, store ? "qa/samples/store-sample" : "qa/samples/doc-features");
const PORT = 5206;
const headed = process.argv.includes("--headed");

function findBrowser() {
  const c = [
    process.env.FIDELITY_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  return c.find((p) => existsSync(p));
}

const body = (req) =>
  new Promise((res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
  });

mkdirSync(OUT, { recursive: true });
let finish;
let failed = "";
const done = new Promise((res) => (finish = res));
const plugin = {
  name: "omniweave-doc-sample",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://x");
      if (!url.pathname.startsWith("/__docsample/")) return next();
      const what = url.pathname.slice("/__docsample/".length);
      if (what === "save") {
        const name = basename(url.searchParams.get("name") ?? "").replace(/[^\w.-]+/g, "_");
        if (!name) return (res.statusCode = 400), res.end();
        writeFileSync(join(OUT, name), await body(req));
        console.log(`  ${name}`);
        return res.end("ok");
      }
      if (what === "done") {
        failed = (await body(req)).toString("utf8");
        res.end("ok");
        return finish();
      }
      next();
    });
  },
};

spawnSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "inherit", windowsHide: true });
const { createServer } = await import("vite");
const server = await createServer({ server: { port: PORT, strictPort: true, host: "127.0.0.1", open: false, hmr: false, watch: { ignored: ["**/*"] } }, plugins: [plugin], logLevel: "warn", clearScreen: false });
await server.listen();
const exe = findBrowser();
if (!exe) {
  await server.close();
  throw new Error("Edge/Chrome을 찾지 못했습니다 — FIDELITY_BROWSER 환경 변수로 경로를 지정하세요");
}
const profile = join(tmpdir(), `omniweave-docsample-${process.pid}`);
const flags = [...(headed ? [] : ["--headless=new"]), "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1400,1000", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, `http://127.0.0.1:${PORT}/scripts/doc-sample/index.html${store ? "?store=1" : ""}`];
console.log("▶ 견본 만들기: 개발 서버 + 헤드리스 브라우저");
const browser = spawn(exe, flags, { stdio: "ignore", windowsHide: true, detached: false });
const limit = setTimeout(() => {
  failed = "시간 초과(5분)";
  finish();
}, 5 * 60_000);
await done;
clearTimeout(limit);
// stop only the processes this run started: the launcher's tree and the helpers using this run's private profile
if (process.platform === "win32") {
  spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { stdio: "ignore", windowsHide: true });
} else {
  browser.kill("SIGKILL");
  spawnSync("pkill", ["-f", basename(profile)], { stdio: "ignore" });
}
await new Promise((r) => setTimeout(r, 1000));
await server.close();
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {}
if (failed) {
  console.error("견본 만들기 실패:\n" + failed);
  process.exit(1);
}
console.log(`완료 → ${OUT}`);
