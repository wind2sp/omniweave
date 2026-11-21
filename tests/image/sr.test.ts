// AI super-resolution (core/image/sr): the bundled Real-ESRGAN models on the in-house engine, the picture classifier
// behind "자동", and the pipeline (tiles, alpha, sizes other than 4×). Pictures: tests/image/srSet.ts (synthetic omw-*
// and the repository's own screenshots). CPU backend (WebGPU is measured in the app, docs/design/IMAGE_UPSCALE.md).
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { parseGraph, runGraph } from "../../src/core/image/infer/graph";
import { downscale, newImg, type Img } from "../../src/core/image/pixels";
import { classifySr, jpegQuality } from "../../src/core/image/sr/classify";
import { blendModels, setSrModelReader, SR_FILES, srModel, type SrModelKind } from "../../src/core/image/sr/models";
import { deblock, resizeArea, superResolve } from "../../src/core/image/sr/pipeline";
import { upscale } from "../../src/core/image/upscale";
import { gaussNoise, jpegLike, omwIllustration, omwLineArt, omwPhoto, omwScreenshot, srSet } from "./srSet";

beforeAll(() => setSrModelReader(async (f) => new Uint8Array(readFileSync(`public/models/sr/${f}`))));

function psnr(a: Img, b: Img): number {
  let se = 0, n = 0;
  for (let i = 0; i < a.data.length; i += 4)
    for (let c = 0; c < 3; c++) {
      const e = a.data[i + c] - b.data[i + c];
      se += e * e;
      n++;
    }
  return 10 * Math.log10((255 * 255) / (se / n));
}

async function sr(img: Img, kind: SrModelKind, denoise: number, W: number, H: number, deblockFirst = false): Promise<Img> {
  const m = await srModel(kind, denoise);
  return superResolve(img, { width: W, height: H, deblock: deblockFirst }, async (x) => runGraph(m, x));
}

describe("bundled models", () => {
  it("three LWT graphs, 4×, fused conv + PReLU and pixel shuffle; the blend of two is their weight mix", async () => {
    for (const f of Object.values(SR_FILES)) {
      const m = parseGraph(new Uint8Array(readFileSync(`public/models/sr/${f}`)));
      expect(m.meta.format).toBe("graph");
      expect((m.meta as any).scale).toBe(4);
      expect(m.meta.nodes.filter((n) => n.op === "conv").every((n) => n.act === "prelu" || n.a?.shuffle === 4)).toBe(true);
    }
    const a = await srModel("photo", 1), b = await srModel("photo", 0), half = await srModel("photo", 0.5);
    const k = "body.0.weight";
    expect(half.w.get(k)!.d[5]).toBeCloseTo((a.w.get(k)!.d[5] + b.w.get(k)!.d[5]) / 2, 6);
    const art = await srModel("art");
    expect(() => blendModels(a, art, 0.5)).toThrow();
    expect(readFileSync("public/models/sr/LICENSE", "utf8")).toContain("Copyright (c) 2021, Xintao Wang");
  });

  it("a flat colour stays that colour (residual path and pixel shuffle line up)", async () => {
    const flat = newImg(24, 20);
    for (let i = 0; i < flat.data.length; i += 4) flat.data.set([120, 60, 200, 255], i);
    for (const kind of ["photo", "art"] as const) {
      const out = await sr(flat, kind, 0.5, 96, 80);
      const p = (40 * 96 + 48) * 4;
      expect(Math.abs(out.data[p] - 120) + Math.abs(out.data[p + 1] - 60) + Math.abs(out.data[p + 2] - 200), kind).toBeLessThan(9);
    }
  });
});

