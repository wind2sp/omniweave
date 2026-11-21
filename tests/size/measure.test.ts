// File-size measurement (docs/design/FILE_SIZE.md). Skipped in the normal `npm test`; run with
//   OMNIWEAVE_SIZE=1 [OMNIWEAVE_SIZE_CORPUS=<dir>] [OMNIWEAVE_SIZE_OUT=<file.json>] npx vitest run tests/size/measure.test.ts
// For every input: original size, .omw size broken down by part, "save in the original format" size and vector-PDF
// export size. Personal corpus files are reported as "corpus#n" only.

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it } from "vitest";
import { useStore } from "../../src/core/store";
import { useHistory } from "../../src/core/history";
import { newDocument } from "../../src/core/types";
import { sameTypeExport } from "../../src/io/formats";
import { packOmw } from "../../src/io/omw";
import { exportPdfVector } from "../../src/io/pdfVector";
import { optimizePdf } from "../../src/io/pdfOptimize";
import { importFile, lastImport } from "../../src/ui/actions";
import { installDom, installPdfWorker } from "../coverage/helpers";
import { omwParts } from "./zipParts";

const ENABLED = !!process.env.OMNIWEAVE_SIZE;
const ROOT = process.cwd();
const SKIP_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg", "mp4", "webm", "mov", "avi", "mkv", "mp3", "wav", "ogg", "flac", "aac", "m4a", "tif", "tiff", "heic", "heif", "bat", "log", "txt", "json", "xml", "yaml", "md", "srt", "csv", "html"]);
const FONTS = { regular: new Uint8Array(readFileSync("assets/fonts/Pretendard-Regular.ttf")), bold: new Uint8Array(readFileSync("assets/fonts/Pretendard-Bold.ttf")) };

interface Input {
  id: string;
  path: string;
}

function inputs(): Input[] {
  const out: Input[] = [];
  const walk = (d: string, set: string) => {
    for (const f of readdirSync(d).sort()) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) {
        if (f !== "_source") walk(p, set);
      } else if (!/\.ref\.pdf$|\.(md|json|png)$/i.test(f) && !SKIP_EXT.has(f.split(".").pop()!.toLowerCase())) out.push({ id: `${set}/${relative(d, p)}`, path: p });
    }
  };
  walk(join(ROOT, "qa/interop/adobe-made"), "adobe");
  walk(join(ROOT, "qa/interop/omniweave-made"), "omw-made");
  walk(join(ROOT, "docs/demo"), "demo");
  const corpus = process.env.OMNIWEAVE_SIZE_CORPUS;
  if (corpus && existsSync(corpus)) {
    let n = 0;
    const all: string[] = [];
    const w = (d: string) => {
      for (const f of readdirSync(d).sort()) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) w(p);
        else all.push(p);
      }
    };
    w(corpus);
    for (const p of all) {
      const ext = p.split(".").pop()!.toLowerCase();
      if (SKIP_EXT.has(ext) || /README|FIDELITY/i.test(p)) continue;
      out.push({ id: `corpus#${++n}.${ext}`, path: p });
    }
  }
  return out;
}

const S = () => useStore.getState();

describe.skipIf(!ENABLED)("file size", () => {
  it("measures", async () => {
    installDom();
    await installPdfWorker();
    const rows: any[] = [];
    for (const inp of inputs()) {
      const bytes = new Uint8Array(readFileSync(inp.path));
      const row: any = { id: inp.id, orig: bytes.length };
      try {
        S().load(newDocument());
        const ext = inp.path.split(".").pop()!.toLowerCase();
        await importFile({ name: inp.path.split(/[\\/]/).pop()!, path: null, bytes, ...(/(encrypted|enc-|aes)/.test(inp.id) ? {} : {}) } as any);
        if (lastImport?.error) {
          row.error = String(lastImport.error).slice(0, 80);
          rows.push(row);
          continue;
        }
        const doc = S().doc;
        const t0 = performance.now();
        const omw = packOmw(doc, useHistory.getState().entries).bytes;
        row.packMs = Math.round(performance.now() - t0);
        row.omw = omw.length;
        row.parts = omwParts(omw);
        const page = doc.pages[0];
        const same = page && sameTypeExport(page);
        if (same && ext !== "omw") {
          try {
            const out = await same.run(doc, page, { confirm: () => true });
            row.same = typeof out === "string" ? out.length : out.length;
          } catch (e) {
            row.same = "err:" + String(e).slice(0, 60);
          }
        }
        try {
          row.pdf = (await exportPdfVector(doc, doc.pages, { fonts: FONTS })).length;
        } catch (e) {
          row.pdf = "err:" + String(e).slice(0, 60);
        }
      } catch (e) {
        row.error = String(e).slice(0, 80);
      }
      rows.push(row);
      console.log(JSON.stringify({ id: row.id.startsWith("corpus") ? row.id : row.id, orig: row.orig, omw: row.omw, same: row.same, pdf: row.pdf, err: row.error }));
    }
    const out = process.env.OMNIWEAVE_SIZE_OUT;
    if (out) writeFileSync(out, JSON.stringify(rows, null, 1));
  }, 1_800_000);

  it("optimizePdf on the PDF / AI inputs (\"최적화하여 저장\" without edits)", async () => {
    const rows: any[] = [];
    for (const inp of inputs().filter((i) => /\.(pdf|ai)$/i.test(i.path))) {
      const bytes = new Uint8Array(readFileSync(inp.path));
      try {
        const t0 = performance.now();
        const { report } = await optimizePdf(bytes);
        rows.push({ id: inp.id, ...report, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        rows.push({ id: inp.id, error: String(e).slice(0, 60) });
      }
      console.log(JSON.stringify(rows[rows.length - 1]));
    }
    const out = process.env.OMNIWEAVE_SIZE_OUT;
    if (out) writeFileSync(out.replace(/\.json$/, "-pdfopt.json"), JSON.stringify(rows, null, 1));
  }, 1_800_000);
});
