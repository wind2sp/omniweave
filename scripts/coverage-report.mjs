#!/usr/bin/env node
// Feature-coverage report: docs/coverage/features.json → console table + docs/coverage/REPORT.md
//
//   node scripts/coverage-report.mjs              use the last saved test results (if any)
//   node scripts/coverage-report.mjs --run-tests  run tests/coverage first (vitest JSON reporter)
//
// Scoring (reproducible, no judgement inside this script):
//   current   = Σ weight·score / Σ weight,   score: 구현 1, 부분 0.5, 미구현 0
//   ceiling   = Σ weight of items whose feasibility ≠ "현실적으로 불가" / Σ weight
//   short     = 3-month target: capability groups ranked by efficiency (gain / cost-weeks) are
//               promoted to 구현 greedily until the week budget is spent (method.shortTermBudgetWeeks,
//               override with --budget N). Items in 현실적으로 불가 are never picked.
// A feature marked 구현 whose linked test fails is scored as 부분 (and flagged).

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEATURES = join(ROOT, "docs/coverage/features.json");
const RESULTS = join(ROOT, "docs/coverage/test-results.json");
const REPORT = join(ROOT, "docs/coverage/REPORT.md");

const SCORE = { 구현: 1, 부분: 0.5, 미구현: 0 };
const FEAS = ["구현됨", "가능-쉬움", "가능-중간", "가능-어려움", "현실적으로 불가"];
const SHORT = { "Adobe Photoshop": "PS", "Adobe Illustrator": "AI(Illustrator)", "Adobe Acrobat Pro": "Acrobat", "Microsoft Word": "Word", "한컴오피스 한글": "한글", "Microsoft PowerPoint": "PPT" };
const AI_CAT = "AI 생성";

// ───────── load & validate ─────────
const data = JSON.parse(readFileSync(FEATURES, "utf8"));
const features = data.features;
const COST = data.method.costWeeks ?? { "가능-쉬움": 1, "가능-중간": 3, "가능-어려움": 8 };
const problems = [];
const ids = new Set();
for (const f of features) {
  for (const k of ["id", "program", "category", "name", "weight", "status", "evidence", "feasibility"]) if (f[k] === undefined || f[k] === "") problems.push(`${f.id}: '${k}' 없음`);
  if (ids.has(f.id)) problems.push(`${f.id}: 중복 ID`);
  ids.add(f.id);
  if (!(f.status in SCORE)) problems.push(`${f.id}: 잘못된 status ${f.status}`);
  if (!FEAS.includes(f.feasibility)) problems.push(`${f.id}: 잘못된 feasibility ${f.feasibility}`);
  if (![1, 2, 3].includes(f.weight)) problems.push(`${f.id}: weight는 1~3`);
  if ((f.status === "구현") !== (f.feasibility === "구현됨")) problems.push(`${f.id}: 구현 ↔ 구현됨 불일치`);
  if (f.testId) {
    const [file, tag] = f.testId.split("#");
    const p = join(ROOT, file);
    if (!existsSync(p)) problems.push(`${f.id}: 테스트 파일 없음 ${file}`);
    else if (!readFileSync(p, "utf8").includes(`[${tag}]`)) problems.push(`${f.id}: ${file}에 [${tag}] 테스트 없음`);
  }
}

