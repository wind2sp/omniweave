// SHX shape fonts read from the user's installation (src/io/formats/cad/shx.ts, shxLoad.ts): the parser on fonts made
// here byte by byte (no Autodesk file in the repository), the stroke font built from them, and — when this computer has
// AutoCAD's Fonts folder — the real txt / romans / whgtxt read in place (never copied).

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pairGlyph, parseShx, shxCode, shxGlyph, shxKeyOf } from "../../src/io/formats/cad/shx";
import { loadDrawingShx, resetShxCache } from "../../src/io/formats/cad/shxLoad";
import { registerShxPair, strokeAdvance, strokeFontTtf, strokeVariantOf, STROKE_SHX } from "../../src/io/formats/cad/strokeFont";
import { fontFamily } from "../../src/io/formats/cad/build";

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le16 = (v: number) => [v & 255, (v >> 8) & 255];
const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];

/** a unifont: shape 0 = name + above, below, modes, encoding, type, 0; then the shapes */
function unifont(shapes: Record<number, number[]>, above = 10, below = 3): Uint8Array {
  const info = [...ascii("TEST"), 0, above, below, 0, 0, 0, 0];
  const out = [...ascii("AutoCAD-86 unifont 1.0\r\n"), 0x1a, ...le32(Object.keys(shapes).length + 1), ...le16(info.length), ...info];
  for (const [k, v] of Object.entries(shapes)) {
    const def = [0, ...v]; // empty name
    out.push(...le16(+k), ...le16(def.length), ...def);
  }
  return new Uint8Array(out);
}

/** a big font with lead bytes 0xB0–0xC8 */
function bigfont(shapes: Record<number, number[]>, height = 20): Uint8Array {
  const defs: [number, number[]][] = [[0, [...ascii("BIG"), 0, height, 0, 2, 0, 0]], ...Object.entries(shapes).map(([k, v]): [number, number[]] => [+k, [0, ...v]])];
  const head = [...ascii("AutoCAD-86 bigfont 1.0\r\n"), 0x1a];
  const idxAt = head.length + 6 + 4;
  let off = idxAt + defs.length * 8;
  const idx: number[] = [], body: number[] = [];
  for (const [code, d] of defs) {
    idx.push(...le16(code), ...le16(d.length), ...le32(off));
    body.push(...d);
    off += d.length;
  }
  return new Uint8Array([...head, ...le16(8), ...le16(defs.length), ...le16(1), ...le16(0xb0), ...le16(0xc8), ...idx, ...body]);
}

