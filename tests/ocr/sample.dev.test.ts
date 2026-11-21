// Dev-only: checks the converted PP-OCRv5 models against the outputs published on their official model cards.
//   OCR_DIR=<dir with models/*.lwt and samples/*.rgba> npx vitest run tests/ocr/sample.dev.test.ts
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseGraph } from "../../src/core/image/infer/graph";
import { recognizeLine } from "../../src/core/image/ocr/recognize";
import type { Img } from "../../src/core/image/pixels";

const DIR = process.env.OCR_DIR;

export function readRgba(p: string): Img {
  const b = readFileSync(p);
  const w = b.readUInt32LE(0), h = b.readUInt32LE(4);
  return { width: w, height: h, data: new Uint8ClampedArray(b.buffer, b.byteOffset + 8, w * h * 4) };
}

it.runIf(!!DIR)("korean rec: model-card sample line", () => {
  for (const f of ["ppocr-rec-ko.lwt", "ppocr-rec-ko-i8.lwt"]) {
    const m = parseGraph(new Uint8Array(readFileSync(`${DIR}/models/${f}`)));
    const img = readRgba(`${DIR}/samples/ko_line.rgba`);
    const t0 = performance.now();
    const raw = recognizeLine(m, img, { spaces: false });
    const sp = recognizeLine(m, img);
    console.log(f, JSON.stringify(raw.text), raw.conf.toFixed(4), "| spaces:", JSON.stringify(sp.text), `${(performance.now() - t0).toFixed(0)} ms`);
    // published: '리에 씨가 자기는돈이 많이있는다고 했어요', score 0.9142
    expect(raw.text).toBe("리에 씨가 자기는돈이 많이있는다고 했어요");
  }
});
