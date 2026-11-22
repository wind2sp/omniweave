// Public source tree: a plain copy of the tracked files without what must stay private, for the first commit of the
// public repository (no git history is copied — the private history names folders, PCs and QA material).
//
//   node scripts/make-public-tree.mjs <dest> [--force] [--allow-dirty]   copy, then run the --check scan on <dest>
//   node scripts/make-public-tree.mjs --list                              print what would be left out, and why
//   node scripts/make-public-tree.mjs --check <dir>                       only scan an existing tree
//
// What is left out: scripts/public-exclude.txt (patterns with the reason above each). Its rule @needs-private-qa
// leaves out test files whose code reads qa/ or docs/qa/ (the private QA material) and test files that import one of
// them, so `npm test` passes in the public tree.
//
// --check scans every text file of the tree for what must not be published: a user-profile path with a real name,
// the internal work folders (omw-migrate and the like), the private cloud folder, the coordination repository, the
// account name of this PC (never printed), and e-mail addresses other than the project contact in the copyright
// lines and documentation examples. It also checks that qa/ and docs/qa/ are absent. Exit 1 when anything is found.
// Hits are printed as file:line with the matched kind only, so the check itself does not copy a value into a log.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GIT = process.env.GIT ?? (process.platform === "win32" && existsSync("C:/Program Files/Git/cmd/git.exe") ? "C:/Program Files/Git/cmd/git.exe" : "git");
const git = (args) => execFileSync(GIT, args, { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 64 << 20 });

