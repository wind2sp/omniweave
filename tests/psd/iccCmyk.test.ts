// CMYK colour management (core/image/iccCmyk.ts): a CMYK document's embedded ICC profile evaluated as Photoshop shows
// it (relative colorimetric, black point compensation, to sRGB), the table's error against the profile itself, the
// way back through the profile's separation, the table kinds (lut8 / lut16 / lutAtoB, Lab and XYZ connection space),
// and the document paths: open (no notice), screen = merged image, save (unchanged pixels keep their inks, an edited
// one is separated through the profile and reads back as the edited colour).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { cmykStoreOf, cmykXformOf, composeRegion } from "../../src/core/image/cmykComposite";
import { cmykXform, defaultCmykProfile, iccInfo } from "../../src/core/image/iccCmyk";
import { loadDissolveField } from "../../src/core/style/blend";
import { makeTile } from "../../src/core/tile";
import { newDocument, type RasterNode } from "../../src/core/types";
import { decodePsd, importPsdPage, layerCmykPlanes, parsePsdLayout, psdCmykProfile, readCompositePlanes } from "../../src/io/formats/psd";
import { writePsd } from "../../src/io/formats/psdWrite";
import { cpuNow, cpuBudget, wallTimeout } from "../budget";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const file = (f: string) => new Uint8Array(readFileSync(join(DIR, f)));

/** The ICC profile Photoshop embedded in omni-fid-cmyk-blend.psd (its working CMYK: U.S. Web Coated (SWOP) v2). */
function swop(): Uint8Array {
  const b = file("omni-fid-cmyk-blend.psd");
  const r = parsePsdLayout(b).resItems.find((it) => it.id === 1039)!;
  return b.slice(r.dataStart, r.dataEnd);
}

/** Stored value (255 = no ink) of an ink percentage. */
const s = (pct: number) => Math.round(255 - pct * 2.55);

function rgbOf(x: NonNullable<ReturnType<typeof cmykXform>>, c: number, m: number, y: number, k: number): number[] {
  const o = new Uint8Array(3);
  x.rgb(s(c), s(m), s(y), s(k), o, 0);
  return [...o];
}

beforeAll(() => loadDissolveField());

