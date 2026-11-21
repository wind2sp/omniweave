// HWPX paragraph margins: hp:switch holds them twice — hp:case (HwpUnitChar namespace) in HWPUNIT, hp:default
// twice that. Unwrapped values are plain HWPUNIT. Expected values measured from PDFs that 한글 2024 saved
// (qa/interop/RESULTS-2026-11-12.md): the sample's indented paragraph is 10 pt; the same header with hp:switch
// replaced by its hp:default content (2000) shows 20 pt, by its hp:case content (1000) 10 pt.
import { readFileSync } from "node:fs";
import { DOMParser } from "@xmldom/xmldom";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { parseHwpx } from "../src/io/office";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
});

const PT = 96 / 72;
const DOC = readFileSync("qa/interop/adobe-made/hwpx_doc.hwpx");
/** the sample with every hp:switch replaced by the content of one of its branches */
function unwrap(keep: "case" | "default"): Uint8Array {
  const files = unzipSync(DOC);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(files)) {
    if (k === "Contents/header.xml")
      out[k] = strToU8(strFromU8(v).replace(/<hp:switch><hp:case [^>]*>([\s\S]*?)<\/hp:case><hp:default>([\s\S]*?)<\/hp:default><\/hp:switch>/g, (_, c, d) => (keep === "case" ? c : d)));
    else out[k] = k === "mimetype" ? [v, { level: 0 }] : v;
  }
  return zipSync(out);
}
const indentOf = (bytes: Uint8Array) => parseHwpx(bytes).find((p) => p.runs.map((r) => r.text).join("").startsWith("들여쓰기와"))!.indent / PT;

describe("HWPX paragraph margins (hp:switch)", () => {
  it("hp:case is read (HWPUNIT): the indented paragraph is 10 pt, as 한글 shows it", () => {
    expect(indentOf(DOC)).toBeCloseTo(10, 1);
  });
  it("unwrapped values are plain HWPUNIT (한글 2024: 2000 → 20 pt, 1000 → 10 pt)", () => {
    expect(indentOf(unwrap("default"))).toBeCloseTo(20, 1);
    expect(indentOf(unwrap("case"))).toBeCloseTo(10, 1);
  });
});
