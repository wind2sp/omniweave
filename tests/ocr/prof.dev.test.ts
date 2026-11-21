// Dev-only profile: OCR_DIR=<dir> npx vitest run tests/ocr/prof.dev.test.ts
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { parseGraph, runGraph, type RunStats } from "../../src/core/image/infer/graph";
import { recInput } from "../../src/core/image/ocr/recognize";
import { readRgba } from "./sample.dev.test";

const DIR = process.env.OCR_DIR;

it.runIf(!!DIR)("profile rec", () => {
  let t0 = performance.now();
  const m = parseGraph(new Uint8Array(readFileSync(`${DIR}/models/ppocr-rec-ko.lwt`)));
  console.log("parse", (performance.now() - t0).toFixed(0));
  const img = readRgba(`${DIR}/samples/ko_line.rgba`);
  for (let k = 0; k < 3; k++) {
    const st: RunStats = { ms: 0, peakBytes: 0, perOp: {} };
    runGraph(m, recInput(img).x, st);
    console.log(st.ms.toFixed(0), JSON.stringify(Object.fromEntries(Object.entries(st.perOp!).map(([k, v]) => [k, Math.round(v)]))));
  }
});
