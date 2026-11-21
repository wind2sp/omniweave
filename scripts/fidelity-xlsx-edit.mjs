// node scripts/fidelity-xlsx-edit.mjs [--out <dir>] [--no-excel] [--corpus <dir>]
// Excel 한 곳 편집 측정 (docs/qa/parity/SCORE.md '가장 아픈 10개' 9번 — 측정 공백):
//   1. vitest tests/fidelity/xlsxEdit.test.ts — 저장소의 모든 XLSX 시험 자료(qa/**, 공개 견본)와 corpus XLSX를 시트로 열어
//      칸 하나를 세 가지로 고쳐(글자 칸 끝에 "~", 숫자 칸 +1, 수식 f → (f)+1) 저장하고, 원본과 파트·행 단위로 비교
//   2. qa/interop/scripts/xlsx_edit_check.ps1 — Excel(새 인스턴스, 창 없음)이 저장본을 복구 없이 여는지, 고친 칸과 다시
//      계산된 칸을 같은 값으로 보는지(열린 그대로·CalculateFull 뒤). 복구 판정이 실제로 잡히는지 깨뜨린 대조 파일로 확인
//   3. 요약 표(stdout)와 qa/fidelity/XLSX_EDIT.md(저장소 자료는 파일별, corpus는 'corpus #n'과 집계만)
// <out> 기본값: node_modules/.cache/omniweave-fidelity/xlsx-edit (저장소 밖 — corpus 저장본이 들어감)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { excelControlsCaught, xlsxEditKept } from "./fidelity-verdict.mjs";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const opt = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : undefined);
const OUT = resolve(opt("--out") ?? join(ROOT, "node_modules/.cache/omniweave-fidelity/xlsx-edit"));

rmSync(join(OUT, "files"), { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
console.log("▶ 1. 오메: 칸 하나 고쳐 저장 (vitest tests/fidelity/xlsxEdit.test.ts)");
const v = spawnSync(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/fidelity/xlsxEdit.test.ts"], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, OMNIWEAVE_XLSX_EDIT: OUT, ...(opt("--corpus") ? { FIDELITY_CORPUS: resolve(opt("--corpus")) } : {}) },
});
if (v.status !== 0) throw new Error("오메 쪽 측정 실패");
const node = JSON.parse(readFileSync(join(OUT, "xlsx-edit-node.json"), "utf8"));
const manifest = JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));

// control: an edited file broken on purpose (a cell outside its row) — Excel must report a repair, else the check is blind
const firstEdit = manifest.find((m) => m.kind === "text");
if (firstEdit) {
  const z = unzipSync(readFileSync(firstEdit.file));
  const sheet = Object.keys(z).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  z[sheet] = strToU8(strFromU8(z[sheet]).replace(/<sheetData>/, '<sheetData><row r="0"><c r="ZZZ0" t="x"><v>?</v></c></row>'));
  const broken = join(OUT, "files", "control-broken.xlsx");
  writeFileSync(broken, zipSync(z));
  manifest.push({ file: broken, sheet: "", addr: "", kind: "control", expect: null, deps: [] });
  // a repairable one: overlapping merged ranges (Excel: "일부 내용에 문제가 있습니다" → 복구)
  const z2 = unzipSync(readFileSync(firstEdit.file));
  const s2 = Object.keys(z2).find((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k) && !strFromU8(z2[k]).includes("<mergeCells"));
  if (s2) {
    z2[s2] = strToU8(strFromU8(z2[s2]).replace(/<\/sheetData>/, '</sheetData><mergeCells count="2"><mergeCell ref="A1:B2"/><mergeCell ref="B2:C3"/></mergeCells>'));
    const rep = join(OUT, "files", "control-repair.xlsx");
    writeFileSync(rep, zipSync(z2));
    manifest.push({ file: rep, sheet: "", addr: "", kind: "control", expect: null, deps: [] });
  }
}
const verdict = (c) => (!c ? "-" : c.open === "ok" ? "**못 잡음(확인기 무효)**" : c.open === "repaired" ? "복구 잡음" : "열기 실패 잡음");

const excel = new Map();
const excelRan = process.platform === "win32" && !argv.includes("--no-excel");
if (excelRan) {
  console.log(`▶ 2. Excel 확인: ${manifest.length}개 파일 (새 인스턴스, 창 없음)`);
  writeFileSync(join(OUT, "manifest-excel.json"), JSON.stringify(manifest));
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", join(ROOT, "qa/interop/scripts/xlsx_edit_check.ps1"), "-Manifest", join(OUT, "manifest-excel.json"), "-Out", join(OUT, "excel.json")], { encoding: "utf8", windowsHide: true, timeout: 30 * 60_000 });
  if (r.status !== 0) console.error("Excel 확인 오류:", (r.stderr || r.stdout || "").slice(0, 600));
  if (existsSync(join(OUT, "excel.json"))) for (const x of JSON.parse(readFileSync(join(OUT, "excel.json"), "utf8").replace(/^﻿/, ""))) excel.set(resolve(x.file), x);
}
const ex = (f) => (f ? excel.get(resolve(f)) : undefined);
const control = ex(join(OUT, "files", "control-broken.xlsx"));
const control2 = ex(join(OUT, "files", "control-repair.xlsx"));
// QA 2026-11-16: with the Excel check on, an edit without an Excel result, or a checker that let a deliberately broken
// control file open "ok", is not "보존" (before: a missing Excel result counted as a pass)
const controlsCaught = excelControlsCaught(manifest.filter((m) => m.kind === "control").map((m) => ex(m.file)));