describe("SHX shape fonts", () => {
  it("reads vectors, pen up / down, displacements, arcs, subshapes and the vertical-only code", () => {
    // 'L': down 10 (vector 0xAC = length 10, direction 12 = south) then east 6; pen up to x 8
    // 'O': octant arc, full circle radius 4 starting at octant 4 (west point), then move on
    // 'X': subshape 'L' (two-byte number in a unifont), then a vertical-only move that horizontal text skips
    const f = parseShx(
      unifont({
        0x4c: [2, 0x84 + 0x20, 1, 0xac, 0x60, 2, 8, 2, 0, 0],
        0x4f: [2, 8, 1, 4, 1, 10, 4, 0x40, 2, 8, 8, 0xfc, 0],
        0x58: [7, 0, 0x4c, 14, 8, 50, 50, 0],
        0x20: [2, 0x80, 0],
      }),
      "test.shx",
    )!;
    expect(f.kind).toBe("unifont");
    expect(f.above).toBe(10);
    expect(f.below).toBe(3);
    const L = shxGlyph(f, 0x4c)!;
    expect(L.strokes).toHaveLength(1);
    expect(L.strokes[0][0]).toEqual([0, 10]);
    expect(L.strokes[0][1]).toEqual([0, 0]);
    expect(L.strokes[0][2]).toEqual([6, 0]);
    expect(L.adv).toBe(8);
    const O = shxGlyph(f, 0x4f)!;
    const xs = O.strokes[0].map((p) => p[0]), ys = O.strokes[0].map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(1, 5);
    expect(Math.max(...xs)).toBeCloseTo(9, 5);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(8, 5);
    expect(O.adv).toBeCloseTo(9, 5);
    const X = shxGlyph(f, 0x58)!;
    expect(X.adv).toBe(8); // the vertical-only move is skipped
    expect(X.strokes[0][2]).toEqual([6, 0]);
    expect(shxCode(f, "Q")).toBeNull();
    // cap-height units: 'L' 0.8 wide on a cap of 1
    expect(pairGlyph({ main: f, big: null }, "L")!.adv).toBeCloseTo(0.8, 6);
  });

  it("bulge arcs and the special characters %%d %%p %%c", () => {
    // code 12: (dx 10, dy 0, bulge 127) = a half circle above / below the chord
    const f = parseShx(unifont({ 0x41: [1, 12, 10, 0, 127, 0], 127: [1, 0x30, 0], 129: [1, 0x40, 0] }), "t")!;
    const A = shxGlyph(f, 0x41)!;
    expect(A.adv).toBeCloseTo(10, 5);
    const ys = A.strokes[0].map((p) => p[1]);
    expect(Math.min(...ys)).toBeCloseTo(-5, 1); // counter-clockwise from (0,0) to (10,0): the arc swings below
    expect(shxCode(f, "°")).toBe(127);
    expect(shxCode(f, "⌀")).toBe(129);
  });

  it("a big font: double-byte shapes by the code page, its own space, the cell scaled to the height", () => {
    const enc = new TextDecoder("euc-kr").decode(new Uint8Array([0xb0, 0xa1])); // 가
    expect(enc).toBe("가"); // i18n: keep — glyph data
    const big = parseShx(bigfont({ 0xb0a1: [1, 0x84, 0xa4, 0xa0, 2, 8, 24, 0xf6, 0], 0x20: [2, 8, 13, 0, 0] }), "whgtest.shx")!;
    expect(big.kind).toBe("bigfont");
    expect(shxCode(big, "가")).toBe(0xb0a1); // i18n: keep — glyph data
    expect(shxCode(big, " ")).toBe(0x20);
    const main = parseShx(unifont({ 0x20: [2, 0xa0, 0], 0x41: [2, 0x80, 0] }), "t")!;
    const pair = { main, big };
    expect(pairGlyph(pair, " ")!.adv).toBeCloseTo(13 / 20, 6); // the big font's space wins
    expect(pairGlyph(pair, "A")!.adv).toBeCloseTo(0.8, 6);
    expect(pairGlyph(pair, "가")!.adv).toBeCloseTo(34 / 20, 6); // i18n: keep — glyph data
  });

  it("rejects what is not a shape font", () => {
    expect(parseShx(new Uint8Array(ascii("hello world")), "x")).toBeNull();
    expect(parseShx(new Uint8Array([...ascii("AutoCAD-86 unifont 1.0\r\n"), 0x1a, 1, 0]), "x")).toBeNull();
  });

  it("style keys, families and the stroke font built from the shapes", () => {
    expect(shxKeyOf("romans.shx", "")).toBe("romans");
    expect(shxKeyOf("txt", "whgtxt.shx")).toBe("txt+whgtxt");
    expect(shxKeyOf("arial.ttf", undefined)).toBeNull();
    expect(shxKeyOf("", undefined)).toBe("txt");
    const f = parseShx(unifont({ 0x41: [1, 0x84, 0x8c, 2, 0x80, 0], 0x20: [2, 0x60, 0] }), "testfont.shx")!;
    registerShxPair("testfont", { main: f, big: null });
    expect(fontFamily("testfont.shx").family).toBe(STROKE_SHX + "testfont");
    const v = strokeVariantOf(STROKE_SHX + "testfont")!;
    expect(v).toBe("shx:testfont");
    // A: 8 / 10 of the cap height; space 6 / 10 — em at cap 0.72
    expect(strokeAdvance("A A", v)).toBeCloseTo(((0.8 + 0.6 + 0.8) * 720) / 1000, 6);
    // a character the SHX lacks: Omni Stroke's
    expect(strokeAdvance("B", v)).toBeCloseTo(strokeAdvance("B", "prop"), 6);
    const ttf = strokeFontTtf("A", false, v);
    expect(ttf[0]).toBe(0);
    expect(ttf.length).toBeGreaterThan(1000);
    // an SHX family whose files are not on this computer stands on Omni Stroke (txt → the fixed-pitch one)
    expect(strokeAdvance("Omni", "shx:txt+nowhere")).toBeCloseTo(strokeAdvance("Omni", "mono"), 6);
  });

  it("loads only the fonts the styles name, from the drawing folder first", async () => {
    resetShxCache();
    const seen: string[] = [];
    const bytes = unifont({ 0x41: [1, 0x84, 0] });
    const read = async (p: string) => {
      seen.push(p);
      return /drawings\/myshape\.shx$/i.test(p) ? bytes : null;
    };
    const styles = new Map([
      ["A", { name: "A", font: "myshape.shx", height: 0, widthFactor: 1, oblique: 0 }],
      ["B", { name: "B", font: "arial.ttf", height: 0, widthFactor: 1, oblique: 0 }],
    ]);
    const keys = await loadDrawingShx({ styles } as never, "C:/drawings", [], read);
    expect(keys).toEqual(["myshape"]);
    expect(seen).toEqual(["C:/drawings/myshape.shx"]);
    expect(seen.some((p) => /arial/i.test(p))).toBe(false);
  });
});

// AutoCAD's own fonts — read in place when installed (never copied into the repository)
const ACAD = "E:/Autodesk/AutoCAD 2027/Fonts";
describe.skipIf(!existsSync(`${ACAD}/romans.shx`))("AutoCAD Fonts folder (read only)", () => {
  const read = (n: string) => parseShx(new Uint8Array(readFileSync(`${ACAD}/${n}.shx`)), n)!;
  it("txt, romans and the Korean big font whgtxt", () => {
    const txt = read("txt"), romans = read("romans"), whg = read("whgtxt");
    expect(txt.kind).toBe("unifont");
    expect(txt.above).toBe(6);
    expect(romans.above).toBe(21);
    // txt: fixed cells (letters 1.0 of the height, i 1/3), romans proportional — the widths measured on the plot of
    // omni-cad-03 (cad/strokeFont.ts PROP_W: O 22/21, i 8/21)
    expect(pairGlyph({ main: txt, big: null }, "O")!.adv).toBeCloseTo(1, 6);
    expect(pairGlyph({ main: romans, big: null }, "O")!.adv).toBeCloseTo(22 / 21, 6);
    expect(pairGlyph({ main: romans, big: null }, "i")!.adv).toBeCloseTo(8 / 21, 6);
    const pair = { main: txt, big: whg };
    expect(pairGlyph(pair, "오")!.adv).toBeCloseTo(124 / 96, 6); // i18n: keep — glyph data
    expect(pairGlyph(pair, " ")!.adv).toBeCloseTo(62 / 96, 6);
  });
  it("gbcbig's self-scaling shapes and extfont's composed subshapes come out one cell wide", () => {
    const gb = read("gbcbig"), ext = read("extfont");
    for (const ch of "季度报告") expect(pairGlyph({ main: null, big: gb }, ch)!.adv).toBeCloseTo(1, 1);
    for (const ch of "四半期報告") expect(pairGlyph({ main: null, big: ext }, ch)!.adv).toBeCloseTo(1.2, 2);
  });
});
