// Release gate (docs/RELEASING.md "배포 관문"): no version bump unless the real-use run of THIS commit passed.
//   import { releaseGate } from "./release-gate.mjs";  releaseGate({ version, approved })  → { ok, problems, remaining }
// What it reads: qa/realuse/results/latest.json (node qa/realuse/run.mjs --channels web,phone,android,desktop --vitest)
// and docs/qa/parity/feature-matrix.json; on success it writes the release snapshot docs/qa/parity/releases/
// feature-matrix-<version>.json, the baseline the next run compares with (a ○ there that is not ○ now = a regression).
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const RESULTS = "qa/realuse/results/latest.json";
const MATRIX = "docs/qa/parity/feature-matrix.json";
const CHANNELS = ["web", "phone", "android", "desktop"];
const GIT = existsSync("C:/Program Files/Git/cmd/git.exe") ? `"C:/Program Files/Git/cmd/git.exe"` : "git";
const git = (c) => execSync(`${GIT} ${c}`, { encoding: "utf8", windowsHide: true }).trim();

export function releaseGate({ version, approved, write = true }) {
  const problems = [];
  if (!existsSync(RESULTS)) return { ok: false, problems: [`실사용 회귀 시험 결과가 없습니다 (${RESULTS}). node qa/realuse/run.mjs --channels web,phone,android,desktop --vitest`], remaining: [] };
  const r = JSON.parse(readFileSync(RESULTS, "utf8"));
  const head = git("rev-parse HEAD");
  const dirty = git("status --porcelain --untracked-files=no -- src public index.html vite.config.ts package.json src-tauri").length > 0;
  if (r.commit !== head) problems.push(`결과가 다른 커밋의 것입니다 (결과 ${r.commit?.slice(0, 8)}, 지금 ${head.slice(0, 8)}) — 지금 커밋으로 다시 돌리세요`);
  if (r.dirty || dirty) problems.push("커밋하지 않은 소스 변경이 있습니다 — 커밋한 뒤 다시 돌리세요");
  // (a) the whole vitest suite
  if (!r.vitest?.ok) problems.push("(a) 전체 vitest가 이 커밋에서 통과한 기록이 없습니다 (run.mjs --vitest)");
  // (b) every channel ran in full for this commit (each channel's own commit / dirty / host, run.mjs)
  for (const ch of CHANNELS) {
    const c = r.channels?.[ch];
    if (!c) problems.push(`(b) ${ch} 채널을 안 돌렸습니다`);
    else if (c.skipped) problems.push(`(b) ${ch} 채널을 건너뛰었습니다: ${c.skipped}`);
    else if (c.only) problems.push(`(b) ${ch} 채널을 일부(--only)만 돌렸습니다`);
    // each channel on its own: run (or imported from another PC, --import-channel) for exactly this commit, clean
    if (c && !c.skipped) {
      const where = c.host ? ` @${c.host}` : "";
      if (!c.commit) problems.push(`(b) ${ch} 결과에 커밋 기록이 없습니다 — 새 run.mjs로 다시 돌리세요`);
      else if (c.commit !== head) problems.push(`(b) ${ch} 결과가 다른 커밋(${c.commit.slice(0, 8)}${where})의 것입니다 — 지금 커밋 ${head.slice(0, 8)}로 다시 돌리세요`);
      if (c.dirty !== false) problems.push(`(b) ${ch} 결과가 커밋 안 한 변경이 있는 상태${where}에서 나왔습니다 — 깨끗한 체크아웃으로 다시 돌리세요`);
      // the web build the browser channels were tested on (run.mjs stamps dist/realuse-build.json): this commit, clean
      if ((ch === "web" || ch === "phone") && (!c.build || c.build.commit !== head || c.build.dirty)) problems.push(`(b) ${ch}를 시험한 웹 빌드가 이 커밋의 깨끗한 빌드가 아닙니다(${c.build ? String(c.build.commit).slice(0, 8) + (c.build.dirty ? "+dirty" : "") + " " + (c.build.worktree ?? "") : "빌드 출처 기록 없음"}) — run.mjs로 다시 돌리세요`);
    }
  }
  // (c) no ○ → × against the last release
  if (r.regressions?.length) problems.push(`(c) 지난 배포보다 후퇴 ${r.regressions.length}개: ${r.regressions.join(", ")}`);
  // (e) cross-version opening (new app ← old .omw is a scenario; old app ← new .omw is a person's check, recorded)
  if (!r.cross?.ok) problems.push("(e) 버전 교차 열기 시험 기록이 없습니다 (직전 두 정식 판 exe로 새 .omw 열기 → node qa/realuse/run.mjs --record-cross \"<판·결과·확인한 사람>\")");
  // (d) what is still × / △ goes to the CEO, and the release waits for the answer
  const remaining = CHANNELS.flatMap((ch) => (r.channels?.[ch]?.fails ?? []).map((f) => `${ch}/${f}`));
  // items of the inspection reports no scenario checks yet: reported to the CEO with the list (not counted as passing)
  if (existsSync(MATRIX)) {
    const m = JSON.parse(readFileSync(MATRIX, "utf8"));
    const sc = new Map(m.rows.filter((x) => x.scenario).map((x) => [x.scenario, x]));
    for (const ch of CHANNELS) {
      const n = m.rows.filter((x) => !x.scenario && !x.cells?.[ch]?.s && !(x.tests ?? []).some((t) => sc.get(t)?.cells?.[ch]?.s)).length;
      if (n) remaining.push(`${ch}: 점검 보고서 항목 ${n}개는 시험으로 확인 안 됨 (표의 * / ?)`);
    }
  }
  if (remaining.length && !approved) problems.push(`(d) 남은 ×·△ ${remaining.length}개를 책임자에게 보고하고 확인받은 뒤 --approved "<누가·언제·어디서>"로 다시`);
  const ok = problems.length === 0;
  if (ok && write && existsSync(MATRIX)) {
    mkdirSync("docs/qa/parity/releases", { recursive: true });
    const m = JSON.parse(readFileSync(MATRIX, "utf8"));
    m.release = { version, commit: head, date: new Date().toISOString().slice(0, 10), approved: approved ?? null, remaining, cross: r.cross, vitest: r.vitest };
    writeFileSync(`docs/qa/parity/releases/feature-matrix-${version}.json`, JSON.stringify(m, null, 1) + "\n");
  }
  return { ok, problems, remaining };
}
