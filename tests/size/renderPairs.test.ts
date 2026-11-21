// Before/after PDF pairs for the pixel comparison page qa/size/render-compare.html (docs/design/FILE_SIZE.md ch. 4).
// Skipped in `npm test`; run with OMNIWEAVE_SIZE=1 [OMNIWEAVE_SIZE_CORPUS=<dir>] npx vitest run tests/size/renderPairs.test.ts
// Files go to node_modules/.cache/omniweave-size/ (never into the repository); corpus files are named corpus-n only.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "vitest";
import { newDocument } from "../../src/core/types";
import { importPdf } from "../../src/io/pdf";
import { optimizePdf } from "../../src/io/pdfOptimize";
import { exportPdfVector } from "../../src/io/pdfVector";
import { pdfjs } from "../pdfsurgeon/helpers";

const OUT = join(process.cwd(), "node_modules/.cache/omniweave-size");
const FONTS = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };

describe.skipIf(!process.env.OMNIWEAVE_SIZE)("render pairs", () => {
  it("writes pairs", async () => {
    await pdfjs();
    mkdirSync(OUT, { recursive: true });
    const pairs: { id: string; a: string; b: string }[] = [];
    const inputs: { id: string; path: string }[] = [];
    for (const d of ["qa/interop/adobe-made", "qa/interop/omniweave-made"])
      for (const f of readdirSync(d)) if (/\.(pdf|ai)$/i.test(f) && !/\.ref\.pdf$|encrypted|aes/.test(f)) inputs.push({ id: f, path: join(d, f) });
    const corpus = process.env.OMNIWEAVE_SIZE_CORPUS;
    if (corpus && existsSync(corpus)) {
      let n = 0;
      const walk = (d: string) => {
        for (const f of readdirSync(d).sort()) {
          const p = join(d, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (/\.(pdf|ai)$/i.test(f)) inputs.push({ id: `corpus-${++n}`, path: p });
        }
      };
      walk(corpus);
    }
    for (const inp of inputs) {
      const src = new Uint8Array(readFileSync(inp.path));
      const safe = inp.id.replace(/[^\w.-]/g, "_");
      writeFileSync(join(OUT, `${safe}.orig.pdf`), src);
      try {
        const { bytes, report } = await optimizePdf(src);
        if (report.effective) {
          writeFileSync(join(OUT, `${safe}.opt.pdf`), bytes);
          pairs.push({ id: `${inp.id} optimize`, a: `${safe}.orig.pdf`, b: `${safe}.opt.pdf` });
        }
      } catch {
        /* unreadable for pdf-lib: nothing to compare */
      }
      if (inp.id.startsWith("corpus") && src.length > 20e6) continue; // vector export of a huge file: skip
      try {
        const { asset, pages } = await importPdf(src, inp.id + ".pdf", /\.ai$/i.test(inp.path) ? "ai" : "pdf");
        const doc = newDocument("Omni pairs");
        doc.pages = pages;
        doc.assets = { [asset.id]: asset };
        writeFileSync(join(OUT, `${safe}.export.pdf`), await exportPdfVector(doc, pages, { fonts: FONTS, outline: false }));
        pairs.push({ id: `${inp.id} export`, a: `${safe}.orig.pdf`, b: `${safe}.export.pdf` });
      } catch {
        /* not importable */
      }
    }
    writeFileSync(join(OUT, "pairs.json"), JSON.stringify(pairs, null, 1));
  }, 900_000);
});
