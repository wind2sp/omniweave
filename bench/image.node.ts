// Image engine benchmark in plain Node (no vitest transform overhead — vitest runs this code ~3-5× slower).
//
//   npx esbuild bench/image.node.ts --bundle --platform=node --format=esm --outfile=<temp>/image-bench.mjs
//   node <temp>/image-bench.mjs
//
// Prints the best of 3 runs per case on 1000×1000 synthetic images (tests/image/scenes.ts).

import { applyOps, defaultParams, type ImageOp } from "../src/core/image/ops";
import { presetOptions, traceImage } from "../src/core/image/trace";
import { logo, photo } from "../tests/image/scenes";

function best<T>(f: () => T, n = 3): [T, number] {
  let ms = Infinity, v!: T;
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    v = f();
    ms = Math.min(ms, performance.now() - t0);
  }
  return [v, ms];
}

const bw = logo(false), col = logo(true), ph = photo(1000, 1000);
for (const [name, img, preset] of [["흑백 로고", bw, "logo"], ["윤곽선", bw, "outline"], ["색상 3", col, "color3"], ["색상 6", col, "color6"], ["색상 16", col, "color16"], ["사진(고충실) — 사진", ph, "photo"]] as const) {
  const [r, ms] = best(() => traceImage(img, presetOptions(preset)), preset === "photo" ? 1 : 3);
  console.log(`trace ${name} 1000×1000: ${ms.toFixed(0)} ms — layers ${r.layers.length}, paths ${r.paths}, anchors ${r.anchors}`);
}
const ops: ImageOp[] = [
  { op: "gaussianBlur", params: { radius: 10 } },
  { op: "gaussianBlur", params: { radius: 1.5 } },
  { op: "motionBlur", params: { angle: 30, distance: 20 } },
  { op: "unsharpMask", params: { amount: 120, radius: 1.5, threshold: 2 } },
  { op: "sharpen", params: defaultParams("sharpen") },
  { op: "median", params: { radius: 2 } },
  { op: "bilateral", params: { sigmaSpace: 2, sigmaRange: 25 } },
  { op: "pixelate", params: { cell: 12 } },
  { op: "emboss", params: defaultParams("emboss") },
  { op: "edgeDetect", params: defaultParams("edgeDetect") },
  { op: "vignette", params: defaultParams("vignette") },
  { op: "levels", params: { ...defaultParams("levels"), gamma: 1.4 } },
  { op: "curves", params: { rgb: [0, 0, 64, 50, 192, 210, 255, 255] } },
  { op: "brightnessContrast", params: { brightness: 10, contrast: 20 } },
  { op: "hueSaturation", params: { hue: 20, saturation: 30, lightness: 0 } },
  { op: "colorBalance", params: { shadows: [10, 0, -10], midtones: [0, 5, 0], highlights: [0, 0, 10], preserveLuminosity: 1 } },
  { op: "exposure", params: { exposure: 0.5 } },
  { op: "autoLevels", params: { clip: 0.1 } },
  { op: "autoColor", params: { clip: 0.1 } },
];
for (const o of ops) {
  const [, ms] = best(() => applyOps(ph, [o]));
  console.log(`${o.op} ${JSON.stringify(o.params)}: ${ms.toFixed(0)} ms`);
}
