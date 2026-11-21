// Layout truth report on real Hancom-saved HWPX files (docs/design/LAYOUT_TRUTH.md).
// - qa/interop/adobe-made/hwpx_doc.hwpx: saved on a QA PC (qa/interop/scripts/hwp_make.ps1)
// - test-corpus/hwpx/*.hwpx (not in the repository; OMW_TEST_CORPUS points elsewhere): measured only, named
//   "corpus #n" — no file name or content leaves this PC.
// Report runs measure with the real installed fonts (nodeFonts.ts), like the app's WebView; a normal test run
// uses the built-in measurer (see SYSTEM_FONTS). Set OMW_LAYOUT_REPORT=<dir>
// to write the per-file JSON reports (with the debug overlay) there.

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DOMParser } from "@xmldom/xmldom";
import { parseHwpx } from "../../src/io/office";
import { setMeasure } from "../../src/core/text";
import { readHwpxTruth } from "../../src/core/layoutcheck/hwpxLineseg";
import { compareLayout, type LayoutCheckReport } from "../../src/core/layoutcheck/compare";
import { isInstalled, nodeMeasure } from "./nodeFonts";

const QA = join(process.cwd(), "qa/interop/adobe-made/hwpx_doc.hwpx");
const CORPUS = process.env.OMW_TEST_CORPUS ?? join(process.cwd(), "test-corpus");
const corpusFiles = existsSync(join(CORPUS, "hwpx")) ? readdirSync(join(CORPUS, "hwpx")).filter((f) => /\.hwpx$/i.test(f)).sort().map((f) => join(CORPUS, "hwpx", f)) : [];
const OUT = process.env.OMW_LAYOUT_REPORT;
/** fitting metric profiles takes minutes on a large file: on for report runs (OMW_LAYOUT_REPORT set) or OMW_LAYOUT_FIT=1 */
const FIT = !!OUT || process.env.OMW_LAYOUT_FIT === "1";
/**
 * Measure with the fonts installed on this PC only for report runs (or OMW_LAYOUT_FONTS=1). A normal test run
 * keeps the built-in deterministic measurer: its assertions (mapping, simulator = layoutText) hold for any
 * measurer, and it must not read C:/Windows/Fonts or depend on what is installed.
 */
const SYSTEM_FONTS = !!OUT || FIT || process.env.OMW_LAYOUT_FONTS === "1";

beforeAll(() => {
  (globalThis as any).DOMParser = DOMParser;
  if (SYSTEM_FONTS) setMeasure(nodeMeasure());
});

function check(label: string, file: string): LayoutCheckReport {
  const bytes = new Uint8Array(readFileSync(file));
  const truth = readHwpxTruth(bytes);
  const paras = parseHwpx(bytes);
  const t0 = Date.now();
  const rep = compareLayout(truth, paras, { fontAvailable: SYSTEM_FONTS ? isInstalled : () => false, fit: FIT });
  const line = (n: string) => {
    const m = rep.configs.find((c) => c.name === n)?.metrics;
    return m ? `${n.padEnd(20)} same ${m.identicalPct}% (${m.identical}/${m.compared})  multi ${m.multi.pct}% (${m.multi.identical}/${m.multi.n})  |Δlines| ${m.meanAbsDeltaLines}  |Δlh| ${m.lineHeight.meanAbsPx}px  |Δph| ${m.paraHeight.meanAbsPx}px  pages ${m.pages.ours}/${m.pages.truth}` : "";
  };
  console.log(
    [
      `== ${label}: ${rep.paragraphs} paragraphs, compared ${rep.compared}, skipped ${JSON.stringify(rep.skipped)}, simulator agrees ${rep.simulatorAgrees}, ${Date.now() - t0} ms`,
      ...rep.configs.map((c) => line(c.name)),
      `fixedAlone ${JSON.stringify(rep.fixedAlone)}`,
      `primary ${JSON.stringify(rep.primary)}`,
      `droppedChars ${rep.droppedChars} nonPercent ${rep.nonPercentSpacing}`,
      `fonts ${rep.fonts.map((f) => `${f.available ? "+" : "-"}${f.paragraphs}`).join(" ")}`,
      `profiles ${Object.values(rep.profiles).map((p) => JSON.stringify(p.fit.scale)).join(" ")}`,
    ].join("\n"),
  );
  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `layout-${label.replace(/\W+/g, "_")}.json`), JSON.stringify(rep, null, 1));
  }
  return rep;
}

describe("layout truth on Hancom-saved HWPX", () => {
  it.skipIf(!existsSync(QA))("qa/interop hwpx_doc.hwpx", () => {
    const rep = check("hwpx_doc", QA);
    expect(rep.compared).toBeGreaterThan(10);
    expect(rep.simulatorAgrees).toBe(rep.compared);
    expect(rep.skipped.unmapped ?? 0).toBe(0);
  }, 600000);
  corpusFiles.forEach((f, n) =>
    it(`corpus #${n + 1}`, () => {
      const rep = check(`corpus${n + 1}`, f);
      expect(rep.skipped.unmapped ?? 0).toBe(0);
      expect(rep.simulatorAgrees).toBe(rep.compared);
    }, 600000),
  );
});