// ---------------------------------------------------------------- exclusion patterns
/** gitignore-like pattern → RegExp over a '/'-separated relative path */
export function patternRegExp(p) {
  const dir = p.endsWith("/");
  const body = (dir ? p.slice(0, -1) : p)
    .split(/(\*\*|\*)/)
    .map((s) => (s === "**" ? ".*" : s === "*" ? "[^/]*" : s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${body}${dir ? "(/.*)?" : ""}$`);
}

export function readExcludes(file = join(ROOT, "scripts/public-exclude.txt")) {
  const rules = { drop: [], keep: [], auto: false };
  let why = "";
  let inComment = false; // consecutive comment lines form one reason
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      const text = line.replace(/^#\s*/, "");
      if (/^---/.test(text)) inComment = false;
      else (why = inComment ? `${why} ${text}` : text), (inComment = true);
      continue;
    }
    inComment = false;
    if (line === "@needs-private-qa") rules.auto = true;
    else if (line.startsWith("!")) rules.keep.push({ pattern: line.slice(1), re: patternRegExp(line.slice(1)), why });
    else rules.drop.push({ pattern: line, re: patternRegExp(line), why });
  }
  return rules;
}

// ---------------------------------------------------------------- tests that need the private QA material
const TEST_FILE = /^(tests|scripts|bench)\/.*\.(test|bench)\.[cm]?[jt]sx?$/;
const CODE_FILE = /^(tests|scripts|bench)\/.*\.[cm]?[jt]sx?$/;
/** code with comments removed (line comments only where '//' starts a comment, not inside "http://") */
export function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[\s;,{}()])\/\/.*$/, "$1"))
    .join("\n");
}
/** a string in the code that names a path under qa/ or docs/qa/ (also a bare "qa" folder in join(…, "qa", …)) */
export const QA_REF = /["'`](?:\.\/)?(?:docs\/)?qa(?:\/|["'`])/;

/** a file path written out in the code under docs/ (a picture or document a test reads) */
const DOC_PATH = /["'`](docs\/[^"'`$\s]+\.[A-Za-z0-9]{2,5})["'`]/g;

/**
 * Test files that need the private material: code that names qa/ or docs/qa/, or (with `exists`) a docs/ file that is
 * not in this tree (left out of the public tree, e.g. a design mock-up picture), and the test files importing them.
 */
export function needsPrivateQa(files, read = (f) => readFileSync(join(ROOT, f), "utf8"), exists = null) {
  const code = files.filter((f) => CODE_FILE.test(f));
  const missingDoc = (src) => !!exists && [...src.matchAll(DOC_PATH)].some((m) => !exists(m[1]));
  const direct = new Set(
    code.filter((f) => {
      const src = stripComments(read(f));
      return QA_REF.test(src) || missingDoc(src);
    }),
  );
  // test files importing (relatively) a file that needs the material need it too — until nothing changes
  const imports = new Map(
    code.map((f) => {
      const src = stripComments(read(f));
      const deps = [...src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map((m) => posix.normalize(posix.join(posix.dirname(f), m[1])));
      return [f, deps];
    }),
  );
  const hit = (dep) => [...direct].some((d) => d === dep || d.replace(/\.[cm]?[jt]sx?$/, "") === dep.replace(/\.[cm]?[jt]sx?$/, ""));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [f, deps] of imports) if (!direct.has(f) && deps.some(hit)) (direct.add(f), (changed = true));
  }
  // tools under scripts/ stay (run by hand, not by npm test); a test helper under tests/ that needs the material is
  // left out when no remaining file imports it
  const bare = (p) => p.replace(/\.[cm]?[jt]sx?$/, "");
  const usedByKept = (f) => [...imports].some(([g, deps]) => !direct.has(g) && deps.some((d) => bare(d) === bare(f)));
  return [...direct].filter((f) => TEST_FILE.test(f) || (f.startsWith("tests/") && !usedByKept(f)));
}

export function plan(files = trackedFiles(), rules = readExcludes()) {
  const auto = rules.auto && !process.argv.includes("--no-auto") ? new Set(needsPrivateQa(files)) : new Set();
  const out = { copy: [], drop: [] };
  for (const f of files) {
    const keep = rules.keep.find((r) => r.re.test(f));
    const rule = rules.drop.find((r) => r.re.test(f));
    if (keep) out.copy.push(f);
    else if (rule) out.drop.push({ file: f, pattern: rule.pattern, why: rule.why });
    else if (auto.has(f)) out.drop.push({ file: f, pattern: "@needs-private-qa", why: "test reads the private QA material" });
    else out.copy.push(f);
  }
  return out;
}

/** tracked files; with --allow-dirty also new files not yet added (not the ignored ones) */
function trackedFiles(withNew = process.argv.includes("--allow-dirty")) {
  const list = git(["ls-files", "-z", ...(withNew ? ["--cached", "--others", "--exclude-standard"] : [])]).split("\0").filter(Boolean);
  return [...new Set(list)];
}

// ---------------------------------------------------------------- check
const GENERIC = new Set(["user", "users", "admin", "administrator", "runner", "runneradmin", "root", "test", "build", "builder", "ci", "node", "default", "owner", "public", "guest", "omniweave"]);
/** the project contact (copyright lines, Director line) is published on purpose — only in these files */
const CONTACT = "wind2sp@9rowpar.com";
const CONTACT_FILES = /^(NOTICE|README(\.en)?\.md|THIRD_PARTY_NOTICES\.md|src\/ui\/shell\/ShellDialogs\.tsx|scripts\/third-party-notices\.mjs|CONTRIBUTING\.md|SECURITY\.md|website\/(.*\.html|config\.json)|packaging\/msix\/store_listing\/.*)$/;
/** documentation-only addresses (RFC 2606 domains), package specifiers and test strings */
const SAFE_MAIL = /@(example\.(com|org|net)|y\.com|github\.com)$|^git@github\.com$|^noreply@/i;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|bmp|tiff?|psd|ai|pdf|docx?|xlsx?|pptx?|hwpx?|omw|zip|gz|7z|woff2?|ttf|otf|lwt|wasm|mp[34]|webm|wav|ogg|m4a|icc|bin|pack|dwg|dxf|shx|emf|wmf|eps|heic)$/i;

export function checkPatterns(account = userInfo().username ?? "") {
  const list = [
    ["user-profile path", /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}(?!<|Public\b|Default\b|you\b|USERNAME\b|\$|%|\*|name\b)[A-Za-z0-9._-]{2,}/i],
    ["internal work folder", /\b[A-Za-z]:[\\/]{1,2}(omw[-\w]*|ref|tools)\b|\bomw-(migrate|integ|release-prep|target)\b/i],
    ["private cloud folder", /Dropbox[\\/]{1,2}9rowpar|9rowpar\/omniweave-/i],
    ["coordination repository", /collaboration_docs|ninerow-main|telegram_ask/i],
    ["development PC name", /\b(windsp|ninerow)\b/], // lower case: the PC names (the company is NINEROW partners),
    ["internal title", /대표님/], // in-house wording of internal instructions; the public text says "product decision"
  ];
  if (account.length >= 4 && !GENERIC.has(account.toLowerCase())) list.push(["this PC's account name", new RegExp(`\\b${account.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")]);
  return list;
}

/** this tool names what it looks for (the patterns themselves) */
const SELF = /^(scripts\/(make-public-tree\.mjs|public-exclude\.txt)|tests\/releaseTools\.test\.ts)$/;

export function checkText(file, text, patterns = checkPatterns()) {
  const hits = [];
  if (SELF.test(file)) return hits;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [kind, re] of patterns) if (re.test(line)) hits.push(`${file}:${i + 1} ${kind}`);
    // an address ends in a letter-only top-level domain; "x@2x.png" (image scale) and "IoU@0.5" are not addresses
    for (const m of line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g)) {
      if (/\.(png|jpe?g|svg|webp|gif|ico|lwt)$/i.test(m[0])) continue;
      const mail = m[0];
      if (SAFE_MAIL.test(mail)) continue;
      if (mail.toLowerCase() === CONTACT && CONTACT_FILES.test(file)) continue;
      if (/^(LICENSE|.*\/LICENSE[^/]*|.*OFL\.txt|package-lock\.json|src-tauri\/Cargo\.lock|THIRD_PARTY_NOTICES\.md)$/.test(file)) continue; // third-party licence texts (their authors' published addresses) and lock files
      hits.push(`${file}:${i + 1} e-mail address`);
    }
  });
  return hits;
}

function walk(dir, base = dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n === ".git") continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split("\\").join("/"));
  }
  return out;
}