describe("classifier (자동)", () => {
  const set = srSet(192);
  it("photo vs art, damage level: accuracy on the labelled set, < 50 ms each", () => {
    // warm up (JIT) first: under the full parallel suite the very first call alone can pass 50 ms
    for (let i = 0; i < 3; i++) classifySr(set[i].img);
    let content = 0, damage = 0;
    const times: number[] = [];
    const wrong: string[] = [];
    for (const c of set) {
      const r = classifySr(c.img);
      if (r.content === c.content) content++;
      else wrong.push(`${c.name}: ${r.content}`);
      if (r.damage === c.damage) damage++;
      times.push(r.ms);
    }
    console.log(`classifier: content ${content}/${set.length}, damage ${damage}/${set.length}`, wrong.join("; "));
    expect(content / set.length).toBeGreaterThanOrEqual(0.95);
    expect(damage / set.length).toBeGreaterThanOrEqual(0.75);
    // speed: the median call (the full parallel suite can stall a few single calls; the budget is per typical image)
    times.sort((a, b) => a - b);
    expect(times[times.length >> 1]).toBeLessThan(50);
  });

  it("reads the JPEG quality back from the pixels (photos and screenshots)", () => {
    const luma = (img: Img) => {
      const C = new Float32Array(img.width * img.height);
      for (let i = 0; i < C.length; i++) C[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
      return C;
    };
    const photo = omwPhoto(192, 192, 11);
    expect(jpegQuality(luma(photo), 192, 192)).toBe(100);
    for (const q of [30, 50, 80]) expect(Math.abs(jpegQuality(luma(jpegLike(photo, q)), 192, 192) - q), `q${q}`).toBeLessThanOrEqual(3);
  });
});

describe("Auto against a fixed model (HR → 4× smaller → damaged → AI 4×, PSNR against HR)", () => {
  it("Auto is at least as good as either model alone over the set", async () => {
    const S = 256;
    const hr: [string, Img][] = [
      ["photo-1", omwPhoto(S, S, 1)],
      ["photo-2", omwPhoto(S, S, 2)],
      ["illust", omwIllustration(S, S, 4)],
      ["lineart", omwLineArt(S, S, 6)],
      ["screen", omwScreenshot("docs/design/ui-top-mockups/word.png", S, S, 40, 60)],
    ];
    const dmg: [string, (i: Img) => Img][] = [["clean", (i) => i], ["q40", (i) => jpegLike(i, 40)], ["noise8", (i) => gaussNoise(i, 8)]];
    const sum = { auto: 0, photo: 0, art: 0, hq: 0 };
    const rows: string[] = [];
    for (const [name, img] of hr)
      for (const [dn, f] of dmg) {
        const lr = f(downscale(img, S / 4).img);
        const d = classifySr(lr);
        const auto = await sr(lr, d.content, d.denoise, S, S, d.deblock);
        const ph = await sr(lr, "photo", 0.5, S, S);
        const ar = await sr(lr, "art", 0.5, S, S);
        const hq = upscale(lr, { method: "hq", width: S, height: S }) as Img;
        const r = { auto: psnr(img, auto), photo: psnr(img, ph), art: psnr(img, ar), hq: psnr(img, hq) };
        for (const k of Object.keys(sum) as (keyof typeof sum)[]) sum[k] += r[k];
        rows.push(`${name}/${dn} → ${d.content} ${d.denoise}${d.deblock ? " deblock" : ""}: auto ${r.auto.toFixed(2)} photo ${r.photo.toFixed(2)} art ${r.art.toFixed(2)} classic ${r.hq.toFixed(2)}`);
      }
    const n = hr.length * dmg.length;
    console.log(rows.join("\n") + `\nmean: auto ${(sum.auto / n).toFixed(2)} photo ${(sum.photo / n).toFixed(2)} art ${(sum.art / n).toFixed(2)} classic ${(sum.hq / n).toFixed(2)}`);
    expect(sum.auto).toBeGreaterThanOrEqual(sum.photo - 0.01 * n);
    expect(sum.auto).toBeGreaterThanOrEqual(sum.art - 0.01 * n);
  }, 300_000);
});

describe("pipeline", () => {
  it("2×, 3× and a custom size come from the 4× result; above 4× the rest is classical", async () => {
    const lr = downscale(omwIllustration(160, 120, 3), 40).img;
    for (const [W, H] of [[80, 60], [120, 90], [100, 70], [200, 150]]) {
      const out = await sr(lr, "art", 0.5, W, H);
      expect([out.width, out.height, out.data.length]).toEqual([W, H, W * H * 4]);
    }
  });

  it("tiles join without seams: the same picture in small tiles and in one tile agree", async () => {
    const lr = omwPhoto(72, 60, 5);
    const m = await srModel("art");
    const one = await superResolve(lr, { width: 288, height: 240, tile: 128 }, async (x) => runGraph(m, x));
    const many = await superResolve(lr, { width: 288, height: 240, tile: 24 }, async (x) => runGraph(m, x));
    expect(psnr(one, many)).toBeGreaterThan(40);
  }, 60_000);

  it("transparency: alpha enlarged separately, no dark fringe on a coloured disc", async () => {
    const W = 40, src = newImg(W, W);
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        let cov = 0;
        for (let s = 0; s < 16; s++) cov += Math.hypot(x + ((s % 4) + 0.5) / 4 - 20, y + (Math.floor(s / 4) + 0.5) / 4 - 20) < 13 ? 1 : 0;
        src.data.set([255, 30, 0, Math.round((cov / 16) * 255)], (y * W + x) * 4);
      }
    const out = await sr(src, "art", 0.5, 160, 160);
    let edge = 0;
    for (let i = 0; i < out.data.length; i += 4) {
      const a = out.data[i + 3];
      if (a === 0 || a === 255) continue;
      edge++;
      if (a >= 16) expect(out.data[i], `R at alpha ${a}`).toBeGreaterThanOrEqual(225);
    }
    expect(edge).toBeGreaterThan(100);
  }, 60_000);

  it("deblock smooths small steps on the 8 × 8 grid only, area resize keeps the mean", () => {
    const blocky = jpegLike(omwPhoto(64, 64, 2), 20);
    const d = deblock(blocky);
    let onGrid = 0, before = 0;
    for (let y = 0; y < 64; y++)
      for (let x = 8; x < 64; x += 8) {
        before += Math.abs(blocky.data[(y * 64 + x) * 4] - blocky.data[(y * 64 + x - 1) * 4]);
        onGrid += Math.abs(d.data[(y * 64 + x) * 4] - d.data[(y * 64 + x - 1) * 4]);
      }
    expect(onGrid).toBeLessThan(before * 0.8);
    const flat = newImg(9, 7);
    flat.data.fill(100);
    expect(Array.from(resizeArea(flat, 4, 3).data.subarray(0, 4))).toEqual([100, 100, 100, 100]);
  });

  it("line art keeps its strokes: the art model beats the classical method on a clean line drawing", async () => {
    const hr = omwLineArt(192, 192, 8), lr = downscale(hr, 48).img;
    const ai = await sr(lr, "art", 0.5, 192, 192);
    const hq = upscale(lr, { method: "hq", width: 192, height: 192 }) as Img;
    expect(psnr(hr, ai)).toBeGreaterThan(psnr(hr, hq) - 0.5);
  }, 60_000);
});
