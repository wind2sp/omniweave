// What tests/psd/iccPortable.test.ts pins and scripts/icc-portable-engines.mjs recomputes in other JavaScript engines
// (Node versions, headless Edge): fingerprints of the colour-managed CMYK → RGB conversion (core/image/iccCmyk.ts),
// which must be the same bits everywhere for the .omw recipe psd/2 (io/omwDerive.ts).
import { hashBytes, hashString } from "../../src/core/hash";
import type { CmykXform } from "../../src/core/image/iccCmyk";
import { PSD_RECIPE_CMS, derivePsdTiles } from "../../src/io/omwDerive";

/** Every stored ink value 0, 5, …, 255 on all four channels (52⁴ colours: each grid cell, corners and insides) → RGB. */
export function conversionFingerprint(xf: CmykXform): string {
  const N = 52;
  const out = new Uint8Array(N * N * N * N * 3);
  let o = 0;
  for (let c = 0; c < N; c++)
    for (let m = 0; m < N; m++)
      for (let y = 0; y < N; y++)
        for (let k = 0; k < N; k++, o += 3) xf.rgb(c * 5, m * 5, y * 5, k * 5, out, o);
  return hashBytes(out);
}

/** The tiles psd/2 derives from a PSD (their content hashes, sorted). */
export function derivedFingerprint(psd: Uint8Array): string {
  return hashString([...derivePsdTiles(psd, PSD_RECIPE_CMS).keys()].sort().join(","));
}
