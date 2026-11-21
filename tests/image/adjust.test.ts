import { describe, expect, it } from "vitest";
import * as A from "../../src/core/image/adjust";
import { applyOps, defaultParams, normalizeOp, OPS } from "../../src/core/image/ops";
import { canvas, gradient, px } from "./helpers";

const monotone = (l: Uint8Array) => l.every((v, i) => i === 0 || v >= l[i - 1]);

describe("levels", () => {
  it("identity at defaults, input stretch and output range", () => {
    expect(Array.from(A.levelsLut({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 }))).toEqual(Array.from(A.identityLut()));
    const l = A.levelsLut({ inBlack: 50, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 });
    expect([l[0], l[50], l[125], l[200], l[255]]).toEqual([0, 0, 128, 255, 255]); // (125−50)/150·255 = 127.5 → 128
    const o = A.levelsLut({ inBlack: 0, inWhite: 255, gamma: 1, outBlack: 20, outWhite: 220 });
    expect([o[0], o[255]]).toEqual([20, 220]);
  });

  it("gamma follows v^(1/γ): γ = 2 maps 64 → round(255·(64/255)^0.5) = 128", () => {
    const l = A.levelsLut({ inBlack: 0, inWhite: 255, gamma: 2, outBlack: 0, outWhite: 255 });
    expect(l[64]).toBe(Math.round(255 * Math.sqrt(64 / 255)));
    expect(monotone(l)).toBe(true);
  });

  it("single-channel levels leave the other channels alone and alpha untouched", () => {
    const img = canvas(2, 1, [100, 100, 100], 77);
    const out = A.levels(img, { channel: 1, inBlack: 0, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 });
    expect(px(out, 0, 0)).toEqual([128, 100, 100, 77]);
  });
});

describe("curves (Fritsch–Carlson monotone cubic)", () => {
  it("passes through every control point", () => {
    const pts = [0, 0, 64, 40, 128, 150, 200, 210, 255, 255];
    const l = A.curveLut(pts);
    for (let i = 0; i < pts.length; i += 2) expect(l[pts[i]]).toBe(pts[i + 1]);
  });

  it("monotone control points always give a monotone LUT (no overshoot)", () => {
    const rnd = (s: number) => () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const r = rnd(42);
    for (let t = 0; t < 200; t++) {
      const n = 2 + Math.floor(r() * 6);
      const xs = Array.from({ length: n }, () => Math.round(r() * 255)).sort((a, b) => a - b);
      const ys = Array.from({ length: n }, () => Math.round(r() * 255)).sort((a, b) => a - b);
      const pts: number[] = [];
      xs.forEach((x, i) => pts.push(x, ys[i]));
      const l = A.curveLut(pts);
      expect(monotone(l)).toBe(true);
      expect(Math.max(...l)).toBeLessThanOrEqual(Math.max(...ys));
      expect(Math.min(...l)).toBeGreaterThanOrEqual(Math.min(...ys));
    }
  });

  it("a steep S-curve stays within [0,255] and flat outside the end points", () => {
    const l = A.curveLut([30, 0, 100, 10, 155, 245, 225, 255]);
    expect(l[0]).toBe(0);
    expect(l[255]).toBe(255);
    expect(monotone(l)).toBe(true);
  });

  it("channel curve then composite curve", () => {
    const img = canvas(1, 1, [100, 100, 100]);
    const out = A.curves(img, { r: [0, 0, 100, 200, 255, 255], rgb: [0, 0, 255, 128] });
    // R: 100 → 200 → (composite, linear 128/255) 100 ; G/B: 100 → 50
    expect(px(out, 0, 0).slice(0, 3)).toEqual([100, 50, 50]);
    // two points = straight line (Hermite with secant slopes)
    expect(A.curveLut([0, 0, 255, 128])[200]).toBe(Math.round((200 * 128) / 255));
  });
});

describe("brightness / contrast", () => {
  it("brightness adds, contrast pivots on mid grey", () => {
    const l = A.brightnessContrastLut(20, 0);
    expect([l[0], l[100], l[250]]).toEqual([20, 120, 255]);
    const c = A.brightnessContrastLut(0, 50); // k = 1/(1 − 0.495)
    expect(c[128]).toBe(128);
    expect(c[100]).toBe(Math.round((100 - 127.5) / 0.505 + 127.5));
    expect(new Set(A.brightnessContrastLut(0, -100)).size).toBe(1); // −100 → flat grey
    expect(monotone(c)).toBe(true);
  });
});

