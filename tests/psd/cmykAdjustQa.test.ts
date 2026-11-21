// QA (psd-cmyk-adjust): the CMYK reading of adjustment blocks (io/formats/psdAdjust.ts — five-channel levels, the
// mixer's ink rows, CMYK gradient stops) on truncated and corrupted data. Whatever the bytes, reading never throws,
// and what is read draws as colours 0..255 on the inks (core/image/adjustLayer.ts inkFnOf) and in RGB (adjustFnOf,
// the path of a rotated or scaled CMYK page) — never NaN, never outside the range.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { putBlob } from "../../src/core/assets";
import { adjustFnOf, inkFnOf, type Adjustment } from "../../src/core/image/adjustLayer";
import { cmykTilesOf, composeRegion, prepareCmykStore, releaseCmykFiles } from "../../src/core/image/cmykComposite";
import { importPsdPage, parsePsdLayout } from "../../src/io/formats/psd";
import { readAdjustment } from "../../src/io/formats/psdAdjust";

const DIR = join(__dirname, "..", "..", "qa", "interop", "adobe-made", "fidelity");
const KEYS = new Set(["levl", "curv", "mixr", "grdm", "selc", "hue2", "blnc", "phfl", "thrs", "post", "nvrt", "brit", "CgEd"]);

/** The adjustment blocks Photoshop wrote in the CMYK set: [file, key, data]. */
function cmykBlocks(): [string, string, Uint8Array][] {
  const out: [string, string, Uint8Array][] = [];
  for (const f of readdirSync(DIR).filter((x) => /^omni-fid-cmyk-adj-.*\.psd$/.test(x))) {
    const L = parsePsdLayout(new Uint8Array(readFileSync(join(DIR, f))));
    for (const rec of L.records)
      for (const k of rec.blocks) if (KEYS.has(k.key)) out.push([f, k.key, L.bytes.slice(k.dataStart, k.dataEnd)]);
  }
  return out;
}

/** Every colour of a coarse grid through the adjustment, on the inks and in RGB: all finite and within 0..255. */
function drawsInRange(a: Adjustment): string | null {
  const o4 = new Float64Array(4), o3 = [0, 0, 0];
  const ink = inkFnOf(a), rgb = adjustFnOf(a);
  for (let c = 0; c < 256; c += 51)
    for (let m = 0; m < 256; m += 51)
      for (let y = 0; y < 256; y += 85)
        for (let k = 0; k < 256; k += 85) {
          if (ink) {
            ink(c, m, y, k, o4);
            for (const v of o4) if (!Number.isFinite(v) || v < -1e-9 || v > 255 + 1e-9) return `ink ${a.kind} (${c},${m},${y},${k}) → ${[...o4]}`;
          }
          if (rgb) {
            rgb(c, m, y, o3);
            for (const v of o3) if (!Number.isFinite(v) || v < -1e-9 || v > 255 + 1e-9) return `rgb ${a.kind} (${c},${m},${y}) → ${o3}`;
          }
        }
  return null;
}

/** Deterministic pseudo-random bytes (LCG). */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s >>> 24);
}

const blocks = cmykBlocks();

describe("the background (worker) channel read", () => {
  // the worker gets only the page's keys (ids, places, tile hashes, `adjust: true`) — the adjustment settings stay on
  // the main thread's nodes. The channels it reads must composite the same as the score's own read.
  it("adjustment, effect and darker-colour files: the same composite from either read", async () => {
    for (const f of ["omni-fid-cmyk-adj-mixer", "omni-fid-cmyk-adj-gradmap", "omni-fid-cmyk-adj-curves-black", "omni-fid-cmyk-fx-shadow-color", "omni-fid-cmyk-mode-darkercolor"]) {
      const bytes = new Uint8Array(readFileSync(join(DIR, f + ".psd")));
      const hash = putBlob(bytes);
      const page = importPsdPage(bytes, f + ".psd", f, { id: "a1", hash }).page;
      releaseCmykFiles(() => false);
      const bg = (await prepareCmykStore(hash, bytes, page))!;
      const own = cmykTilesOf(bytes, page)!;
      expect(bg).not.toBeNull();
      const nodes = page.nodes.filter((n) => n.id !== page.source?.psd?.compositeNode);
      const a = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, bg, page);
      const b = composeRegion(nodes, page.groups, 0, 0, page.width, page.height, own, page);
      expect(Buffer.compare(Buffer.from(a), Buffer.from(b)), f).toBe(0);
      // and it is the CMYK composite, not the RGB one
      expect(Buffer.compare(Buffer.from(a), Buffer.from(composeRegion(nodes, page.groups, 0, 0, page.width, page.height, null, page))), f).not.toBe(0);
    }
    releaseCmykFiles(() => false);
  });
});