describe("CMYK profile evaluation", () => {
  it("reads the embedded profile Photoshop wrote", () => {
    const info = iccInfo(swop())!;
    expect(info.space).toBe("CMYK");
    expect(info.pcs).toBe("Lab ");
    expect(info.tags.has("A2B1")).toBe(true);
    expect(psdCmykProfile(file("omni-fid-cmyk-blend.psd")).name).toBe("U.S. Web Coated (SWOP) v2");
  });

  it("gives Photoshop's colours for U.S. Web Coated (SWOP) v2 (relative colorimetric, black point compensation)", () => {
    // what Photoshop's Info panel / colour picker read for these inks (sRGB): the well-known SWOP values
    const x = cmykXform(swop(), "swop")!;
    expect(x).not.toBeNull();
    const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]), `${got} vs ${want}`).toBeLessThanOrEqual(1));
    near(rgbOf(x, 0, 0, 0, 0), [255, 255, 255]);
    near(rgbOf(x, 100, 0, 0, 0), [0, 174, 239]);
    near(rgbOf(x, 0, 100, 0, 0), [236, 0, 140]);
    near(rgbOf(x, 0, 0, 100, 0), [255, 242, 0]);
    near(rgbOf(x, 0, 0, 0, 100), [35, 31, 32]);
    near(rgbOf(x, 0, 100, 100, 0), [237, 28, 36]);
    near(rgbOf(x, 100, 0, 100, 0), [0, 166, 80]);
    near(rgbOf(x, 100, 100, 0, 0), [46, 48, 146]);
    near(rgbOf(x, 100, 100, 100, 100), [0, 0, 0]);
  });

  it("the cached table stays within 3 levels of the profile itself (99 % within 1)", () => {
    const x = cmykXform(swop(), "swop")!;
    let seed = 1;
    const rnd = () => ((seed = Math.imul(seed, 1103515245) + 12345) >>> 8) & 255;
    const o = new Uint8Array(3);
    let max = 0, within1 = 0, n = 0;
    for (let i = 0; i < 20000; i++) {
      const c = rnd(), m = rnd(), y = rnd(), k = rnd();
      x.rgb(c, m, y, k, o, 0);
      const e = x.exact(c, m, y, k);
      for (let j = 0; j < 3; j++) {
        const d = Math.abs(o[j] - Math.round(e[j]));
        max = Math.max(max, d);
        if (d <= 1) within1++;
        n++;
      }
    }
    expect(max).toBeLessThanOrEqual(3);
    expect(within1 / n).toBeGreaterThan(0.99);
  });

  it("separates a colour through the profile's B2A table, and it reads back as that colour", () => {
    const x = cmykXform(swop(), "swop")!;
    const ink = new Uint8Array(4), back = new Uint8Array(3);
    // Photoshop separates sRGB 0 174 239 into about 70 15 0 0 and pure red into 0 99 100 0
    x.cmyk(0, 174, 239, ink, 0);
    expect([...ink].map((v) => Math.round((255 - v) / 2.55))).toEqual([69, 14, 0, 0]);
    x.cmyk(255, 0, 0, ink, 0);
    expect([...ink].map((v) => Math.round((255 - v) / 2.55))).toEqual([0, 100, 100, 0]);
    // in-gamut colours (made from inks) come back within a few levels
    let worst = 0;
    for (const q of [[30, 20, 10, 0], [0, 60, 80, 10], [50, 0, 20, 30], [10, 10, 10, 60], [80, 40, 0, 0]]) {
      const rgb = rgbOf(x, q[0], q[1], q[2], q[3]);
      x.cmyk(rgb[0], rgb[1], rgb[2], ink, 0);
      x.rgb(ink[0], ink[1], ink[2], ink[3], back, 0);
      for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(back[j] - rgb[j]));
    }
    // (the profile's own B2A ∘ A2B round trip is not exact either: a few levels in the darks)
    expect(worst).toBeLessThanOrEqual(6);
  });

  it("refuses what it cannot evaluate (not CMYK, no A2B table) — the caller falls back to the default profile", () => {
    expect(cmykXform(new Uint8Array(200))).toBeNull();
    const p = swop();
    p[16] = 0x52; // 'RMYK': not a CMYK profile
    expect(cmykXform(p)).toBeNull();
    // the shipped default (FOGRA39, docs/legal/CMYK_PROFILES.md) is one this evaluates
    expect(cmykXform(defaultCmykProfile()!.bytes, "FOGRA39")).not.toBeNull();
  });
});

// ───────── synthetic profiles: the other table kinds ─────────

/** L* of an ink mix in the synthetic profiles: paper 100, each ink takes 25 (linear: every interpolation is exact). */
const Lof = (c: number, m: number, y: number, k: number) => 100 * (1 - 0.25 * (c + m + y + k));

