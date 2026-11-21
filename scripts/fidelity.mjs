// npm run fidelity — measures docs/DESKTOP_DONE.md items 1–4 and writes the reports.
//
//   node scripts/fidelity.mjs              everything (Node round trips + browser screen + reports)
//   node scripts/fidelity.mjs --node       only (1)(2)(3) in Node
//   node scripts/fidelity.mjs --screen     only the browser part (4) + browser-decoded opens
//   node scripts/fidelity.mjs --report     only rebuild the reports from the last raw results
//   --headed                               show the browser window instead of running headless
//   FIDELITY_EXTRA=<folder> node scripts/fidelity.mjs --screen
//                                          only the .ai/.pdf files of that folder (e.g. third-party samples kept
//                                          outside the repository): ids extra#N, results printed and written to
//                                          <raw>/FIDELITY-screen-extra.json, heat maps in the temp folder — the
//                                          reports and qa/fidelity are not touched
//
// Steps
//   1. vitest tests/fidelity/fidelity.test.ts (OMNIWEAVE_FIDELITY=1) → <raw>/FIDELITY-node.json
//   2. vite dev server on port 5205 + a middleware (/__fidelity/*) + headless Edge/Chrome opening
//      qa/fidelity/screen.html → <raw>/FIDELITY-screen.json, heat maps
//   3. qa/fidelity/REPORT.md (format aggregates only — personal files are never named) and
//      test-corpus/FIDELITY.md (per-file detail, stays out of the repository)
// <raw> = test-corpus/ when it exists (raw rows name personal files), else node_modules/.cache/omniweave-fidelity/.
// No new packages: vite and vitest are already dev dependencies; the browser is the one installed on the PC.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

const ROOT = process.cwd();
const CORPUS = join(ROOT, "test-corpus");
const INTEROP = join(ROOT, "qa/interop/adobe-made");
const REFERENCE = join(ROOT, "qa/interop/reference");
const CACHE = join(ROOT, "node_modules/.cache/omniweave-fidelity");
const RAW = existsSync(CORPUS) ? CORPUS : CACHE;
const OUT = join(ROOT, "qa/fidelity");
const PORT = 5205;
const args = new Set(process.argv.slice(2));
const only = ["--node", "--screen", "--report"].find((a) => args.has(a));
const EXTRA = process.env.FIDELITY_EXTRA;

function runNode() {
  console.log("▶ (1)(2)(3) Node 측정: vitest tests/fidelity/fidelity.test.ts");
  const r = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/fidelity/fidelity.test.ts"], {
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, OMNIWEAVE_FIDELITY: "1", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim() },
  });
  if (r.status !== 0) throw new Error("Node 측정이 실패했습니다");
}

// ───────── inputs (same order and ids as tests/fidelity/fidelity.test.ts) ─────────

// omni-ai-*.png: Illustrator's own artboard renders (qa/interop/adobe-made/ai-fidelity) — references, not inputs
const skipName = (n) => /^(README|REPORT|FIDELITY)/i.test(n) || /\.ref\.pdf$/i.test(n) || /^omni-ai-.*\.png$/i.test(n) || n === ".gitkeep";
/** Illustrator artboard renders of an .ai (<name>-ab1.png …, the -nopdf variant shares them) */
function aiPngsFor(path) {
  if (!/\.ai$/i.test(path)) return [];
  const stem = path.replace(/(-nopdf|-pdf)?\.ai$/i, ""); // -pdf / -nopdf copies share the original's renders
  const out = [];
  for (let i = 1; existsSync(`${stem}-ab${i}.png`); i++) out.push(`${stem}-ab${i}.png`);
  return out;
}
/** Photoshop's own render of a .psd/.psb (<name>.ps.png next to it) — the reference when the file's merged image is a
 * placeholder ('Maximize PSD Compatibility' off, the -nomax files); screen.ts decides by the file's version info */
