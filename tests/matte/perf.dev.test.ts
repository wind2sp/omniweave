// Dev-only timing: 12 MP photo end to end on the CPU path (LOOM_PERF=1 npx vitest run tests/matte/perf.dev.test.ts).
import { readFileSync } from "node:fs";
import { it } from "vitest";
import { setModelBytes } from "../../src/core/image/infer";
import { removeBackground } from "../../src/core/image/matte/pipeline";
import { newImg, type Img } from "../../src/core/image/pixels";
import { graphicCase, portraitCase, productCase } from "./synth";

/** bilinear upscale + a little noise, so a 12 MP picture has real per-pixel detail */
function upscale(src: Img, W: number, H: number): Img {
  const out = newImg(W, H);
  let s = 1;
  for (let y = 0; y < H; y++) {
    const fy = Math.min(src.height - 1.001, (y * src.height) / H), y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.min(src.width - 1.001, (x * src.width) / W), x0 = Math.floor(fx), tx = fx - x0;
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const n = ((s >> 16) & 7) - 3.5;
      for (let c = 0; c < 4; c++) {
        const g = (yy: number, xx: number) => src.data[(yy * src.width + xx) * 4 + c];
        const v = (g(y0, x0) * (1 - tx) + g(y0, x0 + 1) * tx) * (1 - ty) + (g(y0 + 1, x0) * (1 - tx) + g(y0 + 1, x0 + 1) * tx) * ty;
        out.data[(y * W + x) * 4 + c] = c === 3 ? v : v + n;
      }
    }
  }
  return out;
}

it.runIf(!!process.env.LOOM_PERF)("12 MP end to end", async () => {
  setModelBytes(new Uint8Array(readFileSync("src/assets/models/u2netp.lwt")));
  for (const [name, c] of [["portrait", portraitCase(11)], ["product", productCase(11)], ["graphic", graphicCase(11)]] as const) {
    const big = upscale(c.img, 4000, 3000);
    const r = await removeBackground(big, { backend: "cpu" });
    console.log(`${name} 4000×3000: type ${r.type}, total ${r.ms.total.toFixed(0)} ms (classify ${r.ms.classify.toFixed(0)}, AI ${r.ms.ai.toFixed(0)} ${r.backend ?? ""}, refine/key ${r.ms.refine.toFixed(0)})`);
  }
}, 600_000);