/** A CMYK → Lab/XYZ profile with an A2B0 tag of `type` (and a B2A0), grid 2, neutral output (a = b = 0) with L* as above. */
function synthetic(type: "mft1" | "mft2" | "mAB ", version: number, pcs: "Lab " | "XYZ " = "Lab ", aCurve?: () => number[]): Uint8Array {
  const grid = 2, corners = 16;
  const vals: number[][] = [];
  for (let i = 0; i < corners; i++) {
    const c = (i >> 3) & 1, m = (i >> 2) & 1, y = (i >> 1) & 1, k = i & 1;
    vals.push([Lof(c, m, y, k), 0, 0]);
  }
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 255);
  const u16 = (v: number) => (u8(v >> 8), u8(v));
  const u32 = (v: number) => (u16(v >>> 16), u16(v & 0xffff));
  const sig = (t: string) => [...t].forEach((ch) => u8(ch.charCodeAt(0)));
  // Lab → the table's encoding
  const enc = (L: number, a: number, b: number): number[] => {
    if (pcs === "XYZ ") {
      // a neutral of that lightness as XYZ (D50), u1Fixed15 in 16 bits
      const fy = (L + 16) / 116;
      const Y = fy > 6 / 29 ? fy ** 3 : 3 * (6 / 29) ** 2 * (fy - 4 / 29);
      return [0.9642 * Y, Y, 0.8249 * Y].map((v) => Math.round(v * 32768));
    }
    if (type === "mft2") return [Math.round((L * 65280) / 100), Math.round((a + 128) * 256), Math.round((b + 128) * 256)];
    if (type === "mft1") return [Math.round((L * 255) / 100), Math.round(a + 128), Math.round(b + 128)];
    return [Math.round((L * 65535) / 100), Math.round(((a + 128) * 65535) / 255), Math.round(((b + 128) * 65535) / 255)];
  };
  sig(type);
  u32(0);
  u8(4);
  u8(3);
  if (type === "mAB ") {
    u16(0);
    // offsets: B curves, matrix, M curves, CLUT, A curves
    const bOff = 32, clutOff = bOff + 3 * 12, aOff = clutOff + 20 + corners * 3 * 2;
    u32(bOff);
    u32(0);
    u32(0);
    u32(clutOff);
    u32(aOff);
    for (let i = 0; i < 3; i++) (sig("curv"), u32(0), u32(0));
    for (let i = 0; i < 16; i++) u8(i < 4 ? grid : 0);
    u8(2);
    u8(0);
    u8(0);
    u8(0);
    for (const v of vals) enc(v[0], v[1], v[2]).forEach(u16);
    for (let i = 0; i < 4; i++) aCurve ? aCurve().forEach(u8) : (sig("curv"), u32(0), u32(0));
  } else {
    u8(grid);
    u8(0);
    for (let i = 0; i < 9; i++) u32(i % 4 === 0 ? 0x10000 : 0);
    const wide = type === "mft2";
    // identity curves: 2 entries (lut16), the fixed 256 (lut8)
    const n = wide ? 2 : 256;
    if (wide) (u16(n), u16(n));
    const put = wide ? u16 : u8;
    const max = wide ? 65535 : 255;
    const ramp = () => {
      for (let i = 0; i < n; i++) put(Math.round((i * max) / (n - 1)));
    };
    for (let c = 0; c < 4; c++) ramp();
    for (const v of vals) enc(v[0], v[1], v[2]).forEach(put);
    for (let c = 0; c < 3; c++) ramp();
  }
  return profile(version, pcs, [["A2B0", Uint8Array.from(bytes)], ["B2A0", b2a()]]);
}

/** A B2A table (lut16, grid 2): the first connection-space input 0 → all four inks full, 1 → none (L* 0 ↔ 400 %). */
function b2a(): Uint8Array {
  const bytes: number[] = [];
  const u16 = (v: number) => bytes.push((v >> 8) & 255, v & 255);
  const sig = (t: string) => [...t].forEach((ch) => bytes.push(ch.charCodeAt(0)));
  sig("mft2");
  bytes.push(0, 0, 0, 0, 3, 4, 2, 0);
  for (let i = 0; i < 9; i++) (u16(i % 4 === 0 ? 1 : 0), u16(0));
  u16(2);
  u16(2);
  for (let c = 0; c < 3; c++) (u16(0), u16(65535));
  for (let i = 0; i < 8; i++) for (let k = 0; k < 4; k++) u16(i & 4 ? 0 : 65535);
  for (let c = 0; c < 4; c++) (u16(0), u16(65535));
  return Uint8Array.from(bytes);
}

/** A profile (class prtr, CMYK) with these tags. */
function profile(version: number, pcs: string, tags: [string, Uint8Array][], space = "CMYK"): Uint8Array {
  const size = tags.reduce((s, [, t]) => s + ((t.length + 3) & ~3), 0);
  const p = new Uint8Array(132 + 12 * tags.length + size);
  const dv = new DataView(p.buffer);
  dv.setUint32(0, p.length);
  p[8] = version;
  p.set([..."prtr"].map((ch) => ch.charCodeAt(0)), 12);
  p.set([...space].map((ch) => ch.charCodeAt(0)), 16);
  p.set([...pcs].map((ch) => ch.charCodeAt(0)), 20);
  p.set([..."acsp"].map((ch) => ch.charCodeAt(0)), 36);
  dv.setUint32(128, tags.length);
  let at = 132 + 12 * tags.length;
  tags.forEach(([name, t], i) => {
    p.set([...name].map((ch) => ch.charCodeAt(0)), 132 + i * 12);
    dv.setUint32(136 + i * 12, at);
    dv.setUint32(140 + i * 12, t.length);
    p.set(t, at);
    at += (t.length + 3) & ~3;
  });
  return p;
}

