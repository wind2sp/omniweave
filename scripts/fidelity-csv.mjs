// node scripts/fidelity-csv.mjs [--out <dir>] [--corpus <dir>] [--no-excel] [--remake]
// CSV ① 열기 충실도 (docs/qa/parity/SCORE.md '가장 아픈 10개' 9번 — 측정 공백, VIEWER_GOAL CSV 줄):
//   정답 = Excel이 같은 CSV를 열었을 때의 칸 값(qa/interop/scripts/csv_make.ps1).
//   저장소 자료 qa/interop/csv/omni-csv-*.csv의 정답(.excel.json)은 저장소에 있고(--remake = Excel로 다시 만들기),
//   corpus CSV의 정답은 그때그때 Excel로 만들어 <out>/truth/에만 둔다(저장소에 넣지 않음).
//   비교: tests/fidelity/csvOpen.test.ts → <out>/csv-open.json, 요약 qa/fidelity/CSV_OPEN.md(corpus는 'corpus #n'과 숫자만)
// <out> 기본값: node_modules/.cache/omniweave-fidelity/csv

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = resolve(opt("--out") ?? join(ROOT, "node_modules/.cache/omniweave-fidelity/csv"));
const CORPUS = resolve(opt("--corpus") ?? join(ROOT, "test-corpus"));
const excelOk = process.platform === "win32" && !argv.includes("--no-excel");
mkdirSync(OUT, { recursive: true });
const ps = (args) => spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(ROOT, "qa/interop/scripts/csv_make.ps1"), ...args], { encoding: "utf8", windowsHide: true, timeout: 20 * 60_000 });

if (argv.includes("--remake") && excelOk) {
  console.log("▶ 저장소 CSV 자료·Excel 정답 다시 만들기 (csv_make.ps1)");
  const r = ps([]);
  process.stdout.write(r.stdout ?? "");
  if (r.status !== 0) throw new Error("csv_make.ps1 실패: " + (r.stderr ?? "").slice(0, 400));
}

const corpus = [];
const walk = (d) => {
  if (!existsSync(d)) return;
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.csv$/i.test(f)) corpus.push(p);
  }
};
walk(CORPUS);
const truthDir = join(OUT, "truth");
if (corpus.length && excelOk) {
  console.log(`▶ corpus CSV ${corpus.length}개의 Excel 정답 (로컬 ${truthDir})`);
  const r = ps(["-Truth", ...corpus, "-TruthOut", truthDir]);
  if (r.status !== 0) console.error("corpus 정답 실패:", (r.stderr ?? "").slice(0, 400));
}
writeFileSync(join(OUT, "corpus.json"), JSON.stringify(corpus.map((p, i) => ({ path: p, truth: join(truthDir, `${i + 1}.excel.json`) }))));

console.log("▶ 오메로 열어 비교 (vitest tests/fidelity/csvOpen.test.ts)");
const v = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/fidelity/csvOpen.test.ts"], { stdio: "inherit", windowsHide: true, env: { ...process.env, OMNIWEAVE_CSV_MEASURE: OUT, OMNIWEAVE_CSV_CORPUS: join(OUT, "corpus.json") } });
if (v.status !== 0) throw new Error("비교 실패");
const res = JSON.parse(readFileSync(join(OUT, "csv-open.json"), "utf8"));