export function checkTree(dir) {
  const hits = [];
  for (const d of ["qa", "docs/qa"]) if (existsSync(join(dir, d))) hits.push(`${d}/ present`);
  const patterns = checkPatterns();
  for (const f of walk(dir)) {
    for (const [kind, re] of patterns) if (re.test(f)) hits.push(`${f} (file name) ${kind}`);
    if (BINARY.test(f)) continue;
    const b = readFileSync(join(dir, f));
    if (b.includes(0)) continue;
    hits.push(...checkText(f, b.toString("utf8"), patterns));
  }
  return hits;
}

// ---------------------------------------------------------------- main
function main(argv) {
  const has = (k) => argv.includes(k);
  if (has("--list")) {
    const p = plan();
    const by = new Map();
    for (const d of p.drop) by.set(d.pattern, [...(by.get(d.pattern) ?? []), d]);
    for (const [pattern, ds] of by) {
      console.log(`${pattern}  (${ds.length})  — ${ds[0].why}`);
      if (pattern === "@needs-private-qa" || ds.length <= 12) for (const d of ds) console.log(`    ${d.file}`);
    }
    console.log(`\ncopy ${p.copy.length} files, leave out ${p.drop.length}`);
    return 0;
  }
  if (has("--check") && argv.indexOf("--check") === 0) {
    const dir = argv[1];
    if (!dir || !existsSync(dir)) throw new Error("usage: --check <dir>");
    return report(checkTree(resolve(dir)));
  }
  const dest = argv.find((a) => !a.startsWith("--"));
  if (!dest) {
    console.error("usage: node scripts/make-public-tree.mjs <dest> [--force] [--allow-dirty] | --list | --check <dir>");
    return 2;
  }
  const out = resolve(dest);
  if (out === ROOT || out.startsWith(ROOT + "\\") || out.startsWith(ROOT + "/")) throw new Error("the destination must be outside the repository");
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim();
  if (dirty && !has("--allow-dirty")) throw new Error("tracked files have uncommitted changes (commit first, or --allow-dirty):\n" + dirty);
  if (existsSync(out) && readdirSync(out).some((n) => n !== "node_modules")) {
    if (!has("--force")) throw new Error(`${out} is not empty (--force replaces it; node_modules is kept)`);
    for (const n of readdirSync(out)) if (n !== "node_modules") rmSync(join(out, n), { recursive: true, force: true });
  }
  const p = plan();
  for (const f of p.copy) {
    if (!existsSync(join(ROOT, f))) continue; // deleted in the working tree
    mkdirSync(dirname(join(out, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(out, f));
  }
  const head = git(["rev-parse", "--short", "HEAD"]).trim();
  console.log(`public tree: ${out}\n  from ${head}${dirty ? " (+ uncommitted changes)" : ""}: copied ${p.copy.length} files, left out ${p.drop.length} (node scripts/make-public-tree.mjs --list)`);
  return report(checkTree(out));
}

function report(hits) {
  if (!hits.length) {
    console.log("check: no personal paths, internal folders, account names or e-mail addresses found");
    return 0;
  }
  console.log(`check: ${hits.length} finding(s)`);
  for (const h of hits.slice(0, 200)) console.log("  " + h);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