// ───────── test results ─────────
if (process.argv.includes("--run-tests")) {
  try {
    execSync(`npx vitest run tests/coverage --reporter=json --outputFile="${RESULTS}"`, { cwd: ROOT, stdio: "ignore" });
  } catch {
    /* failures are read from the JSON below */
  }
}
const testIndex = new Map(); // feature id → { pass, fail }
let testTotals = null;
if (existsSync(RESULTS)) {
  const r = JSON.parse(readFileSync(RESULTS, "utf8"));
  testTotals = { total: 0, passed: 0, failed: 0, files: r.testResults?.length ?? 0, at: r.startTime ? new Date(r.startTime).toISOString() : "" };
  for (const file of r.testResults ?? [])
    for (const a of file.assertionResults ?? []) {
      testTotals.total++;
      const ok = a.status === "passed";
      ok ? testTotals.passed++ : testTotals.failed++;
      for (const m of (a.title ?? "").matchAll(/\[([A-Z]{2}-[A-Z0-9]+)\]/g)) {
        const e = testIndex.get(m[1]) ?? { pass: 0, fail: 0 };
        ok ? e.pass++ : e.fail++;
        testIndex.set(m[1], e);
      }
    }
}
const effStatus = (f) => {
  const t = testIndex.get(f.id);
  if (f.status === "구현" && f.testId && t?.fail) return "부분";
  return f.status;
};
const score = (f) => SCORE[effStatus(f)];
// shortScore is defined after candidates() (it depends on the greedy plan)

// ───────── aggregate ─────────
function agg(list) {
  const W = list.reduce((a, f) => a + f.weight, 0) || 1;
  const sum = (fn) => list.reduce((a, f) => a + f.weight * fn(f), 0);
  const count = (st) => list.filter((f) => effStatus(f) === st).length;
  return {
    n: list.length,
    weight: W,
    implemented: count("구현"),
    partial: count("부분"),
    missing: count("미구현"),
    infeasible: list.filter((f) => f.feasibility === "현실적으로 불가").length,
    current: sum(score) / W,
    ceiling: sum((f) => (f.feasibility === "현실적으로 불가" ? 0 : 1)) / W,
    short: sum(shortScore) / W,
    mid: sum((f) => (f.feasibility === "가능-쉬움" || f.feasibility === "가능-중간" ? 1 : score(f))) / W,
    tested: list.filter((f) => f.testId).length,
  };
}
const programs = Object.keys(data.programs);
const byProgram = (p, ai) => features.filter((f) => f.program === p && (ai === undefined || (f.category === AI_CAT) === ai));

const pct = (x) => (x * 100).toFixed(1) + "%";

// ───────── candidates ─────────
function candidates() {
  const groups = new Map();
  for (const f of features) {
    if (effStatus(f) === "구현" || f.feasibility === "현실적으로 불가") continue;
    const key = f.capability ?? f.id;
    const g = groups.get(key) ?? { key, items: [], gain: 0, cost: 0 };
    g.items.push(f);
    g.gain += f.weight * (1 - score(f));
    g.cost = Math.max(g.cost, COST[f.feasibility]);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ ...g, eff: g.gain / g.cost, programs: [...new Set(g.items.map((f) => short(f.program)))] }))
    .sort((a, b) => b.eff - a.eff || b.gain - a.gain || a.key.localeCompare(b.key));
}
const argBudget = process.argv.indexOf("--budget");
const BUDGET = argBudget > 0 ? Number(process.argv[argBudget + 1]) : data.method.shortTermBudgetWeeks ?? 36;
const ranked = candidates();
const plan = [];
let spent = 0;
for (const c of ranked)
  if (spent + c.cost <= BUDGET) {
    plan.push(c);
    spent += c.cost;
  }
const planned = new Set(plan.flatMap((c) => c.items.map((f) => f.id)));
function shortScore(f) {
  return planned.has(f.id) ? 1 : score(f);
}
const capLabel = (key) => data.capabilities?.[key] ?? key;

function short(p) {
  return SHORT[p] ?? p;
}
const costLabel = (c) => (c <= COST["가능-쉬움"] ? "쉬움" : c <= COST["가능-중간"] ? "중간" : "어려움");

const rowsAll = programs.map((p) => ({ p, all: agg(byProgram(p)), core: agg(byProgram(p, false)), ai: agg(byProgram(p, true)) }));
const total = { all: agg(features), core: agg(features.filter((f) => f.category !== AI_CAT)), ai: agg(features.filter((f) => f.category === AI_CAT)) };