/** 8-bit sRGB of a neutral with lightness L* (D50 white → sRGB white). */
function srgbOfL(L: number): number {
  const fy = (L + 16) / 116;
  const Y = fy > 6 / 29 ? fy ** 3 : 3 * (6 / 29) ** 2 * (fy - 4 / 29);
  const v = Y <= 0.0031308 ? 12.92 * Y : 1.055 * Y ** (1 / 2.4) - 0.055;
  return Math.round(255 * v);
}

describe("table kinds", () => {
  it("mAB (v4) with an XYZ connection space: the grid's corners give their lightness", () => {
    const x = cmykXform(synthetic("mAB ", 4, "XYZ "), "xyz")!;
    expect(x).not.toBeNull();
    for (const q of [[0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1], [1, 1, 0, 0], [1, 1, 1, 0]]) {
      const o = new Uint8Array(3);
      x.rgb(255 - q[0] * 255, 255 - q[1] * 255, 255 - q[2] * 255, 255 - q[3] * 255, o, 0);
      const want = srgbOfL(Lof(q[0], q[1], q[2], q[3]));
      for (let j = 0; j < 3; j++) expect(Math.abs(o[j] - want), `${q} ch${j}: ${o[j]} vs ${want}`).toBeLessThanOrEqual(2);
    }
  });

  for (const [type, version] of [["mft1", 2], ["mft2", 2], ["mAB ", 4]] as const)
    it(`${type.trim()} (v${version}, Lab): neutral inks give the profile's lightness`, () => {
      const x = cmykXform(synthetic(type, version), type)!;
      expect(x).not.toBeNull();
      // the darkest mix is L* 0 (black point 0: no compensation), so the grey of each mix is its own L*
      for (const q of [[0, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 1], [0.5, 0.5, 0, 0], [1, 1, 1, 0], [0.2, 0.4, 0.6, 0.8]]) {
        const o = new Uint8Array(3);
        x.rgb(255 - Math.round(q[0] * 255), 255 - Math.round(q[1] * 255), 255 - Math.round(q[2] * 255), 255 - Math.round(q[3] * 255), o, 0);
        const L = Lof(Math.round(q[0] * 255) / 255, Math.round(q[1] * 255) / 255, Math.round(q[2] * 255) / 255, Math.round(q[3] * 255) / 255);
        const want = srgbOfL(L);
        for (let j = 0; j < 3; j++) expect(Math.abs(o[j] - want), `${type} ${q} ch${j}: ${o[j]} vs ${want}`).toBeLessThanOrEqual(2);
      }
    });
});

// ───────── damaged or hostile profiles: never throw, hang or allocate without bound — the honest notice instead ─────────

const be = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v >>> (8 * (n - 1 - i))) & 255);
const chars = (s: string) => [...s].map((ch) => ch.charCodeAt(0));
/** a 'para' curve element: function type and its s15Fixed16 parameters */
const para = (fn: number, ...v: number[]) => [...chars("para"), 0, 0, 0, 0, ...be(fn, 2), 0, 0, ...v.flatMap((x) => be(Math.round(x * 65536) | 0, 4))];

