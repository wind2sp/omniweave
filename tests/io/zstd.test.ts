import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { xxh64, zstdCompress, zstdDecompress, zstdStoredFrame } from "../../src/io/zstd";

const level = (b: Uint8Array, l: number, extra: Record<number, number> = {}) =>
  new Uint8Array(zstdCompressSync(b, { params: { [constants.ZSTD_c_compressionLevel]: l, ...extra } }));
const AIF = "qa/interop/adobe-made/ai-fidelity";

/** the zstd frame of an .ai's private data (after the '%AI24_ZStandard_Data' head) */
function aiPrivateFrame(path: string): Buffer | null {
  const b = readFileSync(path);
  const s = b.toString("latin1");
  const refs = [...s.matchAll(/\/AIPrivateData(\d+) (\d+) 0 R/g)].sort((a, c) => +a[1] - +c[1]).map((m) => m[2]);
  if (!refs.length) return null;
  const parts = refs.map((n) => {
    const at = s.search(new RegExp(`(^|[\\r\\n])${n} 0 obj`));
    const st = s.indexOf("stream", at) + 6;
    const start = st + (s[st] === "\r" ? 2 : 1);
    return b.subarray(start, start + Number(/\/Length (\d+)/.exec(s.slice(at, st))![1]));
  });
  const all = Buffer.concat(parts);
  return all.subarray(0, 20).toString("latin1") === "%AI24_ZStandard_Data" ? all.subarray(20) : null;
}

/** small deterministic PRNG */
const rng = (seed: number) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;

