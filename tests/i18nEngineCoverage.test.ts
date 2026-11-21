// Engine messages live in the language files too (src/i18n/parts/engine-*): no Korean string literals in src/core
// and src/io outside comments. Lines marked `// i18n: keep` hold Korean that is data (font and style names matched
// in files, input aliases, stored sentinels), `// i18n: ui` registry labels the UI already translates by key, and
// `// i18n: later` format-registry descriptions not shown yet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** not moved yet: being reworked for layer groups / clipping (2026-11-11), their messages follow afterwards */
const PENDING = ["src/io/formats/psd.ts", "src/io/formats/psdWrite.ts", "src/io/pdfVector.ts"].map((p) => join(p));

const LITERAL = /"([^"\n]*[가-힣][^"\n]*)"|`([^`]*[가-힣][^`]*)`/g;
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/^.*\/\/ i18n: (keep|ui|later).*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("engine text lives in the language files", () => {
  it("no Korean literals in src/core and src/io", () => {
    const left = [...files("src/core"), ...files("src/io")]
      .filter((f) => !PENDING.includes(f))
      .flatMap((f) => [...code(f).matchAll(LITERAL)].map((m) => `${f}: ${m[0]}`));
    expect(left).toEqual([]);
  });
});
