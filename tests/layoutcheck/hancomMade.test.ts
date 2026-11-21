// Layout truth on the 한글-saved test files of qa/interop/hancom-made (장평·자간 grid, line breaking, margins,
// controls) and adobe-made/hwpx_doc: identical-break % of layoutText (config "baseline") against 한글's lineseg.
// A normal test run uses the built-in measurer and only checks that the comparator maps every paragraph and the
// simulator equals layoutText (so a layoutText change that the simulator does not follow fails here).
// OMW_LAYOUT_FONTS=1 measures with the fonts installed on this PC and prints the numbers (docs/design/LAYOUT_TRUTH.md 9).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { parseHwpx } from "../../src/io/office";
import { setMeasure } from "../../src/core/text";
import { readHwpxTruth } from "../../src/core/layoutcheck/hwpxLineseg";
import { compareLayout } from "../../src/core/layoutcheck/compare";
import { isInstalled, nodeMeasure } from "./nodeFonts";

const DIR = join(process.cwd(), "qa/interop/hancom-made");
const files = [
  ...(existsSync(DIR) ? readdirSync(DIR).filter((f) => /\.hwpx$/i.test(f)).sort().map((f) => join(DIR, f)) : []),
  join(process.cwd(), "qa/interop/adobe-made/hwpx_doc.hwpx"),
].filter((f) => existsSync(f));
const FONTS = process.env.OMW_LAYOUT_FONTS === "1" || process.env.OMW_LAYOUT_HCR === "1";
/**
 * OMW_LAYOUT_HCR=1: measure 함초롬 faces with the HCR Batang advance widths 한글 uses (qa/interop/hancom-made/
 * hcr-batang-metrics.json, no outlines) and everything else with the installed fonts — separates the 장평 / 자간 rules
 * from the font-width difference (Pretendard 0.864 em against 0.970 em per syllable).
 */
const HCR = process.env.OMW_LAYOUT_HCR === "1";
function hcrMeasure(fallback: (t: string, f: string) => number) {
  const m = JSON.parse(readFileSync(join(process.cwd(), "qa/interop/hancom-made/hcr-batang-metrics.json"), "utf8"));
  const em = (ch: string) => m.ascii[ch] ?? m.punctuation[ch] ?? (/[가-힣]/.test(ch) ? 970 : null);
  return (text: string, font: string) => {
    if (!/함초롬|HCR/i.test(font)) return fallback(text, font);
    const size = Number(/([d.]+)px/.exec(font)?.[1] ?? 16);
    let w = 0;
    for (const ch of text) {
      const u = em(ch);
      w += u === null ? fallback(ch, font) : (u / m.unitsPerEm) * size;
    }
    return w;
  };
}

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
  if (FONTS) setMeasure(HCR ? hcrMeasure(nodeMeasure()) : nodeMeasure());
});

describe("layout truth: hancom-made + hwpx_doc", () => {
  for (const f of files)
    it(f.replace(/^.*[\\/]/, ""), () => {
      const bytes = new Uint8Array(readFileSync(f));
      const rep = compareLayout(readHwpxTruth(bytes), parseHwpx(bytes), { fontAvailable: FONTS ? (f: string) => (HCR && /함초롬|HCR/i.test(f)) || isInstalled(f) : () => false, fit: false });
      const m = rep.configs.find((c) => c.name === "baseline")!.metrics;
      if (FONTS) console.log(`LAYOUT ${f.replace(/^.*[\\/]/, "")}: same ${m.identicalPct}% (${m.identical}/${m.compared}) multi ${m.multi.pct}% (${m.multi.identical}/${m.multi.n}) |dLines| ${m.meanAbsDeltaLines} skipped ${JSON.stringify(rep.skipped)}`);
      if (FONTS) for (const c of rep.configs) console.log(`CONFIG ${f.replace(/^.*[\/]/, "")} ${c.name}: same ${c.metrics.identicalPct}% (${c.metrics.identical}/${c.metrics.compared}) multi ${c.metrics.multi.identical}/${c.metrics.multi.n}`);
      if (process.env.OMW_LAYOUT_DEBUG) for (const o of rep.overlay) if (!o.same) console.log(`DIFF ${o.index} ${o.lines.map((l) => `${l.ourStart}/${l.truthStart}`).join(" ")}`);
      expect(rep.skipped.unmapped ?? 0).toBe(0);
      expect(rep.simulatorAgrees).toBe(rep.compared);
    }, 600000);
});
