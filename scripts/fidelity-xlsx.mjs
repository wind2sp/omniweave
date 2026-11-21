// Excel fidelity score (docs/design/FIDELITY_XLSX.md): the Excel-made workbook (qa/interop/scripts/xlsx_fidelity_make.ps1)
// against Excel's own dump of it and the pages Excel printed (xlsx_fidelity_pdf.ps1):
//   engine   — shown text of every cell, column widths, row heights, formula values recalculated by Omniweave, an
//              unedited save byte for byte (tests/sheet/measure.ts, through vite-node)
//   pictures — every sheet printed by Omniweave next to Excel's PDF page (SSIM) and the grid as the app shows it,
//              in a headless Edge / Chrome (tests/fidelity/xlsx.ts)
//
//   node scripts/fidelity-xlsx.mjs [--label after] [--out <dir>] [--headed]
//
// Output: <out>/xlsx-<label>.json, <out>/xlsx-<label>.md, <out>/pics/<label>/*.png (default out: node_modules/.cache/omniweave-fidelity-xlsx).
// No new packages: vite / vite-node are dev dependencies and the browser is the one installed on the PC.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const LABEL = opt("--label", "now");
const OUT = resolve(opt("--out", join(ROOT, "node_modules/.cache/omniweave-fidelity-xlsx")));
const BOOK = join(ROOT, "qa/interop/excel-made/omni-xlsx-fidelity.xlsx");
// print workbook (qa/interop/scripts/xlsx_print_make.ps1): every printed page against Excel's PDF of each sheet
// (OMW_PRINT_BOOK=<xlsx>: another print workbook with Excel's <name>.<n>.pdf beside it, e.g. one with another Normal font)
const PRINT_BOOK = process.env.OMW_PRINT_BOOK ? resolve(process.env.OMW_PRINT_BOOK) : join(ROOT, "qa/interop/excel-made/omni-xlsx-print.xlsx");
const CHART_BOOK = join(ROOT, "qa/interop/excel-made/omni-xlsx-chart.xlsx");
// OMW_CHART_MORE_BOOK=<xlsx>: another set of Excel chart pictures (<name>.<n>.png + <name>.truth.json beside it),
// e.g. the 3-D views / chartex settings of qa/interop/scripts/xlsx_chart_var_make.ps1
const CHART_MORE_BOOK = process.env.OMW_CHART_MORE_BOOK ? resolve(process.env.OMW_CHART_MORE_BOOK) : join(ROOT, "qa/interop/excel-made/omni-xlsx-chart-more.xlsx");
// OMW_FIDELITY_PORT: another checkout's run may hold the default port
const PORT = Number(process.env.OMW_FIDELITY_PORT) || 5841;
const picDir = join(OUT, "pics", LABEL);
mkdirSync(picDir, { recursive: true });

// ───── engine ─────
const eng = spawnSync(process.execPath, [join(ROOT, "node_modules/vite-node/vite-node.mjs"), "tests/sheet/report.ts", BOOK], { encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });
const line = (eng.stdout ?? "").split("\n").find((l) => l.startsWith("@@JSON"));
if (!line) throw new Error("엔진 측정 실패:\n" + (eng.stderr || eng.stdout));
const score = JSON.parse(line.slice(6));

// ───── pictures ─────
let rows = [];
let resolveDone;
const done = new Promise((r) => (resolveDone = r));
const body = (req) =>
  new Promise((res) => {
    const c = [];
    req.on("data", (x) => c.push(x));
    req.on("end", () => res(Buffer.concat(c)));
  });