// ───────── verdicts ─────────
const KIND = { text: "글자 칸", number: "숫자 칸", formula: "수식 칸" };
const flat = [];
for (const r of node.rows)
  for (const e of r.edits ?? []) {
    const x = ex(e.file);
    const excelOk = x ? x.open === "ok" : null;
    const value = x ? !!x.match : null;
    const deps = x ? `${x.depsSame}/${x.depsTotal}` : "-";
    const kept = xlsxEditKept(e, x, { ran: excelRan, controlsCaught });
    flat.push({ set: r.set, id: r.id, kind: e.kind, where: e.where, kept, e, x, excelOk, value, deps });
  }
const orig = (r) => ex(join(OUT, "files", `${r.id.replace(/[^\w.#-]+/g, "_")}.orig.xlsx`));
const mins = ((Date.now() - t0) / 60_000).toFixed(1);

const L = [];
const today = new Date().toISOString().slice(0, 10);
L.push("# Excel 한 곳 편집 측정 (측정 공백 9번)");
L.push("");
L.push(`측정: ${today} · \`node scripts/fidelity-xlsx-edit.mjs\` (${mins}분) · Excel 확인 ${excel.size ? "있음(새 인스턴스, 창 없음)" : excelRan ? "**실패(결과 없음 — 편집 모두 보존 아님)**" : "없음(--no-excel 또는 Windows 아님)"}${excel.size && !controlsCaught ? " · **대조 파일을 못 잡음 — 확인기 무효, 편집 모두 보존 아님**" : ""}`);
L.push("");
L.push("편집: 시트 칸 하나에 격자처럼 입력(`enterText` — 입력 규칙·다시 계산 포함) · 글자 칸 = 끝에 `~` · 숫자 칸 = +1(수식이 참조하는 칸을 먼저 고름) · 수식 칸 = `f` → `(f)+1`.");
L.push("");
L.push("보존 판정: ① 고친 값이 파일에 있음 ② 편집 밖 칸의 값·수식·서식이 같음 ③ 바뀌어도 되는 파트(고친·다시 계산된 칸의 시트, sharedStrings, calcChain, workbook.xml의 계산 설정, 고친 칸이 표 머리글·요약 행 이름표일 때 그 표의 열 목록) 밖의 파트가 바이트 그대로이고, 바뀐 시트 안에서도 편집과 상관없는 행이 바이트 그대로 ④ Excel이 복구 없이 열고 ⑤ 고친 칸을 같은 값으로 봄. 다시 계산된 칸이 Excel 값과 같은지는 따로 셉니다(오메 계산 엔진).");
L.push("");
const sum = (xs) => {
  const n = xs.length, k = xs.filter((f) => f.kept).length;
  return { n, k, pct: n ? ((k / n) * 100).toFixed(1) : "-" };
};
const all = sum(flat);
L.push(`## 요약 — 보존 **${all.k}/${all.n}** (${all.pct}%)`);
L.push("");
L.push("| 묶음 | 통합 문서 | 편집 | 보존 | 편집 반영 | 파트·행 그대로 | Excel 복구 없이 열기 | Excel 고친 칸 같음 | 오메가 저장한 고친 칸 값 = 기대값 | 다시 계산된 칸 Excel과 같음(열린 그대로 / CalculateFull) |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const set of ["public", "repo", "corpus"]) {
  const xs = flat.filter((f) => f.set === set);
  const books = node.rows.filter((r) => r.set === set).length;
  if (!books) {
    L.push(`| ${set === "corpus" ? "corpus" : set} | 0 | - | - | - | - | - | - | - | - |`);
    continue;
  }
  const s = sum(xs);
  const c = (p) => xs.filter(p).length;
  const dep = xs.reduce((a, f) => [a[0] + (f.x?.depsSame ?? 0), a[1] + (f.x?.calcDepsSame ?? 0), a[2] + (f.x?.depsTotal ?? 0)], [0, 0, 0]);
  L.push(`| ${{ public: "공개 견본", repo: "저장소 시험 자료", corpus: "corpus" }[set]} | ${books} | ${s.n} | **${s.k}** | ${c((f) => f.e.reflected)} | ${c((f) => f.e.reflected !== undefined && !f.e.diffs?.length)} | ${excel.size ? c((f) => f.excelOk) : "-"} | ${excel.size ? c((f) => f.value) : "-"} | ${c((f) => f.e.valueOk)} | ${excel.size ? `${dep[0]}/${dep[2]} · ${dep[1]}/${dep[2]}` : "-"} |`);
}
L.push("");
L.push(`편집 종류별: ${Object.keys(KIND).map((k) => { const s = sum(flat.filter((f) => f.kind === k)); return `${KIND[k]} ${s.k}/${s.n}`; }).join(" · ")}`);
L.push("");
const un = node.rows.filter((r) => r.unchanged);
L.push(`무편집 저장 바이트 동일: ${un.filter((r) => r.unchanged === "바이트 동일").length}/${un.length} · 원본을 Excel이 복구 없이 염: ${excel.size ? `${un.filter((r) => orig(r)?.open === "ok").length}/${un.length}` : "-"} · 대조(일부러 깨뜨린 파일) Excel 판정: 행 번호 0 → ${verdict(control)} · 겹친 병합 → ${verdict(control2)}`);
L.push("");
const errs = node.rows.filter((r) => r.error);
if (errs.length) L.push(`측정 못 한 통합 문서: ${errs.map((r) => `${r.set === "corpus" ? r.id : r.id} (${r.error})`).join(" · ")}`, "");
const why = new Map();
for (const f of flat.filter((f) => !f.kept)) {
  const ks = [...(excelRan && !f.x ? ["Excel 결과 없음"] : []), ...(excel.size && !controlsCaught ? ["Excel 확인기 무효(대조 못 잡음)"] : []), ...(f.e.error ? ["오류"] : []), ...(f.e.reflected === false ? ["편집 반영 안 됨"] : []), ...(f.e.diffs ?? []).map((d) => d.replace(/\d+/g, "N")), ...(f.excelOk === false ? [`Excel ${f.x.open === "repaired" ? "복구" : "열기 실패"}`] : []), ...(f.value === false ? ["Excel이 고친 칸을 다르게 봄"] : [])];
  for (const k of new Set(ks)) why.set(k, (why.get(k) ?? 0) + 1);
}
for (const f of flat.filter((f) => f.e.valueOk === false)) why.set("(보존 판정 밖) 오메가 저장한 고친 칸 값이 기대값과 다름·없음 — Excel은 열 때 다시 계산", (why.get("(보존 판정 밖) 오메가 저장한 고친 칸 값이 기대값과 다름·없음 — Excel은 열 때 다시 계산") ?? 0) + 1);
if (why.size) {
  L.push("### 보존 못 한 원인·계산 차이 (편집 수)");
  L.push("");
  for (const [k, n] of [...why].sort((a, b) => b[1] - a[1])) L.push(`- ${k}: ${n}`);
  L.push("");
}
L.push("## 저장소 시험 자료 상세");
L.push("");
L.push("| 통합 문서 | 무편집 | 편집 | 칸 | 보존 | 차이 | 파트 그대로 | Excel 열기 | Excel 값 | 다시 계산된 칸 |");
L.push("|---|---|---|---|---|---|---|---|---|---|");
for (const r of node.rows.filter((r) => r.set !== "corpus")) {
  if (r.error) {
    L.push(`| ${r.id} | - | - | - | - | ${r.error} | - | - | - | - |`);
    continue;
  }
  if (!r.edits.length) L.push(`| ${r.id} | ${r.unchanged} | 고를 칸 없음 | - | - | - | - | - | - | - |`);
  for (const e of r.edits) {
    const f = flat.find((x) => x.e === e);
    const x = f?.x;
    L.push(`| ${r.id}${r.note ? ` (${r.note})` : ""} | ${r.unchanged} | ${KIND[e.kind] ?? e.kind} | ${e.where ?? "-"} | ${f?.kept ? "**예**" : "아니오"} | ${e.error ?? (e.diffs.join("; ") || "-")} | ${e.parts ? `${e.parts.same}/${e.parts.total}` : "-"} | ${x ? (x.open === "ok" ? "OK" : `${x.open} ${x.why}`) : "-"} | ${x ? (x.match ? "같음" : `다름(${x.value})`) : "-"}${e.valueOk === false ? " · 오메 저장 값 없음·다름" : ""} | ${x ? `${x.depsSame}/${x.depsTotal} · ${x.calcDepsSame}/${x.depsTotal}` : "-"} |`);
  }
}
L.push("");
const corp = node.rows.filter((r) => r.set === "corpus");
L.push(`corpus XLSX: ${corp.length}개${corp.length ? ` — ${corp.map((r) => `${r.id} ${r.error ? "측정 못 함" : `${r.edits.filter((e) => flat.find((x) => x.e === e)?.kept).length}/${r.edits.length}`}`).join(" · ")}` : " (test-corpus에 XLSX 없음)"}`);
L.push("");
writeFileSync(join(ROOT, "qa/fidelity/XLSX_EDIT.md"), L.join("\n").replace(/\n/g, "\r\n"));
writeFileSync(join(OUT, "xlsx-edit.json"), JSON.stringify({ when: new Date().toISOString(), minutes: +mins, summary: all, flat: flat.map(({ e, x, ...f }) => ({ ...f, diffs: e.diffs, error: e.error, excel: x ?? null })), control: [control ?? null, control2 ?? null] }, null, 1));
console.log(L.join("\n"));
console.log(`\n결과: qa/fidelity/XLSX_EDIT.md · ${basename(OUT)}/xlsx-edit.json`);