function psPngFor(path) {
  if (!/\.(psd|psb)$/i.test(path)) return undefined;
  const p = path.replace(/\.(psd|psb)$/i, ".ps.png");
  return existsSync(p) ? p : undefined;
}
function refFor(path) {
  const base = basename(path);
  const cands = [`${path}.ref.pdf`, join(REFERENCE, `${base}.pdf`), join(REFERENCE, `${base.replace(/\.[^.]+$/, "")}.pdf`)];
  return cands.find((p) => existsSync(p));
}
function listItems() {
  const items = [];
  if (EXTRA) {
    let n = 0;
    for (const f of readdirSync(EXTRA).sort()) if (/\.(ai|pdf)$/i.test(f)) items.push({ set: "extra", id: `extra#${++n}`, path: join(EXTRA, f) });
    return items.map((it, i) => ({ ...it, file: it.id, key: `extra/${i}/extra-${i + 1}.${it.path.split(".").pop().toLowerCase()}`, ext: it.path.split(".").pop().toLowerCase(), ref: undefined, aiPngs: aiPngsFor(it.path), psPng: psPngFor(it.path), nodeOpen: undefined }));
  }
  const samples = join(CACHE, "samples");
  if (existsSync(samples)) for (const f of readdirSync(samples).sort()) items.push({ set: "public", id: f, path: join(samples, f) });
  if (existsSync(INTEROP)) {
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (!skipName(f)) items.push({ set: "interop", id: relative(INTEROP, p).replace(/\\/g, "/"), path: p });
      }
    };
    walk(INTEROP);
  }
  if (existsSync(CORPUS)) {
    let n = 0;
    for (const dir of readdirSync(CORPUS).sort()) {
      const d = join(CORPUS, dir);
      if (!statSync(d).isDirectory()) continue;
      for (const f of readdirSync(d).sort()) {
        const p = join(d, f);
        if (!statSync(p).isFile() || skipName(f)) continue;
        items.push({ set: "corpus", id: `corpus#${++n}`, path: p });
      }
    }
  }
  const node = readJson(join(RAW, "FIDELITY-node.json"));
  const nodeOpen = new Map((node?.rows ?? []).map((r) => [r.set + "|" + r.file, r.open.status]));
  // FIDELITY_ONLY=pdf|psd — measure only these extensions in the browser (quick re-checks)
  const only = process.env.FIDELITY_ONLY ? new RegExp(`^(${process.env.FIDELITY_ONLY})$`, "i") : null;
  return items
    .map((it, i) => {
      const ref = refFor(it.path);
      const file = it.set === "corpus" ? relative(CORPUS, it.path).replace(/\\/g, "/") : it.id;
      return { ...it, file, key: `${it.set}/${i}/${basename(it.path)}`, ext: it.path.split(".").pop().toLowerCase(), ref, aiPngs: aiPngsFor(it.path), psPng: psPngFor(it.path), nodeOpen: nodeOpen.get(it.set + "|" + file) };
    })
    .filter((it) => !only || only.test(it.ext));
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// ───────── browser part ─────────

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