const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "-");
const measured = res.rows.filter((r) => r.cells);
const tot = measured.reduce((a, r) => ({ total: a.total + r.cells.total, same: a.same + r.cells.same, value: a.value + r.cells.value, shown: a.shown + r.cells.shown }), { total: 0, same: 0, value: 0, shown: 0 });
const why = {};
for (const r of measured) for (const [k, n] of Object.entries(r.cells.why)) why[k] = (why[k] ?? 0) + n;
const shownOnly = {};
for (const r of measured) for (const [k, n] of Object.entries(r.cells.shownOnly ?? {})) shownOnly[k] = (shownOnly[k] ?? 0) + n;
const un = res.rows.filter((r) => r.unchanged);
const ed = res.rows.filter((r) => r.edit && r.edit.status !== "해당 없음");
const L = [];
L.push("# CSV ① 열기 충실도 — Excel과 같은 칸 값 (측정 공백 9번)");
L.push("");
L.push(`측정: ${new Date().toISOString().slice(0, 10)} · \`node scripts/fidelity-csv.mjs\` · 정답: Excel이 같은 CSV를 연 칸 값(\`qa/interop/scripts/csv_make.ps1\`, 저장소 자료는 \`qa/interop/csv/*.excel.json\`)`);
L.push("");
L.push("판정: 칸마다 **같음** = 값 같음 또는 표시 같음(① 숫자) · **값 같음** = Excel의 칸 값(Value2)과 오메가 보여 주는 칸 글이 같은 값(숫자는 쉼표·% 빼고 같은 수, 참거짓·빈 칸 포함) · **표시 같음** = Excel이 보여 주는 글(Text)과 글자까지 같음. 정답은 Excel이 내용을 바르게 읽은 값입니다(BOM 없는 UTF-8은 BOM을 붙이고, 쉼표가 아닌 구분자는 `sep=` 줄로 알린 사본). 사람이 두 번 눌러 연 그대로의 Excel 값은 'Excel 두 번 눌러 열기' 열에 따로 적습니다.");
L.push("");
L.push(`## 요약 — ① Excel과 같은 칸 **${tot.same}/${tot.total} (${pct(tot.same, tot.total)})** · 값 같음 ${tot.value}/${tot.total} · 표시 같음 ${tot.shown}/${tot.total} (${pct(tot.shown, tot.total)}) · 무편집 저장 바이트 동일 ${un.filter((r) => r.unchanged === "바이트 동일").length}/${un.length} · 한 칸 편집 뒤 나머지 줄 보존 ${ed.filter((r) => r.edit.status === "보존").length}/${ed.length}`);
L.push("");
L.push("| 파일 | 인코딩·구분자 | 행×열 (오메 / Excel) | ① 같음 | 값 같음 | 표시 같음 | Excel 두 번 눌러 열기(바른 값과 같은 칸) | 무편집 저장 | 한 칸 편집 |");
L.push("|---|---|---|---|---|---|---|---|---|");
for (const r of res.rows) {
  if (r.error) {
    L.push(`| ${r.id} | - | - | ${r.error} | - | - | - | - | - |`);
    continue;
  }
  const c = r.cells;
  L.push(`| ${r.id} | ${r.encoding ? `${r.encoding} · \`${r.delimiter === "\t" ? "탭" : r.delimiter}\`` : "정답 없음"} | ${r.rows}×${r.cols} / ${c ? `${r.excelRows}×${r.excelCols}` : "-"} | ${c ? `**${c.same}/${c.total}** (${pct(c.same, c.total)})` : "-"} | ${c ? `${c.value}/${c.total}` : "-"} | ${c ? `${c.shown}/${c.total}` : "-"} | ${r.doubleClick ? `${r.doubleClick.same}/${r.doubleClick.total}` : "-"} | ${r.unchanged}${r.unchangedDiffs?.length ? ` (${r.unchangedDiffs.join("; ")})` : ""} | ${r.edit.status}${r.edit.diffs.length ? ` (${r.edit.diffs.join("; ")})` : ""} |`);
}
L.push("");
if (Object.keys(why).length) {
  L.push("### Excel과 다른 칸 (칸 수)");
  L.push("");
  for (const [k, n] of Object.entries(why).sort((a, b) => b[1] - a[1])) L.push(`- ${k}: ${n}`);
  L.push("");
}
if (Object.keys(shownOnly).length) {
  L.push("### 값은 같고 보이는 글만 다른 칸 (칸 수 — ①에서는 같음으로 셈, 오메는 파일의 글을 그대로 보여 줌)");
  L.push("");
  for (const [k, n] of Object.entries(shownOnly).sort((a, b) => b[1] - a[1])) L.push(`- ${k}: ${n}`);
  L.push("");
}
const corp = res.rows.filter((r) => r.set === "corpus");
L.push(`corpus CSV ${corp.length}개는 이름 대신 'corpus #n'으로만 적고, 정답(Excel 값)은 저장소 밖 \`${OUT.replace(ROOT, ".").replace(/\\/g, "/")}/truth/\`에만 둡니다.`);
L.push("");
writeFileSync(join(ROOT, "qa/fidelity/CSV_OPEN.md"), L.join("\n").replace(/\n/g, "\r\n"));
console.log(L.join("\n"));
