// Word fidelity score (docs/design/FIDELITY_DOCX.md): every DOCX next to the PDF Word printed of it, opened in
// Omniweave in a headless browser (tests/fidelity/docx.ts) and compared line by line with Word's PDF.
//
//   node scripts/fidelity-docx.mjs [--label after] [--out <dir>] [--corpus <dir>] [--only <regex>] [--port n] [--headed] [--doc]
//
// Inputs: qa/interop/word-made/*.docx with <name>.pdf (make them with qa/interop/scripts/word_make_fidelity.ps1),
// plus --corpus <dir>: local files (DOCX + Word PDF) that are only ever named "corpus #n" in the output.
// --doc: Word 97-2003 files instead (qa/interop/**/*.doc and the corpus's .doc, each with "<file>.ref.pdf" or
// "<name>.pdf" — Word's PDF of the .doc), opened by the DOC reader (io/formats/docRich.ts) and measured the same way.
// Output: <out>/docx-<label>.json, <out>/docx-<label>.md (score table) and <out>/pics/<label>/*.png (Word | Omniweave).
// <out> defaults to node_modules/.cache/omniweave-fidelity-docx (outside the repository).
// No new packages: vite is a dev dependency and the browser is the one installed on the PC.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const LABEL = opt("--label", "now");
const OUT = resolve(opt("--out", join(ROOT, "node_modules/.cache/omniweave-fidelity-docx")));
const CORPUS = opt("--corpus", null);
const PORT = Number(opt("--port", 5207));
const ONLY = opt("--only", null) ? new RegExp(opt("--only")) : null;

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const items = [];
const files = new Map();
const add = (path, tag) => {
  // Word's PDF: "<name>.pdf" (word-made) or "<name>.docx.ref.pdf" (corpus, qa/interop/scripts/corpus_ref_pdf.ps1 — the
  // name every other measurement skips as a reference, so the corpus numbering does not change)
  const pdf = [path.replace(/\.docx?$/i, ".pdf"), path + ".ref.pdf"].find((p) => existsSync(p));
  if (!pdf || (ONLY && !ONLY.test(tag))) return;
  const key = `k${items.length}${/\.doc$/i.test(path) ? ".doc" : ".docx"}`;
  files.set(key, path);
  files.set(key.replace(/\.docx?$/, ".pdf"), pdf);
  items.push({ key, tag });
};
const WM = join(ROOT, "qa/interop/word-made");
if (argv.includes("--doc")) {
  walk(join(ROOT, "qa/interop")).filter((p) => /\.doc$/i.test(p)).sort().forEach((p) => add(p, basename(p).replace(/\.doc$/i, "")));
  if (CORPUS) walk(CORPUS).filter((p) => /\.doc$/i.test(p)).sort().forEach((p, i) => add(p, `corpus-${i + 1}`));
} else {
  for (const n of readdirSync(WM).sort()) if (/^omni-.*\.docx$/i.test(n)) add(join(WM, n), n.replace(/\.docx$/i, ""));
  if (CORPUS) walk(CORPUS).filter((p) => /\.docx$/i.test(p)).sort().forEach((p, i) => add(p, `corpus-${i + 1}`));
}

const picDir = join(OUT, "pics", LABEL);
rmSync(picDir, { recursive: true, force: true });
mkdirSync(picDir, { recursive: true });
const rows = [];
let finish;
const done = new Promise((r) => (finish = r));
const body = (req) => new Promise((res) => {
  const c = [];
  req.on("data", (x) => c.push(x));
  req.on("end", () => res(Buffer.concat(c)));
});
const plugin = {
  name: "omniweave-fidelity-docx",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://x");
      if (!url.pathname.startsWith("/__docx/")) return next();
      const what = url.pathname.slice(8);
      if (what === "list") return res.end(JSON.stringify(items));
      if (what === "file") {
        const p = files.get(url.searchParams.get("key"));
        if (!p) return (res.statusCode = 404), res.end();
        return res.end(readFileSync(p));
      }
      if (what === "pic") {
        const name = url.searchParams.get("name").replace(/[^\w.-]+/g, "_");
        writeFileSync(join(picDir, name), await body(req));
        return res.end(join(picDir, name));
      }
      if (what === "row") {
        const row = JSON.parse((await body(req)).toString("utf8"));
        rows.push(row);
        process.stdout.write(`${row.key}: ${row.breakAgree}/${row.breakTotal} 쪽 ${row.pagesWord}/${row.pagesOmni}${row.error ? " " + row.error : ""}\n`);
        return res.end("ok");
      }
      if (what === "done") {
        const msg = (await body(req)).toString("utf8");
        if (msg) console.error("브라우저 오류:", msg);
        res.end("ok");
        return finish();
      }
      next();
    });
  },
};