async function runScreen() {
  console.log(`▶ (4) 화면 충실도: 개발 서버 ${PORT} + 헤드리스 브라우저`);
  spawnSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "inherit", windowsHide: true });
  const items = listItems();
  const byKey = new Map(items.map((it) => [it.key, it]));
  const refs = new Map();
  for (const it of items) if (it.ref) refs.set(`ref:${it.key}`, it.ref);
  for (const it of items) it.aiPngs.forEach((p, i) => refs.set(`aipng:${it.key}:${i}`, p));
  for (const it of items) if (it.psPng) refs.set(`pspng:${it.key}`, it.psPng);
  const rows = new Map(); // by key: a page reload must not duplicate rows
  const corpusHeat = [];
  const HEAT = EXTRA ? join(tmpdir(), "omniweave-fidelity-extra-heat") : join(OUT, "heatmaps");
  rmSync(HEAT, { recursive: true, force: true });
  mkdirSync(HEAT, { recursive: true });
  let finish;
  const done = new Promise((res) => (finish = res));
  const body = (req) => new Promise((res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
  });
  const plugin = {
    name: "omniweave-fidelity",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://x");
        if (!url.pathname.startsWith("/__fidelity/")) return next();
        const what = url.pathname.slice("/__fidelity/".length);
        if (what === "list") {
          res.setHeader("content-type", "application/json");
          return res.end(JSON.stringify(items.map((it) => ({ key: it.key, set: it.set, id: it.id, ext: it.ext, ref: it.ref ? `ref:${it.key}` : undefined, aiPngs: it.aiPngs.map((_, i) => `aipng:${it.key}:${i}`), psPng: it.psPng ? `pspng:${it.key}` : undefined, nodeOpen: it.nodeOpen }))));
        }
        if (what === "file") {
          const key = url.searchParams.get("key");
          const p = refs.get(key) ?? byKey.get(key)?.path;
          if (!p) return (res.statusCode = 404), res.end();
          return res.end(readFileSync(p));
        }
        if (what === "heat") {
          const buf = await body(req);
          const name = url.searchParams.get("name");
          const set = url.searchParams.get("set");
          if (set === "corpus") {
            const [key, rest] = name.split("#");
            const it = byKey.get(key);
            corpusHeat.push({ id: it?.id ?? key, file: it ? relative(CORPUS, it.path).replace(/\\/g, "/") : key, page: rest, png: buf.toString("base64") });
            return res.end(`test-corpus/FIDELITY-heatmaps.html#${it?.id ?? "?"}-${rest}`);
          }
          const it = byKey.get(name.split("#")[0]);
          const file = `${(it?.id ?? "x").replace(/[^\w.-]+/g, "_")}-${name.split("#")[1]}.png`.replace(/[^\w.-]+/g, "_");
          writeFileSync(join(HEAT, file), buf);
          return res.end(`qa/fidelity/heatmaps/${file}`);
        }
        if (what === "row") {
          const row = JSON.parse((await body(req)).toString("utf8"));
          const it = byKey.get(row.key);
          rows.set(row.key, { ...row, file: it ? it.file : row.key, reference: it?.ref ? relative(ROOT, it.ref).replace(/\\/g, "/") : undefined });
          process.stdout.write(".");
          return res.end("ok");
        }
        if (what === "done") {
          const msg = (await body(req)).toString("utf8");
          if (msg) console.error("\n브라우저 측정 오류:", msg);
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
  const exe = findBrowser();
  if (!exe) {
    await server.close();
    throw new Error("Edge/Chrome을 찾지 못했습니다 — FIDELITY_BROWSER 환경 변수로 경로를 지정하세요");
  }
  const profile = join(tmpdir(), `omniweave-fidelity-${process.pid}`);
  const url = `http://127.0.0.1:${PORT}/qa/fidelity/screen.html`;
  const flags = [...(args.has("--headed") ? [] : ["--headless=new"]), "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1400,1000", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, url];
  const browser = spawn(exe, flags, { stdio: "ignore", windowsHide: true, detached: false });
  const limit = setTimeout(() => {
    console.error("\n화면 측정 시간 초과(40분) — 받은 결과까지만 씁니다");
    finish();
  }, 40 * 60_000);
  await done;
  clearTimeout(limit);
  // the browser and its helpers: kill the whole tree (no window was ever shown)
  // Edge/Chrome hand off to a broker process, so the launcher's tree is not enough: stop every
  // process started with this run's private profile directory (never the person's own browser)
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
  console.log(`\n화면 측정 ${rows.size}개 완료`);
  mkdirSync(RAW, { recursive: true });
  if (EXTRA) {
    for (const r of rows.values()) console.log(r.file, r.ext, r.screen?.status ?? "", r.screen?.note ?? "", (r.screen?.pages ?? []).map((p) => `${p.kind}:${f4(p.ssim)}`).join(" "));
    writeFileSync(join(RAW, "FIDELITY-screen-extra.json"), JSON.stringify({ when: new Date().toISOString(), browser: basename(exe), rows: [...rows.values()] }, null, 1));
    return;
  }
  writeFileSync(join(RAW, "FIDELITY-screen.json"), JSON.stringify({ when: new Date().toISOString(), browser: basename(exe), rows: [...rows.values()] }, null, 1));
  if (existsSync(CORPUS)) {
    const html = [`<!doctype html><meta charset="utf-8"><title>FIDELITY heat maps (local only)</title><style>body{font:13px sans-serif;margin:16px}img{max-width:900px;border:1px solid #ccc;display:block;margin:4px 0 20px}</style><h1>화면 차이 히트맵 (개인 파일 — 저장소 밖)</h1><p>노랑→빨강: SSIM 0.9 → 0.5 이하 영역. 회색: 일치.</p>`];
    for (const h of corpusHeat) html.push(`<h3 id="${h.id}-${h.page}">${h.id} · ${escapeHtml(h.file)} · ${escapeHtml(h.page)}</h3><img src="data:image/png;base64,${h.png}">`);
    writeFileSync(join(CORPUS, "FIDELITY-heatmaps.html"), html.join("\n"));
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ───────── reports ─────────

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const f4 = (x) => (Number.isFinite(x) ? x.toFixed(4) : "-");
/** "표 4→0" → "표" (labels are ours; numbers removed so files cannot be told apart) */
function cause(d) {
  const s = d.replace(/\s*\(.*?\)/g, "").trim();
  const n = /^(.*?)\s+([\d.]+)→([\d.]+)$/.exec(s);
  if (n) return `${n[1]} ${+n[3] === 0 ? "사라짐" : +n[3] < +n[2] ? "줄어듦" : "늘어남"}`;
  const v = /^(.*?)\s+(\S+)→(\S+)$/.exec(s);
  if (v) return `${v[1]} 바뀜`;
  return s.replace(/\d+/g, "N");
}
const FORMAT_LABEL = { pdf: "PDF", ai: "AI", psd: "PSD", docx: "DOCX", hwpx: "HWPX", xlsx: "XLSX", pptx: "PPTX", csv: "CSV", srt: "SRT", md: "Markdown", html: "HTML", txt: "TXT", log: "LOG", json: "JSON", xml: "XML", yaml: "YAML", bat: "BAT", code: "코드", image: "이미지", tiff: "TIFF", heic: "HEIC", video: "동영상", audio: "오디오", doc: "DOC", hwp: "HWP", epub: "EPUB", xls: "XLS", ppt: "PPT", omw: "OMW(작업 파일)" };
const label = (f) => FORMAT_LABEL[f] ?? f;
const SETS = { public: "공개 샘플", interop: "호환 시험 파일", corpus: "실무 샘플(test-corpus)" };

function buildReport() {
  const node = readJson(join(RAW, "FIDELITY-node.json"));
  const screen = readJson(join(RAW, "FIDELITY-screen.json"));
  if (!node) throw new Error(`${relative(ROOT, join(RAW, "FIDELITY-node.json"))}이 없습니다 — 먼저 npm run fidelity`);
  const rows = node.rows;
  const sRows = screen?.rows ?? [];
  const sBy = new Map(sRows.map((r) => [r.set + "|" + r.file, r]));
  // (3) open status: Node result, or the browser's for browser-decoded formats
  for (const r of rows) {
    // same rule as the test (older raw files): explained refusals are not failures
    if (r.open.status === "실패" && /암호|DRM|배포용|PDF 호환 (사본|정보)/.test(r.open.detail ?? "")) r.open.status = "안내(미지원)";
    const s = sBy.get(r.set + "|" + r.file);
    if (r.open.status === "브라우저 측정") r.open = s?.open ? { ...r.open, ...s.open, env: "browser" } : { ...r.open, status: "미측정" };
    r.screenRow = s;
  }
  const formats = [...new Set(rows.map((r) => r.format))].sort((a, b) => label(a).localeCompare(label(b)));
  const when = new Date().toISOString().replace("T", " ").slice(0, 16);

  // ── item 1
  const rt = rows.filter((r) => !["해당 없음", "변환 저장"].includes(r.roundtrip.status));
  const rtByte = rt.filter((r) => r.roundtrip.status === "바이트 동일").length;
  const rtSem = rt.filter((r) => r.roundtrip.status === "의미 동일").length;
  // ── item 2
  const ed = rows.filter((r) => !["해당 없음", "변환 저장"].includes(r.edit.status));
  const edOk = ed.filter((r) => r.edit.status === "보존").length;
  // ── item 3
  const op = rows.filter((r) => r.open.status !== "미측정");
  const cnt = (xs, s) => xs.filter((r) => r.open.status === s).length;
  // ── item 4
  const pages = sRows.flatMap((r) => r.screen.pages.map((p) => ({ ...p, set: r.set, ext: r.ext, format: rows.find((x) => x.set === r.set && x.file === r.file)?.format ?? r.ext })));
  const openPages = pages.filter((p) => p.kind === "열기");

  const L = [];
  L.push("# 충실도 측정 보고서 (DESKTOP_DONE 1~4번)");
  L.push("");
  L.push(`생성: ${when} · \`npm run fidelity\` · Node 측정 ${node.when.slice(0, 16).replace("T", " ")}${screen ? ` · 화면 측정 ${screen.when.slice(0, 16).replace("T", " ")} (${screen.browser}, 헤드리스)` : " · 화면 측정 없음"}`);
  L.push("");
  L.push("> 개인 파일(test-corpus/)은 **형식별 집계만** 싣습니다. 파일 이름·내용은 이 보고서에 없습니다(상세는 저장소 밖 `test-corpus/FIDELITY.md`).");
  L.push("> 차이 항목은 측정 도구가 붙인 이름과 개수뿐입니다(예: `표 4→0`).");
  L.push("");
  L.push("## 요약 — 완료 기준표 1~4번");
  L.push("");
  L.push("| # | 항목 | 대상 | 결과 | 목표 |");
  L.push("|---|---|---|---|---|");
  L.push(`| 1 | 원본 보존(무편집 왕복) | 원래 형식 저장이 있는 ${rt.length}개 | 바이트 동일 **${rtByte}** (${pct(rtByte, rt.length)}) · 의미 동일 ${rtSem} · 차이 ${rt.filter((r) => r.roundtrip.status === "차이").length} · 저장 실패 ${rt.filter((r) => r.roundtrip.status === "저장 실패").length} | 99.9% 동일 |`);
  L.push(`| 2 | 부분 편집 보존 | 한 곳 수정 ${ed.length}개 | 보존 **${edOk}** (${pct(edOk, ed.length)}) · 훼손 ${ed.filter((r) => r.edit.status === "훼손").length} · 반영 안 됨 ${ed.filter((r) => r.edit.status === "편집 반영 안 됨").length} · 실패 ${ed.filter((r) => r.edit.status === "저장 실패").length} | 99% |`);
  L.push(`| 3 | 열기 성공률 | ${op.length}개 | 성공 ${cnt(op, "성공")} · 부분 ${cnt(op, "부분")} (${pct(cnt(op, "부분"), op.length)}) · 실패 **${cnt(op, "실패")}** · 안내(미지원) ${cnt(op, "안내(미지원)")} | 실패 0 · 부분 ≤ 1% |`);
  L.push(`| 4 | 화면 충실도(SSIM) | ${openPages.length}쪽 | 평균 **${f4(mean(openPages.map((p) => p.ssim)))}** · 0.99 이상 ${pct(openPages.filter((p) => p.ssim >= 0.99).length, openPages.length)} · 기준 렌더 없음 ${sRows.filter((r) => r.screen.status === "기준 렌더 없음").length}개 파일 | ≥ 0.99 |`);
  L.push("");
  L.push("대상에서 빠진 것: 원래 형식 저장이 없는 형식(이미지·동영상·오디오), 쓰기를 지원하지 않아 다른 형식으로 저장하는 형식(DOC→DOCX, HWP→HWPX, EPUB→DOCX 등 — `변환 저장`), 열지 못한 파일.");
  L.push("");

  const setsPresent = Object.keys(SETS).filter((s) => rows.some((r) => r.set === s));
  L.push("## 1. 원본 보존 — 무편집 왕복 (열기 → 원래 형식으로 저장 → 비교)");
  L.push("");
  L.push("| 형식 | 묶음 | 대상 | 바이트 동일 | 의미 동일 | 차이 | 저장 실패 | 변환 저장·해당 없음 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const f of formats)
    for (const s of setsPresent) {
      const xs = rows.filter((r) => r.format === f && r.set === s);
      if (!xs.length) continue;
      const t = xs.filter((r) => !["해당 없음", "변환 저장"].includes(r.roundtrip.status));
      const c = (st) => t.filter((r) => r.roundtrip.status === st).length;
      L.push(`| ${label(f)} | ${SETS[s]} | ${t.length} | ${c("바이트 동일")} | ${c("의미 동일")} | ${c("차이")} | ${c("저장 실패")} | ${xs.length - t.length} |`);
    }
  L.push("");
  L.push("의미 동일 기준: PDF 쪽별 텍스트·pdf.js 그리기 명령 · PSD 레이어 레코드 바이트·합쳐진 이미지 픽셀 · DOCX/HWPX 문단·런 텍스트·글자/문단 서식 + 구조 목록(표·그림·머리글·필드·목록·쪽 크기·여백·스타일 등) · XLSX 셀 값·수식 + 구조(병합·서식·표시 형식·열 너비·틀 고정·이름 정의·차트…) · PPTX 슬라이드 텍스트·개체 수 + 구조(그룹·연결선·미디어·노트·애니메이션·전환·레이아웃) · 텍스트 계열 인코딩·BOM·줄바꿈·줄.");
  L.push("");
  L.push(...causes("1번 차이 원인 (파일 수)", rows.filter((r) => r.roundtrip.status === "차이" || r.roundtrip.status === "저장 실패"), (r) => r.roundtrip.diffs));

  L.push("## 2. 부분 편집 보존 — 한 곳만 고쳐 저장 → 다시 열어 나머지 비교");
  L.push("");
  L.push("편집 내용: PDF/AI = 'PDF 텍스트 편집'으로 승격 후 한 줄의 끝 글자 삭제(승격만 하고 저장한 대조군도 확인) · PSD = 픽셀 레이어 하나의 10×10 칠하기 · DOCX/HWPX/PPTX/MD/HTML = 문단 하나 끝에 `~` · XLSX/CSV = 글자 셀 하나 끝에 `~` · SRT = 자막 하나 · 텍스트 계열 = 한 줄 끝에 `~`.");
  L.push("보존 기준: PDF = 원본 바이트 + 증분 저장 · Illustrator 고유 데이터가 있는 AI = 편집을 고유 데이터에 옮기므로 일부러 전체 다시 쓰기(옛 고유 데이터가 새지 않게) — 대신 고유 데이터 유지·레이어 그대로·그림 줄 그대로·글은 편집만큼·옛 고유 데이터 없음·쪽 렌더 SSIM(편집 쪽 ≥ 0.95, 다른 쪽 ≥ 0.999)으로 판정(2026-11-21).");
  L.push("");
  L.push("| 형식 | 묶음 | 대상 | 보존 | 훼손 | 반영 안 됨 | 저장 실패 | 해당 없음 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const f of formats)
    for (const s of setsPresent) {
      const xs = rows.filter((r) => r.format === f && r.set === s);
      if (!xs.length) continue;
      const t = xs.filter((r) => !["해당 없음", "변환 저장"].includes(r.edit.status));
      const c = (st) => t.filter((r) => r.edit.status === st).length;
      L.push(`| ${label(f)} | ${SETS[s]} | ${t.length} | ${c("보존")} | ${c("훼손")} | ${c("편집 반영 안 됨")} | ${c("저장 실패")} | ${xs.length - t.length} |`);
    }
  L.push("");
  L.push(...causes("2번 훼손 원인 (파일 수)", rows.filter((r) => ["훼손", "저장 실패", "편집 반영 안 됨"].includes(r.edit.status)), (r) => r.edit.diffs));

  L.push("## 3. 열기 성공률");
  L.push("");
  L.push("| 형식 | 묶음 | 파일 | 성공 | 부분 | 실패 | 안내(미지원) | 미측정 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const f of formats)
    for (const s of setsPresent) {
      const xs = rows.filter((r) => r.format === f && r.set === s);
      if (!xs.length) continue;
      const c = (st) => xs.filter((r) => r.open.status === st).length;
      L.push(`| ${label(f)} | ${SETS[s]} | ${xs.length} | ${c("성공")} | ${c("부분")} | ${c("실패")} | ${c("안내(미지원)")} | ${c("미측정")} |`);
    }
  L.push("");
  L.push("'부분' = 열었지만 오메가 경고를 낸 경우(근사·생략, 텍스트만 가져오는 구형 형식 등). 이미지·동영상·오디오·TIFF는 브라우저 엔진에서 실제 `importFile`로 측정합니다.");
  L.push("");

  L.push("## 4. 화면 충실도 — 원본 기준 렌더 vs 오메 렌더(SSIM)");
  L.push("");
  if (!screen) L.push("화면 측정 결과가 없습니다 (`npm run fidelity` 전체 실행 또는 `node scripts/fidelity.mjs --screen`).");
  else {
    L.push("| 형식 | 묶음 | 화면 | 측정 쪽 | 평균 SSIM | 최소 | 0.99 이상 | 기준 |");
    L.push("|---|---|---|---|---|---|---|---|");
    const groups = new Map();
    for (const p of pages) {
      const k = `${p.format}|${p.set}|${p.kind}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    for (const [k, ps] of [...groups].sort()) {
      const [f, s, kind] = k.split("|");
      const ref = sRows.find((r) => r.set === s && r.ext === ps[0].ext && r.screen.reference)?.screen.reference ?? "";
      L.push(`| ${label(f)} | ${SETS[s]} | ${kind} | ${ps.length} | ${f4(mean(ps.map((p) => p.ssim)))} | ${f4(Math.min(...ps.map((p) => p.ssim)))} | ${pct(ps.filter((p) => p.ssim >= 0.99).length, ps.length)} | ${ref} |`);
    }
    L.push("");
    const noRef = sRows.filter((r) => r.screen.status === "기준 렌더 없음");
    const byFmt = {};
    for (const r of noRef) {
      const f = rows.find((x) => x.set === r.set && x.file === r.file)?.format ?? r.ext;
      byFmt[label(f)] = (byFmt[label(f)] ?? 0) + 1;
    }
    if (noRef.length) L.push(`기준 렌더가 없어 아직 못 잰 파일: ${Object.entries(byFmt).map(([f, n]) => `${f} ${n}`).join(" · ")} — 오피스 프로그램이 출력한 기준 PDF가 필요합니다(아래 '기준 렌더 확보').`, "");
    const failed = sRows.filter((r) => r.screen.status === "실패");
    if (failed.length) L.push(`화면 측정 실패 ${failed.length}개: ${[...new Set(failed.map((r) => (r.screen.note ?? "").replace(/[^가-힣a-zA-Z ()]/g, "").slice(0, 40)))].join(" / ")}`, "");
    const pub = pages.filter((p) => p.set !== "corpus" && p.heat);
    if (pub.length) {
      L.push("공개 샘플 히트맵(SSIM < 0.999인 쪽): " + pub.map((p) => `[${basename(p.heat)}](${p.heat.replace("qa/fidelity/", "")})`).join(" · "));
      L.push("");
    }
  }
  L.push("### 측정 방법");
  L.push("");
  L.push("- SSIM: 휘도(Rec.601, 투명은 흰 종이 위 합성) · 8×8 창 · 보폭 4 · K1 0.01 / K2 0.03 · 긴 변 900px로 줄여 비교 (`tests/fidelity/ssim.ts`, 패키지 없이 직접 구현). '0.99 이상' = 쪽 단위 비율.");
  L.push("- 오메 렌더 = 캔버스·PNG 내보내기와 같은 Weave 렌더러(`paintPage`)로 비동기 자원(PDF 비트맵·이미지)이 다 올 때까지 다시 그린 결과.");
  L.push("- PDF/AI: 기준 = pdf.js 원본 렌더. `열기` = 연 그대로, `편집 모드` = 'PDF 텍스트 편집'(승격) 후 — 오메가 직접 그린 텍스트·벡터가 원본과 얼마나 같은지.");
  L.push("- PSD: 기준 = Photoshop이 파일에 저장한 합쳐진 이미지 — '호환성 최대화'를 끄고 저장해 그 이미지가 자리표시인 파일(-nomax)은 Photoshop이 직접 내보낸 PNG(`<이름>.ps.png`, 2026-11-21~). 오메 렌더 = 레이어를 오메가 합성한 화면(효과·조정 레이어는 근사).");
  L.push("- 이미지·TIFF: 기준 = 브라우저 디코딩(TIFF는 오메 디코더) 원본, 오메 렌더에서 배치된 영역을 잘라 비교. SVG는 편집 가능한 경로로 열리므로(0.1.7~) 쪽 전체 렌더를 브라우저 렌더와 비교.");
  L.push("- DOCX·HWPX·PPTX·XLSX: 기준 = 원본 프로그램이 출력한 PDF(`<파일>.ref.pdf` 또는 `qa/interop/reference/<파일 이름>.pdf`)의 같은 쪽.");
  L.push("");

  // public per-file table
  const pubRows = rows.filter((r) => r.set !== "corpus");
  L.push("## 공개 샘플·호환 시험 파일 상세");
  L.push("");
  L.push("| 파일 | 내용 | 열기 | 1. 무편집 왕복 | 2. 한 곳 편집 | 4. SSIM |");
  L.push("|---|---|---|---|---|---|");
  for (const r of pubRows) {
    const sp = r.screenRow?.screen.pages ?? [];
    const ss = (sp.length ? sp.map((p) => `${p.kind}${p.page} ${p.ssim.toFixed(3)}`).join(", ") : r.screenRow?.screen.status ?? "-") + (r.screenRow?.screen.note ? ` (${r.screenRow.screen.note})` : "");
    L.push(`| ${r.id} | ${r.note ?? ""} | ${r.open.status} | ${r.roundtrip.status}${r.roundtrip.diffs.length ? ": " + r.roundtrip.diffs.join("; ") : ""} | ${r.edit.status}${r.edit.diffs.length ? ": " + r.edit.diffs.join("; ") : ""}${r.edit.extra && !/이미지·미디어/.test(r.edit.extra) ? ` (${r.edit.extra})` : ""} | ${ss} |`);
  }
  L.push("");
  const extra = existsSync(join(OUT, "NOTES.md")) ? readFileSync(join(OUT, "NOTES.md"), "utf8") : "";
  if (extra) L.push(extra.trim(), "");
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "REPORT.md"), L.join("\n") + "\n");
  console.log(`보고서: ${relative(ROOT, join(OUT, "REPORT.md"))}`);

  // ── local per-file detail
  if (existsSync(CORPUS)) {
    const D = [];
    D.push("# 충실도 측정 상세 (개인 파일 — 저장소에 올리지 않음)");
    D.push("");
    D.push(`생성: ${when} · 공개 집계는 qa/fidelity/REPORT.md · 히트맵은 FIDELITY-heatmaps.html`);
    D.push("");
    D.push("| id | 파일 | 형식 | KB | 열기 | 열기 상세 | 1. 무편집 왕복 | 2. 한 곳 편집 | 4. 화면 |");
    D.push("|---|---|---|---|---|---|---|---|---|");
    for (const r of rows.filter((x) => x.set === "corpus")) {
      const sp = r.screenRow?.screen.pages ?? [];
      const ss = sp.length ? sp.map((p) => `${p.kind}${p.page} ${p.ssim.toFixed(4)}${p.note ? ` (${p.note})` : ""}`).join(", ") : `${r.screenRow?.screen.status ?? "-"}${r.screenRow?.screen.note ? ` (${r.screenRow.screen.note})` : ""}`;
      const esc = (s) => String(s ?? "").replace(/\|/g, "\\|");
      D.push(`| ${r.id} | ${esc(r.file)} | ${label(r.format)} | ${r.sizeKB} | ${r.open.status} | ${esc(r.open.detail)} | ${r.roundtrip.status}${r.roundtrip.diffs.length ? ": " + esc(r.roundtrip.diffs.join("; ")) : ""}${r.roundtrip.note && !/이미지·미디어/.test(r.roundtrip.note) ? ` (${esc(r.roundtrip.note)})` : ""} | ${r.edit.status}${r.edit.diffs.length ? ": " + esc(r.edit.diffs.join("; ")) : ""}${r.edit.extra && !/이미지·미디어/.test(r.edit.extra) ? ` (${esc(r.edit.extra)})` : ""} | ${esc(ss)} |`);
    }
    writeFileSync(join(CORPUS, "FIDELITY.md"), D.join("\n") + "\n");
    console.log("상세: test-corpus/FIDELITY.md (저장소 제외)");
  }
}

function causes(title, xs, get) {
  const m = new Map();
  for (const r of xs) for (const c of new Set(get(r).map(cause))) m.set(c, (m.get(c) ?? new Set()).add(r.set + r.id));
  const top = [...m].sort((a, b) => b[1].size - a[1].size).slice(0, 15);
  if (!top.length) return [`${title}: 없음`, ""];
  return [`**${title}**`, "", "| 원인 | 파일 수 | 형식 |", "|---|---|---|", ...top.map(([c, ids]) => `| ${c} | ${ids.size} | ${[...new Set(xs.filter((r) => ids.has(r.set + r.id)).map((r) => label(r.format)))].join(", ")} |`), ""];
}

// ───────── main ─────────

try {
  if (!EXTRA && (!only || only === "--node")) runNode();
  if (!only || only === "--screen") await runScreen();
  if (!EXTRA) buildReport();
  process.exit(0);
} catch (e) {
  console.error(e?.message ?? e);
  process.exit(1);
}