const plugin = {
  name: "omniweave-fidelity-xlsx",
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      const url = new URL(req.url, "http://x");
      if (!url.pathname.startsWith("/__xlsx/")) return next();
      const what = url.pathname.slice(8);
      if (what.startsWith("print/")) return printRoute(what.slice(6), url, req, res);
      if (what.startsWith("chart/")) return chartRoute(what.slice(6), url, req, res);
      if (what === "file") return res.end(readFileSync(BOOK));
      if (what === "pdf") {
        const p = BOOK.replace(/\.xlsx$/, `.${Number(url.searchParams.get("n"))}.pdf`);
        if (!existsSync(p)) return (res.statusCode = 404), res.end();
        return res.end(readFileSync(p));
      }
      if (what === "pic") {
        const name = url.searchParams.get("name").replace(/[^\w.-]+/g, "_");
        writeFileSync(join(picDir, name), await body(req));
        return res.end("ok");
      }
      if (what === "diag") {
        // --only printdiag: text runs against Excel's and the oracle pages (tests/fidelity/xlsx.ts runPrintDiag)
        writeFileSync(join(OUT, `xlsx-diag-${LABEL}.json`), await body(req));
        return res.end("ok");
      }
      if (what === "done") {
        const r = JSON.parse((await body(req)).toString("utf8"));
        if (r.error) console.error("브라우저 오류:", r.error);
        else rows = r;
        res.end("ok");
        return resolveDone();
      }
      next();
    });
  },
};
// ───── print pages (separate from the page-1 pictures above) ─────
let printRows = [];
async function printRoute(what, url, req, res) {
  if (what === "file") {
    if (!existsSync(PRINT_BOOK)) return (res.statusCode = 404), res.end();
    return res.end(readFileSync(PRINT_BOOK));
  }
  if (what === "pdf") {
    const p = PRINT_BOOK.replace(/\.xlsx$/, `.${Number(url.searchParams.get("n"))}.pdf`);
    if (!existsSync(p)) return (res.statusCode = 404), res.end();
    return res.end(readFileSync(p));
  }
  if (what === "done") {
    printRows = JSON.parse((await body(req)).toString("utf8"));
    return res.end("ok");
  }
  res.statusCode = 404;
  res.end();
}
// ───── charts (Excel Chart.Export pictures) and the chart workbook's printed pages ─────
let chartRes = { charts: [], pages: [] };
async function chartRoute(what, url, req, res) {
  if (what === "done") {
    chartRes = JSON.parse((await body(req)).toString("utf8"));
    return res.end("ok");
  }
  // ?book=more: 3-D, chartex, radar, surface, bubble charts (qa/interop/scripts/xlsx_chart_more_make.ps1)
  const book = url.searchParams.get("book") === "more" ? CHART_MORE_BOOK : CHART_BOOK;
  const file = what === "file" ? book : what === "truth" ? book.replace(/\.xlsx$/, ".truth.json") : what === "pdf" ? book.replace(/\.xlsx$/, ".pdf") : what === "png" ? book.replace(/\.xlsx$/, `.${Number(url.searchParams.get("n"))}.png`) : null;
  if (!file || !existsSync(file)) return (res.statusCode = 404), res.end();
  if (what === "png") res.setHeader("Content-Type", "image/png");
  if (what === "truth") res.setHeader("Content-Type", "application/json");
  return res.end(readFileSync(file));
}
function chartReport() {
  if (!chartRes.charts.length) return [];
  const avg = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(4);
  return [
    "",
    `## 차트 — Excel 차트 그림(Chart.Export) 대비 SSIM 평균 ${avg(chartRes.charts.map((c) => c.ssim))} (그리지 않을 때 ${avg(chartRes.charts.map((c) => c.before))})`,
    "",
    "| 차트 | SSIM | 전(빈 틀) |",
    "|---|---|---|",
    ...chartRes.charts.map((c) => `| ${c.name} | ${c.ssim.toFixed(4)} | ${c.before.toFixed(4)} |`),
    ...(chartRes.more?.length
      ? [
          "",
          `### 3차원·새 차트 종류(chartex)·방사형·표면형·거품형 — SSIM 평균 ${avg(chartRes.more.map((c) => c.ssim))} (빈 틀 ${avg(chartRes.more.map((c) => c.before))})`,
          "",
          "| 차트 | SSIM | 빈 틀 |",
          "|---|---|---|",
          ...chartRes.more.map((c) => `| ${c.name} | ${c.ssim.toFixed(4)} | ${c.before.toFixed(4)} |`),
        ]
      : []),
    "",
    "| 차트 통합 문서 인쇄 | 쪽 수 오메 / Excel | 쪽별 SSIM | 전(그림 없이) |",
    "|---|---|---|---|",
    ...chartRes.pages.map((r) => `| ${r.sheet} | ${r.ourPages} / ${r.excelPages}${r.ourPages === r.excelPages ? "" : " ✗"} | ${r.ssim.map((x) => x.toFixed(3)).join(" · ")} | ${r.before.map((x) => x.toFixed(3)).join(" · ")} |`),
  ];
}
function printReport() {
  if (!printRows.length) return [];
  const all = printRows.flatMap((r) => r.ssim);
  const same = printRows.filter((r) => r.excelPages === r.ourPages).length;
  return [
    "",
    `## 인쇄 쪽(페이지 설정) — 쪽 수 일치 ${same}/${printRows.length}, 쪽 SSIM 평균 ${(all.reduce((a, b) => a + b, 0) / Math.max(1, all.length)).toFixed(4)}`,
    "",
    "| 시트 | 쪽 수 오메 / Excel | 내보내기(PDF·그림) 쪽 | 쪽별 SSIM |",
    "|---|---|---|---|",
    ...printRows.map((r) => `| ${r.sheet} | ${r.ourPages} / ${r.excelPages}${r.ourPages === r.excelPages ? "" : " ✗"} | ${r.exportPages ?? "-"} | ${r.ssim.map((x) => x.toFixed(3)).join(" · ")} |`),
  ];
}

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
const profile = join(tmpdir(), `omniweave-fid-xlsx-${process.pid}`);
const flags = [...(argv.includes("--headed") ? [] : ["--headless=new"]), "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1400,1000", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, `http://127.0.0.1:${PORT}/qa/fidelity/xlsx.html${opt("--only", "") ? `?only=${opt("--only", "")}` : ""}`];
const browser = spawn(exe, flags, { stdio: "ignore", windowsHide: true });
const limit = setTimeout(() => resolveDone(), 5 * 60_000);
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