// ───────── console ─────────
const pad = (s, n) => {
  s = String(s);
  const w = [...s].reduce((a, ch) => a + (/[ᄀ-￿]/.test(ch) ? 2 : 1), 0);
  return s + " ".repeat(Math.max(0, n - w));
};
console.log("\nOmniweave 기능 커버리지 (가중치 반영)\n");
console.log(pad("프로그램", 26) + pad("항목", 6) + pad("구현/부분/미구현", 18) + pad("현재", 9) + pad("상한", 9) + pad("3개월", 9) + pad("쉬움·중간", 11) + "AI 제외 현재");
for (const r of [...rowsAll, { p: "전체", ...total }])
  console.log(
    pad(r.p, 26) + pad(r.all.n, 6) + pad(`${r.all.implemented}/${r.all.partial}/${r.all.missing}`, 18) + pad(pct(r.all.current), 9) + pad(pct(r.all.ceiling), 9) + pad(pct(r.all.short), 9) + pad(pct(r.all.mid), 11) + pct(r.core.current),
  );
if (testTotals) console.log(`\n테스트(tests/coverage): ${testTotals.passed}/${testTotals.total} 통과, 실패 ${testTotals.failed}`);
else console.log("\n테스트 결과 파일 없음 — --run-tests로 실행하면 반영됩니다");
const downgraded = features.filter((f) => effStatus(f) !== f.status);
if (downgraded.length) console.log("테스트 실패로 '부분'으로 낮춘 항목: " + downgraded.map((f) => f.id).join(", "));
if (problems.length) {
  console.log("\n검증 문제 " + problems.length + "건:");
  problems.forEach((p) => console.log("  - " + p));
}

// ───────── REPORT.md ─────────
const md = [];
const line = (s = "") => md.push(s);
line("# 기능 커버리지 리포트 — Omniweave vs 6개 프로그램 최신판");
line();
line(`> 자동 생성: \`node scripts/coverage-report.mjs\` (원본: \`docs/coverage/features.json\`, ${features.length}개 항목). 손으로 고치지 말고 features.json을 고친 뒤 다시 생성하세요.`);
line();
line("비교 기준 버전:");
for (const [p, v] of Object.entries(data.programs)) line(`- **${p}** — ${v}`);
line();
line("## 1. 요약");
line();
line("| 프로그램 | 항목 | 구현 / 부분 / 미구현 | **현재 구현률** | 3개월 목표 | 쉬움·중간까지 | 구현 가능 상한 | 현재 (AI 제외) |");
line("|---|---:|---:|---:|---:|---:|---:|---:|");
for (const r of [...rowsAll, { p: "**전체**", ...total }])
  line(`| ${r.p} | ${r.all.n} | ${r.all.implemented} / ${r.all.partial} / ${r.all.missing} | **${pct(r.all.current)}** | ${pct(r.all.short)} | ${pct(r.all.mid)} | ${pct(r.all.ceiling)} | ${pct(r.core.current)} |`);
