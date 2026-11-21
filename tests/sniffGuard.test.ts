// The desktop app's asset server guesses a script's type from its first bytes: a "%PDF-" near the top of a chunk made
// it serve src/io/formats/sniff.ts as application/pdf and the app never left its start screen (2026-11-22).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isPdf } from "../src/io/formats/sniff";
import { sniffTrap } from "../vite.config";

describe("content-sniffing trap in built scripts", () => {
  it("flags a PDF signature near the start of a chunk, not one deep inside", () => {
    expect(sniffTrap('const a=1;function f(h){return h.includes("%PDF-")}')).toMatch(/%PDF-/);
    expect(sniffTrap("x".repeat(5000) + '"%PDF-"')).toBeNull();
    expect(sniffTrap("const d=1")).toBeNull();
  });

  it("sniff.ts no longer carries the literal, and still recognises PDFs", () => {
    expect(readFileSync("src/io/formats/sniff.ts", "utf8")).not.toContain('"%PDF-"');
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(isPdf(enc("%PDF-1.7\n"))).toBe(true);
    expect(isPdf(enc("junk\n%PDF-1.4\n"))).toBe(true);
    expect(isPdf(enc("PK\u0003\u0004"))).toBe(false);
  });
});
