// Office Surgeon 왕복 시험 키트 — 원본 → 오메로 몇 곳 고쳐 저장 → 만든 프로그램(Word·Excel·한글)으로 원본과
// 고친 파일을 PDF로 저장 → 쪽마다 픽셀 비교 → qa/interop/office-surgeon/roundtrip/ROUNDTRIP.md + 차이 그림.
// 사람이 할 일은 결과 그림을 보고 "고친 곳만 빨갛다"를 확인하는 것뿐이다(한글은 보안 창 '모두 허용'도).
//
//   node scripts/surgeon-roundtrip.mjs            모두(DOCX·XLSX·HWPX)
//   node scripts/surgeon-roundtrip.mjs xlsx hwpx  고른 형식만
//   --skip-edit   편집 단계 건너뜀(office-surgeon/의 기존 omw-*.edited.* 사용)
//   --skip-pdf    PDF 저장 건너뜀(roundtrip/pdf/의 기존 PDF로 비교만)
//
// 창은 띄우지 않는다: 하위 프로세스는 windowsHide, Office는 숨은 인스턴스, 브라우저는 헤드리스.
// 앱이 멈추면(첫 실행 창·보안 창) 앱마다 시간 제한 뒤 이번 실행이 띄운 자동화 인스턴스만 닫고 다음으로 간다.
// 새 패키지 없음: vite·vite-node·pdfjs-dist는 이미 있다.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const ROOT = process.cwd();
const KIT = join(ROOT, "qa/interop/office-surgeon");
const OUT = join(KIT, "roundtrip");
const PDF = join(OUT, "pdf");
const HEAT = join(OUT, "heat");
const PORT = 5207;
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const want = args.filter((a) => !a.startsWith("--"));

/** samples: original (made by the program itself) and the edit script that writes omw-<name>.edited.<ext> */
const SAMPLES = [
  { fmt: "docx", src: "qa/interop/adobe-made/word_doc.docx", edit: "qa/interop/scripts/office_surgeon_edit.ts", app: "Word", timeout: 180 },
  { fmt: "xlsx", src: "qa/interop/adobe-made/excel_book.xlsx", edit: "qa/interop/scripts/office_surgeon_edit_xlsx.ts", app: "Excel", timeout: 180 },
  { fmt: "hwpx", src: "qa/interop/adobe-made/hwpx_doc.hwpx", edit: "qa/interop/scripts/office_surgeon_edit_hwpx.ts", app: "한글", timeout: 300 },
].filter((s) => !want.length || want.includes(s.fmt));

const edited = (s) => join(KIT, `omw-${basename(s.src).replace(/\.\w+$/, "")}.edited.${s.fmt}`);
const run = (cmd, argv, timeoutSec) => spawnSync(cmd, argv, { encoding: "utf8", windowsHide: true, timeout: timeoutSec * 1000 });

/** per format: why it could not be compared (no comparison is made then) */
const status = {};

// ───────── 1. edit with Omniweave ─────────
if (!flags.has("--skip-edit"))
  for (const s of SAMPLES) {
    console.log(`▶ 편집 ${s.fmt}: ${s.src}`);
    const r = run(process.execPath, ["node_modules/vite-node/vite-node.mjs", s.edit, s.src, KIT], 300);
    process.stdout.write((r.stdout ?? "").split("\n").filter((l) => !/legacy/.test(l)).join("\n"));
    if (r.status !== 0) {
      status[s.fmt] = "오메 편집 실패";
      console.error(`  편집 실패: ${(r.stderr ?? "").slice(0, 400)}`);
    }
  }

// ───────── 2. PDF from the program that made the document ─────────
/**
 * Run a command with a time limit, collecting stdout as it comes (the "PID n" lines arrive before any hang).
 * On time-out the command's own process tree is ended (taskkill /T); COM servers it started are not in that
 * tree, so the caller closes them by their reported PIDs.
 */
