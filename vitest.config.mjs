// Vitest settings: vite.config.ts, plus one rule for the public source tree.
//
// The private QA material (qa/, docs/qa/) is not in the public repository (scripts/public-exclude.txt). Test files
// whose code reads it cannot pass there, so without a qa/ folder they are skipped (left out of the run) — the same
// scan scripts/make-public-tree.mjs uses (needsPrivateQa: a path under qa/ in the code, a docs/ file the tree does not
// have, or an import of such a file).
// In the development repository qa/ is there and every test runs as before.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { mergeConfig } from "vitest/config";
import base from "./vite.config.ts";
import { needsPrivateQa } from "./scripts/make-public-tree.mjs";

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = `${dir}/${n}`;
    return n === "node_modules" ? [] : statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const skip = existsSync("qa") ? [] : needsPrivateQa(["tests", "scripts", "bench"].flatMap(walk), (f) => readFileSync(join(".", f), "utf8"), (f) => existsSync(f));
if (skip.length && process.env.OMW_SHOW_SKIPPED) console.log(`no qa/: ${skip.length} test files skipped\n  ${skip.join("\n  ")}`);

export default mergeConfig(base, { test: { exclude: skip } });