describe("zstd", () => {
  const text = new Uint8Array(readFileSync("src/io/pdfsurgeon/write.ts"));
  const rnd = new Uint8Array(300_000).map((_, i) => (i * 2654435761) >>> 24);
  const mixed = new Uint8Array([...text, ...rnd.subarray(0, 50_000), ...text, ...new Uint8Array(70_000).fill(7)]);
  for (const l of [1, 3, 9, 19]) {
    it(`decodes node's zstd level ${l}`, () => {
      for (const src of [text, rnd, mixed, new Uint8Array(0), Uint8Array.of(65)]) expect(zstdDecompress(level(src, l))).toEqual(src);
    });
  }
  it("decodes every Illustrator private data in the Adobe-made samples like node does", () => {
    let n = 0;
    for (const f of readdirSync(AIF)) {
      const z = aiPrivateFrame(`${AIF}/${f}`);
      if (!z) continue;
      expect(Buffer.from(zstdDecompress(new Uint8Array(z))).equals(zstdDecompressSync(z)), f).toBe(true);
      n++;
    }
    expect(n).toBeGreaterThan(30);
  });
  it("verifies the content checksum and the content size", () => {
    const f = level(mixed, 3, { [constants.ZSTD_c_checksumFlag]: 1 });
    expect(zstdDecompress(f)).toEqual(mixed);
    const bad = f.slice();
    bad[bad.length - 1] ^= 1;
    expect(() => zstdDecompress(bad)).toThrow(/checksum/);
    // XXH64 against node's own checksum for short and long inputs
    for (const len of [0, 1, 3, 4, 7, 8, 31, 32, 33, 100]) {
      const src = text.subarray(0, len);
      const g = level(src, 1, { [constants.ZSTD_c_checksumFlag]: 1 });
      const want = new DataView(g.buffer).getUint32(g.length - 4, true);
      expect(Number(xxh64(src) & 0xffffffffn), `len ${len}`).toBe(want);
    }
    const sized = level(text, 3);
    const lie = sized.slice();
    expect((lie[4] >> 6) & 3).toBeGreaterThan(0); // node writes the content size
    lie[(lie[4] >> 5) & 1 ? 5 : 6] ^= 1; // one byte of the content size
    expect(() => zstdDecompress(lie)).toThrow();
  });
  it("multiple frames, skippable frames and dictionary frames", () => {
    const a = level(text, 3), b = level(rnd.subarray(0, 1000), 3);
    const skip = Uint8Array.of(0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9);
    expect(zstdDecompress(new Uint8Array([...a, ...skip, ...b]))).toEqual(new Uint8Array([...text, ...rnd.subarray(0, 1000)]));
    expect(() => zstdDecompress(new Uint8Array([...a, ...skip.subarray(0, 9)]))).toThrow();
    expect(() => zstdDecompress(new Uint8Array([...a, 1, 2]))).toThrow();
    // dictionary id 1 in the frame header
    expect(() => zstdDecompress(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x21, 0x01, 0x00, 0x01, 0x00, 0x00))).toThrow(/dictionar/);
  });
  it("caps the output size (RLE blocks cannot blow up memory)", () => {
    // a frame of many 128 KiB RLE blocks: 4 bytes in, 128 KiB out each
    const blocks: number[] = [];
    const n = 64;
    for (let i = 0; i < n; i++) {
      const h = (131072 << 3) | (1 << 1) | (i === n - 1 ? 1 : 0);
      blocks.push(h & 255, (h >> 8) & 255, (h >> 16) & 255, 0x41);
    }
    const f = Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, ...blocks);
    expect(zstdDecompress(f).length).toBe(n * 131072);
    expect(() => zstdDecompress(f, 1_000_000)).toThrow(/limit/);
    // a block bigger than the RFC's 128 KiB is refused
    const big = (131073 << 3) | 2 | 1;
    expect(() => zstdDecompress(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, big & 255, (big >> 8) & 255, big >> 16, 0x41))).toThrow();
    // a lying 4 GiB content size is refused before anything is allocated
    expect(() => zstdDecompress(Uint8Array.of(0x28, 0xb5, 0x2f, 0xfd, 0xa0, 0xff, 0xff, 0xff, 0xff, 1, 0, 0))).toThrow(/limit/);
  });
  it("truncated or corrupted input throws a clean error and never hangs", () => {
    const srcs = [level(text, 19), level(mixed, 3), aiPrivateFrame(`${AIF}/omni-ai-import-layers.ai`)!.subarray(0, 40_000), zstdCompress(text)];
    const r = rng(7);
    let thrown = 0;
    const t0 = Date.now();
    for (const src of srcs) {
      for (let cut = 0; cut < src.length; cut += Math.max(1, (src.length / 97) | 0)) {
        try {
          zstdDecompress(new Uint8Array(src.subarray(0, cut)));
        } catch (e) {
          expect((e as Error).message).toMatch(/^zstd: /);
          thrown++;
        }
      }
      for (let k = 0; k < 400; k++) {
        const b = new Uint8Array(src);
        const flips = 1 + ((r() * 4) | 0);
        for (let j = 0; j < flips; j++) b[(r() * b.length) | 0] ^= 1 << ((r() * 8) | 0);
        try {
          zstdDecompress(b, 64 << 20);
        } catch (e) {
          expect((e as Error).message).toMatch(/^zstd: /);
          thrown++;
        }
      }
    }
    expect(thrown).toBeGreaterThan(1000);
    // a hang would hit the test timeout; alone this takes about 2 s
    expect(Date.now() - t0).toBeLessThan(150_000);
  }, 200_000);
  it("random garbage after a valid magic throws cleanly", () => {
    const r = rng(11);
    for (let k = 0; k < 3000; k++) {
      const n = 6 + ((r() * 300) | 0);
      const b = new Uint8Array(n).map(() => (r() * 256) | 0);
      b.set([0x28, 0xb5, 0x2f, 0xfd]);
      b[4] &= ~8; // no reserved bit
      b[4] &= ~3; // no dictionary
      try {
        zstdDecompress(b, 8 << 20);
      } catch (e) {
        expect((e as Error).message).toMatch(/^zstd: /);
      }
    }
  });
  it("compressed frames round-trip through node's decoder and ours, and actually compress", () => {
    const native = zstdDecompress(new Uint8Array(aiPrivateFrame(`${AIF}/omni-ai-text.ai`)!));
    const runs = new Uint8Array(400_000).map((_, i) => (i >> 12) & 3);
    for (const src of [text, rnd, mixed, native, runs, new Uint8Array(0), Uint8Array.of(65), new Uint8Array(131072).fill(1), new Uint8Array(131073).fill(2)]) {
      const f = zstdCompress(src);
      expect(new Uint8Array(zstdDecompressSync(f))).toEqual(src);
      expect(zstdDecompress(f)).toEqual(src);
    }
    expect(zstdCompress(native).length).toBeLessThan(native.length / 3);
    expect(zstdCompress(rnd).length).toBeLessThan(rnd.length + 100);
  });
  it("stored frames round-trip through node's decoder", () => {
    for (const src of [text, mixed, new Uint8Array(0), new Uint8Array(131072).fill(1)]) {
      const f = zstdStoredFrame(src);
      expect(new Uint8Array(zstdDecompressSync(f))).toEqual(src);
      expect(zstdDecompress(f)).toEqual(src);
    }
  });
  it("rejects garbage", () => {
    expect(() => zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5))).toThrow();
    expect(() => zstdDecompress(new Uint8Array(0))).toThrow();
  });
});