function runLimited(cmd, argv, timeoutSec) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(0, 400)));
    let timedOut = false;
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout, timedOut: false, error: String(e.message) });
    });
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    }, timeoutSec * 1000);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ stdout, timedOut, stderr });
    });
  });
}

/** close the automation instances surgeon_pdf.ps1 reported starting ("PID n" lines) — never anything else */
function closeStuck(pids) {
  for (const pid of pids) spawnSync("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore", windowsHide: true });
  return pids.join(",");
}
if (!flags.has("--skip-pdf")) {
  mkdirSync(PDF, { recursive: true });
  for (const s of SAMPLES) {
    const files = [join(ROOT, s.src), edited(s)].filter(existsSync);
    // no stale PDF from an earlier run may stand in for one that fails now
    for (const f of [join(ROOT, s.src), edited(s)]) rmSync(join(PDF, `${basename(f)}.pdf`), { force: true });
    if (status[s.fmt]) continue;
    console.log(`▶ PDF ${s.app}: ${files.map((f) => basename(f)).join(", ")}`);
    const r = await runLimited("powershell", ["-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "qa/interop/scripts/surgeon_pdf.ps1", "-Out", PDF, ...files], s.timeout);
    const lines = r.stdout.split(/\r?\n/).filter(Boolean);
    const pids = lines.map((l) => /^PID (\d+)$/.exec(l)?.[1]).filter(Boolean);
    lines.filter((l) => !l.startsWith("PID ")).forEach((l) => console.log("  " + l));
    if (r.timedOut) {
      const closed = closeStuck(pids);
      status[s.fmt] = `${s.app}: ${s.timeout}초 안에 끝나지 않음${s.app === "한글" ? "(보안 창 '모두 허용'이 필요했을 수 있음)" : "(첫 실행 창이 숨어 있을 수 있음)"}${closed ? ` — 이번 실행이 띄운 인스턴스 닫음: ${closed.replace(/\s+/g, ",")}` : ""}`;
      console.error("  " + status[s.fmt]);
    } else if (r.error) status[s.fmt] = `PowerShell 실행 실패: ${r.error}`;
    else if (lines.some((l) => l.startsWith("FAIL"))) status[s.fmt] = lines.filter((l) => l.startsWith("FAIL")).join(" / ");
    else if (!lines.some((l) => l.startsWith("OK"))) status[s.fmt] = `PDF 저장 결과 없음${r.stderr ? `: ${r.stderr.trim().slice(0, 200)}` : ""}`;
  }
}

// ───────── 3. compare page by page (pdf.js in a headless browser) ─────────
const pairs = SAMPLES.filter((s) => !status[s.fmt]).map((s) => ({ name: s.fmt, a: `${basename(s.src)}.pdf`, b: `${basename(edited(s))}.pdf` })).filter((p) => existsSync(join(PDF, p.a)) && existsSync(join(PDF, p.b)));
const rows = [];
if (pairs.length) {
  console.log(`▶ 비교: ${pairs.map((p) => p.name).join(", ")}`);
  spawnSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "ignore", windowsHide: true });
  rmSync(HEAT, { recursive: true, force: true });
  mkdirSync(HEAT, { recursive: true });
  let finish;
  const done = new Promise((r) => (finish = r));
  const body = (req) => new Promise((res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
  });
  const plugin = {
    name: "omniweave-roundtrip",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://x");
        if (!url.pathname.startsWith("/__roundtrip/")) return next();
        const what = url.pathname.slice("/__roundtrip/".length);
        if (what === "pairs") return res.setHeader("content-type", "application/json"), res.end(JSON.stringify(pairs));
        if (what === "file") {
          const name = basename(url.searchParams.get("name") ?? "");
          const p = join(PDF, name);
          if (!existsSync(p)) return (res.statusCode = 404), res.end();
          return res.end(readFileSync(p));
        }
        if (what === "heat") {
          const file = `${url.searchParams.get("name")}-p${url.searchParams.get("page")}.png`.replace(/[^\w.-]+/g, "_");
          writeFileSync(join(HEAT, file), await body(req));
          return res.end(`heat/${file}`);
        }
        if (what === "row") return rows.push(JSON.parse((await body(req)).toString("utf8"))), res.end("ok");
        if (what === "done") {
          const msg = (await body(req)).toString("utf8");
          if (msg) console.error("  브라우저 비교 오류:", msg);
          res.end("ok");
          return finish();
        }
        next();
      });
    },
  };
  const { createServer } = await import("vite");
  const server = await createServer({ server: { port: PORT, strictPort: true, host: "127.0.0.1", open: false, hmr: false, watch: { ignored: ["**/*"] } }, plugins: [plugin], logLevel: "warn", clearScreen: false });
  await server.listen();
  const exe = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find(existsSync);
  if (!exe) throw new Error("Edge/Chrome을 찾지 못했습니다");
  const profile = join(tmpdir(), `omniweave-roundtrip-${process.pid}`);
  const browser = spawn(exe, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", `--user-data-dir=${profile}`, `http://127.0.0.1:${PORT}/qa/interop/office-surgeon/compare.html`], { stdio: "ignore", windowsHide: true });
  const limit = setTimeout(() => (console.error("  비교 시간 초과(5분)"), finish()), 5 * 60_000);
  await done;
  clearTimeout(limit);
  // only this run's browser (its private profile), never the person's own
  spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  run("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.Name -in 'msedge.exe','chrome.exe' -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], 60);
  await new Promise((r) => setTimeout(r, 800));
  await server.close();
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {}
}

// ───────── 4. report ─────────
mkdirSync(OUT, { recursive: true });
const lines = [
  `# Office Surgeon 왕복 시험 — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  "",
  "원본(그 프로그램이 만든 견본)과 오메가 몇 곳 고쳐 원본 보존 저장한 파일을 **같은 프로그램으로 PDF 저장**해 쪽마다 비교했습니다.",
  "빨간 곳이 달라진 픽셀입니다. 고친 곳(과 그 때문에 밀린 줄)만 빨가면 정상입니다.",
  "고친 내용은 각 편집 스크립트 머리말에 있습니다(`qa/interop/scripts/office_surgeon_edit*.ts`).",
  "",
  "| 형식 | 쪽 수 (원본/고친) | 쪽별 차이 (픽셀 % · 16px 칸 수) | 차이 그림 | 메모 |",
  "|---|---|---|---|---|",
];
for (const s of SAMPLES) {
  const row = rows.find((r) => r.name === s.fmt);
  if (!row) {
    lines.push(`| ${s.fmt} | — | — | — | ${status[s.fmt] ?? "PDF 없음"} |`);
    continue;
  }
  const per = row.pages.map((p) => (p.missing ? `${p.page}쪽 없음` : `${p.page}쪽 ${(p.ratio * 100).toFixed(2)}% · ${p.cells}`)).join("<br>");
  const heats = row.pages.filter((p) => p.heat).map((p) => `[${p.page}쪽](${p.heat})`).join(" ");
  const note = [row.error, row.pagesA !== row.pagesB ? "쪽 수 다름" : "", status[s.fmt]].filter(Boolean).join(" / ");
  lines.push(`| ${s.fmt} | ${row.pagesA}/${row.pagesB} | ${per || "-"} | ${heats || "차이 없음"} | ${note} |`);
}
lines.push("", `PDF: \`${relative(ROOT, PDF).replace(/\\/g, "/")}/\` · 다시 실행: \`node scripts/surgeon-roundtrip.mjs\``, "");
writeFileSync(join(OUT, "ROUNDTRIP.md"), lines.join("\r\n"));
console.log(`\n보고서: ${relative(ROOT, join(OUT, "ROUNDTRIP.md"))}`);