describe("damaged or hostile profiles", () => {
  it("truncated or corrupted bytes: null or a working transform, never an exception, never much slower than an intact one", () => {
    const base = swop();
    // the time limit is measured in the work an intact profile takes here and now (a loaded machine or a parallel test
    // run slows both alike; a fixed second failed at 1043 ms under load): the slowest of three intact builds — the
    // profile ID bytes changed so the transform cache does not answer — times 25, and never under 2 s. A hang or an
    // unbounded table still fails.
    let unit = 0;
    for (let k = 1; k <= 3; k++) {
      const p = base.slice();
      p[100] = k;
      const t = cpuNow();
      expect(cmykXform(p, `intact ${k}`)).not.toBeNull();
      unit = Math.max(unit, cpuNow() - t);
    }
    const limit = Math.max(2000, 25 * unit);
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) | 0) >>> 8);
    for (let i = 0; i < 90; i++) {
      const p = base.slice();
      let q: Uint8Array = p;
      if (i % 3 === 0) q = p.subarray(0, 132 + (rnd() % (p.length - 132)));
      else if (i % 3 === 1) for (let j = 0; j < 20; j++) p[132 + (rnd() % 400)] = rnd() & 255; // tag table
      else for (let j = 0; j < 50; j++) p[rnd() % p.length] = rnd() & 255;
      const t0 = cpuNow();
      const x = cmykXform(q, `fuzz ${i}`);
      if (x) {
        const o = new Uint8Array(4);
        x.rgb(10, 20, 30, 40, o, 0);
        x.cmyk(10, 200, 30, o, 0);
      }
      expect(cpuNow() - t0, `case ${i} (intact ${unit.toFixed(0)} ms)`).toBeLessThan(limit);
    }
  }, wallTimeout(120000));

  it("huge grid claims are refused before anything is allocated; zero or one grid point too", () => {
    // lut16 with 255 points on 4 inputs (12.7 G values) and lutAtoB with 255⁴: both refused by size, at once
    const mft2 = profile(2, "Lab ", [["A2B0", Uint8Array.from([...chars("mft2"), 0, 0, 0, 0, 4, 3, 255, 0, ...new Array(36).fill(0), 0, 2, 0, 2])], ["B2A0", b2a()]]);
    const mab = synthetic("mAB ", 4);
    const at = 144 + 12 + 32 + 36; // A2B0 data (after two tag entries), its CLUT
    const big = mab.slice();
    big.set([255, 255, 255, 255], at);
    const t0 = cpuNow();
    expect(cmykXform(mft2)).toBeNull();
    expect(cmykXform(big)).toBeNull();
    // refused before any table is built: far under one intact build (a fixed 200 ms bound, generous under load)
    expect(cpuNow() - t0).toBeLessThan(cpuBudget(2000));
    for (const g of [0, 1]) {
      const p = mab.slice();
      p[at + 1] = g;
      expect(cmykXform(p), `grid ${g}`).toBeNull();
    }
    expect(cmykXform(mab)).not.toBeNull();
  });

  it("parametric curves at their edges (a = 0, negative or huge exponents) give finite colours or none", () => {
    for (const curve of [para(1, 1, 0, 0), para(2, 2.2, 0, 0, 0.1), para(3, -2, 1, 0, 0, 0), para(4, 30000, 1, 0, -1, 0, 0, 0), para(0, 0), para(9, 1)]) {
      const x = cmykXform(synthetic("mAB ", 4, "Lab ", () => curve));
      if (!x) continue;
      const o = new Uint8Array(3);
      for (const v of [0, 1, 128, 254, 255]) x.rgb(v, v, v, v, o, 0);
    }
  });

  it("v4 curves pad to four bytes: a 3-entry curve (18 bytes) followed by more reads correctly", () => {
    const curv3 = () => [...chars("curv"), 0, 0, 0, 0, ...be(3, 4), ...be(0, 2), ...be(32768, 2), ...be(65535, 2), 0, 0];
    const x = cmykXform(synthetic("mAB ", 4, "Lab ", curv3))!;
    expect(x).not.toBeNull();
    const o = new Uint8Array(3);
    x.rgb(0, 255, 255, 255, o, 0); // 100 % cyan: L* 75
    for (const v of o) expect(Math.abs(v - srgbOfL(75))).toBeLessThanOrEqual(2);
  });

  it("RGB or Gray profiles, only an A2B or only a B2A table: not used", () => {
    const a2b = synthetic("mft2", 2);
    const info = iccInfo(a2b)!;
    const tag = (s: string) => a2b.slice(info.tags.get(s)!.at, info.tags.get(s)!.at + info.tags.get(s)!.size);
    expect(cmykXform(a2b)).not.toBeNull();
    expect(cmykXform(profile(2, "Lab ", [["A2B0", tag("A2B0")], ["B2A0", tag("B2A0")]], "RGB "))).toBeNull();
    expect(cmykXform(profile(2, "Lab ", [["A2B0", tag("A2B0")], ["B2A0", tag("B2A0")]], "GRAY"))).toBeNull();
    expect(cmykXform(profile(2, "Lab ", [["A2B0", tag("A2B0")]]))).toBeNull();
    expect(cmykXform(profile(2, "Lab ", [["B2A0", tag("B2A0")]]))).toBeNull();
  });

  it("a CMYK document with a damaged profile opens with the notice, its inks shown through the default profile", () => {
    const { warnings } = open("omni-fid-cmyk-blend.psd", (b) => {
      const r = parsePsdLayout(b).resItems.find((it) => it.id === 1039)!;
      // the colour tables claim 255 grid points on each of 4 inputs (a size bomb): refused
      const info = iccInfo(b.subarray(r.dataStart, r.dataEnd))!;
      for (const [name, t] of info.tags) if (/^(A2B|B2A)/.test(name)) b[r.dataStart + t.at + 10] = 255;
    });
    const w = warnings.filter((x) => /CMYK/.test(x));
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^들어 있는 프로필 'U\.S\. Web Coated \(SWOP\) v2'을 읽지 못해 기본 프로필\(FOGRA39\)로 보여 줍니다/);
  });
});

