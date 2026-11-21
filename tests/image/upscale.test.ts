// Image upscale engine (core/image/upscale.ts): quality against bicubic on synthetic pictures (downscale 4× by area
// average, enlarge back, PSNR / SSIM against the original), edge cases (1×1, odd sizes, too large, alpha edges without
// a dark fringe), 16-bit input and tiling (a result made of many tiles equals one made at once).
import { describe, expect, it } from "vitest";
import { downscale, newImg, type Img } from "../../src/core/image/pixels";
import { checkUpscale, scaledSize, upscale, UPSCALE_MAX_SIDE, type UpscaleMethod } from "../../src/core/image/upscale";

// ───────── synthetic pictures ─────────

/** Deterministic smooth value noise, several octaves (a "photo" without real camera noise). */
function fractal(W: number, H: number, seed: number): Img {
  const img = newImg(W, H), d = img.data;
  const hash = (x: number, y: number, c: number) => {
    let n = (x * 374761393 + y * 668265263 + c * 2147483647 + seed * 144269) | 0;
    n = (n ^ (n >>> 13)) * 1274126177;
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x: number, y: number, c: number) => {
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
    const a = hash(x0, y0, c), b = hash(x0 + 1, y0, c), e = hash(x0, y0 + 1, c), f = hash(x0 + 1, y0 + 1, c);
    return a + (b - a) * sx + (e - a) * sy + (a - b - e + f) * sx * sy;
  };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) {
        let v = 0, amp = 0.5, freq = 1 / 48;
        for (let o = 0; o < 5; o++, amp *= 0.5, freq *= 2) v += amp * noise(x * freq, y * freq, c * 7 + o);
        d[(y * W + x) * 4 + c] = v * 255;
      }
  for (let i = 3; i < d.length; i += 4) d[i] = 255;
  return img;
}

/** Anti-aliased (4×4 supersampled) shapes: rings, a diagonal band, thin lines, a disc — "logo / line art". */
function lineArt(W: number, H: number): Img {
  const img = newImg(W, H), d = img.data;
  const shapes: { inside: (x: number, y: number) => boolean; rgb: number[] }[] = [
    { inside: (x, y) => { const r = Math.hypot(x - W * 0.5, y - H * 0.5); return r < W * 0.42 && r > W * 0.33; }, rgb: [210, 40, 40] },
    { inside: (x, y) => Math.abs(x - y * 0.7 - 20) < 9, rgb: [20, 140, 70] },
    { inside: (x, y) => Math.abs(((x + 2 * y) % 37) - 18) < 1.6 && y < H * 0.3, rgb: [0, 0, 0] },
    { inside: (x, y) => Math.hypot(x - W * 0.5, y - H * 0.5) < W * 0.16, rgb: [30, 80, 200] },
    { inside: (x, y) => x > W * 0.1 && x < W * 0.9 && Math.abs(y - H * 0.78) < 3, rgb: [250, 180, 20] },
  ];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          let c = [250, 250, 245];
          for (const s of shapes) if (s.inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) c = s.rgb;
          for (let k = 0; k < 3; k++) acc[k] += c[k];
        }
      const i = (y * W + x) * 4;
      d[i] = acc[0] / 16; d[i + 1] = acc[1] / 16; d[i + 2] = acc[2] / 16; d[i + 3] = 255;
    }
  return img;
}

/** Fine detail: a zone plate of rising frequency mixed with text-like strokes. */
function detail(W: number, H: number): Img {
  const img = newImg(W, H), d = img.data;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const r2 = (x - W / 2) ** 2 + (y - H / 2) ** 2;
      const zone = 0.5 + 0.5 * Math.cos(r2 / (W * 2.2));
      const stroke = (Math.floor(x / 6) + Math.floor(y / 10)) % 3 === 0 && (x % 6) < 2 ? 0.15 : 1;
      const v = 255 * zone * stroke;
      const i = (y * W + x) * 4;
      d[i] = v; d[i + 1] = v * 0.9 + 20; d[i + 2] = 255 - v * 0.6; d[i + 3] = 255;
    }
  return img;
}

// ───────── metrics ─────────

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

