// node scripts/fidelity-pptx.mjs [--out <dir>] [--headed] [--only <name part>] [--port <n>] [--no-com] [--corpus <dir>]
//                                [--deck-timeout <minutes, default 10>]  one deck without progress this long is recorded
//                                as "시간 초과" and a new browser goes on with the rest (no limit on the whole run)
// PowerPoint fidelity (docs/design/FIDELITY_PPTX.md): every .pptx/.ppt with a PowerPoint-printed "<deck>.ref.pdf" in
// qa/interop/adobe-made (and test-corpus/, named "corpus #n" only) is opened in a headless Edge/Chrome through vite and
// compared slide by slide with tests/fidelity/pptxScreen.ts. Writes <out>/pptx-fidelity.json and one PNG per slide
// (PowerPoint | Omniweave). <out> defaults to node_modules/.cache/omniweave-fidelity/pptx (outside the repository).
// 한 곳 편집 보존 (tests/fidelity/pptxEdit.ts): every .pptx edited in one place (a character, a shape moved, a slide
// added) and saved before (written anew) / after (into the original package); on Windows PowerPoint (COM, no window,
// qa/interop/scripts/pptx_surgeon_check.ps1) then opens the originals and every saved file and counts animations,
// media and notes. --no-com skips that check.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = resolve(opt("--out") ?? join(ROOT, "node_modules/.cache/omniweave-fidelity/pptx"));
const ONLY = opt("--only");
const PORT = Number(opt("--port") ?? 5206);

const items = [];
const add = (dir, id) => {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f);
    if (!statSync(p).isFile() || !/\.pptx?$/i.test(f) || /encrypted/i.test(f) || !existsSync(p + ".ref.pdf")) continue;
    items.push({ key: `k${items.length}`, id: id(f), path: p, ref: p + ".ref.pdf" });
  }
};
add(join(ROOT, "qa/interop/adobe-made"), (f) => f);
// legacy PPT decks with PowerPoint's own PDF (qa/interop/scripts/ppt_ref_make.ps1): opened with their formatting (pptRich.ts)
add(join(ROOT, "qa/interop/powerpoint-made"), (f) => f);
const CORPUS = opt("--corpus") ? resolve(opt("--corpus")) : join(ROOT, "test-corpus");
if (existsSync(CORPUS)) {
  let n = 0;
  const walk = (d) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      // a corpus deck without a reference PDF: only its saves are measured (한 곳 편집 보존)
      else if (/\.pptx$/i.test(f)) items.push({ key: `k${items.length}`, id: `corpus#${++n}`, path: p, ref: existsSync(p + ".ref.pdf") ? p + ".ref.pdf" : null });
    }
  };
  walk(CORPUS);
}
const list = items.filter((it) => !ONLY || it.id.includes(ONLY));
const byKey = new Map(list.flatMap((it) => [[it.key, it.path], ...(it.ref ? [[`ref:${it.key}`, it.ref]] : [])]));

function findBrowser() {
  return [
    process.env.FIDELITY_BROWSER,
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ]
    .filter(Boolean)
    .find((p) => existsSync(p));
}

const body = (req) =>
  new Promise((res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => res(Buffer.concat(chunks)));
  });