describe("HSL", () => {
  it("round-trips RGB within 1 unit", () => {
    for (const c of [[255, 0, 0], [12, 200, 77], [128, 128, 128], [0, 0, 0], [255, 255, 255], [240, 10, 250]]) {
      const [h, s, l] = A.rgbToHsl(c[0], c[1], c[2]);
      const back = A.hslToRgb(h, s, l).map(Math.round);
      back.forEach((v, i) => expect(Math.abs(v - c[i])).toBeLessThanOrEqual(1));
    }
  });

  it("hue +120° turns red into green; saturation −100 gives grey; lightness +100 gives white", () => {
    const red = canvas(1, 1, [255, 0, 0]);
    expect(px(A.hueSaturation(red, { hue: 120, saturation: 0, lightness: 0 }), 0, 0)).toEqual([0, 255, 0, 255]);
    const g = px(A.hueSaturation(red, { hue: 0, saturation: -100, lightness: 0 }), 0, 0);
    expect(g[0]).toBe(g[1]);
    expect(g[1]).toBe(g[2]);
    expect(px(A.hueSaturation(red, { hue: 0, saturation: 0, lightness: 100 }), 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it("colorize paints a grey with the chosen hue but keeps its lightness", () => {
    const grey = canvas(1, 1, [128, 128, 128]);
    const out = px(A.hueSaturation(grey, { hue: -180, saturation: 0, lightness: 0, colorize: 1 }), 0, 0); // absolute hue 0 = red
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(Math.round((Math.max(...out.slice(0, 3)) + Math.min(...out.slice(0, 3))) / 2)).toBeCloseTo(128, -1);
  });
});

describe("colour balance", () => {
  it("zero is identity; midtone red lifts R of mid grey but not of black or white", () => {
    const img = gradient(256, 1);
    expect(Array.from(A.colorBalance(img, { shadows: [0, 0, 0], midtones: [0, 0, 0], highlights: [0, 0, 0] }).data)).toEqual(Array.from(img.data));
    const greys = canvas(3, 1, [0, 0, 0]);
    greys.data.set([128, 128, 128, 255], 4);
    greys.data.set([255, 255, 255, 255], 8);
    const out = A.colorBalance(greys, { shadows: [0, 0, 0], midtones: [50, 0, 0], highlights: [0, 0, 0] });
    expect(px(out, 0, 0)[0]).toBe(0);
    expect(px(out, 1, 0)[0]).toBeGreaterThan(150);
    expect(px(out, 2, 0)[0]).toBe(255);
  });

  it("preserve luminosity keeps HSL lightness", () => {
    const img = canvas(1, 1, [128, 128, 128]);
    const o = px(A.colorBalance(img, { shadows: [0, 0, 0], midtones: [60, 0, 0], highlights: [0, 0, 0], preserveLuminosity: 1 }), 0, 0);
    expect(Math.abs((Math.max(o[0], o[1], o[2]) + Math.min(o[0], o[1], o[2])) / 2 - 128)).toBeLessThanOrEqual(1);
    expect(o[0]).toBeGreaterThan(o[1]);
  });
});

describe("exposure (linear light)", () => {
  it("sRGB transfer round-trips and +1 stop doubles linear light", () => {
    for (let i = 0; i <= 255; i += 15) expect(A.linearToSrgb(A.srgbToLinear(i / 255)) * 255).toBeCloseTo(i, 6);
    const l = A.exposureLut(1);
    const x = 100;
    expect(l[x]).toBe(Math.round(A.linearToSrgb(Math.min(1, A.srgbToLinear(x / 255) * 2)) * 255));
    expect(Array.from(A.exposureLut(0))).toEqual(Array.from(A.identityLut()));
    expect(monotone(A.exposureLut(-2.5))).toBe(true);
  });
});

describe("black & white, temperature, invert, posterize, threshold", () => {
  it("channel mix 30/59/11 gives Rec.601 grey", () => {
    const out = px(A.blackWhite(canvas(1, 1, [200, 100, 40]), { r: 30, g: 59, b: 11 }), 0, 0);
    const v = 0.3 * 200 + 0.59 * 100 + 0.11 * 40; // 123.4
    expect(out).toEqual([Math.round(v), Math.round(v), Math.round(v), 255]);
  });

  it("warm temperature raises R and lowers B; tint + lowers G", () => {
    const o = px(A.temperatureTint(canvas(1, 1, [100, 100, 100]), { temperature: 50, tint: 50 }), 0, 0);
    expect(o).toEqual([110, 90, 90, 255]);
  });

  it("invert twice is identity; posterize 2 → 0/255; threshold by luma", () => {
    const g = gradient(64, 64);
    expect(Array.from(A.invert(A.invert(g)).data)).toEqual(Array.from(g.data));
    expect(new Set(Array.from(A.posterize(gradient(256, 1), { levels: 2 }).data.filter((_, i) => i % 4 === 0)))).toEqual(new Set([0, 255]));
    expect(px(A.threshold(canvas(1, 1, [200, 200, 200]), { level: 128 }), 0, 0)).toEqual([255, 255, 255, 255]);
  });
});

describe("automatic corrections", () => {
  const dull = () => {
    const img = gradient(256, 4);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = 60 + (img.data[i] >> 1); // 60..187
      img.data[i + 1] = 80 + (img.data[i] >> 2);
      img.data[i + 2] = 40 + (img.data[i] >> 2);
    }
    return img;
  };

  it("auto levels stretches every channel to 0..255", () => {
    const out = A.autoLevels(dull(), { clip: 0 });
    for (let c = 0; c < 3; c++) {
      const v = Array.from(out.data.filter((_, i) => i % 4 === c));
      expect(Math.min(...v)).toBe(0);
      expect(Math.max(...v)).toBe(255);
    }
  });

  it("auto contrast uses one table for all channels (grey stays grey)", () => {
    const img = canvas(4, 1, [100, 100, 100]);
    img.data.set([150, 150, 150, 255], 4);
    const out = A.autoContrast(img, { clip: 0 });
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(px(out, 1, 0)).toEqual([255, 255, 255, 255]);
  });

  it("auto colour removes a uniform colour cast (channel means converge)", () => {
    const img = gradient(256, 16);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = img.data[i];
      img.data[i] = Math.min(255, 30 + v * 0.8);
      img.data[i + 1] = v * 0.7;
      img.data[i + 2] = v * 0.5;
    }
    const out = A.autoColor(img, { clip: 0.1 });
    const mean = (c: number, d: Uint8ClampedArray) => d.filter((_, i) => i % 4 === c).reduce((a, b) => a + b, 0) / (d.length / 4);
    const before = [0, 1, 2].map((c) => mean(c, img.data)), after = [0, 1, 2].map((c) => mean(c, out.data));
    expect(Math.max(...after) - Math.min(...after)).toBeLessThan((Math.max(...before) - Math.min(...before)) / 3);
  });

  it("transparent pixels are ignored by the histogram", () => {
    const img = canvas(2, 1, [100, 100, 100]);
    img.data.set([0, 0, 0, 0], 4);
    img.data.set([200, 200, 200, 255], 0);
    const out = A.autoContrast(img, { clip: 0 });
    expect(px(out, 1, 0)[3]).toBe(0);
  });
});

describe("op registry", () => {
  it("defaults of every adjustment are the identity (except the destructive ones)", () => {
    const img = gradient(64, 64);
    const notIdentity = new Set(["invert", "posterize", "threshold", "blackWhite", "autoLevels", "autoContrast", "autoColor", "vignette", "gaussianBlur", "motionBlur", "unsharpMask", "sharpen", "median", "bilateral", "pixelate", "emboss", "edgeDetect"]);
    for (const def of OPS) {
      if (notIdentity.has(def.id)) continue;
      const out = applyOps(img, [{ op: def.id, params: defaultParams(def.id) }]);
      expect(Array.from(out.data), def.id).toEqual(Array.from(img.data));
    }
  });

  it("normalizeOp rejects unknown ops, clamps ranges and fills defaults (action records are safe to replay)", () => {
    expect(normalizeOp({ op: "nope", params: {} })).toBeNull();
    const o = normalizeOp({ op: "gaussianBlur", params: { radius: 9999 } })!;
    expect(o.params.radius).toBe(250);
    expect(normalizeOp({ op: "levels", params: {} })!.params).toMatchObject({ inBlack: 0, inWhite: 255, gamma: 1 });
    expect(JSON.parse(JSON.stringify(o))).toEqual(o); // JSON-safe
  });

  it("every op keeps image size and leaves fully transparent pixels transparent", () => {
    const img = gradient(40, 30);
    for (let i = 3; i < img.data.length; i += 16) img.data[i] = 0;
    for (const def of OPS) {
      const out = applyOps(img, [{ op: def.id, params: defaultParams(def.id) }]);
      expect([out.width, out.height], def.id).toEqual([40, 30]);
      if (def.point) for (let i = 3; i < img.data.length; i += 16) expect(out.data[i], def.id).toBe(0);
    }
  });
});
