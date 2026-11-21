// Dev-only: rebuilds tests/fixtures/matte/u2netp-ref.bin (the ONNX Runtime reference outputs the numerics test
// compares against). Skipped in normal runs.
//   1. LOOM_FIX=dump LOOM_FIX_DIR=<dir> npx vitest run tests/infer/fixture.dev.test.ts   → <dir>/in<i>.f32
//   2. python -I scripts/u2netp-reference.py <u2netp.onnx> <dir> --inputs                → <dir>/ref<i>.f32
//   3. LOOM_FIX=pack LOOM_FIX_DIR=<dir> npx vitest run tests/infer/fixture.dev.test.ts   → fixture (8-bit, deflated)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { it } from "vitest";
import { zlibSync } from "fflate";
import { preprocess } from "../../src/core/image/infer";
import { FIXTURE_CASES } from "./fixtureCases";

const MODE = process.env.LOOM_FIX, DIR = process.env.LOOM_FIX_DIR;

it.runIf(!!MODE && !!DIR)("u2netp reference fixture", () => {
  const dir = DIR!;
  if (MODE === "dump") {
    mkdirSync(dir, { recursive: true });
    FIXTURE_CASES().forEach((img, i) => {
      const x = preprocess(img);
      writeFileSync(`${dir}/in${i}.f32`, new Uint8Array(x.buffer));
    });
    return;
  }
  const n = FIXTURE_CASES().length;
  // outputs are in 0..1: 8 bits (±0.002) is far below the fp16-weights error the test bounds
  const q = new Uint8Array(n * 320 * 320);
  for (let i = 0; i < n; i++) {
    const b = readFileSync(`${dir}/ref${i}.f32`);
    const ref = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    for (let j = 0; j < ref.length; j++) q[i * 320 * 320 + j] = Math.round(Math.min(1, Math.max(0, ref[j])) * 255);
  }
  mkdirSync("tests/fixtures/matte", { recursive: true });
  writeFileSync("tests/fixtures/matte/u2netp-ref.bin", zlibSync(q, { level: 9 }));
});