async function main() {
  spawnSync(process.execPath, ["scripts/copy-pdfjs-assets.mjs"], { stdio: "inherit", windowsHide: true });
  mkdirSync(OUT, { recursive: true });
  const rows = [];
  const t0 = Date.now();
  // one browser run at a time; a run ends when the page says done or when a deck makes no progress for DECK_MIN
  // minutes — then only that deck is recorded as timed out and a new browser continues with the remaining decks
  // (before 2026-11-16 one 15-minute limit covered the whole run, so under load not one deck was written)
  const measured = new Set();
  let current = null;
  let beat = Date.now();
  let finish = () => {};
  const plugin = {
    name: "omniweave-pptx-fidelity",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url, "http://x");
        if (!url.pathname.startsWith("/__pptx/")) return next();
        const what = url.pathname.slice(8);
        if (what === "list") return res.end(JSON.stringify(list.filter((it) => !measured.has(it.key)).map((it) => ({ key: it.key, id: it.id, name: basename(it.path), ref: it.ref ? `ref:${it.key}` : null }))));
        if (what === "start") {
          current = url.searchParams.get("key");
          beat = Date.now();
          return res.end("ok");
        }
        if (what === "file") {
          const p = byKey.get(url.searchParams.get("key"));
          if (!p) return (res.statusCode = 404), res.end();
          return res.end(readFileSync(p));
        }
        if (what === "save") {
          mkdirSync(join(OUT, "edits"), { recursive: true });
          writeFileSync(join(OUT, "edits", url.searchParams.get("name").replace(/[^\w.#-]+/g, "_")), await body(req));
          return res.end("ok");
        }
        if (what === "pair") {
          writeFileSync(join(OUT, `${url.searchParams.get("name").replace(/[^\w.#-]+/g, "_")}.png`), await body(req));
          return res.end("ok");
        }
        if (what === "row") {
          const row = JSON.parse((await body(req)).toString("utf8"));
          if (!measured.has(row.key)) rows.push(row);
          measured.add(row.key);
          beat = Date.now();
          process.stdout.write(".");
          return res.end("ok");
        }
        if (what === "done") {
          const msg = (await body(req)).toString("utf8");
          if (msg) console.error("\n브라우저 오류:", msg);
          res.end("ok");
          return finish("done");
        }
        next();
      });
    },
  };
  const { createServer } = await import("vite");
  // its own dependency cache: a second dev server of the same checkout (npm run fidelity on 5205, another measurement)
  // re-optimizing node_modules/.vite/deps answered this page's module requests with "504 Outdated Optimize Dep" and
  // the page never started — the cause of "15분 안에 한 덱도 못 끝냄" under load (2026-11-15 PROGRESS)
  const server = await createServer({ cacheDir: join(ROOT, "node_modules/.vite-fidelity-pptx"), server: { port: PORT, strictPort: true, host: "127.0.0.1", open: false, hmr: false, watch: { ignored: ["**/*"] } }, plugins: [plugin], logLevel: "warn", clearScreen: false });
  await server.listen();
  const exe = findBrowser();
  if (!exe) throw new Error("Edge/Chrome을 찾지 못했습니다 (FIDELITY_BROWSER)");
  const DECK_MIN = Number(opt("--deck-timeout") ?? process.env.FIDELITY_DECK_TIMEOUT ?? 10);
  const profiles = [];
  for (let run = 1, idle = 0; measured.size < list.length; run++) {
    const profile = join(tmpdir(), `omniweave-pptxfid-${process.pid}-${run}`);
    const flags = [...(argv.includes("--headed") ? [] : ["--headless=new"]), "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--window-size=1400,1000", "--force-device-scale-factor=1", `--user-data-dir=${profile}`, `http://127.0.0.1:${PORT}/qa/fidelity/pptx.html`];
    const before = measured.size;
    current = null;
    beat = Date.now();
    const browser = spawn(exe, flags, { stdio: "ignore", windowsHide: true });
    const how = await new Promise((res) => {
      const watch = setInterval(() => Date.now() - beat > DECK_MIN * 60_000 && finish("stuck"), 5_000);
      finish = (x) => (clearInterval(watch), res(x));
    });
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      const ps = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps], { stdio: "ignore", windowsHide: true });
    } else browser.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 800));
    profiles.push(profile);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {}
    if (how === "stuck") {
      const it = list.find((x) => x.key === current && !measured.has(x.key));
      if (it) {
        console.error(`\n${it.id}: ${DECK_MIN}분 동안 끝나지 않아 이 덱만 시간 초과로 적고 새 브라우저로 이어 갑니다`);
        rows.push({ key: it.key, id: it.id, error: `시간 초과(${DECK_MIN}분)`, timeout: true, slides: [] });
        measured.add(it.key);
      } else console.error(`\n브라우저 실행 ${run}: 측정 페이지가 ${DECK_MIN}분 안에 시작하지 못함`);
    }
    // a run that measured nothing and did not hang on a deck (page failed to load twice, browser gone): stop
    idle = measured.size === before ? idle + 1 : 0;
    if (idle >= 2 || (how === "done" && measured.size === before)) {
      console.error(`\n남은 덱 ${list.length - measured.size}개를 재지 못하고 멈춤`);
      break;
    }
  }
  await server.close();
  // QA 2026-11-16: a profile of a browser killed while starting can still be locked right after the kill — try again
  // once every run is over (before, the stuck run's %TEMP% profile stayed behind)
  for (const p of profiles)
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch {}
  const browserMin = (Date.now() - t0) / 60_000;
  // PowerPoint opens the originals and the edited saves (Windows, COM without a window)
  const com = new Map();
  const editDir = join(OUT, "edits");
  if (process.platform === "win32" && !argv.includes("--no-com") && existsSync(editDir)) {
    const targets = [...list.filter((it) => /\.pptx$/i.test(it.path)).map((it) => it.path), ...readdirSync(editDir).filter((f) => f.endsWith(".pptx")).map((f) => join(editDir, f))];
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(ROOT, "qa/interop/scripts/pptx_surgeon_check.ps1"), ...targets], { encoding: "utf8", windowsHide: true, timeout: 20 * 60_000 });
    for (const line of (r.stdout ?? "").split(/\r?\n/)) {
      const m = /^(OK|FAIL)\t([^\t]+)\t?(.*)$/.exec(line.trim());
      if (m) com.set(m[2], m[1] === "OK" ? Object.fromEntries([...m[3].matchAll(/(\w+)=(\d+)/g)].map((x) => [x[1], Number(x[2])])) : { fail: m[3] });
    }
  }
  for (const r of rows) for (const e of r.edits ?? []) for (const k of ["before", "after"]) if (e[k]) e[k].powerpoint = com.get(`${r.id}-${e.scenario}-${k}.pptx`.replace(/[^\w.#-]+/g, "_")) ?? null;
  const totalMin = (Date.now() - t0) / 60_000;
  writeFileSync(join(OUT, "pptx-fidelity.json"), JSON.stringify({ when: new Date().toISOString(), minutes: { browser: +browserMin.toFixed(2), total: +totalMin.toFixed(2) }, rows, powerpoint: Object.fromEntries(com) }, null, 1));
  console.log(`\n측정 시간: 브라우저 ${browserMin.toFixed(1)}분 · 전체 ${totalMin.toFixed(1)}분 · 덱별 ${rows.map((r) => `${r.id} ${r.timeout ? "시간 초과" : ((r.ms ?? 0) / 1000).toFixed(0) + "초"}`).join(", ")}`);
  // summary table (stdout): per deck and slide
  const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "-");
  console.log("\n| 덱 | 슬라이드 | SSIM | 다른 영역 | 줄 일치 | |Δx| pt | |Δy| pt | 못 맞춘 줄(앞부분) |");
  console.log("|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    if (r.error) console.log(`| ${r.id} | - | 오류: ${r.error} |`);
    for (const s of r.slides) console.log(`| ${r.id} | ${s.slide} | ${f(s.ssim, 4)} | ${f(s.badShare * 100, 1)}% | ${s.sameBreak}/${s.refLines} | ${f(s.dx, 1)} | ${f(s.dy, 1)} | ${s.missing.slice(0, 2).join(" / ")} |`);
    const sl = r.slides;
    if (sl.length) {
      const mean = (k) => sl.reduce((a, s) => a + s[k], 0) / sl.length;
      const lines = sl.reduce((a, s) => a + s.refLines, 0), same = sl.reduce((a, s) => a + s.sameBreak, 0);
      const w = (k) => sl.reduce((a, s) => a + s[k] * s.sameBreak, 0) / Math.max(1, same);
      console.log(`| **${r.id}** | 평균 | **${f(mean("ssim"), 4)}** | ${f(mean("badShare") * 100, 1)}% | **${same}/${lines} (${f((same / Math.max(1, lines)) * 100, 1)}%)** | ${f(w("dx"), 1)} | ${f(w("dy"), 1)} | 무편집 저장 원본 보존: ${r.preserved ? "예" : "아니오"} |`);
    }
  }
  // 한 곳 편집 보존: before → after per deck
  const eds = rows.filter((r) => r.edits?.length);
  if (eds.length) {
    console.log("\n| 덱 | 편집 | 전: 보존 | 후: 보존 | 후: 원본 그대로인 부품 | PowerPoint 열기(후) | 애니메이션·미디어·노트·그룹·레이아웃 (원본 → 전 → 후) | 남은 차이(후) |");
    console.log("|---|---|---|---|---|---|---|---|");
    const pp = (x) => (!x ? "-" : x.fail ? "실패" : `${x.anim}·${x.media}·${x.notes}·${x.groups}·${x.layouts}`);
    let nb = 0, na = 0, n = 0;
    for (const r of eds) {
      const orig = com.get(basename(list.find((it) => it.id === r.id)?.path ?? ""));
      for (const e of r.edits) {
        if (e.skipped || e.error) {
          console.log(`| ${r.id} | ${e.scenario} | ${e.error ? "오류: " + e.error : "해당 없음"} |`);
          continue;
        }
        n++;
        nb += e.before.kept ? 1 : 0;
        na += e.after.kept ? 1 : 0;
        const a = e.after.powerpoint;
        console.log(`| ${r.id} | ${e.scenario} (${e.where}) | ${e.before.kept ? "예" : "아니오"} | ${e.after.kept ? "**예**" : "아니오"} | ${e.after.same} | ${!a ? "-" : a.fail ? "실패 " + a.fail : "OK"} | ${pp(orig)} → ${pp(e.before.powerpoint)} → ${pp(a)} | ${e.after.diffs.join(", ") || "-"} |`);
      }
    }
    console.log(`\n한 곳 편집 보존: 전 ${nb}/${n} → 후 ${na}/${n}`);
  }
  console.log(`\n그림·JSON: ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