function findBrowser() {
  const c = [process.env.FIDELITY_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"];
  return c.find((p) => p && existsSync(p));
}

spawnSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "inherit", windowsHide: true });
const { createServer } = await import("vite");
const server = await createServer({ server: { port: PORT, strictPort: true, host: "127.0.0.1", open: false, hmr: false, watch: { ignored: ["**/*"] } }, plugins: [plugin], logLevel: "warn", clearScreen: false });
await server.listen();
const exe = findBrowser();
if (!exe) throw new Error("Edge/Chrome을 찾지 못했습니다 — FIDELITY_BROWSER로 경로를 지정하세요");
const profile = join(tmpdir(), `omniweave-fid-docx-${process.pid}`);
const flags = [...(argv.includes("--headed") ? [] : ["--headless=new"]), "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1400,1000", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, `http://127.0.0.1:${PORT}/qa/fidelity/docx.html`];
const browser = spawn(exe, flags, { stdio: "ignore", windowsHide: true });
const limit = setTimeout(() => finish(), 20 * 60_000);
await done;
clearTimeout(limit);
if (process.platform === "win32") {
  spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { stdio: "ignore", windowsHide: true });
} else browser.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 800));
await server.close();
try {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
} catch {}

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const f = (x) => (x == null || Number.isNaN(x) ? "-" : x.toFixed(2));
const md = [
  `| 문서 | 쪽 통과 | 줄 나눔 일치 | 쪽 수 Word/오메 | 줄 수 Word/오메 | 글상자 쪼개짐 | 글자 덮임 | 같은 쪽 줄 | 줄 시작 |Δx| 평균 pt | |Δy| 평균/중앙 pt | 줄 너비 차 pt (줄 수) | SSIM(쪽별) |`,
  `|---|---|---|---|---|---|---|---|---|---|---|---|`,
  ...rows.map((r) =>
    r.error
      ? `| ${r.key} | 실패: ${r.error} | | | | | | | | | | |`
      : `| ${r.key} | ${r.pagesPass ?? 0}/${r.pagesWord} | ${pct(r.breakAgree, r.breakTotal)} (${r.breakAgree}/${r.breakTotal}) | ${r.pagesWord}/${r.pagesOmni} | ${r.linesWord}/${r.linesOmni} | ${r.boxSplits ?? "-"} | ${pct(r.textCover, 1)} | ${pct(r.samePage, r.breakAgree)} | ${f(r.dxMean)} | ${f(r.dyMean)} / ${f(r.dyMedian)} | ${f(r.dwMean)} (${r.dwN ?? 0}) | ${r.ssim.map((s) => s.toFixed(3)).join(" ")} |`,
  ),
];
const sum = rows.filter((r) => !r.error && !r.key.startsWith("corpus"));
const a = sum.reduce((s, r) => s + r.breakAgree, 0), t = sum.reduce((s, r) => s + r.breakTotal, 0);
const pp = sum.reduce((s, r) => s + (r.pagesPass ?? 0), 0), pw = sum.reduce((s, r) => s + r.pagesWord, 0);
md.push("", `omni- 시험 묶음 합계: 쪽 통과 ${pct(pp, pw)} (${pp}/${pw}), 줄 나눔 일치 ${pct(a, t)} (${a}/${t}), 쪽 수 일치 ${sum.filter((r) => r.pagesWord === r.pagesOmni).length}/${sum.length}, 글상자 쪼개짐 ${sum.reduce((s, r) => s + (r.boxSplits ?? 0), 0)}`);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `docx-${LABEL}.json`), JSON.stringify(rows, null, 1));
writeFileSync(join(OUT, `docx-${LABEL}.md`), md.join("\n") + "\n");
console.log(md.join("\n"));
console.log(`그림: ${picDir}`);
process.exit(0);
