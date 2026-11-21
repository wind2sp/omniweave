// All UI text lives in the language files (src/i18n): no Korean string literals in src/ui outside comments.
// A line marked `// i18n: keep` holds Korean that is not UI text (e.g. a diagnostic code or an error matched by
// message); the company's legal name and the director's name in About are written in Korean on purpose.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ALLOWED = ["나인로우파트너스(주)", "황경진"];

const LITERAL = /"([^"\n]*[가-힣][^"\n]*)"|`([^`]*[가-힣][^`]*)`|>([^<>{}\n]*[가-힣][^<>{}\n]*)</g;
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/^.*\/\/ i18n: keep.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
const literals = (file: string) => [...code(file).matchAll(LITERAL)].map((m) => m[0]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("UI text lives in the language files", () => {
  it("no Korean literals in src/ui", () => {
    const left = files("src/ui").flatMap((f) => literals(f).filter((l) => !ALLOWED.some((a) => l.includes(a))).map((l) => `${f}: ${l}`));
    expect(left).toEqual([]);
  });
});