line();
line("- 구현률 = Σ(가중치 × 점수) / Σ가중치, 점수: 구현 1 · 부분 0.5 · 미구현 0. 가중치: 핵심 3 · 일반 2 · 고급 1.");
line("- 구현 가능 상한 = '현실적으로 불가'가 아닌 항목의 가중치 비율 (지금 구현된 것 포함). 비AI 기능은 거의 전부 원리상 가능하므로 상한은 높게 나옵니다.");
line("- 쉬움·중간까지 = '가능-어려움'(PSD·HWP 이진·디지털 서명·모핑 등 대작업)을 빼고 쉬움·중간만 모두 끝냈을 때의 값 — 1년 안팎의 현실적 중기 상한으로 읽으세요.");
line(`- 3개월 목표 = ${data.method.shortTermRule}. 이번 계산: 예산 ${BUDGET}주 중 ${spent}주 사용, ${plan.length}개 묶음(${planned.size}개 항목) 선택 — 목록은 3장의 ★ 표시.`);
line(`- AI 생성 기능(${total.ai.n}개)만 따로 보면: 현재 ${pct(total.ai.current)}, 상한 ${pct(total.ai.ceiling)} (불가 ${total.ai.infeasible}개).`);
line();
line("### 판정 근거와 검증");
line();
const manual = features.filter((f) => f.verify === "manual").length;
line(`- '구현' ${total.all.implemented}개 중 **${features.filter((f) => f.status === "구현" && f.testId).length}개는 vitest로 자동 검증**(\`tests/coverage/*.test.ts\`, 테스트 제목에 기능 ID), 나머지는 브라우저가 필요해 '수동 검증' 절차를 note에 적었습니다. 테스트가 연결된 부분 항목까지 합치면 ${total.all.tested}개 항목에 테스트가 있습니다. 수동 검증 표시 ${manual}개.`);
if (testTotals) line(`- 최근 테스트 실행(${testTotals.at || "시각 미상"}): **${testTotals.passed}/${testTotals.total} 통과**, 실패 ${testTotals.failed}. ${downgraded.length ? "실패로 낮춘 항목: " + downgraded.map((f) => f.id).join(", ") : "테스트 실패로 등급을 낮춘 항목 없음."}`);
else line("- 테스트 결과 파일이 없어 테스트 반영 없이 계산했습니다 (`--run-tests`).");
if (problems.length) line(`- ⚠ features.json 검증 문제 ${problems.length}건: ${problems.slice(0, 10).join("; ")}`);
line();
line("## 2. 프로그램별 상위 결손 기능 (가중치 높은 미구현 Top 15)");
line();
line("정렬: 가중치 ↓, 같은 가중치는 쉬운 것 먼저. '불가'도 숨기지 않고 표시합니다.");
for (const p of programs) {
  const list = byProgram(p)
    .filter((f) => effStatus(f) === "미구현")
    .sort((a, b) => b.weight - a.weight || FEAS.indexOf(a.feasibility) - FEAS.indexOf(b.feasibility) || a.id.localeCompare(b.id))
    .slice(0, 15);
  line();
  line(`### ${p}`);
  line();
  line("| ID | 분류 | 기능 | 가중치 | 구현 가능성 | 메모 |");
  line("|---|---|---|---:|---|---|");
  for (const f of list) line(`| ${f.id} | ${f.category} | ${f.name} | ${f.weight} | ${f.feasibility} | ${(f.note || "").replace(/\|/g, "/")} |`);
}
line();
line("## 3. 다음 구현 후보 20 (효율 = 얻는 가중 점수 / 난이도 비용)");
line();
line("같은 능력(capability)이 여러 프로그램에 걸치면 하나로 묶어 합산합니다 — 예: '인쇄'는 Word·한글·Acrobat·PPT·PS 항목을 한 번에 올립니다. 비용: 쉬움 1 · 중간 3 · 어려움 8 (묶음 안에서 가장 어려운 항목 기준). 얻는 점수 = Σ 가중치 × (1 − 현재 점수).");
line();
line("| 순위 | 능력 | 대상 프로그램 | 포함 항목 | 얻는 점수 | 난이도 | 효율 | 3개월 |");
line("|---:|---|---|---|---:|---|---:|:---:|");
ranked.slice(0, 20).forEach((c, i) => {
  const label = c.items.length === 1 && !c.items[0].capability ? `${c.items[0].name}` : capLabel(c.key);
  line(`| ${i + 1} | ${label} | ${c.programs.join(", ")} | ${c.items.map((f) => f.id).join(" ")} | ${c.gain.toFixed(1)} | ${costLabel(c.cost)} | ${c.eff.toFixed(2)} | ${plan.includes(c) ? "★" : ""} |`);
});
const beyond = plan.filter((c) => ranked.indexOf(c) >= 20);
if (beyond.length) {
  line();
  line(`3개월 예산에 포함되는 21위 이하 묶음: ${beyond.map((c) => (c.items.length === 1 && !c.items[0].capability ? c.items[0].name : capLabel(c.key))).join(", ")}.`);
}
line();
line("## 4. 정직한 해석");
line();
line("**이 수치가 의미하는 것**");
line();
line("- 각 프로그램에서 사용자가 실제로 찾는 기능 목록(프로그램당 60~100여 개, 사용 빈도 가중)에 대해, 지금 코드가 그 기능을 *제공하는지*의 비율입니다. 판정은 코드를 직접 읽고(근거 파일·함수 기재), Node에서 돌릴 수 있는 것은 테스트로 확인했습니다.");
line("- '구현 가능 상한'은 웹 기술 + Tauri/Rust + Canvas2D→WebGPU 로드맵 안에서 원리적으로 막힌 것(독점 포맷·대형 생성 모델·독점 런타임)을 뺀 천장입니다. 상한과 현재의 차이는 '시간과 인력' 문제이지 아키텍처 문제가 아니라는 뜻입니다.");
line("- 프로그램 간 비교 순서(어느 쪽에 가까운지)는 꽤 믿을 만합니다: 같은 기준과 같은 사람이 판정했습니다.");
line();
line("**이 수치가 의미하지 않는 것**");
line();
line("- *품질·충실도가 아닙니다.* '구현'은 기능이 동작한다는 뜻이지 원본 프로그램만큼 정교하다는 뜻이 아닙니다. 예: 브러시는 '구현'이지만 브러시 엔진 깊이는 Photoshop과 비교할 수 없습니다. 패스파인더는 곡선을 다각형으로 근사하므로 '부분'으로 낮췄습니다.");
line("- *파일 호환률이 아닙니다.* DOCX/HWPX 열기는 '부분'(0.5점)이지만 실제 문서는 표·그림·머리말을 거의 항상 포함하므로, 실사용 문서를 열었을 때 '그대로 보이는' 비율은 이 수치보다 훨씬 낮습니다.");
line("- *기능 목록 자체가 표본입니다.* 각 프로그램의 전체 기능은 수백~수천 개이고, 여기서는 사용자가 자주 쓰는 기능 위주로 골랐습니다. 목록 구성과 가중치에 따라 수치는 ±5%p 정도 움직일 수 있습니다.");
line(`- *난이도와 3개월 목표는 추정입니다.* 쉬움 1주·중간 3주·어려움 8주, 3명×12주라는 가정으로 기계적으로 배분한 값이며 인력 계획이 아닙니다. 특히 '글자·문단 단위 서식'처럼 묶음 하나가 실제로는 3주를 크게 넘을 수 있습니다. 예산을 바꿔 보려면 \`node scripts/coverage-report.mjs --budget 24\`.`);
line("- *AI 생성 기능의 '불가'는 '로컬·오픈소스·무료' 전제의 판정입니다.* 외부 생성형 API를 연동하면 기술적으로는 붙일 수 있지만, 비용·개인정보·라이선스 때문에 기본 기능으로 계산하지 않았습니다.");
line();
line("## 5. 수동 검증이 필요한 '구현' 항목");
line();
line("브라우저(Canvas·포인터·IndexedDB·전체 화면)가 필요해 Node 테스트로 확인할 수 없는 항목입니다. `npm run dev` 후 아래 절차로 확인하세요.");
line();
line("| ID | 기능 | 절차 |");
line("|---|---|---|");
for (const f of features.filter((f) => f.status === "구현" && !f.testId)) line(`| ${f.id} | ${f.name} | ${(f.note || "").replace(/^수동 검증:?\s*/, "").replace(/\|/g, "/") || "해당 기능을 화면에서 직접 실행"} |`);
line();

writeFileSync(REPORT, md.join("\n"));
console.log(`\nREPORT: ${REPORT.replace(ROOT, ".")}`);
if (problems.length) process.exitCode = 1;
