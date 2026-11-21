// Colour-managed CMYK → RGB is the same bits on every JavaScript engine (2026-11-17, core/image/iccCmyk.ts): the
// profile table is computed from IEEE-exact operations only (ppow instead of Math.pow / cbrt), the 4-D interpolation
// in whole numbers. That makes such documents' tiles derivable in .omw again (recipe psd/2, io/omwDerive.ts).
// The fingerprints below are pinned; scripts/icc-portable-engines.mjs recomputes them in other engines (Node 22,
// headless Edge). If they change, the conversion changed: packages listing psd/2 tiles would no longer open fully —
// keep the conversion for psd/2 and give the new one a new recipe.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { cmykXform, defaultCmykProfile, forgetCmykXforms, ppow } from "../../src/core/image/iccCmyk";
import { loadDissolveField } from "../../src/core/style/blend";
import { newDocument } from "../../src/core/types";
import { importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { packOmw, unpackOmw } from "../../src/io/omw";
import { PSD_MIME, PSD_RECIPE, PSD_RECIPE_CMS, derivationPortable, recipeFor } from "../../src/io/omwDerive";
import { conversionFingerprint, derivedFingerprint } from "./iccPortableProbe";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made");
const read = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));
/** U.S. Web Coated (SWOP) v2, embedded */
const SWOP_PSD = "ps_cmyk_8bit.psd";
/** no profile: the default FOGRA39 */
const BARE_PSD = "fidelity/omni-fid-cmyk-mode-multiply.psd";

const swopProfile = () => {
  const b = read(SWOP_PSD);
  const r = parsePsdLayout(b).resItems.find((it) => it.id === 1039)!;
  return b.slice(r.dataStart, r.dataEnd);
};

const PINS = {
  conversion: { FOGRA39: "cdb8df403224f220", SWOP: "e7cccbc59ed77c46" },
  derived: { [SWOP_PSD]: "5d348bbdf36b7b20", [BARE_PSD]: "9016bf4fdd466119" } as Record<string, string>,
};

function fingerprints() {
  return {
    conversion: { FOGRA39: conversionFingerprint(cmykXform(defaultCmykProfile()!.bytes, "FOGRA39")!), SWOP: conversionFingerprint(cmykXform(swopProfile(), "SWOP")!) },
    derived: Object.fromEntries(Object.keys(PINS.derived).map((f) => [f, derivedFingerprint(read(f))])),
  };
}

beforeAll(() => loadDissolveField());

describe("portable CMYK colour management", () => {
  it("ppow follows Math.pow to a few ulps (relative to the exponent's size, as any exp(y·ln x) does)", () => {
    let worst = 0;
    for (const y of [1 / 2.4, 2.4, 1 / 3, 1.8, 2.2, 0.5, 3, 0.1, 7.25, -1.5])
      for (let i = 0; i <= 4000; i++) {
        const x = i === 0 ? 5e-324 : Math.exp(-700 + (i / 4000) * 707);
        const want = Math.pow(x, y), got = ppow(x, y);
        if (want < 1e-300 || !Number.isFinite(want)) continue;
        worst = Math.max(worst, Math.abs(got - want) / want / Math.max(1, Math.abs(y * Math.log(x))));
      }
    expect(worst).toBeLessThan(1e-15);
    expect([ppow(0, 2.4), ppow(1, 7), ppow(0.5, 0), ppow(4, 0.5), ppow(8, 1 / 3)]).toEqual([0, 1, 1, 2, expect.closeTo(2, 14)]);
  });

  it("the conversion and the tiles derived through it are pinned", () => {
    expect(fingerprints()).toEqual(PINS);
  });

  it("nothing in it depends on the engine's approximated Math functions (they throw here)", () => {
    const names = ["pow", "exp", "expm1", "log", "log1p", "log2", "log10", "cbrt", "sin", "cos", "tan", "atan", "atan2", "sinh", "cosh", "tanh", "hypot"] as const;
    const M = Math as unknown as Record<string, unknown>;
    const saved = names.map((n) => M[n]);
    forgetCmykXforms();
    try {
      for (const n of names)
        M[n] = () => {
          throw new Error(`Math.${n} used`);
        };
      expect(fingerprints()).toEqual(PINS);
    } finally {
      names.forEach((n, i) => (M[n] = saved[i]));
      forgetCmykXforms();
    }
  });

  it(".omw: a CMYK document's tiles are listed under psd/2 and open fully; other packages stay psd/1", () => {
    for (const [f, recipe] of [[BARE_PSD, PSD_RECIPE_CMS], [SWOP_PSD, PSD_RECIPE_CMS], ["psd_clip_basic.psd", PSD_RECIPE]]) {
      const bytes = read(f);
      expect(derivationPortable(bytes)).toBe(true);
      expect(recipeFor(bytes)).toBe(recipe);
      const hash = putBlob(bytes);
      const doc = newDocument("Omni PSD");
      doc.pages = [importPsdPage(bytes, f, "p", { id: "a1", hash }).page];
      doc.assets = { a1: { id: "a1", hash, mime: PSD_MIME, name: f, size: bytes.length } };
      const { bytes: omw, stats } = packOmw(doc);
      expect(stats.tiles).toBeGreaterThan(0);
      expect(stats.derivedTiles).toBe(stats.tiles);
      expect(JSON.parse(strFromU8(unzipSync(omw)["rasters/derived.json"])).recipe).toBe(recipe);
      const { report } = unpackOmw(omw);
      expect(report).toMatchObject({ corruptTiles: 0, missingTiles: 0 });
      expect(report.derivedTiles).toBe(stats.tiles);
    }
  });
});