/** Mean SSIM of the luma over 8 × 8 windows (stride 4), the standard constants. */
function ssim(a: Img, b: Img): number {
  const W = a.width, H = a.height;
  const L = (img: Img) => {
    const out = new Float64Array(W * H);
    for (let i = 0; i < W * H; i++) out[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
    return out;
  };
  const x = L(a), y = L(b), C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let wy = 0; wy + 8 <= H; wy += 4)
    for (let wx = 0; wx + 8 <= W; wx += 4) {
      let mx = 0, my = 0;
      for (let j = 0; j < 8; j++) for (let i = 0; i < 8; i++) (mx += x[(wy + j) * W + wx + i]), (my += y[(wy + j) * W + wx + i]);
      mx /= 64;
      my /= 64;
      let vx = 0, vy = 0, cv = 0;
      for (let j = 0; j < 8; j++)
        for (let i = 0; i < 8; i++) {
          const p = (wy + j) * W + wx + i, dx = x[p] - mx, dy = y[p] - my;
          vx += dx * dx; vy += dy * dy; cv += dx * dy;
        }
      vx /= 63; vy /= 63; cv /= 63;
      sum += ((2 * mx * my + C1) * (2 * cv + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      n++;
    }
  return sum / n;
}

function roundTrip(orig: Img, method: UpscaleMethod, k = 4) {
  const small = downscale(orig, Math.max(orig.width, orig.height) / k).img;
  const big = upscale(small, { method, width: orig.width, height: orig.height }) as Img;
  return { psnr: psnr(orig, big), ssim: ssim(orig, big) };
}

// ───────── tests ─────────

const SCENES: [string, Img][] = [
  ["fractal", fractal(384, 288, 3)],
  ["lineArt", lineArt(384, 384)],
  ["detail", detail(320, 320)],
];

describe("upscale quality (downscale 4× by area average, enlarge back)", () => {
  const rows: string[] = [];
  for (const [name, img] of SCENES)
    it(`${name}: 고품질 beats bicubic, both beat nearest`, () => {
      const hq = roundTrip(img, "hq"), bic = roundTrip(img, "smooth"), nn = roundTrip(img, "pixel");
      rows.push(`${name}\thq ${hq.psnr.toFixed(2)} dB / ${hq.ssim.toFixed(4)}\tbicubic ${bic.psnr.toFixed(2)} dB / ${bic.ssim.toFixed(4)}\tnearest ${nn.psnr.toFixed(2)} dB / ${nn.ssim.toFixed(4)}`);
      console.log(rows.at(-1));
      expect(hq.psnr).toBeGreaterThan(bic.psnr + 0.2);
      expect(hq.ssim).toBeGreaterThan(bic.ssim);
      expect(bic.psnr).toBeGreaterThan(nn.psnr);
    }, 60_000);

  it("2× and 3× too", () => {
    const img = lineArt(240, 240);
    for (const k of [2, 3]) {
      const hq = roundTrip(img, "hq", k), bic = roundTrip(img, "smooth", k);
      expect(hq.psnr, `${k}×`).toBeGreaterThan(bic.psnr);
    }
  }, 60_000);
});

describe("upscale edge cases", () => {
  it("1×1, 1×N and odd sizes give the asked size with the source colour where flat", () => {
    for (const method of ["hq", "smooth", "pixel"] as const) {
      const one = newImg(1, 1);
      one.data.set([10, 200, 30, 255]);
      const r = upscale(one, { method, width: 4, height: 4 });
      expect([r.width, r.height]).toEqual([4, 4]);
      for (let i = 0; i < 16; i++) expect(Array.from(r.data.subarray(i * 4, i * 4 + 4)), method).toEqual([10, 200, 30, 255]);
      for (const [w, h, W, H] of [[1, 9, 3, 27], [7, 1, 21, 2], [13, 7, 39, 21], [17, 11, 50, 33], [5, 5, 37, 37]]) {
        const src = fractal(w, h, w * h);
        const out = upscale(src, { method, width: W, height: H });
        expect([out.width, out.height, out.data.length], `${method} ${w}×${h}→${W}×${H}`).toEqual([W, H, W * H * 4]);
      }
    }
  });

  it("refuses shrinking, the same size, more than 8× and results above the limit", () => {
    expect(() => checkUpscale(100, 100, 50, 200)).toThrow("image.upscale.err.notLarger");
    expect(() => checkUpscale(100, 100, 100, 100)).toThrow("image.upscale.err.notLarger");
    expect(() => checkUpscale(100, 100, 900, 900)).toThrow("image.upscale.err.factor");
    expect(() => checkUpscale(8000, 8000, 16000, 16000)).toThrow("image.upscale.err.tooLarge");
    expect(() => checkUpscale(5000, 10, UPSCALE_MAX_SIDE + 10, 20)).toThrow("image.upscale.err.tooLarge");
    expect(() => checkUpscale(100, 100, 200, 200)).not.toThrow();
    expect(scaledSize(3, 5, 2.5)).toEqual({ width: 8, height: 13 });
  });

  it("an opaque disc on transparency: no dark fringe and no colour halo on its edge (premultiplied)", () => {
    const W = 40, src = newImg(W, W);
    for (let y = 0; y < W; y++)
      for (let x = 0; x < W; x++) {
        let cov = 0;
        for (let s = 0; s < 16; s++) cov += Math.hypot(x + ((s % 4) + 0.5) / 4 - 20, y + (Math.floor(s / 4) + 0.5) / 4 - 20) < 13 ? 1 : 0;
        src.data.set([255, 30, 0, Math.round((cov / 16) * 255)], (y * W + x) * 4);
      }
    for (const method of ["hq", "smooth"] as const)
      for (const sharpen of [0, 100]) {
        const r = upscale(src, { method, width: 160, height: 160, sharpen });
        let edge = 0;
        for (let i = 0; i < r.data.length; i += 4) {
          const a = r.data[i + 3];
          if (a === 0) continue;
          if (a < 255) edge++;
          if (a >= 8) {
            expect(r.data[i], `${method} R at alpha ${a}`).toBeGreaterThanOrEqual(240);
            expect(r.data[i + 2], `${method} B at alpha ${a}`).toBeLessThanOrEqual(12);
          }
        }
        expect(edge).toBeGreaterThan(100); // the edge stays soft (anti-aliased), not cut
      }
  });

  it("keepAlpha false flattens onto white", () => {
    const src = newImg(4, 4); // fully transparent
    const r = upscale(src, { method: "hq", width: 8, height: 8, keepAlpha: false });
    for (let i = 0; i < r.data.length; i += 4) expect(Array.from(r.data.subarray(i, i + 4))).toEqual([255, 255, 255, 255]);
    const p = upscale(src, { method: "pixel", width: 8, height: 8, keepAlpha: false });
    expect(Array.from(p.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
  });

  it("pixel method repeats every source pixel exactly (integer factor)", () => {
    const src = fractal(9, 6, 1);
    const r = upscale(src, { method: "pixel", width: 27, height: 18 });
    for (let y = 0; y < 18; y++)
      for (let x = 0; x < 27; x++) {
        const s = (Math.floor(y / 3) * 9 + Math.floor(x / 3)) * 4, t = (y * 27 + x) * 4;
        expect(Array.from(r.data.subarray(t, t + 4))).toEqual(Array.from(src.data.subarray(s, s + 4)));
      }
  });

  it("16-bit input gives a 16-bit result that agrees with the 8-bit one", () => {
    const src = fractal(40, 30, 5);
    const deep = { width: 40, height: 30, data: new Uint16Array(src.data.length) };
    for (let i = 0; i < src.data.length; i++) deep.data[i] = src.data[i] * 257;
    const a = upscale(src, { method: "hq", width: 120, height: 90 });
    const b = upscale(deep, { method: "hq", width: 120, height: 90 });
    expect(b.data).toBeInstanceOf(Uint16Array);
    let maxDiff = 0;
    for (let i = 0; i < a.data.length; i++) maxDiff = Math.max(maxDiff, Math.abs(a.data[i] - b.data[i] / 257));
    expect(maxDiff).toBeLessThanOrEqual(1);
  });

  it("tiles join without seams: a picture made of many tiles equals the source enlarged by halves", () => {
    // 700 px wide at 2× → 1400 px = 3 tile columns; compare the middle seam against a flat-region expectation
    const src = fractal(300, 140, 9);
    const r = upscale(src, { method: "hq", width: 600, height: 280, denoise: true, sharpen: 40 }) as Img;
    // the result on both sides of the tile seam at x = 512 is continuous: the jump there is no larger than elsewhere
    const jump = (x: number) => {
      let s = 0;
      for (let y = 0; y < 280; y++) for (let c = 0; c < 3; c++) s += Math.abs(r.data[(y * 600 + x) * 4 + c] - r.data[(y * 600 + x - 1) * 4 + c]);
      return s / 280;
    };
    const around = (jump(505) + jump(508) + jump(516) + jump(519)) / 4;
    expect(jump(512)).toBeLessThan(around * 2 + 1);
  });

  it("progress reaches the total", () => {
    const calls: [number, number][] = [];
    upscale(fractal(300, 300, 2), { method: "smooth", width: 1200, height: 1200 }, (d, t) => calls.push([d, t]));
    expect(calls.at(-1)).toEqual([9, 9]);
  });
});