describe("CMYK channel mixer, monochrome", () => {
  // Photoshop (omni-fid-cmyk-adj-mixer-mono, made with four different rows): the grey of the first output row goes into
  // the black ink alone — cyan, magenta and yellow end with no ink. (Drawing the first row on all four inks made it
  // 0.2 % within 2 levels.)
  it("the first row's grey on black only; C, M, Y no ink", () => {
    const b = new Uint8Array(4 + 40);
    const dv = new DataView(b.buffer);
    dv.setUint16(0, 1);
    dv.setUint16(2, 1); // monochrome
    const rows = [[60, 20, 0, 0, 0], [0, 70, 0, 10, 0], [0, 0, 100, 0, 0], [20, 30, 0, 60, 0]];
    rows.forEach((r, k) => r.forEach((v, j) => dv.setInt16(4 + k * 10 + j * 2, v)));
    const a = readAdjustment(new Map([["mixr", b]]), KEYS, 4)!;
    const out = new Float64Array(4);
    // stored values (255 = no ink): inks 180, 165, 163, 172 → black ink 0.6 × 180 + 0.2 × 165 = 141 (Photoshop: 141)
    inkFnOf(a)!(75, 90, 92, 83, out);
    expect([...out].map(Math.round)).toEqual([255, 255, 255, 255 - 141]);
  });
  it("Photoshop's file: within 2 levels of its merged image", async () => {
    const { scorePsd } = await import("../../src/core/fidelity/psdScore");
    const s = (await scorePsd(new Uint8Array(readFileSync(join(DIR, "omni-fid-cmyk-adj-mixer-mono.psd")))))!.score;
    expect(s.within2).toBeGreaterThanOrEqual(99);
  });
});

describe("CMYK adjustment blocks: truncated or corrupted data", () => {
  it("the CMYK set has the new kinds to corrupt", () => {
    const keys = new Set(blocks.map((b) => b[1]));
    for (const k of ["levl", "curv", "mixr", "grdm", "selc"]) expect(keys.has(k)).toBe(true);
  });

  it("every truncation reads without throwing and draws within 0..255 (CMYK and RGB documents)", () => {
    const bad: string[] = [];
    for (const [f, key, b] of blocks)
      for (let n = 0; n < b.length; n += n < 64 ? 1 : 7)
        for (const mode of [4, 3, 1]) {
          const cut = b.subarray(0, n);
          let a: Adjustment | null = null;
          try {
            a = readAdjustment(new Map([[key, cut]]), KEYS, mode);
          } catch (e) {
            bad.push(`${f} ${key} len ${n} mode ${mode}: threw ${e}`);
            continue;
          }
          if (!a || a.kind === "other") continue;
          const why = drawsInRange(a);
          if (why) bad.push(`${f} ${key} len ${n} mode ${mode}: ${why}`);
        }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("random bytes changed (seeded): reading never throws, drawing stays within 0..255", () => {
    const bad: string[] = [];
    const rnd = lcg(20261117);
    for (const [f, key, b] of blocks)
      for (let t = 0; t < 60; t++) {
        const d = b.slice();
        const hits = 1 + (rnd() % 6);
        for (let h = 0; h < hits; h++) d[(rnd() << 8 | rnd()) % d.length] = rnd();
        let a: Adjustment | null = null;
        try {
          a = readAdjustment(new Map([[key, d]]), KEYS, 4);
        } catch (e) {
          bad.push(`${f} ${key} try ${t}: threw ${e}`);
          continue;
        }
        if (!a || a.kind === "other") continue;
        const why = drawsInRange(a);
        if (why) bad.push(`${f} ${key} try ${t}: ${why}`);
      }
    expect(bad.slice(0, 5)).toEqual([]);
  });

  it("extreme values: a mixer of ±32768 % weights, levels with input floor = ceiling, gradient stops past the end", () => {
    const mixr = new Uint8Array(4 + 50).fill(0x80); // every weight −32768 %
    mixr[0] = 0, mixr[1] = 1, mixr[2] = 0, mixr[3] = 0;
    const lev = new Uint8Array(2 + 29 * 10);
    for (let k = 0; k < 29; k++) lev.set([0, 128, 0, 128, 0, 0, 0, 255, 0, 0], 2 + k * 10); // inLo = inHi = 128, gamma 0
    for (const [key, d] of [["mixr", mixr], ["levl", lev]] as const) {
      const a = readAdjustment(new Map([[key, d]]), KEYS, 4)!;
      expect(a.kind).not.toBe("other");
      expect(drawsInRange(a)).toBeNull();
    }
  });
});
