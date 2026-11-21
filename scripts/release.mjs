#!/usr/bin/env node
// Continuous release management.
//
//   node scripts/release.mjs patch|minor|major|<x.y.z>[-beta.N] [--date YYYY-MM-DD|none] [--dry]
//
// 1. bumps the version in package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml (+ its Cargo.lock entry) and
//    website/config.json (they must always agree — the updater compares them)
// 2. moves the "Unreleased" notes in CHANGELOG.md under the new version, or, when that section is
//    empty, drafts it from commit subjects since the last tag. --date sets the heading's date (default today;
//    "none" leaves it empty, to fill in on the day the release is published)
// 3. prints the git commands to commit + tag; pushing the tag runs .github/workflows/release.yml,
//    which builds the Windows files into a *draft* GitHub Release for review.
//
// A version is never lower than one already given out: the test channel shipped up to 0.1.13 from release
// branches, so the first public version is 0.2.0 (FLOOR below; installed apps only move to a higher version).
//
// Pre-release versions (x.y.z-beta.N) become GitHub pre-releases: testers can download them, but
// installed apps only auto-update to normal releases ("releases/latest" skips pre-releases).
// Files keep their line endings (CRLF in a Windows checkout).

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/** the highest version handed out before the public channel (test channel 0.1.13) */
const FLOOR = "0.1.13";

const args = process.argv.slice(2);
const arg = args[0];
const dry = args.includes("--dry");
const dateArg = args.includes("--date") ? args[args.indexOf("--date") + 1] : undefined;
if (!arg) {
  console.error("usage: node scripts/release.mjs patch|minor|major|<x.y.z>[-pre] [--date YYYY-MM-DD|none] [--dry]");
  process.exit(1);
}
if (dateArg !== undefined && dateArg !== "none" && !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) throw new Error(`invalid --date: ${dateArg}`);

/** read as LF, write back with the file's own line ending */
const read = (f) => {
  const s = readFileSync(f, "utf8");
  return { text: s.replace(/\r\n/g, "\n"), eol: s.includes("\r\n") ? "\r\n" : "\n" };
};
const write = (f, text, eol) => (dry ? console.log(`[dry] would write ${f}`) : writeFileSync(f, eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text));

const num = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(v).slice(1).map(Number);
const cmp = (a, b) => {
  const [x, y] = [num(a), num(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

const pkgFile = read("package.json");
const pkg = JSON.parse(pkgFile.text);
const cur = pkg.version;
const m = num(cur);
let next;
if (arg === "patch") next = `${m[0]}.${m[1]}.${m[2] + 1}`;
else if (arg === "minor") next = `${m[0]}.${m[1] + 1}.0`;
else if (arg === "major") next = `${m[0] + 1}.0.0`;
else if (/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(arg)) next = arg;
else throw new Error(`invalid version: ${arg}`);
if (cmp(next, FLOOR) <= 0) throw new Error(`${next} is not above ${FLOOR}, a version already given out — installed apps would not update to it`);

// 1. versions
pkg.version = next;
write("package.json", JSON.stringify(pkg, null, 2) + "\n", pkgFile.eol);
const confFile = read("src-tauri/tauri.conf.json");
const conf = JSON.parse(confFile.text);
conf.version = next;
write("src-tauri/tauri.conf.json", JSON.stringify(conf, null, 2) + "\n", confFile.eol);
const cargo = read("src-tauri/Cargo.toml");
write("src-tauri/Cargo.toml", cargo.text.replace(/^version = ".*"$/m, `version = "${next}"`), cargo.eol);
try {
  const lock = read("src-tauri/Cargo.lock");
  write("src-tauri/Cargo.lock", lock.text.replace(/(\[\[package\]\]\nname = "omniweave"\nversion = ")[^"]*"/, `$1${next}"`), lock.eol);
} catch {
  /* no lock file */
}
try {
  const siteFile = read("website/config.json");
  const site = JSON.parse(siteFile.text);
  site.version = next;
  write("website/config.json", JSON.stringify(site, null, 2) + "\n", siteFile.eol);
} catch {
  /* website optional */
}

// 2. changelog
const date = dateArg === "none" ? "" : dateArg ?? new Date().toISOString().slice(0, 10);
const logFile = read("CHANGELOG.md");
let log = logFile.text;
const unreleased = /## \[Unreleased\]\n([\s\S]*?)(?=\n## \[|$)/.exec(log);
let notes = unreleased ? unreleased[1].trim() : "";
if (!notes) {
  let range = "";
  try {
    range = execSync("git describe --tags --abbrev=0", { encoding: "utf8", windowsHide: true }).trim() + "..HEAD";
  } catch {
    /* first release: whole history */
  }
  const subjects = execSync(`git log ${range} --no-merges --pretty=format:%s`, { encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 })
    .split("\n")
    .filter((s) => s && !/^(release|chore\(release\))/i.test(s));
  notes = subjects.map((s) => `- ${s}`).join("\n") || "- 유지보수";
}
const section = `## [${next}] - ${date}\n\n${notes}\n`;
log = unreleased ? log.replace(unreleased[0], `## [Unreleased]\n\n${section}`) : log.replace(/(# .*\n)/, `$1\n## [Unreleased]\n\n${section}`);
write("CHANGELOG.md", log, logFile.eol);

console.log(`\nOmniweave ${cur} → ${next}${date ? "" : " (date left empty in CHANGELOG.md)"}\n`);
console.log("다음 명령으로 커밋·태그·푸시하면 릴리스 빌드가 시작됩니다(초안 릴리스로 올라감):");
console.log(`  git add -A && git commit -m "release: v${next}"`);
console.log(`  git tag v${next} && git push origin main v${next}`);