// ───── report ─────
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const md = [
  `# Excel 충실도 — ${LABEL}`,
  "",
  "| 항목 | 결과 |",
  "|---|---|",
  `| 표시 문자열 일치 | ${pct(score.text.ok, score.text.total)} (${score.text.ok}/${score.text.total}) |`,
  `| 열 너비 ±1px | ${pct(score.colW.exact, score.colW.total)} (${score.colW.exact}/${score.colW.total}), 평균 오차 ${score.colW.meanAbs.toFixed(2)}px |`,
  `| 행 높이 ±1px | ${pct(score.rowH.exact, score.rowH.total)} (${score.rowH.exact}/${score.rowH.total}), 평균 오차 ${score.rowH.meanAbs.toFixed(2)}px |`,
  `| 수식 값(오메가 다시 계산) | ${pct(score.formula.ok, score.formula.total)} (${score.formula.ok}/${score.formula.total}) |`,
  `| 무편집 저장 = 원본 바이트 | ${score.preserve.same ? "예" : "아니오"} |`,
  ...rows.map((r) => `| 인쇄 쪽 SSIM — ${r.sheet} | ${r.ssim.toFixed(4)} (다른 칸 ${(r.bad * 100).toFixed(1)}%) |`),
  "",
  ...printReport(),
  ...chartReport(),
  "",
  ...(score.text.misses.length ? ["표시 문자열 불일치:", ...score.text.misses.map((m) => `- ${m}`), ""] : []),
  ...(score.formula.misses.length ? ["수식 불일치:", ...score.formula.misses.map((m) => `- ${m}`), ""] : []),
  `그림: ${picDir}`,
];
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, `xlsx-${LABEL}.json`), JSON.stringify({ score, pictures: rows, print: printRows, charts: chartRes }, null, 1));
writeFileSync(join(OUT, `xlsx-${LABEL}.md`), md.join("\n") + "\n");
console.log(md.join("\n"));
process.exit(0);