// ───────── documents ─────────

function open(f: string, patch?: (b: Uint8Array) => void) {
  const bytes = file(f);
  patch?.(bytes);
  const hash = putBlob(bytes);
  const r = importPsdPage(bytes, f, f, { id: "a1", hash });
  const doc = newDocument("t");
  doc.assets = { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: f, size: bytes.length } };
  doc.pages = [r.page];
  return { doc, page: r.page, warnings: r.warnings };
}

describe("colour-managed CMYK documents", () => {
  it("shows the merged image through the profile: 100 % cyan is not 0 255 255", () => {
    const b = file("omni-fid-cmyk-blend.psd");
    const L = parsePsdLayout(b);
    const img = decodePsd(b);
    const x = psdCmykProfile(b).xf!;
    // every merged-image pixel = the profile's colour of its stored inks
    const planes = readCompositePlanes(L, 4);
    const o = new Uint8Array(3);
    for (let i = 0; i < L.width * L.height; i += 97) {
      x.rgb(planes[0][i], planes[1][i], planes[2][i], planes[3][i], o, 0);
      expect([...img.composite!.subarray(i * 4, i * 4 + 3)]).toEqual([...o]);
    }
  });

  it("the screen composite (all tiles kept for a managed file) matches Photoshop's merged image", () => {
    const { doc, page } = open("omni-fid-cmyk-blend.psd");
    const store = cmykStoreOf(doc, page)!;
    expect(cmykXformOf(store)).not.toBeNull();
    const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
    const ours = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, store, page);
    const ref = decodePsd(file("omni-fid-cmyk-blend.psd")).composite!;
    let ok = 0;
    for (let i = 0; i < ref.length; i += 4) if ([0, 1, 2].every((c) => Math.abs(ours[i + c] - ref[i + c]) <= 2)) ok++;
    expect((100 * ok) / (ref.length / 4)).toBeGreaterThan(99.9);
  });

  it("unedited saves are the original bytes", async () => {
    for (const f of ["omni-fid-cmyk-blend.psd", "omni-fid-cmyk-curves.psd", "omni-fid-cmyk-normal-alpha.psd", "ps_cmyk_8bit.psd"]) {
      const bytes = f.startsWith("ps_") ? new Uint8Array(readFileSync(join(DIR, "..", f))) : file(f);
      const hash = putBlob(bytes);
      const r = importPsdPage(bytes, f, f, { id: "a1", hash });
      const doc = newDocument("t");
      doc.assets = { a1: { id: "a1", hash, mime: "image/vnd.adobe.photoshop", name: f, size: bytes.length } };
      doc.pages = [r.page];
      expect(psdCmykProfile(bytes).xf, f).not.toBeNull();
      const out = await writePsd(doc, r.page);
      expect(out.bytes.length, f).toBe(bytes.length);
      expect(Buffer.compare(Buffer.from(out.bytes), Buffer.from(bytes)), f).toBe(0);
    }
  });

  it("colours a level off the profile's (another engine's floating point) keep their inks: no B2A ∘ A2B round trip", async () => {
    const f = "omni-fid-cmyk-blend.psd";
    const { doc, page } = open(f);
    const L0 = parsePsdLayout(file(f));
    const links = page.source!.psd!.layers;
    const pick = page.nodes.map((x) => ({ x, i: links.findIndex((l) => l.node === x.id) })).find(({ x, i }) => x.type === "RASTER" && x.visible && !x.adjust && i >= 0 && Object.keys(x.tiles).length > 0)!;
    const n = pick.x as RasterNode;
    const before = layerCmykPlanes(L0, L0.records[pick.i])!;
    // every tile: each pixel's colour moved by one level (as an .omw from another engine could hold it)
    const tiles: RasterNode["tiles"] = {};
    for (const [k, t] of Object.entries(n.tiles)) {
      const d = new Uint8ClampedArray(t.data);
      for (let i = 0; i < d.length; i += 4) d[i] = d[i] < 255 ? d[i] + 1 : 254;
      tiles[k] = makeTile(d);
    }
    n.tiles = tiles;
    const out = await writePsd(doc, page);
    expect(out.warnings.filter((w) => w.includes("다시 나눠"))).toEqual([]);
    const L1 = parsePsdLayout(out.bytes);
    const after = layerCmykPlanes(L1, L1.records[pick.i])!;
    let differ = 0;
    for (let i = 0; i < before.w * before.h; i++) if (before.a[i] && (before.c[i] !== after.c[i] || before.m[i] !== after.m[i] || before.y[i] !== after.y[i] || before.k[i] !== after.k[i])) differ++;
    expect(differ).toBe(0);
  });

  it("an edited pixel is separated through the profile and reads back as the edited colour; the rest keep their inks", async () => {
    const f = "omni-fid-cmyk-blend.psd";
    const { doc, page } = open(f);
    const L0 = parsePsdLayout(file(f));
    const links = page.source!.psd!.layers;
    const pick = page.nodes.map((x) => ({ x, i: links.findIndex((l) => l.node === x.id) })).find(({ x, i }) => x.type === "RASTER" && x.visible && !x.adjust && i >= 0 && Object.keys(x.tiles).length > 0)!;
    const n = pick.x as RasterNode;
    const before = layerCmykPlanes(L0, L0.records[pick.i])!;
    const key = Object.keys(n.tiles)[0];
    const data = new Uint8ClampedArray(n.tiles[key].data);
    let p = 0;
    while (data[p * 4 + 3] !== 255) p++;
    // a colour inside SWOP's gamut (a mid grey-blue)
    data.set([90, 110, 150], p * 4);
    n.tiles = { ...n.tiles, [key]: makeTile(data) };
    const out = await writePsd(doc, page);
    expect(out.warnings.filter((w) => w.includes("다시 나눠"))).toHaveLength(1);
    const back = decodePsd(out.bytes);
    expect(back.warnings.some((w) => /색 관리/.test(w))).toBe(false);
    const L1 = parsePsdLayout(out.bytes);
    const saved = back.layers.find((l) => l.name === n.name)!;
    const after = layerCmykPlanes(L1, L1.records[saved.index])!;
    const rec0 = L0.records[pick.i], rec1 = L1.records[saved.index];
    const [tx, ty] = key.split("_").map(Number);
    const ex = tx * 256 + (p % 256) + n.transform.x, ey = ty * 256 + Math.floor(p / 256) + n.transform.y;
    let differ = 0, same = 0;
    for (let y = 0; y < after.h; y++)
      for (let x = 0; x < after.w; x++) {
        const gx = x + rec1.left, gy = y + rec1.top, ox = gx - rec0.left, oy = gy - rec0.top;
        if (ox < 0 || oy < 0 || ox >= before.w || oy >= before.h || !after.a[y * after.w + x] || (gx === ex && gy === ey)) continue;
        const s0 = oy * before.w + ox, d = y * after.w + x;
        if (before.c[s0] === after.c[d] && before.m[s0] === after.m[d] && before.y[s0] === after.y[d] && before.k[s0] === after.k[d]) same++;
        else differ++;
      }
    expect(differ).toBe(0);
    expect(same).toBeGreaterThan(100);
    const i = ((ey - saved.top) * saved.width + (ex - saved.left)) * 4;
    const got = Array.from(saved.rgba!.subarray(i, i + 3));
    [90, 110, 150].forEach((v, j) => expect(Math.abs(got[j] - v), `${got}`).toBeLessThanOrEqual(4));
  });
});
